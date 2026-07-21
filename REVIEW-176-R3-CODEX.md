# REVIEW-176-R3-CODEX — focused ledger-closing review of design 176 v3

Scope was limited to the seven r2 findings and their tagged folds, including
whether each fold remains consistent with its surrounding contract.

## R2 finding closure ledger

1. **NOT-CLOSED** — §2 now correctly exempts `RESOLUTION-INTENT`, and test 2 exempts it via “OTHER,” but test 1 still requires confirmation to write the intent “without changing P or sidecars,” which includes the sidecar it must write.
2. **CLOSED** — §2.1 explicitly retains the full show-me binding set and adds `stream`, `stateNonce`, `repoGen`, and the disambiguated `gitIncomingKey(P)`.
3. **CLOSED** — §2.2 now gives the required closed lane list, branch-only ancestry rule, exact comparisons, tombstone exclusion rationale, ternary result, and fail-closed indeterminate handling.
4. **NOT-CLOSED** — §2 Eligibility correctly chooses the real-P-only option and specifies the typed `no-incoming` refusal, but §5 never adds the required apply-deferral-only/no-P lifecycle test.
5. **NOT-CLOSED** — §2 Non-goals and test 2 correctly carve out durable pre-commit internal pins, but §2 Semantics still says all “local refs” remain untouched until accepted ACK and test 1 says resolving-host “refs” remain unchanged, contradicting those pre-ACK pin writes.
6. **NOT-CLOSED** — §4 remains unchanged: it neither predicates neutralization on `composedFollow.holds` plus `checkoutComplete` nor requires unmatched holds to persist as typed blockers; test 6 also asserts only controls, not their stored blocker shape.
7. **CLOSED** — §3 adds daemon-control’s deferral-collapse snapshot and git-entanglement to the explicit inventory, and §5.5 pins every enumerated consumer in the grammar-freeze matrix.

## New defects

None beyond the incomplete or internally contradictory r2 folds recorded above.

Verdict: CHANGES-REQUIRED
REVIEW-COMPLETE
