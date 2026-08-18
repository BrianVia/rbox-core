/** Never: measurement state ownership, network, or file I/O. */
import { currentFirstPublishTiming, firstPublishTimingView, type FirstPublishStats } from "./push-spans.js";

export type { FirstPublishStats } from "./push-spans.js";
export const firstPublishTiming = firstPublishTimingView;

/** RBOX_LANE_TIMING=1 — push-side encrypt vs upload attribution. */
export const LANE_TIMING = process.env.RBOX_LANE_TIMING === "1";

export const uploadLaneTiming = { encryptMs: 0, uploadMs: 0, queueMs: 0, blobs: 0, bytes: 0 };

const packFallbackReasons = [
  "disabled_latch", "retry_later", "http_error", "parse_error", "not_activated", "transport",
] as const;
export type PackFallbackReason = (typeof packFallbackReasons)[number];

export interface PackUploadTiming {
  packsBuilt: number;
  packsSent: number;
  members: number;
  payloadBytes: number;
  overheadBytes: number;
  buildMs: number;
  uploadMs: number;
  fallbacks: Record<PackFallbackReason, number>;
}

const newPackFallbacks = (): Record<PackFallbackReason, number> =>
  Object.fromEntries(packFallbackReasons.map((reason) => [reason, 0])) as Record<PackFallbackReason, number>;

export const packUploadTiming: PackUploadTiming = {
  packsBuilt: 0,
  packsSent: 0,
  members: 0,
  payloadBytes: 0,
  overheadBytes: 0,
  buildMs: 0,
  uploadMs: 0,
  fallbacks: newPackFallbacks(),
};

export function recordPackBuilt(members: number, payloadBytes: number, totalBytes: number, buildMs: number): void {
  packUploadTiming.packsBuilt++;
  packUploadTiming.members += members;
  packUploadTiming.payloadBytes += payloadBytes;
  packUploadTiming.overheadBytes += Math.max(0, totalBytes - payloadBytes);
  packUploadTiming.buildMs += buildMs;
}

export function recordPackSent(uploadMs: number): void {
  packUploadTiming.packsSent++;
  packUploadTiming.uploadMs += uploadMs;
}

export function recordPackFallback(reason: PackFallbackReason): void {
  packUploadTiming.fallbacks[reason]++;
}

export function getPackUploadTiming(): Readonly<PackUploadTiming> {
  return { ...packUploadTiming, fallbacks: { ...packUploadTiming.fallbacks } };
}

export function resetPackUploadTimingForTests(): void {
  packUploadTiming.packsBuilt = 0;
  packUploadTiming.packsSent = 0;
  packUploadTiming.members = 0;
  packUploadTiming.payloadBytes = 0;
  packUploadTiming.overheadBytes = 0;
  packUploadTiming.buildMs = 0;
  packUploadTiming.uploadMs = 0;
  packUploadTiming.fallbacks = newPackFallbacks();
}

const uploadDispatchReasons = [
  "full_records", "full_bytes", "fixed_timer", "quiet", "absolute", "idle_tail",
] as const;
export type UploadDispatchReason = (typeof uploadDispatchReasons)[number];

export interface UploadDispatchStat {
  count: number;
  records: number;
  bytes: number;
}

export interface UploadDispatchObservation {
  reason: UploadDispatchReason;
  records: number;
  bytes: number;
  queueDepth: number;
  oldestAgeMs: number;
}

const UPLOAD_DISPATCH_OBSERVATION_CAP = 20_000;
const newUploadDispatchStats = (): Record<UploadDispatchReason, UploadDispatchStat> =>
  Object.fromEntries(uploadDispatchReasons.map((reason) => [reason, { count: 0, records: 0, bytes: 0 }])) as Record<UploadDispatchReason, UploadDispatchStat>;
let uploadDispatchStats = newUploadDispatchStats();
// Design-112 sweep seam: per-dispatch reason/records/bytes/queueDepth/oldestAgeMs observations under RBOX_LANE_TIMING are consumed by the phase-3/4 sweep harness, not production code (docs/design/112-batch-fill-wire-cap.md §Sweep and corpus gates).
let uploadDispatchObservations: UploadDispatchObservation[] = [];

