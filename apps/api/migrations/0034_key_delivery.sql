-- Design 189: web-approved, daemon-fulfilled delivery of an opaque device MK
-- wrap. `device_auth.status` deliberately remains pending|approved|claimed.

ALTER TABLE device_auth ADD COLUMN enc_pub_key TEXT;
ALTER TABLE device_auth ADD COLUMN sig_pub_key TEXT;
ALTER TABLE device_auth ADD COLUMN pubkeys_captured_at INTEGER;
ALTER TABLE device_auth ADD COLUMN request_id TEXT;
ALTER TABLE device_auth ADD COLUMN claim_nonce TEXT;
ALTER TABLE devices ADD COLUMN key_release_enabled INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_auth_request_id
ON device_auth(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS key_delivery (
  request_id                TEXT PRIMARY KEY, -- sha256(device_code)
  account_id                TEXT NOT NULL,
  target_device_id          TEXT,             -- NULL until claim/mint retargets it
  enc_pub_key_hash          TEXT NOT NULL,
  sig_pub_key_hash          TEXT NOT NULL,
  pubkey_fingerprint        TEXT NOT NULL,    -- b64url sha256(JCS(public keys))
  approval_token_hash       TEXT NOT NULL,    -- sha256(fresh Clerk step-up JWT)
  approval_factor_verified_at INTEGER NOT NULL,
  state                     TEXT NOT NULL CHECK(state IN ('queued','fulfilled','delivered','expired')),
  wrap_blob                 TEXT,             -- opaque device-context MK wrap
  published_roster_version  INTEGER,
  account_epoch             INTEGER NOT NULL,
  fulfilling_device_id      TEXT,
  created_at                INTEGER NOT NULL,
  fulfilled_at              INTEGER,
  delivered_at              INTEGER,
  expires_at                INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_key_delivery_approval
ON key_delivery(approval_token_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_key_delivery_live_target
ON key_delivery(account_id, enc_pub_key_hash)
WHERE state IN ('queued','fulfilled');

CREATE INDEX IF NOT EXISTS idx_key_delivery_account_queue
ON key_delivery(account_id, state, expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_key_delivery_target
ON key_delivery(target_device_id, state, expires_at);

-- The bearer is returned again only to a holder of the high-entropy device_code,
-- within that code's TTL. It is AES-GCM encrypted before this row is prepared.
CREATE TABLE IF NOT EXISTS device_token_escrow (
  request_id        TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  device_id         TEXT NOT NULL,
  token_hash        TEXT NOT NULL,
  token_ciphertext  TEXT NOT NULL,
  token_iv          TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_token_escrow_expiry
ON device_token_escrow(expires_at);

CREATE TABLE IF NOT EXISTS account_key_delivery_prefs (
  account_id TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);

-- Notification copy can say that key access was granted without ever holding key
-- material. The fingerprint is public-key metadata and is scrubbed with the other
-- notification projection fields.
ALTER TABLE device_notifications ADD COLUMN keys_granted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_notifications ADD COLUMN key_fingerprint TEXT;
