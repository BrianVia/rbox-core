# Design 11 — Web auth (Clerk) + dashboard

**Status:** v2 — revised after codex security review (NEEDS-PASS → resolved).

### Resolutions to codex must-fix
1. **Short-lived web session, not a durable device token.** `/v1/web/session`
   mints a token with **`expires_at` = now+1h**; `authenticate()` enforces
   `(expires_at IS NULL OR expires_at > now)` (CLI device tokens keep NULL =
   no expiry). The browser re-exchanges the (auto-refreshing) Clerk token when
   it gets a 401. (§3, §5)
2. **Atomic, orphan-free first-login.** The `clerk_users` `INSERT OR IGNORE` is
   the gate: candidate account/user ids are generated, inserted into
   `clerk_users` first; we then re-`SELECT` the authoritative row (winner's ids)
   and `INSERT OR IGNORE` account/user/membership for *those* ids only — so a
   lost race never materializes an orphan account, and the membership exists
   before any token is minted. (§3)
3. **Abuse control.** First-login requires a **verified primary email** (Clerk
   Backend API, `email_verified`) when `CLERK_SECRET_KEY` is set; short-TTL
   tokens + the browser's session cache cap minting to ~1/hour/user. (Per-IP/sub
   rate-limiting needs KV/DO — noted as a follow-up, not built now.) (§3)
4. **Hardened JWT validation:** require header `alg==="RS256"` + a `kid`; reject
   any token-supplied `jku`/`x5u` (we only ever use our configured JWKS URL +
   `kid` match, no fallback key); `sub` a non-empty string; `exp`/`nbf` finite
   numbers (seconds) with 5s leeway; `iss` an exact match to the server constant;
   `azp` must be present AND in the allowlist; throttle unknown-`kid` JWKS
   refetch (≥30s between forced refetches) to prevent fetch amplification. (§2)
Confirmed by review: verifying over the raw `${headerB64}.${payloadB64}` bytes is
correct (decode only the signature); `azp`-reject-absent is correct for a
browser-only route — every allowlisted origin is fully trusted, so prod must NOT
include dev/preview origins.

---


**Implements:** the "Clerk web wiring" + "frontend" items in `docs/go-live-todo.md`.
Turns the *provisioned* Clerk into actual web signup/login that maps to rbox
accounts and lets a user subscribe via the existing billing routes. CLI device
auth (`login`/`pair`/device-code) is unchanged — this is the web/dashboard path.

## 0. Provisioned Clerk instance (dev)
- Frontend API host: `certain-ray-33.clerk.accounts.dev`
- Issuer: `https://certain-ray-33.clerk.accounts.dev`
- JWKS: `https://certain-ray-33.clerk.accounts.dev/.well-known/jwks.json`
- `pk_test_…` (public) + `sk_test_…` (secret, in gitignored vault/.env)
- (A prod Clerk env is created later alongside `rbox.to`.)

## 1. Flow

```
Browser (apps/web, ClerkJS) ── sign in ──▶ Clerk
   │  Clerk.session.getToken()  → short-lived session JWT (RS256)
   ▼
POST /v1/web/session  { token }            (worker, PUBLIC route)
   │  verify JWT (JWKS/RS256, iss, exp/nbf, azp); sub = clerk user id
   │  upsert rbox account+user keyed by clerk_user_id (idempotent)
   │  mint an rbox device token (label "web")
   ▼
{ token: <rbox device token>, accountId }
   │  browser stores it; uses as Bearer for the rbox API
   ▼
POST /v1/billing/checkout?plan=pro   → Stripe Checkout URL  (already built)
```

The Clerk JWT is **only** used to authenticate the `/v1/web/session` exchange;
the rbox device token it returns is what drives every subsequent API call (so
the web path reuses the existing `authenticate()` + Principal model unchanged).

## 2. Clerk JWT verification (the security core)

In the worker, no SDK — raw WebCrypto (`apps/api/src/clerk.ts`):
1. Split JWT; **require header `alg === "RS256"`** (reject `none`/others before any crypto — algorithm-confusion guard).
2. Fetch JWKS (cached in module scope + Workers Cache, ~1h TTL); match `kid`; **refetch once on unknown kid** (key rotation), then reject.
3. `crypto.subtle.importKey("jwk", jwk, {name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"}, false, ["verify"])`; `crypto.subtle.verify` over `${header}.${payload}` (base64url-decoded signature).
4. Claims (against SERVER-side constants, never the token's own): `iss` exact-match `CLERK_ISSUER`; `now ≤ exp + 5s`; `now ≥ nbf − 5s`; if `azp` present it MUST be in `CLERK_ALLOWED_ORIGINS` (origin-binding; absent azp policy = reject for the web route since it's always browser-originated).
5. Return `{ clerkUserId: sub }` on success; uniform 401 on any failure.

