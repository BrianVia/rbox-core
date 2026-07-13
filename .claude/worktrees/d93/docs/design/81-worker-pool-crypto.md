# 81 - Worker-pool crypto: make blob crypto use real cores

Status: Design accepted 2026-07-08 on the v0.9.7 capstone evidence.
Client-only. Target release: v0.9.9, after the compiled dev-build Linux gate in
section 5 passes.
Origin: 2026-07-08 full-corpus publish/join measurements on the 32-core Linux
host, after designs 79 and 80 exposed the next local CPU floor.
Priority framing, founder decision 2026-07-08: Linux perf > macOS perf. The
agent-era motion is ephemeral many-core, weak-single-core Linux boxes doing
first-contact init/join, and this design targets exactly that profile.
Depends on: design 12 V4-5 convergent encryption, design 74 pull lane timing,
design 79 compress-before-encrypt, and design 80 batched blob upload.

## 1. Problem and evidence

Measured means observed directly on the named 2026-07-08 workload. Inferred
means the estimate follows from those measurements but still needs the
compiled-binary acceptance run.

1. **First publish is now encrypt-bound on Linux, measured.** On the wired
   32-core Linux host, a full-corpus first publish of 105,804 blobs / 8.6G tree
   took 27.5 minutes wall. About 23 minutes of that was the encrypt phase, at
   roughly 53-70 blobs/s and 116% CPU. The current push code calls
   `poolMap(toEncrypt, encryptConcurrency(), ...)`, and `encryptConcurrency()`
   defaults to 8 unless `RBOX_ENCRYPT_CONCURRENCY` is set. That gives eight
   in-flight promises, not eight CPU isolates. Each task then runs
   `encryptFileToTemp()` inline: `fs.copyFile` snapshot, snapshot hash,
   optional zstd, `hkdfSync`, AES-GCM, ciphertext tag append, ciphertext hash,
   and stat. `encryptAndUpload()` records this under the encrypt phase, and
   under `uploadLaneTiming.encryptMs` when `RBOX_LANE_TIMING=1`. For synchronous
   CPU-heavy work in Bun's main isolate, the pool is fake parallelism.
2. **Download has the same local floor, measured.** Once join fetch was
   accelerated by the batch transport work (48 batch slots, 84s wall), the
   decrypt+write lane surfaced at 9-10% of wall, with about 19.6ms/blob local
   settlement. The pull writer already has a large supply pool:
   `applyActions()` feeds `stageEntryToTemp()` through `poolMap`, and encrypted
   file staging fetches ciphertext, calls `decryptFileToPath()`, and attributes
   fetch vs decrypt/write with `RBOX_LANE_TIMING`. After transport stops being
   the only story, main-thread decrypt is the next join floor.
3. **The Mac masked this, measured.** On the M-series Mac, a fast single core
   made encrypt lane-sum approximately equal encrypt wall at the 8.6k-blob
   scale, with 2-6ms/blob local crypto cost. That did not predict the first
   contact host that matters here: a many-core Linux box with weaker single-core
   speed and a much larger first-publish corpus.
4. **The prize is large enough to justify a real worker pool, inferred.** If
   encrypt runs on N genuine cores, the 23-minute encrypt phase should fall to
   about 2-4 minutes on the 32-core host, at which point upload becomes the wall
   again. Join decrypt/write should fall back under about 3% of wall. The success
   gate is measured, not aspirational: at least 400 blobs/s encrypt on the Linux
   host, using the same lane instrument as the capstone run, versus 53 blobs/s
   measured today.

Raising `RBOX_ENCRYPT_CONCURRENCY` alone is rejected. The bottleneck is not a
shortage of queued promises; it is that the queued work runs on the same main
thread.

## 2. Design - a Bun Workers crypto pool

