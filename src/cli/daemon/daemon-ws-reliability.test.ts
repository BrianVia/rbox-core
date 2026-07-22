import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type BlobStore, type FileEntry, type Manifest } from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import type { SyncState, WorkspaceConfig } from "../config.js";
import { reconnectDelayMs, RboxDaemon, type CursorClock } from "../daemon.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import type { TelemetryRecorder } from "../telemetry/queue.js";
import type { WsHealthSample } from "../telemetry/contract.js";

const ENV_KEYS = [
  "RBOX_DAEMON_WS_DISABLED",
  "RBOX_DAEMON_WS_RELIABILITY_DISABLED",
  "RBOX_DAEMON_WS_PONG_DEADLINE_MS",
  "RBOX_DAEMON_WS_CURSOR_CHECK_MS",
  "RBOX_DAEMON_POLL_BACKSTOP_MS",
] as const;

interface DaemonInternals {
  recoveryDue: boolean;
  ws?: WebSocket;
  pongDeadlineMs: number;
  backstopMs: number;
  cursorCheckMs: number;
  wsReliabilityDisabled: boolean;
  wsDisabled: boolean;
  wsReconnects: number;
  wsHalfOpenDetected: number;
  wsBackstopPulls: number;
  backstopAppliedPulls: number;
  cursorAppliedPulls: number;
  notifyAppliedPulls: number;
  notifyLatencyCount: number;
  queuedCarrier: "none" | "backstop" | "cursor" | "notify";
  queuedBackstopPending: boolean;
  pumping: boolean;
  reconnectAttempt: number;
  notifyPullPendingAt?: number;
  pendingCatchUpGeneration?: number;
  wsPongDeadlineTimer?: ReturnType<typeof setTimeout>;
  backstopTimer?: ReturnType<typeof setTimeout>;
  cursorTimer?: unknown;
  cursorEpoch: number;
  cursorAbortController?: AbortController;
  wsGeneration: number;
  resetLifecycle: "ready" | "halted" | "recovering" | "bootstrapping";
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pumpRun: Promise<void>;
  cache: HashCache;
  manifest: Manifest;
  activity: { ws?: { connected: boolean; caughtUp: boolean } };
  telemetry: TelemetryRecorder & { flush(signal?: AbortSignal): Promise<void> };
  armPongDeadline(ws: WebSocket): void;
  clearPongDeadline(): void;
  onPongDeadline(ws: WebSocket): void;
  startBackstop(): void;
  onBackstopTick(): void;
  scheduleNextBackstop(): void;
  clearBackstop(): void;
  resetCursorSchedule(ws: WebSocket): void;
  invalidateCursorSchedule(): void;
  runCursorCheck(ws: WebSocket, generation: number, epoch: number): Promise<void>;
  markWsOpen(ws: WebSocket): number;
  markWsDisconnected(ws: WebSocket, reason: "close" | "error" | "timeout"): boolean;
  handleWsMessageData(data: string, from?: WebSocket): void;
  connect(): void;
  maybeConnect(): void;
  scheduleReconnect(): void;
  pump(): Promise<void>;
  sampleWsHealth(): void;
  raiseQueuedCarrier(carrier: "none" | "backstop" | "cursor" | "notify"): void;
  discardQueuedWsCarrier(): void;
  loadSyncBase(): Promise<SyncState>;
  stop(): Promise<void>;
}

const KEK = Buffer.alloc(32, 7);
class MiniRemote implements SyncRemote {
  latestCalls = 0;
  throwNextLatest = false;
  head = 0;
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head++;
    this.manifests.set(this.head, { generatedAt: "", files });
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    this.latestCalls++;
    if (this.throwNextLatest) {
      this.throwNextLatest = false;
      throw new Error("latest failed");
    }
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> { return shas.filter((sha) => !this.blobs.has(sha)); }
  async putBlobFile(sha: string, absPath: string): Promise<void> { this.blobs.set(sha, await fs.readFile(absPath)); }
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head++;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    return {
      has: async (sha) => this.blobs.has(sha),
      put: async (sha, bytes) => void this.blobs.set(sha, Buffer.from(bytes)),
      get: async (sha) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`missing: ${sha}`);
        return bytes;
      },
    };
  }
}

