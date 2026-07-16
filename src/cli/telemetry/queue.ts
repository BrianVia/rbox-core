import { TELEMETRY_SAMPLE_SCHEMAS, type TelemetryEnvelope, type TelemetrySample } from "./contract.js";

export interface TelemetryTransport {
  postJson(path: string, body: unknown, opts?: { signal?: AbortSignal; retries?: number }): Promise<Response>;
}

export interface TelemetryRecorder {
  record(sample: TelemetrySample): void;
}

type Family = TelemetrySample["kind"];
const enabled = (): boolean => process.env.RBOX_TELEMETRY !== "0";

export class TelemetryQueue implements TelemetryRecorder {
  private readonly safety = new Map<Extract<TelemetrySample, { kind: "safety_event" }>["eventType"], number>();
  private capability?: Extract<TelemetrySample, { kind: "capability" }>;
  private readonly firstPublish: Extract<TelemetrySample, { kind: "first_publish" }>[] = [];
  private readonly uploadLane: Extract<TelemetrySample, { kind: "upload_lane" }>[] = [];
  private readonly propagation: Extract<TelemetrySample, { kind: "propagation" }>[] = [];
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
      && this.uploadLane.length === 0 && this.propagation.length === 0;
  }

  record(sample: TelemetrySample): void {
    if (!enabled()) return;
    try {
      switch (sample.kind) {
        case "safety_event":
          this.safety.set(sample.eventType, (this.safety.get(sample.eventType) ?? 0) + sample.count);
          break;
        case "capability": this.capability = sample; break;
        case "first_publish": this.pushRing(this.firstPublish, sample, 16, sample.kind); break;
        case "upload_lane": this.pushRing(this.uploadLane, sample, 64, sample.kind); break;
        case "propagation": this.pushRing(this.propagation, sample, 64, sample.kind); break;
      }
    } catch { /* telemetry never escapes into sync */ }
  }

  flush(signal?: AbortSignal): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce(signal).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushOnce(signal?: AbortSignal): Promise<void> {
    if (!enabled() || this.empty) return;
    if (this.now() < this.blockedUntil) return;
    const samples: TelemetrySample[] = [];
    for (const [eventType, count] of this.safety) samples.push({
      kind: "safety_event",
      eventType,
      count: Math.min(TELEMETRY_SAMPLE_SCHEMAS.safety_event.numbers.count.max, count),
    });
    if (this.capability) samples.push(this.capability);
    samples.push(...this.firstPublish, ...this.uploadLane, ...this.propagation);
    samples.length = Math.min(samples.length, 64);
    const envelope: TelemetryEnvelope = { v: 1, samples };
    let response: Response;
    try {
      response = await this.transport.postJson("/v1/telemetry", envelope, { retries: 0, ...(signal ? { signal } : {}) });
    } catch { return; }
    if (response.status === 429) { this.blockedUntil = this.now() + 240_000; return; }
    if (response.status !== 202) return;
    this.removeAccepted(samples);
    try {
      const body = await response.json() as { dropped?: unknown };
      if (typeof body.dropped === "number" && body.dropped > 0) this.log(`telemetry server dropped ${body.dropped} sample(s)`);
    } catch { /* response diagnostics are optional */ }
  }

  private removeAccepted(samples: TelemetrySample[]): void {
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
      }
    }
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
