# §38 — Parallel multipart upload (per-part retry + progress)

**Status:** DRAFT v1 — first-draft design, no adversarial review yet. Implements proposal
C2 ("Parallel multipart with per-part retry and progress",
`docs/performance-architecture-proposal.md:393-417`). This is a **small, self-contained,
client-only** change: it parallelizes the part-upload loop inside one existing method
(`multipartAttempt`, `src/cli/remote.ts:142-208`) and adds per-part retry. It does **not**
touch the wire protocol, the server, the manifest format, or the resume-token format — the
same init/part/complete endpoints, the same `.rbox/state/uploads/<sha>.json` token, and the
same server-authoritative completed-parts list all stay exactly as they are.

**Implements (forward):** the proposal's ≥2x large-file upload target
(`performance-architecture-proposal.md:801`). **Phase-1 sibling of** §34 (per-account
backpressure) and §36 (blob transfer pipeline) — see Interactions.

**Prior evaluations.** Sequential-per-part multipart was the deliberate original shape
(`docs/design/03-blob-path.md:45`), and this is the *first* time we design parallelizing it —
§26 (batch upload) explicitly scoped itself away from it (`docs/design/26-batch-upload.md:43,49`:
"Not an R2 multi-PUT … Large blobs keep the single-PUT or multipart flow"). So there is no prior
decision to revisit here; the 65k-file / 2.68 GB dogfood is simply the first evidence that
large-file transfer is a felt cost. This is the most build-ready of the Phase-1 docs: it needs
only the existing progress hook, not §35 or §36.

---

## Problem

Large-file upload gets **none** of the fanout that many-small-files get. The client already
runs a 64-wide bounded pool over *blobs* (`poolMap`, `src/engine/pool.ts:11`, driven from
`src/cli/sync.ts`), so a workspace of many small files saturates the link. But a single
large blob that falls through to multipart uploads its parts **strictly sequentially**:

```ts
for (let n = 1; n <= totalParts; n++) {              // remote.ts:179
  if (completed.has(n)) continue;                     // remote.ts:180 (resume skip)
  ...
  const res = await fetch(`.../part/${n}`, { ... });  // remote.ts:184-190 — awaited one at a time
  if (!res.ok) throw new Error(`multipart part ${n} failed: ...`); // remote.ts:190
}
```

Each part is `await`ed before the next begins (`remote.ts:184-190`), so a 2 GB file at a
64 MB part size is 32 serialized round-trips — the wire sits at one-part-in-flight
throughput no matter how fat the link is. The dogfood numbers confirm large-file transfer
is the felt cost: the real `conductor/workspaces` push moved 2.68 GB in 192s and the
cross-host pull took 433s (`performance-architecture-proposal.md:64-68`), with commit time
negligible. A single 2 GB blob inside that set pays full serial latency.

Second defect: **one transient part failure kills the whole file.** A non-2xx on any part
throws out of the loop (`remote.ts:190`), unwinding to `putBlobMultipart`'s catch
(`remote.ts:129-140`), which clears the token and retries the *entire* attempt from a fresh
`multipartAttempt`. A blip on part 30 of 32 discards 29 good parts' worth of progress (they
persisted server-side, so they're skipped on the re-attempt — but the client still tears
down and re-establishes the whole upload instead of just re-sending the one part).

## What must be preserved (the machinery that already works)

The sequential loop is the *only* thing wrong. Everything around it is correct and the
parallel version must keep consulting it verbatim:

- **Server-authoritative resume.** On resume, `GET /v1/blobs/:sha/multipart/:uploadId`
  returns `{ partSize, completedParts }` and builds `completed = new Set(completedParts)`
  (`remote.ts:152-157`). The server is the source of truth for what's already uploaded; the
  loop skips those parts (`remote.ts:180`). A kill/restart mid-upload must **not** resend a
  completed part — the parallel version must consult the **same** `completed` Set.
- **Init.** `POST /v1/blobs/:sha/multipart` → `{ uploadId, partSize }` (`remote.ts:162-176`),
  token persisted to `.rbox/state/uploads/<sha>.json` (`remote.ts:172-175`).
- **Complete + content-addressed race fallback.** `POST .../complete` (`remote.ts:193`); on
  failure, if `missingBlobs([sha])` is empty the content is present regardless of *who*
  finished it (a concurrent uploader of the same sha may have won — `remote.ts:197-205`).
  Preserve this exactly.
- **Bounded part body.** Each part streams a file range: `fileStream(absPath, start, end-1)`
  with `content-length` set (`remote.ts:181-189`). Unchanged — parallelism changes *when*
  we open these streams, not what they are.

## Root cause

The part loop is written as a `for`-await, the one shape in the transfer stack that forbids
concurrency. The fix is to run the **not-completed** part numbers through a bounded pool
instead of a serial loop, exactly the transformation `poolMap` already made for the blob
loop — but with one difference that dictates which primitive to use.

