# Design 04 — Real Auth: Self-Hosted Device Tokens (Milestone 4)

**Status:** ✅ IMPLEMENTED & VERIFIED. Revised per codex security review (NEEDS-PASS → resolved). Verified live: 15/15 auth-flow (cleartext token now 401, bootstrap, device-to-device approval, one-time token claim, immediate revocation, /health public) + 7/7 daemon e2e via the device-token credential. The old shared token is inert server-side. Key fixes applied in implementation: **approve only marks approved; the FIRST poll atomically mints + one-time-claims the token** (status `pending→approved→claimed` via conditional UPDATE; plaintext never stored, returned once, only to the new device); constant-time bootstrap-secret compare + CSPRNG 32-byte tokens; `last_seen_at` throttled (~10 min); revocation immediate via per-request hash lookup; **exact** public routes (`/health`, `/v1/auth/device/start|poll|bootstrap`) not a wildcard; all old `RBOX_DEV_TOKEN` paths removed; `~/.rbox` 700 + credentials 600. Known M4 limitation: revoking a device doesn't force-close its live `/connect` WebSocket (notification-only, carries no data; all real ops re-auth per request) — documented, hardened in M7.
**Implements:** roadmap M4. **Decision:** D8 (device authorization). User chose self-hosted device tokens now; external IdP later.
**Goal:** replace the single shared cleartext bearer token with per-device, revocable tokens issued via a device-authorization flow and validated server-side. Remove the cleartext token from config/git.

---

## 1. Scope (and what's deferred)
- **In:** per-device opaque tokens (hashed at rest in D1), a CLI device-authorization flow (bootstrap + device-to-device approval, no web page), `rbox login` / `rbox device list|revoke`, server validation by token hash, cleartext token removed → Wrangler **secret** for bootstrap only.
- **Deferred (IdP / user-identity layer):** federating *who the human is* (Google/GitHub/email). Per user: evaluate **Cloudflare Zero Trust / Access** and **BetterAuth** before Clerk. The device-token layer here is independent and unchanged by that choice — the IdP later just decides *which account* a device belongs to (ties into M7 multi-tenancy). Single implicit account for M4.

---

## 2. Model
- D1 `devices`: `token_hash` (sha256 hex, PK), `device_id`, `label`, `created_at`, `last_seen_at`, `revoked` (0/1). The token itself is never stored — only its sha256.
- D1 `device_auth` (pending authorizations): `device_code` (PK, opaque), `user_code` (short human code e.g. `WXYZ-1234`), `status` (`pending|approved|denied|expired`), `device_token_hash` (set on approval), `label`, `created_at`, `expires_at`.
- Token format: 32 random bytes hex (opaque, high-entropy). Client stores the **plaintext** token in a per-machine credential file (`~/.rbox/credentials.json`, mode 600); server stores only the hash.

## 3. Flows (self-hosted, CLI-only)
**Bootstrap (first device):** `rbox login --bootstrap <secret>` → `POST /v1/auth/device/bootstrap { secret, label }`. Worker checks `secret === env.RBOX_BOOTSTRAP_SECRET` (Wrangler secret), mints a device token, stores its hash in `devices`, returns the plaintext once. CLI saves it to the credential file. This is the trust anchor that doesn't need an already-authed device.

