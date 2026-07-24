# 194 — Decompose daemon control by ownership

Status: IMPLEMENTED; integrated rig blocked by host prerequisites (2026-07-24)

## Problem

`src/cli/daemon-control.ts` is 869 lines and owns three independent concerns:

1. parsing and persisting daemon runtime records;
2. process lifecycle, mode admission, and safe shutdown;
3. resolving, tailing, merging, and following daemon logs.

The file is below the 1,000-line hard smell threshold, but its concern count is
already the stronger warning. A reader working on PID ownership must scan log
rotation machinery; a reader working on log following encounters spawn and
shutdown policy. Continued changes will make the compatibility entry point an
unsafe merge hotspot.

## Goal

Separate those concerns into explicit modules while preserving every existing
import from `src/cli/daemon-control.ts`, all runtime behavior, and every public
type. This is a structural refactor only.

## Ownership

### `src/cli/daemon/runtime-state.ts`

Owns daemon-control filesystem state and its disk formats:

- dual-format binding and PID parsing;
- the boot-incarnation environment key shared by launcher and daemon;
- binding/PID record reads and writes, including synchronous v2 PID
  publication after spawn;
- concrete mutations used by lifecycle orchestration: stale PID removal,
  pre-spawn binding/status clearing, and compare-and-remove of an exact PID
  record;
- current workspace ID;
- whole-runtime removal, including records, status, and logs.

It never owns process inspection, signalling, mode policy, or log reading.

### `src/cli/daemon/process-control.ts`

Owns daemon process lifecycle and policy:

- spawn arguments and process identity;
- liveness, waiting, and force-kill primitives;
- binding/liveness verdict;
- mode witness and admission;
- crash-sink guard;
- start and safe stop orchestration.

It consumes runtime state through those concrete operations but never parses or
serializes its wire formats and never tails logs. Crash-log guarding remains
here specifically as synchronous spawn crash-sink preparation; general log
consumption stays in `log-reader`.

### `src/cli/daemon/log-reader.ts`

Owns daemon log discovery and consumption:

- dated/crash/legacy source resolution;
- bounded file tails and chronological merging;
- lifecycle-pinned follow behavior.

It may read runtime state to pin a follow session, but never writes runtime
records or controls a process.

### `src/cli/daemon-control.ts`

Becomes a compatibility facade made only of explicit re-exports. Existing
external callers do not change in this PR. The daemon implementation itself
switches its record and boot-environment-key imports from the outward-facing
facade to its sibling `runtime-state` module. Process control imports the same
canonical key there. This avoids an inner-module → facade → inner-module
back-edge without duplicating the incarnation contract. Explicit facade exports
prevent accidental exposure of internal state-mutation helpers.

## Dependency direction

```text
daemon-control.ts (compatibility facade)
  ├── daemon/runtime-state.ts
  ├── daemon/process-control.ts ──> daemon/runtime-state.ts
  └── daemon/log-reader.ts ───────> daemon/runtime-state.ts

daemon/daemon.ts ────────────────> daemon/runtime-state.ts
```

There are no reverse imports into the facade and no cycle between process
control and log reading.

## Behavioral invariants

- Existing exports from `daemon-control.ts` remain source-compatible.
- PID and binding formats, including legacy reads, are byte-for-byte unchanged.
- PID ownership is rechecked at the same points before signals and record
  removal.
- Spawn arguments, environment, inherited crash sink, and mode-witness timing
  are unchanged.
- Shutdown never escalates during a witnessed current-version critical phase.
- Log source ordering, byte bounds, follow lifecycle pinning, and signal cleanup
  are unchanged.
- No production caller except `daemon/daemon.ts` is migrated to an internal
  module; that import establishes the canonical inward dependency direction.

## Compatibility contract

A focused facade test locks down:

- the exact runtime export keys, including all six path helpers;
- compile-time imports and assignability for every exported interface and type;
- the existing subprocess import of `guardDaemonCrashLog` through the facade.

The facade uses explicit named exports rather than `export *`.

## CODEMAP changes

The implementation updates `docs/CODEMAP.md` with one line per new module:

- `daemon-control.ts`: compatibility exports only; never behavior.
- `daemon/runtime-state.ts`: daemon runtime filesystem state and formats; never
  process or log-consumption policy.
- `daemon/process-control.ts`: process lifecycle and spawn/stop policy; never
  record formats, sync-loop behavior, or log consumption.
- `daemon/log-reader.ts`: log discovery/tail/follow; never process control or
  runtime-state mutation.

## Deliberate non-goals

- No redesign of start/stop behavior.
- No new service classes, dependency containers, or generic record framework.
- No test relocation solely to mirror the new file layout.
- No changes to daemon sync-loop ownership.

## Validation

1. Compare the facade export names with the pre-refactor export list.
2. Run the checked-in runtime and compile-time facade contract.
3. Run daemon control, mode, spawn, stop, and log tests, retaining the
   cross-process crash-guard facade test.
4. Run all directly related daemon/logger and command integration tests.
5. Run TypeScript typechecking and repository guards.
6. Run the full CLI/source test suite.
7. Run `bun run rig` as the repository-required integrated validation gate.
8. Review the final diff for moved-code fidelity—especially `startDaemon`
   ordering—cycles, accidental public imports, and CODEMAP accuracy.

## Result

Implemented the three-module split with a 55-line explicit compatibility
facade. Focused daemon tests, command-level facade consumers, typechecking, and
repository guards pass. Both final adversarial reviewers approved the code.

`rig doctor` could not reach an executable scenario because the Apple container
service is stopped and the required dev bootstrap/platform secrets are absent.
The broad source suite was also sampled but has unrelated existing failures in
the design-166 adoption tests; daemon-control-focused and direct consumer suites
remain green.
