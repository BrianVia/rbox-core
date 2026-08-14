import type { DaemonActivity } from "../activity.js";
import { TELEMETRY_SAMPLE_SCHEMAS, type WsHealthSample } from "../telemetry/contract.js";
import { jitter, reconnectDelayMs, WS_KEEPALIVE_PERSIST_MS, WS_PING_MS } from "./policy.js";
import { parseKeyDeliveryNudge } from "./key-delivery-fulfill.js";

export type RemoteWakeupTimer = ReturnType<typeof setTimeout> | number;
export interface RemoteWakeupClock {
  wallNow(): number; monotonicNow(): number; random(): number;
  setTimeout(fn: () => void, ms: number): RemoteWakeupTimer; clearTimeout(handle: RemoteWakeupTimer): void;
  setInterval(fn: () => void, ms: number): RemoteWakeupTimer; clearInterval(handle: RemoteWakeupTimer): void;
}

export interface RemoteWakeupPort {
  requestPull(): void; appliedSequence(): number;
  enqueueKeyDelivery(requestId?: string): void; persistActivity(): void;
  log(line: string): void; traceCommitted(sequence: number): void;
  tracePullDequeue(sequence: number | undefined, latencyMs: number): void;
}

export interface PullWakeupReceipt {
  readonly notifyLatencyMs?: number;
  readonly notifyPendingAt?: number;
}

type Carrier = "none" | "backstop" | "cursor" | "notify";
export interface RemoteWakeupSocket {
  readonly readyState: number;
  send(message: string): void; close(): void;
  addEventListener(name: "open" | "message" | "pong" | "close" | "error", listener: (event: { data?: string }) => void): void;
}
type SocketFactory = (url: string, headers: Record<string, string>) => RemoteWakeupSocket;
type ReceiptState = { carrier: Carrier; catchUp?: number };
const PRECEDENCE = { none: 0, backstop: 1, cursor: 2, notify: 3 } as const;

export interface RemoteWakeupConfig {
  url: string; token: string; deviceId: string; bootId: string;
  activity: DaemonActivity; disabled: boolean; reliabilityDisabled: boolean;
  pongDeadlineMs: number; cursorCheckMs: number; backstopMs: number;
  clock?: RemoteWakeupClock; createSocket?: SocketFactory;
}

