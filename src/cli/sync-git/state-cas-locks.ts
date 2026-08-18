/** Never: journal encoding, restart recovery policy, directory-batch mechanics, deferral persistence, apply proof policy, or generic workspace locking. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory } from "../../engine/fsutil.js";
import {
  captureCommonDirIdentity,
  commonDirIdentityMatches,
  formatLockMarker,
  observeLockMarker,
  publishLockMarker,
  releaseObservedLock,
  safeBoundLockParent,
  serializeMarkerObservation,
  systemLockIdentity,
  type LockIdentitySource,
  type LockfileHooks,
  type MarkerObservation,
} from "../../engine/lockfile.js";
import { StateCasAcquisitionBatch, StateCasReleaseBatch } from "./state-cas-lock-batch.js";
import {
  boundedLockPath,
  createStateCasJournal,
  MAX_V2_LOCKS,
  prepareStateCasJournalDirectory,
  stateCasJournalDir,
  type JournalCommonDir,
  type PreparedStateCasLocks,
  type StateCasJournalHooks,
  type StateCasLockJournal,
  type StateCasLockProof,
} from "./state-cas-journal.js";

export { stateCasJournalDir } from "./state-cas-journal.js";
export type { PreparedStateCasLocks, StateCasLockJournal, StateCasLockProof } from "./state-cas-journal.js";
export { classifyStateCasLockEvidence, recoverStateCasLocks } from "./state-cas-lock-recovery.js";
export type {
  JournalEvidence,
  MarkerEvidence,
  OwnerEvidence,
  StateCasLockClassification,
  StateCasRecoveryResult,
} from "./state-cas-lock-recovery.js";

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
  readonly acquired: number;
  readonly blocked: ReadonlySet<string>;
  release(options?: { syncDirectory?: (directory: string) => Promise<void> }): Promise<boolean>;
}
export async function prepareStateCasLocks(
  root: string,
  binding: { stream: string; stateNonce: string },
  requests: readonly StateCasLockRequest[],
  deps: { identity?: LockIdentitySource; now?: () => number; token?: () => string } = {},
): Promise<PreparedStateCasLocks | undefined> {
  if (requests.length === 0) return undefined;
  if (requests.length > MAX_V2_LOCKS) {
    throw new Error(`state-CAS lock count ${requests.length} exceeds the v2 journal limit of ${MAX_V2_LOCKS}`);
  }
  const identity = deps.identity ?? systemLockIdentity;
  const current = await identity.current();
  const owner = { hostId: current.hostId, bootId: current.bootId, pid: current.pid, startTime: current.startTime };
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
  return { journalPath, journal, writer };
}

async function appendLocked(prepared: PreparedStateCasLocks, batch: StateCasAcquisitionBatch, hooks?: StateCasJournalHooks): Promise<void> {
  batch.assertFlushed();
  await prepared.writer.append({ type: "locked" }, hooks);
  prepared.journal.phase = "locked";
  await prepared.writer.close();
}
export async function acquirePreparedStateCasLocks(
  prepared: PreparedStateCasLocks,
  options: {
    beforeAcquire?: () => void | Promise<void>;
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
  const batch = new StateCasAcquisitionBatch(locks.map((lock) => lock.path), options.syncDirectory);
  let outcomes = 0;
  let ordinal = 0;
  try {
    await options.beforeAcquire?.();
    for (const common of prepared.journal.commonDirs) {
      for (const lock of common.locks) {
        const recordOrdinal = ordinal++;
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
          await prepared.writer.append({ type: "acquisition", ordinal: recordOrdinal, observation }, options.journalHooks);
          lock.acquisition = "acquired";
          lock.observation = observation;
          batch.record(lock.path, "acquired");
          await options.afterLockAppended?.(++outcomes, lock.path);
          if (held.length === 1) await options.onFirstAcquired?.();
        } else if (result.status === "exists") {
          let holderMarker = "unknown";
          try { holderMarker = (await observeLockMarker(lock.path))?.raw ?? "unknown"; } catch { /* raced read */ }
          await prepared.writer.append({ type: "acquisition", ordinal: recordOrdinal, blocked: true, holderMarker }, options.journalHooks);
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
    await batch.flushAll();
    await options.afterBatchDurable?.();
    await appendLocked(prepared, batch, options.journalHooks);
    const release = new StateCasLockHandle(prepared, held, blocked);
    return release;
  } catch (error) {
    await releaseStateCasLocks(prepared, held, { syncDirectory: options.syncDirectory });
    throw error;
  }
}

class StateCasLockHandle implements AcquiredStateCasLocks {
  readonly acquired: number;
  readonly blocked: ReadonlySet<string>;
  #release: ((options?: { syncDirectory?: (directory: string) => Promise<void> }) => Promise<boolean>) | undefined;

  constructor(prepared: PreparedStateCasLocks, held: readonly HeldStateCasLock[], blocked: ReadonlySet<string>) {
    const owned = [...held];
    this.acquired = owned.length;
    this.blocked = new Set(blocked);
    this.#release = (options) => releaseStateCasLocks(prepared, owned, options);
  }

  async release(options?: { syncDirectory?: (directory: string) => Promise<void> }): Promise<boolean> {
    const release = this.#release;
    this.#release = undefined;
    if (!release) throw new Error("state-CAS lock handle already released");
    return release(options);
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

async function releaseStateCasLocks(
  prepared: PreparedStateCasLocks,
  held: readonly HeldStateCasLock[],
  options: { syncDirectory?: (directory: string) => Promise<void> } = {},
): Promise<boolean> {
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
  if (exact && !await prepared.writer.pathBound()) exact = false;
  await prepared.writer.close();
  if (exact) await removeJournal(prepared);
  return exact;
}
