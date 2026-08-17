/**
 * The detail `rbox status` surface (design 45 §2): the health verdict, the lines
 * that sit under it, and the daemon-remote attribution that decides whether a
 * remote probe can be elided.
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
 *
 * Its neighbours own the surfaces that are not this one: `status-view/brief.ts`
 * the design-153 brief, `status-view/git-projection.ts` and `git-render.ts` the
 * Git deferral reading and its frozen log grammar, `status-view/progress.ts`
 * transfer wording, and `status-view/text.ts` the shared display primitives.
 */
import { ACTIVE_STALE_MS, isSafetyHaltReason, type DaemonActivity } from "./activity.js";
import type { DaemonObservation } from "./daemon/observation.js";
import { quotaUsage } from "./quota-format.js";
import { style } from "./style.js";
import type { TransferPhase, TransferProgressBytes } from "./transfer-progress.js";
import { gitDeferralReasonText } from "./status-view/git-projection.js";
import { formatBinaryBytePair, progressLabel } from "./status-view/progress.js";
import { ageBucket, ageLabel, humanBytes, n, relTime } from "./status-view/text.js";

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
  gitOldestDeferral?: { deferredSince: string; reason: string };
  trackedFiles: number;
  daemonRunning: boolean;
  localSequence: number;
  /** Best-effort remote head evidence; undefined = offline/unknown. */
  remote?: StatusRemoteHead;
  activity?: DaemonActivity;
  /** Local-only advisory: ambiguous case-fold path groups are skipped while the
   * rest of the file plane continues syncing. Never promotes to a halt. */
  pathWarnings?: { groupCount: number; pathCount: number };
  /** Design 224 §2.3: already-synced entries that match the ignore rules and are
   *  carried forward rather than deleted. Advisory; `rbox ignore --purge` clears it. */
  strandedIgnored?: number;
  /** Design 272 §4: rbox-minted conflict copies on this device; the user owns deletion. */
  conflictCopies?: number;
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

export function attributeDaemonForStatus(input: {
  activity: DaemonActivity | undefined;
  daemon: Pick<DaemonObservation, "running" | "ownsWorkspace" | "bootId">;
  localSequence: number;
  now: number;
}): DaemonStatusAttribution {
  const { activity } = input;
  const ws = activity?.ws;
  if (ws && input.daemon.bootId !== undefined && ws.bootId !== input.daemon.bootId) {
    return { activity: undefined, elided: false };
  }
  if (!activity || !ws) return { activity, elided: false };

  const ageMs = input.now - Date.parse(ws.at);
  const finiteAge = Number.isFinite(ageMs) ? ageMs : Number.POSITIVE_INFINITY;
  const connectionTrusted = finiteAge >= 0 && finiteAge < WS_TRUST_MS;
  const canElide =
    input.daemon.running &&
    input.daemon.ownsWorkspace &&
    ws.bootId === input.daemon.bootId &&
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

const activeBytes = (active: NonNullable<DaemonActivity["active"]>): TransferProgressBytes | undefined =>
  active.bytesDone !== undefined ? { bytesDone: active.bytesDone, bytesTotal: active.bytesTotal, bytesPerSecond: active.bytesPerSecond, etaSeconds: active.etaSeconds } : undefined;

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
  const nonSafetyRetry = halt
    && !halt.terminal
    && !isSafetyHaltReason(halt.typedReason?.kind);
  if (nonSafetyRetry && halt.recoveryState === "running") {
    return style.cyan("↻ retrying after conflict");
  }
  if (nonSafetyRetry && halt.recoveryState !== "suspended" && halt.nextProbeAt) {
    const seconds = Math.max(0, Math.ceil((Date.parse(halt.nextProbeAt ?? halt.at) - s.now) / 1000));
    return style.yellow(`⚠ retrying after conflict; next probe in ${seconds}s`);
  }
  if (halt?.terminal) return haltLine(halt, s.now);
  if (halt && (!nonSafetyRetry || halt.recoveryState !== "suspended") && (!active || out)) return haltLine(halt, s.now);
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
  if ((s.pathWarnings?.groupCount ?? 0) > 0) {
    const count = s.pathWarnings!.groupCount;
    return `${style.green("✓ in sync")} — ${n(s.trackedFiles)} files · ${style.yellow(`⚠ ${n(count)} warning${count === 1 ? "" : "s"}`)}`;
  }
  return `${style.green("✓ in sync")} — ${n(s.trackedFiles)} files`;
}

/** Secondary health details that should sit directly under the verdict line. */
export function healthDetailLines(s: StatusSnapshot): string[] {
  const halt = s.daemonRunning ? s.activity?.halt : undefined;
  const active = freshActive(s);
  const out = s.daemonRunning ? s.activity?.outOfStorage : undefined;
  const lines: string[] = [];
  if ((s.pathWarnings?.groupCount ?? 0) > 0) {
    const groups = s.pathWarnings!.groupCount;
    const paths = s.pathWarnings!.pathCount;
    lines.push(`${style.yellow("path warning:")} skipped ${n(paths)} case-conflicting path${paths === 1 ? "" : "s"} in ${n(groups)} group${groups === 1 ? "" : "s"}; rename or remove one and background sync will pick it up`);
  }
  if (halt && halt.typedReason?.kind !== "push-conflict" && !halt.terminal && active && !out) {
    lines.push(`${style.yellow("⚠ last attempt failed")} ${style.dim(`(${relTime(halt.at, s.now)})`)} ${halt.reason} ${style.yellow("— will be retried")}`);
  }
  const stranded = strandedIgnoredLine(s.strandedIgnored);
  if (stranded) lines.push(stranded);
  const copies = conflictCopiesLine(s.conflictCopies);
  if (copies) lines.push(copies);
  if ((s.gitDeferrals ?? 0) > 0 && s.gitOldestDeferral) {
    lines.push(`${style.yellow("git deferral:")} oldest ${ageBucket(s.gitOldestDeferral.deferredSince, s.now)} · ${gitDeferralReasonText(s.gitOldestDeferral.reason)}`);
  }
  return lines;
}

/** Design 224 §2.3: the advisory line for already-synced files that now match the
 *  ignore rules and are carried forward instead of deleted. `undefined` at zero —
 *  the detector is only worth a line when there is something to act on. Count only:
 *  the stored size is neither the billed nor the reclaimable number. */
export function strandedIgnoredLine(count: number | undefined): string | undefined {
  if (!count || count <= 0) return undefined;
  const body = count === 1
    ? "1 file matches your ignore rules but is still synced"
    : `${n(count)} files match your ignore rules but are still synced`;
  return `${style.yellow(`⚠ ${body}`)} · ${style.dim("rbox ignore --purge")}`;
}

/** Design 272 §4: rbox-minted conflict copies still on this device. Deliberately NOT
 *  `counts.conflictSnapshots`, which is the `refs/rbox-conflict/` git-ref namespace. */
export function conflictCopiesLine(count: number | undefined): string | undefined {
  if (!count || count <= 0) return undefined;
  const body = count === 1
    ? "1 conflict copy rbox saved is still here"
    : `${n(count)} conflict copies rbox saved are still here`;
  return `${style.yellow(`⚠ ${body}`)} · ${style.dim("inspect, then delete the ones you do not need")}`;
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
