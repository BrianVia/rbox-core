/** Landing staged file values into a plane.
 *
 * One owner for the value-interning and plane-promotion SQL both save shapes
 * share: the connection-owned TEMP tables a verified artifact is copied into,
 * the by-value interning that mints ids, and the two promotions — the complete
 * stage's set-difference and the delta's targeted ops.
 */
import type { Database } from "bun:sqlite";
import type { ConsumedFileEntry } from "../codecs/file-entry.js";
import { StageChangedError } from "../errors.js";
import type { Plane } from "../ports.js";
import { MAX_FILE_BATCH, type ConsumedStageReader } from "./sealed-stages.js";
import { runStatement, selectRow, withStatement } from "./statements.js";

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
