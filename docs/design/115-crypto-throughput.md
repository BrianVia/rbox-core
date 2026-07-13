# 115 — Crypto throughput after blob packing

Status: **SHELF DESIGN — drafted for the future, NOT scheduled; no review loop run. Trigger to activate: a fleet host or user measurably crypto-bound (encrypt wall > upload wall on a >200Mbps effective pipe).**

This is a parked map, not a work order. The measurements and choices below are
enough to restart the investigation without prematurely selecting an
implementation.

## Problem

Design 114 removes the small-object operation-rate ceiling by packing already
encrypted blobs into bandwidth-sized R2 objects. That changes the likely first-
publish bottleneck by workload complexion:

- small-pipe users should remain uplink-bound;
- compressible code/text users may still benefit enough from zstd to justify its
  CPU cost; and
- media-heavy users are likely to hit the next wall first, because JPEG, MP4,
  zstd, and similar content pays compression CPU while yielding nearly the same
  number of ciphertext bytes.

On `flat-meadow` (16 threads), the 2026-07-13 run encrypted 2.77 GB of
ciphertext in 80.6 s, or approximately **275 Mbps**:

```text
2.77 GB * 8 / 80.6 s ~= 0.275 Gb/s
```

The host's pipe is approximately 630 Mbps. Once design 114 lets packed uploads
approach the pipe, 275 Mbps of crypto production cannot keep it fed. Encryption
already overlaps upload through the design-99 fused path and the design-98/99
publish pipeline, so this is not primarily a request to add overlap. It is a
request to make the producer itself faster, but only after a real fleet run
satisfies the activation trigger in the status line.

## Evidence

### What the 275 Mbps includes

The current fused unit is not “AES.” For each eligible file,
`crypto-worker.ts` receives an `encryptBatch` entry containing `srcPath`, the
expected plaintext SHA/size, and options. It then does, serially within that
worker job:

1. `fs.readFile(srcPath)`;
2. SHA-256 of the plaintext, required to reject a changed source;
3. zstd level 3 for every compression-enabled file of at least 128 bytes;
4. when compression wins the `< 0.95 * plaintext` test, SHA-256 of the compressed
   payload and HKDF-SHA-256 key/nonce derivation;
5. AES-256-GCM over the chosen payload; and
6. SHA-256 of `ciphertext || tag` to produce `encSha`.

There is also allocation and worker handoff cost. The worker builds
`body || GCM-tag`, slices it to an exact `ArrayBuffer`, and returns one result
record per file. The protocol uses an `ArrayBuffer[]` transfer list, so the
ciphertext payload should transfer rather than clone, but the job/result arrays
and descriptors are still structured-cloned and scheduled. The main isolate
validates every result and converts the transferred buffer into a leased
`Uint8Array`. In the current Tier-1 publish path, `materializeLease` then writes
that memory ciphertext to a temp file for the existing file-backed uploader.

The pool already coalesces up to 4 MiB or 512 files per `encryptBatch`. It may
create up to 16 workers, but permits only four fused jobs globally by default.
That bound is evidence, not an arbitrary conservative default: design 99's
phase-0 work found streaming zstd at 16-way concurrency **5–6x slower** than at
four. The `CiphertextBudget` independently caps live in-memory ciphertext at 96
MiB and spills at pressure. More workers therefore cannot be presumed to add
throughput while zstd remains the contended stage.

### The one profiling experiment to run on activation

Run one instrumented, null-upload replay of the same pinned `flat-meadow`
snapshot that produced the 2.77 GB result, using the shipped worker count,
`RBOX_CRYPTO_FUSE`, 96 MiB budget, four-job dispatch bound, compression settings,
and Bun build. Repeat the single experiment enough times for a warm p50 (five is
sufficient for this decomposition; it is not an acceptance benchmark).

Behind a profiling-only flag, aggregate byte counts and monotonic timestamps by
workload complexion and size bucket for:

```text
main queue -> worker receive
read
plaintext SHA-256
zstd (split into kept vs rejected output)
payload SHA-256 + HKDF
AES-256-GCM
ciphertext SHA-256
result assembly/post -> main receive/validation
Tier-1 materialize write
```

