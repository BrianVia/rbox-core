# Design 250: one start flag for daemon trace streams

Issue: #666

## Contract and scope

`rbox start --trace` enables every trace stream known to this CLI for the daemon
spawned by that invocation. `rbox start --trace=propagation,held` enables only
the named streams. Unknown or empty names fail before workspace lookup and list
the valid names. The setting is invocation-local: it is neither persisted in
desired daemon state nor interpreted by the daemon. A start that finds an
already-running daemon does not change that process.

The production source inventory contains exactly these readers:

| Public name | Spawned environment variable | Existing owner |
|---|---|---|
| `propagation` | `RBOX_TRACE_PROPAGATION=1` | daemon propagation diagnostics |
| `held` | `RBOX_TRACE_HELD=1` | sync-git held diagnostics |

The trace catalog and its env projection live at the process-spawn boundary in
`daemon/process-control.ts`. The dispatcher is only an adapter: it parses the
registered flag through that catalog and passes the resulting closed names to
the existing command-level start path. The autostart/desired-state layer relays
the invocation-scoped option to `startDaemon`; it never records it.

## Protected-functionality ledger

- Bare `rbox start [path]` preserves its exact current spawn environment and
  read-write/pull-only behavior.
- Existing caller-provided `RBOX_TRACE_*` environment variables continue to be
  inherited. The flag overlays selected variables with `1`; it does not clear
  unselected variables inherited from the caller.
- Existing already-running, stale-pid, scope-lock, desired-state, mode witness,
  crash-log, compiled/dev argv, and restart behavior remain unchanged.
- Autostart, setup, front-door, boot resume, and maintenance starts do not gain
  trace settings implicitly.
- Trace readers remain unchanged and continue to own diagnostic behavior.

No migration, compatibility path, performance fast path, durable format, or
crash-recovery mechanism is retired or changed.

## Interface and ownership

The process-control Module gains one closed `DaemonTraceStream` catalog plus:

- a parser from the flag's optional comma-list to closed stream names;
- a pure spawn-environment assembler used by the real `spawn` call.

This keeps the invariant “every public trace name maps to exactly one daemon env
variable” at the physical-effect owner. It avoids parallel lists in parser,
help, and spawn code. No new file or ownership-map entry is needed because
process-control already owns daemon process spawning.

## Status seam decision

Skip `rbox status`. The pidfile and ambient status record expose boot identity,
version, mode, heartbeat, and shutdown state, but not boot environment. Reading
another process's environment would be platform-specific and untrustworthy;
adding a daemon status field would be new plumbing and violates the issue's
explicit no-daemon-side-change constraint.

## Requirement challenge and deletion

| Requirement | Complexity cost | Evidence | Decision |
|---|---|---|---|
| Optional value on one flag (`--trace` and `--trace=list`) | Parser ambiguity if a space-separated value were accepted | Issue requires bare and equals forms; start also accepts a path | Register as valueless so bare `--trace` never consumes the path; the existing parser already preserves an `=value` |
| Surface trace streams in status | Durable/runtime observation plumbing | No existing trustworthy seam | Skip |
| Persist trace selection | New durable state and restart semantics | User explicitly forbids persistent state | Do not build |

There are no safe deletion candidates in scope. Nothing is approved for
deletion or feature retirement.

## Validation

- Parser tests: bare means all, comma list selects exact streams, unknown/empty
  input lists valid names, and registry parsing keeps the following path.
- Differential spawn-env tests: no option equals the previous environment;
  all/list overlays only the expected names while retaining unrelated env.
- Existing daemon spawn argv tests remain green.
- Start help renders one short operator-facing line.
- Requested targeted tests, repository typecheck, and `lint:affected` pass.
- Compatibility/crash/performance gates are unchanged because no daemon code,
  durable state, argv, process lifecycle ordering, or hot path changes.
