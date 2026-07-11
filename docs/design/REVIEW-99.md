# REVIEW-99 — adversarial review ledger for design 99 (fused crypto worker jobs)

Reviewer: `codex exec` (gpt-5.6-sol), read-only, adversarial. Loop caps at 5
rounds; stop at `VERDICT: ALIGNED` or record standing disagreement.

## Round 1 — VERDICT: REVISE (18 items)

codex (gpt-5.6-sol, read-only). Summary of items and disposition:

1. Memory bound not a real bound (clone dup, worker results retention, framing body). → **FIXED**: single global ciphertext byte-semaphore spanning worker-output→HTTP-settlement, mandatory transfer lists, reservation before dispatch (§4.1, §7.2).
2. Backpressure too late (results returned before capacity reserved). → **FIXED**: reserve conservative bytes at dispatch time, release on upload-ownership/spill (§4.1).
3. Spill underspecified/inconsistent ("single job can't fit idle" is dead code). → **FIXED**: real trigger = reservation pressure at result-receipt; main isolate writes spill, per-file promise settles file-backed, budget released (§4.2).
4. 256 KiB equivalence false (eligibility plaintext vs batch cap ciphertext). → **FIXED**: added byte-backed single PUT `putBytes`; over-cap memory ciphertext uploads from memory, no temp (§7.5); threshold note (§5.2).
5. Worker memory arithmetic ignores batch retention. → **FIXED**: honest lifecycle model, fused in-flight/worker = 1, recomputed peak (§7.2).
6. Failure isolation only for expected fs errors. → **FIXED**: explicit serializable per-file error allowlist; everything else fails envelope → bounded retry (§7.4).
7. Whole-job crash retry blast radius. → **FIXED**: split-on-retry decomposition to singleton; pathological input isolated (§6.3, §7.4).
8. Result protocol completeness (index uniqueness/exactly-one/malformed). → **FIXED**: validation rules; malformed fails all unresolved slots, never cross-resolves (§6.1).
9. Retry ownership (re-encrypt vs retain body). → **FIXED**: transport retries reuse retained immutable bytes; re-encrypt only on source loss/mismatch; cleanup matrix (§7.5).
10. P0 formula not falsifiable (additive sum, overlap). → **FIXED**: replaced with measurement-only A/B micro-prototype on real corpus, critical-path wall; decomposition demoted to diagnostic (§5.3).
11. Baseline conflict (v1.0.0 vs main). → **FIXED**: one pinned control (remeasured `main` @ pinned commit/flags/corpus/hardware/cache); v1.0.0 historical only (§5.4, §8).
12. Unfalsifiable gates (tolerances/method). → **FIXED**: numeric margins, sampling, host-min memory, APFS+ext4 aggregation, worker-vs-main RSS attribution (§8).
13. Gate 1 wrong boundary (Finding 6 full-publish wall). → **FIXED**: added paired full-publish critical-path gate with 98 enabled (§8 gate 6).
14. Readiness operationally coarsened; "tens of ms" unmeasured. → **FIXED**: primed small first batch; measured p50/p99 readiness-delay + time-to-first-upload gate (§8 gate 7, §10).
15. Small-push "guaranteed" too broad. → **FIXED**: replaced with numeric regression gate, pool-off + pool-on partial-batch (§8 gate 5).
16. Determinism coverage incomplete. → **FIXED**: property/mutation-schedule matrix; eligibility revalidated from bytes actually read (§7.1).
17. Refactor claimed untouched but reroutes inline path. → **FIXED**: `encryptFileToTempInline` kept intact as ORACLE; fused helper is separate, validated byte-for-byte against it (§6.2, §7.1).
18. Shipped work partially re-touched. → **FIXED**: explicit unchanged-vs-touched inventory (§1.1).

## Round 2 — VERDICT: REVISE (7 items)

codex (gpt-5.6-sol). Narrower/deeper holes in the v2 revision:

1. Budget contradiction: releasing on frame-copy hides the framed body's memory; "combined ≈ prior peak" false. → **FIXED**: one lease held dispatch→**HTTP settlement**; uploader frames by **reference** (no copy); single combined budget, gated by measured peak not "≈ prior" (§4.1, §8 gate 3).
2. Reservation/bounds rely on stale scan sizes; files can grow yet stay individually eligible → aggregate overrun. → **FIXED**: fixed per-job reservation = job cap (independent of scan sizes); worker enforces aggregate at read time, over-cap files returned `requeue` (§4.1, §6.1, §6.3).
3. Retry accounting unbounded/lifecycle-incomplete; reservation ownership across splits undefined; release-vs-retry contradiction. → **FIXED**: explicit retry-tree state machine, per-file attempt cap K=3, parent releases before children re-reserve (§6.3).
4. 98 interface lacks ownership/settlement protocol; per-file promise insufficient. → **FIXED**: `CiphertextLease` with `release()`/`cancel()`; budget freed exactly on framed/spilled/rejected/deduped/abandoned; early-stop reclaims leases (§10, §4.1).
5. §6.4 doesn't prove streaming per-file readiness (not input-order/after-map). → **FIXED**: two concrete producer APIs — legacy per-file promise (poolMap) and 98's `onReady(lease)` stream with backpressure+cancel (§6.4, §10).
6. Gates 3/6/7 still soft ("materially closer", "measurement noise", no CI). → **FIXED**: numeric overlap-efficiency ≥0.5, ru_maxrss hard-peak bound + absolute slack, bootstrap 95% CI / Mann–Whitney (§8).
7. Mutation correctness claim too broad when `expected` absent. → **FIXED**: `expected` MANDATORY in batch protocol (production call sites already pass it, `sync-recovery.ts:225,294`); snapshot-equivalence claim scoped to the with-expected case (§4, §6.1, §7.1).

## Round 3

Status: pending (codex running).
