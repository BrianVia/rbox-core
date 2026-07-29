# sync-git decomposition map — follow.ts / apply.ts / plan.ts

Measured on `refactor/sync-git-decompose` (branched from `origin/2.0` at
`672d6cad`, the commit that landed the module-size gate).

The task was: decompose the three sync-git giants into domain modules by **pure
move** behind facades, and delete their three entries from
`src/cli/state-plane/file-size.test.ts`.

**The second half is not reachable by pure moves.** This note records the map,
the measurements that prove it, and the two paths forward.

## The gate

`src/cli/state-plane/file-size.test.ts` fails a production `src/**/*.ts` module
at **>400 nonblank lines OR >25 KiB**, whichever binds first. A new module
carrying an oversized function fails the same gate the source file fails, so a
move that relocates the bulk does not retire the allowlist entry — it just moves
which filename is listed.

## Measurement: where the bulk actually lives

| file | total nonblank | single largest function | share |
|---|---:|---|---:|
| `follow.ts` | 1800 | `followDivergedRepo` 598 nb / 32.0 KiB | 33% |
| | | `publishRefPlane` 480 nb / 24.7 KiB | 27% |
| `apply.ts` | 1470 | `applyGitSections` 1217 nb / 63.1 KiB | 83% |
| `plan.ts` | 1447 | `planGitSections` 1245 nb / 59.2 KiB | 86% |

Each of those four functions is, on its own, over both bands of the gate. There
is no arrangement of whole-function moves that puts them into a passing module.

`apply.ts` and `plan.ts` are effectively *one function each*. `applyGitSections`
contains an inner `processRepo` closure of **897 nonblank lines** that captures
~50 outer locals (including the reassigned `let state`); `planGitSections` is a
sequential accumulator pipeline whose `plan()` closure (312–396) reads nearly
every one of ~50 accumulators. Extracting either requires a context object and
mutable-binding boxing — a real refactor with observable-behavior risk, not a
move.

## Domain map — what a pure move CAN extract

### `follow.ts` (1800 nb → facade + 6 modules) — **SHIPPED**

Measured after the split, not estimated:

| module | contents (original source lines) | nonblank | KiB |
|---|---|---:|---:|
| `follow-types.ts` | `FollowCrashPoint`, `FollowCrashInjectedError`, `FollowIntended`, `FollowProgress`, `FollowResult`, `FollowOptions`, `StagedIncoming`, `StageIncomingOptions`, `LiveMetadata`, `BreadcrumbMismatch`, `CheckoutClassification`, `opStateRootOf`, `blockerForReason`, `progressWithBlocker`, `deferResult`, `boundedRefFailure`, `WorktreeOwnershipUnreadableError` (95–222, 242–311) | 208 | 8.4 |
| `follow-journal.ts` | `checkoutJournalBinding`, `recoverFollowJournal`, `recoverAndLandFollowJournal`, `quarantineUnboundFollowJournal`, `clearFollowJournal` (313–386) | 80 | 4.1 |
| `follow-staging.ts` | `receiverEquivalenceByWorkspace`, `candidateIndexCollision`, `indexArtifact`, `normalizedIndexProjection`, `stageIncoming`, `deriveBaseIndexProjection`, `expectedHead` (93, 224–240, 388–456, 1233–1256) | 133 | 6.0 |
| `follow-live.ts` | `readLive` (458–491) | 43 | 2.4 |
| `follow-classify.ts` | `firstReason`, `CheckoutOwnershipClassification`, `classifyCheckoutOwnership`, `classifyCheckout` (493–675) | 208 | 9.7 |
| `follow-ref-witness.ts` | `ensureStashReflog`, `effectiveRefs`, `CheckoutSelfRootWitness`, `selectCheckoutSelfRootWitness`, `appliedTerminalOid` (677–743) | 72 | 3.4 |
| `follow.ts` (facade) | `refEquivalenceWarnings`, `publishRefPlane` (745–1231), `followDivergedRepo` (1258–1865), re-exports | **1183** | **60.5** |

