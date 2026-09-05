# Design 289 — review round 2

Date: 2026-09-05. Verdict: **ALIGNED**. Reviewer: Claude Fable 5.1, medium, dispatched by the parent under the user's standing authorization for scoped design/test-summary disclosure. Source response: `/private/tmp/rbox-289-round2-final-result.json`, session `1345497d-d57a-4ed6-9885-acc0810f0885`.

## Review boundary

Claude reviewed supplied design text and test summaries. It did **not** inspect the working tree or execute the tests itself. Its phrases “reportedly covers” and “asserted by test” describe those supplied results. The parent separately reviewed the source and agreed with the design. The executed local normalization probes and permanent tests satisfy the executed-evidence requirement; they are not represented as Claude execution. This is round 2 of the maximum three rounds.

## Findings and disposition

The reviewer found no blocking issues. It aligned on read-only split=true detection plus explicit native zero sentinel recognition; private writes with split=false and identical monitor/cache settings; fixed split normalization/REUC/hash ordering; exact ordinary raw identity preservation; propagation of snapshot failures; strict stage roots with gitlink exclusion and native object verification; and the explicit historical-artifact repair deferral. No new wire format or repair marker was approved.

Two bounded closure items were retained: validate the native dependency output shape strictly, and inspect direct apply callers for identity-failure containment. The implementation now validates every nonempty dependency basename against `^sharedindex\.([0-9a-f]{40})$`, accepts the zero OID as ordinary, and rejects any unrecognized basename. Actual split and configured ordinary zero-sentinel fixtures exercise the native query. F1's owner was notified of the same shape guard.

Direct apply inspection: `apply.ts`'s `getLocalId` calls at lines 475–479 and downstream uses execute inside `runRepo`'s try/catch (1278–1322). An identity error retains the prior applied BASE, stores incoming as pending and defers only that repository. No identity value is fabricated. The late direct calls at 812 (legacy conflict after possible safe-ref progress) and 1104 (checkpoint reproof defer) are also inside that boundary: before reading identity they retain old BASE/incoming/partial progress; neither advances incoming BASE on failure. Physical safe-ref/journal progress remains owned by the existing follow/conflict mechanisms. The new missing-shared-dependency fixture additionally calls the real `applyGitSections` entry point and asserts prior BASE retention, incoming pending, deferral, unchanged refs/index and no published checkout journal.

Other direct identity entry points retain conservative behavior: divergence-cache catches and invalidates observation; pending-supersession wraps the probe in its existing carry-on-failure catch; resolution-intent must obtain an identity before returning a publishable binding. No apply orchestration or recovery logic was changed in this slice.

## Remaining release gates

The requested full-file and lint evidence was already recorded in design 289 and its notes; fixture additions make the current file inventory 32 rather than the review's original 27-test expectation. The cache suite has also passed. Root owns final combined tests and compiled Linux rig validation. The review's suggested Bun 1.3.14 rerun is not a supported-runtime gate: the project requires Bun >=1.4.0, the old runtime baseline is already documented, and the parent explicitly declined a new unsupported-runtime rerun. Historical published split artifacts remain outside this slice; ALIGNED does not mean they were repaired or that shipping occurred.

Closure tests completed locally: 3 pass, 75 assertions, 5.03s on supported Bun 1.4.0; affected lint exited 0 with the documented pre-existing fingerprint warnings. Evidence: `review2-closure-tests.txt`, `review2-closure-lint.txt`. Final integration remains parent-owned.
