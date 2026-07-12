export type { FileEntry, FileType, Manifest, GitSection, GitRefScope, GitArtifactRef, GitPackLink } from "./types.js";
export {
  gitPreflight,
  gitIdentity,
  captureGitState,
  normalizeSymbolicHeadCasing,
  decideDirBundleAllArgs,
  gitCaptureScratchRoot,
  sweepStaleGitCaptureDirs,
  applyGitState,
  GitCaptureDeferredError,
  preserveGitConflict,
  gitSectionBlobRefs,
  gitSectionNewestLink,
  gitSectionPackLinks,
  gitSectionTips,
  validateGitSection,
  isSyncableRef,
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
  type ApplyGitResult,
  type GitIdentity,
  type GitChainTimings,
  type GitRepoKind,
  type GitPreflightResult,
  type RepoCtx,
} from "./git-state.js";
export { discoverGitRepos, type DiscoveredGitRepo } from "./git-discover.js";
export {
  generateKek,
  kekToPhrase,
  kekFromPhrase,
  encryptFileToTemp,
  decryptFileToPath,
  isSourceChangedError,
  zstdCompress,
  zstdDecompressCapped,
  type EncryptedBlob,
  type EncryptFileOptions,
} from "./crypto.js";
export { readManifestChain } from "./manifest-chain.js";
export {
  MANIFEST_ENVELOPE_MAGIC,
  MANIFEST_ENVELOPE_PREFIX,
  MAX_ENVELOPE_HEADER,
  MAX_MANIFEST_PLAINTEXT,
  MAX_MANIFEST_DELTA_CHAIN,
  ManifestChainError,
  canonicalManifestBytes,
  canonicalManifestHash,
  canonicalManifestHashStreaming,
  encodeSnapshotEnvelope,
  diffToOps,
  encodeDeltaEnvelope,
  decodeEnvelope,
  hasEnvelopePrefix,
  foldDelta,
  type ManifestDeltaHeader,
  type ManifestDeltaOp,
  type DecodedManifestEnvelope,
} from "./manifest-delta.js";
export { cryptoPoolStatus, withCryptoPool, type CryptoPoolStatus, type CryptoPool, type CoalescedBlob } from "./crypto-pool.js";
export { hashFile, hashBytes } from "./hash.js";
export {
  BUILTIN_IGNORE,
  HARD_PRUNE_DIRS,
  nativePruneGlobs,
  buildIgnoreMatcher,
  effectiveIgnoreRules,
  isIgnoreRuleFile,
  type BuildIgnoreMatcherOptions,
  type IgnoreMatcher,
  type IgnoreRule,
} from "./ignore.js";
export { scanManifest, createScanStats, applyWatchEvents, statsStableAcrossHash, type ScanStats, type DirProbeSample, type DirProbeSink, type WatchEvent, type WatchEventKind } from "./manifest.js";
export { diffManifests, indexByPath, sameContent, type ManifestDiff } from "./diff.js";
export { LocalBlobStore, type BlobStore } from "./blobstore.js";
export { reconcile, conflictName, type Action } from "./reconcile.js";
export { applyActions,
  laneTimingSummary, restoreEntryToPath, uploadManifestBlobs } from "./apply.js";
export {
  applyStatsDelta, applyStatsEnabled, setApplyStatsEnabled, snapshotApplyStats,
  type ApplyStats,
} from "./apply-stats.js";
export { poolMap } from "./pool.js";
export { PhaseReport, type PhaseName, type PhaseTotals, type PhaseBytes, type PhaseReportJson } from "./phase-report.js";
export { HashCache, type HashCacheEntry } from "./hashcache.js";
export {
  DirCache,
  RACY_MARGIN_MS,
  UNPRUNED_DEADLINE_MS,
  coverageOf,
  dirListingReusable,
  scanPruneEnabled,
  type ChildType,
  type DirCacheChild,
  type DirCacheEntry,
  type DirCacheFile,
  type DircacheOutcome,
  type RuleFileRecord,
} from "./dircache.js";
export {
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  ENCRYPT_ADDRESS_CACHE_REL,
  type EncryptAddressCacheContext,
  type EncryptAddressCacheEntry,
} from "./encrypt-address-cache.js";
export { writeFileAtomic, RBOX_TMP_PREFIX } from "./fsutil.js";
export {
  validateManifest,
  manifestRequiresSchema4,
  isSafeRelPath,
  type ValidationResult,
  MAX_PATH_BYTES,
  MAX_ENTRIES,
  MAX_MANIFEST_BYTES,
  MAX_SYMLINK_TARGET_BYTES,
  KNOWN_MANIFEST_SCHEMA,
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
  type Ecosystem,
} from "./detect.js";
export {
  evaluateReadiness,
  parseMajor,
  minMajor,
  satisfiesMajor,
  type HostTool,
  type ProjectProbe,
  type ProjectReadiness,
  type ReadinessReport,
  type VersionRequirement,
} from "./doctor.js";
