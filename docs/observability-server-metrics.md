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
| `blob.batchPut.auth` | `blob-batch.ts` | upload authentication path outcome (`fast_path`, `fallback_missing`, `fallback_invalid`, or `fallback_expired`) |
| `multipart.part` | `blobs.ts` | per-part R2 upload time, part size |
| `multipart.complete` | `blobs.ts` | full op time (incl. cleanup), R2 + D1 split, final size, part count, completion total/assemble/reread/cleanup decomposition |

Successful multipart-complete responses also carry a numbers-only `serverTimings`
object with total/assemble/reread/accounting milliseconds for client reconciliation.
Cleanup runs in `finally`, so it remains metric-only and is excluded from that response.

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
double4 = doMs         (Durable Object time, e.g. transactionSync hold)
double5 = bytes        (commit body / blob size)
double6 = count        (blobs per commit, parts)
double7 = ratio        (0..1, e.g. missingBlobs / referenced)
double8 = dbCalls      (# D1 statements/batches — the §23 success metric)
double9 = serverTotalMs    (commit handler wall time returned to the client)
double10 = envelopeMs      (commit request read, parse, and validation)
double11 = accountingMs    (receipt/entitlement accounting or legacy existence check)
double12 = sidecarMs       (sidecar resolution, including its lookup and parse)
double13 = commitMs        (Durable Object head CAS)
double14 = mirrorMs        (alarm scheduling, fanout, and D1 mirror)
double15 = responseMs      (response payload assembly before final serialization)
double16 = earlyReject     (commit preflight reject indicator)
```

The multipart-complete phase decomposition (design 101 P0.2) is its own AE
point (`emitDelta` precedent — the shared array stays frozen):
indexes `["multipart.complete.phases"]`, blobs `[op, outcome]`, doubles
`[totalMs, assembleMs, rereadPutMs, cleanupMs]` where `totalMs` is entry
through success-response assembly (excludes `finally` cleanup), `assembleMs`
is R2 MPU assembly, `rereadPutMs` is the staging reread plus verified
canonical put, and `cleanupMs` is the staging delete plus upload-row cleanup.

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
  quantileWeighted(0.50)(double5, _sample_interval) AS p50_bytes,
  quantileWeighted(0.99)(double5, _sample_interval) AS p99_bytes,
  max(double5) AS max_bytes,
  sumIf(_sample_interval, blob3 = 'body_too_large') AS rejected_too_large
FROM rbox_prod_metrics
WHERE blob1 = 'commit';
```

**3. Blobs per commit (p50/p99)**
```sql
SELECT
  quantileWeighted(0.50)(double6, _sample_interval) AS p50_blobs,
  quantileWeighted(0.99)(double6, _sample_interval) AS p99_blobs,
  max(double6) AS max_blobs
FROM rbox_prod_metrics
WHERE blob1 = 'commit' AND blob3 = 'ok';
```

**4. missingBlobs ratio** (fraction of referenced blobs missing on commit → the
422→upload round-trips that make a push feel slow)
```sql
SELECT
  intDiv(toUInt32(timestamp), 3600) * 3600 AS hour,
  avgWeighted(double7, _sample_interval) AS avg_missing_ratio,
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

**§23 success metric — D1 calls per op** (the headline: `blob.put` ≈ 5 today,
should fall to ~0 once upload-receipts move accounting to commit-time)
```sql
SELECT blob1 AS op,
  quantileWeighted(0.50)(double8, _sample_interval) AS p50_d1_calls,
  quantileWeighted(0.99)(double8, _sample_interval) AS p99_d1_calls,
  quantileWeighted(0.50)(double2, _sample_interval) AS p50_d1_ms
FROM rbox_prod_metrics
WHERE blob1 IN ('blob.put', 'blob.check', 'commit', 'request')
GROUP BY op;
```

**Commit DO contention — `transactionSync` hold (doMs)**
```sql
SELECT
  quantileWeighted(0.50)(double4, _sample_interval) AS p50_do_ms,
  quantileWeighted(0.99)(double4, _sample_interval) AS p99_do_ms,
  sumIf(_sample_interval, blob3 = 'conflict') AS conflicts
FROM rbox_prod_metrics
WHERE blob1 = 'commit';
```

**Future §23/§24 validation panels** (add when the emitters land)
- Stale receipt rejects: count `blob1 = 'commit' AND blob3 = 'receipt_stale'`.
- Orphan reclaim: count/sum `blob1 = 'gc.orphan'` split by `blob3 = 'candidate'|'deleted'`.
- Sidecar validation: p50/p99 `double1` for `blob1 IN ('sidecar.fetch','sidecar.parse')`.
- GC fail-closed: count `blob1 = 'gc.sidecar'` abort outcomes; any sustained non-zero value
  should page or at least alert because GC must abort rather than condemn on sidecar failure.

## Read path — admin cockpit (§25 Plane A)

The write path (above) is one side; the read path is wired into the platform-admin cockpit
so the numbers surface without a separate Grafana. `fetchServerMetrics(env)` in
`apps/api/src/admin.ts` runs three of the queries above (per-op latency + D1/R2 split, the
outcome histogram, and commit-path percentiles) over a rolling 24h window and folds the
result into `GET /v1/admin/overview` as `serverMetrics`:

```jsonc
"serverMetrics": {
  "windowHours": 24,
  "perOp":    [{ "op": "blob.get", "ops": 65406, "p50Ms": 228, "p99Ms": 446, "d1P50": 185, "r2P50": 40 }, …],
  "outcomes": [{ "outcome": "ok", "n": 93809 }, { "outcome": "too_many_refs", "n": 1 }, …],
  "commit":   { "p50Ms": 388, "p99Ms": 2361, "commits": 4 },
  "generatedAt": 1751371200000
}
```

The headline the panel must make visible is the **D1-vs-R2 split** (`d1P50` vs `r2P50`): e.g.
`blob.get` p50 ≈ 228 ms of which ≈ 185 ms (81%) is D1 (one entitlement read per GET) vs ≈ 40 ms
R2. The external admin SPA (admin.rbox.to — a separate repo) renders these fields.

Contract, mirroring the other cockpit externals (Stripe MRR, 5xx rate): **best-effort +
bounded + never throws.** Absent `CF_AE_TOKEN`/`CF_ACCOUNT_ID` or any query failure →
`serverMetrics: null` (the field is simply absent), with a 3s per-query `AbortController` so a
slow AE call can't hang `/overview`.

## Notes

- AE writes are enabled in production via the `rbox_metrics` binding (wrangler.jsonc).
  Local bun unit tests have no binding → `emit()` no-ops, so nothing to mock.
- The SQL API needs a Cloudflare token with the **Account Analytics** read grant (AE SQL
  scope). It's the `CF_AE_TOKEN` Wrangler **secret** — deliberately distinct from
  `CF_ANALYTICS_TOKEN` (the GraphQL 5xx-rate token), since the two grants were minted
  separately and conflating them silently breaks one path when the other's scope narrows. Set
  it with `cd apps/api && bunx wrangler secret put CF_AE_TOKEN`. The read dataset is the
  `CF_METRICS_DATASET` var (default `rbox_prod_metrics`; must match the `rbox_metrics` binding).
