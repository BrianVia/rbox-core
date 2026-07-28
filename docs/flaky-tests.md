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
| Status / fix | **CONFIRMED — FIXED** in `25da94b2` (final barrier hardening `f1d56a55`). Wall-time domination is replaced by an injected cursor clock/random source and logical cadence/timeout advances; defaults preserve native timers, jitter, and `unref`. |
| Proof | First failure [2026-07-20 run](https://github.com/BrianVia/rbox-core/actions/runs/29786152966); [failed and same-SHA rerun run](https://github.com/BrianVia/rbox-core/actions/runs/29913968169), exact SHA `0a88543538901c8d96b924c7bbf54cf0b1681083`; rerun green; isolation green. |

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
| Status / fix | **FIXED** by `5a49b752`, merged as PR #380 / `a1b10bca`: `waitUntil`, suppression-by-domination, and robust ranges. Lesson: polling may have a generous failure ceiling, but ordering claims need handshakes/logical time. FLAKE-001 shows the suppression rewrite retained one real-time assumption; this sweep closes it and audits the other residual wall assertions. |
| Proof | Original CI failures: [epoch-overlap exact-count run/job](https://github.com/BrianVia/rbox-core/actions/runs/29785665033/job/88496559312) and [live-committed zero-count run/job](https://github.com/BrianVia/rbox-core/actions/runs/29786152966/job/88498019200). Retained history does not identify a green same-SHA rerun for every original occurrence, so cluster-wide historical proof is incomplete; fix commit records 25/25 post-fix isolation green. Cursor production and API cursor-handler tests have not changed since the design-170 merge. |

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
| Status / fix | **CONFIRMED — FIXED** on `chore/flake-006`. An inspection-window disappearance or replacement now raises `MarkerTurnoverError`, and the fence observer (`inspectHeldFence`) treats it as "look again" — the same disposition `readMarkerNoFollow` already gives "lock changed during inspection" in `src/engine/git/lockfile.ts`. Owners of a marker keep failing closed by not catching it. |
| Proof | [2026-07-28 failure](https://github.com/BrianVia/rbox-core/actions/runs/30324649446/job/90167390189) and [green same-SHA rerun](https://github.com/BrianVia/rbox-core/actions/runs/30324649446/job/90193788407), exact SHA `7ce9e01adf04c9b673e7ad148755dea1da213140`. Root-caused by reproducing the exact `ENOENT` stack under 8-way load (1 loss in 240 contended pairs; 0 in 240 after the fix). Regression test `a fence released inside the inspection window is a retry, not a lost writer` drives the interleaving through the `marker-observe-before-open` seam: red with the fix stashed, green with it; 10× isolation of the file green (47 tests, 4.59–4.71 s). |

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
| AUDIT-008 | `src/engine/git/capture-stability.test.ts` — ambient index churn | Unawaited churn producer plus 10 ms startup guess; wait for first churn and stop/drain the producer on every exit. | **FIXED** `30aa28cd`, `f1d56a55` |
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
| `src/engine/git/lockfile.test.ts` real process timeout | The real SIGKILL/identity deadline is an explicit performance boundary with a generous outer ceiling. |
| `src/cli/watcher-compiled.test.ts` | Child/native watcher soak delays are compiled integration contracts. |
| `src/cli/daemon/daemon-git-capture.test.ts` | Condition polling has a 3 s ceiling; the separate sustained lock pulses intentionally exercise the synchronous 3 s max-wait contract. |
| `src/cli/daemon/daemon-git-ref-integration.test.ts` | 250/650 ms windows observe real native watcher arm/drain behavior; positive state uses a condition wait. |
| `src/cli/design85-layer-a.test.ts` | Racy-margin sleeps establish the filesystem quiescence precondition. |
| `src/cli/remote/blob-batch/uploader-fill.test.ts` | Scheduling uses an injected fake clock; the 5 s loop is a condition-driven failure ceiling. |
| `src/engine/apply-concurrency.test.ts` | The test awaits an explicit peak event; 10 s is only its generous failure ceiling. |
| `src/engine/git/keep-pins.test.ts` | A real subprocess result races a 10 s outer failure ceiling and reports timeout explicitly. |
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
  `git-state.test.ts`, `src/engine/git/config-txn.test.ts`,
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
  `src/engine/git/lockfile.test.ts`.

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
| `src/engine/git/capture-stability.test.ts` | 10/10 | 0.78–0.81 |

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

## src/engine/git-state.test.ts — RECURRING under CI sharding (2 distinct tests, 2 nights' PRs)

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
