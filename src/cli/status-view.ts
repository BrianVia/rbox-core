/**
 * Pure render helpers for `rbox status` (design 45 §2) and transfer spinners (§3).
 *
 * The verdict logic lives here — not inline in the status command — so priority
 * ordering (halt > live progress > local divergence > behind remote > in sync)
 * and time formatting are unit-testable without console capture. Everything is
 * a pure function of a {@link StatusSnapshot}; `now` is injected, never read.
 *
 * Design 44's lesson applies to rendering too: the verdict is DERIVED from the
 * actual local-vs-baseline diff and the daemon's recorded activity — never from
 * "the command ran to completion".
 */
import { ACTIVE_STALE_MS, type DaemonActivity } from "./activity.js";
import { style } from "./style.js";

/** Everything the status verdict needs, precomputed by the caller. */
export interface StatusSnapshot {
  /** Local scan vs last-synced baseline (`diffManifests`) — counts only. */
  added: number;
  changed: number;
  deleted: number;
  /** Repos whose local git state a push would publish (`gitDivergenceCount`) —
   *  without it a clean file tree + a fresh local commit reads "in sync" while
   *  push would commit a git section (codex R1). Optional: 0 when git-sync is off. */
  gitChanged?: number;
  trackedFiles: number;
  daemonRunning: boolean;
  localSequence: number;
  /** Best-effort remote probe; undefined = offline/unknown (renders nothing). */
  remoteSequence?: number;
  activity?: DaemonActivity;
  now: number;
}

const n = (v: number) => v.toLocaleString("en-US");

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

/** `uploading 42% (3,612/8,603)` — shared by spinners and the live status line. */
export function progressLabel(phase: "encrypt" | "upload" | "download", done: number, total: number): string {
  const verb = phase === "encrypt" ? "encrypting" : phase === "upload" ? "uploading" : "downloading";
  // Clamped: a misbehaving producer must render at worst a wrong-but-sane percent,
  // never `150%` or `NaN%` (total ≤ 0 degenerates to done).
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 100;
  return `${verb} ${pct}% (${n(done)}/${n(total)})`;
}

/** The top-line health verdict, highest-priority state wins. */
export function healthLine(s: StatusSnapshot): string {
  // 1. A halted pump is the one state that must never be missable: the mass-delete
  //    guard (design 44) or a persistent error has background sync refusing to run.
  //    A stopped daemon's leftover halt is dropped — "stopped" already says sync is
  //    not running, and the next start re-evaluates.
  const halt = s.daemonRunning ? s.activity?.halt : undefined;
  if (halt) {
    const times = halt.count > 1 ? `, ×${halt.count}` : "";
    return `${style.red("⚠ sync halted")} ${style.dim(`(${relTime(halt.at, s.now)}${times})`)} ${halt.reason}`;
  }

  // 2. A transfer is live right now. Staleness-gated: a daemon that died mid-op
  //    must not show "syncing" forever.
  const active = s.activity?.active;
  if (active && s.now - Date.parse(active.at) < ACTIVE_STALE_MS) {
    return style.cyan(`↻ syncing — ${progressLabel(active.phase, active.done, active.total)}`);
  }

  const localChanges = s.added + s.changed + s.deleted;
  const gitChanged = s.gitChanged ?? 0;
  const behind = s.remoteSequence !== undefined && s.remoteSequence > s.localSequence;
  const behindNote = `behind remote (sequence ${s.localSequence} vs ${s.remoteSequence})`;

  // 3. Local divergence from the baseline — file and/or git changes waiting to
  //    upload. With the daemon running this is normally transient; stopped, it
  //    needs a nudge.
  if (localChanges > 0 || gitChanged > 0) {
    const parts = [
      s.added ? `${n(s.added)} new` : "",
      s.changed ? `${n(s.changed)} changed` : "",
      s.deleted ? `${n(s.deleted)} deleted` : "",
      gitChanged ? `git changes in ${n(gitChanged)} repo${gitChanged === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    const head =
      localChanges > 0 ? `↑ ${n(localChanges)} local change${localChanges === 1 ? "" : "s"} to sync` : "↑ git changes to sync";
    const extra = behind ? ` · ${behindNote}` : "";
    const hint = s.daemonRunning ? "" : ` ${style.dim("— background sync stopped; run `rbox start`")}`;
    return `${style.yellow(head)} ${style.dim(`(${parts.join(", ")})`)}${extra}${hint}`;
  }

  // 4. Clean locally but the remote has moved on.
  if (behind) {
    const hint = s.daemonRunning ? "will sync on the next pull" : "run `rbox pull` or `rbox start`";
    return `${style.yellow(`↓ ${behindNote}`)} ${style.dim(`— ${hint}`)}`;
  }

  // 5. In sync: no local divergence, and the remote (when reachable) agrees.
  return `${style.green("✓ in sync")} — ${n(s.trackedFiles)} files`;
}

/** Human trail of what background sync last did (from the activity sidecar), most
 *  recent first. TWO slots on purpose (codex R2): a commit right after a
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
