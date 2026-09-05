# 308 — Decide the cheap branch-deletion refusals before the artifact scan

Status: implemented.

## Measured

via-desktop, 2026-09-05: `Personal/rbox-core` had 285 local branches deleted in the morning.
Every push since captured the repo (its fingerprint misses while it is being edited), ran
the branch-deletion witness, and was refused on the first missing branch —
`branch deletion witness refused refs/heads/adoption-callback-fix (origin-mismatch+artifacts-standing)`
— 456 times in one day. The design-304c stage split read `carried=1412[ctx=0 packed=3]`
and a CPU profile of one foreground push put ~1.5s in `directRef` (`for-each-ref` per
protocol artifact) under `prepareFollowerBranchProtocol`, i.e. the artifact scan the witness
performs before it looks at the per-branch facts that refuse anyway.

## Owner and change

`plan.ts: captureAndAuthorizeRepositories`, absence-witness path. The two per-branch refusals
that need no evidence beyond the record and the candidate — `scoped-capture`
(`candidate.refScope !== "all"`) and `origin-mismatch` (no `branchBaseOrigins` entry
matching the BASE OID) — are now evaluated for every missing branch BEFORE
`prepareFollowerBranchProtocol` and before the busy/preflight/worktree/HEAD authorization
reads. If any missing branch fails, the repo is refused immediately with the same typed
deferral (`deletion-pending`) and the same revert-to-BASE behavior.

What changes: only the forensic reason string for that case names the cheap cause alone
(`(origin-mismatch)` instead of `(origin-mismatch+artifacts-standing)`), and the named
branch is the first one failing a cheap check rather than the first failing any check. The
verdict, the deferral type, the carried section and every protected semantic (packed-refs
regression, HEAD reflog, binding, busy/preflight/worktree/collision/HEAD checks, the
verification transaction) are unchanged for repos that pass the cheap checks.

## Validation

`git-sync.test.ts`: a BASE branch without a recorded origin, deleted locally → refusal
`(origin-mismatch)`, `captureDeferrals[rel] === "deletion-pending"`, BASE carried, and ZERO
Git spawns after `beforeAbsenceWitness`. Full plan suites 137+ pass. Rollback: revert.

## What this does not fix

The deletion itself stays deferred: a BASE branch with no origin evidence (pre-design-274
records; this repo has 9 origins for 286 heads) cannot be proven deleted by this device.
Finishing those deletions is a product/user action, not a performance change.
