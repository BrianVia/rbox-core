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
  materializeManifestFromStore,
} from "./adapters/read-only.js";
export { applySavePacketToStore } from "./adapters/sqlite-state-save.js";
export { publishStateBackup, type StateBackupOptions, type StateBackupResult } from "./backup/publish.js";
export { beginGeneration, collectUnreferencedEntryValues, type GenerationBuilder } from "./store/generations.js";
export {
  openSealedStage,
  verifySourceStageBinding,
  type SealedStageRef,
  type SealedStageReader,
} from "./store/sealed-stages.js";
export {
  beginRepoTransitionStage,
  openSealedRepoTransitionStage,
  type RepoTransitionStageBuilder,
  type SealedRepoTransitionRef,
  type SealedTransitionReader,
  type TransitionEvidenceBindings,
  type TransitionInput,
  type TransitionRow,
} from "./store/transition-stages.js";
export { buildCasRetryView } from "./store/cas-retry-view.js";
export { applyCasPacket, ensureTelemetryBindingId, type CasExpectation, type CasPacket } from "./store/write-packet.js";
export { applyLocalScan, invalidateLocalPlane, type LocalScanResult } from "./store/local-plane.js";
export { StageLock } from "./store/stage-artifacts.js";
export { STAGE_GIT_ROLES, type StageCounts, type StageLogicalDigest } from "./digest/stage-semantic-v1.js";
export { type RepoTransitionDigest, type SourceStageBinding } from "./digest/repo-transition-v1.js";
