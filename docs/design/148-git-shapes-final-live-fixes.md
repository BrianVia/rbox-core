# 148 — Git-shapes final live fixes

## Evidence and decision

The source of truth is the complete report and captured context in
`scripts/rig/runs/20260717-112118-git-shapes/`. It records 491 passing
assertions and five failures: one S2 configured observation failure and four
S5 rebase post-abort failures.

The S2 repository materialized correctly. Its second push exited zero, emitted
the exact `git-sync: captured 1 (s2-configured) ... deferred 0` plan, and
advanced sequence 2; B's pull exited zero, reported `repos=1` and
`results=applied=1`, logged `git-sync applied s2-configured`, and created the
native repository. Every later pointer, payload, cache, status, fsck, and
roundtrip assertion passed. The missing `capturing git state 0/1` text is a
throttled non-TTY spinner update (`src/cli/spinner.ts`), not a capture failure.
The materialization assertion therefore uses the deterministic exact plan
formatter plus the exact apply log and native `.git` proof.

S5 rebase is a genuine engine gap, not an unfinished fixture operation. The
corrected fixture starts `git rebase operation-side` on clean symbolic `main`,
enters a detached conflict, and `git rebase --abort` proves all four completion
postconditions: marker absent, porcelain empty, symbolic `main`, and exact
`incoming-side\n` worktree bytes. The next pull exits zero but logs
`git-sync deferred s5-rebase: EPIPE: broken pipe, write`, changes the durable
apply reason to `other` on branch `main`, and retains pending/partial state.

The mechanical trigger is the tag-only/no-branch-delta checkout shape. Rebase
abort leaves a valid `ORIG_HEAD`; follow plans a recovery-ref `create`, then an
unchanged-symbolic-HEAD `symref-verify`. `RefTransaction` emits one
`option no-deref` before both commands. Git applies that option to the next
command only, so the recovery create consumes it and Git rejects the following
symref verification with `fatal: symref-verify: cannot operate with deref
mode`; the FIFO wrapper exposes the closed child as EPIPE
(`src/cli/sync-git/orig-head.ts`, `src/cli/sync-git/follow.ts`,
`src/engine/git/checkout-txn.ts`). Engine repair is follow-up scope.

## Exact rebase gap contract

Keep every pre-abort operation assertion. After the required abort completion
proof, the first receiver pull must:

- exit zero, report `results=deferred=1`, contain the exact EPIPE line, and not
  contain `git-sync followed s5-rebase`;
- preserve empty porcelain and successful `git fsck --no-dangling`;
- expose exactly one apply/`other` row and one projected `other` repo on branch
  `main`, with public `bytesChanged:false`;
- retain `pending`, `partial.checkoutPending:true`, empty held refs,
  `configApplied:true`, and the already-applied tag witness, while resolution,
  P/K recovery refs, and the checkout journal remain absent;
- leave A settled and healthy.

Then create one ordinary B commit. B push and A pull must exit zero, the plain
receiver file must reach A, no native capture plan may publish B's repo, and A's
main OID must remain different from B's commit. Stop the rebase cell there:
remote sequence equality is not native Git convergence, so the generic
fixed-point/no-op assertions do not apply.

Record `engine-gap: rebase-post-abort-epipe` in the generated findings sidecar
with the abort proof, exact EPIPE surface, retained pending/partial state, and
blocked B-to-A native OIDs. Require that finding at scenario completion. The
finding pins the observed gap; it does not suppress assertions.

## Annex supersession

This design supersedes design 147's claim that corrected rebase direction
settles after abort and its requirement for the timing-dependent S2 progress
line. Update both canonical annex copies identically. Merge and cherry-pick
remain deferred-to-settled lifecycles; bisect retains its existing finding.

## Validation

- `bun run typecheck`
- `bun test scripts/rig`
- `git diff --check`
- orchestrator reruns `bun run rig git-shapes`

