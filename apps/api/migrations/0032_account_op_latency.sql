-- Server-side per-account/device latency rollup (SPEC-PER-ACCOUNT-LATENCY).
-- Hourly pre-aggregated buckets so the account/device id the request already carries
-- can be retained in OUR OWN D1 (never AE, never the wire) for support drill-down, with
-- a retention window we control. One row per (account, device, route, hour).
--   mean latency = sum_ms / count           (exact)
--   p50/p95      = interpolated from b0..b5  (approximate, no per-sample storage)
--   throughput   = sum_bytes / (sum_ms/1000) (best-effort, from Content-Length)
--   where our time goes = sum_db_ms / sum_store_ms  (D1 vs R2)
CREATE TABLE account_op_latency (
  account_id   TEXT    NOT NULL,
  device_id    TEXT    NOT NULL DEFAULT '',  -- '' for grant-authed blob ops (no device in credential)
  route        TEXT    NOT NULL,             -- e.g. 'GET /v1/blobs/:sha', 'POST /v1/sync/commit'
  hour_bucket  INTEGER NOT NULL,             -- floor(epoch_ms / 3600000)
  count        INTEGER NOT NULL DEFAULT 0,
  err_count    INTEGER NOT NULL DEFAULT 0,   -- HTTP status >= 400
  sum_ms       INTEGER NOT NULL DEFAULT 0,
  max_ms       INTEGER NOT NULL DEFAULT 0,
  sum_db_ms    INTEGER NOT NULL DEFAULT 0,
  sum_store_ms INTEGER NOT NULL DEFAULT 0,
  sum_bytes    INTEGER NOT NULL DEFAULT 0,
  b0 INTEGER NOT NULL DEFAULT 0,  -- <100ms
  b1 INTEGER NOT NULL DEFAULT 0,  -- <300ms
  b2 INTEGER NOT NULL DEFAULT 0,  -- <1s
  b3 INTEGER NOT NULL DEFAULT 0,  -- <3s
  b4 INTEGER NOT NULL DEFAULT 0,  -- <10s
  b5 INTEGER NOT NULL DEFAULT 0,  -- >=10s
  PRIMARY KEY (account_id, device_id, route, hour_bucket)
);
CREATE INDEX account_op_latency_by_hour ON account_op_latency (hour_bucket);
