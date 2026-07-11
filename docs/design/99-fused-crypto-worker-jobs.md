# 99 — Fused byte-bounded crypto worker jobs + fewer encrypt temp passes

Status: Design draft v1. Measurement-first (Phase 0 gates precede any behaviour
change). Client-only. Owns the crypto worker pool's job granularity and the
first-publish encrypt temp-file lifecycle. Interfaces with **design 98**
(first-publish overlapping encrypt→upload pipeline, drafted in parallel): §7
states the per-file readiness contract 98 consumes.

Origin: `docs/audits/2026-07-10-sync-performance-audit.md` **Finding 7**
(per-job and disk-pass amplification, audit lines 572–659) and the temp-file
overlap of **Finding 13** (945–1031). Initial upload is the conversion moment:
a measured 105k-file first publish is 599s wall, of which **363s is the encrypt
phase** (audit line 40). Finding 7 estimates ≥30% encrypt reduction is
plausible from fusing small files into byte-bounded worker jobs and removing
temp-file passes.

Method follows design 85 (§5) and designs 79–82: measure, falsify, then build.
The 363s and the per-job/disk-pass decomposition are **stale-by-default** — §5
re-measures on current `main` before any gate in §8 is evaluated, and §5's P0
gate can kill this design before implementation.

## 1. Scope and what is explicitly NOT re-proposed

This design changes **only** the I/O envelope around the existing crypto core:
job granularity (one message per file → byte-bounded multi-file jobs) and the
temp-file lifecycle (disk snapshot/ciphertext temps → bounded in-memory
handoff for small files). It does **not** touch the cryptography.

Already shipped, NOT re-proposed (audit lines 68–98):

- the Bun crypto worker pool itself (`src/engine/crypto-pool.ts`);
- compress-before-encrypt (`src/engine/crypto.ts:207–230`, zstd level 3);
- the first-publish encryption-address cache
  (`src/engine/encrypt-address-cache.ts`) and its O(files × cache entries) fix;
- convergent AES-256-GCM determinism (`crypto.ts:105–113`, constant AAD).

