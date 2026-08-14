import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache } from "../../engine/index.js";
import { saveConfig, saveStateUnsafeLegacyOrTest, syncStreamId, type SyncState, type WorkspaceConfig } from "../config.js";
import { RboxDaemon } from "../daemon.js";
import { readResetHaltHealth, writeResetHaltHealth } from "../reset-health.js";
import { beginResetJournal, resetJournalPath } from "../reset-journal.js";
import { resetJournalDoctorCmd } from "../reset-journal-doctor.js";

interface HaltInternals {
  cache: HashCache;
  syncBase?: SyncState;
  resetLifecycle: "ready" | "halted" | "recovering" | "bootstrapping";
  resetHaltIdentity?: string;
  resetRetryTimer?: ReturnType<typeof setTimeout>;
  safetyTimer?: unknown;
  deepTimer?: unknown;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pump(): Promise<void>;
  resetOperationBoundary(): Promise<boolean>;
  doFullScan(): Promise<unknown>;
  start(): Promise<void>;
  stop(): Promise<void>;
  startWatcherFn: (...args: unknown[]) => Promise<{ close(): Promise<void> }>;
  localObserver: { observe(...args: unknown[]): Promise<unknown> };
}

let root = "";
let cfg: WorkspaceConfig;
let state: SyncState;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-halt-daemon-")));
  cfg = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws-halt", projectId: "root", deviceId: "dev-halt",
    rootPath: root, remoteUrl: "https://api.invalid", token: "", encrypted: true,
  };
  state = {
    stream: syncStreamId(cfg), stateNonce: "a".repeat(32), stateRevision: 1,
    lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files: [] },
  };
  await saveConfig(root, cfg);
  await saveStateUnsafeLegacyOrTest(root, state);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function daemon(logs: string[] = []): HaltInternals {
  return new RboxDaemon(root, cfg, {} as never, {
    now: () => Date.parse("2026-07-17T12:00:00.000Z"),
    log: (line) => void logs.push(line),
  }) as HaltInternals;
}

test("warm syncBase cannot bypass the unconditional pump boundary", async () => {
  const d = daemon();
  d.cache = new HashCache();
  d.syncBase = state; // the historical bypass condition
  d.want.fullScan = true;
  let scans = 0;
  d.doFullScan = async () => { scans++; return { coverage: "full-tree", errorGenAtStart: 0 }; };
  await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
  await fs.writeFile(resetJournalPath(root), "{poisoned");
  await d.pump();
  expect(scans).toBe(0);
  expect(d.want.fullScan).toBe(true);
  expect(d.resetLifecycle).toBe("halted");
  expect((await readResetHaltHealth(root))?.reason).toContain("malformed reset journal JSON");
  if (d.resetRetryTimer) clearTimeout(d.resetRetryTimer);
});

test("journal disappearance heals once through three-way agreement and clears daemon-owned health", async () => {
  const logs: string[] = [];
  const d = daemon(logs);
  d.cache = new HashCache();
  d.resetLifecycle = "halted";
  d.resetHaltIdentity = "b".repeat(64);
  await writeResetHaltHealth(root, {
    reason: "legacy journal",
    journalIdentity: "b".repeat(64),
    haltedAt: "2026-07-17T11:00:00.000Z",
  });
  expect(await d.resetOperationBoundary()).toBe(true);
  expect(d.resetLifecycle).toBe("ready");
  expect(d.syncBase?.stateNonce).toBe(state.stateNonce);
  expect(await readResetHaltHealth(root)).toBeUndefined();
  expect(logs.filter((line) => line.includes("bootstrapped"))).toHaveLength(1);
  expect(await d.resetOperationBoundary()).toBe(true);
  expect(logs.filter((line) => line.includes("bootstrapped"))).toHaveLength(1);
});

test("heal refuses stale boot config instead of seeding the old daemon", async () => {
  const d = daemon();
  d.cache = new HashCache();
  d.resetLifecycle = "halted";
  d.resetHaltIdentity = "c".repeat(64);
  await writeResetHaltHealth(root, {
    reason: "old halt",
    journalIdentity: "c".repeat(64),
    haltedAt: "2026-07-17T11:00:00.000Z",
  });
  await saveConfig(root, { ...cfg, remoteWorkspaceId: "externally-rebound" });
  expect(await d.resetOperationBoundary()).toBe(false);
  expect(d.resetLifecycle).toBe("halted");
  expect((await readResetHaltHealth(root))?.reason).toContain("do not agree");
  if (d.resetRetryTimer) clearTimeout(d.resetRetryTimer);
});

