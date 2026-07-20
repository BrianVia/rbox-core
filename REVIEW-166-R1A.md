# REVIEW-166-R1A — adversarial safety-model review

Verdict: **CHANGES-REQUIRED**

Reviewed against `3c8c9b818fb95ab37278bf08ce2764ead25211dc` (design 165
merged). The narrow graph fact behind 166 is correct: if `incoming[R]` is an
ancestor of `local[R]`, publishing `local[R]` does not drop commits reachable
from that incoming branch tip. That fact is not a proof for the whole Git
section or the file plane, however. The proposed seams either leave the exact
fixture parked on its other two active gates, or bypass gates that protect
concurrent index, operation-state, and working-file data. The proposed file
baseline also has direct silent-shadow and TOCTOU counterexamples.

## Findings

1. **BLOCKER — changing the two `local-commits` hold sites cannot produce the specified no-mutation outcome; the existing continuation rewinds the descendant, and the exact fixture still has `local-edits` and `local-index` gates.**

   The existing successful Docker reproduction is
   `scripts/rig/runs/20260719-210335-git-join-ahead`. Its log reports all three
   active failures, not only the one design 166 changes:

   ```text
   git-sync deferred repo: working tree differs from applied manifest;
   index differs from both base and incoming;
   current tip has receiver-only commits
   ```

   (`run.log:84`; the report also shows B's tracked path reverted and the fleet
   failing to advance, `report.md:30-44`). This follows directly from
   `classifyCheckout`: the applied-manifest oracle contributes `local-edits`,
   the live index unequal to both the absent BASE index and older incoming index
   contributes `local-index`, and only then does tip ownership contribute
   `local-commits` (`src/cli/sync-git/follow.ts:408-488`). The file-plane change
   proposed in C keeps B-only paths in the post-action expected manifest, while
   `oracleFromPull` still compares that expected manifest with the incoming
   manifest (`src/engine/apply-receipt.ts:715-755`), so an extra committed
   `b-only.txt` remains an oracle mismatch unless the oracle contract also
   changes. No such change is specified.

   Worse, if an implementation merely suppresses `local-commits`, the current
   continuation treats `oldOid != newOid` as a branch transition. For the
   current branch it prepares and commits `local-descendant -> incoming-ancestor`
   (`follow.ts:1085-1130,1233-1248`); for a non-current branch the analogous
   path is `follow.ts:829-901`. That is the rewind design 166 expressly forbids.

   This also disproves the safety-analysis claim that a no-baseline B-behind
   join already takes an unchanged “ordinary forward application.” A clean old
   index is unequal to the absent BASE and newer incoming index, and changed
   tracked bytes conflict from an empty file BASE. The same `local-index` and
   potentially `local-edits` gates park it. Test 5 therefore requires another
   mechanism that the design does not describe.

   Specify an explicit whole-repo `forward-carry` disposition before either
   transition planner runs. It must define which checkout/index/oracle gates
   are discharged and why; simply reversing the ancestry query at the cited
   hold sites is neither sufficient nor safe.

2. **BLOCKER — commit ancestry does not order the index, operation state, or working state, so “publishing the descendant drops nothing” is false for a `GitSection`.**

   A captured section is not just refs and history. It contains the raw index
   artifact, `indexTree`, and operation-state artifacts
   (`src/engine/git/capture.ts:207-234,276-297`; `src/engine/types.ts:77-116`).
   Git identity deliberately includes HEAD, refs, index tree, and op-state
   (`src/engine/git/identity.ts:87-100`). In contrast, the cited
   `noDropProof` proves reachability only for protected commit tips from durable
   refs/pins (`src/engine/git/reachability.ts:208-237`). It says nothing about
   these other section members.

   Concrete interleaving:

   - A and B share `main=C0`; B commits `C1,C2`, so `C0 <= C2`.
   - Before publishing, A stages an edit at `C0` and/or starts a merge/rebase,
     leaving an incoming index/op-state that B has never observed. A's branch
     ref can remain `C0`.
   - The proposed ref predicate declares B forward-carry.
   - If existing classification remains binding, B parks on `local-index` (and
     possibly `local-operation`/`local-edits`), so 166 fails its goal. If the
     new disposition bypasses checkout because B is “already the future,” A's
     index and in-progress operation are never applied; advancing BASE and
     capturing B publishes their absence/replacement.

   The commit graph cannot decide which concurrent non-commit state wins. A
   safe design needs an explicit matrix for local and incoming index cleanliness
   relative to their respective HEADs, op-state equality/absence, and working
   bytes. A conservative initial contract could require both sides' index to
   equal their own HEAD tree and op-state to be absent, while handling working
   files independently. The current “exact predicate from A” is ref-only and is
   not enough.

