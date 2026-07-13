# rbox — agent rules

## Deployment & local dev

**Pushes to `main` auto-deploy** (GitHub Actions):

- **API worker deploys are handled by Cloudflare's Workers Builds git integration** (connected in the Cloudflare dash; configured by the founder), not by GitHub Actions — the old `deploy-api.yml` was removed 2026-07-03. PR CI (`ci.yml`: typecheck + full test suites) remains the merge gate on every PR. NOTE: Workers Builds runs no tests itself — the PR gate is the only test gate before prod.
- `.github/workflows/deploy-web.yml` — when `apps/web/**` changes → build + `wrangler pages deploy` (**`rbox-app` / `app.rbox.to`**), gated on `check` + `test`.
- `.github/workflows/release.yml` — on `v*` tags → build/sign/publish the `rbox` CLI binaries to R2 (unchanged).

Both deploy workflows need a repo secret **`CLOUDFLARE_DEPLOY_TOKEN`** scoped to **Workers Scripts:Edit + Cloudflare Pages:Edit** (+ Account:Read) for the account. Keep it DISTINCT from release.yml's R2-only `CLOUDFLARE_API_TOKEN` (least privilege). The account id is hard-coded in the workflows (not a secret).

**Support diagnostics:** `rbox doctor` / opt-in report upload (`POST /v1/diagnostics`), incl. how to retrieve reports from D1+R2 — see `docs/diagnostics.md`.

**Rate-limit namespace_id registry (design 64 §3.1):** the Workers Rate Limiting bindings in `apps/api/wrangler.jsonc` use client-chosen `namespace_id`s — `2001` RL_DEVICE_START, `2002` RL_DEVICE_POLL, `2003` RL_RELEASE, `2004` RL_LINK_PAIR, `2005` RL_DEVICE_POLL_IP (same ids in dev + prod; the numbers differ per env). Nothing else in the repo reveals these — record any new limiter's id here. A future zone-level WAF rate-limiting rule (§3.4, once `rbox.to` is on Cloudflare) lives in the dash, not the repo; record it here if added.

**Prefer dev, not prod, while developing:**

- Deploy worker changes to **dev first** and verify there before they reach prod: `cd apps/api && npx wrangler deploy` → `rbox-dev-api`. Remember a merge to `main` ships prod automatically.
- Run the dashboard locally against the **dev** worker: `cd apps/web && npm run dev` uses `.env.development` (→ `rbox-dev-api.brian-via.workers.dev` + the dev Clerk instance `cosmic-phoenix-51`). **Don't point local UI builds at the prod API.** `npm run build` (production mode) bakes in the prod API + `pk_live` — that's only for the Pages deploy.
- Only let it reach prod (`--env production` / merge to `main`) once it works against dev.

<!-- stripe-projects-cli managed:agents-md:start -->
## Stripe Projects CLI

This repository is initialized for the Stripe project "rbox-core".

## Tools used

- [Stripe CLI](https://docs.stripe.com/stripe-cli) with the `projects` plugin to manage third-party services, credentials, and deployments for this project. Use the stripe-projects-cli to manage deploying and access to third party services.
<!-- stripe-projects-cli managed:agents-md:end -->
