<!-- stripe-projects-cli managed:claude-md:start -->
look at AGENTS.md for your rules
<!-- stripe-projects-cli managed:claude-md:end -->

<!-- primitive-first-architecture:start -->
## Primitive-first architecture (always)

These rules apply to Claude, Codex, subagents, and every other coding agent:

- Preserve supported behavior by default. Never remove a command, output,
  protocol, safety property, compatibility path, performance fast path, or
  active migration/readiness path without explicit product approval and
  evidence.
- Simplify by reducing concepts, authorities, branches, modes, Interfaces, and
  cross-Module knowledge—not by spreading the same complexity across more
  files. File splitting alone is not architecture.
- Prefer the smallest coherent set of deep Modules with narrow, complete
  Interfaces. Give every invariant, state transition, durable record, and
  physical effect one explicit owner.
- Keep CLI, daemon, HTTP, UI, and background-loop code as Adapters. They must
  not independently rebuild domain orchestration.
- Treat every new flag, mode, boolean, fallback, sidecar, queue identity, and
  special-case branch as a requirement with an owner and deletion condition.
- Keep feature retirement separate from dead-code deletion. Deletion requires
  command/alias, import, export, build, package, generated-load, automation,
  documentation, owner, and support-window evidence; static reachability alone
  is not proof.
- Challenge incidental or “dumb” requirements explicitly, with their
  complexity cost and a product decision. Until that decision is made,
  preserve the behavior behind a clear Interface.

Before any non-trivial coding, design, refactor, architecture, or review task,
you MUST read and apply `.agents/skills/simplify-codebase-primitives/SKILL.md`
when present, otherwise
`$HOME/.agents/skills/simplify-codebase-primitives/SKILL.md`. The work is not
ready until it identifies protected functionality, ownership, safe deletion
candidates, challenged requirements, and differential/crash/compatibility/
performance validation.

When running a thermo-nuclear review, apply both standards. Line count is a
warning signal, not the goal: never split a cohesive deep Module into shallow
pass-through files merely to stay below a threshold.
<!-- primitive-first-architecture:end -->

## Simple primitives, less code (always)

- The best code is code we don't have to write. Before building any mechanism,
  look for the boring, battle-tested primitive that already solves it (flock,
  git's own index, atomic rename, one plain JSON file) — and prefer deleting
  mechanism over adding it.
- Build every piece from primitives a future reader can grok in one sitting:
  obvious data shapes, one clear owner, no clever indirection. If a design
  needs a new special case every review round, the plane is wrong — step out a
  layer and find the stronger primitive underneath.
- Complexity compounds into a house of cards; simplicity compounds into
  velocity. When two designs both work, ship the one with fewer concepts, even
  when it is slightly less optimal or less general.


## Development flow (anything non-trivial)

Always in a worktree (`.claude/worktrees/<slug>`), never the primary checkout.
Design doc in `docs/design/N-title.md` → codex adversarial review loop
(`/arbitrage`) until Claude + GPT align → implement via `codex exec` →
validate for real (fleet dev build or test rig) → `/simplify` (diff-scoped)
→ merge on green CI → optional CLI release. Periodically (not per-cycle):
codex `/thermo-nuclear-code-quality-review` refreshes the structural-refactor
roadmap — supersedes `/antislop-codebase`. Full version in AGENTS.md.

## Deployments

@docs/DEPLOYMENTS.md

`main` is integration-only for production and automatically deploys the DEV
API through Workers Builds. After green CI and dev verification, production
ships only by explicitly fast-forwarding `main` to the `production` branch;
the test-gated API workflow applies prod D1 migrations before deploying.

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
