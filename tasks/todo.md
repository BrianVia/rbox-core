# Design 45 — status health & live sync visibility

Follow-on to design 44: the incident showed `rbox status` reports internals
(sequence, raw counts) instead of health, the daemon is a black box, and the
new mass-delete guard can silently stall background sync with no indicator.

## Plan

- [ ] `docs/design/45-status-health.md` — design doc
- [ ] `src/cli/activity.ts` — daemon activity sidecar (`.rbox/state/activity.json`,
      best-effort like metrics.json): last completed op, live progress, halt warning
- [ ] `src/cli/status-view.ts` — PURE render helpers (unit-testable):
      health verdict line, last-sync line, progress % label, relative time
- [ ] `src/cli/daemon.ts` — write activity: op summaries, throttled live progress
      (via onProgress), halt set on pump error / clear on success
- [ ] `src/cli/index.ts` — status leads with verdict + warning + last activity;
      sequence/device demoted to detail; push/pull/sync spinners show percentages
- [ ] `src/cli/init-cmd.ts` — populate-sync spinners show percentages
- [ ] best-effort remote-sequence probe (latestCommit, short timeout, never throws)
      → "behind remote" detection in status
- [ ] tests: status-view pure helpers, activity round-trip, daemon writes activity
- [ ] typecheck + full test suite green
- [ ] codex adversarial review → PR

## Review

(to fill in at the end)