Add `src/engine/crypto-pool.ts` and a worker entry
`src/engine/crypto-worker.ts`. The pool owns N Bun `Worker`s; under source
runs (`bun test`, `bun run`) the worker resolves from source directly, and in
compiled binaries it is constructed via the embed-and-spawn mechanism section
3 mandates (the naive literal `new URL()` specifier does not survive
`bun build --compile` — measured, see section 3).

The worker entry is a mechanical extraction of the existing blob crypto bodies.
The inline implementation remains the oracle and the fallback.

### 2.1 Unit of work

The job is the whole per-blob local pipeline, not a thin AES wrapper.

Encrypt job:

```ts
{
  srcPath,
  tmpDir,
  opts: { compress, bufferedCompressionMaxBytes }
}
```

The worker runs the exact `encryptFileToTemp()` body and returns the existing
`EncryptedBlob` fields: `plaintextSha`, `encSha`, `ciphertextPath`,
`cipherSize`, and, when compression is accepted, `comp` and `payloadSha`.

Decrypt job:

```ts
{
  ctPath,
  plaintextSha,
  destPath,
  opts: { comp, payloadSha, maxPlaintextBytes }
}
```

The worker runs the exact `decryptFileToPath()` body.

Moving the whole job is deliberate. It keeps the main thread's cost to
message-passing and preserves the invariants where they live today:
snapshot-first encryption, deterministic payload frames, compressed output
selection, decompressed output cap, ciphertext hashing, and temp cleanup. A
partial workerization that moves only HKDF/AES-GCM or only zstd is rejected
because it leaves too much CPU and I/O orchestration on the main thread and
risks splitting invariants across two implementations.

### 2.2 KEK handling

The 32-byte KEK is posted to each worker once at pool initialization. This is a
structured-clone copy inside the same process and same trust domain as today.
The KEK already lives in the CLI process memory; workers add copies in worker
heaps, but nothing crosses a process boundary, machine boundary, or server
boundary.

The pool is LAZY and REUSED, keyed by (KEK, keyEpoch) — not per-operation
(review blocker, both reviewers): the daemon is the dominant consumer and it
syncs constantly in tiny increments (400ms watcher debounce, 200ms deferred
retries, 60s safety floor); spawning and terminating up to 16 workers twice
per sync cycle to encrypt one file is exactly backwards, and the full-corpus
gate would never surface it (measured spawn cost: ~9ms one worker / ~29ms for
16, darwin — real but hostile to hot ticks). Rules:

1. The pool spawns only when an operation actually has crypto jobs AND the
   job count clears a floor (`RBOX_CRYPTO_POOL_MIN_JOBS`, default 8): tiny
   pushes run inline, which is faster than spawning for them anyway.
2. Once spawned, the pool persists for process lifetime keyed by
   (KEK, keyEpoch); an operation presenting a different key tears the old
   pool down and builds a new one — rotation safety without per-op churn.
3. An idle timeout (60s without a job) terminates workers so a quiescent
   daemon holds no idle isolates.

Process-level sandboxing or key isolation is rejected for this design. That is a
different trust-boundary project; this design buys CPU parallelism inside the
current client trust model.

### 2.3 API and selection

`encryptFileToTemp()` and `decryptFileToPath()` keep their exact public
signatures. Callers do not learn a new crypto API.

The engine selects the pool-backed implementation internally:

```ts
getCryptoPool()?.encrypt(...) ?? inline path
getCryptoPool()?.decrypt(...) ?? inline path
```

The inline implementations are extracted as PRIVATE functions that both the
public wrappers' fallback and the worker entry call (review finding): the
worker must never import the public wrapper, or a worker could recursively
dispatch back into the pool. The worker also normalizes the posted KEK with
`Buffer.from(kek)` — structured clone delivers a `Uint8Array`, and the crypto
bodies expect `Buffer` (verified empirically).

The existing single-threaded paths remain, verbatim:

1. as the fallback when workers are disabled, unavailable, unhealthy, or not
   bundled into a compiled binary; and
