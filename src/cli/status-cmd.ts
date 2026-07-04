import { buildIgnoreMatcher, diffManifests, scanManifest } from "../engine/index.js";
import { trashStats } from "../engine/trash.js";
import { loadActivity, shellStateOf, type DaemonActivity } from "./activity.js";
import { fetchAccountSummary, formatAccountSummary } from "./account-cmd.js";
import { loadConfig, loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import { daemonBindingStatus } from "./daemon-control.js";
import { emitJson } from "./json.js";
import { loadMetrics } from "./metrics.js";
import {
  attributeDaemonForStatus,
  healthLine,
  lastSyncLines,
  trashLine,
  type StatusRemoteHead,
} from "./status-view.js";
import { gitDivergenceCount } from "./sync-git.js";
import { style } from "./style.js";
import { formatUpdateAvailableLine, readUpdateCheckState } from "./update-check.js";
import { shortWorkspaceId } from "./workspace-picker.js";

interface StatusAccountJson {
  plan: string | null;
  usedBytes: number | null;
  capBytes: number | null;
}

async function fetchRemoteSequence(
  cfg: WorkspaceConfig,
  creds: { token: string; remoteUrl?: string } | undefined,
  timeoutMs = 2500
): Promise<number | undefined> {
  try {
    const token = creds?.token || cfg.token;
    if (!token) return undefined;
    const base = creds?.remoteUrl ?? cfg.remoteUrl;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/v1/ws/${cfg.remoteWorkspaceId}/proj/${cfg.projectId}/latest`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.ok) return undefined;
      const seq = ((await res.json()) as { sequence?: number }).sequence;
      return typeof seq === "number" ? seq : undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

async function fetchStatusAccountJson(creds: Credentials | undefined, timeoutMs = 3500): Promise<StatusAccountJson> {
  const unavailable = { plan: null, usedBytes: null, capBytes: null };
  if (!creds) return unavailable;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${creds.remoteUrl}/v1/account/usage`, {
      headers: { authorization: `Bearer ${creds.token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return unavailable;
    const body = (await res.json()) as { plan?: unknown; usedBytes?: unknown; storageCap?: unknown };
    if (typeof body.plan !== "string" || typeof body.usedBytes !== "number") return unavailable;
    const capBytes = body.storageCap === null || typeof body.storageCap === "number" ? body.storageCap : null;
    return { plan: body.plan, usedBytes: body.usedBytes, capBytes };
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
  }
}

function statusHealthJson(input: {
  activity: DaemonActivity | undefined;
  localChanges: number;
  gitChanged: number;
  localSequence: number;
  remote: StatusRemoteHead | undefined;
  now: number;
}): "halt" | "outofstorage" | "active" | "pending" | "ok" {
  const behind = input.remote?.sequence !== undefined && input.remote.sequence > input.localSequence;
  const settled = input.localChanges === 0 && input.gitChanged === 0 && !behind;
  return shellStateOf(input.activity ?? { at: new Date(input.now).toISOString() }, settled);
}

export async function statusCmd(root: string, opts: { json?: boolean } = {}): Promise<void> {
  const creds = await loadCredentials().catch(() => undefined);
  const rawCfg = await loadConfig(root);
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  const state = await loadState(root, syncStreamId(cfg));
  const matcher = buildIgnoreMatcher(root);
  const local = await scanManifest(root, matcher);

  const daemonBinding = daemonBindingStatus(root, cfg.remoteWorkspaceId);
  const alive = daemonBinding.alive;
  const daemonStale = daemonBinding.stale;
  const bg = { running: alive.running && !daemonStale, pid: alive.pid };

  const activityP = daemonStale ? Promise.resolve(undefined) : loadActivity(root);
  const gitChangedP = gitDivergenceCount(root, cfg, state, matcher).catch(() => 0);
  const trashP = trashStats(root).catch(() => undefined);
  const accountJsonP = opts.json ? fetchStatusAccountJson(creds) : Promise.resolve(null);
  const rawActivity = await activityP;
  const attributed = attributeDaemonForStatus({
    activity: rawActivity,
    daemonRunning: bg.running,
    boundWorkspaceId: daemonBinding.bound,
    currentWorkspaceId: cfg.remoteWorkspaceId,
    livePidfileBootId: alive.bootId,
    localSequence: state.lastSyncedSequence,
    now: Date.now(),
  });
  let remote: StatusRemoteHead | undefined = attributed.remote;
  if (!remote) {
    const probed = await fetchRemoteSequence(cfg, creds);
    if (probed !== undefined) remote = { sequence: probed, source: "probe" };
  }
  const [gitChanged, trash, accountJson] = await Promise.all([gitChangedP, trashP, accountJsonP]);
  const activity = attributed.activity;
  const d = diffManifests(state.lastSyncedManifest, local);
  const deleted = d.deleted.filter((p) => !matcher.ignores(p)).length;
  const localChanges = d.added.length + d.changed.length + deleted;
  const now = Date.now();

  if (opts.json) {
    emitJson({
      workspace: { id: cfg.remoteWorkspaceId, name: cfg.name ?? null, root },
      health: statusHealthJson({
        activity,
        localChanges,
        gitChanged,
        localSequence: state.lastSyncedSequence,
        remote,
        now,
      }),
      daemon: { running: bg.running, pid: bg.pid ?? null },
      remote: remote ? { sequence: remote.sequence, source: remote.source } : null,
      trash: trash && trash.files > 0 ? { bytes: trash.bytes, count: trash.files } : null,
      account: accountJson,
    });
    return;
  }

  const wsLabel = cfg.name
    ? `${style.cyan(cfg.name)} ${style.dim("@")} ${root} ${style.dim(`(${shortWorkspaceId(cfg.remoteWorkspaceId)})`)}`
    : `${style.cyan(cfg.remoteWorkspaceId)} ${style.dim("@")} ${root}`;
  console.log(`${style.bold("workspace")} ${wsLabel}`);
  console.log(
    `  ${healthLine({
      added: d.added.length,
      changed: d.changed.length,
      deleted,
      gitChanged,
      trackedFiles: local.files.length,
      daemonRunning: bg.running,
      localSequence: state.lastSyncedSequence,
      remote,
      activity,
      now,
    })}`
  );
  if (attributed.remoteLine) console.log(`  ${attributed.remoteLine}`);
  for (const trail of lastSyncLines(activity, now)) console.log(`  ${style.dim(trail)}`);
  console.log(
    `  ${style.dim("background sync:")} ${
      daemonStale
        ? style.yellow(`running but bound to a previous workspace (pid ${alive.pid}) — run \`rbox start\` to rebind`)
        : bg.running
          ? style.green(`running (pid ${bg.pid})`)
          : style.yellow("stopped")
    }`
  );
  if (cfg.syncGit) {
    const synced = Object.keys(state.lastSyncedManifest.gitRepos ?? {}).length;
    const pending = Object.keys(state.gitPendingRemote ?? {}).length;
    const conflicts = Object.keys(state.gitNeedsResolution ?? {}).length;
    const parts = [style.green(`${synced} repo${synced === 1 ? "" : "s"} synced`)];
    if (pending) parts.push(style.yellow(`${pending} pending`));
    if (conflicts) parts.push(style.yellow(`${conflicts} conflict${conflicts === 1 ? "" : "s"}`));
    console.log(`  ${style.dim("git-sync:")} ${parts.join(" · ")}`);
  }
  const m = await loadMetrics(root);
  if (m.syncs > 0 || m.commitConflicts409 > 0 || m.fileConflicts > 0) {
    const conf = m.commitConflicts409 + m.fileConflicts;
    console.log(
      `  ${style.dim("sync metrics:")} ${m.syncs} syncs, ${conf ? style.yellow(`${m.commitConflicts409} commit-409 / ${m.fileConflicts} file-conflict`) : style.green("0 conflicts")}${m.lastConflictAt ? style.dim(` (last ${m.lastConflictAt})`) : ""}`
    );
  }
  const trashStatus = trashLine(trash);
  if (trashStatus) console.log(`  ${trashStatus}`);
  console.log(`  ${style.dim(`device ${cfg.deviceId} · sequence ${state.lastSyncedSequence} · ${local.files.length.toLocaleString("en-US")} files on disk`)}`);
  for (const line of formatAccountSummary(await fetchAccountSummary())) console.log(line);
  const updateLine = formatUpdateAvailableLine(await readUpdateCheckState());
  if (updateLine) console.log(`  ${updateLine}`);
}
