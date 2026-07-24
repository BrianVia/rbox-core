# REVIEW-166-R2B — mechanism fidelity + post-overlay equivalence

Reviewed design v2 against commit
`3c8c9b818fb95ab37278bf08ce2764ead25211dc` and the current uncommitted rig
scenario. `REVIEW-166-R2A.md` is treated as already accepted: this review does
not re-issue its ancestry-authority, A-only deletion, journal/durability,
fencing, nested-swap, same-stream, join-mode, general behind/keep, ignore,
consent, or doctor/retention findings.

## Verdict: CHANGES-REQUIRED

The load-bearing equivalence claim is not true in the implementation. A
rename-overlay is not explicitly introduced to the scanner as a mutation, and
a whole `.git` replacement is simultaneously treated as a new physical
repository by the config/artifact identity plane and as the same incarnation by
the checkout-journal plane. The final sync also has no all-repositories finish
barrier: every changed based repo bypasses admission throttling, captures in one
four-wide wave, and can defer independently after the adopt journal is already
complete. These are engine-visible differences from ordinary edits inside the
phase-2 repository incarnation.

## Findings

1. **HIGH — phase 3 does not invalidate the phase-2 scan caches, so detection of the overlay depends on incidental timestamp changes rather than an explicit mutation boundary.**

   The file hash fast path trusts only `(path, mtimeMs, size, ctimeMs)`; neither
   the file inode nor device participates (`src/engine/hashcache.ts:5-15,50-54`).
   The directory-listing fast path is weaker still: its persisted entry contains
   only `(mtimeMs, ctimeMs, children)`, and reuse compares the timestamp pair plus
   the racy-clean cutoff, not directory identity
   (`src/engine/dircache.ts:10-27,39-46,133-145`). A reused listing then drives the
   walk, while a matching file cache entry supplies the old content hash without
   reading the file (`src/engine/manifest.ts:485-541,604-632`). Content SHA remains
   the manifest identity, but these stat tuples are the authority for deciding
   whether to obtain it.

   Phase 2 can leave exactly those caches warm. The current join's `sync` is pull
   then push (`src/cli/sync/sync.ts:8-19`), and both ordinary pull and push load a
   persistent cache and run a pruned scan (`src/cli/sync/pull.ts:114-132`;
   `src/cli/sync/push.ts:61-74`). Pull invalidates hash-cache entries only for its
   own apply actions (`pull.ts:230-240`). Phase-3 init-owned renames are not apply
   actions, and no watcher is required to be running, so nothing in the design
   invalidates either cache after the overlay.

   A direct leaf replacement commonly changes the moved inode's `ctime`; a
   directory swap commonly changes the moved root directory's `ctime`. That is
   not the same as a code-level guarantee for the complete subtree. Renaming an
   ancestor preserves descendant file and directory metadata, and both cache
   keys deliberately omit `dev/ino`. If an overlaid descendant aliases the
   phase-2 stat tuple—for example on a coarser-timestamp filesystem—the scanner
   can reuse A's SHA for B's same-sized bytes. A directory-token alias can also
   hide a B-only or missing child until an unpruned rebuild. A normal in-place
   edit ordinarily changes `ctime`, and the daemon watcher explicitly invalidates
   changed paths; the proposed offline ancestor swap supplies neither invariant.

   Phase 3 must establish an explicit cache boundary: invalidate every restored
   leaf from the hash cache, discard/rebuild the directory cache, and make the
   first post-overlay scan full and uncached (or prove an equivalent closed
   token protocol). The test plan needs a warm phase-2 hashcache/dircache test,
   including a whole-repo ancestor swap, B-only names, same-size differing bytes,
   and forced token collisions. Merely asserting the eventual file contents on
   the ordinary cold rig does not exercise this path.

