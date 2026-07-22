# SPEC — `rbox upgrade` fully swaps stale daemons

## Problem (field, v1.7.21 rollout, papercuts entry 2026-07-22)
After an installer binary swap, `rbox upgrade` hits the anti-rollback early
exit ("already up to date") at src/cli/upgrade-cmd.ts:209 (and the post-lock
re-read at :242) and RETURNS — `restartDaemonsAfterUpgrade` never runs, so a
live daemon keeps executing the old version until the user manually runs
`rbox stop && rbox start` (the v1.7.19 skew warning is what surfaces it).
The founder directive: `rbox upgrade` must make the running fleet match the
binary, always.

## Fix
1. `restartDaemonsAfterUpgrade(deps, opts?)` gains version awareness:
   - New optional `opts.staleOnly: boolean`. When true, before stopping a
     daemon, read `~/.rbox/daemons/<key>/daemon.status.json` and parse the
     `daemonVersion` field (same ambient status file the skew warning reads —
     find the existing reader in daemon-control.ts/ambient-status and REUSE
     it rather than hand-rolling JSON parsing if a suitable exported reader
     exists; otherwise a small tolerant local reader: unreadable/malformed
     file or absent field → treat as STALE, since pre-1.7.19 daemons have no
     field and an unreadable status must fail toward restarting).
   - A live daemon whose daemonVersion === RBOX_VERSION is SKIPPED silently
     in staleOnly mode (no log line, it is already correct).
   - All other behavior (binding validation, desired-state respect,
     pendingModeIntent/pullOnly resume, failure accounting) unchanged.
2. Both early-exit sites call a new helper `restartStaleDaemonsIfAny(deps)`:
   - Runs `restartDaemonsAfterUpgrade(deps, { staleOnly: true })`.
   - If at least one daemon was restarted (or attempted), print
     `binary already ${RBOX_VERSION}; restarting daemon(s) still running an older version`
     BEFORE the restart lines, and do NOT print "already up to date".
   - If no live daemons or all current → print `already up to date (${RBOX_VERSION})`
     exactly as today.
   - Failure semantics match the existing pass: any failed restart → the
     command exits non-zero with the existing "could not be restarted" error.
   - `--check` mode is NOT affected (it returns before any mutation today —
     keep that; check mode never restarts anything).
3. The successful-upgrade path (line 266) keeps calling the pass WITHOUT
   staleOnly (a full swap just happened; every live daemon is stale by
   definition — current behavior preserved, no version reads needed).

## Tests (extend src/cli/upgrade-daemons.test.ts / upgrade.test.ts)
- Early-exit path, live daemon with daemonVersion older than RBOX_VERSION →
  daemon stopped and resumed (pull-only preserved via pendingModeIntent/
  pullOnly), stale-restart message printed, no "already up to date".
- Early-exit path, live daemon with current daemonVersion → untouched,
  "already up to date" printed.
- Early-exit path, daemon.status.json absent or malformed → treated stale,
  restarted.
- Early-exit path, no live daemons → "already up to date", nothing else.
- staleOnly restart failure → non-zero exit with existing error message.
- Full-upgrade path regression: restart pass still runs without version
  filtering.

## Non-goals / do not touch
- No installer changes; no daemon-side changes; no version.ts changes.
- No behavior change for `--check`.
- Keep the anti-rollback and locking semantics exactly as they are.

## Acceptance
`bun run typecheck` and `bun test src/cli/upgrade-cmd.test.ts src/cli/upgrade-daemons.test.ts src/cli/upgrade.test.ts` (whichever of those files exist) green; name every new test in the report. One commit:
`upgrade: restart daemons still running an older version even when the binary is current`.
