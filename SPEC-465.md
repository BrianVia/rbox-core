# SPEC-465 — `rbox start`: name the running daemon, confirm the witness yourself

Implementation spec for issue #465 ("rbox start: detect already-running daemon
(incl. dev/release mismatch) and self-confirm witnessed mode"), papercuts entry
`## \`rbox start\` over a running daemon reports ambiguous half-success (2026-07-26)`.

Everything below is anchored to `main` @ `f0650870`. All paths are repo-relative.

---

## 0. Root cause (read this first — it changes the whole fix)

The reported symptom is "the spawned daemon loses the single-instance lock and
exits". That is **not** what happens. There is no flock/pidfile mutex the child
can lose: the daemon's "single instance" mechanism is the pidfile **boot id**
(`src/cli/daemon/daemon.ts:2700` `canPersistTrustedSurface`,
`src/cli/daemon/daemon.ts:2709` `canPersistAmbientStatus`,
`src/cli/daemon/daemon.ts:2724` `beginOwnershipWindDown`) — an incarnation that
finds a v2 pidfile carrying a *different* boot id drains and stops.

What actually happens on the founder's fleet (all hosts run dev builds — see the
`fleet-runs-dev-builds` memory) is:

1. A dev build's version is `"<pkg>-dev+<shortSha>[.dirty]"`
   (`scripts/dev-install.ts:25` `devVersion`), e.g. `1.9.1-dev+514d689`.
2. The daemon stamps that string into its ambient status record as
   `daemonVersion` (`src/cli/daemon/ambient-status.ts:278`).
3. `parseStatus` rejects the **entire record** when `daemonVersion` fails
   `validDaemonVersion` (`src/cli/daemon/ambient-status.ts:352`, validator at
   `:76`), which calls `parseSemver`.
4. `parseSemver`'s regex is
   `^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$` (`src/cli/semver.ts:11`) —
   it has **no build-metadata (`+…`) branch**, and `+` is not in the prerelease
   character class. So `parseSemver("1.9.1-dev+514d689")` throws.

Verified in this worktree:

```
$ bun -e 'import {validDaemonVersion} from "./src/cli/daemon/ambient-status.ts";
          console.log(validDaemonVersion("1.9.1-dev+514d689"))'
false
```

Consequence: on **every dev build**, `readAmbientDaemonStatusRecord` is
permanently `{kind:"corrupt"}`, so `readDaemonModeWitness`
(`src/cli/daemon/process-control.ts:163`) can never return `known`. Therefore:

- the post-spawn 15 s poll (`process-control.ts:327`) always times out and prints
  the line from the issue (`process-control.ts:334`);
- the live-daemon "pending" branch (`process-control.ts:274`) always prints its
  "re-run" twin;
- `promotePendingModeIntent` (`src/cli/autostart-cmd.ts:488`) can never promote,
  so a `pendingModeIntent` recorded by one `rbox start --pull-only/--read-write`
  is sticky forever and every later bare `rbox start` resolves intent
  `"pending"` (`autostart-cmd.ts:238`) and hits that branch;
- `rbox status` never shows the daemon version or the skew warning on dev builds
  (`src/cli/status-cmd.ts:373`, `:381`, `:850`);
- **`rbox stop` loses its graceful-drain witness** (`process-control.ts:402`
  requires a parsed record whose `daemonVersion === RBOX_VERSION`), so a dev
  daemon that is mid critical section gets `SIGKILL`ed after 60 s instead of
  being waited on. This is a live-fleet safety regression, not just cosmetics.

So the fix is three parts: (A) make dev versions parse, (B) name the running
daemon (pid + version + mode, and call out a version mismatch), (C) never tell
the user to re-run — poll, then report a terminal, actionable outcome.

---

## 1. Objective

With a daemon already running for the workspace, `rbox start` must say so
immediately and identify it — `background sync is already running (process 4711,
v1.9.1-dev+514d689, read-write)` — plus a mismatch line when the running daemon's
version differs from the invoking binary's. When `rbox start` genuinely spawns a
daemon, the CLI polls the witness record itself and prints a terminal outcome.
The strings `re-run \`rbox start\` in a moment` must not survive anywhere in the
start path (founder rule: minimize user typing).

