# SPEC — Design 98 Tier 1: overlapped first-publish pipeline (flag-gated, default OFF)

Normative implementation spec. Source of truth: `docs/design/98-first-publish-pipeline.md`
(esp. §3.1–3.6, §6.1, §7) and `docs/design/REVIEW-98.md` (joint rounds J1–J3).
Seam contract: design 99 §10, embodied by `CiphertextLease`/`CiphertextLocation`
in `src/engine/crypto-pool.ts` (do NOT modify that file beyond consuming its
public seam).

## 0. Scope & gating

- **Flag:** `RBOX_PUBLISH_PIPELINE` (truthy: `1|true|yes|on`, case-insensitive,
  trimmed — mirror `fuseEnabled()`), DEFAULT OFF.
- **Flag OFF ⇒ byte-identical** to today's `encryptAndUpload`. No new module runs,
  no allocation, no behavior change. This is gate 7's flag-off byte-identity.
- **Tier 1 only:** file-backed leases through the EXISTING `api.putBlobFile`. No new
  upload API. Consumer MUST accept both `CiphertextLocation` variants: a `memory`
  lease is materialized to a temp via the existing temp flow (exactly as
  `materializeLease` does today in sync-recovery.ts) then `release()`d; a `file`
  lease is consumed by path.
- **Small-push guard:** when `toEncrypt.length < 64` (fixed threshold, gate 7), take
  the direct legacy path even if the flag is on — the pipeline's overhead is not
  worth it for tiny pushes and gate 7 requires within-noise wall.
- Do NOT touch: manifest encode/decode, `commits.ts` manifest surfaces
  (`commit`/`commitSigned`/`latest*`), `apps/api/src/workspace-sync.ts`. Reusing
  `redeemReceipts(ctx)` (a receipt surface, not a manifest surface) from the drainer
  is allowed. Threading a needsUpload channel through `sync.ts`'s `runPushAttempt`
  (flag-gated) is allowed.

## 1. Modules (new, under `src/cli/publish-pipeline/`)

1. `budget.ts` — `ResourceBudget` reservation primitive (disk axis, heap axis,
   items axis) with oversize admission.
2. `ready-queue.ts` — `ReadyQueue`: async producer/consumer channel of `ReadyBlob`,
   closeable, EOF-aware, backed by the budget axes.
3. `receipt-drainer.ts` — `ReceiptDrainer`: single-flight, generation-safe,
   error-latched, backlog-capped; owns the durable `needsUpload` accumulator.
4. `stale-temp.ts` — `reclaimStaleTemps` + `createRunTempDir`: mutex-swept
   reclamation and per-run temp dir creation.
5. `pipeline.ts` — `runPublishPipeline`: the producer-consumer orchestrator
   implementing §3.1 state machine, §3.5 abort, §3.6 EOF chain.

Modified:
- `src/cli/remote/blob-batch.ts` — `BlobBatchUploader.close()`, shared atomic
  `dispatchCount`, no-dispatch-after-close latch.
- `src/cli/sync-recovery.ts` — `encryptAndUpload` restructure (flag routing).
- `src/cli/sync.ts` — flag-gated needsUpload → `reupload` recovery threading.
- `src/engine/crypto.ts` — size-capped snapshot copy in `encryptFileToTempInline`.

## 2. `ResourceBudget` (budget.ts)

An axis is a reservation counter with a cap and a FIFO waiter queue.

```
class ResourceBudget {
  constructor(readonly cap: number)  // cap<=0 disables the axis (always admits)
  used: number; highWater: number
  // Reserve n. If it fits, or occupancy is ZERO (oversize admission — admit one
  // item/reservation even over cap to prevent single-oversize deadlock), reserve
  // and resolve immediately. Else block until space. Rejects if closed.
  async reserve(n: number): Promise<void>
  // Reconcile a reservation from `from` to `to` bytes (to<=from typical: snapshot+
  // worstCase -> actual cipher). Wakes waiters if it frees space.
  reconcile(from: number, to: number): void
  release(n: number): void        // wakes waiters
  close(err: Error): void          // reject all waiters; future reserve() rejects
}
```

