# Adversarial review — Design 204 r1 (codex reviewer B, Part C depth)

Scope: `docs/design/204-delta-scoped-publish.md` reviewed under
`REVIEW-CHARTER-204.md`, with additional depth on Part C and the required-test
contract.

1. **BLOCKER — C1 would move correctness-bearing publisher lineage behind an
   unrelated journal-presence probe.**

   Evidence: the pre-loop does not derive lineage merely to validate journal
   recovery. It stores `publisherAckBindings[rel]` from
   `readRepoIdentityV1`/`readStateLineageV1`
   (`src/cli/sync-git/plan.ts:400-413`). That binding is later required to
   reject an absence proof if repository identity changed
   (`src/cli/sync-git/plan.ts:1080-1090`), to prove pending supersession
   (`src/cli/sync-git/plan.ts:1228-1244`), and to author publisher-ACK/base
   proofs after commit (`src/cli/sync/push.ts:966-985`). By contrast, the
   checkout-journal binding is a separate value derived at
   `src/cli/sync-git/plan.ts:419-420`. Design 204 says the lineage reads
   "exist only to validate a journal binding" and moves them behind the journal
   gate; that claim is false. Design 203 explicitly gated only "design-116
   recovery," while preserving every other demander
   (`docs/design/203-lazy-git-apply-probes.md:58-65`).

   Proposed disposition: split C1 into two clusters. Gate only
   `checkoutJournalBinding` + `recoverAndLandFollowJournal` on
   `checkoutJournalPresent`. Keep publisher identity/lineage eager unless a
   separately reviewed lazy thunk proves every demander is preserved. Revise
   the syscall saving and required tests accordingly; add absence-proof,
   pending-supersession, and publisher-ACK parity tests with no journal.

2. **BLOCKER — the proposed cross-repo common-dir fingerprint memo can produce
   a false trusted hit after a ref mutation.**

   Evidence: `gitFingerprint` combines per-worktree `gitDir` material with a
   memoized common-dir token (`src/cli/sync-git/fingerprint.ts:349-375`).
   `"cross-repo"` retains that token across different rel-path decisions,
   whereas today's `"per-decision"` policy clears it on a rel change
   (`src/cli/sync-git/fingerprint.ts:290-307`;
   `src/cli/sync-git/plan.ts:210-212`). A linked-worktree run can therefore:
   fingerprint repo A and memo common token T; mutate a shared loose/packed ref;
   then fingerprint repo B using stale T. If B's per-worktree token and cache
   also match T, `fingerprintHitProbe` returns `hit`
   (`src/cli/sync-git/divergence-cache.ts:258-277`). The racy-clean check does
   not help: it examines timestamps contained in the stale token against the
   old cache write time (`src/cli/sync-git/divergence-cache.ts:112-114`), not
   the mutation that was never re-read. Existing code deliberately deletes the
   common token before a same-repo after-fingerprint
   (`src/cli/sync-git/divergence-cache.ts:301-304`) and after hygiene mutation
   (`src/cli/sync-git/plan.ts:1276-1289`), confirming that invalidation between
   observations is correctness-bearing.

   Proposed disposition: drop this lever. Keep `"per-decision"` unless the
   common directory is locked against external Git writers for the full shared
   observation window (it currently is not). Static output parity is not a
   proof of concurrent soundness.

3. **BLOCKER — C3's candidate source does not observe every topology change
   that the full discovery walk observes.**

   Evidence: candidate classification recognizes only an event whose exact path
   is `.git` or ends in `/.git`
   (`src/cli/daemon/git-ref-watch.ts:69-85`). A rename of a fully formed clone,
   `git worktree add`, or directory-level materialization may be reported only
   as creation/rename of the owner directory; neither Parcel nor the design
   promises descendant `.git` events. Such an event becomes an ordinary
   `addDir`, not a repo candidate (`src/cli/daemon/watcher.ts:342-379`).
   Chokidar similarly classifies only the exact event path
   (`src/cli/daemon/watcher.ts:423-452`). The current walk, however, recursively
   examines every admitted directory and detects nested dir- and pointer-backed
   repos (`src/engine/git-discover.ts:46-63`). Submodule init and worktree
   pointer creation are covered only if the exact `.git` file event arrives.

   A second missing topology trigger is matcher change: changing
   `.rboxignore`/`.gitignore` can make an already-present repo newly
   discoverable. The daemon rebuilds the matcher and rescans the file plane
   (`src/cli/daemon/daemon.ts:1995-2007`), but no `.git` lifecycle event is
   generated. Design 202 treats ignore-rule and Git-topology changes as explicit
   scan fallbacks (`docs/design/202-pull-trusted-local-manifest.md:183-200`).

   Proposed disposition: delta discovery may be used only if the watcher
   contract includes subtree-opaque create/rename evidence. Any added/renamed
   directory whose descendants were not enumerated must trigger targeted
   `discoverGitReposUnder` or force `mode:"walk"`. Matcher generation changes
   must invalidate the discovery baseline and force a complete walk. Specify
   backend-by-backend event guarantees; do not infer descendant delivery.

