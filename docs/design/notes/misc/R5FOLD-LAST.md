Implemented both parts and completed final adversarial review with `ALIGNED`.

- Design updated to `Status: v6 — r5 folded` with the R5 amendment in [176-wedge-ux-keep-mine.md](/home/via/Development/Personal/rbox-core/.claude/worktrees/176-wedge-ux/docs/design/176-wedge-ux-keep-mine.md).
- Implemented stable classification bracketing, effective projections, canonical artifact binding, split-index fingerprinting, expanded allowlist, and stale-attempt invalidation.
- Added all requested regression and control tests.
- Appended `## v6 adjustment` to [IMPL-176-REPORT.md](/home/via/Development/Personal/rbox-core/.claude/worktrees/176-wedge-ux/IMPL-176-REPORT.md), ending exactly `V6-ADJUST-COMPLETE`.
- `git diff --check` passes.

Acceptance:

- `bun run typecheck` — passed
- `bun test src/cli/sync-git` — 436 passed, 6 skipped
- `bun test src/cli src/engine` — 2,669 passed, 16 skipped

Goal completed in approximately 35m 31s.