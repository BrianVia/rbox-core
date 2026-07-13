-- Design 114: immutable pack inventory, active blob placement, and conservative
-- pack-GC candidacy. Absence from blob_locations continues to mean canonical.

CREATE TABLE IF NOT EXISTS packs (
  pack_id      TEXT PRIMARY KEY,
  pack_sha256  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('uploading','ready','swept')),
  created_at   INTEGER NOT NULL,
  touched_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_packs_created ON packs (created_at);

CREATE TABLE IF NOT EXISTS pack_members (
  pack_id TEXT NOT NULL,
  sha256  TEXT NOT NULL,
  offset  INTEGER NOT NULL,
  length  INTEGER NOT NULL,
  PRIMARY KEY (pack_id, sha256)
);

CREATE TABLE IF NOT EXISTS blob_locations (
  sha256       TEXT PRIMARY KEY,
  storage      TEXT NOT NULL CHECK (storage IN ('pack')),
  pack_id      TEXT NOT NULL,
  offset       INTEGER NOT NULL,
  length       INTEGER NOT NULL,
  pack_sha256  TEXT NOT NULL,
  installed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blob_locations_pack ON blob_locations (pack_id);

CREATE TABLE IF NOT EXISTS pack_gc_candidates (
  pack_id     TEXT PRIMARY KEY,
  epoch       TEXT NOT NULL,
  marked_at   INTEGER NOT NULL,
  deleting_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pack_gc_candidates_intent
  ON pack_gc_candidates (marked_at, pack_id) WHERE deleting_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pack_gc_candidates_execute
  ON pack_gc_candidates (deleting_at, pack_id) WHERE deleting_at IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS blob_locations_insert_delete_fence
BEFORE INSERT ON blob_locations FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM pack_gc_candidates pg
  WHERE pg.pack_id = NEW.pack_id AND pg.deleting_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_delete_fence_pack');
END;

CREATE TRIGGER IF NOT EXISTS blob_locations_update_delete_fence
BEFORE UPDATE ON blob_locations FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM pack_gc_candidates pg
  WHERE pg.pack_id = NEW.pack_id AND pg.deleting_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_delete_fence_pack');
END;

CREATE TRIGGER IF NOT EXISTS blob_locations_insert_inventory_guard
BEFORE INSERT ON blob_locations FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM pack_members m JOIN packs p ON p.pack_id = m.pack_id
  WHERE m.pack_id = NEW.pack_id AND m.sha256 = NEW.sha256
    AND m.offset = NEW.offset AND m.length = NEW.length AND p.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_pack_inventory');
END;

CREATE TRIGGER IF NOT EXISTS blob_locations_update_inventory_guard
BEFORE UPDATE ON blob_locations FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM pack_members m JOIN packs p ON p.pack_id = m.pack_id
  WHERE m.pack_id = NEW.pack_id AND m.sha256 = NEW.sha256
    AND m.offset = NEW.offset AND m.length = NEW.length AND p.state = 'ready'
)
BEGIN
  SELECT RAISE(ABORT, 'rbox_pack_inventory');
END;

CREATE TRIGGER IF NOT EXISTS blob_locations_delete_pack_candidate
AFTER DELETE ON blob_locations FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id = OLD.pack_id)
BEGIN
  INSERT INTO pack_gc_candidates (pack_id, epoch, marked_at)
  VALUES (
    OLD.pack_id,
    lower(hex(randomblob(16))),
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ) ON CONFLICT(pack_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS blob_locations_move_pack_candidate
AFTER UPDATE OF pack_id ON blob_locations FOR EACH ROW
WHEN OLD.pack_id != NEW.pack_id
  AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id = OLD.pack_id)
BEGIN
  INSERT INTO pack_gc_candidates (pack_id, epoch, marked_at)
  VALUES (
    OLD.pack_id,
    lower(hex(randomblob(16))),
    CAST(strftime('%s','now') AS INTEGER) * 1000
  ) ON CONFLICT(pack_id) DO NOTHING;
END;
