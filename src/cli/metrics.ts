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
import { writeFileAtomic } from "../engine/index.js";
import { RBOX_DIR } from "./config.js";

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
