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
  readonly path: string;
  /** Lowercase hex SHA-256 of the file bytes (of the link target string, for symlinks). */
  readonly sha256: string;
  /** Byte length of the content. */
  readonly size: number;
  /** Unix permission bits (`& 0o777`). Carried so the executable bit survives a sync. */
  readonly mode: number;
  /** Local mtime in ms. Fast-path hint only — NOT part of content identity. */
  readonly mtimeMs: number;
  readonly type: FileType;
  /** For `type: "symlink"`, the raw link target. */
  readonly symlinkTarget?: string;
  /** Ciphertext content-address (M5, encrypted workspaces): where the encrypted
   *  body is stored. `sha256` stays the PLAINTEXT identity (dedup/reconcile key);
   *  this is the address of the AES-GCM ciphertext in R2. Absent = plaintext blob. */
  readonly encSha?: string;
  /** Payload compression applied before encryption (design 79). Absent = raw. */
  readonly comp?: "zstd";
  /** sha256 of the compressed payload (the exact encrypted bytes) — the key/nonce
   *  derivation input for compressed blobs. Present iff `comp` is. */
  readonly payloadSha?: string;
  /** Ciphertext byte length (payload + GCM tag). Present iff `comp` is — used as
   *  the download size hint since `size` no longer predicts it. */
  readonly cipherSize?: number;
}

/**
 * Git repository state, synced as ONE indivisible unit (M2), separate from the
 * working-tree `files`. History rides a `git bundle` (consistent on a live repo);
 * index/HEAD/op-state are atomic single-file captures. Artifacts are content-
 * addressed blobs, never materialized in the working tree. Absent when the repo
 * is ineligible (not opt-in / unsupported layout) or empty (no commits).
 */
/** §28 — a git artifact stored as an E2EE blob: `encSha` is the ciphertext address (what the
 *  server stores + what's charged/GC-rooted via blobRefs), `sha` is the plaintext content id
 *  (decrypt-verify + the stable identity input), `cipherSize` is the ciphertext byte length
 *  (upload size + the advisory blobRef size — NEVER the plaintext size, which would leak ≈repo
 *  size). All three ride INSIDE the E2EE-encrypted manifest, so none is server-visible plaintext. */
export interface GitArtifactRef {
  sha: string;
  encSha: string;
  cipherSize: number;
  comp?: "zstd";
  payloadSha?: string;
}

export interface GitPackLink extends GitArtifactRef {
  /** Commit tips made reachable by this historical bundle link. */
  tips: string[];
}

/** Which ref semantics a {@link GitSection} carries (design 43 §2 [v2, B1]).
 *  "all"    — the section's refs are the repo's COMPLETE syncable ref set (dir-repo
 *             capture; design-02 semantics: apply may delete absent refs).
 *  "scoped" — the section carries only HEAD's line of work (pointer-repo capture);
 *             apply must ONLY update the listed refs, NEVER delete others. */
export type GitRefScope = "all" | "scoped";

/** A publisher-authored record of one superseded advertised branch value (design 130). */
export interface GitRefTombstone {
  oid: string;
  ts: string;
  generation: number;
}

export interface GitSection {
  /** plaintext sha of the `git bundle` (all refs + stash + a temp ref making index blobs reachable). */
  bundleSha: string;
  /** ciphertext address of the encrypted bundle blob (stored + charged). */
  bundleEncSha: string;
  /** ciphertext byte length of the bundle (upload size + advisory blobRef size). */
  bundleCipherSize: number;
  bundleComp?: "zstd";
  bundlePayloadSha?: string;
  /** Ancestor bundle links, ordered base → older increments → previous increment. */
  packChain?: GitPackLink[];
  /** HEAD file contents — "ref: refs/heads/x" or a detached 40-hex sha. */
  head: string;
  /** refname → commit sha for every published ref (identity + receiver publish set). */
  refs: Record<string, string>;
  /** Bounded per-branch history of values this publisher previously advertised and
   * subsequently superseded. Absent means a pre-design-130/old-writer section. */
  refTombstones?: Record<string, GitRefTombstone[]>;
  /** Repository-wide monotonic high-water mark for tombstone supersession events. */
  refTombstoneGeneration?: number;
  /** plaintext sha of the `.git/index` blob (staging) for exact restore, if present. */
  indexSha?: string;
  /** ciphertext address + size of the encrypted index blob (present iff indexSha is). */
  indexEncSha?: string;
  indexCipherSize?: number;
  indexComp?: "zstd";
  indexPayloadSha?: string;
  /** `git write-tree` sha of the staging — a STABLE content identity (the raw index
   *  file hash is not: git refreshes its stat info). Used for change-detection. */
  indexTree?: string;
  /** op-state file path (relative to .git) → artifact ref: MERGE_HEAD, REBASE_HEAD, rebase-merge/**, etc. */
  opState?: Record<string, GitArtifactRef>;
  /** Allowlisted common `.git/config` values (design 93). Present only when the
   * sender captured an owned dir repo. Absent means unsupported/carried;
   * `{}` means supported with no allowlisted keys. */
  config?: Record<string, string[]>;
  /** Ref semantics of this section (design 43 §2): stamped "all" for dir-repo captures,
   *  "scoped" for pointer-repo (worktree/submodule) captures. Gates apply-side ref
   *  deletion and identity projection (§7). */
  refScope: GitRefScope;
  generatedAt: string;
  /** The device that CAPTURED this section (design 274 D1). Absent means the author
   *  is unknown — an old writer, a carried pre-274 section, or a local id outside
   *  the wire shape — and every reader degrades to unnamed copy. Never an identity
   *  input: it is excluded from every key/fingerprint by construction. */
  deviceId?: string;
}

/** A point-in-time snapshot of a tree's syncable files, sorted by `path`. */
export interface Manifest {
  generatedAt: string;
  files: readonly FileEntry[];
  /** Manifest schema version. Absent (v1) = pre-§43. `gitRepos` requires >= 2.
   *  Clients refuse schemas newer than KNOWN_MANIFEST_SCHEMA ("upgrade rbox") so
   *  every future schema break fails loudly (design 43 §2). */
  manifestSchema?: number;
  /** POSIX relPath of each git repo dir inside the tree (sync root = ".") → its git
   *  state (design 43 §2). Replaces the pre-§43 single `git` section — legacy
   *  manifests carrying `git` are REFUSED (clean break, validated loudly). */
  gitRepos?: Record<string, GitSection>;
}
