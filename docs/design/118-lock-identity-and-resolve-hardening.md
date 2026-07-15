# 118 — Lock identity + resolve hardening (field incident 2026-07-15)

Status: final; implementation-ready. Evidence: the 2026-07-15 fleet health
sweep. Five defects, all field-proven on the founder's machines, all in the
design-116 locking/resolve stack. One release (v1.6.3) fixes all five.

## The incident chain (evidence)

1. Mac rebooted 2026-07-14 09:39 local. At 13:43Z its pull pump began spinning
   on "another sync is in progress (cross-host lock)" — 341,824 log lines at
   ~4/s, 26h of starvation, 290 sequences behind. The sync.lock marker carried
   the PREVIOUS boot's `kern.uuid`: **on darwin, `kern.uuid` is per-boot**, so
   the daemon's own pre-reboot lock classified as `foreign` (a different host),
   and foreign locks are — correctly — never broken.
2. `rbox git resolve` failed with a generic "operation-failed" that swallowed
   the real error (`run.catch(() => …)` discards the exception,
   git-cmd.ts:551).
3. With the error surfaced (diagnostic build): resolve's own mutex acquire
   failed against a marker leaked by a PREVIOUS resolve run — the acquire path
   that breaks a dead same-host marker can fail its create/verify step,
   self-contend against the marker it just wrote, throw, and leave that marker
   on disk. Every subsequent resolve then fails against the leaked marker.
   (Observed: marker pid 56260 = a dead resolve process, current-boot hostId.)
4. The daemon pump retries a contended mutex with no effective backoff
   (`syncMutexBackoff` ≈ 250ms): the 341k-line log spam.
5. flat-meadow (git 2.43, Ubuntu 24.04 default) lacks `update-ref --stdin`
   `symref-update` (git ≥ 2.46): three repos deferred permanently with
   "unsupported git state". Safe, silent-ish, forever.

## Existing boundaries and corrected claims

Per `docs/CODEMAP.md`, `src/engine/git/lockfile.ts` owns the generic lock
primitive, `src/cli/sync-mutex.ts` owns workspace mutex policy, and
`RboxDaemon` in `src/cli/daemon/daemon.ts` owns pump scheduling. This design
does not move those responsibilities.

The current wire marker is exactly `rbox-93 <hostId> <bootId> <pid>
<startTime> <token>\n`. `LockMarker`, `formatLockMarker`, and the end-anchored
`parseLockMarker` accept no extension. Therefore appending `platformUuid`
would make the marker foreign to every <=1.6.2 reader. In v1.6.3 the raw
marker stays byte-for-byte compatible and keeps current `kern.uuid` in
`hostId`. Keep wire-only `LockMarker` unchanged; a distinct
`ResolvedLockIdentity`/inspection context joins parsed markers to the ledger
and carries optional `platformUuid`, never a seventh wire field. New readers
use it only as enrichment. A versioned wire format using the platform UUID may
ship only in the release after next.

Also, daemon restart is not an existing upgrade property: `scripts/install.sh`
only replaces the binary, and `upgradeCmd` in `src/cli/upgrade-cmd.ts` currently
prints "Re-run rbox." v1.6.3 deliberately gives the two paths different
contracts. The installer remains binary-swap-only; fleet/release instructions
already require an explicit stop/start. The managed `rbox upgrade` path, and
only that path, performs the resident-daemon protocol below. Byte-compatible
markers make mixed versions safe within one boot, so version skew is surfaced
but never refused.

### v1.6.3 resident-daemon upgrade protocol

`stopDaemon` in `src/cli/daemon-control.ts` changes from "SIGTERM then remove
pidfile" to stop-and-wait: revalidate with `isDaemonRunning`, send SIGTERM,
poll with the existing `waitForExit` for at most 60 seconds, and remove
`daemonPidPath(root)` only after exit. At timeout, call the existing
`forceKill`, report the escalation, wait for confirmed exit, and fail if the
process still cannot be confirmed dead. PID ownership is rechecked before
every signal. This common contract applies to normal `rbox stop` as well as
upgrade, eliminating the current line-307 remove-before-exit race.

