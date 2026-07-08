# 80 - Batched blob upload: amortize request tax on the write path

Status: Accepted 2026-07-07 on the evidence of the design-79 prototype A/B.
Write-side mirror of design 77 P1. Supersedes design 26's DON'T-BUILD verdict
with the measurement §26's gate could not produce. Design only, no
implementation.
Origin: 2026-07-07 compress-before-encrypt A/B on a 17,504-file / 570 MB
corpus, WiFi Mac to production.
Depends on: design 23 upload receipts, design 26 batch upload, design 33
per-account GC/quota barriers, design 77 batched blob transport, design 79
compress-before-encrypt.

## 1. Problem and evidence

The current push bottleneck for small encrypted blobs is request count, not
payload bytes.

1. **Compression A/B, measured.** The design-79 A/B used a 17,504-file / 570 MB
   corpus from a WiFi Mac to production (see
   docs/design/79-compress-before-encrypt.md §1 for the full table). Publish
   wall was flat across raw ciphertext (72s), zstd with 79% fewer bytes (81s),
   and zstd plus requested concurrency 256 (69s). The binding observation is
   end-to-end blob throughput: ~120-125 blobs/s at BOTH pool settings — per-blob
   settlement ~370ms at pool 64 and ~1,240ms at pool 256 (queue-wait inflation,
   Little's law), with throughput unchanged. Cutting bytes 79% and quadrupling
   the requested pool each moved nothing. Uploading small blobs is
   request-bound.
2. **Why this supersedes §26.** Design 26 measured server PUTs at about
   126-182ms, mostly R2, and treated that as a byte-bound result. For small
   blobs, that same value is also consistent with a size-independent per-request
   floor. Design 26's data could not distinguish those cases. The compression A/B
   did: cutting bytes by 79% did not materially move wall time.
3. **Fleet shape.** Real workspace pushes are dominated by small source files,
   with a median well under 64 KiB. First publish and large churn pushes pay the
   fixed request floor thousands of times before they ever become bandwidth
   limited.
4. **Batching prize, inferred.** An 8.6k-blob publish sends 8,660 PUT requests
   today. At 32 records per batch, the same publish needs about 271 batch
   requests. That changes the lane from request-bound to byte-bound, where
   design 79's 4.9x byte reduction can pay. For the A/B corpus, the projected
   publish moves from 72s to about 15-25s, bounded by actual uplink capacity,
   which the measured runs did not saturate. The morning capstone run converts
   this projection into the acceptance measurement.

## 2. Admission resolution

Batch upload reopens the unresolved admission dispute left between §26 and §77.
The §26/codex position wanted upload-time quota admission because a batch route
could amplify orphan-write abuse. The opus review of §77 argued that the
receipts path already moved the cap guard to commit-time `commitAccounting()`,
and that batch upload should keep parity with the live single-PUT path.

The live receipts path settles the dispute for this design. Modern clients that
send the receipts protocol do zero upload-time admission:

```ts
  // §23.2 (v2, direct-write) — receipts protocol: ~R2-only. Write the CANONICAL blob key
  // directly (R2 verifies the sha) + return a receipt minted only after R2 accepts. ZERO D1:
  // no blobs/blob_refs/used_bytes/gc_candidates writes, no quota read. Accounting (charge +
  // grant + present=1) moves to commit (§23.4) as a pure D1 batch — NO staging→canonical
  // promote. Dropping the promote removes the serial O(N) commit phase that made §23 regress
  // at scale (measured: 2000-file promote = 19s). Single-user reality makes the canonical-
  // orphan concern moot; online canonical GC is disabled (cron) so a stale purge can't race a
  // direct PUT (codex scaling review). This removes the §25-measured 7-D1-call PUT plateau.
```

`blobPut()` then writes `blobKey(sha)` directly with R2 sha verification, mints a
receipt only after R2 accepts, and returns `{ ok, sha256, sizeBytes, receipt }`.
It performs no quota read and no `blobs`, `blob_refs`, `used_bytes`, or
`gc_candidates` write on the hot path. Accounting moves entirely to commit
through §23.4 validation and `commitAccounting()`.

`POST /v1/blob-batch/put` is therefore receipts-only and mirrors that posture
exactly: each record is an independently sha-verified R2 write to the canonical
key, followed by a per-record receipt. There is no upload-time admission. The
parity argument: same bytes, same sha verification, same commit-time cap
guard, and the same GC-reclaimable canonical orphan behavior.

The abuse model, stated honestly (review finding, both reviewers): a
committed footprint is identical either way — receipts are HMAC-bound to
account, sha, and size with a 12h TTL, and `commitAccounting()` is
idempotent and charges from the receipt-authenticated size. What batching
changes is uncommitted-orphan accrual VELOCITY: one authenticated request can
now create up to 32 canonical orphan objects instead of one, and online
canonical GC is cron-only, so an abusive account can accrue orphan bytes up
to 32x faster between sweeps at a fixed request rate. Orphan byte-rate
remains bounded by the account's uplink either way (the same bytes must be
uploaded), the objects are GC-reclaimable, and the fleet is single-user
today — this is accepted, named exposure, not zero exposure. Upload-time
admission, if ever wanted, is an account-posture change for a future
multi-tenant hardening design, and it applies to single PUT and batch PUT
alike. This is the standing resolution for the §26/§77 dispute.

