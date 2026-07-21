import {
  TELEMETRY_BATCH_CAP,
  TELEMETRY_SAMPLE_SCHEMAS,
  telemetryEnabled,
  type GitCaptureSample,
  type TelemetryEnvelope,
  type TelemetrySample,
  type WsHealthSample,
} from "./contract.js";

export interface TelemetryTransport {
  postJson(path: string, body: unknown, opts?: { signal?: AbortSignal; retries?: number }): Promise<Response>;
}

export interface TelemetryRecorder {
  record(sample: TelemetrySample): void;
}

type Family = TelemetrySample["kind"];
type GitCaptureAdditive = Omit<GitCaptureSample, "kind">;
interface GitCaptureSnapshot {
  readonly sample: GitCaptureSample;
  readonly records: number;
}
type WsHealthAdditive = Omit<WsHealthSample, "kind" | "notifyLatencyMaxMs">;
interface WsHealthSnapshot {
  readonly sample: WsHealthSample;
  readonly records: number;
  readonly frozenMax: number;
}

const emptyWsHealthAdditive = (): WsHealthAdditive => ({
  windowMs: 0,
  wsConnectedMs: 0,
  wsReconnects: 0,
  wsHalfOpenDetected: 0,
  backstopAttempts: 0,
  backstopAppliedPulls: 0,
  cursorAppliedPulls: 0,
  notifyAppliedPulls: 0,
  notifyLatencyCount: 0,
  notifyLatencySumMs: 0,
});

const emptyGitCaptureAdditive = (): GitCaptureAdditive => ({
  signalPushes: 0,
  candidatePushes: 0,
  scanPushes: 0,
});

export class TelemetryQueue implements TelemetryRecorder {
  private readonly safety = new Map<Extract<TelemetrySample, { kind: "safety_event" }>["eventType"], number>();
  private capability?: Extract<TelemetrySample, { kind: "capability" }>;
  private readonly firstPublish: Extract<TelemetrySample, { kind: "first_publish" }>[] = [];
  private readonly uploadLane: Extract<TelemetrySample, { kind: "upload_lane" }>[] = [];
  private readonly propagation: Extract<TelemetrySample, { kind: "propagation" }>[] = [];
  private readonly gitCapture = emptyGitCaptureAdditive();
  private gitCapturePendingRecords = 0;
  private readonly wsHealth = emptyWsHealthAdditive();
  private wsHealthLiveMax = 0;
  private wsHealthPendingRecords = 0;
  private blockedUntil = 0;
  private flushing?: Promise<void>;
  private readonly dropCounts = new Map<Family, number>();