The existing `RboxBarAmbientStatus.daemonVersion` emitted by
`RboxDaemon.ambientStatusFrom` becomes an optional field of
`AmbientDaemonStatusV1`; `parseStatus` must retain it, and daemon startup writes
an initial `daemon.status.json` before normal pump work. Do not overload
`ParsedDaemonPid.version` or `ParsedDaemonBinding.version`: those names already
mean the `legacy | v2 | invalid` record grammar. Old ambient records without
`daemonVersion` render as `pre-1.6.3`; malformed/unreadable values are unknown
and never used as authority. `rbox status`, its JSON projection, and the daemon
line compare this field only after `isDaemonRunning` proves the record belongs
to a live daemon. A known mismatch renders, for example, `daemon v1.6.2, CLI
v1.6.3 — restart: rbox stop && rbox start`; a live record missing the field
renders `daemon pre-1.6.3, CLI v1.6.3 — restart: rbox stop && rbox start`.
There is no start, lock-acquire, resolve, or other refusal gate.

After `upgradeCmd` has atomically swapped and durably recorded the new binary,
it enumerates every directory under `~/.rbox/daemons/`, not merely the current
workspace or running desired rows. It parses each `daemon.pid`, selects every
live owned daemon, joins it by workspace key to `readDesiredDaemonRows`, and
validates the desired root/workspace binding. The snapshot preserves
`DesiredDaemonState.pullOnly`. A live legacy runtime directory with no valid
desired row is still reported and makes the final result non-zero, but is not
stopped because its root and pull-only state cannot be recovered safely.

For each restartable workspace, in stable workspace-key order, `upgradeCmd`
calls the stop-and-wait `stopDaemon`, then calls `startDaemon` with the
preserved `pullOnly` state; the desired record itself is not rewritten. It
continues after any per-workspace discovery, stop, or start failure and prints
one closed outcome per live runtime directory; any failure makes `upgradeCmd`
exit non-zero after attempting the whole snapshot. Stopped desired records are
not started. A crash after the binary swap but before some restart makes no
atomicity promise: the next `rbox status` or bare-rbox front door (which calls
`statusCmd`) exposes the recorded
version skew and the restart command. The release lock continues to serialize
the binary swap; it does not hide per-workspace outcomes.

This design supersedes design 93 section 7 where it specifies Darwin identity,
foreign-never-reaped behavior, and stale-owned recovery. It also updates
`docs/diagnostics.md` for the new closed schemas.

## F1 — Darwin identity, historical aliases, and local recovery

### Identity acquisition and ledger

`currentSystemIncarnation` and `systemLockIdentity.current` stop treating
`kern.uuid` as a stable host identifier. On Darwin, retrieve independently:

- `platformUuid`: `IOPlatformUUID` using absolute `/usr/sbin/ioreg` (or
  `/usr/sbin/sysctl -n kern.iokit.platform-uuid` when available);
- `kernUuid`: `/usr/sbin/sysctl -n kern.uuid`, retained as v1.6.3 wire
  `hostId` and a legacy alias; and
- `bootSessionUuid`: `/usr/sbin/sysctl -n kern.bootsessionuuid`, retained as
  wire `bootId`.

Each command has a 2s timeout, bounded output, and SIGKILL on timeout. Each
component validates independently against the UUID grammar. Cache only a
validated value, never a rejected promise (unlike today's cached promise in
`systemLockIdentity.current`). Retry transient failures three times with
bounded backoff, then retry missing components on each acquire. In v1.6.3,
`kernUuid + bootSessionUuid` is required to write the compatible marker;
adding platform UUID enables enrichment. Missing platform UUID gives
legacy-only same-boot locking and remains retryable; missing kern or boot UUID
is degraded-unlocked even if the other two exist. `execBytes`, `sysctlString`,
and the ioreg fallback are the implementation points.

Every daemon/CLI startup resolves lock identity. Before writing any main or
fence marker it durably merges the valid identity into
`~/.rbox/host-identity.json`, mode 0600. The bounded schema is
`{version:1,boots:[{platformUuid?,kernUuid,bootSessionUuid,seenAt}]}`. The
mandatory identity and deduplication key is the coherent
`(kernUuid,bootSessionUuid)` pair; `platformUuid` is optional enrichment.
Entries lacking it remain valid same-host evidence through that pair.