const nativeClock: RemoteWakeupClock = {
  wallNow: Date.now, monotonicNow: () => performance.now(), random: Math.random,
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class RemoteWakeupChannel {
  private readonly clock: RemoteWakeupClock;
  private readonly createSocket: SocketFactory;
  private readonly receipts = new WeakMap<PullWakeupReceipt, ReceiptState>();
  private ws?: RemoteWakeupSocket;
  private keepalive?: RemoteWakeupTimer; private pongDeadline?: RemoteWakeupTimer;
  private cursorTimer?: RemoteWakeupTimer; private backstopTimer?: RemoteWakeupTimer;
  private reconnectTimer?: RemoteWakeupTimer;
  private cursorEpoch = 0;
  private cursorAbort?: AbortController;
  private cursorReply?: (head: number) => void;
  private reconnectAttempt = 0; private generation = 0;
  private pendingCatchUp?: number;
  private ready = false; private quiesced = false;
  private carrier: Carrier = "none";
  private backstopMasked = false;
  private notifyAt?: number; private notifySequence?: number;
  private reconnects = 0; private backstopPulls = 0; private halfOpen = 0;
  private applied = { backstop: 0, cursor: 0, notify: 0 };
  private sampled = { reconnects: 0, backstopPulls: 0, halfOpen: 0 };
  private latency = { count: 0, sum: 0, max: 0 };
  private monotonicLast: number; private windowStarted: number;
  private connectedSince?: number;
  private connectedAccumulated = 0; private lastKeepaliveWrite = 0;

  constructor(private readonly cfg: RemoteWakeupConfig, private readonly port: RemoteWakeupPort) {
    this.clock = cfg.clock ?? nativeClock;
    this.createSocket = cfg.createSocket ?? ((url, headers) => {
      const BunWebSocket = WebSocket as { new (url: string, opts: { headers: Record<string, string> }): WebSocket };
      return new BunWebSocket(url, { headers });
    });
    const start = this.clock.monotonicNow();
    this.monotonicLast = Number.isFinite(start) ? Math.max(0, start) : 0;
    this.windowStarted = this.monotonicLast;
  }

  start(): void {
    this.cfg.activity.ws = this.baseActivity();
    this.port.persistActivity();
  }

  activate(): void {
    if (this.quiesced) return;
    if (!this.cfg.disabled) this.connect();
    this.scheduleBackstop(Math.floor(this.clock.random() * this.cfg.backstopMs));
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    if (!ready) this.invalidateCursor();
    else if (this.ws?.readyState === WebSocket.OPEN) this.resetCursor(this.ws);
  }

  beginPull(): PullWakeupReceipt {
    const notifyPendingAt = this.notifyAt;
    const sequence = this.notifySequence;
    const notifyLatencyMs = notifyPendingAt === undefined ? undefined : Math.min(
      TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.notifyLatencyMaxMs.max,
      Math.max(0, Math.floor(this.clock.wallNow() - notifyPendingAt)),
    );
    this.notifyAt = undefined;
    this.notifySequence = undefined;
    if (notifyLatencyMs !== undefined) {
      this.latency.count = Math.min(Number.MAX_SAFE_INTEGER, this.latency.count + 1);
      this.latency.sum = Math.min(Number.MAX_SAFE_INTEGER, this.latency.sum + notifyLatencyMs);
      this.latency.max = Math.max(this.latency.max, notifyLatencyMs);
      this.port.log(`notify_latency_ms=${notifyLatencyMs}${sequence === undefined ? "" : ` sequence=${sequence}`}`);
      this.port.tracePullDequeue(sequence, notifyLatencyMs);
    }
    const receipt = Object.freeze({ notifyLatencyMs, notifyPendingAt });
    this.receipts.set(receipt, { carrier: this.takeCarrier(), catchUp: this.takeCatchUp() });
    return receipt;
  }

  settlePull(receipt: PullWakeupReceipt, result: { succeeded: boolean; applied: boolean }): void {
    const state = this.receipts.get(receipt);
    if (!state) return;
    this.receipts.delete(receipt);
    if (!result.succeeded && state.catchUp !== undefined) this.pendingCatchUp ??= state.catchUp;
    if (result.succeeded && state.catchUp !== undefined) this.markCaughtUp(state.catchUp);
    if (result.applied && state.carrier !== "none") this.applied[state.carrier]++;
  }

  healthSample(): WsHealthSample {
    const now = this.monotonicNow();
    this.accrueConnected(now);
    const max = TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.windowMs.max;
    const windowMs = Math.min(max, Math.max(0, Math.floor(now - this.windowStarted)));
    const wsConnectedMs = Math.min(windowMs, Math.max(0, Math.floor(this.connectedAccumulated)));
    const sample: WsHealthSample = {
      kind: "ws_health", windowMs, wsConnectedMs,
      wsReconnects: Math.max(0, this.reconnects - this.sampled.reconnects),
      wsHalfOpenDetected: Math.max(0, this.halfOpen - this.sampled.halfOpen),
      backstopAttempts: Math.max(0, this.backstopPulls - this.sampled.backstopPulls),
      backstopAppliedPulls: this.applied.backstop,
      cursorAppliedPulls: this.applied.cursor,
      notifyAppliedPulls: this.applied.notify,
      notifyLatencyCount: this.latency.count,
      notifyLatencySumMs: this.latency.sum,
      notifyLatencyMaxMs: Math.min(max, this.latency.max),
    };
    this.sampled = { reconnects: this.reconnects, backstopPulls: this.backstopPulls, halfOpen: this.halfOpen };
    this.applied = { backstop: 0, cursor: 0, notify: 0 };
    this.latency = { count: 0, sum: 0, max: 0 };
    this.windowStarted = now;
    this.connectedAccumulated = 0;
    return sample;
  }

  /** Synchronous pre-drain edge: fence work and timers, but keep the socket open. */
  quiesce(): void {
    if (this.quiesced) return;
    this.quiesced = true;
    this.ready = false;
    this.invalidateCursor();
    this.stopLiveness();
    this.clearTimer("backstopTimer");
    this.clearTimer("reconnectTimer");
  }

  finalizeStop(): void {
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try { ws.close(); } catch { /* best effort */ }
  }

  private baseActivity(): NonNullable<DaemonActivity["ws"]> {
    return { connected: false, at: new Date(this.clock.wallNow()).toISOString(), caughtUp: false,
      bootId: this.cfg.bootId, pid: process.pid, lastBroadcastSequence: this.cfg.activity.ws?.lastBroadcastSequence };
  }

  private commitActivity(update: Partial<NonNullable<DaemonActivity["ws"]>>): void {
    this.cfg.activity.ws = { ...this.baseActivity(), ...this.cfg.activity.ws, ...update, bootId: this.cfg.bootId, pid: process.pid };
    this.port.persistActivity();
  }

  private connect(): void {
    if (this.quiesced) return;
    let ws: RemoteWakeupSocket;
    try {
      ws = this.createSocket(`${this.cfg.url}?device=${encodeURIComponent(this.cfg.deviceId)}`, { Authorization: `Bearer ${this.cfg.token}` });
    } catch (error) {
      this.port.log(`ws connect failed: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => this.onOpen(ws));
    ws.addEventListener("message", (event) => this.onMessage(String(event.data), ws));
    ws.addEventListener("pong", () => { if (this.ws === ws) this.armPong(ws); });
    ws.addEventListener("close", () => { if (this.disconnect(ws, "close")) this.scheduleReconnect(); });
    ws.addEventListener("error", () => {
      if (!this.disconnect(ws, "error")) return;
      try { ws.close(); } catch { /* close is best effort */ }
      this.scheduleReconnect();
    });
  }

  private onOpen(ws: RemoteWakeupSocket): void {
    if (this.ws !== ws || this.quiesced) return;
    this.reconnectAttempt = 0;
    this.port.log("ws connected");
    this.discardWsCarrier();
    const generation = ++this.generation;
    const now = this.monotonicNow();
    this.accrueConnected(now);
    this.connectedSince = now;
    this.commitActivity({ connected: true, caughtUp: false, at: new Date(this.clock.wallNow()).toISOString() });
    this.startLiveness(ws);
    this.resetCursor(ws);
    this.pendingCatchUp = generation;
    this.port.enqueueKeyDelivery();
    if (this.ready) this.port.requestPull();
    this.scheduleNextBackstop();
  }

  private onMessage(data: string, from: RemoteWakeupSocket): void {
    if (this.quiesced || this.ws !== from) return;
    this.armPong(from);
    if (data === "pong") return this.refreshActivity();
    const key = parseKeyDeliveryNudge(data);
    if (key) { this.port.enqueueKeyDelivery(key); return this.refreshActivity(); }
    if (!this.ready) return;
    try {
      const message = JSON.parse(data) as { type?: string; sequence?: number; head?: number };
      if (message.type === "committed") {
        const sequence = Number.isFinite(message.sequence) ? Number(message.sequence) : -1;
        this.resetCursor(from);
        this.recordCommitted(sequence);
        if (sequence >= 0) this.port.traceCommitted(sequence);
        if (!this.cfg.reliabilityDisabled) {
          this.notifyAt ??= this.clock.wallNow();
          if (sequence >= 0) this.notifySequence = Math.max(this.notifySequence ?? 0, sequence);
        }
        this.wake("notify");
        this.scheduleNextBackstop();
      } else if (Number.isInteger(message.head) && message.head! >= 0 && this.cursorReply) {
        const resolve = this.cursorReply;
        this.cursorReply = undefined;
        resolve(message.head!);
      } else this.refreshActivity();
    } catch { this.refreshActivity(); }
  }

  private recordCommitted(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 0) return this.refreshActivity();
    this.commitActivity({ connected: true, at: new Date(this.clock.wallNow()).toISOString(),
      lastBroadcastSequence: Math.max(this.cfg.activity.ws?.lastBroadcastSequence ?? 0, sequence) });
  }

  private refreshActivity(): void {
    if (!this.cfg.activity.ws?.connected) return;
    const now = this.clock.wallNow();
    this.cfg.activity.ws = { ...this.cfg.activity.ws, at: new Date(now).toISOString(), bootId: this.cfg.bootId, pid: process.pid };
    if (now - this.lastKeepaliveWrite < WS_KEEPALIVE_PERSIST_MS) return;
    this.lastKeepaliveWrite = now;
    this.port.persistActivity();
  }

  private disconnect(ws: RemoteWakeupSocket, reason: "close" | "error" | "timeout"): boolean {
    if (this.ws !== ws) return false;
    this.invalidateCursor();
    this.accrueConnected(this.monotonicNow());
    this.connectedSince = undefined;
    this.ws = undefined;
    this.stopLiveness();
    this.generation++;
    this.discardWsCarrier();
    this.pendingCatchUp = undefined;
    this.commitActivity({ connected: false, caughtUp: false, at: new Date(this.clock.wallNow()).toISOString() });
    this.reconnects++;
    this.port.log(`ws_reconnect reason=${reason} count=${this.reconnects}`);
    if (reason === "error") this.port.log("ws error");
    return true;
  }

  private startLiveness(ws: RemoteWakeupSocket): void {
    this.stopLiveness();
    this.keepalive = this.clock.setInterval(() => {
      if (this.quiesced || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try { ws.send("ping"); } catch { /* close/error drives recovery */ }
    }, WS_PING_MS);
    this.armPong(ws);
  }

  private stopLiveness(): void {
    if (this.keepalive !== undefined) this.clock.clearInterval(this.keepalive);
    this.keepalive = undefined;
    this.clearTimer("pongDeadline");
  }

  private armPong(ws: RemoteWakeupSocket): void {
    if (this.cfg.pongDeadlineMs <= 0 || this.quiesced) return;
    this.clearTimer("pongDeadline");
    this.pongDeadline = this.clock.setTimeout(() => {
      if (this.quiesced || this.ws !== ws) return;
      this.halfOpen++;
      this.port.log(`ws half-open detected — no frame in ${Math.round(this.cfg.pongDeadlineMs / 1000)}s; cycling socket (ws_half_open_detected=${this.halfOpen})`);
      if (!this.disconnect(ws, "timeout")) return;
      try { ws.close(); } catch { /* best effort */ }
      this.scheduleReconnect();
    }, this.cfg.pongDeadlineMs);
    this.unref(this.pongDeadline);
  }

  private resetCursor(ws: RemoteWakeupSocket): void {
    this.invalidateCursor();
    if (this.cfg.cursorCheckMs <= 0 || !this.ready || this.quiesced || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    this.armCursor(ws, this.generation, this.cursorEpoch);
  }

  private invalidateCursor(): void {
    this.cursorEpoch++;
    this.clearTimer("cursorTimer");
    const controller = this.cursorAbort;
    this.cursorAbort = undefined;
    this.cursorReply = undefined;
    controller?.abort(new Error("cursor check invalidated"));
  }

  private armCursor(ws: RemoteWakeupSocket, generation: number, epoch: number): void {
    this.cursorTimer = this.clock.setTimeout(() => {
      this.cursorTimer = undefined;
      void this.runCursor(ws, generation, epoch);
    }, jitter(this.cfg.cursorCheckMs, this.clock.random));
    this.unref(this.cursorTimer);
  }

  private cursorStale(ws: RemoteWakeupSocket, generation: number, epoch: number): boolean {
    return this.quiesced || !this.ready || this.ws !== ws || ws.readyState !== WebSocket.OPEN
      || generation !== this.generation || epoch !== this.cursorEpoch;
  }

  private async runCursor(ws: RemoteWakeupSocket, generation: number, epoch: number): Promise<void> {
    if (this.cursorStale(ws, generation, epoch)) return;
    const controller = new AbortController();
    this.cursorAbort = controller;
    const timeoutMs = Math.min(10_000, Math.max(1, this.cfg.cursorCheckMs - 1));
    let timeout: RemoteWakeupTimer | undefined;
    const reply = new Promise<number>((resolve, reject) => {
      this.cursorReply = resolve;
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      timeout = this.clock.setTimeout(() => controller.abort(new Error(`cursor reply timed out after ${timeoutMs}ms`)), timeoutMs);
      this.unref(timeout);
    });
    try {
      ws.send("cursor");
      const head = await reply;
      if (!this.cursorStale(ws, generation, epoch) && head > this.port.appliedSequence()) this.wake("cursor");
    } catch (error) {
      if (epoch === this.cursorEpoch && !this.quiesced) this.port.log(`ws cursor check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (timeout !== undefined) this.clock.clearTimeout(timeout);
      if (this.cursorAbort === controller) { this.cursorAbort = undefined; this.cursorReply = undefined; }
      if (!this.cursorStale(ws, generation, epoch) && this.cursorTimer === undefined) this.armCursor(ws, generation, epoch);
    }
  }

  private wake(carrier: Carrier): void {
    if (carrier === "backstop") this.backstopMasked = true;
    if (PRECEDENCE[carrier] > PRECEDENCE[this.carrier]) this.carrier = carrier;
    this.port.requestPull();
  }

  private takeCarrier(): Carrier {
    const carrier = this.carrier;
    this.carrier = "none";
    this.backstopMasked = false;
    return carrier;
  }

  private discardWsCarrier(): void {
    if (this.carrier !== "notify" && this.carrier !== "cursor") return;
    this.carrier = this.backstopMasked ? "backstop" : "none";
    this.notifyAt = undefined;
    this.notifySequence = undefined;
  }

  private takeCatchUp(): number | undefined {
    const generation = this.pendingCatchUp;
    this.pendingCatchUp = undefined;
    return generation;
  }

  private markCaughtUp(generation: number): void {
    if (generation !== this.generation || !this.cfg.activity.ws?.connected) return;
    this.commitActivity({ caughtUp: true });
  }

  private scheduleNextBackstop(): void { this.scheduleBackstop(jitter(this.cfg.backstopMs, this.clock.random)); }

  private scheduleBackstop(delayMs: number): void {
    if (this.cfg.backstopMs <= 0 || this.quiesced) return;
    this.clearTimer("backstopTimer");
    this.backstopTimer = this.clock.setTimeout(() => {
      if (this.quiesced) return;
      this.port.enqueueKeyDelivery();
      this.backstopPulls++;
      this.port.log(`ws backstop pull (ws_backstop_pull=${this.backstopPulls})`);
      this.wake("backstop");
      this.scheduleNextBackstop();
    }, delayMs);
    this.unref(this.backstopTimer);
  }

  private scheduleReconnect(): void {
    if (this.quiesced) return;
    const delay = reconnectDelayMs(this.reconnectAttempt, this.clock.random);
    this.reconnectAttempt++;
    this.reconnectTimer = this.clock.setTimeout(() => this.connect(), delay);
  }

  private monotonicNow(): number {
    const raw = this.clock.monotonicNow();
    if (Number.isFinite(raw)) this.monotonicLast = Math.max(this.monotonicLast, raw);
    return this.monotonicLast;
  }

  private accrueConnected(now: number): void {
    if (this.connectedSince === undefined) return;
    this.connectedAccumulated = Math.min(Number.MAX_SAFE_INTEGER, this.connectedAccumulated + Math.max(0, now - this.connectedSince));
    this.connectedSince = now;
  }

  private clearTimer(key: "pongDeadline" | "cursorTimer" | "backstopTimer" | "reconnectTimer"): void {
    const timer = this[key];
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this[key] = undefined;
  }

  private unref(timer: RemoteWakeupTimer | undefined): void {
    (timer as ReturnType<typeof setTimeout> | undefined)?.unref?.();
  }
}
