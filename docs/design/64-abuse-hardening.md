# 64 — Abuse hardening: rate limits on the anonymous edge + a per-account device cap

**Status:** draft — design only.
**Depends on:** design 12 (pairing cap, shipped), design 21 (link-code cap, shipped),
design 37 (liveness-guarded mint, shipped), design 56 (test bench / rig).
**Explicitly out of scope:** signup abuse (Clerk owns human-verification — §5), WAF
zone rules (documented as defense-in-depth, not code — §3.4), and anything on the
AUTHED sync/blob hot path (already principal-scoped + quota-capped, §23/§30).

## 1. Problem

rbox has NO general rate limiting. The only quantitative caps today are three narrow,
per-account D1 count-guards, all correct but all AUTHED and single-purpose:

- pairing-token active cap 5 (`auth/pairing.ts:16,75` → 429),
- link-code active cap 5 (`account-link.ts:22,67` → 429),
- diagnostics-report window cap (`diagnostics.ts:325-329` → 429).

The `last_seen` throttle (`authenticate.ts:6`) is a write-coalescing optimization,
NOT an abuse control — worth stating because it looks like one.

That leaves the ANONYMOUS edge wide open. The worst offender is device-code start:

- `POST /v1/auth/device/start` (`auth/device-code.ts:20-41`) is public and does an
  unconditional D1 INSERT into `device_auth` per call — no IP cap, no ceiling. A
  scripted loop is a free D1-write amplifier (cost + table bloat) that no gate stops.
- `POST /v1/auth/device/poll` is public and D1-reads per call (interval-advised at 5s,
  but the server never enforces the interval).
- `/install.sh`, `/version`, `/version.sig`, `/bin/*` (`routes/release.ts`) are public
  R2 reads — cheap each, but unbounded and unauthenticated.
- Account provisioning is Clerk-gated (`clerk.ts:118-167`, web first-login) and device
  bootstrap is shared-secret-gated (`auth/bootstrap.ts:19-22`, dev-only) — both fine.

And there is NO cap on devices per account. Every mint path (`auth/mint.ts`) inserts a
`devices` row with zero ceiling: a compromised or scripted owner token can enumerate
`pair`/`device-code` mints without bound. That is both a cost vector and a blast-radius
problem (more live credentials than the user can reason about).

This design adds exactly two things: a per-IP rate limiter on the anonymous endpoints,
and a per-account durable-device cap enforced at the single mint chokepoint. Both are
env-aware so the rig (design 56) never trips them.

## 2. Decision

