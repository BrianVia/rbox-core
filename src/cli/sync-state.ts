import type { GitSection, Manifest } from "../engine/index.js";
import type { ConfigStatToken } from "../engine/git/config-txn.js";
import {
  applyStateSavePacket,
  expectedStateNonce,
  loadRawState,
  repoRecordsForState,
  saveState,
  type FileOnlyManifest,
  type RepoRecord,
  type RepoRecordInput,
  type StateSavePacket,
  type SyncState,
} from "./config.js";

export interface RepoStateValues {
  bases?: Record<string, GitSection>;
  pending?: Record<string, GitSection>;
  removed?: Record<string, string>;
  resolutions?: Record<string, string>;
}

export interface StateSource {
  expectedStream: string;
  sourceGlobalSeq: number;
  /** File-only global truth. gitRepos is deliberately removed by fileOnlyManifest. */
  globalManifest?: Manifest;
  /** Every repo observed by the source, including equal and absent outcomes. */
  observedRepos: Iterable<string>;
  values: RepoStateValues;
  /** ACK-only authorship. Missing entries must not stamp unrelated repos. */
  authoredCfgHashByRepo?: Record<string, string>;
}

export interface ConfigApplyCompletion {
  pre: string;
  post: string;
  incoming: string;
  basePre?: string;
  postToken: ConfigStatToken;
}

export function completeConfigApply(record: RepoRecordInput, completion: ConfigApplyCompletion): RepoRecordInput {
  const ownsPre = completion.pre === record.cfgSynced || completion.pre === completion.basePre;
  const cfgSynced = ownsPre || completion.post === completion.incoming ? completion.post : record.cfgSynced;
  return {
    ...record,
    ...(cfgSynced === undefined ? {} : { cfgSynced }),
    cfgApplied: completion.incoming,
    cfgToken: completion.postToken,
  };
}

export function stampConfigAck(record: RepoRecordInput, authoredHash: string | undefined): RepoRecordInput {
  return authoredHash === undefined ? record : { ...record, cfgSynced: authoredHash };
}

export function fileOnlyManifest(manifest: Manifest): FileOnlyManifest {
  const { gitRepos: _gitRepos, ...filesAndMetadata } = manifest;
  return filesAndMetadata;
}

const inputRecord = (record: RepoRecord): RepoRecordInput => {
  const { repoGen: _repoGen, ...input } = record;
  return input;
};

function sourceRecord(source: StateSource, relPath: string, current: RepoRecord): RepoRecordInput {
  // A recompute from an older source retains the entire newer record. This is the
  // ordering half of the generation CAS: older pending/absence cannot regress a
  // newer success, while the transition still records that this path was observed.
  if (current.sourceSeq > source.sourceGlobalSeq) return inputRecord(current);
  return stampConfigAck({
    sourceSeq: source.sourceGlobalSeq,
    ...(source.values.bases?.[relPath] === undefined ? {} : { base: source.values.bases[relPath] }),
    ...(source.values.pending?.[relPath] === undefined ? {} : { pending: source.values.pending[relPath] }),
    ...(source.values.removed?.[relPath] === undefined ? {} : { removedKey: source.values.removed[relPath] }),
    ...(source.values.resolutions?.[relPath] === undefined ? {} : { resolutionKey: source.values.resolutions[relPath] }),
    ...(current.cfgSynced === undefined ? {} : { cfgSynced: current.cfgSynced }),
    ...(current.cfgApplied === undefined ? {} : { cfgApplied: current.cfgApplied }),
    ...(current.cfgToken === undefined ? {} : { cfgToken: current.cfgToken }),
    ...(current.cfgShape === undefined ? {} : { cfgShape: current.cfgShape }),
  }, source.authoredCfgHashByRepo?.[relPath]);
}

export function composeStateSavePacket(snapshot: SyncState, source: StateSource): StateSavePacket {
  const records = repoRecordsForState(snapshot);
  const repos = [...new Set(source.observedRepos)].sort().map((relPath) => {
    const current = records[relPath] ?? { repoGen: 0, sourceSeq: 0 };
    return {
      relPath,
      expectedRepoGen: current.repoGen,
      newRecord: sourceRecord(source, relPath, current),
    };
  });
  return {
    expectedStream: source.expectedStream,
    expectedNonce: expectedStateNonce(snapshot),
    sourceGlobalSeq: source.sourceGlobalSeq,
    // On recompute after a newer global landed, omit this stale global candidate.
    // Repo transitions above likewise retain records with a newer sourceSeq.
    ...(source.globalManifest === undefined || source.sourceGlobalSeq < snapshot.lastSyncedSequence
      ? {}
      : { global: { manifest: fileOnlyManifest(source.globalManifest) } }),
    repos,
  };
}

