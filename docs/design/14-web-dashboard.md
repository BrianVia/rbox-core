# Design 14 — Web dashboard rebuild (SvelteKit + Vite)

**Status:** v1 — DESIGN, pending codex adversarial review.

Replace the hand-rolled vanilla `apps/web/` dashboard (`index.html` + `config.js`
+ `app.js`, no build step) with a typed **SvelteKit + Vite** app, deployed as a
static bundle to the existing **`rbox-app` Pages project** (`app.rbox.to`). No
worker, domain, or Clerk-instance changes — this is a frontend swap behind the
same origin.

## 1. Motivation — what the vanilla version cost us

The funnel works today, but every bug in the 2026-06-29 bring-up traced to the
frontend being unstructured (see `docs/go-live-todo.md`):

- **Hardcoded Clerk instance in HTML.** The ClerkJS `<script>` pinned a specific
  publishable key + FAPI host; when the Clerk app was consolidated, sign-in broke
  ("Missing token") until the tag was rewritten.
- **No build step → cache bugs.** `app.js`/`config.js` shipped under stable names,
  so browsers + the Pages edge served stale JS after deploys ("endless Loading…").
- **`mountSignIn` can't drive Client Trust.** The prebuilt component reset on
  `needs_client_trust` (password sign-in, new device) instead of prompting for the
  email code. A single-call `signIn.create({identifier,password})` happens to
  complete, but the component path dead-ends.
- **`location.hostname` config sniffing** to pick prod vs dev — fragile.
- **No types, no API client, no tests** for the browser surface.

A real app structure fixes the whole class, not the instances.

## 2. Goals / non-goals

**Goals**
- Typed components + routing; no hand-rolled DOM.
- A sign-in flow that **correctly handles Clerk's full status machine**, including
  `needs_client_trust` and `needs_second_factor` (the email-code steps the vanilla
  mount drops).
- Per-environment config via Vite env vars (no host sniffing).
- Hashed asset filenames so deploys propagate immediately (kills the cache dance).
- Same deploy target: static bundle → `rbox-app` Pages → `app.rbox.to`.

**Non-goals**
- No change to the worker API, Clerk instances, DNS, or Stripe wiring.
- No SSR / server routes (the worker is the backend; the dashboard is a pure SPA).
- No Team-management UI yet (Team is "coming soon"; out of scope until per-seat
  billing + invites exist).

## 3. Stack

- **SvelteKit + Vite**, `@sveltejs/adapter-static` (pure SPA, `fallback: index.html`).
  Output is plain static assets → `wrangler pages deploy` to `rbox-app`, identical
  to how `rbox-home` ships. No `adapter-cloudflare` / Pages Functions — there is no
  server side.
- **`@clerk/clerk-js`** loaded directly (NOT the prebuilt `<SignIn/>` mount). We
  drive the sign-in resource ourselves so Client Trust is handled. Rationale: the
  prebuilt component already failed us on exactly this status; owning the flow is
  the point of the rebuild.
- TypeScript throughout. `svelte-check` in CI.

## 4. Routes

SPA routes (hash-free, client-rendered):

- `/` — if signed out, the sign-in view; if signed in, redirect to `/dashboard`.
- `/dashboard` — plan + usage (storage bar, workspaces, retention) + plan buttons
  (Solo/Pro purchasable; Team disabled "coming soon") + Manage-billing + Sign-out.
  Honors `?plan=solo|pro` deep-link (start that checkout after auth — port the
  existing intent-stash behavior).
- `/billing/success`, `/billing/cancel` — post-Stripe landing (the worker's
  `success_url`/`cancel_url` already point at `${appUrl}/billing/*`; align these).

## 5. Auth flow (the part that must be right)

A `clerk.ts` module wraps `@clerk/clerk-js`:

1. Load ClerkJS for `VITE_CLERK_PUBLISHABLE_KEY` (FAPI host derived from the key).
2. Sign-in is a **custom flow** over `clerk.client.signIn`:
   - `create({ identifier, password })`.
   - Switch on `status`:
     - `complete` → `setActive({ session: createdSessionId })`.
     - `needs_client_trust` **or** `needs_second_factor` → find the `email_code`
       factor → `prepareSecondFactor({ strategy:"email_code", emailAddressId })` →
       collect the code (UI step) → `attemptSecondFactor({ strategy:"email_code",
       code })` → on `complete`, `setActive`.
     - `needs_first_factor` (passwordless / when password unset) → `email_code`
       first-factor path (`prepareFirstFactor`/`attemptFirstFactor`).
   - Surface every Clerk error to the user (no silent resets — the vanilla bug).
