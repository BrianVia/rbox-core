# 310 — A CREATE-P receipt matching this device's own BASE is a completed landing

Status: implemented; founder decision 2026-09-06 ("go for it"), after the riddle "we deleted
them here, why didn't they propagate?" was answered with data.

## The data

via-desktop, `Personal/rbox-core`: 206 standing CREATE-P receipts (`refs/rbox-local/
base-present/v2`, `priorOid: null`). For every one of them, this device's own BASE section
(design-274 stamp `dev_c0774bfe`) already records that branch at exactly the receipt's
`nextOid`; none has a per-branch origin entry. So each receipt describes a landing that DID
complete here — the branch was present at that commit when this device captured — and was
never settled because settlement (`p-settlement.ts`) requires the pull-p origin that legacy
landings never wrote. The same missing origin blocked the deletion (design 309) and left the
receipt standing: one bug, two symptoms. No user action can fix it: `rbox git resolve` has no
verb for outgoing deferrals, and a new verb would be a workaround for missing bookkeeping.

## Rule

In the branch-deletion witness, for a missing branch whose origin evidence is the design-309
self-authored BASE (no ledger entry, section stamped by this device): every valid owning
CREATE-P receipt for that branch whose `nextOid` equals the BASE OID is a **completed
landing**. Its `present`/`keeps` dispositions no longer count as standing, and its P/K refs
are retired **inside the same atomic `update-ref` transaction** that verifies the branch
absent and mints the deletion proof (`planAbsentBranchVerification(..., extraLines)` with
`receiptRetirementLinesForAbsentBranch`, i.e. ordinary settlement's deletions minus the
"branch still at next" verify that a deletion witness contradicts).

Receipts for a DIFFERENT commit, receipts on a foreign- or un-stamped section, foreign
artifacts, absence artifacts, settled-absence ledgers and mismatched keeps are unchanged and
still refuse. No wire, ledger or state format change; no flags; nothing outside the witness
and the verification transaction learns anything new.

## Validation

`git-sync.test.ts`: planted CREATE-P at the BASE OID on a self-stamped, origin-less branch →
proof minted, tombstone authored, both P/K refs gone; planted CREATE-P at another commit →
`(artifacts-standing)` refusal and refs intact. Plan/protocol suites green. Rollback: revert;
already-retired receipts were provably redundant with BASE.

## Review

GPT round 1 (`notes/310/review1-gpt.md`): NOT ALIGNED on one finding — the implementation
matched any receipt whose target equalled BASE, including UPDATE-P (a move this device may
not have applied). Fixed: the rule is CREATE-P only (`priorOid === null`), pinned by a test
that an UPDATE-P at the BASE commit still refuses. The reviewer found no peer-work loss path
for a genuine CREATE-P: creation and landing share one ref transaction, retirement CAS-deletes
the exact P target and episode-specific K refs while verifying the branch absent, and
verify/delete cannot partially commit.