Non-goal: changing the `StartDaemonResult` union, the desired-state bookkeeping
in `autostart-cmd.ts`, or the ambient-status schema.

---

## 2. Current behavior (anchors)

Start path:

- `rbox start` dispatch: `src/cli/main-dispatch.ts:404-425` → `startDaemonAndRecordDesired`.
- Desired-state wrapper: `src/cli/autostart-cmd.ts:300` `startDaemonAndRecordDesiredImpl`
  (mode resolution `:230` `resolveStartMode`; callbacks `onLive` `:379`,
  `onSpawned` `:380`, `onModeWitness` `:399`; result handling `:418-445`).
- Actual start: `src/cli/daemon/process-control.ts:240` `startDaemon`.
  - liveness pre-check: `:242` `readPid` → `:243` `isOurDaemon`
  - workspace-rebind restart: `:249-267`
  - already-running branch: `:268-280` (the two user-visible lines)
  - stale pidfile cleanup: `:281-284`
  - spawn: `:286-316` (`clearDaemonStartupState` `:291`, `publishDaemonPidRecord` `:312`)
  - post-spawn witness poll: `:327-336`
  - success line: `:339`

Single-instance / liveness primitives (reuse these; do not invent new ones):

- pidfile `~/.rbox/daemons/<basename>-<sha8>/daemon.pid`, `v2 <pid> <bootId>` —
  `src/cli/rbox-paths.ts:43-49` (`workspaceKey` `:32`), read/write in
  `src/cli/daemon/runtime-state.ts:125-139`.
- process ownership: `src/cli/daemon/process-control.ts:61` `readDaemonCommand`
  (`ps -p <pid> -o command=`), `:68` `daemonProcessMatches` (marker
  `__daemon-run` + root substring), `:83` `isOurDaemon`, `:94` `isDaemonRunning`.
- workspace binding (stale-daemon detection): `runtime-state.ts:69`
  `recordDaemonBinding` / `:77` `readDaemonBinding`; written by the daemon at
  `daemon.ts:2694` `writeStartupBinding`.
- boot-id ownership wind-down (the real "single instance" rule):
  `daemon.ts:2700`, `:2709`, `:2724`.

Witness machinery:

- ambient status file `daemon.status.json` (`rbox-paths.ts:44`), schema
  `AmbientDaemonStatusV1` `src/cli/daemon/ambient-status.ts:43` — carries
  `daemonVersion`, `mode`, `bootId`, `heartbeatAt`; written every
  `AMBIENT_STATUS_HEARTBEAT_MS = 5_000` (`src/cli/populate-marker.ts:5`),
  stale after `3×` that.
- **"witnessed" means exactly**: the status record parses, its `bootId` equals
  the *v2* pidfile's `bootId`, and it carries a `mode` —
  `process-control.ts:163` `readDaemonModeWitness`. Modes are
  `DaemonMode = "pull-only" | "read-write"` (`ambient-status.ts:30`). It
  witnesses **which mode this exact daemon incarnation booted in**, nothing else.
- bounded poll helper (already exists, reuse it):
  `process-control.ts:195` `waitForDaemonModeWitness` (has `daemonOwned` and
  `sleep` seams); timeout `DAEMON_MODE_WITNESS_TIMEOUT_MS = 15_000` (`:156`).
- mode admission: `process-control.ts:181` `admitLiveDaemonMode`.

How the CLI already learns the daemon version (copy this pattern):
`src/cli/status-cmd.ts:368-381` — read `readAmbientDaemonStatusRecord(root)`,
require `record.kind === "ok"`, gate the version on `validDaemonVersion`, and
gate `mode` on `record.status.bootId === alive.bootId`. Rendering helper
`runningDaemonLabel` at `status-cmd.ts:325`; skew warning copy at `:851` and
`src/cli/status-view.ts:736`.

Existing already-running detection elsewhere (nothing new needed):
`rbox stop` — `process-control.ts:343` `stopDaemon` (`:358` "not running",
`:363` leftover-record cleanup, `:414` SIGKILL line).
`rbox upgrade` — `src/cli/upgrade-cmd.ts:112-170` walks `~/.rbox/daemons/*/daemon.pid`,
filters with `isDaemonProcess`, and skips current-version daemons via
`readAmbientDaemonStatusRecord(root).status.daemonVersion === RBOX_VERSION` (`:150`).

