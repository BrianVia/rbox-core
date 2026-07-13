/** RBOX_LANE_TIMING=1 — push-side encrypt vs upload attribution. */
export const LANE_TIMING = process.env.RBOX_LANE_TIMING === "1";

export const uploadLaneTiming = { encryptMs: 0, uploadMs: 0, queueMs: 0, blobs: 0, bytes: 0 };

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

export interface FirstPublishStats {
  /** Design 108 §3.6: command-level time from init's first-push milestone (before scan)
   *  to the accepted files-only commit ACK — the headline greenfield onboarding KPI. */
  timeToFilesSyncedMs: number;
  timeToFirstReadyCiphertextMs: number;
  firstReadyToFirstUploadStartMs: number;
  encryptWallMs: number;
  missingCheckWallMs: number;
  uploadCriticalPathMs: number;
  receiptRedemptionWallMs: number;
  commitWallMs: number;
  /** Design 110 Phase 0: wall of the redeemReceipts call enclosed by commitSigned,
   *  the only drain inside the commit POST envelope (`p`). */
  finalDrainMs: number;
  /** Design 111 Phase 0 receipt details. Measurement cells built from these
   *  fields must record the design-112 rollout state (fill version + records
   *  cap) alongside them (REVIEW-109-111-seam.md addendum). redeemRequestCount
   *  counts logical redemption requests; transport-level retries inside
   *  fetchResilient are not re-counted. */
  redeemRequestCount: number;
  redeemReceiptCount: number;
  redeemMaxEntryBytes: number;
  redeemMaxRequestBytes: number;
  finalFlushMs: number;
  receiptRedemptionOverlapMs: number;
  authCallCount: number;
  authCriticalPathMs: number;
  peakTempDiskBytes: number;
  peakQueueHeapBytes: number;
  peakUploaderFramingBytes: number;
  serverUnsatisfiedTotal: number;
  serverSatisfiedSkipped: number;
  uniqueEncryptions: number;
  duplicateEncryptions: number;
  reEncryptedOnResume: number;
  producerCpuSaturationPct: number;
}

const zeroFirstPublishStats = (): FirstPublishStats => ({
  timeToFilesSyncedMs: 0,
  timeToFirstReadyCiphertextMs: 0, firstReadyToFirstUploadStartMs: 0,
  encryptWallMs: 0, missingCheckWallMs: 0, uploadCriticalPathMs: 0,
  receiptRedemptionWallMs: 0, commitWallMs: 0, finalDrainMs: 0,
  redeemRequestCount: 0, redeemReceiptCount: 0, redeemMaxEntryBytes: 0,
  redeemMaxRequestBytes: 0, finalFlushMs: 0, receiptRedemptionOverlapMs: 0,
  authCallCount: 0, authCriticalPathMs: 0, peakTempDiskBytes: 0,
  peakQueueHeapBytes: 0, peakUploaderFramingBytes: 0,
  serverUnsatisfiedTotal: 0, serverSatisfiedSkipped: 0,
  uniqueEncryptions: 0, duplicateEncryptions: 0, reEncryptedOnResume: 0,
  producerCpuSaturationPct: 0,
});

/** Per-push measurement state. It extends the shipped lane accumulator and is
 * deliberately inert unless an enabled PhaseReport starts a measurement. */
export const firstPublishTiming = {
  enabled: false,
  /** Bumped on every arm/disarm/void — see firstPublishMeasurementToken. */
  generation: 0,
  stats: zeroFirstPublishStats(),
  startedAt: 0,
  firstReadyAt: 0,
  firstUploadAt: 0,
  uploadStartedAt: 0,
  uploadEndedAt: 0,
  uploadActive: 0,
  uploadIntervals: [] as Array<{ start: number; end: number }>,
  uploadOpenAt: 0,
  tempBytes: 0,
  authStartedAt: 0,
  authEndedAt: 0,
  encryptedAddresses: new Set<string>(),
  checkedAddresses: new Set<string>(),
};

