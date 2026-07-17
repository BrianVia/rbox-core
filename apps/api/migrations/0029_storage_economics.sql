-- Design 149 rollout step 1: shared Unit A/C schema. Runtime in this rollout
-- uses only the observe-only fair-use ledger; capability and enforcement code
-- ship in later rollout steps.

CREATE INDEX IF NOT EXISTS idx_devices_capability_population
ON devices(account_id,kind,last_seen_at,expires_at,last_seen_version,device_id)
WHERE revoked=0 AND kind IN ('device','api_key');

CREATE TABLE IF NOT EXISTS fairuse_scans (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>0),
  status TEXT NOT NULL CHECK(status IN (
    'capture_pins','materialize_roots','classify_entitlements','complete',
    'pruning','converged','aborted_pins','paused_grace',
    'invalidated_plan','paused_kill')),
  plan_snapshot TEXT NOT NULL,
  grace_until_snapshot INTEGER,
  roots_format_generation INTEGER NOT NULL,
  workspace_set_snapshot TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  workspace_cursor_created_at INTEGER,
  workspace_cursor_id TEXT,
  workspace_cursor_project TEXT,
  entitlement_cursor_sha TEXT,
  verify_cursor_id TEXT,
  verify_cursor_project TEXT,
  release_checkpoint TEXT,
  pending_prune_request TEXT,
  active_bytes INTEGER NOT NULL DEFAULT 0 CHECK(active_bytes>=0),
  history_bytes INTEGER NOT NULL DEFAULT 0 CHECK(history_bytes>=0),
  bound_bytes INTEGER NOT NULL DEFAULT 0 CHECK(bound_bytes>=0),
  pruning_active INTEGER NOT NULL DEFAULT 0 CHECK(pruning_active IN (0,1)),
  PRIMARY KEY(account_id,epoch)
);
CREATE INDEX IF NOT EXISTS idx_fairuse_scans_latest
ON fairuse_scans(account_id,completed_at DESC,epoch DESC)
WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS fairuse_workspace_streams (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pin_head INTEGER NOT NULL CHECK(pin_head>=0),
  pin_floor INTEGER NOT NULL CHECK(pin_floor>=0),
  pin_generation INTEGER NOT NULL CHECK(pin_generation>=0),
  pin_roots_format_generation INTEGER NOT NULL,
  roots_cursor TEXT,
  materialize_cursor TEXT,
  roots_done INTEGER NOT NULL DEFAULT 0 CHECK(roots_done IN (0,1)),
  pins_verified INTEGER NOT NULL DEFAULT 0 CHECK(pins_verified IN (0,1)),
  root_rows INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,epoch,workspace_id,project_id)
);
CREATE INDEX IF NOT EXISTS idx_fairuse_workspace_pending
ON fairuse_workspace_streams(account_id,epoch,roots_done,workspace_id,project_id);

CREATE TABLE IF NOT EXISTS fairuse_root_membership (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  head INTEGER NOT NULL CHECK(head IN (0,1)),
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  committed_at INTEGER,
  timestamp_gap INTEGER NOT NULL DEFAULT 0 CHECK(timestamp_gap IN (0,1)),
  PRIMARY KEY(account_id,epoch,workspace_id,project_id,sha256,head,sequence)
);
CREATE INDEX IF NOT EXISTS idx_fairuse_roots_membership
ON fairuse_root_membership(account_id,epoch,sha256,head);
CREATE INDEX IF NOT EXISTS idx_fairuse_roots_candidate
ON fairuse_root_membership(
  account_id,epoch,workspace_id,project_id,head,sequence,sha256
);

CREATE TABLE IF NOT EXISTS fairuse_sha_last (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  last_ws TEXT NOT NULL,
  last_proj TEXT NOT NULL,
  last_seq INTEGER NOT NULL CHECK(last_seq>=0),
  in_head INTEGER NOT NULL CHECK(in_head IN (0,1)),
  PRIMARY KEY(account_id,epoch,sha256)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_fairuse_sha_last_release
ON fairuse_sha_last(
  account_id,epoch,in_head,last_ws,last_proj,last_seq,sha256
);

CREATE TABLE IF NOT EXISTS fairuse_materialize_refs (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  PRIMARY KEY(account_id,epoch,workspace_id,project_id,sequence,sha256)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS fairuse_leases (
  account_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fairuse_scheduler (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  account_cursor TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fairuse_account_queue (
  account_id TEXT PRIMARY KEY,
  next_run_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fairuse_queue_due
ON fairuse_account_queue(next_run_at,account_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_account_scan
ON workspaces(account_id,created_at,workspace_id,project_id);

CREATE TABLE IF NOT EXISTS meta_deploy_floor (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