Ledger reads are bounded, no-follow, regular-file reads with strict schema and
UUID validation. A syntactically or structurally corrupt ledger is atomically
renamed aside as `host-identity.json.corrupt` (replacing the older quarantine,
so only the newest corrupt artifact is retained), never silently deleted; a
new ledger starts with the current boot. A transient/unclassified read error
does not overwrite the existing ledger and surfaces closed locking health.
Loss or corruption of history is not load-bearing because the proven-local
probe rule below handles unknown identities.

All read/merge/prune/rename operations run under a tiny
`host-identity.json.lock` acquired through the existing lockfile primitive;
the internal ledger-lock acquisition skips the ledger-refresh hook to avoid
recursion. File and parent directory are fsynced before a workspace main or
fence marker is created. Duplicate `bootSessionUuid` entries merge, retaining
the mandatory pair, non-empty optional enrichment, and greatest `seenAt`.
`seenAt` is the boot-time epoch derived from the monotonic-preferred
boot/uptime source, not the merge wall clock. Retain at most eight entries:
pin the current boot, then take the newest seven historical boot sessions by
`(seenAt,bootSessionUuid)` descending; the UUID is the deterministic tie-break.
This prevents concurrent lost updates, makes `C_A` durable before a crash, and
defines eviction despite wall
clock steps. The file never enters workspace state, diagnostics, logs, or
telemetry.

`readMarkerNoFollow` must retain one safe `MarkerRead` observation: dev, inode,
size, mtime in nanoseconds, and bounded exact content. A coherent ledger pair
matching `(marker.hostId,marker.bootId)` is historical same-host evidence. For
that pair, current `bootSessionUuid` selects the existing local process probe
and a different boot is `dead`. Apply this exact rule to both `sync.lock` and
`sync.lock.reap`; matching only one member of a pair is never sufficient.

### Locality and unknown-identity classification

Classification uses no timestamp or elapsed-time heuristic. Before treating an
unrecognized marker as local identity drift, injectable
`lockStorageLocal(<root>/.rbox/state)` must positively prove
that the marker storage is local. On Darwin it reads `statfs.f_fstypename` and
allows only `apfs` and `hfs`. On Linux it reads `statfs.f_type` and allows only
ext4 (`0xef53`), btrfs (`0x9123683e`), xfs (`0x58465342`), zfs
(`0x2fc12fc1`), f2fs (`0xf2f52010`), tmpfs (`0x01021994`), and overlay
(`0x794c7630`). NFS, SMB/CIFS, FUSE, every unlisted value, malformed results,
and every syscall/error path return `false`. Cache only a successful result
for that state filesystem identity; tests inject the platform statfs adapter.

On a proven-local filesystem, an unrecognized `hostId` is this machine's
identity drift, not evidence of another live machine. Parse the marker's PID
and start time and call `systemLockIdentity.probe` exactly as on the recognized
same-boot path: a dead PID or start-time mismatch is `dead` and fence-reapable;
alive with the identical start time is `live` and must wait; an unknown probe
fails closed as `foreign`. Thus a marker written 60 seconds before a crash is
recovered immediately after reboot without time arithmetic. On storage not
proven local, the marker stays `foreign`, is never unlinked, and F3 gives the
operator the durable warning after 15 minutes.

For a dead main marker, `tryReap` requires its sibling fence. A dead `.reap` is
the single-level exception: `acquireFence` re-observes
and directly applies `unlinkIfExact`, never creates `.reap.reap`, then retries.
Competing breakers treat replacement/ENOENT as a lost race and re-observe;
causal failure identifies the fence. Identity, locality, probe, and exact
observation rules are identical.

### Eight-cell compatibility matrix

Let `L_A` be a legacy marker from boot A. Let `C_A` be a v1.6.3 logical marker:
the same compatible raw `hostId=K_A, bootId=B_A`, enriched by new readers with
`platformUuid=P`. “A/B” is the reader boot.

