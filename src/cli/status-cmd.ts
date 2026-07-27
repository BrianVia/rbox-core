import path from "node:path";
import { isSafetyHaltReason } from "./activity.js";
import { RBOX_VERSION } from "./version.js";
import { formatAccountSummary } from "./account-cmd.js";
import type { CredentialLoadResult } from "./credentials.js";
import { emitJson } from "./json.js";
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
  type BriefIdentitySource,
  type BriefStatusSnapshot,
} from "./status-view.js";
import { style } from "./style.js";
import { formatUpdateAvailableLine, updateAvailableVersion } from "./update-check.js";
import { shortWorkspaceId } from "./workspace-picker.js";
import { serializeGitDeferralLanes } from "./sync-git/git-deferral-json.js";
import { refreshStatusDeferralAssertions, statusStaleLockDetail } from "./status-maintenance.js";
import { GENESIS_PENDING_MESSAGE } from "./genesis-durable.js";
import { projectWorkspaceStatusDetail } from "./status-projection.js";
import type { StatusCacheHint, StatusMode, WorkspaceStatusProjection } from "./status-contract.js";
import { createStatusReadPort, defaultStatusDeps, type StatusCmdDeps } from "./status-read-port.js";
import { reconcileGitDeferrals } from "./sync-git/deferral-hygiene.js";

export type { StatusCmdDeps } from "./status-read-port.js";
export type { StatusCacheHint } from "./status-contract.js";

export interface StatusCmdResult {
  daemonRunning: boolean;
}

export interface StatusCmdOptions {
  json?: boolean;
  verbose?: boolean;
  git?: boolean;
  now?: Date;
}

function assertPresentationFlags(opts: StatusCmdOptions): void {
  const selected = [opts.json, opts.verbose, opts.git].filter((value) => value === true).length;
  if (selected > 1) throw new Error("choose only one status presentation flag: --json, --verbose, or --git");
}

function credentialStatusJson(loaded: CredentialLoadResult): Record<string, unknown> {
  if (loaded.state === "valid" || loaded.state === "absent") return { state: loaded.state };
  if (loaded.state === "invalid-environment") return { state: "credential-degraded", reason: loaded.state, variable: loaded.variable };
  return { state: "credential-degraded", reason: loaded.state, path: loaded.path };
}

function runningDaemonLabel(version?: string, mode?: string): string {
  const details = [version === undefined ? undefined : `v${version}`, mode].filter((item): item is string => item !== undefined);
  return details.length === 0 ? "running" : `running (${details.join(", ")})`;
}

export type StatusCacheWriteReceipt =
  | { kind: "written" }
  | { kind: "skipped-not-owner" }
  | { kind: "write-failed" };

/** Best-effort fallback writeback of the scan's hashcache. It changes no sync
 * authority, and only a status invocation that still owns the workspace may
 * write — including at rename, which the daemon may have claimed by then. */
export async function saveStatusHashCache(
  root: string,
  hint: StatusCacheHint,
  ownsCache: (root: string) => boolean,
): Promise<StatusCacheWriteReceipt> {
  if (!ownsCache(root)) return { kind: "skipped-not-owner" };
  hint.cache.prune(hint.livePaths());
  let failed = false;
  await hint.cache.save(root, { beforeRename: () => ownsCache(root) }).catch(() => { failed = true; });
  return failed ? { kind: "write-failed" } : { kind: "written" };
}

export async function statusCmd(root: string, opts: StatusCmdOptions = {}): Promise<StatusCmdResult> {
  assertPresentationFlags(opts);
  const deps = opts.now === undefined
    ? defaultStatusDeps
    : { ...defaultStatusDeps, now: () => opts.now!.getTime() };
  return statusCmdWithDeps(root, opts, deps);
}

/** Interactive front-door seam: render the brief from a just-fetched identity
 * while the fetch's existing asynchronous profile-cache write settles. */
export async function statusCmdWithBriefIdentity(root: string, identity: BriefIdentitySource): Promise<StatusCmdResult> {
  return statusCmdWithDeps(root, {}, {
    ...defaultStatusDeps,
    readBriefIdentity: async () => identity,
  });
}

/** Project once, then run the two effects cycle 1 left to this root: the
 * best-effort desired-mode promotion and the fallback hashcache writeback. */
