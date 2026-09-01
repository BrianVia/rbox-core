import path from "node:path";
import { isSafetyHaltReason } from "./activity.js";
import { RBOX_VERSION } from "./version.js";
import { formatAccountSummary } from "./account-cmd.js";
import type { CredentialLoadResult } from "./credentials.js";
import {
  conflictCopiesLine,
  healthDetailLines,
  healthLine,
  lastSyncLines,
  strandedIgnoredLine,
  trashLine,
} from "./status-view.js";
import {
  aggregatePlanQuotaAttention,
  briefBehindRemote,
  briefWorkspaceLabel,
  freshBriefActive,
  renderBriefStatus,
  watcherTrustLine,
  type BriefHaltReason,
  type BriefStatusSnapshot,
} from "./status-view/brief.js";
import { renderGitDeferralCompanion, renderGitDeferralLine } from "./status-view/git-render.js";
import { gitPauseCounts, loudRows } from "./status-view/git-story-render.js";
import { rowNeedsYou, rowStuck } from "./status-view/git-projection.js";
import { gitRepoFallbackNote, renderGitPauseSection, renderGitSingleRepo } from "./status-render-git.js";
import { statusStaleLockDetail } from "./status-maintenance.js";
import { style } from "./style.js";
import { formatUpdateAvailableLine, updateAvailableVersion } from "./update-check.js";
import { shortWorkspaceId } from "./workspace-picker.js";
import { checkoutValue, serializeGitDeferralLanes } from "./sync-git/git-deferral-json.js";
import { GENESIS_PENDING_MESSAGE } from "./genesis-durable.js";
import type { StatusMode, StatusRenderOptions, WorkspaceStatusProjection } from "./status-contract.js";

export type { StatusRenderOptions } from "./status-contract.js";

type HaltProjection = Extract<WorkspaceStatusProjection<StatusMode>, { kind: "reset-halt" }>;
type DetailProjection<M extends StatusMode> = Extract<WorkspaceStatusProjection<M>, { kind: "detail" }>;

type ResetHaltJsonPayload = {
  workspace: { id: string; name: string | null; root: string };
  halted: boolean;
  reason: HaltProjection["reason"];
  daemon: { running: boolean; pid: number | null; watcherTrust: "suspect" | "fused" | null };
  credential: ReturnType<typeof credentialStatusJson>;
};

/** The one thing a status surface produces. The composition root owns emission
 * so no renderer can reorder or interleave what reaches stdout. */
export type StatusSurfaceRender =
  | { surface: "json"; payload: ReturnType<typeof renderStatusJson> | ResetHaltJsonPayload; daemonRunning: boolean }
  | { surface: "lines"; lines: string[]; daemonRunning: boolean };

function credentialStatusJson(loaded: CredentialLoadResult) {
  if (loaded.state === "valid" || loaded.state === "absent") return { state: loaded.state };
  if (loaded.state === "invalid-environment") return { state: "credential-degraded", reason: loaded.state, variable: loaded.variable };
  return { state: "credential-degraded", reason: loaded.state, path: loaded.path };
}

function runningDaemonLabel(version?: string, mode?: string): string {
  const details = [version === undefined ? undefined : `v${version}`, mode].filter((item): item is string => item !== undefined);
  return details.length === 0 ? "running" : `running (${details.join(", ")})`;
}

function daemonLine(daemon: DetailProjection<StatusMode>["daemon"], populatePid?: number): string {
  if (populatePid !== undefined) return style.cyan(`initial sync in progress (pid ${populatePid})`);
  if (daemon.stale) return style.yellow(`running but bound to a previous workspace (pid ${daemon.pid}) — run \`rbox start\` to rebind`);
  return daemon.running
    ? style.green(`${runningDaemonLabel(daemon.version, daemon.mode)} (pid ${daemon.pid})`)
    : style.yellow("stopped");
}

function verboseWorkspaceHeading(workspace: DetailProjection<StatusMode>["workspace"]): string {
  const label = workspace.name
    ? `${style.cyan(workspace.name)} ${style.dim("@")} ${workspace.root} ${style.dim(`(${shortWorkspaceId(workspace.id)})`)}`
    : `${style.cyan(workspace.id)} ${style.dim("@")} ${workspace.root}`;
  return `${style.bold("workspace")} ${label} ${style.dim(`· rbox ${RBOX_VERSION}`)}`;
}

