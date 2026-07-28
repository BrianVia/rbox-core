# Design 219: Batched follow ownership proof

**Issue:** #569  
**Scope:** proof computation only; checkout/ref classification and follow decisions are frozen.

## Problem

The follow classifier proves the current checkout tip and every stash-reflog
tip independently through `tipOwnedByIncoming`. The legacy proof peels every
subject/root with serial `rev-parse` calls and then probes roots with serial
`merge-base --is-ancestor` calls. A repository with hundreds of incoming
ownership roots therefore pays O(tips × roots) Git subprocesses, and follow may
repeat that proof at the initial, checkout-boundary, and final classifiers.

`partitionOwnedByIncoming` already implements the same proof with one shallow
probe, one batch peel, one integrity walk, and one ownership walk. Its fallback
contract deliberately uses the legacy path as its semantic oracle.

## Frozen semantics

For every input tip, the batched answer must equal the legacy answer, including:

- annotated tag tips and roots peel to commits;
- duplicate raw tips and distinct tags peeling to one commit remain positional;
- an absent/malformed tip is independently `missing-object`;
- an absent/malformed root poisons every answer as `missing-object`;
- a shallow repository returns `shallow-store` for every answer;
- an unreadable shallow probe returns `walk-error`;
- batch parse/count failures and integrity/ownership walk failures fall back to
  the legacy oracle, preserving per-tip `commit` fields and exact
  `missing-object`/`walk-error` markers;
- no roots means a valid tip is `unowned`;
- replacement objects and lazy promisor fetches remain disabled by `graphEnv`.

Equivalence means the entire `PartitionedOwnership` entry: positional `tip`,
presence or absence of `commit`, proof status, and marker. In particular, an
unpeelable root yields the legacy shape with no `commit` on any subject; the
fast path must not leak a successfully peeled subject commit in that case.

No reason ranking, blocker construction, breadcrumb waiver, held-ref handling,
or checkout/follow decision changes.

## Production change

### Reachability API

Rename the old single-tip implementation to the non-delegating
`tipOwnedByIncomingLegacyDetailed` oracle helper. Make the partition fallback
call only that helper, never the new delegating single-tip function, so a batch
fallback cannot recurse. Expose a test-oriented legacy partition seam for
differential testing. Fault injection pins that a failed ownership walk enters
the legacy implementation once and terminates.

Make `tipOwnedByIncomingDetailed` call
`partitionOwnedByIncoming(repoDir, [tip], roots)` and return its first result;
`tipOwnedByIncoming` continues to return only `.proof`. This makes every
remaining single-tip caller use the bounded batch implementation without
changing its result type.

Allow a partition caller with an already-known `RepoCtx` to provide one
ownership-store probe result. Add a reachability helper that reads
`<commonDir>/shallow` directly from that context, retaining the three-valued
`true | false | undefined` result. Callers without a context retain the current
`rev-parse --git-common-dir` fallback.

### Follow batching and probe lifetime

At follow admission, derive the ownership-store probe from `opts.ctx` for the
initial classifier, eliminating the reachability helper's `repoCtx`
subprocesses. Re-read `<commonDir>/shallow` from the already-known context at
each later mutation/race boundary (the checkout second proof and the final
classifier after its user hook). These are filesystem revalidations, not
`repoCtx`/Git subprocess probes. This is the maximum safe hoist: blindly
reusing admission-time `false` could authorize from stale evidence if the same
repository becomes shallow during follow. The existing boundary incarnation
check remains independently authoritative.

Extract a focused ownership-gathering helper used by `classifyCheckout`.
Within one classifier/helper invocation:

1. enumerate stash reflog OIDs exactly as today and retain its independent
   error handling/timing;
2. build positional tips as the readable current tip followed by every stash
   OID;
3. call `partitionOwnedByIncoming` once with that list and the classifier's
   unchanged roots;
4. interpret the current result with the existing `local-commits`,
   `unsupported`/`unreadable`, and detail rules;
5. interpret stash results with the existing `local-stash`/`unreadable` and
   detail rules.

If stash enumeration throws, call the partition with the readable current tip
alone, then retain the current-tip reason/detail before appending the existing
stash-reflog unreadable detail. A reflog read error is never converted to an
ownership-walk error. An unreadable current tip still adds the existing
unreadable reason. Result ordering and duplicate stash OIDs remain positional,
and only entries in the stash slice can add `local-stash`.

CODEMAP ownership does not change: `reachability.ts` still owns graph proof,
and `follow.ts` still owns classification/orchestration.

## Tests

### Differential oracle

Build real repositories covering:

- an owned ancestor, an unowned sibling, and duplicate tips;
- annotated-tag-only ownership (tag tip/root peeling);
- stash roots and stash reflog subjects;
- a depth-1 shallow clone;
- missing tip/root objects and a deliberately missing parent;
- empty roots.

For every generated tip set, compare full `PartitionedOwnership` entries from
the batch path against the non-delegating legacy oracle, not merely status
strings. Existing fault-injection tests continue to pin fallback behavior, and
one assertion counts that a forced ownership-walk failure reaches and
terminates in the legacy path without recursion.

Follow-focused tests pin that:

- an unreadable stash reflog still evaluates an unowned current tip and retains
  current-tip detail before reflog detail;
- an owned current tip plus an unowned and an indeterminate stash subject maps
  only the stash slice to stash reasons;
- adding/removing `shallow` between the first classifier and checkout boundary
  cannot authorize checkout from the cached initial result.

### Follow-shaped spawn regression

Use the existing `setGitSpawnObserver` seam and enter through the production
ownership-gathering helper used by `classifyCheckout`, not through
`partitionOwnedByIncoming` directly. Exercise one current tip and N distinct
stash-like tips against multiple roots. Compare small and large N, assert
current/stash reason mapping, and assert the large run is constant and at most
10 observed Git invocations. The command trace must contain the batch plumbing
and no `merge-base` in the successful fast path.

Before landing, temporarily restore the old per-tip call shape while retaining
the regression test, run the focused test to capture the expected red
spawn-count failure, then restore the implementation. Record the command and
output in the review evidence.

## Validation

Run:

```sh
bun run typecheck
bun test src/engine/git/
bun test src/cli/sync-git/
```

Also run the differential and spawn-count tests by exact test name. Perform a
diff-scoped simplify pass, stage only named files, and commit on
`fix/ownership-spawns` without pushing.
