import { buildIgnoreMatcher, diffManifests, HashCache, scanManifest, type DiscoveredGitRepo } from "../engine/index.js";
import { trashStats } from "../engine/trash.js";
import { loadActivity, shellStateOf, type DaemonActivity } from "./activity.js";
import { RBOX_VERSION } from "./version.js";
import { fetchAccountSummary, formatAccountSummary } from "./account-cmd.js";
import { loadConfig, loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { loadCredentials, type Credentials } from "./credentials.js";
import { daemonBindingStatus, readDaemonPidRecord } from "./daemon-control.js";
import { emitJson } from "./json.js";
import { loadMetrics } from "./metrics.js";
import {
  attributeDaemonForStatus,
  healthDetailLines,
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

function createGitRepoFeed(): {
  push: (repo: DiscoveredGitRepo) => void;
  close: () => void;
  iterable: AsyncIterable<DiscoveredGitRepo>;
} {
  const queue: DiscoveredGitRepo[] = [];
  const waiters: Array<(result: IteratorResult<DiscoveredGitRepo>) => void> = [];
  let closed = false;

  return {
    push(repo) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: repo, done: false });
      else queue.push(repo);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<DiscoveredGitRepo>> {
            const repo = queue.shift();
            if (repo) return Promise.resolve({ value: repo, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => waiters.push(resolve));
          },
        };
      },
    },
  };
}

export async function statusCmd(root: string, opts: { json?: boolean } = {}): Promise<void> {
  const creds = await loadCredentials().catch(() => undefined);
  const accountSummaryP = opts.json ? Promise.resolve(null) : fetchAccountSummary();
  const rawCfg = await loadConfig(root);
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  const state = await loadState(root, syncStreamId(cfg));
  const matcher = buildIgnoreMatcher(root, {
    respectGitignore: cfg.respectGitignore === true,
    knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
  });
  const hashCache = await HashCache.load(root);
  const gitRepoFeed = createGitRepoFeed();
  const gitChangedP = gitDivergenceCount(root, cfg, state, matcher, gitRepoFeed.iterable).catch(() => 0);
  let local;
  try {
    local = await scanManifest(root, matcher, hashCache, undefined, (repo) => gitRepoFeed.push(repo));
  } finally {
    gitRepoFeed.close();
  }
  if (!readDaemonPidRecord(root).present) {
    hashCache.prune(new Set(local.files.map((f) => f.path)));
    await hashCache.save(root, { beforeRename: () => !readDaemonPidRecord(root).present }).catch(() => {});
  }

  const daemonBinding = daemonBindingStatus(root, cfg.remoteWorkspaceId);
  const alive = daemonBinding.alive;
  const daemonStale = daemonBinding.stale;
  const bg = { running: alive.running && !daemonStale, pid: alive.pid };

  const activityP = daemonStale ? Promise.resolve(undefined) : loadActivity(root);
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
  console.log(`${style.bold("workspace")} ${wsLabel} ${style.dim(`· rbox ${RBOX_VERSION}`)}`);
  const statusSnapshot = {
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
  };
  console.log(`  ${healthLine(statusSnapshot)}`);
  for (const detail of healthDetailLines(statusSnapshot)) console.log(`  ${detail}`);
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
    // "0 repos synced" while the first publish is mid-flight reads as "doing
    // nothing" (founder repro). When a fresh cycle is running, say what's
    // actually happening; the gitcap phase even knows its counts. Richer
    // persisted per-phase counters are design 69 §3.4.
    const act = activity?.active;
    const live = act && Date.now() - Date.parse(act.at) < 60_000 ? act : undefined;
    const parts: string[] = [];
    if (synced === 0 && live) {
      parts.push(
        live.phase === "gitcap"
          ? style.cyan(`capturing ${live.done}/${live.total} repos — first publish in progress`)
          : style.cyan("first publish in progress")
      );
    } else {
      parts.push(style.green(`${synced} repo${synced === 1 ? "" : "s"} synced`));
    }
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
  for (const line of formatAccountSummary((await accountSummaryP)!)) console.log(line);
  const updateLine = formatUpdateAvailableLine(await readUpdateCheckState());
  if (updateLine) console.log(`  ${updateLine}`);
}
