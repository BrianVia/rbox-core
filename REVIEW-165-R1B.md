# Review 165 R1B — mechanism fidelity + implementability

Verdict: **CHANGES-REQUIRED**

Reviewed against `bef5e0161dc8761064ed463f308d9bf6ed0a22f7`; worktree `HEAD` and `origin/main` are both that commit. All cited production files match that revision.

## Findings

1. **HIGH — The proposed root set violates the durability invariant it claims to preserve.**

   `follow.ts:975-977` permits already-published incoming refs plus the current-ref value the checkout transaction will publish, and explicitly excludes held incoming values. `opts.incoming.refs` is not that set. `publishRefPlane` can retain a receiver value and place the corresponding incoming ref in `heldRefs` (`follow.ts:594-635,690-703,776-810`), but the incoming OID remains present in `opts.incoming.refs`. A literal implementation of design lines 73-77 therefore re-admits held, unpublished values as checkout authority. It also bypasses receiver scope: `effectiveRefs` removes tags/stash for pointer/worktree receivers (`follow.ts:526-532`), whereas raw `opts.incoming.refs` may still contain them.

   The fix must define the admissible durable set rather than append all raw incoming values. The narrow case needed by the reproduction is the unchanged live current ref during a branch switch. If a broader live-equal set is intended, it must be derived from `effective.refs`, exclude held values, and have an explicit locked durability proof. As written, the proposed mechanism and required test 3 ("still excludes ... held values") cannot both pass.

2. **HIGH — Newly admitted non-HEAD roots have no boundary reservation or revalidation.**

   The boundary classification reuses the precomputed `checkoutRoots` (`follow.ts:1221-1233`), but the locked checks only validate `progress.appliedRefs` (`follow.ts:1246-1269`) and held receiver refs. The incoming HEAD receives an explicit reservation (`follow.ts:1084-1088`); arbitrary OIDs added from `opts.incoming.refs` do not. Thus even a value observed live-equal before the first proof can move before checkout while its old OID remains accepted as authority.

   Either limit the new admission to a case whose fresh current tip is itself reproved and remains durable, or reserve/revalidate every newly admitted ref at the checkout boundary. Add a race test that changes an admitted unchanged non-HEAD ref between the first proof and the transaction boundary.

3. **MEDIUM — The design identifies the wrong omission seam, although the exact reproduced failure is real.**

   In the switch-back fixture, `feature/prop-test` is B's current ref. It is skipped at `follow.ts:605` (and again at `:691`) before the `oldOid === newOid` check at `:608`. Unchanged non-current refs are not categorically skipped: the equality arm at `follow.ts:704-764` may record them in `appliedRefs`. Also, `checkoutRoots` includes qualifying operation-state commit candidates through `incomingOwnershipRoots` (`reachability.ts:39-64`), so it is not literally only applied ref terminals plus HEAD.

   For this fixture, however, the root set is the sole *active failing classification*: file apply precedes oracle construction and Git apply (`pull.ts:203-267`); the observed oracle/index/op-state/ownership gates pass; and `tipOwnedByIncoming(featureTip, {mainTip})` fails because it tests `featureTip` as an ancestor of `mainTip` (`reachability.ts:106-126`). Adding the exact `featureTip` as a durable self-root would pass both the initial and boundary classifications and unwedge the parked retry. The roots construction is not the checkout pipeline's sole structural gate—`classifyCheckout` has the other gates at `follow.ts:408-488`—so the design should state the narrower claim.

4. **HIGH — The regression gate does not enforce the design's cycle bound or prove state promotion.**

   `scripts/rig/scenarios/git-ff.ts:110-115` allows five cycles and only asserts eventual branch equality. It never asserts `<= 2`; after exhausting all five attempts its `${cycles + 1}` label reports six. Lines 121-127 parse and log the repo record but assert nothing about it. Consequently the rig can pass despite slow convergence, stale `pending`, a surviving apply deferral, or an unadvanced serialized BASE.

   Make the cycle count an assertion; assert the persisted record's BASE HEAD/refs equal the incoming section, `pending` is absent, the apply deferral is absent, and `partial` is null/absent when config also succeeded. Then run one idle cycle and prove the state does not re-park. Unit coverage should assert the apply outcome and landed/persisted record, not only that checkout moved.

