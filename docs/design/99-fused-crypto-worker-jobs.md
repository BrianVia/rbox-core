# 99 — Fused byte-bounded crypto worker jobs + fewer encrypt temp passes

Status: Design draft v2 (revised after REVIEW-99 round 1). Measurement-first
(Phase 0 gate precedes any behaviour change). Client-only. Owns the crypto
worker pool's job granularity and the first-publish encrypt temp-file lifecycle.
Interfaces with **design 98** (first-publish overlapping encrypt→upload
pipeline, drafted in parallel): §10 states the per-file readiness contract 98
consumes.

Origin: `docs/audits/2026-07-10-sync-performance-audit.md` **Finding 7**
(per-job and disk-pass amplification, audit lines 572–659) and the temp-file
overlap of **Finding 13** (945–1031). Initial upload is the conversion moment:
a measured 105k-file first publish is 599s wall, of which **363s is the encrypt
phase** (audit line 40). Finding 7 estimates ≥30% encrypt reduction is
plausible from fusing small files into byte-bounded worker jobs and removing
temp-file passes. Finding 6 (audit 569–570) requires the *full-publish* wall,
not the sum of lane timings, as the ultimate success condition — §8 gates both.

Method follows design 85 (§5) and designs 79–82: measure, falsify, then build.
The 363s and the per-job/disk-pass decomposition are **stale-by-default** — §5
re-measures on a pinned control before any gate in §8 is evaluated, and §5's P0
gate (a measurement-only A/B micro-prototype) can kill this design before any
production code ships.

## 1. Scope

This design changes **only** the I/O envelope around the existing crypto core:
job granularity (one message per file → byte-bounded multi-file jobs) and the
temp-file lifecycle (disk snapshot/ciphertext temps → bounded, memory-budgeted
in-memory handoff for small files). It does **not** touch the cryptography, and
adds **no** same-isolate encryption promises (audit non-opportunity, line 1192):
fusion runs inside the existing worker isolates; the caller's per-encrypt-call
promise count does not grow (§6.4).

### 1.1 Exact shipped-code inventory: unchanged vs deliberately touched

Addresses REVIEW-99 items 17–18. This design is a **batch envelope + byte-backed
sink**, nothing more.

**Byte-for-byte UNCHANGED (serves as the determinism oracle, §7.1):**

- `encryptFileToTempInline` (`crypto.ts:182–271`) — the shipped single-file
  snapshot/temp path is **not rerouted**. The fused helper (§6.2) is a
  *separate* implementation; §7.1 asserts equality against this untouched
  oracle. (Round-1 item 17.)
- `deriveKeyNonce`, AAD, `COMPRESS_MIN_BYTES`/`COMPRESS_RATIO`/`ZSTD_LEVEL`,
  `encryptBufferToFile` layout (`crypto.ts:27–113`), and the whole
  encrypt-address cache (`encrypt-address-cache.ts`).
- The crypto pool's worker lifecycle, health, crash-replacement, idle timer,
  dispatch/queue machinery (`crypto-pool.ts:185–484`) — reused, not rewritten;
  §6.3 adds a coalescer *alongside* it.
- The batch-PUT wire format, receipts, dedup, and server (`blob-batch.ts`,
  `apps/api/*`).

**Deliberately touched (new code, scoped + gated):**

- `crypto-worker-protocol.ts` — one new message kind + result type (§6.1).
- `crypto-worker.ts` — one new branch calling a new in-memory helper (§6.2).
- `crypto-pool.ts` — a coalescer, a ciphertext memory-budget semaphore, and
  split-on-crash retry (§6.3, §4.1, §7.2).
- `blob-batch.ts` / blob store — a byte-backed `putBytesBatched` + `putBytes`
  single-PUT sink (§7.5).
- `sync-recovery.ts` — one call-site swap behind `RBOX_CRYPTO_FUSE` (§6.4).

Already shipped, NOT re-proposed (audit lines 68–98): the Bun crypto worker
pool, compress-before-encrypt, the encryption-address cache and its O(files ×
entries) fix, convergent AES-256-GCM determinism.

## 2. Current shape, measured in code

### 2.1 Job granularity — one Worker message per file

