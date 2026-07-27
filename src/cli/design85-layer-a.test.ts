import { afterEach, expect, setSystemTime, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createScanStats, HashCache, PhaseReport, RACY_MARGIN_MS, type Manifest } from "../engine/index.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "./config.js";
import { RboxDaemon } from "./daemon.js";
import { scanManifestForPush } from "./sync.js";

let priorFlag: string | undefined;
afterEach(() => {
  setSystemTime();
  if (priorFlag === undefined) delete process.env.RBOX_SCAN_PRUNE;
  else process.env.RBOX_SCAN_PRUNE = priorFlag;
});

test("daemon safety-mode coverage is pruned when warm; deep mode is full-tree and rebuilds", async () => {
  priorFlag = process.env.RBOX_SCAN_PRUNE;
  delete process.env.RBOX_SCAN_PRUNE;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-layer-a-daemon-"));
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  type ScanResult = { freshManifest: Manifest; deferredPaths: ReadonlySet<string>; coverage: "full-tree" | "pruned" };
  type Internals = {
    localObserver: { observe(plan: { kind: "scan"; cache: HashCache; previous: Manifest; scanStats: ReturnType<typeof createScanStats>; scanKind: "safety scan" | "deep scan"; mode: "pruned" | "unpruned" }): Promise<ScanResult> };
    gitDiscovery: {
      readonly hasAuthoritativeSnapshot: boolean;
      readonly absenceProof?: { epoch: number; discoveredRepos: ReadonlySet<string> };
      authoritative: unknown[];
      authoritativeSnapshotTaken: boolean;
    };
  };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as Internals;
  const empty: Manifest = { generatedAt: "", files: [] };
  try {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const cold = await daemon.localObserver.observe({ kind: "scan", cache: new HashCache(), previous: empty, scanStats: createScanStats(), scanKind: "safety scan", mode: "pruned" });
    expect(cold.coverage).toBe("full-tree"); // deadline self-demotion seeds the cache
    await Bun.sleep(RACY_MARGIN_MS + 40);
    const primed = await daemon.localObserver.observe({ kind: "scan", cache: new HashCache(), previous: cold.freshManifest, scanStats: createScanStats(), scanKind: "safety scan", mode: "pruned" });
    await Bun.sleep(RACY_MARGIN_MS + 40);
    const warmStats = createScanStats();
    const warm = await daemon.localObserver.observe({ kind: "scan", cache: new HashCache(), previous: primed.freshManifest, scanStats: warmStats, scanKind: "safety scan", mode: "pruned" });
    expect(warm.coverage).toBe("pruned");
    expect(warmStats.dirsReusedFromCache).toBeGreaterThan(0);
    const deepStats = createScanStats();
    const deep = await daemon.localObserver.observe({ kind: "scan", cache: new HashCache(), previous: warm.freshManifest, scanStats: deepStats, scanKind: "deep scan", mode: "unpruned" });
    expect(deep.coverage).toBe("full-tree");
    expect(deepStats.dircacheOutcome).toBe("unpruned");
    expect(deepStats.dirsReusedFromCache).toBe(0);
    const authoritativeSentinel = [{ relPath: "repo-hidden-by-pruning" }];
    daemon.gitDiscovery.authoritative = authoritativeSentinel;
    daemon.gitDiscovery.authoritativeSnapshotTaken = true;
    process.env.RBOX_SCAN_PRUNE = "0";
    const disabledStats = createScanStats();
    const disabled = await daemon.localObserver.observe({ kind: "scan", cache: new HashCache(), previous: deep.freshManifest, scanStats: disabledStats, scanKind: "safety scan", mode: "pruned" });
    expect(disabled.coverage).toBe("full-tree");
    expect(disabledStats.dircacheOutcome).toBe("off");
    expect(daemon.gitDiscovery.hasAuthoritativeSnapshot).toBe(true);
    expect(daemon.gitDiscovery.authoritative).toBe(authoritativeSentinel);
    expect(daemon.gitDiscovery.absenceProof).toBeUndefined();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("foreground default-on and kill-switch scans stay manifest-identical across structural and metadata changes", async () => {
  priorFlag = process.env.RBOX_SCAN_PRUNE;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-layer-a-foreground-"));
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  await fs.mkdir(left);
  await fs.mkdir(right);
  await fs.writeFile(path.join(root, "original.txt"), "v1");
  const cfg: WorkspaceConfig = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  await saveStateUnsafeLegacyOrTest(root, { stream: syncStreamId(cfg), lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] } });
  setSystemTime(Date.now() + RACY_MARGIN_MS + 1_000);

  const scan = async (enabled: boolean) => {
    if (enabled) delete process.env.RBOX_SCAN_PRUNE;
    else process.env.RBOX_SCAN_PRUNE = "0";
    const stats = createScanStats();
    const manifest = await scanManifestForPush(root, cfg, { report: PhaseReport.push(), scanStats: stats });
    return { manifest, stats };
  };
  const assertParity = async () => {
    const on = await scan(true);
    const off = await scan(false);
    expect(on.manifest.files).toEqual(off.manifest.files);
    expect(off.stats.dircacheOutcome).toBe("off");
    return on;
  };

  try {
    const seeded = await assertParity();
    expect(seeded.stats.dircacheOutcome).toBe("deadline");
    const warm = await assertParity();
    expect(warm.stats.dircacheOutcome).toBe("hit");
    expect(warm.stats.dirsReusedFromCache).toBeGreaterThan(0);

    await fs.writeFile(path.join(root, "original.txt"), "v2");
    const modified = await assertParity();
    expect(modified.manifest.files.find((entry) => entry.path === "original.txt")?.sha256)
      .not.toBe(warm.manifest.files.find((entry) => entry.path === "original.txt")?.sha256);

    await fs.chmod(path.join(root, "original.txt"), 0o600);
    const chmodded = await assertParity();
    expect(chmodded.manifest.files.find((entry) => entry.path === "original.txt")?.mode).toBe(0o600);

    await fs.writeFile(path.join(left, "created.txt"), "created");
    const created = await assertParity();
    expect(created.manifest.files.some((entry) => entry.path === "left/created.txt")).toBe(true);

    await fs.rm(path.join(root, "original.txt"));
    const deleted = await assertParity();
    expect(deleted.manifest.files.some((entry) => entry.path === "original.txt")).toBe(false);

    await fs.rename(path.join(left, "created.txt"), path.join(right, "renamed.txt"));
    const renamed = await assertParity();
    expect(renamed.manifest.files.some((entry) => entry.path === "left/created.txt")).toBe(false);
    expect(renamed.manifest.files.some((entry) => entry.path === "right/renamed.txt")).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
