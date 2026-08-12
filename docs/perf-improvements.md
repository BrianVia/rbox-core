# rbox Performance Improvements — running log

A chronological, **measured** list of perf/correctness wins to the sync engine +
transport. Each entry: what changed, before→after numbers (real, not estimated),
and how it was validated. Methodology + harness live in
[`benchmarking-and-observability.md`](./benchmarking-and-observability.md); the
sweep harness is `scripts/bench/`.

> Validation rig: this Mac + `flat-meadow-prod-main-01` (Linux, `ssh via-server`),
> against `rbox-dev-api`. Test corpus for early entries: **dfinitiv/savvy-core**
> (4287 files, 103 MB, lots of duplicate + empty files).

---

## 2026-06-29 — §25 server observability deployed → the bottleneck, measured

Server-side per-op timing → Workers Analytics Engine (`apps/api/src/metrics.ts`,
`OpSpan` + a D1-binding Proxy that times+counts every statement, incl. inside the
billing/authz helpers). Deployed to dev; live metrics query (`rbox_dev_metrics`,
small corpus push, conc 32) gave the first **measured** server baseline:

| op | dbCalls | dbMs | r2Ms | doMs | ms |
|---|---:|---:|---:|---:|---:|
| **blob.put** | **7** | **956** | 120 | 0 | 1076 |
| commit | 16 | 513 | 0 | ~0 | 513 |
| request | 7.9 | 1116 | 0 | 0 | 1238 |

**Findings that set up §23:** a single `blob.put` spends **~956 ms in D1 across 7
calls — 89% of its wall time** (R2 only 120 ms). The 7 (vs the ~5 estimated) are the
hidden `account()` SELECTs the proxy caught. `doMs≈0` proves the DO sequencer is NOT
the bottleneck — D1 is. This is §23's target, now instrumented: dbCalls/dbMs on
`blob.put` should fall to ~0 once upload-receipts move accounting to commit-time.
(Absolute dbMs is inflated by single-threaded-D1 contention at conc 32 — relative
before/after is the signal.)

## 2026-06-29 — Concurrent blob transfer (push + pull)

**The big one.** Blob upload (`sync.ts`) and download (`apply.ts`) were sequential
`for`-loops — one HTTP round-trip per blob, latency-bound.

- **Before:** ~3 blobs/sec. savvy-core first push projected ~20 min; a fresh clone
  was killed at 120 s having pulled only 846/4285 files.
- **After:** bounded worker pool (`engine/pool.ts` `poolMap`; upload 16 / encrypt 8
  / download 16). Cold clone of savvy-core (4285 files): **~46 s**, byte-identical
  (`diff -rq` clean). Push similar.
- **Validated:** live on flat-meadow + Mac against dev; full round-trip diff.
- Shipped in **v0.1.1**.

## 2026-06-29 — Correctness fixes found by the same dogfood (unblock real repos)

Not speed, but without these the engine silently lost/corrupted data on real repos:

- **Empty 0-byte files** (`.gitkeep`/`__init__.py`) silently never synced —
  `decryptFileToPath` computed a `[0,-1]` read range for tag-only ciphertext and
  threw. Fixed: tag-only case verifies the GCM tag + writes empty. (v0.1.1)
- **Concurrent encrypt temp-collision** — temp file named by content collided for
  duplicate-content files once encryption was parallelized → upload `sha_mismatch`.
  Fixed: unique-per-call temp name. (v0.1.1)
- **Duplicate-content files → duplicate blobRefs** → server reject. Fixed: dedup
  blobRefs to the unique blob set at commit build. (v0.1.1)
- **Commit body too large** — blobRefs inlined in the signed body blew the 256 KB
  cap on a ~4k-file repo. Interim: raised to 1 MB (prod-deployed). Real fix tracked
  below (move blobRefs out of the signed body). (v0.1.1 + prod worker)

## 2026-06-29 — Progress output + tunable concurrency

