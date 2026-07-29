/**
 * The live-window proof that the database `Q` elects is this workspace's own.
 *
 * After the flip — `m6-cleanup`, `m7`, and `terminal-sqlite`, whatever halt the
 * control carries — the store has been in ordinary use and its bytes change on
 * every save. Physical `{bytes, sha256}` is therefore a snapshot of a moment, not
 * identity. 163's `C` is *exact application/schema/authority/completion
 * evidence*, and those properties survive writes: `validateOpen` establishes the
 * application, schema, frozen DDL, and the `migration_completion` singleton bound
 * to `store_meta.authority_id`; this module adds the two bindings that tie the
 * store to THIS workspace's marker and THIS migration.
 *
 * The open is an OWNING open, and it must be `openStateStoreForWalTakeover`
 * specifically. `openStateStore`'s header gate reads page 1 of the main file
 * before taking recovery, which is exactly the page a pending `-wal` supersedes,
 * so it can gate on superseded values. The takeover open recovers first — which
 * is also the only way an abandoned or foreign `-wal` carrying committed frames
 * is seen at all — and its close checkpoints and removes the sidecars.
 *
 * (Residue is no longer the discriminator between the two: since #590 both leave
 * none, because `openStateStore`'s `readonly` is a handle-level advisory flag and
 * its connection is opened `readwrite`, so its close checkpoints too.)
 */
import { StateAuthorityCorruptError } from "../errors.js";
import { openStateStoreForWalTakeover, stateStoreDatabase } from "../store/open.js";

export function proveActiveStore(
  markerFile: string,
  activeFile: string,
  authorityId: string,
  migrationId: string | undefined,
): void {
  const refuse = (detail: string): never => {
    throw new StateAuthorityCorruptError(markerFile, detail);
  };
  let handle;
  try {
    handle = openStateStoreForWalTakeover(activeFile);
  } catch (cause) {
    return refuse(`${activeFile} is not a readable rbox state database (${(cause as { reason?: string }).reason ?? String(cause)})`);
  }
  try {
    if (handle.header.authority_id !== authorityId) {
      refuse("the state database carries a different authority than the marker names");
    }
    if (migrationId !== undefined) {
      const row = stateStoreDatabase(handle)
        .query("SELECT migration_id FROM migration_completion WHERE singleton=1")
        .get() as { migration_id?: string } | null;
      if (row?.migration_id !== migrationId) refuse("the state database was not published by this migration");
    }
  } finally {
    handle.close();
  }
}
