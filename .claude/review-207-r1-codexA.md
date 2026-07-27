Verdict: **CHANGES-REQUIRED**

The central safety claim is invalid: `gitReposRemoved` records “what was present when removal was observed,” not “what rbox last materialized.” Tier 2 can therefore retire user-authored Git state.

## Findings

1. **HIGH — The Tier-2 trigger cannot work literally as specified.**

   On the first remote deletion, `state.gitReposRemoved` normally does not contain the repo. The branch computes live identity and stamps only its local `removedMem` copy at [apply.ts:720](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:720) and [apply.ts:734](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:734).

   On later pulls, removal-memory-only repos are not processed: iteration is remote ∪ base ∪ pending, excluding `removedMem`, at [apply.ts:332](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:332) and [apply.ts:365](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:365).

   Therefore:

   - Checking persisted `state.gitReposRemoved` misses the initial removal and never gets another pass.
   - Checking the newly stamped `removedMem` weakens the predicate into the unsafe case below.
   - Adding removed-memory keys to iteration changes no-op behavior and needs a new design.

2. **HIGH — Removal-memory equality does not prove “exactly what rbox materialized.”**

   The removal branch stamps the live receiver identity, including any local commits, current stash, staged work, or operation state already present when the remote deletion arrives. It does not compare that identity to the prior rbox-authored base before stamping it: [apply.ts:720-740](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:720).

   Concrete sequence:

   1. Machine B creates a local commit while offline.
   2. Machine A deletes the repo and publishes.
   3. B pulls. Current code preserves `.git` and stamps the identity containing B’s commit.
   4. Any later Tier-2 pass sees equality and calls the repo “clean.”
   5. The repo is moved to auto-pruned trash.

   Test 4 only covers a commit made *after* memory was stamped. It misses the dangerous commit-before-removal sequence.

   Existing `cleanMaterialize` is not equivalent precedent: before wiping, it creates a mandatory recovery quarantine at [engine/git/apply.ts:457](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/apply.ts:457). Tier 2 first deletes those quarantines and later relies on temporary trash retention.

3. **HIGH — `gitIdentity` omits multiple classes of user-owned Git state.**

   Identity contains only HEAD, syncable refs, index tree, and selected operation-state files: [identity.ts:13](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/identity.ts:13), [identity.ts:21](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/identity.ts:21), [identity.ts:95](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/identity.ts:95). “All refs” actually filters to heads, tags, and current `refs/stash`: [refs.ts:16](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/refs.ts:16), [manifest-validate.ts:292](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/manifest-validate.ts:292).

   Equal-identity user-work sequences include:

   - Commit, then `reset --hard` to the old tip: the commit is reflog-only.
   - Stash, then drop/clear it: dropped stash objects may be reflog-only.
   - `git hash-object -w`: writes the only object copy without changing identity.
   - Edit `.git/config`, `config.worktree`, hooks, `info/exclude`, notes, replace refs, remote refs, or arbitrary `.git` metadata.
   - Add hooks/config/objects to an unborn repo: `gitIdentity` returns `undefined` when HEAD is absent, collapsing it to `"none"`.

   Thus the claims “refs/HEAD/index byte-identical” and “no local commits/stash” are both too strong.

4. **HIGH — Identity, busy, worktree, and emptiness checks are TOCTOU-unsafe.**

   `getBusy` and `getLocalId` are memoized at [apply.ts:694-710](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:694). Busy checks only currently visible Git lockfiles and `gc.pid`: [shared.ts:721](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/shared.ts:721). Identity itself is a series of separate reads, not a snapshot.

   Concrete race:

   1. Identity and busy checks pass.
   2. Empty-directory walk visits directory `d`.
   3. An editor atomically writes `d/new-work`.
   4. `TrashBatch.put(rel)` renames the entire repo, including `new-work`.
   5. Normal size/age pruning later recursively deletes its only copy.

   A crash before rename leaves the source intact. A crash after rename leaves it in trash. The unsupported case is concurrent user mutation between validation and rename.

   Fresh rechecks narrow but cannot eliminate this race. The design needs an explicit concurrency protocol—such as rename-then-revalidate-and-rollback—or must drop whole-directory automatic retirement.

