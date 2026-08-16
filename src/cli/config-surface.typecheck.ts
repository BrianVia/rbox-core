import * as barrel from "./config.js";
import * as resetState from "./reset-state.js";
import * as model from "./sync-state-model.js";
import * as records from "./sync-state-records.js";
import * as store from "./sync-state-store.js";
import * as workspace from "./workspace-config.js";
import type {
  ConfigStoreIdentity,
  FileOnlyManifest,
  GitDeferral,
  GitDeferralReason,
  GitDeferrals,
  GitHeldAttempt,
  GitPartialApply,
  GitResolutionBinding,
  GitResolutionLaneDisposition,
  GitResolutionPublicationReceipt,
  GlobalManifestMeta,
  RepoRecord,
  RepoRecordInput,
  RepoTransition,
  ResetSyncStateHooks,
  StateSaveOptions,
  StateSavePacket,
  StateSaveResult,
  SyncState,
  TypedBlocker,
  WorkspaceConfig,
} from "./config.js";
// @ts-expect-error The SQLite substrate must not regain an expected-stream policy wrapper.
import type { StateStoreReadAdapters } from "./state-plane/ports.js";
import * as stateStoreFacade from "./state-plane/store-facade.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type AssertNever<T extends never> = T;
type _RemovedSqlitePolicyValuesStayAbsent = AssertNever<Extract<
  keyof typeof stateStoreFacade,
  "loadStateFromStore" | "readOnlyAdapters"
>>;

type OwnerValues =
  & Pick<typeof workspace,
    | "RBOX_DIR"
    | "WorkspaceConfigNotFoundError"
    | "findRoot"
    | "loadConfig"
    | "loadConfigIfPresent"
    | "saveConfig"
    | "syncStreamId"
    | "trashConfig">
  & Pick<typeof model,
    | "DEFERRAL_LANES"
    | "manifestFromMeta"
    | "validManifestMeta">
  & Pick<typeof records,
    | "MAX_LEGACY_GIT_SIDECAR_REPOS"
    | "expectedStateNonce"
    | "repoRecordsForState"
    | "stateFromRepoRecords">
  & Pick<typeof store,
    | "StreamMismatchError"
    | "applyStateSavePacket"
    | "ensureCapableStateLineage"
    | "ensureTelemetryBindingId"
    | "loadRawState"
    | "loadState"
    | "saveState"
    | "saveStateUnsafeLegacyOrTest"
    | "stateLockPath"
    | "statePath"
    | "stateWasStreamMismatch">
  & Pick<typeof resetState, "resetSyncState">;

type _ValueKeysAreExact = Assert<Equal<keyof typeof barrel, keyof OwnerValues>>;
type _BarrelValuesMatchOwners = Assert<typeof barrel extends OwnerValues ? true : false>;
type _OwnerValuesMatchBarrel = Assert<OwnerValues extends typeof barrel ? true : false>;
type _WorkspaceConfig = Assert<Equal<WorkspaceConfig, workspace.WorkspaceConfig>>;
type _SyncState = Assert<Equal<SyncState, model.SyncState>>;
type _GlobalManifestMeta = Assert<Equal<GlobalManifestMeta, model.GlobalManifestMeta>>;
type _ConfigStoreIdentity = Assert<Equal<ConfigStoreIdentity, model.ConfigStoreIdentity>>;
type _GitDeferralReason = Assert<Equal<GitDeferralReason, model.GitDeferralReason>>;
type _GitDeferral = Assert<Equal<GitDeferral, model.GitDeferral>>;
type _GitDeferrals = Assert<Equal<GitDeferrals, model.GitDeferrals>>;
type _GitPartialApply = Assert<Equal<GitPartialApply, model.GitPartialApply>>;
type _TypedBlocker = Assert<Equal<TypedBlocker, model.TypedBlocker>>;
type _GitHeldAttempt = Assert<Equal<GitHeldAttempt, model.GitHeldAttempt>>;
type _GitResolutionLaneDisposition = Assert<Equal<GitResolutionLaneDisposition, model.GitResolutionLaneDisposition>>;
type _GitResolutionBinding = Assert<Equal<GitResolutionBinding, model.GitResolutionBinding>>;
type _GitResolutionPublicationReceipt = Assert<Equal<GitResolutionPublicationReceipt, model.GitResolutionPublicationReceipt>>;
type _RepoRecord = Assert<Equal<RepoRecord, model.RepoRecord>>;
type _RepoRecordInput = Assert<Equal<RepoRecordInput, model.RepoRecordInput>>;
type _RepoTransition = Assert<Equal<RepoTransition, model.RepoTransition>>;
type _FileOnlyManifest = Assert<Equal<FileOnlyManifest, model.FileOnlyManifest>>;
type _StateSavePacket = Assert<Equal<StateSavePacket, model.StateSavePacket>>;
type _StateSaveResult = Assert<Equal<StateSaveResult, model.StateSaveResult>>;
type _StateSaveOptions = Assert<Equal<StateSaveOptions, model.StateSaveOptions>>;
type _ResetSyncStateHooks = Assert<Equal<ResetSyncStateHooks, resetState.ResetSyncStateHooks>>;

export {};
