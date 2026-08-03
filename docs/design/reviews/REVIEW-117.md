# REVIEW-117 — account identity banner

Status: **ALIGNED** after round 2.

## Round 1 — adversarial review

Two blockers were accepted:

1. Fire-and-forget profile writes lacked an ordering/completion contract and could
   race logout. The design now requires a serialized, failure-absorbing scheduler,
   a deterministic flush seam, and an ordered clear that removes the file only after
   all older writes finish.
2. Existing account-status tests use environment credentials without redirecting
   cache state. The design now requires temporary `RBOX_HOME` isolation and draining
   scheduled work in every cache-writing test.

Additional accepted hardening: strict non-empty/finite cache shape validation,
terminal-control rejection, exact null/JSON and method fallback behavior, ANSI
boundary tests, failed-fetch no-write, missing-file clear, and exact linked/unlinked
worker assertions.

## Round 2 — confirmation

The reviewer confirmed both blockers and all noted ambiguities are resolved. The
design is aligned for implementation.

## Implementation review

The first pass found two test-coverage gaps: `fetchAccountSummary` persistence was
not asserted directly, and styling boundaries were not exercised with color on.
Both were added (including older-API null caching and a fresh FORCE_COLOR process
against the real helper). The confirmation pass returned **CLEAN**; 24 affected
cache/account tests and the broader 86-test focused CLI set passed.
