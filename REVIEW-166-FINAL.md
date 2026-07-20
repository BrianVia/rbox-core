# REVIEW-166-FINAL — final serial adversarial review of v3

Reviewed `docs/design/166-forward-adopt.md` v3, the complete R1/R2 trail, the
fold notes, and the current implementation at
`17e3104080262aac1e6ef439d8652166c4945366`.

## Verdict: CHANGES-REQUIRED

The join-time adopt-by-overlay layer remains the right layer, and v3 correctly
eliminates whole-repository and whole-directory swaps. It is not ready for
implementation, however. The literal fetch operation can create live tags; the
supposedly local-only adoption namespace is included by today's `--all` bundle
capture; pointer-repository scope and linked-worktree ownership are not
respected; advancing a checked-out branch destroys valid phase-2 index state;
the journal cannot identify all intervening writes; and the four named fence
sites do not cover every publisher. Those are safety failures, not editorial
gaps.

## Round-2 fold audit

This is the requested one-by-one walk. “Folded” means the original finding's
policy is represented correctly in v3; it does not waive a separately numbered
new-v3 defect below.

### REVIEW-166-R2A findings 1–12

1. **INCOMPLETE.** The ancestry route is improved correctly: an existing branch
   is advanced only by an ancestry proof plus expected-old CAS, while
   behind/diverged/unrelated/probe-error values park. But D1 is not actually
   non-publishing against the real Git implementation: the literal fetch
   auto-follows tags into live `refs/tags/*`, `refs/adopt/*` is included by the
   capture bundle, pointer repos expose a shared ref store, and checked-out
   branch advancement mutates the index plane. See findings 1–3.
2. **FOLDED.** The stash-driven leaf walk leaves A-only paths live, displaces A
   before a same-type B collision lands, and leaves A live/B unplaced on type
   collisions (`166:161-194`; matrix rows `396-398`). There is no remaining
   whole-repo or whole-directory manufactured-deletion rule.
3. **INCOMPLETE.** Ordered parent fsyncs, power-loss scope, before/after states,
   and the honest phase-2 B-plus-A peak are present (`196-230`). But “exact
   identity” hashes only small files and aliases large in-place rewrites; raw
   path revalidation is not an atomic no-clobber operation; and fetch-union adds
   another object/temporary-space peak. See findings 5 and 10.
4. **INCOMPLETE.** The design names daemon, one-shot sync, direct push, and direct
   pull; refuses a degraded mutex; keeps recovery independent of the kill
   switch; and places cache invalidation before successful completion
   (`235-265`). Other real publishers bypass those four sites, a resident daemon
   needs an in-memory generation transition, and the phase-2 continuation is
   not closed. See findings 6–8.
5. **FOLDED.** Repository-directory swaps are gone. Each union targets the
   phase-2 repository and the file walk excludes Git administration, so nested
   ancestor/child directory replacement no longer exists (`103-159`, `403`).
6. **FOLDED.** Every already-bound root, including same-stream re-init, refuses
   before journal publication or movement (`269-290`, `404`).
7. **FOLDED.** Adoption is narrowed to default `firstSync=sync`; pull-only,
   no-sync, and keyed/agent paths refuse before mutation (`269-290`, `405`).
8. **INCOMPLETE.** For an ordinary directory repo, B's branch/tag/stash/detached
   values are fetched and reported rather than silently abandoned. The rule is
   not scope-correct for pointer repos, does not preserve a B-only external
   pointer store under adoption, and can destroy A's index/op-state. See
   findings 2, 3, and 9.
9. **INCOMPLETE.** The file plane specifies no-follow traversal, hardlinks,
   type/special handling, unreadable/mount refusal, and destination containment
   (`53-75`, `161-190`, `414-418`). Phase 3 applies no Git-target containment,
   the check-then-rename writer race remains, and directory mode/ACL/xattr and
   unwritable-destination behavior are unspecified. See findings 4, 5, and 10.
10. **INCOMPLETE.** Ignore-independent restoration and rule-file-first matcher
    rebuilding are correctly stated (`350-365`, `419`). The rebuilt matcher can
    still reuse the persistent Git tracked-set cache across the index mutation.
    See finding 7.
11. **INCOMPLETE.** Direct, wizard, and headless consent routes are correctly
    separated and a typed affirmative witness is required (`267-296`, `406`).
    The promised arbitrary-writer detection is not supplied by a stat check
    followed by an unguarded rename. See finding 5.
