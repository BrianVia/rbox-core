import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fsyncDirectory } from "../../engine/fsutil.js";
import {
  acquireLock,
  captureCommonDirIdentity,
  classifyProcessIncarnation,
  commonDirIdentityMatches,
  deserializeMarkerObservation,
  formatLockMarker,
  inspectLock,
  observeLockMarker,
  publishLockMarker,
  releaseObservedLock,
  safeBoundLockParent,
  sameMarkerObservation,
  serializeMarkerObservation,
  systemLockIdentity,
  type LockIdentitySource,
  type LockfileHooks,
  type MarkerObservation,
  type ProcessIncarnation,
} from "../../engine/lockfile.js";
import { consumeStateCasBatchReceipt, StateCasAcquisitionBatch, StateCasReleaseBatch, type SealedStateCasBatchReceipt } from "./state-cas-lock-batch.js";
import {
  boundedLockPath,
  createStateCasJournal,
  loadStateCasJournals,
  prepareStateCasJournalDirectory,
  stateCasJournalDir,
  type JournalCommonDir,
  type JournalLock,
  type PreparedStateCasLocks,
  type StateCasJournalHooks,
  type StateCasLockJournal,
  type StateCasLockProof,
} from "./state-cas-journal.js";

export { stateCasJournalDir } from "./state-cas-journal.js";
export type { PreparedStateCasLocks, StateCasLockJournal, StateCasLockProof } from "./state-cas-journal.js";

const execFileAsync = promisify(execFile);

export type StateCasLockClassification =
  | "live"
  | "recoverable-rbox"
  | "stale-unattributed"
  | "indeterminate";
export type JournalEvidence = "valid" | "absent" | "corrupt";
export type OwnerEvidence = "alive" | "dead" | "unknown";
export type MarkerEvidence = "match" | "mismatch-live" | "mismatch-dead" | "mismatch-foreign" | "error";

/** Deterministic acceptance seam for the R2 journal × owner × marker matrix. */
export function classifyStateCasLockEvidence(
  journal: JournalEvidence,
  owner: OwnerEvidence,
  marker: MarkerEvidence,
): StateCasLockClassification {
  if (journal === "corrupt" || owner === "unknown" || marker === "error") return "indeterminate";
  if (marker === "mismatch-live") return "live";
  if (journal === "valid" && marker === "match") {
    return owner === "alive" ? "live" : "recoverable-rbox";
  }
  return "stale-unattributed";
}

