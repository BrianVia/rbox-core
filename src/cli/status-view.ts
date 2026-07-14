/**
 * Pure render helpers for `rbox status` (design 45 §2) and transfer spinners (§3).
 *
 * The verdict logic lives here — not inline in the status command — so priority
 * ordering (halt > live progress > local divergence > behind remote > in sync,
 * with fresh retry progress allowed to lead while the older halt moves below it)
 * and time formatting are unit-testable without console capture. Everything is
 * a pure function of a {@link StatusSnapshot}; `now` is injected, never read.
 *
 * Design 44's lesson applies to rendering too: the verdict is DERIVED from the
 * actual local-vs-baseline diff and the daemon's recorded activity — never from
 * "the command ran to completion".
 */
import { ACTIVE_STALE_MS, type DaemonActivity } from "./activity.js";
import type { GitDeferral, GitDeferralReason } from "./config.js";
import { formatBinaryBytes, formatDecimalBytes, quotaUsage } from "./quota-format.js";
import { style } from "./style.js";
import type { TransferPhase, TransferProgressBytes } from "./transfer-progress.js";

/** Everything the status verdict needs, precomputed by the caller. */
export interface StatusSnapshot {
  /** Local scan vs last-synced baseline (`diffManifests`) — counts only. */
  added: number;
  changed: number;
  deleted: number;
  /** Repos whose local git state a push would publish (`gitDivergenceCount`) —
   *  without it a clean file tree + a fresh local commit reads "in sync" while
   *  push would commit a git section. Optional: 0 when git-sync is off. */
  gitChanged?: number;
  /** Durable Git lanes that cannot currently converge. */
  gitDeferrals?: number;
  /** Deferred lanes whose working bytes changed during the episode. */
  gitBytesChangedDeferrals?: number;
  /** Oldest durable lane, for concise context below the verdict. */
  gitOldestDeferral?: { deferredSince: string; reason: GitDeferralReason };
  trackedFiles: number;
  daemonRunning: boolean;
  localSequence: number;
  /** Best-effort remote head evidence; undefined = offline/unknown. */
  remote?: StatusRemoteHead;
  activity?: DaemonActivity;
  populate?: {
    phase: TransferPhase;
    filesDone: number;
    filesTotal: number;
    bytesDone?: number;
    bytesTotal?: number;
  };
  now: number;
}

export const WS_TRUST_MS = 60_000;
export const ELIDE_MAX_AGE_MS = 30_000;

export interface StatusRemoteHead {
  sequence: number;
  source: "probe" | "daemon";
  ageMs?: number;
}

export interface DaemonStatusAttribution {
  activity: DaemonActivity | undefined;
  remote?: StatusRemoteHead;
  remoteLine?: string;
  elided: boolean;
}

const n = (v: number) => v.toLocaleString("en-US");
const BINARY_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export function attributeDaemonForStatus(input: {
  activity: DaemonActivity | undefined;
  daemonRunning: boolean;
  boundWorkspaceId?: string;
  currentWorkspaceId: string;
  livePidfileBootId?: string;
  localSequence: number;
  now: number;
}): DaemonStatusAttribution {
  const { activity } = input;
  const ws = activity?.ws;
  if (ws && input.livePidfileBootId !== undefined && ws.bootId !== input.livePidfileBootId) {
    return { activity: undefined, elided: false };
  }
  if (!activity || !ws) return { activity, elided: false };

  const bindingCurrent = input.boundWorkspaceId === input.currentWorkspaceId;
  const ageMs = input.now - Date.parse(ws.at);
  const finiteAge = Number.isFinite(ageMs) ? ageMs : Number.POSITIVE_INFINITY;
  const connectionTrusted = finiteAge >= 0 && finiteAge < WS_TRUST_MS;
  const canElide =
    input.daemonRunning &&
    bindingCurrent &&
    ws.bootId === input.livePidfileBootId &&
    ws.connected === true &&
    ws.caughtUp === true &&
    connectionTrusted &&
    finiteAge < ELIDE_MAX_AGE_MS &&
    !activity.halt;

  if (!canElide) return { activity, elided: false };
  const sequence = Math.max(ws.lastBroadcastSequence ?? 0, input.localSequence);
  const renderedAgeMs = Math.max(0, finiteAge);
  return {
    activity,
    elided: true,
    remote: {
      sequence,
      source: "daemon",
      ageMs: renderedAgeMs,
    },
    remoteLine: `${style.dim("remote:")} seq ${n(sequence)} · live via daemon (${ageLabel(renderedAgeMs)})`,
  };
}

