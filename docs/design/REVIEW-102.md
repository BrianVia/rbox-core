# REVIEW-102 — adversarial review ledger for design 102 (O(change) commit admission)

Reviewer: codex (gpt-5.6-sol), read-only, adversarial. Cap 6 rounds.
Attack focus: carried-ref regrant under active deletion intents (can a fenced
blob's data be lost?), client-forged/replayed refsets, parent-refset
unavailability (fail closed?), quota under-charging via delta manipulation,
root-index divergence, shadow-mode blind spots, Worker memory bounds,
unfalsifiable gates.

---

## Round 1 — VERDICT: REVISE (15 items)

Codex (gpt-5.6-sol, medium) delivered a deep review. Dispositions:

1. **Carried-ref fence TOCTOU** — ACCEPT (reframe). The snapshot was presented as
   load-bearing; it must not be. Rewrote §3.3 so carried-ref safety rests on the
   D1-level **blob_refs-row-persistence invariant** (openIntents opens a
   `deleting_at` intent only `WHERE NOT EXISTS blob_refs` — versions.ts:431 — so an
   intent literally cannot be created against a carried ref that still holds this
   account's grant; phase1Purge resurrects reachable candidates rather than
   dropping them; `/roots` fails closed). The fence probe is demoted to a
   fail-closed bug-detector: nonempty `fence ∩ carried` ⟹ fallback + alert.
2. **Fenced carried blob loss** — ACCEPT/REBUT. Precluded by item 1's invariant;
   proof rewritten and the deterministic race rig (item 15) added as the gate.
3. **blob_ref_candidates race** — ACCEPT (reframe). Same treatment; phase1Purge's
   fresh reachable-resurrect is the serialization; marker-skip cannot drop a
   head-reachable ref. Documented in §3.3/§4.4.
4. **Child-refset trust overstated** — ACCEPT. Rewrote §3.4: safety = authoritative
   parent + full validation of every server-derived addition, NOT "server-authored
   child bytes." Added replay/omission/substitution/dup adversarial tests.
5. **Quota sizes must come from receipts** — ACCEPT (important). mergeDiff now
   yields SHA membership only; sizes for added refs continue to come from
   `verifyReceipt` inside the unchanged `validateCommitRefs`. §3.2/§4.1 fixed.
6. **Parent-unreadable = history corruption, not just a miss** — ACCEPT. §3.5 now
   distinguishes optimization-fallback from authoritative-history-corruption, pages
   on the latter, notes GC/prune independently fail-closed.
7. **Roots-index "equality-of-derivation" insufficient** — ACCEPT. §4.7 reframed:
   this design does NOT feed the index; index stays correct via the unchanged
   stored `seq:<n>` body; added a divergence monitor (admission delta vs folded
   dropped_index) and made index-priming an explicit follow-on.
8. **Shadow mode can't compare equivalent values** — ACCEPT (important). Rewrote
   §6: read-only comparison of `validateCommitRefs(admitSet).newRefs` vs
   `validateCommitRefs(fullChild).newRefs` from ONE immutable pre-state; fence/
   over-cap equivalence proven by the injected-race rig, not a dry query.
9. **Shadow telemetry unbounded** — ACCEPT. Bounded to counts + stable digest +
   ≤K sample shas.
10. **Memory argument not credible** — ACCEPT (important). Rewrote §3.2 to a
    streaming two-pointer merge over the two sidecar **byte buffers** (40B fixed
    records, already sorted) — no Ref[]/Set materialization; only the `added` SHA
    list is built. Added a measured peak-heap rig gate at 250k disjoint.
11. **Fold guard doesn't bound commit+fold memory** — ACCEPT. Byte-buffer merge
    keeps heap small; added the combined-peak overlap rig test.
12. **Unfalsifiable gates** — ACCEPT. §7 now has concrete sample sizes, delta-size
    matrix, zero-workspace-slope statement bound, p50/p95/p99, fallback ceilings,
    zero-divergence denominator, deterministic race schedules.
13. **200ms gate omits residual O(N) parse/fetch** — ACCEPT. Added per-phase
    timings + a total server-admission gate at 112k and 250k; clarified ≤200ms is
    the D1-accounting sub-phase, ≤2s is total (residual parse is the wire-delta
    follow-on's target).
14. **Response equivalence too broad** — ACCEPT (reframe). Proved delta's
    accounting input (`newRefs`) is IDENTICAL to full's, so 409/epoch/over-cap are
    byte-identical and needsUpload is set-equal; scoped the claim precisely.
15. **Required deterministic race rig** — ACCEPT. Added as a named acceptance gate.

Revision written as draft v2. Proceeding to round 2.
