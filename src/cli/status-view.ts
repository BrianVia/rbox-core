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
import { ACTIVE_STALE_MS, isSafetyHaltReason, type DaemonActivity } from "./activity.js";
import type { DaemonObservation } from "./daemon/observation.js";
import type { GitDeferral, GitDeferralReason, RepoRecord } from "./sync-state-model.js";
import { formatBinaryBytes, formatDecimalBytes, quotaUsage } from "./quota-format.js";
import { style } from "./style.js";
import type { TransferPhase, TransferProgressBytes } from "./transfer-progress.js";
import type { CheckoutTransactionCapability } from "../engine/index.js";
import type { LockingHealth } from "./sync-mutex.js";

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
  populate?: {
    phase: TransferPhase;
    filesDone: number;
    filesTotal: number;
    bytesDone?: number;
    bytesTotal?: number;
  };
  now: number;
}

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

export interface BriefGitAttention {
  count: number;
  oldestDeferredSince: string;
  allLocalEditDeferrals: boolean;
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
  return {
    phase: raw.phase,
    done: raw.done,
    total: raw.total,
    ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
    ...(raw.bytesDone !== undefined ? { bytesDone: raw.bytesDone } : {}),
    ...(raw.bytesTotal !== undefined ? { bytesTotal: raw.bytesTotal } : {}),
    ...(raw.bytesPerSecond !== undefined ? { bytesPerSecond: raw.bytesPerSecond } : {}),
    ...(raw.etaSeconds !== undefined ? { etaSeconds: raw.etaSeconds } : {}),
  };
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
  if (!Number.isFinite(parsed) || parsed > now) return "unknown";
  const seconds = Math.floor((now - parsed) / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return "1h";
  if (seconds < 7 * 86400) return "1d";
  if (seconds < 14 * 86400) return "7d";
  if (seconds < 30 * 86400) return "14d";
  return "30d";
}

export interface GitDeferralReasonPresentation {
  label: string;
  text: string;
  repair: string;
  transient: boolean;
}

export const UNKNOWN_GIT_DEFERRAL_PRESENTATION: GitDeferralReasonPresentation = {
  label: "unrecognized Git issue",
  text: "Git sync is deferred for an unrecognized reason.",
  repair: "Inspect rbox status and the daemon logs before changing repository state.",
  transient: false,
};

const DEFERRAL_REASON_PRESENTATION: Record<GitDeferralReason, GitDeferralReasonPresentation> = {
  "local-edits": { label: "local edits", text: "Working files changed here.", repair: "Stop Git and file changes, then let normal sync retry.", transient: true },
  "local-index": { label: "local index changes", text: "The Git index changed here.", repair: "Stop Git and file changes, then let normal sync retry.", transient: true },
  "local-operation": { label: "local Git operation", text: "A Git operation is active or changed here.", repair: "Finish or stop the Git operation, then let normal sync retry.", transient: true },
  "local-commits": { label: "local commits", text: "Local commits changed here.", repair: "Stop Git mutation, then let normal sync retry.", transient: true },
  "local-stash": { label: "local stash", text: "The local stash changed here.", repair: "Stop stash mutation, then let normal sync retry.", transient: true },
  "deletion-pending": { label: "finishing a branch deletion", text: "rbox is finishing a branch you deleted here.", repair: "rbox retries this on its own. If it stays, run `rbox doctor`.", transient: true },
  conflict: { label: "conflict", text: "Incoming and local Git state conflict.", repair: "Repair the conflicting repository state, then let sync retry.", transient: false },
  "git-busy": { label: "git busy", text: "Another Git process is using this repository.", repair: "Let the other Git process finish, then let sync retry.", transient: false },
  "stale-unattributed": { label: "stale Git locks", text: "A stable lock cohort remains without a known live owner.", repair: "Run `rbox doctor`, confirm no Git process owns the reported locks, then remove only the stale lock files and let sync retry.", transient: false },
  "worktree-ownership": { label: "worktree ownership", text: "Another worktree owns a required Git ref.", repair: "Repair the worktree ownership conflict, then let sync retry.", transient: false },
  "ignored-target": { label: "ignored target", text: "The incoming checkout targets an ignored repository.", repair: "Correct the ignore rule or repository target, then let sync retry.", transient: false },
  "ref-read-unreadable": { label: "unreadable Git refs", text: "Git refs could not be read completely.", repair: "Restore ref-store readability and permissions, then let sync retry.", transient: false },
  unreadable: { label: "unreadable repository", text: "Git metadata could not be read completely.", repair: "Restore repository readability and permissions, then let sync retry.", transient: false },
  artifact: { label: "Git artifact", text: "Required Git artifacts could not be fetched or verified.", repair: "Repair artifact availability or integrity, then let sync retry.", transient: false },
  config: { label: "git config", text: "Common Git configuration could not be synchronized safely.", repair: "Correct the local common Git config so it is readable, supported, within wire bounds, and workspace-owned, then let sync retry.", transient: false },
  containment: { label: "repository containment", text: "Repository containment could not be proved.", repair: "Repair the repository or worktree layout so it stays within the workspace, then let sync retry.", transient: false },
  unsupported: { label: "unsupported git state", text: "This Git version or repository shape is unsupported.", repair: "Upgrade Git or repair the repository shape, then let sync retry.", transient: false },
  other: { label: "other git issue", text: "Git sync is deferred by another known condition.", repair: "Inspect rbox status and the daemon logs, repair the reported condition, then let sync retry.", transient: false },
};

export function gitDeferralReasonPresentation(reason: string): GitDeferralReasonPresentation {
  return DEFERRAL_REASON_PRESENTATION[reason as GitDeferralReason] ?? UNKNOWN_GIT_DEFERRAL_PRESENTATION;
}

export function isKnownGitDeferralReason(reason: string): reason is GitDeferralReason {
  return Object.hasOwn(DEFERRAL_REASON_PRESENTATION, reason);
}

function gitDeferralReasonText(reason: string): string {
  return gitDeferralReasonPresentation(reason).label;
}

/** Preserve the legacy operational tie while giving deletion-pending its deliberate display slot. */
function gitDeferralReasonPrecedence(reason: string): number {
  switch (reason) {
    case "local-edits": return 0;
    case "local-index": return 1;
    case "local-operation": return 2;
    case "local-commits": return 3;
    case "local-stash": return 4;
    case "deletion-pending": return 5;
    case "ref-read-unreadable": return 6;
    default: return 7;
  }
}

export interface GitDeferralDisplayEntry {
  repo: string;
  deferral: Pick<GitDeferral, "lane" | "reason" | "deferredSince" | "bytesChanged" | "checkout">
    & Partial<Pick<GitDeferral, "reasonSince">>;
  record?: RepoRecord;
}

/** One authoritative display row per repo, shared by every local visibility surface. */
export type GitDeferralRemediationClass = "transient" | "capture" | "config" | "apply-resolvable" | "apply-unavailable";

export interface GitDeferralRepoProjection {
  repo: string;
  oldestDeferredSince: string;
  displayReason: string;
  displayLane: GitDeferral["lane"];
  reasonSince: string;
  reasonLabel: string;
  reasonText: string;
  repairText: string;
  remediationClass: GitDeferralRemediationClass;
  canResolve: boolean;
  canKeepMine: boolean;
  alsoDeferred?: string;
  bytesChanged: boolean;
  checkout?: GitDeferral["checkout"];
}

const parsedDeferralTime = (iso: string, now: number): number => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed <= now ? parsed : Number.POSITIVE_INFINITY;
};