async function projectOnce<M extends StatusMode>(
  root: string,
  mode: M,
  deps: StatusCmdDeps,
): Promise<WorkspaceStatusProjection<M>> {
  const projection = await projectWorkspaceStatusDetail(root, { mode }, createStatusReadPort(mode, deps), {
    refresh: (cfg, state) => refreshStatusDeferralAssertions(root, {
      cfg,
      state,
      reconcile: deps.reconcileGitDeferrals ?? reconcileGitDeferrals,
    }),
  });
  // The boot-bound witness remains authoritative; status must still render if
  // the desired-state side file is temporarily unavailable.
  if (projection.bookkeeping.promoteDaemonModeIntent) await deps.promotePendingModeIntent?.(root).catch(() => false);
  if (projection.kind === "detail" && projection.cacheHint) {
    await saveStatusHashCache(root, projection.cacheHint, (owned) => !deps.readDaemonPidRecord(owned).present);
  }
  return projection;
}

export async function statusCmdWithDeps(
  root: string,
  opts: Omit<StatusCmdOptions, "now"> = {},
  deps: StatusCmdDeps = defaultStatusDeps
): Promise<StatusCmdResult> {
  assertPresentationFlags(opts);
  if (opts.json) {
    const projection = await projectOnce(root, "json", deps);
    return projection.kind === "reset-halt" ? renderResetHalt(projection) : renderStatusJson(projection);
  }
  if (opts.verbose) {
    const projection = await projectOnce(root, "verbose", deps);
    return projection.kind === "reset-halt" ? renderResetHalt(projection) : renderStatusVerbose(projection);
  }
  const projection = await projectOnce(root, opts.git === true ? "git" : "brief", deps);
  return projection.kind === "reset-halt" ? renderResetHalt(projection) : renderStatusBrief(projection, opts.git === true);
}

type HaltProjection = Extract<WorkspaceStatusProjection<StatusMode>, { kind: "reset-halt" }>;
type DetailProjection<M extends StatusMode> = Extract<WorkspaceStatusProjection<M>, { kind: "detail" }>;

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