  constructor(
    private readonly transport: TelemetryTransport,
    private readonly log: (line: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  get empty(): boolean {
    return this.safety.size === 0 && !this.capability && this.firstPublish.length === 0
      && this.uploadLane.length === 0 && this.propagation.length === 0
      && this.gitCapturePendingRecords === 0
      && this.wsHealthPendingRecords === 0;
  }

  record(sample: TelemetrySample): void {
    if (!telemetryEnabled()) return;
    try {
      switch (sample.kind) {
        case "safety_event":
          this.safety.set(sample.eventType, (this.safety.get(sample.eventType) ?? 0) + sample.count);
          break;
        case "capability": this.capability = sample; break;
        case "first_publish": this.pushRing(this.firstPublish, sample, 16, sample.kind); break;
        case "upload_lane": this.pushRing(this.uploadLane, sample, 64, sample.kind); break;
        case "propagation": this.pushRing(this.propagation, sample, 64, sample.kind); break;
        case "git_capture":
          this.addGitCapture(sample);
          break;
        case "ws_health":
          this.addWsHealth(sample);
          break;
      }
    } catch { /* telemetry never escapes into sync */ }
  }

  flush(signal?: AbortSignal): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce(signal).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushOnce(signal?: AbortSignal): Promise<void> {
    if (!telemetryEnabled() || this.empty) return;
    if (this.now() < this.blockedUntil) return;
    const samples: TelemetrySample[] = [];
    const wsHealthSnapshot = this.wsHealthPendingRecords > 0 ? this.snapshotWsHealth() : undefined;
    if (wsHealthSnapshot) samples.push(wsHealthSnapshot.sample); // highest priority: never truncated by the batch cap
    const gitCaptureSnapshot = this.gitCapturePendingRecords > 0 ? this.snapshotGitCapture() : undefined;
    if (gitCaptureSnapshot) samples.push(gitCaptureSnapshot.sample); // additive control-plane counters are also cap-proof
    for (const [eventType, count] of this.safety) samples.push({
      kind: "safety_event",
      eventType,
      count: Math.min(TELEMETRY_SAMPLE_SCHEMAS.safety_event.numbers.count.max, count),
    });
    if (this.capability) samples.push(this.capability);
    samples.push(...this.firstPublish, ...this.uploadLane, ...this.propagation);
    samples.length = Math.min(samples.length, TELEMETRY_BATCH_CAP);
    const envelope: TelemetryEnvelope = { v: 1, samples };
    let response: Response;
    try {
      response = await this.transport.postJson("/v1/telemetry", envelope, { retries: 0, ...(signal ? { signal } : {}) });
    } catch {
      this.restoreWsHealthMax(wsHealthSnapshot);
      return;
    }
    if (response.status === 429) {
      this.restoreWsHealthMax(wsHealthSnapshot);
      this.blockedUntil = this.now() + 240_000;
      return;
    }
    if (response.status >= 400 && response.status <= 499) {
      this.removeAccepted(samples, wsHealthSnapshot, gitCaptureSnapshot);
      try { this.log(`telemetry discarded ${samples.length} sample(s) rejected with HTTP ${response.status}`); } catch {}
      return;
    }
    if (response.status !== 202) {
      this.restoreWsHealthMax(wsHealthSnapshot);
      return;
    }
    this.removeAccepted(samples, wsHealthSnapshot, gitCaptureSnapshot);
    try {
      const body = await response.json() as { dropped?: unknown };
      if (typeof body.dropped === "number" && body.dropped > 0) this.log(`telemetry server dropped ${body.dropped} sample(s)`);
    } catch { /* response diagnostics are optional */ }
  }

  private removeAccepted(
    samples: TelemetrySample[],
    wsHealthSnapshot?: WsHealthSnapshot,
    gitCaptureSnapshot?: GitCaptureSnapshot,
  ): void {
    for (const sample of samples) {
      switch (sample.kind) {
        case "safety_event": {
          const current = this.safety.get(sample.eventType) ?? 0;
          if (current <= sample.count) this.safety.delete(sample.eventType);
          else this.safety.set(sample.eventType, current - sample.count);
          break;
        }
        case "capability": if (this.capability === sample) this.capability = undefined; break;
        case "first_publish": this.removeIdentity(this.firstPublish, sample); break;
        case "upload_lane": this.removeIdentity(this.uploadLane, sample); break;
        case "propagation": this.removeIdentity(this.propagation, sample); break;
        case "git_capture":
          if (gitCaptureSnapshot) this.removeGitCaptureSnapshot(gitCaptureSnapshot);
          break;
        case "ws_health":
          if (wsHealthSnapshot) this.removeWsHealthSnapshot(wsHealthSnapshot);
          break;
      }
    }
  }

  private addGitCapture(sample: GitCaptureSample): void {
    for (const field of Object.keys(this.gitCapture) as (keyof GitCaptureAdditive)[]) {
      this.gitCapture[field] = Math.min(Number.MAX_SAFE_INTEGER, this.gitCapture[field] + sample[field]);
    }
    this.gitCapturePendingRecords = Math.min(Number.MAX_SAFE_INTEGER, this.gitCapturePendingRecords + 1);
  }

  private snapshotGitCapture(): GitCaptureSnapshot {
    const numbers = TELEMETRY_SAMPLE_SCHEMAS.git_capture.numbers;
    return {
      sample: {
        kind: "git_capture",
        signalPushes: Math.min(numbers.signalPushes.max, this.gitCapture.signalPushes),
        candidatePushes: Math.min(numbers.candidatePushes.max, this.gitCapture.candidatePushes),
        scanPushes: Math.min(numbers.scanPushes.max, this.gitCapture.scanPushes),
      },
      records: this.gitCapturePendingRecords,
    };
  }

  private removeGitCaptureSnapshot(snapshot: GitCaptureSnapshot): void {
    const { sample } = snapshot;
    this.gitCapture.signalPushes = Math.max(0, this.gitCapture.signalPushes - sample.signalPushes);
    this.gitCapture.candidatePushes = Math.max(0, this.gitCapture.candidatePushes - sample.candidatePushes);
    this.gitCapture.scanPushes = Math.max(0, this.gitCapture.scanPushes - sample.scanPushes);
    this.gitCapturePendingRecords = Math.max(0, this.gitCapturePendingRecords - snapshot.records);
    if (this.gitCapturePendingRecords === 0
      && Object.values(this.gitCapture).some((value) => value > 0)) this.gitCapturePendingRecords = 1;
  }

  private addWsHealth(sample: WsHealthSample): void {
    for (const field of Object.keys(this.wsHealth) as (keyof WsHealthAdditive)[]) {
      this.wsHealth[field] = Math.min(Number.MAX_SAFE_INTEGER, this.wsHealth[field] + sample[field]);
    }
    this.wsHealthLiveMax = Math.max(this.wsHealthLiveMax, sample.notifyLatencyMaxMs);
    this.wsHealthPendingRecords = Math.min(Number.MAX_SAFE_INTEGER, this.wsHealthPendingRecords + 1);
  }

  private snapshotWsHealth(): WsHealthSnapshot {
    const numbers = TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers;
    const frozenMax = Math.min(numbers.notifyLatencyMaxMs.max, this.wsHealthLiveMax);
    this.wsHealthLiveMax = 0;
    return {
      sample: {
        kind: "ws_health",
        windowMs: Math.min(numbers.windowMs.max, this.wsHealth.windowMs),
        wsConnectedMs: Math.min(numbers.wsConnectedMs.max, this.wsHealth.wsConnectedMs),
        wsReconnects: Math.min(numbers.wsReconnects.max, this.wsHealth.wsReconnects),
        wsHalfOpenDetected: Math.min(numbers.wsHalfOpenDetected.max, this.wsHealth.wsHalfOpenDetected),
        backstopAttempts: Math.min(numbers.backstopAttempts.max, this.wsHealth.backstopAttempts),
        backstopAppliedPulls: Math.min(numbers.backstopAppliedPulls.max, this.wsHealth.backstopAppliedPulls),
        cursorAppliedPulls: Math.min(numbers.cursorAppliedPulls.max, this.wsHealth.cursorAppliedPulls),
        notifyAppliedPulls: Math.min(numbers.notifyAppliedPulls.max, this.wsHealth.notifyAppliedPulls),
        notifyLatencyCount: Math.min(numbers.notifyLatencyCount.max, this.wsHealth.notifyLatencyCount),
        notifyLatencySumMs: Math.min(numbers.notifyLatencySumMs.max, this.wsHealth.notifyLatencySumMs),
        notifyLatencyMaxMs: frozenMax,
      },
      records: this.wsHealthPendingRecords,
      frozenMax,
    };
  }

  private restoreWsHealthMax(snapshot?: WsHealthSnapshot): void {
    if (snapshot) this.wsHealthLiveMax = Math.max(this.wsHealthLiveMax, snapshot.frozenMax);
  }

  private removeWsHealthSnapshot(snapshot: WsHealthSnapshot): void {
    const { sample } = snapshot;
    for (const field of Object.keys(this.wsHealth) as (keyof WsHealthAdditive)[]) {
      this.wsHealth[field] = Math.max(0, this.wsHealth[field] - sample[field]);
    }
    this.wsHealthPendingRecords = Math.max(0, this.wsHealthPendingRecords - snapshot.records);
    // A long outage can accumulate more than one wire-domain maximum. Keep a
    // presence token until the capped residual drains over later batches.
    if (this.wsHealthPendingRecords === 0
      && Object.values(this.wsHealth).some((value) => value > 0)) this.wsHealthPendingRecords = 1;
  }

  private removeIdentity<T>(ring: T[], item: T): void {
    const index = ring.indexOf(item);
    if (index >= 0) ring.splice(index, 1);
  }

  private pushRing<T>(ring: T[], sample: T, cap: number, family: Family): void {
    if (ring.length === cap) {
      ring.shift();
      const count = (this.dropCounts.get(family) ?? 0) + 1;
      this.dropCounts.set(family, count);
      if ((count & (count - 1)) === 0) {
        try { this.log(`telemetry ${family} queue dropped ${count} old sample(s)`); } catch {}
      }
    }
    ring.push(sample);
  }
}
