# §25.2 — Workers Analytics Engine datapoints

> Chunk of [§25](../25-server-observability.md). Depends on [§25.1](1-timing-seam.md).
> Turns the per-request timing into queryable p50/p95/p99 + contention signal.

## Problem
The §25.1 log line is per-request and ephemeral. We need aggregate, queryable latency/
throughput per operation over time — without standing up an external APM.

## Design
- Bind a **Workers Analytics Engine** dataset (`wrangler.jsonc` `analytics_engine_datasets`).
- On `obs.finish`, write **one datapoint**:
  - **blobs** (numeric): `durMs`, `r2Ms`, `d1Ms`, `doMs`, `d1Calls`.
  - **indexes/blobs** (dimensions, all coarse): `route` (templated), `op`
    (`blobPut|blobGet|multipart*|commit|pull|check`), `status`, `sizeBucket`.
- Query via the Analytics Engine SQL API for p50/p95/p99 per (op, route) and the 409/contention
  rate. Optionally a tiny `apps/web` admin page or a Cloudflare dashboard.

## Privacy (the must-instrument paths, the must-never dims)
- **Instrument:** `blobPut` (R2+D1 split), commit validation + grant batch (the §23 win
  metric), `missingBlobs`, the DO `transactionSync` hold time + 409 rate (the contention
  signal), multipart.
- **Never as a dimension:** account/device/workspace id, blob/commit sha, upload id, path or
  path-hash, token, raw route. Use the templated route + coarse buckets only (obs doc ban-list).
- **Sampling:** Analytics Engine samples at high volume; record the sample interval and note
  p99 fidelity drops under heavy sampling (obs doc open question). Low volume now → no sampling.

## The §23 success metric, made measurable
Before §23: expect `d1Calls ≈ 5 × blobs`, high `d1Ms` on `blobPut`. After §23: `blobPut`
`d1Calls ≈ 0`, `commit` `d1Calls ≈ chunks`. This datapoint **proves** the win in prod, not
just on the synthetic sweep.

## Tests
- A request emits exactly one datapoint with allow-listed dims only (redaction test).
- Buckets map correctly; op classification matches the route.

## Depends on / Status
Depends on: §25.1. Status: **design**. Enables slow-op alerting + the dashboard (obs doc P4).