- `crypto-worker-protocol.ts:17` — `CryptoWorkerEncryptMessage` carries exactly
  one `srcPath`.
- `crypto-pool.ts:309–311` — `CryptoPool.encrypt(srcPath, …)` posts one
  `{ kind: "encrypt", … }` and resolves one `EncryptedBlob`.
- `crypto-worker.ts:77–79` — one file per message via `encryptFileToTempInline`.
- Pool limits: `MAX_IN_FLIGHT_PER_WORKER = 2`, `QUEUE_PER_WORKER = 4`,
  `MAX_WORKERS = 16`; worker count `min(max(parallelism−2, 2), 16)` capped by a
  512 MiB/worker memory reservation and an FD headroom cap
  (`crypto-pool.ts:26–31, 79–115`).
- Engagement floor: no pool below `minJobs()` = 8 (`crypto-pool.ts:74–77,
  486–487`). A push with <8 `toEncrypt` entries runs `encryptFileToTempInline`
  inline — relevant to, but not a full proof of, small-push safety (§8 gate 5).

At ~105k files that is ~105k `postMessage` round-trips, each structured-cloning
the message and the returned `EncryptedBlob`, plus per-message queue scheduling
(`dispatch()`, `crypto-pool.ts:408–417`). Finding 7's design-81 tmpfs
experiment moved nothing → the residual is **per-job runtime + syscall
overhead**, not disk bandwidth (audit 592–593).

### 2.2 Temp-file / disk passes per file — `encryptFileToTempInline`

`src/engine/crypto.ts:182–257`, per fuse-candidate small file:

1. `copyFile(srcPath, snapPath)` — read source, **write** immutable snapshot
   temp (concurrent-write safety, `crypto.ts:196`).
2. `hashFile(snapPath)` — **reread** snapshot → `plaintextSha` (`:197`).
3. `stat(snapPath)` (`:198`).
4. Compress ≤4 MiB: buffered zstd rereads snapshot into a buffer (`:210`).
5. Encrypt: read payload → **write ciphertext temp** (`:239`/`243–244`).
6. `hashFile(ctPath)` — **reread** ciphertext → `encSha` (`:255`).
7. `stat(ctPath)` (`:256`).
8. Cross-process: the returned `ciphertextPath` is **reread** by the batch
   uploader (`fs.readFile`, `blob-batch.ts:726`) to frame the PUT body.
9. `rm` snapshot then, after upload, `rm` ciphertext.

≥5 disk passes over ≤256 KiB, dominated by open/stat/syscall overhead.

### 2.3 Where the ciphertext goes today

Worker writes ciphertext into the shared `tmpDir` (`rbox-encup-*`,
`sync-recovery.ts:170`) and returns the path; the main isolate passes it to
`api.putBlobFile` (`sync-recovery.ts:341`). Small blobs (ciphertext ≤
`DEFAULT_BATCH_RECORD_BYTES` = 256 KiB, `blob-batch.ts:19`) frame into an 8 MiB
batch-PUT body (`blob-batch.ts:22, 726–734`); larger fall to single PUT. **The
ciphertext for the fusion population is already read back into memory for
upload** — the in-memory handoff (§4) removes that reread and the ciphertext
temp.

### 2.4 First-publish caller

`sync-recovery.ts:193–397` (`runCryptoAndUpload`), wrapped by
`withCryptoPool(kek, cfg.keyEpoch, toEncrypt.length, …)` (`:394`). The
encrypt-address cache is consulted **per file, before dispatch**
(`classifyCacheHit`, `:202–220`); only cache **misses** call `encryptFileToTemp`
(`:224`, `:293`). Fusion only ever batches cache-miss files (§7.3).

## 3. Design overview

Add a third job kind — a **fused byte-bounded encrypt batch** — alongside
per-file `encrypt`/`decrypt`. Route files by plaintext size:

- **Fuse-eligible** (`size ≤ FUSE_MAX_FILE_BYTES`, §5.2): a coalescer
  accumulates them into byte- and count-bounded groups; each group is one worker
  job; ciphertext returns **in memory** under a global byte budget and hands to
  the uploader with no ciphertext temp (spill to temp only under memory
  pressure, §4.2).
