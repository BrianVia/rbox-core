import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type BlobStore, type FileEntry, type Manifest, type WatchEvent } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { loadActivity } from "./activity.js";
import { loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { RboxDaemon } from "./daemon.js";
import { daemonRuntimeDir, readDaemonBindingRecord, readDaemonPidRecord, recordDaemonBinding } from "./daemon-control.js";
import { pull } from "./sync.js";
import { QuotaExceededError, type CommitResult, type SyncRemote } from "./remote.js";
import { attributeDaemonForStatus, healthLine } from "./status-view.js";

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
interface DaemonInternals {
  ws?: WebSocket;
  wsKeepaliveTimer?: ReturnType<typeof setInterval>;
  wsGeneration: number;
  pendingCatchUpGeneration?: number;
  ownershipWindDownStarted: boolean;
  cache: HashCache;
  manifest: Manifest;
  pendingEvents: WatchEvent[];
  activity: import("./activity.js").DaemonActivity;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  onTransferProgress(done: number, total: number, phase: import("./transfer-progress.js").TransferPhase): void;
  lastProgressWrite: number;
  pump(): Promise<void>;
  writeWsActivity(): void;
  recordCommittedFrame(sequence: number): void;
  handleWsMessageData(data: string): void;
  markWsOpen(ws: WebSocket): number;
  markWsCaughtUp(generation: number): void;
  markWsDisconnected(ws: WebSocket, reason: "close" | "error"): boolean;
  handleWsClose(ws: WebSocket): void;
  refreshWsAtThrottled(): void;
  stopWsKeepalive(): void;
  scheduleReconnect(): void;
  /** The chained sidecar-write promise — the pump never awaits it (best-effort
   *  by contract), so tests drain it explicitly before reading the file. */
  activityWrite: Promise<void>;
}

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-activity-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function testConfig(): WorkspaceConfig {
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
  };
}

async function makeDaemon(remote: MiniRemote, bootId = "boot-test"): Promise<DaemonInternals> {
  const cfg = testConfig();
  const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }, bootId) as unknown as DaemonInternals;
  daemon.cache = await HashCache.load(root);
  daemon.manifest = await scanManifest(root);
  return daemon;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fakeWs = () => ({ readyState: WebSocket.OPEN, send: () => {}, close: () => {} }) as unknown as WebSocket;

async function withIsolatedDaemonHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const oldHome = process.env.RBOX_HOME;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-owner-home-"));
  process.env.RBOX_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
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

test("pump error records a halt; only a same-kind success clears it", async () => {
  const remote = new MiniRemote();
  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  const daemon = await makeDaemon(remote);

  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const halted = await loadActivity(root);
  expect(halted?.halt?.reason).toContain("mass-delete guard");
  expect(halted?.halt?.count).toBe(1);
  expect(halted?.halt?.op).toBe("pull");

  // Codex R1 BLOCKER regression: a successful op of a DIFFERENT kind (the queued
  // no-op push, every safety scan) must NOT heal a pull halt — the guard warning
  // would flap off within seconds of every trip.
  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  expect((await loadActivity(root))?.halt?.reason).toContain("mass-delete guard");

  remote.latestError = undefined; // heal → a SUCCESSFUL PULL is what clears it
  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const healed = await loadActivity(root);
  expect(healed?.halt).toBeUndefined();
  expect(healed?.at).toBeDefined();

  // Codex R4 regression: a NEW failure with the SAME message after a heal is a new
  // episode — it must persist a fresh halt (not silently count as dedup repeat 2..9
  // and leave activity.json healed).
  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const rehalted = await loadActivity(root);
  expect(rehalted?.halt?.reason).toContain("mass-delete guard");
  expect(rehalted?.halt?.count).toBe(1);
});

test("a committed push records the last-sync trail; a no-op push does not", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.manifest = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  const after = await loadActivity(root);
  expect(after?.lastPush).toEqual({ at: expect.any(String), files: 1, sequence: 1 });
  expect(after?.active).toBeUndefined(); // live progress never outlives its op

  daemon.want.push = true; // steady state: no changes → no-op → trail unchanged
  await daemon.pump();
  await daemon.activityWrite;
  expect((await loadActivity(root))?.lastPush?.sequence).toBe(1);
});

