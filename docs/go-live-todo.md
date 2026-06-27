# rbox — Go-Live TODO

Status as of 2026-06-27. Test/sandbox billing + Clerk provisioning are **done**;
this is what's left to flip the switch to a real, paid, public product.

## ✅ Done (autonomous)
- [x] Stripe **test** billing built + live-verified in sandbox `acct_1Tn3UN` (checkout/portal/webhook, codex-reviewed, 18 Miniflare tests, deployed to `rbox-dev-api`).
- [x] Stripe **live catalog** created in `acct_1Tn2iO` (Solo/Pro/Team/Extra, same lookup_keys, `live=true`).
- [x] Clerk auth **provisioned** (`stripe projects add clerk/auth`, free tier, app "rbox"); creds in gitignored `.projects/vault` + `.env`.
- [x] Live **publishable** key recorded (`prod-keys.local.secret`, gitignored).
- [x] Live **restricted** key verified (Prices R/W, Checkout W, Portal W, Customers R/W, Subscriptions R, Webhook Endpoints W) — in `/tmp/rbox-stripe-prod-live-restricted-key`.

## 🚧 Go-live: prod environment (agent can do on "go" — creates real CF resources)
- [ ] Create `rbox-prod-db` (D1) + `rbox-prod-blobs` (R2)
- [ ] Add `[env.production]` to `apps/api/wrangler.jsonc` (own DO + bindings) → worker `rbox-prod-api`
- [ ] Run all D1 migrations on prod DB; deploy `rbox-prod-api`
- [ ] Register live Stripe **webhook endpoint** at `…rbox-prod-api…/v1/stripe/webhook` → capture its `whsec_`
- [ ] `wrangler secret put --env production`: `STRIPE_SECRET` (live restricted key), `STRIPE_WEBHOOK_SECRET` (live whsec), `RBOX_BOOTSTRAP_SECRET`, `RBOX_PLATFORM_SECRET`
- [ ] Live-verify: real checkout URL + a real signed webhook event recorded (as done for test)

## 🚧 Frontend (makes billing + Clerk actually reachable)
- [ ] Web dashboard: Clerk sign-in → "Subscribe" buttons hitting `/v1/billing/checkout` + portal
- [ ] Worker: validate Clerk session JWTs → map Clerk user → rbox account/user (CLI device-auth/pairing stays for machines)
- [ ] Wire the live **publishable** key into the frontend

## 🚧 Needs the human
- [ ] Point **`rbox.to` nameservers** at Cloudflare → custom domain `api.rbox.to` for `rbox-prod-api` (until then it's `rbox-prod-api.brian-via.workers.dev`)
- [ ] (Optional) create `acct_1Tn2iO` **test-mode** catalog too, so prod's test mode matches live (today test billing uses the separate `acct_1Tn3UN` sandbox)
- [ ] Revoke the live restricted key's **Products/Prices write** after catalog setup if you want the runtime key minimal (currently broader than needed)

## Notes
- Secrets never go in git/chat. Live secret key → `wrangler secret put` only. Publishable key is public.
- Stripe accounts in play: `acct_1Tn2iO` = main rbox account (Clerk + live billing); `acct_1Tn3UN` = "Rbox - Sandbox" (test billing verification only).
- Retention cron (retention→mark→purge) is built as an admin phase but not yet scheduled — pick a cadence and add a Cloudflare cron trigger.
