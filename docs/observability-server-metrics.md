# Server metrics — Workers Analytics Engine

Implementation reference for the control-plane observability instrumentation
(`apps/api/src/metrics.ts`). The companion design rationale lives in
`docs/benchmarking-and-observability.md` §5; this file documents the *shipped*
schema and the dashboard queries.

## What's instrumented

Each instrumented op emits one Analytics Engine data point (fire-and-forget; adds no
request latency, never throws into the request path, no-op when the binding is absent):

| op | where | notable fields |
|---|---|---|
| `request` | `worker.ts` fetch envelope | **handler latency (TTFB)**, templated route, HTTP status |
| `commit` | `workspace-sync.ts` DO | latency, body size, blobs/commit, missingBlobs ratio |
| `blob.put` | `blobs.ts` | R2 store time, D1 time, blob size |
| `blob.get` | `blobs.ts` | D1 entitlement time, R2 open time, blob size |
| `multipart.part` | `blobs.ts` | per-part R2 upload time, part size |
| `multipart.complete` | `blobs.ts` | full op time (incl. cleanup), R2 + D1 split, final size, part count |

**Latency caveat (important):** `request.ms` and `blob.get.storeMs` measure *handler*
time — time to produce the `Response`, i.e. time-to-first-byte. They do **not** include
streaming the body to the client (`blobGet` returns an R2 body stream that's piped after
the handler returns). So these are server-side TTFB, not client-perceived download time.
Treat `bytes` ÷ `blob.put.storeMs` as the real upload-throughput signal; downloads need
client-side timing (CLI telemetry, design doc §5.1).

**Coverage caveat:** op-level metrics are emitted for the meaningful work paths and their
notable failure outcomes, not for every early validation guard (e.g. a 413 `too_large`
or pre-quota reject in `blobPut`, or a malformed-commit 400). Those are still captured by
the `request` metric (route + status), so the request panel is the source of truth for
total request counts; op panels describe the work that actually ran.

**§23/§24 follow-on signals:** the current schema should be extended, when those designs
land, with low-cardinality rows for stale receipt rejects (`commit` outcome
`receipt_stale`), orphan reclamation (`gc.orphan` candidate/deleted counts), sidecar fetch
latency (`sidecar.fetch`), sidecar parse latency (`sidecar.parse`), and GC fail-closed
sidecar aborts (`gc.sidecar` abort outcomes). These are validation signals, not a reason to
rework the §23/§24 architecture.

## Privacy

Dimensions and logs carry **only** low-cardinality operational labels — op name, a
**templated** route (`routeTemplate` masks shas / `ws_*` / `dev_*` / `acc_*` ids /
the user-chosen project id / UUIDs / numbers), and a coarse outcome. **No** account/
device/workspace id, path, path hash, blob/commit hash, upload id, token, raw URL, or body
ever enters a dimension or log field. The masking contract is unit-tested (`routeTemplate
privacy masking` in `worker.test.ts`). Numeric AE blobs (durations/sizes/counts/ratios) are
raw so the dashboard can compute arbitrary percentiles; raw numerics are acceptable as
measures, not as join keys, labels, or identifiers.

## Schema (positional — AE columns are fixed)

```
index1  = op           (sampling key)
blob1   = op           (GROUP BY op)
blob2   = route        (templated; "" when N/A)
blob3   = outcome      ("ok" | "conflict" | "epoch_stale" | "unsatisfied_blobs"
                        | "body_too_large" | "receipt_stale" | "<http status>" | ...)
double1 = ms           (primary latency)
double2 = dbMs         (D1 time within the op)
double3 = storeMs      (R2 time within the op)
double4 = bytes        (commit body / blob size)
double5 = count        (blobs per commit, parts)
double6 = ratio        (0..1, e.g. missingBlobs / referenced)
```

Query via the [AE SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/).
Dataset: `rbox_dev_metrics` (dev) / `rbox_prod_metrics` (production).

## Dashboard queries

