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
- **`halt`**: set in the pump's error path with the error message, repeat count,
  and the OP KIND that failed; healed only by a later success of the SAME kind
  (codex R1 BLOCKER: "any success clears" let the queued no-op push — or any
  60s safety scan — flap a mass-delete-guard warning off within seconds of every
  trip). This is the guard's indicator light, and covers persistent auth/network
  failures for free. A pull-guard trip inside push's internal 409-recovery
  records as a push halt — sound, because that push can only succeed once its
  internal pull does.
- Sidecar writes are never awaited on the sync path (a slow write must not delay
  an op — codex R1 MAJOR); they chain on one promise (ordered) and stop() drains
  the chain so shutdown flushes the final record.

The file lives under the workspace's `.rbox/state/` (already ignored by sync).

### 2. Status leads with a health verdict

`rbox status` computes `diffManifests(state.lastSyncedManifest, localScan)` —
both sides were already in hand — plus `gitDivergenceCount` (a READ-ONLY mirror
of `planGitSections`' per-repo capture decision: pending carry, removal
memories, needs-resolution suppression, preflight skip, the §7 shape×scope
carry matrix — codex R1: without it a clean file tree with an unpushed local
git commit read "in sync"). State is loaded under the CREDENTIAL'S effective
remote (`creds.remoteUrl ?? cfg.remoteUrl`), the same rule buildAuthedRemote
applies when sync stamps the baseline (codex R1, echoing design 44 R3). It
renders, in priority order:

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

## Code-comment provenance (113 wave 4)

Review citations relocated from code comments by design 113 wave 4 (comment
sweep). The invariant prose remains at each cited site; the review round that
produced it is recorded here.

- `src/cli/sync-git/status.ts` (git status dimension): was "codex R1" — planner-mirroring invariant retained in code.
- `src/cli/sync-git/status.ts` (suppression ordering): was "codex R4" — suppressions-before-preflight invariant retained in code.
- `src/cli/sync-git/status.ts` (structural refusal): was "codex R2" — unpublished-drop counting invariant retained in code.
- `src/cli/sync-git/git-sync.test.ts` (structural drop): was "codex R2" — unpublished-change regression guard retained in code.
- `src/cli/sync-git/git-sync.test.ts` (clean files plus pending git): was "codex R1" — status-verdict guard retained in code.
- `src/cli/activity.ts` (`lastPush` slot): was "codex R2" — recovery-pull visibility invariant retained in code.
- `src/cli/activity.ts` (nested-slot validation): was "codex R3" — malformed-slot isolation invariant retained in code.
- `src/cli/config.ts` (rebind sidecars): was "codex R4" — per-binding sidecar reset invariant retained in code.
- `src/cli/daemon/daemon.ts` (same-kind halt healing): was "codex R1 BLOCKER" — halt persistence invariant retained in code.
- `src/cli/daemon/daemon.ts` (settled shell sidecar): was "codex R4 P1" — idle-settle invariant retained in code.
- `src/cli/daemon/daemon.ts` (`lastPush` slot): was "codex R2" — recovery-pull visibility invariant retained in code.
- `src/cli/daemon/daemon.ts` (pull-inside-push hook): was "codex R2" — retry-loop activity recording invariant retained in code.
- `src/cli/daemon/daemon.ts` (activity write latency): was "codex R1" — non-blocking sidecar persistence invariant retained in code.
- `src/cli/daemon/daemon.ts` (pump-exit settle): was "codex R4 P1" — pending-to-ok transition invariant retained in code.
- `src/cli/daemon/daemon-activity.test.ts` (same-kind heal guard): was "Codex R1 BLOCKER regression" — rewritten as a neutral regression guard.
- `src/cli/daemon/daemon-activity.test.ts` (dedup episode guard): was "Codex R4 regression" — rewritten as a neutral regression guard.
- `src/cli/status-view.ts` (git divergence field): was "codex R1" — pending-git visibility invariant retained in code.
- `src/cli/status-view.ts` (stopped daemon rendering): was "codex R5" — daemon-ownership invariant retained in code.
- `src/cli/status-view.ts` (two activity slots): was "codex R2" — recovery-pull visibility invariant retained in code.
- `src/cli/status-view.test.ts` (409 recovery trail): was "codex R2 regression" — rewritten as a neutral regression guard.
- `src/cli/sync/deps.ts` (`onPullApplied` trail): was "codex R2" — forensic-log/activity-trail invariant retained in code.
- `src/cli/sync/pull.ts` (pull-applied hook): was "codex R3" — hook-after-save invariant retained in code.