Oversize rule (§3.2): `reserve(n)` admits when `used === 0` even if `n > cap` — this
covers the entire crypto working set so a single file whose snapshot+ciphertext
exceeds `maxTempDiskBytes` never deadlocks. `highWater` may then exceed cap by one
item (gate 4 accounts for it). FIFO waiter wakeups so no starvation.

Defaults (calibration outputs; env-overridable, NEVER silently defaulted in engine):
- `RBOX_PIPELINE_QUEUE_BYTES` → disk axis `maxTempDiskBytes` (default 256 MiB)
- `RBOX_PIPELINE_HEAP_BYTES` → heap axis `maxHeapBytes` (default 128 MiB)
- `RBOX_PIPELINE_ITEMS` → items axis `maxItems` (default 2048)
Read at call-time via a clamp helper. These are provisional pending §5.3
calibration; document that in a comment.

## 3. `ReadyBlob` and disposition protocol

```
type Disposition = "uploaded" | "satisfied-skip" | "duplicate-skip" | "abandoned"
type ReadyBlob = {
  file: FileEntry            // the scanned file entry (mutated with cipher descriptor)
  encSha: string
  cipherSize: number
  path: string               // file-backed temp path (memory leases pre-materialized)
  diskCharge: number         // bytes reserved on the disk axis for this temp
  release(d: Disposition): void
}
```

**Single-release rule (§3.2 item 3, §3.3 round-3 item 1):** a ReadyBlob's temp is
unlinked and its disk-axis charge released EXACTLY when its disposition settles:
- **uploaded** — `api.putBlobFile(...)` promise settles (resolve OR reject);
- **satisfied-skip** — the rolling check answered satisfied (putFile never called);
- **duplicate-skip** — a convergent peer of the same `encSha` already settled;
- **abandoned** — abort while queued/held (§3.5).

`release()` is idempotent (guard a boolean). It: (a) `lease.release()` if a live
lease is held (no-op for pipeline-materialized file temps); (b)
`fs.rm(path,{force:true}).catch(()=>{})`; (c) `disk.release(diskCharge)`. Temp
unlink MUST NOT happen before putFile settles — the uploader reads the path during
`encodeBatchBody`/single fallback (no-read-after-settle contract, §3.2).

## 4. `BlobBatchUploader` changes (blob-batch.ts)

### 4.1 Shared atomic dispatch counter (§3.5, gate 3b)
Module-level counter `dispatchCount`, incremented in the SAME synchronous step
immediately before a request body begins transmission, at EVERY transmit site: the
batch PUT (`dispatchBatch`, right before `ctx.fetch(.../blob-batch/put)`), the
single-PUT fallback (`gatedPutFile`, right before `putBlobFile` issues its PUT).
Provide `uploaderDispatchCount()` accessor + `resetUploaderDispatchCountForTests()`.
Gate every transmit site: `if (this.closed) { reject waiters / return; }` BEFORE
incrementing `dispatchCount` and starting the body.

### 4.2 `close(err)` (§3.5, round-2 item 2)
```
close(err: Error): Promise<void>   // idempotent, returns cached promise
```
- Set `this.closed = true`; cancel the coalescing flush `timer`.
- Reject every QUEUED not-yet-dispatched group's waiters with `err`
  (`this.queue` + `this.bySha`); clear the queue/queuedBytes.
- No fallback (`drainQueuedAsSingles`/`fallbackAll`) or batch/single dispatch starts
  after close: `dispatchFull`/`dispatchPartial`/`launch`/`dispatchBatch`/
  `dispatchSingleGroup`/`encodeBatchBody` early-return when `this.closed`.
- **Already-dispatched in-flight requests are AWAITED, not aborted.** Track active
  dispatch promises in a set (add in `launch`/single dispatch, remove on settle);
  `close()` awaits `Promise.allSettled(activeDispatches)`.
- Wire onto `RboxApi` + `SyncRemote` as OPTIONAL methods
  `closeUploader?(err): Promise<void>` and `uploaderDispatchCount?(): number` so the
  pipeline invokes via `?.` and simulators without them still work.

