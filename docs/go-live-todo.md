# rbox — Go-Live TODO

Status as of 2026-06-27. Test/sandbox billing + Clerk provisioning are **done**;
this is what's left to flip the switch to a real, paid, public product.

## ✅ Done (autonomous)
- [x] Stripe **test** billing built + live-verified in sandbox `acct_1Tn3UN` (checkout/portal/webhook, codex-reviewed, 18 Miniflare tests, deployed to `rbox-dev-api`).
- [x] Stripe **live catalog** created in `acct_1Tn2iO` (Solo/Pro/Team/Extra, same lookup_keys, `live=true`).
- [x] Clerk auth **provisioned** (`stripe projects add clerk/auth`, free tier, app "rbox"); creds in gitignored `.projects/vault` + `.env`.
- [x] Live **publishable** key recorded (`prod-keys.local.secret`, gitignored).
- [x] Live **restricted** key verified (Prices R/W, Checkout W, Portal W, Customers R/W, Subscriptions R, Webhook Endpoints W) — in `/tmp/rbox-stripe-prod-live-restricted-key`.

## ✅ Go-live: prod environment (done 2026-06-28)
- [x] `rbox-prod-db` (D1) + `rbox-prod-blobs` (R2) created
- [x] `[env.production]` → worker **`rbox-prod-api`** at **`api.rbox.to`** (custom domain live; rbox.to NS now on Cloudflare) + workers.dev fallback + daily cron
- [x] All migrations applied to prod D1; deployed
- [x] Live Stripe **webhook** registered at `api.rbox.to/v1/stripe/webhook` (live mode)
- [x] Prod secrets set: `STRIPE_SECRET` (live restricted key), `STRIPE_WEBHOOK_SECRET`, fresh `RBOX_BOOTSTRAP_SECRET`/`RBOX_PLATFORM_SECRET` (recorded in `prod-keys.local.secret`), `RBOX_APP_URL`
- [x] Verified: `api.rbox.to/health` 200, prod bootstrap, **live `cs_live_…` checkout URL** (no charge), forged webhook → 400
- [x] **One-line installer** live: `curl -fsSL https://api.rbox.to/install.sh | sh` (binaries for darwin/linux × arm64/x64 served from R2; verified end-to-end)
- [x] **Marketing site** built (`../rbox-home-page`, Astro 5) + deployed to Pages (`rbox-home.pages.dev`)

## 🚧 Remaining (need you — Cloudflare dashboard DNS, wrangler can't)
- [ ] **Add `rbox.to` custom domain** to the `rbox-home` Pages project (Workers&Pages → rbox-home → Custom domains) → makes `rbox.to` + `rbox.to/install.sh` live. (Installer works at `api.rbox.to/install.sh` today.)
- [ ] **Prod Clerk instance**: provision a production Clerk instance for the domain (needs Clerk DNS CNAMEs added to the zone) → set `CLERK_*` `--env production`. Until then web sign-in 501s on prod (CLI auth + billing work).
- [ ] **App dashboard**: deploy `apps/web` to Pages (e.g. `app.rbox.to`); point it at `api.rbox.to`; set `CLERK_ALLOWED_ORIGINS` to that origin. (Today `apps/web` → the dev worker for safe test-mode trials.)

## 📋 Backlog (your asks — not pressing)
- [ ] **CI/CD**: auto-build the `rbox` binaries (all platforms) + publish to R2 on tag/release; CLI self-update (`rbox upgrade`). (Today binaries are built locally with `bun build --compile` and uploaded by hand.)
- [ ] **Two-VM sync e2e test**: spin up two VMs/containers, have them pair + sync a tree both ways, assert convergence. The richest integration coverage (today: engine unit tests + Miniflare worker tests + the FakeRemote client suite + manual cross-host runs).

## ✅ Frontend + Clerk wiring (built autonomously 2026-06-27)
- [x] Worker `/v1/web/session`: verifies Clerk JWT (JWKS/RS256, hardened) → maps clerk user → rbox account/user → short-lived web session token. Codex-reviewed; 9 worker tests. (`apps/api/src/clerk.ts`, migration 0010)
- [x] Web dashboard `apps/web/` (static ClerkJS): sign-in → exchange → plan/usage → Subscribe + Manage-billing buttons.
- [x] Retention cron: scheduled `retention→mark→purge` daily (`wrangler.jsonc` triggers).
- [ ] **Deploy web-auth to a worker + set Clerk config** (`CLERK_ISSUER/JWKS/ALLOWED_ORIGINS/SECRET`) — pending (dev deploy next; prod with the prod env).
- [ ] **Decide where `apps/web` is hosted** (Cloudflare Pages vs local) → set `CLERK_ALLOWED_ORIGINS` to that exact origin (azp is enforced). Dev Clerk instance is `certain-ray-33.clerk.accounts.dev`.
- [ ] Real end-to-end sign-in test (needs a browser — your step).

## 🚧 Needs the human
- [ ] Point **`rbox.to` nameservers** at Cloudflare → custom domain `api.rbox.to` for `rbox-prod-api` (until then it's `rbox-prod-api.brian-via.workers.dev`)
- [ ] (Optional) create `acct_1Tn2iO` **test-mode** catalog too, so prod's test mode matches live (today test billing uses the separate `acct_1Tn3UN` sandbox)
- [ ] Revoke the live restricted key's **Products/Prices write** after catalog setup if you want the runtime key minimal (currently broader than needed)

## Notes
- Secrets never go in git/chat. Live secret key → `wrangler secret put` only. Publishable key is public.
- Stripe accounts in play: `acct_1Tn2iO` = main rbox account (Clerk + live billing); `acct_1Tn3UN` = "Rbox - Sandbox" (test billing verification only).
- Retention cron (retention→mark→purge) is built as an admin phase but not yet scheduled — pick a cadence and add a Cloudflare cron trigger.
