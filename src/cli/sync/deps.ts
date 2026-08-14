import { DirCache, HashCache, PhaseReport, createScanStats, scanPruneEnabled, type Action, type CaseFoldCollisionGroup, type DiscoveredGitRepo, type ScanStats } from "../../engine/index.js";
import { type OwnedRefMutationBoundary } from "../sync-git/pins.js";
import type { SyncState, WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import type { EncryptAndUploadOptions } from "../sync-recovery.js";
import type { WorkspaceSyncMutex } from "../sync-mutex.js";
import type { TransferProgress } from "../transfer-progress.js";
import type { TelemetryRecorder } from "../telemetry/queue.js";
import type { GitPushPlan } from "../sync-git/plan.js";
import type { ResolutionCaptureTestHooks } from "../sync-git/shared.js";
import type { MutationBoundary } from "../../engine/mutation-gate.js";

type CurrentWriteContext = {
  kek: Uint8Array;
  accountId: string;
  accountEpoch: number;
  keyEpoch: number;
};
type WriteContextProvider = SyncRemote & { currentKek?: () => Promise<CurrentWriteContext> };
/**
 * Injectable dependencies for the sync entry points (design 09 §1). Defaults
 * give production behavior; tests inject an in-memory `SyncRemote` and a no-op
 * `backoff` to exercise the conflict-retry control flow offline & fast. The SAME
 * deps object flows through pull/push/pushManifest/sync and its bounded retry loop.
 */
export interface SyncDeps {
  /** Daemon-only synchronous shutdown gate. Foreground operations omit it. */
  mutationBoundary?: MutationBoundary;
  /** Optional daemon ref-observation boundary. Foreground operations omit it. */
  ownedRefMutationBoundary?: OwnedRefMutationBoundary;
  /** Best-effort daemon-owned product telemetry. Record implementations must never throw. */
  telemetry?: TelemetryRecorder;
  /** Held once by the named top-level owner. Nested pull/push/retry operations
   * inherit this exact handle and must never reacquire the workspace mutex. */
  syncMutex?: WorkspaceSyncMutex;
  cache?: HashCache;
  /** Optional caller-owned directory cache. Foreground scans load their own only
   * when Layer A is explicitly enabled. */
  dircache?: DirCache;
  /** Adoption completion/abort requires one uncached, unpruned scan before a
   * publisher/applier may trust any warm listing or hash identity. */
  forceFullScan?: boolean;
  remote?: SyncRemote;
  backoff?: (attempt: number) => Promise<void>;
  /** Wall clock for the push conflict loop's elapsed-time budget; tests inject a
   *  logical clock to exercise the surrender without spending the real budget. */
  now?: () => number;
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
  /** Test-only race seam for synchronous keep-mine's actual publication capture. */
  resolutionCaptureTestHooks?: ResolutionCaptureTestHooks;
  /** Tests only: awaited after capture and before design-200 Step-D reads. */
  beforeAbsenceWitness?: (relPath: string) => void | Promise<void>;
  /** Forensic git-sync log sink (design 43 §10): capture/carry/defer/remove summaries on
   *  push, per-repo apply/conflict lines on pull. Push summaries include their structured
   *  plan as optional presentation context; grep-oriented sinks can ignore it and retain
   *  the exact full line. Default: console.error. The daemon injects its dated logger. */
  onGitLog?: (line: string, pushPlan?: GitPushPlan) => void;
  /** Operational warning/metrics sink. Daemons inject their instance-local dated
   * logger; foreground commands retain their existing stderr defaults. */
  warningSink?: (line: string) => void;
  /** Advisory local-file observation boundary. The push core awaits it while the
   * caller's workspace mutex is held, but swallows failures: path warnings can
   * never change publication correctness or exit status. */
  onCaseCollisionObservation?: (observation: {
    authority: "authoritative" | "preserve";
    caseCollisions: readonly CaseFoldCollisionGroup[];
  }) => void | Promise<void>;
  /** Design 224 §2.3: base entries the matcher ignores, observed once per
   * projection. Observability only — the daemon parks it in its activity snapshot
   * so `rbox status` can report the strand without a scan. */
  onStrandedIgnoredObserved?: (count: number) => void;
  /** Called immediately after a state save that may set/clear durable Git
   * deferrals. Observability-only: callers must not throw or mutate the state. */
  onGitDeferralsSaved?: (state: SyncState) => void;
  /** Daemon-owned additive Git discovery observer. It settles only after every
   * input is armed or recorded pending; planning never inherits observer errors. */
  onGitReposDiscovered?: (repos: readonly DiscoveredGitRepo[]) => Promise<void>;
  /** Sole prompt-retry report for a completed plan that deferred on Git locks. */
  onGitBusyDeferred?: (repos: readonly string[]) => void;
  /** Per-repo progress during the pull-side git-apply loop (`done` advances once per
   *  repo examined, including no-op "unchanged" ones) — lets a CLI collapse the N
   *  per-repo `onGitLog` lines into a single updating "N/total" counter instead. */
  onGitProgress?: (done: number, total: number) => void;
  /** Explicit human consent to a pull that deletes ≥half the baseline (design 44).
   *  Set ONLY by `rbox pull/sync --allow-mass-delete`; the daemon never sets it, so a
   *  runaway mass delete halts background sync instead of destroying the tree. */
  allowMassDelete?: boolean;
  /** Explicit human consent to a PUSH that deletes ≥half the baseline (design 50 §4).
   *  Deliberately SEPARATE from {@link allowMassDelete}: pushManifest's
   *  409-recovery reuses this same deps object to PULL, and pull-side consent must NOT be
   *  implied by push consent — a `rbox push --allow-mass-delete` must never let the recovery
   *  pull silently apply a mass delete. Set by `rbox push --allow-mass-delete`, or by
   *  `rbox sync --allow-mass-delete` alongside pull-side consent. */
  allowMassDeletePush?: boolean;
  /** Command shown when either mass-delete guard refuses this operation. */
  massDeleteHint?: string;
  /** A pull evicted a local directory that the remote now flips to a file/symlink
   *  (design 50 §3): the dir moved to trash. The CLI/daemon logs it and
   *  counts it into `lastPull.conflicts`. Threaded into applyActions via `onTypeFlip`. */
  onTypeFlip?: (relPath: string) => void;
  /** Fired by EVERY pull that applied actions to the local tree — including the pull
   *  inside pushManifest's 409 recovery, whose actions the retry loop discards
   *  (design 45: the daemon's forensic log and activity trail must record
   *  every local-tree mutation, whichever path performed it). */
  onPullApplied?: (actions: Action[]) => void;
  /** Fired after a pull durably adopts a sequence newer than its pre-pull base.
   *  Unlike onPullApplied, this includes Git-ref-only pulls with no file actions. */
  onPullAdopted?: (adoptedSequence: number, phaseMs?: Record<string, number>) => void;
  /** Daemon-only terminal-halt hint. Foreground `rbox push` / `rbox sync` leaves this
   *  unset so an explicit user sync always makes a real attempt. */
  blockedFingerprint?: string;
  /** Design 108 §3.6: the command-level "files synced" start milestone (a
   *  performance.now() reading) captured by init BEFORE scan, so timeToFilesSyncedMs
   *  includes the scan wall. Absent on non-init pushes → falls back to the timing's own
   *  start (which begins inside encryptAndUpload, after scan+git-plan). */
  filesFirstStartedAt?: number;
}

export function withReportScanStats(deps: SyncDeps, report: PhaseReport): SyncDeps {
  if (!report.enabled || deps.scanStats) return deps;
  return { ...deps, scanStats: createScanStats() };
}

/** Either use the caller's cache (caller owns persistence) or load+save one locally. */
export async function withCache(
  root: string,
  provided: HashCache | undefined
): Promise<{ cache: HashCache; save: () => Promise<void> }> {
  if (provided) return { cache: provided, save: async () => {} };
  const cache = await HashCache.load(root);
  return { cache, save: () => cache.save(root) };
}

/** Either use the caller's dircache, load+save the default-on Layer A cache, or
 * stay entirely inert when the RBOX_SCAN_PRUNE=0 kill switch is set. */
export async function withDircache(
  root: string,
  provided: DirCache | undefined
): Promise<{ dircache: DirCache | undefined; save: () => Promise<void> }> {
  if (!scanPruneEnabled()) return { dircache: undefined, save: async () => {} };
  if (provided) return { dircache: provided, save: async () => {} };
  const dircache = await DirCache.load(root);
  return { dircache, save: () => dircache.save(root) };
}

export async function refreshWriteContext(cfg: WorkspaceConfig, deps: SyncDeps): Promise<void> {
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
