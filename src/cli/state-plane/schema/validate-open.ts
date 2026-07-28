import type { Database } from "bun:sqlite";
import { StateStoreOpenError } from "../errors.js";
import {
  STATE_STORE_APPLICATION_ID,
  STATE_STORE_DDL_FINGERPRINT,
  STATE_STORE_SCHEMA_VERSION,
  STATE_STORE_SQLITE_APPLICATION_ID,
  STATE_STORE_SQLITE_USER_VERSION,
} from "./application.js";

const REQUIRED_SCHEMA_OBJECTS = [
  "store_meta", "state_lineage", "migration_completion", "entry_values",
  "entry_values_fingerprint", "plane_heads", "plane_entries", "plane_entries_order",
  "global_manifest_meta", "manifest_chain", "manifest_git_sections",
  "manifest_git_sections_order", "repo_records", "repo_records_order",
  "legacy_state_maps", "base_head_matches_lineage_update", "local_head_matches_lineage_update",
  "lineage_base_generation_guard", "lineage_local_revision_guard",
  "global_meta_generation_guard", "manifest_chain_generation_guard", "manifest_git_generation_guard",
] as const;

function sqliteCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function isMissingStoreMeta(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*(?:main\.)?store_meta\b/i.test(error.message);
}

export interface StoreHeader {
  application_id: string;
  schema_version: number;
  ddl_fingerprint: string;
  authority_id: string;
  active_lineage_id: string;
  created_by: string;
}

export function validateOpen(db: Database, file: string): StoreHeader {
  let header: StoreHeader | null;
  try {
    header = db.query(`SELECT application_id,schema_version,ddl_fingerprint,
      authority_id,active_lineage_id,created_by FROM store_meta WHERE singleton=1`).get() as StoreHeader | null;
  } catch (error) {
    const code = sqliteCode(error);
    throw new StateStoreOpenError(
      code === "SQLITE_NOTADB"
        ? "not-a-database"
        : code === "SQLITE_CORRUPT"
          ? "corrupt"
          : isMissingStoreMeta(error)
            ? "foreign-by-absence"
            : "structural-invariant",
      file,
      code ?? String(error),
      error,
    );
  }
  if (!header) throw new StateStoreOpenError("structural-invariant", file, "missing store_meta singleton");
  if (header.application_id !== STATE_STORE_APPLICATION_ID) {
    throw new StateStoreOpenError("wrong-application", file, `application is ${header.application_id}`);
  }
  if (header.schema_version !== STATE_STORE_SCHEMA_VERSION) {
    throw new StateStoreOpenError("wrong-schema-version", file, `schema is ${header.schema_version}, expected ${STATE_STORE_SCHEMA_VERSION}`);
  }
  if (header.ddl_fingerprint !== STATE_STORE_DDL_FINGERPRINT) {
    throw new StateStoreOpenError("ddl-fingerprint", file, "frozen DDL fingerprint mismatch");
  }
  const applicationId = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id;
  const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (applicationId !== STATE_STORE_SQLITE_APPLICATION_ID || userVersion !== STATE_STORE_SQLITE_USER_VERSION) {
    throw new StateStoreOpenError("wrong-application", file, `SQLite identity is application=${applicationId}, user_version=${userVersion}`);
  }
  const objects = db.query(`SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
  const names = new Set(objects.map((row) => row.name));
  const missing = REQUIRED_SCHEMA_OBJECTS.filter((name) => !names.has(name));
  if (missing.length) throw new StateStoreOpenError("ddl-fingerprint", file, `required schema objects missing: ${missing.join(",")}`);
  const invariants = db.query(`SELECT
    (SELECT count(*) FROM store_meta) AS metas,
    (SELECT count(*) FROM state_lineage) AS lineages,
    (SELECT count(*) FROM migration_completion c WHERE c.authority_id=?) AS completions,
    (SELECT count(*) FROM plane_heads WHERE lineage_id=? AND plane='base') AS base_heads,
    (SELECT count(*) FROM plane_heads WHERE lineage_id=? AND plane='local') AS local_heads,
    (SELECT count(*) FROM state_lineage l JOIN plane_heads b ON b.lineage_id=l.lineage_id AND b.plane='base'
      JOIN plane_heads p ON p.lineage_id=l.lineage_id AND p.plane='local'
      WHERE l.lineage_id=? AND l.active_base_generation=b.generation AND l.local_revision=p.generation) AS coherent
  `).get(header.authority_id, header.active_lineage_id, header.active_lineage_id, header.active_lineage_id) as Record<string, number>;
  if (Object.values(invariants).some((value) => value !== 1)) {
    throw new StateStoreOpenError("structural-invariant", file, `singleton/head invariant failed: ${JSON.stringify(invariants)}`);
  }
  return header;
}
