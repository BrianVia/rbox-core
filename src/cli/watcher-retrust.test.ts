import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest } from "../engine/index.js";
import { classifyWatcherError, nextSafetyDelay, RboxDaemon } from "./daemon.js";
import { continuityBroken, diffForDrift, horizonClass, loadDriftAudit, mergePending, saveDriftAudit, type DriftCandidate } from "./daemon/drift-audit.js";

const FLOOR = 60_000;
const CAP = 300_000;
const DROP = "Events were dropped by the FSEvents client. File system must be re-scanned.";
let previousFlag: string | undefined;

beforeEach(() => {
  previousFlag = process.env.RBOX_WATCHER_RETRUST;
  process.env.RBOX_WATCHER_RETRUST = "1";
});
afterEach(() => {
  if (previousFlag === undefined) delete process.env.RBOX_WATCHER_RETRUST;
  else process.env.RBOX_WATCHER_RETRUST = previousFlag;
});

interface Internals {
  startWatcherFn: (root: string, matcher: unknown, cb: (events: unknown[]) => void, opts?: { onError?: (err: Error) => void }) => Promise<{ backend: "parcel"; close(): Promise<void> }>;
  startLiveWatch(): Promise<void>;
  maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration: number, cov: { coverage: "full-tree" | "pruned"; errorGenAtStart: number }): void;
  advanceSafetyCadenceForTick(): void;
  noteChurn(): void;
  resetSuspectEpisodeState(): void;
  trustState: "trusted" | "suspect" | "fused";
  watcherHealthy: boolean;
  watcherErrorGeneration: number;
  lastTrustedErrorGeneration: number;
  transientDropTimestamps: number[];
  lastTransientDropMs: number;
  recoveryHoldMs: number;
  watcherLivenessSinceDrop: boolean;
  hasCleanUnprunedScanThisEpisode: boolean;
  consecutiveQuietSafetyTicks: number;
  churnSinceSafety: boolean;
  safetyDelay: number;
  pumping: boolean;
  watcher?: { close(): Promise<void> };
  safetyTimer?: ReturnType<typeof setTimeout>;
  deepTimer?: ReturnType<typeof setInterval>;
  openDriftAudits: Set<unknown>;
  runDriftAuditNow(audit?: unknown): Promise<void>;
}

