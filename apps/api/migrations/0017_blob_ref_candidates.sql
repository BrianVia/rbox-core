-- §33 Phase 1 — per-account entitlement GC (per-account reachability prune).
--
-- `blob_ref_candidates` is the ENTITLEMENT-level analog of `gc_candidates` (0005):
-- a PER-ACCOUNT prune marker that the commit preflight must consult. Phase 1 marks
-- an account's `blob_refs` row that has fallen out of authoritative DO roots; the
-- commit preflight (validateCommitRefs / blobsCheck / missingBlobs) treats a marked
-- (account, sha) as NOT-satisfied, forcing a re-grant that CLEARS the marker — so a
-- candidate can never be referenced by a published commit without first being
-- un-marked (the §33 round-1 fix: `granted_at` alone is NOT a sound barrier because
-- the dedup path never bumps it — commit-accounting.ts:78-93).
--
-- A separate table (not a `blob_refs.prune_marked_at` column) is deliberate: clearing
-- a column on reuse depends on the dedup path touching the row, which it does NOT.
-- It also shards cleanly with the owning account (§32).

CREATE TABLE IF NOT EXISTS blob_ref_candidates (
  account_id TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  marked_at  INTEGER NOT NULL,
  PRIMARY KEY (account_id, sha256)
);
