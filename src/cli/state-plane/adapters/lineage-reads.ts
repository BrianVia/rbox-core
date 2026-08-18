/**
 * The O(1) lineage identity read (design 277). It answers the daemon's
 * boundary fence — "is this still the stream and state nonce I bound to?" —
 * without materializing every file and repository behind that answer.
 *
 * Legacy JSON has no header to read cheaply, so it falls back to its ordinary
 * raw read; parity for a dying path is not worth a JSON token scheme.
 */
import type { SyncState } from "../../sync-state-model.js";
import { openAuthorityStore, selectAuthority, sqliteAuthority } from "./authority-open.js";
import { loadRawLegacyJsonState } from "./legacy-json-store.js";

/** The lineage identity a boundary fence compares. `undefined` means no
 * authority is selected, exactly as a raw whole-state read reports it. */
export async function loadRawStateIdentity(root: string): Promise<Pick<SyncState, "stream" | "stateNonce"> | undefined> {
  const selection = await selectAuthority(root);
  if (selection.kind === "uninitialized") return undefined;
  if (selection.kind === "legacy-json-store") return loadRawLegacyJsonState(root);
  const { store, facade } = await openAuthorityStore(sqliteAuthority(root, selection), true);
  try {
    const token = facade.readStateFreshnessFromStore(store);
    return token.stateNonce === undefined ? { stream: token.stream } : { stream: token.stream, stateNonce: token.stateNonce };
  } finally {
    store.close();
  }
}
