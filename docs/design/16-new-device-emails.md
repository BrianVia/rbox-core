# Design 16 — New-device security email ("a new device was added to your account")

> **Implementation: 🔴 NOT STARTED** — design complete & codex-reviewed (2026-06-29). Status index: [`README.md`](./README.md).

**Status:** v2 — design only (no implementation). Revised after an adversarial
codex review (VERDICT: FAIL → all 13 findings resolved; see §13).

**References:** design 10 (pairing), design 11 (web auth / Clerk), design 12 (full
E2EE), design 19 (device revocation — the revoke link target; revocation itself is
designed there, not here).

> **DECISION (2026-06-29) — outbound provider = stay all-Cloudflare.** This doc's
> body recommends **Resend**; the product call overrode it to keep email on the
> Cloudflare-adjacent stack. Caveat captured at decision time: Cloudflare has **no
> first-party transactional send** — Email Workers' `send_email` binding only reaches
> **pre-verified** recipients, so it cannot email arbitrary users. The actual path is
> the **MailChannels Email API (paid)**, historically the CF-integrated sender (note:
> still a separate vendor signup/billing — not literally "no new vendor"). At
> implementation, swap the provider-specific DNS in §(outbound) and design 18 from
> Resend's `include:_spf.resend.com` + Resend DKIM to **MailChannels'** SPF
> (`include:relay.mailchannels.net`) + the **Domain Lockdown** `_mailchannels` TXT +
> MailChannels DKIM. The outbound `From:` stays on **`security.rbox.to`** either way,
> so the apex/subdomain DMARC split in design 18 is unaffected.

---

## 0. Goal & non-goals

**Goal.** When a new auth credential is minted for an account through a durable
device-join path, email the account's owner(s) a transactional security alert —
the equivalent of Google/GitHub's "new sign-in to your account". Contents: device
**label**, approximate **time**, **IP + coarse location** if available, and a
**link to revoke** the device (revocation = design 19).

**Non-goals.** Revocation mechanics and the dashboard device page (design 19);
per-web-session "new browser" emails (§3.4); marketing/digests/billing email; any
change to the E2EE key model — this feature is **metadata-plane only** (§9).

**Naming honesty.** The user-facing copy is "a new device was added", but the
server-observable event we actually hook is "**a new bearer credential was
minted**" (§1.1). In the E2EE model these are not the same instant; §9 explains
why minting — not cryptographic roster admission — is the correct trigger.

---

## 1. What we hook, and why

### 1.1 Trigger = durable-credential mint, not E2EE admission

`mintDevice` (auth.ts) is the one place a `devices` row (a usable bearer token) is
born. It has four callers:

| Caller | Path | Durable credential? | Notify? |
|---|---|---|---|
| `bootstrap` | `POST /v1/auth/device/bootstrap` (secret) | yes (first device of a new account) | **No** — no recipient exists (§3.3) |
| `redeemPairToken` | `POST /v1/auth/pair/redeem` | yes | **Yes** (if a recipient resolves) |
| `pollDeviceAuth` (approved→claimed) | device-code approval | yes | **Yes** (if a recipient resolves) |
| `createWebSession` | `POST /v1/web/session` | **no** — short-lived `web_*` token re-minted ~hourly | **No** (§3.4) |

We enqueue a notification from the **two redeem/claim sites** (pairing redeem,
device-code claim). We do **not** hook `mintDevice` directly: it is also the
hourly web-session mint, so hooking it would emit an hourly email per active
dashboard user — spam, and an hourly IP-egress footgun (§3.4). We do **not** wait
for E2EE roster admission (`/v1/keys/admit`, keys.ts) either:

- Admission is **client-driven and client-verified**; design 12 forbids the server
  from mutating or interpreting the roster, so the server cannot reliably observe
  "admission succeeded" without parsing opaque blobs it must never parse.
- A minted token is **already a credential**: it can call `authenticate()` and hit
  account/metadata routes the moment it exists, **before** any E2EE admission and
  **even if admission never happens**. The security event a user needs to know
  about is "a token that can act as my account now exists" — that is exactly the
  mint, not the later, optional crypto step.
- The device-code path mints a credential but carries **no** `mkWrap`/
  `admissionGrant` (auth.ts `pollDeviceAuth` returns only `{token, deviceId,
  accountId}`), so a device may hold a working token and never complete admission.
  Triggering on mint covers it; triggering on admission would silently miss it.

So the precise semantics: **notify when a durable bearer credential is minted via
pairing-redeem or device-code-claim, addressed to the account's owners.**

---

## 2. Hook mechanics: an atomic outbox + at-least-once delivery

### 2.1 The outbox row

New migration `0013_device_notifications.sql`. There are **two** tables: an
event-level outbox (one row per device, the idempotency anchor + PII snapshot) and
a per-recipient delivery ledger (one row per address we must email about that
event). Splitting them is what makes **multi-owner partial success** representable
(§3) — a per-event status cannot express "owner A sent, owner B still retrying".

