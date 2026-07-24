# REVIEW-166-R2A — adversarial safety + crash-model review

## Verdict: CHANGES-REQUIRED

v2 does escape two important v1 failures for the narrow, fresh, clean,
strictly-ahead fixture: establishing the Git/file BASE through the normal join
removes the baseless `local-edits`/`local-index` wedge, and normal capture avoids
inventing a new BASE-composer authority. It does **not** escape every accepted v1
BLOCKER. The ancestry decision is no longer in the engine, but it still decides
which whole multi-plane repository becomes live; the normal pull does not
re-prove that decision. A-only deletion, index/op-state ordering, per-ref scope,
TOCTOU, and nested ownership are consequently re-imported at the overlay
boundary. Independently, the proposed move journal is not yet a crash protocol.

## Findings

1. **BLOCKER — the ancestry probe is semantic authority, not a harmless routing heuristic: the specified diverged/probe-error route and any wrong swap are published, not protectively deferred.**

   After phase 2, the remote Git section equals the saved Git BASE. On the final
   ordinary sync, pull computes `remoteChanged === false` and returns
   `unchanged` before comparing the live repo to that section
   (`src/cli/sync-git/apply.ts:759-768`). Push carries only on a full identity
   match; any swapped stash repo that differs from BASE falls through to capture
   (`src/cli/sync-git/plan.ts:568-595`). Capture serializes HEAD, all applicable
   refs, index, index tree, and operation state
   (`src/engine/git/capture.ts:207-295`), and push commits that new section
   (`src/cli/sync/push.ts:636-640`).

   Therefore the mandated `diverged | unrelated | probe error -> swap` route
   publishes B's whole divergent Git state as an ordinary post-sync local
   rewrite. A wrong swap of a behind repo does the same. There is no later engine
   proof that turns it into today's protective deferral; receiver-side holds may
   protect a particular follower only after current remote truth has already
   changed. A Git writer can also move refs/index/op-state between probe and swap,
   and the specified probe-error behavior is itself fail-open. Stash retention
   can make a correctly implemented operation locally reversible for a time; it
   cannot make the routing call non-authoritative or prove “never data loss.”
   This re-imports R1A-2/R1A-4/R1A-6 at join orchestration.

2. **BLOCKER — whole-repo replacement recreates the exact A-only deletion that v2 says is closed.**

   File sync scans a Git worktree; only `.git` itself is hard-excluded
   (`src/engine/ignore.ts:232-245`). Let A's baseline contain synced, Git-untracked
   `repo/a-only.txt`, while B's ahead repo lacks it. Replacing the baseline repo
   directory with B's stash directory removes that path from the live tree. The
   final pull sees `local=absent` and `remote=BASE=A`, so reconcile's
   remote-unchanged arm emits no restoring action
   (`src/engine/reconcile.ts:58-66`). Push then computes a real deletion
   (`src/engine/diff.ts:51-53`). The default push breaker permits every such wave
   below 1,000 entries (`src/cli/sync/policy.ts:22-34`). Pull trash is irrelevant:
   it is opened only for pull apply actions (`src/cli/sync/pull.ts:180-218`), not
   for an absence manufactured before push.

   Namespace type collisions make the same contradiction visible without Git.
   If baseline A has directory `x/a-only` and pre-join B has a regular file or
   symlink `x`, `rename(stash/x, root/x)` cannot replace the non-empty directory.
   Evicting A's directory lets B win but removes `x/a-only`; refusing the eviction
   means B did not overlay. The reverse file-to-directory flip also requires an
   explicit displacement. The existing apply path handles directory obstruction
   as a special eviction/trash transaction (`src/engine/apply.ts:268-282`), which
   demonstrates why “overlay never deletes” is not supplied by raw rename. This
   is R1A-3 at the repo/type-swap boundary.

