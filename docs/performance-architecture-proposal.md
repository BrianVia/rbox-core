# rbox performance architecture proposal

**Status:** Proposal — **partly shipped; re-scored 2026-08-11.**  
**Date:** 2026-07-01  

> **Status of each proposal as of 2026-08-11** (verified against code):
> **SHIPPED** — C1 deep blob pipeline (`src/cli/publish-pipeline/`),
> C5 small-blob packfiles (server-side, `apps/api/src/blob-pack.ts`,
> `packs/v1/`, design 114), C6 local SQLite client state
> (`src/cli/state-plane/`), Phase 0 client phase metrics
> (`src/cli/remote/timings.ts` and siblings).
> **STILL OPEN** — C2 parallel multipart (`src/cli/remote/multipart.ts` is still
> a sequential `for` loop; design 101 never shipped), S1/C3 account backpressure
> + adaptive pool (no 429/`Retry-After` handling client-side), S2/D5 D1 sharding
> (`apps/api/src/db.ts` still returns one binding), C4 chunk sync, C7 pull
> apply, C8 chain checkpoints, S3-S6.
> **OVERTURNED** — the "do not build batch upload" non-goal; see that section.  
**Goal:** Dropbox-class perceived performance, or better where rbox's end-to-end
encryption and Cloudflare R2 architecture make that possible.

This proposal follows the measured work in
[`perf-improvements.md`](./perf-improvements.md), the server throughput designs,
and the current server/client implementation. It is intentionally holistic: some
ideas are conservative next steps, and some are large bets that only make sense
if rbox is aiming at "sync a real workstation tree and do not feel it."

## Executive summary

The last performance cycle already found and removed the biggest server-side
hot spot: per-blob D1 work on upload. The direct-write receipts path made
small/medium first push roughly 5-6x faster and moved commit accounting to
chunked D1 batches. Sidecars removed the signed-body ceiling. Large-ref
accounting made a real 65k-file workspace commit. Upload/download concurrency
defaults then captured the cheap remaining throughput wins.

The next Dropbox-level gains are not another small endpoint. They are:

1. **Make transport rate-aware.** Add account-level backpressure on the server
   and adaptive blob transfer on the client so high fanout slows down instead
   of tripping Cloudflare/WAF-style failures.
2. **Create a deep client blob pipeline module.** Hide hash/encrypt/upload and
   download/decrypt/write behind one Interface with phase metrics, fewer disk
   passes, integrated verification, retries, and progress.
3. **Parallelize and harden multipart.** Large-file upload is still sequential
   by part.
4. **Prototype chunk/block sync.** Whole-file encrypted blobs are the major
   architectural ceiling. A 4 KB edit inside a multi-GB file should not upload
   the whole file.
5. **Use packfiles for tiny encrypted blobs if clone stays request-bound.**
   This is the "crazy but plausible" pull-side bet for 50k+ small files.
6. **Keep server scale work focused on isolation.** D1 account sharding,
   route/Worker split, and retained-root materialization are the server-side
   moves that preserve performance under many accounts and long histories.

The current server hot path is much healthier than the client hot path. Server
work should now protect the platform and remove future ceilings; client work
should attack the bytes, CPU, temp-file, and filesystem paths users feel.

## What the measurements say

The important facts from [`perf-improvements.md`](./perf-improvements.md):

- Before receipts, `blob.put` averaged about 7 D1 calls and about 956 ms in D1
  per PUT, around 89% of wall time.
- Direct-write receipts removed D1 from the upload hot path. On real
  `savvy-core` slices, cold push improved from 23.6s to 4.6s for 500 files and
  from 83.6s to 14.9s for 2000 files.
- The staging/promote design was slower at scale. The simple direct-write path
  won because it removed the serial O(N) R2 promote phase.
- BlobRef sidecars made the signed commit body O(1), but did not improve wall
  time. They are a scale/correctness unblock, not a latency feature.
- Batch upload was not built because post-receipts PUT time was dominated by R2
  bytes, not request overhead. Raising upload concurrency to 64 was the better
  lever.
- Download capabilities were deferred because the per-blob entitlement read was
  not the pull bottleneck. Raising download concurrency was the better lever.
- The real `~/conductor/workspaces` dogfood run pushed 65,421 files, 11,925
  unique blobs, and 2.68 GB ciphertext to prod in 192s. Cross-host pull took
  433s. Commit time was negligible compared with transfer, decrypt, and writing
  65k files.

Conclusion: rbox should stop treating server D1 as the default explanation for
felt slowness. The remaining first-order costs are R2 transfer, client crypto,
client disk IO, request fanout, and filesystem application.

