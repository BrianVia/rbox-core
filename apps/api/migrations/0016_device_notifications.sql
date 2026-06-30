-- Design 16 / 30 (slices 4–5) — new-device security email.
--
-- A new durable bearer credential (pairing-redeem / device-code-claim) commits an
-- OUTBOX row in the SAME atomic batch as its `devices` row, so "if the device
-- exists, its notification exists." Delivery is strictly downstream (Cloudflare
-- Queue + cron backstop), tracked per-recipient so a multi-owner fan-out can
-- succeed/fail/retry independently. PII (label/ip/geo) is a snapshot, purged after
-- delivery (§3.7).

-- Event level: one row per minted credential. `token_hash` is the unique credential
-- identity (devices PK) and the idempotency anchor — `INSERT OR IGNORE` makes the
-- outbox write genuinely idempotent (at most one row → at most one notification).
CREATE TABLE IF NOT EXISTS device_notifications (
  token_hash     TEXT PRIMARY KEY,        -- = devices.token_hash (never egressed; the credential verifier)
  device_id      TEXT NOT NULL,           -- display id + revoke-link target (globally unique since 0013)
  account_id     TEXT NOT NULL,
  minted_user_id TEXT,                     -- user the credential minted into (NOT the recipient)
  label          TEXT,                     -- device-label snapshot (PURGED after delivery)
  ip             TEXT,                     -- CF-Connecting-IP at creation (PURGED after delivery)
  geo            TEXT,                     -- coarse "City, Region, CC" from request.cf (PURGED after delivery)
  event          TEXT NOT NULL,            -- 'pair' | 'device_code'
  created_at     INTEGER NOT NULL,         -- epoch ms (the "approximate time" shown)
  resolved_at    INTEGER                   -- set once owners have been fanned out into deliveries
);
CREATE INDEX IF NOT EXISTS idx_devnotif_unresolved ON device_notifications (resolved_at);

-- Delivery level: one row per (event, recipient). Keyed by the STABLE Clerk identity
-- (survives a later link/unlink that moves the clerk_users row). Stores NO email and
-- NO email hash — the address is fetched (cache or live Clerk) at send time and never
-- persisted here (§3.7). Per-recipient status/attempts make partial success
-- representable and the atomic claim/lease (status→'sending') the send mutex (§3.4).
CREATE TABLE IF NOT EXISTS notification_deliveries (
  token_hash         TEXT NOT NULL,        -- FK → device_notifications.token_hash
  recipient_user_id  TEXT NOT NULL,        -- the owner user_id captured at resolution
  recipient_clerk_id TEXT NOT NULL,        -- the Clerk sub — the stable send target; email fetched for THIS id
  idempotency_key    TEXT NOT NULL,        -- HMAC(pepper, token_hash ‖ recipient_clerk_id); internal dedupe tag
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|sending|sent|skipped|failed
  attempts           INTEGER NOT NULL DEFAULT 0,
  claimed_at         INTEGER,              -- lease stamp: when a consumer claimed this row (status→'sending')
  last_attempt_at    INTEGER,
  sent_at            INTEGER,
  PRIMARY KEY (token_hash, recipient_clerk_id)
);
CREATE INDEX IF NOT EXISTS idx_deliv_status ON notification_deliveries (status, last_attempt_at);

-- Account-scoped opt-out (default ON — a security signal). The owner-gated mutation
-- endpoint + cross-notify (design 16 §6 / slice 6) is deferred; the consumer already
-- honours this flag, so flipping it (manually or via a later endpoint) takes effect.
CREATE TABLE IF NOT EXISTS account_notify_prefs (
  account_id        TEXT PRIMARY KEY,
  notify_new_device INTEGER NOT NULL DEFAULT 1   -- 1 = on (opt-out model)
);

-- Recipient resolution caches the owner's primary VERIFIED email on the clerk_users
-- mapping (§3.2), refreshed (throttled) on returning web logins, so we don't egress
-- the sub↔account graph to Clerk on every device add. NULL → the consumer does one
-- live Clerk fetch.
ALTER TABLE clerk_users ADD COLUMN email TEXT;
ALTER TABLE clerk_users ADD COLUMN email_updated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_clerk_users_acct ON clerk_users (account_id, user_id);