Flag-off: `close()` is never called; existing behavior untouched.

## 5. Producers — the encrypt lane (§3.1, §3.2, §3.6)

A CLOSEABLE dynamic work queue (NOT a static `poolMap` — §3.6 round-4 item 1) so the
rolling-check lane can enqueue re-encryption work late.

- **Input:** `toEncrypt` (scan-derived misses) enqueued up front. The rolling-check
  lane enqueues re-encrypt work for server-unsatisfied cache hits.
- **`outstanding` counter** covers every unit of unfinished pre-ready work:
  unclassified cache-hit addresses, enqueued-but-unfinished encrypts, in-flight
  classification batches. Producer EOF (close ReadyQueue for writing) is declared
  only when (a) scan-derived input exhausted, (b) cache-hit lane closed (every
  address classified), (c) `outstanding === 0`.
- **Per-file producer step** (mirrors current encrypt-phase body, sync-recovery.ts
  :248–297):
  1. `encryptCache.lookup(f.sha256)`. On hit → `classifyCacheHit(root,f)`:
     - `defer` → `deferred.add(f.path)`, dec outstanding, done.
     - `accept` → cache HIT: apply descriptor + record; send the ADDRESS to the
       rolling server-satisfied check WITHOUT a ready event (no ciphertext temp
       exists). Retain file↔address association. Satisfied → done; unsatisfied →
       transition to ENCRYPT (re-encrypt from source, emits ready).
  2. Cache miss (or unsatisfied hit): reserve disk
     `expectedSize + worstCaseCipher(expectedSize)` on the disk axis BEFORE
     dispatching the encrypt (`worstCaseCipher(n) = n + AES_GCM_OVERHEAD_BOUND`,
     e.g. `n + 4096`; compression only shrinks). Then encrypt:
     - pool present: `pool.encrypt(join(root,f.path), tmpDir, opts)` (file-backed
       EncryptedBlob). If a `memory` lease is ever delivered (future fused Tier-2),
       materialize to a temp under tmpDir + `lease.release()` immediately, exactly
       as `materializeLease`.
     - no pool: `encryptFileToTemp(join(root,f.path), kek, tmpDir, opts)`.
  3. On source-changed / ENOENT (`isDeferrableChurn`) → `deferred.add`, RELEASE the
     disk reservation, dec outstanding, done.
  4. On success: reconcile disk reservation down to `cipherSize`; record encrypt
     cache; set `ctSizeByEnc`; apply descriptor; `await queue.push(ReadyBlob)`
     (blocks under items/heap axis — backpressure; a blocked push stops this worker
     taking the next file). dec outstanding when the ready event is enqueued.
  5. A crypto-worker crash surfaces as a rejected encrypt → abort scope (§7).
- Concurrency: bounded worker pool over the dynamic queue, width
  `encryptConcurrency(pool?.workers.length)` (unchanged knob).

**Size-capped snapshot (crypto.ts, §3.2 round-4 item 2).** In
`encryptFileToTempInline`, replace `await fs.copyFile(srcPath, snapPath)` with a
bounded stream copy that reads at most `expected.size + 1` bytes WHEN
`opts.expected` is set: if the source yields more than `expected.size` bytes, abort
and throw `sourceChangedError(srcPath)` BEFORE writing past the reservation. Outcome
is byte-identical to today (a grown source already throws sourceChanged after the
full copy); only the transient disk high-water is bounded. When `opts.expected` is
unset, keep `fs.copyFile`. Preserve the existing snapshot cleanup/error paths.

## 6. Consumers — upload scheduler (§3.2)