5. **HIGH — The proposed worktree authorization fails open.**

   `listWorktrees()` is explicitly lossy and converts any Git read failure to `[]`: [shared.ts:483-495](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/shared.ts:483). It cannot authorize retirement.

   The design must use `listWorktreesStrict()`, require `status: "ok"`, and reject every associated live linked worktree other than the main entry—not merely worktrees physically “under” the repo. Moving the main `.git` store breaks linked worktrees located elsewhere too. A concurrent `git worktree add` remains another race.

6. **HIGH — Tier 1 can delete the only recovery copy of user state.**

   `quarantineLocal` stores refs/WIP plus exact index and operation-state copies: [quarantine.ts:17-45](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/quarantine.ts:17). If mutation partially succeeds and rollback hard-holds, the bundle can be the only pre-failure recovery set: [engine/git/apply.ts:748-769](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/apply.ts:748).

   Tier 1 deletes this directory before any Tier-2 veto. “Rbox created it” establishes ownership, not redundancy or dispensability.

   The “every byte is rbox-written” assertion is also false. These are ordinary user-writable directories. More seriously, nested `.rbox` is not hard-excluded by `isHardExcluded`; only workspace-root `.rbox` is: [ignore.ts:316-320](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:316). I verified that `.rboxignore` negations can re-include `repo/.rbox/keep`. Recursive deletion of named subdirectories can therefore delete locally created or even synced user content.

7. **HIGH — Time/count retention can prune the only usable recovery set.**

   Sequence:

   1. Apply A creates Q1.
   2. Mutation partially publishes.
   3. Rollback fails; Q1 contains the only exact old index/op-state.
   4. Later applies create Q2–Q5 from the damaged state.
   5. Once Q1 is older than seven days and outside keep-3, it is pruned.

   No durable metadata pins a bundle needed by a hard-held failure. The CLI ignores `res.conflictBundle` when recording the deferral at [sync-git/apply.ts:1747](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync-git/apply.ts:1747).

   The fallback claimed at design lines 159–162 is incorrect: `refs/rbox-conflict/*` is created only by `preserveGitConflict`, not by ordinary `quarantineLocal`: [quarantine.ts:83-100](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/quarantine.ts:83).

   Retention needs durable “required for recovery” pinning or proof of supersession before deletion.

8. **HIGH — No usable trash batch exists when Tier 2 runs.**

   The batch opens at [pull.ts:325](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/pull.ts:325), is passed only to file-plane apply, and is finished at [pull.ts:358-360](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/pull.ts:358). Git apply begins later at [pull.ts:394-409](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/pull.ts:394). `applyGitSections` currently has no trash option.

   Reusing the finished object is unsafe:

   - If it was never armed, a later put creates an `.active` marker that is never finished.
   - If it was armed, `finish()` removes the marker while `armed` stays true, so a later put is unprotected from pruning: [trash.ts:61-95](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/trash.ts:61).

   The batch lifetime must cover Git apply, or Git retirement needs its own correctly finalized batch.

9. **MED — Trash-disabled configuration is unspecified.**

   `trash.days === 0` intentionally creates no batch: [pull.ts:325](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/sync/pull.ts:325), [workspace-config.ts:56-82](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/workspace-config.ts:56).

   The design must say whether Tier 2:

   - Is disabled when trash is disabled, or
   - Overrides the user’s configuration with mandatory retention.

   It must never fall back to immediate deletion while claiming recoverability.

