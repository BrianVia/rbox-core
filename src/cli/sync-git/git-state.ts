import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore, ByteProgressCallback } from "../../engine/blobstore.js";
import { encryptFileToTemp, decryptFileToPath } from "../../engine/crypto.js";
import { git, gitOk, gitStatus, gitWithIndexFile } from "../../engine/git-spawn.js";
import { hashFile } from "../../engine/hash.js";
import type { GitArtifactRef, GitPackLink, GitSection } from "../../engine/types.js";
import { addTimedMs, type GitChainTimings } from "./chain-timings.js";

/** Repo shape: "dir" = ordinary repo (`.git` directory); "pointer" = worktree/submodule
 *  checkout (`.git` gitfile whose state lives in the main clone's gitdir). */
export type GitRepoKind = "dir" | "pointer";

export const HEX40 = /^[0-9a-f]{40}$/;
export const ZERO_OID = "0".repeat(40);

export interface RegularFileRead {
  bytes: Buffer;
  token: { path: string; dev: number; ino: number };
}

/** Read a regular file through an O_NOFOLLOW handle and return the opened inode
 * identity alongside its exact bytes. Missing paths are the sole soft result. */
export async function readRegularFileNoFollow(abs: string): Promise<RegularFileRead | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`non-regular Git file: ${abs}`);
    return { bytes: await handle.readFile(), token: { path: path.resolve(abs), dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function warnOnce(seen: Set<string>, key: string, message: string, sink: (message: string) => void): void {
  if (seen.has(key)) return;
  seen.add(key);
  sink(message);
}

/** Parse `git config --get-regexp -z` output without trimming meaningful empty
 * values. Shared by direct local reads and same-directory snapshot reads. */
export function parseNullDelimitedGitConfig(raw: string): Array<[key: string, value: string]> {
  if (raw === "") return [];
  const records = raw.split("\0");
  if (records.pop() !== "") throw new Error("git config -z returned an unterminated record");
  return records.map((record) => {
    const separator = record.indexOf("\n");
    if (separator < 0) throw new Error("git config -z returned a record without a key/value separator");
    return [record.slice(0, separator), record.slice(separator + 1)];
  });
}

/** Read candidate design-93 keys from the local common config. Exit 1 is Git's
 * documented no-match result; every other subprocess failure remains loud. */
export async function readLocalGitConfigEntries(root: string): Promise<Array<[key: string, value: string]>> {
  const result = await gitStatus(root, ["config", "--local", "--no-includes", "--get-regexp", "-z", "^(remote|branch)\\."]);
  if (result.status === "ok") return parseNullDelimitedGitConfig(result.stdout);
  if (result.exit === 1) return [];
  throw result.cause;
}

export async function clearIndexResolveUndo(repoDir: string, indexFile: string): Promise<void> {
  await gitWithIndexFile(repoDir, indexFile, ["update-index", "--clear-resolve-undo"]);
}

export async function enumerateRefReflogOids(repoDir: string, ref: string): Promise<string[]> {
  if (!ref.startsWith("refs/") || ref.includes("..")) throw new Error("invalid reflog ref");
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while reading reflog");
  const raw = await fs.readFile(path.join(ctx.commonDir, "logs", ...ref.split("/")), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const result = new Set<string>();
  for (const line of raw.split("\n")) {
    const [oldOid, newOid] = line.split(" ");
    if (oldOid && HEX40.test(oldOid) && !/^0+$/.test(oldOid)) result.add(oldOid);
    if (newOid && HEX40.test(newOid) && !/^0+$/.test(newOid)) result.add(newOid);
  }
  return [...result];
}

// ---- repo context -----------------------------------------------------------

/** Everything path-shaped about a repo, resolved once. `gitDir` is the per-worktree
 *  gitdir (HEAD/index/op-state live here); `commonDir` is the shared object/ref store
 *  (== gitDir for dir repos; the main clone's `.git` for pointer repos). */
export interface RepoCtx {
  repoDir: string;
  kind: GitRepoKind;
  gitDir: string;
  commonDir: string;
}

export async function detectGitKind(repoDir: string): Promise<GitRepoKind | undefined> {
  const st = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "pointer";
  return undefined; // symlinked `.git` — unsupported shape
}

function resolveGitPath(base: string, raw: string): string {
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw));
}

async function pointerGitDir(repoDir: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(repoDir, ".git"), "utf8").catch(() => undefined);
  if (!raw) return undefined;
  const first = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = /^gitdir:\s*(.+)$/.exec(first);
  if (!m) return undefined;
  return resolveGitPath(repoDir, m[1]!.trim());
}

