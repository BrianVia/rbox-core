# 94 — Surface the web login's attached sign-in credentials (`clerk_users.signin_method`)

Status: ✅ ALIGNED v7, 2026-07-10 — 7 adversarial rounds (REVIEW-94.md), codex (sol) verdict ALIGNED; round-7 wording nit folded.
v7: backfill bound restated as CONVERGENCE (final stored = greatest observed
Clerk version); redundant fetches AND writes bounded by request concurrency. Pending round 7 (final).
Origin: 2026-07-10 session — the fleet account's auth method (password vs
Google vs GitHub) was undeterminable from anywhere we control; only the Clerk
dashboard knows. Backlog entry in `docs/STATUS.md`.

## 1. Problem and evidence

An rbox account's web login is a Clerk identity, and which credentials that
identity can sign in with (Google OAuth, GitHub OAuth, password) is invisible
to rbox. D1's `clerk_users` stores `clerk_user_id`, `account_id`, `user_id`,
`created_at` (`apps/api/migrations/0010_clerk.sql:5-10`) plus the cached
`email`/`email_updated_at` added later
(`apps/api/migrations/0016_device_notifications.sql:54-60`). Nothing records
credentials; the only answer today is the Clerk dashboard.

Why it matters beyond curiosity:

- **Support/forensics**: "which identity provider is this account bound to"
  is the first question in a web-auth incident, and today it requires Clerk
  dashboard access (a different auth surface than the rbox admin path).
- **Account-confusion guard**: there is exactly ONE prod web account today
  (`docs/STATUS.md`); a browser session on any other identity silently creates
  a fresh empty account. Surfacing "sign-in: google" in `rbox account status`
  makes a mismatch visible cheaply.

The plumbing already mostly exists and throws its answer away:

1. **`signInMethodOf()` already computes a (flawed) label.**
   `apps/api/src/clerk.ts:233-237` maps `external_accounts[0].provider` →
   `"github" | "google" | …` (oauth_ stripped), else `"email"`. Two defects
   this design fixes: it reads only entry [0] (a password+GitHub user reports
   just `github`), and it ignores verification status (a *pending* Google
   connection reports as `google`).
2. **The full Clerk user object is already fetched at first login.**
   `fetchClerkUser` (`apps/api/src/clerk.ts:242-253`) calls
   `GET api.clerk.com/v1/users/{sub}` with `env.CLERK_SECRET_KEY` for the
   fail-closed provisioning gate; its `signInMethod` flows only into the Slack
   signup ping (`clerk.ts:171-175`, `slackpipes.ts:89`) and is never persisted.
3. **The full Clerk user object is ALSO fetched on returning logins.**
   `refreshOwnerEmail` (`apps/api/src/notify.ts:283`, invoked at
   `clerk.ts:185`) → `fetchClerkPrimaryEmail` (`notify.ts:269`) downloads the
   whole user and reads only the primary email.

So: this design adds no new Clerk fetch call sites and no steady-state
traffic — the only addition is the accelerated backfill for pre-existing
rows. Its precise bound: failed attempts retry on later logins; overlapping
concurrent logins may issue redundant successful fetches AND redundant
successful writes (each bounded by overlapping request concurrency — an
older-version write followed by a newer-version write both pass the
monotone guard); the guarantee is convergence, not uniqueness — the final
stored observation carries the greatest observed Clerk version whose guarded UPDATE completed successfully (§5 I2, I5).

## 2. Column semantics — attached credentials, honestly

New column `clerk_users.signin_method TEXT NULL`.

**What it records: the set of VERIFIED sign-in credentials attached to the
Clerk identity at last observation.** It does NOT record which method was used
for any particular session — Clerk's user object cannot answer that (that
would need sign-in-attempt/session data; explicit non-goal, §4).

Derivation (one pure function, §3.2):

- Each `external_accounts[]` entry with `verification.status === "verified"`
  contributes its provider short name (`oauth_google` → `google`,
  `oauth_github` → `github`; unknown providers pass through prefix-stripped —
  honest over guessing). Unverified / `failed` / `expired` / `transferable`
  entries are EXCLUDED — an attached-but-never-completed connection is not a
  credential.
- `password_enabled === true` contributes `password` (Clerk defines it as
  "the user has a password set" — exactly the credential claim we want).
- Deduplicate (two verified Google accounts → one `google`), sort, join
  with `+`. Examples: `google`, `github+google`, `github+password`.
- **Empty set → SQL NULL**, rendered as "unknown". No `email` fabrication:
  a verified primary email proves deliverability, not that email-code login
  is enabled or used (round-1 blocker 2). An empty modeled set is a
  legitimate state, not an anomaly: email-code-only users exist in this
  product's own history (`docs/design/15-web-dashboard.md:9-10`,
  `docs/go-live-todo.md:42`), and future passkey/phone/enterprise-SSO users
  would land here too — unknown-until-modeled is the honest rendering
  (round-2 finding 4).

