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

### `follow.ts` (1800 nb → facade + 6 modules, ~1078 nb irreducible)

| module | contents (source lines) | nonblank | KiB |
|---|---|---:|---:|
| `follow-types.ts` | `FollowCrashPoint`, `FollowCrashInjectedError`, `FollowIntended`, `FollowProgress`, `FollowResult`, `FollowOptions`, `StagedIncoming`, `LiveMetadata`, `BreadcrumbMismatch`, `CheckoutClassification`, `opStateRootOf`, `blockerForReason`, `progressWithBlocker`, `deferResult`, `boundedRefFailure`, `WorktreeOwnershipUnreadableError` (92–311) | 202 | 8.5 |
| `follow-journal.ts` | `checkoutJournalBinding`, `recoverFollowJournal`, `recoverAndLandFollowJournal`, `quarantineUnboundFollowJournal`, `clearFollowJournal` (313–386) | 69 | 3.3 |
| `follow-staging.ts` | `indexArtifact`, `normalizedIndexProjection`, `stageIncoming`, `candidateIndexCollision`, `deriveBaseIndexProjection`, `expectedHead` (224–240, 388–456, 1233–1256) | ~113 | ~5.2 |
| `follow-live.ts` | `readLive` (458–491) | 34 | 1.8 |
| `follow-classify.ts` | `firstReason`, `classifyCheckoutOwnership`, `classifyCheckout` (493–675) | 174 | 8.3 |
| `follow-ref-witness.ts` | `ensureStashReflog`, `effectiveRefs`, `selectCheckoutSelfRootWitness`, `appliedTerminalOid` (677–743) | 63 | 2.8 |
| **stays over the gate** | `publishRefPlane` (745–1231) | **480** | **24.7** |
| **stays over the gate** | `followDivergedRepo` (1258–1865) | **598** | **32.0** |

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

## Outcome if the pure-move map is applied as-is

| file | before | after | allowlist entry |
|---|---:|---:|---|
| `follow.ts` | 1800 nb | ~1078 nb (2 functions) | **stays** |
| `apply.ts` | 1470 nb | ~1217 nb (1 function) | **stays** |
| `plan.ts` | 1447 nb | ~1245 nb (1 function) | **stays** |

Three of three entries survive. The gate's `no allowlist entry outlives the file
it excuses` test still passes (each file is still over), so the PR would be
green — but it delivers none of the stated merge gate, and it churns the most
safety-critical file in the product for a 40% reduction on one file and ~15% on
the other two.

## The two honest paths

**A. Accept the giants and stop.** Land only the `follow.ts` pure-move split
(the only one with a worthwhile ratio: 1800 → 1078), keep all three allowlist
entries, and write down that the four giant functions are the real debt. Zero
behavior risk; provable by multiset diff and byte-identical bodies.

**B. Authorize a real refactor, one function at a time.** Splitting
`applyGitSections` / `planGitSections` / `followDivergedRepo` / `publishRefPlane`
means introducing per-function context objects, boxing the reassigned `let state`
in `applyGitSections`, and threading ~50 accumulators through stage boundaries in
`planGitSections`. That is a design-doc-and-adversarial-review cycle per
function, validated on the rig, not a move-fidelity audit. It should not ride in
a PR titled "pure moves behind facades", and it should not be attempted for all
four at once.

Recommendation: **B, scoped to one function per cycle**, starting with
`publishRefPlane` (480 nb, the smallest and the most self-contained — it takes
`FollowOptions` + `LiveMetadata` + roots + ownership context and returns a
value; it captures nothing mutable from an enclosing scope). `applyGitSections`
and `planGitSections` are each a multi-cycle project.

The concurrent `src/cli/daemon/daemon.ts` lane (3215 nb) will hit the same wall
if that file is also one-function-dominated — worth checking before that lane
spends the effort.

## Bugs / smells spotted while reading (unfixed, per the zero-behavior-change rule)

- `follow.ts:1102` — `tipOwnedByIncoming(..., [newOid], ...)` is reached only
  when `newOid` is truthy per the guard's short-circuit, but the array literal
  is typed `(string | undefined)[]` at that position; the guard's correctness
  rests on `!newOid ||` ordering rather than on the type. Same shape at
  `follow.ts:1439`.
- `follow.ts:928` — the content-equivalence cache is loaded inside
  `publishRefPlane` on every call including the `classifyOnly = true` final
  pass (`follow.ts:1825`), and `save()` is called on both. The classify-only
  pass can therefore write cache state for a run that published nothing.
- `apply.ts:1004` / `apply.ts:1121` — `clearAttempt(rel)` is called
  unconditionally before `recordAttempt` can reinstall; if `recordAttempt`
  never runs (early return on artifact/capability/boundary exit) the prior
  attempt is lost rather than preserved. The comment at 1118–1120 says this is
  deliberate, but it means a boundary flake costs a full re-follow next cycle.
