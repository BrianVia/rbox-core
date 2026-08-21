import type { Database } from "bun:sqlite";
import { canonicalJson } from "../digest/codecs.js";
import { genesisSourcePresenceFlags, sourcePresenceFlagsCjson } from "../digest/source-shape.js";
import { SCHEMA_V1_DDL } from "./v1.js";
import { runStatement } from "../store/statements.js";

export const STATE_STORE_APPLICATION_ID = "rbox-state-plane";
export const STATE_STORE_SCHEMA_VERSION = 1;
export const STATE_STORE_SQLITE_APPLICATION_ID = 0x52424f58;
export const STATE_STORE_SQLITE_USER_VERSION = 1;
export const STATE_STORE_DDL_FINGERPRINT = "94b519282f6efaed3c51b96e0bf0ca6b998922f149a0600501eedc0cb2224695";

export interface GenesisLineage {
  stream: string;
  authorityId: string;
  lineageId: string;
  createdBy: string;
  stateNonce?: string;
  stateRevision?: number;
  telemetryBindingId?: string;
}

export function applySchemaV1(db: Database): void {
  db.exec(SCHEMA_V1_DDL);
}

export function installGenesisLineage(db: Database, genesis: GenesisLineage): void {
  if (!/^[0-9a-f]{32}$/.test(genesis.authorityId)) throw new TypeError("authorityId must be lowercase hex32");
  if (!/^[0-9a-f]{32}$/.test(genesis.lineageId)) throw new TypeError("lineageId must be lowercase hex32");
  if (!genesis.stream || Buffer.byteLength(genesis.stream) > 4096) throw new TypeError("stream must be nonempty bounded text");
  if (!genesis.createdBy || Buffer.byteLength(genesis.createdBy) > 256) throw new TypeError("createdBy must be nonempty bounded text");
  if (genesis.stateNonce !== undefined && !/^[0-9a-f]{32}$/.test(genesis.stateNonce)) throw new TypeError("stateNonce must be lowercase hex32");
  if (genesis.stateRevision !== undefined && (!Number.isSafeInteger(genesis.stateRevision) || genesis.stateRevision < 0)) {
    throw new TypeError("stateRevision must be a nonnegative safe integer");
  }
  if (genesis.telemetryBindingId !== undefined && !/^[0-9a-f]{16}$/.test(genesis.telemetryBindingId)) {
    throw new TypeError("telemetryBindingId must be lowercase hex16");
  }
  const initialize = db.transaction(() => {
    runStatement(db, `INSERT INTO state_lineage(
      lineage_id,stream,state_nonce,state_revision,last_synced_sequence,
      active_base_generation,local_revision,telemetry_binding_id,
      repo_records_authoritative,extras_cjson
    ) VALUES (?,?,?,?,0,0,0,?,1,NULL)`,
      genesis.lineageId,
      genesis.stream,
      genesis.stateNonce ?? null,
      genesis.stateRevision ?? null,
      genesis.telemetryBindingId ?? null,
    );
    runStatement(db, `INSERT INTO store_meta(
      singleton,application_id,schema_version,ddl_fingerprint,authority_id,active_lineage_id,created_by
    ) VALUES (1,?,?,?,?,?,?)`,
      STATE_STORE_APPLICATION_ID,
      STATE_STORE_SCHEMA_VERSION,
      STATE_STORE_DDL_FINGERPRINT,
      genesis.authorityId,
      genesis.lineageId,
      genesis.createdBy,
    );
    const head = db.prepare(`INSERT INTO plane_heads(
      lineage_id,plane,generation,generated_at,manifest_schema,source_sequence,trust_epoch,complete,extras_cjson
    ) VALUES (?,?,0,'',NULL,?,NULL,?,NULL)`);
    head.run(genesis.lineageId, "base", 0, 1);
    // LOCAL starts incomplete: no full filesystem scan has established a
    // trust epoch for this new lineage.
    head.run(genesis.lineageId, "local", null, 0);
    head.finalize();
    runStatement(db, `INSERT INTO migration_completion(
      singleton,origin_kind,migration_id,importer_version,authority_id,
      source_json_sha256,source_semantic_digest,source_bytes,source_presence_flags_cjson,
      source_repo_records_present,entry_count,repo_count,per_table_counts_cjson,completed_at
    ) VALUES (1,'genesis',?,?,?,NULL,NULL,NULL,?,0,0,0,?,?)`,
      `genesis:${genesis.lineageId}`,
      genesis.createdBy,
      genesis.authorityId,
      sourcePresenceFlagsCjson(genesisSourcePresenceFlags({
        stateNonce: genesis.stateNonce !== undefined,
        stateRevision: genesis.stateRevision !== undefined,
      })),
      canonicalJson({ entry_values: 0, plane_entries: 0, repo_records: 0 }),
      new Date().toISOString(),
    );
  });
  initialize();
}
