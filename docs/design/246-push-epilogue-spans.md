# 246 — Name the push epilogue tail

Status: ALIGNED r3 (issue #661 instrumentation slice; review 3 aligned)

## 0. Yardstick

A field `rbox push` line must name the major work surrounding and following the
accepted commit's final state save. The next slow push should distinguish
publisher acknowledgement excluding its nested save, the daemon publish
transition, time waiting for the scheduler queue to drain, and final drain
settlement without changing publication, recovery, scheduling, persistence,
logging, or telemetry behavior. These spans are exclusive of each other, but
`ack_ms` straddles the state-save boundary and is not itself a purely post-save
bucket.

## 1. Protected functionality and ownership

- `src/cli/sync/push.ts` remains the push retry/attempt owner and
  `src/cli/sync/publisher-ack-transition.ts` remains the sole owner of accepted
  publisher-ACK composition and its single CAS state write (CODEMAP lines 83
  and 153's stated sync-side boundary).
- `PublishLocalWorkspaceTransition` remains the sole daemon-side request,
  outcome-reduction, and ordered-effect owner (CODEMAP line 153). Effects keep
  their exact order: local bookkeeping/logging, durable-state refresh, metrics
  persistence, then report settlement.
- `RboxDaemon` remains the scheduler/report-lifecycle adapter (CODEMAP line
  135). A settled push report is still emitted only after the scheduler queue
  drains and final cache/status persistence completes.
- `PhaseReport` remains a pure accumulator with no emission I/O (CODEMAP line
  390). Existing phase names, JSON shape, privacy bounds, zero-work silence,
  gap/tail calculation, and summary ordering are preserved.
- Publisher acceptance/error propagation, state-save failure behavior,
  first-publish stats, telemetry samples, activity writes, mutex semantics,
  retries, compatibility paths, and fast paths are unchanged.

No migration or deprecated surface is in scope. There are no safe deletion
candidates, and no behavior, format, command, migration, or fast path is
approved for deletion or retirement.

## 2. Tail reading

The final `state-save` phase is nested inside
`acknowledgePublishedGitTransitions`. Work elsewhere in that acknowledgement
(identity checks, set/map/object composition, proof construction, forensic log
callbacks, and outcome construction) currently has no named span. Most of that
composition occurs before `state-save` starts and therefore contributes to the
prior phase→state-save gap; only the final save outcome/catch construction is
after it. Time the acknowledgement wall with `performance.now()`, separately
accumulate the nested state-save wall, and report the nonnegative difference as
`ack_ms`. This follows the required exclusive arithmetic but deliberately does
not claim that all `ack_ms` belongs to the post-state-save tail.

The first-publish stats/telemetry block after acknowledgement is synchronous
counter finalization, object/string construction, a `PhaseReport.toJSON()`
snapshot, and an in-memory telemetry queue append. It has no await, filesystem
write, or state read and is expected below 1 ms, so `push_stats_ms` is omitted.

Other work still runs before `pushManifest` resolves and therefore remains in
the PhaseReport tail rather than `publish_transition_ms`: a nonempty deferred
set formats warnings and calls the daemon's synchronous rotating logger (which
can perform filesystem writes); the success result object/arrays are built;
`withPushLaneAccumulator` maps bounded lane totals and enqueues telemetry; and
`withPushTailTiming` sorts request-duration samples, reduces payload totals,
and appends detail text. The result/lane/tail wrappers are bounded in-memory
bookkeeping and do not merit separate spans. Deferred warning logging is a real
blocking source, but it only runs for a partial push, is already recognizable
from the immediately adjacent `rbox: N file(s) still changing` line, and adding
a fourth epilogue span would violate the requested maximum; it remains an
explicitly known residual rather than being mislabeled as daemon transition.

When `pushManifest` returns to the daemon transition, the report is not final.
The transition still reduces the outcome and applies its ordered effects. Most
are synchronous, but `refresh-durable-state` reads the durable sync base and
`record-sync-metric` writes metrics before `settle-report`. Measure this whole
exclusive reducer/effect interval as `publish_transition_ms` at its owner.

`settle-report` only queues the report. The daemon scheduler may then finish the
current operation, release the mutex, acquire it again, run any later queued
operations (including their operation-boundary reads and blocking work), and
only after the queue is empty call `settleAfterDrain`. Measure the exclusive
queue interval from report settlement to entry into `settleAfterDrain` as
`drain_wait_ms`. The existing `settle_ms` already names the subsequent cache
save and status/activity settlement. Summary sampling/formatting then performs
bounded in-memory work and computes the printed tail; the final synchronous log
write happens only after that tail value is fixed, so it cannot explain the
multi-second tail reported on its own line.

## 3. Mechanism

1. Add `ack_ms`, `publish_transition_ms`, and `drain_wait_ms` to the existing
   `formatPushSpan` name union. Make the formatter return no summary fragment
   for a nonpositive value, matching the existing zero-value span convention.
2. In `push.ts`, time the total acknowledgement and its nested state-save
   callback with monotonic clocks, subtract the latter, and append `ack_ms` to
   the existing `state-save` report details.
3. In `PublishLocalWorkspaceTransition`, start a monotonic clock immediately
   after the push outcome returns. Pass the elapsed reducer/effect time to the
   existing final `settleReport` port call. The daemon appends it and records
   the report-settlement timestamp when queuing the report.
4. At `settleAfterDrain` entry, append the nonnegative time since each queued
   report's settlement as `drain_wait_ms`, then preserve the existing
   `settle_ms` calculation and emission order.

This adds no module, state authority, mode, flag, fallback, queue identity, or
local type. CODEMAP ownership does not change.

## 4. Requirement challenges

| Requirement | Complexity cost | Evidence | Recommendation | Decision |
|---|---|---|---|---|
| Span first-publish stats | Another always-present field around synchronous bookkeeping | No await/I/O/state read; telemetry `record` only updates bounded in-memory collections | Skip as sub-millisecond noise | Decided by this slice after reading |
| Split durable refresh and metrics save into separate spans | More port surface and cross-module timing plumbing | Both are already ordered effects under one transition owner; the immediate question is whether the daemon transition owns the residue | Keep one deep `publish_transition_ms` span | Decided by max-three/plain-name constraint |
| Emit a report immediately after each push | Scheduler/report lifecycle behavior change and different wall semantics | Current reports deliberately settle after the queue and final cache/status persistence | Preserve behavior; name `drain_wait_ms` | Not approved |

## 5. Validation

- Before assertions: run the existing phase-report and sync test files and
  record that Bun collected both. Baseline on 2026-08-14: 97 tests across two
  files, 96 pass, one skip, zero failures.
- The specification names `src/cli/sync/format.test.ts`, which does not exist in
  the baseline tree. Add that focused formatter test file, pin all three new
  names plus zero-value silence there, and run the exact accepted command:
  `bun test src/cli/sync/format.test.ts src/cli/sync/sync.test.ts`.
- Extend the daemon publish-transition contract test to prove the transition
  passes a nonnegative timing at the existing final settle effect.
- Extend the existing committed-push report assertion in
  `src/cli/daemon/daemon-activity.test.ts` to require `ack_ms`,
  `publish_transition_ms`, and `drain_wait_ms` on the emitted `rbox push` line.
  This is the end-to-end gate for settlement timestamp storage, phase detail
  attachment, and final drain rendering.
- Run both touched daemon tests explicitly and report their counts.
- Run `bun run typecheck`, `bun run lint:affected`, and the repository rig.
- Differential review: only timing reads, detail accumulation, and an extra
  numeric port argument may differ; effect order and return/error surfaces
  must be byte-for-byte/control-flow equivalent.
- Crash/compatibility: state-save, durable refresh, metrics-save, and drain
  failures keep their current propagation/finally behavior; disabled reports
  remain transparent; persisted/wire formats and old binaries are untouched.
- Performance: monotonic clock reads and three numeric detail fields only;
  no new traversal, remote call, state read, filesystem write, or hot-path
  allocation when reports are disabled beyond local scalar timing.

## 6. Implementation validation

- Pre-assertion collection proof: 97 tests across the pre-existing phase-report
  and sync files; 96 pass, one skip, zero failures.
- Exact acceptance command: 84 tests across `format.test.ts` and `sync.test.ts`;
  83 pass, one skip, zero failures.
- Touched daemon suites: 99 pass, zero failures. Combined focused coverage:
  183 tests, 182 pass, one skip, zero failures.
- `bun run typecheck` passed. `bun run lint:affected` exited cleanly with no
  warning on a changed line (the reported warnings predate this diff).
- Rig doctor passed, then the real fast suite passed 7/7 scenarios with zero
  failures: onboard smoke, two-device live, mass-delete guard, type flip,
  daemon idle CPU/RSS, Git entanglement, and Git join-ahead.
- Diff-scoped simplification review found no new policy branch, mode, authority,
  duplicated I/O, or ownership move. No CODEMAP change is required.