## Architecture map

### Server-side modules

- [`apps/api/src/blobs.ts`](../apps/api/src/blobs.ts): blob PUT/GET,
  missingBlobs, multipart endpoints. Receipts PUT is now R2-only and mints the
  receipt after R2 accepts the bytes.
- [`apps/api/src/commit-accounting.ts`](../apps/api/src/commit-accounting.ts):
  receipt validation, present cataloging, quota charge, entitlement grant, and
  large-ref super-batches.
- [`apps/api/src/workspace-sync.ts`](../apps/api/src/workspace-sync.ts):
  WorkspaceSync Durable Object, signed commit validation, sidecar resolution,
  accounting before head advance, retained roots for GC.
- [`apps/api/src/db.ts`](../apps/api/src/db.ts): current D1 routing seam. It is
  N=1 today but intentionally shaped for account sharding.
- [`apps/api/src/metrics.ts`](../apps/api/src/metrics.ts): privacy-safe server
  timing and D1/R2/DO span measurement.
- [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc): current bindings:
  one D1, R2 buckets, WorkspaceSync DO, Analytics Engine, queues, email, and
  **ten `ratelimits` bindings** (`RL_DEVICE_START` … `RL_KEY_DELIVERY_ACK`,
  namespace ids 2001-2010 — registered in `AGENTS.md`). **Correction
  (2026-08-11):** an earlier version of this line claimed there were no
  rate-limit bindings, which undercut S1's premise that no limiter
  infrastructure exists. No Smart Placement configuration today.

### Client-side modules

- [`src/cli/sync.ts`](../src/cli/sync.ts): push/pull orchestration, encrypt
  pool, upload pool, missingBlobs preflight, full pull scan. **Moved since
  (2026-08-11):** the fused encrypt→upload pipeline is now
  `src/cli/publish-pipeline/` (C1, shipped) and recovery orchestration is
  `src/cli/sync-recovery.ts`; `uploadConcurrency` lives in
  `publish-pipeline/shared.ts`.
- [`src/engine/crypto.ts`](../src/engine/crypto.ts): convergent AES-GCM
  encryption and decrypt verification. Current push hashes plaintext, encrypts
  to temp, then hashes ciphertext temp. Current pull decrypts from a ciphertext
  temp and then hashes plaintext.
- [`src/cli/remote.ts`](../src/cli/remote.ts): now a facade over the
  `src/cli/remote/` directory — HTTP transport, receipt capture, streamed single
  PUT/GET, multipart client. Multipart still uploads parts sequentially
  (`remote/multipart.ts`; C2 remains open). **Correction (2026-08-11):** non-2xx
  blob responses are *not* generic any more — `translateRemoteError`
  (`remote/errors.ts`) is applied on the blob paths.
- [`src/engine/apply.ts`](../src/engine/apply.ts): precondition-checked apply,
  bounded download/write pool, encrypted pull via ciphertext temp.
- [`src/engine/manifest.ts`](../src/engine/manifest.ts) and
  [`src/engine/hashcache.ts`](../src/engine/hashcache.ts): scan, hash cache,
  incremental manifest patching.
- [`src/cli/daemon.ts`](../src/cli/daemon.ts): watcher-driven single-flight
  push/pull loop, safety scan, deep scan.

## Design principles

1. **Measure before building.** The prior cycle repeatedly showed that measured
   simple levers beat complex speculative designs.
2. **Keep content dumb and metadata sequenced.** R2 should store immutable
   encrypted content. DO/D1 should own ordering, account grants, quota, and GC
   reachability.
3. **Prefer deep Modules.** Put transfer complexity, backpressure, temp-file
   ownership, retries, and verification behind small Interfaces. That creates
   Leverage for callers and Locality for fixes.
4. **Do not weaken E2EE.** Performance work may change chunking, packing, and
   transport shape, but it must not expose plaintext bytes or rely on server
   trust for integrity.
5. **Throttle, do not fail.** Legitimate large sync should slow down under load,
   not hard-fail after doing most of the work.
6. **Optimize felt paths.** The highest-value scenarios are first push, fresh
   clone, large-file edit, many-small-file clone, daemon incremental edit, and
   no-op background cost.

## Server-side proposal

### S1. Account-level backpressure and adaptive client cooperation

**Problem.** rbox now runs 64-wide upload/download fanout. A single account can
generate enough concurrent blob requests to trip platform-level throttles, and
the client cannot currently distinguish "slow down" from a real error.

