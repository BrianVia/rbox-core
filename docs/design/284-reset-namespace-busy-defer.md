# Design 284 — Defer reset namespace census races

Status: IMPLEMENTED · 2026-08-23 · fixes #807 (daemon killed by a
`RESET_NAMESPACE_BUSY` census race at the operation boundary; desktop,
agent-heavy workspace, twice on 2026-08-21/22).

## Protected contract

- Every operation remains fail-closed behind `resetOperationBoundary` and the workspace mutex.
- `RESET_NAMESPACE_INVALID`, `RESET_LEGACY_ARTIFACT_INVALID`, unknown errors, journal verdicts, W1 recovery, startup, and operation scheduling keep their current behavior.
- A transient `RESET_NAMESPACE_BUSY` never changes readiness, halt identity/reason, or halt health; returning `false` leaves the selected operation queued.
- A pending reset gets six short retries, then the existing durable hourly halt. A ready daemon retries without a bound.
- A successful first inspection ends the busy episode before any later recovery work.

## Smallest owning change

`RboxDaemon` already owns reset lifecycle, retry scheduling, operation admission, and halt persistence. It therefore owns one narrow busy-error predicate and one deferral method. Both boundary adapters catch only that typed error and return their existing `false` result. No new Interface, signal, injected seam, flag, or mode is introduced.

The reset policy module owns the two constants. The busy log uses a distinct existing `ResetHaltLogGate`, so transient diagnostics cannot suppress a real halt.

## Boundary flow

1. `resetOperationBoundary` wraps its existing inspection body. The inner `loadSyncBase` catch rethrows the busy race before its existing halt conversion.
2. `openOperationBoundary` wraps its whole existing prologue, preserving the literal mutex source anchors.
3. The first successful journal inspection resets the consecutive-busy counter.
4. Deferral schedules `now + 5s`; on the sixth consecutive busy while non-ready it calls `enterResetHalt` instead.

## Requirement challenge and deletion

The retry counter and timer are required because pending recovery otherwise can wait forever for an external wake. They can be deleted when the namespace census no longer depends on directory identity stability (for example, an `O_DIRECTORY`-fd-pinned census), or when the daemon no longer races SQLite sidecars. No supported behavior is approved for deletion.

## Validation

- RED-first isolated fixture proves deferral, log gating, pump survival, next-pass recovery, bounded pending-reset escalation, and non-busy propagation.
- Focused compatibility tests: reset halt state, namespace inventory, and sync mutex source anchors.
- `bun run typecheck` and `bun run lint:affected`.
- Crash semantics are unchanged because deferral writes no durable state; compatibility and performance risk are limited to two typed catches and one scheduled timer.
