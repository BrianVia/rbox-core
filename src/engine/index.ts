export type { FileEntry, Manifest, GitSection, GitRefScope, GitPackLink } from "./types.js";
export {
  gitPreflight,
  gitIdentity,
  captureGitState,
  applyGitState,
  GitCaptureDeferredError,
  preserveGitConflict,
  gitSectionBlobRefs,
  gitSectionNewestLink,
  gitSectionTips,
  validateGitSection,
  gitIdentityKey,
  projectIdentity,
  assertGitTargetWithinRoot,
  isGitBusy,
  quarantineAndWipeGitState,
  inTreeWorktreeParentRel,
  inTreeWorktreeParentRelFromCtx,
  repoCtxFromDisk,
  setGitSpawnObserver,
  zeroGitChainTimings,
  type GitIdentity,
  type GitChainTimings,
  type GitRepoKind,
  type GitPreflightResult,
  type RepoCtx,
} from "./git-state.js";
export { discoverGitRepos, type DiscoveredGitRepo } from "./git-discover.js";
export {
  generateKek,
  encryptFileToTemp,
  isSourceChangedError,
  type EncryptedBlob,
  type EncryptFileOptions,
} from "./crypto.js";
export { readManifestChain } from "./manifest-chain.js";
export {
  MAX_MANIFEST_DELTA_CHAIN,
  ManifestChainError,
  canonicalManifestHash,
  canonicalManifestHashStreaming,
  encodeSnapshotEnvelope,
  encodeDeltaEnvelope,
  decodeEnvelope,
  hasEnvelopePrefix,
  foldDelta,
} from "./manifest-delta.js";
export { cryptoPoolStatus, shutdownCryptoPool, withCryptoPool, type CryptoPool, type CoalescedBlob } from "./crypto-pool.js";
export { hashFile, hashBytes } from "./hash.js";
export {
  nativePruneGlobs,
  buildIgnoreMatcher,
  effectiveIgnoreRules,
  isIgnoreRuleFile,
  type IgnoreMatcher,
} from "./ignore.js";
export { scanManifest, createScanStats, applyWatchEvents, statsStableAcrossHash, isPresentButUnreadableError, type ScanStats, type DirProbeSample, type DirProbeSink, type WatchEvent, type WatchEventKind } from "./manifest.js";
export { diffManifests } from "./diff.js";
export { LocalBlobStore, type BlobStore } from "./blobstore.js";
export { reconcile, type Action } from "./reconcile.js";
export {
  oracleFromPull,
  oracleFromState,
  probeReceiverEquivalence,
  receiverEquivalentCollisionNames,
  receiverEquivalentPath,
  setReceiverEquivalenceProbeForTests,
  type AppliedManifestOracle,
} from "./apply-receipt.js";
export { applyActions,
  laneTimingSummary, restoreEntryToPath } from "./apply.js";
export {
  applyStatsDelta, setApplyStatsEnabled, snapshotApplyStats,
  type ApplyStats,
} from "./apply-stats.js";
export { poolMap } from "./pool.js";
export { PhaseReport } from "./phase-report.js";
export { HashCache } from "./hashcache.js";
export {
  DirCache,
  RACY_MARGIN_MS,
  UNPRUNED_DEADLINE_MS,
  coverageOf,
  dirListingReusable,
  scanPruneEnabled,
} from "./dircache.js";
export {
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  ENCRYPT_ADDRESS_CACHE_REL,
  type EncryptAddressCacheContext,
} from "./encrypt-address-cache.js";
export { writeFileAtomic } from "./fsutil.js";
export { indexIdentityV2 } from "./git/index-identity.js";
export {
  incomingOwnershipRoots,
  partitionOwnedByIncoming,
  tipOwnedByIncoming,
  noDropProof,
  enumerateStashReflogOids,
} from "./git/reachability.js";
export {
  writeCheckoutJournal,
  markCheckoutJournalPublished,
  clearCheckoutJournal,
  recoverJournal,
  type CheckoutJournalBinding,
  type CheckoutJournal,
} from "./git/journal.js";
export {
  commitCheckout,
  checkoutTransactionCapability,
  checkoutTransactionSupported,
  resetCheckoutCapabilityProbeCacheForTests,
  ORIG_HEAD_CHANGED_AT_CHECKOUT_BOUNDARY,
  type CheckoutRefUpdate,
  type CheckoutCapabilityProbe,
  type CheckoutTransactionCapability,
} from "./git/checkout-txn.js";
export {
  validateManifest,
  validateGitRepos,
  manifestRequiresSchema4,
  isSafeRelPath,
  MAX_PACK_CHAIN,
  MAX_GIT_REPOS,
} from "./manifest-validate.js";
export {
  detectProjects,
  hydrateArgv,
  ECOSYSTEM_RULES,
  type DetectedProject,
  type DetectHints,
  type EcosystemRule,
} from "./detect.js";
export {
  evaluateReadiness,
  type HostTool,
  type ProjectProbe,
  type VersionRequirement,
} from "./doctor.js";
