import { buildIgnoreMatcher, checkoutTransactionCapability, cryptoPoolStatus, HashCache, scanManifest, type IgnoreMatcher } from "../engine/index.js";
import { trashStats } from "../engine/trash.js";
import { fetchAccountSummary } from "./account-cmd.js";
import { readAccountProfile } from "./account-profile.js";
import { loadState, type SyncState, type WorkspaceConfig } from "./config.js";
import { loadCredentials, type CredentialLoadResult, type Credentials } from "./credentials.js";
import { readDaemonPidRecord } from "./daemon-control.js";
import {
  observeWorkspace,
  type AmbientWorkspaceObservation,
} from "./workspace-observation.js";
import { loadMetrics } from "./metrics.js";
import { readPathWarnings } from "./path-warnings.js";
import { pendingGenesisState } from "./genesis-enrollment.js";
import { readFreshPopulateStatus } from "./populate-status.js";
import { inspectResetJournalSafety } from "./reset-halt-inspection.js";
import { readResetHaltHealth } from "./reset-health.js";
import { promotePendingModeIntent } from "./autostart-cmd.js";
import { fetchWithDeadline } from "./remote/resilient.js";
import type { BriefAccountSummary, BriefIdentitySource } from "./status-view.js";
import type { StatusAccountJson, StatusMode, StatusProbePort, StatusReadPort } from "./status-contract.js";
import { conflictSnapshotStatus, gitDivergenceCount, gitDivergenceFastRepoSource, gitDivergenceStatus, type GitDivergenceRepoHint } from "./sync-git.js";
import { reconcileGitDeferrals } from "./sync-git/deferral-hygiene.js";
import { readLockingHealth, type LockingHealth } from "./sync-mutex.js";
import { readUpdateCheckState } from "./update-check.js";

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
  observeWorkspace: (
    root: string,
    request: { depth: "ambient"; now: number },
  ) => Promise<AmbientWorkspaceObservation>;
  /** Independent ownership guard for status's best-effort hash-cache write. */
  readDaemonPidRecord: typeof readDaemonPidRecord;
  readLockingHealth?: (root: string) => Promise<LockingHealth>;
  checkoutTransactionCapability?: typeof checkoutTransactionCapability;
  readBriefIdentity?: (accountId: string) => Promise<BriefIdentitySource | undefined>;
  promotePendingModeIntent?: typeof promotePendingModeIntent;
  reconcileGitDeferrals?: typeof reconcileGitDeferrals;
  readPathWarnings?: typeof readPathWarnings;
}

export const defaultStatusDeps: StatusCmdDeps = {
  now: () => Date.now(),
  loadHashCache: (root) => HashCache.load(root),
  scanManifest,
  gitDivergenceCount,
  gitDivergenceStatus,
  gitDivergenceFastRepoSource,
  observeWorkspace,
  readDaemonPidRecord,
  readLockingHealth,
  checkoutTransactionCapability,
  promotePendingModeIntent,
  reconcileGitDeferrals,
  readPathWarnings,
};

async function fetchRemoteSequence(
  cfg: WorkspaceConfig,
  creds: { token: string; remoteUrl?: string } | undefined,
  timeoutMs = 2500
): Promise<number | undefined> {
  try {
    const token = creds?.token || cfg.token;
    if (!token) return undefined;
    const base = creds?.remoteUrl ?? cfg.remoteUrl;
    const res = await fetchWithDeadline(`${base}/v1/ws/${cfg.remoteWorkspaceId}/proj/${cfg.projectId}/latest`, {
      headers: { authorization: `Bearer ${token}` },
    }, timeoutMs);
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
    const res = await fetchWithDeadline(`${creds.remoteUrl}/v1/account/usage`, {
      headers: { authorization: `Bearer ${creds.token}` },
    }, timeoutMs);
    if (!res.ok) return unavailable;
    const body = (await res.json()) as { plan?: unknown; usedBytes?: unknown; storageCap?: unknown };
    if (typeof body.plan !== "string" || typeof body.usedBytes !== "number") return unavailable;
    const capBytes = body.storageCap === null || typeof body.storageCap === "number" ? body.storageCap : null;
    return { plan: body.plan, usedBytes: body.usedBytes, capBytes };
  } catch {
    return unavailable;
  }
}

