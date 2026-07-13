# REVIEW-110 — commit-tail latency: codex adversarial review ledger

Reviewer loop: fable-5 (judge) + `codex exec` (gpt-5.6-sol, adversarial).
Doc under review: `docs/design/110-commit-tail-latency.md` (initial draft at
839b776d).

## Round 1 — 2026-07-12

Verdict: **CHANGES-REQUIRED** (2 BLOCKER, 9 MAJOR, 4 MINOR, 1 NIT).

| # | Sev | Finding (compressed) | Judgment |
|---|---|---|---|
| 1 | BLOCKER | Option E's round-trip model wrong: validator groups 34 IN-selects per `db.batch()` (one subrequest each) → 17/39/82 subrequests at 49k/118k/250k, not "hundreds of round trips"; bulk at 2k chunks can *increase* round trips; the only plausible win is per-statement execution cost | **ADOPT** — verified in `commit-accounting.ts:35-37,90-93`. Rewrote Option E + new "Round-trip reality" section; recommendation now conditional on a Phase 0.5 prototype win |
| 2 | BLOCKER | Shadow "zero harmful divergence" gate undefined under TOCTOU: two separate chunked reads, no shared snapshot; GC/redemption between reads produces noise (design 102 already concedes this at `workspace-sync.ts:588-590`) | **ADOPT** — added fixed ordering (bulk read → authoritative read → single accounting), bounded re-probe of divergent SHAs classifying `concurrent_noise` vs real `divergence`, GC-quiesced rig requiring strict zero, soak gate = zero non-noise |
| 3 | MAJOR | `commitWallMs` cross-check invalid: it wraps ALL of `api.commit` (refresh/sidecar/encode/encrypt/upload/post) minus redemption, so 46.1 vs 41.7 doesn't constrain `p`'s composition | **ADOPT** — verified `sync.ts:1016-1022` wraps `api.commit`; claim removed, replaced with explicit "constrains only weakly" statement |
| 4 | MAJOR | Single field sample overclaimed ("consistent with the commit POST being the pole", "expected dominant genesis server work") | **ADOPT** — softened; diagnosis now lists drain/Worker/acct as co-equal candidates until the suffix is recovered |
| 5 | MAJOR | Doc misses that genesis receipts are fully drained before the POST (`receipts:{}`), so `newRefs` ≈ empty and `commitAccounting` is a no-op; genesis `acct` = have-set SELECTs only; shifts plausibility toward redemption (design 111) | **ADOPT** — verified `commits.ts:227-235`, `commit-accounting.ts:128`. New "Genesis receipts are already drained" section; correctness matrix case 2 updated |
| 6 | MAJOR | `p - srv` contains Worker-side pre-DO work (authorizeWorkspace D1, MAX(account_epoch) D1, DO dispatch) — not just "client/upstream" | **ADOPT** — verified `routes/sync.ts:23-45`. `p` decomposition and Phase 0 `upstream-of-DO` derivation updated; design 109 owns the split |
| 7 | MAJOR | Phase-0 receipt formula wrong: `receiptRedemptionWallMs` aggregates ALL drains incl. overlapped ones outside `p`; must instrument the exact final drain inside `commitSigned` | **ADOPT** — Phase 0 now requires a new numbers-only final-drain field; formula uses `finalDrainMs` |
| 8 | MAJOR | Shadow contract underspecified: validators return `{newRefs}`/`{needsUpload}` but rollout compares `have/new/missing`; receipt double-verification unaddressed | **ADOPT** — normative pure-classification structure `{have,new,missing}` added; verifyReceipt results shared within a request |
| 9 | MAJOR | Fail-closed fallback unbudgeted at 250k refs (bulk attempts + 82 validator subrequests + up to 84 accounting super-batches in one request); gc-phase1 precedent shows the subrequest budget bites | **ADOPT** — matrix case 9 (injected last-chunk failure at max refs) + combined-path headroom gate added |
| 10 | MAJOR | JSON chunk bounds are placeholders; D1 single-large-param limits, json_each cost, Worker heap at 250k unestablished; ≤100-param rule proves nothing about one 330KB JSON param | **ADOPT** — new Phase 0.5 limits/prototype benchmark gates implementability; caps derived from it |
| 11 | MAJOR | 5x `acct` / 2x commit-wall gates ungrounded (only 17/39 subrequests today; commit wall contains untouchable work); 3 publishes ≠ a distribution | **ADOPT** — gates now finalized from Phase 0 measured share + Phase 0.5 projection; fixed 5x/2x removed; 3-publish gate relabeled screening |
| 12 | MINOR | Flag matrix not implementable as written: with delta `off`, `computeCommitDelta` never runs and no `first_commit` fallback string exists; genesis test must be `parent === 0` ahead of the branch; "same `fullChildShas()` set" wrong for delta-off | **ADOPT** — §2 rewritten around `parent === 0` + genesis helper refactor; "byte-for-byte" softened to behaviorally unchanged |
| 13 | MINOR | Doc conflates the validator's candidate/intent barriers with the `rbox_delete_fence` abort (which lives in `commitAccounting`'s batch) | **ADOPT** — prose split correctly |
| 14 | MINOR | Requirement 5 overstates account-deletion protection: the `account_deletions` probe in `computeCommitDelta` sits AFTER the `first_commit` early return, and genesis accounting is a no-op — unchanged `commitAccounting` guarantees nothing here | **ADOPT** — verified `workspace-sync.ts:286-289` and confirmed no Worker-side commit-path probe exists; requirement 5 now claims behavior *parity* with the current genesis path, tested in matrix case 5 |
| 15 | MINOR | "Roll back instantly" too strong: per-request mode capture means in-flight requests finish under their captured mode | **ADOPT** — kill-switch wording fixed |
| 16 | NIT | Citation/editorial: (a) requirement 2 duplicated verbatim; (b) `formatCommitTimings` is at sync.ts:147-148 not 142-147; (c) commits.ts cite should be 220-236; (d) "byte-for-byte" wording; (e) doc dated 07-12 but observation 07-13 | **PARTIAL** — (a) **REJECT**: requirement 2 appears exactly once in the draft; codex misread. (b) **REJECT**: `formatCommitTimings` is defined at sync.ts:142-143 (verified); cite tightened to 142-143 anyway. (c,d) adopt. (e) adopt as annotation: the field line is timestamped in UTC (2026-07-13 UTC = 2026-07-12 local); dates annotated, data unchanged |

