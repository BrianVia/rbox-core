/**
 * Daemon activity sidecar (design 45 §1) — the indicator light on the black box.
 *
 * The daemon maintains `.rbox/state/activity.json` and `rbox status` reads it:
 * a heartbeat, the last op that changed something, live transfer progress, and
 * a standing halt warning (the mass-delete guard's visible surface — without
 * this, a guard trip stalls background sync with no user-facing signal).
 *
 * Own file, same rationale as metrics.json: an activity write must never be
 * able to corrupt the correctness-critical state.json. Every write here is
 * best-effort (errors swallowed) — visibility must never break sync.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../engine/index.js";
import { RBOX_DIR } from "./config.js";

export interface DaemonActivity {
  /** Heartbeat — last time the pump completed an op (throttled; see daemon). */
  at: string;
  /** Last push that COMMITTED. Separate slot from `lastPull` (codex R2): a single
   *  most-recent-op slot let the commit that follows a 409-recovery pull mask the
   *  local-tree mutations that pull had just applied. */
  lastPush?: { at: string; files: number; sequence: number };
  /** Last pull that APPLIED actions to the local tree — including the pull inside
   *  push's 409 recovery (recorded via the SyncDeps.onPullApplied hook). */
  lastPull?: { at: string; writes: number; deletes: number; conflicts: number };
  /** Live transfer progress; present only mid-op. Status ignores it when older
   *  than {@link ACTIVE_STALE_MS} — a crashed daemon must not show "syncing" forever. */
  active?: { at: string; phase: "encrypt" | "upload" | "download"; done: number; total: number };
  /** Standing warning set by the pump's error path, cleared ONLY by a later success
   *  of the SAME op kind (`op`) — a mass-delete-guard halt from a pull must survive
   *  no-op push successes and safety scans. This is how a guard refusal (design 44)
   *  becomes visible. */
  halt?: { at: string; reason: string; count: number; op: "pull" | "push" | "fullScan" | "deepScan" };
}

/** An `active` entry older than this is ignored by status (stale = daemon died mid-op). */
export const ACTIVE_STALE_MS = 60_000;

const activityPath = (root: string) => path.join(root, RBOX_DIR, "state", "activity.json");

/** Best-effort read: absent/corrupt → undefined (status renders nothing extra). */
export async function loadActivity(root: string): Promise<DaemonActivity | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(activityPath(root), "utf8")) as DaemonActivity;
    return typeof parsed?.at === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort write: any failure (permissions, full disk) is swallowed. */
export async function saveActivity(root: string, a: DaemonActivity): Promise<void> {
  try {
    await fs.mkdir(path.join(root, RBOX_DIR, "state"), { recursive: true });
    await writeFileAtomic(activityPath(root), JSON.stringify(a, null, 2));
  } catch {
    /* best-effort by contract */
  }
}
