import crypto from "node:crypto";
import { receiverEquivalentCollisionNames } from "../../engine/index.js";
import { tipOwnedByIncoming } from "./reachability.js";
import { branchesCheckedOutElsewhere, branchesCheckedOutElsewhereStrict } from "./git-state-apply.js";
import { addTimedMs } from "./chain-timings.js";
import {
  humanDisplacementOrigin,
  prepareDisplacementPins,
  prepareTombstonePrunePins,
  runUpdateRefTransaction,
} from "./keep-pins.js";
import { readAllRefs, readAllRefsStrict } from "./refs.js";
import type { GitDeferralReason, GitPartialApply, TypedBlocker } from "../config.js";
import type { BranchTransitionWitness, LockedBranchProof, SafeRefWitness } from "./base-composer.js";
import {
  commitPlannedBranchTransition,
  planBranchTransition,
  planManualBranchTransition,
  type PlanBranchTransitionInput,
  type PlanManualBranchTransitionInput,
} from "./branch-transition.js";
import { blockerForReason, boundedRefFailure, type FollowProgress } from "./follow-types.js";
import { ensureStashReflog } from "./follow-ref-witness.js";
import type { RefPlaneObservation } from "./ref-plane-observation.js";
import { gitIncomingKey } from "./shared.js";
import { checkTombstoneAttestation } from "./tombstone-attestation.js";

export interface RefPlaneProgress extends FollowProgress {
  checkoutRefReason?: GitDeferralReason;
  checkoutRefDetail?: string;
  checkoutWitnessDisposition: {
    heldRefs: ReadonlySet<string>;
    forcedRefs: ReadonlySet<string>;
    ambiguousRefs: ReadonlySet<string>;
  };
  authoredRefChanges: Array<{ ref: string; before?: string; after?: string }>;
}

function refPublicationFailureReason(message: string): GitDeferralReason {
  if (message.includes("ref-read-unreadable")) return "ref-read-unreadable";
  return /lock|busy|transaction/i.test(message) ? "git-busy" : "other";
}

function planInputs(state: RefPlaneObservation, ref: string, oldOid: string | undefined, newOid: string | undefined, lines: string[], branchEpisode?: string, tombstoneFingerprint?: string): PlanBranchTransitionInput | PlanManualBranchTransitionInput {
  const { opts } = state;
  if (opts.manualResolution) {
    const input: PlanManualBranchTransitionInput = {
      repoDir: opts.ctx.repoDir,
      binding: opts.branchProtocol!.binding,
      ref,
      physicalBeforeOid: oldOid ?? null,
      afterOid: newOid ?? null,
      logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
      extraTransactionLines: lines,
    };
    if (branchEpisode) input.episode = branchEpisode;
    if (tombstoneFingerprint) input.expectedReflogFingerprint = tombstoneFingerprint;
    return input;
  }
  const input: PlanBranchTransitionInput = {
    repoDir: opts.ctx.repoDir,
    binding: opts.branchProtocol!.binding,
    ref,
    beforeOid: oldOid ?? null,
    afterOid: newOid ?? null,
    logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[ref] ?? null,
    extraTransactionLines: lines,
  };
  if (branchEpisode) input.episode = branchEpisode;
  if (tombstoneFingerprint) input.expectedReflogFingerprint = tombstoneFingerprint;
  return input;
}

