-- M6: reachability GC support.
-- `workspaces` — authoritative-ish registry written on every commit, so GC can
-- enumerate which workspace DOs exist to ask each for its authoritative roots.
-- `gc_candidates` — blobs GC has condemned (NOT yet deleted; canonical R2 keys
-- are never moved). The blob-existence check treats a candidate as MISSING, so a
-- new dedup reference forces a re-upload that resurrects (un-condemns) the blob.

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, project_id)
);

CREATE TABLE IF NOT EXISTS gc_candidates (
  sha256    TEXT PRIMARY KEY,  -- the content-address (blob or manifest) condemned
  kind      TEXT NOT NULL,     -- 'blob' | 'manifest'
  marked_at INTEGER NOT NULL
);
