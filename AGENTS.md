# rbox — agent rules

## Deployment & local dev

**Pushes to `main` auto-deploy** (GitHub Actions):

- `.github/workflows/deploy-api.yml` — when `apps/api/**` changes → `wrangler deploy --env production` (**`rbox-prod-api` / `api.rbox.to`**), gated on `typecheck` + `test:api`.
- `.github/workflows/deploy-web.yml` — when `apps/web/**` changes → build + `wrangler pages deploy` (**`rbox-app` / `app.rbox.to`**), gated on `check` + `test`.
- `.github/workflows/release.yml` — on `v*` tags → build/sign/publish the `rbox` CLI binaries to R2 (unchanged).

Both deploy workflows need a repo secret **`CLOUDFLARE_DEPLOY_TOKEN`** scoped to **Workers Scripts:Edit + Cloudflare Pages:Edit** (+ Account:Read) for the account. Keep it DISTINCT from release.yml's R2-only `CLOUDFLARE_API_TOKEN` (least privilege). The account id is hard-coded in the workflows (not a secret).

**Support diagnostics:** `rbox doctor` / opt-in report upload (`POST /v1/diagnostics`), incl. how to retrieve reports from D1+R2 — see `docs/diagnostics.md`.

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