| Marker | Reader | Boot | Result |
|---|---|---:|---|
| L_A | old | A | same host/boot; process probe |
| L_A | old | B | foreign (legacy limitation) |
| L_A | new | A | same host/boot; process probe |
| L_A | new | B | dead if ledger knows pair A; otherwise local-fs process probe, or foreign when locality is unproven |
| C_A | old | A | same host/boot because raw hostId remains K_A |
| C_A | old | B | foreign (legacy limitation) |
| C_A | new | A | same host/boot, preferring enriched P |
| C_A | new | B | dead if ledger knows pair A; otherwise local-fs process probe, or foreign when locality is unproven |

These are eight unit cases, not prose-only compatibility claims.

### Identity-source failure

If the minimum compatible identity fails, `acquireLock` continues returning
`unsupported`, and `degradedHandle` in `sync-mutex.ts` retains the existing
degraded-unlocked behavior. This is an explicit availability-over-exclusion
trade for a single-user tool. Replace `surfacedDegradedRoots` with atomic
`.rbox/state/locking-health.json`, exactly `{status:"degraded-unlocked",
reason:"identity-unavailable"}`. `degradedHandle` writes it; the next normal
acquire clears it. Status JSON exposes `locking:{status,reason,path}` and text
and doctor show the same closed values plus literal `.rbox/state/sync.lock`.
The record and underlying error never enter diagnostics.

## F2 — Exact ownership across main markers and reaper fences

The rule covers every marker created in `acquireLock`, `acquireFence`, and
`tryReap`, including `.reap`:

1. A marker created by this acquire is recognized as ours by exact raw bytes
   (therefore pid + startTime + token), never as contention.
2. Failure after creation cleans up only through existing
   `unlinkIfExact(path, expectedRaw)`. Never use unconditional unlink.
3. If verification/cleanup is indeterminate or a replacement is observed,
   leave the marker, return acquisition failure, and register its exact raw
   value as a `staleOwnedMarkers` candidate for the next acquire in the same
   process. Never claim cleanup succeeded after ownership changes.
4. Track failed `OwnedLock.release()` for a fence exactly like the main lock;
   retry it on the next acquire and surface `fence` as the causal blocker.
5. Cross-process breaking remains serialized by the `.reap` fence. The race
   test uses two independent processes, not merely two promises in one process.
6. A reap decision carries the same observed `(dev,inode,size,mtimeNs,content)`
   from `inspectLock`, through fence acquisition, into `unlinkIfExact`. The
   pre-unlink observation must match every field; any change or indeterminate
   re-read aborts the reap and returns to observation. Owned-marker cleanup and
   `OwnedLock.release()` continue to use exact raw token-bearing bytes because
   those bytes are the ownership capability; foreign/dead reaping always uses
   the complete observation.

`acquireFence` and `tryReap` currently collapse failure to `undefined`/false,
and `tryReap` ignores the fence release result. Replace those results with an
internal causal result naming main versus fence observation. Extend
`LockInspection`/`LockAcquireResult` only enough to propagate the private
cause; raw bytes and fingerprints remain non-public.

## F3 — Durable, private starvation episodes

`DaemonMutexResult` currently exposes only `detail`; `heldDetail` loses marker
identity. A contended result instead carries a private complete causal blocker
(main marker plus fence when the fence prevented reaping), blocker kind
`live | foreign | stale-owned | fence`, optional F3 reason limited to
`foreign | identity-drift | stale-owned | fence`, and `holderKey`. Ordinary
recognized live contention gets F4 backoff but no starvation warning; a
proven-local unknown identity whose PID/start time is alive and matching uses
the `identity-drift` warning reason. For every causal component, `holderKey` is
a cryptographic hash of `kind || exact raw marker bytes || dev:inode ||
mtimeNs`; a malformed regular marker uses its bounded raw bytes in the same
formula. Same bytes on a new inode or with a new mtime are a new observed
episode. The key is never logged, rendered, or uploaded.