- **Large / streaming** (`> FUSE_MAX_FILE_BYTES`) and **all Git artifacts**:
  unchanged single-file `encrypt` job via `encryptFileToTempInline`. Out of
  scope (§9).

Phasing:

- **Phase 0** (§5): a measurement-only, throwaway A/B micro-prototype + passive
  instrumentation, both behind flags, no production behaviour change. Evaluate
  the P0 gate. **If it fails, stop.**
- **Phase 1** (§6): fused job kind + coalescer + budgeted in-memory handoff
  behind `RBOX_CRYPTO_FUSE` (default off). Oracle path untouched.
- **Phase 2** (§8): fleet A/B against the pinned control (§5.4); if §8 gates
  pass, flip the default on.

## 4. Removing temp passes — the memory-budgeted small-file path

Per fuse-eligible file the worker does, entirely in memory:

1. `read(srcPath)` **once** into a bounded buffer `src`. **This single read IS
   the immutable snapshot** — hashing and encrypting both read `src`, the exact
   self-consistent-image guarantee `copyFile`→snapshot gives today
   (`crypto.ts:164–173`), no snapshot temp. Eligibility (`size ≤
   FUSE_MAX_FILE_BYTES`) is **re-validated from `src.length` after the read**,
   not from the pre-read stat — a file that grew past the cap between scan and
   read is failed as source-changed (Round-1 item 16).
2. `plaintextSha = sha256(src)`; if `opts.expected` set and sha or size differ →
   `sourceChangedError` (identical to `crypto.ts:199–201`), a per-file
   deferrable failure (§7.4).
3. Compress in memory exactly as the ≤4 MiB buffered branch
   (`crypto.ts:207–216`): zstd level 3, keep iff `< plaintext × 0.95`.
4. `deriveKeyNonce(kek, payloadSha)` → AES-256-GCM over the payload buffer →
   ciphertext `ct = body || tag` (same bytes as `encryptBufferToFile`).
5. `encSha = sha256(ct)`; `cipherSize = ct.length` — over the in-memory buffer,
   **no ciphertext reread**.
6. `ct` transfers (mandatory transfer list, §7.2) to the main isolate and frames
   directly into the PUT — **no ciphertext temp, no upload reread**.

Net for eligible files: **≥5 disk passes → 1 source read + 0 temp writes**.

### 4.1 The ciphertext memory budget (one global byte-semaphore)

Addresses Round-1 items 1, 2. The reread-elimination moves ciphertext into
main-isolate memory until the uploader owns it. A **single global byte-semaphore
`CiphertextBudget`** governs *all* live ciphertext bytes from worker output
through HTTP settlement — worker `results` retention, transfer-limbo, main-side
result objects, and the uploader's framed body all draw on it:

- **Reserve before dispatch.** Before a fused job is posted, the coalescer
  reserves a conservative upper bound `reserve = Σ plaintextSize + files×16 +
  CLONE_SLACK` (ciphertext ≤ plaintext+tag because compression only shrinks;
  `CLONE_SLACK` covers framing/serialization). If the budget cannot grant the
  reservation, **dispatch blocks** (backpressure onto the encrypt lane) — so a
  worker never returns bytes the main isolate has not already accounted for
  (fixes "backpressure too late").
- **Transfer, don't clone.** Ciphertext buffers move via `postMessage` transfer
  lists (mandatory, §7.2); the worker's copy is neutered on send, so no
  double-count. If a runtime lacks transfer support the pool refuses to enable
  fusion (falls back to the oracle path) rather than silently doubling memory.
- **Release on ownership transfer only.** A reservation is released when the
  uploader has copied the bytes into its framed body (owns them) **or** spill
  (§4.2) has written them to disk. Not before.
- **Budget size** `CIPHERTEXT_BUDGET_BYTES` = **96 MiB** (§5.2), strictly below
  the uploader's already-tolerated in-flight ceiling so the two budgets do not
  jointly exceed prior peak (§8 gate 3 measures it).

### 4.2 Spill (the real trigger, fully specified)

Addresses Round-1 item 3. Spill is **not** a "single job too big for an idle
budget" case (that is impossible for a ≤4 MiB job under a 96 MiB budget — dead
code, removed). The real case is **sustained pressure**: many workers complete
while the uploader lags, so held ciphertext approaches the budget and dispatch
would stall the encrypt lane.

