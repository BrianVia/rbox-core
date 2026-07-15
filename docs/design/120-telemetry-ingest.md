# §120 — Client telemetry ingest (`POST /v1/telemetry`)

> **Status: 📋 DESIGN ONLY — not started.** Deliberately parked (owner decision,
> 2026-07-15): this touches the prod data plane, so it ships as its own reviewed PR when
> picked up, not as part of the rbox-admin cockpit work. No code exists yet. This doc is
> the turnkey spec so implementation is a fill-in-the-blanks job.
>
> **Why it exists.** It is the missing bridge between two halves that already exist:
> §35 (`docs/design/35-client-phase-metrics.md`) instruments the client but keeps every
> metric **local by default** ("shipping them off-device is out of scope"), and §25
> (`docs/design/25-server-observability.md` + `apps/api/src/metrics.ts`) is the server's
> privacy-safe Analytics-Engine observability. The daemon *already computes* everything the
> product-health dashboard wants; the only gap is a path to ship it up. This route is that
> path.
>
> **Consumer.** The rbox-admin cockpit's metrics roadmap (`rbox-admin/docs/metrics-roadmap.md`).
> This single endpoint unblocks **6 of its 9 panels**: #1 propagation health, #2 first-publish
> funnel, #3 fleet version + capability, #4 upload-lane wire vitals, #7 breaker/scan-fault
> events, #9 fleet drift. (The other three — #5 delta-soak, #6 GC gauge, and the outcome/packing
> slices — already shipped in the cockpit reading AE/D1 directly; they need nothing here.)
>
> Line references below are from the 2026-07-15 recon; treat as anchors and re-verify at
> implementation time.

## Problem

Every client-reported product-health signal dies in a local stdout log or `.rbox/state.json`:

- **First-publish stats** (`fp` line): built in `src/cli/upload-lane-timing.ts:123-159`
  (`timeToFilesSyncedMs` at :126, formatted at :334-335, attached at `src/cli/sync/push.ts:670-671`)
  → only `console.log`'d.
- **Propagation lag**: `notify_latency_ms` computed daemon-side (`daemon.ts:1818` set at the WS
  `committed` frame → `daemon.ts:644` at pull dequeue) → only `log()`'d locally.
- **Upload-lane vitals**: bytes + `uploadMs` per push in `upload-lane-timing.ts` (gated on
  `RBOX_LANE_TIMING=1`) → stderr only. (Mbps is not computed anywhere yet.)
- **Capability bit** `workerExecutionsTotal` (`src/engine/crypto-pool/pool.ts:74,148`,
  `cryptoPoolStatus()` at :830-845) → local CLI (`rbox status`/`doctor`) only.
- **Binary version** (`apps/api/src/diagnostics.ts:261,281`) → only in manual, rate-limited
  diagnostics bundles; **not** a column on `devices`.
- **Git-plane drift** (`RepoRecord.base`/`pending`/`deferrals` in `src/cli/config.ts:202-243`)
  → only in `.rbox/state.json`; explicitly kept sender-local (`push.ts:407-411,437-443`).

There is **no** client→server telemetry route today: route dispatch (`apps/api/src/worker.ts:243-310`)
has no such path, and the token allow-lists (`worker.ts:388-428`) enumerate exact pairs, none for
metrics. Admin (rbox-admin) is read-only and **cannot** write — so ingest must live **here**, in the
core API worker, which owns both the device-auth surface and the AE write binding.

## Design

### Route
`POST /v1/telemetry` on the core API worker.

- **Auth:** the existing device Bearer token. The daemon already sends
  `authorization: Bearer <token>` via `RemoteContext` (`src/cli/remote/context.ts:50,64`, with a
  ready `postJson` helper at :127-128; base URL `src/cli/api-base.ts:8`). Add `/v1/telemetry` to the
  authenticated dispatch — **no new auth mechanism**, reuse `authenticate()`.
- **Body:** a small JSON envelope: `{ v: 1, kind: <enum>, samples: [ ... ] }` where `kind` selects the
  metric family (see §Contract). Accept a batch so the daemon can coalesce.
- **Response:** `202 Accepted` with `{ accepted: n }`. Best-effort ingest — never block the client;
  drop-with-200-ish on soft validation issues rather than erroring the sync path.

### Landing: Analytics Engine (not new D1)
Emit each validated sample as one AE datapoint into the existing dataset `rbox_prod_metrics` via the
worker's AE binding (`apps/api/src/env.ts:125` `rbox_metrics`, wired `apps/api/wrangler.jsonc:30` dev /
`:131` prod) using the same `emit()` layout as `apps/api/src/metrics.ts:91-110`. Benefits, all free:
retention (~90d) gives the cockpit **history / baseline bands** with no snapshot table, and the cockpit's
existing AE-SQL reader consumes it unchanged.

Use `index1` to name the family so the reader can `WHERE index1='...'`, mirroring the server ops
convention. Proposed layout (fit numbers into `double1..N`, low-cardinality enums into `blob2..N`):

