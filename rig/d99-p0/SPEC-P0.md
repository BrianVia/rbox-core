# SPEC-P0 — design 99 Phase-0 A/B micro-prototype (THROWAWAY)

> **THROWAWAY / MEASUREMENT-ONLY.** Nothing in `rig/d99-p0/` ships. It never
> imports into production code and production `src/` is **never modified**. This
> harness exists to produce three artifacts before any Phase-1 build:
> (a) measured per-job overhead, (b) a RAM-vs-throughput curve that SELECTS
> `CIPHERTEXT_BUDGET_BYTES`, (c) a go/no-go verdict on design 99 §8 gate 1
> (encrypt-phase ≥30% faster). Read `docs/design/99-fused-crypto-worker-jobs.md`
> §2, §4, §5, §8 and `docs/design/REVIEW-99.md` first.

## 0. Non-negotiable rules

- **No production `src/` edits.** The harness may **import read-only** from
  `src/engine/crypto.ts` (`encryptFileToTempInline`, `generateKek`,
  `BLOB_CIPHERTEXT_TAG_BYTES`) and from `src/engine/crypto-pool.ts`
  (`withCryptoPool`, `__cryptoPoolTestHooks`) to drive the **real** A-arm pool.
- **No real user data.** The corpus is synthetic, seeded, generated into a
  scratch dir under the OS temp dir (never inside the repo, never committed).
- **HARD PRIVACY RULE (design 99 §5).** No file name or path in any emitted
  metric, CSV, JSON, or report field. Every output field must be one of: count,
  byte count, millisecond duration, content hash, or ordinal. Corpus files are
  addressed by ordinal only.
- **Runtime:** Bun (`bun rig/d99-p0/run.ts …`). The runner spawns each measured
  cell as a **fresh child `bun` process** so `process.resourceUsage().maxRSS`
  (peak RSS, KiB on Linux) is attributable per arm/cell.
- Determinism of the *report structure* and the *determinism-oracle verdict* is
  required for acceptance; wall-clock numbers are inherently noisy and are
  reported as p50 + range across runs.

## 1. What the two arms must measure (honest baseline)

The gate (design 99 §5.3) is a controlled A/B changing **only batching + I/O**,
holding crypto core, worker count, and compression **fixed and identical**.

### 1.1 Arm A — control (today's per-file worker path), MUST be the real path

Drive the **real** crypto pool exactly as production does:

- `withCryptoPool(kek, keyEpoch, corpus.length, async (pool) => …)` then, for
  every corpus file, call `pool.encrypt(absPath, tmpDir, { compress: true,
  expected: { sha256, size } })`. This posts one `encrypt` worker message per
  file and runs the untouched `crypto-worker.ts` →
  `encryptFileToTempInline` (snapshot copyFile → hashFile → stat → buffered zstd
  → encrypt to ct temp → hashFile(ct) → stat → returns ciphertextPath).
- **Saturate the pool the way production does:** keep at least
  `workers * (MAX_IN_FLIGHT_PER_WORKER + QUEUE_PER_WORKER)` = `workers * 6`
  `pool.encrypt` calls outstanding via a bounded map (do **not** await files
  serially — that would understate the pool).
- Pin worker count via `RBOX_CRYPTO_WORKERS=<N>` (see §4). The pool's
  `crypto-worker.ts` runs natively under Bun in the non-compiled runtime.
- **"Ready" for a file = its `pool.encrypt` promise resolves** (ciphertext temp
  written, `encSha`/`cipherSize` known — the point production hands the address
  to the uploader). Record that timestamp, then `rm` the ciphertext temp
  (cleanup, excluded from the critical-path window; the temp dir is a fresh
  `mkdtemp`). **Do NOT reread the ciphertext for framing** — that reread lives in
  the upload phase and is excluded from BOTH arms (conservative: it is a real
  cost B eliminates, so excluding it makes the ≥30% gate harder for B to pass).

### 1.2 Arm B — fused in-memory path (this design), null upload sink

