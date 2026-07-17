# 146 — S4 partial-online observation fix

> Superseded at fixed-point settlement by design 147. design 146 remains
> correct for the immediate post-push/post-pull boundary, but the third live run
> proves the subsequent fixed-point cycle hydrates A and materializes B's native
> repository.

## Evidence and scope

The source of truth is the `s4-partial-online` section of
`scripts/rig/runs/20260717-102613-git-shapes/report.md`, including the captured
stderr from the failing receiver step. This is a harness-expectation correction;
it does not change the sync engine. design 147 later superseded this document's
offline and fixed-point conclusions.

At the corrected post-push boundary, A still reports exactly O1/O2 missing. The
live run proves the push output has no `git-sync:` plan/capture line, the metrics
record an empty Git plan (`hit0m0u0 pps0 sp0 prc0`), B applies one plain blob
with `repos=0`, and B has no native repository. The fixture definition supplies
the exact source-clone expectations that the corrected cell must probe:
`remote.origin.promisor=true`, `remote.origin.partialclonefilter=blob:none`, the
fixture's exact `file://` origin URL remains configured, and
`extensions.partialClone` is absent.

The previous hydration observation was an artifact of the round-1 observation
boundary, not an engine gap. Remove the hydration finding from the cell, its
run-level sidecar assertion, renderer test data, the canonical design-141
outcome text and root annex copy, and current design/review references. Both
annex copies must record the exact correction: `hydration artifact of round-1
observation error; no engine gap`. Preserve historical review context only with
an explicit design 146 supersession note. Outside archived run evidence, a
repo-wide search must find no stale `partial-silent-hydration`, `capture silently
hydrates`, `POST={}`, or `record silent hydration finding` expectation.

## Cell behavior

After `pushA`, assert PRE=POST exactly `{O1,O2}` and assert that the combined push
output contains no `git-sync:`, `capturing git state`, or `attaching git history`
line. Pin A's exact promisor/filter/URL config and absent extension. After B
pulls, assert `payload.bin` is exactly `payload-three\n`, `.git` is absent, and
`git rev-parse --git-dir` fails. Use status/state-only empty-durable-state checks
for B; the generic helper invokes Git and is invalid when there is no repo.

Do not invoke the generic native-repository checks, ACK check, or B-to-A Git
commit roundtrip. The live stderr says `git add receiver.txt` failed because B
was not a Git repository; it was not evidence of a receiver lazy-fetch failure.
Restructuring the step around the observed no-repository outcome avoids the
invalid fixture operation without changing the offline arm.

The original implementation instruction was to retain the fixed-point cycle
and reassert A's missing set plus B's no-repository shape. The third live run
disproved that downstream expectation: design 147 now requires the fixed-point
cycle to hydrate A, materialize B, and pin both structural repo records. Design
147 also replaces this document's then-unchanged offline artifact expectations
with the observed files-only first boundary and later worktree-ownership
episode.

## Validation

- `bun run typecheck`
- `bun test scripts/rig`