- **Who / when:** the *main isolate*, at result-receipt, when held ciphertext
  exceeds a high-water mark (`SPILL_WATERMARK` = 75% of budget) **and** the
  uploader is saturated. It writes the oldest held ciphertext buffers to temp
  files in the shared `tmpDir` (owner-only, as today), flips their
  `ciphertextLocation` to `{ kind: "file", path }`, and **releases their budget
  reservation**. Encryption keeps flowing.
- **Promise settlement:** each spilled file's per-file promise still resolves
  normally with the file-backed location; the uploader takes the `putBlobFile`
  path for those (§7.5). A spill *write* failure settles only that file's
  promise as a retry-later deferral (§7.4) and releases its bytes; siblings are
  unaffected.
- Spill is a measured escape hatch (metric: spilled bytes/files, §8 gate 3), not
  the hot path; a healthy pipeline (98 draining) never spills.

## 5. Phase 0 — measure and falsify before building

All Phase-0 work is measurement-only, behind `RBOX_METRICS`/soak flags, no
production behaviour change. **HARD PRIVACY RULE: no raw file name or path in
any emitted metric or log line.** Correlation uses content addresses
(`plaintextSha`/`encSha`, already in the manifest/logs) or an opaque per-job
ordinal; `srcPath` lives only in the in-process job payload (the worker must
open the file) and is never copied into a metric/log field. A Phase-0 review
checklist asserts every new metric field is one of: count, byte count,
millisecond duration, content hash, or ordinal.

### 5.1 Passive instrumentation (diagnostic only — NOT the gate)

Extend `ScanStats`/`phase-report.ts` lane timing (the plumbing design 85 §5 P0.1
reuses) to record, on the pinned control:

- **per-job overhead vs payload** — worker `jobWallMs` (msg-received →
  results-posted) and `payloadCryptoMs` (Σ per-file read+hash+compress+
  encrypt+encSha); main-side enqueue→result latency and clone size.
- **queue wait** — timestamp each job at enqueue and at `post()`
  (`crypto-pool.ts:204–208`).
- **temp bytes written per file** — sum snapshot+compressed+ciphertext bytes to
  disk per file (bytes, not paths).
- **worker utilization** — per worker, busy-ms (Σ intervals with
  `inFlight.size > 0`) / wall.
- **corpus shape** — plaintext-size histogram, fuse-eligible fraction (count and
  bytes), unique vs duplicate (cache-hit) ratio.

These describe *where* time goes; they do **not** by themselves prove
reclaimability (Round-1 item 10: sums overlap under parallelism, queue wait is
not removable wall, upload reread sits outside the encrypt phase). They inform
the prototype and the bounds, nothing more.

### 5.2 Proposed bounds (justified; revisited by §5.1 output)

| Constant | Proposed | Justification |
|---|---:|---|
| `FUSE_MAX_FILE_BYTES` | **256 KiB** | Captures the fusion population; note eligibility is on **plaintext** while batch-PUT eligibility is on **ciphertext** (plaintext+tag), so a near-cap file may exceed the 256 KiB record cap and take the byte-backed **single** PUT (`putBytes`, §7.5) — memory-sourced, no temp. (Round-1 item 4.) |
| `FUSE_MAX_JOB_BYTES` (Σ plaintext/job) | **4 MiB** | Bounds a job's retained ciphertext (§7.2); matches `BUFFERED_COMPRESS_MAX_BYTES`. |
| `FUSE_MAX_JOB_FILES` | **512** | Bounds results-array/clone cost and stops a 105k-empty-file corpus forming one unbounded job; ~105k files → ~205+ jobs, not 105k messages. |
| fused jobs in flight / worker | **1** | A fused job retains **all** its ciphertext until it posts (§7.2); capping at 1 keeps per-worker retention to one job's worth and avoids two jobs overlapping serialization. Per-file `encrypt`/`decrypt` still use the other slot. (Round-1 item 5.) |
| `CIPHERTEXT_BUDGET_BYTES` (§4.1) | **96 MiB** | Global cap on all live ciphertext; below the uploader's existing 192 MiB in-flight ceiling (24×8 MiB, `blob-batch.ts:22, 570`) so combined peak ≈ prior peak, not additive. |
| `SPILL_WATERMARK` | **75%** of budget | Starts spill before the encrypt lane stalls (§4.2). |
| coalescer flush idle timer | **10 ms** (`FLUSH_DELAY_MS`) | Same tail-flush as the uploader (`blob-batch.ts:32`); last partial group never hangs. |
| primed first batch (§10) | **≤ 64 KiB or 16 files** | The stream's *first* fused job flushes early/small so time-to-first-upload is not held for a full 4 MiB group (Round-1 item 14). |

