/** Never: phase/gap/rendering authority, retry policy, upload scheduling, transport selection, network I/O, or durable transitions. */
import { AsyncLocalStorage } from "node:async_hooks";
import { PhaseReport, type PhaseName } from "../engine/index.js";
import { fillVersion } from "./remote/blob-batch/config.js";
import type { AttestSavedBaseOutcome } from "./sync/base-hash-attestation.js";
import type { LaneTransport, UploadLaneSample } from "./telemetry/contract.js";
import { formatPushSpan } from "./sync/format.js";

export interface FirstPublishStats {
  timeToFilesSyncedMs: number;
  timeToFirstReadyCiphertextMs: number;
  firstReadyToFirstUploadStartMs: number;
  encryptWallMs: number;
  missingCheckWallMs: number;
  uploadCriticalPathMs: number;
  receiptRedemptionWallMs: number;
  commitWallMs: number;
  finalDrainMs: number;
  redeemRequestCount: number;
  redeemReceiptCount: number;
  redeemMaxEntryBytes: number;
  redeemMaxRequestBytes: number;
  finalFlushMs: number;
  receiptRedemptionOverlapMs: number;
  authCallCount: number;
  authCriticalPathMs: number;
  peakTempDiskBytes: number;
  peakQueueHeapBytes: number;
  peakUploaderFramingBytes: number;
  serverUnsatisfiedTotal: number;
  serverSatisfiedSkipped: number;
  uniqueEncryptions: number;
  duplicateEncryptions: number;
  reEncryptedOnResume: number;
  producerCpuSaturationPct: number;
}

export interface FirstPublishTiming {
  enabled: boolean;
  generation: number;
  stats: FirstPublishStats;
  startedAt: number;
  firstReadyAt: number;
  firstUploadAt: number;
  uploadStartedAt: number;
  uploadEndedAt: number;
  uploadActive: number;
  uploadIntervals: Array<{ start: number; end: number }>;
  uploadOpenAt: number;
  tempBytes: number;
  authStartedAt: number;
  authEndedAt: number;
  encryptedAddresses: Set<string>;
  checkedAddresses: Set<string>;
}

const zeroFirstPublishStats = (): FirstPublishStats => ({
  timeToFilesSyncedMs: 0,
  timeToFirstReadyCiphertextMs: 0,
  firstReadyToFirstUploadStartMs: 0,
  encryptWallMs: 0,
  missingCheckWallMs: 0,
  uploadCriticalPathMs: 0,
  receiptRedemptionWallMs: 0,
  commitWallMs: 0,
  finalDrainMs: 0,
  redeemRequestCount: 0,
  redeemReceiptCount: 0,
  redeemMaxEntryBytes: 0,
  redeemMaxRequestBytes: 0,
  finalFlushMs: 0,
  receiptRedemptionOverlapMs: 0,
  authCallCount: 0,
  authCriticalPathMs: 0,
  peakTempDiskBytes: 0,
  peakQueueHeapBytes: 0,
  peakUploaderFramingBytes: 0,
  serverUnsatisfiedTotal: 0,
  serverSatisfiedSkipped: 0,
  uniqueEncryptions: 0,
  duplicateEncryptions: 0,
  reEncryptedOnResume: 0,
  producerCpuSaturationPct: 0,
});

const firstPublishTiming = (): FirstPublishTiming => ({
  enabled: false,
  generation: 0,
  stats: zeroFirstPublishStats(),
  startedAt: 0,
  firstReadyAt: 0,
  firstUploadAt: 0,
  uploadStartedAt: 0,
  uploadEndedAt: 0,
  uploadActive: 0,
  uploadIntervals: [],
  uploadOpenAt: 0,
  tempBytes: 0,
  authStartedAt: 0,
  authEndedAt: 0,
  encryptedAddresses: new Set<string>(),
  checkedAddresses: new Set<string>(),
});

const chunkTimings = (): ChunkTiming[] => [];

type PushTailKind = "missing" | "commit";
interface ChunkTiming { ms: number; payloadBytes: number }
interface LaneTotals { bytes: number; uploadMs: number; opCount: number }
interface PushSpanCarrier {
  owner: PushSpans;
  activeTailKinds: ReadonlySet<PushTailKind>;
}

type PushDetailName =
  | "ack_ms"
  | "delta_base_ms"
  | "drain_wait_ms"
  | "matcher_ms"
  | "projection_casefold_ms"
  | "projection_diff_ms"
  | "projection_ignore_carry_ms"
  | "projection_ms"
  | "projection_sort_ms"
  | "publish_transition_ms"
  | "state_lineage_ms";

