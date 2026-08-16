import type { GitRefScope, GitSection } from "../../engine/index.js";
import { DEFERRAL_LANES, type GitDeferralReason, type GitDeferrals, type RepoRecord } from "../config.js";
import type { GitDeferralUpdates } from "../sync-state.js";
import {
  composeRepoBase,
  type ComposeRepoBaseResult,
  type RepoBaseLockedProof,
  type RepoBaseProof,
  type RepoBaseValue,
} from "./base-composer.js";
import { firstReason, type FollowProgress } from "./follow.js";
import { blockersAfterComposer, gitOwnershipNoEscalateEnabled, ownershipBlockersArePerRefOnly } from "./held-blockers.js";

/**
 * The exact repository and wire section a follow transition is bound to. The
 * incoming key is part of the identity because every witness and locked proof
 * this composer mints is stamped with it: an authority can only ever describe
 * the section its execution was planned from.
 */
export interface FollowTransitionIdentity {
  readonly relPath: string;
  readonly incomingKey: string;
  readonly repoKind: RepoBaseLockedProof["repoKind"];
  readonly effectiveRefScope: GitRefScope;
}

/**
 * Bounded projection of a settled `SettleStandingBranchProof` result. Only the
 * lineage this composer stamps into every authority and the crash-reconstructed
 * absence set it is allowed to publish are carried; the settled protocol's
 * artifacts, attestations, and logical BASE stay with their own owner.
 */
export interface StandingBranchProofReceipt {
  readonly relPath: string;
  readonly incomingKey: string;
  readonly lineageHash: string;
  readonly repositoryIdentityHash: string;
  readonly unmaterializedAbsenceRefs: ReadonlySet<string>;
}

/**
 * The complete, immutable outcome of one follow execution. `progress` is the
 * terminal ref/index/op-state, held refs, blockers, witnesses, and locked
 * proofs the executor reached — never a partial view reconstructed here.
 */
export type FollowExecutionReceipt = {
  readonly relPath: string;
  readonly incomingKey: string;
  readonly progress: FollowProgress;
} & (
  | { readonly outcome: "followed" }
  | { readonly outcome: "deferred"; readonly deferralReason: GitDeferralReason }
);

/**
 * Everything the composer may observe besides its two receipts. The BASE
 * composition inputs are built by the caller so design-130's persisted-BASE
 * write allowlist keeps counting genuine BASE construction at its one site.
 */
export interface FollowCommitInput {
  readonly identity: FollowTransitionIdentity;
  /** The wire section this follow was planned from. */
  readonly incoming: GitSection;
  readonly baseComposition: {
    readonly prior: RepoBaseValue;
    readonly candidate: RepoBaseValue;
  };
}

export type FollowPartialDirective =
  /** Persist the execution's own ref/config progress. */
  | { readonly kind: "from-progress"; readonly checkoutPending: boolean }
  /** Git is settled but the config lane is not; retain a config-only partial. */
  | { readonly kind: "config-carry" }
  | { readonly kind: "clear" };

export type FollowDeferralDirective =
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly reason: GitDeferralReason };

export interface FollowBaseAdvance {
  readonly proof: RepoBaseProof;
  /** Named for the applied-manifest slot, not `base`, so the design-130 BASE
   * write allowlist keeps flagging only genuine persisted BASE writes. */
  readonly appliedSection: GitSection | null;
  /** Absent leaves any standing branch provenance exactly as it is. */
  readonly branchOrigins: RepoRecord["branchBaseOrigins"] | undefined;
}

/**
 * The complete repo transition one follow execution produces. Every field is a
 * final value or an explicit retain, never a delta an executor has to interpret.
 */
export interface FollowRepoTransition {
  readonly identity: FollowTransitionIdentity;
  /** Absent leaves the standing proof and applied BASE untouched. */
  readonly baseAdvance: FollowBaseAdvance | undefined;
  readonly pending: GitSection | null;
  readonly partial: FollowPartialDirective;
  readonly deferral: FollowDeferralDirective;
  readonly heldAttempt: "clear" | "retain";
  readonly indexProjection: string | null | "retain";
  readonly resolutionMemory: "clear" | "retain";
  readonly removalMemory: "clear" | "retain";
  readonly publishJournal: boolean;
  readonly result: "applied" | "deferred";
}

export interface FollowAuthorityComposition {
  readonly proof: RepoBaseProof;
  readonly composed: ComposeRepoBaseResult;
  /** Physical holds or a refused BASE advance; either keeps the section pending. */
  readonly held: boolean;
  readonly ownershipOnly: boolean;
}

