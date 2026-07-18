import { expect, test } from "bun:test";
import { estimateByteRate, TransferRateSampler } from "./transfer-rate.js";

test("estimateByteRate computes a five-second steady rate and ETA", () => {
  const samples = [0, 1, 2, 3, 4, 5].map((seconds) => ({ timestampMs: seconds * 1_000, bytes: seconds * 10_000_000 }));
  expect(estimateByteRate(samples, 90_000_000)).toEqual({ bytesPerSecond: 10_000_000, etaSeconds: 4 });
});

test("estimateByteRate exposes early throughput but withholds premature or unstable ETA", () => {
  expect(estimateByteRate([{ timestampMs: 0, bytes: 0 }, { timestampMs: 2_000, bytes: 20_000_000 }], 100_000_000))
    .toEqual({ bytesPerSecond: 10_000_000 });
  expect(estimateByteRate([
    { timestampMs: 0, bytes: 0 },
    { timestampMs: 2_000, bytes: 1_000_000 },
    { timestampMs: 4_000, bytes: 20_000_000 },
  ], 100_000_000).etaSeconds).toBeUndefined();
  expect(estimateByteRate([{ timestampMs: 0, bytes: 5 }, { timestampMs: 5_000, bytes: 5 }], 100)).toEqual({});
});

test("TransferRateSampler resets its window on byte regression", () => {
  const sampler = new TransferRateSampler();
  sampler.sample({ bytesDone: 0, bytesTotal: 100 }, 0);
  sampler.sample({ bytesDone: 50, bytesTotal: 100 }, 4_000);
  expect(sampler.sample({ bytesDone: 0, bytesTotal: 100 }, 5_000)).toEqual({ bytesDone: 0, bytesTotal: 100 });
});