/** "just now" / "42s ago" / "5m ago" / "3h ago" / "2d ago". */
export function relTime(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "unknown";
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Coarse chronic-age bucket shared by all deferral visibility surfaces. */
export function ageBucket(iso: string, now: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "--";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return "1h";
  if (seconds < 7 * 86400) return "1d";
  if (seconds < 14 * 86400) return "7d";
  if (seconds < 30 * 86400) return "14d";
  return "30d";
}

const DEFERRAL_REASON_TEXT: Record<GitDeferralReason, string> = {
  "local-edits": "local edits",
  "local-index": "local index changes",
  "local-operation": "local git operation",
  "local-commits": "local commits",
  "local-stash": "local stash",
  conflict: "conflict",
  "git-busy": "git busy",
  "worktree-ownership": "worktree ownership",
  "ignored-target": "ignored target",
  unreadable: "unreadable repository",
  artifact: "git artifact",
  config: "git config",
  containment: "repository containment",
  unsupported: "unsupported git state",
  other: "other git issue",
};

function gitDeferralReasonText(reason: GitDeferralReason): string {
  return DEFERRAL_REASON_TEXT[reason];
}

/** Human-divergence reasons lead operational reasons when chronic ages tie. */
function gitDeferralReasonPrecedence(reason: GitDeferralReason): number {
  switch (reason) {
    case "local-edits": return 0;
    case "local-index": return 1;
    case "local-operation": return 2;
    case "local-commits": return 3;
    case "local-stash": return 4;
    default: return 5;
  }
}

interface GitDeferralDisplayEntry {
  repo: string;
  deferral: Pick<GitDeferral, "lane" | "reason" | "deferredSince" | "bytesChanged" | "checkout">;
}

/** One authoritative display row per repo, shared by every local visibility surface. */
interface GitDeferralRepoProjection {
  repo: string;
  oldestDeferredSince: string;
  displayReason: GitDeferralReason;
  bytesChanged: boolean;
  checkout?: GitDeferral["checkout"];
}

const parsedDeferralTime = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/**
 * Collapse independent apply/capture/config lanes into the single repo-level
 * projection promised by design 116. The chronic age is the oldest standing
 * lane, while the reason is selected independently by display precedence.
 */
export function projectGitDeferralRepos(entries: Iterable<GitDeferralDisplayEntry>): GitDeferralRepoProjection[] {
  const grouped = new Map<string, GitDeferralDisplayEntry["deferral"][]>();
  for (const { repo, deferral } of entries) {
    const lanes = grouped.get(repo) ?? [];
    lanes.push(deferral);
    grouped.set(repo, lanes);
  }
  const projected: GitDeferralRepoProjection[] = [];
  for (const [repo, lanes] of grouped) {
    const ordered = [...lanes].sort((a, b) =>
      gitDeferralReasonPrecedence(a.reason) - gitDeferralReasonPrecedence(b.reason)
      || parsedDeferralTime(a.deferredSince) - parsedDeferralTime(b.deferredSince)
      || a.lane.localeCompare(b.lane)
      || a.reason.localeCompare(b.reason)
    );
    const display = ordered[0]!;
    const oldest = [...lanes].sort((a, b) =>
      parsedDeferralTime(a.deferredSince) - parsedDeferralTime(b.deferredSince)
      || a.lane.localeCompare(b.lane)
    )[0]!;
    const checkout = display.checkout ?? ordered.find((lane) => lane.checkout !== undefined)?.checkout;
    projected.push({
      repo,
      oldestDeferredSince: oldest.deferredSince,
      displayReason: display.reason,
      bytesChanged: lanes.some((lane) => lane.bytesChanged === true),
      ...(checkout === undefined ? {} : { checkout }),
    });
  }
  return projected.sort((a, b) =>
    parsedDeferralTime(a.oldestDeferredSince) - parsedDeferralTime(b.oldestDeferredSince)
    || gitDeferralReasonPrecedence(a.displayReason) - gitDeferralReasonPrecedence(b.displayReason)
    || a.repo.localeCompare(b.repo)
  );
}

/** Pure, terminal-safe local rendering. Detached checkouts never expose an OID. */
export function renderGitDeferralLine(input: {
  relPath: string;
  reason: GitDeferralReason;
  deferredSince: string;
  checkout?: { kind: "branch" | "detached"; label?: string };
  bytesChanged?: boolean;
  now: number;
}): string {
  const checkout = input.checkout?.kind === "branch"
    ? `branch ${input.checkout.label ? truncateDetail(input.checkout.label) : "(unknown)"}`
    : input.checkout?.kind === "detached"
      ? "detached checkout"
      : "checkout unavailable";
  const changed = input.bytesChanged ? " (working files changed since)" : "";
  return `git deferred ${ageBucket(input.deferredSince, input.now)}: ${gitDeferralReasonText(input.reason)} on ${checkout} (${truncateDetail(input.relPath)})${changed}`;
}

const ageLabel = (ageMs: number | undefined): string => {
  if (ageMs === undefined || !Number.isFinite(ageMs)) return "unknown";
  return `${Math.max(0, Math.round(ageMs / 1000))}s ago`;
};

const freshActive = (s: StatusSnapshot): DaemonActivity["active"] | undefined => {
  const active = s.daemonRunning ? s.activity?.active : undefined;
  return active && s.now - Date.parse(active.at) < ACTIVE_STALE_MS ? active : undefined;
};

const haltLine = (halt: NonNullable<DaemonActivity["halt"]>, now: number): string => {
  if (halt.terminal) return `${style.red("⛔ sync blocked")} ${style.dim(`(${relTime(halt.at, now)})`)} ${halt.reason}`;
  const times = halt.count > 1 ? `, ×${halt.count}` : "";
  // Only reachable with a LIVE daemon (a stopped daemon's leftover halt is dropped
  // above) — and a live daemon retries every tick, so this is amber, not alarm-red,
  // and says so. The reason text carries any required action (e.g. the mass-delete
  // guard's consent flag).
  return `${style.yellow("⚠ sync failing")} ${style.dim(`(${relTime(halt.at, now)}${times})`)} ${halt.reason} ${style.yellow("— will be retried")}`;
};

/** Longest display `detail` (in CODE POINTS, e.g. a repo name) rendered on the
 *  progress line; a longer one is head-truncated so the meaningful TAIL (the
 *  basename) survives. */
const DETAIL_MAX = 40;
/** Sanitize + truncate a display `detail`. Detail comes from on-disk names,
 *  i.e. untrusted bytes headed for a terminal: strip ANSI/CSI escape
 *  sequences and every remaining control char first, then truncate by CODE POINTS
 *  (Array.from — a `.slice` on UTF-16 units could cut through a surrogate pair and
 *  emit a lone-surrogate mojibake) keeping the tail. */
export const sanitizeTerminalText = (text: string): string =>
  text.replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, "").replace(/\p{Cc}/gu, "");