export function recordUploadDispatch(
  reason: UploadDispatchReason,
  records: number,
  bytes: number,
  queueDepth: number,
  oldestAgeMs: number,
): void {
  const stat = uploadDispatchStats[reason];
  stat.count++;
  stat.records += records;
  stat.bytes += bytes;
  if (LANE_TIMING && uploadDispatchObservations.length < UPLOAD_DISPATCH_OBSERVATION_CAP) {
    uploadDispatchObservations.push({ reason, records, bytes, queueDepth, oldestAgeMs });
  }
}

export function getUploadDispatchStats(): Readonly<Record<UploadDispatchReason, Readonly<UploadDispatchStat>>> {
  return Object.fromEntries(uploadDispatchReasons.map((reason) => [reason, { ...uploadDispatchStats[reason] }])) as Record<UploadDispatchReason, UploadDispatchStat>;
}

export function getUploadDispatchObservations(): ReadonlyArray<Readonly<UploadDispatchObservation>> {
  return uploadDispatchObservations.map((observation) => ({ ...observation }));
}

export function resetUploadDispatchStatsForTests(): void {
  uploadDispatchStats = newUploadDispatchStats();
  uploadDispatchObservations = [];
}

export function beginFirstPublishTiming(enabled: boolean): void {
  const timing = currentFirstPublishTiming();
  if (!timing) return;
  timing.generation++;
  if (enabled && timing.enabled) {
    timing.enabled = false;
    return;
  }
  timing.enabled = enabled;
  if (!enabled) return;
  timing.stats = {
    timeToFilesSyncedMs: 0, timeToFirstReadyCiphertextMs: 0, firstReadyToFirstUploadStartMs: 0,
    encryptWallMs: 0, missingCheckWallMs: 0, uploadCriticalPathMs: 0,
    receiptRedemptionWallMs: 0, commitWallMs: 0, finalDrainMs: 0,
    redeemRequestCount: 0, redeemReceiptCount: 0, redeemMaxEntryBytes: 0,
    redeemMaxRequestBytes: 0, finalFlushMs: 0, receiptRedemptionOverlapMs: 0,
    authCallCount: 0, authCriticalPathMs: 0, peakTempDiskBytes: 0,
    peakQueueHeapBytes: 0, peakUploaderFramingBytes: 0,
    serverUnsatisfiedTotal: 0, serverSatisfiedSkipped: 0,
    uniqueEncryptions: 0, duplicateEncryptions: 0, reEncryptedOnResume: 0,
    producerCpuSaturationPct: 0,
  };
  timing.startedAt = performance.now();
  timing.firstReadyAt = timing.firstUploadAt = 0;
  timing.uploadStartedAt = timing.uploadEndedAt = 0;
  timing.uploadActive = 0;
  timing.uploadIntervals = [];
  timing.uploadOpenAt = 0;
  timing.tempBytes = 0;
  timing.authStartedAt = timing.authEndedAt = 0;
  timing.encryptedAddresses.clear();
  timing.checkedAddresses.clear();
}
export function firstPublishReady(bytes: number, address?: string): void {
  const timing = currentFirstPublishTiming();
  if (!timing?.enabled) return;
  const t = performance.now();
  if (!timing.firstReadyAt) {
    timing.firstReadyAt = t;
    timing.stats.timeToFirstReadyCiphertextMs = Math.max(0, Math.round(t - timing.startedAt));
  }
  timing.tempBytes += bytes;
  timing.stats.peakTempDiskBytes = Math.max(timing.stats.peakTempDiskBytes, timing.tempBytes);
  if (address) {
    if (timing.encryptedAddresses.has(address)) timing.stats.duplicateEncryptions++;
    else { timing.encryptedAddresses.add(address); timing.stats.uniqueEncryptions++; }
  }
}
export function firstPublishUploadStart(): number {
  const timing = currentFirstPublishTiming();
  if (!timing?.enabled) return 0;
  const t = performance.now();
  if (!timing.firstUploadAt) {
    timing.firstUploadAt = t;
    timing.stats.firstReadyToFirstUploadStartMs = Math.max(0, Math.round(t - (timing.firstReadyAt || t)));
  }
  if (!timing.uploadStartedAt) timing.uploadStartedAt = t;
  if (timing.uploadActive === 0) timing.uploadOpenAt = t;
  timing.uploadActive++;
  return t;
}
export function firstPublishUploadEnd(): void {
  const timing = currentFirstPublishTiming();
  if (timing?.enabled) {
    const now = performance.now();
    timing.uploadEndedAt = now;
    const wasActive = timing.uploadActive;
    timing.uploadActive = Math.max(0, timing.uploadActive - 1);
    if (wasActive === 1 && timing.uploadOpenAt > 0) {
      timing.uploadIntervals.push({ start: timing.uploadOpenAt, end: now });
      timing.uploadOpenAt = 0;
    }
  }
}

