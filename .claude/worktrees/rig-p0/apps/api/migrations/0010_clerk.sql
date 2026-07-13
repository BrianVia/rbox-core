-- M11: web auth via Clerk. Maps a Clerk user (sub) to exactly one rbox
-- account/user, so repeated web logins reuse the same account (idempotent
-- first-login provisioning is gated on this PK).

CREATE TABLE IF NOT EXISTS clerk_users (
  clerk_user_id TEXT PRIMARY KEY,   -- Clerk `sub` (user_…)
  account_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Web sessions are short-lived device tokens: same `devices` table, but with an
-- expiry. CLI/device-code/pairing tokens keep expires_at NULL (no expiry);
-- authenticate() enforces (expires_at IS NULL OR expires_at > now).
ALTER TABLE devices ADD COLUMN expires_at INTEGER;
