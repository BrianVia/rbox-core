# 207 — Repo-removal residue: sweep what rmdir proves empty, show the rest

Status: ALIGNED r3 (tier-2 retirement and bundle retention DESCOPED on
review; serial-gate hardening folded — see REVIEW-207.md)
Fixes: #460 (visible ghost skeleton + doctor blindness). Successor work
seeded in §Descoped.

## Problem (field evidence)

Burn-in repro (Mac→FM, 2026-07-26): clone savvy-core into the workspace, sync
to FM, `rm -rf` on the Mac. The manifest delta applies on FM in ~4s
(`removed=1`, ~4.9k unlinks) — but the repo directory survives on FM with
~30M of residue, and `rbox doctor` reports `leftover worktrees: 0`.

Residue classes:

1. **Empty directory skeleton** (`media/`, `links/`, `metadata/`, …): the
   file plane's `deleteEntry` unlinks files and never rmdirs parents
   (`src/engine/apply.ts:441-459`; the sync apply path has no directory
   removal — the type-flip path at `apply.ts:306` moves dirs through trash
   but never fires on plain deletes).
2. **`<repo>/.git`, deliberately preserved**: the whole-repo-removal branch
   (`src/cli/sync-git/apply.ts:713-757`) is state-only — "local .git
   untouched. Your local Git repository is safe." Correct as a default; the
   receiver may hold local commits/reflog-only work/hooks/config the
   identity machinery cannot prove absent. Bulk of the bytes.
3. **`<repo>/.rbox/` quarantine artifacts**: `quarantineLocal` writes a
   bundle + index/op-state copies to `<repo>/.rbox/git-quarantine/<ts>.*` on
   mutating applies (`src/engine/git/apply.ts:459-466`,
   `src/engine/git/quarantine.ts:17-45`), conflict bundles to
   `.rbox/git-conflicts` (`quarantine.ts:95-99`). No pruner exists — but
   these are RECOVERY state, not litter: after a partially-published
   mutation with a hard-held rollback, a bundle can be the only pre-failure
   copy of user state (`engine/git/apply.ts:748-769`), and nothing durable
   marks which bundles are still needed. Their lifecycle is a separate
   design (§Descoped).
