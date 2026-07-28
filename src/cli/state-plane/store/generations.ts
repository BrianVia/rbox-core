/** Staging, promotion, and GC for file/Git generations.
 *
 * A generation is built into an external, connection-owned stage database, sealed
 * physically and semantically, and only then promoted into a plane by SQL
 * set-difference. No stage is ever attached as writable authority. */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { decodeFileEntry, encodeFileEntry, type EncodedFileEntry } from "../codecs/file-entry.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import {
  StageDigestBuilder, type StageCounts, type StageLogicalDigest,
} from "../digest/stage-semantic-v1.js";
import { CursorWindowError, GitSectionOversizeError, StageChangedError } from "../errors.js";
import type { CursorPage, GitSectionRole, ManifestHeader, Plane } from "../ports.js";
import {
  StageLock, assertSealedZeroSidecars, buildingStagePath, configureStageBuilder,
  fsyncFile, openSealedArtifact, physicalProof, publishSealed, sealedStagePath, streamRows,
  type SealedArtifactAccessor,
} from "./stage-artifacts.js";

const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BATCH = 512;
const MAX_GIT_BATCH = 16;

const STAGE_DDL = `
CREATE TABLE stage_meta(
  stage_id TEXT PRIMARY KEY, plane TEXT NOT NULL CHECK(plane IN ('base','local')),
  state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  header_cjson TEXT NOT NULL, digest TEXT, counts_cjson TEXT,
  CHECK(state='building' OR (digest IS NOT NULL AND counts_cjson IS NOT NULL))
);
CREATE TABLE stage_entries(
  stage_id TEXT NOT NULL, path TEXT NOT NULL, path_order BLOB NOT NULL,
  entry_cjson TEXT NOT NULL, PRIMARY KEY(stage_id,path)
);
CREATE INDEX stage_entries_order ON stage_entries(stage_id,path_order);
CREATE TABLE stage_git_roles(stage_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(stage_id,role));
CREATE TABLE stage_git_sections(
  stage_id TEXT NOT NULL, role TEXT NOT NULL, rel_path TEXT NOT NULL,
  path_order BLOB NOT NULL, section_cjson TEXT NOT NULL,
  PRIMARY KEY(stage_id,role,rel_path)
);
CREATE INDEX stage_git_sections_order ON stage_git_sections(stage_id,role,path_order);
`;

export interface SealedStageRef {
  stageId: string;
  plane: Plane;
  logicalDigest: StageLogicalDigest;
  physicalSha256: string;
  bytes: number;
  counts: StageCounts;
}

export interface GenerationBuilder {
  readonly stageId: string;
  putEntries(entries: readonly FileEntry[]): void;
  declareGitRole(role: GitSectionRole): void;
  putGitSection(role: GitSectionRole, relPath: string, section: GitSection): void;
  finishGeneration(expectedCounts: StageCounts): SealedStageRef;
  discardGeneration(): void;
}

