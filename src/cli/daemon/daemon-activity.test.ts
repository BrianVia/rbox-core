import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type BlobStore, type FileEntry, type GitSection, type IgnoreMatcher, type Manifest, type WatchEvent } from "../../engine/index.js";
import { gitIdentity } from "../sync-git/identity.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { loadActivity, renderShellLine, saveActivity, type DaemonActivity } from "../activity.js";
import { loadState, saveConfig, saveStateUnsafeLegacyOrTest, syncStreamId, type SyncState, type WorkspaceConfig } from "../config.js";
import { RboxDaemon, type DaemonTimerHandle, type ScanCadenceClock } from "../daemon.js";
import { PENDING_EVENT_CAP } from "./daemon.js";
import { daemonRuntimeDir, daemonStatusPath, readDaemonPidRecord } from "../daemon-control.js";
import { MassDeleteGuardError, pull } from "../sync.js";
import { CommitRejectedError, QuotaExceededError, type CommitOptions, type CommitResult, type SyncRemote } from "../remote.js";
import { healthLine } from "../status-view.js";
import { progressLabel } from "../status-view/progress.js";
import type { TransferPhase, TransferProgressBytes } from "../transfer-progress.js";
import type { WatchOptions, Watcher } from "./watcher.js";
import { prepareDaemonFolderAdmission, releaseDaemonFolderAdmission } from "./folder-admission.test-helper.js";
import { RBOX_VERSION } from "../version.js";

// Design 45: the daemon's activity sidecar is `rbox status`'s window into background
// sync. The load-bearing lifecycle: a pump error records a HALT (the mass-delete
// guard's only user-visible surface), the next success clears it, and a committed
// push records the last-sync trail. Exercised through the real pump via the same
// private-poke pattern as daemon-watch-degrade.test.ts.

const KEK = Buffer.alloc(32, 7);
const TEST_NOW = Date.parse("2026-07-02T12:00:00Z");
const iso = (secondsAgo: number) => new Date(TEST_NOW - secondsAgo * 1000).toISOString();

/** Minimal stateful remote: enough for empty pulls and a real committed push.
 *  `missingBlobs` returns [] (server "has" everything) — blob-upload mechanics are
 *  sync.test.ts's job; here only the activity bookkeeping is under test. */
class MiniRemote implements SyncRemote {
  head = 0;
  latestError?: Error; // when set, latest() throws it (and it stays set until cleared)
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  /** Encrypt + store content as another writer would; returns its manifest entry. */
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.manifests.set(this.head, { generatedAt: "", files });
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    if (this.latestError) throw this.latestError;
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    this.blobs.set(sha256, await fs.readFile(absPath));
  }
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      has: async (s) => blobs.has(s),
      put: async (s, bytes) => void blobs.set(s, Buffer.from(bytes)),
      get: async (s) => {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
    };
  }
}

/** The daemon privates this test drives directly (no watcher, no websocket). */
type TestStartWatcher = (root: string, matcher: IgnoreMatcher, onSettle: (events: WatchEvent[]) => void, opts?: WatchOptions) => Promise<Watcher>;

interface DaemonInternals {
  outOfStorageProbeArmed: boolean;
  watcherTrust: {
    degraded: boolean;
    observe(input: { kind: string }): unknown;
  };
  ownershipWindDownStarted: boolean;
  cache: HashCache;
  local: { head: Manifest };
  pendingEvents: WatchEvent[];
  activity: DaemonActivity;
  syncBase?: SyncState;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  recoveryDue: boolean;
  recoveryDequeuesSinceDue: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  armStandingRecovery(): void;
  startWatcherFn: TestStartWatcher;
  startLiveWatch(): Promise<void>;
  watcher?: Watcher;
  safetyTimer?: unknown;
  scheduleSafetyScan(): void;
  deepTimer?: ReturnType<typeof setInterval>;
  gitDiscovery: { readonly absenceProof?: { epoch: number; discoveredRepos: ReadonlySet<string> } };
  doFullScan(): Promise<{ coverage: "full-tree" | "pruned"; errorGenAtStart: number }>;
  doDeepScan(): Promise<{ coverage: "full-tree" | "pruned"; errorGenAtStart: number }>;
  doPull(...args: unknown[]): Promise<void>;
  retryQueue: { scheduleWriteFinish(paths: Set<string>): void };
  onTransferProgress(done: number, total: number, phase: TransferPhase, detailOrBytes?: string | TransferProgressBytes, bytes?: TransferProgressBytes): void;
  lastProgressWrite: number;
  pump(): Promise<void>;
  pumpRun: Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  loadSyncBase(): Promise<SyncState>;
  runDeferralHygiene(): Promise<void>;
  runSafetyCadenceTick(): Promise<void>;
  hasPublishableLocalDivergence(): Promise<"none" | "some" | "pending-carry" | "indeterminate">;
  doPush(...args: unknown[]): Promise<void>;
  ambientStatusFrom(activity: DaemonActivity, settled: boolean, now: number): { deferredRepos: number };
  writeHeartbeatSurfaces(): void;
  writeWsActivity(): void;
  startActivityHeartbeat(intervalMs?: number): void;
  stopActivityHeartbeat(): void;
  startAmbientStatusHeartbeat(intervalMs?: number): void;
  stopAmbientStatusHeartbeat(): void;
  beginOwnershipWindDown(reason: string): void;
  terminalPushBlock(): string | undefined;
  /** The chained sidecar-write promise — the pump never awaits it (best-effort
   *  by contract), so tests drain it explicitly before reading the file. */
  activityWrite: Promise<void>;
}

let root: string;
let daemons: DaemonInternals[];
beforeEach(async () => {
  daemons = [];
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-activity-")));
  const cfg = testConfig();
  await prepareDaemonFolderAdmission(root, cfg);
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
});
afterEach(async () => {
  await Promise.all(daemons.map((daemon) => daemon.stop().catch(() => {})));
  try {
    await releaseDaemonFolderAdmission(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function testConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_act",
    projectId: "root",
    deviceId: "dev_act",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_act",
    accountEpoch: 0,
    keyEpoch: 0,
    ...overrides,
  };
}

async function makeDaemon(
  remote: MiniRemote,
  bootId = "boot-test",
  opts: ConstructorParameters<typeof RboxDaemon>[3] = {},
  cfgOverrides: Partial<WorkspaceConfig> = {},
): Promise<DaemonInternals> {
  const cfg = testConfig(cfgOverrides);
  // A recorded push/pull failure re-queues its own operation and arms the standing
  // recovery probe with a full-jitter delay whose floor is 0ms (design 178 B). On the
  // real clock that timer can fire inside a test's own remaining awaits and land an
  // extra probe before it asserts, so no test here gets one it did not ask for: a
  // probe fires only when the test fires this clock or sets `recoveryDue`.
  const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }, { bootId, keyDeliveryFlight: null, recoveryClock: new ManualRecoveryClock(), ...opts }) as DaemonInternals;
  daemons.push(daemon);
  daemon.cache = await HashCache.load(root);
  daemon.local.head = await scanManifest(root);
  await daemon.loadSyncBase();
  return daemon;
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason?: Error): void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeScanCadenceClock implements ScanCadenceClock {
  private next = 1;
  private readonly timeouts = new Map<number, () => unknown>();
  private readonly intervals = new Map<number, () => unknown>();

  setTimeout(fn: () => void): DaemonTimerHandle {
    const id = this.next++;
    this.timeouts.set(id, fn);
    return id;
  }
  clearTimeout(handle: DaemonTimerHandle): void { this.timeouts.delete(handle as number); }
  setInterval(fn: () => void): DaemonTimerHandle {
    const id = this.next++;
    this.intervals.set(id, fn);
    return id;
  }
  clearInterval(handle: DaemonTimerHandle): void { this.intervals.delete(handle as number); }
  async fireSafety(): Promise<void> {
    const entry = this.timeouts.entries().next().value as [number, () => unknown] | undefined;
    if (!entry) throw new Error("safety timer is not armed");
    this.timeouts.delete(entry[0]);
    await entry[1]();
  }
  async fireDeep(): Promise<void> {
    const callback = this.intervals.values().next().value as (() => unknown) | undefined;
    if (!callback) throw new Error("deep timer is not armed");
    await callback();
  }
  get safetyArmed(): boolean { return this.timeouts.size > 0; }
  get deepArmed(): boolean { return this.intervals.size > 0; }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function git(repo: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "pipe" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
}

async function makeCommittedRepo(rel = "repo"): Promise<string> {
  const repo = path.join(root, rel);
  await fs.mkdir(repo);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await fs.writeFile(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, "add", "tracked.txt");
  await git(repo, "commit", "-qm", "base");
  return repo;
}
async function withIsolatedDaemonHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const oldHome = process.env.RBOX_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-owner-home-"));
  const firstOwnedDaemon = daemons.length;
  process.env.RBOX_HOME = home;
  try {
    await prepareDaemonFolderAdmission(root, testConfig());
    return await fn(home);
  } finally {
    const ownedDaemons = daemons.splice(firstOwnedDaemon);
    await Promise.allSettled(ownedDaemons.map((daemon) => daemon.stop()));
    try {
      await releaseDaemonFolderAdmission(root);
    } finally {
      if (oldHome === undefined) delete process.env.RBOX_HOME;
      else process.env.RBOX_HOME = oldHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}

class HookedCommitRemote extends MiniRemote {
  readonly commitEntered = deferred<void>();
  readonly releaseCommit = deferred<void>();
  onPutBlobFile?: () => Promise<void>;

  override async putBlobFile(sha256: string, absPath: string, _size?: number, _uploadsDir?: string): Promise<void> {
    await super.putBlobFile(sha256, absPath);
    await this.onPutBlobFile?.();
  }

  override async commit(parentSequence: number, device: string, manifest: Manifest): Promise<CommitResult> {
    this.commitEntered.resolve();
    await this.releaseCommit.promise;
    return super.commit(parentSequence, device, manifest);
  }
}

class QuotaCommitRemote extends MiniRemote {
  commitCalls = 0;
  quotaBlocked = true;
  quotaUsed = 2 * 1024 * 1024 * 1024;
  quotaCap = 2 * 1024 * 1024 * 1024;

  override async commit(parentSequence: number, device: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls++;
    if (this.quotaBlocked) throw new QuotaExceededError("storage", this.quotaUsed, this.quotaCap);
    return super.commit(parentSequence, device, manifest);
  }
}

class RejectedCommitRemote extends MiniRemote {
  commitCalls = 0;
  constructor(private readonly rejectWith: Error) {
    super();
  }
  override async commit(_parentSequence: number, _device: string, _manifest: Manifest): Promise<CommitResult> {
    this.commitCalls++;
    throw this.rejectWith;
  }
}

class StillBlockedRemote extends MiniRemote {
  commitCalls = 0;
  lastBlockedFingerprint?: string;
  stillBlocked = true;

  override async commit(parentSequence: number, device: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    this.commitCalls++;
    this.lastBlockedFingerprint = options?.blockedFingerprint;
    if (this.stillBlocked && options?.blockedFingerprint) {
      throw new CommitRejectedError("too_many_refs", 250_001, 250_000, options.blockedFingerprint, true);
    }
    return super.commit(parentSequence, device, manifest);
  }
}

class AlwaysConflictRemote extends MiniRemote {
  commitCalls = 0;
  override async commit(): Promise<CommitResult> {
    this.commitCalls++;
    return { conflict: true, head: this.head };
  }
}

class OrderedPullRemote extends MiniRemote {
  pullCalls = 0;
  constructor(private readonly order: string[]) {
    super();
  }
  override async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    this.pullCalls++;
    this.order.push("recovery");
    return super.latest();
  }
}

class BlockingLatestRemote extends MiniRemote {
  readonly entered = deferred<void>();
  readonly release = deferred<void>();
  override async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    this.entered.resolve();
    await this.release.promise;
    return super.latest();
  }
}

