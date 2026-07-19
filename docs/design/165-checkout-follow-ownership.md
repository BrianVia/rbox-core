# 165 — checkout-follow: exact-equality self-root with boundary-locked witness

Status: v3 — ALIGNED (r1 wave folded; final serial review's four findings all
accepted and folded as strictly-narrowing spec edits — witnesses are branch
refs only, tests 5/7/8 restated to the reviewer's binding expectations;
mechanism itself confirmed implementable by the final review). Ready to
implement.
Owner: Claude (founder-directed, 2026-07-19)
Severity: core git functionality — permanent follower wedge in a first-week user flow

## Problem (field evidence)

Reproduced 3/3 by `scripts/rig/scenarios/git-ff.ts` (new rig scenario, kept as
the regression gate for this design):

Two paired machines. A's workspace repo is on `feature/prop-test`
(= `main` + 1 commit, both branches known to both machines and identical on
both). A runs `git switch main` — a HEAD-only move; no ref changes, no new
commits — and pushes. B pulls: the file plane applies (tree now matches
`main`), but the git section parks in `RepoRecord.pending` with deferral
reason `local-commits` and NEVER applies — six push/pull cycles, identical
verdict each time. B is stranded: checked out on `feature/prop-test` with a
permanently dirty `git status`, while `rbox git deferrals` claims B has
"receiver-only commits" that do not exist.

The forward direction (switch to a NEW branch carrying a new commit) follows
correctly in one cycle: the ancestry direction happens to point the right way.

## Mechanism (citations verified twice: recon + R1B audit, at bef5e01)

1. Pull order is file plane → post-apply oracle → git apply
   (`src/cli/sync/pull.ts:203-267`). At git-apply time B's tree already
   equals `main` content; the oracle reports `match`.
2. `classifyCheckout` gates the HEAD move with an ownership proof
   (`src/cli/sync-git/follow.ts:454-455`):
   `tipOwnedByIncoming(repoDir, live.currentTip, args.roots)` → `owned` iff
   the current tip is an **ancestor** of some root
   (`src/engine/git/reachability.ts:106-126`, `merge-base --is-ancestor`).
3. The roots comprise `progress.appliedRefs` terminals, qualifying
   operation-state commit candidates (via `incomingOwnershipRoots`,
   `reachability.ts:39-64`), and the incoming HEAD ref
   (`follow.ts:979-988`). B's current ref is skipped by `publishRefPlane`
   BECAUSE it is the live current ref (`follow.ts:605`, again at `:691`) —
   it belongs to the checkout transaction — so on a HEAD-only move it never
   enters the roots. (Unchanged non-current refs are not categorically
   skipped; the equality arm at `follow.ts:704-764` may record them.)
4. Result: `tipOwnedByIncoming(featureTip, {mainTip})` asks "is feature an
   ancestor of main" — the wrong direction — answers `unowned` →
   `local-commits` ("current tip has receiver-only commits").
5. Parking: `src/cli/sync-git/apply.ts:1198-1200` stores the section in
   `pending`, sets the deferral, and does not advance base (retention rule
   at `apply.ts:1168-1197`). No retry escalation exists: every cycle re-runs
   the identical predicate on identical inputs (`apply.ts:895-901` routes
   back through follow; the converged shortcut `apply.ts:775-796` requires
   HEAD to already equal the incoming HEAD — HEAD is part of the projected
   identity, `src/engine/git/identity.ts:92-100` — so it can never bootstrap
   the move). The wedge is permanent by construction.

Scope claim (per R1B-3): for THIS fixture the roots construction is the sole
*active failing classification* — the oracle, index, op-state, and ownership
gates all pass. `classifyCheckout`'s other gates (`follow.ts:408-488`) are
not asserted to be unreachable in general.

## The misjudgment, stated precisely

`local-commits` protects commits the incoming state does not know about. A
follower tip that **equals the oid of an effective, unheld incoming ref
that the receiver also holds at that exact value** is fully known to the
sender — there are no receiver-only commits. The roots under-approximate
"what the incoming state knows" by omitting the live current ref, and the
ancestry test then misfires in the descendant direction.

