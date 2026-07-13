-- Design 20 / 87: agent sync keys.
-- `devices` remains the bearer-token auth table; `api_keys` is descriptive
-- metadata keyed 1:1 by the real credential PK (`devices.token_hash`).

ALTER TABLE devices ADD COLUMN kind TEXT;

UPDATE devices
SET kind = CASE WHEN expires_at IS NULL THEN 'device' ELSE 'web' END
WHERE kind IS NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  token_hash     TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  display_prefix TEXT NOT NULL,
  enrolled       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys (account_id);