---

## 3. Current user-facing copy in the start path (exhaustive)

`src/cli/daemon/process-control.ts`, all via bare `console.log`:

| line | string |
|---|---|
| 252 | ``background sync (process ${existing}) was serving workspace ${bound}, but this folder is now ${current} — restarting`` |
| 264 | ``the previous background sync (process ${existing}) hasn't exited yet — re-run \`rbox start\` in a moment`` |
| 274 | ``background sync (process ${existing}) is running, but its mode is not witnessed yet — re-run \`rbox start\` in a moment`` |
| 278 | ``background sync already running (process ${existing})`` |
| 314 | ``background sync did not report a process id — re-run \`rbox start\` in a moment`` |
| 334 | ``background sync (process ${child.pid}) started, but its mode is not witnessed yet — re-run \`rbox start\` in a moment`` |
| 339 | ``background sync started (process ${child.pid}). view logs with: rbox logs`` |
| 178 (thrown) | ``${detail}; restart required: rbox stop && rbox start ${modeFlag(requested)}`` where detail is `the live daemon is <mode>` or `the live daemon's mode is unknown` |

No test asserts any of these strings today (`grep -rl "background sync already running"` →
only `process-control.ts` and `docs/papercuts.md`).

---

## 4. Required changes

### 4A. Make dev-build versions parse (`src/cli/semver.ts`)

Accept semver build metadata and ignore it for precedence (semver §10).

- Change `RE` to `^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`.
- Add `build: string | null` to the `SemVer` interface and populate it.
- `semverGt` must **not** consider `build` (unchanged comparison logic).
- Keep `.trim()` and the anchors: `"1.6.3\nforged"` must still throw
  (regression asserted by `src/cli/daemon/ambient-status.test.ts:365`).

Nothing else changes: `validDaemonVersion` (`ambient-status.ts:76`) keeps its
80-char cap and now accepts `1.9.1-dev+514d689`, which un-breaks the witness,
`rbox status` version display, `promotePendingModeIntent`, `rbox stop`'s
graceful-drain witness, and `rbox upgrade --stale-only` on dev builds.

### 4B. Harden daemon-process matching (`process-control.ts:61`)

`readDaemonCommand` runs `ps -p <pid> -o command=`. On macOS `ps` truncates its
output to the terminal width, and to ~80 columns when stdout is a pipe (which it
always is here, via `execFileSync`). A dev daemon's command line
(`/Users/via/.local/bin/rbox-dev __daemon-run /Users/via/…/workspace`) routinely
exceeds that, so `cmd.includes(root)` can be false for a perfectly live daemon —
`startDaemon` then treats the pidfile as stale, deletes it, and spawns a second
daemon whose fresh boot id evicts the first (`daemon.ts:2724`). One flag fixes it:

```ts
return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
```

`-ww` is accepted by both BSD/macOS `ps` and procps (verified on this Linux host).
Do not change `daemonProcessMatches`'s predicate or its single-read contract
(frozen by `src/cli/daemon-control.test.ts:4`).

### 4C. Identify the running daemon, and surface version mismatch

Add two **pure, exported** helpers to `process-control.ts` (exported so they are
testable; re-export both from `src/cli/daemon-control.ts` and add them to the
sorted key list in `src/cli/daemon-control-surface.test.ts:35`):

```ts
/** "process 4711, v1.9.1-dev+514d689, read-write" — unknown parts are omitted. */
export function formatDaemonProcessLabel(pid: number, version?: string, mode?: DaemonMode): string;

/** Undefined when the versions match. */
export function daemonVersionSkewLine(daemonVersion: string, cliVersion: string): string | undefined;
```

`formatDaemonProcessLabel` joins the present parts with `", "`, mirroring
`runningDaemonLabel` (`status-cmd.ts:325`) but pid-first.

Add a private reader that resolves the live daemon's identity from the primitives
already listed (no new files, no schema change):