2. **BLOCKER — a repo-dir swap has no coherent incarnation meaning: strong identity says “new repository,” checkout recovery says “same repository,” and the ordinary pull/push silently bridges the two.**

   The strong repository identity is intentionally physical. `RepoIdentityV1`
   includes the worktree/git/common realpaths plus the common directory's
   `dev`, `ino`, and `birthtime`; its hash includes every field
   (`src/engine/git/repo-lineage.ts:11-20,67-80,82-98`). The persisted config shape
   records the same common-dir stat identity (`src/cli/config.ts:232-235`), and
   `sameConfigShape` compares all of it (`src/cli/sync-git/config-lane.ts:80-106`).
   Replacing `repo/.git` at the same pathname therefore is an incarnation change,
   not an edit to the phase-2 repository. Pull notices that much only in the
   independent config lane: `invalidateLaneShape` drops `cfgSynced`, `cfgApplied`,
   and `cfgToken` when the shape changes (`src/cli/sync-git/apply.ts:399-407`),
   then may run config reconciliation against the replacement (`apply.ts:678-715`).

   The checkout transaction uses a different definition. Its journal binding
   contains only stream, state nonce, and three resolved path strings
   (`src/engine/git/journal.ts:11-17`); binding equality compares only those
   strings (`journal.ts:163-172`). `checkoutJournalBinding` likewise records only
   realpaths (`src/cli/sync-git/follow.ts:243-250`), and the boundary named
   `sameIncarnation` compares those realpaths and repo kind, not `dev/ino/birthtime`
   (`follow.ts:1253-1261,1295-1296`). A same-path `.git` swap therefore passes this
   “incarnation” check. Any phase-2 checkout journal retained in workspace
   `.rbox/state` can be recovered against B's different common directory because
   recovery is the first per-repo pull operation
   (`src/cli/sync-git/apply.ts:511-569`).

   The clean no-journal path is inconsistent too. Because remote Git equals the
   phase-2 BASE, pull takes the unchanged shortcut without comparing live Git or
   preparing the lineage/artifact protocol (`apply.ts:759-768`). Push then derives
   a fresh publisher binding from the replacement's current physical identity
   (`src/cli/sync-git/plan.ts:258-288`), captures it when identity differs from BASE
   (`plan.ts:568-595`), and saves a publisher-ACK proof under that new identity
   (`src/cli/sync/push.ts:674-728`). The BASE composer gives changed branches new
   publisher provenance but retains the old provenance for unchanged branches
   (`src/cli/sync-git/base-composer.ts:335-347,436-439`). A multi-branch ahead repo
   can consequently leave one `RepoRecord` with A-incarnation origins on unchanged
   branches and B-incarnation origins on changed branches; `recordOriginLineage`
   then deliberately refuses to collapse the mixed set
   (`base-composer.ts:189-203`).

   A local executable probe against these functions confirmed the split for a
   same-path directory swap: `ConfigShapeIdentity` changed, the
   `repositoryIdentityHash` changed, but `CheckoutJournalBinding` remained
   byte-equal. Thus the answer to “same or foreign?” is subsystem-dependent. That
   is distinguishable from commits made inside the synchronized `.git`, where the
   common-dir incarnation remains fixed.

   The design must specify one typed incarnation cutover. At minimum it must state
   how phase-2 journals and A/P/K/Z artifacts are proved absent or retired, how
   config-lane state and branch provenance move from the baseline store to the
   replacement store, and which exact identity is persisted before publication.
   Tests must assert the `cfgToken/cfgShape`, repository-identity hash, journal
   binding, branch-origin lineage, and foreign-artifact outcomes across the swap;
   HEAD equality alone cannot validate this boundary.

3. **HIGH — “ONE ordinary sync” is not a bounded or atomic finish step for a 100+ repo overlay.**

   Pull applies independent top-level/nested chains with default concurrency six
   (environment bounded to 1–16) (`src/cli/sync-git/shared.ts:17-19,47`;
   `src/cli/sync-git/apply.ts:1510-1513`). Push first walks the repository keys and
   executes every slow fingerprint/preflight decision serially
   (`src/cli/sync-git/plan.ts:598-721`). It then captures all selected repositories
   with fixed concurrency four (`src/cli/sync-git/shared.ts:17-18`;
   `src/cli/sync-git/plan.ts:775-819`). Each capture creates a bundle and uploads
   its bundle/index/op-state artifacts before the one manifest commit
   (`src/engine/git/capture.ts:197-280`).

   The advertised admission cap does not bound this wave. `admitted` starts with
   every base/pending repo, and the cap check runs only for `!baseSec`; a changed
   phase-2 repo always enters `toCapture` even when the configured cap is lower
   than the number of based repos (`src/cli/sync-git/plan.ts:316-320,568-595`). The
   existing cap test explicitly pins that behavior
   (`src/cli/sync-git/git-sync.test.ts:1796-1819`). The only hard manifest bound is
   256 repos (`src/engine/manifest-validate.ts:20-22,106-115`). Conversely, a
   genuinely B-only repo is subject to the remaining admission budget, so at a
   full 256-repo baseline—or under a lower configured cap—it does not “push as an
   addition”; it is loudly deferred.

   Capture failure is per-repo base carry, not failure of the finish operation
   (`src/cli/sync-git/plan.ts:425-436,775-819`). The final push may therefore commit
   a subset of 100 overlaid repos while retaining A's section for the rest. A 409
   pull-first response rescans and replans, potentially repeating this fanout,
   under a five-attempt budget (`src/cli/sync/push.ts:275-300`;
   `src/cli/sync/policy.ts:10`). Yet the design marks the adopt journal complete
   before this sync and gives no “publication still owed” state
   (`docs/design/166-forward-adopt.md:81-87`).

   This behavior is safe as ordinary best-effort sync behavior, but it does not
   support the design's one-cycle completion and stash-clear messaging. Specify
   whether adoption is complete after local overlay or only after every selected
   repo has captured/settled, and preserve a resumable owed set if the latter. Add
   100+, 256, lower-cap, one-capture-failure, and 409-during-fanout tests with
   assertions on which repo BASEs, origins, deferrals, and stash entries remain.

