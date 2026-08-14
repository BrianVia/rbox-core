import { expect, test } from "bun:test";
import type { DaemonActivity } from "../activity.js";
import {
  RemoteWakeupChannel,
  type RemoteWakeupClock,
  type RemoteWakeupPort,
  type RemoteWakeupSocket,
  type RemoteWakeupTimer,
} from "./remote-wakeup-channel.js";

type EventName = "open" | "message" | "pong" | "close" | "error";

class ManualClock implements RemoteWakeupClock {
  wall = 1_000;
  monotonic = 0;
  randomValue = 0;
  private next = 1;
  private timers = new Map<number, { at: number; interval?: number; fn: () => void }>();
  wallNow = () => this.wall;
  monotonicNow = () => this.monotonic;
  random = () => this.randomValue;
  setTimeout(fn: () => void, ms: number): number { return this.add(fn, ms); }
  clearTimeout(handle: RemoteWakeupTimer): void { this.timers.delete(handle as number); }
  setInterval(fn: () => void, ms: number): number { return this.add(fn, ms, ms); }
  clearInterval(handle: RemoteWakeupTimer): void { this.timers.delete(handle as number); }
  advance(ms: number): void {
    const target = this.monotonic + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [handle, timer] = due;
      this.wall += timer.at - this.monotonic;
      this.monotonic = timer.at;
      if (timer.interval === undefined) this.timers.delete(handle);
      else timer.at += timer.interval;
      timer.fn();
    }
    this.wall += target - this.monotonic;
    this.monotonic = target;
  }
  private add(fn: () => void, ms: number, interval?: number): number {
    const handle = this.next++;
    this.timers.set(handle, { at: this.monotonic + ms, interval, fn });
    return handle;
  }
}

