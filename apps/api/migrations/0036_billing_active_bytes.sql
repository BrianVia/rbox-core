-- Design 228: rbox bills, shows and gates on ACTIVE bytes, never on retained
-- history. `accounts.used_bytes` stays the live entitlement ledger and stays the
-- admission input (commit-time active_bytes is unsound — delta admission never
-- sees the full ref set). What changes is the ALLOWANCE:
--
--   billable_bytes = MAX(0, used_bytes - history_overhang_bytes)
--                  = active_bytes(last completed scan) + net ledger delta since it
--
-- history_overhang_bytes is the measured ledger bytes we have decided not to
-- bill; history_overhang_measured_at is WHEN that measurement was taken. They are
-- written together, by one statement, in the fair-use scan's completion batch
-- (apps/api/src/fairuse.ts, completeScan is the single writer) — so the number and
-- its timestamp always agree and `usage()` reads both from ONE row.
--
-- measured_at NULL <=> never measured. That is the fallback: nothing forgiven,
-- byte-for-byte today's behaviour, surfaced as "still being measured".
ALTER TABLE accounts ADD COLUMN history_overhang_bytes INTEGER NOT NULL DEFAULT 0 CHECK(history_overhang_bytes>=0);
ALTER TABLE accounts ADD COLUMN history_overhang_measured_at INTEGER;

-- BACKFILL. Without this, every account that already has a completed scan would
-- spend deploy day reporting a real measurement timestamp against a completely
-- unforgiven ledger — a number and a date that describe different things. Take
-- each account's latest completed scan (highest completed_at, epoch breaking ties,
-- matching the ORDER BY billing already uses) and derive both columns from it,
-- exactly as completeScan will from now on.
UPDATE accounts SET
  history_overhang_bytes = MAX(0, used_bytes - COALESCE((
    SELECT s.active_bytes FROM fairuse_scans s
     WHERE s.account_id = accounts.id AND s.status = 'complete' AND s.completed_at IS NOT NULL
     ORDER BY s.completed_at DESC, s.epoch DESC LIMIT 1), used_bytes)),
  history_overhang_measured_at = (
    SELECT s.completed_at FROM fairuse_scans s
     WHERE s.account_id = accounts.id AND s.status = 'complete' AND s.completed_at IS NOT NULL
     ORDER BY s.completed_at DESC, s.epoch DESC LIMIT 1)
WHERE EXISTS (
  SELECT 1 FROM fairuse_scans s
   WHERE s.account_id = accounts.id AND s.status = 'complete' AND s.completed_at IS NOT NULL);

-- The authoritative hard quota gate (introduced 0014_upload_receipts.sql). It
-- still fires on the LIVE counter and still only guards INCREASES; only the
-- number it compares against the cap changes. Materialized on `accounts` rather
-- than joined from fairuse_scans for the same reason cap_bytes is: this trigger
-- runs on every charge, and the app-layer checks must compare the identical
-- number or the fast-fail and the fence would disagree.
--
-- ONLY A PAID PLAN FORGIVES ANYTHING. A locked ('none') account has cap_bytes = 1,
-- and that one-byte fence is what stops a lapsed subscription writing more data; a
-- standing overhang from its paid era would blunt it until the ledger climbed past
-- the overhang, so a paid->locked race could land real bytes durably. Deciding this
-- here, in the one authority, beats clearing the column on every plan-write path
-- (Stripe webhook, admin set-plan, anything future), and it preserves the
-- measurement across a re-upgrade. Mirrors plans.ts BILLABLE_BYTES_SQL and the PLANS
-- paid names, as the cap CASE in 0014/0016/0021 already does.
--
-- cap_bytes <= 0 still means "unset/unlimited, app-layer-checked" (the platform
-- 'default' account) and still disables the guard.
DROP TRIGGER IF EXISTS accounts_cap_guard;
CREATE TRIGGER accounts_cap_guard
BEFORE UPDATE OF used_bytes ON accounts
WHEN NEW.cap_bytes > 0 AND NEW.used_bytes > OLD.used_bytes
     AND NEW.used_bytes - (CASE WHEN NEW.plan IN ('solo','pro','team') THEN NEW.history_overhang_bytes ELSE 0 END) > NEW.cap_bytes
BEGIN
  SELECT RAISE(ABORT, 'over_cap');
END;
