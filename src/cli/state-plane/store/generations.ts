/** Staging, promotion, and GC for file/Git generations.
 *
 * A generation is built inside its own private directory, sealed by the normative
 * commit → checkpoint TRUNCATE → close → S0 → fsync → prove → link sequence, and
 * only then promoted into a plane by SQL set-difference. No stage is ever attached
 * as writable authority, and no stage pathname is reopened after verification. */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { encodeFileEntry, encodeFileEntryForStage, type ConsumedFileEntry } from "../codecs/file-entry.js";
import { encodeGitSection } from "../codecs/git-section.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { StageDigestBuilder, type StageCounts } from "../digest/stage-semantic-v1.js";
import { CursorWindowError, GitSectionOversizeError, StageChangedError } from "../errors.js";
import type { GitSectionRole, ManifestHeader, Plane } from "../ports.js";
import { MAX_FILE_BATCH, PAGE_BYTES, type ConsumedStageReader, type SealedStageRef } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, abandonBuilder, configureStageBuilder, sealAndPublish,
  sealedStagePath,
} from "./stage-artifacts.js";
import { runStatement, selectRow, streamRows, withStatement } from "./statements.js";

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
    runStatement(db, "INSERT INTO stage_meta(stage_id,plane,state,header_cjson) VALUES (?,?,'building',?)",
      stageId, plane, canonicalJson(header));
  } catch (error) {
    abandonBuilder(db, lock, privateDirectory);
    throw error;
  }
  return new SqliteGenerationBuilder(directory, stageId, plane, header, db, lock, privateDirectory);
}

class SqliteGenerationBuilder implements GenerationBuilder {
  #open = true;
  #pendingBytes = 0;
  readonly #digest: StageDigestBuilder;
  #ordered = true;
  #lastFilePath: string | undefined;
  #lastGitKey: string | undefined;

  constructor(
    private readonly directory: string,
    readonly stageId: string,
    private readonly plane: Plane,
    private readonly header: ManifestHeader,
    private readonly db: Database,
    private readonly lock: StageLock,
    private readonly privateDirectory: PrivateStageDirectory,
  ) {
    this.#digest = new StageDigestBuilder(stageId, plane, header);
    this.db.exec("BEGIN");
  }

