import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextSafetyDelay, RboxDaemon } from "../daemon.js";
import { folderCatalogPath } from "../rbox-paths.js";
import type { GitSignalBatch } from "./watcher.js";
import { HashCache, type IgnoreMatcher, type Manifest, type WatchEvent } from "../../engine/index.js";
import type { WatcherTrustObservation } from "./watcher-trust.js";
import { saveStateUnsafeLegacyOrTest } from "../sync-state-store.js";
import { GenesisAdmissionRefusedError } from "../state-plane/authority-bootstrap.js";

// Design 49: the safety scan heals DROPPED watcher events, and drops happen under
// churn — so quiet intervals back the scan off (60s → 5m cap) instead of
// stat-sweeping every tracked file each minute on an idle machine, forever.

const FLOOR = 60_000;
const CAP = 5 * 60_000;
const quiet = { watcherLive: true, churned: false };

async function beforeDeadline<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("nextSafetyDelay doubles quiet intervals and caps at 5m", () => {
  expect(nextSafetyDelay(FLOOR, quiet)).toBe(120_000);
  expect(nextSafetyDelay(120_000, quiet)).toBe(240_000);
  expect(nextSafetyDelay(240_000, quiet)).toBe(CAP); // 480s would overshoot — capped
  expect(nextSafetyDelay(CAP, quiet)).toBe(CAP);
});

test("churn snaps the delay back to the 60s floor from any level", () => {
  expect(nextSafetyDelay(CAP, { watcherLive: true, churned: true })).toBe(FLOOR);
  expect(nextSafetyDelay(120_000, { watcherLive: true, churned: true })).toBe(FLOOR);
});

test("no live watcher never backs off — the periodic scan IS the sync mechanism there", () => {
  expect(nextSafetyDelay(FLOOR, { watcherLive: false, churned: false })).toBe(FLOOR);
  expect(nextSafetyDelay(CAP, { watcherLive: false, churned: false })).toBe(FLOOR);
});

test("design 172: an active Linux git ref-watch pins quiet safety cadence to 60s", () => {
  expect(nextSafetyDelay(CAP, { watcherLive: true, churned: false, pinToFloor: true })).toBe(FLOOR);
  expect(nextSafetyDelay(FLOOR, { watcherLive: true, churned: false, pinToFloor: true })).toBe(FLOOR);
  // The non-git case is byte-for-byte policy-equivalent to the existing backoff.
  expect(nextSafetyDelay(FLOOR, { watcherLive: true, churned: false, pinToFloor: false })).toBe(120_000);
});

