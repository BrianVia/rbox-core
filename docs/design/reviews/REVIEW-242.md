# REVIEW-242 — daemon test process isolation

## Round 1 — CHANGES REQUIRED

- Required the exact shard commands to remain the red proof; a deterministic
  invariant could expose the state but could not replace the founder's gate.
- Required catalog cleanup under the same `RBOX_HOME`, after all daemons for the
  root stop, once per normalized root.
- Required an exhaustive env inventory rather than a claim narrower than the
  requested `src/cli` scope.
- Required a generation-safe, real-hash-delegating replacement for permanent
  Bun module mocks.

Executed evidence: folder catalog + watcher focused tests, 19 pass / 0 fail.

## Round 2 — CHANGES REQUIRED

- The first hash reset used function identity; reinstalling the same callback
  let a stale reset clear the current override.
- A second direct daemon in `watcher-retrust.test.ts` still bypassed `stop()`.
- A preload env guard could not cover `beforeAll`/`afterAll` ordering and was
  rejected in favor of source-owned restoration.
- The isolated-home activity fixture released before stopping daemons created
  inside its callback.
- Catalog release errors were swallowed, allowing silent re-poisoning.

Executed evidence: four former hash-mock suites, focused watcher, typecheck, and
diff check green.

## Round 3 — CHANGES REQUIRED (final round)

The core daemon/catalog/hash repair aligned:

- hash override uses a generation token and covers same-callback reinstall;
- every direct watcher construction path awaits `stop()`;
- isolated-home teardown stops its owned daemon slice before exact release;
- all six admission-helper users release through real `forgetFolder` and
  propagate release failures while completing filesystem/env cleanup;
- no preload-wide env hook remains.

The remaining blocker was completeness of the explicit env audit. Nine named
CLI fixtures still unconditionally deleted inherited values. They were repaired
after this final review without expanding the design: each now snapshots and
restores the keys it owns at the matching test lifecycle boundary. No fourth
review was scheduled, per the founder's three-round cap.

Executed evidence: former hash mocks + watcher 31 pass / 0 fail; isolated-home
activity cases 4 pass / 0 fail; typecheck and diff check green.

