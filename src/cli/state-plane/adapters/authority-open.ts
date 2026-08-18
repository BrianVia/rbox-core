/**
 * One owner for "reach the selected SQLite authority": routing selection,
 * genesis admission under a held mutex, the held-lock write fence, and the open
 * that proves the database is the one the marker names.
 *
 * The store and the authority coordinator are reached through DYNAMIC imports:
 * the CLI's eager static graph must stay free of `bun:sqlite`
 * (`schema/inventory.test.ts`).
 *
 * NOTHING HERE OPENS A DATABASE IT HAS NOT PROVEN IT OWNS (163 v13). Selection
 * and every refusal are decided from file-level facts — the marker's exact bytes
 * and the SQLite header `store/open.ts` reads before connecting — so a workspace
 * a caller refuses is byte-identical afterwards, sidecars included.
 */
import type { WorkspaceSyncMutex } from "../../sync-mutex.js";
import { StateAuthorityCorruptError, StateStoreOpenError } from "../errors.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import type { StateStoreHandle } from "../store/open.js";
import type { StoreFacade } from "./cas-translation.js";

/** `.rbox/state.json` carries `Q`, and this is the database it names. */
export interface SqliteAuthority { authorityId: string; file: string }

export const sqliteAuthority = (
  root: string,
  selection: { readonly authorityId: string },
): SqliteAuthority => ({ authorityId: selection.authorityId, file: sqliteResetPaths.active(root) });

export function translateStoreOpenError<T>(file: string, read: () => T): T {
  try { return read(); } catch (error) {
    if (error instanceof StateStoreOpenError) throw new StateAuthorityCorruptError(file, `${error.reason}: ${error.message}`);
    throw error;
  }
}

export async function selectAuthority(root: string, heldMutex?: WorkspaceSyncMutex) {
  const coordinator = await import("../authority-bootstrap.js");
  if (!heldMutex) return coordinator.observeStateAuthority(root);
  return coordinator.requireSelected(await coordinator.admitGenesisAuthority(root, heldMutex));
}

/**
 * Everything a writer must do after it takes `<state>.lock` and before it opens
 * anything: clear the write fence, then re-read the marker UNDER the lock. The
 * pre-lock selection only routed, and the authority may have flipped while this
 * call waited. One function, so the three held-lock writers cannot drift.
 */
export async function fencedAuthorityUnderHeldLock(root: string): Promise<SqliteAuthority> {
  const [coordinator, fence] = await Promise.all([
    import("../authority-bootstrap.js"),
    import("../state-write-fence.js"),
  ]);
  fence.assertAuthorityWritable(root);
  const selection = await coordinator.observeStateAuthority(root);
  if (selection.kind !== "sqlite-store") {
    throw new StateAuthorityCorruptError(statePath(root), "the authority marker disappeared under the held state lock");
  }
  return sqliteAuthority(root, selection);
}

export async function openAuthorityStore(authority: SqliteAuthority, readonly: boolean): Promise<{ store: StateStoreHandle; facade: StoreFacade }> {
  const facade = await import("../store-facade.js");
  // Absent, foreign, malformed, or wrong-schema are all zero-write authority
  // contradictions rather than backend-specific open failures.
  const store = translateStoreOpenError(authority.file, () => facade.openStateStore(authority.file, { readonly }));
  if (store.header.authority_id !== authority.authorityId) {
    store.close();
    throw new StateAuthorityCorruptError(
      authority.file,
      `the database carries authority ${store.header.authority_id}, the marker names ${authority.authorityId}`,
    );
  }
  return { store, facade };
}