Two constraints bound any fix (both violated by v1's "admit all incoming
refs", both from the r1 wave):

- **Durability invariant** (`follow.ts:975-977`): a checkout root must be a
  value durably published on the receiver or published by the current
  transaction. Raw `opts.incoming.refs` contains held, forced,
  receiver-equivalent, and scope-filtered values (`follow.ts:594-635,
  690-703, 776-810`; `effectiveRefs` filtering at `follow.ts:526-532`) —
  none may authorize checkout.
- **Observation is not authority** (`apply.ts:783-784`): an equality
  observed before the proof can be invalidated by a receiver-local git
  writer before the commit boundary. Any newly admitted root needs a locked
  witness through the checkout commit; the second proof today revalidates
  only `progress.appliedRefs`/`heldRefs` (`follow.ts:1246-1273`) and
  reserves only the incoming HEAD (`follow.ts:1084-1088`).

## Fix (mechanism, v2 — the R1A "smallest safe fix", adopted)

Admit the follower's current tip as a **self-root**, only under an exact,
effective, unheld, receiver-held equality — and lock it:

1. **Eligibility** (computed where checkoutRoots are built,
   `follow.ts:979-988`): `liveBefore.currentTip` is admitted as a checkout
   root iff there exists a ref R such that:
   - R is in the EFFECTIVE incoming ref set (post `effectiveRefs`
     filtering — never a scope-filtered tag/stash value);
   - R is not held, forced, ambiguous, or receiver-equivalent-colliding in
     this cycle's ref-plane disposition;
   - incoming value of R == receiver's durable value of R ==
     `liveBefore.currentTip` (exact oid equality, no ancestry reasoning);
   - R is a branch ref (`refs/heads/*`) — tags and stash are NEVER
     eligible witnesses (FINAL-1: an annotated tag's direct ref value is the
     tag-object oid, which can never satisfy the exact three-way oid
     equality; rather than a peel-aware triple, the contract stays
     branch-only — the reproduced incident is branch-shaped, and this
     avoids the R1A-3/FINAL-2 tag-liveness edges entirely).
   The admitted root is the tip oid itself; `tipOwnedByIncoming` is
   unchanged and proves `is-ancestor(tip, tip)` = owned.
2. **Boundary reservation**: the checkout transaction reserves at least one
   witness ref R at that exact oid through the commit
   (`commitCheckout` supports arbitrary ref reservations,
   `src/engine/git/checkout-txn.ts:596-613`). The boundary re-proof
   re-checks the SAME eligibility (R still effective+unheld, receiver value
   still equal) under the reservation; any mismatch aborts the checkout and
   the section stays pending (fail-closed, identical to today's outcome).
   This closes the R1A-2/R1B-2 race: a `git update-ref -d` between proof
   and commit now aborts the transaction instead of orphaning the tip.
3. Nothing else changes. `tipOwnedByIncoming`, the other `classifyCheckout`
   gates, held-ref handling, scoped sections, and the pending/promotion
   machinery are untouched. Promotion after the checkout applies is already
   verified sound (R1B end-to-end check: `apply.ts:1205-1228` composes the
   candidate with `checkoutComplete: true`, `base-composer.ts:320-441,
   494-515` selects it, pending clears, deferral clears, BASE advances).

### Alternatives rejected (r1 record)

- **v1's "admit every incoming ref"**: violates the durability invariant
  (held/filtered values as authority — R1A-1/R1B-1), lacks a boundary lock
  (R1A-2/R1B-2), and imports a non-commit-tag liveness failure (R1A-3).
- **Tree-parity waiver**: second safety vocabulary in an ancestry
  predicate; blesses cases the model defers deliberately.
- **Reorder checkout before file plane**: doesn't fix the misjudgment.
- **Pending-retry parity promotion**: cannot bootstrap the first move
  (projected identity includes HEAD); observation-not-authority applies.

### Safety analysis (post-fix; each claim tested in the matrix below)

- Follower tip with a genuinely receiver-only commit: no incoming ref
  equals it; not an ancestor of any root → still defers.
- Follower ahead of its own branch's incoming value: the self-root is not
  admitted (equality fails). Binding expectations are root-set-wide
  (FINAL-3): if the ahead tip is unreachable from every admissible root →
  `local-commits` defer; if it is an ancestor of some OTHER admissible
  durable root it is sender-known → owned (and may follow if the other
  gates pass) — authorized by that root, not by the new self-root.
- Detached receiver HEAD: eligible only under the same exact-equality rule;
  no displacement-pin path is needed because the witness reservation, not
  the current-branch transition, carries durability (the R1A-1
  detached-receiver adversary is excluded because held/filtered values are
  never eligible).
- Non-commit tags: never admitted (peel check) — no new `unreadable`/
  `missing-object` deferrals.
- Local writer races the boundary: reservation aborts → fail-closed.
- Second machine publishes mid-apply: unchanged behavior — B may apply the
  older closed snapshot then converge on the next pull (R1A audit: no
  receiver-only-commit hazard; no latest-head revalidation is introduced).
- Mixed versions: read-side only; unfixed followers keep the
  over-conservative behavior. No wire/schema/state change.

## Tests the implementation MUST provide (r1 matrix, binding)

Rig (`git-ff` scenario, upgraded):
1. Switch-back follows within an ASSERTED ≤ 2 cycles (cycle budget is an
   assertion, not a loop bound — R1A-6/R1B-4).
2. After follow: persisted record's BASE HEAD/refs equal the incoming
   section; `pending` absent; apply deferral absent; `partial` null/absent;
   then ONE idle cycle proves no re-park (R1B-4).
3. `RBOX_GIT_FOLLOW=0` containment semantics, pinned by rig run (2026-07-19,
   corrects R1A-5's model): the flag routes STEADY receivers around the
   design-116 follow pipeline — and therefore around the self-root witness
   logic entirely — into the legacy direct-apply path, which also converges
   (B still lands on the incoming HEAD with a clean tree; safe refs publish;
   record settles). The kill switch's value is removing 165's new code from
   the decision path, not freezing the receiver's checkout.

Unit/behavior (extract a pure checkout-root/eligibility constructor, or
test through `followDivergedRepo` — `checkoutRoots` is currently local and
`classifyCheckout` private, R1B-5):
4. Exact unchanged-current-tip success with a locked witness.
5. Current tip ahead of its own incoming branch value, both graph shapes
   (FINAL-3 binding): (a) tip unreachable from every admissible root →
   `local-commits` defer; (b) tip an ancestor of another admissible durable
   root → owned, checkout may proceed via that root (assert the self-root
   was not the authorizer).
6. Witness ref deleted/moved between first proof and boundary: checkout
   aborts, section stays pending, no ref orphaned.
7. Held, forced, receiver-equivalent, and scope-filtered incoming values:
   never eligible as witnesses. Sibling-owned refs (FINAL-4): only values
   whose publication was HELD are excluded by the eligibility rule; an
   already-equal sibling-owned ref that the ref plane deliberately no-ops
   remains an ordinary checkout root exactly as today — the test pins that
   narrower rule, not a blanket exclusion.
8. Tags of every kind (annotated commit tag, lightweight tag, non-commit
   tag) and stash: never eligible as witnesses (branch-only rule, FINAL-1).
   Pre-existing behavior where a durable non-commit tag root poisons the
   whole ownership proof (`reachability.ts:87-116` peels all roots first)
   is OUT OF SCOPE for 165 — unchanged, noted as a separate papercut
   (FINAL-2).
9. Scoped incoming section (only HEAD's branch captured): behavior
   unchanged; absent refs are not deletions.
10. Detached receiver HEAD and detached incoming HEAD cases: detached
    incoming oid is already a root (`reachability.ts:52-59`); detached
    receiver follows only under exact equality with a reserved witness.
11. All-scope deletion of the checked-out branch with and without another
    durable ref containing its tip (existing behavior pinned).
12. A newer remote publish after B fetched its snapshot: B follows the
    closed snapshot, then converges next pull (staleness is not authority).

Suites: `bun test src/cli/sync-git src/engine/git` + CI shards green.

## Non-goals

- The reflog gap observed in the rig run (B's HEAD reflog missing the
  pre-fast-forward entry) — separate papercut; recon found no reflog
  suppression in checkout-txn.
- Deferral UX/`rbox git resolve` changes.
- 163/SQLite interactions: none — 1.7.x-line code; the 2.0 port inherits
  the corrected predicate.

## Rollout

Ships default-on in the next 1.7.x release (founder priority: 165 releases
FIRST, ahead of the recovery-binary fix). Containment: the EXISTING kill
switch `RBOX_GIT_FOLLOW=0` (`src/cli/sync-git/shared.ts:52`, consulted at
`apply.ts:739/:896/:1147`) routes steady receivers through the legacy
direct-apply path, bypassing the follow pipeline and with it every line 165
adds — verified by rig: the legacy path also converges the switch-back, so
the flag is pure containment, not a behavior freeze (corrects R1A-5's
suppression model; v1's "no kill switch exists" claim was also wrong). It is
a per-process env switch: founder daemons receive it via the daemon
environment (`rbox stop`, export, `rbox start`), not remotely. Test 3 pins
these exact semantics. No new flag.