/** The exact truthiness gate used by `rbox git resolve` to select incoming state. */
export function hasGitResolutionIncoming(record: RepoRecord | undefined): boolean {
  return Boolean(record?.pending || ((record?.resolutionKey || record?.deferrals?.apply) && record?.base));
}

/**
 * Collapse independent apply/capture/config lanes into the single repo-level
 * projection promised by design 116. The chronic age is the oldest standing
 * lane, while the reason is selected independently by display precedence.
 */
export function projectGitDeferralRepos(entries: Iterable<GitDeferralDisplayEntry>, now = Date.now()): GitDeferralRepoProjection[] {
  const grouped = new Map<string, { lanes: GitDeferralDisplayEntry["deferral"][]; record?: RepoRecord }>();
  for (const { repo, deferral, record } of entries) {
    const group = grouped.get(repo) ?? { lanes: [] };
    group.lanes.push(deferral);
    if (record) group.record = record;
    grouped.set(repo, group);
  }
  const projected: GitDeferralRepoProjection[] = [];
  for (const [repo, { lanes, record }] of grouped) {
    const ordered = [...lanes].sort((a, b) =>
      gitDeferralReasonPrecedence(a.reason) - gitDeferralReasonPrecedence(b.reason)
      || parsedDeferralTime(a.deferredSince, now) - parsedDeferralTime(b.deferredSince, now)
      || a.lane.localeCompare(b.lane)
      || a.reason.localeCompare(b.reason)
    );
    const display = ordered[0]!;
    const oldest = [...lanes].sort((a, b) =>
      parsedDeferralTime(a.deferredSince, now) - parsedDeferralTime(b.deferredSince, now)
      || a.lane.localeCompare(b.lane)
    )[0]!;
    const checkout = display.checkout ?? ordered.find((lane) => lane.checkout !== undefined)?.checkout;
    const presentation = gitDeferralReasonPresentation(display.reason);
    const knownReason = isKnownGitDeferralReason(display.reason);
    const canResolve = knownReason && hasGitResolutionIncoming(record);
    const canKeepMine = knownReason && Boolean(record?.pending);
    const remediationClass: GitDeferralRemediationClass = !knownReason
      ? "apply-unavailable"
      : presentation.transient
      ? "transient"
      : display.lane === "capture"
        ? "capture"
        : display.lane === "config"
          ? "config"
          : canResolve ? "apply-resolvable" : "apply-unavailable";
    const additional = ordered.slice(1).map((lane) => `${lane.lane} — ${gitDeferralReasonPresentation(lane.reason).label}`);
    projected.push({
      repo,
      oldestDeferredSince: oldest.deferredSince,
      displayReason: display.reason,
      displayLane: display.lane,
      reasonSince: display.reasonSince ?? display.deferredSince,
      reasonLabel: presentation.label,
      reasonText: presentation.text,
      repairText: presentation.repair,
      remediationClass,
      canResolve,
      canKeepMine,
      ...(additional.length ? { alsoDeferred: `Also deferred: ${additional.join("; ")}.` } : {}),
      bytesChanged: lanes.some((lane) => lane.bytesChanged === true),
      ...(checkout === undefined ? {} : { checkout }),
    });
  }
  return projected.sort((a, b) =>
    parsedDeferralTime(a.oldestDeferredSince, now) - parsedDeferralTime(b.oldestDeferredSince, now)
    || gitDeferralReasonPrecedence(a.displayReason) - gitDeferralReasonPrecedence(b.displayReason)
    || a.repo.localeCompare(b.repo)
  );
}

