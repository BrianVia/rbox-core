export type { FileEntry, FileType, Manifest, GitSection } from "./types.js";
export { gitPreflight, gitIdentity, captureGitState, applyGitState, preserveGitConflict, validateGitSection, isSyncableRef, gitIdentityKey, type ApplyGitResult } from "./git-state.js";
export { generateKek, kekToPhrase, kekFromPhrase, encryptFileToTemp, decryptFileToPath, type EncryptedBlob } from "./crypto.js";
export { hashFile, hashBytes } from "./hash.js";
export { BUILTIN_IGNORE, HARD_PRUNE_DIRS, buildIgnoreMatcher, effectiveIgnoreRules, type IgnoreMatcher, type IgnoreRule } from "./ignore.js";
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