The facade keeps its allowlist entry, with the reason rewritten to name the two
residual functions rather than the retired 1800-line figure.

Module-level state stayed module-level: `refEquivalenceWarnings` (facade) and
`receiverEquivalenceByWorkspace` (`follow-staging.ts`) are each still a single
ESM module singleton evaluated once per process, so no memo is re-created and no
probe re-runs.

`partitionOwnedByIncoming` (the #570 95s→1s macOS batching fix) is called from
exactly two sites, both of which land in `follow-classify.ts`:
`classifyCheckoutOwnership`'s injected `prove` default (521–522) and
`classifyCheckout`'s batched `(tips) => partitionOwnedByIncoming(...)` argument
(635–636). The batching seam is the *single call with all tips at once* — it
moves as one unit inside one module and no call site changes.

### `apply.ts` (1470 nb → facade + 2 modules, 1217 nb irreducible)

| module | contents | nonblank |
|---|---|---:|
| `apply-metrics.ts` | `GitApplyRunKind`, `GitApplyRepoResult`, `GitApplyRepoTiming`, `GitApplyMetrics`, `emptyGitApplyResults`, `GIT_APPLY_RESULT_ABBR`, `gitApplyDistribution`, `formatGitApplyDistribution`, `gitApplyRepoExemplars`, `finishGitApplyMetrics`, `formatGitApplyMetrics`, `hasGitChainTiming`, `chainMetric` (96–260) | ~140 |
| `apply-identity.ts` | `KeySnapshot`, `snapshotKey`, `restoreKey`, `withoutRboxAuthoredRefs`, `checkoutMatchesIncoming`, `GitPullOutcome` (33–94) | ~55 |
| **stays over the gate** | `applyGitSections` (278–1519) | **1217** |

### `plan.ts` (1447 nb → facade + 2 modules, 1245 nb irreducible)

| module | contents | nonblank |
|---|---|---:|
| `plan-types.ts` | `GitPushPlan`, `GitPlanStats`, `GitPlanOptions` (32–153) | ~110 |
| `plan-format.ts` | `formatGitPushLine`, `formatGitPlanStats`, `gitBaseAfterCommit`, `gitForceForMissingBlobs` (1437–end) | ~45 |
| **stays over the gate** | `planGitSections` (154–1431) | **1245** |

## Outcome

| file | before | after | allowlist entry |
|---|---:|---:|---|
| `follow.ts` | 1800 nb | **1183 nb** (2 functions + 6 modules) | **stays** — reason rewritten |
| `apply.ts` | 1470 nb | untouched | stays |
| `plan.ts` | 1447 nb | untouched | stays |

`apply.ts` and `plan.ts` were deliberately left alone: a pure move buys them
~15% each (253 nb and 202 nb of extractable prelude) at the cost of churning two
more safety-critical files, and it retires neither entry. They wait for the real
refactor.

## The queued refactors — measurements so the next lane doesn't re-derive them

These are design-doc + adversarial-review + rig-validation projects, queued
behind U3. Do NOT attempt them as move-fidelity refactors, and do not attempt
more than one per cycle.

**1. `publishRefPlane` — start here.** 480 nb / 24.7 KiB, `follow.ts:745–1231`.
The smallest and most self-contained: a top-level function taking
`(opts: FollowOptions, live: LiveMetadata, roots, ownershipContext, classifyOnly)`
and returning a value. It captures nothing mutable from an enclosing scope — its
only module-level reference is the `refEquivalenceWarnings` warn-once set. Its
natural seams are the deletion-witness block, the hold classifier, the
recompute-until-stable no-drop loop, and the per-ref publication loop.

**2. `followDivergedRepo`.** 598 nb / 32.0 KiB, `follow.ts:1258–1865`. Harder
than its size suggests: `boundaryFailure`, `checkoutBranchPlan`,
`checkoutBranchLockedProof`, and `checkoutBranchReflogFingerprint` are `let`
bindings written from inside the `secondProof` / `postHeadSecondProof` closures
that `commitCheckout` invokes. Any split must keep those closures and their
writes in one scope or box them explicitly.

**3. `applyGitSections`.** 1217 nb / 63.1 KiB, `apply.ts:278–1519`. Multi-cycle.
- Inner `processRepo` closure: **897 nonblank lines**, `apply.ts:509–1424`.
- Inner `runRepo` closure: 64 nb, `apply.ts:1437–1500`.
- `processRepo` captures roughly **50 outer locals** — the accumulators
  (`applied`, `removedMem`, `needsRes`, `pending`, `records`, `configLane`,
  `deferrals`, `partial`, `attempt`, `idxProj`, `repoProofs`,
  `branchBaseOrigins`, `publishedJournals`), the closures (`setDeferral`,
  `clearDeferral`, `clearAttempt`, `currentDeferral`, `currentPartial`,
  `checkoutOf`, `runMutation`, `configExecutorFor`, `installRecoveredRecord`,
  `commonDirGroupFor`, `laneLedger`), and the arguments.
- **`state` is reassigned inside `processRepo`** (`apply.ts:555` after journal
  recovery, `apply.ts:1052` after standing-proof settlement). Any extraction
  must box it; passing it by value silently strips both updates.

**4. `planGitSections`.** 1245 nb / 59.2 KiB, `plan.ts:154–1431`. Multi-cycle.
A sequential accumulator pipeline (journal pre-loop → admission → capture pool →
absence capture → resolution/supersession → hygiene → cache refresh) whose
`plan()` closure at `plan.ts:312–396` reads nearly all ~50 accumulators to build
the returned `GitPushPlan`. Stage boundaries are real, but every stage writes
into the same accumulator set, so the split needs one explicit carrier object
rather than per-stage parameter lists.

### daemon.ts, for the concurrent lane

`src/cli/daemon/daemon.ts` (3215 nb) is **one 2827-nonblank class,
`RboxDaemon`, at `daemon.ts:323`**; its largest top-level function is 41 nb.
Same wall, different shape — a class splits into collaborators more naturally
than a closure does, but it is still not a pure move.

## Bugs spotted while reading — ALL PRE-EXISTING AND UNFIXED

None of these were introduced by the split, and none were fixed by it (the split
is a pure move; fixing anything would have broken the byte-identity audit). Line
numbers are against the pre-split `follow.ts` / current `apply.ts`.

**FOLLOW-UP ISSUE WORTH FILING — classify-only cache write.**
`follow.ts:928` (now `follow.ts` facade, inside `publishRefPlane`): the
content-equivalence cache is loaded on *every* call to `publishRefPlane`,
including the `classifyOnly = true` final observation pass invoked at
`follow.ts:1825`, and `contentEquivalenceCache?.save()` runs on both arms. A
pass whose entire purpose is observation — it publishes nothing and its result
only feeds `afterHeldClassification` — can therefore mutate durable cache state.
This is the one that looks like a genuine defect rather than a smell.

Lesser smells:

- `follow.ts:1102`, `follow.ts:1439` — `tipOwnedByIncoming(..., [newOid], ...)`
  is only reached when `newOid` is truthy because of the `!newOid ||`
  short-circuit ordering, but the array literal is typed
  `(string | undefined)[]` at that position. Correctness rests on statement
  order, not on the type.
- `apply.ts:1004` / `apply.ts:1121` — `clearAttempt(rel)` runs unconditionally
  before `recordAttempt` can reinstall. If `recordAttempt` never runs (early
  return on an artifact/capability/boundary exit) the prior held attempt is
  lost rather than preserved. The comment at `apply.ts:1118–1120` says this is
  deliberate, but it means a boundary flake costs a full re-follow next cycle.
