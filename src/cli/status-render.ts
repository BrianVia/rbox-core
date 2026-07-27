import path from "node:path";
import { isSafetyHaltReason } from "./activity.js";
import { RBOX_VERSION } from "./version.js";
import { formatAccountSummary } from "./account-cmd.js";
import type { CredentialLoadResult } from "./credentials.js";
import {
  aggregatePlanQuotaAttention,
  briefBehindRemote,
  briefWorkspaceLabel,
  freshBriefActive,
  healthDetailLines,
  healthLine,
  lastSyncLines,
  renderBriefStatus,
  renderGitDeferralCompanion,
  renderGitDeferralLine,
  trashLine,
  type BriefHaltReason,
  type BriefStatusSnapshot,
} from "./status-view.js";
import { style } from "./style.js";
import { formatUpdateAvailableLine, updateAvailableVersion } from "./update-check.js";
import { shortWorkspaceId } from "./workspace-picker.js";
import { serializeGitDeferralLanes } from "./sync-git/git-deferral-json.js";
import { statusStaleLockDetail } from "./status-maintenance.js";
import { GENESIS_PENDING_MESSAGE } from "./genesis-durable.js";
import type { StatusMode, WorkspaceStatusProjection } from "./status-contract.js";

type HaltProjection = Extract<WorkspaceStatusProjection<StatusMode>, { kind: "reset-halt" }>;
type DetailProjection<M extends StatusMode> = Extract<WorkspaceStatusProjection<M>, { kind: "detail" }>;

/** The one thing a status surface produces. The composition root owns emission
 * so no renderer can reorder or interleave what reaches stdout. */
export type StatusSurfaceRender =
  | { surface: "json"; payload: Record<string, unknown>; daemonRunning: boolean }
  | { surface: "lines"; lines: string[]; daemonRunning: boolean };

function credentialStatusJson(loaded: CredentialLoadResult): Record<string, unknown> {
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
): StatusSurfaceRender {
  if (projection.kind === "reset-halt") return renderResetHalt(projection);
  const daemonRunning = projection.daemon.running;
  if (projection.probes.mode === "json") {
    return { surface: "json", payload: renderStatusJson(projection as DetailProjection<"json">), daemonRunning };
  }
  if (projection.probes.mode === "verbose") {
    return { surface: "lines", lines: renderStatusVerbose(projection as DetailProjection<"verbose">), daemonRunning };
  }
  return { surface: "lines", lines: renderStatusBrief(projection as DetailProjection<"brief" | "git">), daemonRunning };
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
        halted: true,
        reason: projection.reason,
        daemon: { running: daemon.running, pid: daemon.pid ?? null },
        credential: credentialStatusJson(credentials),
      },
    };
  }
  if (probes.mode !== "verbose") {
    const rendered = renderBriefStatus({
      kind: "reset-halt",
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
  lines.push(`  ${style.yellow(`sync halted: a state-recovery record can't be processed (${projection.reason}). Files on disk are untouched; run \`rbox doctor reset-journal\`.`)}`);
  lines.push(`  ${style.dim("background sync:")} ${daemon.stale
    ? style.yellow(`running but bound to a previous workspace (pid ${daemon.pid})`)
    : daemon.running ? style.green(`${runningDaemonLabel(daemon.version, daemon.mode)} (pid ${daemon.pid})`) : style.yellow("stopped")}`);
  return { surface: "lines", lines, daemonRunning };
}

export function renderStatusJson(projection: DetailProjection<"json">): Record<string, unknown> {
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
    },
    locking: {
      status: locking.status,
      reason: locking.status === "ok" ? null : locking.reason,
      path: ".rbox/state/sync.lock",
    },
    remote: projection.remote ? { sequence: projection.remote.sequence, source: projection.remote.source } : null,
    ...(counts.source === "daemon"
      ? {
        local: {
          added: counts.added,
          changed: counts.changed,
          deleted: counts.deleted,
          gitChangedRepos: counts.gitChanged,
          source: counts.source,
          ageMs: counts.ageMs,
        },
      }
      : {}),
    trash: projection.trash && projection.trash.files > 0 ? { bytes: projection.trash.bytes, count: projection.trash.files } : null,
    account: projection.probes.account,
    credential: credentialStatusJson(projection.credentials),
    ...(projection.genesisPending ? { genesisPending: true, resumeInstruction: GENESIS_PENDING_MESSAGE } : {}),
    crypto: projection.crypto,
    git: {
      ...(git.capability ? { capability: git.capability } : {}),
      deferrals: serializeGitDeferralLanes(git.deferrals.map(({ repo, ...deferral }) => ({ repo, deferral })), now),
      deferredRepos: git.localRepoProjections.map((repo) => ({
        repo: repo.repo,
        oldestDeferredSince: repo.oldestDeferredSince,
        displayReason: repo.displayReason,
        ageSeconds: Number.isFinite(Date.parse(repo.oldestDeferredSince)) && Date.parse(repo.oldestDeferredSince) <= now
          ? Math.floor((now - Date.parse(repo.oldestDeferredSince)) / 1000)
          : null,
        bytesChanged: repo.bytesChanged,
        ...(repo.checkout?.kind === "branch"
          ? { checkout: { kind: "branch" as const, ...(repo.checkout.label === undefined ? {} : { label: repo.checkout.label }) } }
          : repo.checkout?.kind === "detached"
            ? { checkout: { kind: "detached" as const } }
            : {}),
      })),
      conflictSnapshots: counts.conflictSnapshots,
    },
    ...(counts.gitConfigChecking?.length || counts.gitConfigDisabled?.length
      ? {
        gitConfig: {
          state: counts.gitConfigChecking?.length ? "checking" : "disabled",
          checking: counts.gitConfigChecking ?? [],
          disabled: counts.gitConfigDisabled ?? [],
        },
      }
      : {}),
    ...(activity?.halt?.reason !== undefined ? { haltReason: activity.halt.reason } : {}),
    pathWarnings: projection.pathWarnings ?? null,
  };
}

export function renderStatusBrief(projection: DetailProjection<"brief" | "git">): string[] {
  const { workspace, daemon, counts, git, activity, populate } = projection;
  const gitDetail = projection.probes.mode === "git";
  const now = projection.now;
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
        : typedHalt?.kind === "body-too-large"
          ? { kind: "body-too-large" }
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
    ...(active ? { active } : {}),
    ...(populate ? { populate: { filesDone: populate.operation.filesDone, filesTotal: populate.operation.filesTotal } } : {}),
    behindRemote: briefBehindRemote(projection.state.localSequence, projection.remote),
    ...(halt ? { halt } : {}),
    ...(retryArmed && activity?.halt?.nextProbeAt && daemon.mode !== "pull-only"
      ? { recovery: { nextProbeAt: activity.halt.nextProbeAt } }
      : retryRunning
        ? { recovery: { running: true as const } }
        : {}),
    planQuota,
    daemonVersion: daemon.version,
    cliVersion: RBOX_VERSION,
    daemonVersionSkew: daemon.versionSkew,
    locking: projection.locking,
    ...(projection.pathWarnings ? { pathWarnings: projection.pathWarnings } : {}),
    ...(git.humanProjectedRepos.length > 0
      ? {
        git: {
          count: git.humanProjectedRepos.length,
          oldestDeferredSince: git.humanProjectedRepos[0]!.oldestDeferredSince,
          allLocalEditDeferrals: git.humanProjectedRepos.every((repo) => repo.displayReason === "local-edits"),
        },
      }
      : {}),
    ...(projection.trash && projection.trash.files > 0 ? { trash: { files: projection.trash.files, bytes: projection.trash.bytes } } : {}),
    ...(nextVersion ? { update: { current: RBOX_VERSION, next: nextVersion } } : {}),
    now,
  };
  const lines = [...renderBriefStatus(brief).lines];
  if (projection.genesisPending) lines.push(`  ${style.yellow(GENESIS_PENDING_MESSAGE)}`);
  if (counts.conflictSnapshots.prunable > 0) {
    lines.push(`  conflict snapshots: ${counts.conflictSnapshots.total} (${counts.conflictSnapshots.prunable} prunable)`);
  }
  if (gitDetail) {
    for (const deferral of git.humanProjectedRepos) {
      lines.push(`  ${renderGitDeferralLine({
        relPath: deferral.repo,
        reason: deferral.displayReason,
        deferredSince: deferral.oldestDeferredSince,
        checkout: deferral.checkout,
        bytesChanged: deferral.bytesChanged,
        now,
        capability: deferral.displayReason === "unsupported" ? git.capability : undefined,
      })}`);
      lines.push(`    ${renderGitDeferralCompanion({
        reason: deferral.displayReason,
        canResolve: deferral.canResolve,
        canKeepMine: deferral.canKeepMine,
        staleLockDetail: statusStaleLockDetail(workspace.root, projection.hygieneDetails, deferral.repo, deferral.displayLane),
      })}`);
    }
  }
  return lines;
}