class ManualRecoveryClock {
  private next = 0;
  readonly callbacks = new Map<number, () => void>();
  setTimeout(fn: () => void): number {
    const id = ++this.next;
    this.callbacks.set(id, fn);
    return id;
  }
  clearTimeout(handle: DaemonTimerHandle): void {
    this.callbacks.delete(handle as number);
  }
  fireAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

class ManualSafetyClock implements ScanCadenceClock {
  private next = 0;
  readonly callbacks = new Map<number, () => void | Promise<void>>();
  setTimeout(fn: () => void | Promise<void>): number {
    const id = ++this.next;
    this.callbacks.set(id, fn);
    return id;
  }
  clearTimeout(handle: DaemonTimerHandle): void {
    this.callbacks.delete(handle as number);
  }
  // Intervals are irrelevant to the safety-cadence tests; deep-scan arming is inert.
  setInterval(): number {
    return ++this.next;
  }
  clearInterval(): void {}
  async fireAll(): Promise<void> {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    await Promise.all(callbacks.map((callback) => callback()));
  }
}

test("design 178 B: the pump serves one coalesced due probe within eight continuously replenished ambient dequeues", async () => {
  const order: string[] = [];
  const remote = new OrderedPullRemote(order);
  const clock = new ManualRecoveryClock();
  const daemon = await makeDaemon(remote, "boot-test", { now: () => TEST_NOW, recoveryClock: clock });
  daemon.activity.halt = {
    at: iso(10), reason: "pull failed", count: 1, op: "pull",
    firstFailureAt: iso(10), lastFailureAt: iso(10), consecutiveFailures: 1,
    nextProbeAt: new Date(TEST_NOW + 60_000).toISOString(),
  };
  daemon.armStandingRecovery();
  daemon.want.deepScan = true;
  let scans = 0;
  daemon.doDeepScan = async () => {
    scans++;
    order.push("ambient");
    if (scans <= 8) daemon.want.deepScan = true;
    return { coverage: "full-tree", errorGenAtStart: 0 };
  };

  // Repeated wakeups still describe one standing episode and one composite slot:
  // recoveryDue is deliberately a boolean, not a queued count.
  clock.fireAll();
  daemon.recoveryDue = true;
  daemon.recoveryDue = true;
  await daemon.pumpRun;

  expect(order.slice(0, 9)).toEqual([...Array(8).fill("ambient"), "recovery"]);
  expect(remote.pullCalls).toBe(1);
  expect(daemon.activity.halt).toBeUndefined();
});

test("design 178 B: repeated timer rearming coalesces to one composite probe", async () => {
  const clock = new ManualRecoveryClock();
  const order: string[] = [];
  const remote = new OrderedPullRemote(order);
  const daemon = await makeDaemon(remote, "boot-test", { recoveryClock: clock });
  daemon.activity.halt = {
    at: iso(10), reason: "pull failed", count: 1, op: "pull",
    nextProbeAt: new Date(Date.now() + 60_000).toISOString(),
  };
  daemon.armStandingRecovery();
  daemon.armStandingRecovery();
  daemon.armStandingRecovery();
  expect(clock.callbacks.size).toBe(1);

  // The timer callback wakes the pump synchronously, so the run it starts is the
  // signal to await — polling wall clock only races a loaded runner.
  clock.fireAll();
  await daemon.pumpRun;

  expect(remote.pullCalls).toBe(1);
  expect(daemon.activity.halt).toBeUndefined();
});

test("design 178 B: mutex-contention loops do not consume the recovery service budget", async () => {
  const order: string[] = [];
  let acquisitions = 0;
  const remote = new OrderedPullRemote(order);
  const daemon = await makeDaemon(remote, "boot-test", {
    pullOnly: true,
    acquireSyncMutex: async (workspaceRoot) => {
      acquisitions++;
      if (acquisitions <= 2) return { status: "contended", holderKey: "test-holder", blockerKind: "live" };
      return { status: "acquired", handle: { root: workspaceRoot, incarnation: `test-${acquisitions}` } };
    },
    log: () => {},
  });
  daemon.activity.halt = { at: iso(10), reason: "pull failed", count: 1, op: "pull" };
  daemon.recoveryDue = true;
  daemon.recoveryDequeuesSinceDue = 7;
  daemon.want.deepScan = true;
  daemon.doDeepScan = async () => {
    order.push("ambient");
    return { coverage: "full-tree", errorGenAtStart: 0 };
  };

  await daemon.pump();

  expect(acquisitions).toBe(4); // two contended loops, ambient dequeue, recovery dequeue
  expect(order).toEqual(["ambient", "recovery"]);
});

test("design 178 B: a recovery wakeup arriving during pump exit persistence is not lost", async () => {
  const order: string[] = [];
  const remote = new OrderedPullRemote(order);
  const daemon = await makeDaemon(remote);
  daemon.activity.halt = { at: iso(10), reason: "pull failed", count: 1, op: "pull" };
  const originalSave = daemon.cache.save.bind(daemon.cache);
  let injected = false;
  daemon.cache.save = async (workspaceRoot) => {
    if (!injected) {
      injected = true;
      daemon.recoveryDue = true;
    }
    await originalSave(workspaceRoot);
  };

  // Exit-time re-entry is awaited inside the same run, so the pump promise already
  // covers the injected wakeup.
  await daemon.pump();

  expect(remote.pullCalls).toBe(1);
  expect(daemon.activity.halt).toBeUndefined();
});

test("design 178 B: conflict preflight failure rearms without escalating the exhausted-push episode", async () => {
  const remote = new AlwaysConflictRemote();
  remote.latestError = new Error("preflight unavailable");
  const daemon = await makeDaemon(remote);
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 2, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 2,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" },
  };
  daemon.recoveryDue = true;

  await daemon.pump();

  expect(daemon.activity.halt).toMatchObject({
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 2,
    recoveryState: "armed", typedReason: { kind: "push-conflict" },
  });
  expect(remote.commitCalls).toBe(0);
});

test("design 178 B: probe dequeue durably records running state and lastProbeAt before remote work completes", async () => {
  const remote = new BlockingLatestRemote();
  const daemon = await makeDaemon(remote);
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 1, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 1,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  daemon.recoveryDue = true;
  const run = daemon.pump();
  await remote.entered.promise;
  await daemon.activityWrite;

  expect((await loadActivity(root))?.halt).toMatchObject({
    recoveryState: "running",
    lastProbeAt: expect.any(String),
  });

  remote.release.resolve();
  await run;
});

test("design 178 B: restart rearms a persisted episode but resets its in-memory starvation counter", async () => {
  await withIsolatedDaemonHome(async () => {
  const persisted: NonNullable<DaemonActivity["halt"]> = {
    at: iso(10), reason: "pull failed", count: 3, op: "pull",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 3,
    nextProbeAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await saveActivity(root, { at: new Date().toISOString(), halt: persisted });
  const restarted = await makeDaemon(new MiniRemote(), "restart-boot", { pullOnly: true });
  await restarted.start();

  expect(restarted.recoveryDequeuesSinceDue).toBe(0);
  expect(restarted.recoveryTimer).toBeDefined();
  expect(restarted.activity.halt).toMatchObject({ ...persisted, recoveryState: "armed" });
  await restarted.stop();
  });
});

test("design 178 B: restart in pull-only keeps a persisted push recovery dormant until read-write restart", async () => {
  await withIsolatedDaemonHome(async () => {
  const halt: NonNullable<DaemonActivity["halt"]> = {
    at: new Date(TEST_NOW - 10_000).toISOString(), reason: "push conflict", count: 1, op: "push",
    firstFailureAt: new Date(TEST_NOW - 30_000).toISOString(),
    typedReason: { kind: "push-conflict" }, nextProbeAt: new Date(Date.now() + 60_000).toISOString(),
  };
  await saveActivity(root, {
    at: new Date().toISOString(),
    halt,
    ws: { connected: true, at: new Date().toISOString(), caughtUp: true, bootId: "prior-boot", pid: 9999 },
  });
  const pullOnlyRemote = new AlwaysConflictRemote();
  pullOnlyRemote.latestError = new Error("temporary pull failure");
  const dormant = await makeDaemon(pullOnlyRemote, "pull-only-restart", { pullOnly: true });
  await dormant.start();
  expect(dormant.recoveryDue).toBe(false);
  expect(dormant.want.push).toBe(false);
  expect(dormant.activity.halt).toMatchObject({ op: "pull", reason: "temporary pull failure" });
  expect(dormant.activity.suspendedPushHalt).toMatchObject({ ...halt, recoveryState: "suspended" });
  expect(dormant.activity.ws?.bootId).toBe("pull-only-restart");
  expect(pullOnlyRemote.commitCalls).toBe(0);
  await dormant.stop();

  const writableRemote = new AlwaysConflictRemote();
  const writable = await makeDaemon(writableRemote, "read-write-restart");
  writable.startWatcherFn = async () => ({ backend: "parcel", close: async () => {} });
  await writable.start();
  expect(writable.recoveryTimer).toBeDefined();
  expect(writable.activity.halt).toMatchObject({
    op: "push",
    firstFailureAt: halt.firstFailureAt,
    typedReason: { kind: "push-conflict" },
    recoveryState: "armed",
  });
  expect(writable.activity.suspendedPushHalt).toBeUndefined();
  await writable.stop();
  });
});

test("review L3: startup resurrects only the intended prior activity slots", async () => {
  await withIsolatedDaemonHome(async () => {
    const oldDisabled = process.env.RBOX_DAEMON_WS_DISABLED;
    process.env.RBOX_DAEMON_WS_DISABLED = "1";
    try {
      const oldAt = "2025-01-01T00:00:00.000Z";
      const lastPush = { at: "2025-01-01T00:01:00.000Z", files: 2, sequence: 7 };
      await saveActivity(root, {
        at: oldAt,
        active: { at: oldAt, phase: "upload", done: 1, total: 2 },
        ws: { connected: true, at: oldAt, caughtUp: true, bootId: "prior-boot", pid: 9999 },
        lastPush,
      });
      const daemon = await makeDaemon(new MiniRemote(), "selective-resurrection", { pullOnly: true });
      // Observe the resurrection boundary itself rather than letting the normal
      // startup WS marker overwrite any wrongly copied prior-boot slot.

      await daemon.start();

      expect(daemon.activity.at).not.toBe(oldAt);
      expect(daemon.activity.active).toBeUndefined();
      expect(daemon.activity.ws).toMatchObject({ connected: false, caughtUp: false, bootId: "selective-resurrection" });
      expect(daemon.activity.lastPush).toEqual(lastPush);
    } finally {
      if (oldDisabled === undefined) delete process.env.RBOX_DAEMON_WS_DISABLED;
      else process.env.RBOX_DAEMON_WS_DISABLED = oldDisabled;
    }
  });
});

test("design 178 B: idle-host conflict recovery clears after pull without another publication", async () => {
  await fs.writeFile(path.join(root, "local.txt"), "local\n");
  await fs.utimes(path.join(root, "local.txt"), new Date(TEST_NOW - 60_000), new Date(TEST_NOW - 60_000));
  const remote = new AlwaysConflictRemote();
  let logicalNow = TEST_NOW;
  const daemon = await makeDaemon(remote, "boot-test", { now: () => logicalNow });
  daemon.want.push = true;
  await daemon.pump();
  expect(daemon.activity.halt?.typedReason).toEqual({ kind: "push-conflict" });
  expect(remote.commitCalls).toBeGreaterThan(0);
  const firstFailureAt = daemon.activity.halt?.firstFailureAt;
  const firstLastFailureAt = daemon.activity.halt?.lastFailureAt;
  logicalNow += 1;
  daemon.recoveryDue = true;
  await daemon.pump();
  expect(daemon.activity.halt?.firstFailureAt).toBe(firstFailureAt);
  expect(daemon.activity.halt?.consecutiveFailures).toBe(2);
  expect(Date.parse(daemon.activity.halt?.lastFailureAt ?? "")).toBeGreaterThan(Date.parse(firstLastFailureAt ?? ""));
  expect(daemon.activity.halt?.lastProbeAt).toBeDefined();
  const exhaustedCalls = remote.commitCalls;
  await fs.rm(path.join(root, "local.txt"));
  daemon.recoveryDue = true;
  await daemon.pump();
  expect(daemon.activity.halt).toBeUndefined();
  expect(remote.commitCalls).toBe(exhaustedCalls);
  expect(firstFailureAt).toBeDefined();

  // A healed/no-op transaction ends the episode: the next independent
  // exhaustion starts at tier one instead of inheriting the old backoff count.
  await fs.writeFile(path.join(root, "new-local.txt"), "new\n");
  daemon.local.head = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump();
  expect(daemon.activity.halt?.consecutiveFailures).toBe(1);
});

test("review M2: locked divergent repo is indeterminate and conflict recovery still probes once", async () => {
  const repo = await makeCommittedRepo();
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote, "locked-recovery", {}, { syncGit: true });
  await fs.writeFile(path.join(repo, ".git", "index.lock"), "");
  daemon.local.head = daemon.syncBase!.lastSyncedManifest;
  expect(await daemon.hasPublishableLocalDivergence()).toBe("indeterminate");
  daemon.hasPublishableLocalDivergence = async () => "indeterminate";
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 1, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 1,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  let pushAttempts = 0;
  daemon.doPush = async () => { pushAttempts++; };
  daemon.recoveryDue = true;

  await daemon.pump();

  expect(pushAttempts).toBe(1);
  expect(daemon.activity.halt).toBeUndefined();
});

