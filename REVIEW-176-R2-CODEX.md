# REVIEW-176-R2-CODEX — serial confirmation review of design 176 v2

Scope was limited to checking the binding r1 fold, attacking only the new v2
contracts against the current code and designs 130/174, and an editorial sweep.
The intent/ordinary-push architecture itself is not re-litigated.

## Findings

1. **MAJOR — `docs/design/176-wedge-ux-keep-mine.md:40-45,58-59,153-155` — the intent write contradicts the promise and test that no sidecar changes before ACK.**

   The semantics say all sidecars remain untouched until the push is accepted
   and that keep-mine mutates rbox's belief only in the accepted-ACK transition,
   but confirmation necessarily writes `RESOLUTION-INTENT` before that push.
   Test 1 repeats the impossible requirement by requiring the intent write
   "without changing P or sidecars." This is contrary to the fold plan's
   explicit pre-push intent write, although the later ACK ordering itself landed
   correctly.

   Minimal fix: exclude `RESOLUTION-INTENT` from both blanket statements. Say
   that confirmation's only mutation is creating/replacing that sidecar; BASE,
   P, the pre-existing sidecars, and Git state remain unchanged until accepted
   ACK. Change test 1 to require every *other* sidecar to remain byte-identical.

2. **MAJOR — `docs/design/176-wedge-ux-keep-mine.md:52-55` — the supposedly complete token-binding list drops three inputs already bound by show-me.**

   The current `SnapshotIdentity` binds `stream`, `stateNonce`, and `repoGen` in
   addition to `incomingKey` and the Git observations
   (`src/cli/git-cmd.ts:105-116`). V2 adds C6's config/scope/identity inputs but
   omits those three existing fields from its exhaustive-sounding list. A
   lineage-bound stored intent covers stream/stateNonce after it is written, but
   it does not make an old confirmation token stale across a rebind or concurrent
   record generation change before the write. This is an incomplete fold of the
   ruling to bind the snapshot inputs *plus* C6's additions.

   Minimal fix: add `stream`, `stateNonce`, and `repoGen` explicitly (and name
   the "actual pending key" as `gitIncomingKey(P)` to avoid confusing it with
   the repo map key). Keep all existing show-me inputs and add, rather than
   replace them with, the new C6 inputs.

3. **MAJOR — `docs/design/176-wedge-ux-keep-mine.md:65-73` — the directional report does not define a closed, internally consistent lane predicate.**

   "Pending refs use the equal-or-descendant relation" includes tags and
   `refs/stash`, but the next sentence classifies stash as exact. Current v6 and
   design 174 use ancestry only for branches; tags and stash are exact
   (`src/cli/sync-git/pending-supersession.ts:171-187`; design 174:327-366).
   V2 also leaves HEAD, ref scope, op-state, and tags hidden inside "other exact
   lanes," so an implementation cannot prove that its report is exhaustive or
   that the intent authorizes exactly the final failures.

   Minimal fix: replace the open-ended prose with the closed lane list:
   branches = pending-to-candidate equal-or-descendant; tags and stash = exact;
   HEAD, ref scope, index presence/content, complete op-state map, and canonical
   config = exact directional comparisons. State explicitly whether tombstone
   fields are excluded because the normalizer carries them from P. Preserve the
   existing `subsumed | not-subsumed | indeterminate` result and fail-closed
   behavior.

4. **MAJOR — `docs/design/176-wedge-ux-keep-mine.md:40-41,62-70,80-83` — the advertised apply-deferral-without-P case has no execution arm.**

   The contract accepts "pending and/or apply deferral," and current resolver
   eligibility deliberately accepts `base + deferrals.apply` when `pending` is
   absent (`src/cli/status-view.ts:353-356`; `src/cli/git-cmd.ts:208-212`). But
   v2 executes only through "the pending arm" and defines the final report from
   pending to candidate. "A pending-absent lane is vacuous" addresses a missing
   member within P, not an absent P section. There is therefore no specified arm
   that captures, publishes, or consumes the intent for a supported input shape.

   Minimal fix: either (a) define an intent arm for P-absent/apply-deferral-only
   records, with a vacuous discard report and predecessor-bound deferral clear on
   ACK, or (b) narrow keep-mine eligibility to a real P and make the existing
   apply-deferral-only shape a typed `no-incoming` refusal. Add the chosen case to
   the lifecycle tests.

