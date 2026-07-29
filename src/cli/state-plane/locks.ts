import type { OwnedLock } from "../../engine/git/lockfile.js";
import type { WorkspaceSyncMutex } from "../sync-mutex.js";

/**
 * Proof that the complete state-plane lock set is held right now (design 222
 * §3.1). The repository fence is callback-scoped, so this is a witness of what
 * is held rather than a set of handles — a value only `withStatePlaneLocks` can
 * mint, which is what makes it unforgeable at the type level.
 */
export interface HeldStatePlaneLocks {
  readonly mutex: WorkspaceSyncMutex;
  readonly stateLock: OwnedLock;
  readonly underRepositoryFence: true;
}
