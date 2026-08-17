export type { FileEntry, FileType, Manifest, GitSection, GitRefScope, GitRefTombstone, GitArtifactRef, GitPackLink } from "./types.js";
export { isSyncableRef, validateGitSection } from "./manifest-validate.js";
export { discoverGitRepos, discoverGitReposUnder, type DiscoveredGitRepo } from "./git-discover.js";
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
export { cryptoPoolStatus, shutdownCryptoPool, withCryptoPool, type CryptoPoolStatus, type CryptoPool } from "./crypto-pool/pool.js";
export type { CoalescedBlob } from "./crypto-pool/budget.js";
export { hashFile, hashBytes } from "./hash.js";
export {
  ALWAYS_NATIVE_PRUNE,
  BUILTIN_IGNORE,
  GIT_REF_SIGNAL_TAIL_TABLE,
  HARD_PRUNE_DIRS,
  isGitRefSignal,
  isGitRefSignalTail,
  nativePruneGlobs,
  nativePruneCoverageComplete,
  buildIgnoreMatcher,
  effectiveIgnoreRules,
  isIgnoreRuleFile,
  type BuildIgnoreMatcherOptions,
  type IgnoreMatcher,
  type IgnoreRule,
} from "./ignore.js";
export { scanManifest, createScanStats, applyWatchEvents, compareManifestPaths, statsStableAcrossHash, isPresentButUnreadableError, type ScanStats, type ScanTimingStats, type ScanResidualBuckets, type ScanAttemptStats, type DirProbeSample, type DirProbeSink, type WatchEvent, type WatchEventKind } from "./manifest.js";
export { diffManifests, indexByPath, sameContent, type ManifestDiff } from "./diff.js";
export { LocalBlobStore, type BlobStore } from "./blobstore.js";
export { reconcile, type Action } from "./reconcile.js";
export { conflictName, countConflictCopies } from "./conflict-name.js";
export {
  conservativeReceiverEquivalentPath,
  oracleFromPull,
  oracleFromState,
  probeReceiverEquivalence,
  receiverEquivalentCollisionNames,
  receiverEquivalentPath,
  setReceiverEquivalenceProbeForTests,
  type AppliedManifestOracle,
  type OracleVerdict,
  type ReceiverEquivalence,
  type ReceiverEquivalenceProbe,
} from "./apply-receipt.js";
export { applyActions, actionPath,
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
  validateGitRepos,
  validateRefTombstones,
  manifestRequiresSchema4,
  isSafeRelPath,
  caseFoldCollisionGroups,
  manifestPathCaseFold,
  type ValidationResult,
  type CaseFoldCollisionGroup,
  MAX_PATH_BYTES,
  MAX_ENTRIES,
  MAX_MANIFEST_BYTES,
  MAX_SYMLINK_TARGET_BYTES,
  KNOWN_MANIFEST_SCHEMA,
  MAX_PACK_CHAIN,
  MAX_GIT_REPOS,
  MAX_REF_TOMBSTONES_PER_REF,
  MAX_REF_TOMBSTONES_PER_REPO,
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
export {
  abortGeneration,
  candidateRef,
  discardGeneration,
  inspectOwner,
  publishGeneration,
  registerWorker,
  replaceInternedEntry,
  withCipherDescriptor,
  withGenerationOwnerScope,
  workerRequest,
  EntryArena,
  GenerationOwnerCapabilityError,
  OwnerReentrancyError,
  GenerationReplacementConflict,
  PublishedGeneration,
  WorkerLifecycleError,
  type CipherDescriptor,
  type EntryLease,
  type EntryVersionToken,
  type GenerationMutationToken,
  type GenerationOwnerLease,
  type GenerationOwnerScope,
  type OwnedEntryRef,
  type PublishedGenerationToken,
  type WorkerEntryRequest,
  type WorkerRegistration,
  type WorkerReplacementResult,
} from "./entry-arena/index.js";
export { EntryStructureError } from "./entry-arena/index.js";