- Push/pull/sync now emit `uploading|downloading N/total` (TTY spinner + throttled
  non-TTY lines) — long ops no longer look hung (an agent's command was timing out).
- `RBOX_UPLOAD_CONCURRENCY` / `RBOX_ENCRYPT_CONCURRENCY` / `RBOX_DOWNLOAD_CONCURRENCY`
  env knobs (clamped 1–256), read at call-time. Lets the bench sweep + power users tune.

## 2026-06-29 — Upload-concurrency sweep (finding the real default)

Harness: `scripts/bench/push-sweep.ts` — cold first-push of a fixed-shape corpus
(`small` = 1200 files → 1041 unique blobs, with empty + duplicate files), fresh
unique content per run so each is a true cold push, against `rbox-dev-api`.

| conc | wall (s) | blobs/s |
|-----:|---------:|--------:|
| 8 | 76.4 | 14 |
| 16 | 46.7 | 22 |
| **32** | **31.2** | **33** |
| 48 | 31.6 | 33 |
| 64 | 29.6 | 35 |

(n=1/conc, dev; conc=4 threw a transient D1 "connection lost" — itself a signal.)

**Result: knee at 32.** 8→16→32 nearly halves wall time each step (~33% faster than
16); 32/48/64 plateau (~30s). **Default bumped 16 → 32** for upload (and download, by
analogy — same latency-bound shape, not yet directly swept). Both still env-tunable.

**Validated on the Linux VM (flat-meadow, v0.1.2 via the real release pipeline):**

| conc | wall (s) — Mac | wall (s) — Linux |
|-----:|---------------:|-----------------:|
| 16 | 46.7 | 42.3 |
| **32** | **31.2** | **28.6** |
| 64 | 29.6 | 25.9 |

Both clients confirm 32 ≫ 16 (~32–33% faster) — the default generalizes. Nuance: the
Mac *plateaus* at 32 (64 ≈ 32), while flat-meadow (lower-latency link to Cloudflare)
still gains ~9% to 64. So the optimum is **network-dependent** — which is exactly why
the call is "32 default + env knob," not a single hard-coded max. Shipped in **v0.1.2**.

### The pivot this revealed: client perf → server scalability
The plateau is the headline. The first-push cost is **no longer client-side** (we
fixed sequential I/O); past ~32 concurrent requests the wall is **server-side
per-blob work** — each `putBlobFile` is an R2 PUT **+ a D1 insert** (blob_refs /
entitlement), and D1 is where the conc=4 "connection lost" came from. So throwing
more client concurrency at it now buys ~nothing and risks hammering D1.

**The next wins are server-side, not client-side:**
- **Batch the per-blob D1 work.** Today each blob PUT touches D1; a commit with N
  blobs ≈ N D1 round-trips. Batch entitlement/ref writes (D1 `batch()` or move the
  ref accounting to commit-time in one statement). _Prime suspect; bench first._
- **Commit-body / blobRefs out of the signed body** (already tracked) — also reduces
  D1 row pressure.
- **Per-blob latency is R2+D1, not network.** A staging-Worker bench with server
  timing (§5 of the obs doc) is needed to attribute R2 vs D1 vs DO. Client sweeps
  can't see inside the server.
This is the client-vs-server boundary made concrete: **client-side is ~solved for
now; scalability is a server-side problem.**

---

## Tracked next (not yet done)
- **[SERVER, highest-value] Batch per-blob D1 accounting at commit time.** Verified:
  each blob PUT does **~5 D1 round-trips** — cap `SELECT` + `INSERT blobs` + `DELETE
  gc_candidates` + `INSERT blob_refs` + `UPDATE used_bytes` (`apps/api/src/blobs.ts:52`,
  `billing.ts:39`). A 1041-blob push ≈ ~5,200 D1 round-trips — the measured plateau +
  the conc=4 "connection lost". Plan: PUT becomes ~R2-only (keep a cheap cap pre-check);
  the COMMIT (which already lists all blobRefs) does the accounting once — one batched
  blob/blob_ref insert, one `used_bytes` UPDATE, one gc-clear. Correctness to design:
  `missingBlobs` semantics if `blobs` rows land at commit (idempotent re-upload is the
  safe fallback), quota fail-fast vs orphan-R2-bytes, GC interaction. **Design +
  codex adversarial review before implementing.** This is the client→server pivot's
  first real server fix.
- **Move blobRefs out of the signed commit body** → side R2 object referenced by
  hash. Unlocks 50k-file monorepos (the 1 MB cap is interim). Architectural —
  design + codex review first.
- **Future pull-side blocklist / delta-index work**: after the server-D1 P0 lands
  and measurements say pull remains transfer-bound, evaluate block-level content
  hashes and rsync/Syncthing-style indexes so clients can fetch only missing
  blocks instead of whole encrypted blobs. This is explicitly **not** part of the
  current server-D1 P0 commit-time accounting fix.
- **Future streaming overlap**: after the same P0 + measurement gate, consider a
  blocklist → need-blocks → upload/download overlap so clients can pipeline
  metadata negotiation and blob transfer. This is also **not** part of the
  current server-D1 P0.
- **Encrypt double-pass**: `encryptFileToTemp` hashes plaintext then ciphertext;
  the scan already computed the plaintext sha — reuse it? (bench the win first)
- **chain-verify growth** on pull (`verifyCommitChain` is history-linear) — needs a
  verified-checkpoint cache past some depth.

---

## §23 upload-receipts — IMPLEMENTED + MEASURED on dev (2026-06-30)

Design reached codex PASS (v1→v10, 10 adversarial rounds). Server + client implemented
behind `X-Rbox-Protocol: upload-receipts-v1`, deployed to `rbox-dev-api`, measured via
the §25 Analytics Engine telemetry against a real ~100-file E2EE push.

### The headline: D1 is OFF the upload hot path
| metric (`blob.put`)        | baseline (§25) | §23 receipts | change |
|----------------------------|---------------:|-------------:|--------|
| **D1 round-trips / PUT**    | ~7             | **0**        | **−100%** |
| **D1 time / PUT** (dbMs)    | ~850 ms        | **0 ms**     | **−100%** |
| **PUT wall p50**            | ~956 ms        | **~126 ms**  | **7.6× faster** |
| PUT wall p90                | —              | ~180 ms      | (R2-store-bound) |

Measured across 235+ live PUTs: `avg(double8 dbCalls)=0`, `avg(double2 dbMs)=0`,
`p50(double1)=126`. The PUT is now pure R2 (`storeMs≈135`). The §25-measured
"D1 is 89% of blob.put wall time" plateau is **eliminated**.

### Accounting collapsed to the commit
The per-blob D1 work moved into ONE batched transaction per commit:
- A 100-file push's commit did **~6 D1 round-trips total** (validate + the chunked
  catalog/charge/grant batch + present-flips + the legacy mirror), vs the old model's
  ~7 D1 calls **per blob** ≈ **~539 D1 calls** for the same push. **~90× fewer D1
  round-trips per push** — a large reduction in D1 load, contention, and cost.

