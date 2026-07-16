CREATE TABLE device_sync_state (
  device_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  file_seq INTEGER NOT NULL,
  repos_total INTEGER NOT NULL,
  repos_deferred INTEGER NOT NULL,
  oldest_deferral_age_ms INTEGER,
  deferral_reasons TEXT NOT NULL DEFAULT '',
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, workspace_id, project_id, binding_id)
);
