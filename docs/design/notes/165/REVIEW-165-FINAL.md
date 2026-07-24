# REVIEW-165-FINAL — final serial adversarial review

Verdict: **CHANGES-REQUIRED**

Reviewed design v2 and both r1 reviews against the full production paths at
`bef5e0161dc8761064ed463f308d9bf6ed0a22f7`, including
`src/cli/sync-git/follow.ts`, `src/engine/git/checkout-txn.ts`,
`src/engine/git/reachability.ts`, both relevant `apply.ts` modules, and the
existing tests.

The field diagnosis is correct, and the narrow branch-witness mechanism is
implementable: reserve the unchanged old current branch at its exact value,
add the current tip as a self-root, and re-run the equality while the
reservation is held. The reservation is acquired before the second proof and
remains held through ref/HEAD, index, and op-state publication. The ordinary
defer and successful promotion paths also behave as v2 says.

V2 is not yet an implementable binding specification, however. Its tag
identity rule and three test expectations conflict with each other and with
the real root builder.

## Findings

1. **BLOCKER — An annotated tag cannot satisfy v2's exact-OID eligibility, but test 8 requires it to be eligible.**

   The mechanism requires:

   ```text
   incoming[R] == receiverRefs[R] == liveBefore.currentTip
   ```

   with exact OID equality (`docs/design/165-checkout-follow-ownership.md:98-102`).
   `readAllRefs` obtains the direct ref value from `git show-ref`
   (`src/engine/git/refs.ts:6-14`), while `readLive.currentTip` resolves the
   current branch or HEAD to its commit (`follow.ts:356-378`). For an annotated
   commit tag, the direct ref value is the tag-object OID, not the peeled commit
   OID. The repository's own reachability test explicitly asserts that those
   OIDs differ (`src/engine/git/reachability.test.ts:231-238`). Therefore an
   annotated tag can peel to `liveBefore.currentTip`, but can never equal it in
   the raw three-way equality specified by v2. Test 8 nevertheless requires
   “Annotated commit tag as witness: eligible” (design lines 178-180).

   Pick one contract before implementation:

   - Limit witnesses to refs whose **direct** OID equals the current tip; this
     permits heads and lightweight commit tags, and test 8 must make annotated
     tags ineligible.
   - Or define a witness as `(ref, expectedRawOid, expectedCommitOid)`: require
     `incoming[R] == receiverRefs[R] == expectedRawOid`, require an exact peel
     `expectedRawOid^{commit} == liveBefore.currentTip`, reserve `R` at
     `expectedRawOid`, and add `expectedCommitOid` as the self-root. Recheck the
     raw equality and the exact peel under the reservation. This supports
     annotated tags without introducing ancestry reasoning.

2. **HIGH — R1A-3 is only partially folded: excluding a non-commit tag as the new witness does not make test 8's “does not poison” assertion true.**

   An effective, already-equal tag is recorded as a direct applied ref when its
   BASE value is also equal (`follow.ts:704-764`). Its OID then enters
   `durableIncomingRefs` (`follow.ts:979-981`) and
   `incomingOwnershipRoots`, which adds every tag OID without checking its
   object type (`reachability.ts:49-64`). `peelAndVerify` peels **all** roots
   before running any ancestry comparison (`reachability.ts:87-116`), so one
   blob/tree tag makes the whole proof `missing-object`; the new `tip == tip`
   self-root cannot rescue it.

   V2's candidate peel check prevents a held or scope-filtered non-commit tag
   from becoming a *new* witness, which correctly avoids v1's new regression.
   It does not establish the broader binding assertion that a lightweight or
   annotated non-commit tag “does not poison an otherwise authorized
   checkout,” especially in the natural unchanged/effective-tag fixture.
   Line 114's “Nothing else changes” also supplies no filter for existing
   durable roots.

   Either narrow test 8 to the actual delta—non-commit witness candidates that
   are not already checkout roots are skipped without poisoning the proof—or
   explicitly specify a per-root filter for known non-commit durable tags. If
   the latter is chosen, the design must preserve fail-closed behavior for a
   missing or corrupt object rather than treating every peel failure as a known
   non-commit tag.

3. **HIGH — The local-ahead safety claim and binding test 5 demand opposite results for the second graph shape.**

   The safety analysis correctly says ownership remains root-set-wide: an
   ahead tip that is an ancestor of another admissible root is sender-known and
   may follow (design lines 134-138). The next sentence then says a follower
   ahead of its own incoming branch “defers exactly as today” without that
   qualification (lines 139-140). Test 5 makes the contradiction explicit: it
   says the case “defers — in BOTH graph shapes,” then describes the second
   shape as “tip reachable from some other root → legitimately owned” (lines
   170-172).

   `tipOwnedByIncoming` returns `owned` as soon as `tip` is an ancestor of any
   root (`reachability.ts:106-121`). The binding expectations must therefore be:

   - ahead tip unreachable from every admissible root: `local-commits` defer;
   - ahead tip ancestor of another admissible durable root: owned (and may
     follow if the other gates pass), while documenting that the new self-root
     was not what authorized it.

