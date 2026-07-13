# 88 - Ambient sync status: prompt segment and menu bar

Status: Draft v1, product-surface design. Client-only; no sync-engine behavior
change. Phase 1 is the shell prompt, phase 2 is a SwiftBar/xbar MVP, and phase
3 native macOS is parked.
Origin: founder incident on 2026-07-08 plus the post-design-82/83 realization
that rbox's passive-sync pitch still requires active attention to inspect.
Related: design 45 activity sidecar, design 46 shell integration, design 59
daemon attribution, design 73 byte progress, design 82 phase reports, design 83
git-plan cache, and design 85 daemon delegation/socket future.

This specifies the smallest compatibility surface that makes daemon death,
degraded sync, and live progress visible without asking the daemon a question.

## 1. Product problem and evidence

1. **rbox's pitch is passive sync, but the current trust surface is active.**
   The reliable answer is `rbox status`, and `statusCmdWithDeps` is a real
   inspection command: it loads credentials/config/state, checks daemon binding,
   reads activity, may probe remote state, and can fall back to manifest scan and
   git divergence work (`src/cli/status-cmd.ts:202-304`). That is appropriate
   for inspection; it is wrong as the only way to know whether passive sync is
   healthy.
2. **The trust model is inverted.** When sync is healthy, users should stop
   thinking about it. When the daemon is dead or degraded, the product must tell
   them first. On 2026-07-08 a wedged 14-hour-old stray daemon was found on the
   founder's Mac, silently racing newer daemons all day. The bug class was not
   "green was not green enough"; it was "nothing ambient became wrong."
3. **Dropbox's menu bar icon is the canonical product fix.** The value is not
   merely `green = good`. The value is that the user knows within seconds when
   sync is not good. Ambient glanceability is what lets users stop thinking
   about sync.
4. **rbox already has one ambient terminal surface, but not this data source.**
   Design 46 ships zsh hooks where `chpwd` finds the workspace, `precmd`
   updates `RBOX_PROMPT`, and the prompt path reads a
   daemon-rendered `.rbox/state/shell.line` (`src/cli/shell-init.ts:42-56`,
   `src/cli/shell-init.ts:70-125`, `src/cli/shell-init.ts:177-190`). That
   proves the hook shape. It does not give menu bar consumers a shared status
   file beside the daemon pid/log, and its current stale threshold is 180s
   (`src/cli/shell-init.ts:113-117`), too slow for this product promise.
5. **The daemon already owns the right runtime directory.** `daemonRuntimeDir`
   is `~/.rbox/daemons/<workspaceKey>`, with `daemon.pid`, `daemon.log`, and
   `workspace.bound` colocated there (`src/cli/daemon-control.ts:20-39`). This
   design adds one file beside those, not another workspace-local observability
   tree.

## 2. Decision summary

One source of truth: tiny atomic `daemon.status.json`, maintained beside
`daemon.pid`, `daemon.log`, and `workspace.bound` in `daemonRuntimeDir(root)`
(`src/cli/daemon-control.ts:31-39`). Consumers read that file and infer
daemon death from staleness; they never round-trip to the daemon. Phase 1 is
`rbox prompt-status` plus design-46 wiring, phase 2 is a SwiftBar/xbar plugin
that polls the same file, and phase 3 native macOS stays parked until the MVP
proves demand beyond the founder.

## 3. Existing code facts

1. `workspaceKey(root)` is deterministic from the resolved root and already
   names the per-workspace daemon runtime directory
   (`src/cli/daemon-control.ts:20-35`). A reader that has only the current
   directory can walk to `.rbox/workspace.json`, compute the same key, and find
   the status file without parsing workspace config.
2. `readDaemonPidRecord` and `isDaemonRunning` already parse v2 pidfiles and
   verify process ownership with both pid liveness and the daemon marker/root
   in `ps` (`src/cli/daemon-control.ts:218-240`,
   `src/cli/daemon-control.ts:199-204`). Ambient readers do not need to prove
   liveness this strongly on every prompt; they only need pidfile presence for
   stale-file classification.
