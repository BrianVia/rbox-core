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
}

/** A point-in-time snapshot of a tree's syncable files, sorted by `path`. */
export interface Manifest {
  generatedAt: string;
  files: FileEntry[];
}