test("the 409-recovery pull inside a push is recorded in the trail (codex R2)", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "mine");
  daemon.manifest = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump(); // baseline: sequence 1
  await daemon.activityWrite;

  // Another writer advances the remote (adds b.txt) → our next push 409s.
  const current = (await remote.latest()).manifest.files;
  remote.injectCommit([...current, await remote.seedEntry("b.txt", "theirs")]);

  await fs.writeFile(path.join(root, "c.txt"), "more local work");
  daemon.manifest = await scanManifest(root);
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

// Design 46: the daemon renders the prompt sidecar (`shell.line`) alongside every
// activity.json write, from the SAME record on the SAME ordered chain. The zsh prompt
// hook just reads it, so these assertions guard the fields it depends on.
async function readShellLine(): Promise<string> {
  return (await fs.readFile(path.join(root, ".rbox", "state", "shell.line"), "utf8")).trimEnd();
}

test("a committed push writes shell.line: v1, state ok, committed sequence (design 46)", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.manifest = await scanManifest(root);

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

test("a pump error writes shell.line state halt (design 46)", async () => {
  const remote = new MiniRemote();
  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  const daemon = await makeDaemon(remote);

  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect((await readShellLine()).split(" ")[2]).toBe("halt");
});

test("quota errors record outOfStorage, suppress watcher uploads, probe on safety scan, and clear on success", async () => {
  const remote = new QuotaCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.manifest = await scanManifest(root);

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

test("a quota probe refreshes outOfStorage without clearing a real pull halt", async () => {
  const remote = new QuotaCommitRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.manifest = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  const firstQuota = await loadActivity(root);
  expect(firstQuota?.outOfStorage?.used).toBe(2 * 1024 * 1024 * 1024);
  expect(firstQuota?.halt).toBeUndefined();

  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
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

test("ws-only activity writes preserve top-level heartbeat and committed sequence evidence", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  daemon.activity.at = "2026-07-02T12:00:00.000Z";
  daemon.activity.lastPush = { at: "2026-07-02T12:00:01.000Z", files: 2, sequence: 9 };

  daemon.recordCommittedFrame(10);
  daemon.recordCommittedFrame(5); // monotonic: lower broadcasts never overwrite higher evidence
  await daemon.activityWrite;

  const after = await loadActivity(root);
  expect(after?.at).toBe("2026-07-02T12:00:00.000Z");
  expect(after?.lastPush).toEqual({ at: "2026-07-02T12:00:01.000Z", files: 2, sequence: 9 });
  expect(after?.ws?.lastBroadcastSequence).toBe(10);
  expect(after?.ws?.at).toEqual(expect.any(String));
});

test("committed WS frame records before queueing pull, including same-device echoes", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  const order: string[] = [];
  daemon.writeWsActivity = () => order.push("write-ws");
  (daemon as unknown as { request(kind: string): void }).request = (kind: string) => order.push(`request-${kind}`);

  daemon.handleWsMessageData(JSON.stringify({ type: "committed", deviceId: "dev_act", sequence: 42 }));

  expect(order).toEqual(["write-ws", "request-pull"]);
  expect(daemon.activity.ws?.lastBroadcastSequence).toBe(42);
});

test("caughtUp is tied to the connection generation that queued the catch-up pull", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);

  const gen1 = daemon.markWsOpen(fakeWs());
  const gen2 = daemon.markWsOpen(fakeWs());
  daemon.markWsCaughtUp(gen1);
  expect(daemon.activity.ws?.caughtUp).toBe(false);
  daemon.markWsCaughtUp(gen2);
  expect(daemon.activity.ws?.caughtUp).toBe(true);
  daemon.stopWsKeepalive();
});

test("stale WS close does not mutate the current connection or schedule reconnect", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  const ws1 = fakeWs();
  const ws2 = fakeWs();

  daemon.ws = ws1;
  const gen1 = daemon.markWsOpen(ws1);
  daemon.markWsCaughtUp(gen1);
  daemon.ws = ws2;
  const gen2 = daemon.markWsOpen(ws2);
  daemon.markWsCaughtUp(gen2);
  daemon.pendingCatchUpGeneration = gen2;

  const beforeWs = { ...daemon.activity.ws };
  const beforeGeneration = daemon.wsGeneration;
  const beforeKeepalive = daemon.wsKeepaliveTimer;
  let stopKeepaliveCalled = false;
  let reconnectScheduled = false;
  let wsWriteCalled = false;
  const realStopKeepalive = daemon.stopWsKeepalive.bind(daemon);
  daemon.stopWsKeepalive = () => {
    stopKeepaliveCalled = true;
  };
  daemon.scheduleReconnect = () => {
    reconnectScheduled = true;
  };
  daemon.writeWsActivity = () => {
    wsWriteCalled = true;
  };

  try {
    daemon.handleWsClose(ws1);

    expect(daemon.ws).toBe(ws2);
    expect(daemon.activity.ws).toEqual(beforeWs);
    expect(daemon.wsGeneration).toBe(beforeGeneration);
    expect(daemon.pendingCatchUpGeneration).toBe(gen2);
    expect(daemon.wsKeepaliveTimer).toBe(beforeKeepalive);
    expect(stopKeepaliveCalled).toBe(false);
    expect(reconnectScheduled).toBe(false);
    expect(wsWriteCalled).toBe(false);
  } finally {
    daemon.stopWsKeepalive = realStopKeepalive;
    daemon.stopWsKeepalive();
  }
});

