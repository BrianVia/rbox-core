/** Sealed file/Git stage refs, their verification, and their bounded cursors.
 *
 * A ref is never believed: every field of it — plane, header, counts, logical
 * digest — is recomputed from the rows a consumer will actually read, so a
 * crash-resumed stage is never trusted from its `sealed` bit or its stored digest
 * column. The verified sealed header is part of the ref, which is what makes it
 * the header that later commits to authority. */
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { decodeFileEntry, encodeFileEntry, type EncodedFileEntry } from "../codecs/file-entry.js";
import { decodeGitSection } from "../codecs/git-section.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { StageDigestBuilder, type StageCounts, type StageLogicalDigest } from "../digest/stage-semantic-v1.js";
import { CursorWindowError, GitSectionOversizeError, StageChangedError } from "../errors.js";
import type { CursorPage, GitSectionRole, ManifestHeader, Plane } from "../ports.js";
import {
  StageLock, openSealedArtifact, type SealedArtifactAccessor,
} from "./stage-artifacts.js";
import { selectRow, streamRows } from "./statements.js";

export const PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_FILE_BATCH = 512;
export const MAX_GIT_BATCH = 16;

export interface SealedStageRef {
  stageId: string;
  plane: Plane;
  /** The header this stage was SEALED with. `stage-semantic-v1` covers it, and it
   * is the only header a promotion may commit. */
  header: ManifestHeader;
  logicalDigest: StageLogicalDigest;
  physicalSha256: string;
  bytes: number;
  counts: StageCounts;
}

export interface SealedStageReader {
  /** The header the artifact itself carries, read back during verification. */
  readonly sealedHeader: ManifestHeader;
  files(afterPath: string | undefined, batchSize: number): CursorPage<FileEntry>;
  gitRepoCursor(role: GitSectionRole, afterRelPath: string | undefined, batchSize: number): CursorPage<{ relPath: string; section: GitSection }>;
  gitRepo(role: GitSectionRole, relPath: string): GitSection | undefined;
  /** Row-at-a-time canonical stream. The only interface the CAS copy uses. */
  streamFiles(visit: (encoded: EncodedFileEntry) => void): number;
  close(): void;
}

/** Verify and open one sealed stage under its own id-scoped lock. The caller owns
 * the lock for the whole consumption interval and releases it after `close()`. */
export function openSealedStage(directory: string, ref: SealedStageRef, lock: StageLock): SealedStageReader {
  const accessor = openSealedArtifact(directory, ref, lock);
  let derived: SealedStageRef;
  try {
    derived = deriveStageRef(accessor, ref.stageId, ref.physicalSha256, ref.bytes);
    if (canonicalJson(derived) !== canonicalJson(ref)) {
      throw new StageChangedError(ref.stageId, "sealed stage identity does not match its ref");
    }
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    throw error;
  }
  return new SqliteSealedStage(accessor, ref, derived.header);
}

function deriveStageRef(
  accessor: SealedArtifactAccessor,
  stageId: string,
  physicalSha256: string,
  bytes: number,
): SealedStageRef {
  const meta = selectRow<{
    stage_id: string; plane: Plane; state: string; header_cjson: string; digest: string; counts_cjson: string;
  }>(accessor.db, "SELECT stage_id,plane,state,header_cjson,digest,counts_cjson FROM stage_meta");
  if (!meta) throw new StageChangedError(stageId, "sealed stage has no stage_meta row");
  if (meta.stage_id !== stageId || meta.state !== "sealed") {
    throw new StageChangedError(stageId, "sealed stage identity does not match its ref");
  }
  const header = parseCanonicalJson(meta.header_cjson) as unknown as ManifestHeader;
  const digest = new StageDigestBuilder(meta.stage_id, meta.plane, header as unknown as Record<string, unknown>);
  streamRows<{ entry_cjson: string }>(
    accessor.db, "SELECT entry_cjson FROM stage_entries WHERE stage_id=? ORDER BY path_order",
    [stageId], (row) => digest.file(row.entry_cjson));
  streamRows<{ role: GitSectionRole }>(
    accessor.db, "SELECT role FROM stage_git_roles WHERE stage_id=? ORDER BY role",
    [stageId], (row) => digest.declareRole(row.role));
  streamRows<{ role: GitSectionRole; rel_path: string; section_cjson: string }>(
    accessor.db, `SELECT role,rel_path,section_cjson FROM stage_git_sections
      WHERE stage_id=? ORDER BY role,path_order`,
    [stageId], (row) => digest.gitSection(row.role, row.rel_path, row.section_cjson));
  const counts = digest.counts;
  const logicalDigest = digest.seal(parseCanonicalJson(meta.counts_cjson) as unknown as StageCounts);
  if (meta.digest !== logicalDigest) throw new StageChangedError(stageId, "sealed stage digest column is stale");
  return { stageId, plane: meta.plane, header, logicalDigest, physicalSha256, bytes, counts };
}

/**
 * Reverify one source-stage binding end to end. A stage named only as Git evidence
 * still gets the full physical + logical proof even though its rows are not
 * recopied, and the derived ref is returned so a caller can compare it to the ref
 * it believes it is consuming.
 */
export function verifySourceStageBinding(
  directory: string,
  binding: { stageId: string; logicalDigest: string; physicalSha256: string },
): SealedStageRef {
  const lock = StageLock.acquire(directory, binding.stageId);
  try {
    const accessor = openSealedArtifact(directory, binding, lock);
    let derived: SealedStageRef;
    try {
      derived = deriveStageRef(accessor, binding.stageId, binding.physicalSha256, accessor.bytes);
      if (derived.logicalDigest !== binding.logicalDigest) {
        throw new StageChangedError(binding.stageId, "source stage logical digest does not match its binding");
      }
    } finally {
      accessor.close();
    }
    return derived;
  } finally {
    lock.release();
  }
}

