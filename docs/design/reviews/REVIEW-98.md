# REVIEW-98 — adversarial review ledger for design 98 (first-publish pipeline)

Reviewer: `codex exec` (gpt-5.6-sol), read-only, adversarial. Cap 5 rounds.
Verdict line per round + numbered items + disposition (accepted/rejected + why).

---

## Round 1 — VERDICT: REVISE (20 items)

All 20 accepted (a strong, correct review). Dispositions:

1. **Resume terminology wrong** — `/v1/blobs/check` is entitlement+GC-fence, not
   presence. ACCEPTED: renamed "present-check" → "server-satisfied check"; split
   the unsatisfied tail into absent / unentitled / GC-fenced; gates test all three.
2. **Drainer loses 422 `needsUpload`** — ACCEPTED: drainer now owns a durable
   in-process `needsUpload` accumulator; `flush()` returns it; commit is blocked
   until repaired; dedup vs newly captured receipts specified (§3.3).
3. **Drainer unhandled-rejection/race** — ACCEPTED: explicit error latch,
   terminal state, generation-safe drain, structured cancellation (§3.3).
4. **`Promise.all` is not cancellation** — ACCEPTED: added a shared
   `AbortController` abort protocol; queue close/error; producer termination;
   numeric post-402 upload bound in the gate (§3.5, gate 3b).
5. **Byte bound omits owners** — ACCEPTED: memory/disk budget now enumerates
   queue + producer-held + coalescer + uploader-held + batch-framing copy
   amplification + retry bodies (§3.2).
6. **Oversize admission deadlock** — ACCEPTED: oversize admission rule (admit
   when occupancy is zero even if the item exceeds a cap) + test (§3.2).
7. **Temp lifetime unsafe around batching/dedup** — ACCEPTED: reference-counted
   temp ownership released only after batch-encode/fallback/retry/dedup/abort all
   release (§3.2).
8. **Buffer-upload API does not exist; design 99 absent** — ACCEPTED: v1 ships
   FILE-BACKED ONLY; the buffer-backed lane is explicitly a prerequisite on
   design 99 delivering a batch buffer-PUT API (§3.4).
9. **Per-file readiness underspecified for fused response** — ACCEPTED: v1
   readiness = one event per resolved single-file encrypt (exists today); fused
   streaming/partial-success/worker-death/buffer-ownership deferred to the
   design-99 seam contract (§3.4).
10. **Progressive redemption grants before commit → orphan entitlement** —
    ACCEPTED: orphan entitlement stated as accepted semantics, bounded, reclaimed
    by GC; dropped the "final entitlement set unchanged" claim (§6.3).
11. **Quota across super-batches not exactly equivalent** — ACCEPTED: weakened to
    monotonic + idempotent accounting; permitted variance stated (§6.3).
12. **Restart invariant overstates persistence** — ACCEPTED: explicit
    persistence model; graceful-abort vs SIGKILL/power-loss distinguished;
    re-encryption bounded per case (§6.1).
13. **Cache/cleanup crash matrix; "re-encrypt 0" false for unsatisfied hits** —
    ACCEPTED: zero-re-encryption gate scoped to server-satisfied cache hits;
    reconstruction bounded separately (§6.1, gate 3).
14. **P0.2 headroom math omits missing/redeem/commit** — ACCEPTED: fully
    specified baseline equation; gate on end-to-end A/B wall (§5.2, §7 gate 1).
15. **Unfalsifiable thresholds** — ACCEPTED: concrete numbers + statistical
    method (p50/p95, 10 warm/5 cold, A/B control) for every gate (§7).
16. **P0.3 not measurement-only** — ACCEPTED: Phase 0 split into P0
    (measurement-only, current path) and a flagged Prototype-Calibration phase
    (§5).
17. **§4 Finding 9 re-proposal** — ACCEPTED: stripped "ship §4" language; §4 is
    now a measurement + deferral record only; protocol/threat model deferred to
    its own reviewed design (§4).
18. **Auth measurement not causally identified** — ACCEPTED: measure
    critical-path overlap, not summed `authWallMs`; gate on observed publish-wall
    A/B (§4, §5.2 P0.4).
19. **Missing failure modes** — ACCEPTED: added a failure-mode table (§6.4).
20. **Drainer "strict improvement"** — ACCEPTED: rollout treats it as an
    independently gated semantic reorder (§8).

## Round 2 — VERDICT: REVISE (12 items)

All 12 accepted. Dispositions:

1. **Disk budget omits plaintext snapshots + crypto in-flight outputs** —
   ACCEPTED: budget now reserves before encryption (expected input + worst-case
   ciphertext per in-flight crypto job), reconciles on completion; the oversize
   rule covers the whole crypto working set (§3.2).
