# 112 — Batch-fill and blob-PUT wire-cap raise

Status: **INITIAL DRAFT — no adversarial review yet**, 2026-07-12.

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

Thus the observed 17 is not the 32-record cap and is not a slot-completion
race. It is principally the 10 ms fixed window racing the encrypt producer:
the first item starts a clock, the producer supplies roughly 17 unique blobs
before it expires, and the 24 mostly-free PUT slots let the timer drain that
partial immediately. Slot availability enables the underfill but does not
initiate it. The idle-tail path matters only when active requests fall to zero.

The producer is deliberately bounded: the publish pipeline uses
`encryptConcurrency(...)` (normally eight workers). Each queued `putFile()`
promise remains occupied until its record settles. The original design-80
intent was to keep supply ahead of dispatch, but the non-sliding 10 ms window
can expire between encrypt completions even when the overall first-publish
queue is deep.

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

## Root cause

There are two serially composed constraints:

1. **The client closes a batch too early.** The 10 ms timer measures time since
   the first queued record, not time since the last arrival and not whether the
   upstream publish still has a deep encrypt backlog. With 24 free slots it
   eagerly converts producer burstiness into half-full requests.
2. **The wire rejects a useful sweep axis.** Both client and server pin the
   record maximum to 32. `RBOX_BATCH_RECORDS` is clamped to 32 explicitly, so
   `rig/upload-sweep` cannot test larger record batches without a coordinated
   server release.

The 8 MiB request cap is not the FM constraint. At 8.55 KB/record, 64 records
are about 547 KB and even 128 are about 1.09 MiB. Raising body bytes or the
256 KiB per-record limit would add memory risk without helping this corpus.

## Options

### A. Raise records only, leave the 10 ms timer

This exposes a sweep axis but does not address measured underfill: a client
that averages 17 under a cap of 32 will still average about 17 under 64. Reject.

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

“Queue deep” is defined locally and safely: queued unique records plus active
batched records are supply evidence; this design does not reach into the
encrypt scheduler or add a cross-layer queue API. While the queue can form a
full batch, `dispatchFull()` wins. Otherwise the sliding quiet bound detects a
real producer gap and the 50 ms absolute bound prevents starvation.

Latency trade: a small upload that does not fill a batch may wait up to 50 ms
before its request starts, versus nominally 10 ms today: **at most +40 ms of
intentional client queueing** on that tail. A greenfield publish should usually
pay the bound only during ramp and final tail; full batches launch immediately.
Record queue timing already exists under lane timing and must be reported in
the sweep so this trade is measured rather than assumed.

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
| 32 | 64 | Invalid rollout/rollback ordering: server returns 400 and current client falls back the entire request to singles. Safe but slow; alerts must catch any occurrence. |
| old/no batch route | 64-cap client | Existing 404/405 process-wide single-PUT fallback. |

Unlike design 111 redemption, the blob-PUT endpoint does not currently return a
machine-readable `too_many_records` contract that the client safely clamps and
re-slices. This design does not invent one for rollout safety; server-first is
mandatory, and the server kill switch must not be lowered below the deployed
client default until clients have first been rolled back to 32.

## Validation

### Unit and API gates

- Fake-clock uploader tests prove: full batches dispatch immediately; a steady
  stream does not flush at the first record's +10 ms; quiet partials dispatch
  after 10 ms; continuous partial supply dispatches by oldest+50 ms; the
  `active === 0` tail cannot deadlock; close/retry/fallback settles every waiter
  once; duplicate SHAs do not inflate fill counts.
- Boundary tests send 32, 33, 64, and 65 records under server max 32 and 64 and
  pin rejection precedence, response ordering, SHA mismatch, duplicate SHA,
  8 MiB body, and 256 KiB record behavior.
- Receipt/fence suites from designs 96/102 run at 64 records, including an open
  delete intent after writes but before minting: no receipt in the request is
  minted and the response remains `503 retry_later`.
- Design-111 tests cover a 64-receipt-producing PUT followed by redemption
  server rollback: one valid `too_many_receipts` clamp succeeds; absent,
  nonnumeric, or non-shrinking `max` fails hard; commit remains behind flush.

### Sweep and corpus gates

Once dev accepts 64, extend `rig/upload-sweep` so its records axis is no longer
pinned to 32. Hold slots at **24** and body/per-record caps at 8 MiB/256 KiB.
Run 32/48/64 for both fill-v1 and fill-v2, minimum three cold FM first publishes
per cell, randomized order, same build/corpus/network placement. Capture AE
`blob.batchPut` count/bytes/duration plus client wall and queue timing.

Promotion of client default 64 requires all of:

1. **Batch-count gate:** successful attempted batch-PUT count falls by at least
   35% versus 32/fill-v1 on FM; single-PUT fallback count does not increase.
2. **Fill gate:** mean records ≥48 at candidate 64, p50 ≥56, with tail batches
   reported separately; mean accepted bytes ≥400 KB on FM. This is compatible
   with the measured ~8.55 KB/blob and detects continued timer starvation.
3. **Wall-throughput gate:** median FM first-publish upload wall improves ≥15%
   and wall Mbps improves ≥15%; no run regresses >5%. Report total publish wall
   separately so commit/redemption work cannot be credited to this change.
4. **Server-curve gate:** p95 handler wall at 64 <5 s, error/503/fallback rates
   non-inferior, and `duration64 / duration32 < 1.8`. A ratio near 2 means R2
   serialization erased the amortization thesis; keep fill-v2/32 and do not
   promote 64.
5. **Resource gate:** no Worker 1102/resource-limit errors, no material CPU or
   memory regression, response serialization remains bounded, and the existing
   #245 result is respected: slots remain 24 and are not swept upward as part of
   this design.
6. **Correctness gate:** identical committed ref set, all receipts redeemed,
   resume after injected mid-upload failure converges without double accounting,
   and all design-96/102 fence assertions pass.
7. **Privacy gate:** emitted metrics contain counts, bytes, durations, cap and
   low-cardinality outcome only—no raw file paths, SHAs, workspace/account/device
   identifiers, or path hashes.

Validation is the dev fleet or `bun run rig`/upload-sweep against the real dev
Worker and R2, not unit tests alone. If 64 fails the server-curve or wall gate,
the shippable result is fill-v2 at 32; the coordinated cap remains accepted
server-side but is not made the client default.

