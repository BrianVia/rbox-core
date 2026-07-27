import {
  diffManifests,
  type CaseFoldCollisionGroup,
  type IgnoreMatcher,
  type Manifest,
} from "../../engine/index.js";
import { projectLocalManifest } from "../local-file-projection.js";
import type { RepoStateValues } from "../sync-state.js";
import type {
  CaptureObservationReceipt,
  GitCaptureObservation,
} from "../sync-git/git-capture-observation.js";
import type { GitPushPlan } from "../sync-git/plan.js";
import type { GitResolutionRider } from "../sync-git/resolution-intent.js";
import { MassDeleteGuardError, pushMassDeleteTrips } from "./policy.js";
import type { PublishedGitTransition } from "./publisher-ack-transition.js";

/**
 * The publish candidate's own lineage: the accepted revision every decision is
 * taken against, and the manifest that revision applied. This is carry-only
 * authority — preparing a candidate never mints or advances a BASE.
 */
export interface PublishLineageSnapshot {
  /** `lastSyncedSequence`: the last pull that applied completely. */
  readonly acceptedSequence: number;
  /** `lastSyncedManifest`: the file+git plane that sequence installed. */
  readonly appliedBase: Manifest;
}

/** The local file plane offered for publication, plus its collision authority. */
export interface LocalObservation {
  readonly manifest: Manifest;
  /** Shared forward-only ignore carry + git discovery matcher. */
  readonly matcher: IgnoreMatcher;
  /** A 422 reupload retries the already-projected candidate verbatim: it is
   * projected exactly once per fresh input or 409/epoch rescan. */
  readonly projected: boolean;
  readonly caseCollisions: readonly CaseFoldCollisionGroup[];
  readonly authority: "authoritative" | "preserve";
  /**
   * Durably adopt the one-time projection. Ordered exactly where the projection
   * happens so a later refusal can never un-observe a collision the caller has
   * already been told about.
   */
  recordProjection(projection: {
    manifest: Manifest;
    caseCollisions: CaseFoldCollisionGroup[];
  }): Promise<void>;
}

/** Every decision input this transition may read. No environment, no config. */
export interface PublishPolicy {
  readonly purgeIgnored: boolean;
  /** §3.6.3 chain repair: publish as the PIN's child and republish git verbatim
   * — no files-first defer and no zero-commit short circuit. */
  readonly repairing: boolean;
  readonly syncGit: boolean;
  readonly filesFirstEnabled: boolean;
  /** Design 108 §3.2/§3.4: a 409/epoch/starvation latch fired earlier in the run. */
  readonly filesFirstAborted: boolean;
  readonly streamMismatch: boolean;
  /** [v2, M5] per-relPath 422 recapture set. */
  readonly forceGitRecapture: ReadonlySet<string>;
  readonly resolution?: GitResolutionRider;
  readonly allowMassDelete: boolean;
  readonly massDeleteHint?: string;
  readonly now?: () => Date;
  /** Safety-event notification for the mass-delete refusal. Advisory only. */
  onMassDeleteRefused?(): void;
}

/** The Git capture effect this candidate requests, minted once per attempt. */
export interface GitCaptureEffectPlan {
  /** Identity the executor's receipt must echo. */
  readonly planId: string;
  readonly forceGitRecapture: ReadonlySet<string>;
  readonly filesFirstDefer: boolean;
  readonly resolution?: GitResolutionRider;
}

/** What the capture executor returns, bound to the plan it executed. */
export interface GitCaptureExecutionReceipt {
  readonly planId: string;
  readonly plan: GitPushPlan;
}

/** The commit-free sidecar carry a zero-commit candidate still owes. */
export interface NoOpBaseCarry {
  /** The capture this carry is bound to — its ACK bindings are the lineage of
   * last resort for a repository with no durable origin. */
  readonly receipt: GitCaptureExecutionReceipt;
  readonly acceptedSequence: number;
  readonly values: Pick<
    RepoStateValues,
    "bases" | "packedRefsIdentity" | "repoAbsent" | "pending" | "removed" | "resolutions"
  >;
}

