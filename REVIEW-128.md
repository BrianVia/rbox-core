# Design 128 adversarial review

## Round 1

Reviewed the full design against the pre-change runner, reachability proof, resolve snapshot,
and tests. The implementation checklist pinned positional `^{commit}` batch parsing,
integrity-before-classification, missing-root poisoning versus missing-tip independence,
streamed roots-closure ownership with candidate-only retention, batched subjects before the
legacy sort, presentation-only capping, show-me-only progress, observer preservation, and
the complete fixture matrix.

Resolution: implemented each mechanism and added direct equivalence, mixed-batch, shallow,
missing-parent, duplicate/tag, O(1), cap/JSON/protection, subject, progress, and reflog-heavy
coverage.

## Round 2

Adversarial review of the implementation found and resolved:

- fallback-unowned results initially lost their peeled commit, changing subjects and sort;
- fallback was initially unbounded parallel work rather than sequential legacy recovery;
- batched subject records needed per-record trim and control-character normalization;
- the shallow probe needed one validating subprocess without changing legacy single-tip
  marker semantics;
- heartbeat intervals needed restart/clear at each phase transition and failure cleanup;
- runner streaming needed bounded stderr, child termination on overflow, callback error
  propagation, and split UTF-8 decoding on the Node fallback;
- count tests needed to include the subject subprocess, and JSON/human output needed exact
  golden assertions.

Resolution: all findings were incorporated before acceptance testing. The excluded API,
web, and follow-path caller surfaces remain untouched.
