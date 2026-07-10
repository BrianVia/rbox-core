<!-- stripe-projects-cli managed:claude-md:start -->
look at AGENTS.md for your rules
<!-- stripe-projects-cli managed:claude-md:end -->

## Development flow (anything non-trivial)

Always in a worktree (`.claude/worktrees/<slug>`), never the primary checkout.
Design doc in `docs/design/N-title.md` → codex adversarial review loop
(`/arbitrage`) until Claude + GPT align → implement via `codex exec` →
validate for real (fleet dev build or test rig) → `/simplify` +
`/antislop-codebase` → merge on green CI → optional CLI release.
Full version in AGENTS.md.

## Deployments

@docs/DEPLOYMENTS.md

## D1 migrations (apps/api/migrations/README.md)

Before adding or touching anything under `apps/api/migrations/`, read
`apps/api/migrations/README.md`: filenames are append-only (wrangler tracks
applied migrations by filename — never rename), pick the next free number and
re-check it after rebasing. A config-time guard in `apps/api/vitest.config.ts`
fails the test suite on any new number collision.

## Session log (docs/STATUS.md)

`docs/STATUS.md` is the living cross-host state snapshot. At the end of each
working session, update it with what shipped (releases, PRs), workstreams
opened/closed, and any new standing rules or playbook entries — it is how the
next session (on any host) picks up context. Keep it current-state focused:
compress or drop history that no longer changes decisions.
