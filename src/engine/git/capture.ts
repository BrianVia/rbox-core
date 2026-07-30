import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore, ByteProgressCallback } from "../blobstore.js";
import { validateGitSection } from "../manifest-validate.js";
import type { GitArtifactRef, GitSection } from "../types.js";
import { clearIndexResolveUndo, encryptGitArtifact, exists, git, gitOk, headBranchOf, listWorktrees, putGitArtifact, readHead, type PendingGitUpload, type RepoCtx, repoCtx } from "./shared.js";
import { hasInProgressOpState, readAllRefsStrict, readOpStateSnapshot, readScopedRefs } from "./refs.js";
import { type ScratchPins, WIP_NS, collectPinShas, createScratchPins, deleteScratchPins, pruneStaleScratchRefs } from "./pins.js";
import { indexTreeOfPath } from "./identity.js";
import { hashFile } from "../hash.js";

/**
 * Git-native repo-state sync (M2 v3, generalized per design 43 §§4-5). History rides
 * `git bundle` (consistent on a live repo by design); index/HEAD/op-state are atomic
 * single-file captures read from the RESOLVED gitdir (`git rev-parse --absolute-git-dir`)
 * — for pointer repos (worktree/submodule checkouts) that lands in the main clone's
 * `.git/worktrees/<n>/` (or `.git/modules/…`), never a hardcoded `repoDir/.git`.
 *
 * Change detection uses a STABLE identity (refs + HEAD + index hash + op-state),
 * NOT the bundle bytes — `git stash create` mints a fresh commit each capture, so
 * bundle bytes vary even when the repo is unchanged; keying off them would echo
 * the git section forever.
 */

// ---- capture (design 43 §5) ----------------------------------------------------

export class GitCaptureDeferredError extends Error {
  override name = "GitCaptureDeferredError";
}

async function readCaptureRefsStrict(repoDir: string): Promise<Record<string, string>> {
  const result = await readAllRefsStrict(repoDir);
  if (result.status === "unreadable") {
    throw new GitCaptureDeferredError(`ref-read-unreadable: ${result.marker}`);
  }
  return result.refs;
}

const WORKTREE_AWARE_CAPTURE_REASON = "git >= 2.15 required for worktree-aware capture";
const RBOX_INTERNAL_REFS_EXCLUDE = "--exclude=refs/rbox-*";
const GITCAP_STALE_MS = 24 * 60 * 60 * 1000;
const GITCAP_OWNER_PID = "owner.pid";
let supportsSingleWorktreeCache: boolean | undefined;

async function gitSupportsSingleWorktree(repoDir: string): Promise<boolean> {
  if (supportsSingleWorktreeCache !== undefined) return supportsSingleWorktreeCache;
  supportsSingleWorktreeCache = await gitOk(repoDir, ["rev-list", "--single-worktree", "--max-count=0", "HEAD"]);
  return supportsSingleWorktreeCache;
}

async function hasLiveLinkedWorktrees(ctx: RepoCtx): Promise<boolean> {
  const selfReal = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
  for (const e of await listWorktrees(ctx.repoDir)) {
    if (e.prunable) continue;
    const real = await fs.realpath(e.path).catch(() => path.resolve(e.path));
    if (real !== selfReal) return true;
  }
  return false;
}

export function decideDirBundleAllArgs(
  supportsSingleWorktree: boolean,
  liveLinkedWorktrees: boolean
): { ok: true; args: string[] } | { ok: false; reason: string } {
  if (supportsSingleWorktree) return { ok: true, args: ["--single-worktree", "--all"] };
  if (liveLinkedWorktrees) return { ok: false, reason: WORKTREE_AWARE_CAPTURE_REASON };
  return { ok: true, args: ["--all"] };
}

/** Design 226: the caller-owned sink that defers this capture's uploads. */
export interface GitCaptureUploadCollector {
  /** Directory the ciphertext is retained in. Outlives the capture, so it must NOT be
   *  the capture's own temp dir; mint it with `makeGitCaptureDir`. */
  retainDir: string;
  /** Pending uploads, appended in capture order. */
  pending: PendingGitUpload[];
}

