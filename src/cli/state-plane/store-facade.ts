/** Explicit SQLite-owned state-store subpath.
 *
 * Production JSON state code imports `state-plane/index`, whose graph must
 * remain free of bun:sqlite until the U3 cutover.
 */
export {
  createStateStore,
  checkpointStateStoreForReset,
  closeOwnedStateStoreReadersForReset,
  openStateStore,
  openStateStoreForWalTakeover,
  ownedStateStoreWriterForReset,
  type ResetCheckpointResult,
  StateStoreHandle,
  stateStoreDatabase,
  type StorePragmas,
} from "./store/open.js";
export { openReadSnapshot } from "./store/read-snapshot.js";
export { stateSemanticDigest } from "./digest/state-semantic-v1.js";
export {
  loadRawStateFromStore,
  loadStateFromStore,
  materializeManifestFromStore,
  readOnlyAdapters,
} from "./adapters/read-only.js";
export { publishStateBackup, type StateBackupOptions, type StateBackupResult } from "./backup/publish.js";
