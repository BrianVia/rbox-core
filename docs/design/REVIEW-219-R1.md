# Review 219 R1 — batched follow ownership proof

**Verdict: NOT ALIGNED**

The direction is correct, and the proposed current-tip-plus-stash positional
batch preserves the intended classification mapping. The design is not yet
specific enough to preserve the frozen oracle contract at two important
boundaries.

## Required changes

1. **Make full-entry oracle equivalence explicit, including the missing-root
   case.** The current fast path does not equal the legacy detailed result when
   a root cannot be peeled: it returns a valid subject's peeled `commit`,
   whereas `tipOwnedByIncomingDetailed` returns no `commit` because
   `peelAndVerify([tip, ...roots])` failed before classification. The proposed
   differential assertion over full `PartitionedOwnership` entries will
   correctly expose this, but the production section currently leaves the
   required behavior ambiguous. State that an invalid root must produce the
   oracle's exact entry shape (currently no `commit` on any result), either by
   falling back to the oracle or by constructing that exact shape. Apply the
   same rule to every fallback: equality is the entire entry (`tip`, optional
   `commit`, proof status, and marker), not merely status/marker.

2. **Specify the non-recursive oracle split.** After
   `tipOwnedByIncomingDetailed` delegates to `partitionOwnedByIncoming`,
   `legacyPartition` must never call that delegating function or a batch
   fallback will recurse. Name the retained implementation (for example,
   `tipOwnedByIncomingLegacyDetailed`), make `legacyPartition` call it
   directly, and expose only that retained implementation as the test oracle.
   Add a fault-injection assertion that a batch ownership-walk failure reaches
   the legacy implementation once and terminates with the exact legacy entry.

3. **Do not reuse an unvalidated shallow result across the mutation-boundary
   reproof.** `sameIncarnation` validates repository identity, not the state of
   `<commonDir>/shallow`; the same repository can become shallow or unshallow
   while follow is in progress. Reusing the admission-time `false` at
   `secondProof` can therefore turn the boundary's fail-closed
   `shallow-store` result into an owned answer. Either:

   - re-read `shallow` from `freshCtx.commonDir` for the boundary classifier
     (and for a later final classifier after another user hook/race window), or
   - carry a shallow-file identity token and fail closed unless it is
     revalidated unchanged at each proof boundary.

   Hoisting `repoCtx` out of the reachability helper is still correct and
   removes its subprocesses. “Once per repo per follow” must be qualified by
   these concurrency boundaries; a cheap filesystem revalidation is required
   where the old code performed a fresh fail-closed proof. Add a race test that
   creates/removes `shallow` between first classification and second proof and
   demonstrates that checkout is not authorized from stale evidence.

4. **Pin current/stash error behavior with follow-level tests.** Stash reflog
   enumeration must happen before the combined call, unlike the current
   current-tip-first observation order. The implementation must nevertheless:

   - run the current-tip batch when stash enumeration throws;
   - retain the current-tip reason/detail before the stash unreadable detail;
   - not classify a reflog read failure as an ownership-walk failure;
   - retain positional duplicates and map only stash entries to
     `local-stash`.

   Add tests for an unreadable reflog plus an unowned current tip, and for an
   owned current tip plus one unowned and one indeterminate stash subject.
   These protect the “no classify/follow decision logic changes” constraint
   during the orchestration rewrite.

5. **Make the spawn regression genuinely follow-shaped.** Calling
   `partitionOwnedByIncoming` directly would duplicate the existing
   “500 candidates” engine test and would not prove that `classifyCheckout`
   stopped looping over stash OIDs. The regression must enter through the
   production helper used by `classifyCheckout` (or through a focused follow
   integration), supplying one current tip and many **distinct** stash-like
   tips with multiple roots. Compare a small N and a large N, assert the large
   run is `<= 10` observed Git invocations, assert the successful trace has the
   batch plumbing and no `merge-base`, and assert current/stash reason mapping.
   Capture the requested old-call-shape red run verbatim in the next review
   evidence file (command, N, expected bound, actual count/failure), then
   restore the implementation before validation.

## Notes already aligned

- Delegating both public single-tip APIs to the partition path is the right
  global fix; several follow call sites outside `classifyCheckout` remain
  single-tip and will still gain bounded subprocess behavior.
- Current tip followed by stash OIDs is the correct positional layout, and
  interpreting current and stash slices separately preserves reason ownership.
- Annotated tags, duplicate inputs, missing subjects, empty roots, shallow
  stores, missing parents, graph environment, and walk-fallback classes listed
  for the differential fixture match the implementation's oracle-contract
  comment.
- No CODEMAP update is required because module ownership does not move.
