# Runtime and fixture evidence

Main CI 33697551297 used Bun **1.4.0**; PR 882 run 33976813037 used **1.4.2+744846f84** via the unchanged `latest` selection. Provenance logs: `/private/tmp/rbox-main-baseline-ci.txt` and `/private/tmp/rbox-pr882-ci-failed.txt`. No statistics implementation or shard-script change introduced this behavior.

Isolated probe (`/private/tmp/rbox-als-hook.test.ts`): create one `AsyncLocalStorage`, call `enterWith('hook')` in `beforeEach`, then assert `getStore() === 'hook'` in a test callback. A second test wraps an awaited callback in `run('run', callback)` and checks `getStore() === 'run'` afterward. Bun 1.4.0: both pass. Bun 1.4.2: hook-context test fails with undefined; explicit run passes. No environment flag or shard-order change is needed to reproduce the failure.

Four unmodified affected suites on Bun 1.4.2: **43 pass / 10 fail / 15,133 assertions**. Their names and zero/undefined statistics match CI. Log: `/private/tmp/rbox-stats-bun142-before.log`.

After the test-only migration, the same nine-suite verification on both supported runtimes reports **93 pass / 1 existing skip / 0 fail / 15,307 assertions** (5.54 seconds each in final runs). Files: phase-report, remote-commits, remote-commits-cap, redeem-drain-upload, first-publish-overlap, publish-pipeline/pipeline, upload-grant, push-spans, and the new push-spans-test-helper regression. The existing upload-grant skip is `missing auth echoes classify overlapping dispatches as a bearer envelope`; this repair adds no skip and does not weaken it. Logs: `/private/tmp/rbox-stats-bun140-after.log` and `/private/tmp/rbox-stats-bun142-after.log`.

The migrated assertions remain intact: concurrent measurement voiding, disabled output, stale-generation rejection, upload overlap/union, redeem requests/receipts and final flush accounting. Existing `concurrent push owners isolate every ambient sink` and nested-tail tests pass. Two new fixture tests check the supplied owner through async continuations and fresh disabled state for each registration.

`bun run typecheck` passes for root/API/scripts on 1.4.2. An initial prototype import of `bun:test` from the non-test helper failed the existing Node-only typecheck; the final helper receives a narrow native registration function from its calling `.test.ts` file, avoiding any tsconfig/dependency/suppression workaround. Root independently reviewed and accepted that final construction seam.

Affected lint exits 0: no new-helper/context-migration findings; four existing fingerprint warnings and four existing chained test-fixture assertions remain. The latter are pre-existing mock-shape casts in pipeline/redeem fixtures, unrelated to asynchronous context ownership; they were not laundered or rewritten in this repair. `git diff --check` passes. Local checks do not claim the whole PR CI is green; the unrelated Git-artifact timeout has a separate owner.
