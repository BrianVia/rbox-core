-- Design 95: durable GC cursors/lease and the publication fence for open delete
-- intents.  D1 is the serialization point: any publication touching a fenced
-- sha aborts its whole transaction.

CREATE TABLE IF NOT EXISTS gc_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

ALTER TABLE gc_candidates ADD COLUMN deleting_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_gc_candidates_execute
  ON gc_candidates (deleting_at, sha256) WHERE deleting_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gc_candidates_intent
  ON gc_candidates (marked_at, sha256) WHERE deleting_at IS NULL;

CREATE TRIGGER IF NOT EXISTS blob_refs_delete_fence
BEFORE INSERT ON blob_refs FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM gc_candidates c
  WHERE c.sha256 = NEW.sha256 AND c.deleting_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_delete_fence');
END;

CREATE TRIGGER IF NOT EXISTS blobs_insert_delete_fence
BEFORE INSERT ON blobs FOR EACH ROW
WHEN NEW.present = 1 AND EXISTS (
  SELECT 1 FROM gc_candidates c
  WHERE c.sha256 = NEW.sha256 AND c.deleting_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_delete_fence');
END;

CREATE TRIGGER IF NOT EXISTS blobs_present_delete_fence
BEFORE UPDATE OF present ON blobs FOR EACH ROW
WHEN NEW.present = 1 AND EXISTS (
  SELECT 1 FROM gc_candidates c
  WHERE c.sha256 = NEW.sha256 AND c.deleting_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_delete_fence');
END;