/** Seed a git-enabled daemon whose baseline already carries the workspace's files: the
 *  pull op re-scans, and a file-level diff would arm the push before the git verdict is
 *  ever consulted. The folder catalog is the git-policy authority the pump reconciles
 *  against, so the root is re-admitted with git on. */
async function makeGitDaemon(
  bootId: string,
  gitPendingRemote: Record<string, GitSection> = {},
  remote: MiniRemote = new MiniRemote(),
): Promise<DaemonInternals> {
  await releaseDaemonFolderAdmission(root);
  await prepareDaemonFolderAdmission(root, testConfig({ syncGit: true }));
  const daemon = await makeDaemon(remote, bootId, {}, { syncGit: true });
  const seeded: SyncState = {
    ...daemon.syncBase!,
    lastSyncedManifest: await scanManifest(root),
    gitPendingRemote,
  };
  await saveStateUnsafeLegacyOrTest(root, seeded);
  daemon.syncBase = await loadState(root, seeded.stream);
  daemon.local.head = daemon.syncBase!.lastSyncedManifest;
  // The seam under test is the post-pull re-arm predicate, which reads the REAL
  // gitDivergenceStatus path. A live pull against the empty test remote would settle the
  // seeded git state out from under it, so the transfer itself is a no-op.
  daemon.doPull = async () => {};
  return daemon;
}

test("design 244 b1: a pending carry never re-arms the post-pull push", async () => {
  const repo = await makeCommittedRepo();
  const section: GitSection = {
    ...(await gitIdentity(repo))!,
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: 1,
    generatedAt: new Date(TEST_NOW).toISOString(),
  };
  const daemon = await makeGitDaemon("pending-post-pull", { repo: section });
  let pushAttempts = 0;
  daemon.doPush = async () => { pushAttempts++; };

  // The echo-publish ring: the carried section makes divergence unprovable forever, so
  // re-arming published an empty sequence this daemon then pulled back.
  expect(await daemon.hasPublishableLocalDivergence()).toBe("pending-carry");
  daemon.want.pull = true;

  await daemon.pump();

  expect(pushAttempts).toBe(0);
  expect(await daemon.hasPublishableLocalDivergence()).toBe("pending-carry"); // the carry stood
});