export interface GitCaptureOptions {
  /** Workspace root whose `.rbox/gitcap/` owns capture scratch. Defaults to `repoDir`
   *  for direct engine callers; sync-git passes the actual workspace root. */
  workspaceRoot?: string;
  /** Resumable multipart token directory, normally `<workspace>/.rbox/state/uploads`. */
  uploadsDir?: string;
  /** Bounded sha-mismatch retry count supplied by the file-upload path. */
  uploadAttempts?: number;
  /** Backoff between sha-mismatch retries; attempt is zero-based. */
  backoff?: (attempt: number) => Promise<void>;
  /** Previous section tips that may be excluded from this bundle to produce an increment. */
  basis?: { tips: string[] };
  /** Internal planning hook: called when basis bundle creation degrades to a full bundle. */
  onBasisFallback?: (reason: string) => void;
  /** Cumulative ciphertext bytes uploaded during this capture. Engine-local:
   *  callers decide how to surface it. */
  onBytes?: ByteProgressCallback;
  /** Design 226: when supplied, this capture ENCRYPTS its artifacts into
   *  `uploads.retainDir` and appends the pending uploads to `uploads.pending`
   *  INSTEAD of uploading them — the caller owns both the upload and the
   *  reclamation of the retained ciphertext. Absent (the default, and every
   *  caller but the push planner) the artifacts are uploaded inline exactly as
   *  before, so a caller that reads them straight back out of `store` still can. */
  uploads?: GitCaptureUploadCollector;
  /** Synchronous keep-mine hardening: pin the recorded snapshot and prove the
   * live repository still equals it before returning a publish candidate. */
  resolution?: boolean;
  /** Deterministic capture-race seams. Production never supplies these. */
  testHooks?: {
    afterStagedArtifacts?: () => void | Promise<void>;
    afterRefsRecorded?: () => void | Promise<void>;
    afterStashCreated?: () => void | Promise<void>;
    afterScratchPins?: (snapshot: { tmpDir: string; bundlePath: string; refs: readonly string[] }) => void | Promise<void>;
    beforeStabilityCheck?: () => void | Promise<void>;
  };
}

/** Complete object roots for a raw/unmerged staged index. Paths are NUL framed;
 * filenames containing newlines must never corrupt object enumeration. */
export async function stagedIndexObjectOids(repoDir: string, stagedIndex: string): Promise<string[]> {
  const stagedEntries = await git(repoDir, ["ls-files", "-z", "--stage", "--sparse"], { env: { GIT_INDEX_FILE: stagedIndex } });
  const oids = new Set<string>();
  for (const entry of stagedEntries.split("\0")) {
    if (!entry) continue;
    const match = /^\d+\s+([0-9a-f]{40})\s+\d+\t/.exec(entry);
    if (!match || /^0{40}$/.test(match[1]!)) continue;
    await git(repoDir, ["cat-file", "-e", `${match[1]}^{object}`]);
    oids.add(match[1]!);
  }
  return [...oids].sort();
}

export function gitCaptureScratchRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".rbox", "gitcap");
}

export function normalizeSymbolicHeadCasing(head: string, refs: Record<string, string>): string {
  const branch = headBranchOf(head);
  if (!branch || Object.prototype.hasOwnProperty.call(refs, branch)) return head;
  const matches = Object.keys(refs).filter((ref) => ref.toLowerCase() === branch.toLowerCase());
  // macOS/APFS case-insensitivity can leave HEAD with checkout-time casing while
  // packed-refs/show-ref preserves another spelling. Use the ref store's casing as
  // truth only when it identifies exactly one branch; ambiguous cases still fail
  // validation below.
  return matches.length === 1 ? `ref: ${matches[0]}` : head;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readGitCaptureOwnerPid(dir: string): Promise<number | "absent" | "unreadable"> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, GITCAP_OWNER_PID), "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : "unreadable";
}

export async function sweepStaleGitCaptureDirs(workspaceRoot: string, now = Date.now(), olderThanMs = GITCAP_STALE_MS): Promise<void> {
  const root = gitCaptureScratchRoot(workspaceRoot);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("rbox-gitcap-")) return;
      const abs = path.join(root, entry.name);
      const owner = await readGitCaptureOwnerPid(abs);
      if (typeof owner === "number") {
        if (pidIsAlive(owner)) return;
        await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
        return;
      }
      if (owner === "absent") {
        await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
        return;
      }
      const st = await fs.stat(abs).catch(() => undefined);
      if (!st || now - st.mtimeMs < olderThanMs) return;
      await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
    })
  );
}

/** Mint a capture-owned scratch dir under `<workspaceRoot>/.rbox/gitcap/`. The
 *  mkdtemp-then-rename is load-bearing: the staging name `.rbox-gitcap-*` deliberately
 *  misses the sweep's `rbox-gitcap-` prefix, so the window before `owner.pid` exists is
 *  invisible to the concurrent crash reaper. Exported for design 226's plan-lifetime
 *  artifact retention dir, which needs exactly these properties — never reimplement it. */
