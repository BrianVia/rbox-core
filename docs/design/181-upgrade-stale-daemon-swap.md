# 181 — Upgrade stale-daemon swap

Status: **ALIGNED**

## Problem and invariants

`rbox upgrade` currently returns from both forward-only/equal-version gates
without running the daemon replacement pass. After an installer has already
replaced the binary, a live old daemon therefore survives indefinitely.

The change is confined to `src/cli/upgrade-cmd.ts` and its upgrade tests.
It does not add a sync-engine module or change module ownership, so
`docs/CODEMAP.md` is unchanged. Installer behavior, daemon behavior,
`version.ts`, manifest verification, the forward-only floor, and lock lifetime
remain unchanged.

The following invariants are load-bearing:

- `--check` never stops or starts a daemon. At the first equal/older manifest
  gate it retains the existing `already up to date` output and returns.
- A successful binary replacement still runs the unconditional daemon pass;
  it does not read daemon versions.
- A stale-only pass considers only owned/live pid records with a valid desired
  workspace binding. A live daemon is skipped silently only when its valid ambient record says
  `daemonVersion === RBOX_VERSION`. An absent, corrupt, unreadable, invalid, or
  version-less record is stale.
- Existing desired-binding validation, desired-state race handling,
  `pendingModeIntent` precedence, pull-only preservation, stable key order,
  continuation after failures, and final failure text remain intact.

## Design

Extend `restartDaemonsAfterUpgrade(deps, opts?)` with
`opts.staleOnly?: boolean` and return the number of live stale candidates for
which restart handling was attempted. After pid parsing, ownership/liveness
validation, and the existing desired-binding validation, but immediately before
stopping, stale-only mode calls the existing exported
`readAmbientDaemonStatusRecord(root)` from
`daemon/ambient-status.ts`. Only an `ok` record with an exact current version is
skipped. Reading by resolved desired root uses the same
`daemonStatusPath(root)` mapping as daemon control and the skew warning.

The existing binding failure path therefore cannot be hidden by a current-version
status file at a mismatched path. A live runtime without a valid binding retains
its existing diagnostic and aggregate failure; it is not called a stale restart
candidate because no authoritative status path can be derived.

Add `restartStaleDaemonsIfAny(deps)` for the two non-check equal-version exits.
It runs `restartDaemonsAfterUpgrade(deps, { staleOnly: true })`. To guarantee the
summary precedes per-daemon restart/failure lines even though the candidate
count is known only after discovery, it buffers the pass's log output. On a
nonzero attempted count it emits

```text
binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version
```

then replays the buffered lines. On zero attempts after a successful pass it emits the existing
`already up to date (${RBOX_VERSION})` line. If the pass throws, the attempted
count is retained on an internal error subtype while preserving the existing
error message; the helper emits the appropriate prefix and buffered lines, then
rethrows so command failure semantics are unchanged. Discovery failures with no
known stale attempted daemon replay their diagnostic and fail without either
success message.

The first anti-rollback gate calls the helper only when `opts.check !== true`.
The post-lock re-read always calls it. The successful replacement path keeps
calling `restartDaemonsAfterUpgrade(opts.daemonDeps)` without options.

## Tests

Extend `src/cli/upgrade-daemons.test.ts` with focused stale-helper/pass coverage:

1. older live pull-only daemon: stop/start occurs, pull-only is preserved, the
   stale summary precedes restart output, and `already up to date` is absent;
2. exact-current live daemon: no stop/start and only `already up to date`;
3. absent ambient status: stale and restarted;
4. malformed ambient status: stale and restarted;
5. no live daemon: no mutation and only `already up to date`;
6. stale restart failure: existing final error is preserved and stale summary
   precedes the failure line;
7. unconditional/full-upgrade pass with a current ambient version: restart still
   occurs, proving version filtering is opt-in.

Add `src/cli/upgrade-cmd.test.ts` with mandatory command-routing coverage for
the first equal-version gate, that gate's `--check` bypass, the post-lock
equal-version re-read, and the successful replacement path. A narrow injectable
seam for standalone detection and manifest parsing lets the test use a temporary
executable and deterministic signed-manifest result without weakening the
production defaults. The successful-path test replaces only that temporary
executable and proves a current-version ambient record does not filter the full
restart pass. No network access or installed binary mutation is used.

## Validation

Run exactly the requested acceptance commands (omitting nonexistent test files):

```text
bun run typecheck
bun test src/cli/upgrade-cmd.test.ts src/cli/upgrade-daemons.test.ts src/cli/upgrade.test.ts
```

Then run the relevant repository guards and inspect the final diff. Commit all
task artifacts in one commit named:

```text
upgrade: restart daemons still running an older version even when the binary is current
```