test("#691: a pending section clears a persisted push-conflict halt without a commit", async () => {
  const repo = await makeCommittedRepo();
  const section: GitSection = {
    ...(await gitIdentity(repo))!,
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: 1,
    generatedAt: new Date(TEST_NOW).toISOString(),
  };
  const remote = new AlwaysConflictRemote();
  const daemon = await makeGitDaemon("pending-recovery", { repo: section }, remote);
  const halt: NonNullable<DaemonActivity["halt"]> = {
    at: iso(30), reason: "push conflict", count: 1, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 1,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  await saveActivity(root, { at: new Date().toISOString(), halt });
  daemon.activity.halt = (await loadActivity(root))!.halt;
  daemon.recoveryDue = true;

  await daemon.pump();
  await daemon.activityWrite;

  expect(remote.commitCalls).toBe(0);
  expect(daemon.activity.halt).toBeUndefined();
  expect((await loadActivity(root))?.halt).toBeUndefined();
});

test("#691: mixed pending and busy repos still run one conflict-recovery push", async () => {
  const pendingRepo = await makeCommittedRepo("pending");
  const busyRepo = await makeCommittedRepo("busy");
  const section: GitSection = {
    ...(await gitIdentity(pendingRepo))!,
    bundleSha: "a".repeat(64),
    bundleEncSha: "b".repeat(64),
    bundleCipherSize: 1,
    generatedAt: new Date(TEST_NOW).toISOString(),
  };
  const daemon = await makeGitDaemon("pending-busy-recovery", { pending: section });
  await fs.writeFile(path.join(busyRepo, ".git", "index.lock"), "");
  expect(await daemon.hasPublishableLocalDivergence()).toBe("indeterminate");
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 1, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 1,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  let pushAttempts = 0;
  daemon.doPush = async () => { pushAttempts++; };
  daemon.recoveryDue = true;

  await daemon.pump();

  expect(pushAttempts).toBe(1);
  expect(daemon.activity.halt).toBeUndefined();
});

test("review M2: a busy repo is transiently unprovable and still re-arms the post-pull push", async () => {
  const repo = await makeCommittedRepo();
  const daemon = await makeGitDaemon("locked-post-pull");
  await fs.writeFile(path.join(repo, ".git", "index.lock"), "");
  let pushAttempts = 0;
  daemon.doPush = async () => { pushAttempts++; };
  expect(await daemon.hasPublishableLocalDivergence()).toBe("indeterminate");
  daemon.want.pull = true;

  await daemon.pump();

  expect(pushAttempts).toBe(1);
});

test("design 244 a1: a committed recovery push keeps the episode while divergence stands", async () => {
  const daemon = await makeDaemon(new MiniRemote(), "recovery-intent");
  daemon.hasPublishableLocalDivergence = async () => "some";
  daemon.doPush = async () => {};
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 1, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 1,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  const firstFailureAt = daemon.activity.halt.firstFailureAt;
  daemon.recoveryDue = true;

  await daemon.pump();

  expect(daemon.activity.halt?.consecutiveFailures).toBe(2);
  expect(daemon.activity.halt?.firstFailureAt).toBe(firstFailureAt);
  expect(daemon.activity.halt?.typedReason).toEqual({ kind: "push-conflict" });

  daemon.hasPublishableLocalDivergence = async () => "none";
  daemon.want.push = false;
  daemon.recoveryDue = true;
  await daemon.pump();

  expect(daemon.activity.halt).toBeUndefined();
});

test("design 178 C: daemon hygiene updates the next ambient heartbeat projection", async () => {
  await withIsolatedDaemonHome(async () => {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await new Promise<void>((resolve, reject) => {
      const child = Bun.spawn(["git", "-C", repo, "init", "-q"]);
      child.exited.then((code) => code === 0 ? resolve() : reject(new Error(`git init exited ${code}`)));
    });
    const daemon = await makeDaemon(new MiniRemote());
    const at = new Date(TEST_NOW - 60_000).toISOString();
    const seeded: SyncState = {
      ...(daemon.syncBase ?? await daemon.loadSyncBase()),
      repoRecords: {
        repo: {
          repoGen: 1,
          sourceSeq: 0,
          deferrals: { capture: { lane: "capture", reason: "git-busy", deferredSince: at, reasonSince: at, lastSeen: at } },
        },
      },
    };
    await saveStateUnsafeLegacyOrTest(root, seeded);
    daemon.syncBase = await loadState(root, seeded.stream);
    await daemon.runDeferralHygiene();
    expect(daemon.syncBase?.repoRecords?.repo?.deferrals).toBeUndefined();
    await writeOwnedDaemonPid();
    daemon.writeHeartbeatSurfaces();
    await daemon.activityWrite;
    expect((await readAmbientStatus()).deferredRepos).toBe(0);
  });
});

test("review H2: the pull-only safety cadence clears a stale lane, now through its own fullScan", async () => {
  await withIsolatedDaemonHome(async () => {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await new Promise<void>((resolve, reject) => {
      const child = Bun.spawn(["git", "-C", repo, "init", "-q"]);
      child.exited.then((code) => code === 0 ? resolve() : reject(new Error(`git init exited ${code}`)));
    });
    const clock = new ManualSafetyClock();
    const daemon = await makeDaemon(new MiniRemote(), "pull-only-hygiene", {
      pullOnly: true,
      now: () => TEST_NOW,
      scanCadenceClock: clock,
    });
    const at = new Date(TEST_NOW - 60_000).toISOString();
    const seeded: SyncState = {
      ...(daemon.syncBase ?? await daemon.loadSyncBase()),
      repoRecords: {
        repo: {
          repoGen: 1,
          sourceSeq: 0,
          deferrals: { capture: { lane: "capture", reason: "git-busy", deferredSince: at, reasonSince: at, lastSeen: at } },
        },
      },
    };
    await saveStateUnsafeLegacyOrTest(root, seeded);
    daemon.syncBase = await loadState(root, seeded.stream);
    // Design 277: pull-only no longer filters `fullScan`, so the safety tick takes the
    // read-write route and deferral hygiene rides the scan tail instead of being the
    // tick's whole body. The lane still clears, and still without a push.
    let scans = 0;
    const doFullScan = daemon.doFullScan.bind(daemon);
    daemon.doFullScan = async () => {
      scans++;
      return doFullScan();
    };
    daemon.scheduleSafetyScan();
    expect(daemon.safetyTimer).toBeDefined();
    await clock.fireAll();
    await daemon.pumpRun;

    expect(scans).toBe(1);
    expect(daemon.syncBase?.repoRecords?.repo?.deferrals).toBeUndefined();
    expect((await loadState(root, seeded.stream)).repoRecords?.repo?.deferrals).toBeUndefined();
    expect(daemon.want.fullScan).toBe(false);
    expect(daemon.want.push).toBe(false);
  });
});

test("pr8: production pull-only timers remint discovery and clear a ghost without pushing", async () => {
  await withIsolatedDaemonHome(async () => {
    let now = TEST_NOW;
    const clock = new FakeScanCadenceClock();
    const remote = new MiniRemote();
    const daemon = await makeDaemon(remote, "pull-only-pr8", { pullOnly: true, now: () => now, scanCadenceClock: clock });
    // Design 277 B1: a pull-only boot now starts the live watcher. The boot scan still
    // mints an absence proof — it runs BEFORE the watcher exists, so it is unpruned —
    // and this fixture keeps pinning the DEGRADED world, where the watcher factory
    // rejects exactly as production does when it cannot arm. The healthy-watcher path
    // has its own test below.
    daemon.startWatcherFn = () => Promise.reject(new Error("forced watcher-init failure (pr8 fixture)"));
    const at = new Date(TEST_NOW - 60_000).toISOString();
    const seeded: SyncState = {
      ...(daemon.syncBase ?? await daemon.loadSyncBase()),
      repoRecords: {
        ghost: {
          repoGen: 1,
          sourceSeq: 0,
          deferrals: { capture: { lane: "capture", reason: "git-busy", deferredSince: at, reasonSince: at, lastSeen: at } },
        },
      },
    };
    await saveStateUnsafeLegacyOrTest(root, seeded);
    daemon.syncBase = await loadState(root, seeded.stream);

    await daemon.start();
    expect(clock.safetyArmed).toBe(true);
    expect(clock.deepArmed).toBe(true);
    const firstEpoch = daemon.gitDiscovery.absenceProof?.epoch;
    expect(firstEpoch).toBeDefined();

    // Design 277: pull-only no longer filters `fullScan`, so a degraded pull-only host
    // pays read-write's safety-scan cost — and gets read-write's healing. The safety
    // tick now reminits discovery itself instead of waiting 30m for the deep tick.
    await clock.fireSafety();
    await daemon.pumpRun;
    expect(daemon.gitDiscovery.absenceProof?.epoch).toBe(firstEpoch! + 1);

    now += 30_000;
    await clock.fireDeep();
    await Promise.resolve();
    await daemon.pumpRun;
    expect(daemon.gitDiscovery.absenceProof?.epoch).toBe(firstEpoch! + 2);
    expect(daemon.syncBase?.repoRecords?.ghost?.deferrals).toBeUndefined();
    expect((await loadState(root, seeded.stream)).repoRecords?.ghost?.deferrals).toBeUndefined();
    expect(daemon.want.push).toBe(false);
    expect(remote.head).toBe(0);
  });
});

test("design 277 B1: an unscoped pull-only boot starts the live watcher session (#477)", async () => {
  await withIsolatedDaemonHome(async () => {
    const clock = new FakeScanCadenceClock();
    const daemon = await makeDaemon(new MiniRemote(), "pull-only-watch", { pullOnly: true, now: () => TEST_NOW, scanCadenceClock: clock });
    let started = 0;
    daemon.startWatcherFn = () => {
      started++;
      return Promise.resolve({ backend: "parcel", close: async () => {} });
    };

    await daemon.start();

    expect(started).toBe(1);
    expect(daemon.watcher).toBeDefined();
    // The periodic floor stays armed alongside the watcher, exactly as read-write.
    expect(clock.safetyArmed).toBe(true);
    expect(clock.deepArmed).toBe(true);
  });
});

test("design 277 B4: a scoped binding boots without a live watcher (#477)", async () => {
  await withIsolatedDaemonHome(async () => {
    const scopedCfg = testConfig({ scope: ["sub"], scopeGeneration: 1 });
    await saveConfig(root, scopedCfg);
    const clock = new FakeScanCadenceClock();
    const daemon = await makeDaemon(new MiniRemote(), "scoped-no-watch", { now: () => TEST_NOW, scanCadenceClock: clock }, { scope: ["sub"], scopeGeneration: 1 });
    let started = 0;
    daemon.startWatcherFn = () => {
      started++;
      return Promise.resolve({ backend: "parcel", close: async () => {} });
    };

    await daemon.start();

    // This test cannot discriminate the gate PREDICATE by construction: a scoped
    // binding forces `pullOnly`, so `scoped` and `pullOnly` are both true here and a
    // `pullOnly` gate would pass it too. The discriminator is the B1 test above — an
    // unscoped pull-only boot that DOES start the watcher.
    expect(started).toBe(0);
    expect(daemon.watcher).toBeUndefined();
    // Negative control: the boot really reached the mode gate (a halted scope seal
    // would also leave the watcher unstarted) and armed the periodic-scan floor.
    expect(clock.safetyArmed).toBe(true);
    expect(clock.deepArmed).toBe(true);
  });
});

test("design 178 B: safety halt clears only when its own recovery predicate stops reproducing", async () => {
  const remote = new MiniRemote();
  remote.latestError = new MassDeleteGuardError("pull", "pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  let now = TEST_NOW;
  const clock = new ManualRecoveryClock();
  const daemon = await makeDaemon(remote, "boot-test", { now: () => now, recoveryClock: clock });

  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const halted = await loadActivity(root);
  expect(halted?.halt?.reason).toContain("mass-delete guard");
  expect(halted?.halt?.count).toBe(1);
  expect(halted?.halt?.op).toBe("pull");
  expect(halted?.halt?.typedReason).toEqual({ kind: "mass-delete", op: "pull" });
  expect(halted?.halt?.firstFailureAt).toBe(halted?.halt?.at);
  expect(halted?.halt?.consecutiveFailures).toBe(1);
  expect(halted?.halt?.nextProbeAt).toBeDefined();

  // Regression guard: a successful op of a DIFFERENT kind (the queued
  // no-op push, every safety scan) must NOT heal a pull halt — the guard warning
  // would flap off within seconds of every trip.
  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  expect((await loadActivity(root))?.halt?.reason).toContain("mass-delete guard");

  now += 60_000;
  remote.latestError = undefined;
  daemon.recoveryDue = true;
  await daemon.pump();
  await daemon.activityWrite;
  const healed = await loadActivity(root);
  expect(healed?.halt).toBeUndefined();
  expect(healed?.at).toBeDefined();

  // Regression guard: a NEW failure with the SAME message after a heal is a new
  // episode — it must persist a fresh halt (not silently count as dedup repeat 2..9
  // and leave activity.json healed).
  now += 60_000;
  remote.latestError = new MassDeleteGuardError("pull", "pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const rehalted = await loadActivity(root);
  expect(rehalted?.halt?.reason).toContain("mass-delete guard");
  expect(rehalted?.halt?.count).toBe(1);
});

test("review M3: typed mass-delete episode identity survives changing count text", async () => {
  const remote = new MiniRemote();
  remote.latestError = new MassDeleteGuardError("pull", "pull would delete 8000 of 9000 tracked files — refusing (mass-delete guard).");
  const daemon = await makeDaemon(remote);
  daemon.want.pull = true;
  await daemon.pump();
  const firstFailureAt = daemon.activity.halt?.firstFailureAt;

  remote.latestError = new MassDeleteGuardError("pull", "pull would delete 8100 of 9000 tracked files — refusing (mass-delete guard).");
  daemon.recoveryDue = true;
  await daemon.pump();

  expect(daemon.activity.halt).toMatchObject({
    reason: expect.stringContaining("8100 of 9000"),
    firstFailureAt,
    consecutiveFailures: 2,
    typedReason: { kind: "mass-delete", op: "pull" },
  });
});

test("a committed push records the last-sync trail; a no-op push does not", async () => {
  const remote = new MiniRemote();
  const logs: string[] = [];
  const daemon = await makeDaemon(remote, "push-residuals", { log: (line) => logs.push(line) });
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  const after = await loadActivity(root);
  expect(after?.lastPush).toEqual({ at: expect.any(String), files: 1, sequence: 1 });
  expect(after?.active).toBeUndefined(); // live progress never outlives its op
  const pushSummary = logs.find((line) => line.startsWith("rbox push "))!;
  expect(pushSummary).toContain("prologue_ms=");
  expect(pushSummary).toContain("settle_ms=");
  expect(pushSummary).toContain("projection=");
  expect(pushSummary).toContain("projection_ignore_carry=");
  expect(pushSummary).toContain("projection_casefold=");
  expect(pushSummary).toContain("projection_diff=");
  expect(pushSummary).toContain("delta_base=");
  expect(pushSummary).toContain("ack=");
  expect(pushSummary).toContain("publish_transition=");
  expect(pushSummary).toContain("drain_wait=");

  daemon.want.push = true; // steady state: no changes → no-op → trail unchanged
  await daemon.pump();
  await daemon.activityWrite;
  expect((await loadActivity(root))?.lastPush?.sequence).toBe(1);
});

test("#661: a committed push's report settles at its own boundary, not behind later queued work", async () => {
  const remote = new MiniRemote();
  const logs: string[] = [];
  const daemon: DaemonInternals = await makeDaemon(remote, "push-settle-boundary", {
    log: (line: string) => {
      logs.push(line);
      // The field shape (#661): publishing provokes a pull that the same pump loop
      // then services. The push's report must already be out.
      if (line.startsWith("push: published sequence")) daemon.want.pull = true;
    },
  });
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  const pushSummary = logs.findIndex((line) => line.startsWith("rbox push "));
  const pullRun = logs.findIndex((line) => line.startsWith("pull local="));
  expect(pushSummary).toBeGreaterThanOrEqual(0);
  expect(pullRun).toBeGreaterThan(pushSummary);
});

test("the 409-recovery pull inside a push is recorded in the trail (codex R2)", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "mine");
  daemon.local.head = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump(); // baseline: sequence 1
  await daemon.activityWrite;

  // Another writer advances the remote (adds b.txt) → our next push 409s.
  const current = (await remote.latest()).manifest.files;
  remote.injectCommit([...current, await remote.seedEntry("b.txt", "theirs")]);

  await fs.writeFile(path.join(root, "c.txt"), "more local work");
  daemon.local.head = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump(); // 409 → internal pull writes b.txt → re-scan → commit seq 3
  await daemon.activityWrite;

  const after = await loadActivity(root);
  // The recovery pull's local-tree mutation is recorded in ITS OWN slot — the
  // subsequent successful push must not mask it.
  expect(after?.lastPull).toEqual({ at: expect.any(String), writes: 1, deletes: 0, conflicts: 0 });
  expect(after?.lastPush?.sequence).toBe(3);
  expect(after?.lastPush?.files).toBe(3); // a.txt + b.txt + c.txt
  expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("theirs");
});

test.serial("propagation tracing enables pull phases with metrics and telemetry off, while trace-off emits nothing", async () => {
  const previousTrace = process.env.RBOX_TRACE_PROPAGATION;
  const previousMetrics = process.env.RBOX_METRICS;
  const previousTelemetry = process.env.RBOX_TELEMETRY;
  process.env.RBOX_METRICS = "0";
  process.env.RBOX_TELEMETRY = "0";
  try {
    process.env.RBOX_TRACE_PROPAGATION = "1";
    const tracedLogs: string[] = [];
    const tracedRemote = new MiniRemote();
    tracedRemote.injectCommit([]);
    const traced = await makeDaemon(tracedRemote, "trace-on", { log: (line) => tracedLogs.push(line) });
    traced.want.pull = true;
    await traced.pump();
    const applyLine = tracedLogs.find((line) => line.startsWith("propagation_receive ") && line.includes('"event":"apply_complete"'))!;
    const apply = JSON.parse(applyLine.slice("propagation_receive ".length)) as { phase_ms?: Record<string, number> };
    expect(apply.phase_ms).toEqual(expect.objectContaining({
      validate: expect.any(Number),
      reconcile: expect.any(Number),
      "git-apply": expect.any(Number),
    }));

    await traced.stop();
    delete process.env.RBOX_TRACE_PROPAGATION;
    const untracedLogs: string[] = [];
    tracedRemote.injectCommit([]);
    const untraced = await makeDaemon(tracedRemote, "trace-off", { log: (line) => untracedLogs.push(line) });
    untraced.want.pull = true;
    await untraced.pump();
    expect(untracedLogs.filter((line) => line.startsWith("propagation_receive "))).toEqual([]);
  } finally {
    if (previousTrace === undefined) delete process.env.RBOX_TRACE_PROPAGATION; else process.env.RBOX_TRACE_PROPAGATION = previousTrace;
    if (previousMetrics === undefined) delete process.env.RBOX_METRICS; else process.env.RBOX_METRICS = previousMetrics;
    if (previousTelemetry === undefined) delete process.env.RBOX_TELEMETRY; else process.env.RBOX_TELEMETRY = previousTelemetry;
  }
});

test.serial("push-conflict recovery adoption keeps the bare apply-complete record", async () => {
  const previousTrace = process.env.RBOX_TRACE_PROPAGATION;
  process.env.RBOX_TRACE_PROPAGATION = "1";
  try {
    const logs: string[] = [];
    const remote = new MiniRemote();
    const daemon = await makeDaemon(remote, "recovery-trace", { log: (line) => logs.push(line) });
    await fs.writeFile(path.join(root, "a.txt"), "mine");
    daemon.local.head = await scanManifest(root);
    daemon.want.push = true;
    await daemon.pump();

    const current = (await remote.latest()).manifest.files;
    remote.injectCommit([...current, await remote.seedEntry("b.txt", "theirs")]);
    await fs.writeFile(path.join(root, "c.txt"), "more local work");
    daemon.local.head = await scanManifest(root);
    daemon.want.push = true;
    await daemon.pump();

    const records = logs
      .filter((line) => line.startsWith("propagation_receive ") && line.includes('"event":"apply_complete"'))
      .map((line) => JSON.parse(line.slice("propagation_receive ".length)) as {
        v: number;
        event: string;
        adopted_sequence: number;
        phase_ms?: Record<string, number>;
      });
    expect(records).toContainEqual({ v: 1, event: "apply_complete", adopted_sequence: 2 });
    expect(records.some((record) => "phase_ms" in record)).toBe(false);
  } finally {
    if (previousTrace === undefined) delete process.env.RBOX_TRACE_PROPAGATION; else process.env.RBOX_TRACE_PROPAGATION = previousTrace;
  }
});


// Design 46: the daemon renders the prompt sidecar (`shell.line`) alongside every
// activity.json write, from the SAME record on the SAME ordered chain. The zsh prompt
// hook just reads it, so these assertions guard the fields it depends on.
async function readShellLine(): Promise<string> {
  return (await fs.readFile(path.join(root, ".rbox", "state", "shell.line"), "utf8")).trimEnd();
}

async function readAmbientStatus(): Promise<AmbientDaemonStatusV1> {
  return JSON.parse(await fs.readFile(daemonStatusPath(root), "utf8")) as AmbientDaemonStatusV1;
}

async function waitForAmbientState(state: AmbientDaemonStatusV1["state"], timeoutMs = 1000): Promise<AmbientDaemonStatusV1> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await readAmbientStatus();
      if (status.state === state) return status;
      last = status;
    } catch (e) {
      last = e;
    }
    await sleep(25);
  }
  throw new Error(`ambient status did not become ${state}: ${JSON.stringify(last)}`);
}

