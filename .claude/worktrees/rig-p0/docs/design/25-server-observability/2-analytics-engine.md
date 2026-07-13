# §25.2 — Workers Analytics Engine datapoints

> Chunk of [§25](../25-server-observability.md). Depends on [§25.1](1-timing-seam.md).
> Turns the per-request timing into queryable p50/p95/p99 + contention signal.

## Problem
The §25.1 log line is per-request and ephemeral. We need aggregate, queryable latency/
throughput per operation over time — without standing up an external APM.

## Design
- Bind a **Workers Analytics Engine** dataset (`wrangler.jsonc` `analytics_engine_datasets`).
- On `obs.finish`, always write one `request` datapoint. Instrumented work paths also emit
  op datapoints, but only after that work actually starts; early 4xx validation guards may
  have no op row. Use `request` rows for total request counts.
  - **blobs** (numeric): `durMs`, `r2Ms`, `d1Ms`, `doMs`, `d1Calls`, and bounded counts/bytes
    where they are the measured value.
  - **indexes/blobs** (dimensions, all coarse): `route` (templated), `op`
    (`request|blobPut|blobGet|multipart*|commit|pull|check`), `status`, `sizeBucket`.
- Query via the Analytics Engine SQL API for p50/p95/p99 per (op, route) and the 409/contention
  rate. Optionally a tiny `apps/web` admin page or a Cloudflare dashboard.

## Privacy (the must-instrument paths, the must-never dims)
- **Instrument:** `blobPut` (R2+D1 split), commit validation + grant batch (the §23 win
  metric), `missingBlobs`, the DO `transactionSync` hold time + 409 rate (the contention
  signal), multipart.
- **§23 follow-ons:** stale-receipt rejects as a commit outcome (`receipt_stale`) and orphan
  reconciliation counts as bounded `gc.orphan` rows (`candidate`/`deleted`).
- **§24 follow-ons:** sidecar fetch latency + sidecar parse latency (`sidecar.fetch` /
  `sidecar.parse`) and GC fail-closed abort counts (`gc.sidecar` abort outcomes).
- **Never as a dimension:** account/device/workspace id, blob/commit sha, upload id, path or
  path-hash, token, raw route. Use the templated route + coarse buckets only (obs doc ban-list).
- **Raw numerics are OK as measures:** AE numeric blobs may store raw durations, byte sizes,
  counts, and ratios so percentile queries remain valid. Do not duplicate those values into
  dimensions or logs.
- **Sampling:** Analytics Engine samples at high volume; record the sample interval and note
  p99 fidelity drops under heavy sampling (obs doc open question). Low volume now → no sampling.

## The §23 success metric, made measurable
Before §23: expect `d1Calls ≈ 5 × blobs`, high `d1Ms` on `blobPut`. After §23: `blobPut`
`d1Calls ≈ 0`, `commit` `d1Calls ≈ chunks`. This datapoint **proves** the win in prod, not
just on the synthetic sweep. Add stale-receipt rejects and orphan candidate/deletion counts
with §23.5/reconciliation so the new orphan lifecycle is observable.

## The §24 validation metric, made measurable
For sidecar commits, separately time the sidecar R2 fetch and parse path, then count
GC sidecar fail-closed aborts. These signals prove that §24's validation and retained-root
GC path is working without adding sidecar hashes, workspace IDs, or paths to analytics.

## Tests
- A request emits exactly one datapoint with allow-listed dims only (redaction test).
- Buckets map correctly; op classification matches the route.

## Depends on / Status
Depends on: §25.1. Status: **design**. Enables slow-op alerting + the dashboard (obs doc P4).
