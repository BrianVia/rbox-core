import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextSafetyDelay, RboxDaemon } from "../daemon.js";
import { folderCatalogPath } from "../rbox-paths.js";
import type { GitSignalBatch } from "./watcher.js";
import { HashCache } from "../../engine/index.js";

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
    matcher: unknown,
    cb: (events: unknown[]) => void,
    opts?: {
      onError?: (err: Error) => void;
      signalDebouncer?: { push(reason: "signal" | "candidate" | "other"): void };
      onInitialGitRepos?: (repos: readonly { relPath: string; kind: "dir" | "pointer" }[]) => Promise<void>;
    }
  ) => Promise<{ backend: "parcel" | "chokidar"; close(): Promise<void> }>;
  startLiveWatch(): Promise<void>;
  advanceSafetyCadenceForTick(): void;
  churnSinceSafety: boolean;
  watcherHealthy: boolean;
  trustState: "trusted" | "suspect" | "fused";
  watcherErrorGeneration: number;
  lastTransientDropMs: number;
  recoveryHoldMs: number;
  maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration: number, cov: { coverage: "full-tree" | "pruned"; errorGenAtStart: number }): void;
  safetyDelay: number;
  pumping: boolean;
  want: { push: boolean; fullScan: boolean };
  pendingEvents: unknown[];
  watcherUnsettled: boolean;
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
  folderAdmissionHaltReason?: string;
  folderMatcherRebuildPending: boolean;
  folderPolicyRecyclePending: boolean;
  localObserver: { observe(plan: unknown): Promise<{ deferredPaths: ReadonlySet<string> }> };
  rebuildMatcher(state?: unknown): void;
  acknowledgeFolderPolicyRecycle(): Promise<boolean>;
  gitDiscovery: DiscoveryInternals;
  handleGitSignalBatch(batch: GitSignalBatch): Promise<void>;
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
  let signalFailed!: (error: unknown) => void;
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
      signalFailed(error);
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
    expect(daemon.watcherUnsettled).toBe(false);
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

function makeDaemon(root: string, opts: { pullOnly?: boolean } = {}): SafetyInternals {
  const cfg = { remoteWorkspaceId: "w", projectId: "root", deviceId: "d", rootPath: root, remoteUrl: "https://example.invalid", token: "" };
  return new RboxDaemon(root, cfg as never, {} as never, opts) as unknown as SafetyInternals;
}

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
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
    await daemon.watcher?.close();
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
    expect(daemon.watcherHealthy).toBe(true);
    // Simulate a fully backed-off idle daemon at the moment the stream dies.
    daemon.safetyDelay = CAP;
    const armedBefore = daemon.safetyTimer;
    onError!(new Error("FSEvents stream died"));
    expect(daemon.watcherHealthy).toBe(false); // …and stays false: trust is not restored
    // The error must also pull the ARMED backed-off timer forward — the
    // flag alone would wait out the remaining (up to 5m) timeout.
    expect(daemon.safetyDelay).toBe(FLOOR);
    expect(daemon.safetyTimer).not.toBe(armedBefore);
    // With trust revoked, quiet intervals must NOT back off — the scan is now the
    // only healer for anything the (possibly dead) watcher misses.
    expect(nextSafetyDelay(CAP, { watcherLive: daemon.watcher !== undefined && daemon.watcherHealthy, churned: false })).toBe(FLOOR);
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
    expect(daemon.trustState).toBe("suspect");
    expect(daemon.watcherHealthy).toBe(false);
    daemon.lastTransientDropMs -= daemon.recoveryHoldMs;
    daemon.maybeClearWatcherDegradedAfterScan(daemon.watcherErrorGeneration, { coverage: "full-tree", errorGenAtStart: daemon.watcherErrorGeneration });
    expect(daemon.trustState).toBe("trusted");
    expect(daemon.watcherHealthy).toBe(true);
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

test("Git-policy recycle uses an uncached unpruned scan and acknowledges only after cache save", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-safety-")));
  const daemon = makeDaemon(root);
  const plans: Array<{ mode?: string; cache?: unknown }> = [];
  let deferred = new Set<string>();
  let rebuilds = 0;
  daemon.localObserver = {
    observe: async (plan) => {
      plans.push(plan as { mode?: string; cache?: unknown });
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
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf8"))).toEqual({ version: 2, entries: {} });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
