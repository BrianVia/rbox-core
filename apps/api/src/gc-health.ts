/** Never: candidate mutation, leases, root traversal, or scheduling. */
import type { Env } from "./env.js";
import { json, logErr } from "./util.js";
import { dbFor } from "./db.js";
import { MAX_UNIQUE_ROOTS, exactWorkspaceCount } from "./gc-roots.js";
import { readGcObservation, type GcObservationV1, type GcRootsSampleV1 } from "./gc-observability.js";

export const GC_WARN_UNIQUE_ROOTS = 562_500;

export interface GcHealthV1 {
  ok: true;
  rows: number;
  uniqueRoots: (GcRootsSampleV1 & { stale: true }) | null;
  maxRoots: 750_000;
  mark: GcObservationV1 | null;
  purge: GcObservationV1 | null;
  warn: boolean;
}

function newerRootsSample(a: GcRootsSampleV1 | null, b: GcRootsSampleV1 | null): GcRootsSampleV1 | null {
  if (!a) return b;
  if (!b) return a;
  if (b.measuredAt > a.measuredAt) return b;
  if (b.measuredAt < a.measuredAt) return a;
  return a.lowerBound === true && b.lowerBound !== true ? b : a;
}

export async function gcHealthData(env: Env): Promise<GcHealthV1> {
  const db = dbFor(env, "");
  const [rows, mark, purge] = await Promise.all([
    exactWorkspaceCount(env),
    readGcObservation(db, "gc_obs_mark"),
    readGcObservation(db, "gc_obs_purge"),
  ]);
  const selected = newerRootsSample(mark?.rootsSample ?? null, purge?.rootsSample ?? null);
  const uniqueRoots = selected ? { ...selected, stale: true as const } : null;
  const warn = (selected?.value ?? 0) >= GC_WARN_UNIQUE_ROOTS
    || mark?.outcome === "roots_cap_exceeded"
    || purge?.outcome === "roots_cap_exceeded"
    || (purge?.orphanRefs ?? 0) > 0;
  return {
    ok: true,
    rows,
    uniqueRoots,
    maxRoots: MAX_UNIQUE_ROOTS,
    mark,
    purge,
    warn,
  };
}

export async function gcHealth(env: Env): Promise<Response> {
  return json(await gcHealthData(env));
}

/** Hourly level-triggered warning; health-read failures remain best-effort. */
export async function emitGcHealthWarning(env: Env): Promise<void> {
  try {
    const health = await gcHealthData(env);
    if (!health.warn) return;
    console.warn(JSON.stringify({
      event: "gc_health_warning",
      rows: health.rows,
      uniqueRoots: health.uniqueRoots?.value ?? null,
      rootsLowerBound: health.uniqueRoots?.lowerBound === true,
      maxRoots: health.maxRoots,
      markOutcome: health.mark?.outcome ?? null,
      purgeOutcome: health.purge?.outcome ?? null,
    }));
  } catch (e) {
    logErr("scheduled_gc_health_failed", e);
  }
}