Bounded worker pool (width `uploadConcurrency()`) pulling ready blobs, driving the
EXISTING `uploadFileWithRetry`-equivalent logic (reuse the current body's retry +
churn-defer semantics: BlobShaMismatch re-encrypt loop, BlobRetryLater→retryLater,
defer on exhaustion, per-file re-encrypt so a divergent duplicate never smears
another path's snapshot):

1. **Rolling server-satisfied check** replaces the global `missingBlobs` barrier.
   Ready addresses AND cache-hit addresses (no ready event) accumulate in a small
   coalescing buffer; flush at `ROLLING_CHECK_BATCH` (default 5000, ≤
   `MAX_SHAS_PER_CHECK`) or a short idle timeout, or immediately on queue EOF (§3.6
   step 3). One `api.missingBlobs(batch)`:
   - SATISFIED (not in `missing`) → skip PUT. Ready blob → **satisfied-skip**
     disposition (release temp+charge). Cache-hit address → mark file done.
   - UNSATISFIED (in `missing`) → ready blob: dispatch PUT. Cache-hit address:
     enqueue re-encrypt work on the encrypt lane (outstanding++ until ready).
   - **Compose with design 103 `RBOX_PREFLIGHT_DELTA`** (live in sync-recovery.ts):
     the rolling check is the delta-narrowed check issued in batches, replacing the
     single `api.missingBlobs(encShas)`. Preserve `recoverAddresses`/`forceFullAudit`
     semantics: `forceFullAudit` ⇒ rolling-sweep the full refset; delta ⇒ only
     introduced+recover addresses. The rolling check is a superset-safe replacement.
2. **Convergent dedup** — keep `uploaded`/`inflight` address sets. A ready blob whose
   `encSha` is already `uploaded` → **duplicate-skip**. Two consumers racing the same
   `encSha` may both PUT (content-addressed idempotent, unchanged).
3. **PUT** via `api.putBlobFile(encSha, path, size, uploadsDir, onBytes)`. Release
   the ReadyBlob under **uploaded** on settle (resolve OR reject). On BlobShaMismatch
   retry, re-encrypt a fresh temp (reserve+release its own bounded disk charge).
4. **Receipt backlog cap (§3.3).** Before dispatching a NEW PUT, if
   `ctx.receipts.size > RECEIPT_BACKLOG_MAX` pause dispatching until the drainer
   signals a drain completed. In-flight PUTs finish and capture normally.

Progress totals may grow: `UploadByteTracker.reviseTotal` already tolerates it.

## 7. Abort protocol (§3.5)

One shared `AbortController` (`scope`). Abort fires on: drainer error-latch
(402/auth/network), non-deferrable producer error (worker crash), consumer fatal
error, or SIGINT (add the listener only for the pipeline's lifetime; remove in
`finally`). Ordered:
1. Close ReadyQueue to new `push`; blocked producers wake, observe abort, stop
   taking files, release any disk reservation/temp they hold.
2. Consumers stop pulling.
3. `await api.closeUploader?.(abortErr)` — reject queued undispatched groups (their
   waiters settle → those ReadyBlobs release under **uploaded** as putFile rejects),
   cancel timers, no dispatch after close; in-flight requests awaited.
4. **Producer-termination barrier:** await every already-dispatched
   `pool.encrypt`/`encryptFileToTemp` settlement (no cooperative cancellation
   exists; add none). Only AFTER this barrier do temp unlink + `fs.rm(tmpDir)` run.
5. **Tier-2 abort bridge (joint-round item 4):** if a `pool.encryptStream` handle is
   active, invoke its `cancel()` then await 99's posted-job terminal barrier (the
   stream settles all refs). Settle already-held DELIVERED leases with the Tier-1
   split: queued/undispatched → **abandoned** immediately; already-dispatched
   in-flight → release at HTTP settlement. Do NOT reclaim producer-owned undelivered
   entries (99's authority). (Tier-1 default path uses single-file file-backed
   producers, so this branch is inert unless the fused seam is wired.)
6. Drainer stops kicking; `flush()` re-throws the latched error.
7. Every unsettled ReadyBlob temp unlinked; `fs.rm(tmpDir)` backstop.
8. Error propagates to `pushManifest` unchanged (402 → `QuotaExceeded`, etc.).

**Post-abort dispatch bound (gate 3b):** `uploaderDispatchCount()` delta after the
abort latch is set == 0. Objects that still LAND ≤ active batch slots + active
single-lane slots at abort time (record in the metric).

