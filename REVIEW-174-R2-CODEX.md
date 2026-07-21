# 174 round-2 serial confirmation review (Codex)

Scope was limited to the binding r1 fold, the text newly introduced in v2, and the requested editorial sweep. The seeding retraction, E deletion/non-goal move, exclusive timing accounting, D scheduling/cache rules, tombstone retention source, failure-carry rule, multi-writer wording, fleet-evidence qualification, and corrected connectivity/recovery anchors all landed as ruled. The exceptions and fresh v2 defects are below.

## Findings

1. **BLOCKER — the folded “complete blocker set” still has no seam for composer/orchestration blockers, and the skip predicate is vacuously true for an empty `FollowResult.blockers`.**

   Evidence: v2 declares the seam on `FollowResult` and says classification supplies the complete provenance-bearing set (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:203-210`), then authorizes a skip when “every blocker” in that stored set is allowlisted (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:244-250`). In the current flow, however, `FollowResult` is produced before the BASE composer runs (`src/cli/sync-git/follow.ts:136-139`; `src/cli/sync-git/apply.ts:1133-1158`), and the composer can independently return `pending`, causing an `artifact` deferral even when `follow.heldRefs` is empty (`src/cli/sync-git/apply.ts:1207-1222`). Protocol/artifact holds can also terminate in orchestration before follow (`src/cli/sync-git/apply.ts:948-956`). Thus `FollowResult.blockers` cannot by itself be the complete ref-plane + checkout + boundary + journal/protocol + composer set accepted under C3. With no explicit non-empty requirement, a composer-only pending outcome would also satisfy `every blocker ∈ allowlist` vacuously.

   Minimal fix: define `TypedBlocker` as a closed provenance-bearing union across classification and orchestration, merge composer/protocol disposition into the final attempt outcome in `apply.ts`, and require `blockers.length > 0 && blockers.every(allowlisted)`. Add the two missing C3 adversaries: `local-stash + worktree-ownership` and held-ref/composer-pending (including a composer-only pending case).

2. **BLOCKER — the new final-candidate fast-forward proof can be laundered by local replace refs that are not part of the candidate.**

   Evidence: v2 makes equal-or-fast-forward ancestry against candidate `C` publication authority and forbids ancestry laundering (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:310-325`). Git’s current graph helpers invoke `rev-parse`, `rev-list`, and `merge-base --is-ancestor` with only `GIT_NO_LAZY_FETCH=1` (`src/engine/git/reachability.ts:30-32,87-121`), so they honor `refs/replace/*`. Those refs are explicitly non-syncable and absent from a `GitSection` (`src/engine/manifest-validate.ts:261-265`), and the planned structural rejection names graft/shallow files but not replace refs (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:203-210`). A local replacement can therefore make unrelated `P.main` appear ancestral to `C.main`, while the published candidate carries neither that replacement nor the claimed graph relation.

   Minimal fix: define candidate ancestry over the literal object graph and run every peel/walk/ancestor subprocess with `GIT_NO_REPLACE_OBJECTS=1` (while retaining the structural graft rejection). Add a test where `refs/replace/*` makes an actually divergent pending tip appear ancestral; B must carry pending.

3. **MAJOR — the revised A tests still contradict the folded recovery/P-settlement placement.**

   Evidence: v2 correctly places A after journal recovery, follower-protocol/P settlement, and partial revalidation (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:238-243`), but test 2 still requires zero Git subprocesses for the repo (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:429-431`) and test 15 still states an unqualified composer call-count of zero (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:466-468`). Today the mandatory path reaches `gitPreflight`, constructs the journal binding, prepares the branch protocol, and reads refs before follow (`src/cli/sync-git/apply.ts:934-953`); preflight itself invokes Git (`src/engine/git/preflight.ts:73-83`). This is exactly the C4 test wording the r1 review warned could move A ahead of recovery.

   Minimal fix: make the assertions “zero fetch/decrypt/import/follow/ref-transaction work after the mandatory prepass” and “no BASE mutation by the final skip.” Explicitly allow prerequisite Git/composer calls and assert that journal recovery, protocol/P settlement, and partial revalidation ran first.

4. **MAJOR — the new journal disposition table and its test are not exhaustive over the code’s recovery union.**

   Evidence: §4.2 and test 11 enumerate allowed `none`, `rolled-back`, `landed-and-cleared`, and quarantined binding mismatch, plus blocked defer/corruption/human intervention (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:295-300,454-456`). The actual recovery union also has `fresh-quarantined` (`src/engine/git/journal.ts:89-96`), produced after a crashed created-fresh checkout is moved aside (`src/engine/git/journal.ts:349-360`); the current push prepass blocks capture for that result (`src/cli/sync-git/plan.ts:308-316`). Leaving it unclassified invites a non-exhaustive implementation or test switch at the new B gate.

   Minimal fix: state explicitly that `fresh-quarantined` blocks supersession/carries pending, and add it to test 11. Require an exhaustive `never` check over `JournalRecoveryResult.status` at the B gate.

5. **MAJOR — the revised tests do not actually pin all four ACK-gated sidecar clears or the retained-BASE rule.**

   Evidence: the mechanism requires pending absence, `partial=null`, `attempt=null`, an ordered apply-deferral clear, and retention of omitted BASE members/origins (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:328-336`). Test 1 says only “accepted ACK clear”; test 7 checks pending bytes on capture failure; and test 9 checks only pending + deferral on 409 (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:422-449`). None would catch early clearing of `partial` or the new `attempt`, a non-predecessor-bound deferral clear, or accidental loss of an omitted BASE/origin anchor.

   Minimal fix: extend the positive ACK test to assert exact clearing of pending/partial/attempt and only the predecessor-bound apply episode, while an omitted prior branch and origin remain. Table-test each named pre-ACK failure class (at least capture, upload, 422, commit error, and 409) for byte-identical pending/partial/attempt/deferral state.

6. **MINOR — “atomically with acceptance” overstates the existing ACK boundary.**

   Evidence: v2 says B clears sidecars “atomically with acceptance” (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:191-199`). The server commit returns accepted first (`src/cli/sync/push.ts:642-671`); only afterward does the client compose and save the publisher-ACK state (`src/cli/sync/push.ts:680-738`). A crash in that interval safely leaves the old local sidecars, but remote acceptance and local clearing are not one atomic transaction.

   Minimal fix: say “only after an accepted commit, in the generation-CAS publisher-ACK state transition”; document that an accepted-commit/state-save crash leaves sidecars intact for ordinary recovery.

7. **MINOR — editorial drift remains after deleting E.**

   Evidence: the mechanism jumps from §4.4 to §4.6 (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:391-418`), and the now-binding v2 still labels its non-goals “v0, to be ratified” (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:160-166`). The reviewed code anchors for the connectivity proof, pending carry, and plan recovery preamble otherwise match current code, and no dropped r1 tag was found outside the substantive findings above.

   Minimal fix: renumber F to §4.5 and remove “v0, to be ratified.”

Verdict: CHANGES-REQUIRED
REVIEW-COMPLETE
