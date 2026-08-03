# REVIEW-134 — second-device clarity

Review rounds for §134. The acceptance bar is complete coverage of the customer’s
second-device confusion with copy/guidance changes only.

## Round 1

**Codex: NEEDS WORK.** The draft paraphrased rather than quoted the customer,
under-specified exact copy and exactly-once output ownership across `login()`’s
bootstrap/env-pair/device-code branches, did not name the two tolerated CLI failures,
and justified the root docs link without the locally available website source.

**Resolution:** The design now quotes the token/dashboard and workspace questions;
pins literal CLI, web, and usage copy; assigns the shared workspace instruction to
one owner for every login result plus `redeemPair()`; names both tolerated tests;
and cites the source and built website evidence that “Devices & account” has no
fragment while `#agents` is explicit.

## Round 2

**Codex: PASS.** The revised design is literal, auditable, assigns exactly-once
output ownership across every login and pairing success path, covers all requested
web/docs surfaces, and preserves the copy-only boundary. Both reviewers are aligned;
implementation may proceed.

## Implementation review

**Codex: NEEDS WORK.** The first pass replaced rather than supplemented the
wizard’s “shown here, approve elsewhere” guidance and `/cli-login`’s “approval does
not unlock files; finish pairing on-device” guidance.

**Resolution:** Both operational explanations are restored alongside the new
mechanism distinction, matching the request to add a clarifying clause.

The second pass also found that tests pinned constants but not the live initial
authorization array, and covered only one device-code output owner plus no bootstrap
success. The choices now come from one exported, exact-tested array; a pure predicate
used by `login()` pins all five post-approval results; an end-to-end existing-keys
test guards against duplication; and bootstrap success is exercised directly.

**Codex: PASS after revision.** The final diff preserves the original operational
guidance, exact-tests the live choices, assigns every success path to one output
owner, and has no remaining scope, simplification, antislop, or UX issue.

Validation: `bun run typecheck` passed; focused auth/setup tests passed 41/41;
web `npm run check` completed with 0 errors and 0 warnings; web `npm run build`
passed. The full `bun test src/cli` run reached 1,462 pass / 7 skip / 6 fail: the
known same-SHA metadata-heal failure plus five unchanged local-listener tests that
cannot bind `127.0.0.1:0` in this sandbox (`EADDRINUSE`). The signed-in-account JSON
test passed in this environment, and no changed-path test failed.
