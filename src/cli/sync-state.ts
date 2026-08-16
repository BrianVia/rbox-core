import type { GitSection, Manifest } from "../engine/index.js";
import { isDeepStrictEqual } from "node:util";
import type { ConfigStatToken } from "../cli/sync-git/config-txn.js";
import { sanitizeRepoRecord } from "./repo-record-sanitation.js";
import {
  composeRepoBase,
  type BranchBaseOrigin,
  type RepoBaseProof,
} from "./sync-git/base-composer.js";
import { provisionalRepoBaseProof } from "./sync-git/base-proof-selection.js";
import {
  applyStateSavePacket,
  DEFERRAL_LANES,
  expectedStateNonce,
  loadRawState,
  MAX_LEGACY_GIT_SIDECAR_REPOS,
  repoRecordsForState,
  saveStateUnsafeLegacyOrTest,
  stateFromRepoRecords,
  type FileOnlyManifest,
  type GlobalManifestMeta,
  type GitDeferral,
  type GitDeferrals,
  type GitPartialApply,
  type GitHeldAttempt,
  type GitResolutionPublicationReceipt,
  type RepoRecord,
  type RepoRecordInput,
  type StateSavePacket,
  type SyncState,
} from "./config.js";
import {
  fullyElidedPacket, globalWouldNotChange, receiptBoundTo, recordWouldNotChange, type ElisionReceipt,
} from "./sync-state-elision.js";
import { ResetCorruptionError } from "./reset-io.js";
import { rethrowIfStateBarrier } from "./state-plane/authority-marker.js";
import { replaceResetLineageStream } from "./state-plane/adapters/whole-state-compat.js";

/** The record's config-lane members, in persisted order. Durable field names,
 * not code symbols (docs/wire-rename-candidates.md). */
const CONFIG_LANE_FIELDS = ["cfgSynced", "cfgApplied", "cfgToken", "cfgShape"] as const;

export type ConfigLaneState = Pick<RepoRecordInput, (typeof CONFIG_LANE_FIELDS)[number]>;
/** Planner-facing lane results. Persistence converts these to ordered
 * transitions with orderedDeferralUpdates() before a generation-CAS save. */
export type GitDeferralUpdates = Partial<Record<GitDeferral["lane"], GitDeferral | null>>;
type GitDeferralTransition =
  | { set: GitDeferral; ifPreviouslyAbsent: true }
  | { set: GitDeferral; ifLastSeenAtMost: string }
  | { clear: true; ifLastSeenAtMost: string };
export type OrderedGitDeferralUpdates = Partial<Record<GitDeferral["lane"], GitDeferralTransition>>;

export function configLaneState(record: ConfigLaneState): ConfigLaneState {
  const lane: ConfigLaneState = {};
  for (const field of CONFIG_LANE_FIELDS) {
    if (record[field] !== undefined) Object.assign(lane, { [field]: record[field] });
  }
  return lane;
}

