# SPEC — Design 99 Phase 1: fused byte-bounded crypto worker jobs

Implementation spec for `codex exec`. Normative source: `docs/design/99-fused-crypto-worker-jobs.md`
(§4 budget/lease, §5.5 Phase-0 results incl. the dispatch-bound amendment, §6 build
seam, §7 correctness, §10 seam contract). This document is the concrete build plan;
where it and the design doc conflict, the design doc wins — flag it, don't silently
diverge.

Flag: **`RBOX_CRYPTO_FUSE`**, DEFAULT OFF. Flag-off path must be **byte-identical to
today** (the coalescer/budget code is never entered).

Acceptance (both must be green):
- `bun test ./src/`
- `bun x tsc --noEmit -p tsconfig.json`

Tolerated pre-existing host failures (do NOT try to fix): same-SHA metadata heal
(`sync.test.ts`), `shellStateOf` (`json-output.test.ts`), the ctime-granularity flake.

---

## 0. HARD RULES (E2EE determinism — non-negotiable)

1. **`encryptFileToTempInline` (`crypto.ts:182`) is the determinism ORACLE. Do NOT
   touch its body, its call graph, or reroute it.** The fused helper is a SEPARATE
   function validated byte-for-byte against it.
2. The fused helper MUST reuse the SAME crypto primitives already in `crypto.ts`:
   `deriveKeyNonce` (single HKDF over the freshly re-hashed payload sha), constant
   `AAD = "rbox/blob/v1"`, `ZSTD_LEVEL=3`, `COMPRESS_MIN_BYTES=128`,
   `COMPRESS_RATIO=0.95`, and the `body || getAuthTag()` layout. It must NOT
   reimplement them and must NOT use `zstdCompressSync` (Finding 3: sync zstd
   produces different frame bytes → address churn). Compression is **streaming zstd**
   over the in-memory buffer, byte-identical to the file path.
3. Differential tests MUST assert byte-identical `plaintextSha`, `payloadSha`,
   `encSha`, `cipherSize`, `comp`, AND raw ciphertext bytes vs the oracle, for every
   fixture including the Phase-0 boundary fixtures (empty; `COMPRESS_MIN_BYTES∓1`;
   the `COMPRESS_RATIO` keep/reject edge; the 64 KiB stream-chunk edges 65535/65536/
   65537; `FUSE_MAX_FILE_BYTES∓1`; compressible + incompressible). Reuse the fixture
   generators in `rig/d99-p0/determinism.ts`.
4. Encrypt-address-cache semantics unchanged (`classifyCacheHit` still runs
   per-file before dispatch; only cache misses are fused; the descriptor tuple is
   identical).
5. **No raw file names / paths in any metric or log field.** Correlate by content
   hash or opaque ordinal only.
6. No changes to the single-file oracle path, the batch-PUT wire format, receipts,
   dedup, or `apps/api/*`.

---

## 1. Constants (named, with the §5.5 rationale in comments)

Add to `crypto-pool.ts` (or a small shared module imported by pool + worker):

```ts
const FUSE_MAX_FILE_BYTES = 256 * 1024;          // §5.2 fuse eligibility (plaintext)
const FUSE_MAX_JOB_BYTES  = 4 * 1024 * 1024;     // §5.2 Σ plaintext per job (= BUFFERED_COMPRESS_MAX_BYTES)
const FUSE_MAX_JOB_FILES  = 512;                 // §5.2 per-job file cap
const CLONE_SLACK         = 64 * 1024;           // reservation slack (§4.1)
const JOB_RESERVE         = FUSE_MAX_JOB_BYTES + FUSE_MAX_JOB_FILES * 16 + CLONE_SLACK; // §4.1
const CIPHERTEXT_BUDGET_BYTES = 96 * 1024 * 1024; // §5.5 SELECTED — smallest zero-spill budget at full throughput
const SPILL_WATERMARK_FRAC = 0.75;               // §5.2 spill starts before the lane stalls
const FUSE_FLUSH_DELAY_MS  = 10;                 // §5.2 tail flush (matches uploader FLUSH_DELAY_MS)
const FUSE_PRIMED_FIRST_BYTES = 64 * 1024;       // §5.2 primed first batch — flush early/small
const FUSE_PRIMED_FIRST_FILES = 16;              // §5.2 primed first batch
const FUSE_MAX_ENCRYPT_RETRIES = 3;              // §6.3 per-file re-encrypt cap K=3

// Global fused-dispatch bound — Phase-0's key finding (§5.5 Finding 1): the encrypt
// lane scales NEGATIVELY with concurrent streaming-zstd jobs on measured hosts (16
// workers 5–6× slower than 4). Capping concurrent fused jobs at this bound recovers
// the full ~87% win at every budget ≥96 MiB. Env-tunable for the Phase-2 fleet sweep.
const FUSE_DISPATCH_BOUND_DEFAULT = 4;           // §5.5 measured optimum ~4–6
function fusedDispatchBound(): number { /* parse RBOX_CRYPTO_FUSE_DISPATCH, clamp ≥1, default 4 */ }
```