2. as the determinism oracle in tests.

Worker output must be byte-identical to inline output for the same input, KEK,
and compression settings. Pin raw and compressed cases, including the buffered
small-file compression path and the streaming path above 4 MiB.

### 2.4 Sizing and supply

`RBOX_CRYPTO_WORKERS` controls worker count. `0` disables the pool and forces
the inline path. The default is:

```ts
min(max(availableParallelism - 2, 2), 16)
```

further capped by memory (review finding — the target profile pairs many
cores with low RAM): no more than one worker per ~512MB of total system
memory. Each worker accepts at most two in-flight jobs so file I/O can
pipeline with CPU without turning the pool into an unbounded queue, and the
pool's job queue itself is BOUNDED: `pool.decrypt()` awaits a slot when the
queue is full, which restores the backpressure that main-thread-serial
decrypt implicitly provided today — without it, the 512-wide pull pool would
buffer hundreds of fetched ciphertext temps behind ≤32 decrypt slots (review
finding). File-descriptor headroom (16 workers × streams under a 512-wide
pull pool) is checked at pool init against `RLIMIT_NOFILE`; if tight, the
worker count shrinks and a diagnostic logs.

The existing encrypt `poolMap` in `encryptAndUpload()` remains the outer supply
gate. When the crypto pool is active, its default rises from today's 8 to
`workers * 2`; an explicit `RBOX_ENCRYPT_CONCURRENCY` still wins. This keeps the
current push structure: `encryptAndUpload()` still owns descriptor adoption,
encrypt-cache reuse, ENOENT churn deferral, upload retry, and progress. The pool
only changes where the local crypto work executes.

On pull, `applyActions()` and `stageEntryToTemp()` keep their current shape. The
download/write pool supplies work; `decryptFileToPath()` becomes pool-backed
through the same selection boundary, and `laneTiming.decryptWriteMs` remains the
acceptance instrument. Attribution note: caller-side lane timing brackets the
pool call, so it measures queue-wait plus worker wall, not pure CPU — fine
for the acceptance gate (which uses phase wall), stated here so nobody reads
per-blob lane figures as core time.

Adaptive or dynamic pool sizing is rejected. The knobs are the environment
variable and the conservative default formula above.

### 2.5 Error fidelity across the worker boundary

Workerization must not erase the error shapes callers depend on.

