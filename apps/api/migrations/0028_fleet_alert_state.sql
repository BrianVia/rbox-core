-- Design 127: claim-fenced state for fleet push alerts.
CREATE TABLE alert_state (
  condition            TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  workspace_id         TEXT NOT NULL DEFAULT '',
  project_id           TEXT NOT NULL DEFAULT '',
  binding_id           TEXT NOT NULL DEFAULT '',
  incident_started_at  INTEGER NOT NULL,
  last_notified_at     INTEGER NOT NULL,
  resolved_at          INTEGER,
  resolve_notified_at  INTEGER,
  PRIMARY KEY (condition, device_id, workspace_id, project_id, binding_id)
);

