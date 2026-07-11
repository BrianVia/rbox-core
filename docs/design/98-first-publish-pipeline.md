# 98 — First-publish pipeline: overlap encrypt → upload → receipt redemption

Status: Design draft v4 (v1 → round-1 REVISE, 20 items; v2 → round-2 REVISE,
12 items; v3 → round-3 REVISE, 4 items; all accepted — see `REVIEW-98.md`). Owns audit Findings 6 (phase-serialized publish)
and 8 (receipt redemption after all uploads). Finding 9 (batch bearer-auth) is
a **measurement-and-deferral record only** (§4), not a build in this design.
Client-and-server-adjacent. Pending the Phase 0 measurements in §5 before the
pipeline is built. Follows the designs 79–85 method: measure, falsify, then
redesign, and the design-85 shape of a runnable Phase 0 with hard gates ahead of
every build phase — including falsifying this design's own v1 (§ round-1 items,
recorded in `REVIEW-98.md`).

Framing (why this is worth doing at all): the initial upload is THE conversion
moment — a user's first real, timed experience of rbox. Every other design in
this generation shaves a steady-state cycle a user runs hundreds of times; this
one shapes the single run that decides whether there is a second run. The
measured first publish of a ~105k-file workspace is **599s wall, of which 363s
is encryption**, and the heavy stages (encrypt-all, missing-check, upload-all,
redeem-all) run STRICTLY SERIALIZED — the wall is their SUM when it could be
close to their MAX.

**Interface note (load-bearing, stated up front).** This design and design 99
(fused multi-file crypto worker jobs) share ONE seam. **This pipeline consumes a
per-file readiness event `ready(encSha, size, ciphertextLocation)` and must NOT
assume one-file-per-worker-job.** Design 99 may batch many files into one worker
job, but it MUST preserve per-file readiness signaling. §3.4 states the contract
normatively, distinguishes what ships in THIS design (file-backed, one event per
single-file encrypt — exists today) from what is **gated on design 99**
(buffer-backed ready blobs and fused-job streaming), and neither design may land
a change to the seam without the other's gate re-run.

All wall numbers here are from the design-81 105k-file benchmark
(`docs/design/81-worker-pool-crypto.md:356–369`) and are stale-by-default: §5
re-measures on current `main` before any gate is evaluated.

## 1. Problem and evidence

Measured means observed directly on the named workload; inferred follows from
those measurements but still needs the Phase 0 gate in §5.

1. **First publish is phase-serialized, measured in code.** The whole-workspace
   push funnels through `encryptAndUpload` (`src/cli/sync-recovery.ts:150`),
   whose inner `runCryptoAndUpload` (`:193`) runs awaited barriers in strict
   order: `report.phase("encrypt", …)` (`:199`, `poolMap(toEncrypt, …)` `:200`)
   → `report.phase("missing", …)` (`:258`, one `api.missingBlobs(encShas)` over
   the FULL set) → `report.phase("upload", …)` (`:378`, `poolMap(toUpload, …)`
   `:379`). Only then does the caller reach `commitSigned`
   (`src/cli/remote/commits.ts:190`), which FIRST calls `redeemReceipts` (`:197`)
   to drain the entire accumulated receipt map, THEN posts the commit. Four
   barriers, zero overlap.

2. **The wall is dominated by encrypt, but the machine is under-used,
   measured.** 105k files: full publish **599s**, encrypt phase **363s**, at only
   **575% peak CPU on a 32-core host** — the encryptors never saturate the
   machine because during the encrypt barrier no upload keeps the network busy,
   and during the upload barrier no CPU work keeps cores busy. The wall is
   `encrypt + missing + upload + redeem + commit`; the structural ceiling of an
   overlapped pipeline is `max(encrypt, upload) + tail-drain + commit`.

3. **Receipt redemption runs strictly after all uploads, measured in code.**
   `redeemReceipts` (`commits.ts:150`) loops the accumulated `ctx.receipts` map
   (`src/cli/remote/context.ts:23`) in batches of `RECEIPT_REDEEM_BATCH_MAX =
   5000` (`commits.ts:7`); each batch is a serialized round trip that verifies
   HMACs and runs `commitAccounting` server-side
   (`apps/api/src/workspace-sync.ts:625–684`). The FIRST redemption cannot start
   until the LAST upload captured its receipt, so the redemption wall is appended
   whole instead of hiding under the upload it could overlap. Crucially,
   `redeemReceipts` also RETURNS `needsUpload` on a 422 (`commits.ts:161–172`),
   and `commitSigned` feeds that into residue recovery (`:198–201`) — any
   background redemption MUST preserve that return channel (round-1 item 2).

4. **Every ciphertext temp lives for the whole run, inferred from code.**
   `encryptFileToTemp` writes each ciphertext to a temp under `tmpDir`
   (`src/engine/crypto.ts:273`; inline path `:182`), recorded in `ctByEnc`
   (`sync-recovery.ts:242`). Nothing deletes an individual temp after its upload
   settles — the ONLY cleanup is `fs.rm(tmpDir, { recursive: true })` in the
   `finally` at `:406`. So **peak temp-disk is the entire corpus's ciphertext at
   once**, though at any instant only a queue-plus-in-flight window is needed.

5. **The batch PUT uploader already buffers whole payloads in heap,
   measured in code.** `BlobBatchUploader.encodeBatchBody` (`blob-batch.ts:725`)
   does `fs.readFile(group.srcPath)` for EVERY group in a batch (`:726`) then
   COPIES each into a single framed `Uint8Array` (`:744`) — so the uploader holds
   roughly `bodyBytes × PUT-slots` of heap (default 24 slots,
   `DEFAULT_BATCH_PUT_SLOTS`) with a copy-amplification factor, entirely outside
   any producer-side queue bound. Any memory budget (§3.2) MUST count this owner
   (round-1 item 5).

6. **Batch PUT re-authenticates per request, measured in code** —
   `authenticate` (`apps/api/src/auth/authenticate.ts:25–57`) per receipt-mode
   batch PUT. This is Finding 9; it is deferred to its own design and only
   MEASURED here (§4).

## 2. Root cause and the falsifications that shape the design

The naive hope is "remove the awaits and let the phases interleave." Round-1
review falsified four under-specifications in that hope; each drives a concrete
mechanism below.