/** Arm-scoped settlement guard for timers that may span a disarm/re-arm (e.g. a
 *  receipt drain in flight while a push finishes): capture the token when the timed
 *  work starts and settle stats only while the SAME armed measurement is live.
 *  Gating on `enabled` alone would let a drain started under measurement A (or under
 *  no measurement, with a zero start timestamp) credit a later measurement B. */
export function firstPublishMeasurementToken(): number {
  const timing = currentFirstPublishTiming();
  return timing?.enabled ? timing.generation : 0;
}
export function firstPublishMeasurementLive(token: number): boolean {
  const timing = currentFirstPublishTiming();
  return token !== 0 && timing?.enabled === true && timing.generation === token;
}

/** Intervals must be disjoint and sorted ascending by start (uploadIntervals is
 *  append-ordered by construction) — the early break relies on it. */
export function intervalUnionOverlapMs(
  start: number,
  end: number,
  intervals: ReadonlyArray<{ start: number; end: number }>,
): number {
  if (end <= start) return 0;
  let overlap = 0;
  for (const interval of intervals) {
    if (interval.start > end) break;
    overlap += Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start));
  }
  return overlap;
}

export function uploadActiveOverlapMs(start: number, end: number): number {
  const timing = currentFirstPublishTiming();
  if (!timing) return 0;
  const closed = intervalUnionOverlapMs(start, end, timing.uploadIntervals);
  const open = timing.uploadOpenAt > 0
    ? Math.max(0, end - Math.max(start, timing.uploadOpenAt))
    : 0;
  return closed + open;
}
/** Start a batch-PUT timing span; auth classification is unknown until settle. */
export function firstPublishAuthDispatchStart(): number {
  return currentFirstPublishTiming()?.enabled ? performance.now() : 0;
}
/** authn counts settle-classified bearer-path batch PUTs from the server echo.
 *  A missing echo or thrown fetch is classified bearer by the caller. */
export function firstPublishAuthSettle(startT: number, path: "grant" | "bearer"): void {
  const timing = currentFirstPublishTiming();
  if (!timing?.enabled || startT === 0 || path === "grant") return;
  timing.stats.authCallCount++;
  timing.authStartedAt = timing.authStartedAt
    ? Math.min(timing.authStartedAt, startT)
    : startT;
  timing.authEndedAt = Math.max(timing.authEndedAt, performance.now());
}
export function finishFirstPublishStats(): FirstPublishStats | undefined {
  const timing = currentFirstPublishTiming();
  if (!timing?.enabled) return undefined;
  // (design 108): finalization ALWAYS disables the measurement —
  // even when it yields no stats — so a no-upload push can't leak timing into later work.
  timing.enabled = false;
  // Render when there was a real upload critical path OR a command-level files-synced
  // milestone (design 108 §3.6): a 409/422-retry success re-uploads nothing yet must still
  // emit the headline timeToFilesSyncedMs — the files DID sync, on the earlier attempt.
  if (!timing.firstUploadAt && !timing.stats.timeToFilesSyncedMs) return undefined;
  const s = timing.stats;
  s.uploadCriticalPathMs = Math.max(0, Math.round(timing.uploadEndedAt - timing.uploadStartedAt));
  s.authCriticalPathMs = Math.max(0, Math.round(timing.authEndedAt - timing.authStartedAt));
  return { ...s };
}

