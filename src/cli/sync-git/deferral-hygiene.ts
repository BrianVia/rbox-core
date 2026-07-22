import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import { inputRecord } from "../sync-state.js";

export type GitBusyClassification =
  | "quiescent"
  | "live"
  | "stale-unattributed"
  | "recoverable-rbox"
  | "indeterminate";

export type DeferralHygieneAction = "clear" | "retain" | "upgrade" | "recover";

/** Tranche 2 has no recoverable-rbox producer. The mapping is nevertheless
 * complete so workstream A can consume the same classifier contract. */
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
  resolveRepoContext: (repoDir: string) => Promise<RepoCtx | undefined>;
  inspectShared: (commonDir: string) => Promise<GitBusySharedInspection>;
  inspectRepo: (ctx: RepoCtx, shared: GitBusySharedInspection | Promise<GitBusySharedInspection>) => Promise<GitBusyInspection>;
  save: typeof applyStateSavePacket;
  reload: (root: string, stream: string) => Promise<SyncState>;
  classifier: GitBusyClassifier;
}

const defaultDeps: DeferralHygieneDeps = {
  now: () => Date.now(),
  resolveRepoContext: repoCtx,
  inspectShared: inspectGitBusyShared,
  inspectRepo: inspectGitBusy,
  save: applyStateSavePacket,
  reload: loadState,
  classifier: defaultClassifier,
};

export interface DeferralHygieneResult {
  state: SyncState;
  changed: boolean;
  accepted: boolean;
  displayDetails: Map<string, GitBusyDisplayDetail>;
  commonDirsInspected: number;
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
  const candidates = new Map<string, GitDeferral[]>();
  for (const [repo, record] of Object.entries(records)) {
    for (const deferral of Object.values(record.deferrals ?? {})) {
      if (deferral && selectedReason((deferral as { reason?: unknown }).reason)) {
        const list = candidates.get(repo) ?? [];
        list.push(deferral);
        candidates.set(repo, list);
      }
    }
  }
  if (candidates.size === 0) {
    return { state, changed: false, accepted: false, displayDetails: new Map(), commonDirsInspected: 0 };
  }

  const sharedInspections = new Map<string, Promise<GitBusySharedInspection>>();
  const inspections = new Map<string, GitBusyInspection>();
  for (const repo of candidates.keys()) {
    const repoDir = path.resolve(root, repo);
    if (repoDir !== root && !repoDir.startsWith(`${path.resolve(root)}${path.sep}`)) {
      inspections.set(repo, { status: "indeterminate", detail: "repository path leaves workspace" });
      continue;
    }
    const ctx = await deps.resolveRepoContext(repoDir).catch(() => undefined);
    if (!ctx) {
      inspections.set(repo, { status: "indeterminate", detail: "repository context unavailable" });
      continue;
    }
    const commonKey = path.resolve(ctx.commonDir);
    let shared = sharedInspections.get(commonKey);
    if (!shared) {
      shared = deps.inspectShared(commonKey);
      sharedInspections.set(commonKey, shared);
    }
    inspections.set(repo, await deps.inspectRepo(ctx, shared).catch((error) => ({
      status: "indeterminate" as const,
      detail: error instanceof Error ? error.message : String(error),
    })));
  }

  const planned: Array<{ repo: string; predecessor: GitDeferral; replacement: GitDeferral | null }> = [];
  const displayDetails = new Map<string, GitBusyDisplayDetail>();
  for (const [repo, deferrals] of candidates) {
    const inspection = inspections.get(repo) ?? { status: "indeterminate" as const, detail: "inspection missing" };
    const detail = inspection.status === "ok" ? displayDetail(inspection.locks, now) : undefined;
    for (const predecessor of deferrals) {
      if (detail) displayDetails.set(laneKey(repo, predecessor.lane), detail);
      const classification = predecessor.reason === "stale-unattributed" && inspection.status === "ok" && inspection.locks.length > 0
        ? "stale-unattributed"
        : deps.classifier.classify(episodeKey(root, repo, predecessor), inspection, now);
      const action = DEFERRAL_HYGIENE_ACTION[classification];
      if (action === "clear") {
        planned.push({ repo, predecessor, replacement: null });
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
    return { state, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size };
  }

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
      return { state: base, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size };
    }
    let saved: StateSaveResult;
    try {
      saved = await deps.save(root, {
        expectedStream: base.stream || syncStreamId(cfg),
        expectedNonce: expectedStateNonce(base),
        sourceGlobalSeq: base.lastSyncedSequence,
        repos: transitions,
      });
    } catch {
      const winner = await deps.reload(root, base.stream || syncStreamId(cfg)).catch(() => base);
      return { state: winner, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size };
    }
    if (saved.status === "accepted") {
      return { state: saved.state, changed: true, accepted: true, displayDetails, commonDirsInspected: sharedInspections.size };
    }
    const winner = await deps.reload(root, base.stream || syncStreamId(cfg)).catch(() =>
      saved.status === "rejected" ? saved.state : base);
    if (saved.status !== "rejected" || saved.reason !== "repo-generation") {
      return { state: winner, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size };
    }
    base = winner;
  }
  return { state: base, changed: false, accepted: false, displayDetails, commonDirsInspected: sharedInspections.size };
}

export function deferralHygieneDetailKey(repo: string, lane: GitDeferral["lane"]): string {
  return laneKey(repo, lane);
}
