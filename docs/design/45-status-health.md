# 45 — Status health & live sync visibility

## Motivation

The 2026-07-01 rebind incident (design 44) was *detected by the user*, not by the
tool: "no progress spinner, so I don't believe it synced." Post-mortem, three
visibility gaps stand out — and design 44 itself made the third one urgent:

1. **`rbox status` reports internals, not health.** It printed
   `last-synced sequence: 0` / `local files: 0` and left the human to infer the
   disaster. Status already holds both sides of the comparison (the local scan
   AND the last-synced baseline) and never diffs them for display.
2. **The daemon is a black box.** It deleted 8,603 files and the only record was
   `daemon.log`. Status reports daemon *liveness* (`running (pid N)`), never
   *activity* ("what did sync last do to my tree?").
3. **The mass-delete guard (design 44) created a silent-stall state.** When the
   daemon's pull trips the guard it refuses (correctly), logs invisibly, and
   background sync just stops. We shipped a circuit breaker with no indicator
   light.

Plus one direct user ask: **live percentages** during transfers, everywhere a
transfer happens (one-shot commands *and* status while the daemon is mid-sync).

## Mechanisms

### 1. Daemon activity sidecar — `.rbox/state/activity.json`

A tiny, best-effort JSON the daemon maintains and `rbox status` reads. Same
placement rationale as `metrics.json`: its own file, so an activity write can
never corrupt the correctness-critical `state.json`. Every write is
throw-swallowed — visibility must never break sync.

```ts
interface DaemonActivity {
  at: string;                    // heartbeat: last time the pump completed an op
  last?: {                       // last op that CHANGED something (op summaries)
    at: string;
    op: "pull" | "push";
    writes?: number; deletes?: number; conflicts?: number;  // pull
    files?: number; sequence?: number;                      // push
  };
  active?: {                     // live progress; present only mid-transfer
    at: string;
    phase: "encrypt" | "upload" | "download";
    done: number; total: number;
  };
  halt?: {                       // standing warning; cleared by the next success
    at: string; reason: string; count: number;
  };
}
```

Daemon wiring:
- **Heartbeat**: `at` refreshed after every successful pump op (including no-op
  ticks) — throttled to one write per 30s in steady state so an idle daemon
  isn't churning the disk.
- **`last`**: written when a pull applies actions or a push commits.
- **`active`**: written from `onProgress` (throttled to ~500ms, plus the final
  tick), cleared when the op ends. `rbox status` treats `active` older than 60s
  as stale (a crashed daemon must not show "syncing" forever).
- **`halt`**: set in the pump's error path with the error message and repeat
  count; cleared on the next successful op. This is the mass-delete guard's
  indicator light, and covers persistent auth/network failures for free.

The file lives under the workspace's `.rbox/state/` (already ignored by sync).

### 2. Status leads with a health verdict

`rbox status` computes `diffManifests(state.lastSyncedManifest, localScan)` —
both sides were already in hand — and renders, in priority order:

```
⚠ sync halted: pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard). …
↻ syncing — uploading 42% (3612/8603)
↑ 12 local changes to sync (3 new, 9 changed) — background sync stopped; run `rbox start`
↓ behind remote — sequence 78 vs 80; will sync on next pull
✓ in sync — 8,603 files · last sync 2m ago
```

- The **halt** line renders whenever `halt` is present and the daemon is
  running (a stopped daemon's stale halt is dropped — the next start clears it).
- **Behind remote** comes from a best-effort `latestCommit()` probe (small
  metadata fetch, short timeout, never throws — same never-block contract as
  `fetchAccountSummary`). Offline, the line simply doesn't render.
- **In sync** is the local verdict (no local divergence from baseline) plus, if
  the probe answered, remote confirmation.
- `last-synced sequence` demotes into a dim detail line; a `last sync:` line
  from `activity.last` gives the human-readable trail
  (`last sync: 2m ago — pushed 3 files → sequence 78`).

All rendering is in pure helpers (`status-view.ts`) so the verdict logic is
unit-tested without console capture.

### 3. Percentages on every transfer

`onProgress(done, total, phase)` already flows from `encryptAndUpload` (encrypt,
upload) and `applyActions` (download). One shared formatter:

```
uploading 42% (3612/8603)
```

used by `rbox push` / `pull` / `sync` spinners, the `rbox init`/`setup`
populate-sync spinners, the daemon's `active` progress in status. Counts are
blob/entry counts (byte-weighted percentages are a §35 follow-up — counts are
what the pipeline already emits, and for "is it moving / how far along" they're
equivalent in practice).

## Non-goals

- Real-time progress streaming into a running `rbox status` (it's a snapshot;
  `rbox logs -f` remains the live view).
- Byte-accurate transfer percentages (counts now; bytes ride §35's basis work).
- Server-side pending-change detail (status stays local-first; the remote probe
  is sequence-only and optional).

## Failure posture

Every new surface is read-only or best-effort: activity writes swallow errors,
the remote probe times out silently, and a missing/corrupt activity.json renders
nothing. `rbox status` must keep working offline and must never mutate sync
state.

## Regression coverage

- `status-view.test.ts` — verdict priority (halt > active > diverged > behind >
  in-sync), stale-active suppression, relative-time formatting, progress labels.
- `activity.test.ts` — round-trip, corrupt-file → undefined, best-effort writes.
- `daemon.ts` integration (in `sync.test.ts` harness style): a push that commits
  writes `last`; a pump error writes `halt`; the next success clears it.
