/** Frozen behavior-free schema-v1 DDL. Keep column names in normative design
 * order: the schema-rebase test treats the RepoRecord list as a contract. */
export const SCHEMA_V1_DDL = `
CREATE TABLE store_meta(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  application_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  ddl_fingerprint TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  active_lineage_id TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  FOREIGN KEY(active_lineage_id) REFERENCES state_lineage(lineage_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE state_lineage(
  lineage_id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  state_nonce TEXT CHECK(state_nonce IS NULL OR (length(state_nonce)=32 AND state_nonce NOT GLOB '*[^0-9a-f]*')),
  state_revision INTEGER CHECK(state_revision IS NULL OR state_revision>=0),
  last_synced_sequence INTEGER NOT NULL CHECK(last_synced_sequence>=0),
  active_base_generation INTEGER NOT NULL CHECK(active_base_generation>=0),
  local_revision INTEGER NOT NULL CHECK(local_revision>=0),
  telemetry_binding_id TEXT CHECK(telemetry_binding_id IS NULL OR (length(telemetry_binding_id)=16 AND telemetry_binding_id NOT GLOB '*[^0-9a-f]*')),
  repo_records_authoritative INTEGER NOT NULL CHECK(repo_records_authoritative=1),
  extras_cjson TEXT
);
CREATE TABLE migration_completion(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  origin_kind TEXT NOT NULL CHECK(origin_kind IN ('migration','genesis')),
  migration_id TEXT NOT NULL,
  importer_version TEXT NOT NULL,
  authority_id TEXT NOT NULL,
  source_json_sha256 TEXT,
  source_semantic_digest TEXT,
  source_bytes INTEGER,
  source_shape_flags_cjson TEXT NOT NULL,
  source_repo_records_present INTEGER NOT NULL CHECK(source_repo_records_present IN (0,1)),
  entry_count INTEGER NOT NULL CHECK(entry_count>=0),
  repo_count INTEGER NOT NULL CHECK(repo_count>=0),
  per_table_counts_cjson TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE TABLE entry_values(
  entry_id TEXT PRIMARY KEY,
  exact_fingerprint TEXT NOT NULL,
  path TEXT NOT NULL,
  path_order BLOB NOT NULL,
  sha256 BLOB NOT NULL CHECK(length(sha256)=32),
  size NUMERIC NOT NULL CHECK(size>=0),
  mode INTEGER NOT NULL CHECK(mode BETWEEN 0 AND 4095),
  mtime_ms REAL NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file','symlink')),
  symlink_target TEXT,
  enc_sha BLOB CHECK(enc_sha IS NULL OR length(enc_sha)=32),
  comp TEXT CHECK(comp IS NULL OR comp='zstd'),
  payload_sha BLOB CHECK(payload_sha IS NULL OR length(payload_sha)=32),
  cipher_size NUMERIC CHECK(cipher_size IS NULL OR cipher_size>=0),
  extras_cjson TEXT,
  canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes BETWEEN 1 AND 4194304),
  retained_estimate INTEGER NOT NULL CHECK(retained_estimate BETWEEN 1 AND 16777216),
  UNIQUE(entry_id,path,path_order),
  CHECK((comp IS NULL)=(payload_sha IS NULL)),
  CHECK((comp IS NULL)=(cipher_size IS NULL)),
  CHECK(kind!='symlink' OR (symlink_target IS NOT NULL AND length(symlink_target)>0))
);
CREATE INDEX entry_values_fingerprint ON entry_values(exact_fingerprint);
CREATE TABLE plane_heads(
  lineage_id TEXT NOT NULL,
  plane TEXT NOT NULL CHECK(plane IN ('base','local')),
  generation INTEGER NOT NULL CHECK(generation>=0),
  generated_at TEXT NOT NULL,
  manifest_schema INTEGER CHECK(manifest_schema IS NULL OR manifest_schema>=1),
  source_sequence INTEGER CHECK(source_sequence IS NULL OR source_sequence>=0),
  trust_epoch TEXT,
  complete INTEGER NOT NULL CHECK(complete IN (0,1)),
  extras_cjson TEXT,
  PRIMARY KEY(lineage_id,plane),
  FOREIGN KEY(lineage_id) REFERENCES state_lineage(lineage_id) ON DELETE CASCADE,
  CHECK(plane!='base' OR complete=1)
);
CREATE TABLE plane_entries(
  lineage_id TEXT NOT NULL,
  plane TEXT NOT NULL,
  path TEXT NOT NULL,
  path_order BLOB NOT NULL,
  entry_id TEXT NOT NULL,
  changed_generation INTEGER NOT NULL CHECK(changed_generation>=0),
  PRIMARY KEY(lineage_id,plane,path),
  FOREIGN KEY(lineage_id,plane) REFERENCES plane_heads(lineage_id,plane) ON DELETE CASCADE,
  FOREIGN KEY(entry_id,path,path_order) REFERENCES entry_values(entry_id,path,path_order)
);
CREATE INDEX plane_entries_order ON plane_entries(lineage_id,plane,path_order);
CREATE TABLE global_manifest_meta(
  lineage_id TEXT PRIMARY KEY,
  base_generation INTEGER NOT NULL CHECK(base_generation>=0),
  enc_manifest_sha BLOB NOT NULL CHECK(length(enc_manifest_sha)=32),
  manifest_hash BLOB NOT NULL CHECK(length(manifest_hash)=32),
  account_epoch INTEGER NOT NULL CHECK(account_epoch>=0),
  key_epoch INTEGER NOT NULL CHECK(key_epoch>=0),
  chain_bytes INTEGER NOT NULL CHECK(chain_bytes>=0),
  snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes>0),
  extras_cjson TEXT,
  FOREIGN KEY(lineage_id) REFERENCES state_lineage(lineage_id) ON DELETE CASCADE
);
CREATE TABLE manifest_chain(
  lineage_id TEXT NOT NULL,
  base_generation INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  enc_sha BLOB NOT NULL CHECK(length(enc_sha)=32),
  PRIMARY KEY(lineage_id,base_generation,ordinal),
  FOREIGN KEY(lineage_id) REFERENCES state_lineage(lineage_id) ON DELETE CASCADE,
  UNIQUE(lineage_id,base_generation,enc_sha)
);
CREATE TABLE manifest_git_sections(
  lineage_id TEXT NOT NULL,
  base_generation INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('meta-wire','manifest-projection')),
  rel_path TEXT NOT NULL,
  path_order BLOB NOT NULL,
  section_cjson TEXT NOT NULL,
  PRIMARY KEY(lineage_id,base_generation,role,rel_path),
  FOREIGN KEY(lineage_id) REFERENCES state_lineage(lineage_id) ON DELETE CASCADE
);
CREATE INDEX manifest_git_sections_order
  ON manifest_git_sections(lineage_id,base_generation,role,path_order);
CREATE TABLE repo_records(
  lineage_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  path_order BLOB NOT NULL,
  repo_gen INTEGER NOT NULL CHECK(repo_gen>=0),
  source_seq INTEGER NOT NULL CHECK(source_seq>=0),
  base_cjson TEXT,
  advertised_cjson TEXT,
  branch_base_origins_cjson TEXT,
  packed_refs_identity TEXT,
  pending_cjson TEXT,
  repo_absent INTEGER CHECK(repo_absent=1),
  removed_key TEXT,
  resolution_key TEXT,
  cfg_synced TEXT,
  cfg_applied TEXT,
  cfg_token_cjson TEXT,
  cfg_shape_cjson TEXT,
  deferrals_cjson TEXT,
  partial_cjson TEXT,
  attempt_cjson TEXT,
  resolution_receipt_cjson TEXT,
  idx_proj TEXT,
  extras_cjson TEXT,
  canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes BETWEEN 1 AND 4194304),
  retained_estimate INTEGER NOT NULL CHECK(retained_estimate BETWEEN 1 AND 16777216),
  PRIMARY KEY(lineage_id,rel_path),
  FOREIGN KEY(lineage_id) REFERENCES state_lineage(lineage_id) ON DELETE CASCADE
);
CREATE INDEX repo_records_order ON repo_records(lineage_id,path_order);
CREATE TABLE legacy_state_maps(
  migration_id TEXT NOT NULL,
  field TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  value_cjson TEXT NOT NULL,
  PRIMARY KEY(migration_id,field,rel_path)
);
CREATE TRIGGER base_head_matches_lineage_update
AFTER UPDATE OF generation ON plane_heads WHEN NEW.plane='base'
BEGIN
  UPDATE state_lineage SET active_base_generation=NEW.generation WHERE lineage_id=NEW.lineage_id;
END;
CREATE TRIGGER local_head_matches_lineage_update
AFTER UPDATE OF generation ON plane_heads WHEN NEW.plane='local'
BEGIN
  UPDATE state_lineage SET local_revision=NEW.generation WHERE lineage_id=NEW.lineage_id;
END;
CREATE TRIGGER lineage_base_generation_guard
BEFORE UPDATE OF active_base_generation ON state_lineage
WHEN EXISTS(SELECT 1 FROM plane_heads WHERE lineage_id=NEW.lineage_id AND plane='base')
  AND NEW.active_base_generation<>(SELECT generation FROM plane_heads WHERE lineage_id=NEW.lineage_id AND plane='base')
BEGIN
  SELECT RAISE(ABORT,'active_base_generation must equal BASE head');
END;
CREATE TRIGGER lineage_local_revision_guard
BEFORE UPDATE OF local_revision ON state_lineage
WHEN EXISTS(SELECT 1 FROM plane_heads WHERE lineage_id=NEW.lineage_id AND plane='local')
  AND NEW.local_revision<>(SELECT generation FROM plane_heads WHERE lineage_id=NEW.lineage_id AND plane='local')
BEGIN
  SELECT RAISE(ABORT,'local_revision must equal LOCAL head');
END;
CREATE TRIGGER global_meta_generation_guard
BEFORE INSERT ON global_manifest_meta
WHEN NOT EXISTS(SELECT 1 FROM plane_heads WHERE lineage_id=NEW.lineage_id AND plane='base' AND generation=NEW.base_generation)
BEGIN
  SELECT RAISE(ABORT,'global meta must own active BASE generation');
END;
CREATE TRIGGER manifest_chain_generation_guard
BEFORE INSERT ON manifest_chain
WHEN NOT EXISTS(SELECT 1 FROM global_manifest_meta WHERE lineage_id=NEW.lineage_id AND base_generation=NEW.base_generation)
BEGIN
  SELECT RAISE(ABORT,'manifest chain must belong to global meta generation');
END;
CREATE TRIGGER manifest_git_generation_guard
BEFORE INSERT ON manifest_git_sections
WHEN NOT EXISTS(SELECT 1 FROM plane_heads WHERE lineage_id=NEW.lineage_id AND plane='base' AND generation=NEW.base_generation)
BEGIN
  SELECT RAISE(ABORT,'manifest Git section must belong to BASE generation');
END;
`;
