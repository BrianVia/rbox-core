/** The follow pipeline's two irreducible engines.
 *
 * `publishRefPlane` (480 nonblank) and `followDivergedRepo` (598 nonblank) each
 * exceed the module-size gate on their own, so they cannot be moved into a
 * passing module — see docs/design/notes/sync-git-decompose.md. Everything that
 * COULD move has: the vocabulary, journal lifecycle, staging, live read,
 * classifier, and ref-plane witnesses are now separate domain modules, and this
 * file re-exports the full public surface unchanged. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  checkoutTransactionSupported,
  clearCheckoutJournal,
  commitCheckout,
  enumerateStashReflogOids,
  incomingOwnershipRoots,
  indexIdentityV2,
  markCheckoutJournalPublished,
  noDropProof,
  ownershipProofContext,
  ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY,
  tipOwnedByIncoming,
  validateGitSection,
  updateCheckoutJournal,
  writeCheckoutJournal,
  receiverEquivalentCollisionNames,
  type CheckoutJournal,
  type CheckoutRefUpdate,
  type OwnershipProofContext,
  basePresentKeepRef,
} from "../../engine/index.js";
import { branchesCheckedOutElsewhere, branchesCheckedOutElsewhereStrict } from "../../engine/git/apply.js";
import {
  humanDisplacementOrigin,
  prepareDisplacementPins,
  prepareTombstonePrunePins,
  readRefReflogFingerprint,
  runUpdateRefTransaction,
} from "../../engine/git/keep-pins.js";
import { readAllRefs, readAllRefsStrict } from "../../engine/git/refs.js";
import {
  addTimedMs,
  git,
  headBranchOf,
  readHead,
  repoCtx,
  exists,
  warnOnce,
} from "../../engine/git/shared.js";
import type { GitDeferralReason, GitPartialApply, TypedBlocker } from "../config.js";
import {
  origHeadPreservationFailureLine,
  preserveOrigHead,
  pruneOrigHeadRecoveryRefs,
  type OrigHeadPreservation,
} from "./orig-head.js";
import { gitIncomingKey, observePackedRefsIdentity, packedRefsMtimeRegressed, sectionOpState } from "./shared.js";
import { checkTombstoneAttestation } from "./tombstone-attestation.js";
import { commitPlannedBranchTransition, planBranchTransition, planManualBranchTransition, type PlannedBranchTransition } from "./branch-transition.js";
import { branchBaseOriginMatches, type BranchTransitionWitness, type LockedBranchProof, type SafeRefWitness } from "./base-composer.js";
import { gitFingerprint, gitFingerprintRun, type GitFingerprint } from "./fingerprint.js";
import { loadContentEquivalenceCache } from "./content-equivalence-cache.js";
import { checkoutJournalBinding } from "./follow-journal.js";
import { candidateIndexCollision, deriveBaseIndexProjection, expectedHead, indexArtifact, stageIncoming } from "./follow-staging.js";
import { readLive } from "./follow-live.js";
import { classifyCheckout, firstReason, opStateDetailToken } from "./follow-classify.js";
import { appliedTerminalOid, effectiveRefs, ensureStashReflog, selectCheckoutSelfRootWitness } from "./follow-ref-witness.js";
import {
  blockerForReason,
  boundedRefFailure,
  deferResult,
  progressWithBlocker,
  WorktreeOwnershipUnreadableError,
  type CheckoutClassification,
  type FollowIntended,
  type FollowOptions,
  type FollowProgress,
  type FollowResult,
  type LiveMetadata,
  type StagedIncoming,
} from "./follow-types.js";

export {
  FollowCrashInjectedError,
  opStateRootOf,
  type FollowCrashPoint,
  type FollowIntended,
  type FollowProgress,
  type FollowResult,
} from "./follow-types.js";
export {
  checkoutJournalBinding,
  clearFollowJournal,
  quarantineUnboundFollowJournal,
  recoverAndLandFollowJournal,
  recoverFollowJournal,
} from "./follow-journal.js";
export { deriveBaseIndexProjection, indexArtifact, stageIncoming } from "./follow-staging.js";
export {
  classifyCheckoutOwnership,
  firstReason,
  type CheckoutOwnershipClassification,
} from "./follow-classify.js";
export { selectCheckoutSelfRootWitness, type CheckoutSelfRootWitness } from "./follow-ref-witness.js";

const refEquivalenceWarnings = new Set<string>();

/** The one classifier for a thrown ref-publication failure. Classify on the raw
 * message: boundedRefFailure truncates, and a `lock`/`busy`/`transaction` token
 * past the bound must still count. A message no rule recognizes stays `other`:
 * an unexplained failure must never inherit an allowlisted reason. */
function refPublicationFailureReason(message: string): GitDeferralReason {
  if (message.includes("ref-read-unreadable")) return "ref-read-unreadable";
  return /lock|busy|transaction/i.test(message) ? "git-busy" : "other";
}