3. **BLOCKER — “moves only” and “pre-join stash retained” cannot both be true, and the described journal cannot recover the required swaps.**

   Renaming `.rbox/adopt/stash/p` back to live `p` removes the stash name. In an
   ahead/diverged swap, the only B copy is then the live copy; if the baseline is
   moved into the stash slot, that slot contains A, not the promised pre-join
   copy. A plain-file rename over an existing destination also replaces that
   destination name, while a directory rename over a non-empty directory fails.
   Keeping an immutable B backup requires copying/reflinking or a separately
   retained tree; ordinary hardlinks are not an immutable backup because
   in-place writes mutate every name.

   A real repo replacement needs at least `live -> baseline-hold` and
   `stash -> live`, normally with a temporary third name. `phase + moved set +
   timestamps` and per-entry “move-or-skip” do not classify crashes after each
   rename, after a rename but before journal advance, or states changed by an
   intervening writer. Presence alone cannot identify whether live contains A,
   B, or new user bytes. The repo already has the stronger precedent: reset
   recovery uses exact identities/hashes and a closed physical-state classifier
   (`src/cli/reset-journal.ts:324-379,465-479`).

   Durability is also incomplete. Fsyncing the journal before moves orders the
   journal bytes, not the renamed directory entries. Power-loss safety requires
   ordered fsyncs of every changed source and destination parent before the next
   journal state is published; `fsyncDirectory` exists for precisely that
   distinction (`src/engine/fsutil.ts:39,62,70-78`). If “crash” means only process
   termination, the design must say so. The headroom claim is understated too:
   at phase-2 peak the complete B tree is in stash while the complete A baseline,
   including colliding files and Git materialization, is live. Net-new peak usage
   is not limited to A-only content.

4. **BLOCKER — an incomplete adopt journal is not a global sync fence, so a crash can convert a locally recoverable partial overlay into a fleet-visible mutation.**

   A healthy init mutex can serialize a live adopter if it is held from before
   journal publication through overlay completion. The design does not require
   that interval, and a process crash or finalization error releases/recoverably
   stales the lock. Current init writes `workspace.json` before its first sync
   (`src/cli/init-cmd.ts:386-417`), so a daemon can recognize the root after phase
   2. The daemon's operation boundary knows about the reset journal, not an adopt
   journal (`src/cli/daemon/daemon.ts:780-810,913-943`); one-shot sync likewise
   acquires the mutex and proceeds directly (`src/cli/sync-cmd.ts:55-76`). Because
   `.rbox/**` is hard-excluded, neither scan sees the stash. A daemon starting
   after a mid-overlay crash can thus publish the subset already overlaid,
   including finding 2's manufactured absences.

   Every pull/push/sync/daemon owner must inspect a validated adopt state while
   holding the mutex and refuse any non-overlay-complete physical state. The
   adopter needs a typed continuation authority for its own final sync. The kill
   switch may stop new adoption; it must never bypass recovery of an existing
   journal. Adoption must also refuse `workspaceSyncMutexDegraded`: current lock
   acquisition intentionally continues with an unlocked degraded handle on an
   unsupported filesystem (`src/cli/sync-mutex.ts:140-155`), which is unsuitable
   for whole-tree namespace surgery.

5. **BLOCKER — “most-specific-first” is physically incompatible with whole-directory ancestor swaps.**

   Start with `stash/outer/inner=B-inner` and
   `live/outer/inner=A-inner`. Swapping `inner` first correctly puts B-inner live.
   A later swap of `outer` necessarily moves that already-selected live inner
   away and installs the stash ancestor, whose inner slot now holds A-inner or a
   hole. Treating the child “as opaque” affects probing, not rename containment.
   The rule also fails when parent and child choose different swap/keep routes.

   Nested repos are an intentional supported shape: discovery does not stop at a
   repo boundary (`src/engine/git-discover.ts:14-26`), and root/child/grandchild
   cases are tested (`src/engine/git-nested.test.ts:78-97`). v2 needs an actual
   namespace algorithm—such as extracting descendants to independent journaled
   roots or assembling a selected tree before one publication—and crash rows for
   every ancestor decision × descendant decision. This re-imports R1A-5.

6. **BLOCKER — a same-workspace re-init does not establish the claimed clean baseline and can again publish A-only deletions.**

   v2 applies to non-empty `init --workspace` but does not exclude a root already
   bound to that same stream. Existing init resets state only when the stream
   changes (`src/cli/init-cmd.ts:377-385`). On same-stream re-init, the old file
   BASE survives phase 1. With the live tree moved aside, an A-only path has
   `local=absent`, `remote=old BASE`; reconcile treats that as a local-ahead
   deletion and materializes nothing (`src/engine/reconcile.ts:58-66`). Overlay
   cannot restore a path B never had, and the subsequent push publishes its
   absence.

   Either adoption must refuse every already-bound root (including same-stream),
   or the design needs a separately consented, fenced fresh-baseline transition
   for that case. Calling the existing join path is not sufficient.

