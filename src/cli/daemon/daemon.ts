import os from "node:os";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ALWAYS_NATIVE_PRUNE,
  buildIgnoreMatcher,
  nativePruneGlobs,
  discoverGitRepos,
  discoverGitReposUnder,
  diffManifests,
  isIgnoreRuleFile,
  HashCache,
  createScanStats,
  type IgnoreMatcher,
  type Manifest,
  type WatchEvent,
  type DiscoveredGitRepo,
  ManifestChainError,
  PhaseReport,
  cryptoPoolStatus,
  manifestPathCaseFold,
  type CaseFoldCollisionGroup,
} from "../../engine/index.js";
import type { Action } from "../../engine/reconcile.js";
import { MutationGateClosedError, ShutdownMutationGate } from "../../engine/mutation-gate.js";
import { loadActivity, renderShellDeferrals, renderShellLine, saveActivity, saveShellDeferrals, saveShellLine, shellLineStateOf, type DaemonActivity } from "../activity.js";
import { expectedStateNonce, loadConfig, loadState, repoRecordsForState, syncStreamId, trashConfig, type SyncState, type WorkspaceConfig } from "../config.js";
import { pruneTrash } from "../../engine/trash.js";
import { DAEMON_BOOT_ID_ENV, readDaemonPidRecord, recordDaemonBinding } from "./runtime-state.js";
import { MassDeleteGuardError, PushConflictExhaustedError, pull, pushManifest, type SyncDeps, type TrustedLocalView } from "../sync.js";
import type { TransferPhase, TransferProgressBytes } from "../transfer-progress.js";
import { buildAuthedRemote } from "../e2ee-client.js";
import { ensureFolderAuthority } from "../folder-authority.js";
import {
  applyFolderPolicy,
  folderPolicyFields,
  observeFolderAdmission,
  runtimeRefusal,
} from "../folder-inventory.js";
import { folderCatalogPath } from "../rbox-paths.js";
import { E2eeRemote } from "../e2ee-remote.js";
import { beginReport, loadMetrics, metricsEnabled, saveMetrics, type SyncMetrics } from "../metrics.js";
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
} from "./drift-audit.js";
import { lowerIoPriority } from "../io-priority.js";
import { QuotaExceededError, RboxApi } from "../remote.js";
import { envInt } from "../remote/resilient.js";
import { CommitRejectedError } from "../remote.js";
import { createSignalDebouncer, startWatcher, type GitSignalBatch, type SignalDebouncer, type Watcher } from "./watcher.js";
import { gitRefSideChannelEligible } from "./git-ref-watch.js";
import { GitDiscoveryContinuity } from "./git-discovery-continuity.js";
import {
  LocalRetryQueue,
  LocalWorkspaceObserver,
  type ScanObservationReceipt,
} from "./local-workspace-observer.js";
import { runUpdateCheckIfDue } from "../update-check.js";
import {
  AMBIENT_STATUS_HEARTBEAT_MS,
  pausedAmbientDaemonStatus,
  projectAmbientDaemonStatus,
  type AmbientDaemonStatusV1,
  type DaemonMode,
} from "./ambient-status.js";
import { saveAmbientDaemonStatus } from "./ambient-status-writer.js";
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
import { resolveBindingScope, ScopedBindingRefusal, type BindingScope } from "../scope/binding-scope.js";
import {
  ACTIVITY_HEARTBEAT_MS,
  ChainRepairHaltError,
  classifyWatcherError,
  DaemonChainRepairPolicy,
  DEEP_SCAN_MS,
  jitter,
  recoveryProbeDelayMs,
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
  type PumpOperation,
  UPDATE_CHECK_TICK_MS,
  type Wants,
  worseTrust,
  WS_KEEPALIVE_PERSIST_MS,
  WS_CURSOR_CHECK_MS,
  WS_PING_MS,
  WS_PONG_DEADLINE_DEFAULT_MS,
} from "./policy.js";
import {
  gitReposMatcherKey,
  gitTopologyChanged,
  patchManifestFromPull,
  pullTrustWatcherEnabled,
  type TrustedPullViewResult,
} from "./manifest-update.js";
import {
  DaemonOperationScheduler,
  readLockStarvationEpisode,
  type DaemonOperationExecutor,
  type DaemonSchedulerPorts,
} from "./daemon-operation-scheduler.js";
import { LocalAuthority } from "./local-observation-transition.js";
import { classifyPublishOutcome, PublishLocalWorkspaceTransition } from "./daemon-publish-transition.js";
import {
  ApplyRemoteWorkspaceTransition,
  buildTrustedPullView,
  classifyPullOutcome,
  type PullTrustFacts,
} from "./daemon-pull-transition.js";
import { cleanPath, LOG_PATHS_MAX, scanStatsLine, summarizeActions } from "./render.js";
import { errCode, RotatingDaemonLogger, type DaemonLogSink } from "./logger.js";
import { TelemetryQueue } from "../telemetry/queue.js";
import { TELEMETRY_SAMPLE_SCHEMAS, telemetryEnabled, type GitCaptureSample } from "../telemetry/contract.js";
import { SyncPhaseSampler } from "../telemetry/sync-phase.js";
import { SyncStateReporter } from "../telemetry/sync-state.js";
import { inspectResetJournalSafety } from "../reset-halt-inspection.js";
import { clearResetHaltHealth, readResetHaltHealth, writeResetHaltHealth } from "../reset-health.js";
import { buildPathWarnings, readPathWarnings, savePathWarnings } from "../path-warnings.js";
import { RESET_RECOVERY_RETRY_MS, ResetHaltLogGate } from "./reset-halt-policy.js";
import { acknowledgeCacheGeneration, readCacheGeneration } from "../adopt-cache.js";
import { reconcileGitDeferrals, type DeferralHygieneCursor } from "../sync-git/deferral-hygiene.js";
import { gitDivergenceStatus } from "../sync-git/status.js";
import { recoverStateCasLocks } from "../sync-git/state-cas-locks.js";
import { GENESIS_ACCOUNT_ID_RE } from "../genesis-durable.js";
import {
  KeyDeliveryFulfillmentFlight,
  keyDeliveryPreferenceOverrideFromEnv,
  parseKeyDeliveryNudge,
  rboxKeyDeliveryApi,
  type KeyDeliveryFlightPort,
} from "./key-delivery-fulfill.js";

type RboxBarAmbientStatus = AmbientDaemonStatusV1 & {
  fileCount: number;
  totalBytes: number;
  daemonVersion: string;
  mode: DaemonMode;
  bootId: string;
  workspaceRoot: string;
};

const TELEMETRY_FLUSH_MS = 120_000;
const CAPABILITY_INITIAL_DELAY_MS = 5 * 60_000;
const CAPABILITY_INTERVAL_MS = 6 * 60 * 60_000;
const SYNC_STATE_HEARTBEAT_MS = 60 * 60_000;
export const GIT_BUSY_RETRY_DELAYS_MS = [2_000, 8_000] as const;

interface ReloadStatToken { mtimeMs: number; size: number }

async function reloadStatToken(file: string): Promise<ReloadStatToken | null> {
  const stat = await fs.stat(file).catch(() => undefined);
  return stat ? { mtimeMs: stat.mtimeMs, size: stat.size } : null;
}

function sameReloadStatToken(a: ReloadStatToken | null | undefined, b: ReloadStatToken | null): boolean {
  return a !== undefined && (a === null
    ? b === null
    : b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size);
}

function sameWorkspaceBindingIdentity(boot: WorkspaceConfig, loaded: WorkspaceConfig): boolean {
  return boot.schema === loaded.schema
    && boot.remoteWorkspaceId === loaded.remoteWorkspaceId
    && boot.projectId === loaded.projectId
    && boot.deviceId === loaded.deviceId
    && path.resolve(boot.rootPath) === path.resolve(loaded.rootPath);
}

export interface GitBusyRetryClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface RecoveryProbeClock extends GitBusyRetryClock {}
export interface CursorClock extends GitBusyRetryClock {}
/** Superset of #403's SafetyCadenceClock: t3's pull-only deep-scan cadence
 * needs injectable setInterval too, so one seam drives both timers. */
export interface ScanCadenceClock extends GitBusyRetryClock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
export interface DaemonShutdownClock extends GitBusyRetryClock {}
class RecoveryProbePreflightError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RecoveryProbePreflightError";
  }
}
class RecoveryConditionPersistsError extends Error {
  constructor(readonly halt: NonNullable<DaemonActivity["halt"]>) {
    super(halt.reason);
    this.name = "RecoveryConditionPersistsError";
  }
}
type ClassifiedOperationFailure =
  | { kind: "quota"; error: QuotaExceededError }
  | {
    kind: "halt";
    error: unknown;
    typedReason?: NonNullable<DaemonActivity["halt"]>["typedReason"];
    terminal?: { fingerprint: string };
    blocked: boolean;
  };
export type PushProvenance = Readonly<{ signal: boolean; candidate: boolean; scan: boolean; other: boolean }>;

export function gitCaptureSampleForProvenance(provenance: PushProvenance): GitCaptureSample | undefined {
  if (provenance.signal) return { kind: "git_capture", signalPushes: 1, candidatePushes: 0, scanPushes: 0 };
  if (provenance.candidate) return { kind: "git_capture", signalPushes: 0, candidatePushes: 1, scanPushes: 0 };
  if (provenance.scan) return { kind: "git_capture", signalPushes: 0, candidatePushes: 0, scanPushes: 1 };
  return undefined;
}

interface ScanCoverage { coverage: "full-tree" | "pruned"; errorGenAtStart: number }
type Carrier = "none" | "backstop" | "cursor" | "notify";

/** A retained safe subset cannot patch collision-related events incrementally:
 * an omitted sibling may be the survivor. Ancestor directory events count too. */
