/** Sealed file/Git stage refs, their verification, and their bounded cursors.
 *
 * A ref is never believed: every field of it — plane, header, counts, logical
 * digest — is recomputed from the rows a consumer will actually read, so a
 * crash-resumed stage is never trusted from its `sealed` bit or its stored digest
 * column. The verified sealed header is part of the ref, which is what makes it
 * the header that later commits to authority. */
import type { FileEntry, GitSection } from "../../../engine/index.js";
import type { JsonObject, JsonValue } from "../../../json.js";
import {
  decodeFileEntry, encodeFileEntry, encodeFileEntryForConsume,
  type ConsumedFileEntry, type EncodedFileEntry,
} from "../codecs/file-entry.js";
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
  close(): void;
}

/** Consumption's one interface: a single canonical pass that both yields the rows
 * and proves the artifact, verified at end-of-stream. */
export interface ConsumedStageReader {
  readonly sealedHeader: ManifestHeader;
  streamFiles(visit: (encoded: ConsumedFileEntry) => void): number;
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

/** A sealed stage's own metadata, read without scanning a single row. */
interface SealedStageMeta {
  plane: Plane;
  header: ManifestHeader;
  counts: StageCounts;
  digest: string;
}

function readSealedStageMeta(accessor: SealedArtifactAccessor, stageId: string): SealedStageMeta {
  const meta = selectRow<{
    stage_id: string; plane: Plane; state: string; header_cjson: string; digest: string; counts_cjson: string;
  }>(accessor.db, "SELECT stage_id,plane,state,header_cjson,digest,counts_cjson FROM stage_meta");
  if (!meta) throw new StageChangedError(stageId, "sealed stage has no stage_meta row");
  if (meta.stage_id !== stageId || meta.state !== "sealed") {
    throw new StageChangedError(stageId, "sealed stage identity does not match its ref");
  }
  return {
    plane: meta.plane,
    header: decodeSealedHeader(stageId, meta.header_cjson),
    counts: decodeSealedCounts(stageId, meta.counts_cjson),
    digest: meta.digest,
  };
}

function deriveStageRef(
  accessor: SealedArtifactAccessor,
  stageId: string,
  physicalSha256: string,
  bytes: number,
): SealedStageRef {
  const meta = readSealedStageMeta(accessor, stageId);
  const header = meta.header;
  const digest = new StageDigestBuilder(stageId, meta.plane, header);
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
  const logicalDigest = digest.seal(meta.counts);
  if (meta.digest !== logicalDigest) throw new StageChangedError(stageId, "sealed stage digest column is stale");
  return { stageId, plane: meta.plane, header, logicalDigest, physicalSha256, bytes, counts };
}

/** The one container test every persisted-bytes decode in this seam shares. */
function jsonObject(value: JsonValue): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/**
 * The persisted spelling of a sealed stage's own metadata. `stage-semantic-v1`
 * already binds these exact bytes, so `stage_meta` that no longer decodes to the
 * required members of its type is a mutated sealed stage — the same class as
 * every other verification failure here. The parsed value itself is returned, so
 * members these rules cannot see ride along exactly as they were sealed.
 */
function isManifestHeader(value: JsonValue): value is JsonObject & ManifestHeader {
  const object = jsonObject(value);
  return object !== undefined
    && typeof object.generatedAt === "string" && typeof object.complete === "boolean";
}

function decodeSealedHeader(stageId: string, text: string): ManifestHeader {
  const value = parseCanonicalJson(text);
  if (!isManifestHeader(value)) {
    throw new StageChangedError(stageId, "sealed stage header is not a manifest header");
  }
  return value;
}

function isStageCounts(value: JsonValue): value is JsonObject & StageCounts {
  const object = jsonObject(value);
  return object !== undefined
    && typeof object.files === "number" && typeof object.gitSections === "number";
}

function decodeSealedCounts(stageId: string, text: string): StageCounts {
  const value = parseCanonicalJson(text);
  if (!isStageCounts(value)) {
    throw new StageChangedError(stageId, "sealed stage counts are not stage counts");
  }
  return value;
}

/** A stage entry's persisted canonical bytes. `encodeFileEntry`'s admission is
 * the validator; only the JSON object container is re-established here. */
function isFileEntry(value: JsonValue): value is JsonObject & FileEntry {
  return jsonObject(value) !== undefined;
}

function decodeStageEntryBytes(text: string): FileEntry {
  const value = parseCanonicalJson(text);
  if (!isFileEntry(value)) throw new TypeError("stage entry is not a JSON object");
  return value;
}

/**
 * Open a sealed stage for CONSUMPTION: metadata is proven before any row is
 * yielded, and the logical digest is accumulated during the one row pass the
 * consumer already makes, then verified at end-of-stream. Consume-then-verify is
 * safe because the consumer's copy is SAVEPOINT-contained and precedes `BEGIN
 * IMMEDIATE`, so no authority row exists before the proof completes.
 */
export function openSealedStageForConsume(
  directory: string,
  ref: SealedStageRef,
  lock: StageLock,
): ConsumedStageReader {
  const accessor = openSealedArtifact(directory, ref, lock);
  let meta: SealedStageMeta;
  try {
    meta = readSealedStageMeta(accessor, ref.stageId);
    if (meta.plane !== ref.plane || meta.digest !== ref.logicalDigest
      || canonicalJson(meta.header) !== canonicalJson(ref.header)
      || canonicalJson(meta.counts) !== canonicalJson(ref.counts)) {
      throw new StageChangedError(ref.stageId, "sealed stage identity does not match its ref");
    }
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    throw error;
  }
  return {
    sealedHeader: meta.header,
    streamFiles(visit: (encoded: ConsumedFileEntry) => void): number {
      const digest = new StageDigestBuilder(ref.stageId, ref.plane, meta.header);
      const copied = streamRows<{ path: string; entry_cjson: string }>(
        accessor.db, "SELECT path,entry_cjson FROM stage_entries WHERE stage_id=? ORDER BY path_order",
        [ref.stageId], (row) => {
          const encoded = encodeFileEntryForConsume(JSON.parse(row.entry_cjson) as FileEntry);
          if (encoded.path !== row.path || encoded.canonical !== row.entry_cjson) {
            throw new StageChangedError(ref.stageId, `stage row ${row.path} is not canonical`);
          }
          digest.file(encoded.canonical);
          visit(encoded);
        });
      streamRows<{ role: GitSectionRole }>(
        accessor.db, "SELECT role FROM stage_git_roles WHERE stage_id=? ORDER BY role",
        [ref.stageId], (row) => digest.declareRole(row.role));
      streamRows<{ role: GitSectionRole; rel_path: string; section_cjson: string }>(
        accessor.db, `SELECT role,rel_path,section_cjson FROM stage_git_sections
          WHERE stage_id=? ORDER BY role,path_order`,
        [ref.stageId], (row) => digest.gitSection(row.role, row.rel_path, row.section_cjson));
      if (canonicalJson(digest.counts) !== canonicalJson(ref.counts)) {
        throw new StageChangedError(ref.stageId, "sealed stage counts do not match its ref");
      }
      if (digest.seal(ref.counts) !== ref.logicalDigest) {
        throw new StageChangedError(ref.stageId, "sealed stage logical digest does not match its ref");
      }
      return copied;
    },
    close(): void {
      accessor.close();
    },
  };
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
        encoded = encodeFileEntry(decodeStageEntryBytes(row.entry_cjson));
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
