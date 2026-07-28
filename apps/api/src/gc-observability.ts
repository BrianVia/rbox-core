import type { Env } from "./env.js";
import { logErr } from "./util.js";
import { startOp } from "./metrics.js";
import { readState } from "./gc-state.js";

export type GcObservationOutcome =
  | "success"
  | "roots_budget_exceeded"
  | "roots_cap_exceeded"
  | "zero_chunk"
  | "lease_busy"
  | "lease_lost"
  | "internal_500"
  | "thrown";

export type GcObservationStage =
  | "count"
  | "snapshot"
  | "reachability"
  | "state_read"
  | "list"
  | "candidate_write"
  | "state_write"
  | "lease"
  | "execute"
  | "intent"
  | "release";

export interface GcRootsSampleV1 {
  value: number;
  measuredAt: string;
  lowerBound?: true;
}

export interface GcObservationV1 {
  v: 1;
  at: string;
  outcome: GcObservationOutcome;
  stage?: GcObservationStage;
  status?: number;
  rows?: number;
  marked?: number;
  purged?: number;
  opened?: number;
  errorClass?: string;
  rootsSample: GcRootsSampleV1 | null;
}

const GC_OBSERVATION_KEYS = ["gc_obs_mark", "gc_obs_purge"] as const;
export type GcObservationKey = (typeof GC_OBSERVATION_KEYS)[number];
const GC_OUTCOMES = new Set<GcObservationOutcome>([
  "success", "roots_budget_exceeded", "roots_cap_exceeded", "zero_chunk",
  "lease_busy", "lease_lost", "internal_500", "thrown",
]);
const GC_STAGES = new Set<GcObservationStage>([
  "count", "snapshot", "reachability", "state_read", "list", "candidate_write",
  "state_write", "lease", "execute", "intent", "release",
]);

function isFixedIso(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseGcObservation(value: unknown): GcObservationV1 | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.v !== 1 || !isFixedIso(o.at) || !GC_OUTCOMES.has(o.outcome as GcObservationOutcome)) return null;
  if (o.stage !== undefined && !GC_STAGES.has(o.stage as GcObservationStage)) return null;
  for (const field of ["status", "rows", "marked", "purged", "opened"] as const) {
    if (o[field] !== undefined && (!Number.isFinite(o[field]) || Number(o[field]) < 0)) return null;
  }
  if (o.errorClass !== undefined && typeof o.errorClass !== "string") return null;
  if (o.rootsSample !== null) {
    if (!o.rootsSample || typeof o.rootsSample !== "object") return null;
    const sample = o.rootsSample as Record<string, unknown>;
    if (!Number.isFinite(sample.value) || Number(sample.value) < 0 || !isFixedIso(sample.measuredAt)) return null;
    if (sample.lowerBound !== undefined && sample.lowerBound !== true) return null;
  }
  return value as GcObservationV1;
}

const GC_OBSERVATION_UPSERT = `
INSERT INTO gc_state (k, v)
VALUES (?1, json(?2))
ON CONFLICT(k) DO UPDATE SET v = json_set(
  CASE
    WHEN json_extract(excluded.v, '$.at') > json_extract(gc_state.v, '$.at')
      OR (
        json_extract(excluded.v, '$.at') = json_extract(gc_state.v, '$.at')
        AND json_extract(excluded.v, '$.outcome') = 'roots_cap_exceeded'
        AND json_extract(gc_state.v, '$.outcome') <> 'roots_cap_exceeded'
      )
    THEN excluded.v
    ELSE gc_state.v
  END,
  '$.rootsSample',
  json(CASE
    WHEN json_type(excluded.v, '$.rootsSample') = 'object'
      AND (
        json_type(gc_state.v, '$.rootsSample') <> 'object'
        OR json_extract(excluded.v, '$.rootsSample.measuredAt')
             > json_extract(gc_state.v, '$.rootsSample.measuredAt')
        OR (
          json_extract(excluded.v, '$.rootsSample.measuredAt')
            = json_extract(gc_state.v, '$.rootsSample.measuredAt')
          AND COALESCE(json_extract(excluded.v, '$.rootsSample.lowerBound'), 0) <> 1
          AND COALESCE(json_extract(gc_state.v, '$.rootsSample.lowerBound'), 0) = 1
        )
      )
    THEN json_extract(excluded.v, '$.rootsSample')
    ELSE json_extract(gc_state.v, '$.rootsSample')
  END)
)
WHERE
  json_extract(excluded.v, '$.at') > json_extract(gc_state.v, '$.at')
  OR (
    json_extract(excluded.v, '$.at') = json_extract(gc_state.v, '$.at')
    AND json_extract(excluded.v, '$.outcome') = 'roots_cap_exceeded'
    AND json_extract(gc_state.v, '$.outcome') <> 'roots_cap_exceeded'
  )
  OR (
    json_type(excluded.v, '$.rootsSample') = 'object'
    AND (
      json_type(gc_state.v, '$.rootsSample') <> 'object'
      OR json_extract(excluded.v, '$.rootsSample.measuredAt')
           > json_extract(gc_state.v, '$.rootsSample.measuredAt')
      OR (
        json_extract(excluded.v, '$.rootsSample.measuredAt')
          = json_extract(gc_state.v, '$.rootsSample.measuredAt')
        AND COALESCE(json_extract(excluded.v, '$.rootsSample.lowerBound'), 0) <> 1
        AND COALESCE(json_extract(gc_state.v, '$.rootsSample.lowerBound'), 0) = 1
      )
    )
  );`;

/** Best-effort, single-statement monotonic observation write. */
export async function writeGcObservation(db: D1Database, key: GcObservationKey, observation: GcObservationV1): Promise<void> {
  try {
    if (!GC_OBSERVATION_KEYS.includes(key) || !parseGcObservation(observation)) throw new TypeError("invalid GC observation");
    await db.prepare(GC_OBSERVATION_UPSERT).bind(key, JSON.stringify(observation)).run();
  } catch (e) {
    logErr("gc_observation_write_failed", e);
  }
}

export function terminalObservation(
  outcome: GcObservationOutcome,
  rootsSample: GcRootsSampleV1 | null,
  fields: Omit<Partial<GcObservationV1>, "v" | "at" | "outcome" | "rootsSample"> = {},
): GcObservationV1 {
  return { v: 1, at: new Date().toISOString(), outcome, ...fields, rootsSample };
}

export function metric(env: Env, name: string, count = 0, bytes = 0, outcome = "ok"): void {
  const op = startOp(env, name);
  op.done(outcome, { count, bytes });
}

export async function readGcObservation(db: D1Database, key: GcObservationKey): Promise<GcObservationV1 | null> {
  const raw = await readState<unknown>(db, key);
  return parseGcObservation(raw);
}