## 3. `POST /v1/blob-batch/put`

The route lives beside `POST /v1/blob-batch/get`: worker routing authenticates
normally, then a `routes/blob-batch.ts` mirror dispatches the write method. It is
not under `/v1/blobs/`; the `/v1/blobs/:sha` matcher would turn an old-client
compatibility probe into `400 invalid sha256` instead of a route-absent 404.
Old servers 404 the `/v1/blob-batch/*` namespace, so the client's existing
probe-and-disable pattern applies unchanged.

Authentication is standard `authenticate()` with the machine token. Download
grant pre-auth is not used; grants are download-scoped and remain limited to
`GET /v1/blobs/:sha` and `POST /v1/blob-batch/get`. Batch PUT requires the same
receipts opt-in that `usesReceipts()` reads today:
`x-rbox-protocol: upload-receipts-v1`. A non-receipts batch request is a 400 with
a distinct error code.

The request body uses `Content-Type: application/x-rbox-blobs`, reusing the §77
frame data-record format and the wire-twin constants from
`apps/api/src/blob-batch.ts` and `src/cli/remote/blob-batch.ts`:

```
sha256[32 raw bytes] | u32be payloadLen | payload[payloadLen]
```

Payloads are ciphertext. The payload sha256 must equal the frame sha. The server
passes `{ sha256: sha }` to R2 on every `put`, so R2 verifies the content address
before the receipt is minted.

Limits mirror batch-get:

1. At most 32 records per request.
2. At most 8 MiB total body, enforced over ACTUAL bytes read with the same
   `readBodyCapped()` discipline batch-get uses — never trusted from
   `Content-Length` (design 77 §5's rule; a chunked or lying request must hit
   the byte cap, not the header check). A `Content-Length` pre-check is
   allowed as a fast reject, never as the guard.
3. At most `MAX_BATCH_RECORD_BYTES = 256 KiB` per record. A larger record
   settles as a per-record `too_large` result (batch-get's per-record status
   philosophy) and the client re-routes that record to the single-PUT path;
   the other records in the batch are unaffected. A correct client never
   produces one — its carve caps records at 256 KiB — so `too_large` in the
   wild means a client bug, visible in metrics, without killing 31 innocent
   records.
