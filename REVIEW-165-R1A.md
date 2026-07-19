# REVIEW-165-R1A — adversarial safety review

Verdict: **CHANGES-REQUIRED**

The field diagnosis is correct: in the rig's all-scope, HEAD-only switch, B's
unchanged `feature/prop-test` ref is omitted from `checkoutRoots`, so
`tipOwnedByIncoming(featureTip, [mainTip])` returns `unowned` and the pending
section cannot bootstrap itself. The ancestry predicate is also sound in one
important, narrow sense: a truly receiver-only current commit cannot be an
ancestor of a genuine incoming commit root. The proposed construction is not
sound, however. It equates “named by the incoming snapshot” with “durably
published on this receiver,” includes values the ref plane held or filtered,
and gives newly admitted unchanged refs no locked boundary witness.

## Findings

1. **BLOCKER — `opts.incoming.refs` includes held and scope-filtered values, so the proposed code cannot satisfy its own “held values remain excluded” invariant.**

   Design 165 says both “the oid of every ref in `opts.incoming.refs`” and
   “held values remain excluded” (`docs/design/165-checkout-follow-ownership.md:70-77`).
   Those sets are not equivalent. `publishRefPlane` classifies divergent,
   sibling-owned, forced, and receiver-equivalent refs as holds
   (`src/cli/sync-git/follow.ts:594-635,690-702`), while pointer receivers filter
   tags and stash out of the effective publish set altogether
   (`follow.ts:526-532`). All of those OIDs remain in raw
   `opts.incoming.refs`. Moreover, a non-checkout held ref does not generally
   defer checkout: `heldRefs` is only a breadcrumb-waiver veto at
   `follow.ts:483-504`; `checkoutRefReason` is forced for the incoming checkout
   ref, not every held ref (`follow.ts:696-701`).

   Concrete interleaving:

   - Incoming all-scope snapshot has `HEAD = main@Y` and `refs/tags/t = H`,
     where `X` is an ancestor of `H` and `Y` is unrelated.
   - B is detached at `X`. B's local `refs/tags/t = L`, where `L` is
     receiver-only and unrelated, so the ref plane correctly holds the tag at
     `L`; alternatively, use an all-scope sender and a pointer receiver, where
     the tag is filtered by `effectiveRefs`.
   - Adding every raw incoming ref makes `H` a checkout root. Classification
     now proves detached `X` owned because `X <= H`, even though `H` was never
     published on B.
   - Detached B has no `liveBefore.currentRef`, so the displacement-pin path at
     `follow.ts:1033-1080` does not run. Checkout moves HEAD to `main@Y`.
     `stageIncoming.cleanup()` then deletes the `refs/rbox-incoming/*` scratch
     refs (`follow.ts:320-327,1356`). `X/H` have no durable local ref and are
     left only to ordinary reflog/object-retention behavior.

   This does not make `X` “receiver-only” in the graph-theoretic sense—being an
   ancestor of `H` proves the sender knew `X`. It does refute the design's
   stronger durability claim and can orphan a commit from the receiver's
   durable ref graph. The current comment at `follow.ts:975-977` excludes this
   case deliberately.

   Define the admitted set from `effective.refs` and the actual ref-plane
   disposition, not raw `opts.incoming.refs`. A held, ambiguous, forced, or
   scope-filtered value must never authorize checkout.

