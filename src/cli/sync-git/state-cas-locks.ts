import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../../engine/fsutil.js";
import {
  acquireLock,
  captureCommonDirIdentity,
  classifyProcessIncarnation,
  commonDirIdentityMatches,
  deserializeMarkerObservation,
  formatLockMarker,
  inspectLock,
  observeLockMarker,
  parseLockMarker,
  publishLockMarker,
  releaseObservedLock,
  safeBoundLockParent,
  sameMarkerObservation,
  serializeMarkerObservation,
  systemLockIdentity,
  validProcessIncarnation,
  type CommonDirIdentity,
  type LockIdentitySource,
  type LockfileHooks,
  type MarkerObservation,
  type ProcessIncarnation,
  type SerializedMarkerObservation,
} from "../../engine/git/lockfile.js";

const execFileAsync = promisify(execFile);
const JOURNAL_VERSION = 1 as const;
const JOURNAL_DIR = path.join(".rbox", "state", "git-lock-transactions", "v1");
const HEX_32 = /^[0-9a-f]{32}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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

export interface StateCasLockProof {
  repo: string;
  ref: string;
  expectedOid: string | null;
}

export interface StateCasLockRequest {
  lockPath: string;
  commonDir: string;
  proofs: StateCasLockProof[];
}

interface JournalLock {
  path: string;
  marker: string;
  proofs: StateCasLockProof[];
  acquisition?: "acquired" | "blocked";
  /** Persisted exact unlink capability. Marker bytes alone are never enough. */
  observation?: SerializedMarkerObservation;
}

interface JournalCommonDir extends CommonDirIdentity {
  locks: JournalLock[];
}

export interface StateCasLockJournal {
  version: 1;
  txnId: string;
  phase: "prepared" | "locked" | "committed";
  stream: string;
  stateNonce: string;
  owner: ProcessIncarnation;
  commonDirs: JournalCommonDir[];
  createdAt: string;
}

export interface PreparedStateCasLocks {
  journalPath: string;
  journal: StateCasLockJournal;
}

export interface HeldStateCasLock {
  path: string;
  observation: MarkerObservation;
}

export interface AcquiredStateCasLocks {
  held: HeldStateCasLock[];
  blocked: Set<string>;
}

export const stateCasJournalDir = (root: string): string => path.join(root, JOURNAL_DIR);

function boundedLockPath(commonDir: string, lockPath: string): string {
  const common = path.resolve(commonDir);
  const lock = path.resolve(lockPath);
  if (!lock.startsWith(`${common}${path.sep}`)) throw new Error(`Git lock escaped common directory: ${lock}`);
  return lock;
}

async function writeJournal(prepared: PreparedStateCasLocks): Promise<void> {
  await writeFileAtomic(prepared.journalPath, `${JSON.stringify(prepared.journal, null, 2)}\n`, { mode: 0o600, exactMode: true });
  await fsyncDirectory(path.dirname(prepared.journalPath));
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
  const dir = stateCasJournalDir(root);
  const created = await ensureDirectoryChain(dir, "state-CAS journal directory");
  await fsyncCreatedDirectoryAncestors(dir, created);
  const prepared: PreparedStateCasLocks = {
    journalPath: path.join(dir, `${txnId}.json`),
    journal: {
      version: JOURNAL_VERSION,
      txnId,
      phase: "prepared",
      stream: binding.stream,
      stateNonce: binding.stateNonce,
      owner,
      commonDirs,
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
    },
  };
  await writeJournal(prepared);
  return prepared;
}

export async function acquirePreparedStateCasLocks(
  prepared: PreparedStateCasLocks,
  options: {
    onFirstAcquired?: () => void | Promise<void>;
    /** Synchronous shutdown check at the actual hardlink publication edge. */
    beforeLockPublish?: () => void;
    afterAcquisitionPersisted?: (count: number, lockPath: string) => void | Promise<void>;
    hooks?: LockfileHooks;
  } = {},
): Promise<AcquiredStateCasLocks> {
  const held: HeldStateCasLock[] = [];
  const blocked = new Set<string>();
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
        const result = await publishLockMarker(lock.path, lock.marker, hooks);
        if (result.status === "created") {
          lock.acquisition = "acquired";
          lock.observation = serializeMarkerObservation(result.observation);
          held.push({ path: lock.path, observation: result.observation });
          // Persist each acquired inode before proceeding to any later lock or
          // state mutation. A crash before this write stays unattributed.
          await writeJournal(prepared);
          await options.afterAcquisitionPersisted?.(held.length, lock.path);
          if (held.length === 1) await options.onFirstAcquired?.();
        } else if (result.status === "exists") {
          lock.acquisition = "blocked";
          blocked.add(lock.path);
          await writeJournal(prepared);
        } else {
          throw result.error;
        }
      }
    }
    prepared.journal.phase = "locked";
    await writeJournal(prepared);
    return { held, blocked };
  } catch (error) {
    await releaseStateCasLocks(prepared, held);
    throw error;
  }
}

export async function markStateCasCommitted(prepared: PreparedStateCasLocks | undefined): Promise<void> {
  if (!prepared) return;
  prepared.journal.phase = "committed";
  await writeJournal(prepared);
}