**Solution.**

- Add Worker rate-limit bindings keyed by `accountId`, split by operation class:
  blob hot path, commit, and generic account reads.
- Fold plan into authentication so the limiter can select a static plan tier
  without an extra D1 read.
- Return `429` with `Retry-After` on throttle.
- Return `x-rbox-max-concurrency` on normal blob responses so updated clients
  can converge before hitting a throttle.
- Add a client adaptive pool for blob upload/download only. Keep the existing
  fail-fast `poolMap` semantics for CPU/disk work.
- Treat only `429` as unbounded-but-progress-bounded throttle retry. Treat 5xx,
  network errors, and malformed responses as real errors with bounded retry.

**Files.**

- Server: [`apps/api/src/worker.ts`](../apps/api/src/worker.ts),
  [`apps/api/src/auth.ts`](../apps/api/src/auth.ts),
  [`apps/api/src/env.ts`](../apps/api/src/env.ts),
  [`apps/api/wrangler.jsonc`](../apps/api/wrangler.jsonc)
- Client: [`src/cli/remote.ts`](../src/cli/remote.ts),
  [`src/engine/pool.ts`](../src/engine/pool.ts),
  [`src/cli/sync.ts`](../src/cli/sync.ts),
  [`src/engine/apply.ts`](../src/engine/apply.ts)

**Benefits.**

- Better platform isolation under real multi-account load.
- Heavy accounts slow down instead of failing.
- The concurrency default becomes a ceiling, not a blind constant.
- The backpressure behavior is testable at the transport Interface.

**Validation gate.**

- Synthetic 429 injection proves no blob is lost and the job eventually
  completes.
- A 64-wide push under a tight dev limiter slows down and finishes.
- 5xx injection still fails after bounded retry and does not loop forever.
- Analytics Engine shows throttle counts by operation class, not account IDs.

### S2. D1 account sharding when multi-account pressure appears

**Problem.** The D1 routing seam exists, but both `dbFor` and `dirDb` still
return the same binding. D1 is documented as single-threaded per database, so a
single D1 remains the future write ceiling under many accounts.

**Solution.**

- Keep the current N=1 seam.
- Implement account-data shard assignment only when telemetry shows D1 queueing
  or a noisy account.
- Split the account-data plane from the directory plane as designed in
  [`docs/design/32-d1-account-sharding.md`](./design/32-d1-account-sharding.md).
- Freeze existing placements before adding a shard; move only selected accounts.

**Benefits.**

- Preserves the current code shape while making future scale operational rather
  than a rewrite.
- Hot account data moves without touching credential lookup semantics.
- Commit accounting, blob refs, account usage, and workspace data stay colocated.

**Validation gate.**

- N=1 behavior-preserving tests stay green.
- Shadow-router test proves every account-scoped query resolves through `dbFor`.
- Shard simulation catches any `dbFor(env, "")` fanout site before production.

### S3. Split blob and metadata execution paths

**Problem.** Blob transfer wants to be near the user and R2 path. Metadata routes
may benefit from placement near D1/DO. One Worker deployment gives every route
the same placement behavior.

**Solution.**

- Split into two Workers or two route groups:
  - Blob Worker: PUT/GET/multipart/missingBlobs, optimized for transfer.
  - Metadata Worker: commit/latest/account/key/admin routes, eligible for Smart
    Placement measurement.
- Keep shared code as internal Modules, not duplicated route implementations.
- Measure before enabling Smart Placement globally.

**Benefits.**

- Avoids optimizing blob routes and D1-heavy routes against opposite goals.
- Allows Smart Placement experiments on metadata without risking upload latency.
- Makes platform limits easier to reason about per route class.

**Validation gate.**

- A/B dev deployment measuring first push, fresh pull, latest, commit, and key
  routes with and without Smart Placement.
- No regression in large upload wall time.

### S4. Presigned direct-to-R2 for large blobs

**Problem.** Small/medium Worker-through-R2 transfer is now good. Large blobs
still route every byte through the Worker body path. Multipart also still uses
the server as a transfer hop for every part.

**Solution.**

- Add credential-gated presigned PUT/GET or multipart URLs for large blobs.
- Keep Worker-through-R2 as the default fallback.
- Server mints an upload session, the client transfers directly to R2, then the
  server verifies R2 object metadata/checksum/head before issuing or accepting a
  receipt.
- For GET, consider short-lived download grants only after backpressure and
  client metrics show Worker-through-R2 is still a large cost.

**Benefits.**