7. **BLOCKER — the real join-mode surface contradicts mandatory phase 2 and the final ordinary sync.**

   The planner permits join `firstSync` values of `sync`, `pull`, or `none`:
   `--no-sync` yields no BASE and `--pull-only` forbids the final push
   (`src/cli/init-plan.ts:172-176`; the no-sync join is pinned at
   `src/cli/init-plan.test.ts:75-80`). Guided setup can forward `no-sync`
   (`src/cli/setup-cmd.ts:660-662`). More importantly, keyed setup permits a
   non-empty destination only with explicit `--force`, then invokes `runInit`
   with `no-interactive + pull-only` (`src/cli/setup-keyed.ts:52-60,94-105`)
   because shared-agent use is pull-only (`setup-keyed.ts:108-114`). v2's final
   push violates that security/behavior contract; honoring pull-only leaves the
   overlaid state deliberately unpublished.

   Also, today's ordinary join is not “init + first pull”: the default join calls
   `sync` (`src/cli/init-cmd.ts:484-503`), and `sync` is pull then push
   (`src/cli/sync/sync.ts:8-19`). A raced or unmovable residual entry can therefore
   publish during phase 2 before overlay. The design must narrow/refuse these
   modes or specify distinct resumable semantics for each; “all non-empty joins”
   is not implementable as written.

8. **HIGH — the behind/keep route still lets commit-tip ancestry discard every non-ref plane from the active result.**

   B can be behind at commit C0 while holding staged/unstaged edits, an in-progress
   merge/rebase, stash entries, B-only untracked files, tags, local-only branches,
   or detached-HEAD state. “Keep baseline repo” parks all of it in the ignored
   stash while the engine sees an exact clean BASE and therefore emits no
   deferral. The actual Git identity/capture intentionally includes index and
   op-state (`src/engine/git/identity.ts:87-100`;
   `src/engine/git/capture.ts:207-295`). Owned directory repos and pointer repos
   also have different all/scoped ref universes; the phrase “all tips” does not
   define missing names, tags, `refs/stash`/stash reflog, detached HEAD, or mixed
   per-ref direction.

   Retention prevents immediate erasure only if finding 3 is repaired. It does
   not make this an adoption: the valuable state is silent, the engine never
   examines it, and completion messaging tells the user the stash may later be
   cleared. The behind route needs a whole-repo cleanliness predicate plus a
   recorded, user-visible decision, or a non-destructive merge policy. This
   re-imports R1A-2/R1A-6 rather than delegating them to the engine.

9. **HIGH — same-volume, symlink-containment, and metadata guarantees are not established by the proposed rename walk.**

   Comparing the workspace root and stash root does not prove every source can be
   renamed: a top-level source may itself be another filesystem or mount point,
   yielding `EXDEV`/`EBUSY` after earlier entries have already moved. A pre-existing
   `.rbox` can also be a symlink or hostile non-directory. Adoption needs no-follow
   validation of every control-path component and every movable source before the
   first move; `ensureDirectoryChain` is the repository precedent for lstat-based
   symlink refusal (`src/engine/fsutil.ts:81-110`).

   A leaf overlay can escape the workspace if baseline A materializes a symlinked
   parent and B contains a descendant—for example A `d -> /outside`, B
   `d/file`. `rename(stash/d/file, live/d/file)` follows the destination's
   intermediate symlink unless the overlay uses the same containment guard as
   normal apply (`src/engine/fsutil.ts:125-148`;
   `src/engine/apply.ts:240-243`).

   A simple rename does preserve the moved inode's symlink identity, hardlink
   relationships, mode, ACLs/xattrs, and other inode metadata. But shared
   directories require a merge: moving leaves into A's directory loses B's
   directory metadata, while swapping the whole directory loses A-only children.
   Copy-based retention can also break hardlink topology, and special files are
   not represented by the normal manifest. The design needs an explicit
   no-follow/type/special-file policy and tests for hardlinks spanning rename
   batches, symlink parents, mode-000/read-only directories, mount points, and
   file↔directory flips.