export async function makeGitCaptureDir(workspaceRoot: string): Promise<string> {
  const scratch = gitCaptureScratchRoot(workspaceRoot);
  await fs.mkdir(scratch, { recursive: true, mode: 0o700 });
  await fs.chmod(scratch, 0o700).catch(() => {});
  await sweepStaleGitCaptureDirs(workspaceRoot);
  const pending = await fs.mkdtemp(path.join(scratch, ".rbox-gitcap-"));
  await fs.chmod(pending, 0o700).catch(() => {});
  await fs.writeFile(path.join(pending, GITCAP_OWNER_PID), `${process.pid}\n`, { mode: 0o600 });
  const dir = path.join(scratch, `rbox-gitcap-${path.basename(pending).slice(".rbox-gitcap-".length)}`);
  await fs.rename(pending, dir);
  return dir;
}

/** Full capture: build the bundle + upload all artifacts; return the manifest section.
 *
 * Small files (index, op-state) are STAGED (copied) into a temp dir FIRST and then
 * hashed+uploaded from those copies — never from the live gitdir. This avoids a
 * TOCTOU where `git stash create` (below) rewrites the index between hashing and
 * upload, making the claimed sha disagree with the uploaded bytes. (git writes
 * these files via atomic rename, so a copy is always an internally-consistent
 * snapshot.) History rides the bundle, which git produces consistently regardless.
 *
 * Scope split (design 43 §5):
 * - dir repo → refScope "all": bundle `--single-worktree --all` + refs/stash + enumerated
 *   pins. The `--single-worktree` restriction (design 68 §3.1) matters ONLY for a main clone
 *   with linked worktrees: plain `--all` runs rev-list over EVERY worktree's HEAD, so a
 *   detached linked-worktree HEAD would smuggle tier-2 state into the main bundle —
 *   live-repro'd git 2.50.1. `--single-worktree` restricts rev-list to the main checkout's
 *   view; branches checked out in worktrees are ordinary `refs/heads/*` and still ride. It is
 *   a harmless no-op on a worktree-free repo. Ancient git without `--single-worktree`
 *   falls back to plain `--all` only when no live linked worktrees exist; with live
 *   worktrees we defer instead of smuggling detached tier-2 state.
 * - pointer repo → refScope "scoped": bundle `refs/heads/<current-branch>` + enumerated
 *   pins ONLY — no `--all` (so `--single-worktree` does not apply), and `refs/stash` is NEVER
 *   captured (it lives in the SHARED gitdir; per-worktree capture would fan one global stash
 *   stack out into N standalone repos [v2, B2]). Uncommitted dirty state still transfers via
 *   the WIP commit + index.
 */