function daemonHarness(): { daemon: Internals; error(err?: string): void; close(): Promise<void> } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-retrust-")));
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  const daemon = new RboxDaemon(root, cfg as never, {} as never) as unknown as Internals;
  let onError: ((err: Error) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, _cb, opts) => {
    onError = opts?.onError;
    return Promise.resolve({ backend: "parcel", close: async () => {} });
  };
  daemon.pumping = true;
  return {
    daemon,
    error: (message = DROP) => onError!(new Error(message)),
    close: async () => {
      if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
      if (daemon.deepTimer) clearInterval(daemon.deepTimer);
      await daemon.watcher?.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("classifies only known overflow phrases as transient", () => {
  for (const message of ["EVENTS WERE DROPPED by FSEvents", "File System MUST BE RE-SCANNED now"]) expect(classifyWatcherError(message)).toBe("transient");
  for (const message of ["FSEvents stream died", "permission denied", "", "events dropped"]) expect(classifyWatcherError(message)).toBe("fatal");
});

test("re-trust requires stable advanced full-tree coverage after the hold", async () => {
  const h = daemonHarness();
  try {
    await h.daemon.startLiveWatch();
    h.error();
    expect(h.daemon.trustState).toBe("suspect");
    h.daemon.lastTransientDropMs -= h.daemon.recoveryHoldMs;
    h.daemon.maybeClearWatcherDegradedAfterScan(1, { coverage: "pruned", errorGenAtStart: 1 });
    expect(h.daemon.trustState).toBe("suspect");
    h.daemon.maybeClearWatcherDegradedAfterScan(0, { coverage: "full-tree", errorGenAtStart: 0 });
    expect(h.daemon.trustState).toBe("suspect");
    h.daemon.maybeClearWatcherDegradedAfterScan(1, { coverage: "full-tree", errorGenAtStart: 1 });
    expect(h.daemon.trustState).toBe("trusted");
    expect(h.daemon.watcherHealthy).toBe(true);
    expect(h.daemon.watcherErrorGeneration).toBe(1);
  } finally { await h.close(); }
});

test("fuse arithmetic handles M, M-1, and the rolling-window boundary", async () => {
  const h = daemonHarness();
  try {
    await h.daemon.startLiveWatch();
    for (let i = 0; i < 5; i++) h.error();
    expect(h.daemon.trustState).toBe("suspect");
    h.daemon.lastTransientDropMs -= h.daemon.recoveryHoldMs;
    h.daemon.maybeClearWatcherDegradedAfterScan(5, { coverage: "full-tree", errorGenAtStart: 5 });
    expect(h.daemon.trustState).toBe("trusted");
    h.error();
    expect(h.daemon.trustState).toBe("fused");
    h.daemon.maybeClearWatcherDegradedAfterScan(6, { coverage: "full-tree", errorGenAtStart: 6 });
    expect(h.daemon.trustState).toBe("fused");
  } finally { await h.close(); }

  // ±5s (not ±1ms): the daemon reads its own Date.now() inside error(), so a
  // 1ms-inside-the-window entry ages out whenever the two clock reads straddle a
  // millisecond — the offset must exceed scheduling jitter to be deterministic.
  for (const offset of [-5_000, 0, 5_000]) {
    const b = daemonHarness();
    try {
      await b.daemon.startLiveWatch();
      const now = Date.now();
      b.daemon.transientDropTimestamps = Array(5).fill(now - 600_000 + offset);
      b.error();
      expect(b.daemon.trustState).toBe(offset > 0 ? "fused" : "suspect");
    } finally { await b.close(); }
  }
});

test("originUntrusted is omitted when false and survives to a subsequent healthy audit", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-drift-retrust-")));
  const entry = (sha256: string) => ({ path: "a", type: "file" as const, sha256, size: 1, mode: 0o644 });
  const base = { generatedAt: "", files: [entry("a")] };
  const observed = { generatedAt: "", files: [entry("b")] };
  const common = { firstSeenAtMs: 1, eventGenAtScan: 1, bootId: "boot", errorGenAtScan: 1, originUntrusted: false };
  expect(diffForDrift(base, observed, common)[0]).not.toHaveProperty("originUntrusted");
  const candidate = diffForDrift(base, observed, { ...common, originUntrusted: true })[0]!;
  const persisted: DriftCandidate = { ...candidate, quiescentAtScan: true };
  try {
    await saveDriftAudit(root, { version: 1, pending: [persisted], resolvedSinceLastAudit: { lateCovered: 0, coveredAmbiguous: 0 } });
    const loaded = (await loadDriftAudit(root)).pending[0]!;
    expect(loaded.originUntrusted).toBe(true);
    const healthy = { bootId: "boot", errorGeneration: 1, watcherUnhealthySince: false };
    expect(continuityBroken(loaded, healthy)).toBe(true);
    expect(horizonClass(loaded, loaded.observed, healthy)).toBe("unattributable");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("drift line omits trustState flag-off and stamps suspect flag-on", async () => {
  const h = daemonHarness();
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const audit = (trustState: "trusted" | "suspect") => ({
    scanStartMs: Date.now(), candidates: [], horizonInputs: new Map(), rawEvents: [], appliedEvents: [], overflow: false,
    watcherHealthy: trustState === "trusted", trustState, errorGen: 0, sinceSafetyMs: 0, rulesChanged: false,
  });
  try {
    delete process.env.RBOX_WATCHER_RETRUST;
    const trusted = audit("trusted");
    h.daemon.openDriftAudits.add(trusted);
    await h.daemon.runDriftAuditNow(trusted);
    expect(lines.at(-1)).not.toContain("trustState=");
    process.env.RBOX_WATCHER_RETRUST = "1";
    const suspect = audit("suspect");
    h.daemon.openDriftAudits.add(suspect);
    await h.daemon.runDriftAuditNow(suspect);
    expect(lines.at(-1)).toContain("watcherHealthy=n trustState=suspect");
  } finally {
    console.log = originalLog;
    await h.close();
  }
});

test("P2 cadence requires suspect liveness and clean coverage, and resets on churn/drop", async () => {
  expect(nextSafetyDelay(FLOOR, { watcherLive: false, churned: false, degradedBackoffEligible: true })).toBe(120_000);
  expect(nextSafetyDelay(CAP, { watcherLive: false, churned: true, degradedBackoffEligible: true })).toBe(FLOOR);
  const h = daemonHarness();
  try {
    await h.daemon.startLiveWatch();
    h.error();
    h.daemon.lastTransientDropMs = Date.now(); // keep suspect while clean coverage records P2 evidence
    h.daemon.maybeClearWatcherDegradedAfterScan(1, { coverage: "full-tree", errorGenAtStart: 1 });
    for (let i = 0; i < 3; i++) h.daemon.advanceSafetyCadenceForTick();
    expect(h.daemon.safetyDelay).toBe(FLOOR); // no callback since the drop
    h.daemon.noteChurn();
    h.daemon.advanceSafetyCadenceForTick();
    expect(h.daemon.safetyDelay).toBe(FLOOR);
    h.daemon.churnSinceSafety = false;
    for (let i = 0; i < 3; i++) h.daemon.advanceSafetyCadenceForTick();
    expect(h.daemon.safetyDelay).toBe(120_000);
    h.daemon.churnSinceSafety = true;
    h.daemon.advanceSafetyCadenceForTick();
    expect(h.daemon.safetyDelay).toBe(FLOOR);
    h.error();
    expect(h.daemon.watcherLivenessSinceDrop).toBe(false);
    expect(h.daemon.hasCleanUnprunedScanThisEpisode).toBe(false);
    expect(h.daemon.consecutiveQuietSafetyTicks).toBe(0);
  } finally { await h.close(); }
});

test("dedupePending ORs originUntrusted across same-path duplicates (clean-oldest + contaminated-newer)", () => {
  const mk = (firstSeenAtMs: number, originUntrusted?: boolean): DriftCandidate => ({
    path: "a", kind: "modified", expected: null, observed: null,
    firstSeenAtMs, eventGenAtScan: 0, bootId: "boot", errorGenAtScan: 1, quiescentAtScan: true,
    ...(originUntrusted ? { originUntrusted: true } : {}),
  });
  // oldest is CLEAN, a newer same-path duplicate is contaminated: the merge must
  // keep the oldest's evidence (firstSeenAtMs) yet carry the contamination.
  const merged = mergePending([mk(1)], [mk(2, true)]);
  expect(merged).toHaveLength(1);
  expect(merged[0]!.firstSeenAtMs).toBe(1);
  expect(merged[0]!.originUntrusted).toBe(true);
  // all-clean stays omit-when-false (flag-off byte identity).
  expect(mergePending([mk(1)], [mk(2)])[0]).not.toHaveProperty("originUntrusted");
});

// End-to-end: a candidate whose origin audit was downgraded by a transient drop
// stays UNATTRIBUTABLE when a subsequent, re-trusted, generation-matching audit
// classifies it — originUntrusted is the SOLE decider here (errorGen matches and
// the watcher is healthy at classification, so nothing else forces it).
test("drop-spanning survivor is unattributable via a subsequent re-trusted audit", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-retrust-e2e-")));
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    fs.writeFileSync(path.join(root, "drift.txt"), "old");
    const cfg = { remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "mem://", token: "" };
    const d = new RboxDaemon(root, cfg as never, {} as never, { bootId: "boot" }) as never as {
      cache: HashCache; manifest: unknown; matcher: unknown; watcher?: unknown; watcherSessionId?: string;
      trustState: string; watcherHealthy: boolean; watcherErrorGeneration: number; lastTransientDropMs: number; recoveryHoldMs: number;
      startWatcherFn: (r: string, m: unknown, cb: unknown, o?: { onError?: (e: Error) => void }) => Promise<{ backend: "parcel"; close(): Promise<void> }>;
      startLiveWatch(): Promise<void>; doDeepScan(): Promise<unknown>; runDriftAuditNow(): Promise<void>;
      maybeClearWatcherDegradedAfterScan(g: number, c: { coverage: "full-tree" | "pruned"; errorGenAtStart: number }): void;
      safetyTimer?: ReturnType<typeof setTimeout>; deepTimer?: ReturnType<typeof setInterval>;
    };
    let onError: ((e: Error) => void) | undefined;
    d.startWatcherFn = (_r, _m, _cb, o) => { onError = o?.onError; return Promise.resolve({ backend: "parcel", close: async () => {} }); };
    d.cache = await HashCache.load(root);
    d.manifest = await scanManifest(root, d.matcher as never, d.cache);
    await d.startLiveWatch();
    d.watcherSessionId = "session";

    onError!(new Error(DROP));                 // errorGen 1, trustState suspect
    expect(d.trustState).toBe("suspect");
    fs.writeFileSync(path.join(root, "drift.txt"), "changed"); // drift, no watcher event
    await d.doDeepScan();                       // audit A opens SUSPECT → candidate born originUntrusted, errorGenAtScan=1
    await d.runDriftAuditNow();                 // → contaminated survivor persisted
    expect((await loadDriftAudit(root)).pending[0]!.originUntrusted).toBe(true);

    d.lastTransientDropMs = Date.now() - d.recoveryHoldMs; // hold elapsed
    d.maybeClearWatcherDegradedAfterScan(1, { coverage: "full-tree", errorGenAtStart: 1 }); // re-trust; errorGen stays 1
    expect(d.trustState).toBe("trusted");
    expect(d.watcherHealthy).toBe(true);
    expect(d.watcherErrorGeneration).toBe(1);   // gen unchanged by re-trust

    logs.length = 0;
    await d.doDeepScan();                        // audit B: trusted, errorGen 1, stashes the survivor
    await d.runDriftAuditNow();                  // classify: gen matches + healthy ⇒ originUntrusted is the ONLY reason it can't confirm
    const line = logs.find((l) => l.includes("deep-scan drift:"))!;
    expect(line).toContain("unattributable=1");
    expect(line).toContain("confirmed=0");
  } finally {
    console.log = oldLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