## 8. `ReceiptDrainer` (receipt-drainer.ts, §3.3)

Reuses `redeemReceipts(ctx)`. Surface:
```
class ReceiptDrainer {
  constructor(ctx, opts: { threshold; backlogMax; onError(err) })
  capture(): void       // after each receipt captured; no-op once latched;
                        // single-flight: if pending>=threshold and no drain active, kick.
  async flush(): Promise<{ needsUpload: string[] }>
  get error(): Error | undefined
  readonly backlogMax: number
  onDrainComplete(cb): void   // consumers wake from backlog pause
}
```
- **Single-flight + generation-safe:** ≤1 `redeemReceipts` in flight; on completion
  re-check `ctx.receipts.size >= threshold` → re-kick. `flush()` awaits the active
  generation THEN drains once more, looping until `ctx.receipts` empty or latched.
- **Error latch + terminal state:** the background redeem promise is OWNED (never
  floating); any rejection → latch → `onError(err)` (triggers shared abort). Once
  latched `capture` is a no-op and `flush()` re-throws the latched error.
- **Durable needsUpload accumulator (round-2 item 5 dedup):** accumulate 422
  `needsUpload` into a Set. Remove an entry ONLY when a replacement receipt for that
  address was successfully REDEEMED — NOT on capture. To know the redeemed set,
  extend `redeemReceipts`'s `ReceiptRedeemResult` with `settled?: string[]` (the
  shas deleted from `ctx.receipts` after a clean redeem) — additive, receipt-surface
  only, flag-neutral. Remove accumulated entries that appear in a drain's `settled`.
- **Backlog cap:** consumers pause NEW PUTs when `ctx.receipts.size > backlogMax`;
  fire `onDrainComplete` after each drain.
- **Race-safe delete preserved verbatim** (already in `redeemReceipts`).

Defaults: `RBOX_PIPELINE_REDEEM_THRESHOLD` (default 5000 = `RECEIPT_REDEEM_BATCH_MAX`),
`RECEIPT_BACKLOG_MAX` = `2 × threshold`.

## 9. EOF/drain barrier chain (§3.6) — normal completion
Ordered, each awaited before the next:
1. Producer EOF (§5) → close ReadyQueue for writing.
2. Queue drain: consumers observe EOF after draining every queued item to a settled
   disposition.
3. Final rolling-check flush: coalescing buffer flushes its final partial batch
   immediately on EOF (not timer-dependent).
4. Consumer settlement: all putFile promises settle; last receipt captured.
5. `drainer.flush()` → residual `needsUpload`; commit proceeds only when empty.

## 10. `encryptAndUpload` restructure (sync-recovery.ts)
- Keep the `address` phase (carry-forward) unchanged.
- `usePipeline = pipelineEnabled() && options.encryptFileToTemp === undefined &&
  toEncrypt.length >= PIPELINE_MIN_FILES (64)`.
- `!usePipeline` → run EXISTING `runCryptoAndUpload` verbatim (byte-identical).
- `usePipeline` → create run temp dir via `createRunTempDir(root)` (sweeps stale
  temps under the mutex, §11) INSTEAD of `os.tmpdir()/rbox-encup-`; run
  `runPublishPipeline(...)` which owns `withCryptoPool` + the drainer and returns
  `{ deferred, retryLater, needsUpload }`. Preserve the `finally` cache-prune +
  `fs.rm(tmpDir)`.
- Return type extends to `{ deferred; retryLater; needsUpload?: Set<string> }`
  (optional; legacy path leaves it undefined).

## 11. Stale-temp reclamation (stale-temp.ts, §6.1)
- Pipeline temps: `<root>/.rbox/state/tmp/enc-<pid>-<startMs>/` (pid DIAGNOSTIC only).
- `createRunTempDir(root)`:
  1. Under the design-93 workspace sync mutex (held by the push at push start),
     `reclaimStaleTemps(parent)`: remove EVERY pre-existing `enc-*` sibling dir under
     `<root>/.rbox/state/tmp/`. Process identity plays NO role — the only survivor is
     the dir THIS run creates AFTER the sweep. `fs.rm(dir,{recursive,force})`; ignore
     errors (non-fatal, logged).
  2. Create `enc-<pid>-<Date.now()>/` (mode 0700), return it.
