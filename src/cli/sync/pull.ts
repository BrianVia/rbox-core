import {
  applyActions,
  isIgnoreRuleFile,
  PhaseReport,
  reconcile,
  oracleFromPull,
  scanManifest,
  validateManifest,
  type Action,
  type Manifest,
  laneTimingSummary,
  applyStatsDelta,
  setApplyStatsEnabled,
  snapshotApplyStats,
} from "../../engine/index.js";
import { openTrashBatch } from "../../engine/trash.js";
import { ensureCapableStateLineage, loadState, manifestFromMeta, repoRecordsForState, stateWasStreamMismatch, syncStreamId, trashConfig, validManifestMeta, type GlobalManifestMeta, type SyncState, type WorkspaceConfig } from "../config.js";
import { type LatestTimings, type SyncRemote } from "../remote.js";
import {
  deferManifest,
} from "../sync-recovery.js";
import {
  applyGitSections,
  formatGitApplyMetrics,
  settleCommittedBranchArtifacts,
  withRevalidatedGitPartialApplies,
} from "../sync-git.js";
import { assertSyncMutex, workspaceSyncMutexDegraded } from "../sync-mutex.js";
import { observedRepoKeys, orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { type SyncDeps, withReportScanStats, withCache, withDircache } from "./deps.js";
import { formatLatestTimings, formatScanStats, scanDetailsOf, formatApplyStats } from "./format.js";
import { apiFor, makeDeferErrnoReporter, MASS_DELETE_MIN_FILES, MassDeleteGuardError, matcherForState, plaintextBytesOf, fileCountOf, scanTick } from "./policy.js";

export async function scanManifestForPush(root: string, cfg: WorkspaceConfig, deps: SyncDeps, purgeIgnored = false): Promise<Manifest> {
  const report = deps.report ?? PhaseReport.disabled("push");
  const { cache, save } = await withCache(root, deps.cache);
  const { dircache, save: dircacheSave } = await withDircache(root, deps.dircache);
  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex));
  const scanStats = report.enabled ? deps.scanStats : undefined;
  const scanDeferred = new Set<string>();
  const scanFault = () => deps.telemetry?.record({ kind: "safety_event", eventType: "scan_fault", count: 1 });
  const deferErrnos = deps.warningSink ? makeDeferErrnoReporter(deps.warningSink, scanFault) : makeDeferErrnoReporter(undefined, scanFault);
  const scanT0 = Date.now();
  let local = await report.phase("scan", () => scanManifest(root, matcherForState(root, cfg, state, { purgeSafety: purgeIgnored }), cache, scanTick(deps), undefined, scanStats, scanDeferred, undefined, dircache, deps.forceFullScan ? "unpruned" : "pruned", deferErrnos.onErrno, deps.warningSink));
  deferErrnos.flush();
  const scanWallMs = Date.now() - scanT0;
  if (scanDeferred.size > 0) local = deferManifest(local, state.lastSyncedManifest, scanDeferred);
  if (scanStats) {
    const details = scanDetailsOf(scanStats, scanWallMs, scanDeferred.size);
    report.recordDetails("scan", { ...details }, formatScanStats(details));
  }
  await Promise.all([save(), dircacheSave()]);
  return local;
}

/**
 * Pull the latest remote manifest and reconcile it onto the local tree. The
 * reconcile base is the last-synced manifest; after applying, the new base is
 * the remote we just pulled. The remote manifest is validated before it touches
 * the filesystem (never trust the network). Returns the actions taken.
 */
export async function pull(root: string, cfg: WorkspaceConfig, deps: SyncDeps = {}): Promise<Action[]> {
  return (await pullWithMetadata(root, cfg, deps)).actions;
}