  putEntries(entries: readonly FileEntry[]): void {
    this.#assertOpen();
    if (entries.length > MAX_FILE_BATCH) throw new CursorWindowError("file", entries.length, MAX_FILE_BATCH);
    const pending: ReturnType<typeof encodeFileEntryForStage>[] = [];
    const insertPending = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0);
      const values = batch.map(() => "(?,?,?,?)").join(",");
      const bindings = batch.flatMap((encoded) =>
        [this.stageId, encoded.path, encoded.pathOrder, encoded.canonical]);
      try {
        runStatement(this.db, `INSERT INTO stage_entries(stage_id,path,path_order,entry_cjson) VALUES ${values}`,
          ...bindings);
        for (const encoded of batch) this.#adoptInsertedEntry(encoded);
      } catch {
        // A multi-row statement is atomic. Replaying rowwise after its failure
        // preserves the original prefix-admission and exact SQLite refusal.
        for (const encoded of batch) {
          runStatement(this.db, "INSERT INTO stage_entries(stage_id,path,path_order,entry_cjson) VALUES (?,?,?,?)",
            this.stageId, encoded.path, encoded.pathOrder, encoded.canonical);
          this.#adoptInsertedEntry(encoded);
        }
      }
    };
    try {
      for (const entry of entries) {
        const encoded = encodeFileEntryForStage(entry);
        if (this.#pendingBytes > 0 && this.#pendingBytes + encoded.retainedEstimate > PAGE_BYTES) {
          insertPending();
          this.db.exec("COMMIT");
          this.db.exec("BEGIN");
          this.#pendingBytes = 0;
        }
        pending.push(encoded);
        this.#pendingBytes += encoded.retainedEstimate;
      }
      insertPending();
    } catch (error) {
      if (pending.length > 0) insertPending();
      throw error;
    }
  }

  #adoptInsertedEntry(encoded: ReturnType<typeof encodeFileEntryForStage>): void {
    if (this.#ordered && this.#lastGitKey === undefined
      && (this.#lastFilePath === undefined || this.#lastFilePath < encoded.path)) {
      this.#digest.file(encoded.canonical);
      this.#lastFilePath = encoded.path;
    } else {
      this.#ordered = false;
    }
  }

  declareGitRole(role: GitSectionRole): void {
    this.#assertOpen();
    runStatement(this.db, "INSERT OR IGNORE INTO stage_git_roles(stage_id,role) VALUES (?,?)", this.stageId, role);
    this.#digest.declareRole(role);
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
    runStatement(this.db, "INSERT INTO stage_git_sections(stage_id,role,rel_path,path_order,section_cjson) VALUES (?,?,?,?,?)",
      this.stageId, role, relPath, utf16beOrderKey(relPath), encoded.canonical);
    const key = `${role}\0${relPath}`;
    if (this.#ordered && (this.#lastGitKey === undefined || this.#lastGitKey < key)) {
      this.#digest.gitSection(role, relPath, encoded.canonical);
      this.#lastGitKey = key;
    } else {
      this.#ordered = false;
    }
    this.#pendingBytes += encoded.bytes;
  }

  finishGeneration(expectedCounts: StageCounts): SealedStageRef {
    this.#assertOpen();
    try {
      const digest = this.#ordered && process.env.RBOX_STATE_VERIFY_STAGE !== "1"
        ? this.#digest
        : this.#verifiedDigest();
      const counts = digest.counts;
      const logicalDigest = digest.seal(expectedCounts);
      runStatement(this.db, "UPDATE stage_meta SET state='sealed',digest=?,counts_cjson=? WHERE stage_id=?",
        logicalDigest, canonicalJson(counts), this.stageId);
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

  #verifiedDigest(): StageDigestBuilder {
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
    return digest;
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

/** Every interned column except the id, which the consume path never carries. */
export const VALUE_COLUMNS = ["exact_fingerprint", "path", "path_order", "sha256", "size", "mode",
  "mtime_ms", "kind", "symlink_target", "enc_sha", "comp", "payload_sha", "cipher_size",
  "extras_cjson", "canonical_bytes", "retained_estimate"] as const;

const VALUE_COLUMN_LIST = VALUE_COLUMNS.join(",");
const ENTRY_COLUMNS = `entry_id,${VALUE_COLUMN_LIST}`;

/** NULL-safe exact comparison. The fingerprint index is only a lookup; identity is
 * decided column by column, so a collision can never alias two different entries. */
const EXACT_MATCH = `e.exact_fingerprint=t.exact_fingerprint AND e.path=t.path AND e.sha256=t.sha256
  AND e.size=t.size AND e.mode=t.mode AND e.mtime_ms=t.mtime_ms AND e.kind=t.kind
  AND e.symlink_target IS t.symlink_target AND e.enc_sha IS t.enc_sha AND e.comp IS t.comp
  AND e.payload_sha IS t.payload_sha AND e.cipher_size IS t.cipher_size
  AND e.extras_cjson IS t.extras_cjson`;

/** `entry_id` is nullable: the consume path leaves it unset and the intern pass
 * resolves or mints it in SQL. */
export function createFileValueTemp(db: Database, table: string): void {
  db.exec(`DROP TABLE IF EXISTS temp.${table};
    CREATE TEMP TABLE ${table}(
      entry_id TEXT, exact_fingerprint TEXT NOT NULL, path TEXT PRIMARY KEY,
      path_order BLOB NOT NULL, sha256 BLOB NOT NULL, size NUMERIC NOT NULL, mode INTEGER NOT NULL,
      mtime_ms REAL NOT NULL, kind TEXT NOT NULL, symlink_target TEXT, enc_sha BLOB, comp TEXT,
      payload_sha BLOB, cipher_size NUMERIC, extras_cjson TEXT,
      canonical_bytes INTEGER NOT NULL, retained_estimate INTEGER NOT NULL);`);
}

export function dropFileValueTemp(db: Database, table: string): void {
  db.exec(`DROP TABLE IF EXISTS temp.${table}`);
}

export function createStageFileTemp(db: Database): void {
  createFileValueTemp(db, CAS_FILE_TEMP);
}

export function dropStageFileTemp(db: Database): void {
  dropFileValueTemp(db, CAS_FILE_TEMP);
}

/**
 * Stream a sealed stage's files into the connection-owned TEMP table one row at a
 * time. Nothing is written to the authority here: this runs before `BEGIN
 * IMMEDIATE`, so interning and promotion stay entirely inside the CAS transaction.
 */
export function copyStageFilesIntoTemp(db: Database, stage: ConsumedStageReader): number {
  return copyFileValuesIntoTemp(db, CAS_FILE_TEMP, (visit) => stage.streamFiles(visit));
}

/** The one row-at-a-time TEMP fill both stage kinds share. */
export function copyFileValuesIntoTemp(
  db: Database,
  table: string,
  stream: (visit: (encoded: ConsumedFileEntry) => void) => number,
): number {
  db.exec("SAVEPOINT copy_stage_files");
  try {
    const pending: ConsumedFileEntry[] = [];
    const bind = (encoded: ConsumedFileEntry): Array<string | number | Buffer | null> => [
      encoded.exactFingerprint, encoded.path, encoded.pathOrder, encoded.sha256,
      encoded.size, encoded.mode, encoded.mtimeMs, encoded.kind, encoded.symlinkTarget,
      encoded.encSha, encoded.comp, encoded.payloadSha, encoded.cipherSize, encoded.extrasCjson,
      encoded.canonicalBytes, encoded.retainedEstimate,
    ];
    const row = `(${VALUE_COLUMNS.map(() => "?").join(",")})`;
    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0);
      try {
        runStatement(db, `INSERT INTO ${table}(${VALUE_COLUMN_LIST}) VALUES ${batch.map(() => row).join(",")}`,
          ...batch.flatMap(bind));
      } catch {
        // Preserve the rowwise statement's exact prefix and refusal if the bulk
        // statement encounters any SQLite limit or data error.
        withStatement(db, `INSERT INTO ${table}(${VALUE_COLUMN_LIST}) VALUES ${row}`,
          (insertTemp) => {
            for (const encoded of batch) insertTemp.run(...bind(encoded));
          });
      }
    };
    const copied = stream((encoded) => {
      pending.push(encoded);
      if (pending.length === MAX_FILE_BATCH) flush();
    });
    flush();
    db.exec("RELEASE copy_stage_files");
    return copied;
  } catch (error) {
    db.exec("ROLLBACK TO copy_stage_files");
    db.exec("RELEASE copy_stage_files");
    throw error;
  }
}