2. **Abort doesn't reach BlobBatchUploader internals** — ACCEPTED: the pipeline
   requires an abort-aware `close()` on the batch uploader (drop queued groups,
   cancel timers, no fallback dispatch after close); the post-402 bound is
   defined over an atomic dispatch counter (§3.5).
3. **3-way unsatisfied classification unobservable client-side** — ACCEPTED:
   `/v1/blobs/check` returns only `missing`; the three split metrics are removed
   in favor of `serverUnsatisfiedTotal` + `serverSatisfiedSkipped`; a
   privacy-safe server-side aggregate breakdown is optional future work (§5.1).
4. **Cache-hit scheduling contradictory on resume** — ACCEPTED: explicit state
   transitions — a cache hit goes to the rolling check WITHOUT a ready event; an
   unsatisfied cache hit re-enters the ENCRYPT lane (shares producer
   backpressure) and emits `ready` only after re-encryption (§3.1/§3.2).
5. **`needsUpload` dedup too early** — ACCEPTED: an accumulated `needsUpload`
   entry is removed only after successful REDEMPTION of the replacement receipt,
   not on capture (§3.3).
6. **Ref-count impossible at the uploader seam** — ACCEPTED: replaced with a
   single-release rule — `putFile` promise settlement is the SOLE release point
   for a temp; the uploader must guarantee no path read after settlement (it
   already reads only the first waiter's path for duplicates,
   `dispatchSingleGroup`) (§3.2).
7. **Quota-abort bound observation point undefined** — ACCEPTED: an atomic
   dispatch counter (incremented when a request body begins transmission),
   checked against the abort latch; gate 3b counts that counter (§3.5, gate 3b).
8. **p95 gates unspecified; small-N vague** — ACCEPTED: noise statistic defined
   (control p95 − p50, floored at 5% of p50); explicit p50 AND p95 inequalities
   per gate; small-push threshold fixed at 64 changed files (§7).
9. **Receipt-residue gate vacuous** — ACCEPTED: sampled instants defined
   (backlog high-water during the run; residue at the instant the last upload
   settles, before `flush()`); a pending-receipt backlog cap added as
   backpressure (§3.3, gate 5).
10. **Resume invariant overclaims** — ACCEPTED: reworded — the cache persists
    ADDRESS COMPUTATION, not reusable ciphertext; no-re-work is claimed only for
    server-satisfied persisted descriptors (invariant, §6.1).
11. **Post-ready churn semantics unstated** — ACCEPTED: stated explicitly — the
    manifest intentionally commits the SCAN snapshot; a ciphertext validated
    against the scanned tuple at snapshot time remains valid to commit even if
    the source changes afterward (identical to today); mutation-after-ready test
    added (§6.5).
12. **Heap "budget" not enforceable inside the uploader** — ACCEPTED: invariant
    weakened — enforceable accounting covers pipeline-owned bytes only; uploader
    internals are a MEASURED high-water target (gate 4), not a claimed hard
    bound (§3.2).

## Round 3 — VERDICT: REVISE (4 items)

All 4 accepted. Dispositions:

1. **Server-satisfied ready blobs never hit `putFile` → temp/reservation leak**
   — ACCEPTED: release rule generalized to "disposition settlement": a temp and
   its disk charge are released when the blob's DISPOSITION settles — `putFile`
   promise settlement, OR a server-satisfied rolling-check answer, OR
   convergent-duplicate satisfaction (§3.2).
2. **No explicit EOF/drain protocol for successful completion** — ACCEPTED:
   defined — producers close the readiness stream after the last encrypt
   settles; queue EOF propagates; the rolling checker flushes its final partial
   batch on EOF (not timer-dependent); commit is reached only after the ordered
   barrier: producers settled → queue drained → consumers settled → final
   checker flush → `drainer.flush()` (§3.6).
3. **Crypto cancellation interface unstated** — ACCEPTED: stated — the pool
   provides NO cooperative cancellation and this design adds none; abort stops
   NEW dispatch only, in-flight `CryptoPool.encrypt` jobs are AWAITED, and temp
   unlink / `fs.rm(tmpDir)` runs only AFTER the producer-termination barrier
   (all in-flight encrypts settled) so workers never write into deleted storage
   (§3.5).
4. **P0.2 `expected overlap` is a free parameter** — ACCEPTED: replaced with a
   parameter-free optimistic upper bound (redemption assumed fully overlapped)
   fixed before measurement (§5.2).

## Round 4 — VERDICT: REVISE (3 items)

All 3 accepted. Dispositions:

1. **EOF circular for re-queued cache hits (a static `poolMap` cannot take
   late work)** — ACCEPTED: the encrypt lane is now an explicitly CLOSEABLE
   dynamic work queue with an outstanding-work counter; producer EOF is
   declared only when both input lanes are closed (scan-derived misses
   exhausted AND cache-hit checker has classified every address) and
   outstanding classification + re-encryption work is zero (§3.6).
