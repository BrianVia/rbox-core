# 112 — Batch-fill and blob-PUT wire-cap raise

Status: **REVIEWED — ALIGNED** (4 codex rounds; ledger: `REVIEW-112.md`),
2026-07-12.

## Problem

Greenfield first-publish uploads pay the fixed and per-wave cost of far too many
`POST /v1/blob-batch/put` requests. In the AE/FM A/B window on 2026-07-13, the
server handled 2,360 blob-batch PUTs at an average **733 ms handler wall**, but
each request carried only **17.3 of the allowed 32 records** and **148 KB of the
8 MiB body cap**. The implied mean ciphertext blob is about `148 / 17.3 = 8.55
KB`. The records cap, not the byte cap, is the binding wire dimension for this
corpus, and even that dimension is only 54% utilized.

The result is roughly 2,360 server settle payments for about 40,828 records.
At 24 existing PUT slots, `2,360 × 733 ms / 24 = 72.1 s` is the idealized
slot-envelope contribution before ramp, tail, retries, and client work. Design
109 gate 0 found only about 89 ms/request before the handler and therefore
parked the auth refactor: the next lever is more records and bytes per round
trip, not cheaper authentication.

This design changes neither concurrency nor cryptographic or publication
semantics. In particular:

- no new upload slots are added; the default remains 24;
- ciphertext production, SHA verification, convergent E2EE, and the 256 KiB
  per-record cap are unchanged;
- receipt minting and the design-96/102 deletion-fence guarantees are
  unchanged;
- `/v1/blobs/check` is untouched;
- the commit request and commit sequencing/fence shape are untouched; and
- metrics contain only numeric counts/bytes/timings and low-cardinality enums,
  never raw file paths or path-derived identifiers.

## Evidence

### Field measurement

Design 109 gate 0 is the motivating sample:

| Metric | Measured value |
|---|---:|
| batch PUT handler requests | 2,360 |
| mean handler wall | 733 ms |
| mean records | 17.3 / 32 |
| mean accepted payload | 148 KB / 8 MiB |
| implied payload per record | ~8.55 KB |

If the same ~40,828 records averaged 32/request, request count would be about
1,276. At 64/request it would be about 638. Those are cardinality projections,
not latency promises: the server performs one R2 write per unique record and
Cloudflare permits only six simultaneous outgoing connections per invocation.

### Client dispatch evidence

`BlobBatchUploader` in `src/cli/remote/blob-batch.ts` has four relevant paths:

1. `enqueue()` calls `dispatchFull()` immediately. A batch launches here only
   when the queue reaches the record cap or body cap and a slot is free.
2. The first residual enqueue arms a **non-sliding 10 ms timer**. Subsequent
   enqueues do not reset it because `this.timer` already exists.
3. When that timer fires, `dispatchPartial()` first launches full batches and
   then drains *all* remaining partial batches while slots are available.
4. After a request settles, `launch().finally` launches full batches and, if
   every slot is idle, flushes a remaining tail partial.

Thus, from code, partial batches have exactly two origins: the 10 ms timer
path and the idle-tail path (FIFO carving cannot underfill at ~8.55 KB
records). The observed 17.3 is not the 32-record cap and is not a
slot-completion race.

**Attribution caveat (what the field data can and cannot prove).** The AE
`blob.batchPut` fields are count/bytes/duration only; there are no enqueue
timestamps or dispatch reasons, so the 17.3 mean cannot be decomposed into
timer-drain versus idle-tail versus full batches diluted by small flushes.
Supply is also not a smooth stream: the pipeline buffers missing-checks for
50 ms (or `ROLLING_CHECK_BATCH`) and resolves an entire check batch in one
synchronous loop (`pipeline.ts` `flushChecks`), releasing consumers in waves —
a large wave forms full batches via `dispatchFull()` and only the residue is
timer-drained. The timer hypothesis is the most probable mechanism consistent
with the code paths, but its share is unproven. This design therefore treats
fill-v2 as a **measurement-first experiment**: the implementation adds
low-cardinality dispatch-reason counters — per fill version, matching each
version's actual dispatch paths: fill-v1 emits `full_records`, `full_bytes`,
`fixed_timer`, `idle_tail`; fill-v2 emits `full_records`, `full_bytes`,
`quiet`, `absolute`, `idle_tail` — plus queued-record depth and oldest-record
age at dispatch. The fill-v1 baseline run must show `fixed_timer`/`idle_tail`
partials dominating before the causal claim is asserted in any report.