- Removes Worker body transfer from very large objects.
- Sets up better large-file throughput before chunk sync lands.
- Borrows the files-sdk technique the ADR explicitly leaves open without taking
  the dependency.

**Risks.**

- Possession proof and quota semantics must remain server-authoritative.
- Orphan bytes become easier to create unless sessions expire and reconcile.
- Credential provisioning is operationally sensitive.

**Validation gate.**

- 500 MB and 2 GB file upload/download comparison:
  Worker path vs presigned path.
- Abandoned upload reconciliation proves quota and GC safety.
- Wrong-sha upload cannot mint a usable receipt.

### S5. Retained-root materialization for GC and long history

**Problem.** The `roots()` path can walk retained commits and fetch sidecars to
compute GC roots. That is fine off the hot path today, but it grows with history
and sidecar count.

**Solution.**

- Maintain a per-workspace retained-root index updated when a commit is accepted
  and when retention prunes history.
- Store enough compact ref information to compute GC roots without fetching every
  sidecar in history.
- Keep the existing sidecar-aware walk as an audit/fallback path.

**Benefits.**

- Makes GC latency depend on current retained roots, not history depth.
- Reduces R2 sidecar fetches during background maintenance.
- Concentrates GC root logic in one Module.

**Validation gate.**

- Root index and historical walk produce identical root sets on generated
  histories.
- Corrupt/missing index fails closed and rebuilds from history.

### S6. Use D1 read replicas/sessions for web and account reads, not commits

**Problem.** Some read-heavy web/account paths do not need the same primary-read
behavior as commit accounting. Commit and sync semantics do.

**Solution.**

- Evaluate D1 Sessions/read replication for web dashboard reads, usage history,
  account settings, and admin views.
- Keep commit accounting, entitlement checks that affect blob access, quota, and
  DO head advancement on the authoritative path.

**Benefits.**

- Helps dashboard responsiveness under read load.
- Avoids adding consistency risk to sync correctness.

## Client-side proposal

### C1. A deep blob transfer pipeline Module

**Problem.** Blob work is currently spread across sync orchestration, crypto,
remote transport, apply, and temp-file handling. The caller Interface leaks too
much Implementation detail: temp files, hashes, receipts, retries, progress, and
concurrency are coordinated across multiple files.

Current push path:

1. Scan computes plaintext hashes.
2. `encryptFileToTemp` hashes plaintext again for key derivation.
3. Encryption writes ciphertext temp.
4. `encryptFileToTemp` hashes ciphertext temp to get `encSha`.
5. Upload reads ciphertext temp.

Current pull path:

1. Download streams ciphertext to `.ct` temp and hashes ciphertext.
2. Decrypt reads `.ct` temp and writes plaintext temp.
3. Decrypt hashes plaintext temp.
4. Apply renames plaintext temp into place.

Because convergent encryption derives the key from plaintext hash, one
plaintext pass is fundamental unless a fresh, same-cycle hash can be safely
reused. But the ciphertext temp rehash and pull-side ciphertext temp are
avoidable.

**Solution.**

Create a client blob pipeline Module with a small Interface for:

- Encrypt changed files, produce encrypted blob descriptors, and own temp-file
  lifetime.
- Upload missing encrypted blobs with receipts, backpressure, retry, and
  progress.
- Download encrypted blobs, decrypt, verify, and stage plaintext temps for
  precondition-checked apply.
- Emit phase metrics from inside the pipeline.

Implementation details:

- Reuse a fresh scan hash only when the pipeline can prove the file has not
  changed since that hash was computed. Otherwise rehash. Do not pass stale
  hashcache values into key derivation.
- Compute ciphertext sha while writing the ciphertext temp, avoiding a separate
  ciphertext re-read.
- On pull, stream network ciphertext through a verifier/decrypter into the
  plaintext temp. AES-GCM puts the tag at EOF, so keep a 16-byte trailing buffer,
  set the tag at finalization, and compute plaintext sha inline.
- Keep atomic publish and conflict preservation in `apply`.
- Keep small-buffer helpers only for tests and small sidecar/manifest blobs.

**Files.**

- [`src/engine/crypto.ts`](../src/engine/crypto.ts)
- [`src/cli/sync.ts`](../src/cli/sync.ts)
- [`src/engine/apply.ts`](../src/engine/apply.ts)
- [`src/cli/remote.ts`](../src/cli/remote.ts)
- New likely Module under `src/engine/blob-pipeline.ts` or
  `src/engine/transfer-pipeline.ts`

**Benefits.**

