import { expect, test } from "bun:test";
import type { ApplyStats } from "../engine/apply-stats.js";
import { formatGitApplyMetrics, type GitApplyMetrics } from "./sync-git.js";
import { formatApplyStats } from "./sync.js";

test("apply and git metric formats are numeric and path-free", () => {
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
  expect(gitDetail).toContain("L3fd820bv40gi3200io30");
  expect(gitDetail).not.toContain("private-repo");
  expect(gitDetail).not.toContain("/");
});
