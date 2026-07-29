import type { CheckoutTransactionCapability, HashCache, IgnoreMatcher, scanManifest } from "../engine/index.js";
import type { CryptoPoolStatus } from "../engine/crypto-pool/pool.js";
import type { TrashStats } from "../engine/trash.js";
import type { DaemonActivity } from "./activity.js";
import type { AccountSummary } from "./account-cmd.js";
import type { GitDeferral, SyncState, WorkspaceConfig } from "./config.js";
import type { CredentialLoadResult, Credentials } from "./credentials.js";
import type { AmbientDaemonStatusRecord, DaemonMode } from "./daemon/ambient-status.js";
import type { PathWarningsV1 } from "./path-warnings.js";
import type { PopulateStatusV1 } from "./populate-status.js";
import type { ResetSafetyInspection } from "./reset-halt-inspection.js";
import type { ResetHaltHealthV1 } from "./reset-health.js";
import type { SyncMetrics } from "./metrics.js";
import type { BriefAccountSummary, GitDeferralRepoProjection, StatusRemoteHead } from "./status-view.js";
import type { StatusDeferralDisplayDetails, StatusRefreshReceipt } from "./status-maintenance.js";
import type { GitDivergenceRepoHint, GitDivergenceStatus } from "./sync-git.js";
import type { LockingHealth } from "./sync-mutex.js";
import type { UpdateCheckState } from "./update-check.js";

export type StatusMode = "json" | "verbose" | "brief" | "git";

export interface StatusRequest<M extends StatusMode> {
  mode: M;
}

export interface StatusAccountJson {
  plan: string | null;
  usedBytes: number | null;
  capBytes: number | null;
}

/** The projection reconciles nothing: it asks the composition root's cycle-1
 * hygiene writer for a receipt bound to the state it just read, and re-asks only
 * when a daemon base mismatch forces a second read. */
export interface StatusRefreshAuthority {
  refresh: (cfg: WorkspaceConfig, state: SyncState) => Promise<StatusRefreshReceipt>;
}

export type StatusProbePort =
  | { mode: "json"; readAccountUsage: (loaded: CredentialLoadResult) => Promise<StatusAccountJson> }
  | {
    mode: "verbose";
    readAccountSummary: (loaded: CredentialLoadResult) => Promise<AccountSummary>;
    readMetrics: (root: string) => Promise<SyncMetrics>;
    readUpdateState: () => Promise<UpdateCheckState | undefined>;
  }
  | {
    mode: "brief" | "git";
    readBriefAccount: (loaded: CredentialLoadResult) => Promise<BriefAccountSummary>;
    readUpdateState: () => Promise<UpdateCheckState | undefined>;
  };

/** Every read a status surface performs. A read absent from this port is a
 * hidden global, and design 163 replaces the whole port — never `SyncState`
 * plumbing — when the bounded read-only store lands. */
export interface StatusReadPort<M extends StatusMode> {
  readonly mode: M;
  now: () => number;
  readCredentials: () => Promise<CredentialLoadResult>;
  readPendingGenesis: (accountId: string) => Promise<boolean>;
  readConfig: (root: string) => Promise<WorkspaceConfig>;
  readDaemonBinding: (root: string, workspaceId: string) => {
    alive: { running: boolean; pid?: number; bootId?: string };
    bound?: string;
    stale: boolean;
  };
  readAmbientDaemonStatus: (root: string) => AmbientDaemonStatusRecord;
  inspectResetJournal: (root: string, stream: string) => Promise<ResetSafetyInspection>;
  readResetHaltHealth: (root: string) => Promise<ResetHaltHealthV1 | undefined>;
  readState: (root: string, stream: string) => Promise<SyncState>;
  readActivity: (root: string) => Promise<DaemonActivity | undefined>;
  readPathWarnings: (root: string) => Promise<PathWarningsV1 | undefined>;
  readTrashStats: (root: string) => Promise<TrashStats | undefined>;
  readLockingHealth: (root: string) => Promise<LockingHealth>;
  readPopulateStatus: (root: string, cfg: WorkspaceConfig, now: number) => Promise<PopulateStatusV1 | undefined>;
  readRemoteSequence: (cfg: WorkspaceConfig, creds: Credentials | undefined) => Promise<number | undefined>;
  readCryptoPoolStatus: () => CryptoPoolStatus;
  buildMatcher: (root: string, opts: { respectGitignore: boolean; knownGitRepos: string[] }) => IgnoreMatcher;
  loadHashCache: (root: string) => Promise<HashCache>;
  scanManifest: typeof scanManifest;
  gitDivergenceFastRepoSource: (
    root: string,
    baseGitRepos: SyncState["lastSyncedManifest"]["gitRepos"],
    matcher: IgnoreMatcher,
  ) => Promise<GitDivergenceRepoHint[]>;
  /** Optional so embedders still wiring the numeric API keep working; the
   * count-only shape reconstructs deferrals from durable state below. */
  gitDivergenceStatus?: (
    root: string,
    cfg: WorkspaceConfig,
    state: SyncState,
    matcher?: IgnoreMatcher,
    source?: readonly GitDivergenceRepoHint[] | AsyncIterable<GitDivergenceRepoHint>,
    includeBaseRepos?: boolean,
  ) => Promise<GitDivergenceStatus>;
  gitDivergenceCount: (
    root: string,
    cfg: WorkspaceConfig,
    state: SyncState,
    matcher?: IgnoreMatcher,
    source?: readonly GitDivergenceRepoHint[] | AsyncIterable<GitDivergenceRepoHint>,
    includeBaseRepos?: boolean,
  ) => Promise<number>;
  readConflictSnapshotStatus: (root: string, repos: string[]) => Promise<{ total: number; prunable: number }>;
  readCheckoutTransactionCapability: (root: string) => Promise<CheckoutTransactionCapability>;
  probes: StatusProbePort;
}