```ts
function liveDaemonIdentity(root: string): { version?: string; mode?: DaemonMode } {
  const pidfile = readDaemonPidRecord(root);
  const record = readAmbientDaemonStatusRecord(root);
  if (record.kind !== "ok") return {};
  const bootBound = pidfile.version === "v2" && pidfile.bootId !== undefined
    && record.status.bootId === pidfile.bootId;
  return {
    ...(validDaemonVersion(record.status.daemonVersion) ? { version: record.status.daemonVersion } : {}),
    ...(bootBound && record.status.mode !== undefined ? { mode: record.status.mode } : {}),
  };
}
```

Version is reported whenever it parses (a live-but-not-boot-bound record still
names the binary that wrote it); **mode is reported only when boot-bound**, which
is the existing witness rule and must not be loosened.

### 4D. Rewrite the start outcomes (`startDaemon`, `process-control.ts:240`)

Add to `StartDaemonOptions` (`:141`):

```ts
  /** Output seam; defaults to console.log. Mirrors StopDaemonDeps.log (:127). */
  log?: (line: string) => void;
  /** Test seam for process ownership; defaults to the ps-backed isOurDaemon. */
  daemonOwned?: (pid: number, root: string) => boolean;
```

Route **every** `console.log` in `startDaemon` through `log`, and every ownership
check (`:243`, `:256`, `:321`, and the one passed into `waitForDaemonModeWitness`)
through `daemonOwned`.

Behavior changes, branch by branch:

1. **Already-running, witnessed, mode matches** (`:277-279`) — replace `:278` with
   the identified line plus an optional skew line (see §5).
   Result stays `"already-running"`.
2. **Already-running, mode unknown, intent `preserve`/`explicit`** — same
   identified line (mode omitted); `explicit` still throws
   `modeRestartRequired` from `admitLiveDaemonMode` (unchanged).
   Result stays `"already-running-unknown-mode"`.
3. **Already-running, intent `pending`, witness unknown** (`:273-276`) — no
   longer an instant "re-run". First **poll**: when the pidfile is v2 with a
   boot id, `await waitForDaemonModeWitness(root, pidfile.bootId, timeout, poll,
   { daemonOwned })` and re-run `admitLiveDaemonMode` on the result. Only if it
   is still unknown, print the "couldn't confirm" line (§5) and return
   `"retry-later"` exactly as today. A legacy/absent boot id skips the poll and
   goes straight to that line.
4. **Spawn path timeout** (`:333-336`) — after the existing poll fails, classify
   before printing, using the primitives above:
   - pidfile is v2, still names `child.pid`+`bootId`, and `daemonOwned(child.pid, root)`
     → the daemon is alive but slow: print the "still starting up" line.
   - pidfile now names a *different* live rbox daemon → our child lost the boot-id
     race: print the already-running line for **that** pid (with its version), so
     the user learns a daemon owns the workspace.
   - otherwise (child gone) → print the "exited right after starting" line.
   All three keep returning `"retry-later"` (autostart's bookkeeping at
   `autostart-cmd.ts:429` depends on the value, not the copy).
5. **Success** (`:339`) — include the identity: version+mode come from the
   witness we just obtained (`witness.mode`) and `liveDaemonIdentity`.
6. `:264` and `:314` — drop the "re-run" tail, keep them terminal and actionable.

Do **not** change: the `StartDaemonResult` union (`:135`), which result each
branch returns, the workspace-rebind restart logic (`:249-267`), the
`onLive`/`onSpawned`/`onModeWitness` call order, or `modeRestartRequired`'s
message (frozen by `src/cli/daemon-control-mode.test.ts:42`).

---

## 5. Exact new strings

House style: lowercase, no jargon, one concrete next command, never "re-run
`rbox start`". `v` prefixes the version as in `rbox status`.

```
background sync is already running (process 4711, v1.9.1-dev+514d689, read-write)
background sync is already running (process 4711, v1.9.1)
background sync is already running (process 4711)
```
(one line; parts omitted when unknown — `formatDaemonProcessLabel`)

Version mismatch (printed as an extra line right after any already-running line,
only when the daemon's version differs from this binary's — `daemonVersionSkewLine`):

```
this rbox is v1.9.1 but the running background sync is v1.9.1-dev+514d689 — restart it to catch up: rbox stop && rbox start
```