/**
 * Every Git-plane effect this transition orders. `execute` is the ONLY member
 * permitted to mutate a repository; the rest observe, persist sidecar lanes, or
 * report. Preparing a candidate never encrypts, uploads, POSTs, or advances BASE.
 */
export interface GitCapturePort {
  execute(plan: GitCaptureEffectPlan): Promise<GitCaptureExecutionReceipt>;
  /** Advisory daemon observer for repos this plan deferred as `git-busy`. */
  notifyBusyDeferred(relPaths: readonly string[]): void;
  /** Durable pre-publication observation (RecordGitCaptureObservation). */
  observe(observation: GitCaptureObservation): Promise<CaptureObservationReceipt>;
  /** Phase counts and plan stats for the surrounding push report. */
  reportCapturePlan(receipt: GitCaptureExecutionReceipt): void;
  /** §9: prune local-only git bookkeeping without burning a commit. */
  carryBaseOnNoOp(carry: NoOpBaseCarry): Promise<void>;
  /** §10 forensic line, emitted only past the zero-commit short circuit. */
  logPublicationLine(receipt: GitCaptureExecutionReceipt): void;
}

/** What binds a sealed candidate to the exact effects it was planned from. */
export interface PublicationIdentity {
  readonly acceptedSequence: number;
  readonly capturePlanId: string;
  readonly observedSequence: number;
}

/**
 * The bounded publication projection of the executed capture. The sealed plan
 * exposes this instead of the whole `GitPushPlan`: a publication consumer needs
 * the disposition, the files-first flag, and the transition packet the accepted
 * acknowledgement replays — never the planner's working surface.
 */
export interface SealedGitPublication {
  readonly capturePlanId: string;
  /** Explicit disposition for the foreground resolver. Never inferred. */
  readonly resolution?: NonNullable<GitPushPlan["resolution"]>;
  /** Design 108 §3.1: git capture was deferred AND a repo exists to attach. */
  readonly filesFirstDeferred: boolean;
  readonly transition: PublishedGitTransition;
}

function sealedGitPublication(receipt: GitCaptureExecutionReceipt): SealedGitPublication {
  const plan = receipt.plan;
  return {
    capturePlanId: receipt.planId,
    ...(plan.resolution ? { resolution: plan.resolution } : {}),
    filesFirstDeferred: plan.filesFirstDeferred === true,
    transition: {
      supersededPending: plan.supersededPending,
      resolvedPending: plan.resolvedPending ?? [],
      ...(plan.supersessionIdentityKeys ? { supersessionIdentityKeys: plan.supersessionIdentityKeys } : {}),
      pending: plan.gitPendingRemote,
      removed: plan.gitReposRemoved,
      resolutions: plan.gitNeedsResolution,
      repoAbsent: plan.repoAbsent,
      packedRefsIdentity: plan.packedRefsIdentity,
      ...(plan.publisherAckBindings ? { publisherAckBindings: plan.publisherAckBindings } : {}),
      ...(plan.absentBranchProofs ? { absentBranchProofs: plan.absentBranchProofs } : {}),
      authoredCfgHashByRepo: plan.authoredCfgHashByRepo,
    },
  };
}

interface SealedPlanBase {
  readonly identity: PublicationIdentity;
  /** The file plane to publish, with this capture's sections attached. */
  readonly candidate: Manifest;
  readonly publication: SealedGitPublication;
  readonly observationReceipt: CaptureObservationReceipt;
}

export type SealedPushDecisionPlan =
  | (SealedPlanBase & { readonly admission: "no-op" })
  | (SealedPlanBase & { readonly admission: "publish"; readonly gitUnchanged: boolean });

/** A candidate whose plan, receipt, and lineage do not name each other. */
export class PublishCandidateSealError extends Error {
  readonly name = "PublishCandidateSealError";
}

let capturePlanCounter = 0;

