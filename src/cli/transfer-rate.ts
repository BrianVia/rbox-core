import type { TransferProgressBytes } from "./transfer-progress.js";

export interface ByteRateSample {
  timestampMs: number;
  bytes: number;
}

export interface ByteRateEstimate {
  bytesPerSecond?: number;
  etaSeconds?: number;
}

const WINDOW_MS = 5_000;
const STABLE_MS = 3_000;
const MAX_RATE_RATIO = 3;
const SAMPLE_INTERVAL_MS = 250;

/** Pure sliding-window estimate. ETA is withheld until both halves of a >=3s
 * window are advancing at comparable rates. */
export function estimateByteRate(samples: readonly ByteRateSample[], bytesTotal?: number): ByteRateEstimate {
  if (samples.length < 2) return {};
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    const previous = samples[index - 1];
    if (!Number.isFinite(sample.timestampMs) || !Number.isFinite(sample.bytes) || sample.bytes < 0 ||
        (previous && (sample.timestampMs < previous.timestampMs || sample.bytes < previous.bytes))) return {};
  }
  const last = samples.at(-1)!;
  const firstIndex = samples.findIndex((sample) => sample.timestampMs >= last.timestampMs - WINDOW_MS);
  const window = samples.slice(Math.max(0, firstIndex));
  const first = window[0]!;
  const elapsedMs = last.timestampMs - first.timestampMs;
  const advanced = last.bytes - first.bytes;
  if (elapsedMs <= 0 || advanced <= 0) return {};
  const bytesPerSecond = advanced * 1_000 / elapsedMs;
  const result: ByteRateEstimate = { bytesPerSecond };
  if (elapsedMs < STABLE_MS || bytesTotal === undefined || bytesTotal <= last.bytes) return result;

  const midpointMs = first.timestampMs + elapsedMs / 2;
  let midpoint = first;
  for (const sample of window) {
    if (sample.timestampMs > midpointMs) break;
    midpoint = sample;
  }
  const firstElapsed = midpoint.timestampMs - first.timestampMs;
  const secondElapsed = last.timestampMs - midpoint.timestampMs;
  const firstRate = firstElapsed > 0 ? (midpoint.bytes - first.bytes) * 1_000 / firstElapsed : 0;
  const secondRate = secondElapsed > 0 ? (last.bytes - midpoint.bytes) * 1_000 / secondElapsed : 0;
  if (firstRate <= 0 || secondRate <= 0 || Math.max(firstRate, secondRate) / Math.min(firstRate, secondRate) > MAX_RATE_RATIO) return result;
  result.etaSeconds = Math.max(0, Math.round((bytesTotal - last.bytes) / bytesPerSecond));
  return result;
}

/** Tiny phase-local sampler. Regressions are legitimate during retry/retraction,
 * so they start a fresh window instead of producing a negative rate. */
export class TransferRateSampler {
  private samples: ByteRateSample[] = [];

  sample(bytes: TransferProgressBytes, timestampMs = Date.now()): TransferProgressBytes {
    if (!Number.isFinite(timestampMs) || !Number.isFinite(bytes.bytesDone) || bytes.bytesDone < 0) {
      this.samples = [];
      return { ...bytes };
    }
    let last = this.samples.at(-1);
    if (last && (timestampMs < last.timestampMs || bytes.bytesDone < last.bytes)) {
      this.samples = [];
      last = undefined;
    }
    const current = { timestampMs, bytes: bytes.bytesDone };
    if (last && timestampMs - last.timestampMs < SAMPLE_INTERVAL_MS) this.samples[this.samples.length - 1] = { timestampMs: last.timestampMs, bytes: bytes.bytesDone };
    else this.samples.push(current);
    const cutoff = timestampMs - WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1]!.timestampMs < cutoff) this.samples.shift();
    return { ...bytes, ...estimateByteRate(this.samples, bytes.bytesTotal) };
  }
}
