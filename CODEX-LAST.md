Deleted exactly 64 tests from 29 files, including 6 files removed entirely. No production source or unlisted tests were changed.

Created [CULL-REPORT.md](/home/via/Development/Personal/rbox-core/.claude/worktrees/test-cull/CULL-REPORT.md).

Validation passed:

- All 23 retained test files individually
- `bun run typecheck`
- `bun run lint:affected` — no new warnings
- `git diff --check`
- Kill-list audit: 64/64 absent

Goal completed in 6m 33s using 114,686 tokens.