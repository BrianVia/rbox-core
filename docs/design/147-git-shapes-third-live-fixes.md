# 147 — Git-shapes third-live fixture and assertion fixes

> Superseded in part by design 148: the timing-dependent S2 capture-progress
> requirement is replaced by the exact capture plan, and the corrected rebase
> topology still exposes a genuine post-abort EPIPE engine gap.

## Evidence and scope

The source of truth is
`scripts/rig/runs/20260717-105329-git-shapes/report.md` together with its
captured `run.log` and `report.json`. The run recorded 385 passing assertions,
26 failing assertions, and three failing lifecycle steps. All 29 failures are
fixture or assertion defects. This change does not alter the sync engine.

The worktree contains the uncommitted design-141 scenario and its first two
live-fix rounds. Note: the git-shapes live-fix docs were originally drafted
under numbers that collided with `origin/main`'s storage-truth designs
(142–144) and were renumbered to 145–148 at commit time; cross-references
here use the final numbers.

## S2 LFS materialization boundary

Both `s2-configured` and `s2-unconfigured` are constructed after the devices
pair. The captured first push has an empty Git plan
(`hit0m0u0 pps0 sp0 prc0`), and B's first pull reports `repos=0`; it transfers
`.gitattributes` and `asset.bin` as plain files but does not materialize `.git`.
The failing `git ... cat-file -p HEAD:asset.bin` therefore runs before the
repository exists.

Preserve the after-pair construction because B's global LFS filter state must
be established before Git materialization. Read the committed pointer from A's
canonical `refs/heads/main:asset.bin`, perform the initial files-only push/pull,
then perform a second A push/B pull and assert the exact capture/apply surfaces.
Only after that boundary may the cell read B's canonical
`refs/heads/main:asset.bin` and run its native-repository LFS assertions. The
source and receiver pointer bytes must be identical. Use the canonical branch
ref for later pointer reads too, so the assertion does not accidentally depend
on checkout attachment. The run aborted before this second cycle, so pin the
source-defined `capturing git state` progress surface plus
`GIT_SHAPE_SURFACES.applied`; do not require the forensic summary line, whose
emission gate is not the materialization contract.

Add a fixture test that proves each LFS fixture commits the pointer at
`refs/heads/main:asset.bin` while leaving the worktree payload materialized.

## S4 partial-clone reality

### Online arm

The first A push and B pull are deliberately files-only: A still misses O1/O2,
B has plain `payload-three\n` with no `.git`, and both repo records are absent.
Those existing pre-settlement assertions remain.

The fixed-point cycle then captures A's native repository and applies it on B.
The report proves the settled contract:

- A's missing-object list is empty;
- B still has exact `payload-three\n`, now with a native `.git` and successful
  `rev-parse --git-dir`;
- A has a base plus advertised checkpoint and publisher-ack provenance;
- B has a base plus pull provenance and no advertised checkpoint;
- both records have no pending, partial, resolution, or deferral state.

Replace only the four failing post-settlement assertions with these positive
structural pins. Keep the source promisor/filter/URL pins because the report
shows that config survives hydration. Do not preserve design 146's stale claim
that fixed-point settlement remains files-only.

### Offline arm

The first push is also files-only and exactly reports the empty Git-plan metric
tuple. Its combined output contains none of `git-sync:`, `capturing git state`,
or `attaching git history`; it has no durable deferral rows and no projected
deferred repos. Human status contains the complete observed verdict
`↑ git changes to sync (git changes in 1 repo) — background sync stopped; run
\`rbox start\``, reports `git-sync: 0 repos synced`, and contains neither
`git deferral:` nor a `git deferred` row. B remains plain-files-only.

The next A push holds sequence 1 and creates a fresh durable capture deferral
whose exact reason is `worktree-ownership`, not `artifact`. Pin the status and
state projections to one row for `s4-partial-offline`, lane `capture`, reason
`worktree-ownership`, public `bytesChanged=false`, no checkout, valid/equal
episode timestamps, and a projected row with the same display reason. The
durable record may omit false, so it must reject only `bytesChanged=true`.
This second-boundary assertion is JSON/state-only because the report did not
sample a second human status after the new episode began.

