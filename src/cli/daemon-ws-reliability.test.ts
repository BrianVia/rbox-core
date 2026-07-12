import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type BlobStore, type Manifest } from "../engine/index.js";
import type { SyncState, WorkspaceConfig } from "./config.js";
import { reconnectDelayMs, RboxDaemon } from "./daemon.js";
import type { CommitResult, SyncRemote } from "./remote.js";

const ENV_KEYS = [
  "RBOX_DAEMON_WS_DISABLED",
  "RBOX_DAEMON_WS_RELIABILITY_DISABLED",
  "RBOX_DAEMON_WS_PONG_DEADLINE_MS",
  "RBOX_DAEMON_POLL_BACKSTOP_MS",
] as const;

interface DaemonInternals {
  ws?: WebSocket;
  pongDeadlineMs: number;
  backstopMs: number;
  wsReliabilityDisabled: boolean;
  wsDisabled: boolean;
  wsHalfOpenDetected: number;
  wsBackstopPulls: number;
  reconnectAttempt: number;
  notifyPullPendingAt?: number;
  pendingCatchUpGeneration?: number;
  wsPongDeadlineTimer?: ReturnType<typeof setTimeout>;
  backstopTimer?: ReturnType<typeof setTimeout>;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pumpRun: Promise<void>;
  cache: HashCache;
  manifest: Manifest;
  activity: { ws?: { connected: boolean; caughtUp: boolean } };
  armPongDeadline(ws: WebSocket): void;
  clearPongDeadline(): void;
  onPongDeadline(ws: WebSocket): void;
  startBackstop(): void;
  scheduleNextBackstop(): void;
  clearBackstop(): void;
  markWsOpen(ws: WebSocket): number;
  markWsDisconnected(ws: WebSocket, reason: "close" | "error" | "timeout"): boolean;
  handleWsMessageData(data: string, from?: WebSocket): void;
  connect(): void;
  maybeConnect(): void;
  scheduleReconnect(): void;
  pump(): Promise<void>;
  loadSyncBase(): Promise<SyncState>;
  stop(): Promise<void>;
}

class MiniRemote implements SyncRemote {
  latestCalls = 0;
  throwNextLatest = false;
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    this.latestCalls++;
    if (this.throwNextLatest) {
      this.throwNextLatest = false;
      throw new Error("latest failed");
    }
    return { sequence: 0, manifest: { generatedAt: "", files: [] } };
  }
  async missingBlobs(): Promise<string[]> { return []; }
  async putBlobFile(): Promise<void> {}
  async commit(): Promise<CommitResult> { return { sequence: 1 }; }
  blobStore(): BlobStore {
    return { has: async () => false, put: async () => {}, get: async () => { throw new Error("missing"); } };
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

async function makeDaemon(remote: MiniRemote = new MiniRemote()): Promise<DaemonInternals> {
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws_test", projectId: "root", deviceId: "dev_test",
    rootPath: root, remoteUrl: "mem://", token: "", encrypted: true, kek: Buffer.alloc(32, 7),
    accountId: "acct_test", accountEpoch: 0, keyEpoch: 0,
  };
  const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }, {
    bootId: "boot-test",
  }) as unknown as DaemonInternals;
  daemon.cache = await HashCache.load(root);
  daemon.manifest = await scanManifest(root);
  await daemon.loadSyncBase();
  daemons.push(daemon);
  return daemon;
}

function fakeWs(close = () => {}): WebSocket {
  return { readyState: WebSocket.OPEN, send: () => {}, close } as unknown as WebSocket;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("pong deadline closes a silent socket and counts the half-open", async () => {
  process.env.RBOX_DAEMON_WS_PONG_DEADLINE_MS = "20";
  const daemon = await makeDaemon();
  let closes = 0;
  const ws = fakeWs(() => closes++);
  daemon.ws = ws;
  daemon.scheduleReconnect = () => {};
  daemon.markWsOpen(ws);
  await sleep(100);
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
  await sleep(90);
  expect(daemon.wsBackstopPulls).toBeGreaterThanOrEqual(1);
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
  expect(daemon.wsPongDeadlineTimer).toBeUndefined();
  expect(daemon.backstopTimer).toBeUndefined();
  expect(daemon.notifyPullPendingAt).toBeUndefined();
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
  await sleep(50);
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
