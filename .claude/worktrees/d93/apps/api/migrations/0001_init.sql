-- rbox dev control plane (minimal).
-- Faithful to v2 where it matters: manifests are content-addressed blobs in R2,
-- D1 holds only a pointer row per committed version (D4). Multi-tenant accounts/
-- devices/memberships are stubbed for the dev harness (shared bearer token).

CREATE TABLE IF NOT EXISTS blobs (
  sha256     TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS manifests (
  workspace_id      TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  sequence          INTEGER NOT NULL,
  manifest_blob_sha TEXT NOT NULL,
  device_id         TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, project_id, sequence)
);