12. **INCOMPLETE.** A direct-path `adopt` family, explicit retention, and
    pre-/post-phase-2 abort concepts exist (`318-348`, `409-410`, `423`). “After
    phase 2 begins” is not a valid recovery boundary when the phase-2 sync may
    itself be partially applied; abort also lacks the successful path's cache
    mutation boundary. See findings 7 and 9.

### REVIEW-166-R2B findings 1–4

1. **INCOMPLETE.** Hash-leaf invalidation, directory-cache/token discard, a
   rebuilt matcher, and a forced full scan correctly address the original
   one-shot warm-cache counterexample (`253-258`, `350-365`, `420`). They do not
   cover the Git tracked-set cache, a daemon's resident manifest/hash cache, or
   the inverse mutations performed by abort. See finding 7.
2. **FOLDED.** The phase-2 `.git` incarnation, repository identity, config shape,
   and checkout-journal binding are never replaced (`103-159`, `421`). Removing
   the swap dissolves the mixed-incarnation defect.
3. **FOLDED FOR SEMANTICS; TEST COVERAGE INCOMPLETE.** Local adoption completes
   before an explicitly ordinary, incremental, non-atomic finish sync; capture
   failures, subsets, 409 retries, and later settlement are acknowledged
   (`298-316`, `422`). The matrix uses the synthesis's 20+ ruling but drops the
   accepted review's 100+/256/lower-admission-cap boundaries and does not assert
   every BASE/origin outcome. See finding 11.
4. **INCOMPLETE.** Warm cache, incarnation, fanout, real wizard parity, behind
   stash visibility, and immediate post-init observation all have rows. The
   review required refusal to clean a hidden-only value; v3 instead allows clean
   after listing/confirmation. If that is an intentional synthesis override, it
   must be recorded as such and tested. Additional missing binding rows are in
   finding 11.

## Findings

1. **BLOCKER — the specified fetch-union command violates D1 before ancestry or CAS is reached.**

   Design lines `110-120` specify the equivalent of:

   ```text
   git fetch <stash-repo> +refs/*:refs/adopt/incoming/*
   ```

   A literal probe against Git created both
   `refs/adopt/incoming/tags/b-tag` **and live `refs/tags/b-tag`**: normal fetch
   auto-followed the tag. That live tag is syncable by
   `src/engine/manifest-validate.ts:261-265`, directly contradicting lines
   `131-139` and the stash/tags acceptance row.

   Even after adding `--no-tags`, the namespace is not “never captured.”
   `readAllRefs` filters manifest refs to heads/tags/stash
   (`src/engine/git/refs.ts:6-14`), but directory capture runs
   `git bundle create --single-worktree --all` and excludes only `refs/rbox-*`
   (`src/engine/git/capture.ts:30-31,52-58,242-253`). A second literal probe
   showed every `refs/adopt/incoming/*` ref in `git bundle list-heads`. Followers
   import every bundle ref into a temporary namespace
   (`src/engine/git/shared.ts:462-493`). The parked ref may not become a receiver
   live ref, but its supposedly local-only name/objects are captured and uploaded
   in the encrypted Git artifact.

   The fetch also needs at least `--no-recurse-submodules`; the existing artifact
   importer added that exact guard because configured recursion can contact real
   remotes and mutate children (`shared.ts:487-493`). `--no-write-fetch-head`
   should be decided explicitly as part of the no-baseline-admin-mutation
   contract.

   Specify exact plumbing arguments (`--no-tags --no-recurse-submodules`), use an
   already capture-excluded namespace such as `refs/rbox-adopt/*` or extend the
   bundle exclusion, and bind both the live-ref set and `bundle list-heads`.

