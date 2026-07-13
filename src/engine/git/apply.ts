import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "../blobstore.js";
import { writeFileAtomic } from "../fsutil.js";
import { validateGitSection } from "../manifest-validate.js";
import type { GitSection } from "../types.js";
import {
  addTimedMs,
  type GitChainTimings,
  type RepoCtx,
  clearIndexResolveUndo,
  detectGitKind,
  exists,
  getGitArtifact,
  git,
  gitBusy,
  gitOk,
  headBranchOf,
  importGitPackChain,
  listWorktrees,
  moveFileAtomic,
  repoCtx,
} from "./shared.js";
import { listRefs, readAllRefs, restoreOpState } from "./refs.js";
import { pruneStaleScratchRefs } from "./pins.js";
import { quarantineLocal } from "./quarantine.js";
import { restoreLocal, snapshotLocal } from "./rollback.js";

// ---- apply (design 43 §7) -------------------------------------------------------

export interface ApplyGitResult {
  applied: boolean;
  reason?: string;
  conflictBundle?: string;
  /** Dir-target refs held at their receiver values because a sibling worktree owns
   *  them (design 116 phase-0). Non-empty on a successful PARTIAL apply. */
  heldRefs?: Record<string, string>;
  /** Refs the pointer-target namespace/ownership filter refused to publish
   *  (design 43 §7 [v3/v4]) — surfaced so the caller can log them. */
  filteredRefs?: string[];
}

/** Branches (full refname → linked-worktree display name) checked out by a DIFFERENT,
 *  NON-PRUNABLE worktree of the same store — `git update-ref refs/heads/x` from one
 *  worktree silently moves a branch a sibling has checked out, leaving that sibling dirty
 *  (`git branch -f` refuses; `update-ref` does not — codex repro, design 43 §7 [v4]).
 *  Prunable (stale) entries are ignored so they can't produce phantom collisions
 *  (design 68 V13). From `git worktree list --porcelain`. */
export async function branchesCheckedOutElsewhere(ctx: RepoCtx): Promise<Map<string, string>> {
  const selfReal = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
  const owned = new Map<string, string>();
  for (const e of await listWorktrees(ctx.repoDir)) {
    if (e.prunable || !e.branch) continue;
    const real = await fs.realpath(e.path).catch(() => path.resolve(e.path));
    if (real !== selfReal) owned.set(e.branch, path.basename(e.path));
  }
  return owned;
}

/** Design 116 phase-0 supersedes design 68 §3.2's ANY-intersection defer: ordinary
 *  sibling-owned ref updates/deletions are held per ref, while HEAD/index/op-state and
 *  unrelated refs keep moving. HEAD ownership and clean-materialization wipes remain
 *  whole-apply hazards. Current refs are read ONCE so an identical incoming OID is a
 *  no-op, never a hold (the field-incident shape). Read-only. */