2. **Snapshot can exceed its reservation when a source grows after scan** —
   ACCEPTED: the pipeline requires a SIZE-CAPPED snapshot: the snapshot copy
   reads at most `expectedSize + 1` bytes and a source that exceeds
   `expectedSize` mid-copy churn-defers immediately, before any write beyond
   the reservation — making the disk bound hold regardless of live source
   growth (§3.2).
3. **Abandoned temp dirs leak across SIGKILL runs** — ACCEPTED: stale-temp
   reclamation policy added — pipeline temps live under a workspace-scoped
   directory embedding the owning pid; every push start reclaims directories
   whose owner pid is dead (plus an age floor); gate covers repeated hard
   kills (§6.1, gate 3).

## Round 5 (FINAL, cap reached) — VERDICT: REVISE (1 item)

1. **Stale-temp reclamation not robust to PID reuse** — ACCEPTED and fixed
   exactly as the reviewer prescribed: reclamation no longer reasons from PID
   liveness at all. Ownership is established by the design-93 workspace sync
   mutex — at push start, under the mutex, no other pipeline for this
   workspace can be mid-run, so every sibling temp directory not created by
   the current process is stale by construction and reclaimed unconditionally
   (the embedded pid becomes diagnostic only). Gate 3 gains a PID-reuse
   simulation case (§6.1, gate 3).

## Round 6 (confirmation, main-session dispatch) — VERDICT: REVISE (1 wording item) → resolved

Focused round verifying only the post-cap §6.1 fix. Codex confirmed the mutex
mechanism itself is sound (item 2: no double-reclaim race, safe across daemon
restart and concurrent publishers, no contradiction elsewhere in the doc), but
caught residual PID-flavored wording (item 1): "not created by the current
process" still made process identity the exemption test, which breaks when a
restarted daemon reuses a stale directory's embedded pid, or when a long-lived
daemon leaves its own prior failed-cleanup directory behind.

1. **Process identity must play no role** — ACCEPTED and fixed with the
   reviewer's prescribed remedy: under the mutex, reclamation removes EVERY
   pre-existing `enc-*` sibling directory before creating the current run's
   directory; the only exempt directory is the one created after the sweep
   (§6.1).
2. **Mutex mechanism otherwise sound** — no action needed.

## Final state

The loop converged 20 → 12 → 4 → 3 → 1 → 1 items across six rounds; every item
in every round was accepted and incorporated. Round 6 was a focused
confirmation of the post-cap round-5 fix: codex confirmed the mutex-based
mechanism sound and prescribed a final wording correction (sweep-all-then-create
instead of a process-identity exemption), which was applied verbatim. The
mechanism now carries an explicit reviewer disposition on every design point,
with the reviewer's own text stating "with that wording corrected, the mutex
mechanism is sound; no other contradiction was found." Treated as ALIGNED.

## Joint seam rounds with design 99 (2026-07-11, main session)

After both loops closed, the 98↔99 seam was reconciled and reviewed in three
joint codex rounds with BOTH documents visible — the per-design loops had each
inferred the other's internals. Resolution: design 99 §10 is the normative seam
contract; this design's §3.4 Tier 2 adopts it verbatim (single shared
CiphertextLease/CiphertextLocation type; 99's CiphertextBudget as sole charging
authority — maxHeapBytes covers only uploader-owned framing copies of
file-location leases, native Tier 1 or producer-spilled Tier 2; single
disposition protocol with spill producer-only).

Joint round J1 (4 items, all fixed): stale §3.2 claim that the heap axis counts
design-99 buffers; 99 §10's stale "not yet reconciled" text; consumer spill
allowed here but forbidden by 99 §4.2 (resolved: spill removed from consumer
dispositions — the consumer's memory-pressure lever is prompt draining); no
Tier-2 abort bridge (resolved: §3.5 now invokes 99's cancel(), awaits the
posted-job terminal barrier, and only then cleans up). J2 (3 wording items,
fixed): §4.1 spill residue in 99; 99 §5.2 combined-peak claim replaced by the
measured gate; file-variant framing coverage extended to producer-spilled
Tier-2 leases with the abort settlement split (queued/undispatched → abandoned
immediately; already-dispatched → release at HTTP settlement). J3: all
verified, one wording echo in 99 §10 fixed as dictated. Seam ALIGNED.

## Code-comment provenance (113 wave 4)

Review citations relocated from code comments by design 113 wave 4 (comment
sweep). The invariant prose remains at each cited site; the review round that
produced it is recorded here.

- `src/cli/publish-pipeline/stale-temp.ts` (PID-reuse guard): was "design review rounds 5/6" — PID-reuse invariant retained in code.
- `src/cli/publish-pipeline/receipt-drainer.ts` (replacement receipt): was "round-2 item 5" — redeem-before-forget invariant retained in code.