interface SafetyInternals {
  startWatcherFn: (
    root: string,
    matcher: IgnoreMatcher,
    cb: (events: WatchEvent[]) => void,
    opts?: {
      onError?: (err: Error) => void;
      signalDebouncer?: { push(reason: "signal" | "candidate" | "other"): void };
      onInitialGitRepos?: (repos: readonly { relPath: string; kind: "dir" | "pointer" }[]) => Promise<void>;
    }
  ) => Promise<{ backend: "parcel" | "chokidar"; close(): Promise<void> }>;
  startLiveWatch(): Promise<void>;
  advanceSafetyCadenceForTick(): void;
  churnSinceSafety: boolean;
  ambientStatusFrom(activity: { at: string }, settled: boolean, now: number): { watcherTrust?: "suspect" | "fused" };
  watcherTrust: {
    healthy: boolean;
    state: "trusted" | "suspect" | "fused";
    degraded: boolean;
    errorGeneration: number;
    lastTransientDropMs: number;
    recoveryHoldMs: number;
    unsettled: boolean;
    observe(input: WatcherTrustObservation): void | { wasUnsettled: boolean };
  };
  safetyDelay: number;
  pumping: boolean;
  want: { push: boolean; fullScan: boolean; deepScan: boolean };
  pendingEvents: WatchEvent[];
  watcher?: { backend: "parcel" | "chokidar"; close(): Promise<void> };
  safetyTimer?: ReturnType<typeof setTimeout>;
  deepTimer?: ReturnType<typeof setInterval>;
  matcher: { ignores(path: string): boolean };
  cfg: {
    remoteWorkspaceId: string;
    respectGitignore?: boolean;
    encrypted?: boolean;
    kek?: Buffer;
    remoteUrl: string;
    token: string;
    accountId?: string;
    accountEpoch?: number;
    keyEpoch?: number;
  };
  reloadWorkspaceConfigIfChanged(): Promise<void>;
  folderOperationBoundary(): Promise<boolean>;
  activitySnapshot(): { halt?: { reason: string; typedReason?: { kind: string } } };
  folderAdmissionHaltReason?: string;
  folderMatcherRebuildPending: boolean;
  folderPolicyRecyclePending: boolean;
  localObserver: { observe(plan: RecycleScanPlan): Promise<{ deferredPaths: ReadonlySet<string> }> };
  rebuildMatcher(state?: { lastSyncedManifest: Manifest }): void;
  acknowledgeFolderPolicyRecycle(): Promise<boolean>;
  gitDiscovery: DiscoveryInternals;
  handleGitSignalBatch(batch: GitSignalBatch): Promise<void>;
  request(kind: "pull" | "push" | "fullScan" | "deepScan"): void;
  /** The exact effect object the supervisor holds — reached so the fuse-recovery
   *  re-arm route is proven WIRED, not merely present on the daemon. */
  watcherSessions: { effects: { requestFullScan(): void } };
  pump(): Promise<void>;
}

/** The discovery owner's public receipt surface plus the continuity fields these
 *  floor regressions drive directly, reached the same way daemon internals are. */
interface DiscoveryInternals {
  readonly floorRequired: boolean;
  readonly refBackendAttached: boolean;
  observe(observation: { kind: "plan"; repos: readonly { relPath: string; kind: "dir" | "pointer" }[] }): Promise<unknown>;
  refreshFloor(reason: string): void;
  backendFallbackPending: boolean;
  authoritative: readonly { relPath: string; kind: "dir" | "pointer" }[];
  planDiscoveredDirOwners: Set<string>;
}

