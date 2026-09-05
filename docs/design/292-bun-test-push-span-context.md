# 292 — Bind statistics test contexts to their callbacks

Status: implemented and tested on Bun 1.4.0 and 1.4.2; GPT review aligned; Claude Fable 5.1 round-1 review aligned (`notes/292/review1-claude.md`). The prototype helper was written before this document, before any test migration. This is a separate test compatibility slice, not another design 291 review round. No production behavior, runtime pin or CI assertion bypass is proposed.

## Verified cause

Successful main CI run 33697551297 used Bun 1.4.0. PR 882 run 33976813037 used Bun 1.4.2+744846f84 because the unchanged workflow selects `latest`. The first-publish statistics code, sharder and affected statistics tests are unchanged from the original baseline.

An isolated two-test probe (`/private/tmp/rbox-als-hook.test.ts`) establishes `AsyncLocalStorage.enterWith` in beforeEach and reads it from the test body. Bun 1.4.0 retains that context; Bun 1.4.2 returns undefined. Explicit `AsyncLocalStorage.run` around a callback and its awaited continuation works on both. Four actual statistics files under 1.4.2 reproduce ten CI failures: 43 pass / 10 fail. Missing active ownership causes instrumentation to return its disabled state; no environment switch is required to reproduce the failure.

## Existing owner and narrow correction

Production `PushSpans.run` already owns a complete operation-scoped timing context using `AsyncLocalStorage.run`, and finalizes its lane/tail observations. Keep that implementation unchanged. A test-only `pushSpanTests` helper accepts the calling test file's Bun registrar and registers a test whose actual callback creates a fresh `PushSpans`, enters `run`, and invokes the fixture with that owner's `FirstPublishTiming`. Synchronous and asynchronous fixture bodies are awaited inside the scope. Resolve/reject and cleanup continue through the existing owner's finally path; no global fallback or shared mutable owner is introduced.

Migrate six existing suites currently relying on beforeEach-entered ownership: phase-report, remote-commits, remote-commits-cap, redeem-drain-upload, first-publish-overlap and publish-pipeline/pipeline. Bind `const test = pushSpanTests(bunTest)` so existing names, timeout arguments and static test discovery stay intact. Keeping the Bun registrar in test files avoids adding Bun test types to production typechecking. Remove only the obsolete hook/global timing variable; callbacks that inspect timing receive it directly as a parameter. Keep unrelated hooks (environment restoration, pipeline settings) and every assertion. Upload-grant already establishes its context inside the callback and needs no migration; run it as adjacent coverage.

Protected behavior includes disabled-measurement cases, overlap voiding both measurements, stale dispatch generation rejection, upload interval union, explicit drain/flush accounting, request/receipt counts, async nesting and the production fast path when there is no active context. Test callbacks must not become concurrent implicitly; each registered test gets a distinct owner. No test name, timeout, expectation, negative control, skip rule, production helper or workflow setting may be weakened to achieve green CI.

## Validation and review

Run the migrated suites, upload-grant and push-spans owner tests under both Bun 1.4.0 and exact CI Bun 1.4.2. Add a focused test-helper regression exercising callback ownership after an await, with separate concurrent owners to ensure isolation. Run affected lint and typecheck; explain independent warnings rather than suppressing them. Preserve the pre-fix evidence and original runtime probe, whose hook-propagation assertion intentionally remains red on 1.4.2. The fixed fixtures must be green without changing that runtime fact.

Root supplies independent GPT review; Claude Fable 5.1 medium receives the scoped design, test-only diff and executed evidence for round 1 before commit. Maximum three rounds applies to this separate CI repair. Rollback is a test-only source revert; no durable, wire or product rollback is needed. Keep this as a separate narrow compatibility commit, preserving the four requested fixes as atomic feature commits. Remaining PR CI failures outside statistics retain their own owners and are not cleared by this slice.

## Implemented and locally verified

The six suites now bind their native Bun registrar through `pushSpanTests`; the final helper imports no Bun test globals and requires no type configuration change. All existing test assertions, names, timeouts and negative controls remain. Root's independent GPT review accepts both the original scoped-callback design and the final explicit registration seam. Final verification is **93 pass / 1 existing skip / 0 fail / 15,307 assertions** on both Bun 1.4.0 and 1.4.2; typecheck passes. Affected lint exits 0 with only documented pre-existing warnings. See `docs/design/notes/292/runtime-comparison.md`. Claude round-1 review aligned directly in-repo (`notes/292/review1-claude.md`); GPT and Claude are aligned.