Before its first pump acquire, `RboxDaemon.start` loads the bounded local-only
`.rbox/state/lock-starvation.json` record:
`{holderKey,firstSeenAt,warnedAt,countedAt}`. The daemon atomically clears it
on acquisition, observed absence, or holder-key change. Observed replacement
or ABA starts a new episode; an ABA completed entirely between polls is
necessarily unobservable and remains the same episode. Continuous eligible
contention by one holder for 15 minutes produces an EVENTUALLY-ONCE warning:
log before persisting `warnedAt`, so a crash may duplicate the line. Persist
`countedAt` before incrementing/saving `SyncMetrics.lockStarved`; on restart,
a persisted
`countedAt` suppresses another count. Thus telemetry counts an episode at
most once. A crash after `countedAt` persistence but before metrics save may
lose that count; this accepted window buys the never-duplicate guarantee.

The only daemon record is exactly `lock starved:
reason=<foreign|identity-drift|stale-owned|fence> age=<15m|1h|1d>`, with
buckets 15–59m, 1–23h, and >=1d. No path, PID, UUID, token, raw marker, holder
key, timestamp, or free-form detail is allowed. `statusCmd` text and `--json`,
and doctor, may show only the literal relative path `.rbox/state/sync.lock`
and the closed reason. The episode record itself is never copied into
diagnostics.

## F4 — Holder-aware, abortable pump backoff

Replace `syncMutexBackoff: () => Promise<void>` and the fixed
`sleep(jitter(250))` in `RboxDaemon` with holder-aware state:

- exponential tiers from 250ms to a 30s cap while `holderKey` is unchanged;
- one re-queued log per `(holderKey,tier)`, with no marker detail;
- reset on successful acquisition or holder-key change;
- an AbortSignal-backed wait that `stop()` aborts immediately; and
- while parked, new requests only OR want bits and trigger one rate-limited
  early re-probe, no more often than every 2s.

No want bit is cleared until successful acquisition and
`daemonBindingMatches` revalidation. Maximum takeover latency after release is
the current tier or the permitted early re-probe, whichever occurs first.
`request`, `requestPush`, and all want-bit ingress signal the rate limiter;
`stop` owns and aborts the backoff controller.

## F5 — Typed resolve errors and functional Git capability

### Resolve contract

`gitResolveCmd` keeps its existing explicit outcomes, but replaces the open
`ResolveOutput` refused `code: string` and terminal swallowing catch with a
closed `ResolveRefusalCode`. `sync-mutex.ts` supplies a typed contention error;
mapping never parses error strings.

| Source | Code/status | Safe message |
|---|---|---|
| workspace mutex contended | `sync-busy` | daemon/CLI is syncing; retry, or run `rbox stop` first |
| snapshot identity changed | existing `snapshot-mismatch` status | confirm the newly rendered snapshot |
| oracle/index/reachability proof indeterminate | `proof-indeterminate` | proof could not complete; retry after Git state settles |
| journal recovery failure | `journal-recovery` | closed recovery guidance, no quarantine absolute path |
| no incoming state | `no-incoming` | existing closed message |
| degraded mutex | `mutex-degraded` | locking unavailable; resolution refused |
| typed follow refusal | closed `GitDeferralReason` subset | `refusalMessage` closed text only |
| unknown exception | `operation-failed` | generic safe fallback; no exception text |

Before both JSON and human `emit` paths, collapse CR/LF/control characters,
redact URL userinfo and authorization/secret-shaped arguments, and relativize
workspace-contained paths. Human-only `sanitizeTerminalText` is insufficient
because JSON currently retains controls. Resolve exception/error text must
never enter `SyncMetrics`, `PhaseReport`, daemon activity/logs, or a diagnostics
bundle.

### Git check

Doctor reuses the real functional `checkoutTransactionSupported` protocol in
`src/engine/git/checkout-txn.ts` (`update-ref --stdin`, `symref-update`,
prepare, commit), cached by the exact `git --version` result. Export a typed
capability result because the current boolean conflates failures. Closed
statuses are `supported`, `git-missing`, `version-unavailable`,
`probe-failed`, and `unsupported`; detected version is context only and raw
stderr is discarded. On repos with an unsupported capability, status replaces
`unsupported git state` with `needs Git >= 2.46 transactional symref-update;
found <sanitized version>`. `statusCmdWithDeps` obtains the typed cached probe
for unsupported deferrals and passes `{status,version}` to JSON
`git.capability` and `status-view.ts`; it is not persisted in `GitDeferral`.