function renderResetHalt(projection: HaltProjection): StatusCmdResult {
  const { workspace, daemon, credentials, probes } = projection;
  if (probes.mode === "json") {
    emitJson({
      workspace: { id: workspace.id, name: workspace.name ?? null, root: workspace.root },
      halted: true,
      reason: projection.reason,
      daemon: { running: daemon.running, pid: daemon.pid ?? null },
      credential: credentialStatusJson(credentials),
    });
    return { daemonRunning: daemon.running };
  }
  if (probes.mode !== "verbose") {
    const rendered = renderBriefStatus({
      kind: "reset-halt",
      workspaceLabel: briefWorkspaceLabel(workspace.name, path.basename(workspace.root)),
      daemonRunning: daemon.running,
      account: probes.account,
    });
    for (const line of rendered.lines) console.log(line);
    return { daemonRunning: rendered.daemonRunning };
  }
  console.log(verboseWorkspaceHeading(workspace));
  if (credentials.state !== "valid" && credentials.state !== "absent") {
    const diagnostic = credentialStatusJson(credentials);
    console.log(`  ${style.yellow(`credential-degraded: ${String(diagnostic.reason)} (${String(diagnostic.variable ?? diagnostic.path)})`)}`);
  }
  console.log(`  ${style.yellow(`sync halted: a state-recovery record can't be processed (${projection.reason}). Files on disk are untouched; run \`rbox doctor reset-journal\`.`)}`);
  console.log(`  ${style.dim("background sync:")} ${daemon.stale
    ? style.yellow(`running but bound to a previous workspace (pid ${daemon.pid})`)
    : daemon.running ? style.green(`${runningDaemonLabel(daemon.version, daemon.mode)} (pid ${daemon.pid})`) : style.yellow("stopped")}`);
  return { daemonRunning: daemon.running };
}

function renderStatusJson(projection: DetailProjection<"json">): StatusCmdResult {
  const { workspace, daemon, counts, git, locking, activity } = projection;
  const now = projection.now;
  emitJson({
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
  });
  return { daemonRunning: daemon.running };
}

function renderStatusBrief(projection: DetailProjection<"brief" | "git">, gitDetail: boolean): StatusCmdResult {
  const { workspace, daemon, counts, git, activity, populate } = projection;
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
  const rendered = renderBriefStatus(brief);
  for (const line of rendered.lines) console.log(line);
  if (projection.genesisPending) console.log(`  ${style.yellow(GENESIS_PENDING_MESSAGE)}`);
  if (counts.conflictSnapshots.prunable > 0) {
    console.log(`  conflict snapshots: ${counts.conflictSnapshots.total} (${counts.conflictSnapshots.prunable} prunable)`);
  }
  if (gitDetail) {
    for (const deferral of git.humanProjectedRepos) {
      console.log(`  ${renderGitDeferralLine({
        relPath: deferral.repo,
        reason: deferral.displayReason,
        deferredSince: deferral.oldestDeferredSince,
        checkout: deferral.checkout,
        bytesChanged: deferral.bytesChanged,
        now,
        capability: deferral.displayReason === "unsupported" ? git.capability : undefined,
      })}`);
      console.log(`    ${renderGitDeferralCompanion({
        reason: deferral.displayReason,
        canResolve: deferral.canResolve,
        canKeepMine: deferral.canKeepMine,
        staleLockDetail: statusStaleLockDetail(workspace.root, projection.hygieneDetails, deferral.repo, deferral.displayLane),
      })}`);
    }
  }
  return { daemonRunning: rendered.daemonRunning };
}

function renderStatusVerbose(projection: DetailProjection<"verbose">): StatusCmdResult {
  const { workspace, daemon, counts, git, activity, populate, locking, crypto } = projection;
  const now = projection.now;
  console.log(verboseWorkspaceHeading(workspace));
  if (projection.genesisPending) console.log(`  ${style.yellow(GENESIS_PENDING_MESSAGE)}`);
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
  console.log(`  ${healthLine(statusSnapshot)}`);
  for (const detail of healthDetailLines(statusSnapshot)) console.log(`  ${detail}`);
  if (projection.remoteLine) console.log(`  ${projection.remoteLine}`);
  if (crypto.state === "disabled") console.log(`  ${style.dim("crypto workers:")} ${style.yellow(`disabled — ${crypto.reason}`)}`);
  for (const trail of lastSyncLines(activity, now)) console.log(`  ${style.dim(trail)}`);
  console.log(`  ${style.dim("background sync:")} ${daemonLine(daemon, populate?.pid)}`);
  if (daemon.versionSkew) {
    console.log(`  ${style.yellow(`daemon is running v${daemon.version} but this CLI is v${RBOX_VERSION} — restart to finish the upgrade: rbox stop && rbox start`)}`);
  }
  console.log(`  ${style.dim("locking:")} ${locking.status === "ok"
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
    console.log(`  ${style.dim("git-sync:")} ${parts.join(" · ")}`);
    if (counts.conflictSnapshots.prunable > 0) {
      console.log(`  conflict snapshots: ${counts.conflictSnapshots.total} (${counts.conflictSnapshots.prunable} prunable)`);
    }
    for (const deferral of git.humanLocalRepoProjections) {
      console.log(`    ${renderGitDeferralLine({
        relPath: deferral.repo,
        reason: deferral.displayReason,
        deferredSince: deferral.oldestDeferredSince,
        checkout: deferral.checkout,
        bytesChanged: deferral.bytesChanged,
        now,
        capability: deferral.displayReason === "unsupported" ? git.capability : undefined,
      })}`);
      console.log(`      ${renderGitDeferralCompanion({
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
    console.log(
      `  ${style.dim("sync metrics:")} ${m.syncs} syncs, ${conf ? style.yellow(`${m.commitConflicts409} commit-409 / ${m.fileConflicts} file-conflict`) : style.green("0 conflicts")}${m.lastConflictAt ? style.dim(` (last ${m.lastConflictAt})`) : ""}`
    );
  }
  const trashStatus = trashLine(projection.trash);
  if (trashStatus) console.log(`  ${trashStatus}`);
  console.log(`  ${style.dim(`device ${workspace.deviceId} · sequence ${projection.state.localSequence} · ${counts.trackedFiles.toLocaleString("en-US")} files on disk`)}`);
  for (const line of formatAccountSummary(projection.probes.accountSummary)) console.log(line);
  const updateLine = formatUpdateAvailableLine(projection.probes.update);
  if (updateLine) console.log(`  ${updateLine}`);
  return { daemonRunning: daemon.running };
}