let root: string;
let savedEnv: Record<string, string | undefined>;
const daemons: DaemonInternals[] = [];

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ws-reliability-")));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    daemon.clearPongDeadline();
    daemon.clearBackstop();
    await daemon.stop();
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function makeDaemon(remote: MiniRemote = new MiniRemote(), opts: {
  now?: () => number;
  monotonicNow?: () => number;
  cursorClock?: CursorClock;
  cursorRandom?: () => number;
  log?: (line: string) => void;
} = {}): Promise<DaemonInternals> {
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws_test", projectId: "root", deviceId: "dev_test",
    rootPath: root, remoteUrl: "mem://", token: "", encrypted: true, kek: KEK,
    accountId: "acct_test", accountEpoch: 0, keyEpoch: 0,
  };
  const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }, {
    bootId: "boot-test",
    ...opts,
  }) as unknown as DaemonInternals;
  daemon.cache = await HashCache.load(root);
  daemon.manifest = await scanManifest(root);
  await daemon.loadSyncBase();
  daemons.push(daemon);
  return daemon;
}

function fakeWs(close = () => {}, send = (_message: string) => {}): WebSocket {
  return { readyState: WebSocket.OPEN, send, close } as unknown as WebSocket;
}

class ManualCursorClock implements CursorClock {
  nowMs = 0;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.nowMs + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    for (;;) {
      let next: { handle: number; at: number; fn: () => void } | undefined;
      for (const [handle, timer] of this.timers) {
        if (timer.at > target) continue;
        if (!next || timer.at < next.at || (timer.at === next.at && handle < next.handle)) {
          next = { handle, ...timer };
        }
      }
      if (!next) break;
      this.nowMs = next.at;
      this.timers.delete(next.handle);
      next.fn();
    }
    this.nowMs = target;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Poll until a condition holds rather than sleeping a fixed interval and asserting
// an exact count — the cursor timer fires at cadence ±25% jitter + event-loop
// delay, so a fixed `sleep` races the send. waitUntil returns the instant the
// count reaches the target (before any further send), preserving the exact-count
// intent without the timing flake.
const waitUntil = async (cond: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    await sleep(5);
  }
};

test("pong deadline closes a silent socket and counts the half-open", async () => {
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "20";
  const daemon = await makeDaemon();
  let closes = 0;
  const ws = fakeWs(() => closes++);
  daemon.ws = ws;
  daemon.scheduleReconnect = () => {};
  daemon.markWsOpen(ws);
  await waitUntil(() => closes === 1);
  expect(closes).toBe(1);
  expect(daemon.wsHalfOpenDetected).toBe(1);
});

test("every inbound frame re-arms the pong deadline", async () => {
  const daemon = await makeDaemon();
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  const originalTimer = daemon.wsPongDeadlineTimer;
  daemon.handleWsMessageData("pong");
  expect(daemon.wsPongDeadlineTimer).toBeDefined();
  expect(daemon.wsPongDeadlineTimer).not.toBe(originalTimer);
});

test("pong deadline disconnects immediately and schedules recovery", async () => {
  const daemon = await makeDaemon();
  let closes = 0;
  let reconnects = 0;
  const ws = fakeWs(() => closes++);
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  daemon.scheduleReconnect = () => { reconnects++; };
  daemon.onPongDeadline(ws);
  expect(daemon.ws).toBeUndefined();
  expect(daemon.activity.ws?.connected).toBe(false);
  expect(reconnects).toBe(1);
  expect(closes).toBe(1);
  expect(daemon.wsHalfOpenDetected).toBe(1);
});

