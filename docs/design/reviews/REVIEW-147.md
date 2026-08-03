# Review 147 — Git-shapes third-live fixes

## Round 1 — changes required

The reviewers independently reconstructed all 29 failures from the third-live
report. They confirmed the S2 files-only genesis boundary, S4 online's settled
native materialization, S4 offline's shifted first-attempt boundary, and the
missing runtime committer identity behind merge's absent `MERGE_HEAD`.

They rejected the first draft's proposal to advance rebase's branch. The
canonical annex requires a tag-only incoming rebase section because a branch
delta can prepublish before classification and invalidate abort proof. They
also identified the directional cleanup bug: switching to `operation-side` and
rebasing it onto `main` makes abort restore `operation-side`; the later manual
switch is the path that produced the live EPIPE/stale pending cascade. The
correct operation starts on clean `main` with `git rebase operation-side`, and
abort itself restores `main`.

## Round 1 — response

Accepted. design 147 now preserves tag-only rebase, reverses the receiver rebase
direction, removes the manual switch, and requires exact post-abort branch,
marker, porcelain, and worktree checks. It retains design 145's merge-only
incoming-BASE control but supplies runtime identity to both merge commands and
fails closed on absent-before/present-after operation markers.

The S4 offline contract was also tightened: first-push combined output rejects
every Git capture surface; first human status is pinned exactly and rejects any
deferral row; the later push creates a new capture/worktree-ownership episode;
public `bytesChanged` is false while durable false may be omitted. The design
now explicitly requires both canonical annex copies and design 146's
supersession note to be updated.

## Round 2 — changes required

The lifecycle reviewer required exact conflict exit 1 rather than an arbitrary
nonzero result, absent-before markers to exclude stale-state false positives,
and a fixture test proving rebase begins on symbolic `main`, becomes detached,
and aborts back to clean `main` with exact bytes. The report reviewer clarified
that S2's second-cycle capture/apply strings are source-derived contracts rather
than observed report output, and that the report did not sample a second S4
offline human status after the worktree-ownership episode began.

## Round 2 — response and verdict

Accepted. The design pins exact conflict exits and marker transitions, expands
the directional fixture test, labels S2's source-derived evidence correctly,
and keeps the second S4 offline boundary JSON/state-only. Both reviewers then
returned **ALIGNED** with no remaining blockers.

## Implementation simplify and antislop review

The simplify pass caught that recorder assertions do not throw, so a failed
operation-start assertion could still recreate the eleven-result cascade. The
implementation now uses a small required-assertion helper for shared BASE,
operation entry, incoming-BASE control transitions, source delta, and abort
postconditions. It also made the LFS cache-path helper synchronous and removed
its unused device parameter.

The antislop pass split the offline capture episode into sequence, public
projection, and durable-record assertions; renamed stale retry variables;
pinned exact B payload bytes; completed projected-row shape checks; removed the
dead O1/O2 object return; and corrected the operation test name. It found stale
imperative text in design 146, which is now explicitly historical and
superseded at fixed point/offline behavior.

Both reviewers suggested requiring the forensic `git-sync: captured ...`
summary during S2 attachment. That suggestion was not applied: product code
emits the summary behind a separate conditional gate, and the third-live S4
attachment demonstrates a successful native capture without that summary.
Instead the cell requires zero command exits, exact `capturing git state 0/1`
progress, B's absent-to-present `.git` transition, and the shared exact
`git-sync applied <repo>` surface. This pins materialization without making the
forensic emission gate part of the contract.

Final local validation: `bun run typecheck` passed; `bun test scripts/rig`
passed 134 tests and 497 expectations; both canonical annex copies are
byte-identical; stale live S4 expectation search and `git diff --check` are
clean. The live Docker rig remains an orchestrator-only gate.