/** Intern every staged value, then resolve each staged row to the authority's entry
 * id. Both halves are indexed SQL set operations over the whole named TEMP table:
 * the delta path interns its upserts through these exact statements. */
export function internStagedEntryValues(db: Database, table: string = CAS_FILE_TEMP): void {
  runStatement(db, `INSERT INTO entry_values(${ENTRY_COLUMNS})
    SELECT lower(hex(randomblob(16))),${VALUE_COLUMNS.map((column) => `t.${column}`).join(",")}
    FROM ${table} t
    WHERE NOT EXISTS(SELECT 1 FROM entry_values e WHERE ${EXACT_MATCH})`);
  runStatement(db, `UPDATE ${table} AS t SET entry_id=(
    SELECT e.entry_id FROM entry_values e WHERE ${EXACT_MATCH} LIMIT 1)`);
}

/** Indexed SQL set-difference. Deleted paths go in this transaction, unchanged
 * paths keep their row and generation, and only dirty rows are stamped. */
export function promoteFilesIntoPlane(db: Database, lineageId: string, plane: Plane, generation: number): void {
  runStatement(db, `DELETE FROM plane_entries WHERE lineage_id=? AND plane=?
    AND NOT EXISTS(SELECT 1 FROM ${CAS_FILE_TEMP} f WHERE f.path=plane_entries.path)`, lineageId, plane);
  runStatement(db, `INSERT INTO plane_entries(lineage_id,plane,path,path_order,entry_id,changed_generation)
    SELECT ?,?,f.path,f.path_order,f.entry_id,? FROM ${CAS_FILE_TEMP} f
    WHERE NOT EXISTS(SELECT 1 FROM plane_entries p
      WHERE p.lineage_id=? AND p.plane=? AND p.path=f.path AND p.entry_id=f.entry_id)
    ON CONFLICT(lineage_id,plane,path) DO UPDATE SET
      path_order=excluded.path_order, entry_id=excluded.entry_id,
      changed_generation=excluded.changed_generation`, lineageId, plane, generation, lineageId, plane);
}

