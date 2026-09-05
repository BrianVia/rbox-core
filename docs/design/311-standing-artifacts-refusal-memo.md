# 311 — Remember a standing-artifacts refusal until the protocol ref plane changes

Status: implemented.

## Measured

With design 309 in, the branch-deletion witness on via-desktop passes the cheap checks and
pays the full artifact scan every push (~200 `for-each-ref`/`cat-file` spawns, `carried≈1.4s`)
only to refuse the same branch for `artifacts-standing` — 206 standing CREATE-P receipts
(design 286) that nothing changes between pushes.

## Owner and rule

`branch-deletion-witness.ts`. A refusal whose reason is exactly `(artifacts-standing)` is
remembered per repository under a token of the protocol ref plane — every `refs/rbox-local/*`
ref and OID from one `for-each-ref`, plus the missing-branch set. On the next witness for the
same repository, if the token is unchanged the same refusal is returned before the scan.
Retirement, landing, settlement, a new receipt, or a change in which branches are missing
all change the token, so the memo can never outlive the facts it summarizes; a proven witness
deletes the entry; combined refusals (e.g. `artifacts-standing+worktree-owned`) are not
memoized because their other half can change without touching the ref plane.

Process-local, bounded by repository count, same discipline as designs 277/302/303. No
flags. Deletion condition: when design 310 lets standing CREATE-P receipts be discarded and
this refusal stops recurring per push.

## Validation

`git-sync.test.ts`: first witness refuses `(artifacts-standing)` with one protocol scan; the
second returns the same refusal with exactly one `for-each-ref` and no scan; after a new
`refs/rbox-local/*` ref appears the scan runs again. Plan suites green. Rollback: revert.