export class FollowRepoTransitionIdentityMismatch extends Error {
  constructor(expected: { relPath: string; incomingKey: string }, actual: { relPath: string; incomingKey: string }) {
    super(`follow transition bound to ${expected.relPath}@${expected.incomingKey} cannot compose ${actual.relPath}@${actual.incomingKey}`);
    this.name = "FollowRepoTransitionIdentityMismatch";
  }
}

function assertBound(
  expected: { relPath: string; incomingKey: string },
  actual: { relPath: string; incomingKey: string },
): void {
  if (expected.relPath !== actual.relPath || expected.incomingKey !== actual.incomingKey) {
    throw new FollowRepoTransitionIdentityMismatch(expected, actual);
  }
}

/** The one pull-ref-transaction proof constructor of the follow path. */
export function followBaseProof(
  identity: FollowTransitionIdentity,
  proof: StandingBranchProofReceipt,
  progress: FollowProgress,
  checkoutComplete: boolean,
): RepoBaseProof {
  assertBound(identity, proof);
  const branches: RepoBaseLockedProof["branches"] = { ...(progress.branchLockedProofs ?? {}) };
  const safeRefs: RepoBaseLockedProof["safeRefs"] = Object.fromEntries(Object.entries(progress.safeRefWitnesses ?? {}).map(([ref, witness]) => [ref, {
    liveOid: witness.afterOid,
    witness,
    ...(ref === "refs/stash" && witness.afterOid !== null ? { stashReflogReady: true } : {}),
  }]));
  return {
    authority: {
      kind: "pull-ref-transaction",
      lineageHash: proof.lineageHash,
      repositoryIdentityHash: proof.repositoryIdentityHash,
      incomingKey: identity.incomingKey,
      branchWitnesses: progress.branchWitnesses ?? {},
      safeRefWitnesses: progress.safeRefWitnesses ?? {},
    },
    lockedProof: {
      repoKind: identity.repoKind,
      effectiveRefScope: identity.effectiveRefScope,
      checkoutComplete,
      incomingKey: identity.incomingKey,
      branches,
      safeRefs,
    },
  };
}

/** Ranked hold reason for an escalating apply-lane deferral. */
export function followHeldDeferralReason(
  progress: Pick<FollowProgress, "blockers" | "heldRefs">,
): GitDeferralReason {
  const classified = firstReason(new Set<GitDeferralReason>(
    progress.blockers
      .filter((blocker) => blocker.provenance === "ref-plane")
      .map((blocker) => blocker.reason),
  ));
  if (classified) return classified;
  const persisted = Object.values(progress.heldRefs);
  return persisted.includes("local-commits") ? "local-commits"
    : persisted.includes("local-stash") ? "local-stash"
    : "worktree-ownership";
}

function ownershipOnlyDisposition(
  progress: Pick<FollowProgress, "heldRefs" | "blockers">,
  composed: ComposeRepoBaseResult,
  checkoutComplete: boolean,
): boolean {
  const heldReasons = Object.values(progress.heldRefs);
  if (heldReasons.length === 0 || heldReasons.some((reason) => reason !== "ownership")) return false;
  return ownershipBlockersArePerRefOnly(blockersAfterComposer({
    classification: progress.blockers,
    disposition: composed.disposition,
    holds: composed.holds,
    checkoutComplete,
  }));
}

/**
 * Mints the proof and composes the BASE it authorizes. Shared by the pre-commit
 * intended record, the held-attempt binding, and the terminal transition so all
 * three can never disagree about what one execution proved.
 */
export function composeFollowAuthority(
  input: FollowCommitInput,
  proof: StandingBranchProofReceipt,
  progress: FollowProgress,
  checkoutComplete: boolean,
): FollowAuthorityComposition {
  const baseProof = followBaseProof(input.identity, proof, progress, checkoutComplete);
  const composed = composeRepoBase(
    input.baseComposition.prior,
    input.baseComposition.candidate,
    baseProof.authority,
    baseProof.lockedProof,
  );
  return {
    proof: baseProof,
    composed,
    held: Object.keys(progress.heldRefs).length > 0 || composed.disposition === "pending",
    ownershipOnly: ownershipOnlyDisposition(progress, composed, baseProof.lockedProof.checkoutComplete),
  };
}