3. **BLOCKER — treating the incoming manifest as BASE for every path inside the repo silently shadows sender-only untracked files and turns their absence on B into a later deletion.**

   “Inside a Git repo” is not “ordered by this branch ancestry.” File sync
   includes untracked files. Consider A's incoming manifest containing
   `repo/a-only.txt`, untracked by Git, while B has the descendant branch but
   does not have that file. With the real empty BASE, reconcile emits a write.
   With `base=incoming`, `remote == base`, so line 66 classifies the absence as
   “local ahead” and emits no action (`src/engine/reconcile.ts:58-74`). A pure
   probe against the real function produced:

   ```text
   ordinary(empty base) -> [write repo/a-only.txt]
   adopt baseline       -> []
   ```

   Pull then persists the remote global manifest as the file BASE even if the
   Git repo later defers (`src/cli/sync/pull.ts:253-285`). On B's next push the
   still-absent file is a deletion relative to that BASE. The pull-side
   mass-delete guard sees zero planned deletes, and the push-side guard has a
   default absolute floor of 1,000 (`src/cli/sync/policy.ts:17-34`), so one or
   hundreds of A-only files can be removed without either breaker firing. This
   directly refutes design lines 128-131 (“no deletions introduced”).

   The same construction with different A/B untracked bytes suppresses the
   conflict sibling and silently chooses B. Restricting the waiver to paths
   proven tracked is necessary but not by itself sufficient: sparse/skip-worktree
   state and concurrent staged/working edits still need the matrix in Finding 2.
   Remote-only and untracked paths must retain ordinary no-baseline reconcile
   semantics.

4. **HIGH — the claimed file-plane TOCTOU fallback cannot occur with the stated ordering.**

   Reconcile computes all actions once (`src/cli/sync/pull.ts:165`), file actions
   execute at `:202-209`, and only afterward does Git recompute its verdict at
   `:257-267`. If the pre-probe chose `base=incoming`, a differing or absent
   local path commonly produced *no action*. A later Git disagreement cannot
   retroactively create a conflict sibling. `applyActions`' `expectedLocal`
   guards only detect a change to a file for an action that already exists
   (`src/engine/apply.ts:66-72,235-270,403-426`); changing a Git ref does not
   trigger them, and a no-action path has no guard at all.

   Concrete race: the probe sees `incoming main=C0 <= local main=C2`; before Git
   apply, a local writer moves `main` to unrelated `D`. File bytes remain
   unchanged. The forward-biased no-actions have already landed, Git correctly
   parks, and the remote manifest is still saved as the file BASE. No sibling is
   created; the next push can publish B's bytes/deletions independently of the
   pending Git section.

   Test 9's requested “TOCTOU disagreement -> conservative fallback” is
   impossible under the proposed one-shot plan. The design needs a transactional
   bridge: for example, hold all required Git observations through file apply,
   or re-run/re-apply ordinary reconciliation and rebuild the oracle before
   saving whenever the boundary verdict differs. The exact boundary and crash
   recovery contract must be specified.