Spawn succeeded and was witnessed (replaces `:339`):

```
background sync started (process 4711, v1.9.1-dev+514d689, read-write). view logs with: rbox logs
```

Live daemon whose mode could not be confirmed within the bounded wait
(replaces `:274`):

```
background sync is running (process 4711, v1.9.1) but rbox could not confirm its mode within 15s — check it with: rbox status
```

Spawned daemon still not witnessed after the bounded wait, child alive and owns
the pidfile (replaces `:334`):

```
background sync (process 4711) is still starting up — it keeps going in the background; check it with: rbox status
```

Spawned daemon lost the workspace to another daemon:

```
another background sync already owns this workspace (process 3900, v1.9.1) — the one just started stood down
```

Spawned daemon exited before witnessing:

```
background sync exited right after starting — see what happened with: rbox logs
```

Rewrites of the remaining two "re-run" lines:

```
the previous background sync (process 4711) has not exited yet — start again once it does: rbox status
background sync did not report a process id — nothing started; check for errors with: rbox logs
```

---

## 6. Files to touch

| file | change |
|---|---|
| `src/cli/semver.ts` | build-metadata support in `RE` + `SemVer.build`; `semverGt` unchanged |
| `src/cli/daemon/process-control.ts` | `-ww`; `log`/`daemonOwned` options; `formatDaemonProcessLabel`, `daemonVersionSkewLine`, `liveDaemonIdentity`; the branch rewrites in §4D and copy in §5 |
| `src/cli/daemon-control.ts` | re-export the two new helpers (keep the alphabetical grouping) |
| `src/cli/daemon-control-surface.test.ts` | add the two names to the sorted key list at `:35` |
| `src/cli/upgrade.test.ts` | new semver cases (§7) |
| `src/cli/daemon-control-mode.test.ts` | dev-version witness regression + new copy tests (§7) |
| `docs/papercuts.md` | mark the 2026-07-26 entry resolved (append the fix, do not delete) |
| `CHANGELOG.md` | `[Unreleased]` entry |

**Do not touch**: `src/cli/autostart-cmd.ts` (desired-state/pending-intent
bookkeeping is orthogonal and heavily tested), `src/cli/daemon/daemon.ts`
(ownership wind-down is correct), `src/cli/daemon/ambient-status.ts` schema or
`validDaemonVersion`'s contract, `src/cli/status-cmd.ts` / `status-view.ts` copy,
`stopDaemon`, `apps/**`, `src/cli/rbox-paths.ts`. Do not add a process-table scan
(`ps -A`/`pgrep`) — the pidfile + `-ww` ownership read is sufficient and is the
primitive the rest of the codebase already trusts.

---

## 7. Acceptance

Every command run from the repo root.

```sh
bun test src/cli/upgrade.test.ts
bun test src/cli/daemon-control-mode.test.ts src/cli/daemon-control.test.ts \
        src/cli/daemon-control-surface.test.ts src/cli/daemon-spawn.test.ts \
        src/cli/daemon-stop.test.ts src/cli/main-dispatch-start.test.ts
bun test src/cli/daemon/ambient-status.test.ts src/cli/status-cmd.test.ts \
        src/cli/status-view.test.ts src/cli/autostart-cmd.test.ts \
        src/cli/upgrade-daemons.test.ts src/cli/credential-policy.test.ts
bun run typecheck
bun run guards
bun test ./src/ ./scripts/gc-drain.test.ts     # full suite before handing back
```