const truncateDetail = (d: string): string => {
  const clean = sanitizeTerminalText(d);
  const cps = Array.from(clean);
  return cps.length > DETAIL_MAX ? `…${cps.slice(-(DETAIL_MAX - 1)).join("")}` : clean;
};

/**
 * Shared by spinners and the live status line.
 * Phase-shaped so the two silent-until-now phases read truthfully:
 *  - `scan` is INDETERMINATE (no known total during a live walk) → count only,
 *    no percent: `scanning… 12,304 files`.
 *  - `gitcap` is a per-repo N/total with an optional repo name:
 *    `capturing git state 3/140 — zen-browser-desktop`.
 *  - byte-aware transfer phases render count and byte fractions side by side,
 *    without manufacturing a unified percent.
 */
export function progressLabel(phase: TransferPhase, done: number, total: number, detail?: string, bytes?: TransferProgressBytes): string {
  if (phase === "scan") return `scanning… ${n(done)} files`;
  const byteSuffix = bytes ? ` · ${formatProgressBytes(bytes)}` : "";
  if (phase === "gitcap") {
    const suffix = detail ? ` — ${truncateDetail(detail)}` : "";
    return `capturing git state ${n(done)}/${n(total)}${byteSuffix}${suffix}`;
  }
  // Determinate transfer phases. The final `?? "syncing"` is a defensive fallback so a
  // phase string an OLDER daemon never wrote (read from the user-editable activity file)
  // degrades to a sane verb rather than a misleading "downloading".
  const verb = phase === "encrypt" ? "encrypting" : phase === "upload" ? "uploading" : phase === "download" ? "downloading" : "syncing";
  if (bytes) return `${verb} ${n(done)}/${n(total)}${byteSuffix}`;
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 100;
  return `${verb} ${pct}% (${n(done)}/${n(total)})`;
}

function formatProgressBytes(bytes: TransferProgressBytes): string {
  if (bytes.bytesTotal !== undefined && bytes.bytesTotal > 0) return formatBinaryBytePair(bytes.bytesDone, bytes.bytesTotal);
  return `${formatBinaryBytes(bytes.bytesDone)} sent`;
}

const activeBytes = (active: NonNullable<DaemonActivity["active"]>): TransferProgressBytes | undefined =>
  active.bytesDone !== undefined ? { bytesDone: active.bytesDone, bytesTotal: active.bytesTotal } : undefined;