async function writeOwnedDaemonPid(): Promise<void> {
  const runtime = daemonRuntimeDir(root);
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(runtime, "daemon.pid"), `v2 ${process.pid} boot-test\n`);
}

async function closeWatcherTimers(daemon: DaemonInternals): Promise<void> {
  if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
  if (daemon.deepTimer) clearInterval(daemon.deepTimer);
  await daemon.watcher?.close();
}

function captureWatcherErrors(daemon: DaemonInternals) {
  let onError: ((err: Error) => void) | undefined;
  daemon.startWatcherFn = async (_root, _matcher, _onSettle, opts = {}) => {
    onError = opts.onError;
    return { backend: "parcel", close: async () => {} };
  };
  return {
    fire(err) {
      if (!onError) throw new Error("watcher error callback was not installed");
      onError(err);
    },
  };
}

test("a committed push writes shell.line: v1, state ok, committed sequence (design 46)", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;

  const line = await readShellLine();
  const parts = line.split(" ");
  expect(line.startsWith("v1 ")).toBe(true);
  expect(parts[2]).toBe("ok"); // pump settled, nothing queued
  expect(parts[4]).toBe("1"); // sequence = the committed seq (lastLoggedSeq)
  expect(line).toContain("ws_act"); // name falls back to the workspace id
});

test("design 178 B: a timer-owned generic retry writes shell.line pending, not halted", async () => {
  const remote = new MiniRemote();
  remote.latestError = new Error("temporary pull failure");
  const daemon = await makeDaemon(remote);

  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect((await readShellLine()).split(" ")[2]).toBe("pending");
});

test("ambient status writes beside the pidfile and carries local-only currentPath", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.pid"), `v2 ${process.pid} boot-test\n`);

    daemon.onTransferProgress(1, 3, "encrypt", "src/private-file.ts");
    await daemon.activityWrite;

    const status = await readAmbientStatus();
    expect(status).toMatchObject({
      schemaVersion: 1,
      state: "syncing",
      sequence: null,
      fileCount: 0,
      totalBytes: 0,
      daemonVersion: RBOX_VERSION,
      mode: "read-write",
      bootId: "boot-test",
      workspaceRoot: root,
      operation: { kind: "push", phase: "encrypt", filesDone: 1, filesTotal: 3, currentPath: "src/private-file.ts" },
    });
  });
});

test("ambient status totalBytes sums the tracked manifest's file sizes", async () => {
  await withIsolatedDaemonHome(async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello"); // 5 bytes
    await fs.writeFile(path.join(root, "b.txt"), "hello world!"); // 12 bytes
    const daemon = await makeDaemon(new MiniRemote());
    await writeOwnedDaemonPid();

    daemon.want.push = true;
    await daemon.pump();
    await daemon.activityWrite;

    const status = await readAmbientStatus();
    expect(status).toMatchObject({ fileCount: 2, totalBytes: 17 });
  });
});

test("transient watcher degradation clears after a clean covering scan and stays synced", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const errors = captureWatcherErrors(daemon);
    await writeOwnedDaemonPid();

    try {
      await daemon.startLiveWatch();
      errors.fire(new Error("Events were dropped by the FSEvents client"));
      await daemon.activityWrite;
      expect(daemon.watcherTrust.degraded).toBe(true);
      expect(await readAmbientStatus()).toMatchObject({ state: "attention", attentionReason: "watcher-degraded" });

      daemon.want.fullScan = true;
      await daemon.pump();
      await daemon.activityWrite;
      expect(daemon.watcherTrust.degraded).toBe(false);
      expect(await readAmbientStatus()).toMatchObject({ state: "synced" });

      daemon.want.fullScan = true;
      await daemon.pump();
      await daemon.activityWrite;
      expect(daemon.watcherTrust.degraded).toBe(false);
      expect(await readAmbientStatus()).toMatchObject({ state: "synced" });
    } finally {
      await closeWatcherTimers(daemon);
    }
  });
});

test("a second watcher error during the covering scan keeps status degraded", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const errors = captureWatcherErrors(daemon);
    const scanEntered = deferred<void>();
    const releaseScan = deferred<void>();
    const realFullScan = daemon.doFullScan.bind(daemon);
    daemon.doFullScan = async () => {
      scanEntered.resolve();
      await releaseScan.promise;
      return realFullScan(); // forward ScanCoverage so the completion hook gets errorGenAtStart
    };
    await writeOwnedDaemonPid();

    try {
      await daemon.startLiveWatch();
      errors.fire(new Error("first dropped-events warning"));
      daemon.want.fullScan = true;
      const pumpDone = daemon.pump();
      await scanEntered.promise;
      errors.fire(new Error("second dropped-events warning"));
      releaseScan.resolve();
      await pumpDone;
      await daemon.activityWrite;

      expect(daemon.watcherTrust.degraded).toBe(true);
      expect(await readAmbientStatus()).toMatchObject({ state: "attention", attentionReason: "watcher-degraded" });
    } finally {
      releaseScan.resolve();
      await closeWatcherTimers(daemon);
    }
  });
});

test("watch-unavailable degradation never self-clears without a live watcher", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    daemon.startWatcherFn = async () => {
      throw new Error("forced watcher-init failure");
    };
    await writeOwnedDaemonPid();

    try {
      await daemon.startLiveWatch();
      await daemon.activityWrite;
      expect(daemon.watcher).toBeUndefined();
      expect(await readAmbientStatus()).toMatchObject({ state: "attention", attentionReason: "watcher-degraded" });

      daemon.want.fullScan = true;
      await daemon.pump();
      await daemon.activityWrite;
      expect(daemon.watcherTrust.degraded).toBe(true);
      expect(await readAmbientStatus()).toMatchObject({ state: "attention", attentionReason: "watcher-degraded" });
    } finally {
      await closeWatcherTimers(daemon);
    }
  });
});