New tests (fixture patterns already in the repo — reuse them, don't invent):

- **Fake daemon/pidfile/status**: `src/cli/daemon-control-mode.test.ts:19-31`
  — `mkdtemp`, set `process.env.RBOX_HOME`, `mkdir(daemonRuntimeDir(root))`,
  then write `daemonPidPath(root)` as `"v2 123 boot-live\n"` and
  `daemonStatusPath(root)` via its local `writeStatus` helper (`:68`).
- **Fake process ownership**: inject a reader, as
  `src/cli/daemon-control.test.ts:4` does for `daemonProcessMatches`, or the new
  `daemonOwned` option for `startDaemon`.
- **Fake witness timing**: the `{ daemonOwned, sleep }` deps of
  `waitForDaemonModeWitness` (`daemon-control-mode.test.ts:95-124`).

Required assertions:

1. `parseSemver("1.9.1-dev+514d689")` parses; `build === "514d689"`;
   `parseSemver("0.9.1-dev+03ff993.dirty")` parses;
   `semverGt("1.9.1", "1.9.1-dev+514d689") === true`;
   `semverGt("1.9.1+a", "1.9.1+b") === false` (build ignored);
   `parseSemver("1.6.3\nforged")` still throws; `parseSemver("1.2")` still throws.
2. **Dev-version witness regression** (the #465 root cause): write a status
   record with `daemonVersion: "1.9.1-dev+514d689"`, boot-bound to a v2 pidfile,
   `mode: "read-write"` → `readDaemonModeWitness(root)` is
   `{kind:"known", mode:"read-write", bootId:…}`. This test must fail on `main`.
3. `startDaemon` with a live, owned, boot-bound, witnessed daemon (`daemonOwned:
   () => true`, pidfile+status written) logs exactly
   `background sync is already running (process 123, v1.9.1-dev+514d689, read-write)`,
   logs no line containing `re-run`, spawns nothing, and returns
   `"already-running"`.
4. Same setup with a daemon version different from `RBOX_VERSION` also logs the
   `daemonVersionSkewLine` string; with an equal version it logs no second line.
5. Intent `"pending"` + unwitnessed live daemon: the witness appears during the
   poll → returns `"already-running"`/`"matched"` admission without printing the
   "could not confirm" line; witness never appears → prints the 15s line and
   returns `"retry-later"`.
6. Guard test: `grep` over `src/cli/daemon/process-control.ts` finds no
   ``re-run `rbox start` `` occurrence (cheap freeze; keep it in
   `daemon-control-mode.test.ts`).

Field validation (dev fleet, after CI is green — dev build, not a release):
`bun scripts/dev-install.ts`, then in a real workspace run
`rbox start` twice (second must print the identified already-running line),
`rbox stop && rbox start` (must print the witnessed `started (…)` line within
15 s), and `rbox status` (must now show `running (v…-dev+…, <mode>)`).

---

## 8. Edge cases the implementation must get right

- **Stale pidfile, dead daemon**: `readDaemonPidRecord` returns a pid whose
  process is gone or is not ours → existing `:281-284` cleanup path, then a
  normal spawn. Unchanged; do not report "already running" from a pidfile alone.
- **PID reuse**: never trust the pid without `daemonOwned` (marker + root match);
  re-check ownership immediately before any signal, as `:256` already does.
- **Legacy (non-v2) pidfile**: no boot id → witness is unknown by construction
  (`:165`). Report pid (and version if the status record parses) but never a mode,
  and never poll for a boot-bound witness.
- **Corrupt/absent status file**: `liveDaemonIdentity` returns `{}` → the short
  form `(process N)`. Never fail start because status is unreadable.
- **Boot-id mismatch between status and pidfile**: the record belongs to a
  previous incarnation → version may be shown, mode must not.
- **Mode mismatch** (`pull-only` vs `read-write`): unchanged — `admitLiveDaemonMode`
  throws `…restart required: rbox stop && rbox start --pull-only|--read-write`.
  Do not soften it into a log line; the desired-state machinery relies on the throw.
- **Workspace rebind**: `:249-267` (daemon bound to a different workspace id)
  still takes precedence over any already-running reporting — it must run first.
- **Unknown binding (pre-binding daemon)**: "can't tell" ≠ stale (`:248`).
- **Clock/heartbeat staleness**: do not add a heartbeat-freshness gate to the
  already-running decision; process liveness plus boot-bound witness is the
  existing contract, and a busy daemon can lag its heartbeat.
- **Concurrent starts**: two `rbox start`s can race between the pidfile read and
  `publishDaemonPidRecord`. The loser's child stands down via the boot-id rule;
  §4D case 4b is exactly that outcome and must report the winner's pid, not an
  error.
- **`--pull-only` on a legacy live daemon**: intent `explicit` + unknown witness
  still throws (`:191`), and on dev builds this becomes reachable-and-correct for
  the first time once 4A lands.
