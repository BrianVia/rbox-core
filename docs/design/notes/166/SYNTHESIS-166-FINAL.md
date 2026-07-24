# 166 final-review synthesis — rulings for v4 (targeted; 12/16 r2 items FOLDED)

REVIEW-166-FINAL.md: CHANGES-REQUIRED — layer and de-swap confirmed again;
6 new BLOCKERs + 2 HIGHs, all mechanical specifics. All accepted. Rulings:

## F1 (their B1, fetch creates live tags + adopt namespace captured)
KILL the import-everything union. v4: fetch ONLY proven-fast-forwardable
branches, one explicit refspec each, with --no-tags; nothing else is ever
fetched into the baseline repo. Divergent/behind/tags/stash/detached state
is NOT imported anywhere — the retained STASH REPO ITSELF is the parking
namespace (it already exists, is already journaled/reported, already
outside every capture surface). `rbox adopt status` reports from the stash.
This deletes the refs/adopt/* in-repo namespace entirely and with it the
capture-leak class. Binding test: after adoption, the baseline repo's ref
set differs from pre-adoption ONLY by the fast-forwarded branch tips.

## F2 (their B2, CAS scope/ownership/pause)
Fold their protocol: enumerate ref ownership (linked worktrees per 165's
branchesCheckedOutElsewhere), pointer-repo scope honored (only the scoped
branch may ff), CAS failure → journaled pause state with classifier resume
(never silent retry), every ff recorded before/after in the journal.

## F3 (their B3, index rebuild destroys A state)
Journal-copy the pre-op index file into the adopt area FIRST (that is the
inverse), then `git read-tree` to the post-ff HEAD. Only for the checked-out
branch's repo; abort restores the journaled index.

## F4 (their B4, symlink escape to outside repos)
Containment proof before any repo mutation: no-follow component walk of the
repo path + realpath-inside-workspace check (fsutil precedent), refusal
parks the repo (stash retention covers it).

## F5 (their B5, journal identity strength)
Content hash for every displaced/overlaid leaf (streamed, any size);
identity tuple (ino, size, mtimeNs, birthtime) recorded additionally;
classifier states: match=proceed, mismatch=pause (never overwrite an
unrecognized live value — the no-clobber rule is identity-gated rename:
verify-then-rename with the destination held via O_NOFOLLOW dirfd ops).

## F6 (their B6, fence coverage)
The fence check moves INTO the shared sync-mutex acquisition path (one
choke point) rather than per-caller memos; enumerate and test every
publisher the reviewer names (daemon, one-shot, push, pull, export,
restore, versions-restore, git resolve) — anything acquiring the workspace
mutex for mutation refuses on an incomplete adopt.

## F7/F8 (cache generations; continuation authority)
Fold their specifics: trackedness/dircache/hash-leaf invalidation
enumerated; resident-daemon signal (bump a workspace generation the daemon
watches); abort also invalidates. Continuation = single-use nonce bound to
(journal id, phase, mutex incarnation), persisted in the journal, consumed
on use; reconstruction only via adopt resume validation.

Fold to v4, keep everything already FOLDED verbatim, cite FINAL findings at
each site, status "v4 — pending delta verification". Then delta-verify
(163 playbook): one reviewer confirms the 8 rulings closed + nothing
regressed → ALIGNED → implementation.
