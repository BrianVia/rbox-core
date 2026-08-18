/** Lock bundle for fresh SQLite genesis admission. */
import path from "node:path";
import {
  acquireLock,
  type LockAcquireResult,
  type OwnedLock,
} from "../../engine/lockfile.js";
import {
  withRepositoryRecoveryFence,
  type RepositoryProtocolFenceRequest,
} from "../sync-git/protocol-locks.js";
import {
  inspectResetFenceInventory,
  settleStandingResetUnderHeldFence,
  type ResetFenceObservation,
} from "../reset-journal.js";
import {
  assertHealthyOwnedSyncMutex,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import { loadConfigIfPresent, syncStreamId } from "../workspace-config.js";
import { stateLockPath, statePath } from "./paths.js";

const heldStatePlaneLocks: unique symbol = Symbol("held-state-plane-locks");

export interface HeldStatePlaneLocks {
  readonly mutex: WorkspaceSyncMutex;
  readonly stateLock: OwnedLock;
  readonly underRepositoryFence: true;
  readonly [heldStatePlaneLocks]: true;
}

export interface StatePlaneLockOptions {
  readonly attempts?: number;
  readonly onStage?: (stage: StatePlaneLockStage) => void | Promise<void>;
}

export type StatePlaneLockStage =
  | "mutex"
  | "inventory"
  | "fence"
  | "state-lock"
  | "fenced-recheck"
  | "reset-recovery"
  | "body";

export class StateLockAcquisitionError extends Error {
  constructor(readonly outcome: Exclude<LockAcquireResult, { status: "acquired" }>) {
    super(`state-plane locks refused: the sync state lock is unavailable (${outcome.status})`);
    this.name = "StateLockAcquisitionError";
  }
}

interface RepositoryRequest extends RepositoryProtocolFenceRequest {
  readonly relPath: string;
  readonly identityHash: string;
}

interface Inventory {
  readonly requests: readonly RepositoryRequest[];
  readonly stream: string | undefined;
  readonly resetSettlement: "none" | "required";
  readonly resetObservation: ResetFenceObservation;
}

const inventoryFingerprint = (inventory: Inventory): string => JSON.stringify([
  inventory.requests.map((request) => [
    request.relPath,
    request.commonDir,
    request.identityHash,
    [...request.reflogRefs ?? []],
    request.origins === true,
  ]),
  inventory.stream ?? null,
  inventory.resetSettlement,
]);

async function inspectResetInventory(root: string): Promise<Inventory> {
  const config = await loadConfigIfPresent(root).catch(() => undefined);
  const stream = config ? syncStreamId(config) : undefined;
  const reset = await inspectResetFenceInventory(root, stream);
  const requests = reset.requests.map((request) => {
    const relPath = `reset:${request.commonDir}`;
    return { relPath, ...request, identityHash: relPath };
  }).sort((a, b) => a.relPath < b.relPath ? -1 : 1);
  return {
    requests,
    stream,
    resetSettlement: reset.settlement,
    resetObservation: reset.observation,
  };
}

async function completeStandingReset(
  root: string,
  inventory: Inventory,
  stateLock: OwnedLock,
): Promise<boolean> {
  if (inventory.resetSettlement === "none") return false;
  if (!inventory.stream) {
    throw new Error("state-plane locks refused: reset recovery needs the durable config stream");
  }
  await settleStandingResetUnderHeldFence(
    root,
    inventory.stream,
    inventory.resetObservation,
    stateLock,
  );
  return true;
}

type LockAttempt<T> =
  | { readonly restart: true }
  | { readonly restart: false; readonly value: T };

async function runLockAttempt<T>(
  root: string,
  mutex: WorkspaceSyncMutex,
  fn: (locks: HeldStatePlaneLocks) => Promise<T>,
  options: StatePlaneLockOptions,
): Promise<LockAttempt<T>> {
  await assertHealthyOwnedSyncMutex(mutex, root);
  await options.onStage?.("mutex");
  const inventory = await inspectResetInventory(root);
  await options.onStage?.("inventory");
  return withRepositoryRecoveryFence(
    inventory.requests,
    path.resolve(statePath(root)),
    async () => {
      await options.onStage?.("fence");
      const acquired = await acquireLock(stateLockPath(root));
      if (acquired.status !== "acquired") throw new StateLockAcquisitionError(acquired);
      const stateLock = acquired.lock;
      try {
        await options.onStage?.("state-lock");
        const current = await inspectResetInventory(root);
        if (inventoryFingerprint(current) !== inventoryFingerprint(inventory)) {
          return { restart: true };
        }
        await options.onStage?.("fenced-recheck");
        if (await completeStandingReset(root, inventory, stateLock)) {
          return { restart: true };
        }
        await options.onStage?.("reset-recovery");
        if (!await stateLock.isOwner()) {
          throw new Error("state-plane locks refused: state lock ownership was lost");
        }
        await options.onStage?.("body");
        const locks = {
          mutex,
          stateLock,
          underRepositoryFence: true,
          [heldStatePlaneLocks]: true,
        } satisfies HeldStatePlaneLocks;
        return { restart: false, value: await fn(locks) };
      } finally {
        await stateLock.release();
      }
    },
  );
}

export async function withGenesisAdmissionLocks<T>(
  root: string,
  heldMutex: WorkspaceSyncMutex,
  fn: (locks: HeldStatePlaneLocks) => Promise<T>,
  options: StatePlaneLockOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; ; attempt += 1) {
    const result = await runLockAttempt(root, heldMutex, fn, options);
    if (!result.restart) return result.value;
    if (attempt >= attempts) {
      throw new Error(
        `state-plane locks refused: the workspace kept changing under the fence (${attempts} attempts)`,
      );
    }
  }
}
