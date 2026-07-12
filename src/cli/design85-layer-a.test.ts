import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScanStats, HashCache, RACY_MARGIN_MS, type Manifest } from "../engine/index.js";
import { RboxDaemon } from "./daemon.js";

let priorFlag: string | undefined;
afterEach(() => {
  if (priorFlag === undefined) delete process.env.RBOX_SCAN_PRUNE;
  else process.env.RBOX_SCAN_PRUNE = priorFlag;
});

test("daemon safety-mode coverage is pruned when warm; deep mode is full-tree and rebuilds", async () => {
  priorFlag = process.env.RBOX_SCAN_PRUNE;
  process.env.RBOX_SCAN_PRUNE = "1";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-layer-a-daemon-"));
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  type ScanResult = { freshManifest: Manifest; deferred: Set<string>; coverage: "full-tree" | "pruned" };
  type Internals = {
    replaceManifestFromScan(cache: HashCache, previous: Manifest, stats: ReturnType<typeof createScanStats>, kind: "safety scan" | "deep scan", mode: "pruned" | "unpruned"): Promise<ScanResult>;
  };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as Internals;
  const empty: Manifest = { generatedAt: "", files: [] };
  try {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const cold = await daemon.replaceManifestFromScan(new HashCache(), empty, createScanStats(), "safety scan", "pruned");
    expect(cold.coverage).toBe("full-tree"); // deadline self-demotion seeds the cache
    await Bun.sleep(RACY_MARGIN_MS + 40);
    const primed = await daemon.replaceManifestFromScan(new HashCache(), cold.freshManifest, createScanStats(), "safety scan", "pruned");
    await Bun.sleep(RACY_MARGIN_MS + 40);
    const warmStats = createScanStats();
    const warm = await daemon.replaceManifestFromScan(new HashCache(), primed.freshManifest, warmStats, "safety scan", "pruned");
    expect(warm.coverage).toBe("pruned");
    expect(warmStats.dirsReusedFromCache).toBeGreaterThan(0);
    const deepStats = createScanStats();
    const deep = await daemon.replaceManifestFromScan(new HashCache(), warm.freshManifest, deepStats, "deep scan", "unpruned");
    expect(deep.coverage).toBe("full-tree");
    expect(deepStats.dircacheOutcome).toBe("unpruned");
    expect(deepStats.dirsReusedFromCache).toBe(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 10_000);
