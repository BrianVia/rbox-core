import { expect, test } from "bun:test";
import type { DaemonActivity } from "../activity.js";
import { reconnectDelayMs } from "./policy.js";
import {
  RemoteWakeupChannel,
  type PullWakeupReceipt,
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
  private readonly timers = new Map<number, { at: number; interval?: number; fn: () => void }>();

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
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
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

class FakeSocket implements RemoteWakeupSocket {
  readyState = WebSocket.OPEN;
  closes = 0;
  readonly sends: string[] = [];
  private readonly listeners = new Map<EventName, Array<(event: { data?: string }) => void>>();

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

interface Harness {
  channel: RemoteWakeupChannel;
  clock: ManualClock;
  activity: DaemonActivity;
  sockets: FakeSocket[];
  pulls: string[];
  keys: Array<string | undefined>;
  logs: string[];
  dequeues: Array<[number | undefined, number]>;
  setAppliedSequence(value: number): void;
}

function harness(overrides: Partial<{
  disabled: boolean;
  reliabilityDisabled: boolean;
  pong: number;
  cursor: number;
  backstop: number;
}> = {}): Harness {
  const clock = new ManualClock();
  const activity: DaemonActivity = { at: new Date(clock.wall).toISOString() };
  const sockets: FakeSocket[] = [];
  const pulls: string[] = [];
  const keys: Array<string | undefined> = [];
  const logs: string[] = [];
  const dequeues: Array<[number | undefined, number]> = [];
  let appliedSequence = 0;
  const port: RemoteWakeupPort = {
    requestPull: () => pulls.push("pull"),
    appliedSequence: () => appliedSequence,
    enqueueKeyDelivery: (requestId) => keys.push(requestId),
    persistActivity: () => {},
    log: (line) => logs.push(line),
    traceCommitted: () => {},
    tracePullDequeue: (sequence, latency) => dequeues.push([sequence, latency]),
  };
  const reliabilityDisabled = overrides.reliabilityDisabled ?? false;
  const channel = new RemoteWakeupChannel({
    url: "wss://example.test/ws",
    token: "token",
    deviceId: "device",
    bootId: "boot",
    activity,
    disabled: overrides.disabled ?? false,
    reliabilityDisabled,
    pongDeadlineMs: reliabilityDisabled ? 0 : (overrides.pong ?? 60_000),
    cursorCheckMs: reliabilityDisabled ? 0 : (overrides.cursor ?? 100),
    backstopMs: reliabilityDisabled ? 0 : (overrides.backstop ?? 1_000),
    clock,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  }, port);
  return {
    channel, clock, activity, sockets, pulls, keys, logs, dequeues,
    setAppliedSequence: (value) => { appliedSequence = value; },
  };
}

function open(h: Harness): FakeSocket {
  h.channel.activate();
  const socket = h.sockets.at(-1)!;
  socket.emit("open");
  return socket;
}

function committed(socket: FakeSocket, sequence: number): void {
  socket.emit("message", { data: JSON.stringify({ type: "committed", sequence, deviceId: "d" }) });
}

function settle(channel: RemoteWakeupChannel, receipt: PullWakeupReceipt, applied: boolean, succeeded = true): void {
  channel.settlePull(receipt, { applied, succeeded });
}

test("pong deadline closes a silent socket and counts the half-open", () => {
  const h = harness({ pong: 20, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(20);
  expect(socket.closes).toBe(1);
  expect(h.channel.healthSample().wsHalfOpenDetected).toBe(1);
});

test("every inbound frame re-arms the pong deadline", () => {
  const h = harness({ pong: 60, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(40);
  socket.emit("message", { data: "pong" });
  h.clock.advance(20);
  expect(socket.closes).toBe(0);
  h.clock.advance(40);
  expect(socket.closes).toBe(1);
});

test("pong deadline disconnects immediately and schedules recovery", () => {
  const h = harness({ pong: 20, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(20);
  expect(h.activity.ws?.connected).toBe(false);
  expect(socket.closes).toBe(1);
  expect(h.logs).toContain("ws_reconnect reason=timeout count=1");
  h.clock.advance(0);
  expect(h.sockets).toHaveLength(2);
});

test("reconnect delay spreads the first attempt and preserves capped jitter", () => {
  expect(reconnectDelayMs(0, () => 0)).toBe(0);
  expect(reconnectDelayMs(0, () => 0.999999)).toBeLessThan(3_000);
  expect(reconnectDelayMs(1, () => 0)).toBe(750);
  expect(reconnectDelayMs(1, () => 1)).toBe(1_250);
  expect(reconnectDelayMs(10, () => 1)).toBe(37_500);
});

test("scheduleReconnect advances the attempt sequence used by reconnectDelayMs", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const first = open(h);
  first.emit("error");
  h.clock.advance(0);
  expect(h.sockets).toHaveLength(2);
  h.sockets[1]!.emit("error");
  h.clock.advance(749);
  expect(h.sockets).toHaveLength(2);
  h.clock.advance(1);
  expect(h.sockets).toHaveLength(3);
});

test("a stale socket deadline cannot close the replacement", () => {
  const h = harness({ pong: 20, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const stale = open(h);
  const replacement = open(h);
  stale.emit("close");
  expect(replacement.closes).toBe(0);
  expect(h.activity.ws?.connected).toBe(true);
  expect(h.channel.healthSample().wsHalfOpenDetected).toBe(0);
});

test("backstop pulls and reschedules itself", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 30 });
  h.channel.activate();
  h.clock.advance(0);
  settle(h.channel, h.channel.beginPull(), false);
  h.clock.advance(23);
  expect(h.pulls).toHaveLength(2);
  expect(h.channel.healthSample()).toMatchObject({ backstopAttempts: 2, backstopAppliedPulls: 0 });
});

test("committed notification resets the backstop and records a latency token", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 1_000 });
  h.clock.randomValue = 0.5;
  h.channel.setReady(true);
  const socket = open(h);
  h.pulls.length = 0;
  h.clock.advance(700);
  committed(socket, 5);
  h.clock.advance(999);
  expect(h.keys).toEqual([undefined]);
  h.clock.advance(1);
  expect(h.keys).toHaveLength(2);
  const receipt = h.channel.beginPull();
  expect(receipt.notifyPendingAt).toBeNumber();
  expect(h.logs.some((line) => line.startsWith("notify_latency_ms="))).toBe(true);
  expect(h.dequeues.at(-1)?.[0]).toBe(5);
});

test("failed notified pull logs latency at dequeue without restoring the timestamp", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  committed(socket, 5);
  h.clock.wall += 10;
  const receipt = h.channel.beginPull();
  settle(h.channel, receipt, false, false);
  expect(h.logs).toContain("notify_latency_ms=10 sequence=5");
  expect(h.channel.beginPull().notifyPendingAt).toBeUndefined();
  expect(h.channel.healthSample()).toMatchObject({ notifyLatencyCount: 1, notifyAppliedPulls: 0 });
});

test("failed catch-up pull restores its generation until a healing pull", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  open(h);
  settle(h.channel, h.channel.beginPull(), false, false);
  expect(h.activity.ws?.caughtUp).toBe(false);
  settle(h.channel, h.channel.beginPull(), false, true);
  expect(h.activity.ws?.caughtUp).toBe(true);
});

test("a stale socket message cannot trigger a pull or notify token", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const stale = open(h);
  open(h);
  h.pulls.length = 0;
  committed(stale, 5);
  expect(h.pulls).toEqual([]);
  expect(h.channel.beginPull().notifyPendingAt).toBeUndefined();
});

