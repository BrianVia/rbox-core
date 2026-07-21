import { AsyncLocalStorage } from "node:async_hooks";
import type { PhaseName, PhaseReport } from "../engine/index.js";

export interface PushTailDetail {
  chunks: number;
  chunkP95Ms: number;
  payloadBytes: number;
}

type PushTailKind = "missing" | "commit";
interface ChunkTiming { ms: number; payloadBytes: number }

const scope = new AsyncLocalStorage<Record<PushTailKind, ChunkTiming[]>>();
const requestScope = new AsyncLocalStorage<ReadonlySet<PushTailKind>>();

export async function withPushTailTiming<T>(report: PhaseReport, fn: () => Promise<T>): Promise<T> {
  const chunks: Record<PushTailKind, ChunkTiming[]> = { missing: [], commit: [] };
  try {
    return await scope.run(chunks, fn);
  } finally {
    for (const kind of ["missing", "commit"] as const) {
      const values = chunks[kind];
      if (values.length === 0) continue;
      const detail = summarize(values);
      report.appendDetails(kind satisfies PhaseName, { ...detail }, tailSummary(detail));
    }
  }
}

export async function timePushTailRequest<T>(kind: PushTailKind, payloadBytes: number, fn: () => Promise<T>): Promise<T> {
  const active = scope.getStore();
  if (!active) return fn();
  const parents = requestScope.getStore();
  if (parents?.has(kind)) return fn();
  const nested = new Set(parents);
  nested.add(kind);
  const startedAt = performance.now();
  try {
    return await requestScope.run(nested, fn);
  } finally {
    active[kind].push({ ms: Math.max(0, performance.now() - startedAt), payloadBytes: Math.max(0, payloadBytes) });
  }
}

export function missingPayloadBytes(shas: readonly string[]): number {
  return Buffer.byteLength(JSON.stringify({ shas }));
}

export async function timeMissingBlobs<T extends { missingBlobs(shas: string[]): Promise<string[]> }>(api: T, shas: string[]): Promise<string[]> {
  return timePushTailRequest("missing", missingPayloadBytes(shas), () => api.missingBlobs(shas));
}

function summarize(values: readonly ChunkTiming[]): PushTailDetail {
  const sorted = values.map((value) => value.ms).sort((a, b) => a - b);
  const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  return {
    chunks: values.length,
    chunkP95Ms: Math.max(0, Math.round(p95)),
    payloadBytes: values.reduce((sum, value) => sum + value.payloadBytes, 0),
  };
}

function tailSummary(detail: PushTailDetail): string {
  return `chunks=${detail.chunks} chunkP95=${detail.chunkP95Ms}ms payload=${detail.payloadBytes}B`;
}
