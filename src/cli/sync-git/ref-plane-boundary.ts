import path from "node:path";
import { receiverEquivalentCollisionNames } from "../../engine/index.js";
import { ownershipProofContext } from "./reachability.js";
import { branchesCheckedOutElsewhere } from "./git-state-apply.js";
import { addClassifyTimedMs, addTimedMs } from "./chain-timings.js";
import { readRefReflogFingerprint } from "./keep-pins.js";
import { readAllRefsStrict } from "./refs.js";
import { exists, headBranchOf, readHead, repoCtx } from "./git-state.js";
import type { GitDeferralReason } from "../config.js";
import type { LockedBranchProof } from "./base-composer.js";
import type { PlannedBranchTransition } from "./branch-transition.js";
import { firstReason, classifyCheckout, opStateDetailToken } from "./follow-classify.js";
import { checkoutJournalBinding } from "./follow-journal.js";
import { appliedTerminalOid, selectCheckoutSelfRootWitness, type CheckoutSelfRootWitness } from "./follow-ref-witness.js";
import { blockerForReason, type CheckoutClassification, type FollowOptions, type FollowProgress, type LiveMetadata, type StagedIncoming } from "./follow-types.js";
import { readLive } from "./follow-live.js";
import type { OrigHeadPreservation } from "./orig-head.js";
import type { RefPlaneProgress } from "./ref-plane-publication.js";

export type BoundaryFailure = Pick<CheckoutClassification, "safe" | "reason" | "detail" | "blockers">;

export interface CheckoutBoundaryInput {
  opts: FollowOptions;
  liveBefore: LiveMetadata;
  effectiveRefs: Record<string, string>;
  incomingHeadRef?: string;
  checkoutRoots: readonly string[];
  first: CheckoutClassification;
  staged: StagedIncoming;
  baseProjection?: string;
  origHeadPreservation?: OrigHeadPreservation;
  progress: FollowProgress;
  refProgress: RefPlaneProgress;
  selfRootWitness?: CheckoutSelfRootWitness;
  checkoutBranchPlan?: PlannedBranchTransition;
  checkoutBranchPlanIsPostHead: boolean;
  checkoutBranchReflogFingerprint?: string;
}

export interface CheckoutBoundaryResult {
  safe: boolean;
  failure?: BoundaryFailure;
  lockedProof?: LockedBranchProof;
}

function chooseFailure(current: BoundaryFailure | undefined, reason: GitDeferralReason, detail: string): BoundaryFailure {
  const chosen = firstReason(new Set([...(current?.reason ? [current.reason] : []), reason]));
  if (current && chosen !== reason) return current;
  return { safe: false, reason, detail, blockers: [blockerForReason(reason, "boundary", detail)] };
}

function lockedProof(input: CheckoutBoundaryInput, currentRef: boolean): LockedBranchProof | undefined {
  const plan = input.checkoutBranchPlan;
  if (!plan) return undefined;
  const proof: LockedBranchProof = {
    liveOid: plan.afterOid,
    witness: plan.witness,
    artifactsClear: true,
    ownershipStable: true,
    reflogStable: true,
    currentRef,
    siblingOwned: false,
  };
  if (plan.witness.kind === "present") proof.reflogEpisode = plan.witness.episode;
  return proof;
}

