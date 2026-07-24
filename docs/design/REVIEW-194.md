# Review 194 — Daemon control decomposition

## Round 1

Verdict: not aligned.

Two reviewers independently found that the proposed persistence boundary was
false: `startDaemon` still serialized PID records and directly performed
record mutation. They also found an inward `daemon.ts` import through the
outward compatibility facade, missing CODEMAP deliverables, inadequate
protection for type-only facade exports, and no integrated rig gate.

Revision:

- renamed the filesystem module to `runtime-state`;
- assigned synchronous PID publication, concrete lifecycle state mutations,
  and whole-runtime removal to it;
- made `daemon/daemon.ts` the single intentional direct importer;
- scoped crash-log guarding to spawn preparation;
- required an exact runtime and compile-time facade contract;
- specified all four CODEMAP lines;
- added `bun run rig` and explicit start-order fidelity review to validation.

## Round 2

Architecture: aligned.

Compatibility found one remaining blocker: `daemon/daemon.ts` also consumes
`DAEMON_BOOT_ID_ENV`, so moving only its record imports would retain the facade
back-edge. The design now assigns that key to `runtime-state`; both
`daemon.ts` and `process-control.ts` import it there and the facade re-exports
it for compatibility.

## Round 3

Compatibility: aligned. No remaining design or validation blockers.

## Final code review

Both reviewers approved the implementation. They confirmed the split is
substantive, dependency direction and CODEMAP are accurate, the facade retains
its runtime and type surface, and behavior-sensitive start/stop/log ordering is
unchanged.