Explicit non-opportunity honoured (audit line 1192): this design adds **no**
same-isolate encryption promises. Fusion runs entirely inside the existing
worker isolates; the main isolate's promise count per encrypt call does not
grow (§6 keeps the caller's per-file promise shape while coalescing under it).

## 2. Current shape, measured in code

### 2.1 Job granularity — one Worker message per file

- `crypto-worker-protocol.ts:17` — `CryptoWorkerEncryptMessage` carries exactly
  one `srcPath`.
- `crypto-pool.ts:309–311` — `CryptoPool.encrypt(srcPath, …)` posts one
  `{ kind: "encrypt", srcPath, … }` message and resolves one `EncryptedBlob`.
- `crypto-worker.ts:77–79` — the worker handles one file per message via
  `encryptFileToTempInline`.
- Pool limits: `MAX_IN_FLIGHT_PER_WORKER = 2`, `QUEUE_PER_WORKER = 4`,
  `MAX_WORKERS = 16`, worker count `min(max(parallelism−2, 2), 16)` further
  capped by a 512 MiB/worker memory reservation and an FD headroom cap
  (`crypto-pool.ts:26–31, 79–115`).
- Engagement floor: `selectCryptoPool` returns no pool below `minJobs()` = 8
  (`crypto-pool.ts:74–77, 486–487`). **A single-file / small push never touches
  the pool** — it runs `encryptFileToTempInline` inline. This is the structural
  reason fusion cannot regress a steady one-file change (§8 gate 4).

At ~105k files that is ~105k `postMessage` round-trips, each with structured
clone of the message and the returned `EncryptedBlob`, plus per-message queue
scheduling in `dispatch()` (`crypto-pool.ts:408–417`). Finding 7's design-81
tmpfs experiment moved nothing, which points at **per-job runtime + syscall
overhead**, not aggregate disk bandwidth (audit lines 592–593).

### 2.2 Temp-file / disk passes per file — `encryptFileToTempInline`

`src/engine/crypto.ts:182–257`, for each fuse-candidate small file:

1. `copyFile(srcPath, snapPath)` — read the live source, **write** an immutable
   plaintext snapshot temp (concurrent-write safety, `crypto.ts:196`).
2. `hashFile(snapPath)` — **reread** the snapshot to derive `plaintextSha`
   (`crypto.ts:197`).
3. `stat(snapPath)` for size (`crypto.ts:198`).
4. If compressing ≤ 4 MiB: buffered zstd reads the snapshot again into a buffer
   (`crypto.ts:210`); the >4 MiB branch streams snapshot→**compressed temp**
   (`crypto.ts:218–219`).
5. Encrypt: read payload (snapshot or compressed) → **write ciphertext temp**
   (`crypto.ts:239` or `243–244`).
6. `hashFile(ctPath)` — **reread** the ciphertext to compute `encSha`
   (`crypto.ts:255`).
7. `stat(ctPath)` for `cipherSize` (`crypto.ts:256`).
8. Cross-process: the returned `ciphertextPath` is later **reread** by the
   batch uploader — `fs.readFile(group.srcPath)` at
   `src/cli/remote/blob-batch.ts:726` — to frame the blob into a batch PUT body.
9. `rm` snapshot (+ compressed) then, after upload, `rm` ciphertext.

So a fuse-eligible small file pays: 1 source read + 1 snapshot write + 1
snapshot reread (hash) + (compress reread) + 1 ciphertext write + 1 ciphertext
reread (encSha) + 1 ciphertext reread (upload framing). That is **≥5 disk
passes over ≤256 KiB of data**, dominated by syscall/open/stat overhead rather
than bytes.

### 2.3 Where the ciphertext actually goes

The worker writes ciphertext into the shared `tmpDir` (`rbox-encup-*`, created
in `sync-recovery.ts:170`) and returns the path. The main isolate hands that
path to `api.putBlobFile(encSha, ct, size, …)` (`sync-recovery.ts:341`), which
routes through the batch uploader. Small blobs (≤ `DEFAULT_BATCH_RECORD_BYTES`
= 256 KiB, `blob-batch.ts:19`) are framed into an 8 MiB-body batch PUT
(`blob-batch.ts:22, 726–734`); larger blobs fall to single PUT. **The
ciphertext for the exact set of files fusion targets is already read back into
memory for upload** — the in-memory handoff (§4) removes both that reread and
the ciphertext temp entirely.

### 2.4 First-publish caller

`src/cli/sync-recovery.ts:193–397` (`runCryptoAndUpload`), wrapped by
`withCryptoPool(kek, cfg.keyEpoch, toEncrypt.length, …)` (`:394`). The
encrypt-address cache is consulted **per file, before dispatch**
(`classifyCacheHit`, `:202–220`); only cache **misses** call
`encryptFileToTemp` (`:224`, `:293`). Fusion therefore only ever batches
cache-miss files — cache hits never enter a job, so the cache's semantics
(§7.3) are untouched by construction.

## 3. Design overview

Add a third job kind — a **fused byte-bounded encrypt batch** — alongside the
existing per-file `encrypt` and `decrypt`. Route files by plaintext size:

- **Fuse-eligible** (`size ≤ FUSE_MAX_FILE_BYTES`, §5.2): accumulated by a
  coalescer into byte- and count-bounded groups; each group is one worker job;
  ciphertext is returned **in memory** and handed straight to the batch
  uploader with no ciphertext temp.
- **Large / streaming** (`size > FUSE_MAX_FILE_BYTES`) and **all Git
  artifacts**: unchanged — one single-file `encrypt` job each, streaming to a
  ciphertext temp via `encryptFileToTempInline`. Out of scope (§9).

The cryptography is **byte-for-byte the same code path** (§7.1): the fused
worker derives keys and encrypts through the identical primitives; only the
source of bytes (an in-memory buffer instead of a snapshot temp) and the sink
(a returned buffer instead of a ciphertext temp) change.

Phasing:

- **Phase 0** (§5): add measurement-only instrumentation behind
  `RBOX_METRICS`/a soak flag; collect the falsifiable decomposition; evaluate
  the P0 gate. No behaviour change. **If the gate fails, stop here.**
- **Phase 1** (§6): fused job kind + coalescer + in-memory handoff behind
  `RBOX_CRYPTO_FUSE` (default off). Large path and inline path untouched.
- **Phase 2**: fleet A/B on Workload B against the v1.0.0 control; if §8 gates
  pass, flip the default on.

## 4. Removing temp passes — the in-memory small-file path

For a fuse-eligible file the worker does, per file, entirely in memory:

1. `read(srcPath)` once into a bounded buffer `src` (≤ `FUSE_MAX_FILE_BYTES`).
   **This single read IS the immutable snapshot** — hashing and encrypting both
   read the same `src` buffer, giving the exact self-consistent-image guarantee
   `copyFile`→snapshot gives today (`crypto.ts:164–173`), with no snapshot temp.
2. `plaintextSha = sha256(src)`; `plaintextSize = src.length`. If
   `opts.expected` is set and either differs → `sourceChangedError` (identical
   to `crypto.ts:199–201`), classified per-file as deferrable churn (§7.4).
3. Compress in memory exactly as the ≤4 MiB buffered branch does today
   (`crypto.ts:207–216`): zstd level 3, keep only if `< plaintext × 0.95`.
4. `deriveKeyNonce(kek, payloadSha)` → AES-256-GCM over the payload buffer →
   ciphertext buffer `ct = body || tag` (same bytes as `encryptBufferToFile`,
   `crypto.ts:65–76`).
5. `encSha = sha256(ct)`; `cipherSize = ct.length` — computed over the
   in-memory buffer, **no ciphertext reread**.
6. The buffer is returned to the main isolate and framed directly into the
   batch PUT — **no ciphertext temp, no upload reread** (removes §2.2 steps
   1, 2, 6, 8; step 4's temp only for the buffered branch, which is already
   bufferless).

Net: **≥5 disk passes → 1 source read + 0 temp writes** for fuse-eligible
files. This is the same elimination Finding 13 describes for the pull side
(945–1031), applied to the push side; both should eventually share one deep
staging primitive, but this design does not block on that consolidation.

### 4.1 Backpressure and spill (bounds the new RSS)

The reread-elimination moves ciphertext from disk into main-isolate memory
until the batch uploader consumes it. That is the one new memory pressure and
it must be bounded, not unbounded:

- The coalescer holds a global budget `FUSE_MAX_INFLIGHT_CIPHERTEXT_BYTES`
  (§5.2) of **ready-but-not-yet-accepted** ciphertext across all jobs. While
  the budget is exceeded, the coalescer stops dispatching new fused jobs
  (natural backpressure onto the encrypt lane — design 98's consumer draining
  faster relieves it).
- If a single job's returned ciphertext cannot fit the budget even when idle
  (pathological), that job's ciphertext **spills to a temp file** and its
  `ciphertextLocation` becomes `{ kind: "file", path }` — the pre-fusion
  behaviour, always available as the floor. Spill is a measured escape hatch,
  not the hot path.

## 5. Phase 0 — measure and falsify before building

All Phase-0 instrumentation is measurement-only, behind `RBOX_METRICS` or a
soak flag, no behaviour change. **HARD PRIVACY RULE: no raw file name or path
appears in any emitted metric or log line.** Correlation uses content
addresses (`plaintextSha`/`encSha` — already in the manifest and existing logs)
or an opaque per-job ordinal; the job payload carries `srcPath` because the
worker must open the file, but that field is never copied into a metric or log
field. A Phase-0 review checklist asserts every new metric field is one of:
count, byte count, millisecond duration, content hash, or ordinal.

### 5.1 Metrics to collect on Workload B (audit 1245–1262)

Decompose the encrypt phase per file into disjoint spans (extend `ScanStats`/
`phase-report.ts` lane timing, the same plumbing design 85 §5 P0.1 reuses):

- **per-job overhead vs payload time** — in the worker, record `jobWallMs`
  (message-received → results-posted) and `payloadCryptoMs` (Σ per-file
  read+hash+compress+encrypt+encSha). Overhead = `jobWallMs − payloadCryptoMs`;
  main-side, record enqueue→result latency and structured-clone size.
- **queue wait** — timestamp each job at enqueue and at `post()`
  (`crypto-pool.ts:204–208`); report time spent in `queue`.
- **temp bytes written per file** — instrument `crypto.ts` to sum snapshot +
  compressed + ciphertext bytes written to disk per file (today's baseline);
  this is the disk-pass volume fusion removes. Report bytes, not paths.
- **worker utilization** — per worker, busy-ms (Σ intervals with
  `inFlight.size > 0`) / wall; plus `jobsRun`/`workerExecutions`
  (already tracked, `crypto-pool.ts:207, 249`) and idle gaps.
- **corpus shape** — histogram of plaintext sizes and the fuse-eligible
  fraction (count and bytes), unique vs duplicate (cache-hit) ratio.

Report p50/p95/range over ≥5 warm + ≥3 cold Workload-B runs per host (APFS +
ext4), metrics-on vs metrics-off wall first (design 85 §5 P0.1 caveat: if
instrumentation overhead > ~5%, per-span numbers are directional only).

### 5.2 Proposed bounds (justified, revisited by §5.1 output)

| Constant | Proposed | Justification |
|---|---:|---|
| `FUSE_MAX_FILE_BYTES` (fuse-eligibility threshold) | **256 KiB** | Equals `DEFAULT_BATCH_RECORD_BYTES` (`blob-batch.ts:19`): exactly the set whose ciphertext already goes through the in-memory batch PUT, so the in-memory handoff adds no new large-buffer class. Also ≤ the 4 MiB buffered-compression threshold (`crypto.ts:32`), so fused files always take the bufferless compress branch. |
| `FUSE_MAX_JOB_BYTES` (aggregate plaintext / job) | **4 MiB** | Caps per-job working set; matches `BUFFERED_COMPRESS_MAX_BYTES`. Peak worker transient ≈ src(≤4) + compressed(≤4) + ciphertext(≤4) ≈ 12 MiB/job. |
| `FUSE_MAX_JOB_FILES` (record cap / job) | **512** | Bounds the results array + clone cost and stops a many-tiny-files corpus (105k empty `__init__.py`) from forming one unbounded job. At 512 files/job, ~105k files → ~205+ jobs instead of 105k messages. |
| in-flight fused jobs / worker | **2** (reuse `MAX_IN_FLIGHT_PER_WORKER`) | Peak per worker ≈ 2 × 12 MiB = 24 MiB; × 16 workers ≈ **384 MiB** transient, within the existing 512 MiB/worker reservation the count derivation already assumes (`crypto-pool.ts:30, 90`). |
| `FUSE_MAX_INFLIGHT_CIPHERTEXT_BYTES` (main-side ready budget, §4.1) | **128 MiB** | Below today's already-tolerated batch-PUT in-flight ceiling (24 slots × 8 MiB body = 192 MiB, `blob-batch.ts:22, 570`). Above it → stop dispatch / spill. |
| coalescer flush idle timer | **10 ms** (reuse `FLUSH_DELAY_MS`) | Same tail-flush discipline as the batch uploader (`blob-batch.ts:32`); the last partial group never hangs. |

### 5.3 P0 GATE (falsifiable, can kill the design)

From §5.1, compute the **amortizable + eliminable** share of the encrypt phase:

```
reclaimable = queue_wait
            + (per_job_overhead × (1 − 1/mean_files_per_fused_job))   // amortized away
            + snapshot_write_time
            + ciphertext_encSha_reread_time
            + ciphertext_upload_reread_time
```

**GATE:** if `reclaimable < 30%` of the measured current encrypt phase on
Workload B, fusion **cannot** meet its own §8 gate 1 on this corpus →
do NOT build Phase 1 (redesign or drop). This falsifies the audit's ≥30%
estimate on real numbers before any code ships, exactly as design 85 §5 gates
Layer A on measured readdir share.

## 6. Phase 1 — implementation seam

### 6.1 Protocol (`crypto-worker-protocol.ts`)

Add one job kind; `health` and `decrypt` unchanged:

```ts
type CryptoWorkerEncryptBatchMessage = {
  id: number;
  kind: "encryptBatch";
  jobs: Array<{ index: number; srcPath: string; opts?: EncryptFileOptions }>;
};
type CryptoWorkerEncryptBatchResult = {
  id: number; ok: true;
  results: Array<
    | { index: number; ok: true; blob: InMemoryEncryptedBlob }   // ciphertext as bytes
    | { index: number; ok: false; error: SerializedError }        // per-file failure
  >;
};
```

`InMemoryEncryptedBlob` is `EncryptedBlob` with `ciphertextPath` replaced by a
`ciphertext: ArrayBuffer` (optionally sent in `postMessage`'s transfer list to
avoid a clone copy — a perf lever measured in §5, not required for
correctness). The whole-job envelope succeeds even when individual files fail
(§7.4).

### 6.2 Worker (`crypto-worker.ts`)

New branch factors the crypto core out of `encryptFileToTempInline` into a
buffer-in/buffer-out helper `encryptBytesInMemory(src, kek, opts)` that
`encryptFileToTempInline` **also** calls for its buffered branch — one shared
implementation, so fused and single-file outputs are provably identical (§7.1).
The batch branch loops `jobs`, reads each file into a bounded buffer, calls the
helper, and pushes a per-file `ok`/`error` result; one bad file is caught and
recorded, never thrown past the job (§7.4).

### 6.3 Coalescer (`crypto-pool.ts`)

Add `CryptoPool.encryptCoalesced(srcPath, size, opts): Promise<EncryptedBlob-ish>`:

- `size > FUSE_MAX_FILE_BYTES` → delegate to today's single-file `encrypt()`
  (streaming temp path) unchanged.
- else buffer into the current open group; flush a fused job when the group hits
  `FUSE_MAX_JOB_BYTES`, `FUSE_MAX_JOB_FILES`, the 10 ms idle timer, or pool
  drain/close. Each buffered file gets a deferred promise resolved from its
  slot in the job's `results` array.
- respects `FUSE_MAX_INFLIGHT_CIPHERTEXT_BYTES` backpressure and the spill
  fallback (§4.1); dispatch/queue/crash-retry stay the existing pool machinery
  (`crypto-pool.ts:381–458`) — a crashed fused job re-queues once like any job,
  and re-running it is deterministic (§7.1) so retry is safe.

### 6.4 Caller (`sync-recovery.ts`) — minimal change

`runCryptoAndUpload`'s `poolMap` loop (`:200–249`) swaps `encryptFileToTemp`
for `pool.encryptCoalesced` (falling back to `encryptFileToTemp` when no pool /
flag off). Each call still returns one per-file result, so the address-cache
record (`:244`), `ctByEnc` bookkeeping, and the upload/retry logic (`:282–373`)
are structurally unchanged. When a result carries `{ kind: "memory", bytes }`,
upload takes the new `putBytesBatched` path (§7.5); when `{ kind: "file" }`
(large or spilled), it takes today's `putBlobFile`.

## 7. Correctness requirements

### 7.1 Byte-identical ciphertext and encSha (determinism)

The fused path MUST call the **same** crypto core as
`encryptFileToTempInline`: `deriveKeyNonce` (single HKDF from a freshly
re-hashed payload sha, `crypto.ts:110–113`), constant AAD `rbox/blob/v1`, zstd
level 3 with the same `COMPRESS_MIN_BYTES`/`COMPRESS_RATIO` keep rule, and the
`body || getAuthTag()` layout. §6.2 enforces this by extraction, not
re-implementation. The E2EE determinism suite must pass unchanged:
`src/engine/crypto.test.ts`, `src/engine/crypto-pool.test.ts`,
`src/engine/e2ee/e2ee-e2e.test.ts`, `src/engine/e2ee/primitives.test.ts`,
`src/engine/encrypt-address-cache.test.ts`. A new differential test encrypts a
size-stratified fixture corpus through both the inline temp path and the fused
in-memory path and asserts equal `(plaintextSha, encSha, cipherSize, comp,
payloadSha)` and equal ciphertext bytes for every file.

### 7.2 Bounded worker memory

Per §5.2: ≤ 2 in-flight fused jobs/worker × ~12 MiB = ~24 MiB/worker; pool-wide
transient ≈ 384 MiB within the existing 512 MiB/worker reservation; main-side
ready ciphertext ≤ 128 MiB before backpressure/spill. Fusion **reduces** FD
pressure (fewer temp opens), so the FD cap (`crypto-pool.ts:102–115`) only
relaxes. §8 gate 3 measures peak RSS against these bounds.

### 7.3 Encrypt-address-cache semantics unchanged

Cache lookup/`classifyCacheHit` runs before dispatch (`sync-recovery.ts:202`);
only misses are fused. Fused results produce the same descriptor tuple the
cache records/looks up (`plaintextSha` key → `{encSha, cipherSize, comp,
payloadSha}`), so `EncryptAddressCache` behaviour and its O(files × entries)
fix are untouched. Convergent duplicates dedup the same way (identical
`plaintextSha` → identical `encSha`).

### 7.4 Failure isolation in a fused batch

One bad file (vanished, source-changed vs `expected`, unreadable) MUST NOT
poison its batch. The worker catches per file and emits a per-file
`{ index, ok:false, error }`; the job envelope still resolves `ok:true`. The
main isolate resolves that file's promise with the error and applies today's
exact classification (`sync-recovery.ts:228–239`): `isDeferrableChurn` /
`isSourceChangedError` → defer that path only; otherwise reject that file. All
sibling files in the job settle normally. `SOURCE_CHANGED` classification
survives worker serialization (`crypto.ts:139–142`) unchanged.

### 7.5 Upload path for in-memory ciphertext

Add `putBytesBatched(encSha, bytes, size)` to the blob store / batch uploader
that frames a buffer directly, skipping `fs.readFile(group.srcPath)`
(`blob-batch.ts:726`). Same framing, record/body caps, receipts, dedup, and
retry as the file path — only the byte source differs. On `BlobShaMismatch`
retry the coalescer re-encrypts from source (deterministic → identical bytes);
spilled/large ciphertext keeps the existing file-based retry.

## 8. Gates (falsify, not promise)

1. **Encrypt phase ≥30% faster.** Workload B (audit 1245–1262), p50 over ≥5
   cold + ≥10 warm, A/B against the v1.0.0 control: encrypt phase ≥30% below
   the §5-remeasured baseline (target framed against the audit's 363s /
   line 1313).
2. **Determinism green.** §7.1 suites pass unchanged; the differential
   inline-vs-fused corpus test is byte-identical for every file.
3. **Peak RSS bound stated and met.** Measured peak RSS on Workload B ≤ v1.0.0
   baseline **+ 128 MiB** (the §4.1 ready-ciphertext budget); pool-wide
   transient within §7.2; FD count not above baseline (expected below).
4. **No small-push regression.** Workload A steady one-file change (audit
   1227–1234): unchanged wall. Guaranteed structurally — a push below
   `minJobs()`=8 never engages the pool (`crypto-pool.ts:487`); fusion is
   pool-only.
5. **Full-corpus receiver diff clean** after a fused first publish (audit
   line 658): a fresh join reproduces every file byte-for-byte.

## 9. Out of scope

- Large-file / streaming encryption (`size > FUSE_MAX_FILE_BYTES`) and Git
  artifact upload (`putGitArtifact`, `git/shared.ts:392–419`) — unchanged
  single-file temp path.
- The decrypt / pull side (Finding 13, audit 945–1031) — separate; this design
  only notes the eventual shared staging primitive.
- Worker count / pool-sizing heuristics, `minJobs`, FD/memory caps
  (`crypto-pool.ts:74–115`) — unchanged.
- The encrypt→upload **overlap** pipeline — **design 98**; this design supplies
  the readiness contract (§10) that 98 consumes but does not itself build the
  producer/consumer overlap.
- Server-side changes — none; ciphertext, addresses, batch-PUT wire format, and
  receipts are unchanged.

## 10. Interface contract with design 98 (per-file readiness)

Design 98 overlaps encrypt with upload and needs a per-file readiness signal
`ready(encSha, size, ciphertextLocation)` for each file as it becomes
uploadable, where:

```ts
type CiphertextLocation =
  | { kind: "memory"; bytes: Uint8Array }   // fused small file (and un-spilled)
  | { kind: "file"; path: string };         // large / streaming / spilled (§4.1)
```

**Granularity — decided: readiness fires per file at FUSED-JOB completion, not
incrementally within a job.** A fused job posts one `results` message; every
file in it becomes `ready` when that message lands. Rationale: incremental
within-job signalling would require multiple `postMessage`s per job,
reintroducing the exact per-message overhead fusion exists to amortize (§2.1).

**Latency implication (stated for 98):** a fused file's `ready` is delayed by at
most one fused job's processing time — bounded by `FUSE_MAX_JOB_BYTES` = 4 MiB
of crypto (tens of ms), and far below the per-file **queue wait** it replaces
(§5.1). Large / spilled files remain single-file jobs and signal `ready` at
their own completion exactly as today, so 98 sees no coarsening for the large
blobs where per-file overlap matters most. 98 MUST accept both
`CiphertextLocation` variants; the `memory` variant hands bytes straight to
`putBytesBatched` (§7.5) with no temp file, and 98's consumer draining the
`memory` variants promptly is what relieves the §4.1 backpressure budget.

## 11. Open questions for the founder

1. **Gate-1 baseline denominator.** Is the ≥30% gate measured against the
   §5-remeasured current encrypt phase (recommended, current `main`), or held
   literally to 363s from the audit's earlier corpus?
2. **RSS headroom.** Is baseline **+128 MiB** peak (§8 gate 3) acceptable on
   the smallest fleet host, or should `FUSE_MAX_INFLIGHT_CIPHERTEXT_BYTES` be
   tightened (trading a little encrypt/upload overlap for lower peak)?
3. **Transfer-list.** Bun `postMessage` transfer of the ciphertext ArrayBuffer
   is a measurable clone-copy saving but adds runtime coupling — attempt in
   Phase 1 or defer as a follow-up perf lever behind §5 numbers?
