-- §23 upload-receipts (docs/design/23-upload-receipts*, design v10, codex PASS).
-- Moves per-blob D1 accounting off the PUT hot path to commit-time. This migration
-- adds the three schema pieces the commit-time accounting needs; the code lands
-- separately. See §23.4 "Schema (migration)".
--
-- 1. blobs.present — decouples "canonical bytes confirmed present" (set only after
--    a commit promotes staging→canonical) from "charged" (blob_refs). Reuse,
--    missingBlobs, and head-validate all gate on present=1. Existing rows predate
--    §23 and already have canonical objects, so they backfill to 1.
-- 2. blob_refs.granted_at — the revoke-lease timestamp (§23.5). Refreshed on every
--    (re-)grant; reconcile may revoke a present=0 ref only when it is older than
--    REVOKE_GRACE. Existing rows are all present=1 (never swept) → backfill to now.
-- 3. accounts.cap_bytes + an over-cap GUARD TRIGGER — the hard quota gate (§23.4
--    B2). SQLite cannot ALTER a wide existing table to ADD a CHECK, so we use a
--    BEFORE UPDATE trigger that RAISE(ABORT)s when an INCREASE would exceed cap.
--    A failed statement rolls back the whole batch() (unlike a 0-row UPDATE) — that
--    is the property the §23.6 spike must confirm on real D1.

ALTER TABLE blobs     ADD COLUMN present    INTEGER NOT NULL DEFAULT 0;
UPDATE blobs SET present = 1;  -- existing blobs already have canonical R2 objects

ALTER TABLE blob_refs ADD COLUMN granted_at INTEGER NOT NULL DEFAULT 0;
UPDATE blob_refs SET granted_at = unixepoch() * 1000;  -- existing refs: present, never swept

-- cap_bytes = plan base cap + purchasable extra. Kept in sync with the plan by the
-- billing path (apps/api/src/plans.ts PLANS, mirrored here). storageBytes are all
-- finite (free 2Gi, solo 50Gi, pro 250Gi, team 150Gi); only workspaces/projects are
-- Infinity. If a future plan is unlimited-storage, materialize a large sentinel.
ALTER TABLE accounts ADD COLUMN cap_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE accounts SET cap_bytes = extra_storage_bytes + (
  CASE plan
    WHEN 'solo' THEN 50  * 1024 * 1024 * 1024
    WHEN 'pro'  THEN 250 * 1024 * 1024 * 1024
    WHEN 'team' THEN 150 * 1024 * 1024 * 1024
    ELSE             2   * 1024 * 1024 * 1024   -- free / unknown
  END);

-- Hard cap gate. Only an INCREASE that crosses cap aborts — a no-op (newBytes=0)
-- or a refund (decrease) on an already-over-cap account must still succeed, else a
-- reconcile refund or an all-already-entitled commit would wedge.
-- Keep cap_bytes in sync with plan/extra automatically, so every billing/stripe
-- UPDATE (SET plan=…, extra_storage_bytes=…) materializes the cap without needing to
-- remember. Mirrors plans.ts PLANS.storageBytes. (INSERTs set cap_bytes directly.)
DROP TRIGGER IF EXISTS accounts_cap_sync;
CREATE TRIGGER accounts_cap_sync
AFTER UPDATE OF plan, extra_storage_bytes ON accounts
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

-- cap_bytes <= 0 means "unset" (a legacy account whose cap was never materialized,
-- or the platform 'default' account) → no guard; those paths keep their own checks.
DROP TRIGGER IF EXISTS accounts_cap_guard;
CREATE TRIGGER accounts_cap_guard
BEFORE UPDATE OF used_bytes ON accounts
WHEN NEW.cap_bytes > 0 AND NEW.used_bytes > OLD.used_bytes AND NEW.used_bytes > NEW.cap_bytes
BEGIN
  SELECT RAISE(ABORT, 'over_cap');
END;
