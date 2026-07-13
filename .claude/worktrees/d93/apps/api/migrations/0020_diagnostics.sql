-- Opt-in support diagnostics uploads (`rbox doctor --report`).
--
-- The report body is plaintext support data the user explicitly consents to send.
-- D1 is the durable handle/audit index; R2 stores the opaque JSON blob under
-- `diagnostics/<accountId>/<reportId>.json` (never the content-addressed blob tree).
--
-- Upload ordering is row-first:
--   pending row -> R2 put -> stored update with bytes + sha256.
-- Pending rows older than 1h are swept as failed attempts; stored rows expire at 30d.

CREATE TABLE IF NOT EXISTS diagnostics_reports (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | stored
  bytes      INTEGER,
  sha256     TEXT,
  CHECK (status IN ('pending', 'stored'))
);

CREATE INDEX IF NOT EXISTS idx_diag_rate ON diagnostics_reports (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_diag_sweep ON diagnostics_reports (status, created_at);
