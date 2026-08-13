# 241 — Held-skip local-edit convergence

Status: implementation-ready regression repair.

## Problem and root cause

Commit `c7029c3cf` moved held-attempt admission before artifact fetch and
classification. That optimization is valid only when the cheap observation
covers every eligible blocker input. `gitFingerprint` deliberately covers Git
metadata (`.git` identity, HEAD, index, refs, locks, operation state, config,
and worktree registry), not tracked working-tree bytes. The same commit added
`local-edits` to `heldBlockersAllowSkip`, so rewriting an edited tracked file
back to the incoming bytes does not change the early fingerprint. The stale
attempt skips classification, carries pending verbatim, and refreshes the old
apply deferral.

This violates the eligibility contract retained by design 176 §4 amendment
v5: working-tree bytes are never fingerprinted, so `local-edits` stays
excluded. Later designs validly admitted Git-metadata-backed blockers such as
`local-index` and `local-operation`; this repair does not disturb them or
revert #641's early gate for eligible Git-state blockers.

## Protected-functionality ledger

- Preserve the pre-fetch/pre-classification skip for eligible unchanged held
  attempts, including the measured fast path.
- Preserve #641's classifier semantic key across bundle/pack recapture and its
  immediate invalidation for a semantic section change.
- Preserve legacy-attempt late-match upgrade, blocker-plane retention, the
  one-hour forced retry, fail-open observation, state nonce/BASE/partial/reflog
  bindings, and ordered deferral refresh.
- Preserve pending/partial/BASE authority and all design 235 §5 constraints;
  this repair changes no manifest delta, digest, CAS, mass-delete, encryption,
  or trust contract.
- A cleared local edit must converge on the next pull without another push,
  through the real disk-backed `applyPulledManifest` path.

## Ownership and change

`held-skip.ts` already owns blocker eligibility. Remove `local-edits` from its
closed allowlist. Do not add a second predicate in `apply.ts`, widen the Git
fingerprint to workspace content, or consult the full manifest oracle in the
early gate. Those alternatives either duplicate policy or recreate the
expensive classification work that #641 eliminated.

No module ownership changes and no CODEMAP update are required.

## Validation

1. Add a disk-backed test that creates a real pending local-edit attempt,
   persists it through the normal state transition, restores the tracked file
   bytes without touching Git metadata, calls `applyPulledManifest`, and first
   demonstrates the current non-convergence.
2. After the predicate repair, assert HEAD follows incoming and pending,
   partial, attempt, and apply deferral are absent.
3. Retain a disk-backed eligible held attempt test proving the second pull
   performs no blob fetch and reports `earlySkip=1`.
4. Retain semantic recapture/change tests, run the requested sync-git and
   daemon suites plus typecheck, and run affected lint.

Crash/compatibility/performance gates: the change introduces no effect or
durable format. Existing crash/state-CAS tests remain differential coverage;
legacy attempts retain their upgrade path; eligible unchanged attempts retain
the pre-fetch performance contract.

## Requirement challenge and deletion ledger

| Requirement | Cost | Evidence | Decision |
| --- | --- | --- | --- |
| Skip unchanged `local-edits` attempts | Requires a new complete working-tree witness or full oracle proof before admission, defeating the cheap Git-only key | Design 176 v5 explicitly excludes it; #641's Git-only fingerprint cannot observe byte restoration | Reject for this repair; full re-follow is required |

No feature, compatibility path, fast path, migration, command, or module is
approved for deletion. Only the unsupported `local-edits` eligibility arm and
its contradictory test expectation are safe deletion candidates.