3. Offer a "sign in with email code instead" path (passwordless) — it sidesteps
   Client Trust entirely (Client Trust only triggers on password sign-ins) and is
   better UX for a dev tool. Optional v1, but cheap once the factor machinery exists.
4. After a session is active → exchange for an rbox token (§6).

> Open question for review: should we keep `@clerk/clerk-js` custom flow, or adopt
> the community **`svelte-clerk`** SDK + prebuilt components and only fall back to a
> custom flow for Client Trust? Custom-everything is more code but no black box.

## 6. API client (`api.ts`)

Typed wrapper over the worker (all cross-origin to `VITE_API_BASE`, CORS already
allowlisted by `CLERK_ALLOWED_ORIGINS`):

- `POST /v1/web/session { token }` → `{ token, accountId }` (Clerk JWT → rbox token;
  cache in `sessionStorage`, re-exchange on 401).
- `GET /v1/account/usage` → `{ plan, usedBytes, storageCap, workspaces, workspaceCap,
  retentionDays }`.
- `POST /v1/billing/checkout?plan=solo|pro` → `{ url }` (redirect to Stripe).
- `POST /v1/billing/portal` → `{ url }`.

Bearer auth via the rbox token (not cookies), matching today.

## 7. Config / environments

Vite env vars, committed as `.env.production` / `.env.development` (publishable keys
+ API base are PUBLIC — safe to commit; no secrets):

```
# .env.production
VITE_API_BASE=https://api.rbox.to
VITE_CLERK_PUBLISHABLE_KEY=pk_live_…        # clerk.rbox.to
# .env.development
VITE_API_BASE=https://rbox-dev-api.brian-via.workers.dev
VITE_CLERK_PUBLISHABLE_KEY=pk_test_…        # cosmic-phoenix-51
```

`vite build --mode production` for the Pages deploy; `vite dev` uses the dev mode.
No `location.hostname` branching.

## 8. Deployment

- `npm run build` → static output (e.g. `build/`).
- `wrangler pages deploy build --project-name rbox-app --branch main` — same project
  serving `app.rbox.to` today, so the custom domain + cert are untouched.
- Cutover: deploy the SvelteKit build over the same project; the vanilla files are
  replaced by the new bundle in one deploy. Keep the old `apps/web/` in git history;
  the new app lives at `apps/web/` (replaced) or a new `apps/dashboard/` (decide in
  review — see §10).

## 9. Testing

- `svelte-check` (types) + a Vitest unit test for the sign-in status machine
  (`complete` / `needs_client_trust` / `needs_second_factor` branching) and the API
  client's 401 re-exchange — the control-flow that actually broke. No tests for
  trivially-typed render output.
- Manual: agent-browser e2e against `app.rbox.to` (the exact flow already verified:
  sign in → usage → `cs_live` checkout), using `TEST_CREDENTIALS`.

## 10. Open questions (for codex review)

1. **Directory:** replace `apps/web/` in place, or add `apps/dashboard/` and delete
   `apps/web/` at cutover? (Monorepo already has `apps/api`, `apps/web`.)
2. **Clerk SDK:** `@clerk/clerk-js` custom flow (full control, more code) vs
   `svelte-clerk` + prebuilt components (less code, but it's what fumbled Client
   Trust). Lean: custom flow for sign-in, since that's the whole motivation.
3. **Passwordless default:** make email-code the primary sign-in (sidesteps Client
   Trust, no password management) and keep password as secondary? Better UX, but
   changes the auth story.
4. **adapter-static SPA fallback** vs prerender — any Pages routing gotchas for
   `/dashboard` deep links + `?plan=` query on a static fallback?
5. Should the worker's `success_url`/`cancel_url` (`${appUrl}/billing/*`) be
   realigned to the new `/billing/success|cancel` routes now, or kept?

## 11. Rollback

The vanilla dashboard is in git history; a single `wrangler pages deploy` of the
prior `apps/web/` restores it. No data/schema involved — pure static asset swap.
