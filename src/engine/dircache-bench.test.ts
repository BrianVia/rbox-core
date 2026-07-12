import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScanStats, DirCache, HashCache, RACY_MARGIN_MS, scanManifest } from "./index.js";

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
