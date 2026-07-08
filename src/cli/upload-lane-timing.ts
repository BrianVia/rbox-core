/** RBOX_LANE_TIMING=1 — push-side encrypt vs upload attribution. */
export const LANE_TIMING = process.env.RBOX_LANE_TIMING === "1";

export const uploadLaneTiming = { encryptMs: 0, uploadMs: 0, queueMs: 0, blobs: 0, bytes: 0 };

export function uploadLaneTimingSummary(): string | undefined {
  if (!LANE_TIMING || uploadLaneTiming.blobs === 0) return undefined;
  const e = uploadLaneTiming.encryptMs, u = uploadLaneTiming.uploadMs, q = uploadLaneTiming.queueMs, n = uploadLaneTiming.blobs;
  const active = e + u;
  const encryptPct = active > 0 ? ((e / active) * 100).toFixed(0) : "0";
  const uploadPct = active > 0 ? ((u / active) * 100).toFixed(0) : "0";
  const queue = q > 0 ? ` · queue ${(q / 1000).toFixed(1)}s` : "";
  return `lane timing (push): ${n} blobs · encrypt ${(e / 1000).toFixed(1)}s (${encryptPct}%) · upload ${(u / 1000).toFixed(1)}s (${uploadPct}%)${queue} · per-blob encrypt ${(e / n).toFixed(1)}ms / upload ${(u / n).toFixed(1)}ms`;
}
