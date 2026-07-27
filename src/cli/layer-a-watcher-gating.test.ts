import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HashCache, type Manifest } from "../engine/index.js";
import { RboxDaemon } from "./daemon.js";

const DROP = "Events were dropped by the FSEvents client. File system must be re-scanned.";
type Mode = "pruned" | "unpruned";
type Coverage = { coverage: "full-tree" | "pruned"; errorGenAtStart: number };
type ScanResult = { freshManifest: Manifest; deferredPaths: ReadonlySet<string>; coverage: Coverage["coverage"] };

interface Internals {
  startWatcherFn: (root: string, matcher: unknown, cb: (events: unknown[]) => void, opts?: { onError?: (err: Error) => void }) => Promise<{ close(): Promise<void> }>;
  startLiveWatch(): Promise<void>;
  doFullScan(): Promise<Coverage>;
  maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration: number, cov: Coverage): void;
  localObserver: { observe(plan: { kind: "scan"; mode: Mode }): Promise<ScanResult> };
  cache: HashCache;
  local: { head: Manifest };
  watcher?: { close(): Promise<void> };
  watcherHealthy: boolean;
  trustState: "trusted" | "suspect" | "fused";
  watcherErrorGeneration: number;
  lastTransientDropMs: number;
  recoveryHoldMs: number;
  hasCleanUnprunedScanThisEpisode: boolean;
  pumping: boolean;
  safetyTimer?: ReturnType<typeof setTimeout>;
  deepTimer?: ReturnType<typeof setInterval>;
}

let priorRetrust: string | undefined;
let priorRetrustCaptured = false;
afterEach(() => {
  if (priorRetrustCaptured) {
    if (priorRetrust === undefined) delete process.env.RBOX_WATCHER_RETRUST;
    else process.env.RBOX_WATCHER_RETRUST = priorRetrust;
  }
  priorRetrustCaptured = false;
});

function setRetrust(enabled: boolean): void {
  if (!priorRetrustCaptured) {
    priorRetrust = process.env.RBOX_WATCHER_RETRUST;
    priorRetrustCaptured = true;
  }
  if (enabled) process.env.RBOX_WATCHER_RETRUST = "1";
  else process.env.RBOX_WATCHER_RETRUST = "0";
}

