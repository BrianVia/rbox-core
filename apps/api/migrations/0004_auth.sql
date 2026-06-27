-- M4: self-hosted device-token auth. Replaces the shared cleartext bearer token
-- with per-device, revocable tokens validated by their sha256 hash (the token
-- itself is never stored). `device_auth` holds in-flight device-authorization
-- requests (bootstrap or device-to-device approval).

CREATE TABLE IF NOT EXISTS devices (
  token_hash   TEXT PRIMARY KEY,      -- sha256(plaintext token); plaintext never stored
  device_id    TEXT NOT NULL,
  label        TEXT,
  account_id   TEXT NOT NULL DEFAULT 'default', -- single implicit account until M7
  created_at   INTEGER NOT NULL,      -- epoch ms
  last_seen_at INTEGER,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS devices_device_id ON devices (device_id);

CREATE TABLE IF NOT EXISTS device_auth (
  device_code       TEXT PRIMARY KEY, -- high-entropy secret held by the polling device
  user_code         TEXT NOT NULL,    -- short human code shown for approval
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied
  device_token_hash TEXT,             -- set when approved (the new device's token hash)
  device_id         TEXT NOT NULL,
  label             TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_auth_user_code ON device_auth (user_code);
