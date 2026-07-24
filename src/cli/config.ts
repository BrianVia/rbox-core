export {
  RBOX_DIR,
  WorkspaceConfigNotFoundError,
  findRoot,
  loadConfig,
  loadConfigIfPresent,
  saveConfig,
  syncStreamId,
  trashConfig,
  type WorkspaceConfig,
} from "./workspace-config.js";

export {
  DEFERRAL_LANES,
  MAX_LEGACY_GIT_SIDECAR_REPOS,
  expectedStateNonce,
  manifestFromMeta,
  repoRecordsForState,
  stateFromRepoRecords,
  validManifestMeta,
  type ConfigShapeIdentity,
  type FileOnlyManifest,
  type GitDeferral,
  type GitDeferralReason,
  type GitDeferrals,
  type GitHeldAttempt,
  type GitPartialApply,
  type GitResolutionBinding,
  type GitResolutionLaneDisposition,
  type GitResolutionPublicationReceipt,
  type GlobalManifestMeta,
  type RepoRecord,
  type RepoRecordInput,
  type RepoTransition,
  type StateSaveOptions,
  type StateSavePacket,
  type StateSaveResult,
  type SyncState,
  type TypedBlocker,
} from "./sync-state-model.js";

export {
  StreamMismatchError,
  applyStateSavePacket,
  ensureCapableStateLineage,
  ensureTelemetryBindingId,
  loadRawState,
  loadState,
  saveState,
  saveStateUnsafeLegacyOrTest,
  stateLockPath,
  statePath,
  stateWasStreamMismatch,
} from "./sync-state-store.js";

export {
  resetSyncState,
  type ResetSyncStateHooks,
} from "./reset-state.js";