export interface RepoStateValues {
  bases?: Record<string, GitSection>;
  /** Explicit publisher ACK lane. A section installs the exact committed wire value;
   * null records acknowledged wire absence; omission preserves the existing lane. */
  advertised?: Record<string, GitSection | null>;
  /** Complete publisher/apply suppression projection when present. Missing
   * entries clear repoAbsent; omitting the map preserves the current lane. */
  repoAbsent?: Record<string, true>;
  branchBaseOrigins?: Record<string, Record<string, BranchBaseOrigin>>;
  /** null explicitly clears a baseline after packed-refs disappears; omission retains it. */
  packedRefsIdentity?: Record<string, NonNullable<RepoRecord["packedRefsIdentity"]> | null>;
  pending?: Record<string, GitSection>;
  removed?: Record<string, string>;
  resolutions?: Record<string, string>;
  /** A present entry replaces this repo's local-only config lane fields. Missing
   * means preserve them. This rides the same generation-CAS transition as base and
   * pending; there is never a second config-only state write. */
  configLane?: Record<string, ConfigLaneState>;
  /** Missing repo/lane preserves it. Every transition is bound to the lane
   * predecessor observed by its writer, so a CAS recompute cannot clear or
   * resurrect a newer episode. */
  deferrals?: Record<string, OrderedGitDeferralUpdates>;
  partial?: Record<string, GitPartialApply | null>;
  /** Explicit local-only held-attempt transitions; omission preserves, null clears. */
  attempt?: Record<string, GitHeldAttempt | null>;
  /** Synchronous keep-mine publication receipt transition. Missing preserves;
   * null clears only in the same or a later transition than accepted clears. */
  resolutionReceipt?: Record<string, GitResolutionPublicationReceipt | null>;
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
  /** Closed, per-repository BASE authority. One packet may mix authority kinds. */
  repoProofs?: Record<string, RepoBaseProof>;
  /** ACK-only authorship. Missing entries must not stamp unrelated repos. */
  authoredCfgHashByRepo?: Record<string, string>;
  /** Design 267: a pull's proof that sections of this save would move nothing.
   * Absent — every non-pull source — composes the full packet as always. */
  elisionReceipt?: ElisionReceipt;
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
  const completed: RepoRecordInput = { ...record };
  if (cfgSynced !== undefined) completed.cfgSynced = cfgSynced;
  completed.cfgApplied = completion.incoming;
  completed.cfgToken = completion.postToken;
  return completed;
}

export function stampConfigAck(record: RepoRecordInput, authoredHash: string | undefined): RepoRecordInput {
  return authoredHash === undefined ? record : { ...record, cfgSynced: authoredHash };
}

export function fileOnlyManifest(manifest: Manifest): FileOnlyManifest {
  const { gitRepos: _gitRepos, ...filesAndMetadata } = manifest;
  return filesAndMetadata;
}

export const inputRecord = (record: RepoRecord): RepoRecordInput => {
  const { repoGen: _repoGen, ...input } = record;
  return input;
};

const isStrictlyNewer = (candidate: string, bound: string): boolean => {
  const candidateMs = Date.parse(candidate);
  const boundMs = Date.parse(bound);
  return Number.isFinite(candidateMs) && Number.isFinite(boundMs) ? candidateMs > boundMs : candidate > bound;
};

export function orderedDeferralUpdates(
  current: GitDeferrals | undefined,
  incoming: GitDeferralUpdates | null | undefined,
): OrderedGitDeferralUpdates | undefined {
  if (incoming === undefined) return undefined;
  const updates: OrderedGitDeferralUpdates = {};
  for (const lane of DEFERRAL_LANES) {
    const previous = current?.[lane];
    const value = incoming === null ? null : incoming[lane];
    if (value === undefined) continue;
    if (value === null) {
      if (previous) updates[lane] = { clear: true, ifLastSeenAtMost: previous.lastSeen };
      continue;
    }
    updates[lane] = previous
      ? { set: value, ifLastSeenAtMost: previous.lastSeen }
      : { set: value, ifPreviouslyAbsent: true };
  }
  return Object.keys(updates).length === 0 ? undefined : updates;
}

export function orderedRepoDeferralUpdates(
  current: Record<string, RepoRecord>,
  incoming: Record<string, GitDeferralUpdates | null> | undefined,
): Record<string, OrderedGitDeferralUpdates> | undefined {
  if (incoming === undefined) return undefined;
  const updates: Record<string, OrderedGitDeferralUpdates> = {};
  for (const [relPath, lanes] of Object.entries(incoming)) {
    const ordered = orderedDeferralUpdates(current[relPath]?.deferrals, lanes);
    if (ordered !== undefined) updates[relPath] = ordered;
  }
  return Object.keys(updates).length === 0 ? undefined : updates;
}

