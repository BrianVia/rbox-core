import type { GitDeferralReason, GitDeferrals } from "../config.js";
import { orderedDeferralUpdates, type GitDeferralUpdates, type OrderedGitDeferralUpdates, type RepoStateValues } from "../sync-state.js";
import { carriedLineageProof, type RepoBaseProof } from "./base-composer.js";
import { nextDeferral } from "./shared.js";

/** The durable BASE lineage this observation carries forward. It is carry-only
 * authority: recording an observation never mints or advances a BASE. */
export interface LineageSnapshot {
  /** Accepted global sequence the sidecar-only write is bound to. Because it is
   * the accepted revision and not a candidate, the write cannot claim a commit
   * that later fails. */
  acceptedSequence: number;
  originLineageOf(relPath: string): string | undefined;
}

/** The bounded projection of a push plan this transition may observe. */
export interface GitCaptureObservation {
  /** Single observation instant; every lane transition it writes shares it. */
  observedAt: string;
  captureObserved: readonly string[];
  captureDeferrals: Readonly<Record<string, GitDeferralReason>>;
  configObserved: readonly string[];
  configDeferrals: Readonly<Record<string, GitDeferralReason>>;
  /** Repositories whose entire record is immutable before an accepted ACK. */
  protectedPending: readonly string[];
  packedRefsIdentity: RepoStateValues["packedRefsIdentity"];
  /** Plan-time publisher ACK lineage, used only when no durable origin exists. */
  ackLineageOf(relPath: string): string | undefined;
  /** File-plane paths this push observed changing, for apply-lane intersection.
   * A thunk because no repository with a standing apply episode is the common
   * case, and materializing a whole file diff for it would be wasted work. */
  changedFilePaths(): readonly string[];
}

/** Sidecar lanes the observation write carries forward unchanged. */
export interface CarriedSidecarLanes {
  bases: RepoStateValues["bases"];
  pending: RepoStateValues["pending"];
  removed: RepoStateValues["removed"];
  resolutions: RepoStateValues["resolutions"];
}

export interface CaptureObservationSidecarValues extends CarriedSidecarLanes {
  packedRefsIdentity: RepoStateValues["packedRefsIdentity"];
  deferrals: Record<string, OrderedGitDeferralUpdates>;
}

export interface CaptureObservationWrite {
  acceptedSequence: number;
  observedRepos: readonly string[];
  values: CaptureObservationSidecarValues;
  repoProofs: Record<string, RepoBaseProof>;
}

/** Durable state, as this transition is allowed to see it: the deferral rows it
 * fences against, the lanes it carries, the change test, and one CAS write. */
export interface RepoObservationWritePort {
  readonly records: Readonly<Record<string, { deferrals?: GitDeferrals }>>;
  readonly carried: CarriedSidecarLanes;
  changedRepos(values: CaptureObservationSidecarValues): readonly string[];
  save(write: CaptureObservationWrite): Promise<void>;
}

export interface CaptureObservationReceipt {
  kind: "written" | "no-change";
  acceptedSequence: number;
  observedRepos: readonly string[];
  deferralUpdates: Readonly<Record<string, OrderedGitDeferralUpdates>>;
}

function subtreeIntersects(relPath: string, filePaths: readonly string[]): boolean {
  return filePaths.some((filePath) =>
    relPath === "." || filePath === relPath || filePath.startsWith(`${relPath}/`));
}

/**
 * A standing apply episode is also a warning that the checkout metadata may
 * describe older working bytes. Once this push observes a file-plane change
 * anywhere in that repo subtree, retain the marker monotonically until the
 * apply episode itself clears. This is sender-local state only; it never enters
 * the manifest or changes the apply lane's retry timestamp.
 */
function markBytesChanged(
  port: RepoObservationWritePort,
  observation: GitCaptureObservation,
  protectedPending: ReadonlySet<string>,
  updates: Record<string, OrderedGitDeferralUpdates>,
): void {
  const candidates = Object.entries(port.records).filter(([relPath, record]) => {
    if (protectedPending.has(relPath)) return false;
    const apply = record.deferrals?.apply;
    return apply !== undefined && apply.bytesChanged !== true;
  });
  if (candidates.length === 0) return;
  const changedFilePaths = observation.changedFilePaths();
  for (const [relPath, record] of candidates) {
    const apply = record.deferrals!.apply!;
    if (!subtreeIntersects(relPath, changedFilePaths)) continue;
    const ordered = orderedDeferralUpdates(record.deferrals, {
      apply: { ...apply, bytesChanged: true },
    });
    if (ordered?.apply) updates[relPath] = { ...(updates[relPath] ?? {}), apply: ordered.apply };
  }
}

/**
 * Record the durable pre-publication observation of capture/config deferrals,
 * packed-ref identity, and apply-lane file-byte intersection. Visibility is
 * durable as soon as planning settles, so this write carries the accepted
 * sequence and no candidate commit.
 */
export async function recordGitCaptureObservation(
  port: RepoObservationWritePort,
  lineage: LineageSnapshot,
  observation: GitCaptureObservation,
): Promise<CaptureObservationReceipt> {
  const protectedPending = new Set(observation.protectedPending);
  const deferrals: Record<string, OrderedGitDeferralUpdates> = {};
  for (const rel of observation.captureObserved) {
    if (protectedPending.has(rel)) continue;
    const current = port.records[rel]?.deferrals;
    const lanes: GitDeferralUpdates = {};
    const captureReason = observation.captureDeferrals[rel];
    if (captureReason) {
      lanes.capture = nextDeferral("capture", current?.capture, captureReason, observation.observedAt);
    } else if (current?.capture) lanes.capture = null;
    if (observation.configObserved.includes(rel)) {
      const configReason = observation.configDeferrals[rel];
      if (configReason) {
        lanes.config = nextDeferral("config", current?.config, configReason, observation.observedAt);
      } else if (current?.config) lanes.config = null;
    }
    const ordered = orderedDeferralUpdates(current, lanes);
    if (ordered !== undefined) deferrals[rel] = ordered;
  }
  markBytesChanged(port, observation, protectedPending, deferrals);

  const values: CaptureObservationSidecarValues = {
    bases: port.carried.bases,
    packedRefsIdentity: observation.packedRefsIdentity,
    pending: port.carried.pending,
    removed: port.carried.removed,
    resolutions: port.carried.resolutions,
    deferrals,
  };
  const observedRepos = port.changedRepos(values);
  if (observedRepos.length === 0) {
    return { kind: "no-change", acceptedSequence: lineage.acceptedSequence, observedRepos, deferralUpdates: deferrals };
  }
  const repoProofs = Object.fromEntries(observedRepos.map((relPath) => [
    relPath,
    carriedLineageProof(lineage.originLineageOf(relPath), observation.ackLineageOf(relPath)),
  ]));
  await port.save({ acceptedSequence: lineage.acceptedSequence, observedRepos, values, repoProofs });
  return { kind: "written", acceptedSequence: lineage.acceptedSequence, observedRepos, deferralUpdates: deferrals };
}