4. **Workspace-root artifacts**: journal keys
   (`src/engine/git/journal.ts:148`), journal-retired **whole `.git`
   trees** (`journal.ts:838-846` — "never rm -rf; preserve the entire
   partial repository"), and ORIG_HEAD forensic breadcrumbs sharing the
   SAME `<workspace>/.rbox/git-quarantine/<sha16>/` tree
   (`src/cli/sync-git/orig-head.ts:56-58`, deliberate per design 126).
   Never auto-deleted — doctor-surfaced only.

Why doctor is blind: `collectLeftoverWorktrees` (`src/cli/doctor-cmd.ts:439-489`)
is a design-200 ref-ownership check over `git worktree list`; it skips the
main worktree by construction and has no byte/residue dimension.

## Mechanism (deliberately narrow)

### 1. Empty-skeleton sweep at removal time (rmdir-only)

Hook: the `!remoteSec` whole-repo-removal branch
(`src/cli/sync-git/apply.ts:713-757`), after the state transitions. Fires
once per removal (removal-memory keys never re-enter the
remote ∪ base ∪ pending iteration at `apply.ts:365` — accepted: a residue
that survives this one pass is doctor's job, not retried).

Bottom-up sweep of directories under `repoDir`, `fs.rmdir` ONLY:

- `rmdir` is the leaf-level safety proof — ENOTEMPTY atomically refuses
  anything holding data, including `.git`, `.rbox`, nested repos, untracked
  files, conflict copies. No emptiness pre-walk feeds a delete decision.
- Traversal MUST use the adopt precedent's anchored form
  (`src/cli/adopt-fs.ts:179-195`), not path-based walking: open the parent
  directory handle (no-follow), verify dev/inode identity, and `rmdir`
  relative to that pinned handle. Path-based `lstat`-then-`rmdir` leaves a
  window where a concurrent process swaps an inspected ancestor for a
  symlink and the sweep removes empty directories OUTSIDE `repoDir`
  (`assertWithinRoot` is itself check-then-use and cannot close this).
  With anchoring, the residual race is bounded to "a concurrently created
  empty directory inside the residue may be removed" — an empty dir, no
  data. Stop at the first failure per subtree; ENOTEMPTY/ENOTDIR/EACCES
  are silent leave-in-place.
- Refuse `rel === "."` (workspace-root repo, `sync-git/shared.ts:95`) — the
  sweep never considers the workspace root itself. `assertWithinRoot` on
  every path.
- The repo dir itself is included: a fully-empty leftover disappears
  entirely (fresh-clone-then-delete case — the founder's repro — where the
  file plane deleted everything and no `.git`/`.rbox` bytes remain... which
  cannot happen while class 2/3 exist; in practice the top dir stays and
  doctor names it. The sweep still removes ALL empty interior skeleton).

### 2. Journal key clearing

`<workspace>/.rbox/state/git-journal/<key(rel)>` for the removed rel is
cleared via the existing journal-clear helper in the same branch — rbox
lifecycle state whose normal lifecycle already clears it on published
recovery / checkout completion (`follow.ts:337`, `journal.ts:213`); this
just covers the removal arm. Journal-retired `.git` trees and everything
under the workspace-root `git-quarantine` ancestor (retired trees directly
under it; ORIG_HEAD bytes under `<sha16>/` subdirs — sibling layouts, one
shared ancestor) are NOT touched (class 4 contract).

### 3. Doctor `repo residue` section

New section in `collectDoctorContext` (`doctor-cmd.ts:546-577`) driven by
`state.gitReposRemoved`, reporting only entries whose path still exists
(no phantom rows after a manual rm):

- Per repo: path, `.git` present, `<repo>/.rbox` present, identity verdict
  `match | mismatch | unknown` vs the removal memory. The verdict is
  **informational only** — `match` means "the sync identity still equals
  the removal-time fingerprint," which is stamped from the LIVE repo at
  removal (`apply.ts:720`; busy repos stamp a projected base identity,
  `apply.ts:735`) and blind to config/hooks/reflog-only objects
  (`identity.ts:90`). It never authorizes deletion and the copy never says
  "safe to delete" (`unknown` never renders as "contains local history"
  either).
- Coverage is honest, not complete: the section is driven by removal
  memories, which exist only when `.git` was present at removal and are
  pruned when `.git` later disappears (`plan.ts:424`) — skeleton-only or
  `.rbox`-only residue without a memory is out of scope here (the sweep in
  §1 is what prevents the common case).
- Presence only by default — no recursive byte walks on every doctor run
  (`rbox doctor --residue-bytes` can size them on demand).
- **Local-only**: paths/repo names stay in the path-bearing local output,
  never in uploaded diagnostics (existing split, `doctor-cmd.ts:63-117`);
  the uploaded record carries counts only.
- Copy (non-developer bar, neutral): `left behind after '<rel>' was
  removed on another machine — contains a local Git repository rbox will
  not delete. review it yourself before removing anything.`
- Also reports size-on-disk of `<workspace>/.rbox/git-quarantine` AND the
  per-repo `.rbox/git-quarantine`/`.rbox/git-conflicts` of current base
  repos (stat walks over known artifact dirs only, read-only) so class-3/4
  growth is visible ahead of #470.
- `leftover worktrees` stays untouched (different question).

## Descoped from r1 (with reasons — successor seeds)

- **Tier-2 whole-directory retirement to trash.** r1's authorization
  predicate was self-referential (`removedMem[rel]` is stamped from the
  same live identity in the same branch — `apply.ts:720-741` — so equality
  always passes, INCLUDING over a local commit made before the removal
  arrived). Repairing it runs into: `gitIdentity` blind spots (reflog-only
  commits, `.git/config`, hooks, `hash-object -w`, unborn repos),
  fail-open `listWorktrees` (`engine/git/shared.ts:483-495`),
  validate-then-rename TOCTOU with no fence, trash batch lifecycle not
  covering the git lane (`pull.ts:325`/`358` vs `:394`), `trash.days === 0`
  configs, and 2-GiB size-cap eviction making "recoverable" a weeks-or-less
  promise (`workspace-config.ts:66-69`, `trash.ts:159-185`). Four+
  independent counterexample classes = wrong-layer signal. A future design
  needs genuine provenance (e.g. a durable "materialized-by-rbox, never
  user-touched" marker maintained across the repo's life, not reconstructed
  at removal time).
- **Quarantine/conflict bundle retention.** Bundles are
  quarantine-before-destruction recovery state; nothing durable pins
  "still needed for an unresolved failure" (the CLI drops
  `res.conflictBundle` at `sync-git/apply.ts:1747`), and `refs/rbox-conflict/*`
  is NOT a parallel copy (only `preserveGitConflict` writes it). Retention
  without a pinning/supersession protocol can delete the only recovery
  copy. Needs its own design; the doctor size line above keeps the growth
  observable meanwhile. Tracked as a new issue.
- **Deleting `<repo>/.rbox` contents at removal.** Same recovery-state
  argument; also `.rbox` is NOT hard-excluded at depth (only workspace-root
  `.rbox` is — `ignore.ts:316-320`; the `BUILTIN_IGNORE` entry is an
  ordinary ignore a negation can re-include), so "no user content can live
  there" is not provable. Doctor names it instead.

## Non-goals

- No change to the "local .git untouched" contract.
- No `rbox gc` verb yet (doctor prints the exact manual command).
- No file-plane rmdir-on-every-delete; the sweep runs only in the
  repo-removal branch.

## Tests

Extend: `src/cli/sync-git/follow-matrix.test.ts`,
`lazy-apply-probes.test.ts`, `doctor-cmd.test.ts:315-344`.

1. Skeleton pruned: whole-repo delete leaves no empty dirs; `.git` and
   `.rbox` (and their parents) survive untouched.
2. Nested repo/submodule dir survives (ENOTEMPTY chain) — the sweep never
   removes a dir containing anything.
3. Symlink (incl. one named like a dir in the skeleton) is never followed
   or removed.
4. `rel === "."`: sweep refuses; workspace root intact.
5. Busy/failed rmdir mid-sweep: partial sweep, no error surfaced, next
   doctor still reports.
6. Journal key cleared; workspace-root `git-quarantine` and journal-retired
   `.git` trees untouched.
7. Doctor: residue entry rendered local-only with identity verdict; absent
   path → no row; uploaded diagnostics carry counts only; quarantine size
   line present; `leftover worktrees` stays 0.
8. No-op pull performs zero rmdir calls.
9. The founder's repro end-to-end: clone → sync → rm -rf → apply → interior
   skeleton gone, doctor names the `<repo>` leftover with the manual
   command.

## Risks

- The sweep's only mutation is anchored `rmdir` — with dirfd anchoring the
  worst race outcome is a concurrently created EMPTY directory being
  removed; without anchoring it would be out-of-tree rmdir via symlink
  swap, which is why the anchored form is mandatory, not stylistic.
- Trash cap note for the descoped successor: 2 GiB is the default, not the
  max (`workspace-config.ts:66` allows up to 1 TiB).
- One-shot semantics mean vetoed residue persists until manual action;
  accepted and doctor-visible (a gc verb is the escape hatch if field
  demand shows).
- Doctor `--residue-bytes` walks are user-invoked only.