2. **BLOCKER — the newly admitted unchanged current-ref value is only an observation; without a reservation it can disappear after the second proof and still authorize checkout.**

   `publishRefPlane` unconditionally skips the live current ref because it
   belongs to the checkout transaction (`follow.ts:690-692`). That is the
   omitted ref in the rig. (Non-current equal refs have additional branch/safe
   ref disposition logic at `follow.ts:704-765`; the design's blanket statement
   that all unchanged refs are skipped is too broad.) The existing second proof
   reuses the static `checkoutRoots` (`follow.ts:1221-1233`) and verifies values
   only for `progress.appliedRefs`/`progress.heldRefs`
   (`follow.ts:1246-1273`). The skipped, unchanged current ref is in neither
   map. `commitCheckout` can reserve arbitrary refs across the second proof and
   commit (`src/engine/git/checkout-txn.ts:596-613`), but `follow.ts` does not
   reserve the old current branch when it is unchanged and HEAD is switching
   away (`follow.ts:1081-1088,1101-1135`).

   Concrete rig-shaped interleaving:

   - Incoming all-scope snapshot has `HEAD = main@Y` and unchanged
     `refs/heads/feature = X`; B is on `feature@X`.
   - The proposed root admits `X`. Both classifications pass. There is no
     current-branch transition because its OID is unchanged, so no expected-old
     update, displacement-pin plan, or reservation covers `feature`.
   - After the second proof has read `feature@X` but before the prepared HEAD
     switch commits, a local `git update-ref -d refs/heads/feature` (or force
     move) completes and releases its own lock. The prepared transaction owns
     HEAD/index locks, not an unchanged old-branch lock.
   - Checkout commits the symbolic move to `main@Y`. Scratch cleanup then
     removes the imported namespace. If the concurrent action deleted the ref,
     `X` has been orphaned from the durable ref graph and survives only according
     to ordinary reflog/object-retention behavior.

   Again, `X` is sender-known rather than receiver-only; the ancestry theorem
   remains sound. The failure is that the new authorization depends on a ref
   the transaction does not keep durable. A remote push from a second machine
   between capture and B's apply does not itself mutate B's refs, so it cannot
   create this local race; B may temporarily apply a stale accepted snapshot
   and will see the newer sequence on its next pull. The dangerous interleaving
   is a receiver-local Git writer between observation and commit. The existing
   code's own warning that equality is “observation, not authority” applies here
   too.

   The smallest safe fix for the reported incident is narrower than “all
   incoming refs”: if `liveBefore.currentTip` exactly equals an unheld,
   effective incoming ref that is also present at that exact value on the
   receiver, admit the tip as a self-root and reserve at least one such witness
   ref at that OID through the checkout commit. Re-run the same equality under
   the reservation. This fixes the rig without allowing an unrelated incoming
   ref to become authority. Admitting broader ancestor roots is possible, but
   every witness still needs the same effective/unheld selection and locked
   durability proof.

3. **MAJOR — “every incoming ref” broadens failure as well as success because valid Git tags need not peel to commits.**

   The wire permits heads, tags, and stash, and validates tag values only as
   40-hex OIDs (`src/engine/manifest-validate.ts:261-265,355-359`). Git tags may
   point to blobs or trees. `incomingOwnershipRoots` admits every tag OID
   (`src/engine/git/reachability.ts:49-64`), while `peelAndVerify` treats any
   failed `^{commit}` peel as an indeterminate whole proof before testing the
   other roots (`reachability.ts:87-110`). Consequently, adding a held or
   pointer-filtered blob/tree tag from raw `opts.incoming.refs` can turn a
   checkout that is already authorized by a valid branch root into
   `unreadable`/`missing-object`. This contradicts the rollout
   premise that every widened case is merely a previously permanent wedge
   (`docs/design/165-checkout-follow-ownership.md:140-144`). Annotated and
   lightweight tags that peel to commits are valid roots; non-commit tags are
   not.

   Either keep the incident fix to an exact branch-tip witness, or specify and
   test per-root type handling so a known non-commit tag is skipped without
   weakening the fail-closed behavior for missing/corrupt commit objects.

4. **MAJOR — the required tests do not cover the safety boundary the change crosses, and one requested assertion is impossible under the stated construction.**

   The design requires a roots test that includes all incoming refs while still
   excluding held values (`docs/design/165-checkout-follow-ownership.md:120-125`),
   but the mechanism supplies no disposition input from which that test could
   distinguish them. Before implementation, require tests for:

   - exact unchanged-current-tip success with a locked witness;
   - local current tip ahead of its own incoming branch, both at initial proof
     and injected at the boundary;
   - all-scope deletion of the checked-out branch, with and without another
     durable ref containing its tip;
   - scoped incoming sections (only HEAD's branch is captured; absent refs are
     not deletions) and all-scope incoming applied to a pointer receiver;
   - detached receiver HEAD and detached incoming HEAD;
   - changed/held tag, stash, sibling-owned branch, forced hold, and
     receiver-equivalent ambiguous refs never becoming roots;
   - annotated commit tags versus lightweight/annotated non-commit tags;
   - deletion/movement of an unchanged witness between first proof and boundary,
     proving the reservation aborts the checkout;
   - a newer remote publish after B fetched its snapshot, proving eventual
     convergence without treating remote staleness as local authority.

