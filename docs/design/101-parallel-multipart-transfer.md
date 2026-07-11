# 101 — Parallel multipart part transfer (upload) + completion-pass measurement

Status: Design draft v5 (codex review rounds 1-4 folded in — see
`REVIEW-101.md`). Client-dominant. Shipped scope is **multipart UPLOAD
parallelization plus completion-pass measurement**; ranged parallel *download*
is descoped to a Phase-0 measurement outcome that, if its gate passes, opens a
**follow-on design (102)** — it is not designed here (R1 items 9-11). Origin:
the 2026-07-10 sync-performance audit, Finding 10
(`docs/audits/2026-07-10-sync-performance-audit.md:753-816`). The first publish
is the conversion moment; a first publish containing large files (video, disk
images, ML checkpoints) is bottlenecked by **serial** multipart part upload. The
audit rates this "at least 2x transfer for qualifying large blobs … High,
workload-specific" (`audit:119`) and sets the falsifiable success gate at "at
least 2x large-object transfer with no resume regression" (`audit:1317`).

Method: designs 79-100's — **measure, falsify, then redesign.** Phase 0 (§5) is
shipped measurement-only instrumentation on the current serial path and decides
whether parallelizing parts can even reach the target; Phase 1 (§3) is the
implementation, whose concurrency default is chosen by an experimental sweep
(§9) and whose ship is gated on §7's falsifiable gates. Every "measured" number
cited from prior work is stale-by-default and re-measured on current `main`
before its gate is evaluated.

Related: design 97 (commit server timing decomposition — the numbers-only
`serverTimings` propagation and control-flow rules this design copies for the
completion pass, `docs/design/97-commit-server-timings.md`), design 85 (the
falsification-first measurement discipline), the audit's Workload D
(`audit:1279-1293`) and statistical discipline (`audit:1294-1301`).

## 0. Scope and hard constraints (stated first)

**In scope (shipped).** (a) Upload the N missing parts of a single large blob
concurrently instead of one-at-a-time, under a global occupancy budget with an
adaptive throttling rule that protects the small-file batch lane. (b) Measure the
client's per-part transfer wall separately from the server's completion wall, so
we learn whether parallelizing parts merely exposes finalization as the next
pole (`audit:810-811`). (c) Close a pre-existing staging-orphan gap the audit's
completion analysis surfaces (§8).

**Descoped to a follow-on (design 102), decided by a Phase-0 measurement gate
only (§5, §6).** Ranged parallel *download* of large blobs. Finding 10 only
recommends *separately testing* it (`audit:813-815`); it carries its own server
Range semantics, sparse-file assembly, retry/watchdog changes, a second
scheduler, and a distinct revocation boundary — a separate design-sized feature
(R1 item 11). This document ships none of it.

**Out of bounds by audit hard constraint (`audit:1197`, `audit:1198`):**

- **No direct-R2 path that weakens whole-object integrity or revocation.** The
  server completion pass exists to make R2 verify the whole-object SHA
  server-side (`apps/api/src/blobs.ts:435-453`). Any mitigation that publishes
  canonical bytes R2 did not verify against the content address, or that
  bypasses the entitlement/GC-fence gate, is dead on arrival — including the §7.3
  completion-mitigation track. **No checksum composition (per-part or summed) is
  equivalent to verifying `encSha` unless R2 itself validates the exact
  assembled byte sequence** (R1 item 12). If no integrity-preserving mitigation
  exists, the honest conclusion is written in: **parallelize parts, accept the
  completion cost, document it** (§7.3).
- **No chunk sync.** This design changes *how the bytes of one content-addressed
  blob move*, never *what a blob is*: no sub-blob addresses, no partial/delta
  re-upload of a mutated large file (`audit:1198`). A large blob stays one
  immutable `encSha`; a changed byte re-encrypts and re-uploads the whole blob.
- **No retuning of shipped lanes to pass a gate** (R1 item 13). No gate in §7
  may be satisfied by changing the shipped 24 batch-PUT / 48 batch-GET / 64
  large-blob slot defaults, the compress-before-encrypt behavior, the
  qualifying-object threshold, or the benchmark workload composition. Those are
  shipped (`audit:68-98`) and fixed; the only knob this design introduces is the
  multipart part budget.

**Invariant (design-82 style, honestly bounded).**

> A large blob's published canonical bytes are **always** R2-verified against
> its content address `encSha`, whether its parts arrived serially or
> concurrently, on the first attempt or after any number of resumes. Parallel
> parts may do EXTRA work — re-upload a part whose ack was lost, re-init a dead
> MPU, re-stream on resume — but the worst legitimate outcome is bounded
> repeated transfer, never an unverified or partial publication. Concretely:
> (a) the completion call still performs exactly one server-authoritative
> whole-object verification (`put(canonicalKey, staged, {sha256})`,
> `blobs.ts:449`) — untouched; (b) a part is content-scoped and idempotent
> (server `INSERT OR REPLACE upload_parts`, `blobs.ts:402-405`), so a
> concurrently-retried part converges to one row; (c) resume seeds the missing
> set from the SERVER's completed-parts status (`multipart.ts:69-80`) before
> launching any part; (d) exactly one `complete` call is issued per attempt, its
> not-auto-retried idempotency-safety contract (`multipart.ts:133-140`)
> preserved verbatim, and it is issued **only after every launched part of this
> attempt has settled** (§3.1 structured drain), so completion never races a
> surviving in-flight PUT. "Fall back to serial-correct recovery on any doubt"
> is not a mid-flight mode switch: it is the existing outer `putBlobMultipart`
> recovery (clear token, re-check present, re-init from a fresh MPU,
> `multipart.ts:28-52`), entered only after the drain, reusing the
> server-authoritative part set on the next attempt.

## 1. Problem and evidence

Measured means observed in code or on the named workload; inferred still needs
the §5 gate.

1. **Parts upload strictly one at a time, measured in code.** `multipartAttempt`
   walks part numbers in a `for` loop, `await`-ing each part PUT before the next
   (`src/cli/remote/multipart.ts:107-131`; quoted in `audit:759-766`). Part size
   begins at 8 MiB (`MIN_PART`, `apps/api/src/blobs.ts:105`; `partSizeFor`,
   `blobs.ts:109-113`), so a 2 GiB object is **256 serialized part requests**,
   each a full WAN round-trip + R2 `uploadPart` + D1 `INSERT OR REPLACE`
   (`blobs.ts:379-408`). At nonzero RTT this is latency-bound: 256 × (RTT +
   transfer) instead of transfer + a few RTTs.