export async function proveCheckoutBoundary(input: CheckoutBoundaryInput): Promise<CheckoutBoundaryResult> {
  const { opts } = input;
  let failure: BoundaryFailure | undefined;
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
      if (!(await opts.manualResolution.secondProof(input.refProgress.authoredRefChanges))) {
        failure = chooseFailure(failure, "other", "confirmed snapshot changed at checkout boundary");
        return { safe: false, failure };
      }
    } catch {
      failure = chooseFailure(failure, "unreadable", "confirmed snapshot could not be revalidated at checkout boundary");
      return { safe: false, failure };
    }
  }
  const proof = await addClassifyTimedMs(opts.chainTimings, () => classifyCheckout({
    opts,
    live,
    incomingProjection: input.staged.incomingIndexProjection,
    baseProjection: input.baseProjection,
    roots: input.checkoutRoots,
    boundary: true,
    boundaryChanged: !sameIncarnation,
    tombstonePrunedThisCycle: input.progress.tombstonePrunedThisCycle === true,
    checkoutRefReason: input.refProgress.checkoutRefReason,
    checkoutRefDetail: input.refProgress.checkoutRefDetail,
    heldRefs: input.progress.heldRefs,
    ownershipContext: boundaryOwnershipContext,
  }));
  if (!proof.safe) failure = proof;
  if (!opts.manualResolution && (input.first.breadcrumbWaived || proof.breadcrumbMismatches.length > 0 || input.origHeadPreservation)) {
    const boundaryHasOrigHead = proof.breadcrumbMismatches.some((mismatch) => mismatch.rel === "ORIG_HEAD");
    if (!proof.breadcrumbWaived || boundaryHasOrigHead !== (input.origHeadPreservation !== undefined)) {
      if (proof.safe) {
        const rels = [...new Set([
          ...input.first.breadcrumbMismatches.map((mismatch) => mismatch.rel),
          ...proof.breadcrumbMismatches.map((mismatch) => mismatch.rel),
        ])];
        failure = chooseFailure(failure, "local-operation", `operation state differs at ${rels.map((rel) => opStateDetailToken(opts.ctx, rel)).join(", ")}`);
      }
      return { safe: false, failure };
    }
  }
  if (!sameIncarnation) {
    failure = chooseFailure(failure, "unreadable", "repository incarnation changed at checkout boundary");
    return { safe: false, failure };
  }
  if (!live) {
    failure = chooseFailure(failure, "unreadable", "git metadata became unreadable");
    return { safe: false, failure };
  }
  const boundaryOwned = await addTimedMs(opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(opts.ctx));
  if (input.selfRootWitness) {
    const boundaryAmbiguousRefs = new Set([
      ...input.refProgress.checkoutWitnessDisposition.ambiguousRefs,
      ...receiverEquivalentCollisionNames([
        ...Object.keys(input.effectiveRefs),
        ...Object.keys(live.refs),
        ...boundaryOwned.keys(),
      ]),
    ]);
    const boundaryWitness = selectCheckoutSelfRootWitness({
      currentTip: live.currentTip,
      effectiveIncomingRefs: input.effectiveRefs,
      receiverRefs: live.refs,
      heldRefs: input.refProgress.checkoutWitnessDisposition.heldRefs,
      forcedRefs: input.refProgress.checkoutWitnessDisposition.forcedRefs,
      ambiguousRefs: boundaryAmbiguousRefs,
      requiredRef: input.selfRootWitness.ref,
    });
    if (!boundaryWitness || boundaryWitness.oid !== input.selfRootWitness.oid) {
      failure = chooseFailure(failure, "local-commits", `checkout self-root witness changed at ${input.selfRootWitness.ref}`);
      return { safe: false, failure };
    }
  }
  for (const [ref, expected] of Object.entries(input.progress.appliedRefs)) {
    const terminal = appliedTerminalOid(expected);
    if (boundaryOwned.has(ref) && (input.liveBefore.refs[ref] ?? null) !== (terminal ?? null)) {
      failure = chooseFailure(failure, "worktree-ownership", `worktree ownership changed for ${ref}`);
      return { safe: false, failure };
    }
  }
  if (input.incomingHeadRef && boundaryOwned.has(input.incomingHeadRef)) {
    failure = chooseFailure(failure, "worktree-ownership", "incoming checkout branch became sibling-owned");
    return { safe: false, failure };
  }
  for (const bad of opts.ctx.kind === "dir" ? ["modules", "objects/info/alternates"] : ["objects/info/alternates"]) {
    const root = opts.ctx.kind === "dir" ? opts.ctx.gitDir : opts.ctx.commonDir;
    if (await exists(path.join(root, bad))) {
      failure = chooseFailure(failure, "unsupported", `repository structure changed at ${bad}`);
      return { safe: false, failure };
    }
  }
  for (const [ref, expected] of Object.entries(input.progress.appliedRefs)) {
    const terminal = appliedTerminalOid(expected);
    if (terminal !== undefined && (live.refs[ref] ?? null) !== terminal) {
      failure = chooseFailure(failure, "local-commits", `published ref changed at ${ref}`);
      return { safe: false, failure };
    }
  }
  for (const ref of Object.keys(input.progress.heldRefs)) {
    if (live.refs[ref] !== input.liveBefore.refs[ref]) {
      failure = chooseFailure(failure, "local-commits", `held ref changed at ${ref}`);
      return { safe: false, failure };
    }
  }
  if (input.checkoutBranchPlan && !input.checkoutBranchPlanIsPostHead && input.checkoutBranchReflogFingerprint) {
    const fingerprint = await addTimedMs(opts.chainTimings, "reflogMs", () =>
      readRefReflogFingerprint(opts.ctx.repoDir, input.checkoutBranchPlan!.ref));
    if (fingerprint.sha256 !== input.checkoutBranchReflogFingerprint) {
      failure = chooseFailure(failure, "local-commits", `branch reflog changed at ${input.checkoutBranchPlan.ref}`);
      return { safe: false, failure };
    }
  }
  return {
    safe: proof.safe,
    failure,
    lockedProof: input.checkoutBranchPlan && !input.checkoutBranchPlanIsPostHead
      ? lockedProof(input, input.incomingHeadRef === input.checkoutBranchPlan.ref)
      : undefined,
  };
}

export async function provePostHeadBoundary(input: CheckoutBoundaryInput): Promise<CheckoutBoundaryResult> {
  const plan = input.checkoutBranchPlan;
  if (!plan) return { safe: false };
  const [strict, owned, headContent] = await Promise.all([
    readAllRefsStrict(input.opts.ctx.repoDir),
    addTimedMs(input.opts.chainTimings, "ownershipMs", () => branchesCheckedOutElsewhere(input.opts.ctx)),
    readHead(input.opts.ctx),
  ]);
  if (strict.status === "unreadable") {
    const detail = `ref-read-unreadable: ${strict.marker}`;
    return { safe: false, failure: chooseFailure(undefined, "ref-read-unreadable", detail) };
  }
  if ((strict.refs[plan.ref] ?? null) !== plan.beforeOid
    || owned.has(plan.ref)
    || headBranchOf(headContent) === plan.ref) return { safe: false };
  if (input.checkoutBranchReflogFingerprint) {
    const fingerprint = await addTimedMs(input.opts.chainTimings, "reflogMs", () =>
      readRefReflogFingerprint(input.opts.ctx.repoDir, plan.ref));
    if (fingerprint.sha256 !== input.checkoutBranchReflogFingerprint) return { safe: false };
  }
  return { safe: true, lockedProof: lockedProof(input, false) };
}