/** Selects the one surface a projection's mode admits. */
export function renderWorkspaceStatusSurface<M extends StatusMode>(
  projection: WorkspaceStatusProjection<M>,
  options: StatusRenderOptions = {},
): StatusSurfaceRender {
  if (projection.kind === "reset-halt") return renderResetHalt(projection);
  const daemonRunning = projection.daemon.running;
  if (projection.probes.mode === "json") {
    return { surface: "json", payload: renderStatusJson(projection as DetailProjection<"json">), daemonRunning };
  }
  if (projection.probes.mode === "verbose") {
    return { surface: "lines", lines: renderStatusVerbose(projection as DetailProjection<"verbose">), daemonRunning };
  }
  const detail = projection as DetailProjection<"brief" | "git">;
  const repo = projection.probes.mode === "git" ? options.repo : undefined;
  const single = repo === undefined ? undefined : renderGitSingleRepo(detail, repo, options);
  if (single) return { surface: "lines", lines: single, daemonRunning };
  const lines = renderStatusBrief(detail, options);
  if (repo !== undefined) lines.unshift(...gitRepoFallbackNote(repo));
  return { surface: "lines", lines, daemonRunning };
}

export function renderResetHalt(projection: HaltProjection): StatusSurfaceRender {
  const { workspace, daemon, credentials, probes } = projection;
  const daemonRunning = daemon.running;
  if (probes.mode === "json") {
    return {
      surface: "json",
      daemonRunning,
      payload: {
        workspace: { id: workspace.id, name: workspace.name ?? null, root: workspace.root },
        halted: projection.halted,
        reason: projection.reason,
        daemon: { running: daemon.running, pid: daemon.pid ?? null, watcherTrust: daemon.watcherTrust ?? null },
        credential: credentialStatusJson(credentials),
      },
    };
  }
  if (probes.mode !== "verbose") {
    const rendered = renderBriefStatus({
      kind: "reset-halt",
      halted: projection.halted,
      workspaceLabel: briefWorkspaceLabel(workspace.name, path.basename(workspace.root)),
      daemonRunning: daemon.running,
      account: probes.account,
    });
    return { surface: "lines", lines: rendered.lines, daemonRunning: rendered.daemonRunning };
  }
  const lines = [verboseWorkspaceHeading(workspace)];
  if (credentials.state !== "valid" && credentials.state !== "absent") {
    const diagnostic = credentialStatusJson(credentials);
    lines.push(`  ${style.yellow(`credential-degraded: ${String(diagnostic.reason)} (${String(diagnostic.variable ?? diagnostic.path)})`)}`);
  }
  const recovering = `sync recovering: an unclean shutdown left write-ahead state${daemon.running ? " the daemon replays in place. Files on disk are untouched; no action needed." : " to replay. Files on disk are untouched; it recovers on the next daemon start — run \`rbox start\`."}`;
  lines.push(`  ${projection.halted ? style.yellow(`sync halted: a state-recovery record can't be processed (${projection.reason}). Files on disk are untouched; run \`rbox doctor reset-journal\`.`) : style.cyan(recovering)}`);
  lines.push(`  ${style.dim("background sync:")} ${daemon.stale
    ? style.yellow(`running but bound to a previous workspace (pid ${daemon.pid})`)
    : daemon.running ? style.green(`${runningDaemonLabel(daemon.version, daemon.mode)} (pid ${daemon.pid})`) : style.yellow("stopped")}`);
  if (daemon.watcherTrust) lines.push(`  ${style.dim("watcher trust:")} ${style.yellow(watcherTrustLine(daemon.watcherTrust).replace("watcher trust ", ""))}`);
  return { surface: "lines", lines, daemonRunning };
}

export function renderStatusJson(projection: DetailProjection<"json">) {
  const { workspace, daemon, counts, git, locking, activity } = projection;
  const now = projection.now;
  return {
    workspace: { id: workspace.id, name: workspace.name ?? null, root: workspace.root },
    health: projection.health,
    daemon: {
      running: daemon.running,
      pid: daemon.pid ?? null,
      version: daemon.version ?? null,
      mode: daemon.mode ?? null,
      cliVersion: RBOX_VERSION,
      versionSkew: daemon.versionSkew,
      watcherTrust: daemon.watcherTrust ?? null,
    },
    locking: {
      status: locking.status,
      reason: locking.status === "ok" ? null : locking.reason,
      path: ".rbox/state/sync.lock",
    },
    remote: projection.remote ? { sequence: projection.remote.sequence, source: projection.remote.source } : null,
    // Design 224 §2.3: deliberately OUTSIDE the `local` block, which is emitted
    // only for a daemon snapshot — the count exists on both branches.
    strandedIgnored: projection.strandedIgnored,
    conflictCopies: projection.conflictCopies,
    local: counts.source === "daemon"
      ? {
        added: counts.added,
        changed: counts.changed,
        deleted: counts.deleted,
        gitChangedRepos: counts.gitChanged,
        source: counts.source,
        ageMs: counts.ageMs,
      }
      : undefined,
    trash: projection.trash && projection.trash.files > 0 ? { bytes: projection.trash.bytes, count: projection.trash.files } : null,
    account: projection.probes.account,
    credential: credentialStatusJson(projection.credentials),
    genesisPending: projection.genesisPending ? true : undefined,
    resumeInstruction: projection.genesisPending ? GENESIS_PENDING_MESSAGE : undefined,
    crypto: projection.crypto,
    git: {
      capability: git.capability ? git.capability : undefined,
      deferrals: serializeGitDeferralLanes(git.deferrals.map(({ repo, ...deferral }) => ({ repo, deferral })), now),
      // Design 273 S5: EVERY repo, quiet rows included and flagged.
      // `displayReason` stays the machine contract; `story` is additive.
      deferredRepos: git.localRepoProjections.map((repo) => ({
        repo: repo.repo,
        oldestDeferredSince: repo.oldestDeferredSince,
        displayReason: repo.displayReason,
        story: repo.story.code,
        needsYou: rowNeedsYou(repo, now),
        stuck: rowStuck(repo, now),
        quiet: repo.quiet,
        remediationClass: repo.remediationClass,
        ageSeconds: Number.isFinite(Date.parse(repo.oldestDeferredSince)) && Date.parse(repo.oldestDeferredSince) <= now
          ? Math.floor((now - Date.parse(repo.oldestDeferredSince)) / 1000)
          : null,
        bytesChanged: repo.bytesChanged,
        checkout: checkoutValue(repo.checkout),
      })),
      conflictSnapshots: counts.conflictSnapshots,
    },
    gitConfig: counts.gitConfigChecking?.length || counts.gitConfigDisabled?.length
      ? {
        state: counts.gitConfigChecking?.length ? "checking" : "disabled",
        checking: counts.gitConfigChecking ?? [],
        disabled: counts.gitConfigDisabled ?? [],
      }
      : undefined,
    haltReason: activity?.halt?.reason,
    pathWarnings: projection.pathWarnings ?? null,
  };
}

export function renderStatusBrief(
  projection: DetailProjection<"brief" | "git">,
  options: StatusRenderOptions = {},
): string[] {
  const { workspace, daemon, counts, git, activity, populate } = projection;
  const gitDetail = projection.probes.mode === "git";
  const now = projection.now;
  const loudGitRepos = loudRows(git.projectedRepos);
  const account = projection.probes.account;
  const planQuota = aggregatePlanQuotaAttention(account, activity?.outOfStorage);
  const typedHalt = activity?.halt?.typedReason;
  const retryArmed = Boolean(daemon.running
    && activity?.halt?.nextProbeAt
    && activity.halt.recoveryState !== "suspended"
    && activity.halt.recoveryState !== "running"
    && !activity.halt.terminal
    && !isSafetyHaltReason(typedHalt?.kind));
  const retrySuspended = activity?.halt?.recoveryState === "suspended"
    && typedHalt?.kind !== "mass-delete"
    && typedHalt?.kind !== "chain-repair";
  const retryRunning = activity?.halt?.recoveryState === "running"
    && !activity.halt.terminal
    && typedHalt?.kind !== "mass-delete"
    && typedHalt?.kind !== "chain-repair";
  const halt: BriefHaltReason | undefined = activity?.halt && !retryArmed && !retrySuspended && !retryRunning
    ? typedHalt?.kind === "mass-delete"
      ? { kind: "mass-delete", op: typedHalt.op }
      : typedHalt?.kind === "too-many-refs"
        ? { kind: "too-many-refs" }
        : typedHalt?.kind === "too-many-entries"
          ? { kind: "too-many-entries" }
          : typedHalt?.kind === "body-too-large"
            ? { kind: "body-too-large" }
            : typedHalt?.kind === "chain-repair"
              ? { kind: "chain-repair" }
              : { kind: "unknown" }
    : undefined;
  const active = freshBriefActive(activity, daemon.running, now);
  const nextVersion = updateAvailableVersion(projection.probes.update);
  const brief: BriefStatusSnapshot = {
    kind: "full",
    workspaceLabel: briefWorkspaceLabel(workspace.name, path.basename(workspace.root)),
    daemonRunning: daemon.running,
    daemonStale: daemon.stale,
    account,
    pendingChanges: projection.localChanges + counts.gitChanged,
    active,
    populate: populate ? { filesDone: populate.operation.filesDone, filesTotal: populate.operation.filesTotal } : undefined,
    behindRemote: briefBehindRemote(projection.state.localSequence, projection.remote),
    halt,
    recovery: retryArmed && activity?.halt?.nextProbeAt && daemon.mode !== "pull-only"
      ? { nextProbeAt: activity.halt.nextProbeAt }
      : retryRunning
        ? { running: true as const }
        : undefined,
    planQuota,
    watcherTrust: daemon.watcherTrust,
    daemonVersion: daemon.version,
    cliVersion: RBOX_VERSION,
    daemonVersionSkew: daemon.versionSkew,
    locking: projection.locking,
    pathWarnings: projection.pathWarnings ? projection.pathWarnings : undefined,
    git: loudGitRepos.length > 0 ? { ...gitPauseCounts(loudGitRepos, now), listed: gitDetail } : undefined,
    trash: projection.trash && projection.trash.files > 0 ? { files: projection.trash.files, bytes: projection.trash.bytes } : undefined,
    update: nextVersion ? { current: RBOX_VERSION, next: nextVersion } : undefined,
    now,
  };
  const lines = [...renderBriefStatus(brief).lines];
  if (projection.genesisPending) lines.push(`  ${style.yellow(GENESIS_PENDING_MESSAGE)}`);
  if (counts.conflictSnapshots.prunable > 0) {
    lines.push(`  conflict snapshots: ${counts.conflictSnapshots.total} (${counts.conflictSnapshots.prunable} prunable)`);
  }
  const strandedLine = strandedIgnoredLine(projection.strandedIgnored);
  if (strandedLine) lines.push(`  ${strandedLine}`);
  const copiesLine = conflictCopiesLine(projection.conflictCopies);
  if (copiesLine) lines.push(`  ${copiesLine}`);
  // Design 273 S2: the grouped full-path listing replaces the per-repo
  // record/companion pair. That record grammar is untouched — it is the daemon
  // LOG line, whose redaction classifier is byte-frozen against it.
  if (gitDetail) lines.push(...renderGitPauseSection(projection, workspace.root, options));
  return lines;
}

export function renderStatusVerbose(projection: DetailProjection<"verbose">): string[] {
  const { workspace, daemon, counts, git, activity, populate, locking, crypto } = projection;
  const now = projection.now;
  const loudGitRepos = loudRows(git.projectedRepos);
  const lines = [verboseWorkspaceHeading(workspace)];
  if (projection.genesisPending) lines.push(`  ${style.yellow(GENESIS_PENDING_MESSAGE)}`);
  const statusSnapshot = {
    added: counts.added,
    changed: counts.changed,
    deleted: counts.deleted,
    gitChanged: counts.gitChanged,
    gitDeferrals: loudGitRepos.length,
    gitBytesChangedDeferrals: loudGitRepos.filter((repo) => repo.bytesChanged).length,
    gitOldestDeferral: loudGitRepos[0]
      ? { deferredSince: loudGitRepos[0].oldestDeferredSince, reason: loudGitRepos[0].displayReason }
      : undefined,
    trackedFiles: counts.trackedFiles,
    daemonRunning: daemon.running,
    localSequence: projection.state.localSequence,
    remote: projection.remote,
    activity,
    pathWarnings: projection.pathWarnings,
    strandedIgnored: projection.strandedIgnored,
    conflictCopies: projection.conflictCopies,
    populate: populate
      ? {
        phase: populate.operation.phase,
        filesDone: populate.operation.filesDone,
        filesTotal: populate.operation.filesTotal,
        bytesDone: populate.operation.bytesDone,
        bytesTotal: populate.operation.bytesTotal,
      }
      : undefined,
    now,
  };
  lines.push(`  ${healthLine(statusSnapshot)}`);
  for (const detail of healthDetailLines(statusSnapshot)) lines.push(`  ${detail}`);
  if (projection.remoteLine) lines.push(`  ${projection.remoteLine}`);
  if (crypto.state === "disabled") lines.push(`  ${style.dim("crypto workers:")} ${style.yellow(`disabled — ${crypto.reason}`)}`);
  for (const trail of lastSyncLines(activity, now)) lines.push(`  ${style.dim(trail)}`);
  lines.push(`  ${style.dim("background sync:")} ${daemonLine(daemon, populate?.pid)}`);
  if (daemon.watcherTrust) lines.push(`  ${style.dim("watcher trust:")} ${style.yellow(watcherTrustLine(daemon.watcherTrust).replace("watcher trust ", ""))}`);
  if (daemon.versionSkew) {
    lines.push(`  ${style.yellow(`daemon is running v${daemon.version} but this CLI is v${RBOX_VERSION} — restart to finish the upgrade: rbox stop && rbox start`)}`);
  }
  lines.push(`  ${style.dim("locking:")} ${locking.status === "ok"
    ? style.green("ok (.rbox/state/sync.lock)")
    : style.yellow(`${locking.status}: ${locking.reason} (.rbox/state/sync.lock)`)}`);
  if (workspace.syncGit || counts.gitDeferrals.length > 0) {
    const parts: string[] = [];
    // "0 repos synced" while the first publish is mid-flight reads as "doing
    // nothing" (founder repro). When a fresh cycle is running, say what's
    // actually happening; the gitcap phase even knows its counts.
    if (projection.state.syncedRepos === 0 && git.live) {
      parts.push(
        git.live.phase === "gitcap"
          ? style.cyan(`capturing ${git.live.done}/${git.live.total} repos — first publish in progress`)
          : style.cyan("first publish in progress")
      );
    } else {
      parts.push(style.green(`${projection.state.syncedRepos} repo${projection.state.syncedRepos === 1 ? "" : "s"} synced`));
    }
    if (projection.state.pendingRepos) parts.push(style.yellow(`${projection.state.pendingRepos} pending`));
    if (projection.state.conflictRepos) parts.push(style.yellow(`${projection.state.conflictRepos} conflict${projection.state.conflictRepos === 1 ? "" : "s"}`));
    if (loudGitRepos.length) parts.push(style.yellow(`${loudGitRepos.length} deferred`));
    if (counts.gitConfigChecking?.length) {
      const names = counts.gitConfigChecking.filter((rel) => rel !== "*");
      parts.push(style.yellow(`config: checking${names.length ? ` (${names.join(", ")})` : ""}`));
    }
    if (counts.gitConfigDisabled?.length) {
      parts.push(style.yellow(`config: disabled (${counts.gitConfigDisabled.map((issue) => `${issue.relPath}: ${issue.reason}`).join("; ")})`));
    }
    lines.push(`  ${style.dim("git-sync:")} ${parts.join(" · ")}`);
    if (counts.conflictSnapshots.prunable > 0) {
      lines.push(`  conflict snapshots: ${counts.conflictSnapshots.total} (${counts.conflictSnapshots.prunable} prunable)`);
    }
    for (const deferral of loudRows(git.localRepoProjections)) {
      lines.push(`    ${renderGitDeferralLine({
        relPath: deferral.repo,
        reason: deferral.displayReason,
        deferredSince: deferral.oldestDeferredSince,
        checkout: deferral.checkout,
        bytesChanged: deferral.bytesChanged,
        now,
        capability: deferral.displayReason === "unsupported" ? git.capability : undefined,
      })}`);
      lines.push(`      ${renderGitDeferralCompanion({
        reason: deferral.displayReason,
        // The projection's predicate, here too: raw canResolve/canKeepMine made
        // this companion a fourth offer-decider and handed keep-mine to holds.
        canResolve: deferral.resolvable,
        canKeepMine: deferral.resolvable && deferral.canKeepMine,
        staleLockDetail: statusStaleLockDetail(workspace.root, projection.hygieneDetails, deferral.repo, deferral.displayLane),
        detail: deferral.detail,
      })}`);
    }
  }
  const m = projection.probes.metrics;
  if (m.syncs > 0 || m.commitConflicts409 > 0 || m.fileConflicts > 0) {
    const conf = m.commitConflicts409 + m.fileConflicts;
    lines.push(
      `  ${style.dim("sync metrics:")} ${m.syncs} syncs, ${conf ? style.yellow(`${m.commitConflicts409} commit-409 / ${m.fileConflicts} file-conflict`) : style.green("0 conflicts")}${m.lastConflictAt ? style.dim(` (last ${m.lastConflictAt})`) : ""}`
    );
  }
  const trashStatus = trashLine(projection.trash);
  if (trashStatus) lines.push(`  ${trashStatus}`);
  lines.push(`  ${style.dim(`device ${workspace.deviceId} · sequence ${projection.state.localSequence} · ${counts.trackedFiles.toLocaleString("en-US")} files on disk`)}`);
  for (const line of formatAccountSummary(projection.probes.accountSummary)) lines.push(line);
  const updateLine = formatUpdateAvailableLine(projection.probes.update);
  if (updateLine) lines.push(`  ${updateLine}`);
  return lines;
}
