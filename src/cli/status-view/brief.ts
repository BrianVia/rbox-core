/**
 * The brief status surface (design 153): bare `rbox` and the default
 * `rbox status`.
 *
 * It is a deliberately different language from the detail surface — no
 * sequences, no glyphs beyond the three attention marks, no host or workspace
 * identifiers — because it is the line a non-developer reads and the line a
 * user pastes into a support thread. The snapshot union it renders cannot
 * represent a state-backed field during reset recovery, so no caller can invent
 * a healthy zero, and `headlineBlocked` is the closed list of conditions that
 * demote the headline to "needs attention".
 */
import { ACTIVE_STALE_MS, type DaemonActivity } from "../activity.js";
import type { AmbientWatcherTrust } from "../daemon/ambient-status.js";
import type { LockingHealth } from "../sync-mutex.js";
import type { StatusRemoteHead } from "../status-view.js";
import type { TransferPhase, TransferProgressBytes } from "../transfer-progress.js";
import { gitPauseHeadline, type GitPauseCounts } from "./git-story-render.js";
import { progressLabel } from "./progress.js";
import { humanBytes, n, sanitizeTerminalText } from "./text.js";

/** Closed, brief-only entitlement/quota state. Raw evidence is aggregated by the
 * status command so the renderer cannot accidentally print overlapping rows. */
export type PlanQuotaAttention =
  | { kind: "no-active-plan" }
  | { kind: "storage-limit" }
  | { kind: "workspace-limit" }
  | { kind: "none" };

/** Cache-only identity and entitlement data used by the brief status surface. */
export interface BriefIdentitySource {
  email: string | null;
  plan: string | null;
}

export type BriefAccountSummary =
  | { state: "ok"; identity: BriefIdentitySource }
  | { state: "signed-out" }
  | { state: "credential-degraded"; reason: string }
  | { state: "unavailable" };

/** The only daemon halt reasons the brief is allowed to interpret. */
export type BriefHaltReason =
  | { kind: "mass-delete"; op: "pull" | "push" }
  | { kind: "too-many-refs" }
  | { kind: "body-too-large" }
  | { kind: "unknown" };

/** Design 273 S1: the split every glance surface shows — literally the
 * projection's own counts, so the snapshot cannot declare a different set of
 * numbers than the one that was computed. Quiet rows are already excluded by
 * the caller. */
export interface BriefGitAttention extends GitPauseCounts {
  /** The grouped listing follows this headline, so the pointer to it is noise. */
  listed?: boolean;
}

export interface BriefPopulateProgress {
  filesDone: number;
  filesTotal: number;
}

export interface BriefTransferProgress {
  phase: TransferPhase;
  done: number;
  total: number;
  detail?: string;
  bytesDone?: number;
  bytesTotal?: number;
  bytesPerSecond?: number;
  etaSeconds?: number;
}

/** Design 153 Unit D: reset recovery is deliberately unable to represent any
 * state-backed field. This union prevents callers from inventing healthy zeros. */
export type BriefStatusSnapshot =
  | {
      kind: "reset-halt";
      workspaceLabel: string;
      daemonRunning: boolean;
      account: BriefAccountSummary;
    }
  | {
      kind: "full";
      workspaceLabel: string;
      daemonRunning: boolean;
      daemonStale: boolean;
      account: BriefAccountSummary;
      pendingChanges: number;
      active?: BriefTransferProgress;
      populate?: BriefPopulateProgress;
      behindRemote: boolean;
      halt?: BriefHaltReason;
      recovery?: { nextProbeAt?: string; running?: true };
      planQuota: PlanQuotaAttention;
      watcherTrust?: AmbientWatcherTrust;
      daemonVersion?: string;
      cliVersion: string;
      daemonVersionSkew: boolean;
      locking: LockingHealth;
      git?: BriefGitAttention;
      pathWarnings?: { groupCount: number; pathCount: number };
      trash?: { files: number; bytes: number };
      update?: { current: string; next: string };
      now: number;
    };

export interface BriefStatusRender {
  lines: string[];
  daemonRunning: boolean;
}

export function aggregatePlanQuotaAttention(
  account: BriefAccountSummary,
  outOfStorage: DaemonActivity["outOfStorage"] | undefined
): PlanQuotaAttention {
  if (account.state === "ok" && account.identity.plan === "none") return { kind: "no-active-plan" };
  if (outOfStorage?.reason === "no_plan") return { kind: "no-active-plan" };
  if (outOfStorage?.kind === "storage") return { kind: "storage-limit" };
  if (outOfStorage?.kind === "workspaces") return { kind: "workspace-limit" };
  return { kind: "none" };
}

export function briefWorkspaceLabel(configuredName: string | undefined, rootBasename: string): string {
  return sanitizeTerminalText(configuredName?.trim() ?? "")
    || sanitizeTerminalText(rootBasename)
    || "Workspace";
}

export function briefBehindRemote(localSequence: number, remote: StatusRemoteHead | undefined): boolean {
  return remote?.sequence !== undefined && remote.sequence > localSequence;
}

