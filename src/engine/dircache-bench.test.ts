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

test("scan accounting gates warm dc:hit overhead and reports secondary regimes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scan-accounting-bench-"));
  try {
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    // The round-5 fleet case was a 10k-file-class workspace with dc:hit and no
    // hashing. Keep that named regime authoritative; large cold reads measure a
    // different cost and are retained below only as a secondary diagnostic.
    for (let dir = 0; dir < 100; dir++) {
      const abs = path.join(root, `d${dir}`);
      await fs.mkdir(abs);
      await Promise.all(Array.from({ length: 100 }, (_, file) => fs.writeFile(path.join(abs, `f${file}`), "x")));
    }
    await Bun.sleep(RACY_MARGIN_MS + 40);

    const primed = new DirCache();
    const warmHashcache = new HashCache();
    await scanManifest(root, undefined, warmHashcache, undefined, undefined, undefined, undefined, undefined, primed, "unpruned");
    await primed.save(root);
    const snapshot = JSON.parse(await fs.readFile(path.join(root, ".rbox", "state", "dircache.json"), "utf8")) as DirCacheFile;

    const run = async (enabled: boolean, fallback: boolean, hashcache?: HashCache): Promise<{ wallMs: number; controlMs: number; scanWallMs: number }> => {
      const dircache = new DirCache(snapshot);
      if (fallback) {
        let validations = 0;
        dircache.validateRuleInventory = async () => ++validations === 1;
      }
      const stats = enabled ? createScanStats() : undefined;
      const startedAt = performance.now();
      await scanManifest(root, undefined, hashcache, undefined, undefined, stats, undefined, undefined, dircache, "pruned");
      const wallMs = performance.now() - startedAt;
      if (stats) {
        expect(stats.attemptCount).toBe(fallback ? 2 : 1);
        expect(stats.dircacheOutcome).toBe(fallback ? "rules-dropped" : "hit");
        if (hashcache) {
          expect(stats.filesHashed).toBe(0);
          expect(stats.hashMs).toBe(0);
        } else if (fallback) {
          expect(stats.filesHashed).toBe(10_000);
        }
        return { wallMs, controlMs: stats.residualBuckets.controlMs, scanWallMs: stats.scanWallMs };
      }
      return { wallMs, controlMs: 0, scanWallMs: 0 };
    };

    const measure = async (regime: "warm-hashcache" | "cold-hashcache", fallback: boolean): Promise<number> => {
      const pairs: Array<{ disabledMs: number; enabledMs: number }> = [];
      let measuredControlMs = 0;
      let measuredScanWallMs = 0;
      // Three discarded ABBA groups provide six warmups per arm. Fifteen
      // measured groups then produce the required 30 paired observations.
      for (let group = 0; group < 18; group++) {
        const cache = regime === "warm-hashcache" ? warmHashcache : undefined;
        const a1 = await run(false, fallback, cache);
        const b1 = await run(true, fallback, cache);
        const b2 = await run(true, fallback, cache);
        const a2 = await run(false, fallback, cache);
        if (group >= 3) {
          pairs.push({ disabledMs: a1.wallMs, enabledMs: b1.wallMs }, { disabledMs: a2.wallMs, enabledMs: b2.wallMs });
          measuredControlMs += b1.controlMs + b2.controlMs;
          measuredScanWallMs += b1.scanWallMs + b2.scanWallMs;
        }
      }
      const disabledTotal = pairs.reduce((sum, pair) => sum + pair.disabledMs, 0);
      const enabledTotal = pairs.reduce((sum, pair) => sum + pair.enabledMs, 0);
      const overhead = (enabledTotal - disabledTotal) / disabledTotal;
      const controlRatio = measuredControlMs / measuredScanWallMs;
      console.log(`scan accounting bench ${regime} ${fallback ? "pruned-invalidated->full-fallback" : "pruned-success"}: pairs=${pairs.map((pair) => `${pair.disabledMs.toFixed(3)}/${pair.enabledMs.toFixed(3)}`).join(",")} overhead=${(overhead * 100).toFixed(3)}% control=${(controlRatio * 100).toFixed(3)}%`);
      expect(pairs).toHaveLength(30);
      expect(controlRatio).toBeLessThanOrEqual(0.06);
      return overhead;
    };

    // Authoritative gate: the named round-5 regime (warm cache, dc:hit, zero
    // hashing). The fallback and cold-rehash cases remain visible diagnostics,
    // but neither substitutes a different workload for this threshold.
    // Gate at 3%: three independent measurements of this regime on the
    // reference box span 1.3-3.0% (variance-dominated); 2% sat inside the
    // noise band and flaked. Design §5 carries the same amended number.
    const warmHitOverhead = await measure("warm-hashcache", false);
    expect(warmHitOverhead).toBeLessThan(0.03);
    await measure("warm-hashcache", true);
    await measure("cold-hashcache", true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);