Why composite TEXT, not JSON or a single value: multiple simultaneous
credentials are real (password AND GitHub); sorted-join is deterministic
(cheap equality for change detection), greppable, and human-readable in three
renderers without parsing. Cardinality is tiny. Per-method metadata
(timestamps, counts) would be a new design.

`NULL` provenance is exactly: (a) rows created before this design ships,
until their first post-ship refresh; (b) the empty-credential case above.
A failed Clerk fetch never NULLs an existing value (writes are skipped, §3.4)
and cannot produce a NULL INSERT (provisioning fail-closes first, §3.3).
Renderers MUST omit the line/row when NULL. Nothing — device auth, plans,
quotas — may branch on this column (display/forensics metadata only).

Sibling column `signin_method_updated_at INTEGER NULL` records **Clerk's own
`updated_at` from the user payload that produced the value** — a
server-authoritative snapshot VERSION, not a local clock (round-2 finding 2:
locally sampled timestamps cannot order concurrent snapshots). Its two jobs:
(a) `IS NULL` ⇔ "this row has never been observed" — the backfill
discriminator (an observed-empty row has `signin_method NULL` but a non-NULL
version, so it does NOT re-trigger backfill; round-2 finding 1); (b) the
conditional-write guard (§3.4).

## 3. Design

### 3.1 Migration — `0023_signin_method.sql`

```sql
-- Design 94: persist the web login's verified attached sign-in credentials
-- (sorted composite like 'google', 'github+password'; NULL = not yet
-- captured / none derivable — never blocks auth). Additive + nullable.
-- signin_method_updated_at = Clerk user.updated_at of the observation
-- (snapshot version: stale-writer guard + never-observed discriminator).
ALTER TABLE clerk_users ADD COLUMN signin_method TEXT;
ALTER TABLE clerk_users ADD COLUMN signin_method_updated_at INTEGER;
```

0023 is the next free number (guard: `apps/api/vitest.config.ts`).

Rollout ordering:

- **Prod**: safe by pipeline construction — the Workers Builds build command
  applies migrations before the deploy command runs
  (`docs/DEPLOYMENTS.md`), so prod's new code never sees the old schema.
  This claim is scoped to prod's recorded pipeline, not a general property.
- **Dev**: the dev DB has no auto-apply hook. **Apply the migration BEFORE
  deploying the schema-dependent dev worker** — the new INSERT/SELECT/UPDATE
  SQL fails on the old schema (additive-nullable protects old code against
  the new schema, not new code against the old schema):
  `cd apps/api && npx wrangler d1 migrations apply rbox-dev-db --remote`,
  then `cd apps/api && npx wrangler deploy`.
- Old code + new schema (rollback case) is safe: column unread by old code.

### 3.2 Compute — one shared pure parser

New exported pure function (single owner of the semantics, used by BOTH fetch
paths — prevents drift between them):

```ts
// apps/api/src/clerk-signin.ts
export function signinMethodsOf(u: {
  external_accounts?: Array<{ provider?: string; verification?: { status?: string } }>;
  password_enabled?: boolean;
}): string | null {
  const methods = new Set<string>();
  for (const a of u.external_accounts ?? []) {
    if (a.verification?.status !== "verified") continue;
    if (typeof a.provider === "string" && a.provider.length) {
      methods.add(a.provider.replace(/^oauth_/, ""));
    }
  }
  if (u.password_enabled === true) methods.add("password");
  return methods.size ? [...methods].sort().join("+") : null;
}
```

`signInMethodOf` (`clerk.ts:233-237`) is replaced by this; the Slack signup
ping (`slackpipes.ts:75,89`) renders the composite as-is (`via
github+password` reads fine; when null the ping omits the fragment exactly as
it does today for a null `signInMethod`). `fetchClerkUser`'s parsed shape
gains `password_enabled?: boolean`, per-entry `verification`, **and
`updated_at`** — it returns `clerkUpdatedAt` parsed from the payload's
`u.updated_at`, the value every write binds (round-3 finding 1: this column
holds Clerk versions ONLY; no locally sampled time may ever enter it).

### 3.3 Write path A — first login (INSERT)

The provisioning INSERT (`clerk.ts:141`) gains
`signin_method, signin_method_updated_at`, bound to the parser output and
**the payload's `clerkUpdatedAt`** (same snapshot-version domain as every
other write to this column — never a local timestamp). Control-flow fact (round-1 finding 3): a failed Clerk fetch
returns `verified:false` and `webSession` 403s BEFORE the INSERT — so every
row that exists was created from a successful fetch. The inserted value may
still be NULL only via the empty-credential case (§2). There is no
"insert-NULL-then-self-heal" path; first-login retry after a failed fetch is
simply another first login.

