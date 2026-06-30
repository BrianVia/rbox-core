# rbox — Go-Live TODO

Status as of 2026-06-29. Test/sandbox billing + Clerk provisioning are **done**;
the prod funnel (marketing → auth → checkout) is **live end-to-end**; the dashboard
has been **rebuilt on SvelteKit**, **CI/CD auto-deploys** on push to `main`, and
**GitHub + Google one-click sign-in** are wired. Remaining work is hardening +
the post-launch feature set (see the design-docs batch at the bottom).

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
- [x] **Frontend rebuild (SvelteKit + Vite + official Clerk components)** — **DONE 2026-06-29**, see the section below.

## ✅ Update 2026-06-29 (cont. 2) — SvelteKit rebuild, CI/CD, one-click OAuth
- [x] **Dashboard rebuilt on SvelteKit + Vite + Svelte 5 runes** (replaces the vanilla static SPA). `@sveltejs/adapter-static` (`fallback: index.html`), Pages `_redirects` + `_headers` (CSP). Clerk-js **v6** prebuilt sign-in/up component (loads the `@clerk/ui` bundle from the FAPI). Session-bound rbox-token cache keyed by Clerk session id with a refresh mutex + one-shot 401 retry. **Codex-reviewed → /simplify → /antislop-codebase**, merged to `main`, deployed to the `rbox-app` Pages project (`app.rbox.to`). `apps/web` package renamed `web-next → web`; vanilla dashboard retired.
- [x] **Subscribed-state UX fix** — plan buttons hide once `usage.plan !== 'free'`; paid users see **Manage billing** (portal) instead of a second-checkout path.
- [x] **CI/CD auto-deploy on push to `main`** (GitHub Actions):
  - `.github/workflows/deploy-api.yml` — `apps/api/**` → `wrangler deploy --env production` (`rbox-prod-api` / `api.rbox.to`), gated on typecheck + worker tests.
  - `.github/workflows/deploy-web.yml` — `apps/web/**` → build + `wrangler pages deploy` (`rbox-app` / `app.rbox.to`), gated on `check` + unit tests. Uses `npm install` (not `ci`) — macOS-generated lock fails strict `npm ci` on Linux (utf-8-validate optional dep).
  - `.github/workflows/release.yml` — `v*` tags → build/sign/publish the `rbox` CLI binaries to R2. **First CI-signed release `v0.1.0` shipped.**
  - Repo secret **`CLOUDFLARE_DEPLOY_TOKEN`** (Workers Scripts:Edit + Cloudflare Pages:Edit + Account:Read), distinct from release.yml's R2-only `CLOUDFLARE_API_TOKEN`. Dev-first workflow documented in `AGENTS.md`.
- [x] **One-click sign-in — GitHub + Google OAuth** (reduces signup friction; bot protection stays ON):
  - **GitHub** OAuth App live; **Google** via a dedicated GCP project (`rbox-500920`), consent screen published "In production", Web client `942927500825-…`, callback `https://clerk.rbox.to/v1/oauth_callback`.
  - Prod Clerk env confirms `oauth_github` and `oauth_google` both `enabled + authenticatable`; `app.rbox.to` sign-in renders both buttons. (Pending: a human one-click test of the Google button after the user pruned extra client secrets.)

## 📋 Backlog (your asks — not pressing)
- [x] **Rebuild `apps/web` as a real framework app (Svelte/SvelteKit + Vite)** — **DONE 2026-06-29** (see "cont. 2" above).
- [x] **CI/CD**: auto-build the `rbox` binaries (all platforms) + publish to R2 on tag/release; CLI self-update (`rbox upgrade`). — **DONE** via `release.yml` (`v0.1.0` shipped) + `rbox upgrade`.
- [ ] **Two-VM sync e2e test**: spin up two VMs/containers, have them pair + sync a tree both ways, assert convergence. The richest integration coverage (today: engine unit tests + Miniflare worker tests + the FakeRemote client suite + manual cross-host runs).

## 🎨 Post-launch features — designed, not yet built (2026-06-29)
Each spec is codex adversarially-reviewed; **design only** (except P1, now shipped). **Live status index: [`docs/design/README.md`](design/README.md).**
Cross-cutting prerequisites that gate this batch:
1. ✅ **DONE — `device_id` is now globally unique** (migration `0013`, commit `5ef4ba2`): global `UNIQUE(device_id)` reconciling the E2EE `device_keys` PK, 128-bit ids, mint-retry. **Apply `0013` to prod D1 when ready.**
2. **No web↔CLI account link** — web sign-in mints a *new* Clerk account and never links a pre-existing CLI/bootstrap account, so CLI-only accounts are currently un-notifiable and unmanageable from the dashboard.
3. **E2EE epoch *rotation operation* isn't built** — full E2EE is **merged to main** (migration 0011, `e2ee-*` CLI, `account_key_states`), and epoch *enforcement* works (commits gated on `x-rbox-account-epoch`, `epoch_stale` 409s). But genesis only ever writes **epoch 0** and `e2ee-remote.ts:146` notes "v1 has no rotation; never fires" — there is no operation that bumps the epoch + re-wraps MK for surviving devices + signs a new roster. So `revoked=1` stops *new* access but a leaked credential still decrypts *existing* data. This is the write-side rotate op, on main — not a cross-branch dependency.
4. **Credential-kind route gating (hardening)** — a web-session token is an ordinary `devices` row with the same `Principal` (no `kind`), so it can hit durable-mint routes (`pair/create`, `device/approve`, workspace-create): an ephemeral web session can mint *permanent* access. Fix specified in docs 20 + 21 (`Principal.kind` + default-deny route policy). Surfaced by doc 21's review.

