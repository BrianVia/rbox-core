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
| Status / fix | **CONFIRMED — FIX PENDING.** Replace wall-time domination with an injected cursor clock and logical cadence/timeout advances; no production behavior change. |
| Proof | First failure [2026-07-20 run](https://github.com/BrianVia/rbox-core/actions/runs/29786152966); [failed and same-SHA rerun run](https://github.com/BrianVia/rbox-core/actions/runs/29913968169), exact SHA `0a88543538901c8d96b924c7bbf54cf0b1681083`; rerun green; isolation green. |

### FLAKE-002 — logout waits for an in-flight credential writer

| Field | Record |
|---|---|
| Test | `logout waits for a normal in-flight credential writer and clears definitively` |
| File | `src/cli/credentials.test.ts` |
| First / last seen | 2026-07-20 / 2026-07-22 |
| Failure | `[50.51ms]` on PR #373; `[56.48ms]` on PR #394, shard 4 |
| Root cause | A child holds the credential lock for a fixed 350 ms while the parent polls every 10 ms; neither sleep establishes that logout actually encounters the live writer. |
| Status / fix | **CONFIRMED historical flake — FIX PENDING; 2026-07-22 recurrence SUSPECTED.** Child-owned-lock and parent-observed-contention handshakes replace both timing windows. The PR #394 protected-path diff does not include `credentials.ts` or this test. |
| Proof | [2026-07-20 failure and green failed-job rerun](https://github.com/BrianVia/rbox-core/actions/runs/29753317433); [2026-07-22 recurrence](https://github.com/BrianVia/rbox-core/actions/runs/29937523471) has 5× isolation and two green full local runs, but its same-SHA CI rerun remains pending. |

### FLAKE-003 — design-93 §11 concurrent saves

| Field | Record |
|---|---|
| Test | `§11 E2E: concurrent daemon/CLI process saves preserve newer-source atomicity` |
| File | `src/cli/git-config-sync.e2e.test.ts` |
| First / last seen | 2026-07-12 / 2026-07-21 |
| Failure | final state expected sequence 2 but received sequence 1; observed `[284ms]`, `[267ms]`, `[398.10ms]`, `[859.11ms]`, `[205.70ms]`, `[529.06ms]`, `[342.57ms]`, `[458.01ms]`, and `[491.08ms]` |
| Root cause | Two child processes load the same snapshot, then the daemon merely sleeps 40 ms in the hope that the newer CLI writer finishes first; scheduler order and one-shot lock acquisition are uncontrolled. |
| Status / fix | **SUSPECTED — FIX PENDING.** Coordinate both snapshot-ready events, release/await CLI sequence 2, then release stale daemon sequence 1. Production save logic unchanged. The current registry lacks a complete three-witness proof for one historical occurrence and does not promote it on repetition alone. |
| Proof | [2026-07-21 failed run and failed-job rerun](https://github.com/BrianVia/rbox-core/actions/runs/29854135760); earlier exact-SHA reruns include [2026-07-20](https://github.com/BrianVia/rbox-core/actions/runs/29758980906). `docs/STATUS.md` says “FOUR strikes” on July 21, but the retained log shows two executions whose failure body was duplicated in each job summary, not four distinct runs. Local isolation proof will be refreshed by this sweep. |

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

## Same-class audit candidates

These are the actionable occurrences found by the `src/**/*.test.ts` and
`apps/api/test` sweep. “Fix pending” means the test contains a sleep or
unawaited producer that directly controls an exact assertion; final status is
updated after implementation review.

| ID | File / test area | Risk and deterministic disposition | Status |
|---|---|---|---|
| AUDIT-001 | `src/cli/telemetry/sync-state.test.ts` — `reporter gates unchanged ticks...` and `kill switch...` | Fire-and-forget tick/heartbeat followed by 10 ms then exact call counts; await the reporter's internal chain through a test flush. | **FIX PENDING** |
| AUDIT-002 | `src/cli/git-cmd.test.ts` — resolve heartbeat teardown | Sleeps 10 ms after return then asserts no later output; inject/record timer lifecycle and assert clear structurally. | **FIX PENDING** |
| AUDIT-003 | `src/cli/remote/blob-batch/blob-batch.test.ts` — queued close and pull-first tail | 20/30 ms sleeps control exact dispatch counts; use existing uploader clock and dispatch-entry gates. | **FIX PENDING** |
| AUDIT-004 | `src/cli/remote/blob-batch/pack-upload.test.ts` — pack release wakes batch | 20 ms negative window before exact no-batch assertion; use pack/batch entry gates. | **FIX PENDING** |
| AUDIT-005 | `src/cli/remote/blob-batch/upload-grant.test.ts` — refresh and close cases | Unawaited refresh followed by `setTimeout(0)`/100 ms race; use test-only mocked-fetch completion/condition polling. `src/cli/remote/context.ts` is protected, so seam-dependent cases are **DEFERRED: POST-394**. | **FIX PENDING / DEFER POLICY** |
| AUDIT-006 | `src/engine/crypto-pool/crypto-pool.test.ts` — post-reset status | A 25 ms sleep follows an already-awaited reset and is redundant; remove it. | **FIX PENDING** |
| AUDIT-007 | `src/cli/e2ee-sync.test.ts` — `D fast pull evidence mismatches...` | Fake chain GET sleeps 5 ms to manufacture overlap; entered/release gates prove the expected chain reads (not the sequential head read) are in flight. | **FIX PENDING** |
| AUDIT-008 | `src/engine/git/capture-stability.test.ts` — ambient index churn | Unawaited churn producer plus 10 ms startup guess; wait for first churn and await controlled shutdown. | **FIX PENDING** |
| AUDIT-009 | `src/cli/sync-git/follow.test.ts` — held fingerprint aging | Eight 2.1 s sleeps age a 2 s racy-clean margin; inject one `heldNow` per repo decision, defaulting to `Date.now`. | **FIX PENDING** |
| AUDIT-010 | `src/cli/redeem-drain-upload.test.ts` — serialized backpressure | 20 ms negative window before exact PUT count despite an existing drain gate; assert through that gate. | **FIX PENDING** |
| AUDIT-011 | `src/cli/daemon/daemon-safety.test.ts` — signal/state and safety cadence cases | A 450 ms signal wait and `setTimeout(0)` scheduler turn precede exact assertions; drive/await explicit state and scheduler events. | **FIX PENDING** |
| AUDIT-012 | `src/cli/daemon/daemon-activity.test.ts` — `lastFailureAt` ordering and stop-settlement cases | A 2 ms timestamp guess and 50 ms negative stop window precede exact assertions; inject logical now and await stop settlement. Existing condition polling remains note-only. | **FIX PENDING** |
| AUDIT-013 | PR #394 protected files | The authoritative 56-path diff was scanned. No clear live fix above needs a protected path; any later candidate there is **DEFERRED: POST-394**, never edited in this sweep. | **NOTE-ONLY / DEFER POLICY** |
| AUDIT-014 | `src/cli/daemon/daemon-ws-reliability.test.ts` — pong deadline, backstop positive, WS-disabled zero-backstop | Fixed 100/90/50 ms sleeps precede exact counts/state; await the positive events and remove the causally unnecessary disabled-path sleep. | **FIX PENDING** |
| AUDIT-015 | `src/cli/credentials.test.ts` — `a long fenced operation refreshes the main marker...` | Sleeps 60 ms after a 10 ms heartbeat then asserts mtime advanced; condition-poll the mtime event under a generous ceiling. | **FIX PENDING** |
| AUDIT-016 | `src/cli/sync-git/git-sync.test.ts` — `git apply pools independent repos...` | The positive `betaStarted` event uses a 1 s failure ceiling; preserve the causal promise and raise only this starvation ceiling to 10 s. The three negative non-overlap windows below stay note-only as concurrency contracts. | **FIX PENDING** |
| AUDIT-017 | `src/cli/remote/resilient.test.ts` — `abort mid-backoff aborts the retry` | A microtask guess precedes abort and the losing sleep leaves a real 10 s timer detached; announce sleep entry and return a resource-free never-settling promise before abort. | **FIX PENDING** |

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

The audit found four unawaited-producer families requiring fixes
(AUDIT-001, AUDIT-005, AUDIT-008, AUDIT-017). Reviewed D1 helper arrows ending in
`.run()` return their promise to an awaited caller and are false positives,
not unawaited producers. Reviewed plain `Date.now()` uses that only seed
database rows, grants, expiries, or logical fixtures without a tight delta
assertion are likewise false positives, not timing candidates. The explicit
sleep/setTimeout census now accounts for all 34 matching test files; the
fixture-only `Date.now()` file census is completed and enumerated with the
final audit proof after implementation.
