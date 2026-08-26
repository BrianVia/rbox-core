/** Never: construct branch inverses, classify checkout safety, recover journals, compose BASE, or persist sync state. */
import crypto from "node:crypto";
import path from "node:path";
import { CONNECTIVITY_PROOF_UNAVAILABLE, ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY, commitCheckout, type CheckoutDeferCode, type CheckoutPlan, type CheckoutRefUpdate, type CommitCheckoutOptions } from "./checkout-txn.js";
import { basePresentKeepRef } from "./base-artifacts.js";
import { clearCheckoutJournal, markCheckoutJournalPublished, updateCheckoutJournal, writeCheckoutJournal, type CheckoutJournal } from "./journal.js";
import { tipOwnedByIncoming, type OwnershipProofContext } from "./reachability.js";
import { addTimedMs } from "./chain-timings.js";
import { humanDisplacementOrigin, prepareDisplacementPins } from "./keep-pins.js";
import type { GitDeferralReason } from "../config.js";
import type { LockedBranchProof } from "./base-composer.js";
import {
  planBranchTransition,
  planManualBranchTransition,
  type PlanBranchTransitionInput,
  type PlanManualBranchTransitionInput,
  type PlannedBranchTransition,
} from "./branch-transition.js";
import { opStateDetailToken } from "./follow-classify.js";
import { expectedHead } from "./follow-staging.js";
import { ensureStashReflog, effectiveRefs, type CheckoutSelfRootWitness } from "./follow-ref-witness.js";
import {
  blockerForReason,
  deferResult,
  type CheckoutClassification,
  type FollowIntended,
  type FollowOptions,
  type FollowProgress,
  type FollowResult,
  type LiveMetadata,
  type StagedIncoming,
} from "./follow-types.js";
import {
  proveCheckoutBoundary,
  provePostHeadBoundary,
  type BoundaryFailure,
  type CheckoutBoundaryInput,
} from "./ref-plane-boundary.js";
import { observeRefPlane } from "./ref-plane-observation.js";
import { publishObservedRefPlane, type RefPlaneProgress } from "./ref-plane-publication.js";
import { origHeadPreservationFailureLine, preserveOrigHead, type OrigHeadPreservation } from "./orig-head.js";
import { gitIncomingKey, sectionOpState } from "./shared.js";

export type CheckoutCommitReceipt =
  | { status: "defer"; result: FollowResult; code?: CheckoutDeferCode }
  | { status: "committed"; progress: FollowProgress; origHeadPreservation?: OrigHeadPreservation };

export interface CheckoutCommitInput {
  staged: StagedIncoming; first: CheckoutClassification;
  checkoutRoots: readonly string[];
  selfRootWitness?: CheckoutSelfRootWitness; baseProjection?: string;
}

function copyProgress(source: FollowProgress): FollowProgress {
  return structuredClone(source);
}

function copyPublication(source: RefPlaneProgress): RefPlaneProgress {
  return structuredClone(source);
}

export class RefPlaneTransaction {
  private published?: RefPlaneProgress;
  private progress?: FollowProgress;
  private checkoutBranchPlan?: PlannedBranchTransition;
  private journal?: CheckoutJournal<FollowIntended>;
  private publicationStarted = false;
  private checkoutStarted = false;

  constructor(private readonly opts: FollowOptions, private readonly liveBefore: LiveMetadata,
    private readonly roots: readonly string[], private readonly ownershipContext: OwnershipProofContext,
    private readonly effective: ReturnType<typeof effectiveRefs>, private readonly incomingHeadRef: string | undefined) {}

  async publishIndependentRefs(staged: StagedIncoming, baseProjection?: string): Promise<Readonly<RefPlaneProgress>> {
    if (this.publicationStarted) throw new Error("ref plane publication already started");
    this.publicationStarted = true;
    const observation = await observeRefPlane(
      this.opts,
      this.liveBefore,
      this.roots,
      this.ownershipContext,
      false,
      this.effective,
      this.incomingHeadRef,
    );
    const published = await publishObservedRefPlane(observation);
    published.consultedReflogPaths = [
      ...(this.opts.ctx.kind === "dir" ? ["logs/refs/stash"] : []),
      ...(published.consultedReflogPaths ?? []),
    ];
    if (staged.incomingIndexProjection !== undefined) published.incomingIndexProjection = staged.incomingIndexProjection;
    if (!this.opts.record?.idxProj && baseProjection !== undefined) published.derivedBaseIndexProjection = baseProjection;
    this.published = copyPublication(published);
    this.progress = copyProgress(this.published);
    return copyPublication(this.published);
  }