4. Duplicate shas within one request are silently deduplicated server-side —
   one R2 write, each duplicate record answered with the same result
   (batch-get's dedup posture). The client coalesces by sha before carving
   (§4), so server-side dedup is defense in depth, not the primary mechanism.

The Worker buffers and parses the request before issuing any R2 write.
Truncated headers, truncated payloads, empty batches, and body-cap violations
are clean request-level 400s. This parse-all boundary is about deterministic
errors, not storage consistency: accepted R2 writes are independent,
sha-verified, idempotent writes to canonical keys, and no entitlement or
quota state changes until commit.

After validation the Worker starts all R2 puts in parallel and settles them
with `Promise.allSettled` — never `Promise.all` (review blocker): one
transient R2 failure must not discard the receipts of records that succeeded.
Per-record outcomes:

- fulfilled write → `{ ok: true, sizeBytes, receipt }`;
- R2 sha rejection → `{ ok: false, error: "sha_mismatch" }`;
- any other per-record R2 failure → `{ ok: false, error: "r2_error" }`,
  retryable — the client re-routes that record to the single-PUT path, which
  already owns transient retry.

The request-level status is 200 whenever the request was well-formed,
regardless of per-record outcomes.

The response is small JSON, not binary framing:

```json
{
  "results": [
    { "sha256": "64hex...", "ok": true, "sizeBytes": 123, "receipt": "..." },
    { "sha256": "64hex...", "ok": false, "error": "sha_mismatch" },
    { "sha256": "64hex...", "ok": false, "error": "too_large" },
    { "sha256": "64hex...", "ok": false, "error": "r2_error" }
  ]
}
```

Results are in request order. Partial success is normal. A `sha_mismatch`
record settles as `BlobShaMismatchError` for its file, feeding the existing
re-encrypt retry loop; `too_large` and `r2_error` records re-route to the
single-PUT path, which already owns live-file churn, transient retry, and the
user-facing error surface.

Metrics use `startOp(env, "blob.batchPut")`. `count` is the record count and
`bytes` is total accepted payload bytes, mapping to the same Analytics Engine
fields batch-get uses. Outcomes are `ok`, `partial`, and `bad_request`. Average
records per request is the health diagnostic; the 342s batch-get regression
showed that a starved coalescer is visible first as low `avg_count`.

## 4. Client coalescer

The CLI adds a `BlobBatchUploader` beside `BlobBatchDownloader` in
`src/cli/remote/`. It mirrors the downloader's shape: pull-based dispatch,
bounded carve, process-wide permanent disable, and a test reset hook. `RboxApi`
owns one instance. `putBlobFile()` routes ciphertext files up to 256 KiB through
the uploader; larger blobs keep today's single-PUT and multipart behavior.

The queue item is `{ encSha, ctPath, size }`. Enqueues coalesce by sha FIRST
(review finding, both reviewers): convergent duplicates are a first-class
input here — two identical-content files race through the upload pool and
both call `putBlobFile` for the same `encSha` before either settles, because
the `uploaded` dedup set is only written at settlement. A second enqueue of
an in-flight sha attaches as a waiter; settlement fans the one result (and
its receipt — `RemoteContext.receipts` is keyed by sha, last-write-wins, so
fan-out is harmless) to every waiter. This is the downloader's `bySha`
grouping, applied at the queue boundary.

Dispatch mirrors the downloader EXACTLY, including its tail guard (review
blocker, both reviewers — the draft's "no timer" line misread the §77
lesson): full batches launch eagerly, pull-based, whenever a record or byte
cap is reached and a slot is free; a short quiet-period flush
(`FLUSH_DELAY_MS = 10`, the downloader's constant) dispatches a PARTIAL batch
only when no new supply has arrived and no full batch is pending. The §77
regression came from a timer shipping starved batches WHILE supply existed —
pull-first dispatch prevents that; the timer exists solely so the tail of a
push (or a small push that never fills a batch) cannot deadlock. There is no
drain API to plumb: `putBlobFile()` callers simply await settlement, exactly
as the download side's callers await `getBlobToFile()`.

`RBOX_BATCH_PUT_SLOTS` controls concurrent batch requests, default 8 and
clamped to `[1, 32]`. That default is a first guess to tune in the capstone
run.

Supply must scale with batching or the coalescer starves (review finding,
both reviewers — this is §77's supply lesson replayed on the write side: the
download pool went to 512 for exactly this reason in the 12.8-fill
iteration). Each `putBlobFile()` call occupies an upload-pool slot until its
record settles, so a 64-wide pool can only ever fill two 32-record batches.
When upload batching is enabled, the upload pool default rises to 512
(explicit `RBOX_UPLOAD_CONCURRENCY` still wins; the old default 64 applies
when batching is off). 512 slots ÷ 32 records ≈ 16 fillable batches against
8 dispatch slots — supply ahead of dispatch, the same margin the download
side ships. The encrypt pool (default 8) remains the true producer; AE
`avg_count` is the health check that supply is keeping batches full.

Settlement preserves the existing `putBlobFile()` contract. For an accepted
record, the uploader captures the returned receipt in `RemoteContext.receipts`,
reports byte progress as complete for that ciphertext, and resolves the queued
file as if the single PUT had returned `{ sizeBytes, receipt }`. The
`sync-recovery.ts` `uploadFileWithRetry()` loop is unchanged: it still owns
per-file re-encryption, bounded retries, `BlobShaMismatchError`, deferred churn,
and the `uploadsDir` argument for existing resumable paths. A `sha_mismatch`
batch result settles that one queued file by throwing `BlobShaMismatchError` for
its `encSha`; other records in the same batch remain successful.

The first 404 or 405 from `/v1/blob-batch/put` permanently disables upload
batching for the process and reroutes queued and future records to single PUTs.
That is old-server compatibility and keeps dev fake-server parity until the fake
server learns the endpoint. Per-record failures never disable the endpoint.

Any OTHER whole-request failure — a 5xx, a network error, a timeout — falls
back every pending record of that batch to the single-PUT path without
disabling the endpoint (review finding: the downloader's `fallbackAll`
posture, mirrored). This matters because `uploadFileWithRetry` only catches
`BlobShaMismatchError`; letting a transient batch 500 throw out of
`putBlobFile` would fail the entire push attempt, strictly worse than
today's single-PUT path which retries transients. The single-PUT path owns
transient retry; the batch layer never re-batches a failed batch.

Lane-timing attribution changes meaning under batching and must be handled
explicitly (review finding): `uploadFileWithRetry` brackets `putBlobFile()`
with wall-clock timing, which in batch mode would absorb queue-wait and
batch-fill latency — corrupting the very instrument (`RBOX_LANE_TIMING`)
this design's acceptance run reads. The uploader therefore records transport
time itself: each record's `uploadMs` share is the actual batch HTTP request
duration divided across its records, captured at settlement; queue wait is
accumulated separately (`queueMs`) for diagnostics. The per-blob upload
number stays comparable with the §79 A/B baselines.

Timeouts reuse the downloader's small control deadline and idle-abort constants.
`RBOX_BATCH_BLOBS=0` disables upload batching too; batching remains one switch
for the blob transport family, not a new upload-only environment variable.

## 5. Interaction with design 79

Compress-before-encrypt makes ciphertexts about 5x smaller, so more records fit
inside the 8 MiB body cap. The 32-record cap should bind first. Raising that
record cap is deliberately deferred until the capstone measures batched plus
compressed publish, because design 79's A/B did not measure this transport.

If Analytics Engine shows `avg_count` pinned at 32 while batch bodies sit far
under 8 MiB, a follow-up can raise the record cap. That is a coordinated
client/server constant change, not a server-only tweak: the batch constants are
duplicated as wire twins between the Worker and CLI build targets, and the code
comments require changing them in lockstep.

## 6. Tests and verification

Worker tests are `apps/api` vitest and must run locally; the Codex sandbox cannot
run the Workers pool. Coverage:

1. Frame parsing for truncated header, truncated payload, oversize body (via
   actual-bytes cap, including a lying `Content-Length`), and zero records.
2. Oversize record → per-record `too_large` while siblings succeed; duplicate
   shas → one R2 write, each duplicate answered with the same result.
3. `sha_mismatch` for one record returns a per-record error while other records
   succeed; a per-record R2 throw returns `r2_error` for that record and valid
   receipts for the fulfilled ones (`allSettled` pinned).
4. Receipts are minted for each accepted record and validate through the commit
   path.
5. Non-receipts requests fail with a 400 and the distinct receipts-required
   error code.
6. Metrics record batch count, accepted bytes, and `ok` / `partial` /
   `bad_request` outcomes.

Client tests are `bun test`:

1. Carve/coalesce matrix mirroring the downloader suite, including same-sha
   coalescing: two concurrent `putBlobFile` calls for one `encSha` produce one
   record and both callers settle with the receipt.
2. Pull-based dispatch does not ship small batches while supply exists; the
   quiet-period flush ships the tail; a push smaller than one batch (the
   steady-state few-file increment) completes — the deadlock regression test.
3. Per-record fallback to single PUT preserving `BlobShaMismatchError`;
   `r2_error`/`too_large` records re-route without disabling the endpoint.
4. Whole-batch 5xx/network failure falls back all pending records to single
   PUTs and the push succeeds.
5. 404/405 permanent disable for the process.
6. `RBOX_BATCH_BLOBS=0` kill switch.
7. Supply default: batching on → upload pool 512; explicit
   `RBOX_UPLOAD_CONCURRENCY` respected; batching off → 64.
8. Lane timing under batching: `uploadMs` reflects batch transport share, not
   queue wait.

The fake E2EE server learns `POST /v1/blob-batch/put` so the round-trip suite
exercises the batched path by default. Keep one explicit disabled-path
round-trip so old-server compatibility stays pinned.

E2E acceptance uses the §26/§79 fresh throwaway publish protocol and corpus
recipe. With batching on, publish should be materially under the 72s raw
baseline and Analytics Engine should show `avg_count` near 32. The capstone then
runs batched plus compressed to produce the combined number.

## 7. Non-goals

1. No upload-time quota admission; §2 is the resolution.
2. No grant pre-auth for uploads.
3. No multipart or large-blob changes. The path above 256 KiB is unchanged.
4. No record-cap raise in this design.
5. No manifest, schema, or commit protocol change. This is transport only, and
   receipts are the same receipts.
