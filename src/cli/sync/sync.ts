import { PhaseReport, type Action } from "../../engine/index.js";
import type { WorkspaceConfig } from "../config.js";
import { assertSyncMutex } from "../sync-mutex.js";
import { type SyncDeps, withReportScanStats } from "./deps.js";
import { pull } from "./pull.js";
import { push } from "./push.js";

/** One full cycle: take remote changes, then publish local ones. */
export async function sync(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {}
): Promise<{ pulled: Action[]; pushedSequence: number; pushCommitted: boolean }> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("sync");
  deps = withReportScanStats(deps, report);
  const pulled = await pull(root, cfg, deps);
  const { sequence: pushedSequence, committed: pushCommitted } = await push(root, cfg, deps);
  return { pulled, pushedSequence, pushCommitted };
}