The producer is deliberately bounded: the publish pipeline uses
`encryptConcurrency(...)` (normally eight workers) feeding up to 512 upload
consumers that each await `putFile()` settlement. The original design-80
intent was to keep supply ahead of dispatch, but the non-sliding 10 ms window
can expire between encrypt completions and between check waves even when the
overall first-publish queue is deep.

### Server cost evidence

`apps/api/src/blob-batch.ts` parses at most `MAX_BATCH_RECORDS = 32`; record 33
causes `400 bad_request` (`"too many records"`). After SHA de-duplication,
`writeBatchPutRecords()` starts one `putOneRecord()` promise per unique record
and awaits `Promise.allSettled`. Each record hashes its payload and performs one
verified R2 write. Only after all writes settle does the request perform one
amortized fence point-read and mint receipts for successful writes.

The fan-out is therefore not unlimited parallel R2 work. The existing #245
sweep and source comments observe approximately six simultaneous R2 operations
per invocation and collapse at 64 or more *client slots* through per-batch RTT
inflation. Cloudflare currently documents six simultaneous outgoing
connections, 128 MiB memory, a paid-plan default 30 s CPU limit configurable to
300 s, and 10,000 subrequests/request. Waiting on R2 is duration rather than
CPU. Those platform ceilings do not justify an arbitrarily large batch: hash
work and request/response materialization consume CPU and memory, while R2 PUTs
complete in about `ceil(N/6)` waves. See the current [Cloudflare Workers
limits](https://developers.cloudflare.com/workers/platform/limits/).

## Constraints and hypotheses

There are two serially composed constraints — the first a hypothesis to test,
the second a hard fact of the wire:

1. **Hypothesis: the client closes batches too early.** The 10 ms timer
   measures time since the first queued record, not time since the last
   arrival and not whether the upstream publish still has a deep backlog; with
   24 free slots it can convert producer burstiness into half-full requests.
   This is the most probable underfill mechanism consistent with the code
   paths, but per the attribution caveat above it is asserted as cause only if
   the fill-v1 dispatch-reason baseline demonstrates it.
2. **Fact: the wire rejects a useful sweep axis.** Both client and server pin
   the record maximum to 32. `RBOX_BATCH_RECORDS` is clamped to 32 explicitly,
   so `rig/upload-sweep` cannot test larger record batches without a
   coordinated server release.

The 8 MiB request cap is not the FM constraint. At 8.55 KB/record, 64 records
are about 547 KB and even 128 are about 1.09 MiB. Raising body bytes or the
256 KiB per-record limit would add memory risk without helping this corpus.
Memory bounds after the raise are unchanged in the dimension that matters:
the server's per-request payload stays capped at 8 MiB (a 64-record batch of
max-size 256 KiB records cannot exist — FIFO carving and `readBytesCapped`
bind at the body cap near 31 records, so the record raise only changes
small-record batches). On the client, peak framing remains approximately two
body buffers per active slot (payloads plus the contiguous output in
`encodeBatchBody`), bounded by slots × body cap, not by the record count.
Measurement honesty: `peakUploaderFramingBytes` is a **per-request** framing
peak (it maxes each `encodeBatchBody` invocation's own bytes; it does not
aggregate across the up-to-24 concurrent encodes), so aggregate client memory
is assessed via process peak RSS, with `peakUploaderFramingBytes` as the
per-request component. This design does not add an aggregate in-flight
framing counter.

## Options

### A. Raise records only, leave the 10 ms timer

This exposes a sweep axis but provides no fill mechanism and no telemetry to
interpret the result. Whether fill would improve depends on which underfill
mechanism dominates — under a wave-residue pattern a larger cap can absorb a
whole check wave into one partial, while under timer starvation it changes
nothing — and without dispatch-reason instrumentation the sweep could not
tell which happened. Option D strictly contains A. Reject as a standalone.

### B. Sliding quiet timer

Reset a short timer on every enqueue and dispatch partial only after no new
arrival for the quiet interval. This fills a continuously supplied queue, but
an irregular producer can postpone the tail indefinitely unless there is a
separate absolute deadline. It also makes latency depend on inter-arrival
jitter. Useful as a component, insufficient alone.

### C. Full-only dispatch with no deadline

Dispatch only on record/body fullness and at uploader shutdown. This maximizes
fill but deadlocks the current contract: callers await individual `putFile()`
settlement, so the producer may stop awaiting records before an explicit close
can be reached. Reject.

