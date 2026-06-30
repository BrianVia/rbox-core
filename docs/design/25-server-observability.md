# §25 — Server-side timing & observability (P0-adjacent)

> Status: **🚧 implementation started** (not yet PR'd). A near-complete server
> instrumentation already lives on branch **`obs/server-instrumentation`** (pushed):
> `apps/api/src/metrics.ts` (one Analytics Engine datapoint per op) + instrumented
> blobs/worker/workspace-sync + tests + the `wrangler` AE binding (~347 lines). The
> shipped schema + dashboard SQL are in [`../observability-server-metrics.md`](../observability-server-metrics.md).
> **Resume / open a PR from that branch — don't reimplement.** The design below is the
> intent it realizes.
>
> Implements the server half of `benchmarking-and-observability.md` §5, pulled forward
> because you can't validate §23/§24 throughput wins without it. **"Don't optimize
> blind."** Do the timing seam (§25.1) before/around the §23 work.

## Problem
The Worker has ~no observability — a handful of `console` calls, no request timing, no
per-op latency. We can't attribute the per-blob cost to R2 vs D1 vs DO, and we can't prove
a §23/§24 change actually helped in prod (only the synthetic bench).

## Target
Per-request structured timing with sub-timings (`r2Ms`/`d1Ms`/`doMs`) → Cloudflare Workers
Analytics Engine, under a strict metadata-privacy ban-list. Surfaces p50/p95/p99 per op +
the conc/contention signal.

## Chunks
| # | Chunk | What | Depends |
|---|-------|------|---------|
| 19.1 | [Timing seam + request IDs](25-server-observability/1-timing-seam.md) | one `time()` wrapper around R2/D1/DO calls; structured JSON log line; templated routes | — |
| 19.2 | [Analytics Engine datapoints](25-server-observability/2-analytics-engine.md) | bucketed dims (route, op, status, size-bucket), the privacy ban-list, sampling | 19.1 |

(Client telemetry — `SyncMetrics` + `rbox doctor --report` — stays in the obs doc's P3;
it's not needed to validate server throughput.)

## Hard constraint (carried from obs doc §5)
Metadata threat model, reviewed per chunk: **no** path hashes, raw account/device/workspace
IDs, blob/commit SHAs, upload IDs, tokens, raw URLs, or request/response/error bodies. Use
templated routes (`/v1/ws/{ws}/…`), coarse rotating principals, and **size/duration
buckets**, not raw values.

## Why P0-adjacent (not after)
The §23 plan's success metric is "the conc-32 plateau lifts." 19.1 lets us measure the
server-side D1 time directly (before: ~5 D1/blob; after: O(chunks)) instead of inferring it
from client wall-time. Land 19.1 first, instrument the blob/commit path, then implement §23.
