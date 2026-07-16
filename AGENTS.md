# rbox — agent rules

## Development flow (anything non-trivial)

Brian's preferred loop — follow it unless told otherwise:

0. Work in a git worktree by default — `.claude/worktrees/<slug>` off main,
   never the primary checkout — so parallel sessions don't clobber each other.
1. Put a design document in `docs/design/N-title.md` (next free N; check after
   rebasing — same collision rule as migrations).
2. Iterate with subagents + `/arbitrage`: have codex (GPT) adversarially review
   the design, revise here, re-dispatch — repeat until BOTH agents (Claude and
   GPT) are in alignment. Keep the review rounds in a `REVIEW-N.md` beside the
   worktree (see design 93's 11 rounds for the pattern).
3. Implement via `codex exec` against the agreed design (spec-first dispatch).
4. Validate the design is actually working: a dev build shipped to the local
   fleet, or the test rig (`bun run rig`) — not just unit tests.
5. Run `/simplify` and `/antislop-codebase`.
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
merging anything that touches `apps/api/**`.** Key trap: a merge to `main`
ships prod automatically, and prod D1 migrations auto-apply as part of the
Workers Builds build command.

**Support diagnostics:** `rbox doctor` / opt-in report upload (`POST /v1/diagnostics`), incl. how to retrieve reports from D1+R2 — see `docs/diagnostics.md`.

**Rate-limit namespace_id registry (design 64 §3.1):** the Workers Rate Limiting bindings in `apps/api/wrangler.jsonc` use client-chosen `namespace_id`s — `2001` RL_DEVICE_START, `2002` RL_DEVICE_POLL, `2003` RL_RELEASE, `2004` RL_LINK_PAIR, `2005` RL_DEVICE_POLL_IP, `2006` RL_TELEMETRY (same ids in dev + prod; the numbers differ per env). Nothing else in the repo reveals these — record any new limiter's id here. A future zone-level WAF rate-limiting rule (§3.4, once `rbox.to` is on Cloudflare) lives in the dash, not the repo; record it here if added.

<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "rbox-core".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->
