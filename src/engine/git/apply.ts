import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "../blobstore.js";
import { receiverEquivalentCollisionNames } from "../apply-receipt.js";
import { writeFileAtomic } from "../fsutil.js";
import { validateGitSection } from "../manifest-validate.js";
import type { GitSection } from "../types.js";
import { addTimedMs, type GitChainTimings } from "./chain-timings.js";
import {
  HEX40,
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
  listWorktreesStrict,
  moveFileAtomic,
  repoCtx,
  warnOnce,
  ZERO_OID,
} from "./shared.js";
import { listRefs, readAllRefs, restoreOpState } from "./refs.js";
import { pruneStaleScratchRefs } from "./pins.js";
import { quarantineLocal } from "./quarantine.js";
import { restoreLocal, snapshotLocal } from "./rollback.js";
import { humanDisplacementOrigin, prepareDisplacementPins, runUpdateRefTransaction } from "./keep-pins.js";
import { tipOwnedByIncoming } from "./reachability.js";

const refEquivalenceWarnings = new Set<string>();

function warnRefEquivalence(repoDir: string, refs: Set<string>, sink: (message: string) => void): void {
  if (refs.size === 0) return;
  warnOnce(
    refEquivalenceWarnings,
    repoDir,
    `git-sync WARNING: receiver-equivalent Git refnames held in ${repoDir}: ${[...refs].sort().join(", ")}`,
    sink,
  );
}

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
  /** Exact §130 branch witnesses committed by the clean/legacy engine path. */
  branchTransitions?: Record<string, ApplyBranchTransitionResult>;
  /** Exact expected-old witnesses for committed tag/stash mutations. */
  safeRefTransitions?: Record<string, { kind: "safe-ref"; proof: "expected-old-transaction"; beforeOid: string | null; afterOid: string | null }>;
}

export interface ApplyBranchTransitionInput {
  ctx: RepoCtx;
  ref: string;
  beforeOid: string | null;
  afterOid: string | null;
  /** Prepared keep-pin commands which must commit atomically with A/P/K and R. */
  extraTransactionLines: readonly string[];
  /** Complete reflog bytes observed while preparing displacement pins. */
  expectedReflogFingerprint?: string;
}

export interface ApplyBranchTransitionResult {
  ref: string;
  beforeOid: string | null;
  afterOid: string | null;
  inverseLines: string[];
  /** Absent only for a typed clean-wipe deletion whose logical BASE was already absent. */
  witness?:
    | { kind: "absent"; ref: string; priorOid: string; lineageHash: string; repositoryIdentityHash: string; artifactRef: string; artifactOid: string; source: "a" | "z" }
    | { kind: "present"; ref: string; priorOid: string | null; nextOid: string; lineageHash: string; repositoryIdentityHash: string; artifactRef: string; artifactOid: string; episode: string };
  /** Opaque receipt facts returned only by the committed prepared transaction. */
  lockedProof?: {
    liveOid: string | null;
    witness: NonNullable<ApplyBranchTransitionResult["witness"]>;
    reflogEpisode?: string;
    artifactsClear: boolean;
    ownershipStable: boolean;
    reflogStable: boolean;
    currentRef: boolean;
    siblingOwned: boolean;
  };
}

export interface ApplyBranchTransitionAdapter {
  /** Plans and commits one complete A/P/K + branch expected-old transaction. */
  commit(input: ApplyBranchTransitionInput): Promise<ApplyBranchTransitionResult>;
  /** Commits the exact inverse returned by commit. A failure is a hard rollback failure. */
  rollback(ctx: RepoCtx, result: ApplyBranchTransitionResult): Promise<void>;
}

/** Branches (full refname → linked-worktree display name) checked out by a DIFFERENT,
 *  NON-PRUNABLE worktree of the same store — `git update-ref refs/heads/x` from one
 *  worktree silently moves a branch a sibling has checked out, leaving that sibling dirty
 *  (`git branch -f` refuses; `update-ref` does not — codex repro, design 43 §7 [v4]).
 *  Prunable (stale) entries are ignored so they can't produce phantom collisions
 *  (design 68 V13). From `git worktree list --porcelain`. */