test("pong keepalive advances ws.at in memory but persists at most once per 20s", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  const realNow = Date.now;
  let now = TEST_NOW;
  let writes = 0;
  Date.now = () => now;
  daemon.writeWsActivity = () => {
    writes++;
  };
  try {
    daemon.activity.ws = { connected: true, at: iso(60), caughtUp: true, bootId: "boot-test", pid: process.pid };
    daemon.refreshWsAtThrottled();
    const firstAt = daemon.activity.ws.at;
    expect(writes).toBe(1);

    now += 19_000;
    daemon.refreshWsAtThrottled();
    expect(writes).toBe(1);
    expect(daemon.activity.ws.at).not.toBe(firstAt);

    now += 1_000;
    daemon.refreshWsAtThrottled();
    expect(writes).toBe(2);
  } finally {
    Date.now = realNow;
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
    daemon.manifest = await scanManifest(root);
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
    daemon.manifest = await scanManifest(root);
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

test("first activity write before pidfile creation is kept with the daemon bootId", async () => {
  await withIsolatedDaemonHome(async () => {
    const remote = new MiniRemote();
    const daemon = await makeDaemon(remote);

    daemon.recordCommittedFrame(3);
    await daemon.activityWrite;

    const activity = await loadActivity(root);
    expect(activity?.ws?.bootId).toBe("boot-test");
    expect(activity?.ws?.lastBroadcastSequence).toBe(3);
    expect(daemon.ownershipWindDownStarted).toBe(false);
    expect(readDaemonPidRecord(root).present).toBe(false);
  });
});

test("binding bootId mismatch does not block attribution when pidfile and activity match", async () => {
  await withIsolatedDaemonHome(async () => {
    const remote = new MiniRemote();
    const daemon = await makeDaemon(remote);
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.pid"), `v2 ${process.pid} boot-test\n`);
    await recordDaemonBinding(root, "ws_act", "boot-loser");

    const ws = fakeWs();
    daemon.ws = ws;
    const generation = daemon.markWsOpen(ws);
    daemon.markWsCaughtUp(generation);
    daemon.activity.lastPush = { at: new Date().toISOString(), files: 1, sequence: 12 };
    daemon.recordCommittedFrame(12);
    await daemon.activityWrite;
    daemon.stopWsKeepalive();

    const activity = await loadActivity(root);
    const binding = readDaemonBindingRecord(root);
    const pidfile = readDaemonPidRecord(root);
    const attributed = attributeDaemonForStatus({
      activity,
      daemonRunning: true,
      boundWorkspaceId: binding.workspaceId,
      currentWorkspaceId: "ws_act",
      livePidfileBootId: pidfile.bootId,
      localSequence: 10,
      now: Date.now(),
    });

    expect(binding.bootId).toBe("boot-loser");
    expect(pidfile.bootId).toBe("boot-test");
    expect(attributed.activity?.lastPush?.sequence).toBe(12);
    expect(attributed.elided).toBe(true);
    expect(attributed.remote?.sequence).toBe(12);
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
    (daemon as unknown as { beginOwnershipWindDown(reason: string): void }).beginOwnershipWindDown = () => {
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
