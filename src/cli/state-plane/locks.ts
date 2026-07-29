import type { OwnedLock } from "../../engine/git/lockfile.js";
import type { WorkspaceSyncMutex } from "../sync-mutex.js";

/**
 * Proof that the complete state-plane lock set is held right now (design 222
 * §3.1). The repository fence is callback-scoped, so this is a witness of what
 * is held rather than a set of handles. It is a plain interface today and is
 * therefore structurally constructible; wave 2B, which adds
 * `withStatePlaneLocks`, is what makes it mintable only there.
 */
export interface HeldStatePlaneLocks {
  readonly mutex: WorkspaceSyncMutex;
  readonly stateLock: OwnedLock;
  readonly underRepositoryFence: true;
}