const detailPhase = {
  ack_ms: "state-save",
  delta_base_ms: "commit",
  drain_wait_ms: "state-load",
  matcher_ms: "git-plan",
  projection_casefold_ms: "git-plan",
  projection_diff_ms: "git-plan",
  projection_ignore_carry_ms: "git-plan",
  projection_ms: "git-plan",
  projection_sort_ms: "git-plan",
  publish_transition_ms: "state-save",
  state_lineage_ms: "git-plan",
} satisfies Record<PushDetailName, PhaseName>;

const scope = new AsyncLocalStorage<PushSpanCarrier>();

export class PushSpans {
  readonly firstPublish = firstPublishTiming();
  private readonly lanes = new Map<LaneTransport, LaneTotals>();
  private readonly tails = { missing: chunkTimings(), commit: chunkTimings() } satisfies Record<PushTailKind, ChunkTiming[]>;
  private readonly measurements = new Map<PushDetailName, number>();
  private stateSaveWallMs = 0;
  private baseAttestation: { hit: boolean; outcome: AttestSavedBaseOutcome | "skipped" } | undefined;

  constructor(
    readonly report: PhaseReport,
    private readonly onLaneSamples: (samples: UploadLaneSample[]) => void = () => {},
  ) {}

  static from(deps: {
    report?: PhaseReport;
    telemetry?: { record(sample: UploadLaneSample): void };
  }): PushSpans {
    return new PushSpans(
      deps.report ?? PhaseReport.disabled("push"),
      (samples) => { for (const sample of samples) deps.telemetry?.record(sample); },
    );
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await scope.run({ owner: this, activeTailKinds: new Set() }, fn);
    } finally {
      if (this.baseAttestation) {
        const value = `${this.baseAttestation.hit ? "hit" : "miss"}/${this.baseAttestation.outcome}`;
        this.report.appendDetails("commit", { attest: value }, `attest=${value}`);
      }
      this.finishLanes();
      this.finishTails();
    }
  }

  span<T>(name: PhaseName, fn: () => Promise<T>): Promise<T>;
  span<T>(name: PushDetailName, fn: () => T): T;
  span<T>(name: PhaseName | PushDetailName, fn: () => T | Promise<T>): T | Promise<T> {
    if (name === "ack_ms") return this.acknowledgement(fn as () => Promise<T>);
    if (name in detailPhase) return this.detailSpan(name as PushDetailName, fn);
    if (name === "state-save") {
      const startedAt = performance.now();
      return this.report.phase(name, fn as () => Promise<T>).finally(() => {
        this.stateSaveWallMs += performance.now() - startedAt;
      });
    }
    if (name === "commit") return this.commitSpan(fn as () => Promise<T>);
    return this.report.phase(name as PhaseName, fn as () => Promise<T>);
  }

  note(name: PushDetailName, value?: number): void {
    const measured = value ?? this.measurements.get(name);
    if (measured === undefined) return;
    this.measurements.delete(name);
    const phase = detailPhase[name];
    this.report.appendDetails(phase, { [name]: measured }, formatPushSpan(name, measured));
  }

  noteAttestation(hit: boolean, outcome: AttestSavedBaseOutcome | "skipped" = "skipped"): void {
    this.baseAttestation = { hit, outcome };
  }

  private async acknowledgement<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.report.enabled) return fn();
    const startedAt = performance.now();
    const stateSaveBefore = this.stateSaveWallMs;
    try {
      return await fn();
    } finally {
      this.note("ack_ms", Math.max(0, performance.now() - startedAt - (this.stateSaveWallMs - stateSaveBefore)));
    }
  }

  recordLane(transport: LaneTransport, bytes: number, uploadMs: number): void {
    const current = this.lanes.get(transport) ?? { bytes: 0, uploadMs: 0, opCount: 0 };
    current.bytes += Math.max(0, Math.round(bytes));
    current.uploadMs += Math.max(0, uploadMs);
    current.opCount++;
    this.lanes.set(transport, current);
  }

  recordTail(kind: PushTailKind, ms: number, payloadBytes: number): void {
    this.tails[kind].push({ ms: Math.max(0, ms), payloadBytes: Math.max(0, payloadBytes) });
  }

  private detailSpan<T>(name: PushDetailName, fn: () => T | Promise<T>): T | Promise<T> {
    if (!this.report.enabled) return fn();
    const startedAt = performance.now();
    const settle = () => { this.measurements.set(name, performance.now() - startedAt); };
    const result = fn();
    if (result instanceof Promise) return result.then((value) => { settle(); return value; });
    settle();
    return result;
  }

  private async commitSpan<T>(fn: () => Promise<T>): Promise<T> {
    const generation = this.firstPublish.enabled ? this.firstPublish.generation : 0;
    const startedAt = generation ? performance.now() : 0;
    const redemptionBefore = this.firstPublish.stats.receiptRedemptionWallMs;
    try {
      return await this.report.phase("commit", fn);
    } finally {
      if (generation !== 0 && this.firstPublish.enabled && this.firstPublish.generation === generation) {
        const redemptionDuring = this.firstPublish.stats.receiptRedemptionWallMs - redemptionBefore;
        this.firstPublish.stats.commitWallMs += Math.max(0, Math.round(performance.now() - startedAt) - redemptionDuring);
      }
    }
  }

  private finishLanes(): void {
    const fill = fillVersion();
    try {
      this.onLaneSamples([...this.lanes]
        .filter(([, value]) => value.opCount > 0)
        .map(([transport, value]) => ({
          kind: "upload_lane" as const,
          transport,
          fillVersion: fill,
          bytes: value.bytes,
          uploadMs: Math.max(0, Math.round(value.uploadMs)),
          opCount: value.opCount,
        })));
    } catch {
      // Telemetry completion must not replace the push result or error.
    }
  }

  private finishTails(): void {
    for (const kind of ["missing", "commit"] as const) {
      const values = this.tails[kind];
      if (values.length === 0) continue;
      const sorted = values.map((value) => value.ms).sort((a, b) => a - b);
      const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
      const detail = {
        chunks: values.length,
        chunkP95Ms: Math.max(0, Math.round(p95)),
        payloadBytes: values.reduce((sum, value) => sum + value.payloadBytes, 0),
      };
      this.report.appendDetails(
        kind satisfies PhaseName,
        { ...detail },
        `chunks=${detail.chunks} chunkP95=${detail.chunkP95Ms}ms payload=${detail.payloadBytes}B`,
      );
    }
  }
}

