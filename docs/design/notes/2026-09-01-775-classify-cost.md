# #775 remainder — the held classify + cleanup cost

*Design note, 2026-09-01. Evidence read on main @ `d8d2658e9`. No code changed.*

## The problem

Held-skip works: on steady pulls FM shows `fetchDecryptMs=0`, short-circuiting
before any bundle work. What is left is the *other* pull — after a pending section
genuinely changes. FM 2026-09-01 measured one at 22.8s: fetch 0.6s / classify 6.8s
/ follow 3.4s / cleanup 6.9s — 60% of the wall clock, none of it attributed today.

## Where classify spends 6.8s — hypothesis

The classifier runs **twice per follow** — `src/cli/sync-git/follow.ts:168` and
`:245`, both under `addClassifyTimedMs` — and each run opens with a full
working-tree proof at `src/cli/sync-git/follow-classify.ts:134`
(`args.boundary ? oracle.reproveRepo(...) : oracle.proveRepo(...)`). Both pass
`boundary: false`, so both take `proveRepo`, which goes straight to `proveFresh`
every call (`src/engine/apply-receipt.ts:308-310`, `:451`) — never `reproveRepo`'s
cheap stored-token re-check (`:313-328`). The only de-duplication is `serial`
(`:338-344`), an in-flight map cleared on settle: it merges *concurrent* callers,
not sequential ones. These two are sequential, separated by the checkout, so each
pays a full scan-and-compare of the working tree. **Hypothesis: classify ≈ 2 ×
repo working-tree scan.** `ownershipMs`/`reflogMs` (`follow-classify.ts:189`,
`:191-192`) are already subtracted into `classifyExclusiveMs`, so the oracle cost
sits there unlabelled.

## Where cleanup spends 6.9s — hypothesis

Two serial per-ref `git` spawn loops sit on the follow path. `cleanupRefs`
(`src/cli/sync-git/follow-staging.ts:69-71`) spawns one `git update-ref -d` **per
ref**, awaited one at a time; it runs at `follow.ts:73` and again via `cleanup`
(`follow-staging.ts:72-75`) at `follow.ts:282`. `pruneStaleScratchRefs`
(`src/cli/sync-git/pins.ts:85-99`) does `for-each-ref`, then one `ownedUpdateRef
-d` **per stale ref**, serially — at `follow-staging.ts:98`, on every stage. So a
section change with a wide ref set becomes N sequential subprocess spawns.
**Hypothesis: cleanup ≈ N × spawn latency, not N × real work**, and `git
update-ref --stdin` collapses both loops to one spawn each.

## The smallest instrumentation that would confirm it

Two new leaves in `GitChainTimings`, both surfacing through the existing stats
formatter with no new plumbing. **`oracleMs`** — one `addTimedMs` around
`follow-classify.ts:134`, added to `LEAF_FIELDS` (`chain-timings.ts:57-60`) **and**
to the explicit child subtraction in `addClassifyTimedMs` (`chain-timings.ts:82-88`
names `ownershipMs`/`reflogMs` one by one, picking up no new leaf on its own).
**`refCleanupMs`** — one `addTimedMs` around the `cleanupRefs` loop and around
`pruneStaleScratchRefs`, emitting the ref *count*; time ÷ count is the
spawn-latency test that decides `--stdin`.

## The safety property at risk

The second classify at `follow.ts:245` is **load-bearing and must not be memoized
away**: the checkout between the two runs changes the working tree, so the
post-checkout proof has to be fresh. "Cache the oracle across both calls" is wrong
by construction — the lever is a cheaper single scan, not a vanished second one.
Proved in the follow rig: two `oracleMs` samples per follow, and a tree edited
during the checkout still caught by the post-checkout verdict.

## Acceptance measurement

Same pull shape as FM's 22.8s one: `oracleMs` + `refCleanupMs` should account for
≥80% of today's classify+cleanup 13.7s. Any fix is judged on that pull's wall clock.

## Not worth it if…

…this pull shape is rare. Held-skip covers steady state, so this is the cost of a
*change* — exactly when a user waits. But if section changes are hours apart in
practice, 22.8s is not worth two new leaves; measure frequency first.

## Appendix — the local-edits working-tree witness (#814)

`heldBlockersAllowSkip` (`held-blockers.ts:91-99`) lists the reasons eligible for a
held skip. `local-edits` is deliberately absent; `held-blockers.ts:77-87` says why:
`gitFingerprint` covers Git metadata, never tracked working-tree bytes, so restoring
the incoming bytes changes nothing the predicate sees and the repo carries its
pending lane to the one-hour floor. Design 176 §4 v5 ruled it out, #641 re-added
it unaudited, design 241 removed it again against a red rig scenario and an FM field
twin. Re-admitting it needs a working-tree witness — the same oracle proof measured
above — so #814 is *blocked on* this work, not parallel to it.
