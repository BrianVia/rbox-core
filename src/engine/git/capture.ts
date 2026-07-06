import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BlobStore } from "../blobstore.js";
import { validateGitSection } from "../manifest-validate.js";
import type { GitArtifactRef, GitSection } from "../types.js";
import { exists, git, gitOk, listWorktrees, putGitArtifact, readHead, type RepoCtx, repoCtx } from "./shared.js";
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
export async function captureGitState(repoDir: string, store: BlobStore, kek: Buffer): Promise<GitSection | undefined> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) return undefined; // unusable (dangling pointer etc.) → caller defers
  if (!(await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"]))) return undefined; // empty repo

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcap-"));
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
    const head = await readHead(ctx);
    const refs = ctx.kind === "dir" ? await readAllRefs(repoDir) : await readScopedRefs(repoDir, head);

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
    await git(repoDir, ["bundle", "create", bundlePath, ...bundleArgs]);

    // 4. §28: ENCRYPT each staged artifact under the workspace KEK, upload the CIPHERTEXT by
    //    encSha (convergent — same primitive as file blobs), and record (plaintext sha, encSha,
    //    cipherSize). The server only ever sees ciphertext + encShas; the manifest carrying this
    //    section is itself E2EE-encrypted, so refs/HEAD/object-shas stay private too.
    const bundle = await putGitArtifact(store, kek, bundlePath, tmpDir);

    let index: GitArtifactRef | undefined;
    if (stagedIndex) index = await putGitArtifact(store, kek, stagedIndex, tmpDir);
    const indexTree = await indexTreeOf(ctx);
    const opState: Record<string, GitArtifactRef> = {};
    for (const { rel, staged } of stagedOp) {
      opState[rel] = await putGitArtifact(store, kek, staged, tmpDir);
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
    // refs/heads) can assemble a section apply-side validation refuses. Defer this repo —
    // undefined, identical to the empty-repo path; the next cycle re-captures — rather than
    // commit a section every receiver will reject.
    if (!validateGitSection(section).ok) return undefined;
    return section;
  } finally {
    if (pins) await deleteScratchPins(repoDir, pins);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