/** Arm (or disarm) the per-push first-publish measurement.
 *
 *  OWNERSHIP INVARIANT (design 108): the accumulator is a
 *  process-global singleton, so at most ONE measurement may be in flight per process.
 *  That holds today because every push author is sequential — the CLI runs one command,
 *  the daemon's tick loop awaits each push, and `runPushAttempt`'s finally disarms
 *  before the next attempt (the design-93 workspace sync mutex additionally serializes
 *  same-workspace pushes across processes). If a second measurement is ever requested
 *  while one is armed (a future concurrent multi-workspace embedder), BOTH are voided
 *  rather than cross-attributed: disarm and record nothing — mis-attributed timing is
 *  worse than no timing. */
export function beginFirstPublishTiming(enabled: boolean): void {
  firstPublishTiming.generation++; // any arm/disarm/void invalidates in-flight measurement tokens
  if (enabled && firstPublishTiming.enabled) {
    firstPublishTiming.enabled = false; // concurrent measurement detected: void both, never mix
    return;
  }
  firstPublishTiming.enabled = enabled;
  if (!enabled) return;
  firstPublishTiming.stats = zeroFirstPublishStats();
  firstPublishTiming.startedAt = performance.now();
  firstPublishTiming.firstReadyAt = firstPublishTiming.firstUploadAt = 0;
  firstPublishTiming.uploadStartedAt = firstPublishTiming.uploadEndedAt = 0;
  firstPublishTiming.uploadActive = 0;
  firstPublishTiming.uploadIntervals = [];
  firstPublishTiming.uploadOpenAt = 0;
  firstPublishTiming.tempBytes = 0;
  firstPublishTiming.authStartedAt = firstPublishTiming.authEndedAt = 0;
  firstPublishTiming.encryptedAddresses.clear();
  firstPublishTiming.checkedAddresses.clear();
}
export function firstPublishReady(bytes: number, address?: string): void {
  if (!firstPublishTiming.enabled) return;
  const t = performance.now();
  if (!firstPublishTiming.firstReadyAt) {
    firstPublishTiming.firstReadyAt = t;
    firstPublishTiming.stats.timeToFirstReadyCiphertextMs = Math.max(0, Math.round(t - firstPublishTiming.startedAt));
  }
  firstPublishTiming.tempBytes += bytes;
  firstPublishTiming.stats.peakTempDiskBytes = Math.max(firstPublishTiming.stats.peakTempDiskBytes, firstPublishTiming.tempBytes);
  if (address) {
    if (firstPublishTiming.encryptedAddresses.has(address)) firstPublishTiming.stats.duplicateEncryptions++;
    else { firstPublishTiming.encryptedAddresses.add(address); firstPublishTiming.stats.uniqueEncryptions++; }
  }
}
export function firstPublishUploadStart(): number {
  if (!firstPublishTiming.enabled) return 0;
  const t = performance.now();
  if (!firstPublishTiming.firstUploadAt) {
    firstPublishTiming.firstUploadAt = t;
    firstPublishTiming.stats.firstReadyToFirstUploadStartMs = Math.max(0, Math.round(t - (firstPublishTiming.firstReadyAt || t)));
  }
  if (!firstPublishTiming.uploadStartedAt) firstPublishTiming.uploadStartedAt = t;
  if (firstPublishTiming.uploadActive === 0) firstPublishTiming.uploadOpenAt = t;
  firstPublishTiming.uploadActive++;
  return t;
}
export function firstPublishUploadEnd(): void {
  if (firstPublishTiming.enabled) {
    const now = performance.now();
    firstPublishTiming.uploadEndedAt = now;
    const wasActive = firstPublishTiming.uploadActive;
    firstPublishTiming.uploadActive = Math.max(0, firstPublishTiming.uploadActive - 1);
    if (wasActive === 1 && firstPublishTiming.uploadOpenAt > 0) {
      firstPublishTiming.uploadIntervals.push({ start: firstPublishTiming.uploadOpenAt, end: now });
      firstPublishTiming.uploadOpenAt = 0;
    }
  }
}

