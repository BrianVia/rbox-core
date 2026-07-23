import { PhaseReport, type Action, type CaseFoldCollisionGroup } from "../../engine/index.js";
import type { WorkspaceConfig } from "../config.js";
import { assertSyncMutex } from "../sync-mutex.js";
import { type SyncDeps, withReportScanStats } from "./deps.js";
import { pullWithMetadata } from "./pull.js";
import { push } from "./push.js";

/** One full cycle: take remote changes, then publish local ones. */
export async function sync(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {}
): Promise<{ pulled: Action[]; pushedSequence: number; pushCommitted: boolean; initialRemoteSequence: number; caseCollisions: CaseFoldCollisionGroup[] }> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("sync");
  deps = withReportScanStats(deps, report);
  const { actions: pulled, initialRemoteSequence } = await pullWithMetadata(root, cfg, deps);
  const { sequence: pushedSequence, committed: pushCommitted, caseCollisions } = await push(root, cfg, deps);
  return { pulled, pushedSequence, pushCommitted, initialRemoteSequence, caseCollisions };
}
