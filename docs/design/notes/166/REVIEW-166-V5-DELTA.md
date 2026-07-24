# REVIEW-166-V5-DELTA — targeted v4→v5 delta verification

Reviewed `REVIEW-166-V4-DELTA.md` in full, `SYNTHESIS-166-V5.md`,
`FOLD-166-V5-NOTES.md`, and `docs/design/166-forward-adopt.md` v5.
Implementation spot-checks use the current tree at
`17e3104080262aac1e6ef439d8652166c4945366` and Git 2.54.0.

## Verdict: ALIGNED

V5 closes exactly the three live v4-delta findings. Fetch is bound to the
proved and journaled object rather than a mutable source ref; checked-out
fast-forwards are admitted only with an index tree equal to the current HEAD
tree and no operation state at both gates; and external pointer sources are
refused before journal publication or movement. The prior CLOSED/FOLDED
material remains intact, and no new contradiction was found.

## G1 — exact journaled-OID fetch: CLOSED

The layer invariant limits import to the object closure of an individually
proved, journaled 40-hex OID (`166:33-39`). Phase 3 journals that incoming OID
and then runs only:

```text
git fetch --no-tags --no-recurse-submodules --no-write-fetch-head \
  <stash-repo> <journaled-40-hex-oid>
```

(`166:192-218`). No branch name appears in the fetch. At the prepared mutation
boundary the design expressly does not dereference or require stability of the
source branch name; the target CAS can name only the journaled incoming OID
(`166:220-243`). Source movement therefore cannot substitute its moved-to tip.
If the proved object disappears, fetch failure PARKS before target ref or index
mutation (`166:211-215`). The journal and safety-property sections retain the
same binding (`166:341-344,550-552`).

The mandatory rows cover the literal argv, movement before fetch, movement
after proof/before CAS, and proved-object GC. Each requires the divergent
moved-to tip to remain absent from A (`166:591-594`).

A real local-Git probe reproduced the binding schedule after the source branch
moved from proved `I` to divergent `D`: fetching the literal `I` transferred
`I`, left `D` absent, created no ref, and left a sentinel `FETCH_HEAD`
byte-identical. After expiring reachability and pruning `I`, the same fetch
failed while target HEAD, index, and `FETCH_HEAD` remained unchanged. The
repository's generic Git runner passes the argv directly with repository-routing
environment variables cleared (`src/engine/git/shared.ts:74-93,112-126,200-211`).

## G2 — clean checked-out eligibility gate: CLOSED

For the target's checked-out branch, the initial gate requires both
`indexTree == HEAD tree` and absence of operation state. Failure to derive an
index tree, any tree mismatch, or any operation state PARKS before preparation,
fetch, CAS, index copy, or `read-tree` (`166:180-190`). After exact-OID fetch,
the prepared mutation boundary acquires the live index lock and repeats both
conditions immediately before the saved-index copy and ref CAS. A boundary
failure PARKS before CAS or `read-tree` and creates no prepared mutation
(`166:220-233`).

Only the branch that passes both gates reaches the saved-index inverse, CAS,
and post-fast-forward `git read-tree --reset <post-ff-HEAD>` path
(`166:245-258`). Journal, status, and recovery text follow that split
(`166:341-344,491-512`). The `conflicted-merge repo`, `clean repo`, and
ref/index crash rows bind the refused and admitted paths separately
(`166:605-607`). Every remaining `read-tree` mention is either an explicit
ineligible-path prohibition, eligible clean-path behavior, or recovery/test
metadata. The v4 read-tree-on-dirty successful path is gone.

This gate maps to existing primitives. `indexTreeOf` performs `write-tree` on a
copy of the resolved index and conservatively falls back to a non-tree raw
identity for an unmerged index (`src/engine/git/identity.ts:38-69`). Operation
state is read from the resolved per-worktree Git directory
(`src/engine/git/refs.ts:31-45`; `src/engine/git/shared.ts:281-328`), with an
exhaustive root classification at `src/engine/manifest-validate.ts:226-248`.
Implementation should mirror the existing root-presence probe at
`src/cli/sync-git/follow.ts:356-381,479-482` so an empty rebase directory is
still treated as live operation state. Targeted existing tests for copied-index
projection, unmerged fallback, and pointer Git directories passed.

## G3 — linked-worktree/pointer source refusal: CLOSED

Phase 0 inventories every Git root's shape and refuses the entire adoption
invocation upon finding a linked-worktree/pointer source, before journal
publication or any move. It leaves the pre-join source in place, emits the
required report, admits only ordinary self-contained repository sources and
plain file-plane content, and keeps a separate invocation on the ordinary main
clone eligible (`166:86-97`).

Phase 3 is consistent with that refusal: every source reaching it is declared
self-contained and ordinary; its worktree, Git directory, common directory,
and object store must remain inside the retained stash; and pointer scope is
now target-only. The text explicitly says B is never a pointer repository
(`166:140-172`). The safety property and `linked-worktree source` row repeat
the phase-0 disposition (`166:553-557,602`). The existing pointer-target row is
not a stale pointer-source route (`166:601`).

The shape is directly detectable in current code: `.git` directory maps to
`dir`, `.git` regular file maps to `pointer`, and the pointer Git/common
directories resolve from the gitfile and `commondir`
(`src/engine/git/shared.ts:281-328`). Discovery already distinguishes those
two no-follow shapes (`src/engine/git-discover.ts:35-45`).

## Preservation and contradiction audit

No regression was found in prior CLOSED/FOLDED material. The recorded v3
pre-fold snapshot still has SHA-256
`7f61ceeee4bd48ca81da6214b16c6cdc033517809d5ebdf63ea0fbd1aed141a4`.
Exact comparisons confirm that v5 retains the original D2 overlay block, all
of D5 and D6, and the previously called-out A-only, collision, type-flip,
nested-repository, same-stream, unsupported-mode, consent, Git-incarnation,
and finish-fanout rows. F5's full-identity/no-clobber protocol, F6's shared
fence, F7's cache generations, and F8's continuation authority and their
binding rows remain represented without semantic change.

The full design contains no adoption parking namespace, wildcard/import-all
fetch, or source-branch fetch. Each of the six required v5 binding labels occurs
exactly once, all binding-table rows have the expected three-column shape, and
`git diff --check -- docs/design/166-forward-adopt.md` passes. Pointer targets
remain deliberately scoped while pointer sources are refused, so G3 does not
conflict with the previously closed ownership rule. A failed second G2 gate may
leave only the already-fetched exact object unreachable; it still performs no
ref/index mutation, matching the G1 and G2 safety boundaries.

Design 166 v5 is aligned and ready to proceed to implementation.