/** Pure, terminal-safe local rendering. Detached checkouts never expose an OID. */
export function renderGitDeferralLine(input: {
  relPath: string;
  reason: string;
  deferredSince: string;
  checkout?: { kind: "branch" | "detached"; label?: string };
  bytesChanged?: boolean;
  now: number;
  capability?: CheckoutTransactionCapability;
}): string {
  const checkout = input.checkout?.kind === "branch"
    ? `branch ${input.checkout.label ? truncateDetail(input.checkout.label) : "(unknown)"}`
    : input.checkout?.kind === "detached"
      ? "detached checkout"
      : "checkout unavailable";
  const changed = input.bytesChanged ? " (working files changed since)" : "";
  const reason = input.reason === "unsupported" && input.capability
    ? `needs Git >= 2.46 transactional symref-update${input.capability.version ? `; found ${truncateDetail(input.capability.version)}` : `; ${input.capability.status}`}`
    : gitDeferralReasonText(input.reason);
  return `git deferred ${ageBucket(input.deferredSince, input.now)}: ${reason} on ${checkout} (${truncateDetail(input.relPath)})${changed}`;
}

/** Status-only explanation for the byte-frozen `git deferred` record above.
 * This line is never written to daemon logs or diagnostics, so the parsers of
 * the shared record keep their exact grammar and privacy boundary. */
