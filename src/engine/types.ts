export type FileType = "file" | "symlink";

/**
 * One entry in a {@link Manifest}. Identity is the content hash, never mtime —
 * mtime is carried only as a local fast-path to skip re-hashing unchanged files
 * (see `scanManifest`), and is deliberately excluded from equality so a touched
 * file doesn't read as changed. (files-sdk's `sync` makes the same call: the
 * destination restamps mtime, so comparing it re-syncs everything every run.)
 */
export interface FileEntry {
  /** POSIX-relative path from the sync root. Never absolute, never contains `..`. */
  path: string;
  /** Lowercase hex SHA-256 of the file bytes (of the link target string, for symlinks). */
  sha256: string;
  /** Byte length of the content. */
  size: number;
  /** Unix permission bits (`& 0o777`). Carried so the executable bit survives a sync. */
  mode: number;
  /** Local mtime in ms. Fast-path hint only — NOT part of content identity. */
  mtimeMs: number;
  type: FileType;
  /** For `type: "symlink"`, the raw link target. */
  symlinkTarget?: string;
  /** Ciphertext content-address (M5, encrypted workspaces): where the encrypted
   *  body is stored. `sha256` stays the PLAINTEXT identity (dedup/reconcile key);
   *  this is the address of the AES-GCM ciphertext in R2. Absent = plaintext blob. */
  encSha?: string;
}

/**
 * Git repository state, synced as ONE indivisible unit (M2), separate from the
 * working-tree `files`. History rides a `git bundle` (consistent on a live repo);
 * index/HEAD/op-state are atomic single-file captures. Artifacts are content-
 * addressed blobs, never materialized in the working tree. Absent when the repo
 * is ineligible (not opt-in / unsupported layout) or empty (no commits).
 */
export interface GitSection {
  /** sha of the `git bundle` blob (all refs + stash + a temp ref making index blobs reachable). */
  bundleSha: string;
  /** sha of the bundle blob's byte length, for streaming upload. */
  bundleSize: number;
  /** HEAD file contents — "ref: refs/heads/x" or a detached 40-hex sha. */
  head: string;
  /** refname → commit sha for every published ref (identity + receiver publish set). */
  refs: Record<string, string>;
  /** sha of the `.git/index` blob (staging) for exact restore, if present. */
  indexSha?: string;
  /** `git write-tree` sha of the staging — a STABLE content identity (the raw index
   *  file hash is not: git refreshes its stat info). Used for change-detection. */
  indexTree?: string;
  /** op-state file path (relative to .git) → blob sha: MERGE_HEAD, REBASE_HEAD, rebase-merge/**, etc. */
  opState?: Record<string, string>;
  generatedAt: string;
}

/** A point-in-time snapshot of a tree's syncable files, sorted by `path`. */
export interface Manifest {
  generatedAt: string;
  files: FileEntry[];
  /** Present only when git-state sync is enabled and the repo is eligible (M2). */
  git?: GitSection;
}
