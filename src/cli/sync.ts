import {
  applyActions,
  buildIgnoreMatcher,
  diffManifests,
  isIgnoreRuleFile,
  HashCache,
  PhaseReport,
  createScanStats,
  reconcile,
  scanManifest,
  validateManifest,
  manifestRequiresSchema4,
  type Action,
  type IgnoreMatcher,
  type Manifest,
  type ScanStats,
  laneTimingSummary,
  applyStatsDelta,
  setApplyStatsEnabled,
  snapshotApplyStats,
  type ApplyStats,
} from "../engine/index.js";
import {
  applyGitSections,
  formatGitApplyMetrics,
  formatGitPlanStats,
  formatGitPushLine,
  gitBaseAfterCommit,
  gitForceForMissingBlobs,
  gitReposManifestSchema,
  planGitSections,
} from "./sync-git.js";
import {
  deferManifest,
  encryptAndUpload,
  pruneEncryptAddressCache,
  reportDeferred,
  uploadLaneTimingSummary,
  type EncryptAndUploadOptions,
} from "./sync-recovery.js";
import type { TransferProgress } from "./transfer-progress.js";
import { loadState, stateWasStreamMismatch, syncStreamId, trashConfig, type WorkspaceConfig } from "./config.js";
import { changedSidecarRepoKeys, observedRepoKeys, saveStateSource } from "./sync-state.js";
import { assertSyncMutex, workspaceSyncMutexDegraded, type WorkspaceSyncMutex } from "./sync-mutex.js";
import { openTrashBatch } from "../engine/trash.js";
import { RboxApi, type CommitOptions, type CommitTimings, type LatestTimings, type SyncRemote } from "./remote.js";

const apiFor = (cfg: WorkspaceConfig): SyncRemote =>
  new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId);

const MAX_ATTEMPTS = 5;
/** Mass-delete guard (design 44): a pull that wants to delete this many files AND at
 *  least half the baseline is far more likely a poisoned baseline / wrong workspace /
 *  server-side accident than a real edit, so it fails closed until a human says
 *  otherwise. Normal dev churn (deleting a subtree) stays far under half the tree. */
const MASS_DELETE_MIN_FILES = 100;
/** The empty per-relPath 422 recapture set: the default force for a first attempt (design
 *  43 §6 [v2, M5]). Its `.size === 0` also marks "not a git-recapture retry" below. */
const NO_GIT_FORCE: ReadonlySet<string> = new Set();

type CurrentWriteContext = {
  kek: Uint8Array;
  accountId: string;
  accountEpoch: number;
  keyEpoch: number;
};
type WriteContextProvider = SyncRemote & { currentKek?: () => Promise<CurrentWriteContext> };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Exponential backoff with jitter, so two hot daemons don't livelock retrying. */
const defaultBackoff = (attempt: number) => sleep(Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random()));

/** Adapt `deps.onProgress` into the engine scan's discovery callback: the walk reports a
 *  running count with no known total, which surfaces as the indeterminate `scan` phase. */
const scanTick = (deps: SyncDeps): ((discovered: number) => void) | undefined =>
  deps.onProgress ? (discovered) => deps.onProgress!(discovered, 0, "scan") : undefined;

/** Plaintext byte total / file-entry count of a manifest (the §35 "plaintext bytes" basis
 *  + file count). Computed only on the metrics-enabled path (each is an O(files) pass). */
const plaintextBytesOf = (m: Manifest): number => m.files.reduce((n, f) => n + (f.type === "file" ? f.size : 0), 0);
const fileCountOf = (m: Manifest): number => m.files.reduce((n, f) => n + (f.type === "file" ? 1 : 0), 0);
const matcherForState = (root: string, cfg: WorkspaceConfig, state?: { lastSyncedManifest: Manifest }, opts: { purgeSafety?: boolean } = {}) =>
  buildIgnoreMatcher(root, {
    respectGitignore: cfg.respectGitignore === true,
    forceTrackedEvaluation: opts.purgeSafety === true,
    protectTrackedPaths: opts.purgeSafety === true,
    knownGitRepos: Object.keys(state?.lastSyncedManifest.gitRepos ?? {}),
  });

