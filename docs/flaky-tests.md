# Flaky-test registry

## Proof protocol

A test is called a **confirmed flake** only when all three witnesses exist:

1. a dated link to the CI failure;
2. a green rerun of the **same commit SHA**; and
3. a green local run of the failing test file in isolation.

A green run on a later SHA is regression evidence, not proof that an earlier
failure was flaky. A repeated failure without its same-SHA rerun is a suspected
flake. Every fix must run the complete changed test file ten times in separate
processes, report all-green plus its minimum/maximum wall time, and then pass
the full repository, API, and typecheck gates.

Statuses used below:

- **SUSPECTED** — one or more witnesses are missing;
- **CONFIRMED** — all three proof witnesses exist;
- **FIX PENDING** — root cause is known and the deterministic patch is in this
  sweep but not yet committed;
- **FIXED** — deterministic fix merged/committed with its proof;
- **FIXED-BY-DESIGN** — the old binary pass/fail claim was replaced by a more
  accurate contract;
- **NOTE-ONLY** — timing is the contract, or condition polling has a generous
  failure ceiling and does not control the asserted outcome;
- **DEFERRED: POST-394** — actionable, but its file belongs to PR #394.

## Incident registry

### FLAKE-001 — committed frames suppress the websocket cursor

| Field | Record |
|---|---|
| Test | `live committed frames reset the cursor cadence before it can wake the DO` |
| File | `src/cli/daemon/daemon-ws-reliability.test.ts` |
| First / last seen | 2026-07-20 / 2026-07-22 |
| Failure | expected zero cursor sends, received nonzero after `[2773.07ms]` in v1.7.21 release CI, shard 4; adjacent log context included `ws cursor check failed: cursor reply timed out after 29ms` |
| Root cause | The test sleeps 40 ms between committed frames and assumes a starved runner will resume before the jittered cursor's 150 ms minimum; the exact 29 ms diagnostic is expected output from the adjacent 30 ms blackhole test, not this daemon's 199 ms deadline. |
| Status / fix | **CONFIRMED — FIXED** in `25da94b2` (final barrier hardening `f1d56a55`). Design 255 preserves the named test in `daemon-ws-reliability.test.ts` and ports its wall-time domination proof to the injected `RemoteWakeupChannel` clock/random Interface; defaults preserve native timers, jitter, and `unref`. |
| Proof | Surviving coverage: `live committed frames reset the cursor cadence before it can wake the DO` advances twelve committed frames across more than three minimum-jitter cadence windows and still asserts exactly zero cursor sends. First failure [2026-07-20 run](https://github.com/BrianVia/rbox-core/actions/runs/29786152966); [failed and same-SHA rerun run](https://github.com/BrianVia/rbox-core/actions/runs/29913968169), exact SHA `0a88543538901c8d96b924c7bbf54cf0b1681083`; rerun green; isolation green. |

### FLAKE-002 — logout waits for an in-flight credential writer

| Field | Record |
|---|---|
| Test | `logout waits for a normal in-flight credential writer and clears definitively` |
| File | `src/cli/credentials.test.ts` |
| First / last seen | 2026-07-20 / 2026-07-22 |
| Failure | `[50.51ms]` on PR #373; `[56.48ms]` on PR #394, shard 4 |
| Root cause | A child holds the credential lock for a fixed 350 ms while the parent polls every 10 ms; neither sleep establishes that logout actually encounters the live writer. |
| Status / fix | **CONFIRMED historical flake — FIXED** in `734d87f4` (teardown hardening `f1d56a55`); the 2026-07-22 recurrence remains **SUSPECTED** because its same-SHA rerun is pending. Child-owned-lock and parent-observed-contention handshakes replace both timing windows. The PR #394 protected-path diff does not include `credentials.ts` or this test. |
| Proof | [2026-07-20 failure and green failed-job rerun](https://github.com/BrianVia/rbox-core/actions/runs/29753317433); [2026-07-22 recurrence](https://github.com/BrianVia/rbox-core/actions/runs/29937523471) has 5× isolation and two green full local runs, but its same-SHA CI rerun remains pending. |

### FLAKE-003 — design-93 §11 concurrent saves

| Field | Record |
|---|---|
| Test | `§11 E2E: concurrent daemon/CLI process saves preserve newer-source atomicity` |
| File | `src/cli/git-config-sync.e2e.test.ts` |
| First / last seen | 2026-07-12 / 2026-07-21 |
| Failure | final state expected sequence 2 but received sequence 1; observed `[284ms]`, `[267ms]`, `[398.10ms]`, `[859.11ms]`, `[205.70ms]`, `[529.06ms]`, `[342.57ms]`, `[458.01ms]`, and `[491.08ms]` |
| Root cause | Two child processes load the same snapshot, then the daemon merely sleeps 40 ms in the hope that the newer CLI writer finishes first; scheduler order and one-shot lock acquisition are uncontrolled. |
| Status / fix | **SUSPECTED — FIXED** in `afd948c9`. Both child snapshot-ready events are coordinated; the parent releases/awaits CLI sequence 2 before releasing stale daemon sequence 1, with both stderr streams drained. Production save logic is unchanged. The historical incident remains suspected because one three-witness set is incomplete. |
| Proof | [2026-07-21 failed run and failed-job rerun](https://github.com/BrianVia/rbox-core/actions/runs/29854135760); earlier exact-SHA reruns include [2026-07-20](https://github.com/BrianVia/rbox-core/actions/runs/29758980906). `docs/STATUS.md` says “FOUR strikes” on July 21, but the retained log shows two executions whose failure body was duplicated in each job summary, not four distinct runs. The sweep's refreshed isolation proof is below. |

### FLAKE-004 — original design-170 cursor timer cluster

| Field | Record |
|---|---|
| Tests | `a missed committed frame is recovered by cursor before the backstop and credited once`; `live committed frames reset the cursor cadence before it can wake the DO`; `a blackholed cursor is bounded, single-flight, does not cycle the socket, and preserves backstop`; `cursor epoch fences committed, reconnect, and stop overlaps` |
| File | `src/cli/daemon/daemon-ws-reliability.test.ts` |
| First / last seen | 2026-07-20 / 2026-07-20 for the original cluster; FLAKE-001 is the 2026-07-22 recurrence |
| Failure | roughly 1-in-6 exact send-count failures around jittered cursor windows |
| Root cause | Fixed sleeps and exact counts raced cadence jitter and event-loop delay. |
| Status / fix | **FIXED** by `5a49b752`, merged as PR #380 / `a1b10bca`; design 255 preserves all four named tests in `daemon-ws-reliability.test.ts` and ports their ordering proofs to the injected `RemoteWakeupChannel` clock, socket, receipt, and health Interfaces. No cluster test is retired or substituted by suite-count equivalence. |
| Proof | Surviving coverage: missed-frame recovery still proves cursor-before-backstop and cursor-only credit; live frames still prove exact zero cursor sends; blackhole still proves bounded single-flight/no socket cycle/backstop preservation; epoch overlap still fences committed/reconnect/stop and carrier credit. Original CI failures: [epoch-overlap exact-count run/job](https://github.com/BrianVia/rbox-core/actions/runs/29785665033/job/88496559312) and [live-committed zero-count run/job](https://github.com/BrianVia/rbox-core/actions/runs/29786152966/job/88498019200). Retained history does not identify a green same-SHA rerun for every original occurrence, so cluster-wide historical proof is incomplete; fix commit records 25/25 post-fix isolation green. |

### FLAKE-005 — Bun refwatch Parcel-pressure premise

| Field | Record |
|---|---|
| Probe | `scripts/probe/bun-refwatch-contract.ts` |
| First / last seen | 2026-07-21 / 2026-07-21 |
| Failure | Parcel delivered zero pressure events on four described pipeline legs (three on July 21: two main CI and one release smoke, plus the v1.7.16 train), previously reported as a Bun contract failure. Exact historical run URLs were not recovered. |
| Root cause | The environment failed to establish the Parcel-starvation premise, so the Bun behavior under pressure was not observed. |
| Status / fix | **FIXED-BY-DESIGN** in PR #389 / `cbcab7b9` (local `4a2fb24c`): premise-only starvation retries with bounded escalation and then reports `INCONCLUSIVE` with exit 0; an established-pressure contract violation and callback deadline still hard-fail. |
| Proof | v1.7.19 premise-versus-contract split; `docs/STATUS.md` and fix history record the incident and corrected semantics. |

### FLAKE-006 — contended credential save loses a serialized writer

| Field | Record |
|---|---|
| Test | `separate save processes serialize and leave one complete v1 document` |
| File | `src/cli/credentials.test.ts` (line 424) |
| First / last seen | 2026-07-28 / 2026-07-28 |
| Failure | `expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0])` received `[0, 1]` after `[80.19ms]` on PR #536, shard 3/6 |
| Root cause | Real product race, not a test artifact: `readMarker` opened a *contended* fence marker after lstat'ing it, and the fence holder's release unlinked that marker inside the window, so the observing writer took a fatal `ENOENT` out of `acquireFence` instead of retrying. Nothing fences the fence, so the window is unavoidable; only its disposition was wrong. |
| Status / fix | **CONFIRMED — FIXED** on `chore/flake-006`. An inspection-window disappearance or replacement now raises `MarkerTurnoverError`, and the fence observer (`inspectHeldFence`) treats it as "look again" — the same disposition `readMarkerNoFollow` already gives "lock changed during inspection" in `src/engine/lockfile.ts`. Owners of a marker keep failing closed by not catching it. |
| Proof | [2026-07-28 failure](https://github.com/BrianVia/rbox-core/actions/runs/30324649446/job/90167390189) and [green same-SHA rerun](https://github.com/BrianVia/rbox-core/actions/runs/30324649446/job/90193788407), exact SHA `7ce9e01adf04c9b673e7ad148755dea1da213140`. Root-caused by reproducing the exact `ENOENT` stack under 8-way load (1 loss in 240 contended pairs; 0 in 240 after the fix). Regression test `a fence released inside the inspection window is a retry, not a lost writer` drives the interleaving through the `marker-observe-before-open` seam: red with the fix stashed, green with it; 10× isolation of the file green (47 tests, 4.59–4.71 s). |

### FLAKE-007 — onboarding rig sha_mismatch under one overwritten Bun canary

| Field | Record |
|---|---|
| Test | `onboard-smoke` — `[A] init --new` initial push, `blob PUT failed: 400 {"error":"sha_mismatch"}` |
| File | CI job `compiled TUI · onboarding rig` (rig driver runs `bun-version: "canary"`; the rbox binary itself is built on 1.3.14) |
| First / last seen | 2026-08-10 / 2026-08-10 |
| Failure | Main run for #626 merge ([run 31402717470](https://github.com/BrianVia/rbox-core/actions/runs/31402717470) attempt 1), SHA `321bf7599`: first blob PUT rejected by the dev API with `sha_mismatch` at 0% upload. |
| Root cause | Environment, not code: the failing attempt ran Bun canary `1.4.0-canary.1+827475e21`; the same repo content passed the identical job on the PR ~15 h earlier under canary `52bf09cb1` and on the same-SHA rerun under canary `9fcdea80b`. The bad canary lived inside a ~15 h window and the `canary` tag is overwritten in place, so `827475e21` is no longer downloadable and cannot be bisected. Local rig on Bun 1.3.14 (same SHA) passed end-to-end; full engine suite under `9fcdea80b` passed 871/871. |
| Status / fix | **CONFIRMED — NOTE-ONLY** (environment drift, no repo change possible). Disposition for recurrences: a red canary-driver rig job with a green same-SHA history is first re-run against the *current* canary before any code investigation; record the failing `bun --revision` from the job log immediately — it is unrecoverable once the tag moves. |
| Proof | Failed attempt-1 log (canary `827475e21`), [green same-SHA rerun](https://github.com/BrianVia/rbox-core/actions/runs/31402717470) (canary `9fcdea80b`), green PR-run 2026-08-09 23:57 (canary `52bf09cb1`), green local rig on 1.3.14, exact SHA `321bf75991ceedd1d95a20108d6e7a580b5ed4ab`. |

### FLAKE-008 — credentials fresh-main contention fence timeout

| Field | Record |
|---|---|
| Test | `fresh main contention and a live exact-incarnation fence fail closed without reaping` |
| File | `src/cli/credentials.test.ts` |
| First / last seen | 2026-08-13 / 2026-08-14 |
| Failure | PR #682 `tests · shard 6/6` attempt 1 timed out at `[15001.53ms]`; PR #689 `tests · shard 3/6` attempt 1 timed out at `[15000.45ms]`. Both were instrumentation-only diffs outside credential fencing. |
| Root cause | The test sequentially exhausted the production 80-attempt, 25-ms retry policy twice—first against the fresh main marker, then against the live exact-incarnation fence. That requests about four seconds of sleeps before filesystem work; starved CI runners stretched the timers and marker inspection past Bun's 15-second ceiling. Both markers are under the test's private root, so no neighboring lock holder was involved. |
| Status / fix | **CONFIRMED — FIXED** on `credentials-flake-fix`. A process-local installer, patterned after the existing heartbeat installer, supplies a short retry delay/count while production remains 80×25 ms. The regression exhausts every configured attempt for both marker classes, asserts acquisition fails closed, and compares each live marker byte-for-byte after failure. The harness now sets and restores both `HOME` and the preferred `RBOX_HOME`; the symlink-root case redirects both. No shard serialization, timeout increase, or safety-coverage reduction. |
| Proof | PR #682 attempt 2 passed on the same SHA; pre-fix isolation was 49/49 green in 4.6 s. Post-fix, the complete file passed in ten fresh processes (48 pass, 1 skip each; 0.493–0.610 s), plus an independent review run (48 pass, 1 skip in 0.526 s). The test's exact attempt traces are `0..3` for both main and fence markers. |

### FLAKE-009 — daemon-activity load flake is one state.json republish race

| Field | Record |
|---|---|
| Tests | `a second watcher error during the covering scan keeps status degraded`; `review M2: a busy repo is transiently unprovable and still re-arms the post-pull push`; `executeOp D1a: a successful recovery-probe fullScan clears watcher-degraded like an ordinary scan` — plus, under local load, at least nine more names in the same file |
| File | `src/cli/daemon/daemon-activity.test.ts` |
| First / last seen | 2026-08-15 / 2026-08-15 |
| Failure | PR #741 (`sp25-rig`, a diff that touches no daemon code) failed `tests · shard 1/6` on three consecutive attempts of [run 31906625854](https://github.com/BrianVia/rbox-core/actions/runs/31906625854), each on a different test name. All three carry the identical body: `ResetCorruptionError: reset-corruption: reset file changed while reading /tmp/rbox-daemon-activity-*/.rbox/state.json`, `kind: "identity-race"`, thrown from `boundedStream` → `boundedHash` → `artifactIdentity` → `createResetFenceObservation` → `inspectResetFenceInventory` → `recoverStandingResetJournal` → `loadLegacyJsonState`. |
| Root cause | Not timing sensitivity in the tests, and not three flakes: one product race, attributed by Bun to whichever test was running when the rejection surfaced. Every ordinary state load runs `recoverStandingResetJournal`, which fingerprints the workspace's physical artifacts by hashing `state.json` — unlocked, because a load must not serialize behind writers. State writers publish `state.json` by atomic rename (`writeFileAtomic`), so a republish landing inside that hash flips the file's dev/ino and `boundedStream` correctly reports an identity race. `boundedRead` already treats a settled republish as retryable (`identityRetries`, default 2); the fence's `boundedHash` had no such retry, so the benign case threw. The daemon suite hits it constantly because `SyncStateReporter` mints `telemetryBindingId` into `state.json` on each fresh test root while the pump is loading; contention widens the window, which is why it reads as a load flake. |
| Status / fix | **CONFIRMED — FIXED** on `fix/daemon-activity-load-flake`. `reset-io` now owns one retry policy, `retryOnIdentityRace`, and both `boundedRead` and the fence's `artifactIdentity` go through it. Review also closed a second, quieter window in the same tuple: `boundedHash` guards only its own read, so a rename completing between the outer `lstat` and that read paired old metadata with a new hash without either noticing. `artifactIdentity` now re-stats after hashing and raises the same identity race (ENOENT included, so the retry settles a vanished file to `["absent"]`), which makes "one settled file" actually true. Scope stays narrow on purpose: standing-reset inspection (`observeLegacyResetPhysical`, `optionalStableHash`, `stableDbHash`) keeps NO retry — on the destructive plane a concurrently republished artifact must fail closed. No assertion was weakened, no timeout raised, no test skipped; non-race corruption and an exhausted budget still throw. |
| Proof | Local repro: 24 concurrent copies of the file × 3 rounds under 16 busy-loop stressors on a 32-core host. Pre-fix 15/72 process-runs failed, 100% of them on this race, spread across 12 distinct test names. Post-fix 0 races in 120 runs of the identical harness (72 + 48). Isolation is 65/65 and CI shard 1/6 runs 833 pass / 0 fail locally. `retryOnIdentityRace` is pinned deterministically in `src/cli/reset-io.test.ts`: a rename that lands mid-read is re-read (the witness records both the pre- and post-rename bodies), a `kind: "corruption"` failure is never retried, and an unending race still throws after exactly three attempts. The call site cannot silently drop either obligation: `artifactIdentity` is now an enumerated entry point in the state barrier pinning inventory with `guards: ["retryOnIdentityRace", "assertUnmovedSince"]`, checked as real ordered calls from the AST sweep. |

### FLAKE-010 — pr8 pull-only timers await the wrong pump

| Field | Record |
|---|---|
| Test | `pr8: production pull-only timers remint discovery and clear a ghost without pushing` |
| File | `src/cli/daemon/daemon-activity.test.ts` |
| First / last seen | 2026-08-15 / 2026-08-15 (local load harness only; no CI sighting) |
| Failure | `expect(daemon.syncBase?.repoRecords?.ghost?.deferrals).toBeUndefined()` received the seeded `capture` deferral. The preceding epoch assertion passed, so the deep scan had run and only the deferral hygiene behind it had not. |
| Root cause | Suspected: after `clock.fireDeep()` the test hops one microtask (`await Promise.resolve()`) and then awaits `daemon.pumpRun`. That is not a completion signal for the pump the deep scan requested — under contention `pumpRun` can still be an earlier pump, and awaiting it returns before hygiene runs. Distinct from FLAKE-009; it survived that fix. |
| Status / fix | **SUSPECTED — OPEN.** Not fixed here: the FLAKE-009 change is unrelated to it, and the honest repair needs a real pump-quiescence signal from `RboxDaemon` rather than another hop. Do not paper over it with a sleep or a poll on the asserted value. |
| Proof | 1 of 72 post-FLAKE-009 process-runs under the 24-way + 16-stressor harness (`r3-p23`), and 1 of 24 in a pre-fix round. Isolation and the ordinary shard run are green. |

## Same-class audit candidates

These are the actionable occurrences found by the `src/**/*.test.ts` and
`apps/api/test` sweep. Each fixed row originally contained a sleep or unawaited
producer that directly controlled an exact assertion; the status records its
deterministic disposition after implementation review.

| ID | File / test area | Risk and deterministic disposition | Status |
|---|---|---|---|
| AUDIT-001 | `src/cli/telemetry/sync-state.test.ts` — `reporter gates unchanged ticks...` and `kill switch...` | Fire-and-forget tick/heartbeat followed by 10 ms then exact call counts; await the reporter's internal chain through a test flush. | **FIXED** `e353fcff` |
| AUDIT-002 | `src/cli/git-cmd.test.ts` — resolve heartbeat teardown | Sleeps 10 ms after return then asserts no later output; inject/record timer lifecycle and assert clear structurally. | **FIXED** `0a09bb93`, `f1d56a55` |
| AUDIT-003 | `src/cli/remote/blob-batch/blob-batch.test.ts` — queued close and pull-first tail | 20/30 ms sleeps control exact dispatch counts; use existing uploader clock and dispatch-entry gates. | **FIXED** `f0559760`, `f1d56a55` |
| AUDIT-004 | `src/cli/remote/blob-batch/pack-upload.test.ts` — pack release wakes batch | 20 ms negative window before exact no-batch assertion; use pack/batch entry gates. | **FIXED** `f0559760`, `f1d56a55` |
| AUDIT-005 | `src/cli/remote/blob-batch/upload-grant.test.ts` — refresh and close cases | Unawaited refresh followed by `setTimeout(0)`/100 ms race; observe the actual in-flight refresh promise or positive state and structurally drain close. The protected `src/cli/remote/context.ts` needed no edit; the disabled overlap case remains note-only. | **FIXED / NOTE-ONLY SKIP** `f0559760`, `f1d56a55` |
| AUDIT-006 | `src/engine/crypto-pool/crypto-pool.test.ts` — post-reset status | A 25 ms sleep follows an already-awaited reset and is redundant; remove it. | **FIXED** `30aa28cd` |
| AUDIT-007 | `src/cli/e2ee-sync.test.ts` — `D fast pull evidence mismatches...` | Fake chain GET sleeps 5 ms to manufacture overlap; entered/release gates prove the expected chain reads (not the sequential head read) are in flight. | **FIXED** `30aa28cd`, `f1d56a55` |
| AUDIT-008 | `src/cli/sync-git/capture-stability.test.ts` — ambient index churn | Unawaited churn producer plus 10 ms startup guess; wait for first churn and stop/drain the producer on every exit. | **FIXED** `30aa28cd`, `f1d56a55` |
| AUDIT-009 | `src/cli/sync-git/follow.test.ts` — held fingerprint aging | Eight 2.1 s sleeps age a 2 s racy-clean margin; inject one shared logical `heldNow` for tests while omitted production call sites retain their original independent wall-clock reads. | **FIXED** `aecf3634`, `f1d56a55` |
| AUDIT-010 | `src/cli/redeem-drain-upload.test.ts` — serialized backpressure | 20 ms negative window before exact PUT count despite an existing drain gate; assert through that gate. | **FIXED** `30aa28cd` |
| AUDIT-011 | `src/cli/daemon/daemon-safety.test.ts` — signal/state and safety cadence cases | A 450 ms signal wait and `setTimeout(0)` scheduler turn precede exact assertions; drive/await the exact signal batch and scheduler state. | **FIXED** `15d98beb`, `f1d56a55` |
| AUDIT-012 | `src/cli/daemon/daemon-activity.test.ts` — `lastFailureAt` ordering and stop-settlement cases | A 2 ms timestamp guess and 50 ms negative stop window precede exact assertions; inject logical now and race the owned stop-settlement promise. Existing condition polling remains note-only. | **FIXED** `15d98beb`, `f1d56a55` |
| AUDIT-013 | PR #394 protected files | The authoritative 56-path diff was scanned. No clear live fix above needs a protected path; any later candidate there is **DEFERRED: POST-394**, never edited in this sweep. | **NOTE-ONLY / DEFER POLICY** |
| AUDIT-014 | `src/cli/daemon/daemon-ws-reliability.test.ts` — pong deadline, backstop positive, WS-disabled zero-backstop | Fixed 100/90/50 ms sleeps precede exact counts/state; await positive events, inspect scheduled backstop preservation, and remove the causally unnecessary disabled-path sleep. | **FIXED** `25da94b2`, `f1d56a55` |
| AUDIT-015 | `src/cli/credentials.test.ts` — `a long fenced operation refreshes the main marker...` | Sleeps 60 ms after a 10 ms heartbeat then asserts mtime advanced; condition-poll the mtime event under a generous ceiling. | **FIXED** `734d87f4`, `f1d56a55` |
| AUDIT-016 | `src/cli/sync-git/git-sync.test.ts` — `git apply pools independent repos...` | The positive `betaStarted` event uses a 1 s failure ceiling; preserve the causal promise and raise only this starvation ceiling to 10 s. The three negative non-overlap windows below stay note-only as concurrency contracts. | **FIXED** `30aa28cd` |
| AUDIT-017 | `src/cli/remote/resilient.test.ts` — `abort mid-backoff aborts the retry` | A microtask guess precedes abort and the losing sleep leaves a real 10 s timer detached; announce sleep entry and return a resource-free never-settling promise before abort. | **FIXED** `e353fcff` |

## Note-only timing contracts and acceptable ceilings

Commit `d2b8a69a` / PR #331 left these six deliberate timing-contract
families as notes:

| File / test area | Why it stays note-only |
|---|---|
| `src/cli/shell-init.test.ts` — deferrals reader 5 ms p99 budget | The elapsed-time performance boundary is the asserted product contract. |
| `src/cli/daemon/watcher.test.ts` — `SCALE (design §41): monorepo-shaped tree — ready fast, memory flat, node_modules subtree pruned` and native watcher quiet windows | The scale contract asserts `<10s` readiness, `<300MB` RSS, and a 500 ms negative native window; other negative Parcel/native delivery windows likewise cannot be deleted. |
| `src/engine/apply-stats.test.ts` — phase decomposition tracks apply wall | The measured apply wall is the output; scheduler distortion does not flip a discrete race assertion. |
| `src/engine/dircache.test.ts` and `src/engine/dircache-bench.test.ts` | Sleeps establish the filesystem timestamp-age/quiescence precondition itself. |
| `src/engine/crypto-pool/crypto-pool.test.ts` bounded queue and `crypto-fused.test.ts` spill-close | Explicit queue/spill gates keep elapsed time from changing the result; the waits observe a performance/concurrency contract. |
| `apps/api/test/pack-gc.test.ts` strict issuance/mark ordering | Condition-controlled waits advance to a distinct wall-clock millisecond for a security ordering contract. |

Benign observations recorded separately from those six: expiration fixtures
in `apps/api/test/blob-batch-auth-grant.test.ts` and
`apps/api/test/gc-purge.test.ts` only become more expired when reclocked, and
the diagnostic URL expiry assertion in `apps/api/test/diagnostics.test.ts`
has a days-wide margin.

Additional note-only audit entries:

| File / test area | Risk note |
|---|---|
| `src/cli/first-publish-overlap.test.ts` | Open-interval overlap is the measured contract. |
| `src/cli/remote-commits.test.ts` | Final-drain and overlap accounting intentionally consume actual elapsed time. |
| `src/cli/redeem-drain-upload.test.ts` overlap/final-flush cases | Positive wall metrics are the contract; only AUDIT-010's negative sleep is actionable. |
| `src/cli/upload-lane-timing.test.ts` | Subprocess upload/queue attribution is an explicit timing contract. |
| `src/cli/publish-pipeline/pipeline.test.ts` | Latency-driven overlap/backpressure is asserted structurally and by ranges. |
| `src/engine/darwin-bulk-walk.test.ts` and layer-A racy-margin cases | Clock movement establishes filesystem race preconditions. |
| `src/engine/lockfile.test.ts` real process timeout | The real SIGKILL/identity deadline is an explicit performance boundary with a generous outer ceiling. |
| `src/cli/watcher-compiled.test.ts` | Child/native watcher soak delays are compiled integration contracts. |
| `src/cli/daemon/daemon-git-capture.test.ts` | Condition polling has a 3 s ceiling; the separate sustained lock pulses intentionally exercise the synchronous 3 s max-wait contract. |
| `src/cli/daemon/daemon-git-ref-integration.test.ts` | 250/650 ms windows observe real native watcher arm/drain behavior; positive state uses a condition wait. |
| `src/cli/design85-layer-a.test.ts` | Racy-margin sleeps establish the filesystem quiescence precondition. |
| `src/cli/remote/blob-batch/uploader-fill.test.ts` | Scheduling uses an injected fake clock; the 5 s loop is a condition-driven failure ceiling. |
| `src/engine/apply-concurrency.test.ts` | The test awaits an explicit peak event; 10 s is only its generous failure ceiling. |
| `src/cli/sync-git/keep-pins.test.ts` | A real subprocess result races a 10 s outer failure ceiling and reports timeout explicitly. |
| `src/engine/manifest-delta.bench.test.ts` | The 2 s gate is an explicit benchmark/performance regression contract. |
| `src/cli/sync-git/git-sync.test.ts` — shared-common-dir, nested parent/child, and concurrency=1 non-overlap | The held first operation plus 1 s negative window is the concurrency contract; elapsed delay cannot turn a correct implementation positive, and structural scheduler inspection would exceed this sweep. |
| Skipped upload-grant overlap test | It contains timing risk but is disabled; retain as a note until re-enabled. |

## `Date.now()` census

The audit found `Date.now()` in 58 in-scope files. Every occurrence is covered
below; none revealed another tight real-time assertion beyond the actionable or
note-only loci already registered.

- API fixture/logical-input only (row creation, explicit expiry/age inputs, or
  injected handler time): `apps/api/test/abuse-hardening.test.ts`,
  `account-delete.test.ts`, `admin.test.ts`, `api-keys.test.ts`,
  `auth-version.test.ts`, `blob-batch-auth-grant.test.ts`,
  `blob-batch.test.ts`, `blob-pack-put.test.ts`, `blob-pack-read.test.ts`,
  `blob-pack-redeem.test.ts`, `blobs-grant.test.ts`,
  `commit-delta-shadow.test.ts`, `fairuse-scan.test.ts`, `gc-phase1.test.ts`,
  `gc-purge.test.ts`, `multipart-inventory.test.ts`, `notify.test.ts`,
  `receipts-flow.test.ts`, `sidecar-flow.test.ts`, `slackpipes.test.ts`,
  `worker.test.ts`, `ws-purge.test.ts`, and `ws-session-cap.test.ts`.
- API reviewed timing observations: `apps/api/test/diagnostics.test.ts` has a
  days-wide expiry margin; `telemetry-ingest.test.ts` checks only that a
  server-stamped row is no earlier than the request; and `pack-gc.test.ts` is
  the deliberate security-ordering timing contract listed above.
- CLI/engine fixture, injected-clock, or cache-buster only:
  `src/cli/remote/blob-batch/blob-batch.test.ts`,
  `src/cli/remote/resilient.test.ts`,
  `src/cli/sync-git/conflict-retention.test.ts`, `fingerprint.test.ts`,
  `held-skip.test.ts`, `pending-supersession.test.ts`,
  `sync-git-config-push.test.ts`, `src/cli/telemetry/sync-phase.test.ts`,
  `src/engine/apply-receipt.test.ts`, `engine-m1.test.ts`, `engine.test.ts`,
  `git-state.test.ts`, `src/cli/sync-git/config-txn.test.ts`,
  `index-identity.test.ts`, and `src/engine/trash.test.ts`.
- CLI/engine reviewed timing loci already represented by an actionable or
  note-only row: `src/cli/credentials.test.ts`,
  `src/cli/daemon/daemon-activity.test.ts`, `daemon-git-capture.test.ts`,
  `daemon-git-ref-integration.test.ts`, `watcher.test.ts`,
  `src/cli/design85-layer-a.test.ts`, `git-config-sync.e2e.test.ts`,
  `redeem-drain-upload.test.ts`,
  `src/cli/remote/blob-batch/pack-upload.test.ts`, `src/cli/shell-init.test.ts`,
  `src/cli/sync-git/follow.test.ts`, `git-sync.test.ts`,
  `src/cli/watcher-retrust.test.ts`,
  `src/engine/crypto-pool/crypto-fused.test.ts`,
  `src/engine/darwin-bulk-walk.test.ts`, `dircache.test.ts`, and
  `src/engine/lockfile.test.ts`.

The audit found four unawaited-producer families requiring fixes
(AUDIT-001, AUDIT-005, AUDIT-008, AUDIT-017). Reviewed D1 helper arrows ending in
`.run()` return their promise to an awaited caller and are false positives,
not unawaited producers. Reviewed plain `Date.now()` uses that only seed
database rows, grants, expiries, or logical fixtures without a tight delta
assertion are likewise false positives, not timing candidates. The explicit
sleep/setTimeout census accounts for all 34 matching test files.

## Sweep proof — 2026-07-22

### Ten-process isolation matrix

Each changed test file ran as a whole in ten fresh Bun processes with no retry.
All 170 processes passed. The retained transcript is
`/tmp/rbox-flake-sweep-isolation.log` and ends in
`ISOLATION_MATRIX_COMPLETE`.

| Test file | Passes | Wall spread (seconds) |
|---|---:|---:|
| `src/cli/credentials.test.ts` | 10/10 | 4.54–4.57 |
| `src/cli/daemon/daemon-activity.test.ts` | 10/10 | 5.14–6.13 |
| `src/cli/daemon/daemon-safety.test.ts` | 10/10 | 0.11–0.12 |
| `src/cli/daemon/daemon-ws-reliability.test.ts` | 10/10 | 0.36–0.40 |
| `src/cli/e2ee-sync.test.ts` | 10/10 | 10.57–13.83 |
| `src/cli/git-cmd.test.ts` | 10/10 | 22.10–22.28 |
| `src/cli/git-config-sync.e2e.test.ts` | 10/10 | 3.84–3.88 |
| `src/cli/redeem-drain-upload.test.ts` | 10/10 | 0.16–0.18 |
| `src/cli/remote/blob-batch/blob-batch.test.ts` | 10/10 | 3.92–6.10 |
| `src/cli/remote/blob-batch/pack-upload.test.ts` | 10/10 | 0.95–0.97 |
| `src/cli/remote/blob-batch/upload-grant.test.ts` | 10/10 | 0.09–0.11 |
| `src/cli/remote/resilient.test.ts` | 10/10 | 0.03–0.04 |
| `src/cli/sync-git/follow.test.ts` | 10/10 | 66.68–67.21 |
| `src/cli/sync-git/git-sync.test.ts` | 10/10 | 44.62–46.42 |
| `src/cli/telemetry/sync-state.test.ts` | 10/10 | 0.08–0.10 |
| `src/engine/crypto-pool/crypto-pool.test.ts` | 10/10 | 0.45–0.48 |
| `src/cli/sync-git/capture-stability.test.ts` | 10/10 | 0.78–0.81 |

### Repository gates

- `bun run test` expands the repository's canonical root command,
  `bun test ./src/ ./scripts/gc-drain.test.ts`: **2814 passed, 16 skipped,
  0 failed**, 31,893 assertions across 2,830 tests / 226 files in 327.24 s.
  Bare no-argument `bun test` is not the package gate: Bun recursively discovers
  nested Vitest suites and runner-specific utility scripts. This sweep did not
  change test configuration to disguise that pre-existing monorepo-runner
  boundary.
- `bun run test:api -- --configLoader runner`: **46 files passed; 781 tests
  passed, 4 skipped**, in 64.48 s. The runner loader is an environment-only workaround:
  the sandbox otherwise makes Vite write `.vite-temp` beside dependencies in the
  read-only primary checkout. No API or test source changed.
- `bun run typecheck`: **passed** (root and API incremental TypeScript checks).
- `git diff --check`: **passed**.

### Compiled live integration proof

`bun run rig doctor --runner docker` passed dev-secret resolution and dev API
health (HTTP 200), but the execution sandbox denied access to the local Docker
socket; the Desktop context had no running daemon, and user namespaces were
disabled, so neither the checked-in Docker rig nor a private rootless daemon
could start. The doctor evidence is retained at
`/tmp/rbox-flake-sweep-rig-doctor.log`.

The repository-sanctioned non-container alternative was therefore exercised
with a compiled dev CLI on this local host against the dev worker, using two
isolated homes/workspaces and a throwaway account. It passed bootstrap and plan
grant; initial Git remote/tracking materialization; config-only encrypted-wire
propagation to both devices without changing HEAD; two idle cycles with zero
new sequences; compiled-daemon heartbeats; A→B propagation in 4.257 s; B→A
propagation in 4.006 s; healthy activity state on both daemons; graceful stops;
and account deletion HTTP 200. The temporary harness and device homes were
removed; the redacted result is retained at
`/tmp/rbox-flake-sweep-live-proof.log`.

### Scope and behavior audit

- Recomputed PR #394 as
  `git diff --name-only origin/main...origin/feat/180-atomic-genesis` (56 paths).
  Its intersection with every tracked and untracked sweep path is **empty**.
- No candidate required a protected path, so there are **no deferred post-394
  fixes**. AUDIT-013 remains the standing defer policy, not a deferred edit.
- The six PR #331 timing-contract families remain note-only. The disabled
  upload-grant overlap case also remains note-only.
- Non-test production changes are limited to five testability seams:
  `RboxDaemon` cursor clock/random injection; the credentials test hook's
  lock-contention notification; Git resolve's injectable progress scheduler;
  telemetry reporter `flushForTests`; and optional held-attempt time injection.
  Omitted/default arguments preserve the original native timers, random jitter,
  lock behavior, progress cadence, reporter behavior, and independent
  `Date.now()` reads. No product behavior or API contract changed.
- Four adversarial design rounds reached alignment. Final simplify/default-
  equivalence and anti-slop/correctness reviews were clean after teardown,
  scheduler, signal-filtering, and producer-drain hardening.

## New candidates (2026-07-22 evening, v1.7.24 release train)

- RESOLVED 2026-07-22 (PR #403): `daemon-activity.test.ts` — "design 178 B:
  the pump serves one coalesced due probe within eight continuously
  replenished ambient dequeues" and "review H2: pull-only safety cadence
  clears a stale lane without a scan or status call". Both failed on shard 1
  of the v1.7.24 release-SHA run (starved runner, proof completed there);
  "review H2" recurred on PR #401 CI. Converted to injected clocks
  (SafetyCadenceClock seam + ManualRecoveryClock) with assertions unchanged;
  looped 10x green.

## src/cli/sync-git/capture-identity.test.ts — RECURRING under CI sharding (2 distinct tests, 2 nights' PRs)

- 2026-07-26: "detached pointer captures use detached HEAD as basis" failed
  once on shard 4/6 (PR #478, status-only diff). Green isolation + rerun.
- 2026-07-27: "current incremental link is imported even when recorded
  commit tips are already present" failed on shard 5/6 (PR #491, daemon
  observation diff — no plausible path). Green isolation + rerun.
- Class: real-git subprocess timing under shard parallelism, file-level.
  QUEUED FIX: convert the file's timing-sensitive fixtures to the injected
  seam pattern that resolved the daemon-activity flakes (PR #403), or give
  the file a dedicated anti-affinity shard slot.
- RESOLVED 2026-07-27: root cause identified as detached git
  auto-maintenance (`gc.pid` trips `gitBusy` → "receiver git busy"
  `applied:false`; evidence: PR #491 CI attempt-1 shard 5/6 log). Fixed by
  suite-wide `GIT_CONFIG` env injection in `scripts/test-preload.ts`;
  assertions now surface `res.reason`.

## rig git-join-ahead — fixture setup "linked-worktree source is refused" (RESOLVED — not a flake)

- 2026-07-27: failed twice consecutively at setup (`git worktree add` exit
  128, then `git clone` "destination already exists") — the scenario's
  sibling fixture dirs (/work/ws-{ordinary,linked}-source) live OUTSIDE the
  reset workspace and survive warm volumes: a non-idempotent fixture, not a
  flake (an earlier version of this entry wrongly claimed a green rerun).
  Fixed same night: rm -rf before mkdir + worktree add -B. Not correlated
  with product changes (#480-482).

## src/cli/daemon/daemon-activity.test.ts — "design 178 B: safety halt clears only when its own recovery predicate stops reproducing"

- 2026-07-27: failed on CI shard 1/6 (PR #492); green in the file locally
  (67/67) and full suite green on the exact merged tree. Same design-178
  starved-runner class as the two tests PR #403 converted to injected
  clocks — this sibling still uses real timing. QUEUED FIX: same
  SafetyCadenceClock seam conversion. Process note: this PR was merged
  before the rerun proof due to an unguarded command chain (merges are now
  verdict-gated); post-merge verification on main substituted for the rerun
  leg.
- RESOLVED 2026-07-27: converted to injected `now` +
  `ManualRecoveryClock` per the PR #403 pattern. CI evidence (PR #492
  attempt-1 shard 1/6) showed the ~5 ms real recovery timer consuming the
  probe before the error was cleared.

## src/cli/sync-git/follow.test.ts — "design safety linearization: op-state after the boundary remains ordinary post-follow work"

- 2026-07-27: failed on main run 30232946666 shard 1/6 (commit `300c85ad`)
  with "git-sync deferred repo: planned graph connectivity proof failed".
  Same Cause-A class: auto-gc repack racing connectivity-proof object reads;
  covered by the same `scripts/test-preload.ts` fix.

## src/cli/sync-git/follow.test.ts — "design 174 C: many-ref follow has exclusive leaf coverage and an explicit residual"

- 2026-07-27: failed on PR #499 CI shard 3/6 (run 30269092909) at its 30s
  test timeout with "killed 1 dangling process" — a hung git subprocess
  under shard contention, NOT the auto-gc class #497 fixed (that cause is
  suppressed suite-wide since 678697ad; this presents as a hang, mechanism
  unidentified). Diff was daemon-scheduling only (no plausible path into
  applyIncoming). Proof: 3x green locally in the file, rerun requested.
  Second follow.test.ts incident today (see the safety-linearization entry)
  — the file is the flake registry's top subprocess-contention locus now;
  if a third incident lands, it earns a dedicated investigation cycle.

## src/cli/daemon/daemon-activity.test.ts — "design 178 B: repeated timer rearming coalesces to one composite probe" (FIXED)

- 2026-07-29: failed on CI shard 1/6 (run 30416449068, job 90463926447,
  attempt 1) on a PR whose diff touched only `src/cli/state-plane/store/`
  and docs. Shard wall time 236.87s; the test itself burned 291.68ms.
- Attempt-1 evidence — the assertion at `daemon-activity.test.ts:441`
  (`expect(daemon.activity.halt).toBeUndefined()`) received a halt still in
  flight: `recoveryState: "running"`, `lastProbeAt` 4ms before the probe's
  own `nextProbeAt` stamp. The probe had started and had not finished.
- Root cause: the test observed an asynchronous probe by polling wall clock
  — `for (let i = 0; i < 100 && daemon.activity.halt !== undefined; i++)
  await sleep(2)`. That is a ~200ms budget on a runner that was oversubscribed
  enough to stretch a 5s file to 236s. Nothing about coalescing was wrong.
- Fix: await the signal the production code already publishes. The recovery
  timer's callback calls `wake()` → `pump()` → `scheduler.service()`, which
  assigns `pumpRun` synchronously, so `await daemon.pumpRun` after
  `clock.fireAll()` covers the whole run including the loop's exit-time
  re-entry. No clock injection was needed or added; no assertion changed.
  The sibling "recovery wakeup arriving during pump exit persistence is not
  lost" lost its identical poll loop too — `serviceLoop`'s re-entry is
  awaited inside the same promise, so `await daemon.pump()` already covered it.
- Red→green proof (both halves of the test bite):
  - removed `clearRecoveryTimer()` from `armRecoveryProbe` → RED at line 435,
    `expect(clock.callbacks.size)` received 3;
  - removed the timer callback's `wake()` → RED at line 442,
    `expect(remote.pullCalls)` received 0;
  - production restored → 20/20 green runs of the file (5.14s–6.10s),
    `src/cli/` 3514 pass / 0 fail, clean typecheck after `rm -rf .cache/tsbuildinfo`.

## apps/api/test/fairuse-scan.test.ts — "stops after eight phase ticks in one invocation" + "missing blob catalog evidence fails closed without advancing totals" (FIXED)

- 2026-07-29: both failed together on CI "workers API · shard 2/2" (run
  30416449068, job 90463926431, attempt 1) — the same run and the same PR as
  the daemon-activity entry above, whose diff touched only
  `src/cli/state-plane/store/` and docs, with zero files under `apps/api/`.
- Attempt-1 evidence — `fairuse-scan.test.ts:176`
  (`expect((await scan(accountId))?.status).toBe("materialize_roots")`)
  received `'capture_pins'`, and `:231`
  (`await expect(runFairUseObservation(env, NOW)).rejects.toThrow(...)`)
  resolved `undefined` instead of rejecting. Two failures, one cause: neither
  invocation ran on the account its own test had just created.
- Root cause: `runFairUseObservation` is a **global** scheduler.
  `discoverOneAccount` walks the whole `accounts` table (`fairuse.ts:1032`),
  enqueues at `next_run_at = nowMs`, and the invocation then spends itself on
  one row via `ORDER BY next_run_at,account_id LIMIT ?` (`fairuse.ts:1053`).
  `apps/api/vitest.config.ts` runs the Workers suite `maxWorkers: 1,
  isolate: false`, so **every file in a shard shares one D1**. This file's
  `beforeEach` cleared the global `fairuse_*` tables but not `accounts`, so a
  leftover foreign account was discovered, enqueued at the same `nowMs`, and
  won the tie whenever its id sorted below `acct_000_fairuse_*` — which every
  literal `acct-*` id in the suite does, since `'-'` (0x2D) < `'_'` (0x5F).
  Intermittent because vitest orders files by cached durations, so which files
  precede this one varies with the CI vitest cache. Reproduced
  deterministically on `main` by inserting one `acct-probe-foreign` account
  ahead of the file: same two failures, same messages.
- Fix: one statement in the existing `beforeEach` — `UPDATE accounts SET
  deleted_at=? WHERE deleted_at IS NULL`. Discovery skips tombstones, so the
  file's own accounts become the scheduler's whole world. No retry, sleep,
  widened timeout, skip, production change, or migration.
- Red→green proof (the fix does not mask the logic it covers): with it in,
  `FAIRUSE_PHASE_TICKS_PER_INVOCATION` 8→1 plus a neutered
  `fairuse_catalog_missing` throw → 3 failed / 7 passed, including both
  formerly-flaky tests; `apps/api/src/fairuse.ts` restored → 10 passed.
  Loops: file alone 20/20; `--shard=2/2` in CI order 20/20 — the shard loop is
  the meaningful one, since the file in isolation has no foreign accounts to
  trip over.
- **Generalizes to the whole Workers suite**: one D1 is shared across every
  file in a shard, so any test whose subject reads a table **globally** must
  neutralize rows it did not create, not merely clean up its own.

## src/cli/daemon/daemon-activity.test.ts — "CommitRejectedError %s records a typed terminal push halt" (FIXED)

- 2026-07-30: the `body_too_large` case failed on CI shard 1/6 (run
  30509121641, job 90765211048, attempt 1) on PR #609, whose diff touched only
  `scripts/snapshot-replay/` and one tsconfig line. The `too_many_refs` case of
  the same `test.each` passed in the same process. Green on rerun and locally.
- Attempt-1 evidence — `daemon-activity.test.ts:1271`
  (`expect(remote.commitCalls).toBe(1)`) received `2`, with exactly one
  `pump op blocked: commit request is too large for the server` log line: the
  second commit was still in flight, not a second completed operation. The
  failing case burned 49.41ms against the sibling's 33.03ms.
- Root cause: the test drove the **real** recovery clock. `recordRecoveryFailure`
  re-queues the failed operation (`scheduler.queue(op)`) and arms the standing
  probe from `recoveryProbeDelayMs(1, Math.random)` — design 178 B full jitter,
  `floor(random() * 5000)`, whose **floor is 0ms**. `makeDaemon` injected
  neither `recoveryClock` nor `recoveryRandom`, so ~1 draw in 300 lands a delay
  short enough to elapse inside the test's own remaining awaits (the activity
  write, `loadActivity`, `readShellLine`). The timer callback calls `wake()` →
  `pump()` → a recovery-probe push → a second `commit`. Nothing about the halt
  classification was wrong, and CI load only widens the window.
- Reproduced deterministically on the unfixed tree: `recoveryRandom: () => 0`
  plus `await sleep(25)` before the assertion → `commitCalls` 6, both cases.
- Fix: one option in the existing `makeDaemon` — default
  `recoveryClock: new ManualRecoveryClock()` (the PR #403 / 178 B seam already
  in this file), placed before `...opts` so the three tests that fire the clock
  themselves still override it. A probe now runs only when a test fires the
  clock or sets `recoveryDue`. No sleep, retry, widened timeout, skip,
  assertion change, or production change. It closes the class for every sibling
  here that asserts an exact commit count or `consecutiveFailures` after a
  recorded failure, not just the two cases that failed.
- Red→green proof (both halves of the test still bite, and the fix does not
  mask them):
  - `nextOperation()`'s `eligible[halt.op] = false` → `true` (a standing halt no
    longer makes its own operation ineligible) → RED at line 1271,
    `commitCalls` 5858 / 5987, both cases timing out at 15s;
  - `classifyOperationFailure`'s `terminal: { fingerprint }` capture dropped →
    RED at line 1272 on the `terminal` key, both cases;
  - production restored → the widened-window probe (`await sleep(200)`, 4x the
    25ms that produced 6 extra commits before the fix) holds `commitCalls` at 1;
    20/20 green runs of the file (5.42s–6.52s), full `bun run test` green,
    clean typecheck after `rm -rf .cache/tsbuildinfo`.
- **Generalizes to every recovery-episode test**: a recorded pull/push failure
  always arms a real timer that can fire with **zero** delay. Any test that
  provokes one and then asserts must own the recovery clock; asserting under
  `Math.random`'s 0ms floor is a coin flip, not a contract.

## SUSPECTED (proof pending): daemon-trusted-pull design-206 fallback case

- 2026-08-02, PR #621 push fcfd22479, `tests · shard 1/6` attempt 1:
  `(fail) design 206 (#464): a git-topology pull falls back once, then the
  NEXT pull is trusted again` — `Received: undefined` at
  `daemon-trusted-pull.test.ts:528`. Attempt 2: pass. Locally: file alone
  27/27, `src/cli/daemon/` together 412/412 (same SHA).
- The registry bar is a reproduction, not a rerun-went-green — this entry is
  a SIGHTING, recorded because that PR moved the daemon's startup binding
  write earlier in `start()` and this test drives pull trust. If it recurs,
  suspect that interaction first and reproduce under shard ordering
  (`bun test --shard`), not the file alone.

## SUSPECTED: design-202 stale-trusted-entry conflict-copy test (2nd trusted-pull-family sighting)

- 2026-08-14, PR #695 (`credentials.ts`/test/docs only — cannot influence this
  file), `tests · shard 3/6`: `(fail) design 202: a stale trusted entry
  degrades to a conflict copy — never loss — and the base still advances
  [181.53ms]`. Same-SHA rerun dispatched; locally green in isolation (34/34)
  AND with the new credentials neighbor co-scheduled (83 tests green).
- Second sighting in the trusted-pull family (see the design-206 SIGHTING
  above, `daemon-trusted-pull.test.ts`). If it recurs, this family earns the
  shard-ordering reproduction treatment FLAKE-008 just got.
- Process note: PR #695 was merged while this shard was red (merge tooling
  did not refuse; operator error compounded it). The failure was triaged
  post-merge and does not reproduce; the same-SHA rerun is the outstanding
  witness.

## SUSPECTED: daemon-activity "pr8: production pull-only timers remint discovery and clear a ghost without pushing"

- 2026-08-14, PR #725 (type-only lint diff in remote/context + e2ee-client —
  no daemon code touched), tests shard 1/6, run 31854379274 attempt 1.
- Proof: failed on attempt 1; the full daemon-activity file is green in
  isolation on the same-day main (65/65 locally on via-desktop); the
  `--failed` rerun of the same run went green and the PR merged on it.
- Third distinct flaky test in daemon-activity.test.ts (see the two FIXED
  entries above). If it recurs, the file earns the shard-ordering
  reproduction treatment rather than another single-test fix.

## THIRD SIGHTING (trusted-pull family): "design 202: an armed daemon logs pull local=trusted and refreshes with the O(applied) patch"

- 2026-08-15, PR #737 (SP-2 state-plane change), tests shard 2/6, attempt 1.
- Proof: failed on attempt 1; 34/34 green in isolation on the same tree;
  --failed rerun green and the PR merged on it.
- Third distinct sighting in the trusted-pull family (see the two SUSPECTED
  entries above). Per the standing bar this family NOW EARNS the
  shard-ordering reproduction treatment (FLAKE-008 style) — queued.

## cas-operations heap-scaling guard (registered 2026-08-16)
`cas-operations.test.ts` "promotion of a large stage does not scale heap
with authority size": failed once on the 269 branch's `test:parallel`
(authorityScaledGrowth ~26.5MB vs 16MB budget), passed 3/3 in isolation
and green on full rerun — rerun-proven flake. The ~26MB matches the
per-connection wrapper cost the test's own comment names; hypothesis is
retained-connection nondeterminism under shard-process cumulative
pressure, NOT authority-size growth (the branch reduces this path's
allocation: R3 removes per-row randomBytes). The two new 269 suites
measure 0.41s/0.08s — not the pressure source. RECURRED same day (2nd sighting,
next full-gate run; again green on rerun + isolation). **ESCALATED 2026-08-16: no longer
rerun-green on the Linux desktop — treat "green-on-rerun proceeds" as
SUSPENDED until the guard is redesigned.** On the 270 branch's
post-269-rebase gate it failed on TWO consecutive full `test:parallel`
runs (24.0MB then 29.2MB vs the 16MB budget, shard 1/6, sole failure both
times), which is not the rerun-green behavior this entry was registered
on. Negative control run the same hour: a clean detached worktree at
`4f282a41d` (origin/main, ZERO 270 commits) fails the IDENTICAL test, same
shard, sole failure, at **29.9MB** — the worst of the three. So the red is
a main-baseline condition on this host, not a property of any feature
branch, and a branch cannot clear it by rerunning. The suite is still
green 23/23 in isolation, so the guard measures host/shard pressure rather
than the code path it names. Its own comment already concedes the 16MiB
threshold cannot catch the regression it is named for. Until the redesign
lands (per-connection-cost-aware baseline or a dedicated-process runner),
a branch whose ONLY `test:parallel` failure is this guard, with a
same-commit-of-main control reproducing it, should be reported as
"baseline-red, branch-neutral" — never as a green gate. Isolation into its
own file is NOT mechanical — the guard shares the file's fixture
machinery. Follow-up owed, now blocking every branch's final gate on this
host: redesign the guard (per-connection-cost-aware baseline or a
dedicated-process runner), not a threshold bump.

## issue-501 journal persist batching — overlay write amplification (shard 5)
- First seen: 2026-08-17, PR #763 CI (run 31991680267, attempt 1), unrelated diff (272 conflict-copy oracle — journal subsystem untouched).
- Signature: fails at exactly ~15055ms (15s cap) on the shard runner; green on rerun of the same SHA; passes locally.
- Class: timing-sensitive perf pin on loaded runners. Suspect the #501 amplification measurement needs a load-tolerant bound, not a wall-clock cap.
- Status: green-on-rerun eligible; if it recurs on an untouched-subsystem diff twice more, split the measurement out of the CI wall-clock budget.
