/**
 * Dogfooding sync metrics (design 09 §3). Persisted in its OWN file —
 * `.rbox/state/metrics.json` — deliberately separate from the correctness-
 * critical `state.json`, so a metrics write can never corrupt the sync base.
 *
 * Two distinct conflict signals:
 *  - `commitConflicts409`: parent-sequence races at commit (retry pressure) —
 *    invisible in reconcile output; counted via the sync `onCommitConflict` hook.
 *  - `fileConflicts`: reconcile `conflict`-kind actions (real content divergence,
 *    local kept as a `.conflict` copy) — counted from a pull's returned actions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PhaseReport, writeFileAtomic } from "../engine/index.js";
import { RBOX_DIR } from "./config.js";

/** Per-run phase metrics (design §35/85) are on by default. Measured scan overhead is
 *  <=3% in the worst cache-hit profile; set `RBOX_METRICS=0` (or `false`) to opt out. */
export const metricsEnabled = (): boolean => process.env.RBOX_METRICS !== "0" && process.env.RBOX_METRICS !== "false";

/** An ENABLED per-run report when metrics are on, else `undefined` — so the daemon hot
 *  path and no-op tick allocate nothing. Callers wire the result into `SyncDeps.report`
 *  and later `report?.logSummaryTo(sink)`; the sync core falls back to a disabled no-op. */
export function beginReport(op: "push" | "pull" | "sync"): PhaseReport | undefined {
  if (!metricsEnabled()) return undefined;
  return op === "push" ? PhaseReport.push() : op === "pull" ? PhaseReport.pull() : PhaseReport.sync();
}

export interface SyncMetrics {
  syncs: number;
  commitConflicts409: number;
  fileConflicts: number;
  lastConflictAt?: string;
}

const ZERO: SyncMetrics = { syncs: 0, commitConflicts409: 0, fileConflicts: 0 };
const metricsPath = (root: string) => path.join(root, RBOX_DIR, "state", "metrics.json");

export async function loadMetrics(root: string): Promise<SyncMetrics> {
  try {
    return { ...ZERO, ...(JSON.parse(await fs.readFile(metricsPath(root), "utf8")) as Partial<SyncMetrics>) };
  } catch {
    return { ...ZERO }; // absent or unreadable → fresh counters (metrics are best-effort)
  }
}

export async function saveMetrics(root: string, m: SyncMetrics): Promise<void> {
  await fs.mkdir(path.join(root, RBOX_DIR, "state"), { recursive: true });
  await writeFileAtomic(metricsPath(root), JSON.stringify(m, null, 2));
}
