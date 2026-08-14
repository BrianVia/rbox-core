# design 251: Honest git-apply residual accounting

**Status:** implementation-ready  
**Issue:** #573 ranked fix 3  
**Scope:** accounting only; no apply, held-skip, fingerprint, proof, or mutation behavior changes

## 1. Protected contract

`src/cli/sync-git/apply.ts` remains the pull-side materialization owner and
`src/engine/git/chain-timings.ts` is the `GitChainTimings` owner. The patch must
preserve every apply result, blocker, held-attempt decision, before/after
fingerprint bracket, standing-proof retry/repair transition, index projection,
crash boundary, compatibility path, and fast path. Timings remain an exclusive
partition of each repository wall interval; `classifyMs` remains a separately
reported nested parent and is never itself added to the partition.

There is no feature retirement, migration change, command/output removal, or
CODEMAP ownership change in this slice.

## 2. Verified gaps

1. `finalizeGitChainTimings` excludes nested `classifyMs`, correctly avoiding
   its overlap with `ownershipMs` and `reflogMs`, but therefore bills the
   classifier's own oracle and decision work to `residualMs`.
2. `earlyHeldAttemptDecision`, both apply-side `observeHeldInputs` calls, and
   `settleStandingBranchProof` have no `GitChainTimings` leaf. The trace-only
   manual standing-proof stopwatch does not close normal metrics.
3. The apply-side semantic index projection block is untimed while the
   equivalent follow-side projection is billed to `indexOpStateMs`.
4. Fingerprint runs deliberately use `per-decision` memo scope. Widening that
   scope without a proof that each independent before/after bracket observes
   concurrent common-dir mutation would weaken the protected safety contract.

## 3. Smallest coherent change

Extend `GitChainTimings` with three explicit exclusive leaves:

- `classifyExclusiveMs`: wall spent inside `classifyCheckout` after subtracting
  the ownership and reflog child-leaf deltas for that invocation.
- `heldInputMs`: early held decisions and the two apply-side held-input
  observations, each of which owns a complete independent mutation bracket.
- `standingProofMs`: the complete standing-branch settlement call, replacing
  the trace-only manual stopwatch as the single timing owner.

Add a narrow `addClassifyTimedMs` operation beside `addTimedMs`. It snapshots
the classifier's child leaves, records the existing nested parent, and records
only the non-child remainder in `classifyExclusiveMs`. Route all three
`classifyCheckout` calls through it. Add the three new exclusive fields to the
residual sum and metrics output.

Wrap the semantic index projection block as one `indexOpStateMs` operation,
without moving or rewriting its body. Wrap the four named held/proof regions
with `addTimedMs` and their owning leaves. Do not widen fingerprint memo scope.

This adds no policy branch, mode, sidecar, durable record, or state authority.

## 4. Ownership and deletion audit

| Item | Owner | Safe deletion candidate |
|---|---|---|
| Exclusive timing schema/finalization | `engine/git/shared.ts` | None |
| Apply-side timing placement | `sync-git/apply.ts` adapter | Trace-only standing-proof stopwatch, after its diagnostic reads the canonical leaf |
| Follow classifier timing placement | `sync-git/follow.ts` | None |
| Fingerprint memo scope | `sync-git/fingerprint.ts` | None; safety proof absent |

No module is added and no ownership changes, so `docs/CODEMAP.md` remains
accurate.

## 5. Challenged requirements

| Requirement | Complexity cost | Evidence | Decision |
|---|---|---|---|
| Reuse common-dir fingerprint memos across independent held decisions | Shared observation lifetime can hide mutation between safety brackets | `beginFingerprintDecision` clears `per-decision` runs; held checks create independent runs | Reject from this slice unless a differential race proof establishes equivalence |

## 6. Validation

- Unit-level timing closure: exclusive leaves plus residual equal repository
  wall time (within timer/clock tolerance); nested `classifyMs` is excluded.
- Existing many-ref design-174 test continues to require nonzero classification
  and low residual, now pinning `classifyExclusiveMs` and exact partition
  closure.
- Focused `bun test src/engine/git src/cli/sync-git`.
- `bun run typecheck` and `bun run lint:affected`, with no new-line warnings.
- `git diff --check` and staged diff inspection.

Crash, compatibility, and behavior validation are supplied by the existing
focused suites because the wrapped functions and ordering remain byte-for-byte
inside their original call sites. Performance validation is the timing test
itself plus the newly exposed leaves; no fast path is removed.