test("reliability master switch disables deadline, backstop, and notify token", () => {
  const h = harness({ reliabilityDisabled: true, pong: 20, cursor: 20, backstop: 20 });
  h.channel.setReady(true);
  const socket = open(h);
  h.pulls.length = 0;
  committed(socket, 1);
  h.clock.advance(10_000);
  expect(socket.closes).toBe(0);
  expect(socket.sends).not.toContain("cursor");
  expect(h.keys).toEqual([undefined]);
  expect(h.pulls).toEqual(["pull"]);
  expect(h.channel.beginPull().notifyPendingAt).toBeUndefined();
});

test("a missed committed frame is recovered by cursor before the backstop and credited once", async () => {
  const h = harness({ pong: 0, cursor: 30, backstop: 10_000 });
  h.setAppliedSequence(0);
  h.channel.setReady(true);
  const socket = open(h);
  h.pulls.length = 0;
  h.keys.length = 0;
  h.clock.advance(23);
  expect(socket.sends).toEqual(["cursor"]);
  socket.emit("message", { data: JSON.stringify({ head: 1 }) });
  await Promise.resolve();
  expect(h.pulls).toEqual(["pull"]);
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({
    cursorAppliedPulls: 1, notifyAppliedPulls: 0, backstopAppliedPulls: 0, backstopAttempts: 0,
  });
  expect(h.keys).toEqual([]);
});

