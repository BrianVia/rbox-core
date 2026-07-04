# 61 — Daemon autostart: survive a reboot without silently dropping sync

**Status:** draft — design only.
**Depends on:** design 01 (per-workspace daemon, shipped), design 29 (`start`/`stop`/`setup`, shipped), design 44/45 (rebind + mass-delete halt semantics, shipped). **Relates to** design 54 (workspace registry, unscheduled) — this doc ships the minimal slice of that registry it needs and no more.
**Explicitly out of scope:** crash-supervision / KeepAlive (§6), Windows Task Scheduler, root/system-wide daemons, and the full design-54 `rbox list` registry.

## 1. Problem

The daemon is per-workspace and lives only as long as its process does. `rbox start [path]`
spawns it detached + `unref` (`daemon-control.ts:308-313`) with a v2 pidfile carrying a
`bootId`; `rbox stop` SIGTERMs it (`daemon-control.ts:320-333`). There is **no**
launchd/systemd integration — the roadmap defers it explicitly (`roadmap.md:26`,
"systemd/launchd service install"). So a reboot, a laptop that sleeps and gets power-cycled,
or a `sudo shutdown` silently kills every daemon and nothing brings them back.

That silence is the bug. The setup wizard's Step 3 promises the opposite:

```
Keep this workspace syncing in the background?          setup-cmd.ts:85
  ✓ Background sync started. Stop anytime with `rbox stop`.
```

The user answers yes, closes the laptop, reboots a week later, and the "background sync"
they were promised is gone with no signal. `rbox status` will eventually show a stale
remote, but only if they think to run it. A sync tool that stops syncing on reboot and
doesn't say so is worse than one that never claimed to.

### 1.1 Registry reality (the thing this design must first establish)

There is **no machine-wide record of which workspaces are tracked, or which were running.**
Verified: every binding lives inside its own `<root>/.rbox/workspace.json`
(`config.ts`), and the only global state under `~/.rbox/` is `credentials.json`,
`e2ee/<acct>/`, `bin/` + `release.json`, and `daemons/<basename>-<hash8>/` (pid/log/
`workspace.bound`). Design 54 §2.1 already dissects why the daemons dir is **not** a
usable registry: its key is `workspaceKey(root)` = `<basename>-<sha256(absRoot)[:8]>`
(`daemon-control.ts:24-29`), and that hash is **one-way** — given the dir you cannot recover
the absolute path. `workspace.bound` records the workspace *id*, never the path. So today
nothing can answer "enumerate the tracked roots," which is exactly what a boot-time resumer
needs. **This design must add that primitive.** It adds the smallest possible version of it.

## 2. Decision

1. **New command `rbox autostart enable | disable | status`** — installs, removes, and
   reports a user-scope login item that resumes daemons after a reboot. Never installed
   silently.
2. **Platform login item, user-scope, no root:**
   - **macOS** — a LaunchAgent at `~/Library/LaunchAgents/to.rbox.daemon.plist`, `RunAtLoad`,
     `ProgramArguments = [<resolved ~/.rbox/bin/rbox>, __boot-resume]`.
   - **Linux** — a systemd *user* unit at `~/.config/systemd/user/rbox.service` enabled with
     `systemctl --user enable rbox.service`.
3. **New hidden token `rbox __boot-resume`** starts a daemon for **every workspace whose
   recorded desired-state is `running`** — so a reboot resurrects exactly what the user had
   running, nothing more.
4. **Desired-state is a per-workspace file** written on `start`/`stop`, keyed off the
   already-existing daemons dir. This is the minimal registry from §1.1.
5. **Setup wizard** offers autostart after the Step-3 "keep syncing?" yes (default yes, one
   line of explanation). It never installs a login item without asking.
6. **RunAtLoad-only, no KeepAlive** — the daemon owns its own halt semantics (§6); a
   supervisor that fought deliberate halts would mask the mass-delete guard.

## 3. Mechanism

### 3.1 Desired-state: the minimal registry (`~/.rbox/daemons/<key>/desired.json`)

Rather than stand up design 54's shared `workspaces.json` (a write-contended file, 54 §3.2),
autostart records desired-state as a **per-workspace file inside the daemon runtime dir that
already exists** — one file per workspace, no read-modify-write race, mirroring the daemons-dir
convention (and 54 §9 Q3's recommended fallback shape):

```jsonc
// ~/.rbox/daemons/<basename>-<hash8>/desired.json  (mode 600)
{ "rootPath": "/Users/via/code/app", "state": "running", "at": "2026-07-03T18:00:00Z" }
```

- `rbox start [path]` (`index.ts:462`) writes `state: "running"` **after** `startDaemon`.
- `rbox stop [path]` (`index.ts:466`) writes `state: "stopped"` — the dir survives a stop
  (`stopDaemon` removes only the pidfile), so the "user deliberately stopped this" fact
  persists across reboots. This is why stop records `stopped` rather than deleting the file.
- `setup` Step 3 "keep syncing? yes" flows through `startDaemon`, so it inherits `running`.
- `rbox untrack` already `rm -rf`s `~/.rbox/daemons/<key>` (`untrack-cmd.ts`, `removeDaemonRuntime`)
  — that deletes `desired.json` too, so an untracked workspace never auto-resumes. No new
  prune hook needed.

Crucially, storing `rootPath` here makes the one-way `workspaceKey` **reversible locally** —
the exact gap design 54 §2.1 names. A workspace that was only ever foreground-`sync`'d (never
`start`ed) has no runtime dir and thus no desired-state, and is correctly ignored by resume:
autostart only ever resurrects daemons the user explicitly started.

