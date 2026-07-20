import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hashBytes, hashFile } from "../engine/hash.js";
import { branchesCheckedOutElsewhere } from "../engine/git/apply.js";
import { checkoutJournalDir } from "../engine/git/journal.js";
import { readRepoIdentityV1 } from "../engine/git/repo-lineage.js";
import { readAllRefs, readOpState, readScopedRefs } from "../engine/git/refs.js";
import {
  HEX40,
  git,
  gitWithIndexFile,
  headBranchOf,
  readHead,
  repoCtx,
  type RepoCtx,
} from "../engine/git/shared.js";
import { OP_STATE_CLASSIFICATION, OP_STATE_DIRS, OP_STATE_FILES, type OpStateRoot } from "../engine/manifest-validate.js";
import { fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { openAdoptDirectory } from "./adopt-fs.js";
import {
  adoptStashDir,
  identitiesEqual,
  readAdoptIdentity,
  type AdoptGitBranch,
  type AdoptGitRepo,
  type AdoptIdentity,
  type AdoptJournal,
  type AdoptRepoIdentity,
} from "./adopt-journal.js";

export interface AdoptGitDeps {
  runGit?: typeof git;
  beforeFetch?: (repo: string, branch: AdoptGitBranch) => void | Promise<void>;
  afterFetchBeforeMutation?: (repo: string, branch: AdoptGitBranch) => void | Promise<void>;
  beforeCas?: (repo: string, branch: AdoptGitBranch) => void | Promise<void>;
  afterCas?: (repo: string, branch: AdoptGitBranch) => void | Promise<void>;
  afterIndexPublish?: (repo: string, branch: AdoptGitBranch) => void | Promise<void>;
}

const absentHash = hashBytes(Buffer.from("absent"));

function repoAbs(root: string, rel: string): string {
  return rel === "." ? root : path.join(root, ...rel.split("/"));
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function hashPath(abs: string): Promise<string> {
  const stat = await fs.lstat(abs).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!stat) return absentHash;
  if (stat.isSymbolicLink()) return hashBytes(Buffer.from(`symlink\0${await fs.readlink(abs)}`));
  if (stat.isFile()) return hashFile(abs);
  if (!stat.isDirectory()) return hashBytes(Buffer.from(`special\0${stat.mode}`));
  const hash = crypto.createHash("sha256");
  const names = (await fs.readdir(abs)).sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  for (const name of names) hash.update(name).update("\0").update(await hashPath(path.join(abs, name))).update("\0");
  return hash.digest("hex");
}

async function currentRepoIdentity(root: string, rel: string, ctx: RepoCtx): Promise<AdoptRepoIdentity> {
  const [repo, worktreeStat, gitDirStat] = await Promise.all([
    readRepoIdentityV1(rel, ctx.kind, { worktreeId: ctx.repoDir, gitDirReal: ctx.gitDir, commonDirReal: ctx.commonDir }),
    fs.lstat(ctx.repoDir, { bigint: true }),
    fs.lstat(ctx.gitDir, { bigint: true }),
  ]);
  if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink() || !gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
    throw new Error(`repository incarnation is not a no-follow directory: ${rel}`);
  }
  const birthtime = (value: bigint) => value > 0n ? value.toString() : "unavailable";
  return {
    kind: ctx.kind,
    worktreeId: repo.worktreeId,
    gitDirReal: repo.gitDirReal,
    commonDirReal: repo.commonDirReal,
    dev: repo.dev,
    ino: repo.ino,
    birthtime: repo.birthtime,
    worktreeDev: worktreeStat.dev.toString(),
    worktreeIno: worktreeStat.ino.toString(),
    worktreeBirthtime: birthtime(worktreeStat.birthtimeNs),
    gitDirDev: gitDirStat.dev.toString(),
    gitDirIno: gitDirStat.ino.toString(),
    gitDirBirthtime: birthtime(gitDirStat.birthtimeNs),
    configHash: await hashPath(path.join(ctx.commonDir, "config")),
    checkoutJournalHash: await hashPath(checkoutJournalDir(root, rel)),
  };
}