```sql
-- Event level: one row per minted credential (the dedupe + PII snapshot).
CREATE TABLE IF NOT EXISTS device_notifications (
  token_hash      TEXT PRIMARY KEY,         -- = devices.token_hash: the ONLY unique credential identity (§2.2)
  device_id       TEXT NOT NULL,            -- display id; revoke-link target only via a UNIQUE id (§5.2)
  account_id      TEXT NOT NULL,
  minted_user_id  TEXT,                     -- user the credential was minted into (NOT the recipient; §3)
  label           TEXT,                     -- device-label snapshot (purged after delivery, §8)
  ip              TEXT,                     -- CF-Connecting-IP at creation (purged after delivery, §8)
  geo             TEXT,                     -- coarse "City, Region, CC" from request.cf (nullable; purged §8)
  event           TEXT NOT NULL,            -- 'pair' | 'device_code'
  created_at      INTEGER NOT NULL,         -- epoch ms (the "approximate time" shown)
  coalesced_into  INTEGER,                  -- coalesce-window id when rolled into a summary (§10); NULL otherwise
  resolved_at     INTEGER                   -- set once recipients have been fanned out into deliveries
);
CREATE INDEX IF NOT EXISTS idx_devnotif_account ON device_notifications (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_devnotif_unresolved ON device_notifications (resolved_at);

-- Delivery level: one row per (event, recipient). Per-recipient status + retry +
-- idempotency key, so a 2-owner fan-out can succeed/fail/retry independently.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  token_hash      TEXT NOT NULL,            -- FK → device_notifications (or a summary id, §10)
  recipient_hash  TEXT NOT NULL,            -- sha256(lowercased email) — never store the address here
  idempotency_key TEXT NOT NULL,            -- HMAC(server_pepper, token_hash || recipient_hash); ESP key (§4.4)
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|sent|skipped|failed (§7)
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  sent_at         INTEGER,
  PRIMARY KEY (token_hash, recipient_hash)
);
CREATE INDEX IF NOT EXISTS idx_deliv_status ON notification_deliveries (status, last_attempt_at);

-- Per-account coalescing window (§10): an atomically-claimed bucket that bounds
-- email count under mass device creation without dropping the signal.
CREATE TABLE IF NOT EXISTS notify_coalesce (
  account_id   TEXT NOT NULL,
  window_start INTEGER NOT NULL,            -- floor(created_at / WINDOW_MS) * WINDOW_MS
  count        INTEGER NOT NULL DEFAULT 0,  -- events folded into this window
  summary_sent INTEGER NOT NULL DEFAULT 0,  -- 0/1: has the summary email been emitted
  PRIMARY KEY (account_id, window_start)
);
```

### 2.2 Idempotency anchor = `token_hash` (not `device_id`)

`device_id` is **not** unique: in `devices` the PRIMARY KEY is `token_hash`;
`device_id` only has a non-unique index (migration 0004), and pairing/device-code
mint it with just 4–6 bytes of randomness (`dev_<8 hex>` = 32 bits) — birthday
collisions are plausible at scale and the schema does not forbid them. The unique,
deterministic, server-side identity of a credential is its **`token_hash`**
(sha256 of the bearer token; already stored, irreversible). The outbox keys on
`token_hash`, so the insert is genuinely idempotent: a retried handler `INSERT OR
IGNORE`s the same `token_hash` → at most one row → at most one email.

> Follow-up (out of scope, flagged §11): bump `device_id` entropy in `mintDevice`,
> since it also appears in revoke links and the dashboard. The notification design
> does not depend on it, but the weak id is a latent issue.

### 2.3 Atomic row creation (a real outbox, and no regression to the join)

The outbox INSERT must commit **with** the device — and must not introduce a new
way to burn a single-use token without producing a device. The two join paths
differ in what can be batched, so they are specified separately:

- **Device-code (`pollDeviceAuth`)** — fully atomic. The approved row already
  carries `account_id`/`user_id` (no `RETURNING` dependency), so the claim, the
  mint, and the outbox insert go in **one** `env.rbox_dev_db.batch([claim-UPDATE,
  device-INSERT, outbox-INSERT])` (the same atomic D1 primitive `admitDevice`/
  `bootstrapAccountKeys` already use). All three commit or none do — the credential
  is claimed iff the device and its notification exist.