Concurrent first logins (`INSERT OR IGNORE`): whichever INSERT wins carries
its own fetch's snapshot; the losers' snapshots are discarded with their
INSERTs. Accepted — the snapshots are seconds apart and the refresh path
converges the value.

### 3.4 Write path B — returning login (refresh, zero extra calls)

Restructure the fetch result so credential data is independent of email
availability (round-1 finding 4 — today `fetchClerkPrimaryEmail` discards the
whole user unless a verified primary email exists):

- `fetchClerkPrimaryEmail` (`notify.ts:269`) → returns a real discriminated
  union (round-2 finding 3):
  `ok { address, signinMethod, clerkUpdatedAt }`
  `| absent { signinMethod, clerkUpdatedAt }`
  `| error {}`
  where `signinMethod: string | null` comes from the shared parser and
  `clerkUpdatedAt` is the payload's `updated_at`, present on every successful
  fetch (`ok` AND `absent`); `error` carries nothing. The existing `address`
  field name and the `ownerEmail` projection (`notify.ts:250-255`) are
  unchanged — the security-notification path does not move.
- **The method UPDATE is a separate statement from the email write.**
  `cacheOwnerEmail` keeps its exact semantics (writes on `ok` only); the new
  method write executes on `ok` OR `absent`. The email cache's behavior is
  byte-for-byte today's.
- **Refresh-due rule**: run the fetch when `email_updated_at` is stale per
  the existing `EMAIL_REFRESH_MS` window **OR
  `signin_method_updated_at IS NULL`** (backfill kicker — fires only for
  never-observed rows; round-2 finding 1: keying on `signin_method IS NULL`
  would re-fetch observed-empty users on every login forever).
- **Conditional write (stale-writer guard)**: the UPDATE sets
  `signin_method = ?, signin_method_updated_at = ?` only
  `WHERE signin_method_updated_at IS NULL OR signin_method_updated_at < ?`
  (the new `clerkUpdatedAt`). Because the guard is Clerk's own version, not a
  local clock, a request that read an older Clerk state loses regardless of
  response-completion order (round-2 finding 2). Equal versions skip the
  write — same snapshot derives the same composite, so there is nothing to
  win.
- A successful fetch whose credential set is empty writes NULL (with its
  `clerkUpdatedAt`) — a *deleted* last credential must clear the display
  rather than pin the stale value (endorsed, round-2 finding 4). `error`
  results write nothing (stale > wrong).

Staleness, stated honestly: the value updates on the first login after
`EMAIL_REFRESH_MS` (24h) elapses, or immediately when never observed
(`signin_method_updated_at IS NULL` — NOT when the value is an
observed-empty NULL); a credential
change right after a refresh can therefore be stale for up to ~24h of
continued logins, and indefinitely if the user never logs in again. Fine for
display/forensics; anyone needing push-fresh data needs the webhook non-goal
(§4).

### 3.5 Read path — account status → CLI + web

- `accountStatus` (`apps/api/src/account-link.ts:372`): SELECT gains
  `signin_method`; response JSON gains `signInMethod: string | null`.
- CLI (`src/cli/account-cmd.ts`) — ALL propagation points (round-1 finding 8):
  the `AccountStatus` interface (`:33`); `fetchAccountSummary`'s destructure +
  reconstruction (`:51-64`); the `formatAccountSummary` renderer (`:76-88`);
  `accountStatus`'s second destructure, its human renderer (`:114-116`), and
  its JSON DTO — where the key must be **conditionally constructed** (spread
  or if-set), because `JSON.stringify` serializes an explicit `null` and the
  contract is key-omitted-when-unknown. Both human renderers print
  `sign-in: <value>` only when non-null. Old-server responses (field absent)
  must behave identically to null.
- Web (`apps/web/src/lib/api.ts:162-166` type; the settings store at
  `src/routes/settings/+page.svelte:55-61`; the account section render at
  `:104-143`): one display row, hidden when null/absent.
- Acknowledged alternative for the web row (round-1 finding 11): the settings
  page already holds the live Clerk frontend user and could derive a fresher
  display client-side. Rejected for v1: one source of truth (D1) keeps CLI,
  web, and Slack telling the same story, and the D1 value is the thing
  support will read. Revisit if the 24h skew ever misleads someone.

## 4. Non-goals

- **Not a "which method was used to sign in" record.** Clerk's user object
  cannot answer that; it would need sign-in-attempt/session-event data (a
  webhook design). The column name stays `signin_method` (per the original
  ask) but every rendered label says `sign-in:` over the attached-credentials
  value; the doc comment in the migration states the semantics.
- **No Clerk webhook.** The repo has no svix handling (only Stripe at
  `worker.ts:218`); a new public route + signature scheme to shrink a ≤24h
  display-staleness window is disproportionate.