## Design

### 1. Bounded part pool over not-completed parts — a *dedicated* runner, not raw `poolMap`

Build the worklist as the part numbers **not** in `completed`:

```
const pending = [];
for (let n = 1; n <= totalParts; n++) if (!completed.has(n)) pending.push(n);
```

Then run `pending` through a bounded runner at **`PART_CONCURRENCY` = 4** in flight per
blob (tunable to 8; start conservative — see fd safety, §5).

**Primitive choice — recommend a small dedicated runner, not `poolMap`.** `poolMap`
(`src/engine/pool.ts:11`) is deliberately **fail-fast**: it rejects on the first task
failure and starts no new tasks (`pool.ts:8`). That is the correct shape for the *blob*
pool (a failed blob just resumes next push), but it is the **wrong** shape here: a single
transient part failure would abort every in-flight part and collapse back to the
whole-file-retry behavior we are trying to kill. Multipart wants **per-part retry
*before* surfacing** — a part failure should be absorbed locally and only escalate after
its own retry budget is spent. That policy doesn't fit `poolMap`'s "reject on first
failure" contract, so §38 uses a small dedicated bounded runner (a fixed-width set of
workers pulling from a shared `pending` cursor, the same worker-pool shape as `poolMap`
internally, `pool.ts:12-16`) whose per-task body is "upload part *n* with retry." Keep
`poolMap` untouched for the blob/CPU/disk phases — this is the same "adaptive/retrying
network pool lives separately from the fail-fast primitive" split §34 draws for the blob
level (`34-per-account-rate-fairness.md`).

### 2. Per-part independent retry with backoff + jitter

Each part upload is wrapped in bounded retry: on a non-2xx or network error, sleep
`base * 2^attempt + jitter` and re-issue the **same** `fetch(.../part/n)` with a fresh
`fileStream(absPath, start, end-1)` (streams are single-use, so re-open per attempt —
`remote.ts:187`). Classify like §34's blob retry: treat `429` as throttle (honor
`Retry-After`, unbounded-but-progress-bounded) and `5xx`/network as bounded retry
(surface after N attempts). Only when a part exhausts its budget does the runner reject,
which unwinds to the existing `putBlobMultipart` catch (`remote.ts:129-140`) — so the
outer "clear token, re-init once" safety net is still the last line of defense, just
rarely reached now.

Parts are independent by construction (each is an isolated R2 part PUT keyed by part
number), so retrying one part never disturbs another in flight.

### 3. Resume still consulted — completed parts are never resent

The worklist is built **from** `completed` (§1), so a part the server already has is never
in `pending` and never uploaded. This is the identical guarantee the sequential
`if (completed.has(n)) continue` gave (`remote.ts:180`), just hoisted out of the loop into
the worklist filter. A kill/restart mid-upload re-runs `multipartAttempt` with
`allowResume=true`, re-GETs the authoritative `completedParts` (`remote.ts:152-157`), and
the pool only uploads the still-missing parts. **No completed part is resent** — validated
explicitly (see Validation gate).

### 4. Progress through the existing progress Interface

Emit part-completion and byte progress as each part settles, through the **same** progress
Interface blob upload already reports on (the C2 requirement,
`performance-architecture-proposal.md:403`). Because parts now complete out of order, byte
progress is `Σ len(completed parts)`, not "part N of M sequentially" — accumulate settled
bytes, don't assume monotonic part order. This is the surface §35 (phase metrics) and §36
(pipeline) consume; §38 emits into it rather than owning it.

### 5. fd safety — a global in-flight cap (a real constraint, called out)

This is the one place parallelism can bite. The outer blob pool runs up to 64 blobs at
once (`sync.ts` / `pool.ts:11`). If each large blob independently opens
`PART_CONCURRENCY` part streams, the worst case is **64 × PART_CONCURRENCY** concurrent
`fileStream` handles (`remote.ts:187`) plus their sockets — at 64×8 that's 512 fds from
multipart alone, on top of everything else, which can exhaust the process fd limit when
several large files upload at once.

**Propose a global in-flight part cap.** A single process-wide semaphore
(`GLOBAL_MULTIPART_PARTS`, default ~32) that every per-blob part runner acquires before
opening a part stream and releases on settle. Per-blob width stays `PART_CONCURRENCY`, but
the **sum** across all concurrently-uploading blobs is bounded by the global cap — so 8
large blobs at 4-wide each still never exceed 32 open part streams total. The bound is
`min(PART_CONCURRENCY per blob, GLOBAL_MULTIPART_PARTS across blobs)`. This keeps the fd
ceiling a fixed constant independent of how many large files happen to land in one push.

## Files