10. **MED — The path-based emptiness/sweep contract can follow swapped symlink components.**

   `lstat(path)` followed later by `readdir(path)` is not “never follow symlinks”: a directory can be replaced with a symlink between calls. A bottom-up `rmdir(repo/a/b)` can similarly traverse a replaced `repo/a`.

   `assertWithinRoot` is a check, not a mutation fence: [fsutil.ts:146-169](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/fsutil.ts:146). The stronger Git containment helper explicitly excludes local path-replacement races: [containment.ts:6-14](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/containment.ts:6).

   A plain `rmdir` is safe against a file added directly to that directory—it atomically returns `ENOTEMPTY`. Tier 3 therefore has a sound leaf operation, but not a specified race-safe traversal. The cited adopt precedent is stronger than proposed: it uses opened-parent handles and dev/inode/birthtime checks before `rmdir`: [adopt-fs.ts:179-195](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/adopt-fs.ts:179).

11. **MED — Workspace-root quarantine residue is identified but neither cleaned nor reported.**

   Created-fresh recovery moves `.git` to workspace `.rbox/git-quarantine/...`: [journal.ts:838-846](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/journal.ts:838). Other journal retirement uses `.rbox/state/git-journal-quarantine/...`: [journal.ts:450-462](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/git/journal.ts:450).

   Tier 1 names only repo-local bundle directories and the active journal key; doctor is scoped to removed repo paths. The workspace-root residue class remains hidden and unbounded.

12. **MED — Doctor needs an explicit privacy and uncertainty contract.**

   Current doctor intentionally separates path-bearing local output from uploaded diagnostics; uploaded worktree entries cannot contain paths: [doctor-cmd.ts:63-117](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/doctor-cmd.ts:63), [doctor-cmd.ts:479-488](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/doctor-cmd.ts:479). The proposed repo names, paths, and byte totals need an explicit local-only/redacted split.

   Identity must be `match | mismatch | unknown`, not yes/no. `gitIdentity` returns undefined for no-HEAD or unusable repos and can use a raw-index fallback. “Unknown” must not produce “contains local Git history” or authorize cleanup.

## Claim and anchor audit

- `engine/apply.ts:442-460`: correctly shows file deletion without parent `rmdir`. The broader claim that no directory removal exists anywhere in apply is false; type-flip paths can move whole directories through trash at `apply.ts:306`.
- `sync-git/apply.ts:713-757`: accurate removal-branch anchor and confirms current state-only behavior.
- `engine/git/apply.ts:344`: accurately identifies `.rbox` staging creation.
- `engine/git/apply.ts:459-466` and `quarantine.ts:17-45`: accurate quarantine anchors. “Every mutating apply” is imprecise; quarantine can remain after an attempt that later defers or fails.
- `quarantine.ts:95-99`: accurate conflict-bundle location.
- `ignore.ts:18`: confirms a default ignore pattern, not hard exclusion at every depth. The hard-exclusion claim is false for nested `.rbox`.
- `journal.ts:148` and `838-846`: accurate. The latter retires `.git`, not the whole repo.
- `doctor-cmd.ts:439-490`: accurate; it skips the main worktree and has no byte dimension.
- `pull.ts:347`: accurate matcher-filter anchor.
- `engine/apply.ts:457`: effectively accurate for visible conflict preservation; the move occurs at line 458.
- `trash.ts:83`: stale by two lines; rename is currently line 85.
- `quarantine.ts:65`: stale; the directory-kind refusal is line 63.
- `adopt-fs.ts:185-191`: relevant but materially stronger than the proposed path-based sweep.
- The claim that directory `TrashBatch.put` is untested is false; an existing whole-directory case starts at [trash.test.ts:44](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/trash.test.ts:44).
- Retention test 13 contradicts the policy: five recent applies must all survive the seven-day floor. The test must explicitly age the first two beyond seven days.
- The design defines three tiers but calls the emptiness walk “tier 4” at line 163.
- The field measurements—38.7 KB, ~4 seconds, ~4.9k unlinks, ~30 MB—cannot be verified from source, although the code supports the described residue mechanism.

The safe revision is to retain Tier 3 and doctor visibility, remove automatic Tier-2 retirement unless a genuinely provenance-based and race-safe protocol is designed, and treat quarantine deletion as recovery-state lifecycle management rather than residue cleanup.