- Fewer disk reads/writes for large data.
- Better Locality for correctness bugs around temp files and verification.
- One test surface for encrypted transfer.
- One place to add adaptive concurrency, retry classification, and metrics.

**Validation gate.**

- Microbench `encrypt` and `decrypt` before/after on 1 MB, 100 MB, and 2 GB
  corpora.
- E2E byte identity across Mac and Linux.
- Intentional wrong tag, wrong sha, short ciphertext, partial download, and
  concurrent local edit tests all fail safely.
- Resource metrics: peak RSS, fd count, temp bytes written.

### C2. Parallel multipart with per-part retry and progress

**Problem.** `multipartAttempt` uploads parts in a sequential loop. Large files
therefore do not get the same fanout benefits as many small files.

**Solution.**

- Add a bounded part pool per large blob, initially 4 or 8 parts in flight.
- Retry failed parts independently with backoff and jitter.
- Persist completed parts after each success through the existing server state.
- Surface part/byte progress through the same progress Interface as blob upload.
- Let global account backpressure shrink part concurrency too.

**Benefits.**

- Immediate large-file win without changing the manifest format.
- Better resume behavior on flaky links.
- Isolated improvement with a clear deletion test: if removed, retry/progress
  logic would spread back into the caller.

**Validation gate.**

- 120 MB, 500 MB, and 2 GB upload with induced part failures.
- Kill/restart mid-upload and prove already completed parts are not resent.
- Verify no fd explosion when multiple large files upload concurrently.

### C3. Adaptive concurrency as a transport Adapter

**Problem.** Upload/download concurrency is currently a fixed env-tunable number.
The right number depends on network, plan, account load, and platform behavior.

**Solution.**

- Keep fixed `poolMap` for CPU/disk phases.
- Add an adaptive blob pool used only by network blob operations.
- Initial width comes from server hint or default.
- `429` halves target width; sustained success raises it.
- In-flight jobs park when target width shrinks; they do not exit, so width can
  recover.
- Non-429 errors keep fail-fast semantics.

**Benefits.**

- Lets clients self-tune across laptop, VM, fast LAN, and remote colo cases.
- Works with server rate limiting instead of fighting it.
- Avoids more global constants becoming stale after the next architecture shift.

**Validation gate.**

- Simulated limiter shows convergence to the sustainable width.
- No regression in current unconstrained dev benchmark.
- Daemon remains responsive while jobs are parked.

### C4. Chunk/block sync for large-file deltas

**Problem.** Whole-file encrypted blobs are the biggest remaining architecture
ceiling. Any edit to a large file changes its plaintext hash, key/nonce, and
ciphertext, so rbox uploads and downloads the whole file. R2 cannot make that
fast if the protocol asks for whole-file replacement.

**Solution.**

Introduce a manifest v2 for selected files:

- Small files remain whole-file blobs.
- Files over a threshold become chunked.
- Use content-defined chunking, such as FastCDC/Buzhash, with target chunk size
  tuned by corpus measurement. Start with 1-4 MiB target chunks for workstation
  files; revisit for VM images and media.
- Each chunk is encrypted independently with convergent encryption derived from
  the chunk plaintext sha and workspace KEK.
- A file entry points to a chunk tree or chunk-list sidecar:
  chunk plaintext sizes, chunk plaintext shas, encrypted chunk shas, and total
  file hash.
- The server still sees only encrypted blob refs and sizes. Commit accounting
  can reuse the existing refset machinery.
- Restore/download reconstructs the file by fetching missing encrypted chunks
  and verifying the final plaintext hash.

**Rollout.**

- New clients can read/write manifest v2.
- Existing whole-file blobs remain valid.
- Only files above the threshold are chunked.
- A changed legacy large file can migrate to chunked form on its next write.
- Old clients must reject unsupported manifest version cleanly rather than
  corrupting state.

**Benefits.**

- A 4 KB edit in a 2 GB file uploads/downloads a few chunks, not 2 GB.
- Chunk reuse improves across file copies and renames inside a workspace.
- Large-file sync becomes protocol-limited by changed bytes, not total bytes.

**Risks.**

- More refs per commit. Large-ref accounting may need another cap pass.
- Chunk boundaries and sizes leak additional structure unless the future
  manifest-metadata E2EE work hides them.
- More R2 objects can worsen many-small-object behavior unless combined with
  packfiles or chunk aggregation.
- File reconstruction gets more complex, so the pipeline Module must own it.

**Validation gate.**

- 2 GB file, modify 4 KB near beginning/middle/end: upload bytes under 20 MB.
- Random insertion shifts content: content-defined chunking should preserve most
  chunks after the edit.
