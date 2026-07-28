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
import type { OwnedLock } from "../../../engine/git/lockfile.js";
import { assertStatePublishable } from "../authority-marker.js";
import { StateWriteRefusedError } from "../errors.js";
import { ensureStateReserve } from "../migration/reserve.js";
import { recordLastWriterWitness } from "../migration/last-writer-witness.js";

/**
 * Publish `body` as the whole state document at `file`. `lock` is the state lock
 * held continuously across the check and the rename; `undefined` means the
 * filesystem offers no lock primitive at all, which is the only condition under
 * which an unlocked publication is authorized.
 *
 * `beforeRename` is the sole publication-abort seam `writeFileAtomic` exposes,
 * so both the barrier read and the lease re-assertion live there: a marker or a
 * stolen lease aborts before the rename rather than racing it.
 */
export async function publishWholeState(file: string, body: string, lock: OwnedLock | undefined): Promise<void> {
  let leaseHeld = true;
  await writeFileAtomic(file, body, {
    beforeRename: async () => {
      await assertStatePublishable(file, { locked: lock !== undefined });
      if (!lock) return true;
      leaseHeld = await lock.isOwner();
      return leaseHeld;
    },
  });
  if (!leaseHeld) throw new StateWriteRefusedError("state-lock-lease-lost", file);
  await fsyncDirectory(path.dirname(file));
}

/**
 * Post-publication obligations of every barrier-era writer: record the witness
 * for the bytes just published, and make sure the migration reserve exists.
 * Neither may fail a state write that is already durable.
 */
export async function afterStatePublication(root: string, file: string, stream: string, body: string): Promise<void> {
  await recordLastWriterWitness(root, file, body);
  if (typeof stream === "string" && stream.length > 0) {
    await ensureStateReserve(root, stream).catch(() => undefined);
  }
}