test("quota errors record outOfStorage, suppress watcher uploads, probe on safety scan, and clear on success", async () => {
  const remote = new QuotaCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  let activity = await loadActivity(root);
  expect(remote.commitCalls).toBe(1);
  expect(activity?.halt).toBeUndefined();
  expect(activity?.outOfStorage).toEqual({
    at: expect.any(String),
    kind: "storage",
    used: 2 * 1024 * 1024 * 1024,
    cap: 2 * 1024 * 1024 * 1024,
  });
  expect((await readShellLine()).split(" ")[2]).toBe("outofstorage");

  await fs.writeFile(path.join(root, "a.txt"), "hello again");
  daemon.pendingEvents.push({ relPath: "a.txt", kind: "change" });
  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  expect(remote.commitCalls).toBe(1);
  expect((await loadActivity(root))?.outOfStorage?.kind).toBe("storage");

  daemon.want.fullScan = true;
  await daemon.pump();
  await daemon.activityWrite;
  expect(remote.commitCalls).toBe(2);
  expect((await loadActivity(root))?.outOfStorage?.kind).toBe("storage");

  remote.quotaBlocked = false;
  daemon.want.fullScan = true;
  await daemon.pump();
  await daemon.activityWrite;
  activity = await loadActivity(root);
  expect(remote.commitCalls).toBe(3);
  expect(activity?.outOfStorage).toBeUndefined();
  expect(activity?.halt).toBeUndefined();
  expect(activity?.lastPush?.sequence).toBe(1);
});

test("review M1: quota thrown by a conflict recovery probe is reclassified", async () => {
  const remote = new QuotaCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "local.txt"), "publish me");
  daemon.local.head = await scanManifest(root);
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 2, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 2,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  daemon.recoveryDue = true;

  await daemon.pump();
  await daemon.activityWrite;

  expect(remote.commitCalls).toBe(1);
  expect(daemon.activity.outOfStorage?.kind).toBe("storage");
  expect(daemon.activity.halt).toBeUndefined();
  expect((await loadActivity(root))?.halt).toBeUndefined();
});

test("review M1: unrelated generic probe error starts a message-only episode", async () => {
  const remote = new RejectedCommitRemote(new Error("unrelated upload failure"));
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "local.txt"), "publish me");
  daemon.local.head = await scanManifest(root);
  const originalFirstFailureAt = iso(30);
  daemon.activity.halt = {
    at: originalFirstFailureAt, reason: "push conflict", count: 3, op: "push",
    firstFailureAt: originalFirstFailureAt, lastFailureAt: iso(10), consecutiveFailures: 3,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  daemon.recoveryDue = true;

  await daemon.pump();

  expect(daemon.activity.halt).toMatchObject({
    reason: "unrelated upload failure",
    consecutiveFailures: 1,
    op: "push",
  });
  expect(daemon.activity.halt?.typedReason).toBeUndefined();
  expect(daemon.activity.halt?.firstFailureAt).not.toBe(originalFirstFailureAt);
});

test("review M1: commit rejection during a conflict probe captures the new fingerprint", async () => {
  const rejected = new CommitRejectedError("too_many_refs", 250_001, 250_000, "probe-fingerprint");
  const remote = new RejectedCommitRemote(rejected);
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "local.txt"), "publish me");
  daemon.local.head = await scanManifest(root);
  daemon.activity.halt = {
    at: iso(30), reason: "push conflict", count: 2, op: "push",
    firstFailureAt: iso(30), lastFailureAt: iso(10), consecutiveFailures: 2,
    nextProbeAt: iso(1), typedReason: { kind: "push-conflict" }, recoveryState: "armed",
  };
  daemon.recoveryDue = true;

  await daemon.pump();

  expect(daemon.activity.halt).toMatchObject({
    reason: rejected.message,
    consecutiveFailures: 1,
    typedReason: { kind: "too-many-refs" },
    terminal: { fingerprint: "probe-fingerprint" },
  });
});

test.each([
  [new CommitRejectedError("too_many_refs", 250_001, 250_000, "sidecar-fingerprint"), "too-many-refs"],
  [new CommitRejectedError("body_too_large", undefined, undefined, "sidecar-fingerprint"), "body-too-large"],
] as const)("CommitRejectedError %s records a typed terminal push halt", async (err, expectedKind) => {
  const remote = new RejectedCommitRemote(err);
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;

  const activity = await loadActivity(root);
  expect(remote.commitCalls).toBe(1);
  expect(activity?.halt).toMatchObject({
    at: expect.any(String),
    reason: err.message,
    count: 1,
    op: "push",
    typedReason: { kind: expectedKind },
    terminal: { fingerprint: "sidecar-fingerprint" },
  });
  expect((await readShellLine()).split(" ")[2]).toBe("halt");
});

test("push mass-delete refusal persists the producer-authored push classification", async () => {
  const err = new MassDeleteGuardError("push", "push would delete 1000 of 1000 tracked files — refusing (mass-delete guard).");
  const remote = new RejectedCommitRemote(err);
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  daemon.recoveryDue = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect((await loadActivity(root))?.halt).toMatchObject({
    reason: err.message,
    op: "push",
    typedReason: { kind: "mass-delete", op: "push" },
  });
});

test("terminal push halt passes blocked fingerprint into the push and preserves the halt when still blocked", async () => {
  const remote = new StillBlockedRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);
  daemon.activity.halt = {
    at: "2026-07-02T12:00:00.000Z",
    reason: "workspace needs 250,001 blob refs per commit; the server cap is 250,000.",
    count: 1,
    op: "push",
    terminal: { fingerprint: "blocked-sidecar-sha" },
  };

  daemon.want.push = true;
  daemon.recoveryDue = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect(remote.commitCalls).toBe(1); // the push ran; E2eeRemote is the point of truth for the comparison.
  expect(remote.lastBlockedFingerprint).toBe("blocked-sidecar-sha");
  expect(await loadActivity(root)).toMatchObject({
    halt: {
      at: "2026-07-02T12:00:00.000Z",
      reason: "workspace needs 250,001 blob refs per commit; the server cap is 250,000.",
      count: 2,
      consecutiveFailures: 2,
      op: "push",
      terminal: { fingerprint: "blocked-sidecar-sha" },
    },
  });

  remote.stillBlocked = false;
  await fs.writeFile(path.join(root, "a.txt"), "changed");
  daemon.local.head = await scanManifest(root);
  daemon.want.push = true;
  daemon.recoveryDue = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect(remote.commitCalls).toBe(2);
  expect(daemon.activity.halt).toBeUndefined();
  expect((await loadActivity(root))?.lastPush?.sequence).toBe(1);
});

test("a quota probe refreshes outOfStorage without clearing a real pull halt", async () => {
  const remote = new QuotaCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.local.head = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  const firstQuota = await loadActivity(root);
  expect(firstQuota?.outOfStorage?.used).toBe(2 * 1024 * 1024 * 1024);
  expect(firstQuota?.halt).toBeUndefined();

  remote.latestError = new MassDeleteGuardError("pull", "pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const halted = await loadActivity(root);
  expect(halted?.halt?.op).toBe("pull");
  expect(halted?.halt?.reason).toContain("mass-delete guard");
  expect(halted?.outOfStorage?.used).toBe(2 * 1024 * 1024 * 1024);

  remote.quotaUsed = 3 * 1024 * 1024 * 1024;
  daemon.want.fullScan = true;
  await daemon.pump();
  await daemon.activityWrite;
  const probed = await loadActivity(root);
  expect(remote.commitCalls).toBe(2);
  expect(probed?.halt?.op).toBe("pull");
  expect(probed?.halt?.reason).toContain("mass-delete guard");
  expect(probed?.outOfStorage?.used).toBe(3 * 1024 * 1024 * 1024);
  expect((await readShellLine()).split(" ")[2]).toBe("halt");

  const line = healthLine({
    added: 0,
    changed: 0,
    deleted: 0,
    trackedFiles: 1,
    daemonRunning: true,
    localSequence: 0,
    remote: { sequence: 0, source: "probe" },
    activity: probed,
    now: Date.now(),
  });
  expect(line).toContain("sync failing");
  expect(line).toContain("mass-delete guard");
  expect(line).not.toContain("out of storage");
});

test("a throwing onPullApplied hook never fails a completed pull (codex R3)", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("x.txt", "hi")]);
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_act",
    projectId: "root",
    deviceId: "dev_act",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_act",
    accountEpoch: 0,
    keyEpoch: 0,
  };
  const actions = await pull(root, cfg, {
    remote,
    backoff: async () => {},
    onPullApplied: () => {
      throw new Error("observability boom");
    },
  });
  expect(actions).toHaveLength(1); // the pull itself succeeded…
  expect(await fs.readFile(path.join(root, "x.txt"), "utf8")).toBe("hi"); // …and applied
});

test("onPullAdopted observes sequence-only advances and suppresses unchanged heads", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([]);
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_act",
    projectId: "root",
    deviceId: "dev_act",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_act",
    accountEpoch: 0,
    keyEpoch: 0,
  };
  const adopted: number[] = [];
  const pullApplied: number[] = [];
  const deps = {
    remote,
    backoff: async () => {},
    onPullAdopted: (sequence: number) => adopted.push(sequence),
    onPullApplied: () => pullApplied.push(1),
  };

  expect(await pull(root, cfg, deps)).toEqual([]);
  expect(adopted).toEqual([1]);
  expect(pullApplied).toEqual([]);

  expect(await pull(root, cfg, deps)).toEqual([]);
  expect(adopted).toEqual([1]);
  expect(pullApplied).toEqual([]);
});

test("an idle pull + no-op push settles shell.line back to ok (codex R4)", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);

  // The classic steady-state tick: pull queues a follow-up push; the pull's write
  // renders `pending` (push still queued) and the no-op push writes nothing.
  daemon.want.pull = true;
  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;

  const line = await fs.readFile(path.join(root, ".rbox", "state", "shell.line"), "utf8");
  expect(line.split(" ")[2]).toBe("ok");
});

test("local snapshot stays unsettled while a pump op is in flight", async () => {
  const remote = new HookedCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "during.txt"), "local work");
  daemon.local.head = await scanManifest(root, undefined, daemon.cache);
  daemon.want.push = true;

  const pump = daemon.pump();
  await remote.commitEntered.promise;
  try {
    daemon.writeWsActivity();
    await daemon.activityWrite;

    expect((await loadActivity(root))?.local?.settled).toBe(false);
  } finally {
    remote.releaseCommit.resolve();
    await pump;
    await daemon.activityWrite;
  }
});