3. `startDaemon` creates the runtime dir, clears stale binding state, opens
   `daemon.log`, spawns the daemon, and writes the v2 pidfile with boot id
   (`src/cli/daemon-control.ts:301-319`). The status file is born and cleared
   in this same runtime lifecycle.
4. `stopDaemon` sends SIGTERM and removes the pidfile (`src/cli/daemon-control.ts:323-335`).
   A graceful daemon stop can therefore write `state:"paused"` before exit; a
   killed daemon leaves the stale file and pidfile that readers classify as
   `attention`.
5. The daemon already has an in-memory activity record for health, last push,
   last pull, live progress, halt, and out-of-storage
   (`src/cli/daemon.ts:151-160`; shape in `src/cli/activity.ts:25-80`).
   The ambient status file is a projection of that record plus daemon-local
   queue state, not a new source of sync truth.
6. Activity writes are chained and not awaited on the sync hot path
   (`src/cli/daemon.ts:669-679`, `src/cli/daemon.ts:774-779`). The status file
   uses the same ordered, best-effort discipline so visibility never blocks sync.
7. `canPersistTrustedSurface` already prevents a daemon that lost pidfile
   ownership from writing trusted sidecars (`src/cli/daemon.ts:788-790`). The
   status writer must sit behind the same gate.
8. Live progress already carries counts and optional byte counters, while
   `detail` is display-only and explicitly never persisted
   (`src/cli/transfer-progress.ts:10-20`, `src/cli/transfer-progress.ts:31-40`;
   daemon sink at `src/cli/daemon.ts:839-864`). The status file reuses counts
   and bytes, never detail strings.

## 4. Mechanism - `daemon.status.json`

Add `daemonStatusPath(root) = path.join(daemonRuntimeDir(root),
"daemon.status.json")`. The file is JSON, atomic, and best-effort, using the
same `writeFileAtomic` pattern as `saveActivity` / `saveShellLine`
(`src/cli/activity.ts:200-207`, `src/cli/activity.ts:294-306`). It is rewritten
on visible state transitions and by a dedicated status heartbeat timer.

Schema v1:

```ts
interface AmbientDaemonStatusV1 {
  schemaVersion: 1;
  state: "synced" | "syncing" | "attention" | "paused";
  heartbeatAt: string;      // ISO timestamp, rewritten every status heartbeat
  sequence: number | null;  // last known synced sequence
  lastSyncedAt: string | null;
  operation?: {
    kind: "pull" | "push";
    phase?: "scan" | "gitcap" | "encrypt" | "upload" | "download";
    filesDone?: number;
    filesTotal?: number;
    bytesDone?: number;
    bytesTotal?: number;
    /** Current file being processed, workspace-relative. LOCAL-ONLY display
     *  (founder call 2026-07-08): shown in the menu dropdown's
     *  Status / File / Progress block; never exported off-machine. */
    currentPath?: string;
  };
  attentionReason?:
    | "halt"
    | "out-of-storage"
    | "watcher-degraded"
    | "ownership-lost"
    | "unknown-error";
}
```

Privacy scoping (founder call 2026-07-08): the status file is a LOCAL-ONLY
surface in the daemon runtime dir — same trust domain as `daemon.log`, which
already records paths by design. So `operation.currentPath` and its display in
local surfaces (menu dropdown) are allowed; Dropbox shows the syncing filename
for the same reason. What stays banned from paths/hashes is everything that
LEAVES the machine: phase reports (design 82 §35), metrics summaries, gate
logs, and anything pasted into PRs. The prompt segment also stays path-free —
not for privacy but for width and the ≤5ms budget.

State derivation:

1. `syncing` when a pull or push is active, or when queued daemon wants mean a
   pull/push cycle is about to run. The daemon already tracks `activePumpOp`,
   `want`, `pendingEvents`, and `deferredRetryPaths` for `localSettled`
   (`src/cli/daemon.ts:148-149`, `src/cli/daemon.ts:712-722`).
