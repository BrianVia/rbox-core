# 192 — Headless CI rig for design 189 (web-approved pairing)

Status: IMPLEMENTATION (test-harness deliverable, not a new product surface). The
189 protocol is already ALIGNED + merged + live on the dev API. This doc records
the ONE new production-touching decision — a dev-only scriptable approve hook —
and the rig scenario that drives 189 end-to-end with no human and no browser.

Related: 189 (web-approved pairing), WIRE-189, scriptable-path-posture (memory),
design 56 §9 (the rig).

## 1. Problem

The 189 two-machine flow was only ever validatable by hand: the approve step
needs a Clerk-authenticated browser, so neither an agent, CI, nor the rig could
run it. Per the founder's scriptable-path posture, every interactive/browser
flow must have a single-command twin so the rig can validate it. The API tests
already drive the approve+key-delivery path via `SELF.fetch` with a minted fresh
Clerk step-up, but that mechanism lives only in test-land (it forges Clerk JWTs
with the test signing key). A rig hitting the LIVE dev worker has no Clerk
signing key and cannot drive a browser, so it needs an equivalent hook the live
worker exposes.

## 2. The hook: `POST /v1/auth/device/approve-dev` (DEV-ONLY)

A scriptable twin of the web approve step. It queues a 189 key-delivery for a
pending device-code WITHOUT a Clerk step-up or a `web`-kind session, swapping ONLY
the authentication for a dev-env + operator-secret gate. Everything else — the
fragment/fingerprint binding, the keyConsent-equivalent (calling it at all IS the
consent), current-epoch check, per-account caps, duplicate-target uniqueness,
revoke fence, and the atomic approve+queue D1 batch — is the IDENTICAL
`queueApprovedKeyDelivery()` code path the real `device/approve` uses. The 189
crypto/consent/trust model is unchanged; the daemon still wraps + publishes an
admin roster, the new device still verifies the chain.

### 2.1 Prod-impossibility (the security contract)

Three independent gates, checked in this order:

1. **`env.RBOX_ENV !== "dev"` → 404** as the handler's first line. `RBOX_ENV` is a
   hardcoded Wrangler var: `"dev"` in the dev env block, `"prod"` in production
   (`apps/api/wrangler.jsonc`). This is the SAME gate that already disables the
   dev bootstrap plan and the device-cap bypass (`mint.ts`). In prod the endpoint
   is indistinguishable from a route that does not exist.
2. **Authenticated rbox principal required.** The route sits under
   `authDeviceRoutes` (post-`authenticate`), and `approve-dev` is on NEITHER the
   `web` nor the `api_key` allowlist, so only a durable DEVICE bearer reaches it —
   the caller must already be an enrolled device on the target account.
3. **`RBOX_BOOTSTRAP_SECRET` operator proof** via constant-time `ctEqual`, mirroring
   `bootstrap()`. Even in dev, only the operator who can already bootstrap
   accounts can call it.

A test (`apps/api/test/key-delivery.test.ts`) proves prod rejection by invoking
the handler with `{ ...env, RBOX_ENV: "prod" }` and asserting a 404 with no
`key_delivery` row, plus a wrong-secret 401 and a dev-env happy path that queues.

## 3. The rig scenario: `web-pairing`

`bun run rig run web-pairing` (docker/apple-container, dev API). Fully headless:

1. **Machine A** — fresh dev account via `login --bootstrap` (genesis enrolls
   encryption), pro plan grant, `init --new`, write + push a file, `rbox start`
   (daemon online; read-write daemons are key-release default-on).
2. **Machine B** — `rbox login` (device-code) run detached. Non-interactive so it
   just prints the approval URL (`?code=…#fp=…`) and polls. The rig parses the
   userCode + fragment fingerprint from that URL — exactly the surface a human
   would copy.
3. **Approve** — the rig host `POST`s `approve-dev` with A's bearer + the
   userCode + fingerprint + the dev bootstrap secret. Response carries
   `keyDelivery.status="pending"` (queued).
4. **Assert positive** — B's login self-completes 189: it prints
   `device authorized + encryption enrolled` (NOT the legacy `device authorized`
   line, NOT the pairing/phrase fallback). B then `init --workspace` + `pull`; the
   file A wrote is byte-identical on B — proving the DELIVERED master key actually
   decrypts A's ciphertext. Observable state: `pending` (approve response) →
   `delivered` (enroll completes only on a delivered wrap + ACK).
5. **Assert negative** — a fresh device-code from B approved via the REAL
   `device/approve` with `{ userCode }` (no keyConsent) returns `{ ok: true }`
   with no `keyDelivery` and creates no `key_delivery` row: device-auth only, no
   delivery.

## 4. Out of scope

No CLI changes: `rbox login`'s device-code path is already a headless,
non-interactive 189 client (prints URL, polls, enrolls, ACKs). No schema/D1
migration — the hook reuses the 189 tables. No web changes.
