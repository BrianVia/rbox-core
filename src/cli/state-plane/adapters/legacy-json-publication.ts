/**
 * The barrier-era publication seam for `.rbox/state.json` (design 163, unit B0).
 *
 * This is where the two obligations the barrier adds — check the format
 * immediately before the rename, record the last-writer witness immediately
 * after it — are written once instead of per writer. The two transactional CAS
 * writers still publish inline, because a lost lease is a typed *result* for
 * them rather than a throw; the pinning inventory test is what holds every
 * writer, inline or not, to both obligations.
 */
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../../../engine/fsutil.js";
import type { OwnedLock } from "../../../engine/lockfile.js";
import { assertStatePublishable } from "../authority-marker.js";
import { StateWriteRefusedError } from "../errors.js";
import { ensureStateReserve } from "../reserve.js";
import { recordLastWriterWitness } from "../last-writer-witness.js";

/**
 * Publish `body` as the whole state document at `file`. `lock` is the state lock
 * held continuously across the check and the rename; `undefined` means the
 * filesystem offers no lock primitive at all, which is the only condition under
 * which an unlocked publication is authorized.
 *
 * The asynchronous slot owns the barrier read and early lease check; the
 * syscall-adjacent synchronous slot re-asserts the lease with no await before
 * rename. A marker or stolen lease therefore aborts publication.
 */
export async function publishWholeState(file: string, body: string, lock: OwnedLock | undefined): Promise<void> {
  if (lock && path.resolve(lock.path) !== path.resolve(`${file}.lock`)) {
    throw new StateWriteRefusedError("state-lock-unavailable", file, "held lock has the wrong canonical path");
  }
  let leaseHeld = true;
  await writeFileAtomic(file, body, {
    beforeRename: async () => {
      await assertStatePublishable(file, { locked: lock !== undefined });
      if (!lock) return true;
      leaseHeld = await lock.isOwner();
      return leaseHeld;
    },
    beforeRenameSync: lock
      ? () => {
          if (!lock.isOwnerSync()) throw new StateWriteRefusedError("state-lock-lease-lost", file);
        }
      : undefined,
  });
  if (!leaseHeld) throw new StateWriteRefusedError("state-lock-lease-lost", file);
  await fsyncDirectory(path.dirname(file));
}

/**
 * Post-publication obligations of every barrier-era writer: record the witness
 * for the bytes just published, and make sure the state reserve exists.
 * Neither may fail a state write that is already durable.
 */
export async function afterStatePublication(
  root: string,
  file: string,
  // `SyncState.stream` is declared required, but a legacy document decoded from
  // disk can lack it entirely, and a streamless state is pinned behaviour
  // (telemetry/sync-state.test.ts T14). The reserve is stream-scoped, so such a
  // state simply has none.
  stream: string | undefined,
  body: string,
  heldLock?: OwnedLock,
): Promise<void> {
  await recordLastWriterWitness(root, file, body, Date.now, heldLock);
  if (stream !== undefined && stream.length > 0) {
    await ensureStateReserve(root, stream).catch(() => undefined);
  }
}
