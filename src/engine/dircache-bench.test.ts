import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScanStats, DirCache, HashCache, RACY_MARGIN_MS, scanManifest } from "./index.js";
import type { DirCacheFile } from "./dircache.js";

test("dircache structural CI gate: quiescent 50k-file tree reuses every directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-dircache-bench-"));
  const dirCount = 2_000;
  const filesPerDir = 25;
  try {
    for (let start = 0; start < dirCount; start += 50) {
      await Promise.all(Array.from({ length: Math.min(50, dirCount - start) }, async (_, offset) => {
        const dir = path.join(root, `d${String(start + offset).padStart(4, "0")}`);
        await fs.mkdir(dir);
        await Promise.all(Array.from({ length: filesPerDir }, (_, file) => fs.writeFile(path.join(dir, `f${file}`), "x")));
      }));
    }
    const dircache = new DirCache();
    const hashcache = new HashCache();
    // Settle so every dir is older than the racy margin at the CACHING scan — the
    // steady-state condition Layer A optimizes (a quiescent tree between cycles).
    await Bun.sleep(RACY_MARGIN_MS + 40);
    const unprunedStats = createScanStats();
    const t0 = performance.now();
    const unpruned = await scanManifest(root, undefined, hashcache, undefined, undefined, unprunedStats, undefined, undefined, dircache, "unpruned");
    const unprunedMs = performance.now() - t0;
    const prunedStats = createScanStats();
    const t1 = performance.now();
    const pruned = await scanManifest(root, undefined, hashcache, undefined, undefined, prunedStats, undefined, undefined, dircache, "pruned");
    const prunedMs = performance.now() - t1;
    const totalDirs = dirCount + 1;
    console.log(`dircache bench: prunedMs/unprunedMs=${(prunedMs / unprunedMs).toFixed(3)} reuse=${prunedStats.dirsReusedFromCache}/${totalDirs} files=${dirCount * filesPerDir}`);
    expect(prunedStats.dirsReusedFromCache).toBe(totalDirs);
    expect(pruned.files).toEqual(unpruned.files);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("scan accounting stays below 2% paired ABBA overhead", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scan-accounting-bench-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    for (let dir = 0; dir < 20; dir++) {
      const abs = path.join(root, `d${dir}`);
      await fs.mkdir(abs);
      await Promise.all(Array.from({ length: 25 }, (_, file) => fs.writeFile(path.join(abs, `f${file}`), "x".repeat(262_144))));
    }
    await Bun.sleep(RACY_MARGIN_MS + 40);

    const primed = new DirCache();
    await scanManifest(root, undefined, undefined, undefined, undefined, undefined, undefined, undefined, primed, "unpruned");
    await primed.save(root);
    const snapshot = JSON.parse(await fs.readFile(path.join(root, ".rbox", "state", "dircache.json"), "utf8")) as DirCacheFile;

    const run = async (enabled: boolean, fallback: boolean): Promise<number> => {
      const dircache = new DirCache(snapshot);
      if (fallback) {
        let validations = 0;
        dircache.validateRuleInventory = async () => ++validations === 1;
      }
      const stats = enabled ? createScanStats() : undefined;
      const startedAt = performance.now();
      await scanManifest(root, undefined, undefined, undefined, undefined, stats, undefined, undefined, dircache, "pruned");
      const wallMs = performance.now() - startedAt;
      if (stats) {
        const accounted = stats.readdirMs + stats.statMs + stats.matcherMs + stats.hashMs + stats.sortMs + stats.residualMs;
        expect(Math.abs(stats.scanWallMs - accounted)).toBeLessThanOrEqual(Math.max(2 * stats.attemptCount, stats.scanWallMs * 0.05));
        expect(stats.attemptCount).toBe(fallback ? 2 : 1);
      }
      return wallMs;
    };

    for (const fallback of [false, true]) {
      const pairs: Array<{ disabledMs: number; enabledMs: number }> = [];
      // Three discarded ABBA groups provide six warmups per arm. Fifteen
      // measured groups then produce the required 30 paired observations.
      for (let group = 0; group < 18; group++) {
        const a1 = await run(false, fallback);
        const b1 = await run(true, fallback);
        const b2 = await run(true, fallback);
        const a2 = await run(false, fallback);
        if (group >= 3) pairs.push({ disabledMs: a1, enabledMs: b1 }, { disabledMs: a2, enabledMs: b2 });
      }
      const disabledTotal = pairs.reduce((sum, pair) => sum + pair.disabledMs, 0);
      const enabledTotal = pairs.reduce((sum, pair) => sum + pair.enabledMs, 0);
      const overhead = (enabledTotal - disabledTotal) / disabledTotal;
      console.log(`scan accounting bench ${fallback ? "pruned-invalidated->full-fallback" : "pruned-success"}: pairs=${pairs.map((pair) => `${pair.disabledMs.toFixed(3)}/${pair.enabledMs.toFixed(3)}`).join(",")} overhead=${(overhead * 100).toFixed(3)}%`);
      expect(pairs).toHaveLength(30);
      expect(overhead).toBeLessThan(0.02);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