export function beginGeneration(
  directory: string,
  plane: Plane,
  header: ManifestHeader,
  stageId: string = crypto.randomBytes(16).toString("hex"),
): GenerationBuilder {
  const lock = StageLock.acquire(directory, stageId);
  const file = buildingStagePath(directory, stageId);
  let db: Database;
  try {
    fs.rmSync(file, { force: true });
    db = new Database(file, { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(STAGE_DDL);
    db.query("INSERT INTO stage_meta(stage_id,plane,state,header_cjson) VALUES (?,?,'building',?)")
      .run(stageId, plane, canonicalJson(header));
  } catch (error) {
    lock.cleanupOwnedArtifacts();
    lock.release();
    throw error;
  }
  return new SqliteGenerationBuilder(directory, stageId, plane, header, db, lock, file);
}

class SqliteGenerationBuilder implements GenerationBuilder {
  #open = true;
  #pendingBytes = 0;

  constructor(
    private readonly directory: string,
    readonly stageId: string,
    private readonly plane: Plane,
    private readonly header: ManifestHeader,
    private readonly db: Database,
    private readonly lock: StageLock,
    private readonly file: string,
  ) {
    this.db.exec("BEGIN");
  }

  putEntries(entries: readonly FileEntry[]): void {
    this.#assertOpen();
    if (entries.length > MAX_FILE_BATCH) throw new CursorWindowError("file", entries.length, MAX_FILE_BATCH);
    const insert = this.db.query("INSERT INTO stage_entries(stage_id,path,path_order,entry_cjson) VALUES (?,?,?,?)");
    for (const entry of entries) {
      const encoded = encodeFileEntry(entry);
      this.#flushBefore(encoded.retainedEstimate);
      insert.run(this.stageId, encoded.path, encoded.pathOrder, encoded.canonical);
      this.#pendingBytes += encoded.retainedEstimate;
    }
  }

  declareGitRole(role: GitSectionRole): void {
    this.#assertOpen();
    this.db.query("INSERT OR IGNORE INTO stage_git_roles(stage_id,role) VALUES (?,?)").run(this.stageId, role);
  }

  putGitSection(role: GitSectionRole, relPath: string, section: GitSection): void {
    this.#assertOpen();
    const canonical = canonicalJson(section);
    const bytes = Buffer.byteLength(canonical) + Buffer.byteLength(relPath);
    if (bytes > BATCH_BYTES) throw new GitSectionOversizeError(relPath, bytes);
    this.#flushBefore(bytes);
    this.declareGitRole(role);
    this.db.query("INSERT INTO stage_git_sections(stage_id,role,rel_path,path_order,section_cjson) VALUES (?,?,?,?,?)")
      .run(this.stageId, role, relPath, utf16beOrderKey(relPath), canonical);
    this.#pendingBytes += bytes;
  }

  finishGeneration(expectedCounts: StageCounts): SealedStageRef {
    this.#assertOpen();
    this.lock.assertHeld();
    const digest = new StageDigestBuilder(this.stageId, this.plane, this.header);
    streamRows<{ path: string; entry_cjson: string }>(
      this.db, "SELECT path,entry_cjson FROM stage_entries WHERE stage_id=? ORDER BY path_order",
      [this.stageId], (row) => {
        // Re-encode rather than trust the stored bytes: the digest must cover a
        // value this store would itself admit, in this store's canonical spelling.
        const encoded = encodeFileEntry(parseCanonicalJson(row.entry_cjson) as unknown as FileEntry);
        if (encoded.canonical !== row.entry_cjson || encoded.path !== row.path) {
          throw new StageChangedError(this.stageId, `stage row ${row.path} is not canonical`);
        }
        digest.file(encoded.canonical);
      });
    streamRows<{ role: GitSectionRole }>(
      this.db, "SELECT role FROM stage_git_roles WHERE stage_id=? ORDER BY role",
      [this.stageId], (row) => digest.declareRole(row.role));
    streamRows<{ role: GitSectionRole; rel_path: string; section_cjson: string }>(
      this.db, `SELECT role,rel_path,section_cjson FROM stage_git_sections
        WHERE stage_id=? ORDER BY role,path_order`,
      [this.stageId], (row) => digest.gitSection(row.role, row.rel_path, row.section_cjson));
    const counts = digest.counts;
    const logicalDigest = digest.seal(expectedCounts);
    this.db.query("UPDATE stage_meta SET state='sealed',digest=?,counts_cjson=? WHERE stage_id=?")
      .run(logicalDigest, canonicalJson(counts), this.stageId);
    this.db.exec("COMMIT");
    this.#open = false;
    this.db.close();
    assertSealedZeroSidecars(this.file, this.stageId);
    fsyncFile(this.file);
    const physical = physicalProof(this.file, this.stageId);
    const destination = sealedStagePath(this.directory, this.stageId, logicalDigest);
    publishSealed(this.file, destination, this.stageId);
    this.lock.release();
    return {
      stageId: this.stageId, plane: this.plane, logicalDigest,
      physicalSha256: physical.sha256, bytes: physical.bytes, counts,
    };
  }

  discardGeneration(): void {
    if (!this.#open) return;
    this.#open = false;
    try { if (this.db.inTransaction) this.db.exec("ROLLBACK"); } catch { /* closing anyway */ }
    this.db.close();
    this.lock.cleanupOwnedArtifacts();
    this.lock.release();
  }

  #flushBefore(rowBytes: number): void {
    // An oversize-but-valid row is processed alone; otherwise the open batch is
    // committed before it would cross the byte ceiling.
    if (this.#pendingBytes > 0 && this.#pendingBytes + rowBytes > BATCH_BYTES) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
      this.#pendingBytes = 0;
    }
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error("generation builder is closed");
    this.lock.assertHeld();
  }
}

export interface SealedStageReader {
  files(afterPath: string | undefined, batchSize: number): CursorPage<FileEntry>;
  gitRepoCursor(role: GitSectionRole, afterRelPath: string | undefined, batchSize: number): CursorPage<{ relPath: string; section: GitSection }>;
  gitRepo(role: GitSectionRole, relPath: string): GitSection | undefined;
  /** Row-at-a-time canonical stream. The only interface the CAS copy uses. */
  streamFiles(visit: (encoded: EncodedFileEntry) => void): number;
  close(): void;
}

/** Verify and open one sealed stage under its own id-scoped lock. The caller owns
 * the lock for the whole consumption interval and releases it after `close()`. */
export function openSealedStage(
  directory: string,
  ref: SealedStageRef,
  lock: StageLock,
): SealedStageReader {
  const file = sealedStagePath(directory, ref.stageId, ref.logicalDigest);
  const accessor = openSealedArtifact(file, ref, lock);
  try {
    const derived = deriveStageRef(accessor, ref.stageId, ref.physicalSha256, ref.bytes);
    if (canonicalJson(derived) !== canonicalJson(ref)) {
      throw new StageChangedError(ref.stageId, "sealed stage identity does not match its ref");
    }
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    throw error;
  }
  return new SqliteSealedStage(accessor, ref);
}

/**
 * Recompute the whole ref from the artifact's own rows. A crash-resumed stage is
 * never trusted from its `sealed` bit or its stored digest column: both are
 * compared against a fresh `stage-semantic-v1` recomputation.
 */
function deriveStageRef(
  accessor: SealedArtifactAccessor,
  stageId: string,
  physicalSha256: string,
  bytes: number,
): SealedStageRef {
  const meta = accessor.db.query("SELECT stage_id,plane,state,header_cjson,digest,counts_cjson FROM stage_meta").get() as {
    stage_id: string; plane: Plane; state: string; header_cjson: string; digest: string; counts_cjson: string;
  } | null;
  if (!meta) throw new StageChangedError(stageId, "sealed stage has no stage_meta row");
  if (meta.stage_id !== stageId || meta.state !== "sealed") {
    throw new StageChangedError(stageId, "sealed stage identity does not match its ref");
  }
  const digest = new StageDigestBuilder(meta.stage_id, meta.plane, parseCanonicalJson(meta.header_cjson) as Record<string, unknown>);
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
  const stored = parseCanonicalJson(meta.counts_cjson) as unknown as StageCounts;
  const logicalDigest = digest.seal(stored);
  if (meta.digest !== logicalDigest) throw new StageChangedError(stageId, "sealed stage digest column is stale");
  return { stageId, plane: meta.plane, logicalDigest, physicalSha256, bytes, counts };
}

/**
 * Reverify one source-stage binding end to end. A stage named only as Git proof
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
    const file = sealedStagePath(directory, binding.stageId, binding.logicalDigest);
    const accessor = openSealedArtifact(file, binding, lock);
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

class SqliteSealedStage implements SealedStageReader {
  constructor(private readonly accessor: SealedArtifactAccessor, private readonly ref: SealedStageRef) {}

  files(afterPath: string | undefined, batchSize: number): CursorPage<FileEntry> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_FILE_BATCH) {
      throw new CursorWindowError("file", batchSize, MAX_FILE_BATCH);
    }
    const rows = this.accessor.db.query(`SELECT path,entry_cjson FROM stage_entries
      WHERE stage_id=? AND path_order>? ORDER BY path_order LIMIT ?`).all(
      this.ref.stageId, afterPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterPath), batchSize,
    ) as Array<{ path: string; entry_cjson: string }>;
    const admitted: FileEntry[] = [];
    let used = 0;
    for (const row of rows) {
      const encoded = encodeFileEntry(parseCanonicalJson(row.entry_cjson) as unknown as FileEntry);
      if (admitted.length > 0 && used + encoded.retainedEstimate > BATCH_BYTES) break;
      admitted.push(decodeStageEntry(encoded));
      used += encoded.retainedEstimate;
    }
    const last = rows[admitted.length - 1];
    return {
      rows: admitted,
      done: admitted.length === rows.length && rows.length < batchSize,
      ...(last ? { after: last.path } : {}),
    };
  }

  gitRepoCursor(role: GitSectionRole, afterRelPath: string | undefined, batchSize: number) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_GIT_BATCH) {
      throw new CursorWindowError("git", batchSize, MAX_GIT_BATCH);
    }
    const rows = this.accessor.db.query(`SELECT rel_path,section_cjson FROM stage_git_sections
      WHERE stage_id=? AND role=? AND path_order>? ORDER BY path_order LIMIT ?`).all(
      this.ref.stageId, role, afterRelPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterRelPath), batchSize,
    ) as Array<{ rel_path: string; section_cjson: string }>;
    const admitted: Array<{ relPath: string; section: GitSection }> = [];
    let used = 0;
    for (const row of rows) {
      const bytes = Buffer.byteLength(row.section_cjson) + Buffer.byteLength(row.rel_path);
      if (bytes > BATCH_BYTES) throw new GitSectionOversizeError(row.rel_path, bytes);
      if (admitted.length > 0 && used + bytes > BATCH_BYTES) break;
      admitted.push({ relPath: row.rel_path, section: parseCanonicalJson(row.section_cjson) as unknown as GitSection });
      used += bytes;
    }
    const last = rows[admitted.length - 1];
    return {
      rows: admitted,
      done: admitted.length === rows.length && rows.length < batchSize,
      ...(last ? { after: last.rel_path } : {}),
    };
  }

  gitRepo(role: GitSectionRole, relPath: string): GitSection | undefined {
    const row = this.accessor.db.query("SELECT section_cjson FROM stage_git_sections WHERE stage_id=? AND role=? AND rel_path=?")
      .get(this.ref.stageId, role, relPath) as { section_cjson: string } | null;
    return row ? parseCanonicalJson(row.section_cjson) as unknown as GitSection : undefined;
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

/* ---------------------------------------------------------------- promotion */

export const CAS_FILE_TEMP = "cas_stage_files";

const ENTRY_COLUMNS = `entry_id,exact_fingerprint,path,path_order,sha256,size,mode,mtime_ms,kind,
  symlink_target,enc_sha,comp,payload_sha,cipher_size,extras_cjson,canonical_bytes,retained_estimate`;

/** NULL-safe exact comparison. The fingerprint index is only a lookup; identity is
 * decided column by column, so a collision can never alias two different entries. */
const EXACT_MATCH = `e.exact_fingerprint=t.exact_fingerprint AND e.path=t.path AND e.sha256=t.sha256
  AND e.size=t.size AND e.mode=t.mode AND e.mtime_ms=t.mtime_ms AND e.kind=t.kind
  AND e.symlink_target IS t.symlink_target AND e.enc_sha IS t.enc_sha AND e.comp IS t.comp
  AND e.payload_sha IS t.payload_sha AND e.cipher_size IS t.cipher_size
  AND e.extras_cjson IS t.extras_cjson`;

export function createStageFileTemp(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_FILE_TEMP};
    CREATE TEMP TABLE ${CAS_FILE_TEMP}(
      entry_id TEXT NOT NULL, exact_fingerprint TEXT NOT NULL, path TEXT PRIMARY KEY,
      path_order BLOB NOT NULL, sha256 BLOB NOT NULL, size NUMERIC NOT NULL, mode INTEGER NOT NULL,
      mtime_ms REAL NOT NULL, kind TEXT NOT NULL, symlink_target TEXT, enc_sha BLOB, comp TEXT,
      payload_sha BLOB, cipher_size NUMERIC, extras_cjson TEXT,
      canonical_bytes INTEGER NOT NULL, retained_estimate INTEGER NOT NULL);`);
}

export function dropStageFileTemp(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_FILE_TEMP}`);
}

