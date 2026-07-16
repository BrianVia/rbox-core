import os from "node:os";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  applyWatchEvents,
  buildIgnoreMatcher,
  diffManifests,
  isIgnoreRuleFile,
  HashCache,
  DirCache,
  coverageOf,
  createScanStats,
  scanPruneEnabled,
  scanManifest,
  type ScanStats,
  type IgnoreMatcher,
  type Manifest,
  type WatchEvent,
  ManifestChainError,
  cryptoPoolStatus,
  writeFileAtomic,
} from "../../engine/index.js";
import type { Action } from "../../engine/reconcile.js";
import { renderShellDeferrals, renderShellLine, saveActivity, saveShellDeferrals, saveShellLine, shellLineStateOf, type DaemonActivity } from "../activity.js";
import { expectedStateNonce, loadConfig, loadState, repoRecordsForState, syncStreamId, trashConfig, type SyncState, type WorkspaceConfig } from "../config.js";
import { pruneTrash } from "../../engine/trash.js";
import { DAEMON_BOOT_ID_ENV, readDaemonPidRecord, recordDaemonBinding } from "../daemon-control.js";
import { makeDeferErrnoReporter, pull, pushManifest, type SyncDeps } from "../sync.js";
import { deferManifest } from "../sync-recovery.js";
import type { TransferPhase, TransferProgressBytes } from "../transfer-progress.js";
import { buildAuthedRemote } from "../e2ee-client.js";
import { E2eeRemote } from "../e2ee-remote.js";
import { beginReport, loadMetrics, metricsEnabled, saveMetrics, type SyncMetrics } from "../metrics.js";
import { createScanProbe, loadScanProbe, saveScanProbe } from "../scan-probe.js";
import {
  AUDIT_EVENT_CAP,
  AUDIT_SETTLE_MS,
  diffForDrift,
  candidateStillMismatch,
  eventsCoverPath,
  horizonClass,
  loadDriftAudit,
  mergePending,
  reverifyPath,
  resolveCoveredAtApply,
  saveDriftAudit,
  snapshotAtPath,
  type DriftAuditState,
  type DriftCandidate,
  type DriftCandidateDraft,
  type EntrySnapshot,
} from "../drift-audit.js";
import { lowerIoPriority } from "../io-priority.js";
import { QuotaExceededError, RboxApi } from "../remote.js";
import { envInt } from "../remote/resilient.js";
import { CommitRejectedError } from "../remote.js";
import { startWatcher, type Watcher } from "../watcher.js";
import { runUpdateCheckIfDue } from "../update-check.js";
import {
  AMBIENT_STATUS_HEARTBEAT_MS,
  pausedAmbientDaemonStatus,
  projectAmbientDaemonStatus,
  type AmbientDaemonStatusV1,
} from "../ambient-status.js";
import { saveAmbientDaemonStatus } from "../ambient-status-writer.js";
import { RBOX_VERSION } from "../version.js";
import { daemonBindingMatches } from "../sync-state.js";
import { ageBucket, projectGitDeferralRepos, renderGitDeferralLine } from "../status-view.js";
import {
  acquireWorkspaceSyncMutex,
  releaseWorkspaceSyncMutex,
  type DaemonMutexResult,
  type LockStarvationReason,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import { repairChain, type SuffixInfo } from "../chain-repair.js";
import {
  ACTIVITY_HEARTBEAT_MS,
  classifyWatcherError,
  DaemonChainRepairPolicy,
  DEEP_SCAN_MS,
  GC_FENCE_RETRY_MS,
  jitter,
  nextSafetyDelay,
  POLL_BACKSTOP_DEFAULT_MS,
  reconnectDelayMs,
  RETRUST_DROP_WINDOW_MS,
  RETRUST_FUSE_DROPS,
  RETRUST_HOLD_MAX_MS,
  RETRUST_MIN_QUIET_TICKS,
  retrustEnabled,
  SAFETY_SYNC_MS,
  type TrustState,
  UPDATE_CHECK_TICK_MS,
  type Wants,
  worseTrust,
  WS_KEEPALIVE_PERSIST_MS,
  WS_PING_MS,
  WS_PONG_DEADLINE_DEFAULT_MS,
} from "./policy.js";
import { cleanPath, LOG_PATHS_MAX, scanStatsLine, summarizeActions } from "./render.js";
import { RotatingDaemonLogger, type DaemonLogSink } from "./logger.js";
import { RemoteContext } from "../remote/context.js";
import { TelemetryQueue } from "../telemetry/queue.js";
import { SyncStateReporter } from "../telemetry/sync-state.js";

type RboxBarAmbientStatus = AmbientDaemonStatusV1 & {
  fileCount: number;
  totalBytes: number;
  daemonVersion: string;
  workspaceRoot: string;
};

const LOCK_STARVATION_MS = 15 * 60_000;
const LOCK_STARVATION_MAX_BYTES = 4 * 1024;
const MUTEX_BACKOFF_TIERS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const MUTEX_EARLY_REPROBE_MS = 2_000;

export interface LockStarvationEpisode {
  holderKey: string;
  firstSeenAt: number;
  warnedAt?: number;
  countedAt?: number;
}

export const lockStarvationPath = (root: string): string => path.join(root, ".rbox", "state", "lock-starvation.json");

const episodeTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export async function readLockStarvationEpisode(root: string): Promise<LockStarvationEpisode | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockStarvationPath(root), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LOCK_STARVATION_MAX_BYTES) return undefined;
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) > LOCK_STARVATION_MAX_BYTES) return undefined;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    if (keys.some((key) => !["holderKey", "firstSeenAt", "warnedAt", "countedAt"].includes(key))) return undefined;
    if (typeof parsed.holderKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.holderKey)) return undefined;
    if (!episodeTime(parsed.firstSeenAt)) return undefined;
    if (parsed.warnedAt !== undefined && !episodeTime(parsed.warnedAt)) return undefined;
    if (parsed.countedAt !== undefined && !episodeTime(parsed.countedAt)) return undefined;
    return {
      holderKey: parsed.holderKey,
      firstSeenAt: parsed.firstSeenAt,
      ...(parsed.warnedAt === undefined ? {} : { warnedAt: parsed.warnedAt }),
      ...(parsed.countedAt === undefined ? {} : { countedAt: parsed.countedAt }),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function saveLockStarvationEpisode(root: string, episode: LockStarvationEpisode): Promise<void> {
  await fs.mkdir(path.dirname(lockStarvationPath(root)), { recursive: true });
  await writeFileAtomic(lockStarvationPath(root), JSON.stringify(episode));
}

export function lockStarvationAgeBucket(ageMs: number): "15m" | "1h" | "1d" {
  if (ageMs >= 24 * 60 * 60_000) return "1d";
  if (ageMs >= 60 * 60_000) return "1h";
  return "15m";
}

interface ScanCoverage { coverage: "full-tree" | "pruned"; errorGenAtStart: number }

export interface GitDeferralLogSeen { reason: string; boundary: string }

const repoRecordProjection = new WeakMap<SyncState, ReturnType<typeof repoRecordsForState>>();
const projectedRepoRecords = (state: SyncState): ReturnType<typeof repoRecordsForState> => {
  const cached = repoRecordProjection.get(state);
  if (cached) return cached;
  const records = repoRecordsForState(state);
  repoRecordProjection.set(state, records);
  return records;
};

/** Pure state projection used by the daemon's instance-local durable-line dedup. */
export function durableGitDeferralLines(
  state: SyncState,
  seen: Map<string, GitDeferralLogSeen>,
  now: number,
): string[] {
  const active = new Set<string>();
  const pending: Array<{ at: number; line: string }> = [];
  const projections = projectGitDeferralRepos(Object.entries(projectedRepoRecords(state)).flatMap(([repo, record]) =>
    Object.values(record.deferrals ?? {}).flatMap((deferral) => deferral ? [{ repo, deferral }] : [])
  ));
  for (const deferral of projections) {
    const key = deferral.repo;
    active.add(key);
    const displayBucket = ageBucket(deferral.oldestDeferredSince, now);
    // Minute precision is useful on first display, but only the normative coarse
    // boundaries trigger later lines (never one line per minute before 1h).
    const boundary = displayBucket.endsWith("m") ? "<1h" : displayBucket;
    const previous = seen.get(key);
    if (!previous || previous.reason !== deferral.displayReason || previous.boundary !== boundary) {
      pending.push({
        at: Date.parse(deferral.oldestDeferredSince),
        line: renderGitDeferralLine({
          relPath: deferral.repo,
          reason: deferral.displayReason,
          deferredSince: deferral.oldestDeferredSince,
          checkout: deferral.checkout,
          bytesChanged: deferral.bytesChanged,
          now,
        }),
      });
    }
    seen.set(key, { reason: deferral.displayReason, boundary });
  }
  for (const key of seen.keys()) if (!active.has(key)) seen.delete(key);
  return pending.sort((a, b) => a.at - b.at || a.line.localeCompare(b.line)).map((row) => row.line);
}

/** Sanitized error identifier for measurement-failure log lines. Node fs errors
 *  embed absolute paths in `message` — only the errno code may be emitted (the
 *  founder's no-raw-filenames rule covers failure lines too, D2-R3). */
const errCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : "unknown";

interface OpenDriftAudit {
  scanStartMs: number;
  candidates: DriftCandidateDraft[];
  /** Fresh-scan snapshot per pending-candidate path, stashed at scan time so the
   *  horizon can be resolved at SETTLE time (apply-time resolution only ever
   *  removes pending entries, so the stash stays a superset). */
  horizonInputs: Map<string, EntrySnapshot | null>;
  rawEvents: WatchEvent[];
  /** Settled batches APPLIED while this window was open. A raw event that fired
   *  BEFORE the scan opened leaves no rawEvents trace, but its batch applying
   *  during the window is still watcher evidence for a candidate — without it,
   *  apply-time resolution (which ran before the candidate persisted) and settle
   *  coverage would both miss it and mint a false confirmed drop (D2-R2 HIGH).
   *  Coverage evidence only — quiescence stays rawEvents-based, since these raw
   *  events may predate the window. */
  appliedEvents: WatchEvent[];
  overflow: boolean;
  watcherHealthy: boolean;
  trustState: TrustState;
  errorGen: number;
  sinceSafetyMs: number;
  rulesChanged: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The rbox daemon: passive, continuous, resource-disciplined sync.
 *
 *  - watcher → incremental manifest patch (O(changed)) → push   [hot path]
 *  - WS "committed" broadcast → pull                            [notification-only]
 *  - safety tick (60s) → stat-only full reconcile               [heals dropped events]
 *  - deep tick (30m) → cache-bypassing re-hash                  [heals silent drift]
 *
 * A single-flight pump serializes all of the above and coalesces redundant
 * requests, so the daemon never races itself into 409 storms.
 */
export class RboxDaemon {
  private readonly api: RboxApi;
  private readonly telemetry: TelemetryQueue;
  private readonly syncStateReporter: SyncStateReporter;
  private matcher: IgnoreMatcher; // rebuilt when .gitignore/.rboxignore changes
  private cache!: HashCache;
  private manifest: Manifest = { generatedAt: "", files: [] };
  private syncBase?: SyncState;
  private pendingEvents: WatchEvent[] = [];

  private watcher?: Watcher;
  private ws?: WebSocket;
  private wsKeepaliveTimer?: ReturnType<typeof setInterval>;
  private wsPongDeadlineTimer?: ReturnType<typeof setTimeout>;
  private backstopTimer?: ReturnType<typeof setTimeout>;
  private notifyPullPendingAt?: number;
  private wsReconnects = 0;
  private wsBackstopPulls = 0;
  private wsHalfOpenDetected = 0;
  private activityHeartbeatTimer?: ReturnType<typeof setInterval>;
  private ambientStatusHeartbeatTimer?: ReturnType<typeof setInterval>;
  private wsGeneration = 0;
  private pendingCatchUpGeneration?: number;
  private lastWsKeepaliveWrite = 0;
  private safetyTimer?: ReturnType<typeof setTimeout>;
  private deepTimer?: ReturnType<typeof setInterval>;
  private updateCheckTimer?: ReturnType<typeof setInterval>;
  private telemetryFlushTimer?: ReturnType<typeof setInterval>;
  private capabilityInitialTimer?: ReturnType<typeof setTimeout>;
  private capabilityTimer?: ReturnType<typeof setInterval>;
  private syncStateHeartbeatTimer?: ReturnType<typeof setInterval>;
  /** Current safety-scan delay (60s floor, backs off to 5m while idle — design 49). */
  private safetyDelay = SAFETY_SYNC_MS;
  /** Watcher events seen since the last safety tick — churn pins the scan to its floor. */
  private churnSinceSafety = false;
  /** Flips false on ANY post-init backend error and stays false: a watcher that has
   *  errored once is no longer trusted to have delivered everything, so the safety
   *  scan never backs off again (fail-safe toward pre-design-49 behavior). */
  private watcherHealthy = true;
  private trustState: TrustState = "trusted";
  private lastTrustedErrorGeneration = 0;
  private transientDropTimestamps: number[] = [];
  private lastTransientDropMs = 0;
  private recoveryHoldMs = 0;
  private watcherLivenessSinceDrop = false;
  private hasCleanUnprunedScanThisEpisode = false;
  private consecutiveQuietSafetyTicks = 0;
  private watcherDegraded = false;
  /** Monotonic post-init watcher error generation. A successful full/deep scan may
   *  clear the visible degradation only if this did not advance after that scan began. */
  private watcherErrorGeneration = 0;
  private watcherSessionId?: string;
  private lastSafetyCompletedMs?: number;
  private rulesChangedSinceDeepScan = false;
  private readonly openDriftAudits = new Set<OpenDriftAudit>();
  private driftState?: DriftAuditState;
  private driftIo: Promise<void> = Promise.resolve();
  private driftSaveFailedLogged = false;
  private reconnectAttempt = 0;
  private stopped = false;
  /** Per-path retry counter for hot-path write-finish: a mid-write file is re-pushed a
   *  few times before falling back to the safety scan, so a large save isn't stalled 60s. */
  private readonly writeFinishRetries = new Map<string, number>();
  private readonly writeFinishRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly deferredRetryPaths = new Set<string>();
  /** Publication-fenced paths remain base-carried across unrelated safety pushes
   * until their hours-scale retry timer deliberately releases them. */
  private readonly gcFenceRetryPaths = new Set<string>();
  private watcherUnsettled = false;
  private watcherUnsettledGeneration = 0;
  private activePumpOp?: keyof Wants;
  private appliedPendingEventsInOp = false;
  /** Pump-error dedup (see the pump catch) + last logged commit sequence (doPush). */
  private lastErrMsg = "";
  private errRepeat = 0;
  private pushTerminalBlocked = false;
  private lastTerminalBlockFingerprint = "";
  /** Foreign-device chain HALTs are terminal for a verified head. Avoid repeatedly
   * attempting repair (and repeating the same HALT) until the authenticated pin moves. */
  private readonly chainRepairPolicy: DaemonChainRepairPolicy;
  private lastLoggedSeq?: number;
  /** While quota-blocked, only a safety full-scan arms one upload probe. */
  private outOfStorageProbeArmed = false;
  /** The watcher factory. Real native-backed `startWatcher` by default; an injectable seam
   *  so the "watcher init rejects → reconcile loops stay armed" invariant is testable without
   *  a process-global module mock (which leaks across test files). */
  private startWatcherFn: typeof startWatcher = startWatcher;
  private workspaceConfigStat?: { mtimeMs: number; size: number };

  private readonly want: Wants = { pull: false, push: false, fullScan: false, deepScan: false };
  private pumping = false;
  private metrics: SyncMetrics = { syncs: 0, commitConflicts409: 0, fileConflicts: 0, lockStarved: 0 };
  /** In-memory activity record mirrored to `.rbox/state/activity.json` (design 45) —
   *  what `rbox status` reads for the health verdict, last-sync trail, live transfer
   *  progress, and (crucially) the mass-delete-guard halt warning. */
  private readonly activity: DaemonActivity = { at: new Date().toISOString() };
  private activityDirty = false; // a `last`/halt change that must persist un-throttled
  private lastActivityWrite = 0;
  private lastProgressWrite = 0;
  private lastProgressPhase: TransferPhase | undefined;
  private ownershipWindDownStarted = false;
  private ambientStatusSawPidfile = false;
  private activeProgressPath?: string;
  private readonly bootId: string;
  private readonly pullOnly: boolean;
  private readonly acquireSyncMutexFn: (root: string) => Promise<DaemonMutexResult>;
  private readonly now: () => number;
  private lockStarvationEpisode?: LockStarvationEpisode;
  private mutexHolderKey?: string;
  private mutexBackoffTier = 0;
  private mutexLoggedTier = -1;
  private mutexBackoffResolve?: () => void;
  private mutexBackoffTimer?: ReturnType<typeof setTimeout>;
  private mutexBackoffController?: AbortController;
  private lastMutexEarlyReprobeAt = Number.NEGATIVE_INFINITY;
  private readonly wsDisabled: boolean;
  private readonly wsReliabilityDisabled: boolean;
  private readonly pongDeadlineMs: number;
  private readonly backstopMs: number;
  private readonly log: DaemonLogSink;
  private readonly onStopped?: () => void;

  /** `e2ee` is the E2EE sync transport (deps.remote) — every push/pull goes
   *  through it so the daemon syncs encrypted, exactly like the one-shot commands. */
  constructor(
    private readonly root: string,
    private cfg: WorkspaceConfig,
    private readonly e2ee: SyncDeps,
    opts: {
      bootId?: string;
      pullOnly?: boolean;
      acquireSyncMutex?: (root: string) => Promise<DaemonMutexResult>;
      now?: () => number;
      log?: DaemonLogSink;
      onStopped?: () => void;
    } = {},
  ) {
    this.log = opts.log ?? ((message) => console.log(`${new Date().toISOString()} ${message}`));
    this.onStopped = opts.onStopped;
    this.api = new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId, this.log);
    const telemetryContext = new RemoteContext(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId, this.log);
    this.telemetry = new TelemetryQueue(telemetryContext, this.log);
    this.syncStateReporter = new SyncStateReporter(root, cfg, telemetryContext, this.log);
    this.matcher = buildIgnoreMatcher(root, { respectGitignore: cfg.respectGitignore === true });
    this.bootId = opts.bootId ?? process.env[DAEMON_BOOT_ID_ENV] ?? crypto.randomBytes(16).toString("hex");
    this.pullOnly = opts.pullOnly === true;
    this.chainRepairPolicy = new DaemonChainRepairPolicy(cfg.deviceId);
    this.acquireSyncMutexFn = opts.acquireSyncMutex ?? ((workspaceRoot) => acquireWorkspaceSyncMutex(workspaceRoot, "daemon"));
    this.now = opts.now ?? Date.now;
    this.wsDisabled = process.env.RBOX_DAEMON_WS_DISABLED === "1";
    this.wsReliabilityDisabled = process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED === "1";
    this.pongDeadlineMs = this.wsReliabilityDisabled
      ? 0
      : envInt("RBOX_DAEMON_WS_PONG_DEADLINE_MS", WS_PONG_DEADLINE_DEFAULT_MS, 0, Number.MAX_SAFE_INTEGER);
    this.backstopMs = this.wsReliabilityDisabled
      ? 0
      : envInt("RBOX_DAEMON_POLL_BACKSTOP_MS", POLL_BACKSTOP_DEFAULT_MS, 0, Number.MAX_SAFE_INTEGER);
  }

  async start(): Promise<void> {
    // Be a background citizen: lose the CPU race to the developer's own tools.
    try {
      os.setPriority(0, 10);
    } catch {
      /* setpriority may be denied; not fatal */
    }
    // ...and the DISK race too (design 49): macOS throttle tier / linux BE-7.
    this.log(`io priority: ${lowerIoPriority()}`);

    this.cache = await HashCache.load(this.root);
    this.metrics = await loadMetrics(this.root);
    this.lockStarvationEpisode = await readLockStarvationEpisode(this.root);
    this.log(`rbox daemon starting: ${this.root} → workspace ${this.cfg.remoteWorkspaceId} (device ${this.cfg.deviceId})${this.pullOnly ? " [pull-only]" : ""}`);
    // Record the binding so `rbox start` can tell a live daemon from a STALE one
    // (bound to a workspace this root was since re-initialized away from).
    if (!(await this.writeStartupBinding())) return;
    this.writeAmbientStatus();
    await this.activityWrite;
    this.markWsStartupDisconnected();
    await this.activityWrite;
    if (this.stopped) return;
    this.startActivityHeartbeat();
    this.startAmbientStatusHeartbeat();
    this.startTelemetryTimers();
    // Seed the push log's sequence memory so the first no-op push (re-publishing
    // nothing) isn't logged as an advance.
    const initialState = await this.loadSyncBase();
    // Seed the in-memory manifest with the last-synced base BEFORE the first scan so a
    // heartbeat firing during the scan window diffs base-vs-base (clean) — never
    // empty-vs-base, which would report a phantom full-tree deletion in `rbox status`
    // (the 2026-07-12 near-miss: an EACCES-aborted first scan left this.manifest empty
    // and every heartbeat wrote "126,557 deleted"). Fix 1 stops the abort; this stops
    // the phantom count even if a future scan-fatal throws here.
    this.manifest = initialState.lastSyncedManifest;
    this.lastLoggedSeq = initialState.lastSyncedSequence;
    this.rebuildMatcher(initialState);

    // Initial convergence: full scan, then a real pull+push cycle.
    await this.replaceManifestFromScan(this.cache, initialState.lastSyncedManifest, undefined, undefined, "pruned");
    this.pruneCache();
    await this.cache.save(this.root);
    this.want.pull = true;
    this.requestPush();
    await this.pump();

    if (!this.pullOnly) await this.startLiveWatch();
    this.maybeConnect();
    this.startBackstop();
    this.startUpdateChecks();

    this.log(this.watcher ? "rbox daemon ready" : "rbox daemon ready (periodic-scan mode; no live watch)");
  }

  /**
   * Arm the reconcile loops, then try the live watcher — in that order, so the
   * correctness floor exists BEFORE the watcher can fail. A rejected watcher init
   * (no native binding, inotify exhaustion, unsupported FS) is caught and degraded to
   * periodic full-scan reconciliation; sync is NEVER left silently dead. This ordering
   * is load-bearing and covered by a dedicated test.
   */
  private async startLiveWatch(): Promise<void> {
    this.scheduleSafetyScan();
    this.deepTimer = setInterval(() => this.request("deepScan"), jitter(DEEP_SCAN_MS));
    try {
      this.watcher = await this.startWatcherFn(
        this.root,
        this.matcher,
        (events) => {
          this.noteChurn();
          this.pendingEvents.push(...events);
          this.request("push");
        },
        {
          onRawEvent: (event) => {
            this.noteChurn();
            this.markLocalUnsettledFromWatchEvent();
            for (const audit of this.openDriftAudits) {
              if (audit.rawEvents.length < AUDIT_EVENT_CAP) audit.rawEvents.push(event);
              else audit.overflow = true;
            }
          },
          onError: (err) => {
            if (!retrustEnabled()) {
              // Design-104 flag OFF (default): today's body, verbatim — one backend
              // error and the watcher is no longer TRUSTED: a dead
              // FSEvents/inotify stream must not let the safety scan — now the
              // only healer — sit backed off at 5m. Sync itself is unaffected. An
              // already-armed backed-off timer is pulled forward too —
              // the flag alone would wait out the remaining timeout.
              if (this.watcherHealthy) this.log(`watcher error: ${err.message} — safety scan pinned to its ${Math.round(SAFETY_SYNC_MS / 1000)}s floor`);
              this.watcherHealthy = false;
              for (const audit of this.openDriftAudits) audit.watcherHealthy = false;
              this.watcherDegraded = true;
              this.watcherErrorGeneration++;
              this.writeAmbientStatus();
              this.pinSafetyFloor();
              return;
            }
            // Design-104 flag ON: classify transient overflow vs fatal and run the
            // trust state machine. errorGen bumps on EVERY drop (never on re-trust);
            // all P2 episode evidence resets on every drop, incl. suspect→suspect.
            this.watcherDegraded = true;
            this.watcherErrorGeneration++;
            this.resetSuspectEpisodeState();
            if (this.trustState === "fused") {
              // Fused is permanent — never re-enters suspect, but the drop still
              // bumped errorGen and re-pins the floor (today's untrusted behavior).
              this.writeAmbientStatus();
              this.pinSafetyFloor();
              return;
            }
            if (classifyWatcherError(err.message) === "fatal") {
              this.log(`watcher error (fatal): ${err.message} — permanent un-trust`);
              this.setTrustState("fused", "fatal error");
            } else {
              const now = Date.now();
              this.transientDropTimestamps = this.transientDropTimestamps.filter((ts) => ts > now - RETRUST_DROP_WINDOW_MS);
              this.transientDropTimestamps.push(now);
              this.lastTransientDropMs = now;
              const d = this.transientDropTimestamps.length;
              if (d >= RETRUST_FUSE_DROPS) {
                this.log(`watcher trust FUSED: ${d} transient drops within ${RETRUST_DROP_WINDOW_MS}ms — reverting to permanent un-trust (safety-scan-only)`);
                this.setTrustState("fused", `fuse ${d}/${RETRUST_FUSE_DROPS}`);
              } else {
                this.recoveryHoldMs = Math.min(SAFETY_SYNC_MS * 2 ** (d - 1), RETRUST_HOLD_MAX_MS);
                if (this.trustState === "trusted") this.log(`watcher error (transient overflow): ${err.message} — safety scan pinned; recovering`);
                this.log(`retrust drop: window=${d}/${RETRUST_FUSE_DROPS} wouldFuse=n hold=${this.recoveryHoldMs}ms`);
                this.setTrustState("suspect", `transient drop ${d}`);
              }
            }
            this.writeAmbientStatus();
            this.pinSafetyFloor();
          },
        }
      );
      this.watcherSessionId = crypto.randomBytes(16).toString("hex");
    } catch (e) {
      this.log(`live watch unavailable: ${e instanceof Error ? e.message : String(e)} — degrading to periodic scan every ${Math.round(SAFETY_SYNC_MS / 1000)}s`);
      this.watcherDegraded = true;
      this.writeAmbientStatus();
    }
  }

  /** Record watcher churn AND pull a backed-off safety timer forward:
   *  the flag alone would let a drop from THIS storm wait out an armed 5m timer —
   *  the scan must return to its 60s cadence the moment there is churn to protect. */
  private noteChurn(): void {
    this.watcherLivenessSinceDrop = true;
    this.churnSinceSafety = true;
    this.pinSafetyFloor();
  }

  /** Re-arm a backed-off safety timer at the 60s floor NOW. Shared by churn and
   *  watcher-error: both mean "the next scan matters — don't wait out
   *  an armed 5m timeout". No-op at the floor, so it can never double-schedule. */
  private pinSafetyFloor(): void {
    if (this.safetyDelay > SAFETY_SYNC_MS && !this.stopped) {
      this.safetyDelay = SAFETY_SYNC_MS;
      if (this.safetyTimer) clearTimeout(this.safetyTimer);
      this.scheduleSafetyScan();
    }
  }

  /**
   * Self-rescheduling safety tick (design 49). The safety scan heals DROPPED
   * watcher events, and drops happen under churn — so quiet intervals (zero
   * watcher events since the previous tick) double the next delay up to 5m,
   * instead of stat-sweeping every tracked file each minute on an idle
   * machine, forever. Any event snaps the delay back to the 60s floor (armed
   * timers are pulled forward by noteChurn), and a missing OR unhealthy live
   * watcher never backs off (there, the scan IS the sync mechanism). The 30m
   * deep scan stays the unconditional floor beneath both.
   */
  private scheduleSafetyScan(): void {
    this.safetyTimer = setTimeout(() => {
      if (this.stopped) return;
      this.advanceSafetyCadenceForTick();
      this.churnSinceSafety = false;
      this.request("fullScan");
      this.scheduleSafetyScan();
    }, jitter(this.safetyDelay));
  }

  private advanceSafetyCadenceForTick(): void {
    if (this.churnSinceSafety) this.consecutiveQuietSafetyTicks = 0;
    else this.consecutiveQuietSafetyTicks++;
    const degradedBackoffEligible = retrustEnabled()
      && this.trustState === "suspect"
      && this.watcherLivenessSinceDrop
      && this.hasCleanUnprunedScanThisEpisode
      && this.consecutiveQuietSafetyTicks >= RETRUST_MIN_QUIET_TICKS;
    // degradedBackoffEligible already embeds the flag; false and absent are
    // identical to nextSafetyDelay, so flag-off output is unchanged.
    this.safetyDelay = nextSafetyDelay(this.safetyDelay, {
      watcherLive: this.watcher !== undefined && this.watcherHealthy,
      churned: this.churnSinceSafety,
      degradedBackoffEligible,
    });
  }

  async stop(): Promise<void> {
    const firstStop = !this.stopped;
    this.stopped = true;
    this.abortMutexBackoff();
    if (firstStop) await this.writePausedAmbientStatusImmediate().catch(() => {});
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    if (this.deepTimer) clearInterval(this.deepTimer);
    for (const audit of this.openDriftAudits) if (audit.timer) clearTimeout(audit.timer);
    this.openDriftAudits.clear();
    if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
    if (this.telemetryFlushTimer) clearInterval(this.telemetryFlushTimer);
    if (this.capabilityInitialTimer) clearTimeout(this.capabilityInitialTimer);
    if (this.capabilityTimer) clearInterval(this.capabilityTimer);
    if (this.syncStateHeartbeatTimer) clearInterval(this.syncStateHeartbeatTimer);
    this.stopActivityHeartbeat();
    this.stopAmbientStatusHeartbeat();
    for (const timer of this.writeFinishRetryTimers) clearTimeout(timer);
    this.writeFinishRetryTimers.clear();
    this.deferredRetryPaths.clear();
    this.gcFenceRetryPaths.clear();
    this.stopWsKeepalive();
    this.clearBackstop();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    await this.watcher?.close();
    // DRAIN the in-flight pump before declaring stopped: SIGTERM shutdown awaits
    // stop(), so this is what makes termination actually graceful — the current
    // op (an applyGitState, a write, an upload) COMPLETES; only queued work is
    // skipped (the loop re-checks `stopped`). Without this, `rbox start`'s stale-
    // daemon restart could interrupt a mutation mid-flight.
    await this.pumpRun.catch(() => {});
    await this.telemetry.flush(AbortSignal.timeout(1500)).catch(() => {});
    await this.activityWrite.catch(() => {}); // flush the final sidecar record (best-effort)
    await this.cache?.save(this.root).catch(() => {});
    await this.writePausedAmbientStatus().catch(() => {});
    if (firstStop) {
      this.log("rbox daemon stopped");
      this.onStopped?.();
    }
  }

  // ---- single-flight pump --------------------------------------------------

  private requestPush(): void {
    if (!this.pullOnly) {
      this.want.push = true;
      this.signalMutexEarlyReprobe();
    }
  }

  private request(kind: keyof Wants): void {
    if (kind === "push") this.requestPush();
    else {
      if (this.pullOnly && kind !== "pull") return;
      this.want[kind] = true;
      this.signalMutexEarlyReprobe();
    }
    this.writeAmbientStatus();
    void this.pump();
  }

  private async loadSyncBase(): Promise<SyncState> {
    const state = await loadState(this.root, syncStreamId(this.cfg), this.log);
    this.syncBase = state;
    return state;
  }

  private startUpdateChecks(): void {
    void runUpdateCheckIfDue(this.cfg.remoteUrl);
    this.updateCheckTimer = setInterval(() => void runUpdateCheckIfDue(this.cfg.remoteUrl), UPDATE_CHECK_TICK_MS);
  }

  /** The in-flight pump loop, if any — awaited by stop() so shutdown drains it. */
  private pumpRun: Promise<void> = Promise.resolve();

  private signalMutexEarlyReprobe(): void {
    if (!this.mutexBackoffResolve) return;
    const now = this.now();
    if (now - this.lastMutexEarlyReprobeAt < MUTEX_EARLY_REPROBE_MS) return;
    this.lastMutexEarlyReprobeAt = now;
    this.mutexBackoffController?.abort();
  }

  private finishMutexBackoff(): void {
    if (this.mutexBackoffTimer) clearTimeout(this.mutexBackoffTimer);
    this.mutexBackoffTimer = undefined;
    this.mutexBackoffController = undefined;
    const resolve = this.mutexBackoffResolve;
    this.mutexBackoffResolve = undefined;
    resolve?.();
  }

  private abortMutexBackoff(): void {
    this.mutexBackoffController?.abort();
    this.finishMutexBackoff();
  }

  private mutexDelay(holderKey: string): { delayMs: number; shouldLog: boolean } {
    if (this.mutexHolderKey !== holderKey) {
      this.mutexHolderKey = holderKey;
      this.mutexBackoffTier = 0;
      this.mutexLoggedTier = -1;
    } else {
      this.mutexBackoffTier = Math.min(this.mutexBackoffTier + 1, MUTEX_BACKOFF_TIERS.length - 1);
    }
    const shouldLog = this.mutexLoggedTier !== this.mutexBackoffTier;
    if (shouldLog) this.mutexLoggedTier = this.mutexBackoffTier;
    return { delayMs: MUTEX_BACKOFF_TIERS[this.mutexBackoffTier]!, shouldLog };
  }

  private resetMutexBackoff(): void {
    this.mutexHolderKey = undefined;
    this.mutexBackoffTier = 0;
    this.mutexLoggedTier = -1;
    this.lastMutexEarlyReprobeAt = Number.NEGATIVE_INFINITY;
  }

  private async waitForMutexBackoff(delayMs: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const controller = new AbortController();
      this.mutexBackoffController = controller;
      this.mutexBackoffResolve = resolve;
      this.mutexBackoffTimer = setTimeout(() => this.finishMutexBackoff(), delayMs);
      controller.signal.addEventListener("abort", () => this.finishMutexBackoff(), { once: true });
    });
  }

  private async clearLockStarvationEpisode(): Promise<void> {
    if (!this.lockStarvationEpisode) return;
    this.lockStarvationEpisode = undefined;
    await fs.rm(lockStarvationPath(this.root), { force: true });
  }

  private async observeLockContention(contention: Extract<DaemonMutexResult, { status: "contended" }>): Promise<void> {
    const reason = contention.warningReason;
    if (!reason) {
      await this.clearLockStarvationEpisode();
      return;
    }
    const now = this.now();
    let episode = this.lockStarvationEpisode;
    if (!episode || episode.holderKey !== contention.holderKey) {
      episode = { holderKey: contention.holderKey, firstSeenAt: now };
      this.lockStarvationEpisode = episode;
      await saveLockStarvationEpisode(this.root, episode);
      return;
    }
    const age = Math.max(0, now - episode.firstSeenAt);
    if (age < LOCK_STARVATION_MS) return;
    if (episode.warnedAt === undefined) {
      this.log(`lock starved: reason=${reason} age=${lockStarvationAgeBucket(age)}`);
      episode = { ...episode, warnedAt: now };
      this.lockStarvationEpisode = episode;
      await saveLockStarvationEpisode(this.root, episode);
    }
    if (episode.countedAt === undefined) {
      episode = { ...episode, countedAt: now };
      this.lockStarvationEpisode = episode;
      // Persist the episode fence before the metric: a crash may lose one count,
      // but can never count the same starvation episode twice.
      await saveLockStarvationEpisode(this.root, episode);
      this.metrics.lockStarved += 1;
      await saveMetrics(this.root, this.metrics);
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    const run = this.pumpLoop();
    this.pumpRun = run;
    return run;
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (!this.stopped && (this.want.pull || this.want.push || this.want.fullScan || this.want.deepScan)) {
        // Resolve WHICH op this iteration runs up front — the halt bookkeeping below
        // is keyed on it (a halt is only healed by a success of the SAME kind).
        const op: keyof Wants = this.want.deepScan ? "deepScan" : this.want.fullScan ? "fullScan" : this.want.pull ? "pull" : "push";
        const acquired = await this.acquireSyncMutexFn(this.root);
        if (acquired.status === "contended") {
          // Do not clear want[op]: contention must requeue, never consume, this tick.
          await this.observeLockContention(acquired).catch(() => {
            this.log("lock starvation state unavailable");
          });
          const backoff = this.mutexDelay(acquired.holderKey);
          if (backoff.shouldLog) this.log(`pump op ${op}: sync busy; re-queued (backoff ${backoff.delayMs}ms)`);
          await this.waitForMutexBackoff(backoff.delayMs);
          continue;
        }
        this.resetMutexBackoff();
        await this.clearLockStarvationEpisode().catch(() => {
          this.log("lock starvation state unavailable");
        });
        const syncMutex = acquired.handle;
        try {
          const binding = this.syncBase ?? await this.loadSyncBase();
          const bindingMatches = await daemonBindingMatches(this.root, syncStreamId(this.cfg), expectedStateNonce(binding));
          if (!bindingMatches) {
            this.log("daemon binding changed while idle (stream/state nonce mismatch) — stopping before mutation");
            this.stopped = true;
            break;
          }
          const opWatcherGeneration = this.watcherUnsettledGeneration;
          const opWatcherErrorGeneration = this.watcherErrorGeneration;
          try {
            let pushedToRemote = false;
            this.pushTerminalBlocked = false;
            this.want[op] = false;
            this.activePumpOp = op;
            this.writeAmbientStatus();
            this.appliedPendingEventsInOp = false;
            try {
              if (op === "deepScan") {
                const cov = await this.doDeepScan();
                this.maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration, cov);
                this.requestPush();
              } else if (op === "fullScan") {
                const cov = await this.doFullScan();
                this.maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration, cov);
                if (this.activity.outOfStorage) this.outOfStorageProbeArmed = true;
                this.requestPush();
              } else if (op === "pull") {
                const notifyPendingAt = this.notifyPullPendingAt;
                const notifyLatencyMs = notifyPendingAt !== undefined ? Date.now() - notifyPendingAt : undefined;
                this.notifyPullPendingAt = undefined;
                // §6: the standalone metric event fires at dequeue — measured latency is recorded
                // even if the pull below fails (the pull-line token then simply never prints).
                if (notifyLatencyMs !== undefined) this.log(`notify_latency_ms=${notifyLatencyMs}`);
                const catchUpGeneration = this.pendingCatchUpGeneration;
                this.pendingCatchUpGeneration = undefined;
                try {
                  await this.doPull(syncMutex, notifyLatencyMs, notifyPendingAt);
                } catch (e) {
                  // A failed catch-up pull must not orphan its generation: restore it so the eventual
                  // healing pull (backstop / next frame) can still mark the socket caught up.
                  // markWsCaughtUp discards stale generations, so restoring a superseded one is harmless.
                  if (catchUpGeneration !== undefined) this.pendingCatchUpGeneration ??= catchUpGeneration;
                  throw e;
                }
                if (catchUpGeneration !== undefined) this.markWsCaughtUp(catchUpGeneration);
                this.requestPush(); // publish any local divergence after taking remote
              } else {
                const quotaProbe = this.activity.outOfStorage !== undefined && this.outOfStorageProbeArmed;
                this.outOfStorageProbeArmed = false;
                if (this.activity.outOfStorage && !quotaProbe) {
                  await this.applyPendingWatchEvents();
                } else {
                  await this.doPush(syncMutex);
                  pushedToRemote = true;
                }
              }
              this.maybeClearWatcherUnsettledAfterOp(op, opWatcherGeneration);
              if (this.syncBase) this.syncStateReporter.afterSyncTick(this.syncBase);
            } finally {
              this.activePumpOp = undefined;
              this.activeProgressPath = undefined;
              this.writeAmbientStatus();
            }
            // Op completed: any live progress is over. A standing halt is healed ONLY by
            // a success of the op kind that recorded it — a mass-delete-guard halt from a
            // pull must survive the queued push's no-op success and every safety scan.
            // Anything less flaps the warning off within seconds.
            // Persist when something visible changed (or as a throttled heartbeat, so
            // `rbox status` can say "last checked: Ns ago" without idle disk churn).
            const terminalBlocked = op === "push" && this.pushTerminalBlocked;
            const heals = !terminalBlocked && this.activity.halt !== undefined && this.activity.halt.op === op;
            const clearsOutOfStorage = pushedToRemote && this.activity.outOfStorage !== undefined;
            const cleared = this.activity.active !== undefined || heals || clearsOutOfStorage || terminalBlocked;
            this.activity.active = undefined;
            this.activeProgressPath = undefined;
            if (heals) {
              this.activity.halt = undefined;
            }
            if (clearsOutOfStorage) {
              this.activity.outOfStorage = undefined;
            }
            if (heals || clearsOutOfStorage) {
              // The healed failure's dedup streak ends with it: a LATER failure with the
              // same message is a new episode that must log and persist a fresh visible
              // state, not silently count as repeat 2..9 and leave activity.json healed.
              this.lastErrMsg = "";
              this.errRepeat = 0;
            }
            if (cleared || this.activityDirty || Date.now() - this.lastActivityWrite > 30_000) this.writeActivity();
          } catch (e) {
            // A capture/config lane transition is saved before later upload/commit
            // work. If that later work fails, refresh the durable truth here rather
            // than waiting for a successful operation that may never arrive.
            try {
              const now = Date.now();
              const before = this.syncBase ? renderShellDeferrals(this.syncBase, now, ageBucket) : undefined;
              const durableState = await this.loadSyncBase();
              this.emitDurableGitDeferrals(durableState, now);
              if (before !== renderShellDeferrals(durableState, now, ageBucket)) this.writeActivity();
            } catch {
              // Preserve the original pump failure if the visibility refresh fails.
            }
            // Dedup a persistent error (e.g. a dead workspace 404s on EVERY op): log the
            // first hit and every 10th after, with the running count — so the log stays
            // readable while still showing exactly how long the failure has persisted.
            const msg = e instanceof Error ? e.message : String(e);
            this.errRepeat = msg === this.lastErrMsg ? this.errRepeat + 1 : 1;
            this.lastErrMsg = msg;
            const shouldLogRepeat = this.errRepeat === 1 || this.errRepeat % 10 === 0;
            if (e instanceof QuotaExceededError) {
              const visibleChanged = this.recordOutOfStorage(e, op);
              if (shouldLogRepeat) this.log(`pump op quota: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
              if (visibleChanged || shouldLogRepeat) this.writeActivity();
              await sleep(jitter(1000));
              continue;
            }
            if (e instanceof CommitRejectedError) {
              this.activity.active = undefined;
              this.activeProgressPath = undefined;
              this.activity.halt = {
                at: new Date().toISOString(),
                reason: msg,
                count: this.errRepeat,
                op,
                ...(e.fingerprint ? { terminal: { fingerprint: e.fingerprint } } : {}),
              };
              if (shouldLogRepeat) {
                this.log(`pump op blocked: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
                this.writeActivity();
              }
              await sleep(jitter(1000));
              continue;
            }
            // The halt record is the failure's user-visible surface (design 45): without
            // it a mass-delete-guard refusal (design 44) stalls background sync with no
            // indicator anywhere but this log. Persisted on the log-line schedule.
            this.activity.active = undefined;
            this.activeProgressPath = undefined;
            this.activity.halt = { at: new Date().toISOString(), reason: msg, count: this.errRepeat, op };
            if (shouldLogRepeat) {
              this.log(`pump op error: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
              this.writeActivity();
            }
            await sleep(jitter(1000)); // brief backoff so a persistent error can't hot-loop
          }
        } finally {
          await releaseWorkspaceSyncMutex(syncMutex);
        }
      }
      await this.cache.save(this.root);
      this.writeAmbientStatus();
      // Settle the sidecar: all wants are drained here, so re-render if
      // the state CHANGED from the last write — the mid-pump write said `pending`
      // (push still queued) and the no-op push wrote nothing; an idle workspace must
      // read `ok`. State-compared, so a truly unchanged pump writes nothing extra.
      const settledNow = this.localSettled();
      if (shellLineStateOf(this.activity, settledNow, Date.now()) !== this.lastShellState) this.writeActivity();
    } finally {
      this.pumping = false;
    }
  }

  private async doPush(syncMutex: WorkspaceSyncMutex): Promise<void> {
    this.typeFlipsSincePull = 0; // per-op tally — a failed prior op's flips must not inflate this one's count
    await this.applyPendingWatchEvents();
    const blockedFingerprint = this.terminalPushBlock();
    const report = beginReport("push");
    let res: Awaited<ReturnType<typeof pushManifest>>;
    try {
      const pushManifestInput = this.gcFenceRetryPaths.size > 0 && this.syncBase
        ? deferManifest(this.manifest, this.syncBase.lastSyncedManifest, this.gcFenceRetryPaths)
        : this.manifest;
      res = await pushManifest(this.root, this.cfg, pushManifestInput, {
        ...this.e2ee,
        cache: this.cache,
        syncMutex,
        blockedFingerprint,
        onCommitConflict: () => this.bumpConflict("commit"),
        report,
        onGitLog: this.log, // design 43 §10: capture/carry/defer/remove forensics in the daemon log
        onGitDeferralsSaved: (state) => this.observeDurableGitState(state),
        onProgress: (done, total, phase, detail, bytes) => this.onTransferProgress(done, total, phase, detail, bytes), // design 45 + 88: progress plus local status path
        onPullApplied: (a) => this.recordPullApplied(a), // design 45: the 409-recovery pull mutates the tree too
        onTypeFlip: (rel) => this.noteTypeFlip(rel), // design 50: 409-recovery pull can evict a dir too
        telemetry: this.telemetry,
      });
    } catch (e) {
      if (e instanceof CommitRejectedError && e.stillBlocked) {
        this.pushTerminalBlocked = true;
        this.logTerminalPushBlocked(e.fingerprint);
        return;
      }
      throw e;
    }
    this.manifest = res.manifest; // stays fresh even across a conflict re-scan (committed subset)
    // Forensic record: every ADVANCE of the remote sequence this daemon caused, with the
    // resulting tree size and anything it had to defer. Gated on `committed` (design 44):
    // a push whose internal 409-recovery PULLED a remote sequence and then no-opped must
    // not be logged as if THIS daemon published it — and the steady-state no-op stays
    // silent so it doesn't fill the log.
    if (res.committed && res.sequence !== this.lastLoggedSeq) {
      const deferredNote =
        res.deferred && res.deferred.length > 0
          ? `; deferred ${res.deferred.length}: ${res.deferred.slice(0, LOG_PATHS_MAX).map(cleanPath).join(" ")}`
          : "";
      this.log(`push: published sequence ${res.sequence} (${res.manifest.files.length} files${deferredNote})`);
    }
    this.lastLoggedSeq = res.sequence;
    if (res.committed) {
      // The status trail: "last push: 2m ago — N files → sequence S" (design 45).
      // Its own slot — it must never mask what a recovery pull applied.
      this.activity.lastPush = { at: new Date().toISOString(), files: res.manifest.files.length, sequence: res.sequence };
      this.activityDirty = true;
    }
    // Files deferred because they were still changing under the push: re-enqueue them
    // promptly (bounded) rather than waiting for the 60s safety scan. Reuses the same
    // per-path retry budget as mid-write files — a pathologically-churning file gives up
    // to the safety/deep scan instead of hot-looping. res.manifest already carries their
    // base (or omits them), so a genuine settle is re-detected by the change event's re-hash.
    if (res.deferred && res.deferred.length > 0) {
      const retryLater = new Set(res.retryLater ?? []);
      const writeFinish = new Set(res.deferred.filter((p) => !retryLater.has(p)));
      if (writeFinish.size > 0) this.scheduleWriteFinishRetry(writeFinish);
      if (retryLater.size > 0) this.scheduleGcFenceRetry(retryLater);
    }
    const durableState = await this.loadSyncBase();
    this.emitDurableGitDeferrals(durableState);
    this.metrics.syncs += 1;
    await saveMetrics(this.root, this.metrics);
    report?.logSummaryTo(this.log); // Explicit metrics opt-out is silent. By default even a
    // no-op tick logs its state-load/git-plan cost — intentional since design 82 §4 (the
    // invisible steady-state cost is exactly what that design instruments).
  }

  private terminalPushBlock(): string | undefined {
    const halt = this.activity.halt;
    if (!halt || halt.op !== "push") return undefined;
    return halt.terminal?.fingerprint;
  }

  private logTerminalPushBlocked(fingerprint: string | undefined): void {
    if (!fingerprint || this.lastTerminalBlockFingerprint === fingerprint) return;
    this.lastTerminalBlockFingerprint = fingerprint;
    const reason = this.activity.halt?.reason ?? "push is blocked";
    this.log(`push blocked: ${reason} — change the workspace or raise limits`);
  }

  private recordOutOfStorage(e: QuotaExceededError, op: keyof Wants): boolean {
    const next: NonNullable<DaemonActivity["outOfStorage"]> = {
      at: new Date().toISOString(),
      kind: e.kind,
      ...(e.used !== undefined ? { used: e.used } : {}),
      ...(e.cap !== undefined ? { cap: e.cap } : {}),
      ...(e.reason === "no_plan" ? { reason: e.reason } : {}),
    };
    const prev = this.activity.outOfStorage;
    const clearsStaleQuotaHalt =
      this.activity.halt !== undefined &&
      op === "push" &&
      this.activity.halt.op === "push" &&
      this.activity.halt.reason === e.message;
    const visibleChanged =
      clearsStaleQuotaHalt ||
      !prev ||
      prev.kind !== next.kind ||
      prev.used !== next.used ||
      prev.cap !== next.cap ||
      prev.reason !== next.reason;
    this.activity.active = undefined;
    this.activeProgressPath = undefined;
    if (clearsStaleQuotaHalt) this.activity.halt = undefined;
    this.activity.outOfStorage = next;
    this.outOfStorageProbeArmed = false;
    return visibleChanged;
  }

  private async applyPendingWatchEvents(): Promise<void> {
    if (this.pendingEvents.length > 0) {
      const events = this.pendingEvents;
      this.pendingEvents = [];
      this.appliedPendingEventsInOp = true;
      for (const audit of this.openDriftAudits) {
        for (const e of events) {
          if (audit.appliedEvents.length < AUDIT_EVENT_CAP) audit.appliedEvents.push(e);
          else { audit.overflow = true; break; }
        }
      }
      // If the ignore rules themselves changed, rebuild the matcher and full-rescan
      // so newly-ignored paths are dropped (and re-included ones picked up) — the
      // incremental matcher would otherwise be stale until restart. [M3b]
      if (events.some((e) => isIgnoreRuleFile(e.relPath))) {
        this.rebuildMatcher(await this.loadSyncBase());
        this.rulesChangedSinceDeepScan = true;
        const { deferred } = await this.replaceManifestFromScan(this.cache, this.manifest, undefined, undefined, "pruned");
        await this.resolveDriftFromAppliedEvents(events, deferred);
      } else {
        const deferred = new Set<string>();
        this.manifest = await applyWatchEvents(this.manifest, this.root, this.matcher, events, this.cache, deferred);
        await this.resolveDriftFromAppliedEvents(events, deferred);
        // A path that hashed cleanly this round is settled — clear any retry it accrued.
        for (const e of events) if (!deferred.has(e.relPath)) this.writeFinishRetries.delete(e.relPath);
        if (deferred.size > 0) this.scheduleWriteFinishRetry(deferred);
      }
    }
  }

  /**
   * Re-enqueue mid-write paths as `change` events after a short quiet, so a large save
   * that was still being written when we hashed gets picked up promptly rather than
   * waiting for the 60s safety scan. Bounded per path — after a few tries we give up and
   * let the safety/deep scan be the floor, so a pathological never-settling file can't
   * hot-loop the pump forever.
   */
  private scheduleWriteFinishRetry(paths: Set<string>): void {
    const MAX_RETRIES = 15; // ~3s of retrying at RETRY_DELAY_MS before deferring to safety scan
    const RETRY_DELAY_MS = 200;
    const retryable: string[] = [];
    for (const p of paths) {
      const n = (this.writeFinishRetries.get(p) ?? 0) + 1;
      if (n <= MAX_RETRIES) {
        this.writeFinishRetries.set(p, n);
        this.deferredRetryPaths.add(p);
        retryable.push(p);
      } else {
        this.writeFinishRetries.delete(p); // give up; the safety scan will heal it
        this.deferredRetryPaths.delete(p);
      }
    }
    if (retryable.length === 0 || this.stopped) return;
    const timer = setTimeout(() => {
      this.writeFinishRetryTimers.delete(timer);
      if (this.stopped) return;
      for (const p of retryable) {
        this.deferredRetryPaths.delete(p);
        this.pendingEvents.push({ relPath: p, kind: "change" });
      }
      this.request("push");
    }, RETRY_DELAY_MS);
    this.writeFinishRetryTimers.add(timer);
  }

  /** A GC publication fence is deliberately long-lived. Keep these paths in the
   * existing deferred set (so status remains unsettled), but requeue only on an
   * hours-scale timer; the ordinary 200ms write-finish loop would re-upload bytes
   * that the server has already accepted and deterministically receive another 503. */
  private scheduleGcFenceRetry(paths: Set<string>): void {
    for (const p of paths) {
      this.deferredRetryPaths.add(p);
      this.gcFenceRetryPaths.add(p);
    }
    if (paths.size === 0 || this.stopped) return;
    const timer = setTimeout(() => {
      this.writeFinishRetryTimers.delete(timer);
      if (this.stopped) return;
      for (const p of paths) {
        this.deferredRetryPaths.delete(p);
        this.gcFenceRetryPaths.delete(p);
        this.pendingEvents.push({ relPath: p, kind: "change" });
      }
      this.request("push");
    }, GC_FENCE_RETRY_MS);
    timer.unref?.();
    this.writeFinishRetryTimers.add(timer);
  }

  private async doPull(syncMutex: WorkspaceSyncMutex, notifyLatencyMs?: number, notifyPendingAt?: number): Promise<void> {
    if (this.e2ee.remote instanceof E2eeRemote) {
      const pin = await this.e2ee.remote.loadVerifiedPin();
      this.chainRepairPolicy.assertHeadAllowed(pin);
    }
    this.typeFlipsSincePull = 0; // per-op tally — a failed prior op's flips must not inflate this one's count
    const report = beginReport("pull");
    // onGitLog: per-repo apply/conflict/defer forensics (design 43 §10) land in the daemon log.
    // onPullApplied carries BOTH the forensic log line and the status trail — wired
    // here and in doPush's deps so the pull inside push's 409 recovery is recorded
    // identically; its actions are discarded by the retry loop.
    const pullDeps: SyncDeps = {
      ...this.e2ee,
      cache: this.cache,
      syncMutex,
      report,
      onGitLog: this.log,
      onGitDeferralsSaved: (state) => this.observeDurableGitState(state),
      onProgress: (done, total, phase, detail, bytes) => this.onTransferProgress(done, total, phase, detail, bytes), // design 45 + 88
      onPullApplied: (a) => this.recordPullApplied(a),
      onTypeFlip: (rel) => this.noteTypeFlip(rel), // design 50 §3: forensic line + conflict count
      telemetry: this.telemetry,
    };
    let actions: Action[];
    try {
      actions = await pull(this.root, this.cfg, pullDeps);
    } catch (error) {
      if (!(error instanceof ManifestChainError)) throw error;
      let refusal: SuffixInfo[] | undefined;
      const outcome = await repairChain(this.root, this.cfg, pullDeps, error, {
        confirmSupersede: async (suffix) => {
          const selfOnly = this.chainRepairPolicy.confirmSupersede(suffix);
          if (!selfOnly) refusal = suffix;
          return selfOnly;
        },
      });
      if (outcome.kind === "declined") {
        const suffix = refusal ?? outcome.suffix;
        throw this.chainRepairPolicy.halt(error, suffix);
      }
      actions = outcome.kind === "converged"
        ? [...outcome.actions, ...await pull(this.root, this.cfg, pullDeps)]
        : outcome.actions;
    }
    this.chainRepairPolicy.clear();
    if (notifyPendingAt !== undefined) {
      try { this.telemetry.record({ kind: "propagation", deliveryToApplyMs: Math.max(0, Date.now() - notifyPendingAt) }); } catch {}
    }
    report?.logSummaryTo((line) =>
      this.log(notifyLatencyMs !== undefined ? `${line} notify_latency_ms=${notifyLatencyMs}` : line),
    );
    const fileConflicts = actions.filter((a) => a.kind === "conflict").length;
    if (fileConflicts > 0) {
      this.metrics.fileConflicts += fileConflicts;
      this.metrics.lastConflictAt = new Date().toISOString();
      await saveMetrics(this.root, this.metrics);
    }
    // A pull that WROTE an ignore-rule file must refresh the matcher before the rescan
    // below and the pump's follow-up push — otherwise that push publishes files the
    // freshly pulled rules exclude (same hazard doPush guards on watcher events).
    if (actions.some((a) => isIgnoreRuleFile(a.kind === "write" ? a.entry.path : a.path))) {
      this.rebuildMatcher(await this.loadSyncBase());
      this.rulesChangedSinceDeepScan = true;
    }
    // The pull advanced the local base sequence; remember it so the follow-up no-op
    // push isn't logged as if THIS daemon published the remotely-produced sequence.
    const base = await this.loadSyncBase();
    this.emitDurableGitDeferrals(base);
    this.lastLoggedSeq = base.lastSyncedSequence;
    // Refresh in-memory truth from disk (cache-warm: pull invalidated written paths).
    // Deferred paths carry the POST-pull base entry, never the pre-pull manifest —
    // carrying pre-pull truth would let the follow-up push publish a stale entry
    // over the version this pull just applied.
    await this.replaceManifestFromScan(this.cache, base.lastSyncedManifest, undefined, undefined, "pruned");
  }

  private bumpConflict(_kind: "commit"): void {
    this.metrics.commitConflicts409 += 1;
    this.metrics.lastConflictAt = new Date().toISOString();
  }

  /** Pending activity persistence — writes CHAIN on this promise so overlapping
   *  saves can never land out of order (an older record must not win). NEVER awaited
   *  on the sync path (a slow sidecar write must not delay a single op);
   *  drained only by stop() so graceful shutdown flushes the final record. */
  private activityWrite: Promise<void> = Promise.resolve();
  /** The shell.line state most recently WRITTEN — compared at pump exit so an idle
   *  workspace settles back to `ok` (the last op's write can render
   *  `pending` because the follow-up push was still queued, and the no-op push
   *  never writes — without the settle pass the glyph reads pending forever). */
  private lastShellState?: string;
  /** Last shell.deferrals rendering scheduled for persistence; null means no write
   * has been attempted yet, so startup still removes a stale empty sidecar. */
  private lastShellDeferrals: string | undefined | null = null;
  /** Instance-local suppression only; authoritative episode state remains state.json. */
  private readonly gitDeferralLogSeen = new Map<string, GitDeferralLogSeen>();

  private emitDurableGitDeferrals(state: SyncState | undefined, now = Date.now()): void {
    if (!state) return;
    for (const line of durableGitDeferralLines(state, this.gitDeferralLogSeen, now)) this.log(line);
  }

  /** Runs synchronously after the authoritative state save, before later network
   * work can hang/fail, so every new durable episode becomes locally visible. */
  private observeDurableGitState(state: SyncState, now = Date.now()): void {
    const before = this.syncBase
      ? renderShellDeferrals(this.syncBase, now, ageBucket, projectedRepoRecords(this.syncBase))
      : undefined;
    this.syncBase = state;
    this.emitDurableGitDeferrals(state, now);
    if (before !== renderShellDeferrals(state, now, ageBucket, projectedRepoRecords(state))) this.writeActivity();
  }

  /** Persist the activity record and bump the pump heartbeat. */
  private writeActivity(): void {
    this.enqueueActivityWrite(true);
  }

  /** Persist the activity record after a WS-only update. */
  private writeWsActivity(): void {
    this.enqueueActivityWrite(false);
  }

  /** Timer-driven daemon heartbeat: proves the process is alive even if a pump op is hung. */
  private startActivityHeartbeat(intervalMs = ACTIVITY_HEARTBEAT_MS): void {
    if (this.activityHeartbeatTimer || this.stopped) return;
    this.activityHeartbeatTimer = setInterval(() => {
      if (!this.stopped) this.enqueueActivityWrite(true);
    }, intervalMs);
  }

  private stopActivityHeartbeat(): void {
    if (!this.activityHeartbeatTimer) return;
    clearInterval(this.activityHeartbeatTimer);
    this.activityHeartbeatTimer = undefined;
  }

  private startAmbientStatusHeartbeat(intervalMs = AMBIENT_STATUS_HEARTBEAT_MS): void {
    if (this.ambientStatusHeartbeatTimer || this.stopped) return;
    this.ambientStatusHeartbeatTimer = setInterval(() => {
      if (!this.stopped) this.writeHeartbeatSurfaces();
    }, intervalMs);
    this.ambientStatusHeartbeatTimer.unref?.();
  }

  private stopAmbientStatusHeartbeat(): void {
    if (!this.ambientStatusHeartbeatTimer) return;
    clearInterval(this.ambientStatusHeartbeatTimer);
    this.ambientStatusHeartbeatTimer = undefined;
  }

  private startTelemetryTimers(): void {
    this.telemetryFlushTimer = setInterval(() => {
      if (!this.stopped && !this.telemetry.empty) void this.telemetry.flush(AbortSignal.timeout(1500)).catch(() => {});
    }, 120_000);
    this.telemetryFlushTimer.unref?.();
    const capability = () => {
      if (!this.stopped) {
        try { this.telemetry.record({ kind: "capability", workerExecutions: cryptoPoolStatus().workerExecutions }); } catch {}
      }
    };
    this.capabilityInitialTimer = setTimeout(() => {
      capability();
      if (this.stopped) return;
      this.capabilityTimer = setInterval(capability, 6 * 60 * 60_000);
      this.capabilityTimer.unref?.();
    }, 5 * 60_000);
    this.capabilityInitialTimer.unref?.();
    this.syncStateHeartbeatTimer = setInterval(() => {
      if (!this.stopped && this.syncBase) this.syncStateReporter.heartbeat(this.syncBase);
    }, 60 * 60_000);
    this.syncStateHeartbeatTimer.unref?.();
  }

  private markLocalUnsettledFromWatchEvent(): void {
    const wasUnsettled = this.watcherUnsettled;
    this.watcherUnsettled = true;
    this.watcherUnsettledGeneration++;
    if (!this.syncBase || (wasUnsettled && this.activity.local?.settled === false)) return;
    this.enqueueActivityWrite(false);
  }

  private localSettled(): boolean {
    return (
      this.activePumpOp === undefined &&
      !this.watcherUnsettled &&
      !this.want.pull &&
      !this.want.push &&
      !this.want.fullScan &&
      !this.want.deepScan &&
      this.pendingEvents.length === 0 &&
      this.deferredRetryPaths.size === 0
    );
  }

  private maybeClearWatcherUnsettledAfterOp(op: keyof Wants, opWatcherGeneration: number): void {
    if (!this.watcherUnsettled || this.watcherUnsettledGeneration > opWatcherGeneration || this.pendingEvents.length > 0) return;
    const refreshedLocalTruth = this.appliedPendingEventsInOp || op === "pull" || op === "fullScan" || op === "deepScan";
    if (refreshedLocalTruth) this.watcherUnsettled = false;
  }

  /** A completed full-tree scan covers the dropped-events window. Clear the ambient
   *  warning only for a live watcher that reported no further error during that scan;
   *  periodic-scan mode has no watcher to recover and therefore remains degraded. */
  private maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration: number, cov: ScanCoverage): void {
    // Visible-degraded clear: keyed on the PUMP-OP-START generation, byte-identical
    // to pre-104 behavior — a second error DURING the covering scan (bumping errorGen
    // after this capture) must keep status degraded (daemon-activity.test.ts).
    const stable = this.watcher && this.watcherDegraded && this.watcherErrorGeneration === opWatcherErrorGeneration;
    if (stable) { this.watcherDegraded = false; this.writeAmbientStatus(); }
    if (!retrustEnabled()) return;
    // Re-trust uses the scan's OWN inside-scan coverage evidence (design 85 R1 F8):
    // coverage originates at the walker; a drop during config-reload OR
    // the walk advances errorGen past errorGenAtStart and blocks re-trust.
    const clean = this.watcher !== undefined && cov.coverage === "full-tree" && cov.errorGenAtStart === this.watcherErrorGeneration;
    if (!clean) return;
    if (this.trustState !== "suspect") return;
    this.hasCleanUnprunedScanThisEpisode = true; // P2 episode evidence
    if (this.watcherErrorGeneration > this.lastTrustedErrorGeneration
      && Date.now() - this.lastTransientDropMs >= this.recoveryHoldMs) {
      this.lastTrustedErrorGeneration = this.watcherErrorGeneration;
      this.setTrustState("trusted", `re-trusted after clean full-tree scan (errorGen=${this.watcherErrorGeneration})`);
      this.watcherDegraded = false;
      this.resetSuspectEpisodeState();
      this.writeAmbientStatus();
    }
  }

  private setTrustState(next: TrustState, reason: string): void {
    if (this.trustState === next) return;
    this.trustState = next;
    this.watcherHealthy = next === "trusted";
    if (next !== "trusted") for (const audit of this.openDriftAudits) {
      audit.watcherHealthy = false;
      audit.trustState = worseTrust(audit.trustState, next);
    }
    this.log(`watcher trust ${this.trustState} (${reason})`);
  }

  private resetSuspectEpisodeState(): void {
    this.watcherLivenessSinceDrop = false;
    this.hasCleanUnprunedScanThisEpisode = false;
    this.consecutiveQuietSafetyTicks = 0;
  }

  private localSnapshot(settled: boolean, now: number): DaemonActivity["local"] | undefined {
    const base = this.syncBase;
    if (!base) return undefined;
    const manifestDiff = diffManifests(base.lastSyncedManifest, this.manifest);
    return {
      at: new Date(now).toISOString(),
      stream: base.stream,
      baseSequence: base.lastSyncedSequence,
      trackedFiles: this.manifest.files.length,
      added: manifestDiff.added.length,
      changed: manifestDiff.changed.length,
      deleted: manifestDiff.deleted.filter((p) => !this.matcher.ignores(p)).length,
      settled,
      sourceVersion: 1,
    };
  }

  private ambientStatusFrom(snapshot: DaemonActivity, settled: boolean, now: number): RboxBarAmbientStatus {
    return {
      ...projectAmbientDaemonStatus({
        activity: snapshot,
        settled,
        now,
        sequence: this.lastLoggedSeq,
        activePumpOp: this.activePumpOp,
        want: this.want,
        watcherDegraded: this.watcherDegraded,
        ownershipLost: this.ownershipWindDownStarted,
        currentPath: this.activeProgressPath,
        repoRecords: this.syncBase ? projectedRepoRecords(this.syncBase) : undefined,
      }),
      fileCount: this.manifest.files.length,
      totalBytes: this.manifest.files.reduce((n, f) => n + f.size, 0),
      daemonVersion: RBOX_VERSION,
      workspaceRoot: this.root,
    };
  }

  private activitySnapshot(): DaemonActivity {
    return {
      ...this.activity,
      local: this.activity.local ? { ...this.activity.local } : undefined,
      ws: this.activity.ws ? { ...this.activity.ws } : undefined,
      active: this.activity.active ? { ...this.activity.active } : undefined,
    };
  }

  private async saveAmbientStatusIfOwned(status: AmbientDaemonStatusV1): Promise<void> {
    if (!this.canPersistAmbientStatus(status)) return;
    await saveAmbientDaemonStatus(this.root, status, { beforeRename: () => this.canPersistAmbientStatus(status) });
  }

  private enqueueAmbientStatusWrite(status?: AmbientDaemonStatusV1): void {
    const next =
      status ??
      this.ambientStatusFrom(
        this.activitySnapshot(),
        this.localSettled(),
        Date.now()
      );
    this.activityWrite = this.activityWrite.then(async () => {
      await this.saveAmbientStatusIfOwned(next);
    });
  }

  private writeAmbientStatus(): void {
    this.enqueueAmbientStatusWrite();
  }

  private pausedAmbientStatus(now = Date.now()): RboxBarAmbientStatus {
    const previous = this.ambientStatusFrom(this.activity, this.localSettled(), now);
    return {
      ...pausedAmbientDaemonStatus(now, previous),
      fileCount: previous.fileCount,
      totalBytes: previous.totalBytes,
      daemonVersion: previous.daemonVersion,
      workspaceRoot: previous.workspaceRoot,
    };
  }

  private async writePausedAmbientStatusImmediate(): Promise<void> {
    await this.saveAmbientStatusIfOwned(this.pausedAmbientStatus());
  }

  private async writePausedAmbientStatus(): Promise<void> {
    const paused = this.pausedAmbientStatus();
    this.activityWrite = this.activityWrite.then(async () => {
      await this.saveAmbientStatusIfOwned(paused);
    });
    await this.activityWrite;
  }

  private writeHeartbeatSurfaces(): void {
    const settled = this.localSettled();
    const now = Date.now();
    const snapshot = this.activitySnapshot();
    const shellState = shellLineStateOf(snapshot, settled, now);
    const line = renderShellLine(snapshot, {
      settled,
      sequence: this.lastLoggedSeq,
      name: this.cfg.name ?? this.cfg.remoteWorkspaceId,
      now,
    });
    const ambient = this.ambientStatusFrom(snapshot, settled, now);
    const syncBase = this.syncBase;
    const shellDeferrals = syncBase
      ? renderShellDeferrals(syncBase, now, ageBucket, projectedRepoRecords(syncBase))
      : undefined;
    const writeShellDeferrals = syncBase !== undefined && shellDeferrals !== this.lastShellDeferrals;
    if (syncBase) this.lastShellDeferrals = shellDeferrals;
    this.emitDurableGitDeferrals(syncBase, now);
    this.lastShellState = shellState;
    this.activityWrite = this.activityWrite.then(async () => {
      if (this.canPersistTrustedSurface()) {
        await saveShellLine(this.root, line);
        if (writeShellDeferrals) await saveShellDeferrals(this.root, syncBase!, now, ageBucket);
      }
      await this.saveAmbientStatusIfOwned(ambient);
    });
  }

  private enqueueActivityWrite(bumpHeartbeat: boolean): void {
    if (bumpHeartbeat) {
      this.activity.at = new Date().toISOString();
      this.activityDirty = false;
      this.lastActivityWrite = Date.now();
    }
    // Design 46: the same record ALSO renders the one-line prompt sidecar, chained
    // onto the same promise so BOTH files preserve write ordering and neither is ever
    // awaited on the sync path.
    const settled = this.localSettled();
    const now = Date.now();
    const localSnapshot = this.localSnapshot(settled, now);
    if (localSnapshot) this.activity.local = localSnapshot;
    else this.activity.local = undefined;
    const snapshot = this.activitySnapshot();
    this.lastShellState = shellLineStateOf(snapshot, settled, now);
    const line = renderShellLine(snapshot, {
      settled,
      sequence: this.lastLoggedSeq,
      name: this.cfg.name ?? this.cfg.remoteWorkspaceId,
      now,
    });
    const ambient = this.ambientStatusFrom(snapshot, settled, now);
    const syncBase = this.syncBase;
    const shellDeferrals = syncBase
      ? renderShellDeferrals(syncBase, now, ageBucket, projectedRepoRecords(syncBase))
      : undefined;
    const writeShellDeferrals = syncBase !== undefined && shellDeferrals !== this.lastShellDeferrals;
    if (syncBase) this.lastShellDeferrals = shellDeferrals;
    this.activityWrite = this.activityWrite
      .then(async () => {
        if (!this.canPersistTrustedSurface()) return;
        await saveActivity(this.root, snapshot);
        await saveShellLine(this.root, line);
        if (writeShellDeferrals) await saveShellDeferrals(this.root, syncBase!, now, ageBucket);
        await this.saveAmbientStatusIfOwned(ambient);
      });
  }

  private async writeStartupBinding(): Promise<boolean> {
    if (!this.canPersistTrustedSurface()) return false;
    await recordDaemonBinding(this.root, this.cfg.remoteWorkspaceId, this.bootId);
    return !this.stopped;
  }

  private canPersistTrustedSurface(): boolean {
    const pidfile = readDaemonPidRecord(this.root);
    if (pidfile.version === "v2" && pidfile.bootId !== undefined && pidfile.bootId !== this.bootId) {
      this.beginOwnershipWindDown(`pidfile now belongs to boot ${pidfile.bootId}`);
      return false;
    }
    return true;
  }

  private canPersistAmbientStatus(status: AmbientDaemonStatusV1): boolean {
    if (this.stopped && status.state !== "paused") return false;
    const pidfile = readDaemonPidRecord(this.root);
    if (pidfile.present) this.ambientStatusSawPidfile = true;
    if (pidfile.version === "v2" && pidfile.bootId !== undefined && pidfile.bootId !== this.bootId) {
      this.beginOwnershipWindDown(`pidfile now belongs to boot ${pidfile.bootId}`);
      return false;
    }
    const gracefulPaused = this.stopped && !this.ownershipWindDownStarted && status.state === "paused" && this.ambientStatusSawPidfile;
    if (!pidfile.present && !gracefulPaused) {
      return false;
    }
    return true;
  }

  private beginOwnershipWindDown(reason: string): void {
    if (this.ownershipWindDownStarted || this.stopped) return;
    this.ownershipWindDownStarted = true;
    this.log(`daemon ownership lost: ${reason} — draining and stopping`);
    setTimeout(() => void this.stop(), 0);
  }

  /** Type-flip evictions seen since the last recorded pull (design 50 §3).
   *  onTypeFlip fires DURING applyActions (before the pull's onPullApplied), so it
   *  accumulates here and recordPullApplied folds it into `lastPull.conflicts` and resets. */
  private typeFlipsSincePull = 0;

  /** A pull moved an obstructing local directory to trash so an incoming file/symlink
   *  could land (the EISDIR-flip heal). Forensic log line + folded into the conflict
   *  count so `rbox status`'s last-pull trail surfaces it. */
  private noteTypeFlip(relPath: string): void {
    // Fires for BOTH eviction shapes: an obstructing directory (→ trash) and an
    // obstructing ancestor file (→ visible conflict copy) — word it generically.
    this.log(`pull type-flip conflict: ${cleanPath(relPath)} — local obstruction moved aside (see rbox trash / conflict copies)`);
    this.typeFlipsSincePull++;
  }

  /** Every pull that mutated the local tree — whichever path ran it (doPull, or the
   *  409-recovery pull inside pushManifest). Forensic log line + status trail: this
   *  is the record that answers "did sync change/delete my files?" after the fact. */
  private recordPullApplied(actions: Action[]): void {
    this.log(`pull applied: ${summarizeActions(actions)}`);
    let writes = 0;
    let deletes = 0;
    let conflicts = 0;
    for (const a of actions) {
      if (a.kind === "write") writes++;
      else if (a.kind === "delete") deletes++;
      else conflicts++;
    }
    // Type-flip evictions are conflicts too (a local dir was moved aside), but they arrive
    // out-of-band via onTypeFlip rather than as `conflict` actions — fold + reset the tally.
    this.activity.lastPull = { at: new Date().toISOString(), writes, deletes, conflicts: conflicts + this.typeFlipsSincePull };
    this.typeFlipsSincePull = 0;
    this.activityDirty = true;
  }

  /** Live transfer progress → activity sidecar, throttled to ~2 writes/s so a big
   *  transfer isn't bottlenecked on progress bookkeeping. Phase changes, determinate
   *  final ticks, and raw same-phase regressions bypass the throttle so transitions,
   *  completions, and retry/retraction restarts are visible immediately. */
  private onTransferProgress(
    done: number,
    total: number,
    phase: TransferPhase,
    detailOrBytes?: string | TransferProgressBytes,
    maybeBytes?: TransferProgressBytes
  ): void {
    const detail = typeof detailOrBytes === "string" ? detailOrBytes : undefined;
    const bytes = typeof detailOrBytes === "string" ? maybeBytes : detailOrBytes;
    const now = Date.now();
    const final = total > 0 && done >= total;
    const phaseChanged = phase !== this.lastProgressPhase;
    const active = this.activity.active;
    const regressed =
      active?.phase === phase &&
      (done < active.done ||
        total < active.total ||
        (bytes?.bytesDone !== undefined && active.bytesDone !== undefined && bytes.bytesDone < active.bytesDone) ||
        (bytes?.bytesTotal !== undefined && active.bytesTotal !== undefined && bytes.bytesTotal < active.bytesTotal));
    if (!final && !phaseChanged && !regressed && now - this.lastProgressWrite < 500) return;
    this.lastProgressPhase = phase;
    this.lastProgressWrite = now;
    this.activeProgressPath = detail;
    this.activity.active = {
      at: new Date().toISOString(),
      phase,
      done,
      total,
      ...(bytes ? { bytesDone: bytes.bytesDone, ...(bytes.bytesTotal !== undefined ? { bytesTotal: bytes.bytesTotal } : {}) } : {}),
    };
    this.writeActivity();
  }

  private async doFullScan(): Promise<ScanCoverage> {
    await this.reloadWorkspaceConfigIfChanged();
    const errorGenAtStart = this.watcherErrorGeneration;
    const stats = createScanStats();
    const started = Date.now();
    const { deferred, coverage } = await this.replaceManifestFromScan(this.cache, this.manifest, stats, "safety scan", "pruned");
    if (metricsEnabled()) this.log(scanStatsLine("safety scan", stats, Date.now() - started, deferred.size));
    this.lastSafetyCompletedMs = Date.now();
    this.pruneCache();
    return { coverage, errorGenAtStart };
  }

  /** Cache-bypassing re-hash — the ultimate authority against mtime+size-stable drift. */
  private async doDeepScan(): Promise<ScanCoverage> {
    await this.reloadWorkspaceConfigIfChanged();
    const errorGenAtStart = this.watcherErrorGeneration;
    const scanStartMs = Date.now();
    const priorManifest = this.manifest;
    const eventGenAtScan = this.watcherUnsettledGeneration;
    const rulesChanged = this.rulesChangedSinceDeepScan;
    const stats = createScanStats();
    const audit: OpenDriftAudit = {
      scanStartMs, candidates: [], horizonInputs: new Map(), rawEvents: [], appliedEvents: [], overflow: false,
      watcherHealthy: !!this.watcher && this.watcherHealthy,
      trustState: retrustEnabled() ? this.trustState : "trusted",
      errorGen: this.watcherErrorGeneration,
      sinceSafetyMs: this.lastSafetyCompletedMs === undefined ? 0 : Math.max(0, scanStartMs - this.lastSafetyCompletedMs),
      rulesChanged,
    };
    this.openDriftAudits.add(audit);
    const fresh = new HashCache();
    let scanResult: { freshManifest: Manifest; deferred: Set<string>; coverage: "full-tree" | "pruned" };
    try {
      scanResult = await this.replaceManifestFromScan(fresh, this.manifest, stats, "deep scan", "unpruned");
    } catch (error) {
      this.openDriftAudits.delete(audit);
      throw error;
    }
    const { freshManifest, deferred, coverage } = scanResult;
    this.rulesChangedSinceDeepScan = false;
    if (metricsEnabled()) this.log(scanStatsLine("deep scan", stats, Date.now() - scanStartMs, deferred.size));
    this.cache = fresh; // replace cache with freshly-verified truth (already tight)
    audit.candidates = diffForDrift(priorManifest, freshManifest, {
      firstSeenAtMs: scanStartMs, eventGenAtScan, bootId: this.bootId,
      watcherSessionId: this.watcherSessionId, errorGenAtScan: this.watcherErrorGeneration,
      originUntrusted: retrustEnabled() && audit.trustState !== "trusted",
    });
    // Stash the fresh-scan snapshot for each PENDING candidate now (the fresh
    // manifest is the horizon's disk truth) — but resolve nothing until the settle
    // window closes: a covering event delivered during the next 4s must still be
    // able to retract, and confirmation must share the settle's evidence barrier.
    await this.mutateDriftState((state) => {
      audit.horizonInputs = new Map(state.pending.map((c) => [c.path, snapshotAtPath(freshManifest, c.path)]));
      return false; // read-only
    });
    this.scheduleDriftClassification(audit);
    // Trash retention (design 50 §2): the daemon owns pruning, on the infrequent deep tick
    // ONLY — never the sync hot path. Fire-and-forget: a prune failure must never surface as
    // a pump error. `.active`/young-batch protection (B3) lives in pruneTrash itself.
    void pruneTrash(this.root, trashConfig(this.cfg))
      .then((r) => {
        if (r.removedBatches) this.log(`trash pruned: ${r.removedBatches} batch${r.removedBatches === 1 ? "" : "es"}, ${r.freedBytes} bytes freed`);
      })
      .catch(() => {});
    return { coverage, errorGenAtStart };
  }

  /** Install a coherent full-scan result. A path that changed under its deferred
   *  hash carries `previous`'s entry (never a torn tuple, never a deletion) and
   *  enters the existing write-finish retry loop. */
  private async replaceManifestFromScan(cache: HashCache, previous: Manifest, scanStats: ScanStats | undefined, scanKind: "safety scan" | "deep scan" | undefined, mode: "pruned" | "unpruned"): Promise<{ freshManifest: Manifest; deferred: Set<string>; coverage: "full-tree" | "pruned" }> {
    const deferred = new Set<string>();
    const probeOn = process.env.RBOX_SCAN_PROBE === "1" && scanKind !== undefined;
    const scanStartMs = Date.now();
    const priorProbe = probeOn ? await loadScanProbe(this.root) : undefined;
    const probe = probeOn ? createScanProbe(priorProbe) : undefined;
    const dircache = scanPruneEnabled() ? await DirCache.load(this.root) : undefined;
    const deferErrnos = makeDeferErrnoReporter(this.log, () => {
      try { this.telemetry.record({ kind: "safety_event", eventType: "scan_fault", count: 1 }); } catch {}
    });
    const fresh = await scanManifest(this.root, this.matcher, cache, undefined, undefined, scanStats, deferred, probe, dircache, mode,
      deferErrnos.onErrno, this.log);
    deferErrnos.flush();
    await dircache?.save(this.root);
    this.manifest = deferred.size > 0 ? deferManifest(fresh, previous, deferred) : fresh;
    if (deferred.size > 0) this.scheduleWriteFinishRetry(deferred);
    if (probe) {
      const summary = probe.summary();
      this.log(`scan probe: dirs=${summary.dirs} eligible=${summary.eligible} eligibleReaddirMs=${summary.eligibleReaddirMs} totalReaddirMs=${summary.totalReaddirMs} projectedDircacheBytes=${summary.projectedDircacheBytes} probeOverheadMs=${summary.probeOverheadMs}`);
      // Measurement only — a probe sidecar write failure must never fail the scan op.
      await saveScanProbe(this.root, scanStartMs, probe).catch((e) => this.log(`scan probe sidecar write failed: ${errCode(e)}`));
    }
    // Coverage originates HERE — the function that invokes the tree walker. It is
    // read from the DIRCACHE (the component that made the pruning decision), never
    // from the optional metrics struct: a pruned scan can heal but must never
    // testify to watcher re-trust (design 104 R1 F8). No dircache ⇒ unpruned walk ⇒
    // "full-tree". Callers forward this value unchanged.
    return { freshManifest: fresh, deferred, coverage: coverageOf(dircache?.lastOutcome ?? "off") };
  }

  /** Serialized sidecar transaction. `fn` returning false means "unchanged" and
   *  skips the disk write — the empty-pending case runs on EVERY settled watch
   *  batch and must cost nothing. Persistence failures are measurement-only:
   *  the in-memory state stays coherent, the failure is logged once, and the
   *  caller (the pump's apply path included) NEVER sees an error. */
  private async mutateDriftState(fn: (state: DriftAuditState) => boolean | void | Promise<boolean | void>): Promise<void> {
    const run = this.driftIo.then(async () => {
      try {
        const state = this.driftState ??= await loadDriftAudit(this.root);
        const dirty = await fn(state);
        if (dirty === false) return;
        await saveDriftAudit(this.root, state);
        this.driftSaveFailedLogged = false;
      } catch (e) {
        if (!this.driftSaveFailedLogged) {
          this.driftSaveFailedLogged = true;
          this.log(`drift audit sidecar write failed (measurement only, sync unaffected): ${errCode(e)}`);
        }
      }
    });
    this.driftIo = run;
    await run;
  }

  private async resolveDriftFromAppliedEvents(events: WatchEvent[], deferred: Set<string>): Promise<void> {
    await this.mutateDriftState((state) => {
      if (state.pending.length === 0) return false;
      const result = resolveCoveredAtApply(state.pending, events, deferred, this.manifest);
      if (result.pending.length === state.pending.length) return false;
      state.pending = result.pending;
      state.resolvedSinceLastAudit.lateCovered += result.lateCovered;
      state.resolvedSinceLastAudit.coveredAmbiguous += result.coveredAmbiguous;
    });
  }

  private scheduleDriftClassification(audit: OpenDriftAudit): void {
    audit.timer = setTimeout(() => { void this.runDriftAuditNow(audit); }, AUDIT_SETTLE_MS);
    audit.timer.unref?.();
  }

  /** Close the audit's observation window: filter this scan's candidates
   *  (racing / re-verify / quiescence stamp) AND resolve the prior horizon —
   *  both inside ONE serialized sidecar transaction whose decision section is
   *  synchronous, so no covering event can slip between "decided" and
   *  "persisted": until the audit leaves `openDriftAudits` (inside that
   *  section) raw events still buffer into it, and afterwards the candidate is
   *  already in the in-memory pending set that apply-time resolution reads.
   *  Deterministic test seam: production reaches this from the settle timer. */
  async runDriftAuditNow(audit = this.openDriftAudits.values().next().value): Promise<void> {
    if (!audit || !this.openDriftAudits.has(audit)) return;
    if (audit.timer) clearTimeout(audit.timer);
    audit.timer = undefined;
    try {
      // Re-verification hashes candidate paths — do it OUTSIDE the transaction
      // (the audit is still open, so its event buffer keeps accumulating; the
      // final coverage check below re-reads it synchronously).
      const reverified = new Map<string, EntrySnapshot | null | undefined>();
      for (const candidate of audit.candidates) {
        if (!audit.overflow) reverified.set(candidate.path, await reverifyPath(this.root, candidate.path));
      }
      let racing = 0, confirmed = 0, confirmedQuiescent = 0, reverted = 0, unattributable = 0, maxDriftAgeMs = 0;
      let resolved = { lateCovered: 0, coveredAmbiguous: 0 };
      let survivorCount = 0, pendingHeld = 0;
      let quiescent = false;
      await this.mutateDriftState((state) => {
        // ---- synchronous decision section (no awaits past this point) ----
        const pendingCoverage = [...audit.rawEvents, ...audit.appliedEvents, ...this.pendingEvents, ...[...this.deferredRetryPaths].map((relPath) => ({ relPath, kind: "change" as const }))];
        quiescent = !audit.overflow && audit.rawEvents.length === 0;
        const survivors: DriftCandidate[] = [];
        // Loop-invariant: the audit's trust stamp is monotonically downgraded and
        // never changes mid-loop (the decision section is synchronous).
        const auditContaminated = retrustEnabled() && audit.trustState !== "trusted";
        for (const candidate of audit.candidates) {
          if (audit.overflow || eventsCoverPath(pendingCoverage, candidate.path)) { racing++; continue; }
          const current = reverified.get(candidate.path);
          if (current === undefined) { racing++; continue; }
          // The same retained-expected mismatch must survive; healed scan churn is dropped.
          if (candidateStillMismatch(candidate, current)) {
            const originUntrusted = candidate.originUntrusted || auditContaminated;
            survivors.push({ ...candidate, quiescentAtScan: quiescent, ...(originUntrusted ? { originUntrusted: true } : {}) });
          }
        }
        const held: DriftCandidate[] = [];
        const continuity = {
          bootId: this.bootId, watcherSessionId: this.watcherSessionId,
          errorGeneration: this.watcherErrorGeneration,
          watcherUnhealthySince: !this.watcher || !this.watcherHealthy || !audit.watcherHealthy,
        };
        for (const candidate of state.pending) {
          // Event-time truth is binding: a candidate covered by ANY event seen
          // through this settle window — raw, settled-but-unapplied, or deferred —
          // stays pending for apply-time resolution. A candidate this audit never
          // stashed a disk observation for (an overlapping audit's survivor) holds too.
          if (eventsCoverPath(pendingCoverage, candidate.path) || !audit.horizonInputs.has(candidate.path)) { held.push(candidate); continue; }
          const cls = horizonClass(candidate, audit.horizonInputs.get(candidate.path) ?? null, continuity);
          if (cls === "confirmed") {
            confirmed++;
            if (candidate.quiescentAtScan) confirmedQuiescent++;
            maxDriftAgeMs = Math.max(maxDriftAgeMs, audit.scanStartMs - candidate.firstSeenAtMs);
          } else if (cls === "reverted") reverted++;
          else unattributable++;
        }
        const before = state.pending.length;
        state.pending = mergePending(held, survivors);
        survivorCount = survivors.length;
        pendingHeld = held.length;
        resolved = state.resolvedSinceLastAudit;
        state.resolvedSinceLastAudit = { lateCovered: 0, coveredAmbiguous: 0 };
        this.openDriftAudits.delete(audit); // window closed — atomically with the pending update
        return before !== 0 || state.pending.length !== 0 || resolved.lateCovered !== 0 || resolved.coveredAmbiguous !== 0;
      });
      this.log(`deep-scan drift: candidates=${audit.candidates.length} survivors=${survivorCount} pendingHeld=${pendingHeld} confirmed=${confirmed} confirmedQuiescent=${confirmedQuiescent} late-covered=${resolved.lateCovered} covered-ambiguous=${resolved.coveredAmbiguous} unattributable=${unattributable} racing=${racing} reverted=${reverted} quiescent=${quiescent ? "y" : "n"} watcherHealthy=${audit.watcherHealthy ? "y" : "n"}${retrustEnabled() ? ` trustState=${audit.trustState}` : ""} errorGen=${audit.errorGen} sinceSafetyMs=${audit.sinceSafetyMs} rawEvents=${audit.rawEvents.length} rulesChanged=${audit.rulesChanged ? "y" : "n"} maxDriftAgeMs=${maxDriftAgeMs}`);
    } catch (e) {
      this.openDriftAudits.delete(audit);
      this.log(`drift audit failed (measurement only, sync unaffected): ${errCode(e)}`);
    }
  }

  /**
   * Bound the on-disk HashCache: after a full scan the manifest is the complete set
   * of live paths, so drop cache entries for anything no longer present (deleted,
   * renamed, branch-switched-away). Without this the cache grows monotonically over
   * a workspace's lifetime — real disk bloat on fast-churning monorepos.
   */
  private pruneCache(): void {
    this.cache.prune(new Set(this.manifest.files.map((f) => f.path)));
  }

  private rebuildMatcher(state?: { lastSyncedManifest: Manifest }): void {
    this.matcher = buildIgnoreMatcher(this.root, {
      respectGitignore: this.cfg.respectGitignore === true,
      knownGitRepos: Object.keys(state?.lastSyncedManifest.gitRepos ?? {}),
    });
  }

  private async reloadWorkspaceConfigIfChanged(): Promise<void> {
    const file = path.join(this.root, ".rbox", "workspace.json");
    const st = await fs.stat(file).catch(() => undefined);
    if (!st) return;
    const token = { mtimeMs: st.mtimeMs, size: st.size };
    if (this.workspaceConfigStat && this.workspaceConfigStat.mtimeMs === token.mtimeMs && this.workspaceConfigStat.size === token.size) return;
    this.workspaceConfigStat = token;
    const loaded = await loadConfig(this.root);
    const wasRespecting = this.cfg.respectGitignore === true;
    // Take ONLY the field this reload exists for. Rebuilding cfg from `loaded`
    // clobbers the RUNTIME-ATTACHED fields buildAuthedRemote layered on at boot
    // (`encrypted: true`, `kek`, the credential `remoteUrl` override) — none of
    // which live in workspace.json. That shipped in v0.9.2 and killed every
    // daemon push with "E2EE required" minutes after start (first reload tick),
    // live on 2026-07-07. cfg stays the boot object; only the hot-reloadable
    // setting moves.
    this.cfg = { ...this.cfg, respectGitignore: loaded.respectGitignore };
    this.rebuildMatcher(await this.loadSyncBase());
    if (wasRespecting !== (this.cfg.respectGitignore === true)) {
      this.log(`workspace config reloaded: respectGitignore ${this.cfg.respectGitignore === true ? "on" : "off"}`);
    }
  }

  // ---- live notification channel (optional; correctness never depends on it) ----

  private wsBase(): NonNullable<DaemonActivity["ws"]> {
    return {
      connected: false,
      at: new Date().toISOString(),
      caughtUp: false,
      bootId: this.bootId,
      pid: process.pid,
      ...(this.activity.ws?.lastBroadcastSequence !== undefined
        ? { lastBroadcastSequence: this.activity.ws.lastBroadcastSequence }
        : {}),
    };
  }

  private markWsStartupDisconnected(): void {
    this.activity.ws = this.wsBase();
    this.writeWsActivity();
  }

  private markWsOpen(ws: WebSocket): number {
    const generation = ++this.wsGeneration;
    this.activity.ws = {
      ...this.wsBase(),
      connected: true,
    };
    this.writeWsActivity();
    this.startWsKeepalive(ws);
    this.armPongDeadline(ws);
    return generation;
  }

  private markWsDisconnected(ws: WebSocket, reason: "close" | "error" | "timeout"): boolean {
    if (this.ws !== ws) return false;
    this.ws = undefined;
    this.stopWsKeepalive();
    this.wsGeneration++;
    this.pendingCatchUpGeneration = undefined;
    this.activity.ws = {
      ...this.wsBase(),
      connected: false,
      caughtUp: false,
      at: new Date().toISOString(),
    };
    this.writeWsActivity();
    this.wsReconnects++;
    this.log(`ws_reconnect reason=${reason} count=${this.wsReconnects}`);
    if (reason === "error") this.log("ws error");
    return true;
  }

  private markWsCaughtUp(generation: number): void {
    if (generation !== this.wsGeneration || !this.activity.ws?.connected) return;
    this.activity.ws = { ...this.activity.ws, caughtUp: true, bootId: this.bootId, pid: process.pid };
    this.writeWsActivity();
  }

  private refreshWsAtThrottled(): void {
    if (!this.activity.ws?.connected) return;
    const now = Date.now();
    this.activity.ws = { ...this.activity.ws, at: new Date(now).toISOString(), bootId: this.bootId, pid: process.pid };
    if (now - this.lastWsKeepaliveWrite < WS_KEEPALIVE_PERSIST_MS) return;
    this.lastWsKeepaliveWrite = now;
    this.writeWsActivity();
  }

  private recordCommittedFrame(sequence: number): void {
    if (!Number.isInteger(sequence) || sequence < 0) {
      this.refreshWsAtThrottled();
      return;
    }
    const current = this.activity.ws ?? this.wsBase();
    const lastBroadcastSequence = Math.max(current.lastBroadcastSequence ?? 0, sequence);
    this.activity.ws = {
      ...current,
      connected: true,
      at: new Date().toISOString(),
      caughtUp: current.caughtUp,
      lastBroadcastSequence,
      bootId: this.bootId,
      pid: process.pid,
    };
    this.writeWsActivity();
  }

  private handleWsMessageData(data: string, from?: WebSocket): void {
    if (from !== undefined && this.ws !== from) return;
    if (this.ws) this.armPongDeadline(this.ws);
    if (data === "pong") {
      this.refreshWsAtThrottled();
      return;
    }
    try {
      const m = JSON.parse(data) as { type?: string; sequence?: unknown };
      if (m.type === "committed") {
        this.recordCommittedFrame(typeof m.sequence === "number" ? m.sequence : -1);
        if (!this.wsReliabilityDisabled) this.notifyPullPendingAt ??= Date.now();
        this.request("pull");
        this.scheduleNextBackstop();
      } else {
        this.refreshWsAtThrottled();
      }
    } catch {
      this.refreshWsAtThrottled();
    }
  }

  private handleWsClose(ws: WebSocket): void {
    if (this.markWsDisconnected(ws, "close")) this.scheduleReconnect();
  }

  private handleWsError(ws: WebSocket): void {
    if (!this.markWsDisconnected(ws, "error")) return;
    try {
      ws.close();
    } catch {
      /* will fire close */
    }
    this.scheduleReconnect();
  }

  private startWsKeepalive(ws: WebSocket): void {
    this.stopWsKeepalive();
    this.wsKeepaliveTimer = setInterval(() => {
      if (this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send("ping");
      } catch {
        /* close/error will drive reconnect */
      }
    }, WS_PING_MS);
  }

  /** Tear down the whole WebSocket liveness apparatus (keepalive interval + pong deadline). */
  private stopWsKeepalive(): void {
    if (this.wsKeepaliveTimer) clearInterval(this.wsKeepaliveTimer);
    this.wsKeepaliveTimer = undefined;
    this.clearPongDeadline();
  }

  private armPongDeadline(ws: WebSocket): void {
    if (this.pongDeadlineMs <= 0) return;
    if (this.wsPongDeadlineTimer) clearTimeout(this.wsPongDeadlineTimer);
    this.wsPongDeadlineTimer = setTimeout(() => this.onPongDeadline(ws), this.pongDeadlineMs);
    this.wsPongDeadlineTimer.unref?.();
  }

  private clearPongDeadline(): void {
    if (this.wsPongDeadlineTimer) clearTimeout(this.wsPongDeadlineTimer);
    this.wsPongDeadlineTimer = undefined;
  }

  private onPongDeadline(ws: WebSocket): void {
    if (this.stopped || this.ws !== ws) return;
    this.wsHalfOpenDetected++;
    this.log(`ws half-open detected — no frame in ${Math.round(this.pongDeadlineMs / 1000)}s; cycling socket (ws_half_open_detected=${this.wsHalfOpenDetected})`);
    if (!this.markWsDisconnected(ws, "timeout")) return;
    try {
      ws.close();
    } catch {
      /* half-open close is best-effort; reconnect is already scheduled */
    }
    this.scheduleReconnect();
  }

  private startBackstop(): void {
    this.armBackstop(Math.floor(Math.random() * this.backstopMs)); // first tick: uniform(0, interval)
  }

  private scheduleNextBackstop(): void {
    this.armBackstop(jitter(this.backstopMs)); // subsequent ticks: interval ±25%
  }

  private armBackstop(delayMs: number): void {
    if (this.backstopMs <= 0) return;
    if (this.backstopTimer) clearTimeout(this.backstopTimer);
    this.backstopTimer = setTimeout(() => this.onBackstopTick(), delayMs);
    this.backstopTimer.unref?.();
  }

  private onBackstopTick(): void {
    if (this.stopped || this.backstopMs <= 0) return;
    this.wsBackstopPulls++;
    this.log(`ws backstop pull (ws_backstop_pull=${this.wsBackstopPulls})`);
    this.request("pull");
    this.scheduleNextBackstop();
  }

  private clearBackstop(): void {
    if (this.backstopTimer) clearTimeout(this.backstopTimer);
    this.backstopTimer = undefined;
  }

  private maybeConnect(): void {
    if (!this.wsDisabled) this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.api.wsConnectUrl()}?device=${encodeURIComponent(this.cfg.deviceId)}`;
    let ws: WebSocket;
    try {
      // Bun's WebSocket client accepts a `{ headers }` option (verified) that the
      // standard lib types omit; declare that signature rather than cast to a lie.
      const BunWebSocket = WebSocket as unknown as {
        new (url: string, opts: { headers: Record<string, string> }): WebSocket;
      };
      ws = new BunWebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.token}` } });
    } catch (e) {
      this.log(`ws connect failed: ${e instanceof Error ? e.message : String(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt = 0;
      this.log("ws connected");
      const generation = this.markWsOpen(ws);
      this.pendingCatchUpGeneration = generation;
      this.request("pull"); // catch up on anything missed while disconnected
      this.scheduleNextBackstop();
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      this.handleWsMessageData(String(ev.data), ws);
    });
    ws.addEventListener("pong", () => {
      if (this.ws !== ws) return;
      this.armPongDeadline(ws);
    });
    ws.addEventListener("close", () => {
      this.handleWsClose(ws);
    });
    ws.addEventListener("error", () => {
      this.handleWsError(ws);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt++;
    setTimeout(() => this.connect(), delay);
  }
}

/** Run the daemon until SIGTERM/SIGINT. Used by the hidden `__daemon-run` command. */
export async function runDaemon(root: string): Promise<void> {
  const logger = new RotatingDaemonLogger(root, () => new Date(), fsSync);
  const bootId = logger.bootId;
  logger.boot();
  let daemon: RboxDaemon | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const shutdown = async () => {
    try { await daemon?.stop(); } finally { finish(); }
  };
  try {
    const { cfg, deps } = await buildAuthedRemote(root, Date.now, logger.log); // E2EE transport + injected KEK
    await loadState(root, syncStreamId(cfg), logger.log); // surfaces corrupt-state errors loudly before we go live
    daemon = new RboxDaemon(root, cfg, { ...deps, onGitLog: logger.log, warningSink: logger.log }, {
      bootId,
      pullOnly: process.env.RBOX_DAEMON_PULL_ONLY === "1",
      log: logger.log,
      onStopped: finish,
    });
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    await daemon.start();
    await stopped;
  } finally {
    process.removeListener("SIGTERM", shutdown);
    process.removeListener("SIGINT", shutdown);
    if (daemon) await daemon.stop().catch(() => {});
    logger.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
