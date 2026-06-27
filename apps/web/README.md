# rbox web dashboard

A minimal static SPA (no build step) for managing an rbox account: sign in with
Clerk, view plan + usage, subscribe to a plan, or open the billing portal.

Stack: plain HTML/CSS + vanilla ES modules, ClerkJS via CDN, `fetch` against the
rbox API. No npm install, no bundler.

## Files

- `index.html` — markup, CSS, loads `config.js` + ClerkJS + `app.js`.
- `config.js` — `window.RBOX_CONFIG` (`apiBase`, `clerkPublishableKey`). The
  publishable key is a public `pk_test_...` value, safe to embed.
- `app.js` — sign-in detection, token exchange, usage render, button handlers.

## Run locally

It must be **served** over HTTP (ES modules + Clerk won't work from `file://`):

```bash
cd apps/web
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static server works (`npx serve`, `caddy file-server`, etc.).

> Note: Clerk's allowed origins must include your local origin
> (`http://localhost:8000`) for sign-in to complete. Add it in the Clerk
> dashboard if you hit an origin/redirect error.

## How it works

1. ClerkJS loads from the CDN using the publishable key (the Clerk frontend API
   host `certain-ray-33.clerk.accounts.dev` is derived from the key).
2. Signed-out → Clerk's `<SignIn />` is mounted.
3. Signed-in → the app gets the Clerk session JWT (`Clerk.session.getToken()`)
   and `POST`s it to `{API}/v1/web/session`, receiving an rbox device token
   (cached in `sessionStorage`).
4. That rbox token is sent as `Authorization: Bearer <token>` to:
   - `GET /v1/account/usage` — plan + usage figures
   - `POST /v1/billing/checkout?plan=solo|pro|team` — returns `{ url }`, redirect
   - `POST /v1/billing/portal` — returns `{ url }`, redirect

## API base

`https://rbox-dev-api.brian-via.workers.dev`

**`/v1/web/session` must be live on the worker for sign-in to complete.** If the
endpoint returns 404/501, the dashboard shows "web auth isn't enabled on the API
yet" instead of breaking — the rest of the flow is ready once it's deployed.

## Deploy (later)

Deployable as-is to Cloudflare Pages (or any static host): point it at this
directory, no build command. Set the production `apiBase` / publishable key in
`config.js` (or swap in prod values at deploy time).
