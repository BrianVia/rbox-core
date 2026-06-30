# Design 21 — Account identity model + web↔CLI account linking

> **Implementation status: 🔴 NOT STARTED** — design complete & codex-reviewed (2026-06-29). Highest-leverage spec in the batch: docs 16/17/19 depend on it. **Staged build plan: [`21-account-linking-plan.md`](./21-account-linking-plan.md).**

Designs **16** (new-device emails), **17** (device/workspace dashboard) and **19**
(revocation) all sit on top of "the Clerk session manages the user's *real*
account," which today it does not.

**Depends on / reconciles:** 04 (device-token auth), 06 (tenancy:
accounts/users/memberships), 10 (pairing), 11 (web auth / Clerk → rbox token,
migration 0010), 12 (full E2EE — the MK/roster ceiling).
**Feeds:** 16 §12.1, 17 §1.3a/§8.1, 19 (account scope of the dashboard).

---

## 0. The bug, confirmed with file:line evidence

rbox accounts are born two ways that do **not** know about each other:

1. **CLI-born (bootstrap).** `POST /v1/auth/device/bootstrap` →
   `bootstrap(req, env)` in `apps/api/src/auth.ts:200-215` mints a fresh
   `accountId = acct_<16hex>` + owner `userId = user_<16hex>` + owner membership
   + first device, directly in D1. **No Clerk identity, no email on file**
   (`users.email` from migration 0006 is left NULL — bootstrap never sets it).
   This account holds the user's real devices, workspaces, MK, and E2EE genesis
   roster (design 12).

2. **Web-born (Clerk).** `POST /v1/web/session` → `webSession(req, env, nowMs)`
   in `apps/api/src/clerk.ts:106-151` maps a verified Clerk user (`sub`) to an
   rbox account via the `clerk_users` table (migration 0010).

**THE BUG — confirmed.** In `webSession`, when the Clerk user has no
`clerk_users` row yet (`if (!map)`, `clerk.ts:121`), the code does **not** look
for the caller's existing bootstrap account by *any* join key. It unconditionally
**mints brand-new ids** and provisions a fresh empty account:

- `clerk.ts:130-131` — `const candAcct = randomId("acct", 8); const candUser =
  randomId("user", 8);` (freshly random, never derived from anything the CLI user
  already owns).
- `clerk.ts:132-135` — `INSERT OR IGNORE INTO clerk_users (clerk_user_id,
  account_id, user_id, …) VALUES (sub, candAcct, candUser, …)`.
- `clerk.ts:145-147` — `INSERT OR IGNORE` a new `accounts` row (name `'web'`,
  plan `'free'`), a new `users` row, and an **owner** `memberships` row for those
  fresh ids.

There is **no** `SELECT … FROM accounts/users/memberships/devices WHERE email = ?`
or any other reconciliation. The only lookup performed (`clerk.ts:116-119`) is
keyed on `clerk_user_id` itself, which by definition does not exist for a
CLI-first user's first web login. **Claim CONFIRMED: the web flow mints a new
empty account and never links the bootstrap account.**

**Blast radius (all real, all downstream):**
- Empty dashboard — design 17's `GET /v1/account/devices|workspaces` is scoped to
  `Principal.accountId`, which is now the shell, not X (17 §1.3a).
- Billing attaches to the **wrong (shell) account** — Stripe checkout/portal run
  against `Principal.accountId`.
- New-device security emails (design 16) can never reach the user: X has **no**
  `clerk_users` row, so owner-email resolution yields nothing (16 §3.3, §12.1 —
  "permanently un-notifiable").
- Device list / revocation (17/19) operate on the shell, not the user's machines.

---

## 1. The E2EE ceiling — read this before anything else (linking ≠ "web can sync")

State plainly, because it is the most common misunderstanding this doc must kill:

**The browser has no Master Key and can never be a roster device.** Under full
E2EE (design 12, migration 0011, merged to main):
- MK lives only on enrolled CLI devices (wrapped per-device, RSA-OAEP) and under
  the recovery key. The browser holds **no device signing key, no enc key, no MK**.
- Admitting a device to the roster requires an **admission grant** signed by an
  active+admin device, plus an `admissionSecret` derived from a pairing
  `tokenSecret` that only the true token bearer ever holds (design 12 §V4-1). The
  server is forbidden from mutating the roster; the dashboard cannot mint
  admission material and cannot bootstrap an account's crypto world (17 §1.3a, R2-1).

**Therefore: linking is about SERVER IDENTITY / account ownership — *which*
`account_id` the Clerk session manages — NOT about MK.** Even after a perfect
link, the dashboard's **honest ceiling** is:
- ✅ billing (Stripe customer on the right account),
- ✅ read-only account metadata (plan/usage),
- ✅ read-only device & workspace listing (design 17, token-side metadata only),
- ✅ token-level device revocation (design 19 part (a): flip `devices.revoked`),
- ❌ **never** decrypt files, **never** sync, **never** mint E2EE admission,
  **never** complete a crypto eviction (roster rotation needs an enrolled CLI
  device — 17 §7).

Linking removes the "empty/wrong account" problem. It does **not** turn the web
into a sync client. Anyone who reads "link" as "the dashboard can now see my
files" is wrong, and this section exists to make that impossible to misread.

### 1.1 The ceiling must be ENFORCED, not just asserted (prerequisite)
The "web can't sync" claim is today **aspirational, not enforced** — and linking
*widens the gap*. A web session is a real `devices` row (`createWebSession`,
`auth.ts:76-80`) and `authenticate()` (`auth.ts:39-59`) returns the same
`Principal` shape as a CLI token (`authz.ts:5-10` — `{deviceId, accountId,
userId, role}`, **no token-kind field**). `worker.ts` then routes that Principal
through the *same* surface as CLI devices: `v1/keys/*` (roster/device-key/keystate
writes), `v1/blobs/*`, and the workspace commit paths. Commits are stored verbatim
and **not server-signature-verified** (the server is zero-knowledge), so a web
token can plausibly *advance server state with opaque garbage* (poison a
workspace's commit log / append junk roster blobs) even though it can never
*decrypt*. Before linking, a web token sits on an empty shell where that's
harmless; **after linking it sits on the user's real account X**, so the blast
radius of an unscoped web token becomes the user's real workspaces.

**Therefore this is a hard prerequisite, owned here:** thread a **session kind**
into `Principal` by deriving `kind = (expires_at IS NULL ? 'durable' : 'web')` in
`authenticate` — which requires **adding `d.expires_at` to that SELECT's
projection** (today it is referenced only in the `WHERE`, not returned —
auth.ts:47-54; Round-3 finding 9 corrects the earlier "already read" wording) —
and add a **DEFAULT-DENY route policy** for `kind=='web'`. A web token is permitted
only on an **explicit, EXACT-MATCH allowlist of (method, path) pairs** (Round-3
finding 8 — no `GET /v1/account/*` wildcard, which would silently expose any
future account GET by path accident):
- `GET  /v1/account/usage`
- `GET  /v1/account/status`        (the CLI/account link-state probe, §8)
- `POST /v1/billing/checkout`
- `POST /v1/billing/portal`
- `GET  /v1/auth/devices`
- `POST /v1/auth/devices/:id/revoke`
- `POST /v1/account/link/redeem`   (self-rejects a web token on its own `kind=='durable'` check)
- `POST /v1/account/unlink`        (a web owner token may unlink, §5.4)

Everything else is **403** — including the routes that would let a web token
*escalate into a durable credential* and thereby bypass the gate entirely:
**`POST /v1/auth/pair/create`, `POST /v1/auth/device/approve`,
`POST /v1/workspaces`**, plus all `v1/keys/*`, blob mutate/check, and `v1/ws/*`
commit paths. (`link/start`/`status`/`confirm` are **not** in this list because
they are PUBLIC Clerk-JWT routes that never carry an rbox Principal — §4.1.)
Default-deny (not a deny-list) is load-bearing: a deny-list that enumerates only
crypto/sync routes would let a web token mint/approve a CLI token and then act
durably (the exact escalation codex flagged). The E2EE ceiling (§1) is only *true*
once this exhaustive gate exists; without it "the dashboard can never sync" is a
claim the API does not back. (This also underpins the link-redeem owner-proof in
§4.2 — finding 4.)

---

## 2. The three options

### Option A — CLI-canonical claim/link (the primitive) ✅ recommend as primitive
The bootstrap account X is the valuable, crypto-anchored one. The human who owns a
**non-revoked owner device on X** is the right party to decide "attach my web
login to this account." Reuses the existing possession-proof machinery (pairing /
device-auth): a short, single-use code binds a live Clerk identity onto X.

- **Trust property:** the binding requires **two simultaneous live proofs** —
  (a) a verified, live Clerk session, and (b) possession of a non-revoked **owner**
  device token on X. Neither alone suffices.
- **Covers the migration case:** it is the *only* option that can attach a
  Clerk identity to a **pre-existing** bootstrap account (the thing the bug
  created a mess of). B and C cannot retrofit existing accounts.

### Option B — web-first funnel for *new* users (default UX, but built FROM A) ✅
**Honest mechanics (corrected after review — B is not a separate genesis path).**
A brand-new user signs up on the web first (Clerk → `'web'` shell, account C). To
get a working rbox they install the CLI and run `rbox login --bootstrap`, which
today **always mints a brand-new account X** (`auth.ts:200-215` — bootstrap has no
"adopt the caller's existing web shell" mode, and normal `rbox login` device-auth
needs an *already-signed-in device to approve*, `auth-cmd.ts:63-84`, which a
web-first user does not have). So the realistic greenfield flow is: **web signup →
`rbox login --bootstrap` creates X (the real crypto world) → run A once to link
C↔X** (which reclaims the empty web shell, §3.4). In other words **B is a UX
framing layered on the A primitive, not a distinct mechanism.**
- **Optional future enhancement (NOT in scope, flagged §9.6):** a *web-approved
  CLI bootstrap* where the dashboard issues a code that the CLI bootstrap consumes
  to make genesis target the **shell's** `account_id` instead of minting a fresh
  one — that would let the shell itself become the crypto world and skip the
  later reclaim. It needs a **new** bootstrap-into-existing-account endpoint that
  does not exist today; until then B = "web signup + normal bootstrap + A."