2. `synced` when `localSettled()` is true and there is no halt,
   out-of-storage, or watcher degradation.
3. `attention` when the daemon knows sync is blocked or degraded: standing
   `activity.halt`, `activity.outOfStorage`, watcher unavailable/unhealthy, or
   ownership wind-down. The existing daemon records halt/out-of-storage in the
   pump catch paths (`src/cli/daemon.ts:432-451`, `src/cli/daemon.ts:552-568`)
   and records watcher degradation by disabling watcher trust and pinning the
   safety scan, or degrading to periodic scan on start failure (`src/cli/daemon.ts:235-249`).
4. `paused` on graceful stop and intentional no-daemon state. `stopDaemon`
   removes the pidfile after SIGTERM (`src/cli/daemon-control.ts:323-335`), so
   a paused final status with no pidfile is intentional; a stale non-paused
   status with a pidfile is not.

`lastSyncedAt` is the newer of the existing `lastPush.at` and `lastPull.at`
slots (`src/cli/activity.ts:50-56`; render logic already chooses newer at
`src/cli/activity.ts:277-287`). `sequence` is the daemon's known sequence:
`lastLoggedSeq` is seeded from `loadSyncBase()` on startup
(`src/cli/daemon.ts:190-193`) and updated on push/pull paths
(`src/cli/daemon.ts:510-515`, `src/cli/daemon.ts:657-659`).

## 5. Liveness and reader invariants

Status heartbeat interval: **5 seconds**. Stale window: **3 intervals = 15
seconds**.

Rationale: the existing activity heartbeat proves a process is alive during a
hung pump op, but it runs at `ACTIVITY_HEARTBEAT_MS = 30_000`
(`src/cli/daemon.ts:690-696`). That is fine for `rbox status` and too slow for
"you would know within seconds." A 5s tiny JSON rewrite is cheap; 3 missed beats
avoids false attention from one delayed timer while surfacing a killed daemon
quickly.

Reader algorithm:

1. Walk up from `$PWD` to find `.rbox/workspace.json`, the same root discovery
   shape the zsh integration uses (`src/cli/shell-init.ts:42-56`). If no root
   exists, print nothing.
2. Compute `daemonRuntimeDir(root)` via `workspaceKey`
   (`src/cli/daemon-control.ts:24-35`).
3. Read `daemon.status.json` and `daemon.pid`. Do not parse full workspace
   config, do not load state, do not touch the network, do not spawn `ps`, and
   do not contact the daemon.
4. If the status file is absent/corrupt and a pidfile exists, render
   `attention` with inferred reason `daemon-dead`. If BOTH are absent (a
   workspace where the daemon was never started, or fully stopped before this
   design shipped), render `paused` — background sync is off, which is a fact,
   not an emergency (glyph treatment is Open Decision §12.4).
5. If `heartbeatAt` is older than 15s and a pidfile exists, render `attention`
   with inferred reason `daemon-dead`.
6. If `heartbeatAt` is stale and no pidfile exists, render `paused` only when
   the last status state is `paused`; otherwise render `attention` with inferred
   reason `daemon-dead`.
7. If the file is fresh, render the daemon-written state. A daemon-written
   `attentionReason` is used only for daemon-known reasons; reader-inferred
   daemon death is never written into the file.

Invariant: readers are allowed to be conservative toward attention. A false
attention state costs annoyance; a false synced state recreates the 14-hour
silent-wedge class.

## 6. Phase 1 - shell prompt segment

Add a new command:

```
rbox prompt-status [path] [--json]
```

Default output is a compact segment plus newline. `--json` prints the reader
verdict for tests and prompt frameworks. Outside a workspace, output is empty
and exit 0.

