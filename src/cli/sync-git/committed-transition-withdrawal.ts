/**
 * How a committed received-Git transition SURRENDERS a repository: the two
 * withdrawals a commit may author, and the apply deferral each one records.
 *
 * Both live here rather than with the commit itself because they share one
 * rule — a repository that loses its claim keeps the prior durable BASE, keeps
 * its incoming section pending, and says why in the durable lane. Neither ever
 * fails the pull.
 */
import {
  applyStateSavePacket,
  expectedStateNonce,
  loadRawState,
  repoRecordsForState,
  type RepoRecord,
  type RepoRecordInput,
  type SyncState,
} from "../config.js";
import type { GitPullOutcome } from "./apply.js";
import { carryRepoBaseProof, recordOriginLineage, type RepoBaseProof } from "./base-composer.js";
import { gitIncomingKey, nextDeferral } from "./shared.js";

/** Drop a repository's partial crash marker: an unprovable marker must never
 * survive the CAS. */
export function dropPartial(rel: string, outcome: GitPullOutcome): void {
  outcome.partial = { ...(outcome.partial ?? {}), [rel]: null };
}

/** Why a composed BASE was withdrawn at the CAS: the reader could not read, or a
 * concurrent writer moved a ref inside the CAS window. */
export type CarriedBaseWithdrawalReason = "ref-read-unreadable" | "git-busy";

/** A ref database that has become unreadable is evidence about the reader, not
 * about the transition: the composed BASE is withdrawn in favour of the prior
 * durable one, the incoming section returns to pending, and the proof is kept
 * only so its artifacts still settle. This never fails the pull. */
export function carryUnreadableRefDatabase(
  rel: string,
  proof: RepoBaseProof,
  prior: RepoRecord | undefined,
  outcome: GitPullOutcome,
  reason: CarriedBaseWithdrawalReason = "ref-read-unreadable",
): void {
  const candidate = outcome.gitRepos?.[rel];
  if (candidate) {
    outcome.gitPendingRemote = { ...(outcome.gitPendingRemote ?? {}), [rel]: candidate };
  }
  if (prior?.base) outcome.gitRepos = { ...(outcome.gitRepos ?? {}), [rel]: prior.base };
  else if (outcome.gitRepos) delete outcome.gitRepos[rel];
  if (prior?.branchBaseOrigins) {
    outcome.branchBaseOrigins = { ...(outcome.branchBaseOrigins ?? {}), [rel]: prior.branchBaseOrigins };
  } else if (outcome.branchBaseOrigins) {
    delete outcome.branchBaseOrigins[rel];
  }
  dropPartial(rel, outcome);
  outcome.artifactSettlementProofs = {
    ...(outcome.artifactSettlementProofs ?? {}),
    [rel]: proof,
  };
  const retainedLineage = recordOriginLineage(prior?.branchBaseOrigins) ?? "legacy-untrusted";
  outcome.repoProofs = {
    ...(outcome.repoProofs ?? {}),
    [rel]: carryRepoBaseProof(retainedLineage),
  };
  const existingTransition = outcome.deferrals?.[rel];
  const existing = existingTransition === null
    ? undefined
    : existingTransition?.apply ?? prior?.deferrals?.apply;
  const now = new Date().toISOString();
  const transition = existingTransition && existingTransition !== null ? { ...existingTransition } : {};
  transition.apply = nextDeferral(
    "apply",
    existing,
    reason,
    now,
    candidate ? gitIncomingKey(candidate) : undefined,
  );
  outcome.deferrals = {
    ...(outcome.deferrals ?? {}),
    [rel]: transition,
  };
}

/** Curated, path-free text for a post-CAS settlement refusal. The hold reason
 * itself stringifies arbitrary errors and may name filesystem paths. */
const POST_CAS_SETTLEMENT_DETAIL = "the standing present-artifact could not be settled after its BASE was committed";

/**
 * A settlement refusal after the batch CAS is a repository-scoped hold, not a
 * pull abort: it writes that repository's apply deferral as its own one-repo
 * carry-proof packet, so the rebind CAS at the end of the loop sees fresh state.
 * A rejected packet leaves the deferral unwritten and the next pull re-derives it.
 */
export async function deferPostCasSettlementRefusal(input: {
  root: string;
  state: SyncState;
  relPath: string;
}): Promise<SyncState> {
  const record = repoRecordsForState(input.state)[input.relPath];
  if (!record) return input.state;
  const { repoGen, ...withoutGeneration } = record;
  const deferrals = { ...(record.deferrals ?? {}) };
  deferrals.apply = nextDeferral(
    "apply",
    deferrals.apply,
    "artifact",
    new Date().toISOString(),
    record.pending ? gitIncomingKey(record.pending) : undefined,
    undefined,
    POST_CAS_SETTLEMENT_DETAIL,
  );
  const newRecord: RepoRecordInput = { ...withoutGeneration, deferrals };
  const saved = await applyStateSavePacket(input.root, {
    expectedStream: input.state.stream,
    expectedNonce: expectedStateNonce(input.state),
    sourceGlobalSeq: input.state.lastSyncedSequence,
    repos: [{
      relPath: input.relPath,
      expectedRepoGen: repoGen,
      newRecord,
      baseProof: carryRepoBaseProof(recordOriginLineage(record.branchBaseOrigins) ?? "legacy-untrusted"),
    }],
  });
  if (saved.status !== "accepted") return input.state;
  return await loadRawState(input.root) ?? input.state;
}