2. **BLOCKER — branch CAS is not a complete scope, ownership, or pause protocol.**

   V3 applies `+refs/*` and per-branch rules uniformly to every discovered repo.
   Real pointer repos deliberately own only the current branch:
   `readScopedRefs` excludes other branches, tags, and stash because those belong
   to the shared main clone (`src/engine/git/refs.ts:17-23`). Fetching all refs
   from a B pointer and updating all corresponding baseline branches adopts
   unrelated shared-store state.

   An expected-old `update-ref` protects one OID, but not linked-worktree
   ownership, HEAD, the index, the reflog, or an ABA. The existing engine calls
   out that `update-ref` silently advances a branch checked out by a sibling and
   leaves that worktree dirty (`src/engine/git/apply.ts:106-120`). Its safe
   transition rechecks the ref, HEAD, sibling ownership, and optional reflog
   fingerprint at the prepared transaction boundary
   (`src/cli/sync-git/branch-transition.ts:294-333`). V3 specifies none of those
   observations. A concurrent checkout can also change which branch is current
   between CAS and “rebuild the resulting HEAD” and cause the wrong index to be
   rebuilt.

   CAS-failure semantics are not closed. If the observed old OID becomes a third
   value, the general classifier calls it new-writer/ambiguous, while line `129`
   promises classifier-driven resume. The design never says whether resume parks
   the incoming ref, stays terminally paused, or creates a new operation after a
   fresh ancestry/ownership proof. It must not silently reinterpret the original
   journal operation against the new value.

   Define dir-vs-pointer ref scope, sibling ownership and HEAD/reflog reservations,
   and a total CAS-failure state machine. Add pointer, linked-worktree, concurrent
   checkout, ABA, probe-error, CAS-mismatch, and resume/abort rows.

3. **BLOCKER — rebuilding the checked-out index discards valid A state and has no inverse.**

   Lines `144-150` advance a checked-out phase-2 branch and rebuild its index
   against the new HEAD, then assert that baseline operation state remains clean.
   Phase 2 provides no such cleanliness guarantee. Git sections intentionally
   transfer raw index and operation-state artifacts
   (`src/engine/git/capture.ts:207-221,276-295`), so A may materialize a staged,
   sparse, intent-to-add, skip-worktree, unmerged, merge, or rebase state.

   Rebuilding against B's HEAD erases A's synchronized staged index and can leave
   A's operation files incoherent with the new HEAD/index. The ordinary finish
   capture can then publish that erasure. The journal records ref operations but
   specifies no retained A-index bytes or index/op-state classifier. Abort at
   lines `332-338` rolls the branch ref back by CAS only, leaving the rebuilt B
   index against rolled-back A HEAD.

   Either require `indexTree == HEAD tree` and no operation state before a
   checked-out fast-forward (otherwise park), or specify a journaled, retained,
   lock-protected index/op-state composition and exact inverse. Tests must cover
   staged/sparse/ITA/unmerged indexes, merge/rebase state, crashes between ref and
   index publication, and post-index abort.

4. **BLOCKER — phase 3 can follow an A symlink and mutate a repository outside the workspace.**

   The file-plane containment guard runs in phase 4, after Git union. If B has a
   repo at `d/repo` and phase 2 materializes A's `d -> /outside`, phase 3 opens the
   “baseline repository at the same relative path” and can fetch/update
   `/outside/repo` before the later type-collision rule retains B. The existing
   Git apply path has the stronger `assertGitTargetWithinRoot` no-symlink and
   realpath guard (`src/engine/git/containment.ts:7-47`) for this reason.

   Require that guard, repository-incarnation revalidation, and source
   containment immediately before every fetch/ref/index mutation. Add the exact
   B-repo-below-A-symlink case; the current file-only symlink row does not cover
   it.

5. **BLOCKER — the “exact-identity” file journal cannot distinguish all intervening writers and raw rename is not no-clobber.**

   Lines `203-205` hash only small regular entries. For a large file, a writer can
   change bytes in place, retain inode/type/size, and restore mtime; ctime is not
   even part of the listed identity. Resume can classify those foreign bytes as
   the recorded value and move or overwrite them, contradicting lines `218-225`.
   The existing hash cache explicitly includes ctime to defeat same-size,
   restored-mtime edits (`src/engine/hashcache.ts:5-15,50-54`). A content identity
   used to authorize destructive recovery needs a collision-resistant hash for
   every regular file, or an equivalently strong retained/open-handle protocol.

   There is a second check/use gap. `ensureDirectoryChain` and `assertWithinRoot`
   validate paths (`src/engine/fsutil.ts:81-148`), but a subsequent path-based
   `rename` is neither no-replace nor bound to the validated parent directory.
   Between revalidation and rename, an unrelated writer can create the absent
   destination (which rename overwrites) or exchange a parent for a symlink. The
   workspace mutex excludes sync owners, not that writer. This violates v3's
   stated writer model, not merely a hostile-local-attacker model.

   Specify no-clobber/dir-identity primitives (for example dirfd/renameat-style
   operations or a proven equivalent), or explicitly narrow the writer model and
   safety claims. Add large-file identity-alias, destination-created-after-check,
   parent-exchange, rollback-CAS-blocked, and ambiguous-writer tests.