The four headline panels from the TODO. AE keeps ~3 months; `_sample_interval`
weights each row for the sampled estimate.

**1. Commit latency (p50/p90/p99), hourly**
```sql
SELECT
  intDiv(toUInt32(timestamp), 3600) * 3600 AS hour,
  quantileWeighted(0.50)(double1, _sample_interval) AS p50_ms,
  quantileWeighted(0.90)(double1, _sample_interval) AS p90_ms,
  quantileWeighted(0.99)(double1, _sample_interval) AS p99_ms,
  sum(_sample_interval) AS commits
FROM rbox_prod_metrics
WHERE blob1 = 'commit' AND blob3 = 'ok'
GROUP BY hour ORDER BY hour;
```

**2. Commit-body size distribution** (drives the commit-body-scaling decision —
watch how close p99 creeps to the 1 MB cap, and count `body_too_large` rejections)
```sql
SELECT
  quantileWeighted(0.50)(double4, _sample_interval) AS p50_bytes,
  quantileWeighted(0.99)(double4, _sample_interval) AS p99_bytes,
  max(double4) AS max_bytes,
  sumIf(_sample_interval, blob3 = 'body_too_large') AS rejected_too_large
FROM rbox_prod_metrics
WHERE blob1 = 'commit';
```

**3. Blobs per commit (p50/p99)**
```sql
SELECT
  quantileWeighted(0.50)(double5, _sample_interval) AS p50_blobs,
  quantileWeighted(0.99)(double5, _sample_interval) AS p99_blobs,
  max(double5) AS max_blobs
FROM rbox_prod_metrics
WHERE blob1 = 'commit' AND blob3 = 'ok';
```

**4. missingBlobs ratio** (fraction of referenced blobs missing on commit → the
422→upload round-trips that make a push feel slow)
```sql
SELECT
  intDiv(toUInt32(timestamp), 3600) * 3600 AS hour,
  avgWeighted(double6, _sample_interval) AS avg_missing_ratio,
  sumIf(_sample_interval, blob3 = 'unsatisfied_blobs') AS commits_with_missing,
  sum(_sample_interval) AS total_commits
FROM rbox_prod_metrics
WHERE blob1 = 'commit'
GROUP BY hour ORDER BY hour;
```

**Bonus — slowest routes (find the next thing to fix)**
```sql
SELECT blob2 AS route,
  quantileWeighted(0.99)(double1, _sample_interval) AS p99_ms,
  sum(_sample_interval) AS reqs
FROM rbox_prod_metrics
WHERE blob1 = 'request'
GROUP BY route ORDER BY p99_ms DESC LIMIT 20;
```

**Bonus — R2 vs D1 time split per blob op**
```sql
SELECT blob1 AS op,
  quantileWeighted(0.50)(double3, _sample_interval) AS p50_r2_ms,
  quantileWeighted(0.50)(double2, _sample_interval) AS p50_d1_ms
FROM rbox_prod_metrics
WHERE blob1 LIKE 'blob.%' OR blob1 LIKE 'multipart.%'
GROUP BY op;
```

**Future §23/§24 validation panels** (add when the emitters land)
- Stale receipt rejects: count `blob1 = 'commit' AND blob3 = 'receipt_stale'`.
- Orphan reclaim: count/sum `blob1 = 'gc.orphan'` split by `blob3 = 'candidate'|'deleted'`.
- Sidecar validation: p50/p99 `double1` for `blob1 IN ('sidecar.fetch','sidecar.parse')`.
- GC fail-closed: count `blob1 = 'gc.sidecar'` abort outcomes; any sustained non-zero value
  should page or at least alert because GC must abort rather than condemn on sidecar failure.

## Notes

- AE writes are enabled in production via the `rbox_metrics` binding (wrangler.jsonc).
  Local bun unit tests have no binding → `emit()` no-ops, so nothing to mock.
- A Cloudflare API token with Account Analytics read is needed to run the SQL API;
  wire these queries into a Grafana/Workers dashboard once the token exists.
