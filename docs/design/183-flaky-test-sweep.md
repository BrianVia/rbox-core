# 182 — deterministic flaky-test sweep

Status: **ALIGNED**

## Objective and boundaries

Execute `SPEC-FLAKE-SWEEP.md`: establish a durable flake registry, fix the
three live timing flakes, and audit `src/**/*.test.ts` plus `apps/api/test`
for the same sleep/deadline/unawaited-producer class.

The diff must not touch any path in
`git diff --name-only origin/main...origin/feat/180-atomic-genesis` (PR #394),
including the genesis API files and the `auth-cmd`, `e2ee-client`,
`setup-cmd`, `init-cmd`, and `front-door` tests named by the founder. A
candidate in that set is registry-only and `deferred: post-394`. No CI retry,
shard, timeout-layout, or production-behavior change is allowed. A narrow
injected clock, completion promise, or test hook may be added to production
code only when no existing observable event can close the race; its default
path must remain behavior-identical.

`docs/CODEMAP.md` is unchanged: no module is added and no ownership moves.

## Registry contract

`docs/flaky-tests.md` begins with the proof rule: a historical incident is a
confirmed flake only when it has (1) a dated CI failure link, (2) a green
rerun of that exact SHA, and (3) a green local isolation run. Incomplete
evidence is recorded honestly as pending, not upgraded by repetition on a
different SHA. Entries carry test/file, first/last seen, signature, cause,
status/fix, and proof.

The seed set is the July 22 websocket incident; the July 20 credential
incident and its July 22 recurrence; the multi-run design-93 §11 concurrent-
save incident (first 2026-07-12, last 2026-07-21); the July 20 design-170
cursor fix and its July 22 recurrence; and the v1.7.19 Parcel premise-versus-
contract split. `docs/STATUS.md` calls the July 21 §11 evidence “FOUR
strikes”; retained logs show two executions whose failure was repeated in the
body and job summary, not four distinct runs, and the registry says so.

The audit table records every reviewed candidate with exact test/file,
pattern, and disposition: fixed, note-only, false-positive/redundant,
protected/deferred, or acceptable condition-polling ceiling. Same-disposition
fixture-only `Date.now()` hits may be grouped by an enumerated file list, but
no reviewed candidate disappears from the census.

## Live-flake fixes

### 1. Websocket cursor tests

The current suppression test sends a committed frame, awaits arbitrary pump
and scheduler work, sleeps 40 ms, and assumes the next iteration runs before
the jittered cursor's 150 ms minimum. A timer sleep is only a lower bound; on
a starved shard the cursor legitimately fires before the next committed
frame. The reported `29ms` timeout is an adjacent blackhole test's expected
diagnostic (`cursorCheckMs=30`); the suppression daemon uses 200 ms and would
say 199 ms. The actual failure signature is the zero-send assertion receiving
a nonzero count after `[2773.07ms]`. The registry preserves the adjacent
warning as observed context but does not claim it caused the failure.

Add a cursor-only injected clock/random source to `RboxDaemon`. Its default
delegates to global `setTimeout`/`clearTimeout` at each schedule/clear call,
unrefs every cadence and reply-timeout handle, and evaluates `Math.random`
exactly once at each cadence arm where `jitter()` does today (never for reply
timeout). Handles are opaque and compared with `undefined`, never by
truthiness, and each handle is cleared through its creating clock. Preserve
the reply calculation and error text exactly:
`min(10_000, max(1, cursorCheckMs - 1))`. Route only cursor cadence and
cursor-reply timeout timers through it. A test manual clock then proves:

- committed frames repeatedly replace the cursor timer for more than three
  logical minimum cadences, with exact zero sends;
- missed-notify recovery fires at a logical cadence without a sub-100 ms wall
  assertion;
- blackhole timeout is single-flight and re-arms only after logical timeout;
- stop/reconnect/epoch callbacks advanced after invalidation cannot send.

Pong, backstop, reconnect, and every other timer remain untouched.
The same file's pong-deadline and backstop-positive cases switch from fixed
sleeps to `waitUntil`; the WS-disabled zero-backstop case removes its
causally unnecessary sleep.

### 2. Credential logout versus writer

The child writer currently holds its lock for a fixed 350 ms while the parent
polls every 10 ms and hopes to enter logout during that window. Replace the
window with a bidirectional child handshake: the quarantine hook announces
that the writer owns the lock and waits for release. Add a no-op-by-default
`lock-contended` test hook at the already-existing credential lock seam. It
only announces contention and returns immediately; it never waits while the
credential fence is held. The parent starts logout, waits until logout has
actually observed contention, then releases the writer and awaits both
operations. The same file's heartbeat-mtime test polls for the mtime event
under a generous ceiling instead of sleeping 60 ms. These prove normal wait,
heartbeat, and definitive clear without a real-time race or behavior change.

### 3. Design-93 §11 concurrent state saves

Both child processes currently load the same snapshot and then the daemon
sleeps 40 ms so the newer CLI writer will supposedly win. Replace that guess
with coordinator markers: both children snapshot and announce ready; the
parent releases and awaits the CLI sequence-2 save, then releases the stale
daemon sequence-1 save. Ready/release waits race child exit under a generous
failure ceiling, stdout/stderr are drained concurrently, and premature exits
surface captured stderr rather than hanging. The final state must remain
sequence 2. Production state-save code is unchanged.

## Repo-wide deterministic fixes

Clear sleep-then-exact-assert or unawaited-producer cases are fixed with the
smallest existing or new test control:

1. `telemetry/sync-state.test.ts`: expose a test flush for the reporter's
   internal write chain; await it instead of four 10 ms sleeps.
2. `git-cmd.test.ts`: inject/record heartbeat timer scheduling and clearing;
   assert teardown structurally rather than after 10 ms.
3. `remote/blob-batch/blob-batch.test.ts`: use the existing uploader clock
   and explicit dispatch-entry latches instead of 20/30 ms sleeps.
4. `remote/blob-batch/pack-upload.test.ts`: use the existing pack-start and
   batch-start gates to prove release ordering.
5. `remote/blob-batch/upload-grant.test.ts`: use test-only mocked-fetch
   completion and condition polling on the asserted refresh state; do not edit
   protected `remote/context.ts`. Any case that truly requires a context seam
   is `DEFERRED: POST-394`.
6. `crypto-pool.test.ts`: remove only the wholly redundant post-`reset()`
   sleep. Keep the bounded-queue and fused spill-close cases note-only because
   their explicit gates already prevent elapsed time from flipping outcomes.
7. `e2ee-sync.test.ts`: hold each fake chain GET behind an entered latch and
   release after `manifestMeta.chain.length` parallel reads have started; the
   sequential head-manifest GET is not part of the barrier.
8. `git/capture-stability.test.ts`: announce the first successful churn write,
   stop it through a gate, and await the producer.
9. `sync-git/follow.test.ts`: replace eight 2.1 s fingerprint-age sleeps with
   a test-only `heldNow?: () => number` option to `applyGitSections`. Evaluate
   it once per repo decision and pass that value through held-match, floor, and
   new-attempt timestamp decisions. The default remains `Date.now`.
10. `redeem-drain-upload.test.ts`: use the existing drain latch instead of a
    20 ms negative window.
11. `daemon/daemon-safety.test.ts`: replace both the 450 ms signal/state wait
    and zero-delay cadence turn with explicit state/scheduler events.
12. `daemon/daemon-activity.test.ts`: inject/advance logical now for the 2 ms
    `lastFailureAt` ordering case and use a stop-settlement event for the 50 ms
    negative case. Existing bounded condition polling stays note-only.
13. `sync-git/git-sync.test.ts`: widen only the independent-repo positive
    `betaStarted` event ceiling from 1 s to 10 s. The three held-operation
    negative non-overlap windows are registered as note-only concurrency
    contracts rather than weakened or misclassified as positive waits.
14. `remote/resilient.test.ts`: make the backoff stub announce entry and return
    a resource-free never-settling promise; await entry before aborting. This
    removes both the microtask ordering guess and the detached real 10 s timer.

If implementation inspection shows an item already has a causal await making
the sleep redundant, delete only the sleep. If a proposed seam would alter
runtime policy rather than only observability/control, leave the entry
note-only instead.

## Note-only contracts

Do not widen or mechanically remove time from tests whose subject is elapsed
time or a native backend observation window. The recovered #331 report's six
deliberate timing-contract families are:

- `shell-init.test.ts` 5 ms p99 prompt budget;
- `daemon/watcher.test.ts` native watcher observation window;
- `apply-stats.test.ts` measured apply wall;
- `dircache.test.ts` plus `dircache-bench.test.ts` racy-age/quiescence delays;
- `crypto-pool.test.ts` bounded queue plus `crypto-fused.test.ts` spill-close,
  whose explicit gates make the outcomes deterministic;
- `apps/api/test/pack-gc.test.ts` strict signed-issuance/mark wall ordering;

Also register:

- benign expiry observations in `blob-batch-auth-grant.test.ts`,
  `gc-purge.test.ts`, and `diagnostics.test.ts`, where later reclocking only
  makes day-scale fixtures more expired;
- upload/publish overlap accounting tests where measured intervals are the
  output contract;
- filesystem racy-margin tests (`dircache`, layer-A, Darwin bulk walk);
- native/compiled watcher quiet windows and real lockfile/process timeout
  probes;
- generous condition polling whose deadline is only a failure ceiling.

The audit may narrow the proposed fix list when code inspection proves a case
already event-controlled, but it must record that reviewed locus and must not
convert a performance boundary into a loose assertion merely to make it green.

## Proof

For every changed test file, run the whole file in ten separate processes,
record all ten elapsed walls, and publish min–max spread. The final proof
section in `docs/flaky-tests.md` records each changed file's ten results (or a
linked local log artifact plus all-green and min/max), exact commands/results
for the full gates, the protected-diff audit, all production seams/default-
equivalence checks, and the deferred list. Then run:

```text
bun test
bun run test:api
bun run typecheck
```

Run `bun run rig doctor --runner docker`, `bun run rig up --api-url <dev>`,
`bun run rig run two-device-live`, and `bun run rig run git-config-sync` to
exercise the unchanged default daemon timer and cross-process config paths.
Preserve the run evidence, then use scoped `bun run rig down`. An evidenced
environment failure is a blocker to resolve, not permission to silently omit
integration validation. Compute the PR #394 path set again and fail/report any
intersection with all changed paths. Confirm every non-test production diff is
an injection or test-control seam with behavior-identical defaults. Run
simplify/anti-slop review over the final patch.

The first commit contains `docs/flaky-tests.md` (this design and its review
ledger may accompany it) before any fix. Follow it with one commit per live
flake or tightly related audit group. Record the refwatch seed as
`FIXED-BY-DESIGN`: bounded pressure-premise exhaustion is `INCONCLUSIVE` with
exit 0, while established-pressure violations and the callback deadline remain
hard failures. Create `/tmp/rbox-flake-sweep.bundle` only if git metadata cannot
be written.
