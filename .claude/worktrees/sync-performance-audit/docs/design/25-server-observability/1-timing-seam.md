# §25.1 — Timing seam + structured request logs

> Chunk of [§25](../25-server-observability.md). The instrumentation foundation; everything
> else (Analytics Engine, dashboards, slow-op alerts) reads from this. No external deps.

## Problem
There's no single place that times a request or its sub-operations. We need consistent,
low-overhead timing around the three cost centers — R2, D1, DO — and one structured log
line per request, WITHOUT leaking metadata.

## Design
- **`time(label, fn)`** helper (`apps/api/src/obs.ts`) using `performance.now()`, returns
  the value and records `{label, ms}` into a per-request collector held on the request ctx.
- Wrap the hot calls: `r2.put/get/head`, each D1 `prepare().run()/all()/first()`/`batch()`,
  and the DO `fetch`/`transactionSync`. Aggregate into `r2Ms`, `d1Ms`, `doMs`, `d1Calls`.
- **One JSON log line per request** at completion: `{ reqId, route(templated), method,
  status, durMs, r2Ms, d1Ms, doMs, d1Calls, sizeBucket }`. Replaces the ad-hoc `console`.
  This line is emitted for early validation failures too, so request logs remain the total
  request-count source even when no op-level work starts.
- `reqId`: random per request (not derived from any principal). `route`: **templated** —
  params stripped (`/v1/ws/:ws/proj/:proj/...` → `/v1/ws/{ws}/proj/{proj}/...`).
- Overhead: `performance.now()` + object pushes only; no I/O on the hot path beyond the
  single final log line. Negligible vs an R2/D1 round-trip.

## Privacy (enforced here, not just documented)
- The log line carries **no** raw IDs, SHAs, paths, tokens, bodies, or raw URLs.
- `sizeBucket` = coarse bucket (e.g. `<1KiB|1-64KiB|64KiB-1MiB|>1MiB`), never the exact byte
  count. Duration is the real ms (not sensitive on its own; it's the server's own latency).
- A tiny allow-list of fields is logged; anything not on it is dropped. Reviewed per the obs
  doc ban-list.

## Interface
```ts
const obs = startRequestObs(req);           // reqId, templated route, timers
const x = await obs.time("d1", () => stmt.run());
…
obs.finish(status, { sizeBucket });         // emits the one JSON line (+ §25.2 datapoint)
```

## Tests
- `time()` accumulates into the right bucket; concurrent ops don't cross-contaminate.
- The emitted line contains only allow-listed fields; a route with params is templated;
  no raw sha/id/path can appear (assert via a redaction test over sample requests).
- Early 4xx paths still emit the final request line with route + status and no leaked body,
  URL, id, SHA, or token.

## Depends on / Status
Depends on: nothing. Status: **design**. Land FIRST so §23/§24 changes are measurable.
