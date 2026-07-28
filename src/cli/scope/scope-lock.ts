/**
 * The one writer of a scope transition (design 212 §3.3).
 *
 * Every hazard the review found in this transaction was two edits interleaving on
 * a shared cursor: the intent slot, the intent's phase, the maintenance token. One
 * exclusive lock held for the whole transition removes the class rather than each
 * instance. It is deliberately NOT the workspace sync mutex — the daemon holds that
 * for entire sync cycles, and the park exists precisely so the transition can take
 * it uncontended. This lock is contended only by other scope edits and their
 * recovery, so waiting on it costs nothing anyone can feel.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock } from "../../engine/git/lockfile.js";

export class ScopeEditInProgressError extends Error {
  constructor() {
    super("another change to the folders this machine syncs is in progress — re-run this in a moment");
    this.name = "ScopeEditInProgressError";
  }
}

export const scopeTransitionLockPath = (root: string): string =>
  path.join(root, ".rbox", "state", "scope-transition.lock");

const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 25;

export async function withScopeTransitionLock<T>(
  root: string,
  body: () => Promise<T>,
  waitMs = DEFAULT_WAIT_MS,
): Promise<T> {
  const lockPath = scopeTransitionLockPath(root);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    const acquired = await acquireLock(lockPath);
    if (acquired.status === "acquired") {
      try {
        return await body();
      } finally {
        await acquired.lock.release();
      }
    }
    // No safe lock here means no safe single writer. Scope edits move and delete
    // files, so this fails closed rather than degrading to an unlocked path.
    if (acquired.status === "unsupported" || acquired.status === "error") {
      throw new Error(`cannot lock scope edits on this filesystem: ${String(acquired.error)}`);
    }
    if (Date.now() >= deadline) throw new ScopeEditInProgressError();
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
}