test("forensic foreign-next v1 halts, journal-only quarantine, then heals end to end", async () => {
  const d = daemon();
  d.cache = new HashCache();
  d.syncBase = state;
  d.want.fullScan = true;
  const oldBytes = await fs.readFile(path.join(root, ".rbox", "state.json"));
  await beginResetJournal(root, "foreign-next-stream", oldBytes, state, [], {
    version: 2,
    authorizedNextStream: "foreign-next-stream",
    consentKind: "setup-rebind",
    mintedAtRevision: 1,
  }, {
    now: () => new Date("2026-07-17T10:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, 0x44),
  });
  const v2 = JSON.parse(await fs.readFile(resetJournalPath(root), "utf8"));
  delete v2.authorization;
  v2.v = 1;
  await fs.writeFile(resetJournalPath(root), JSON.stringify(v2));
  await d.pump();
  expect(d.resetLifecycle).toBe("halted");
  await resetJournalDoctorCmd(root, { quarantine: true });
  expect(await fs.lstat(resetJournalPath(root)).catch(() => undefined)).toBeUndefined();
  expect(await d.resetOperationBoundary()).toBe(true);
  expect(d.resetLifecycle).toBe("ready");
  expect(await readResetHaltHealth(root)).toBeUndefined();
  const restarted = daemon();
  restarted.cache = new HashCache();
  expect(await restarted.resetOperationBoundary()).toBe(true);
  expect(restarted.resetLifecycle).toBe("ready");
  if (d.resetRetryTimer) clearTimeout(d.resetRetryTimer);
});

test("poisoned startup arms handles once, skips the direct scan, and heal does not duplicate them", async () => {
  const previousWs = process.env.RBOX_DAEMON_WS_DISABLED;
  const previousReliability = process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED;
  const previousHome = process.env.RBOX_HOME;
  process.env.RBOX_DAEMON_WS_DISABLED = "1";
  process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED = "1";
  process.env.RBOX_HOME = path.join(root, "runtime");
  const d = daemon();
  let watcherStarts = 0;
  let startupScans = 0;
  let deliverWatcher: ((events: unknown[]) => void) | undefined;
  d.startWatcherFn = async (...args: unknown[]) => {
    watcherStarts++;
    deliverWatcher = args[2] as (events: unknown[]) => void;
    return { backend: "parcel", close: async () => {} };
  };
  d.localObserver.observe = async () => { startupScans++; return undefined; };
  await fs.mkdir(path.dirname(resetJournalPath(root)), { recursive: true });
  await fs.writeFile(resetJournalPath(root), "{poisoned-startup");
  try {
    await d.start();
    expect(d.resetLifecycle).toBe("halted");
    expect(startupScans).toBe(0);
    expect(watcherStarts).toBe(1);
    deliverWatcher!([{ type: "update", path: path.join(root, "ignored.txt") }]);
    expect(d.want.push).toBe(false);
    expect(d.want.pull).toBe(false);
    const safety = d.safetyTimer;
    const deep = d.deepTimer;
    await resetJournalDoctorCmd(root, { quarantine: true });
    expect(await d.resetOperationBoundary()).toBe(true);
    expect(d.resetLifecycle).toBe("ready");
    expect(watcherStarts).toBe(1);
    expect(d.safetyTimer).toBe(safety);
    expect(d.deepTimer).toBe(deep);
  } finally {
    await d.stop();
    if (previousWs === undefined) delete process.env.RBOX_DAEMON_WS_DISABLED; else process.env.RBOX_DAEMON_WS_DISABLED = previousWs;
    if (previousReliability === undefined) delete process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED; else process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED = previousReliability;
    if (previousHome === undefined) delete process.env.RBOX_HOME; else process.env.RBOX_HOME = previousHome;
  }
});

test("startup mutex contention queues both the initial pull and full scan", async () => {
  const previousWs = process.env.RBOX_DAEMON_WS_DISABLED;
  const previousReliability = process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED;
  const previousHome = process.env.RBOX_HOME;
  process.env.RBOX_DAEMON_WS_DISABLED = "1";
  process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED = "1";
  process.env.RBOX_HOME = path.join(root, "contention-runtime");
  const d = new RboxDaemon(root, cfg, {} as never, {
    pullOnly: true,
    acquireSyncMutex: async () => ({ status: "contended", holderKey: "test-holder", blockerKind: "live" }),
  }) as HaltInternals;
  let queued: HaltInternals["want"] | undefined;
  d.pump = async () => { queued = { ...d.want }; };
  try {
    await d.start();
    expect(queued).toMatchObject({ pull: true, fullScan: true });
  } finally {
    await d.stop();
    if (previousWs === undefined) delete process.env.RBOX_DAEMON_WS_DISABLED; else process.env.RBOX_DAEMON_WS_DISABLED = previousWs;
    if (previousReliability === undefined) delete process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED; else process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED = previousReliability;
    if (previousHome === undefined) delete process.env.RBOX_HOME; else process.env.RBOX_HOME = previousHome;
  }
});