export async function publishObservedRefPlane(state: RefPlaneObservation): Promise<RefPlaneProgress> {
  const {
    opts, live, roots, ownershipContext, classifyOnly, effective, candidates,
    classifiedHolds, indeterminateRefs, forcedRefs, ambiguousRefs,
    tombstoneAuthorized, deletionWitnessRefs, deletionWitnessHeldRefs,
    incomingHeadRef,
  } = state;
  const appliedRefs: GitPartialApply["appliedRefs"] = {};
  const heldRefs: GitPartialApply["heldRefs"] = {};
  const blockers: TypedBlocker[] = [...state.blockers];
  const consultedReflogPaths = new Set<string>();
  const branchWitnesses: Record<string, BranchTransitionWitness> = {};
  const branchLockedProofs: Record<string, LockedBranchProof> = {};
  const safeRefWitnesses: Record<string, SafeRefWitness> = {};
  const manualBranchTerminals: NonNullable<FollowProgress["manualBranchTerminals"]> = {};
  const authoredRefChanges: RefPlaneProgress["authoredRefChanges"] = [];
  let { tombstonePrunedThisCycle, checkoutRefReason, checkoutRefDetail, checkoutRefReasonFromIndeterminate } = state;

  for (const ref of [...candidates].sort()) {
    if (ref === live.currentRef) continue;
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
            if (!checkoutRefReason) {
              checkoutRefReason = refPublicationFailureReason(String((error as Error)?.message ?? error));
              checkoutRefDetail = `manual absent branch proof failed for ${ref}: ${boundedRefFailure(error)}`;
            }
          }
        } else if (baseOid !== (newOid ?? null)) {
          heldRefs[ref] = "local-commits";
        }
      } else if (baseOid !== (newOid ?? null)) {
        const persisted = opts.record?.partial?.incomingKey === gitIncomingKey(opts.incoming)
          ? opts.record.partial.appliedRefs[ref]
          : undefined;
        const witness = persisted?.kind === "safe-ref" && persisted.afterOid === (newOid ?? null)
          ? persisted
          : { kind: "safe-ref" as const, proof: "locked-terminal-observation" as const, afterOid: newOid ?? null };
        appliedRefs[ref] = witness;
        safeRefWitnesses[ref] = witness;
      } else if (newOid) {
        appliedRefs[ref] = { kind: "direct", oid: newOid };
      }
      if (!opts.manualResolution && ref === "refs/stash" && newOid && !classifyOnly) {
        await addTimedMs(opts.chainTimings, "reflogMs", () => ensureStashReflog(opts.ctx.repoDir, newOid));
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
        const input = planInputs(state, ref, oldOid, newOid, lines, branchEpisode, tombstoneFingerprint);
        const plan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => opts.manualResolution
          ? planManualBranchTransition(input as PlanManualBranchTransitionInput)
          : planBranchTransition(input as PlanBranchTransitionInput));
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
        const witness = { kind: "safe-ref" as const, proof: "expected-old-transaction" as const, beforeOid: oldOid ?? null, afterOid: newOid ?? null };
        safeRefWitnesses[ref] = witness;
        appliedRefs[ref] = witness;
      }
      if (opts.manualResolution) {
        const change: RefPlaneProgress["authoredRefChanges"][number] = { ref };
        if (oldOid) change.before = oldOid;
        if (newOid) change.after = newOid;
        authoredRefChanges.push(change);
      }
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
  if (checkoutRefReason && !checkoutRefReasonFromIndeterminate) {
    blockers.push(blockerForReason(checkoutRefReason, "checkout", checkoutRefDetail));
  }
  const result: RefPlaneProgress = {
    appliedRefs,
    heldRefs,
    blockers,
    consultedReflogPaths: [...consultedReflogPaths].sort(),
    configApplied,
    checkoutRefReason,
    checkoutRefDetail,
    checkoutWitnessDisposition: {
      heldRefs: new Set(Object.keys(heldRefs)),
      forcedRefs,
      ambiguousRefs,
    },
    authoredRefChanges,
  };
  if (Object.keys(branchWitnesses).length) result.branchWitnesses = branchWitnesses;
  if (Object.keys(branchLockedProofs).length) result.branchLockedProofs = branchLockedProofs;
  if (Object.keys(safeRefWitnesses).length) result.safeRefWitnesses = safeRefWitnesses;
  if (Object.keys(manualBranchTerminals).length) result.manualBranchTerminals = manualBranchTerminals;
  if (tombstonePrunedThisCycle) result.tombstonePrunedThisCycle = true;
  return result;
}
