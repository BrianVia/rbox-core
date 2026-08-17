import { PassThrough } from "node:stream";
import { countConflictCopies, diffManifests, type DiscoveredGitRepo, type IgnoreMatcher } from "../engine/index.js";
import { shellStateOf, type DaemonActivity } from "./activity.js";
import { DEFERRAL_LANES, repoRecordsForState, syncStreamId, type SyncState } from "./config.js";
import {
  knownRepoKeys,
} from "./sync-state-records.js";
import type { DaemonMode } from "./daemon/ambient-status.js";
import type { DaemonObservation } from "./daemon/observation.js";
import { buildPathWarnings, type PathWarningsV1 } from "./path-warnings.js";
import { projectLocalManifest } from "./local-file-projection.js";
import {
  attributeDaemonForStatus,
  projectGitDeferralRepos,
  type GitDeferralDisplayEntry,
  type StatusRemoteHead,
} from "./status-view.js";
import type { StatusDeferralDisplayDetails } from "./status-maintenance.js";
import type { GitDivergenceRepoHint, GitDivergenceStatus } from "./sync-git.js";
import { RBOX_VERSION } from "./version.js";
import { scopeProjectionFor } from "./scope/projection.js";
import { applyFolderPolicy } from "./folder-inventory.js";
import type {
  LocalGitDeferral,
  StatusCacheHint,
  StatusDaemonProjection,
  StatusDetailProjection,
  StatusGitProjection,
  StatusHaltProbes,
  StatusHaltProjection,
  StatusLocalCounts,
  StatusMode,
  StatusModeProbes,
  StatusProjectionCommon,
  StatusReadPort,
  StatusRefreshAuthority,
  StatusRequest,
  WorkspaceStatusProjection,
} from "./status-contract.js";

const LOCAL_TRUST_MS = 60_000;
const TRANSIENT_DEFERRAL_QUIET_MS = 10 * 60_000;

function localGitDeferrals(state: SyncState): LocalGitDeferral[] {
  const out: LocalGitDeferral[] = [];
  for (const [repo, record] of Object.entries(repoRecordsForState(state))) {
    for (const lane of DEFERRAL_LANES) {
      const deferral = record.deferrals?.[lane];
      if (deferral) out.push({ repo, ...deferral });
    }
  }
  return out.sort((a, b) => Date.parse(a.deferredSince) - Date.parse(b.deferredSince)
    || a.repo.localeCompare(b.repo)
    || DEFERRAL_LANES.indexOf(a.lane) - DEFERRAL_LANES.indexOf(b.lane));
}

const laneDeferrals = (state: SyncState): GitDivergenceStatus["deferrals"] =>
  localGitDeferrals(state).map(({ repo, ...deferral }) => ({ relPath: repo, ...deferral }));

function humanGitDeferralEntries<T extends GitDeferralDisplayEntry>(entries: T[], now: number): T[] {
  return entries.filter((entry) => {
    const projected = projectGitDeferralRepos([entry], now)[0];
    if (projected?.remediationClass !== "transient") return true;
    const deferredAt = Date.parse(entry.deferral.deferredSince);
    // Peer echoes on an actively committed repo arrive seconds behind local
    // state and self-supersede on the next push. Showing those brief holds as
    // attention trains users to ignore the banner or reach for take-theirs.
    return !Number.isFinite(deferredAt)
      || deferredAt > now
      || now - deferredAt >= TRANSIENT_DEFERRAL_QUIET_MS;
  });
}