### 5.3 P0 GATE — a measurement-only A/B micro-prototype (falsifiable)

Addresses Round-1 item 10. The gate is **not** an additive formula. Build a
throwaway, behind-flag harness (never shipped enabled) that encrypts the **same
pinned corpus snapshot** two ways on the **same host, back-to-back**, changing
**only** batching + I/O and holding crypto, worker count, and compression fixed:

- **Arm A:** today's per-file temp path (the control).
- **Arm B:** fused in-memory path (this design), uploads discarded to a null
  sink so only the encrypt→ready critical path is measured.

Measure **critical-path encrypt-phase wall** (first-file-start →
last-file-ready), p50 over ≥5 cold + ≥10 warm runs, plus peak RSS and FD count
for both arms.

**GATE:** Arm B's encrypt critical-path wall is **≥30% below Arm A's** on
Workload B, with peak RSS ≤ Arm A + the §5.2 budget and no FD increase. If not,
fusion cannot meet §8 gate 1 on this corpus → **do NOT build Phase 1** (redesign
or drop). This is a direct, controlled measurement of the exact mechanism, not a
synthesized reclaimability sum.

### 5.4 The single pinned control (Round-1 item 11)

One control for every §5/§8 comparison: **current `main` at a pinned commit**,
pinned `RBOX_*` flags, a pinned Workload-B corpus snapshot (fixed file set,
sizes, duplicate ratio — audit 1245–1251), pinned hardware (each fleet host
named), and pinned cache state (cold = purged page cache where feasible; warm =
defined warm-up). v1.0.0 is cited only as historical context, never as the A/B
control. Statistical discipline per audit 1294–1301 (p50/p95/range, WAN
serialized, control retained for A/B).

## 6. Phase 1 — implementation seam

### 6.1 Protocol (`crypto-worker-protocol.ts`) + completeness rules

```ts
type CryptoWorkerEncryptBatchMessage = {
  id: number;
  kind: "encryptBatch";
  jobs: Array<{ index: number; srcPath: string; opts?: EncryptFileOptions }>;
};
type CryptoWorkerEncryptBatchResult = {
  id: number; ok: true;
  results: Array<
    | { index: number; ok: true; blob: InMemoryEncryptedBlob }
    | { index: number; ok: false; error: SerializedError }   // allowlisted (§7.4)
  >;
};
```

`InMemoryEncryptedBlob` = `EncryptedBlob` with `ciphertextPath` replaced by
`ciphertext: ArrayBuffer` (**always** in the transfer list, §7.2).

**Completeness validation (Round-1 item 8):** on receipt the pool asserts
`results` contains **exactly one** entry per requested `index`, indices unique
and within the request set. Any violation (missing, duplicate, extra, malformed,
non-`ok` envelope) **rejects every still-unresolved slot of that job promptly**
with a crash-class error → bounded whole-job retry (§6.3); a caller is never
resolved with another file's ciphertext, and no promise hangs. Health/decrypt
messages are unchanged.

### 6.2 Worker (`crypto-worker.ts`) — separate helper, not a reroute

A **new** `encryptBytesInMemory(src, kek, opts): InMemoryEncryptedBlob`
implements §4 steps 2–5. It is a *separate* function; `encryptFileToTempInline`
is **left byte-for-byte intact** as the oracle (Round-1 item 17). §7.1 proves
the two agree. The `encryptBatch` branch loops `jobs` **serially**, reading each
file, calling the helper, pushing an `ok`/`error` result; expected per-file
errors are caught into `{ ok:false }` (§7.4), unexpected errors abort the job
envelope. Buffers accumulate in `results` until one post (retention modelled in
§7.2).

