import path from "node:path";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { scopeProjectionFor } from "../scope/projection.js";
import {
  inspectGitBusy,
  inspectGitBusyShared,
  repoCtx,
  type GitBusyInspection,
  type GitBusyLock,
  type GitBusySharedInspection,
  type RepoCtx,
} from "../../engine/git/shared.js";
import {
  applyStateSavePacket,
  expectedStateNonce,
  loadState,
  repoRecordsForState,
  syncStreamId,
  type GitDeferral,
  type StateSaveResult,
  type SyncState,
  type WorkspaceConfig,
} from "../config.js";
import { rethrowIfStateBarrier } from "../state-barrier.js";
import { inputRecord } from "../sync-state.js";
import { recoverStateCasLocks, type StateCasRecoveryResult } from "./state-cas-locks.js";

export type GitBusyClassification =
  | "quiescent"
  | "live"
  | "stale-unattributed"
  | "recoverable-rbox"
  | "indeterminate";

export type DeferralHygieneAction = "clear" | "retain" | "upgrade" | "recover";

/** One total classifier-to-action mapping shared by display and recovery. */
export const DEFERRAL_HYGIENE_ACTION: Record<GitBusyClassification, DeferralHygieneAction> = {
  quiescent: "clear",
  live: "retain",
  "stale-unattributed": "upgrade",
  "recoverable-rbox": "recover",
  indeterminate: "retain",
};

export interface GitBusyDisplayDetail {
  lockCount: number;
  oldestAgeMs: number;
  samplePath: string;
}

interface StableObservation {
  fingerprint: string;
  firstObservedAt: number;
  lastObservedAt: number;
}

export class GitBusyClassifier {
  private readonly observations = new Map<string, StableObservation>();

  constructor(private readonly stableForMs = 30_000) {}

  classify(key: string, inspection: GitBusyInspection, now: number): GitBusyClassification {
    if (inspection.status === "indeterminate") {
      this.observations.delete(key);
      return "indeterminate";
    }
    if (inspection.locks.length === 0) {
      this.observations.delete(key);
      return "quiescent";
    }
    if (!validLockCohort(inspection.locks, now)) {
      this.observations.delete(key);
      return "indeterminate";
    }
    const fingerprint = lockCohortFingerprint(inspection.locks);
    const previous = this.observations.get(key);
    if (!previous || previous.fingerprint !== fingerprint || now < previous.lastObservedAt) {
      this.remember(key, { fingerprint, firstObservedAt: now, lastObservedAt: now });
      return "live";
    }
    previous.lastObservedAt = now;
    if (now - previous.firstObservedAt >= this.stableForMs) return "stale-unattributed";
    return "live";
  }

  private remember(key: string, observation: StableObservation): void {
    if (this.observations.size >= 1_024) {
      const oldest = [...this.observations].sort(([, a], [, b]) => a.lastObservedAt - b.lastObservedAt)[0]?.[0];
      if (oldest !== undefined) this.observations.delete(oldest);
    }
    this.observations.set(key, observation);
  }
}

const defaultClassifier = new GitBusyClassifier();

function validLockCohort(locks: readonly GitBusyLock[], now: number): boolean {
  return Number.isFinite(now) && locks.every((lock) =>
    Number.isFinite(lock.mtimeMs)
    && lock.mtimeMs >= 0
    && lock.mtimeMs <= now
    && Number.isSafeInteger(lock.size)
    && lock.size >= 0
    && lock.dev.length > 0
    && lock.ino.length > 0
  );
}

function lockCohortFingerprint(locks: readonly GitBusyLock[]): string {
  return JSON.stringify([...locks]
    .map((lock) => [lock.path, lock.dev, lock.ino, lock.size, lock.mtimeMs] as const)
    .sort(([a], [b]) => a.localeCompare(b)));
}

function displayDetail(locks: readonly GitBusyLock[], now: number): GitBusyDisplayDetail | undefined {
  if (!validLockCohort(locks, now) || locks.length === 0) return undefined;
  const ordered = [...locks].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  return {
    lockCount: ordered.length,
    oldestAgeMs: Math.max(0, now - ordered[0]!.mtimeMs),
    samplePath: ordered[0]!.path,
  };
}