function trustedLocalSnapshot(input: {
  activity: DaemonActivity | undefined;
  state: SyncState;
  now: number;
  daemon: Pick<DaemonObservation, "running" | "ownsWorkspace" | "bootId">;
}): { local: NonNullable<DaemonActivity["local"]>; ageMs: number } | undefined {
  if (!input.daemon.running || !input.daemon.ownsWorkspace) return undefined;
  if (input.daemon.bootId === undefined) return undefined;
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

interface GitRepoFeed {
  push: (repo: DiscoveredGitRepo) => void;
  close: () => void;
  iterable: AsyncIterable<DiscoveredGitRepo>;
}

function createGitRepoFeed(): GitRepoFeed {
  const feed = new PassThrough({ objectMode: true });
  let closed = false;
  return {
    push(repo) {
      if (closed) return;
      feed.write(repo);
    },
    close() {
      if (closed) return;
      closed = true;
      feed.end();
    },
    iterable: feed.iterator({ destroyOnReturn: false }) as AsyncIterable<DiscoveredGitRepo>,
  };
}

function projectHealth(input: {
  activity: DaemonActivity | undefined;
  populate?: { filesDone: number; filesTotal: number };
  localChanges: number;
  gitChanged: number;
  gitDeferrals: number;
  gitBytesChangedDeferrals: number;
  localSequence: number;
  remote: StatusRemoteHead | undefined;
  now: number;
}): "halt" | "outofstorage" | "active" | "pending" | "ok" {
  if (input.populate) return "active";
  const behind = input.remote?.sequence !== undefined && input.remote.sequence > input.localSequence;
  const settled = input.localChanges === 0
    && input.gitChanged === 0
    && input.gitDeferrals === 0
    && input.gitBytesChangedDeferrals === 0
    && !behind;
  return shellStateOf(input.activity ?? { at: new Date(input.now).toISOString() }, settled);
}

/** One root, one read-only projection, one surface's worth of facts. It performs
 * no deferral reconciliation and no hashcache writeback: both are named effects
 * of the `status-cmd.ts` composition root. */
export async function projectWorkspaceStatusDetail<M extends StatusMode>(
  root: string,
  request: StatusRequest<M>,
  port: StatusReadPort<M>,
  refresh: StatusRefreshAuthority,
): Promise<WorkspaceStatusProjection<M>> {
  const probes = port.probes;
  if (port.mode !== request.mode || probes.mode !== request.mode) {
    throw new Error(`status projection port is bound to mode ${probes.mode}, not ${request.mode}`);
  }

  const loadedCredentials = await port.readCredentials();
  const creds = loadedCredentials.state === "valid" ? loadedCredentials.credentials : undefined;
  const genesisPending = Boolean(creds?.accountId && await port.readPendingGenesis(creds.accountId));
  const observationNow = port.now();
  const workspaceObservation = await port.readWorkspaceObservation(root, { depth: "ambient", now: observationNow });
  const rawCfg = workspaceObservation.config;
  const admission = await port.readFolderAdmission?.(root);
  const policyCfg = admission?.kind === "admitted" ? applyFolderPolicy(rawCfg, admission.policy) : rawCfg;
  const cfg = { ...policyCfg, remoteUrl: creds?.remoteUrl ?? policyCfg.remoteUrl };
  const observedDaemon = workspaceObservation.daemon;
  const running = observedDaemon.running && !observedDaemon.stale;
  const daemonVersion = observedDaemon.version;
  const daemonMode: DaemonMode | undefined = observedDaemon.mode;
  // Trust visibility is admitted only through observation's live-incarnation,
  // current-workspace, fresh-heartbeat ambient proof.
  const watcherTrust = observedDaemon.trustedAmbient?.watcherTrust;
  const daemon: StatusDaemonProjection = {
    running,
    stale: observedDaemon.stale,
    version: daemonVersion,
    mode: daemonMode,
    versionSkew: daemonVersion !== undefined && daemonVersion !== RBOX_VERSION,
  };
  if (observedDaemon.pid !== undefined) daemon.pid = observedDaemon.pid;
  if (watcherTrust !== undefined) daemon.watcherTrust = watcherTrust;
  const workspace: StatusProjectionCommon["workspace"] = {
    id: cfg.remoteWorkspaceId,
    root,
    deviceId: cfg.deviceId,
    syncGit: cfg.syncGit === true,
  };
  if (cfg.name !== undefined) workspace.name = cfg.name;
  const common: StatusProjectionCommon = {
    workspace,
    daemon,
    credentials: loadedCredentials,
    bookkeeping: { promoteDaemonModeIntent: running },
  };

  // Design 138 F2b: this branch precedes every state read. The classifier and
  // health reader are both read-only, so a direct status invocation can explain
  // an unsafe standing transaction without helping the daemon mutate its side-file.
  const [resetInspection, resetHealth] = await Promise.all([
    port.inspectResetJournal(root, syncStreamId(cfg)),
    port.readResetHaltHealth(root),
  ]);
  if (resetInspection.status === "halt" || resetHealth !== undefined) {
    const halt: StatusHaltProjection & { probes: StatusHaltProbes } = {
      kind: "reset-halt",
      ...common,
      reason: resetInspection.status === "halt" ? resetInspection.reason : "recovering",
      probes: probes.mode === "brief" || probes.mode === "git"
        ? { mode: probes.mode, account: await probes.readBriefAccount(loadedCredentials) }
        : { mode: probes.mode },
    };
    return halt as WorkspaceStatusProjection<M>;
  }

  const rawActivityP = workspaceObservation.readActivity();

  const accountSummaryP = probes.mode === "verbose" ? probes.readAccountSummary(loadedCredentials) : undefined;
  let state = await port.readState(root, syncStreamId(cfg));
  let hygieneDetails: StatusDeferralDisplayDetails = new Map();
  const runHygiene = async (): Promise<void> => {
    const receipt = await refresh.refresh(cfg, state);
    if (receipt.kind !== "refreshed") return;
    state = receipt.state;
    hygieneDetails = receipt.displayDetails;
  };
  await runHygiene();

  const pathWarningsP = port.readPathWarnings(root);
  const trashP = port.readTrashStats(root);
  const lockingP = port.readLockingHealth(root);
  const accountJsonP = probes.mode === "json" ? probes.readAccountUsage(loadedCredentials) : undefined;
  const rawActivity = await rawActivityP;
  const durablePathWarnings = await pathWarningsP;
  let pathWarnings: PathWarningsV1 | undefined = durablePathWarnings;
  const attributionNow = port.now();
  const attributeActivity = (base: SyncState) =>
    attributeDaemonForStatus({
      activity: rawActivity,
      daemon: observedDaemon,
      localSequence: base.lastSyncedSequence,
      now: attributionNow,
    });
  let attributed = attributeActivity(state);
  let activity = attributed.activity;
  let mustComputeLocal = false;
  if (localBaseSequenceMismatched(activity, state)) {
    state = await port.readState(root, syncStreamId(cfg));
    await runHygiene();
    attributed = attributeActivity(state);
    activity = attributed.activity;
    mustComputeLocal = true;
  }
  const remoteHeadP: Promise<StatusRemoteHead | undefined> = attributed.remote
    ? Promise.resolve(attributed.remote)
    : port.readRemoteSequence(cfg, creds).then((probed) => (probed !== undefined ? { sequence: probed, source: "probe" as const } : undefined));
  const populate = state.lastSyncedSequence === 0 ? await port.readPopulateStatus(root, cfg, attributionNow) : undefined;
  const trusted = mustComputeLocal
    ? undefined
    : trustedLocalSnapshot({
      activity,
      state,
      now: attributionNow,
      daemon: observedDaemon,
    });

  const evaluateGit = async (
    matcher: IgnoreMatcher | undefined,
    source?: readonly GitDivergenceRepoHint[] | AsyncIterable<GitDivergenceRepoHint>,
    includeBaseRepos = true,
  ): Promise<GitDivergenceStatus> => {
    const base = { pendingOnly: false, deferrals: laneDeferrals(state), configChecking: [] as string[], configDisabled: [], conflictSnapshots: { total: 0, prunable: 0 } };
    if (!cfg.syncGit) return { count: 0, indeterminate: false, ...base };
    try {
      if (port.gitDivergenceStatus) return await port.gitDivergenceStatus(root, cfg, state, matcher, source, includeBaseRepos);
      return { count: await port.gitDivergenceCount(root, cfg, state, matcher, source, includeBaseRepos), indeterminate: false, ...base };
    } catch {
      // Design 93 §6: an indeterminate config lane is conservatively divergent;
      // status must never collapse an evaluation failure to zero.
      return { count: 1, indeterminate: true, ...base, configChecking: ["*"] };
    }
  };

  // Design 212 §3.2: status consumes the same projection as everything else. Its
  // diff base must be scope-sized, or a binding that is working perfectly reports
  // every folder it deliberately does not hold as a local deletion.
  const statusRepoKeys = knownRepoKeys(state);
  const statusScope = await scopeProjectionFor(root, statusRepoKeys);
  const scopedBaseManifest = statusScope
    ? statusScope.projectFiles(state.lastSyncedManifest)
    : state.lastSyncedManifest;
  let counts: StatusLocalCounts;
  let cacheHint: StatusCacheHint | undefined;
  let strandedIgnored: number | undefined;
  let conflictCopies: number | undefined;
  if (trusted) {
    const matcher = port.buildMatcher(root, {
      respectGitignore: false,
      knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    });
    const repoHints = cfg.syncGit ? await port.gitDivergenceFastRepoSource(root, state.lastSyncedManifest.gitRepos, matcher) : [];
    const gitStatus = await evaluateGit(undefined, repoHints, false);
    strandedIgnored = trusted.local.strandedIgnored;
    conflictCopies = trusted.local.conflictCopies;
    counts = {
      added: trusted.local.added,
      changed: trusted.local.changed,
      // The daemon's deletion count is measured against the whole workspace. On a
      // scoped binding the folders it does not hold are absent on purpose, and the
      // daemon does not know which those are.
      deleted: statusScope ? 0 : trusted.local.deleted,
      trackedFiles: trusted.local.trackedFiles,
      gitChanged: gitStatus.count,
      gitDeferrals: gitStatus.deferrals,
      gitConfigChecking: gitStatus.configChecking,
      gitConfigDisabled: gitStatus.configDisabled,
      conflictSnapshots: gitStatus.conflictSnapshots,
      source: "daemon",
      ageMs: trusted.ageMs,
    };
  } else if (populate) {
    const conflictSnapshots = await port.readConflictSnapshotStatus(
      root,
      statusScope ? statusScope.probeKeys(statusRepoKeys) : statusRepoKeys,
    );
    counts = {
      added: 0,
      changed: 0,
      deleted: 0,
      trackedFiles: populate.operation.filesDone,
      gitChanged: 0,
      gitDeferrals: localGitDeferrals(state).filter(({ repo }) =>
        statusScope === undefined || statusScope.classifyRepo(repo) === "in").map(({ repo, ...d }) => {
        const projected: StatusLocalCounts["gitDeferrals"][number] = {
          relPath: repo,
          lane: d.lane,
          reason: d.reason,
          deferredSince: d.deferredSince,
        };
        if (d.bytesChanged !== undefined) projected.bytesChanged = d.bytesChanged;
        if (d.detail !== undefined) projected.detail = d.detail;
        return projected;
      }),
      conflictSnapshots,
      source: "computed",
    };
  } else {
    const matcher = port.buildMatcher(root, {
      respectGitignore: cfg.respectGitignore === true,
      knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    });
    const hashCache = await port.loadHashCache(root);
    const gitRepoFeed = createGitRepoFeed();
    const gitChangedP = evaluateGit(matcher, gitRepoFeed.iterable);
    let rawLocalManifest;
    try {
      rawLocalManifest = await port.scanManifest(root, matcher, hashCache, undefined, (repo) => gitRepoFeed.push(repo));
    } finally {
      gitRepoFeed.close();
    }
    cacheHint = { cache: hashCache, livePaths: () => new Set(rawLocalManifest.files.map((f) => f.path)) };
    const projected = projectLocalManifest(rawLocalManifest, scopedBaseManifest, matcher);
    const localManifest = projected.manifest;
    strandedIgnored = projected.strandedIgnored;
    // `rawLocalManifest`, never the post-carry manifest: only the raw scan is this disk.
    conflictCopies = countConflictCopies(rawLocalManifest.files);
    // A full status scan owns current read-only disk truth for this invocation.
    // It never mutates the durable sidecar; the passive loop remains its writer.
    pathWarnings = buildPathWarnings(projected.caseCollisions);
    const manifestDiff = diffManifests(scopedBaseManifest, localManifest);
    const gitStatus = await gitChangedP;
    counts = {
      added: manifestDiff.added.length,
      changed: manifestDiff.changed.length,
      deleted: manifestDiff.deleted.filter((p) => !matcher.ignores(p)).length,
      trackedFiles: localManifest.files.length,
      gitChanged: gitStatus.count,
      gitDeferrals: gitStatus.deferrals,
      gitConfigChecking: gitStatus.configChecking,
      gitConfigDisabled: gitStatus.configDisabled,
      conflictSnapshots: gitStatus.conflictSnapshots,
      source: "computed",
    };
  }

  const [remote, trash, locking] = await Promise.all([remoteHeadP, trashP, lockingP]);
  const localChanges = counts.added + counts.changed + counts.deleted;
  const now = port.now();
  const statusRecords = repoRecordsForState(state);
  const gitDeferrals = localGitDeferrals(state);
  const projectedGitEntries = counts.gitDeferrals.map((deferral) => ({
    repo: deferral.relPath,
    deferral,
    record: statusRecords[deferral.relPath],
  }));
  const localGitEntries = gitDeferrals.map((deferral) => ({
    repo: deferral.repo,
    deferral,
    record: statusRecords[deferral.repo],
  }));
  const projectedRepos = projectGitDeferralRepos(projectedGitEntries, now);
  const humanProjectedRepos = projectGitDeferralRepos(humanGitDeferralEntries(projectedGitEntries, now), now);
  const active = activity?.active;
  const live = active && Date.now() - Date.parse(active.at) < 60_000 ? active : undefined;
  const git: StatusGitProjection = {
    deferrals: gitDeferrals,
    projectedRepos,
    localRepoProjections: projectGitDeferralRepos(localGitEntries, now),
    humanProjectedRepos,
    humanLocalRepoProjections: projectGitDeferralRepos(humanGitDeferralEntries(localGitEntries, now), now),
    deferredRepos: projectedRepos.length,
    bytesChangedDeferrals: projectedRepos.filter((repo) => repo.bytesChanged).length,
  };
  if (projectedRepos.some((repo) => repo.displayReason === "unsupported")) {
    git.capability = await port.readCheckoutTransactionCapability(root);
  }
  if (live) git.live = live;

  const detail: StatusDetailProjection & { probes: StatusModeProbes } = {
    kind: "detail",
    ...common,
    genesisPending,
    state: {
      localSequence: state.lastSyncedSequence,
      syncedRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}).length,
      pendingRepos: Object.keys(state.gitPendingRemote ?? {}).length,
      conflictRepos: Object.keys(state.gitNeedsResolution ?? {}).length,
    },
    activity,
    remote,
    remoteLine: attributed.remoteLine,
    counts,
    localChanges,
    health: projectHealth({
      activity,
      populate: populate?.operation,
      localChanges,
      gitChanged: counts.gitChanged,
      gitDeferrals: git.deferredRepos,
      gitBytesChangedDeferrals: git.bytesChangedDeferrals,
      localSequence: state.lastSyncedSequence,
      remote,
      now,
    }),
    populate,
    trash,
    locking,
    crypto: port.readCryptoPoolStatus(),
    pathWarnings,
    git,
    hygieneDetails,
    cacheHint,
    now,
    probes: probes.mode === "json"
      ? { mode: "json", account: (await accountJsonP)! }
      : probes.mode === "verbose"
        ? { mode: "verbose", accountSummary: (await accountSummaryP)!, metrics: await probes.readMetrics(root), update: await probes.readUpdateState() }
        : { mode: probes.mode, account: await probes.readBriefAccount(loadedCredentials), update: await probes.readUpdateState() },
  };
  if (strandedIgnored !== undefined) detail.strandedIgnored = strandedIgnored;
  if (conflictCopies !== undefined) detail.conflictCopies = conflictCopies;
  return detail as WorkspaceStatusProjection<M>;
}