function mergeDeferrals(
  current: GitDeferrals | undefined,
  incoming: OrderedGitDeferralUpdates | undefined,
): GitDeferrals | undefined {
  if (incoming === undefined) return current;
  const merged: GitDeferrals = { ...(current ?? {}) };
  for (const lane of DEFERRAL_LANES) {
    const transition = incoming[lane];
    if (transition === undefined) continue;
    const present = merged[lane];
    if ("clear" in transition) {
      if (present && !isStrictlyNewer(present.lastSeen, transition.ifLastSeenAtMost)) delete merged[lane];
      continue;
    }
    // A set computed from a standing predecessor cannot resurrect that episode
    // after a concurrent clear. Otherwise only a strictly newer standing truth
    // wins; equal/older observations may be refreshed by this source.
    if (present === undefined && "ifLastSeenAtMost" in transition) continue;
    if (present && isStrictlyNewer(present.lastSeen, transition.set.lastSeen)) continue;
    merged[lane] = transition.set;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/** One local-only sidecar lane's transition: an omitted incoming value retains
 * the current one, an explicit null clears it, and a value replaces it. */
const selectSidecarLane = <Lane>(incoming: Lane | null | undefined, current: Lane | undefined): Lane | undefined =>
  incoming === undefined ? current : incoming ?? undefined;

/** Sidecar tri-state, keyed by property presence rather than by value. */
function selectPackedRefsIdentity(
  values: RepoStateValues["packedRefsIdentity"],
  relPath: string,
  current: RepoRecord["packedRefsIdentity"],
): NonNullable<RepoRecord["packedRefsIdentity"]> | undefined {
  if (!Object.prototype.hasOwnProperty.call(values ?? {}, relPath)) return current;
  return values![relPath] ?? undefined;
}

/** The transition one source contributes for one repository: its record and the
 * BASE authority that both this composition and the store's re-composition use. */
interface SourceRepoTransition {
  newRecord: RepoRecordInput;
  baseProof: RepoBaseProof;
}

function sourceRecord(source: StateSource, relPath: string, current: RepoRecord): SourceRepoTransition {
  const previousValue = { base: current.base, branchBaseOrigins: current.branchBaseOrigins };
  // A recompute from an older source retains the entire newer record. This is the
  // ordering half of the generation CAS: older pending/absence cannot regress a
  // newer success, while the transition still records that this path was observed.
  const mergedDeferrals = mergeDeferrals(current.deferrals, source.values.deferrals?.[relPath]);
  if (current.sourceSeq > source.sourceGlobalSeq) {
    const retained = inputRecord(current);
    if (mergedDeferrals === undefined) delete retained.deferrals;
    else retained.deferrals = mergedDeferrals;
    // A retention moves nothing, so it carries the record's own lineage rather
    // than the discarded source's proof.
    return { newRecord: sanitizeRepoRecord(retained), baseProof: provisionalRepoBaseProof(relPath, undefined, previousValue) };
  }
  const lane = source.values.configLane?.[relPath] ?? current;
  const hasAdvertisedValue = Object.prototype.hasOwnProperty.call(source.values.advertised ?? {}, relPath);
  const advertisedValue = source.values.advertised?.[relPath];
  const candidateValue = {
    base: source.values.bases?.[relPath],
    branchBaseOrigins: source.values.branchBaseOrigins?.[relPath],
  };
  const proof = provisionalRepoBaseProof(relPath, source.repoProofs?.[relPath], previousValue);
  const composed = composeRepoBase(
    previousValue,
    candidateValue,
    proof.authority,
    proof.lockedProof,
  );
  // Installed in persisted order; an omitted member is ABSENT, never undefined.
  const composedRecord: RepoRecordInput = { sourceSeq: source.sourceGlobalSeq };
  if (composed.base !== undefined) composedRecord.base = composed.base;
  if (composed.branchBaseOrigins !== undefined) composedRecord.branchBaseOrigins = composed.branchBaseOrigins;
  const packedRefsIdentity = selectPackedRefsIdentity(source.values.packedRefsIdentity, relPath, current.packedRefsIdentity);
  if (packedRefsIdentity !== undefined) composedRecord.packedRefsIdentity = packedRefsIdentity;
  const advertised = hasAdvertisedValue ? advertisedValue ?? undefined : current.advertised;
  if (advertised !== undefined) composedRecord.advertised = advertised;
  const repoAbsent = source.values.repoAbsent === undefined ? current.repoAbsent : source.values.repoAbsent[relPath];
  if (repoAbsent === true) composedRecord.repoAbsent = true;
  const pending = source.values.pending?.[relPath];
  if (pending !== undefined) composedRecord.pending = pending;
  const removedKey = source.values.removed?.[relPath];
  if (removedKey !== undefined) composedRecord.removedKey = removedKey;
  const resolutionKey = source.values.resolutions?.[relPath];
  if (resolutionKey !== undefined) composedRecord.resolutionKey = resolutionKey;
  Object.assign(composedRecord, configLaneState(lane));
  if (mergedDeferrals !== undefined) composedRecord.deferrals = mergedDeferrals;
  const partial = selectSidecarLane(source.values.partial?.[relPath], current.partial);
  if (partial !== undefined) composedRecord.partial = partial;
  const attempt = selectSidecarLane(source.values.attempt?.[relPath], current.attempt);
  if (attempt !== undefined) composedRecord.attempt = attempt;
  const resolutionReceipt = selectSidecarLane(source.values.resolutionReceipt?.[relPath], current.resolutionReceipt);
  if (resolutionReceipt !== undefined) composedRecord.resolutionReceipt = resolutionReceipt;
  const idxProj = selectSidecarLane(source.values.idxProj?.[relPath], current.idxProj);
  if (idxProj !== undefined) composedRecord.idxProj = idxProj;
  const next = stampConfigAck(composedRecord, source.authoredCfgHashByRepo?.[relPath]);
  if (composed.disposition === "pending" && source.values.bases?.[relPath] && next.pending === undefined) {
    next.pending = source.values.bases[relPath];
  }
  return { newRecord: sanitizeRepoRecord(next), baseProof: proof };
}

export function composeStateSavePacket(snapshot: SyncState, source: StateSource): StateSavePacket {
  const records = { ...repoRecordsForState(snapshot) };
  const observedRepos = [...new Set(source.observedRepos)].sort();
  // The receipt is evidence only against the snapshot it was minted from, so a
  // recomposition after ANY rejection silently spends it (§3.2b).
  const receipt = receiptBoundTo(snapshot, source.elisionReceipt);
  // An elision has ONE meaning: the global was proven unchanged. Repo
  // transitions ride that same proof rather than each carrying their own, so a
  // content-carrying save never attaches an expectation and never spends part
  // of its retry budget on a race it had no reason to care about (§3.3).
  const proven = receipt !== undefined
    && globalWouldNotChange(snapshot, source.sourceGlobalSeq, receipt) ? receipt : undefined;
  const repos = observedRepos.flatMap((relPath) => {
    const stored = records[relPath];
    const current = stored ?? { repoGen: 0, sourceSeq: 0 };
    const transition = sourceRecord(source, relPath, current);
    // A path with no stored record is never elided: absence is a distinct
    // durable outcome from a record that happens to compose to the same values.
    if (proven !== undefined && stored !== undefined
      && recordWouldNotChange(inputRecord(stored), transition.newRecord)) {
      return [];
    }
    return [{ relPath, expectedRepoGen: current.repoGen, ...transition }];
  });
  const packet: StateSavePacket = {
    expectedStream: source.expectedStream,
    expectedNonce: expectedStateNonce(snapshot),
    sourceGlobalSeq: source.sourceGlobalSeq,
    repos,
  };
  // On recompute after a newer global landed, omit this stale global candidate.
  // Repo transitions above likewise retain records with a newer sourceSeq.
  if (source.globalManifest !== undefined && proven === undefined && source.sourceGlobalSeq >= snapshot.lastSyncedSequence) {
    packet.global = { manifest: fileOnlyManifest(source.globalManifest), manifestMeta: source.manifestMeta };
  }
  if (proven !== undefined) {
    packet.elisionExpectation = { nonce: proven.nonce, stateRevision: proven.stateRevision };
  }
  return packet;
}

function projectStateSource(snapshot: SyncState, source: StateSource): SyncState {
  const packet = composeStateSavePacket(snapshot, source);
  const records = repoRecordsForState(snapshot);
  for (const transition of packet.repos) records[transition.relPath] = { ...transition.newRecord, repoGen: transition.expectedRepoGen + 1 };
  for (const [relPath, record] of Object.entries(records)) records[relPath] = sanitizeRepoRecord(record);
  const manifest = packet.global?.manifest ?? snapshot.lastSyncedManifest;
  const projected = stateFromRepoRecords({
    ...snapshot,
    manifestMeta: packet.global ? packet.global.manifestMeta : snapshot.manifestMeta,
    lastSyncedSequence: packet.global ? source.sourceGlobalSeq : snapshot.lastSyncedSequence,
    lastSyncedManifest: manifest,
  }, records);
  if (projected.manifestMeta === undefined) delete projected.manifestMeta;
  if (projected.lastSyncedManifest.gitRepos === undefined) delete projected.lastSyncedManifest.gitRepos;
  if (projected.gitReposRemoved === undefined) delete projected.gitReposRemoved;
  if (projected.gitNeedsResolution === undefined) delete projected.gitNeedsResolution;
  if (projected.gitPendingRemote === undefined) delete projected.gitPendingRemote;
  if (projected.gitDeferrals === undefined) delete projected.gitDeferrals;
  if (projected.gitPartial === undefined) delete projected.gitPartial;
  return projected;
}

function legacyState(projected: SyncState): SyncState {
  const records = repoRecordsForState(projected);
  const legacyMap = <T>(pick: (record: RepoRecord) => T | undefined): Record<string, T> | undefined => {
    const result: Record<string, T> = {};
    for (const [relPath, record] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b))) {
      const value = pick(record);
      if (value !== undefined) {
        result[relPath] = value;
        if (Object.keys(result).length === MAX_LEGACY_GIT_SIDECAR_REPOS) break;
      }
    }
    return Object.keys(result).length === 0 ? undefined : result;
  };
  return {
    ...projected,
    manifestMeta: undefined,
    // link()-unsupported fallback intentionally has no lane fence/state.
    stateNonce: undefined,
    stateRevision: undefined,
    repoRecords: undefined,
    gitDeferrals: legacyMap((record) => record.deferrals),
    gitPartial: legacyMap((record) => record.partial),
  };
}