4. **BLOCKER — the proposed "set union, then clear after a successful plan"
   handoff can erase candidates that arrive while the plan awaits.**

   Evidence: signal batches are intentionally snapshotted and cleared before
   asynchronous consumption so later signals belong to a new generation
   (`src/cli/daemon/watcher.ts:169-186`). `planGitSections` has many awaits after
   its key set is selected (`src/cli/sync-git/plan.ts:376-445` and onward), so
   watcher callbacks can add a candidate during the plan. An unconditional
   clear on completion would delete that post-snapshot candidate even though
   the completed plan never visited it. Design 204 names a "single-use handoff"
   but defines neither a generation token nor compare-and-clear semantics.

   Proposed disposition: define an epoch-stamped snapshot. A plan receives
   `{epoch,candidates}` and successful completion acknowledges only that epoch;
   additions after the snapshot remain pending. Failed/aborted plans acknowledge
   nothing. Pin arrivals (a) before snapshot, (b) during plan, (c) after plan
   but before ACK, plus 409/422 retry and thrown-plan cases.

5. **MAJOR — the stated trust predicate is not representable by the current
   registry, and the Mac headline cannot use it as written.**

   Evidence: `GitRefWatchRegistryState` exposes `closed`, `readerDead`,
   `floorRequired`, handle/retry counts, and owner state, but no "complete
   snapshot," "armed continuously since epoch," or owner `floorDir`
   (`src/cli/daemon/git-ref-watch.ts:122-139,255-263`). A complete snapshot is
   only implicit in the successful `beginSnapshot`/`applySnapshot` transaction
   (`src/cli/daemon/git-ref-watch.ts:281-304`). Furthermore the registry is
   constructed only for Linux + Parcel
   (`src/cli/daemon/git-ref-watch.ts:19-25`;
   `src/cli/daemon/daemon.ts:872-885`). The motivating measurement and rollout
   target are Mac, so "registry snapshot is complete" either makes
   `discovery=delta` permanently unavailable there or silently means a
   different, unspecified registry.

   Proposed disposition: introduce a backend-independent discovery-continuity
   state owned by the daemon, with explicit watcher session/error generation,
   matcher generation, complete-walk epoch, overflow bit, and opaque-subtree
   bit. Treat the Linux ref-watch registry as an additional ref-signal safety
   input, not as proof that workspace topology was observed. State precisely
   how Mac reaches delta mode.

6. **MAJOR — owner failure tests and predicate inputs are underspecified and
   currently hide necessary state.**

   Evidence: owner states include `pending`, `armed`, `failed`, `overCap`,
   `outside`, and `refused` (`src/cli/daemon/git-ref-watch.ts:131-140`), but
   design test 14 checks only "registry incomplete / owner refused / no
   daemon." It omits `pending`, `failed`, `overCap`, `outside`, reader death,
   retrying targets, closed registry, watcher error-generation change,
   candidate overflow (`discoverAll`), and initial/restart baseline. Candidate
   overflow is already a distinct state that discards the bounded owner set
   (`src/cli/daemon/watcher.ts:194-204`). Also `markCandidates` ignores an
   unknown owner (`src/cli/daemon/git-ref-watch.ts:307-325`), so registry state
   alone cannot attest that the candidate was retained by the separate
   discovery handoff.

   Proposed disposition: write the predicate as a pure typed function over a
   complete snapshot, enumerate every false cause, and table-test all causes.
   Unknown owners and overflow must remain explicit discovery work even if the
   ref registry cannot mark them.

