# design 218: autostart command module family

Status: implemented and validated

## Goal

Decompose `src/cli/autostart-cmd.ts` into a cohesive module family with every
module at most 500 lines, while preserving the existing
`./autostart-cmd.js` public import surface and all behavior from the recent
maintenance-mode work. This is a move-only refactor: production function
bodies remain byte-identical except for import declarations and the `export`
modifier needed for private cross-module seams.

## Exact layout and ownership

```text
src/cli/
  autostart-cmd.ts
  autostart/
    desired-state.ts
    daemon-state.ts
    boot-resume.ts
    install.ts
    command.ts
    test-helpers.ts
    install.test.ts
    command.test.ts
    desired-transitions.test.ts
    mode-maintenance.test.ts
    daemon-maintenance.test.ts
    desired-state.test.ts
    boot-resume.test.ts
```

- `autostart-cmd.ts` remains a logic-free compatibility facade and explicitly
  re-exports the same values and types as today. No consumer import changes are
  required.
- `desired-state.ts` owns the desired-record schema, paths, parsing, atomic
  persistence, lock discipline, generation comparison, mode projection, and
  desired-row/status enumeration. It exposes narrow internal helpers to
  sibling modules but the facade re-exports only the established public API.
- `daemon-state.ts` owns start/stop desired-state transitions, the
  pending-mode park/promotion maintenance seam, and generation-guarded resume.
  The complete `startDaemonAndRecordDesiredImpl` closure, user-start scope
  transition lock, and desired-record maintenance protocol move as one unit.
- `boot-resume.ts` owns credential-gated boot enumeration and resume dispatch.
- `install.ts` owns LaunchAgent/systemd rendering, binary resolution, install,
  uninstall, and enabled-state inspection.
- `command.ts` owns status presentation and `autostartCmd` dispatch.
- `test-helpers.ts` owns unchanged filesystem/credential test fixtures shared
  by the moved successor suites.

Sibling modules import concrete owners directly and never import the facade.

## Move-only invariants

1. No production function or callback body is edited.
2. No symbol is renamed.
3. Import paths and import lists may change.
4. Formerly file-private declarations may gain `export` solely for sibling
   access; the compatibility facade does not expose those new internal seams.
5. `startDaemonAndRecordDesiredImpl`, its callback ordering, its
   `StaleDesiredResumeError` handling, and the pending-mode generation guards
   move together without restructuring.
6. Scope binding resolution remains exactly where it is inside start
   admission. Nothing under `src/cli/scope/` or track/transaction logic changes.
7. OS service file content and command ordering remain byte-identical.
8. `sameDesiredGeneration` continues not to compare `maintenance`; this is the
   intentional PR #555 behavior and is not “fixed” during the move.

Before extraction, save the post-#555 production file and compare every
top-level declaration body by symbol against its destination, including class
constructors and const-arrow initializers. Only import changes and
declaration-level `export` additions are allowed. The final report lists every
body changed beyond imports; expected result: none.

The compatibility facade explicitly preserves exactly this post-#555 surface:

- `BOOT_RESUME_MARKER`;
- `DesiredDaemonStateValue`, `DaemonMaintenance`, `DesiredDaemonState`,
  `DesiredStateRow`, and `AutostartWorkspaceStatus`;
- `desiredStatePath`;
- `startDaemonAndRecordDesired`, `startDaemonForUser`, `resumeDesiredDaemon`,
  and `stopDaemonAndRecordDesired`;
- `DaemonMaintenanceConflictError`, `readDaemonMaintenance`,
  `parkDaemonForMaintenance`, and `resumeDaemonAfterMaintenance`;
- `promotePendingModeIntent`, `readDesiredDaemonRows`,
  `autostartWorkspaceStatuses`, and `bootResume`;
- `enableAutostart`, `disableAutostart`, `isAutostartEnabled`, and
  `autostartCmd`.

## Test partition and fidelity

Every existing assertion remains inside its original test callback:

- install and binary-resolution cases move to `install.test.ts`;
- CLI status/linger presentation cases move to `command.test.ts`;
- ordinary start/stop and admission-result cases move to
  `desired-transitions.test.ts`;
- pending-mode parking, witness promotion, and generation-race cases move to
  `mode-maintenance.test.ts`;
- PR #555 user-start and park/read/resume maintenance-protocol cases move to
  `daemon-maintenance.test.ts`;
- desired-row enumeration/status cases move to `desired-state.test.ts`;
- boot resume and degraded-credential cases move to `boot-resume.test.ts`.

Shared named fixture helpers move byte-identically into `test-helpers.ts`.
Per-file setup/cleanup callbacks may be repeated verbatim. Test callbacks and
their assertions are not rewritten.

## Validation

Run:

```sh
bun run typecheck
bun test src/cli/autostart/
bun test src/cli/scope/ src/cli/track-cmd.test.ts src/cli/front-door.test.ts
```

Also run tests owned by every direct consumer of the facade where a focused
suite exists: `setup-cmd`, `setup-keyed-rebind`, `uninstall-cmd`, `upgrade-cmd`,
`upgrade-daemons`, `binding-registry`, `credential-policy`,
`main-dispatch-start`, `main-dispatch-upgrade`, `main-dispatch-pair`,
`track-untrack`, and the status/maintenance contract. Use
`bun test src/cli/` as the broad collateral gate if that is more reliable than
enumerating individual files. There is no focused auth/session test. Run
`bun run rig` for the repository integration gate.

Finally verify:

- every production and successor test module is at most 500 lines;
- all existing facade consumers still import `./autostart-cmd.js` (or its
  relative equivalent);
- no scope-transaction or track implementation changed;
- all 46 post-#555 tests are assigned to successors and their aggregate 158
  expectation calls are preserved.

Stage only named files, commit on `chore/autostart-split`, and do not push.