Env knobs (all optional, for the Phase-2 sweep; parsed like the existing
`parsePositiveIntEnv`): `RBOX_CRYPTO_FUSE` (on/off), `RBOX_CRYPTO_FUSE_DISPATCH`
(dispatch bound), `RBOX_CRYPTO_FUSE_BUDGET_BYTES` (budget override). Defaults reproduce
the §5.5 selected configuration.

---

## 2. Protocol — `crypto-worker-protocol.ts` (§6.1)

Add (do NOT change existing message/response types):

```ts
export type InMemoryEncryptedBlob = {
  plaintextSha: string;
  encSha: string;
  cipherSize: number;
  comp?: "zstd";
  payloadSha?: string;
  ciphertext: ArrayBuffer;   // ALWAYS in the postMessage transfer list (§7.2)
};

export type FusedJobEntry = {
  index: number;
  srcPath: string;
  expected: { sha256: string; size: number };   // MANDATORY (§6.1, Round-2 item 7)
  opts?: Omit<EncryptFileOptions, "expected">;
};

export type CryptoWorkerEncryptBatchMessage = {
  id: number;
  kind: "encryptBatch";
  jobs: FusedJobEntry[];
  jobPlaintextCap: number;   // = FUSE_MAX_JOB_BYTES; worker enforces the aggregate
};

export type FusedResult =
  | { index: number; ok: true; blob: InMemoryEncryptedBlob }
  | { index: number; ok: false; error: SerializedError }   // allowlisted per-file (§7.4)
  | { index: number; ok: false; requeue: true };           // aggregate overflow (§6.1)

export type CryptoWorkerEncryptBatchResult = { id: number; ok: true; results: FusedResult[] };
```

Extend `CryptoWorkerJobMessage` union with `CryptoWorkerEncryptBatchMessage`. The
worker posts `CryptoWorkerEncryptBatchResult` as `{ id, ok:true, result: {...} }`
via the existing response envelope OR a dedicated response — pick one; the pool must
route batch responses to the batch handler by matching the in-flight job kind.

---

## 3. Worker — `crypto.ts` helper + `crypto-worker.ts` branch (§4, §6.2)

### 3.1 `encryptBytesInMemory` in `crypto.ts` (new, exported, separate from the oracle)

```ts
export async function encryptBytesInMemory(
  src: Buffer, kek: Buffer, opts: EncryptFileOptions
): Promise<{ plaintextSha; encSha; cipherSize; comp?; payloadSha?; ciphertext: ArrayBuffer }>
```

Steps (§4 steps 2–5), reusing existing `crypto.ts` internals:
1. `plaintextSha = hashBytes(src)`. **`opts.expected` is mandatory here for the fused
   caller**: if `plaintextSha !== expected.sha256 || src.length !== expected.size` →
   throw `sourceChangedError` (reuse the existing helper; it survives serialization).
   (Per-file eligibility revalidation from the bytes actually read — §4 step 1.)
2. Compress iff `opts.compress && src.length >= COMPRESS_MIN_BYTES`: stream `src`
   through `createZstdCompressLevel3()` collecting chunks (add a
   `zstdCompressBufferToBuffer(src)` helper mirroring `zstdCompressFileToBuffer` but
   sourced from `Readable.from([src])` — MUST be byte-identical to the file variant;
   the boundary differential test is the guard). Keep iff
   `compressed.length < src.length * COMPRESS_RATIO`; then `payloadSha =
   hashBytes(compressed); comp = "zstd"`.
