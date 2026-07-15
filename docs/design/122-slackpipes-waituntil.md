# Design 122 — Durable request-lifetime Slackpipes pings

## Incident and goal

On 2026-07-11 both the first real customer's web-signup and initial-subscription
Slackpipes requests exceeded the existing 700 ms inline timeout. Tier-1 pings must
add zero Slackpipes latency to HTTP responses while retaining best-effort delivery,
privacy-safe final-failure logging, and the hard never-throws contract.

## Request-lifetime plumbing

The full Worker `ExecutionContext` is passed into `route` (alongside its existing
`exports` use), added to `RouteCtx` as `executionCtx`, and threaded through the
public auth, billing-webhook, and web-session route
groups into the three handlers that can emit Tier-1 events: CLI bootstrap, Clerk
first-login provisioning, and Stripe event application. Each event-specific ping
helper is a synchronous `void` scheduler accepting
`Pick<ExecutionContext, "waitUntil">`; it registers its send promise with
`ctx.waitUntil`. No handler or route awaits ping completion, so its response settles
while a controlled ping remains unresolved. `waitUntil` does not guarantee the
fetch literally begins after response bytes are sent; it guarantees ping completion
is outside the response dependency graph and extends the request lifetime for that
work. The authoritative database work and event gates remain in their current
order, registration occurs only after the corresponding state transition succeeds,
and Stripe's processed-event ledger insertion never depends on ping completion.

All Tier-1 events use this path: new account (bootstrap and web), new subscription,
churn, and payment failure. Direct handler tests receive an injected test execution
context and explicitly drain it when they need to assert delivery. This is request
lifetime extension, not a durable outbox: a terminal Worker loss can still drop a
best-effort notification.

## Sender policy

`pingSlackpipes` remains the exported, never-throwing sender and continues to return
`false` only when no source configuration exists for its event's channel and `true`
when a send was attempted (including a configured-but-invalid URL).
Each fetch attempt uses `AbortSignal.timeout(5000)`. On the first attempt only, a
timeout (recognized by the runtime error's `TimeoutError` name, including a
`DOMException`) or HTTP 500–599 result waits 1000 ms and receives exactly one retry.
HTTP 4xx and non-timeout thrown errors are terminal without retry, and any failure
on the second attempt is terminal. No intermediate error is logged. Every terminal
attempted-send failure—including delay/dependency failure—emits the existing
privacy-safe `slackpipes_ping_failed` event exactly once and is swallowed; the old
`slackpipes_ping_non_2xx` event is removed. No source configuration logs nothing and
returns false; successful 2xx delivery logs nothing and returns true.

The sender exports the timeout constant and accepts optional injected `fetch`,
delay, and timeout-signal factory functions solely as test seams, with production
defaults of global `fetch`, a timer promise, and `AbortSignal.timeout`. The entire
dependency path is inside the failure-swallowing boundary. This makes retry timing,
signals, and outcomes deterministic without weakening production behavior.

### Founder-confirmed SlackPipes channel and failure-alert semantics

SlackPipes webhook URLs have the shape `<base>/<channel>` (a trailing slash is not a
valid configured channel URL). The alerts endpoint uses the nonempty explicit
`SLACKPIPES_ALERTS_WEBHOOK_URL` secret opaquely when it is set. Otherwise,
`webhookFor("alerts")` derives it from `SLACKPIPES_WEBHOOK_URL` by parsing the URL and
replacing only its final nonempty pathname segment with `rbox-alerts`, preserving
any prefix plus query and fragment. Thus one business
secret configures both channels while the alerts secret remains an override. If
neither source exists, alerts remain self-gating. Webhook URLs are transport-only:
no URL, raw fetch error message, response body, or stack is ever logged; failure
logs retain only the fixed event name and error class through `logErr`.

Every product ping carries a required compile-time closed event name:
`SlackpipesEvent = "signup" | "subscription" | "payment_failed" | "churn"`.
An internal total event-to-channel mapping sends `payment_failed` to alerts and all
other events to business, so callers cannot mismatch identity and channel. After
the retry policy reaches any terminal business-channel failure—including 4xx or
non-timeout errors that are terminal without an actual retry, delay/dependency
failure, or an exhausted retry—`pingSlackpipes` creates exactly one additional
best-effort alerts-channel operation with text
`slackpipes ping failed: <event>`. An internal `sendWithRetry` primitive only sends
and returns a discriminated outcome; it has no alerting behavior. The public
orchestrator logs the original failure once and may invoke that primitive once for
the synthetic alert. It logs a terminal synthetic-alert failure once and stops, so
two log records are expected only when both operations fail. The alert operation
uses the same bounded attempt/retry policy and injected dependencies. Ordinary
alerts events such as `payment_failed` also stop after their own terminal failure.
The original attempted-send result remains `true` regardless of whether its
diagnostic alert can be delivered.

## Tests and validation

Unit tests pin one fresh 5000 ms timeout signal per attempt, one retry after a 1000
ms injected delay for both timeout and 5xx, no retry for 4xx and generic network
errors, success after retry, exactly one final-failure log, absent-secret gating,
and never-throws behavior. Amendment tests pin alerts-URL derivation, explicit
override precedence, exactly one failure-alert operation containing only a
closed-enum event name (three fetches when a twice-failed business operation is
followed by a successful alert), and the alerts-channel recursion guard both for an
ordinary alerts event (at most two fetches) and a failed synthetic alert (at most
four fetches total, never five). They assert the absence of either configured URL
from all serialized logs even when a thrown error message contains both, and cover
malformed derived configuration without throwing or leaking it. Handler
tests use a controlled unresolved fetch and a
captured `waitUntil` promise to pin that the HTTP handler resolves first, then drain
the work; existing event-selection gates still emit only the intended pings. Direct
handler tests pass the new context argument explicitly.

Run `cd apps/api && npx vitest run` natively and `bun run typecheck`. No module under
the sync-engine ownership trees changes, so `docs/CODEMAP.md` needs no update.
