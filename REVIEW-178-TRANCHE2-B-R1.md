# Design 178 tranche 2 — workstream B review

## Round 1

Codex found lifecycle blockers in the first implementation: a timer wakeup could
be lost while the pump was exiting; restart, pull-only, and coalescing tests did
not drive the real lifecycle; probe dequeue state was not durable; conflict
preflight failures incorrectly escalated push exhaustion; dormant pull-only
episodes were misprojected; legacy push episodes bypassed the composite; and
timers leaked across tests.

The implementation was revised to use a lost-wakeup-safe pump re-entry, an
injectable unreferenced recovery clock, durable `armed` / `running` /
`suspended` state, producer-typed chain-repair safety halts, preflight-preserved
conflict episodes, composite recovery for legacy push halts, and real persisted
restart tests. Test teardown now stops every daemon.

## Round 2

Codex found four residual gaps: running recovery still mapped to a brief halt,
suspended recovery still mapped to machine/shell halt, legacy preflight did not
use the non-escalating path, and backoff reset lacked an explicit regression
assertion. All four were corrected and the focused B suites and typecheck were
green before final acceptance.
