-- Admin cockpit "GC pipeline" panel (rbox-admin fetchGcPipeline) reads two
-- aggregates over gc_candidates/blobs on every /api/metrics load. Both full-scan
-- today; measured on prod at ~4.1s (candidate group-by) and ~11.3s (orphan join),
-- and because composeMetrics awaits all fetchers together, the ~11s query gates
-- the entire "Loading external analytics…" section. These covering indexes make
-- both index-served. Read-side only; additive and non-breaking.

-- Candidate backlog: GROUP BY kind, (deleting_at IS NOT NULL), reading MIN(marked_at).
-- Before: SCAN gc_candidates + USE TEMP B-TREE FOR GROUP BY. The expression index
-- matches the grouping key exactly, dropping both the scan and the sort.
CREATE INDEX IF NOT EXISTS idx_gc_candidates_kind_open
  ON gc_candidates (kind, (deleting_at IS NOT NULL), marked_at);

-- Orphan bytes: SUM(blobs.size_bytes) over gc_candidates JOIN blobs ON sha256.
-- size_bytes lives only on blobs, whose sole index is the sha256 PK, so today the
-- planner SCANs all ~1.48M blobs and fetches each matching row for size_bytes.
-- Carrying size_bytes in the index makes the join probe index-only (no table fetch).
CREATE INDEX IF NOT EXISTS idx_blobs_sha_size ON blobs (sha256, size_bytes);