export interface StateCasLockRequest {
  lockPath: string;
  commonDir: string;
  proofs: StateCasLockProof[];
}
export interface HeldStateCasLock {
  path: string;
  observation: MarkerObservation;
}
export interface AcquiredStateCasLocks {
  held: HeldStateCasLock[];
  blocked: Set<string>;
}
export async function prepareStateCasLocks(
  root: string,
  binding: { stream: string; stateNonce: string },
  requests: readonly StateCasLockRequest[],
  deps: { identity?: LockIdentitySource; now?: () => number; token?: () => string } = {},
): Promise<PreparedStateCasLocks | undefined> {
  if (requests.length === 0) return undefined;
  const identity = deps.identity ?? systemLockIdentity;
  const owner = await identity.current();
  const token = deps.token ?? (() => crypto.randomBytes(16).toString("hex"));
  const byCommon = new Map<string, StateCasLockRequest[]>();
  for (const request of requests) {
    const common = path.resolve(request.commonDir);
    boundedLockPath(common, request.lockPath);
    const group = byCommon.get(common) ?? [];
    group.push(request);
    byCommon.set(common, group);
  }
  const commonDirs: JournalCommonDir[] = [];
  for (const [common, group] of [...byCommon].sort(([a], [b]) => a.localeCompare(b))) {
    const identityRecord = await captureCommonDirIdentity(common);
    commonDirs.push({
      ...identityRecord,
      locks: group
        .map((request) => ({
          path: boundedLockPath(common, request.lockPath),
          marker: formatLockMarker({ ...owner, token: token() }),
          proofs: [...request.proofs].sort((a, b) => a.repo.localeCompare(b.repo) || a.ref.localeCompare(b.ref)),
        }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    });
  }
  const txnId = crypto.randomBytes(16).toString("hex");
  const dir = await prepareStateCasJournalDirectory(root);
  const journal: StateCasLockJournal & { version: 2 } = {
    version: 2,
    txnId,
    phase: "prepared",
    stream: binding.stream,
    stateNonce: binding.stateNonce,
    owner,
    commonDirs,
    createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
  };
  const journalPath = path.join(dir, `${txnId}.json`);
  const writer = await createStateCasJournal(root, journalPath, journal);
  return { root, journalPath, journal, writer };
}

async function appendLocked(prepared: PreparedStateCasLocks, receipt: SealedStateCasBatchReceipt, hooks?: StateCasJournalHooks): Promise<void> {
  consumeStateCasBatchReceipt(receipt, prepared.journal.txnId);
  await prepared.writer.append({ type: "locked" }, hooks);
  prepared.journal.phase = "locked";
  await prepared.writer.close();
}
export async function acquirePreparedStateCasLocks(
  prepared: PreparedStateCasLocks,
  options: {
    onFirstAcquired?: () => void | Promise<void>;
    /** Synchronous shutdown check at the actual hardlink publication edge. */
    beforeLockPublish?: () => void;
    afterLockAppended?: (count: number, lockPath: string) => void | Promise<void>;
    afterBatchDurable?: () => void | Promise<void>;
    hooks?: LockfileHooks;
    journalHooks?: StateCasJournalHooks;
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
): Promise<AcquiredStateCasLocks> {
  const held: HeldStateCasLock[] = [];
  const blocked = new Set<string>();
  const locks = prepared.journal.commonDirs.flatMap((common) => common.locks);
  const batch = new StateCasAcquisitionBatch(prepared.journal.txnId, locks.map((lock) => lock.path), options.syncDirectory);
  let outcomes = 0;
  try {
    for (const common of prepared.journal.commonDirs) {
      for (const lock of common.locks) {
        await safeBoundLockParent(common.path, lock.path, { create: true });
        if (!await commonDirIdentityMatches(common)) throw new Error(`Git common directory identity changed: ${common.path}`);
        const hooks: LockfileHooks = {
          ...options.hooks,
          beforeLink: async (lockPath, marker) => {
            await options.hooks?.beforeLink?.(lockPath, marker);
            // No await may occur between this check and atomicCreateMarker's
            // fs.link. Closing the gate before publication therefore wins.
            options.beforeLockPublish?.();
          },
        };
        const result = await publishLockMarker(lock.path, lock.marker, hooks, batch);
        if (result.status === "created") {
          const observation = serializeMarkerObservation(result.observation);
          held.push({ path: lock.path, observation: result.observation });
          await prepared.writer.append({ type: "acquisition", lockPath: lock.path, acquisition: "acquired", observation }, options.journalHooks);
          lock.acquisition = "acquired";
          lock.observation = observation;
          batch.record(lock.path, "acquired");
          await options.afterLockAppended?.(++outcomes, lock.path);
          if (held.length === 1) await options.onFirstAcquired?.();
        } else if (result.status === "exists") {
          let holderMarker = "unknown";
          try { holderMarker = (await observeLockMarker(lock.path))?.raw ?? "unknown"; } catch { /* raced read */ }
          await prepared.writer.append({ type: "acquisition", lockPath: lock.path, acquisition: "blocked", holderMarker }, options.journalHooks);
          lock.acquisition = "blocked";
          lock.holderMarker = holderMarker;
          blocked.add(lock.path);
          batch.record(lock.path, "blocked");
          await options.afterLockAppended?.(++outcomes, lock.path);
        } else {
          throw result.error;
        }
      }
    }
    const receipt = await batch.flushAll();
    await options.afterBatchDurable?.();
    await appendLocked(prepared, receipt, options.journalHooks);
    return { held, blocked };
  } catch (error) {
    await releaseStateCasLocks(prepared, held, { retainJournal: true, syncDirectory: options.syncDirectory });
    throw error;
  }
}

export async function markStateCasCommitted(prepared: PreparedStateCasLocks | undefined): Promise<void> {
  if (!prepared) return;
  try {
    await prepared.writer.append({ type: "committed" });
    prepared.journal.phase = "committed";
  } finally {
    await prepared.writer.close().catch(() => {});
  }
}

async function removeJournal(prepared: PreparedStateCasLocks): Promise<void> {
  await prepared.writer.close();
  await fs.unlink(prepared.journalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fsyncDirectory(path.dirname(prepared.journalPath));
}

export async function releaseStateCasLocks(
  prepared: PreparedStateCasLocks | undefined,
  held: readonly HeldStateCasLock[],
  options: { retainJournal?: boolean; syncDirectory?: (directory: string) => Promise<void> } = {},
): Promise<boolean> {
  if (!prepared) return true;
  let exact = true;
  const batch = new StateCasReleaseBatch(options.syncDirectory);
  const releasedByPath = new Map<string, boolean>();
  for (const lock of [...held].reverse()) {
    const released = await releaseObservedLock(lock.path, lock.observation, undefined, batch);
    releasedByPath.set(lock.path, released.released);
  }
  await batch.flushAll();
  for (const lock of held) if (!releasedByPath.get(lock.path) || !batch.durable(lock.path)) exact = false;
  // A publication can fail after the final hardlink exists but before the
  // publisher can return its observation (directory fsync/readback failure).
  // Re-scan the durable allowlist before retiring its authority. This also
  // preserves the journal when a normal release was replaced mid-cleanup.
  for (const common of prepared.journal.commonDirs) {
    for (const lock of common.locks) {
      try {
        const observed = await observeLockMarker(lock.path);
        if (observed?.raw === lock.marker) exact = false;
        else if (observed && lock.acquisition !== "blocked") exact = false;
      } catch {
        exact = false;
      }
    }
  }
  await prepared.writer.close();
  if (exact && !options.retainJournal) await removeJournal(prepared);
  return exact;
}

async function ownerEvidence(owner: ProcessIncarnation, identity: LockIdentitySource): Promise<OwnerEvidence> {
  return classifyProcessIncarnation(owner, identity);
}

async function identityMatches(common: JournalCommonDir): Promise<boolean> {
  return commonDirIdentityMatches(common);
}

async function validateGitCommonDir(commonDir: string): Promise<boolean> {
  try {
    await execFileAsync("git", [`--git-dir=${commonDir}`, "for-each-ref", "--format=%(refname)"]);
    return true;
  } catch {
    return false;
  }
}

async function validateJournalProofs(common: JournalCommonDir, lock: JournalLock): Promise<boolean> {
  try {
    for (const proof of lock.proofs) {
      let live: string | null;
      try {
        const { stdout } = await execFileAsync("git", [`--git-dir=${common.path}`, "rev-parse", "--verify", "--quiet", proof.ref]);
        live = String(stdout).trim() || null;
      } catch (error) {
        if ((error as { code?: number }).code !== 1) return false;
        live = null;
      }
      if (live !== proof.expectedOid) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface StateCasRecoveryResult {
  recovered: number;
  live: number;
  stale: number;
  indeterminate: number;
  journals: number;
  /** Canonical common directories in which at least one exact owned lock was reaped. */
  recoveredCommonDirs?: string[];
}

/** Recover every exact dead-owner lock in one canonical common directory. Mixed
 * foreign cohorts remain blockers. The common-dir fence serializes linked
 * worktrees and concurrent recovery attempts. */
export async function recoverStateCasLocks(
  root: string,
  options: {
    commonDir?: string;
    identity?: LockIdentitySource;
    /** Deterministic unlink/fsync refusal seam. */
    releaseObserved?: typeof releaseObservedLock;
    /** Deterministic absent-entry parent durability seam. */
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
): Promise<StateCasRecoveryResult> {
  let loaded: Awaited<ReturnType<typeof loadStateCasJournals>>;
  try {
    loaded = await loadStateCasJournals(root);
  } catch {
    return { recovered: 0, live: 0, stale: 0, indeterminate: 1, journals: 0, recoveredCommonDirs: [] };
  }
  const identity = options.identity ?? systemLockIdentity;
  const releaseObserved = options.releaseObserved ?? releaseObservedLock;
  const syncDirectory = options.syncDirectory ?? fsyncDirectory;
  const wanted = options.commonDir === undefined ? undefined : path.resolve(options.commonDir);
  const recoveredCommonDirs = new Set<string>();
  type AcquiredFence = Extract<Awaited<ReturnType<typeof acquireLock>>, { status: "acquired" }>;
  const recoveryFences = new Map<string, AcquiredFence>();
  const failedFences = new Set<string>();
  const retireCandidates: Array<{ path: string; commonKeys: string[] }> = [];
  const result: StateCasRecoveryResult = { recovered: 0, live: 0, stale: 0, indeterminate: 0, journals: loaded.length, recoveredCommonDirs: [] };
  for (const item of loaded) {
    if (!item.journal) {
      // Malformed authority remains visible in startup and targeted episodes.
      result.indeterminate++;
      continue;
    }
    const owner = await ownerEvidence(item.journal.owner, identity);
    const allJournalCommonDirsTargeted = wanted === undefined || item.journal.commonDirs.every((common) =>
      path.resolve(common.path) === wanted || path.resolve(common.realpath) === wanted);
    let retain = owner !== "dead";
    const absentParents = new Set<string>();
    if (owner === "unknown") result.indeterminate++;
    for (const common of item.journal.commonDirs) {
      if (wanted !== undefined && path.resolve(common.path) !== wanted && path.resolve(common.realpath) !== wanted) continue;
      if (!await identityMatches(common)) {
        result.indeterminate++;
        retain = true;
        continue;
      }
      const recoverable: Array<{ lock: JournalLock; observation: MarkerObservation }> = [];
      for (const lock of common.locks) {
        let bounded = false;
        try { bounded = boundedLockPath(common.path, lock.path) === path.resolve(lock.path); }
        catch { /* corrupt authority is retained below */ }
        if (!bounded) {
          result.indeterminate++;
          retain = true;
          continue;
        }
        let observed;
        try {
          const parent = await safeBoundLockParent(common.path, lock.path, { create: false });
          if (parent === "absent") {
            if (owner === "dead" && lock.acquisition !== "blocked") {
              result.indeterminate++;
              retain = true;
            }
            continue;
          }
          observed = await observeLockMarker(lock.path);
        }
        catch {
          result.indeterminate++;
          retain = true;
          continue;
        }
        if (!observed) {
          if (lock.acquisition !== "blocked") absentParents.add(path.dirname(lock.path));
          continue;
        }
        if (observed.raw !== lock.marker) {
          const inspection = await inspectLock(lock.path, identity);
          if (inspection.kind === "live") result.live++;
          else if (inspection.kind !== "absent") result.stale++;
          // A blocked entry was never ours; the journal is not needed to retain
          // someone else's blocker. Acquired/pending entries remain evidence.
          if (lock.acquisition !== "blocked") retain = true;
          continue;
        }
        const persisted = deserializeMarkerObservation(lock.observation);
        if (!persisted || !sameMarkerObservation(observed, persisted)) {
          // Matching bytes on a different inode are not ownership. This is the
          // reproduced copied-marker replacement case.
          result.stale++;
          retain = true;
          continue;
        }
        const classification = classifyStateCasLockEvidence("valid", owner, "match");
        if (classification === "live") result.live++;
        else if (classification === "indeterminate") result.indeterminate++;
        else if (classification === "recoverable-rbox") {
          if (!await validateJournalProofs(common, lock)) {
            result.indeterminate++;
            retain = true;
          } else recoverable.push({ lock, observation: persisted });
        }
        if (classification !== "recoverable-rbox") retain = true;
      }
      if (recoverable.length > 0) {
        const commonKey = path.resolve(common.realpath);
        const fenceDir = path.join(common.path, "rbox-locks", "recovery", "v1");
        let fence = recoveryFences.get(commonKey);
        if (!fence && !failedFences.has(commonKey)) {
          try {
            await safeBoundLockParent(common.path, path.join(fenceDir, "recovery.lock"), { create: true });
            const acquired = await acquireLock(path.join(fenceDir, "recovery.lock"));
            if (acquired.status === "acquired") {
              fence = acquired;
              recoveryFences.set(commonKey, acquired);
            } else failedFences.add(commonKey);
          } catch {
            failedFences.add(commonKey);
          }
        }
        if (!fence) {
          result.indeterminate++;
          retain = true;
        } else if (!await identityMatches(common)) {
          result.indeterminate++;
          retain = true;
        } else {
          for (const candidate of recoverable) {
            try {
              const parent = await safeBoundLockParent(common.path, candidate.lock.path, { create: false });
              if (parent === "absent") continue;
            } catch {
              result.indeterminate++;
              retain = true;
              continue;
            }
            const released = await releaseObserved(candidate.lock.path, candidate.observation);
            if (released.released && released.durable) {
              result.recovered++;
              recoveredCommonDirs.add(common.realpath);
            } else {
              result.indeterminate++;
              retain = true;
            }
          }
        }
      }
      // Validation is required even when a dead-owner journal's locks are
      // already absent (for example, crash after cleanup but before journal
      // retirement). A failed validation can never disappear on the next pass.
      if (owner === "dead" && !await validateGitCommonDir(common.path)) {
        result.indeterminate++;
        retain = true;
      }
    }
    if (allJournalCommonDirsTargeted && !retain) {
      let parentsDurable = true;
      for (const parent of [...absentParents].sort()) {
        try { await syncDirectory(parent); }
        catch {
          parentsDurable = false;
          result.indeterminate++;
        }
      }
      if (parentsDurable) {
        retireCandidates.push({
          path: item.path,
          commonKeys: item.journal.commonDirs
            .filter((common) => wanted === undefined || path.resolve(common.path) === wanted || path.resolve(common.realpath) === wanted)
            .map((common) => path.resolve(common.realpath)),
        });
      }
    }
  }
  for (const [commonKey, fence] of recoveryFences) {
    const released = await fence.lock.release();
    if (!released.released || !released.durable) {
      failedFences.add(commonKey);
      result.indeterminate++;
    }
  }
  for (const candidate of retireCandidates) {
    if (candidate.commonKeys.some((key) => failedFences.has(key))) continue;
    try {
      await fs.unlink(candidate.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      await fsyncDirectory(path.dirname(candidate.path));
    } catch {
      result.indeterminate++;
    }
  }
  result.recoveredCommonDirs = [...recoveredCommonDirs].sort();
  return result;
}