/** Arm-scoped settlement guard for timers that may span a disarm/re-arm (e.g. a
 *  receipt drain in flight while a push finishes): capture the token when the timed
 *  work starts and settle stats only while the SAME armed measurement is live.
 *  Gating on `enabled` alone would let a drain started under measurement A (or under
 *  no measurement, with a zero start timestamp) credit a later measurement B. */
export function firstPublishMeasurementToken(): number {
  return firstPublishTiming.enabled ? firstPublishTiming.generation : 0;
}
export function firstPublishMeasurementLive(token: number): boolean {
  return token !== 0 && firstPublishTiming.enabled && firstPublishTiming.generation === token;
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
  const closed = intervalUnionOverlapMs(start, end, firstPublishTiming.uploadIntervals);
  const open = firstPublishTiming.uploadOpenAt > 0
    ? Math.max(0, end - Math.max(start, firstPublishTiming.uploadOpenAt))
    : 0;
  return closed + open;
}
export function firstPublishAuthStart(): number {
  if (!firstPublishTiming.enabled) return 0;
  const t = performance.now();
  firstPublishTiming.stats.authCallCount++;
  if (!firstPublishTiming.authStartedAt) firstPublishTiming.authStartedAt = t;
  return t;
}
export function firstPublishAuthEnd(): void {
  if (firstPublishTiming.enabled) firstPublishTiming.authEndedAt = performance.now();
}
export function finishFirstPublishStats(): FirstPublishStats | undefined {
  if (!firstPublishTiming.enabled) return undefined;
  // (design 108): finalization ALWAYS disables the singleton —
  // even when it yields no stats — so a no-upload push can't leak timing into later work.
  firstPublishTiming.enabled = false;
  // Render when there was a real upload critical path OR a command-level files-synced
  // milestone (design 108 §3.6): a 409/422-retry success re-uploads nothing yet must still
  // emit the headline timeToFilesSyncedMs — the files DID sync, on the earlier attempt.
  if (!firstPublishTiming.firstUploadAt && !firstPublishTiming.stats.timeToFilesSyncedMs) return undefined;
  const s = firstPublishTiming.stats;
  s.uploadCriticalPathMs = Math.max(0, Math.round(firstPublishTiming.uploadEndedAt - firstPublishTiming.uploadStartedAt));
  s.authCriticalPathMs = Math.max(0, Math.round(firstPublishTiming.authEndedAt - firstPublishTiming.authStartedAt));
  return { ...s };
}

export function formatFirstPublishStats(s: FirstPublishStats): string {
  return `fp filesSynced${s.timeToFilesSyncedMs} ready${s.timeToFirstReadyCiphertextMs} wait${s.firstReadyToFirstUploadStartMs} enc${s.encryptWallMs} miss${s.missingCheckWallMs} up${s.uploadCriticalPathMs} redeem${s.receiptRedemptionWallMs} redeemOverlap${s.receiptRedemptionOverlapMs} commit${s.commitWallMs} finalDrain${s.finalDrainMs} rreq${s.redeemRequestCount} rcpt${s.redeemReceiptCount} rentB${s.redeemMaxEntryBytes} rreqB${s.redeemMaxRequestBytes} flush${s.finalFlushMs} authn${s.authCallCount} authms${s.authCriticalPathMs} temp${s.peakTempDiskBytes} queue${s.peakQueueHeapBytes} frame${s.peakUploaderFramingBytes} unsat${s.serverUnsatisfiedTotal} skip${s.serverSatisfiedSkipped} uniq${s.uniqueEncryptions} dup${s.duplicateEncryptions} resume${s.reEncryptedOnResume} cpu${s.producerCpuSaturationPct}`;
}

export function uploadLaneTimingSummary(): string | undefined {
  if (!LANE_TIMING || uploadLaneTiming.blobs === 0) return undefined;
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
  return `lane timing (push): ${n} blobs · encrypt ${(e / 1000).toFixed(1)}s (${encryptPct}%) · upload ${(u / 1000).toFixed(1)}s (${uploadPct}%)${queue} · per-blob encrypt ${(e / n).toFixed(1)}ms / upload ${(u / n).toFixed(1)}ms${dispatch}`;
}