- **Limitation:** B does nothing on its own for the pre-existing-bootstrap-accounts
  case (CLI-first users whose crypto world already lives on X). **A is the
  migration path** for them. So: A is the universal primitive; B is the new-user
  *funnel*, and it bottoms out in A.

### Option C — email-as-join-key (auto-link on matching verified email) ❌ reject
Collect an email at bootstrap; when a Clerk user signs in, auto-link if their
**verified** Clerk email equals the bootstrap email.
- **Why it's the weakest / rejected:**
  - **Verification asymmetry → takeover.** rbox would have to trust an email it
    itself verified at bootstrap *and* Clerk's verification. Email ownership
    changes (corporate addresses recycle; a former employee's `name@company.com`
    is reassigned). A new Clerk user who legitimately controls a recycled address
    would auto-inherit the *previous* owner's account X — **silent account
    takeover with no human in the loop.**
  - **Collision & ambiguity.** Two bootstrap accounts with the same email; an
    email typo'd at bootstrap; multiple Clerk identities sharing an address. The
    auto-linker has no safe resolution.
  - **No possession proof.** It binds on *knowledge of an address*, not
    possession of a device — strictly weaker than A's two-live-proofs model.
  - Collecting email at bootstrap also dents the "CLI works with zero PII" property.

  C may have a *narrow* future role as a **convenience hint** ("we found a CLI
  account that might be yours — link it?" → still routes through A's possession
  proof), never as an automatic binder. Recommend: **do not build C**; if ever
  built, it MUST funnel into A, never auto-bind.

### Recommendation
**A is the primitive; B is the new-user funnel (implemented *via* A); C is
rejected.** Build A first — it is the universal binder and the only migration path
for every stranded account the bug already created. B needs no separate mechanism
beyond A plus the existing bootstrap flow (genesis-into-shell is a flagged future
enhancement, not required, §2/Option B).

---

## 3. Data model

### 3.1 Reconcile with migration 0010 — rebind the existing row, don't add a parallel map
`clerk_users(clerk_user_id PK, account_id, user_id, created_at)` (0010) **already
is** the authoritative "Clerk identity → rbox account/user" mapping, and
`webSession` already resolves returning logins through it
(`clerk.ts:116-120, 143-147`, all idempotent `INSERT OR IGNORE`). Linking is
therefore **a rebind of this row's `account_id`/`user_id`**, not a new join table:

```
-- conceptual effect of a successful link of Clerk identity C onto account X:
UPDATE clerk_users
   SET account_id = X.id,
       user_id    = X.owner_user_id    -- the bootstrap owner user (§3.3)
 WHERE clerk_user_id = C;
```

After the rebind, `webSession` resolves C → X for free (the `map` lookup at
`clerk.ts:116-120` returns X; the trailing `INSERT OR IGNORE`s at 145-147 are
no-ops because X's account/user/membership already exist). The **resolve path**
(returning login) needs no change — but the **first-provision self-heal must be
gated to `if (!map)`** so a returning login never re-grants owner on a real
account (§3.5, Round-3 finding 1). Beyond that, only the new link endpoints (§4)
and shell reclamation (§3.4) are added.

### 3.2 New tables/columns (migration `0014_account_linking.sql`)

```sql
-- Short-lived, single-use link codes. Mirrors pairing_tokens (0008): plaintext
-- never stored, sha256 only; the code is generated dashboard-side and bound to
-- the live Clerk identity that requested it. Redeem moves a code through a
-- TWO-PHASE bind: redeem → 'pending', dashboard confirm → committed (§4).
CREATE TABLE IF NOT EXISTS account_link_codes (
  code_hash      TEXT PRIMARY KEY,    -- sha256(plaintext code); plaintext shown once in the dashboard
  poll_key       TEXT NOT NULL UNIQUE, -- opaque handle the dashboard polls/confirms with (NOT the code; §4.3)
  clerk_user_id  TEXT NOT NULL,       -- the Clerk sub that requested the link (the identity being bound)
  origin_account TEXT NOT NULL,       -- the account currently mapped to this Clerk id (verified unchanged at commit, §4.2)
  created_at     INTEGER NOT NULL,    -- epoch ms
  expires_at     INTEGER NOT NULL,    -- epoch ms; redeem rejects past TTL (10 min)
  consumed_at    INTEGER,             -- NULL until redeemed; the single-use gate (phase 1)
  pending_account TEXT,               -- target X proposed by the redeeming owner device (phase 1 → awaiting confirm)
  pending_device  TEXT,               -- the redeeming durable owner device_id (audit; §6.4 caveat)
  pending_user    TEXT,               -- the redeeming owner's user_id, captured at redeem (§3.3 — confirm maps C→this user; Round-3 finding 2)
  pending_at      INTEGER,
  committed_at    INTEGER             -- set when the dashboard (live C session) confirms the target (phase 2)
);
CREATE INDEX IF NOT EXISTS idx_link_codes_clerk ON account_link_codes (clerk_user_id, created_at);

-- Append-only audit of every (re)bind. Forensics for takeover/double-link disputes.
CREATE TABLE IF NOT EXISTS account_link_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  clerk_user_id TEXT NOT NULL,
  from_account  TEXT,                 -- NULL if the Clerk id had no prior account
  to_account    TEXT NOT NULL,
  method        TEXT NOT NULL,        -- 'cli_link' | 'unlink' | 'genesis_web'
  actor_device  TEXT,                 -- the redeeming owner device_id (audit only; see device_id caveat §5.6)
  at            INTEGER NOT NULL
);

-- Mark account provenance so a web shell can be safely reclaimed and a
-- crypto-anchored account is never auto-deleted (§3.4).
ALTER TABLE accounts ADD COLUMN origin TEXT;       -- 'bootstrap' | 'web' | NULL(legacy → backfilled, §6)
ALTER TABLE accounts ADD COLUMN reclaimed_at INTEGER;  -- set when a shell is tombstoned by a link

-- Schema-enforce one-Clerk-per-account (§5.5). clerk_users (0010) keys only on
-- clerk_user_id, leaving the INVERSE (one account ← one Clerk id) unconstrained.
-- A UNIQUE index on account_id makes a second Clerk id rebinding onto the same X
-- fail at the DB, not just at an app check that could race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clerk_users_account ON clerk_users (account_id);
```

`bootstrap` (auth.ts) sets `origin='bootstrap'`; `webSession` first-provision sets
`origin='web'`. Both are one-line additions; **no behavioral change** to either
path beyond stamping provenance.

> **Caveat — the UNIQUE-on-`account_id` index needs a one-time cleanup first.**
> Today nothing forbids two `clerk_users` rows pointing at one account, and the
> backfill (§6) plus any historical duplicates must be de-duplicated *before* the
> unique index can be created or the migration will fail. The migration therefore
> runs: (1) collapse/validate any existing account_id duplicates, (2) backfill
> `origin` (§6), (3) create the unique index.

### 3.3 Which `user_id` does the Clerk identity map to after linking?
Map C to **the redeeming owner's own `user_id`** — i.e. `p.userId` of the device
token that ran `rbox account link` (the live `Principal` from
`authenticate`/`authz.ts:5-10`), **not** an arbitrary "the owner of X" row.
Rationale: on a single-owner bootstrap account these coincide (it's the
`user_<…>` minted at `auth.ts:210`), but on a **multi-owner** account picking "an
owner row" could attach C to *another* human's rbox user. Binding to the
redeemer's own user means the Clerk identity is unified with **the exact rbox user
who proved possession**, which is the only person whose intent we actually have.
The shell's user row is reclaimed with the shell (§3.4). (Resolves the multi-owner
hazard codex flagged.)

**The redeemer's `p.userId` is captured at REDEEM into `pending_user`** (§3.2);
confirm reads it back (`clerk_users.user_id = pending_user`) rather than
re-deriving the user from `devices` at commit time (which would go stale if the
device were revoked/re-paired between redeem and confirm). Because redeem already
proved `pending_user` is an **owner** of X, the post-link `webSession` self-heal
(which only `INSERT OR IGNORE`s an owner membership for the *currently mapped*
user — and, post-Round-3, only on first provision, §3.5) is a **no-op** on X: it
can never *grant* a new membership, only re-assert one that already exists.
(Resolves Round-3 finding 2.)