test("live committed frames reset the cursor cadence before it can wake the DO", () => {
  const h = harness({ pong: 0, cursor: 200, backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  for (let sequence = 0; sequence < 12; sequence++) {
    committed(socket, sequence);
    h.clock.advance(40);
  }
  expect(socket.sends.filter((message) => message === "cursor")).toHaveLength(0);
});

test("a blackholed cursor is bounded, single-flight, does not cycle the socket, and preserves backstop", async () => {
  const h = harness({ pong: 0, cursor: 30, backstop: 10_000 });
  h.channel.setReady(true);
  const socket = open(h);
  h.keys.length = 0;
  h.clock.advance(23);
  expect(socket.sends).toEqual(["cursor"]);
  h.clock.advance(28);
  expect(socket.sends).toHaveLength(1);
  h.clock.advance(1);
  await Promise.resolve();
  h.clock.advance(22);
  expect(socket.sends).toHaveLength(1);
  h.clock.advance(1);
  expect(socket.sends).toEqual(["cursor", "cursor"]);
  expect(socket.closes).toBe(0);
  expect(h.keys).toEqual([]);
  expect(h.channel.healthSample()).toMatchObject({ backstopAttempts: 0, cursorAppliedPulls: 0 });
  h.clock.advance(7_425);
  expect(h.keys).toEqual([undefined]);
  expect(h.channel.healthSample()).toMatchObject({ backstopAttempts: 1, cursorAppliedPulls: 0 });
});

test("cursor epoch fences committed, reconnect, and stop overlaps", async () => {
  const h = harness({ pong: 0, cursor: 100, backstop: 0 });
  h.channel.setReady(true);
  const first = open(h);
  h.pulls.length = 0;
  h.clock.advance(75);
  expect(first.sends).toEqual(["cursor"]);
  committed(first, 1);
  first.emit("message", { data: JSON.stringify({ head: 2 }) });
  await Promise.resolve();
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({ notifyAppliedPulls: 1, cursorAppliedPulls: 0 });

  h.clock.advance(75);
  expect(first.sends).toEqual(["cursor", "cursor"]);
  first.emit("close");
  first.emit("message", { data: JSON.stringify({ head: 3 }) });
  h.clock.advance(0);
  const second = h.sockets.at(-1)!;
  second.emit("open");
  h.clock.advance(75);
  expect(second.sends).toEqual(["cursor"]);
  expect(first.sends).toHaveLength(2);

  h.channel.setReady(false);
  h.channel.quiesce();
  const sendsAtStop = second.sends.length;
  h.clock.advance(1_000);
  expect(second.sends).toHaveLength(sendsAtStop);
  h.channel.finalizeStop();
  expect(second.closes).toBe(1);
});

test("cursor scheduling stays off while reset-halted and resumes once ready", () => {
  const h = harness({ pong: 0, cursor: 30, backstop: 0 });
  h.channel.setReady(false);
  const socket = open(h);
  h.clock.advance(1_000);
  expect(socket.sends).not.toContain("cursor");
  h.channel.setReady(true);
  h.clock.advance(23);
  expect(socket.sends).toContain("cursor");
});

test("WS-disabled plus zero backstop is the pure-polling falsification config", () => {
  const disabled = harness({ disabled: true, pong: 0, cursor: 0, backstop: 0 });
  disabled.channel.setReady(true);
  disabled.channel.activate();
  disabled.clock.advance(10_000);
  expect(disabled.sockets).toEqual([]);
  expect(disabled.pulls).toEqual([]);
  expect(disabled.keys).toEqual([]);

  const enabled = harness({ pong: 0, cursor: 0, backstop: 0 });
  enabled.channel.activate();
  expect(enabled.sockets).toHaveLength(1);
});

test("an applying backstop pull increments attempts and backstop attribution", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 100 });
  h.channel.activate();
  h.clock.advance(0);
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({
    backstopAttempts: 1, backstopAppliedPulls: 1, notifyAppliedPulls: 0,
  });
});

test("a failed notify is discarded and a fresh applying backstop gets the credit", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 100 });
  h.channel.setReady(true);
  const socket = open(h);
  committed(socket, 1);
  settle(h.channel, h.channel.beginPull(), false, false);
  h.clock.advance(75);
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({ notifyAppliedPulls: 0, backstopAppliedPulls: 1 });
});

test("notify wins over cursor, coalesced backstop, and a carrier-less catch-up", async () => {
  const h = harness({ pong: 0, cursor: 100, backstop: 100 });
  h.setAppliedSequence(0);
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.advance(0);
  h.clock.advance(75);
  socket.emit("message", { data: JSON.stringify({ head: 1 }) });
  await Promise.resolve();
  committed(socket, 1);
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({
    notifyAppliedPulls: 1, cursorAppliedPulls: 0, backstopAppliedPulls: 0,
  });
});

