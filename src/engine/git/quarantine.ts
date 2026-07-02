import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BlobStore } from "../blobstore.js";
import type { GitSection } from "../types.js";
import { type RepoCtx, exists, getGitArtifact, git, gitOk, readHead, repoCtx } from "./shared.js";
import { pruneEmptyOpStateDirs, readAllRefs, readOpState, readScopedRefs } from "./refs.js";
import { WIP_NS, collectPinShas, createScratchPins, deleteScratchPins, pruneStaleScratchRefs } from "./pins.js";

/** Quarantine the local repo's committed + staged state before a mutating apply —
 *  a bundle with the SAME HEAD/pseudo-ref pinning discipline as capture, PLUS copies
 *  of index/op-state (full recovery, not refs-only — design 43 §9 [v5]). Dir repos
 *  bundle `--all`; pointer repos bundle their scoped line of work (an `--all` bundle
 *  of a big SHARED clone would be huge and isn't ours to quarantine). Throws on
 *  bundle failure — callers fail closed. */
export async function quarantineLocal(ctx: RepoCtx, qDir: string, ts: string): Promise<string> {
  await fs.mkdir(qDir, { recursive: true });
  const bundlePath = path.join(qDir, `${ts}.bundle`);
  // Same stale-scratch prune as capture: a legacy exact `refs/rbox-wip` ref D/F-blocks
  // the namespaced pins below and would fail the quarantine (→ spurious apply defer).
  await pruneStaleScratchRefs(ctx.repoDir, WIP_NS);
  const head = await readHead(ctx);
  const pinShas = new Set(await collectPinShas(ctx, head));
  const wip = (await git(ctx.repoDir, ["stash", "create"]).catch(() => "")).trim();
  if (wip) pinShas.add(wip);
  const pins = await createScratchPins(ctx.repoDir, [...pinShas]);
  try {
    const args =
      ctx.kind === "dir"
        ? ["--all", ...pins.refs]
        : [...Object.keys(await readScopedRefs(ctx.repoDir, head)), ...pins.refs];
    await git(ctx.repoDir, ["bundle", "create", bundlePath, ...args]);
  } finally {
    await deleteScratchPins(ctx.repoDir, pins);
  }
  if (await exists(path.join(ctx.gitDir, "index"))) {
    await fs.copyFile(path.join(ctx.gitDir, "index"), path.join(qDir, `${ts}.index`));
  }
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) {
    const dest = path.join(qDir, `${ts}-op`, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(ctx.gitDir, rel), dest);
  }
  return bundlePath;
}

/**
 * Design 43 §9 [v5] — the DIR-leftover half of a CLEAN MATERIALIZATION (fresh re-create
 * at a removed path): quarantine the local repo first (a bundle with the SAME
 * HEAD/pseudo-ref pinning discipline as capture, PLUS index/op-state copies — full
 * recovery, not refs-only), then DELETE its syncable refs + index + op-state (reset to
 * empty). A following {@link applyGitState} then lands on a clean target, so the
 * leftover's old refs can never re-enter a later all-scope capture (resurrection
 * through the side door — codex round-4 BLOCKER). DIR repos only: a pointer repo's
 * refs live in the SHARED main-clone store and must never be wiped — pointer leftovers
 * go through the guarded update-only apply instead. Throws when the quarantine fails
 * (callers defer the apply — fail closed, never wipe unquarantined state).
 */
export async function quarantineAndWipeGitState(repoDir: string): Promise<{ quarantineBundle?: string }> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repo unusable — cannot quarantine for clean materialization");
  if (ctx.kind !== "dir") throw new Error("refusing to ref-wipe a pointer repo (shared ref store)");
  let quarantineBundle: string | undefined;
  if (await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"])) {
    quarantineBundle = await quarantineLocal(ctx, path.join(repoDir, ".rbox", "git-quarantine"), `${Date.now()}`);
  }
  for (const ref of Object.keys(await readAllRefs(repoDir))) {
    await git(repoDir, ["update-ref", "-d", ref]);
  }
  await fs.rm(path.join(ctx.gitDir, "index"), { force: true });
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) {
    await fs.rm(path.join(ctx.gitDir, rel), { force: true }).catch(() => {});
  }
  await pruneEmptyOpStateDirs(ctx.gitDir, []);
  return { quarantineBundle };
}

/**
 * CONFLICT preserve (both sides diverged): do NOT clobber local. Import the remote
 * refs into a recovery namespace and bundle, so the user can merge manually.
 */
export async function preserveGitConflict(repoDir: string, section: GitSection, store: BlobStore, kek: Buffer): Promise<{ recoveryBundle?: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcf-"));
  try {
    const bundlePath = path.join(tmpDir, "remote.bundle");
    await getGitArtifact(store, kek, { sha: section.bundleSha, encSha: section.bundleEncSha, cipherSize: section.bundleCipherSize }, bundlePath, tmpDir);
    if (!(await gitOk(repoDir, ["bundle", "verify", bundlePath]))) return {};
    const ts = `${Date.now()}`;
    // --no-tags: tag-following would write remote tags DIRECTLY into refs/tags, outside the
    // recovery namespace — a silent local mutation the conflict flow must never make.
    await git(repoDir, ["fetch", "--no-tags", bundlePath, `refs/*:refs/rbox-conflict/${ts}/*`], { maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
    const recDir = path.join(repoDir, ".rbox", "git-conflicts");
    await fs.mkdir(recDir, { recursive: true });
    const recoveryBundle = path.join(recDir, `remote-${ts}.bundle`);
    await fs.copyFile(bundlePath, recoveryBundle).catch(() => {});
    return { recoveryBundle };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
