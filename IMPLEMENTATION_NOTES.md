# CLI fixes implementation notes

## Fix 1: `rbox track --name`

- Found: the create-new path in `src/cli/track-cmd.ts` forwarded the remote URL,
  token, and project to `createRemoteWorkspace`, but omitted its existing optional
  `name` argument. No sibling flag was dropped on that call path.
- Changed: forward `flags.name` to the remote workspace-create boundary.
- Tested: `src/cli/track-untrack.test.ts` now drives the non-interactive create-new
  path with environment credentials and asserts the exact encoded request URL.

## Fix 2: visible `RBOX_API` override

- Found: the normal CLI resolved its default API base once in the dispatcher, but
  the latency-sensitive `prompt-status` startup path bypassed that module.
- Changed: when `RBOX_API` differs from the production default, that resolution
  now lives in the small shared `src/cli/api-base.ts` startup module and writes
  exactly `⚠ RBOX_API override: <url>` to stderr. Both CLI entry paths import it;
  module evaluation limits it to once per process, and `RBOX_API_QUIET=1` suppresses it.
- Tested: subprocess coverage verifies the warning, the unset/production-default
  cases, quiet suppression, and parseable JSON-only stdout with the override active.

## Verification

- `bun test src/cli/track-untrack.test.ts`: 8 passed, 0 failed.
- `bun test src/cli/dispatch-json.test.ts src/cli/ambient-status.test.ts`: 13 passed,
  0 failed.
- `bun run typecheck`: passed both the root and `apps/api` TypeScript checks.
- `bun test ./src/` (the root package's canonical full suite): 927 passed, 11
  skipped, 0 failed. The spec's documented pre-existing `json-output.test.ts`
  local failure did not reproduce.
- A raw unscoped `bun test` was also run once: its CLI/core tests passed, while 17
  untouched `apps/api`/`apps/web` test files failed to load because this worktree's
  Bun runner cannot resolve `cloudflare:test`, `@clerk/clerk-js`, or Svelte `$lib`.
  Those environment/module-resolution errors are outside both CLI fixes.
