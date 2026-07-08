import { buildIgnoreMatcher, cryptoPoolStatus, diffManifests, HashCache, scanManifest, type DiscoveredGitRepo, type IgnoreMatcher } from "../engine/index.js";
import { trashStats } from "../engine/trash.js";
import { loadActivity, shellStateOf, type DaemonActivity } from "./activity.js";
import { RBOX_VERSION } from "./version.js";
import { fetchAccountSummary, formatAccountSummary } from "./account-cmd.js";
import { loadConfig, loadState, syncStreamId, type SyncState, type WorkspaceConfig } from "./config.js";
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
import { gitDivergenceCount, gitDivergenceFastRepoSource, type GitDivergenceRepoHint } from "./sync-git.js";
import { style } from "./style.js";
import { formatUpdateAvailableLine, readUpdateCheckState } from "./update-check.js";
import { shortWorkspaceId } from "./workspace-picker.js";
import { readFreshPopulateStatus } from "./populate-status.js";

interface StatusAccountJson {
  plan: string | null;
  usedBytes: number | null;
  capBytes: number | null;
}

interface StatusLocalCountsBase {
  added: number;
  changed: number;
  deleted: number;
  trackedFiles: number;
  gitChanged: number;
}

type StatusLocalCounts =
  | (StatusLocalCountsBase & { source: "computed" })
  | (StatusLocalCountsBase & { source: "daemon"; ageMs: number });

export interface StatusCmdDeps {
  now: () => number;
  loadHashCache: (root: string) => Promise<HashCache>;
  scanManifest: typeof scanManifest;
  gitDivergenceCount: typeof gitDivergenceCount;
  gitDivergenceFastRepoSource: (
    root: string,
    baseGitRepos: SyncState["lastSyncedManifest"]["gitRepos"],
    matcher: IgnoreMatcher
  ) => Promise<GitDivergenceRepoHint[]>;
  daemonBindingStatus: typeof daemonBindingStatus;
  readDaemonPidRecord: typeof readDaemonPidRecord;
}

const defaultStatusDeps: StatusCmdDeps = {
  now: () => Date.now(),
  loadHashCache: (root) => HashCache.load(root),
  scanManifest,
  gitDivergenceCount,
  gitDivergenceFastRepoSource,
  daemonBindingStatus,
  readDaemonPidRecord,
};

const LOCAL_TRUST_MS = 60_000;

function trustedLocalSnapshot(
  input: {
    activity: DaemonActivity | undefined;
    state: SyncState;
    now: number;
    daemonRunning: boolean;
    boundWorkspaceId?: string;
    currentWorkspaceId: string;
    livePidfileBootId?: string;
  }
): { local: NonNullable<DaemonActivity["local"]>; ageMs: number } | undefined {
  if (!input.daemonRunning) return undefined;
  if (input.boundWorkspaceId !== input.currentWorkspaceId) return undefined;
  if (input.livePidfileBootId === undefined) return undefined;
  const { activity, state, now } = input;
  if (!activity) return undefined;
  const local = activity.local;
  if (!local) return undefined;
  if (!activity.ws) return undefined;
  const ageMs = now - Date.parse(local.at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= LOCAL_TRUST_MS) return undefined;
  if (local.stream !== state.stream) return undefined;
  if (local.baseSequence !== state.lastSyncedSequence) return undefined;
  if (!local.settled) return undefined;
  return { local, ageMs };
}

function localBaseSequenceMismatched(activity: DaemonActivity | undefined, state: SyncState): boolean {
  const local = activity?.local;
  return local !== undefined && local.stream === state.stream && local.baseSequence !== state.lastSyncedSequence;
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
  populate?: { filesDone: number; filesTotal: number };
  localChanges: number;
  gitChanged: number;
  localSequence: number;
  remote: StatusRemoteHead | undefined;
  now: number;
}): "halt" | "outofstorage" | "active" | "pending" | "ok" {
  if (input.populate) return "active";
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
  return statusCmdWithDeps(root, opts, defaultStatusDeps);
}