6. **BLOCKER — the global fence does not cover every real publisher.**

   The four sites at lines `237-243` are necessary but not sufficient. For
   example, `rbox ignore --purge` acquires the workspace mutex and calls
   `pushManifest` directly (`src/cli/ignore-cmd.ts:70-106`), bypassing the direct
   push command boundary. Chain repair likewise calls `applyPulledManifest`,
   `scanManifestForPush`, and `pushManifest` directly
   (`src/cli/chain-repair.ts:24-89`). `recover` drives those paths under its own
   mutex (`src/cli/recover-cmd.ts:61-123`). After an adopter crashes and releases
   the mutex, these owners can publish/apply a partial overlay unless the fence is
   enforced at a common lower boundary or every owner is enumerated.

   The safety property at lines `377-379` says *any* incomplete adoption prevents
   partial publication, so implement the fence at a common operation boundary
   that all manifest publishers/appliers must cross, with the private phase-2
   exception described in finding 8. Add every direct and ceremonial publisher
   to the fence matrix, not only `sync|push|pull|daemon` commands.

7. **HIGH — cache-generation completion is incomplete for trackedness, resident daemons, and abort.**

   Dropping the persisted hash/dir caches does not invalidate
   `.rbox/state/git-tracked/*`, which `buildIgnoreMatcher` reuses using only index
   path, mtime, and size (`src/engine/ignore.ts:593-608,642-669`). After an index
   replacement with a colliding stat tuple, a “rebuilt” `respectGitignore`
   matcher can still use A's tracked paths. The warm-cache row tests file hash and
   directory tokens, not this cache.

   A daemon also owns long-lived in-memory manifest/hash/matcher state. Deleting
   disk caches cannot invalidate an already-running daemon. Its operation
   boundary must consume the durable adopt generation, replace resident caches,
   rebuild the matcher, run an unpruned/cache-bypassing scan, durably acknowledge
   that generation, and only then apply/publish. The current daemon's analogous
   reset reseed happens at its held-mutex operation boundary
   (`src/cli/daemon/daemon.ts:772-810`).

   Finally, abort performs inverse file/ref mutations but the scan-mutation
   boundary is specified only for successful `complete`. An `aborted` journal is
   terminal/cleanable, so lifting its fence without the same cache boundary can
   publish stale B bytes or miss restored A.

   The physical placement of `stash/`, `displaced/`, and `unplaced/` under
   `.rbox` is otherwise correct: normal scanning hard-excludes `.rbox/**`
   (`src/engine/ignore.ts:231-245`). Bind that fact end-to-end and bind the
   generation transition for successful completion, resume, and abort.

8. **HIGH — the continuation is not yet a closed, implementable authority.**

   Phase 2 calls today's default init sync (`92-101`), and today's
   `sync()` necessarily invokes nested pull then push
   (`src/cli/sync/sync.ts:8-19`; `src/cli/init-cmd.ts:484-494`). V3 simultaneously
   says the continuation authorizes the baseline-establishment call and is not
   accepted by pull, push, or ordinary sync entry points. The intended distinction
   is plausible, but it must be explicit: a private, unforgeable, single-use
   top-level capability must propagate to the nested common fence checks, while
   no public command can construct or replay it.

   Binding fields in prose are not sufficient. The current mutex assertion checks
   only the root string (`src/cli/sync-mutex.ts:163-165`); the capability must also
   reject a degraded handle, a released/lost lock, a new handle substituted for
   the recorded one, a wrong nonce/workspace/stream/phase, and replay after phase
   2. Recovery must mint a fresh invocation-local capability only after durable
   journal validation and healthy lock ownership. The opaque `WeakMap` consent
   witness is an available authenticity precedent
   (`src/cli/reset-consent.ts:3-107`). Add positive nested propagation and all
   negative/replay cases to the binding matrix.