10. **HIGH — ignore-layer parity is order-dependent and cannot literally govern the restoration walk.**

    `.git` is unconditionally hard-excluded from a normal matcher, yet adoption
    must restore `.git`; therefore all non-`.rbox` pre-join entries must be
    restored independently of ignore decisions. In addition, a normal matcher
    reads `.gitignore` and `.rboxignore` from the current disk tree when it is
    built (`src/engine/ignore.ts:279-304`). Overlay replaces A's rule files with
    B's, so a matcher frozen from the pulled baseline can disagree with the final
    normal scan. Normal pull handles exactly this by applying rule files first,
    rebuilding the matcher, and only then filtering other actions
    (`src/cli/sync/pull.ts:151-163,179-207`).

    Example: A's `.rboxignore` ignores `secret.txt`; B's re-includes it and has
    the file. Baseline routing says ignored, post-overlay normal scan says synced.
    The inverse is equally possible, and `respectGitignore` trackedness depends on
    which repo tree is present when the matcher is built. Specify independent
    restoration, rule-file ordering, and a final matcher rebuild; “same rules as
    normal scan” is not yet a parity contract.

11. **HIGH — the proposed interactive confirmation misses the actual wizard, while headless default-on has no affirmative adoption witness.**

    The interactive setup wizard deliberately constructs init flags containing
    `no-interactive=true` (`src/cli/setup-cmd.ts:58-70`). Its existing-workspace
    path confirms only cross-stream rebind, not ordinary non-empty adoption
    (`setup-cmd.ts:657-699`). A confirmation added merely where `runInit` computes
    `interactive` (`src/cli/init-cmd.ts:159-166`) would therefore make the wizard
    silently take v2's headless default-on path.

    Setup should prompt and pass a typed adoption-consent witness (or preserve a
    distinct interactive-caller signal), with explicit decline behavior. Direct
    headless `--no-interactive` currently means “do not prompt,” not “I authorize
    moving this complete tree twice”; require an affirmative flag/witness or
    justify and test that compatibility break. The confirmed inventory also
    needs revalidation before the first move: the workspace mutex excludes other
    sync owners, not arbitrary build tools or Git writers.

12. **HIGH — doctor/retention/version claims do not match the available recovery surfaces.**

    Main dispatch resolves a workspace before entering any doctor subcommand
    (`src/cli/main-dispatch.ts:353-366`), and root discovery requires
    `.rbox/workspace.json` (`src/cli/config.ts:655-667`). A crash after the adopt
    journal is created but before config publication cannot reach the promised
    `rbox doctor` resume/restore route. Recovery needs a local-only direct-path
    command that validates the journal without an existing binding, plus exact
    resume and abort semantics. Abort after phase 2 must also decide what happens
    to A's materialized baseline and the newly written config/BASE; a reverse
    rename is not sufficient once names collide.

    `.rbox/adopt/stash` is not `rbox trash`. Trash owns `.rbox/trash`, has its own
    active markers, pruning, listing, and collision-safe restore semantics
    (`src/engine/trash.ts:7-22,149-185`; `src/cli/trash-cmd.ts:1-24`). The design
    specifies no list/clear/restore command or retention duration for adopt data.
    Remote `versions` can preserve A's prior published file value within remote
    history retention, but it cannot recover never-published B state and is not a
    substitute for an immutable pre-join stash. The rollout is therefore not
    “fully reversible” as specified.

## v1 BLOCKER escape audit

- **Escaped for the narrow clean-ahead fixture:** the baseless first-join
  `local-edits`/`local-index`/`local-commits` wedge and rewind continuation; normal
  phase-2 BASE plus ordinary capture also avoids a new BASE-composer authority.
- **Re-imported:** index/op-state ordering and whole-section authority (findings
  1/8), sender-only/A-only deletion (finding 2, plus finding 6), TOCTOU (findings
  1/11), nested ownership (finding 5), and per-ref scope/tag/stash (finding 8).
- **New crash-layer blockers:** the retention contradiction and incomplete
  physical journal (finding 3), missing global adopt fence (finding 4), and real
  join-mode mismatches (findings 6/7).

The architectural pivot is directionally better than v1, but v2 does not yet
have a safe state machine or a non-authoritative routing heuristic. It is not
ready for implementation or a default-on rollout.
