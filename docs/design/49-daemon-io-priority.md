# 49 — Daemon IO priority + idle safety-scan backoff

Status: shipped in v0.6.5
Origin: 2026-07-02 machine-contention incident — Conductor shell startups
blew its 5s budget (one measured at 81s, 0% CPU: pure IO starvation) while
workspaces were being cloned. Profiling showed the main hogs were external
(antivirus + Spotlight indexing the churn), and that the daemon already runs
at CPU nice 10 (`os.setPriority(0, 10)` in `start()`), but two second-order
rbox costs remained: the daemon competes at *default disk-IO priority*, and
the 60s safety scan stat-sweeps every tracked file (12k+ in the incident
workspace) forever, even on a completely idle machine.

## 1. Disk-IO priority (both platforms, daemon only)

The same principle as the existing CPU nice: **background sync must lose the
disk race to the developer's own tools.** `daemon start()` was already
annotated "ionice for IO priority on Linux is a follow-up" — this is that
follow-up, plus the macOS half.

`src/cli/io-priority.ts` exports one function, `lowerIoPriority(): string`
(the return is a human-readable outcome for the startup log). Best-effort by
design: every failure path returns a reason and leaves the default policy —
never a throw, never fatal.

- **darwin**: `setiopolicy_np(IOPOL_TYPE_DISK=0, IOPOL_SCOPE_PROCESS=0,
  IOPOL_THROTTLE=3)` via `bun:ffi` on `libSystem.B.dylib`. THROTTLE is the
  Time Machine / Spotlight-indexer background tier: throttling only engages
  under contention — an idle disk still serves the daemon at full speed, so
  sync latency is unchanged except exactly when the user's foreground work
  needs the disk.
- **linux**: `ioprio_set(IOPRIO_WHO_PROCESS, tid, (BE<<13)|7)` for **every
  existing tid in `/proc/self/task`**, via the libc `syscall` symbol
  (`__NR_ioprio_set`: 251 on x64, 30 on arm64 — asm-generic). IO priority is
  per-*task* on Linux and `who=0` targets only the calling thread — which
  would miss Bun's already-spawned IO worker threads, the ones doing the
  actual disk work (codex R1 MAJOR). Threads spawned later inherit from
  their spawner. Best-effort class level 7 (lowest), NOT the IDLE class:
  IDLE can starve indefinitely under sustained foreign IO, and the daemon
  still has real-time pulls to apply.

Only the **daemon** calls this. One-shot `rbox push/pull/sync` are foreground
commands the user is actively waiting on — they keep default priority.

Why FFI and not `Bun.spawnSync(["taskpolicy"/"ionice", ...])`: the policy must
apply to *this* process; both CLI tools primarily wrap exec-a-child, the
`-p pid` forms aren't uniformly available, and a dlopen of libc/libSystem is
fewer moving parts than shelling out at daemon boot.

## 2. Idle backoff for the safety scan

The safety scan exists to heal **dropped watcher events**. Drops happen under
churn (event-queue overflow, storm coalescing) — not on an idle machine. Yet
the scan ran every 60s unconditionally: a stat sweep of every tracked file,
per minute, around the clock (plus the activity/sidecar write cluster it
causes). On the incident workspace that's 12,858 stats/minute of pure
overhead while idle — and on laptops, disk wakeups for nothing.

New behavior (`scheduleSafetyScan`, a self-rescheduling timeout replacing the
fixed `setInterval`):

- A **quiet** interval (zero watcher events since the previous safety tick)
  doubles the next delay: 60s → 2m → 4m → 5m (cap).
- **Any** watcher event snaps the delay back to 60s, **including an armed
  timer**: `noteChurn` pulls a backed-off timeout forward immediately (codex
  R1 MAJOR — the flag alone would let a drop from *this* storm wait out an
  armed 5m timer). Churn is exactly when the scan's protection matters, so
  the floor returns the moment there is anything to protect.
- **Degraded mode never backs off**: with no live watcher the periodic scan
  IS the sync mechanism, so it stays at 60s regardless of quiet.
- **A post-init watcher error revokes trust permanently** (codex R1 MAJOR +
  self-found): backend errors are surfaced via a new `WatchOptions.onError`
  (both parcel and chokidar), and one error flips `watcherHealthy` false for
  the daemon's lifetime — a possibly-dead FSEvents/inotify stream must not
  let the safety scan, now the only healer, sit backed off at 5m. Fail-safe
  toward pre-design-49 behavior: worst case is the old 60s cadence.
- The deep scan (30m, cache-bypassing re-hash) is untouched — it remains the
  unconditional floor under everything.

Cost of the trade: a watcher event dropped while otherwise fully idle now
heals in up to 5m instead of up to 60s (bounded above, as always, by the 30m
deep scan). Accepted: an isolated drop with no surrounding churn is the rare
case by construction, and `rbox status` still reports local divergence
immediately on demand.

The decision is a pure exported function, `nextSafetyDelay(current,
{watcherLive, churned})`, so the doubling/cap/reset table is unit-tested
without timers.

## 3. Testing

- `nextSafetyDelay`: doubling from 60s, 5m cap, churn reset, degraded reset.
- Wiring: watcher events mark churn AND re-arm a backed-off timer at the
  floor; a post-init `onError` revokes watcher trust.
- `lowerIoPriority` / `verifyIoPriority`: platform probes run in a
  **spawned** bun process (spawned so the throttle never applies to the
  test-suite process itself), asserting via the OS getters that the policy
  actually took — `getiopolicy_np == 3` on darwin; on linux, `ioprio_get ==
  16391` for **every** tid in `/proc/self/task`, with IO worker threads
  forced to exist before the set (the codex R1 repro). CI's ubuntu runner
  exercises the linux-x64 leg.
- **Release smoke** (codex R1 MINOR): `__watcher-selftest` — which already
  runs natively on all 3 release targets and gates publish — now also runs
  `lowerIoPriority` + `verifyIoPriority` and exits 4 on failure, printing an
  `IOPRIO_SELFTEST` line. A darwin-arm64 symbol typo or a wrong arm64
  syscall number can no longer ship.