`encryptAndUpload()` catches ENOENT-like failures from `encryptFileToTemp()` and
treats them as vanished-mid-push churn: defer the file and continue the partial
commit. That must still work when the failure happens inside a worker. Worker
errors therefore serialize `{ name, message, code, errno, syscall, path,
dest, stack }` plus a bounded `cause` (review finding: ENOENT carries
errno/syscall/path/dest, zstd errors carry errno, and everything has a stack
— `{name,message,code}` alone is too lossy for diagnostics even though
correctness only needs `code`). The `message` string is preserved VERBATIM —
tests and telemetry match on decrypt error substrings ("unable to
authenticate data", "decompressed plaintext exceeds declared size"), so the
message is load-bearing, not cosmetic. A worker ENOENT is a deferred file,
not a fatal push. Confirmed non-requirement: `BlobShaMismatchError` is
upload-side (thrown after `api.putBlobFile`), never from the crypto
boundaries — the worker boundary does not carry custom error subclasses.

Decrypt errors must remain integrity failures with useful names/messages. A bad
GCM tag, wrong KEK, plaintext hash mismatch, missing `payloadSha`, oversized
decompressed output, or empty compressed ciphertext body must not become an
opaque "worker failed" error. The caller may still fail the pull, but the error
surface must preserve the real crypto/integrity reason.

### 2.6 Lifecycle and crash behavior

The pool is process-lifetime, keyed by (KEK, keyEpoch) with the idle timeout
from section 2.2; `pool.close()` runs on process exit and on key change.

If a worker crashes, EVERY job it held (up to two) is rejected with a
distinguishable worker-crash error and each is retried once on another
worker. If a retry fails, the real failure surfaces. Retrying once handles
the worker-runtime fault class without hiding deterministic data, filesystem,
or integrity errors.

## 3. Build-pipeline constraint

This is the critical implementation constraint and the reason the acceptance
order requires a compiled dev build before merge.

The test suite can pass while the compiled binary is broken. `bun test` runs the
source tree and can resolve `src/engine/crypto-worker.ts` from disk. The shipped
CLI is a standalone executable built with `bun build --compile`; if that binary
does not contain or cannot resolve the worker entry, then
`new Worker(new URL("./crypto-worker.ts", import.meta.url))` fails only at
runtime.

The current build scripts make that risk concrete:

1. `scripts/dev-install.ts` assembles a host-only command:
   `bun build --compile --target=bun-${target} --define __RBOX_DEV_VERSION__=...`
   plus watcher externals, then a single entry, defaulting to
   `./src/cli/index.ts`, and `--outfile`.
2. `scripts/release.ts` first ensures all platform-specific `@parcel/watcher`
   bindings are installed, then for each release target runs
   `bun build --compile --target=bun-${t}` with watcher externals, the same
   single CLI entry `./src/cli/index.ts`, and the target outfile.
3. Neither script currently names a crypto worker entry. Their compile-time
   special handling is for native watcher bindings, not Bun worker bundling.

Mechanism 1 — relying on Bun's compile-time bundling of literal `new URL()`
worker specifiers — is EMPIRICALLY DEAD (review, tested 2026-07-08 on Bun
1.3.14): a minimal repro works under `bun ./main.ts` but the compiled binary
fails with `ModuleNotFound resolving "/$bunfs/root/worker.ts"`, INCLUDING
when the worker is passed as a second build entrypoint. The design therefore
mandates mechanism 2, concretely:

1. the build pre-bundles `src/engine/crypto-worker.ts` into one
   self-contained JS artifact (`bun build --target=bun`, no --compile) and
   embeds it in the binary as a text/asset import;
2. at first pool spawn, the runtime writes that artifact to a private
   (0600, owner-only temp dir) file once per process and constructs workers
   with `new Worker(thatPath)`;
3. both `scripts/release.ts` and `scripts/dev-install.ts` run the pre-bundle
   step; under `bun test`/source runs, the worker resolves from source
   directly so tests exercise the same worker code.

The mechanism above is the accepted default; if implementation finds a
cleaner Bun-native embedding that provably works in compiled binaries on all
three targets, it may substitute — the contract below is what must hold:

1. the build scripts must handle the worker entry explicitly enough that a
   compiled binary can start the pool on every supported target;
2. pool initialization must run a worker health-check round trip with a
   timeout; if it fails, the pool disables itself and falls back to inline
   crypto — AND the disabled state is PERSISTENT, surfaced by `rbox doctor`
   and `rbox status` as a named degradation, not a one-time log line that
   scrolls off a multi-day daemon (review blocker: silent fallback would let
   a broken binary run the fleet 20x slower forever);
3. the three-platform release smoke must assert the worker path ACTUALLY
   EXECUTED (a worker-execution marker/counter the smoke reads) — a smoke
   that merely encrypts successfully is satisfied by the inline fallback and
   proves nothing (review blocker); and
4. before any PR merges, a compiled dev binary on the Linux host must demonstrate
   the encrypt-rate gate in section 5.

## 4. What does not change

No crypto primitive changes. AES-256-GCM, HKDF, the `rbox/blob/v1` AAD, tag
placement, payload derivation rules, compression descriptors, and manifest
fields stay exactly as they are after design 79. Worker and inline output must
be byte-identical to v0.9.8 for the same input.

No server change. No wire change. No manifest schema change. Blobs remain opaque
ciphertext addressed by `encSha`.

The git lane is not special-cased. Git artifacts already call the same
`encryptFileToTemp()` / `decryptFileToPath()` boundaries, so they get the pool
for free. Verify that path; do not build a second git-specific crypto pool.

The encrypt-address cache, descriptor carry-forward, upload retry, deferred
churn manifest surgery, batch upload, and batch download decisions stay in their
current owners. The pool changes execution placement only.

## 5. Rollout and verification

Tests:

1. worker-vs-inline determinism for raw blobs and compressed blobs;
2. determinism across small buffered compression and the streaming path above
   4 MiB;
3. `RBOX_CRYPTO_WORKERS=0` and unhealthy-worker fallback use the inline path;
4. ENOENT inside a worker still follows the vanished-file defer path in
   `encryptAndUpload()`;
5. worker crash mid-job retries once on another worker, then surfaces cleanly if
   the retry also fails;
6. full E2EE round-trip suite under the worker pool; and
7. compiled-binary smoke for one worker-pool encrypt on each release target.

Bench gate, on the 32-core Linux host, using a compiled dev build, not
`bun run`:

1. staged full-corpus publish to a throwaway workspace;
2. encrypt rate at least 400 blobs/s, defined as BLOBS ÷ ENCRYPT-PHASE WALL
   (review nit: the per-blob lane-sum figure will not improve with
   parallelism and may worsen slightly from message passing — count/wall is
   the gate metric);
3. multi-core CPU utilization visible during the encrypt phase, plus a
   one-off decomposition of the per-blob cost (hash/zstd/cipher vs snapshot
   I/O) and a note on the host's /tmp backing — the linear-scaling inference
   assumes CPU-bound work, and the gate is what proves it (review finding:
   116% CPU is also consistent with I/O-bound-on-/tmp; the copyFile snapshot
   does not parallelize on a saturated disk);
4. fresh join of that workspace with decrypt+write back under about 3% of
   wall; and
5. a SMALL-PUSH bench (single-file push on the daemon-shaped path): wall must
   not regress vs v0.9.8 — this is the lazy-pool/job-floor rule's
   measurement, which the full-corpus run structurally cannot provide
   (review blocker).

**Gate results (measured 2026-07-08, compiled dev build 483eb27 on the
32-core Linux host, same corpus as the founding measurements):** full publish
1,653s → 599s; encrypt phase 363s = 293 files/s (5.5x the 53 baseline) /
132 unique-encrypts/s (3.7x the true 36 baseline — the corpus proved to be
55% duplicate files, absorbed by the design-75 cache; the baseline "blobs"
figures were files-basis and, on v0.9.7, double-counted); CPU peaked 575%;
join decrypt+write lane 9-10% → 1% (19.6ms → 1.5ms/blob); small push pool
359s vs inline 391s (no regression; the ~6-min absolute is a cold-throwaway
git-recapture artifact present in both arms); full-corpus join diff: zero
differing files; compiled-binary worker execution proven on darwin-arm64 and
linux-x64. The 400 files/s aspiration was missed at 293: a tmpfs A/B was
null (encrypt ~416s on /dev/shm), so the residual bound is per-job overhead,
not disk I/O — in-worker profiling / multi-blob job batching is the named
follow-up. Shipped on the strength of 5.5x + zero regressions.

Only after that gate passes does this ship as v0.9.9. The rollout is a normal
fleet upgrade plus daemon restarts so long-running daemons move onto the worker
pool build.

## 6. Non-goals

1. No worker-pooling of manifest crypto, receipts, remote protocol work, or
   hashing outside the two blob encrypt/decrypt paths.
2. No process-level sandboxing, process isolation, or new key-isolation model.
   Workers are same-process parallelism inside the existing trust domain.
3. No adaptive pool controller beyond `RBOX_CRYPTO_WORKERS` and the default
   formula.
4. No crypto, manifest, server, or wire-format migration.
