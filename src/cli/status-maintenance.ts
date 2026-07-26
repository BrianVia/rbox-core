import path from "node:path";
import type { GitDeferral, SyncState, WorkspaceConfig } from "./config.js";
import {
  deferralHygieneDetailKey,
  type DeferralHygieneResult,
  type GitBusyDisplayDetail,
} from "./sync-git/deferral-hygiene.js";

/** Deferral hygiene is a writer: it can recover Git locks and publish a
 * repo-transition CAS. This port is the only route from a status invocation to
 * that authority, so a read-only or all-workspaces surface must never hold one. */
export interface StatusMaintenancePort {
  readonly cfg: WorkspaceConfig;
  /** The durable state already loaded for this root; superseded only by a
   * `refreshed` receipt. */
  readonly state: SyncState;
  reconcile: (root: string, cfg: WorkspaceConfig, state: SyncState) => Promise<DeferralHygieneResult>;
}

export type StatusDeferralDisplayDetails = ReadonlyMap<string, GitBusyDisplayDetail>;

export type StatusRefreshReceipt =
  | {
    kind: "refreshed";
    root: string;
    state: SyncState;
    displayDetails: StatusDeferralDisplayDetails;
    changed: boolean;
    accepted: boolean;
    recoveredLocks: number;
    commonDirsInspected: number;
  }
  | { kind: "unavailable"; root: string; reason: string };

/** One root, one hygiene pass, one receipt bound to what that pass actually did.
 * An `unavailable` receipt carries no state or display evidence: the caller keeps
 * the durable deferrals it already loaded and status still renders. */
export async function refreshStatusDeferralAssertions(
  root: string,
  writer: StatusMaintenancePort,
): Promise<StatusRefreshReceipt> {
  try {
    const result = await writer.reconcile(root, writer.cfg, writer.state);
    return {
      kind: "refreshed",
      root,
      state: result.state,
      displayDetails: result.displayDetails,
      changed: result.changed,
      accepted: result.accepted,
      recoveredLocks: result.recoveredLocks,
      commonDirsInspected: result.commonDirsInspected,
    };
  } catch (error) {
    return { kind: "unavailable", root, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Lock evidence is ephemeral and absolute-pathed; status may only show it
 * relative to the workspace root. */
export function statusStaleLockDetail(
  root: string,
  details: StatusDeferralDisplayDetails,
  repo: string,
  lane: GitDeferral["lane"],
): GitBusyDisplayDetail | undefined {
  const detail = details.get(deferralHygieneDetailKey(repo, lane));
  if (!detail) return undefined;
  const relative = path.relative(root, detail.samplePath);
  return { ...detail, samplePath: relative && !relative.startsWith("..") ? relative : path.basename(detail.samplePath) };
}