async function readCachedBriefIdentity(accountId: string): Promise<BriefIdentitySource | undefined> {
  const profile = await readAccountProfile(accountId);
  return profile ? { email: profile.email, plan: profile.plan } : undefined;
}

async function cachedAccountSummary(
  loaded: CredentialLoadResult,
  primaryIdentityLookup?: (accountId: string) => Promise<BriefIdentitySource | undefined>
): Promise<BriefAccountSummary> {
  if (loaded.state === "absent") return { state: "signed-out" };
  if (loaded.state !== "valid") {
    const where = loaded.state === "invalid-environment" ? loaded.variable : loaded.path;
    return { state: "credential-degraded", reason: `${loaded.state}: ${where}` };
  }
  const creds = loaded.credentials;
  if (!creds.accountId) return { state: "unavailable" };
  const [primary, profile] = await Promise.all([
    primaryIdentityLookup?.(creds.accountId),
    readCachedBriefIdentity(creds.accountId),
  ]);
  return {
    state: "ok",
    identity: {
      email: primary?.email ?? profile?.email ?? null,
      plan: primary?.plan ?? profile?.plan ?? null,
    },
  };
}

function modeProbes(mode: StatusMode, deps: StatusCmdDeps): StatusProbePort {
  if (mode === "json") return { mode, readAccountUsage: (loaded) => fetchStatusAccountJson(loaded) };
  if (mode === "verbose") {
    return {
      mode,
      readAccountSummary: (loaded) => fetchAccountSummary(3500, loaded),
      readMetrics: loadMetrics,
      readUpdateState: readUpdateCheckState,
    };
  }
  return {
    mode,
    readBriefAccount: (loaded) => cachedAccountSummary(loaded, deps.readBriefIdentity),
    readUpdateState: readUpdateCheckState,
  };
}

/** The one adapter from the command's injectable dependencies to the projection's
 * read port. Every status read lives here; the projection holds no global. */
export function createStatusReadPort<M extends StatusMode>(mode: M, deps: StatusCmdDeps): StatusReadPort<M> {
  return {
    mode,
    now: deps.now,
    readCredentials: deps.loadCredentials ?? loadCredentials,
    readPendingGenesis: async (accountId) => Boolean(await pendingGenesisState(accountId)),
    readWorkspaceObservation: deps.observeWorkspace,
    inspectResetJournal: inspectResetJournalSafety,
    readResetHaltHealth,
    readState: loadState,
    readPathWarnings: deps.readPathWarnings ?? readPathWarnings,
    readTrashStats: (root) => trashStats(root).catch(() => undefined),
    readLockingHealth: deps.readLockingHealth ?? readLockingHealth,
    readPopulateStatus: (root, cfg, now) => readFreshPopulateStatus(root, cfg, now).catch(() => undefined),
    readRemoteSequence: (cfg, creds: Credentials | undefined) => fetchRemoteSequence(cfg, creds),
    readCryptoPoolStatus: cryptoPoolStatus,
    buildMatcher: buildIgnoreMatcher,
    loadHashCache: deps.loadHashCache,
    scanManifest: deps.scanManifest,
    gitDivergenceFastRepoSource: deps.gitDivergenceFastRepoSource,
    ...(deps.gitDivergenceStatus ? { gitDivergenceStatus: deps.gitDivergenceStatus } : {}),
    gitDivergenceCount: deps.gitDivergenceCount,
    readConflictSnapshotStatus: conflictSnapshotStatus,
    readCheckoutTransactionCapability: deps.checkoutTransactionCapability ?? checkoutTransactionCapability,
    probes: modeProbes(mode, deps),
  };
}
