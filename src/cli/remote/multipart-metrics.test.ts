import { afterEach, describe, expect, test } from "bun:test";
import {
  MultipartMetrics,
  readMultipartServerTimings,
  resetMultipartMetricsSinkForTests,
  setMultipartMetricsSink,
} from "./multipart-metrics.js";

afterEach(() => resetMultipartMetricsSinkForTests());

describe("readMultipartServerTimings", () => {
  const valid = { totalMs: 100, assembleMs: 20, rereadPutMs: 70, accountingMs: 10 };

  test("accepts a complete finite, non-negative object and ignores extra keys", () => {
    expect(readMultipartServerTimings({ ...valid, ignored: "value" })).toEqual(valid);
  });

  test.each([
    undefined,
    null,
    {},
    { totalMs: 100, assembleMs: 20, rereadPutMs: 70 },
    { ...valid, totalMs: -1 },
    { ...valid, assembleMs: "20" },
    { ...valid, rereadPutMs: Number.NaN },
    { ...valid, accountingMs: Number.POSITIVE_INFINITY },
  ])("rejects absent, partial, negative, and non-finite values", (value) => {
    expect(readMultipartServerTimings(value)).toBeUndefined();
  });
});

describe("MultipartMetrics", () => {
  test("aggregates walls and gaps using nearest-rank percentiles", () => {
    const metrics = new MultipartMetrics(true);
    for (const ms of [50, 10, 40, 20, 30]) metrics.recordPartWall(ms);
    for (const ms of [4, 1, 3, 2]) metrics.recordGap(ms);
    metrics.setParts(5);
    metrics.setBytes(1234);
    metrics.addRetries(2);
    metrics.noteReInit();
    metrics.recordCompletionWall(17);

    expect(metrics.toTimings()).toEqual({
      parts: 5,
      retries: 2,
      reInits: 1,
      bytes: 1234,
      completionWallMs: 17,
      partWall: { p50: 30, p95: 50, max: 50, sum: 150 },
      gap: { p50: 2, p95: 4, max: 4, sum: 10 },
    });
  });

  test("empty samples produce zero aggregates", () => {
    const timings = new MultipartMetrics(true).toTimings();
    expect(timings.partWall).toEqual({ p50: 0, p95: 0, max: 0, sum: 0 });
    expect(timings.gap).toEqual({ p50: 0, p95: 0, max: 0, sum: 0 });
  });

  test("disabled instances accumulate nothing and never emit", () => {
    const lines: string[] = [];
    setMultipartMetricsSink((line) => lines.push(line));
    const metrics = new MultipartMetrics(false);
    metrics.recordPartWall(10);
    metrics.recordGap(3);
    metrics.addRetries(4);
    metrics.noteReInit();
    metrics.setBytes(99);
    metrics.setParts(2);
    metrics.recordCompletionWall(8);
    metrics.setServerTimings({ totalMs: 7, assembleMs: 1, rereadPutMs: 5, accountingMs: 1 });
    metrics.emit();

    expect(metrics.toTimings()).toEqual({
      parts: 0,
      retries: 0,
      reInits: 0,
      bytes: 0,
      completionWallMs: 0,
      partWall: { p50: 0, p95: 0, max: 0, sum: 0 },
      gap: { p50: 0, p95: 0, max: 0, sum: 0 },
    });
    expect(lines).toEqual([]);
  });
});