export async function captureGitState(repoDir: string, store: BlobStore, kek: Buffer, opts: GitCaptureOptions = {}): Promise<GitSection | undefined> {
  // The two early bails are NAMED (savvy-core incident: a repo deferred for days as
  // "capture returned nothing" with no way to see why). Each re-runs the failing probe
  // and surfaces git's actual complaint in the defer reason.
  const ctx = await repoCtx(repoDir);
  if (!ctx) {
    const why = await git(repoDir, ["rev-parse", "--absolute-git-dir"]).then(
      () => "unsupported .git shape (symlink, or unreadable pointer)",
      (e) => (e instanceof Error ? e.message.split("\n").slice(0, 2).join(" ") : String(e))
    );
    throw new GitCaptureDeferredError(`repo context unresolvable: ${why}`);
  }
  if (!(await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"]))) {
    const why = await git(repoDir, ["rev-parse", "--verify", "HEAD"]).then(
      () => "transient: HEAD verified on recheck",
      (e) => (e instanceof Error ? e.message.split("\n").slice(0, 2).join(" ") : String(e))
    );
    throw new GitCaptureDeferredError(`HEAD unverifiable (empty repo, or drifted symbolic ref): ${why}`);
  }

  // Stage on the WORKSPACE filesystem (under .rbox), NOT os.tmpdir(): git bundles,
  // staged index/op-state, plaintext encryption snapshots, and ciphertext temps can
  // be large and live across hash→multipart upload. Keeping them under the repo root
  // avoids tmp cleaners/truncation and stays on the same mount for cheap local moves.
  const tmpDir = await makeGitCaptureDir(opts.workspaceRoot ?? repoDir);
  let pins: ScratchPins | undefined;
  try {
    // Age-guarded prune of scratch refs left by prior crashed captures (shared-store safe).
    await pruneStaleScratchRefs(repoDir, WIP_NS);

    // 1. Stage index + op-state immediately (atomic single-file snapshots) — from the
    //    RESOLVED gitdir (pointer repos: `.git/worktrees/<n>/…`), never `repoDir/.git`.
    let stagedIndex: string | undefined;
    if (await exists(path.join(ctx.gitDir, "index"))) {
      stagedIndex = path.join(tmpDir, "index");
      await fs.copyFile(path.join(ctx.gitDir, "index"), stagedIndex);
      await clearIndexResolveUndo(repoDir, stagedIndex);
    }
    const stagedOp: Array<{ rel: string; staged: string }> = [];
    const sampledOp = await readOpStateSnapshot(ctx.gitDir, hashFile);
    for (const rel of Object.keys(sampledOp.files)) {
      const staged = path.join(tmpDir, "op", rel);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(path.join(ctx.gitDir, rel), staged);
      stagedOp.push({ rel, staged });
    }
    const stagedOpFiles = Object.fromEntries(await Promise.all(stagedOp.map(async ({ rel, staged }) => [rel, await hashFile(staged)])));
    const stagedOpSnapshot = { files: stagedOpFiles, rootsPresent: sampledOp.rootsPresent };
    if (opts.resolution && hasInProgressOpState(stagedOpSnapshot)) {
      throw new GitCaptureDeferredError("a Git operation is in progress; finish or abort it, then run keep-mine again");
    }
    await opts.testHooks?.afterStagedArtifacts?.();

    // 2. refs + HEAD (scope-aware) — read via git / atomic file from the resolved gitdir.
    let head = await readHead(ctx);
    const refs = ctx.kind === "dir" ? await readCaptureRefsStrict(repoDir) : await readScopedRefs(repoDir, head);
    head = normalizeSymbolicHeadCasing(head, refs);
    await opts.testHooks?.afterRefsRecorded?.();

    // 3. Make dirty+staged state + pseudo-ref commits reachable, then bundle.
    //    Stash against the private staged index. Git may refresh index stat data
    //    while creating the synthetic commit; the live index must remain outside
    //    capture's write set.
    const privateStashIndex = path.resolve(stagedIndex ?? path.join(tmpDir, "absent-index"));
    const wip = (await git(
      repoDir,
      ["stash", "create"],
      { env: { GIT_INDEX_FILE: privateStashIndex } },
    ).catch(() => "")).trim();
    await opts.testHooks?.afterStashCreated?.();
    const pinShas = new Set(await collectPinShas(ctx, head, path.join(tmpDir, "op")));
    if (wip) pinShas.add(wip);
    const indexTree = stagedIndex ? await indexTreeOfPath(ctx, stagedIndex) : undefined;
    if (opts.resolution && indexTree && /^[0-9a-f]{40}$/.test(indexTree)) pinShas.add(indexTree);
    if (opts.resolution && stagedIndex && indexTree?.startsWith("raw:")) {
      for (const oid of await stagedIndexObjectOids(repoDir, stagedIndex)) pinShas.add(oid);
    }
    if (opts.resolution) for (const oid of Object.values(refs)) pinShas.add(oid);
    pins = await createScratchPins(repoDir, [...pinShas]);
    const bundlePath = path.join(tmpDir, "repo.bundle");
    await opts.testHooks?.afterScratchPins?.({ tmpDir, bundlePath, refs: pins.refs });
    let dirAllArgs: string[] | undefined;
    if (ctx.kind === "dir" && !opts.resolution) {
      const decision = decideDirBundleAllArgs(await gitSupportsSingleWorktree(repoDir), await hasLiveLinkedWorktrees(ctx));
      if (!decision.ok) throw new GitCaptureDeferredError(decision.reason);
      dirAllArgs = decision.args;
    }
    const bundleArgs = opts.resolution
      ? pins.refs
      : ctx.kind === "dir"
        ? [...dirAllArgs!, ...(refs["refs/stash"] ? ["refs/stash"] : []), ...pins.refs]
        : [...Object.keys(refs), ...pins.refs]; // current branch (if any) + pins; detached HEAD rides its pin
    const basisTips = [...new Set(opts.basis?.tips ?? [])].filter((tip) => /^[0-9a-f]{40}$/.test(tip)).sort();
    try {
      await git(repoDir, ["bundle", "create", bundlePath, RBOX_INTERNAL_REFS_EXCLUDE, ...bundleArgs, ...basisTips.map((tip) => `^${tip}`)]);
    } catch (e) {
      if (basisTips.length === 0) throw e;
      opts.onBasisFallback?.((e as Error)?.message ?? String(e));
      await fs.rm(bundlePath, { force: true }).catch(() => {});
      await git(repoDir, ["bundle", "create", bundlePath, RBOX_INTERNAL_REFS_EXCLUDE, ...bundleArgs]);
    }

    // 4. §28: ENCRYPT each staged artifact under the workspace KEK, upload the CIPHERTEXT by
    //    encSha (convergent — same primitive as file blobs), and record (plaintext sha, encSha,
    //    cipherSize). The server only ever sees ciphertext + encShas; the manifest carrying this
    //    section is itself E2EE-encrypted, so refs/HEAD/object-shas stay private too.
    let captureBytes = 0;
    const uploadOpts = () => {
      let artifactAbs = 0;
      return {
        attempts: opts.uploadAttempts,
        backoff: opts.backoff,
        uploadsDir: opts.uploadsDir,
        onBytes: (abs: number) => {
          captureBytes += Math.max(0, abs - artifactAbs);
          artifactAbs = abs;
          opts.onBytes?.(captureBytes);
        },
      };
    };
    //    Design 226: with an upload collector the CIPHERTEXT is retained for the caller
    //    to flush after it has decided the section's fate; without one (every caller but
    //    the push planner) it is uploaded inline, right here, as it always was.
    const collector = opts.uploads;
    const artifact = async (srcPath: string): Promise<GitArtifactRef> => {
      const artifactOpts = uploadOpts();
      if (!collector) return putGitArtifact(store, kek, srcPath, tmpDir, artifactOpts);
      const { ref, pending } = await encryptGitArtifact(kek, srcPath, collector.retainDir, artifactOpts);
      collector.pending.push(pending);
      return ref;
    };
    const bundle = await artifact(bundlePath);

    let index: GitArtifactRef | undefined;
    if (stagedIndex) index = await artifact(stagedIndex);
    const opState: Record<string, GitArtifactRef> = {};
    for (const { rel, staged } of stagedOp) {
      opState[rel] = await artifact(staged);
    }

    const section: GitSection = {
      bundleSha: bundle.sha,
      bundleEncSha: bundle.encSha,
      bundleCipherSize: bundle.cipherSize,
      head,
      refs,
      indexSha: index?.sha,
      indexEncSha: index?.encSha,
      indexCipherSize: index?.cipherSize,
      indexTree,
      opState: Object.keys(opState).length ? opState : undefined,
      refScope: ctx.kind === "dir" ? "all" : "scoped",
      generatedAt: new Date().toISOString(),
    };
    // Engine self-check (scrutiny M4): a capture race (branch deleted between the HEAD and
    // refs reads by a concurrent git/sibling worktree, or an exotic symbolic-ref outside
    // refs/heads) can assemble a section apply-side validation refuses. Defer this repo
    // with the validator reason rather than commit a section every receiver will reject.
    const validation = validateGitSection(section);
    if (!validation.ok) throw new GitCaptureDeferredError(`capture failed self-validation: ${validation.reason ?? "invalid git section"}`);
    if (opts.resolution) {
      await opts.testHooks?.beforeStabilityCheck?.();
      try {
        let liveHead = await readHead(ctx);
        const liveRefs = ctx.kind === "dir" ? await readCaptureRefsStrict(repoDir) : await readScopedRefs(repoDir, liveHead);
        liveHead = normalizeSymbolicHeadCasing(liveHead, liveRefs);
        const liveIndexPath = path.join(ctx.gitDir, "index");
        const liveIndex = await exists(liveIndexPath);
        let liveIndexTree: string | undefined;
        if (liveIndex) {
          const normalizedLiveIndex = path.join(tmpDir, "live-index");
          await fs.copyFile(liveIndexPath, normalizedLiveIndex);
          await clearIndexResolveUndo(repoDir, normalizedLiveIndex);
          liveIndexTree = await indexTreeOfPath(ctx, normalizedLiveIndex);
        }
        const liveOpSnapshot = await readOpStateSnapshot(ctx.gitDir, hashFile);
        const canonical = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
        const stable = liveHead === head
          && canonical(liveRefs) === canonical(refs)
          && liveIndex === (stagedIndex !== undefined)
          && liveIndexTree === indexTree
          && canonical(liveOpSnapshot.files) === canonical(stagedOpSnapshot.files)
          && JSON.stringify([...liveOpSnapshot.rootsPresent].sort()) === JSON.stringify([...stagedOpSnapshot.rootsPresent].sort());
        if (!stable) throw new Error("snapshot mismatch");
      } catch (error) {
        if (error instanceof GitCaptureDeferredError && error.message.startsWith("ref-read-unreadable:")) throw error;
        throw new GitCaptureDeferredError("your repository changed while publishing — run the command again");
      }
    }
    return section;
  } finally {
    if (pins) await deleteScratchPins(repoDir, pins);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