### 6.3 Coalescer + split-on-crash retry (`crypto-pool.ts`)

`CryptoPool.encryptCoalesced(srcPath, size, opts): Promise<EncryptResult>`:

- `size > FUSE_MAX_FILE_BYTES` → today's single-file `encrypt()` unchanged.
- else buffer into the open group; flush a fused job on `FUSE_MAX_JOB_BYTES`,
  `FUSE_MAX_JOB_FILES`, the 10 ms timer, the primed-first-batch rule (§5.2), or
  pool drain/close. Reserve `CiphertextBudget` **before** posting (§4.1). Each
  buffered file gets a deferred promise resolved from its `results` slot.
- **Crash retry decomposes (Round-1 item 7).** The shipped machinery re-queues a
  crashed job once (`crypto-pool.ts:342–364`); for a fused job the retry
  **splits the batch in half** and re-queues the halves, recursing to singleton
  jobs. A deterministic crash on one pathological input therefore isolates to a
  single-file job that fails only that file (§7.4) after its own bounded retry;
  the ≤511 innocent siblings succeed on the sibling half. Split depth is bounded
  by ⌈log2(512)⌉ = 9. Readiness for siblings is delayed only by their (smaller)
  half's re-run, not by the poisoned file.

### 6.4 Caller (`sync-recovery.ts`) — one guarded swap

`runCryptoAndUpload`'s `poolMap` loop (`:200–249`) calls `pool.encryptCoalesced`
when `RBOX_CRYPTO_FUSE` is on and a pool exists, else the shipped
`encryptFileToTemp`. Each call still returns one per-file result, so the
address-cache record (`:244`), `ctByEnc` bookkeeping, and upload/retry logic
(`:282–373`) are structurally unchanged. A `{ kind:"memory" }` result routes to
`putBytesBatched`/`putBytes` (§7.5); `{ kind:"file" }` (large or spilled) to
today's `putBlobFile`. No new same-isolate promise per file beyond the one the
loop already awaits.

## 7. Correctness requirements

### 7.1 Byte-identical ciphertext and encSha (determinism)

The fused helper MUST use the same core: `deriveKeyNonce` (single HKDF over a
freshly re-hashed payload sha), constant AAD `rbox/blob/v1`, zstd level 3 with
the same keep rule, `body || getAuthTag()` layout. Validation:

- **Differential oracle test:** encrypt a fixture corpus through both
  `encryptFileToTempInline` (untouched oracle) and `encryptBytesInMemory` and
  assert equal `(plaintextSha, encSha, cipherSize, comp, payloadSha)` and equal
  ciphertext bytes for **every** file.
- **Boundary/property matrix (Round-1 item 16):** empty files; sizes at
  `COMPRESS_MIN_BYTES∓1`, the `COMPRESS_RATIO` keep/reject edge, and
  `FUSE_MAX_FILE_BYTES∓1`; incompressible vs highly compressible; non-transfer
  clone mode; a file mutated/truncated/grown *during* `read` (must yield a
  self-consistent image or a source-changed failure, never a wrong-sha commit —
  eligibility is revalidated from bytes read, §4 step 1); crash-retry replays;
  spill round-trips.
- E2EE determinism suites pass unchanged: `crypto.test.ts`,
  `crypto-pool.test.ts`, `e2ee/e2ee-e2e.test.ts`, `e2ee/primitives.test.ts`,
  `encrypt-address-cache.test.ts`.

### 7.2 Bounded memory (honest lifecycle model)

Addresses Round-1 items 1, 5. A fused job retains **every** ciphertext until it
posts, so per-job peak in the worker =
`Σ(ciphertext of completed files) + (current file: src + compressed-candidate +
ciphertext) + descriptors + serialization state`. Since Σ plaintext ≤ 4 MiB and
ciphertext ≤ plaintext + 16 B/file, retained ciphertext ≤ ~4 MiB + 512×16 B ≈
4.01 MiB; the current file adds ≤ 3×256 KiB ≈ 0.75 MiB; serialization on post is
avoided by **mandatory transfer** (no clone copy). With **1 fused job in flight
per worker**, worker peak ≈ **~5 MiB/job**; the other slot may hold one per-file
`encrypt`/`decrypt`. Across 16 workers, worker-side transient ≈ 80 MiB, inside
the 512 MiB/worker reservation. Main-isolate live ciphertext is capped by the
96 MiB `CiphertextBudget` (§4.1); above `SPILL_WATERMARK` it spills (§4.2).
Fusion **reduces** FDs (fewer temp opens), so the FD cap only relaxes. §8 gate 3
measures worker RSS and main RSS **separately** and at high sample rate to catch
short peaks.