async function removeJournal(prepared: PreparedStateCasLocks): Promise<void> {
  await fs.unlink(prepared.journalPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fsyncDirectory(path.dirname(prepared.journalPath));
}

export async function releaseStateCasLocks(
  prepared: PreparedStateCasLocks | undefined,
  held: readonly HeldStateCasLock[],
): Promise<boolean> {
  if (!prepared) return true;
  let exact = true;
  for (const lock of [...held].reverse()) {
    const released = await releaseObservedLock(lock.path, lock.observation);
    if (!released.released || !released.durable) exact = false;
  }
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
  if (exact) await removeJournal(prepared);
  return exact;
}

function parseJournal(raw: string, journalPath?: string): StateCasLockJournal | undefined {
  try {
    const value = JSON.parse(raw) as Partial<StateCasLockJournal>;
    if (value.version !== 1 || !HEX_32.test(value.txnId ?? "")
      || !["prepared", "locked", "committed"].includes(value.phase ?? "")
      || typeof value.stream !== "string" || typeof value.stateNonce !== "string"
      || !validProcessIncarnation(value.owner) || !Array.isArray(value.commonDirs) || value.commonDirs.length === 0
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return undefined;
    if (journalPath !== undefined && path.basename(journalPath) !== `${value.txnId}.json`) return undefined;
    const commonPaths = new Set<string>();
    const lockPaths = new Set<string>();
    for (const common of value.commonDirs) {
      if (!common || typeof common !== "object" || typeof common.path !== "string"
        || typeof common.realpath !== "string" || typeof common.dev !== "string"
        || typeof common.ino !== "string" || typeof common.birthtimeNs !== "string"
        || !Array.isArray(common.locks) || common.locks.length === 0) return undefined;
      if (!path.isAbsolute(common.path) || path.resolve(common.path) !== common.path
        || !path.isAbsolute(common.realpath) || path.resolve(common.realpath) !== common.realpath
        || commonPaths.has(common.path)) return undefined;
      commonPaths.add(common.path);
      for (const lock of common.locks) {
        if (!lock || typeof lock.path !== "string" || typeof lock.marker !== "string"
          || !Array.isArray(lock.proofs) || (lock.acquisition !== undefined && lock.acquisition !== "acquired" && lock.acquisition !== "blocked")) return undefined;
        if (lock.observation !== undefined) {
          const observation = deserializeMarkerObservation(lock.observation);
          if (!observation || observation.raw !== lock.marker || lock.acquisition !== "acquired") return undefined;
        }
        if (!path.isAbsolute(lock.path) || path.resolve(lock.path) !== lock.path
          || !lock.path.endsWith(".lock") || lockPaths.has(lock.path)) return undefined;
        try {
          if (boundedLockPath(common.path, lock.path) !== lock.path) return undefined;
        } catch {
          return undefined;
        }
        lockPaths.add(lock.path);
        const marker = parseLockMarker(lock.marker);
        if (!marker || marker.hostId !== value.owner.hostId || marker.bootId !== value.owner.bootId
          || marker.pid !== value.owner.pid || marker.startTime !== value.owner.startTime) return undefined;
        for (const proof of lock.proofs) {
          if (!proof || typeof proof !== "object" || typeof proof.repo !== "string" || proof.repo.length === 0
            || typeof proof.ref !== "string" || !proof.ref.startsWith("refs/")
            || (proof.expectedOid !== null && (typeof proof.expectedOid !== "string" || !GIT_OID.test(proof.expectedOid)))) return undefined;
        }
      }
    }
    return value as StateCasLockJournal;
  } catch {
    return undefined;
  }
}

interface LoadedJournal {
  path: string;
  journal?: StateCasLockJournal;
}

async function loadJournals(root: string): Promise<LoadedJournal[]> {
  const dir = stateCasJournalDir(root);
  try {
    const rootAbsolute = path.resolve(root);
    const rootReal = await fs.realpath(rootAbsolute);
    let current = rootAbsolute;
    for (const component of path.relative(rootAbsolute, dir).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe state-CAS journal directory: ${current}`);
    }
    const dirReal = await fs.realpath(dir);
    if (dirReal !== rootReal && !dirReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error("state-CAS journal directory escaped workspace");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const loaded: LoadedJournal[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let handle: fs.FileHandle | undefined;
    let raw: string | undefined;
    try {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) {
        loaded.push({ path: file });
        continue;
      }
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
        loaded.push({ path: file });
        continue;
      }
      raw = await handle.readFile("utf8");
    } catch {
      raw = undefined;
    } finally {
      await handle?.close().catch(() => {});
    }
    loaded.push({ path: file, journal: raw === undefined ? undefined : parseJournal(raw, file) });
  }
  return loaded;
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
  } = {},
): Promise<StateCasRecoveryResult> {
  let loaded: LoadedJournal[];
  try {
    loaded = await loadJournals(root);
  } catch {
    return { recovered: 0, live: 0, stale: 0, indeterminate: 1, journals: 0, recoveredCommonDirs: [] };
  }
  const identity = options.identity ?? systemLockIdentity;
  const releaseObserved = options.releaseObserved ?? releaseObservedLock;
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
          if (parent === "absent") continue;
          observed = await observeLockMarker(lock.path);
        }
        catch {
          result.indeterminate++;
          retain = true;
          continue;
        }
        if (!observed) continue;
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
      retireCandidates.push({
        path: item.path,
        commonKeys: item.journal.commonDirs
          .filter((common) => wanted === undefined || path.resolve(common.path) === wanted || path.resolve(common.realpath) === wanted)
          .map((common) => path.resolve(common.realpath)),
      });
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