test("a WS generation change discards notify but preserves a masked backstop", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 100 });
  h.channel.setReady(true);
  const first = open(h);
  h.clock.advance(75);
  committed(first, 1);
  const second = open(h);
  expect(second).toBeDefined();
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({ notifyAppliedPulls: 0, backstopAppliedPulls: 1 });
});

test("a WS generation change discards cursor but preserves a masked backstop", async () => {
  const h = harness({ pong: 0, cursor: 100, backstop: 100 });
  h.setAppliedSequence(0);
  h.channel.setReady(true);
  const first = open(h);
  h.clock.advance(0);
  h.clock.advance(75);
  first.emit("message", { data: JSON.stringify({ head: 1 }) });
  await Promise.resolve();
  open(h);
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({ cursorAppliedPulls: 0, backstopAppliedPulls: 1 });
});

test("startup and reconnect catch-up applying pulls are attributed to neither carrier", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  open(h);
  settle(h.channel, h.channel.beginPull(), true);
  open(h);
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({
    notifyAppliedPulls: 0, cursorAppliedPulls: 0, backstopAppliedPulls: 0,
  });
  expect(h.activity.ws?.caughtUp).toBe(true);
});

test("a push-internal recovery pull is attributed to neither carrier", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  settle(h.channel, h.channel.beginPull(), true);
  expect(h.channel.healthSample()).toMatchObject({
    notifyAppliedPulls: 0, cursorAppliedPulls: 0, backstopAppliedPulls: 0,
  });
});

test("sampling exports absolute counter deltas and leaves cumulative log counters intact", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 100 });
  h.channel.activate();
  h.clock.advance(0);
  for (let i = 1; i < 5; i++) h.clock.advance(75);
  const first = h.channel.healthSample();
  for (let i = 0; i < 3; i++) h.clock.advance(75);
  const second = h.channel.healthSample();
  expect([first.backstopAttempts, second.backstopAttempts]).toEqual([5, 3]);
  expect(first).toMatchObject({ notifyLatencyCount: 0, notifyLatencyMaxMs: 0, cursorAppliedPulls: 0 });
  expect(h.logs).toContain("ws backstop pull (ws_backstop_pull=8)");

  const liveness = harness({ pong: 10, cursor: 0, backstop: 0 });
  liveness.channel.setReady(true);
  open(liveness);
  for (let i = 0; i < 5; i++) {
    liveness.clock.advance(10);
    liveness.clock.advance(0);
    liveness.sockets.at(-1)!.emit("open");
  }
  const livenessFirst = liveness.channel.healthSample();
  for (let i = 0; i < 3; i++) {
    liveness.clock.advance(10);
    liveness.clock.advance(0);
    liveness.sockets.at(-1)!.emit("open");
  }
  const livenessSecond = liveness.channel.healthSample();
  expect([livenessFirst.wsHalfOpenDetected, livenessSecond.wsHalfOpenDetected]).toEqual([5, 3]);
  expect([livenessFirst.wsReconnects, livenessSecond.wsReconnects]).toEqual([5, 3]);
  expect(liveness.logs).toContain("ws half-open detected — no frame in 0s; cycling socket (ws_half_open_detected=8)");
  expect(liveness.logs).toContain("ws_reconnect reason=timeout count=8");
});

test("monotonic WS exposure never exceeds its window and never goes negative", () => {
  const h = harness({ pong: 0, cursor: 0, backstop: 0 });
  h.channel.setReady(true);
  const socket = open(h);
  h.clock.monotonic = 100;
  const first = h.channel.healthSample();
  h.clock.monotonic = 175;
  socket.emit("close");
  h.clock.monotonic = 200;
  const second = h.channel.healthSample();
  h.clock.monotonic = 150;
  const third = h.channel.healthSample();
  expect([first, second, third].map(({ windowMs, wsConnectedMs }) => ({ windowMs, wsConnectedMs }))).toEqual([
    { windowMs: 100, wsConnectedMs: 100 },
    { windowMs: 100, wsConnectedMs: 75 },
    { windowMs: 0, wsConnectedMs: 0 },
  ]);
  expect([first, second, third].every((sample) =>
    sample.windowMs >= 0 && sample.wsConnectedMs >= 0 && sample.wsConnectedMs <= sample.windowMs,
  )).toBe(true);
});
