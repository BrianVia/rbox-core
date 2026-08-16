import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fsyncDirectory } from "../../engine/fsutil.js";
import {
  acquireLock,
  classifyProcessIncarnation,
  commonDirIdentityMatches,
  deserializeMarkerObservation,
  inspectLock,
  observeLockMarker,
  releaseObservedLock,
  safeBoundLockParent,
  sameMarkerObservation,
  systemLockIdentity,
  type LockIdentitySource,
  type MarkerObservation,
  type ProcessIncarnation,
} from "../../engine/lockfile.js";
import {
  boundedLockPath,
  type JournalCommonDir,
  type JournalLock,
} from "./state-cas-journal.js";
import { loadStateCasJournals } from "./state-cas-journal-loader.js";

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

async function ownerEvidence(owner: ProcessIncarnation, identity: LockIdentitySource): Promise<OwnerEvidence> {
  return classifyProcessIncarnation(owner, identity);
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

async function nearestExistingAncestor(commonDir: string, lockPath: string): Promise<string> {
  const common = path.resolve(commonDir);
  let cursor = path.dirname(lockPath);
  for (;;) {
    if (cursor !== common && !cursor.startsWith(`${common}${path.sep}`)) {
      throw new Error(`Git lock parent escaped common directory: ${lockPath}`);
    }
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe Git lock parent: ${cursor}`);
      const real = await fs.realpath(cursor);
      if (real !== common && !real.startsWith(`${common}${path.sep}`)) {
        throw new Error(`Git lock parent escaped common directory: ${cursor}`);
      }
      return cursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (cursor === common) throw error;
      cursor = path.dirname(cursor);
    }
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
      if (!await commonDirIdentityMatches(common)) {
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
              absentParents.add(await nearestExistingAncestor(common.path, lock.path));
            }
            continue;
          }
          observed = await observeLockMarker(lock.path);
        } catch {
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
          if (lock.acquisition !== "blocked") retain = true;
          continue;
        }
        const persisted = deserializeMarkerObservation(lock.observation);
        if (!persisted || !sameMarkerObservation(observed, persisted)) {
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
        } else if (!await commonDirIdentityMatches(common)) {
          result.indeterminate++;
          retain = true;
        } else {
          for (const candidate of recoverable) {
            try {
              const parent = await safeBoundLockParent(common.path, candidate.lock.path, { create: false });
              if (parent === "absent") {
                absentParents.add(await nearestExistingAncestor(common.path, candidate.lock.path));
                continue;
              }
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
