import { afterEach, expect, test } from "bun:test";
import type { ApplyStats } from "../engine/apply-stats.js";
import { formatGitApplyMetrics, type GitApplyMetrics, type GitApplyRepoResult, type GitApplyRepoTiming } from "./sync-git.js";
import { formatApplyStats } from "./sync.js";

const originalDebug = process.env.RBOX_DEBUG;

afterEach(() => {
  if (originalDebug === undefined) delete process.env.RBOX_DEBUG;
  else process.env.RBOX_DEBUG = originalDebug;
});

const results = (overrides: Partial<Record<GitApplyRepoResult, number>> = {}): Record<GitApplyRepoResult, number> => ({
  unchanged: 0,
  applied: 0,
  deferred: 0,
  conflict: 0,
  removed: 0,
  skipped: 0,
  ...overrides,
});

const metricsWith = (repoTimings: GitApplyRepoTiming[], resultCounts: Partial<Record<GitApplyRepoResult, number>> = {}): GitApplyMetrics => ({
  runKind: "steady",
  repos: repoTimings.length,
  commonDirGroups: 0,
  results: results(resultCounts),
  repoTimings,
});

function exemplarIndexes(detail: string): number[] {
  const repoBits = detail.split(" repoMs=")[1]!;
  return [...repoBits.matchAll(/(?:^|,)i(\d+)q/g)].map((match) => Number(match[1]));
}

test("apply and git metric formats are numeric and path-free", () => {
  delete process.env.RBOX_DEBUG;
  const stats: ApplyStats = {
    mkdirCalls: 8, mkdirCreated: 2, dirComponentWalks: 11, uniqueDirs: 2,
    lstatCalls: 9, renameCalls: 6, stageCalls: 3, preflightMs: 420, writePoolMs: 11900,
    smallCount: 2, smallBytes: 48200000, smallStageMs: 20,
    largeCount: 1, largeBytes: 4100000000, largeStageMs: 30,
  };
  const detail = formatApplyStats(stats);
  expect(detail).toMatch(/^mk\d+\/cr\d+ walk\d+ uniq\d+ ls\d+ rn\d+ stg\d+ pre\d+\.\d+s pool\d+\.\d+s sm\d+n\/[\d.]+(?:B|KB|MB|GB) lg\d+n\/[\d.]+(?:B|KB|MB|GB)$/);
  expect(detail).not.toContain("alpha");
  expect(detail).not.toContain("secret.txt");

  const metrics: GitApplyMetrics = {
    runKind: "fresh", repos: 1, commonDirGroups: 0,
    results: { unchanged: 0, applied: 1, deferred: 0, conflict: 0, removed: 0, skipped: 0 },
    repoTimings: [{ index: 0, queueMs: 5, wallMs: 1234, result: "applied", chain: {
      chainLength: 3, fetchDecryptMs: 820.2, bundleVerifyMs: 40.4, gitImportMs: 3200.1, indexOpStateMs: 30.2,
    } }],
  };
  const gitDetail = formatGitApplyMetrics(metrics);
  expect(gitDetail).toContain("queueMs p50=5 p95=5 max=5 wallMs p50=1234 p95=1234 max=1234");
  expect(gitDetail).toContain("fetchDecryptMs p50=820 p95=820 max=820 bundleVerifyMs p50=40 p95=40 max=40 gitImportMs p50=3200 p95=3200 max=3200 indexOpStateMs p50=30 p95=30 max=30");
  expect(gitDetail).toContain("L3fd820bv40gi3200io30");
  expect(gitDetail).not.toContain("private-repo");
  expect(gitDetail).not.toContain("/");
});

test("git metrics select at most eight deterministic deduplicated exemplars", () => {
  delete process.env.RBOX_DEBUG;
  const timings: GitApplyRepoTiming[] = [
    { index: 9, queueMs: 700, wallMs: 700, result: "unchanged" },
    { index: 2, queueMs: 30, wallMs: 120, result: "deferred", chain: {
      chainLength: 2, fetchDecryptMs: 15, bundleVerifyMs: 25, gitImportMs: 35, indexOpStateMs: 45,
    } },
    { index: 7, queueMs: 900, wallMs: 160, result: "unchanged" },
    { index: 4, queueMs: 50, wallMs: 1000, result: "unchanged", chain: {
      chainLength: 0, fetchDecryptMs: 0, bundleVerifyMs: 0, gitImportMs: 0, indexOpStateMs: 0,
    } },
    { index: 1, queueMs: 20, wallMs: 110, result: "applied" },
    { index: 11, queueMs: 500, wallMs: 500, result: "unchanged" },
    { index: 0, queueMs: 10, wallMs: 100, result: "unchanged" },
    { index: 8, queueMs: 800, wallMs: 800, result: "unchanged" },
    { index: 5, queueMs: 60, wallMs: 1000, result: "unchanged" },
    { index: 3, queueMs: 40, wallMs: 130, result: "unchanged" },
    { index: 6, queueMs: 900, wallMs: 150, result: "unchanged" },
    { index: 10, queueMs: 600, wallMs: 600, result: "unchanged" },
  ];
  const metrics = metricsWith(timings, { unchanged: 10, applied: 1, deferred: 1 });
  const before = structuredClone(metrics);

  const detail = formatGitApplyMetrics(metrics);

  expect(exemplarIndexes(detail)).toEqual([1, 2, 4, 5, 6, 7, 8, 9]);
  expect(metrics).toEqual(before);
});