### D. Full-or-deadline coalescing, then a coordinated 32→64 wire step

Keep immediate full dispatch. Replace the single 10 ms timer with a bounded
coalescing deadline: a partial may ship after a short quiet period only if the
producer is not visibly supplying records, and it must ship at an absolute
deadline regardless. Lift the server acceptance cap first, then the client cap.
This directly addresses both constraints without adding slots. Recommend.

### E. Raise directly to 128 or more

At the FM mean, 128 records are still only ~1.1 MiB, but they require about 22
six-wide R2 waves. Using the measured 17.3-record/733 ms point as a deliberately
conservative linear-duration model gives `733 × 128/17.3 = 5.42 s` handler wall;
256 projects to 10.85 s. Neither breaches the platform wall/CPU limits by
itself, but both enlarge retry blast radius, receipt response size, transient
memory, and long-tail exposure before field data establishes the curve. Defer.

## Recommended design

### 1. Make partial dispatch full-or-deadline

For upload PUTs only, replace `FLUSH_DELAY_MS = 10` behavior with two bounds:

- **quiet window: 10 ms sliding** from the most recent unique enqueue; and
- **absolute fill deadline: 50 ms** from the oldest queued unique record.

Full record/body batches still launch synchronously in `enqueue()` whenever a
slot is free. A partial launches when either (a) no new unique record arrived
for 10 ms, or (b) its oldest record waited 50 ms. The timer callback computes
the remaining time to the earlier condition and rearms; it does not blindly
drain every partial on the first tick. The existing `active === 0` tail flush
remains, because it is the deadlock guard when all active work finishes.

**Known limitation, stated up front:** the uploader sees only `putFile()`
arrivals; it has no producer-open or encrypt-backlog signal, and this design
deliberately does not add a cross-layer queue API. Consequently the sliding
quiet bound cannot distinguish a genuine producer end from a >10 ms supply gap
(encrypt stall, filesystem variance, a missing-check wave boundary): any such
gap ships the partial. Fill-v2 is therefore an **experiment with a falsifiable
gate**, not a diagnosed cure — if supply gaps >10 ms dominate, fill-v2 will
measure no better than fill-v1 and the fill gate below will fail. A fake-clock
unit test pins this exact behavior (deep logical backlog, inter-arrival gaps
>10 ms → partials ship on the quiet bound); it documents the limitation rather
than gating on it. While the queue can form a full batch, `dispatchFull()`
wins. The dispatch-reason counters above are what turn a fill-gate failure
into a diagnosis (quiet-dominated → gaps; absolute-dominated → slow trickle).

Latency trade: a small upload that does not fill a batch may wait up to 50 ms
before its request starts, versus nominally 10 ms today: **at most +40 ms of
additional timer-induced client queueing while the uploader remains open**.
Scope of that bound: the `active === 0` idle-tail flush may ship a partial
sooner than either timer bound, and `close(err)` does not flush at all — it
cancels the timer and rejects queued waiters, exactly as today. A greenfield
publish should usually pay the bound only during ramp and final tail; full
batches launch immediately. Record queue timing already exists under lane
timing and must be reported in the sweep so this trade is measured rather
than assumed.

### 2. Raise the accepted record cap from 32 to 64

Change the wire twins in lockstep conceptually but deploy them separately:

- server `MAX_BATCH_RECORDS`: 32 → 64;
- client compiled maximum/default: retain 32 until rollout phase 2, then allow
  `RBOX_BATCH_RECORDS` through 64 and make 64 the candidate default;
- body cap stays 8 MiB and per-record cap stays 256 KiB;
- PUT slots stay 24.

Why 64: at the measured 8.55 KB mean it carries ~547 KB, only 6.5% of the body
cap. It needs at most 64 R2 PUT subrequests plus the existing amortized fence
work, far below 10,000. Under the conservative linear model its handler wall is
`733 × 64/17.3 = 2.71 s`, about 11 six-wide waves. For ~40,828 blobs it reduces
request count from 2,360 measured to at best 638. If duration scaled perfectly
linearly, the slot envelope would remain approximately `638 × 2.71 / 24 =
72.0 s`; the win would then be only avoided fixed request/auth/fence overhead.
The design therefore does **not** claim a 4× wall-speedup. The purpose of the
64 step is to expose and measure whether fixed settle cost is material while
staying on the first bounded point above 32. A 128 default requires a later
design or explicit follow-up gate using the measured 64 curve.