/** Save a source as one packet, recomputing immediately on generation/global CAS
 * rejection. Stream/nonce rejection is an incarnation change and never retries.
 * An elision receipt is SINGLE-ATTEMPT: drift discards it, so the retry composes
 * the standing full packet and can never re-send a stale proof. */
export async function saveStateSource(
  root: string,
  initialSnapshot: SyncState,
  source: StateSource,
  options: { apply?: typeof applyStateSavePacket; allowLegacyStreamReplacement?: boolean } = {},
): Promise<SyncState> {
  const apply = options.apply ?? applyStateSavePacket;
  let snapshot = initialSnapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const packet = composeStateSavePacket(snapshot, source);
    const result = await apply(root, packet, fullyElidedPacket(packet) ? { acceptedProjection: snapshot } : {});
    if (result.status === "accepted") return result.state;
    if (result.status === "unsupported") {
      // Exact-Q lock refusal is a typed state-plane barrier. It must escape
      // before the JSON-only projection or writer is even reached. Legacy JSON
      // keeps its raw unsupported result and therefore its established fallback.
      rethrowIfStateBarrier(result.error);
      const next = legacyState(projectStateSource(snapshot, source));
      await saveStateUnsafeLegacyOrTest(root, next);
      return next;
    }
    if (result.status === "busy") throw new Error(`sync state busy (${result.detail})`);
    if (result.status === "rejected" && result.reason === "stream" && options.allowLegacyStreamReplacement) {
      const acceptedProjection = projectStateSource(snapshot, source);
      return replaceResetLineageStream(
        root, snapshot, result.state, packet, acceptedProjection, legacyState(acceptedProjection),
      );
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
    ...Object.keys(values.advertised ?? {}),
    ...Object.keys(values.repoAbsent ?? {}),
    ...Object.keys(values.branchBaseOrigins ?? {}),
    ...Object.keys(values.packedRefsIdentity ?? {}),
    ...Object.keys(values.pending ?? {}),
    ...Object.keys(values.removed ?? {}),
    ...Object.keys(values.resolutions ?? {}),
    ...Object.keys(values.configLane ?? {}),
    ...Object.keys(values.deferrals ?? {}),
    ...Object.keys(values.partial ?? {}),
    ...Object.keys(values.attempt ?? {}),
    ...Object.keys(values.resolutionReceipt ?? {}),
    ...Object.keys(values.idxProj ?? {}),
  ])].sort();
}

