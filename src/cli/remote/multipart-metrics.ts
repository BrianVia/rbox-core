import { metricsEnabled } from "../metrics.js";
import type { JsonValue } from "../../json.js";
import { readNumericFields } from "./timings.js";

export const multipartMetricsEnabled = (): boolean => metricsEnabled();

export interface MultipartServerTimings {
  totalMs: number;
  assembleMs: number;
  rereadPutMs: number;
  accountingMs: number;
}

const SERVER_TIMING_KEYS = ["totalMs", "assembleMs", "rereadPutMs", "accountingMs"] as const;

export function readMultipartServerTimings(value: JsonValue | undefined): MultipartServerTimings | undefined {
  return readNumericFields(value, SERVER_TIMING_KEYS);
}

interface Distribution {
  p50: number;
  p95: number;
  max: number;
  sum: number;
}

export interface MultipartTimings {
  parts: number;
  retries: number;
  reInits: number;
  bytes: number;
  completionWallMs: number;
  partWall: Distribution;
  gap: Distribution;
  server?: MultipartServerTimings;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { p50: 0, p95: 0, max: 0, sum: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentile: number) => sorted[Math.ceil(percentile * sorted.length) - 1]!;
  return {
    p50: rank(0.5),
    p95: rank(0.95),
    max: sorted[sorted.length - 1]!,
    sum: values.reduce((total, value) => total + value, 0),
  };
}

export class MultipartMetrics {
  private readonly partWalls: number[] = [];
  private readonly gaps: number[] = [];
  private parts = 0;
  private retries = 0;
  private reInits = 0;
  private bytes = 0;
  private completionWallMs = 0;
  private server?: MultipartServerTimings;

  constructor(private readonly enabled: boolean, private readonly output: (line: string) => void) {}

  /** Callers use this to skip optional metric-only work (e.g. reading a response body). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  recordPartWall(ms: number): void { if (this.enabled) this.partWalls.push(ms); }
  recordGap(ms: number): void { if (this.enabled) this.gaps.push(ms); }
  addRetries(n: number): void { if (this.enabled) this.retries += n; }
  noteReInit(): void { if (this.enabled) this.reInits++; }
  setBytes(n: number): void { if (this.enabled) this.bytes = n; }
  setParts(n: number): void { if (this.enabled) this.parts = n; }
  recordCompletionWall(ms: number): void { if (this.enabled) this.completionWallMs = ms; }
  setServerTimings(t: MultipartServerTimings | undefined): void { if (this.enabled) this.server = t; }

  toTimings(): MultipartTimings {
    return {
      parts: this.parts,
      retries: this.retries,
      reInits: this.reInits,
      bytes: this.bytes,
      completionWallMs: this.completionWallMs,
      partWall: distribution(this.partWalls),
      gap: distribution(this.gaps),
      ...(this.server ? { server: this.server } : {}),
    };
  }

  summaryLine(): string {
    const t = this.toTimings();
    const server = t.server
      ? ` srv total=${t.server.totalMs} assemble=${t.server.assembleMs} reread=${t.server.rereadPutMs} acct=${t.server.accountingMs}`
      : "";
    return `rbox multipart parts=${t.parts} bytes=${t.bytes} partWall p50=${t.partWall.p50} p95=${t.partWall.p95} max=${t.partWall.max} sum=${t.partWall.sum}ms gap p50=${t.gap.p50} p95=${t.gap.p95} max=${t.gap.max} sum=${t.gap.sum}ms complete=${t.completionWallMs}ms retries=${t.retries} reinit=${t.reInits}${server}`;
  }

  emit(): void {
    if (this.enabled && this.partWalls.length > 0) this.output(this.summaryLine());
  }
}