test("reconnect delay spreads the first attempt and preserves capped jitter", () => {
  expect(reconnectDelayMs(0, () => 0)).toBe(0);
  expect(reconnectDelayMs(0, () => 0.999999)).toBeLessThan(3000);
  expect(reconnectDelayMs(1, () => 0)).toBe(750);
  expect(reconnectDelayMs(1, () => 1)).toBe(1250);
  expect(reconnectDelayMs(10, () => 1)).toBe(37500);
});

test("scheduleReconnect advances the attempt sequence used by reconnectDelayMs", async () => {
  const daemon = await makeDaemon();
  daemon.connect = () => {};
  expect(daemon.reconnectAttempt).toBe(0);
  daemon.scheduleReconnect(); // consumes attempt 0 (the uniform 0–3s spread)
  daemon.scheduleReconnect(); // consumes attempt 1 (the 1s ±25% step G5(b) expects)
  expect(daemon.reconnectAttempt).toBe(2);
});

test("a stale socket deadline cannot close the replacement", async () => {
  const daemon = await makeDaemon();
  let closes = 0;
  daemon.ws = fakeWs();
  daemon.onPongDeadline(fakeWs(() => closes++));
  expect(closes).toBe(0);
  expect(daemon.wsHalfOpenDetected).toBe(0);
});

test("backstop pulls and reschedules itself", async () => {
  process.env.RBOX_DAEMON_POLL_BACKSTOP_MS = "30";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const daemon = await makeDaemon();
  daemon.startBackstop();
  await waitUntil(() => daemon.wsBackstopPulls >= 1);
  await daemon.pumpRun;
  expect(daemon.wsBackstopPulls).toBeGreaterThanOrEqual(1);
  expect(daemon.backstopAppliedPulls).toBe(0); // every tick was a no-op pull
  expect(daemon.backstopTimer).toBeDefined();
});

test("committed notification resets the backstop and records a latency token", async () => {
  process.env.RBOX_DAEMON_POLL_BACKSTOP_MS = "10000";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const daemon = await makeDaemon();
  daemon.startBackstop();
  const originalTimer = daemon.backstopTimer;
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 5, deviceId: "d" }));
  expect(daemon.backstopTimer).not.toBe(originalTimer);
  expect(daemon.notifyPullPendingAt).toBeNumber();

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    await daemon.pump();
    await daemon.pumpRun;
  } finally {
    console.log = originalLog;
  }
  expect(daemon.notifyPullPendingAt).toBeUndefined();
  expect(lines.some((line) => line.includes("notify_latency_ms="))).toBe(true);
});

test("failed notified pull logs latency at dequeue without restoring the timestamp", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  remote.throwNextLatest = true;

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 5, deviceId: "d" }));
    await daemon.pumpRun;
  } finally {
    console.log = originalLog;
  }
  expect(lines.some((line) => line.includes("notify_latency_ms="))).toBe(true);
  expect(daemon.notifyPullPendingAt).toBeUndefined();
  expect(daemon.notifyLatencyCount).toBe(1);
  expect(daemon.notifyAppliedPulls).toBe(0);
});

test("failed catch-up pull restores its generation until a healing pull", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  const ws = fakeWs();
  daemon.ws = ws;
  const generation = daemon.markWsOpen(ws);
  daemon.pendingCatchUpGeneration = generation;
  remote.throwNextLatest = true;
  daemon.want.pull = true;
  await daemon.pump();
  expect(daemon.pendingCatchUpGeneration).toBeDefined();

  daemon.want.pull = true;
  daemon.recoveryDue = true;
  await daemon.pump();
  expect(daemon.activity.ws?.caughtUp).toBe(true);
});

test("a stale socket message cannot trigger a pull or notify token", async () => {
  const daemon = await makeDaemon();
  const wsA = fakeWs();
  const wsB = fakeWs();
  daemon.ws = wsA;
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 5, deviceId: "d" }), wsB);
  expect(daemon.notifyPullPendingAt).toBeUndefined();
  expect(daemon.want.pull).toBe(false);
});