/**
 * Accumulate a page while streaming. The byte ceiling is applied BEFORE the next
 * row is admitted, so a page never materializes more than the ceiling plus the one
 * row that is allowed to exceed it alone.
 */
export function boundedStream<Row, Out>(
  scan: (visit: (row: Row) => boolean | void) => void,
  batchSize: number,
  measure: (row: Row) => number,
  admit: (row: Row) => Out,
  key: (row: Row) => string,
): CursorPage<Out> {
  const rows: Out[] = [];
  let used = 0;
  let last: string | undefined;
  let yielded = 0;
  let stoppedOnBytes = false;
  scan((row) => {
    const bytes = measure(row);
    if (rows.length > 0 && used + bytes > PAGE_BYTES) {
      stoppedOnBytes = true;
      return false;
    }
    yielded++;
    rows.push(admit(row));
    used += bytes;
    last = key(row);
    return true;
  });
  return {
    rows,
    done: !stoppedOnBytes && yielded < batchSize,
    ...(last === undefined ? {} : { after: last }),
  };
}

function assertWindow(kind: "file" | "git", batchSize: number, maximum: number): void {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > maximum) {
    throw new CursorWindowError(kind, batchSize, maximum);
  }
}

class SqliteSealedStage implements SealedStageReader {
  constructor(
    private readonly accessor: SealedArtifactAccessor,
    private readonly ref: SealedStageRef,
    readonly sealedHeader: ManifestHeader,
  ) {}

  files(afterPath: string | undefined, batchSize: number): CursorPage<FileEntry> {
    assertWindow("file", batchSize, MAX_FILE_BATCH);
    const after = afterPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterPath);
    let encoded: EncodedFileEntry | undefined;
    return boundedStream<{ path: string; entry_cjson: string }, FileEntry>(
      (visit) => streamRows(this.accessor.db, `SELECT path,entry_cjson FROM stage_entries
        WHERE stage_id=? AND path_order>? ORDER BY path_order LIMIT ?`,
      [this.ref.stageId, after, batchSize], visit),
      batchSize,
      (row) => {
        encoded = encodeFileEntry(parseCanonicalJson(row.entry_cjson) as unknown as FileEntry);
        return encoded.retainedEstimate;
      },
      () => decodeStageEntry(encoded!),
      (row) => row.path,
    );
  }

  gitRepoCursor(role: GitSectionRole, afterRelPath: string | undefined, batchSize: number) {
    assertWindow("git", batchSize, MAX_GIT_BATCH);
    const after = afterRelPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterRelPath);
    return boundedStream<{ rel_path: string; section_cjson: string }, { relPath: string; section: GitSection }>(
      (visit) => streamRows(this.accessor.db, `SELECT rel_path,section_cjson FROM stage_git_sections
        WHERE stage_id=? AND role=? AND path_order>? ORDER BY path_order LIMIT ?`,
      [this.ref.stageId, role, after, batchSize], visit),
      batchSize,
      (row) => {
        const bytes = Buffer.byteLength(row.section_cjson) + Buffer.byteLength(row.rel_path);
        if (bytes > PAGE_BYTES) throw new GitSectionOversizeError(row.rel_path, bytes);
        return bytes;
      },
      (row) => ({ relPath: row.rel_path, section: this.#decodeSealedSection(row.rel_path, row.section_cjson) }),
      (row) => row.rel_path,
    );
  }

  gitRepo(role: GitSectionRole, relPath: string): GitSection | undefined {
    const row = selectRow<{ section_cjson: string }>(this.accessor.db,
      "SELECT section_cjson FROM stage_git_sections WHERE stage_id=? AND role=? AND rel_path=?",
      this.ref.stageId, role, relPath);
    return row ? this.#decodeSealedSection(relPath, row.section_cjson) : undefined;
  }

  /** A sealed row that no longer decodes to an admissible section is a mutated or
   * corrupt sealed stage — the same class as every other verification failure
   * here, so it fails as a `StageChangedError`, never a bare parse throw. */
  #decodeSealedSection(relPath: string, sectionCjson: string): GitSection {
    try {
      return decodeGitSection(relPath, sectionCjson);
    } catch (cause) {
      throw new StageChangedError(this.ref.stageId, `git section ${relPath} is not a canonical admissible section: ${String(cause)}`);
    }
  }

  streamFiles(visit: (encoded: EncodedFileEntry) => void): number {
    return streamRows<{ entry_cjson: string }>(
      this.accessor.db, "SELECT entry_cjson FROM stage_entries WHERE stage_id=? ORDER BY path_order",
      [this.ref.stageId], (row) => visit(encodeFileEntry(parseCanonicalJson(row.entry_cjson) as unknown as FileEntry)));
  }

  close(): void {
    this.accessor.close();
  }
}

function decodeStageEntry(encoded: EncodedFileEntry): FileEntry {
  return decodeFileEntry({
    path: encoded.path, sha256: encoded.sha256, size: encoded.size, mode: encoded.mode,
    mtime_ms: encoded.mtimeMs, kind: encoded.kind, symlink_target: encoded.symlinkTarget,
    enc_sha: encoded.encSha, comp: encoded.comp, payload_sha: encoded.payloadSha,
    cipher_size: encoded.cipherSize, extras_cjson: encoded.extrasCjson,
    canonical_bytes: encoded.canonicalBytes, retained_estimate: encoded.retainedEstimate,
  });
}