/* --------------------------------------------------------- delta promotion */

export const CAS_DELTA_UPSERTS = "cas_delta_upserts";
export const CAS_DELTA_DELETES = "cas_delta_deletes";

export function createDeltaTemps(db: Database): void {
  createFileValueTemp(db, CAS_DELTA_UPSERTS);
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_DELTA_DELETES};
    CREATE TEMP TABLE ${CAS_DELTA_DELETES}(path TEXT PRIMARY KEY);`);
}

export function dropDeltaTemps(db: Database): void {
  dropFileValueTemp(db, CAS_DELTA_UPSERTS);
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_DELTA_DELETES}`);
}

export interface DeltaApplication {
  stageId: string;
  resultFiles: number;
}

/**
 * Apply a verified delta's ops to one plane. Only the named paths move: there is
 * no set-difference and no delete-absent statement anywhere on this path, so a
 * delete of a path the plane does not hold is a refusal rather than a silent
 * no-op that would convert base mismatch into success. The upsert carries
 * promotion's `changed_generation` guard, so a recomposed delta re-upserting an
 * already-landed value leaves that row's generation exactly as promotion would.
 */
export function applyDeltaOpsIntoPlane(
  db: Database,
  lineageId: string,
  plane: Plane,
  generation: number,
  delta: DeltaApplication,
): void {
  const absent = selectRow<{ path: string }>(db, `SELECT d.path FROM ${CAS_DELTA_DELETES} d
    WHERE NOT EXISTS(SELECT 1 FROM plane_entries p
      WHERE p.lineage_id=? AND p.plane=? AND p.path=d.path) LIMIT 1`, lineageId, plane);
  if (absent) {
    throw new StageChangedError(delta.stageId, `delta deletes ${absent.path}, which the plane does not hold`);
  }
  runStatement(db, `DELETE FROM plane_entries WHERE lineage_id=? AND plane=?
    AND path IN (SELECT path FROM ${CAS_DELTA_DELETES})`, lineageId, plane);
  internStagedEntryValues(db, CAS_DELTA_UPSERTS);
  runStatement(db, `INSERT INTO plane_entries(lineage_id,plane,path,path_order,entry_id,changed_generation)
    SELECT ?,?,f.path,f.path_order,f.entry_id,? FROM ${CAS_DELTA_UPSERTS} f
    WHERE NOT EXISTS(SELECT 1 FROM plane_entries p
      WHERE p.lineage_id=? AND p.plane=? AND p.path=f.path AND p.entry_id=f.entry_id)
    ON CONFLICT(lineage_id,plane,path) DO UPDATE SET
      path_order=excluded.path_order, entry_id=excluded.entry_id,
      changed_generation=excluded.changed_generation`, lineageId, plane, generation, lineageId, plane);
  const held = selectRow<{ files: number }>(db,
    "SELECT COUNT(*) AS files FROM plane_entries WHERE lineage_id=? AND plane=?", lineageId, plane);
  if (held?.files !== delta.resultFiles) {
    throw new StageChangedError(delta.stageId,
      `delta left ${held?.files ?? 0} files in the plane, sealed ${delta.resultFiles}`);
  }
}

/** GC: an interned value is collectable only once no plane row references it. */
export function collectUnreferencedEntryValues(db: Database): number {
  return withStatement(db, `DELETE FROM entry_values WHERE NOT EXISTS(
    SELECT 1 FROM plane_entries p WHERE p.entry_id=entry_values.entry_id)`,
  (statement) => statement.run().changes);
}
