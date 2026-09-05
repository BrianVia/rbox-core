# Design288 — review round2

Verdict: **ALIGNED for the regression-only slice**, from Claude Fable5.1 at medium effort and the local GPT review. Full Claude feedback: `docs/design/notes/288/fable51-medium-round2.md`. No third round is needed for the regression specification.

The tests now exercise an established split base plus add/delete/modify delta, preserve source index/sharedindex bytes and file sets, isolate Git routing/object/config/test environment, prove three conflict-stage blobs unreachable from refs/reflogs and absent in an unrelated initialized receiver, and exercise product capture/apply. The direct artifact test is paired with a separate fresh-apply test. All preconditions pass before the three intended defect failures: 77 assertions,3.74s in the targeted run.

Claude's two nonblocking observations are already concrete in the tests: connectivity uses `git fsck --connectivity-only --no-dangling`; successful standalone index reading additionally requires an empty `git rev-parse --shared-index-path`, with the source shared file absent from the receiver. No byte equality of source and transported index is required.

This closes the test design review, not normalization/identity implementation design. Tests remain intentionally red; supported Bun, lint/tooling and subsequent product crash/compatibility/rig validation are separate gates. No production algorithm, deployment, merge or release changed.
