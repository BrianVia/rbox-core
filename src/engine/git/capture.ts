import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "../blobstore.js";
import { validateGitSection } from "../manifest-validate.js";
import type { GitArtifactRef, GitSection } from "../types.js";
import { exists, git, gitOk, headBranchOf, listWorktrees, putGitArtifact, readHead, type RepoCtx, repoCtx } from "./shared.js";
import { readAllRefs, readOpState, readScopedRefs } from "./refs.js";
import { type ScratchPins, WIP_NS, collectPinShas, createScratchPins, deleteScratchPins, pruneStaleScratchRefs } from "./pins.js";
import { indexTreeOf } from "./identity.js";

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

const WORKTREE_AWARE_CAPTURE_REASON = "git >= 2.15 required for worktree-aware capture";
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

async function makeGitCaptureDir(workspaceRoot: string): Promise<string> {
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
 *   detached linked-worktree HEAD would smuggle tier-2 state into the main bundle (codex M1;
 *   live-repro'd git 2.50.1). `--single-worktree` restricts rev-list to the main checkout's
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
    }
    const stagedOp: Array<{ rel: string; staged: string }> = [];
    const liveOp = await readOpState(ctx.gitDir, async () => ""); // just enumerate present op-state
    for (const rel of Object.keys(liveOp)) {
      const staged = path.join(tmpDir, "op", rel);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(path.join(ctx.gitDir, rel), staged);
      stagedOp.push({ rel, staged });
    }

    // 2. refs + HEAD (scope-aware) — read via git / atomic file from the resolved gitdir.
    let head = await readHead(ctx);
    const refs = ctx.kind === "dir" ? await readAllRefs(repoDir) : await readScopedRefs(repoDir, head);
    head = normalizeSymbolicHeadCasing(head, refs);

    // 3. Make dirty+staged state + pseudo-ref commits reachable, then bundle.
    //    `git stash create` works from a worktree context unchanged.
    const wip = (await git(repoDir, ["stash", "create"]).catch(() => "")).trim();
    const pinShas = new Set(await collectPinShas(ctx, head));
    if (wip) pinShas.add(wip);
    pins = await createScratchPins(repoDir, [...pinShas]);
    const bundlePath = path.join(tmpDir, "repo.bundle");
    let dirAllArgs: string[] | undefined;
    if (ctx.kind === "dir") {
      const decision = decideDirBundleAllArgs(await gitSupportsSingleWorktree(repoDir), await hasLiveLinkedWorktrees(ctx));
      if (!decision.ok) throw new GitCaptureDeferredError(decision.reason);
      dirAllArgs = decision.args;
    }
    const bundleArgs =
      ctx.kind === "dir"
        ? [...dirAllArgs!, ...(refs["refs/stash"] ? ["refs/stash"] : []), ...pins.refs]
        : [...Object.keys(refs), ...pins.refs]; // current branch (if any) + pins; detached HEAD rides its pin
    const basisTips = [...new Set(opts.basis?.tips ?? [])].filter((tip) => /^[0-9a-f]{40}$/.test(tip)).sort();
    try {
      await git(repoDir, ["bundle", "create", bundlePath, ...bundleArgs, ...basisTips.map((tip) => `^${tip}`)]);
    } catch (e) {
      if (basisTips.length === 0) throw e;
      opts.onBasisFallback?.((e as Error)?.message ?? String(e));
      await fs.rm(bundlePath, { force: true }).catch(() => {});
      await git(repoDir, ["bundle", "create", bundlePath, ...bundleArgs]);
    }

    // 4. §28: ENCRYPT each staged artifact under the workspace KEK, upload the CIPHERTEXT by
    //    encSha (convergent — same primitive as file blobs), and record (plaintext sha, encSha,
    //    cipherSize). The server only ever sees ciphertext + encShas; the manifest carrying this
    //    section is itself E2EE-encrypted, so refs/HEAD/object-shas stay private too.
    const uploadOpts = { attempts: opts.uploadAttempts, backoff: opts.backoff, uploadsDir: opts.uploadsDir };
    const bundle = await putGitArtifact(store, kek, bundlePath, tmpDir, uploadOpts);

    let index: GitArtifactRef | undefined;
    if (stagedIndex) index = await putGitArtifact(store, kek, stagedIndex, tmpDir, uploadOpts);
    const indexTree = await indexTreeOf(ctx);
    const opState: Record<string, GitArtifactRef> = {};
    for (const { rel, staged } of stagedOp) {
      opState[rel] = await putGitArtifact(store, kek, staged, tmpDir, uploadOpts);
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
    return section;
  } finally {
    if (pins) await deleteScratchPins(repoDir, pins);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
