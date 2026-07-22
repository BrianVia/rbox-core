# Design 178 tranche 2 — workstream C implementation review, round 1

Scope: `SPEC-178-T2.md` workstream C and design 178 §C.

## Findings

1. **BLOCKER — exact predecessor after generation-CAS loss.** The first draft
   reloaded the winner but did not re-project a clear/upgrade when an unrelated
   repo-generation change left the exact selected lane untouched.
2. **BLOCKER — unsafe repair command.** Display copy interpolated a truncated or
   basename-only sample path into an executable `rm` hint.
3. **Performance — ordinary busy-probe short circuit.** Refactoring `gitBusy`
   through exhaustive cohort inspection made the planner/apply hot path scan the
   shared refs tree even when a per-worktree lock was already present.
4. Add direct coverage for context-resolution failure, real shared-lock and
   per-worktree-lock behavior, persisted daemon heartbeat projection, and the
   shell/API vocabulary additions.

## Resolution

- Hygiene now retries a repo-generation loser at most three times and applies a
  captured action only when the winner lane is deeply equal to the exact captured
  predecessor; all unrelated winner fields are carried forward.
- Status reports recomputed count, age, and a sample path but emits no deletion
  command. It instructs the operator to verify ownership and remove only verified
  stale locks.
- `gitBusy` retains its original fail-closed short-circuiting behavior; only
  hygiene uses exhaustive structured inspection.
- The requested regression tests were added. Focused C tests, root typecheck, and
  API telemetry ingestion tests are green.

Status: aligned; no remaining workstream-C blockers.
