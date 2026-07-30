-- Design 228: rbox bills, shows and gates on ACTIVE bytes, never on retained
-- history. `accounts.used_bytes` stays the live entitlement ledger and stays the
-- admission input (commit-time active_bytes is unsound — delta admission never
-- sees the full ref set). What changes is the ALLOWANCE:
--
--   billable_bytes = MAX(0, used_bytes - history_overhang_bytes)
--                  = active_bytes(last completed scan) + net ledger delta since it
--
-- history_overhang_bytes is the measured ledger bytes we have decided not to
-- bill. DEFAULT 0 means "nothing measured, nothing forgiven" — byte-for-byte
-- today's behaviour — so this migration is a no-op until a fair-use scan
-- completes and writes a real number (apps/api/src/fairuse.ts, completeScan is
-- the single writer).
ALTER TABLE accounts ADD COLUMN history_overhang_bytes INTEGER NOT NULL DEFAULT 0 CHECK(history_overhang_bytes>=0);

-- The authoritative hard quota gate (introduced 0014_upload_receipts.sql). It
-- still fires on the LIVE counter and still only guards INCREASES; only the
-- number it compares against the cap changes. Materialized on `accounts` rather
-- than joined from fairuse_scans for the same reason cap_bytes is: this trigger
-- runs on every charge, and the app-layer checks must compare the identical
-- number or the fast-fail and the fence would disagree.
-- cap_bytes <= 0 still means "unset/unlimited, app-layer-checked" (the platform
-- 'default' account) and still disables the guard.
DROP TRIGGER IF EXISTS accounts_cap_guard;
CREATE TRIGGER accounts_cap_guard
BEFORE UPDATE OF used_bytes ON accounts
WHEN NEW.cap_bytes > 0 AND NEW.used_bytes > OLD.used_bytes
     AND NEW.used_bytes - NEW.history_overhang_bytes > NEW.cap_bytes
BEGIN
  SELECT RAISE(ABORT, 'over_cap');
END;
