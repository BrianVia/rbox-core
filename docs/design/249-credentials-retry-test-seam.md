# 248 — Deterministic credential retry exhaustion

Status: **ACCEPTED** (2026-08-14, aligned after three review rounds)

## Problem and settled diagnosis

`fresh main contention and a live exact-incarnation fence fail closed without
reaping` runs two independent exhaustion cases. Each consumes the production
credential retry policy (80 attempts with 25 ms between attempts), so the file
normally spends about four seconds in this one test. On a starved CI runner,
timer and filesystem scheduling stretches those waits past Bun's 15-second test
ceiling. The marker is local to the test root; no neighboring test owns it.

The harness also redirects only `HOME`, although `rboxDir()` gives `RBOX_HOME`
precedence. A developer or runner with `RBOX_HOME` already set can therefore
send the suite outside its scratch root. The symlinked-home test separately
changes `HOME`, so it must change the preferred root at the same time.

## Protected functionality

- Production acquisition remains bounded at exactly 80 attempts and 25 ms
  between held-marker attempts.
- A fresh main marker and a live exact-incarnation fence both fail closed after
  exhausting the complete configured budget.
- Neither live marker is reaped or rewritten; its bytes remain exact.
- Fence turnover, stale takeover, heartbeat, crash, compatibility, and fast-path
  behavior are unchanged.

## Change

1. In `credentials.ts`, keep `LOCK_RETRIES = 80` and `LOCK_RETRY_MS = 25` as
   production defaults. Mirror the existing heartbeat test installer with one
   process-local retry-policy installer that validates positive finite values,
   replaces the active retry count/delay, and returns a restoring closure.
   Both credential and fence acquisition read the same owned policy.
2. In the affected test, install a small positive delay and count attempts via
   the existing `lock-contended` hook. For both marker paths, assert unreadable
   (fail closed), exact marker bytes, and the complete configured attempt
   sequence. This preserves exhaustion coverage without measuring wall time.
3. In `beforeEach`, point both `HOME` and `RBOX_HOME` at the scratch root; restore
   the captured environment in `afterEach`. Tests that intentionally redirect
   the preferred credential root restore it to the per-test root. The symlink
   ancestor test redirects/restores both variables.
4. Move the registry entry from suspected to resolved and record the two-budget
   starvation mechanism, deterministic retry seam, isolation fix, and retained
   safety assertions.

## Ownership and simplicity audit

`credentials.ts` remains the sole owner of retry policy and acquisition. Tests
receive one narrow policy seam; they do not rebuild acquisition or add a second
clock abstraction. No module ownership changes, new flags, modes, durable
records, compatibility paths, or deletion candidates are introduced. The
incidental requirement of spending production wall time in a unit test is
removed; the real requirement—full bounded exhaustion—is asserted structurally.

## Validation

- `bun test src/cli/credentials.test.ts`
- ten fresh repetitions of that command
- repository typecheck
- `bun run lint:affected`, with zero warnings on added lines
- diff review confirms production defaults, fail-closed behavior, marker bytes,
  and unrelated tests remain unchanged