7. **MAJOR — required test 15 would pass despite the C2 race.**

   Evidence: the specified matrix `(clean, ref-moved, index-touched)` compares
   final hit/miss decisions under two policies, but does not mutate the shared
   common directory between repo A's memo fill and repo B's read. The defect in
   finding 2 requires exactly that interleaving. Existing after-fingerprint
   logic explicitly invalidates the common token before re-read
   (`src/cli/sync-git/divergence-cache.ts:301-304`).

   Proposed disposition: if C2 is retained, add a deterministic hook after A
   fills the common memo, mutate a shared loose ref, `packed-refs`, config, and
   worktree registry in separate cases, then require B to miss. Also test a
   mutation during A's before/after bracket. The expected result likely proves
   the lever must be removed.

8. **MAJOR — required test 14 is too synthetic to validate C3.**

   Evidence: it injects "new repo created while daemon runs ⇒ candidate set
   carries it," assuming the disputed premise. The real classifiers and
   backend filters are at `src/cli/daemon/watcher.ts:306-452`, while discovery
   semantics include nested repos, pointers, ignore pruning, and no symlink
   following (`src/engine/git-discover.ts:15-27,46-63`).

   Proposed disposition: require end-to-end watcher-to-plan cases for: exact
   `.git` create/update; fully formed clone renamed into the tree with only the
   parent-dir event; nested repo; submodule init; `git worktree add`; repo in an
   ignored directory (must remain absent); already-present repo made visible by
   ignore-rule change; daemon restart before any completed plan; candidate-cap
   overflow; watcher error during plan; and each backend/platform contract.
   Also assert the epoch-safe ACK behavior from finding 4. Retain the deletion
   case, which is sound because base keys stay in `keys` and physical absence
   produces removal (`src/cli/sync-git/plan.ts:826-846`).

9. **BLOCKER — Part A's freeze condition is not discharged, and an unmarked
   carried ref with `present=0` is not covered by the claimed 422 backstop.**

   Evidence: design 103 requires an acceptance regression pinning carried-ref
   admission before coexistence
   (`docs/design/103-steady-sync-quick-wins.md:615-627`). The current unit test
   proves that `mergeAddedShas` classifies an intersection as carried
   (`apps/api/test/commit-delta.test.ts:45-68`), and shadow integration proves
   the authoritative *full* path catches a harmful carried ref
   (`apps/api/test/commit-delta-shadow.test.ts:91-98`). Neither is an endpoint
   test with `RBOX_COMMIT_DELTA_ADMISSION="enforce"` proving the narrowed path's
   parent-refset/fence behavior; the shadow fixture only accepts `"off" |
   "shadow"` (`apps/api/test/commit-delta-shadow.test.ts:43-54`). The server
   chooses the narrowed `admitData` only in enforce mode
   (`apps/api/src/workspace-sync.ts:638-645`). In that mode ordinary carried
   refs are absent from `admitData`: the merge emits only `added` and
   `markedCarried` (`apps/api/src/commit-delta.ts:40-94`). Therefore a carried
   ref whose catalog row has become `present=0` without a prune marker or
   active-intent row is checked by today's full client preflight/full server
   path, but by neither side after Part A is default-on alongside narrowed
   admission. No 422 is generated, so the retry loop cannot repair it. Design
   102 argues sanctioned GC cannot create this state, but the charter's
   pack-loss/catalog-correction case is exactly the unsatisfied "loss"
   condition that design 103 froze on.

   Proposed disposition: keep Part A frozen until an enforce-mode endpoint
   regression exercises parent/child carried refs across ordinary, prune-marked,
   active-intent, and lost/catalog-inconsistent states and proves either safe
   admission/regrant or 422/fallback. If arbitrary `present=0` is a supported
   repair state, add a bounded server-side loss detector/fallback or retain a
   periodic/full client audit policy that detects it before commit. Required
   test 3 should say this explicitly, rather than "verify exists / add."

10. **MINOR — Part A's "one flag read site" claim is false today and the
    required tests do not pin both execution arms.**

    Evidence: `RBOX_PREFLIGHT_DELTA` is read separately in the pipeline arm
    (`src/cli/sync-recovery.ts:184-203`) and serialized arm
    (`src/cli/sync-recovery.ts:295-315`). `pipeline.ts` consumes a boolean; it
    is not a second env read (`src/cli/publish-pipeline/pipeline.ts:437-479`).

    Proposed disposition: either hoist the env read above `usePipeline` and
    thread one value to both arms, or correct the design to "two mutually
    exclusive reads." Test no-env/default-off behavior in both arms, including
    `forceFullAudit` and recovery residue. Ambient cleanup should cover both
    `RBOX_PREFLIGHT_DELTA` and `RBOX_PREFLIGHT_FULL`.

