import { expect, spyOn, test } from "bun:test";
import { PhaseReport } from "../engine/index.js";
import { formatPushResiduals } from "./sync/format.js";
import { beginFirstPublishTiming, firstPublishReady, formatFirstPublishStats } from "./upload-lane-timing.js";
import { PRE_PUSH_SPANS_DAEMON_LINE } from "./push-spans-output.fixture.js";
import { currentFirstPublishTiming, PushSpans, recordLaneSettlement, timePushTailRequest, type FirstPublishStats } from "./push-spans.js";

const firstPublish: FirstPublishStats = {
  timeToFilesSyncedMs: 1,
  timeToFirstReadyCiphertextMs: 2,
  firstReadyToFirstUploadStartMs: 3,
  encryptWallMs: 4,
  missingCheckWallMs: 5,
  uploadCriticalPathMs: 6,
  receiptRedemptionWallMs: 7,
  commitWallMs: 8,
  finalDrainMs: 9,
  redeemRequestCount: 10,
  redeemReceiptCount: 11,
  redeemMaxEntryBytes: 12,
  redeemMaxRequestBytes: 13,
  finalFlushMs: 14,
  receiptRedemptionOverlapMs: 15,
  authCallCount: 16,
  authCriticalPathMs: 17,
  peakTempDiskBytes: 18,
  peakQueueHeapBytes: 19,
  peakUploaderFramingBytes: 20,
  serverUnsatisfiedTotal: 21,
  serverSatisfiedSkipped: 22,
  uniqueEncryptions: 23,
  duplicateEncryptions: 24,
  reEncryptedOnResume: 25,
  producerCpuSaturationPct: 26,
};

test("complete daemon push line stays byte-identical to the pre-consolidation fixture", async () => {
  let now = 0;
  const dateNow = spyOn(Date, "now").mockImplementation(() => now);
  const memoryUsage = spyOn(process, "memoryUsage").mockReturnValue({
    rss: 1_234,
    heapTotal: 0,
    heapUsed: 1_024,
    external: 0,
    arrayBuffers: 0,
  });
  try {
    const report = PhaseReport.push();
    const spans = new PushSpans(report);
    await spans.run(async () => {
      report.files = 3;
      report.blobs = 2;
      await spans.span("state-load", async () => { now = 1_000; });
      spans.note("drain_wait_ms", 700);
      report.appendDetails("state-load", { prologue_ms: 100, settle_ms: 200 }, formatPushResiduals(100, 200));
      await spans.span("git-plan", async () => { now = 3_000; });
      report.recordDetails("git-plan", { base: true }, "git-plan-base");
      spans.note("projection_ms", 300);
      spans.note("projection_ignore_carry_ms", 40);
      spans.note("projection_casefold_ms", 50);
      spans.note("projection_sort_ms", 60);
      spans.note("projection_diff_ms", 70);
      spans.note("state_lineage_ms", 80);
      spans.note("matcher_ms", 90);
      report.recordDetails("missing", { base: true }, "missing-base");
      spans.recordTail("missing", 11, 8);
      spans.recordTail("missing", 13, 13);
      report.record("upload", { ciphertextBytes: 30, wireBytes: 20, changedBytes: 10 });
      report.recordDetails("upload", { firstPublish }, formatFirstPublishStats(firstPublish));
      await spans.span("commit", async () => { now = 3_500; });
      report.recordDetails("commit", { base: true }, "commit-base");
      spans.note("delta_base_ms", 100);
      spans.noteAttestation(false, "attested");
      spans.recordTail("commit", 17, 21);
      spans.recordTail("commit", 15, 13);
      await spans.span("state-save", async () => { now = 3_900; });
      spans.note("ack_ms", 110);
    });
    spans.note("publish_transition_ms", 120);
    expect(report.summaryLine()).toBe(PRE_PUSH_SPANS_DAEMON_LINE);
  } finally {
    dateNow.mockRestore();
    memoryUsage.mockRestore();
  }
});

test("nested tail wrappers deduplicate without suppressing concurrent siblings", async () => {
  const report = PhaseReport.push();
  const spans = new PushSpans(report);
  await spans.run(() => Promise.all([
    timePushTailRequest("missing", 11, () => timePushTailRequest("missing", 99, async () => "nested")),
    timePushTailRequest("missing", 13, async () => "sibling"),
  ]));
  expect(report.toJSON().phases.missing?.details).toMatchObject({ chunks: 2, payloadBytes: 24 });
});

test("a terminal push before state save reports one skipped attestation", async () => {
  const report = PhaseReport.push();
  const spans = new PushSpans(report);
  await expect(spans.run(async () => {
    await spans.span("commit", async () => {});
    spans.noteAttestation(true);
    throw new Error("terminal");
  })).rejects.toThrow("terminal");
  expect(report.summaryLine().match(/attest=/g)).toHaveLength(1);
  expect(report.summaryLine()).toContain("attest=hit/skipped");
});

test("concurrent push owners isolate every ambient sink", async () => {
  const reportA = PhaseReport.push();
  const reportB = PhaseReport.push();
  const lanesA: unknown[] = [];
  const lanesB: unknown[] = [];
  const spansA = new PushSpans(reportA, (samples) => lanesA.push(...samples));
  const spansB = new PushSpans(reportB, (samples) => lanesB.push(...samples));
  await Promise.all([
    spansA.run(async () => {
      beginFirstPublishTiming(true);
      firstPublishReady(10, "a");
      recordLaneSettlement("batch", 10, 2);
      await timePushTailRequest("missing", 11, async () => Promise.resolve());
    }),
    spansB.run(async () => {
      beginFirstPublishTiming(true);
      firstPublishReady(20, "b");
      recordLaneSettlement("single", 20, 3);
      await timePushTailRequest("commit", 13, async () => Promise.resolve());
    }),
  ]);
  expect(lanesA).toMatchObject([{ transport: "batch", bytes: 10, uploadMs: 2, opCount: 1 }]);
  expect(lanesB).toMatchObject([{ transport: "single", bytes: 20, uploadMs: 3, opCount: 1 }]);
  expect([...spansA.firstPublish.encryptedAddresses]).toEqual(["a"]);
  expect([...spansB.firstPublish.encryptedAddresses]).toEqual(["b"]);
  expect(reportA.toJSON().phases.missing?.details).toMatchObject({ chunks: 1, payloadBytes: 11 });
  expect(reportA.toJSON().phases.commit?.details).toBeUndefined();
  expect(reportB.toJSON().phases.commit?.details).toMatchObject({ chunks: 1, payloadBytes: 13 });
  expect(reportB.toJSON().phases.missing?.details).toBeUndefined();
});

test("disabled ambient producer lookup stays within the direct-check fast-path bound", () => {
  expect(currentFirstPublishTiming()).toBeUndefined();
  firstPublishReady(5, "outside");
  expect(currentFirstPublishTiming()).toBeUndefined();
  const timing = new PushSpans(PhaseReport.disabled("push")).firstPublish;
  const iterations = 100_000;
  const measure = (fn: () => void): number => {
    const samples: number[] = [];
    for (let run = 0; run < 5; run++) {
      const startedAt = performance.now();
      for (let index = 0; index < iterations; index++) fn();
      samples.push(performance.now() - startedAt);
    }
    samples.sort((a, b) => a - b);
    return samples[2]!;
  };
  const directMs = measure(() => { if (timing.enabled) throw new Error("disabled timing became enabled"); });
  const ambientMs = measure(() => { firstPublishReady(0); });
  expect(ambientMs).toBeLessThanOrEqual(directMs * 2 + 25);
});