const selectedReason = (reason: unknown): reason is "git-busy" | "stale-unattributed" =>
  reason === "git-busy" || reason === "stale-unattributed";

const laneKey = (repo: string, lane: GitDeferral["lane"]): string => `${repo}\0${lane}`;
const episodeKey = (root: string, repo: string, deferral: GitDeferral): string =>
  `${root}\0${repo}\0${deferral.lane}\0${deferral.deferredSince}\0${deferral.reasonSince}`;

export interface DeferralHygieneDeps {
  now: () => number;
  budgetNow: () => number;
  timeBudgetMs: number;
  cursor?: DeferralHygieneCursor;
  resolveRepoContext: (repoDir: string) => Promise<RepoCtx | undefined>;
  inspectShared: (commonDir: string) => Promise<GitBusySharedInspection>;
  inspectRepo: (ctx: RepoCtx, shared: GitBusySharedInspection | Promise<GitBusySharedInspection>) => Promise<GitBusyInspection>;
  save: typeof applyStateSavePacket;
  reload: (root: string, stream: string) => Promise<SyncState>;
  classifier: GitBusyClassifier;
  inspectRepoDirectory: (repoDir: string) => Promise<"present" | "gone" | "indeterminate">;
  recoverShared: (root: string, commonDir: string) => Promise<StateCasRecoveryResult>;
  compensationBackoff: (attempt: number) => Promise<void>;
  /** The current per-repository complete-discovery proof. This is a getter so a
   * save retry can reject an authority revoked or superseded since planning. */
  getDiscoveryAuthority?: () => DeferralDiscoveryAuthority | undefined;
}

export interface DeferralDiscoveryAuthority {
  epoch: number;
  discoveredRepos: ReadonlySet<string>;
}

export interface DeferralHygieneCursor {
  /** Lexical repo name at which the next bounded pass resumes. */
  nextRepo?: string;
  /** pr8: bounded in-memory two-observation history, keyed once per repo/pass. */
  gone?: Map<string, { fingerprint: string; firstObservedAt: number; lastObservedAt: number; discoveryEpoch: number }>;
}

const defaultDeps: DeferralHygieneDeps = {
  now: () => Date.now(),
  budgetNow: () => performance.now(),
  timeBudgetMs: 2_000,
  resolveRepoContext: repoCtx,
  inspectShared: inspectGitBusyShared,
  inspectRepo: inspectGitBusy,
  save: applyStateSavePacket,
  reload: loadState,
  classifier: defaultClassifier,
  inspectRepoDirectory: async (repoDir) => {
    try {
      const stat = await fs.lstat(repoDir);
      return stat.isDirectory() && !stat.isSymbolicLink() ? "present" : "indeterminate";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "indeterminate";
    }
  },
  recoverShared: async (root, commonDir) => {
    return recoverStateCasLocks(root, { commonDir });
  },
  compensationBackoff: async (attempt) => {
    const delay = Math.min(1_000, 10 * 2 ** Math.min(attempt, 7));
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  },
};

export interface DeferralHygieneResult {
  state: SyncState;
  changed: boolean;
  accepted: boolean;
  displayDetails: Map<string, GitBusyDisplayDetail>;
  commonDirsInspected: number;
  recoveredLocks: number;
}

/** Re-probe every reconcilable durable lane, including records absent from all
 * discovery projections. The write is one nonce/repo-generation CAS packet; a
 * lost race reloads and returns the durable winner. */
