/**
 * The one transaction that turns a legacy row plan into a schema-v1 store
 * (design 163 M3, design 222 §M-5).
 *
 * Split out of `import-json.ts` because that module owns four filesystem
 * protocols and this owns none: everything here runs inside the installer
 * callback of `adoptClaimedStateStore`, on a connection the caller proved it
 * owns, and it never learns a path.
 *
 * `migration_completion` is inserted LAST, inside the same transaction, so a
 * rollback or `SQLITE_FULL` can leave no complete record — the row's presence
 * IS the import's durable witness, and M-5 rereads it before publishing M3.
 */
import type { Database } from "bun:sqlite";
import { encodeFileEntry } from "../codecs/file-entry.js";
import { encodeRepoRecord, REPO_RECORD_COLUMN_BY_FIELD } from "../codecs/repo-record.js";
import { canonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { sourceShapeFlagsCjson } from "../digest/source-shape.js";
import type { NormalizedLegacyState } from "../digest/legacy-state-plan.js";
import {
  STATE_STORE_APPLICATION_ID, STATE_STORE_DDL_FINGERPRINT, STATE_STORE_SCHEMA_VERSION,
} from "../schema/application.js";
import type { CompletionTuple } from "./control-codec.js";

/** What the import records about where it came from. `completedAt` is derived
 * from the stored text rather than sampled twice: the durable row is the only
 * clock this protocol has, and a second `Date.now()` would make the control
 * record unable to recur after a crash. */
export interface ImportProvenance {
  readonly migrationId: string;
  readonly authorityId: string;
  readonly importerVersion: string;
  readonly sourceJsonSha256: string;
  readonly sourceSemanticDigest: string;
  readonly sourceBytes: number;
  readonly completedAtIso: string;
}

const REPO_VALUE_COLUMNS = Object.values(REPO_RECORD_COLUMN_BY_FIELD)
  .filter((column) => column !== "repo_gen" && column !== "source_seq");

/**
 * Prepare, use, finalize — never `db.query`.
 *
 * `db.query` caches its statement on the connection and the cached statement
 * outlives the call. A connection that still holds one cannot let SQLite remove
 * `-wal`/`-shm` when it closes, so the database never reaches `S0` and M4's
 * at-rest proof fails on exactly the workspaces with the most rows. Empirically
 * confirmed against the fixture: the leak appeared only once the manifest-meta
 * and Git-section inserts existed to be cached.
 */
function statement<T>(db: Database, sql: string, use: (run: (...args: unknown[]) => void) => T): T {
  const prepared = db.prepare(sql);
  try {
    return use((...args) => { prepared.run(...args as never[]); });
  } finally {
    prepared.finalize();
  }
}

function installEntries(db: Database, plan: NormalizedLegacyState): void {
  statement(db, `INSERT INTO entry_values(
    entry_id,exact_fingerprint,path,path_order,sha256,size,mode,mtime_ms,kind,
    symlink_target,enc_sha,comp,payload_sha,cipher_size,extras_cjson,canonical_bytes,retained_estimate
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, (value) => {
    statement(db, `INSERT INTO plane_entries(
      lineage_id,plane,path,path_order,entry_id,changed_generation
    ) VALUES (?,'base',?,?,?,?)`, (placement) => {
      for (const entry of plan.entries) {
        const row = encodeFileEntry(entry);
        value(
          row.entryId, row.exactFingerprint, row.path, row.pathOrder, row.sha256,
          row.size, row.mode, row.mtimeMs, row.kind, row.symlinkTarget,
          row.encSha, row.comp, row.payloadSha, row.cipherSize, row.extrasCjson,
          row.canonicalBytes, row.retainedEstimate,
        );
        placement(plan.lineage.lineage_id, row.path, row.pathOrder, row.entryId, plan.baseHead.generation);
      }
    });
  });
}

function installRepos(db: Database, plan: NormalizedLegacyState): void {
  const columns = ["lineage_id", "rel_path", "path_order", "repo_gen", "source_seq",
    ...REPO_VALUE_COLUMNS, "extras_cjson", "canonical_bytes", "retained_estimate"];
  statement(db, `INSERT INTO repo_records(${columns.join(",")})
    VALUES (${columns.map(() => "?").join(",")})`, (insert) => {
    for (const { relPath, record } of plan.repos) {
      const row = encodeRepoRecord(relPath, record);
      insert(
        plan.lineage.lineage_id, relPath, row.pathOrder, row.repoGen, row.sourceSeq,
        ...REPO_VALUE_COLUMNS.map((column) => row.values[column] ?? null),
        row.extrasCjson, row.canonicalBytes, row.retainedEstimate,
      );
    }
  });
}

function installManifestLayer(db: Database, plan: NormalizedLegacyState): void {
  const lineage = plan.lineage.lineage_id;
  const meta = plan.manifestMeta;
  if (meta) {
    statement(db, `INSERT INTO global_manifest_meta(
      lineage_id,base_generation,enc_manifest_sha,manifest_hash,account_epoch,key_epoch,
      chain_bytes,snapshot_bytes,extras_cjson
    ) VALUES (?,?,?,?,?,?,?,?,?)`, (insert) => insert(
      lineage, meta.baseGeneration,
      Buffer.from(meta.encManifestSha, "hex"), Buffer.from(meta.manifestHash, "hex"),
      meta.accountEpoch, meta.keyEpoch, meta.chainBytes, meta.snapshotBytes,
      meta.extras === undefined ? null : canonicalJson(meta.extras),
    ));
    statement(db, "INSERT INTO manifest_chain(lineage_id,base_generation,ordinal,enc_sha) VALUES (?,?,?,?)",
      (insert) => {
        for (const [ordinal, encSha] of plan.chain.entries()) {
          insert(lineage, meta.baseGeneration, ordinal, Buffer.from(encSha, "hex"));
        }
      });
  }
  statement(db, `INSERT INTO manifest_git_sections(
    lineage_id,base_generation,role,rel_path,path_order,section_cjson
  ) VALUES (?,?,?,?,?,?)`, (insert) => {
    for (const row of plan.gitSections) {
      insert(lineage, plan.baseHead.generation, row.role, row.relPath,
        utf16beOrderKey(row.relPath), canonicalJson(row.section));
    }
  });
}

/**
 * Install the plan and return the completion tuple exactly as it was committed.
 * The tuple is read back out of the row rather than assembled from the inputs,
 * so what M-5 publishes is what the database actually holds.
 */
export function installLegacyState(
  db: Database, plan: NormalizedLegacyState, provenance: ImportProvenance,
): CompletionTuple {
  const lineage = plan.lineage;
  const perTableCounts = {
    entry_values: plan.entries.length,
    plane_entries: plan.entries.length,
    repo_records: plan.repos.length,
  };
  const install = db.transaction(() => {
    statement(db, `INSERT INTO state_lineage(
      lineage_id,stream,state_nonce,state_revision,last_synced_sequence,
      active_base_generation,local_revision,telemetry_binding_id,
      repo_records_authoritative,extras_cjson
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`, (insert) => insert(
      lineage.lineage_id, lineage.stream, lineage.state_nonce, lineage.state_revision,
      lineage.last_synced_sequence, lineage.active_base_generation, lineage.local_revision,
      lineage.telemetry_binding_id, lineage.repo_records_authoritative, lineage.extras_cjson,
    ));
    statement(db, `INSERT INTO store_meta(
      singleton,application_id,schema_version,ddl_fingerprint,authority_id,active_lineage_id,created_by
    ) VALUES (1,?,?,?,?,?,?)`, (insert) => insert(
      STATE_STORE_APPLICATION_ID, STATE_STORE_SCHEMA_VERSION, STATE_STORE_DDL_FINGERPRINT,
      provenance.authorityId, lineage.lineage_id, provenance.importerVersion,
    ));
    statement(db, `INSERT INTO plane_heads(
      lineage_id,plane,generation,generated_at,manifest_schema,source_sequence,trust_epoch,complete,extras_cjson
    ) VALUES (?,?,?,?,?,?,?,?,?)`, (insert) => {
      for (const row of [plan.baseHead, plan.localHead]) {
        insert(row.lineage_id, row.plane, row.generation, row.generated_at,
          row.manifest_schema, row.source_sequence, row.trust_epoch, row.complete, row.extras_cjson);
      }
    });
    installEntries(db, plan);
    installManifestLayer(db, plan);
    installRepos(db, plan);
    statement(db, "INSERT INTO legacy_state_maps(migration_id,field,rel_path,value_cjson) VALUES (?,?,?,?)",
      (insert) => {
        for (const row of plan.legacyMaps) {
          insert(provenance.migrationId, row.field, row.relPath, canonicalJson(row.value));
        }
      });
    statement(db, `INSERT INTO migration_completion(
      singleton,origin_kind,migration_id,importer_version,authority_id,
      source_json_sha256,source_semantic_digest,source_bytes,source_shape_flags_cjson,
      source_repo_records_present,entry_count,repo_count,per_table_counts_cjson,completed_at
    ) VALUES (1,'migration',?,?,?,?,?,?,?,?,?,?,?,?)`, (insert) => insert(
      provenance.migrationId, provenance.importerVersion, provenance.authorityId,
      provenance.sourceJsonSha256, provenance.sourceSemanticDigest, provenance.sourceBytes,
      sourceShapeFlagsCjson(plan.shapeFlags), plan.repoRecordsPresent ? 1 : 0,
      plan.entries.length, plan.repos.length, canonicalJson(perTableCounts),
      provenance.completedAtIso,
    ));
  });
  install();
  return readCompletionTuple(db);
}

/**
 * The committed completion tuple, as the M3 witness records it. Called both at
 * the end of the import and on every resume that finds a staging main already
 * carrying one — the same read either way, so the control record a crashed
 * attempt would have published is byte-for-byte the one the resume publishes.
 */
export function readCompletionTuple(db: Database): CompletionTuple {
  const prepared = db.prepare(`SELECT origin_kind,migration_id,importer_version,authority_id,
    source_json_sha256,source_semantic_digest,source_bytes,entry_count,repo_count,
    per_table_counts_cjson,completed_at FROM migration_completion WHERE singleton=1`);
  let row: {
    origin_kind: string; migration_id: string; importer_version: string; authority_id: string;
    source_json_sha256: string | null; source_semantic_digest: string | null; source_bytes: number | null;
    entry_count: number; repo_count: number; per_table_counts_cjson: string; completed_at: string;
  } | null;
  try {
    row = prepared.get() as typeof row;
  } finally {
    prepared.finalize();
  }
  if (!row) throw new Error("the imported store carries no migration_completion row");
  if (row.origin_kind !== "migration") throw new Error(`imported store records origin ${row.origin_kind}`);
  if (row.source_json_sha256 === null || row.source_semantic_digest === null || row.source_bytes === null) {
    throw new Error("the imported completion row has no source provenance");
  }
  const completedAt = Date.parse(row.completed_at);
  if (!Number.isSafeInteger(completedAt) || new Date(completedAt).toISOString() !== row.completed_at) {
    throw new Error("the imported completion row has no exact millisecond timestamp");
  }
  const counts = JSON.parse(row.per_table_counts_cjson) as Record<string, number>;
  return {
    migrationId: row.migration_id,
    importerVersion: row.importer_version,
    authorityId: row.authority_id,
    sourceJsonSha256: row.source_json_sha256,
    sourceSemanticDigest: row.source_semantic_digest,
    sourceBytes: row.source_bytes,
    entryCount: row.entry_count,
    repoCount: row.repo_count,
    perTableCounts: counts,
    completedAt,
  };
}