export function cloneCollisionGroups(
  groups: readonly CaseFoldCollisionGroup[],
): CaseFoldCollisionGroup[] {
  return groups.map((group) => ({ paths: [...group.paths] }));
}

function mergeCollisionGroups(
  previous: readonly CaseFoldCollisionGroup[],
  discovered: readonly CaseFoldCollisionGroup[],
): CaseFoldCollisionGroup[] {
  const groups = new Map<string, CaseFoldCollisionGroup>();
  for (const group of [...previous, ...discovered]) {
    const paths = [...new Set(group.paths)].sort();
    groups.set(paths.join("\0"), { paths });
  }
  return [...groups.values()].sort((a, b) => {
    const ak = a.paths.join("\0");
    const bk = b.paths.join("\0");
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

function assertNoUnevaluatedPurgeDeletes(matcher: IgnoreMatcher, deleted: string[]): void {
  for (const path of deleted) {
    const repo = matcher.unevaluatedGitRepoForPath?.(path);
    if (repo !== undefined) {
      throw new Error(
        `refusing purge: cannot evaluate tracked files for git repo ${repo} (first affected path ${path}). ` +
          `Fix that repo's .git/index and retry.`
      );
    }
  }
}

/**
 * Seal one publication candidate: project the local file plane, admit or refuse
 * it, execute exactly one Git capture effect, durably observe that capture, and
 * bind the result to a single {@link PublicationIdentity}. The returned plan is
 * either admitted for publication or a zero-commit no-op that has already paid
 * its commit-free sidecar carry.
 *
 * This transition never encrypts, uploads, POSTs, or advances BASE.
 */
export async function preparePublishCandidate(
  snapshot: PublishLineageSnapshot,
  local: LocalObservation,
  capture: GitCapturePort,
  policy: PublishPolicy,
): Promise<SealedPushDecisionPlan> {
  const appliedBase = snapshot.appliedBase;
  let candidate = local.manifest;

  if (!local.projected) {
    const projected = projectLocalManifest(candidate, appliedBase, local.matcher, policy.purgeIgnored);
    const caseCollisions = local.authority === "authoritative"
      ? cloneCollisionGroups(projected.caseCollisions)
      : mergeCollisionGroups(local.caseCollisions, projected.caseCollisions);
    candidate = projected.manifest;
    await local.recordProjection({ manifest: candidate, caseCollisions });
  }

  if (policy.purgeIgnored) {
    assertNoUnevaluatedPurgeDeletes(local.matcher, diffManifests(appliedBase, candidate).deleted);
  }

  // Design 108 §3.2: the file-plane diff drives BOTH the files-must-diff guard and
  // the no-op / mass-delete checks. Computed once, before any capture, so the
  // files-first decision precedes Git capture.
  const filesDiff = diffManifests(appliedBase, candidate);
  const fileDiffNonEmpty =
    filesDiff.added.length > 0 || filesDiff.changed.length > 0 || filesDiff.deleted.length > 0;

  // Files-first defers Git capture ONLY on a genuine genesis first-init with a real
  // file diff (§3.1/§3.4). Any false leg ⇒ ordinary git-inclusive planning.
  const filesFirstDefer =
    policy.filesFirstEnabled &&
    !policy.repairing &&
    policy.syncGit &&
    !policy.filesFirstAborted &&
    snapshot.acceptedSequence === 0 &&
    !policy.streamMismatch &&
    fileDiffNonEmpty;

  const effectPlan: GitCaptureEffectPlan = {
    planId: `capture-${++capturePlanCounter}`,
    forceGitRecapture: policy.forceGitRecapture,
    filesFirstDefer,
    ...(policy.resolution ? { resolution: policy.resolution } : {}),
  };
  const captureReceipt = await capture.execute(effectPlan);
  if (captureReceipt.planId !== effectPlan.planId) {
    throw new PublishCandidateSealError(
      `capture receipt ${captureReceipt.planId} does not name the executed plan ${effectPlan.planId}`,
    );
  }
  const plan = captureReceipt.plan;

  const busyRepos = Object.entries(plan.captureDeferrals)
    .filter(([, reason]) => reason === "git-busy")
    .map(([relPath]) => relPath)
    .sort();
  capture.notifyBusyDeferred(busyRepos);

  const observationReceipt = await capture.observe({
    observedAt: (policy.now?.() ?? new Date()).toISOString(),
    captureObserved: plan.captureObserved,
    captureDeferrals: plan.captureDeferrals,
    configObserved: plan.configObserved,
    configDeferrals: plan.configDeferrals,
    protectedPending: plan.protectedPending,
    packedRefsIdentity: plan.packedRefsIdentity,
    ackLineageOf: (relPath) => plan.publisherAckBindings?.[relPath]?.lineageHash,
    changedFilePaths: () => [
      ...filesDiff.added.map((fileEntry) => fileEntry.path),
      ...filesDiff.changed.map((fileEntry) => fileEntry.path),
      ...filesDiff.deleted,
    ],
  });
  if (observationReceipt.acceptedSequence !== snapshot.acceptedSequence) {
    throw new PublishCandidateSealError(
      `capture observation bound revision ${observationReceipt.acceptedSequence}, not the accepted ${snapshot.acceptedSequence}`,
    );
  }
  capture.reportCapturePlan(captureReceipt);

  // Schema is stamped once, at commit — deriving it here too would be a second
  // copy of the rule.
  candidate = { ...candidate, gitRepos: plan.gitRepos };

  const identity: PublicationIdentity = {
    acceptedSequence: snapshot.acceptedSequence,
    capturePlanId: effectPlan.planId,
    observedSequence: observationReceipt.acceptedSequence,
  };

  // The file plane is unchanged by capture, so the diff above is authoritative.
  const gitUnchanged = !plan.changed;
  if (!policy.repairing && !fileDiffNonEmpty && gitUnchanged) {
    // No-op (files AND git identity match base). LOCAL-ONLY git bookkeeping may
    // still have moved — deleting a leftover .git is usually EXACTLY a no-op push,
    // yet §9 requires its removal memory to be pruned then, or the stale memory
    // suppresses a later legitimate re-add at that path.
    if (policy.syncGit) {
      await capture.carryBaseOnNoOp({
        receipt: captureReceipt,
        acceptedSequence: snapshot.acceptedSequence,
        values: {
          bases: appliedBase.gitRepos,
          packedRefsIdentity: plan.packedRefsIdentity,
          repoAbsent: plan.repoAbsent ?? {},
          pending: plan.gitPendingRemote,
          removed: plan.gitReposRemoved,
          resolutions: plan.gitNeedsResolution,
        },
      });
    }
    return { admission: "no-op", identity, candidate, publication: sealedGitPublication(captureReceipt), observationReceipt };
  }

  // §10 forensic line — only when git-sync did something beyond a steady carry.
  if (policy.syncGit && (plan.captured.length || plan.deferred.length || plan.removed.length)) {
    capture.logPublicationLine(captureReceipt);
  }

  // Push-side mass-delete breaker (design 108): compute the intended deletions on
  // the PRE-UPLOAD candidate and refuse before any encrypt/upload/commit work.
  // Deferral only carries base entries forward, so the pre-upload candidate and the
  // post-defer committed manifest have an identical DELETE count.
  const pushDeletes = filesDiff.deleted.length;
  if (!policy.allowMassDelete && pushMassDeleteTrips(pushDeletes, appliedBase.files.length)) {
    policy.onMassDeleteRefused?.();
    throw new MassDeleteGuardError("push",
      `push would delete ${pushDeletes} of ${appliedBase.files.length} tracked files — refusing (mass-delete guard). ` +
        `If this deletion is intentional, run \`${policy.massDeleteHint ?? "rbox push --allow-mass-delete"}\` ` +
        `(or set RBOX_ALLOW_MASS_DELETE=1) to publish it once.`
    );
  }

  return { admission: "publish", identity, candidate, publication: sealedGitPublication(captureReceipt), observationReceipt, gitUnchanged };
}