## Complete schema and presentation touchpoints

Implementation must update every item below together:

1. `src/engine/git/lockfile.ts`: `ProcessIncarnation`, wire `LockMarker`, new
   `ResolvedLockIdentity`, `lockStorageLocal`,
   `MarkerRead`, `LockInspection`, `LockAcquireResult`, `formatLockMarker`,
   `parseLockMarker`, `readMarkerNoFollow`, `inspectLock`, `atomicCreateMarker`,
   `unlinkIfExact`, `acquireFence`, `tryReap`, `OwnedLock.release`,
   `staleOwnedMarkers`, and identity acquisition. The rbox-93 raw grammar does
   not change in v1.6.3. `config-txn.ts` candidate naming keeps existing
   `ProcessIncarnation.hostId` semantics. `src/cli/main-dispatch.ts` invokes the
   startup identity/ledger hook even for non-locking CLI commands.
2. `src/cli/sync-mutex.ts`: `DaemonMutexResult`, `SyncMutexOptions`,
   `heldDetail`, `degradedHandle`, and `acquireWorkspaceSyncMutex`; private
   holder/cause fields never become presentation strings.
3. `src/cli/daemon/daemon.ts`: `metrics` initializer/load/save,
   `acquireSyncMutexFn`, `syncMutexBackoff`, `want`, `pump`, `pumpLoop`,
   `pumpRun`, `request`, `requestPush`, `start`, `stop`,
   `RboxBarAmbientStatus`, and `ambientStatusFrom` ordering/projection.
4. `src/cli/metrics.ts`: add exactly one non-negative integer,
   `SyncMetrics.lockStarved`, to `ZERO`, backward-compatible `loadMetrics`, and
   `saveMetrics`; load normalizes it to a non-negative safe integer before
   arithmetic. No reason, path, holder, age, or identity dimension exists.
5. `src/cli/status-cmd.ts`: `StatusCmdDeps`, `statusCmdWithDeps`, inline JSON,
   and human renderer gain closed locking health and typed Git probe;
   `status-view.ts` receives that projection. Add text/JSON tests.
6. `src/cli/doctor-cmd.ts`: add required `locking` and `git` names to
   `CheckName`, `DoctorChecks`, `collectDoctorContext`, and `renderDoctor` order;
   add `lockStarved` to `pickMetrics`; normalize the closed lock warning in
   `redactGitLogLines`. Use existing `status`/`current` fields for closed result
   and sanitized Git version.