function legacyState(snapshot: SyncState, source: StateSource): SyncState {
  const packet = composeStateSavePacket(snapshot, source);
  const records = repoRecordsForState(snapshot);
  for (const transition of packet.repos) records[transition.relPath] = { ...transition.newRecord, repoGen: transition.expectedRepoGen + 1 };
  const bases: Record<string, GitSection> = {};
  const pending: Record<string, GitSection> = {};
  const removed: Record<string, string> = {};
  const resolutions: Record<string, string> = {};
  for (const [relPath, record] of Object.entries(records)) {
    if (record.base !== undefined) bases[relPath] = record.base;
    if (record.pending !== undefined) pending[relPath] = record.pending;
    if (record.removedKey !== undefined) removed[relPath] = record.removedKey;
    if (record.resolutionKey !== undefined) resolutions[relPath] = record.resolutionKey;
  }
  const manifest = packet.global?.manifest ?? snapshot.lastSyncedManifest;
  return {
    ...snapshot,
    lastSyncedSequence: packet.global ? source.sourceGlobalSeq : snapshot.lastSyncedSequence,
    lastSyncedManifest: { ...manifest, gitRepos: Object.keys(bases).length ? bases : undefined },
    gitPendingRemote: Object.keys(pending).length ? pending : undefined,
    gitReposRemoved: Object.keys(removed).length ? removed : undefined,
    gitNeedsResolution: Object.keys(resolutions).length ? resolutions : undefined,
    // link()-unsupported fallback intentionally has no lane fence/state.
    stateNonce: undefined,
    stateRevision: undefined,
    repoRecords: undefined,
  };
}

/** Save a source as one packet, recomputing immediately on generation/global CAS
 * rejection. Stream/nonce rejection is an incarnation change and never retries. */
export async function saveStateSource(
  root: string,
  initialSnapshot: SyncState,
  source: StateSource,
  options: { apply?: typeof applyStateSavePacket; allowLegacyStreamReplacement?: boolean } = {},
): Promise<SyncState> {
  const apply = options.apply ?? applyStateSavePacket;
  let snapshot = initialSnapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await apply(root, composeStateSavePacket(snapshot, source));
    if (result.status === "accepted") return result.state;
    if (result.status === "unsupported") {
      const next = legacyState(snapshot, source);
      await saveState(root, next);
      return next;
    }
    if (result.status === "busy") throw new Error(`sync state busy (${result.detail})`);
    if (result.status === "rejected" && result.reason === "stream" && options.allowLegacyStreamReplacement) {
      const next = legacyState(snapshot, source);
      await saveState(root, next);
      return next;
    }
    if (result.reason === "stream" || result.reason === "nonce" || result.reason === "owner-lost") {
      throw new Error(`sync state changed during operation (${result.reason})`);
    }
    snapshot = result.state;
  }
  throw new Error("sync state kept changing during save (3 recomputes exhausted)");
}

export function observedRepoKeys(state: SyncState, manifestGit?: Record<string, GitSection>, values: RepoStateValues = {}): string[] {
  return [...new Set([
    ...Object.keys(repoRecordsForState(state)),
    ...Object.keys(manifestGit ?? {}),
    ...Object.keys(values.bases ?? {}),
    ...Object.keys(values.pending ?? {}),
    ...Object.keys(values.removed ?? {}),
    ...Object.keys(values.resolutions ?? {}),
  ])].sort();
}

/** The no-op site is intentionally narrow: only records whose exact sidecar
 * values differ are transitioned, and no global candidate is emitted. */
export function changedSidecarRepoKeys(state: SyncState, values: RepoStateValues): string[] {
  const records = repoRecordsForState(state);
  const keys = new Set([
    ...Object.keys(records),
    ...Object.keys(values.pending ?? {}),
    ...Object.keys(values.removed ?? {}),
    ...Object.keys(values.resolutions ?? {}),
  ]);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return [...keys].filter((relPath) => {
    const record = records[relPath];
    return !same(record?.pending, values.pending?.[relPath])
      || record?.removedKey !== values.removed?.[relPath]
      || record?.resolutionKey !== values.resolutions?.[relPath];
  }).sort();
}

/** Daemon iteration-start binding fence. Unlike loadState, this inspects the raw
 * stream and nonce so a reset/rebind while the daemon idles cannot be hidden. */
export async function daemonBindingMatches(root: string, expectedStream: string, expectedNonce: string): Promise<boolean> {
  const raw = await loadRawState(root);
  if (!raw) return expectedNonce === "legacy";
  const rawStream = raw.stream ?? expectedStream; // pre-stream legacy adoption
  return rawStream === expectedStream && expectedStateNonce(raw) === expectedNonce;
}