export type PublishedRepoIntentDisposition = "landed" | "already-semantic" | "superseded";

/** A published intent is settled for every currently known terminal disposition. */
export const intentSettled = (disposition: PublishedRepoIntentDisposition): boolean =>
  disposition === "landed" || disposition === "already-semantic" || disposition === "superseded";

interface PublishedRepoIntentResult {
  state: SyncState;
  disposition: PublishedRepoIntentDisposition;
}

/** Complete a published checkout journal with a fresh generation-CAS merge.
 * The opaque intended record supplies the checkout/config result, while current
 * capture deferrals are retained. Apply/config transitions are merged by their
 * own episode: a retry-only lastSeen refresh is not a competing transition. */
export async function savePublishedRepoIntent(
  root: string,
  snapshot: SyncState,
  relPath: string,
  intended: { record: RepoRecordInput; expectedRepoGen: number; relPath: string; previousRecord?: RepoRecordInput; baseProof?: RepoBaseProof },
): Promise<PublishedRepoIntentResult> {
  if (intended.relPath !== relPath) throw new Error("published journal relPath mismatch");
  const select = (record: RepoRecordInput | undefined, fields: readonly (keyof RepoRecordInput)[]): object =>
    Object.fromEntries(fields.map((field) => [field, record?.[field]]));
  const applyFields = ["base", "branchBaseOrigins", "packedRefsIdentity", "pending", "repoAbsent", "removedKey", "resolutionKey", "partial", "idxProj"] as const;
  const configFields = CONFIG_LANE_FIELDS;
  const replace = (target: RepoRecordInput, desired: RepoRecordInput, fields: readonly (keyof RepoRecordInput)[]): void => {
    for (const field of fields) {
      if (desired[field] === undefined) delete target[field];
      else Object.assign(target, { [field]: desired[field] });
    }
  };
  const laneDeferral = (record: RepoRecordInput | undefined, lane: "apply" | "capture" | "config") => record?.deferrals?.[lane];
  const sameEpisode = (left: GitDeferral | undefined, right: GitDeferral | undefined): boolean =>
    left === undefined || right === undefined
      ? left === right
      : left.deferredSince === right.deferredSince && left.reason === right.reason;
  const deferralSemantic = (current: GitDeferral | undefined, desired: GitDeferral | undefined): boolean => {
    if (!current || !desired) return current === desired;
    const { lastSeen: _currentLastSeen, ...currentEffect } = current;
    const { lastSeen: _desiredLastSeen, ...desiredEffect } = desired;
    return isDeepStrictEqual(currentEffect, desiredEffect)
      && !isStrictlyNewer(desired.lastSeen, current.lastSeen);
  };
  const laneSemantic = (
    current: RepoRecordInput,
    desired: RepoRecordInput,
    fields: readonly (keyof RepoRecordInput)[],
    lane: "apply" | "config",
  ): boolean => isDeepStrictEqual(select(current, fields), select(desired, fields))
    && deferralSemantic(laneDeferral(current, lane), laneDeferral(desired, lane));
  const laneStillAtPredecessor = (
    current: RepoRecordInput,
    previous: RepoRecordInput,
    desired: RepoRecordInput,
    fields: readonly (keyof RepoRecordInput)[],
    lane: "apply" | "config",
  ): boolean => {
    const fieldsCompatible = isDeepStrictEqual(select(current, fields), select(previous, fields))
      || isDeepStrictEqual(select(current, fields), select(desired, fields));
    const currentDeferral = laneDeferral(current, lane);
    return fieldsCompatible && (
      sameEpisode(currentDeferral, laneDeferral(previous, lane))
      || sameEpisode(currentDeferral, laneDeferral(desired, lane))
    );
  };
  const installDeferral = (
    deferrals: GitDeferrals,
    current: GitDeferral | undefined,
    desired: GitDeferral | undefined,
    lane: "apply" | "config",
  ): void => {
    if (!desired) {
      delete deferrals[lane];
      return;
    }
    // Preserve only the newer observation time. The journal's other fields are
    // the intended set effect and must land even when the predecessor refreshed.
    if (current && sameEpisode(current, desired) && isStrictlyNewer(current.lastSeen, desired.lastSeen)) {
      deferrals[lane] = { ...desired, lastSeen: current.lastSeen };
    } else {
      deferrals[lane] = desired;
    }
  };
  let currentSnapshot = snapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = repoRecordsForState(currentSnapshot)[relPath] ?? { repoGen: 0, sourceSeq: 0 };
    const currentInput = inputRecord(current);
    const exactGeneration = current.repoGen === intended.expectedRepoGen;
    const previous = intended.previousRecord ?? { sourceSeq: 0 };
    const appAlready = laneSemantic(currentInput, intended.record, applyFields, "apply");
    const configAlready = laneSemantic(currentInput, intended.record, configFields, "config");
    if (appAlready && configAlready && currentInput.sourceSeq >= intended.record.sourceSeq) {
      return { state: currentSnapshot, disposition: "already-semantic" };
    }
    const appUnchanged = exactGeneration
      || laneStillAtPredecessor(currentInput, previous, intended.record, applyFields, "apply");
    const configUnchanged = exactGeneration
      || laneStillAtPredecessor(currentInput, previous, intended.record, configFields, "config");
    const superseded = (!appAlready && !appUnchanged) || (!configAlready && !configUnchanged);

    // Generation drift means another save landed. Install a journal lane only
    // while it remains at the predecessor episode (a lastSeen refresh is still
    // that episode); a genuinely different episode wins. Capture is never
    // journal-owned and is always preserved.
    const merged: RepoRecordInput = { ...currentInput };
    if (!appAlready && appUnchanged) {
      replace(merged, intended.record, applyFields);
    }
    if (!configAlready && configUnchanged) replace(merged, intended.record, configFields);
    const deferrals = { ...(currentInput.deferrals ?? {}) };
    if (!appAlready && appUnchanged) {
      installDeferral(deferrals, currentInput.deferrals?.apply, intended.record.deferrals?.apply, "apply");
    }
    if (!configAlready && configUnchanged) {
      installDeferral(deferrals, currentInput.deferrals?.config, intended.record.deferrals?.config, "config");
    }
    if (Object.keys(deferrals).length) merged.deferrals = deferrals; else delete merged.deferrals;
    merged.sourceSeq = Math.max(currentInput.sourceSeq, intended.record.sourceSeq);
    const previousValue = { base: currentInput.base, branchBaseOrigins: currentInput.branchBaseOrigins };
    // Authority comes only from the proof the caller supplies. A published
    // checkout that verified its landing against disk supplies an observed-
    // landing proof (see recoverAndLandFollowJournal) that installs the refs it
    // observed; a caller with no proof — including a legacy journal whose
    // landing could not be confirmed — falls to carry, which holds. Missing
    // proof is never on its own a signal to install anything.
    const baseProof = provisionalRepoBaseProof(relPath, intended.baseProof, previousValue);
    const composed = composeRepoBase(
      previousValue,
      { base: merged.base, branchBaseOrigins: merged.branchBaseOrigins },
      baseProof.authority,
      baseProof.lockedProof,
    );
    if (composed.base === undefined) delete merged.base; else merged.base = composed.base;
    if (composed.branchBaseOrigins === undefined) delete merged.branchBaseOrigins;
    else merged.branchBaseOrigins = composed.branchBaseOrigins;
    if (composed.disposition === "pending" && intended.record.base && merged.pending === undefined) merged.pending = intended.record.base;
    if (isDeepStrictEqual(currentInput, merged)) {
      return { state: currentSnapshot, disposition: superseded ? "superseded" : "already-semantic" };
    }

    const result = await applyStateSavePacket(root, {
      expectedStream: currentSnapshot.stream,
      expectedNonce: expectedStateNonce(currentSnapshot),
      sourceGlobalSeq: merged.sourceSeq,
      repos: [{ relPath, expectedRepoGen: current.repoGen, newRecord: merged, baseProof }],
    });
    if (result.status === "accepted") {
      return { state: result.state, disposition: superseded ? "superseded" : "landed" };
    }
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
    ...Object.keys(values.repoAbsent ?? {}),
    ...Object.keys(values.removed ?? {}),
    ...Object.keys(values.resolutions ?? {}),
    ...Object.keys(values.deferrals ?? {}),
    ...Object.keys(values.partial ?? {}),
    ...Object.keys(values.resolutionReceipt ?? {}),
    ...Object.keys(values.packedRefsIdentity ?? {}),
  ]);
  const same = <Left, Right>(a: Left, b: Right): boolean =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return [...keys].filter((relPath) => {
    const record = records[relPath];
    const receiptTransition = values.resolutionReceipt?.[relPath];
    return !same(record?.pending, values.pending?.[relPath])
      || (Object.prototype.hasOwnProperty.call(values.packedRefsIdentity ?? {}, relPath)
        && !same(record?.packedRefsIdentity, values.packedRefsIdentity?.[relPath]))
      || (values.repoAbsent !== undefined && record?.repoAbsent !== values.repoAbsent[relPath])
      || record?.removedKey !== values.removed?.[relPath]
      || record?.resolutionKey !== values.resolutions?.[relPath]
      || (values.deferrals?.[relPath] !== undefined && !same(mergeDeferrals(record?.deferrals, values.deferrals[relPath]), record?.deferrals))
      || (values.partial?.[relPath] !== undefined && !same(values.partial[relPath], record?.partial))
      || (receiptTransition !== undefined && !same(receiptTransition, record?.resolutionReceipt));
  }).sort();
}

/** Daemon iteration-start binding fence. Unlike loadState, this inspects the raw
 * stream and nonce so a reset/rebind while the daemon idles cannot be hidden. */
export async function daemonBindingMatches(root: string, expectedStream: string, expectedNonce: string): Promise<boolean> {
  let raw: SyncState | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await loadRawState(root);
      break;
    } catch (error) {
      // State publication is an atomic rename and some writers intentionally do
      // not own the workspace mutex. A bounded reader may straddle that rename;
      // retry the complete identity-checked observation, never the same handle.
      const transientIdentityRace = error instanceof ResetCorruptionError
        && error.kind === "identity-race";
      if (!transientIdentityRace || attempt >= 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  if (!raw) return expectedNonce === "legacy";
  const rawStream = raw.stream ?? expectedStream; // pre-stream legacy adoption
  return rawStream === expectedStream && expectedStateNonce(raw) === expectedNonce;
}