test("reliability master switch disables deadline, backstop, and notify token", async () => {
  process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED = "1";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "20";
  process.env.RBOX_DAEMON_POLL_BACKSTOP_MS = "20";
  const daemon = await makeDaemon();
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  daemon.startBackstop();
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 1, deviceId: "d" }));
  expect(daemon.wsReliabilityDisabled).toBe(true);
  expect(daemon.pongDeadlineMs).toBe(0);
  expect(daemon.backstopMs).toBe(0);
  expect(daemon.cursorCheckMs).toBe(0);
  expect(daemon.wsPongDeadlineTimer).toBeUndefined();
  expect(daemon.backstopTimer).toBeUndefined();
  expect(daemon.notifyPullPendingAt).toBeUndefined();
});

test("a missed committed frame is recovered by cursor before the backstop and credited once", async () => {
  process.env.RBOX_DAEMON_WS_CURSOR_CHECK_MS = "30";
  process.env.RBOX_DAEMON_POLL_BACKSTOP_MS = "10000";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("cursor.txt", "recovered")]);
  const cursorClock = new ManualCursorClock();
  const daemon = await makeDaemon(remote, { cursorClock, cursorRandom: () => 0 });
  const sent: string[] = [];
  let ws!: WebSocket;
  ws = fakeWs(() => {}, (message) => {
    sent.push(message);
    if (message === "cursor") {
      queueMicrotask(() => daemon.handleWsMessageData(JSON.stringify({ head: remote.head }), ws));
    }
  });
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  daemon.scheduleNextBackstop();

  cursorClock.advance(23); // 30ms cadence at fixed minimum jitter: round(30 * 0.75)
  await waitUntil(() => daemon.cursorAppliedPulls === 1);
  await daemon.pumpRun;

  expect(sent).toContain("cursor");
  expect(await fs.readFile(path.join(root, "cursor.txt"), "utf8")).toBe("recovered");
  expect(daemon.cursorAppliedPulls).toBe(1);
  expect(daemon.notifyAppliedPulls).toBe(0);
  expect(daemon.backstopAppliedPulls).toBe(0);
  expect(daemon.wsBackstopPulls).toBe(0);
});

test("live committed frames reset the cursor cadence before it can wake the DO", async () => {
  process.env.RBOX_DAEMON_WS_CURSOR_CHECK_MS = "200";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const cursorClock = new ManualCursorClock();
  const daemon = await makeDaemon(new MiniRemote(), { cursorClock, cursorRandom: () => 0 });
  const sent: string[] = [];
  const ws = fakeWs(() => {}, (message) => sent.push(message));
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  // Advance 480 logical milliseconds (>3 minimum-jitter cadences) while each
  // committed frame replaces the timer after only 40ms. Any uncleared timer
  // would fire synchronously during advance(), making the exact zero fail.
  for (let i = 0; i < 12; i++) {
    daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: i }), ws);
    await daemon.pumpRun;
    cursorClock.advance(40);
  }

  expect(sent.filter((message) => message === "cursor")).toHaveLength(0);
});

