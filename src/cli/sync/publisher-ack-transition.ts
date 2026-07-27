import type { GitSection, Manifest } from "../../engine/index.js";
import type { GitDeferrals, GitResolutionPublicationReceipt, GlobalManifestMeta } from "../config.js";
import { gitIncomingKey } from "../sync-git.js";
import { gitBaseAfterCommit } from "../sync-git/plan.js";
import {
  carriedLineageProof,
  recordOriginLineage,
  type BranchBaseOrigin,
  type RepoBaseProof,
} from "../sync-git/base-composer.js";
import { orderedDeferralUpdates, type RepoStateValues } from "../sync-state.js";
import type { PublicationIdentity } from "./publish-candidate.js";

/**
 * The bounded projection of an executed Git capture that an acknowledgement may
 * read. It names no `GitPushPlan`, no `SyncState`, and no mutable output map:
 * everything here was already decided by the capture that this publication
 * carried onto the wire.
 */
export interface PublishedGitTransition {
  /** Candidate-bound receipts the accepted ACK retires (design 43 §7 [v5]). */
  readonly supersededPending: readonly string[];
  /** Keep-mine candidates whose directional report this publication authorized. */
  readonly resolvedPending: readonly string[];
  /** Privacy-safe section identity keys proven by the ACK-composer dry run. */
  readonly supersessionIdentityKeys?: Readonly<Record<string, { pending: string; candidate: string; composed: string }>>;
  readonly pending: Record<string, GitSection> | undefined;
  readonly removed: Record<string, string> | undefined;
  readonly resolutions: Record<string, string> | undefined;
  readonly repoAbsent: Record<string, true> | undefined;
  readonly packedRefsIdentity: RepoStateValues["packedRefsIdentity"];
  /** Plan-time physical/logical binding captured before publication, so a
   * post-commit path replacement cannot lend a section another repo's lineage. */
  readonly publisherAckBindings?: Readonly<Record<string, {
    lineageHash: string;
    repositoryIdentityHash: string;
    repoKind: "dir" | "pointer";
  }>>;
  readonly absentBranchProofs?: Readonly<Record<string, Record<string, { priorOid: string }>>>;
  readonly authoredCfgHashByRepo: Record<string, string>;
}

/** The publication whose acceptance is being acknowledged: the exact manifest
 *  that went onto the wire, the applied base its per-repo BASE advance is taken
 *  against, and the capture transition it published. */
export interface SealedPublishedCandidate {
  readonly identity: PublicationIdentity;
  readonly manifest: Manifest;
  /** `lastSyncedManifest.gitRepos`: what a still-pending repo's BASE holds at. */
  readonly appliedBaseGit: Record<string, GitSection> | undefined;
  readonly transition: PublishedGitTransition;
}

/** The remote's acceptance of exactly that publication. */
export interface AcceptedPublicationReceipt {
  readonly identity: PublicationIdentity;
  readonly sequence: number;
  readonly manifestMeta?: GlobalManifestMeta;
  /** Keep-mine publication authority armed for this POST. Its presence is what
   * makes an unpersisted acknowledgement recoverable rather than fatal. */
  readonly armed?: GitResolutionPublicationReceipt;
}

/** Every sidecar lane one acknowledgement transitions. Present lanes are total
 *  projections; this transition never writes a lane it did not derive. */
export type PublisherAckSidecarValues = Pick<
  RepoStateValues,
  | "bases"
  | "packedRefsIdentity"
  | "advertised"
  | "repoAbsent"
  | "pending"
  | "removed"
  | "resolutions"
  | "partial"
  | "attempt"
  | "resolutionReceipt"
  | "deferrals"
>;

export interface PublisherAckStateWrite {
  readonly acceptedSequence: number;
  readonly globalManifest: Manifest;
  readonly manifestMeta?: GlobalManifestMeta;
  readonly observedRepos: readonly string[];
  readonly values: PublisherAckSidecarValues;
  readonly repoProofs: Record<string, RepoBaseProof>;
  readonly authoredCfgHashByRepo: Record<string, string>;
}

