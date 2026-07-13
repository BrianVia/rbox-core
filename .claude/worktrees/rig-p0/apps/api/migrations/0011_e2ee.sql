-- Full E2EE (design 12, v4): the server is a DUMB ZERO-KNOWLEDGE STORE. Every
-- TEXT column below holds an OPAQUE client-produced blob — a signed envelope or
-- a wrap — that the server NEVER decrypts or verifies (clients verify from
-- genesis). We persist verbatim, ordered, and account-scoped; nothing more.

-- Per-account recovery material (MK-under-RK wrap). One row per account.
CREATE TABLE IF NOT EXISTS account_keys (
  account_id       TEXT PRIMARY KEY,
  recovery_wrap    TEXT,             -- opaque AES-GCM wrap of MK under rkWrapKey
  recovery_wrap_id TEXT,             -- id the signed accountKeyState pins
  created_at       INTEGER
);

-- Per-device public keys + the MK wrapped to that device (RSA-OAEP). Opaque.
CREATE TABLE IF NOT EXISTS device_keys (
  device_id  TEXT PRIMARY KEY,
  account_id TEXT,
  sig_pubkey TEXT,                   -- Ed25519 raw 32-byte, b64url
  enc_pubkey TEXT,                   -- RSA SPKI DER, b64url
  mk_wrap    TEXT,                   -- opaque MK-to-this-device wrap
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_keys_account ON device_keys (account_id);

-- Per-(workspace, keyEpoch) KEK wrap (KEK-under-MK). Opaque; monotone keyEpoch.
CREATE TABLE IF NOT EXISTS workspace_keys (
  workspace_id TEXT NOT NULL,
  account_id   TEXT,
  key_epoch    INTEGER,
  kek_wrap     TEXT,                 -- opaque AES-GCM wrap of the KEK under MK
  created_at   INTEGER,
  PRIMARY KEY (workspace_id, key_epoch)
);

-- Append-only signed roster history (one principal-set per version). Opaque.
CREATE TABLE IF NOT EXISTS rosters (
  account_id TEXT NOT NULL,
  version    INTEGER,
  signed     TEXT,                   -- opaque SignedRoster (canonical JSON + sig)
  created_at INTEGER,
  PRIMARY KEY (account_id, version)
);

-- Append-only signed account-key-state chain (one per epoch). Opaque.
CREATE TABLE IF NOT EXISTS account_key_states (
  account_id    TEXT NOT NULL,
  account_epoch INTEGER,
  signed        TEXT,                -- opaque SignedKeyState (canonical JSON + sig)
  created_at    INTEGER,
  PRIMARY KEY (account_id, account_epoch)
);

-- Best-effort D1 mirror of the authoritative DO commit log (the DO storage is the
-- source of truth). `body`/`sig`/`commit_hash` form the opaque SignedCommit.
CREATE TABLE IF NOT EXISTS commits (
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  sequence     INTEGER,
  commit_hash  TEXT,
  body         TEXT,                 -- opaque canonical commitBody JSON
  sig          TEXT,                 -- opaque Ed25519 sig (b64url)
  device_id    TEXT,
  created_at   INTEGER DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (workspace_id, project_id, sequence)
);

-- Pairing tokens (0008) carry optional E2EE admission material: the split-secret
-- hash (V4-1), the MK wrap the redeemer unwraps, and the pre-signed admission
-- grant. All NULL for legacy (M10) tokens → those redeem exactly as before.
ALTER TABLE pairing_tokens ADD COLUMN secret_hash TEXT;
ALTER TABLE pairing_tokens ADD COLUMN mk_wrap TEXT;
ALTER TABLE pairing_tokens ADD COLUMN admission_grant TEXT;