async function publishRefPlane(
  opts: FollowOptions,
  live: LiveMetadata,
  roots: readonly string[],
  ownershipContext: OwnershipProofContext,
  classifyOnly = false,
): Promise<FollowProgress & {
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
  checkoutWitnessDisposition: {
    heldRefs: ReadonlySet<string>;
    forcedRefs: ReadonlySet<string>;
    ambiguousRefs: ReadonlySet<string>;
  };
  authoredRefChanges: Array<{ ref: string; before?: string; after?: string }>;
}> {
  const effective = effectiveRefs(opts.ctx, opts.incoming);
  const owned = classifyOnly
    ? await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx))
    : await (async () => {
        let ownedRead: Awaited<ReturnType<typeof branchesCheckedOutElsewhereStrict>>;
        try {
          await opts.beforeWorktreeOwnershipRead?.();
          ownedRead = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhereStrict(opts.ctx));
        } catch (error) {
          throw new WorktreeOwnershipUnreadableError(error);
        }
        if (ownedRead.status === "unreadable") throw new WorktreeOwnershipUnreadableError(ownedRead.cause);
        return ownedRead.owned;
      })();
  const appliedRefs: GitPartialApply["appliedRefs"] = {};
  const heldRefs: GitPartialApply["heldRefs"] = {};
  const blockers: TypedBlocker[] = [];
  const consultedReflogPaths = new Set<string>();
  const branchWitnesses: Record<string, BranchTransitionWitness> = {};
  const branchLockedProofs: Record<string, LockedBranchProof> = {};
  const safeRefWitnesses: Record<string, SafeRefWitness> = {};
  const manualBranchTerminals: NonNullable<FollowProgress["manualBranchTerminals"]> = {};
  // A committed prune may have crashed before the state CAS. A/Z overlaid on
  // stale serialized presence reconstructs the §126 veto exactly until this
  // cycle materializes the absence in BASE.
  let tombstonePrunedThisCycle = (opts.branchProtocol?.unmaterializedAbsenceRefs.size ?? 0) > 0;
  const plannedRoots = [...new Set(Object.values(effective.refs))];
  let checkoutRefReason: GitDeferralReason | undefined;
  let checkoutRefDetail: string | undefined;
  let checkoutRefReasonFromIndeterminate = false;
  const authoredRefChanges: Array<{ ref: string; before?: string; after?: string }> = [];
  const manualProtected = new Set(opts.manualResolution?.protectedOids ?? []);
  const incomingHeadRef = headBranchOf(opts.incoming.head);
  const ambiguousRefs = receiverEquivalentCollisionNames([
    ...Object.keys(effective.refs),
    ...Object.keys(live.refs),
    ...owned.keys(),
  ]);
  if (ambiguousRefs.size > 0) warnOnce(
    refEquivalenceWarnings,
    opts.workspaceRoot,
    `git-sync WARNING: receiver-equivalent Git refnames held in ${opts.relPath}: ${[...ambiguousRefs].sort().join(", ")}`,
    opts.log ?? (() => {}),
  );
  if ((live.currentRef && ambiguousRefs.has(live.currentRef)) || (incomingHeadRef && ambiguousRefs.has(incomingHeadRef))) {
    checkoutRefReason = "unreadable";
    checkoutRefDetail = "checkout ref belongs to an ambiguous receiver-equivalence group";
  }
  if (incomingHeadRef && owned.has(incomingHeadRef)) {
    checkoutRefReason = "worktree-ownership";
    checkoutRefDetail = `branch ${incomingHeadRef.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(incomingHeadRef)}`;
  }
  const candidates = new Set(Object.keys(effective.refs));
  if (effective.deleteAbsent) {
    for (const ref of Object.keys(live.refs)) candidates.add(ref);
    for (const ref of Object.keys(opts.base?.refs ?? {})) candidates.add(ref);
  }

  // Design 200 apply-side witness. Unlike push W/L/D this is intentionally not
  // kill-switched: it prevents a follower from recreating a published branch
  // during the publisher's capture-to-ACK window and licenses converged case (c).
  const deletionWitnessRefs = new Set<string>();
  const deletionWitnessHeldRefs = new Set<string>();
  if (opts.ctx.kind === "dir" && opts.incoming.refScope === "all" && opts.branchProtocol) {
    const priorPacked = opts.record?.packedRefsIdentity;
    const currentPacked = await observePackedRefsIdentity(opts.ctx.commonDir);
    const packedRegressed = currentPacked.status === "unreadable"
      || packedRefsMtimeRegressed(priorPacked, currentPacked);
    const headLog = await fs.readFile(path.join(opts.ctx.commonDir, "logs", "HEAD")).catch(() => undefined);
    if (!packedRegressed && headLog && headLog.byteLength > 0) {
      for (const [ref, baseOid] of Object.entries(opts.base?.refs ?? {})) {
        if (!ref.startsWith("refs/heads/") || live.refs[ref] !== undefined
          || ref === live.currentRef || owned.has(ref) || ambiguousRefs.has(ref)) continue;
        const origin = opts.record?.branchBaseOrigins?.[ref];
        const disposition = opts.branchProtocol.artifacts[ref];
        const artifactsClear = disposition === undefined || (disposition.absence === "absent"
          && disposition.present === "absent" && disposition.keeps === "clear"
          && disposition.settledAbsence === "absent");
        if (artifactsClear && branchBaseOriginMatches(origin, baseOid)
          && origin.lineageHash === opts.branchProtocol.lineageHash) deletionWitnessRefs.add(ref);
      }
    }
  }

  const classifiedHolds = new Map<string, "local-commits" | "local-stash" | "worktree-ownership">();
  const indeterminateRefs = new Set<string>();
  const forcedRefs = new Set(Object.keys(opts.forcedHeldRefs ?? {}));
  for (const ref of candidates) if (ambiguousRefs.has(ref)) classifiedHolds.set(ref, "worktree-ownership");
  for (const [ref, reason] of Object.entries(opts.forcedHeldRefs ?? {})) {
    const classified = reason === "ownership" ? "worktree-ownership" : reason;
    classifiedHolds.set(ref, classified);
    if (ref === live.currentRef) checkoutRefReason ??= classified;
  }
  for (const ref of deletionWitnessRefs) {
    if (effective.refs[ref] !== undefined) {
      classifiedHolds.set(ref, "local-commits");
      deletionWitnessHeldRefs.add(ref);
    }
  }
  const protectedByRef = new Map<string, string[]>();
  for (const ref of candidates) {
    if (ref === live.currentRef) continue;
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    if (oldOid === newOid) continue;
    let hold = classifiedHolds.get(ref);
    if (!hold && owned.has(ref)) {
      hold = "worktree-ownership";
      if (opts.manualResolution) checkoutRefReason ??= "worktree-ownership";
      checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${owned.get(ref)}`;
    }
    // A branch whose receiver value the logical BASE does not authorize is a
    // receiver-only hold — the same rule the equality arm applies below
    // ("equality cannot invent branch P/A authority"). planBranchTransition
    // refuses exactly this pre-state, so the hold is classified here instead of
    // arriving later as a thrown, untyped `other` from the publication path.
    if (!hold && !opts.manualResolution && ref.startsWith("refs/heads/") && opts.branchProtocol
      && (opts.branchProtocol.logicalBaseRefs[ref] ?? null) !== (oldOid ?? null)) {
      hold = "local-commits";
    }
    if (oldOid) {
      const protectedOids = ref === "refs/stash" && opts.ctx.kind === "dir"
        ? [...new Set([oldOid, ...await addTimedMs(opts.chainTimings, "reflogMs", () => enumerateStashReflogOids(opts.ctx.repoDir))])]
        : [oldOid];
      protectedByRef.set(ref, protectedOids);
      if (!hold) for (const oid of protectedOids) {
        const proof = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
          tipOwnedByIncoming(opts.ctx.repoDir, oid, roots, ownershipContext));
        if (proof.status === "unowned") {
          if (opts.manualResolution && manualProtected.has(oid)) continue;
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          break;
        }
        if (proof.status === "indeterminate") {
          indeterminateRefs.add(ref);
          blockers.push({
            provenance: "indeterminate",
            reason: proof.marker === "shallow-store" ? "unsupported" : "unreadable",
            detail: `${ref} preservation proof ${proof.marker}`,
          });
          hold = ref === "refs/stash" ? "local-stash" : "local-commits";
          if (!checkoutRefReason) {
            checkoutRefReason = proof.marker === "shallow-store" ? "unsupported" : "unreadable";
            checkoutRefReasonFromIndeterminate = true;
          }
          break;
        }
      }
    }
    if (hold) classifiedHolds.set(ref, hold);
  }

  // Tombstones may waive only a determinate local-commits conclusion. Every
  // ambiguity/forced/sibling/current/indeterminate/artifact gate has already
  // run and remains binding.
  const tombstoneAuthorized = new Set<string>();
  for (const [ref, hold] of [...classifiedHolds]) {
    const oldOid = live.refs[ref];
    if (hold !== "local-commits" || !oldOid || !ref.startsWith("refs/heads/")
      || ref === live.currentRef || owned.has(ref) || ambiguousRefs.has(ref)
      || forcedRefs.has(ref) || indeterminateRefs.has(ref) || !opts.branchProtocol) continue;
    const check = checkTombstoneAttestation(opts.branchProtocol.attestations, {
      incomingKey: gitIncomingKey(opts.incoming), ref, oid: oldOid, liveOid: oldOid,
      logicalBaseOid: opts.branchProtocol.logicalBaseRefs[ref] ?? null,
    });
    if (check.status === "authorized") {
      classifiedHolds.delete(ref);
      tombstoneAuthorized.add(ref);
    }
  }

  // Recompute until stable: a ref may be called safe only from roots that will
  // actually remain durable after every already-classified hold. The current
  // checkout ref is deliberately a held root here because checkout may defer.
  let plannedRefs: Record<string, string> = {};
  let heldDurable: Record<string, string> = {};
  const contentEquivalenceCache = process.env.RBOX_GIT_CONTENT_EQUIV === "0"
    ? undefined
    : await loadContentEquivalenceCache(opts.workspaceRoot).catch(() => undefined);
  for (;;) {
    plannedRefs = {};
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const oid = effective.refs[ref];
      if (oid) plannedRefs[ref] = oid;
    }
    if (live.currentRef && effective.refs[live.currentRef]) plannedRefs[live.currentRef] = effective.refs[live.currentRef]!;
    heldDurable = {};
    for (const [ref, oid] of Object.entries(live.refs)) {
      if (ref === live.currentRef || classifiedHolds.has(ref) || !candidates.has(ref)) heldDurable[ref] = oid;
    }
    let changed = false;
    for (const ref of candidates) {
      if (ref === live.currentRef || classifiedHolds.has(ref)) continue;
      const protectedOids = protectedByRef.get(ref);
      if (!protectedOids?.length) continue;
      if (tombstoneAuthorized.has(ref)) continue;
      if (opts.manualResolution && protectedOids.every((oid) => manualProtected.has(oid))) continue;
      const proof = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        noDropProof(opts.ctx.repoDir, plannedRefs, heldDurable, {}, protectedOids, {
          contentEquivalenceCache,
          ownershipContext,
        }));
      if (proof.status === "proven") {
        if (proof.marker !== "content-equivalent") continue;
        const oldOid = live.refs[ref];
        const newOid = effective.refs[ref];
        const nonDestructive = oldOid !== undefined && newOid !== undefined
          && (await addTimedMs(opts.chainTimings, "ownershipMs", () =>
            tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid], ownershipContext))).status === "owned";
        if (nonDestructive) {
          opts.onContentEquivalentWaiver?.(ref);
          continue;
        }
        opts.onContentEquivalentDestructiveHold?.(ref);
      }
      classifiedHolds.set(ref, ref === "refs/stash" ? "local-stash" : "local-commits");
      if (proof.status === "indeterminate") {
        indeterminateRefs.add(ref);
        if (!checkoutRefReason) {
          checkoutRefReason = proof.marker === "shallow-store" ? "unsupported" : "unreadable";
          checkoutRefReasonFromIndeterminate = true;
        }
        blockers.push({
          provenance: "indeterminate",
          reason: proof.marker === "shallow-store" ? "unsupported" : "unreadable",
          detail: `${ref} no-drop proof ${proof.marker}`,
        });
      }
      changed = true;
    }
    if (!changed) break;
  }
  await contentEquivalenceCache?.save().catch(() => {});

  for (const ref of [...candidates].sort()) {
    if (ref === live.currentRef) continue; // current branch belongs to checkout txn.
    const oldOid = live.refs[ref];
    const newOid = effective.refs[ref];
    let hold = classifiedHolds.get(ref);
    if (!hold && ref.startsWith("refs/heads/") && oldOid !== newOid && !opts.branchProtocol) hold = "local-commits";
    if (hold) {
      heldRefs[ref] = hold === "worktree-ownership" ? "ownership" : hold;
      if (opts.manualResolution) checkoutRefReason ??= hold;
      if (ref === incomingHeadRef && !indeterminateRefs.has(ref)) checkoutRefReason = ambiguousRefs.has(ref)
        ? "unreadable"
        : hold;
      continue;
    }
    if (oldOid === newOid) {
      const baseOid = opts.base?.refs[ref] ?? null;
      if (ref.startsWith("refs/heads/")) {
        const logicalBaseOid = opts.branchProtocol?.logicalBaseRefs[ref] ?? null;
        const disposition = opts.branchProtocol?.artifacts[ref];
        const reconstructedAbsence = opts.branchProtocol?.absenceWitnesses[ref];
        const artifactsClear = disposition === undefined || (disposition.absence === "absent"
          && disposition.present === "absent" && disposition.keeps === "clear" && disposition.settledAbsence === "absent");
        if (!newOid && oldOid === undefined && baseOid !== null
          && reconstructedAbsence?.priorOid === baseOid
          && disposition?.absence === "valid-owning") {
          appliedRefs[ref] = { kind: "absent", artifactOid: reconstructedAbsence.artifactOid };
          branchWitnesses[ref] = reconstructedAbsence;
          branchLockedProofs[ref] = {
            liveOid: null,
            witness: reconstructedAbsence,
            artifactsClear: true,
            ownershipStable: true,
            reflogStable: true,
            currentRef: false,
            siblingOwned: false,
          };
        } else if (logicalBaseOid === (newOid ?? null) && newOid) {
          appliedRefs[ref] = { kind: "direct", oid: newOid };
        } else if (opts.manualResolution && newOid && logicalBaseOid !== null && artifactsClear) {
          manualBranchTerminals[ref] = { beforeBaseOid: logicalBaseOid, afterOid: newOid };
          appliedRefs[ref] = { kind: "direct", oid: newOid };
        } else if ((opts.manualResolution || deletionWitnessRefs.has(ref))
          && !newOid && logicalBaseOid !== null && opts.branchProtocol) {
          try {
            await opts.beforeManualAbsentTransition?.(ref);
            const plan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => planManualBranchTransition({
              repoDir: opts.ctx.repoDir, binding: opts.branchProtocol!.binding, ref,
              physicalBeforeOid: null, afterOid: null, logicalBaseOid,
            }));
            const committed = await commitPlannedBranchTransition(plan, async () => {
              const strict = await readAllRefsStrict(opts.ctx.repoDir);
              if (strict.status === "unreadable") throw new Error(`ref-read-unreadable: ${strict.marker}`);
              const lockedRefs = strict.refs;
              const lockedOwnedRead = await branchesCheckedOutElsewhereStrict(opts.ctx);
              if (lockedOwnedRead.status === "unreadable") throw lockedOwnedRead.cause;
              const lockedOwned = lockedOwnedRead.owned;
              if (lockedRefs[ref] !== undefined || lockedOwned.has(ref)) throw new Error("manual absent branch changed at locked proof");
            }, opts.chainTimings);
            branchWitnesses[ref] = committed.witness;
            branchLockedProofs[ref] = committed.lockedProof;
            appliedRefs[ref] = plan.partial;
          } catch (error) {
            heldRefs[ref] = "local-commits";
            // Reason and detail are one cause: a failure that does not win the
            // reason must not overwrite the winning cause's evidence, and one
            // that does win must carry its own.
            if (!checkoutRefReason) {
              checkoutRefReason = refPublicationFailureReason(String((error as Error)?.message ?? error));
              checkoutRefDetail = `manual absent branch proof failed for ${ref}: ${boundedRefFailure(error)}`;
            }
          }
        } else if (baseOid !== (newOid ?? null)) {
          heldRefs[ref] = "local-commits"; // equality cannot invent branch P/A authority.
        }
      } else if (baseOid !== (newOid ?? null)) {
        const persisted = opts.record?.partial?.incomingKey === gitIncomingKey(opts.incoming)
          ? opts.record.partial.appliedRefs[ref]
          : undefined;
        const witness: SafeRefWitness = persisted?.kind === "safe-ref" && persisted.afterOid === (newOid ?? null)
          ? persisted
          : { kind: "safe-ref", proof: "locked-terminal-observation", afterOid: newOid ?? null };
        appliedRefs[ref] = witness;
        safeRefWitnesses[ref] = witness;
      } else if (newOid) {
        appliedRefs[ref] = { kind: "direct", oid: newOid };
      }
      if (!opts.manualResolution && ref === "refs/stash" && newOid) {
        if (!classifyOnly) await addTimedMs(opts.chainTimings, "reflogMs", () => ensureStashReflog(opts.ctx.repoDir, newOid));
      }
      continue;
    }
    if (classifyOnly) continue;
    try {
      const ownedNow = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx));
      const liveNow = await addTimedMs(opts.chainTimings, "ownershipMs", () => readAllRefs(opts.ctx.repoDir));
      const ambiguousNow = receiverEquivalentCollisionNames([
        ...Object.keys(effective.refs),
        ...Object.keys(liveNow),
        ...ownedNow.keys(),
      ]);
      if (ambiguousNow.has(ref)) {
        heldRefs[ref] = "ownership";
        checkoutRefDetail ??= "ref belongs to an ambiguous receiver-equivalence group";
        if (opts.manualResolution || ref === incomingHeadRef) checkoutRefReason = "unreadable";
        continue;
      }
      if (ownedNow.has(ref)) {
        heldRefs[ref] = "ownership";
        const sibling = ownedNow.get(ref);
        checkoutRefDetail ??= `branch ${ref.replace(/^refs\/heads\//, "")} is checked out in linked worktree ${sibling}`;
        if (opts.manualResolution || ref === incomingHeadRef) checkoutRefReason = "worktree-ownership";
        continue;
      }
      if (!oldOid && !newOid) continue;

      const lines: string[] = [];
      let tombstoneFingerprint: string | undefined;
      let branchEpisode: string | undefined;
      if (oldOid && (!newOid || (await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid], ownershipContext))).status !== "owned")) {
        consultedReflogPaths.add(`logs/${ref}`);
        const durableNow = { ...liveNow };
        delete durableNow[ref];
        branchEpisode = crypto.randomBytes(16).toString("hex");
        const pins = tombstoneAuthorized.has(ref)
          ? await addTimedMs(opts.chainTimings, "reflogMs", () =>
              prepareTombstonePrunePins(opts.ctx.repoDir, ref, oldOid, branchEpisode!, new Date().toISOString()))
          : await addTimedMs(opts.chainTimings, "reflogMs", () => prepareDisplacementPins(
              opts.ctx.repoDir,
              ref,
              oldOid,
              [...Object.values(durableNow), ...(newOid ? [newOid] : [])],
              humanDisplacementOrigin(ref, opts.incoming),
            ));
        if (!("transactionLines" in pins)) {
          heldRefs[ref] = ref === "refs/stash" ? "local-stash" : "local-commits";
          if (ref === incomingHeadRef) checkoutRefReason = ref === "refs/stash" ? "local-stash" : "local-commits";
          continue;
        }
        lines.push(...pins.transactionLines);
        if ("reflogFingerprint" in pins) tombstoneFingerprint = pins.reflogFingerprint;
        await opts.afterBranchPinsPrepared?.(ref);
      }
      if (ref.startsWith("refs/heads/")) {
        if (!opts.manualResolution) opts.beforePlanBranchTransition?.(ref, newOid ?? null);
        // Artifact/HEAD preparation is exclusive ref-transaction setup: no
        // ownership/reflog leaf runs inside these planners.
        const plan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => opts.manualResolution
          ? planManualBranchTransition({
              repoDir: opts.ctx.repoDir, binding: opts.branchProtocol!.binding, ref,
              physicalBeforeOid: oldOid ?? null, afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
              extraTransactionLines: lines,
              ...(branchEpisode ? { episode: branchEpisode } : {}),
              ...(tombstoneFingerprint ? { expectedReflogFingerprint: tombstoneFingerprint } : {}),
            })
          : planBranchTransition({
              repoDir: opts.ctx.repoDir,
              binding: opts.branchProtocol!.binding,
              ref,
              beforeOid: oldOid ?? null,
              afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
              extraTransactionLines: lines,
              ...(branchEpisode ? { episode: branchEpisode } : {}),
              ...(tombstoneFingerprint ? { expectedReflogFingerprint: tombstoneFingerprint } : {}),
            }));
        const committed = await commitPlannedBranchTransition(plan, async () => {
          const strict = await readAllRefsStrict(opts.ctx.repoDir);
          if (strict.status === "unreadable") throw new Error(`ref-read-unreadable: ${strict.marker}`);
          const lockedRefs = strict.refs;
          const lockedOwnedRead = await branchesCheckedOutElsewhereStrict(opts.ctx);
          if (lockedOwnedRead.status === "unreadable") throw lockedOwnedRead.cause;
          const lockedOwned = lockedOwnedRead.owned;
          if ((lockedRefs[ref] ?? null) !== (oldOid ?? null) || lockedOwned.has(ref)) throw new Error("branch changed at locked second proof");
          if (tombstoneAuthorized.has(ref) && oldOid) {
            const checked = checkTombstoneAttestation(opts.branchProtocol!.attestations, {
              incomingKey: gitIncomingKey(opts.incoming), ref, oid: oldOid,
              liveOid: oldOid, logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
            });
            if (checked.status !== "authorized") throw new Error(checked.reason);
          }
        }, opts.chainTimings);
        branchWitnesses[ref] = committed.witness;
        branchLockedProofs[ref] = committed.lockedProof;
        appliedRefs[ref] = plan.partial;
        if (tombstoneAuthorized.has(ref) && !newOid) {
          tombstonePrunedThisCycle = true;
          opts.log?.(`git-sync: pruned tombstoned branch ${ref} (was ${oldOid!.slice(0, 12)})`);
        }
      } else {
        if (oldOid && newOid) lines.push(`update ${ref} ${newOid} ${oldOid}`);
        else if (newOid) lines.push(`create ${ref} ${newOid}`);
        else lines.push(`delete ${ref} ${oldOid}`);
        await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => runUpdateRefTransaction(opts.ctx.repoDir, lines));
        const witness: SafeRefWitness = { kind: "safe-ref", proof: "expected-old-transaction", beforeOid: oldOid ?? null, afterOid: newOid ?? null };
        safeRefWitnesses[ref] = witness;
        appliedRefs[ref] = witness;
      }
      if (opts.manualResolution) authoredRefChanges.push({ ref, ...(oldOid ? { before: oldOid } : {}), ...(newOid ? { after: newOid } : {}) });
      if (!opts.manualResolution && ref === "refs/stash" && newOid) {
        await addTimedMs(opts.chainTimings, "reflogMs", () => ensureStashReflog(opts.ctx.repoDir, newOid));
      }
    } catch (error) {
      if (!checkoutRefReason) {
        checkoutRefReason = refPublicationFailureReason(String((error as Error)?.message ?? error));
        checkoutRefDetail = `publishing ref ${ref} failed: ${boundedRefFailure(error)}`;
      }
    }
  }

  const configApplied = classifyOnly ? true : await opts.runConfig?.().catch(() => false) ?? true;
  for (const [ref, held] of Object.entries(heldRefs)) {
    if (indeterminateRefs.has(ref)) continue;
    blockers.push({
      provenance: "ref-plane",
      reason: deletionWitnessHeldRefs.has(ref)
        ? "deletion-pending"
        : held === "ownership" ? "worktree-ownership" : held,
      ref,
    });
  }
  if (checkoutRefReason && !checkoutRefReasonFromIndeterminate) blockers.push(blockerForReason(checkoutRefReason, "checkout", checkoutRefDetail));
  const checkoutWitnessDisposition = {
    heldRefs: new Set(Object.keys(heldRefs)),
    forcedRefs,
    ambiguousRefs,
  };
  return {
    appliedRefs,
    heldRefs,
    blockers,
    consultedReflogPaths: [...consultedReflogPaths].sort(),
    ...(Object.keys(branchWitnesses).length ? { branchWitnesses } : {}),
    ...(Object.keys(branchLockedProofs).length ? { branchLockedProofs } : {}),
    ...(Object.keys(safeRefWitnesses).length ? { safeRefWitnesses } : {}),
    ...(Object.keys(manualBranchTerminals).length ? { manualBranchTerminals } : {}),
    ...(tombstonePrunedThisCycle ? { tombstonePrunedThisCycle: true } : {}),
    configApplied,
    checkoutRefReason,
    checkoutRefDetail,
    checkoutWitnessDisposition,
    authoredRefChanges,
  };
}