5. **HIGH — “paths inside a forward-carry repo” has no safe ownership rule for root and nested repositories.**

   Nested repositories are a supported, deliberate shape: discovery does not
   stop at a repo boundary (`src/engine/git-discover.ts:15-27`), the tests cover
   `.` plus nested repos (`src/engine/git-nested.test.ts:78-97`), and manifest
   validation permits nested Git keys (`src/engine/manifest-validate.ts:102-129`).
   Therefore `outer/inner/file` may be inside two independently sectioned repos.

   If `outer` forward-carries while `outer/inner` is divergent, the literal
   “inside a repo whose verdict is forward-carry” rule lets the outer verdict
   suppress the conflict semantics required by the inner repo. The root repo
   key `.` is worse: it contains every workspace path, including plain and
   untracked files, so a forward root repo would make the design's “plain files
   unchanged” promise false.

   Define a most-specific-repo ownership rule. A non-forward/unknown nested
   repo must veto every ancestor repo for its subtree, and untracked/plain paths
   must not inherit ancestry merely because some containing repo is forward.
   Add root-forward+nested-diverged, outer-forward+inner-behind, and nested-forward+
   outer-diverged tests.

6. **HIGH — the all-or-nothing ref predicate is not defined over the states the real ref plane handles: incoming-only refs, local-only refs/deletions, scoped omissions, tags, and stash.**

   The design quantifies over “ANY effective incoming ref,” but the current
   candidate universe is the union of incoming refs plus live/BASE refs when an
   all-scope section encodes absence as deletion
   (`src/cli/sync-git/follow.ts:526-532,626-630`). A literal implementation has
   no consistent answer for:

   - an incoming-only branch/tag: there is no receiver value for the ancestry
     comparison, although the existing ref plane can safely create it;
   - a local-only ref under incoming `refScope=all`: it is not an effective
     incoming ref, but its omission is a deletion that must not be ignored and
     resurrected by B's subsequent all-scope capture;
   - the same omission under `refScope=scoped`: it is explicitly *not* a
     deletion and must not veto forward-carry;
   - tags and `refs/stash`: they are syncable effective refs, but design 165's
     witness is branch-only (`selectCheckoutSelfRootWitness`,
     `follow.ts:543-565`), and stash additionally protects its complete reflog
     (`reachability.ts:240-245`). Commit ancestry is not a “forward tag” or
     “forward stash stack” semantic;
   - two ahead branches at distinct tips: the stated requirement that the live
     current tip equal the durable witness value can authorize only the current
     branch, while design 166 also cites the non-current per-ref hold site and
     says all refs qualify.

   Example liveness failure: B's current `main` is ahead, while A adds an
   incoming-only `topic` branch. Literal all-or-nothing parks a safe combination
   of “keep main, create topic.” If the probe instead observes after applying
   `topic`, it is no longer the same read-only pre-file predicate. Example safety
   failure: incoming all-scope omits B's local `old` branch; ignoring it lets the
   next capture shadow the incoming deletion. Leaving today's hold in place is
   safe but contradicts the promised no-pending outcome.

   Specify a disposition matrix over the union of names, with ref class, scope,
   equality/ahead/behind/diverged, incoming-only/local-only, hold/ownership,
   and tombstone state. “All-or-nothing” can remain the final repo result, but it
   cannot replace those per-ref semantics.

7. **HIGH — one reserved checkout witness is not a repo-wide boundary proof, and the current BASE composer cannot advance to incoming without a transition witness.**

   Design 165's witness protects one exact value used to authorize checkout.
   Design 166 proposes preserving potentially many descendant refs while BASE
   advances to their incoming ancestors. A local writer can move an unreserved
   non-current forward-carried ref after the repo-wide recheck but before the
   boundary commits. `commitCheckout` only excludes such writers for refs
   explicitly listed in `refReservations` (`src/engine/git/checkout-txn.ts:597-608`).
   Reserving R for the current checkout does not protect every other value on
   which the all-or-nothing verdict depends. The boundary test in design line
   159 covers only “the reserved witness,” so the receiver-local-writer claim is
   not established.

   There is also no authority for the stated BASE update. On a first join,
   previous branch BASE is absent and candidate BASE contains the incoming
   ancestor. `composeRepoBase` requires a matching locked branch-transition
   witness whenever those values differ (`src/cli/sync-git/base-composer.ts:320-441`);
   absent that proof it selects the previous family and returns `pending`
   (`:494-515`). A reservation proving the live ref is a *descendant* is not one
   of the current authority shapes. Marking the incoming value as an ordinary
   applied terminal would be false because the physical ref deliberately remains
   at the descendant.

   Define a distinct forward-carry BASE authority/locked-proof shape, prove the
   exact incoming-to-live ancestry at the boundary, and reserve every ref whose
   live descendant is retained until the intended record is committed. Also
   define crash recovery and post-boundary local-write semantics. Without this,
   implementation either rewinds, forges an applied-ref receipt, or remains
   pending.

