-- Design 225: active_bytes is computed at HEAD only (no retained-history walk).
--
-- history_computed defaults to 1 — NOT 0. Existing completed rows genuinely did
-- compute history through classify_entitlements, and billing reads the latest
-- completed row, so a 0 default would blank a correct historyBytes on rows that
-- earned it. The new active-only path writes 0 explicitly.
ALTER TABLE fairuse_scans ADD COLUMN history_computed INTEGER NOT NULL DEFAULT 1 CHECK(history_computed IN (0,1));
ALTER TABLE fairuse_scans ADD COLUMN entitlement_missing_count INTEGER NOT NULL DEFAULT 0 CHECK(entitlement_missing_count>=0);

-- ONE row per workspace-GROUP (workspace_id), never per stream: dedup is a
-- property of the KEK scope, and two projects of one workspace_id can share a
-- sha. Row existence is the completion marker; active_bytes=0 is a computed
-- zero (pristine/empty workspace), never "not measured". The row is written
-- once and never added to — an incremental `active_bytes = active_bytes + ?`
-- would double-count a sha shared across the group's projects.
CREATE TABLE IF NOT EXISTS fairuse_workspace_group_totals (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  active_bytes INTEGER NOT NULL CHECK(active_bytes>=0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,epoch,workspace_id)
) WITHOUT ROWID;

-- Cross-tick checkpoint for the entitlement intersection of ONE group. It is what
-- removes any account-level ref cap: an account of any blob_refs cardinality makes
-- progress 48 pages at a time. Deleted in the same batch that writes the group's
-- totals row, so a totals row and a progress row never coexist.
CREATE TABLE IF NOT EXISTS fairuse_group_progress (
  account_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  cursor_sha TEXT NOT NULL,
  partial_bytes INTEGER NOT NULL CHECK(partial_bytes>=0),
  found_refs INTEGER NOT NULL CHECK(found_refs>=0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,epoch,workspace_id)
) WITHOUT ROWID;