export async function statusCmdWithDeps(
  root: string,
  opts: { json?: boolean } = {},
  deps: StatusCmdDeps = defaultStatusDeps
): Promise<void> {
  const creds = await loadCredentials().catch(() => undefined);
  const accountSummaryP = opts.json ? Promise.resolve(null) : fetchAccountSummary();
  const rawCfg = await loadConfig(root);
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  let state = await loadState(root, syncStreamId(cfg));

  const daemonBinding = deps.daemonBindingStatus(root, cfg.remoteWorkspaceId);
  const alive = daemonBinding.alive;
  const daemonStale = daemonBinding.stale;
  const bg = { running: alive.running && !daemonStale, pid: alive.pid };

  const activityP = daemonStale ? Promise.resolve(undefined) : loadActivity(root);
  const trashP = trashStats(root).catch(() => undefined);
  const accountJsonP = opts.json ? fetchStatusAccountJson(creds) : Promise.resolve(null);
  const rawActivity = await activityP;
  const attributionNow = deps.now();
  const attributeActivity = (base: SyncState) =>
    attributeDaemonForStatus({
      activity: rawActivity,
      daemonRunning: bg.running,
      boundWorkspaceId: daemonBinding.bound,
      currentWorkspaceId: cfg.remoteWorkspaceId,
      livePidfileBootId: alive.bootId,
      localSequence: base.lastSyncedSequence,
      now: attributionNow,
    });
  let attributed = attributeActivity(state);
  let activity = attributed.activity;
  let mustComputeLocal = false;
  if (localBaseSequenceMismatched(activity, state)) {
    state = await loadState(root, syncStreamId(cfg));
    attributed = attributeActivity(state);
    activity = attributed.activity;
    mustComputeLocal = true;
  }
  const remoteHeadP: Promise<StatusRemoteHead | undefined> = attributed.remote
    ? Promise.resolve(attributed.remote)
    : fetchRemoteSequence(cfg, creds).then((probed) => (probed !== undefined ? { sequence: probed, source: "probe" as const } : undefined));
  const populate = state.lastSyncedSequence === 0 ? await readFreshPopulateStatus(root, cfg, attributionNow).catch(() => undefined) : undefined;
  const trusted = mustComputeLocal
    ? undefined
    : trustedLocalSnapshot({
      activity,
      state,
      now: attributionNow,
      daemonRunning: bg.running,
      boundWorkspaceId: daemonBinding.bound,
      currentWorkspaceId: cfg.remoteWorkspaceId,
      livePidfileBootId: alive.bootId,
    });

  let counts: StatusLocalCounts;
  if (trusted) {
    const matcher = buildIgnoreMatcher(root, {
      respectGitignore: false,
      knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    });
    const repoHints = cfg.syncGit ? await deps.gitDivergenceFastRepoSource(root, state.lastSyncedManifest.gitRepos, matcher) : [];
    const gitChanged = await deps.gitDivergenceCount(root, cfg, state, undefined, repoHints, false).catch(() => 0);
    counts = {
      added: trusted.local.added,
      changed: trusted.local.changed,
      deleted: trusted.local.deleted,
      trackedFiles: trusted.local.trackedFiles,
      gitChanged,
      source: "daemon",
      ageMs: trusted.ageMs,
    };
  } else if (populate) {
    counts = {
      added: 0,
      changed: 0,
      deleted: 0,
      trackedFiles: populate.operation.filesDone,
      gitChanged: 0,
      source: "computed",
    };
  } else {
    const matcher = buildIgnoreMatcher(root, {
      respectGitignore: cfg.respectGitignore === true,
      knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    });
    const hashCache = await deps.loadHashCache(root);
    const gitRepoFeed = createGitRepoFeed();
    const gitChangedP = deps.gitDivergenceCount(root, cfg, state, matcher, gitRepoFeed.iterable).catch(() => 0);
    let localManifest;
    try {
      localManifest = await deps.scanManifest(root, matcher, hashCache, undefined, (repo) => gitRepoFeed.push(repo));
    } finally {
      gitRepoFeed.close();
    }
    if (!deps.readDaemonPidRecord(root).present) {
      hashCache.prune(new Set(localManifest.files.map((f) => f.path)));
      await hashCache.save(root, { beforeRename: () => !deps.readDaemonPidRecord(root).present }).catch(() => {});
    }
    const manifestDiff = diffManifests(state.lastSyncedManifest, localManifest);
    const deleted = manifestDiff.deleted.filter((p) => !matcher.ignores(p)).length;
    counts = {
      added: manifestDiff.added.length,
      changed: manifestDiff.changed.length,
      deleted,
      trackedFiles: localManifest.files.length,
      gitChanged: await gitChangedP,
      source: "computed",
    };
  }

  const [remote, trash, accountJson] = await Promise.all([remoteHeadP, trashP, accountJsonP]);
  const localChanges = counts.added + counts.changed + counts.deleted;
  const now = deps.now();
  const crypto = cryptoPoolStatus();

  if (opts.json) {
    const statusJson = {
      workspace: { id: cfg.remoteWorkspaceId, name: cfg.name ?? null, root },
      health: statusHealthJson({
        activity,
        populate: populate?.operation,
        localChanges,
        gitChanged: counts.gitChanged,
        localSequence: state.lastSyncedSequence,
        remote,
        now,
      }),
      daemon: { running: bg.running, pid: bg.pid ?? null },
      remote: remote ? { sequence: remote.sequence, source: remote.source } : null,
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
      trash: trash && trash.files > 0 ? { bytes: trash.bytes, count: trash.files } : null,
      account: accountJson,
      crypto,
    };
    emitJson(statusJson);
    return;
  }

  const wsLabel = cfg.name
    ? `${style.cyan(cfg.name)} ${style.dim("@")} ${root} ${style.dim(`(${shortWorkspaceId(cfg.remoteWorkspaceId)})`)}`
    : `${style.cyan(cfg.remoteWorkspaceId)} ${style.dim("@")} ${root}`;
  console.log(`${style.bold("workspace")} ${wsLabel} ${style.dim(`· rbox ${RBOX_VERSION}`)}`);
  const statusSnapshot = {
    added: counts.added,
    changed: counts.changed,
    deleted: counts.deleted,
    gitChanged: counts.gitChanged,
    trackedFiles: counts.trackedFiles,
    daemonRunning: bg.running,
    localSequence: state.lastSyncedSequence,
    remote,
    activity,
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
  if (attributed.remoteLine) console.log(`  ${attributed.remoteLine}`);
  if (crypto.state === "disabled") console.log(`  ${style.dim("crypto workers:")} ${style.yellow(`disabled — ${crypto.reason}`)}`);
  for (const trail of lastSyncLines(activity, now)) console.log(`  ${style.dim(trail)}`);
  console.log(
    `  ${style.dim("background sync:")} ${
      populate
        ? style.cyan(`initial sync in progress (pid ${populate.pid})`)
        : daemonStale
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
  console.log(`  ${style.dim(`device ${cfg.deviceId} · sequence ${state.lastSyncedSequence} · ${counts.trackedFiles.toLocaleString("en-US")} files on disk`)}`);
  for (const line of formatAccountSummary((await accountSummaryP)!)) console.log(line);
  const updateLine = formatUpdateAvailableLine(await readUpdateCheckState());
  if (updateLine) console.log(`  ${updateLine}`);
}
