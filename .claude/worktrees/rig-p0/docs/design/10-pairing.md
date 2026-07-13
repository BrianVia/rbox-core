# Design 10 — Pairing Tokens (low-friction "connect a new machine")

**Status:** v2 — IMPLEMENTED. Codex security review (NEEDS-PASS → all 5 resolved).
Verified by 7 Miniflare integration tests (real D1): create-requires-auth,
create→redeem mints a same-account device, single-use (2nd redeem 401),
malformed/unknown 401, expired 401, **revoked-creator → token dead at redeem**,
**active-cap → 429**. Client: `rbox pair` + menu paste-token path + headless
`RBOX_PAIR_TOKEN` (never argv).

### Resolutions to codex must-fix (v1 → v2)
1. **Revoke cuts off outstanding tokens (live re-validation).** Redeem does NOT
   trust the create-time snapshot. After the atomic single-use consume it
   re-checks, fail-closed: the `created_by` device is still **non-revoked** AND
   `user_id` still has a **live membership** in the account. A compromised
   device that's since been revoked can't mint via its leftover tokens. (§1, §3)
2. **Non-null membership.** `pairing_tokens.user_id` is **NOT NULL**;
   `pair/create` is **rejected (403)** for any principal without a real
   membership (no legacy `default`/viewer-by-absence path). The redeemed device
   inherits that user's membership/role. (§1, §3)
3. **Atomic consume + snapshot via `UPDATE … RETURNING`.** One statement
   consumes (single-use gate: `consumed_at IS NULL AND expires_at > now`) and
   returns `account_id, user_id, created_by`. Token/label format is validated
   BEFORE consume; a post-consume mint failure is logged and fails closed (token
   burned, no credential — availability loss, never escalation). (§3)
4. **No token in argv.** Dropped `rbox login --pair <token>` (shell history /
   process args leak). Redeem reads the token **interactively (paste)**, or for
   headless via **stdin** (`rbox connect --pair-stdin`) / `RBOX_PAIR_TOKEN` env.
   Token is redacted from any log/error. (§4)
5. **Caps are required, not optional.** `pair/create` enforces a per-account
   **active-token cap** (≤5 unconsumed, unexpired) → 429 over cap. (Request-rate
   limiting is an operational follow-up; the active cap bounds the foothold.) (§3)
Wording fix: the redeem lookup is an indexed equality on `token_hash` (not
"constant-time") — acceptable because the token is unguessable (32 bytes).

---


**Implements:** the agreed fast-follow to the onboarding menu (M7c). Adds a second
"Connect this machine" path: generate a pairing token on an already-signed-in
machine (`rbox pair`), paste it on the new machine, which redeems it for its own
device credential — no hopping back to approve a device-code.

## 0. Why a second path (vs M4 device-code)

- **Device-code (M4):** the NEW machine generates a code; an already-signed-in
  machine *approves* it. The authorization decision happens on the trusted
  machine — good, but it forces the user to go back to the old machine and run
  `rbox approve <code>` against a specific code.
- **Pairing token (this):** the already-signed-in (trusted) machine *generates*
  the token; generating it IS the authorization (only an authenticated device
  can). The new machine merely *redeems* it. Same trust property — the decision
  is still made on an already-authenticated device — but the redeem is a single
  paste with no round-trip back. Both paths coexist under the menu's "Connect".

## 1. Security model (the part to attack)

A pairing token is a **bearer credential that mints a device token for an
account** — treat it like a short-lived secret. Properties, mirroring M4 device
tokens:

1. **High-entropy:** 32 random bytes (CSPRNG), base64url. Infeasible to guess.
2. **Hashed at rest:** server stores `sha256(token)` only; plaintext is shown
   once on the generating machine and never persisted (same as device tokens).
3. **Short TTL:** default **10 minutes**. Redeem rejects expired (server clock).
4. **Single-use (atomic):** redeem succeeds via a conditional
   `UPDATE … SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND
   expires_at>?` — only the row-winning redeem mints a credential. Replays and
   concurrent double-redeems get 0 rows changed → 410/401. (Same one-time-claim
   pattern as the device-code poll, `auth.ts`.)
5. **Account/user-scoped at creation:** `pair/create` runs as an authenticated
   device; the token is bound to *that device's* `account_id` + `user_id`. The
   redeemed device joins **the same account as the same user** (you're adding
   your own machine) → it inherits that user's membership/role. No privilege
   escalation: a viewer's pairing token yields another viewer device.
6. **Bounded blast radius:** even if a token leaks, it's one device on one
   account, single-use, ≤10 min, and revocable like any device (`rbox device
   revoke`). Optional: cap outstanding un-redeemed tokens per account (e.g. 5)
   to limit a create-spam foothold.