3. `deriveKeyNonce(kek, payloadSha)` → AES-256-GCM over the payload buffer →
   `ct = Buffer.concat([cipher.update(payload), cipher.final()==noop, cipher.getAuthTag()])`
   (same layout as `encryptBufferToFile`). Use `setAAD(AAD)`.
4. `encSha = hashBytes(ct)`, `cipherSize = ct.length`, `ciphertext =`
   a **freshly-owned, non-aliased** `ArrayBuffer` sliced from `ct`
   (`ct.buffer.slice(ct.byteOffset, ct.byteOffset+ct.byteLength)`), so each result is
   a distinct backing buffer (§6.1 validation (d)).

This function is NOT wired into `encryptFileToTemp`/`encryptFileToTempInline`; it is
only called by the worker's batch branch and the differential test.

### 3.2 `crypto-worker.ts` — new `encryptBatch` branch (§6.2)

Add a branch alongside `encrypt`/`decrypt`. Loop `jobs` **serially**, tracking
`usedPlaintext`:
```
for (const job of jobs):
  read src = await fs.readFile(job.srcPath)                 // one source read, no snapshot temp
  if (usedPlaintext + src.length > jobPlaintextCap):
      results.push({ index, ok:false, requeue:true }); continue   // aggregate overflow → requeue (§6.1)
  usedPlaintext += src.length
  try:
      blob = await encryptBytesInMemory(src, kek, { ...job.opts, expected: job.expected, compress: job.opts?.compress ?? ... })
      results.push({ index, ok:true, blob })
      transfers.push(blob.ciphertext)
  catch (err):
      if isAllowlisted(err): results.push({ index, ok:false, error: serializeError(err) })   // §7.4
      else: throw err        // crash-class → abort whole envelope (pool split-retries)
postMessage({ id, ok:true, result:{ results } }, transfers)   // MANDATORY transfer list
```
- Allowlist (§7.4): `isSourceChangedError(err)` OR fs churn codes
  (`ENOENT`/`EACCES`/`ENOTDIR`/…, matching `sync-recovery.ts` `isDeferrableChurn`
  classification). Everything else (programmer error, OOM, unexpected) rethrows to
  abort the envelope → the pool treats a thrown/absent envelope as crash-class.