export function formatFirstPublishStats(s: FirstPublishStats): string {
  return `fp filesSynced${s.timeToFilesSyncedMs} ready${s.timeToFirstReadyCiphertextMs} wait${s.firstReadyToFirstUploadStartMs} enc${s.encryptWallMs} miss${s.missingCheckWallMs} up${s.uploadCriticalPathMs} redeem${s.receiptRedemptionWallMs} redeemOverlap${s.receiptRedemptionOverlapMs} commit${s.commitWallMs} finalDrain${s.finalDrainMs} rreq${s.redeemRequestCount} rcpt${s.redeemReceiptCount} rentB${s.redeemMaxEntryBytes} rreqB${s.redeemMaxRequestBytes} flush${s.finalFlushMs} authn${s.authCallCount} authms${s.authCriticalPathMs} temp${s.peakTempDiskBytes} queue${s.peakQueueHeapBytes} frame${s.peakUploaderFramingBytes} unsat${s.serverUnsatisfiedTotal} skip${s.serverSatisfiedSkipped} uniq${s.uniqueEncryptions} dup${s.duplicateEncryptions} resume${s.reEncryptedOnResume} cpu${s.producerCpuSaturationPct}`;
}

export function uploadLaneTimingSummary(): string | undefined {
  if (!LANE_TIMING || (uploadLaneTiming.blobs === 0 && packUploadTiming.packsBuilt === 0)) return undefined;
  const e = uploadLaneTiming.encryptMs, u = uploadLaneTiming.uploadMs, q = uploadLaneTiming.queueMs, n = uploadLaneTiming.blobs;
  const active = e + u;
  const encryptPct = active > 0 ? ((e / active) * 100).toFixed(0) : "0";
  const uploadPct = active > 0 ? ((u / active) * 100).toFixed(0) : "0";
  const queue = q > 0 ? ` · queue ${(q / 1000).toFixed(1)}s` : "";
  const dispatches = uploadDispatchReasons
    .filter((reason) => uploadDispatchStats[reason].count > 0)
    .map((reason) => `${reason}:${uploadDispatchStats[reason].count}(${uploadDispatchStats[reason].records}r)`)
    .join(" ");
  const dispatch = dispatches ? ` · dispatch ${dispatches}` : "";
  const perBlobEncrypt = n > 0 ? (e / n).toFixed(1) : "0.0";
  const perBlobUpload = n > 0 ? (u / n).toFixed(1) : "0.0";
  const fallback = packFallbackReasons
    .filter((reason) => packUploadTiming.fallbacks[reason] > 0)
    .map((reason) => `${reason}:${packUploadTiming.fallbacks[reason]}`)
    .join(" ");
  const packs = packUploadTiming.packsBuilt > 0 || fallback
    ? ` · packs built ${packUploadTiming.packsBuilt} sent ${packUploadTiming.packsSent}`
      + ` members/pack ${(packUploadTiming.members / Math.max(1, packUploadTiming.packsBuilt)).toFixed(1)}`
      + ` payload ${packUploadTiming.payloadBytes}B overhead ${packUploadTiming.overheadBytes}B`
      + ` build ${packUploadTiming.buildMs.toFixed(1)}ms upload ${packUploadTiming.uploadMs.toFixed(1)}ms`
      + (fallback ? ` fallback ${fallback}` : "")
    : "";
  return `lane timing (push): ${n} blobs · encrypt ${(e / 1000).toFixed(1)}s (${encryptPct}%) · upload ${(u / 1000).toFixed(1)}s (${uploadPct}%)${queue} · per-blob encrypt ${perBlobEncrypt}ms / upload ${perBlobUpload}ms${dispatch}${packs}`;
}
