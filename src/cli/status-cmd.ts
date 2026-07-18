import path from "node:path";
import { PassThrough } from "node:stream";
import { buildIgnoreMatcher, checkoutTransactionCapability, cryptoPoolStatus, diffManifests, HashCache, scanManifest, type CheckoutTransactionCapability, type DiscoveredGitRepo, type IgnoreMatcher } from "../engine/index.js";
import { trashStats } from "../engine/trash.js";
import { loadActivity, shellStateOf, type DaemonActivity } from "./activity.js";
import { RBOX_VERSION } from "./version.js";
import { fetchAccountSummary, formatAccountSummary } from "./account-cmd.js";
import { readAccountProfile } from "./account-profile.js";
import { DEFERRAL_LANES, loadConfig, loadState, repoRecordsForState, syncStreamId, type GitDeferral, type SyncState, type WorkspaceConfig } from "./config.js";
import { loadCredentials, type CredentialLoadResult, type Credentials } from "./credentials.js";
import { daemonBindingStatus, readDaemonPidRecord } from "./daemon-control.js";
import { emitJson } from "./json.js";
import { loadMetrics } from "./metrics.js";
import {
  attributeDaemonForStatus,
  aggregatePlanQuotaAttention,
  briefBehindRemote,
  briefWorkspaceLabel,
  freshBriefActive,
  healthDetailLines,
  healthLine,
  lastSyncLines,
  gitDeferralReasonPresentation,
  projectGitDeferralRepos,
  renderBriefStatus,
  renderGitDeferralLine,
  trashLine,
  type BriefHaltReason,
  type BriefAccountSummary,
  type BriefIdentitySource,
  type BriefStatusSnapshot,
  type StatusRemoteHead,
} from "./status-view.js";
import {
  gitDivergenceCount,
  gitDivergenceFastRepoSource,
  gitDivergenceStatus,
  type GitDivergenceRepoHint,
  type GitDivergenceStatus,
} from "./sync-git.js";
import { style } from "./style.js";
import { formatUpdateAvailableLine, readUpdateCheckState, updateAvailableVersion } from "./update-check.js";
import { shortWorkspaceId } from "./workspace-picker.js";
import { readFreshPopulateStatus } from "./populate-status.js";
import { readLockingHealth, type LockingHealth } from "./sync-mutex.js";
import { readAmbientDaemonStatusRecord, validDaemonVersion } from "./daemon/ambient-status.js";
import { serializeGitDeferralLanes } from "./sync-git/git-deferral-json.js";
import { inspectResetJournalSafety } from "./reset-halt-inspection.js";
import { readResetHaltHealth } from "./reset-health.js";

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
  gitDeferrals: GitDivergenceStatus["deferrals"];
  gitConfigChecking?: string[];
  gitConfigDisabled?: GitDivergenceStatus["configDisabled"];
}

interface LocalGitDeferral extends GitDeferral {
  repo: string;
}

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

type StatusLocalCounts =
  | (StatusLocalCountsBase & { source: "computed" })
  | (StatusLocalCountsBase & { source: "daemon"; ageMs: number });

export interface StatusCmdDeps {
  now: () => number;
  loadCredentials?: typeof loadCredentials;
  loadHashCache: (root: string) => Promise<HashCache>;
  scanManifest: typeof scanManifest;
  gitDivergenceCount: typeof gitDivergenceCount;
  /** Optional so existing embedders/test fakes using the numeric API remain valid. */
  gitDivergenceStatus?: typeof gitDivergenceStatus;
  gitDivergenceFastRepoSource: (
    root: string,
    baseGitRepos: SyncState["lastSyncedManifest"]["gitRepos"],
    matcher: IgnoreMatcher
  ) => Promise<GitDivergenceRepoHint[]>;
  daemonBindingStatus: typeof daemonBindingStatus;
  readDaemonPidRecord: typeof readDaemonPidRecord;
  readLockingHealth?: (root: string) => Promise<LockingHealth>;
  checkoutTransactionCapability?: typeof checkoutTransactionCapability;
  readAmbientDaemonStatusRecord?: typeof readAmbientDaemonStatusRecord;
  readBriefIdentity?: (accountId: string) => Promise<BriefIdentitySource | undefined>;
}