const populateLine = (p: NonNullable<StatusSnapshot["populate"]>): string => {
  const files =
    p.filesTotal > 0
      ? `${n(p.filesDone)}/${n(p.filesTotal)} files`
      : p.filesDone > 0
        ? `${n(p.filesDone)} files`
        : "starting";
  const bytes = p.bytesDone !== undefined && p.bytesTotal !== undefined && p.bytesTotal > 0
    ? ` · ${formatBinaryBytePair(p.bytesDone, p.bytesTotal)}`
    : "";
  return `${style.cyan(`↻ initial sync in progress — ${files}${bytes}`)}`;
};

function formatBinaryBytePair(done: number, total: number): string {
  const clampedTotal = Math.max(0, total);
  const clampedDone = Math.max(0, done);
  if (clampedTotal < 1024) return `${Math.round(clampedDone)}/${Math.round(clampedTotal)} B`;
  let unit = 0;
  let scaledTotal = clampedTotal;
  while (scaledTotal >= 1024 && unit < BINARY_UNITS.length - 1) {
    scaledTotal /= 1024;
    unit++;
  }
  const divisor = 1024 ** unit;
  return `${(clampedDone / divisor).toFixed(1)}/${scaledTotal.toFixed(1)} ${BINARY_UNITS[unit]}`;
}