test("timer heartbeat advances while a pump op is in flight", async () => {
  const remote = new HookedCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "during.txt"), "local work");
  daemon.local.head = await scanManifest(root, undefined, daemon.cache);
  daemon.want.push = true;

  const pump = daemon.pump();
  await remote.commitEntered.promise;
  const before = daemon.activity.at;
  try {
    daemon.startActivityHeartbeat(5);
    for (let i = 0; i < 20 && daemon.activity.at === before; i++) await sleep(10);
    await daemon.activityWrite;

    const activity = await loadActivity(root);
    expect(activity?.at).not.toBe(before);
    expect(activity?.local?.settled).toBe(false);
  } finally {
    daemon.stopActivityHeartbeat();
    remote.releaseCommit.resolve();
    await pump;
    await daemon.activityWrite;
  }
});

test("ambient heartbeat refreshes shell.line while the daemon is otherwise idle", async () => {
  const daemon = await makeDaemon(new MiniRemote());
  daemon.writeWsActivity();
  await daemon.activityWrite;
  const before = Number((await readShellLine()).split(" ")[1]);

  const realNow = Date.now;
  Date.now = () => (before + 20) * 1000;
  try {
    daemon.startAmbientStatusHeartbeat(5);
    for (let i = 0; i < 20; i++) {
      await sleep(10);
      await daemon.activityWrite;
      if (Number((await readShellLine()).split(" ")[1]) > before) break;
    }
    expect(Number((await readShellLine()).split(" ")[1])).toBeGreaterThan(before);
  } finally {
    daemon.stopAmbientStatusHeartbeat();
    Date.now = realNow;
  }
});

test("raw watcher event persists local unsettled before the debounced pump runs", async () => {
  const daemon = await makeDaemon(new MiniRemote());
  daemon.startWatcherFn = async (_root, _matcher, _onSettle, opts = {}) => {
    opts.onRawEvent?.({ relPath: "a.txt", kind: "add" });
    return { backend: "parcel", close: async () => {} };
  };

  try {
    await daemon.startLiveWatch();
    await daemon.activityWrite;
    daemon.writeWsActivity();
    await daemon.activityWrite;
    const activity = await loadActivity(root);
    expect(activity?.local).toMatchObject({
      baseSequence: 0,
      settled: false,
      sourceVersion: 1,
    });
    expect(daemon.pendingEvents).toEqual([]);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
  }
});

test("a second raw event projects an episode first seen before BASE was available", async () => {
  const daemon = await makeDaemon(new MiniRemote());
  let onRawEvent: ((event: WatchEvent) => void) | undefined;
  daemon.startWatcherFn = async (_root, _matcher, _onSettle, opts = {}) => {
    onRawEvent = opts.onRawEvent;
    return { backend: "parcel", close: async () => {} };
  };
  daemon.syncBase = undefined;

  try {
    await daemon.startLiveWatch();
    onRawEvent?.({ relPath: "before-base.txt", kind: "add" });
    await daemon.activityWrite;
    expect((await loadActivity(root))?.local).toBeUndefined();

    await daemon.loadSyncBase();
    onRawEvent?.({ relPath: "after-base.txt", kind: "add" });
    await daemon.activityWrite;
    expect((await loadActivity(root))?.local?.settled).toBe(false);
  } finally {
    if (daemon.safetyTimer) clearTimeout(daemon.safetyTimer);
    if (daemon.deepTimer) clearInterval(daemon.deepTimer);
  }
});

test("deferred write-finish retry keeps local unsettled while retry is pending", async () => {
  const daemon = await makeDaemon(new MiniRemote());
  try {
    daemon.retryQueue.scheduleWriteFinish(new Set(["still-writing.txt"]));
    daemon.writeWsActivity();
    await daemon.activityWrite;
    expect((await loadActivity(root))?.local?.settled).toBe(false);
  } finally {
    await daemon.stop();
  }
});

test("conflicting v2 pidfile observed mid-pump drains the current op before wind-down", async () => {
  await withIsolatedDaemonHome(async () => {
    const remote = new HookedCommitRemote();
    const daemon = await makeDaemon(remote);
    const runtime = daemonRuntimeDir(root);
    const pidfile = path.join(runtime, "daemon.pid");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(pidfile, `v2 ${process.pid} boot-test\n`);
    remote.onPutBlobFile = async () => {
      await fs.writeFile(pidfile, `v2 ${process.pid} boot-other\n`);
    };

    await fs.writeFile(path.join(root, "a.txt"), "hello");
    daemon.local.head = await scanManifest(root);
    daemon.want.push = true;
    const pumpDone = daemon.pump();
    await remote.commitEntered.promise;
    await daemon.activityWrite;

    expect(daemon.ownershipWindDownStarted).toBe(true);
    expect(remote.head).toBe(0);

    remote.releaseCommit.resolve();
    await pumpDone;
    const state = await loadState(root, syncStreamId(testConfig()));
    expect(remote.head).toBe(1);
    expect(state.lastSyncedSequence).toBe(1);
  });
});

test("removing the pidfile during shutdown does not steal ownership from the running pump", async () => {
  await withIsolatedDaemonHome(async () => {
    const remote = new HookedCommitRemote();
    const daemon = await makeDaemon(remote);
    const runtime = daemonRuntimeDir(root);
    const pidfile = path.join(runtime, "daemon.pid");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(pidfile, `v2 ${process.pid} boot-test\n`);
    remote.onPutBlobFile = async () => {
      await fs.rm(pidfile, { force: true });
    };

    await fs.writeFile(path.join(root, "a.txt"), "hello");
    daemon.local.head = await scanManifest(root);
    daemon.want.push = true;
    const pumpDone = daemon.pump();
    await remote.commitEntered.promise;
    await daemon.activityWrite;

    expect(daemon.ownershipWindDownStarted).toBe(false);
    expect((await loadActivity(root))?.active?.phase).toBe("upload");

    remote.releaseCommit.resolve();
    await pumpDone;
    await daemon.activityWrite;
    const state = await loadState(root, syncStreamId(testConfig()));
    const activity = await loadActivity(root);
    expect(daemon.ownershipWindDownStarted).toBe(false);
    expect(remote.head).toBe(1);
    expect(state.lastSyncedSequence).toBe(1);
    expect(activity?.lastPush?.sequence).toBe(1);
    expect(activity?.active).toBeUndefined();
  });
});

test("activity writes persist without a v2 boot claim and stop on a conflicting v2 pidfile", async () => {
  const oldHome = process.env.RBOX_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-owner-home-"));
  process.env.RBOX_HOME = home;
  try {
    const remote = new MiniRemote();
    const daemon = await makeDaemon(remote);
    daemon.activity.ws = { connected: false, at: "2026-07-02T12:00:00.000Z", caughtUp: false, bootId: "boot-test", pid: process.pid };

    daemon.writeWsActivity();
    await daemon.activityWrite;
    expect((await loadActivity(root))?.ws?.bootId).toBe("boot-test");

    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.pid"), `${process.pid}\n`);
    daemon.activity.ws = { ...daemon.activity.ws, at: "2026-07-02T12:00:01.000Z" };
    daemon.writeWsActivity();
    await daemon.activityWrite;
    expect((await loadActivity(root))?.ws?.at).toBe("2026-07-02T12:00:01.000Z");

    let windDown = false;
    daemon.beginOwnershipWindDown = () => {
      windDown = true;
    };
    await fs.writeFile(path.join(runtime, "daemon.pid"), `v2 ${process.pid} boot-other\n`);
    daemon.activity.ws = { ...daemon.activity.ws, at: "2026-07-02T12:00:02.000Z" };
    daemon.writeWsActivity();
    await daemon.activityWrite;
    expect((await loadActivity(root))?.ws?.at).toBe("2026-07-02T12:00:01.000Z");
    expect(windDown).toBe(true);
  } finally {
    if (oldHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("ambient status writer stops when an observed pidfile disappears", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const runtime = daemonRuntimeDir(root);
    const pidfile = path.join(runtime, "daemon.pid");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(pidfile, `v2 ${process.pid} boot-test\n`);

    daemon.onTransferProgress(1, 3, "encrypt", "before-loss.txt");
    await daemon.activityWrite;
    expect((await readAmbientStatus()).operation).toMatchObject({ currentPath: "before-loss.txt" });

    let windDown = false;
    daemon.beginOwnershipWindDown = () => {
      windDown = true;
    };
    await fs.rm(pidfile);
    daemon.onTransferProgress(2, 3, "encrypt", "after-loss.txt");
    await daemon.activityWrite;

    expect(windDown).toBe(false);
    expect((await readAmbientStatus()).operation).toMatchObject({ currentPath: "before-loss.txt" });
  });
});

test("graceful daemon stop writes paused ambient status even after stopDaemon removes the pidfile", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const runtime = daemonRuntimeDir(root);
    const pidfile = path.join(runtime, "daemon.pid");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(pidfile, `v2 ${process.pid} boot-test\n`);

    daemon.onTransferProgress(1, 3, "encrypt", "stopping.txt");
    await daemon.activityWrite;
    await fs.rm(pidfile);
    await daemon.stop();

    expect(await readAmbientStatus()).toMatchObject({
      schemaVersion: 1,
      state: "paused",
      fileCount: 0,
      daemonVersion: RBOX_VERSION,
      mode: "read-write",
      bootId: "boot-test",
      workspaceRoot: root,
    });
  });
});

test("graceful stop exposes a closed gate, drains a slow pump, and settles watcher close failure", async () => {
  await withIsolatedDaemonHome(async () => {
    const remote = new HookedCommitRemote();
    const daemon = await makeDaemon(remote);
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.pid"), `v2 ${process.pid} boot-test\n`);

    await fs.writeFile(path.join(root, "slow.txt"), "hello");
    let watcherCloseCalled = false;
    daemon.watcher = {
      close: async () => {
        watcherCloseCalled = true;
        throw new Error("injected watcher close rejection");
      },
    } as Watcher;
    daemon.local.head = await scanManifest(root);
    daemon.want.push = true;
    const pump = daemon.pump();
    await remote.commitEntered.promise;

    let stop: Promise<void> | undefined;
    try {
      stop = daemon.stop();
      expect(daemon.stop()).toBe(stop);
      // The injected activity-write chain is the deterministic persistence
      // boundary; no wall-clock polling is needed.
      await daemon.activityWrite;
      const early = await readAmbientStatus();
      expect(early).toMatchObject({ schemaVersion: 1, state: "syncing", shutdown: { gateClosed: true } });
      expect(stop).toBeInstanceOf(Promise);
    } finally {
      remote.releaseCommit.resolve();
      await Promise.allSettled([pump, ...(stop ? [stop] : [])]);
    }
    await pump;
    await stop!;
    expect(watcherCloseCalled).toBe(true);
    expect(await readAmbientStatus()).toMatchObject({ schemaVersion: 1, state: "paused" });
  });
});