- **`src/cli/remote.ts:142-208`** (`multipartAttempt`) — replace the sequential
  `for` loop (`:179-191`) with: build `pending` from `!completed.has(n)`, run through the
  dedicated bounded part runner (§1) with per-part retry (§2). Keep init (`:162-176`),
  resume GET (`:152-157`), complete + race fallback (`:193-207`), and `fileStream` bodies
  (`:181-189`) unchanged. `putBlobMultipart` (`:129-140`) is untouched — it stays the outer
  safety net.
- **`src/engine/pool.ts`** — add the dedicated bounded-retry part runner alongside
  `poolMap` (do **not** modify `poolMap`; its fail-fast contract is depended on elsewhere).
  Or keep the runner local to `remote.ts` if it stays small — it's ~20 lines. Recommend
  `pool.ts` for one test surface with the blob pool.
- **`src/cli/remote.ts`** (transport class ctor) — thread the global in-flight part
  semaphore (§5) so it's shared across all blobs' part runners in one process.
- Progress Interface wiring (§4) — the same hook blob upload already reports through.

## Benefits

- **Immediate large-file win, zero protocol change.** Parts fan out; the ≥2x fast-link
  target (`performance-architecture-proposal.md:801`) is met by concurrency alone. Manifest
  format, server, and resume token all untouched.
- **Flaky-link resilience.** A transient part failure retries *that part*, not the whole
  file — 29 good parts survive a blip on part 30.
- **Clean deletion test.** If §38 were reverted, per-part retry and progress logic would
  have to spread back into the caller (`performance-architecture-proposal.md:410-412`). It's
  a genuinely isolated Module boundary.
- **Composes with backpressure.** Because part concurrency is a bounded pool, §34's adaptive
  width can shrink it under load (see Interactions) — the same lever that governs blob width.

## Validation gate

- **120 MB / 500 MB / 2 GB uploads with induced part failures.** Inject non-2xx on selected
  part indices; assert the upload completes and per-part retry recovers **without** tearing
  down the whole upload (the outer `putBlobMultipart` re-init catch is *not* reached). Prove
  independent retry: failing part 30 does not re-send parts 1-29.
- **Kill + restart mid-upload.** Kill the process partway through a 2 GB upload; restart;
  assert the resume GET's `completedParts` (`remote.ts:152-157`) are **not** re-PUT — only
  still-missing parts upload, and the final blob is byte-identical (`missingBlobs([sha])`
  empty after complete).
- **No fd explosion.** Upload several large files concurrently (saturating the 64-wide blob
  pool with multipart-eligible blobs) and assert open fd count stays bounded by the global
  cap (§5), not by 64 × `PART_CONCURRENCY`. Measure peak fd count directly.
- **≥2x throughput on a fast link.** Benchmark a 2 GB upload sequential-vs-parallel on a
  fast link; assert ≥2x wall-time improvement (the proposal's target,
  `performance-architecture-proposal.md:801`).
- **Race fallback preserved.** Two clients uploading the same sha concurrently: the loser's
  `complete` fails, `missingBlobs([sha])` is empty, it returns success without error
  (`remote.ts:197-205`) — assert the parallel version still honors this.

## Interactions

- **§34 (per-account backpressure) — shrinks part concurrency too.** A heavy account's
  multipart parts are blob hot-path requests and count against the **same** adaptive width
  §34 governs (`34-per-account-rate-fairness.md`). When §34 lands, `PART_CONCURRENCY` and the
  global cap (§5) become *targets* the adaptive pool can lower on `429`, not fixed constants
  — a throttled account slows its parts instead of hammering. §38's bounded-pool shape is
  what makes this possible; the runner reads its width from the same source the blob pool
  will.
- **§35 (phase metrics) / §36 (blob transfer pipeline).** §38 emits part/byte progress
  (§4) into the progress + phase-metric surface those designs own; it does not own that
  surface. When the §36 pipeline Module lands, `multipartAttempt` becomes one of its upload
  strategies — §38's isolated runner slots in cleanly. §38 can ship **before** them (it only
  needs the existing progress hook).
- **NOT chunk sync (§40 / proposal C4).** This is the critical scoping line: §38 is
  whole-file multipart made parallel. It does **not** touch the manifest format, does not
  introduce chunk refs, and does not change what a "blob" is. Chunk/block sync (C4,
  `performance-architecture-proposal.md:446-502`) is the manifest-v2 change that lets a 4 KB
  edit avoid re-uploading a 2 GB file; that's a separate, far larger design. §38 is a Phase-1
  reliability/throughput win that ships independently and stacks under chunk sync later
  (chunked large files still upload their chunks — and each chunk that's itself large still
  goes through this same parallel multipart path).
- **Phase-1 cohort.** Per the proposal roadmap (`performance-architecture-proposal.md:732-737`),
  §38 ships alongside §34 (backpressure) and the C3 adaptive pool as Phase-1 "reliability and
  obvious throughput" — all client-transport, none touching sync correctness or the manifest.