A throwaway re-implementation of the §4 in-memory fused path. It **must do the
same cryptographic work** as A — the determinism oracle (§3) proves byte
identity, which is the guard against "B cheats by measuring less work":

- **Crypto core** (`rig/d99-p0/core.ts`, a throwaway copy of the `crypto.ts`
  core — `deriveKeyNonce`/AAD are not exported, so replicate them EXACTLY):
  - `AAD = Buffer.from("rbox/blob/v1")`, `ZSTD_LEVEL = 3`,
    `COMPRESS_MIN_BYTES = 128`, `COMPRESS_RATIO = 0.95`.
  - `plaintextSha = sha256(src)`; enforce `expected` (`sha256`, `size`) →
    source-changed error on mismatch.
  - Compress **iff** `compress && src.length >= 128`, keeping the compressed
    buffer **iff** `compressed.length < src.length * 0.95`. `payloadSha =
    sha256(payload)`; `comp = "zstd"` when kept.
  - **Zstd byte-identity risk (call out, do not gloss):** `crypto.ts` compresses
    via a **streaming** `createZstdCompress({ level: 3 })` pipeline. To guarantee
    byte-identical compressed output (hence identical `encSha`/`payloadSha`), the
    in-memory helper MUST compress through the **same streaming path** over the
    buffer (`Readable.from(buf) → createZstdCompress({level:3}) → collect`),
    **not** `zstdCompressSync` unless the determinism oracle proves the sync
    framing is byte-identical. Let the oracle (§3) decide; default to streaming.
  - `deriveKeyNonce(kek, payloadSha)` = `hkdfSync("sha256", kek, AAD,
    Buffer.from(payloadSha,"hex"), 44)` → `dek = out[0:32]`, `nonce = out[32:44]`.
  - AES-256-GCM: `createCipheriv("aes-256-gcm", dek, nonce)`, `setAAD(AAD)`,
    `body = update(payload)`, `final()`, `ct = Buffer.concat([body,
    getAuthTag()])`. `encSha = sha256(ct)`, `cipherSize = ct.length`.
  - Returns `{ plaintextSha, encSha, cipherSize, comp?, payloadSha?, ct:
    ArrayBuffer }`.
- **Fused worker** (`rig/d99-p0/fused-worker.ts`): receives an `encryptBatch`
  message `{ id, jobs: [{ index, srcPath, expected }], jobPlaintextCap }`.
  Reads each file **once** into a bounded buffer, runs `core.ts`, accumulates
  results, and posts **one** message with all ciphertext `ArrayBuffer`s in the
  **transfer list** (mandatory transfer, §7.2 — a runtime without transfer
  support is a fatal harness error, not a silent clone). Enforce the aggregate
  cap: if adding a file would exceed `jobPlaintextCap`, mark it `requeue` (the
  coalescer resubmits). Per-file expected/source-changed failures are per-file
  `{ ok:false }` results; they do not fail the batch.