async function commonDirFromGitDir(gitDir: string): Promise<string> {
  const raw = await fs.readFile(path.join(gitDir, "commondir"), "utf8").catch(() => undefined);
  if (!raw) return path.resolve(gitDir);
  return resolveGitPath(gitDir, raw.trim());
}

/** Resolve gitdir/commondir from on-disk metadata only. This deliberately avoids
 *  `git rev-parse`, so warm status fingerprints can be checked with zero git
 *  subprocesses. It is advisory: callers that need Git's validation still use
 *  {@link repoCtx}. */
export async function repoCtxFromDisk(repoDir: string): Promise<RepoCtx | undefined> {
  const kind = await detectGitKind(repoDir);
  if (!kind) return undefined;
  const gitDir = kind === "dir" ? path.join(repoDir, ".git") : await pointerGitDir(repoDir);
  if (!gitDir) return undefined;
  const commonDir = await commonDirFromGitDir(gitDir);
  return { repoDir, kind, gitDir: path.resolve(gitDir), commonDir: path.resolve(commonDir) };
}

/** Resolve the repo's gitdirs, or undefined when the repo is unusable (no `.git`,
 *  dangling pointer — the Conductor incident — or not a repo at all). */
export async function repoCtx(repoDir: string): Promise<RepoCtx | undefined> {
  const kind = await detectGitKind(repoDir);
  if (!kind) return undefined;
  let gitDir: string;
  try {
    gitDir = await git(repoDir, ["rev-parse", "--absolute-git-dir"]);
  } catch {
    return undefined; // dangling pointer / corrupt repo → caller skips cleanly
  }
  const commonRaw = await git(repoDir, ["rev-parse", "--git-common-dir"]).catch(() => gitDir);
  return { repoDir, kind, gitDir, commonDir: path.resolve(repoDir, commonRaw) };
}

export async function readHead(ctx: RepoCtx): Promise<string> {
  return (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8")).trim();
}

/** Design 68 §3.3: find the in-tree main clone that carries a linked worktree's
 * history. Ordinary repos, submodules (`.git/modules/...`), and out-of-tree main
 * clones return undefined and retain their existing capture behavior. */
export async function inTreeWorktreeParentRel(root: string, repoDir: string): Promise<string | undefined> {
  const ctx = await repoCtx(repoDir);
  return inTreeWorktreeParentRelFromCtx(root, ctx);
}

export async function inTreeWorktreeParentRelFromCtx(root: string, ctx: RepoCtx | undefined): Promise<string | undefined> {
  if (!ctx || ctx.kind !== "pointer") return undefined;
  if (path.basename(ctx.commonDir) !== ".git") return undefined; // submodule checkout → exempt
  const mainTop = path.dirname(ctx.commonDir);
  const rootReal = await fs.realpath(root).catch(() => path.resolve(root));
  const mainReal = await fs.realpath(mainTop).catch(() => path.resolve(mainTop));
  const rel = path.relative(rootReal, mainReal);
  if (rel === "") return "."; // the sync root itself is the main clone
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined; // out-of-tree main clone → unchanged full capture
  return rel.split(path.sep).join("/"); // POSIX relPath, matching discoverGitRepos keys
}

/** One entry from `git worktree list --porcelain` — enough for branch-collision checks.
 *  `prunable` marks a stale entry (`git worktree prune` case), which design 68 treats
 *  as absent for apply collisions and live-worktree bookkeeping. */
export interface WorktreeEntry {
  path: string;
  /** full refname (refs/heads/…) the worktree has checked out; undefined when detached. */
  branch?: string;
  prunable: boolean;
}
export type WorktreeListResult =
  | { status: "ok"; entries: WorktreeEntry[] }
  | { status: "unreadable"; cause: unknown };

function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: (Partial<WorktreeEntry> & { path?: string }) | undefined;
  const flush = () => {
    if (cur?.path) entries.push({ path: cur.path, branch: cur.branch, prunable: cur.prunable ?? false });
    cur = undefined;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length);
    } else if (line.startsWith("prunable")) {
      cur.prunable = true;
    }
  }
  flush();
  return entries;
}

/** Evidence-sensitive worktree enumeration. A failed Git read is not an empty
 * ownership map: callers using this to authorize ref mutation must refuse. */