export function freshBriefActive(
  activity: DaemonActivity | undefined,
  daemonRunning: boolean,
  now: number
): BriefTransferProgress | undefined {
  const raw = daemonRunning ? activity?.active : undefined;
  const age = raw ? now - Date.parse(raw.at) : Number.POSITIVE_INFINITY;
  if (!raw || !Number.isFinite(age) || age < 0 || age >= ACTIVE_STALE_MS) return undefined;
  const progress: BriefTransferProgress = { phase: raw.phase, done: raw.done, total: raw.total };
  if (raw.detail !== undefined) progress.detail = raw.detail;
  if (raw.bytesDone !== undefined) progress.bytesDone = raw.bytesDone;
  if (raw.bytesTotal !== undefined) progress.bytesTotal = raw.bytesTotal;
  if (raw.bytesPerSecond !== undefined) progress.bytesPerSecond = raw.bytesPerSecond;
  if (raw.etaSeconds !== undefined) progress.etaSeconds = raw.etaSeconds;
  return progress;
}

const briefTransferBytes = (active: BriefTransferProgress): TransferProgressBytes | undefined =>
  active.bytesDone !== undefined ? { bytesDone: active.bytesDone, bytesTotal: active.bytesTotal, bytesPerSecond: active.bytesPerSecond, etaSeconds: active.etaSeconds } : undefined;

/** Sequence-free, glyph-free transfer wording for the brief headline. */
export function translateBriefProgressLabel(label: string): string {
  if (label.startsWith("scanning…")) return `checking files…${label.slice("scanning…".length)}`;
  if (label.startsWith("capturing git state")) return `saving git history${label.slice("capturing git state".length)}`;
  return label;
}

export function briefProgressLabel(active: BriefTransferProgress): string {
  return translateBriefProgressLabel(
    progressLabel(active.phase, active.done, active.total, active.detail, briefTransferBytes(active))
  );
}