const fmtDetailSeconds = (ms: number): string => (ms / 1000).toFixed(1);
const fmtDetailBytes = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}KB`;
  return `${n}B`;
};
const formatCommitTimings = (t: CommitTimings): string =>
  `r${fmtDetailSeconds(t.refreshMs)} sc${fmtDetailSeconds(t.sidecarMs)} e${fmtDetailSeconds(t.encodeMs)} c${fmtDetailSeconds(t.encryptMs)} u${fmtDetailSeconds(t.uploadMs)} p${fmtDetailSeconds(t.postMs)} ${fmtDetailBytes(t.encBytes)}${formatServerTimings(t.serverTimings)}`;
/** Design 97: the server's own commit decomposition, echoed on the commit response.
 *  Rendered only when the server sent it (older workers omit the field). */
const formatServerTimings = (t: CommitTimings["serverTimings"]): string =>
  t ? ` srv${fmtDetailSeconds(t.totalMs)} env${fmtDetailSeconds(t.envelopeMs)} acct${fmtDetailSeconds(t.accountingMs)} ssc${fmtDetailSeconds(t.sidecarMs)} cm${fmtDetailSeconds(t.commitMs)} mir${fmtDetailSeconds(t.mirrorMs)} rsp${fmtDetailSeconds(t.responseMs)}` : "";
const formatLatestTimings = (t: LatestTimings): string => `d${fmtDetailSeconds(t.downloadMs)} x${fmtDetailSeconds(t.decryptMs)} p${fmtDetailSeconds(t.parseMs)} ${fmtDetailBytes(t.encBytes)}`;
/** Design 85 §6.1: the scan details carry an explicit residual (wall minus the
 *  five timed components — allocation, path construction, readlink, cache lookup,
 *  loop overhead) and the mid-write deferral count from the P-1 guard. */
type ScanDetails = ScanStats & { residualMs: number; midwriteDeferred: number };
const scanDetailsOf = (s: ScanStats, wallMs: number, midwriteDeferred: number): ScanDetails => ({
  ...s,
  residualMs: Math.max(0, wallMs - (s.readdirMs + s.statMs + s.matcherMs + s.hashMs + s.sortMs)),
  midwriteDeferred,
});
const formatScanStats = (s: ScanDetails): string =>
  `rd${fmtDetailSeconds(s.readdirMs)} st${fmtDetailSeconds(s.statMs)} mt${fmtDetailSeconds(s.matcherMs)} h${fmtDetailSeconds(s.hashMs)} srt${fmtDetailSeconds(s.sortMs)} res${fmtDetailSeconds(s.residualMs)} d${s.dirsWalked} f${s.filesStatted} hit${s.filesSkippedCacheHit} defer${s.midwriteDeferred}`;
/** mk=mkdir/cr=created, walk=dir components, uniq=dirs, ls=lstat, rn=rename,
 * stg=stages, pre=preflight, pool=write pool, sm/lg=count and bytes. */
export const formatApplyStats = (s: ApplyStats): string =>
  `mk${s.mkdirCalls}/cr${s.mkdirCreated} walk${s.dirComponentWalks} uniq${s.uniqueDirs} ls${s.lstatCalls} rn${s.renameCalls} stg${s.stageCalls} pre${fmtDetailSeconds(s.preflightMs)}s pool${fmtDetailSeconds(s.writePoolMs)}s sm${s.smallCount}n/${fmtDetailBytes(s.smallBytes)} lg${s.largeCount}n/${fmtDetailBytes(s.largeBytes)}`;

export function stampManifestSchemaForCommit(manifest: Manifest): Manifest {
  const schema = Math.max(gitReposManifestSchema(manifest.gitRepos) ?? 0, manifestRequiresSchema4(manifest) ? 4 : 0);
  if (schema === 0) {
    const { manifestSchema: _manifestSchema, ...withoutSchema } = manifest;
    return withoutSchema;
  }
  return { ...manifest, manifestSchema: schema };
}

/**
 * Injectable dependencies for the sync entry points (design 09 §1). Defaults
 * give production behavior; tests inject an in-memory `SyncRemote` and a no-op
 * `backoff` to exercise the conflict-retry control flow offline & fast. The SAME
 * deps object flows through pull/push/pushManifest/sync and its bounded retry loop.
 */
export interface SyncDeps {
  /** Held once by the named top-level owner. Nested pull/push/retry operations
   * inherit this exact handle and must never reacquire the workspace mutex. */
  syncMutex?: WorkspaceSyncMutex;
  cache?: HashCache;
  remote?: SyncRemote;
  backoff?: (attempt: number) => Promise<void>;
  /** Called once per commit-level 409 (parent-sequence conflict). Lets the daemon
   *  tally retry pressure without sync.ts doing metrics I/O (design 09 §3). */
  onCommitConflict?: () => void;
  /** Progress for the long phases of sync (scan + git-capture + encrypt + upload on
   *  push; download on pull). The CLI renders it on the spinner; the daemon records the
   *  coarse `{phase,done,total}` into its activity sidecar. `done`/`total` are
   *  entry/blob/repo counts (`total === 0` = indeterminate, e.g. a live scan). */
  onProgress?: TransferProgress;
  /** Optional per-run phase-timing collector (design §35). Defaulted off; when absent,
   *  the sync path uses a disabled no-op report that allocates nothing — so the daemon's
   *  hot path and no-op tick stay free unless metrics are explicitly enabled. */
  report?: PhaseReport;
  /** internal: cumulative scan-stats accumulator for RBOX_METRICS; created at the entry point,
   *  shared by retry/recovery rescans. */
  scanStats?: ScanStats;
  /** Test seam for the expensive encrypt primitive; production uses encryptFileToTemp. */
  encryptFileToTemp?: EncryptAndUploadOptions["encryptFileToTemp"];
  /** Test seam for debounce timing; production leaves the design-75 ~10s default. */
  encryptCacheFlushMs?: number;
  /** Forensic git-sync log sink (design 43 §10): capture/carry/defer/remove summaries on
   *  push, per-repo apply/conflict lines on pull. Default: console.error. The daemon
   *  injects its timestamped logger so the lines land in the daemon log. */
  onGitLog?: (line: string) => void;
  /** Per-repo progress during the pull-side git-apply loop (`done` advances once per
   *  repo examined, including no-op "unchanged" ones) — lets a CLI collapse the N
   *  per-repo `onGitLog` lines into a single updating "N/total" counter instead. */
  onGitProgress?: (done: number, total: number) => void;
  /** Explicit human consent to a pull that deletes ≥half the baseline (design 44).
   *  Set ONLY by `rbox pull/sync --allow-mass-delete`; the daemon never sets it, so a
   *  runaway mass delete halts background sync instead of destroying the tree. */
  allowMassDelete?: boolean;
  /** Explicit human consent to a PUSH that deletes ≥half the baseline (design 50 §4).
   *  Deliberately SEPARATE from {@link allowMassDelete} (design-review B2): pushManifest's
   *  409-recovery reuses this same deps object to PULL, and pull-side consent must NOT be
   *  implied by push consent — a `rbox push --allow-mass-delete` must never let the recovery
   *  pull silently apply a mass delete. Set by `rbox push --allow-mass-delete`, or by
   *  `rbox sync --allow-mass-delete` alongside pull-side consent. */
  allowMassDeletePush?: boolean;
  /** Command shown when either mass-delete guard refuses this operation. */
  massDeleteHint?: string;
  /** A pull evicted a local directory that the remote now flips to a file/symlink
   *  (design 50 §3, review M2): the dir moved to trash. The CLI/daemon logs it and
   *  counts it into `lastPull.conflicts`. Threaded into applyActions via `onTypeFlip`. */
  onTypeFlip?: (relPath: string) => void;
  /** Fired by EVERY pull that applied actions to the local tree — including the pull
   *  inside pushManifest's 409 recovery, whose actions the retry loop discards
   *  (design 45, codex R2: the daemon's forensic log and activity trail must record
   *  every local-tree mutation, whichever path performed it). */
  onPullApplied?: (actions: Action[]) => void;
  /** Daemon-only terminal-halt hint. Foreground `rbox push` / `rbox sync` leaves this
   *  unset so an explicit user sync always makes a real attempt. */
  blockedFingerprint?: string;
}

function withReportScanStats(deps: SyncDeps, report: PhaseReport): SyncDeps {
  if (!report.enabled || deps.scanStats) return deps;
  return { ...deps, scanStats: createScanStats() };
}

/** Either use the caller's cache (caller owns persistence) or load+save one locally. */
async function withCache(
  root: string,
  provided: HashCache | undefined
): Promise<{ cache: HashCache; save: () => Promise<void> }> {
  if (provided) return { cache: provided, save: async () => {} };
  const cache = await HashCache.load(root);
  return { cache, save: () => cache.save(root) };
}

async function refreshWriteContext(cfg: WorkspaceConfig, deps: SyncDeps): Promise<void> {
  const remote = deps.remote as WriteContextProvider | undefined;
  if (typeof remote?.currentKek !== "function") {
    throw new Error("push: account epoch changed, but this remote cannot refresh the E2EE write context");
  }
  const writeContext = await remote.currentKek();
  Object.assign(cfg, {
    kek: Buffer.from(writeContext.kek),
    accountId: writeContext.accountId,
    accountEpoch: writeContext.accountEpoch,
    keyEpoch: writeContext.keyEpoch,
  });
}

async function rescanForRetry(root: string, cfg: WorkspaceConfig, deps: SyncDeps, purgeIgnored: boolean): Promise<Manifest> {
  const report = deps.report ?? PhaseReport.disabled("push");
  const { cache, save } = await withCache(root, deps.cache);
  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg)));
  const scanStats = report.enabled ? deps.scanStats : undefined;
  const scanDeferred = new Set<string>();
  const scanT0 = Date.now();
  let local = await report.phase("scan", () => scanManifest(root, matcherForState(root, cfg, state, { purgeSafety: purgeIgnored }), cache, scanTick(deps), undefined, scanStats, scanDeferred));
  const scanWallMs = Date.now() - scanT0;
  if (scanDeferred.size > 0) local = deferManifest(local, state.lastSyncedManifest, scanDeferred);
  if (scanStats) {
    const details = scanDetailsOf(scanStats, scanWallMs, scanDeferred.size);
    report.recordDetails("scan", { ...details }, formatScanStats(details));
  }
  await save();
  return local;
}

/**
 * Pull the latest remote manifest and reconcile it onto the local tree. The
 * reconcile base is the last-synced manifest; after applying, the new base is
 * the remote we just pulled. The remote manifest is validated before it touches
 * the filesystem (never trust the network). Returns the actions taken.
 */
export async function pull(root: string, cfg: WorkspaceConfig, deps: SyncDeps = {}): Promise<Action[]> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("pull");
  deps = withReportScanStats(deps, report);
  const api = deps.remote ?? apiFor(cfg);
  let latestTimings: LatestTimings | undefined;
  const { sequence, manifest: remote } = await report.phase("latest", () =>
    api.latest(report.enabled ? { onLatestTimings: (t) => (latestTimings = t) } : undefined)
  );
  if (latestTimings) report.recordDetails("latest", { ...latestTimings }, formatLatestTimings(latestTimings));

  const v = validateManifest(remote);
  if (!v.ok) throw new Error(`refusing to apply invalid remote manifest: ${v.error}`);

  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg)));
  const { cache, save } = await withCache(root, deps.cache);
  const matcher = matcherForState(root, cfg, state);
  const scanStats = report.enabled ? deps.scanStats : undefined;
  // Counting-only deferral sink: pull intentionally acts on no deferred set
  // (see sync-scan-defer.test.ts — apply's expectedLocal guard is the protection),
  // but the §6.1 details still report how many paths the P-1 guard dropped.
  const scanDeferred = new Set<string>();
  const scanT0 = Date.now();
  const local = await report.phase("scan", () => scanManifest(root, matcher, cache, scanTick(deps), undefined, scanStats, scanDeferred));
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
  const kek = cfg.kek;
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
    throw new Error(
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
    keyEpoch: cfg.keyEpoch,
    trash: batch,
    onTypeFlip: deps.onTypeFlip,
    onProgress: deps.onProgress ? (done: number, total: number) => deps.onProgress!(done, total, "download") : undefined,
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
    if (lane) process.stderr.write(`${lane}\n`);
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
  await report.phase("cache-save", save);

  // Git repos (design 43 §7): per-repo loop over remote ∪ base ∪ pending with
  // scope-projected identity, per-repo base advance (one busy repo never blocks the
  // others), removal memories, needs-resolution checkpoints, pending-remote carry.
  const glog = deps.onGitLog ?? ((line: string) => console.error(line));
  const gitOutcome = await report.phase("git-apply", () =>
    applyGitSections(root, cfg, state, remote, api.blobStore(), finalMatcher, glog, {
      collectMetrics: report.enabled,
      onProgress: deps.onGitProgress,
      disableConfigLane: workspaceSyncMutexDegraded(deps.syncMutex),
    })
  );
  report.record("git-apply", { count: gitOutcome.gitApplyMetrics?.repos ?? 0 });
  if (gitOutcome.gitApplyMetrics) {
    report.recordDetails("git-apply", { gitApply: gitOutcome.gitApplyMetrics }, formatGitApplyMetrics(gitOutcome.gitApplyMetrics));
  }
  await report.phase("state-save", () => saveStateSource(root, state, {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: sequence,
    globalManifest: remote,
    observedRepos: observedRepoKeys(state, remote.gitRepos, {
      bases: gitOutcome.gitRepos,
      pending: gitOutcome.gitPendingRemote,
      removed: gitOutcome.gitReposRemoved,
      resolutions: gitOutcome.gitNeedsResolution,
      configLane: gitOutcome.configLane,
    }),
    values: {
      bases: gitOutcome.gitRepos,
      pending: gitOutcome.gitPendingRemote,
      removed: gitOutcome.gitReposRemoved,
      resolutions: gitOutcome.gitNeedsResolution,
      configLane: gitOutcome.configLane,
    },
  }, {
    allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
    forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
  }));
  if (actions.length > 0) {
    try {
      deps.onPullApplied?.(actions);
    } catch {
      // Observability only: a hook failure must never fail a pull that has already
      // applied and saved — the daemon would misread it as a pull halt (codex R3).
    }
  }
  return actions;
}

/**
 * Scan and push. Convenience wrapper for CLI one-shots — the daemon uses
 * {@link pushManifest} directly with its incrementally-patched in-memory manifest.
 */
export async function push(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {},
  purgeIgnored = false
): Promise<{ sequence: number; committed: boolean }> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("push");
  deps = withReportScanStats(deps, report);
  const { cache, save } = await withCache(root, deps.cache);
  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg)));
  const matcher = matcherForState(root, cfg, state, { purgeSafety: purgeIgnored });
  const scanStats = report.enabled ? deps.scanStats : undefined;
  const scanDeferred = new Set<string>();
  const scanT0 = Date.now();
  let local = await report.phase("scan", () => scanManifest(root, matcher, cache, scanTick(deps), undefined, scanStats, scanDeferred));
  const scanWallMs = Date.now() - scanT0;
  if (scanDeferred.size > 0) local = deferManifest(local, state.lastSyncedManifest, scanDeferred);
  await save();
  if (report.enabled) {
    report.files = fileCountOf(local);
    report.record("scan", { count: report.files, plaintextBytes: plaintextBytesOf(local) });
    if (scanStats) {
      const details = scanDetailsOf(scanStats, scanWallMs, scanDeferred.size);
      report.recordDetails("scan", { ...details }, formatScanStats(details));
    }
  }
  const { sequence, committed } = await pushManifest(root, cfg, local, deps, 0, purgeIgnored);
  return { sequence, committed };
}

/** What a push commit reports back to callers holding an in-memory manifest.
 *  `committed` is true only when a commit actually advanced the sequence — false on
 *  the no-op and everything-deferred short-circuits, so callers can say "already in
 *  sync" instead of reporting a publish that never happened (design 44: the setup
 *  flow once printed "published → sequence 75" for a push that uploaded nothing). */
type PushResult = { sequence: number; manifest: Manifest; deferred?: string[]; retryLater?: string[]; committed: boolean };

/**
 * The one typed recovery structure behind pushManifest's bounded retry loop. A failed
 * commit attempt classifies into exactly one of these, and the loop applies it — this
 * unifies what were four ad-hoc retry paths (409-conflict, 422-unsatisfied, per-file
 * churn defer, and blob-sha mismatch) into a single sequencing point:
 *  - `pull-first` — a 409 parent-sequence conflict: PULL (absorb the remote change) then
 *    RE-SCAN (disk moved under us) and retry with a fresh manifest and no git force.
 *  - `epoch-stale` — the account rotated under this push: refresh the write context,
 *    RE-SCAN under the new KEK/cache binding, and retry with no git force.
 *  - `reupload` — a 422 unsatisfied-blobs bounce: retry the SAME manifest (no pull, no
 *    re-scan), forcing a git recapture for exactly the referenced repos (§6 [v2, M5]).
 * (The per-file churn defer + blob-sha-mismatch recovery live one layer down, inside
 *  encryptAndUpload: they resolve WITHIN an attempt by committing the stable subset and
 *  deferring the file that won't settle — never a whole-attempt retry.)
 */
type RecoveryAction =
  | { kind: "pull-first" }
  | { kind: "epoch-stale" }
  | { kind: "reupload"; forceGitRecapture: ReadonlySet<string>; localForRetry: Manifest; unsatisfiedTotal?: number; unsatisfiedBlobs: string[] };

const RECOVER_ACCUM_MAX = 100_000;

/** Design 103 Part B: fold one 422 page into the recovery accumulator. Returns the
 *  new full-audit latch state. Once latched (or newly overflowing RECOVER_ACCUM_MAX)
 *  the set is cleared and stays empty — the chunked full audit needs no recovery set,
 *  and holding 100k+ strings would be dead weight (unit-tested memory bound). */
export function accumulateRecoveryPage(accum: Set<string>, latched: boolean, page: readonly string[]): boolean {
  if (latched) return true;
  for (const sha of page) accum.add(sha);
  if (accum.size > RECOVER_ACCUM_MAX) {
    accum.clear();
    return true;
  }
  return false;
}

/** The result of ONE push attempt: either done (committed / no-op / everything deferred),
 *  or a classified recovery to apply, carrying the error to throw once the shared
 *  MAX_ATTEMPTS budget is exhausted. */
type AttemptOutcome =
  | { done: true; result: PushResult }
  | { done: false; action: RecoveryAction; exhaustedError: string };

/**
 * Push a pre-computed manifest: upload missing blobs, commit. Short-circuits to a
 * no-op (no upload, no commit) when nothing changed vs the last-synced manifest —
 * this is what keeps continuous bidirectional sync from echo-storming (a pull
 * writes exactly the last-synced bytes, so the next push sees no diff). A 409
 * conflict pulls, RE-SCANS (disk changed), and retries (bounded, backed off); a
 * 422 re-uploads the named blobs and retries. A file that keeps changing under the
 * push (never producing a hash-matching ciphertext) is DEFERRED rather than aborting
 * the whole push: the stable subset commits, and the deferred paths are returned so
 * the daemon can re-queue them once they settle. Returns the sequence now in effect,
 * the manifest that reflects it (so a caller holding an in-memory manifest can keep it
 * fresh even across a conflict re-scan), and the deferred paths (empty when none).
 *
 * The retry itself is a bounded LOOP (not recursion): each iteration runs one attempt
 * and, on a classified failure, applies the {@link RecoveryAction} — sharing the single
 * MAX_ATTEMPTS budget, backing off only before a 409 pull (never a 422 re-upload), and
 * preserving the exact interleaving of the original recursive form.
 */
export async function pushManifest(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps = {},
  attempt = 0,
  purgeIgnored = false,
  forceGitRecapture: ReadonlySet<string> = NO_GIT_FORCE
): Promise<PushResult> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("push");
  deps = withReportScanStats(deps, report);
  const backoff = deps.backoff ?? defaultBackoff;
  let currentLocal = local;
  let currentForce = forceGitRecapture;
  let previousUnsatisfiedTotal: number | undefined;
  const recoverAccum = new Set<string>();
  let recoverFullAudit = false;

  for (;;) {
    const outcome = await runPushAttempt(root, cfg, currentLocal, deps, backoff, purgeIgnored, currentForce, recoverAccum, recoverFullAudit);
    if (outcome.done) {
      const lane = uploadLaneTimingSummary();
      if (lane) process.stderr.write(`${lane}\n`);
      return outcome.result;
    }
    const consumesAttempt =
      outcome.action.kind !== "reupload" ||
      outcome.action.unsatisfiedTotal === undefined ||
      previousUnsatisfiedTotal === undefined ||
      outcome.action.unsatisfiedTotal >= previousUnsatisfiedTotal;
    previousUnsatisfiedTotal = outcome.action.kind === "reupload" ? outcome.action.unsatisfiedTotal : undefined;
    // Shared budget: throw once we've exhausted MAX_ATTEMPTS (the just-failed attempt is
    // `attempt`), matching the original recursion's throw-before-retry ordering.
    if (consumesAttempt && attempt >= MAX_ATTEMPTS) throw new Error(outcome.exhaustedError);
    if (outcome.action.kind !== "reupload") {
      if (outcome.action.kind === "pull-first") {
        await backoff(attempt);
        await pull(root, cfg, deps);
      } else {
        await refreshWriteContext(cfg, deps);
      }
      currentLocal = await rescanForRetry(root, cfg, deps, purgeIgnored); // disk changed under us
      currentForce = NO_GIT_FORCE;
      // The manifest was rebuilt; recovery pages from the discarded attempt no longer apply.
      recoverAccum.clear();
      recoverFullAudit = false;
    } else {
      // 422: same manifest, no backoff, no re-scan — force git recapture of the named repos.
      recoverFullAudit = accumulateRecoveryPage(recoverAccum, recoverFullAudit, outcome.action.unsatisfiedBlobs);
      currentLocal = outcome.action.localForRetry;
      currentForce = outcome.action.forceGitRecapture;
    }
    if (consumesAttempt) attempt++;
  }
}

/**
 * Run ONE push attempt: forward-only ignore carry, git-section plan, no-op short-circuit,
 * encrypt+upload (with per-file churn defer), and commit — then classify the commit into
 * a done result or a {@link RecoveryAction} for the loop to apply. Attempt-agnostic: the
 * MAX_ATTEMPTS budget and backoff live in {@link pushManifest}'s loop.
 */
async function runPushAttempt(
  root: string,
  cfg: WorkspaceConfig,
  local: Manifest,
  deps: SyncDeps,
  backoff: (attempt: number) => Promise<void>,
  purgeIgnored: boolean,
  forceGitRecapture: ReadonlySet<string>,
  recoverAddresses: ReadonlySet<string>,
  forceFullAudit: boolean
): Promise<AttemptOutcome> {
  // Created PER attempt (not once in the loop): when no remote is injected, a stateful
  // RboxApi must start each attempt with a clean upload-receipt slate — exactly as the
  // prior recursive form did (each recursive call re-ran `deps.remote ?? apiFor(cfg)`).
  const api = deps.remote ?? apiFor(cfg);
  // Needed before the no-op short-circuit (state-load/git-plan are phased, design 82
  // §4); §35's "a no-op tick allocates nothing" still holds — disabled() is a shared
  // free singleton, not a per-attempt allocation.
  const report = deps.report ?? PhaseReport.disabled("push");
  const state = await report.phase("state-load", () => loadState(root, syncStreamId(cfg)));
  // One authority for every push decision: the persisted base records the last
  // pull that applied completely. A newer remote manifest may have been verified
  // (and its anti-rollback head pinned) before apply failed, but it is not a base.
  const appliedSequence = state.lastSyncedSequence;
  const appliedBase = state.lastSyncedManifest;
  const matcher = matcherForState(root, cfg, state, { purgeSafety: purgeIgnored }); // shared: forward-only ignore carry + git discovery
  const scannedFilePaths = new Set(local.files.filter((f) => f.type === "file").map((f) => f.path));

  // Forward-only ignore (M3b): a file that was synced but is now ignored should
  // NOT read as a deletion on other machines. Carry forward its last-synced entry
  // unless --purge explicitly requests propagating the deletion. (A real `rm` of a
  // non-ignored file is still absent-and-not-ignored → a genuine deletion.)
  if (!purgeIgnored) {
    const present = new Set(local.files.map((f) => f.path));
    const carried = appliedBase.files.filter((e) => !present.has(e.path) && matcher.ignores(e.path));
    if (carried.length) {
      local = { ...local, files: [...local.files, ...carried].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) };
    }
  }

  if (purgeIgnored) {
    const deleted = diffManifests(appliedBase, local).deleted;
    assertNoUnevaluatedPurgeDeletes(matcher, deleted);
  }

  // Attach the git sections (design 43 §6): per-repo carry/capture/defer/remove map
  // orchestration. `forceGitRecapture` is the per-relPath 422 recapture set [v2, M5]:
  // a git artifact missing server-side can't be satisfied by a file re-upload — ONLY
  // the repos whose sections reference the missing encShas recapture; the force lives
  // at this single site (each retry recomputes the map) or the recovery is dead.
  const gitPlan = await report.phase("git-plan", () =>
    planGitSections(root, cfg, state, api, forceGitRecapture, matcher, deps.onProgress, backoff, {
      onGitLog: deps.onGitLog,
      disableConfigLane: workspaceSyncMutexDegraded(deps.syncMutex),
    })
  );
  if (report.enabled) {
    report.record("git-plan", { count: Object.keys(gitPlan.gitRepos ?? {}).length }); // guarded: skip the key-array materialization on no-op ticks
    if (gitPlan.gitPlanStats) report.recordDetails("git-plan", { gitPlan: gitPlan.gitPlanStats }, formatGitPlanStats(gitPlan.gitPlanStats));
  }
  // Schema is stamped once, at commit (stampManifestSchemaForCommit) — deriving it
  // here too would be a second copy of the rule.
  local = { ...local, gitRepos: gitPlan.gitRepos };

  const filesUnchanged = (() => {
    const d = diffManifests(appliedBase, local);
    return d.added.length === 0 && d.changed.length === 0 && d.deleted.length === 0;
  })();
  const gitUnchanged = !gitPlan.changed;
  if (filesUnchanged && gitUnchanged) {
    // No-op (files AND git identity match base). Safe even under a forced git RE-CAPTURE
    // (the 422 recovery): reaching here needs local == base, but to have hit the 422 at all
    // attempt-0 must have passed its own no-op — i.e. a real file or git-identity change. The
    // base sequence is unadvanced across a 422, so that change still shows here (filesUnchanged
    // or gitUnchanged is false) → this no-op is unreachable whenever there is anything to
    // commit; when it IS reachable, local == base and committing would just echo. So the git
    // recapture's re-uploaded artifacts are never silently dropped by this branch.
    //
    // LOCAL-ONLY git bookkeeping may still have moved even though nothing needs
    // committing — deleting a leftover .git is usually EXACTLY a no-op push (a .git
    // removal changes no synced files), yet §9 requires its removal memory to be
    // pruned then, or the stale memory suppresses a later legitimate re-add at that
    // path (codex step-3 round-3 MAJOR). Persist the bookkeeping commit-free.
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    if (
      cfg.syncGit &&
      (!same(gitPlan.gitReposRemoved, state.gitReposRemoved) ||
        !same(gitPlan.gitNeedsResolution, state.gitNeedsResolution) ||
        !same(gitPlan.gitPendingRemote, state.gitPendingRemote))
    ) {
      const values = {
        bases: appliedBase.gitRepos,
        pending: gitPlan.gitPendingRemote,
        removed: gitPlan.gitReposRemoved,
        resolutions: gitPlan.gitNeedsResolution,
      };
      await report.phase("state-save", () => saveStateSource(root, state, {
        expectedStream: syncStreamId(cfg),
        sourceGlobalSeq: appliedSequence,
        observedRepos: changedSidecarRepoKeys(state, values),
        values,
      }, {
        allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
        forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
      }));
    }
    if (cfg.encrypted) await pruneEncryptAddressCache(root, cfg, scannedFilePaths);
    return { done: true, result: { sequence: appliedSequence, manifest: local, committed: false } };
  }
  // §10 forensic line — only when git-sync did something beyond a steady carry.
  if (cfg.syncGit && (gitPlan.captured.length || gitPlan.deferred.length || gitPlan.removed.length)) {
    (deps.onGitLog ?? ((l: string) => console.error(l)))(formatGitPushLine(gitPlan));
  }

  // Upload missing blobs — ALWAYS convergently encrypted (by encSha, ciphertext).
  // E2EE is the only mode (design 12 D6): a non-encrypted config reaching the sync
  // core is a fail-closed error, BEFORE any byte is uploaded — never plaintext.
  if (!cfg.encrypted || !cfg.kek) throw new Error("E2EE required: refusing to sync without an encryption key (run `rbox init`/`rbox pair`/`rbox key recover`)");

  // Missing or scan-mismatched sources defer immediately; ciphertext upload
  // mismatches retry within a bounded per-file budget. Only the stable subset is
  // committed, and watcher/safety scans re-queue deferred paths once they settle.
  const { deferred, retryLater } = await encryptAndUpload(api, root, cfg, local, appliedBase, report, deps.onProgress, backoff, {
    encryptFileToTemp: deps.encryptFileToTemp,
    encryptCacheFlushMs: deps.encryptCacheFlushMs,
    pruneLivePaths: scannedFilePaths,
    recoverAddresses,
    forceFullAudit,
  });

  // Build the manifest we actually COMMIT. A deferred file is dropped from this commit;
  // if it was previously synced we carry its base entry forward (mirrors the forward-only
  // ignore carry above) so it NEVER reads as a deletion on other machines, and a never-synced
  // deferred file is simply omitted. Invariant: every blob the committed manifest references
  // was uploaded AND hash-matched this run, or is an already-synced base blob — no dangling
  // ref, no phantom deletion.
  const committed = stampManifestSchemaForCommit(deferred.size === 0 ? local : deferManifest(local, appliedBase, deferred));

  // If deferral left nothing to commit (every change deferred, git unchanged), don't burn a
  // no-op commit — the deferred files stand alone for the daemon to re-queue later. NEVER
  // short-circuit a forced git RE-CAPTURE (422 recovery): its whole point is to re-commit a
  // manifest whose git artifacts were re-uploaded, and gitUnchanged (identity-only) can't see
  // that the artifact blobs were missing.
  if (deferred.size > 0 && forceGitRecapture.size === 0) {
    const dd = diffManifests(appliedBase, committed);
    if (dd.added.length === 0 && dd.changed.length === 0 && dd.deleted.length === 0 && gitUnchanged) {
      reportDeferred(deferred);
      return { done: true, result: { sequence: appliedSequence, manifest: committed, deferred: [...deferred], retryLater: [...retryLater], committed: false } };
    }
  }

  // Push-side mass-delete guard (design 50 §4): symmetry with the pull guard. A push that
  // would delete ≥half the baseline is far likelier a stray `rm -rf` on THIS machine than an
  // intended cleanup — publishing it wedges every OTHER device (each halts ⚠ on its next pull).
  // Refuse to COMMIT until a human consents. Counted on `committed` (post-defer) so the number
  // is exact, and gated on the op-scoped consent field so the recovery pull can't inherit it.
  const pushDeletes = diffManifests(appliedBase, committed).deleted.length;
  if (!deps.allowMassDeletePush && pushDeletes >= MASS_DELETE_MIN_FILES && pushDeletes * 2 >= appliedBase.files.length) {
    throw new Error(
      `push would delete ${pushDeletes} of ${appliedBase.files.length} tracked files — refusing (mass-delete guard). ` +
        `If this deletion is intentional, run \`${deps.massDeleteHint ?? "rbox push --allow-mass-delete"}\` to publish it once.`
    );
  }

  let commitTimings: CommitTimings | undefined;
  let commitOptions: CommitOptions | undefined;
  if (deps.blockedFingerprint !== undefined || report.enabled) {
    commitOptions = {
      ...(deps.blockedFingerprint !== undefined ? { blockedFingerprint: deps.blockedFingerprint } : {}),
      ...(report.enabled ? { onCommitTimings: (t: CommitTimings) => (commitTimings = t) } : {}),
    };
  }
  const res = await report.phase("commit", () => api.commit(appliedSequence, cfg.deviceId, committed, commitOptions));
  if (commitTimings) report.recordDetails("commit", { ...commitTimings }, formatCommitTimings(commitTimings));

  if (res.epochStale !== undefined) {
    return { done: false, action: { kind: "epoch-stale" }, exhaustedError: "push: account epoch kept rotating under us" };
  }
  if (res.conflict) {
    deps.onCommitConflict?.(); // tally 409 retry pressure (design 09 §3)
    return { done: false, action: { kind: "pull-first" }, exhaustedError: "push: too many conflicts, remote is moving faster than we can reconcile" };
  }
  if (res.unsatisfiedBlobs) {
    // A missing GIT artifact can't be satisfied by a file re-upload, and an identity-carry
    // would re-reference the absent bundle (§28, codex M3) — so force a RE-CAPTURE for
    // exactly the repos whose sections reference the missing encShas (see gitForceForMissingBlobs).
    // The reupload retry re-checks missingBlobs + re-uploads the missing FILE ciphertext with
    // the same per-file defer; the SAME manifest is retried (no pull, no re-scan).
    const gitForce = gitForceForMissingBlobs(committed.gitRepos, new Set(res.unsatisfiedBlobs));
    return {
      done: false,
      action: {
        kind: "reupload",
        forceGitRecapture: gitForce,
        localForRetry: committed,
        unsatisfiedTotal: res.unsatisfiedTotal,
        unsatisfiedBlobs: res.unsatisfiedBlobs ?? [],
      },
      exhaustedError: "push: server keeps reporting missing blobs after re-upload",
    };
  }

  // Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
  // remote's own unapplied truth — the saved git BASE keeps the OLD entry (or none) so the
  // next pull still sees remote != base and retries the apply (see gitBaseAfterCommit).
  const stateGit = gitBaseAfterCommit(committed.gitRepos, gitPlan.gitPendingRemote, appliedBase.gitRepos);
  const ackValues = {
    bases: stateGit,
    pending: gitPlan.gitPendingRemote,
    removed: gitPlan.gitReposRemoved,
    resolutions: gitPlan.gitNeedsResolution,
  };
  await report.phase("state-save", () => saveStateSource(root, state, {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: res.sequence!,
    globalManifest: committed,
    observedRepos: observedRepoKeys(state, committed.gitRepos, ackValues),
    values: ackValues,
    authoredCfgHashByRepo: gitPlan.authoredCfgHashByRepo,
  }, {
    allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
    forceLegacy: workspaceSyncMutexDegraded(deps.syncMutex),
  }));
  if (deferred.size > 0) reportDeferred(deferred);
  return { done: true, result: { sequence: res.sequence!, manifest: committed, deferred: [...deferred], retryLater: [...retryLater], committed: true } };
}

function assertNoUnevaluatedPurgeDeletes(matcher: IgnoreMatcher, deleted: string[]): void {
  for (const path of deleted) {
    const repo = matcher.unevaluatedGitRepoForPath?.(path);
    if (repo !== undefined) {
      throw new Error(
        `refusing purge: cannot evaluate tracked files for git repo ${repo} (first affected path ${path}). ` +
          `Fix that repo's .git/index and retry.`
      );
    }
  }
}

/** One full cycle: take remote changes, then publish local ones. */
export async function sync(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps = {}
): Promise<{ pulled: Action[]; pushedSequence: number; pushCommitted: boolean }> {
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const report = deps.report ?? PhaseReport.disabled("sync");
  deps = withReportScanStats(deps, report);
  const pulled = await pull(root, cfg, deps);
  const { sequence: pushedSequence, committed: pushCommitted } = await push(root, cfg, deps);
  return { pulled, pushedSequence, pushCommitted };
}