### 7.3 Encrypt-address-cache semantics unchanged

Cache lookup/`classifyCacheHit` runs before dispatch (`sync-recovery.ts:202`);
only misses are fused. Fused results produce the same descriptor tuple
(`plaintextSha` → `{encSha, cipherSize, comp, payloadSha}`), so
`EncryptAddressCache` and its O(files × entries) fix are untouched. Convergent
duplicates dedup identically.

### 7.4 Failure isolation — explicit error allowlist (Round-1 item 6)

Only an **allowlist of expected, serializable per-file errors** becomes a
`{ index, ok:false }` result that defers/rejects that file alone:

- `SOURCE_CHANGED` (`crypto.ts:139–142`, survives serialization);
- source-vanished / unreadable filesystem errors classified `isDeferrableChurn`
  (ENOENT/EACCES/…), matching `sync-recovery.ts:228–239`;
- post-read eligibility-revalidation failure (§4 step 1).

**Everything else** — programmer errors, invariant violations, cancellation,
pool closure, OOM, resource exhaustion — MUST fail the **whole job envelope**
(`ok:false` at the envelope), invoking bounded split retry (§6.3). Per-file
resolution then applies today's classification (`sync-recovery.ts:228–239`):
deferrable churn → defer that path only; else reject that file. Siblings settle
normally.

### 7.5 Upload path for in-memory ciphertext + retry ownership (Round-1 items 4, 9)

- **Batchable** (`cipherSize ≤ recordBytes`): `putBytesBatched(encSha, bytes,
  size)` frames the buffer directly, skipping `fs.readFile` (`blob-batch.ts:726`)
  — same framing/caps/receipts/dedup as the file path.
- **Over-cap memory blob** (near-`FUSE_MAX_FILE_BYTES` plaintext whose ciphertext
  > `recordBytes`): `putBytes(encSha, bytes, size)` — a byte-sourced **single**
  PUT, no temp file (fixes the "single PUT needs a file path" gap).
- **Retry ownership:** the encrypted ciphertext buffer is **retained as the
  immutable request body across transport retries** (503/retry-later/network) —
  those reuse the held bytes, never re-encrypt (a re-read could turn a
  recoverable transport failure into churn). Only a genuine **source-loss /
  sha-mismatch that invalidates the address** re-encrypts from source (as
  `sync-recovery.ts:282–333` does today), releasing the stale bytes' budget
  first. Spilled/large ciphertext keeps the file-based retry.
- **Cleanup matrix (all outcomes release exactly once):** success → release on
  frame-ownership; per-file defer/reject → release on settle; whole-job/worker
  crash → release all reservations for the job's unresolved slots on rejection;
  uploader fallback to single/spill → transfer the reservation to the new owner;
  duplicate-address coalescing (`uploaded` set, `sync-recovery.ts:284`) → the
  losing buffer releases immediately.

## 8. Gates (falsify, not promise) — with tolerances and method

All on the §5.4 pinned control; p50/p95 over ≥5 cold + ≥10 warm; aggregated
**per host and per filesystem** (APFS + ext4); a gate passes only if it holds on
**both** filesystems.

1. **Encrypt phase ≥30% faster.** Fused vs control encrypt-phase critical-path
   wall (first-start → last-ready), p50 ≥30% below control, 95% CI excluding 0.
2. **Determinism green.** §7.1 differential + boundary/property matrix
   byte-identical; named suites pass unchanged.
3. **Memory + FDs bounded, attributed.** Peak **worker** RSS and peak **main**
   RSS sampled ≥100 Hz; main live-ciphertext never exceeds
   `CIPHERTEXT_BUDGET_BYTES`; combined peak RSS ≤ control + 96 MiB (± measurement
   noise stated); FD count ≤ control; spilled bytes/files reported (0 expected
   with 98 draining). Host-minimum memory named; gate re-checked there.