export function renderGitDeferralCompanion(input: {
  reason: string;
  canResolve: boolean;
  canKeepMine: boolean;
  staleLockDetail?: { lockCount: number; oldestAgeMs: number; samplePath: string };
}): string {
  const presentation = gitDeferralReasonPresentation(input.reason);
  const reassurance = `Your repository is healthy; only rbox's bookkeeping is paused (${presentation.label}).`;
  if (input.reason === "stale-unattributed" && input.staleLockDetail) {
    const detail = input.staleLockDetail;
    const count = `${detail.lockCount} stable lock${detail.lockCount === 1 ? "" : "s"}`;
    const oldestSeconds = Math.max(0, Math.floor(detail.oldestAgeMs / 1000));
    const oldest = oldestSeconds < 60 ? `${oldestSeconds}s` : oldestSeconds < 3600
      ? `${Math.floor(oldestSeconds / 60)}m`
      : `${Math.floor(oldestSeconds / 3600)}h`;
    return `rbox found ${count} without a known live owner; oldest ${oldest} (for example ${truncateDetail(detail.samplePath)}). ` +
      "Run `rbox doctor`, confirm no Git process owns the reported locks, then remove only the verified stale lock files and let sync retry.";
  }
  if (!input.canResolve) return `${reassurance} ${presentation.repair}`;
  if (!input.canKeepMine) {
    return `${reassurance} Nothing is waiting to publish with \`keep-mine\`; ` +
      "`take-theirs` discards my local changes and follows the available incoming snapshot.";
  }
  return `${reassurance} To publish my work, run \`rbox git resolve <repo> keep-mine\`; ` +
    "`take-theirs` discards my local changes and follows incoming.";
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
 *  - byte-aware transfer phases render a byte-derived bar/percent and byte fraction;
 *    entry counts are never used as a transfer percentage.
 */
export function progressLabel(phase: TransferPhase, done: number, total: number, detail?: string, bytes?: TransferProgressBytes): string {
  if (phase === "scan") return `scanning… ${n(done)} files${bytes ? ` · ${formatDecimalBytes(bytes.bytesDone)}` : ""}`;
  const byteSuffix = bytes ? ` · ${formatProgressBytes(bytes)}` : "";
  if (phase === "gitcap") {
    const suffix = detail ? ` — ${truncateDetail(detail)}` : "";
    return `capturing git state ${n(done)}/${n(total)}${byteSuffix}${suffix}`;
  }
  // Determinate transfer phases. The final `?? "syncing"` is a defensive fallback so a
  // phase string an OLDER daemon never wrote (read from the user-editable activity file)
  // degrades to a sane verb rather than a misleading "downloading".
  const verb = phase === "encrypt" ? "encrypting" : phase === "upload" ? "uploading" : phase === "download" ? "downloading" : "syncing";
  if (bytes?.bytesTotal !== undefined && bytes.bytesTotal > 0) {
    const pct = Math.min(100, Math.max(0, Math.floor((bytes.bytesDone / bytes.bytesTotal) * 100)));
    const rate = phase === "upload" && bytes.bytesPerSecond !== undefined && Number.isFinite(bytes.bytesPerSecond) && bytes.bytesPerSecond > 0 ? ` · ${formatRate(bytes.bytesPerSecond)}` : "";
    const eta = phase === "upload" && bytes.etaSeconds !== undefined && Number.isFinite(bytes.etaSeconds) && bytes.etaSeconds >= 0 ? ` · ${formatEta(bytes.etaSeconds)}` : "";
    return `${verb} ${progressBar(pct)} ${pct}%${byteSuffix}${rate}${eta}`;
  }
  return `${verb} ${n(done)}/${n(total)}${byteSuffix}`;
}

function formatProgressBytes(bytes: TransferProgressBytes): string {
  if (bytes.bytesTotal !== undefined && bytes.bytesTotal > 0) return formatDecimalBytePair(bytes.bytesDone, bytes.bytesTotal);
  return `${formatDecimalBytes(bytes.bytesDone)} sent`;
}

const DECIMAL_PROGRESS_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
function formatDecimalBytePair(done: number, total: number): string {
  let unit = 0;
  let scaledTotal = Math.max(0, total);
  while (scaledTotal >= 1_000 && unit < DECIMAL_PROGRESS_UNITS.length - 1) {
    scaledTotal /= 1_000;
    unit++;
  }
  if (unit === 0) return `${Math.round(Math.max(0, done))} B / ${Math.round(scaledTotal)} B`;
  const divisor = 1_000 ** unit;
  return `${(Math.max(0, done) / divisor).toFixed(1)} ${DECIMAL_PROGRESS_UNITS[unit]} / ${scaledTotal.toFixed(1)} ${DECIMAL_PROGRESS_UNITS[unit]}`;
}

const progressBar = (pct: number): string => {
  const filled = Math.floor(pct / 20);
  return `${"▓".repeat(filled)}${"░".repeat(5 - filled)}`;
};

function formatRate(bytesPerSecond: number): string {
  const mb = Math.max(0, bytesPerSecond) / 1_000_000;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  const safe = Math.max(0, seconds);
  return safe < 60 ? `~${Math.round(safe)}s left` : `~${Math.max(1, Math.round(safe / 60))}m left`;
}

const activeBytes = (active: NonNullable<DaemonActivity["active"]>): TransferProgressBytes | undefined =>
  active.bytesDone !== undefined ? { bytesDone: active.bytesDone, bytesTotal: active.bytesTotal, bytesPerSecond: active.bytesPerSecond, etaSeconds: active.etaSeconds } : undefined;

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
  if (snapshot.git && snapshot.git.count > 0) {
    const repos = `${n(snapshot.git.count)} git repo${snapshot.git.count === 1 ? "" : "s"}`;
    const condition = snapshot.git.allLocalEditDeferrals
      ? "waiting on uncommitted changes"
      : snapshot.git.count === 1 ? "needs attention" : "need attention";
    lines.push(`⚠ ${repos} ${condition} (oldest: ${briefAge(snapshot.git.oldestDeferredSince, snapshot.now)}) · rbox status --git`);
  }
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