7. **Constant-time / hashed lookup:** redeem looks up by `token_hash` (a hash
   equality in the DB index); no plaintext compare. No user-enumeration signal
   (uniform 401 for bad/expired/consumed).

**Explicitly out of scope / accepted:** the token transits via user copy-paste
(terminal scrollback). Short TTL + single-use + revocability is the mitigation;
we document "treat it like a password, it expires in 10 min."

## 2. Schema — migration `0008_pairing.sql`

```sql
CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash  TEXT PRIMARY KEY,   -- sha256(plaintext); plaintext never stored
  account_id  TEXT NOT NULL,
  user_id     TEXT,               -- the user adding the machine (role inherited)
  created_by  TEXT NOT NULL,      -- device_id that generated it (audit)
  label       TEXT,
  created_at  INTEGER NOT NULL,   -- epoch ms
  expires_at  INTEGER NOT NULL,   -- epoch ms
  consumed_at INTEGER             -- NULL until redeemed (single-use gate)
);
```

No new index needed (PK on `token_hash` is the lookup).

## 3. Endpoints

- **`POST /v1/auth/pair/create`** — *authenticated* (any valid device token).
  Generates a token, stores `sha256(token)` with the caller's `account_id` +
  `user_id` + `device_id`, `expires_at = now + 10min`. Returns
  `{ token, expiresAt }` (plaintext token once). Optional outstanding-token cap →
  429 if exceeded.
- **`POST /v1/auth/pair/redeem`** — *public* (like `bootstrap`/device `start`).
  Body `{ token, label }`. Computes `sha256(token)`, runs the atomic single-use
  UPDATE; on win, `mintDevice(account_id, user_id, newDeviceId, label)` and
  returns `{ token: <device token>, deviceId }`. On miss → **401** (uniform for
  invalid/expired/consumed). Added to the worker's EXACT public-route allowlist
  (not a wildcard), alongside `bootstrap`/`start`/`poll`.

Both reuse `auth.ts` helpers (`sha256Hex`, `mintDevice`, the authenticated
`Principal` for create).

## 4. Client

- **`rbox pair`** — authenticated; calls `pair/create`, prints:
  ```
  Pairing token (valid 10 min, single use):
      rbox-pair_<token>
  On the new machine: run `rbox`, choose "Connect this machine", paste this.
  ```
- **Menu "Connect this machine"** now offers both: (a) approve a device-code on
  another machine [M4], or (b) **paste a pairing token**. The redeem path:
  `pair/redeem` → save credentials (`~/.rbox/credentials.json`, 600) → then
  `init --workspace`. Also exposed headlessly as `rbox login --pair <token>`.
- `credentials.ts` / `saveCredentials` unchanged — the redeemed device token is
  stored exactly like a device-code or bootstrap token.

## 5. Files

| File | Change |
|---|---|
| `apps/api/migrations/0008_pairing.sql` | **new** — `pairing_tokens` |
| `apps/api/src/auth.ts` | **+** `createPairToken(env, principal)` , `redeemPairToken(req, env)` |
| `apps/api/src/worker.ts` | routes: authed `pair/create`, public `pair/redeem` (exact allowlist) |
| `src/cli/auth-cmd.ts` | `pairCreate()` (`rbox pair`), `loginWithPair(token)` |
| `src/cli/menu-cmd.ts` | "Connect" offers paste-token alongside device-code |
| `src/cli/index.ts` | `pair` command + `login --pair <token>` |
| `apps/api/test/worker.test.ts` | redeem happy-path, single-use, expiry, bad-token 401, role inheritance |

## 6. Verification

- **Worker tests (Miniflare, real D1):** create (authed) → redeem mints a device
  whose token authenticates; **single-use** (second redeem → 401, 0 rows);
  **expired** token → 401 (insert with past `expires_at`); **bad token** → 401;
  **role inheritance** (redeemed device's principal role == creator's);
  `pair/create` **unauthenticated → 401**; `pair/redeem` is public.
- **Live:** `rbox pair` on host A → paste on host B's menu → B authed + synced.
- `bun test src` + both `tsc` + antislop clean.

## 7. Open questions for codex

1. Is "generating device's act = authorization" sound, or should redeem also
   re-check the *creating* device isn't revoked at redeem time (so revoking the
   source device invalidates its outstanding pairing tokens)?
2. Role inheritance: mint the new device under the creator's `user_id` (same
   person, same role) — correct, or should pairing default to a lower role?
3. TTL (10 min) + single-use enough, or also cap outstanding tokens per account
   / per device, and/or rate-limit `pair/create`?
4. Uniform 401 vs distinct expired/consumed responses — does a distinct "expired,
   generate a new one" message leak anything meaningful, or is the UX worth it?
5. Anything that makes this WEAKER than the M4 device-code path it sits beside?