### Honest tradeoff: the promote makes the COLD push slower, not faster (measured)
Commit copies each NEW blob staging→canonical via an R2 get→put through the Worker.
**Head-to-head, same 120-new-file corpus, same dev worker:**

| cold push, 120 new files | legacy (main) | §23 receipts |
|--------------------------|--------------:|-------------:|
| **total wall**           | **6.46 s**    | **~7.5 s**   |
| blob.put D1 calls (each) | ~7            | **0**        |
| D1 calls / push (total)  | ~840          | **~7**       |

So §23 currently costs **~1 s MORE** on a cold first-push: the legacy per-PUT D1 work was
pooled at 16× client concurrency, while the promote get→put is **capped at ~8× effective
concurrency by the Workers R2-binding limit** (measured `storeMs/wall ≈ 7.9` regardless of the
`PROMOTE_CONCURRENCY` constant — 12, 16, 32 all cap at ~8). The **D1-load win is real and banked**
(~120× fewer D1 round-trips/push → far less D1 contention/cost), but the **felt-speed win is NOT
yet realized** — it requires the design-noted **R2 S3 `CopyObject` promote** (server-side copy, no
Worker get→put, lighter fetch ops not subject to the binding-concurrency cap). Incremental pushes
(few new blobs) already benefit. Binding-level tuning applied (barrier-free pool + dropped the
redundant canonical-put sha256 re-verify) shaves ~10–15% but cannot break the ~8× cap. **S3
CopyObject is the required next step to make §23 a net speedup.**

### REAL savvy-core head-to-head: get→put promote is a 2.4× REGRESSION (measured)
500 real dfinitiv/savvy-core files (6 MB), same corpus, same dev worker, epoch-timed:

| cold push, 500 savvy files | legacy (main) | §23 (get→put promote) |
|----------------------------|--------------:|----------------------:|
| **total wall**             | **17.3 s**    | **41.2 s** (2.4× SLOWER) |
| blob.put D1 calls          | ~7 each       | **0** |

The earlier "win scales with N" projection was **WRONG**: the get→put promote costs **~560 ms/blob**
(get+put through the Worker) at **8× capped concurrency** = ~35 s for 500 blobs, which EXCEEDS the
per-PUT D1 savings (legacy PUTs pool at 16×). So **§23 with the get→put promote is a net regression
at every scale** — it is NOT mergeable as-is. The D1-load reduction is real but does not pay for the
promote.

