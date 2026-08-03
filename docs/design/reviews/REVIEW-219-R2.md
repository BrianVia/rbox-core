# Review 219 R2 — batched follow ownership proof

**Verdict: ALIGNED**

The revised design resolves all five R1 requirements and is precise enough to
implement without changing classify/follow decisions.

## R1 resolution

1. Full-entry equivalence is now normative. The design explicitly includes
   positional `tip`, optional `commit`, proof status, and marker, and calls out
   the previously divergent missing-root case: no subject may retain `commit`
   when the legacy oracle would omit it.

2. The oracle split is non-recursive by construction:
   `tipOwnedByIncomingLegacyDetailed` remains non-delegating,
   `legacyPartition` calls only it, and the public detailed function delegates
   to the batch. The specified fault-injection termination assertion protects
   this structure.

3. Shallow-state hoisting now respects proof boundaries. The initial proof
   uses `opts.ctx`; checkout second proof and the post-hook final classifier
   re-read `<commonDir>/shallow` from their already-known context. Thus the
   change removes repeated `repoCtx`/Git subprocesses without caching a false
   answer across a race window. The specified shallow-transition race test
   pins the fail-closed behavior.

4. Current/stash orchestration is implementable with frozen mapping. The
   design says to evaluate the current tip alone if reflog enumeration fails,
   append current detail before the independent reflog detail, preserve
   positional duplicates, and allow only the stash slice to add
   `local-stash`. The two follow-focused tests cover the subtle error paths.

5. The subprocess regression now enters through the exact production
   ownership-gathering helper used by `classifyCheckout`, uses distinct
   stash-like tips and multiple roots, compares small and large N, checks
   reason mapping, caps the large run at 10, and rejects `merge-base` on the
   successful fast path. This proves the follow loop was removed rather than
   merely retesting the engine partition function. The required temporary
   old-shape red run and verbatim evidence are also explicit.

The direct-context shallow option, refreshed probe lifetime, and fallback
oracle form a coherent API boundary: reachability owns graph semantics while
follow owns when repository evidence must be refreshed. No CODEMAP ownership
change is needed.

## Executable review evidence

Baseline command run from the worktree:

```text
$ bun test src/engine/git/reachability.test.ts
bun test v1.4.0-canary.1 (6c12afd8e)

 25 pass
 0 fail
 53 expect() calls
Ran 25 tests across 1 file. [1330.00ms]
```

This is the required code/test-bearing review round. It confirms the current
oracle and batch test baseline is green before implementation; the revised
design separately requires the new differential, recursion, shallow-race,
follow-mapping, and spawn-count regressions.
