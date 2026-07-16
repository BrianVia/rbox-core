# §25 — Server-side timing & observability (P0-adjacent)

> Status: **🚧 implementation started** (not yet PR'd). The implementation work is on
> pushed branch **`obs/server-instrumentation`**: `apps/api/src/metrics.ts` (one
> Analytics Engine datapoint per op) + instrumented blobs/worker/workspace-sync + tests +
> the `wrangler` AE binding (~347 lines). The shipped schema + dashboard SQL are in
> [`../observability-server-metrics.md`](../observability-server-metrics.md). If you are
> reading this from another or detached worktree, **fetch/switch to
> `obs/server-instrumentation` and continue there; don't recreate the implementation.**
> The design below is the intent it realizes.
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
the conc/contention signal. Request rows are the source of truth for total request counts;
op rows describe work that actually ran, so early 4xxs may have only a request row.

## Read path (Plane A) — wired into the admin cockpit
The write half above is only useful once someone can *read* it. Rather than stand up a
separate Grafana, the read path lives inside the existing platform-admin cockpit
(§32 Tier 3a, `GET /v1/admin/overview`): `fetchServerMetrics(env)` in `apps/api/src/admin.ts`
runs the AE **SQL API** (`POST /accounts/{id}/analytics_engine/sql`) for per-op latency + the
**D1-vs-R2 split** (the headline: `blob.get` p50 ≈ 228 ms of which ≈ 81% is D1), the outcome
histogram (429/error view), and commit-path percentiles over a rolling 24h window, folded in
as `serverMetrics`. It reuses the cockpit's external-dependency contract exactly
(`fetchFiveXxRate`/`fetchStripeMrrCents`): **best-effort, bounded (3s per-query
AbortController), never throws** — absent `CF_AE_TOKEN`/`CF_ACCOUNT_ID` or any failure →
`serverMetrics: null`, so `/overview` never degrades. The dimensions read are already
privacy-safe (op/route/outcome + numeric measures only). The read token is a separate
`CF_AE_TOKEN` secret (Account Analytics read, AE-SQL grant) — distinct from the GraphQL
`CF_ANALYTICS_TOKEN`. The external admin SPA (admin.rbox.to) renders the fields; the shape is
documented in [`../observability-server-metrics.md`](../observability-server-metrics.md).

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
templated routes (`/v1/ws/{ws}/…`), coarse rotating principals, and bucketed/low-cardinality
log or dimension fields. Raw numeric AE metric blobs (durations, sizes, counts) are allowed
when needed for percentiles, but they must not become dimensions and must never carry IDs,
paths, SHAs, tokens, or raw request material.

## Why P0-adjacent (not after)
The §23 plan's success metric is "the conc-32 plateau lifts." 19.1 lets us measure the
server-side D1 time directly (before: ~5 D1/blob; after: O(chunks)) instead of inferring it
from client wall-time. Land 19.1 first, instrument the blob/commit path, then implement §23.

## Validation signals for §23/§24
§25 is also the production validation surface for the adjacent storage changes:

- **§23 upload receipts / orphan reclaim:** count stale-receipt commit rejects
  (`commit` outcome like `receipt_stale`) plus orphan-GC candidate/deleted counts
  (`gc.orphan` outcomes like `candidate`/`deleted`) so the orphan lifecycle is measurable.
- **§24 blobRef sidecars:** time sidecar R2 fetch and parse (`sidecar.fetchMs`,
  `sidecar.parseMs` or equivalent op rows) and count GC fail-closed aborts (`gc.sidecar`
  abort outcomes). If the current branch does not include GC/reconciliation emitters yet,
  treat these as bounded follow-on signals required before §24 ships.

## Future work (outside core §25)
Blocklist/streaming-overlap metrics belong in a later protocol pass, not this server timing
slice. If rbox adds Dropbox-style prefetch/overlap, track bounded metrics such as prefetched
block counts, prefetch-cache size buckets, cache hit/miss rates, and block-index/download
progress overlap using the same low-cardinality privacy rules.

---

## Benchmarking this change (against **dev**, not prod)

Validate on the **dev** worker `rbox-dev-api` — real Cloudflare D1/R2/DO, the only place
the latency/contention this change targets actually shows up (local Miniflare has ~0
network latency and would hide it). The dev deploy is a **separate, manual** step —
**do NOT promote to `production` to test**: `main` is integration-only;
production deploys from explicit `production` branch updates.

```bash
# on a branch/worktree with the change (server + the client binary if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api (dev only; prod untouched)
bun build --compile --target=bun-darwin-arm64 \      # match your platform; only if the client changed
  ./src/cli/index.ts --outfile /tmp/rbox
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

- **Compare base vs head back-to-back** (deploy baseline → sweep → deploy change → sweep) so
  dev's shared-instance noise cancels — relative deltas are valid even though absolute dev
  numbers wander vs prod.
- **Drive the path this change affects:** push via `push-sweep.ts`; pull/clone-side changes
  by timing a fresh `rbox init --workspace <id>` into an empty dir (a clone-sweep is a TODO).
- **Success metric = this doc's Target/Goal section.** Once the §25 server metrics are live on
  dev you can read the server-side split (`d1Calls` / `d1Ms` / `r2Ms` per op) directly instead
  of inferring it from client wall-time — land §25 on dev first.
- Merge only after dev proof, then explicitly promote `main` to `production`.
- For an **isolated, repeatable** target (no contention with other dev work, wipe-and-repeat),
  set up a dedicated `[env.bench]` → `rbox-bench-api` + throwaway `rbox-bench-db`/`-blobs` and
  point `--remote` at it. (See the README "Benchmarking" section.)