No per-record byte shaping is added. FIFO carving already stops before the body
cap. Size-aware reordering would complicate fairness and receipt association,
and FM is record-bound by a wide margin. Validation separately buckets batch
duration by record count and bytes so a future design can justify shaping if a
mixed-size corpus shows head-of-line waste.

### 3. Preserve response and correctness semantics

The server continues to de-duplicate identical SHAs within a request, verify
each ciphertext SHA, write each unique object, perform the single amortized
fence check, and mint one receipt result per submitted record in input order.
Partial per-record failures, whole-request `retry_later`, fallback-to-single,
and idempotent retry behavior do not change. E2EE plaintext/ciphertext formats
and hashes do not change.

Design 111 owns *redemption* batch sizing. Receipts returned by blob-batch PUT
responses are captured one per successful record, so a 64-record PUT can add up
to 64 pending receipts sooner; it does not redeem them on this route. Design
111's count/byte-bounded drainer remains authoritative. Its
`400 too_many_receipts` fallback must re-slice the untouched generation-safe
receipt map to the server-provided shrinking `max`; this design neither changes
that error nor treats the blob-PUT record cap as a redemption cap. Thus a
new-client/old-redemption-server combination may incur one design-111 clamp
bounce but cannot lose receipts, loop on a non-shrinking max, or commit before
the required flush. If design 111 instead moves redemption into blob-PUT
responses, that is a seam change requiring joint re-review before this ships.

### 4. Seam with the 109/110/111 binding order

`REVIEW-109-111-seam.md` fixes a binding implementation/evaluation order whose
step 4 captures ONE fixed-corpus, flags-off baseline shared by 110 Phase 0 and
111's control. Design 112 changes exactly the quantities that baseline
measures: `blob.batchPut` count/duration (109's gate-0 decomposition and 110's
upstream-of-DO context) and the cadence at which receipts reach 111's drainer
(a 64-record PUT can hand the drainer 64 receipts at once). Binding rules:

- 112's effective state (fill version, client record cap, server acceptance
  cap) is **frozen and recorded in every cell** of any 110/111 baseline,
  control, or candidate measurement; no 112 behavior or cap transition may
  land inside such a window.
- The seam ledger's order list must be amended when 112 enters
  implementation, slotting 112's field evaluation outside the step-4 window
  (before the baseline capture with its state recorded, or strictly after the
  110/111 evaluations that consume it).
- If design 109 is ever unparked, its gate-0 attribution must be rerun after
  112 has changed batch cardinality — the 89 ms/request pre-handler share was
  measured against 17.3-record batches and does not transfer.

## Flags and rollout

Two independent kill switches are required:

- **server:** `RBOX_BLOB_BATCH_MAX_RECORDS`, parsed as a bounded deployment
  value with default 32 and allowed candidate 64. Setting 32 immediately
  restores old acceptance behavior;
- **client:** existing `RBOX_BATCH_RECORDS`, newly clamped to the compiled
  maximum 64, plus `RBOX_BATCH_FILL_V2=0` to restore the existing fixed 10 ms
  partial flush. `RBOX_BATCH_RECORDS=32` is the cap rollback without disabling
  the fill policy; `RBOX_BATCH_BLOBS=0` remains the endpoint-wide escape hatch.

Rollout order is binding:

1. Ship server code and tests with acceptance default 32.
2. Enable server acceptance 64 in dev, then production. Old clients remain 32.
3. Ship client fill-v2 with record default still 32; evaluate fill-only.
4. Sweep 32/48/64 against the 64-cap dev server, then promote client 64 only if
   the gates below pass.
5. Keep server acceptance at 64 through at least one client rollback window.

| Server max | Client send max | Result |
|---:|---:|---|
| 32 | 32 | Current compatible behavior; fill-v2 may improve occupancy. |
| 64 | 32 | Backward-compatible; server capability is unused. |
| 64 | 64 | Target behavior. |
| 32 | 64 | Invalid rollout/rollback ordering. Without the latch below this would be UNBOUNDED degradation, not a one-off: today's client treats a 400 like any non-OK response — `fallbackAll` re-uploads that request as singles and keeps forming oversized batches forever (unlike 404/405, a 400 latches nothing). Mitigations below reduce it to one latch event plus a bounded in-flight burst (≤ slots), and make it alertable. |
| old/no batch route | 64-cap client | Existing 404/405 process-wide single-PUT fallback. |

The skewed-rollback path needs three concrete mechanisms, because a
new-client/old-server pair cannot rely on any new server contract:

1. **Client 400 latch (mandatory, ships with phase 3).** On any
   `/v1/blob-batch/put` 400 while the effective record cap exceeds the
   compiled floor of 32, the client latches its session record cap down to 32
   (one-time, monotonic — analogous to `uploadDisabledForProcess`), falls the
   current request back to singles as today, and continues batching at 32.
   A 400 at cap ≤32 is a genuine bad request and behaves exactly as today.
   Honest bound: with 24 slots, several oversized requests may already be in
   flight when the first 400 lands, and each falls back to singles
   independently — the guarantee is therefore **at most the number of
   oversized requests in flight at latch time (≤ slots, 24 by default)
   degraded requests per process**, not exactly one. The latch prevents any
   NEW oversized batch from being carved: the session cap is a mutable field
   that replaces `config.records` at BOTH read sites — `dispatchFull()`'s
   fullness check and `carve()`'s take limit — so queued not-yet-carved
   groups automatically re-carve at 32; only batches already carved and
   launching stay oversized.
2. **Server `too_many_records` outcome (ships with the server change).** The
   current handler collapses every parse failure into AE outcome
   `bad_request` with `count: 0` — an alert on the skew condition is not
   implementable from existing telemetry. The new server emits a distinct
   low-cardinality outcome (`too_many_records`) with the offending record
   count, and the deployment checklist gains an alert on any nonzero rate.
3. **Machine-readable `max` (new server only, forward-looking).** The new
   server's over-cap 400 includes `max`, mirroring the existing batch-GET
   "too many shas" response shape. Clients that see a valid shrinking `max`
   clamp to it (same validation discipline as design 111: positive integer,
   strictly below what was sent; otherwise use the latch in (1)). Old servers
   never send it, which is why (1) does not depend on it.

Server-first rollout remains mandatory, and the server kill switch must not
be lowered below the deployed client default until clients have first been
rolled back to 32 — mechanism (2) is what makes a violation of that rule
visible within minutes rather than by anecdote.

## Validation

### Unit and API gates

- Fake-clock uploader tests prove: full batches dispatch immediately; a steady
  stream does not flush at the first record's +10 ms; quiet partials dispatch
  after 10 ms; continuous partial supply dispatches by oldest+50 ms; the
  `active === 0` tail cannot deadlock; close/retry/fallback settles every waiter
  once; duplicate SHAs do not inflate fill counts; and the documented
  limitation is pinned: inter-arrival gaps >10 ms with a deep logical backlog
  ship partials on the quiet bound (limitation-documenting, not a pass gate).
- 400-latch tests: a `/v1/blob-batch/put` 400 at effective cap >32 latches the
  session cap to 32, falls back that request to singles, and subsequent
  batches carve at 32 with no further 400s; with 24 concurrent oversized
  requests in flight against a 32-cap server, every waiter settles exactly
  once, at most those in-flight requests degrade to singles, and queued
  groups re-carve at 32; a 400 at cap ≤32 behaves exactly as today; a valid
  shrinking `max` in the response clamps to `max` instead; absent/invalid/
  non-shrinking `max` uses the 32 latch.
- Boundary tests send 32, 33, 64, and 65 records under server max 32 and 64 and
  pin rejection precedence, response ordering, SHA mismatch, duplicate SHA,
  8 MiB body, and 256 KiB record behavior, plus the new `too_many_records`
  outcome and `max` field on the over-cap 400.
- Receipt/fence suites from designs 96/102 run at 64 records, including an open
  delete intent after writes but before minting: no receipt in the request is
  minted and the response remains `503 retry_later`.
- Design-111 tests cover a 64-receipt-producing PUT followed by redemption
  server rollback: one valid `too_many_receipts` clamp succeeds; absent,
  nonnumeric, or non-shrinking `max` fails hard; commit remains behind flush.

### Sweep and corpus gates

The current harness cannot run this plan as-is: `sweep.sh` takes one scalar
`RECORDS`, loops only over `SLOTS`, has no fill-policy selector, and — absent
an explicit `RBOX_API` — the CLI targets **production**. The records sweep is
therefore an explicit harness change shipped with phase 3 (whose client build
is also a prerequisite, since older clients clamp `RBOX_BATCH_RECORDS` to 32):

- `RECORDS_SET="32 48 64"` and `FILL_SET="v1 v2"` axes, cells randomized and
  repeated (minimum three cold FM first publishes per cell), same
  build/corpus/network placement;