Hard budget: **≤5ms p99 cold**, measured with `hyperfine`, on both fleet hosts.
The command must be an early dispatcher path, not a wrapper around
`statusCmdWithDeps`: the status command loads config/state, may remote-probe,
and may scan (`src/cli/status-cmd.ts:202-304`). `prompt-status` performs only
root discovery, `workspaceKey`, two small file reads, JSON parse, staleness math,
and formatting.

Initial default rendering:

1. `synced` → `✓`
2. `syncing` pull → `↓N` where `N` is files remaining when known, else `↓`
3. `syncing` push → `↑N` where `N` is files remaining when known, else `↑`
4. `attention` → `! reason`, e.g. `! dead`, `! quota`, `! halt`
5. `paused` → `! paused`

Design-46 wiring:

1. Keep the existing `chpwd` root cache and `precmd` refresh shape
   (`src/cli/shell-init.ts:177-190`).
2. Replace the `.rbox/state/shell.line` parser with the `prompt-status` verdict
   only if the ≤5ms p99 gate passes. If it misses, ship `prompt-status` for
   Starship/Powerlevel10k/manual prompts and keep the current pure-zsh
   `shell.line` path. The product requirement is the gate, not wishful latency.
3. Preserve design 46's failure mode: outside a workspace or on unreadable
   state, the segment vanishes or turns attention; it never prints shell errors
   (`src/cli/shell-init.ts:11-13`, `src/cli/shell-init.ts:81-90`).

## 7. Phase 2 - SwiftBar/xbar menu bar MVP

Ship a script such as:

```
contrib/swiftbar/rbox.5s.sh
```

The script is configured with `RBOX_ROOT=/absolute/workspace/root` or generated
from the current workspace later. For the MVP, one plugin instance tracks one
workspace. It computes the same runtime-dir key as `workspaceKey`, polls
`daemon.status.json` every 5s, never opens a socket, and never asks the daemon
for state.

Menu bar title: `✓` synced, `↑` / `↓` syncing push/pull, `!` attention, and
`○` paused. Dropdown:

1. workspace display name from local workspace config when available; otherwise
   short workspace id, not root path (`rbox status` already uses name/id for its
   human header at `src/cli/status-cmd.ts:342-345`);
2. last synced time from `lastSyncedAt`;
3. the current operation as three aligned lines — `Status:` (phase),
   `File:` (`currentPath`, middle-truncated, monospace), `Progress:`
   (`filesDone / filesTotal — N%`) — with a thin progress bar. Rendered
   mockup: [assets/88-menubar-mockup.png](assets/88-menubar-mockup.png)
   (source: [assets/88-menubar-mockup.html](assets/88-menubar-mockup.html));
4. Pause / Resume actions wired to `rbox stop "$RBOX_ROOT"` and
   `rbox start "$RBOX_ROOT"` (`src/cli/daemon-control.ts:265-335`);
5. Open dashboard URL, derived from local config/app defaults
   (`src/cli/config.ts:12-30`, `src/cli/credentials.ts:27-33`);
6. redacted daemon-log tail plus "Open raw daemon log".

Log tail: with §4's local-only privacy scoping, the raw `daemon.log` tail may
render directly in the dropdown (it is the same local trust domain). The MVP is
demand validation: if users ask for this beyond the terminal-native cohort,
unpark §8.

## 8. Phase 3 - native macOS menu bar app, parked

A native app is future work. The bar for unparking:

1. the SwiftBar plugin proves value beyond the founder;
2. the product target moves beyond terminal-native early adopters; and
3. the native app needs richer interaction than a polled file can provide.

Design 85's daemon delegation unix socket is the future streaming surface for
rich clients: it was chosen for ack latency, progress streaming, and immediate
death detection (`docs/design/85-incremental-scan.md:187-231`). This design's
status file remains the compatibility floor even after that socket exists:
simple consumers can still read one file and infer liveness by staleness.

## 9. Acceptance gates

