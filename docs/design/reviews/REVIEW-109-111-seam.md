# Joint seam review — designs 109 / 110 / 111

2026-07-13 · gpt-5.6-sol, one round · **VERDICT: ALIGNED** (all five seams clean)

Scope: ONLY the cross-design seams recorded in REVIEW-109/-110/-111. Intra-design
decisions were adjudicated in the individual loops and were off-limits here.

## Seam verdicts

1. **Commit-request shape** — CLEAN. 111 keeps redemption OUT of the commit
   envelope (upload-time draining; genesis commit arrives pre-drained with
   `receipts: {}`); 110's phases assume exactly that shape. No contradiction;
   110's budgets don't depend on 111's batch-cap or drain-scheduling changes.
2. **Auth threat model** — CLEAN. 111 keeps receipt redemption
   bearer-authenticated in every specified path, which 109 §4.1's stolen-grant
   bound requires.
3. **`/v1/blobs/check` wire shape** — CLEAN. 109's empty-refresh (`{shas:[]}`
   accepted; client `missingBlobs([])` short-circuits) is the only change; 111
   expressly leaves missing-check untouched; 110 doesn't touch the endpoint.
4. **Measurement interdependence** — CLEAN, with a REQUIRED ORDER (below).
   Token semantics are disjoint: 109 gate-0 decomposes AE `request` vs
   `blob.batchPut`; 110 owns `upstream-of-DO = p − finalDrainMs − srv`; 111
   repairs `redeemOverlap` to intersection-with-union-of-upload-active.
   Caveat kept: 110's `finalDrainMs` (commit-enclosed) and 111's final flush
   wall may coincide in the old post-tail baseline but must stay conceptually
   distinct after pipelining.
5. **Shared vocabulary** — CLEAN. 109 exclusively owns the auth enum
   (`x-rbox-auth-path: grant|bearer`; AE `fast_path|fallback_missing|
   fallback_invalid|fallback_expired`). 110/111's classifications are different
   semantic domains; do NOT unify.

## Required implementation/evaluation order (binding)

1. Evaluate **109 gate 0** from existing AE data (no code).
2. Implement + evaluate **109** (it intentionally moves the `p`/upstream-of-DO
   baseline — anything measured against `p` before this must be remeasured).
3. Land flags-off instrumentation for 110 + 111 (111's overlap repair, 110's
   commit-enclosed final-drain timer).
4. Capture ONE fixed-corpus, 5k/post-tail, flags-off baseline shared by 110
   Phase 0 and 111's control.
5. 110 Phase 0.5 (D1-limits prototype; fix projections + stop-rule thresholds).
6. Enable + evaluate 111 (upload-time draining default + bounded 15k candidate).
7. Implement + evaluate 110's bulk admission (conditional on its Phase 0/0.5
   gates surviving).

111's behavioral rollout does not invalidate 110's admission baseline (commits
still arrive pre-drained). 109 must precede the shared baseline of step 4.

## Addendum — design 112 (added 2026-07-13, from REVIEW-112 seam items)

112 (batch fill / wire-cap raise, reviewed ALIGNED in #254) slots into the
binding order as follows:
- 112's evaluation runs OUTSIDE the step-4 shared-baseline window, and the
  112 rollout state (fill version + records cap) must be recorded in every
  110/111 measurement cell.
- If 109 ever unparks, its gate-0 attribution must be RERUN after 112 changes
  batch cardinality (the 89ms/request pre-handler share moves with request
  count).
- Codex confirmed 112 violates none of: /v1/blobs/check, commit shape,
  fence/receipt semantics, 111's too_many_receipts clamp contract.