- If `postMessage` with a transfer list is unsupported at runtime, post a
  `{ id, ok:false, error:{...transfer-unsupported...} }` sentinel so the pool disables
  fusion and falls back to the oracle path (design §4.1 "no transfer support disables
  fusion"). Do not silently clone.
- Reuse the existing `serializeError`. `kek`/`TEST_DELAY_MS` handling unchanged.

---

## 4. Pool — coalescer, budget, lease, split-retry (`crypto-pool.ts`) (§4.1, §6.3, §7)

All new machinery lives on `CryptoPool` and is **only reachable through the new
`encryptCoalesced`/`encryptStream` methods** — the existing `encrypt`/`decrypt`/
dispatch/queue/crash machinery is untouched and continues to serve per-file jobs.

### 4.1 `CiphertextLocation` / `CiphertextLease` (§10 — the NORMATIVE seam type)

```ts
export type CiphertextLocation =
  | { kind: "memory"; bytes: Uint8Array }   // fused, budget-held
  | { kind: "file"; path: string };         // oversize (oracle temp) or spilled temp

export interface CiphertextLease {
  readonly encSha: string;
  readonly size: number;                     // cipherSize
  readonly location: CiphertextLocation;
  /** Call exactly once after taking ownership (HTTP settlement / reject / dedup /
   *  abandon). Frees the §4.1 budget charge for the `memory` variant; no-op for
   *  `file`. Idempotent guard: 2nd call THROWS in dev, is IGNORED in prod
   *  (gate on `process.env.NODE_ENV === "production"` OR a `RBOX_ENV` check — use
   *  the same convention the repo already uses; if none, throw unless
   *  `process.env.NODE_ENV === "production"`). */
  release(): void;
}
```

The legacy consumer needs the full descriptor, so the resolved value is a superset:
```ts
export type CoalescedBlob = {
  plaintextSha: string; encSha: string; cipherSize: number;
  comp?: "zstd"; payloadSha?: string;
  lease: CiphertextLease;
};
```
`CiphertextLease` (location + release + encSha + size) is the single shared seam type
design 98 consumes; `CoalescedBlob` merely bundles it with the manifest descriptor
for the producer's own callers.

### 4.2 `CiphertextBudget` (byte-semaphore, §4.1)

A single instance per pool, `CIPHERTEXT_BUDGET_BYTES` (or the env override):
```
class CiphertextBudget {
  used = 0; highWater = 0; waiters: (()=>void)[] = []
  tryReserve(n): boolean            // if used+n <= cap: used+=n; track highWater; true. else false
  async reserveJob(): Promise<void> // block until tryReserve(JOB_RESERVE); spill hook checked by caller (§4.4)
  convert(reserved=JOB_RESERVE, exactCharges: number[])  // atomic: used -= (reserved - Σexact); wake waiters; track highWater
  charge(n)                         // used += n (only used inside convert accounting)
  release(n)                        // used -= n; wake all waiters
  wake()                            // resolve+clear waiters
}
```
`highWater` is the instrumented budget high-water for gate 3. Expose a read-only
getter + a per-pool spilled-bytes/spilled-files counter (all opaque numbers).

### 4.3 The coalescer (§6.3)

State on the pool (created lazily on first `encryptCoalesced`/`encryptStream`):
- `openGroup: PendingFile[]`, `openBytes: number`, a flush timer, a monotonically
  increasing `groupsFlushed` count (to detect "first group" for the primed batch),
  and a spill tmpdir (lazily `mkdtemp` mode 0700, cleaned on pool close).
- A `PendingFile` carries `{ srcPath, size, opts, expected, attempts, deliver(result|error) }`.

`encryptCoalesced(srcPath, size, tmpDir, opts)`:
```
if size > FUSE_MAX_FILE_BYTES:
    // large/streaming stays on the UNCHANGED single-file oracle path (§3, §9)
    blob = await this.encrypt(srcPath, tmpDir, opts)     // existing per-file job → ciphertextPath
    return coalescedBlobFromFile(blob)                    // lease {kind:"file", path: blob.ciphertextPath}, release()=no-op
else:
    return new Promise(resolve/reject =>
        push PendingFile into openGroup; openBytes += size
        maybeFlush()   // flush on FUSE_MAX_JOB_BYTES / FUSE_MAX_JOB_FILES / primed-first / arm timer
    )
```
`maybeFlush()`:
- flush NOW if `openGroup.length >= FUSE_MAX_JOB_FILES` OR
  `openBytes + nextFile.size > FUSE_MAX_JOB_BYTES` (flush before adding the file
  that would overflow — mirror `arm-b.ts`), OR (first group only)
  `openBytes >= FUSE_PRIMED_FIRST_BYTES || openGroup.length >= FUSE_PRIMED_FIRST_FILES`.
- else (arm|reset) a `FUSE_FLUSH_DELAY_MS` timer whose callback flushes the partial
  group. Also flush on pool `close()`/`drain`.
- flushing moves `openGroup` into a `FusedJob` and schedules dispatch (§4.4).

Note on group-filling: the legacy caller (`poolMap` in sync-recovery, §5) runs at
**high concurrency when fused** so many `encryptCoalesced` calls are pending at once
and groups fill toward 512. Backpressure is the budget (`reserveJob` blocks dispatch)
and the dispatch bound — NOT the caller's concurrency width.

### 4.4 Dispatch policy + budget reservation (§4.1, §5.5 Finding 1)

A `FusedJob` = `{ id, files: PendingFile[], plaintextCap }`. A global queue of
flushed-but-not-yet-dispatched `FusedJob`s. A dispatch pump:
```
async dispatchFused():
  while queue not empty AND fusedInFlight < fusedDispatchBound() AND a worker slot is free:
      job = queue[0]
      await budget.reserveJob()          // BLOCKS until JOB_RESERVE granted (may trigger spill, §4.5)
      queue.shift()
      fusedInFlight++
      post the encryptBatch message to a worker slot (reuse the existing slot/inFlight
          machinery: the fused job occupies one of the worker's MAX_IN_FLIGHT_PER_WORKER
          slots; keep fused-in-flight-per-worker at 1 by only posting a fused job to a
          worker that has no other fused job — §5.2 "fused in flight / worker = 1")
```
- `fusedDispatchBound()` bounds concurrent fused jobs across ALL workers (the global
  bound from §5.5). Per-file `encrypt`/`decrypt` jobs are unaffected and may use the
  other worker slot.
- On worker slot free / job completion / budget release / new flush → re-run
  `dispatchFused()`.

### 4.5 Receipt handling — validation → charge conversion → delivery (§6.1, §4.1)

On a fused-job response for job `J` (before doing anything else):
1. **Validate the envelope (§6.1, crash-class on any failure):**
   (a) exactly one result per requested index; indices unique + within `J`'s set;
   (b) each `ok` result: `blob.ciphertext.byteLength === blob.cipherSize`;
   (c) `Σ ok.cipherSize ≤ JOB_RESERVE`;
   (d) all result `ArrayBuffer`s are distinct (non-aliased) — track by identity.
   Any violation → **discard every transferred buffer of `J`** (drop refs), then
   **release `J`'s `JOB_RESERVE`** (single release), then run split-retry on `J`'s
   unresolved files (§4.6). Never cross-resolve.
2. **Charge conversion (atomic, §4.1):** `budget.convert(JOB_RESERVE, [cipherSize…])`
   replaces the one `JOB_RESERVE` with N exact per-file charges (= each `cipherSize`)
   and releases the slack in one critical section.
3. For each result:
   - `ok` → build a `CiphertextLease` `{kind:"memory", bytes: new Uint8Array(blob.ciphertext)}`
     holding exactly `cipherSize` of budget; deliver `CoalescedBlob` to its
     `PendingFile.deliver` (resolve the promise / push to onReady). Delivery makes it
     **consumer-owned** (§4.7).
   - `requeue` → re-coalesce that file as a fresh single-file group (or, if it now
     exceeds `FUSE_MAX_FILE_BYTES`, route to the oracle single-file path). No charge
     was ever taken for it. Not a failure.
   - `error` (allowlisted) → reject/settle that file alone with the rehydrated error
     (the caller classifies churn-vs-fatal exactly as today). No charge.
4. `fusedInFlight--`; re-run `dispatchFused()`.

### 4.6 Split-on-crash retry (§6.3, §7.4) — crash-class ONLY

Trigger: worker crash affecting a fused job, OR a malformed/incomplete envelope
(§4.5 step 1 failure). NOT triggered by cancel/close (§4.8).
```
onFusedCrash(job J):
  0. discard every already-transferred buffer of J (drop refs; no charge conversion happened)
  1. release J's JOB_RESERVE  (the SAME single release; not two — Round-2 item 3)
  2. partition J's still-unresolved files into two halves
  3. each half → a NEW FusedJob enqueued for dispatch (makes its OWN JOB_RESERVE via
     the normal blocking reserve → no reacquisition deadlock, capacity was freed in step 1)
  4. each file's attempt counter increments per re-encrypt; a file reaching
     FUSE_MAX_ENCRYPT_RETRIES (K=3) is failed as a per-file error (§7.4), never retried
  5. recursion bottoms out at singleton jobs → a deterministic poison isolates to one
     file after K attempts; its ≤511 siblings already succeeded on sibling halves.
     Split depth ≤ ⌈log2(512)⌉ = 9; re-encrypts per file ≤ K.
```
Ordering is strict: **discard buffers → release reserve → children re-reserve**, so
live retry bytes are never uncharged and capacity is never reused while old bytes are
still referenced.

### 4.7 Spill (§4.2) — producer-only, above the watermark

`reserveJob()` cannot grant `JOB_RESERVE` and `budget.used > SPILL_WATERMARK_FRAC *
cap`: the pool attempts to spill **one producer-owned, undelivered** memory result:
```
spillOldest():
  victim = oldest received-but-not-yet-delivered memory result   // NEVER a delivered/consumer-owned lease
  if none: return false                                          // dispatch stays blocked until a consumer release()
  write victim.ciphertext to a temp file in the spill tmpdir (owner-only)
  flip its pending lease location to { kind:"file", path }
  release victim's per-file charge (budget.release(cipherSize))
  bump spilledBytes/spilledFiles counters
  return true
```
- A spill **write failure** settles only that file as a retry-later deferral (§7.4)
  and releases its bytes; siblings unaffected.
- After spill, the file's lease delivers file-backed; its `release()` is a no-op that
  still lets the owner delete the spilled temp once uploaded.
- Spill only ever touches results the producer still holds (received, not yet handed
  to `deliver`). Once delivered → consumer-owned → MUST NOT spill (§4.2, Round-4 item
  1): an in-flight HTTP PUT may reference those exact bytes.

In the shipped legacy consumer (§5), delivery is immediate on receipt, so spill is
essentially never exercised in production; it exists for the streaming/back-pressured
consumer (design 98) and for correctness under a lagging consumer. It is unit-tested
via `encryptStream` with a paused consumer + tiny budget (§6).

### 4.8 Cancel / close — NOT crash-class (§7.4, §6.4)

`encryptStream(...).cancel()` and pool `close()` do NOT enter split-retry and create
NO children. They terminally settle every unresolved **producer-owned** entry (reject
with the cancel error / existing `RBOX_CRYPTO_POOL_CLOSED`) and stop. Consumer-owned
in-flight leases are untouched and settle via their own `release()`.

**Posted-job `JOB_RESERVE` retention (§7.4 Round-5 item 1) — the one subtle rule:**
- **Undispatched** group (still in coalescer/queue) → release `JOB_RESERVE`
  immediately (no bytes exist yet; for an undispatched group nothing was reserved
  until dispatch, so this is simply "don't reserve / drop the queued job").
- **Posted / in-flight** at a worker → retain its `JOB_RESERVE` until EITHER its
  terminal result is received-and-discarded (buffers dropped) OR the worker is
  terminated with **confirmed** termination — whichever first. Only then release.
  Since `close()` terminates all workers (`terminateIntentional`), confirmed
  termination is the release trigger there. This closes the late-result
  uncharged-bytes leak.

### 4.9 `encryptStream` (§6.4, §10) — the design-98 seam (built, unit-tested; NOT wired to prod)

```ts
encryptStream<T>(
  items: { ref: T; srcPath: string; size: number; opts: EncryptFileOptions }[],
  handlers: { onReady: (ref: T, blob: CoalescedBlob) => void | Promise<void> }
): { cancel(): void }
```
- Feeds all `items` through the SAME coalescer + budget + dispatch pump as
  `encryptCoalesced`. `onReady(ref, blob)` fires **per file at fused-job completion,
  in completion order** (not after the batch). If `onReady` returns a promise, the
  result stays producer-owned until it settles (this is the backpressure surface that
  lets spill engage under a slow consumer).
- `cancel()` reclaims ONLY undispatched, producer-owned charges (§4.8); posted/
  in-flight jobs retain reserve per §4.8; already-delivered leases stay consumer-owned.
- The Phase-1 production consumer is the legacy `encryptCoalesced` path (§5). This PR
  ships `encryptStream` as the seam + its tests; design 98 wires the overlapping
  consumer later.

---

## 5. Caller integration — `sync-recovery.ts` (§6.4, flag-gated)

The ONLY production call-site change. Preserve the entire downstream flow (`ctByEnc`,
`ctSizeByEnc`, cache record, missing-check, upload phase, retry loop) unchanged.

1. Thread the `pool` object into `runCryptoAndUpload` (currently only `poolWorkers:
   number` is passed). Change the call at `:436` to pass `pool` so the encrypt loop
   can reach `pool.encryptCoalesced`. When `options.encryptFileToTemp` is injected
   (tests) OR no pool OR flag off → `pool` is effectively unused and the existing
   `encryptFileToTemp` path runs (byte-identical).

2. Compute `const fuse = pool !== undefined && process.env.RBOX_CRYPTO_FUSE ... truthy
   && options.encryptFileToTemp === undefined;`

3. Encrypt concurrency: when `fuse`, raise the `poolMap` width so the coalescer can
   fill groups: `const encConc = fuse ? Math.min(toEncrypt.length, FUSED_ENCRYPT_CONCURRENCY_CAP)
   : encryptConcurrency(poolWorkers);` with `FUSED_ENCRYPT_CONCURRENCY_CAP = 2048`
   (comment: real backpressure is the budget + dispatch bound, not this width).

4. Inside the existing `poolMap(toEncrypt, encConc, async (f) => {...})` callback,
   the cache-hit / defer branches are UNCHANGED. Replace ONLY the cache-miss encrypt
   call (`:236–253`) with a helper that yields an `EncryptedBlob`-shaped object with a
   `ciphertextPath`, so the rest of the callback (`applyCipherDescriptor`, `ctByEnc.set`,
   `ctSizeByEnc.set`, `encryptCache.record`, `encCtBytes`) is byte-for-byte the same:
   ```
   let e: EncryptedBlob;
   try {
     if (fuse) {
       const cb = await pool.encryptCoalesced(path.join(root, f.path), f.size, tmpDir,
                    { ...encryptOpts, expected: { sha256: f.sha256, size: f.size } });
       e = await materializeLease(cb, tmpDir);   // §5.1
     } else {
       e = await encryptFileToTemp(path.join(root, f.path), kek, tmpDir,
                    { ...encryptOpts, expected: { sha256: f.sha256, size: f.size } });
     }
   } catch (err) { /* isDeferrableChurn → defer; else throw — UNCHANGED */ }
   ```
5. `uploadFileWithRetry`'s re-encrypt path (`:335`) stays on the UNCHANGED
   `encryptFileToTemp` (oracle single-file) — it is a rare retry that needs a
   `ciphertextPath` and must not depend on the coalescer. Do not touch it.

### 5.1 `materializeLease(cb: CoalescedBlob, tmpDir): Promise<EncryptedBlob>`

The Phase-1 upload sink adapter (no new upload API — parent directive; Tier-2 zero-copy
upload stays with design 98):
```
if cb.lease.location.kind === "file":
    ct = cb.lease.location.path        // oversize oracle temp or spilled temp
    cb.lease.release()                 // no-op for file variant
else: // memory
    ct = path.join(tmpDir, `${cb.plaintextSha}.${randomBytes(8).hex}.ct`)
    await fs.writeFile(ct, cb.lease.location.bytes)   // materialize to the existing encup temp flow
    cb.lease.release()                 // frees the memory budget charge immediately
return { plaintextSha: cb.plaintextSha, encSha: cb.encSha, ciphertextPath: ct,
         cipherSize: cb.cipherSize, comp: cb.comp, payloadSha: cb.payloadSha }
```
The materialized/oracle/spilled ct temps live in `tmpDir` and are cleaned by the
existing `fs.rm(tmpDir, {recursive:true})` in the `finally` (`:448`) — identical
lifecycle to today's oracle temps. Uploads go through the UNCHANGED
`api.putBlobFile`. Because the memory variant is materialized-and-released on receipt,
budget residence is short and spill is not exercised on this path.

**Result: flag-on ships the fusion encrypt win (few worker messages, in-memory
encrypt+hash, global dispatch bound) while the upload path and ciphertext-temp
lifecycle stay exactly as today. Tier-2 activation (by-reference PUT, gate-4 zero-copy)
is design 98's, per the parent scope.**

---

## 6. Required tests (`bun test ./src/`)

Add focused test files (mirror the `crypto-pool.test.ts` harness: `RBOX_CRYPTO_WORKERS`,
`RBOX_CRYPTO_POOL_MIN_JOBS=1`, `__cryptoPoolTestHooks.reset()`).

1. **Differential determinism** (`src/engine/crypto-fused.test.ts` or extend
   `crypto.test.ts`): for the full boundary/property matrix (lift generators from
   `rig/d99-p0/determinism.ts`: sizes `[0,127,128,129,255,512,2048,8192,65535,65536,
   65537,131072,200001,262143,262144,262145]` × {compressible, incompressible} + the
   `COMPRESS_RATIO` ratio-edge fixtures), assert `encryptBytesInMemory` and
   `encryptFileToTempInline` produce byte-identical `plaintextSha`/`payloadSha`/
   `encSha`/`cipherSize`/`comp`/ciphertext. Also drive the SAME fixtures end-to-end
   through `pool.encryptCoalesced` (fused, small) and assert identity vs the oracle.
2. **Fused-job failure isolation** (`crypto-pool.test.ts` additions): a group where
   one file is poisoned (e.g. deleted between coalesce and read → churn error, OR a
   worker that deterministically throws crash-class on one input via a test hook) →
   the other files succeed; the poisoned file fails ALONE after split-retry to a
   singleton and K=3. Assert siblings' ciphertext is correct and delivered.
3. **Budget accounting** under: normal completion (charge conversion releases slack;
   high-water ≤ budget); worker crash before receipt (single `JOB_RESERVE` released,
   no per-file charge leak, no double-release); pool `close()` with a posted job
   (reserve retained until confirmed termination, then released — assert `budget.used`
   returns to 0 and no negative). Mirror the design §7 cleanup-matrix rows. Use the
   budget getters (`used`, `highWater`, spilled counters) for assertions.
4. **Spill path**: `encryptStream` with a paused/slow `onReady` + a tiny
   `RBOX_CRYPTO_FUSE_BUDGET_BYTES` (one `JOB_RESERVE`+ε) → assert spill fires
   (spilledFiles > 0), the spilled file's lease is `{kind:"file"}`, and its ciphertext
   round-trips byte-identical to the oracle. Assert a delivered/consumer-owned lease is
   never spilled.
5. **Idempotent release guard**: second `release()` throws (dev) / is ignored (prod);
   memory budget freed exactly once.
6. **Flag-off byte-identity**: with `RBOX_CRYPTO_FUSE` unset, an `encryptAndUpload`
   (or `runCryptoAndUpload`) run produces identical manifest descriptors + identical
   uploaded ciphertext bytes vs a control run — the coalescer is never entered. (A
   focused unit asserting `encryptCoalesced` is not called when the flag is off is
   acceptable if a full e2e is heavy.)
7. **Requeue (aggregate overflow)**: a job whose files' actual read bytes exceed
   `jobPlaintextCap` (simulate by growing a file after coalesce) → overflow files
   return `requeue`, are re-coalesced, and all files ultimately succeed with correct
   ciphertext; no charge leak.

Keep tests deterministic and fast (small worker counts, `RBOX_CRYPTO_WORKER_TEST_DELAY_MS`
where ordering matters). No raw paths in any assertion message that a metric would emit.

---

## 7. Failure / cleanup matrix (lifted from design §7 — every row releases the charge exactly once)

| Outcome | Charge lifecycle |
|---|---|
| Success (memory) | per-file charge released on `lease.release()` (legacy: after materialize-to-temp; 98: after HTTP settlement) |
| Per-file allowlisted error (churn/source-changed) | no charge ever taken; file settled alone |
| `requeue` (aggregate overflow) | no charge; re-coalesced |
| Oversize / spilled → file-backed | charge released when it becomes file-backed (spill write) or never taken (oversize oracle) |
| Whole-job / worker crash BEFORE receipt | discard transferred buffers → release the single `JOB_RESERVE`; no per-file charges existed |
| Malformed envelope | same as crash: discard buffers → release `JOB_RESERVE` → split-retry |
| Cancel/close, undispatched group | `JOB_RESERVE` never held / released immediately; producer-owned entries terminally settled; no children |
| Cancel/close, posted/in-flight job | `JOB_RESERVE` retained until result-received-and-discarded OR confirmed worker termination, then released |
| Duplicate-address coalescing (`uploaded` set) | losing buffer's charge released immediately (handled by the legacy loop's existing dedup + `release()`) |

