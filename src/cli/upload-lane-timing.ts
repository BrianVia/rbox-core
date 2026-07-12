/** RBOX_LANE_TIMING=1 — push-side encrypt vs upload attribution. */
export const LANE_TIMING = process.env.RBOX_LANE_TIMING === "1";

export const uploadLaneTiming = { encryptMs: 0, uploadMs: 0, queueMs: 0, blobs: 0, bytes: 0 };

export interface FirstPublishStats {
  timeToFirstReadyCiphertextMs: number;
  firstReadyToFirstUploadStartMs: number;
  encryptWallMs: number;
  missingCheckWallMs: number;
  uploadCriticalPathMs: number;
  receiptRedemptionWallMs: number;
  commitWallMs: number;
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
  timeToFirstReadyCiphertextMs: 0, firstReadyToFirstUploadStartMs: 0,
  encryptWallMs: 0, missingCheckWallMs: 0, uploadCriticalPathMs: 0,
  receiptRedemptionWallMs: 0, commitWallMs: 0, receiptRedemptionOverlapMs: 0,
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
  stats: zeroFirstPublishStats(),
  startedAt: 0,
  firstReadyAt: 0,
  firstUploadAt: 0,
  uploadStartedAt: 0,
  uploadEndedAt: 0,
  uploadActive: 0,
  tempBytes: 0,
  authStartedAt: 0,
  authEndedAt: 0,
  encryptedAddresses: new Set<string>(),
  checkedAddresses: new Set<string>(),
};

export function beginFirstPublishTiming(enabled: boolean): void {
  firstPublishTiming.enabled = enabled;
  if (!enabled) return;
  firstPublishTiming.stats = zeroFirstPublishStats();
  firstPublishTiming.startedAt = performance.now();
  firstPublishTiming.firstReadyAt = firstPublishTiming.firstUploadAt = 0;
  firstPublishTiming.uploadStartedAt = firstPublishTiming.uploadEndedAt = 0;
  firstPublishTiming.uploadActive = 0;
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
  firstPublishTiming.uploadActive++;
  return t;
}
export function firstPublishUploadEnd(): void {
  if (firstPublishTiming.enabled) {
    firstPublishTiming.uploadEndedAt = performance.now();
    firstPublishTiming.uploadActive = Math.max(0, firstPublishTiming.uploadActive - 1);
  }
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
  if (!firstPublishTiming.enabled || !firstPublishTiming.firstUploadAt) return undefined;
  const s = firstPublishTiming.stats;
  s.uploadCriticalPathMs = Math.max(0, Math.round(firstPublishTiming.uploadEndedAt - firstPublishTiming.uploadStartedAt));
  s.authCriticalPathMs = Math.max(0, Math.round(firstPublishTiming.authEndedAt - firstPublishTiming.authStartedAt));
  firstPublishTiming.enabled = false;
  return { ...s };
}

export function formatFirstPublishStats(s: FirstPublishStats): string {
  return `fp ready${s.timeToFirstReadyCiphertextMs} wait${s.firstReadyToFirstUploadStartMs} enc${s.encryptWallMs} miss${s.missingCheckWallMs} up${s.uploadCriticalPathMs} redeem${s.receiptRedemptionWallMs} commit${s.commitWallMs} authn${s.authCallCount} authms${s.authCriticalPathMs} temp${s.peakTempDiskBytes} queue${s.peakQueueHeapBytes} frame${s.peakUploaderFramingBytes} unsat${s.serverUnsatisfiedTotal} skip${s.serverSatisfiedSkipped} uniq${s.uniqueEncryptions} dup${s.duplicateEncryptions} resume${s.reEncryptedOnResume} cpu${s.producerCpuSaturationPct}`;
}

export function uploadLaneTimingSummary(): string | undefined {
  if (!LANE_TIMING || uploadLaneTiming.blobs === 0) return undefined;
  const e = uploadLaneTiming.encryptMs, u = uploadLaneTiming.uploadMs, q = uploadLaneTiming.queueMs, n = uploadLaneTiming.blobs;
  const active = e + u;
  const encryptPct = active > 0 ? ((e / active) * 100).toFixed(0) : "0";
  const uploadPct = active > 0 ? ((u / active) * 100).toFixed(0) : "0";
  const queue = q > 0 ? ` · queue ${(q / 1000).toFixed(1)}s` : "";
  return `lane timing (push): ${n} blobs · encrypt ${(e / 1000).toFixed(1)}s (${encryptPct}%) · upload ${(u / 1000).toFixed(1)}s (${uploadPct}%)${queue} · per-blob encrypt ${(e / n).toFixed(1)}ms / upload ${(u / n).toFixed(1)}ms`;
}
