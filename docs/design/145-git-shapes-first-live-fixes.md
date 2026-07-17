# 145 — Git-shapes first-live-run fixes

## Evidence and scope

The source of truth is the complete first live report at
`scripts/rig/runs/20260717-095146-git-shapes/report.md` plus its `run.log`.
This round fixes the harness and fixtures; it does not change the Git sync
engine or run Docker locally.

The live run revealed five shared harness mistakes behind the individual
failures:

1. `rbox init --new` performs an implicit initial file publish and Git attach,
   and `rbox init --workspace` performs an implicit initial pull. The scenario
   discarded both command results, then looked for first-sync forensic lines in
   later no-op `push`/`pull` output. The exact lines are present in `run.log` at
   the init boundary.
2. Fixtures whose contract needs an untouched PRE state (case collision and
   partial clones) were constructed before init. B therefore encountered the
   case-collision refusal while joining, and A's init capture hydrated both
   partial clones before the PRE probe.
3. Pull-side per-repository lines are quiet by default. Exact
   `applied`/`deferred`/`followed` assertions must use the product's supported
   `--verbose` surface.
4. The common no-op helper sampled after one ordered A-then-B round. B may
   legitimately publish later in that round, leaving A one accepted sequence
   behind until the next round. Equality at that intermediate boundary is not
   convergence.
5. The CLI entry point assigns `process.exitCode` from a detached promise
   callback. The live orchestrator observed exit 0 for a FAIL report. The
   executable must terminate explicitly with the integer returned by `main`.

## Changes

### Preserve the real first-sync surfaces

Extend `ProvisionResult` with the A init and B init `RunResult`s. Cells whose
fixture is intentionally present at init assert the exact plan/apply strings
from those results. In particular, S1(a) continues to pin the exact observed
line:

```text
git-sync: captured 1 (s1-a/mod) · carried 0 · skipped 0 · deferred 1 (s1-a: .git/modules present — unsupported — section not captured) · removed 0
```

The refusal comes from the fixture's runtime product-preflight probe and the
full formatter remains drift-checked against `formatGitPushLine`; the cell does
not invent a second spelling. The design-141 annex is amended to name init's
implicit Git attach as the live emission boundary.

All explicit pull helpers used for exact Git forensics pass `--verbose`.

### Enroll before constructing refusal/PRE fixtures

Add an after-pair fixture mode to `provisionCell`: provision and enroll A/B on
an empty workspace, then execute the fixture only on A.

- S3 case uses this mode. Both devices join successfully first; A then creates
  `README.md`/`Readme.md` and publishes the colliding manifest. As the first live
  stderr proves, refusal is receiver-side: two explicit B pulls reject the same
  exact duplicate path, B does not consume the accepted sequence, and B's
  worktree remains unchanged.
- Both partial-clone cells use this mode. Their missing-object PRE probes now
  run before the rbox push boundary. design 146 corrects the online outcome to
  no hydration/no Git plan; offline capture is performed only after the origin
  is moved away.
- Both LFS cells use this mode so B's filter state is selected before native
  materialization. The configured arm invokes the installed binary directly as
  `/usr/bin/git-lfs install --skip-repo`; Git LFS installs global filters by
  default and has no `--global` flag. The unconfigured arm removes global and
  system filter sections before the pull. Before pull, both arms prove
  `/usr/bin/git-lfs version`; configured proves effective filter keys exist,
  while unconfigured proves the effective filter keys are absent. No PATH
  masking is shared between arms.

### Correct operation lifecycles

The incoming-BASE merge control needs a deterministic source cleanup, not a
second test of `git merge --abort`. First prove A's merge command entered a
conflict and created MERGE_HEAD. After proving A and B received identical
`MERGE_HEAD`, require `git reset --hard HEAD` to succeed in `s5-merge`, assert
MERGE_HEAD is absent, publish that deletion, and prove B deletes its BASE-equal
copy. The later receiver-local merge must itself exit nonzero with MERGE_HEAD
present before the two deferral pulls, and is aborted on B afterward.

For rebase, `git rebase --abort` returns B to `operation-side`. Switch B back to
`main` before the settlement pull so the incoming main checkout can follow and
clear pending/partial/deferral state. Durable `bytesChanged` may omit false;
the public JSON projection remains pinned to `false`, while the durable check
rejects only `true`.

### Settle to a fixed point before asserting no-op

Replace the one-round equality assumption with bounded complete ordered
settlement rounds: run A sync then B sync, require both exits zero, and only
then sample both `lastSyncedSequence` values. Repeat until equal, retaining a
sequence trace and failing with it if the bound is exhausted. Once equal, run
one additional complete A/B round and require zero exits, equality, and no
advance from the accepted sequence. A pure modeled test pins the observed
`5/6 → 6/6`, then-stable progression.

This is especially important for S5 bisect. The annex explicitly allows sync
to proceed and then allows clause 5's B commit to publish. The observed
`A=5 B=6`, followed by `A=6 B=6`, is the later publisher winning the first
ordered round and A consuming it in the next—not a race and not a fixed
sequence-delta contract. A code comment will preserve that rationale.

### Propagate FAIL to the process

Await `main()` at module top level and assign its result to `process.exitCode`
before module evaluation completes; caught errors assign 1. Keep the pure
report-verdict mapping. A subprocess test imports the exit seam with a synthetic
main that returns 1 and proves the child process exits 1; a separate unit pin
proves `FAIL` report → 1. This catches the detached-callback bug without risking
truncation of buffered report output through `process.exit()`.

## Additional first-run assertion repairs

The report also exposed shared consequences not individually listed in the
orchestrator summary. They are part of making the full report green:

- S1/S1(b)/S1(c)/S4 plan and apply assertions bind to the actual init result.
- S1(a) drops its redundant child clause-5 roundtrip. The live run showed that
  topology holds A's physical pointer branch and opens an apply deferral, so
  weakening the assertion would hide a real outcome. The annex matrix already
  assigns pointer bidirectionality to the independent S1(b) cell, which remains
  strict.
- Operation deferred/followed assertions use verbose output.
- Rebase settlement returns to main before clause 5.
- Partial PRE/offline artifact assertions execute before capture can hydrate.

## Validation

- `bun run typecheck`
- `bun test scripts/rig`
- no local Docker invocation; the orchestrator reruns the live family