export async function reconcileGitDeferrals(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  overrides: Partial<DeferralHygieneDeps> = {},
): Promise<DeferralHygieneResult> {
  const deps = { ...defaultDeps, ...overrides };
  const now = deps.now();
  const nowIso = new Date(now).toISOString();
  const records = repoRecordsForState(state);
  // Design 212 §3.2: hygiene resolves repo paths and can retire a deferral once its
  // stable-gone proof holds. On a scoped binding an out-of-scope repo is ABSENT by
  // design, so probing it would age out durable conflict and recovery posture that
  // is still true. Filter before candidate construction, never after the probe.
  const scope = await scopeProjectionFor(root, Object.keys(records));
  const candidates = new Map<string, GitDeferral[]>();
  for (const [repo, record] of Object.entries(records)) {
    if (scope && scope.classifyRepo(repo) !== "in") continue;
    for (const deferral of Object.values(record.deferrals ?? {})) {
      if (deferral && selectedReason((deferral as { reason?: unknown }).reason)) {
        const list = candidates.get(repo) ?? [];
        list.push(deferral);
        candidates.set(repo, list);
      }
    }
  }
  if (candidates.size === 0) {
    if (deps.cursor) deps.cursor.nextRepo = undefined;
    deps.cursor?.gone?.clear();
    return { state, changed: false, accepted: false, displayDetails: new Map(), commonDirsInspected: 0, recoveredLocks: 0 };
  }
  if (deps.cursor?.gone) {
    const prefix = `${path.resolve(root)}\0`;
    for (const key of deps.cursor.gone.keys()) {
      if (key.startsWith(prefix) && !candidates.has(key.slice(prefix.length))) deps.cursor.gone.delete(key);
    }
  }

  const orderedRepos = [...candidates.keys()].sort();
  const cursorRepo = deps.cursor?.nextRepo;
  const exactCursorIndex = cursorRepo === undefined ? -1 : orderedRepos.indexOf(cursorRepo);
  const nextCursorIndex = cursorRepo === undefined
    ? -1
    : orderedRepos.findIndex((repo) => repo >= cursorRepo);
  const startIndex = exactCursorIndex >= 0 ? exactCursorIndex : nextCursorIndex >= 0 ? nextCursorIndex : 0;
  const passRepos = [...orderedRepos.slice(startIndex), ...orderedRepos.slice(0, startIndex)];
  const budgetStartedAt = deps.budgetNow();

  const sharedInspections = new Map<string, Promise<GitBusySharedInspection>>();
  const repoCommonDirs = new Map<string, string>();
  const inspections = new Map<string, GitBusyInspection>();
  const goneDiscoveryEpochs = new Map<string, number>();
  let inspectedCount = 0;
  for (const repo of passRepos) {
    if (inspectedCount > 0 && deps.budgetNow() - budgetStartedAt >= deps.timeBudgetMs) break;
    const repoDir = path.resolve(root, repo);
    if (repoDir !== root && !repoDir.startsWith(`${path.resolve(root)}${path.sep}`)) {
      inspections.set(repo, { status: "indeterminate", detail: "repository path leaves workspace" });
      inspectedCount++;
      continue;
    }
    const ctx = await deps.resolveRepoContext(repoDir).catch(() => undefined);
    if (!ctx) {
      const directory = await deps.inspectRepoDirectory(repoDir).catch(() => "indeterminate" as const);
      const gone = deps.cursor?.gone ?? new Map<string, { fingerprint: string; firstObservedAt: number; lastObservedAt: number; discoveryEpoch: number }>();
      if (deps.cursor && !deps.cursor.gone) deps.cursor.gone = gone;
      const fingerprint = JSON.stringify((candidates.get(repo) ?? [])
        .map((item) => [item.lane, item.reason, item.deferredSince, item.reasonSince])
        .sort(([a], [b]) => String(a).localeCompare(String(b))));
      const key = `${path.resolve(root)}\0${repo}`;
      const previous = gone.get(key);
      const authority = directory === "gone" ? deps.getDiscoveryAuthority?.() : undefined;
      if (directory === "gone" && authority !== undefined && !authority.discoveredRepos.has(repo)
        && previous?.discoveryEpoch !== authority.epoch) {
        const stablePrevious = previous?.fingerprint === fingerprint
          && previous.discoveryEpoch !== authority.epoch
          && now >= previous.lastObservedAt;
        const observation = {
          fingerprint,
          firstObservedAt: stablePrevious ? previous.firstObservedAt : now,
          lastObservedAt: now,
          discoveryEpoch: authority.epoch,
        };
        gone.set(key, observation);
        if (stablePrevious && now - previous.firstObservedAt >= 30_000) {
          inspections.set(repo, { status: "ok", locks: [] });
          goneDiscoveryEpochs.set(repo, authority.epoch);
        } else {
          inspections.set(repo, { status: "indeterminate", detail: "repository is absent from discovery and directory is stably gone once" });
        }
      } else if (directory === "gone" && (authority === undefined || !authority.discoveredRepos.has(repo))) {
        // A safety-cadence pass without a fresh discovery cannot advance the
        // proof, but must not erase the prior qualifying observation either.
        if (previous && previous.fingerprint !== fingerprint) gone.delete(key);
        inspections.set(repo, { status: "indeterminate", detail: "repository is gone without fresh discovery authority" });
      } else {
        gone.delete(key);
        inspections.set(repo, { status: "indeterminate", detail: "repository context unavailable" });
      }
      inspectedCount++;
      continue;
    }
    deps.cursor?.gone?.delete(`${path.resolve(root)}\0${repo}`);
    const commonKey = await fs.realpath(ctx.commonDir).catch(() => path.resolve(ctx.commonDir));
    repoCommonDirs.set(repo, commonKey);
    let shared = sharedInspections.get(commonKey);
    if (!shared) {
      shared = deps.inspectShared(commonKey);
      sharedInspections.set(commonKey, shared);
    }
    inspections.set(repo, await deps.inspectRepo(ctx, shared).catch((error) => ({
      status: "indeterminate" as const,
      detail: error instanceof Error ? error.message : String(error),
    })));
    inspectedCount++;
  }
  if (deps.cursor) deps.cursor.nextRepo = inspectedCount < passRepos.length ? passRepos[inspectedCount] : undefined;

  // A linked-worktree blocker has one lifetime, regardless of how many repo
  // lanes observe it. Advance its stability window once under the canonical
  // common-dir key so every consumer reaches the same recovery decision.
  const sharedClassifications = new Map<string, GitBusyClassification>();
  for (const [commonDir, shared] of sharedInspections) {
    sharedClassifications.set(
      commonDir,
      deps.classifier.classify(`${path.resolve(root)}\0common\0${commonDir}`, await shared, now),
    );
  }

  const planned: Array<{ repo: string; predecessor: GitDeferral; replacement: GitDeferral | null; goneDiscoveryEpoch?: number }> = [];
  const displayDetails = new Map<string, GitBusyDisplayDetail>();
  const recoveryByCommonDir = new Map<string, Promise<StateCasRecoveryResult>>();
  const countedRecoveries = new Set<string>();
  let recoveredLocks = 0;
  for (const repo of passRepos.slice(0, inspectedCount)) {
    const deferrals = candidates.get(repo)!;
    let inspection = inspections.get(repo) ?? { status: "indeterminate" as const, detail: "inspection missing" };
    const detail = inspection.status === "ok" ? displayDetail(inspection.locks, now) : undefined;
    for (const predecessor of deferrals) {
      if (detail) displayDetails.set(laneKey(repo, predecessor.lane), detail);
      let classification = predecessor.reason === "stale-unattributed" && inspection.status === "ok" && inspection.locks.length > 0
        ? "stale-unattributed"
        : deps.classifier.classify(episodeKey(root, repo, predecessor), inspection, now);
      const commonDir = repoCommonDirs.get(repo);
      if (commonDir && sharedClassifications.get(commonDir) === "stale-unattributed") {
        classification = "stale-unattributed";
      }
      if (classification === "stale-unattributed" && commonDir) {
        let recovery = recoveryByCommonDir.get(commonDir);
        if (!recovery) {
          recovery = deps.recoverShared(root, commonDir);
          recoveryByCommonDir.set(commonDir, recovery);
        }
        const recovered = await recovery.catch(() => ({ recovered: 0, live: 0, stale: 0, indeterminate: 1, journals: 0 }));
        if (recovered.recovered > 0 && !countedRecoveries.has(commonDir)) {
          countedRecoveries.add(commonDir);
          recoveredLocks += recovered.recovered;
        }
        if (recovered.indeterminate > 0) classification = "indeterminate";
        else if (recovered.live > 0) classification = "live";
        else if (recovered.recovered > 0) {
          classification = "recoverable-rbox";
        }
      }
      let action = DEFERRAL_HYGIENE_ACTION[classification];
      if (action === "recover" && commonDir) {
        const ctx = await deps.resolveRepoContext(path.resolve(root, repo)).catch(() => undefined);
        if (ctx) {
          const refreshedShared = await deps.inspectShared(commonDir);
          sharedClassifications.set(
            commonDir,
            deps.classifier.classify(`${path.resolve(root)}\0common\0${commonDir}`, refreshedShared, now),
          );
          inspection = await deps.inspectRepo(ctx, refreshedShared).catch((error) => ({
            status: "indeterminate" as const,
            detail: error instanceof Error ? error.message : String(error),
          }));
          classification = deps.classifier.classify(episodeKey(root, repo, predecessor), inspection, now);
          const refreshedDetail = inspection.status === "ok" ? displayDetail(inspection.locks, now) : undefined;
          if (refreshedDetail) displayDetails.set(laneKey(repo, predecessor.lane), refreshedDetail);
          else displayDetails.delete(laneKey(repo, predecessor.lane));
        } else classification = "indeterminate";
        action = DEFERRAL_HYGIENE_ACTION[classification];
      }
      if (action === "clear") {
        planned.push({ repo, predecessor, replacement: null, goneDiscoveryEpoch: goneDiscoveryEpochs.get(repo) });
      } else if (action === "upgrade" && predecessor.reason === "git-busy") {
        planned.push({
          repo,
          predecessor,
          replacement: { ...predecessor, reason: "stale-unattributed", reasonSince: nowIso, lastSeen: nowIso },
        });
      }
    }
  }

  if (planned.length === 0) {
    return { state, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
  }

  /** Reload the durable winner of a lost CAS race, falling back to what the
   * caller already holds. A barrier refusal is terminal and must never be
   * folded into that fallback: the retry it would authorize is the write the
   * barrier just refused. */
  const reloadWinner = async (from: SyncState, fallback: SyncState = from): Promise<SyncState> =>
    await deps.reload(root, from.stream || syncStreamId(cfg)).catch((error: unknown) => {
      rethrowIfStateBarrier(error);
      return fallback;
    });

  let base = state;
  for (let attempt = 0; attempt < 3; attempt++) {
    const currentRecords = repoRecordsForState(base);
    const byRepo = new Map<string, typeof planned>();
    for (const action of planned) {
      const current = currentRecords[action.repo]?.deferrals?.[action.predecessor.lane];
      if (!current || !isDeepStrictEqual(current, action.predecessor)) continue;
      const actions = byRepo.get(action.repo) ?? [];
      actions.push(action);
      byRepo.set(action.repo, actions);
    }
    const transitions: Array<{ relPath: string; expectedRepoGen: number; newRecord: ReturnType<typeof inputRecord> }> = [];
    for (const [repo, actions] of byRepo) {
      const goneEpoch = actions.find((action) => action.goneDiscoveryEpoch !== undefined)?.goneDiscoveryEpoch;
      if (goneEpoch !== undefined) {
        const directory = await deps.inspectRepoDirectory(path.resolve(root, repo)).catch(() => "indeterminate" as const);
        const authority = deps.getDiscoveryAuthority?.();
        if (directory !== "gone" || authority?.epoch !== goneEpoch || authority.discoveredRepos.has(repo)) {
          if (directory !== "gone") deps.cursor?.gone?.delete(`${path.resolve(root)}\0${repo}`);
          continue;
        }
      }
      const record = currentRecords[repo]!;
      const nextRecord = inputRecord(record);
      const deferrals = { ...(nextRecord.deferrals ?? {}) };
      for (const action of actions) {
        if (action.replacement === null) delete deferrals[action.predecessor.lane];
        else deferrals[action.predecessor.lane] = action.replacement;
      }
      if (Object.keys(deferrals).length === 0) delete nextRecord.deferrals;
      else nextRecord.deferrals = deferrals;
      transitions.push({ relPath: repo, expectedRepoGen: record.repoGen, newRecord: nextRecord });
    }
    if (transitions.length === 0) {
      return { state: base, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
    }
    let saved: StateSaveResult;
    try {
      saved = await deps.save(root, {
        expectedStream: base.stream || syncStreamId(cfg),
        expectedNonce: expectedStateNonce(base),
        sourceGlobalSeq: base.lastSyncedSequence,
        repos: transitions,
      });
    } catch (error) {
      rethrowIfStateBarrier(error);
      const winner = await reloadWinner(base);
      return { state: winner, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
    }
    if (saved.status === "accepted") {
      const invalidGoneClears = new Map<string, typeof planned>();
      for (const [repo, actions] of byRepo) {
        const goneActions = actions.filter((action) => action.goneDiscoveryEpoch !== undefined);
        const goneEpoch = goneActions[0]?.goneDiscoveryEpoch;
        if (goneEpoch === undefined) continue;
        const directory = await deps.inspectRepoDirectory(path.resolve(root, repo)).catch(() => "indeterminate" as const);
        const authority = deps.getDiscoveryAuthority?.();
        if (directory !== "gone" || authority?.epoch !== goneEpoch || authority.discoveredRepos.has(repo)) {
          if (directory !== "gone") deps.cursor?.gone?.delete(`${path.resolve(root)}\0${repo}`);
          invalidGoneClears.set(repo, goneActions);
        }
      }
      if (invalidGoneClears.size === 0) {
        return { state: saved.state, changed: true, accepted: true, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
      }

      // The absence proof can be revoked while the accepted state write awaits
      // its lock/fsync. Restore only lanes still absent in the accepted winner;
      // a concurrent successor lane is stronger and is never overwritten.
      let repairBase = saved.state;
      for (let repairAttempt = 0; ; repairAttempt++) {
        const repairRecords = repoRecordsForState(repairBase);
        const repairs: Array<{ relPath: string; expectedRepoGen: number; newRecord: ReturnType<typeof inputRecord> }> = [];
        for (const [repo, actions] of invalidGoneClears) {
          const record = repairRecords[repo];
          if (!record) continue;
          const nextRecord = inputRecord(record);
          const deferrals = { ...(nextRecord.deferrals ?? {}) };
          let restoring = false;
          for (const action of actions) {
            if (deferrals[action.predecessor.lane] !== undefined) continue;
            deferrals[action.predecessor.lane] = action.predecessor;
            restoring = true;
          }
          if (!restoring) continue;
          nextRecord.deferrals = deferrals;
          repairs.push({ relPath: repo, expectedRepoGen: record.repoGen, newRecord: nextRecord });
        }
        if (repairs.length === 0) {
          return { state: repairBase, changed: true, accepted: true, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
        }
        let repaired: StateSaveResult;
        try {
          repaired = await deps.save(root, {
            expectedStream: repairBase.stream || syncStreamId(cfg),
            expectedNonce: expectedStateNonce(repairBase),
            sourceGlobalSeq: repairBase.lastSyncedSequence,
            repos: repairs,
          });
        } catch (error) {
          rethrowIfStateBarrier(error);
          repairBase = await reloadWinner(repairBase);
          await deps.compensationBackoff(repairAttempt);
          continue;
        }
        if (repaired.status === "accepted") {
          return { state: repaired.state, changed: true, accepted: true, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
        }
        repairBase = await reloadWinner(repairBase, repaired.status === "rejected" ? repaired.state : repairBase);
        await deps.compensationBackoff(repairAttempt);
      }
    }
    const winner = await reloadWinner(base, saved.status === "rejected" ? saved.state : base);
    if (saved.status !== "rejected" || saved.reason !== "repo-generation") {
      return { state: winner, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
    }
    base = winner;
  }
  return { state: base, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size, recoveredLocks };
}

export function deferralHygieneDetailKey(repo: string, lane: GitDeferral["lane"]): string {
  return laneKey(repo, lane);
}
