import { AsyncLocalStorage } from "node:async_hooks";
import { fillVersion } from "../remote/blob-batch/config.js";
import type { LaneTransport, UploadLaneSample } from "./contract.js";

interface LaneTotals { bytes: number; uploadMs: number; opCount: number }
const scope = new AsyncLocalStorage<Map<LaneTransport, LaneTotals>>();

export async function withPushLaneAccumulator<T>(fn: () => Promise<T>, onComplete: (samples: UploadLaneSample[]) => void): Promise<T> {
  const totals = new Map<LaneTransport, LaneTotals>();
  try {
    return await scope.run(totals, fn);
  } finally {
    const fill = fillVersion();
    try {
      onComplete([...totals].filter(([, value]) => value.opCount > 0).map(([transport, value]) => ({
        kind: "upload_lane" as const,
        transport,
        fillVersion: fill,
        bytes: value.bytes,
        uploadMs: Math.max(0, Math.round(value.uploadMs)),
        opCount: value.opCount,
      })));
    } catch { /* telemetry completion must not replace the push result/error */ }
  }
}

export function recordLaneSettlement(transport: LaneTransport, bytes: number, uploadMs: number): void {
  const totals = scope.getStore();
  if (!totals) return;
  const current = totals.get(transport) ?? { bytes: 0, uploadMs: 0, opCount: 0 };
  current.bytes += Math.max(0, Math.round(bytes));
  current.uploadMs += Math.max(0, uploadMs);
  current.opCount++;
  totals.set(transport, current);
}
