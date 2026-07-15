# REVIEW-118 — Slackpipes request-lifetime pings

Status: **ALIGNED** after round 2.

## Round 1 — adversarial review

The reviewer conditionally approved the architecture and required six
clarifications: name the complete `ExecutionContext` route plumbing; distinguish
`waitUntil` lifetime extension from a literal post-response start guarantee; define
the synchronous event-helper API; make the retry and exactly-once terminal logging
matrix exhaustive; expose timeout-signal testability; and pin response independence
with a controlled unresolved ping while keeping Stripe ledger insertion independent.

## Round 2 — revision

Design 118 now incorporates all six corrections. It specifies the exact route and
handler chain, `Pick<ExecutionContext, "waitUntil">` schedulers with no caller
await, all terminal/retry classifications (including dependency failures), removal
of the superseded non-2xx log, injected signal/delay/fetch seams, and direct
response-before-ping assertions. No design blocker remains.

## Implementation review

The first pass found one logging-cardinality issue: a synchronous `waitUntil`
registration failure could log once itself and then let a failed sender log again.
Registration is now failure-absorbing without its own event, leaving the sender as
the sole owner of attempted-send failure logging. A test pins one log for a failed
send and no false log for a successful send under a throwing context. The sender's
outer boundary also contains dependency-initialization failures. The confirmation
pass returned **CLEAN**.

## Founder semantics amendment

The founder subsequently confirmed that SlackPipes URLs are channel-addressed and
that terminal business-ping failures should themselves produce a one-shot alert.
Design 118 now specifies alerts URL derivation with explicit-secret precedence, a
closed event-name enum, a single synthetic alerts ping after terminal failure, a
hard alerts-channel recursion boundary, and URL-free logging. The amendment is
subject to a fresh adversarial review below before implementation.

### Amendment review round 1

The reviewer found the terminal-failure scope ambiguous and requested structural
recursion prevention, a concrete closed-enum API with total event-to-channel
mapping, explicit derivation/parse-failure behavior, per-operation logging
cardinality, and stronger recursion/privacy cases. The design now defines a
terminal failure as the result after applying retry policy (including failures that
are not retryable), separates an alert-free `sendWithRetry` primitive from the
single-alert public orchestrator, requires the event enum, specifies URL mechanics
and invalid configuration behavior, and pins two- and four-attempt guard tests.
Redispatched for alignment before implementation.

### Amendment review round 2

The reviewer found no remaining blockers or major issues and marked the amendment
**ALIGNED**. Implementation proceeds against the structurally non-recursive sender
and the clarified terminal-failure policy.

## Amendment implementation review

The adversarial implementation pass returned **CLEAN**. It confirmed override and
derivation behavior, closed event-to-channel selection, structural recursion
prevention, per-operation privacy-safe logging, failure absorption across all
dependency stages, and the focused 2/3/4-attempt test matrix. Native Workers Vitest
remains pending because this sandbox rejects the runtime's localhost listener;
TypeScript validation passes.