const defaultStatusDeps: StatusCmdDeps = {
  now: () => Date.now(),
  loadHashCache: (root) => HashCache.load(root),
  scanManifest,
  gitDivergenceCount,
  gitDivergenceStatus,
  gitDivergenceFastRepoSource,
  daemonBindingStatus,
  readDaemonPidRecord,
  readLockingHealth,
  checkoutTransactionCapability,
  readAmbientDaemonStatusRecord,
};

const LOCAL_TRUST_MS = 60_000;

async function cachedAccountSummary(
  loaded: CredentialLoadResult,
  identityLookup: (accountId: string) => Promise<BriefIdentitySource | undefined>
): Promise<BriefAccountSummary> {
  if (loaded.state === "absent") return { state: "signed-out" };
  if (loaded.state !== "valid") {
    const where = loaded.state === "invalid-environment" ? loaded.variable : loaded.path;
    return { state: "credential-degraded", reason: `${loaded.state}: ${where}` };
  }
  const creds = loaded.credentials;
  if (!creds.accountId) return { state: "unavailable" };
  const identity = await identityLookup(creds.accountId);
  return {
    state: "ok",
    identity: identity ?? { email: null, plan: null },
  };
}

async function readCachedBriefIdentity(accountId: string): Promise<BriefIdentitySource | undefined> {
  const profile = await readAccountProfile(accountId);
  return profile ? { email: profile.email, plan: profile.plan } : undefined;
}

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
    const res = await fetch(`${base}/v1/ws/${cfg.remoteWorkspaceId}/proj/${cfg.projectId}/latest`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const seq = ((await res.json()) as { sequence?: number }).sequence;
    return typeof seq === "number" ? seq : undefined;
  } catch {
    return undefined;
  }
}

