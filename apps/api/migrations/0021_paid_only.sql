-- Design 86: paid-only accounts.
-- Replace the old free tier with the locked `none` state and materialize its
-- one-byte storage cap in the cap sync triggers.

UPDATE accounts SET plan = 'none' WHERE plan = 'free';

-- Unlike 0014, exclude the platform 'default' account: under ELSE 1 an
-- accidental plan/extra UPDATE on it would materialize a 1-byte cap and
-- enable the guard on the deliberately-unlimited row (cap_bytes = 0).
DROP TRIGGER IF EXISTS accounts_cap_sync;
CREATE TRIGGER accounts_cap_sync
AFTER UPDATE OF plan, extra_storage_bytes ON accounts
WHEN NEW.id <> 'default'
BEGIN
  UPDATE accounts SET cap_bytes = NEW.extra_storage_bytes + (
    CASE NEW.plan
      WHEN 'solo' THEN 50  * 1024 * 1024 * 1024
      WHEN 'pro'  THEN 250 * 1024 * 1024 * 1024
      WHEN 'team' THEN 150 * 1024 * 1024 * 1024
      ELSE             1
    END)
  WHERE id = NEW.id;
END;

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
      ELSE             1
    END)
  WHERE id = NEW.id;
END;

UPDATE accounts SET cap_bytes = extra_storage_bytes + (
  CASE plan
    WHEN 'solo' THEN 50  * 1024 * 1024 * 1024
    WHEN 'pro'  THEN 250 * 1024 * 1024 * 1024
    WHEN 'team' THEN 150 * 1024 * 1024 * 1024
    ELSE             1
  END)
WHERE id <> 'default';