5. **MAJOR — the no-kill-switch rollout claim is factually wrong and discards a useful existing containment control.**

   `RBOX_GIT_FOLLOW=0` already disables automatic checkout follow
   (`src/cli/sync-git/shared.ts:49-52`), is passed into this path on every apply
   (`src/cli/sync-git/apply.ts:1135-1148`), and returns before checkout-root
   construction (`src/cli/sync-git/follow.ts:964-973`). Therefore this change is
   already behind a live local kill switch; no new flag is necessary. The
   rollout should say that explicitly, retain the switch, and add a regression
   proving `=0` blocks the newly authorized HEAD-only case while preserving
   existing ref-plane behavior. It is a per-process/fleet-configuration switch,
   not a remote instantaneous fleet switch, so rollout instructions must also
   say how founder daemons receive it. Mixed versions remain format-safe as the
   design claims: old followers are only over-conservative.

6. **MINOR — the rig does not enforce the design's claimed “in <= 2 cycles” gate.**

   The scenario retries up to five cycles and only asserts that B eventually
   reaches `main` (`scripts/rig/scenarios/git-ff.ts:108-120`). It never asserts
   `cycles <= 2`; on total failure its label even reports `cycles + 1` after
   only five attempts. Add an explicit cycle-budget assertion so a partial
   parking/retry regression cannot pass the named gate.

## Claim-by-claim safety audit

- **Genuinely local current commit:** verified. If the current tip is not an
  ancestor of any commit-bearing checkout root, `merge-base --is-ancestor`
  exhausts the roots and returns `unowned` (`reachability.ts:106-121`). Merely
  adding an older incoming value cannot authorize a follower-ahead descendant.
- **Follower ahead of its own branch:** verified with the design's stated
  qualification “not ancestor of any incoming value.” If another incoming
  branch, tag, detached HEAD, or commit-bearing op-state root descends from the
  follower tip, the tip is sender-known and classification may legitimately be
  owned; the sentence should not imply the own-branch comparison alone decides
  the result.
- **Remote deletion while checked out:** all-scope sections may delete absent
  refs; a unique ahead tip still defers. Scoped sections never delete absent
  refs (`follow.ts:526-532`) and capture only the pointer worktree's current
  branch, or no refs for detached HEAD (`src/engine/git/refs.ts:17-23`). A
  deletion authorized via another root is safe only if that root is durably
  locked or displacement pins are created; Finding 2 shows the missing lock.
- **Detached incoming HEAD:** verified. The detached incoming OID is already an
  ownership root (`reachability.ts:52-59`) and becomes HEAD in the prepared
  transaction (`follow.ts:1081-1083`), so it is not the missing-root incident.
  A receiver-ahead detached tip remains unowned. Detached *receiver* HEAD is the
  most important held/filtered-root adversary because it has no current branch
  displacement-pin path (Finding 1).
- **Tags/non-branch refs:** only heads, tags, and `refs/stash` are syncable;
  remotes/notes/replace/internal refs are excluded
  (`manifest-validate.ts:261-265`). Commit-peeling tags can prove ownership,
  but held/filtered values cannot prove receiver durability, and non-commit
  tags cause the liveness failure in Finding 3. Stash additionally protects
  every local stash reflog OID during classification, but a held stash value is
  still not checkout authority.
- **Held/ambiguous/worktree/oracle gates:** oracle mismatch and ambiguity of the
  current or incoming checkout ref still defer. The broader claim that held
  refs are “untouched” is false for root construction: unrelated held refs are
  intentionally compatible with checkout follow, so putting their incoming
  values into roots changes authorization even though no reason enum changes.
- **Second machine publishes during apply:** no direct receiver-only-commit
  hazard was found. The incoming artifact remains a closed historical snapshot;
  a later remote sequence does not alter B's live refs. There is no latest-head
  revalidation at checkout, so B may briefly follow the older snapshot, then
  process the newer one. The safety-critical race is a local writer changing an
  admitted durability witness, which the prepared transaction must reserve.
- **No wire/schema/state change and mixed versions:** verified.

The design should be revised around an exact, effective, unheld, boundary-locked
durability witness. With that change—and the adversarial matrix above—the
original rig fix can remain a small read/apply-side correction rather than a
global redefinition of checkout authority.
