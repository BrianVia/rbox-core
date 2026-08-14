import { expect, test } from "bun:test";
import { PhaseReport } from "../../engine/index.js";
import { SYNC_PHASE_GAP_KEYS, SYNC_PHASE_GAP_TRANSITIONS, type TelemetrySample } from "./contract.js";
import { SYNC_PHASE_SAMPLE_EVERY, SyncPhaseSampler } from "./sync-phase.js";

test("sync_phase samples every eighth completed pull and push independently", () => {
  const sampler = new SyncPhaseSampler();
  const samples: TelemetrySample[] = [];
  const telemetry = { record: (sample: TelemetrySample) => samples.push(sample) };
  for (let i = 0; i < SYNC_PHASE_SAMPLE_EVERY - 1; i++) {
    sampler.recordCompleted(PhaseReport.pull(), "pull", telemetry);
    sampler.recordCompleted(PhaseReport.push(), "push", telemetry);
  }
  expect(samples).toEqual([]);
  const pull = PhaseReport.pull();
  pull.record("latest", { count: 1 });
  sampler.recordCompleted(pull, "pull", telemetry);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ kind: "sync_phase", op: "pull", phases: { latest: 0 } });
  expect(JSON.stringify(samples[0])).not.toContain("repo");

  sampler.recordCompleted(PhaseReport.push(), "push", telemetry);
  expect(samples).toHaveLength(2);
  expect(samples[1]).toMatchObject({ kind: "sync_phase", op: "push" });
});

test("push samples preserve phase gaps, tail, and daemon residuals", async () => {
  const sampler = new SyncPhaseSampler();
  const samples: TelemetrySample[] = [];
  for (let i = 0; i < SYNC_PHASE_SAMPLE_EVERY - 1; i++) {
    sampler.recordCompleted(PhaseReport.push(), "push", { record: (sample) => samples.push(sample) });
  }
  const report = PhaseReport.push();
  await report.phase("state-load", async () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  await report.phase("git-plan", async () => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  sampler.recordCompleted(report, "push", { record: (sample) => samples.push(sample) }, { prologue_ms: 11.2, settle_ms: 12.8 });
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({
    kind: "sync_phase",
    op: "push",
    gaps: { "gap:state-load→git-plan": expect.any(Number), tailMs: expect.any(Number) },
    prologue_ms: 11,
    settle_ms: 13,
  });
});

test("push gap projection preserves the complete bounded producer contract atomically", () => {
  const record = (report: PhaseReport): TelemetrySample[] => {
    const sampler = new SyncPhaseSampler();
    const samples: TelemetrySample[] = [];
    for (let i = 0; i < 7; i++) sampler.recordCompleted(PhaseReport.push(), "push", { record: (sample) => samples.push(sample) });
    sampler.recordCompleted(report, "push", { record: (sample) => samples.push(sample) });
    return samples;
  };

  const maximum = PhaseReport.push();
  const gaps = Reflect.get(maximum, "gaps") as Map<string, number>;
  for (const [index, transition] of SYNC_PHASE_GAP_TRANSITIONS.entries()) gaps.set(transition, index);
  expect(Object.keys(record(maximum)[0]?.gaps ?? {}).sort()).toEqual([...SYNC_PHASE_GAP_KEYS].sort());

  const impossible = PhaseReport.push();
  const impossibleGaps = Reflect.get(impossible, "gaps") as Map<string, number>;
  impossibleGaps.set("state-load→start", 1);
  expect(record(impossible)).toEqual([]);
});

test("sync_phase always emits strict tail outliers and projects path-free git aggregates", () => {
  const sampler = new SyncPhaseSampler();
  const samples: TelemetrySample[] = [];
  const report = PhaseReport.pull();
  (report as unknown as { startedAt: number }).startedAt = Date.now() - 20_001;
  report.recordDetails("git-apply", { gitApply: {
    repoTimings: [{ relPath: "/private/repo", wallMs: 31 }, { wallMs: 47 }],
    results: { skipped: 3 },
  } });
  sampler.recordCompleted(report, "pull", { record: (sample) => samples.push(sample) });
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({
    kind: "sync_phase", op: "pull", gitApplyMaxRepoMs: 47, gitApplySkippedHeld: 3,
  });
  expect(JSON.stringify(samples[0])).not.toContain("private");
});

test("sync_phase uses strict per-op thresholds and emits once when cadence and outlier coincide", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 100_000;
    const exactSampler = new SyncPhaseSampler();
    const exact: TelemetrySample[] = [];
    const pull = PhaseReport.pull();
    (pull as unknown as { startedAt: number }).startedAt = 80_000;
    exactSampler.recordCompleted(pull, "pull", { record: (sample) => exact.push(sample) });
    const push = PhaseReport.push();
    (push as unknown as { startedAt: number }).startedAt = 85_000;
    exactSampler.recordCompleted(push, "push", { record: (sample) => exact.push(sample) });
    expect(exact).toEqual([]);

    const sampler = new SyncPhaseSampler();
    const samples: TelemetrySample[] = [];
    for (let i = 0; i < 7; i++) sampler.recordCompleted(PhaseReport.push(), "push", { record: (sample) => samples.push(sample) });
    const outlier = PhaseReport.push();
    (outlier as unknown as { startedAt: number }).startedAt = 84_999;
    sampler.recordCompleted(outlier, "push", { record: (sample) => samples.push(sample) });
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ kind: "sync_phase", op: "push", wallMs: 15_001 });
  } finally {
    Date.now = originalNow;
  }
});