- Cross-host pull reconstructs byte-identical file.
- Worst-case random rewrite does not perform materially worse than whole-file.

### C5. Small-blob packfiles for cold clone

**Problem.** A 65k-file pull is partly network transfer and partly 65k separate
filesystem writes. If many files are small, clone may be dominated by request
count and per-object overhead even after high concurrency.

**Crazy but plausible solution.**

- During commit or background compaction, group small encrypted blobs into
  immutable pack objects.
- Store a pack index mapping `encSha -> { packSha, offset, length, checksum }`.
- Pull can fetch one pack and materialize many files locally.
- Existing individual blob keys remain canonical for compatibility and recovery,
  or packs become a read-optimized mirror only.
- For large or frequently changed objects, keep individual blobs.

**Benefits.**

- Fewer R2 GETs on cold clone.
- Better request locality for many-small-file workspaces.
- Could combine naturally with chunk sync: small chunks pack well.

**Risks.**

- GC and accounting become more complex if packs are authoritative.
- Read-optimized mirror doubles storage unless old objects can be pruned safely.
- Range-read behavior and cache locality must be measured, not assumed.
- Pack corruption must not make individual blobs unrecoverable.

**Validation gate.**

- Synthetic 100k tiny file clone before/after.
- `savvy-core` and `conductor/workspaces` clone before/after.
- Pack mirror disabled by config produces identical behavior.
- Corrupt/missing pack falls back to individual blobs.

### C6. Local SQLite index for client state

**Problem.** JSON state and manifest arrays are acceptable at current sizes, but
chunk sync, pack indexes, durable dirty queues, history checkpoints, and very
large workspaces want indexed local state.

**SHIPPED (2026-08-11)** as `src/cli/state-plane/` — `.rbox/state/state.db` on
`bun:sqlite`, with schema/migration/backup modules. AGENTS.md now makes it the
rule: internal state belongs in SQLite, JSON only for human-edited records.

**Solution.**

- Add a local SQLite store under `.rbox/state/`.
- Store path index, stat/hash cache, file identity where available, chunk index,
  encrypted blob cache, dirty queue, upload session state, and last-known remote
  sequence.
- Keep JSON export/import or migration for recovery.
- Treat SQLite as local cache/state, not the source of remote truth.

**Benefits.**

- Faster targeted queries for large workspaces.
- Durable daemon queue without fragile JSON rewrite patterns.
- Enables chunk and pack features without turning manifest scans into O(N)
  array rewrites everywhere.

**Validation gate.**

- Migration from existing state.
- Corrupt local DB produces a safe rebuild path.
- No-op daemon tick remains near zero cost on 100k-file synthetic corpus.

### C7. Pull apply optimization

**Problem.** Pull currently scans the local tree before reconcile, then the daemon
often scans again after apply. This is correct, but expensive at large scale.

**Solution.**

- Keep precondition correctness, but narrow the pre-apply work to paths touched
  by the diff when the daemon already has a trusted in-memory manifest.
- Patch the in-memory manifest after successful apply rather than immediately
  doing a broad scan.
- Keep periodic stat-only and deep scans as safety nets.
- Add a write scheduler that separates large sequential writes from many tiny
  writes so concurrency does not punish the disk.

**Benefits.**

- Reduces warm pull/no-op overhead.
- Keeps correctness anchored in preconditions and periodic truth scans.
- Improves daemon invisibility on large trees.

**Validation gate.**

- Concurrent local edit tests stay green.
- Dropped watcher event is recovered by safety scan.
- Warm pull with no changes avoids a full hash pass.

### C8. Chain checkpoints for long-lived histories

**Problem.** History verification is cheap when the pin is current, but long-lived
workspaces and long-offline clients can accumulate large commit tails.

**Solution.**

- Add signed checkpoint commits or skip-list links every N commits.
- A client verifies from a trusted checkpoint plus tail rather than walking the
  entire history.
- Keep full verification as an audit mode.

**Benefits.**

- Bounded pull latency after long offline periods.
- Better fit for future version browsing and restore.

**Validation gate.**

- Fork/rollback attempts fail.
- Long history pull improves without weakening trust semantics.

## Web dashboard proposal

The web dashboard is not the sync data plane, so it should not compete with
client pipeline work. Still, to make the product feel fast:

- Keep production web builds pointed at prod only through the existing deploy
  workflow; local dev should keep using the dev Worker.
- Add route-level data loading and parallel fetches where pages currently chain
  account reads.