1. **Prompt latency:** compiled `rbox prompt-status` is ≤5ms p99 cold via
   `hyperfine` on both fleet hosts, inside and outside a workspace, across
   synced/syncing/attention/paused fixtures. No config parse, network, or
   subprocess.
2. **State flips:** across a real push and a real pull cycle, the status file
   flips `synced → syncing → synced`, records pull vs push direction, records
   files/bytes counts when available, and updates `sequence` / `lastSyncedAt`.
3. **Death visibility:** `kill -9` the daemon. With the pidfile still present,
   `rbox prompt-status` and the SwiftBar plugin render attention with inferred
   `dead` within one 15s staleness window.
4. **Paused distinction:** `rbox stop` renders paused, not daemon-dead, after the
   daemon's final write and pidfile removal.
5. **Privacy scope:** `rbox prompt-status` output contains no paths; nothing
   from `daemon.status.json` (including `currentPath`) flows into phase
   reports, metrics summaries, or any off-machine artifact. A grep gate runs
   against RBOX_METRICS outputs and phase-report JSON with a synced+syncing
   fixture whose `currentPath` is a sentinel string.
6. **Overhead:** status writes are unmeasurable in the phase report, with
   explicit acceptance of **<10ms/tick** overhead on both hosts. If the write
   path shows up, reduce heartbeat frequency or coalesce writes before shipping.
7. **Ownership:** a stale loser daemon cannot overwrite the current status file.
   The writer uses the existing pidfile boot-id ownership gate
   (`src/cli/daemon.ts:774-790`), and a test simulates pidfile ownership loss.

## 10. Rollout

1. **Phase 0 - fixtures and reader.** Pure reader/renderer tests: fresh, stale,
   corrupt, pidfile/no-pidfile, no-workspace empty output, and PII.
2. **Phase 1A - daemon writer.** Write `daemon.status.json` beside pid/log,
   behind `canPersistTrustedSurface`, on transitions and 5s heartbeat.
3. **Phase 1B - prompt command.** Add early `prompt-status`, gate it with
   `hyperfine`, and keep design-46 zsh unchanged until the gate passes.
4. **Phase 1C - shell-init integration.** Wire design-46 hooks to the new
   reader/format, preserving `RBOX_PROMPT` / `RBOX_NO_RPROMPT`.
5. **Phase 2 - SwiftBar MVP.** Ship script/docs/fixtures; validate demand.
6. **Phase 3 - parked native app.** Revisit only after SwiftBar evidence.

## 11. Non-goals

1. Linux tray support.
2. Windows notification area support.
3. Push notifications. A macOS notification from the SwiftBar plugin on
   attention is an open decision (§12), not a commitment.
4. Web dashboard activity feed.
5. Any change to daemon sync behavior, conflict behavior, watcher behavior, or
   retry behavior.
6. Replacing `rbox status`. The prompt/menu are smoke alarms; `rbox status`
   remains the inspection command.
7. Native app transport design. Design 85 owns the future unix socket; this
   design keeps the file floor.

## 12. Open decisions for the founder

1. **Prompt glyph taste.** Proposed defaults:
   - Minimal: `✓`, `↑12`, `↓8`, `! dead`
   - Branded: `rbx ✓`, `rbx ↑12/25`, `rbx ↓4.1GB`, `rbx ! quota`
   - Quiet: `✓`, `up 12`, `down 8`, `! halt`
2. **SwiftBar notification on attention.** Should the MVP fire a macOS
   notification on a fresh `attention` reason, or stay glance-only?
3. ~~Progress scalar.~~ **Resolved** (founder format, 2026-07-08): the file
   carries counts; every surface renders `filesDone / filesTotal — N%` with
   the percent computed at display time.
4. **The no-daemon prompt.** A workspace with background sync intentionally off
   renders `paused` — should the prompt show a quiet glyph (`○`), the louder
   `! paused`, or nothing at all? A permanent nag is wrong for a user who
   chose foreground-only sync; total silence recreates the invisible-failure
   class for one who forgot to `rbox start`.
