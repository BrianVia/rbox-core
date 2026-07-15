# 118 gate findings — apply all (3-angle review verdicts; altitude was ALIGNED)

## Must-fix (efficiency majors — the design's own incident math)

1. **Identity-ledger refresh: once per process, not per acquire.** Today every
   `acquireLock()` runs `refreshSystemLockIdentityLedger()` → nested
   host-identity.json.lock + read + UNCONDITIONAL rewrite (~3 fsyncs) even when
   content is unchanged — per pump tick, and per retry during a starvation
   episode. Fix: module-level memo so the full read/lock/merge/write sequence
   runs exactly once per process lifetime (main-dispatch's startup call is the
   real refresh; acquireLock's internal call becomes a cache hit returning the
   in-memory ResolvedLockIdentity). Also: skip the rewrite when the merged
   ledger is byte-identical to what was read (cheap equality check) so even the
   one real refresh is read-only in steady state.
2. **Memoize own processStart.** `currentSystemIncarnation()` calls
   `processStart(process.pid)` per invocation (darwin: a sysctl subprocess
   spawn per acquire). pid+startTime can't change in-process — memoize once
   (independent of the boot-uuid retry caches, which stay as-is).
3. **Guard the per-cycle starvation-file rm.** `clearLockStarvationEpisode()`
   unconditionally `fs.rm`s every pump cycle. Only touch disk when
   `this.lockStarvationEpisode` was set (in-memory guard).

## Quality (apply all)

4. Delete dead `heldDetail` + `lastDetail` in src/cli/sync-mutex.ts (assigned,
   never read; superseded by WorkspaceSyncBusyError + causal blocker).
5. `readLockingHealth()` (sync-mutex.ts:81-97): the shape-validation branch and
   its else return the identical value — collapse to the single return.
6. `validDaemonVersion()` (ambient-status.ts): drop the hand-rolled semver
   regex; wrap `parseSemver` (src/cli/semver.ts) in try/catch exactly like
   update-check.ts's updateAvailableVersion does. Keep the length cap.
7. `recordVerifiedRelease()` (upgrade-cmd.ts): use `fsyncDirectory` from
   src/engine/fsutil.ts (import directly; optionally re-export via
   engine/index.ts) instead of the hand-rolled open/sync/close. ALSO extend
   `writeFileAtomic` (fsutil.ts) with optional `{ mode?: number, flag?: string }`
   and collapse the three hand-rolled temp-write dances (upgrade-cmd
   recordVerifiedRelease, lockfile.ts writeLedger, and any third site the
   grep finds) onto it — behavior identical, one shared implementation.
8. `isOurDaemon()` (daemon-control.ts:190): back to ONE `ps` read testing both
   substrings; keep `isDaemonProcess` as a thin wrapper over a shared
   single-read helper for upgrade-cmd's standalone use. (This is a hot path on
   most rbox invocations.)
9. `safeResolveText()` (git-cmd.ts ~332): the `\r\n\p{Cc}` replace runs AFTER
   sanitizeTerminalText already stripped those chars — unreachable, and the
   intent (multiline error → single line with spaces, not concatenated words)
   requires the OPPOSITE order. Run the replace-with-space FIRST, then
   sanitizeTerminalText. Add/extend a test with a multiline error message
   asserting words stay space-separated.

## Acceptance

`bun test ./src/engine/git/ ./src/cli/` and `bun run typecheck` natively green
(known host flakes exempt: json-output shellStateOf, same-SHA metadata heal).
Extend tests where behavior is pinned (once-per-process refresh: assert the
ledger write happens once across two acquires; single-ps daemon check). Do not
commit.