test("git metrics retain result aggregates when anomalies exceed exemplar capacity", () => {
  delete process.env.RBOX_DEBUG;
  const timings: GitApplyRepoTiming[] = Array.from({ length: 12 }, (_, index) => ({
    index,
    queueMs: index === 8 || index === 9 ? 10_000 : index,
    wallMs: index === 10 || index === 11 ? 20_000 : index,
    result: index < 8 ? "applied" as const : "unchanged" as const,
  }));
  const detail = formatGitApplyMetrics(metricsWith(timings, { applied: 8, unchanged: 4 }));

  expect(detail).toContain("results=unchanged=4,applied=8");
  expect(exemplarIndexes(detail)).toEqual([0, 1, 2, 3, 4, 5, 8, 10]);
});

test("git metric aggregates preserve the uniform wall floor and queue ramp", () => {
  delete process.env.RBOX_DEBUG;
  const timings: GitApplyRepoTiming[] = Array.from({ length: 98 }, (_, index) => ({
    index,
    queueMs: Math.round(index * 1500 / 97),
    wallMs: Math.round(85 + index * 110 / 97),
    result: "unchanged",
  }));
  const detail = formatGitApplyMetrics(metricsWith(timings, { unchanged: 98 }));

  expect(detail).toContain("queueMs p50=742 p95=1438 max=1500");
  expect(detail).toContain("wallMs p50=139 p95=190 max=195");
  expect(exemplarIndexes(detail)).toHaveLength(8);
});

test("git metric chain aggregates use only positive-length fresh chains and round values", () => {
  delete process.env.RBOX_DEBUG;
  const timings: GitApplyRepoTiming[] = [
    { index: 0, queueMs: 1.2, wallMs: 10.2, result: "unchanged", chain: {
      chainLength: 0, fetchDecryptMs: 0, bundleVerifyMs: 0, gitImportMs: 0, indexOpStateMs: 0,
    } },
    { index: 1, queueMs: 2.5, wallMs: 20.5, result: "applied", chain: {
      chainLength: 2, fetchDecryptMs: 10.4, bundleVerifyMs: 20.4, gitImportMs: 30.4, indexOpStateMs: 40.4,
    } },
    { index: 2, queueMs: 3.7, wallMs: 30.7, result: "applied", chain: {
      chainLength: 3, fetchDecryptMs: 100.6, bundleVerifyMs: 200.6, gitImportMs: 300.6, indexOpStateMs: 400.6,
    } },
  ];
  const detail = formatGitApplyMetrics(metricsWith(timings, { unchanged: 1, applied: 2 }));

  expect(detail).toContain("queueMs p50=3 p95=4 max=4 wallMs p50=21 p95=31 max=31");
  expect(detail).toContain("fetchDecryptMs p50=10 p95=101 max=101 bundleVerifyMs p50=20 p95=201 max=201 gitImportMs p50=30 p95=301 max=301 indexOpStateMs p50=40 p95=401 max=401");
});

test("git metrics omit chain aggregates when no fresh chain ran", () => {
  delete process.env.RBOX_DEBUG;
  const detail = formatGitApplyMetrics(metricsWith([
    { index: 0, queueMs: 0, wallMs: 1, result: "unchanged", chain: {
      chainLength: 0, fetchDecryptMs: 0, bundleVerifyMs: 0, gitImportMs: 0, indexOpStateMs: 0,
    } },
  ], { unchanged: 1 }));

  expect(detail).not.toContain("fetchDecryptMs");
  expect(detail).not.toContain("bundleVerifyMs");
  expect(detail).not.toContain("gitImportMs");
  expect(detail).not.toContain("indexOpStateMs");
});

test("truthy RBOX_DEBUG preserves the full per-repo timing line", () => {
  process.env.RBOX_DEBUG = "0";
  const timings: GitApplyRepoTiming[] = Array.from({ length: 12 }, (_, index) => ({
    index,
    queueMs: index,
    wallMs: index * 2,
    result: "unchanged",
  }));
  const detail = formatGitApplyMetrics(metricsWith(timings, { unchanged: 12 }));

  expect(exemplarIndexes(detail)).toEqual(Array.from({ length: 12 }, (_, index) => index));
});

test("git metrics render empty distributions and no exemplars", () => {
  delete process.env.RBOX_DEBUG;
  const detail = formatGitApplyMetrics(metricsWith([]));

  expect(detail).toContain("queueMs p50=0 p95=0 max=0 wallMs p50=0 p95=0 max=0");
  expect(detail).toEndWith("repoMs=none");
});
