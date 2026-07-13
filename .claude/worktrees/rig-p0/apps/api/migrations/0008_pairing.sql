-- M10: pairing tokens — low-friction "connect a new machine". An authenticated
-- device mints a short-lived, single-use token; a new machine redeems it for its
-- own device credential bound to the SAME account/user. Plaintext token is never
-- stored (sha256 only), mirroring `devices` (0004).

CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash  TEXT PRIMARY KEY,   -- sha256(plaintext token); plaintext never stored
  account_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,      -- the user adding the machine (role inherited; non-null — redeem requires a live membership)
  created_by  TEXT NOT NULL,      -- device_id that generated it (revoke of this device kills the token at redeem)
  label       TEXT,
  created_at  INTEGER NOT NULL,   -- epoch ms
  expires_at  INTEGER NOT NULL,   -- epoch ms; redeem rejects once past
  consumed_at INTEGER             -- NULL until redeemed; the single-use gate
);