2. **The large-blob lane runs many blobs concurrently — but never many parts of
   one blob, measured in code.** The first-publish uploader fans out
   `poolMap(toUpload, uploadConcurrency(), …)` at up to 512
   (`src/cli/sync-recovery.ts:53,379`); each file funnels into
   `BlobBatchUploader.putFile` (`src/cli/remote/blob-batch.ts:581-593`). A blob
   past the 256 KiB batch record cap is NOT batched — it takes the `gatedPutFile`
   path bounded by a per-process `SingleGate` of 64
   (`SINGLE_UPLOAD_FALLBACK_CONCURRENCY`, `blob-batch.ts:35,566,826-828`) →
   `putBlobFile` → `putBlobMultipart`. So up to 64 *large blobs* upload at once,
   each serializing its parts. A publish whose large bytes live in **one**
   enormous blob (a disk image, a single video) uses one of those 64 slots and
   serializes every part inside it — the "qualifying large blob" shape.

3. **Small-file and large-blob lanes are SEPARATE budgets sharing only the
   uplink, measured in code.** Small blobs (≤ 256 KiB) coalesce through the 24
   batch-PUT slots (`DEFAULT_BATCH_PUT_SLOTS`, `blob-batch.ts:31,570-571`); large
   blobs use the independent 64-wide `SingleGate`. They share no semaphore — only
   physical bandwidth and CPU. **Central risk:** giving each large blob its own
   part concurrency N lets the process issue up to `64 × N` concurrent part PUTs,
   saturating the uplink and starving the small-file lane of *bandwidth* even
   though its *semaphore* is free. §3.2's budget bounds occupancy and its
   adaptive-throttling rule bounds bandwidth pressure (measured, not guaranteed — §3.2, G3).

4. **Completion rereads the whole object, server-side, measured in code.** After
   the last part, `multipartComplete` (`blobs.ts:411-484`): (1) `mpu.complete`
   assembles staging — the composite ETag is NOT the content hash
   (`blobs.ts:438-439`); (2) `get(staging_key)` reads the whole object back
   (`blobs.ts:440`); (3) `put(canonicalKey, staged.body, {sha256})` streams it
   through the Worker into canonical, **where R2 verifies the whole-object SHA**
   (`blobs.ts:449`); (4) `INSERT … present=1` + `grantEntitlementWithQuota`
   (`blobs.ts:454-476`); (5) `finally` deletes staging + `cleanupUpload`
   (`blobs.ts:479-483`). Steps 2-3 move the entire object through the Worker a
   second time. It is **load-bearing for integrity**: R2 verifies a content hash
   only on `put(..., {sha256})`; `complete` yields a composite ETag. Removing
   steps 2-3 publishes unverified canonical bytes — the codex-review fix the code
   documents (`blobs.ts:98-101`) and exactly what `audit:1197` forbids. §5
   measures this wall; §7.3 constrains any mitigation to integrity-preserving
   options.

5. **Downloads of large blobs are single-stream, measured in code** (context for
   the §6 measurement gate only). `getBlobToFile` opens one `fetch`, streams to
   disk, hashes in stream order to verify `sha256`
   (`src/cli/remote/blobs.ts:133-210`); the server GET is a single un-ranged R2
   read (`blobGet`, `blobs.ts:283-296`; `blobGetWithVerifiedGrant`,
   `blobs.ts:302-312`; routed `apps/api/src/worker.ts:242-254`). Whether this is
   even a pole is unknown — "Do not assume the ordinary small-file corpus
   benefits" (`audit:814-815`).

## 2. Root cause

The serial loop is the *absence* of a part-level concurrency primitive: the two
existing budgets (24 batch-PUT, 64 large-blob) operate at **blob** granularity;
a single large blob is opaque to both. The fix adds a part-level scheduler.
Because part bodies are large (≥ 8 MiB) and the uplink is shared, the scheduler
must (a) bound *occupancy* to keep memory/request pressure sane and (b) carry an
explicit *adaptive throttling* rule so it does not starve the small-file lane of bandwidth
— occupancy alone does not bound bandwidth (R1 item 2).

## 3. Design — client parallel parts (Phase 1)

### 3.1 Per-blob: structured pool over the missing parts

Replace the serial `for` loop (`multipart.ts:107-131`) with a bounded,
**structured** pool over the missing part numbers:

```
missing = [1..totalParts] filter (n => !completed.has(n))
attempt = structuredPool(missing, MULTIPART_PARTS_PER_BLOB, async (n, signal) => {
  await globalPartBudget.acquire(len(n), signal)   // §3.2 FIFO, abortable
  try   { await uploadPartWithRetry(n, signal); progress.add(len(n)) }
  finally { globalPartBudget.release(len(n)) }
})
// on FIRST error (structured concurrency — R1 item 5):
//   1. stop launching new parts;
//   2. abort() every in-flight part's signal (aborts its fetch + drops any budget waiter);
//   3. AWAIT settlement of every already-launched part (no orphan writes survive);
//   4. THEN classify the first error and re-init/defer via the existing outer recovery.
await complete(uploadId)   // reached only if all parts settled OK — still exactly one call
```

Kept verbatim (`audit:801-808`): server-authoritative completed-parts status
(`multipart.ts:73-77`); per-part body ranges (`fileStream(absPath, start,
end-1)`, `multipart.ts:119`); idempotent per-part retry (`retryTransient`,
`multipart.ts:114-123`); the on-disk resume token
(`.rbox/state/uploads/<encSha>.json`, `multipart.ts:98-101`); one final
`complete`; whole-object server-authoritative integrity.

Correctness deltas the parallelization forces, each testable:

