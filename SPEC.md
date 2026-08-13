# Implement design 236 — concluded-op litter self-heal

Objective: implement docs/design/236-concluded-op-litter-self-heal.md
exactly as written (r5, codex-aligned). The doc is the authority; this file
only adds execution order and acceptance criteria.

## Execution order (each step keeps the tree green)

1. **Table + epoch**: manifest-validate.ts:295 `REBASE_HEAD` →
   `"breadcrumb"`; fingerprint.ts:8 `GIT_FINGERPRINT_SCHEMA_VERSION` 7→8
   with the comment from §3.5. Update the table pin
   (follow.test.ts:656-665) in the same commit.
2. **Classifier**: follow-classify.ts:157-176 — route any
   breadcrumb-classified mismatch into `breadcrumbMismatches`; veto gates
   at :196-216 untouched. Detail string becomes the worktree-qualified
   token per §3.4 (segment concatenation ONLY — never path.relative on
   absolute dirs). Rewrite the ORIG_HEAD-only pin (follow.test.ts:668-679)
   to the new rule.
3. **Executor**: follow.ts:743-754 — new shape per §3.2b (at most one
   ORIG_HEAD mismatch → preserveOrigHead unchanged; other breadcrumbs need
   no action; guard becomes "ORIG_HEAD ∈ mismatches ⇔ preservation ran").
4. **Boundary proof**: follow.ts:992-999 per §3.2c — keep
   `!opts.manualResolution` scoping; automatic follows compare FULL
   canonical tuples (rel, live, base, incoming) between initial and
   boundary classification; ORIG_HEAD ⇔ preservation both directions;
   failure detail names actual rels.
5. **Durable sample**: `GitDeferral.opStateSample?: string`
   (sync-state-model.ts:171-183) + coverage.ts:123 registration +
   JSON/SQLite differential + compat fixture (old records load unchanged).
   Plumb per §3.4 last bullet: follow defer shape → 
   composeFollowRepoTransition (follow-repo-transition.ts:291) →
   nextDeferral/setDeferral (shared.ts:155, apply.ts:1214);
   retainHeldRepo (apply.ts:456-468) preserves existing sample.
6. **Status**: status-view.ts local-operation row reads
   `opStateSample` from the selected lane's deferral; render
   "Git operation files at <token>." per §3.4 (mirror the git-busy
   samplePath display shape).
7. **Fixtures** per §6: three field-wedge red→greens, real-git
   REBASE_HEAD lifecycle matrix, boundary tuple rules (new fossil /
   same-rel-different-value / manual+fossil), held-skip epoch miss,
   persistence lanes (boundary-failure deferral carries sample;
   no-fingerprint lane carries sample; retainHeldRepo re-stamp preserves).

## Constraints

- Do NOT touch: orig-head.ts preservation machinery, the veto gates,
  resolve-command privacy suppression (resolve-command.ts:1077-1083),
  pruneEmptyOpStateDirs, the gitBusy/deferral-hygiene lock plane,
  restoreOpState/restoreOpStateWithCrash bodies (they already conform
  op-state — no changes needed).
- Protected tests that must stay green UNMODIFIED:
  git-cmd.test.ts:928-944, :966-989, :1024-1046, :804 (privacy pin);
  capture-stability.test.ts:110,157,211; follow-matrix.test.ts.
- Intentionally rewritten tests: follow.test.ts:656-665 (table pin),
  :668-679 (ORIG_HEAD-only waiver pin).
- No new flags, no config, no background sweepers. ≤500 lines/file target;
  comments only for inexpressible constraints.
- IMPORTANT: prove tests EXECUTE before writing implementation code (run
  one existing follow.test.ts test first; if the runner is blocked, STOP
  and report — do not write static-only tests).

## Acceptance criteria (all must pass, run from the worktree root)

- bun test src/cli/sync-git/follow.test.ts
- bun test src/cli/git-cmd.test.ts
- bun test src/cli/sync-git/follow-matrix.test.ts
- bun test src/engine/git/capture-stability.test.ts
- bun test src/cli/sync-git/held-skip.test.ts (or the suite containing
  held-skip coverage)
- bun test src/cli/state-plane (codec differential + coverage)
- bun run typecheck
- bun run lint:affected (warnings reviewed, not required zero)

Report: list every file changed with a one-line why, every test
added/rewritten, and paste the final passing test output summary.