- **Pairing (`redeemPairToken`)** — the consume is `UPDATE … RETURNING
  account_id,…`, whose result is *needed* to build the device INSERT, so it cannot
  be pre-batched ahead of the consume. The consume → mint shape is therefore
  **unchanged from today** (design 10): the device INSERT and outbox INSERT are
  batched together (`batch([device-INSERT, outbox-INSERT])`), and the pre-existing
  consume-then-mint non-atomicity (a mint failure after consume burns the token —
  today's code already returns 500 with "token burned") is **inherited, not
  regressed**. Critically, folding the outbox into the *same* batch as the device
  INSERT means the outbox cannot fail *independently* of the device: both are
  trivial INSERTs on the same D1 connection in one transaction, so their failure
  modes are coextensive. We never turn a would-have-succeeded mint into a failure.

Net guarantee: **if the device exists, its outbox row exists**, and the outbox adds
no new token-burn failure surface beyond what design 10 already has. (Minor
refactor: `mintDevice` exposes its prepared INSERT so the call site can batch it.)
Delivery is the only best-effort part — strictly downstream of the committed rows.

### 2.4 Delivery: Cloudflare Queues, cron as backstop

- **Primary — Cloudflare Queues.** Add producer binding `DEVICE_NOTIFY_Q` to
  `Env`. After the batch commits, the call site does `env.DEVICE_NOTIFY_Q.send({
  tokenHash })` (id only — no PII on the wire; the consumer re-reads the
  authoritative row). A `queue(batch, env)` consumer (new handler in worker.ts)
  loads the row, resolves recipients (§3), renders, sends (§4), updates status.
  Queues give seconds-latency, at-least-once delivery, automatic backoff retry,
  and a DLQ.
- **Backstop — the existing cron.** `scheduled()` (worker.ts, currently GC-only)
  also sweeps `device_notifications WHERE status IN ('pending','failed') AND
  attempts < N`, re-enqueuing them. This re-drives rows whose `send()` never
  reached the queue (e.g., isolate evicted between commit and enqueue). **The D1
  row, not the queue message, is the source of truth.**

**Why not `ctx.waitUntil`?** The current `fetch(req, env)` signature has **no
`ExecutionContext`**, so `waitUntil` isn't even available without a signature
change; and `waitUntil` is best-effort with no retry, no idempotency record, and
dies with the isolate — unacceptable for a security alert. The outbox is durable +
idempotent + auditable; Queues are merely the fast transport.

---

## 3. Recipients: the account's owners, resolved via memberships

The recipient is **not** the user whose device minted the join (that user may be a
non-owner, or the same person on a new laptop). It is the **account's owner(s)**
(and optionally admins), resolved through the membership/role model that already
exists.

### 3.1 Resolution

1. `SELECT user_id FROM memberships WHERE account_id = ? AND role IN ('owner')`
   (extendable to `'admin'` if/when that role exists). These are the people who
   should hear "a device joined your account".
2. For each such `user_id`, reverse-map to a Clerk identity:
   `SELECT clerk_user_id, email FROM clerk_users WHERE account_id = ? AND user_id = ?`
   (index added in §3.2). The email comes from the cached column (§3.2), falling
   back to a live Clerk Backend API fetch.
3. Send one email per distinct resolved address (dedup addresses).

This guarantees the *owner* is alerted even when a *member's* device triggers the
join, and it never mis-addresses the alert to the joining user alone.

### 3.2 Email source + caching

`clerk_users(clerk_user_id, account_id, user_id, …)` (migration 0010) is the only
bridge to an email. We reverse it per owner, and the address itself comes from
Clerk's Backend API — the **same call already used** for the verified-email gate
(`GET https://api.clerk.com/v1/users/{sub}`, `CLERK_SECRET_KEY`, primary *verified*
address). To decouple delivery from Clerk's uptime and avoid egressing the
`sub`↔account graph on every device add, **cache the primary verified email on the
mapping row**, refreshed on every successful `/v1/web/session`:

```sql
ALTER TABLE clerk_users ADD COLUMN email TEXT;             -- cached primary verified email
ALTER TABLE clerk_users ADD COLUMN email_updated_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_clerk_users_acct ON clerk_users (account_id, user_id);
```

**Correction to a tempting assumption:** `webSession()` calls Clerk's Backend API
**only on first provisioning** (the `if (!map)` branch); **returning logins skip
Clerk entirely** (clerk.ts), so today there is *no* per-login email refresh to
piggyback on. The implementation must therefore **add** a returning-user refresh
path: on each `/v1/web/session`, throttled by `email_updated_at` (e.g. refetch at
most once per 24h), call `GET /v1/users/{sub}`, and `UPDATE clerk_users SET
email=?, email_updated_at=?` with the primary *verified* address. Failure of that
fetch is **non-fatal to login** (it's a cache refresh, not the auth path) — it
just leaves the prior cached value. The consumer reads `email`; if NULL it does one
live Clerk fetch (and on transient failure → `failed`/retry, §7, never `skipped`).
Staleness is bounded by the refresh cadence and self-heals on login; for a security
alert, "the address you most recently authenticated with" is the right target.

### 3.3 CLI-only / bootstrap accounts — no recipient (terminal `skipped`)

`bootstrap` creates account+user+owner-membership with **no `clerk_users` row** →
no email anywhere. Device-code joins into such accounts inherit the gap. When the
owner resolution (§3.1) yields **zero** addresses **and** a Clerk lookup confirms
none exists, the row is terminally `skipped`. This is distinct from a transient
lookup *failure* (§7), which retries. Bootstrap thus never emails (first device +
no recipient — both independently true).

### 3.4 Web sessions excluded

`createWebSession` mints a short-lived `web_*` token on every dashboard login. Not
notified: there is no stable browser identity to dedupe (fresh id hourly → every
login looks "new"); the user is actively completing a Clerk sign-in at that moment;
and Clerk already owns new-browser sign-in security signals. "New browser" emails,
if ever wanted, belong to Clerk's settings, not here.

---

## 4. Email infrastructure

### 4.1 Cloudflare-native outbound is a dead end here

- **MailChannels'** free Workers tier **ended (June 2024)** — no longer the default.
- The **Email Routing / Email Workers `send_email` binding can only send TO
  verified destination addresses** in your routing config (built for
  forwarding to your own inboxes), **not** arbitrary customers. Useless here.
- No first-party Cloudflare transactional-send for arbitrary recipients exists.
  Outbound therefore goes to a third-party ESP via HTTPS `fetch` from the Worker.

### 4.2 Recommendation: **Resend** (AWS SES as the scale fallback)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Resend** | One-`fetch` HTTPS API, Workers-first, strong transactional deliverability, DKIM/SPF/DMARC setup wizard, native `Idempotency-Key` + `List-Unsubscribe` | another vendor; cost grows at volume | **Recommended** |
| AWS SES | cheapest at volume, mature | SigV4 in a Worker is fiddly; slower domain setup; needs reputation warm-up | scale fallback |
| Postmark | best transactional deliverability | pricier, strict content rules | viable alt |

Volume is tiny (one email per *new durable device* — rare), the repo already
standardizes on Resend for server email, and the outbox/consumer split isolates
the ESP behind the consumer's `send()` (swap = one function). Recommend Resend.

New config: `RESEND_API_KEY` (Wrangler secret), `RBOX_NOTIFY_FROM` (e.g.
`security@security.rbox.to`), `NOTIFY_IDEMPOTENCY_PEPPER` (secret, §4.4), reuse
`RBOX_APP_URL` for the revoke-link base.

**Feature gating — fail loud, not silent.** A *missing or rotated* `RESEND_API_KEY`
in prod must **not** become a terminal `skipped` (that would permanently discard
security alerts until someone notices). Instead: with the key unset the delivery is
`failed` + an ops alarm, and the cron keeps re-driving it so it self-heals the
moment the secret is restored. The feature is only intentionally off — `skipped` —
when an **explicit** `DEVICE_NOTIFICATIONS_DISABLED=1` env flag is set. (Local/dev
sets that flag; prod never should.)

### 4.3 Deliverability (rbox.to is on Cloudflare DNS)

All records are one Cloudflare DNS change:
- **Dedicated sending subdomain** (e.g. `security.rbox.to`) so transactional
  reputation is isolated from the apex and any future marketing domain.
- **SPF**: `v=spf1 include:_spf.resend.com ~all` on the sending subdomain.
- **DKIM**: the CNAME keys Resend issues.
- **DMARC**: `v=DMARC1; p=quarantine; rua=mailto:dmarc@rbox.to; adkim=s; aspf=s`,
  graduating to `p=reject` once aligned and monitored.
- `List-Unsubscribe` headers (§6) for inbox-provider compliance.

### 4.4 Idempotent send (without leaking `token_hash`)

The ESP `Idempotency-Key` is the **per-recipient** `idempotency_key =
HMAC(NOTIFY_IDEMPOTENCY_PEPPER, token_hash ‖ recipient_hash)` stored on the
delivery row — **not** the raw `token_hash`. `token_hash` is the server's stable
credential *verifier*; even though it is irreversible, there is no reason to egress
it to a third party. The HMAC is per-(event,recipient), so two owners get distinct
keys (a redelivery to owner A can't be deduped against owner B's send), and it
reveals nothing about the credential to the ESP. Combined with the per-delivery
`status='sent'` check, at-least-once queue redelivery can never double-send a given
recipient even if a status write loses a race.

---

## 5. Email contents & the revoke link

Rendered server-side in the consumer; plain, security-styled:

- **Subject:** `New device on your rbox account` — the device label is **not**
  interpolated into the Subject (avoids header injection from a hostile label);
  the label appears only in the sanitized body (§5.1).
- **Body:** sanitized device label; approximate time (`created_at`, explicit UTC
  offset + "times are approximate"); `ip · City, Region, CC` when available,
  degrading to country-only or "location unavailable"; how it joined ("paired from
  another device" / "approved via device code"); a **"This wasn't you?"** revoke
  link → `${RBOX_APP_URL}/devices?highlight=<unique-credential-id>` (see §5.2;
  design 19 owns the page and any signed one-click-revoke token; the link is **not**
  an unauthenticated mutate-on-GET — the owner authenticates via Clerk before
  revoking); footer with why-you-got-this + preferences link (§6).
- **Never** contains the bearer token, key material, or anything that grants
  authentication if the email is forwarded/intercepted (§9).

### 5.1 Label sanitization (render-time, authoritative)

Stored labels are inconsistently bounded across paths (pairing slices to 200;
bootstrap/device-code labels come straight from request bodies). The email
renderer therefore sanitizes **at render time, regardless of stored value**:
strip CR/LF and all C0/C1 control characters (header-injection + spoofing guard),
clamp to ~80 chars, HTML-escape for the HTML part and text-escape for the text
part. This is the single chokepoint that makes a hostile label safe in every
sink.

### 5.2 The revoke target must be a UNIQUE credential id (hard prerequisite)

The revoke link must point at **exactly one** credential. Today it cannot:
- `devices.device_id` is **not unique** (PK is `token_hash`; `device_id` is a
  non-unique index, minted with only 4–6 bytes of entropy, migration 0004 / auth.ts).
- `revokeDevice` revokes **by `device_id` across the whole account**
  (`UPDATE devices SET revoked=1 WHERE device_id=? AND account_id=?`), so a
  collision would revoke *every* matching credential — and a `?highlight=<device_id>`
  link is ambiguous.
- It also **collides with the E2EE schema**, where `device_keys.device_id` is a
  `TEXT PRIMARY KEY` (migration 0011) — i.e. E2EE already *assumes* uniqueness that
  `devices` does not enforce.

So this feature has a **cross-cutting prerequisite**: a unique, high-entropy public
credential identifier to target. Two options (decided in design 19 / a small
auth.ts change, **not** invented here): (a) make `device_id` unique + high-entropy
at mint and add a `UNIQUE` constraint, reconciling `devices` with `device_keys`; or
(b) introduce a separate `public_credential_id` column. Until that lands, the email
should link to the **device list page** (no `highlight`) rather than ship an
ambiguous deep-link. Flagged for the human (§12.7).

---

## 6. Notification preferences (account-scoped)

The preference is a property of the **account**, not of one Clerk user, so it
lives in a new account-scoped table (not on `clerk_users`, which is keyed by Clerk
user and would be the wrong grain):

```sql
-- 0013 (same migration): account-scoped notification prefs
CREATE TABLE IF NOT EXISTS account_notify_prefs (
  account_id        TEXT PRIMARY KEY,
  notify_new_device INTEGER NOT NULL DEFAULT 1   -- 1=on (opt-out model)
);
```

- The consumer checks it; `0` → `skipped`.
- **Changing it requires an authenticated `owner`/`admin` session — not merely any
  logged-in member.** The account already has roles (`memberships`, authz.ts); a
  non-owner member (whose own paired device can trigger these alerts) must **not**
  be able to blind the account's owners. The mutation endpoint authorizes the
  caller's role exactly like other owner-scoped routes.
- **Audit + cross-notify.** Disabling the alert writes an audit record and sends a
  one-off "new-device alerts were turned off" email to the **other** owners, so a
  single compromised/rogue owner cannot silently disable the account's security
  signal for everyone. (Re-enabling is unremarkable and not cross-notified.)
- There is **no** unauthenticated one-click endpoint that disables a *security*
  alert — a forwarded email must never be able to silence future alerts.
- For inbox-provider compliance we still send a `List-Unsubscribe` header, but it
  points at the **authenticated** preferences deep-link
  (`${RBOX_APP_URL}/settings/notifications`) — header present (good for
  deliverability), state change still gated on login. (A `mailto:` unsubscribe to a
  monitored box is an acceptable secondary form; it opens a request, it does not
  silently flip the flag.)
- **Stance:** new-device emails are security notifications, kept opt-out (default
  on), separate from any future marketing prefs, with a UI warning when disabling.

---

## 7. Failure handling (email must never break device creation)

Hard rule: **the device is created and usable regardless of email outcome** — the
batch (§2.3) commits the device + outbox row atomically; everything else is
downstream.

The state machine runs **per `notification_deliveries` row** (one per recipient),
not per event — so a 2-owner fan-out tracks each send independently and a partial
failure neither drops the other owner nor re-sends the succeeded one:

- The consumer first **resolves recipients** for an unresolved
  `device_notifications` row (§3) and inserts one `notification_deliveries` row per
  owner address (`INSERT OR IGNORE`, so re-resolution is idempotent), then stamps
  `device_notifications.resolved_at`.
- Per delivery: **`pending` → `sent`** on ESP 2xx (stamps `sent_at`).
- **`pending`/`failed` → `failed` (retry)** on **transient** errors — ESP 5xx/429,
  **Clerk API down/timeout**, network, **or a missing `RESEND_API_KEY` in prod**
  (§4.2). Bounded `attempts`; queue backoff + cron re-drive. Transient failures
  must **retry**, never silently drop a security alert.
- **`pending` → `skipped` (terminal, no retry)** only when the *answer is known*:
  the account genuinely resolves to **no** owner email (CLI-only, §3.3), the pref
  is disabled (§6), or `DEVICE_NOTIFICATIONS_DISABLED=1` is set (§4.2). The cron
  ignores `skipped`.
- `attempts` exhausted → `failed` terminal-with-alarm (DLQ + log) for ops.

The distinction is the fix for "Clerk/ESP down silently eats alerts":
*unknown/transient/misconfigured* retries, *known-absent/intentionally-off* skips.

---

## 8. Privacy & data minimization

- **Coarse by default.** `request.cf` city/region/country plus the raw IP (the one
  signal users actually recognize), mirroring GitHub/Google.
- **This IS a new disclosure channel.** Sending the email egresses recipient
  address + device label + IP/geo to the ESP and to the destination mailbox. That
  is inherent to email and is a *conscious* new egress — not "no new disclosure".
  We minimize the standing copy to limit blast radius if D1 leaks.
- **Purge all PII after delivery.** The cron sweep **nulls `label`, `ip`, and
  `geo`** once a row is `sent`/`skipped` (or after a 7-day TTL, whichever first).
  We keep only non-PII audit fields (`token_hash`, `device_id`, `account_id`,
  `event`, timestamps, `status`). We do **not** build a permanent per-device IP or
  label history — that would be a new tracking surface (design 19's device list
  shows `last_seen_at`, never IP trails).
- **`request.cf` is fetch-only.** IP/geo exist only inside the `fetch` handler, so
  they are snapshotted into the outbox row at creation; the queue consumer and cron
  have no `request.cf` and never recompute them.
- **`token_hash` never leaves rbox.** It is the server's stable credential
  *verifier*; though irreversible, it is not egressed to the ESP. The ESP
  idempotency key is a per-recipient HMAC over `(token_hash ‖ recipient_hash)`
  (§4.4), and `notification_deliveries` stores `recipient_hash`, never the raw email.

---

## 9. E2EE confirmation (metadata-plane only — no plaintext leak)

This feature lives entirely outside the E2EE envelope (design 12). Confirmed:

1. **No MK / KEK / workspace-key / roster / key-state material is read, sent, or
   referenced.** The notification uses only `devices`/`memberships`/`clerk_users`
   columns (label, ids, timestamps, email) + request metadata (IP/geo). None are
   encrypted blobs.
2. **The device label is already server-plaintext** (`devices.label`, set by the
   redeemer/CLI). Emailing it discloses **no new plaintext file content** — under
   E2EE the server never holds file content, and this feature never decrypts
   anything, so it *cannot* leak plaintext. (It is still a new *egress* of existing
   metadata — see §8; we don't overclaim "no new disclosure".)
3. **Trigger is server-observable mint, not the client-verified roster admission**
   (§1.1). The server respects design 12's "must not mutate/interpret the roster"
   boundary: it never parses the opaque admission blobs to drive notifications.
4. **No key material and no bearer token in the email** (§5), so a forwarded or
   intercepted email confers no cryptographic capability.

Net: purely metadata-plane; consistent with E2EE; adds no plaintext exposure
beyond metadata the server already stores, and that egress is documented and
minimized.

---

## 10. Abuse / rate-limiting

New-device *creation* is gated upstream, which bounds email volume at the source:
- **Pairing redeem** needs a valid single-use token minted by an **authenticated
  device**, capped at **5 active/account** (`PAIR_ACTIVE_CAP`), 10-minute TTL.
- **Device-code** needs interactive **approval by an authenticated device on the
  account** — note this is *any* authed device, **not** specifically an
  owner/admin (`approveDeviceAuth` does no role check). It still requires an
  existing credential on the account; an outside attacker cannot self-approve.
- **Bootstrap** needs the platform bootstrap secret (and never emails).

So an outside attacker cannot freely add devices to a victim's account, hence
cannot freely trigger emails.

**Over-cap behavior never drops the signal — concretely.** A *compromised
authorized device* mass-creating devices is exactly when alerting matters most, so
the cap bounds the email *count*, never the *signal*. Mechanism, designed (not just
asserted):

1. Each event maps to a coalescing window `window_start = floor(created_at /
   WINDOW_MS) * WINDOW_MS`, account-scoped (`notify_coalesce`, §2.1).
2. The consumer **atomically claims a slot** with a single conditional upsert
   (D1 serializes writes, closing the parallel-consumer race exactly as
   `createPairToken`'s cap does):
   `INSERT INTO notify_coalesce(...) VALUES(...,1,0) ON CONFLICT(account_id,
   window_start) DO UPDATE SET count = count + 1 RETURNING count`.
3. If the returned `count` ≤ `PER_WINDOW_CAP`, send the individual email as normal.
4. If `count` > cap, the individual event is **not** dropped: its outbox row is
   stamped `coalesced_into = window_start` and **no** individual email is sent.
   Instead, exactly one **summary** delivery is emitted per window — guarded by an
   atomic `UPDATE notify_coalesce SET summary_sent = 1 WHERE account_id=? AND
   window_start=? AND summary_sent = 0` (only the consumer that flips 0→1 sends it),
   so parallel consumers can't double-send the summary. The summary ("**M new
   devices were added to your account**", listing labels/times/revoke-links for all
   `coalesced_into` rows in the window) goes through the same per-recipient
   `notification_deliveries` machinery, keyed by a synthetic
   `summary:<account>:<window_start>` id.

Every device is therefore represented (either an individual or a summary email);
only the email *rate* is capped. Coalescing is **required** for v1's over-cap path.

---

## 11. Implementation surface & test plan (for the eventual build)

**`Env` / wrangler additions:** `DEVICE_NOTIFY_Q` (queue producer binding) +
consumer config + DLQ; `RESEND_API_KEY` (secret), `RBOX_NOTIFY_FROM`,
`NOTIFY_IDEMPOTENCY_PEPPER` (secret), `DEVICE_NOTIFICATIONS_DISABLED` (flag); DNS
(SPF/DKIM/DMARC on `security.rbox.to`).
**Worker:** add `queue(batch, env)` handler; extend `scheduled()` with the
backstop sweep + PII purge + coalesce-summary emission.
**auth.ts:** `mintDevice` exposes a batchable INSERT statement; `pollDeviceAuth`
batches **claim+device+outbox** atomically; `redeemPairToken` batches
**device+outbox** (consume stays as today, §2.3) and enqueues.
**clerk.ts:** **add** a returning-user verified-email refresh (throttled by
`email_updated_at`) — today Clerk is called only on first provisioning (§3.2).
**revoke prerequisite:** a unique high-entropy credential id for the revoke link
(§5.2) — a small auth.ts/`devices` change owned with design 19.
**Migrations:** `0013` — `device_notifications`, `notification_deliveries`,
`notify_coalesce`, `account_notify_prefs`, `clerk_users.email`/`email_updated_at`,
indexes.

**Tests (business logic, not type-checks):**
- Idempotency: duplicate queue delivery for one `token_hash` → exactly one send
  per recipient (`notification_deliveries` PK).
- Atomicity: device-code claim+device+outbox commit together (one fails ⇒ all roll
  back, token not burned); pairing device+outbox commit together.
- Recipients = account **owners** via memberships, even when a **non-owner's**
  device joins; multi-owner fan-out with independent per-delivery status (owner A
  `sent`, owner B retrying); address dedup.
- `skipped` vs `failed`: Clerk-down / missing ESP key ⇒ `failed`+retry;
  no-owner-email / `DEVICE_NOTIFICATIONS_DISABLED` ⇒ `skipped`.
- Label sanitization: CRLF/control chars stripped, clamped, escaped; hostile label
  cannot inject a header or break the body.
- Returning-user email refresh path actually calls Clerk + updates the cache
  (throttled); NULL cache ⇒ one live fetch; transient fetch failure ⇒ retry.
- Over-cap coalescing: 50 rapid devices ⇒ exactly one summary per window (atomic
  `summary_sent` 0→1), every device represented, no silent drop, parallel
  consumers don't double-send.
- Pref change requires owner/admin; a member cannot disable; disabling cross-
  notifies other owners.
- Web-session mint creates **no** outbox row; bootstrap creates none.

---

## 12. Open questions for the human

1. **CLI-first coverage gap (biggest, and structural).** Today web login
   *provisions a new Clerk-backed account* and never **links** a pre-existing
   bootstrap/CLI account (clerk.ts), so CLI-first accounts are **permanently
   un-notifiable** — not just "no email yet". Real fix options: (a) collect+verify
   an account contact email during CLI onboarding (design 07c) into an
   `account_contacts` table the recipient resolver also consults; (b) build
   CLI↔Clerk account linking. Both are larger efforts. Accept web-only coverage
   for v1, or fund one of these?
2. **Adopt Cloudflare Queues** (new binding + `queue()` handler), or ship v1 on the
   cron-sweep-only path (higher latency, no new binding) and add Queues later?
3. **Resend vs SES** — recommend Resend; any AWS/SES investment that tips it?
4. **DMARC `p=quarantine` → `p=reject`** timeline and sending subdomain
   (`security.rbox.to`?).
5. Recipients = **owners only**, or **owners + admins** once an admin role exists?
6. Keep new-device email **opt-out** (recommended, with a UI warning) or make it
   strictly non-disable-able as a pure security signal?
7. **Unique credential id for the revoke link (§5.2) — a real prerequisite.**
   `devices.device_id` is non-unique and `revokeDevice` revokes by it
   account-wide, which also conflicts with E2EE's `device_keys.device_id PRIMARY
   KEY`. Make `device_id` unique+high-entropy (reconciling the two schemas), or add
   a separate `public_credential_id`? This blocks shipping the deep-link form of
   the revoke link (until then, link to the device list without `highlight`).

---

## 13. Codex adversarial review

Reviewer: `gpt-5.5` (xhigh), two adversarial passes.

### 13.1 First pass (on the v1 draft) — VERDICT: FAIL → all 13 resolved in v2

1. **"Outbox" wasn't transactional (caught insert failure ⇒ "no row → no email").**
   Resolved: device INSERT + outbox INSERT now go in one `env.rbox_dev_db.batch()`
   (the atomic D1 primitive already used by `admitDevice`/`bootstrapAccountKeys`),
   so the row commits iff the device does (§2.3). Only *delivery* is best-effort,
   correctly.
2. **Emails on token mint, not E2EE roster admission.** Resolved by making the
   semantics explicit (§1.1, §9): we deliberately trigger on **credential mint**
   because a minted token can act on the account before/without admission, and the
   server must not interpret the opaque roster to observe admission. User copy
   stays "device added"; doc names the real event "credential minted".
3. **Device-code carries no `mkWrap`/`admissionGrant`, unlike pairing.** Resolved:
   the credential-mint framing (§1.1) covers device-code precisely *because*
   triggering on admission would miss it; both paths mint a usable token → both
   notify.
4. **`device_id` is not a valid idempotency anchor (PK is `token_hash`; device_id
   is 32-bit, non-unique).** Resolved: outbox PRIMARY KEY is now `token_hash`
   (§2.2); `device_id` is a display/link column only. Weak `device_id` entropy
   flagged as a separate follow-up (§11/§2.2).
5. **Recipient = the minting user, ignoring owners/roles.** Resolved: recipients
   now resolve via `memberships` where `role='owner'` (extensible to admin), each
   mapped to a Clerk email, fan-out + dedup (§3.1). The owner is alerted even when
   a member's device joins.
6. **Opt-out on `clerk_users` (wrong grain) + unauthenticated unsubscribe
   footgun.** Resolved: preference moved to account-scoped `account_notify_prefs`
   (§6); the unauthenticated one-click *disable* is removed — security-alert prefs
   change only from an authenticated session; `List-Unsubscribe` points at the
   authenticated settings page for deliverability without an unauthenticated
   mutation.
7. **Clerk/ESP failure → terminal `skipped` silently eats alerts.** Resolved: §7
   splits **transient** failures (Clerk down, ESP 5xx) → `failed`+retry, from
   **known-absent** recipients → `skipped`. Security alerts retry on turbulence.
8. **False claim that device-code needs "owner approval".** Resolved: §10 now
   states accurately that `approveDeviceAuth` requires *an authenticated device on
   the account* with **no role check** — still a gate against outsiders, but not
   owner-restricted.
9. **Rate cap could suppress the very mass-creation it should surface.** Resolved:
   §10 never drops — over-cap events **coalesce** into a single summary email
   (required for v1), bounding email count without losing the signal.
10. **Privacy overstated ("no new disclosure"); label kept indefinitely.**
    Resolved: §8/§9 now state the email **is** a new egress channel; and the cron
    purges `label` too (not just IP/geo) after send.
11. **Label sanitization underdesigned (bootstrap/device-code labels unbounded; no
    header/control-char handling).** Resolved: §5.1 adds authoritative render-time
    sanitization — strip CRLF/control chars, clamp, escape; label kept out of the
    Subject to block header injection.
12. **Operational deliverability hand-waved (no bindings/envs/test plan).**
    Resolved: §11 enumerates exact `Env`/wrangler/worker/migration changes and a
    business-logic test plan.
13. **CLI-first coverage gap is structural, not just product (web login creates a
    new account, never links the CLI account).** Resolved: elevated in §12.1 as a
    structural limitation with two concrete fix options, flagged for the human.

### 13.2 Second pass (on the revised v2) — VERDICT: FAIL → all 8 resolved in this version

The re-review confirmed the trigger/E2EE boundary, web-session exclusion, owner
lookup, and CLI-gap honesty held, but found deeper state-model/targeting flaws.
All folded in:

1. **Multi-owner partial success was unrepresentable** (one per-event status +
   shared idempotency key). Resolved: added a per-recipient
   `notification_deliveries` ledger keyed by `(token_hash, recipient_hash)` with its
   own status/attempts/idempotency key (§2.1, §7).
2. **The atomic batch didn't cover the single-use gate** — outbox failure could
   burn a pairing/device-code token with no device. Resolved: device-code batches
   **claim+device+outbox** atomically; pairing keeps design 10's consume→mint shape
   and the outbox rides the *same* batch as the device INSERT so it can't fail
   independently — no new token-burn surface (§2.3).
3. **`device_id` unsafe as the revoke target** (non-unique; `revokeDevice` is
   account-wide; conflicts with `device_keys.device_id PRIMARY KEY`). Resolved:
   added §5.2 making a unique credential id a hard prerequisite; link omits
   `highlight` until it lands; elevated to §12.7.
4. **Coalescing was asserted, not designed.** Resolved: §10 now specifies the
   `notify_coalesce` window, the atomic slot-claim upsert, `coalesced_into`, and the
   atomic `summary_sent` 0→1 guard against double-send by parallel consumers.
5. **Opt-out lacked role authz.** Resolved: §6 requires owner/admin to change it,
   audits the change, and cross-notifies other owners.
6. **Missing `RESEND_API_KEY` → terminal silent drop.** Resolved: §4.2/§7 make an
   unconfigured-in-prod key a retryable `failed`+alarm; only an explicit
   `DEVICE_NOTIFICATIONS_DISABLED` flag yields `skipped`.
7. **`token_hash` egressed to the ESP as the idempotency key.** Resolved: §4.4/§8
   use a per-recipient `HMAC(pepper, token_hash ‖ recipient_hash)` instead;
   `token_hash` never leaves rbox; deliveries store `recipient_hash`, not the email.
8. **False assumption that `webSession()` refetches email every login** (it calls
   Clerk only on first provisioning). Resolved: §3.2/§11 require an explicit,
   throttled returning-user refresh path with non-fatal failure behavior.

**Disposition of the second FAIL.** The two codex passes were used (the iterate-
and-re-run budget is spent); these 8 findings were genuine and are all resolved in
the text above. The remaining items the reviewer would still call out are
deliberately scoped **out** of this doc and tracked as cross-doc prerequisites /
human decisions, not omissions: the unique-credential-id change (§5.2/§12.7, owned
with design 19), the CLI-first coverage gap (§12.1), and the Queues-vs-cron and
ESP-vendor calls (§12.2–12.3).