8. **MEDIUM — the mandatory tests omit the counterexamples above and one stated positive test is based on a false current-behavior premise.**

   In addition to design tests 1-10, require:

   - exact rig shape proving `local-edits`, `local-index`, and `local-commits`
     are all intentionally discharged, with a clean index versus B's HEAD;
   - incoming staged change and incoming merge/rebase op-state while B's branch
     is ahead;
   - A-only untracked file, B-only untracked file, same-name differing untracked
     files, and local absence of an A-only file;
   - incoming-only branch/tag, local-only ref under all versus scoped sections,
     changed tag, local and incoming stash plus stash-reflog entries;
   - two forward-carried branches with a race on the non-current one;
   - root/nested repo combinations from Finding 5;
   - Git mutation after the file probe, after file apply, and at the checkout
     boundary, asserting actual conflict siblings and file BASE—not merely a Git
     deferral;
   - B-behind with changed tracked content and no prior BASE. The design cannot
     label this “ordinary unchanged behavior”; it must prove the new mechanism
     that avoids empty-BASE file conflicts and `local-index`.

## Safety-claim audit

- **B behind:** not verified; false for the stated no-baseline non-empty shape
  under current code, for the reasons in Finding 1.
- **True divergence / unrelated history:** the ancestry direction itself is
  sound and fails closed. This remains true only if containing/nested repo
  verdicts cannot override the affected paths.
- **Receiver-local boundary race:** not proven. The one exact witness is covered
  by design 165, but other carried refs and all prior file decisions are not
  (Findings 4 and 7).
- **Mass-delete / no-drop:** false as stated. Ref reachability can be a superset
  while index/op-state/untracked data is shadowed, and `base=incoming` can
  manufacture later file deletions below the push breaker's floor.
- **Second-machine publish race:** verified. Commit uses the applied sequence as
  CAS parent; a 409 returns `pull-first`, performs pull, then re-scans before
  retry (`src/cli/sync/push.ts:98-108,275-301,636-654`). The targeted existing
  409 test passed. This does not repair the local probe-to-Git TOCTOU.
- **Mixed versions / wire format:** format compatibility is credible: a
  successful capture is an ordinary `GitSection`, and an old receiver can apply
  a genuinely forward branch. The stronger “ordinary forward advance” claim is
  conditional on fixing the full ref/non-ref/path matrix; it is not established
  by branch-tip ancestry alone.
- **Kill switch:** `RBOX_GIT_FOLLOW=0` can contain the Git change as stated, but
  C must explicitly consult the same live gate before any altered file action;
  otherwise disabling follow after the probe does not undo those actions.

## Validation record

- The worktree already contains a complete Docker reproduction at
  `scripts/rig/runs/20260719-210335-git-join-ahead`; it failed exactly as quoted
  above. A fresh invocation during this review was blocked before scenario
  execution by permission denial on `/var/run/docker.sock`.
- Targeted merged-code tests passed: three follow safety tests
  (`local-ahead`, `local-index`, `local-operation`) and three tests covering 409
  pull/rescan, nested discovery, and root-repo sync.
- A pure call to the real `reconcile` function reproduced the remote-only-file
  counterexample in Finding 3.

The branch ancestry predicate is suitable as one component of a forward-carry
proof. It is not yet a safety proof for the unit design 166 proposes to advance
and publish. **CHANGES-REQUIRED.**