5. **MAJOR — `docs/design/176-wedge-ux-keep-mine.md:43-45,75-76,82-83,98-100` — mandatory preservation pins contradict "no ref mutation," and their safety ordering is unspecified.**

   Take-theirs-grade pins are real internal Git refs under
   `refs/rbox-local/keep/<oid>` plus an origin sidecar
   (`src/engine/git/keep-pins.ts:47-67`; design 130:715-739). Thus the unqualified
   "No ref mutation" and "Local refs ... remain untouched" promises conflict
   with the required preservation step. The text also never says whether pins
   must be durable before publication/ACK; creating them afterward leaves a
   crash window in which P has cleared but a locally reachable losing object is
   unpinned.

   Minimal fix: distinguish user-visible refs from rbox-internal keep refs.
   Require pin refs and their take-theirs-grade origin record to become durable,
   fail-closed, before publication can commit; a failed publication may leave
   harmless over-protection while intent and P remain intact. Update the
   pre-ACK failure assertion to permit only those idempotent internal pins.

6. **MAJOR — `docs/design/176-wedge-ux-keep-mine.md:143-148` — the held-skip fold states that independent composer failures remain blocking but gives no predicate that can preserve them.**

   Today apply collapses every pending composer result into the same synthetic
   blocker (`src/cli/sync-git/apply.ts:1312-1321`), while the composer already
   returns the typed independent reasons in `composedFollow.holds`
   (`src/cli/sync-git/base-composer.ts:443-515`). Neutralizing the synthetic
   blocker solely from `provenance:"composer"`, pending disposition, and
   allowlisted classification blockers also neutralizes a coexisting safe-ref,
   scope, wrong-class, or checkout-completeness failure. Merely asserting that
   foreign artifacts and veto gates remain blocking does not specify how.

   Minimal fix: make the predicate inspect `composedFollow.holds` and
   `checkoutComplete`: neutralize only the synthetic own-disposition blocker
   when there is no unmatched independent composer hold (or when every typed
   hold is explicitly mapped ref-for-ref to an allowlisted causal classifier).
   Persist unmatched holds as blocking typed blockers. Make the existing
   foreign-artifact/veto controls assert the stored blocker shape, not only the
   final skip count.

7. **MINOR — `docs/design/176-wedge-ux-keep-mine.md:125-132,171-173` — the grammar-freeze consumer inventory is not complete despite calling itself explicit.**

   The list covers the r1-named major suites, but current consumers also include
   the daemon-control Git-family prefix classifier
   (`src/cli/daemon-control.ts:587`) and the git-entanglement rig's direct
   `git deferred` grammar parse (`scripts/rig/scenarios/git-entanglement.ts:480-481`).
   Neither is named by the list or by test 5; "shared rig fixtures" does not pin
   the scenario-local regex. This is a small completeness miss in the binding
   ruling to enumerate and test every current consumer.

   Minimal fix: add daemon-control and git-entanglement to the consumer list and
   grammar-freeze test matrix. A terse pointer to the daemon deferral-collapse
   snapshot suite would also make the shared-line coverage unambiguous.

## Fold confirmation

Apart from the findings above, the remaining binding rulings landed: preliminary
versus final reporting, ACK-only clears and failure retention, existing
publisher-ack BASE authority, the two enumerated refusal shapes, removal of the
lockedProof claim, P-sourced tombstone retention, status-only deferral guidance,
the two-verb copy, the safety-floor rollout wording, the current-checkout
boundary, the non-opportunistic rig requirement, the field-validation condition,
and the mandated v2 status line.

Verdict: CHANGES-REQUIRED
REVIEW-COMPLETE