1. **Overlap without backpressure is a resource-exhaustion bug, not a speedup.**
   A 32-core encryptor races ahead of one uplink and fills disk (file temps) OR
   heap (design-99 buffers, and the shipped batch-PUT framing, evidence 5). →
   §3.2 defines a memory/disk BUDGET over ALL owners, not just "ready"
   descriptors, with an oversize-admission rule.

2. **The global `missingBlobs` preflight is a barrier, but skipping it is not
   free — and it is NOT a presence check.** `/v1/blobs/check` (`context.ts:74` →
   server `missingBlobs`, `workspace-sync.ts`) returns a sha as "missing" unless
   it is BOTH entitled for THIS account (`blob_refs`) AND safe from GC
   (not `blob_ref_candidates` / `gc_candidates`). So it is a **server-satisfied
   check**, not a raw-presence check (round-1 item 1). → §3.2 replaces the one
   global call with a rolling batched server-satisfied check. Note the response
   is a single merged `missing: string[]` — the absent / unentitled / GC-fenced
   sub-causes are deliberately NOT distinguishable client-side (round-2 item 3),
   so the design reasons only about the satisfied/unsatisfied partition.

3. **A receipt is ephemeral, process-local, and its redemption returns
   repair state.** `ctx.receipts` (`context.ts:23`) is cleared on commit
   (`commits.ts:244`) and never persisted; redemption can 422 with `needsUpload`.
   → §3.3 defines a drainer that OWNS an error latch, a durable in-process
   `needsUpload` accumulator, terminal state, and generation-safe draining — not
   a fire-and-forget `kick()`.

4. **`Promise.all` is not cancellation.** A quota 402, auth failure, or network
   fault must actually STOP crypto jobs, rolling checks, queued PUTs, and
   retries — a rejected promise does none of that. → §3.5 defines a shared
   `AbortController` protocol with defined queue-close, producer-termination, and
   descriptor-cleanup semantics, and a numeric bound on post-abort uploads.

The governing rule (audit §Final assessment): *a cold transfer must overlap
independent CPU, network, accounting, and filesystem stages.* This design
overlaps exactly those four for the first publish, under an explicit
backpressure, cancellation, and crash-recovery model.

## 3. Design

### Invariant (stated first, design-85 style — honestly bounded)

