-- M3: server-authoritative state for resumable R2 multipart uploads.
-- The client keeps a local token as a cache only; on resume it asks the server
-- which parts are already done (codex review: server is the source of truth,
-- resumeMultipartUpload does not validate existence).

CREATE TABLE IF NOT EXISTS uploads (
  sha256      TEXT PRIMARY KEY,        -- content address being assembled
  upload_id   TEXT NOT NULL,          -- R2 multipart upload id
  part_size   INTEGER NOT NULL,       -- uniform non-final part size (bytes)
  total_parts INTEGER NOT NULL,
  size        INTEGER NOT NULL,        -- total object size (bytes)
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS upload_parts (
  upload_id   TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag        TEXT NOT NULL,          -- R2UploadedPart.etag, used ONLY for complete()
  size        INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (upload_id, part_number)
);
