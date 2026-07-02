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
const shellLinePath = (root: string) => path.join(root, RBOX_DIR, "state", "shell.line");

/** Best-effort read: absent/corrupt → undefined, and each nested slot is SHAPE-
 *  VALIDATED individually — a malformed slot is dropped, never handed to a render
 *  helper (codex R3: `{"at":"…","lastPush":{}}` crashed `rbox status` on
 *  `undefined.toLocaleString`). The file is daemon-written but user-editable. */
export async function loadActivity(root: string): Promise<DaemonActivity | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(activityPath(root), "utf8")) as Partial<DaemonActivity>;
    if (typeof raw?.at !== "string") return undefined;
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    const a: DaemonActivity = { at: raw.at };
    const push = raw.lastPush;
    if (push && typeof push.at === "string" && num(push.files) && num(push.sequence)) {
      a.lastPush = { at: push.at, files: push.files, sequence: push.sequence };
    }
    const pull = raw.lastPull;
    if (pull && typeof pull.at === "string" && num(pull.writes) && num(pull.deletes) && num(pull.conflicts)) {
      a.lastPull = { at: pull.at, writes: pull.writes, deletes: pull.deletes, conflicts: pull.conflicts };
    }
    const act = raw.active;
    if (act && typeof act.at === "string" && (act.phase === "encrypt" || act.phase === "upload" || act.phase === "download") && num(act.done) && num(act.total)) {
      a.active = { at: act.at, phase: act.phase, done: act.done, total: act.total };
    }
    const halt = raw.halt;
    if (halt && typeof halt.at === "string" && typeof halt.reason === "string" && num(halt.count) && (halt.op === "pull" || halt.op === "push" || halt.op === "fullScan" || halt.op === "deepScan")) {
      a.halt = { at: halt.at, reason: halt.reason, count: halt.count, op: halt.op };
    }
    return a;
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

/** The sidecar's state field — halt > active > pending (unsettled) > ok. Exported
 *  so the daemon can compare "what would render now" against what it last wrote
 *  (the codex R4 settle fix) without duplicating the precedence. */
export const shellStateOf = (a: DaemonActivity, settled: boolean): "halt" | "active" | "pending" | "ok" =>
  a.halt ? "halt" : a.active ? "active" : settled ? "ok" : "pending";

/**
 * Design 46: render the daemon's activity record into the one-line prompt sidecar
 * (`.rbox/state/shell.line`). PURE — all display judgment (state precedence, pct
 * clamping, op-recency) lives HERE next to the code that owns the data, so the zsh
 * prompt hook can stay a single `read` builtin that never re-derives (and drifts
 * from) the verdict rules. See {@link saveShellLine} for the write side.
 *
 * Format (v1), single-space separated, `name` LAST because it may contain spaces:
 *   `v1 <epochSeconds> <state> <pct> <sequence> <lastOpEpoch> <lastOpKind> <name>`
 *
 * - `state` precedence: `halt` > `active` > `pending` (unsettled) > `ok` (settled).
 * - `pct` — floor(done/total*100) clamped 0–100 for `active` (total<=0 → 100), else `-`.
 * - `sequence` — last synced sequence; `-` when none (0 = never synced ⇒ `-`).
 * - `lastOpEpoch`/`lastOpKind` — the MORE RECENT of lastPush/lastPull (`push`/`pull`);
 *   `- -` when neither.
 */
export function renderShellLine(
  a: DaemonActivity,
  opts: { settled: boolean; sequence?: number; name: string; now: number }
): string {
  const epochSeconds = Math.floor(opts.now / 1000);
  const state = shellStateOf(a, opts.settled);

  let pct: string | number = "-";
  if (a.active) {
    const { done, total } = a.active;
    pct = total <= 0 ? 100 : Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
  }

  // Sequence 0 = never synced (the daemon seeds it from a fresh baseline) — that's
  // "no sequence", not "(seq 0)" in the banner (codex R1).
  const sequence = opts.sequence !== undefined && opts.sequence > 0 ? opts.sequence : "-";

  let lastOpEpoch: string | number = "-";
  let lastOpKind = "-";
  const pushAt = a.lastPush ? Date.parse(a.lastPush.at) : NaN;
  const pullAt = a.lastPull ? Date.parse(a.lastPull.at) : NaN;
  if (a.lastPush && (!a.lastPull || pushAt >= pullAt)) {
    lastOpEpoch = Math.floor(pushAt / 1000);
    lastOpKind = "push";
  } else if (a.lastPull) {
    lastOpEpoch = Math.floor(pullAt / 1000);
    lastOpKind = "pull";
  }

  // Strip control chars (incl. newlines) so the sidecar stays exactly one line.
  const name = opts.name.replace(/\p{Cc}/gu, "?");
  return `v1 ${epochSeconds} ${state} ${pct} ${sequence} ${lastOpEpoch} ${lastOpKind} ${name}`;
}

/**
 * Design 46: write the pre-rendered prompt sidecar — the daemon renders, the zsh
 * side just reads. Same best-effort contract as {@link saveActivity} (mkdir
 * recursive, atomic write, all errors swallowed): visibility must never break sync.
 */
export async function saveShellLine(root: string, line: string): Promise<void> {
  try {
    await fs.mkdir(path.join(root, RBOX_DIR, "state"), { recursive: true });
    await writeFileAtomic(shellLinePath(root), line + "\n");
  } catch {
    /* best-effort by contract */
  }
}
