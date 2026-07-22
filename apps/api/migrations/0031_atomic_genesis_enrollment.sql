-- Design 180: atomic genesis publication and permanently-audited orphan repair.
-- Nullable columns keep the rollout read-before-write compatible with older Workers.

ALTER TABLE account_keys ADD COLUMN genesis_device_id TEXT;
ALTER TABLE account_keys ADD COLUMN repair_id TEXT;
ALTER TABLE account_keys ADD COLUMN repaired_at INTEGER;

CREATE UNIQUE INDEX account_keys_repair_id_unique
  ON account_keys(repair_id) WHERE repair_id IS NOT NULL;

CREATE TABLE genesis_repair_audit (
  audit_id TEXT PRIMARY KEY,
  account_id TEXT,
  operator TEXT,
  reason TEXT,
  requested_at INTEGER NOT NULL,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  observed_classification TEXT,
  proof_json TEXT,
  original_claim_present INTEGER CHECK (original_claim_present IN (0, 1)),
  original_claim_snapshot BLOB,
  original_recovery_wrap BLOB,
  original_recovery_wrap_id BLOB,
  original_created_at INTEGER,
  original_genesis_device_id TEXT,
  original_repair_id TEXT,
  original_repaired_at INTEGER,
  outcome TEXT NOT NULL,
  result_vector TEXT,
  completion_observation_json TEXT,
  completed_at INTEGER,
  scrubbed_at INTEGER,
  scrubbed_evidence_sha256 TEXT
);

CREATE INDEX genesis_repair_audit_account_outcome
  ON genesis_repair_audit(account_id, outcome);