function sameRepoIdentity(a: AdoptRepoIdentity, b: AdoptRepoIdentity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function proveRepoContainment(root: string, stash: string, record: AdoptGitRepo): Promise<{ sourceDir: string; targetDir?: string; source: RepoCtx; target?: RepoCtx }> {
  const sourceDir = repoAbs(stash, record.path);
  const sourceHandle = await openAdoptDirectory(stash, record.path === "." ? "." : record.path, false);
  await sourceHandle.close();
  const source = await repoCtx(sourceDir);
  if (!source || source.kind !== "dir") throw new Error(`retained repository shape changed: ${record.path}`);
  const [stashReal, sw, sg, sc] = await Promise.all([fs.realpath(stash), fs.realpath(sourceDir), fs.realpath(source.gitDir), fs.realpath(source.commonDir)]);
  const so = await fs.realpath(path.resolve(sourceDir, await git(sourceDir, ["rev-parse", "--git-path", "objects"])));
  if (![sw, sg, sc, so].every((candidate) => inside(stashReal, candidate))) throw new Error(`retained repository escaped stash: ${record.path}`);
  const alternates = path.join(so, "info", "alternates");
  const alternateStat = await fs.lstat(alternates).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (alternateStat) {
    if (!alternateStat.isFile() || alternateStat.isSymbolicLink()) throw new Error(`retained repository has unsafe alternates: ${record.path}`);
    const handle = await fs.open(alternates, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw = "";
    try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const alternateReal = await fs.realpath(path.resolve(so, line));
      if (!inside(stashReal, alternateReal)) throw new Error(`retained repository escaped stash through alternates: ${record.path}`);
    }
  }
  if (sw !== record.source.worktreeReal || sg !== record.source.gitDirReal
    || sc !== record.source.commonDirReal || so !== record.source.objectStoreReal) {
    throw new Error(`retained repository incarnation changed: ${record.path}`);
  }

  const targetDir = repoAbs(root, record.path);
  const targetStat = await fs.lstat(targetDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!targetStat?.isDirectory() || targetStat.isSymbolicLink()) return { sourceDir, source };
  const targetHandle = await openAdoptDirectory(root, record.path === "." ? "." : record.path, false);
  await targetHandle.close();
  const target = await repoCtx(targetDir);
  if (!target) return { sourceDir, source };
  const [rootReal, tw, tg, tc] = await Promise.all([fs.realpath(root), fs.realpath(targetDir), fs.realpath(target.gitDir), fs.realpath(target.commonDir)]);
  if (!inside(rootReal, tw) || target.kind === "dir" && (!inside(rootReal, tg) || !inside(rootReal, tc))) {
    throw new Error(`baseline repository containment changed: ${record.path}`);
  }
  return { sourceDir, targetDir, source, target };
}

/** Bind the admitted phase-0 repo records to their phase-1 retained paths. */
export async function bindRetainedRepoIncarnations(journal: AdoptJournal): Promise<void> {
  const stash = adoptStashDir(journal.workspace.root);
  const stashReal = await fs.realpath(stash);
  for (const record of journal.sourceRepos) {
    const sourceDir = repoAbs(stash, record.path);
    const source = await repoCtx(sourceDir);
    if (!source || source.kind !== "dir") throw new Error(`retained repository shape changed: ${record.path}`);
    const [worktreeReal, gitDirReal, commonDirReal] = await Promise.all([
      fs.realpath(sourceDir), fs.realpath(source.gitDir), fs.realpath(source.commonDir),
    ]);
    const objectStoreReal = await fs.realpath(path.resolve(sourceDir, await git(sourceDir, ["rev-parse", "--git-path", "objects"])));
    if (![worktreeReal, gitDirReal, commonDirReal, objectStoreReal].every((candidate) => inside(stashReal, candidate))) {
      throw new Error(`retained repository escaped stash: ${record.path}`);
    }
    Object.assign(record, { worktreeReal, gitDirReal, commonDirReal, objectStoreReal });
  }
}

async function reflogFingerprint(ctx: RepoCtx, ref: string): Promise<string> {
  return hashPath(path.join(ctx.commonDir, "logs", ...ref.split("/")));
}

async function reflogEndsWith(ctx: RepoCtx, ref: string, oldOid: string, newOid: string): Promise<boolean> {
  const raw = await fs.readFile(path.join(ctx.commonDir, "logs", ...ref.split("/")), "utf8").catch(() => "");
  const last = raw.trimEnd().split("\n").at(-1) ?? "";
  return last.startsWith(`${oldOid} ${newOid} `);
}

async function gateCheckedOut(ctx: RepoCtx, ownedIndexLock?: AdoptIdentity): Promise<{ eligible: boolean; indexTree?: string; headTree?: string; noOperationState: boolean; reason?: string }> {
  const opFiles = await readOpState(ctx.gitDir, hashFile).catch(() => ({ __probe_error: "" }));
  let rootsPresent = false;
  for (const rel of [...OP_STATE_FILES, ...OP_STATE_DIRS]) {
    if (OP_STATE_CLASSIFICATION[rel] !== "in-progress") continue;
    if (await fs.lstat(path.join(ctx.gitDir, rel)).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) {
      rootsPresent = true;
      break;
    }
  }
  const liveIndexLock = await readAdoptIdentity(path.join(ctx.gitDir, "index.lock"), true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (liveIndexLock && (!ownedIndexLock || !identitiesEqual(ownedIndexLock, liveIndexLock))) rootsPresent = true;
  const hasHashedInProgressState = Object.keys(opFiles).some((rel) => {
    const root = rel.split("/", 1)[0] as OpStateRoot;
    return OP_STATE_CLASSIFICATION[root] === "in-progress";
  });
  const noOperationState = !rootsPresent && !hasHashedInProgressState;
  const [indexTree, headTree] = await Promise.all([
    readIndexTreeWithoutMutation(ctx).catch(() => undefined),
    git(ctx.repoDir, ["rev-parse", "HEAD^{tree}"]).catch(() => undefined),
  ]);
  const eligible = noOperationState && !!indexTree && !!headTree && indexTree === headTree;
  return { eligible, indexTree, headTree, noOperationState, ...(!eligible ? { reason: !noOperationState ? "operation state present" : !indexTree ? "index tree unavailable" : "index differs from HEAD" } : {}) };
}

/** git write-tree may refresh cache-tree extensions in the live index. Run it
 * against a no-follow byte copy so an ineligible gate is observational only. */
async function readIndexTreeWithoutMutation(ctx: RepoCtx): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-index-gate-"));
  const tempIndex = path.join(tempDir, "index");
  const liveIndex = path.join(ctx.gitDir, "index");
  try {
    const stat = await fs.lstat(liveIndex).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("live Git index is not a regular no-follow file");
      const handle = await fs.open(liveIndex, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { await fs.writeFile(tempIndex, await handle.readFile(), { mode: 0o600 }); }
      finally { await handle.close(); }
    }
    return await gitWithIndexFile(ctx.repoDir, tempIndex, ["write-tree"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function saveIndex(root: string, rel: string, ctx: RepoCtx): Promise<NonNullable<AdoptGitBranch["index"]>> {
  const key = crypto.createHash("sha256").update(rel).digest("hex");
  const dir = path.join(root, ".rbox", "adopt", "indexes");
  await fs.mkdir(dir, { recursive: true });
  const savedPath = path.join(dir, `${key}.old-index`);
  const preparedPath = path.join(dir, `${key}.prepared-index`);
  const indexPath = path.join(ctx.gitDir, "index");
  const stat = await fs.lstat(indexPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  let record: NonNullable<AdoptGitBranch["index"]>;
  if (!stat) {
    await writeFileAtomic(path.join(dir, `${key}.index-absent`), "absent\n", { mode: 0o600, exactMode: true });
    await fsyncDirectory(dir);
    record = { present: false, savedPath, preparedPath, lockPath: path.join(ctx.gitDir, "index.lock"), readTreeState: "none" };
  } else {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("live Git index is not a regular no-follow file");
    const before = await readAdoptIdentity(indexPath, true);
    const handle = await fs.open(indexPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = await handle.readFile();
      const after = await readAdoptIdentity(indexPath, true);
      if (!identitiesEqual(before, after) || hashBytes(bytes) !== before.sha256) throw new Error("live Git index changed while saving inverse");
      await writeFileAtomic(savedPath, bytes, { mode: 0o600, exactMode: true });
    } finally {
      await handle.close();
    }
    await fsyncDirectory(dir);
    record = { present: true, savedPath, preparedPath, lockPath: path.join(ctx.gitDir, "index.lock"), before, beforeHash: before.sha256, readTreeState: "none" };
  }
  const lock = await fs.open(record.lockPath!, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await lock.sync(); } finally { await lock.close(); }
  await fsyncDirectory(ctx.gitDir);
  record.lockIdentity = await readAdoptIdentity(record.lockPath!, true);
  return record;
}

function assertIndexRecordPaths(root: string, ctx: RepoCtx, record: NonNullable<AdoptGitBranch["index"]>): void {
  const indexDir = path.join(root, ".rbox", "adopt", "indexes");
  const insideIndexDir = (candidate: string | undefined) => !!candidate && inside(indexDir, path.resolve(candidate));
  if (!insideIndexDir(record.savedPath) || !insideIndexDir(record.preparedPath)
    || record.lockPath !== path.join(ctx.gitDir, "index.lock")) {
    throw new Error("adoption index record path binding mismatch");
  }
}

async function prepareIndex(root: string, ctx: RepoCtx, branch: AdoptGitBranch): Promise<void> {
  const record = branch.index!;
  assertIndexRecordPaths(root, ctx, record);
  await fs.rm(record.preparedPath!, { force: true });
  if (record.present) await fs.copyFile(record.savedPath, record.preparedPath!);
  await gitWithIndexFile(ctx.repoDir, record.preparedPath!, ["read-tree", "--reset", branch.incomingOid]);
  const handle = await fs.open(record.preparedPath!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
  await fsyncDirectory(path.dirname(record.preparedPath!));
  record.readTreeState = "intent";
}

async function releaseOwnedIndexLock(ctx: RepoCtx, branch: AdoptGitBranch): Promise<void> {
  const record = branch.index;
  if (!record?.lockPath || !record.lockIdentity) return;
  const live = await readAdoptIdentity(record.lockPath, true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (!live) return;
  if (!identitiesEqual(record.lockIdentity, live)) throw new Error("live Git index lock ownership changed");
  await fs.unlink(record.lockPath);
  await fsyncDirectory(ctx.gitDir);
}

async function publishPreparedIndex(root: string, ctx: RepoCtx, branch: AdoptGitBranch): Promise<void> {
  const record = branch.index!;
  assertIndexRecordPaths(root, ctx, record);
  const lockPath = record.lockPath!;
  const bytes = await fs.readFile(record.preparedPath!);
  const lockBefore = await readAdoptIdentity(lockPath, true);
  if (!record.lockIdentity || !identitiesEqual(record.lockIdentity, lockBefore)) throw new Error("live Git index lock ownership changed");
  const lock = await fs.open(lockPath, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await lock.stat({ bigint: true });
    if (opened.dev.toString() !== lockBefore.dev || opened.ino.toString() !== lockBefore.ino) throw new Error("live Git index lock changed while opening");
    await lock.truncate(0);
    await lock.writeFile(bytes);
    await lock.sync();
  } finally { await lock.close(); }
  record.preparedIdentity = await readAdoptIdentity(lockPath, true);
  const liveIndex = path.join(ctx.gitDir, "index");
  if (record.present) {
    const live = await readAdoptIdentity(liveIndex, true);
    if (JSON.stringify(live) !== JSON.stringify(record.before)) throw new Error("live index changed before prepared read-tree publication");
  } else if (await fs.lstat(liveIndex).then(() => true, () => false)) {
    throw new Error("live index appeared before prepared read-tree publication");
  }
  await fs.rename(lockPath, liveIndex);
  await fsyncDirectory(ctx.gitDir);
  record.after = await readAdoptIdentity(liveIndex, true);
  record.afterHash = record.after.sha256;
  record.readTreeState = "complete";
}

async function finishPreparedIndex(root: string, ctx: RepoCtx, branch: AdoptGitBranch): Promise<void> {
  const record = branch.index!;
  assertIndexRecordPaths(root, ctx, record);
  const livePath = path.join(ctx.gitDir, "index");
  const live = await readAdoptIdentity(livePath, true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  const prepared = await readAdoptIdentity(record.preparedPath!, true);
  if (live && live.sha256 === prepared.sha256 && live.size === prepared.size) {
    record.after = live;
    record.afterHash = live.sha256;
    record.readTreeState = "complete";
    return;
  }
  if (record.present ? JSON.stringify(live) === JSON.stringify(record.before) : live === undefined) {
    await publishPreparedIndex(root, ctx, branch);
    return;
  }
  throw new Error("live index is neither saved-before nor prepared-after state");
}

async function listSourceBranches(sourceDir: string): Promise<Array<{ ref: string; oid: string }>> {
  const raw = await git(sourceDir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
  return raw.split("\n").filter(Boolean).map((line) => {
    const split = line.lastIndexOf(" ");
    return { ref: line.slice(0, split), oid: line.slice(split + 1) };
  }).filter((entry) => entry.ref.startsWith("refs/heads/") && HEX40.test(entry.oid));
}

async function updateRetainedReport(repo: AdoptGitRepo, sourceDir: string): Promise<void> {
  const raw = await git(sourceDir, ["for-each-ref", "--format=%(refname)"]).catch(() => "");
  repo.retainedRefs = raw.split("\n").filter(Boolean).sort();
  const head = await git(sourceDir, ["rev-parse", "HEAD"]).catch(() => "");
  const symbolic = await git(sourceDir, ["symbolic-ref", "-q", "HEAD"]).catch(() => "");
  if (HEX40.test(head) && !symbolic) repo.detachedHead = head;
}

/** Exact-OID fetch-union. No BASE/reconcile/capture authority is imported here. */
export async function runGitAdoption(
  journal: AdoptJournal,
  persist: () => Promise<void>,
  deps: AdoptGitDeps = {},
): Promise<void> {
  if (!journal.workspace.syncGit) {
    journal.gitRepos = journal.sourceRepos.map((source) => ({ path: source.path, source, branches: [], retainedRefs: [], state: "parked", reason: "git sync disabled" }));
    await persist();
    return;
  }
  const root = journal.workspace.root;
  const stash = adoptStashDir(root);
  const run = deps.runGit ?? git;
  if (journal.gitRepos.length === 0) journal.gitRepos = journal.sourceRepos.map((source) => ({ path: source.path, source, branches: [], retainedRefs: [], state: "pending" }));

  for (const repo of journal.gitRepos) {
    if (repo.state === "complete" || repo.state === "unplaced") continue;
    if (repo.state === "paused" && !repo.branches.some((branch) => branch.state === "cas-intent" || branch.state === "cas-complete")) continue;
    let proof: Awaited<ReturnType<typeof proveRepoContainment>>;
    try { proof = await proveRepoContainment(root, stash, repo); }
    catch (error) {
      repo.state = "parked"; repo.reason = error instanceof Error ? error.message : String(error); await persist(); continue;
    }
    await updateRetainedReport(repo, proof.sourceDir);
    if (!proof.target || !proof.targetDir) {
      repo.state = "unplaced"; repo.reason = "no phase-2 target repository"; await persist(); continue;
    }
    const identity = await currentRepoIdentity(root, repo.path, proof.target);
    if (repo.target && !sameRepoIdentity(repo.target, identity)) {
      repo.state = "paused"; repo.reason = "baseline repository incarnation changed"; await persist(); continue;
    }
    repo.target ??= identity;
    const targetHead = await readHead(proof.target);
    const targetRefs = proof.target.kind === "pointer" ? await readScopedRefs(proof.targetDir, targetHead) : await readAllRefs(proof.targetDir);
    const sourceBranches = await listSourceBranches(proof.sourceDir);
    const existing = new Map(repo.branches.map((branch) => [branch.ref, branch]));

    for (const candidate of sourceBranches) {
      if (existing.has(candidate.ref)) continue;
      const old = targetRefs[candidate.ref];
      if (!old || !HEX40.test(old)) continue;
      if (old === candidate.oid) {
        repo.branches.push({
          ref: candidate.ref, expectedOld: old, incomingOid: candidate.oid, provedSourceOid: candidate.oid,
          checkedOut: headBranchOf(targetHead) === candidate.ref, targetHead, siblingOwnership: {}, reflogBefore: await reflogFingerprint(proof.target, candidate.ref), state: "equal",
        });
        continue;
      }
      if (!await git(proof.sourceDir, ["merge-base", "--is-ancestor", old, candidate.oid], { env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } }).then(() => true, () => false)) continue;
      const owned = await branchesCheckedOutElsewhere(proof.target);
      if (owned.has(candidate.ref)) {
        repo.branches.push({
          ref: candidate.ref, expectedOld: old, incomingOid: candidate.oid, provedSourceOid: candidate.oid,
          checkedOut: headBranchOf(targetHead) === candidate.ref, targetHead, siblingOwnership: Object.fromEntries(owned),
          reflogBefore: await reflogFingerprint(proof.target, candidate.ref), state: "parked", reason: `branch checked out in linked worktree ${owned.get(candidate.ref)}`,
        });
        continue;
      }
      const checkedOut = headBranchOf(targetHead) === candidate.ref;
      const gate = checkedOut ? await gateCheckedOut(proof.target) : undefined;
      const branch: AdoptGitBranch = {
        ref: candidate.ref, expectedOld: old, incomingOid: candidate.oid, provedSourceOid: candidate.oid,
        checkedOut, targetHead, siblingOwnership: Object.fromEntries(owned), reflogBefore: await reflogFingerprint(proof.target, candidate.ref),
        ...(gate ? { initialIndexTree: gate.indexTree, initialHeadTree: gate.headTree, initialNoOperationState: gate.noOperationState } : {}),
        state: gate && !gate.eligible ? "parked" : "proved",
        ...(gate && !gate.eligible ? { reason: gate.reason } : {}),
      };
      repo.branches.push(branch);
      await persist();
    }

    for (const branch of repo.branches) {
      if (["equal", "parked", "index-complete", "paused", "aborted"].includes(branch.state)) continue;
      try {
        if (branch.state === "proved") {
          await deps.beforeFetch?.(repo.path, branch);
          await run(proof.targetDir, ["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", proof.sourceDir, branch.provedSourceOid], {
            env: { GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
          });
          branch.state = "fetched";
          await persist();
        }
        await deps.afterFetchBeforeMutation?.(repo.path, branch);
        const boundary = await proveRepoContainment(root, stash, repo);
        if (!boundary.target || !boundary.targetDir || !sameRepoIdentity(repo.target!, await currentRepoIdentity(root, repo.path, boundary.target))) throw new Error("repository incarnation changed after fetch");
        const liveRef = await run(boundary.targetDir, ["rev-parse", "--verify", branch.ref]);
        const boundaryReflog = await reflogFingerprint(boundary.target, branch.ref);
        if (branch.state === "cas-intent") {
          if (liveRef === branch.incomingOid && await reflogEndsWith(boundary.target, branch.ref, branch.expectedOld, branch.incomingOid)) {
            branch.reflogAfter = boundaryReflog;
            branch.state = "cas-complete";
            await persist();
          } else if (liveRef !== branch.expectedOld || boundaryReflog !== branch.reflogBefore) {
            throw new Error("prepared CAS is in a third-value or ABA state");
          }
        }
        if (branch.state === "cas-complete") {
          if (branch.checkedOut) {
            await finishPreparedIndex(root, boundary.target, branch);
            branch.state = "index-complete";
            await persist();
          }
          continue;
        }
        const liveHead = await readHead(boundary.target);
        const liveOwned = await branchesCheckedOutElsewhere(boundary.target);
        const liveReflog = boundaryReflog;
        if (liveRef !== branch.expectedOld || liveHead !== branch.targetHead
          || JSON.stringify(Object.fromEntries(liveOwned)) !== JSON.stringify(branch.siblingOwnership)
          || liveReflog !== branch.reflogBefore) throw new Error("prepared ref/HEAD/ownership/reflog proof changed");
        if (branch.checkedOut) {
          if (!branch.index) {
            branch.index = await saveIndex(root, `${repo.path}\0${branch.ref}`, boundary.target);
            await persist();
          }
          const gate = await gateCheckedOut(boundary.target, branch.index.lockIdentity);
          branch.boundaryIndexTree = gate.indexTree;
          branch.boundaryHeadTree = gate.headTree;
          branch.boundaryNoOperationState = gate.noOperationState;
          const liveIndex = await readAdoptIdentity(path.join(boundary.target.gitDir, "index"), true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
          const sameSavedIndex = branch.index.present
            ? identitiesEqual(branch.index.before, liveIndex)
            : liveIndex === undefined;
          if (!gate.eligible) {
            await releaseOwnedIndexLock(boundary.target, branch);
            branch.index = undefined;
            branch.state = "parked"; branch.reason = gate.reason; await persist(); continue;
          }
          if (!sameSavedIndex) {
            await releaseOwnedIndexLock(boundary.target, branch);
            branch.index = undefined;
            branch.state = "parked"; branch.reason = "index changed while acquiring live index lock"; await persist(); continue;
          }
          if (branch.index.readTreeState === "none") {
            await prepareIndex(root, boundary.target, branch);
            await persist();
          }
        }
        branch.state = "cas-intent";
        await persist();
        await deps.beforeCas?.(repo.path, branch);
        await run(boundary.targetDir, ["update-ref", branch.ref, branch.incomingOid, branch.expectedOld]);
        await deps.afterCas?.(repo.path, branch);
        branch.reflogAfter = await reflogFingerprint(boundary.target, branch.ref);
        branch.state = "cas-complete";
        await persist();
        if (branch.checkedOut) {
          await finishPreparedIndex(root, boundary.target, branch);
          await deps.afterIndexPublish?.(repo.path, branch);
          branch.state = "index-complete";
          await persist();
        }
      } catch (error) {
        // A proved object disappearing before the literal fetch has no prepared
        // mutation to recover. It is a fresh-classifiable PARKED candidate.
        if (branch.state === "proved") branch.state = "parked";
        else if (branch.state !== "cas-intent" && branch.state !== "cas-complete") branch.state = "paused";
        branch.reason = error instanceof Error ? error.message : String(error);
        repo.state = branch.state === "parked" ? "parked" : "paused";
        repo.reason = branch.reason;
        await persist();
      }
    }
    repo.state = repo.branches.some((branch) => branch.state === "paused" || branch.state === "cas-intent" || branch.checkedOut && branch.state === "cas-complete")
      ? "paused"
      : repo.branches.some((branch) => branch.state === "parked") ? "parked" : "complete";
    await persist();
  }
}

export async function abortGitAdoption(journal: AdoptJournal, persist: () => Promise<void>): Promise<void> {
  const root = journal.workspace.root;
  const stash = adoptStashDir(root);
  for (const repo of [...journal.gitRepos].reverse()) {
    const proof = await proveRepoContainment(root, stash, repo);
    if (!proof.target || !proof.targetDir || !repo.target || !sameRepoIdentity(repo.target, await currentRepoIdentity(root, repo.path, proof.target))) {
      repo.state = "paused"; repo.reason = "cannot prove baseline repository for abort"; await persist(); continue;
    }
    for (const branch of [...repo.branches].reverse()) {
      if (!["cas-intent", "cas-complete", "index-complete"].includes(branch.state)) continue;
      try {
        if (branch.index) assertIndexRecordPaths(root, proof.target, branch.index);
        const liveRef = await git(proof.targetDir, ["rev-parse", "--verify", branch.ref]);
        let refWasAdvanced = liveRef === branch.incomingOid;
        if (branch.state === "cas-intent" && liveRef === branch.expectedOld) {
          if (await reflogFingerprint(proof.target, branch.ref) !== branch.reflogBefore) {
            throw new Error("prepared abort saw an ABA reflog transition");
          }
          refWasAdvanced = false;
        } else if (!refWasAdvanced || !await reflogEndsWith(proof.target, branch.ref, branch.expectedOld, branch.incomingOid)) {
          throw new Error("prepared abort saw a third-value or unproved reflog transition");
        }
        let indexPath: string | undefined;
        let expectedLiveIndex: AdoptGitBranch["index"];
        if (refWasAdvanced && branch.checkedOut && branch.index) {
          indexPath = path.join(proof.target.gitDir, "index");
          const live = await readAdoptIdentity(indexPath, true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
          if (branch.index.after) {
            if (JSON.stringify(live) !== JSON.stringify(branch.index.after)) throw new Error("post-adoption index changed; abort paused");
          } else {
            const prepared = branch.index.preparedPath
              ? await readAdoptIdentity(branch.index.preparedPath, true).catch(() => undefined)
              : undefined;
            const isBefore = branch.index.present ? JSON.stringify(live) === JSON.stringify(branch.index.before) : live === undefined;
            const isPrepared = prepared !== undefined && live !== undefined && live.sha256 === prepared.sha256 && live.size === prepared.size;
            if (!isBefore && !isPrepared) throw new Error("live index is neither journaled before nor prepared state; abort paused");
          }
          expectedLiveIndex = branch.index;
        }
        if (refWasAdvanced) await git(proof.targetDir, ["update-ref", branch.ref, branch.expectedOld, branch.incomingOid]);
        if (branch.checkedOut && branch.index) await releaseOwnedIndexLock(proof.target, branch);
        if (refWasAdvanced && branch.checkedOut && expectedLiveIndex && indexPath) {
          const liveAfterRef = await readAdoptIdentity(indexPath, true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
          if (expectedLiveIndex.after) {
            if (JSON.stringify(liveAfterRef) !== JSON.stringify(expectedLiveIndex.after)) throw new Error("post-adoption index changed during abort; abort paused");
          } else {
            const prepared = expectedLiveIndex.preparedPath
              ? await readAdoptIdentity(expectedLiveIndex.preparedPath, true).catch(() => undefined)
              : undefined;
            const isBefore = expectedLiveIndex.present ? JSON.stringify(liveAfterRef) === JSON.stringify(expectedLiveIndex.before) : liveAfterRef === undefined;
            const isPrepared = prepared !== undefined && liveAfterRef !== undefined && liveAfterRef.sha256 === prepared.sha256 && liveAfterRef.size === prepared.size;
            if (!isBefore && !isPrepared) throw new Error("live index changed during abort; abort paused");
          }
          if (expectedLiveIndex.present) {
            const bytes = await fs.readFile(expectedLiveIndex.savedPath);
            const tmp = `${indexPath}.adopt-abort-${process.pid}`;
            const handle = await fs.open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            await fs.rename(tmp, indexPath);
          } else await fs.rm(indexPath, { force: true });
          await fsyncDirectory(proof.target.gitDir);
        }
        branch.state = "aborted";
        await persist();
      } catch (error) {
        branch.state = "paused"; branch.reason = error instanceof Error ? error.message : String(error); repo.state = "paused"; await persist();
      }
    }
  }
}