test("a blackholed cursor is bounded, single-flight, does not cycle the socket, and preserves backstop", async () => {
  process.env.RBOX_DAEMON_WS_CURSOR_CHECK_MS = "30";
  process.env.RBOX_DAEMON_POLL_BACKSTOP_MS = "10000";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const cursorClock = new ManualCursorClock();
  const daemon = await makeDaemon(new MiniRemote(), { cursorClock, cursorRandom: () => 0 });
  let cursorSends = 0;
  let closes = 0;
  const ws = fakeWs(() => closes++, (message) => { if (message === "cursor") cursorSends++; });
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  daemon.scheduleNextBackstop();
  const scheduledBackstop = daemon.backstopTimer;

  cursorClock.advance(23);
  expect(cursorSends).toBe(1);
  cursorClock.advance(28);
  expect(cursorSends).toBe(1); // still one in flight immediately before timeout
  cursorClock.advance(1);
  await waitUntil(() => daemon.cursorTimer !== undefined); // timeout completion re-arms
  expect(cursorSends).toBe(1);

  cursorClock.advance(22);
  expect(cursorSends).toBe(1);
  cursorClock.advance(1);
  expect(cursorSends).toBe(2); // next send occurs only after timeout + fresh cadence
  expect(closes).toBe(0);
  expect(daemon.ws).toBe(ws);
  expect(daemon.backstopTimer).toBe(scheduledBackstop);
  expect(daemon.wsBackstopPulls).toBe(0);
  expect(daemon.cursorAppliedPulls).toBe(0);
});

test("cursor epoch fences committed, reconnect, and stop overlaps", async () => {
  process.env.RBOX_DAEMON_WS_CURSOR_CHECK_MS = "100";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("overlap.txt", "once")]);
  const cursorClock = new ManualCursorClock();
  const daemon = await makeDaemon(remote, { cursorClock, cursorRandom: () => 0 });
  let sendsA = 0;
  let wsA!: WebSocket;
  wsA = fakeWs(() => {}, (message) => {
    if (message !== "cursor") return;
    sendsA++;
    if (sendsA > 1) queueMicrotask(() => daemon.handleWsMessageData(JSON.stringify({ head: remote.head }), wsA));
  });
  daemon.ws = wsA;
  daemon.markWsOpen(wsA);
  daemon.invalidateCursorSchedule();
  const committedEpoch = daemon.cursorEpoch;
  const committedRun = daemon.runCursorCheck(wsA, daemon.wsGeneration, committedEpoch);
  expect(sendsA).toBe(1);
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 0 }), wsA);
  await committedRun;
  await daemon.pumpRun;
  cursorClock.advance(75);
  await waitUntil(() => sendsA === 2);
  expect(await fs.readFile(path.join(root, "overlap.txt"), "utf8")).toBe("once");
  expect(daemon.notifyAppliedPulls).toBe(1);
  expect(daemon.cursorAppliedPulls).toBe(0);

  daemon.invalidateCursorSchedule();
  const reconnectEpoch = daemon.cursorEpoch;
  const reconnectRun = daemon.runCursorCheck(wsA, daemon.wsGeneration, reconnectEpoch);
  expect(sendsA).toBe(3);
  daemon.markWsDisconnected(wsA, "close");
  let sendsB = 0;
  const wsB = fakeWs(() => {}, (message) => { if (message === "cursor") sendsB++; });
  daemon.ws = wsB;
  daemon.markWsOpen(wsB);
  await reconnectRun;
  cursorClock.advance(75);
  expect(sendsB).toBe(1);
  expect(sendsA).toBe(3);
  expect(daemon.cursorAppliedPulls).toBe(0);

  await daemon.stop();
  cursorClock.advance(1_000);
  expect(sendsB).toBe(1);
  expect(daemon.cursorTimer).toBeUndefined();
});

test("cursor scheduling stays off while reset-halted and resumes once ready", async () => {
  process.env.RBOX_DAEMON_WS_CURSOR_CHECK_MS = "30";
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "0";
  const daemon = await makeDaemon();
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.resetLifecycle = "halted";
  daemon.markWsOpen(ws);
  expect(daemon.cursorTimer).toBeUndefined();
  daemon.resetLifecycle = "ready";
  daemon.resetCursorSchedule(ws);
  expect(daemon.cursorTimer).toBeDefined();
});

