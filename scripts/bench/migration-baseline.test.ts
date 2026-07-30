/**
 * The baseline FILE is checked; the wall clock is not.
 *
 * Design 222 §7.5 states a duration bound, and the temptation is to assert it in
 * CI. A wall-clock assertion on a shared runner measures the runner, flakes,
 * gets muted, and then guards nothing. The gate is the recorded baseline plus
 * the manual `--update` workflow, so what a test can honestly own is that the
 * record exists, parses, names its corpus, carries the design bound, and keeps
 * the out-of-repo real-corpus datum labelled as unverifiable here.
 */
import { expect, test } from "bun:test";
import { BENCH_CORPUS, readBaseline, summarize } from "./migration-baseline";

test("the migration baseline is well formed and records the §7.5 design bound", () => {
  const baseline = readBaseline();

  expect(baseline.version).toBe(1);
  expect(baseline.designBoundSecondsOnCorpus112k).toBe(60);
  expect(baseline.toleranceRatio).toBeGreaterThan(1);
  expect(baseline.corpus).toEqual({ ...BENCH_CORPUS });
  expect(baseline.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  for (const [label, summary] of [["total", baseline.total], ...Object.entries(baseline.phases)] as const) {
    expect(summary.samples, label).toBeGreaterThan(0);
    expect(summary.p50Ms, label).toBeGreaterThan(0);
    expect(summary.p95Ms, label).toBeGreaterThanOrEqual(summary.p50Ms);
  }
  // Every M0–M7 phase has a row, so a phase that stops reporting progress shows
  // up as a missing baseline entry rather than as a silently faster migration.
  for (const phase of ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"]) {
    expect(Object.keys(baseline.phases), phase).toContain(phase);
  }
});

test("the real-corpus reference row stays labelled as an out-of-repo, uncheckable datum", () => {
  const reference = readBaseline().referenceCorpus;
  // The 5C datum: 81 MB / 145,913 entries / 101 repos in 38 s, against a 60 s
  // bound. Nothing in this repo can reproduce it, and the record has to say so.
  expect(reference.entries).toBe(145_913);
  expect(reference.repos).toBe(101);
  expect(reference.durationSeconds).toBe(38);
  expect(reference.machineCheckable).toBe(false);
  expect(reference.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(reference.note).toMatch(/OUT-OF-REPO/);
});

test("the percentile summary is the ordinary one", () => {
  expect(summarize([5, 1, 3])).toEqual({ p50Ms: 3, p95Ms: 5, samples: 3 });
  expect(summarize([2])).toEqual({ p50Ms: 2, p95Ms: 2, samples: 1 });
});
