import { expect, test } from "bun:test";
import { assessIdle, IDLE_BUDGETS } from "./budgets.js";

/** Build a stats sample: cumulative CPU usec + wall ts + RSS. */
function sample(tsMs: number, cpuUsec: number, memMB: number) {
  return { ts: new Date(tsMs).toISOString(), cpuUsageUsec: cpuUsec, memoryUsageBytes: memMB * 1024 * 1024 };
}

test("assessIdle derives mean/peak CPU% and peak mem over the window", () => {
  const t0 = 1_000_000;
  // 4 samples 2s apart, +20000 usec (0.02 core-s) per 2s interval → 1% per interval.
  const samples = [
    sample(t0, 1_000_000, 100),
    sample(t0 + 2000, 1_020_000, 110),
    sample(t0 + 4000, 1_040_000, 105),
    sample(t0 + 6000, 1_060_000, 120),
  ];
  const a = assessIdle(samples, t0, t0 + 6000);
  expect(a.samples).toBe(4);
  expect(a.spanSeconds).toBe(6);
  // 3 intervals × 0.02 core-s = 0.06 core-s over 6s → 1% mean; each interval is 1% → 1% peak.
  expect(a.meanCpuPct).toBeCloseTo(1, 5);
  expect(a.peakCpuPct).toBeCloseTo(1, 5);
  expect(a.peakMemMB).toBeCloseTo(120, 5);
  expect(a.withinBudget).toBe(true);
});

test("assessIdle derives Docker instant-percent mean and peak end-to-end", () => {
  const t0 = 1_500_000;
  const base = { name: "rig-dev-a", runner: "docker" as const };
  const samples = [
    { ...base, ts: new Date(t0).toISOString(), memBytes: 100 * 1024 * 1024, cpu: { kind: "instant-percent" as const, pct: 1 } },
    { ...base, ts: new Date(t0 + 2000).toISOString(), memBytes: 110 * 1024 * 1024, cpu: { kind: "instant-percent" as const, pct: 2 } },
    { ...base, ts: new Date(t0 + 4000).toISOString(), memBytes: 105 * 1024 * 1024, cpu: { kind: "instant-percent" as const, pct: 4 } },
  ];
  const a = assessIdle(samples, t0, t0 + 4000);
  expect(a.meanCpuPct).toBeCloseTo(3, 5);
  expect(a.peakCpuPct).toBe(4);
  expect(a.peakMemMB).toBe(110);
  expect(a.withinBudget).toBe(true);
});

test("assessIdle excludes samples outside the soak window (a pre-soak CPU spike doesn't count)", () => {
  const t0 = 2_000_000;
  const samples = [
    // A big pre-window jump that would blow the budget if counted.
    sample(t0 - 4000, 0, 100),
    sample(t0 - 2000, 5_000_000, 100),
    // In-window quiet series.
    sample(t0, 5_000_000, 100),
    sample(t0 + 2000, 5_020_000, 100),
    sample(t0 + 4000, 5_040_000, 100),
  ];
  const a = assessIdle(samples, t0, t0 + 4000);
  expect(a.samples).toBe(3);
  expect(a.peakCpuPct).toBeCloseTo(1, 5); // only the in-window 1%/interval survives
  expect(a.withinBudget).toBe(true);
});

test("assessIdle flags a busy window as over budget (CPU only — guest mem is context)", () => {
  const t0 = 3_000_000;
  // +2_000_000 usec (2 core-s) per 2s interval → 100% of a core, over the 5% mean budget.
  const samples = [sample(t0, 0, 100), sample(t0 + 2000, 2_000_000, 100), sample(t0 + 4000, 4_000_000, 600)];
  const a = assessIdle(samples, t0, t0 + 4000);
  expect(a.meanCpuPct).toBeGreaterThan(IDLE_BUDGETS.meanCpuPctMax);
  expect(a.peakMemMB).toBeCloseTo(600, 5); // reported for context, never a budget input
  expect(a.withinBudget).toBe(false);
});

test("assessIdle: a mem-heavy but CPU-quiet window stays within budget (ballooned page cache must not fail the daemon)", () => {
  const t0 = 4_000_000;
  const samples = [sample(t0, 0, 900), sample(t0 + 2000, 20_000, 900), sample(t0 + 4000, 40_000, 900)];
  expect(assessIdle(samples, t0, t0 + 4000).withinBudget).toBe(true);
});

test("assessIdle on an empty/singleton window is quiet (no interval to measure)", () => {
  expect(assessIdle([], 0, 1000).withinBudget).toBe(true);
  expect(assessIdle([{ ts: new Date(0).toISOString(), cpuUsageUsec: 1, memoryUsageBytes: 1 }], 0, 1000).meanCpuPct).toBe(0);
});

test("provisional budgets are the documented ceilings", () => {
  expect(IDLE_BUDGETS.meanCpuPctMax).toBe(5);
  expect(IDLE_BUDGETS.peakCpuPctMax).toBe(25);
  expect(IDLE_BUDGETS.daemonPeakRssMbMax).toBe(512);
});