4. **MEDIUM — Test 7's blanket sibling-owned exclusion is not stated by the eligibility rule and is not implied by “unheld.”**

   Test 7 says sibling-owned incoming values are never eligible witnesses
   (design lines 175-177), but eligibility lines 94-102 do not list sibling
   ownership separately. In the real ref plane, an already-equal ref is skipped
   before the changed-ref sibling-ownership checks (`follow.ts:604-610`) and
   can be recorded as a direct applied ref (`follow.ts:704-764`). This is
   deliberate no-op behavior; an equal sibling-owned branch is not necessarily
   present in `heldRefs`. Consequently “R is not held” does not implement test
   7's blanket rule.

   If all sibling-owned refs really must be excluded as witnesses, add
   `!owned.has(R)` explicitly to initial eligibility and say whether it must be
   rechecked at the boundary. Also decide whether an equal sibling-owned ref
   already present in `progress.appliedRefs` remains an ordinary checkout root.
   If the intended prohibition covers only sibling-owned values whose
   publication was held, narrow test 7 to say that. This mismatch does not
   break the reported branch-switch fix, but it makes the binding matrix
   impossible to implement unambiguously.

## R1 fold audit

| R1 item | Result in v2 |
|---|---|
| R1A-1 / R1B-1 — held, forced, ambiguous, and scope-filtered values are not authority | **Correctly folded for those dispositions.** Eligibility is based on `effectiveRefs`, exact receiver equality, and exclusion by disposition rather than raw `opts.incoming.refs`. The sibling-owned wording still needs Finding 4 resolved. |
| R1A-2 / R1B-2 — observation needs a locked boundary witness | **Correctly folded.** `CheckoutPlan.refReservations` supports the exact lock needed (`checkout-txn.ts:596-613`), the lock participates in the owned-lock busy proof, and it is retained until after op-state publication (`checkout-txn.ts:639-665,742-765`). A change before lock acquisition fails the expected-OID check; a standard Git writer after acquisition cannot take the ref lock. |
| R1A-3 — non-commit tags | **Not fully folded.** The new-witness peel gate is present, but annotated-tag equality is contradictory and the binding no-poison claim exceeds the mechanism (Findings 1-2). |
| R1A-4 — adversarial matrix | **Mostly folded, not binding as written.** Deletion, scoped/pointer, detached, held/forced/ambiguous, boundary race, and stale-snapshot cases are present. Tests 5, 7, and 8 need the corrections above. |
| R1A-5 — existing kill switch | **Correctly folded.** V2 identifies `RBOX_GIT_FOLLOW=0`, its process-local deployment procedure, and requires non-vacuous ref-plane preservation coverage. |
| R1A-6 — asserted rig cycle budget | **Correctly folded.** The `<= 2` bound is explicitly an assertion. |
| R1B-3 — exact omission seam and scope of diagnosis | **Correctly folded.** V2 identifies the current-ref skip, includes op-state roots in the description, and limits “sole failure” to the active fixture. |
| R1B-4 — promotion/state assertions | **Correctly folded.** BASE, pending, deferral, partial, and one idle no-repark cycle are all binding. The cited apply path does clear/promote them after `followed`. |
| R1B-5 — direct test seam and root-wide topology | **Partially folded.** The helper/behavior seam is specified and the two topologies are named, but test 5 assigns contradictory outcomes. |

## Mechanism verification against the real code

- In the reported fixture, the omitted witness is exactly the unchanged live
  current branch: `publishRefPlane` skips it at `follow.ts:605` and `:691`, so
  it does not enter `progress.appliedRefs`; `checkoutRoots` otherwise contains
  the incoming main tip and qualifying op-state roots. Adding the feature tip
  as a self-root makes the existing reachability proof owned.
- The witness can be carried from root construction into the existing
  `reserveRef`/`refReservations` plan in `follow.ts:1020-1025,1181-1195`.
  `commitCheckout` prepares the primary HEAD transaction, acquires and checks
  the witness ref lock, acquires the index lock, and only then invokes the
  second proof. The reservation survives the entire checkout commit.
- The second proof can re-read the selected witness from the fresh incarnation
  while its lock is held and require the same selected witness—not merely any
  replacement candidate—to retain its expected raw value and commit identity.
  A mismatch returns `defer`; `apply.ts:1159-1202` keeps the incoming section
  pending and records the deferral.
- On success, `apply.ts:1205-1228` composes with checkout complete, advances
  BASE, removes pending, clears the apply deferral, and nulls partial when
  config also applied. No new promotion or retry hole was found.

The exact branch self-root plus boundary reservation is sound and ready to
implement once Findings 1-4 are resolved in the design. Until then, the
binding tests admit mutually incompatible implementations, so the final gate
is **CHANGES-REQUIRED**.