5. **MEDIUM — The proposed unit coverage misses the unsafe topology and has no current direct seam.**

   `checkoutRoots` is local to `followDivergedRepo` (`follow.ts:979-988`), and `classifyCheckout` is private. A direct “roots” unit cannot verify applied/held/effective subset construction by testing generic `incomingOwnershipRoots`, because that function intentionally accepts whatever section subset its caller supplies (`reachability.ts:49-64`). Extract a pure checkout-root constructor or make these behavior-level `followDivergedRepo` tests.

   Add counterexamples for: a non-current incoming ref whose publication is held but whose OID would otherwise prove the current tip owned; pointer/worktree incoming tags or stash excluded by `effectiveRefs`; the boundary race from finding 2; and a local-ahead tip in both graph shapes (unreachable from every admissible root, and reachable from some other root). The current phrase “ahead of its own incoming branch value” alone is insufficient because ownership is tested against any root (`reachability.ts:113-121`).

## End-to-end promotion check

With a correctly scoped self-root and no other deferral, the proposed behavior does complete the reproduced scenario. `followDivergedRepo` returns `followed`; `apply.ts:1205-1218` composes the incoming candidate with `checkoutComplete: true`. Because the branch maps are unchanged, `composeRepoBase` needs no transition witness for them (`base-composer.ts:320-441`), has no hold, selects the candidate family, and returns the incoming section as BASE (`base-composer.ts:494-515`). `apply.ts:1219-1228` then deletes `pending` and clears the apply deferral; `partial` becomes null when config also applied. The pre-commit intended record independently follows the same composition path at `apply.ts:1093-1131`.

So the promotion implementation is sound for the fixture. The design's broad authority change and its tests are not.

## File:line citation audit

| Design citation | Result | Evidence |
|---|---|---|
| `src/cli/sync/pull.ts:203-267` (also shorthand repeat) | Verified | File actions run at 203-209, the post-apply oracle is built at 242-251, and Git apply receives it at 257-267. |
| `src/cli/sync-git/follow.ts:454-455` / `follow.ts:455` | Verified | Calls `tipOwnedByIncoming` and maps `unowned` to `local-commits` with the quoted detail. |
| `src/engine/git/reachability.ts:106-126` | Verified | Peels tip/roots, runs `merge-base --is-ancestor tip root`, and returns `unowned` only after every root fails. |
| `follow.ts:979-988` (both uses) | Lines valid; description incomplete | This is the checkout-root construction, but operation-state roots are also added by `incomingOwnershipRoots`, and `appliedRefs` can represent locked terminal observations rather than only refs physically changed this cycle. |
| `follow.ts:604-608` | Interpretation incorrect | The range contains both the current-ref skip and unchanged comparison, but unchanged refs may later produce applied markers at 704-764. The reproduced ref is omitted because it is current. |
| `src/cli/sync-git/apply.ts:1198-1200` | Lines valid; under-cited | These lines park pending/partial/deferral. BASE retention for ordinary defers is established by 1168-1197, with the documented reconstructed-absence exception. |
| `apply.ts:895-901` | Lines valid; under-cited | Computes eligibility/route-through-follow; the branch starts at 921 and calls `followDivergedRepo` at 1133-1156. |
| `apply.ts:775-796` (both uses) | Verified with dependency | Projected equality is required. HEAD is part of that identity by `src/engine/git/identity.ts:92-100`, so it cannot bootstrap an unmatched HEAD. |
| `apply.ts:783-784` | Verified | Exact cited warning about observation versus authority. |
| `follow.ts:384-389` | Lines valid; weak support for stated purpose | Establishes reason precedence, not by itself the semantic purpose of `local-commits`; that purpose follows from 454-455 and reachability. |
| `follow.ts:975-977` (both uses) | Directly contradicts proposed fix | Explicitly excludes held values and requires published/current-transaction durability; raw `opts.incoming.refs` does not satisfy that condition. |
| `checkout-txn.ts:134` | Verified | Unique file is `src/engine/git/checkout-txn.ts`; line 134 invokes `git update-ref --stdin` and preserves the optional reflog message via `-m`. |