test("WS-disabled plus zero backstop is the pure-polling falsification config", async () => {
  process.env.RBOX_DAEMON_WS_DISABLED = "1";
  process.env.RBOX_DAEMON_POLL_BACKSTOP_MS = "0";
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  let connectCalls = 0;
  daemon.connect = () => { connectCalls++; };
  daemon.maybeConnect();
  expect(connectCalls).toBe(0);
  daemon.startBackstop();
  expect(daemon.wsDisabled).toBe(true);
  expect(daemon.backstopMs).toBe(0);
  expect(daemon.backstopTimer).toBeUndefined();
  expect(remote.latestCalls).toBe(0);

  delete process.env.RBOX_DAEMON_WS_DISABLED;
  const enabled = await makeDaemon();
  enabled.connect = () => { connectCalls++; };
  enabled.maybeConnect();
  expect(connectCalls).toBe(1);
});

test("an applying backstop pull increments attempts and backstop attribution", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("backstop.txt", "arrived")]);
  const daemon = await makeDaemon(remote);
  daemon.onBackstopTick();
  await daemon.pumpRun;
  expect(await fs.readFile(path.join(root, "backstop.txt"), "utf8")).toBe("arrived");
  expect(daemon.wsBackstopPulls).toBe(1);
  expect(daemon.backstopAppliedPulls).toBe(1);
  expect(daemon.notifyAppliedPulls).toBe(0);
});

test("a failed notify is discarded and a fresh applying backstop gets the credit", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("healed.txt", "backstop")]);
  remote.throwNextLatest = true;
  const daemon = await makeDaemon(remote);
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 1 }));
  await daemon.pumpRun;
  expect(daemon.notifyAppliedPulls).toBe(0);
  expect(daemon.backstopAppliedPulls).toBe(0);

  daemon.recoveryDue = true;
  daemon.onBackstopTick();
  await daemon.pumpRun;
  expect(await fs.readFile(path.join(root, "healed.txt"), "utf8")).toBe("backstop");
  expect(daemon.notifyAppliedPulls).toBe(0);
  expect(daemon.backstopAppliedPulls).toBe(1);
});

test("notify wins over cursor, coalesced backstop, and a carrier-less catch-up", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("coalesced.txt", "notify")]);
  const daemon = await makeDaemon(remote);
  daemon.pumping = true; // hold the pending pull until every trigger has coalesced
  daemon.want.pull = true; // reconnect/startup-style none carrier
  daemon.onBackstopTick();
  daemon.raiseQueuedCarrier("cursor");
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 1 }));
  expect(daemon.queuedCarrier).toBe("notify");
  daemon.pumping = false;
  await daemon.pump();
  expect(daemon.notifyAppliedPulls).toBe(1);
  expect(daemon.backstopAppliedPulls).toBe(0);
});

test("a WS generation change discards notify but preserves a masked backstop", async () => {
  const daemon = await makeDaemon();
  daemon.pumping = true;
  daemon.onBackstopTick();
  daemon.handleWsMessageData(JSON.stringify({ type: "committed", sequence: 1 }));
  expect(daemon.queuedCarrier).toBe("notify");
  expect(daemon.queuedBackstopPending).toBe(true);
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.markWsOpen(ws); // the real generation transition discards only WS provenance
  expect(daemon.queuedCarrier).toBe("backstop");
  expect(daemon.notifyPullPendingAt).toBeUndefined();
  daemon.pumping = false;
});

test("a WS generation change discards cursor but preserves a masked backstop", async () => {
  const daemon = await makeDaemon();
  daemon.pumping = true;
  daemon.onBackstopTick();
  daemon.raiseQueuedCarrier("cursor");
  expect(daemon.queuedCarrier).toBe("cursor");
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  expect(daemon.queuedCarrier).toBe("backstop");
  daemon.pumping = false;
});

