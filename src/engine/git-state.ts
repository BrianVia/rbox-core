// Barrel for the git-state feature (design 02 v3 + §28 + design 43). The implementation
// lives in ./git/* — split along its natural seams (shared primitives, refs/op-state,
// scratch pinning, preflight, identity, capture, apply, quarantine, containment) — but the
// import surface stays exactly here so no consumer (engine/index.ts, cli/sync.ts,
// cli/daemon.ts, the git test suites) has to change.

// Re-exported for compat: these moved to manifest-validate.ts (pure — validateManifest
// validates gitRepos values, and manifest-validate must stay node:*-free for the Worker).
export { isSyncableRef, validateGitSection, validateRefTombstones } from "./manifest-validate.js";

export type { GitBusyInspection, GitBusyLock, GitBusySharedInspection, GitRepoKind, RepoCtx } from "./git/shared.js";
export { gitSectionBlobRefs, gitSectionNewestLink, gitSectionPackLinks, gitSectionTips, inTreeWorktreeParentRel, inTreeWorktreeParentRelFromCtx, inspectGitBusy, inspectGitBusyShared, repoCtxFromDisk, setGitSpawnObserver } from "./git/shared.js";
export type { GitChainTimings } from "./git/chain-timings.js";
export { finalizeGitChainTimings, zeroGitChainTimings } from "./git/chain-timings.js";
export { gitPreflight, gitRefStorage, isGitBusy, type GitPreflightResult } from "./git/preflight.js";
export { gitIdentity, gitIdentityKey, projectIdentity, type GitIdentity } from "./git/identity.js";
export {
  captureGitState,
  normalizeSymbolicHeadCasing,
  decideDirBundleAllArgs,
  gitCaptureScratchRoot,
  sweepStaleGitCaptureDirs,
  GitCaptureDeferredError,
} from "./git/capture.js";
export { readSyncableRefSurface } from "./git/refs.js";
export type { OwnedRefMutationBoundary, OwnedRefMutationLease } from "./git/pins.js";
export { applyGitState, type ApplyGitResult, type ApplyBranchTransitionInput, type ApplyBranchTransitionResult, type ApplyBranchTransitionAdapter } from "./git/apply.js";
export { quarantineAndWipeGitState, preserveGitConflict } from "./git/quarantine.js";
export { assertGitTargetWithinRoot } from "./git/containment.js";
export {
  validateRepoIdentityV1,
  encodeRepoIdentityV1,
  repositoryIdentityHash,
  readRepoIdentityV1,
  encodeStateLineageV1,
  readStateLineageV1,
  stateLineageV1FromRealRoot,
  lineageHash,
  artifactBinding,
  bindingForContext,
  repositoryIdentityForContext,
  type RepoIdentityV1,
  type StateLineageV1,
  type ArtifactBinding,
} from "./git/repo-lineage.js";
export {
  BASE_ABSENT_PREFIX,
  BASE_PRESENT_PREFIX,
  BASE_PRESENT_KEEP_PREFIX,
  SETTLED_ABSENCE_PREFIX,
  MAX_UNSETTLED_BASE_ABSENT,
  MAX_BASE_PRESENT,
  MAX_BASE_PRESENT_KEEP,
  branchRefHash,
  baseAbsentArtifactRef,
  basePresentArtifactRef,
  basePresentKeepRef,
  settledAbsenceRef,
  baseAbsentPayload,
  basePresentPayload,
  assertBaseArtifactCapacity,
  prepareBaseAbsentArtifact,
  prepareBasePresentArtifact,
  readBaseAbsentArtifact,
  readBaseAbsentArtifactRef,
  inspectBaseAbsentArtifactRef,
  readBasePresentArtifact,
  readBasePresentArtifactRef,
  inspectBasePresentArtifactRef,
  buildSettledAbsenceTree,
  readSettledAbsence,
  lookupSettledAbsence,
  prepareSettleBaseAbsent,
  prepareRetireSettledAbsence,
  settleBaseAbsentArtifact,
  commitProtocolRefTransaction,
  type BaseAbsentPayload,
  type BasePresentPayload,
  type SettledAbsenceMeta,
  type PreparedProtocolRef,
  type PreparedBasePresent,
  type ArtifactInvalidReason,
  type ArtifactReadResult,
  type SettledAbsenceLedger,
  type SettledAbsenceReadResult,
  type PreparedSettledAbsence,
  type PreparedSettledAbsenceRetirement,
} from "./git/base-artifacts.js";
export { scanBaseArtifacts, type BaseArtifactScan, type ForeignBaseArtifactScanEntry } from "./git/base-artifact-scan.js";
export {
  PROTOCOL_LOCK_ORDER,
  heldProtocolLocks,
  assertProtocolLockHeld,
  setProtocolLockTraceForTests,
  withProtocolLockClass,
  withPostHeadCompatibilityException,
  withCommonDirOperationLocks,
  withRepoOperationLock,
  reflogMaintenanceLockPath,
  withReflogMaintenanceLocks,
  withKeepOriginsLock,
  withRepoProtocolLocks,
  withRepositoryRecoveryFence,
  type ProtocolLockClass,
  type ProtocolLockTraceEvent,
  type RepositoryProtocolFenceRequest,
} from "./git/protocol-locks.js";
