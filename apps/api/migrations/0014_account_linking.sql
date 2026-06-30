-- Design 21: account identity model + web↔CLI account linking.
--
-- Adds the two-phase link-code ceremony tables, account provenance columns, the
-- one-Clerk-per-account inverse constraint, and a deterministic `origin` backfill
-- for the installed base of stranded web shells. ORDER MATTERS (§3.2 caveat):
--   (1) de-dup any clerk_users.account_id collisions,
--   (2) backfill accounts.origin (§6),
--   (3) CREATE UNIQUE INDEX uq_clerk_users_account
-- or the unique-index build aborts the deploy. Mirrors the dedup-first ordering
-- proven safe in 0013_device_id_unique.sql.

-- ── new tables ───────────────────────────────────────────────────────────────

-- Short-lived, single-use link codes. Plaintext never stored (sha256 only), like
-- pairing_tokens (0008). A code moves through a TWO-PHASE bind: redeem → 'pending'
-- (records a proposed target X), dashboard confirm → committed (the rebind, §4).
CREATE TABLE IF NOT EXISTS account_link_codes (
  code_hash       TEXT PRIMARY KEY,     -- sha256(plaintext code); plaintext shown once
  poll_key        TEXT NOT NULL UNIQUE, -- opaque handle the dashboard polls/confirms with (NOT the code, §4.3)
  clerk_user_id   TEXT NOT NULL,        -- the Clerk sub that requested the link (the identity being bound)
  origin_account  TEXT NOT NULL,        -- the account currently mapped to this Clerk id (verified unchanged at commit, §4.2.1)
  created_at      INTEGER NOT NULL,     -- epoch ms
  expires_at      INTEGER NOT NULL,     -- epoch ms; redeem/confirm reject past TTL (10 min)
  consumed_at     INTEGER,              -- NULL until redeemed; the single-use gate (phase 1)
  pending_account TEXT,                 -- target X proposed by the redeeming owner device (phase 1 → awaiting confirm)
  pending_device  TEXT,                 -- the redeeming durable owner device_id (audit; §5.6)
  pending_user    TEXT,                 -- the redeeming owner's user_id, captured at redeem (§3.3 — confirm maps C→this user)
  pending_at      INTEGER,
  committed_at    INTEGER               -- set when the dashboard (live C session) confirms the target (phase 2)
);
CREATE INDEX IF NOT EXISTS idx_link_codes_clerk ON account_link_codes (clerk_user_id, created_at);

-- Append-only audit of every (re)bind. Forensics for takeover/double-link disputes.
-- Explicitly EXCLUDED from the shell-reclaim predicate (§3.4) — a log never blocks reclaim.
CREATE TABLE IF NOT EXISTS account_link_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clerk_user_id TEXT NOT NULL,
  from_account  TEXT,                   -- NULL if the Clerk id had no prior account
  to_account    TEXT NOT NULL,
  method        TEXT NOT NULL,          -- 'cli_link' | 'unlink'
  actor_device  TEXT,                   -- the redeeming owner device_id (audit only)
  at            INTEGER NOT NULL
);

-- Account provenance so a web shell can be safely reclaimed and a crypto-anchored
-- account is never auto-deleted (§3.4). 'bootstrap' | 'web' | NULL(legacy → backfilled).
ALTER TABLE accounts ADD COLUMN origin TEXT;
ALTER TABLE accounts ADD COLUMN reclaimed_at INTEGER;  -- set when a shell is tombstoned by a link

-- ── (1) de-dup clerk_users.account_id BEFORE the unique index ────────────────
-- Today nothing forbids two clerk_users rows pointing at one account; the unique
-- index below would then fail the build. Keep the earliest row per account_id
-- (MIN(rowid)); re-point each loser to a FRESH empty shell id pair. webSession
-- self-heals the new ids (INSERT OR IGNORE accounts/users/memberships, origin='web')
-- on that identity's next login, so no orphan results. randomblob is evaluated per
-- row → distinct ids; on a clean DB this updates nothing and is a no-op on re-run.
UPDATE clerk_users
SET account_id = 'acct_' || lower(hex(randomblob(8))),
    user_id    = 'user_' || lower(hex(randomblob(8)))
WHERE rowid NOT IN (SELECT MIN(rowid) FROM clerk_users GROUP BY account_id);

-- ── (2) backfill accounts.origin (§6) — EXHAUSTIVE over every account-scoped
-- state table + billing column. `commits` (0011) has no account_id → checked via
-- the workspaces join. audit_log / account_link_events are forensic logs → excluded.

-- A real (crypto-anchored / data-bearing / billing-bearing) account → 'bootstrap'.
UPDATE accounts SET origin = 'bootstrap'
 WHERE origin IS NULL
   AND ( id IN (SELECT account_id FROM account_keys)
      OR id IN (SELECT account_id FROM device_keys)
      OR id IN (SELECT account_id FROM rosters)
      OR id IN (SELECT account_id FROM account_key_states)
      OR id IN (SELECT account_id FROM workspace_keys)
      OR id IN (SELECT account_id FROM workspaces)
      OR id IN (SELECT account_id FROM blob_refs)
      OR id IN (SELECT account_id FROM uploads WHERE account_id IS NOT NULL)
      -- pairing_tokens / device_auth use the SAME active-only test as the runtime
      -- §3.4 reclaim predicate (in-flight only); a consumed/expired artifact never
      -- blocks, exactly as at link time. (now = epoch ms via strftime.)
      OR id IN (SELECT account_id FROM pairing_tokens WHERE consumed_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000)
      OR id IN (SELECT account_id FROM device_auth WHERE account_id IS NOT NULL AND status IN ('pending','approved') AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000)
      OR id IN (SELECT DISTINCT account_id FROM devices WHERE expires_at IS NULL)
      OR plan != 'free'
      OR stripe_customer_id IS NOT NULL
      OR stripe_subscription_id IS NOT NULL
      OR grace_until IS NOT NULL
      OR extra_storage_bytes != 0
      OR used_bytes != 0 );

-- A provably-empty web shell (clerk_users-mapped, none of the above) → 'web'
-- (reclaimable). The data/billing rows already became 'bootstrap', so any remaining
-- NULL clerk-mapped account is empty. Anything still NULL stays NULL = NOT
-- reclaimable (fail-closed; a human can reclassify).
UPDATE accounts SET origin = 'web'
 WHERE origin IS NULL
   AND id IN (SELECT account_id FROM clerk_users);

-- ── (3) one-Clerk-per-account inverse constraint (§5.5) ──────────────────────
-- clerk_users (0010) keys only on clerk_user_id, leaving the INVERSE (one account
-- ← one Clerk id) unconstrained. This unique index makes a second Clerk id
-- rebinding onto the same X fail at the DB, not just at a racy app check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clerk_users_account ON clerk_users (account_id);