**Device-to-device (subsequent devices):**
1. New device: `rbox login` → `POST /v1/auth/device/start { label }` → `{ device_code, user_code, interval, expires_in }`. CLI prints: *"On an already-signed-in machine run: `rbox device approve <user_code>`"* and polls `POST /v1/auth/device/poll { device_code }` every `interval`s.
2. Authed device: `rbox device approve <user_code>` → `POST /v1/auth/device/approve { user_code }` (authed by that device's token). Worker marks the auth approved and mints the new device's token (stores hash).
3. New device's next poll returns `{ status: "approved", token }` → saved to its credential file. Pending auths expire (`expires_at`); poll respects `interval` (slow-down on abuse).

**Validation:** `requireAuth` hashes the incoming bearer and looks it up in `devices` where `revoked = 0`; updates `last_seen_at` (throttled). Replaces the `=== RBOX_DEV_TOKEN` check everywhere.

**Management:** `rbox device list` (id, label, created, last-seen, this-device marker), `rbox device revoke <id>` (sets `revoked=1`; that token stops working immediately).

## 4. Removing the cleartext token
- Delete `RBOX_DEV_TOKEN` from `wrangler.jsonc` `vars`. Add `RBOX_BOOTSTRAP_SECRET` via `wrangler secret put` (never in git).
- The Worker no longer has a single shared token; it validates device tokens. Bootstrap secret is used ONLY at `/v1/auth/device/bootstrap`.
- Client: remove the hardcoded `DEFAULT_TOKEN`. The API client reads the token from the credential file (or `RBOX_TOKEN` env for CI). No credential → clear error: *"run `rbox login`"*.
- The old token already in git history stays history (documented debt); the live value is gone from config and superseded by per-device tokens.

## 5. Files touched
| File | Change |
|---|---|
| `apps/api/migrations/0004_auth.sql` | **new** — `devices`, `device_auth` |
| `apps/api/src/auth.ts` | **new** — bootstrap/start/poll/approve handlers; `requireDeviceAuth` (hash lookup) |
| `apps/api/src/worker.ts` | route `/v1/auth/device/*`; replace `requireAuth` with device-token validation; keep `/health` public |
| `apps/api/src/env.ts` | `RBOX_BOOTSTRAP_SECRET` (secret); drop `RBOX_DEV_TOKEN` |
| `apps/api/wrangler.jsonc` | remove `RBOX_DEV_TOKEN` var |
| `src/cli/credentials.ts` | **new** — read/write `~/.rbox/credentials.json` (mode 600) |
| `src/cli/auth-cmd.ts` | **new** — `login` (bootstrap + poll), `device list/revoke/approve` |
| `src/cli/remote.ts` | bearer from credential file (not hardcoded) |
| `src/cli/index.ts` | wire `login`, `device` commands; token resolution via credentials |

## 6. Security considerations (for review)
- Tokens hashed at rest (sha256); plaintext shown once. Credential file mode 600.
- `user_code` short + `device_auth` short expiry + poll `interval`/slow-down to bound guessing; `device_code` is the high-entropy secret the poller holds.
- Bootstrap secret is the single high-value secret — Wrangler secret only, rotatable; bootstrap could be one-time/limited.
- Constant-time compare for the bootstrap secret; rate-limit bootstrap + poll.
- Revocation is immediate (per-request hash lookup, no token caching).

## 7. Verification
- Unit: token hash round-trip; approve mints a working token; revoke invalidates; expired device_auth rejected; bad bootstrap secret rejected.
- Live: deploy; bootstrap a device (secret) → token works on the API; start a 2nd device → approve from the 1st → 2nd device's poll returns a working token; revoke the 2nd → its calls 401. Re-run the existing sync smoke with device tokens (daemon/push/pull authenticate via credential file). Confirm `/health` still public and all other routes reject a missing/garbage token.

## 8. Open questions for review
1. Device-to-device approval trust: is `rbox device approve <user_code>` from any authed device acceptable for M4 (single account), or does approval need finer authz now?
2. Bootstrap secret lifecycle: one-time vs reusable? Reusable is simpler (re-bootstrap any device) but a standing high-value secret. Lean reusable + rotatable for M4.
3. Credential location `~/.rbox/credentials.json` (per-machine, all workspaces share one device token) vs per-workspace token. Per-machine is cleaner (a device is a device). Agree?
4. Transition: do we seed the current dev token as a device token for continuity, or hard-cut to `rbox login`? Hard-cut is cleaner (no cleartext lingering); tests bootstrap fresh.
