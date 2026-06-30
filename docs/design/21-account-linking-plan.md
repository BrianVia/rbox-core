# Design 21 — Account linking: staged implementation plan

> **Status: 🔴 NOT STARTED — build plan.** Execution plan for [`21-account-linking.md`](./21-account-linking.md) (the design). Slices are ordered by dependency + blast radius; each is independently buildable, testable, and committable. Section refs (`§`) point into the design doc.

## Decisions needed before starting (gate the slices)

These are doc 21 §9. Three actually block code; the rest have safe defaults baked into the plan.

| # | Decision | Blocks | Plan's default if unanswered |
|---|----------|--------|------------------------------|
| D1 | **Billing-on-shell migration** (§3.4/§9.1): auto re-point Stripe shell→X, or force cancel+resubscribe? | Slice 6 only | **Block the link on billing-bearing shells (`409`)** — the always-safe fallback. Saga deferred to Slice 6. |
| D2 | **Code form** (§9.3): opaque full-entropy token vs human-typeable `XXXX-XXXX` over ≥128 bits? | Slice 2 (cosmetic) | Opaque ≥128-bit; grouped display is a later polish. |
| D3 | **`link/start`/`confirm` auth** (§9.6): re-verify the short-lived Clerk JWT, or persist `clerk_user_id`+kind on the web session and authorize by rbox token? | Slice 2 | **Re-verify the Clerk JWT** (design's recommendation — simpler + stronger). |
| D4 | **Genesis-into-shell** (§9.7): build the web-approved CLI bootstrap so the web shell becomes the crypto world? | — (future) | **Out of scope.** B = web signup + normal bootstrap + A. |

D1 is the only one with real product weight; everything else has a defensible default. **The kind-gate (Slice 0) is non-negotiable — design §1.1/§9.2 say linking must not land without it.**

---

## Slice 0 — Token-kind route gate (P4 / §1.1) — **prerequisite, ship first**
The E2EE ceiling is only *real* once this exists; linking widens the gap if it doesn't. Independent of everything below — buildable + shippable on its own, and it closes prerequisite **P4**.

- [ ] `authz.ts`: add `kind: 'durable' | 'web'` to `Principal`.
- [ ] `auth.ts` `authenticate()`: derive `kind = (expires_at IS NULL ? 'durable' : 'web')` from the SELECT that already reads `expires_at`.
- [ ] `worker.ts`: **default-deny** policy for `kind=='web'` — explicit allowlist (`GET /v1/account/*`, `/v1/billing/checkout`, `/v1/billing/portal`, `GET /v1/auth/devices`, device-revoke, and the §8 link endpoints); **403 everything else**, especially the credential-mint escalation routes `POST /v1/auth/pair/create`, `POST /v1/auth/device/approve`, `POST /v1/workspaces`, plus all `v1/keys/*`, blob mutate/check, `v1/ws/*` commit.
- [ ] Tests: `web_*` token → 403 on `v1/keys/*` / blob upload / workspace commit / pair-create / device-approve; durable token → passes. (Default-deny, not deny-list — prove an *unlisted* route is also 403 for web.)

**Why first:** security-critical, no dependency on the link schema, and it can deploy to prod independently (like P1).

---

## Slice 1 — Schema + provenance (migration `0014`, no behavior change)
Additive. The risky bits are the unique index + backfill — mirror the **dedup-first** ordering proven in `0013`.

- [ ] `0014_account_linking.sql`: `account_link_codes` (two-phase + `poll_key`), `account_link_events`, `accounts.origin`/`reclaimed_at`. **Order matters (§3.2 caveat):** (1) collapse/validate any existing `clerk_users.account_id` duplicates, (2) run the `origin` backfill (§6), (3) `CREATE UNIQUE INDEX uq_clerk_users_account` — or the index build fails.
- [ ] Backfill (§6): data/billing-bearing → `origin='bootstrap'`; provably-empty clerk-mapped → `origin='web'`; ambiguous → `NULL` (fail-closed, not reclaimable).
- [ ] `auth.ts` `bootstrap`: stamp `origin='bootstrap'`. `clerk.ts` `webSession` first-provision: stamp `origin='web'`. (One line each, no behavior change.)
- [ ] Tests: backfill classification (empty web shell → `web`; data/billing acct → `bootstrap`; ambiguous → `NULL`); the unique index rejects a 2nd Clerk id on one account.
- [ ] Apply to **dev** D1; leave prod for a human (same as 0013).

---

## Slice 2 — Link ceremony, server-side (Option A primitive) — the core
The two-phase bind. Empty-shell reclamation only here; billing-bearing shells **block** (Slice 6 resolves them).

- [ ] `clerk.ts`: `startLink` (fresh JWT → mint code, cap active codes/Clerk id via the §5.7 atomic pattern), `linkStatus` (poll `pending_account` + fingerprint), `confirmLink` (the **one atomic conditional rebind** — §4.2: origin unchanged, target not reclaimed, no other Clerk on X, single-use).
- [ ] `auth.ts`: `redeemLink` (phase 1: single-use consume; assert `kind=='durable' && role=='owner'` on X via live `memberships`, identified by unique `token_hash`; record *pending*, **no rebind**).
- [ ] Map C → the **redeeming owner's own `p.userId`** (§3.3), not "an owner of X".
- [ ] Empty-shell reclamation (§3.4): tombstone (`reclaimed_at` + delete memberships/users/ephemeral devices) only when the **exhaustive** predicate holds; billing/data-bearing → `409 origin_account_has_state`.
- [ ] `worker.ts`: wire `POST /v1/account/link/{start,redeem,confirm}` + `GET /v1/account/link/status` (all under the Slice-0 allowlist).
- [ ] Tests (§8 list): two-phase happy path; **confirm-mandatory** (redeem alone never rebinds); redeem requires durable+owner (`web_*` owner → 403, `viewer`/`admin` durable → 403); fresh-JWT gate (stale `web_*` → 401); single-use/expired → 401; conditional-confirm aborts (409) on concurrent move / reclaimed / other-Clerk; **leaked-code property** (stranger's redeem onto Y only *pending*; victim declines; no commit); E2EE untouched (no `account_keys`/`rosters`/`device_keys` writes).

---

## Slice 3 — CLI `rbox account` group
- [ ] `src/cli/index.ts`: new `account` command group — `link <code>` / `status` / `unlink`. **Must not collide** with the existing `link <path>` (dir→workspace, §4.0).
- [ ] `src/cli/auth-cmd.ts`: `accountLink(code)` (redeem; print "confirm in your dashboard"), `accountStatus()`, `accountUnlink()`.
- [ ] Tests: `account link` hits redeem with the durable bearer; surfaces the pending→confirm instruction.

---

## Slice 4 — Dashboard UI
- [ ] `apps/web/`: "Link your CLI account" — start → show code → poll status → **confirm the target account** (phase 2, shows the X fingerprint).
- [ ] Empty-state discovery nudge (ties to design 17 §4.1): "Used the rbox CLI? Link your account" → start flow. **Never** auto-detect-and-bind (that's option C's takeover risk).

---

## Slice 5 — Unlink + re-link guard
(Can fold into Slice 2/3; called out for completeness.)
- [ ] `unlink` (owner-gated, web or CLI): rebind C → fresh `'web'` shell; audit; **never** touches devices/roster.
- [ ] Re-link guard (§5.4): C on a non-shell account → `409 already_linked` unless explicit `unlink`/`--force`; re-confirm same X → idempotent success.

---

## Slice 6 — Billing-on-shell migration saga (**deferred, gated on D1**)
Only needed for the non-empty case where the shell carries a Stripe subscription. Until built, Slice 2 **blocks** those links (`409`) — safe, just not seamless.
- [ ] If D1 = re-point: **preflight → Stripe update (idempotent, keyed) → D1 commit** saga moving the full billing set (`stripe_customer_id`, `stripe_subscription_id`, `plan`, `grace_until`, extras) shell→X, rebind gated on the Stripe step; then reclaim. Replayable; never half-moved.
- [ ] If D1 = guided: cancel-at-period-end on shell + resubscribe on X.
- [ ] Tests: saga idempotency/replay; link unblocks once billing moved; a mid-saga failure leaves a consistent, retryable state.

---

## Build order & shipping
1. **Slice 0** (kind-gate) — ship to prod independently; closes P4.
2. **Slice 1** (schema) — additive; dev-first.
3. **Slice 2** (server ceremony) — the heart; needs 0 + 1.
4. **Slices 3 + 4** (CLI + dashboard) — can run in parallel once 2's endpoints are stable.
5. **Slice 5** (unlink) — small, anytime after 2.
6. **Slice 6** (billing saga) — only after **D1** is decided; link works (with a block) without it.

Each slice: Miniflare/business-logic tests (per CLAUDE.md — no type-only tests), `typecheck` + `test:api` green, dev-first, commit at green. Migrations applied to prod by a human.