- `RBOX_API` mandatory, pointing at the dev worker; the script hard-refuses
  to run any cell with records >32 or fill-v2 against the prod API base;
- every output row records the effective settings (records, fill, slots,
  API base, build sha) alongside the measurements;
- slots held at **24**, body/per-record caps at 8 MiB/256 KiB;
- capture AE `blob.batchPut` count/bytes/duration per cell window, the new
  client dispatch-reason counters, lane queue timing, and client process peak
  RSS + `peakUploaderFramingBytes`.

Measurement sources are named because round 1 found gates that could not be
evaluated from existing telemetry: overall per-batch fill distributions
(mean/p50) come from per-event AE `blob.batchPut` `count`. Per-reason fill is
NOT derivable by joining server AE with independent client counters — so the
client records, under lane timing/sweep mode only, a per-dispatch observation
of `(reason, records, bytes)` (numbers and one enum; local sweep output, no
identifiers), from which the sweep reports per-reason dispatch counts and
record-count histograms. Reasons are reported **independently, one per
reason** — only `idle_tail` is an observed idle-tail dispatch; `absolute` can
equally mean a sustained slow trickle mid-publish, and a genuine
end-of-producer tail can ship via `quiet`, so no reason combination is
labeled "the tail" (a true logical end-of-producer marker would need a
producer-closed signal this design does not add — that quantity is simply
unavailable). Response size is bounded
analytically (results array of ≤64 fixed-shape records, receipt string of
measured size) and spot-checked in the boundary tests.

Promotion of client default 64 requires all of:

1. **Batch-count gate:** successful attempted batch-PUT count falls by at least
   35% versus 32/fill-v1 on FM; single-PUT fallback count does not increase.
2. **Fill gate:** mean records ≥48 at candidate 64, p50 ≥56 (AE per-event
   `count`), with the fill distribution also broken down per dispatch reason
   (each reason reported independently — no combined "tail" bucket); mean
   accepted bytes ≥400 KB on FM. This is compatible with the measured
   ~8.55 KB/blob and detects continued timer starvation.
3. **Wall-throughput gate:** median FM first-publish upload wall improves ≥15%
   and wall Mbps improves ≥15%; no run regresses >5%. Report total publish wall
   separately so commit/redemption work cannot be credited to this change.
4. **Server slot-work gate:** compared on matched fill-v2 cells (fill-v2/64 vs
   fill-v2/32 — never against the underfilled fill-v1 baseline, which would
   confound fill policy with record count): total slot work (sum of handler
   durations ≈ request count × mean duration) falls by ≥10%, p95 handler wall
   at 64 <5 s, and error/503/fallback rates are non-inferior. A raw
   duration ratio is deliberately NOT the falsifier: the design's own
   six-wide wave model predicts an ideal full-batch ratio of 11/6 ≈ 1.83, so
   a threshold near it cannot separate healthy scaling from erased
   amortization; slot work measures the thesis directly. If slot work does
   not fall, keep fill-v2/32 and do not promote 64.
5. **Resource gate:** zero Worker 1102/resource-limit errors across the sweep;
   p99 handler wall at 64 <10 s; client peak process RSS (aggregate memory)
   within 10% of the 32-record cells (the aggregate bound is slots × body
   cap, unchanged by this design); `peakUploaderFramingBytes` (per-request
   framing peak) checked against its **analytical ceiling** of ~2× (body cap
   + frame headers) — it is EXPECTED to grow roughly with per-request fill
   (a full 64-record FM batch frames ~2 × 547 KB vs ~2 × 274 KB at 32), so
   it gets a ceiling, not a no-growth comparison; single-PUT fallback and
   retry counts non-inferior. The existing #245 result is respected: slots
   remain 24 and are not swept upward as part of this design.
6. **Correctness gate:** identical committed ref set, all receipts redeemed,
   resume after injected mid-upload failure converges without double accounting,
   and all design-96/102 fence assertions pass.
7. **Privacy gate:** emitted metrics (including the new dispatch-reason
   counters and `too_many_records` outcome) contain counts, bytes, durations,
   cap and low-cardinality outcome only—no raw file paths, SHAs,
   workspace/account/device identifiers, or path hashes.

Validation is the dev fleet or `bun run rig`/upload-sweep against the real dev
Worker and R2, not unit tests alone. If 64 fails the slot-work or wall gate,
the shippable result is fill-v2 at 32; the coordinated cap remains accepted
server-side but is not made the client default.

