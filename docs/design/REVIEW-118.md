# Design 118 review ledger

Final verdict: **ALIGNED for implementation** after the binding round-2 fold.
This file records review disposition; the normative specification is
`118-lock-identity-and-resolve-hardening.md`.

## Round ledger

| Round | Verdict | Findings | Disposition |
|---|---|---:|---|
| 1 | NOT ALIGNED | 2 BLOCKER / 10 MAJOR | All twelve findings folded into the round-2 design: compatible six-field wire identity, retryable identity acquisition, exact owned-marker/fence cleanup, private starvation episodes, holder-aware abortable backoff, typed resolve failures, functional Git capability, diagnostics schema reconciliation, and acknowledgement that daemon restart and historical identity recovery required real protocols. |
| 2 | CHANGES REQUIRED | 3 BLOCKER / 7 MAJOR, plus one precision/minor issue | All ten findings resolved below by the binding final-fold decisions. The forged-marker precision issue is accepted under the stated threat model. No further design round is required. |

## Round-2 finding dispositions

| ID | Review finding | Binding final resolution |
|---|---|---|
| B1 | `stale-foreign` could reap a live marker because locality was asserted, not enforced | Delete `stale-foreign` and all mtime reasoning. `lockStorageLocal(<root>/.rbox/state)` uses a positive Darwin/Linux statfs allowlist; NFS, SMB/CIFS, FUSE, unknown, malformed, and error results fail closed. |
| B2 | The fixed `bootTime - 120s` cutoff could leave a prior-boot marker foreign forever | On proven-local storage, every unknown identity is local identity drift and receives the same PID/start-time probe as a recognized current-boot marker. Dead or mismatched is reapable; alive/matching waits; unknown fails closed. No clock cutoff remains. |
| B3 | Daemon restart was aspirational and `stopDaemon` removed the pidfile before exit | `stopDaemon` is SIGTERM + `waitForExit(60_000)` + post-exit pidfile removal, with `forceKill` escalation/reporting. After its successful swap, `upgradeCmd` enumerates every runtime directory and restarts all safely recoverable live daemons with preserved desired/pull-only state, continues per-workspace failures, and exits non-zero on any failure. Version skew is surfaced through retained `daemonVersion`; `scripts/install.sh` remains binary-swap-only. |
| M4 | An old reader can starve on a byte-compatible new marker after reboot | Accepted with the compatibility claim narrowed to same-boot mixed versions. The fixed CLI reaps the marker whenever it next runs; the residual old-only case is recorded below. |
| M5 | Corrupt or transiently unreadable ledger data could erase historical evidence | Reads are bounded, no-follow, regular-file, and schema-validated. Corruption is renamed to the single newest `.corrupt` quarantine; transient unreadability never overwrites the ledger. A rebuild begins with the current boot, and ledger history is no longer required for proven-local recovery. |
| M6 | Re-read-before-rename allowed concurrent lost updates | A tiny `host-identity.json.lock` serializes read/merge/prune/rename through the existing lockfile primitive. Its already-resolved internal acquisition skips ledger refresh to prevent recursion. |
| M7 | `seenAt` and eight-boot eviction were undefined and wall-clock-sensitive | `seenAt` is the monotonic-preferred boot-time epoch. `bootSessionUuid` is the uniqueness key; duplicates merge; the current boot is pinned; at most seven historical entries survive by deterministic `(seenAt,bootSessionUuid)` order. |
| M8 | Partial identity semantics contradicted the compatible wire format | `(kernUuid,bootSessionUuid)` is the mandatory coherent pair. `platformUuid` is optional enrichment. Either missing mandatory value takes the existing unsupported/degraded-unlocked path; a ledger match requires both values from one entry. |
| M9 | Raw-only `holderKey` could not distinguish an observed byte-identical replacement | Hash `kind || raw marker bytes || dev:inode || mtimeNs`. A new inode or mtime is a new observed episode; an ABA completed between observations is explicitly accepted below. |
| M10 | Reaping was not bound to the observation that justified it | Carry the same `(dev,inode,size,mtimeNs,content)` from inspection, through the fence, into `unlinkIfExact`; any changed or indeterminate field aborts the reap. |
| Minor | A forged/corrupt marker could exploit loose identity matching | Matching now requires a coherent `(kernUuid,bootSessionUuid)` pair from one ledger entry. Deliberate marker forgery remains an accepted single-user local threat-model risk below. |

## Explicit accepted risks