Rename the stale artifact/retry-preservation assertions so the ledger describes
the boundary actually observed. Remove the unused partial-offline artifact
stderr fixture constant. The missing-object PRE=POST assertion remains exact.

## S5 receiver operation lifecycle

The annex lifecycle is authoritative:

1. A and B are clean and share the same main-branch BASE.
2. B starts the operation and the fixture proves its operation marker exists.
3. A publishes the incoming delta: merge/cherry-pick advance `main` with an
   empty commit plus the safe-ref witness tag; rebase publishes the tag only.
4. A pushes; B pulls twice while holding the in-progress operation.
5. B's HEAD, index, operation state, and worktree remain byte-identical and the
   existing exact deferral/status/resolve surfaces are asserted.
6. B aborts the genuine operation; `rebase --abort` itself restores `main` with
   no manual switch. B pulls the pending state and converges before the
   roundtrip/no-op checks.

Retain the merge-only incoming-BASE control required by design 145, but run
both its source merge and the later receiver merge with explicit fixture
identity. The fixture-construction shell's `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
exports do not persist into scenario commands; Git therefore exited 128 before
writing either `MERGE_HEAD`. Prove each command returned a conflict and its
marker exists before reading marker bytes or continuing. A missing marker must
fail closed instead of allowing two empty `fileHex` results to compare equal.

For the receiver rebase, remain on the clean shared `main` checkout and run
`git rebase operation-side`. The current inverse sequence switches to
`operation-side` and rebases it onto `main`; abort then restores the wrong
checkout and the manual switch leaves the follow path in an `EPIPE` deferral.
The corrected direction conflicts while detached, and `rebase --abort`
deterministically restores clean `main`, so remove the post-abort switch.

For merge, rebase, and cherry-pick, assert the marker is absent before the
command, exact conflict exit 1, the kind-specific marker (`MERGE_HEAD`, a rebase
state directory, or `CHERRY_PICK_HEAD`) present afterward, and exact
`UU conflict.txt` porcelain. Capture the A and B BASE
OIDs before B starts and assert they are equal. Preserve the design-141
tag-only rebase exception: advancing the rebased branch would prepublish it
before classification and invalidate partial proof on abort. Merge and
cherry-pick still require A's incoming OID to differ from BASE.

After abort, assert the kind-specific marker is absent and porcelain is empty
before pulling. Rebase additionally requires symbolic HEAD to be `main` and
`conflict.txt` to contain exact `incoming-side\n`; these postconditions prove
abort itself restored the correct clean checkout and distinguish the fixed
direction from the old abort/switch sequence that produced EPIPE.

Add fixture tests that independently start all three conflicted operations and
prove absent-before/present-after markers plus exact exit 1 and porcelain. The
rebase test must additionally prove pre-op symbolic HEAD is `main`, conflict
state is detached, and `rebase --abort` restores symbolic `main`, empty
porcelain, and exact `incoming-side\n` worktree bytes. These tests protect the
directional topology and merge identity requirement without Docker.

## Validation

- `bun test scripts/rig/lib/git-fixtures.test.ts scripts/rig/scenarios/git-shapes.test.ts`
- `bun run typecheck`
- `bun test scripts/rig`
- repo search confirms no live partial-offline artifact expectation remains
- orchestrator reruns `bun run rig git-shapes` because this sandbox has no live
  Docker fleet

Update the canonical annex, `docs/design/141-cell-outcomes.md` (its root
working copy `OUTCOMES-141.md` was removed at commit time), so its S4
online/offline sections and summary rows match
the third-live contracts above. Mark design 146's fixed-point no-hydration claim
as superseded by design 147. Archived run reports and historical review text
are evidence and remain unchanged; stale-surface searches exclude those
archives explicitly.
