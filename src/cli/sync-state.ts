import type { GitSection, Manifest } from "../engine/index.js";
import { isDeepStrictEqual } from "node:util";
import type { ConfigStatToken } from "../engine/git/config-txn.js";
import {
  applyStateSavePacket,
  expectedStateNonce,
  loadRawState,
  repoRecordsForState,
  saveState,
  stateFromRepoRecords,
  type FileOnlyManifest,
  type GlobalManifestMeta,
  type GitDeferral,
  type GitDeferrals,
  type GitPartialApply,
  type RepoRecord,
  type RepoRecordInput,
  type StateSavePacket,
  type SyncState,
} from "./config.js";

export type ConfigLaneState = Pick<RepoRecordInput, "cfgSynced" | "cfgApplied" | "cfgToken" | "cfgShape">;
export type GitDeferralUpdates = Partial<Record<GitDeferral["lane"], GitDeferral | null>>;

export function configLaneState(record: ConfigLaneState): ConfigLaneState {
  return {
    ...(record.cfgSynced === undefined ? {} : { cfgSynced: record.cfgSynced }),
    ...(record.cfgApplied === undefined ? {} : { cfgApplied: record.cfgApplied }),
    ...(record.cfgToken === undefined ? {} : { cfgToken: record.cfgToken }),
    ...(record.cfgShape === undefined ? {} : { cfgShape: record.cfgShape }),
  };
}

export interface RepoStateValues {
  bases?: Record<string, GitSection>;
  pending?: Record<string, GitSection>;
  removed?: Record<string, string>;
  resolutions?: Record<string, string>;
  /** A present entry replaces this repo's local-only config lane fields. Missing
   * means preserve them. This rides the same generation-CAS transition as base and
   * pending; there is never a second config-only state write. */
  configLane?: Record<string, ConfigLaneState>;
  /** Missing repo/lane preserves it; null repo clears all lanes; null lane clears it. */
  deferrals?: Record<string, GitDeferralUpdates | null>;
  partial?: Record<string, GitPartialApply | null>;
  /** Semantic projection of the last applied index; null clears a stale cache. */
  idxProj?: Record<string, string | null>;
}