- Safe: a stale dir holds only dead ciphertext. Best-effort even if the mutex is
  degraded/absent (documented).

## 12. `sync.ts` needsUpload threading (flag-gated)
When the pipeline returns a non-empty `needsUpload`, `runPushAttempt` treats it like
a commit 422 `unsatisfiedBlobs`: emit a `reupload` RecoveryAction
(`forceGitRecapture` as today, `localForRetry = currentLocal`,
`unsatisfiedBlobs = [...needsUpload]`), surfacing drainer-discarded 422 addresses to
the residue-recovery loop (`sync.ts:491+`). Flag off ⇒ needsUpload undefined/empty
⇒ no behavior change.

## 13. Metrics (§5.1) — OPTIONAL, privacy-gated
If time permits: `FirstPublishStats` via `report.recordDetails` under
`metricsEnabled()`, counts/bytes/durations ONLY. HARD PRIVACY: no path-shaped
(`/`) or 64-hex sha-shaped strings in any metric/log. Not required by the
correctness gates; do not block the PR on it.

## 14. Test obligations (mirror gates 3/3b/4/5/6/7/8)
Under `src/cli/publish-pipeline/*.test.ts` with a fake `SyncRemote` (in-memory blob
store + receipts + missingBlobs + artificial putBlobFile latency), a fake producer
for the memory-lease seam, and the real modules:
- **G3 interrupted-resume** (SIGINT + simulated hard-kill: drop receipts+temps): resume
  re-encrypts 0 for server-SATISFIED cache hits; re-uploads only the unsatisfied tail;
  re-encrypts only (unsatisfied ∪ post-last-flush); final charge == single-run
  (exact, byte-exact).
- **G3 repeated-kill temp reclamation** (≥3 kills then clean run): no cross-run temp
  accumulation; **PID-reuse simulation** (live unrelated process holding a stale dir's
  embedded pid) — dir still reclaimed.
- **G3b abort → zero post-latch dispatches:** `uploaderDispatchCount()` delta after
  abort == 0; all held leases released under the right disposition; landed ≤ recorded
  in-flight window. Exact counts.
- **G4 disk-axis bound under growing source:** snapshot capped at `expectedSize+1`;
  disk occupancy ≤ `maxTempDiskBytes` + one oversize item; single-object-over-cap
  admission.
- **G5 drainer:** 422 residue ⇒ `flush()` returns non-empty needsUpload ⇒ commit
  blocks on residue; 402 latch ⇒ abort + re-throw; backlog high-water ≤
  `RECEIPT_BACKLOG_MAX` + in-flight window.
- **Disposition correctness:** no-read-after-settle; satisfied-skip + duplicate-skip
  release temps; release() idempotent & single.
- **Backpressure/deadlock:** producers blocked on a full queue progress once consumers
  drain; a closed queue wakes blocked producers.
- **G6 integrity:** committed manifest + uploaded blob set identical to the serialized
  path on the same corpus. §6.5 mutation-after-ready: mutate a file after ready, before
  PUT; committed manifest references the SCANNED content.
- **G7 flag-off byte-identity:** flag off ⇒ byte-identical uploads/commit/receipts;
  small-push (<64) takes legacy path.
- **G8 privacy** (if metrics land): no path/sha-shaped strings in details+summary.

Acceptance each iteration: `bun test ./src/` and `bun x tsc --noEmit -p tsconfig.json`.
Tolerated host-only failures: same-SHA heal, shellStateOf, ctime flake.

## 15. A/B rig (rig/d98-t1, optional, pattern of rig/d99-p0)
Drive `encryptAndUpload` flag-on vs flag-off against an in-memory fake remote with
artificial upload latency; demonstrate overlap (wall < serialized sum). Report the
measured overlap factor. No prod side effects.
