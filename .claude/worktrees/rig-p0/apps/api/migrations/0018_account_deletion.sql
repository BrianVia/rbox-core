-- Design 33 — self-serve account + data deletion (GDPR/CCPA right-to-erasure).
--
-- Two pieces, mirroring the design-16 durable-outbox pattern:
--   1. accounts.deleted_at — the TOMBSTONE. Set the instant DELETE /v1/account is
--      accepted; while non-NULL the account is inaccessible (authenticate() rejects it)
--      but its data still exists. NULL = live.
--   2. account_deletions — the durable work-ledger (source of truth) for the async,
--      bounded, re-entrant hard-purge. Written in the SAME atomic batch as the tombstone,
--      so "if the account is tombstoned, its deletion row exists." The cron backstop
--      (and the optional queue) drive each row forward once purge_after has elapsed.

ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;  -- epoch ms; NULL = live

CREATE TABLE IF NOT EXISTS account_deletions (
  account_id      TEXT PRIMARY KEY,             -- the account being erased (also the idempotency anchor)
  requested_at    INTEGER NOT NULL,             -- epoch ms the owner asked to delete
  purge_after     INTEGER NOT NULL,             -- epoch ms; the irreversible hard-purge runs only at/after this (grace gate)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | purging | done
  attempts        INTEGER NOT NULL DEFAULT 0,   -- drive attempts (lease/observability)
  last_attempt_at INTEGER,                       -- lease stamp: when a drain claimed this row (status->'purging')
  lease_token     TEXT,                          -- per-driver lease owner; CAS'd on release so only the owner resets it
  confirmed_with  TEXT                           -- audit: 'email' | 'account_id' (NEVER the raw value)
);

-- Cron sweep selects past-grace, not-yet-done rows ordered by readiness.
CREATE INDEX IF NOT EXISTS idx_account_deletions_due ON account_deletions (status, purge_after);
