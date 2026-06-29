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

## ✅ Update 2026-06-29
- [x] **`rbox.to` custom domain is LIVE** — `https://rbox.to` + `https://rbox.to/install.sh` both serve 200 (marketing site on the `rbox-home` Pages project). The item below is done.
- [x] **Marketing site under version control** — `../rbox-home-page` was untracked; now a **private repo `BrianVia/rbox-home`**. Pricing/quotas verified to match `apps/api/src/plans.ts`; removed dead links (wrong `github.com/rbox`, 4× nonexistent `docs.rbox.to`).
- [x] **Prod Clerk instance PROVISIONED** — one Clerk app `rbox` (dev + **production**), domain `rbox.to`, Frontend API `https://clerk.rbox.to`. Creds in gitignored `.projects/vault`+`.env`. Sign into the Clerk dashboard with `stripe projects open clerk` (account `brian.via.dev@gmail.com`).

## ✅ Update 2026-06-29 (cont.) — prod web auth + dashboard LIVE
- [x] **Clerk prod DNS** — all 5 CNAMEs added to the `rbox.to` zone via the Cloudflare API (DNS-only). Clerk shows **Verified + SSL Issued**; `https://clerk.rbox.to/.well-known/jwks.json` serves the prod instance key (`ins_3Fom8QRdPwh9I0…`).
- [x] **Prod worker secrets set** on `rbox-prod-api`: `CLERK_ISSUER=https://clerk.rbox.to`, `CLERK_SECRET_KEY` (sk_live), `CLERK_ALLOWED_ORIGINS=https://app.rbox.to`. Verified: `POST https://api.rbox.to/v1/web/session` now returns **401 (configured)**, not 501.
- [x] **Dashboard deployed** — `apps/web` → Pages project **`rbox-app`** (`rbox-app.pages.dev`), with **`app.rbox.to`** custom domain attached. `config.js` is host-aware (prod = `api.rbox.to` + `pk_live`; localhost = dev worker + dev `pk_test`). Clerk prod `allowed_origins` includes `https://app.rbox.to`.
- [x] **Marketing CTAs now resolve** — every "Sign in"/paid button on `rbox.to` points at `app.rbox.to`, which is now live → signup→authenticated-checkout funnel is wired end to end.

### Follow-ups (non-blocking)
- [x] **Dev Clerk drift** fixed: `rbox-dev-api` CLERK_* secrets repointed to `cosmic-phoenix-51`.
- [x] **Full prod funnel VERIFIED end-to-end (2026-06-29)** via agent-browser: sign in → `/v1/web/session` exchange → usage renders (`0 B / 250 GB`) → click Solo → **live `cs_live_…` Stripe checkout**. Bugs found + fixed along the way:
  - Worker had **no CORS** → all `app.rbox.to → api.rbox.to` fetches failed. Added CORS (preflight + allowlisted via CLERK_ALLOWED_ORIGINS).
  - ClerkJS loaded **legacy v4** (`@latest`) → couldn't drive prod client-trust. Pinned **v5** + added `#clerk-captcha` mount.
  - **Client Trust** attack-protection (can't be disabled in dash) forces email-code on password sign-in *via the prebuilt component's two-step*; a single-call `signIn.create({identifier,password})` completes directly. Prebuilt vanilla mount handles `needs_client_trust` poorly → motivates the SvelteKit rebuild.
  - Prod + dev D1 were missing **migration `0012_billing_grace.sql`** (`grace_until`) → `/v1/account/usage` 500. Applied to both.
- [ ] **Frontend rebuild (SvelteKit + Vite + official Clerk components)** — see backlog; today's vanilla static dashboard caused most of the friction (hardcoded keys, no CORS awareness, no build/cache-busting, weak client-trust handling).

## 📋 Backlog (your asks — not pressing)
- [ ] **Rebuild `apps/web` as a real framework app (Svelte/SvelteKit + Vite)** — today it's a deliberately zero-build vanilla-JS static SPA (`index.html` + `config.js` + `app.js`). Fine for the current single-page dashboard, but it'll get unwieldy as account/billing UI grows (esp. Team management: member invites, roles, per-seat). A SvelteKit+Vite app buys components, routing, typed state, and a proper ClerkJS/`@clerk` integration. Do this when Team work starts; keep it deployed to the same `rbox-app` Pages project. (Deferred 2026-06-29.)
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