- [ ] `docs/design/16-new-device-emails.md` — "new device added" security email. Outbound has **no Cloudflare-native path** (Email Workers only send to verified destinations). **DECISION 2026-06-29: stay all-Cloudflare → MailChannels Email API (paid)** on `security.rbox.to` (overrides the doc's Resend recommendation; provider-specific SPF/DKIM swapped at build time). Durable D1 outbox + Queues (no `ctx.waitUntil` in the worker's `fetch`).
- [ ] `docs/design/17-account-devices-workspaces.md` — read-only devices + workspaces list in the dashboard. New `GET /v1/account/devices|workspaces` (camelCase, paginated; **never** exposes `token_hash`); leaves the snake_case CLI endpoint untouched.
- [ ] `docs/design/18-support-email-routing.md` — `support@rbox.to → Gmail` via **Cloudflare Email Routing**. It's a **migration off Namecheap** (apex MX today; DMARC already `p=reject`); catch-all = **Drop**.
- [ ] `docs/design/19-device-revocation.md` — revoke from web + CLI (codex **PASS**, 4 rounds). **Access-revocation already works** (`authenticate()` enforces `revoked=0` since M4; `revokeDevice` + `rbox device revoke` exist) — but with **no role check** (a `viewer` can revoke the owner), `rbox logout` doesn't revoke server-side, web-revoke is undone by the SPA re-minting from the live Clerk session, and **cryptographic** revocation needs the unwired MK-rotation (prereq #3) + an account write-freeze.
- [ ] `docs/design/20-cli-api-keys.md` — headless `RBOX_KEY` for CI 1-shot sync. v1 is necessarily a **full E2EE device carrying MK** (the transport refuses non-roster sync); a leaked key is MK-equivalent → **do not GA before epoch rotation (prereq #3) ships.**
- [ ] `docs/design/21-account-linking.md` — web↔CLI account link (codex-reviewed). Confirmed the bug at `clerk.ts:121` (web login mints a fresh account, no reconciliation). Recommends **option A** (`rbox account link <code>`, CLI-canonical, possession-proven) **+ B** (web-first funnel). **Resolves prereq #2.** Highest-leverage — unblocks 16/17/19.

## ✅ Frontend + Clerk wiring (built autonomously 2026-06-27)
- [x] Worker `/v1/web/session`: verifies Clerk JWT (JWKS/RS256, hardened) → maps clerk user → rbox account/user → short-lived web session token. Codex-reviewed; 9 worker tests. (`apps/api/src/clerk.ts`, migration 0010)
- [x] Web dashboard `apps/web/` (static ClerkJS): sign-in → exchange → plan/usage → Subscribe + Manage-billing buttons.
- [x] Retention cron: scheduled `retention→mark→purge` daily (`wrangler.jsonc` triggers).
- [ ] **Deploy web-auth to a worker + set Clerk config** (`CLERK_ISSUER/JWKS/ALLOWED_ORIGINS/SECRET`) — pending (dev deploy next; prod with the prod env).
- [ ] **Decide where `apps/web` is hosted** (Cloudflare Pages vs local) → set `CLERK_ALLOWED_ORIGINS` to that exact origin (azp is enforced). Dev Clerk instance is `certain-ray-33.clerk.accounts.dev`.
- [ ] Real end-to-end sign-in test (needs a browser — your step).

## 📊 Perf & observability (post-dogfood, 2026-06-29)
See **`docs/benchmarking-and-observability.md`** for the full plan. Tracked work:
- [ ] **Observability instrumentation** — wrap R2/D1/commit in timing, emit to Workers Analytics Engine, dashboard commit-latency + commit-body-size + blobs/commit + missingBlobs ratio. ("What's slow in prod" without guessing.) Status + remaining work tracked in **`docs/design/observability-instrumentation.md`**.
- [ ] **Benchmark harness (Tier 1)** — fixtures (small/medium/large, with duplicate + empty files), sweep upload concurrency 8→64, measure cold push / cold clone / warm no-op + p50/p99 per-blob latency. Find the real optimal concurrency (16 was a blind default).
- [ ] **Commit-body scaling** — blobRefs are inlined in the *signed* commit body (~85B each); raised the cap to 1MB (≈12k blobs) but a 50k-file monorepo needs blobRefs moved OUT of the body into a side R2 object referenced by hash. Architectural — design + codex review first.
- [ ] (later) Two-machine Apple `container` Linux bench for real end-to-end convergence + Linux watcher validation.

## 🚧 Needs the human
- [ ] Point **`rbox.to` nameservers** at Cloudflare → custom domain `api.rbox.to` for `rbox-prod-api` (until then it's `rbox-prod-api.brian-via.workers.dev`)
- [ ] (Optional) create `acct_1Tn2iO` **test-mode** catalog too, so prod's test mode matches live (today test billing uses the separate `acct_1Tn3UN` sandbox)
- [ ] Revoke the live restricted key's **Products/Prices write** after catalog setup if you want the runtime key minimal (currently broader than needed)

## Notes
- Secrets never go in git/chat. Live secret key → `wrangler secret put` only. Publishable key is public.
- Stripe accounts in play: `acct_1Tn2iO` = main rbox account (Clerk + live billing); `acct_1Tn3UN` = "Rbox - Sandbox" (test billing verification only).
- Retention cron (retention→mark→purge) is built as an admin phase but not yet scheduled — pick a cadence and add a Cloudflare cron trigger.
