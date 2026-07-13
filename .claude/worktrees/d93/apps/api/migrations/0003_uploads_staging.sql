-- M3 fixes (codex review): assemble multipart into a per-upload STAGING key and
-- only publish to the canonical blob key after R2 verifies the hash, so a bad or
-- concurrent upload can never clobber a good canonical object. Also key uploads
-- by upload_id (not sha) so two devices uploading the same content-addressed sha
-- don't clobber each other's in-flight upload.
--
-- `uploads` holds only transient in-flight state, so recreating it is safe.

DROP TABLE IF EXISTS uploads;

CREATE TABLE uploads (
  upload_id   TEXT PRIMARY KEY,       -- R2 multipart upload id (unique per attempt)
  sha256      TEXT NOT NULL,          -- target content address
  staging_key TEXT NOT NULL,          -- R2 key the MPU assembles into (pre-verification)
  part_size   INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL        -- epoch ms, for expiry/GC before R2's 7-day TTL
);

CREATE INDEX IF NOT EXISTS uploads_sha ON uploads (sha256);
