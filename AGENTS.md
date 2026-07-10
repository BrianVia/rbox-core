# rbox — agent rules

## Deployment & local dev

**How every surface ships (API worker / web dashboard / CLI binaries), the
Workers Builds dash config, prod-migration auto-apply, secrets, and the
dev-first rule live in `docs/DEPLOYMENTS.md` — read it before deploying or
merging anything that touches `apps/api/**`.** Key trap: a merge to `main`
ships prod automatically, and prod D1 migrations auto-apply as part of the
Workers Builds build command.

**Support diagnostics:** `rbox doctor` / opt-in report upload (`POST /v1/diagnostics`), incl. how to retrieve reports from D1+R2 — see `docs/diagnostics.md`.

**Rate-limit namespace_id registry (design 64 §3.1):** the Workers Rate Limiting bindings in `apps/api/wrangler.jsonc` use client-chosen `namespace_id`s — `2001` RL_DEVICE_START, `2002` RL_DEVICE_POLL, `2003` RL_RELEASE, `2004` RL_LINK_PAIR, `2005` RL_DEVICE_POLL_IP (same ids in dev + prod; the numbers differ per env). Nothing else in the repo reveals these — record any new limiter's id here. A future zone-level WAF rate-limiting rule (§3.4, once `rbox.to` is on Cloudflare) lives in the dash, not the repo; record it here if added.

<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "rbox-core".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->
