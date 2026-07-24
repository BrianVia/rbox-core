# Adversarial design review — 174, round 1 (Codex)

The proposed changes are not safe to implement as written. The held-skip key omits inputs that directly control the two allowlisted reasons, pending supersession is neither failure-atomic nor exhaustive over the wire section, and the watcher premise for scan reuse is explicitly contradicted by designs 172/175 and the current daemon. The one-writer wedge is real once a pending section exists, but the document's claimed schema-bump/commit-during-push seed is not the transition the code implements.

## Findings

1. **BLOCKER — `local-stash` and some `local-commits` outcomes are not covered by `gitFingerprint`; an unchanged-key unblock exists.**

   Evidence: §4.1 says ownership inputs over refs/reflogs are fully covered and that any stash/ref mutation invalidates the attempt (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:196-218`). In fact, `classifyCheckout` enumerates every old and new OID in the stash reflog and makes any unowned entry a `local-stash` blocker (`src/cli/sync-git/follow.ts:462-471`); the enumerator reads `<commonDir>/logs/refs/stash` bytes (`src/engine/git/shared.ts:262-276`). Checkout-boundary proof also turns a branch-reflog fingerprint change into `local-commits` (`src/cli/sync-git/follow.ts:1350-1355`). `gitFingerprint` covers shallow, alternates, config, worktrees, `gc.pid`, packed refs, loose refs, HEAD, index, locks, and op-state, but no `logs/**` path (`src/cli/sync-git/fingerprint.ts:204-226,268-297`).

   Concrete unchanged-fingerprint unblock: let `refs/stash` still point to `N` while an older stash-reflog entry `S` is receiver-only. Dropping/expiring only `S` removes the `local-stash` blocker while every fingerprint input and the incoming key remain unchanged. A branch-reflog-only boundary race has the same shape. The proposed skip can therefore suppress a follow that would now succeed for up to an hour.

   Fix direction: include exact, reason-specific reflog digests in the attempt key (the complete stash log and every branch log that contributed to classification), or extend the fingerprint schema to those exact logs. Persist an attempt only from a stable before/after observation, and add reflog truncation, entry deletion, and same-tip append tests.

2. **BLOCKER — ancestry itself can change without a fingerprint change.**

   Evidence: current-tip `local-commits` is decided by `tipOwnedByIncoming` (`src/cli/sync-git/follow.ts:450-459`), whose oracle peels objects and executes `git merge-base --is-ancestor` (`src/engine/git/reachability.ts:87-121`). `gitFingerprint` does not include `<commonDir>/info/grafts` (`src/cli/sync-git/fingerprint.ts:204-226`), and preflight does not reject grafts (`src/engine/git/preflight.ts:73-101`). A local Git reproduction confirmed that adding an `info/grafts` parent line can change an unrelated local tip from unowned to owned while `gitFingerprint` stays byte-for-byte identical.

   Object availability is another uncovered input: an indeterminate preservation proof is mapped to a held `local-commits`/`local-stash` ref (`src/cli/sync-git/follow.ts:653-670,845-848`), while restoring/removing the relevant object changes only `objects/**`, also absent from the fingerprint. `GIT_NO_LAZY_FETCH` prevents a proof from silently fetching; it does not make object presence a fingerprint input (`src/engine/git/reachability.ts:30-32,87-121`).

   Fix direction: reject legacy grafts structurally (the simplest policy), or fingerprint and define them explicitly. Never encode an indeterminate graph/preservation result as only an allowlisted local-work reason; retain an `unreadable`/indeterminate blocker in the complete blocker set. Add ancestry-flip and object-disappear/restore tests.

3. **BLOCKER — the proposed `attempt.reasons[]` cannot be populated safely from the current APIs; a non-allowlisted blocker can be hidden.**

   Evidence: `classifyCheckout` accumulates a set but immediately collapses it through a precedence list (`src/cli/sync-git/follow.ts:384-390,405-410,501-504`), and `FollowResult` exports one singular `reason` (`src/cli/sync-git/follow.ts:136-139`). `local-commits` and `local-stash` precede `unreadable`, so an unowned tip plus an unreadable stash proof can report only `local-commits`. The mixed followed path separately collapses all held refs to one reason (`src/cli/sync-git/apply.ts:644-648`) and lets a held-ref reason mask a simultaneous composer/artifact pending disposition (`src/cli/sync-git/apply.ts:1219-1222`).

   A naïve implementation that records the returned reason will satisfy §4.1's allowlist even though a working-tree, ownership, unreadable, boundary-race, or artifact veto coexisted. Conversely, the document provides no seam from which to obtain the promised complete array.

   Fix direction: make classification and orchestration return a complete typed blocker set, including source/provenance for ref-plane, checkout, boundary, journal, and composer blockers. Permit A only when *every* blocker is stable ownership work, not merely when the highest-precedence display reason is allowlisted. Test at least `local-commits + unreadable`, `local-stash + worktree-ownership`, and held-ref + composer-pending combinations.

4. **BLOCKER — A lacks the stable-observation, state binding, and recovery ordering that make a skip safe under design 130.**

   Evidence: the divergence cache is not proof that a lone fingerprint read is safe. It brackets the expensive probe with before/after fingerprints, clears common-dir memoization, writes only a stable observation, and later applies a racy-clean age test (`src/cli/sync-git/divergence-cache.ts:111-113,278-318`). §4.1 specifies only the fingerprint "at attempt time" (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:184-205`). A follow itself mutates refs, reflogs, artifacts, and journals before returning.

   More importantly, the outcome also depends on local state outside the two keys. A recorded partial can force `local-commits` after exact revalidation fails (`src/cli/sync-git/apply.ts:798-815`), and tombstone authorization depends on logical BASE/origins/artifacts (`src/cli/sync-git/follow.ts:676-692`). Apply intentionally performs journal recovery first (`src/cli/sync-git/apply.ts:515-569`) and exact follower-protocol/P settlement before follow (`src/cli/sync-git/apply.ts:948-1064`); design 130 makes a standing P block use of serialized BASE until exact settlement/repair (`docs/design/130-follower-branch-hygiene.md:601-621,1135-1143`).

   A crash after an old attempt was stored but after a later retry wrote a journal can leave both user-facing keys unchanged. If A is placed before recovery—as test 2's "zero git subprocesses" wording could encourage—the next pull skips the mandatory journal/P work. A BASE/origin/partial transition can likewise make a formerly held retry productive without changing local Git bytes.

   Fix direction: normatively place A after journal recovery, branch-protocol preparation, and exact P/P-repair settlement. Any such transition invalidates/recomputes the attempt. Bind the record to the exact repo generation/identity, logical BASE and origins, partial/artifact disposition, incoming key, and a stable pre/post fingerprint bracket; fail open on any race. "Composer call-count zero" should apply only to the final no-op skip, not its recovery prerequisites.

5. **BLOCKER — B clears pending before a best-effort capture, so a one-writer push can replace `P` with older BASE without any 409.**

   Evidence: the design orders deletion of pending/sidecars before the repo enters the capture pool (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:264-275`). Capture can return nothing or throw (`src/cli/sync-git/plan.ts:798-813`); its failure path carries `base[rel]`, not `P` (`src/cli/sync-git/plan.ts:432-440`). Today's early pending arm is precisely what publishes `P` and avoids capture (`src/cli/sync-git/plan.ts:622-632`).

   Concrete trace: durable BASE=`B`, pending and current remote=`P`, and local=`L`; the probe proves `P ⊆ L`, deletes pending, then capture/config/preflight fails. `deferOne` emits `B`. With no concurrent writer, the commit's parent is still the current sequence, so the server accepts `P → B`; the remote CAS has no reason to return 409 (`src/cli/sync/push.ts:642-660`).

   Fix direction: stage supersession. Keep `P` and all sidecars until a fresh candidate is captured, normalized, and revalidated. On any preflight, config, capture, upload, missing-blob/422, or commit failure, carry `P` byte-for-byte. Clear pending only in the accepted/no-op state transition associated with a validated candidate. Add fault injection at every named stage.

6. **BLOCKER — the supersession proof and the published capture observe different repository states.**

   Evidence: per-repo probes happen in the planning loop (`src/cli/sync-git/plan.ts:602-725`), but capture runs later in a concurrency pool (`src/cli/sync-git/plan.ts:779-823`). Capture independently stages index/op-state, rereads HEAD and refs, and creates the bundle (`src/engine/git/capture.ts:207-254`). No ref lock or post-capture subsumption proof spans those phases.

   A branch can prove `P.main` is an ancestor of local `main`, then be reset or deleted before capture. The final section can omit the very OID used to clear `P`. Parent-sequence CAS protects against another *remote publisher*, not a local Git mutation between proof and capture.

   Fix direction: make the final captured/normalized candidate the proof subject. Recheck every P lane against that exact candidate immediately before publication, with a stable before/after bracket; on mismatch or indeterminate evidence, discard the candidate and carry P. Do not treat a pre-capture live-repo proof as publication authority.

7. **BLOCKER — §4.2's lane proof is not information-preserving for stash, op-state, HEAD, scope, index, or config.**

   Evidence by lane:

   - **Stash:** §4.2 accepts a pending stash OID found anywhere in the local stash reflog or branches (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:243-247`). Capture serializes only the current `refs/stash`; it does not serialize the reflog stack, and the bundle roots only the current stash plus ordinary capture pins (`src/engine/git/capture.ts:161-175,224-245`). If `P.stash=S`, local `refs/stash=N`, and `S` is merely a reflog entry, fresh capture changes stash semantics and may omit `S` from the bundle entirely.
   - **Op-state:** `GitSection.opState` is exact path→artifact data (`src/engine/types.ts:107-108`), and current follow compares exact plaintext identities (`src/cli/sync-git/shared.ts:102-104`; `src/cli/sync-git/follow.ts:435-446`). Candidate extraction only searches selected paths for 40-hex substrings (`src/engine/git/reachability.ts:39-46`). `MERGE_MSG`, sequencer instructions, and other meaningful bytes can have no candidates, so the proposed ownership check passes vacuously even though fresh capture deletes/replaces the whole operation (`src/engine/git/refs.ts:48-77`).
   - **HEAD/scope:** §4.2 only asks that a symbolic `P.head` branch exist (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:248-251`). `P.head=main` and local HEAD=`feature` therefore passes despite changing checkout intent. Detached P HEAD is unspecified. `refScope` is omitted entirely, although both fields affect receiver behavior and `gitIncomingKey` (`src/engine/types.ts:88-116`; `src/cli/sync-git/shared.ts:82-99`).
   - **Index/config:** the sound index comparison is `indexIdentityV2`, not raw artifact identity (`src/cli/sync-git/follow.ts:417-432`). A pre-probe config equality is not the published result: capture may fall back to BASE/no config after ownership/read/size failure (`src/cli/sync-git/plan.ts:370-427`).

   Branch same-name FF/equality and exact tag equality are sound only against the final candidate. For conservative v1, require exact normalized-candidate equality for stash, HEAD (including detached), `refScope`, semantic index presence/projection, exact op-state path/SHA map, and canonical config. Any future weaker rule needs a lane-specific terminal proof and an object-inclusion proof.

8. **BLOCKER — clearing P drops P-only tombstone chains/high-water state and can regress another follower.**

   Evidence: fresh capture contains no tombstone fields (`src/engine/git/capture.ts:284-297`). Once pending is removed, outbound normalization merges only `RepoRecord.advertised` with the candidate (`src/cli/sync-git/publisher-tombstones.ts:54-85,168-188`). A pending value is byte-identically exempt only while it is still recognized as pending (`src/cli/sync-git/publisher-tombstones.ts:180-183`; `src/cli/sync-git/publisher-tombstones.test.ts:111-125`). Pull persistence does not update `advertised` (`src/cli/sync/pull.ts:272-300`); accepted push ACK does (`src/cli/sync/push.ts:684-725`), and omission retains the older advertised value (`src/cli/sync-state.ts:199-217`).

   Design 130 requires a retained chain so a follower paused at an older branch value can still prove supersession (`docs/design/130-follower-branch-hygiene.md:67-84`) and makes P the sole byte-identical normalization exemption (`docs/design/130-follower-branch-hygiene.md:104-122`). Example: A authors P with tombstone `R=Q`; slow C still has Q. B pulls P but holds for unrelated local-ahead `main`, so B has never advertised/ACKed P. B clears P and captures. Normalization has no source for P's `R=Q`, and C loses the attestation it needs. This is safe-direction authority loss, but it breaks fleet convergence and directly falsifies §4.2's claimed non-interaction (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:284-291`).

   Fix direction: make the validated P tombstone container an explicit retention source for the superseding normalization, including its high-water mark. Keep tombstone *authoring predecessor* semantics separate from inherited retention. Add a three-device test in which C depends on a chain present only in P.

9. **MAJOR — B's sidecar clears and "wholesale" BASE fold do not match the current state/composer APIs.**

   Evidence: accepted push ACK currently persists `bases`, `advertised`, `repoAbsent`, `pending`, `removed`, and `resolutions`, but not partial or deferral clears (`src/cli/sync/push.ts:718-734`). Missing `partial` preserves the current value; only explicit null clears it (`src/cli/sync-state.ts:226-231`). Deferrals change only through predecessor-bound ordered transitions (`src/cli/sync-state.ts:129-184`), and status renders any standing lane regardless of pending (`src/cli/sync-git/status.ts:53-70`). Thus deleting the planner's pending map alone leaves stale partial/apply/attempt state and its banner.

   The prose that post-commit fold advances BASE "wholesale" is also false under design 130 (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:270-272`). Publisher ACK cannot remove a previous branch and restores omitted prior refs (`src/cli/sync-git/base-composer.ts:320-347,494-506`); design 130 explicitly requires present advances while retaining omitted anchors (`docs/design/130-follower-branch-hygiene.md:908-919`).

   Fix direction: have planning return a staged superseded disposition. On an accepted/no-op candidate only, persist `pending` absence, `partial[rel]=null`, `attempt=null`, and an ordered apply-lane clear tied to its predecessor `lastSeen`. Continue through the existing `publisher-ack` composer arm; document exactly which BASE members/origins remain rather than claiming wholesale replacement. Never add a new BASE authority arm.

10. **MAJOR — the claimed reusable "absence-supersession quarantine-then-clear" journal primitive does not exist, and the requested behavior is unsafe.**

   Evidence: absence does not arbitrarily quarantine a standing journal. Every apply arm first executes ordinary journal recovery (`src/cli/sync-git/apply.ts:515-569`), and only afterward does remote absence clear pending/partial/deferrals (`src/cli/sync-git/apply.ts:587-630`). Published journals are landed into state and then deleted (`src/cli/sync-git/follow.ts:267-279`). Intent journals are rollback-arbitrated; only binding mismatch or human intervention is quarantined (`src/engine/git/journal.ts:303-347,364-472`). `retireJournal` is private (`src/engine/git/journal.ts:183-187`), while `clearFollowJournal` merely deletes (`src/cli/sync-git/follow.ts:295-298`). `quarantineUnboundFollowJournal` deliberately supplies an impossible binding only when no usable repo context exists (`src/cli/sync-git/follow.ts:282-292`).

   Push planning already runs recovery/landing before pending carry (`src/cli/sync-git/plan.ts:262-317`). Quarantining a valid intent journal without rollback can strand mutations/locks; quarantining a published journal without landing discards its state intent.

   Fix direction: specify that B proceeds only after the existing recovery prepass reaches a terminal none/rolled-back/landed-and-cleared/quarantined-binding-mismatch disposition. Recovery `defer`, corruption, or human-intervention blocks supersession. Remove the nonexistent absence-helper claim unless a new phase-aware, fsync-safe retirement protocol is designed and tested.

11. **BLOCKER — §4.5's watcher authority does not exist; designs 172/175 explicitly establish the opposite.**

   Evidence: design 172 records that Parcel silently discards Linux `IN_Q_OVERFLOW` and add-watch failures, that those failures cannot reach `onError`, and that a daemon can remain "trusted" after losing events (`docs/design/172-event-driven-git-capture.md:219-249`). Its contract therefore retains the safety scan as the healer (`docs/design/172-event-driven-git-capture.md:278-289`). Design 175 repeats that watcher/ref signaling is latency-only and keeps scan-backed correctness (`docs/design/175-git-ref-side-channel.md:13-25,276-299`). The actual watcher calls `onError` only when Parcel supplies an error (`src/cli/daemon/watcher.ts:331-340`), and the daemon changes health/error generation only in that callback (`src/cli/daemon/daemon.ts:610-624`). The code itself says safety scans heal dropped events (`src/cli/daemon/daemon.ts:762-770`).

   There is also a startup scan→watch-arm gap: startup scans before `startLiveWatch` (`src/cli/daemon/daemon.ts:534-563`). A "healthy watcher + current generation + no debounce" cannot prove that no file mutation was missed in either that gap or a silent overflow.

   Fix direction: remove the claim that 172/175 created local-manifest authority. Keep the pull scan unless 174 designs a real loss-detecting baseline protocol. A post-arm covering scan/session token is necessary but still insufficient against silent Linux overflow; affected pull actions need authoritative or targeted disk revalidation.

12. **BLOCKER — §4.5 reuses the wrong manifest, changing reconcile and mass-delete semantics even for delivered local edits.**

   Evidence: `lastSyncedManifest` is BASE, not current local truth. The daemon seeds `this.manifest` from BASE, then incrementally patches `this.manifest` from settled events (`src/cli/daemon/daemon.ts:925-929,1456-1483`); its local status explicitly diffs BASE against that current manifest (`src/cli/daemon/daemon.ts:1794-1806`). A delivered local edit followed by a failed push leaves no pending debounce but leaves `this.manifest != lastSyncedManifest`.

   `reconcile` requires three distinct inputs. A remote delete plus locally modified file produces no action (`src/engine/reconcile.ts:29-40,58-75`). Substituting BASE for local instead schedules a delete (`src/engine/reconcile.ts:60-63`). The apply precondition saves the bytes only by moving the now-mismatching file aside (`src/engine/apply.ts:403-426`), which is not the intended keep-in-place result. Worse, the mass-delete guard counts these false delete actions before apply (`src/cli/sync/pull.ts:165-178`) and can reject a pull the true local snapshot would accept.

   Fix direction: do not pass `lastSyncedManifest` as local. If E survives, pass an immutable current-local snapshot and bind it atomically to watcher session, error/event/rule generations, pending/deferred retry state, and the pull. Add delivered-edit + failed-push + remote-delete and mass-delete differential tests.

13. **MAJOR — E's eligibility is incomplete and it does not remove the daemon's per-pull walk as claimed.**

   Evidence: raw events set `watcherUnsettled` and increment a generation (`src/cli/daemon/daemon.ts:599-603,1723-1727`); settled events enter `pendingEvents`, while mid-write paths enter retry sets (`src/cli/daemon/daemon.ts:1456-1490`). `localSettled` requires both pending events and deferred retries to be empty (`src/cli/daemon/daemon.ts:1731-1741`), and ignore-rule events trigger a full rebuild/rescan (`src/cli/daemon/daemon.ts:1467-1474`). §4.5 names none of the watcher session, error/rule generations, retry sets, or a before/after snapshot bracket (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:320-331`). `maybeClearWatcherUnsettledAfterOp` treats every successful pull as refreshing local truth only because pull currently scans (`src/cli/daemon/daemon.ts:1744-1747`); that becomes false for a reused pull.

   Further, changing only `pull.ts:131-142` leaves the daemon's unconditional post-pull `replaceManifestFromScan` (`src/cli/daemon/daemon.ts:1614-1623`), which invokes `scanManifest` (`src/cli/daemon/daemon.ts:2231-2246`). The claimed 7.5s/4.6s saving and "removes the per-notify-pull full walk" are therefore not established.

   Fix direction: either drop E or define one immutable local-snapshot capability with complete session/generation/retry/rule fields and a post-operation bracket. A reused pull must not clear unsettled state merely because it was a pull. Specify the post-pull refresh too: retain a validated snapshot for zero actions, derive exact updates from apply receipts, or rescan. Test total scan invocation count, not only manifest equality.

14. **BLOCKER — the schema-bump and ordinary commit-during-push seeding story is factually inconsistent with the code.**

   Evidence: `GIT_FINGERPRINT_SCHEMA_VERSION` participates in the divergence-cache version (`src/cli/sync-git/fingerprint.ts:7-34`; `src/cli/sync-git/divergence-cache.ts:8-13`). A version mismatch merely empties that cache (`src/cli/sync-git/divergence-cache.ts:88-99`), after which the slow path reruns preflight/identity and still carries matching BASE (`src/cli/sync-git/divergence-cache.ts:254-273`; `src/cli/sync-git/plan.ts:535-588`). Design 175 explicitly made capture/bundle changes a non-goal (`docs/design/175-git-ref-side-channel.md:421-425`). Wire manifest schema is derived separately from the section/file shape (`src/cli/sync/push.ts:40-46`). Therefore fingerprint schema 4→5 did **not** by itself force a full Git-section republish as claimed at `docs/design/174-apply-side-perf-and-held-repo-livelock.md:34-38`.

   An ordinary local commit after capture also cannot make the *next pull* follow. After an accepted non-pending push, the committed section is folded into durable BASE before return (`src/cli/sync/push.ts:680-738`; `src/cli/sync-git/plan.ts:855-871`). The next pull sees remote==BASE and exits unchanged before classifying local divergence (`src/cli/sync-git/apply.ts:759-769`). The daemon serializes operations under the workspace mutex (`src/cli/daemon/daemon.ts:1140-1208`). The later commit is simply eligible for a later outbound capture.

   The wedge mechanism *after P exists* is correct: a held follow retains P (`src/cli/sync-git/apply.ts:1205-1232`) and push carries it (`src/cli/sync-git/plan.ts:622-632`). But the immediate follow after sequence 83 proves that pending/stale BASE already existed, the accepted state save failed/rolled back, or another writer advanced remote; the supplied timeline does not select among those. The stash can contribute a hold only after remote change has routed into follow (`src/cli/sync-git/follow.ts:462-472`).

   Fix direction: reconstruct the pre-83 RepoRecord/ACK outcome and document the actual reachable seed. Build the end-to-end test from a real transition (another writer, accepted-commit/state-save crash recovery, or another proven stale-BASE producer), not from the disproven schema-bump/ordinary-race narrative.

15. **MAJOR — A/B do not specify deferral observation and busy-retry semantics.**

   Evidence: A says a skip preserves the entire deferral (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:213-215`), but the deferral contract says `lastSeen` advances on retry (`docs/design/116-git-sync-correctness-and-visibility.md:773-778`), and `nextDeferral` implements that (`src/cli/sync-git/shared.ts:112-130`). `lastSeen` is also the predecessor clock for ordered set/clear merges (`src/cli/sync-state.ts:129-184`), not merely display data. A skipped pull that observed the same condition but leaves `lastSeen` stale changes that contract.

   B's pending probe must also integrate the busy episode. Current pending carry returns before the slow-path busy check (`src/cli/sync-git/plan.ts:605-632`), while daemon +2s/+8s retries are triggered solely from `gitPlan.captureDeferrals == git-busy` (`src/cli/sync/push.ts:406-410`; `src/cli/daemon/daemon.ts:871-905`). If the ref signal that scheduled the push is consumed while the B probe sees a lock, merely carrying P can strand retry until the safety scan.

   The visible age itself is sound: `ageBucket` is computed from `deferredSince` and current time (`src/cli/status-view.ts:253-264`), durable lines recompute it (`src/cli/daemon/daemon.ts:217-251`), and heartbeat rendering advances the banner without a state mutation (`src/cli/daemon/daemon.ts:1886-1911`). A's allowlist also excludes an existing apply `git-busy` reason. The missing pieces are the observation clock and B's push-busy retry seam.

   Fix direction: either refresh the same apply episode's `lastSeen` with an ordered sidecar-only update on A-skip, or redefine it as "last full classification" and add a separate last-checked/last-skipped clock. A forced hourly retry must refresh `attempt.at` on the same outcome. B must surface a busy probe as a capture busy observation while preserving P, so existing bounded retries are armed.

16. **MAJOR — C's ≥90% acceptance metric double-counts nested time and cannot establish attribution.**

   Evidence: the proposed `classifyMs` is total `classifyCheckout` time while `ownershipMs` covers the ownership calls inside it (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:293-303`; classification calls ownership at `src/cli/sync-git/follow.ts:450-468`). The checkout transaction's prepare+commit interval includes `secondProof` (`src/engine/git/checkout-txn.ts:652-672`), and that callback runs `classifyCheckout` again (`src/cli/sync-git/follow.ts:1233-1286`). `refTxnMs + classifyMs + ownershipMs + reflogMs` therefore overlap, possibly two or three times. A sum can exceed 90% while leaving a large exclusive wall interval dark.

   Fix direction: define a hierarchy and test exclusive accounting: parent phase timings may contain child timers, but the acceptance sum must use non-overlapping leaf durations plus an explicit residual. Alternatively report nested timers separately and require `repoWall - union(namedIntervals) <= 10%`. Include both first and boundary classifications and all ref-plane preservation work without summing parents and children.

17. **MAJOR — D's capped backlog will not drain "across pushes" at the stated hook, and each deletion invalidates the cache entry just written.**

   Evidence: D runs only "at the end of a successful capture" and claims 64 deletions per push drain the backlog (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:305-318`). But the planner writes the divergence-cache observation before adding the repo to `toCapture` (`src/cli/sync-git/plan.ts:545-562`), and actual capture happens later (`src/cli/sync-git/plan.ts:779-823`). Conflict refs are inside the fingerprinted `refs` tree (`src/cli/sync-git/fingerprint.ts:204-225`), so post-capture pruning immediately makes the cached fingerprint stale. On the next push the repo slow-probes, finds live identity equal to the just-published BASE, and carries instead of capturing (`src/cli/sync-git/plan.ts:579-588`); because no successful capture occurs, the next 64 are not pruned. The backlog drains only when unrelated repo changes cause later captures.

   The scratch/non-wire premise is otherwise correct: `refs/rbox-*` is not syncable (`src/engine/manifest-validate.ts:261-265`), capture explicitly excludes it from bundles (`src/engine/git/capture.ts:31,242-253`), and the timestamp segment is created from `Date.now()` (`src/engine/git/quarantine.ts:83-99`).

   Fix direction: make retention an independently bounded hygiene phase that can run after a stable probe/carry as well as capture, or explicitly schedule repeated hygiene pushes. Refresh/invalidate the divergence-cache entry after each deletion batch. Do not describe the repository as "already quiet" unless a real bracket/lock proves it; fail closed on reachability errors and race-check old OIDs in the delete transaction.

18. **EDITORIAL — scope and evidence wording overclaims what is implemented or independently checkable.**

   Evidence: scope says A protects "ALL deferral reasons" (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:120-125`), while the normative mechanism permits only `local-commits` and `local-stash` and explicitly re-follows all others (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:201-212`). The live-fleet counts, timings, ref counts, and provenance at `docs/design/174-apply-side-perf-and-held-repo-livelock.md:19-51,91-116` have no checked-in log/diagnostic artifact, so this review can verify their cited code surfaces but not independently reproduce those empirical numbers from this checkout.

   Fix direction: narrow the A scope language to the eligible blocker set, and label fleet values as author-observed or attach a sanitized diagnostic fixture/log excerpt. Separate observation from causal inference; finding 14 shows the current timeline inference is wrong even if every timestamp is accurate.

## Claims that survived adversarial checking

- Once a pending section exists, the core livelock loop is real: a followed result with held refs/composer pending retains P and the apply deferral (`src/cli/sync-git/apply.ts:1205-1232`), while push carries P and suppresses capture (`src/cli/sync-git/plan.ts:622-632`).
- A true no-op A path is compatible with design 130's A/P/K/BASE rules if it runs after recovery/protocol settlement, preserves P byte-for-byte, performs no BASE composition, and is keyed by all decision inputs. The preservation effect is sound; the proposed eligibility key and placement are not.
- Same-name branch equality/ancestor checks and exact tag equality are conservative no-drop rules when evaluated against the exact final candidate and when shallow/missing/error cases fail closed. A fresh bundle/pack family may replace P after every semantic lane and retained tombstone has been proven; incremental capture links to BASE as one family (`src/cli/sync-git/shared.ts:132-145,200-241`).
- The remote multi-writer CAS is airtight for unseen newer remote sequences: the client commits against `appliedSequence` and converts conflict to pull-first (`src/cli/sync/push.ts:642-660,279-290`), while the server compares parent to head inside one synchronous transaction (`apps/api/src/workspace-sync.ts:661-706`) and E2EE refuses a parent behind the verified pin (`src/cli/e2ee-remote.ts:687-697`). No remote interleaving was found that overwrites a newer unseen section without 409. This does not protect finding 5's accepted one-writer regression from current P to old BASE. After a 409, the newer section may apply fully rather than necessarily becoming pending, so §4.2 should not promise the latter.
- The cited current timing hooks are real: `GitChainTimings` currently contains fetch/decrypt, verify, import, and index/op-state fields (`src/engine/git/shared.ts:17-27`); checkout uses the FIFO-fed `update-ref --stdin` process at `src/engine/git/checkout-txn.ts:121-151`; post-apply fsck is at `src/engine/git/apply.ts:712-724`. C needs exclusive accounting, not different anchors.
- Deferral age/banner progression does not require a full retry and will continue across A-skips, as described in finding 15.
- D's internal-ref classification does not itself violate design 130's wire/BASE contracts; its scheduling/cache behavior needs correction as described in finding 17.

Verdict: CHANGES-REQUIRED
REVIEW-COMPLETE
