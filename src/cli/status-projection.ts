import { countConflictCopies, diffManifests, dominatingNewDir, type DominantDir, type IgnoreMatcher } from "../engine/index.js";
import { shellStateOf, type DaemonActivity } from "./activity.js";
import { DEFERRAL_LANES, repoRecordsForState, syncStreamId, type SyncState } from "./config.js";
import {
  knownRepoKeys,
} from "./sync-state-records.js";
import type { DaemonMode } from "./daemon/ambient-status.js";
import type { DaemonObservation } from "./daemon/observation.js";
import { buildPathWarnings, type PathWarningsV1 } from "./path-warnings.js";
import { unhandledResetInspection } from "./reset-halt-inspection.js";
import { projectLocalManifest } from "./local-file-projection.js";
import { createGitRepoFeed } from "./status-git-repo-feed.js";
import { attributeDaemonForStatus, type StatusRemoteHead } from "./status-view.js";
import { projectGitDeferralRepos } from "./status-view/git-projection.js";
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

  // Design 138 F2b: this branch precedes every state read, and the classifier is
  // read-only, so a direct status invocation can explain an unsafe standing
  // transaction without helping the daemon mutate anything. Design 276 F2.1
  // routes `w1` through it too: not a halt, but it must never fall through to
  // `readState`, whose recovery would take the workspace sync mutex and attempt
  // a rival writer takeover against the live daemon.
  //
  // Design 276 F2.4: the second halt source is the live daemon's own lifecycle
  // over its ambient heartbeat, not the health-halt.json side-file this surface
  // no longer reads at all. A heartbeat cannot outlive the condition, and a dead
  // daemon needs no file because status already reports `daemon.running`.
  const resetInspection = await port.inspectResetJournal(root, syncStreamId(cfg));
  const halted = resetInspection.status === "halt"
    || observedDaemon.trustedAmbient?.resetLifecycle === "halted";
  if (halted || resetInspection.status === "w1") {
    const halt: StatusHaltProjection & { probes: StatusHaltProbes } = {
      kind: "reset-halt",
      ...common,
      halted,
      reason: resetInspection.status === "halt" ? resetInspection.reason : "recovering",
      probes: probes.mode === "brief" || probes.mode === "git"
        ? { mode: probes.mode, account: await probes.readBriefAccount(loadedCredentials) }
        : { mode: probes.mode },
    };
    return halt as WorkspaceStatusProjection<M>;
  }
  if (resetInspection.status !== "none" && resetInspection.status !== "recoverable") throw unhandledResetInspection(resetInspection);

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
  let dominantDir: DominantDir | undefined;
  // One definition of a status matcher; the branches differ only in gitignore.
  const statusMatcher = (respectGitignore: boolean) => port.buildMatcher(root, {
    respectGitignore,
    ignorePaths: cfg.ignorePaths ?? [],
    knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
  });
  if (trusted) {
    const matcher = statusMatcher(false);
    const repoHints = cfg.syncGit ? await port.gitDivergenceFastRepoSource(root, state.lastSyncedManifest.gitRepos, matcher) : [];
    const gitStatus = await evaluateGit(undefined, repoHints, false);
    strandedIgnored = trusted.local.strandedIgnored;
    conflictCopies = trusted.local.conflictCopies;
    dominantDir = trusted.local.dominantDir;
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
        // Same carrier, same law: every predicate input travels with the row.
        if (d.reasonSince !== undefined) projected.reasonSince = d.reasonSince;
        if (d.lastSeen !== undefined) projected.lastSeen = d.lastSeen;
        if (d.bytesChanged !== undefined) projected.bytesChanged = d.bytesChanged;
        if (d.detail !== undefined) projected.detail = d.detail;
        if (d.code !== undefined) projected.code = d.code;
        if (d.checkout !== undefined) projected.checkout = d.checkout;
        return projected;
      }),
      conflictSnapshots,
      source: "computed",
    };
  } else {
    const matcher = statusMatcher(cfg.respectGitignore === true);
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
    // #810: same rule the daemon applies, from a diff this branch already has.
    dominantDir = dominatingNewDir(manifestDiff.added, localManifest.files.length, state.lastSyncedSequence > 0);
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
  // Design 273 P5: ONE population. Every row carries its own `quiet` flag, and
  // each surface decides whether to omit or label those rows — no surface
  // re-derives the rule, so the headline and the listing cannot disagree.
  const projectedRepos = projectGitDeferralRepos(projectedGitEntries, now);
  const active = activity?.active;
  const live = active && Date.now() - Date.parse(active.at) < 60_000 ? active : undefined;
  const git: StatusGitProjection = {
    deferrals: gitDeferrals,
    projectedRepos,
    localRepoProjections: projectGitDeferralRepos(localGitEntries, now),
    records: statusRecords,
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
  if (dominantDir !== undefined) detail.dominantDir = dominantDir;
  return detail as WorkspaceStatusProjection<M>;
}
