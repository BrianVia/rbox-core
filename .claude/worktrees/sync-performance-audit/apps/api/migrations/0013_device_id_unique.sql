-- P1 (designs 16/17/19/20): `device_id` must be UNIQUE.
--
-- Today `devices.token_hash` is the PRIMARY KEY and `device_id` is only a
-- NON-UNIQUE index (0004). `revokeDevice` targets rows by (account_id, device_id),
-- so a same-account `device_id` collision would revoke MULTIPLE devices, and some
-- ids were only 32–48 bits (`dev_/web_` + randomHex(4..6)).
--
-- SCOPE — global, not per-account. The E2EE schema already treats `device_id` as
-- GLOBALLY unique: `device_keys.device_id` is a global PRIMARY KEY
-- (0011_e2ee.sql:16). A per-account `UNIQUE(account_id, device_id)` here would be
-- weaker than (and could contradict) that table. So the correct, reconciling
-- constraint is a GLOBAL unique index on `device_id` — it satisfies revoke safety
-- (at most one row per (account_id, device_id) too) and keeps `devices` consistent
-- with `device_keys`. No change to `device_keys` is needed; it is already global.
--
-- D1/SQLite cannot `ALTER TABLE ... ADD CONSTRAINT`, so we use `CREATE UNIQUE INDEX`.
-- A unique index BUILD FAILS if existing rows already collide, which would abort a
-- deploy mid-flight. To make this safe and idempotent we DEDUP FIRST: re-id every
-- duplicate loser (all rows in a `device_id` group except the earliest, by rowid)
-- to a fresh wide id. `randomblob` is evaluated per row, so each re-id'd row gets a
-- distinct value. After this runs there are zero duplicate `device_id`s, so the
-- index build below always succeeds (re-running the migration re-ids nothing).
--
-- Re-id'ing losers in `devices` is safe w.r.t. `device_keys`: a duplicate could
-- only ever have had ONE matching `device_keys` row (global PK), so the loser rows
-- being re-id'd had no key material bound to them.
UPDATE devices
SET device_id = 'dev_' || lower(hex(randomblob(16)))
WHERE rowid NOT IN (SELECT MIN(rowid) FROM devices GROUP BY device_id);

-- Replace the non-unique index (0004) with the global unique one — no redundant
-- pair left behind; lookups by `device_id` still use the (now unique) index.
DROP INDEX IF EXISTS devices_device_id;
CREATE UNIQUE INDEX IF NOT EXISTS devices_device_id_unique ON devices (device_id);