async function classifyWorktreeOwnership(
  ctx: RepoCtx,
  section: GitSection,
  deletesAbsent: boolean,
  beforeMutateWipesRefs: boolean
): Promise<{ heldRefs: Map<string, string>; deferReason?: string }> {
  const owned = await branchesCheckedOutElsewhere(ctx);
  const heldRefs = new Map<string, string>();
  if (owned.size === 0) return { heldRefs };
  const localRefs = await readAllRefs(ctx.repoDir);
  const shortName = (ref: string) => ref.replace(/^refs\/heads\//, "");
  const collision = (ref: string, suffix = "") => `worktree-ownership: branch ${shortName(ref)} checked out in linked worktree ${owned.get(ref)}${suffix}`;
  // HEAD move is a checkout-plane collision even when its ref OID is already equal:
  // the primary checkout may not attach to a branch held by a sibling worktree.
  const headBranch = headBranchOf(section.head);
  if (headBranch && owned.has(headBranch)) return { heldRefs, deferReason: collision(headBranch) };
  // pre-mutation ref wipe — clean materialization deletes every local syncable ref before
  // publishing even scoped sections; partial holding of a wipe is undefined in D1.
  if (beforeMutateWipesRefs) {
    for (const ref of Object.keys(localRefs)) {
      if (owned.has(ref)) return { heldRefs, deferReason: collision(ref, " (would be wiped)") };
    }
  }
  // Ref updates: equality is a true no-op, so only a different/absent local OID is held.
  for (const [ref, incomingOid] of Object.entries(section.refs)) {
    const worktree = owned.get(ref);
    if (worktree && localRefs[ref] !== incomingOid) heldRefs.set(ref, worktree);
  }
  // Ref deletions: an owned local branch absent from an all-scope section survives.
  if (deletesAbsent) {
    for (const ref of Object.keys(localRefs)) {
      const worktree = owned.get(ref);
      if (worktree && !(ref in section.refs)) heldRefs.set(ref, worktree);
    }
  }
  return { heldRefs };
}

/**
 * CLEAN apply (caller guarantees local == base): import objects from the bundle,
 * publish refs/HEAD per the SCOPE-GATED rules below, restore index/op-state — under
 * receiver quiescence, transactionally. On any failure or fsck-fail, ROLL BACK to
 * the pre-apply snapshot. Quarantines local first (fail-closed if that fails).
 *
 * Ref-publish semantics (design 43 §7 [v2, B1; v3; v4]):
 * - deletion of absent local refs happens ONLY when section.refScope === "all" AND the
 *   local repo is a dir-repo (both sides speak "complete set" — design-02 semantics);
 * - a "scoped" section applied into a dir-repo is UPDATE-ONLY (extra local branches survive);
 * - ANY section applied into a local POINTER repo touches a ref store SHARED with sibling
 *   worktrees and the main clone: `refs/stash` + `refs/tags/*` are FILTERED, and
 *   `refs/heads/*` publication is OWNERSHIP-GUARDED via `git worktree list --porcelain` —
 *   a branch checked out by a DIFFERENT worktree is filtered (returned in filteredRefs);
 *   if the section's own HEAD branch is blocked, the WHOLE apply defers
 *   ({applied:false, reason: "ownership-deferred: …"}).
 *
 * NOTE (STEP 3): callers materializing a repo at `join(root, key)` must run
 * {@link assertGitTargetWithinRoot} BEFORE this function and re-verify after `git init`
 * (design 43 §7 [v2, B5; v3]) — this function trusts `repoDir`.
 *
 * `opts.beforeMutate` (design 43 §9 [v5] clean materialization): invoked AFTER every
 * artifact has been fetched+decrypted+verified/imported into scratch refs but BEFORE
 * publish/ref-wipe/index mutation. The caller's quarantine+ref-wipe of a removal-memory
 * leftover runs here, so a missing or corrupt remote artifact can never strand a wiped
 * repo. When the hook wipes syncable refs, callers must set
 * `beforeMutateWipesRefs` so the worktree collision pre-check can defer before the hook
 * strands a sibling checkout. A hook throw returns {applied:false} after scratch refs
 * are cleaned.
 */
export async function applyGitState(
  repoDir: string,
  section: GitSection,
  store: BlobStore,
  kek: Buffer,
  opts: {
    beforeMutate?: () => Promise<void>;
    beforeMutateWipesRefs?: boolean;
    /** Final mutation in the rollback boundary. Design 93 uses this for config:
     * its rename is the combined git+config commit point. */
    afterGitMutate?: () => Promise<void>;
    chainTimings?: GitChainTimings;
  } = {}
): Promise<ApplyGitResult> {
  const v = validateGitSection(section);
  if (!v.ok) return { applied: false, reason: `invalid git section: ${v.reason}` };

  // Fresh target (no .git): the repo is materialized by `git init` — but only AFTER every
  // artifact has been fetched+decrypted+verified (decrypt-before-mutate: a wrong-KEK apply
  // must leave NO .git behind — codex repro'd the old init-first order doing exactly that).
  // "Fresh" strictly means NO `.git` entry at all: a symlinked `.git` (kind undefined but
  // lstat-present) must be REFUSED, not initialized — `git init` through the symlink would
  // reinitialize the LINKED repo, and the fresh-cleanup would then delete the user's symlink,
  // hijacking the directory on the next cycle (scrutiny M1).
  const preKind = await detectGitKind(repoDir);
  if (!preKind && (await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined))) {
    return { applied: false, reason: ".git is neither a directory nor a gitfile pointer — unsupported apply target" };
  }
  let ctx = preKind ? await repoCtx(repoDir) : undefined;
  if (preKind && !ctx) return { applied: false, reason: "repo unusable (dangling .git pointer?)" };

  // Scope-gated publish set (design 43 §7). A fresh target materializes as a dir repo.
  const publishRefs: Record<string, string> = { ...section.refs };
  const filteredRefs: string[] = [];
  const heldRefs = new Map<string, string>();
  let deleteAbsent = false;
  if (!ctx || ctx.kind === "dir") {
    // superproject/alternates stores have undefined apply semantics (design 43 §4, v1) —
    // still structurally refused. A PRIMARY with linked worktrees is now ELIGIBLE
    // (design 68 §3.1); its one hazard — silently moving a sibling's checked-out branch —
    // is caught by the §3.2 collision defer below, not a blanket refusal.
    if (ctx) {
      for (const bad of ["modules", "objects/info/alternates"]) {
        if (await exists(path.join(ctx.commonDir, bad))) {
          return { applied: false, reason: `.git/${bad} present — unsupported apply target` };
        }
      }
    }
    deleteAbsent = section.refScope === "all";
    // Design 116 phase-0: retain the zero-cost no-worktrees path, then hold only
    // sibling-owned refs whose OIDs would actually move (or whose deletion is requested).
    if (ctx && (await exists(path.join(ctx.commonDir, "worktrees")))) {
      const ownership = await classifyWorktreeOwnership(ctx, section, deleteAbsent, opts.beforeMutateWipesRefs === true);
      if (ownership.deferReason) return { applied: false, reason: ownership.deferReason };
      for (const [ref, worktree] of ownership.heldRefs) {
        heldRefs.set(ref, worktree);
        delete publishRefs[ref];
      }
    }
  } else {
    for (const ref of Object.keys(publishRefs)) {
      if (!ref.startsWith("refs/heads/")) {
        // a standalone receiver's stash/tags must never overwrite the SHARED stash stack
        // or tag namespace [v3]
        filteredRefs.push(ref);
        delete publishRefs[ref];
      }
    }
    const owned = await branchesCheckedOutElsewhere(ctx);
    const localRefs = owned.size > 0 ? await readAllRefs(ctx.repoDir) : {};
    for (const ref of Object.keys(publishRefs)) {
      // Design 116 phase-0: publishing the identical OID cannot disturb the sibling;
      // keep it in the publish set as an explicit no-op, not a filtered ref.
      if (owned.has(ref) && localRefs[ref] !== publishRefs[ref]) {
        filteredRefs.push(ref);
        delete publishRefs[ref];
      }
    }
    const headBranch = headBranchOf(section.head);
    if (headBranch && owned.has(headBranch)) {
      // applying a HEAD that points at a branch we refused to move would be incoherent [v4]
      return { applied: false, reason: `ownership-deferred: ${headBranch} is checked out by another worktree`, filteredRefs };
    }
  }
  if (ctx && (await gitBusy(ctx))) return { applied: false, reason: "receiver git busy" };

  // Stage on the REPO's filesystem (under .rbox), NOT os.tmpdir() — the decrypted index/op-state
  // are moved into the gitdir with rename, which throws EXDEV across mounts. On Linux/containers
  // /tmp is commonly a separate tmpfs from the repo, so an os.tmpdir() staging would fail git
  // apply on every pull (it only worked on macOS because $TMPDIR + the repo share one APFS volume).
  await fs.mkdir(path.join(repoDir, ".rbox"), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(repoDir, ".rbox", "gitap-"));
  let createdGit = false;
  // Fail-closed for the fresh path: any failure after `git init` removes the .git WE created
  // this call (nothing of the user's lives in it), restoring the strict no-mutation contract.
  const removeFreshGit = async () => {
    if (createdGit) await fs.rm(path.join(repoDir, ".git"), { recursive: true, force: true }).catch(() => {});
  };
  let incomingNs: string | undefined;
  const cleanupIncoming = async () => {
    if (!incomingNs) return;
    const refs = await listRefs(repoDir, incomingNs).catch(() => []);
    for (const ref of refs) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
    incomingNs = undefined;
  };
  const importIncoming = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    await pruneStaleScratchRefs(repoDir, "refs/rbox-incoming");
    incomingNs = `refs/rbox-incoming/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      await importGitPackChain(repoDir, section, store, kek, tmpDir, incomingNs, opts.chainTimings);
      return { ok: true };
    } catch (e) {
      await cleanupIncoming();
      await removeFreshGit();
      return {
        ok: false,
        reason: `git artifact fetch/decrypt/import failed (no publish): ${(e as Error)?.message ?? e}`,
      };
    }
  };
  try {
    // §28: decrypt side artifacts before publish/index mutation. Bundle
    // links are decrypted, git-verified, and imported into scratch refs below; failures
    // clean those refs and return {applied:false} before user-visible git state changes.
    const indexTmp = section.indexSha ? path.join(tmpDir, "index") : undefined;
    const opTmp: Array<{ rel: string; tmp: string }> = [];
    try {
      if (indexTmp) {
        await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
          await getGitArtifact(
            store,
            kek,
            {
              sha: section.indexSha!,
              encSha: section.indexEncSha!,
              cipherSize: section.indexCipherSize!,
              ...(section.indexComp ? { comp: section.indexComp, payloadSha: section.indexPayloadSha } : {}),
            },
            indexTmp,
            tmpDir
          );
        });
      }
      for (const [rel, ref] of Object.entries(section.opState ?? {})) {
        const tmp = path.join(tmpDir, "op", rel);
        await addTimedMs(opts.chainTimings, "indexOpStateMs", async () => {
          await getGitArtifact(store, kek, ref, tmp, tmpDir);
        });
        opTmp.push({ rel, tmp });
      }
    } catch (e) {
      return { applied: false, reason: `git artifact fetch/decrypt failed (no mutation): ${(e as Error)?.message ?? e}`, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    }

    if (ctx) {
      const imported = await importIncoming();
      if (!imported.ok) return { applied: false, reason: imported.reason, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    }

    // Artifacts are decrypt-verified on disk and bundle links are git-verified/imported
    // into scratch refs. The caller's pre-mutation step (quarantine + ref-wipe for a
    // clean materialization) may now run; failure cleans scratch refs and defers cleanly.
    if (opts.beforeMutate) {
      try {
        await opts.beforeMutate();
      } catch (e) {
        return { applied: false, reason: `pre-mutation step failed (no apply): ${(e as Error)?.message ?? e}`, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
    }

    if (!ctx) {
      // TOCTOU recheck (scrutiny M2): the artifact download above can take a long time on a
      // big bundle. If a repo APPEARED at repoDir in that window (user ran git init/clone —
      // this is a live-folder daemon), `git init` would "reinitialize" IT and createdGit
      // would claim a .git this call did NOT create — every later failure path would then
      // rm -rf the USER's .git. Absence must be re-confirmed immediately before init.
      if (await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined)) {
        return { applied: false, reason: "target repo appeared mid-apply — deferred" };
      }
      // fresh machine / standalone materialization of a worktree-origin section (design 43 §5)
      await git(repoDir, ["init", "-q"]);
      createdGit = true;
      ctx = await repoCtx(repoDir);
      if (!ctx) {
        await removeFreshGit();
        return { applied: false, reason: "git init failed for fresh apply target" };
      }
      const imported = await importIncoming();
      if (!imported.ok) return { applied: false, reason: imported.reason, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    }

    const hadHead = await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"]);
    const snap = await snapshotLocal(ctx);

    // Quarantine local committed+staged state first — fail closed if we can't (§9 [v5]:
    // bundle with capture-grade pinning PLUS index/op-state copies).
    let conflictBundle: string | undefined;
    if (hadHead) {
      try {
        conflictBundle = await quarantineLocal(ctx, path.join(repoDir, ".rbox", "git-quarantine"), `${Date.now()}`);
      } catch (e) {
        return { applied: false, reason: `quarantine bundle failed; aborting: ${(e as Error)?.message ?? e}`, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
    }

    try {
      // Publish refs per the scope-gated rules (see doc comment).
      for (const [ref, sha] of Object.entries(publishRefs)) {
        if (ref === "refs/stash") {
          // refs/stash is only usable through its REFLOG (`git stash list`/`pop` read
          // stash@{N}, never the bare ref) — publish it WITH a reflog entry whose
          // message is the stash commit's subject (`git stash` writes the same text to
          // both), so the synced stash is listable/poppable on the receiver.
          const subject = (await git(repoDir, ["log", "-1", "--format=%s", sha]).catch(() => "")) || "rbox: synced stash";
          await git(repoDir, ["update-ref", "--create-reflog", "-m", subject, ref, sha]);
        } else {
          await git(repoDir, ["update-ref", ref, sha]);
        }
      }
      if (deleteAbsent) {
        for (const ref of Object.keys(await readAllRefs(repoDir))) {
          if (!(ref in section.refs) && !heldRefs.has(ref)) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
        }
      }
      await writeFileAtomic(path.join(ctx.gitDir, "HEAD"), section.head.endsWith("\n") ? section.head : `${section.head}\n`);

      // Restore index + op-state from the pre-decrypted temp files via atomic rename —
      // into the RESOLVED gitdir.
      if (indexTmp) {
        const indexPath = path.join(ctx.gitDir, "index");
        await moveFileAtomic(indexTmp, indexPath);
        await clearIndexResolveUndo(repoDir, indexPath);
      }
      await restoreOpState(ctx.gitDir, opTmp);

      if (!(await gitOk(repoDir, ["fsck", "--connectivity-only", "--no-dangling"]))) {
        // ROLLBACK (fresh target: removing the .git we created IS the rollback)
        if (createdGit) await removeFreshGit();
        else await restoreLocal(ctx, snap, ctx.kind === "pointer" ? new Set(Object.keys(publishRefs)) : undefined);
        return { applied: false, reason: "post-apply fsck failed — rolled back", conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
      // Must remain LAST inside the mutation boundary. A pre-commit throw follows
      // the row's existing rollback disposition; successful config rename makes
      // all cleanup below best-effort/non-fatal.
      await opts.afterGitMutate?.();
    } catch (e) {
      // ROLLBACK on any mutation error (fresh target: remove the .git we created)
      if (createdGit) await removeFreshGit();
      else await restoreLocal(ctx, snap, ctx.kind === "pointer" ? new Set(Object.keys(publishRefs)) : undefined).catch(() => {});
      return { applied: false, reason: `apply failed — rolled back: ${(e as Error)?.message ?? e}`, conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    } finally {
      await cleanupIncoming();
    }
    return {
      applied: true,
      conflictBundle,
      heldRefs: heldRefs.size ? Object.fromEntries(heldRefs) : undefined,
      filteredRefs: filteredRefs.length ? filteredRefs : undefined,
    };
  } finally {
    await cleanupIncoming();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
