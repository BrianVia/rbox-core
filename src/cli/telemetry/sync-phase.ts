import type { PhaseReport, PhaseReportJson } from "../../engine/index.js";
import {
  SYNC_PHASE_NAMES,
  TELEMETRY_SAMPLE_SCHEMAS,
  type SyncPhaseSample,
} from "./contract.js";
import type { TelemetryRecorder } from "./queue.js";

export const SYNC_PHASE_SAMPLE_EVERY = 8;
export const SYNC_PHASE_OUTLIER_MS = { pull: 20_000, push: 15_000 } as const;

function boundedInteger(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value)));
}

function gitApplyDetails(json: PhaseReportJson): Pick<SyncPhaseSample, "gitApplyMaxRepoMs" | "gitApplySkippedHeld"> {
  const detail = json.phases["git-apply"]?.details?.gitApply;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return {};
  const record = detail as Record<string, unknown>;
  const out: Pick<SyncPhaseSample, "gitApplyMaxRepoMs" | "gitApplySkippedHeld"> = {};
  if (Array.isArray(record.repoTimings)) {
    const walls = record.repoTimings.flatMap((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const wallMs = (entry as Record<string, unknown>).wallMs;
      return typeof wallMs === "number" && Number.isFinite(wallMs) && wallMs >= 0 ? [wallMs] : [];
    });
    if (walls.length > 0) out.gitApplyMaxRepoMs = boundedInteger(
      Math.max(...walls),
      TELEMETRY_SAMPLE_SCHEMAS.sync_phase.optionalNumbers.gitApplyMaxRepoMs.max,
    );
  }
  const results = record.results;
  if (results !== null && typeof results === "object" && !Array.isArray(results)) {
    const skipped = (results as Record<string, unknown>).skipped;
    if (typeof skipped === "number" && Number.isFinite(skipped) && skipped >= 0) {
      out.gitApplySkippedHeld = boundedInteger(
        skipped,
        TELEMETRY_SAMPLE_SCHEMAS.sync_phase.optionalNumbers.gitApplySkippedHeld.max,
      );
    }
  }
  return out;
}

/** Per-daemon sampler. Pull and push ordinals stay independent to avoid cadence bias. */
export class SyncPhaseSampler {
  private readonly completed = { pull: 0, push: 0 };

  recordCompleted(report: PhaseReport, op: "pull" | "push", telemetry: TelemetryRecorder): void {
    try {
      const json = report.toJSON();
      if (json.op !== op) return;
      this.completed[op]++;
      if (this.completed[op] % SYNC_PHASE_SAMPLE_EVERY !== 0 && json.wallMs <= SYNC_PHASE_OUTLIER_MS[op]) return;
      const phases: Record<string, number> = {};
      for (const name of SYNC_PHASE_NAMES) {
        const ms = json.phases[name]?.ms;
        if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
          phases[name] = boundedInteger(ms, TELEMETRY_SAMPLE_SCHEMAS.sync_phase.numericRecords.phases.domain.max);
        }
      }
      telemetry.record({
        kind: "sync_phase",
        op,
        wallMs: boundedInteger(json.wallMs, TELEMETRY_SAMPLE_SCHEMAS.sync_phase.numbers.wallMs.max),
        phases,
        ...gitApplyDetails(json),
      });
    } catch {
      // Product telemetry cannot replace or fail a completed sync operation.
    }
  }
}