Also capture one Bun CPU profile/native-symbol sample during the replay. The
timers give attributable wall/CPU work; the profile catches native contention,
copies, GC, and time inside zstd or BoringSSL that timer sums can misdescribe.
Report totals and distributions only—never paths. This one run answers whether
the next design should target zstd, hashing/AES, job handoff, materialization, or
contention; no optimization should be selected from the 275 Mbps aggregate
alone.

### AES is probably not the unclaimed easy win

The implementation already calls Bun's `node:crypto.createCipheriv("aes-256-gcm",
...)`, not a JavaScript AES implementation. Bun 1.3.14 statically links
[BoringSSL](https://bun.sh/docs/project/license), and Bun documents
`node:crypto` as an implemented compatibility surface
([compatibility status](https://bun.sh/docs/runtime/nodejs-compat)). On supported
CPUs, a separate “hardware AES” route is therefore likely to reach the same
native primitives and be a no-op. The profiling run should confirm native AES
cost and CPU feature use before any API or native-addon experiment.

## Options

### A. Tune zstd level, minimum size, and keep threshold — cheap

Sweep level 1 versus level 3, a higher `COMPRESS_MIN_BYTES`, and the keep-ratio
threshold by complexion. This is a small code/config change and likely helps
code-heavy corpora somewhat. The honest cost is extra ciphertext and upload
bytes when compression is weakened, plus changed compression descriptors and
`encSha` values for decisions that differ from existing clients. It cannot be
judged on crypto Mbps alone; saved CPU must exceed added upload wall at the
target pipe.

### B. Skip compression for already-compressed content — likely largest win

For media-heavy complexions, avoiding futile zstd work is the strongest
candidate because it removes a whole pass while barely changing wire bytes.
JPEG, MP4, zstd frames, and other known compressed containers are initial
families to measure.

An extension-only rule is rejected: identical bytes named `a.jpg` and `a.bin`
must not encrypt differently. Extension may select a probe, but the decision
must be a deterministic function of content bytes (for example, validated magic
plus a byte-derived compressibility probe). It must also report how often its
decision differs from today's full-zstd `<0.95` oracle. A differing decision is
still cryptographically sound if deterministic, but causes cross-version
address/dedup churn; the active design must either prove that acceptable or keep
the oracle-compatible result. False “incompressible” classifications are the
main risk.

### C. Larger jobs or per-worker pipelining — medium

Raise the 4 MiB/512-file envelope, or pipeline reads/native operations inside a
worker so one job is not a strictly serial file loop. This can reduce message,
result-array, scheduling, and Tier-1 materialization overhead if the profiling
run assigns meaningful time there.

Costs are higher head-of-line delay, later time-to-first-ciphertext, more live
ciphertext per job, larger failure/retry units, and pressure on the 96 MiB
budget. Per-worker pipelining can also recreate the same zstd contention as
raising the global dispatch bound. Any version must retain transfer-list
handoff, byte-bounded reservations, split retry, and prompt lease release.

### D. Add a Bun/BoringSSL “hardware AES” path — probably no-op

Only pursue this if the profiling run shows AES-GCM is material and a standalone
microbenchmark proves another Bun API or native binding is faster on the same
host with byte-identical output. Otherwise this adds a runtime-specific path,
packaging burden, and a new cryptographic implementation seam for facilities
the current BoringSSL-backed call likely already uses.

### E. Add more workers — conditional, not a first move

The pool already reaches 16 workers while fused dispatch is capped near four
because zstd scaled negatively. Re-sweep worker count and dispatch only after a
compression change removes or reduces that contention. More workers also cost
roughly budgeted memory, file descriptors, scheduling, and may lower rather than
raise throughput.

## Recommended direction

When the trigger fires, start with the decomposition run, then optimize in this
order:

1. compression-skip classification for media-heavy content;
2. zstd level/threshold tuning for the remaining compressible population;
3. job granularity or per-worker pipelining if measured marshalling/scheduling
   remains material;
4. a fresh worker/dispatch sweep after zstd pressure changes; and
5. AES-path work only with direct evidence that the existing BoringSSL-backed
   primitive is a bottleneck.

This order follows expected reclaimed wall per unit of complexity. It is not a
pre-approval of any option. In particular, a media optimization should be
evaluated on a media-heavy corpus; averaging it into the existing code-heavy
upload sweep can hide the users most likely to be crypto-bound.

### E2EE and storage invariants that do not move

Any activated design must preserve:

- **Per-blob protection.** AES-256-GCM keys/nonces remain derived per blob from
  the workspace/key-epoch KEK and exact payload SHA; the per-blob GCM tag/MAC is
  retained. No pack-level key, MAC, or cross-blob compression replaces it.
- **Convergent, content-derived output.** A compression/skip choice must not
  depend on path, scheduling, worker, host load, or upload state. Identical
  content under the same KEK/key epoch and algorithm rules must yield identical
  ciphertext and `encSha`.
- **Content addressing.** `encSha` remains SHA-256 of the complete per-blob
  `ciphertext || tag`; plaintext verification and source-change checks are not
  dropped to gain speed.
- **Receipt and retention semantics.** Design 96 retained-root reachability and
  design 102 receipt/admission/deletion-fence rules continue to operate on each
  logical `encSha`. Design 114 may change physical placement, never these
  logical identities or their accounting.
- **Bounded pipeline ownership.** The design-99 transfer protocol,
  `CiphertextBudget`, retry isolation, and lease lifetime remain bounded unless
  an active design supplies a reviewed replacement invariant.

## Validation sketch

Activation should produce three pinned corpus complexions with equal plaintext
byte targets and recorded file-size histograms:

- compressible code/text;
- the existing mixed upload-sweep corpus; and
- media-heavy (predominantly valid JPEG/MP4/zstd or similar containers).

First run a local/null-upload crypto replay for stage attribution and
determinism. Then extend `rig/upload-sweep` (or a sibling using its identity,
dev-only, repeat, and result-capture rails) to run packed uploads with the same
corpora and record ciphertext bytes, first/last ciphertext-ready timestamps,
upload critical-path wall, packed upload wire Mbps, CPU saturation, peak RSS,
budget high-water/spills, FDs, and time to first upload. `encrypt wall` for the
gate must mean first crypto dispatch to last ciphertext ready, not the enclosing
overlapped upload phase.

The activation design should set exact statistical margins, but its minimum
acceptance shape is:

1. **Enc-throughput gate:** on every complexion, warm p50
   `8 * ciphertextBytes / encryptReadyWall` is at least **1.10x the same run's
   achieved packed-upload wire Mbps** on the >200 Mbps pipe. This proves crypto
   has moved off the critical path rather than merely improved from 275 Mbps.
2. **Media gate:** the media-heavy corpus improves encrypt-ready wall materially
   without a material ciphertext-byte increase; report zstd bytes attempted,
   kept, rejected, and skipped.
3. **Correctness gate:** differential output against the chosen compatibility
   oracle, GCM/decrypt/plaintext-hash checks, a fresh receiver byte diff, and
   design-96/102 receipt/retention/GC scenarios all pass.
4. **Resource/readiness gate:** the 96 MiB ciphertext budget never overdraws;
   RSS/FD/spill remain within named bounds; and time-to-first-upload and p99
   ciphertext readiness do not regress beyond stated non-inferiority margins.
5. **Honest end-to-end gate:** full publish wall becomes upload-bound on the
   activation host. If both walls improve but encryption remains longer, the
   trigger is not resolved and the design does not ship as complete.

No implementation, CODEMAP change, deployment, or fleet experiment is proposed
by this shelf document.

## Addendum (founder food-for-thought, 2026-07-13)

The fused-dispatch bound (`FUSE_DISPATCH_BOUND_DEFAULT = 4`) encodes a memory-
BANDWIDTH knee, not a core-count one — tuned on dual-channel DDR4 x86 (both
Ryzens, ~50GB/s shared). The M2 Max's unified memory (~400GB/s) almost
certainly supports a much higher bound. Channel/DIMM topology is not portably
queryable and predicts poorly anyway; if this design activates, prefer a ~1s
startup calibration (measure 2/4/8 concurrent zstd jobs, keep the knee, cache
per host) over per-arch constants. The fleet's three memory architectures
(2× dual-channel x86, 1× unified ARM) are the natural validation matrix.
