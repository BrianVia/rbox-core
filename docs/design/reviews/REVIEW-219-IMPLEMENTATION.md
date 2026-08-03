# Implementation review 219

**Verdict: READY**

## Resolution

The required timing-attribution correction is present. All three hoisted
`ownershipProofContext(...)` refreshes—initial admission, checkout boundary,
and final classification—now run inside
`addTimedMs(opts.chainTimings, "ownershipMs", ...)`. No residual finding
remains.

## Confirmed correct

- `tipOwnedByIncomingDetailed` delegates to the batch, while every fallback
  calls the non-delegating legacy implementation; there is no fallback
  recursion.
- Missing-root results now match the complete legacy entry shape, including
  omission of `commit`, and the differential compares complete entries.
- Current plus stash results remain positional. Current/stash reason mapping,
  unreadable-reflog independence, and detail ordering are unchanged.
- Shallow evidence is refreshed at checkout second proof and after the final
  user hook; the race regression proves stale admission evidence cannot
  authorize checkout.
- The spawn regression enters through the production helper used by
  `classifyCheckout`, uses distinct stash-like tips, proves constant scaling,
  and the red evidence shows the old per-tip call shape growing from 9 to 123
  processes.
- The additional injectable `prove` parameter on
  `classifyCheckoutOwnership` is not needed by production or the landed tests.
  Removing it would simplify the exported seam, but it is not a correctness
  blocker.

## Review validation

```text
bun run typecheck
PASS

bun test src/engine/git/reachability.test.ts
26 pass, 0 fail

bun test src/cli/sync-git/follow.test.ts -t 'issue 569'
2 pass, 0 fail

bun test src/engine/git/
361 pass, 2 skip, 0 fail
```

The full `src/cli/sync-git/` run was interrupted by the review deadline before
completion and therefore is not claimed as acceptance evidence here.
