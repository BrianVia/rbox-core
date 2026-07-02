# Design 45 — status health & live sync visibility

Follow-on to design 44: the incident showed `rbox status` reports internals
(sequence, raw counts) instead of health, the daemon is a black box, and the
new mass-delete guard can silently stall background sync with no indicator.

## Plan

- [x] `docs/design/45-status-health.md` — design doc
- [x] `src/cli/activity.ts` — daemon activity sidecar (`.rbox/state/activity.json`,
      best-effort like metrics.json): last completed op, live progress, halt warning
- [x] `src/cli/status-view.ts` — PURE render helpers (unit-testable):
      health verdict line, last-sync line, progress % label, relative time
- [x] `src/cli/daemon.ts` — write activity: op summaries, throttled live progress
      (via onProgress), halt set on pump error / clear on success (writes CHAINED
      so they can't land out of order; drained at pump end)
- [x] `src/cli/index.ts` — status leads with verdict + warning + last activity;
      sequence/device demoted to detail; push/pull/sync spinners show percentages
- [x] `src/cli/init-cmd.ts` — populate-sync spinners show percentages
- [x] best-effort remote-sequence probe (abortable fetch of `/latest`, 2.5s timeout,
      never throws) → "behind remote" detection in status
- [x] tests: status-view pure helpers (13), activity round-trip (4), daemon halt
      lifecycle + push trail (2) — 413 total green, tsc clean, live smoke on
      ~/conductor/workspaces renders the verdict
- [x] typecheck + full test suite green
- [x] codex adversarial review → PR

## Review

Shipped through 6 codex rounds → PASS. 421 tests green. Findings fixed en route:
- R1 BLOCKER: any successful pump op cleared the halt — now op-keyed (a pull
  halt survives no-op pushes and safety scans; only a successful pull heals it).
- R1 MAJOR ×3: sidecar writes were awaited at pump tail (now never awaited on
  the sync path; stop() drains); status loaded state under the raw config
  remote instead of the credential's effective remote (the design-44 R3 rule);
  the verdict ignored git divergence (added gitDivergenceCount — a read-only
  mirror of planGitSections' capture decision).
- R2 MAJOR ×2: structural preflight drops over a synced base now count as
  divergence; the 409-recovery pull inside push is recorded via the new
  SyncDeps.onPullApplied hook, and the trail split into lastPush/lastPull
  slots so a commit can't mask its recovery pull's mutations.
- R3: per-slot shape validation in loadActivity (malformed lastPush crashed
  status); onPullApplied made throw-safe.
- R4: heal resets the error-dedup streak (same-message re-failure persists a
  fresh halt); resetSyncState clears activity.json; status suppresses a
  stale-bound daemon's liveness + sidecar; git walk reordered to match the
  planner (suppressions before preflight).
- R5: a stopped daemon never renders a live "syncing" verdict.