11. **MAJOR — Part B does not actually adopt design 149's master-switch
    precedence at both seams, and its behavioral test cannot detect that.**

    Evidence: design 149 explicitly says tri-state overrides apply "at BOTH
    seams" and `RBOX_MDE_SNAPSHOT=0` wins
    (`docs/design/149-storage-economics.md:318-337`). Design 204 changes push's
    delta-base selection only to `RBOX_MDE_DELTA !== "0"`; that site currently
    does not read the snapshot switch
    (`src/cli/sync/push.ts:771-778`). The remote writer would ultimately emit
    raw because `mdeWriteCaps` disables delta, so the proposed wire-only test
    passes while the push seam still constructs and sends a `deltaBase` option,
    contradicting the claimed precedence and warning ownership.

    Proposed disposition: define one shared `mdeWriteCaps`/policy result (or a
    pure shared flag parser) and use it at both seams. Pin that snapshot-off
    prevents delta-base selection, raw is emitted, metadata is omitted, and the
    warning occurs exactly once. Add default-on stale-meta, sequence-gap,
    epoch-rotation, interrupted/retried push, and repair cases; current tests
    heavily exercise opt-in delta but do not make absence-of-env the default
    contract.

12. **MAJOR — required test 16's "sub-phase buckets sum ≈ phase wall" assertion
    is not valid for the proposed buckets.**

    Evidence: `git-plan` includes cache load, state normalization, config lane,
    preflight/capture, pending and resolution proofs, persistence preparation,
    and cache save in addition to discover/journal/fingerprint/hygiene
    (`src/cli/sync-git/plan.ts:150-327,452-1257,1294-1325`). Four selected
    buckets cannot be expected to approximate the phase wall, especially on
    misses or captures. Conversely, nested fingerprint time can be counted
    inside larger operations if brackets are not exclusive.

    Proposed disposition: either add an explicit `otherMs` measured as
    `totalMs - exclusiveBuckets`, or test only that buckets are finite,
    nonnegative, and individually bounded by total wall. Define whether buckets
    are exclusive before using their sum as an acceptance signal.

13. **MINOR — the cost attribution and C2 memo plan overstate what the stated
    code change can save.**

    Evidence: `gitFingerprint` always calls `repoCtxFromDisk` internally
    (`src/cli/sync-git/fingerprint.ts:349-363`), so a `rel → ctx` memo in
    `planGitSections` does not remove that derivation unless the fingerprint API
    gains an explicit trusted-context parameter and its invalidation semantics
    are specified. Common-dir reuse helps only linked worktrees sharing a
    common directory, not 101 independent repos. C1 also cannot remove the
    publisher lineage cluster per finding 1. The ≤0.5s field target therefore
    is not supported by the mechanism as written.

    Proposed disposition: inventory each remaining `repoCtxFromDisk` call after
    the proposed signature changes, keep shared-context invalidation local to a
    repo decision, and state separate expected savings for independent repos
    versus linked worktrees. Treat C5 telemetry as measurement, not proof of the
    forecast.

## Backstop conclusions

The Part A 422 loop itself is sound only after authoritative commit admission
has produced a 422: pages accumulate into the next preflight
(`src/cli/sync/push.ts:358-374`), overflow latches a bounded full audit
(`src/cli/sync/push.ts:158-171`), chain-link/truncated responses force snapshots
(`src/cli/sync/push.ts:181-199`), and receipts and legacy commit branches both
return chain-first 422s (`apps/api/src/workspace-sync.ts:544-565,661-674`).
It cannot detect a physical R2/pack loss while D1 still falsely says
`present=1`, but today's full preflight uses the same catalog and is equally
unable to detect that inconsistency. Once the catalog is corrected to
`present=0`, however, today's full path detects it and the proposed combined
delta paths do not; that is the delta-specific regression in finding 9.

Part B's chain rooting is implemented for retained sequences: chain SHAs enter
the per-sequence ref set (`apps/api/src/workspace-sync.ts:841-859`) and both
roots readers include them (`apps/api/src/workspace-sync.ts:1016-1025,
1121-1126`). `fastFoldBase` exact-evidence and grown-chain suffix checks are
also present (`src/cli/e2ee-remote.ts:188-208,264-302`). Those facts do not
resolve the flag-precedence/test gap in finding 11.

## Verdict

**CHANGES-REQUIRED**