> **No committed manifest ever references a blob that is not server-satisfied
> (entitled + present + GC-safe) at commit time; a graceful interruption never
> re-does work whose persisted descriptor is still server-satisfied on resume
> (the encrypt cache persists ADDRESS COMPUTATION, not reusable ciphertext —
> round-2 item 10); and the pipeline's OWN occupancy (queued + crypto-reserved +
> unsettled temps) never exceeds its disk/heap accounting, while uploader-internal
> heap is a measured, calibrated high-water target rather than a hard accounting
> bound (round-2 item 12).** Every overlap is conservative: the pipeline may do
> EXTRA work — re-encrypt a churned, non-persisted, or server-unsatisfied file,
> re-PUT a server-unsatisfied blob to re-mint a receipt, re-run an idempotent
> redemption — but it never commits ahead of durable server-side entitlement and
> never streams unverified partial bytes as a whole object. On ANY doubt —
> churn, receipt loss, quota
> rejection, abort — it falls back to the existing residue-driven recovery
> (`pushManifest`'s `unsatisfiedBlobs` loop, `src/cli/sync.ts:491+`), which
> already re-encrypts, re-uploads, and re-commits the residue.
>
> **Accepted exposure (round-1 items 10/11, stated honestly):** progressive
> redemption grants account entitlements to blobs BEFORE the commit that
> references them succeeds. A churn-deferred file, a 409/epoch conflict, a
> signing failure, or a user cancellation can therefore leave entitlements for a
> manifest that is never committed ("orphan entitlements"). This WIDENS an
> exposure that already exists in the terminal-redemption path (which also
> redeems before the commit POST, `commits.ts:197` before `:202`). It is
> ACCEPTED semantics, bounded in §6.3, and reclaimed by the existing per-account
> GC (design 33) exactly as any other unreferenced ref.

The correctness floor is the CURRENT code's: content-addressed idempotent PUT,
race-safe receipt delete-if-unchanged (`commits.ts:170,182`), per-file
re-encrypt on retry (`uploadFileWithRetry`, `sync-recovery.ts:282`), and
churn-defer (`isDeferrableChurn`). The pipeline reorders WHEN these run; it
weakens none of them.

### 3.1 Shape

Replace the serial barriers inside `runCryptoAndUpload` with one
producer-consumer graph under a shared abort scope:

```
 encrypt producers ──ready(encSha,size,fileLoc)──▶ [budgeted ReadyQueue]
   (crypto pool; one event                                  │
    per single-file encrypt today)                          ▼
        ▲                                 upload scheduler (consumers)
        │ re-encrypt lane                   │ rolling server-satisfied check
        │ (unsatisfied cache hits)          │ convergent-dedup (idempotent PUT)
        │                                   ▼
 cache-hit checker ──unsatisfied──┐  putBlobFile → captureReceipt
   (addresses only, no ready      │    (temp released on putFile settlement)
    event; rolling check)─────────┘         │
                                            ▼
                                   ReceiptDrainer (single-flight, error-latched,
                                     backlog-capped; owns needsUpload accumulator;
                                     redeems DURING upload)
                                            │
   EOF/drain barrier (§3.6) OR abort fires ┘
                                            ▼
                             drainer.flush() → { needsUpload } → commit residue loop
```

**File state transitions (round-2 item 4 — the resume path is central, not a
detail).** Each file entering the pipeline is in exactly one state:

1. `CARRIED` — unchanged base file (`sync-recovery.ts:180–190`): descriptor
   applied immediately; never enters the queue.
2. `CACHE-HIT` (`classifyCacheHit` → `accept`, `:210`): the file's cached
   ADDRESS (no ciphertext — temps do not survive runs) goes to the rolling
   server-satisfied check **without a ready event**. If SATISFIED → done
   (descriptor applied). If UNSATISFIED → transition to `ENCRYPT` (the cached
   descriptor supplies the expected address, but the bytes must be
   reconstructed).
3. `ENCRYPT` — cache miss, or unsatisfied cache hit re-entering: joins
   `toEncrypt`, is encrypted by a producer under the SAME `poolMap` /
   backpressure as fresh misses (one lane, no separate scheduler), and emits
   `ready` when its ciphertext temp exists.
4. `READY → UPLOADING → SETTLED` — queued under the budget, uploaded, receipt
   captured, temp released.

The cache-hit checker retains the file↔address association across the rolling
check (it is the same coalescing buffer the consumers use), so an unsatisfied
answer re-queues the specific file, not just an address.

### 3.2 The producer-consumer pipeline (Finding 6)

**Producers.** The existing `withCryptoPool` (`src/engine/crypto-pool.ts:508`)
and `poolMap` over `toEncrypt` are retained. Instead of resolving into a
`ctByEnc` map consumed by a later phase, each completed single-file encrypt
emits ONE readiness event the moment its ciphertext temp is ready (§3.4). A
producer's `poolMap` worker `await`s `queue.push(...)`; a blocked `push`
naturally stops that worker from taking the next file — that IS the backpressure
(no separate throttle). A crypto-worker crash surfaces as a rejected encrypt
(`crypto-pool.ts` `workerCrashError`), which aborts the scope (§3.5).

**Disk accounting reserves BEFORE encryption (round-2 item 1).** Charging only
queued+unsettled ciphertext under-counts: `encryptFileToTempInline` writes a
plaintext SNAPSHOT before producing ciphertext (`crypto.ts:186–190`), and every
in-flight crypto job holds snapshot+output on disk before its `queue.push` ever
runs. The disk axis therefore works by RESERVATION: a producer reserves
`expectedSize + worstCaseCipher(expectedSize)` (plaintext snapshot + AES-GCM
overhead bound; compression can only shrink it) BEFORE dispatching the encrypt,
blocks if the reservation would exceed `maxTempDiskBytes`, and reconciles the
reservation down to the actual `cipherSize` when the job completes (snapshot
deleted, ciphertext measured). Occupancy on the disk axis is thus: crypto
in-flight reservations + queued file-backed ready blobs + temps whose upload has
not yet settled. This is what makes the disk-full row in §6.4 a bounded claim
rather than a hope.

**Heap accounting is two-tier (round-2 item 12).** The pipeline can enforce a
hard accounting bound ONLY over bytes it owns: queued buffer-backed ready blobs
(design-99 lane, §3.4). The shipped batch-PUT uploader's internals —
`fs.readFile` payloads, framed copies (`encodeBatchBody`, `blob-batch.ts:725`),
fallback singles, response parsing — cannot be byte-reserved from outside the
seam, so they are a MEASURED, CALIBRATED high-water target: modelled as
`PUT-slots × bodyBytes × copy-factor`, measured as `peakUploaderFramingBytes`
(§5.1), bounded by capping upload concurrency in calibration (§5.3), and
verified by gate 4 — the design does NOT claim a hard heap invariant across the
uploader. (Adding byte reservations inside the uploader is noted as an option if
calibration cannot find a safe setting.)

`maxItems` is a third cheap cap on bookkeeping. **Oversize admission (round-1
item 6, extended round-2 item 1):** if occupancy on the relevant axis is ZERO,
one item (or one crypto reservation) is admitted even if it exceeds the cap —
covering the ENTIRE crypto working set, so a single file whose
snapshot+ciphertext exceeds `maxTempDiskBytes` can never deadlock; the
high-water metric may then exceed the cap by one item, which gate 4 accounts
for. Large files (>`SINGLE_PUT_MAX`) take the existing multipart path and are
admitted one-at-a-time on the disk axis. Defaults are a calibration output
(§5.3), env-overridable (`RBOX_PIPELINE_QUEUE_BYTES` / `_HEAP_BYTES` /
`_ITEMS`), never silently defaulted inside the engine.

**Consumers = the upload scheduler**, a bounded pool driving the EXISTING
`uploadFileWithRetry` (`sync-recovery.ts:282`) with these adaptations:

1. **Rolling server-satisfied check replaces the global `missingBlobs` barrier.**
   Ready addresses accumulate into a small coalescing buffer; at a batch size or
   short idle timeout, one `api.missingBlobs(batch)` classifies them. A
   server-SATISFIED address (entitled + present + GC-safe) skips the PUT; a
   server-UNSATISFIED address is uploaded to (re-)mint a receipt. This is the
   unchanged `/v1/blobs/check` call, just issued in rolling batches instead of
   one global barrier. On resume the unsatisfied tail is exactly the blobs the
   prior run did not durably entitle — see §6.1. Cache-hit addresses flow
   through the SAME coalescing buffer, without ready events, per the state
   graph in §3.1.
2. **Convergent-dedup is best-effort and idempotent, unchanged.** The
   `uploaded`/`inflight` address sets (`sync-recovery.ts:270,284`) coalesce
   duplicate plaintext that encrypts to the same address. Two consumers may still
   race two files of the same `encSha` and both PUT — correct because PUT is
   content-addressed idempotent (the current serialized `poolMap` upload has the
   same race); the pipeline does not regress it.
3. **Single-release temp lifetime: DISPOSITION settlement is the SOLE release
   point (round-2 item 6, replacing v2's ref-count; extended round-3 item 1).**
   The pipeline cannot observe the batch uploader's internal ownership
   transitions (batch-encode read, fallback-single dispatch, duplicate-waiter
   service are asynchronous and internal), so per-consumer ref-counting is
   impossible at the seam. Instead, every ready blob has exactly one
   DISPOSITION, and its temp is unlinked and its disk-axis charge released
   exactly when that disposition settles:
   - **uploaded** — the `api.putBlobFile(...)` promise for that temp settles
     (resolve or reject);
   - **server-satisfied skip** — the rolling check answers satisfied, so
     `putFile` is never called: released when that check settles (round-3
     item 1 — otherwise a freshly-encrypted-but-already-satisfied blob leaks
     its temp and reservation until final cleanup, and can deadlock the queue);
   - **convergent-duplicate skip** — another file with the same `encSha`
     already settled: released immediately on dedup.
   The uploader's contract is strengthened to guarantee **no read of the path
   after its `putFile` promise settles**, which the shipped implementation
   already satisfies: every read (`encodeBatchBody`'s `fs.readFile`, the
   single-PUT fallback stream) happens before the group's waiters are
   resolved/rejected, and duplicate waiters never have their own path read
   (only the FIRST waiter's path is read, `dispatchSingleGroup`,
   `blob-batch.ts:771–786`). A test pins the no-read-after-settle contract and
   the two skip-path releases. On rejection followed by retry,
   `uploadFileWithRetry` already re-encrypts a fresh snapshot when `ctByEnc`
   has no temp for the address (`:286–333`), so releasing on settlement cannot
   strand a retry.

**Progress totals may grow** as ciphertext sizes become known; `UploadByteTracker`
(`sync-recovery.ts:272`) already tolerates `reviseTotal` (`:337`).

### 3.3 Receipt redemption during upload (Finding 8)

A `ReceiptDrainer` captures each receipt as `putBlobFile` mints it
(`captureReceipt`, `context.ts:53`; batch path `blob-batch.ts:789`) and redeems
in the background during upload. Round-1 items 2/3 make it a real state machine,
not a fire-and-forget `kick()`:

- **Single-flight with generation-safe draining.** At most one redemption runs
  at a time; when one finishes it re-checks and re-kicks if the pending set again
  crosses `REDEEM_THRESHOLD`. `flush()` awaits the active generation AND then
  drains once more, looping until the pending set is empty or the error latch is
  set — so `flush()` cannot return with an un-awaited generation in flight.
- **Error latch + terminal state.** The background redemption's promise is OWNED
  by the drainer (never a floating promise): any rejection (402 quota, auth
  failure, network fault) is caught, stored in a latch, and triggers the shared
  abort (§3.5); it never becomes an unhandled rejection. Once latched, `capture`
  is a no-op and `flush()` re-throws the latched error.
- **Durable in-process `needsUpload` accumulator (round-1 item 2; dedup timing
  fixed per round-2 item 5).** The reused `redeemReceipts` body
  (`commits.ts:150–186`) returns `needsUpload` on 422; the drainer ACCUMULATES
  those across every background drain into a set. An accumulated entry is
  removed ONLY when a replacement receipt for that address is successfully
  REDEEMED (the address appears in a subsequent drain's granted/already-entitled
  outcome) — capture of a new receipt alone proves a re-PUT minted authority,
  not that entitlement landed, so capture does NOT clear the entry. `flush()`
  returns the residual `needsUpload` set; **the commit is blocked until that set
  is empty** — it feeds the existing `pushManifest` `unsatisfiedBlobs` recovery
  (`sync.ts:491+`), identical to how `commitSigned` handles `redeemNeedsUpload`
  today (`commits.ts:198–201`).
- **Backlog cap (round-2 item 9).** The drainer is single-flight, so one slow
  redemption could otherwise let settled uploads pile receipts without bound.
  A `RECEIPT_BACKLOG_MAX` (default `2 × REDEEM_THRESHOLD`, calibration-tunable)
  applies backpressure: when `ctx.receipts.size` exceeds it, consumers pause
  dispatching NEW PUTs until a drain completes (in-flight PUTs finish and
  capture normally — receipts from in-flight uploads may briefly exceed the cap
  by the in-flight window). This bounds the process-local receipt exposure an
  interruption can lose, and gives gate 5's backlog high-water a real bound.
- **Race-safe delete preserved verbatim** — `if (ctx.receipts.get(sha) ===
  receipt) delete` (`:182`) and the 422 "discard exactly the fenced sub-batch,
  keep siblings" handling (`:161–172`) are unchanged.

The ONLY behavioral change vs today is WHO calls redemption and WHEN: repeatedly,
during upload, under an owned promise with an error latch, instead of once after
all uploads. `REDEEM_THRESHOLD` trades round-trip count against how much
redemption wall hides under upload (§5.3). Per Finding 8's caution, this design
does NOT build batch receipt attestations — metrics (§5.1) must first show HMAC
verification, not D1 accounting or dispatch, is the redemption pole.

### 3.4 Interface contract with design 99 (fused crypto worker jobs)

Normative. Two tiers, explicitly separated so THIS design ships without design
99 (round-1 items 8/9):

**Tier 1 — ships in THIS design (file-backed, exists today).** Every ready
event is `ready(encSha, size, { kind: "file"; path })`. Producers are the
existing single-file `CryptoPool.encrypt` (`crypto-pool.ts:309`), which resolves
one `EncryptedBlob { plaintextSha, encSha, ciphertextPath, cipherSize, comp?,
payloadSha? }` (`crypto.ts:115`) per file — the pipeline emits exactly one
readiness event per resolved encrypt. The uploader consumes a path via the
EXISTING `api.putBlobFile` (`api.ts:73`) → `BlobBatchUploader.putFile`. No new
upload API, no design-99 dependency. This tier alone satisfies gate 1.

**Tier 2 — GATED on design 99 (buffer-backed, prerequisite).** Design 99's fused
small-file path returns ciphertext as an in-memory buffer (audit Finding 7's
`SmallEncryptResult.ciphertext`). A `ready(encSha, size, { kind: "buffer";
bytes })` event is accepted ONLY once design 99 also delivers a **batch
buffer-PUT API** — because the SHIPPED uploader takes filesystem paths
(`putFile`) and `encodeBatchBody` `fs.readFile`s them (`blob-batch.ts:726`);
`putBlobBytes` exists (`api.ts:96`) but bypasses the batch/receipt path. Until
that API exists and is reviewed under design 99, buffer-backed readiness is
**out of scope here** and the heap axis (§3.2) carries only the shipped
batch-PUT framing owner. The normative requirements design 99 MUST meet for
Tier 2 to turn on:

- one readiness event per file even when N files are fused into one worker job
  (a fused result array of N emits N events);
- per-file success/failure fidelity within a fused job (a partial batch may
  succeed; failed files defer individually);
- defined worker-death semantics: files in an in-flight fused job that dies are
  reported as un-produced and re-queued, never silently dropped;
- defined transfer-buffer ownership: a transferred `ArrayBuffer` is owned by the
  uploader on receipt and released (allowing GC) only after upload settles,
  counted against `maxHeapBytes` until then;
- `encSha` computed over the COMPLETE ciphertext by the producer before the
  event is emitted (whole-object integrity, §6.2).

Neither design lands a seam change without re-running the other's gates. The
Tier-1 seam is unit-testable in isolation with a fake single-file producer;
Tier-2 turns on behind its own flag after design 99's gates pass.

### 3.5 Cancellation and abort protocol (round-1 item 4)

All producers, consumers, the rolling-check batcher, and the drainer share one
`AbortController`. Abort fires on: a drainer error-latch (402/auth/network), a
non-deferrable producer error (worker crash), a consumer fatal error, or user
SIGINT. On abort:

- the ReadyQueue is CLOSED to new `push` (blocked producers wake and observe
  abort, stop taking files, and clean up any temp/reservation they hold);
- consumers stop pulling, and — because closing the ReadyQueue alone does NOT
  stop the batch uploader's internal queue, coalescing timers, batch slots, and
  `drainQueuedAsSingles()` fallback from dispatching later (round-2 item 2) —
  **the `BlobBatchUploader` gains an abort-aware `close()`**: queued
  not-yet-dispatched groups are rejected with the abort error (their waiters
  settle), coalescing timers are cancelled, and no fallback or batch dispatch
  starts after close. **Already-dispatched in-flight requests are allowed to
  finish** (aborting a PUT mid-body wastes the bytes and leaves a partial R2
  object the server must reject anyway).
- **The post-abort dispatch bound is defined over an atomic counter (round-2
  item 7):** a shared `dispatchCount` is incremented immediately before a
  request body begins transmission (batch, fallback single, or multipart part),
  in the same synchronous step that checks the abort latch — so "dispatched
  after abort" is a well-defined, falsifiable count. The protocol guarantees
  `dispatchesAfterAbort = 0` new dispatches post-close; what may still LAND is
  the in-flight window at abort time, ≤ active batch slots + active single-lane
  slots (a fixed, config-derived number recorded in the metric). Gate 3b
  asserts on this counter, not on wall-clock inference.
- **In-flight crypto jobs are AWAITED, never force-cancelled (round-3 item 3,
  Tier-1 requirement).** `CryptoPool` provides no cooperative cancellation
  (`crypto-pool.ts` has no abort surface on a dispatched `encrypt`) and this
  design adds none: abort stops producers from DISPATCHING new encrypts, and
  the abort path then awaits every already-dispatched encrypt's settlement —
  the **producer-termination barrier**. Only after that barrier do temp unlink
  and `fs.rm(tmpDir)` run, so a worker can never finish into deleted storage or
  recreate a file after cleanup;
- the drainer stops kicking; `flush()` re-throws the latched error;
- temp cleanup (after the producer-termination barrier): every unsettled temp
  is unlinked, then `fs.rm(tmpDir)` (the existing `finally`, `:406`) is the
  backstop;
- the error propagates to `pushManifest`, which surfaces it exactly as today
  (a 402 becomes the existing `QuotaExceeded`, `commits.ts:175`; other faults
  become the existing push error). A re-run resumes per §6.1.

### 3.6 Normal completion: the EOF/drain protocol (round-3 item 2)

Successful termination is an ordered barrier chain, not "Promise.all settled":

1. **Producer EOF.** When the `poolMap` over `toEncrypt` (including files
   re-queued from the cache-hit lane, §3.1) has settled every entry, producers
   CLOSE the ReadyQueue for writing. The cache-hit checker closes its lane the
   same way once every cache-hit address has a settled disposition (satisfied,
   or re-queued into `toEncrypt` BEFORE producer EOF is declared — the
   re-queue happens inside the same `poolMap` scope, so EOF cannot race a
   pending re-queue).
2. **Queue drain.** Consumers observe EOF after draining every queued item;
   each item reaches a settled disposition (§3.2 item 3).
3. **Final rolling-check flush.** On queue EOF the coalescing buffer FLUSHES
   its final partial batch immediately — a below-threshold tail must not
   depend on the idle timer.
4. **Consumer settlement.** All `putFile` promises and multipart transfers
   settle; the last receipt is captured.
5. **Drainer flush.** Only now does `drainer.flush()` run (§3.3), returning the
   residual `needsUpload`; the commit proceeds only when it is empty.

Each barrier is awaited in order; a test publishes a corpus whose tail is
smaller than every batch/threshold size and asserts no descriptor is left
buffered at commit time.

## 4. Finding 9 — measurement and deferral record only (NOT built here)

Round-1 item 17: §4 as originally written re-proposed the audit's Finding 9 while
deferring its core correctness properties (key management, rotation, revocation,
replay, issuance), which is not an implementable server design. It is therefore
**explicitly DEFERRED to its own reviewed design** with its own threat model.
This section is now only:

1. **A measurement obligation.** Instrument authentication CRITICAL-PATH time,
   not summed wall (round-1 item 18): concurrent batch-PUT auth calls overlap, so
   summed `authWallMs` overstates removable time. Measure per-request auth
   critical-path, D1 queuing, and `last_seen` throttling, and — the only gate
   that matters — an end-to-end A/B against an experimental path with auth cost
   artificially removed on a dev worker.
2. **A deferral gate.** A short-lived HMAC upload capability minted at an
   authenticated preflight (bound to account, protocol version, expiry,
   per-request object/byte caps, route family) is worth a dedicated design ONLY
   if that A/B shows ≥ a fixed threshold of publish-wall improvement (§5.2 P0.4).
   No client behavior in §3 depends on the outcome, and nothing in this design
   ships a server auth change.

## 5. Phase 0 and calibration — measure before building (falsification-first)

Round-1 item 16: calibrating queue bounds and `REDEEM_THRESHOLD` requires the
pipeline to EXIST, so it cannot be "measurement-only on the current path." Phase
0 is therefore split into **P0 (measurement-only, current serialized path)** and
a **flagged Prototype-Calibration phase** that runs after the pipeline is built
behind `RBOX_PIPELINE=1` but before it is trusted or defaulted.

### 5.1 P0 instrumentation (behavior-neutral, current path)

Add a `FirstPublishStats` details object, emitted through the EXISTING
`PhaseReport.recordDetails` path (`src/engine/phase-report.ts:167`) under the
push report, gated by `metricsEnabled()` (`src/cli/metrics.ts:19`), piggybacking
on the shipped `uploadLaneTiming` accumulator (`blob-batch.ts:788–824`) and the
design-97 numbers-only discipline. Fields (non-negative integers; **counts,
bytes, durations ONLY**):

- `timeToFirstReadyCiphertextMs`, `firstReadyToFirstUploadStartMs`;
- `encryptWallMs`, `missingCheckWallMs`, `uploadCriticalPathMs`,
  `receiptRedemptionWallMs`, `commitWallMs` — every serialized stage, so §5.2's
  baseline equation has all its terms (round-1 item 14);
- `receiptRedemptionOverlapMs` — redemption wall that overlapped active upload
  (measured, the Finding 8 win);
- `authCallCount`, `authCriticalPathMs` — critical-path, not summed (round-1
  item 18);
- `peakTempDiskBytes`, `peakQueueHeapBytes`, `peakUploaderFramingBytes` — the
  three memory/disk owners (round-1 item 5);
- `serverUnsatisfiedTotal`, `serverSatisfiedSkipped` — the resume-tail
  partition. The absent/unentitled/GC-fenced sub-causes are NOT client-observable
  (`/v1/blobs/check` returns one merged `missing` list — round-2 item 3); a
  privacy-safe server-side aggregate breakdown (counts only, with defined
  precedence for overlapping states) is optional future work, not required by
  any gate;
- `uniqueEncryptions`, `duplicateEncryptions`, `reEncryptedOnResume`;
- `producerCpuSaturationPct`.

**HARD PRIVACY RULE (non-negotiable, inherited from design 97 and the
`PhaseReport` header contract, `phase-report.ts:6–9`): no raw file names or paths
in ANY emitted metric or log line — counts, bytes, and durations only.** The
existing code passes `f.path` to `onProgress` for the live spinner
(`sync-recovery.ts:207`); that is the interactive display, NOT a metric, and must
not leak into `FirstPublishStats`, the phase report, or persisted telemetry. A
test asserts the emitted details object and summary line contain no path-shaped
(`/`-containing) or sha-shaped (64-hex) string (§7 gate 8).

### 5.2 P0 gates (measurement-only, kill the build before it starts)

Measured on Workload B (audit protocol: fixed ~100k-file corpus, empty
encryption cache, duplicate-content ratio recorded, one clean + one
interrupted-and-resumed run; **10 warm / 5 cold samples; report p50, p95, range,
raw counts; keep the pre-pipeline release as the A/B control; "noise" = the p95
run-to-run spread of the control on the same host/network**).

- **P0.1 — full serialized baseline equation.** Record all stage walls from §5.1
  and define the control end-to-end wall
  `W_ctrl = encryptWall + missingCheckWall + uploadCriticalPath +
  receiptRedemptionWall + commitWall + fixed overhead`, measured directly (NOT
  reconstructed) as the push command wall. Every later gate compares the pipeline
  build's measured end-to-end wall `W_pipe` against `W_ctrl` (round-1 item 14).
- **P0.2 — overlap headroom (parameter-free, round-3 item 4).** The headroom is
  the OPTIMISTIC upper bound with redemption assumed fully overlapped:
  `H_p50 = p50(W_ctrl) − (p50(max(encryptWall, uploadCriticalPath)) +
  p50(commitWall))` — every term is a directly measured control stage wall;
  there is no tunable parameter. **GATE:** if `H_p50 < 0.10 × p50(W_ctrl)`,
  STOP — even the optimistic bound is not worth the complexity. (Inferred large
  from the 575% CPU observation, but measured.) Because `H_p50` is optimistic,
  gate 1's "reclaim ≥ half of `H_p50`" is a conservative bar.
- **P0.3 — owner-sizing.** From `peakTempDiskBytes` /
  `peakUploaderFramingBytes` on the control, confirm the batch-PUT framing owner
  and the largest single ciphertext, so §5.3's caps are set against measured
  sizes, not circular ones (round-1 item 6).
- **P0.4 — auth lever (§4 only).** Per §4: end-to-end A/B on a dev worker with
  auth cost removed. **GATE:** open a Finding-9 design only if publish-wall p50
  improves ≥ 3s on the fixed cold corpus; else record deferred.

### 5.3 Prototype-Calibration (flagged, after the pipeline is built)

Behind `RBOX_PIPELINE=1`, on Workload B: sweep `maxTempDiskBytes`,
`maxHeapBytes`, `maxItems`, upload concurrency, and `REDEEM_THRESHOLD`. Record
`peakTempDiskBytes` + `peakQueueHeapBytes` + `peakUploaderFramingBytes` vs
upload-slot idle fraction at each setting. **Calibration target:** a setting
whose summed peak disk ≤ 4× the largest single ciphertext (P0.3) and summed peak
heap ≤ a fixed fraction (target 25%) of a 2 GiB RSS ceiling, with upload-slot
idle < 5% at p50. If no setting bounds the peaks without starving upload, the
budget model (§3.2) is wrong and returns to design before default-on.

## 6. Correctness requirements

Each is a REQUIREMENT with a test obligation (§7); none may regress the current
floor.

### 6.1 Interrupted-and-resumed publish (persistence model, round-1 items 12/13)

State the persistence model explicitly rather than claiming "loses no work".
**The encrypt cache persists ADDRESS COMPUTATION, not reusable encryption
output** (round-2 item 10): a persisted descriptor lets resume skip re-encrypting
a file ONLY when its address is still server-satisfied; a server-unsatisfied
cached address must be re-encrypted from source regardless of how gracefully the
prior run exited, because ciphertext temps never survive a run.

- **What persists:** the encrypt-address cache (`encryptCache`,
  `.rbox/state/…`), mapping `plaintextSha → descriptor`, flushed on a scheduled
  cadence (`cacheWriter.schedule()`), NOT synchronously per file. What is
  uploaded+redeemed persists SERVER-side as account entitlement.
- **What does NOT persist:** receipts (`ctx.receipts`, process-local),
  and ciphertext temps (`tmpDir`, removed in `finally`).
- **Graceful abort (§3.5, SIGINT):** the cache flush runs in the `finally`, so
  address records for encrypted files survive; resume re-encrypts only the
  server-unsatisfied subset of them (bounded by the backlog cap + in-flight
  window, §3.3).
- **SIGKILL / power loss:** address records written since the last scheduled
  flush are also lost; resume additionally re-encrypts that BOUNDED tail (at
  most one flush interval of encryptions). This is stated as expected, not a
  bug.

On resume, the rolling server-satisfied check (§3.2) classifies each address:

- **server-satisfied** (entitled+present+GC-safe): skipped, no upload, charged 0
  by `commitAccounting` — these are prior-run blobs that reached redemption.
- **server-unsatisfied** (whether from absence, missing entitlement, or GC
  fencing — one merged answer client-side, §2.2): re-PUT to re-mint a receipt,
  then redeemed. A cache HIT supplies a descriptor but NOT ciphertext (temps
  are gone), so a server-unsatisfied cache-hit address IS re-encrypted from
  source per the §3.1 state graph — unavoidable reconstruction, bounded by the
  unsatisfied tail (round-1 item 13). **Redeeming during upload (§3.3) shrinks
  this tail** to roughly `RECEIPT_BACKLOG_MAX + in-flight` at the interruption
  point.

Test: kill (SIGINT and SIGKILL) mid-upload and mid-redeem; assert resume
re-encrypts 0 files for the server-SATISFIED cache-hit set, re-uploads only the
server-unsatisfied tail, re-encrypts only the (server-unsatisfied ∪
post-last-flush) set, and the final account charge equals the single-run charge
(no double-charge).

### 6.2 Receipt idempotency and whole-object integrity

- **Receipt idempotency:** unchanged and preserved — redemption is idempotent
  (server charges 0 for already-entitled), delete is race-safe delete-if-unchanged
  (`commits.ts:170,182`), socket-close-before-response is replayable. The
  drainer's single-flight discipline (§3.3) forbids two concurrent redemptions of
  the same receipt. Test: redeem a set twice (simulated replay) → one net charge.
- **Whole-object integrity (audit non-opportunity: "direct R2 paths that weaken
  whole-object integrity or revocation"):** `encSha` is sha256 over the COMPLETE
  ciphertext, computed by the producer before `ready` (§3.4); the uploader PUTs
  the whole object; server whole-object hash verification and revocation are
  untouched. No partial/streamed-unverified body is ever a committed address.
  Test: committed manifest and R2 objects byte-identical to the serialized path
  on the same corpus (full-corpus receiver diff clean).

### 6.3 Quota and orphan-entitlement semantics (round-1 items 10/11)

- **Accounting is monotonic and idempotent, NOT byte-set-identical.**
  `commitAccounting` (`commit-accounting.ts:122`) preserves successful earlier
  super-batches when a later one exceeds cap (`:192` delete-fence, `:200`
  over-cap rollback of only the failing super-batch). So which refs are granted
  before a 402 depends on receipt grouping and `REDEEM_THRESHOLD`. This design
  therefore claims only: (a) every granted ref is genuinely uploaded+entitled;
  (b) total charged bytes never exceed the cap; (c) a re-run is idempotent and
  reaches the same cap decision. It does NOT claim the exact pre-402 granted set
  is identical to the serialized path. Test: a quota-exceeding corpus fails with
  the same terminal `QuotaExceeded`, uploads at most the in-flight window past
  the point quota is known exceeded (§3.5), and a re-run reaches the same cap
  decision with no double-charge — asserting monotonicity, not set-equality.
- **Orphan entitlements are accepted and bounded.** Progressive redemption grants
  entitlements before the commit succeeds (invariant, accepted exposure). Bound:
  the orphan set on a failed/cancelled/conflicted publish is at most the redeemed
  set at failure time (≤ all uploaded blobs); each orphan is an unreferenced,
  entitled `blob_ref` that per-account GC (design 33) reclaims exactly as any
  other. The design does NOT attempt to un-redeem on failure (that would fight
  idempotency); it documents the exposure and relies on GC + the re-run
  re-committing the same manifest. Test: force a 409/epoch conflict after early
  redemption; assert the retry re-commits without double-charge and no orphan
  survives a GC pass.

### 6.4 Failure-mode table (round-1 item 19)

| Failure | Handling | Cleanup / entitlement |
|---|---|---|
| Crypto worker crash mid-job | rejected encrypt → abort scope (§3.5) | unsettled temps released on abort cleanup; churn-deferrable files defer, others fail push |
| Rolling-check timeout/error | consumer fatal → abort scope | in-flight PUTs finish; push fails; re-run resumes (§6.1) |
| Producer faster than consumers | `push` blocks (budget, §3.2) | bounded occupancy; no exhaustion |
| Batch-PUT partial/framing response | existing per-record status parse (`blob-batch.ts:853`) | unsatisfied records fall to single-PUT fallback / retry inside the uploader; temp released only when the putFile promise settles (§3.2) |
| Receipt 422 (`needsUpload`) during backlog | drainer accumulates, dedups vs new receipts (§3.3) | `flush()` returns set; commit blocked → residue re-upload |
| Quota 402 mid-redeem | error latch → abort (§3.5) | ≤ in-flight window uploaded past cap; orphan set GC-reclaimed (§6.3) |
| Auth/token expiry mid-run | thrown transport fault → consumer fatal → abort | re-run re-authenticates |
| 409 / epoch conflict after early redemption | existing `pushManifest` recovery re-commits | orphan entitlements GC-reclaimed; no double-charge (§6.3) |
| Disk-full on temp creation | encrypt throws → abort | reservation-based disk axis (§3.2) bounds the crypto working set, so occupancy is bounded by `maxTempDiskBytes` + one oversize item; backstop `fs.rm(tmpDir)` |
| Temp deletion failure | logged, non-fatal; `finally` `fs.rm` backstop | no correctness impact |
| Worker death with transferred buffer (Tier 2) | files re-queued (§3.4) | design-99 gate; not in Tier-1 scope |
| User SIGINT | abort scope (§3.5) | graceful; cache flushed in `finally`; resume per §6.1 |

### 6.5 Post-ready churn: the manifest commits the SCAN snapshot (round-2 item 11)

Stated explicitly rather than implied: **a file may change AFTER its ciphertext
is ready but before PUT or commit, and the pipeline intentionally commits the
scanned snapshot anyway.** This is IDENTICAL to today's serialized semantics —
`encryptFileToTemp` validates the source against the scanned `{sha256, size}`
tuple at SNAPSHOT time (`expected`, `sync-recovery.ts:224–227`) and encrypts an
immutable snapshot (`crypto.ts:186–190`); nothing in the current code re-checks
the live file between encryption and commit, and the committed manifest
deliberately references the scan's content. Post-encryption churn is detected by
the NEXT scan and published by the next push. Churn-defer
(`isDeferrableChurn` → `deferred`, `:234`; `BlobShaMismatchError` retry,
`:360–369`) applies only when the mismatch is observed AT snapshot/upload time —
that per-file contract is unchanged by the pipeline. Test: mutate a file after
its `ready` event and before its PUT; assert the committed manifest references
the SCANNED content (byte-identical to the serialized path's behavior on the
same interleaving) and the next scan picks up the mutation.

## 7. Gates (falsifiable, on Workload B; 10 warm / 5 cold, A/B vs control)

**Statistical definitions (round-2 item 8), fixed BEFORE measurement:** for any
quantity X, `noise(X) = max(p95_ctrl(X) − p50_ctrl(X), 0.05 × p50_ctrl(X))` —
the control's p95−p50 spread on the same host/network, floored at 5% of the
control p50. "Within noise" means `p50_pipe ≤ p50_ctrl + noise` AND
`p95_pipe ≤ p95_ctrl + noise`. Wall gates are stated as separate p50 and p95
inequalities. A gate run is invalidated (and re-run, not averaged over) only for
a documented external cause (host sleep, network change).

1. **Overlap gate (headline).** `p50(W_pipe) ≤ p50(W_ctrl) − 0.5 × H_p50` AND
   `p95(W_pipe) ≤ p95(W_ctrl) − 0.25 × H_p50` (the tail may reclaim less, but
   must reclaim), measured as command wall, not summed lanes (round-1 items
   14/15).
2. **Encrypt no-regression.** With design 99 absent (Tier 1), `encryptWallMs` is
   within noise (as defined above) of P0.1's control `encryptWallMs`.
3. **Interrupted-resume gate.** Per §6.1: resume re-encrypts 0 files whose
   cached address is still server-SATISFIED; re-uploads only the
   server-unsatisfied tail; re-encrypts only the (server-unsatisfied ∪
   post-last-flush) set; final account charge == single-run charge, byte-exact.
   Run for both SIGINT and SIGKILL. Exact counts, no percentiles — this is a
   correctness gate.
   - **3b. Post-abort dispatch bound.** On a mid-run quota 402:
     `dispatchCount` increments after the abort latch = 0 (the atomic counter of
     §3.5), and objects landed after the latch ≤ the recorded in-flight window
     (active batch + single-lane slots at latch time). Exact counts.
4. **Budget gate.** For the full run: disk occupancy (crypto reservations +
   queued + unsettled temps) ≤ `maxTempDiskBytes` + one oversize item (§3.2),
   with `maxTempDiskBytes` calibrated ≤ 4× the largest single ciphertext
   (P0.3); `peakQueueHeapBytes + peakUploaderFramingBytes` ≤ 25% of the 2 GiB
   RSS ceiling at p95 across runs (the uploader term is a measured target, not
   an accounting bound — §3.2); upload-slot idle < 5% at p50 and < 10% at p95.
   Includes a single-object-over-cap test (oversize admission covering the
   crypto working set, §3.2).
5. **Receipt-overlap gate (sampled instants defined, round-2 item 9).**
   (a) `receiptRedemptionOverlapMs ≥ 0.5 × receiptRedemptionWallMs` at p50 and
   ≥ 0.25 at p95; (b) receipt-backlog high-water DURING the run ≤
   `RECEIPT_BACKLOG_MAX` + in-flight window (§3.3); (c) pending receipts
   sampled AT THE INSTANT the last upload settles (before `flush()`) ≤
   `RECEIPT_BACKLOG_MAX` + in-flight window. Exact counts for (b)/(c).
6. **Integrity gate.** Full-corpus receiver diff clean; committed manifest and R2
   objects byte-identical to the serialized path (§6.2). Includes the §6.5
   mutation-after-ready test.
7. **Determinism/regression suite.** Re-run corruption, quota, GC-fence, 409,
   churn, and E2EE determinism suites (audit §Statistical discipline). No
   small-push regression: a push with < 64 changed files (fixed threshold)
   takes the direct non-pipeline path and its wall is within noise of control.
8. **Privacy gate.** `FirstPublishStats`, the phase summary line, and persisted
   telemetry contain no path-shaped or 64-hex sha-shaped strings (§5.1).
9. **(§4, deferral only.)** No auth change ships; P0.4 A/B either opens a
   Finding-9 design (≥ 3s) or records deferred.

## 8. Rollout

1. **P0 instrumentation first (§5.1), behavior-neutral.** Land `FirstPublishStats`
   and the three-owner high-water tracking on the CURRENT serialized path; collect
   P0.1–P0.4 on the fleet. Gate P0.2 decides whether to proceed.
2. **Pipeline (Tier 1, file-backed) behind `RBOX_PIPELINE=1`.** Build §3.1–3.3,
   §3.5; run Prototype-Calibration (§5.3); A/B vs serialized on real workspaces.
   Serialized stays default until gates 1/3/4/5/6 hold.
3. **Receipt drainer (§3.3) is an independently gated semantic reorder, NOT an
   axiomatic improvement (round-1 item 20).** It ships only after its quota,
   orphan-entitlement, cancellation, and error-propagation behavior (§6.3, §3.5)
   is proven; A/B-able via `REDEEM_THRESHOLD`.
4. **Tier 2 (buffer-backed) stays off** until design 99 delivers the batch
   buffer-PUT API and passes its own gates (§3.4); then behind its own flag.
5. **Finding 9 (§4)** is a separate reviewed design if and only if P0.4 clears;
   nothing here ships a server auth change.
6. **Flip default** once gates hold at p50 AND p95 across both fleet filesystems,
   keeping the flag as an escape hatch for one release.

## 9. Out of scope

1. **Fused multi-file crypto worker jobs and the buffer-upload API (audit Finding
   7 / design 99).** Tier 2 (§3.4) is gated on design 99; this design ships Tier 1
   only and must not regress encrypt (gate 2).
2. **Finding 9 server auth capability (§4).** Measurement + deferral only; its
   protocol, key management, rotation, revocation, replay, and threat model are a
   separate reviewed design.
3. **Parallel multipart parts / ranged large-object transfer (Finding 10).**
   Large files stay on the existing multipart path (`src/cli/remote/multipart.ts`);
   the pipeline schedules them one-at-a-time on the disk axis but does not change
   part concurrency.
4. **Batch receipt attestations.** Deferred by Finding 8 until metrics show HMAC
   verification is the redemption pole.
5. **Un-redeeming on failure.** Orphan entitlements are accepted and GC-reclaimed
   (§6.3), not actively reversed.
6. **Any change to receipt minting, quota accounting, whole-object verification,
   or revocation semantics.** The pipeline reorders WHEN existing operations run;
   it changes none of their semantics.
7. **Cold-JOIN (Workload C) and steady-sync (Track A).** Different designs; this
   is Workload B (cold first publish) only.
8. **Server-side ciphertext compression, staging→canonical promotion for small
   blobs, D1 sharding** — audit explicit non-opportunities, unchanged here.
