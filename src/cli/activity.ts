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
import {
  type RepoRecord, type SyncState,
} from "./sync-state-model.js";
import {
  repoRecordsForState,
} from "./sync-state-records.js";
import { projectGitDeferralRepos } from "./status-view.js";
import type { TransferPhase } from "./transfer-progress.js";
import { RBOX_DIR } from "./workspace-config.js";
import { jsonText, type JsonValue } from "../json.js";

/** One field read out of the parsed sidecar: a JSON value, or absent. The file
 *  is daemon-written but user-editable, so every slot is validated on read. */
type JsonField = JsonValue | undefined;

/** The transfer phases the activity sidecar accepts. The daemon only ever writes a
 *  subset (it never emits `scan` — its full/deep scans don't wire progress), but a
 *  forward-compatible read must not drop a phase a newer writer might land. */
const TRANSFER_PHASES: readonly TransferPhase[] = ["scan", "gitcap", "encrypt", "upload", "download"];
const isTransferPhase = (v: JsonField): v is TransferPhase => TRANSFER_PHASES.includes(v as TransferPhase);

export interface DaemonRecoveryHalt {
  at: string;
  reason: string;
  count: number;
  firstFailureAt?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
  nextProbeAt?: string;
  lastProbeAt?: string;
  /** Timer lifecycle. Missing means a legacy armed episode when nextProbeAt exists. */
  recoveryState?: "armed" | "running" | "suspended";
  op: "pull" | "push" | "fullScan" | "deepScan";
  /** Producer-authored classification. Missing/invalid legacy values are
   * deliberately unknown; readers never classify the raw reason string. */
  typedReason?:
    | { kind: "mass-delete"; op: "pull" | "push" }
    | { kind: "push-conflict" }
    | { kind: "chain-repair" }
    | { kind: "too-many-refs" }
    | { kind: "body-too-large" }
    | { kind: "folder-admission" };
  terminal?: { fingerprint: string };
}

export interface DaemonActivity {
  /** Heartbeat — last time the pump completed an op (throttled; see daemon). */
  at: string;
  /** Daemon-computed local file divergence against the recorded sync-state base. */
  local?: {
    at: string;
    stream: string;
    baseSequence: number;
    trackedFiles: number;
    added: number;
    changed: number;
    deleted: number;
    settled: boolean;
    /** Design 224 §2.3: already-synced base entries the matcher now ignores, as of
     *  this daemon's last projection. Optional — an older daemon, or one that has
     *  not pushed since start, omits it; `sourceVersion` stays 1. */
    strandedIgnored?: number;
    /** Design 272 §4: locally observed entries carrying an rbox conflict-copy
     *  path component. Optional — an older daemon omits it; `sourceVersion` stays 1. */
    conflictCopies?: number;
    sourceVersion: 1;
  };
  /** Workspace-DO WebSocket currency evidence. `at` is refreshed only by WS-layer
   *  traffic/lifecycle, not by pump heartbeats. */
  ws?: {
    connected: boolean;
    at: string;
    caughtUp: boolean;
    lastBroadcastSequence?: number;
    bootId: string;
    pid: number;
  };
  /** Last push that COMMITTED. Separate slot from `lastPull`: a single
   *  most-recent-op slot let the commit that follows a 409-recovery pull mask the
   *  local-tree mutations that pull had just applied. */
  lastPush?: { at: string; files: number; sequence: number };
  /** Last pull that APPLIED actions to the local tree — including the pull inside
   *  push's 409 recovery (recorded via the SyncDeps.onPullApplied hook). */
  lastPull?: { at: string; writes: number; deletes: number; conflicts: number };
  /** Live transfer progress; present only mid-op. Status ignores it when older
   *  than {@link ACTIVE_STALE_MS} — a crashed daemon must not show "syncing" forever. */
  active?: {
    at: string;
    phase: TransferPhase;
    done: number;
    total: number;
    detail?: string;
    bytesDone?: number;
    bytesTotal?: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
  };
  /** Standing warning set by the pump's error path, cleared ONLY by a later success
   *  of the SAME op kind (`op`) — a mass-delete-guard halt from a pull must survive
   *  no-op push successes and safety scans. This is how a guard refusal (design 44)
   *  becomes visible. */
  halt?: DaemonRecoveryHalt;
  /** Push recovery preserved while a pull-only daemon uses `halt` for live pull failures. */
  suspendedPushHalt?: DaemonRecoveryHalt;
  /** Quota exhaustion blocks pushes, but it is soft state: halt still wins. */
  outOfStorage?: { at: string; kind: "storage" | "workspaces"; used?: number; cap?: number; reason?: "no_plan" };
}

