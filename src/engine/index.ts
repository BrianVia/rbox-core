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
  type ApplyGitResult,
  type GitIdentity,
  type GitRepoKind,
  type GitPreflightResult,
  type RepoCtx,
} from "./git-state.js";
export { discoverGitRepos, type DiscoveredGitRepo } from "./git-discover.js";
export { generateKek, kekToPhrase, kekFromPhrase, encryptFileToTemp, decryptFileToPath, type EncryptedBlob } from "./crypto.js";
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
export { scanManifest, applyWatchEvents, type WatchEvent, type WatchEventKind } from "./manifest.js";
export { diffManifests, indexByPath, sameContent, type ManifestDiff } from "./diff.js";
export { LocalBlobStore, type BlobStore } from "./blobstore.js";
export { reconcile, conflictName, type Action } from "./reconcile.js";
export { applyActions, restoreEntryToPath, uploadManifestBlobs } from "./apply.js";
export { poolMap } from "./pool.js";
export { PhaseReport, type PhaseName, type PhaseTotals, type PhaseBytes, type PhaseReportJson } from "./phase-report.js";
export { HashCache, type HashCacheEntry } from "./hashcache.js";
export { writeFileAtomic, RBOX_TMP_PREFIX } from "./fsutil.js";
export {
  validateManifest,
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