7. Reconcile the existing client/API drift: the client emits required
   `credentials,enrollment,device,daemon,remote,version,state,crypto,locking,git`
   plus optional `chain`. `apps/api/src/diagnostics.ts` splits `CHECK_KEYS`
   into legacy `REQUIRED_CHECK_KEYS` (today's six) and `OPTIONAL_CHECK_KEYS`
   (`device,crypto,locking,git,chain`), while
   `CHECK_RESULT_KEYS`, `validateChecks`, and `validateCheckResult` must accept
   that exact vocabulary/optionality; it currently rejects `device`, `crypto`,
   and `chain`. `METRICS_KEYS` and `validateMetrics` add only `lockStarved`,
   validated by existing `safeNumber`. `TOP_KEYS` does not change.
8. `DiagnosticsBundle`, `buildDiagnosticsBundle`, client doctor fixtures, and
   `apps/api/test/diagnostics.test.ts` fixtures/route tests must round-trip the
   new checks and metric client -> validator -> API storage. Hostile privacy
   tests cover both log normalization and the API allowlist.
9. `src/cli/git-cmd.ts`: `ResolveOutput`, new `ResolveRefusalCode`, `emit`,
   `refusalMessage`, and `gitResolveCmd`; `sync-mutex.ts` owns the typed busy
   error. No new resolve text enters any diagnostics schema.
10. `src/cli/ambient-status.ts` adds optional `daemonVersion` to
    `AmbientDaemonStatusV1` and retains it in `parseStatus`.
    `src/cli/daemon-control.ts` updates `stopDaemon` using existing
    `isDaemonRunning`, `waitForExit`, `forceKill`, `daemonPidPath`, and
    `startDaemon`; `src/cli/autostart-cmd.ts` supplies `DesiredDaemonState` and
    `readDesiredDaemonRows`; `upgradeCmd` owns enumeration and per-workspace
    restart. `scripts/install.sh` stays binary-swap-only. Update
    `docs/DEPLOYMENTS.md`, release instructions, and `docs/diagnostics.md` for
    the operational and schema/privacy contracts.

## Acceptance

Required adversarial regressions:

- The full eight-cell legacy/new marker matrix.
- Prior-boot legacy main marker and prior-boot legacy `.reap`.
- Old daemon/new CLI skew presentation, pre-1.6.3 missing-version records, and
  the accepted cross-boot old-reader/downgrade starvation scenario.
- Two independent breakers racing on the same dead marker.
- Exact-token cleanup with marker replacement.
- Reaper-fence release failure.
- F3 restart/crash/ABA episode tests.
- Holder-key replacement with reused PID and distinct foreign markers.
- Capped-backoff shutdown and queued-wakeup tests.
- Missing, denied, malformed, transient, and hung platform-UUID commands.
- Client/API telemetry and doctor-schema round trips.
- Diagnostic privacy tests proving that paths, UUIDs, tokens, raw errors, and
  secrets never enter counts-only telemetry.

Also required:

- Identity command cases include ENOENT, EPERM/sandbox denial, timeout with
  SIGKILL, oversized output, independent-component failure, and recovery after
  a transient failure.
- F2 includes dead-marker success, create/verify failure with exact cleanup,
  indeterminate verification retained for next-acquire recovery, same-process
  contention, and the required real-process breaker race.
- Resolve tests cover every mapping row and hostile paths, credentials,
  newlines, controls, token-like text, and identical safe JSON/human semantics.
- The locality matrix covers every allowlisted Darwin/Linux type, NFS,
  SMB/CIFS, FUSE, unknown type, malformed result, and statfs error. Unproven
  locality never unlinks a foreign main marker or fence.
- An unknown-hostId marker on proven-local storage is tested with a dead PID,
  a recycled PID with different start time, and an alive PID with matching
  start time. The first two acquire within one pump cycle with no starvation
  increment; the last waits and reaches the closed `identity-drift` F3 surface.
- Ledger tests cover bounded/no-follow validation, corruption quarantine,
  transient unreadable preservation, durable-before-marker ordering,
  lock-serialized concurrent merges, duplicate boot-session merge, current
  pinning, equal-time tie-break, backward/forward clock steps, eight-entry
  eviction, and a crash after marker creation; a non-locking CLI invocation
  refreshes it.
- Reap tests replace the exact raw bytes on a new inode and independently
  change each of dev, inode, size, mtimeNs, and content between observation and
  unlink; every changed observation aborts without unlinking.
- Upgrade tests cover multiple live workspaces, preserved pull-only state, a
  live legacy runtime without desired state, 60-second timeout/SIGKILL,
  continue-on-error with final non-zero status, crash after swap and before
  restart, version-skew text/JSON, and installer binary-swap-only behavior.
- Forged lock-warning prefixes containing paths, UUIDs, tokens, credential
  URLs, CR/LF, and controls are normalized/dropped by `redactGitLogLines` and
  absent from `buildDiagnosticsBundle` and stored API reports; telemetry is
  separately asserted to contain only integer `lockStarved`.
- `bun test ./src/`, apps/api vitest, and typecheck are green modulo registered
  host flakes. The test rig or a dev build on the local fleet validates the
  design, not unit tests alone.
- On the incident Mac, a dev build (a) acquires over a synthetic legacy
  `kern.uuid` marker, (b) runs `rbox git resolve show-me` with daemon running
  (`sync-busy`) and stopped (success), and (c) surfaces a synthetic foreign
  marker through F3 without leaking its details.

## Out of scope

- No follow fallback for Git <2.46. Non-transactional symref updates would
  restore the torn-checkout class design 116 prevents; capability diagnosis
  and upgrade guidance are the answer.
- No general foreign-lock breaking. Reaping remains fence-gated and occurs
  only for a coherent historical same-host pair, or when proven-local storage
  plus the local PID/start-time probe establishes that the owner is dead.