class FakeSocket {
  readyState = WebSocket.OPEN;
  closes = 0;
  sends: string[] = [];
  private listeners = new Map<EventName, Array<(event: { data?: string }) => void>>();
  addEventListener(name: EventName, listener: (event: { data?: string }) => void): void {
    const entries = this.listeners.get(name) ?? [];
    entries.push(listener);
    this.listeners.set(name, entries);
  }
  send(message: string): void { this.sends.push(message); }
  close(): void { this.closes++; }
  emit(name: EventName, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function harness(overrides: Partial<{ disabled: boolean; reliabilityDisabled: boolean; pong: number; cursor: number; backstop: number; socketFailure: string }> = {}) {
  const clock = new ManualClock();
  const activity: DaemonActivity = { at: new Date(clock.wall).toISOString() };
  const sockets: FakeSocket[] = [];
  const pulls: string[] = [];
  const keys: Array<string | undefined> = [];
  const logs: string[] = [];
  const committed: number[] = [];
  const dequeues: Array<[number | undefined, number]> = [];
  let appliedSequence = 0;
  let persists = 0;
  const port: RemoteWakeupPort = {
    requestPull: () => pulls.push("pull"),
    appliedSequence: () => appliedSequence,
    enqueueKeyDelivery: (id) => keys.push(id),
    persistActivity: () => { persists++; },
    log: (line) => logs.push(line),
    traceCommitted: (sequence) => committed.push(sequence),
    tracePullDequeue: (sequence, latency) => dequeues.push([sequence, latency]),
  };
  const channel = new RemoteWakeupChannel({
    url: "wss://example.test/ws", token: "token", deviceId: "device", bootId: "boot", activity,
    disabled: overrides.disabled ?? false, reliabilityDisabled: overrides.reliabilityDisabled ?? false,
    pongDeadlineMs: overrides.pong ?? 60_000, cursorCheckMs: overrides.cursor ?? 100,
    backstopMs: overrides.backstop ?? 1_000, clock,
    createSocket: () => {
      if (overrides.socketFailure) throw new Error(overrides.socketFailure);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket satisfies RemoteWakeupSocket;
    },
  }, port);
  return { channel, clock, activity, sockets, pulls, keys, logs, committed, dequeues,
    persists: () => persists, setAppliedSequence: (value: number) => { appliedSequence = value; } };
}

function open(h: ReturnType<typeof harness>): FakeSocket {
  h.channel.activate();
  const socket = h.sockets.at(-1)!;
  socket.emit("open");
  return socket;
}

test("healthy startup explicitly becomes ready before activation; reset-halted startup does not catch up", () => {
  const healthy = harness({ backstop: 0 });
  healthy.channel.start();
  healthy.channel.setReady(true);
  open(healthy);
  expect(healthy.pulls).toEqual(["pull"]);
  expect(healthy.activity.ws).toMatchObject({ connected: true, caughtUp: false, bootId: "boot" });

  const halted = harness({ backstop: 0 });
  halted.channel.start();
  halted.channel.setReady(false);
  open(halted);
  expect(halted.pulls).toEqual([]);
});

test("dequeue traces newest coalesced sequence and latency exactly once even when settlement fails", () => {
  const h = harness({ backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  h.pulls.length = 0;
  socket.emit("message", { data: JSON.stringify({ type: "committed", sequence: 4 }) });
  h.clock.wall += 25;
  socket.emit("message", { data: JSON.stringify({ type: "committed", sequence: 9 }) });
  h.clock.wall += 75;
  const receipt = h.channel.beginPull();
  expect(receipt).toEqual({ notifyPendingAt: 1_000, notifyLatencyMs: 100 });
  expect(h.dequeues).toEqual([[9, 100]]);
  expect(h.logs).toContain("notify_latency_ms=100 sequence=9");
  h.channel.settlePull(receipt, { succeeded: false, applied: false });
  h.channel.settlePull(receipt, { succeeded: true, applied: true });
  const later = h.channel.beginPull();
  expect(later.notifyLatencyMs).toBeUndefined();
  expect(h.dequeues).toHaveLength(1);
  expect(h.channel.healthSample()).toMatchObject({ notifyLatencyCount: 1, notifyLatencySumMs: 100, notifyAppliedPulls: 0 });
});

test("shutdown pins all three edges: ready fence, pre-drain quiesce, post-drain close", async () => {
  const h = harness({ cursor: 100, backstop: 1_000, pong: 500 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(75);
  expect(socket.sends).toContain("cursor");

  h.channel.setReady(false); // initial stop edge aborts the in-flight cursor
  await Promise.resolve();
  expect(h.logs.some((line) => line.startsWith("ws cursor check failed:"))).toBe(false);
  h.channel.quiesce(); // synchronous pre-drain edge disarms liveness/backstop
  expect(socket.closes).toBe(0);
  const sendsAtDrain = socket.sends.length;
  const keysAtDrain = h.keys.length;
  h.clock.advance(120_000); // parked daemon drain
  expect(socket.sends).toHaveLength(sendsAtDrain);
  expect(h.keys).toHaveLength(keysAtDrain);
  expect(socket.closes).toBe(0);

  h.channel.finalizeStop(); // post-drain suffix
  h.channel.finalizeStop();
  expect(socket.closes).toBe(1);
});

test("committed frames reset cursor cadence, retain first timestamp, and record newest sequence", () => {
  const h = harness({ cursor: 100, backstop: 0, pong: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  h.pulls.length = 0;
  for (let sequence = 1; sequence <= 3; sequence++) {
    h.clock.advance(40);
    socket.emit("message", { data: JSON.stringify({ type: "committed", sequence }) });
  }
  expect(socket.sends).not.toContain("cursor");
  expect(h.committed).toEqual([1, 2, 3]);
  expect(h.activity.ws?.lastBroadcastSequence).toBe(3);
  expect(h.channel.beginPull().notifyLatencyMs).toBe(80);
});

test("cursor wakes only when remote head is newer and is credited only when applied", async () => {
  const h = harness({ cursor: 100, backstop: 0, pong: 0 });
  h.setAppliedSequence(5);
  h.channel.setReady(true);
  const socket = open(h);
  h.pulls.length = 0;
  h.clock.advance(75);
  socket.emit("message", { data: JSON.stringify({ head: 6 }) });
  await Promise.resolve();
  expect(h.pulls).toEqual(["pull"]);
  const receipt = h.channel.beginPull();
  h.channel.settlePull(receipt, { succeeded: true, applied: true });
  expect(h.channel.healthSample().cursorAppliedPulls).toBe(1);
});

test("backstop first/subsequent cadence nudges key delivery and rephases on notify", () => {
  const h = harness({ cursor: 0, pong: 0, backstop: 1_000 });
  h.clock.randomValue = 0.5;
  h.channel.activate();
  h.clock.advance(499);
  expect(h.keys).toEqual([]);
  h.clock.advance(1);
  expect(h.keys).toEqual([undefined]);
  expect(h.logs).toContain("ws backstop pull (ws_backstop_pull=1)");
  h.clock.advance(999);
  expect(h.keys).toHaveLength(1);
  h.clock.advance(1);
  expect(h.keys).toHaveLength(2);
  expect(h.channel.healthSample().backstopAttempts).toBe(2);
});

test("all eight load-bearing log formats remain exact", async () => {
  const failed = harness({ socketFailure: "dial refused", backstop: 0 });
  failed.channel.activate();
  expect(failed.logs).toEqual(["ws connect failed: dial refused"]);

  const h = harness({ cursor: 100, backstop: 1_000, pong: 60_000 });
  h.channel.setReady(true);
  const socket = open(h);
  expect(h.logs).toContain("ws connected");
  socket.emit("message", { data: JSON.stringify({ type: "committed", sequence: 8 }) });
  h.clock.wall += 25;
  h.channel.beginPull();
  expect(h.logs).toContain("notify_latency_ms=25 sequence=8");
  h.clock.advance(75);
  h.clock.advance(99);
  await Promise.resolve();
  expect(h.logs).toContain("ws cursor check failed: cursor reply timed out after 99ms");

  const errored = harness({ cursor: 0, backstop: 0, pong: 0 });
  errored.channel.setReady(true);
  const errorSocket = open(errored);
  errorSocket.emit("error");
  expect(errored.logs).toContain("ws_reconnect reason=error count=1");
  expect(errored.logs).toContain("ws error");

  const halfOpen = harness({ cursor: 0, backstop: 0, pong: 60_000 });
  halfOpen.channel.setReady(true);
  open(halfOpen);
  halfOpen.clock.advance(60_000);
  expect(halfOpen.logs).toContain("ws half-open detected — no frame in 60s; cycling socket (ws_half_open_detected=1)");

  const backstop = harness({ cursor: 0, backstop: 100, pong: 0 });
  backstop.channel.activate();
  backstop.clock.advance(0);
  expect(backstop.logs).toContain("ws backstop pull (ws_backstop_pull=1)");
});

test("notify carrier wins over a masked backstop and stale/replayed receipts cannot double-credit", () => {
  const h = harness({ cursor: 0, pong: 0, backstop: 100 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(0); // first backstop at random=0
  socket.emit("message", { data: JSON.stringify({ type: "committed", sequence: 7 }) });
  const receipt = h.channel.beginPull();
  h.channel.settlePull(receipt, { succeeded: true, applied: true });
  h.channel.settlePull(receipt, { succeeded: true, applied: true });
  expect(h.channel.healthSample()).toMatchObject({ notifyAppliedPulls: 1, backstopAppliedPulls: 0 });
});

test("generation change discards WS provenance while preserving a masked backstop", () => {
  const h = harness({ cursor: 0, pong: 0, backstop: 100 });
  h.channel.setReady(true);
  const first = open(h);
  h.clock.advance(75);
  first.emit("message", { data: JSON.stringify({ type: "committed", sequence: 7 }) });
  const second = open(h);
  const receipt = h.channel.beginPull();
  h.channel.settlePull(receipt, { succeeded: true, applied: true });
  expect(second).toBeDefined();
  expect(h.channel.healthSample()).toMatchObject({ notifyAppliedPulls: 0, backstopAppliedPulls: 1 });
});

test("failed catch-up is restored for healing, but superseded generation cannot mark caught up", () => {
  const h = harness({ cursor: 0, pong: 0, backstop: 0 });
  h.channel.setReady(true);
  open(h);
  const failed = h.channel.beginPull();
  const replacement = open(h);
  h.channel.settlePull(failed, { succeeded: true, applied: false });
  expect(replacement).toBeDefined();
  expect(h.activity.ws?.caughtUp).toBe(false);
});

test("half-open socket cycles once, reconnects, and keeps exact cumulative log formats", () => {
  const h = harness({ cursor: 0, backstop: 0, pong: 60_000 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(60_000);
  expect(socket.closes).toBe(1);
  expect(h.logs).toContain("ws half-open detected — no frame in 60s; cycling socket (ws_half_open_detected=1)");
  expect(h.logs).toContain("ws_reconnect reason=timeout count=1");
  expect(h.channel.healthSample()).toMatchObject({ wsHalfOpenDetected: 1, wsReconnects: 1 });
});

test("health windows clamp regressing/non-finite monotonic time and reset sample-only counters", () => {
  const h = harness({ cursor: 0, backstop: 0, pong: 0 });
  h.channel.setReady(true);
  open(h);
  h.clock.monotonic = 100;
  expect(h.channel.healthSample()).toMatchObject({ windowMs: 100, wsConnectedMs: 100 });
  h.clock.monotonic = 50;
  expect(h.channel.healthSample()).toMatchObject({ windowMs: 0, wsConnectedMs: 0 });
  h.clock.monotonic = Number.NaN;
  expect(h.channel.healthSample()).toMatchObject({ windowMs: 0, wsConnectedMs: 0 });
});

test("disabled modes preserve polling-only and committed-pull behavior without reliability telemetry", () => {
  const disabled = harness({ disabled: true, backstop: 0 });
  disabled.channel.setReady(true);
  disabled.channel.activate();
  expect(disabled.sockets).toEqual([]);

  const reliabilityOff = harness({ reliabilityDisabled: true, cursor: 0, backstop: 0, pong: 0 });
  reliabilityOff.channel.setReady(true);
  const socket = open(reliabilityOff);
  reliabilityOff.pulls.length = 0;
  socket.emit("message", { data: JSON.stringify({ type: "committed", sequence: 2 }) });
  expect(reliabilityOff.pulls).toEqual(["pull"]);
  expect(reliabilityOff.channel.beginPull().notifyLatencyMs).toBeUndefined();
});

test("key-delivery nudges bypass readiness without scheduling workspace pull", () => {
  const h = harness({ backstop: 0, cursor: 0, pong: 0 });
  h.channel.setReady(false);
  const socket = open(h);
  const requestId = "a".repeat(64);
  socket.emit("message", { data: JSON.stringify({ type: "key-delivery", requestId }) });
  expect(h.keys).toContain(requestId);
  expect(h.pulls).toEqual([]);
});
