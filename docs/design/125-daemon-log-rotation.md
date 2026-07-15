# 125 — Daemon log rotation (daily files) + log diet

Status: DRAFT (review resolved; implementation pending)
Owner: founder request 2026-07-15 ("the logs in there are a week long and
running — probably time to design and implement log rotating on the local
daemon. daily files perhaps." + "probably somethings worth NOT logging?")

## Problem

`~/.rbox/daemons/<ws>/daemon.log` grows forever. Field numbers 2026-07-15:
Mac 44 MB / 370k lines over 8 days; desktop 9.3 MB. Byte breakdown on the
Mac:

- 33 MB (75%): `pump op pull: another sync is in progress; re-queued` every
  ~300 ms — **already fixed** by 118 F4's backoff (`shouldLog` gating);
  zero occurrences since the v1.6.3 daemon started. Historical, not a 125
  work item.
- 5.8 MB (13%): `rbox push/pull …` perf lines whose `repoMs=` blob carries a
  per-repo timing entry for all 101 repos (~3–4 KB per line, one line per
  sync, syncs every few minutes).
- Everything else is proportionate.

The existing `daemon.log` is also both a normal stream and inherited child
stdio. Rotation must separate those roles without hiding startup failures,
panics, or operational messages that currently bypass `daemon/render.ts`.

## Design

### 1. Daily files

#### Ownership and record protocol

- `runDaemon(root)` constructs one
  `RotatingDaemonLogger(root, clock, fs)` as its first action, before
  `buildAuthedRemote` or `loadState`. It injects the logger's bound synchronous
  sink into `RboxDaemon` and every downstream CLI/engine logging seam. There is
  no process-global configured logger: direct and concurrent `RboxDaemon` tests
  receive their own sink. Failures before construction are crash-sink-only by
  definition.
- The logger uses synchronous `openSync`/`writeSync`/`closeSync`, opens dated
  files with `O_APPEND`, and has no async queue. Each `log(message)` captures
  exactly one `Date`; that value supplies both the leading ISO timestamp and the
  UTC `daemon-YYYY-MM-DD.log` basename.
- A record is encoded once as one newline-terminated UTF-8 buffer. The normal
  path passes that complete buffer in one `writeSync` call; a short-write loop
  advances over the same buffer until complete. Records are synchronous and
  ordered within a process, and the successful full-buffer path is one
  `O_APPEND` syscall per record. The exceptional short-write path preserves the
  record within one process but cannot claim cross-process non-interleaving
  between retry syscalls; the native two-process guarantee and test apply to
  the OS full-buffer-write path. An injected-short-write test separately proves
  correct completion and failure handling.
- On a UTC date change, the writer closes the old fd before it opens or writes
  the new file. It never renames or truncates a dated file. The triggering
  record is the first ordinary record in the new file.
- `RboxDaemon.stop()` emits the final `rbox daemon stopped` record through the
  injected sink. `runDaemon` closes the logger only after that write and after
  shutdown work completes; a `try/finally` also closes it on construction/start
  failures after logger initialization. Close is idempotent and best-effort.

#### Multiple processes and crash channel

Launch serialization is explicitly out of scope. The log protocol tolerates
two daemons for one root on the native full-buffer path: records use one
`O_APPEND` syscall; dated files are never renamed or truncated; pruning
considers only non-current calendar dates; a concurrent `ENOENT` is benign; and
the child boot record contains both `bootId` and PID. A native two-process test
crosses UTC midnight while both writers log and prune, and proves intact
records, final-old/first-new presence, and safe concurrent pruning.

`daemon.log` is renamed conceptually and in helpers to the **crash sink**. The
launcher still opens it for inherited stdout/stderr, so runtime diagnostics,
uncaught failures, and Bun panics survive even if the dated writer fails. Before
opening it for a new boot, the launcher applies this startup-only guard:

1. If the regular `daemon.log` is larger than 5,000,000 bytes (5 MB), remove any
   `daemon.log.old`, rename `daemon.log` to `daemon.log.old`, and create a fresh
   append-only `daemon.log`. Exactly one old generation is kept.
2. Guard operations are best-effort; a concurrent `ENOENT` means another
   launcher completed the same transition. Other failures are emitted to the
   inherited sink if possible and never prevent daemon startup.

After **every** successful dated open (boot, rollover, or reopen), the logger
synchronously appends this leading-ISO pointer record to the crash fd before
the first record on the new fd:

`<timestamp> logs: basename=<basename> bootId=<bootId> pid=<pid>`

The timestamp and basename use the same `Date` that selected the open. An open
failure writes a timestamped failure diagnostic to the crash sink instead of a
pointer. On boot the child also writes an explicit dated-stream record:
`daemon boot bootId=<bootId> pid=<pid>`; this is distinct from the parent-printed
start message. The parent message becomes
`background sync started (process <pid>). view logs with: rbox logs`; it never
presents the crash-sink pathname as the live log.

The sink is best-effort and non-fatal. Each primary dated open/write and each
direct-fd crash fallback write is separately wrapped. A primary failure tries
the crash fd synchronously; a failure of both sinks is swallowed after one
at-most-once, non-recursive self-report attempt per logger lifetime. The sink
never throws or rejects. Pointer, diagnostic, and fallback ordering uses direct
fd writes—not `console.log` or buffered stream writes.

Every 60 seconds or 512 records, whichever comes first, the writer `fstat`s its
dated fd. If `nlink === 0`, it closes and reopens the current dated basename
before the next record, producing the pointer above; a reopen failure uses the
same fallback contract. `removeDaemonRuntime` remains post-exit-only:
`untrack` must prove graceful exit or complete its explicit force-kill/wait
path before removal. The link check separately handles manual unlink while a
daemon remains alive.

#### Bypass inventory and routing

The reviewer's reachable-bypass inventory is reproduced verbatim below. Every
OPERATIONAL row is routed through the injected logger; front-door/runtime fatal
rows intentionally remain on inherited stdio.

| Classification | Reachable bypass (verbatim) | Disposition |
| --- | --- | --- |
| FATAL | top-level rejected `runDaemon` errors through `fail` (`src/cli/index.ts:23-31`) | Inherited crash sink; this is the final rejection boundary. |
| OPERATIONAL | stream-mismatch warnings (`src/cli/config.ts:552-557`) | Injected daemon sink. |
| OPERATIONAL | E2EE applied-head lag (`src/cli/e2ee-remote.ts:683-688`) | Injected daemon sink. |
| OPERATIONAL | changing-file deferrals, including full path lists under `RBOX_DEBUG` (`src/cli/sync-recovery.ts:534-536`) | Injected daemon sink. |
| OPERATIONAL | publish-pipeline encryption churn (`src/cli/publish-pipeline/shared.ts:62-66`) | Injected daemon sink. |
| OPERATIONAL | recovered blob-integrity events (`src/cli/remote/blobs.ts:140-144`) | Injected daemon sink. |
| OPERATIONAL | downloader debug and liveness-watchdog output (`src/cli/remote/blob-batch/downloader.ts:13-15,138-143`) | Injected daemon sink. |
| OPERATIONAL | multipart metrics' default sink (`src/cli/remote/multipart-metrics.ts:37-41`) | Per-daemon injected/scoped sink; no process-global logger ownership. |
| OPERATIONAL | macOS bulk-walk warnings (`src/engine/darwin-bulk-walk.ts:84-90`) | Engine warning-sink seam supplied by the daemon. |
| OPERATIONAL | crypto worker fd-cap/spawn warnings (`src/engine/crypto-pool/config.ts:59-62`, `src/engine/crypto-pool/pool.ts:210-220`) | Engine warning-sink seam supplied by the daemon. |
| OPERATIONAL | git ref-equivalence warnings whose engine default remains `console.warn` (`src/engine/git/apply.ts:91,406,539`) | Propagate the daemon warning sink through `applyGitSections` to the existing engine seam. |
| FATAL | Bun/runtime diagnostics, panics, and uncaught failures bypass it as intended. | Inherited crash sink. |

The implementation audit also routes pull `laneTimingSummary()` and push
`uploadLaneTimingSummary()` (`RBOX_LANE_TIMING`) through the injected sink.
Process-import-time warnings that precede `runDaemon`, such as the API-base
override warning, are pre-logger and therefore crash-sink-only.

### 2. Retention

- Retention runs after a successful startup/rollover open. Candidate basenames
  must match anchored
  `^daemon-(\d{4})-(\d{2})-(\d{2})\.log$` and round-trip as a real UTC calendar
  date; junk, impossible dates, and future dates are not candidates.
- `lstat` must show a regular file. Symlinks and other file types are skipped.
  Immediately before unlink, re-`lstat` and require the same regular-file
  identity; replacement races are skipped. The logger never prunes its current
  basename, even if clocks disagree between processes.
- Age comes only from the filename's UTC date; mtime is not read. Retention `N`
  keeps today plus the prior `N - 1` UTC dates and removes eligible files with
  calendar age `>= N`. Only a concurrent `ENOENT` is benign; all other scan,
  `lstat`, and unlink failures are best-effort warnings through the logger.
- `RBOX_LOG_RETENTION_DAYS` defaults to 14. An absent value is silent. A present
  value must match strict unsigned base-10 positive-integer syntax and convert
  to a safe integer; zero, signs, whitespace, fractions, junk, infinity, and
  unsafe values are invalid. Invalid input emits one warning and uses 14. A valid
  value is clamped to `[1, 3650]`.

### 3. Readers

#### Shared source model

`rbox-paths.ts` owns a pure UTC dated-basename constructor and the renamed
`daemonCrashLogPath`; it performs no directory I/O. `daemon-control.ts` owns one
async shared resolver returning the crash sink, the greatest calendar-valid
dated basename not later than the resolver's current UTC date, and the legacy
in-workspace path when present. Selection is filename-date lexical/calendar
order, never mtime. A future-dated file is ignored until that UTC date. After a
clock rollback the writer may append to the older date again and the resolver
selects the greatest eligible date; no file is renamed or truncated.

The global crash sink is always a concurrent channel, not a fallback. This also
keeps a pre-125 daemon that writes its whole stream to global `daemon.log`
visible even when a stale dated file exists. An existing in-workspace legacy
source is also returned independently: a one-shot read includes its bounded,
source-marked tail because activity cannot be proven without waiting; follow
tracks identity and size growth rather than mtime and continues monitoring it
even when stale global files exist. A dated source becomes the preferred
operational source when it appears, but neither stale dated nor crash presence
can hide later legacy growth after a downgrade.

Default `rbox logs` reads the requested tail from the newest eligible dated file
and bounded 64 KiB tails from the crash sink and any in-workspace legacy file,
parses leading ISO timestamps, and stably merges timestamped records in
chronological order (crash, dated, then legacy on an exact tie, then source byte
offset). Non-ISO crash/runtime lines cannot be ordered reliably; they remain in
source order in visibly source-marked trailing blocks. Doctor uses the same
source model and byte bound before its existing redaction/truncation rules.

#### Follow state machine

`rbox logs --follow` polls crash and operational sources independently and
source-marks emitted bytes. Its initial display opens each resolved source,
`fstat`s and tails that same handle, records the actual ending offset and
identity, and hands those still-open handles to polling. Bytes appended during
initial display are therefore read from the saved offset—never skipped or
replayed. For each source it then:

1. opens first, then `fstat`s the handle; it never stats a pathname and then
   assumes the opened file is that object;
2. tracks source kind, basename, `(dev, ino)`, and a monotonically increasing
   local generation;
3. reads only up to the handle's observed size, loops on short reads, advances
   by actual `bytesRead`, emits only those bytes, and treats two unchanged polls
   as stable EOF;
4. on dated rollover, keeps the old handle until stable EOF, then promotes the
   new basename from offset zero. Because close-before-new-write is per writer,
   another allowed daemon may append to the old date later: every retired dated
   identity remains polled at its saved offset for the rest of the follow
   session (reopening only that identity as needed), so late-old bytes are still
   emitted with their source marker;
5. treats disappearance/recreation or same-path identity change as a new
   generation, and promotes crash-only→dated or legacy→dated when the resolver
   discovers the dated stream; and
6. closes every handle and removes timers/signal handlers in `finally`, including
   read errors and SIGINT/SIGTERM.

Follow with no source waits and discovers a subsequent boot. At entry it
captures the root's current workspace binding plus pid/binding `bootId`
generation. With no boot yet it may adopt the first consistent boot for the
captured workspace; after adoption, it exits rather than attaching to a new
boot generation. It also exits when untrack removes the binding, the workspace
binding changes, or pid/binding generations disagree. A root-derived
`workspaceKey` alone is never lifecycle authority.

#### Reader audit

All direct readers move to the source model:

- `sync-mutex.ts:readStarvationWarning` searches the resolved operational dated
  tail, not the quiet crash sink.
- `doctor-cmd.ts:daemonLogTail` merges bounded dated + crash input and retains
  its redaction guarantees.
- `scripts/rig/lib/capture.ts` and `scripts/rig/lib/device.ts` collect all valid
  dated files in calendar order plus the crash sink, with source separators;
  watcher classification consumes the combined operational stream.
- `contrib/swiftbar/rbox.5s.sh` and macOS RboxBar's `StatusReader` stop opening
  `daemon.log` as the live stream and use the resolved/`rbox logs` view.
- `docs/STATUS.md`, `docs/diagnostics.md`, rig comments, and surface specs stop
  presenting `daemon.log` as the ordinary daemon log.

The old `daemonLogPath` name is removed in favor of `daemonCrashLogPath` so new
callers cannot mistake the crash channel for the operational stream.

### 4. Log diet: cap `repoMs=`

The real seam is `formatGitApplyMetrics` in `src/cli/sync-git/apply.ts`.
Normal output keeps `repoMs=` bounded to at most eight deduplicated exemplars:
seed the slowest wall repo and slowest queue repo, add every non-`unchanged`
result in index order, then alternate remaining wall- and queue-ranked repos
until the cap. Ties use lower repo index; final exemplar rendering is by index.
The cap applies to the union, so anomalous results beyond available slots are
represented by result aggregates even when not all can be exemplars.

The line also includes all-repo nearest-rank p50/p95/max aggregates for
`queueMs` and `wallMs`. When `chainLength > 0`, it separately includes
p50/p95/max over that fresh-chain subset for `fetchDecryptMs`,
`bundleVerifyMs`, `gitImportMs`, and `indexOpStateMs`; zero chain objects from
steady repos do not dilute these distributions. Aggregate field order and
number rounding are fixed, and formatting works from copies/sorted index arrays:
`repoTimings` and nested `chain` objects are never mutated.

Truthy `RBOX_DEBUG` preserves the full current per-repo `repoMs=` line. The
daemon sees the value inherited in `startDaemon`'s environment, so changing it
requires a daemon restart.

This diet preserves the actual consumers: design 74 requires per-repo queue and
wall visibility for pull parallelism; design 83 used the 98-repo unchanged
distribution to expose a roughly 85–195 ms uniform subprocess floor and a queue
ramp toward 1.5 s; design 100 added fresh-chain decomposition. The bounded line
therefore retains queue, wall, result/group, and fresh-chain distribution
signals without retaining every exemplar. It makes no uploader-ceiling or
move-aside-incident claim.

## Non-goals

- No daemon launch serialization in this design.
- No compression, size-based rotation of dated files, or external logrotate
  configuration.
- No change to Cloudflare/API-worker logging.
- No structured/JSON migration; records remain ISO-prefixed plaintext.
- No thinning of the perf lines beyond the bounded `repoMs=` representation and
  aggregates above.

## Files

- `src/cli/daemon/render.ts`, `src/cli/daemon/daemon.ts`, and downstream
  CLI/engine seams — per-daemon rotating logger, injection, boot/stop lifecycle,
  warning routing, and native-Bun logger tests.
- `src/cli/daemon-control.ts`, `src/cli/rbox-paths.ts`, `src/cli/sync-mutex.ts`,
  `src/cli/doctor-cmd.ts` — crash-path rename, pure basename constructor, async
  source resolver, merged tails, follow state machine, and status/doctor tests.
- `src/cli/sync-git/apply.ts` — bounded exemplars and distribution aggregates.
- `scripts/rig/lib/capture.ts`, `scripts/rig/lib/device.ts`, rig watcher consumers,
  `contrib/swiftbar/rbox.5s.sh`, and `macos/RboxBar/**` — direct-reader migration.
- `docs/STATUS.md`, `docs/diagnostics.md`, related surface docs, and
  `docs/CODEMAP.md` if implementation adds a sync-engine module or changes a
  listed module's ownership.

## Acceptance

- Native `bun test` covers one-Date timestamp/basename selection, simultaneous
  synchronous calls, midnight close/open ordering, injected short writes,
  primary failure, simultaneous primary+fallback failure, idempotent close,
  pointer-on-every-open, initial-open failure, multi-day uptime, explicit boot
  and final-stop records, unlink-while-open recovery, and crash-sink 5 MB guard.
- A real two-process test performs rollover and concurrent prune against one
  runtime directory and proves every record intact, no dated rename/truncate,
  benign concurrent `ENOENT`, and both bootId/PID identities.
- Retention tests cover absent and every invalid/clamped env form; junk and
  impossible/future names; symlinks/non-regular files; old/future mtime
  irrelevance; current-basename protection; filename-date age; and
  disappearance/replacement races where only `ENOENT` is benign.
- Default logs/doctor tests cover crash-after-dated and fail-before-dated boots,
  merge ordering, non-ISO crash marking, bounds, and doctor redaction. Follow
  tests cover final-old + first-new, a second process's late-old append after
  promotion, gapless initial-tail handoff, crash-only→dated and legacy→dated
  promotion, downgrade-era legacy growth beside stale global sources,
  follow-before-start discovery, open-then-fstat replacement, short reads,
  disappearance/recreation, signal cleanup, untrack, binding change, and
  unrelated boot generation exit.
- Status reads starvation from a dated file. Rig capture/classification sees
  ordered dated files plus crash output across rollover. SwiftBar and RboxBar no
  longer present the crash sink as the live log.
- Formatter tests use immutable synthetic timings with more than eight repos and
  deterministic ties/results/chains. Aggregate-only assertions reproduce design
  83's uniform ~85–195 ms wall floor and queue ramp toward ~1.5 s. Normal output
  has at most eight exemplars; truthy `RBOX_DEBUG` has the full line.
- Field validation uses a daemon **pull** with more than eight repos, verifies
  the bounded line and queue/wall aggregates (plus chain aggregates when that
  pull contains `chainLength > 0`), then restarts with truthy `RBOX_DEBUG` and
  verifies full output. It also confirms the parent `rbox start` message points
  to `rbox logs`, while the child dated stream carries its boot record.
- The test rig or a dev build on the local fleet validates daily rollover,
  retention, merged `rbox logs`, follow promotion, crash visibility, and
  post-exit-only untrack cleanup; unit tests alone are insufficient.

## Review resolutions

| Finding | Disposition |
| --- | --- |
| F1 | Per-`runDaemon` logger constructed first, injected, and closed after final stop; pre-logger failures are crash-only. |
| F2 | Synchronous append fd, one-Date records, full-buffer writes with short-write completion, and no async queue. |
| F3 | No launch serialization; dated protocol and two-process rollover/prune test are multi-process-safe. |
| F4 | Verbatim bypass inventory classified; operational emitters use injected CLI/engine warning seams; crash sink is guarded. |
| F5 | Crash sink is a bounded concurrent channel merged with the dated stream, not a fallback reader. |
| F6 | Polled dual-channel follower drains old stable EOF and supports crash/legacy promotion. |
| F7 | Every successful dated open publishes basename, bootId, PID, and timestamp; failures publish diagnostics. |
| F8 | Anchored real-date names, regular-file `lstat`, current protection, filename age, and ENOENT-only race tolerance. |
| F9 | All direct readers are audited; helper renamed; pure basename constructor and shared async resolver are required. |
| F10 | Throttled `nlink === 0` detection reopens unlinked logs; runtime removal is post-exit-only. |
| F11 | Eight deterministic exemplars plus all-repo queue/wall and fresh-chain p50/p95/max preserve distributions immutably. |
| F12 | Calendar-valid async resolution defines future dates, rollback, and legacy/global-stream coexistence. |
| F13 | Follow opens before fstat, honors `bytesRead`, tracks identity/generation, and closes handles in `finally`. |
| F14 | Follow waits before start, adopts one boot, and exits on untrack, rebinding, or unrelated generation. |
| F15 | Primary and fallback direct-fd writes are wrapped, ordered, at-most-once self-reporting, and non-throwing. |
| F16 | Retention env parsing is strict positive safe base-10, clamped 1–3650, with one warning and default 14 on invalid input. |
| F17 | `formatGitApplyMetrics`, truthy inherited debug, and daemon-pull acceptance use the real seams. |
| F18 | Diet rationale now cites designs 74/83/100 and drops unrelated incident claims. |
| F19 | Start is parent-printed and points to `rbox logs`; the child emits an explicit dated boot record. |
