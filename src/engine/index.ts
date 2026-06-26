export type { FileEntry, FileType, Manifest } from "./types.js";
export { hashFile, hashBytes } from "./hash.js";
export { BUILTIN_IGNORE, buildIgnoreMatcher, type IgnoreMatcher } from "./ignore.js";
export { scanManifest } from "./manifest.js";
export { diffManifests, indexByPath, sameContent, type ManifestDiff } from "./diff.js";
export { LocalBlobStore, type BlobStore } from "./blobstore.js";
export { reconcile, conflictName, type Action } from "./reconcile.js";
export { applyActions, uploadManifestBlobs } from "./apply.js";
