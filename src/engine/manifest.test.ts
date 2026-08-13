import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScanStats, DirCache, scanManifest, type ScanAttemptStats, type ScanStats } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-manifest-accounting-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "dir"));
  await fs.writeFile(path.join(root, "dir", "file.txt"), "payload");
  await fs.symlink("file.txt", path.join(root, "dir", "link"));
  return root;
}

const primarySum = (stats: Pick<ScanAttemptStats, "readdirMs" | "statMs" | "matcherMs" | "hashMs" | "sortMs">): number =>
  stats.readdirMs + stats.statMs + stats.matcherMs + stats.hashMs + stats.sortMs;

const residualSum = (stats: ScanStats | ScanAttemptStats): number => {
  const residual = "residualBuckets" in stats ? stats.residualBuckets : stats;
  return residual.rulePrevalidationMs + residual.rulePostvalidationMs + residual.ruleRebuildMs
    + residual.directoryMs + residual.pathMs + residual.gitDiscoveryMs + residual.symlinkMs
    + residual.observerMs + residual.entryMs + residual.controlMs + residual.finalizationMs;
};

function expectClosed(stats: ScanStats): void {
  expect(Math.abs(stats.residualMs - residualSum(stats))).toBeLessThanOrEqual(Number.EPSILON * 100);
  expect(stats.scanWallMs).toBeGreaterThanOrEqual(0);
  expect(primarySum(stats)).toBeGreaterThanOrEqual(0);
  expect(stats.attempts).toHaveLength(stats.attemptCount);
  for (const attempt of stats.attempts) {
    expect(Math.abs(attempt.residualMs - residualSum(attempt))).toBeLessThanOrEqual(Number.EPSILON * 100);
    expect(attempt.scanWallMs).toBeGreaterThanOrEqual(0);
    expect(primarySum(attempt)).toBeGreaterThanOrEqual(0);
  }
  expect(stats.attempts.reduce((sum, attempt) => sum + attempt.scanWallMs, 0)).toBeCloseTo(stats.scanWallMs, 6);
}

test("scanManifest emits a fixed path-free exhaustive timing record", async () => {
  const root = await fixture();
  const stats = createScanStats();
  const progress: number[] = [];
  await scanManifest(root, undefined, undefined, (count) => progress.push(count), undefined, stats);

  expect(stats.attemptCount).toBe(1);
  expect(stats.attempts[0]?.mode).toBe("off");
  expect(Object.keys(stats.residualBuckets).sort()).toEqual([
    "controlMs", "directoryMs", "entryMs", "finalizationMs", "gitDiscoveryMs", "observerMs",
    "pathMs", "rulePostvalidationMs", "rulePrevalidationMs", "ruleRebuildMs", "symlinkMs",
  ]);
  expect(progress).toEqual([2]);
  expectClosed(stats);
  const encoded = JSON.stringify({ residualBuckets: stats.residualBuckets, attempts: stats.attempts });
  expect(encoded).not.toContain(root);
  expect(encoded).not.toContain("file.txt");
});

test("accounting retains failed pruned attempts and closes 30 measured scans per fixture", async () => {
  const root = await fixture();
  const dircache = new DirCache();
  await scanManifest(root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, dircache, "unpruned");

  const measured = async (fallback: boolean): Promise<void> => {
    const original = dircache.validateRuleInventory.bind(dircache);
    let validations = 0;
    if (fallback) {
      dircache.validateRuleInventory = async () => ++validations % 2 === 1 || false;
    }
    try {
      for (let iteration = 0; iteration < 35; iteration++) {
        if (fallback) validations = 0;
        const stats = createScanStats();
        await scanManifest(root, undefined, undefined, undefined, undefined, stats, undefined, undefined, dircache, "pruned");
        if (iteration < 5) continue;
        expectClosed(stats);
        expect(stats.attemptCount).toBe(fallback ? 2 : 1);
        expect(stats.attempts.map(({ mode }) => mode)).toEqual(fallback ? ["pruned", "unpruned"] : ["pruned"]);
      }
    } finally {
      dircache.validateRuleInventory = original;
    }
  };

  await measured(false);
  await measured(true);
});
