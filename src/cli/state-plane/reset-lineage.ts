/**
 * The two reset-derived facts every state backend's read path must honour.
 *
 * Neither is JSON-specific and neither is SQLite-specific, so they live beside
 * the adapters rather than inside one of them: the compatibility selector
 * (design 222 §1.2 A-2) and the legacy JSON store call the same implementation,
 * which is what makes "shared reset recovery and reset-lineage provenance" one
 * behaviour instead of two that drift.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { inspectResetFenceInventory, settleStandingReset } from "../reset-journal.js";
import {
  acquireWorkspaceSyncMutex,
  assertSyncMutex,
  releaseWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type WorkspaceSyncMutex,
} from "../sync-mutex.js";
import type { SyncState } from "../sync-state-model.js";
import { RBOX_DIR } from "../workspace-config.js";

/**
 * Recover a standing reset journal before any state read. `recoverResetJournal`
 * dispatches to the SQLite reset plane itself once `Q` is authority, so this is
 * backend-neutral all the way down.
 *
 * The gate is the journal's PRESENCE, never its contents. Decoding it here
 * would decide the format twice, and the legacy decoder throws outright on a
 * `sqlite/v1` journal — the only kind a `Q` workspace can have — so a decode
 * gate turns "recover this reset" into a hard read error on exactly the
 * workspaces this recovery exists for. Format dispatch belongs to
 * `recoverResetJournal`, which classifies the authority first.
 *
 * Returns whether a standing reset was settled: a recovery replaces the lineage,
 * so it invalidates any retained sync state (design 277 §A2).
 */
export async function recoverStandingResetJournal(
  root: string,
  stream: string,
  heldMutex?: WorkspaceSyncMutex,
): Promise<boolean> {
  if ((await inspectResetFenceInventory(root, stream)).settlement === "none") return false;
  let recoveryMutex = heldMutex;
  let releaseRecoveryMutex = false;
  if (!recoveryMutex) {
    recoveryMutex = await acquireWorkspaceSyncMutex(root, "cli");
    releaseRecoveryMutex = true;
  }
  assertSyncMutex(recoveryMutex, root);
  if (workspaceSyncMutexDegraded(recoveryMutex)) throw new Error("reset journal recovery requires a non-degraded workspace fence");
  try {
    await settleStandingReset(root, recoveryMutex, stream);
    return true;
  } finally {
    if (releaseRecoveryMutex) await releaseWorkspaceSyncMutex(recoveryMutex);
  }
}

const streamMismatchFreshStates = new WeakSet<SyncState>();

/** True when this exact loaded state came from a rebind/freshening rather than
 * true genesis. */
export const stateWasStreamMismatch = (state: SyncState): boolean => streamMismatchFreshStates.has(state);

/**
 * reset-v1's hash-addressed old-lineage archive is durable evidence that a seq-0
 * state came from rebind/freshening rather than true genesis. Re-mark every load
 * so daemon preflight and direct pushManifest callers cannot lose the provenance
 * merely by reloading the atomically installed next state.
 */
export async function markResetLineageProvenance(root: string, state: SyncState): Promise<SyncState> {
  if (state.lastSyncedSequence === 0 && await hasResetLineageArchive(root)) streamMismatchFreshStates.add(state);
  return state;
}

/**
 * Read-path provenance is deliberately tolerant of unrelated legacy-directory
 * entries. Reset operations use the strict namespace inventory; ordinary state
 * loads have always ignored names they do not understand.
 */
async function hasResetLineageArchive(root: string): Promise<boolean> {
  const archiveRoot = path.join(root, RBOX_DIR, "state", "lineages");
  const lineages = await readDirectory(archiveRoot);
  for (const lineage of lineages) {
    if (!lineage.isDirectory() || !/^[0-9a-f]{32}$/.test(lineage.name)) continue;
    const archives = await readDirectory(path.join(archiveRoot, lineage.name));
    if (archives.some((entry) => entry.isFile() && /^[0-9a-f]{64}\.(?:json|db)$/.test(entry.name))) return true;
  }
  return false;
}

async function readDirectory(directory: string) {
  return fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  });
}