- Cache read-mostly dashboard data with short TTLs.
- Consider D1 read replicas/sessions for dashboard reads after the sync path is
  stable.
- Prerender or SSR static shell only if the web app starts to feel slow on cold
  load. Do not let this distract from sync throughput.

## Deepening opportunities

These are the architectural refactors that make the proposal maintainable.

### D1. Blob transfer pipeline Module

**Files:** `src/cli/sync.ts`, `src/engine/crypto.ts`,
`src/engine/apply.ts`, `src/cli/remote.ts`

**Problem:** Transfer logic is shallow across many Modules. Callers coordinate
temp files, hashes, progress, concurrency, receipts, and retries.

**Solution:** A deep Module owns encrypted upload/download pipelines behind one
Interface. The Implementation can contain internal seams for crypto, transport,
metrics, temp storage, and retry policy.

**Benefits:** Better Locality for performance and correctness bugs. Tests use
the same Interface production callers use.

### D2. Rate-aware transport Adapter

**Files:** `src/cli/remote.ts`, `src/engine/pool.ts`,
`apps/api/src/worker.ts`, `apps/api/wrangler.jsonc`

**Problem:** The current transport Interface cannot express throttle, retry
after, server-advertised concurrency, or operation class.

**Solution:** Add a transport Adapter that classifies responses and exposes
backpressure to the adaptive pool. Leave raw fetch details inside the Adapter.

**Benefits:** Server and client rate work become one contract. Non-429 errors
keep a crisp fail-fast path.

### D3. Chunked file Module

**Files:** `src/engine/manifest.ts`, `src/engine/types.ts`,
`src/engine/crypto.ts`, `src/engine/apply.ts`,
`apps/api/src/commit-accounting.ts`

**Problem:** Whole-file blobs make large-file deltas impossible.

**Solution:** Add a chunked file representation behind a manifest version seam.
Callers ask for file materialization and upload planning; the Implementation
owns chunking, chunk encryption, chunk refs, and reconstruction.

**Benefits:** Large-file performance changes by protocol design rather than by
more concurrency.

### D4. Local state index Module

**Files:** `src/engine/hashcache.ts`, `src/cli/config.ts`,
`src/cli/daemon.ts`, future chunk/pack Modules

**Problem:** JSON state is easy to inspect but weak for indexed, durable,
incremental operations at 100k+ files.

**Solution:** Introduce local SQLite as a cache/state Module with rebuild
semantics, not as the source of truth.

**Benefits:** More efficient daemon operations and a better base for chunk,
pack, and durable queue work.

### D5. Server account-data routing Module

**Files:** `apps/api/src/db.ts`, auth/billing/account-link/key Modules,
`apps/api/migrations`

**Problem:** N=1 routing exists but shard lifecycle is not implemented.

**Solution:** Finish the account-data/directory split when telemetry says D1 is
shared-account limited.

**Benefits:** Future scale without rewriting every D1 call under pressure.

## Roadmap

### Phase 0: measurement foundation

Implement before large changes:

- Client phase metrics:
  - scan stat/hash
  - encrypt plaintext hash
  - encrypt write
  - ciphertext hash
  - upload wait/upload wall/retry/throttle
  - commit
  - download wait/download wall
  - decrypt
  - filesystem apply
  - peak RSS and fd count where practical
- Bench corpora:
  - many-small-files
  - large-file edit
  - real `savvy-core`
  - real `conductor/workspaces`
  - long history
- Comparison scripts that report bytes/sec by basis:
  plaintext bytes, ciphertext bytes, wire bytes, changed bytes.

### Phase 1: reliability and obvious throughput

- S1 account backpressure.
- C3 adaptive blob pool.
- C2 parallel multipart.
- Client/server tests for 429, 5xx, restart, partial multipart, and progress.

### Phase 2: pipeline depth

- C1 blob transfer pipeline Module.
- Pull-side direct decrypt-to-plaintext-temp.
- Ciphertext sha while writing temp on push.
- Phase metrics wired into the pipeline.

### Phase 3: large-file protocol

- C4 chunk sync prototype behind manifest v2.
- Threshold-gated rollout for large files only.
- Presigned large-blob path if measurements show Worker transfer is still the
  limiting cost before chunk sync is ready.

### Phase 4: many-small-file clone

- C5 packfile experiment.
- C6 local SQLite state if chunk/pack data makes JSON state awkward.
- Pull apply scheduler improvements.

### Phase 5: server scale under real multi-account load

- S2 D1 account sharding if AE shows D1 queueing.
- S3 split blob/metadata Worker if placement measurements show benefit.
- S5 retained-root materialization before GC history becomes expensive.
- S6 read replicas/sessions for dashboard/account reads.

