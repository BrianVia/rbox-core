# 166 v5 rulings — closing the last 3 (5 of 8 already CLOSED; refuse, don't patch)

Delta verdict: CHANGES-REQUIRED, but F5/F6/F7/F8 CLOSED and F1/F2/F3/F4 each
one specific edge from closed. All three live findings resolved by the
battle-tested-primitive / refuse-the-exotic move, not more machinery:

## G1 (delta-1, mutable-source fetch race) — fetch by exact OID
Fetch the JOURNALED 40-hex OID, never the branch name:
`git fetch --no-tags --no-recurse-submodules --no-write-fetch-head
<stash-repo> <proved-oid>`. The reviewer's own local probe confirms this
transfers only that commit, creates no ref, touches no FETCH_HEAD. A source
writer moving the branch after the proof is then irrelevant — the proved
object is fetched or (if GC'd) the fetch fails and the repo parks. Closes
the "imports unproved D" race and makes the complete-ref-set assertion
sound. Binding rows: source-moved-before-fetch, source-moved-after-proof,
proved-object-GC'd → in every case the moved-to tip is ABSENT from A's
object store.

## G2 (delta-2, checked-out index destruction) — GATE, don't compose
Per the growing-complexity rule: do NOT build a successful-path index/
op-state composition (that's the machinery that keeps breaking). REFUSE.
A repo whose checked-out branch fast-forwards is eligible ONLY when
`indexTree == HEAD tree` AND no operation state exists (no MERGE_HEAD/
rebase/etc). Otherwise the branch ff is PARKED (retained in stash, reported)
— the user finishes their merge/rebase, re-runs adopt resume. Clean the
common case perfectly; refuse the dirty-index/mid-operation case safely.
This is strictly simpler than v4 and closes FINAL-3 completely (the abort
copy stays for the eligible read-tree). Binding: conflicted-merge repo →
parked, not rebuilt; clean repo → ff + read-tree.

## G3 (delta-3, pointer/linked-worktree source) — REFUSE at preflight
A linked worktree's .git resolves its common/object store OUTSIDE the moved
stash dir (shared.ts:281-328) — it cannot be a self-contained parking
surface. Do not try to snapshot it. REFUSE linked-worktree / pointer-repo
sources at phase-0 inventory: detect via the existing shape probe, leave
them in place (not moved to stash — they're not self-contained), report
"linked worktree not adopted — its history travels with its main clone"
(the exact language the git-sync summary already uses for skipped
worktrees). Only self-contained ordinary directory repos and plain files
adopt. This makes F2/F4 consistent (no external-source containment problem
exists) and matches how the product ALREADY treats linked worktrees in
capture (they skip). Binding: linked-worktree source → refused + reported,
its main clone adopts normally.

Fold to v5, keep all CLOSED/FOLDED material verbatim, cite delta findings,
status "v5 — pending delta verification". Then one more delta pass → ALIGNED.