4. **HIGH — the mandatory tests do not test the stated equivalence boundary, and the current rig masks the finish-step contract.**

   The current `git-join-ahead` rig drives only direct headless init. Its provisioner
   invokes `init --workspace ... --no-interactive`, then performs another explicit
   pull after init (`scripts/rig/scenarios/preamble.ts:156-164`); the scenario later
   performs an explicit B push (`scripts/rig/scenarios/git-join-ahead.ts:101-115`).
   Since default join init already calls `sync`, this sequence cannot prove that
   the design's single post-overlay sync detected and published the overlay. It can
   let a later scan heal cache/record state and still pass.

   The ordinary setup wizard can reach the same plan, but only if adoption is
   placed below the frontend seam: `workspaceFlags` maps a join to
   `workspace=<id>` plus `no-interactive=true`, and `stepWorkspace` passes those
   flags to `runInit` (`src/cli/setup-cmd.ts:58-70,657-699`). `runInit` then resolves
   the shared join plan (`src/cli/init-cmd.ts:148-181`). The existing unit test pins
   the flag mapping, not a non-empty wizard adoption
   (`src/cli/setup-cmd.test.ts:77-97`). R2A-11 already owns the separate consent
   defect; the additional test gap here is route/mechanism parity. The mandatory
   plan needs a setup-wizard non-empty join that proves the same journal, overlay,
   final-sync, decline, and recovery path as direct `init --workspace`.

   R2A-8 already owns the general behind/keep loss, so it is not re-issued here.
   The exact equivalence counterexample still needs a mandatory assertion: let B's
   branch be behind, create B-only data, and run `git stash push -u` so B's visible
   worktree is clean and the only copy is in `refs/stash` and its reflog. If B were
   genuinely a synced repo with a later user stash, `gitIdentity` would include
   `refs/stash` via the all-ref read (`src/engine/git/identity.ts:21-35`;
   `src/engine/git/refs.ts:6-14`), follower classification would protect receiver-only
   stash-reflog OIDs as `local-stash` (`src/cli/sync-git/follow.ts:462-471,653-673`),
   and directory-repo capture would bundle `refs/stash`
   (`src/engine/git/capture.ts:224-245`). Under the specified behind keep route,
   none of that state is live: it exists only below hard-excluded `.rbox/adopt/stash`
   (`src/engine/ignore.ts:231-245`), while `git stash list` in the visible baseline
   repo shows no B stash. Test 3's “stash retains B's old copy” inventory check does
   not establish that the user can discover or verify this value before following
   the instruction to clear the adopt stash.

   Required additions are therefore: a warm-cache overlay test; an exact
   repo-incarnation/provenance test; a many-repo fanout/partial-failure test; a real
   wizard-route test; and a behind Git-stash-only test that asserts live
   discoverability, object reachability, completion messaging, and clear refusal
   while hidden-only value remains. The upgraded rig must also inspect the state
   immediately after init's own final sync, before any extra pull or push.

## Validation record

- PASS: all eight `src/engine/dircache.test.ts` tests, confirming the exact
  timestamp-pair/racy-margin reuse contract.
- PASS: targeted config-shape tests in
  `src/cli/sync-git/sync-git-config-pull.test.ts`.
- PASS: the based-repo admission-cap test in
  `src/cli/sync-git/git-sync.test.ts`.
- PASS: the setup join-to-`runInit` flag-mapping test in
  `src/cli/setup-cmd.test.ts`.
- PASS: targeted stash rows in `src/cli/sync-git/follow-matrix.test.ts`.
- A same-path two-repository swap probe using the reviewed
  `configReceiver`, `readRepoIdentityV1`, and `checkoutJournalBinding` functions
  produced `shapeSame=false`, `identitySame=false`, and `journalSame=true`,
  corroborating finding 2.

The v2 pivot can still be made to work, but not by treating a namespace and
repository-incarnation replacement as observationally identical to ordinary
post-sync edits. The design must make those boundaries explicit and test them.
