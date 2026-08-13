# Implement design 236 — concluded-op litter self-heal (r6-slim)

Objective: implement docs/design/236-concluded-op-litter-self-heal.md
exactly as written (r6-slim). The doc is the authority; this file only adds
execution order and acceptance criteria.

NOTE: the design was deliberately SLIMMED after alignment. There is NO
GitDeferral.opStateSample field, NO codec/coverage work, NO status-view
change, NO boundary tuple comparison. Do not build any of those.

## Execution order (each step keeps the tree green)

1. **Table + epoch**: manifest-validate.ts:295 `REBASE_HEAD` →
   `"breadcrumb"` (update the doc comment at :289-293 — its assumption is
   field-falsified); fingerprint.ts:8 `GIT_FINGERPRINT_SCHEMA_VERSION` 7→8
   with a comment that classifier semantics are part of the schema. Update
   the table pin (follow.test.ts:656-665) in the same commit.
2. **Classifier**: follow-classify.ts:157-176 — route any
   breadcrumb-classified mismatch into `breadcrumbMismatches`; veto gates
   at :196-216 untouched. Detail string becomes the worktree-qualified
   token per design §3.4: `worktrees/<name>/<rel>` for a linked worktree
   (name = basename of the gitdir under commonDir/worktrees/), `<rel>` for
   the primary — segment concatenation ONLY, never path.relative on
   absolute dirs. Rewrite the ORIG_HEAD-only pin (follow.test.ts:668-679)
   to the new rule.
3. **Executor**: follow.ts:743-754 — at most one ORIG_HEAD mismatch →
   preserveOrigHead unchanged; other breadcrumb mismatches need no
   execution-time action; guard becomes "ORIG_HEAD ∈ mismatches ⇔
   preservation ran".
4. **Boundary proof**: follow.ts:992-999 — keep `!opts.manualResolution`
   scoping exactly; automatic follows require boundary classification
   waived AND (ORIG_HEAD ∈ boundary mismatches ⇔ origHeadPreservation
   exists). NO fossil value/set comparison. Failure detail names the
   actual rels (fix the hard-coded "differs at ORIG_HEAD" lie at :993).
5. **Fixtures** per design §6: three field-wedge red→greens (stale
   AUTO_MERGE follows + fossil gone after checkout via existing
   conformance; stale REBASE_HEAD in linked worktree follows; fossil +
   real MERGE_HEAD defers with both rels named); real-git REBASE_HEAD
   lifecycle matrix (conflict-stop, interactive edit, --quit, finish,
   abort); boundary fixtures (real op appears mid-flight defers;
   manual+fossil take-theirs still applies); held-skip epoch miss
   ("fingerprint-version"); token construction unit test (no absolute
   path possible).

## Constraints

- Do NOT touch: orig-head.ts, the veto gates, resolve-command privacy
  suppression (resolve-command.ts:1077-1083), pruneEmptyOpStateDirs,
  gitBusy/deferral-hygiene, restoreOpState/restoreOpStateWithCrash bodies,
  sync-state-model.ts, state-plane codecs, status-view.ts.
- Protected tests, green UNMODIFIED: git-cmd.test.ts:928-944, :966-989,
  :1024-1046, :804; capture-stability.test.ts:110,157,211;
  follow-matrix.test.ts.
- Intentionally rewritten: follow.test.ts:656-665, :668-679.
- No new flags, no config, no new fields. ≤500 lines/file target; comments
  only for inexpressible constraints.
- IMPORTANT: prove tests EXECUTE before writing implementation code (run
  one existing follow.test.ts test first; if the runner is blocked, STOP
  and report — do not write static-only tests).

## Acceptance criteria (all must pass, run from the worktree root)

- bun test src/cli/sync-git/follow.test.ts
- bun test src/cli/git-cmd.test.ts
- bun test src/cli/sync-git/follow-matrix.test.ts
- bun test src/engine/git/capture-stability.test.ts
- bun test src/cli/sync-git/  (held-skip + fingerprint suites included)
- bun run typecheck
- bun run lint:affected (warnings reviewed, not required zero)

Report: list every file changed with a one-line why, every test
added/rewritten, and paste the final passing test output summary.