- **No custom JWT claims.** The session JWT carries only `sub` for us
  (`verifyClerkJWT`, `clerk.ts:59-101`); a Clerk JWT template would be
  dashboard config, stale-at-mint, and redundant given two existing fetches.
- **No enforcement.** Nothing may branch on the column.
- **No per-method history / no modeling of passkeys, phone, enterprise SSO.**
  Unknown credential shapes render as their prefix-stripped provider name or
  fall into the NULL case; modeling them is future work if the instance ever
  enables them.

## 5. Failure modes and invariants

- **I1 — never blocks auth.** Every write lives inside an existing
  best-effort path; every consumer tolerates NULL/absent. `CLERK_SECRET_KEY`
  unset (`env.ts:102-103`, optional) ⇒ provisioning already fail-closes;
  refresh no-ops; column stays NULL.
- **I2 — no new fetch call sites, no steady-state traffic increase.** Both
  writes piggyback the two existing fetches. One honest exception (round-3
  finding 3, precision from round-4 finding 1): the backfill kicker
  ACCELERATES fetches for never-observed rows
  (`signin_method_updated_at IS NULL`) — requests the old email-throttle
  would have deferred — until the row becomes observed; a Clerk `error`
  writes nothing and the row retries on a later login. Bounds, stated
  precisely: attempt count is bounded by login frequency during a Clerk
  outage (the exposure the email refresh already has); redundant successful
  fetches AND redundant successful writes under overlapping concurrent
  logins are each bounded by request concurrency (an older-version write
  then a newer-version write both pass the monotone guard). The guarantee
  is convergence (I5): the final stored observation carries the greatest
  Clerk version observed; once ANY write lands, the backfill kicker is off
  for that row. Observed rows, including observed-empty, throttle normally.
- **I3 — additive rollout.** Old readers ignore the column; the SELECT change
  ships with the code that reads it. Prod ordering safe by pipeline (§3.1);
  dev ordering is operator-sequenced (migrate → deploy).
- **I4 — deterministic value.** Same Clerk state ⇒ same string (dedup + sort).
  Consumers may compare equality; none may parse-and-branch.
- **I5 — monotone in Clerk's version.** The stored value's `clerkUpdatedAt`
  never decreases, so a writer holding an older Clerk snapshot loses
  regardless of local timing. Residual limit: two distinct Clerk states
  sharing one `updated_at` value (sub-resolution flapping) are
  indistinguishable — accepted for display metadata.

## 6. Validation (dev-flow step 4)

1. **Unit (apps/api vitest)** — parser fixture matrix (round-1 finding 9;
   the existing `slackpipes.test.ts` fixtures are formatter-only and the
   worker fixture (`worker.test.ts:569-577`) carries no external accounts, so
   new fixtures are required): verified google; verified github + password;
   password-only; OAuth-only (`password_enabled:false`); unverified /
   `failed` / `expired` / `transferable` external accounts excluded (all four
   named statuses; round-2 finding 5); duplicate providers dedup; unknown
   provider passthrough; empty set → null. Write paths: provisioning INSERT
   captures the composite; refresh updates it when due (email-stale OR
   never-observed); **second login after an observed-empty refresh does NOT
   re-fetch** (kicker keyed on version, not value; round-2 finding 1);
   refresh with `absent` email still writes the method; `error` writes
   nothing; deleted-last-credential writes NULL; stale-writer UPDATE loses
   (older `clerkUpdatedAt`); equal-version UPDATE skips. Read paths: `accountStatus`
   returns the field; CLI renders/omits correctly for value / null / absent
   (old server), and the `--json` DTO omits the key when unknown.
2. **Live dev gate** — in order: apply dev migration
   (`cd apps/api && npx wrangler d1 migrations apply rbox-dev-db --remote`),
   deploy dev worker (`cd apps/api && npx wrangler deploy`), log into the dev
   dashboard (dev Clerk `cosmic-phoenix-51`), then
   `RBOX_API=… rbox account status` shows the dev identity's real credential
   set; toggle a credential in dev Clerk and confirm the ≤24h/NULL-kicker
   refresh rules.
3. **Prod self-check after merge** — next dashboard login backfills the
   founder row (NULL kicker fires regardless of email-cache freshness);
   `rbox account status` on a fleet host shows it.

## 7. Size

~9-10 files, ~90-120 LOC + test fixtures (v2 estimate; grew from v1 with the
shared parser module, the refresh restructure, and the conditional write):
migration (new), `clerk-signin.ts` (new), `clerk.ts`, `notify.ts`,
`account-link.ts`, `slackpipes.ts` (type only), `src/cli/account-cmd.ts`,
`apps/web/src/lib/api.ts`, `apps/web/src/routes/settings/+page.svelte`,
tests.