test("stop during slow watcher admission closes the late watcher and starts no live resources", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const watcherEntered = deferred<void>();
    const releaseWatcher = deferred<void>();
    let watcherClosed = false;
    daemon.startWatcherFn = async () => {
      watcherEntered.resolve();
      await releaseWatcher.promise;
      return { backend: "parcel", close: async () => { watcherClosed = true; } } as Watcher;
    };

    const starting = daemon.start();
    await watcherEntered.promise;
    const stopping = daemon.stop();
    releaseWatcher.resolve();
    await stopping;
    await starting;
    expect(watcherClosed).toBe(true);
    expect(daemon.watcher).toBeUndefined();
  });
});

test("daemon that never saw a pidfile does not write paused ambient status on stop", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    await daemon.stop();
    await expect(fs.readFile(daemonStatusPath(root), "utf8")).rejects.toThrow();
  });
});

test("transfer-progress throttle: indeterminate ticks never bypass it; phase changes and final ticks do", async () => {
  const daemon = await makeDaemon(new MiniRemote());

  // First tick is a phase change (nothing→scan) → recorded immediately.
  daemon.onTransferProgress(500, 0, "scan");
  expect(daemon.activity.active).toMatchObject({ phase: "scan", done: 500, total: 0 });

  // Rapid follow-up INDETERMINATE ticks (total===0) are never "final" — throttled.
  // Pre-fix, the guard was `done < total`, which is false for total===0, so every
  // 500-file stride of a big daemon scan queued an activity+shell.line write.
  daemon.onTransferProgress(1000, 0, "scan");
  daemon.onTransferProgress(1500, 0, "scan");
  expect(daemon.activity.active?.done).toBe(500);

  // A phase CHANGE bypasses the throttle: scan→gitcap must show immediately.
  daemon.onTransferProgress(1, 140, "gitcap");
  expect(daemon.activity.active).toMatchObject({ phase: "gitcap", done: 1, total: 140 });

  // Mid-phase determinate tick inside the 500ms window: throttled.
  daemon.onTransferProgress(2, 140, "gitcap");
  expect(daemon.activity.active?.done).toBe(1);

  // The FINAL determinate tick (done >= total) bypasses the throttle.
  daemon.onTransferProgress(140, 140, "gitcap");
  expect(daemon.activity.active?.done).toBe(140);

  await daemon.activityWrite; // drain the best-effort sidecar chain before teardown
});

test("transfer-progress throttle: byte-only ticks use the existing write cadence", async () => {
  const daemon = await makeDaemon(new MiniRemote());

  daemon.onTransferProgress(0, 1, "upload", { bytesDone: 0, bytesTotal: 100 });
  expect(daemon.activity.active).toMatchObject({ phase: "upload", done: 0, total: 1, bytesDone: 0, bytesTotal: 100 });

  daemon.onTransferProgress(0, 1, "upload", { bytesDone: 50, bytesTotal: 100 });
  expect(daemon.activity.active).toMatchObject({ phase: "upload", done: 0, total: 1, bytesDone: 0, bytesTotal: 100 });

  daemon.onTransferProgress(1, 1, "upload", { bytesDone: 100, bytesTotal: 100 });
  expect(daemon.activity.active).toMatchObject({ phase: "upload", done: 1, total: 1, bytesDone: 100, bytesTotal: 100 });

  // A same-phase retry restart is a real regression, not jitter: it bypasses the
  // throttle and writes the raw fresh 0/N instead of leaving the final tick visible.
  daemon.onTransferProgress(0, 1, "upload", { bytesDone: 0, bytesTotal: 100 });
  expect(daemon.activity.active).toMatchObject({ phase: "upload", done: 0, total: 1, bytesDone: 0, bytesTotal: 100 });

  daemon.lastProgressWrite = 0; // age out the throttle for the next normal progress tick
  daemon.onTransferProgress(1, 2, "upload", { bytesDone: 90, bytesTotal: 100 });
  expect(daemon.activity.active).toMatchObject({ phase: "upload", done: 1, total: 2, bytesDone: 90, bytesTotal: 100 });

  // Retraction-corrected tracker values also pass through raw and stay valid at
  // the activity boundary and renderer boundary.
  daemon.onTransferProgress(1, 2, "upload", { bytesDone: 10, bytesTotal: 40, bytesPerSecond: 5_000_000, etaSeconds: 6 });
  expect(daemon.activity.active).toMatchObject({ phase: "upload", done: 1, total: 2, bytesDone: 10, bytesTotal: 40, bytesPerSecond: 5_000_000, etaSeconds: 6 });
  expect(daemon.activity.active!.bytesDone!).toBeLessThanOrEqual(daemon.activity.active!.bytesTotal!);
  expect(progressLabel("upload", 1, 2, undefined, { bytesDone: 10, bytesTotal: 40 })).toBe("uploading ▓░░░░ 25% · 10 B / 40 B");

  await daemon.activityWrite;
  const persisted = (await loadActivity(root))?.active;
  expect(persisted).toMatchObject({ phase: "upload", done: 1, total: 2, bytesDone: 10, bytesTotal: 40, bytesPerSecond: 5_000_000, etaSeconds: 6 });
  expect(persisted!.bytesDone!).toBeLessThanOrEqual(persisted!.bytesTotal!);
  expect(renderShellLine({ at: "", active: persisted }, { settled: false, name: "ws", now: Date.now() }).split(" ")[3]).toBe("25");
});

// ── executeOp extraction: characterization + ruled-behavior pins ──────────────
// The recovery probe (runRecoveryProbe) re-implements the pump's op bodies. These
// pin the shared contract before/through the extraction into a private executeOp:
// #1 catch-up-generation restore-on-failure (both callers), #2 single notify-latency
// recording per notify, and the founder-ruled divergences D1–D3 (recovery ops must
// behave like ordinary ops for scan-degraded clear, out-of-storage arming, and
// notify-latency bookkeeping). D4 pins the ONE deliberate exclusion that survives.
// Spec: docs/design/notes/2026-07-24-recovery-probe-divergences.md (RULED).

test("executeOp D1a: a successful recovery-probe fullScan clears watcher-degraded like an ordinary scan", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const errors = captureWatcherErrors(daemon);
    await writeOwnedDaemonPid();

    try {
      await daemon.startLiveWatch();
      errors.fire(new Error("Events were dropped by the FSEvents client"));
      await daemon.activityWrite;
      expect(daemon.watcherTrust.degraded).toBe(true);

      // A fullScan halt drives the recovery probe (the halt masks want.fullScan, so
      // the ONLY scan this pump runs is the recovery scan).
      daemon.activity.halt = { at: iso(10), reason: "scan failed", count: 1, op: "fullScan" };
      daemon.recoveryDue = true;
      await daemon.pump();
      await daemon.activityWrite;

      expect(daemon.watcherTrust.degraded).toBe(false);
      expect(daemon.activity.halt).toBeUndefined();
    } finally {
      await closeWatcherTimers(daemon);
    }
  });
});

test("executeOp D1b: a successful recovery-probe deepScan clears watcher-degraded like an ordinary scan", async () => {
  await withIsolatedDaemonHome(async () => {
    const daemon = await makeDaemon(new MiniRemote());
    const errors = captureWatcherErrors(daemon);
    await writeOwnedDaemonPid();

    try {
      await daemon.startLiveWatch();
      errors.fire(new Error("Events were dropped by the FSEvents client"));
      await daemon.activityWrite;
      expect(daemon.watcherTrust.degraded).toBe(true);

      daemon.activity.halt = { at: iso(10), reason: "scan failed", count: 1, op: "deepScan" };
      daemon.recoveryDue = true;
      await daemon.pump();
      await daemon.activityWrite;

      expect(daemon.watcherTrust.degraded).toBe(false);
      expect(daemon.activity.halt).toBeUndefined();
    } finally {
      await closeWatcherTimers(daemon);
    }
  });
});

test("executeOp D2: a recovery-probe fullScan arms outOfStorageProbeArmed when out of storage", async () => {
  // Pull-only so the scan's requestPush("scan") is a no-op — no follow-up push runs
  // to consume the armed flag, so the arming survives to the assertion.
  const daemon = await makeDaemon(new MiniRemote(), "boot-test", { pullOnly: true });
  daemon.activity.outOfStorage = { at: iso(5), kind: "storage", used: 1, cap: 1 };
  daemon.activity.halt = { at: iso(10), reason: "scan failed", count: 1, op: "fullScan" };
  daemon.recoveryDue = true;
  expect(daemon.outOfStorageProbeArmed).toBe(false);

  await daemon.pump();

  expect(daemon.outOfStorageProbeArmed).toBe(true);
});

test("executeOp D4: recovery-probe ops do NOT report watcher operation completion (deliberate exclusion)", async () => {
  const daemon = await makeDaemon(new MiniRemote());
  const calls: string[] = [];
  daemon.watcherTrust.observe = (input) => { calls.push(input.kind); };
  daemon.doPull = async () => {};
  daemon.activity.halt = { at: iso(10), reason: "pull failed", count: 1, op: "pull" };
  daemon.recoveryDue = true;

  await daemon.pump();

  // Recovery ops run outside the watcher-generation bracketing the observation assumes.
  expect(calls).toEqual([]);
});

test("design 277 B1: a pull-only host WITH a live watcher still clears a ghost deferral (#477)", async () => {
  await withIsolatedDaemonHome(async () => {
    let now = TEST_NOW;
    const clock = new FakeScanCadenceClock();
    const remote = new MiniRemote();
    const daemon = await makeDaemon(remote, "pull-only-ghost-watch", { pullOnly: true, now: () => now, scanCadenceClock: clock });
    daemon.startWatcherFn = () => Promise.resolve({ backend: "parcel", close: async () => {} });
    const at = new Date(TEST_NOW - 60_000).toISOString();
    const seeded: SyncState = {
      ...(daemon.syncBase ?? await daemon.loadSyncBase()),
      repoRecords: {
        ghost: {
          repoGen: 1,
          sourceSeq: 0,
          deferrals: { capture: { lane: "capture", reason: "git-busy", deferredSince: at, reasonSince: at, lastSeen: at } },
        },
      },
    };
    await saveStateUnsafeLegacyOrTest(root, seeded);
    daemon.syncBase = await loadState(root, seeded.stream);

    await daemon.start();
    expect(daemon.watcher).toBeDefined();

    // Clearing a gone repo needs TWO qualifying observations under DIFFERENT discovery
    // epochs at least 30s apart (sync-git/deferral-hygiene.ts): the first deep tick
    // records the gone observation, the second clears it. Nothing here is about
    // pruning — deep scans are always unpruned. Ghost-clear latency on a pull-only
    // host therefore spans two deep ticks (30m → 60m) — a named trade.
    now += 30_000;
    await clock.fireDeep();
    await Promise.resolve();
    await daemon.pumpRun;
    now += 30_000;
    await clock.fireDeep();
    await Promise.resolve();
    await daemon.pumpRun;

    expect(daemon.gitDiscovery.absenceProof?.epoch).toBe(3);
    expect(daemon.syncBase?.repoRecords?.ghost?.deferrals).toBeUndefined();
    expect((await loadState(root, seeded.stream)).repoRecords?.ghost?.deferrals).toBeUndefined();
    expect(daemon.want.push).toBe(false);
    expect(remote.head).toBe(0);
  });
});