export function currentPushSpans(): PushSpans | undefined {
  return scope.getStore()?.owner;
}

export function currentFirstPublishTiming(): FirstPublishTiming | undefined {
  return currentPushSpans()?.firstPublish;
}

const inactiveFirstPublishTiming = firstPublishTiming();
/** Compatibility view for leaf instrumentation. Mutable state always resolves to
 * the active PushSpans field; outside a push the disabled target is inert. */
export const firstPublishTimingView: FirstPublishTiming = new Proxy(inactiveFirstPublishTiming, {
  get(target, property, receiver) {
    return Reflect.get(currentFirstPublishTiming() ?? target, property, receiver);
  },
  set(target, property, value, receiver) {
    const timing = currentFirstPublishTiming();
    return timing ? Reflect.set(timing, property, value, timing) : true;
  },
});

export function recordLaneSettlement(transport: LaneTransport, bytes: number, uploadMs: number): void {
  currentPushSpans()?.recordLane(transport, bytes, uploadMs);
}

export async function timePushTailRequest<T>(kind: PushTailKind, payloadBytes: number, fn: () => Promise<T>): Promise<T> {
  const carrier = scope.getStore();
  if (!carrier || carrier.activeTailKinds.has(kind)) return fn();
  const activeTailKinds = new Set(carrier.activeTailKinds);
  activeTailKinds.add(kind);
  const startedAt = performance.now();
  try {
    return await scope.run({ owner: carrier.owner, activeTailKinds }, fn);
  } finally {
    carrier.owner.recordTail(kind, performance.now() - startedAt, payloadBytes);
  }
}

export function missingPayloadBytes(shas: readonly string[]): number {
  return Buffer.byteLength(JSON.stringify({ shas }));
}

export async function timeMissingBlobs<T extends { missingBlobs(shas: string[]): Promise<string[]> }>(api: T, shas: string[]): Promise<string[]> {
  return timePushTailRequest("missing", missingPayloadBytes(shas), () => api.missingBlobs(shas));
}

/** Focused harnesses use the same owner as production while observing one sink. */
export function withPushLaneAccumulator<T>(fn: () => Promise<T>, onComplete: (samples: UploadLaneSample[]) => void): Promise<T> {
  return new PushSpans(PhaseReport.disabled("push"), onComplete).run(fn);
}

export function withPushTailTiming<T>(report: PhaseReport, fn: () => Promise<T>): Promise<T> {
  return new PushSpans(report).run(fn);
}

export function enterPushSpansForTest(report: PhaseReport = PhaseReport.disabled("push")): PushSpans {
  const owner = new PushSpans(report);
  scope.enterWith({ owner, activeTailKinds: new Set() });
  return owner;
}