/** The top-line health verdict, highest-priority state wins. */
export function healthLine(s: StatusSnapshot): string {
  // 1. A halted pump is the one state that must never be missable: the mass-delete
  //    guard (design 44) or a persistent error has background sync refusing to run.
  //    A stopped daemon's leftover halt is dropped — "stopped" already says sync is
  //    not running, and the next start re-evaluates.
  const halt = s.daemonRunning ? s.activity?.halt : undefined;
  const active = freshActive(s);

  // 2. Quota exhaustion is soft state: halt still wins, and live progress waits
  //    below it. The one surgical exception is a fresh retry transfer: it
  //    leads over an older halt, with the halt rendered as secondary context.
  const out = s.daemonRunning ? s.activity?.outOfStorage : undefined;
  if (halt?.terminal) return haltLine(halt, s.now);
  if (halt && (!active || out)) return haltLine(halt, s.now);
  if (out) {
    if (out.reason === "no_plan") return `${style.red("⛔ no active plan")} · run \`rbox subscribe\``;
    const usage = quotaUsage(out.kind, out.used, out.cap);
    const detail = out.kind === "workspaces"
      ? usage ? `workspace limit reached — ${usage} workspaces used` : "workspace limit reached"
      : usage ? `out of storage — ${usage} used` : "out of storage";
    return `${style.red(`⛔ ${detail}`)} · run \`rbox usage\`, then \`rbox subscribe solo\``;
  }

  // 3. A transfer is live right now. Gated on BOTH daemon liveness and freshness
  //    only the daemon writes `active`, so with the daemon stopped —
  //    even freshly killed mid-op — there is no live transfer to report; and a
  //    daemon that died with its pidfile intact must not show "syncing" forever.
  if (active) {
    return style.cyan(`↻ syncing — ${progressLabel(active.phase, active.done, active.total, undefined, activeBytes(active))}`);
  }
  if (s.populate) return populateLine(s.populate);

  const localChanges = s.added + s.changed + s.deleted;
  const gitChanged = s.gitChanged ?? 0;
  const gitDeferrals = s.gitDeferrals ?? 0;
  const gitBytesChangedDeferrals = s.gitBytesChangedDeferrals ?? 0;
  const remoteSequence = s.remote?.sequence;
  const behind = remoteSequence !== undefined && remoteSequence > s.localSequence;
  const behindNote = `behind remote (sequence ${s.localSequence} vs ${remoteSequence})`;

  // 4. Local divergence from the baseline — file and/or git changes waiting to
  //    upload. With the daemon running this is normally transient; stopped, it
  //    needs a nudge.
  if (localChanges > 0 || gitChanged > 0 || gitDeferrals > 0 || gitBytesChangedDeferrals > 0) {
    const deferralIsHead = localChanges === 0 && gitChanged === 0 && gitDeferrals > 0;
    const parts = [
      s.added ? `${n(s.added)} new` : "",
      s.changed ? `${n(s.changed)} changed` : "",
      s.deleted ? `${n(s.deleted)} deleted` : "",
      gitChanged ? `git changes in ${n(gitChanged)} repo${gitChanged === 1 ? "" : "s"}` : "",
      gitDeferrals && !deferralIsHead ? `${n(gitDeferrals)} git repo${gitDeferrals === 1 ? "" : "s"} deferred` : "",
      gitBytesChangedDeferrals ? `working files changed during ${n(gitBytesChangedDeferrals)} deferral${gitBytesChangedDeferrals === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const head = localChanges > 0
      ? `↑ ${n(localChanges)} local change${localChanges === 1 ? "" : "s"} to sync`
      : gitChanged > 0
        ? "↑ git changes to sync"
        : gitDeferrals > 0
          ? `⚠ ${n(gitDeferrals)} git repo${gitDeferrals === 1 ? "" : "s"} deferred`
          : "⚠ git working files changed during deferral";
    const extra = behind ? ` · ${behindNote}` : "";
    const hint = s.daemonRunning ? "" : ` ${style.dim("— background sync stopped; run `rbox start`")}`;
    const detail = parts.length ? ` ${style.dim(`(${parts.join(", ")})`)}` : "";
    return `${style.yellow(head)}${detail}${extra}${hint}`;
  }

  // 5. Clean locally but the remote has moved on.
  if (behind) {
    const hint = s.remote?.source === "daemon" ? `daemon has not applied seq ${remoteSequence} yet` : s.daemonRunning ? "will sync on the next pull" : "run `rbox pull` or `rbox start`";
    return `${style.yellow(`↓ ${behindNote}`)} ${style.dim(`— ${hint}`)}`;
  }

  // 6. In sync: no local divergence, and the remote (when reachable) agrees.
  return `${style.green("✓ in sync")} — ${n(s.trackedFiles)} files`;
}

/** Secondary health details that should sit directly under the verdict line. */
export function healthDetailLines(s: StatusSnapshot): string[] {
  const halt = s.daemonRunning ? s.activity?.halt : undefined;
  const active = freshActive(s);
  const out = s.daemonRunning ? s.activity?.outOfStorage : undefined;
  const lines: string[] = [];
  if (halt && !halt.terminal && active && !out) {
    lines.push(`${style.yellow("⚠ last attempt failed")} ${style.dim(`(${relTime(halt.at, s.now)})`)} ${halt.reason} ${style.yellow("— will be retried")}`);
  }
  if ((s.gitDeferrals ?? 0) > 0 && s.gitOldestDeferral) {
    lines.push(`${style.yellow("git deferral:")} oldest ${ageBucket(s.gitOldestDeferral.deferredSince, s.now)} · ${gitDeferralReasonText(s.gitOldestDeferral.reason)}`);
  }
  return lines;
}

/** Human byte size: `847 B` / `12.3 KB` / `312.4 MB` / `1.4 GB` (decimal units, one
 *  decimal place above bytes). Pure — the status trash line and any future size surface
 *  share one formatting rule. */
export function humanBytes(bytes: number): string {
  return formatDecimalBytes(bytes);
}

/** The `rbox status` trash line (design 50 §2), or undefined when trash is empty — the
 *  caller passes {@link TrashStats}-shaped data so this stays a pure view. */
export function trashLine(stats: { files: number; bytes: number } | undefined): string | undefined {
  if (!stats || stats.files <= 0) return undefined;
  return `${style.dim("trash:")} ${n(stats.files)} file${stats.files === 1 ? "" : "s"} (${humanBytes(stats.bytes)}) ${style.dim("— rbox trash list")}`;
}

/** Human trail of what background sync last did (from the activity sidecar), most
 *  recent first. TWO slots on purpose: a commit right after a
 *  409-recovery pull must not mask the local-tree mutations that pull applied.
 *  Empty when there is no activity record (daemon never ran here). */
export function lastSyncLines(activity: DaemonActivity | undefined, now: number): string[] {
  if (!activity) return [];
  const lines: Array<{ at: string; text: string }> = [];
  if (activity.lastPush) {
    const p = activity.lastPush;
    lines.push({ at: p.at, text: `last push: ${relTime(p.at, now)} — ${n(p.files)} files → sequence ${p.sequence}` });
  }
  if (activity.lastPull) {
    const p = activity.lastPull;
    const parts = [
      p.writes ? `${n(p.writes)} written` : "",
      p.deletes ? `${n(p.deletes)} deleted` : "",
      p.conflicts ? `${n(p.conflicts)} conflict${p.conflicts === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    lines.push({ at: p.at, text: `last pull: ${relTime(p.at, now)} — ${parts.length ? parts.join(", ") : "nothing changed"}` });
  }
  if (lines.length === 0) return [`last checked: ${relTime(activity.at, now)}`];
  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).map((l) => l.text);
}