export async function followDivergedRepo(opts: FollowOptions): Promise<FollowResult> {
  const valid = validateGitSection(opts.incoming);
  const emptyProgress: FollowProgress = { appliedRefs: {}, heldRefs: {}, blockers: [], configApplied: true };
  if (!valid.ok) return deferResult(emptyProgress, "unsupported", `invalid git section: ${valid.reason}`);

  let staged: StagedIncoming;
  try {
    staged = await stageIncoming(opts);
  } catch (error) {
    const detail = `git artifact fetch/decrypt/import failed: ${String((error as Error)?.message ?? error)}`;
    return deferResult(emptyProgress, "artifact", detail);
  }

  try {
    // Imported scratch refs are transport scaffolding, never ownership roots.
    // Remove them before the trusted held-classification edge so cleanup cannot
    // make an otherwise stable attempt fingerprint self-invalidate.
    await staged.cleanupRefs();
    if (staged.candidateIndex) {
      try {
        const collision = await candidateIndexCollision(opts.workspaceRoot, opts.ctx.repoDir, staged.candidateIndex);
        if (collision) {
          opts.log?.(`git-sync WARNING ${opts.relPath}: incoming index has receiver-equivalent paths (${collision})`);
          return deferResult(emptyProgress, "unreadable", "incoming index has receiver path-equivalence collision");
        }
      } catch {
        return deferResult(emptyProgress, "unreadable", "incoming index receiver-equivalence check failed");
      }
    }
    const trustedFingerprint = await gitFingerprint(
      gitFingerprintRun("per-decision"), opts.workspaceRoot, opts.relPath, { includeIndexDependencies: true },
    ).catch(() => undefined);
    const effectiveIncomingIndexProjection = indexArtifact(opts.incoming)
      ? staged.candidateIndex
        ? await indexIdentityV2(opts.ctx.repoDir, staged.candidateIndex)
        : undefined
      : null;
    const strictLiveRefs = await readAllRefsStrict(opts.ctx.repoDir);
    if (strictLiveRefs.status === "unreadable") {
      return deferResult(emptyProgress, "ref-read-unreadable", `ref-read-unreadable: ${strictLiveRefs.marker}`);
    }
    const liveBefore = await readLive(opts.ctx, opts.chainTimings, strictLiveRefs.refs);
    if (!liveBefore) return deferResult(emptyProgress, "unreadable", "git metadata could not be read");
    const baseProjection = opts.record?.idxProj ?? await addTimedMs(opts.chainTimings, "indexOpStateMs", () =>
      deriveBaseIndexProjection(opts, staged.tmpDir).catch(() => undefined));
    const initialOwnershipContext = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
      ownershipProofContext(opts.ctx));
    const effectiveBaseIndexProjection = indexArtifact(opts.base) ? baseProjection : null;
    const effective = effectiveRefs(opts.ctx, opts.incoming);
    const ownershipSection = { ...opts.incoming, refs: effective.refs };
    const roots = incomingOwnershipRoots(ownershipSection, { prefix: staged.incomingNs, opState: staged.opBytes });
    // R2-3 adjudication: safe-ref publication intentionally precedes the state
    // save. A crash/republication reaches the same design-LWW outcome; the
    // displaced value is incoming-owned, remains reachable, and the design's
    // idempotency clause covers the retry. Do not move this behind the checkout
    // journal absent a new normative design change.
    let refProgress: Awaited<ReturnType<typeof publishRefPlane>>;
    try {
      refProgress = await publishRefPlane(opts, liveBefore, roots, initialOwnershipContext);
    } catch (error) {
      if (!(error instanceof WorktreeOwnershipUnreadableError)) throw error;
      return deferResult(
        emptyProgress,
        "unreadable",
        error.message,
      );
    }
    const progress: FollowProgress = {
      appliedRefs: refProgress.appliedRefs,
      heldRefs: refProgress.heldRefs,
      blockers: refProgress.blockers,
      consultedReflogPaths: [
        ...(opts.ctx.kind === "dir" ? ["logs/refs/stash"] : []),
        ...(refProgress.consultedReflogPaths ?? []),
      ],
      ...(refProgress.branchWitnesses ? { branchWitnesses: refProgress.branchWitnesses } : {}),
      ...(refProgress.branchLockedProofs ? { branchLockedProofs: refProgress.branchLockedProofs } : {}),
      ...(refProgress.safeRefWitnesses ? { safeRefWitnesses: refProgress.safeRefWitnesses } : {}),
      ...(refProgress.manualBranchTerminals ? { manualBranchTerminals: refProgress.manualBranchTerminals } : {}),
      ...(refProgress.tombstonePrunedThisCycle ? { tombstonePrunedThisCycle: true } : {}),
      configApplied: refProgress.configApplied,
      ...(staged.incomingIndexProjection === undefined ? {} : { incomingIndexProjection: staged.incomingIndexProjection }),
      ...(opts.record?.idxProj || baseProjection === undefined ? {} : { derivedBaseIndexProjection: baseProjection }),
    };
    opts.crashAt?.("after-safe-refs");

    // The design kill switch disables oracle-authorized checkout only. Safe
    // refs/config and their partial markers remain active in both flag arms.
    // R2-7 adjudication preserves design 43 [v2,M2] here: exact =0 keeps the
    // legacy conflict-checkpoint disposition; only capability unsupported is
    // converted to a typed retryable defer below.
    if (!opts.followEnabled && !opts.manualResolution) return { status: "legacy", reason: "conflict", detail: "automatic checkout follow disabled", ...progressWithBlocker(progress, "conflict", "automatic checkout follow disabled") };
    const capabilitySupported = opts.capabilityProbe
      ? await opts.capabilityProbe(await git(opts.ctx.repoDir, ["--version"]))
      : await checkoutTransactionSupported(opts.ctx.repoDir);
    if (!capabilitySupported) return deferResult(progress, "unsupported", "git lacks prepared transactional symref-update");

    // Scratch refs and held incoming values are not durable roots. Authorize
    // checkout only from incoming refs that are already published (plus the
    // current ref value that this checkout transaction itself will publish).
    const incomingHeadRef = headBranchOf(opts.incoming.head);
    const durableIncomingRefs = Object.fromEntries(Object.entries(progress.appliedRefs)
      .map(([ref, value]) => [ref, appliedTerminalOid(value)] as const)
      .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"));
    if (incomingHeadRef && effective.refs[incomingHeadRef]) {
      durableIncomingRefs[incomingHeadRef] = effective.refs[incomingHeadRef]!;
    }
    const selfRootWitness = selectCheckoutSelfRootWitness({
      currentTip: liveBefore.currentTip,
      effectiveIncomingRefs: effective.refs,
      receiverRefs: liveBefore.refs,
      ...refProgress.checkoutWitnessDisposition,
    });
    if (selfRootWitness) durableIncomingRefs[selfRootWitness.ref] = selfRootWitness.oid;
    const checkoutRoots = incomingOwnershipRoots(
      { ...opts.incoming, refs: durableIncomingRefs },
      { prefix: staged.incomingNs, opState: staged.opBytes },
    );

    const first = await addTimedMs(opts.chainTimings, "classifyMs", () => classifyCheckout({
      opts,
      live: liveBefore,
      incomingProjection: effectiveIncomingIndexProjection ?? undefined,
      baseProjection,
      roots: checkoutRoots,
      boundary: false,
      tombstonePrunedThisCycle: progress.tombstonePrunedThisCycle === true,
      checkoutRefReason: refProgress.checkoutRefReason,
      checkoutRefDetail: refProgress.checkoutRefDetail,
      heldRefs: progress.heldRefs,
      ownershipContext: initialOwnershipContext,
    }));
    if (!first.safe) {
      const blockers = [...progress.blockers, ...first.blockers];
      await opts.afterHeldClassification?.({
        phase: "defer",
        trustedFingerprint,
        effectiveBaseIndexProjection,
        effectiveIncomingIndexProjection,
        blockers,
        reflogPaths: progress.consultedReflogPaths ?? [],
        progress: { ...progress, blockers },
      });
      return { status: "defer", reason: first.reason!, detail: first.detail ?? "checkout follow proof failed", ...progress, blockers };
    }

    let origHeadPreservation: OrigHeadPreservation | undefined;
    if (first.breadcrumbWaived) {
      try {
        const origHeadMismatches = first.breadcrumbMismatches.filter((mismatch) => mismatch.rel === "ORIG_HEAD");
        if (origHeadMismatches.length > 1) throw new Error("unexpected breadcrumb waiver shape");
        const origHeadMismatch = origHeadMismatches[0];
        if (origHeadMismatch) {
          origHeadPreservation = await preserveOrigHead(opts, { ...origHeadMismatch, rel: "ORIG_HEAD" });
        }
        if ((origHeadMismatch !== undefined) !== (origHeadPreservation !== undefined)) {
          throw new Error("unexpected breadcrumb waiver shape");
        }
      } catch (error) {
        opts.log?.(origHeadPreservationFailureLine(opts.relPath, error));
        return deferResult(progress, "local-operation", `operation state differs at ${opStateDetailToken(opts.ctx, "ORIG_HEAD")}`);
      }
    }

    const refUpdates: CheckoutRefUpdate[] = [];
    const postHeadRefUpdates: CheckoutRefUpdate[] = [];
    const postHeadExtraTransactionLines: string[] = [];
    const refReservations: Array<{ ref: string; expectedOid: string | null }> = [];
    const reserveRef = (ref: string, expectedOid: string | null): void => {
      const existing = refReservations.find((reservation) => reservation.ref === ref);
      if (existing && existing.expectedOid !== expectedOid) throw new Error(`contradictory ref reservation for ${ref}`);
      if (!existing) refReservations.push({ ref, expectedOid });
    };
    if (selfRootWitness) reserveRef(selfRootWitness.ref, selfRootWitness.oid);
    const extraTransactionLines: string[] = [];
    const expectedRefs: Record<string, string> = {};
    let checkoutBranchPlan: PlannedBranchTransition | undefined;
    let checkoutBranchPlanIsPostHead = false;
    let checkoutBranchReflogFingerprint: string | undefined;
    let checkoutBranchLockedProof: LockedBranchProof | undefined;
    if (origHeadPreservation?.transactionLine) extraTransactionLines.push(origHeadPreservation.transactionLine);
    if (liveBefore.currentRef) {
      const currentRef = liveBefore.currentRef;
      const oldOid = liveBefore.currentTip;
      const newOid = effective.refs[currentRef];
      let pinLines: string[] = [];
      if (oldOid && (!newOid || (await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid], initialOwnershipContext))).status !== "owned")) {
        progress.consultedReflogPaths = [...new Set([
          ...(progress.consultedReflogPaths ?? []),
          `logs/${currentRef}`,
        ])].sort();
        const durableNow = { ...liveBefore.refs };
        delete durableNow[currentRef];
        const pins = await addTimedMs(opts.chainTimings, "reflogMs", () => prepareDisplacementPins(
          opts.ctx.repoDir,
          currentRef,
          oldOid,
          [...Object.values(durableNow), ...(newOid ? [newOid] : [])],
          humanDisplacementOrigin(currentRef, opts.incoming),
        ));
        if (pins.status === "indeterminate") {
          return deferResult(progress, "unreadable", `current-ref reflog reachability ${pins.marker}`);
        }
        pinLines = pins.transactionLines;
        checkoutBranchReflogFingerprint = pins.reflogFingerprint;
      }
      if (oldOid && ((newOid && oldOid !== newOid) || (!newOid && effective.deleteAbsent))) {
        if (!opts.branchProtocol) return deferResult(progress, "artifact", "checked-out branch transition lacks lineage authority");
        checkoutBranchPlan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => opts.manualResolution
          ? planManualBranchTransition({
              repoDir: opts.ctx.repoDir, binding: opts.branchProtocol!.binding, ref: currentRef,
              physicalBeforeOid: oldOid, afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[currentRef] ?? null,
              extraTransactionLines: pinLines,
              ...(checkoutBranchReflogFingerprint ? { expectedReflogFingerprint: checkoutBranchReflogFingerprint } : {}),
              reserveHead: false,
            })
          : planBranchTransition({
              repoDir: opts.ctx.repoDir,
              binding: opts.branchProtocol!.binding,
              ref: currentRef,
              beforeOid: oldOid,
              afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[currentRef] ?? null,
              extraTransactionLines: pinLines,
              ...(checkoutBranchReflogFingerprint ? { expectedReflogFingerprint: checkoutBranchReflogFingerprint } : {}),
              reserveHead: false,
            }));
        checkoutBranchPlanIsPostHead = incomingHeadRef !== liveBefore.currentRef;
        if (checkoutBranchPlanIsPostHead) postHeadExtraTransactionLines.push(...checkoutBranchPlan.lines);
        else extraTransactionLines.push(...checkoutBranchPlan.lines);
        if (newOid) expectedRefs[liveBefore.currentRef] = newOid;
      }
    }
    const head = incomingHeadRef
      ? { kind: "symbolic" as const, newTarget: incomingHeadRef, ...(liveBefore.currentRef ? { oldTarget: liveBefore.currentRef } : { oldOid: liveBefore.currentTip }) }
      : { kind: "detached" as const, newOid: opts.incoming.head.trim(), oldOid: liveBefore.currentTip! };
    if (incomingHeadRef && incomingHeadRef !== liveBefore.currentRef) {
      const targetOid = effective.refs[incomingHeadRef];
      if (!targetOid) return deferResult(progress, "unsupported", "incoming HEAD branch is filtered or absent");
      reserveRef(incomingHeadRef, targetOid);
    }

    const postProgress: FollowProgress = {
      ...progress,
      appliedRefs: { ...progress.appliedRefs },
      branchWitnesses: { ...(progress.branchWitnesses ?? {}) },
      branchLockedProofs: { ...(progress.branchLockedProofs ?? {}) },
      manualBranchTerminals: { ...(progress.manualBranchTerminals ?? {}) },
    };
    if (checkoutBranchPlan) {
      postProgress.appliedRefs[checkoutBranchPlan.ref] = checkoutBranchPlan.partial;
      postProgress.branchWitnesses![checkoutBranchPlan.ref] = checkoutBranchPlan.witness;
    }
    // §126/§130 second-proof reservations cover every ref-plane commit that is
    // not already held by the checkout transaction itself. Absence is an exact
    // locked fact, accompanied by its A/Z target; present branch progress also
    // reserves P and every mandatory K until the state composer consumes it.
    for (const [ref, witness] of Object.entries(postProgress.safeRefWitnesses ?? {})) {
      reserveRef(ref, witness.afterOid);
    }
    for (const [ref, witness] of Object.entries(postProgress.branchWitnesses ?? {})) {
      if (ref === checkoutBranchPlan?.ref) continue;
      reserveRef(ref, witness.kind === "present" ? witness.nextOid : null);
      reserveRef(witness.artifactRef, witness.artifactOid);
      if (witness.kind === "present") {
        if (witness.priorOid) reserveRef(
          basePresentKeepRef(opts.branchProtocol!.binding, ref, witness.episode, "prior"),
          witness.priorOid,
        );
        reserveRef(
          basePresentKeepRef(opts.branchProtocol!.binding, ref, witness.episode, "next"),
          witness.nextOid,
        );
      }
    }
    if (incomingHeadRef && effective.refs[incomingHeadRef] && incomingHeadRef !== checkoutBranchPlan?.ref) {
      postProgress.appliedRefs[incomingHeadRef] = { kind: "direct", oid: effective.refs[incomingHeadRef]! };
    }
    if (liveBefore.currentRef && incomingHeadRef === liveBefore.currentRef && effective.refs[liveBefore.currentRef]
      && liveBefore.currentRef !== checkoutBranchPlan?.ref) {
      postProgress.appliedRefs[liveBefore.currentRef] = { kind: "direct", oid: effective.refs[liveBefore.currentRef]! };
      const logicalBefore = opts.branchProtocol?.logicalBaseRefs[liveBefore.currentRef] ?? null;
      if (opts.manualResolution && logicalBefore !== null && logicalBefore !== effective.refs[liveBefore.currentRef]) {
        postProgress.manualBranchTerminals![liveBefore.currentRef] = {
          beforeBaseOid: logicalBefore,
          afterOid: effective.refs[liveBefore.currentRef]!,
        };
      }
    }

    const oldOp = Object.fromEntries(Object.keys(liveBefore.opState).map((rel) => [rel, true as const]));
    const newOp = sectionOpState(opts.incoming);
    const intended = await opts.makeIntended(postProgress);
    const journalId = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const journal: CheckoutJournal<FollowIntended> = {
      journalId,
      phase: "intent",
      incomingKey: gitIncomingKey(opts.incoming),
      incomingSection: opts.incoming,
      old: {
        ...(liveBefore.currentRef ? { currentRefName: liveBefore.currentRef, currentRefOid: liveBefore.currentTip } : {}),
        headContent: liveBefore.headContent,
        indexPresent: liveBefore.indexPresent,
        opState: oldOp,
      },
      expectedNew: {
        opState: newOp,
        refs: expectedRefs,
        head: expectedHead(opts.incoming),
        ...(checkoutBranchPlan ? { branchInverses: [{
          ref: checkoutBranchPlan.ref,
          beforeOid: checkoutBranchPlan.beforeOid,
          afterOid: checkoutBranchPlan.afterOid,
          lines: checkoutBranchPlan.inverseLines,
        }] } : {}),
        ...(refReservations.length ? { reservedRefs: Object.fromEntries(refReservations.map(({ ref, expectedOid }) => [ref, expectedOid])) } : {}),
      },
      binding: opts.binding,
      createdFresh: false,
      intended,
      ...(opts.manualResolution ? { episode: { verb: "take-theirs" as const, snapshotId: opts.manualResolution.snapshotId } } : {}),
    };
    await addTimedMs(opts.chainTimings, "journalMs", () => writeCheckoutJournal(opts.workspaceRoot, opts.relPath, journal, {
      indexPath: path.join(opts.ctx.gitDir, "index"),
      gitDir: opts.ctx.gitDir,
    }));
    opts.crashAt?.("after-journal-write");

    let boundaryFailure: Pick<CheckoutClassification, "safe" | "reason" | "detail" | "blockers"> | undefined;
    const noteBoundaryFailure = (reason: GitDeferralReason, detail: string): void => {
      const chosen = firstReason(new Set([...(boundaryFailure?.reason ? [boundaryFailure.reason] : []), reason]));
      if (!boundaryFailure || chosen === reason) boundaryFailure = {
        safe: false,
        reason,
        detail,
        blockers: [blockerForReason(reason, "boundary", detail)],
      };
    };
    const result = await commitCheckout(opts.ctx, {
      ...(staged.candidateIndex ? { candidateIndexPath: staged.candidateIndex } : { removeIndex: true }),
      refUpdates,
      postHeadRefUpdates,
      postHeadExtraTransactionLines,
      ...(checkoutBranchPlanIsPostHead && checkoutBranchPlan?.reflogMessage
        ? { postHeadReflogMessage: checkoutBranchPlan.reflogMessage } : {}),
      refReservations,
      head,
      extraTransactionLines,
      ...(!checkoutBranchPlanIsPostHead && checkoutBranchPlan?.reflogMessage
        ? { reflogMessage: checkoutBranchPlan.reflogMessage } : {}),
      plannedGraphRoots: [...roots, ...(origHeadPreservation?.recoveryOid ? [origHeadPreservation.recoveryOid] : [])],
      opState: staged.opState,
      ...(origHeadPreservation ? { origHeadLock: { journalId, expectedOldBytes: origHeadPreservation.expectedOldBytes } } : {}),
      ...(origHeadPreservation?.malformedRawBytes ? { malformedOrigHeadPreserved: true as const } : {}),
    }, {
      capabilityProbe: opts.capabilityProbe,
      capabilitySupported: true,
      journal: { workspaceRoot: opts.workspaceRoot, relPath: opts.relPath, value: journal },
      mutationBoundary: opts.mutationBoundary,
      secondProof: async () => {
        await opts.beforeCheckoutSecondProof?.();
        const freshCtx = await repoCtx(opts.ctx.repoDir);
        const freshBinding = freshCtx ? await checkoutJournalBinding(opts.binding.stream, opts.binding.stateNonce, freshCtx) : undefined;
        const sameIncarnation = freshCtx !== undefined && freshBinding !== undefined
          && freshBinding.gitDirReal === opts.binding.gitDirReal
          && freshBinding.commonDirReal === opts.binding.commonDirReal
          && freshBinding.worktreeId === opts.binding.worktreeId
          && freshCtx.kind === opts.ctx.kind;
        const live = sameIncarnation ? await readLive(freshCtx, opts.chainTimings) : undefined;
        const boundaryOwnershipContext = freshCtx
          ? await addTimedMs(opts.chainTimings, "ownershipMs", () => ownershipProofContext(freshCtx))
          : { shallow: undefined };
        if (opts.manualResolution) {
          try {
            if (!(await opts.manualResolution.secondProof(refProgress.authoredRefChanges))) {
              noteBoundaryFailure("other", "confirmed snapshot changed at checkout boundary");
              return false;
            }
          } catch {
            noteBoundaryFailure("unreadable", "confirmed snapshot could not be revalidated at checkout boundary");
            return false;
          }
        }
        const proof = await addTimedMs(opts.chainTimings, "classifyMs", () => classifyCheckout({
          opts,
          live,
          incomingProjection: staged.incomingIndexProjection,
          baseProjection,
          roots: checkoutRoots,
          boundary: true,
          boundaryChanged: !sameIncarnation,
          tombstonePrunedThisCycle: progress.tombstonePrunedThisCycle === true,
          checkoutRefReason: refProgress.checkoutRefReason,
          checkoutRefDetail: refProgress.checkoutRefDetail,
          heldRefs: progress.heldRefs,
          ownershipContext: boundaryOwnershipContext,
        }));
        if (!proof.safe) boundaryFailure = proof;
        if (!opts.manualResolution && (first.breadcrumbWaived || proof.breadcrumbMismatches.length > 0 || origHeadPreservation)) {
          const boundaryHasOrigHead = proof.breadcrumbMismatches.some((mismatch) => mismatch.rel === "ORIG_HEAD");
          if (!proof.breadcrumbWaived || boundaryHasOrigHead !== (origHeadPreservation !== undefined)) {
            if (proof.safe) {
              const rels = [...new Set([
                ...first.breadcrumbMismatches.map((mismatch) => mismatch.rel),
                ...proof.breadcrumbMismatches.map((mismatch) => mismatch.rel),
              ])];
              noteBoundaryFailure("local-operation", `operation state differs at ${rels.map((rel) => opStateDetailToken(opts.ctx, rel)).join(", ")}`);
            }
            return false;
          }
        }
        if (!sameIncarnation) { noteBoundaryFailure("unreadable", "repository incarnation changed at checkout boundary"); return false; }
        if (!live) { noteBoundaryFailure("unreadable", "git metadata became unreadable"); return false; }
        const boundaryOwned = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx));
        if (selfRootWitness) {
          const boundaryAmbiguousRefs = new Set([
            ...refProgress.checkoutWitnessDisposition.ambiguousRefs,
            ...receiverEquivalentCollisionNames([
              ...Object.keys(effective.refs),
              ...Object.keys(live.refs),
              ...boundaryOwned.keys(),
            ]),
          ]);
          const boundaryWitness = selectCheckoutSelfRootWitness({
            currentTip: live.currentTip,
            effectiveIncomingRefs: effective.refs,
            receiverRefs: live.refs,
            heldRefs: refProgress.checkoutWitnessDisposition.heldRefs,
            forcedRefs: refProgress.checkoutWitnessDisposition.forcedRefs,
            ambiguousRefs: boundaryAmbiguousRefs,
            requiredRef: selfRootWitness.ref,
          });
          if (!boundaryWitness || boundaryWitness.oid !== selfRootWitness.oid) {
            noteBoundaryFailure("local-commits", `checkout self-root witness changed at ${selfRootWitness.ref}`);
            return false;
          }
        }
        for (const [ref, expected] of Object.entries(progress.appliedRefs)) {
          const terminal = appliedTerminalOid(expected);
          if (boundaryOwned.has(ref) && (liveBefore.refs[ref] ?? null) !== (terminal ?? null)) {
            noteBoundaryFailure("worktree-ownership", `worktree ownership changed for ${ref}`);
            return false;
          }
        }
        if (incomingHeadRef && boundaryOwned.has(incomingHeadRef)) {
          noteBoundaryFailure("worktree-ownership", "incoming checkout branch became sibling-owned");
          return false;
        }
        for (const bad of opts.ctx.kind === "dir" ? ["modules", "objects/info/alternates"] : ["objects/info/alternates"]) {
          const root = opts.ctx.kind === "dir" ? opts.ctx.gitDir : opts.ctx.commonDir;
          if (await exists(path.join(root, bad))) {
            noteBoundaryFailure("unsupported", `repository structure changed at ${bad}`);
            return false;
          }
        }
        for (const [ref, expected] of Object.entries(progress.appliedRefs)) {
          const terminal = appliedTerminalOid(expected);
          if (terminal !== undefined && (live.refs[ref] ?? null) !== terminal) {
            noteBoundaryFailure("local-commits", `published ref changed at ${ref}`);
            return false;
          }
        }
        for (const ref of Object.keys(progress.heldRefs)) if (live.refs[ref] !== liveBefore.refs[ref]) {
          noteBoundaryFailure("local-commits", `held ref changed at ${ref}`);
          return false;
        }
        if (checkoutBranchPlan && !checkoutBranchPlanIsPostHead) {
          if (checkoutBranchReflogFingerprint) {
            const fingerprint = await addTimedMs(opts.chainTimings, "reflogMs", () =>
              readRefReflogFingerprint(opts.ctx.repoDir, checkoutBranchPlan!.ref));
            if (fingerprint.sha256 !== checkoutBranchReflogFingerprint) {
              noteBoundaryFailure("local-commits", `branch reflog changed at ${checkoutBranchPlan.ref}`);
              return false;
            }
          }
          checkoutBranchLockedProof = {
            liveOid: checkoutBranchPlan.afterOid,
            witness: checkoutBranchPlan.witness,
            ...(checkoutBranchPlan.witness.kind === "present" ? { reflogEpisode: checkoutBranchPlan.witness.episode } : {}),
            artifactsClear: true,
            ownershipStable: true,
            reflogStable: true,
            currentRef: incomingHeadRef === checkoutBranchPlan.ref,
            siblingOwned: false,
          };
        }
        return proof.safe;
      },
      ...(checkoutBranchPlanIsPostHead && checkoutBranchPlan ? { postHeadSecondProof: async () => {
        const [strict, owned, headContent] = await Promise.all([
          readAllRefsStrict(opts.ctx.repoDir),
          addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx)),
          readHead(opts.ctx),
        ]);
        if (strict.status === "unreadable") {
          noteBoundaryFailure("ref-read-unreadable", `ref-read-unreadable: ${strict.marker}`);
          return false;
        }
        const refs = strict.refs;
        if ((refs[checkoutBranchPlan!.ref] ?? null) !== checkoutBranchPlan!.beforeOid
          || owned.has(checkoutBranchPlan!.ref)
          || headBranchOf(headContent) === checkoutBranchPlan!.ref) return false;
        if (checkoutBranchReflogFingerprint) {
          const fingerprint = await addTimedMs(opts.chainTimings, "reflogMs", () =>
            readRefReflogFingerprint(opts.ctx.repoDir, checkoutBranchPlan!.ref));
          if (fingerprint.sha256 !== checkoutBranchReflogFingerprint) return false;
        }
        checkoutBranchLockedProof = {
          liveOid: checkoutBranchPlan!.afterOid,
          witness: checkoutBranchPlan!.witness,
          ...(checkoutBranchPlan!.witness.kind === "present" ? { reflogEpisode: checkoutBranchPlan!.witness.episode } : {}),
          artifactsClear: true,
          ownershipStable: true,
          reflogStable: true,
          currentRef: false,
          siblingOwned: false,
        };
        return true;
      } } : {}),
      crashAt: (point) => opts.crashAt?.(point),
      chainTimings: opts.chainTimings,
    });
    if (result.status !== "committed") {
      // A dead prepared child or post-symref HEAD arbitration can leave locks
      // and/or committed checkout fields that only intent recovery may touch.
      if (result.status !== "defer" || !result.journalIntact) await addTimedMs(opts.chainTimings, "journalMs", () => clearCheckoutJournal(opts.workspaceRoot, opts.relPath));
      const reason: GitDeferralReason = result.status === "unsupported" ? "unsupported"
        : /became busy/.test(result.reason) ? "git-busy"
        : /connectivity/.test(result.reason) ? "artifact"
        : result.reason === ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY ? "local-operation"
        : boundaryFailure?.reason ?? "other";
      return {
        status: "defer",
        reason,
        detail: result.reason === ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY ? "operation state differs at ORIG_HEAD" : boundaryFailure?.detail ?? result.reason,
        ...progress,
        blockers: [
          ...progress.blockers,
          ...(boundaryFailure?.blockers ?? [blockerForReason(reason, "boundary", result.reason)]),
        ],
      };
    }
    if (checkoutBranchPlan) {
      if (!checkoutBranchLockedProof) throw new Error("checkout branch committed without locked proof receipt");
      postProgress.branchLockedProofs![checkoutBranchPlan.ref] = checkoutBranchLockedProof;
      journal.intended = await opts.makeIntended(postProgress);
      await addTimedMs(opts.chainTimings, "journalMs", () => updateCheckoutJournal(opts.workspaceRoot, opts.relPath, journal));
    }
    await addTimedMs(opts.chainTimings, "journalMs", () => markCheckoutJournalPublished(opts.workspaceRoot, opts.relPath));
    if (opts.manualResolution && effective.refs["refs/stash"]) await ensureStashReflog(opts.ctx.repoDir, effective.refs["refs/stash"]!);
    opts.crashAt?.("after-published-flip");
    if (origHeadPreservation) {
      if (origHeadPreservation.recoveryRef && origHeadPreservation.discriminator) {
        await pruneOrigHeadRecoveryRefs(opts.ctx.repoDir, origHeadPreservation.discriminator, origHeadPreservation.recoveryRef).catch(() => {});
      }
      opts.log?.(`git-sync: adopted stale ORIG_HEAD breadcrumb for ${opts.relPath} (old value preserved at ${origHeadPreservation.recoveryLocation})`);
    }
    if (opts.afterHeldClassification && !opts.manualResolution) {
      const finalTrusted = await gitFingerprint(
        gitFingerprintRun("per-decision"), opts.workspaceRoot, opts.relPath, { includeIndexDependencies: true },
      ).catch(() => undefined);
      const finalIncomingProjection = indexArtifact(opts.incoming)
        ? staged.candidateIndex
          ? await indexIdentityV2(opts.ctx.repoDir, staged.candidateIndex)
          : undefined
        : null;
      const finalBaseProjection = indexArtifact(opts.base)
        ? opts.record?.idxProj ?? await addTimedMs(opts.chainTimings, "indexOpStateMs", () =>
          deriveBaseIndexProjection(opts, staged.tmpDir).catch(() => undefined))
        : null;
      await opts.beforeFinalLive?.();
      const finalOwnershipContext = await addTimedMs(opts.chainTimings, "ownershipMs", () =>
        ownershipProofContext(opts.ctx));
      const finalLive = await readLive(opts.ctx, opts.chainTimings);
      if (finalLive) {
        const finalRef = await publishRefPlane(opts, finalLive, roots, finalOwnershipContext, true);
        const finalCheckout = await addTimedMs(opts.chainTimings, "classifyMs", () => classifyCheckout({
          opts,
          live: finalLive,
          incomingProjection: finalIncomingProjection ?? undefined,
          baseProjection: finalBaseProjection ?? undefined,
          roots: checkoutRoots,
          boundary: false,
          tombstonePrunedThisCycle: postProgress.tombstonePrunedThisCycle === true,
          checkoutRefReason: finalRef.checkoutRefReason,
          checkoutRefDetail: finalRef.checkoutRefDetail,
          heldRefs: finalRef.heldRefs,
          ownershipContext: finalOwnershipContext,
        }));
        const blockers = [...finalRef.blockers, ...finalCheckout.blockers];
        const finalReflogPaths = [...new Set([
          ...(opts.ctx.kind === "dir" ? ["logs/refs/stash"] : []),
          ...(finalRef.consultedReflogPaths ?? []),
        ])].sort();
        const finalProgress: FollowProgress = {
          ...postProgress,
          heldRefs: finalRef.heldRefs,
          blockers,
          consultedReflogPaths: finalReflogPaths,
        };
        await opts.afterHeldClassification({
          phase: "followed",
          trustedFingerprint: finalTrusted,
          effectiveBaseIndexProjection: finalBaseProjection,
          effectiveIncomingIndexProjection: finalIncomingProjection,
          blockers,
          reflogPaths: finalReflogPaths,
          progress: finalProgress,
        });
      }
    }
    return { status: "followed", ...postProgress };
  } finally {
    await staged.cleanup();
  }
}