export async function listWorktreesStrict(repoDir: string): Promise<WorktreeListResult> {
  const result = await gitStatus(repoDir, ["worktree", "list", "--porcelain"]);
  if (result.status === "failed") return { status: "unreadable", cause: result.cause };
  return { status: "ok", entries: parseWorktrees(result.stdout) };
}

/** Lossy worktree enumeration for diagnostics and non-authorizing callers. */
export async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const result = await listWorktreesStrict(repoDir);
  return result.status === "ok" ? result.entries : [];
}

/** "ref: refs/heads/x" → "refs/heads/x"; detached (40-hex) → undefined. */
export function headBranchOf(head: string): string | undefined {
  const m = /^ref: (refs\/heads\/\S+)$/.exec(head.trim());
  return m?.[1];
}

export function gitSectionTips(section: Pick<GitSection, "head" | "refs">): string[] {
  const tips = new Set<string>();
  for (const sha of Object.values(section.refs)) {
    if (HEX40.test(sha)) tips.add(sha);
  }
  const head = section.head.trim();
  if (HEX40.test(head)) tips.add(head);
  return [...tips].sort();
}

export function gitSectionNewestLink(section: GitSection): GitPackLink {
  const link: GitPackLink = {
    sha: section.bundleSha,
    encSha: section.bundleEncSha,
    cipherSize: section.bundleCipherSize,
    tips: gitSectionTips(section),
  };
  if (section.bundleComp) {
    link.comp = section.bundleComp;
    link.payloadSha = section.bundlePayloadSha;
  }
  return link;
}

export function gitSectionPackLinks(section: GitSection): GitPackLink[] {
  return [...(section.packChain ?? []), gitSectionNewestLink(section)];
}

export function gitSectionBlobRefs(section: GitSection): Array<{ encSha: string; size: number }> {
  return [
    { encSha: section.bundleEncSha, size: section.bundleCipherSize },
    ...(section.packChain ?? []).map((link) => ({ encSha: link.encSha, size: link.cipherSize })),
    ...(section.indexEncSha ? [{ encSha: section.indexEncSha, size: section.indexCipherSize ?? 0 }] : []),
    ...Object.values(section.opState ?? {}).map((ref) => ({ encSha: ref.encSha, size: ref.cipherSize })),
  ];
}

async function gitTipsPresent(repoDir: string, tips: readonly string[]): Promise<boolean> {
  if (tips.length === 0) return false;
  for (const tip of tips) {
    if (!(await gitOk(repoDir, ["cat-file", "-e", `${tip}^{commit}`]))) return false;
  }
  return true;
}

/** Import every missing link in a git bundle chain into an apply-unique namespace.
 *  The caller owns namespace cleanup after publish or defer. */
export async function importGitPackChain(
  repoDir: string,
  section: GitSection,
  store: BlobStore,
  kek: Buffer,
  tmpDir: string,
  incomingNs: string,
  timings?: GitChainTimings
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  const importLink = async (link: GitPackLink, i: number): Promise<void> => {
    const bundlePath = path.join(tmpDir, `chain-${i}.bundle`);
    await addTimedMs(timings, "fetchDecryptMs", async () => {
      await getGitArtifact(store, kek, link, bundlePath, tmpDir);
    });
    const verified = await addTimedMs(timings, "bundleVerifyMs", () =>
      gitOk(repoDir, ["bundle", "verify", bundlePath])
    );
    if (!verified) {
      throw new Error(`bundle verify failed for git pack link ${i}`);
    }
    await addTimedMs(timings, "gitImportMs", async () => {
      // --no-recurse-submodules: a bundle import is a LOCAL artifact operation. Without
      // it, git may recursively fetch configured submodules' real remotes (network I/O,
      // child-ref mutation) when the target repo has active submodules — observed on
      // git 2.54 with an adopted standalone child (design 154 round-2 CRITICAL).
      await git(repoDir, ["fetch", "--no-tags", "--no-recurse-submodules", bundlePath, `+refs/*:${incomingNs}/*`], { maxBuffer: 64 * 1024 * 1024 });
    });
    imported++;
  };

  const links = gitSectionPackLinks(section);
  if (timings) timings.chainLength = links.length;
  const hasHistoricalLinks = (section.packChain?.length ?? 0) > 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    // Presence-skip is only safe for historical chain links. The current section's
    // index/op-state reference only CURRENT-link objects; superseded links' WIP
    // objects are never referenced by restored state, and repo fsck remains the
    // backstop after import/publish.
    if (hasHistoricalLinks && i < links.length - 1 && (await gitTipsPresent(repoDir, link.tips))) {
      skipped++;
      continue;
    }
    await importLink(link, i);
  }
  return { imported, skipped };
}

