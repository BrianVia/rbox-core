export type { FileEntry, FileType, Manifest, GitSection } from "./types.js";
export { gitPreflight, gitIdentity, captureGitState, applyGitState, preserveGitConflict, validateGitSection, isSyncableRef, gitIdentityKey, type ApplyGitResult } from "./git-state.js";
export { hashFile, hashBytes } from "./hash.js";
export { BUILTIN_IGNORE, buildIgnoreMatcher, effectiveIgnoreRules, type IgnoreMatcher, type IgnoreRule } from "./ignore.js";
export { scanManifest, applyWatchEvents, type WatchEvent, type WatchEventKind } from "./manifest.js";
export { diffManifests, indexByPath, sameContent, type ManifestDiff } from "./diff.js";
export { LocalBlobStore, type BlobStore } from "./blobstore.js";
export { reconcile, conflictName, type Action } from "./reconcile.js";
export { applyActions, uploadManifestBlobs } from "./apply.js";
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