test("design 175: ref signal requests push without pending/file-settle state", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-git-signal-")));
  const daemon = makeDaemon(root);
  let signal: (() => void) | undefined;
  let signalHandled!: () => void;
  let signalFailed!: (error: Error) => void;
  const handled = new Promise<void>((resolve, reject) => {
    signalHandled = resolve;
    signalFailed = reject;
  });
  const handleGitSignalBatch = daemon.handleGitSignalBatch.bind(daemon);
  daemon.handleGitSignalBatch = async (batch) => {
    try {
      await handleGitSignalBatch(batch);
    } catch (error) {
      if (!batch.reasons.signal) throw error;
      signalFailed(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (batch.reasons.signal) signalHandled();
  };
  daemon.startWatcherFn = (_root, _matcher, _cb, opts) => {
    signal = () => opts?.signalDebouncer?.push("signal");
    return Promise.resolve({ backend: "parcel", close: async () => {} });
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.gitDiscovery.refBackendAttached).toBe(process.platform === "linux");
    const realNow = Date.now;
    const signalAt = realNow();
    try {
      Date.now = () => signalAt;
      signal!();
      Date.now = () => signalAt + 3_000;
      signal!();
      await beforeDeadline(handled, "git signal batch");
    } finally {
      Date.now = realNow;
    }
    expect(daemon.want.push).toBe(true);
    expect(daemon.churnSinceSafety).toBe(true);
    expect(daemon.pendingEvents).toEqual([]);
    expect(daemon.watcherTrust.unsettled).toBe(false);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("design 175: a directory-backed repo holds the git safety floor only on Linux", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-git-floor-")));
  const daemon = makeDaemon(root);
  daemon.startWatcherFn = async (_root, _matcher, _cb, opts) => {
    await opts?.onInitialGitRepos?.([{ relPath: ".", kind: "dir" }]);
    return { backend: "parcel", close: async () => {} };
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    daemon.safetyDelay = FLOOR;
    expect(daemon.gitDiscovery.floorRequired).toBe(process.platform === "linux");
    daemon.advanceSafetyCadenceForTick();
    expect(daemon.safetyDelay).toBe(process.platform === "linux" ? FLOOR : 120_000);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("design 175 fix: plan discovery pins the floor without a registry until a shrinking snapshot", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-git-plan-floor-")));
  const daemon = makeDaemon(root);
  try {
    daemon.safetyDelay = CAP;
    daemon.gitDiscovery.authoritative = [];
    expect(daemon.gitDiscovery.refBackendAttached).toBe(false);
    await daemon.gitDiscovery.observe({ kind: "plan", repos: [{ relPath: "late", kind: "dir" }] });
    expect(daemon.gitDiscovery.planDiscoveredDirOwners).toEqual(new Set(["late"]));
    expect(daemon.gitDiscovery.floorRequired).toBe(true);
    expect(daemon.safetyDelay).toBe(FLOOR);

    daemon.gitDiscovery.planDiscoveredDirOwners.clear();
    daemon.gitDiscovery.refreshFloor("complete-zero-snapshot");
    expect(daemon.gitDiscovery.floorRequired).toBe(false);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("design 175 fix: registry construction follows the watcher-reported backend", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-git-backend-report-")));
  const daemon = makeDaemon(root);
  daemon.startWatcherFn = async (_root, _matcher, _cb, opts) => {
    await opts?.onInitialGitRepos?.([{ relPath: ".", kind: "dir" }]);
    return { backend: "chokidar", close: async () => {} };
  };
  daemon.pumping = true;
  try {
    await daemon.startLiveWatch();
    expect(daemon.gitDiscovery.refBackendAttached).toBe(false);
    expect(daemon.gitDiscovery.floorRequired).toBe(true);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("design 175: fallback and dir snapshots pin; pointer-only and zero-repo snapshots release", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-git-floor-state-")));
  const daemon = makeDaemon(root);
  try {
    daemon.safetyDelay = CAP;
    daemon.gitDiscovery.backendFallbackPending = true;
    daemon.gitDiscovery.refreshFloor("chokidar-pending");
    expect(daemon.gitDiscovery.floorRequired).toBe(true);
    expect(daemon.safetyDelay).toBe(FLOOR);

    daemon.gitDiscovery.backendFallbackPending = false;
    daemon.gitDiscovery.authoritative = [{ relPath: "linked", kind: "pointer" }];
    daemon.gitDiscovery.refreshFloor("pointer-only-snapshot");
    expect(daemon.gitDiscovery.floorRequired).toBe(false);

    daemon.gitDiscovery.authoritative = [{ relPath: "repo", kind: "dir" }];
    daemon.gitDiscovery.refreshFloor("dir-snapshot");
    expect(daemon.gitDiscovery.floorRequired).toBe(true);

    daemon.gitDiscovery.authoritative = [];
    daemon.gitDiscovery.refreshFloor("zero-repo-snapshot");
    expect(daemon.gitDiscovery.floorRequired).toBe(false);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface RecycleScanPlan { mode?: string; cache?: HashCache }

function makeDaemon(root: string, opts: { pullOnly?: boolean; log?: (message: string) => void } = {}): SafetyInternals {
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  return new RboxDaemon(root, cfg as never, {} as never, opts) as SafetyInternals;
}

test("direct fresh-state refusal precedes folder authority and every daemon sidecar", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-daemon-genesis-refusal-")));
  const previousHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = path.join(root, "home");
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  const daemon = new RboxDaemon(root, cfg as never, {} as never, {
    keyDeliveryFlight: null,
    acquireSyncMutex: async () => ({
      status: "acquired",
      handle: {
        root,
        incarnation: "lock-unavailable",
        released: false,
        lockFailure: { reason: "hardlink-unsupported", error: new Error("unsupported") },
      },
    }),
    log: () => {},
  });
  try {
    await expect(daemon.start()).rejects.toBeInstanceOf(GenesisAdmissionRefusedError);
    expect(fs.existsSync(folderCatalogPath())).toBe(false);
    expect(fs.existsSync(path.join(root, ".rbox"))).toBe(false);
  } finally {
    await daemon.stop();
    if (previousHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeFolderCatalog(root: string, respectGitignore: boolean): string {
  const file = folderCatalogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    globalOptions: {
      syncGit: true,
      git: { incremental: true },
      respectGitignore: false,
      noDrift: false,
      trash: { days: 30, maxBytes: 2147483648 },
    },
    folders: [{ name: "Safety", path: root, options: { respectGitignore } }],
  }, null, respectGitignore ? 2 : 0));
  return file;
}

test("watcher events mark churn AND pull a backed-off timer forward (codex R1)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let deliver: ((events: unknown[]) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, cb) => {
    deliver = cb;
    return Promise.resolve({ backend: "parcel", close: async () => {} });
  };
  // Block the pump so delivering an event exercises ONLY the callback's
  // bookkeeping (churn flag + queued want) — this minimal daemon has no deps.
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.churnSinceSafety).toBe(false); // boots quiet
    // Simulate a fully backed-off idle daemon, then a churn storm at T+1s.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    deliver!([{ type: "update", path: path.join(root, "a.txt") }]);
    expect(daemon.churnSinceSafety).toBe(true); // churn recorded for the next tick
    expect(daemon.want.push).toBe(true); // hot path still queued the push
    // The codex R1 repro: the flag alone would let a drop from THIS storm wait out
    // the armed 5m timer. The timer must be re-armed at the floor immediately.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pull-only daemon watcher path never queues push", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root, { pullOnly: true });
  let deliver: ((events: unknown[]) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, cb) => {
    deliver = cb;
    return Promise.resolve({ backend: "parcel", close: async () => {} });
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    deliver!([{ type: "update", path: path.join(root, "a.txt") }]);
    expect(daemon.want.push).toBe(false);
    // Design 277 B1: the watcher path is LIVE in pull-only now, so "no push" must be
    // the suppression proving itself, not a dead watcher — the event still lands.
    expect(daemon.pendingEvents.length).toBe(1);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("design 277: pull-only filters PUSH only — every scan route stays open (#477)", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root, { pullOnly: true });
  let pumps = 0;
  daemon.pump = () => {
    pumps++;
    return Promise.resolve();
  };

  try {
    // Design 178 dropped `fullScan`/`deepScan` in pull-only because a watcherless
    // pull-only daemon scanned inside every pull anyway. B1 gives it a watcher, so that
    // rationale is dead — and the fuse-recovery re-arm needs a witnessed full-tree scan
    // it can only get through this route.
    daemon.request("fullScan");
    expect(daemon.want.fullScan).toBe(true);
    daemon.request("deepScan");
    expect(daemon.want.deepScan).toBe(true);
    daemon.request("push");
    expect(daemon.want.push).toBe(false); // publish suppression is the whole of pull-only

    daemon.want.fullScan = false;
    daemon.watcherSessions.effects.requestFullScan(); // the supervisor's re-arm witness
    expect(daemon.want.fullScan).toBe(true);
    expect(pumps).toBe(4);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a post-init watcher error revokes trust: backoff treats the watcher as dead (codex R1)", async () => {
  const previous = process.env.RBOX_WATCHER_RETRUST;
  process.env.RBOX_WATCHER_RETRUST = "0";
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let onError: ((err: Error) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, _cb, opts) => {
    onError = opts?.onError;
    return Promise.resolve({ backend: "parcel", close: async () => {} });
  };
  daemon.pumping = true;

  try {
    await daemon.startLiveWatch();
    expect(daemon.watcherTrust.healthy).toBe(true);
    // Simulate a fully backed-off idle daemon at the moment the stream dies.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    onError!(new Error("FSEvents stream died"));
    expect(daemon.watcherTrust.healthy).toBe(false); // …and stays false: trust is not restored
    // The error must also pull the ARMED backed-off timer forward — the
    // flag alone would wait out the remaining (up to 5m) timeout.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
    // With trust revoked, quiet intervals must NOT back off — the scan is now the
    // only healer for anything the (possibly dead) watcher misses.
    expect(nextSafetyDelay(CAP, { watcherLive: daemon.watcher !== undefined && daemon.watcherTrust.healthy, churned: false })).toBe(FLOOR);
  } finally {
    if (previous === undefined) delete process.env.RBOX_WATCHER_RETRUST;
    else process.env.RBOX_WATCHER_RETRUST = previous;
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a transient post-init watcher error is suspect and recoverable with the flag on", async () => {
  const previous = process.env.RBOX_WATCHER_RETRUST;
  process.env.RBOX_WATCHER_RETRUST = "1";
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  let onError: ((err: Error) => void) | undefined;
  daemon.startWatcherFn = (_root, _matcher, _cb, opts) => {
    onError = opts?.onError;
    return Promise.resolve({ backend: "parcel", close: async () => {} });
  };
  daemon.pumping = true;
  try {
    await daemon.startLiveWatch();
    onError!(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."));
    expect(daemon.watcherTrust.state).toBe("suspect");
    expect(daemon.ambientStatusFrom({ at: new Date().toISOString() }, true, Date.now()).watcherTrust).toBe("suspect");
    expect(daemon.watcherTrust.healthy).toBe(false);
    daemon.watcherTrust.lastTransientDropMs -= daemon.watcherTrust.recoveryHoldMs;
    daemon.watcherTrust.observe({
      kind: "scan",
      operationErrorGeneration: daemon.watcherTrust.errorGeneration,
      receipt: { coverage: "full-tree", errorGenAtStart: daemon.watcherTrust.errorGeneration },
    });
    expect(daemon.watcherTrust.state).toBe("trusted");
    expect(daemon.watcherTrust.healthy).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.RBOX_WATCHER_RETRUST;
    else process.env.RBOX_WATCHER_RETRUST = previous;
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("design 72: safety tick reloads workspace.json and rebuilds the matcher", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const cfg = {
    remoteWorkspaceId: "w",
    projectId: "root",
    deviceId: "d",
    rootPath: root,
    remoteUrl: "https://example.invalid",
    token: "",
    respectGitignore: false,
  };
  try {
    fs.mkdirSync(path.join(root, ".rbox"), { recursive: true });
    fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "pkg", ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify(cfg));
    await saveStateUnsafeLegacyOrTest(root, {
      stream: "https://example.invalid::w::root", stateNonce: "a".repeat(32), stateRevision: 0,
      lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
    });
    writeFolderCatalog(root, false);

    await daemon.reloadWorkspaceConfigIfChanged();
    expect(daemon.cfg.respectGitignore).toBe(false);
    expect(daemon.matcher.ignores("pkg/ignored.txt")).toBe(false);
    expect(daemon.folderPolicyRecyclePending).toBe(true);

    writeFolderCatalog(root, true);
    await daemon.reloadWorkspaceConfigIfChanged();
    expect(daemon.cfg.respectGitignore).toBe(true);
    expect(daemon.matcher.ignores("pkg/ignored.txt")).toBe(true);
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v0.9.2 regression: reload preserves runtime-attached encrypted/kek/remoteUrl", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const persisted = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://persisted.invalid", token: "" };
  try {
    fs.mkdirSync(path.join(root, ".rbox"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify(persisted));
    writeFolderCatalog(root, false);
    // Simulate what buildAuthedRemote layers on at boot — none of it is persisted.
    daemon.cfg.encrypted = true;
    daemon.cfg.kek = Buffer.alloc(32, 7);
    daemon.cfg.remoteUrl = "https://credential-override.invalid";
    daemon.cfg.token = "runtime-token";
    daemon.cfg.accountId = "acct_runtime";
    daemon.cfg.accountEpoch = 2;
    daemon.cfg.keyEpoch = 9;

    await daemon.reloadWorkspaceConfigIfChanged();

    // The v0.9.2 bug: cfg rebuilt from workspace.json dropped `encrypted` (and the
    // credential remoteUrl), so every subsequent daemon push failed "E2EE required".
    expect(daemon.cfg.encrypted).toBe(true);
    expect(Buffer.isBuffer(daemon.cfg.kek)).toBe(true);
    expect(daemon.cfg.remoteUrl).toBe("https://credential-override.invalid");
    expect(daemon.cfg.token).toBe("runtime-token");
    expect(daemon.cfg.accountId).toBe("acct_runtime");
    expect(daemon.cfg.accountEpoch).toBe(2);
    expect(daemon.cfg.keyEpoch).toBe(9);
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("damaged folder catalog parks the operation boundary without throwing from reload", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  try {
    fs.mkdirSync(path.join(root, ".rbox"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
      remoteWorkspaceId: "w",
      projectId: "root",
      deviceId: "d",
      rootPath: root,
      remoteUrl: "https://example.invalid",
      token: "",
    }));
    fs.mkdirSync(path.dirname(folderCatalogPath()), { recursive: true });
    fs.writeFileSync(folderCatalogPath(), "{ damaged");

    await expect(daemon.reloadWorkspaceConfigIfChanged()).resolves.toBeUndefined();
    expect(await daemon.folderOperationBoundary()).toBe(false);
    expect(daemon.folderAdmissionHaltReason).toContain("Copy");
    expect(daemon.folderAdmissionHaltReason).toContain("rbox config regenerate");
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace stat reload parks a rebound binding before the boot cfg can run", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const file = path.join(root, ".rbox", "workspace.json");
  const original = {
    remoteWorkspaceId: "w",
    projectId: "root",
    deviceId: "d",
    rootPath: root,
    remoteUrl: "https://persisted.invalid",
    token: "",
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(original));
    writeFolderCatalog(root, false);
    expect(await daemon.folderOperationBoundary()).toBe(true);

    fs.writeFileSync(file, JSON.stringify({
      ...original,
      remoteWorkspaceId: "new-workspace-long",
      deviceId: "new-device-long",
    }, null, 2));
    expect(await daemon.folderOperationBoundary()).toBe(false);
    expect(daemon.folderAdmissionHaltReason).toContain("workspace config identity mismatch");
    expect(daemon.cfg.remoteWorkspaceId).toBe("w");
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("folder admission halt surfaces, retries a transient workspace read, and logs state changes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-admission-recover-")));
  const logs: string[] = [];
  const daemon = makeDaemon(root, { log: (message) => logs.push(message) });
  const file = path.join(root, ".rbox", "workspace.json");
  const binding = JSON.stringify({
    remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root,
    remoteUrl: "https://example.invalid", token: "",
  });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, binding);
    writeFolderCatalog(root, false);
    expect(await daemon.folderOperationBoundary()).toBe(true);

    fs.writeFileSync(file, `{${" ".repeat(binding.length - 1)}`);
    const failedToken = fs.statSync(file);
    expect(await daemon.folderOperationBoundary()).toBe(false);
    expect(daemon.activitySnapshot().halt).toMatchObject({ typedReason: { kind: "folder-admission" } });

    fs.writeFileSync(file, binding);
    fs.utimesSync(file, failedToken.atime, failedToken.mtime);
    expect(await daemon.folderOperationBoundary()).toBe(true);
    expect(daemon.activitySnapshot().halt).toBeUndefined();
    expect(logs.filter((line) => line.startsWith("sync halted:"))).toHaveLength(1);
    expect(logs.filter((line) => line === "sync resumed: folder admission recovered")).toHaveLength(1);
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("folder admission retries and clears a duplicate binding halt without stat changes", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-admission-duplicate-")));
  const duplicate = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-admission-duplicate-")));
  const daemon = makeDaemon(root);
  const binding = (observedRoot: string) => ({
    remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: observedRoot,
    remoteUrl: "https://example.invalid", token: "",
  });
  try {
    for (const observedRoot of [root, duplicate]) {
      fs.mkdirSync(path.join(observedRoot, ".rbox"), { recursive: true });
      fs.writeFileSync(path.join(observedRoot, ".rbox", "workspace.json"), JSON.stringify(binding(observedRoot)));
    }
    const file = folderCatalogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      globalOptions: {},
      folders: [
        { name: "Primary", path: root },
        { name: "Duplicate", path: duplicate },
      ],
    }));
    expect(await daemon.folderOperationBoundary()).toBe(false);
    expect(daemon.folderAdmissionHaltReason).toContain("same workspace and device binding");

    fs.rmSync(path.join(duplicate, ".rbox", "workspace.json"));
    expect(await daemon.folderOperationBoundary()).toBe(true);
    expect(daemon.folderAdmissionHaltReason).toBeUndefined();
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(duplicate, { recursive: true, force: true });
  }
});

test("rootPath-less legacy workspace binding is admitted at its observed root", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-admission-rootless-")));
  const daemon = makeDaemon(root);
  try {
    fs.mkdirSync(path.join(root, ".rbox"), { recursive: true });
    fs.writeFileSync(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
      remoteWorkspaceId: "w", projectId: "root", deviceId: "d",
      remoteUrl: "https://example.invalid", token: "",
    }));
    writeFolderCatalog(root, false);
    expect(await daemon.folderOperationBoundary()).toBe(true);
    expect(daemon.folderAdmissionHaltReason).toBeUndefined();
  } finally {
    fs.rmSync(folderCatalogPath(), { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Git-policy recycle uses an uncached unpruned scan and acknowledges only after cache save", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const plans: RecycleScanPlan[] = [];
  let deferred = new Set<string>();
  let rebuilds = 0;
  daemon.localObserver = {
    observe: async (plan) => {
      plans.push(plan);
      return { deferredPaths: deferred };
    },
  };
  daemon.rebuildMatcher = () => { rebuilds++; };
  daemon.folderMatcherRebuildPending = false;
  daemon.folderPolicyRecyclePending = true;
  let releaseSave!: () => void;
  const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
  const save = spyOn(HashCache.prototype, "replace").mockImplementation(() => saveReleased);
  try {
    const acknowledging = daemon.acknowledgeFolderPolicyRecycle();
    await Promise.resolve();
    expect(daemon.folderPolicyRecyclePending).toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.mode).toBe("unpruned");
    expect(plans[0]?.cache).toBeInstanceOf(HashCache);
    expect(rebuilds).toBe(0);
    releaseSave();
    expect(await acknowledging).toBe(true);
    expect(daemon.folderPolicyRecyclePending).toBe(false);

    daemon.folderPolicyRecyclePending = true;
    deferred = new Set(["still-writing"]);
    expect(await daemon.acknowledgeFolderPolicyRecycle()).toBe(false);
    expect(daemon.folderPolicyRecyclePending).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(rebuilds).toBe(0);
  } finally {
    save.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty Git-policy recycle durably replaces stale on-disk hashcache entries", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const cacheFile = path.join(root, ".rbox", "state", "hashcache.json");
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({
      version: 2,
      entries: {
        "stale.txt": { mtimeMs: 1, size: 1, ctimeMs: 1, sha256: "a".repeat(64) },
      },
    }));
    daemon.localObserver = {
      observe: async () => ({ deferredPaths: new Set<string>() }),
    };
    daemon.folderMatcherRebuildPending = false;
    daemon.folderPolicyRecyclePending = true;

    expect(await daemon.acknowledgeFolderPolicyRecycle()).toBe(true);
    expect(daemon.folderPolicyRecyclePending).toBe(false);
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8"))).toEqual({
      version: 2,
      entries: {},
      // The recycle stamps the applied Git policy so a restart can detect a
      // policy edit made while the daemon was stopped (design 231 §7.3).
      gitPolicy: { syncGit: false, incremental: true },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