Revision committed after this round rewrites the doc per the adopted findings.

## Round 2 — 2026-07-12

Verdict: **CHANGES-REQUIRED** (2 BLOCKER, 5 MAJOR, 6 MINOR, 2 NIT). Codex
confirmed the round-1 finding-16 rejections were sound (its finding 14) and
round-1 finding 14 resolved (its finding 15).

| # | Sev | Finding (compressed) | Judgment |
|---|---|---|---|
| 1 | BLOCKER | Round-1 #2 unresolved: re-probe rule "R != B → noise" is inverted — it excuses a stably-wrong bulk query (B wrong, A==R correct → labeled noise); `A == R != B` must be gate-blocking | **ADOPT** — protocol rewritten: `A == R != B` → `divergence` (blocking); `R != A` → `state_moved` (blocking by default) |
| 2 | BLOCKER | Round-1 #2 unresolved: re-probe unbounded/undefined at high cardinality; a systematic defect diverging on 250k refs must not be sampled into an excuse | **ADOPT** — cap = one validator batch (3,060); above the cap nothing is re-probed and all counts as `divergence` |
| 3 | MAJOR | Change-and-change-back histories are unattributable by any read sequence; noise excusal needs external mutation evidence | **ADOPT** — automatic excusal removed entirely; `state_moved` excusable only in soak review with corroborating GC-tick/redemption-log evidence, recorded in the gate record |
| 4 | MAJOR | Phase 0.5 circular: prototype projects its own gate; "material win"/"plausibly meet" undefined | **ADOPT** — fixed independent stop rule (projected reduction ≥50% of measured `acct` AND ≥3s absolute at 49k, set before the prototype runs); implementation gate = ≥80% of the projection |
| 5 | MAJOR | Screening expression ambiguous (which statistic, tie policy, p50 attachment) | **ADOPT** — all clauses defined as median-of-three; explicit both-pass policy (lanes proceed independently) and env-first precedence |
| 6 | MAJOR | Combined-path gate unverifiable: 85 not 84 accounting subrequests (plan lookup), limits unnamed, no measurement method, case 9 needs the all-receipt-backed variant | **ADOPT** — case 9 fixed (all-receipt-backed, 82+85+bulk arithmetic, op.span counters); limits named (~1,000 subrequests, 128MB isolate, CPU budget); Phase 0.5 must name methods or fall back to analytical 50%-of-limit bounds |
| 7 | MAJOR | `first_commit` telemetry emission lost by routing genesis ahead of `computeCommitDelta`; must be normative + tested or design-102 dashboards silently change | **ADOPT** — synthetic emission normative in §2; matrix case 7 asserts count/tags |
| 8 | MINOR | Doc should state genesis bulk shadow = exactly two classification passes and prohibit design-102 `readShadowFlags` at genesis | **ADOPT** — stated in §2 |
| 9 | MINOR | Receipt-result sharing underspecified (cache keying, nowMs, union population, order-independence, deterministic output order) | **ADOPT** — cache keyed `(sha, receipt)` with request `nowMs`, lazy union population, classifiers consult only the cache; input-order contract for `new`/`missing` |
| 10 | MINOR | Cardinality check insufficient: bulk relation must reject duplicate inputs and yield exactly one row per input under table multiplicity (no silent first/last-write-wins) | **ADOPT** — two-level guard in §1 |
| 11 | MINOR | JSON caps need a margin below the measured failure boundary + boundary±1 tests | **ADOPT** — caps ≤50% of failure boundary, boundary±1 tested |
| 12 | MINOR | Matrix case 2 "drain skipped/failed" wrong: a failed drain never POSTs; all-receipt-backed is a fixture variant | **ADOPT** — reworded; cross-linked to case 9 |
| 13 | MINOR | `max(0, …)` residual formulas hide clock skew; record signed residuals | **ADOPT** — signed values recorded, clamp for display only |
| 14 | NIT | Round-1 #16 rejections confirmed sound | no action |
| 15 | NIT | Round-1 #14 confirmed resolved | no action |