/**
 * Stream a sealed stage's files into the connection-owned TEMP table one row at a
 * time. Nothing is written to the authority here: this runs before `BEGIN
 * IMMEDIATE`, so interning and promotion stay entirely inside the CAS transaction.
 */
export function copyStageFilesIntoTemp(db: Database, stage: SealedStageReader): number {
  const insertTemp = db.query(`INSERT INTO ${CAS_FILE_TEMP}(${ENTRY_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stage.streamFiles((encoded) => {
    insertTemp.run(
      encoded.entryId, encoded.exactFingerprint, encoded.path, encoded.pathOrder, encoded.sha256,
      encoded.size, encoded.mode, encoded.mtimeMs, encoded.kind, encoded.symlinkTarget,
      encoded.encSha, encoded.comp, encoded.payloadSha, encoded.cipherSize, encoded.extrasCjson,
      encoded.canonicalBytes, encoded.retainedEstimate,
    );
  });
}

/** Intern every staged value, then resolve each staged row to the authority's
 * entry id. Both halves are indexed SQL set operations over the whole stage. */
export function internStagedEntryValues(db: Database): void {
  db.query(`INSERT INTO entry_values(${ENTRY_COLUMNS})
    SELECT ${ENTRY_COLUMNS.split(",").map((column) => `t.${column.trim()}`).join(",")}
    FROM ${CAS_FILE_TEMP} t
    WHERE NOT EXISTS(SELECT 1 FROM entry_values e WHERE ${EXACT_MATCH})`).run();
  db.query(`UPDATE ${CAS_FILE_TEMP} AS t SET entry_id=(
    SELECT e.entry_id FROM entry_values e WHERE ${EXACT_MATCH} LIMIT 1)`).run();
}

/** Indexed SQL set-difference. Deleted paths go in this transaction, unchanged
 * paths keep their row and generation, and only dirty rows are stamped. */
export function promoteFilesIntoPlane(db: Database, lineageId: string, plane: Plane, generation: number): void {
  db.query(`DELETE FROM plane_entries WHERE lineage_id=? AND plane=?
    AND NOT EXISTS(SELECT 1 FROM ${CAS_FILE_TEMP} f WHERE f.path=plane_entries.path)`).run(lineageId, plane);
  db.query(`INSERT INTO plane_entries(lineage_id,plane,path,path_order,entry_id,changed_generation)
    SELECT ?,?,f.path,f.path_order,f.entry_id,? FROM ${CAS_FILE_TEMP} f
    WHERE NOT EXISTS(SELECT 1 FROM plane_entries p
      WHERE p.lineage_id=? AND p.plane=? AND p.path=f.path AND p.entry_id=f.entry_id)
    ON CONFLICT(lineage_id,plane,path) DO UPDATE SET
      path_order=excluded.path_order, entry_id=excluded.entry_id,
      changed_generation=excluded.changed_generation`).run(lineageId, plane, generation, lineageId, plane);
}

/** GC: an interned value is collectable only once no plane row references it. */
export function collectUnreferencedEntryValues(db: Database): number {
  return db.query(`DELETE FROM entry_values WHERE NOT EXISTS(
    SELECT 1 FROM plane_entries p WHERE p.entry_id=entry_values.entry_id)`).run().changes;
}