async function fetchStatusAccountJson(loaded: CredentialLoadResult, timeoutMs = 3500): Promise<StatusAccountJson> {
  const unavailable = { plan: null, usedBytes: null, capBytes: null };
  if (loaded.state !== "valid") return unavailable;
  const creds = loaded.credentials;
  try {
    const res = await fetch(`${creds.remoteUrl}/v1/account/usage`, {
      headers: { authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return unavailable;
    const body = (await res.json()) as { plan?: unknown; usedBytes?: unknown; storageCap?: unknown };
    if (typeof body.plan !== "string" || typeof body.usedBytes !== "number") return unavailable;
    const capBytes = body.storageCap === null || typeof body.storageCap === "number" ? body.storageCap : null;
    return { plan: body.plan, usedBytes: body.usedBytes, capBytes };
  } catch {
    return unavailable;
  }
}

function credentialStatusJson(loaded: CredentialLoadResult): Record<string, unknown> {
  if (loaded.state === "valid" || loaded.state === "absent") return { state: loaded.state };
  if (loaded.state === "invalid-environment") return { state: "credential-degraded", reason: loaded.state, variable: loaded.variable };
  return { state: "credential-degraded", reason: loaded.state, path: loaded.path };
}

function statusHealthJson(input: {
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

function createGitRepoFeed(): {
  push: (repo: DiscoveredGitRepo) => void;
  close: () => void;
  iterable: AsyncIterable<DiscoveredGitRepo>;
} {
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

export async function statusCmd(root: string, opts: StatusCmdOptions = {}): Promise<StatusCmdResult> {
  assertPresentationFlags(opts);
  const deps = opts.now === undefined
    ? defaultStatusDeps
    : { ...defaultStatusDeps, now: () => opts.now!.getTime() };
  return statusCmdWithDeps(root, opts, deps);
}

export async function statusCmdWithDeps(
  root: string,
  opts: Omit<StatusCmdOptions, "now"> = {},
  deps: StatusCmdDeps = defaultStatusDeps
): Promise<StatusCmdResult> {
  assertPresentationFlags(opts);
  const loadedCredentials = await (deps.loadCredentials ?? loadCredentials)();
  const creds = loadedCredentials.state === "valid" ? loadedCredentials.credentials : undefined;
  const rawCfg = await loadConfig(root);
  const cfg = { ...rawCfg, remoteUrl: creds?.remoteUrl ?? rawCfg.remoteUrl };
  const daemonBinding = deps.daemonBindingStatus(root, cfg.remoteWorkspaceId);
  const alive = daemonBinding.alive;
  const daemonStale = daemonBinding.stale;
  const bg = { running: alive.running && !daemonStale, pid: alive.pid };

  // Design 138 F2b: this branch precedes every loadState/state-dependent
  // section. The classifier and health reader are both read-only; a direct
  // status invocation can therefore explain an unsafe standing transaction
  // without helping the daemon mutate its side-file.
  const [resetInspection, resetHealth] = await Promise.all([
    inspectResetJournalSafety(root, syncStreamId(cfg)),
    readResetHaltHealth(root),
  ]);
  const resetDegraded = resetInspection.status === "halt" || resetHealth !== undefined;
  if (resetDegraded) {
    const reason = resetInspection.status === "halt" ? resetInspection.reason : "recovering";
    if (opts.json) {
      emitJson({
        workspace: { id: cfg.remoteWorkspaceId, name: cfg.name ?? null, root },
        halted: true,
        reason,
        daemon: { running: bg.running, pid: bg.pid ?? null },
        credential: credentialStatusJson(loadedCredentials),
      });
      return { daemonRunning: bg.running };
    }
    if (!opts.verbose) {
      const workspaceLabel = briefWorkspaceLabel(cfg.name, path.basename(root));
      const rendered = renderBriefStatus({
        kind: "reset-halt",
        workspaceLabel,
        daemonRunning: bg.running,
        account: await cachedAccountSummary(loadedCredentials, deps.readBriefIdentity ?? readCachedBriefIdentity),
      });
      for (const line of rendered.lines) console.log(line);
      return { daemonRunning: rendered.daemonRunning };
    }
    const wsLabel = cfg.name
      ? `${style.cyan(cfg.name)} ${style.dim("@")} ${root} ${style.dim(`(${shortWorkspaceId(cfg.remoteWorkspaceId)})`)}`
      : `${style.cyan(cfg.remoteWorkspaceId)} ${style.dim("@")} ${root}`;
    console.log(`${style.bold("workspace")} ${wsLabel} ${style.dim(`· rbox ${RBOX_VERSION}`)}`);
    if (loadedCredentials.state !== "valid" && loadedCredentials.state !== "absent") {
      const diagnostic = credentialStatusJson(loadedCredentials);
      console.log(`  ${style.yellow(`credential-degraded: ${String(diagnostic.reason)} (${String(diagnostic.variable ?? diagnostic.path)})`)}`);
    }
    console.log(`  ${style.yellow(`sync halted: a state-recovery record can't be processed (${reason}). Files on disk are untouched; run \`rbox doctor reset-journal\`.`)}`);
    console.log(`  ${style.dim("background sync:")} ${daemonStale
      ? style.yellow(`running but bound to a previous workspace (pid ${alive.pid})`)
      : bg.running ? style.green(`running (pid ${bg.pid})`) : style.yellow("stopped")}`);
    return { daemonRunning: bg.running };
  }

  const accountSummaryP = opts.verbose ? fetchAccountSummary(3500, loadedCredentials) : Promise.resolve(null);
  let state = await loadState(root, syncStreamId(cfg));

  const activityP = daemonStale ? Promise.resolve(undefined) : loadActivity(root);
  const trashP = trashStats(root).catch(() => undefined);
  const lockingP = (deps.readLockingHealth ?? readLockingHealth)(root);
  const accountJsonP = opts.json ? fetchStatusAccountJson(loadedCredentials) : Promise.resolve(null);
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

  const evaluateGit = async (
    matcher: IgnoreMatcher | undefined,
    source?: readonly GitDivergenceRepoHint[] | AsyncIterable<GitDivergenceRepoHint>,
    includeBaseRepos = true
  ): Promise<GitDivergenceStatus> => {
    if (!cfg.syncGit) return { count: 0, deferrals: localGitDeferrals(state).map(({ repo, ...d }) => ({ relPath: repo, ...d })), configChecking: [], configDisabled: [] };
    try {
      if (deps.gitDivergenceStatus) {
        return await deps.gitDivergenceStatus(root, cfg, state, matcher, source, includeBaseRepos);
      }
      return {
        count: await deps.gitDivergenceCount(root, cfg, state, matcher, source, includeBaseRepos),
        deferrals: localGitDeferrals(state).map(({ repo, ...d }) => ({ relPath: repo, ...d })),
        configChecking: [],
        configDisabled: [],
      };
    } catch {
      // Design 93 §6: an indeterminate config lane is conservatively divergent;
      // status must never collapse an evaluation failure to zero.
      return { count: 1, deferrals: localGitDeferrals(state).map(({ repo, ...d }) => ({ relPath: repo, ...d })), configChecking: ["*"], configDisabled: [] };
    }
  };

  let counts: StatusLocalCounts;
  if (trusted) {
    const matcher = buildIgnoreMatcher(root, {
      respectGitignore: false,
      knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    });
    const repoHints = cfg.syncGit ? await deps.gitDivergenceFastRepoSource(root, state.lastSyncedManifest.gitRepos, matcher) : [];
    const gitStatus = await evaluateGit(undefined, repoHints, false);
    counts = {
      added: trusted.local.added,
      changed: trusted.local.changed,
      deleted: trusted.local.deleted,
      trackedFiles: trusted.local.trackedFiles,
      gitChanged: gitStatus.count,
      gitDeferrals: gitStatus.deferrals,
      gitConfigChecking: gitStatus.configChecking,
      gitConfigDisabled: gitStatus.configDisabled,
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
      gitDeferrals: localGitDeferrals(state).map(({ repo, ...d }) => ({
        relPath: repo,
        lane: d.lane,
        reason: d.reason,
        deferredSince: d.deferredSince,
        ...(d.bytesChanged === undefined ? {} : { bytesChanged: d.bytesChanged }),
      })),
      source: "computed",
    };
  } else {
    const matcher = buildIgnoreMatcher(root, {
      respectGitignore: cfg.respectGitignore === true,
      knownGitRepos: Object.keys(state.lastSyncedManifest.gitRepos ?? {}),
    });
    const hashCache = await deps.loadHashCache(root);
    const gitRepoFeed = createGitRepoFeed();
    const gitChangedP = evaluateGit(matcher, gitRepoFeed.iterable);
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
    const gitStatus = await gitChangedP;
    counts = {
      added: manifestDiff.added.length,
      changed: manifestDiff.changed.length,
      deleted,
      trackedFiles: localManifest.files.length,
      gitChanged: gitStatus.count,
      gitDeferrals: gitStatus.deferrals,
      gitConfigChecking: gitStatus.configChecking,
      gitConfigDisabled: gitStatus.configDisabled,
      source: "computed",
    };
  }

  const [remote, trash, accountJson, locking] = await Promise.all([remoteHeadP, trashP, accountJsonP, lockingP]);
  const localChanges = counts.added + counts.changed + counts.deleted;
  const now = deps.now();
  const crypto = cryptoPoolStatus();
  const gitDeferrals = localGitDeferrals(state);
  const projectedGitDeferrals = counts.gitDeferrals;
  const projectedGitRepos = projectGitDeferralRepos(projectedGitDeferrals.map((deferral) => ({
    repo: deferral.relPath,
    deferral,
  })), now);
  const localGitRepoProjections = projectGitDeferralRepos(gitDeferrals.map((deferral) => ({
    repo: deferral.repo,
    deferral,
  })), now);
  const gitDeferredRepos = projectedGitRepos.length;
  const gitBytesChangedDeferrals = projectedGitRepos.filter((repo) => repo.bytesChanged).length;
  const gitOldestDeferral = projectedGitRepos[0];
  const gitCapability: CheckoutTransactionCapability | undefined = projectedGitRepos.some((repo) => repo.displayReason === "unsupported")
    ? await (deps.checkoutTransactionCapability ?? checkoutTransactionCapability)(root)
    : undefined;
  let daemonVersion: string | undefined;
  let daemonVersionKnown = false;
  if (alive.running) {
    const record = (deps.readAmbientDaemonStatusRecord ?? readAmbientDaemonStatusRecord)(root);
    if (record.kind === "ok") {
      if (record.status.daemonVersion === undefined) {
        daemonVersion = "pre-1.6.3";
        daemonVersionKnown = true;
      } else if (validDaemonVersion(record.status.daemonVersion)) {
        daemonVersion = record.status.daemonVersion;
        daemonVersionKnown = true;
      }
    }
  }
  const daemonVersionSkew = daemonVersionKnown && daemonVersion !== RBOX_VERSION;

  if (opts.json) {
    const statusJson = {
      workspace: { id: cfg.remoteWorkspaceId, name: cfg.name ?? null, root },
      health: statusHealthJson({
        activity,
        populate: populate?.operation,
        localChanges,
        gitChanged: counts.gitChanged,
        gitDeferrals: gitDeferredRepos,
        gitBytesChangedDeferrals,
        localSequence: state.lastSyncedSequence,
        remote,
        now,
      }),
      daemon: {
        running: bg.running,
        pid: bg.pid ?? null,
        version: daemonVersion ?? null,
        cliVersion: RBOX_VERSION,
        versionSkew: daemonVersionSkew,
      },
      locking: {
        status: locking.status,
        reason: locking.status === "ok" ? null : locking.reason,
        path: ".rbox/state/sync.lock",
      },
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
      credential: credentialStatusJson(loadedCredentials),
      crypto,
      git: {
        ...(gitCapability ? { capability: gitCapability } : {}),
        deferrals: serializeGitDeferralLanes(gitDeferrals.map(({ repo, ...deferral }) => ({ repo, deferral })), now),
        deferredRepos: localGitRepoProjections.map((repo) => ({
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
    };
    emitJson(statusJson);
    return { daemonRunning: bg.running };
  }

  if (!opts.verbose) {
    const account = await cachedAccountSummary(
      loadedCredentials,
      deps.readBriefIdentity ?? readCachedBriefIdentity
    );
    const updateState = await readUpdateCheckState();
    const nextVersion = updateAvailableVersion(updateState);
    const planQuota = aggregatePlanQuotaAttention(account, activity?.outOfStorage);
    const typedHalt = activity?.halt?.typedReason;
    const halt: BriefHaltReason | undefined = activity?.halt
      ? typedHalt?.kind === "mass-delete"
        ? { kind: "mass-delete", op: typedHalt.op }
        : typedHalt?.kind === "too-many-refs"
          ? { kind: "too-many-refs" }
          : typedHalt?.kind === "body-too-large"
            ? { kind: "body-too-large" }
            : { kind: "unknown" }
      : undefined;
    const active = freshBriefActive(activity, bg.running, now);
    const workspaceLabel = briefWorkspaceLabel(cfg.name, path.basename(root));
    const brief: BriefStatusSnapshot = {
      kind: "full",
      workspaceLabel,
      daemonRunning: bg.running,
      daemonStale,
      account,
      pendingChanges: localChanges + counts.gitChanged,
      ...(active ? { active } : {}),
      ...(populate ? { populate: { filesDone: populate.operation.filesDone, filesTotal: populate.operation.filesTotal } } : {}),
      behindRemote: briefBehindRemote(state.lastSyncedSequence, remote),
      ...(halt ? { halt } : {}),
      planQuota,
      daemonVersionSkew,
      locking,
      ...(projectedGitRepos.length > 0
        ? {
          git: {
            count: projectedGitRepos.length,
            oldestDeferredSince: projectedGitRepos[0]!.oldestDeferredSince,
            allLocalEditDeferrals: projectedGitRepos.every((repo) => repo.displayReason === "local-edits"),
          },
        }
        : {}),
      ...(trash && trash.files > 0 ? { trash: { files: trash.files, bytes: trash.bytes } } : {}),
      ...(nextVersion ? { update: { current: RBOX_VERSION, next: nextVersion } } : {}),
      now,
    };
    const rendered = renderBriefStatus(brief);
    for (const line of rendered.lines) console.log(line);
    if (opts.git) {
      for (const deferral of projectedGitRepos) {
        console.log(`  ${renderGitDeferralLine({
          relPath: deferral.repo,
          reason: deferral.displayReason,
          deferredSince: deferral.oldestDeferredSince,
          checkout: deferral.checkout,
          bytesChanged: deferral.bytesChanged,
          now,
          capability: deferral.displayReason === "unsupported" ? gitCapability : undefined,
        })}`);
        const presentation = gitDeferralReasonPresentation(deferral.displayReason);
        console.log(`    ${presentation.text}`);
        console.log(`    ${presentation.repair}`);
      }
    }
    return { daemonRunning: rendered.daemonRunning };
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
    gitDeferrals: gitDeferredRepos,
    gitBytesChangedDeferrals,
    gitOldestDeferral: gitOldestDeferral
      ? { deferredSince: gitOldestDeferral.oldestDeferredSince, reason: gitOldestDeferral.displayReason }
      : undefined,
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
  if (daemonVersionSkew) {
    const daemonLabel = daemonVersion === "pre-1.6.3" ? daemonVersion : `v${daemonVersion}`;
    console.log(`  ${style.yellow(`daemon ${daemonLabel}, CLI v${RBOX_VERSION} — restart: rbox stop && rbox start`)}`);
  }
  console.log(`  ${style.dim("locking:")} ${locking.status === "ok"
    ? style.green("ok (.rbox/state/sync.lock)")
    : style.yellow(`${locking.status}: ${locking.reason} (.rbox/state/sync.lock)`)}`);
  if (cfg.syncGit || projectedGitDeferrals.length > 0) {
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
    if (projectedGitRepos.length) parts.push(style.yellow(`${projectedGitRepos.length} deferred`));
    if (counts.gitConfigChecking?.length) {
      const names = counts.gitConfigChecking.filter((rel) => rel !== "*");
      parts.push(style.yellow(`config: checking${names.length ? ` (${names.join(", ")})` : ""}`));
    }
    if (counts.gitConfigDisabled?.length) {
      parts.push(style.yellow(`config: disabled (${counts.gitConfigDisabled.map((issue) => `${issue.relPath}: ${issue.reason}`).join("; ")})`));
    }
    console.log(`  ${style.dim("git-sync:")} ${parts.join(" · ")}`);
    for (const deferral of localGitRepoProjections) {
      console.log(`    ${renderGitDeferralLine({
        relPath: deferral.repo,
        reason: deferral.displayReason,
        deferredSince: deferral.oldestDeferredSince,
        checkout: deferral.checkout,
        bytesChanged: deferral.bytesChanged,
        now,
        capability: deferral.displayReason === "unsupported" ? gitCapability : undefined,
      })}`);
    }
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
  return { daemonRunning: bg.running };
}
