/** Staging, promotion, and GC for file/Git generations.
 *
 * A generation is built inside its own private directory, sealed by the normative
 * commit → checkpoint TRUNCATE → close → S0 → fsync → prove → link sequence, and
 * only then promoted into a plane by SQL set-difference. No stage is ever attached
 * as writable authority, and no stage pathname is reopened after verification. */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { encodeFileEntry } from "../codecs/file-entry.js";
import { encodeGitSection } from "../codecs/git-section.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { StageDigestBuilder, type StageCounts } from "../digest/stage-semantic-v1.js";
import { CursorWindowError, GitSectionOversizeError, StageChangedError } from "../errors.js";
import type { GitSectionRole, ManifestHeader, Plane } from "../ports.js";
import { MAX_FILE_BATCH, PAGE_BYTES, type SealedStageReader, type SealedStageRef } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, abandonBuilder, configureStageBuilder, sealAndPublish,
  sealedStagePath, streamRows,
} from "./stage-artifacts.js";

export const STAGE_DDL = `
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
  let privateDirectory: PrivateStageDirectory | undefined;
  let db: Database | undefined;
  try {
    privateDirectory = PrivateStageDirectory.claim(lock);
    db = new Database(privateDirectory.file(), { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(STAGE_DDL);
    db.query("INSERT INTO stage_meta(stage_id,plane,state,header_cjson) VALUES (?,?,'building',?)")
      .run(stageId, plane, canonicalJson(header));
  } catch (error) {
    abandonBuilder(db, lock, privateDirectory);
    throw error;
  }
  return new SqliteGenerationBuilder(directory, stageId, plane, header, db, lock, privateDirectory);
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
    private readonly privateDirectory: PrivateStageDirectory,
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
    // Malformed path/section from a caller is a TypeError here, before any row
    // is written — the same admission the RepoRecord codec applies to its base/
    // advertised/pending sections. The stored bytes are then the exact canonical
    // spelling the digest covers.
    const encoded = encodeGitSection(relPath, section);
    if (encoded.bytes > PAGE_BYTES) throw new GitSectionOversizeError(relPath, encoded.bytes);
    this.#flushBefore(encoded.bytes);
    this.declareGitRole(role);
    this.db.query("INSERT INTO stage_git_sections(stage_id,role,rel_path,path_order,section_cjson) VALUES (?,?,?,?,?)")
      .run(this.stageId, role, relPath, utf16beOrderKey(relPath), encoded.canonical);
    this.#pendingBytes += encoded.bytes;
  }

  finishGeneration(expectedCounts: StageCounts): SealedStageRef {
    this.#assertOpen();
    try {
      const digest = new StageDigestBuilder(this.stageId, this.plane, this.header as unknown as Record<string, unknown>);
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
      const physical = sealAndPublish(
        this.db, this.privateDirectory.file(),
        sealedStagePath(this.directory, this.stageId, logicalDigest), this.stageId,
      );
      this.privateDirectory.destroy();
      this.lock.release();
      return {
        stageId: this.stageId, plane: this.plane, header: this.header, logicalDigest,
        physicalSha256: physical.sha256, bytes: physical.bytes, counts,
      };
    } catch (error) {
      // A sealing failure — no-clobber refusal, S0, or hash — must leave neither a
      // lock nor a partial artifact behind.
      this.#open = false;
      abandonBuilder(this.db, this.lock, this.privateDirectory);
      throw error;
    }
  }

  discardGeneration(): void {
    if (!this.#open) return;
    this.#open = false;
    abandonBuilder(this.db, this.lock, this.privateDirectory);
  }

  #flushBefore(rowBytes: number): void {
    // An oversize-but-valid row is processed alone; otherwise the open batch is
    // committed before it would cross the byte ceiling.
    if (this.#pendingBytes > 0 && this.#pendingBytes + rowBytes > PAGE_BYTES) {
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

/** Intern every staged value, then resolve each staged row to the authority's entry
 * id. Both halves are indexed SQL set operations over the whole stage. */
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