  static async classifyExistingRefs(
    opts: FollowOptions,
    live: LiveMetadata,
    roots: readonly string[],
    ownershipContext: OwnershipProofContext,
  ): Promise<RefPlaneProgress> {
    const observation = await observeRefPlane(opts, live, roots, ownershipContext, true);
    return publishObservedRefPlane(observation);
  }

  async commitCheckout(input: CheckoutCommitInput): Promise<CheckoutCommitReceipt> {
    if (this.checkoutStarted) throw new Error("checkout transaction already started");
    this.checkoutStarted = true;
    const refProgress = this.published;
    const progress = this.progress;
    if (!refProgress || !progress) throw new Error("independent ref plane has not been published");
    const { opts, liveBefore } = this;
    const { staged, first, checkoutRoots } = input;
    const { effective, incomingHeadRef } = this;

    let origHeadPreservation: OrigHeadPreservation | undefined;
    if (first.breadcrumbWaived) {
      try {
        const origHeadMismatches = first.breadcrumbMismatches.filter((mismatch) => mismatch.rel === "ORIG_HEAD");
        if (origHeadMismatches.length > 1) throw new Error("unexpected breadcrumb waiver shape");
        const origHeadMismatch = origHeadMismatches[0];
        if (origHeadMismatch) origHeadPreservation = await preserveOrigHead(opts, { ...origHeadMismatch, rel: "ORIG_HEAD" });
        if ((origHeadMismatch !== undefined) !== (origHeadPreservation !== undefined)) throw new Error("unexpected breadcrumb waiver shape");
      } catch (error) {
        opts.log?.(origHeadPreservationFailureLine(opts.relPath, error));
        return { status: "defer", result: deferResult(progress, "local-operation", `operation state differs at ${opStateDetailToken(opts.ctx, "ORIG_HEAD")}`) };
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
    if (input.selfRootWitness) reserveRef(input.selfRootWitness.ref, input.selfRootWitness.oid);
    const extraTransactionLines: string[] = [];
    const expectedRefs: Record<string, string> = {};
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
        tipOwnedByIncoming(opts.ctx.repoDir, oldOid, [newOid], this.ownershipContext))).status !== "owned")) {
        progress.consultedReflogPaths = [...new Set([...(progress.consultedReflogPaths ?? []), `logs/${currentRef}`])].sort();
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
          return { status: "defer", result: deferResult(progress, "unreadable", `current-ref reflog reachability ${pins.marker}`) };
        }
        pinLines = pins.transactionLines;
        checkoutBranchReflogFingerprint = pins.reflogFingerprint;
      }
      const needsPlan = oldOid
        ? (newOid !== undefined && oldOid !== newOid) || (newOid === undefined && effective.deleteAbsent)
        : opts.manualResolution !== undefined && newOid !== undefined;
      if (needsPlan) {
        if (!opts.branchProtocol) {
          return { status: "defer", result: deferResult(progress, "artifact", "checked-out branch transition lacks lineage authority") };
        }
        this.checkoutBranchPlan = await addTimedMs(opts.chainTimings, "refTxnExclusiveMs", () => {
          if (opts.manualResolution) {
            const planInput: PlanManualBranchTransitionInput = {
              repoDir: opts.ctx.repoDir,
              binding: opts.branchProtocol!.binding,
              ref: currentRef,
              physicalBeforeOid: oldOid ?? null,
              afterOid: newOid ?? null,
              logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[currentRef] ?? null,
              extraTransactionLines: pinLines,
              reserveHead: false,
            };
            if (checkoutBranchReflogFingerprint) planInput.expectedReflogFingerprint = checkoutBranchReflogFingerprint;
            return planManualBranchTransition(planInput);
          }
          if (!oldOid) throw new Error("automatic branch transition requires a physical predecessor");
          const planInput: PlanBranchTransitionInput = {
            repoDir: opts.ctx.repoDir,
            binding: opts.branchProtocol!.binding,
            ref: currentRef,
            beforeOid: oldOid,
            afterOid: newOid ?? null,
            logicalBaseOid: opts.branchProtocol!.logicalBaseRefs[currentRef] ?? null,
            extraTransactionLines: pinLines,
            reserveHead: false,
          };
          if (checkoutBranchReflogFingerprint) planInput.expectedReflogFingerprint = checkoutBranchReflogFingerprint;
          return planBranchTransition(planInput);
        });
        checkoutBranchPlanIsPostHead = incomingHeadRef !== liveBefore.currentRef;
        if (checkoutBranchPlanIsPostHead) postHeadExtraTransactionLines.push(...this.checkoutBranchPlan.lines);
        else extraTransactionLines.push(...this.checkoutBranchPlan.lines);
        if (newOid) expectedRefs[liveBefore.currentRef] = newOid;
      }
    }
    const head: CheckoutPlan["head"] = incomingHeadRef
      ? liveBefore.currentRef
        ? { kind: "symbolic", newTarget: incomingHeadRef, oldTarget: liveBefore.currentRef }
        : { kind: "symbolic", newTarget: incomingHeadRef, oldOid: liveBefore.currentTip }
      : { kind: "detached", newOid: opts.incoming.head.trim(), oldOid: liveBefore.currentTip! };
    if (incomingHeadRef && incomingHeadRef !== liveBefore.currentRef) {
      const targetOid = effective.refs[incomingHeadRef];
      if (!targetOid) return { status: "defer", result: deferResult(progress, "unsupported", "incoming HEAD branch is filtered or absent") };
      reserveRef(incomingHeadRef, targetOid);
    }

    const postProgress: FollowProgress = {
      ...progress,
      appliedRefs: { ...progress.appliedRefs },
      branchWitnesses: { ...(progress.branchWitnesses ?? {}) },
      branchLockedProofs: { ...(progress.branchLockedProofs ?? {}) },
      manualBranchTerminals: { ...(progress.manualBranchTerminals ?? {}) },
    };
    if (this.checkoutBranchPlan) {
      postProgress.appliedRefs[this.checkoutBranchPlan.ref] = this.checkoutBranchPlan.partial;
      postProgress.branchWitnesses![this.checkoutBranchPlan.ref] = this.checkoutBranchPlan.witness;
    }
    for (const [ref, witness] of Object.entries(postProgress.safeRefWitnesses ?? {})) reserveRef(ref, witness.afterOid);
    for (const [ref, witness] of Object.entries(postProgress.branchWitnesses ?? {})) {
      if (ref === this.checkoutBranchPlan?.ref) continue;
      reserveRef(ref, witness.kind === "present" ? witness.nextOid : null);
      reserveRef(witness.artifactRef, witness.artifactOid);
      if (witness.kind === "present") {
        if (witness.priorOid) reserveRef(basePresentKeepRef(opts.branchProtocol!.binding, ref, witness.episode, "prior"), witness.priorOid);
        reserveRef(basePresentKeepRef(opts.branchProtocol!.binding, ref, witness.episode, "next"), witness.nextOid);
      }
    }
    if (incomingHeadRef && effective.refs[incomingHeadRef] && incomingHeadRef !== this.checkoutBranchPlan?.ref) {
      postProgress.appliedRefs[incomingHeadRef] = { kind: "direct", oid: effective.refs[incomingHeadRef]! };
    }
    if (liveBefore.currentRef && liveBefore.currentRef !== this.checkoutBranchPlan?.ref) {
      const currentRef = liveBefore.currentRef;
      const candidate = effective.refs[currentRef];
      const noOpTerminal = opts.manualResolution !== undefined && liveBefore.refs[currentRef] === candidate;
      if (candidate && (incomingHeadRef === currentRef || noOpTerminal)) {
        postProgress.appliedRefs[currentRef] = { kind: "direct", oid: candidate };
      }
      if (candidate && noOpTerminal && !postProgress.branchWitnesses?.[currentRef]) {
        reserveRef(currentRef, candidate);
        postProgress.manualBranchTerminals![currentRef] = { beforeBaseOid: opts.base?.refs[currentRef] ?? null, afterOid: candidate };
      }
    }

    const old = {
      headContent: liveBefore.headContent,
      indexPresent: liveBefore.indexPresent,
      opState: Object.fromEntries(Object.keys(liveBefore.opState).map((rel) => [rel, true as const])),
    } as CheckoutJournal<FollowIntended>["old"];
    if (liveBefore.currentRef) {
      old.currentRefName = liveBefore.currentRef;
      old.currentRefOid = liveBefore.currentTip;
    }
    const expectedNew: CheckoutJournal<FollowIntended>["expectedNew"] = {
      opState: sectionOpState(opts.incoming),
      refs: expectedRefs,
      head: expectedHead(opts.incoming),
    };
    if (this.checkoutBranchPlan) expectedNew.branchInverses = [{
      ref: this.checkoutBranchPlan.ref,
      beforeOid: this.checkoutBranchPlan.beforeOid,
      afterOid: this.checkoutBranchPlan.afterOid,
      lines: this.checkoutBranchPlan.inverseLines,
    }];
    if (refReservations.length) expectedNew.reservedRefs = Object.fromEntries(refReservations.map(({ ref, expectedOid }) => [ref, expectedOid]));
    this.journal = {
      journalId: `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
      phase: "intent",
      incomingKey: gitIncomingKey(opts.incoming),
      incomingSection: opts.incoming,
      old,
      expectedNew,
      binding: opts.binding,
      createdFresh: false,
      intended: await opts.makeIntended(copyProgress(postProgress)),
    };
    if (opts.manualResolution) this.journal.episode = { verb: "take-theirs", snapshotId: opts.manualResolution.snapshotId };
    await addTimedMs(opts.chainTimings, "journalMs", () => writeCheckoutJournal(opts.workspaceRoot, opts.relPath, this.journal!, {
      indexPath: path.join(opts.ctx.gitDir, "index"),
      gitDir: opts.ctx.gitDir,
    }));
    opts.crashAt?.("after-journal-write");

    let boundaryFailure: BoundaryFailure | undefined;
    const boundaryInput: CheckoutBoundaryInput = {
      opts,
      liveBefore,
      effectiveRefs: effective.refs,
      checkoutRoots,
      first,
      staged,
      progress,
      refProgress,
      checkoutBranchPlanIsPostHead,
    };
    if (incomingHeadRef) boundaryInput.incomingHeadRef = incomingHeadRef;
    if (input.baseProjection !== undefined) boundaryInput.baseProjection = input.baseProjection;
    if (origHeadPreservation) boundaryInput.origHeadPreservation = origHeadPreservation;
    if (input.selfRootWitness) boundaryInput.selfRootWitness = input.selfRootWitness;
    if (this.checkoutBranchPlan) boundaryInput.checkoutBranchPlan = this.checkoutBranchPlan;
    if (checkoutBranchReflogFingerprint) boundaryInput.checkoutBranchReflogFingerprint = checkoutBranchReflogFingerprint;

    const checkoutPlan: CheckoutPlan = {
      refUpdates,
      postHeadRefUpdates,
      postHeadExtraTransactionLines,
      refReservations,
      head,
      extraTransactionLines,
      plannedGraphRoots: [...this.roots, ...(origHeadPreservation?.recoveryOid ? [origHeadPreservation.recoveryOid] : [])],
      opState: staged.opState,
    };
    if (staged.candidateIndex) checkoutPlan.candidateIndexPath = staged.candidateIndex;
    else checkoutPlan.removeIndex = true;
    if (checkoutBranchPlanIsPostHead && this.checkoutBranchPlan?.reflogMessage) checkoutPlan.postHeadReflogMessage = this.checkoutBranchPlan.reflogMessage;
    if (!checkoutBranchPlanIsPostHead && this.checkoutBranchPlan?.reflogMessage) checkoutPlan.reflogMessage = this.checkoutBranchPlan.reflogMessage;
    if (origHeadPreservation) checkoutPlan.origHeadLock = {
      journalId: this.journal.journalId,
      expectedOldBytes: origHeadPreservation.expectedOldBytes,
    };
    if (origHeadPreservation?.malformedRawBytes) checkoutPlan.malformedOrigHeadPreserved = true;

    const commitOptions: CommitCheckoutOptions<FollowIntended> = {
      capabilityProbe: opts.capabilityProbe,
      connectivityProof: opts.connectivityProof,
      capabilitySupported: true,
      journal: { workspaceRoot: opts.workspaceRoot, relPath: opts.relPath, value: this.journal },
      mutationBoundary: opts.mutationBoundary,
      secondProof: async () => {
        const proof = await proveCheckoutBoundary(boundaryInput);
        if (proof.failure) boundaryFailure = proof.failure;
        if (proof.lockedProof) checkoutBranchLockedProof = proof.lockedProof;
        return proof.safe;
      },
      crashAt: (point) => opts.crashAt?.(point),
      chainTimings: opts.chainTimings,
    };
    if (checkoutBranchPlanIsPostHead && this.checkoutBranchPlan) {
      commitOptions.postHeadSecondProof = async () => {
        const proof = await provePostHeadBoundary(boundaryInput);
        if (proof.failure) boundaryFailure = proof.failure;
        if (proof.lockedProof) checkoutBranchLockedProof = proof.lockedProof;
        return proof.safe;
      };
    }
    const result = await commitCheckout(opts.ctx, checkoutPlan, commitOptions);
    if (result.status !== "committed") {
      if (result.status !== "defer" || !result.journalIntact) {
        await addTimedMs(opts.chainTimings, "journalMs", () => clearCheckoutJournal(opts.workspaceRoot, opts.relPath));
      }
      // The typed code is the ONLY carrier of the connectivity verdict; the
      // human reason stays a log string (design 278 M0).
      // ONE fact, one variable: the code this site is willing to act on. A
      // boundary failure authors its own blockers, so a code that cannot reach a
      // blocker must not steer the reason either — the receipt, the blocker, and
      // the reason all read the same value.
      const mintedCode = result.status === "defer" && !boundaryFailure ? result.code : undefined;
      const reason: GitDeferralReason = result.status === "unsupported" ? "unsupported"
        : /became busy/.test(result.reason) ? "git-busy"
        : mintedCode === "connectivity-unproven" ? "artifact"
        // Design 280: a proof that could not run tells the same self-healing
        // story as one that ran and failed, and carries no code, so it is not
        // skip-eligible, latches no attempt, and is offered no repair.
        : result.reason === CONNECTIVITY_PROOF_UNAVAILABLE ? "artifact"
        : result.reason === ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY ? "local-operation"
        : boundaryFailure?.reason ?? "other";
      const detail = result.reason === ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY
        ? "operation state differs at ORIG_HEAD"
        : boundaryFailure?.detail ?? result.reason;
      const receipt: CheckoutCommitReceipt = {
        status: "defer",
        result: {
          status: "defer",
          reason,
          detail,
          ...progress,
          blockers: [
            ...progress.blockers,
            ...(boundaryFailure?.blockers ?? [blockerForReason(reason, "boundary", result.reason, mintedCode)]),
          ],
        },
      };
      if (mintedCode) receipt.code = mintedCode;
      return receipt;
    }
    if (this.checkoutBranchPlan) {
      if (!checkoutBranchLockedProof) throw new Error("checkout branch committed without locked proof receipt");
      postProgress.branchLockedProofs![this.checkoutBranchPlan.ref] = checkoutBranchLockedProof;
      this.journal.intended = await opts.makeIntended(copyProgress(postProgress));
      await addTimedMs(opts.chainTimings, "journalMs", () => updateCheckoutJournal(opts.workspaceRoot, opts.relPath, this.journal!));
    }
    await addTimedMs(opts.chainTimings, "journalMs", () => markCheckoutJournalPublished(opts.workspaceRoot, opts.relPath));
    if (opts.manualResolution && effective.refs["refs/stash"]) await ensureStashReflog(opts.ctx.repoDir, effective.refs["refs/stash"]!);
    opts.crashAt?.("after-published-flip");
    const receipt: CheckoutCommitReceipt = { status: "committed", progress: postProgress };
    if (origHeadPreservation) receipt.origHeadPreservation = origHeadPreservation;
    return receipt;
  }
}
