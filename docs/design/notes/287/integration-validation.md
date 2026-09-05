# First four fixes: integration validation

Base: `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`, preserved by the remote
annotated tag `pre-astra-changes`. The user requested four atomic fixes, merge
after validation, and a subsequent `docs/STATUS.md` handoff. The remaining
design-287 roadmap is not part of this implementation batch.

## Environment and completed checks

- Supported Bun 1.4.0, frozen dependencies, Apple Git 2.50.1.
- Root, API and scripts typecheck passed; repository lint and affected lint
  passed. Four existing fingerprint-parser warnings remain unchanged.
- Repository guards passed, including shard coverage and import/fetch guards.
- Affected Workers API telemetry-ingest test: 15 passed.
- Source DEV rig: type-flip 9 assertions; mass-delete-guard 8 assertions.
- Compiled Linux ARM64 DEV Git-entanglement rig: **111 assertions passed**,
  using the same candidate binary on both devices. Throwaway account cleanup
  returned HTTP 200. No production promotion or released CLI installation.

Compiled acceptance artifact SHA-256:
`ed86903ad1bc56828109662aa27ccc86d5068625170f5a71c23e10d8d3b05933`.
Its version label is `2.0.2+dev.c4aa22b`: the build includes the then-uncommitted
candidate source, so the label alone does not identify its bytes. Subsequent
formatting cleanup and trackedness-owner extraction require final validation
of the resulting commit candidate; this earlier artifact is not represented
as a build of the final commit.

The final source candidate was subsequently rebuilt and passed the compiled
Git-entanglement rig again: **111 assertions, zero failures**, report
`scripts/rig/runs/20260905-115752-git-entanglement/report.md`, account deletion
HTTP 200. Both devices used SHA-256
`a69b95e751ec2e06934c39eb08c275a00059f2d0529b0f5daec7d5e2fef2e987`.
This includes the owner extraction and formatting cleanup. Final capture tests:
32 pass / 357 assertions; held-skip compatibility: 16 pass / 90 assertions;
ignore/manifest: 70 pass / 1,102 assertions; deletion and safety: 68 pass;
module-size guard: 6 pass. Fable reviews: design 289 round 2, design 290 round 2,
design 291 round 3 all ALIGNED, with root GPT source review.

## Broad local suite: not a green result

The canonical-temp-directory run completed **4,464 pass, 10 skip, 65 fail,
2 errors**, across 328 files (59,092 assertions). It is retained as a diagnostic
run, not a merge acceptance claim. A first sandboxed attempt additionally hit
process-identity access restrictions and temporary-path aliases; running with
host process access and `TMPDIR=/private/tmp` fixed those classes.

Clean-baseline comparisons are recorded in `integration-baseline-comparison.md`
and design 289's adoption notes. Baseline failures must remain distinguished
from candidate regressions and unresolved order-dependent failures. Two Git
command-expectation tests needed to recognize the added private-index safety
configuration and dependency query without weakening their assertions.

The full GitHub CI matrix and review remain the merge gates. Local baseline
failures do not authorize bypassing branch protection, suppressing tests, or
calling the full suite green.

## Performance scope

The bounded deletion fixture has 124,000 manifest entries and 1,000 consecutive
confirmed-absent directory events. Manifest key visits fall from 123,500,500
to 124,000; observed median time falls from approximately 1.4 seconds to
27–33 milliseconds (42–52×). This is a workload-specific result and does not
claim an equivalent end-to-end sync improvement.