- **Structured first-error drain (R1 item 5, the load-bearing one).** `poolMap`
  today (`src/engine/pool.ts:11-16`) rejects on first failure but does not await
  the other in-flight tasks. Under parallel parts that is unsafe: completion or
  re-init must NOT begin while a surviving PUT can still write to the same
  `uploadId`, or cleanup/re-init races the surviving request, yields noisy 410s,
  distorts progress, and inflates retransmission past the claimed bound. The pool
  is therefore structured: on first error it stops launching, `abort()`s every
  in-flight part (an `AbortController` per part, threaded into `fetchWithDeadline`
  which already accepts a signal, `multipart.ts:116-121`), and **awaits every
  launched part's settlement** before the outer catch classifies the error. Only
  then does the existing recovery (re-check present / re-init from fresh MPU)
  run — and it re-reads the server's completed set, so it reuses whatever
  survived. **Abort must propagate through the retry wrapper, not just the fetch
  (R2 item 9):** `uploadPartWithRetry`/`retryTransient` observe the same signal —
  an abort interrupts a backoff sleep immediately and forbids launching any
  further attempt, and a budget waiter's acquire rejects on abort (§3.2) — so
  the drain never waits out a retry ladder and never launches a request after
  the first error. Tests: (a) inject a part failure with j others in flight,
  assert completion/re-init starts only after all j settle; (b) a lost ack
  (server accepted a part the client saw fail) → next attempt's status GET
  reports it complete → not re-sent; (c) abort landing during each of: an active
  fetch, a retry backoff sleep, and a budget wait — each settles promptly with
  no further attempt launched.
- **Progress accumulation is atomic.** Today `completedBytes += len` runs on one
  thread (`multipart.ts:129-130`); under the pool it becomes one accumulator
  mutated under the pool and reported via the existing `onBytes`. Purely the
  progress number, no upload-correctness effect. Test: sum of per-part `len` ==
  `size` in any completion order.
- **Concurrent disjoint reads of one source file.** Each part opens its own
  `fileStream` over a disjoint range (`multipart.ts:109-119`); concurrent
  read-only streams over disjoint ranges are safe on both fleet platforms. The
  live-file TOCTOU case is unchanged: a changed range still surfaces as server
  `sha_mismatch` → `BlobShaMismatchError` → push re-scans and retries
  (`multipart.ts:124-127`).

### 3.2 Global: a FIFO occupancy budget with batch-busy adaptive throttling

A per-process budget governs how many part-body bytes may be in flight across
*every* large blob. **Honest framing (R1 item 2):** a byte budget bounds
*occupancy* (memory, concurrent requests, socket count) — it does NOT by itself
bound *bandwidth*, because a continuously replenished window can still saturate a
capacity-bound uplink. Two mechanisms therefore work together:

1. **Occupancy cap** — `MULTIPART_INFLIGHT_BYTES` bounds concurrent part-body
   bytes. Bytes not slots, because `partSizeFor` grows parts with object size
   (`blobs.ts:109-113`) so a fixed count has a wildly variable footprint. Sweep
   window (not a promise) 64-128 MiB; the §9 sweep + §7 G-part/G3 set the
   default. `MULTIPART_PARTS_PER_BLOB` (≈ 6-8) caps how much one blob may hold so
   a second large blob still progresses.