export function renderStatusVerbose(projection: DetailProjection<"verbose">): string[] {
  const { workspace, daemon, counts, git, activity, populate, locking, crypto } = projection;
  const now = projection.now;
  const lines = [verboseWorkspaceHeading(workspace)];
  if (projection.genesisPending) lines.push(`  ${style.yellow(GENESIS_PENDING_MESSAGE)}`);
  const statusSnapshot = {
    added: counts.added,
    changed: counts.changed,
    deleted: counts.deleted,
    gitChanged: counts.gitChanged,
    gitDeferrals: git.humanProjectedRepos.length,
    gitBytesChangedDeferrals: git.humanProjectedRepos.filter((repo) => repo.bytesChanged).length,
    gitOldestDeferral: git.humanProjectedRepos[0]
      ? { deferredSince: git.humanProjectedRepos[0].oldestDeferredSince, reason: git.humanProjectedRepos[0].displayReason }
      : undefined,
    trackedFiles: counts.trackedFiles,
    daemonRunning: daemon.running,
    localSequence: projection.state.localSequence,
    remote: projection.remote,
    activity,
    pathWarnings: projection.pathWarnings,
    populate: populate
      ? {
        phase: populate.operation.phase,
        filesDone: populate.operation.filesDone,
        filesTotal: populate.operation.filesTotal,
        ...(populate.operation.bytesDone !== undefined ? { bytesDone: populate.operation.bytesDone } : {}),
        ...(populate.operation.bytesTotal !== undefined ? { bytesTotal: populate.operation.bytesTotal } : {}),
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
    if (git.humanProjectedRepos.length) parts.push(style.yellow(`${git.humanProjectedRepos.length} deferred`));
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
    for (const deferral of git.humanLocalRepoProjections) {
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
        canResolve: deferral.canResolve,
        canKeepMine: deferral.canKeepMine,
        staleLockDetail: statusStaleLockDetail(workspace.root, projection.hygieneDetails, deferral.repo, deferral.displayLane),
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