// ---- filesystem helpers ---------------------------------------------------

export async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function existsNoFollow(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // A busy probe must fail closed on inspection errors.
    return true;
  }
}

export interface GitBusyLock {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
}

export type GitBusySharedInspection =
  | { status: "ok"; locks: GitBusyLock[] }
  | { status: "indeterminate"; detail: string };

export type GitBusyInspection = GitBusySharedInspection;

async function inspectBusyLock(lockPath: string): Promise<GitBusyLock | undefined> {
  try {
    const stat = await fs.lstat(lockPath, { bigint: true });
    return {
      path: lockPath,
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeNs) / 1_000_000,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Inspect the store-wide half of the ordinary fail-closed busy probe. Callers
 * sweeping linked worktrees may cache this result by canonical commonDir. */
export async function inspectGitBusyShared(commonDir: string): Promise<GitBusySharedInspection> {
  try {
    const locks: GitBusyLock[] = [];
    for (const name of ["config.lock", "packed-refs.lock", "gc.pid"]) {
      const lock = await inspectBusyLock(path.join(commonDir, name));
      if (lock) locks.push(lock);
    }
    const refsDir = path.join(commonDir, "refs");
    if (await existsNoFollow(refsDir)) {
      for (const rel of await walkFiles(refsDir)) {
        if (!rel.endsWith(".lock")) continue;
        const lock = await inspectBusyLock(path.join(refsDir, rel));
        if (lock) locks.push(lock);
      }
    }
    return { status: "ok", locks };
  } catch (error) {
    return { status: "indeterminate", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Structured form of gitBusy(). Shared inspection is injectable so a workspace
 * hygiene pass reads a linked-worktree common directory exactly once. */
export async function inspectGitBusy(
  ctx: RepoCtx,
  shared: GitBusySharedInspection | Promise<GitBusySharedInspection> = inspectGitBusyShared(ctx.commonDir),
): Promise<GitBusyInspection> {
  try {
    const worktreeLocks: GitBusyLock[] = [];
    for (const name of ["index.lock", "HEAD.lock"]) {
      const lock = await inspectBusyLock(path.join(ctx.gitDir, name));
      if (lock) worktreeLocks.push(lock);
    }
    const common = await shared;
    if (common.status === "indeterminate") return common;
    return { status: "ok", locks: [...worktreeLocks, ...common.locks] };
  } catch (error) {
    return { status: "indeterminate", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** rename, with an EXDEV fallback (copy to a temp in the DEST dir, then rename) — a
 *  pointer repo's resolved gitdir (the main clone) may live on a different mount than
 *  the worktree where the apply staged its temp files. */
export async function moveFileAtomic(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const tmp = path.join(path.dirname(dest), `.rbox-xdev-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dest);
    await fs.rm(src, { force: true }).catch(() => {});
  }
}

export async function gitBusy(ctx: RepoCtx): Promise<boolean> {
  // Keep the ordinary planner/apply probe short-circuiting. Hygiene uses the
  // exhaustive structured inspector above because it needs the whole cohort.
  for (const lock of [path.join(ctx.gitDir, "index.lock"), path.join(ctx.gitDir, "HEAD.lock"), path.join(ctx.commonDir, "config.lock"), path.join(ctx.commonDir, "packed-refs.lock"), path.join(ctx.commonDir, "gc.pid")]) {
    if (await existsNoFollow(lock)) return true;
  }
  const refsDir = path.join(ctx.commonDir, "refs");
  if (await existsNoFollow(refsDir)) {
    try {
      for (const rel of await walkFiles(refsDir)) if (rel.endsWith(".lock")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// ---- encrypted artifact IO (§28) ------------------------------------------

export interface PutGitArtifactOptions {
  attempts?: number;
  backoff?: (attempt: number) => Promise<void>;
  uploadsDir?: string;
  onBytes?: ByteProgressCallback;
}

const isBlobShaMismatchError = (cause: unknown): boolean => cause instanceof Error && cause.name === "BlobShaMismatchError";

/** Design 226: retained ciphertext uses a per-encryption path, never an encSha
 * path that concurrent convergent captures could share and prematurely delete. */
export interface PendingGitUpload {
  encSha: string;
  ciphertextPath: string;
  cipherSize: number;
  attempts: number;
  uploadsDir?: string;
  onBytes?: ByteProgressCallback;
  backoff?: (attempt: number) => Promise<void>;
}

/** §28/design 226: encrypt locally without touching the store, retaining the
 * ciphertext until the caller decides the section's fate and cleans it up. */
export async function encryptGitArtifact(
  kek: Buffer,
  srcPath: string,
  retainDir: string,
  opts: PutGitArtifactOptions = {}
): Promise<{ ref: GitArtifactRef; pending: PendingGitUpload }> {
  const enc = await encryptFileToTemp(srcPath, kek, retainDir);
  return {
    ref: enc.comp
      ? { sha: enc.plaintextSha, encSha: enc.encSha, cipherSize: enc.cipherSize, comp: enc.comp, payloadSha: enc.payloadSha }
      : { sha: enc.plaintextSha, encSha: enc.encSha, cipherSize: enc.cipherSize },
    pending: {
      encSha: enc.encSha,
      ciphertextPath: enc.ciphertextPath,
      cipherSize: enc.cipherSize,
      attempts: Math.max(1, opts.attempts ?? 1),
      uploadsDir: opts.uploadsDir,
      onBytes: opts.onBytes,
      backoff: opts.backoff,
    },
  };
}

/** §28/design 226: upload retained ciphertext, retrying a typed SHA mismatch
 * only after local re-verification. Cleanup remains the retention owner's job. */
export async function flushGitArtifact(store: BlobStore, pending: PendingGitUpload): Promise<void> {
  for (let attempt = 0; attempt < pending.attempts; attempt++) {
    try {
      if (!(await store.has(pending.encSha))) {
        if (store.putFile) await store.putFile(pending.encSha, pending.ciphertextPath, pending.cipherSize, pending.uploadsDir, pending.onBytes);
        else {
          await store.put(pending.encSha, await fs.readFile(pending.ciphertextPath));
          pending.onBytes?.(pending.cipherSize);
        }
      }
      return;
    } catch (e) {
      if (!isBlobShaMismatchError(e) || attempt + 1 >= pending.attempts) throw e;
      const actual = await hashFile(pending.ciphertextPath, pending.cipherSize).catch(() => undefined);
      if (actual !== pending.encSha) {
        throw new Error(`retained git artifact ciphertext no longer matches ${pending.encSha} at ${pending.ciphertextPath}`);
      }
      await pending.backoff?.(attempt);
    }
  }
  throw new Error("unreachable git artifact upload retry state");
}

/** §28: encrypt + upload in one step, cleaning up the ciphertext temp. The composition of
 *  `encryptGitArtifact` and `flushGitArtifact`, kept at its original signature for direct
 *  engine callers and for every `captureGitState` caller that supplies no upload collector. */
export async function putGitArtifact(
  store: BlobStore,
  kek: Buffer,
  srcPath: string,
  tmpDir: string,
  opts: PutGitArtifactOptions = {}
): Promise<GitArtifactRef> {
  const { ref, pending } = await encryptGitArtifact(kek, srcPath, tmpDir, opts);
  try {
    await flushGitArtifact(store, pending);
    return ref;
  } finally {
    await fs.rm(pending.ciphertextPath, { force: true });
  }
}

/** Fetch excludes `has`: a plan-local retained artifact must not be mistaken
 * for an artifact already present on the server (design 226). */
export type GitArtifactReadStore = Pick<BlobStore, "get" | "getToFile">;

async function getBlobToFile(store: GitArtifactReadStore, sha: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  if (store.getToFile) await store.getToFile(sha, destPath);
  else await fs.writeFile(destPath, await store.get(sha));
}

/** Fetch, decrypt, and verify into a pre-mutation temp path; fail closed. */
export async function getGitArtifact(store: GitArtifactReadStore, kek: Buffer, ref: GitArtifactRef, destPath: string, tmpDir: string): Promise<void> {
  const ct = path.join(tmpDir, `ct-${ref.encSha}`);
  await getBlobToFile(store, ref.encSha, ct);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  // Git artifacts are currently uncompressed. Compression requires adding a
  // declared plaintext size to GitArtifactRef and enforcing it here.
  await decryptFileToPath(ct, kek, ref.sha, destPath, { comp: ref.comp, payloadSha: ref.payloadSha });
  await fs.rm(ct, { force: true });
}