/** Pull boundary metadata used by guided setup without changing pull's public API. */
export async function pullWithMetadata(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {}
): Promise<{ actions: Action[]; initialRemoteSequence: number }> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("pull");
  deps = withReportScanStats(deps, report);
  const api = deps.remote ?? apiFor(cfg);
  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex));
  const validatedMeta = validManifestMeta(state.manifestMeta);
  const fastPullEnabled = process.env.RBOX_MDE_FAST_PULL === "1";
  const fastFoldBase = fastPullEnabled && validatedMeta
    ? { manifest: manifestFromMeta(state.lastSyncedManifest, validatedMeta), meta: validatedMeta }
    : undefined;
  let latestTimings: LatestTimings | undefined;
  const { sequence, manifest: remote, manifestMeta } = await report.phase("latest", () =>
    api.latest(report.enabled || fastPullEnabled ? {
      ...(report.enabled ? { onLatestTimings: (t: LatestTimings) => (latestTimings = t) } : {}),
      ...(fastFoldBase ? { fastFoldBase } : {}),
      ...(fastPullEnabled ? { recordEvidence: true } : {}),
    } : undefined)
  );
  if (latestTimings) report.recordDetails("latest", { ...latestTimings }, formatLatestTimings(latestTimings));

  return {
    actions: await applyPulledManifest(root, cfg, deps, api, { sequence, manifest: remote, manifestMeta, state }),
    initialRemoteSequence: sequence,
  };
}

/** Apply an already authenticated remote manifest through the exact normal pull
 * pipeline. Historical chain repair supplies the target commit's KEK/epoch here. */