2. **Batch-busy adaptive throttling (the anti-starvation mechanism; honestly
   named per R2 item 6 — adaptive throttling, NOT a bandwidth-share guarantee).**
   The multipart scheduler throttles while the small-file batch-PUT lane has
   work: while `BlobBatchUploader` has any queued or in-flight batch (observable
   in-process — the uploader is a singleton with a `queue` and `active` count,
   `blob-batch.ts:559-565`), the effective part budget drops to
   `MULTIPART_INFLIGHT_BYTES_WHEN_BATCH_BUSY` (a smaller cap, possibly zero).
   Occupancy still does not bound bandwidth on a capacity-bound uplink — whether
   a given cap protects the batch lane is exactly what G3 measures, and the
   mechanically safe extreme (`…_WHEN_BATCH_BUSY = 0`: **no new multipart
   admissions while batch work is queued**) is a first-class member of G3's
   predeclared candidate set, not a last resort. **Busy-transition semantics,
   defined:** already-admitted parts always run to settlement (throttling never
   aborts an in-flight PUT); on busy, no NEW admission occurs while in-flight
   part bytes exceed the reduced cap; on drain (batch queue empty, no active
   batch), the full budget is restored and FIFO admission resumes.
   **Check/admission coordination (R3 item 6; linearization made real per R4
   item 2):** the busy flag and budget grants share one linearization point —
   the budget's grant loop. `BlobBatchUploader.enqueue` flips the shared flag
   **synchronously, before its first await**; the grant loop (run on every
   release/drain) **re-checks the flag before each individual permit and stops
   immediately when it flips**, and — because a synchronous multi-grant burst
   could otherwise admit a whole budget window before the enqueue task ever
   runs — **the loop yields to the event loop between permits (one permit per
   turn)**. A yield per ≥ 8 MiB part is negligible overhead and restores the
   real bound: at most ONE part admitted between an enqueue and the throttle
   taking effect. Test (R4 item 2): an enqueue racing a queue drain with many
   eligible waiters admits at most one part after the flag flips.
   Time-to-effect of the reduced cap (worst case: that one interleaved part
   plus the largest in-flight part's remaining transfer) is therefore bounded
   and is measured under G3. First-publish reality: small files finish their
   batches early and the big blob then gets the whole budget — the throttle
   costs nothing once the small lane is idle.

**Scheduler semantics (R1 item 3), specified, not implied:**

- **FIFO admission.** `globalPartBudget.acquire(bytes, signal)` enqueues waiters
  and admits in arrival order when enough budget frees — no reordering, so no
  waiter is starved by later arrivals.
- **Abortable waiters.** A waiter carries the part's `AbortController` signal; a
  first-error drain (§3.1) or a dead-MPU abort removes it from the queue and
  rejects its acquire, so aborted parts never hold or later grab budget.
- **Oversized part, head-of-line reservation.** If `partSizeFor` mints a part
  larger than `MULTIPART_INFLIGHT_BYTES` (multi-hundred-GB objects), the
  "admit-alone" rule alone could starve it behind an endless stream of small
  parts. Rule: once an oversized waiter reaches the FIFO head, **no new
  admissions occur until the budget fully drains and the oversized part is
  admitted alone** — bounded wait, no monopoly (it releases the whole budget on
  completion). Test: a part larger than the whole budget still uploads, and
  small parts queued behind it are admitted immediately after it completes.
- **Fairness tests (R1 item 3):** (a) one huge-part blob + many 8 MiB-part
  blobs; (b) many 8 MiB-part blobs + queued small-file batch work; (c) the
  oversized head-of-line case. Each asserts FIFO progress and the batch-busy throttle
  floor.

Placement: a module-level singleton in `src/cli/remote/multipart.ts` (process
scope, exactly like `downloadDisabledForProcess` in `blob-batch.ts:94-95`),
reading the live `BlobBatchUploader` queue depth for the throttle rule via a small
injected accessor (no cross-module coupling beyond a `batchLaneBusy(): boolean`
callback). One CLI push is one process — process scope is the correct boundary.

### 3.3 What does NOT change

The `complete` call and its retries:0 lost-ack recovery (`multipart.ts:133-168`);
the server upload endpoints (`multipartInit`/`multipartPart`/`multipartComplete`,
`blobs.ts:315-484`) — parts already arrive as independent, idempotently-handled
HTTP requests, so Phase 1 is a pure client change apart from §5 P0.2's
measurement add and §8's reaper; the on-disk resume token; the
quota/fence/mismatch classification. Verbatim.

## 4. Server completion pass — characterize, do not (yet) touch

Phase 1 changes no upload behavior on the server. But the audit predicts
"Parallel parts may simply expose finalization as the next pole"
(`audit:810-811`), so §5 P0.2 adds design-97-style numbers-only timing to
`multipartComplete` (measurement-only, no behavior delta). §7.3 decides — from
that measurement and only after verifying R2 capability — whether any
integrity-preserving mitigation is worth a follow-on, or whether the honest
answer is "accept and document."

## 5. Phase 0 — shipped measurement on the SERIAL baseline (falsification-first)

All of Phase 0 is measurement-only, behind `RBOX_METRICS`, no behavior change,
and instruments the **current serial path** — it establishes the baseline and
the part-vs-completion split that decide whether Phase 1 can reach the target.
It does NOT sweep parallel concurrency; that sweep needs a Phase-1 build and runs
as the §9 experimental harness (R1 item 14).

**HARD PRIVACY RULE (release gate): no raw file name, path, or blob content in
any emitted metric or log line.** Every number is a count, a byte total, or a
wall-millisecond — never an identifier. Matches the shipped discipline: the
preflight emits "count + missing ratio, never raw SHAs" (`blobs.ts:190`); design
97's `serverTimings` carries "No identifiers, paths, or hashes" (`design 97:76`).
The one permissible identifier is the already-logged short-SHA prefix on
integrity recovery (`blobs.ts:143`) — not extended here.

### P0.1 — client per-part + completion wall on the serial path (instrument to ADD)

Into the enabled phase report (`report.record("upload", …)`,
`sync-recovery.ts:390`), numbers only: per-part transfer wall (`Date.now()`
around each serial part PUT — p50/p95/max/sum); **completion wall** (the single
`complete` POST as the client sees it, which includes server-side cleanup since
cleanup runs before the response returns, §5 P0.2); per-part retry counts and
whole-blob re-inits. Quantization caveat (design-85): first measure metrics-on
vs -off part-sum (5 pairs); if overhead > ~5% treat per-part numbers as
directional — aggregate walls (part sum, completion) stay robust.

### P0.2 — server completion decomposition (design-97 pattern + control-flow, instrument to ADD)

Add a numbers-only object to `multipartComplete`, design-97 rules exactly
(`design 97:14-58`): fixed keys, non-negative integer ms, `Date.now()` only, no
added awaits. Control-flow, made precise per R1 item 8: the returned snapshot is
serialized inside the `try` **before** the `finally`, so it carries only work
that precedes cleanup:

```
returned on the complete response: { totalMs, assembleMs, rereadPutMs, accountingMs }
recorded on the metric only:       cleanupMs   (runs in finally, after serialization)
```

- `totalMs` — entry to just-before the `json()` that builds the response
  (design 97's "final serialization occurs after the returned snapshot");
- `assembleMs` — `mpu.complete(parts)` (`blobs.ts:439`);
- `rereadPutMs` — `get(staging)` + `put(canonical, {sha256})`, the whole-object
  verification reread (`blobs.ts:440-449`) — **the pole this design exposes**;
- `accountingMs` — `blobs` insert + `grantEntitlementWithQuota`
  (`blobs.ts:454-476`);
- `cleanupMs` — staging delete + `cleanupUpload` (`blobs.ts:479-483`), emitted
  only on the already-present `multipart.complete` `OpSpan` metric in `finally`
  (mirroring `op.done(outcome, { bytes, count })`, `blobs.ts:482`).

Because the client's completion wall (P0.1) DOES include cleanup (the HTTP
response is returned only after `finally`), client-vs-server reconciliation uses
`totalMs + cleanupMs` from the metric — the two decompositions are then
comparable (R1 item 8). Instrumentation is pure `Date.now()` reads and adds no
awaits, so it cannot alter cleanup or error semantics. Old-server compatibility,
per design 97 (`design 97:61-66`): the client accepts an absent object and
ignores a partial/negative one, degrading to "completion wall only." The existing
R2-vs-D1 span split (`op.span.r2`, `blobs.ts:415`) is preserved.

### P0.3 — orphan/state inventory on the serial path (instrument to ADD; feeds §8)

Enumerate and count, numbers only, the R2/D1 object states left by each failure
point around completion (feeds §8's reaper design and the correctness proof):
after a clean run; an interrupted-and-resumed run; a killed-mid-parts run; and —
critically — runs killed at each completion boundary: **after `mpu.complete`
before staging delete** (the completed-but-abandoned staging object, R1 item
4), **after the canonical `put` before the `blobs` insert**, and **after the
insert before the grant** (the canonical-orphan states, R2 item 5 / R3 item 4).
Count `uploads` rows, incomplete R2 MPUs, **completed `staging/` objects**, and
**row-less canonical objects** separately, so §8 can prove each class is healed
or reaped within its stated bound.

### Download-pole measurement (decides §6 only, not a shipped behavior)

On the Workload-D 2 GiB download, measure single-stream throughput vs the link's
measured capacity (a separate iperf-style or batch-GET-aggregate reference).
**Gate G-dl-pole:** open the design-102 follow-on ONLY if single-stream download
uses < 60% of demonstrated available download bandwidth on the 2 GiB blob (i.e.
single-stream is demonstrably the pole) across the audit's sample discipline.
Otherwise record "download is not the pole" and close §6. This gate decides
whether to START a design, nothing more.

### Gates out of Phase 0 (decide Phase 1)

- **G-baseline-split.** From P0.1+P0.2 on the 2 GiB incompressible blob at the
  serial baseline, report `partSumMs` vs `rereadPutMs`+`cleanupMs`. This sets the
  arithmetic ceiling for Phase 1: if completion already ≥ part transfer,
  end-to-end 2x (G1) is impossible by parts alone and §7.3's completion track is
  the only route to Finding 10's headline — reported as such, not redefined
  (R1 item 1).

## 6. Ranged parallel download — descoped, measurement outcome only

Not designed or shipped here (R1 items 9-11). Finding 10 recommends only
*separately testing* it (`audit:813-815`). The §5 download-pole measurement
(gate G-dl-pole) is the sole deliverable this document owns for download: if the
gate passes, open **design 102 (ranged parallel download)**, which must itself
resolve, at minimum, (a) server `Range` support on both GET paths
(`blobs.ts:292,308`; `worker.ts:242-254`) without touching the grant/entitlement
gate; (b) the sparse-temp + **ordered** whole-object hash verification the E2EE
path requires (out-of-order ranges cannot be hashed incrementally,
`blobs.ts:175-193`); (c) a byte-budget symmetric to §3.2 that respects the
48-slot batch-GET knee (`audit:1190`, `blob-batch.ts:27`) — intra-blob
parallelism, not more blob slots; and (d) **the revocation boundary** (R1 item
9): already-authorized concurrent range responses may continue after a grant is
revoked and collectively deliver bytes past the fence — design 102 must state and
test exactly how much is deliverable post-revocation and whether that widens the
current single-stream boundary. If G-dl-pole fails, this section is the record
that download was not the pole.

## 7. Correctness requirements and falsifiable gates

### 7.1 Correctness requirements (each maps to a test)

1. **Whole-object integrity unchanged.** The `complete` path still performs
   exactly one `put(canonicalKey, staged, {sha256})` verification
   (`blobs.ts:449`); a wrong-hash assembled object still yields 412 → client
   `BlobShaMismatchError` → re-scan + retry (`blobs.ts:450-452`,
   `multipart.ts:164`). Test: assemble a deliberately wrong-hash object under
   parallel parts; canonical is never written and the client re-scans.
2. **GCM / encSha verification unchanged.** Parts carry raw ciphertext; the blob
   address stays the ciphertext `encSha`; encryption/GCM live in the engine,
   untouched. Test: E2EE determinism suite (`audit:1301`) with parallel parts on.
3. **Resume via server-observed completed set (R1 items 5, 7).** After the §3.1
   drain, the next attempt's status GET (`multipart.ts:72-77`) is authoritative;
   the pool skips those numbers. Test: seed a subset, interrupt with j parts in
   flight, resume; assert the parts re-sent are exactly those the server reports
   missing **after all prior requests settle** — including a lost-ack part
   (server has it, client saw failure) which is NOT re-sent.
4. **No orphaned uploads beyond a bounded, reaped set (R1 item 4; bounds per
   R3 item 7).** Per §8: a killed parallel-parts upload leaves the same one MPU
   + one staging key a serial one leaves; every resulting state — incomplete
   MPU, completed staging object, stale D1 rows, row-less canonical object —
   is healed or reaped within the explicit per-class bound stated in §8. Test:
   P0.3 counts (including row-less canonical objects) reach zero within those
   bounds under the §8 reapers.
5. **Quota accounting unchanged.** Grant/charge happen once, at
   `multipartComplete`, on actual staged bytes (`blobs.ts:465`); the fail-fast
   over-cap check still runs at `multipartInit` before any part is staged
   (`blobs.ts:325-329`). Test: quota-fence + over-cap suites pass; a
   fence-tripping parallel upload returns 503 retry_later exactly as serial
   (`blobs.ts:457-459` → `multipart.ts:145-153`).

### 7.2 Falsifiable gates (Workload D `audit:1279-1293`; statistics `audit:1294-1301`)

**Phase 1 ships iff G-part AND G2 AND G3 all hold on the SAME configuration**
(one chosen `MULTIPART_PARTS_PER_BLOB` / `MULTIPART_INFLIGHT_BYTES` /
`…_WHEN_BATCH_BUSY` triple — no per-gate tuning; R2 items 1, 7). G1 is
immutable and reported truthfully; its failure is a failure, never a
redefinition (R1 item 1).

- **G1 (Finding 10's headline, immutable).** ≥ 2× reduction in **end-to-end
  transfer wall** for a 2 GiB incompressible blob on Workload D upload — the full
  `putBlobMultipart` span (part phase + completion), p50 over the audit's sample
  discipline, prior release as A/B control (`audit:1300`). **Finding 10 stays
  OPEN until G1 AND G2 pass** (R2 item 10): shipping Phase 1 on G-part alone is
  recorded as a scoped sub-result ("part-phase 2× achieved; end-to-end 2×
  blocked by the completion pass"), and the audit recommendation is marked
  partially achieved — never claimed met — until the §7.3 track closes the gap
  or is itself falsified.
- **G-part.** ≥ 2× reduction in the **part-phase wall** (first part start →
  last part ack) for the same blob — what parallelizing parts can actually move.
- **G2 — no resume regression (SHIP GATE; fault matrix and bounds predeclared,
  R3 item 2).** Fault classes, injected identically into serial (control) and
  parallel: **F1** lost part ack (server accepted, client saw failure); **F2**
  kill during an active part fetch; **F3** abort landing during retry backoff;
  **F4a** process kill with k ≥ 2 parts accepted and exactly **j = 1** in
  flight — the control-compatible kill (a serial control can never have more
  than one part in flight, so only j = 1 admits a like-for-like schedule; R4
  item 1); **F5** resume against a dead/expired MPU; **F6**
  completion-response loss. **Samples:** 10 runs per class per mode, identical
  schedules. **Acceptance bounds, all explicit:** (a) **success rate 100% in
  both modes** — any run whose resume fails to complete fails G2 outright
  (categorical, no statistics needed); (b) per class, resume completion wall
  p50 (parallel) ≤ 1.10 × p50 (serial); (c) per class, total retransmitted
  bytes p50 (parallel) ≤ 1.10 × p50 (serial); (d) re-init counts are sparse,
  so they are summed ACROSS the whole matrix: parallel's total ≤ serial's
  total. **F4b — parallel-only correctness/ceiling test (no serial comparison
  claimed):** process kill with k ≥ 2 accepted and **j ≥ 2** in flight, 10
  runs; asserts success-rate 100%, the max-in-flight retransmission ceiling
  below, and the §3.1 resume-set correctness — it feeds NO regression
  statistic, because no identical serial schedule exists. **Correctness ceiling (separate invariant
  test, not the acceptance criterion):** in every single run, ambiguous
  retransmission never exceeds the configured max in-flight
  (≤ `MULTIPART_PARTS_PER_BLOB` parts / `MULTIPART_INFLIGHT_BYTES`). Resume-set
  correctness is measured against the **server-observed completed set after all
  prior requests settle**; no "zero re-sends" claim (it conflicts with lost-ack
  reality).
- **G3 — small-file lane unharmed (redefined, R1 item 2; loop closed per R2
  items 7-8).** Under one mixed Workload-D publish (small-file corpus + a
  concurrent 2 GiB blob), compare **parallel multipart** vs the **current
  serial-large-upload control** (same mixed workload — NOT "no large blob
  present", impossible on a capacity-bound link). Two sub-workloads: (i) small
  files and the large blob start together (first-publish shape); (ii)
  **sustained-arrival**: small batches begin only after multipart reaches steady
  state, measuring the throttle's time-to-effect (which includes the ≤ one-part
  admission interleave, §3.2). **Statistics sized to be supportable (R3 item
  3):** a "run" of a candidate = the full preregistered sample set — 10 samples
  per sub-workload per mode (audit discipline, `audit:1296`) — and each sample's
  publish yields one per-batch queue-wait observation PER BATCH (hundreds to
  thousands per sample), so tail statistics are computed on the **pooled
  per-batch observations across the candidate's samples**, not on 10 numbers.
  Acceptance: small-file batch throughput p50 within 10%, per-batch latency p95
  within 20%, and **pooled per-batch queue-wait p99 within 2× of the
  serial-large control's pooled p99** (tail coverage, R2 item 8); max queue
  wait is reported (worst across samples) but not gated — a single-observation
  maximum is not a supportable gate statistic. **Large-blob liveness under the
  same gate (R4 item 4):** in the sustained-arrival sub-workload, the 2 GiB
  blob's completion wall (parallel, candidate cap) ≤ 1.10 × the serial-large
  mixed control's p50 — so a candidate cannot pass by giving the batch lane
  absolute priority while starving the blob. This binds the `0` candidate
  specifically: with cap 0, multipart admission depends on the batch lane
  draining between arrival bursts, and the liveness bound is what proves that
  eventual admission actually happens on the measured workload; a `0` candidate
  that starves the blob fails G3 and is recorded as such. **Predeclared, finite tuning (R2
  item 7):** the ONLY tunable is `MULTIPART_INFLIGHT_BYTES_WHEN_BATCH_BUSY`,
  over the preregistered candidate set `{32 MiB, 16 MiB, 8 MiB, 0}` (0 = no new
  admissions while batch work is queued, §3.2), one full sample set per
  candidate in that order, first passing candidate selected; G-part and G2 must
  then hold at that SAME candidate. **If no candidate passes all three gates,
  Phase 1 does not ship** — that is the recorded outcome, not a tuning restart.
  **The lane's own 24/48/64 defaults are never changed to pass this** (R1
  item 13).

### 7.3 Completion-mitigation decision (decoupled, integrity-first, R1 item 12)

Phase 1 ships on the §7.2 condition — **G-part AND G2 AND G3 on the same
configuration** — regardless of the completion cost (the same three-gate
condition everywhere; R3 item 1). The completion reread is a **separate
finding**:

- If `rereadPutMs`+`cleanupMs` is a small fraction of the now-parallel part
  wall: **accept, document, close** (`audit:810-811`).
- If it dominates (and thus blocks G1): this is an OPEN finding, not a promoted
  requirement. Before any mitigation is designed, **verify the platform
  capability first** — specifically whether the R2 binding can verify the
  assembled object's SHA-256 at `complete` time (whole-object checksum, or
  per-part checksums R2 itself validates against the exact assembled byte
  sequence) so the get→put reread is eliminated *without* publishing unverified
  bytes. Restated hard constraint: **no checksum composition is equivalent to
  verifying `encSha` unless R2 validates the exact assembled byte sequence.** If
  R2 cannot, the answer is "accept and document." No mitigation ships on
  assumption; the R2 question is §11 open-question 1 and gates its own follow-on.

## 8. Orphan / abort / GC — per-state inventory and an explicit reaper (R1 item 4)

Parallel parts share one MPU + one staging key per attempt (§3.1), so they add
no new orphan *class*. But the reviewer is right that the prior draft
over-asserted cleanup: **deleting the D1 `uploads` row does not abort the R2
MPU, and a *completed* staging object is not an incomplete MPU** — so the 7-day
incomplete-MPU lifecycle does not cover every state. Full inventory of what each
failure point leaves, and its reaper:

| Failure point | R2 object left | D1 left | Reaper / recovery |
|---|---|---|---|
| Killed before/among parts | incomplete MPU on `staging/<sha>/<uuid>` | `uploads` row | R2 abort-incomplete-MPU lifecycle at **7 days** (§8.1 rule A — retention deliberately UNCHANGED so resume within `UPLOAD_EXPIRY_MS` = 6d keeps working, R2 item 3); init-time sweep reaps the row (`blobs.ts:332`) |
| Part PUT vs a vanished MPU | none (R2 already dropped it) | stale `uploads` row | `cleanupUpload` on the 410 (`blobs.ts:386-400`); else init sweep |
| Worker dies **after `mpu.complete`, before `get(staging)`/canonical `put`** | **completed `staging/` object** | `uploads` row | §8.1 rule B (delete-objects, 24h). Client: `complete` response lost → `missingBlobs` says missing → outer recovery re-inits a FRESH MPU (old staging object is never adopted); safe because the completed staging object was deletable the moment its MPU was consumed — no resume path reads it (R2 item 3: rule B cannot break resume; only rule A could, and it is unchanged) |
| Worker dies **after verified canonical `put`, before `blobs` insert** (R2 item 5) | canonical object (R2-verified bytes at the correct address) + completed staging object | `uploads` row; NO `blobs`/accounting row | Canonical-orphan: primarily healed by client retry (blobsCheck reads it as missing — no `present=1`/entitlement row → the retry's canonical `put` **overwrite-adopts** byte-identical verified content and its complete performs insert + grant, healing accounting; the daemon's push pump retries deferred uploads on its next cycle). If the client never returns: reaped by the **§8.2 canonical-orphan audit** (bound: next audit run, eligibility ≥ 7d). Staging object: rule B (≤ 24h) |
| Worker dies **after `blobs` insert, before grant** | canonical + `blobs.present=1`; staging object | no entitlement for this account | Client account still sees "missing" (entitlement-gated check, `blobs.ts:119-193`) → re-uploads → retry's complete re-runs `INSERT OR IGNORE` (no-op) + grant, healing entitlement/quota. Staging: rule B |
| Worker dies **after grant, before response** | canonical published + granted; staging object | consistent | Client's existing lost-ack recovery: `missingBlobs` present-check succeeds (`multipart.ts:157-161`) → done. Staging: rule B; `uploads` row: init sweep |
| Fence 503 at accounting (handled response) | canonical verified; staging deleted in `finally` | consistent (deferred) | in-request `finally`; client defers (`multipart.ts:145-153`) |

**Explicit bounds per class (R3 item 7; deadlines per R4 item 3):** incomplete
MPU ≤ 7d (rule A); completed staging object ≤ 24h (rule B); stale
`uploads`/`upload_parts` rows — swept at the account's next `multipartInit`
(`blobs.ts:332`), else cleared by the scheduled §8.2 audit within ≤ 7d
(expiry) + 1d (cron) — inert D1 metadata meanwhile (no R2 cost, no accounting
effect); row-less canonical orphan — healed at the client's next retry
(typically the daemon's next push-pump cycle), else reaped end-to-end within
**≤ 10 days** (7d eligibility + ≤ 1d scheduled audit + ≤ 2d design-95 P2
quiescence/execution; §8.2). Every state is either healed by the client's existing recovery
(which always converges on "canonical verified + accounted" because parts,
canonical PUT, insert, and grant are all idempotent) or reaped by a named
reaper within its stated bound. No state requires adopting unverified bytes.

**§8.1 — staging reapers (two DISTINCT lifecycle actions, R2 items 3-4).**
Completed-object expiration and incomplete-MPU abortion are different R2
lifecycle actions with different resume consequences, so they are two rules,
not one:

- **Rule A — abort incomplete multipart uploads, `staging/` prefix, age 7
  days.** This matches R2's existing default posture and the code's assumption
  (`UPLOAD_EXPIRY_MS` = 6d client state expiry "before R2's 7-day MPU TTL",
  `blobs.ts:107`). Retention is deliberately NOT shortened: aborting a
  resumable MPU earlier than the client's 6-day expiry would force an offline
  client returning within the window to restart and retransmit every part — a
  resume regression the invariant forbids (R2 item 3). Rule A is
  belt-and-suspenders (make the assumed TTL explicit configuration), not a
  behavior change.
- **Rule B — delete objects, `staging/` prefix, age 24 hours.** Covers
  completed-but-abandoned staging objects (Worker death between `mpu.complete`
  and the `finally` delete), which the MPU rule cannot touch — a completed
  object is not an incomplete MPU. Safe for resume by construction: a staging
  object only becomes a completed object when its MPU is consumed, after which
  no client path can resume against it (the next attempt always re-inits a
  fresh MPU, `multipart.ts:41-50,82-101`); the healthy path deletes it within
  the same request. R2's delete-objects action does not touch in-progress MPU
  part data, so rule B cannot affect a resumable upload.

**Operational spec (R2 item 4):** rules are applied to BOTH buckets
(`rbox-dev-blobs` first per the dev-first rule, then the prod bucket) via the
R2 lifecycle configuration surface (dash or `wrangler r2 bucket lifecycle`);
ownership: founder (bucket config is dash/config-owned like the Workers Builds
pipeline); recorded in `docs/DEPLOYMENTS.md` on application; verification:
list the bucket's lifecycle rules post-apply AND run P0.3's
killed-after-complete probe on dev, confirming the staged object disappears
within the rule-B window while a 3-day-old *incomplete* MPU still resumes
(boundary tests on both sides of each configured age, R2 item 3); rollback:
delete the rules — the system returns to today's behavior (orphaned completed
staging objects persist, everything else unaffected). **The exact lifecycle
capability (per-prefix delete-objects + abort-MPU actions) must be confirmed
against the R2 configuration surface before this ships** — it is §11 open
question 2, and §8.1 is a correctness-prerequisite *proposal* until then.
**Fallbacks cover BOTH rules (R3 item 5):** if the surface lacks per-prefix
rules, rule A's fallback is R2's **bucket-wide default incomplete-MPU abort at
7 days** — the exact TTL the code already assumes (`blobs.ts:107`) —
verified by listing the bucket's lifecycle configuration and confirming the
default multipart-abort rule is present (it is bucket-wide, so per-prefix
support is not needed for A); rule B's fallback is a scheduled Worker cron
listing `staging/` and deleting objects older than 24h (same semantics,
code-owned). Only if BOTH the per-prefix surface AND the bucket-wide default
are absent does rule A also move into the cron (list in-progress `staging/`
MPUs, abort those older than 7d) — the prerequisite is met in every branch.

This is a **pre-existing gap this design surfaces, not one it introduces** —
the completed-staging orphan already exists on the serial path. Parallel parts
do not change its likelihood (same single staging key per attempt).

**§8.2 — canonical-orphan audit (small server addition; named reaper for the
row-less canonical class, R3 items 4, 7).** No collector exists today for a
canonical object with no `blobs` row (verified: the GC pipeline is D1-driven —
`gc-phase1.ts` marks from refs, design-95 P2 executes `gc_candidates` intents —
so an object invisible to D1 is invisible to GC; the `blobs.ts:66-67` "safe for
P2 to reap" comment covers only shas that acquire a candidate row). Addition:
an **admin-triggered audit** (behind the existing `RBOX_PLATFORM_SECRET` admin
surface, like the manual GC drain) that pages `list()` over the canonical blob
prefix, and for each key with **no `blobs` row** and an R2 `uploaded` timestamp
**older than 7 days** inserts a `gc_candidates` intent — after which design
95's existing P1/P2 machinery (quiescence, delete fence, activity-unwind if a
retry publishes meanwhile) deletes it with all its standing protections.
Eligibility proof: 7d > the client's 6-day upload-state expiry and any
daemon-pump retry cadence, so a live retry either already re-published
(insert restores the `blobs` row → key no longer matches) or is fenced/unwound
by P2's existing re-checks — the audit can never delete a blob an account still
legitimately holds, because such a blob has rows. The audit also deletes
`uploads`/`upload_parts` rows older than `UPLOAD_EXPIRY_MS` (the same sweep
`multipartInit` does, `blobs.ts:332`, for accounts that never multipart again).
**The audit is SCHEDULED, not operator-cadence (R4 item 3):** it runs from the
same daily Worker cron design 95's GC automation already owns ("daily cron
jitter", `docs/design/95-gc-purge-automation.md:104`); the admin-secret trigger
remains for tests and manual runs. The class bound is therefore explicit and
falsifiable: **eligibility (7d) + ≤ 1d scheduler interval + design-95 P2
quiescence/execution (≤ 2d) → a row-less canonical orphan is deleted within
10 days of its creation**, and stale `uploads`/`upload_parts` rows within 7d
(`UPLOAD_EXPIRY_MS` ≈ 6d) + 1d. A cron run that finds audit work overdue past
its bound emits the existing GC drain's overdue signal. Steady-state class
size is ≤ one object per crashed completion — P0.3 measures the actual rate,
and the automated test asserts counts reach zero within the stated bounds.

**GC isolation, unchanged.** `gc_candidates` condemns *canonical* blobs by
`sha256` (`blobs.ts:62,148,183`); `staging/` objects carry no `blobs`/`gc_
candidates` row until the completion `INSERT` publishes canonical
(`blobs.ts:455`). The completion fence check (`isDeleteFenceAbort` → 503,
`blobs.ts:456-460`) is the only GC interaction, untouched. A parallel-parts
upload can neither resurrect a condemned canonical blob nor strand a
`gc_candidates` row — staging is invisible to GC and reaped by §8.1.

## 9. Rollout and the concurrency sweep (R1 item 14)

1. **Phase 0 (shipped, measurement-only, behind `RBOX_METRICS`).** P0.1 (client
   serial-path per-part + completion wall), P0.2 (server `serverTimings` on
   `multipartComplete`, design-97 control-flow), P0.3 (orphan/state inventory).
   No behavior change. Ship, soak, collect Workload D on Wi-Fi and wired.
   Evaluate G-baseline-split and G-dl-pole.
2. **§8.1 staging reapers + §8.2 canonical-orphan audit (independent).**
   Confirm the R2 lifecycle capability (§11 Q2), apply rules A+B dev-first
   (fallbacks per §8.1), verify with the §8.1 boundary tests, record in
   DEPLOYMENTS; land the §8.2 admin audit beside the existing GC drain.
   Correctness prerequisites for the orphan invariant; not gated on Phase 1.
3. **Phase 1 concurrency sweep (experimental, NOT default).** The parallel-parts
   implementation lands behind `RBOX_MULTIPART_PARTS` **defaulting off**. The
   sweep over `MULTIPART_PARTS_PER_BLOB` / `MULTIPART_INFLIGHT_BYTES` runs with
   the flag ON as an experimental harness on the fleet (the behavior Phase 0
   could not sweep, R1 item 14); the busy-cap candidate walk is G3's
   preregistered set (§7.2). The knee sets the proposed default.
4. **Phase 1 ship.** Flip `RBOX_MULTIPART_PARTS` on by default **iff G-part AND
   G2 AND G3 hold on the same configuration** (§7.2); report G1 truthfully —
   **Finding 10 stays open until G1+G2 pass**, with Phase 1 recorded as a
   scoped sub-result if only the part-phase 2× is met. The serial loop remains
   the flag-off fallback — a regression is a one-env-var revert.
5. **Completion mitigation** only if §7.3 says it dominates AND the R2 capability
   (open-question 1) is confirmed; else documented as accepted cost.
6. **Design 102 (ranged download)** only if G-dl-pole passed.

Re-run corruption, quota, GC-fence, 409, churn, and E2EE-determinism suites at
each phase (`audit:1301`); keep the prior release as A/B control (`audit:1300`).

## 10. Out of scope / non-goals

1. **Chunk sync / sub-blob addressing / delta re-upload** (`audit:1198`). One
   immutable `encSha` per blob; a changed byte re-uploads the whole blob.
2. **Any direct-R2 path weakening whole-object integrity or revocation**
   (`audit:1197`). The completion `put(…, {sha256})` verification is sacrosanct;
   §7.3 is fenced to integrity-preserving options, and no checksum composition
   substitutes for R2 validating the exact assembled bytes.
3. **Re-proposing or retuning shipped work** (`audit:68-98`, R1 item 13):
   receipts, direct canonical writes, batch PUT/GET, the 24/48/64 slot defaults,
   compression, the qualifying-object threshold, the benchmark workload. No gate
   may be met by changing any of them; the only new knob is the multipart part
   budget.
4. **Ranged parallel download** — descoped to design 102, decided by G-dl-pole
   (§6). This document ships no download change.
5. **The first-publish encrypt→upload→receipt pipeline** (`audit:116`) — a
   separate workstream. This design assumes the ciphertext temp exists when
   `putBlobFile` is called and optimizes only its transfer.
6. **Small-blob transfer.** ≤ 90 MiB single-PUT and ≤ 256 KiB batched blobs are
   already optimized; multipart begins above the 90 MiB `SINGLE_PUT_MAX`
   (`blobs.ts:104,200`).

## 11. Open questions for the founder

1. **R2 whole-object checksum at multipart-complete (§7.3).** Does the R2
   binding let R2 verify the assembled object's SHA-256 at `complete` time
   (whole-object checksum, or per-part checksums R2 validates against the exact
   assembled byte sequence) so the completion get→put reread is eliminated
   *without* publishing unverified canonical bytes? Must be verified against
   R2's actual API before any completion mitigation is designed; if no, we accept
   and document the reread.
2. **Staging-prefix lifecycle rules (§8.1).** Confirm the R2 lifecycle surface
   supports per-prefix rules for BOTH actions — delete-objects (`staging/`,
   24h) and abort-incomplete-MPU (`staging/`, 7d) — and apply them dev-first on
   both blob buckets (dash/config-owned; wrangler `r2 bucket lifecycle` if
   scriptable). MPU retention must stay ≥ the client's 6-day resume window. If
   per-prefix rules are unsupported, approve the cron-Worker fallback instead.
   Closes a pre-existing completed-staging orphan gap independent of Phase 1.
3. **Default concurrency posture (§9).** Conservative (protect the small-file
   lane and shared Wi-Fi links) or aggressive (maximize the single-giant-blob
   case)? The §9 sweep gives a knee per link type; the founder picks which link
   type sets the shipped default.
4. **Is the single-giant-blob workload real for the fleet?** Parallel parts win
   most when the large bytes are in *one* blob (§1.2). If fleet large-blob
   publishes are already many-medium-blobs, the 64-wide lane may already saturate
   the link and G-part may fail — in which case the honest outcome is "already
   concurrent at the blob level," closing Finding 10's upload half. The §9 sweep
   shows this.
</content>