1. **Anonymous per-IP limiting → the Cloudflare Workers `ratelimit` binding** (GA
   2025-09-19). In-repo config, zero new infrastructure, a one-line `.limit({ key })`
   call. Chosen over a DO sliding-window (a whole new stateful class + storage cost for
   coarse cost-floor limiting we don't need to be exact) and over WAF zone rules
   (config lives outside the repo, untestable in CI — kept only as §3.4 backstop).
   Accept its two documented limits: `period` is **10 or 60s only**, and counters are
   **per-edge-location, not global**. Both are fine here — we want a cost/abuse FLOOR
   on cheap anonymous ops, not a precise global quota.

2. **Per-account durable-device cap → the existing D1 count-guard pattern**, added to
   `plans.ts` and enforced at the mint chokepoint (`auth/mint.ts`). This is a resource
   cap, not rate limiting; the `ratelimit` binding can't express "≤ N durable devices
   per account" (per-edge, IP-keyed) so it's the wrong tool. The pairing/diagnostics
   count-guard is the right precedent — exact, global, transactional.

3. **Everything env-aware.** Both mechanisms read `RBOX_ENV`: dev/rig get lax (or
   effectively unbounded) thresholds, prod gets real numbers.

## 3. Mechanism

### 3.1 The `ratelimit` binding (anonymous edge)

Declare one binding per logical limit in `wrangler.jsonc`. Named environments do NOT
inherit top-level bindings once they override siblings, so the `production` block
(which already redefines d1/r2/queues) declares its OWN tighter `ratelimits`; the
top-level (dev) block declares lax ones. That IS the env-aware knob — no code branch:

```jsonc
// top-level (dev): generous so the rig never trips
"ratelimits": [
  { "name": "RL_DEVICE_START", "namespace_id": "2001", "simple": { "limit": 120, "period": 60 } },
  { "name": "RL_DEVICE_POLL",  "namespace_id": "2002", "simple": { "limit": 240, "period": 60 } },
  { "name": "RL_RELEASE",      "namespace_id": "2003", "simple": { "limit": 600, "period": 60 } },
  { "name": "RL_LINK_PAIR",    "namespace_id": "2004", "simple": { "limit": 120, "period": 60 } }
]
// env.production: real numbers
"ratelimits": [
  { "name": "RL_DEVICE_START", "namespace_id": "2001", "simple": { "limit": 6,  "period": 60 } },
  { "name": "RL_DEVICE_POLL",  "namespace_id": "2002", "simple": { "limit": 20, "period": 60 } },
  { "name": "RL_RELEASE",      "namespace_id": "2003", "simple": { "limit": 60, "period": 60 } },
  { "name": "RL_LINK_PAIR",    "namespace_id": "2004", "simple": { "limit": 10, "period": 60 } }
]
```

Reframed from the "10/hour" intent in the ticket: the binding maxes at a 60s window, so
we express budgets as per-60s bursts (a human logs in a handful of times a minute at
most; 6/60s/IP is generous for people, ruinous for a loop). Enforcement is one guard
at the top of each public route, keyed by IP + route:

```ts
const ip = clientIp(req) ?? "noip";           // notify.ts already extracts CF-Connecting-IP
if (!(await env.RL_DEVICE_START.limit({ key: `ds:${ip}` })).success)
  return json({ error: "rate_limited", retryAfterSeconds: 60 }, 429, { "Retry-After": "60" });
```

Applied to: `device/start`, `device/poll`, the three `release.ts` GETs (shared
`RL_RELEASE`), and `account/link/start` + `auth/pair/redeem` (shared `RL_LINK_PAIR` —
both credential-minting: pair/redeem is anonymous, link/start is Clerk-authed but
cheap to script from a stolen session). `pair/create` is AUTHED and already capped, so it
stays as-is. The guard sits in each route BEFORE the D1 work, so a limited call costs
one binding lookup, not a D1 write.

Cloudflare docs warn against IP-only keys (shared NATs); acceptable here because these
are cost-floor limits on anonymous ops, and the real per-actor cap is §3.2. A shared
office NAT hitting 6 logins/60s is implausible; if it happens, the 429 is transient.

### 3.2 Per-account durable-device cap

Add to `PlanLimits` (`plans.ts`):

```ts
devices: number;   // max DURABLE (non-expiring) device credentials per account
// free: 5, solo: 10, pro: 25, team: 100  (Infinity-storage plans keep a real integer here)
```

**The mint chokepoint is `prepareMintDevice` (`auth/mint.ts:80-107`)** — it builds the
sole `INSERT INTO devices …` statement, and ALL four mint paths route through it:
bootstrap (`mintDevice`), web sessions (`createWebSession → mintDevice`), pair-redeem and
device-code-claim (both `mintDeviceWithNotification`). Enforce ONCE here.

Two constraints shape the enforcement:

- **Web sessions must be exempt.** `createWebSession` mints with `expiresAt` set; those
  are ephemeral and churn. The cap counts and blocks only DURABLE devices
  (`expires_at IS NULL AND revoked = 0`), i.e. only mints where `expiresAt === null`.
- **Don't overload design-37's `changes == 0`.** Today `changes == 0` on the guarded
  INSERT means "account tombstoned" (→ `AccountGoneError`). Folding a cap predicate
  into that same WHERE would make 0 ambiguous. So enforce the cap as a **pre-count**
  inside `mintWithRetry` for durable mints only: `SELECT COUNT(*) FROM devices WHERE
  account_id = ? AND expires_at IS NULL AND revoked = 0`; if `>= planFor(plan).devices`,
  throw a typed `DeviceLimitError` before the INSERT. This accepts a benign
  check-then-insert race (two concurrent mints could overshoot by one) — tolerable
  because this is a soft resource cap, NOT a secret-issuance gate like pairing (where
  the atomic INSERT…SELECT…WHERE is load-bearing). If exactness is ever needed, the
  atomic form is available at the cost of a second sentinel for the ambiguous 0.

Plan is read from `accounts.plan` (account-data plane, `dbFor`) alongside the existing
liveness read — one extra point read on the durable-mint path only.

Public routes surface it as **409** with a clear DTO:

```json
{ "error": "device_limit_reached", "cap": 5, "plan": "free" }
```

409 over 402: revoking an old device (`rbox device revoke`, free) resolves it, so it
isn't strictly payment-gated — though the DTO carries `plan` so the CLI can add "or
upgrade for more devices." The CLI message: `device limit reached (5/5 on free) — run
'rbox device revoke <id>' to free a slot, or upgrade`.

Env-aware: in dev/rig, `planFor` is overridden to a large `devices` value (gate on
`env.RBOX_ENV !== "prod"` at the enforcement site → treat cap as effectively unbounded),
so design-56 bench runs that mint many devices never trip it.

### 3.3 Required client tolerance

- **Pairing** already handles 429 (`src/cli/auth-cmd.ts:202`; web `apps/web/src/lib/api.ts:278`).
- **Device-code login does NOT.** `device/start` throws a generic
  `login start failed: 429` (`auth-cmd.ts:80`), and the poll loop (`auth-cmd.ts:101-110`)
  branches only on `p.status` — a 429 JSON body has no `status`, so it's silently treated
  as `pending` and the loop keeps polling. Both need small changes: `start` should retry
  with backoff (respect `Retry-After`) rather than hard-fail on 429; the poll loop should
  treat a 429/non-ok response as a transient back-off, not a status. Flag this as a
  required companion CLI change, small and isolated.
- The device-cap 409 is terminal (not retryable) — the CLI prints the message and exits.

### 3.4 WAF (out-of-repo backstop, documented not built)

A zone-level WAF rate-limiting rule (once `rbox.to` is live on Cloudflare) is a useful
defense-in-depth layer for volumetric/L7 floods the per-isolate binding can't see
globally. It is CONFIG, not code, lives in the dash, and is untestable in CI — so it is
NOT part of this design's deliverable. If/when added it MUST be recorded in AGENTS.md's
deployment/ops section (alongside the `namespace_id` registry for §3.1), because nothing
in the repo will reveal its existence.

## 4. Security & privacy

- **IP handling.** Rate-limit keys derive from `CF-Connecting-IP` (via the existing
  `clientIp`, `notify.ts`). The IP is used only as an ephemeral key fed to the binding;
  we do NOT persist it for limiting. The binding's counters age out on their 10/60s
  window — no durable IP store, no new PII at rest. (This is stricter than the existing
  `clientIp` usage, which already records IP in device-notification rows for security
  alerts — a separate, consented surface.)
- **Fail-open on the limiter.** A binding error must not take down login; treat a thrown
  `.limit()` as `success: true` (log + allow). The device cap, by contrast, fails CLOSED
  on a plan-read error (better to block a mint than mint unbounded).
- **No new escalation surface.** The device cap sits behind the existing §1.1 token-kind
  gate and design-37 liveness guard; it only ever REDUCES what a caller can mint.
- **Enumeration.** The 429/409 DTOs carry no account-identifying data beyond the caller's
  own `plan`/`cap`; the anonymous 429 carries none.

## 5. Signup velocity — what we are NOT doing, and why

- **No Turnstile / CAPTCHA on the API.** Human signup is Clerk's job (`clerk.ts`
  first-login is gated on a Clerk-verified email; Clerk runs its own bot protection).
  This MITIGATES but does not ELIMINATE scripted abuse — a Clerk-authed session can still
  drive API calls — which is exactly why §3.1/§3.2 cap the anonymous edge and per-account
  mints regardless of how the caller authenticated.
- **No per-Clerk-user provision guard.** One Clerk id maps to exactly one account by
  construction (`clerk_users` unique), so there's nothing to cap.
- **No IP reputation / geo-blocking.** Out of proportion to a CLI product's risk; the
  per-IP burst cap + per-account device cap cover the realistic vectors. Web-shell
  reclaim abuse is already bounded by the link-code active cap (§1).

## 6. Test plan

Unit tests (Vitest, `apps/api/test`, alongside the existing `worker.test.ts` cap tests):

- **Device cap:** mint durable devices up to `plans.free.devices`, assert the next mint
  returns 409 `device_limit_reached`; assert a `revoked` device frees a slot; assert an
  EPHEMERAL web-session mint is NOT counted and NOT blocked; assert pair-redeem AND
  device-code-claim both hit the same cap (proves single-chokepoint enforcement); assert
  `RBOX_ENV=dev` (or the test override) lifts the cap so the rig is unaffected.
- **Limiter guard logic:** with a stubbed `ratelimit` binding (`{ limit: async () =>
  ({ success }) }`), assert each guarded route returns 429 + `Retry-After` when
  `success:false` and passes through when `success:true`; assert a thrown `.limit()`
  fails OPEN.
- **Client tolerance:** device-code start retries on 429; the poll loop treats 429 as
  transient (drive with a mocked fetch).

NOT in scope for CI: the real `ratelimit` binding counters (per-edge, non-deterministic)
and any WAF rule — both are ops-verified, not unit-tested. The rig (design 56) gets NO
new limit assertions in v1; it must simply keep passing, which the dev-lax thresholds
guarantee.

## 7. Out of scope

- WAF/zone rate-limiting rules (§3.4 — ops config, documented in AGENTS.md, not code).
- Global (cross-edge) exactness on the anonymous limits — the per-edge binding is a
  deliberate cost-floor approximation; the DO-counter upgrade is available later if a
  single hot endpoint proves it needs precision.
- Rate limiting the AUTHED sync/blob/keys hot path (principal-scoped + §23 quota-capped
  already; adding per-request limits there is a separate perf/fairness workstream).
- CAPTCHA/Turnstile, IP reputation, geo-blocking (§5).
- Enforcing the poll `interval` server-side beyond the burst cap (the 429 already bounds
  a hot-looping client; a precise token-bucket per device-code is future work).