## Prioritized candidate list

| Priority | Candidate | Expected impact | Risk | Why now |
|---:|---|---|---|---|
| 1 | Client phase metrics | High decision quality | Low | Prevents another speculative cycle |
| 2 | Account backpressure + adaptive pool | High reliability | Medium | 64-wide fanout needs a real contract |
| 3 | Parallel multipart | High for large files | Medium | Current implementation is sequential |
| 4 | Blob pipeline Module | Medium/high broad win | Medium | Concentrates temp/hash/retry work |
| 5 | Chunk sync prototype | Very high | High | Only way to beat whole-file physics |
| 6 | Pull-side packfiles | High for tiny-file clone | High | 65k-file pull suggests request/fs pressure |
| 7 | Local SQLite index | Medium enabling | Medium | Needed by chunk/pack scale |
| 8 | Retained-root index | Medium maintenance | Medium | Avoids history-shaped GC later |
| 9 | D1 sharding | High under multi-account load | High | Wait for telemetry |
| 10 | Worker route split / Smart Placement | Unknown | Medium | Measure after route classes are clearer |

## Success metrics

The proposal should be judged by measured outcomes, not code volume:

- **First push:** files/sec, ciphertext MB/sec, wall time by corpus.
- **Fresh clone:** files/sec, ciphertext MB/sec, wall time, local write time.
- **Large-file edit:** changed bytes vs uploaded bytes.
- **No-op daemon tick:** wall time and CPU near zero on 100k-file corpus.
- **Incremental edit latency:** p50/p95 time from write settled to remote commit.
- **Backpressure:** throttled large push completes without user-visible failure.
- **Resource use:** peak RSS, fd count, temp bytes, number of R2 objects/requests.
- **Server load:** D1 calls/ms, R2 calls/ms, DO ms, 429 counts, commit refs.

Target examples:

- 4 KB edit in 2 GB file uploads under 20 MB after chunk sync.
- 100k tiny-file clone reduces R2 GET count materially after packfile experiment.
- 65k-file pull improves from 433s by attacking download/decrypt/write phases,
  with no conflict-safety regression.
- Large-file multipart upload improves at least 2x on fast links once parts are
  parallel and retryable.

## Non-goals and rejected shortcuts

- Do not move commit acceptance to Queues. Queues are appropriate for GC,
  reconciliation, and retries after acceptance, not for "commit accepted means
  bytes are readable."
- Do not use KV for authoritative sync state, entitlements, heads, or quota.
- Do not route every blob operation through a Durable Object rate limiter. That
  serializes the hot path.
- Do not reintroduce staging->canonical promote for normal small blob uploads.
  It was measured and lost.
- ~~Do not build batch upload without a new measurement showing request overhead
  is dominant again.~~ **OVERTURNED (2026-08-11):** design 112 took that new
  measurement and batch upload shipped —  `POST /v1/blob-batch/put` and
  `/v1/blob-batch/get` (`apps/api/src/routes/blob-batch.ts`, client
  `src/cli/remote/blob-batch/`). The bar the non-goal set was met, not ignored.
- Do not remove per-blob GET entitlement checks unless a measured pull bottleneck
  returns. The prior download-capability design remains deferred for a reason.
- Do not optimize the web dashboard ahead of sync data-plane work.

## Open questions

1. What is the first-class target workload: developer monorepos, design/media
   folders, VM/image archives, or broad home-directory backup?
2. How soon does manifest-metadata E2EE need to land? Chunk sync increases the
   amount of shape metadata unless chunk lists are hidden.
3. Is direct-to-R2 credential provisioning acceptable operationally, or should
   Worker-through-R2 remain the only path until chunk sync changes the byte
   volume?
4. Should packfiles be authoritative storage or a read-optimized mirror?
5. What product behavior should happen when a user is throttled for 30 minutes
   but still making progress?
6. What are the plan-tier concurrency targets for free, solo, pro, and team?
7. How much local state complexity is acceptable before introducing SQLite?

## External platform references

These are current Cloudflare platform facts checked while preparing this
proposal:

- D1 throughput and single-threaded-per-database model:
  <https://developers.cloudflare.com/d1/platform/limits/>
- D1 `batch()` behavior:
  <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- Workers rate-limit binding:
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- R2 Workers binding, checksums, and conditional operations:
  <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- R2 presigned URLs:
  <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>
- Workers Smart Placement:
  <https://developers.cloudflare.com/workers/configuration/placement/>