## Round 3 — 2026-07-12

Verdict: **CHANGES-REQUIRED** (1 BLOCKER, 4 MAJOR, 2 MINOR). Codex's audit
confirmed round-2 findings 2, 3, 5-13 resolved; 1 and 4 partially (closed this
round).

| # | Sev | Finding (compressed) | Judgment |
|---|---|---|---|
| 1 | BLOCKER | Re-probe not normatively ordered before accounting — a post-accounting `R` reads this request's own grants/marker-clears as `state_moved` | **ADOPT** — normative total sequence added to §3: B → A → compare → R → classify/emit → materialize A's result → single accounting |
| 2 | MAJOR | Authoritative-422 path drops divergence telemetry: current `runFullAdmission` returns 422 immediately (`workspace-sync.ts:520-526`); B=have/A=missing would never be compared | **ADOPT** — comparison + re-probe required before materializing every A-derived result incl. 422; shadow always answers from A on every path |
| 3 | MAJOR | 80%-of-projection gate undefined across workloads/units | **ADOPT** — Phase 0.5 records baseline + projected reduction per gated workload in absolute ms; the 80% comparison is absolute-ms, per workload |
| 4 | MAJOR | Rollout step 6 "sample-count gate" undefined → shadow→enforce not decidable | **ADOPT** — defined: ≥10 prod-shadow genesis commits, ≥3 at ≥10k refs (manufactured if organic traffic is too rare), zero divergence/unexcused state_moved |
| 5 | MAJOR | 111 seam lacks an implementation-order gate in the doc itself | **ADOPT** — "Ordering dependency on design 111" section: Phase 0.5+ valid only under the pre-drained `receipts:{}` shape; a 111 request-shape change forces Phase 0/0.5 + gate rerun before shadow. 109 explicitly non-blocking (baseline remeasured) |
| 6 | MINOR | "Exactly two classification passes" conflicts with the diagnostic re-probe | **ADOPT** — "two full-set classification passes (plus the bounded diagnostic re-probe)" |
| 7 | MINOR | `admit_stmts` emits `op.span.dbCalls` (calls), not statements, despite the design-102 name | **ADOPT** — verified `workspace-sync.ts:524,531`; Phase 0 notes the misnomer and adds a true statement counter or records it as calls |

## Round 4 — 2026-07-12 (cap round)

Verdict: **CHANGES-REQUIRED**, but reduced to two prescribed wording/fixture
fixes. Round-3 items 2-7 confirmed RESOLVED.

| # | Sev | Finding | Judgment |
|---|---|---|---|
| 1 | BLOCKER (residual of r3 #1) | §3 sequence wrote "materialize A's result (200/422/402)" before accounting, but 200/402 are decided BY accounting — as written it would violate admission-before-success | **ADOPT** — sequence corrected: compare/re-probe → A's 422 if missing → single accounting from A → 402/fence/200 exactly as today |
| 2 | MAJOR | Matrix case 5 fixture contradicted §3: a mark between B and A yields `A == R != B` → `divergence`, not `state_moved`; `state_moved` needs the mark between A and R | **ADOPT** — case 5 split into both fixtures with their expected classes |

## Round 5 — 2026-07-12 (confirmation round for the round-4 prescribed fixes)

<!-- filled after the confirmation run -->

## Seam items (for the joint round with 109/111)

- **111 (redemption tail):** Round-1 finding 5 establishes that at genesis the
  commit request arrives with `receipts: {}` and all per-ref accounting cost
  was paid in the redemption lane — partly inside `p` as the final drain. If
  111 folds receipt redemption into the commit request, design 110's premise
  changes materially: commit-time `receipts` would be non-empty at genesis,
  `newRefs` would be the full refset, `commitAccounting` would run its full
  super-batch sequence inside `acct`, and 110's bulk validator would need to
  cover the receipt-verification loop (currently sequential per-SHA
  `verifyReceipt`) and the combined-path subrequest budget would include up to
  84 accounting super-batches. 110's Phase 0 gate math (acct share of `p`) and
  matrix case 2 both assume the pre-drained state; the joint round must pick
  ONE commit-request shape before either design implements.
- **109 (auth-call storm):** `p - finalDrain - srv` includes Worker-side
  `authorizeWorkspace` + `MAX(account_epoch)` D1 lookups before the DO
  dispatch (`routes/sync.ts:23-45`). 110's Phase 0 only sizes this
  (`upstream-of-DO`); attribution and fixes belong to 109. If 109 changes the
  per-request auth shape, the `upstream-of-DO` baseline moves.
