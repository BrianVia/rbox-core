-- §30 (codex BLOCKER 5): cap_bytes=0 disables accounts_cap_guard. Bootstrap sets cap_bytes
-- directly, but unlinkAccount's web-shell INSERT (and any future insert path) omitted it,
-- leaving a tenant account with NO quota enforcement. Close the hole at the DB layer so no
-- code path can recreate it, while preserving the deliberate platform 'default' account
-- (id='default') whose cap_bytes=0 means "unlimited, app-layer-checked" (migration 0014 note).

-- 1. AFTER INSERT materializer: any tenant row inserted without a real cap gets its plan's
--    cap (mirrors accounts_cap_sync's CASE). Excludes the platform 'default' account.
DROP TRIGGER IF EXISTS accounts_cap_on_insert;
CREATE TRIGGER accounts_cap_on_insert
AFTER INSERT ON accounts
WHEN NEW.cap_bytes <= 0 AND NEW.id <> 'default'
BEGIN
  UPDATE accounts SET cap_bytes = NEW.extra_storage_bytes + (
    CASE NEW.plan
      WHEN 'solo' THEN 50  * 1024 * 1024 * 1024
      WHEN 'pro'  THEN 250 * 1024 * 1024 * 1024
      WHEN 'team' THEN 150 * 1024 * 1024 * 1024
      ELSE             2   * 1024 * 1024 * 1024
    END)
  WHERE id = NEW.id;
END;

-- 2. Backfill any existing tenant account left unguarded (no-op where already materialized).
UPDATE accounts SET cap_bytes = extra_storage_bytes + (
  CASE plan
    WHEN 'solo' THEN 50  * 1024 * 1024 * 1024
    WHEN 'pro'  THEN 250 * 1024 * 1024 * 1024
    WHEN 'team' THEN 150 * 1024 * 1024 * 1024
    ELSE             2   * 1024 * 1024 * 1024
  END)
WHERE cap_bytes <= 0 AND id <> 'default';