/** Durable lanes as they stand after this pull's in-flight lane transition. */
export function mergeFollowDeferralLanes(
  durable: GitDeferrals | undefined,
  transition: GitDeferralUpdates | null | undefined,
): GitDeferrals {
  const effective: GitDeferrals = { ...(durable ?? {}) };
  if (transition === null) {
    for (const lane of DEFERRAL_LANES) delete effective[lane];
  } else if (transition) {
    for (const lane of DEFERRAL_LANES) {
      if (transition[lane] === null) delete effective[lane];
      else if (transition[lane]) effective[lane] = transition[lane]!;
    }
  }
  return effective;
}

function advanceFrom(authority: FollowAuthorityComposition): FollowBaseAdvance {
  return {
    proof: authority.proof,
    appliedSection: authority.composed.base ?? null,
    branchOrigins: authority.composed.branchBaseOrigins,
  };
}

/**
 * The crash-reconstructed owning absences a deferred checkout may still
 * publish. A deferred follow otherwise keeps serialized BASE unchanged even
 * when earlier ref phases made physical progress; an owning A must consume its
 * stale BASE member once so the §126 veto does not recur forever. Unrelated
 * pre-checkout progress and every safe ref are narrowed out.
 */
function reconstructedAbsenceProgress(
  progress: FollowProgress,
  absenceRefs: ReadonlySet<string>,
): FollowProgress | undefined {
  const reconstructed = [...absenceRefs].filter((ref) => progress.appliedRefs[ref]?.kind === "absent"
    && progress.branchWitnesses?.[ref]?.kind === "absent"
    && progress.branchLockedProofs?.[ref] !== undefined);
  if (reconstructed.length === 0) return undefined;
  const only = new Set(reconstructed);
  return {
    appliedRefs: Object.fromEntries(Object.entries(progress.appliedRefs).filter(([ref]) => only.has(ref))),
    heldRefs: progress.heldRefs,
    blockers: progress.blockers,
    configApplied: false,
    branchWitnesses: Object.fromEntries(Object.entries(progress.branchWitnesses ?? {}).filter(([ref]) => only.has(ref))),
    branchLockedProofs: Object.fromEntries(Object.entries(progress.branchLockedProofs ?? {}).filter(([ref]) => only.has(ref))),
    safeRefWitnesses: {},
  };
}

/**
 * The pure authority composer of the follow path: one complete execution
 * receipt plus one settled standing-branch proof produce one repo transition.
 * It performs no Git and no state I/O, and it never reads anything the two
 * receipts and the bound input did not carry.
 */
export function composeFollowRepoTransition(
  input: FollowCommitInput,
  execution: FollowExecutionReceipt,
  proof: StandingBranchProofReceipt,
): FollowRepoTransition {
  assertBound(input.identity, execution);
  assertBound(input.identity, proof);
  const progress = execution.progress;

  if (execution.outcome === "deferred") {
    const absence = reconstructedAbsenceProgress(progress, proof.unmaterializedAbsenceRefs);
    return {
      identity: input.identity,
      baseAdvance: absence === undefined
        ? undefined
        : advanceFrom(composeFollowAuthority(input, proof, absence, false)),
      pending: input.incoming,
      partial: { kind: "from-progress", checkoutPending: true },
      deferral: { kind: "set", reason: execution.deferralReason },
      heldAttempt: "retain",
      indexProjection: "retain",
      resolutionMemory: "retain",
      removalMemory: "retain",
      publishJournal: false,
      result: "deferred",
    };
  }

  const authority = composeFollowAuthority(input, proof, progress, true);
  const heldRefCount = Object.keys(progress.heldRefs).length;
  const settled: Pick<FollowRepoTransition, "identity" | "baseAdvance" | "indexProjection" | "resolutionMemory" | "removalMemory" | "publishJournal" | "result"> = {
    identity: input.identity,
    baseAdvance: advanceFrom(authority),
    indexProjection: progress.incomingIndexProjection ?? null,
    resolutionMemory: "clear",
    removalMemory: "clear",
    publishJournal: true,
    result: "applied",
  };
  if (authority.held) {
    return {
      ...settled,
      pending: input.incoming,
      partial: { kind: "from-progress", checkoutPending: false },
      deferral: gitOwnershipNoEscalateEnabled() && authority.ownershipOnly
        ? { kind: "clear" }
        : { kind: "set", reason: heldRefCount ? followHeldDeferralReason(progress) : "artifact" },
      heldAttempt: "retain",
    };
  }
  return {
    ...settled,
    pending: null,
    partial: progress.configApplied ? { kind: "clear" } : { kind: "config-carry" },
    deferral: { kind: "clear" },
    heldAttempt: "clear",
  };
}
