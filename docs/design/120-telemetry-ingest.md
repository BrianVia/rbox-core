# §120 — Client telemetry ingest (`POST /v1/telemetry`)

> **Status: 🚧 IN PROGRESS — unparked 2026-07-15 (owner go-ahead).** Ships as its own
> reviewed PR. The four open decisions are resolved in §Resolved decisions below; the
> original analysis is preserved unchanged underneath.
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

## Open decisions — RESOLVED 2026-07-15 (see §Resolved decisions)
1. `devices.version` column vs version-in-telemetry (#3) — one source of truth for the version histogram.
2. `/v1/telemetry` single route with `kind` switch vs a small family of routes. (Single + validator is leaner.)
3. Sampling/rate-limit per device to bound AE write volume at fleet scale.
4. #9 landing route shape (see above).

## Resolved decisions (2026-07-15, implementation round)

### D1 — version source of truth: `devices.last_seen_version` — **already shipped, nothing to build**
Recon (2026-07-15 implementation round) found this decision was already made and implemented:
migration `0026_device_last_seen_version.sql` added `devices.last_seen_version`, `authenticate()`
(`apps/api/src/auth/authenticate.ts:26-73`) reads the `x-rbox-version` header (semver-validated),
and updates the column on change (throttled: 10 min normally, 60s floor on version change).
`RemoteContext.auth` (`src/cli/remote/context.ts:52`) already sends the header. The Problem
section's "not a column on devices" claim is stale.

- Panel #3's version histogram reads `devices.last_seen_version` + `last_seen_at`. **No new code**
  — except one rider bug-fix found in review round 1 (F4): when a *present but invalid*
  `x-rbox-version` header arrives, `authenticate.ts:64-73` computes `lastSeenVersion = null` and,
  past the 60s floor, writes **NULL over a previously-known version**. Fix: only treat the version
  as changed when the header validates; preserve the stored value on invalid input. With a test.
- Precision (F5): the column updates on every request that traverses bearer `authenticate()` —
  grant fast paths return earlier and don't refresh it. That's fine; handshake/control traffic is
  frequent enough.
- Consequence: the AE `capability` kind drops `blob2=binaryVersion` and `double2=version_ok`
  entirely — it carries `workerExecutions` only. No second source of truth.

### D2 — single route `POST /v1/telemetry` with a `kind` switch
As recommended. The hard validator is a **declarative per-kind schema table** (numeric fields →
positional doubles; enum fields → exact allow-lists), not per-kind imperative code — adding a kind
means adding a table row, and nothing outside the table can reach AE. Strict semantics: unknown
`kind`, unknown field, non-finite/negative number, or non-allow-listed enum value → **drop the whole
sample** (counted, not erred). Response `202 {accepted, dropped}`.

Enforcement structure (review round 1, F6 — the table must be *provably* the only path to AE):
- The schema table is a `const` object; the accepted-kind union is **derived from its keys**
  (`satisfies`), so a kind cannot exist outside the table.
- The validator's only output is a normalized positional `{index, blobs, doubles}` value type;
  a dedicated writer (`emitClientMetric`) accepts **only that type** and is the only code that calls
  `writeDataPoint` for client data. Client telemetry NEVER routes through the generic `emit()`.
- Blobs are **reconstructed from the matched canonical enum value**, never copied/spread from the
  request object. Unknown own-keys on a sample → drop.
- Every numeric field carries an explicit finite maximum and an integer/continuous rule in the
  schema row (e.g. ms fields capped at 7 days, counts at 10^7, mbps at 10^5) — non-negative-finite
  alone would let a hostile token holder submit `1e308` and destroy percentiles, or encode
  identifiers numerically. Out-of-domain → drop the sample.
- Privacy tests prove: arbitrary strings, extra fields, identifier-shaped values, and non-schema
  kinds cannot reach `writeDataPoint()`.

Drop observability (F7 — silent drops would make "missing telemetry" ambiguous, the exact
ambiguity the cockpit exists to resolve): the server emits a low-cardinality counter point
(`client.telemetry.drops`, `blob2=dropReason` ∈ `unknown_kind|unknown_field|bad_number|bad_enum|
batch_cap|body_cap|bad_state|unauthorized`, `double1=count`) per request with nonzero drops; the daemon logs nonzero
`dropped` counts (bounded, no payload echo).

Exact wire contract (round 2 — protocol errors vs sample drops are distinct):

- Envelope: `{ v: 1, samples: [...] }`, `assertOnlyKeys` on the envelope and on every sample.
  Body that fails `readBodyCapped` (32 KiB) → **HTTP 413** (+ `body_cap` drop point); body that is
  not valid JSON, not an object, `v !== 1`, or `samples` not an array → **HTTP 400**. These are
  protocol errors (a correct client never hits them), not sample drops.
- `samples.length > 64` → process the first 64, drop+count the excess as `batch_cap` → still 202.
- Everything else is a per-sample drop (202): unknown `kind`, unknown own-key, missing required
  field, wrong type, non-finite / negative / out-of-domain number, non-allow-listed enum value.
- Per-field numeric domains (schema rows): all `*Ms` fields integer `[0, 604_800_000]` (7 days);
  `fileCount`/`uniqueBlobs`/`opCount`/`count` integer `[0, 10_000_000]`; `bytes` integer
  `[0, 10^13]`; `workerExecutions` integer `[0, 10^9]`. (`mbps`/`corpusBucket` are server-derived,
  §AE table — not wire fields.)
- Response: `202 {accepted, dropped}` in all non-4xx cases.

### D3 — sampling/rate-limit: client coalescing + per-device rate limit + server caps
Revised after review round 1 (F1: size caps bound one invocation, not request *rate* — a malicious
device-token holder could send unlimited concurrent requests; F8: one global drop-oldest ring
systematically evicts rare events).

- Client: **per-family retention**, not one global ring (exact mechanics, round 2):
  - `safety_event`: coalesced per event type into counters — never evicted.
  - `capability`: single latest-value slot.
  - `first_publish`: ring of 16 (rare by nature; effectively never wraps).
  - `propagation`, `upload_lane`: rings of 64 each, drop-oldest **within family only** (dropped
    counts logged locally, bounded).
  - Flush: at most once per 120s, only when non-empty, riding the unref'd-heartbeat pattern. One
    request per flush, draining up to 64 samples in family order `safety_event, capability,
    first_publish, upload_lane, propagation` (rarest/highest-value first). Items are removed
    **only on 202**; on network error / 5xx they stay queued for the next tick (no immediate
    retry); on **429** skip the next tick (240s effective backoff). Leftovers beyond 64 wait for
    the next tick.
  - Kill switch `RBOX_TELEMETRY=0` evaluated **both at enqueue and at flush**, with a test proving
    no telemetry network call is made when set (default on — telemetry goes to the operator's
    *own* worker; note for open-source docs).
- Daemon shutdown: one best-effort final flush, sequenced **after** the pump drain completes (so it
  can never delay sync integrity), bounded by `AbortSignal.timeout(1500)`; failure is silent.
- Server: per-device **Workers Rate Limiting binding** `RL_TELEMETRY`, `namespace_id` **2006**
  (2001–2005 taken; record in `AGENTS.md` registry), keyed by `p.deviceId` via the existing
  `ratelimit.ts` helper, shared by `/v1/telemetry` and `/v1/fleet/sync-state`; 429 on trip.
  Budget: prod `{limit: 20, period: 60}`, dev `{limit: 120, period: 60}` (matching the existing
  dev-looser convention). Note the binding is per-edge-location, not a global bound — acceptable:
  it is an abuse damper on top of AE's own sampling, not a correctness guarantee. Plus the
  stateless caps: max 64 samples/request, max 32 KiB body via `readBodyCapped`.

### D4 — #9 lands on a separate `POST /v1/fleet/sync-state`, aggregated per device×workspace
Confirmed separate route (different landing D1-vs-AE, current-state-vs-sample semantics). One
material change from the sketch above, forced by recon: **the server has no git-plane concept at
all** (git sync rides the E2EE blob/commit plane; nothing under `apps/api/src` knows repos), so
there is **no server-known per-repo identifier** — and inventing one from client data (path or
path-hash) is exactly the metadata leak the §5 threat model and this doc's own non-goals ban.
Therefore the upsert is **aggregate per device×workspace**, which still fully serves the cockpit
alert band ("any repo deferred >24h" → `oldest_deferred_since`); per-repo drill-down stays
on-device via `rbox git deferrals` (§124), which is the tool built for it.

- New table (additive migration, next free number after rebase — 0027 as of writing):
  `device_sync_state(device_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT
  NULL, binding_id TEXT NOT NULL, file_seq INTEGER NOT NULL, repos_total INTEGER NOT NULL,
  repos_deferred INTEGER NOT NULL, oldest_deferral_age_ms INTEGER, deferral_reasons TEXT NOT NULL
  DEFAULT '', reported_at INTEGER NOT NULL, PRIMARY KEY (device_id, workspace_id, project_id,
  binding_id))` — server workspaces are keyed `(workspace_id, project_id)` (`0005_gc.sql`) and one
  device can track multiple projects per workspace (round 1, F9). Plain upsert via the established
  `ON CONFLICT ... DO UPDATE SET col = excluded.col` idiom, routed through `dbFor(env, accountId)`
  (account-data-plane state).
- **`binding_id`** (round 2 — last-writer-wins across multiple local roots bound to the same
  triple would let a clean root overwrite a deferred root's row and false-clear/flap the 24h
  alert): a **random opaque id** (16 hex chars from CSPRNG) generated once per local root on first
  report and persisted in that root's local daemon state. Not path-derived; carries no information.
  The cockpit alert is **existential over fresh rows**, so any deferred binding keeps it raised.
  Stale bindings (untracked roots) age out via the freshness window.
- **Ages, not timestamps, on the wire** (round 2 — client clocks are unsynced; a client-ISO
  `deferredSince` compared against server time is undefensible): the client sends
  `oldestDeferralAgeMs` (its own clock's `now − deferredSince`, a same-clock delta; bounded
  `[0, 90d]`, null when no deferrals). The server stores it verbatim next to server-generated
  `reported_at`. Cockpit current age = `oldest_deferral_age_ms + (now − reported_at)`; alert when
  > 24h and the row is fresh.
- `deferral_reasons` (F11): comma-joined **deduplicated subset of the exact 15-value
  `GitDeferralReason` union**; the server validator checks every token against that allow-list
  (≤15 tokens). `configDisabled.reason` (free-form text) never ships.
- Wire contract (round 2 — same rigor as `/v1/telemetry`): envelope `{ v: 1, states: [...] }`,
  ≤32 states/request (**round 3: excess beyond 32 is dropped+counted, first 32 processed — same
  rule as D2's batch_cap**), 32 KiB `readBodyCapped`, `assertOnlyKeys` on envelope and every state.
  State fields: `workspaceId`, `projectId`, `bindingId` (16 lowercase hex), `fileSeq` (integer
  `[0, 2^48]`), `reposTotal` (integer `[0, 10_000]`), `reposDeferred` (integer,
  `0 ≤ reposDeferred ≤ reposTotal`), `oldestDeferralAgeMs` (integer `[0, 7_776_000_000]` or
  null; must be null iff `reposDeferred == 0`), `deferralReasons` (array of enum tokens, ≤15,
  empty iff `reposDeferred == 0`). Invalid state → drop that state (counted); **a state whose
  `(workspaceId, projectId)` fails `authorizeWorkspace()` against `p.accountId` is likewise
  dropped-and-counted per-state (round 3) — one stale/unauthorized state never fails the batch,
  and the response does not reveal which state was dropped**. Protocol errors → 400/413 as in D2.
  Response `202 {accepted, dropped}`. Adversarial tests mirror D2's.
- **Field source semantics** (round 3 — these determine what the cockpit actually shows):
  `fileSeq` = the workspace's currently applied file-plane manifest sequence (the same value
  ambient status reports). `reposTotal` = number of repos under git-plane management for that
  root, i.e. `repoRecordsForState(state)` count. `reposDeferred` = number of **distinct repos**
  with ≥1 lane deferral, and `oldestDeferralAgeMs`/`deferralReasons` aggregate across all lanes —
  computed from the SAME repo-level projection design 124 uses (`projectGitDeferralRepos`), so the
  cockpit and the on-device `rbox git deferrals` can never disagree about what counts as deferred.
- `reported_at` is **server-generated**. Cockpit freshness window: stale if `reported_at` older
  than 2.5× the heartbeat (allows jitter).
- Lifecycle (F10, rounds 2–3 — exact mechanics): workspace purge (`ws-purge.ts` — add the table
  to its deletion inventory) deletes `WHERE workspace_id = ? AND project_id = ?`. Account deletion
  (`account-delete.ts`) deletes the account's rows by device id — note `devices` is
  **directory-plane** while `device_sync_state` is **account-data-plane**, so this is not one
  cross-DB subquery: prefetch the account's device ids (the existing `clerkIds` prefetch pattern)
  and delete with an IN-list, **before the directory-plane `DELETE FROM devices`** (round 3:
  after it, the ids are gone). Same guard as revocation: prefetch scoped by `account_id`. Device revocation (`auth/devices.ts`): the delete carries the
  **authorization guard inside the statement itself** — `DELETE FROM device_sync_state WHERE
  device_id = ?1 AND EXISTS (SELECT 1 FROM devices WHERE device_id = ?1 AND account_id = ?2 AND
  revoked = 1)` — run after the guarded revocation UPDATE (rounds 3–4: an unguarded delete would
  let forbidden/cross-account revocation *attempts* erase state, while gating on the UPDATE's
  affected-rows count is not retry-safe — a failed DELETE after a successful revocation would
  never be retried since the retry's UPDATE reports 0 changes; the in-statement guard is both
  authorization-safe and idempotent, and an authorized retry against an already-revoked device
  still deletes). All statements idempotent. Local `untrack`
  performs no remote call today; those rows age out via the freshness window (acceptable).
- Daemon reports after any sync tick where the per-workspace summary **changed** (compare a summary
  fingerprint), plus an hourly heartbeat to keep `reported_at` meaningful.
- The route authz-checks the exact `(workspace_id, project_id)` pair against `p.accountId` using
  the existing project-scoped workspace authorization (`authz.ts`).

### Locked AE layout (follows the `emitDelta` per-family precedent in `metrics.ts`)
`index1 = blob1 = "client.<kind>"`; remaining blobs are enums only; doubles positional per family:

| index1 | wire fields (client sends) | doubles (server emits, positional) | enum blobs (server emits) |
|---|---|---|---|
| `client.propagation` | `deliveryToApplyMs` | `[deliveryToApplyMs]` | — |
| `client.first_publish` | `timeToFilesSyncedMs, pushWallMs, fileCount, uniqueBlobs` | `[timeToFilesSyncedMs, pushWallMs, fileCount, uniqueBlobs]` | `blob2=corpusBucket` (`xs\|s\|m\|l\|xl`) — **server-derived from fileCount**, never on the wire |
| `client.upload_lane` | `transport, bytes, uploadMs, opCount, fillVersion` | `[mbps, bytes, uploadMs, opCount]` (`mbps` **server-computed** = `8*bytes/(uploadMs/1000)/1e6`, 0 when `uploadMs==0`) | `blob2=transport` (`batch\|pack\|single`), `blob3=fillVersion` (`v1\|v2`) |
| `client.capability` | `workerExecutions` | `[workerExecutions]` | — |
| `client.safety_event` | `eventType, count` | `[count]` | `blob2=eventType` (`mass_delete_breaker\|scan_fault`) |
| `client.telemetry.drops` | — (server-emitted only) | `[count]` | `blob2=dropReason` (8-value enum, §D2) |

Round-2 revisions to this table:

- **`dispatchReason` is dropped from AE** (round 2: `recordUploadDispatch()` fires per *batch*
  dispatch decision, *before* encoding/settlement where `uploadMs` becomes known; pack uploads
  bypass it and single-blob puts have no reason — the attribution is structurally unrepresentable).
  The family is instead **one aggregate per push×transport** (`batch|pack|single`), truthful by
  construction. Dispatch-reason analysis remains local-only via `RBOX_LANE_TIMING` stderr output.
- **Push boundary**: the per-push lane accumulator is scoped to one `pushManifest()` invocation
  (`src/cli/sync/push.ts`), including retries inside it, with unconditional reset on every exit
  path. It is always populated (NOT `RBOX_LANE_TIMING`-gated; the env var continues to gate only
  the stderr line). Settlement sites (`uploader.ts` timed puts, `pack-uploader.ts`) add
  `(transport, bytes, uploadMs, +1 op)` into the accumulator at response time.
- **Derived values are server-side** (round 2: client-sent derivations can contradict their source
  fields): the client never sends `corpusBucket` or `mbps`; the server derives both. The
  `CORPUS_BUCKETS` threshold table lives in the client contract module and is **duplicated** in
  the server validator with a **drift test** (`apps/api` test imports both via relative path and
  asserts equality — test-time import only, no runtime cross-package dependency).
- `settleMs` (undefined) stays dropped. `publishWallMs` → `pushWallMs` (alias of the push
  report's `wallMs`, `src/engine/phase-report.ts:207`).
- **Settlement accounting semantics** (round 3): `opCount`, `bytes`, and `uploadMs` count
  **successfully settled HTTP upload requests** (one increment per completed HTTP request, not per
  logical blob/group — pack/batch settlement code attributes per-blob, but the accumulator adds at
  the HTTP-request level). Failed requests contribute nothing (no truthful settlement exists);
  when a transport falls back (e.g. pack → single), the settled requests count under the transport
  that actually carried them.
- **Derived-value guards** (round 3 — individually-valid hostile fields can still poison
  distributions): `bytes > 0` with `uploadMs == 0` → drop the sample (`bad_number`); derived
  `mbps > 100_000` → drop the sample (`bad_number`). `uploadMs == 0` with `bytes == 0` → `mbps = 0`.

Client emit points: `upload_lane` per push (computed unconditionally — `RBOX_LANE_TIMING` continues
to gate only the local stderr line); `first_publish` alongside the existing `fp` construction;
`propagation` at the post-checkout stamp (single subscriber clock, per the locked definition);
`capability` once per boot (~5 min in) and 6-hourly; `safety_event` at the breaker/scan-fault sites.

### Route wiring (review round 1, F12 — explicit, not incidental)
Both routes are **device-only**: require `p.kind === "device"` in the handler; they are NOT added
to the web-token or API-key allow-lists (`worker.ts:388-430`), and tests prove web/API-key tokens
are denied. Add `telemetry` / `fleet` / `sync-state` to `ROUTE_VOCAB` so templated-route metrics
stay well-formed. Handlers live in a dedicated module (`apps/api/src/telemetry-ingest.ts`), wired
into the authenticated dispatch.

### Anchor corrections from implementation-round recon (2026-07-15)
The original recon anchors above have drifted in places; the corrected, verified anchors:

- **`daemon.ts` was split**: the class now lives in `src/cli/daemon/daemon.ts`.
  `notifyPullPendingAt` declared :275, **set** at the WS `committed` frame :2009, read+cleared at
  the pull dequeue :835-836. The propagation "applied" stamp does not exist yet — add it in
  `doPull()` (starts :1170) after the pull applies (~:1196-1236).
- **`publishWallMs` does not exist as a field.** The wall clock is the generic
  `PhaseReportJson.wallMs` (`src/engine/phase-report.ts:207`, note *engine* not *cli*) shared by
  push/pull/sync reports — alias the `op==="push"` report's `wallMs` at emit time.
- **`corpusBucket` does not exist yet** — it is **server-derived** from the wire `fileCount` via
  fixed thresholds (`xs ≤100 < s ≤1k < m ≤10k < l ≤100k < xl`; canonical `CORPUS_BUCKETS` const +
  drift test per the AE-table section). It is never a wire field.
- `RBOX_BATCH_FILL` lives in `src/cli/remote/blob-batch/config.ts:80` (not `src/cli/config.ts`);
  values are a closed `v1|v2`. `dispatchReason` enum verbatim-confirmed at
  `src/cli/upload-lane-timing.ts:68-70`. `GitDeferralReason` (`src/cli/config.ts`) is a closed
  15-value union — the `reason_classes` allow-list mirrors it.
- **Server building blocks to reuse**: body parsing via `readBodyCapped`
  (`apps/api/src/commit-envelope.ts:76` — aborts past-cap before JSON.parse); field validation via
  the `assertOnlyKeys` + bounded-value idiom (`apps/api/src/diagnostics.ts:58`); D1 upsert idiom
  `INSERT ... ON CONFLICT(...) DO UPDATE SET col = excluded.col` (six existing sites). Next free
  migration number: **0027** (re-check after rebase).
- **Dev AE dataset is separate**: `rbox_dev_metrics` (dev) vs `rbox_prod_metrics` (prod), same
  binding name `rbox_metrics` — dev-first validation can query the dev dataset without touching
  prod history.
- **Daemon flusher shape**: ride the `ambientStatusHeartbeatTimer` pattern
  (`src/cli/daemon/daemon.ts:1302-1309` — unref'd `setInterval`, fire-and-forget, never holds the
  process open).

## Non-goals
- Any path, sha, or account/device/workspace id in **AE metric samples** (hard-blocked by the
  validator). The `/v1/fleet/sync-state` D1 upsert necessarily carries workspace/project/device
  ids — those are control-plane state the server already holds, not AE dimensions.
- Backfill — this is forward-only; the cockpit's history begins at ingest go-live.
