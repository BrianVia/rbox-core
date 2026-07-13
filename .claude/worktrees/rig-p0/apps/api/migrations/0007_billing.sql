-- M7b: billing add-on storage + the atomic usage counter.
-- extra_storage_bytes: purchasable extra capacity ($3/100GB).
-- used_bytes: authoritative deduped usage, mutated by an atomic conditional
-- UPDATE on entitlement grant (race-safe quota) and decremented on GC purge.
ALTER TABLE accounts ADD COLUMN extra_storage_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0;