9. **HIGH — recovery and B-only Git retention have undefined physical states.**

   “After phase 2 begins, keep A” (`332-338`) is too early a boundary. The normal
   phase-2 sync can crash after config creation, during file apply, during Git
   apply, after state save, or before its no-op push. Until baseline establishment
   is durably classified, there may be only a partial A tree/BASE. Marking abort
   terminal there can expose a state that is neither restored B nor established
   A. Define at least pre-phase-2, phase-2-incomplete, baseline-established, and
   overlay-started abort rows, including config/state disposition.

   For a B-only ordinary dir repo, leaving `.git` in the stash can retain its admin
   state. A pointer repo is different: the retained `.git` file may point to a
   common/git directory outside the workspace. With no baseline target, phase 3
   performs no union, so line `142` has not retained that Git state *under the
   adoption area*. Specify a local bare/bundle snapshot, or reject the external
   pointer shape before mutation. A binding test must remove/unavailable the
   external source after adoption and still prove the promised local
   reachability/reporting. Also test that the live worktree leaves overlay as
   ordinary files while no retained `.git`/source state enters scans.

10. **HIGH — phase-0/phase-1 control, capacity, and scale contracts are not implementable as written.**

    Acquiring the workspace mutex creates `.rbox/state/sync.lock`
    (`src/cli/sync-mutex.ts:47-49,125-160`). Phase 1 says to move pre-join content
    except the adoption control directory. If that includes the rest of `.rbox`,
    moving the live lock path defeats the fence by allowing another owner to
    create/acquire a new path. If all `.rbox` is excluded—as D8 appears to
    intend—say so and define retention/reporting for pre-existing unbound `.rbox`
    content.

    The headroom envelope also omits fetch-union. While B's complete object store
    remains in the stash, local fetch can copy every B-unique object/pack into A's
    live object store, plus pack/index/temp overhead. Peak is not merely phase-2 B
    plus A (`66-67`, `227-230`). Add an explicit conservative bound or a
    recoverable ENOSPC protocol and low-space test.

    Finally, one `journal.json` containing every operation and durably advancing
    around every rename implies repeated rewrites of an unbounded file; at the
    engine's 200,000-entry ceiling this can become quadratic I/O. The reset
    precedent is deliberately bounded (`src/cli/reset-journal.ts:32-37,147-218`).
    Specify a bounded/chunked/append protocol, parse limits, admission caps, and a
    large-inventory test. Mount-point detection also needs a cross-platform,
    fail-closed algorithm; comparing `dev` does not detect same-device bind
    mounts.

11. **HIGH — the binding matrix does not bind the mechanisms on which v3 now depends.**

    The matrix does cover the synthesis's headline additions: A-only survival,
    same/type collisions, diverged/behind/detached/stash/tag cases, nesting,
    same-stream/mode/consent refusal, kill/power shapes, degraded/fence/kill
    switch, hardlink/symlink/mode/mount/special handling, ignore independence,
    warm hash/dir caches, incarnation, 20+ fanout, and retention.

    It still needs mandatory rows for:

    - literal fetch argv: no live auto-followed tag, no submodule recursion or
      network, no FETCH_HEAD mutation if that is the contract, and no parked ref
      in the captured bundle;
    - pointer/scoped refs, linked-worktree ownership, concurrent checkout/ABA,
      probe error, actual CAS failure, no stale-proof retry, and CAS-blocked abort;
    - A staged/sparse/ITA/unmerged index and merge/rebase state, including crash
      and abort around ref/index publication;
    - Git-plane containment through an A symlink parent;
    - large-file stat alias, destination/parent writer races, hostile control
      paths, unwritable destinations, and directory metadata policy;
    - every manifest publisher/applier obeying the fence;
    - continuation wrong-tuple, wrong/lost/degraded mutex, public-owner use,
      replay, and resume reminting;
    - persistent tracked-cache collision and an already-running daemon crossing
      completion/resume/abort;
    - abort during each phase-2 substate and the first post-abort full scan;
    - B-only dir and external-pointer repos, with retained trees proven absent
      from normal scans;
    - fetch-union low-space recovery and a high-cardinality journal; and
    - if R2B-3 remains accepted literally, 100+, 256, and lower-cap fanout with
      exact BASE/origin/deferral assertions rather than only the 20+ synthesis
      row.

The design should retain the v3 architectural pivot, repair these state-machine
and physical-protocol holes, and return for another serial review before
implementation.
