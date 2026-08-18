/**
 * Projecting a SyncState's repository records.
 *
 * The model file next door declares the durable shapes; this one owns the two
 * directions between them: folding a state's legacy parallel maps into complete
 * records, and rebuilding a state from a record set. Every state write goes
 * through this pair, so the fold rules have exactly one home.
 */
import { MAX_GIT_REPOS } from "../engine/index.js";
import { jsonCounter, type JsonValue } from "../json.js";
import { sanitizeGitSectionForPersistence } from "./sync-git/config-sync.js";
import { carryRepoBaseProof, composeRepoBase, recordOriginLineage } from "./sync-git/base-composer.js";
import { adoptLegacyManifestRepoBase } from "./state-plane/base-proof.js";
import type { RepoRecord, RepoRecordsByPath, StateSavePacket, SyncState } from "./sync-state-model.js";

export const MAX_LEGACY_GIT_SIDECAR_REPOS = MAX_GIT_REPOS;

/** An accepted save of ANY kind advances stateRevision, so revision equality
 * proves nothing interleaved since the composer's load. */
export function elisionExpectationDrifted(packet: StateSavePacket, live: SyncState): boolean {
  const expected = packet.elisionExpectation;
  if (expected === undefined) return false;
  return expectedStateNonce(live) !== expected.nonce
    || normalizeStateCounter(live.stateRevision) !== expected.stateRevision;
}

/** <=1.7.18 persisted deferred keep-mine intents. They have no meaning under
 * synchronous confirmation, so every state reader sees them stripped — not
 * merely callers that later project records through repoRecordsForState(). */
export function stripObsoleteResolutionIntents(state: SyncState): SyncState {
  if (!state.repoRecords) return state;
  let changed = false;
  const repoRecords: Record<string, RepoRecord> = {};
  for (const [relPath, record] of Object.entries(state.repoRecords)) {
    if (Object.prototype.hasOwnProperty.call(record, "resolutionIntent")) {
      const { resolutionIntent: _obsoleteResolutionIntent, ...normalized } = record as RepoRecord & { resolutionIntent?: unknown };
      repoRecords[relPath] = normalized;
      changed = true;
    } else {
      repoRecords[relPath] = record;
    }
  }
  return changed ? { ...state, repoRecords } : state;
}

/** `value` is either a typed counter this process already holds, or the same
 * field as decoded from a durable JSON record — never anything else. */
export function normalizeStateCounter(value: JsonValue | undefined): number {
  return jsonCounter(value) ?? 0;
}

/** Every git repo key this state knows of: the last-synced manifest, whatever the
 * remote has queued, and every durable per-repo record. This is the set status,
 * doctor and the design-212 scope projection classify. */
export function knownRepoKeys(state: SyncState): string[] {
  return [
    ...Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    ...Object.keys(state.gitPendingRemote ?? {}),
    ...Object.keys(repoRecordsForState(state)),
  ];
}

/** Fold the legacy parallel maps into complete records. Every later state write
 * reconstructs gitRepos and sidecars solely from this returned record set. */