**Conclusion (data-backed): the staging→canonical promote MUST be server-side (R2 S3 CopyObject) —
it is a prerequisite for §23, not an optimization.** Two paths to a real win:
- **(A) R2 S3 CopyObject** (`docs/r2-s3-copyobject-setup.md`) — server-side copy, ~50 ms/op, no
  Worker round-trip. Implemented + SigV4-validated + feature-flagged; **blocked on the one-time R2
  S3 credential** (dashboard, can't be minted by the deploy token).
- **(B) single-user direct-write** — since "we're the only users", PUT could write the canonical key
  directly (no staging, no promote, instant commit), accepting uncollected canonical orphans from
  abandoned pushes (the multi-user M7 attack codex closed is moot for one user). Realizes the win
  now without a credential, but abandons the codex-PASSED staging/GC-safety design → needs a design
  decision + codex re-review before adopting.

Until (A) or (B), §23 stays on its branch unmerged (correctly — it's a regression as-is).

### Correctness verified (synthetic)
Byte-identical **passive sync**: a fresh host (`init --workspace` + `pull`) reconstructed
all 100 files from the encrypted blobs, `diff -rq` clean. Over-cap → 402 (trigger rolls
back the batch), idempotent re-commit charges 0, present-gated `missingBlobs`.

### Next (to land §23 to main)
1. **R2 S3 CopyObject promote** (kill the get→put cost) — then re-bench total-push.
2. §23.5 reconcile sweep + staging-prefix R2 lifecycle + per-account PUT rate limit;
   remove the legacy canonical GC + the legacy PUT/commit paths (the `426` cutover).
3. Multipart-on-receipts (large files) — currently legacy canonical+grant (fine).
4. Bench dfinitiv/savvy-core (4287 files) once the promote is server-side.

### §23.5 hardening — implemented (unblocked, no credential needed)
- **Reconcile sweep** (`reconcile.ts`, in the scheduled handler): present=0 crash-tail refs →
  R2-head canonical → adopt(present=1, keep charge) / re-promote from staging / lease-guarded
  atomic revoke+refund. 4 tests (adopt, re-promote, revoke, lease-guard). Closes the v8/v10
  "entitled-but-not-yet-canonical" tail.
- **Staging GC** = R2-native lifecycle rule on `staging/` (expire 1 day = `STAGING_GC_GRACE`,
  set on `rbox-dev-blobs`) + the existing 7-day incomplete-MPU abort. Zero hot-path code; the
  M7 orphan-byte backstop. `RECEIPT_TTL`=12h < 24h holds.
- **Remaining before merge** (gated on the benchmark / low-priority): per-account PUT rate-limit
  binding (M7 accrual bound — low priority for a single-user system); remove the legacy
  destructive canonical GC (`gcMark`/`gcPurge`) + the legacy PUT/commit paths (the 426 cutover,
  breaks the old GC tests — do last); /simplify + /antislop; atomic merge.

---

## §23 + S3 CopyObject — MEASURED on real savvy-core (2026-06-30)

R2 S3 CopyObject promote enabled (creds derived from the `cfut_` user token: AccessKeyID =
token id, Secret = SHA-256(value); verified read+write on `rbox-dev-blobs`). SigV4 in-worker,
validated vs AWS's published vector. Clean head-to-head: **fresh accounts, empty workspaces,
files added after init, same real savvy-core files**, legacy (main) vs §23+S3:

| cold push        | legacy | §23 + S3 CopyObject | §23 / legacy |
|------------------|-------:|--------------------:|:------------:|
| **500 files**    | 23.6 s | **19.0 s**          | **1.24× faster** ✓ |
| **2000 files**   | 83.6 s | 136.7 s             | 0.61× (1.6× SLOWER) ✗ |

S3 CopyObject fixed the get→put regression at 500 files (was 41s → 19s, now beats legacy). BUT
**§23 does not scale** — the win reverses by 2000 files. Why (from §25 AE):
- `blob.put` stays D1-free (dbCalls=0) but staging-PUT latency degrades under sustained load
  (p50 140 ms, **p90 776 ms** at 2000 blobs).
- the §23 **commit is a SERIAL O(N) phase** legacy doesn't have: promoting 1980 blobs
  staging→canonical took **19 s** (S3 CopyObject ~217 ms/op — a worker→R2-S3 round-trip — at
  ~22× effective concurrency). Legacy spreads its per-blob D1 work *across the pooled uploads*
  (overlapped); §23 defers ALL accounting+promote to one serial commit that grows with N.

**Honest conclusion:** §23 (staging + commit-promote) is a **net win for small/medium repos
(~20% at 500 files) but a regression for large repos** — the GC-safety the staging/promote buys
costs an O(N) serial R2-copy phase at commit. The crossover is ~1k files. To win at savvy-core
scale (4294) the promote must stop being a serial per-blob commit phase. Options, in order:
1. **higher promote concurrency** (S3 ops are light; pushing 24→64 may cut the 19 s commit ~2×).
2. **overlap / pipeline** the promote with uploads, or **async promote** (`waitUntil` + serve
   reads from staging until present=1) — push returns fast, promote in background (the "direct
   write"-adjacent option; needs codex re-review of the head⟹present invariant).
3. **eliminate the promote** (single-user direct-write — PUT writes canonical; the option
   declined earlier, but the data now argues for revisiting it for large repos).

---

## §23 v2 — DIRECT-WRITE: the breakthrough (2026-06-30, codex-recommended)

Asked codex for a second opinion on the scaling regression. Verdict: **ditch the
staging→canonical promote entirely** (option C). PUT writes the CANONICAL key directly (R2
sha-verified) + returns a receipt; commit is a PURE D1 batch (catalog `present=1` + charge via
NOT-EXISTS + grant + un-condemn) — **NO promote, NO staging, NO S3 copy**. The single-user
reality makes the canonical-orphan concern moot (online canonical GC already removed from the
cron). This eliminates the serial O(N) commit phase that made the promote version regress.

**Measured (fresh accounts, empty workspaces, real savvy-core files, clean head-to-head):**

| cold push    | legacy | §23 + promote | **§23 direct-write** | vs legacy |
|--------------|-------:|--------------:|---------------------:|:---------:|
| **500 files**  | 23.6 s | 19.0 s        | **4.6 s**            | **5.1× faster** |
| **2000 files** | 83.6 s | 136.7 s       | **14.0 s**           | **6.0× faster** |

**The win GROWS with scale (5.1× → 6.0×)** — exactly the O(N) per-PUT D1 elimination, now with
no promote tax. `blob.put` stays dbCalls=0; commit is O(chunks) pure D1. This is the §23 payoff
the whole effort was for.

**Correctness:** direct-write passive sync verified **byte-identical** (fresh host
`init --workspace` + `pull`, unique-content corpus, `diff -rq` clean). Over-cap → 402 (trigger
rollback), idempotent re-commit charges 0. 98 api tests green.

**Caveat (pre-existing, NOT §23):** a full 4294-file savvy-core round-trip is blocked by a
shared-engine bug with **duplicate-content / empty files** — `main`'s binary `sha_mismatch`es on
the same fileset, and the pull 404s a few blobs. This is the duplicate-content/0-byte class from
the v0.1.1 learnings, re-exposed at savvy-core scale; it affects the legacy path identically and
is independent of §23/direct-write. Tracked separately.

---

## ⛔ §23 BLOCKER (found before merge): data loss with duplicate-content + high concurrency

Pulling a §23 push to a fresh host revealed **lost blobs** (404 on pull). Run down:

| test | conc | result |
|------|-----:|--------|
| 60 savvy files | 32 | ✓ byte-identical |
| 300 savvy files (501-800) | 8 | ✓ |
| 200 savvy files (801-1000) | 8 | ✓ |
| 500 savvy files (501-1000) | 32 | ✗ blobs lost |
| **500 UNIQUE synthetic** | **32** | **✓** (rules out pure concurrency) |
| **500 synthetic, 250 DUP-content pairs** | **32** | **✗ 1 lost** (clean repro) |
| 500 savvy (501-1000) **legacy binary** | 32 | ✓ (rules out pre-existing / engine) |

**Characterization:** the loss happens ONLY at the intersection of **duplicate-content files**
(same convergent `encSha`) **AND high upload concurrency** (conc ≫ 8). Unique content is fine at
any concurrency; dup-content is fine at conc≤8; **legacy (grant-on-PUT) is unaffected at conc=32**
— so it is **specific to the §23 receipts protocol**, not the shared engine. The push reports
success (no 422), entitlement is granted (~496/496 blob_refs), but some canonical objects are
missing on read → a referenced blob's bytes are gone.

**This BLOCKS the merge.** A 6×-faster sync that silently drops a blob on a real repo is not
shippable. Repro (deterministic): `dup-A` test above — 250 files in `a/` + identical 250 in `b/`,
`RBOX_UPLOAD_CONCURRENCY=32`, push then pull to a fresh dir → `diff` shows a missing file.

**Suspected area (needs client instrumentation to confirm):** the receipts-protocol upload→commit
path under dedup — `missingBlobs` returns unique encShas (`sync.ts:109`), `ctByEnc` is overwritten
by concurrent encrypts of dup-content (`sync.ts:107`), and the receipt map (`remote.ts`) is
populated under concurrency. Legacy avoids it by granting on the PUT itself. **Next: instrument
the client to log, per push, uploaded-encShas vs receipts-sent vs blobRefs-referenced vs
granted, on the dup-A repro at conc=32, and find which set drops the blob.**

Interim safe workaround: `RBOX_UPLOAD_CONCURRENCY=8` round-trips correctly. Do NOT merge until the
root cause is fixed and the dup-A repro + a full 4294-file savvy-core round-trip both verify clean.

### §23 blocker — narrowed (counts are consistent; it's a per-blob persistence/grant gap)
Instrumented the dup-A repro (250 dup pairs @ conc=32): server saw `shas=252, receipts=251,
newRefs=251, needsUpload=0`; client saw `uniqueEncShas=251, missing=250, receiptsSent=251`. Those
counts are all CONSISTENT (the README committed at `init` is legitimately already-present → `have=1`;
the 250 new dup-blobs each upload once + receipt + grant; manifest +1). So it is NOT a dropped
receipt or a missingBlobs miscount. Yet one referenced blob 404s on pull → for ONE of the 250
distinct-key PUTs, either its canonical R2 object didn't persist or its `blob_refs` grant didn't land,
under dup-content + high concurrency. Next session: after a dup-A push, enumerate the 250 uploaded
encShas and assert each has (a) a canonical R2 object and (b) a `blob_refs` row — bisect to the one
that's missing and determine canonical-vs-grant. NOTE the shared dev DB + whether the bootstrap KEK
is deterministic can confound `have`; use a guaranteed-unique-content dup repro (each pair's content
random) on a freshly-wiped check.

### ✅ RESOLVED — the "blocker" was a verify-harness artifact, not §23
The reported data loss was a bug in my BENCHMARK HARNESS, not in §23:
- the verify script read `workspace.json.workspaceId` (the field is `remoteWorkspaceId`) → host-B
  `init --workspace ""` → 404s that looked like blob loss;
- the canonical-presence S3 check used the wrong bucket name → bogus "canonical missing";
- re-running `init --workspace` on dirty state produced spurious diffs.
With a CORRECT harness (fresh accounts, `remoteWorkspaceId`, clean dirs), §23 direct-write is
**byte-identical at conc=32**: savvy-core 501–1000 (500 files) ✓, and **501–2500 (2000 files) ✓**
(push 14.9 s, host-B pull reconstructs all 2001 files identically). 0/6 dup-content repro failures.

**§23 direct-write is FAST (6×) AND CORRECT.** Mergeable. Final numbers (fresh accounts, real
savvy-core, conc=32, clean harness):

| cold push | legacy | §23 direct-write | speedup |
|-----------|-------:|-----------------:|:-------:|
| 500 files  | 23.6 s | 4.6 s  | 5.1× |
| 2000 files | 83.6 s | 14.9 s | 5.6× |

Passive sync (push host A → pull host B) byte-identical at both sizes.

---

## Convergence — the perf workstream's measured ceiling (2026-06-30)

After §23 shipped, I measured each remaining doc against its own gate instead of building on faith.
The data says the backend-perf workstream has **converged**: the one hot-path D1 storm (upload)
is gone, and the rest is bytes-on-the-wire, which no server change removes.

| doc | what it would do | measured ROI | verdict |
|-----|------------------|--------------|---------|
| **§23** upload-receipts | D1 off the upload hot path (7 calls→0) | **5–6× sync, grows with N** | ✅ shipped + released v0.2.0 |
| **§25** observability | per-op AE metrics | enabled all the above measurements | ✅ shipped |
| **§26** batch-upload | amortize per-request fixed overhead | post-§23 `blob.put`=126 ms of which **120 ms is the R2 write**; fixed overhead ≈6 ms → batching saves **<5%** of upload time | ⏸️ **fails its own gate** — R2 bytes dominate, not overhead |
| **§27** download-caps | D1 off the pull hot path | pull D1 is a single **indexed** `blob_refs` read ≈8% of a 15.1 s/2000-blob clone; D1-free needs Merkle proofs + §24 | ⏸️ **deferred** — ~8% behind real complexity |
| **§24** blobref-sidecar | move refs out of the 1 MB commit body | unblocks ~50k-file repos (today's cap ~12k); **no current repo needs it** (savvy-core=4.3k) | 🟡 **available** as a pure scaling unblock if/when repos get huge |

**The through-line (also the §23 learning):** measure end-to-end before believing a design. §23's
own 10-codex-round staging design was a 2.4× *regression*; the simple direct-write won. Same lens
here kills three more speculative builds before they cost anything. The remaining wins are
client-side (decrypt/write throughput, concurrency) and physics (R2 transfer), not server D1.

---

## §24 blobRef sidecar — SHIPPED (2026-06-30): the signed commit body is now O(1)

Per the user's directive to take EVERY backend-perf doc through the full cycle (not just the
ones with a speed win), §24 was implemented after the convergence note above. It is a
**correctness/scaling** change, not a latency win — and the measurements say so honestly.

**What it does.** The signed commit body used to inline one `{encSha,size}` (~85 B) per unique
blob. Above a threshold the refs now live in a content-addressed R2 **sidecar** (`rbox-refset-v1`
binary: magic ‖ u32be count ‖ count×(32 raw sha ‖ u64be size)); the body carries only the
`{sidecarSha,count,totalBytes}` descriptor. The signature still commits to `sidecarSha`, so
integrity is unchanged. Server resolves+validates the sidecar at commit (direct-write: GET the
canonical blob, bound by R2-reported size, hash-verify, strict-parse, descriptor-match), charges
`sidecarSha` like any blob, and `roots()` is sidecar-aware + fail-closed for GC.

**Measured on dev (real D1/R2/DO), savvy-core 4287 files / 4217 unique blobs:**

| metric | inline (pre-§24) | §24 sidecar | change |
|---|---|---|---|
| **signed commit body** | ~358 KB (4217×85 B) | **533 bytes** | **~670× smaller, now O(1)** |
| cold push wall (4287 files) | ~37 s (extrapolated §23) | **38.9 s** | neutral (one sidecar PUT amortized over 4287 blobs) |
| fresh-checkout clone | byte-identical | **byte-identical** | ✓ (0 content diffs; only default-ignored `.env`/`.DS_Store` differ) |
| commit-body cap pressure | hits 1 MB at ~12k refs | **gone** (body O(1)) | unblocks repos past the inline cap |

**The honest result:** §24 buys ZERO push/pull latency — the work (encrypt + upload N blobs +
account) is identical; it just adds one small sidecar upload. What it buys is **the 1 MB / D1-row
body ceiling disappearing** — a repo whose inline body would exceed ~1 MB (~12k refs) now commits.
v1 still keeps the §23.4 accounting cap (6000 refs/commit), so it does NOT yet raise the accepted
ref count — that needs the separate deferred large-ref accounting design. The threshold
(`SIDECAR_THRESHOLD`=4000) means small repos stay inline (full old/new-client interop); only large
repos — which an old client couldn't commit anyway — use the sidecar, so nothing regresses.

---

## §26 batch-upload — NOT BUILT; the win was a concurrency default (2026-06-30)

Took §26 through its cycle: codex review → **DONT-BUILD** + ran the measurement gate. The gate
failed (R2 bytes are 95% of a PUT — the doc's own "don't build if R2 dominates" condition), and
§26 would add a streaming frame parser + a quota-abuse surface for ≤13%. Instead, the gate
surfaced a **free win bigger than §26's ceiling**: §23 had shifted the upload-concurrency knee.

| upload concurrency | savvy-core push wall (4287 blobs, dev) |
|---|---|
| 32 (old default) | 31.3 s |
| **64 (new default)** | **23.4 s — ~25% faster** |
| 96 | 26.4 s (regresses — R2/connection limits) |

**Why the knee moved:** the old default (32) was measured PRE-§23, when each PUT did ~7 D1
round-trips and more concurrency just multiplied D1 contention. §23 moved D1 off the PUT (pure R2
write now), so the upload scales to ~64 before R2/connection limits bite. One-line fix
(`uploadConcurrency` 32→64 in `src/cli/sync.ts`) — no new endpoint, no parser, no abuse surface.
**Third time the simple lever beat the complex one** (§23 direct-write > staging; §27 deferred;
§26 concurrency > batch endpoint). Reaches CLI users on the next release.

---

## §27 download-capabilities — CONFIRMED DEFERRED; pull win was download concurrency (2026-06-30)

Closed §27 the same way as §26: measure the cheap lever before building the complex feature. A
direct download-concurrency sweep on a savvy-core clone (4287 blobs, dev) settles it:

| download concurrency | clone wall |
|---|---|
| 32 (old default) | 28.8s / 31.6s |
| **64 (new default)** | 26.4s / 27.2s |
| 96 | 25.6s / 26.9s |
| 128 | 22.9s / 23.7s |

Clone time falls monotonically with concurrency and **never plateaus on D1** — so the per-blob
entitlement read §27 removes is NOT the clone bottleneck (download throughput is). §27's HMAC
capability + Merkle-inclusion-proof scheme would remove an uncontended read for ~8%, behind real
complexity. The actual pull win was a **stale default**: download concurrency was 32 "by analogy
with the old upload knee," never directly swept. Bumped to 64 (`src/engine/apply.ts`) — ~14% off a
clone for one line, env-tunable toward 128. §27 stays designed-but-unbuilt.

### Scorecard for the backend-perf workstream (§22–27)
- **§23** upload-receipts — SHIPPED, 5–6× push (the one real hot-path D1 win).
- **§25** observability — SHIPPED (enabled every measurement here).
- **§24** blobRef sidecar — SHIPPED, commit body O(1) (correctness/scaling, neutral latency).
- **§26** batch-upload — was NOT BUILT at the time of this scorecard; **later re-measured and
  SHIPPED under design 112** (`POST /v1/blob-batch/put|get`, `apps/api/src/routes/blob-batch.ts`,
  client `src/cli/remote/blob-batch/`). Upload-concurrency 32→64 (~25%) was the better lever *then*;
  the default is now 512 under batch mode (`src/cli/publish-pipeline/shared.ts`).
- **§27** download-caps — DEFERRED; download-concurrency 32→64 (~14%) was the better lever.
- **§22** umbrella.
The recurring lesson, four times over: **measure, and the simple lever usually beats the complex
feature.** The big structural win (§23, D1 off the upload hot path) was real; the rest was either
O(1)-correctness (§24) or a concurrency default that had gone stale when §23 moved the bottleneck.

---

## §30 — large-ref commit accounting (the cap that blocked real workspaces) + first cross-host benchmark

**Dogfood discovery (2026-06-30).** Pushing a real dev folder (`~/conductor/workspaces`: 65,421
files → **11,925 unique blobs** after per-account dedup, 2.68 GB ciphertext) uploaded every blob
then failed the commit: `413 too_many_refs, max 6002`. §24 had made the commit *body* O(1), but a
SECOND, hidden ceiling remained: `commitAccounting` charged/granted every ref in ONE atomic D1
`batch()`, soft-capped at ~6000. Any workspace past ~6k unique blobs simply could not commit.

**The platform-limit reality (codex round-1 framed it wrong; the CF docs corrected it):** D1
`batch()` is **ONE subrequest**, not N statements counted toward a limit. The binding ceiling is
**~1000 subrequests per Worker invocation**; the per-`batch()` ceiling is D1 **isolate CPU/memory**.
The subrequest hog was `validateCommitRefs` (one SELECT per 90 refs). So the fix:
- charge/grant in **sequential atomic super-batches** of ≤3000 refs (each one subrequest, cap-guarded);
- **batch the validate SELECTs** (one `db.batch()` per group, not one round-trip per 90);
- on over-cap, **keep the completed super-batches charged** (idempotent retry) — NO compensation
  (codex's own endorsed path; the founder killed the gold-plated rollback: a near-cap concurrent
  race is "a different problem" than the actual use case).
- `MAX_REFS_PER_COMMIT = 50k` hard reject, but **12k validated, 50k behind measurement** (the real
  ceiling is isolate CPU/mem, not subrequests).

**First real large-workspace + cross-host benchmark (prod, v0.4.1):**

| Stage | Result |
|---|---|
| Cold push (Mac → prod R2) | **192 s** — 65,421 files → 11,925 unique blobs, **2.68 GB** committed |
| Commit | `sequence 1` at ~11,925 refs — **2× past the old 6,002 cap**; the commit's D1 work is a few super-batches, negligible vs transfer |
| Cross-host pull (prod → flat-meadow x86 Linux) | **433 s** — 65,476 files, **0 conflicts** (each blob decrypt-verified vs `plaintextSha`) |
| Byte-identity | 10/10 sampled files hash-identical across hosts |

The push is bandwidth/CPU-bound exactly as §"how fast is fast enough" predicted (encrypt pass +
~30 MB/s uplink); the §30 commit added negligible wall time. The pull is download + 65k-file write.

**Lesson:** "we fixed commit-body scaling (§24)" did NOT mean "large repos work" — a separate
accounting-cost cap silently blocked them. Two different scaling axes hid behind one feature; only
pushing a *real* 65k-file workspace end-to-end surfaced it. (See also `learnings.md` §30/§31 — the
same dogfood run exposed a P0 multi-device brick that no fresh-account test would catch.)