test("startup and reconnect catch-up applying pulls are attributed to neither carrier", async () => {
  const remote = new MiniRemote();
  const first = await remote.seedEntry("startup.txt", "startup");
  remote.injectCommit([first]);
  const daemon = await makeDaemon(remote);
  daemon.want.pull = true;
  await daemon.pump();
  expect(daemon.notifyAppliedPulls).toBe(0);
  expect(daemon.backstopAppliedPulls).toBe(0);

  const second = await remote.seedEntry("reconnect.txt", "reconnect");
  remote.injectCommit([first, second]);
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.pendingCatchUpGeneration = daemon.markWsOpen(ws);
  daemon.want.pull = true;
  await daemon.pump();
  expect(await fs.readFile(path.join(root, "reconnect.txt"), "utf8")).toBe("reconnect");
  expect(daemon.notifyAppliedPulls).toBe(0);
  expect(daemon.backstopAppliedPulls).toBe(0);
});

test("a push-internal recovery pull is attributed to neither carrier", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("remote.txt", "remote")]);
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "local.txt"), "local");
  daemon.manifest = await scanManifest(root, undefined, daemon.cache);
  daemon.want.push = true;
  await daemon.pump();
  expect(await fs.readFile(path.join(root, "remote.txt"), "utf8")).toBe("remote");
  expect(daemon.notifyAppliedPulls).toBe(0);
  expect(daemon.backstopAppliedPulls).toBe(0);
});

test("sampling exports absolute counter deltas and leaves cumulative log counters intact", async () => {
  let monotonic = 0;
  const logs: string[] = [];
  const daemon = await makeDaemon(new MiniRemote(), { monotonicNow: () => monotonic, log: (line) => logs.push(line) });
  const samples: WsHealthSample[] = [];
  daemon.telemetry = { record: (sample) => { if (sample.kind === "ws_health") samples.push(sample); }, flush: async () => {} };
  daemon.wsBackstopPulls = 5;
  daemon.wsReconnects = 5;
  daemon.wsHalfOpenDetected = 5;
  monotonic = 120_000;
  daemon.sampleWsHealth();
  daemon.wsBackstopPulls = 8;
  monotonic = 240_000;
  daemon.sampleWsHealth();
  expect(samples.map((sample) => sample.backstopAttempts)).toEqual([5, 3]);
  expect(samples[0]).toMatchObject({ notifyLatencyCount: 0, notifyLatencyMaxMs: 0, cursorAppliedPulls: 0 });
  expect(daemon.wsBackstopPulls).toBe(8);
  daemon.onBackstopTick();
  expect(logs).toContain("ws backstop pull (ws_backstop_pull=9)");
  daemon.scheduleReconnect = () => {};
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.onPongDeadline(ws);
  expect(logs.some((line) => line.includes("ws_half_open_detected=6"))).toBe(true);
  expect(logs).toContain("ws_reconnect reason=timeout count=6");
});

test("monotonic WS exposure never exceeds its window and never goes negative", async () => {
  let monotonic = 0;
  const daemon = await makeDaemon(new MiniRemote(), { monotonicNow: () => monotonic });
  const samples: WsHealthSample[] = [];
  daemon.telemetry = { record: (sample) => { if (sample.kind === "ws_health") samples.push(sample); }, flush: async () => {} };
  const ws = fakeWs();
  daemon.ws = ws;
  daemon.markWsOpen(ws);
  monotonic = 100;
  daemon.sampleWsHealth();
  monotonic = 175;
  daemon.markWsDisconnected(ws, "close");
  monotonic = 200;
  daemon.sampleWsHealth();
  monotonic = 150; // regressed source is clamped by the daemon's monotonic high-water
  daemon.sampleWsHealth();
  expect(samples.map(({ windowMs, wsConnectedMs }) => ({ windowMs, wsConnectedMs }))).toEqual([
    { windowMs: 100, wsConnectedMs: 100 },
    { windowMs: 100, wsConnectedMs: 75 },
    { windowMs: 0, wsConnectedMs: 0 },
  ]);
  expect(samples.every((sample) => sample.windowMs >= 0 && sample.wsConnectedMs >= 0 && sample.wsConnectedMs <= sample.windowMs)).toBe(true);
});