export async function branchesCheckedOutElsewhere(ctx: RepoCtx): Promise<Map<string, string>> {
  return branchesCheckedOutElsewhereFrom(ctx, await listWorktrees(ctx.repoDir));
}

/** Strict authorization-path variant: enumeration failure is a refusal, never
 * evidence that no sibling worktree owns a branch. */
export async function branchesCheckedOutElsewhereStrict(
  ctx: RepoCtx,
): Promise<{ status: "ok"; owned: Map<string, string> } | { status: "unreadable"; cause: unknown }> {
  const worktrees = await listWorktreesStrict(ctx.repoDir);
  if (worktrees.status === "unreadable") return worktrees;
  return { status: "ok", owned: await branchesCheckedOutElsewhereFrom(ctx, worktrees.entries) };
}

async function branchesCheckedOutElsewhereFrom(
  ctx: RepoCtx,
  worktrees: Awaited<ReturnType<typeof listWorktrees>>,
): Promise<Map<string, string>> {
  const selfReal = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
  const owned = new Map<string, string>();
  for (const e of worktrees) {
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
  beforeMutateWipesRefs: boolean,
  legacyWholeSectionOwnership = false,
  localRefs?: Record<string, string>,
  warningSink: (message: string) => void = console.warn,
): Promise<{ heldRefs: Map<string, string>; deferReason?: string }> {
  const owned = await branchesCheckedOutElsewhere(ctx);
  const heldRefs = new Map<string, string>();
  const refs = localRefs ?? await readAllRefs(ctx.repoDir);
  const ambiguous = receiverEquivalentCollisionNames([...Object.keys(section.refs), ...Object.keys(refs), ...owned.keys()]);
  warnRefEquivalence(ctx.repoDir, ambiguous, warningSink);
  for (const ref of ambiguous) heldRefs.set(ref, owned.get(ref) ?? "receiver-equivalent-refname");
  if (owned.size === 0 && ambiguous.size === 0) return { heldRefs };
  const shortName = (ref: string) => ref.replace(/^refs\/heads\//, "");
  const collision = (ref: string, suffix = "") => `worktree-ownership: branch ${shortName(ref)} checked out in linked worktree ${owned.get(ref)}${suffix}`;
  // HEAD move is a checkout-plane collision even when its ref OID is already equal:
  // the primary checkout may not attach to a branch held by a sibling worktree.
  const headBranch = headBranchOf(section.head);
  if (headBranch && ambiguous.has(headBranch)) {
    return { heldRefs, deferReason: `worktree-ownership/unreadable: HEAD ref ${headBranch} has a receiver-equivalent alias` };
  }
  if (headBranch && owned.has(headBranch)) return { heldRefs, deferReason: collision(headBranch) };
  // pre-mutation ref wipe — clean materialization deletes every local syncable ref before
  // publishing even scoped sections; partial holding of a wipe is undefined in D1.
  if (beforeMutateWipesRefs) {
    if (ambiguous.size > 0) {
      return { heldRefs, deferReason: "worktree-ownership/unreadable: receiver-equivalent refnames would be wiped" };
    }
    for (const ref of Object.keys(refs)) {
      if (owned.has(ref)) return { heldRefs, deferReason: collision(ref, " (would be wiped)") };
    }
  }
  // Degraded serialization deliberately retains design 68's whole-section
  // ownership disposition. Equality is not an exemption in that legacy mode:
  // no ref-plane portion is independently published while a section intersects
  // a sibling-owned branch.
  if (legacyWholeSectionOwnership) {
    if (ambiguous.size > 0) return { heldRefs, deferReason: "worktree-ownership/unreadable: receiver-equivalent refnames" };
    for (const ref of Object.keys(section.refs)) {
      if (owned.has(ref)) return { heldRefs, deferReason: collision(ref) };
    }
    if (deletesAbsent) {
      for (const ref of Object.keys(refs)) {
        if (owned.has(ref) && !(ref in section.refs)) {
          return { heldRefs, deferReason: collision(ref, " (would be deleted)") };
        }
      }
    }
    return { heldRefs };
  }
  // Ref updates: equality is a true no-op, so only a different/absent local OID is held.
  for (const [ref, incomingOid] of Object.entries(section.refs)) {
    if (ambiguous.has(ref)) continue;
    const worktree = owned.get(ref);
    if (worktree && refs[ref] !== incomingOid) heldRefs.set(ref, worktree);
  }
  // Ref deletions: an owned local branch absent from an all-scope section survives.
  if (deletesAbsent) {
    for (const ref of Object.keys(refs)) {
      if (ambiguous.has(ref)) continue;
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
    /** Degraded-mode compatibility: any sibling-owned intersection defers the
     * whole section, retaining the pre-design-116 ownership disposition. */
    legacyWholeSectionOwnership?: boolean;
    /** Final mutation in the rollback boundary. Design 93 uses this for config:
     * its rename is the combined git+config commit point. */
    afterGitMutate?: () => Promise<void>;
    chainTimings?: GitChainTimings;
    warningSink?: (message: string) => void;
    /** Required by production callers for every refs/heads create/update/delete. */
    branchTransitions?: ApplyBranchTransitionAdapter;
    /** Clean leftover materialization deletes every local ref, even for scoped input. */
    cleanWipeRefs?: boolean;
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
  const eligiblePublishRefs: Record<string, string> = { ...section.refs };
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
    deleteAbsent = section.refScope === "all" || opts.cleanWipeRefs === true;
    // Design 116: classify every existing store so receiver-equivalent refnames
    // are caught before a destructive wipe; absent sibling worktrees otherwise
    // reduce to the cheap exact-ref scan.
    if (ctx) {
      const ownership = await classifyWorktreeOwnership(
        ctx,
        section,
        deleteAbsent,
        opts.beforeMutateWipesRefs === true,
        opts.legacyWholeSectionOwnership === true,
        undefined,
        opts.warningSink,
      );
      if (ownership.deferReason) return { applied: false, reason: ownership.deferReason };
    }
  } else {
    for (const ref of Object.keys(eligiblePublishRefs)) {
      if (!ref.startsWith("refs/heads/")) {
        // a standalone receiver's stash/tags must never overwrite the SHARED stash stack
        // or tag namespace [v3]
        filteredRefs.push(ref);
        delete eligiblePublishRefs[ref];
      }
    }
    const owned = await branchesCheckedOutElsewhere(ctx);
    if (opts.legacyWholeSectionOwnership && owned.size > 0) {
      const ownership = await classifyWorktreeOwnership(ctx, section, false, false, true);
      if (ownership.deferReason) return { applied: false, reason: ownership.deferReason, filteredRefs };
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
    const committedBranchTransitions: ApplyBranchTransitionResult[] = [];
    const safeRefTransitions: NonNullable<ApplyGitResult["safeRefTransitions"]> = {};
    const rollbackCommittedBranches = async (): Promise<void> => {
      if (committedBranchTransitions.length === 0) return;
      if (!opts.branchTransitions) throw new Error("typed branch rollback adapter missing");
      for (const transition of [...committedBranchTransitions].reverse()) {
        await opts.branchTransitions.rollback(ctx!, transition);
      }
    };

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
      // The ownership decision made before artifact I/O is only an early refusal
      // for destructive hooks.  The publication plan is rebuilt here, after import
      // and quarantine, from CURRENT worktree ownership and exact ref OIDs.  Every
      // subsequent update is compare-and-swap against this snapshot.
      const boundaryRefs = await readAllRefs(repoDir);
      const boundaryOwned = await branchesCheckedOutElsewhere(ctx);
      const incomingHeadRef = headBranchOf(section.head);
      const ambiguousRefs = receiverEquivalentCollisionNames([
        ...Object.keys(eligiblePublishRefs),
        ...Object.keys(boundaryRefs),
        ...boundaryOwned.keys(),
      ]);
      warnRefEquivalence(repoDir, ambiguousRefs, opts.warningSink ?? console.warn);
      if (incomingHeadRef && ambiguousRefs.has(incomingHeadRef)) {
        return {
          applied: false,
          reason: `worktree-ownership/unreadable: HEAD ref ${incomingHeadRef} has a receiver-equivalent alias`,
          conflictBundle,
          filteredRefs: filteredRefs.length ? filteredRefs : undefined,
        };
      }
      if (incomingHeadRef && boundaryOwned.has(incomingHeadRef)) {
        return {
          applied: false,
          reason: `worktree-ownership: branch ${incomingHeadRef.replace(/^refs\/heads\//, "")} checked out in linked worktree ${boundaryOwned.get(incomingHeadRef)}`,
          conflictBundle,
          filteredRefs: filteredRefs.length ? filteredRefs : undefined,
        };
      }

      if (opts.legacyWholeSectionOwnership) {
        const ownership = await classifyWorktreeOwnership(ctx, section, deleteAbsent, false, true, boundaryRefs, opts.warningSink);
        if (ownership.deferReason) {
          return {
            applied: false,
            reason: ownership.deferReason,
            conflictBundle,
            filteredRefs: filteredRefs.length ? filteredRefs : undefined,
          };
        }
      }

      heldRefs.clear();
      for (const ref of ambiguousRefs) heldRefs.set(ref, boundaryOwned.get(ref) ?? "receiver-equivalent-refname");
      const publishRefs: Record<string, string> = {};
      for (const [ref, oid] of Object.entries(eligiblePublishRefs)) {
        if (ambiguousRefs.has(ref)) continue;
        const sibling = boundaryOwned.get(ref);
        if (sibling && boundaryRefs[ref] !== oid) {
          if (ctx.kind === "pointer") {
            if (!filteredRefs.includes(ref)) filteredRefs.push(ref);
          } else {
            heldRefs.set(ref, sibling);
          }
          continue;
        }
        publishRefs[ref] = oid;
      }
      const deletionCandidates = deleteAbsent
        ? Object.keys(boundaryRefs).filter((ref) => !(ref in section.refs))
        : [];
      const ownershipChangedRefs = new Set<string>();
      const hold = (ref: string, label: string): void => {
        if (opts.legacyWholeSectionOwnership) {
          if (label.startsWith("ancestry-")) throw new Error(`ref ancestry ${label.slice("ancestry-".length)} for ${ref}`);
          if (label.startsWith("reflog-")) throw new Error(`reflog reachability ${label.slice("reflog-".length)} for ${ref}`);
          if (ownershipChangedRefs.has(ref)) throw new Error(`worktree ownership changed for ${ref}`);
          throw new Error(`ref compare-and-swap failed for ${ref}`);
        }
        heldRefs.set(ref, label);
      };

      // Publish refs per the scope-gated rules (see doc comment).
      for (const [ref, sha] of Object.entries(publishRefs)) {
        const oldOid = boundaryRefs[ref] ?? ZERO_OID;
        if (ref.startsWith("refs/heads/") && oldOid !== sha && opts.branchTransitions) {
          let extraTransactionLines: string[] = [];
          let expectedReflogFingerprint: string | undefined;
          if (oldOid !== ZERO_OID) {
            const ff = await tipOwnedByIncoming(repoDir, oldOid, [sha]);
            if (ff.status === "indeterminate") {
              hold(ref, `ancestry-${ff.marker}`);
              continue;
            }
            if (ff.status === "unowned") {
              const durable = { ...boundaryRefs, [ref]: sha };
              const pins = await prepareDisplacementPins(
                repoDir,
                ref,
                oldOid,
                Object.values(durable),
                humanDisplacementOrigin(ref, section),
              );
              if (pins.status === "indeterminate") {
                hold(ref, `reflog-${pins.marker}`);
                continue;
              }
              extraTransactionLines = pins.transactionLines;
              expectedReflogFingerprint = pins.reflogFingerprint;
            }
          }
          try {
            const committed = await opts.branchTransitions.commit({
              ctx,
              ref,
              beforeOid: oldOid === ZERO_OID ? null : oldOid,
              afterOid: sha,
              extraTransactionLines,
              ...(expectedReflogFingerprint ? { expectedReflogFingerprint } : {}),
            });
            committedBranchTransitions.push(committed);
            boundaryRefs[ref] = sha;
          } catch (error) {
            hold(ref, boundaryOwned.get(ref) ?? `artifact-${String((error as Error)?.message ?? error)}`);
          }
          continue;
        }
        if (oldOid !== ZERO_OID && oldOid !== sha) {
          // Review R2-8: replacing an existing ref is classified by the
          // complete graph walk used by the follow plane. A non-FF update
          // protects the displaced ref's reflog-only commits, with the
          // fsynced human-origin sidecar written before pin creation and the
          // compare-and-swap replacement commit in one update-ref transaction.
          const ff = await tipOwnedByIncoming(repoDir, oldOid, [sha]);
          if (ff.status === "indeterminate") {
            hold(ref, `ancestry-${ff.marker}`);
            continue;
          }
          if (ff.status === "unowned") {
            const durable = { ...boundaryRefs };
            durable[ref] = sha;
            const origin = humanDisplacementOrigin(ref, section);
            const pins = await prepareDisplacementPins(repoDir, ref, oldOid, Object.values(durable), origin);
            if (pins.status === "indeterminate") {
              hold(ref, `reflog-${pins.marker}`);
              continue;
            }
            // Reflogs may be disabled or missing. The live displaced tip is
            // independently mandatory protection, not merely one likely
            // member of the reflog enumeration.
            try {
              await runUpdateRefTransaction(repoDir, [
                ...pins.transactionLines,
                `update ${ref} ${sha} ${oldOid}`,
              ]);
              boundaryRefs[ref] = sha;
              if (!ref.startsWith("refs/heads/")) safeRefTransitions[ref] = {
                kind: "safe-ref", proof: "expected-old-transaction", beforeOid: oldOid, afterOid: sha,
              };
            } catch {
              hold(ref, boundaryOwned.get(ref) ?? "concurrent-update");
            }
            continue;
          }
        }
        if (ref === "refs/stash") {
          // refs/stash is only usable through its REFLOG (`git stash list`/`pop` read
          // stash@{N}, never the bare ref) — publish it WITH a reflog entry whose
          // message is the stash commit's subject (`git stash` writes the same text to
          // both), so the synced stash is listable/poppable on the receiver.
          const subject = (await git(repoDir, ["log", "-1", "--format=%s", sha]).catch(() => "")) || "rbox: synced stash";
          try {
            await git(repoDir, ["update-ref", "--create-reflog", "-m", subject, ref, sha, oldOid]);
            boundaryRefs[ref] = sha;
            if (!ref.startsWith("refs/heads/") && oldOid !== sha) safeRefTransitions[ref] = {
              kind: "safe-ref", proof: "expected-old-transaction",
              beforeOid: oldOid === ZERO_OID ? null : oldOid, afterOid: sha,
            };
          } catch {
            hold(ref, boundaryOwned.get(ref) ?? "concurrent-update");
          }
        } else {
          try {
            await git(repoDir, ["update-ref", ref, sha, oldOid]);
            boundaryRefs[ref] = sha;
            if (!ref.startsWith("refs/heads/") && oldOid !== sha) safeRefTransitions[ref] = {
              kind: "safe-ref", proof: "expected-old-transaction",
              beforeOid: oldOid === ZERO_OID ? null : oldOid, afterOid: sha,
            };
          } catch {
            hold(ref, boundaryOwned.get(ref) ?? "concurrent-update");
          }
        }
      }
      if (deleteAbsent) {
        for (const ref of deletionCandidates) {
          if (heldRefs.has(ref)) continue;
          // Ownership is re-read for each destructive mutation, not merely at
          // the section boundary. A branch attached by a sibling while earlier
          // refs publish survives this cycle.
          const ownedNow = await branchesCheckedOutElsewhere(ctx);
          const liveRefs = await readAllRefs(repoDir);
          const ambiguousNow = receiverEquivalentCollisionNames([
            ...Object.keys(section.refs),
            ...Object.keys(liveRefs),
            ...ownedNow.keys(),
          ]);
          if (ambiguousNow.has(ref)) {
            warnRefEquivalence(repoDir, ambiguousNow, opts.warningSink ?? console.warn);
            heldRefs.set(ref, ownedNow.get(ref) ?? "receiver-equivalent-refname");
            continue;
          }
          if (ownedNow.has(ref)) {
            ownershipChangedRefs.add(ref);
            hold(ref, ownedNow.get(ref)!);
            continue;
          }
          const oldOid = liveRefs[ref];
          if (!oldOid || ref in section.refs) continue;
          const durable = { ...liveRefs };
          delete durable[ref];
          const detachedIncoming = section.head.trim();
          const plannedGraphRoots = [
            ...Object.values(durable),
            ...(HEX40.test(detachedIncoming) ? [detachedIncoming] : []),
          ];
          const pins = await prepareDisplacementPins(
            repoDir,
            ref,
            oldOid,
            plannedGraphRoots,
            humanDisplacementOrigin(ref, section),
          );
          if (pins.status === "indeterminate") {
            hold(ref, `reflog-${pins.marker}`);
            continue;
          }
          try {
            if (ref.startsWith("refs/heads/") && opts.branchTransitions) {
              const committed = await opts.branchTransitions.commit({
                ctx,
                ref,
                beforeOid: oldOid,
                afterOid: null,
                extraTransactionLines: pins.transactionLines,
                expectedReflogFingerprint: pins.reflogFingerprint,
              });
              committedBranchTransitions.push(committed);
            } else {
              await runUpdateRefTransaction(repoDir, [...pins.transactionLines, `delete ${ref} ${oldOid}`]);
              if (!ref.startsWith("refs/heads/")) safeRefTransitions[ref] = {
                kind: "safe-ref", proof: "expected-old-transaction", beforeOid: oldOid, afterOid: null,
              };
            }
            delete boundaryRefs[ref];
          } catch {
            hold(ref, "concurrent-update");
          }
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
        else {
          await rollbackCommittedBranches();
          await restoreLocal(
            ctx,
            snap,
            ctx.kind === "pointer" ? new Set(Object.keys(eligiblePublishRefs)) : undefined,
            new Set(committedBranchTransitions.map((transition) => transition.ref)),
          );
        }
        return { applied: false, reason: "post-apply fsck failed — rolled back", conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
      // Must remain LAST inside the mutation boundary. A pre-commit throw follows
      // the row's existing rollback disposition; successful config rename makes
      // all cleanup below best-effort/non-fatal.
      await opts.afterGitMutate?.();
    } catch (e) {
      // ROLLBACK on any mutation error (fresh target: remove the .git we created)
      if (createdGit) await removeFreshGit();
      else {
        try {
          await rollbackCommittedBranches();
          await restoreLocal(
            ctx,
            snap,
            ctx.kind === "pointer" ? new Set(Object.keys(eligiblePublishRefs)) : undefined,
            new Set(committedBranchTransitions.map((transition) => transition.ref)),
          );
        } catch (rollbackError) {
          return {
            applied: false,
            reason: `apply failed and typed branch rollback hard-held: ${(rollbackError as Error)?.message ?? rollbackError}`,
            conflictBundle,
            filteredRefs: filteredRefs.length ? filteredRefs : undefined,
          };
        }
      }
      return { applied: false, reason: `apply failed — rolled back: ${(e as Error)?.message ?? e}`, conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    } finally {
      await cleanupIncoming();
    }
    return {
      applied: true,
      conflictBundle,
      heldRefs: heldRefs.size ? Object.fromEntries(heldRefs) : undefined,
      filteredRefs: filteredRefs.length ? filteredRefs : undefined,
      branchTransitions: committedBranchTransitions.length
        ? Object.fromEntries(committedBranchTransitions.map((transition) => [transition.ref, transition]))
        : undefined,
      safeRefTransitions: Object.keys(safeRefTransitions).length ? safeRefTransitions : undefined,
    };
  } finally {
    await cleanupIncoming();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
