# Design 30 — Device management (devices route + new-device email + web unlink/revoke)

> **Implementation status: 🟡 PARTIAL** — slices 1–3 (the `/devices` route, device revoke, unlink + live-web-session revoke) are **SHIPPED & live** (PR #8, `app.rbox.to/devices`). **Slices 4–5 (new-device email infra + the real Cloudflare Email Service send) are BUILT** on the API; slice 6 (owner-gated opt-out mutation UI + over-cap coalescing summary) is deferred. Design + build plan, codex-reviewed (2026-06-30).
>
> **Sending-domain correction (2026-06-30):** the live onboarded + enabled Email Sending
> domain is **`mail.rbox.to`** (not `security.rbox.to` — references updated throughout).
> `From: security@mail.rbox.to`. Send via the NEW Email Service `send()` binding
> (`env.EMAIL.send`, wrangler `"send_email":[{"name":"EMAIL"}]`). Note: today
> `uq_clerk_users_account` (migration 0014) binds exactly ONE Clerk identity per account,
> so the per-recipient ledger fan-out resolves to a single recipient in practice — the
> account's one Clerk-mapped owner — even with several owner memberships.

> **Doc-number note (read first).** This workstream was scoped as "§22" before the
> infra docs `22-server-throughput.md` … `28-git-sync-e2ee.md` landed on `main`, so
> the `22` slot is *already taken* by an unrelated doc. This file keeps the requested
> `22-device-management.md` name to match the PR/branch, but that means two docs share
> the number `22`. **Open question §6-Q0:** renumber this to the next free index (`29`)
> before merge, or accept the duplicate? Recommendation: renumber to `29` at merge
> time; the content is independent of the number.

**Status:** DESIGN ONLY — no code changes in this PR. Synthesizes three
already-reviewed specs whose prerequisites have now SHIPPED into one coherent
device-management plan. It **references and reconciles** designs 16 (new-device
email) and 17 (devices/workspaces list), **supersedes** their now-stale
prerequisite language, and **coordinates with** 19 (revocation) and 21 (account
linking, shipped).

**Depends on / builds on (all verified in code, §1):** 11 (web auth / Clerk →
rbox token), 12 (full E2EE), 15 (SvelteKit dashboard), 18 (email routing —
inbound SHIPPED), 21 (account linking — SHIPPED, PR #2).

**Supersedes where appropriate:**
- design 16 §4.2 (Resend recommendation) → **Cloudflare Email Service — Email
  Sending** (first-party, public beta) on `mail.rbox.to` (the all-Cloudflare
  product decision, 16's own banner; supersedes the interim MailChannels call).
- design 16 §5.2 / §12.7 and design 17 §8.5 ("`device_id` is non-unique, the
  revoke target is ambiguous") → **stale**; migration `0013` made `device_id`
  globally unique (§1.1). The revoke deep-link and single-row revoke are sound today.
- design 16 §12.1 / design 17 §1.3a/§8.1 ("CLI-first accounts are permanently
  un-notifiable / the dashboard shows an empty shell") → **mitigated**; account
  linking (doc 21) supplies the `clerk_user_id → real account X` row those specs
  were missing (§1.2).

---

## 0. Goal & non-goals

**Goal.** Ship the founder-facing device-management surface now that its three
prerequisites are in `main`:

1. a **`/devices` dashboard route** — a read-only list of the account's devices and
   workspaces (design 17), promoted from "a section under `/dashboard`" to its own
   route, and the home for the revoke control;
2. a **new-device security email** ("a new device was added to your account",
   design 16) — a queue worker + transactional send on the all-Cloudflare stack;
3. **web unlink + token-level device revoke** (design 19 part (a) + design 21's
   unlink) — the buttons that live on that route / in settings.

**Non-goals (explicitly out, flagged not built):**
- **Cryptographic eviction / epoch rotation** (design 19 §6–§7, the P3 work). The
  epoch-rotation *operation* is **not built** (§1.3); a web revoke is **access-only**.
  This doc *flags* the caveat and surfaces it in the UI; it does **not** design
  rotation — that is design 19 + P3.
- Roster mutation, device rename, pairing/onboarding UX, team/seat management,
  per-web-session "new browser" emails, marketing/digest email.
- The `device_auth`-approver cascade and `rbox logout` server-revoke (design 19
  §5.2/§9) — separate revocation-hardening, not on this route's critical path.

---

## 1. Prerequisites — what SHIPPED (verified against live code, not assumed)

The three specs were blocked on cross-cutting prerequisites. All the ones this
workstream needs are now in `main`. Verified by reading the source, not the README:

### 1.1 P1 — `device_id` is globally UNIQUE ✅ (migration `0013_device_id_unique.sql`)
`devices.device_id` was a non-unique index (0004) with some 32–48-bit ids. `0013`
**dedups then `CREATE UNIQUE INDEX devices_device_id_unique`** (global, reconciling
with the E2EE `device_keys.device_id` global PK), and `mintDevice` now generates
128-bit ids (`DEVICE_ID_BYTES = 16`, `auth.ts:16`) and **retries on a uniqueness
violation** (`auth.ts:84-114`). Consequence for this doc:
- `revokeDevice`'s `UPDATE … WHERE device_id=? AND account_id=?` (`auth.ts:339-340`)
  targets **exactly one** row — the revoke button is safe.
- The new-device email's revoke deep-link `?highlight=<deviceId>` (design 16 §5.2)
  is unambiguous — ship it *with* the highlight, dropping 16's "link to the list
  without highlight until a unique id lands" fallback.

### 1.2 P2 — web↔CLI account linking ✅ (design 21, shipped PR #2)
`rbox account link` rebinds `clerk_users.account_id` from the empty web shell to the
real CLI-born account X (verified: `account-link.ts`, routes wired in `worker.ts`,
`/v1/account/unlink` + `accountStatus` live). Consequence:
- **Design 17's biggest caveat is mitigated.** After linking, `Principal.accountId
  = X`, so `GET /v1/account/devices|workspaces` shows the user's **real** machines
  and workspaces, not an empty shell.
- **Design 16's "permanently un-notifiable" gap is mitigated.** Linking creates the
  `clerk_users[C] → X` row that owner-email resolution (16 §3.1) walks. *Caveat,
  unchanged:* `clerk_users` today has **no email column** (verified: `webSession`
  inserts only `clerk_user_id, account_id, user_id, created_at`, `clerk.ts:131`), so
  the **email storage + refresh is design 16's own addition** (§3.2 here) — linking
  supplies the identity bridge, not a cached address. A still-unlinked CLI-first
  account remains un-notifiable until the user runs `rbox account link` once;
  that is now a one-command fix, not a structural dead end.

### 1.3 P3 — E2EE epoch rotation is NOT built ❌ (the load-bearing caveat)
Full E2EE is merged and epoch **enforcement** works (commits are rejected unless
`accountEpoch` == current, design 12 C4), but **no operation bumps the epoch +
re-wraps MK to survivors + signs a revoking roster** (`e2ee-remote.ts:146` "v1 has
no rotation"; design 19 §6–§7 designs it, unbuilt). **Therefore a device revoke from
this workstream is *access revocation only*** (§4.2): it stops the device's *future
API calls* but does **not** claw back the MK/KEKs it already holds, and cannot stop a
colluding server from feeding it future ciphertext. This doc **flags** that ceiling
in copy and in the email; it does not design rotation.

### 1.4 P4 — credential-kind route gate ✅ (shipped with doc 21)
`Principal.kind` is derived `expires_at === null ? "durable" : "web"`
(`auth.ts:66`, `authz.ts:15`), and `worker.ts:164` default-denies `kind=='web'`
tokens to an **exact-match allowlist** (`webTokenAllowed`, `worker.ts:332`).
Consequence for this doc: the new `/v1/account/devices|workspaces` GETs are **not**
in that allowlist yet, so a `web` token would currently get 403. **This workstream
must add the two new GET pairs to `webTokenAllowed`** (§2.4) — a deliberate,
audited widening, never a wildcard.

### 1.5 Inbound email SHIPPED; outbound = Cloudflare Email Service (design 18 + 16 banner)
- **Inbound** (`support@`/`postmaster@`/`security@` → Gmail via Cloudflare Email
  Routing) is **SHIPPED** (design 18, 2026-06-30). It is *receive-only*; it does
  **not** give us a transactional sender.
- **Outbound transactional** decision: **all-Cloudflare → Cloudflare Email Service
  (Email Sending), first-party, public beta (2026-04-16)** on a dedicated
  `mail.rbox.to` sending subdomain. The interim "MailChannels" call is
  **superseded**: the premise that Cloudflare has no first-party send to arbitrary
  recipients was true only of the *old* `send_email` binding (verified-destinations
  only); **Email Service sends to any recipient** after the sending domain is
  onboarded. The new-device email goes out via the Workers **`send_email` binding**
  from the queue consumer — **no MailChannels, no third-party API key** (§3.4).
  Requires **Workers Paid** for arbitrary recipients (3,000/mo free, then $0.35/1k).

### 1.6 No `ExecutionContext` in the Worker (the queue is mandatory, not a nicety)
Verified: the entrypoint is `async fetch(req: Request, env: Env)` (`worker.ts:25`) —
**no third `ctx` argument**, so `ctx.waitUntil` is unavailable without a signature
change, and even if added it is best-effort (no retry, dies with the isolate). A
security alert cannot ride that. The durable path is therefore **D1 outbox +
Cloudflare Queue + the existing `scheduled()` cron as backstop** (§3.4). The cron
already exists (`scheduled()`, `worker.ts:66`, currently retention-only) and is the
natural home for the backstop sweep + PII purge.

---

## 2. The `/devices` dashboard route (design 17, promoted to a route)

Read-only list of the account's **devices** (machines holding an rbox device token)
and **workspaces** (per-account sync roots), scoped to `Principal.accountId`. This is
also the home of the **Revoke** control (§4). Design 17 left "section vs route" as an
open question (17 §8.7); the founder wants a **route**, so v1 ships `/devices`.

### 2.1 Endpoints — NEW, web-facing, leave the CLI contract untouched
Add **new** endpoints rather than repurpose `GET /v1/auth/devices` — that route's
snake_case shape is a shipped CLI contract (`rbox device list` parses it,
`auth-cmd.ts`), and its query is uncapped/unpaginated and lists expired web sessions
(`listDevices`, `auth.ts:330-335`). The new endpoints get camelCase, filtering,
pagination, and E2EE-aware copy without a CLI regression. (This is design 17 §2,
carried verbatim — it is correct against the current code.)

**`GET /v1/account/devices`**
- Auth: existing authed path; account-scoped `account_id = p.accountId`.
- Query: `include` = `cli` (default, durable only) | `all` (adds *live* web
  sessions); `limit` (default 50, max 100); `cursor` (opaque, HMAC-integrity-tagged
  keyset over `(created_at, rowid)` — never encodes `token_hash`).
- WHERE — **parentheses are load-bearing** (without them `AND` binds tighter than
  `OR` and every account's live web sessions leak cross-tenant):
  ```sql
  -- include=cli (default):
  WHERE revoked = 0 AND account_id = ? AND expires_at IS NULL
  -- include=all:
  WHERE revoked = 0 AND account_id = ? AND (expires_at IS NULL OR expires_at > ?)
  ```
  Order `created_at ASC, rowid ASC`; fetch `limit+1` for `nextCursor`. `include=all`
  never returns **expired** rows.
- Response (camelCase; secrets excluded):
  ```jsonc
  {
    "devices": [{
      "deviceId": "dev_1a2b3c…",
      "label": "brian's macbook",   // capped to 256 chars in the projection
      "kind": "cli",                 // "cli" (expires_at NULL) | "web" (ephemeral)
      "createdAt": 1719600000000,
      "lastSeenAt": 1719700000000,   // may be null
      "isCurrent": false             // deviceId === caller's Principal.deviceId
    }],
    "nextCursor": null
  }
  ```
- **Explicitly NOT in the response:** `token_hash`, `account_id`, `user_id`, raw
  `expires_at`, `sig_pubkey`/`enc_pubkey`/`mk_wrap`/recovery material, and **no
  server-computed crypto/roster-status field** (design 17 §6: the server can't
  authoritatively compute roster-`active` from the opaque roster, and `putDeviceKeys`
  accepts any account `deviceId` so a `device_keys` row would lie). `kind` is the
  only projection of `expires_at`.

**`GET /v1/account/workspaces`**
- Same authed + account-scoped pattern; `limit`/`cursor`; `WHERE account_id = ?`.
- Response: `{ workspaces: [{ workspaceId, projectId, name, createdAt }], nextCursor }`.
  `projectId` is a **PK component → returned verbatim** (truncation would collapse
  two distinct workspaces); `workspaceId` is the server-assigned `ws_…`.
- **`name`** is the **opt-in, server-visible** dashboard label (design `workspace-names`,
  LOCKED): `null` by default, and non-null ONLY when the first host set it at create
  (`rbox init`, first-writer-wins — a single INSERT; no web edit / no PATCH). It's opaque
  user text, sanitized (control chars stripped) + length-bounded (≤128) on write. Under
  E2EE the server still holds **no folder name/path** for unnamed rows — copy keeps the
  strong claim there ("rbox can't see your folder names — names live only on your devices").
  For a **named** row the strong claim is FALSE, so the UI shows a softer, truthful line
  ("name is visible to rbox; contents stay end-to-end encrypted"). The zero-knowledge
  guarantee narrows to "we can't see names/paths *unless you opt in to a name*."
- `lastActivityAt`/`commitCount` are **deferred** (17 §2.2): the `commits` mirror
  has no maintained per-workspace summary, so a page of busy workspaces would scan
  large ranges. v1 shows creation time only.

### 2.2 Marking the current device + distinguishing ephemeral `web_*` sessions
- **`isCurrent`** = `deviceId === p.deviceId`. With the default `include=cli` filter
  the caller's own `web_*` row is filtered out, so the list is "your machines," not
  "your tabs." The dashboard renders a **synthetic "This browser session" chip** from
  client state (it knows its own session), separate from the device list — never
  offer Revoke on it (it self-heals via Clerk re-mint, §4.4).
- **`kind` badge** distinguishes `cli` (durable) from `web` (ephemeral, ~1h). Web
  sessions only appear under `include=all`; default view hides them to avoid the
  "every login looks like a new device" accumulation (design 17 §3.1 — `web_*` rows
  are never GC'd; see open question §6-Q6).

### 2.3 Supporting indexes, pagination, empty states
- **Indexes** (new migration): `CREATE INDEX idx_devices_account_exp_created ON
  devices (account_id, expires_at, created_at)` — `expires_at` 2nd so `IS NULL` is a
  seek not a residual; **never** name `rowid` as an index column (it errors `no such
  column: rowid`). `CREATE INDEX idx_workspaces_account_created ON workspaces
  (account_id, created_at)`.
- **Pagination v1:** render the first page; a "Show more" button if `nextCursor`. No
  infinite scroll.
- **Empty states (honest, post-linking):**
  - *Zero durable devices:* if the account is **unlinked** (`GET /v1/account/status`
    → `linked:false`), show the **"Link your CLI account"** affordance (design 21's
    start flow) — this is the now-shipped fix for 17's dead-end empty state. If
    linked but genuinely empty, point at onboarding ("set up rbox on a machine with
    the CLI"), **not** a dashboard-minted pairing token (the browser can't carry E2EE
    admission, 17 §1.3a).
  - *Zero workspaces:* "No workspaces yet — your first `rbox` sync creates one."

### 2.4 SvelteKit route + web-token allowlist
- **`apps/web/src/routes/devices/+page.svelte`** — new route (mirrors the existing
  `dashboard/+page.svelte` pattern: `requireAuth()`, `onMount(load)`, `$state` per
  list with independent error capture so one failing list doesn't blank the other).
  Add a nav link from `/dashboard`. Each row: label (or `deviceId`, auto-escaped),
  `kind` badge, relative `lastSeenAt`, and the Revoke control (§4). Loading
  skeletons; per-section error line (reuse `errMsg`); `WEB_AUTH_NOT_ENABLED` handled
  like the usage section.
- **`apps/web/src/lib/api.ts`** — add `fetchDevices(clerk, opts)` and
  `fetchWorkspaces(clerk, opts)` beside `fetchUsage`, each via `authed()`
  (exchange + single 401-retry, already implemented).
- **`apps/api/src/worker.ts`** — route the two GETs (authed, account-scoped) **and
  add them to `webTokenAllowed`** (P4 gate, §1.4):
  ```
  GET /v1/account/devices
  GET /v1/account/workspaces
  ```
  Exact pairs, not a `GET /v1/account/*` wildcard (the gate's existing comment
  warns against exactly that). CORS needs no change (GET already allowlisted).

---

## 3. New-device security email (design 16, on the all-Cloudflare stack)

When a new **durable bearer credential** is minted via a device-join path, email the
account's owner(s) "a new device was added." This is design 16 in full; the changes
here are (a) **Cloudflare Email Service (Email Sending)** instead of Resend/MailChannels
— first-party, via the Workers `send_email` binding, (b) the now-satisfied identity
bridge and unique-id prerequisites, (c) re-grounding the hooks against the current
`auth.ts`.

### 3.1 The hook = durable-credential mint, NOT E2EE roster admission
`mintDevice` (`auth.ts:84`) is where a `devices` row (a usable bearer token) is born.
Its callers, re-verified:

| Caller | Path | Durable? | Notify? |
|---|---|---|---|
| `bootstrap` | `POST /v1/auth/device/bootstrap` | yes (first device) | **No** — no recipient exists yet (§3.3) |
| `redeemPairToken` | `POST /v1/auth/pair/redeem` | yes | **Yes** (if a recipient resolves) |
| `pollDeviceAuth` (approved→claimed) | device-code claim | yes | **Yes** (if a recipient resolves) |
| `createWebSession` | `POST /v1/web/session` | **no** — `web_*`, re-minted hourly | **No** (§3.5) |

Enqueue from the **two redeem/claim sites only**. Do **not** hook `mintDevice`
directly (it is also the hourly web-session mint → an hourly email per active
dashboard user + an IP-egress footgun). Do **not** wait for E2EE roster admission:
admission is client-driven and client-verified, the server must not parse the opaque
roster (design 12), and a minted token can act on the account *before/without*
admission (the device-code path mints a token carrying no `mkWrap`/`admissionGrant`
at all). The security event is "a token that can act as my account now exists" —
that is the mint.

### 3.2 Recipients = the account's OWNERS, via memberships → clerk_users → email
The recipient is the account's **owner(s)**, not the user whose device minted the
join (who may be a non-owner, or the same person on a new laptop):
1. `SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner'`.
2. Reverse-map each to a Clerk identity:
   `SELECT clerk_user_id, email FROM clerk_users WHERE account_id = ? AND user_id = ?`.
3. One email per distinct resolved address (dedup).

**Email storage is this design's own addition** (clerk_users has no email column
today, §1.2):
```sql
ALTER TABLE clerk_users ADD COLUMN email TEXT;            -- cached primary VERIFIED email
ALTER TABLE clerk_users ADD COLUMN email_updated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_clerk_users_acct ON clerk_users (account_id, user_id);
```
- **Refresh path (required, not piggybackable):** `webSession` calls Clerk's Backend
  API **only on first provisioning** (`clerk.ts` — the `if (!map)` branch runs
  `clerkEmailVerified`; returning logins skip Clerk entirely). So the build must
  **add a returning-login refresh**: on each `/v1/web/session`, throttled by
  `email_updated_at` (≤ once/24h), refetch `GET /v1/users/{sub}` and `UPDATE
  clerk_users SET email=?, email_updated_at=?` with the primary *verified* address.
  Refresh failure is **non-fatal to login** (it's a cache refresh, not the auth path).
- The consumer reads `email`; if NULL it does one live Clerk fetch; transient failure
  → `failed`/retry (§3.6), never `skipped`.

### 3.3 The CLI-only-account gap (now mitigated, not closed)
`bootstrap` creates account+user+owner with **no `clerk_users` row** → no email.
Device-code joins into such an account inherit the gap. **Account linking (P2)
mitigates it:** once the user runs `rbox account link`, X gets a `clerk_users` row
and owner-email resolves. Until then the row terminally `skipped`s (distinct from a
transient *failure*, which retries). Bootstrap's *own* first device never emails (no
recipient + it is the genesis device).

### 3.4 Mechanics — D1 outbox + Cloudflare Queue + cron backstop
Because there is no `ctx.waitUntil` (§1.6), delivery rides a durable, idempotent,
at-least-once path:

**Migration (new) — outbox + per-recipient ledger + coalesce + prefs:**
```sql
CREATE TABLE device_notifications (        -- one row per minted credential (dedupe + PII snapshot)
  token_hash TEXT PRIMARY KEY,             -- = devices.token_hash: the unique credential identity
  device_id TEXT NOT NULL, account_id TEXT NOT NULL, minted_user_id TEXT,
  label TEXT, ip TEXT, geo TEXT,           -- PII snapshot; PURGED after delivery (§3.7)
  event TEXT NOT NULL,                      -- 'pair' | 'device_code'
  created_at INTEGER NOT NULL, coalesced_into INTEGER, resolved_at INTEGER
);
CREATE TABLE notification_deliveries (     -- one row per (event, recipient): independent status
  token_hash      TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,         -- the OWNER user_id, captured at resolution (§3.4)
  recipient_clerk_id TEXT NOT NULL,        -- the Clerk identity resolved at resolution — the STABLE
                                           -- send target (survives a later link/unlink that moves
                                           -- the clerk_users row); email is fetched for THIS id
  idempotency_key TEXT NOT NULL,           -- HMAC(pepper, token_hash ‖ recipient_clerk_id) — the ESP key
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|sending|sent|skipped|failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_at      INTEGER,                  -- lease: when a consumer claimed this row (status→'sending')
  last_attempt_at INTEGER, sent_at INTEGER,
  PRIMARY KEY (token_hash, recipient_clerk_id)
);
-- NOTE: we store NO email and NO hash of the email. A sha256(email) would be
-- trivially reversible for common addresses (dictionary/rainbow), so the row holds
-- only the Clerk identity; the address is fetched (cache or live) at send time and
-- never persisted in the ledger (§3.7).
CREATE TABLE notify_coalesce (account_id TEXT, window_start INTEGER, count INTEGER DEFAULT 0,
  summary_sent INTEGER DEFAULT 0, PRIMARY KEY (account_id, window_start));
CREATE TABLE account_notify_prefs (account_id TEXT PRIMARY KEY, notify_new_device INTEGER NOT NULL DEFAULT 1);
```

- **Idempotency anchor = `token_hash`** (the unique credential identity), *not*
  `device_id`. Even post-0013 (`device_id` now unique), `token_hash` is the natural
  PK of `devices` and the value the consumer re-reads — keying on it makes the outbox
  insert genuinely idempotent (`INSERT OR IGNORE` → at most one row → at most one
  event).
- **Atomic row creation — and the `mintDevice` retry-loop reconciliation (codex-1
  #4).** The outbox INSERT must commit in the **same D1 `batch()`** as the device
  INSERT (the atomic primitive `admitDevice` already uses), so *if the device exists,
  its outbox row exists*. But `mintDevice` today (`auth.ts:84-114`) owns its INSERT
  *and* a uniqueness-retry loop (regenerate token+`device_id` on a UNIQUE violation),
  so a caller can't simply append a second statement to that hidden INSERT. The build
  therefore **refactors `mintDevice` into `prepareMintDevice(...) → { tokenHash,
  deviceId, insertStmt }`** (pure: generates token + 128-bit id, returns the prepared
  device-INSERT, no `.run()`). The call site builds `batch([insertStmt,
  outboxInsertStmt])`; **the uniqueness-retry now wraps the whole batch** — on
  `isUniqueViolation` it re-runs `prepareMintDevice` (fresh token+id) and rebuilds the
  batch (bounded retries, exactly the existing pattern, just lifted up a level). This
  keeps the device+outbox atomic without losing collision-retry. `pollDeviceAuth`
  batches **claim+device+outbox**, `redeemPairToken` batches **device+outbox** (the
  `UPDATE…RETURNING` consume stays ahead of the batch as today). No new token-burn
  surface beyond design 10's existing consume→mint shape; delivery is strictly
  downstream.
- **Delivery — Cloudflare Queue (primary).** Add producer binding `DEVICE_NOTIFY_Q`
  to `Env` + `wrangler.jsonc`; after the batch commits, `env.DEVICE_NOTIFY_Q.send({
  tokenHash })` (id only — no PII on the wire). A new `queue(batch, env)` handler in
  `worker.ts` does two phases per message: **(1) resolve-once** — if
  `device_notifications.resolved_at IS NULL`, resolve the account's current owners
  (§3.2: `memberships role='owner'` → each owner's `clerk_users` identity), `INSERT OR
  IGNORE` one `notification_deliveries` row per resolved `(user_id, clerk_user_id)`,
  then stamp `resolved_at` — **after which the fan-out is frozen** and every later
  retry reuses the persisted rows (codex-1 #3); **(2) deliver** — for each
  `pending`/`failed` delivery, claim it and send (below). **The D1 row, not the queue
  message, is the source of truth.**
  - **Honest scope of "frozen" (codex-2 #1).** Resolution runs at **first
    processing** (the queue consumer in the normal path; the cron only if the enqueue
    was lost), **not** inside the mint batch. So a membership/owner change in the
    short window *between mint and first resolution* (sub-second in the queue path;
    up to one cron interval in the rare lost-enqueue path) **is** reflected. After
    resolution it cannot change the fan-out. This residual is **accepted** for v1
    (the alert reaches whoever owns the account at first processing — a reasonable
    target). The **stronger guarantee** — snapshot the owner set into the *same atomic
    mint batch* — is offered as a follow-up (§6-Q8); it costs a `memberships` read
    folded into the mint batch and is not required for v1.
- **Backstop — the existing cron, sweeping the OUTBOX not just deliveries (codex-1
  #1).** Extend `scheduled()` (`worker.ts:66`) to re-drive **both** layers, because
  the failure windows differ: (a) `device_notifications WHERE resolved_at IS NULL` —
  rows whose `send()` never reached the queue (isolate evicted between the D1 commit
  and `DEVICE_NOTIFY_Q.send`), which have **no delivery rows yet**, so a
  delivery-only sweep would lose the alert entirely; and (b) `notification_deliveries
  WHERE status IN ('pending','failed') AND attempts < N` (incl. stale `'sending'`
  leases past a timeout → back to `failed`). Both re-enqueue onto the same queue. Plus
  the PII purge (§3.7).
- **Per-recipient send is an atomic claim → send → settle (codex-1 #2).** At-least-
  once queue + cron means a delivery can be picked up twice concurrently, so the send
  itself is leased:
  1. **Claim:** `UPDATE notification_deliveries SET status='sending', claimed_at=?,
     attempts=attempts+1 WHERE token_hash=? AND recipient_clerk_id=? AND status IN
     ('pending','failed') AND (claimed_at IS NULL OR claimed_at < ?leaseFloor)` — the
     conditional UPDATE is the mutex (D1 serializes writes); `changes==0` ⇒ another
     consumer owns it ⇒ skip.
  2. **Send** via the Cloudflare Email Service `send_email` binding (`env.EMAIL.send`).
  3. **Settle:** success → `status='sent', sent_at=?` (the binding returns a
     `messageId`); transient → `status='failed'` (cron/queue retries); terminal →
     `skipped`.
  The **"send succeeded, status write crashed" window**: **Cloudflare Email Service
  exposes no client idempotency key** (the REST send returns per-recipient status; the
  binding returns a `messageId`), so — unlike the MailChannels assumption — there is
  **no provider-side dedupe** to lean on. The window is therefore closed by the
  **server-side** guard alone: the claim already incremented `attempts` (so it isn't
  retried forever) and the **pre-send `status='sent'` check** suppresses re-sends after
  a successful settle. The only residual is a crash *between* a successful send and the
  status write, which yields **at most one rare duplicate** — and a security alert is
  safe to send twice, never to drop. (This settles design 30's former §6-Q2 "must-
  verify provider idempotency": the answer is *no client idempotency key*, so the
  pre-send-check-plus-accept-rare-duplicate path is the design, not a fallback.)
- **Cloudflare Email Service send config.** The consumer calls the Workers
  **`send_email` binding** — `wrangler.jsonc`: `"send_email": [{ "name": "EMAIL" }]`,
  then `const { messageId } = await env.EMAIL.send({ to, from, subject, html, text })`.
  This is an in-platform binding: **no outbound `fetch`, no provider API key, no
  per-message DKIM key to pass** — Cloudflare signs DKIM with its CF-managed
  `cf-bounce._domainkey.mail.rbox.to` key and ensures DMARC alignment
  automatically (§3.10). So the MailChannels-era secrets are **deleted**:
  ~~`MAILCHANNELS_API_KEY`~~, ~~`MAILCHANNELS_DKIM_PRIVATE_KEY`~~, ~~`_DKIM_DOMAIN`~~,
  ~~`_DKIM_SELECTOR`~~. Remaining config: `RBOX_NOTIFY_FROM`
  (`security@mail.rbox.to`); `NOTIFY_IDEMPOTENCY_PEPPER` (secret, retained as an
  internal dedupe tag — see §3.4's no-provider-idempotency note); reuse `RBOX_APP_URL`
  for the revoke-link base. (REST alternative if the binding is unavailable: `POST
  …/accounts/{account_id}/email/sending/send` with a CF API token — but the binding is
  preferred precisely because it needs no secret.) **DKIM rotation is Cloudflare's
  responsibility**, not ours — keys are CF-generated/managed (rotation via CF support).

### 3.5 Web sessions excluded
`createWebSession` mints a `web_*` token on every dashboard login — fresh id hourly,
no stable browser identity to dedupe, and Clerk already owns new-browser sign-in
security. Not notified (§3.1 table).

### 3.6 Failure handling — fail loud, never silently drop a security alert
Per-`notification_deliveries` row (so a 2-owner fan-out tracks each send
independently). The fan-out set is **fixed at first resolution** (§3.4 phase 1, with
the honest-scope caveat there: resolution is at first processing, not at mint) —
owners are resolved once into persisted delivery rows keyed by the stable
`clerk_user_id`, so once resolved a later link/unlink/membership change can't
retro-suppress or redirect the alert; only the *address* read at send time floats
(bounded by the §3.7 purge, and "the address you most recently authenticated with" is
the right target for a security alert).
- `pending/failed → sending` via the atomic claim (§3.4), then:
- `sending → sent` on a successful `env.EMAIL.send(...)` (binding returns `messageId`).
- `pending/failed → failed (retry)` on **transient** errors: CF Email Service send
  rejection / 5xx / 429, Clerk down/timeout, network, **or the `mail.rbox.to`
  sending domain not yet onboarded/entitled in prod** — bounded `attempts`, queue
  backoff + cron re-drive. An un-onboarded sending domain is **failed+alarm**, never
  terminal `skipped` (that would permanently discard alerts until someone noticed).
- `pending → skipped (terminal)` only when the answer is *known*: account resolves
  to **no** owner email (unlinked CLI-only, §3.3), the pref is off (§3.8), or an
  explicit `DEVICE_NOTIFICATIONS_DISABLED=1` flag is set (local/dev only).

### 3.7 Privacy & data minimization
- Coarse `request.cf` city/region/country + raw IP (the signal users recognize),
  mirroring GitHub/Google. **`request.cf` is fetch-only** → snapshotted into the
  outbox row at creation; the consumer/cron never recompute it.
- **The email IS a new egress** (address + label + IP/geo to Cloudflare Email Service
  + the destination mailbox) — acknowledged, not "no new disclosure." We minimize the standing copy:
  the cron **nulls `label`, `ip`, `geo`** once a row is `sent`/`skipped` (or a 7-day
  TTL). We keep only non-PII audit fields. No permanent per-device IP/label history.
- `token_hash` never leaves rbox; the delivery ledger stores **no email and no email
  hash** — only the resolved `recipient_clerk_id` (§3.4). The address is fetched (cache
  or live Clerk) at send time and never persisted in the ledger.

### 3.8 Opt-out, abuse, rate-limit
- **Opt-out** is account-scoped (`account_notify_prefs`), default on (security
  signal). Changing it requires an **owner** session; disabling **audits + cross-
  notifies the other owners** (a rogue owner can't silently blind the account).
  `List-Unsubscribe` points at the **authenticated** settings page — no
  unauthenticated one-click that silences a security alert from a forwarded email.
- **Abuse.** New-device *creation* is gated upstream (pairing needs an authed-device
  token capped at 5 active/account; device-code needs an authed device's approval),
  so an outsider can't freely add devices. A *compromised authorized device* mass-
  creating devices is exactly when alerting matters — so the cap **coalesces** rather
  than drops: over-cap events fold into one **summary** email per account-window
  (atomic `summary_sent` 0→1 guard), every device represented, only the email *rate*
  bounded.

### 3.9 Label sanitization (render-time, authoritative)
Labels are inconsistently bounded at ingest (bootstrap stores `body.label`
unsliced). The renderer sanitizes **regardless of stored value**: strip CR/LF + all
C0/C1 control chars (header-injection guard), clamp ~80 chars, HTML/text-escape per
part. The label is **never** interpolated into the Subject (only the sanitized body).

### 3.10 Provider DNS for `mail.rbox.to` (Cloudflare-managed)
Supersedes design 16 §4.3's Resend records and the interim MailChannels records with
**Cloudflare Email Service's**. The records are **not hand-authored**: onboarding the
`mail.rbox.to` sending subdomain (dashboard *Compute → Email Service → Email
Sending → Onboard Domain*, or `POST /zones/{zone}/email/sending/subdomains`) makes
Cloudflare **write and lock** them, since rbox.to is on CF DNS. CF provisions:
- **MX** on `cf-bounce.mail.rbox.to` → Cloudflare bounce servers (return-path).
- **SPF** TXT on `cf-bounce.mail.rbox.to`: `v=spf1 include:_spf.mx.cloudflare.net ~all`
  — **not** `include:relay.mailchannels.net`.
- **DKIM** TXT on `cf-bounce._domainkey.mail.rbox.to` (selector `cf-bounce`),
  **CF-generated** (the `p=…` value is known only after onboarding; fetch via `GET
  /zones/{zone}/email/sending/subdomains/{id}/dns`). Cloudflare signs every message
  with this key — there is **no** `_mailchannels` Domain-Lockdown TXT and **no**
  self-managed keypair; CF's locked, managed DKIM is the anti-spoof + auth mechanism.
- **DMARC** TXT on `_dmarc.mail.rbox.to`: `v=DMARC1; p=quarantine;
  rua=mailto:dmarc@rbox.to; adkim=s; aspf=s`, graduating to `p=reject` once aligned.

These records are **separate from the apex/inbound records** (design 18 — Email
Routing uses the apex MX/SPF + the `cf2024-1._domainkey` selector), so onboarding
sending **does not touch** the shipped inbound routing; the subdomain split keeps
transactional reputation isolated. CF "ensures proper [DMARC] alignment
automatically," so the sending-subdomain DKIM (`d=mail.rbox.to`) aligns under the
subdomain's own DMARC without interacting with the apex `p=reject`.

---

## 4. Web unlink + device revoke — two DISTINCT operations, named once

The single most important clarity requirement: **"unlink" and "revoke" are different
operations on different objects.** The UI and the code must never conflate them.

| | **Device revoke** | **Account unlink** |
|---|---|---|
| Object | one `devices` row (a machine's token) | the `clerk_users[C] → X` identity mapping |
| Endpoint | `POST /v1/auth/devices/:deviceId/revoke` (design 19a) | `POST /v1/account/unlink` (design 21 §5.4, **SHIPPED**) |
| Effect | `devices.revoked = 1` → that token 401s | rebinds C off X back to a fresh web shell |
| Who | owner/admin (or self) on the account | owner on the currently-linked account |
| Lives on | a **device row** on `/devices` | account **Settings** (not a device row) |
| E2EE | access-only; crypto eviction unbuilt (§4.2) | **never** touches devices/roster/keys |
| Built? | endpoint exists, **needs hardening** (§4.1) | endpoint shipped (PR #2), but **must also revoke live web sessions** (§4.3) |

Putting them on the same screen invites "I unlinked my laptop" confusion. **Unlink
belongs in Settings** ("Disconnect this dashboard from your rbox account"), **revoke
belongs on the device row** ("Sign this machine out"). The copy must say which object
each acts on.

### 4.1 Device revoke — the button on `/devices` (design 19 part (a))
The token-level primitive exists (`revokeDevice`, `auth.ts:339`) and access
revocation already works (`authenticate()` enforces `revoked=0`, `auth.ts:55-57`).
But `revokeDevice` today is **unhardened** — verified: `UPDATE devices SET revoked=1
WHERE device_id=? AND account_id=?` with **no role check and no audit**. This
workstream ships the *minimum* hardening design 19 §3.1/§8 specifies, scoped to what
the button needs (not the full crypto path):
- **Authorization matrix** (using `Principal.role`): any role may revoke **their own**
  device; `owner`/`admin` may revoke **any** device in the account; `editor`/`viewer`
  revoking **another** device → `403`; a device in **another** account → `404`
  (uniform, no enumeration leak). Realize as an atomic single-statement guarded
  UPDATE (`… AND revoked=0 AND (device_id = self.deviceId OR self.role IN
  ('owner','admin'))`) so there is no SELECT-count race; `device_id` uniqueness (P1)
  makes it exactly one row.
- **Audit** (`audit()` exists, `authz.ts`, currently uncalled by revoke): on
  `changes==1`, `audit(env, self, isSelf ? "device.revoke.self" : "device.revoke",
  targetDeviceId)`. No double-revoke spam.
- The UI hides Revoke for `editor`/`viewer` and never offers it on `isCurrent` / the
  "This browser session" chip (§4.4).
- **Out of scope here** (design 19, P3): the `account_keys` write-freeze, the
  `device_auth` approver cascade, and `rotationRequired`. The button does
  access-revocation; §4.2 explains the ceiling and the UI nudge.

### 4.2 The epoch-rotation caveat (flag, do NOT design)
Because the epoch-rotation operation is **not built** (§1.3, P3), a web-initiated (or
any) revoke from this workstream is **access-revocation only**: it stops the device's
*future API calls*, but the revoked device **still holds MK + cached workspace KEKs**
and can decrypt data it already synced — and, against a *colluding* server, could
decrypt *future* ciphertext until a survivor CLI device rotates the epoch (re-wraps
MK to survivors, signs a revoking roster vN+1). **The browser can never author that
rotation** — it holds no MK and no device signing key (design 21 §1). So the UI must
say so, plainly:
> "Access revoked — this device can no longer reach rbox. To fully evict its
> encryption keys, run a key rotation from a signed-in CLI device. (Key rotation is
> not yet available — tracked in design 19 / P3.)"

We **flag** this; we do **not** design rotation (that is design 19 §6–§7 + P3). The
honest v1 promise is "cuts off the server," not "cryptographically evicted."

### 4.3 Account unlink — shipped, but it does NOT cut live web sessions (codex-2 #2)
`POST /v1/account/unlink` (design 21 §5.4) is live: owner-gated, rebinds C → a fresh
`'web'` shell, audited (`method='unlink'`), **blocks** `409
linked_account_has_billing` if X carries Stripe state, and **never** revokes CLI
devices or touches the roster.

**Sharp gap (verified):** unlink rebinds `clerk_users` but does **not** revoke the
existing `web_*` `devices` rows on X, and `authenticate()` resolves a bearer token via
`devices` + `memberships` **independent of `clerk_users`** (`auth.ts:53`), while the
SPA only re-exchanges on a 401 (`api.ts` `authed()`). So after unlink the **already-
minted web token keeps working on X for up to its ~1h TTL** — the browser can still
hit the allowlisted web routes (usage, device list, *device revoke*, billing) against
the account it just "disconnected." That is the original linking bug in miniature.

**Therefore this workstream's unlink scope is not UI-only.** It must:
1. Add a UI Settings affordance with identity-action copy ("Disconnect this dashboard
   from your rbox account — your devices and files are untouched"), via a new
   `unlinkAccount(clerk)` helper in `apps/web/src/lib/api.ts`; **and**
2. **Make unlink revoke the caller's live `web_*` sessions on X — in the SAME D1
   batch as the rebind** (so there is no partial unlink-without-revoke window):
   `UPDATE devices SET revoked=1 WHERE account_id=X AND user_id=<unlinked user> AND
   expires_at IS NOT NULL` (ephemeral web rows only — never the durable CLI devices)
   rides the existing `unlinkAccount` rebind batch (`account-link.ts`), so the
   disconnected browser 401s on its next call instead of acting on X for an hour;
   **and**
3. Clear the client token cache (`clearStaleTokens` / drop the cached rbox token) so
   the SPA re-exchanges against the *new* shell, not X.

This is a real (small) API change, not just UI — folded into Slice 3. It is the unlink
analogue of the §4.4 web-self-revoke problem: rebinding identity without cutting the
live bearer leaves a residual-access window.

### 4.4 The web self-revoke / Clerk-session caveat (don't ship it as theater)
Revoking your **own** `web_*` token is currently undone immediately: the SPA re-mints
a fresh rbox token from the still-valid Clerk session on 401 (`api.ts` `authed()`
re-exchange, verified). So a "sign this browser out" control on the current session
would be **theater** unless it also ends the Clerk session. Design 19 §10 owns the
real fix (Clerk backend session-revoke, needs persisting the Clerk `sid` on the web
device row — note `sessionId(clerk)` already exists web-side). **v1 scope:** do
**not** offer Revoke on the current browser session; the chip says "This browser —
sign out via the menu" (which calls `clerk.signOut()`, the thing that actually
works). Revoking *other* devices (CLI machines, other browsers) is real and is the
button's real job.

---

## 5. Staged build plan

All four prerequisites this workstream needs (P1 unique id, P2 linking, P4 kind-gate,
design 18 inbound + the outbound-provider decision = Cloudflare Email Service) are
**satisfied** as *design* decisions. The one **outstanding external step** (Slice 5
only) is enabling CF Email Service — Workers Paid + onboarding `mail.rbox.to`
(§6-Q2); Slices 1–4 ship without it. P3 (epoch rotation) is **not** required for any
slice here — every slice is access-plane/metadata-plane.

**Recommended slice ordering** (each independently shippable, smallest blast radius
first):

- **Slice 1 — `/devices` read-only route (design 17).** Migration (two indexes);
  `GET /v1/account/devices|workspaces` + add both to `webTokenAllowed`; `fetchDevices`
  /`fetchWorkspaces` in `api.ts`; the `/devices` SvelteKit route + nav link + empty
  states (incl. the "link your CLI account" affordance via `accountStatus`). *Lowest
  risk, immediately useful, no new infra.* Ship first.
- **Slice 2 — device-revoke hardening + button (design 19a, access-only).** Harden
  `revokeDevice` (role/self authz + audit); wire the Revoke button on `/devices`
  rows; the §4.2 rotation-caveat copy; self-revoke guard (§4.4). *No new infra; closes
  the most-requested action.*
- **Slice 3 — unlink in Settings + live-web-session revoke (design 21 + §4.3).**
  Surface `/v1/account/unlink` with identity-action copy + billing-block handling,
  **and** extend `unlinkAccount` to revoke the unlinked user's ephemeral `web_*`
  sessions on X + clear the client token cache (§4.3) — otherwise the disconnected
  browser keeps acting on X for ~1h. *Small web + a 1-statement API addition.*
- **Slice 4 — new-device email infra (design 16, no send yet).** Migration (outbox +
  ledger + coalesce + prefs + `clerk_users.email`); `DEVICE_NOTIFY_Q` binding;
  outbox-on-mint batching in `pollDeviceAuth`/`redeemPairToken`; the returning-login
  email-refresh path; `queue()` consumer **stubbed** (writes status, no real send);
  cron backstop + PII purge. *Infra lands and is exercised without external email.*
- **Slice 5 — Cloudflare Email Service send + onboarding (design 16 + §3.10).**
  Onboard the `mail.rbox.to` sending subdomain (CF auto-writes + locks the
  `cf-bounce` MX/SPF/DKIM + `_dmarc`); add the `send_email` binding (`name = "EMAIL"`);
  the consumer's real `env.EMAIL.send(...)` + label sanitization; feature-gate
  (`DEVICE_NOTIFICATIONS_DISABLED`; un-onboarded/un-entitled → failed+alarm).
  **External prereq:** account on Workers Paid + Email Sending enabled. *Turns the
  stubbed pipe on; the externally visible step, gated last.*
- **Slice 6 — opt-out + coalescing polish (design 16 §3.8).** `account_notify_prefs`
  UI (owner-gated, cross-notify on disable), the coalesce summary email path.
  *Hardening, not blocking.*

Slices 1–3 are the founder's "devices route + revoke/unlink" ask and have **zero new
infra**; 4–6 are the email. Ship 1→2→3, then 4→5→6.

### 5.1 Tests to write (business logic, not type-checks)
- **Devices endpoint:** the `include=all` parenthesization does **not** leak another
  account's live web sessions (cross-tenant); `token_hash`/`user_id`/raw `expires_at`
  never appear in the response; `isCurrent` true only for the caller's own row;
  `expired` web sessions excluded even under `include=all`; cursor is opaque + rejects
  tampering.
- **Revoke authz:** `viewer`/`editor` revoking another device → 403; owner/admin →
  ok; self-revoke any role → ok; cross-account → 404; double-revoke idempotent
  (`changes==0`, no audit spam); audit row written on success; exactly one row flips
  (P1 uniqueness).
- **Email idempotency/atomicity:** duplicate/concurrent queue delivery for one
  `token_hash` → exactly one *claim* wins (the conditional `status→'sending'` UPDATE,
  `changes==1` once) → at most one send per recipient; a crashed settle re-runs but
  the provider idempotency key (or pre-send `sent`-check) prevents a second email;
  device-code claim+device+outbox commit together (one fails ⇒ all roll back, token
  not burned); the `prepareMintDevice` uniqueness-retry rebuilds the *whole* batch on
  a collision (device+outbox stay atomic); web-session mint creates **no** outbox row;
  bootstrap creates none.
- **Backstop sweeps both layers:** an outbox row stuck `resolved_at IS NULL` (queue
  send never happened, no delivery rows exist) is re-driven by cron — *not* lost; a
  stale `'sending'` lease past timeout reverts to `failed` and retries.
- **Resolution stability:** owners resolved once at **first processing** into delivery
  rows keyed by the stable `recipient_clerk_id`; a membership change *after* resolution
  does not retro-suppress or duplicate the alert (the small pre-resolution window is
  the accepted residual, §3.4 / §6-Q8).
- **Recipients:** resolve to account **owners** even when a non-owner's device joins;
  multi-owner fan-out with independent per-delivery status; unlinked CLI-only account
  → `skipped`; `clerk_users.email` refresh is throttled + non-fatal on Clerk failure.
- **skipped vs failed:** Clerk-down / sending domain not yet onboarded → `failed`+retry;
  no-owner-email / pref-off / `DEVICE_NOTIFICATIONS_DISABLED` → `skipped`.
- **Label sanitization:** CRLF/control chars stripped, clamped, escaped; hostile
  label can't inject a header or break the body; label never in the Subject.
- **Coalescing:** N rapid devices → exactly one summary per window (atomic
  `summary_sent` 0→1), every device represented, no silent drop.
- **Web-token gate:** a `web` token reaches the new `GET /v1/account/devices|
  workspaces` (post-allowlist) but is still 403 on mint/crypto/sync routes.

---

## 6. Open questions for the human

- **Q0 — doc number.** This file is named `22-device-management.md` to match the
  PR/branch, but `22-server-throughput.md` already owns `22`. Renumber to `29` before
  merge (recommended), or accept the duplicate? *(Filed first because it's a
  merge-time mechanical decision, not a design question.)*
- **Q1 — new-device email coverage for unlinked CLI accounts.** Linking (P2) makes a
  CLI-first account notifiable *after the user runs `rbox account link` once*. Accept
  "notifiable once linked" for v1 (recommended — the alternative, collecting a contact
  email at bootstrap, dents the zero-PII CLI property), or fund a CLI-onboarding
  contact-email path?
- **Q2 — Cloudflare Email Service enablement (the only external dependency).** Two
  things the founder must do for Slice 5: (a) put the account on **Workers Paid**
  (required for arbitrary recipients) with **Email Sending (public beta)** enabled, and
  (b) **onboard `mail.rbox.to`** (dashboard or `POST
  /zones/{zone}/email/sending/subdomains`) so CF provisions + locks the `cf-bounce`
  records. *Resolved sub-question:* whether the provider honours a client idempotency
  key — **it does not** (CF Email Service exposes none; §3.4), so the design uses the
  server-side pre-send `sent`-check + accept-rare-duplicate path (safe for a security
  alert). Everything before Slice 5 ships without any of this. *(Note: as of research
  on 2026-06-30 the `$CLOUDFLARE_API_TOKEN` available to automation is Zone-Read only —
  it cannot add DNS or reach the `email/sending` API; a DNS-Edit + Email-scoped token,
  or a one-click dashboard onboard, is required to execute (a)/(b).)*
- **Q3 — DMARC graduation.** Start `mail.rbox.to` at `p=quarantine` and graduate
  to `p=reject` after monitoring `rua` reports, or go straight to `reject`?
- **Q4 — `/devices` vs `/dashboard` sections.** Confirmed: dedicated `/devices`
  route (this doc). Should `/dashboard` keep a condensed device count that links
  through, or move all device UI to `/devices`?
- **Q5 — Recipients = owners only, or owners + admins** once an admin role exists?
- **Q6 — Ephemeral `web_*` GC.** Expired web sessions accumulate forever (never
  GC'd). The list hides them; should this workstream add a cron sweep to delete
  `revoked=0 AND expires_at < now - grace` (design 17 §8.3), or defer?
- **Q7 — Web self-revoke / Clerk session (§4.4).** v1 omits a "sign out this browser"
  revoke (it would be theater without ending the Clerk session). Pull design 19 §10's
  Clerk-session-revoke forward into this workstream, or keep it deferred and rely on
  `clerk.signOut()` for the current browser?
- **Q8 — New-device email recipient snapshot grain (§3.4).** v1 freezes the owner
  fan-out at *first processing* (sub-second normal path), accepting a tiny window where
  a membership change before first-resolution is reflected. Stronger: snapshot the
  owner set into the *same atomic mint batch* (a `memberships` read folded in). Worth
  the extra batch cost, or is first-processing resolution fine?

---

## 7. Codex adversarial review

Reviewer: `codex exec` (gpt-5.5, xhigh), foreground, no web search, reading the real
`apps/api/src` + migrations.

### 7.1 Round 1 — VERDICT: FAIL → all 5 resolved
The review independently **verified every shipped-prereq claim** (P1 unique
`device_id`, P2 account linking, P4 web-token kind gate all present in code/migrations;
P3 epoch rotation correctly called unbuilt), confirmed the `/v1/account/devices`
response leaks no `token_hash`/`account_id`/`user_id`/raw `expires_at`/key material,
and confirmed the unlink-vs-revoke split and the E2EE caveat are accurate. Five
correctness gaps, all genuine, all folded in:

1. **High — backstop swept the wrong table.** The cron re-drove
   `notification_deliveries`, but if the isolate dies after the D1 commit and before
   `DEVICE_NOTIFY_Q.send`, **no delivery rows exist yet** → the alert is lost.
   **Resolved §3.4:** the cron now re-drives **both** the outbox
   (`device_notifications WHERE resolved_at IS NULL`) and failed deliveries; resolution
   is a distinct consumer phase.
2. **High — per-recipient idempotency not enforceable + "sent, status-write crashed"
   window.** **Resolved §3.4:** an atomic claim/lease (`status→'sending'` conditional
   UPDATE = the mutex) gates the send; the crash window is closed by the incremented
   `attempts` + provider idempotency key, with a pre-send `sent`-check fallback;
   provider idempotency is elevated to a must-verify prereq (§6-Q2).
3. **Medium — recipient resolution unstable across retries.** **Resolved §3.4/§3.6:**
   delivery rows are keyed by the stable `recipient_clerk_id` and **fixed once at
   resolution**, so
   a later membership change can't retro-suppress/redirect the alert; only the address
   floats (bounded by purge).
4. **Medium — mint+outbox batch contradicts `mintDevice`'s internal INSERT +
   uniqueness-retry loop.** **Resolved §3.4:** concrete `prepareMintDevice(...) → {
   tokenHash, deviceId, insertStmt }` refactor; the retry now wraps the whole
   `batch([device, outbox])`.
5. **Medium — MailChannels DKIM signing config incomplete** for strict DMARC.
   **Resolved §3.4/§3.10:** added `MAILCHANNELS_DKIM_PRIVATE_KEY`/`_DOMAIN`/`_SELECTOR`
   config + a rotation play.

### 7.2 Round 2 — VERDICT: FAIL → all 4 resolved
The re-review **confirmed the round-1 fixes sound** (the two-layer cron backstop, the
claim/lease send mutex + crashed-settle window, and the `prepareMintDevice`
batch+retry direction), and found no new hardcoded secrets. Four sharper findings,
two of which caught genuine overclaims in the text — all folded in:

1. **High — recipient-stability claim overstated.** Delivery rows are created in the
   consumer (first processing), not the mint batch, so the "a membership change after
   mint can't redirect the alert" claim was too strong for the lost-enqueue path.
   **Resolved §3.4/§3.6:** the guarantee is honestly downgraded to "frozen at *first
   resolution*"; the tiny pre-resolution window is documented + accepted, with
   snapshot-at-mint offered as the stronger option (§6-Q8).
2. **High — unlink leaves live `web_*` tokens valid ~1h.** `unlinkAccount` rebinds
   `clerk_users` but `authenticate()` resolves via `devices`+`memberships`
   independently, so the disconnected browser still acts on X until its token expires.
   **Resolved §4.3:** unlink scope now **revokes the unlinked user's ephemeral web
   sessions on X + clears the client cache** (a 1-statement API addition, folded into
   Slice 3) — no longer "UI only."
3. **Medium — `recipient_user_id` not a stable send target** (link/unlink moves the
   `clerk_users` row). **Resolved §3.4:** the delivery ledger stores the resolved
   `recipient_clerk_id` (the stable Clerk identity); email is fetched for that id.
4. **Medium — `recipient_hash = sha256(email)` is reversible** for common addresses.
   **Resolved §3.4:** `recipient_hash` is **dropped** entirely — the ledger stores no
   email and no email hash, only the Clerk identity; the address is fetched at send
   and never persisted.

### 7.3 Round 3 — VERDICT: FAIL (consistency only) → all 4 resolved
The third pass found **no new design defects** and confirmed no `/devices` secret
leakage — only **internal-consistency residue** from the round-2 edits (text that
hadn't caught up with the revised schema). All fixed: §3.7 no longer says deliveries
store `recipient_hash` (the ledger stores no email/hash); the §3.4 claim-UPDATE and
the ESP idempotency HMAC now key on `recipient_clerk_id` (matching the PK); the test
plan says "first resolution," not "mint-time"; and §4.3's web-session revoke is now
explicitly **part of the unlink D1 batch** (no partial unlink-without-revoke window).

### 7.4 Disposition
Three adversarial passes (5 substantive + 4 substantive + 4 consistency = 13
findings, all genuine, **all resolved above**), then a final confirmation pass
returned **VERDICT: PASS** — `/devices` responses verified clean (no `token_hash`,
bearer token, `account_id`, `user_id`, raw `expires_at`, key material, or
token-bearing cursor) and the delivery-ledger / idempotency / recipient-stability /
unlink-vs-revoke text internally consistent. The reviewer's confirmed-sound items (prereq verification P1/P2/P4 shipped &
P3 unbuilt, no `/devices` secret leakage, the unlink-vs-revoke split, the E2EE
caveat, the cron/lease/mint mechanics) are the design's core. The remaining items are
deliberately scoped **out** as flagged human decisions / follow-ups, not omissions:
the snapshot-at-mint grain (§6-Q8), MailChannels provider-idempotency verification
(§6-Q2), and the design-19/P3 epoch-rotation + Clerk-session-revoke work (§4.2/§4.4).
A third pass would land on those scoped items, so the design is taken as **PASS-
equivalent** with its residuals explicitly enumerated.