export interface StatusCacheHint {
  cache: Pick<HashCache, "prune" | "save">;
  /** Evaluated only once writeback is authorized, so a skipped save costs nothing. */
  livePaths: () => Set<string>;
}

export interface LocalGitDeferral extends GitDeferral {
  repo: string;
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
  conflictSnapshots: { total: number; prunable: number };
}

export type StatusLocalCounts =
  | (StatusLocalCountsBase & { source: "computed" })
  | (StatusLocalCountsBase & { source: "daemon"; ageMs: number });

export interface StatusWorkspaceProjection {
  id: string;
  name?: string;
  root: string;
  deviceId: string;
  syncGit: boolean;
}

export interface StatusDaemonProjection {
  running: boolean;
  pid?: number;
  stale: boolean;
  version?: string;
  mode?: DaemonMode;
  versionSkew: boolean;
}

export interface StatusStateProjection {
  localSequence: number;
  syncedRepos: number;
  pendingRepos: number;
  conflictRepos: number;
}

export interface StatusGitProjection {
  deferrals: LocalGitDeferral[];
  projectedRepos: GitDeferralRepoProjection[];
  localRepoProjections: GitDeferralRepoProjection[];
  humanProjectedRepos: GitDeferralRepoProjection[];
  humanLocalRepoProjections: GitDeferralRepoProjection[];
  deferredRepos: number;
  bytesChangedDeferrals: number;
  capability?: CheckoutTransactionCapability;
  /** Mid-flight first-publish evidence for the git-sync line. */
  live?: NonNullable<DaemonActivity["active"]>;
}

/** Best-effort desired-mode bookkeeping stays a composition-root effect so the
 * projection itself writes nothing. */
export interface StatusBookkeepingHints {
  promoteDaemonModeIntent: boolean;
}

export interface StatusProjectionCommon {
  workspace: StatusWorkspaceProjection;
  daemon: StatusDaemonProjection;
  credentials: CredentialLoadResult;
  bookkeeping: StatusBookkeepingHints;
}

export type StatusHaltProbes =
  | { mode: "json" }
  | { mode: "verbose" }
  | { mode: "brief"; account: BriefAccountSummary }
  | { mode: "git"; account: BriefAccountSummary };

interface BriefProbeReceipt {
  account: BriefAccountSummary;
  update?: UpdateCheckState;
}

export type StatusModeProbes =
  | { mode: "json"; account: StatusAccountJson }
  | { mode: "verbose"; accountSummary: AccountSummary; metrics: SyncMetrics; update?: UpdateCheckState }
  | ({ mode: "brief" } & BriefProbeReceipt)
  | ({ mode: "git" } & BriefProbeReceipt);

export interface StatusHaltProjection extends StatusProjectionCommon {
  kind: "reset-halt";
  reason: string;
}

export interface StatusDetailProjection extends StatusProjectionCommon {
  kind: "detail";
  genesisPending: boolean;
  state: StatusStateProjection;
  activity?: DaemonActivity;
  remote?: StatusRemoteHead;
  remoteLine?: string;
  counts: StatusLocalCounts;
  /** Design 224 §2.3: already-synced base entries the matcher now ignores. Absent
   * when no source could supply one (a daemon that has not projected since start).
   * Deliberately top-level rather than inside `counts`, which is entangled with
   * `counts.source`. */
  strandedIgnored?: number;
  localChanges: number;
  health: "halt" | "outofstorage" | "active" | "pending" | "ok";
  populate?: PopulateStatusV1;
  trash?: TrashStats;
  locking: LockingHealth;
  crypto: CryptoPoolStatus;
  pathWarnings?: PathWarningsV1;
  git: StatusGitProjection;
  hygieneDetails: StatusDeferralDisplayDetails;
  cacheHint?: StatusCacheHint;
  now: number;
}

export type WorkspaceStatusProjection<M extends StatusMode> =
  | (StatusHaltProjection & { probes: Extract<StatusHaltProbes, { mode: M }> })
  | (StatusDetailProjection & { probes: Extract<StatusModeProbes, { mode: M }> });