- **Coalescer + budget** (`rig/d99-p0/arm-b.ts`): spawn **N workers, same N as
  Arm A**. Route files: `size > FUSE_MAX_FILE_BYTES` (256 KiB) → a single-file
  fused job (still in-memory, still budget-charged); else accumulate into the
  open group, flushing a job on `FUSE_MAX_JOB_BYTES` (4 MiB), `FUSE_MAX_JOB_FILES`
  (512), the 10 ms idle timer, the primed-first-batch rule (≤64 KiB or 16 files
  for the stream's first job), or drain. **In-flight fused jobs per worker = 1**
  (the default; §4 sweeps 1 vs 2 as a secondary axis). Reserve `JOB_RESERVE =
  FUSE_MAX_JOB_BYTES + FUSE_MAX_JOB_FILES*16 + CLONE_SLACK` against the global
  `CiphertextBudget` byte-semaphore **before posting**; on validated receipt,
  atomically convert to per-file `cipherSize` charges and release the slack.
  **Null sink:** the instant a file's ciphertext is received, record its "ready"
  timestamp and immediately `release()` its charge (models design 98 draining
  promptly). Optionally simulate a small settle delay = 0 by default. Ciphertext
  buffers are dropped after release (no disk write). **Spill** (§4.2): if held
  ciphertext exceeds `SPILL_WATERMARK` (75% of budget) and no charge can be
  granted, write the oldest producer-owned undelivered buffer to a temp file and
  release its charge (count spilled bytes/files). With prompt null-sink draining,
  spill should be ~0 except at the smallest budgets — that is a measured signal,
  not a bug.
- **"Ready" for a file = its ciphertext `ArrayBuffer` received + validated** in
  the main isolate (parity with A's "address known"). No framing/reread either.

Both arms: same corpus, same host, back-to-back within one child process run
(A then B for one budget, or one arm per child — see §4). Same `compress: true`.
Same worker count. Only batching + temp-vs-memory I/O differ.

## 2. Corpus (`rig/d99-p0/corpus.ts`) — §5.1 profile, documented

Many small files (fuse population is `≤ 256 KiB` plaintext). Seeded PRNG so a
given `(seed, N)` reproduces the exact corpus. Document the histogram in the
generated report. Default histogram (dev-workspace / source-tree shaped, heavy
tiny-file tail):

| bucket | plaintext size | share | notes |
|---|---|---:|---|
| empty | 0 B | 3% | `__init__.py`, `.gitkeep` — exercises tag-only ct |
| tiny | 1–512 B | 22% | below/around `COMPRESS_MIN_BYTES` edge |
| small | 512 B–2 KiB | 30% | bulk of a source tree |
| med | 2–8 KiB | 22% | |
| large | 8–32 KiB | 13% | |
| xl | 32–128 KiB | 7% | |
| near-cap | 128–256 KiB | 2% | fuse-eligible upper edge |
| over-cap | 256 KiB–1 MiB | 1% | **not** fuse-eligible → single-file both arms |

- **Content mix:** ~60% compressible (repetitive text / pseudo-JSON / source-like
  tokens → zstd keeps), ~40% incompressible (seeded random bytes → zstd rejects,
  ct over raw plaintext). This exercises **both** the compression-kept and
  compression-rejected `encSha` paths in the determinism oracle. Content is
  unique per file (per-file seed) so every file is a **cache miss** — the A/B
  loop only ever processes cache misses (design 99 §2.4, §7.3); dedup is out of
  scope. Document the fuse-eligible fraction (count and bytes) in the report.
- Default `N = 20000`. If run-to-run variance swamps the A/B delta (§4), scale N
  up (50000) until the signal is clean; the real first-publish is ~105k files.

## 3. Determinism oracle (`rig/d99-p0/determinism.ts`) — CRITICAL

Run once, before/independent of the timing sweep. For a boundary + property
sample, encrypt through **both** `encryptFileToTempInline` (untouched oracle,
imported from `src`) and the harness `core.ts` `encryptBytesInMemory`, and
assert **byte-identical** `(plaintextSha, encSha, cipherSize, comp, payloadSha)`
**and** identical ciphertext bytes for **every** file. Boundary/property matrix
(design 99 §7.1):

- empty (0 B); sizes `128∓1` (`COMPRESS_MIN_BYTES` edge); a file at the
  `COMPRESS_RATIO` keep/reject edge; `256 KiB ∓ 1` (`FUSE_MAX_FILE_BYTES` edge);
  fully incompressible vs highly compressible; a handful spanning the histogram.
- Use the **same `expected` tuple** and **same kek** for both.

If the two paths ever disagree on ciphertext/`encSha`, that is a **CRITICAL
finding for design 99** (the E2EE determinism oracle would fail): the harness
must print `DETERMINISM: FAIL` loudly, write the failing case (sizes/hashes
only, no paths), and the report's verdict section must surface it. A green
`DETERMINISM: PASS` is a precondition for trusting the B-arm timings.

## 4. Sweep matrix, runs, statistics

- **Worker count `N`:** default = `configuredWorkers()` on the host (record it);
  pin identically for both arms via `RBOX_CRYPTO_WORKERS`.
- **Primary sweep — budget (Arm B):** `CIPHERTEXT_BUDGET_BYTES ∈ {24, 48, 96,
  192} MiB`. Arm A has no budget (control), run once per pass.
- **Secondary sweep — fused in-flight/worker:** `{1, 2}` at the selected budget
  (informs design 99 §11 Q3). Keep primary sweep at in-flight = 1.
- **Runs per cell:** ≥5 warm runs (warm page cache). Rationale for warm-primary:
  the audit (design-81 tmpfs experiment "moved nothing", lines 592–593) shows the
  residual is **per-job runtime + syscall overhead, not disk bandwidth** — warm
  runs isolate exactly what fusion attacks; cold runs add equal disk-read noise
  to both arms. Attempt a best-effort cold pass (drop page cache if permitted:
  `/proc/sys/vm/drop_caches`); if not permitted, record "cold: unavailable
  (no privilege)" and proceed warm-only, clearly labeled.
- **Passes:** run the whole sweep **≥2 times** end-to-end; report run-to-run and
  pass-to-pass variance (p50 + [min,max] range). If the A/B p50 delta is within
  the noise range, **increase N and rerun** until the signal is clean; state the
  final N.
- **Statistics (audit benchmark protocol):** report p50 and [min,max] range per
  metric per cell; change **one variable at a time**; keep A as the retained
  control for every comparison. The headline delta is
  `(A_p50 − B_p50) / A_p50` on the encrypt critical-path wall.
- **Exact run command (acceptance):**
  `bun rig/d99-p0/run.ts --files 20000 --budgets 24,48,96,192 --runs 5 --passes 2`
  Also support `--inflight 1,2` for the secondary sweep and `--determinism-only`.
  The runner must (a) run the determinism oracle, (b) generate the corpus once
  per pass (seeded), (c) spawn a fresh child `bun` per (arm, budget, inflight,
  run) so `maxRSS` is per-cell, (d) aggregate, (e) emit
  `results/results.csv`, `results/results.json`, and `results/REPORT.md`.

## 5. Metrics (per cell; counts/bytes/durations/hashes/ordinals only)

Emit for every cell (arm, budget, inflight, pass, run):

- **encrypt critical-path wall ms** — first-file-start → last-file-ready
  (the gate metric).
- **per-job overhead** — Arm A: main-side enqueue→resolve latency p50/p99;
  message count (= file count). Arm B: `jobWallMs` (worker msg-received →
  results-posted) and `payloadCryptoMs` (Σ per-file read+hash+compress+encrypt+
  encSha) per job → per-job overhead = `jobWallMs − payloadCryptoMs`; job count.
- **queue wait ms** — time from enqueue to dispatch/post, p50/p99.
- **peak RSS** — `process.resourceUsage().maxRSS` (KiB→bytes) for the child; plus
  a high-frequency `process.memoryUsage().rss` sampler max (record both; note
  workers are threads in the same OS process so this is process-wide, per design
  99 §8 gate 3).
- **CiphertextBudget high-water bytes** (Arm B) — must never exceed the cell's
  budget; also the peak count of concurrently-held per-file charges.
- **temp bytes written** — Arm A: Σ per file `(plaintextSize [snapshot] +
  cipherSize [ct temp])` (exact from returned blob + known sizes; buffered
  compress ≤4 MiB writes no compressed temp). Arm B: spilled bytes only
  (0 expected at healthy budgets).
- **peak FD count** — high-frequency sampler of `/proc/self/fd` entry count
  (Linux); report peak. Fusion should **reduce** FDs.
- **worker utilization** — busy-ms/wall per worker if observable (best-effort).
- **throughput** — files/s and plaintext MiB/s.

## 6. Deliverables the runner emits

1. `results/results.csv` + `results/results.json` — one row/object per cell with
   all §5 metrics, p50 + range across runs/passes.
2. `results/REPORT.md` — a short markdown report containing:
   - corpus histogram actually used + fuse-eligible fraction (count, bytes),
     final N, worker count N, host descriptor (CPU count, platform, filesystem),
     warm/cold state.
   - **A/B encrypt-wall delta table** (per budget): `A_p50`, `B_p50`, delta %,
     range; the headline delta.
   - **RAM-vs-throughput curve table**: budget → B_p50 wall, throughput,
     peak RSS, budget high-water, spilled bytes — the curve that selects the
     budget (knee: smallest budget whose throughput is within a small margin of
     the largest budget's).
   - per-job overhead + queue-wait + temp-bytes + FD summary (A vs B).
   - `DETERMINISM: PASS|FAIL` + boundary-case count.
   - **SELECTED `CIPHERTEXT_BUDGET_BYTES`** + one-line rationale from the curve.
   - **GATE VERDICT:** `GO` iff B_p50 encrypt wall ≥30% below A_p50 at the
     selected budget with peak RSS ≤ A + budget + 32 MiB slack and FD count ≤ A;
     else `NO-GO` stated plainly (a NO-GO kills the Phase-1 build and is a valid
     result — do not massage the numbers).
   - run-to-run variance notes.

## 7. Acceptance

- `bun rig/d99-p0/run.ts --determinism-only` prints `DETERMINISM: PASS` (or a
  loud, specific FAIL) and exits non-zero on FAIL.
- The full command in §4 runs end-to-end on this host and deterministically
  emits `results/results.csv`, `results/results.json`, `results/REPORT.md`.
- No path/filename appears in any emitted artifact (grep the outputs for the
  corpus dir — must be absent).
- Production `src/` is unmodified (`git status src/` clean).

## 8. Amendments during execution (2026-07-11)

Recorded so the spec matches what actually ran; motivated by the codex
adversarial review (BIASED-TOWARD-B verdict on the first build) and by
anomalies in the first sweep:

1. **Uniform cache warming + interleaved cell order** (review CRITICAL 1): the
   corpus is read once after generation, and each run executes A then all B
   cells, so no arm inherits another's page-cache warming. Cold runs remain
   unavailable without drop_caches privilege; the report says so.
2. **Arm A caller width = workers*2** (review MAJOR 2), matching production
   `poolMap(toEncrypt, encryptConcurrency(poolWorkers))`.
3. **Arm A clock starts after pool spawn** (parity with B's pre-started
   workers).
4. **Over-cap files (>256 KiB) in Arm B go through the untouched oracle
   temp path** (design 99 §3) rather than the in-memory path; their temp bytes
   are counted.
5. **Settlement-residence mode** (`--settle N`, review MAJOR 4/6): per-file
   charges are held N ms after receipt to model §4.1 lease residence; the
   budget curve is taken from the residence sweep, settle=0 remains the §5.3
   gate measurement. **Spill (§4.2) is implemented** (75% watermark,
   producer-held victims, real spilled-bytes reporting; review MAJOR 5).
6. **Global dispatch cap axis** (`--maxjobs N`): added after the first sweep
   showed BOTH arms collapse with worker concurrency (streaming-zstd
   contention; see Phase-0 results in the design doc). The cap bounds
   concurrently in-flight worker jobs, separating the dispatch-concurrency
   knob from the memory-budget knob that the first sweep conflated.
7. **Statistics** (review CRITICAL 3 / MAJOR 7): bootstrap 95% CI on the p50
   delta from per-run walls; per-pass p50s emitted; gate requires the CI
   entirely above the +30% margin.
8. **Honest metrics only** (review MAJOR 8/9): Arm A no longer emits
   placeholder queue-wait/overhead fields (pool internals are not observable
   without touching src/); B's peak held charges are tracked as a real
   concurrent count.
9. **Determinism matrix widened** (review MINOR 10/11): 33 cases including
   zstd-ratio keep/reject edge fixtures and 64 KiB stream-chunk boundaries.
10. **Sync-zstd byte-compatibility probe**: `zstdCompressSync` (with and
    without contentSizeFlag, any windowLog accepted by Bun) does NOT reproduce
    streaming `createZstdCompress` bytes (different frame header AND different
    block decisions on mixed content / ≥128 KiB inputs) — so the fused path
    keeps the streaming compressor; the sync-zstd speedup is recorded as a
    design-level finding, not adopted.