No double-release (idempotent guard). Pre-receipt authority = `JOB_RESERVE` only;
post-receipt authority = guarded per-file leases only.

---

## 8. What NOT to touch

- `encryptFileToTempInline`, `deriveKeyNonce`, `encryptBufferToFile`, AAD,
  `COMPRESS_*`/`ZSTD_LEVEL`, decrypt path, `encrypt-address-cache.ts`.
- The pool's existing per-file `encrypt`/`decrypt`, worker lifecycle, health,
  crash-replacement, idle timer, `dispatch`/`enqueue`/queue machinery, `minJobs`,
  worker-count / FD / memory caps.
- `blob-batch.ts` wire format, receipts, dedup; `api.ts` `putBlobFile`;
  `apps/api/*`; the server. **No new upload API** (parent directive).
- `sync-recovery.ts` cache classification, defer logic, `uploadFileWithRetry`
  re-encrypt path, manifest surgery.

## 9. Performance validation (before PR) — reuse `rig/d99-p0`

Add a small harness variant (or a flag to `rig/d99-p0/run.ts`) that drives the
**production** `CryptoPool.encryptStream` (flag on, dispatch bound = 4, budget 96 MiB)
with a **null-release consumer** (release each lease immediately — matches Phase-0
Arm-B null sink and design §8 gate 1 "first-start → last-ready") vs flag-off (the real
`encryptFileToTempInline` pool path = Arm A) on the seeded 20k corpus. Report:
measured encrypt-wall A/B delta (confirm ≥30%), peak RSS vs 96 MiB + control bound,
peak FD. This validates the PRODUCTION code path, not the throwaway prototype.
```
