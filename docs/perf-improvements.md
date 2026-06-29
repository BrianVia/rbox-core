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
- **Encrypt double-pass**: `encryptFileToTemp` hashes plaintext then ciphertext;
  the scan already computed the plaintext sha — reuse it? (bench the win first)
- **chain-verify growth** on pull (`verifyCommitChain` is history-linear) — needs a
  verified-checkpoint cache past some depth.