export async function applyPulledManifest(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps,
  api: SyncRemote,
  input: { sequence: number; manifest: Manifest; manifestMeta?: GlobalManifestMeta; kek?: Uint8Array; keyEpoch?: number; state?: SyncState }
): Promise<Action[]> {
  const report = deps.report ?? PhaseReport.disabled("pull");
  deps = withReportScanStats(deps, report);
  const { sequence, manifest: remote, manifestMeta } = input;

  const v = validateManifest(remote);
  if (!v.ok) throw new Error(`refusing to apply invalid remote manifest: ${v.error}`);

  let state = input.state ?? await report.phase("state-load", () => loadState(root, syncStreamId(cfg), deps.warningSink, deps.syncMutex));
  state = await ensureCapableStateLineage(root, state);
  const { cache, save } = await withCache(root, deps.cache);
  const { dircache, save: dircacheSave } = await withDircache(root, deps.dircache);
  const matcher = matcherForState(root, cfg, state);
  const scanStats = report.enabled ? deps.scanStats : undefined;
  // Counting-only deferral sink: pull intentionally acts on no deferred set
  // (see sync-scan-defer.test.ts — apply's expectedLocal guard is the protection),
  // but the §6.1 details still report how many paths the P-1 guard dropped. A
  // scan-faulted local path is omitted from `local`; if remote deleted that same
  // path in the same window, reconcile no-ops and advances base. Once readable,
  // the local file re-publishes (RESURRECTION, the safe direction: never a
  // deletion). Feeding base-carried entries into reconcile would instead let a
  // remote delete plan a disk delete against an unreadable path (design 108).
  const scanDeferred = new Set<string>();
  const scanFault = () => deps.telemetry?.record({ kind: "safety_event", eventType: "scan_fault", count: 1 });
  const deferErrnos = deps.warningSink ? makeDeferErrnoReporter(deps.warningSink, scanFault) : makeDeferErrnoReporter(undefined, scanFault);
  const scanT0 = Date.now();
  const local = await report.phase("scan", () => scanManifest(root, matcher, cache, scanTick(deps), undefined, scanStats, scanDeferred, undefined, dircache, deps.forceFullScan ? "unpruned" : "pruned", deferErrnos.onErrno, deps.warningSink));
  deferErrnos.flush();
  const scanWallMs = Date.now() - scanT0;
  if (report.enabled) {
    report.files = fileCountOf(local);
    report.record("scan", { count: report.files, plaintextBytes: plaintextBytesOf(local) });
    if (scanStats) {
      const details = scanDetailsOf(scanStats, scanWallMs, scanDeferred.size);
      report.recordDetails("scan", { ...details }, formatScanStats(details));
    }
  }

  // E2EE is the only mode (D6): the KEK is injected by buildAuthedRemote. A remote
  // manifest with encrypted entries but no key on this device → fail closed.
  const kek = input.kek ? Buffer.from(input.kek) : cfg.kek;
  if (!kek && remote.files.some((f) => f.encSha)) {
    throw new Error("E2EE required: this workspace is encrypted but no key on this device — run `rbox pair` or `rbox key recover`.");
  }

  // A remote entry that LOCAL rules ignore must never touch this tree — neither
  // written (an old client may have synced a `.git` pointer file before it was a
  // builtin ignore; applying it would plant a machine-local path here) nor deleted
  // (a remote removal must not delete the REAL, never-synced artifact this machine
  // has at that path). Ignored entries stay untouched in the recorded base, so they
  // aren't pushed back as deletions either (same forward-only rule as push).
  //
  // TWO-PHASE apply when the pull itself changes the RULES: rule-file actions
  // (.rboxignore/.gitignore writes/deletes) land first, the matcher is rebuilt
  // from the updated disk state, and only then are the remaining actions filtered.
  // Filtering everything through the PRE-pull matcher would drop a file a relaxed
  // rule just un-ignored — it would never land locally, and the follow-up push
  // would commit its deletion back to the remote (a data-loss echo).
  const pathOf = (a: Action) => (a.kind === "write" ? a.entry.path : a.path);
  const all = reconcile(state.lastSyncedManifest, local, remote, cfg.deviceId, new Date().toISOString());

  // Mass-delete guard (design 44): refuse to apply a delete wave that wipes ≥half the
  // baseline. Checked BEFORE any action touches disk — the whole pull fails closed,
  // nothing partial. Legitimate big cleanups ack once with `--allow-mass-delete`.
  const plannedDeletes = all.reduce((n, a) => n + (a.kind === "delete" ? 1 : 0), 0);
  const baseFiles = state.lastSyncedManifest.files.length;
  if (!deps.allowMassDelete && plannedDeletes >= MASS_DELETE_MIN_FILES && plannedDeletes * 2 >= baseFiles) {
    deps.telemetry?.record({ kind: "safety_event", eventType: "mass_delete_breaker", count: 1 });
    throw new MassDeleteGuardError("pull",
      `pull would delete ${plannedDeletes} of ${baseFiles} tracked files — refusing (mass-delete guard). ` +
        `If this deletion is intentional, run \`${deps.massDeleteHint ?? "rbox pull --allow-mass-delete"}\` to apply it once.`
    );
  }
  const ruleActions = all.filter((a) => isIgnoreRuleFile(pathOf(a)) && !matcher.ignores(pathOf(a)));
  // Trash tier (design 50 §2): ONE batch per pull receives every propagated deletion and
  // type-flip dir eviction as an atomic rename instead of `fs.rm`. `days === 0` disables it
  // (classic immediate delete / visible conflict eviction). `finish()` settles the `.active`
  // marker and MUST run after the apply phase even on throw, or a crashed pull leaves the
  // batch marked in-flight for 24h (the pruner's stale window).
  const batch = trashConfig(cfg).days > 0 ? openTrashBatch(root) : undefined;
  const applyOpts = {
    device: cfg.deviceId,
    kek,
    keyEpoch: input.keyEpoch ?? cfg.keyEpoch,
    trash: batch,
    onTypeFlip: deps.onTypeFlip,
    warningSink: deps.warningSink,
    onProgress: deps.onProgress ? (done: number, total: number, bytesDone: number, bytesTotal: number) =>
      deps.onProgress!(done, total, "download", undefined, { bytesDone, bytesTotal }) : undefined,
  };
  let actions: Action[] = [];
  let finalMatcher = matcher; // the post-pull rules — also gates git materialization below
  try {
    if (report.enabled) setApplyStatsEnabled(true);
    const applyStatsBefore = report.enabled ? snapshotApplyStats() : undefined;
    try {
      await report.phase("apply", async () => {
        if (ruleActions.length > 0) await applyActions(root, ruleActions, api.blobStore(), applyOpts);
        const fresh = ruleActions.length > 0 ? matcherForState(root, cfg, state) : matcher;
        finalMatcher = fresh;
        const rest = all.filter((a) => !isIgnoreRuleFile(pathOf(a)) && !fresh.ignores(pathOf(a)));
        await applyActions(root, rest, api.blobStore(), applyOpts);
        actions = [...ruleActions, ...rest];
      });
    } finally {
      if (report.enabled) setApplyStatsEnabled(false);
    }
    if (applyStatsBefore) {
      const d = applyStatsDelta(applyStatsBefore);
      report.recordDetails("apply", { applyStats: d }, formatApplyStats(d));
    }
  } finally {
    if (batch) await batch.finish();
  }
  {
    const lane = laneTimingSummary();
    if (lane) (deps.warningSink ?? ((line) => process.stderr.write(`${line}\n`)))(lane);
  }
  if (report.enabled) {
    const writeActions = actions.filter((a): a is Extract<Action, { kind: "write" }> => a.kind === "write");
    report.blobs = writeActions.length;
    report.record("apply", { count: writeActions.length, plaintextBytes: writeActions.reduce((n, a) => n + a.entry.size, 0) });
  }

  // Paths we just wrote/removed changed on disk — invalidate so the next scan
  // re-hashes them from real disk truth (never trust a stale cache entry there).
  for (const a of actions) {
    if (a.kind === "write") cache.invalidate(a.entry.path);
    else if (a.kind === "delete") cache.invalidate(a.path);
    else if (a.kind === "conflict") {
      cache.invalidate(a.path);
      cache.invalidate(a.keepLocalAs);
    }
  }
  await report.phase("cache-save", () => Promise.all([save(), dircacheSave()]).then(() => undefined));

  const oracle = oracleFromPull({
    preScan: local,
    actions,
    oracle: remote,
    matcher: finalMatcher,
    dircache,
    hashcache: cache,
    root,
    scanDeferred,
  });

  // Git repos (design 43 §7): per-repo loop over remote ∪ base ∪ pending with
  // scope-projected identity, per-repo base advance (one busy repo never blocks the
  // others), removal memories, needs-resolution checkpoints, pending-remote carry.
  const glog = deps.onGitLog ?? ((line: string) => console.error(line));
  const gitOutcome = await report.phase("git-apply", () =>
    applyGitSections(root, cfg, state, remote, api.blobStore(), finalMatcher, glog, {
      collectMetrics: report.enabled,
      oracle,
      onProgress: deps.onGitProgress,
      disableConfigLane: workspaceSyncMutexDegraded(deps.syncMutex),
      degradedMutex: workspaceSyncMutexDegraded(deps.syncMutex),
      warningSink: deps.warningSink,
      sourceGlobalSeq: sequence,
    })
  );
  report.record("git-apply", { count: gitOutcome.gitApplyMetrics?.repos ?? 0 });
  if (gitOutcome.gitApplyMetrics) {
    report.recordDetails("git-apply", { gitApply: gitOutcome.gitApplyMetrics }, formatGitApplyMetrics(gitOutcome.gitApplyMetrics));
  }
  const deferralUpdates = orderedRepoDeferralUpdates(repoRecordsForState(state), gitOutcome.deferrals);
  let savedState = await withRevalidatedGitPartialApplies(root, state, gitOutcome, () => report.phase("state-save", () => saveStateSource(root, state, {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: sequence,
    globalManifest: remote,
    ...(manifestMeta ? { manifestMeta } : {}),
    observedRepos: observedRepoKeys(state, remote.gitRepos, {
      bases: gitOutcome.gitRepos,
      branchBaseOrigins: gitOutcome.branchBaseOrigins,
      pending: gitOutcome.gitPendingRemote,
      removed: gitOutcome.gitReposRemoved,
      resolutions: gitOutcome.gitNeedsResolution,
      configLane: gitOutcome.configLane,
      deferrals: deferralUpdates,
      partial: gitOutcome.partial,
      attempt: gitOutcome.attempt,
      idxProj: gitOutcome.idxProj,
    }),
    values: {
      bases: gitOutcome.gitRepos,
      branchBaseOrigins: gitOutcome.branchBaseOrigins,
      pending: gitOutcome.gitPendingRemote,
      removed: gitOutcome.gitReposRemoved,
      resolutions: gitOutcome.gitNeedsResolution,
      configLane: gitOutcome.configLane,
      deferrals: deferralUpdates,
      partial: gitOutcome.partial,
      attempt: gitOutcome.attempt,
      idxProj: gitOutcome.idxProj,
    },
    repoProofs: gitOutcome.repoProofs,
  }, {
    allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
    forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
  })));
  savedState = await settleCommittedBranchArtifacts(root, savedState, gitOutcome);
  try {
    deps.onGitDeferralsSaved?.(savedState);
  } catch {
    // A local visibility hook cannot fail a save that is already durable.
  }
  if (actions.length > 0) {
    try {
      deps.onPullApplied?.(actions);
    } catch {
      // Observability only: a hook failure must never fail a pull that has already
      // applied and saved — the daemon would misread it as a pull halt.
    }
  }
  return actions;
}