### 3.5 `webSession` must not re-grant owner on every returning login (Round-3 finding 1)
Today `webSession` runs the `accounts`/`users`/`memberships` `INSERT OR IGNORE`
self-heal (clerk.ts:143-147) on **every** login — including returning, already-
provisioned ones. On an empty shell that is harmless, but once C maps to a real
account X it is a **privilege-resurrection vector**: if an admin ever revoked the
web user's owner membership on X, the next Clerk login would silently re-`INSERT
OR IGNORE` it back. **Fix (owned here):** move the three `INSERT OR IGNORE`s
**inside** the first-provision (`if (!map)`) branch, so a returning login only
*resolves* the existing mapping and mints a token — it never re-asserts
membership. Intact accounts are unaffected (the rows already exist); the only
behavior dropped is a "self-heal" of a partially-provisioned account, which cannot
arise because the three inserts run sequentially right after the mapping is
claimed. This is the one **required** `webSession` change (correcting §3.1's "no
happy-path change" for the returning path).

### 3.4 The empty shell already minted for web-first users — reclaim, don't strand
Every Clerk-first login created a shell `(account 'web'/free, user, owner
membership)` and possibly accumulated `web_*` session rows. On a successful link
we **tombstone** the shell, but only when it is provably empty and unanchored:

A shell is **reclaimable** iff ALL hold. The predicate enumerates **every
account-scoped *state* table and every billing/entitlement column that exists
today** (Round-3 finding 5 — a hand-picked partial list is a fail-*open* hazard),
with the **append-only forensic logs explicitly EXCLUDED** (Round-3 finding 6):
- `accounts.origin = 'web'` (never reclaim a `'bootstrap'` account — that is
  someone's crypto-anchored data),
- **no E2EE genesis:** no row keyed to it in `account_keys`, `device_keys`,
  `rosters`, `account_key_states`, **or `workspace_keys`** (migration 0011),
- **no durable devices:** no `devices` row with `expires_at IS NULL` (only
  ephemeral `web_*` sessions, if any),
- **no workspaces** (`workspaces.account_id`), **no `blob_refs`** (account_id),
  **no in-flight `uploads`** (account_id, 0006), **no active `pairing_tokens`**
  (`consumed_at IS NULL AND expires_at>now`), **no live `device_auth`**
  (`status IN ('pending','approved') AND expires_at>now`), and **no `commits`** —
  the real `commits` table (0011) has **no `account_id`**; ownership is via
  `workspaces`, so it is checked as `commits.workspace_id IN
  (SELECT workspace_id FROM workspaces WHERE account_id=shell)` (and is moot when
  there are no workspaces),
- **no billing/entitlement state:** `plan = 'free'` **and** `stripe_customer_id`
  IS NULL **and** `stripe_subscription_id` IS NULL **and** `grace_until` IS NULL
  (0012) **and** `extra_storage_bytes = 0` **and** `used_bytes = 0` (0007 — the two
  real entitlement/usage columns),
- the Clerk identity being relinked is its **only** `clerk_users` reference and its
  **only** owner membership.

**Explicit EXCLUSIONS (do NOT block reclaim).** `audit_log` (0006) and
`account_link_events` (0014) are **append-only forensic history**, keyed to an
account by design; counting them would make every shell that ever logged in
un-reclaimable (finding 6). They are deliberately *not* in the predicate — the
tombstone (`reclaimed_at`) + these logs are what keep a mistaken reclaim
recoverable. The maintenance invariant (§9.5) therefore reads: *every new
account-scoped **live-state** table must be added to the predicate; every new
append-only **log** table must be added to this exclusion list.*

The canonical, maintainable form is "reclaimable = not referenced by **any**
account-scoped row in **any** table and not carrying **any** non-default
billing/entitlement value." New state tables must be added to this predicate when
introduced (flagged as a maintenance invariant, §9).

Reclamation = stamp `accounts.reclaimed_at`, delete its `memberships`/`users`/
ephemeral `devices` rows, and (cron) GC. We **tombstone rather than hard-delete
inline** so the rebind transaction stays small and a mistaken reclamation is
recoverable from the audit trail.

**Hard rule — a non-reclaimable shell BLOCKS the link; it is never silently
abandoned.** The rebind moves the *only* Clerk route to the origin account away
from it (C now resolves to X). So if the origin shell is **not** reclaimable
(fails any §3.4 predicate — it has a durable device, a workspace, E2EE genesis
rows, `blob_refs`, a pending upload, **or Stripe state**), the redeem **must NOT
proceed to a silent rebind**. Instead it **refuses with a specific, actionable
error** (`409 origin_account_has_state`) and routes the user to an explicit
**resolve** step (billing migration below, or "this web account already has data —
contact support / choose merge direction"). We do not strand a non-empty account
behind an unreachable Clerk mapping. (Resolves codex's "abandoned account"
finding.)

**The common non-empty case — billing on the shell (the real wart).** Stripe
state lives **directly on `accounts`** (`stripe_customer_id`,
`stripe_subscription_id`, migration `0009_stripe.sql:5-6`; `plan` from 0006;
`grace_until` from 0012; the webhook keeps `accounts.plan` authoritative,
`stripe.ts`). If the user subscribed via the shell, the link is **blocked** until
billing is resolved. Two honest paths (§9.1):
- (a) **migrate billing** — re-point the Stripe customer/subscription to X. This is
  **a saga, not one transaction**: a D1 update and a Stripe API call cannot be
  atomic. Design it as **preflight → Stripe update (idempotent, keyed) → D1
  commit**, copying the **full** billing/entitlement set (`stripe_customer_id`,
  `stripe_subscription_id`, `plan`, `grace_until`, extras) onto X and clearing it
  on the shell, with the rebind gated on the Stripe step having succeeded
  (replayable on failure; never half-moved). Then reclaim.
- (b) **guided move** — cancel-at-period-end on the shell + resubscribe on X
  (Stripe handles proration).

Recommended default: **(a) re-point** for an *active* subscription (no card
re-collection), **(b) guided** only if the saga can't complete. Either way the
link **blocks** rather than silently rebinds when the shell carries billing —
never strand a paying customer's subscription on an unreachable account. (Blocking
is the always-safe fallback; the auto-migration saga is the convenience path.)

### 3.4.1 DECISION D1 — `rbox subscribe` is the PRIMARY billing path; re-point is the FALLBACK
The billing-on-shell wart only exists because a user *paid web-side on a shell*.
The decision (D1, recorded here) attacks it at the source **and** repairs the
installed base:

- **PRIMARY — `rbox subscribe` (no shell, no re-point).** A CLI user is already
  authenticated on their real account X with a **durable** device token. Billing
  binds the Stripe customer/subscription to **`Principal.accountId`**
  (`stripe.ts` `billingCheckout`: `client_reference_id`, `metadata[account_id]`,
  and `subscription_data[metadata][account_id]` are all `p.accountId`, and it
  reuses the account's existing `stripe_customer_id`). So a durable token calling
  `POST /v1/billing/checkout` yields a `cs_live` checkout **already bound to X** —
  the payment lands on the right account with **no Clerk identity, no web shell,
  and no re-point.** `rbox subscribe` simply opens that checkout URL in the
  browser; `rbox billing` opens the customer portal (`/v1/billing/portal`). This
  is a **billing handoff, not an identity handoff** — it binds no Clerk identity
  and creates no link; it is deliberately kept separate from the `account link`
  ceremony (which stays dashboard→CLI for takeover-safety, §5.2). The Slice-0
  route gate already permits a durable token on `/v1/billing/*` (default-deny
  applies only to `kind=='web'`), so no gate change is needed for the primary
  path. **Note (review caveat):** the gate still also permits a *web* token on
  `/v1/billing/*` — billing is intentionally reachable from both clients. "No
  shell" is a property of the CLI `rbox subscribe` *path* (a durable token on X),
  not an exclusivity property of the billing API.

- **Double-charge guard (server-side, defends BOTH web and CLI).** `billingCheckout`
  today has **no** guard against an account that *already* has an active
  subscription — it reuses the customer (avoiding duplicate customers) but a second
  checkout still creates a **second subscription on the same customer → a double
  charge**. The web app only avoids this by hiding the button client-side; `rbox
  subscribe` would walk straight into it. So `billingCheckout` **must 409
  `already_subscribed`** (pointing at the portal) when the account already carries
  a live subscription. Key the guard on **`stripe_subscription_id IS NOT NULL`** —
  the reliable signal (set at checkout / `subscription.created`, cleared on
  `subscription.deleted`, `stripe.ts:205`); `plan != 'free'` is a secondary tell. A
  **canceled-but-in-grace** account has `stripe_subscription_id IS NULL` +
  `grace_until` set and **must be allowed to re-subscribe**, so the guard keys on
  `stripe_subscription_id`, never on `grace_until`. `rbox subscribe` surfaces the
  409 as a friendly "you're already subscribed — `rbox billing` to manage" (exit 0,
  not an error).
- **FALLBACK — the re-point saga (§3.4.2).** For users who *already* subscribed on
  a web shell before `rbox subscribe` existed, the link must still move that
  subscription onto X. That is the re-point saga below. It is the **fallback**,
  not the default UX — new paying CLI users never touch it.

### 3.4.2 The re-point saga — buildable shape + the dual-routing-key trap
When `link/confirm` finds the origin shell's **only** blocker is billing (the
shell is otherwise §3.4-empty) **and** the destination X is **billing-empty**
(`stripe_customer_id IS NULL` and no active sub), it runs the saga *in place of*
the `409 origin_account_has_state` block, then reclaims the now-empty shell.

**CRITICAL — the webhook routes by TWO independent keys; moving only D1 columns is
a split-brain bug.** `stripe.ts`:
- `customer.subscription.created/updated` route by the **subscription's
  `metadata.account_id`** (`stripe.ts:177`).
- `customer.subscription.deleted` (and every ownership guard
  `WHERE … (stripe_customer_id IS NULL OR = ?)`) routes by the
  **`accounts.stripe_customer_id`** column (`stripe.ts:189,196,205`).

So if the saga moves only the D1 columns shell→X, the subscription's Stripe
`metadata.account_id` **still says shell**. The next renewal's
`subscription.updated` would then target the shell — and because the saga cleared
the shell's `stripe_customer_id`, the guard `(stripe_customer_id IS NULL OR = ?)`
**re-binds the customer back onto the shell** (split-brain). **The saga MUST update
the subscription's Stripe metadata too**, so *both* routing keys point at X.

**Saga steps (idempotent, replayable — modeled on the `stripe_events` discipline):**
1. **Preflight (reads).** Shell has `stripe_customer_id` **and**
   `stripe_subscription_id`; shell is otherwise §3.4-empty (the non-billing
   predicate holds). Destination X has `stripe_customer_id IS NULL`. If X already
   carries an active subscription → **do NOT merge two subscriptions** → block
   `409 destination_has_subscription` (route to guided resolution). Any other
   non-billing shell state → `409 origin_account_has_state` (unchanged block).
2. **Stripe step (idempotent).** `POST /v1/subscriptions/{sub_id}` setting
   `metadata[account_id]=X` (and the customer's `metadata[account_id]=X` if used).
   Re-running sets the identical value — Stripe PATCH semantics make this a no-op
   on replay. Gated on `STRIPE_SECRET`; if billing isn't provisioned the saga
   can't run → fall back to the block.
3. **D1 commit (one atomic `batch`, CAS-guarded — replay/race-safe).** Move the
   **full** billing set — `stripe_customer_id, stripe_subscription_id, plan,
   grace_until, extra_storage_bytes` — onto X with a claim guard that tolerates a
   **webhook having already bound the same customer to X** (the race below):
   `UPDATE accounts SET …<billing> WHERE id=X AND (stripe_customer_id IS NULL OR
   stripe_customer_id = ?cust)`. Then **unconditionally clear the shell's billing**
   with a CAS on the subscription it still carries: `UPDATE accounts SET
   stripe_customer_id=NULL, stripe_subscription_id=NULL, plan='free',
   grace_until=NULL, extra_storage_bytes=0 WHERE id=shell AND stripe_subscription_id
   = ?sub`. The shell-clear is the load-bearing half: it always runs once Stripe
   says X owns the sub, so the shell can never keep a stale customer the
   `subscription.deleted` guard would later match.
4. **Reclaim the shell** (the existing §3.4 confirm batch — the shell is now
   billing-empty, so `isReclaimableShell` passes).
5. **On any failure → retryable, never a stuck half-move.** Because the Stripe
   metadata update lands **first**, a failure *after* it leaves billing's routing
   pointed at X (both keys, once D1 lands) — **not** "fully on the shell." That is
   deliberate and safe: re-running `confirm` re-reads, finds the shell now
   billing-empty (or the D1 move idempotently re-applies via the
   `stripe_customer_id = ?cust` arm), reclaims, and completes. A failure *before*
   the Stripe step leaves everything on the shell (the link simply blocks and is
   retried). There is no state in which a renewal can re-bind to the shell.

The order **Stripe-first, D1-second** is deliberate: the Stripe metadata update is
the irreversible-once-renewed routing decision, so it must land before D1 claims
the customer for X. **The webhook race (called out by review):** a
`customer.subscription.updated` arriving between step 2 and step 3 routes by
`metadata.account_id = X` and its guard `(X.stripe_customer_id IS NULL OR = cust)`
holds (X is billing-empty pre-move) → it **binds the customer onto X early**. The
step-3 claim must therefore *also* accept `stripe_customer_id = cust` (not only
`IS NULL`), and the **shell-clear must be unconditional-on-the-sub** so the shell
is emptied regardless of who set X first. Either way both routing keys end on X;
the shell never re-binds.

---

## 4. The link ceremony

### 4.0 Naming — `rbox account link <code>`, NOT `rbox link`
**`rbox link` is already taken** — `src/cli/index.ts:74-106` binds a *directory*
to a workspace. The account-linking verb must therefore live under a new
`account` command group: **`rbox account link <code>`** (and `rbox account
status` / `rbox account unlink`). Do **not** overload the existing `link`. (This
is a real collision caught in the code, not a stylistic preference.)

### 4.1 Direction — dashboard shows the code, CLI owner redeems, dashboard CONFIRMS
A **mandatory two-phase** bind (phase 2 is the fix for the leaked-code grief case,
§5.2 / finding 2). Direction justified in §5.2.

**Transport & routing (Round-3 finding 3).** `start`/`status`/`confirm` are
authenticated **solely by a re-verified Clerk JWT** (no rbox bearer), so they are
**PUBLIC routes** placed *before* `authenticate()` in `worker.ts` — alongside
`/v1/web/session` — and verify the JWT internally. They are therefore **not**
governed by the Slice-0 web-token allowlist (that gate only applies to rbox-bearer
Principals; the link endpoints it lists are `redeem` + `unlink`). JWT transport:
`start`/`confirm` carry `clerkToken` in the JSON **body**; `GET status` carries it
in the **`Authorization: Bearer <jwt>`** header (a JWT has dots → fails the 64-hex
`TOKEN_RE`, so it is never mistaken for an rbox token) plus `pollKey` in the query.
The opaque link code is **≥128-bit** and shown once (`rbox-link_<base64url(32B)>`),
**not** the short `XXXX` mnemonic (§5.3, finding 10).

```
1. START — Dashboard, with a FRESH Clerk JWT (not just a stale rbox web token, §4.2)
      POST /v1/account/link/start   { clerkToken }       (the Clerk session JWT) — PUBLIC
   → server re-runs verifyClerkJWT(clerkToken) → sub = C  (so the code is bound to a
                                                            re-proven Clerk identity C)
   → REQUIRE an existing clerk_users[C] mapping (the dashboard always exchanges a
     /v1/web/session first, so it exists); else 409 web_session_required (finding 11)
   → INSERT account_link_codes{ code_hash, poll_key, clerk_user_id=C,
                                origin_account=clerk_users[C].account_id, expires_at=now+10min }
   → returns { code (plaintext ≥128-bit, once), pollKey }
   → dashboard shows: "Run this in a terminal signed in to your rbox account:
                          rbox account link rbox-link_xK7…<opaque>"

2. REDEEM (phase 1, → 'pending') — Terminal, a non-revoked OWNER + DURABLE device token on X
      rbox account link rbox-link_xK7…
   → POST /v1/account/link/redeem  { code }   (Bearer: X's device token) — AUTHED
   → server: atomic single-use consume; assert Principal.kind=='durable' && role=='owner'
             on X (§4.2); record pending_account=X, pending_device=p.deviceId,
             pending_user=p.userId (§3.3). NOTHING is rebound yet. Returns { account: X }
             so the terminal shows "Proposed link to account X — confirm in your dashboard."

3. CONFIRM (phase 2, → committed) — Dashboard, SAME Clerk identity C, shown the target
      Dashboard polls GET /v1/account/link/status?pollKey=…  (Authorization: Bearer <clerkJWT>)
        → { status, pendingAccount: X, fingerprint }
   → shows: "A terminal on account <X fingerprint> wants to manage this login. Approve?"
   → POST /v1/account/link/confirm { clerkToken, pollKey }   (re-verify sub==C) — PUBLIC
   → server: the ONE atomic conditional rebind transaction (§4.2.1). Now clerk_users[C]→X,
             shell reclaimed (§3.4) / billing-bearing shell → 409, account_link_events written.
```

Why phase 2 is not optional: it forces the **same live Clerk identity that
requested the code** to *see and approve the specific target account* before any
rebind. A stolen code redeemed onto an attacker's account Y produces a *pending*
bind that the victim's dashboard would show as "account Y wants to manage your
login" — and the victim declines. No rebind ever happens without C's explicit,
target-aware approval.

### 4.2 Server rules (the security core)
- **Code:** ≥128 bits of entropy. Stored as `sha256(code)` only; plaintext shown
  once in the dashboard. A human-typeable grouped form is display-only over full
  entropy (§5.3).
- **TTL:** 10 minutes (aligns with `PAIR_TTL_MS`). Single-use across *both* phases.
- **`link/start` and `link/confirm` require a FRESH Clerk JWT, re-verified** with
  `verifyClerkJWT` (clerk.ts) — **not** merely a bearer rbox `web_*` token.
  Rationale (finding 3): `authenticate()` proves only *possession of an rbox bearer
  token* and the `Principal` carries **no `clerk_user_id`**, so a stolen/stale web
  token is indistinguishable from a live Clerk session at that layer. Re-verifying
  the JWT re-proves the *specific Clerk identity* C and ties the code/confirm to
  it. (Alternative, if we ever want to authorize these by the rbox token instead:
  persist `clerk_user_id` + token kind on the web session row and check it — but
  re-verifying the short-lived JWT is simpler and stronger.)
- **Redeem authz = DURABLE + OWNER, fail-closed and live (finding 4).** A web
  session is *also* a `devices` row with a role, so an owner check alone is
  satisfiable by a stolen `web_*` owner token. Redeem therefore requires
  **`Principal.kind == 'durable'`** (the `expires_at IS NULL` CLI-token kind from
  §1.1) **AND** `role == 'owner'` on X via a live `memberships` lookup, on a
  non-revoked device (already enforced by `authenticate`). The redeemer is
  identified by the **unique `token_hash`** (not the non-unique `device_id`, §5.6),
  so the proof is sound. Owner-only because linking moves billing + installs the
  durable web-management identity; a `viewer`/`admin`/web token must not attach a
  Clerk identity.
- **`link/confirm` is ONE atomic conditional transaction** (finding 7) — it
  commits only if **all** still hold (else 409, no partial state): the code row is
  `pending` (phase-1 consumed, not yet committed, unexpired); `clerk_users[C]`
  still maps to `origin_account` (no concurrent rebind moved it); the target
  `pending_account` X is **not** `reclaimed`; X has **no other** `clerk_user_id`
  mapped (the `uq_clerk_users_account` index enforces this at the DB, §3.2/§5.5);
  and the origin shell is reclaimable-or-billing-resolved (§3.4) — otherwise it
  returns `409 origin_account_has_state` and the link is blocked, never silently
  abandoning the shell.
- **Re-link guard (§5.4):** if C is already mapped to a **non-shell** account
  (`origin='bootstrap'`/crypto-anchored), `confirm` refuses (`409 already_linked`)
  unless an explicit `rbox account unlink` ran first. Re-confirming the *same* X is
  an idempotent success. A Clerk identity manages **one** account at a time;
  last-write-wins is forbidden.

### 4.2.1 The atomic conditional confirm — the exact buildable shape (Round-3 finding 4)
"One transaction" is realized as **read-side pre-checks → one `db.batch([...])`
(D1 batches run in a single atomic transaction) of self-guarded statements →
post-batch verify**. Every write self-guards so a stale pre-check can only *no-op*,
never half-apply; the batch is atomic so a thrown UNIQUE rolls the whole thing back.

**Pre-checks (reads, all → `409`/`401` on failure, no writes):**
1. Load the code by `poll_key`; require `clerk_user_id == C`, `consumed_at NOT NULL`,
   `committed_at IS NULL`, `expires_at > now`, `pending_account` (=X) `NOT NULL`.
   *Idempotency:* if `committed_at NOT NULL` **and** `clerk_users[C].account_id == X`
   → return success (a re-confirm of the same target).
2. Re-link guard: read `clerk_users[C].account_id` (= `cur`) and its account `origin`.
   If `cur != origin_account` → `409 conflict` (concurrent move). If `cur` is a
   **non-shell** (`origin='bootstrap'`) **and** `cur != X` → `409 already_linked`.
3. Reclaim decision: `reclaimNeeded = (origin_account is a 'web' shell AND origin_account != X)`.
   If `reclaimNeeded` and the origin shell is **not** reclaimable (§3.4 predicate)
   → `409 origin_account_has_state` (the link blocks; never silent-rebind).

**Atomic `db.batch` (in order):**
- **rebind:** `UPDATE clerk_users SET account_id=X, user_id=pending_user
  WHERE clerk_user_id=C AND account_id=origin_account AND EXISTS(SELECT 1 FROM
  account_link_codes WHERE poll_key=? AND consumed_at IS NOT NULL AND committed_at
  IS NULL AND expires_at>now AND pending_account=X)` — the rebind **re-verifies the
  full code validity inside its own WHERE** (pending, unexpired, still proposing X),
  so the *write condition* (not just the prior JS read) gates the rebind — closing
  the Round-3-finding-1 TOCTOU. The `account_id=origin_account` clause also makes it
  **single-winner** (a concurrent second confirm finds C already on X → no-op). If X
  already has a different Clerk row, the `uq_clerk_users_account` UNIQUE index throws
  → **the whole batch rolls back** → caught as `409 already_linked`.
- **commit code:** `UPDATE account_link_codes SET committed_at=now
  WHERE poll_key=? AND committed_at IS NULL
    AND EXISTS(SELECT 1 FROM clerk_users WHERE clerk_user_id=C AND account_id=X)` —
  only marks committed if the rebind landed.
- **audit:** `INSERT INTO account_link_events (...) SELECT C, origin_account, X, 'cli_link', pending_device, now
  WHERE EXISTS(SELECT 1 FROM clerk_users WHERE clerk_user_id=C AND account_id=X)`.
- **reclaim (only if `reclaimNeeded`)**, each guarded by `the shell is now Clerk-orphaned`:
  `UPDATE accounts SET reclaimed_at=now WHERE id=origin_account
     AND NOT EXISTS(SELECT 1 FROM clerk_users WHERE account_id=origin_account)`;
  then `DELETE FROM memberships WHERE account_id=origin_account AND NOT EXISTS(…clerk_users…)`;
  `DELETE FROM users WHERE account_id=origin_account AND NOT EXISTS(…clerk_users…)`;
  `DELETE FROM devices WHERE account_id=origin_account AND expires_at IS NOT NULL` (ephemeral web
  sessions only — there are no durable devices on a reclaimable shell, §3.4).

**Post-batch verify:** re-read `clerk_users[C].account_id`; if `== X` → `200 { account: X }`,
else (the rebind guard no-op'd on a concurrent move) → `409 conflict`. A thrown
UNIQUE during the batch surfaces as `409 already_linked` (atomic rollback, no partial
state). The reclaim deletes touch **only** the origin shell and only once it is
Clerk-orphaned, so they can never delete X's rows.

### 4.3 Status polling = the confirm surface
`link/start` returns a `pollKey`; the dashboard polls `GET
/v1/account/link/status?pollKey=…` to learn the **proposed** `pending_account` and
a human-readable account fingerprint, then drives the phase-2 `confirm` (§4.1). The
poll never exposes the code or `token_hash`; `pollKey` is an opaque,
single-purpose handle. This is both the UX and the security trip-wire: the bind is
visible and approvable *before* it commits, not merely auditable after.

---

## 5. Failure / abuse / threat model

### 5.1 Linking to an account you don't own (the core takeover threat)
You cannot bind to X without a **non-revoked owner device token on X** *and* a
live Clerk session. A stranger with neither cannot link. The code is **not a
bearer that alone grants a binding** — it is a challenge that must be answered by
the *complementary* authenticated principal (an owner device). This is the whole
security argument: leaking the code is insufficient without the second live
credential.

### 5.2 Why direction = dashboard-shows-code (and not CLI-shows-code)
Both directions require both proofs at redeem; the difference is the **severity of
a leaked code**:
- **CLI-shows-code (rejected):** the code would encode *account X*. Whoever
  redeems with *a Clerk session* binds their Clerk identity to X. A leaked code +
  **any** Clerk session ⇒ an attacker's Clerk now manages X (billing, device
  list, design-19 revocation) = **takeover of the valuable account.**
- **Dashboard-shows-code (chosen):** the code encodes *Clerk identity C*. Whoever
  redeems must hold a **durable owner device on some account**. A leaked code can
  at most create a *pending* proposal to bind victim C to attacker account Y — and
  **phase 2 (§4.1) requires the victim's own live Clerk session to see "account Y
  wants to manage your login" and approve it**, which they won't. So the leaked-code
  outcome is **not even reversible grief — it never commits**: no rebind happens
  without C's explicit, target-aware confirmation. The victim's data account X is
  never reachable by a stranger (redeeming onto X needs a durable owner device on
  X). Strictly less severe than CLI-shows-code, *and* the two-phase confirm closes
  the residual misbind entirely. (This is the resolution to codex's "still allows
  linking to an account you don't own" finding.)

### 5.3 Code strength & transport
The code is a bearer binding for ~10 minutes — treat like the pairing token
(design 10 §1, accepted scrollback risk). **v1 ships the opaque full-entropy form
(D2): `rbox-link_<base64url(32 random bytes)>` = 256 bits**, stored only as
`sha256(code)`, shown once. The short `XXXX-XXXX` mnemonic from earlier drafts is
**rejected** for v1 (Round-3 finding 10): it carries nowhere near 128 bits, and
since the server stores only `sha256(code)` the *displayed plaintext itself* must
carry the entropy — a grouped human-typeable form would need a separate
server-side indirection table, deferred as polish. Uniform 401 for
invalid/expired/consumed (no enumeration), exactly like `redeemPairToken`.

### 5.4 Double-link / re-link / unlink
- **Double-link:** single-use code (consumed atomically). A second redeem of the
  same code → 401.
- **Re-link to a different account:** blocked while C is linked to a non-shell
  account; requires explicit `rbox account unlink` first (or a confirmed
  `--force`), which records an `account_link_events` row. Prevents silent
  billing/identity migration off the user's real account.
- **Unlink:** owner-gated (`role='owner'` on the currently linked account X). Both
  the CLI (durable owner token) and the dashboard (its rbox `web_*` owner token,
  which authenticates on X *after* the link) reach the **same authed route**, so no
  separate Clerk-JWT path is needed. Rebinds C back to a fresh `'web'` shell (so the
  Clerk user still has *an* account; billing continuity is explicit, not dangling),
  audited (`method='unlink'`). Unlink does **not** revoke CLI devices or touch the
  roster (E2EE untouched).
- **Unlink billing guard (Round-3 finding 7).** Symmetric to the link's
  billing-on-shell block: if the linked account **X carries Stripe state**
  (`stripe_customer_id` or `stripe_subscription_id` set), unlink would strand X's
  subscription on an account that no longer has *any* Clerk login — the original
  bug in reverse. Unlink therefore **BLOCKS** in that case with
  `409 linked_account_has_billing`, routing the user to resolve/cancel billing
  first (or, once Slice 6 lands, migrate it). Blocking is the always-safe fallback;
  we never strand a paying customer's subscription behind no web login.

### 5.5 Multi-identity / multi-bootstrap edge cases
- **One Clerk id → many bootstrap accounts:** `clerk_users` PK is
  `clerk_user_id`, so a Clerk id maps to exactly one account. Linking a second
  bootstrap account is a *re-link* and hits the §5.4 guard (explicit unlink
  required). A Clerk identity manages one rbox account at a time — last-write-wins
  is explicitly forbidden (it could silently move billing).
- **Many Clerk ids → one bootstrap account:** rejected in v1 (§4.2,
  one-Clerk-per-account). Genuine multi-web-owner is a future seats/team feature.
- **A user with two laptops, both owner devices on X:** fine — either may redeem;
  the bind targets X regardless of which owner device redeems.

### 5.6 `device_id` uniqueness — already RESOLVED upstream (migration 0013)
The redeemer is authenticated by `token_hash` (unique PK of `devices`, 0004), so
the link authz never depended on `device_id`. And the prerequisite that designs
16/17/19 flagged — non-unique `device_id` poisoning the revoke target — **has
since landed**: **`0013_device_id_unique.sql` makes `device_id` GLOBALLY unique**
(dedup-then-`CREATE UNIQUE INDEX devices_device_id_unique`), explicitly
reconciling `devices.device_id` with the global `device_keys.device_id PRIMARY
KEY` (0011) and making `revokeDevice`'s `WHERE device_id=? AND account_id=?` target
exactly one row. So the linked-dashboard device-management result this doc promises
is **sound today**: `account_link_events.actor_device` is an unambiguous id, and a
web-initiated token-revoke (design 19 part (a)) hits a single device. (Note: 16/17
still describe `device_id` as non-unique because they predate 0013; that caveat is
now stale — recorded in §7.4.)

### 5.7 Abuse rate-limiting
- `link/start` is authed (a live Clerk session) — cap **active unconsumed codes
  per Clerk id** (e.g. ≤5, mirroring `PAIR_ACTIVE_CAP`, auth.ts:85) via the same
  atomic `INSERT…SELECT…WHERE count<cap` pattern (auth.ts:135-143) to bound
  code-spam.
- `link/redeem` is authed (an owner device token); the OWNER gate + single-use +
  TTL bound it. Per-IP/sub request limiting is the same KV/DO follow-up design 11
  already defers (§8.2 there).

---

## 6. Migration / back-compat for already-stranded shells

Every user who hit the web before this lands is in the broken state: `clerk_users`
maps C → an empty `'web'` shell; their real account X has no `clerk_users` row.

**A one-time `origin` backfill IS required (correcting the earlier "no migration
forced" overclaim, finding 5).** Without it every pre-existing shell reads
`origin=NULL`, and since we (correctly) refuse to auto-tombstone NULL-origin
accounts, the *exact installed-base shells this design exists to repair* would be
un-reclaimable — the link would block on them forever. So migration `0014` runs a
deterministic backfill over existing `accounts`:

The classifier uses the **same exhaustive predicate as §3.4** (Round-3 finding 5 —
the earlier 6-clause list was a fail-open subset), *literally* — including the
**active-only** `pairing_tokens`/`device_auth` tests (Round-3 finding 3: §6 must
not block on historical/consumed artifacts when §3.4 blocks only live ones; the
migration uses `CAST(strftime('%s','now') AS INTEGER)*1000` for "now" in epoch ms).
`commits` is checked via the `workspaces` join (no `account_id` column); the billing
test covers all six real columns; `audit_log`/`account_link_events` are excluded
(forensic logs):

```
-- A real (crypto-anchored / data-bearing / billing-bearing) account → 'bootstrap'
-- (never reclaimable). EXHAUSTIVE over every account-scoped state table + billing col:
UPDATE accounts SET origin='bootstrap'
 WHERE origin IS NULL
   AND ( id IN (SELECT account_id FROM account_keys)
      OR id IN (SELECT account_id FROM device_keys)
      OR id IN (SELECT account_id FROM rosters)
      OR id IN (SELECT account_id FROM account_key_states)
      OR id IN (SELECT account_id FROM workspace_keys)
      OR id IN (SELECT account_id FROM workspaces)
      OR id IN (SELECT account_id FROM blob_refs)
      OR id IN (SELECT account_id FROM uploads WHERE account_id IS NOT NULL)
      OR id IN (SELECT account_id FROM pairing_tokens WHERE consumed_at IS NULL AND expires_at > CAST(strftime('%s','now') AS INTEGER)*1000)
      OR id IN (SELECT account_id FROM device_auth WHERE account_id IS NOT NULL AND status IN ('pending','approved') AND expires_at > CAST(strftime('%s','now') AS INTEGER)*1000)
      OR id IN (SELECT DISTINCT account_id FROM devices WHERE expires_at IS NULL)
      OR plan != 'free'
      OR stripe_customer_id IS NOT NULL
      OR stripe_subscription_id IS NOT NULL
      OR grace_until IS NOT NULL
      OR extra_storage_bytes != 0
      OR used_bytes != 0 );

-- A provably-empty web shell (clerk_users-mapped, none of the above) → 'web'
-- (reclaimable). The data/billing rows already became 'bootstrap' above, so any
-- remaining NULL clerk-mapped account is empty:
UPDATE accounts SET origin='web'
 WHERE origin IS NULL
   AND id IN (SELECT account_id FROM clerk_users);
-- Anything still NULL after this is an ambiguous legacy account → stays NULL =
-- NOT reclaimable (fail-closed; a human can reclassify).
```

- **The link ceremony (§4) is the back-compat path.** A stranded user runs
  `rbox account link <code>` once from a durable owner device on X; the two-phase
  bind + shell reclamation (§3.4) repairs them. Because the backfill stamped their
  empty web shell `origin='web'`, reclamation now succeeds; a shell with a
  subscription is stamped `'bootstrap'`/blocked and routes to billing-resolve
  (§3.4), never abandoned.
- **NULL stays not-reclaimable** (fail-closed) — a NULL-origin account is treated
  as possibly-real and never auto-tombstoned.
- **Discovery nudge (optional, A-routed):** the dashboard empty state (17 §4.1)
  can show "Have you used the `rbox` CLI? Link your account" → the §4 start flow.
  It must **not** auto-detect-and-bind (that would be option C's takeover risk).

---

## 7. Interactions with the dependent designs (what they get once this lands)

### 7.1 Design 16 (new-device emails) — linking supplies the missing identity→email BRIDGE
16 §12.1 names this exact gap as its biggest, structural limitation: a CLI-first
account is "permanently un-notifiable" because owner-email resolution
(`memberships role='owner'` → `clerk_users` → email, 16 §3.1-3.2) finds **no
`clerk_users` row** for X. Linking creates that row (C → X), which is the piece 16
is missing. **Precise division of labor (finding 10):** `clerk_users` today has
**no email column** and `clerkEmailVerified` (clerk.ts:153) returns only a
boolean — so linking provides the **`clerk_user_id`↔X mapping**, while the **email
storage + refresh** is *design 16's own addition* (16 §3.2 adds
`clerk_users.email`/`email_updated_at` and a returning-login refresh). This doc
does **not** claim a cached email exists today; it claims linking unblocks 16 by
giving X a Clerk identity to resolve an email *through*. Together they turn 16 from
"web-only coverage" into full coverage.

### 7.2 Design 17 (device/workspace dashboard) — shows the real account
17 §1.3a/§8.1 flags "which account this list shows" as its single biggest caveat
and top open question: the list is scoped to `Principal.accountId`, which today is
the shell. After linking, `Principal.accountId = X`, so `GET
/v1/account/devices|workspaces` shows the user's **real machines and workspaces**
instead of an empty shell. This doc **is** the "bootstrap↔Clerk account-link flow"
17 calls "unsolved and OUT OF SCOPE (owned by onboarding)."

### 7.3 Design 19 (revocation) — operates on the right account, with the E2EE caveat intact
Once linked, the dashboard can issue token-level revokes (design 19 part (a),
`POST /v1/auth/devices/:id/revoke`) against X's devices. The E2EE asymmetry from
17 §7 is **unchanged**: the browser still cannot author the signed `roster vN+1` /
epoch rotation (part (b)) — that needs an enrolled CLI device. Linking fixes
*which account* the revoke targets; it does not give the browser crypto authority.

### 7.4 Shared prerequisite — unique device-credential id (now SATISFIED)
16 §5.2/§12.7, 17 §8.5, and §5.6 here all wanted the same thing: a unique,
high-entropy public credential id. **It has landed: `0013_device_id_unique.sql`
makes `device_id` globally unique** (reconciled with `device_keys.device_id PRIMARY
KEY`, 0011). This unblocks the revoke deep-link (16), the revoke target (17/19),
and clean link auditing (here). 16/17's "device_id is non-unique" language predates
0013 and should be treated as stale; this doc builds on the post-0013 reality.

---

## 8. Endpoints & files (surface, for the eventual build — not implemented here)

| Endpoint | Routing / Auth | Purpose |
|---|---|---|
| `POST /v1/account/link/start` | **PUBLIC** route; **fresh Clerk JWT** in body, re-verified (§4.2) | mint a single-use ≥128-bit link code bound to re-proven C; require existing `clerk_users[C]` (else 409 `web_session_required`); cap active codes/Clerk id |
| `POST /v1/account/link/redeem` | **AUTHED**; **durable** CLI **owner** device token (Bearer) | phase 1: consume code, assert kind=durable+owner on X, record *pending* (account/device/`pending_user`) — no rebind yet |
| `GET  /v1/account/link/status` | **PUBLIC** route; **fresh Clerk JWT** in `Authorization: Bearer` header, `pollKey` in query (sub==C) | poll the *proposed* `pendingAccount` + fingerprint (drives the confirm) |
| `POST /v1/account/link/confirm` | **PUBLIC** route; **fresh Clerk JWT** + `pollKey` in body (sub==C) | phase 2: one atomic conditional rebind clerk_users→X + shell-resolve + audit (§4.2.1) |
| `POST /v1/account/unlink` | **AUTHED**; durable **or** web **owner** token on X | rebind C → fresh shell, audit; blocks `409 linked_account_has_billing` if X has Stripe state (§5.4); never touches devices/roster |
| `GET  /v1/account/status` | **AUTHED**; any token on the account | report `{ accountId, linked }` — whether a `clerk_users` row maps this account (drives `rbox account status`) |
| `POST /v1/billing/checkout` | **AUTHED**; durable **or** web token | binds the Stripe checkout to `Principal.accountId` (§3.4.1) — the surface `rbox subscribe` opens from a durable token (no new endpoint) |
| `POST /v1/billing/portal` | **AUTHED**; durable **or** web token | customer-portal URL for `Principal.accountId` — the surface `rbox billing` opens |

"PUBLIC route" = registered in `worker.ts` *before* the global `authenticate()`
(like `/v1/web/session`), carrying no rbox Principal — so it is outside the §1.1
web-token gate and verifies its Clerk JWT internally (Round-3 finding 3).

| File | Change |
|---|---|
| `apps/api/migrations/0014_account_linking.sql` | new — `account_link_codes` (two-phase + `poll_key`), `account_link_events`, `accounts.origin`/`reclaimed_at`, `uq_clerk_users_account`, the **`origin` backfill** (§6) |
| `apps/api/src/auth.ts` | thread **`Principal.kind` (`durable`/`web`)** by **adding `d.expires_at` to `authenticate`'s SELECT projection** (§1.1, finding 9); `bootstrap` stamps `origin='bootstrap'`; new `redeemLink`/`unlinkAccount`/`accountStatus` helpers (reuse `sha256Hex`, atomic-cap + single-use-consume patterns) |
| `apps/api/src/authz.ts` | add `kind` to `Principal` |
| `apps/api/src/clerk.ts` | `webSession`: stamp `origin='web'` **and gate the account/user/membership self-heal to `if (!map)`** (§3.5, finding 1); new `startLink`/`linkStatus`/`confirmLink` on the **re-verified-Clerk-JWT** path (reuse `verifyClerkJWT`) |
| `apps/api/src/worker.ts` | PUBLIC routes for `start`/`status`/`confirm`; AUTHED routes for `redeem`/`unlink`/`status`; **enforce the §1.1 exact-match web-token gate** (default-deny; 403 a web token off everything but the allowlisted pairs) |
| `src/cli/index.ts` | new `account` command group (`link`/`status`/`unlink`) — must NOT collide with existing `link <path>` (§4.0) |
| `src/cli/auth-cmd.ts` | `accountLink(code)`, `accountStatus()`, `accountUnlink()` |
| `apps/web/` | dashboard "Link your CLI account": start → show code → poll → **confirm target account** (phase 2) |
| `apps/api/src/stripe.ts` | new `repointBillingToAccount` saga (§3.4.2): idempotent Stripe `metadata[account_id]` update + CAS-guarded D1 billing-column move shell→X (the dual-routing-key fix) |
| `apps/api/src/account-link.ts` | `confirmLink` runs the saga when the shell's ONLY blocker is billing AND X is billing-empty (else block); `409 destination_has_subscription` when X already has a sub |
| `src/cli/subscribe-cmd.ts` (+ `index.ts`) | `rbox subscribe [plan]` / `rbox billing` — call `/v1/billing/{checkout,portal}` with the durable token and open the URL cross-platform (`open`/`xdg-open`; print as fallback) |

**Tests (business logic, per CLAUDE.md — not type-checks):**
- Two-phase happy path: start (fresh JWT) → redeem (durable owner) records
  *pending* with no rebind → confirm (same C) rebinds C→X; returning `webSession`
  then resolves C→X.
- **Confirm is mandatory:** a redeem alone never rebinds; without confirm,
  `clerk_users[C]` is unchanged.
- **Token-kind gate (§1.1):** a `web_*` token is 403 on `v1/keys/*` / blob upload
  / workspace commit; a durable token passes.
- **Redeem requires durable+owner:** a `web_*` owner token → 403; a `viewer`/
  `admin` durable token → 403; durable owner → pending.
- **Fresh-JWT gate:** `link/start`/`confirm` with only a stale rbox `web_*` bearer
  (no valid Clerk JWT) → 401.
- Single-use REDEEM: a second redeem of a consumed code → 401; expired → 401.
  (Distinct from CONFIRM idempotency below — Round-3 finding 2: redeem is strictly
  single-use; a re-confirm of the *same already-committed target* is idempotent 200.)
- Shell reclamation only when provably empty/unanchored (§3.4); a shell with a
  durable device / workspace / e2ee row / **subscription** → link **blocks**
  (`409 origin_account_has_state`), never silent-rebind or auto-delete.
- Conditional confirm: rebind aborts (409) if `clerk_users[C]` moved, X is
  reclaimed, or another Clerk id already maps X (`uq_clerk_users_account`).
- Re-link guard: C already on a non-shell account → 409 without explicit unlink;
  re-confirm same X → idempotent success.
- **Leaked-code property:** a stranger redeeming a stolen code onto their own
  account Y only creates a *pending* proposal; the victim's confirm step declines
  it; no rebind commits.
- Backfill (§6): a pre-existing empty web shell → `origin='web'` (reclaimable); a
  data/billing-bearing account → `origin='bootstrap'` (blocked); ambiguous → NULL.
- E2EE untouched: link/confirm/unlink write no `account_keys`/`rosters`/
  `device_keys` rows.

---

## 9. Open questions for the human
1. **Billing-on-shell migration (§3.4) — RESOLVED (D1).** Decision: **`rbox
   subscribe` is the PRIMARY billing path** (a durable CLI token opens a checkout
   already bound to X — no shell, no re-point; §3.4.1), and the **re-point saga is
   the FALLBACK** for users who already paid web-side (§3.4.2, with the
   dual-routing-key Stripe-metadata fix). Two sub-cases still block (the
   always-safe fallback): a shell carrying **non-billing** state, and a destination
   X that **already has an active subscription** (`409
   destination_has_subscription` — we never auto-merge two subs). Guided
   cancel+resubscribe (§3.4(b)) remains the manual escape hatch for those.
2. **Token-kind route gate (§1.1) is now a hard prerequisite of the E2EE ceiling.**
   Ship the `Principal.kind` + mutating-route 403 policy *with* this (recommended —
   without it "web can never sync" is unenforced), or track it as its own
   security-hardening item? Either way linking should not land before it.
3. **Code form.** Full-entropy opaque token (safest), or human-typeable
   `XXXX-XXXX` backed by ≥128 bits? The latter is friendlier for the
   "read it off the dashboard, type it in the terminal" flow.
4. **One-Clerk-per-account in v1 (§5.5)** — fine to defer multi-web-owner to a
   future seats/team feature? (Now schema-enforced by `uq_clerk_users_account`.)
5. **Shell-reclaimable predicate is a maintenance invariant (§3.4).** Every future
   account-scoped table / billing column must be added to the "is this shell
   empty?" check or a non-empty shell could be misclassified reclaimable. Encode it
   as a single derived check (+ a test that fails when a new account-scoped table is
   added without updating it)? (Note: the unique-`device_id` prerequisite §5.6/§7.4
   is **already satisfied** by migration 0013 — no longer an open item.)
6. **`link/start`/`confirm` auth** — re-verify the short-lived Clerk JWT
   (recommended, §4.2), or persist `clerk_user_id` + token-kind on the web-session
   row and authorize by the rbox token instead?
7. **Web-approved CLI bootstrap (genesis-into-shell)** — build the optional B
   enhancement (a new bootstrap-into-existing-account endpoint so the web shell
   itself becomes the crypto world, skipping the later reclaim), or keep B = "web
   signup + normal bootstrap + A"?

---

## 10. Codex adversarial review

Reviewer: `gpt-5.5` (xhigh), foreground, no web search. Round 1 on the first draft
returned **VERDICT: FAIL** with 11 findings — all genuine, all grounded in the real
code, all resolved in the text above. Summary + resolution:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | Critical | "web can't sync" is asserted but **unenforced** — a web token is a normal `devices` row, `Principal` has no kind, and `worker.ts` routes it through `v1/keys/*`/blobs/commit; commits aren't server-sig-verified, so a linked web token could advance state with garbage. | **§1.1 added:** thread `Principal.kind` (durable/web) from the existing `expires_at` read; route policy rejects `kind=='web'` on all mutating crypto/sync routes. The ceiling is now a hard prerequisite, not a claim. |
| 2 | Critical | Dashboard-code leak still allows binding victim C to attacker account Y (owner web access to Y, billing, revoke) — "reversible grief" hand-waved. | **§4.1 made two-phase mandatory:** redeem only records a *pending* proposal; the victim's live Clerk session must *confirm the specific target account* before any rebind. A stolen code never commits. (§5.2 rewritten.) |
| 3 | High | "live Clerk session" untrue — `link/start` authed by a bearer `web_*` token, but `authenticate()` proves only token possession and `Principal` carries no `clerk_user_id`. | **§4.2:** `link/start`/`confirm` require a **fresh Clerk JWT** re-verified via `verifyClerkJWT`; alternative (persist `clerk_user_id`+kind) noted. |
| 4 | High | CLI-owner proof unenforceable — web sessions are also owner `devices` rows, so a naive owner check passes a `web_*` token. | **§4.2:** redeem requires `Principal.kind=='durable'` **and** `role=='owner'`, identified by unique `token_hash`. |
| 5 | High | Stranded-shell migration unsolved — existing shells predate `accounts.origin`; NULL is not reclaimable, so the installed base stays broken. "No data migration forced" is wrong. | **§6 rewritten:** migration `0014` runs a deterministic `origin` backfill (data/billing → `bootstrap`; provably-empty clerk-mapped → `web`; ambiguous → NULL/fail-closed). Overclaim corrected. |
| 6 | High | Non-reclaimable shells become **abandoned** — rebind removes the only Clerk route; Stripe state lives on `accounts` (0009). | **§3.4 hard rule:** a non-reclaimable/billing-bearing shell **blocks** the link (`409 origin_account_has_state`) and routes to billing-resolve; never silent-rebind. |
| 7 | Med | One-Clerk-per-account stated but not schema-backed; no `poll_key`; redeem must be one conditional transaction. | **§3.2/§4.2:** added `uq_clerk_users_account` UNIQUE index + `poll_key`; `confirm` is one atomic conditional rebind (origin unchanged, target not reclaimed, no other Clerk on X, single-use). |
| 8 | Med | Mapping C to "X's existing owner user" is unsafe on multi-owner accounts. | **§3.3:** map to the **redeeming owner's own `p.userId`**, the only proven-intent user. |
| 9 | Med | `device_id` non-uniqueness is a prerequisite (revoke updates by `device_id`), not audit slop. | **§5.6 elevated:** unique credential id is a **hard prerequisite of the linked-dashboard device-management result**; shared with 16/17/19 (§7.4). |
| 10 | Med | Email claim incomplete — `clerk_users` has no email column; `clerkEmailVerified` returns a boolean. | **§7.1:** linking supplies only the `clerk_user_id`↔X **mapping**; the email column + refresh is design 16's own addition. No cached-email overclaim. |
| 11 | Med | Option B asserted, not designed — `bootstrap` always mints a new account; normal login needs an approver device. | **§2/Option B rewritten honestly:** B = web signup + normal bootstrap (creates X) + A to link/reclaim; genesis-into-shell is a flagged *future* enhancement needing a new endpoint (§9.7). |

**Disposition.** The iterate-and-re-run budget is one round; these 11 findings are
all resolved above. The items a re-review would still raise are deliberately scoped
**out** as cross-doc prerequisites / human decisions, not omissions: the
`Principal.kind` route gate (§1.1, recommended to ship *with* this — §9.2), the
unique device-credential id (§5.6/§7.4, shared with 16/17/19), and the
billing-on-shell migration policy (§3.4/§9.1).

### 10.1 Round 2 (on the revised draft) — VERDICT: FAIL → folded in / scoped

The re-review confirmed prior findings **#2, #3, #8, #10, #11 genuinely
resolved**, **#7 resolved** (modulo exact impl of the confirm transaction +
duplicate cleanup), takeover closed by the two-phase confirm, and **no false
"web can decrypt" implication**. It surfaced four sharper items, all folded above:

1. **Token-kind gate must be DEFAULT-DENY and cover credential-mint routes**
   (#1/#4 not fully closed): a deny-list of only crypto/sync routes lets a web
   token call `pair/create` / `device/approve` / `POST /v1/workspaces` to mint a
   *durable* credential and then bypass the gate. **Resolved §1.1:** web tokens are
   default-deny with an explicit allowlist; the mint/approve/workspace routes are
   explicitly 403 for `kind=='web'`.
2. **`device_id` finding (#9) is STALE** — `0013_device_id_unique.sql` already made
   `device_id` globally unique. **Resolved §5.6/§7.4:** rewritten to treat
   uniqueness as satisfied; 16/17's "non-unique" language flagged as pre-0013.
3. **Reclamation/backfill predicates were a partial hand-list** (fail-open hazard).
   **Resolved §3.4/§6:** the predicate is now "not referenced by **any**
   account-scoped row in **any** table and carrying **no** non-default
   billing/entitlement value" (adds `workspace_keys`, `uploads`, `pairing_tokens`,
   `device_auth`, `plan!='free'`, `grace_until`, extras), with a maintenance
   invariant (§9.5).
4. **Billing migration can't be one D1+Stripe transaction.** **Resolved §3.4:**
   reframed as an idempotent **preflight → Stripe → D1 commit saga** moving the
   full billing set; **blocking the link remains the always-safe fallback**.

**Disposition.** The iterate-and-re-run budget (one round) is spent. Round 2's FAIL
was narrow — exhaustiveness of the route allowlist and the reclaim predicate, plus
the billing saga — and every item is now reflected in the design text as an
enumerated build requirement rather than a hidden gap. The residual the reviewer
would still note (proving the allowlist/predicate are *exhaustive in code*, and the
billing saga's exact idempotency keys) is implementation-surface, called out in
§1.1, §3.4, §8, and §9, not omitted.

### 10.2 Round 3 (implementability + correctness pass, on the revised draft) — VERDICT: FAIL → all 12 resolved

Reviewer: `gpt-5.x`-class, foreground, no web search. A fresh adversarial pass for
*buildability* (does a competent engineer have an unambiguous, non-contradictory
spec, and does anything contradict the real code). 12 findings — all genuine, all
resolved in the text above:

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | Critical | `webSession` self-heals an **owner** membership on *every* login (clerk.ts:143-147); after C→X this re-grants owner on the real account → privilege resurrection. | **§3.5 (new) + §3.1 corrected:** gate the three `INSERT OR IGNORE`s to the first-provision `if (!map)` branch; a returning login only resolves+mints. The one required `webSession` change. |
| 2 | Critical | Schema can't implement "map C to the redeeming owner": `account_link_codes` had no `pending_user`; re-deriving from `devices` at confirm is stale. | **§3.2/§3.3:** added `pending_user`, captured at redeem (`p.userId`), read back at confirm. Since redeem proved it's an owner of X, the §3.5 self-heal is a no-op. |
| 3 | High | Endpoint auth/routing contradictory — JWT-only `start/status/confirm` vs "under the Slice-0 allowlist" (which only exists *after* `authenticate()`); `GET status` JWT transport unspecified. | **§4.1/§8:** `start/status/confirm` are **PUBLIC** routes (before `authenticate`), JWT in body (POST) or `Authorization: Bearer` header (GET status); the web-token gate applies only to the AUTHED `redeem`/`unlink`. |
| 4 | High | "one atomic conditional confirm" asserted, no SQL shape / rollback story. | **§4.2.1 (new):** explicit pre-checks → one self-guarded `db.batch` (atomic) → post-batch verify; UNIQUE-violation rollback → 409; reclaim deletes guarded by "shell now Clerk-orphaned." |
| 5 | High | Reclaim/backfill §6 SQL was a partial list; named `commits` as account-scoped (it has no `account_id`). | **§3.4/§6:** exhaustive over all real state tables; `commits` via the `workspaces` join; billing covers all six columns (`plan`,`stripe_customer_id`,`stripe_subscription_id`,`grace_until`,`extra_storage_bytes`,`used_bytes`). |
| 6 | High | "any account-scoped row" is too broad — `audit_log` (+ new `account_link_events`) would make every shell un-reclaimable. | **§3.4:** explicit EXCLUSION list — append-only forensic logs (`audit_log`, `account_link_events`) never block reclaim; invariant in §9.5 split into state-table vs log-table rules. |
| 7 | High | Unlink strands X's billing in reverse (subscription left on an account with no Clerk login). | **§5.4:** unlink **BLOCKS** `409 linked_account_has_billing` when X carries Stripe state — symmetric with the link-side block. |
| 8 | Med | Default-deny gate used a `GET /v1/account/*` wildcard (future GETs leak to web by accident). | **§1.1:** replaced with an **exact (method,path) allowlist**; enumerated pairs. |
| 9 | Med | "`expires_at` already read by `authenticate`" is false — it's only in the `WHERE`, not the projection. | **§1.1/§8:** corrected — the build **adds `d.expires_at` to the SELECT projection**, then derives `kind`. |
| 10 | Med | Code example `RBQX-7F3K` is ≪128 bits; with `sha256(code)` storage the *plaintext* must carry the entropy. | **§4.1/§5.3:** v1 ships the opaque `rbox-link_<base64url(32B)>` (256-bit); the short mnemonic is rejected (would need a separate indirection table). |
| 11 | Med | `link/start` assumes a `clerk_users` row exists (`origin_account NOT NULL`) but a fresh JWT doesn't guarantee one. | **§4.1/§8:** `start` **requires** an existing mapping (the dashboard always exchanges `/v1/web/session` first) → else `409 web_session_required`. |
| 12 | Low | "same fresh Clerk session" isn't enforceable — `verifyClerkJWT` returns only `sub`. | Wording corrected throughout to "same Clerk **identity** C (sub)"; we bind at the user level, which is the property that matters. |

**Disposition.** All 12 are folded into the text above as concrete, buildable
requirements (new §3.5 and §4.2.1; corrected §1.1, §3.1, §3.2, §3.3, §3.4, §4.1,
§5.3, §5.4, §6, §8). No finding is deferred. The design is now self-consistent with
the real `auth.ts`/`clerk.ts`/`worker.ts`/migrations and unambiguous to implement.

### 10.3 Round 3, re-review of the revised draft — VERDICT: FAIL → 3 sharper items folded

The re-review confirmed the two-phase bind and the default-deny exact-match gate
are resolved and match the built `Principal.kind`/`webTokenAllowed`. It surfaced
three precise residuals on confirm/backfill, all now fixed in text **and code**:

1. **§4.2.1 confirm was not *fully* self-guarded.** The batch writes gated on
   `clerk_users[C]` state but not on the **code row's** pending/unexpired/X state, so
   D1 batch atomicity didn't make the JS pre-read part of the write condition.
   **Resolved §4.2.1:** the rebind now carries an inline `EXISTS(account_link_codes
   … consumed_at NOT NULL AND committed_at IS NULL AND expires_at>now AND
   pending_account=X)` guard — the write itself re-verifies code validity and is
   single-winner. (Implemented in `confirmLink`.)
2. **Idempotency was contradictory** — §4.2 said re-confirm same X = idempotent 200,
   the test list said "second redeem/confirm of a consumed code → 401." **Resolved
   §8 tests:** split into *redeem* (strictly single-use → 401) vs *confirm* (re-confirm
   of the same committed target → idempotent 200). Both have tests.
3. **§6 backfill ≠ §3.4 predicate** — §6 blocked on *any* historical
   `pairing_tokens`/`device_auth` row while §3.4 blocks only *live* ones. **Resolved
   §6 + migration 0014:** the backfill now uses the same **active-only** test
   (`consumed_at IS NULL AND expires_at>now`; `status IN ('pending','approved') AND
   expires_at>now`), with "now" as `CAST(strftime('%s','now') AS INTEGER)*1000`.

**Disposition.** The three are fixed in the design *and* the implementation
(`account-link.ts`, `0014_account_linking.sql`) with passing Miniflare tests
(two-phase happy path incl. reclaim, confirm-mandatory, durable+owner redeem,
fresh-JWT gate, single-use/expired, conditional-confirm abort, re-link guard,
leaked-code property, dirty-shell block, E2EE-untouched, unlink+billing-guard,
idempotent re-confirm). The implementability budget is spent; the design is
self-consistent and built.