export interface StateSource {
  expectedStream: string;
  sourceGlobalSeq: number;
  /** File-only global truth. gitRepos is deliberately removed by fileOnlyManifest. */
  globalManifest?: Manifest;
  manifestMeta?: GlobalManifestMeta;
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

export function mergeDeferrals(
  current: GitDeferrals | undefined,
  incoming: GitDeferralUpdates | null | undefined,
): GitDeferrals | undefined {
  if (incoming === undefined) return current;
  if (incoming === null) return undefined;
  const merged: GitDeferrals = { ...(current ?? {}) };
  for (const lane of ["apply", "capture", "config"] as const) {
    const value = incoming[lane];
    if (value === null) delete merged[lane];
    else if (value !== undefined) merged[lane] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function sourceRecord(source: StateSource, relPath: string, current: RepoRecord): RepoRecordInput {
  // A recompute from an older source retains the entire newer record. This is the
  // ordering half of the generation CAS: older pending/absence cannot regress a
  // newer success, while the transition still records that this path was observed.
  const mergedDeferrals = mergeDeferrals(current.deferrals, source.values.deferrals?.[relPath]);
  if (current.sourceSeq > source.sourceGlobalSeq) {
    const retained = inputRecord(current);
    if (mergedDeferrals === undefined) delete retained.deferrals;
    else retained.deferrals = mergedDeferrals;
    return retained;
  }
  const lane = source.values.configLane?.[relPath] ?? current;
  const next = stampConfigAck({
    sourceSeq: source.sourceGlobalSeq,
    ...(source.values.bases?.[relPath] === undefined ? {} : { base: source.values.bases[relPath] }),
    ...(source.values.pending?.[relPath] === undefined ? {} : { pending: source.values.pending[relPath] }),
    ...(source.values.removed?.[relPath] === undefined ? {} : { removedKey: source.values.removed[relPath] }),
    ...(source.values.resolutions?.[relPath] === undefined ? {} : { resolutionKey: source.values.resolutions[relPath] }),
    ...configLaneState(lane),
    ...(mergedDeferrals === undefined ? {} : { deferrals: mergedDeferrals }),
    ...(source.values.partial?.[relPath] === undefined
      ? (current.partial === undefined ? {} : { partial: current.partial })
      : source.values.partial[relPath] === null ? {} : { partial: source.values.partial[relPath] }),
    ...(source.values.idxProj?.[relPath] === undefined
      ? (current.idxProj === undefined ? {} : { idxProj: current.idxProj })
      : source.values.idxProj[relPath] === null ? {} : { idxProj: source.values.idxProj[relPath] }),
  }, source.authoredCfgHashByRepo?.[relPath]);
  return next;
}

export function composeStateSavePacket(snapshot: SyncState, source: StateSource): StateSavePacket {
  const records = repoRecordsForState(snapshot);
  const observedRepos = [...new Set(source.observedRepos)].sort();
  const repos = observedRepos.map((relPath) => {
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
      : { global: { manifest: fileOnlyManifest(source.globalManifest), manifestMeta: source.manifestMeta } }),
    repos,
  };
}

function legacyState(snapshot: SyncState, source: StateSource): SyncState {
  const packet = composeStateSavePacket(snapshot, source);
  const records = repoRecordsForState(snapshot);
  for (const transition of packet.repos) records[transition.relPath] = { ...transition.newRecord, repoGen: transition.expectedRepoGen + 1 };
  const manifest = packet.global?.manifest ?? snapshot.lastSyncedManifest;
  return {
    ...stateFromRepoRecords({
      ...snapshot,
      manifestMeta: undefined,
      lastSyncedSequence: packet.global ? source.sourceGlobalSeq : snapshot.lastSyncedSequence,
      lastSyncedManifest: manifest,
    }, records),
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
  options: { apply?: typeof applyStateSavePacket; allowLegacyStreamReplacement?: boolean; forceLegacy?: boolean } = {},
): Promise<SyncState> {
  if (options.forceLegacy) {
    const next = legacyState(initialSnapshot, source);
    await saveState(root, next);
    return next;
  }
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
    ...Object.keys(values.configLane ?? {}),
    ...Object.keys(values.deferrals ?? {}),
    ...Object.keys(values.partial ?? {}),
    ...Object.keys(values.idxProj ?? {}),
  ])].sort();
}

/** Complete a published checkout journal with a fresh generation-CAS merge.
 * The opaque intended record supplies the checkout/config result, while current
 * capture/config deferral lanes are retained and only the apply lane is replaced. */
export async function savePublishedRepoIntent(
  root: string,
  snapshot: SyncState,
  relPath: string,
  intended: { record: RepoRecordInput; expectedRepoGen: number; relPath: string; previousRecord?: RepoRecordInput },
  options: { forceLegacy?: boolean } = {},
): Promise<SyncState> {
  if (intended.relPath !== relPath) throw new Error("published journal relPath mismatch");
  const withoutGen = (value: RepoRecord): RepoRecordInput => {
    const { repoGen: _repoGen, ...record } = value;
    return record;
  };
  const select = (record: RepoRecordInput | undefined, fields: readonly (keyof RepoRecordInput)[]): object =>
    Object.fromEntries(fields.map((field) => [field, record?.[field]]));
  const applyFields = ["base", "pending", "removedKey", "resolutionKey", "partial", "idxProj"] as const;
  const configFields = ["cfgSynced", "cfgApplied", "cfgToken", "cfgShape"] as const;
  const replace = (target: RepoRecordInput, desired: RepoRecordInput, fields: readonly (keyof RepoRecordInput)[]): void => {
    for (const field of fields) {
      if (desired[field] === undefined) delete target[field];
      else (target as Record<string, unknown>)[field] = desired[field];
    }
  };
  const laneDeferral = (record: RepoRecordInput | undefined, lane: "apply" | "capture" | "config") => record?.deferrals?.[lane];
  let currentSnapshot = snapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = repoRecordsForState(currentSnapshot)[relPath] ?? { repoGen: 0, sourceSeq: 0 };
    const currentInput = withoutGen(current);
    const exactGeneration = current.repoGen === intended.expectedRepoGen;
    const appAlready = isDeepStrictEqual(select(currentInput, applyFields), select(intended.record, applyFields))
      && isDeepStrictEqual(laneDeferral(currentInput, "apply"), laneDeferral(intended.record, "apply"));
    const configAlready = isDeepStrictEqual(select(currentInput, configFields), select(intended.record, configFields))
      && isDeepStrictEqual(laneDeferral(currentInput, "config"), laneDeferral(intended.record, "config"));
    const appUnchanged = exactGeneration || (intended.previousRecord !== undefined
      && isDeepStrictEqual(select(currentInput, applyFields), select(intended.previousRecord, applyFields))
      && isDeepStrictEqual(laneDeferral(currentInput, "apply"), laneDeferral(intended.previousRecord, "apply")));
    const configUnchanged = exactGeneration || (intended.previousRecord !== undefined
      && isDeepStrictEqual(select(currentInput, configFields), select(intended.previousRecord, configFields))
      && isDeepStrictEqual(laneDeferral(currentInput, "config"), laneDeferral(intended.previousRecord, "config")));

    // Generation drift means another save landed. Only install a journal lane
    // if that lane is still byte-for-byte the pre-journal value; otherwise the
    // newer lane wins. Capture is never journal-owned and is always preserved.
    const merged: RepoRecordInput = { ...currentInput };
    if (!appAlready && appUnchanged) {
      replace(merged, intended.record, applyFields);
      merged.sourceSeq = intended.record.sourceSeq;
    }
    if (!configAlready && configUnchanged) replace(merged, intended.record, configFields);
    const deferrals = { ...(currentInput.deferrals ?? {}) };
    if (!appAlready && appUnchanged) {
      const value = intended.record.deferrals?.apply;
      if (value) deferrals.apply = value; else delete deferrals.apply;
    }
    if (!configAlready && configUnchanged) {
      const value = intended.record.deferrals?.config;
      if (value) deferrals.config = value; else delete deferrals.config;
    }
    if (Object.keys(deferrals).length) merged.deferrals = deferrals; else delete merged.deferrals;
    if (isDeepStrictEqual(currentInput, merged)) return currentSnapshot;

    if (options.forceLegacy) {
      const records = repoRecordsForState(currentSnapshot);
      records[relPath] = { ...merged, repoGen: current.repoGen + 1 };
      const next = stateFromRepoRecords(currentSnapshot, records);
      await saveState(root, next);
      return next;
    }
    const result = await applyStateSavePacket(root, {
      expectedStream: currentSnapshot.stream,
      expectedNonce: expectedStateNonce(currentSnapshot),
      sourceGlobalSeq: merged.sourceSeq,
      repos: [{ relPath, expectedRepoGen: current.repoGen, newRecord: merged }],
    });
    if (result.status === "accepted") return result.state;
    if (result.status === "rejected" && (result.reason === "repo-generation" || result.reason === "global-sequence")) {
      currentSnapshot = result.state;
      continue;
    }
    if (result.status === "busy") throw new Error(`sync state busy (${result.detail})`);
    if (result.status === "unsupported") throw new Error(`sync state transactional save unsupported (${String(result.error)})`);
    throw new Error(`sync state changed during published recovery (${result.reason})`);
  }
  throw new Error("sync state kept changing during published recovery (3 recomputes exhausted)");
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
    ...Object.keys(values.deferrals ?? {}),
    ...Object.keys(values.partial ?? {}),
  ]);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return [...keys].filter((relPath) => {
    const record = records[relPath];
    return !same(record?.pending, values.pending?.[relPath])
      || record?.removedKey !== values.removed?.[relPath]
      || record?.resolutionKey !== values.resolutions?.[relPath]
      || (values.deferrals?.[relPath] !== undefined && !same(mergeDeferrals(record?.deferrals, values.deferrals[relPath]), record?.deferrals))
      || (values.partial?.[relPath] !== undefined && !same(values.partial[relPath], record?.partial));
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