/** Durable state, as this transition is allowed to see it: the rows whose
 *  lineage and deferral lanes it carries, the observation set, one CAS write,
 *  and the bounded publication lines it emits. */
export interface RepoTransitionPort {
  readonly records: Readonly<Record<string, {
    branchBaseOrigins?: Readonly<Record<string, BranchBaseOrigin>>;
    deferrals?: GitDeferrals;
  }>>;
  /** Every repository this write observes, including equal and absent outcomes. */
  observedRepos(values: PublisherAckSidecarValues): readonly string[];
  /** Design 174 §4.2: the bounded post-ACK publication lines. Advisory. */
  announce(line: string): void;
  save(write: PublisherAckStateWrite): Promise<void>;
}

/** Why an accepted publication has no durable local acknowledgement yet. */
export interface StatePersistenceFailure {
  /** The keep-mine authority armed for the accepted POST, when there was one. */
  readonly armed?: GitResolutionPublicationReceipt;
  readonly cause: unknown;
}

export interface PublisherAcknowledgementReceipt {
  readonly identity: PublicationIdentity;
  readonly transitionId: string;
  readonly sequence: number;
  readonly observedRepos: readonly string[];
  readonly settledPending: readonly string[];
}

export type PublisherAckOutcome =
  | { readonly kind: "acknowledged"; readonly receipt: PublisherAcknowledgementReceipt }
  | {
      readonly kind: "accepted-state-pending";
      readonly publication: AcceptedPublicationReceipt;
      readonly transitionId: string;
      readonly reason: StatePersistenceFailure;
    };

/** A candidate and a receipt that do not name the same publication. */
export class PublisherAckIdentityError extends Error {
  readonly name = "PublisherAckIdentityError";
}

function assertSameIdentity(candidate: PublicationIdentity, accepted: PublicationIdentity): void {
  for (const field of ["acceptedSequence", "capturePlanId", "observedSequence"] as const) {
    if (candidate[field] !== accepted[field]) {
      throw new PublisherAckIdentityError(
        `acknowledgement ${field} ${String(accepted[field])} does not name the published candidate's ${String(candidate[field])}`,
      );
    }
  }
}

/**
 * Acknowledge one accepted publication: retire the pending receipts it settled,
 * advance the persisted Git BASE and advertised lane for exactly the sections it
 * carried, mint publisher-ACK authority for each acknowledged section, and
 * persist all of it in the single CAS write bound to the accepted sequence.
 *
 * This is the only place a publisher-ACK BASE is minted. It plans nothing, sends
 * nothing, and never reports a BASE the durable write did not install.
 */