- **PID recycling with coincident start time:** On proven-local storage, a recycled PID whose start time exactly equals the marker can be misclassified `live`. This fails in the safe direction (waits rather than unlinks), F3 warns after 15 minutes, and the coincidence probability is negligible.
- **Cross-boot old-reader starvation:** A <=1.6.2 reader alone after reboot can retain a stranded v1.6.3-compatible marker as foreign. New markers preserve legacy hostId bytes, so the window exists only across reboot; any later fixed CLI run heals it. The residual requires the user never to run the installed fixed CLI again.
- **Forged local markers:** A local process can forge PID/start-time marker contents. This is accepted for the local-filesystem, single-user threat model and must be revisited before multi-user support. A real customer exists as of 2026-07-11, but the risk is machine-local; server-side isolation is unaffected.
- **Between-poll byte-identical ABA:** An entire remove/recreate ABA between two observations is unobservable and may retain the prior F3 episode. This affects warning/count episode boundaries, not mutual exclusion.
- **Crash during managed upgrade:** A crash after binary swap and before every daemon restart can leave version skew. There is no atomicity promise; the next status/front-door projection surfaces the old daemon version and exact restart command.
- **At-most-once starvation count window:** Persisting `countedAt` before saving `SyncMetrics.lockStarved` can lose one count on a crash. This is accepted to guarantee that telemetry never double-counts an episode.
- **Mandatory identity unavailable:** Failure to obtain either `kernUuid` or `bootSessionUuid` retains the existing degraded-unlocked availability trade. Durable closed locking health exposes it, and no underlying error is uploaded.
- **Unproven filesystem locality:** A real dead foreign-looking marker on NFS, SMB/CIFS, FUSE, an unknown filesystem, or after statfs failure is never automatically reaped. Availability is sacrificed to preserve cross-host mutual exclusion, with F3 providing the operator surface.

## Symbol audit

Verified against the implementation before the final fold:

- `src/engine/git/lockfile.ts`: `ProcessIncarnation`, `LockMarker`,
  `LockIdentitySource`, `LockfileHooks`, `LockInspection`, `LockAcquireResult`,
  `MarkerRead`, `staleOwnedMarkers`, `execBytes`, `sysctlString`,
  `currentSystemIncarnation`, `systemLockIdentity.current`, `formatLockMarker`,
  `parseLockMarker`, `readMarkerNoFollow`, `inspectLock`, `atomicCreateMarker`,
  `unlinkIfExact`, `acquireFence`, `tryReap`, `OwnedLock.release`, and
  `acquireLock`. `ResolvedLockIdentity` and `lockStorageLocal` are intentionally
  new symbols.
- `src/cli/daemon-control.ts`: `daemonRuntimeDir`, `daemonStatusPath`,
  `daemonPidPath`, `readDaemonPidRecord`, `isDaemonRunning`, `startDaemon`,
  `stopDaemon`, `waitForExit`, and `forceKill`.
- `src/cli/upgrade-cmd.ts`: `upgradeCmd`; its current successful path ends after
  binary replacement and the release-state write, which is where the managed
  restart protocol attaches.
- `scripts/install.sh`: the swap is `mv -f "$TMP" "$DEST/rbox"`; it remains
  intentionally unaware of daemon state.

The daemon-version name is specifically `daemonVersion` in
`RboxBarAmbientStatus`/`RboxDaemon.ambientStatusFrom`; the final design does not
reuse the unrelated pid/binding parser field named `version`.

## Field-fix addendum (2026-07-15): darwin locality adapter


Status: implementation and adversarial reviewer aligned after four rounds.

## Round 1

The reviewer found that globally rejecting any malformed mount record could
disable recovery for an unrelated storage path. The parser was revised to
fail closed only when a malformed or ambiguous record could own the requested
realpath. Darwin adapter-error coverage and stale statfs-adapter prose were
also corrected; the field-incident mount line was marked as verbatim.

## Round 2

The reviewer found that checking only the first ` on ` delimiter could miss a
plausible target mountpoint after a source-side delimiter. The parser now
enumerates every delimiter suffix, and a source-side ambiguity fixture pins
the closed result.

## Round 3

The reviewer found that empty and whitespace-only source fields could bypass
the target-sensitive malformed-record check. Source text is now validated and
target-relevant invalid sources fail closed, with regression fixtures.

## Round 4

The reviewer verified delimiter-loop termination, target-sensitive malformed
handling, path-component matching, longest-prefix selection, duplicate-best
rejection, caching, adapter shape, design text, and the Darwin-only real
adapter test. No remaining correctness issues were found.