4. **No upload regression.** Batch-PUT record/body occupancy and wire bytes
   within ±2% of control (in-memory framing must not change what goes on the
   wire).
5. **No small-push regression (numeric, not "guaranteed").** Workload A
   one-file change (audit 1227–1234), p50 wall within +1% of control, measured
   in **both** pool-off (<`minJobs`) and pool-on partial-batch cases; the swap,
   helper extraction, and flag plumbing must add no measurable cost.
6. **Full-publish critical path improves (Finding 6, Round-1 item 13).** With
   design 98 enabled, full first-publish wall p50 materially closer to
   `max(encrypt, upload)` than to their sum, and no worse than control; fusion
   must not shave the encrypt phase while inflating upload buffering or
   time-to-first-upload.
7. **Readiness not coarsened (Round-1 item 14).** Measured per-file
   readiness-delay p50/p99 (enqueue → `ready`) and **time-to-first-upload** both
   ≤ control; the primed first batch (§5.2) must keep first-upload no later than
   control.
8. **Full-corpus receiver diff clean** after a fused first publish (audit 658):
   a fresh join reproduces every file byte-for-byte.

## 9. Out of scope

- Large-file/streaming encryption (`> FUSE_MAX_FILE_BYTES`) and Git artifact
  upload (`putGitArtifact`, `git/shared.ts:392–419`) — unchanged temp path.
- The decrypt/pull side (Finding 13) — separate; only noted as the eventual
  shared staging primitive.
- Worker count / pool sizing, `minJobs`, FD/memory caps
  (`crypto-pool.ts:74–115`) — unchanged.
- The encrypt→upload overlap pipeline — **design 98**; this design supplies the
  §10 readiness contract, not the producer/consumer loop.
- Server-side changes — none.

## 10. Interface contract with design 98 (per-file readiness)

98 overlaps encrypt with upload and needs `ready(encSha, size,
ciphertextLocation)` per file, where:

```ts
type CiphertextLocation =
  | { kind: "memory"; bytes: Uint8Array }   // fused, budget-held (§4.1)
  | { kind: "file"; path: string };         // large / streaming / spilled (§4.2)
```

**Granularity — decided: readiness fires per file at fused-job completion, not
incrementally within a job.** A fused job posts one `results` message; its files
become `ready` together. Incremental within-job signalling would need multiple
`postMessage`s per job, reintroducing the per-message overhead fusion exists to
amortize (§2.1).

**Latency — measured, not asserted (Round-1 item 14).** A fused file's `ready`
is delayed by at most one fused job's run. This design does **not** claim "tens
of ms"; §8 gate 7 *measures* readiness-delay p50/p99 and time-to-first-upload
and gates them ≤ control. Two mechanisms protect the head of the stream: (a) the
**primed first batch** (≤64 KiB / 16 files, §5.2) so first-upload is not held
for a full 4 MiB group; (b) large/spilled files stay single-file jobs and signal
at their own completion, so 98 sees no coarsening for the large blobs where
per-file overlap matters most. 98 MUST accept both `CiphertextLocation`
variants; the `memory` variant hands bytes straight to `putBytesBatched`/
`putBytes` (§7.5), and 98's consumer draining `memory` variants promptly is what
keeps the §4.1 budget below the spill watermark.

## 11. Open questions for the founder

1. **Budget vs peak.** Is control + 96 MiB peak RSS (§8 gate 3) acceptable on
   the smallest fleet host, or should `CIPHERTEXT_BUDGET_BYTES` shrink (less
   encrypt/upload overlap headroom for a lower peak)?
2. **Primed-first-batch size.** ≤64 KiB / 16 files (§5.2) is a guess at the
   time-to-first-upload vs per-job-overhead trade; tune from §5.1 corpus shape or
   set by policy?
3. **Fused in-flight = 1 vs 2 per worker.** 1 bounds retention cleanly (§7.2);
   2 could raise utilization if memory allows. Decide from the §5.3 prototype's
   RSS-vs-throughput curve, or fix at 1 for safety?