/** Spelled-unit age used only by the brief; legacy detail keeps ageBucket. */
export function briefAge(iso: string, now: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed) || parsed > now) return "unknown";
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${n(minutes)} minute${minutes === 1 ? "" : "s"}`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return `${n(hours)} hour${hours === 1 ? "" : "s"}`;
  }
  const exactDays = Math.floor(seconds / 86400);
  const days = exactDays >= 30 ? 30 : exactDays >= 14 ? 14 : exactDays >= 7 ? 7 : exactDays;
  return `${n(days)} day${days === 1 ? "" : "s"}`;
}

function briefPlan(plan: string | null | undefined): string {
  if (plan === "none") return "no active plan";
  if (plan === "solo" || plan === "pro" || plan === "team") return plan;
  return "plan unavailable";
}

export function briefIdentityLine(account: BriefAccountSummary): string {
  if (account.state === "signed-out") return "Signed out · rbox login";
  if (account.state === "credential-degraded") return `Credential degraded · ${account.reason}`;
  if (account.state === "unavailable") return "Signed in · account details unavailable";
  const plan = briefPlan(account.identity.plan);
  const email = sanitizeTerminalText(account.identity.email?.trim() ?? "");
  return email ? `Signed in as ${email} · ${plan}` : `Signed in · ${plan}`;
}

/** The intentionally closed design-153 headline blocker predicate. */
export function headlineBlocked(snapshot: BriefStatusSnapshot): boolean {
  if (snapshot.kind === "reset-halt") return true;
  return snapshot.halt !== undefined
    || snapshot.planQuota.kind !== "none"
    || snapshot.watcherTrust === "fused"
    || snapshot.daemonVersionSkew
    || snapshot.locking.status !== "ok";
}

function briefHaltLine(halt: BriefHaltReason): string {
  switch (halt.kind) {
    case "mass-delete": return "⛔ sync paused to protect against a large deletion · rbox sync --allow-mass-delete";
    case "too-many-refs": return "⛔ workspace has too many files to upload · rbox ignore";
    case "body-too-large": return "⛔ workspace update is too large to upload · rbox ignore";
    case "unknown": return "⛔ sync halted — see rbox logs";
  }
}

function planQuotaLine(attention: PlanQuotaAttention): string | undefined {
  switch (attention.kind) {
    case "no-active-plan": return "⛔ no active plan · rbox subscribe";
    case "storage-limit": return "⛔ storage limit reached · rbox usage · rbox subscribe";
    case "workspace-limit": return "⛔ workspace limit reached · rbox usage · rbox subscribe";
    case "none": return undefined;
  }
}

export function watcherTrustLine(trust: AmbientWatcherTrust): string {
  return trust === "suspect"
    ? "watcher trust suspect — pulls may scan while trust is rebuilt"
    : "watcher reliability reduced — syncing continues by scan; restarting rbox restores reactive sync.";
}

function lockingAttentionLine(locking: LockingHealth): string | undefined {
  if (locking.status === "ok") return undefined;
  if (locking.status === "degraded-unlocked") {
    return "⚠ safe workspace locking is unavailable; Git config sync is off · rbox doctor";
  }
  switch (locking.reason) {
    case "foreign": return "⚠ workspace sync is waiting on another lock · rbox doctor";
    case "identity-drift": return "⚠ workspace lock identity changed · rbox doctor";
    case "stale-owned": return "⚠ a stale workspace lock is blocking sync · rbox doctor";
    case "fence": return "⚠ workspace recovery is holding the sync lock · rbox doctor";
  }
}

function fullBriefHeadline(snapshot: Extract<BriefStatusSnapshot, { kind: "full" }>): string {
  const workspace = snapshot.workspaceLabel;
  if (headlineBlocked(snapshot)) return `${workspace} · sync needs attention`;
  if (snapshot.daemonStale || !snapshot.daemonRunning) return `${workspace} · sync is paused`;
  if (snapshot.populate) {
    const progress = snapshot.populate.filesTotal > 0
      ? `${n(snapshot.populate.filesDone)}/${n(snapshot.populate.filesTotal)} files`
      : "starting";
    return `${workspace} · initial sync in progress — ${progress}`;
  }
  if (snapshot.active && !(snapshot.active.phase === "upload" && snapshot.pendingChanges > 0)) {
    return `${workspace} · syncing now — ${briefProgressLabel(snapshot.active)}`;
  }
  if (snapshot.pendingChanges > 0) {
    const changes = `${n(snapshot.pendingChanges)} change${snapshot.pendingChanges === 1 ? "" : "s"}`;
    const action = snapshot.active?.phase === "upload" ? "uploading now" : "waiting to upload";
    return `${workspace} · syncing normally — ${changes} ${action}`;
  }
  if ((snapshot.pathWarnings?.groupCount ?? 0) > 0) {
    const count = snapshot.pathWarnings!.groupCount;
    return `${workspace} · synced with ${n(count)} warning${count === 1 ? "" : "s"}`;
  }
  return `${workspace} · syncing normally`;
}

/** One renderer for bare-rbox and default `rbox status`. */
export function renderBriefStatus(snapshot: BriefStatusSnapshot): BriefStatusRender {
  if (snapshot.kind === "reset-halt") {
    return {
      daemonRunning: snapshot.daemonRunning,
      lines: [
        `${snapshot.workspaceLabel} · sync needs attention`,
        "⛔ sync halted to protect recovery state · rbox doctor reset-journal",
        briefIdentityLine(snapshot.account),
      ],
    };
  }

  const lines = [fullBriefHeadline(snapshot)];
  if (snapshot.recovery) {
    if (snapshot.recovery.running) lines.push("↻ retrying after conflict");
    else {
      const seconds = Math.max(0, Math.ceil((Date.parse(snapshot.recovery.nextProbeAt!) - snapshot.now) / 1000));
      lines.push(`⚠ retrying after conflict; next probe in ${seconds}s`);
    }
  }
  if (snapshot.halt) lines.push(briefHaltLine(snapshot.halt));
  const quota = planQuotaLine(snapshot.planQuota);
  if (quota) lines.push(quota);
  // Halt/quota suppress watcher detail. Fused also escalates the headline;
  // suspect remains a supplementary line under an otherwise-normal headline.
  if (!snapshot.halt && !quota && snapshot.watcherTrust) lines.push(watcherTrustLine(snapshot.watcherTrust));
  if (snapshot.daemonStale) {
    lines.push("⚠ background sync is attached to a previous workspace · rbox start");
  } else if (!snapshot.daemonRunning) {
    lines.push("⚠ background sync is stopped · rbox start");
  }
  if (snapshot.daemonVersionSkew) {
    lines.push(`⚠ daemon is running v${snapshot.daemonVersion} but this CLI is v${snapshot.cliVersion} — restart to finish the upgrade: rbox stop && rbox start`);
  }
  const locking = lockingAttentionLine(snapshot.locking);
  if (locking) lines.push(locking);
  if (snapshot.behindRemote) lines.push("⚠ remote changes waiting to download · rbox pull");
  if ((snapshot.pathWarnings?.groupCount ?? 0) > 0) {
    const groups = snapshot.pathWarnings!.groupCount;
    const paths = snapshot.pathWarnings!.pathCount;
    lines.push(`⚠ skipped ${n(paths)} case-conflicting path${paths === 1 ? "" : "s"} in ${n(groups)} group${groups === 1 ? "" : "s"} · rename or remove one; background sync will pick it up`);
  }
  if (snapshot.git) lines.push(...gitPauseHeadline(snapshot.git));
  if (snapshot.trash && snapshot.trash.files > 0) {
    const files = `${n(snapshot.trash.files)} trashed file${snapshot.trash.files === 1 ? "" : "s"}`;
    lines.push(`⚠ ${files} (${humanBytes(snapshot.trash.bytes)}) · rbox trash list`);
  }
  if (snapshot.update) {
    lines.push(`⚠ update available: ${snapshot.update.current} → ${snapshot.update.next} · rbox upgrade`);
  }
  lines.push(briefIdentityLine(snapshot.account));
  return { lines, daemonRunning: snapshot.daemonRunning };
}
