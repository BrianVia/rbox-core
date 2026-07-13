-- M7: multi-tenancy & isolation.
-- Real accounts/users/memberships; per-account blob entitlements; account-scoped
-- workspace ownership + multipart uploads; audit log.

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  plan       TEXT NOT NULL DEFAULT 'free',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email      TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  account_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,          -- owner | admin | editor | viewer
  PRIMARY KEY (account_id, user_id)
);

-- Entitlement: which accounts may READ a given content-addressed blob. Created
-- ONLY by a hash-verified upload (never by referencing a sha in a manifest), so
-- one account can't gain access to another's blob by referencing its sha.
CREATE TABLE IF NOT EXISTS blob_refs (
  account_id TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  PRIMARY KEY (account_id, sha256)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT,
  actor_device TEXT,
  actor_user   TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  at           INTEGER NOT NULL
);

-- devices (0004) gains user_id; account_id already present (default 'default').
ALTER TABLE devices ADD COLUMN user_id TEXT;
-- workspaces (0005) gains its owning account (set at creation; NULL = unowned → 404).
ALTER TABLE workspaces ADD COLUMN account_id TEXT;
-- uploads (0003) gains the owning account so a leaked uploadId can't be completed cross-account.
ALTER TABLE uploads ADD COLUMN account_id TEXT;
-- device_auth (0004) carries the approver's account/user so an approved device joins it.
ALTER TABLE device_auth ADD COLUMN account_id TEXT;
ALTER TABLE device_auth ADD COLUMN user_id TEXT;