| kind (`index1`) | doubles | blobs (enums only) |
|---|---|---|
| `propagation` | `double1=deliveryToApplyMs` | — |
| `first_publish` | `double1=timeToFilesSyncedMs`, `double2=publishWallMs`, `double3=fileCount`, `double4=uniqueBlobs` | `blob2=corpusBucket` |
| `upload_lane` | `double1=mbps`, `double2=settleMs`, `double3=bytes` | `blob2=dispatchReason`, `blob3=fillVersion` |
| `capability` | `double1=workerExecutions`, `double2=version_ok?1:0` | `blob2=binaryVersion` |
| `safety_event` | `double1=count` | `blob2=eventType` (`mass_delete_breaker`/`scan_fault`) |

### Contract & privacy — the first *enforced* choke point
Today the privacy rule (`apps/api/src/metrics.ts:12-24`: counts/timings/enums only — **never** an
account/device/workspace id, path, path-hash, or blob/commit hash) is **convention**, enforced per-emitter.
Because this route accepts client-supplied data, the ingest handler MUST be a **hard validator**: reject
any field that isn't a number or a value from a fixed enum allow-list; cap `blob*` cardinality; never
persist a free-form string. This is the first code-enforced boundary and is a **hard prerequisite** — do
not ship the route without it.

## Metric definitions (locked 2026-07-15)

These were decided against what the clocks/fields actually permit — do not silently redefine:

- **#1 propagation = subscriber notify→applied (single-clock).** Stamp `Date.now()` after checkout
  (`daemon.ts:1413`) minus `notifyPullPendingAt` (`daemon.ts:1818`). Both are the **same subscriber
  clock → zero skew.** There is **no publisher-commit timestamp** anywhere and the 3 clocks are unsynced,
  so a true end-to-end number would be cross-clock and undefensible (that's what the manual ~17s field
  figure measured). Label the emitted metric honestly as *delivery→apply* — it reads lower than ~17s
  because it excludes publish + server fanout. **No per-host p95 split** is possible: AE dimensions
  forbid host/device labels and there is no permitted low-cardinality stand-in.
- **#4 wire-Mbps = `8 * bytes / (uploadMs/1000) / 1e6`, whole-push aggregate.** Per-blob attribution is a
  fake even-split (`pack-uploader.ts:276-279`) — use the aggregate. `uploadMs` already **excludes** queue
  wait (`uploader.ts:442,470`), so it isn't idle-polluted; it still includes TTFB + server processing, a
  mild understatement that's acceptable. Emit `dispatchReason` (enum: `full_records|full_bytes|fixed_timer|quiet|absolute|idle_tail`,
  `upload-lane-timing.ts:68-70`) and `fillVersion` (`RBOX_BATCH_FILL` v1/v2, `config.ts:80`) as
  **separate axes** — they are orthogonal; do not conflate.
- **#2 first-publish:** ship `timeToFilesSyncedMs` + `publishWallMs` (`phase-report.ts:207`) **and** the
  corpus-size key (`files`/`ct`) — the bucket key is NOT inside the `fp` struct today, so it must be added
  to the emit alongside.
- **#3 capability + version:** ship `workerExecutions` (extend the diagnostics `METRICS_KEYS` allow-list,
  `diagnostics.ts:20`, which currently drops it) and the binary version. Version is otherwise unavailable
  as a fleet snapshot (only in rate-limited diagnostics bundles); the alternative is adding `devices.version`
  written on `authenticate()` — pick one at implementation.

## #9 fleet drift — a *state upsert*, not an append-only metric (related, distinct)

#9 wants the **current** git-plane position per device×repo, not a time-series. The daemon already knows
it correctly (verified: `RepoRecord.base` stays pinned, `pending` held, `deferrals.apply.deferredSince`
stamped — **no detection bug**; the Mac "in sync" incident was purely "knew but didn't ship"). So this is
a sibling ingest with a **D1 upsert** landing, not AE:

- New table (rbox-core migration): `device_repo_sync(device_id, workspace_id, project_id, file_seq,
  git_seq, deferral_reason, deferred_since, updated_at)`, upserted per report.
- Daemon reports `gitDivergenceStatus.deferrals` (shape at `src/cli/sync-git/status.ts:22-37`) on each
  sync tick, near the `deferralValues` save (`src/cli/sync/push.ts:437-454`).
- Cockpit alert band: any repo `deferred_since` > 24h. After §116 (checkout-follows-sync), any nonzero
  drift is real human divergence, not noise.

Decide whether to fold this under `/v1/telemetry` (with an upsert `kind`) or a dedicated
`POST /v1/fleet/sync-state`. Recommend the latter — different landing (D1 vs AE), different semantics
(current-state vs sample).

## Open decisions
1. `devices.version` column vs version-in-telemetry (#3) — one source of truth for the version histogram.
2. `/v1/telemetry` single route with `kind` switch vs a small family of routes. (Single + validator is leaner.)
3. Sampling/rate-limit per device to bound AE write volume at fleet scale.
4. #9 landing route shape (see above).

## Non-goals
- Any path/sha/id in the payload (hard-blocked by the validator).
- Backfill — this is forward-only; the cockpit's history begins at ingest go-live.
- Building it now: parked pending owner go-ahead on prod-data-plane work.