/** An `active` entry older than this is ignored by status (stale = daemon died mid-op). */
export const ACTIVE_STALE_MS = 60_000;

const activityPath = (root: string) => path.join(root, RBOX_DIR, "state", "activity.json");
const shellLinePath = (root: string) => path.join(root, RBOX_DIR, "state", "shell.line");

/** Best-effort read: absent/corrupt → undefined, and each nested slot is SHAPE-
 *  VALIDATED individually — a malformed slot is dropped, never handed to a render
 *  helper (`{"at":"…","lastPush":{}}` crashed `rbox status` on
 *  `undefined.toLocaleString`). The file is daemon-written but user-editable. */
export async function loadActivity(root: string): Promise<DaemonActivity | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(activityPath(root), "utf8")) as Partial<DaemonActivity>;
    if (!jsonText(raw?.at)) return undefined;
    const num = (v: JsonField): v is number => Number.isFinite(v);
    const flag = (v: JsonField): v is boolean => v === true || v === false;
    const uint = (v: JsonField): v is number => Number.isInteger(v) && (v as number) >= 0;
    const positiveInt = (v: JsonField): v is number => Number.isInteger(v) && (v as number) > 0;
    const timestamp = (v: JsonField): v is string => jsonText(v) && Number.isFinite(Date.parse(v));
    const a: DaemonActivity = { at: raw.at };
    const local = raw.local;
    if (
      local &&
      jsonText(local.at) &&
      jsonText(local.stream) &&
      uint(local.baseSequence) &&
      uint(local.trackedFiles) &&
      uint(local.added) &&
      uint(local.changed) &&
      uint(local.deleted) &&
      flag(local.settled) &&
      (local.strandedIgnored === undefined || uint(local.strandedIgnored)) &&
      (local.conflictCopies === undefined || uint(local.conflictCopies)) &&
      local.sourceVersion === 1
    ) {
      const decoded: NonNullable<DaemonActivity["local"]> = {
        at: local.at,
        stream: local.stream,
        baseSequence: local.baseSequence,
        trackedFiles: local.trackedFiles,
        added: local.added,
        changed: local.changed,
        deleted: local.deleted,
        settled: local.settled,
        sourceVersion: 1,
      };
      if (local.strandedIgnored !== undefined) decoded.strandedIgnored = local.strandedIgnored;
      if (local.conflictCopies !== undefined) decoded.conflictCopies = local.conflictCopies;
      a.local = decoded;
    }
    const ws = raw.ws;
    if (
      ws &&
      flag(ws.connected) &&
      jsonText(ws.at) &&
      flag(ws.caughtUp) &&
      jsonText(ws.bootId) &&
      ws.bootId.length > 0 &&
      positiveInt(ws.pid) &&
      (ws.lastBroadcastSequence === undefined || uint(ws.lastBroadcastSequence))
    ) {
      const decoded: NonNullable<DaemonActivity["ws"]> = {
        connected: ws.connected,
        at: ws.at,
        caughtUp: ws.caughtUp,
        bootId: ws.bootId,
        pid: ws.pid,
      };
      if (ws.lastBroadcastSequence !== undefined) decoded.lastBroadcastSequence = ws.lastBroadcastSequence;
      a.ws = decoded;
    }
    const push = raw.lastPush;
    if (push && jsonText(push.at) && num(push.files) && num(push.sequence)) {
      a.lastPush = { at: push.at, files: push.files, sequence: push.sequence };
    }
    const pull = raw.lastPull;
    if (pull && jsonText(pull.at) && num(pull.writes) && num(pull.deletes) && num(pull.conflicts)) {
      a.lastPull = { at: pull.at, writes: pull.writes, deletes: pull.deletes, conflicts: pull.conflicts };
    }
    const act = raw.active;
    if (act && jsonText(act.at) && isTransferPhase(act.phase) && num(act.done) && num(act.total)) {
      a.active = {
        at: act.at,
        phase: act.phase,
        done: act.done,
        total: act.total,
      };
      if (jsonText(act.detail)) a.active.detail = act.detail;
      if (
        uint(act.bytesDone) &&
        (act.bytesTotal === undefined || (positiveInt(act.bytesTotal) && act.bytesDone <= act.bytesTotal))
      ) {
        a.active.bytesDone = act.bytesDone;
        if (act.bytesTotal !== undefined) a.active.bytesTotal = act.bytesTotal;
      }
      if (num(act.bytesPerSecond) && act.bytesPerSecond > 0) {
        a.active.bytesPerSecond = act.bytesPerSecond;
      }
      if (uint(act.etaSeconds)) a.active.etaSeconds = act.etaSeconds;
    }
    const parseHalt = (halt: DaemonRecoveryHalt | undefined, requiredOp?: DaemonRecoveryHalt["op"]): DaemonRecoveryHalt | undefined => {
      if (!halt || !timestamp(halt.at) || !jsonText(halt.reason) || !positiveInt(halt.count)
        || !(halt.op === "pull" || halt.op === "push" || halt.op === "fullScan" || halt.op === "deepScan")
        || (requiredOp !== undefined && halt.op !== requiredOp)) return undefined;
      const decoded: DaemonRecoveryHalt = {
        at: halt.at,
        reason: halt.reason,
        count: halt.count,
        op: halt.op,
      };
      if (timestamp(halt.firstFailureAt)) decoded.firstFailureAt = halt.firstFailureAt;
      if (timestamp(halt.lastFailureAt)) decoded.lastFailureAt = halt.lastFailureAt;
      if (positiveInt(halt.consecutiveFailures)) decoded.consecutiveFailures = halt.consecutiveFailures;
      if (timestamp(halt.nextProbeAt)) decoded.nextProbeAt = halt.nextProbeAt;
      if (timestamp(halt.lastProbeAt)) decoded.lastProbeAt = halt.lastProbeAt;
      if (halt.recoveryState === "armed" || halt.recoveryState === "running" || halt.recoveryState === "suspended") {
        decoded.recoveryState = halt.recoveryState;
      }
      const typedReason = halt.typedReason;
      if (typedReason?.kind === "mass-delete" && (typedReason.op === "pull" || typedReason.op === "push")) {
        decoded.typedReason = { kind: "mass-delete", op: typedReason.op };
      } else if (typedReason?.kind === "push-conflict") decoded.typedReason = { kind: "push-conflict" };
      else if (typedReason?.kind === "chain-repair") decoded.typedReason = { kind: "chain-repair" };
      else if (typedReason?.kind === "too-many-refs") decoded.typedReason = { kind: "too-many-refs" };
      else if (typedReason?.kind === "body-too-large") decoded.typedReason = { kind: "body-too-large" };
      else if (typedReason?.kind === "folder-admission") decoded.typedReason = { kind: "folder-admission" };
      const terminal = halt.terminal;
      if (terminal && jsonText(terminal.fingerprint) && terminal.fingerprint.length > 0) {
        decoded.terminal = { fingerprint: terminal.fingerprint };
      }
      return decoded;
    };
    const halt = parseHalt(raw.halt);
    if (halt) a.halt = halt;
    const suspendedPushHalt = parseHalt(raw.suspendedPushHalt, "push");
    if (suspendedPushHalt) a.suspendedPushHalt = suspendedPushHalt;
    const out = raw.outOfStorage;
    if (
      out &&
      jsonText(out.at) &&
      (out.kind === "storage" || out.kind === "workspaces") &&
      (out.used === undefined || num(out.used)) &&
      (out.cap === undefined || num(out.cap)) &&
      (out.reason === undefined || out.reason === "no_plan")
    ) {
      const decoded: NonNullable<DaemonActivity["outOfStorage"]> = { at: out.at, kind: out.kind };
      if (out.used !== undefined) decoded.used = out.used;
      if (out.cap !== undefined) decoded.cap = out.cap;
      if (out.reason === "no_plan") decoded.reason = out.reason;
      a.outOfStorage = decoded;
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

/** Typed reasons that are safety refusals rather than transient contention:
 *  they must keep the ⛔ typed-halt surface even when a recovery probe is
 *  armed, and regardless of whether the server attached a fingerprint
 *  (too-many-refs/body-too-large arrive fingerprint-less without a blob-ref
 *  sidecar). */
export const isSafetyHaltReason = (kind: string | undefined): boolean =>
  kind === "mass-delete"
  || kind === "chain-repair"
  || kind === "too-many-refs"
  || kind === "body-too-large"
  || kind === "folder-admission";

/** The machine-facing activity state — halt > outofstorage > active > pending
 *  (unsettled) > ok. `status --json` mirrors this verbatim. */
const isTimerOwnedRetry = (halt: DaemonActivity["halt"]): boolean => Boolean(
  halt?.nextProbeAt
    && halt.recoveryState !== "suspended"
    && !halt.terminal
    && !isSafetyHaltReason(halt.typedReason?.kind),
);
const isSuspendedRetry = (halt: DaemonActivity["halt"]): boolean => Boolean(
  halt?.recoveryState === "suspended"
    && !halt.terminal
    && !isSafetyHaltReason(halt.typedReason?.kind),
);

export const shellStateOf = (a: DaemonActivity, settled: boolean): "halt" | "outofstorage" | "active" | "pending" | "ok" =>
  isTimerOwnedRetry(a.halt) ? "pending"
    : isSuspendedRetry(a.halt) ? (settled ? "ok" : "pending")
    : a.halt ? "halt" : a.outOfStorage ? "outofstorage" : a.active ? "active" : settled ? "ok" : "pending";

const freshActive = (a: DaemonActivity, now: number): DaemonActivity["active"] | undefined => {
  const active = a.active;
  return active && now - Date.parse(active.at) < ACTIVE_STALE_MS ? active : undefined;
};

/** Writer-side prompt state. `status --json` intentionally keeps using
 *  {@link shellStateOf}; this variant only controls the pre-rendered shell line. */
export const shellLineStateOf = (
  a: DaemonActivity,
  settled: boolean,
  now: number
): "halt" | "outofstorage" | "active" | "pending" | "ok" => {
  const active = freshActive(a, now);
  if (isTimerOwnedRetry(a.halt)) return active ? "active" : "pending";
  if (isSuspendedRetry(a.halt)) return a.outOfStorage ? "outofstorage" : active ? "active" : settled ? "ok" : "pending";
  if (a.halt?.terminal) return "halt";
  if (a.halt && (!active || a.outOfStorage)) return "halt";
  if (a.outOfStorage) return "outofstorage";
  if (active) return "active";
  return settled ? "ok" : "pending";
};

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
 * - `state` precedence: `halt` > `outofstorage` > `active` > `pending` (unsettled) > `ok` (settled),
 *   except a FRESH `active` transfer renders as `active` while carrying an older halt
 *   record, so installed snippets show the live retry glyph instead of a stale warning.
 * - `pct` — floor(done/total*100) clamped 0–100 for a determinate `active`; `-` for an
 *   INDETERMINATE active phase (total<=0, e.g. a live scan — a fake "100" would render
 *   `↻ 100%` for minutes) and when not active at all. `-` has been a legal pct token
 *   since v1 (the installed zsh snippet's regex pins pct to `([0-9]{1,3}|-)` and its
 *   glyph renders `↻` alone for `-`), so already-installed stale snippets degrade sanely.
 * - `sequence` — last synced sequence; `-` when none (0 = never synced ⇒ `-`).
 * - `lastOpEpoch`/`lastOpKind` — the MORE RECENT of lastPush/lastPull (`push`/`pull`);
 *   `- -` when neither.
 */
export function renderShellLine(
  a: DaemonActivity,
  opts: { settled: boolean; sequence?: number; name: string; now: number }
): string {
  const epochSeconds = Math.floor(opts.now / 1000);
  const state = shellLineStateOf(a, opts.settled, opts.now);

  let pct: string | number = "-";
  if (a.active?.bytesTotal !== undefined && a.active.bytesTotal > 0) {
    const { bytesDone, bytesTotal } = a.active;
    pct = Math.min(100, Math.max(0, Math.floor(((bytesDone ?? 0) / bytesTotal) * 100)));
  } else if (a.active?.phase === "gitcap" && a.active.total > 0) {
    const { done, total } = a.active;
    pct = Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
  }

  // Sequence 0 = never synced (the daemon seeds it from a fresh baseline) — that's
  // "no sequence", not "(seq 0)" in the banner.
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

const SHELL_DEFERRALS_MAX_ROWS = 50;
const SHELL_DEFERRALS_MAX_BYTES = 8 * 1024;
const shellDeferralsPath = (root: string): string => path.join(root, RBOX_DIR, "state", "shell.deferrals");

/**
 * Render design 116's repo-routed prompt sidecar. Rows are deliberately ASCII-only:
 * encodeURIComponent protects tabs/newlines and makes the zsh reader's character
 * bound equal the on-disk byte bound. One row represents one repo; coexisting lanes
 * collapse to the display-precedence reason, oldest episode age, and an OR of the
 * sender-local bytesChanged marker.
 */
export function renderShellDeferrals(
  state: SyncState,
  now: number,
  ageBucket: (iso: string, now: number) => string,
  repoRecords: Record<string, RepoRecord> = repoRecordsForState(state),
): string | undefined {
  const entries = Object.entries(repoRecords).flatMap(([repo, record]) =>
    Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral }] : [])
  );
  const projections = projectGitDeferralRepos(entries);
  const rows = projections.map((repo) => ({
    projection: repo,
    line: `${encodeURIComponent(repo.repo)}\t${repo.displayReason}\t${ageBucket(repo.oldestDeferredSince, now)}\t${repo.bytesChanged ? 1 : 0}`,
  }));

  if (rows.length === 0) return undefined;
  let rendered = "v1\n";
  let included = 0;
  for (const row of rows) {
    const rowsAfter = rows.length - (included + 1);
    const overflow = rowsAfter > 0;
    // If this row would omit anything, reserve one row and enough bytes for the
    // aggregate workspace-root fallback. The exact aggregate is built below.
    if (overflow && included >= SHELL_DEFERRALS_MAX_ROWS - 1) break;
    const omitted = rows.slice(included + 1);
    const fallback = omitted.length
      ? `.\tother\t${ageBucket(omitted[0]!.projection.oldestDeferredSince, now)}\t${omitted.some((item) => item.projection.bytesChanged) ? 1 : 0}\n`
      : "";
    const candidate = rendered + row.line + "\n";
    if (Buffer.byteLength(candidate + fallback) > SHELL_DEFERRALS_MAX_BYTES) break;
    rendered = candidate;
    included++;
  }
  if (included < rows.length) {
    const omitted = rows.slice(included);
    const fallback = `.\tother\t${ageBucket(omitted[0]!.projection.oldestDeferredSince, now)}\t${omitted.some((item) => item.projection.bytesChanged) ? 1 : 0}\n`;
    if (Buffer.byteLength(rendered + fallback) <= SHELL_DEFERRALS_MAX_BYTES) rendered += fallback;
  }
  return rendered;
}

/** Best-effort atomic sidecar write; absence is the fast no-op signal to zsh. */
export async function saveShellDeferrals(
  root: string,
  state: SyncState,
  now: number,
  ageBucket: (iso: string, now: number) => string,
): Promise<void> {
  const file = shellDeferralsPath(root);
  try {
    const rendered = renderShellDeferrals(state, now, ageBucket);
    if (rendered === undefined) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, rendered);
  } catch {}
}