export function caseCollisionEventsRequireScan(
  groups: readonly CaseFoldCollisionGroup[],
  events: readonly WatchEvent[],
): boolean {
  return events.some((event) => {
    const eventFold = manifestPathCaseFold(event.relPath.replace(/\/$/, ""));
    return groups.some((group) => group.paths.some((collisionPath) => {
      const collisionFold = manifestPathCaseFold(collisionPath);
      return eventFold === collisionFold
        || collisionFold.startsWith(`${eventFold}/`)
        || ((event.kind === "addDir" || event.kind === "unlinkDir") && eventFold.startsWith(`${collisionFold}/`));
    }));
  });
}
const CARRIER_PRECEDENCE: Readonly<Record<Carrier, number>> = { none: 0, backstop: 1, cursor: 2, notify: 3 };

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
  private readonly syncPhaseSampler = new SyncPhaseSampler();
  private readonly syncStateReporter: SyncStateReporter;
  private matcher: IgnoreMatcher; // rebuilt when .gitignore/.rboxignore changes
  /** Design 224 §2.3: last observed stranded-ignored count from a push projection.
   *  Undefined until this daemon has projected once. */
  private strandedIgnored: number | undefined;
  private cache!: HashCache;
  /** LOCAL authority — head, unread cursor, completeness, and the P5/P7 provenance
   *  trusted-pull reads (`CommitLocalObservation`). The daemon never assigns them. */
  private readonly local = new LocalAuthority();
  /** P7: the base `gitRepos` key set `this.matcher` was last built from. */
  private matcherGitReposKey = gitReposMatcherKey();
  /** Design 206 §2: bumped by every `rebuildMatcher`. */
  private matcherGeneration = 0;
  /** The `nativePruneGlobs` output the live parcel subscription was created with —
   *  backend state no facade can retro-fix (design 206 §3b). */
  private watcherNativePruneKey: string;
  private activeCaseCollisions: CaseFoldCollisionGroup[] = [];
  private pathWarningWrite: Promise<void> = Promise.resolve();
  private syncBase?: SyncState;
  private resetLifecycle: "ready" | "halted" | "recovering" | "bootstrapping" = "ready";
  private resetRetryTimer?: ReturnType<typeof setTimeout>;
  private nextResetRetryAt = Number.NEGATIVE_INFINITY;
  private resetHaltIdentity?: string;
  private resetHaltReason?: string;
  private readonly resetHaltLogGate = new ResetHaltLogGate();
  private pendingEvents: WatchEvent[] = [];
  private gitSignalDebouncer?: SignalDebouncer;
  /** Sole owner of repository topology, absence authority, and the Linux
   * safety-cadence floor. The daemon supplies discovery effects and consumes
   * receipts; it holds none of that state itself. */
  private readonly gitDiscovery = new GitDiscoveryContinuity({
    discoverAll: () => discoverGitRepos(this.root, this.matcher),
    discoverUnder: (owner) => discoverGitReposUnder(this.root, owner, this.matcher),
    pinSafetyFloor: () => this.pinSafetyFloor(),
    log: (line) => this.log(line),
  });
  private pendingPushReasons = { signal: false, candidate: false, scan: false, other: false };
  private gitBusyEpisode?: { timers: unknown[]; queuedStages: number[] };

  private watcher?: Watcher;
  private ws?: WebSocket;
  private wsKeepaliveTimer?: ReturnType<typeof setInterval>;
  private wsPongDeadlineTimer?: ReturnType<typeof setTimeout>;
  private cursorTimer?: unknown;
  private cursorEpoch = 0;
  private cursorAbortController?: AbortController;
  private cursorReplyResolve?: (head: number) => void;
  private backstopTimer?: ReturnType<typeof setTimeout>;
  private notifyPullPendingAt?: number;
  private queuedCarrier: Carrier = "none";
  /** Retains a coalesced backstop beneath a higher-priority notify so a WS
   * generation change can discard only the stale WS provenance. */
  private queuedBackstopPending = false;
  private wsReconnects = 0;
  private wsBackstopPulls = 0;
  private wsHalfOpenDetected = 0;
  private backstopAppliedPulls = 0;
  private cursorAppliedPulls = 0;
  private notifyAppliedPulls = 0;
  // Only the three cumulative-and-logged counters need a last-sampled baseline;
  // the *AppliedPulls counters are telemetry-only and reset to 0 each sample.
  private lastSampledWsReconnects = 0;
  private lastSampledWsBackstopPulls = 0;
  private lastSampledWsHalfOpenDetected = 0;
  private notifyLatencyCount = 0;
  private notifyLatencySumMs = 0;
  private notifyLatencyMaxMs = 0;
  private readonly monotonicNow: () => number;
  private monotonicLastMs: number;
  private wsHealthWindowStartedMs: number;
  private wsConnectedSinceMs?: number;
  private wsConnectedAccumulatedMs = 0;
  private activityHeartbeatTimer?: ReturnType<typeof setInterval>;
  private ambientStatusHeartbeatTimer?: ReturnType<typeof setInterval>;
  private wsGeneration = 0;
  private pendingCatchUpGeneration?: number;
  private lastWsKeepaliveWrite = 0;
  private safetyTimer?: unknown;
  private deepTimer?: unknown;
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
  private shutdownPromise?: Promise<void>;
  private startupBoundaryRun?: Promise<void>;
  private readonly mutationGate: ShutdownMutationGate;
  private startupLockRecoveryDone = false;
  /** Sole owner of local disk observation: the tree walk, the bounded watcher
   * patch, and the per-path retry queue their deferrals arm. The daemon supplies
   * effects and sequences receipts; it holds none of that queue itself. */
  private readonly localObserver: LocalWorkspaceObserver;
  private readonly retryQueue: LocalRetryQueue;
  private watcherUnsettled = false;
  private watcherUnsettledGeneration = 0;
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
  private workspaceConfigStat?: ReloadStatToken | null;
  private folderCatalogStat?: ReloadStatToken | null;
  private folderAdmissionHaltReason?: string;
  private folderMatcherRebuildPending = false;
  private folderPolicyRecyclePending = false;
  private folderPolicyRecycleFailure?: string;
  private observedAdoptCacheGeneration = 0;

  /** Sole owner of the wakeup queue, the recovery episode, mutex backoff/starvation,
   *  the active operation, and the single-flight/drain state. */
  private readonly scheduler: DaemonOperationScheduler;
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
  /** Design 212 §3.1b layer 3: NOT readonly — scope, not the startup environment
   *  bit or the desired-mode record, is the authority for this. It is re-derived at
   *  every operation boundary under the mutex, and can only ever narrow to
   *  pull-only. */
  private pullOnly: boolean;
  /** Whether this binding syncs only part of the workspace, as of the last
   *  operation boundary. */
  private scoped = false;
  /** The scope generation this process's cached and watcher-fed observations were
   *  built under. A change fences them all by ending the process. */
  private scopeGeneration: number | undefined;
  private readonly acquireSyncMutexFn: (root: string) => Promise<DaemonMutexResult>;
  private readonly now: () => number;
  private readonly recoveryRandom: () => number;
  private readonly recoveryClock: RecoveryProbeClock;
  private readonly deferralHygieneCursor: DeferralHygieneCursor = {};
  private deferralHygieneRunning = false;
  private readonly deferralHygieneBudgetMs: number;
  private readonly gitBusyRetryClock: GitBusyRetryClock;
  private readonly wsDisabled: boolean;
  private readonly wsReliabilityDisabled: boolean;
  private readonly pongDeadlineMs: number;
  private readonly cursorCheckMs: number;
  private readonly cursorClock: CursorClock;
  private readonly scanCadenceClock: ScanCadenceClock;
  private readonly cursorRandom: () => number;
  private readonly backstopMs: number;
  private readonly log: DaemonLogSink;
  private readonly onStopped?: () => void;
  /** Independent account-key release worker. It never enters the workspace sync
   * mutex and shutdown only drains its own bounded in-flight request. */
  private readonly keyDeliveryFlight?: KeyDeliveryFlightPort;

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
      monotonicNow?: () => number;
      gitBusyRetryClock?: GitBusyRetryClock;
      recoveryRandom?: () => number;
      recoveryClock?: RecoveryProbeClock;
      cursorClock?: CursorClock;
      scanCadenceClock?: ScanCadenceClock;
      cursorRandom?: () => number;
      deferralHygieneBudgetMs?: number;
      log?: DaemonLogSink;
      onStopped?: () => void;
      /** Test seam; null explicitly disables the production fulfillment flight. */
      keyDeliveryFlight?: KeyDeliveryFlightPort | null;
    } = {},
  ) {
    this.log = opts.log ?? ((message) => console.log(`${new Date().toISOString()} ${message}`));
    this.mutationGate = new ShutdownMutationGate(() => this.writeAmbientStatus());
    this.gitBusyRetryClock = opts.gitBusyRetryClock ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.onStopped = opts.onStopped;
    this.api = new RboxApi(cfg.remoteUrl, cfg.token, cfg.remoteWorkspaceId, cfg.projectId, this.log);
    if (opts.keyDeliveryFlight !== undefined) {
      this.keyDeliveryFlight = opts.keyDeliveryFlight ?? undefined;
    } else if (cfg.accountId && GENESIS_ACCOUNT_ID_RE.test(cfg.accountId)) {
      this.keyDeliveryFlight = new KeyDeliveryFulfillmentFlight({
        accountId: cfg.accountId,
        deviceId: cfg.deviceId,
        workspaceId: cfg.remoteWorkspaceId,
        pullOnly: opts.pullOnly === true,
        preferenceOverride: keyDeliveryPreferenceOverrideFromEnv(),
        api: rboxKeyDeliveryApi(this.api),
        log: this.log,
      });
    }
    this.telemetry = new TelemetryQueue(this.api, this.log);
    this.retryQueue = new LocalRetryQueue({
      requeue: (paths) => {
        for (const p of paths) this.pendingEvents.push({ relPath: p, kind: "change" });
        this.request("push");
      },
      markUnsettled: (p) => this.local.markUnsettled(p),
      stopped: () => this.stopped,
    });
    this.localObserver = new LocalWorkspaceObserver({
      root,
      currentManifest: () => this.local.manifest,
      currentMatcher: () => this.matcher,
      matcherGeneration: () => this.matcherGeneration,
      scanMode: () => this.watcherScanMode(),
      beginTopologySnapshot: (scanKind) => this.gitDiscovery.beginScanSnapshot(scanKind),
      observeTopology: (observation) => this.gitDiscovery.observe(observation),
      authority: this.local,
      log: (line) => this.log(line),
      recordScanFault: () => {
        try { this.telemetry.record({ kind: "safety_event", eventType: "scan_fault", count: 1 }); } catch {}
      },
    }, this.retryQueue);
    this.syncStateReporter = new SyncStateReporter(root, cfg, this.api, this.log);
    this.matcher = buildIgnoreMatcher(root, { respectGitignore: cfg.respectGitignore === true });
    this.watcherNativePruneKey = nativePruneGlobs(root).join("\n");
    this.bootId = opts.bootId ?? process.env[DAEMON_BOOT_ID_ENV] ?? crypto.randomBytes(16).toString("hex");
    this.pullOnly = opts.pullOnly === true;
    this.chainRepairPolicy = new DaemonChainRepairPolicy(cfg.deviceId);
    this.acquireSyncMutexFn = opts.acquireSyncMutex ?? ((workspaceRoot) => acquireWorkspaceSyncMutex(workspaceRoot, "daemon"));
    this.now = opts.now ?? Date.now;
    this.recoveryRandom = opts.recoveryRandom ?? Math.random;
    this.recoveryClock = opts.recoveryClock ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.cursorClock = opts.cursorClock ?? {
      setTimeout: (fn, ms) => {
        const handle = globalThis.setTimeout(fn, ms);
        handle.unref?.();
        return handle;
      },
      clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.scanCadenceClock = opts.scanCadenceClock ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
    this.cursorRandom = opts.cursorRandom ?? (() => Math.random());
    this.deferralHygieneBudgetMs = opts.deferralHygieneBudgetMs ?? 2_000;
    this.monotonicNow = opts.monotonicNow ?? (() => performance.now());
    const monotonicStart = this.monotonicNow();
    this.monotonicLastMs = Number.isFinite(monotonicStart) ? Math.max(0, monotonicStart) : 0;
    this.wsHealthWindowStartedMs = this.monotonicLastMs;
    this.wsDisabled = process.env.RBOX_DAEMON_WS_DISABLED === "1";
    this.wsReliabilityDisabled = process.env.RBOX_DAEMON_WS_RELIABILITY_DISABLED === "1";
    this.pongDeadlineMs = this.wsReliabilityDisabled
      ? 0
      : envInt("RBOX_DAEMON_WS_PONG_DEADLINE_MS", WS_PONG_DEADLINE_DEFAULT_MS, 0, Number.MAX_SAFE_INTEGER);
    this.cursorCheckMs = this.wsReliabilityDisabled
      ? 0
      : envInt("RBOX_DAEMON_WS_CURSOR_CHECK_MS", WS_CURSOR_CHECK_MS, 0, Number.MAX_SAFE_INTEGER);
    this.backstopMs = this.wsReliabilityDisabled
      ? 0
      : envInt("RBOX_DAEMON_POLL_BACKSTOP_MS", POLL_BACKSTOP_DEFAULT_MS, 0, Number.MAX_SAFE_INTEGER);
    const ports: DaemonSchedulerPorts = {
      root: this.root,
      now: () => this.now(),
      log: (line) => this.log(line),
      recoveryClock: this.recoveryClock,
      acquireMutex: (workspaceRoot) => this.acquireSyncMutexFn(workspaceRoot),
      releaseMutex: (handle) => releaseWorkspaceSyncMutex(handle),
      isStopped: () => this.stopped,
      readyForReentry: () => !this.stopped && this.resetLifecycle === "ready",
      standingHalt: () => {
        const halt = this.activity.halt;
        return halt ? { op: halt.op, witness: halt.nextProbeAt ?? halt.at } : undefined;
      },
      countLockStarvation: async () => {
        this.metrics.lockStarved += 1;
        await saveMetrics(this.root, this.metrics);
      },
      wake: () => void this.pump(),
    };
    this.scheduler = new DaemonOperationScheduler(ports);
  }

  // ---- scheduler-owned state, as the daemon's test-visible surface -----------
  // The scheduler is the sole owner; these forward reads and writes to it so the
  // daemon (and the suites that poke its internals) keep one vocabulary.

  private get want(): Wants { return this.scheduler.wants; }
  private get pumping(): boolean { return this.scheduler.pumping; }
  private set pumping(value: boolean) { this.scheduler.pumping = value; }
  private get pumpRun(): Promise<void> { return this.scheduler.pumpRun; }
  private get activePumpOp(): PumpOperation | undefined { return this.scheduler.activePumpOp; }
  private get recoveryDue(): boolean { return this.scheduler.recoveryDue; }
  private set recoveryDue(value: boolean) { this.scheduler.recoveryDue = value; }
  private get recoveryDequeuesSinceDue(): number { return this.scheduler.recoveryDequeuesSinceDue; }
  private set recoveryDequeuesSinceDue(value: number) { this.scheduler.recoveryDequeuesSinceDue = value; }
  private get recoveryTimer(): unknown { return this.scheduler.recoveryTimer; }

  /** The halt record the dequeued probe was armed against, handed from the operation's
   *  own prologue to its body (the record itself is never the scheduler's). */
  private probeHalt?: NonNullable<DaemonActivity["halt"]>;

  /** The daemon's side of the scheduler: what an operation boundary admits, what each
   *  dequeued operation DOES, and the exit-time persistence. Which operation runs, and
   *  whether it may run at all, is the scheduler's. */
  private readonly operationExecutor: DaemonOperationExecutor = {
    openOperationBoundary: (syncMutex) => this.openOperationBoundary(syncMutex),
    beginOperation: (op) => this.beginPumpOperation(op),
    runOperation: (op, syncMutex) => this.runPumpOperation(op, syncMutex),
    settleAfterDrain: () => this.settleAfterDrain(),
  };

  async start(): Promise<void> {
    // Be a background citizen: lose the CPU race to the developer's own tools.
    try {
      os.setPriority(0, 10);
    } catch {
      /* setpriority may be denied; not fatal */
    }
    // ...and the DISK race too (design 49): macOS throttle tier / linux BE-7.
    this.log(`io priority: ${lowerIoPriority()}`);

    // Record the binding FIRST. `rbox start` cleared the previous one before
    // spawning us, and every reader treats "no binding" as an unproven daemon —
    // so any work before this write is a window in which third parties cannot
    // attribute this root's daemon. Only the workspace id and boot id are
    // needed, and both are known here.
    if (!(await this.writeStartupBinding())) return;

    this.cache = await HashCache.load(this.root);
    this.metrics = await loadMetrics(this.root);
    const persistedActivity = await loadActivity(this.root);
    if (persistedActivity) {
      this.activity.halt = persistedActivity.halt;
      this.activity.suspendedPushHalt = persistedActivity.suspendedPushHalt;
      this.activity.lastPush = persistedActivity.lastPush;
      this.activity.lastPull = persistedActivity.lastPull;
      this.activity.local = persistedActivity.local;
      this.activity.outOfStorage = persistedActivity.outOfStorage;
    }
    this.scheduler.lockStarvationEpisode = await readLockStarvationEpisode(this.root);
    // Scope is truth: a forged RBOX_DAEMON_PULL_ONLY=0, a missing desired record, or
    // a corrupt one can never start a scoped binding read-write.
    if (!await this.refreshScopeAuthority()) return;
    this.log(`rbox daemon starting: ${this.root} → workspace ${this.cfg.remoteWorkspaceId} (device ${this.cfg.deviceId})${this.pullOnly ? " [pull-only]" : ""}`);
    this.writeAmbientStatus();
    await this.activityWrite;
    this.markWsStartupDisconnected();
    await this.activityWrite;
    if (this.stopped) return;
    this.startActivityHeartbeat();
    this.startAmbientStatusHeartbeat();
    this.startTelemetryTimers();
    // Pull fallback is account-scoped and intentionally starts outside/before
    // the workspace mutex. A slow sync startup cannot delay key release.
    this.keyDeliveryFlight?.enqueue();
    // The direct startup scan is an operation too. Acquire the same mutex and
    // execute the universal journal boundary before loadState or scan work.
    const startupMutex = await this.acquireSyncMutexFn(this.root);
    if (startupMutex.status === "acquired") {
      const run = (async () => {
        try {
          if (!this.stopped && await this.resetOperationBoundary(startupMutex.handle)) {
            await this.recoverOwnedLocksAtBoundary();
            if (this.stopped) return;
            const boundaryBootstrapped = this.syncBase !== undefined;
            const initialState = this.syncBase ?? await this.loadSyncBase(startupMutex.handle);
            if (!this.stopped && (boundaryBootstrapped || await this.bootstrapAgreement(initialState))) {
              if (!boundaryBootstrapped) this.seedFromState(initialState);
              await this.adoptionCacheGenerationBoundary();
              if (this.stopped) return;
              await this.localObserver.observe({ kind: "scan", cache: this.cache, previous: initialState.lastSyncedManifest, mode: this.watcherScanMode() });
              if (this.stopped) return;
              this.pruneCache();
              await this.cache.save(this.root);
              this.scheduler.queue("pull");
              if (!this.pullOnly) this.requestPush("other");
            }
          }
        } finally {
          await releaseWorkspaceSyncMutex(startupMutex.handle);
        }
      })();
      this.startupBoundaryRun = run;
      try {
        await run;
      } finally {
        if (this.startupBoundaryRun === run) this.startupBoundaryRun = undefined;
      }
    } else {
      // Startup contention is not a recovery halt. Queue the startup scan; its
      // eventual pump iteration will pass through the same boundary.
      this.scheduler.queue("pull");
      this.scheduler.queue("fullScan");
    }

    if (this.stopped) return;
    this.armStandingRecovery();
    if (this.pullOnly) {
      this.scheduleSafetyScan();
      this.scheduleDeepScan();
    }
    else await this.startLiveWatch();
    if (this.stopped) return;
    this.maybeConnect();
    this.startBackstop();
    this.startUpdateChecks();

    if (this.resetLifecycle === "ready") {
      await this.pump();
      this.log(this.watcher ? "rbox daemon ready" : "rbox daemon ready (periodic-scan mode; no live watch)");
    } else {
      this.log("rbox daemon live but sync halted pending reset-journal recovery");
    }
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
    this.scheduleDeepScan();
    const signalDebouncer = createSignalDebouncer((batch) => this.handleGitSignalBatch(batch), 400, 3000);
    this.gitSignalDebouncer = signalDebouncer;
    let initialGitRepos: readonly DiscoveredGitRepo[] = [];
    try {
      const watcher = await this.startWatcherFn(
        this.root,
        this.currentMatcherFacade(),
        (events) => {
          if (this.resetLifecycle !== "ready") return;
          this.noteChurn();
          this.pendingEvents.push(...events);
          this.request("push");
        },
        {
          onRawEvent: (event) => {
            if (this.resetLifecycle !== "ready") return;
            this.noteChurn();
            this.markLocalUnsettledFromWatchEvent();
            for (const audit of this.openDriftAudits) {
              if (audit.rawEvents.length < AUDIT_EVENT_CAP) audit.rawEvents.push(event);
              else audit.overflow = true;
            }
          },
          signalDebouncer,
          onInitialGitRepos: async (repos) => { initialGitRepos = repos; },
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
      if (this.stopped) {
        await Promise.resolve().then(() => watcher.close()).catch(() => {});
        signalDebouncer.dispose();
        if (this.gitSignalDebouncer === signalDebouncer) this.gitSignalDebouncer = undefined;
        return;
      }
      this.watcher = watcher;
      // The subscription's native prune set is fixed from here until close; §3b
      // compares later rebuilds against THIS value, not the current rule files.
      this.watcherNativePruneKey = nativePruneGlobs(this.root).join("\n");
      if (gitRefSideChannelEligible(process.platform, this.watcher.backend)) {
        await this.gitDiscovery.attachRefBackend({
          root: this.root,
          initial: initialGitRepos,
          onSignal: () => signalDebouncer.push("signal"),
          onArmed: () => signalDebouncer.push("other"),
          onLog: this.log,
        });
      } else this.gitDiscovery.noteRefBackendUnavailable();
      this.watcherSessionId = crypto.randomBytes(16).toString("hex");
    } catch (e) {
      await this.gitDiscovery.abandonRefBackend();
      signalDebouncer.dispose();
      this.gitSignalDebouncer = undefined;
      this.log(`live watch unavailable: ${e instanceof Error ? e.message : String(e)} — degrading to periodic scan every ${Math.round(SAFETY_SYNC_MS / 1000)}s`);
      this.watcherDegraded = true;
      this.writeAmbientStatus();
    }
  }

  private async handleGitSignalBatch(batch: GitSignalBatch): Promise<void> {
    if (this.resetLifecycle !== "ready" || this.stopped) return;
    await this.gitDiscovery.observe({ kind: "signal", discoverAll: batch.discoverAll, candidates: batch.candidates });
    this.noteChurn();
    if (batch.reasons.signal) this.requestPush("signal");
    if (batch.reasons.candidate) this.requestPush("candidate");
    if (batch.reasons.other) this.requestPush("other");
    this.writeAmbientStatus();
    void this.pump();
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
      if (this.safetyTimer !== undefined) this.scanCadenceClock.clearTimeout(this.safetyTimer);
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
    this.safetyTimer = this.scanCadenceClock.setTimeout(() => {
      this.safetyTimer = undefined;
      return this.runSafetyCadenceTick();
    }, jitter(this.safetyDelay));
  }

  private scheduleDeepScan(): void {
    this.deepTimer = this.scanCadenceClock.setInterval(() => this.request("deepScan"), jitter(DEEP_SCAN_MS));
  }

  private async runSafetyCadenceTick(): Promise<void> {
    if (this.stopped) return;
    try {
      this.advanceSafetyCadenceForTick();
      this.churnSinceSafety = false;
      if (this.pullOnly) await this.runDeferralHygiene();
      else this.request("fullScan");
    } finally {
      if (!this.stopped) this.scheduleSafetyScan();
    }
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
      watcherLive: this.watcherLive(),
      churned: this.churnSinceSafety,
      degradedBackoffEligible,
      pinToFloor: this.gitDiscovery.floorRequired,
    });
  }

  /** Workspace-mutex-owned startup boundary for state-CAS journals. The same
   * method runs on the first eventual pump acquisition when startup contended. */
  private async recoverOwnedLocksAtBoundary(): Promise<void> {
    if (this.startupLockRecoveryDone) return;
    const recovery = await this.recoverStateCasWithGate();
    if (recovery.recovered > 0) {
      this.log(`recovered ${recovery.recovered} crash-owned Git lock${recovery.recovered === 1 ? "" : "s"}`);
      this.scheduler.queue("pull");
      if (!this.pullOnly) this.requestPush("other");
    }
    if (recovery.indeterminate > 0) this.log(`Git lock recovery retained ${recovery.indeterminate} indeterminate journal episode${recovery.indeterminate === 1 ? "" : "s"}`);
    this.startupLockRecoveryDone = true;
  }

  private async recoverStateCasWithGate(commonDir?: string): Promise<Awaited<ReturnType<typeof recoverStateCasLocks>>> {
    const lease = this.mutationGate.enter({ phase: "state-cas", ...(commonDir ? { repository: commonDir } : {}) });
    try {
      if (!lease.beginCommit()) throw new MutationGateClosedError();
      return await recoverStateCasLocks(this.root, commonDir ? { commonDir } : {});
    } finally {
      lease.finish();
    }
  }

  hasCommittedMutation(): boolean {
    return this.mutationGate.snapshot().some((mutation) => mutation.committed);
  }

  waitForCommittedMutationDrain(): Promise<void> {
    return this.mutationGate.drainCommitted();
  }

  stop(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const firstStop = !this.stopped;
    this.stopped = true;
    this.mutationGate.close();
    this.invalidateCursorSchedule();
    this.scheduler.abortMutexBackoff();
    this.writeAmbientStatus();
    this.shutdownPromise = this.finishStop(firstStop);
    return this.shutdownPromise;
  }

  private async finishStop(firstStop: boolean): Promise<void> {
    const keyDeliveryDrain = this.keyDeliveryFlight?.stop();
    if (this.safetyTimer !== undefined) this.scanCadenceClock.clearTimeout(this.safetyTimer);
    if (this.deepTimer) this.scanCadenceClock.clearInterval(this.deepTimer);
    if (this.resetRetryTimer) clearTimeout(this.resetRetryTimer);
    for (const audit of this.openDriftAudits) if (audit.timer) clearTimeout(audit.timer);
    this.openDriftAudits.clear();
    if (this.updateCheckTimer) clearInterval(this.updateCheckTimer);
    if (this.telemetryFlushTimer) clearInterval(this.telemetryFlushTimer);
    if (this.capabilityInitialTimer) clearTimeout(this.capabilityInitialTimer);
    if (this.capabilityTimer) clearInterval(this.capabilityTimer);
    if (this.syncStateHeartbeatTimer) clearInterval(this.syncStateHeartbeatTimer);
    this.stopActivityHeartbeat();
    this.stopAmbientStatusHeartbeat();
    this.retryQueue.stop();
    this.clearGitBusyEpisode();
    this.stopWsKeepalive();
    this.clearBackstop();
    // DRAIN the in-flight pump before declaring stopped: SIGTERM shutdown awaits
    // stop(), so this is what makes termination actually graceful — the current
    // op (an applyGitState, a write, an upload) COMPLETES; only queued work is
    // skipped (the loop re-checks `stopped`). Without this, `rbox start`'s stale-
    // daemon restart could interrupt a mutation mid-flight.
    // `rbox stop` extends its wait only for a fresh, same-boot critical-phase
    // witness. Keep that witness live while the ordinary heartbeat is stopped
    // and the closed mutation gate drains.
    const shutdownHeartbeat = setInterval(() => this.writeAmbientStatus(), AMBIENT_STATUS_HEARTBEAT_MS);
    shutdownHeartbeat.unref?.();
    try {
      await Promise.allSettled([
        this.startupBoundaryRun,
        // Disarms the recovery probe and any parked mutex backoff, then drains the
        // in-flight loop: the committed operation completes, queued work is skipped.
        this.scheduler.stop(),
        this.mutationGate.drain(),
        keyDeliveryDrain,
      ]);
    } finally {
      clearInterval(shutdownHeartbeat);
    }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.gitSignalDebouncer?.dispose();
    await Promise.allSettled([
      Promise.resolve().then(() => this.watcher?.close()),
      Promise.resolve().then(() => this.gitDiscovery.close()),
      Promise.resolve().then(() => this.telemetry.flush(AbortSignal.timeout(1500))),
      Promise.resolve().then(() => this.activityWrite),
      Promise.resolve().then(() => this.cache?.save(this.root)),
    ]);
    await this.writePausedAmbientStatus().catch(() => {});
    if (firstStop) {
      this.log("rbox daemon stopped");
      this.onStopped?.();
    }
  }

  // ---- single-flight pump --------------------------------------------------

  private requestPush(reason: "signal" | "candidate" | "scan" | "other" = "other"): void {
    if (!this.pullOnly) {
      this.pendingPushReasons[reason] = true;
      this.scheduler.request("push");
    }
  }

  private takePushProvenance(): PushProvenance {
    const snapshot = { ...this.pendingPushReasons };
    this.pendingPushReasons = { signal: false, candidate: false, scan: false, other: false };
    if (!snapshot.signal && !snapshot.candidate && !snapshot.scan && !snapshot.other) snapshot.other = true;
    return snapshot;
  }

  private recordGitCaptureSuccess(provenance: PushProvenance): void {
    const sample = gitCaptureSampleForProvenance(provenance);
    if (sample) this.telemetry.record(sample);
  }

  private noteGitBusyDeferred(): void {
    if (this.stopped || this.gitBusyEpisode) return;
    const episode = { timers: [] as unknown[], queuedStages: [] as number[] };
    this.gitBusyEpisode = episode;
    const schedule = (stage: number, delayMs: number) => {
      const timer = this.gitBusyRetryClock.setTimeout(() => {
        if (this.stopped || this.gitBusyEpisode !== episode) return;
        episode.queuedStages.push(stage);
        this.requestPush("other");
        this.writeAmbientStatus();
        void this.pump();
      }, delayMs);
      (timer as { unref?: () => void }).unref?.();
      episode.timers.push(timer);
    };
    GIT_BUSY_RETRY_DELAYS_MS.forEach((delayMs, index) => schedule(index + 1, delayMs));
  }

  private takeGitBusyRetryStage(): number {
    const stage = this.gitBusyEpisode?.queuedStages.shift() ?? 0;
    if (this.gitBusyEpisode && this.gitBusyEpisode.queuedStages.length > 0) {
      this.requestPush("other");
    }
    return stage;
  }

  private finishGitBusyRetry(stage: number): void {
    if (stage === GIT_BUSY_RETRY_DELAYS_MS.length) this.clearGitBusyEpisode();
  }

  private clearGitBusyEpisode(): void {
    if (!this.gitBusyEpisode) return;
    for (const timer of this.gitBusyEpisode.timers) this.gitBusyRetryClock.clearTimeout(timer);
    this.gitBusyEpisode = undefined;
  }

  private request(kind: keyof Wants): void {
    if (kind === "push") this.requestPush("other");
    else {
      if (this.pullOnly && kind !== "pull" && kind !== "deepScan") return;
      this.scheduler.request(kind);
    }
    this.writeAmbientStatus();
    if (this.resetLifecycle !== "ready" && this.now() < this.nextResetRetryAt) return;
    void this.pump();
  }

  private async loadSyncBase(heldMutex?: WorkspaceSyncMutex): Promise<SyncState> {
    const state = await loadState(this.root, syncStreamId(this.cfg), this.log, heldMutex);
    this.syncBase = state;
    // Design 206 §1: push completion, post-pull reload, failure recovery and boot all
    // land here, so a base whose `gitRepos` key set moved re-baselines P7 provenance
    // instead of latching the pull path onto scans until restart (#464).
    this.ensureMatcherProvenance(state);
    return state;
  }

  private seedFromState(state: SyncState): void {
    this.syncBase = state;
    this.lastLoggedSeq = state.lastSyncedSequence;
    this.rebuildMatcher(state);
    // The seed is last-synced BASE, not disk truth: nothing has been observed yet,
    // so provenance is cleared and P5 goes false until a full-workspace scan
    // installs (design 202).
    this.local.seed(state.lastSyncedManifest);
  }

  private scheduleResetRetry(): void {
    if (this.stopped || this.resetRetryTimer) return;
    const delay = Math.max(0, this.nextResetRetryAt - this.now());
    this.resetRetryTimer = setTimeout(() => {
      this.resetRetryTimer = undefined;
      if (this.stopped) return;
      this.nextResetRetryAt = this.now();
      this.scheduler.queue("fullScan");
      void this.pump();
    }, delay);
    this.resetRetryTimer.unref?.();
  }

  private async enterResetHalt(reason: string, journalIdentity?: string): Promise<void> {
    const identity = journalIdentity ?? this.resetHaltIdentity ?? "0".repeat(64);
    const changed = this.resetLifecycle !== "halted" || this.resetHaltIdentity !== identity || this.resetHaltReason !== reason;
    this.resetLifecycle = "halted";
    this.invalidateCursorSchedule();
    this.resetHaltIdentity = identity;
    this.resetHaltReason = reason;
    this.nextResetRetryAt = this.now() + RESET_RECOVERY_RETRY_MS;
    if (changed) {
      await writeResetHaltHealth(this.root, {
        reason,
        journalIdentity: identity,
        haltedAt: new Date(this.now()).toISOString(),
      });
    }
    if (this.resetHaltLogGate.shouldLog(reason, this.now())) this.log(`sync halted: reset journal cannot be processed (${reason})`);
    this.scheduleResetRetry();
  }

  private async bootstrapAgreement(state: SyncState): Promise<boolean> {
    const bootStream = syncStreamId(this.cfg);
    const fresh = await loadConfig(this.root);
    const freshStream = syncStreamId(fresh);
    const nonce = expectedStateNonce(state);
    const activeAgrees = state.stream === bootStream && await daemonBindingMatches(this.root, state.stream, nonce);
    if (freshStream !== bootStream || !activeAgrees) {
      await this.enterResetHalt("daemon boot binding, durable config, and recovered active state do not agree", this.resetHaltIdentity);
      return false;
    }
    return true;
  }

  /** Called only while the workspace sync mutex is held. Returns true exactly
   * when scan/pull/push work may proceed. */
  private async resetOperationBoundary(heldMutex?: WorkspaceSyncMutex): Promise<boolean> {
    const inspection = await inspectResetJournalSafety(this.root, syncStreamId(this.cfg));
    const persisted = await readResetHaltHealth(this.root);
    if (inspection.status === "halt") {
      await this.enterResetHalt(inspection.reason, inspection.journalIdentityHash);
      return false;
    }
    if (inspection.status === "recoverable") this.resetLifecycle = "recovering";
    if (inspection.status === "recoverable" || this.resetLifecycle !== "ready" || persisted) {
      this.resetLifecycle = "recovering";
      let state: SyncState;
      try {
        // loadState owns the classifier-gated forward-recovery implementation.
        state = await this.loadSyncBase(heldMutex);
      } catch (error) {
        await this.enterResetHalt(error instanceof Error ? error.message : String(error), inspection.status === "recoverable" ? inspection.journalIdentityHash : undefined);
        return false;
      }
      const after = await inspectResetJournalSafety(this.root, syncStreamId(this.cfg));
      if (after.status !== "none") {
        if (after.status === "halt") await this.enterResetHalt(after.reason, after.journalIdentityHash);
        else await this.enterResetHalt("reset journal recovery did not reach a terminal state", after.journalIdentityHash);
        return false;
      }
      if (!await this.bootstrapAgreement(state)) return false;
      this.resetLifecycle = "bootstrapping";
      this.seedFromState(state);
      this.resetLifecycle = "ready";
      if (this.ws?.readyState === WebSocket.OPEN) this.resetCursorSchedule(this.ws);
      this.resetHaltIdentity = undefined;
      this.resetHaltReason = undefined;
      this.nextResetRetryAt = Number.NEGATIVE_INFINITY;
      if (this.resetRetryTimer) clearTimeout(this.resetRetryTimer);
      this.resetRetryTimer = undefined;
      await clearResetHaltHealth(this.root);
      this.log("reset journal healed; background sync bootstrapped");
    }
    return true;
  }

  private startUpdateChecks(): void {
    void runUpdateCheckIfDue(this.cfg.remoteUrl);
    this.updateCheckTimer = setInterval(() => void runUpdateCheckIfDue(this.cfg.remoteUrl), UPDATE_CHECK_TICK_MS);
  }

  private async pump(): Promise<void> {
    return this.scheduler.service(this.operationExecutor);
  }

  private nextPumpOperation(): PumpOperation | undefined {
    return this.scheduler.nextOperation();
  }

  private armStandingRecovery(): void {
    if (!this.pullOnly && this.activity.suspendedPushHalt && this.activity.halt?.op !== "push") {
      this.activity.halt = this.activity.suspendedPushHalt;
      this.activity.suspendedPushHalt = undefined;
      this.writeActivity();
    }
    const halt = this.activity.halt;
    if (!halt) return;
    if (this.pullOnly && halt.op === "push") {
      this.scheduler.clearRecoveryEpisode();
      this.activity.suspendedPushHalt ??= { ...halt, recoveryState: "suspended" };
      this.activity.halt = undefined;
      this.writeActivity();
      return;
    }
    halt.recoveryState = "armed";
    const dueAt = Date.parse(halt.nextProbeAt ?? halt.lastFailureAt ?? halt.at);
    const delayMs = Number.isFinite(dueAt) ? Math.max(0, dueAt - this.now()) : 0;
    this.scheduler.armRecoveryProbe(delayMs, halt.nextProbeAt ?? halt.at);
  }

  private recordRecoveryFailure(
    op: keyof Wants,
    error: unknown,
    typedReason?: NonNullable<DaemonActivity["halt"]>["typedReason"],
    terminal?: { fingerprint: string },
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    const now = this.now();
    const prior = this.activity.halt;
    const same = prior?.op === op && (prior.typedReason && typedReason
      ? prior.typedReason.kind === typedReason.kind
      : !prior.typedReason && !typedReason && prior.reason === reason);
    const firstFailureAt = same ? prior.firstFailureAt ?? prior.at : new Date(now).toISOString();
    const consecutiveFailures = same ? (prior.consecutiveFailures ?? prior.count) + 1 : 1;
    const lastFailureAt = new Date(now).toISOString();
    const nextProbeAt = new Date(now + recoveryProbeDelayMs(consecutiveFailures, this.recoveryRandom)).toISOString();
    this.activity.halt = {
      at: firstFailureAt,
      reason,
      count: consecutiveFailures,
      op,
      firstFailureAt,
      lastFailureAt,
      consecutiveFailures,
      nextProbeAt,
      recoveryState: this.pullOnly && op === "push" ? "suspended" : "armed",
      ...(prior?.lastProbeAt ? { lastProbeAt: prior.lastProbeAt } : {}),
      ...(typedReason ? { typedReason } : {}),
      ...(terminal ? { terminal } : {}),
    };
    if (!(this.pullOnly && op === "push")) this.scheduler.queue(op);
    this.scheduler.disarmRecoveryDue();
    this.armStandingRecovery();
    this.writeActivity();
  }

  private classifyOperationFailure(error: unknown): ClassifiedOperationFailure {
    const actual = error instanceof RecoveryProbePreflightError ? error.cause : error;
    if (actual instanceof QuotaExceededError) return { kind: "quota", error: actual };
    if (actual instanceof CommitRejectedError) {
      const typedReason: NonNullable<DaemonActivity["halt"]>["typedReason"] = actual.reason === "too_many_refs"
        ? { kind: "too-many-refs" }
        : actual.reason === "body_too_large"
          ? { kind: "body-too-large" }
          : undefined;
      return {
        kind: "halt",
        error: actual,
        typedReason,
        ...(actual.fingerprint ? { terminal: { fingerprint: actual.fingerprint } } : {}),
        blocked: true,
      };
    }
    if (actual instanceof RecoveryConditionPersistsError) {
      return {
        kind: "halt",
        error: actual,
        typedReason: actual.halt.typedReason,
        terminal: actual.halt.terminal,
        blocked: false,
      };
    }
    return {
      kind: "halt",
      error: actual,
      typedReason: actual instanceof PushConflictExhaustedError
        ? { kind: "push-conflict" }
        : actual instanceof MassDeleteGuardError
          ? { kind: "mass-delete", op: actual.op }
          : actual instanceof ChainRepairHaltError
            ? { kind: "chain-repair" }
            : undefined,
      blocked: false,
    };
  }

  private recordClassifiedFailure(
    op: keyof Wants,
    failure: ClassifiedOperationFailure,
  ): { kind: "quota"; visibleChanged: boolean } | { kind: "halt"; blocked: boolean } {
    if (failure.kind === "quota") {
      return { kind: "quota", visibleChanged: this.recordOutOfStorage(failure.error, op) };
    }
    this.activity.active = undefined;
    this.activeProgressPath = undefined;
    const failureOp = failure.typedReason?.kind === "mass-delete" ? failure.typedReason.op : op;
    this.recordRecoveryFailure(
      failureOp,
      failure.error,
      failure.typedReason,
      failure.terminal,
    );
    return { kind: "halt", blocked: failure.blocked };
  }

  private clearRecoveryHalt(): void {
    this.scheduler.clearRecoveryEpisode();
    this.activity.halt = undefined;
    this.lastErrMsg = "";
    this.errRepeat = 0;
    this.writeActivity();
  }

  private async hasPublishableLocalDivergence(): Promise<"none" | "some" | "indeterminate"> {
    const base = this.syncBase;
    if (!base) return "some";
    const diff = diffManifests(base.lastSyncedManifest, this.local.manifest);
    if (diff.added.length || diff.changed.length || diff.deleted.some((item) => !this.matcher.ignores(item))) return "some";
    const git = await gitDivergenceStatus(this.root, this.cfg, base, this.matcher);
    return git.count > 0 ? "some" : git.indeterminate ? "indeterminate" : "none";
  }

  /** The op bodies the pump and the recovery probe run IDENTICALLY: pull (notify-latency
   *  bookkeeping + catch-up-generation protocol + publishable-divergence re-push) and the
   *  fullScan/deepScan bodies (scan → deferral hygiene → watcher-degraded clear →
   *  out-of-storage arming for fullScan → requestPush). Push is deliberately NOT here — the
   *  pump's push branch carries two pump-only concerns the recovery push lacks (the
   *  quota-probe/applyPendingWatchEvents suppression, and the `pushedToRemote` signal the
   *  pump's out-of-storage settle consumes afterward), so each caller keeps its own push
   *  dispatch rather than forcing an asymmetric branch through here.
   *
   *  `recovery` records which caller this is (design note 2026-07-24 D4): recovery ops run
   *  outside the watcher-unsettled generation bracketing, so `maybeClearWatcherUnsettledAfterOp`
   *  stays with the pump's guarded call and is never invoked for a recovery op. */
  private async executeOp(
    op: "pull" | "fullScan" | "deepScan",
    syncMutex: WorkspaceSyncMutex,
    opts: { recovery: boolean; opWatcherErrorGeneration: number; carrier: Carrier },
  ): Promise<void> {
    if (op === "pull") {
      const notifyPendingAt = this.notifyPullPendingAt;
      const notifyLatencyMs = notifyPendingAt !== undefined
        ? Math.min(TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.notifyLatencyMaxMs.max, Math.max(0, Math.floor(this.now() - notifyPendingAt)))
        : undefined;
      this.notifyPullPendingAt = undefined;
      // §6: the standalone metric event fires at dequeue — measured latency is recorded
      // even if the pull below fails (the pull-line token then simply never prints).
      if (notifyLatencyMs !== undefined) {
        this.observeNotifyLatency(notifyLatencyMs);
        this.log(`notify_latency_ms=${notifyLatencyMs}`);
      }
      const catchUpGeneration = this.pendingCatchUpGeneration;
      this.pendingCatchUpGeneration = undefined;
      try {
        await this.doPull(syncMutex, notifyLatencyMs, notifyPendingAt, opts.carrier);
      } catch (e) {
        // A failed catch-up pull must not orphan its generation: restore it so the eventual
        // healing pull (backstop / next frame) can still mark the socket caught up.
        // markWsCaughtUp discards stale generations, so restoring a superseded one is harmless.
        if (catchUpGeneration !== undefined) this.pendingCatchUpGeneration ??= catchUpGeneration;
        throw e;
      }
      if (catchUpGeneration !== undefined) this.markWsCaughtUp(catchUpGeneration);
      if (await this.hasPublishableLocalDivergence() !== "none") this.requestPush("other");
      return;
    }
    const cov = op === "fullScan" ? await this.doFullScan() : await this.doDeepScan();
    await this.runDeferralHygiene();
    this.maybeClearWatcherDegradedAfterScan(opts.opWatcherErrorGeneration, cov);
    if (op === "fullScan" && this.activity.outOfStorage) this.outOfStorageProbeArmed = true;
    this.requestPush("scan");
  }

  private async runRecoveryProbe(
    syncMutex: WorkspaceSyncMutex,
    halt: NonNullable<DaemonActivity["halt"]>,
    opWatcherErrorGeneration: number,
  ): Promise<void> {
    if (halt.typedReason?.kind === "push-conflict" || (halt.op === "push" && !halt.typedReason && !halt.terminal)) {
      let publishable: "none" | "some" | "indeterminate";
      try {
        await this.doPull(syncMutex, undefined, undefined, "none");
        publishable = await this.hasPublishableLocalDivergence();
      } catch (error) {
        throw new RecoveryProbePreflightError(error);
      }
      if (publishable === "none") {
        this.clearRecoveryHalt();
        return;
      }
      await this.doPush(syncMutex, this.takePushProvenance());
      if (this.pushTerminalBlocked) throw new RecoveryConditionPersistsError(this.activity.halt ?? halt);
      this.clearRecoveryHalt();
      return;
    }
    if (halt.op === "pull") {
      await this.executeOp("pull", syncMutex, { recovery: true, opWatcherErrorGeneration, carrier: this.takeQueuedCarrier() });
    } else if (halt.op === "push") await this.doPush(syncMutex, this.takePushProvenance());
    else await this.executeOp(halt.op, syncMutex, { recovery: true, opWatcherErrorGeneration, carrier: "none" });
    if (this.pushTerminalBlocked) throw new RecoveryConditionPersistsError(this.activity.halt ?? halt);
    this.clearRecoveryHalt();
  }

  /** Reset authority, crash-lock recovery, and binding revalidation — the prologue
   *  every operation passes through with the workspace mutex held. `false` ends the
   *  loop WITHOUT consuming the selected operation. */
  private async openOperationBoundary(syncMutex: WorkspaceSyncMutex): Promise<boolean> {
    if (!await this.refreshScopeAuthority()) return false;
    if (!await this.resetOperationBoundary(syncMutex)) return false;
    if (this.stopped) return false;
    if (!await this.folderOperationBoundary()) return false;
    await this.recoverOwnedLocksAtBoundary();
    if (this.stopped) return false;
    await this.adoptionCacheGenerationBoundary();
    if (!await this.acknowledgeFolderPolicyRecycle()) return false;
    const binding = this.syncBase ?? await this.loadSyncBase();
    const bindingMatches = await daemonBindingMatches(this.root, syncStreamId(this.cfg), expectedStateNonce(binding));
    if (!bindingMatches) {
      this.log("daemon binding changed while idle (stream/state nonce mismatch) — stopping before mutation");
      this.stopped = true;
      return false;
    }
    this.pushTerminalBlocked = false;
    return true;
  }

  /**
   * Re-derive the binding's scope authority. Returns false (and stops the daemon)
   * when the binding is halted — a scope witness that has gone missing or
   * disagrees must never be read as "legacy unscoped", because that would put a
   * partial tree back on the publishing path.
   */
  private async refreshScopeAuthority(): Promise<boolean> {
    const seal = await resolveBindingScope(this.root).catch((error): BindingScope =>
      ({ kind: "halted", condition: "binding-record-unreadable", message: error instanceof Error ? error.message : String(error) }));
    this.scoped = seal.kind === "scoped";
    if (seal.kind === "halted") {
      this.log(`rbox daemon halting (${seal.condition}): ${seal.message}`);
      this.stopped = true;
      return false;
    }
    if (seal.kind === "scoped" && !this.pullOnly) {
      this.pullOnly = true;
      this.log(`rbox daemon is receive-only: this folder syncs only ${seal.prefixes.join(", ")}`);
    }
    const generation = seal.kind === "scoped" ? seal.generation : 0;
    if (this.scopeGeneration === undefined) {
      this.scopeGeneration = generation;
    } else if (this.scopeGeneration !== generation) {
      // The folders this machine syncs changed under us. Every watcher-fed
      // observation and cached view this process holds was built for the old set,
      // so the only safe move is to stop: the scope edit restarts us with fresh
      // authority and a full rescan.
      this.log("the folders this machine syncs changed - restarting background sync");
      this.stopped = true;
      return false;
    }
    return true;
  }

  /** The dequeued operation's own bookkeeping, run before the scheduler publishes the
   *  active operation — the probe's halt record must render against an idle surface. */
  private beginPumpOperation(op: PumpOperation): void {
    if (op !== "recoveryProbe") return;
    const recoveryHalt = this.activity.halt!;
    this.probeHalt = recoveryHalt;
    this.activity.halt = {
      ...recoveryHalt,
      lastProbeAt: new Date(this.now()).toISOString(),
      recoveryState: "running",
    };
    this.writeActivity();
  }

  private async runPumpOperation(op: PumpOperation, syncMutex: WorkspaceSyncMutex): Promise<void> {
    const opWatcherGeneration = this.watcherUnsettledGeneration;
    const opWatcherErrorGeneration = this.watcherErrorGeneration;
    const recoveryHalt = this.probeHalt;
    this.probeHalt = undefined;
    try {
      let pushedToRemote = false;
      const pushProvenance = op === "push" ? this.takePushProvenance() : undefined;
      const gitBusyRetryStage = op === "push" ? this.takeGitBusyRetryStage() : 0;
      const activeCarrier = op === "pull" ? this.takeQueuedCarrier() : "none";
      this.writeAmbientStatus();
      this.appliedPendingEventsInOp = false;
      try {
        if (op === "recoveryProbe") {
          await this.runRecoveryProbe(syncMutex, recoveryHalt!, opWatcherErrorGeneration);
        } else if (op === "push") {
          const quotaProbe = this.activity.outOfStorage !== undefined && this.outOfStorageProbeArmed;
          this.outOfStorageProbeArmed = false;
          if (this.activity.outOfStorage && !quotaProbe) {
            await this.applyPendingWatchEvents();
          } else {
            await this.doPush(syncMutex, pushProvenance!);
            pushedToRemote = true;
          }
        } else {
          await this.executeOp(op, syncMutex, { recovery: false, opWatcherErrorGeneration, carrier: activeCarrier });
        }
        // D4 (design note 2026-07-24): the exclusion is deliberate — a recovery op runs
        // outside the watcher-unsettled generation bracketing this guard's generation
        // argument assumes, so it must never clear the unsettled surface here.
        if (op !== "recoveryProbe") this.maybeClearWatcherUnsettledAfterOp(op, opWatcherGeneration);
        if (this.syncBase) this.syncStateReporter.afterSyncTick(this.syncBase);
      } finally {
        if (op === "push") this.finishGitBusyRetry(gitBusyRetryStage);
        this.scheduler.markOperationIdle();
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
      const clearsOutOfStorage = pushedToRemote && this.activity.outOfStorage !== undefined;
      const cleared = this.activity.active !== undefined || clearsOutOfStorage || terminalBlocked;
      this.activity.active = undefined;
      this.activeProgressPath = undefined;
      if (clearsOutOfStorage) {
        this.activity.outOfStorage = undefined;
      }
      if (clearsOutOfStorage) {
        // The healed failure's dedup streak ends with it: a LATER failure with the
        // same message is a new episode that must log and persist a fresh visible
        // state, not silently count as repeat 2..9 and leave activity.json healed.
        this.lastErrMsg = "";
        this.errRepeat = 0;
      }
      if (cleared || this.activityDirty || Date.now() - this.lastActivityWrite > 30_000) this.writeActivity();
    } catch (e) {
      if (e instanceof MutationGateClosedError && this.stopped) {
        // Cooperative shutdown cancellation is not an operation failure:
        // no durable halt, retry counter, or misleading error surface.
        return;
      }
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
      if (op === "recoveryProbe") {
        const standing = this.activity.halt;
        if (standing) {
          const failure = this.classifyOperationFailure(e);
          if ((standing.typedReason?.kind === "push-conflict"
            || (standing.op === "push" && !standing.typedReason && !standing.terminal))
            && e instanceof RecoveryProbePreflightError
            && failure.kind === "halt"
            && !failure.typedReason
            && !failure.terminal) {
            const nextProbeAt = new Date(this.now() + recoveryProbeDelayMs(
              standing.consecutiveFailures ?? standing.count,
              this.recoveryRandom,
            )).toISOString();
            this.activity.halt = { ...standing, nextProbeAt, recoveryState: "armed" };
            this.scheduler.queue(standing.op);
            this.scheduler.disarmRecoveryDue();
            this.armStandingRecovery();
            this.writeActivity();
          } else {
            const recorded = this.recordClassifiedFailure(standing.op, failure);
            if (recorded.kind === "quota" && standing.op === "push") {
              // A recovery probe discovered a new quota condition. Retire the
              // conflict episode so it cannot remain permanently "running".
              this.clearRecoveryHalt();
            }
          }
        }
        if (shouldLogRepeat) this.log(`recovery probe failed: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
        return;
      }
      const failure = this.classifyOperationFailure(e);
      const recorded = this.recordClassifiedFailure(op, failure);
      if (recorded.kind === "quota") {
        if (shouldLogRepeat) this.log(`pump op quota: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
        if (recorded.visibleChanged || shouldLogRepeat) this.writeActivity();
        await sleep(jitter(1000));
        return;
      }
      if (recorded.blocked) {
        if (shouldLogRepeat) {
          this.log(`pump op blocked: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
          this.writeActivity();
        }
        return;
      }
      // The halt record is the failure's user-visible surface (design 45): without
      // it a mass-delete-guard refusal (design 44) stalls background sync with no
      // indicator anywhere but this log. Persisted on the log-line schedule.
      if (shouldLogRepeat) {
        this.log(`pump op error: ${msg}${this.errRepeat > 1 ? ` (x${this.errRepeat})` : ""}`);
        this.writeActivity();
      }
    }
  }

  private async settleAfterDrain(): Promise<void> {
    await this.cache.save(this.root);
    this.writeAmbientStatus();
    // Settle the sidecar: all wants are drained here, so re-render if
    // the state CHANGED from the last write — the mid-pump write said `pending`
    // (push still queued) and the no-op push wrote nothing; an idle workspace must
    // read `ok`. State-compared, so a truly unchanged pump writes nothing extra.
    const settledNow = this.localSettled();
    if (shellLineStateOf(this.activity, settledNow, Date.now()) !== this.lastShellState) this.writeActivity();
  }

  /** The publish composition root: prologue, the report lifecycle the push deps bag
   *  owns, and one sealed transition. Everything the outcome is allowed to change
   *  lives in {@link PublishLocalWorkspaceTransition}. */
  private async doPush(syncMutex: WorkspaceSyncMutex, provenance: PushProvenance): Promise<void> {
    this.typeFlipsSincePull = 0; // per-op tally — a failed prior op's flips must not inflate this one's count
    await this.applyPendingWatchEvents();
    const metricsReport = beginReport("push");
    const report = metricsReport ?? (telemetryEnabled() ? PhaseReport.push() : undefined);
    await this.publishTransition.publish(provenance, {
      execute: (request) => classifyPublishOutcome(request, () => pushManifest(this.root, this.cfg, request.manifest, {
        ...this.e2ee,
        cache: this.cache,
        syncMutex,
        blockedFingerprint: request.blockedFingerprint,
        onCommitConflict: () => this.bumpConflict("commit"),
        report,
        onGitLog: this.log, // design 43 §10: capture/carry/defer/remove forensics in the daemon log
        onGitDeferralsSaved: (state) => this.observeDurableGitState(state),
        onGitReposDiscovered: async (repos) => { await this.gitDiscovery.observe({ kind: "plan", repos }); },
        onGitBusyDeferred: (repos) => { if (repos.length > 0) this.noteGitBusyDeferred(); },
        onProgress: (done, total, phase, detail, bytes) => this.onTransferProgress(done, total, phase, detail, bytes), // design 45 + 88: progress plus local status path
        onPullApplied: (a) => this.recordPullApplied(a), // design 45: the 409-recovery pull mutates the tree too
        onTypeFlip: (rel) => this.noteTypeFlip(rel), // design 50: 409-recovery pull can evict a dir too
        telemetry: this.telemetry,
        mutationBoundary: this.mutationGate,
        onCaseCollisionObservation: (observation) => this.observeCaseCollisions(observation),
        onStrandedIgnoredObserved: (count) => { this.strandedIgnored = count; },
      }, { localFileObservation: request.localFileObservation })),
      settleReport: () => {
        if (report) this.syncPhaseSampler.recordCompleted(report, "push", this.telemetry);
        metricsReport?.logSummaryTo(this.log); // Explicit metrics opt-out is silent. By default even a
        // no-op tick logs its state-load/git-plan cost — intentional since design 82 §4 (the
        // invisible steady-state cost is exactly what that design instruments).
      },
    });
  }

  private readonly publishTransition = new PublishLocalWorkspaceTransition({
    sealAttemptInputs: () => ({
      manifest: this.local.manifest,
      appliedBase: this.syncBase?.lastSyncedManifest,
      gcFencedPaths: this.retryQueue.gcFencedPaths,
      observationComplete: this.local.observationComplete,
      caseCollisions: this.activeCaseCollisions,
      blockedFingerprint: this.terminalPushBlock(),
    }),
    lastPublishedSequence: () => this.lastLoggedSeq,
    noteTerminalBlock: (fingerprint) => {
      this.pushTerminalBlocked = true;
      this.logTerminalPushBlocked(fingerprint);
    },
    recordGitCaptureSuccess: (provenance) => this.recordGitCaptureSuccess(provenance),
    commitPublishedSubset: (next, deferred) => {
      this.local.commitPatch(next, { kind: "partial", source: "push-committed", paths: new Set(deferred) }, { add: deferred });
    },
    adoptCollisionObservation: (groups, observationComplete) => {
      this.activeCaseCollisions = groups.map((group) => ({ paths: [...group.paths] }));
      this.local.setObservationComplete(observationComplete);
    },
    log: (line) => this.log(line),
    notePublishedSequence: (sequence) => { this.lastLoggedSeq = sequence; },
    recordPublishActivity: (files, sequence) => {
      // The status trail: "last push: 2m ago — N files → sequence S" (design 45).
      // Its own slot — it must never mask what a recovery pull applied.
      this.activity.lastPush = { at: new Date().toISOString(), files, sequence };
      this.activityDirty = true;
    },
    scheduleWriteFinish: (paths) => this.retryQueue.scheduleWriteFinish(new Set(paths)),
    scheduleGcFence: (paths) => this.retryQueue.scheduleGcFence(new Set(paths)),
    refreshDurableState: async () => { this.emitDurableGitDeferrals(await this.loadSyncBase()); },
    recordSyncMetric: async () => {
      this.metrics.syncs += 1;
      await saveMetrics(this.root, this.metrics);
    },
  });

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
    if (clearsStaleQuotaHalt) this.clearRecoveryHalt();
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
      const collisionIntersection = caseCollisionEventsRequireScan(this.activeCaseCollisions, events);
      if (events.some((e) => isIgnoreRuleFile(e.relPath)) || collisionIntersection) {
        this.rebuildMatcher(await this.loadSyncBase());
        if (events.some((e) => isIgnoreRuleFile(e.relPath))) this.rulesChangedSinceDeepScan = true;
        const receipt = await this.localObserver.observe({ kind: "scan", cache: this.cache, previous: this.local.manifest, mode: this.watcherScanMode() });
        await this.resolveDriftFromAppliedEvents(events, receipt.deferredPaths);
      } else {
        const receipt = await this.localObserver.observe({ kind: "watch-batch", events, cache: this.cache });
        // Drift resolves against the receipt's unread cursor BEFORE the retry
        // schedule lands: a covering event delivered in that window must still be
        // able to retract, and the sidecar transaction is the evidence barrier.
        await this.resolveDriftFromAppliedEvents(events, receipt.deferredPaths);
        this.localObserver.settleRetries(receipt);
      }
    }
  }

  private async observeCaseCollisions(observation: { authority: "authoritative" | "preserve"; caseCollisions: readonly CaseFoldCollisionGroup[] }): Promise<void> {
    const groups = observation.caseCollisions.map((group) => ({ paths: [...group.paths] }));
    // This callback runs before failure-capable publication work. Downgrade
    // immediately so a later throw cannot leave the next retry authoring truth
    // from the pre-rescan manifest. Only an installed successful PushResult may
    // upgrade completeness again.
    this.activeCaseCollisions = groups;
    if (observation.authority === "preserve" || groups.length > 0) {
      this.local.setObservationComplete(false);
    }
    if (observation.authority !== "authoritative") return;
    const run = this.pathWarningWrite.then(async () => {
      const next = buildPathWarnings(groups);
      // Foreground sync is another authorized writer. Compare to durable truth,
      // not an instance-local fingerprint that can become stale behind our back.
      if (next && (await readPathWarnings(this.root))?.fingerprint === next.fingerprint) return;
      const warnings = await savePathWarnings(this.root, groups);
      if (!warnings) return;
      const sample = warnings.collisions[0]?.paths.slice(0, LOG_PATHS_MAX).map(cleanPath).join(" ") ?? "";
      const omitted = warnings.groupCount > warnings.collisions.length ? `; ${warnings.groupCount - warnings.collisions.length} more groups` : "";
      this.log(`path warning: skipped ${warnings.pathCount} case-conflicting paths in ${warnings.groupCount} group${warnings.groupCount === 1 ? "" : "s"}${sample ? `: ${sample}` : ""}${omitted} — rename or remove one; background sync will pick it up`);
    });
    this.pathWarningWrite = run.catch(() => {});
    await run;
  }

  /** A watcher OBJECT exists and its stream has not faulted. `watcherHealthy` starts
   *  true before watcher initialization, so the object-presence half is load-bearing
   *  for startup failure and periodic-scan-only mode. */
  private watcherLive(): boolean {
    return this.watcher !== undefined && this.watcherHealthy;
  }

  /** P1: the watcher is live and its stream is trusted, not merely present. */
  private watcherTrustedForPull(): boolean {
    return this.watcherLive() && this.trustState === "trusted" && !this.watcherDegraded;
  }

  /** P2: the manifest is a complete observation with no active case-fold collision. */
  private manifestSettledForPull(): boolean {
    return this.local.observationComplete && this.activeCaseCollisions.length === 0;
  }

  /** The daemon-state readings design 202's trust predicate P is evaluated over.
   *  `deferred` aliases the live unsettled set deliberately: it is read-only to
   *  `pull()` (ReadonlySet) and every writer of that set is pump-owned code that cannot
   *  run while this op's `pull()` is in flight — watcher callbacks only enqueue events,
   *  and the pump is single-flight. The op therefore sees one consistent snapshot
   *  without copying it. */
  private pullTrustFacts(base: SyncState): PullTrustFacts {
    return {
      killSwitchOff: () => !pullTrustWatcherEnabled(),
      watcherTrusted: () => this.watcherTrustedForPull(),
      manifestSettled: () => this.manifestSettledForPull(),
      fullWorkspaceSinceSeed: () => this.local.fullWorkspaceSinceSeed,
      resetReady: () => this.resetLifecycle === "ready",
      matcherMatchesBase: () => this.matcherGitReposKey === gitReposMatcherKey(base),
      matcherObservationCurrent: () => this.local.observedMatcherGeneration === this.matcherGeneration,
      drainPendingEvents: () => this.applyPendingWatchEvents(),
      pendingEmpty: () => this.pendingEvents.length === 0,
      trustedView: () => ({ manifest: this.local.trustedProjection(), deferred: this.local.unsettledPaths }),
    };
  }

  private buildTrustedPullView(base: SyncState): Promise<TrustedPullViewResult> {
    return buildTrustedPullView(this.pullTrustFacts(base));
  }

  /**
   * Design 202 post-pull refresh: O(applied) instead of O(workspace). Re-checks P4
   * (F1) and then installs SYNCHRONOUSLY — there is no `await` between the check and
   * the assignment, so no watcher callback can interleave. The `watcher-drop` reason
   * is returned, never inferred by the caller.
   */
  private installPullPatch(
    local: Manifest,
    actions: readonly Action[],
    postBase: Manifest,
    opWatcherErrorGeneration: number,
  ): "watcher-drop" | undefined {
    if (this.watcherErrorGeneration !== opWatcherErrorGeneration) return "watcher-drop"; // F1
    const patched = patchManifestFromPull(local, actions, postBase);
    // A conflict copy's content is unknown until something hashes it; the watcher
    // event that observes it settles it and the next push publishes it.
    this.local.commitPatch(patched.manifest, { kind: "partial", source: "pull-applied", paths: patched.paths }, {
      add: patched.unsettled,
    });
    return undefined;
  }

  /** Chain repair mutates disk across historical sequences and its post-repair re-pull
   *  must see that disk — both always scan (F4 also forces the post-pull scan), so only
   *  the view passed in here can ever be trusted. */
  private async runPull(deps: SyncDeps, view: TrustedLocalView | undefined, noteChainRepair: () => void): Promise<Action[]> {
    try {
      return await pull(this.root, this.cfg, deps, view);
    } catch (error) {
      if (!(error instanceof ManifestChainError)) throw error;
      // Chain repair applies a historical manifest to disk and then PUBLISHES the
      // supersession. A scoped binding can do neither safely, so it halts here
      // rather than at the late publication chokepoint (design 212 §3.1b).
      if (this.scoped) {
        throw new ScopedBindingRefusal(
          "scoped-binding-cannot-publish",
          "the workspace history needs repairing, and this folder only syncs part of it. "
            + "Run `rbox recover` on a machine that syncs the whole workspace; this copy resumes on its own afterwards.",
        );
      }
      noteChainRepair();
      let refusal: SuffixInfo[] | undefined;
      const outcome = await repairChain(this.root, this.cfg, deps, error, {
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
      return outcome.kind === "converged"
        ? [...outcome.actions, ...await pull(this.root, this.cfg, deps)]
        : outcome.actions;
    }
  }

  private async doPull(syncMutex: WorkspaceSyncMutex, notifyLatencyMs?: number, notifyPendingAt?: number, carrier: Carrier = "none"): Promise<void> {
    if (this.e2ee.remote instanceof E2eeRemote) {
      const pin = await this.e2ee.remote.loadVerifiedPin();
      this.chainRepairPolicy.assertHeadAllowed(pin);
    }
    this.typeFlipsSincePull = 0; // per-op tally — a failed prior op's flips must not inflate this one's count
    let chainRepaired = false;
    let activeCarrier = carrier;
    await this.pullTransition.apply({
      seal: async () => {
        // Design 202. P4 is captured HERE, at op start, and re-checked immediately
        // before the post-pull install; the pre-op base is F2's "before" side.
        const watcherErrorGeneration = this.watcherErrorGeneration;
        const preBase = this.syncBase ?? await this.loadSyncBase();
        return { trust: await this.buildTrustedPullView(preBase), preBase, watcherErrorGeneration, notifyPendingAt };
      },
      open: () => {
        const metricsReport = beginReport("pull");
        const report = metricsReport ?? (telemetryEnabled() ? PhaseReport.pull() : undefined);
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
          onPullApplied: (a) => {
            this.creditAppliedCarrier(activeCarrier);
            activeCarrier = "none";
            this.recordPullApplied(a);
          },
          onTypeFlip: (rel) => this.noteTypeFlip(rel), // design 50 §3: forensic line + conflict count
          telemetry: this.telemetry,
          mutationBoundary: this.mutationGate,
        };
        return {
          execute: (request) => classifyPullOutcome(
            request,
            (view) => this.runPull(pullDeps, view, () => { chainRepaired = true; }),
            () => chainRepaired,
          ),
          settleReport: () => {
            if (report) this.syncPhaseSampler.recordCompleted(report, "pull", this.telemetry);
            metricsReport?.logSummaryTo((line) =>
              this.log(notifyLatencyMs !== undefined ? `${line} notify_latency_ms=${notifyLatencyMs}` : line),
            );
          },
        };
      },
    });
  }

  private readonly pullTransition = new ApplyRemoteWorkspaceTransition({
    clearChainRepair: () => this.chainRepairPolicy.clear(),
    recordPropagation: (pendingAt) => {
      this.telemetry.record({ kind: "propagation", deliveryToApplyMs: Math.max(0, this.now() - pendingAt) });
    },
    recordFileConflicts: async (count) => {
      this.metrics.fileConflicts += count;
      this.metrics.lastConflictAt = new Date().toISOString();
      await saveMetrics(this.root, this.metrics);
    },
    refreshMatcher: async () => {
      this.rebuildMatcher(await this.loadSyncBase());
      this.rulesChangedSinceDeepScan = true;
    },
    adoptPostBase: async () => {
      const base = await this.loadSyncBase();
      this.emitDurableGitDeferrals(base);
      this.lastLoggedSeq = base.lastSyncedSequence;
      return base;
    },
    gitTopologyChanged: (before, after) => gitTopologyChanged(before, after),
    // The scan does NOT realign matcher provenance — the guarded rebuild in
    // `loadSyncBase` already did that (design 206 §1), so it runs under a current
    // matcher and its install re-stamps the observation generation.
    scanLocal: async (previous) => {
      await this.localObserver.observe({ kind: "scan", cache: this.cache, previous, mode: this.watcherScanMode() });
    },
    installPullPatch: (view, actions, postBase, generation) =>
      this.installPullPatch(view.manifest, actions, postBase, generation),
    log: (line) => this.log(line),
  });

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
   * work can hang/fail, so every new durable episode becomes locally visible.
   *
   * Deliberately does NOT re-baseline matcher provenance (design 206 §1): its callers
   * are `pull()`/`pushManifest()` save callbacks and the un-pumped hygiene timer, where
   * a synchronous rebuild would stall the event loop mid-network-op. A key change here
   * leaves P7 refusing (named `skip=p7-matcher`) until the next pump-owned boundary —
   * at most one extra scan pull, in the safe direction. */
  private observeDurableGitState(state: SyncState, now = Date.now()): void {
    const before = this.syncBase
      ? renderShellDeferrals(this.syncBase, now, ageBucket, projectedRepoRecords(this.syncBase))
      : undefined;
    this.syncBase = state;
    this.emitDurableGitDeferrals(state, now);
    if (before !== renderShellDeferrals(state, now, ageBucket, projectedRepoRecords(state))) this.writeActivity();
  }

  /** Design 178 C: the existing scan cadence also revalidates durable busy
   * assertions. Accepted saves and CAS winners replace syncBase immediately. */
  private async runDeferralHygiene(): Promise<void> {
    if (this.deferralHygieneRunning) return;
    const base = this.syncBase;
    if (!base) return;
    this.deferralHygieneRunning = true;
    try {
      const result = await reconcileGitDeferrals(this.root, this.cfg, base, {
        now: this.now,
        timeBudgetMs: this.deferralHygieneBudgetMs,
        cursor: this.deferralHygieneCursor,
        recoverShared: (_root, commonDir) => this.recoverStateCasWithGate(commonDir),
        getDiscoveryAuthority: () => this.gitDiscovery.absenceProof,
      });
      if (result.state !== base) this.observeDurableGitState(result.state, this.now());
      if (result.recoveredLocks > 0) {
        this.scheduler.queue("pull");
        if (!this.pullOnly) this.requestPush("other");
        this.log(`Git lock recovery requeued the repository family (${result.recoveredLocks} lock${result.recoveredLocks === 1 ? "" : "s"})`);
      }
    } catch {
      // Hygiene is fail-closed and must never turn a presentation refresh into a
      // failed sync operation. The standing deferral remains authoritative.
      this.log("git deferral hygiene unavailable; retaining current assertions");
    } finally {
      this.deferralHygieneRunning = false;
    }
    if (!this.stopped && this.nextPumpOperation()) void this.pump();
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
      if (!this.stopped) this.sampleWsHealth();
      if (!this.stopped && !this.telemetry.empty) void this.telemetry.flush(AbortSignal.timeout(1500)).catch(() => {});
    }, TELEMETRY_FLUSH_MS);
    this.telemetryFlushTimer.unref?.();
    const capability = () => {
      if (!this.stopped) this.telemetry.record({ kind: "capability", workerExecutions: cryptoPoolStatus().workerExecutions });
    };
    this.capabilityInitialTimer = setTimeout(() => {
      capability();
      if (this.stopped) return;
      this.capabilityTimer = setInterval(capability, CAPABILITY_INTERVAL_MS);
      this.capabilityTimer.unref?.();
    }, CAPABILITY_INITIAL_DELAY_MS);
    this.capabilityInitialTimer.unref?.();
    this.syncStateHeartbeatTimer = setInterval(() => {
      if (!this.stopped && this.syncBase) this.syncStateReporter.heartbeat(this.syncBase);
    }, SYNC_STATE_HEARTBEAT_MS);
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
      this.retryQueue.deferredPaths.size === 0
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
    const manifestDiff = diffManifests(base.lastSyncedManifest, this.local.manifest);
    return {
      at: new Date(now).toISOString(),
      stream: base.stream,
      baseSequence: base.lastSyncedSequence,
      trackedFiles: this.local.manifest.files.length,
      added: manifestDiff.added.length,
      changed: manifestDiff.changed.length,
      deleted: manifestDiff.deleted.filter((p) => !this.matcher.ignores(p)).length,
      settled,
      ...(this.strandedIgnored === undefined ? {} : { strandedIgnored: this.strandedIgnored }),
      sourceVersion: 1,
    };
  }

  private ambientStatusFrom(snapshot: DaemonActivity, settled: boolean, now: number): RboxBarAmbientStatus {
    // Nested boundaries refine broad repo orchestration (for example the
    // abortable native git-prepare inside a draining follow). Report the newest,
    // most specific active lease rather than masking it with its outer scope.
    const mutations = this.mutationGate.snapshot();
    const activeMutation = mutations[mutations.length - 1];
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
      fileCount: this.local.manifest.files.length,
      totalBytes: this.local.manifest.files.reduce((n, f) => n + f.size, 0),
      daemonVersion: RBOX_VERSION,
      mode: this.pullOnly ? "pull-only" : "read-write",
      bootId: this.bootId,
      workspaceRoot: this.root,
      ...(this.mutationGate.closed ? {
        shutdown: {
          gateClosed: true as const,
          ...(activeMutation ? {
            phase: activeMutation.phase,
            repository: activeMutation.repository,
            committed: activeMutation.committed,
          } : {}),
        },
      } : {}),
    };
  }

  private activitySnapshot(): DaemonActivity {
    return {
      ...this.activity,
      local: this.activity.local ? { ...this.activity.local } : undefined,
      ws: this.activity.ws ? { ...this.activity.ws } : undefined,
      active: this.activity.active ? { ...this.activity.active } : undefined,
      halt: this.activity.halt ? {
        ...this.activity.halt,
        ...(this.activity.halt.typedReason ? { typedReason: { ...this.activity.halt.typedReason } } : {}),
        ...(this.activity.halt.terminal ? { terminal: { ...this.activity.halt.terminal } } : {}),
      } : undefined,
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
      mode: previous.mode,
      bootId: previous.bootId,
      workspaceRoot: previous.workspaceRoot,
    };
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
    if (this.stopped && status.state !== "paused" && status.shutdown?.gateClosed !== true) return false;
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

  private raiseQueuedCarrier(carrier: Carrier): void {
    if (carrier === "backstop") this.queuedBackstopPending = true;
    if (CARRIER_PRECEDENCE[carrier] > CARRIER_PRECEDENCE[this.queuedCarrier]) this.queuedCarrier = carrier;
  }

  private takeQueuedCarrier(): Carrier {
    const carrier = this.queuedCarrier;
    this.queuedCarrier = "none";
    this.queuedBackstopPending = false;
    return carrier;
  }

  private discardQueuedWsCarrier(): void {
    if (this.queuedCarrier !== "notify" && this.queuedCarrier !== "cursor") return;
    this.queuedCarrier = this.queuedBackstopPending ? "backstop" : "none";
    this.notifyPullPendingAt = undefined;
  }

  private creditAppliedCarrier(carrier: Carrier): void {
    if (carrier === "notify") this.notifyAppliedPulls++;
    else if (carrier === "cursor") this.cursorAppliedPulls++;
    else if (carrier === "backstop") this.backstopAppliedPulls++;
  }

  private observeNotifyLatency(latencyMs: number): void {
    this.notifyLatencyCount = Math.min(Number.MAX_SAFE_INTEGER, this.notifyLatencyCount + 1);
    this.notifyLatencySumMs = Math.min(Number.MAX_SAFE_INTEGER, this.notifyLatencySumMs + latencyMs);
    this.notifyLatencyMaxMs = Math.max(this.notifyLatencyMaxMs, latencyMs);
  }

  private readMonotonicMs(): number {
    const raw = this.monotonicNow();
    if (Number.isFinite(raw)) this.monotonicLastMs = Math.max(this.monotonicLastMs, raw);
    return this.monotonicLastMs;
  }

  private accrueWsConnectedUntil(now: number): void {
    if (this.wsConnectedSinceMs === undefined) return;
    this.wsConnectedAccumulatedMs = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.wsConnectedAccumulatedMs + Math.max(0, now - this.wsConnectedSinceMs),
    );
    this.wsConnectedSinceMs = now;
  }

  private sampleWsHealth(): void {
    const now = this.readMonotonicMs();
    this.accrueWsConnectedUntil(now);
    const durationMax = TELEMETRY_SAMPLE_SCHEMAS.ws_health.numbers.windowMs.max;
    const windowMs = Math.min(durationMax, Math.max(0, Math.floor(now - this.wsHealthWindowStartedMs)));
    const wsConnectedMs = Math.min(windowMs, Math.max(0, Math.floor(this.wsConnectedAccumulatedMs)));
    const counterDelta = (absolute: number, sampled: number): number => Math.max(0, absolute - sampled);
    const wsReconnects = counterDelta(this.wsReconnects, this.lastSampledWsReconnects);
    const wsHalfOpenDetected = counterDelta(this.wsHalfOpenDetected, this.lastSampledWsHalfOpenDetected);
    const backstopAttempts = counterDelta(this.wsBackstopPulls, this.lastSampledWsBackstopPulls);
    // Telemetry-only counters: the sample IS the running total, then zero it.
    const backstopAppliedPulls = this.backstopAppliedPulls;
    const cursorAppliedPulls = this.cursorAppliedPulls;
    const notifyAppliedPulls = this.notifyAppliedPulls;

    this.lastSampledWsReconnects = this.wsReconnects;
    this.lastSampledWsHalfOpenDetected = this.wsHalfOpenDetected;
    this.lastSampledWsBackstopPulls = this.wsBackstopPulls;
    this.backstopAppliedPulls = 0;
    this.cursorAppliedPulls = 0;
    this.notifyAppliedPulls = 0;
    this.wsHealthWindowStartedMs = now;
    this.wsConnectedAccumulatedMs = 0;

    this.telemetry.record({
      kind: "ws_health",
      windowMs,
      wsConnectedMs,
      wsReconnects,
      wsHalfOpenDetected,
      backstopAttempts,
      backstopAppliedPulls,
      cursorAppliedPulls,
      notifyAppliedPulls,
      notifyLatencyCount: this.notifyLatencyCount,
      notifyLatencySumMs: this.notifyLatencySumMs,
      notifyLatencyMaxMs: Math.min(durationMax, this.notifyLatencyMaxMs),
    });
    this.notifyLatencyCount = 0;
    this.notifyLatencySumMs = 0;
    this.notifyLatencyMaxMs = 0;
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
      ...(detail !== undefined ? { detail } : {}),
      ...(bytes ? { bytesDone: bytes.bytesDone, ...(bytes.bytesTotal !== undefined ? { bytesTotal: bytes.bytesTotal } : {}) } : {}),
      ...(bytes?.bytesPerSecond !== undefined ? { bytesPerSecond: bytes.bytesPerSecond } : {}),
      ...(bytes?.etaSeconds !== undefined ? { etaSeconds: bytes.etaSeconds } : {}),
    };
    this.writeActivity();
  }

  private async doFullScan(): Promise<ScanCoverage> {
    if (this.syncBase) this.ensureMatcherProvenance(this.syncBase);
    const errorGenAtStart = this.watcherErrorGeneration;
    const stats = createScanStats();
    const started = Date.now();
    const { deferredPaths, coverage } = await this.localObserver.observe({ kind: "scan", cache: this.cache, previous: this.local.manifest, scanStats: stats, scanKind: "safety scan", mode: this.watcherScanMode() });
    if (metricsEnabled()) this.log(scanStatsLine("safety scan", stats, Date.now() - started, deferredPaths.size));
    this.lastSafetyCompletedMs = Date.now();
    this.pruneCache();
    return { coverage, errorGenAtStart };
  }

  /** Layer A may prune only while a live watcher is trusted (see `watcherLive`). */
  private watcherScanMode(): "pruned" | "unpruned" {
    return this.watcherLive() ? "pruned" : "unpruned";
  }

  /** Cache-bypassing re-hash — the ultimate authority against mtime+size-stable drift. */
  private async doDeepScan(): Promise<ScanCoverage> {
    // Design 206 §1 serial gate: hygiene installs `syncBase` directly and the pump
    // binding prefers it over a reload, so a pull-only daemon could otherwise deep-scan
    // under a stale matcher indefinitely. Runs BEFORE errorGen capture, audit creation,
    // and `watcherScanMode()` selection.
    if (this.syncBase) this.ensureMatcherProvenance(this.syncBase);
    const errorGenAtStart = this.watcherErrorGeneration;
    const scanStartMs = Date.now();
    const priorManifest = this.local.manifest;
    const eventGenAtScan = this.watcherUnsettledGeneration;
    const rulesChanged = this.rulesChangedSinceDeepScan;
    const stats = createScanStats();
    const audit: OpenDriftAudit = {
      scanStartMs, candidates: [], horizonInputs: new Map(), rawEvents: [], appliedEvents: [], overflow: false,
      watcherHealthy: this.watcherLive(),
      trustState: retrustEnabled() ? this.trustState : "trusted",
      errorGen: this.watcherErrorGeneration,
      sinceSafetyMs: this.lastSafetyCompletedMs === undefined ? 0 : Math.max(0, scanStartMs - this.lastSafetyCompletedMs),
      rulesChanged,
    };
    this.openDriftAudits.add(audit);
    const fresh = new HashCache();
    let scanResult: ScanObservationReceipt;
    try {
      scanResult = await this.localObserver.observe({ kind: "scan", cache: fresh, previous: this.local.manifest, scanStats: stats, scanKind: "deep scan", mode: "unpruned" });
    } catch (error) {
      this.openDriftAudits.delete(audit);
      throw error;
    }
    const freshManifest = scanResult.freshManifest;
    this.rulesChangedSinceDeepScan = false;
    if (metricsEnabled()) this.log(scanStatsLine("deep scan", stats, Date.now() - scanStartMs, scanResult.deferredPaths.size));
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
    return { coverage: scanResult.coverage, errorGenAtStart };
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

  private async resolveDriftFromAppliedEvents(events: WatchEvent[], deferred: ReadonlySet<string>): Promise<void> {
    await this.mutateDriftState((state) => {
      if (state.pending.length === 0) return false;
      const result = resolveCoveredAtApply(state.pending, events, deferred, this.local.manifest);
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
        const pendingCoverage = [...audit.rawEvents, ...audit.appliedEvents, ...this.pendingEvents, ...[...this.retryQueue.deferredPaths].map((relPath) => ({ relPath, kind: "change" as const }))];
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
          watcherUnhealthySince: !this.watcherLive() || !audit.watcherHealthy,
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
    this.cache.prune(new Set(this.local.manifest.files.map((f) => f.path)));
  }

  private rebuildMatcher(state?: { lastSyncedManifest: Manifest }): void {
    this.matcher = buildIgnoreMatcher(this.root, {
      respectGitignore: this.cfg.respectGitignore === true,
      knownGitRepos: Object.keys(state?.lastSyncedManifest.gitRepos ?? {}),
    });
    this.matcherGitReposKey = gitReposMatcherKey(state);
    this.matcherGeneration++;
    this.downgradeWatcherIfBackendStale();
  }

  /**
   * Design 206 §1: re-baseline P7 provenance at pump-owned boundaries. The
   * key-equality guard is LOAD-BEARING, not an optimization: under tracked
   * evaluation `buildIgnoreMatcher` runs `discoverGitReposSync` plus per-repo
   * `git ls-files`, so an unguarded call would put sync fs + subprocess work on
   * every base reload. Guarded, it fires only on genuine topology change.
   */
  private ensureMatcherProvenance(base: SyncState): void {
    if (this.matcherGitReposKey !== gitReposMatcherKey(base)) this.rebuildMatcher(base);
  }

  /**
   * Design 206 §3b. The §3a facade keeps the JS filtering layer current, but the
   * BACKEND subscription bakes in matcher-derived state it cannot retro-fix: parcel's
   * native `ignore` globs are computed once at subscribe time, and chokidar bakes
   * `matcher.prunes` into recursive watch admission. When a rebuild moves those
   * inputs the live watch is blind for paths the new matcher observes, so trust drops
   * to the EXISTING terminal `fused` state — P1 stays false and every pull takes the
   * (correct, pre-202) scan path until restart. Hot re-arm is a watcher-lifecycle
   * design of its own, deliberately not smuggled in here.
   */
  private downgradeWatcherIfBackendStale(): void {
    const backend = this.watcher?.backend;
    if (backend === undefined || this.trustState === "fused") return;
    const stale = backend === "chokidar"
      // Chokidar admits recursive watches by the full `prunes` result: any rebuild
      // can move it, and there is no cheaper subscription input to compare.
      || nativePruneGlobs(this.root).join("\n") !== this.watcherNativePruneKey
      // Glob output unchanged but matcher coverage EXPANDED into a natively-excluded
      // dir (`!node_modules/`): those events never reach the JS layer at all.
      || [...ALWAYS_NATIVE_PRUNE].some((d) => !(this.matcher.prunes?.(`${d}/`) ?? this.matcher.ignores(`${d}/`)));
    if (!stale) return;
    this.log("watcher downgraded: ignore-rule change alters native watch coverage — pulls scan until restart");
    this.setTrustState("fused", "native watch coverage changed");
    this.writeAmbientStatus();
    this.pinSafetyFloor();
  }

  /**
   * Design 206 §3a. The watcher is handed THIS, not `this.matcher`: the backends
   * capture the matcher object once at start, so after any rebuild a captured
   * reference filters live events through a matcher the daemon has already replaced.
   * Delegation switches atomically with the assignment in `rebuildMatcher`.
   */
  private currentMatcherFacade(): IgnoreMatcher {
    return {
      ignores: (p) => this.matcher.ignores(p),
      prunes: (p) => this.matcher.prunes?.(p) ?? this.matcher.ignores(p),
      prunesForGitDiscovery: (p) => this.matcher.prunesForGitDiscovery?.(p) ?? this.matcher.ignores(`${p}/`),
      tracked: (p) => this.matcher.tracked?.(p) ?? false,
      unevaluatedGitRepoForPath: (p) => this.matcher.unevaluatedGitRepoForPath?.(p),
    };
  }

  /** Adoption invalidation is a durable cross-process generation, not merely a
   * disk-cache deletion. Observe it only under the workspace mutex, drop every
   * resident scan hint, and acknowledge only after an uncached unpruned scan. */
  private async adoptionCacheGenerationBoundary(): Promise<void> {
    const record = await readCacheGeneration(this.root);
    if (!record || record.generation <= this.observedAdoptCacheGeneration) return;
    const fresh = new HashCache();
    this.rebuildMatcher(this.syncBase);
    const prior = this.local.manifest;
    const scanned = await this.localObserver.observe({ kind: "scan", cache: fresh, previous: prior, scanKind: "deep scan", mode: "unpruned" });
    if (scanned.deferredPaths.size > 0) throw new Error("adoption cache generation full scan deferred; publication remains blocked");
    this.cache = fresh;
    this.pruneCache();
    await this.cache.save(this.root);
    await acknowledgeCacheGeneration(this.root, record.generation, `daemon-${this.bootId}`);
    this.observedAdoptCacheGeneration = record.generation;
    this.log(`adoption cache generation ${record.generation} acknowledged after full scan`);
  }

  private async reloadWorkspaceConfigIfChanged(): Promise<void> {
    const workspaceFile = path.join(this.root, ".rbox", "workspace.json");
    const [workspaceToken, catalogToken] = await Promise.all([
      reloadStatToken(workspaceFile),
      reloadStatToken(folderCatalogPath()),
    ]);
    const workspaceChanged = !sameReloadStatToken(this.workspaceConfigStat, workspaceToken);
    const catalogChanged = !sameReloadStatToken(this.folderCatalogStat, catalogToken);
    if (!workspaceChanged && !catalogChanged) return;
    this.workspaceConfigStat = workspaceToken;
    this.folderCatalogStat = catalogToken;

    try {
      if (workspaceChanged && workspaceToken !== null) {
        const loadedBinding = await loadConfig(this.root);
        if (!sameWorkspaceBindingIdentity(this.cfg, loadedBinding)) {
          this.setFolderAdmissionHalt("daemon binding changed while idle (workspace config identity mismatch) — stopping before mutation");
          return;
        }
      }
      const state = await ensureFolderAuthority({ currentRoot: this.root });
      const admission = await observeFolderAdmission(this.root, state);
      if (admission.kind !== "admitted") {
        this.setFolderAdmissionHalt(runtimeRefusal(admission).message);
        return;
      }
      const loaded = folderPolicyFields(admission.policy);
      const wasRespecting = this.cfg.respectGitignore === true;
      const needsRecycle = this.cfg.syncGit !== loaded.syncGit
        || this.cfg.git?.incremental !== loaded.git?.incremental;
      const safeFieldsOnly = {
        ...loaded,
        git: { ...this.cfg.git, incremental: loaded.git?.incremental },
      };
      // Take ONLY the field this reload exists for. Rebuilding cfg from `loaded`
      // clobbers the RUNTIME-ATTACHED fields buildAuthedRemote layered on at boot
      // (`encrypted: true`, `kek`, the credential `remoteUrl` override) — none of
      // which live in workspace.json. That shipped in v0.9.2 and killed every
      // daemon push with "E2EE required" minutes after start (first reload tick),
      // live on 2026-07-07. cfg stays the boot object; only the hot-reloadable
      // setting moves.
      this.cfg = { ...this.cfg, ...safeFieldsOnly };
      if (wasRespecting !== (this.cfg.respectGitignore === true)) {
        this.folderMatcherRebuildPending = true;
        try {
          this.rebuildMatcher(await this.loadSyncBase());
          this.folderMatcherRebuildPending = false;
          this.log(`workspace config reloaded: respectGitignore ${this.cfg.respectGitignore === true ? "on" : "off"}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.log(`folder config matcher rebuild deferred: ${reason}`);
        }
      }
      if (needsRecycle) {
        this.folderPolicyRecyclePending = true;
        this.log("folder config reloaded: Git policy changed; uncached rescan required");
      }
      this.folderAdmissionHaltReason = undefined;
    } catch (error) {
      this.setFolderAdmissionHalt(error instanceof Error ? error.message : String(error));
    }
  }

  private setFolderAdmissionHalt(reason: string): void {
    if (this.folderAdmissionHaltReason !== reason) this.log(`sync halted: ${reason}`);
    this.folderAdmissionHaltReason = reason;
  }

  private async folderOperationBoundary(): Promise<boolean> {
    await this.reloadWorkspaceConfigIfChanged();
    return this.folderAdmissionHaltReason === undefined;
  }

  /** Git policy changes invalidate resident scan hints. The boundary owns one
   * uncached, unpruned scan and clears the recycle flag only after its cache is
   * durable, so a failed acknowledgement is retried before any operation. */
  private async acknowledgeFolderPolicyRecycle(): Promise<boolean> {
    if (!this.folderPolicyRecyclePending && !this.folderMatcherRebuildPending) return true;
    try {
      if (this.folderMatcherRebuildPending) {
        this.rebuildMatcher(this.syncBase ?? await this.loadSyncBase());
        this.folderMatcherRebuildPending = false;
      }
      if (this.folderPolicyRecyclePending) {
        const fresh = new HashCache();
        const scanned = await this.localObserver.observe({
          kind: "scan",
          cache: fresh,
          previous: this.local.manifest,
          scanKind: "deep scan",
          mode: "unpruned",
        });
        if (scanned.deferredPaths.size > 0) {
          throw new Error("folder policy recycle full scan deferred; policy acknowledgement remains blocked");
        }
        this.cache = fresh;
        this.pruneCache();
        await this.cache.replace(this.root);
        this.folderPolicyRecyclePending = false;
        this.log("folder config Git policy acknowledged after uncached rescan");
      }
      this.folderPolicyRecycleFailure = undefined;
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.folderPolicyRecycleFailure !== reason) this.log(`sync halted: ${reason}`);
      this.folderPolicyRecycleFailure = reason;
      return false;
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
    this.discardQueuedWsCarrier();
    const generation = ++this.wsGeneration;
    const now = this.readMonotonicMs();
    this.accrueWsConnectedUntil(now);
    this.wsConnectedSinceMs = now;
    this.activity.ws = {
      ...this.wsBase(),
      connected: true,
    };
    this.writeWsActivity();
    this.startWsKeepalive(ws);
    this.armPongDeadline(ws);
    this.resetCursorSchedule(ws);
    return generation;
  }

  private markWsDisconnected(ws: WebSocket, reason: "close" | "error" | "timeout"): boolean {
    if (this.ws !== ws) return false;
    this.invalidateCursorSchedule();
    this.accrueWsConnectedUntil(this.readMonotonicMs());
    this.wsConnectedSinceMs = undefined;
    this.ws = undefined;
    this.stopWsKeepalive();
    this.wsGeneration++;
    this.discardQueuedWsCarrier();
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
    const keyDeliveryRequestId = parseKeyDeliveryNudge(data);
    if (keyDeliveryRequestId) {
      // This branch deliberately precedes the reset/sync readiness gate.
      this.keyDeliveryFlight?.enqueue(keyDeliveryRequestId);
      this.refreshWsAtThrottled();
      return;
    }
    if (this.resetLifecycle !== "ready") return;
    try {
      const m = JSON.parse(data) as { type?: string; sequence?: unknown };
      if (m.type === "committed") {
        if (this.ws) this.resetCursorSchedule(this.ws);
        this.recordCommittedFrame(typeof m.sequence === "number" ? m.sequence : -1);
        if (!this.wsReliabilityDisabled) this.notifyPullPendingAt ??= this.now();
        this.raiseQueuedCarrier("notify");
        this.request("pull");
        this.scheduleNextBackstop();
      } else if (Number.isInteger((m as { head?: unknown }).head) && (m as { head: number }).head >= 0 && this.cursorReplyResolve) {
        const resolve = this.cursorReplyResolve;
        this.cursorReplyResolve = undefined;
        resolve((m as { head: number }).head);
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

  private invalidateCursorSchedule(): void {
    this.cursorEpoch++;
    if (this.cursorTimer !== undefined) this.cursorClock.clearTimeout(this.cursorTimer);
    this.cursorTimer = undefined;
    const controller = this.cursorAbortController;
    this.cursorAbortController = undefined;
    this.cursorReplyResolve = undefined;
    controller?.abort(new Error("cursor check invalidated"));
  }

  private resetCursorSchedule(ws: WebSocket): void {
    this.invalidateCursorSchedule();
    if (
      this.cursorCheckMs <= 0 || this.stopped || this.resetLifecycle !== "ready"
      || this.ws !== ws || ws.readyState !== WebSocket.OPEN
    ) return;
    this.armCursorCheck(ws, this.wsGeneration, this.cursorEpoch);
  }

  private armCursorCheck(ws: WebSocket, generation: number, epoch: number): void {
    this.cursorTimer = this.cursorClock.setTimeout(() => {
      this.cursorTimer = undefined;
      void this.runCursorCheck(ws, generation, epoch);
    }, jitter(this.cursorCheckMs, this.cursorRandom));
  }

  /** A cursor check captured at (ws, generation, epoch) is stale — no longer the
   *  live socket/schedule — if the daemon stopped, the socket was swapped/closed,
   *  or a newer WS generation or cursor epoch superseded it. */
  private cursorStale(ws: WebSocket, generation: number, epoch: number): boolean {
    return this.stopped || this.ws !== ws || ws.readyState !== WebSocket.OPEN
      || generation !== this.wsGeneration || epoch !== this.cursorEpoch;
  }

  private async runCursorCheck(ws: WebSocket, generation: number, epoch: number): Promise<void> {
    if (this.cursorStale(ws, generation, epoch)) return;
    const controller = new AbortController();
    this.cursorAbortController = controller;
    const timeoutMs = Math.min(10_000, Math.max(1, this.cursorCheckMs - 1));
    let timeout: unknown;
    const reply = new Promise<number>((resolve, reject) => {
      this.cursorReplyResolve = resolve;
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      timeout = this.cursorClock.setTimeout(() => controller.abort(new Error(`cursor reply timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      ws.send("cursor");
      const head = await reply;
      if (this.cursorStale(ws, generation, epoch)) return;
      const localAppliedSequence = this.syncBase?.lastSyncedSequence ?? 0;
      if (head <= localAppliedSequence) return;
      this.raiseQueuedCarrier("cursor");
      this.request("pull");
    } catch (error) {
      if (epoch === this.cursorEpoch && !this.stopped) {
        this.log(`ws cursor check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (timeout !== undefined) this.cursorClock.clearTimeout(timeout);
      if (this.cursorAbortController === controller) {
        this.cursorAbortController = undefined;
        this.cursorReplyResolve = undefined;
      }
      if (!this.cursorStale(ws, generation, epoch) && this.cursorTimer === undefined) {
        this.armCursorCheck(ws, generation, epoch);
      }
    }
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
    // The same ordinary cadence supplies correctness when no workspace socket
    // is bound/live. This enqueue never joins the sync pump.
    this.keyDeliveryFlight?.enqueue();
    this.wsBackstopPulls++;
    this.log(`ws backstop pull (ws_backstop_pull=${this.wsBackstopPulls})`);
    this.raiseQueuedCarrier("backstop");
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
      this.keyDeliveryFlight?.enqueue();
      if (this.resetLifecycle === "ready") this.request("pull"); // catch up on anything missed while disconnected
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

export function createDaemonShutdownHandler(deps: {
  stop: () => Promise<void>;
  hasCommittedMutation: () => boolean;
  waitForCommittedMutationDrain: () => Promise<void>;
  finish: () => void;
  kill?: () => void;
  clock?: DaemonShutdownClock;
}): () => void {
  const clock = deps.clock ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const kill = deps.kill ?? (() => process.kill(process.pid, "SIGKILL"));
  let signals = 0;
  let finished = false;
  let shutdownDeadline: unknown;
  const armDeadline = () => {
    if (finished || shutdownDeadline !== undefined) return;
    shutdownDeadline = clock.setTimeout(kill, 60_000);
    (shutdownDeadline as { unref?: () => void } | undefined)?.unref?.();
  };
  return () => {
    signals++;
    if (signals > 1) {
      kill();
      return;
    }
    const stopping = deps.stop();
    if (deps.hasCommittedMutation()) {
      void deps.waitForCommittedMutationDrain().then(armDeadline, armDeadline);
    } else {
      armDeadline();
    }
    void stopping.catch(() => {}).finally(() => {
      finished = true;
      if (shutdownDeadline !== undefined) clock.clearTimeout(shutdownDeadline);
      shutdownDeadline = undefined;
      deps.finish();
    });
  };
}

/** Run the daemon until SIGTERM/SIGINT. Used by the hidden `__daemon-run` command. */
export async function buildAdmittedDaemonRuntime(
  root: string,
  warningSink?: (line: string) => void,
): Promise<Awaited<ReturnType<typeof buildAuthedRemote>>> {
  const state = await ensureFolderAuthority({ currentRoot: root });
  const admission = await observeFolderAdmission(root, state);
  if (admission.kind !== "admitted") throw runtimeRefusal(admission);
  const { cfg, deps, remote } = await buildAuthedRemote(root, Date.now, warningSink);
  return { cfg: applyFolderPolicy(cfg, admission.policy), deps, remote };
}

export async function runDaemon(root: string): Promise<void> {
  const logger = new RotatingDaemonLogger(root, () => new Date(), fsSync);
  const bootId = logger.bootId;
  logger.boot();
  let daemon: RboxDaemon | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const shutdown = createDaemonShutdownHandler({
    stop: () => daemon?.stop() ?? Promise.resolve(),
    hasCommittedMutation: () => daemon?.hasCommittedMutation() ?? false,
    waitForCommittedMutationDrain: () => daemon?.waitForCommittedMutationDrain() ?? Promise.resolve(),
    finish,
  });
  try {
    const { cfg, deps } = await buildAdmittedDaemonRuntime(root, logger.log); // E2EE transport + injected KEK
    daemon = new RboxDaemon(root, cfg, { ...deps, onGitLog: logger.log, warningSink: logger.log }, {
      bootId,
      // Transport only — `refreshScopeAuthority` is what actually decides, and can
      // only narrow. A scoped binding starts pull-only whatever this says.
      pullOnly: process.env.RBOX_DAEMON_PULL_ONLY === "1",
      log: logger.log,
      onStopped: finish,
    });
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
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