export function repoRecordsForState(state: SyncState): RepoRecordsByPath {
  const legacyDeferrals = state.repoRecords === undefined
    ? Object.fromEntries(Object.entries(state.gitDeferrals ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_LEGACY_GIT_SIDECAR_REPOS))
    : {};
  const legacyPartial = state.repoRecords === undefined
    ? Object.fromEntries(Object.entries(state.gitPartial ?? {}).sort(([a], [b]) => a.localeCompare(b)).slice(0, MAX_LEGACY_GIT_SIDECAR_REPOS))
    : {};
  const keys = new Set([
    ...Object.keys(state.repoRecords ?? {}),
    ...Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    ...Object.keys(state.gitPendingRemote ?? {}),
    ...Object.keys(state.gitReposRemoved ?? {}),
    ...Object.keys(state.gitNeedsResolution ?? {}),
    ...Object.keys(legacyDeferrals),
    ...Object.keys(legacyPartial),
  ]);
  const records: RepoRecordsByPath = {};
  for (const relPath of keys) {
    const saved = state.repoRecords?.[relPath];
    if (saved) {
      // Once a record exists it is authoritative, including property absence.
      // Falling back to a legacy map here would resurrect an observed deletion.
      // loadRawState strips <=1.7.18 resolutionIntent fields. Keep this projection
      // defensive for callers that construct a SyncState directly in memory.
      const { resolutionIntent: _obsoleteResolutionIntent, ...normalizedSaved } = saved as RepoRecord & { resolutionIntent?: unknown };
      records[relPath] = { ...normalizedSaved, repoGen: normalizeStateCounter(saved.repoGen), sourceSeq: normalizeStateCounter(saved.sourceSeq) };
      continue;
    }
    // Folded in member order; an absent legacy map contributes an ABSENT member.
    const folded: RepoRecord = {
      repoGen: 0,
      sourceSeq: normalizeStateCounter(state.lastSyncedSequence),
      ...adoptLegacyManifestRepoBase(state.lastSyncedManifest.gitRepos?.[relPath]),
    };
    const pending = state.gitPendingRemote?.[relPath];
    if (pending !== undefined) folded.pending = pending;
    const removedKey = state.gitReposRemoved?.[relPath];
    if (removedKey !== undefined) folded.removedKey = removedKey;
    const resolutionKey = state.gitNeedsResolution?.[relPath];
    if (resolutionKey !== undefined) folded.resolutionKey = resolutionKey;
    if (legacyDeferrals[relPath] !== undefined) folded.deferrals = legacyDeferrals[relPath];
    if (legacyPartial[relPath] !== undefined) folded.partial = legacyPartial[relPath];
    records[relPath] = folded;
  }
  return records;
}

export const expectedStateNonce = (state: Pick<SyncState, "stateNonce">): string => state.stateNonce ?? "legacy";

function mapFromRecords<T>(records: Record<string, RepoRecord>, pick: (record: RepoRecord) => T | undefined): Record<string, T> | undefined {
  const result: Record<string, T> = {};
  for (const [relPath, record] of Object.entries(records)) {
    const value = pick(record);
    if (value !== undefined) result[relPath] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

export function stateFromRepoRecords(state: SyncState, records: Record<string, RepoRecord>): SyncState {
  const normalized: Record<string, RepoRecord> = Object.fromEntries(Object.entries(records).map(([relPath, record]) => {
    const sanitizedBase = record.base === undefined ? undefined : sanitizeGitSectionForPersistence(record.base);
    const sanitizedPending = record.pending === undefined ? undefined : sanitizeGitSectionForPersistence(record.pending);
    const lineageHash = recordOriginLineage(record.branchBaseOrigins) ?? "legacy-untrusted";
    const proof = carryRepoBaseProof(lineageHash);
    const composed = composeRepoBase(
      { base: sanitizedBase, branchBaseOrigins: record.branchBaseOrigins },
      { base: sanitizedBase, branchBaseOrigins: record.branchBaseOrigins },
      proof.authority,
      proof.lockedProof,
    );
    const next = { ...record };
    if (composed.base === undefined) delete next.base; else next.base = composed.base;
    if (composed.branchBaseOrigins === undefined) delete next.branchBaseOrigins;
    else next.branchBaseOrigins = composed.branchBaseOrigins;
    if (sanitizedPending === undefined) delete next.pending; else next.pending = sanitizedPending;
    return [relPath, next];
  }));
  // Removal/suppression hides the repository from the last-synced projection
  // without destroying its non-authoritative BASE provenance anchor.
  const gitRepos = mapFromRecords(normalized, (record) =>
    record.repoAbsent !== true && record.removedKey === undefined ? record.base : undefined);
  return {
    ...state,
    lastSyncedManifest: { ...state.lastSyncedManifest, gitRepos },
    gitReposRemoved: mapFromRecords(normalized, (record) => record.removedKey),
    gitNeedsResolution: mapFromRecords(normalized, (record) => record.resolutionKey),
    gitPendingRemote: mapFromRecords(normalized, (record) => record.pending),
    // A transactional record supersedes the legacy sidecar maps. legacyState()
    // deliberately reconstructs them after dropping repoRecords.
    gitDeferrals: undefined,
    gitPartial: undefined,
    repoRecords: normalized,
  };
}