### 3.2 `rbox __boot-resume`

A hidden dispatcher case (alongside `__daemon-run`, `index.ts:564`). It:

1. **Guards on credentials** — if `loadCredentials()` has no `accountId`, log one line and
   exit 0. A logged-out machine's daemons would only fail `buildAuthedRemote` in a loop
   (`daemon.ts:828`); don't spawn them.
2. **Enumerates** `~/.rbox/daemons/*/desired.json`, keeps `state === "running"`, and for each
   reads `rootPath`. Rows whose `rootPath` or `<rootPath>/.rbox/workspace.json` no longer
   exists are skipped (stale — dir moved/`rm -rf`'d), matching design 54 §6's stat-based
   validation. No silent deletion; a later `autostart status` can report them.
3. **Calls `startDaemon(root)` per surviving row.** `startDaemon` is already idempotent and
   rebind-safe (`daemon-control.ts:263-297`) — a workspace whose daemon somehow survived is a
   no-op ("already running"); a rebound root restarts cleanly. Each daemon spawns detached +
   `unref` with a fresh `bootId` exactly as an interactive `start` would.

`__boot-resume` itself then exits — it is a one-shot resumer, not a long-lived supervisor.

### 3.3 macOS LaunchAgent

`autostart enable` writes `~/Library/LaunchAgents/to.rbox.daemon.plist` (label `to.rbox.daemon`,
reverse-DNS of `rbox.to`) and `launchctl load`s it:

```xml
<key>Label</key><string>to.rbox.daemon</string>
<key>ProgramArguments</key><array>
  <string>/Users/via/.rbox/bin/rbox</string><string>__boot-resume</string>
</array>
<key>RunAtLoad</key><true/>
<!-- deliberately NO KeepAlive — see §6 -->
```

`RunAtLoad` fires the job at login. It runs `__boot-resume`, which spawns the detached
daemons and returns; the launchd job completes. macOS lets the `unref`'d children outlive it.

### 3.4 Linux systemd user unit

`~/.config/systemd/user/rbox.service`:

```ini
[Unit]
Description=rbox background sync resume
[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process          # ← load-bearing: see below
ExecStart=%h/.rbox/bin/rbox __boot-resume
[Install]
WantedBy=default.target
```

`KillMode=process` is **not optional.** systemd's default `control-group` kill mode would
tear down the whole cgroup when the `oneshot` main process exits — killing the daemons
`__boot-resume` just spawned. `process` scopes teardown to the (already-exited) main pid and
lets the detached daemons live. `enable` runs `systemctl --user enable rbox.service`.

Note for headless servers that never interactively log in: systemd user units run only while
a session exists unless `loginctl enable-linger $USER` is set. That's an opt-in we *mention*
in `autostart status` output but do not run by default (it changes session lifetime machine-
wide) — a dev laptop logs in normally and needs no linger.

### 3.5 Setup wizard integration (Step 3)

After the existing `startDaemon` on "keep syncing? yes" (`setup-cmd.ts:85-88`), add one
prompt:

```
Resume syncing automatically after you reboot? [Y/n]        ← NEW, default YES
  ✓ Autostart enabled. Disable anytime with `rbox autostart disable`.
```

Default yes, one-line explanation, uses the same `autostart enable` primitive. Declining
leaves no login item. It is never installed without this explicit yes — the wizard already
routes every widget through `promptConfirm` (`setup-cmd.ts:85`), so this is one more.

## 4. Security & privacy

- **User-scope only, no root, no sudo.** LaunchAgent under `~/Library/LaunchAgents`; systemd
  `--user` unit under `~/.config/systemd/user`. Never a system-wide daemon or `/Library/`
  agent. The blast radius is the user's own account — the same boundary their shell rc already
  grants.
- **No secrets in the unit files.** The plist/unit carry only a binary path and the
  `__boot-resume` token. The daemon reads `~/.rbox/credentials.json` and the e2ee keystore at
  runtime; the only env passed to a spawned daemon is `RBOX_DAEMON_BOOT_ID`, set by
  `startDaemon` (`daemon-control.ts:311`), never by the plist.
- **Path integrity.** `ProgramArguments`/`ExecStart` point at `~/.rbox/bin/rbox`, which is
  user-writable — anyone who can write there already has login-time code-exec via the user's
  PATH, so autostart adds no new privilege. Enable **resolves the real path** and refuses to
  install if the binary is absent, so the login item never points at a dangling or symlinked
  target. The path is stable across `upgrade` (design 14 replaces the binary in place with
  `mv -f`, `install.sh:46`), so an upgraded binary keeps working without re-enabling.
- **`desired.json`** stores absolute local paths under the already-`0700` `~/.rbox`. Local-
  only, never synced to the server — same posture as design 54 §8 (syncing local paths would
  leak machine layout for no product benefit).
- `__boot-resume` opens no network port; it only re-spawns the existing daemon binary.

## 5. Uninstall & logout

- **`rbox autostart disable`** `launchctl unload`s + removes the plist (macOS) /
  `systemctl --user disable` + removes the unit (Linux). Desired-state files are left intact
  — disabling autostart shouldn't forget which workspaces were running, so a later re-enable
  restores the same set.
- **`rbox untrack`** already removes the whole `~/.rbox/daemons/<key>` dir, so it drops that
  workspace's desired-state for free (§3.1).
- **`rbox logout` — out of scope to auto-disable** (matches design 54 §5.2: state should
  reflect *what is tracked*, not *what is authenticated*). But because `__boot-resume` guards
  on credentials (§3.2 step 1), a logged-out machine's autostart is a harmless one-line no-op
  rather than a crash-loop. `logout` **should print a hint** — "autostart is still enabled;
  daemons resume when you log back in" — so the interaction isn't invisible. Auto-disabling on
  logout is deferred.

## 6. Why RunAtLoad-only, not KeepAlive

The daemon already has crash-halt semantics from designs 44/45. On a mass-delete-guard refusal
it **records a `halt` and keeps the process alive** (`daemon.ts:326-355`), backing off — it
does *not* exit. The only things that exit the process are SIGTERM/SIGINT (`daemon.ts:831-836`,
graceful `stop`) and a hard startup failure like corrupt state (`loadState` throws before the
loop, `daemon.ts:829`).

A KeepAlive supervisor would therefore do exactly the wrong thing at each:

- **On `rbox stop`** (SIGTERM → `exit(0)`): KeepAlive would instantly relaunch the daemon,
  fighting the user's deliberate stop.
- **On a corrupt-state exit:** KeepAlive would hot-loop restart a daemon that cannot start.
- **If a future safety mechanism ever chose to *exit* on a detected mass-delete** (instead of
  today's in-process halt), KeepAlive would resurrect it in a loop and **mask the very guard
  that saved 8,603 files** (the 2026-07-01 rebind incident, design 44).

RunAtLoad-only resumes what the user had running *at boot* and then gets out of the way —
respecting `stop`, respecting halts, respecting startup failures. Crash-supervision, if ever
wanted, is a separate design that must first reconcile with the halt state machine.

## 7. Test plan

- **Unit — login-item generation (pure, no FS).** A `buildPlist(binaryPath)` /
  `buildSystemdUnit(binaryPath)` string builder, tested like `workspaceFlags`
  (`setup-cmd.ts:39`) and `nextSafetyDelay` (`daemon.ts:851`): assert label
  `to.rbox.daemon`, `ProgramArguments`/`ExecStart` = resolved binary + `__boot-resume`,
  `RunAtLoad` present, **no `KeepAlive` key** / systemd has **no `Restart=`** and
  **`KillMode=process`**. The absence assertions are the ones that protect §6.
- **Unit — desired-state bookkeeping.** Under a temp `RBOX_HOME` (the existing test pattern,
  `daemon-binding.test.ts:27`): `start` writes `running`, `stop` writes `stopped`, `untrack`
  removes the file, and the enumerator returns exactly the `running` roots (and skips a row
  whose `rootPath` was deleted).
- **Rig scenario — `__boot-resume` without a reboot.** The rig can't easily reboot a
  container, so test the resume logic directly: track two workspaces, `start` both, `stop` one
  (so desired-state is `running`,`stopped`), then **kill the daemon pids read from their
  pidfiles** to simulate a reboot wiping them, run `rbox __boot-resume`, and assert
  `isDaemonRunning` is true for the `running` workspace and false for the `stopped` one.
  Kill only the two rbox daemon pids from the pidfiles — never a broad `pkill -f` (standing
  ops lesson: concurrent agents must not blanket-kill by pattern).
- **Rig scenario — logged-out no-op.** With credentials cleared, `__boot-resume` starts
  nothing and exits 0.

## 8. Out of scope

- **Crash-supervision / KeepAlive / `Restart=always`** — deferred; must reconcile with the
  halt state machine first (§6).
- **The full design-54 registry and `rbox list`.** Autostart ships only the per-workspace
  `desired.json` slice it needs. If design 54 lands, desired-state can fold into
  `workspaces.json` as a field — but per-workspace files avoid its write-contention (54 §3.2)
  and don't block on it.
- **Windows** (no launchd/systemd; Task Scheduler is a separate design).
- **`loginctl enable-linger`** for headless-server autostart-while-logged-out — mentioned in
  `status` output, not run by default.
- **Root / system-wide / multi-user daemons.**
- **Auto-disable of autostart on `logout`, or any remote kill-switch.**
