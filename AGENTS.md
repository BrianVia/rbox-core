# rbox — agent rules

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

- Before any work, ask two questions: “what's the simplest thing I can use off
  the shelf to solve this?” and “how can I simplify or remove dumb requirements
  instead of building for them?” The best code is code we don't have to write — reach for the
  boring, battle-tested primitive that already solves it (flock, git's own
  index, atomic rename, SQLite for local state) and prefer deleting mechanism
  over adding it. Plain JSON files are only for records a human is meant to
  read or hand-edit; internal state belongs in SQLite.
- Build every piece from primitives a future reader can grok in one sitting:
  obvious data shapes, one clear owner, no clever indirection. If a design
  needs a new special case every review round, the plane is wrong — step out a
  layer and find the stronger primitive underneath.
- Complexity compounds into a house of cards; simplicity compounds into
  velocity. When two designs both work, ship the one with fewer concepts, even
  when it is slightly less optimal or less general.


## Development flow (anything non-trivial)

Brian's preferred loop — follow it unless told otherwise:

0. Work in a git worktree by default — `.claude/worktrees/<slug>` off main,
   never the primary checkout — so parallel sessions don't clobber each other.
1. Put a design document in `docs/design/N-title.md` (next free N; check after
   rebasing — same collision rule as migrations).
2. Iterate with subagents + `/arbitrage`: have codex (GPT) adversarially review
   the design, revise here, re-dispatch — until BOTH agents (Claude and GPT)
   are in alignment, **capped at 3 review rounds** (founder rule 2026-07-27).
   At least one round must execute code/tests, not just read the doc. If
   round 3 isn't ALIGNED, the design is wrong-layer or over-scoped — never
   schedule round 4: step out a layer (re-frame one abstraction level up),
   ask the founder to break the tie with 2-4 concrete options, or cut
   scope / ship the residual behind a kill switch.
   Keep the rounds in a `REVIEW-N.md` beside the worktree.
3. Implement via `codex exec` against the agreed design (spec-first dispatch).
4. Validate the design is actually working: a dev build shipped to the local
   fleet, or the test rig (`bun run rig`) — not just unit tests.
5. Run `/simplify` (diff-scoped cleanup of the change). Repo-wide structural
   review runs on a separate cadence, not per-cycle: every few merged cycles
   (or when touching a known hotspot), run codex's
   `/thermo-nuclear-code-quality-review` to refresh the ranked refactor
   roadmap — it supersedes ad-hoc `/antislop-codebase` runs; act on the
   roadmap one decomposition cycle at a time.
6. Merge only after all CI is green and no remaining issues are found.
7. (Optional) release a new CLI build if the change warrants it
   (`docs/DEPLOYMENTS.md` has the release flow).

## Module ownership map (docs/CODEMAP.md)

`docs/CODEMAP.md` is the canonical ownership map of the sync engine
(`src/cli/sync*`, `src/cli/daemon*`, `src/cli/e2ee-remote*`,
`src/cli/remote/`, `src/cli/publish-pipeline/`, `src/engine/`): one line per
module — what it owns, what it must never own. Specs cite CODEMAP lines
instead of re-deriving structure from line numbers. **Any PR that adds a
module under those trees, or changes what a module owns, updates its CODEMAP
line in the same PR.**

## Deployment & local dev

**How every surface ships (API worker / web dashboard / CLI binaries), the
Workers Builds dash config, prod-migration auto-apply, secrets, and the
dev-first rule live in `docs/DEPLOYMENTS.md` — read it before deploying or
promoting anything that touches `apps/api/**`.** `main` deploys DEV through
Workers Builds but no production surface. After dev verification and green CI,
explicitly fast-forward `main` to the deployed `production` branch. The
test-gated `deploy-api.yml` workflow applies prod D1 migrations before the
production deploy during that promotion.

**Support diagnostics:** `rbox doctor` / opt-in report upload (`POST /v1/diagnostics`), incl. how to retrieve reports from D1+R2 — see `docs/diagnostics.md`.

**Rate-limit namespace_id registry (design 64 §3.1):** the Workers Rate Limiting bindings in `apps/api/wrangler.jsonc` use client-chosen `namespace_id`s — `2001` RL_DEVICE_START, `2002` RL_DEVICE_POLL, `2003` RL_RELEASE, `2004` RL_LINK_PAIR, `2005` RL_DEVICE_POLL_IP, `2006` RL_TELEMETRY, `2007` RL_KEY_DELIVERY_APPROVE, `2008` RL_KEY_DELIVERY_FETCH, `2009` RL_KEY_DELIVERY_SUBMIT, `2010` RL_KEY_DELIVERY_ACK (same ids in dev + prod; the numbers differ per env). Nothing else in the repo reveals these — record any new limiter's id here. A future zone-level WAF rate-limiting rule (§3.4, once `rbox.to` is on Cloudflare) lives in the dash, not the repo; record it here if added.

<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "rbox-core".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->