## 3. Account/user mapping (idempotent)

Migration `0010_clerk.sql`: `clerk_users(clerk_user_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at INTEGER)`.

`/v1/web/session` after verification:
- `SELECT account_id, user_id FROM clerk_users WHERE clerk_user_id = ?`.
- **Found** → that account/user (returning user).
- **Not found (first login)** → create account + user + owner membership (mirrors `bootstrap` but the *trust anchor is the verified Clerk JWT*, not a secret), then `INSERT INTO clerk_users …`. Race-safe: `INSERT OR IGNORE` then re-`SELECT`, so two concurrent first-logins converge on one account (the loser of the insert reads the winner's row).
- Mint a device token (`mintDevice`, label "web") into that account/user; return it.

Email (optional, for the account name): one Clerk **Backend API** call
`GET https://api.clerk.com/v1/users/{sub}` with `CLERK_SECRET_KEY`, cached; not
required for auth. MVP: name the account from email if fetched, else "web".

## 4. Frontend (`apps/web`)

Minimal static SPA (no framework lock needed): ClerkJS via CDN with the
publishable key →
- signed out: Clerk `<SignIn/>`.
- signed in: `getToken()` → `POST /v1/web/session` → store rbox token (memory/
  sessionStorage) → show plan/usage (`GET /v1/account/usage`) → **Subscribe**
  buttons (`POST /v1/billing/checkout?plan=…` → redirect to `.url`) + **Manage
  billing** (`/v1/billing/portal`). Static; deployable to Cloudflare Pages later.
- The publishable key + API base are build-time config (public).

## 5. Config (env)
`CLERK_ISSUER`, `CLERK_JWKS_URL` (derivable from issuer), `CLERK_SECRET_KEY`
(Backend API, optional), `CLERK_ALLOWED_ORIGINS` (csv azp allowlist, e.g.
`http://localhost:5173,https://rbox.to`). Set as Wrangler vars/secrets on the
dev worker. `/v1/web/session` 501s if `CLERK_ISSUER` unset (feature-gated).

## 6. Files
| File | Change |
|---|---|
| `apps/api/src/clerk.ts` | **new** — JWT verify (JWKS/RS256/claims) + `/v1/web/session` |
| `apps/api/src/worker.ts` | route: public `POST /v1/web/session` (exact allowlist) |
| `apps/api/src/auth.ts` | export `mintDevice` (or a small `createWebSession` helper) |
| `apps/api/src/env.ts` | CLERK_* vars |
| `apps/api/migrations/0010_clerk.sql` | `clerk_users` mapping |
| `apps/web/` | **new** — static dashboard (ClerkJS + checkout) |
| `apps/api/test/worker.test.ts` | JWT verify (good/forged/expired/alg-confusion), first-login-creates-once idempotency |

## 7. Verification
- **Unit/Miniflare:** sign a JWT with a test RSA key, host a stub JWKS; assert
  valid→200+token, bad-sig→401, `alg:none`→401, wrong `iss`→401, expired→401,
  bad `azp`→401. First-login creates exactly one account; second login reuses it;
  concurrent first-logins → one account. (Inject JWKS/issuer via test env.)
- **Live (no user):** can't do a real browser sign-in unattended — but verify the
  route gating (501 without config), JWKS fetch from the real dev instance, and
  the verification against a token minted by Clerk's test JWKS shape. Real
  end-to-end sign-in is a user step.
- `bun test src` + both `tsc` + `test:api` green; antislop + codex review clean.

## 8. Open questions for codex
1. Reusing the device-token model for web sessions — sound, or should web get a
   distinct shorter-lived session credential? (Device tokens are long-lived.)
2. First-login auto-provisioning an account from a verified Clerk JWT — any abuse
   (e.g. someone mass-creating Clerk users → mass rbox accounts)? Rate/limit?
3. `azp` absent policy for the web route (reject vs allow) — correct to reject?
4. Is minting a device token the right return, or should the browser keep using
   the Clerk token + a per-request verify (heavier but no second long-lived cred)?
5. Anything weaker than the CLI device-auth path it sits beside?