export async function acknowledgePublishedGitTransitions(
  candidate: SealedPublishedCandidate,
  accepted: AcceptedPublicationReceipt,
  state: RepoTransitionPort,
): Promise<PublisherAckOutcome> {
  assertSameIdentity(candidate.identity, accepted.identity);
  const committed = candidate.manifest;
  const plan = candidate.transition;
  const acceptedSequence = accepted.sequence;
  const transitionId = `${candidate.identity.capturePlanId}@${acceptedSequence}`;

  // Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
  // remote's own unapplied truth — the saved git BASE keeps the OLD entry (or none) so the
  // next pull still sees remote != base and retries the apply (see gitBaseAfterCommit).
  const supersededPending = new Set(plan.supersededPending);
  const resolvedPending = new Set(plan.resolvedPending);
  const settledPending = new Set([...supersededPending, ...resolvedPending]);
  // Design 174 §4.2: the one bounded supersession line — emitted ONLY here, after
  // the accepted commit, so it never claims a supersession a pre-ACK failure undid.
  for (const relPath of [...supersededPending].sort()) {
    const keys = plan.supersessionIdentityKeys?.[relPath];
    state.announce(
      `git-sync superseded pending ${relPath}${keys ? ` [P=${keys.pending} candidate=${keys.candidate} composed=${keys.composed}]` : ""}: local history subsumes the unapplied remote section. rbox will publish the local history instead.`,
    );
  }
  for (const relPath of [...resolvedPending].sort()) {
    state.announce(
      `git-sync published keep-mine ${relPath}: local Git state is now the acknowledged remote truth`,
    );
  }
  const pendingAfterAck = { ...(plan.pending ?? {}) };
  for (const relPath of settledPending) delete pendingAfterAck[relPath];
  const stateGit = gitBaseAfterCommit(committed.gitRepos, pendingAfterAck, candidate.appliedBaseGit);
  const advertised: Record<string, GitSection | null> = {};
  const repoProofs: Record<string, RepoBaseProof> = {};
  const ackRecords = state.records;
  const ackPartial = Object.fromEntries([...settledPending].map((relPath) => [relPath, null]));
  const ackAttempt = Object.fromEntries([...settledPending].map((relPath) => [relPath, null]));
  const ackDeferrals: Record<string, NonNullable<RepoStateValues["deferrals"]>[string]> = {};
  for (const relPath of settledPending) {
    const ordered = orderedDeferralUpdates(ackRecords[relPath]?.deferrals, { apply: null });
    if (ordered) ackDeferrals[relPath] = ordered;
  }
  const resolutionsAfterAck = { ...(plan.resolutions ?? {}) };
  for (const relPath of resolvedPending) delete resolutionsAfterAck[relPath];
  for (const relPath of new Set([
    ...Object.keys(ackRecords),
    ...Object.keys(committed.gitRepos ?? {}),
  ])) {
    const section = committed.gitRepos?.[relPath];
    advertised[relPath] = section ?? null;
    const binding = plan.publisherAckBindings?.[relPath];
    if (section && binding) repoProofs[relPath] = {
      authority: {
        kind: "publisher-ack",
        lineageHash: binding.lineageHash,
        repositoryIdentityHash: binding.repositoryIdentityHash,
        incomingKey: gitIncomingKey(section),
        sourceSeq: acceptedSequence,
        advertisedRefs: section.refs,
        ...(plan.absentBranchProofs?.[relPath]
          ? { absentBranchProofs: plan.absentBranchProofs[relPath] }
          : {}),
      },
      lockedProof: {
        repoKind: binding.repoKind,
        effectiveRefScope: section.refScope,
        checkoutComplete: true,
        branches: {},
        safeRefs: {},
      },
    };
    else {
      repoProofs[relPath] = carriedLineageProof(
        recordOriginLineage(ackRecords[relPath]?.branchBaseOrigins),
        binding?.lineageHash,
      );
    }
  }
  const values: PublisherAckSidecarValues = {
    bases: stateGit,
    packedRefsIdentity: plan.packedRefsIdentity,
    advertised,
    repoAbsent: plan.repoAbsent ?? {},
    pending: pendingAfterAck,
    removed: plan.removed,
    resolutions: resolutionsAfterAck,
    partial: ackPartial,
    attempt: ackAttempt,
    resolutionReceipt: Object.fromEntries([...resolvedPending].map((relPath) => [relPath, null])),
    deferrals: ackDeferrals,
  };
  const observedRepos = state.observedRepos(values);
  try {
    await state.save({
      acceptedSequence,
      globalManifest: committed,
      ...(accepted.manifestMeta ? { manifestMeta: accepted.manifestMeta } : {}),
      observedRepos,
      values,
      repoProofs,
      authoredCfgHashByRepo: plan.authoredCfgHashByRepo,
    });
  } catch (error) {
    return {
      kind: "accepted-state-pending",
      publication: accepted,
      transitionId,
      reason: { ...(accepted.armed ? { armed: accepted.armed } : {}), cause: error },
    };
  }
  return {
    kind: "acknowledged",
    receipt: {
      identity: candidate.identity,
      transitionId,
      sequence: acceptedSequence,
      observedRepos,
      settledPending: [...settledPending].sort(),
    },
  };
}