function harness(): {
  daemon: Internals;
  modes: Mode[];
  start(): Promise<void>;
  failInit(): void;
  error(message?: string): void;
  errorDuringNextScan(message?: string): void;
  completeSafety(): Promise<Coverage>;
  close(): Promise<void>;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-layer-a-watch-")));
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as Internals;
  daemon.cache = new HashCache();
  daemon.pumping = true;
  const modes: Mode[] = [];
  let initFails = false;
  let onError: ((err: Error) => void) | undefined;
  let duringScan: (() => void) | undefined;
  daemon.startWatcherFn = async (_root, _matcher, _cb, opts) => {
    if (initFails) throw new Error("forced watcher init failure");
    onError = opts?.onError;
    return { backend: "parcel", close: async () => {} };
  };
  daemon.localObserver.observe = async ({ mode }) => {
    modes.push(mode);
    const hook = duringScan;
    duringScan = undefined;
    hook?.();
    return { freshManifest: daemon.local.head, deferredPaths: new Set<string>(), coverage: mode === "pruned" ? "pruned" : "full-tree" };
  };
  return {
    daemon,
    modes,
    start: () => daemon.startLiveWatch(),
    failInit: () => { initFails = true; },
    error: (message = DROP) => onError!(new Error(message)),
    errorDuringNextScan: (message = DROP) => { duringScan = () => onError!(new Error(message)); },
    completeSafety: async () => {
      const opErrorGeneration = daemon.watcherErrorGeneration;
      const coverage = await daemon.doFullScan();
      daemon.maybeClearWatcherDegradedAfterScan(opErrorGeneration, coverage);
      return coverage;
    },
    close: async () => {
      if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
      if (daemon.deepTimer) clearInterval(daemon.deepTimer);
      await daemon.watcher?.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("watcher init failure requests unpruned coverage with re-trust off and on", async () => {
  for (const retrust of [false, true]) {
    setRetrust(retrust);
    const h = harness();
    h.failInit();
    try {
      await h.start();
      expect(h.daemon.watcher).toBeUndefined();
      expect(h.daemon.watcherHealthy).toBe(true); // proves presence, not this boolean alone, gates pruning
      expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
      expect(h.modes).toEqual(["unpruned"]);
    } finally { await h.close(); }
  }
});

test("flag-off watcher errors permanently select unpruned mode", async () => {
  setRetrust(false);
  for (const message of [DROP, "fatal watcher stream failure"]) {
    const h = harness();
    try {
      await h.start();
      h.error(message);
      expect(h.daemon.watcherHealthy).toBe(false);
      expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
      expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
      expect(h.modes).toEqual(["unpruned", "unpruned"]);
      expect(h.daemon.watcherHealthy).toBe(false);
    } finally { await h.close(); }
  }
});

test("suspect recovery remains unpruned through the hold and prunes only after full-tree re-trust", async () => {
  setRetrust(true);
  const h = harness();
  try {
    await h.start();
    h.error();
    expect(h.daemon.trustState).toBe("suspect");
    expect(h.daemon.watcherHealthy).toBe(false);

    expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
    expect(h.daemon.hasCleanUnprunedScanThisEpisode).toBe(true);
    expect(h.daemon.trustState).toBe("suspect");
    expect(h.modes).toEqual(["unpruned"]);

    h.daemon.lastTransientDropMs -= h.daemon.recoveryHoldMs + 1;
    expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
    expect(h.daemon.trustState).toBe("trusted");
    expect(h.daemon.watcherHealthy).toBe(true);
    expect(h.modes).toEqual(["unpruned", "unpruned"]);

    expect(await h.completeSafety()).toMatchObject({ coverage: "pruned" });
    expect(h.modes).toEqual(["unpruned", "unpruned", "pruned"]);
  } finally { await h.close(); }
});

test("fused watcher stays unpruned even after stable full-tree coverage", async () => {
  setRetrust(true);
  const h = harness();
  try {
    await h.start();
    h.error("fatal watcher stream failure");
    expect(h.daemon.trustState).toBe("fused");
    expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
    expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree" });
    expect(h.modes).toEqual(["unpruned", "unpruned"]);
    expect(h.daemon.trustState).toBe("fused");
  } finally { await h.close(); }
});

test("an error during a trusted pruned scan forces the following scan unpruned", async () => {
  for (const retrust of [false, true]) {
    setRetrust(retrust);
    const h = harness();
    try {
      await h.start();
      h.errorDuringNextScan();
      const raced = await h.completeSafety();
      expect(raced.coverage).toBe("pruned");
      expect(raced.errorGenAtStart).toBe(0);
      expect(h.daemon.watcherErrorGeneration).toBe(1);
      expect(h.daemon.watcherHealthy).toBe(false);
      expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree", errorGenAtStart: 1 });
      expect(h.modes).toEqual(["pruned", "unpruned"]);
    } finally { await h.close(); }
  }
});

test("an error during an unpruned recovery scan cannot re-trust despite full-tree coverage", async () => {
  setRetrust(true);
  const h = harness();
  try {
    await h.start();
    h.error();
    h.daemon.lastTransientDropMs -= h.daemon.recoveryHoldMs + 1;
    h.errorDuringNextScan();
    const raced = await h.completeSafety();
    expect(raced).toMatchObject({ coverage: "full-tree", errorGenAtStart: 1 });
    expect(h.daemon.watcherErrorGeneration).toBe(2);
    expect(h.daemon.trustState).toBe("suspect");
    expect(await h.completeSafety()).toMatchObject({ coverage: "full-tree", errorGenAtStart: 2 });
    expect(h.modes).toEqual(["unpruned", "unpruned"]);
  } finally { await h.close(); }
});
