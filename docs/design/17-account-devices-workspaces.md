# Design 17 — Account: devices & workspaces (read-only dashboard view)

> **Implementation: 🔴 NOT STARTED** — design complete & codex-reviewed (2026-06-29). Status index: [`README.md`](./README.md).

**Status:** DESIGN — codex adversarial review (2 rounds) absorbed; remaining FAILs
are scoped to upstream/dependent work and recorded in §9. Design only, no
implementation.
**Depends on:** 11 (web auth / Clerk → rbox token), 12 (full E2EE roster), 15
(SvelteKit dashboard).
**Feeds:** 19 (device/workspace revoke — this doc only stubs the tie-in and lists its
prerequisites; it does **not** design revoke).

## 0. Goal & scope

Give a signed-in dashboard user (`app.rbox.to`) a **read-only** list of:
1. their **devices** — the machines that hold a durable rbox device token, and
2. their **workspaces** — the per-account sync roots.

This is the surface where doc 19's **Revoke** button will eventually live. We render a
disabled placeholder; we do **not** design revocation here.

**Non-goals:** revocation, renaming/labeling from the web, roster mutation from the
web, team/seat management, per-workspace member lists, account linking/merge (§1.3a),
and the device-onboarding/pairing UX itself (we only point at it from an empty state).

## 1. Grounding — what already exists (do NOT invent a parallel model)

### 1.1 Devices (`devices` table — migrations 0004 + 0006 + 0010)
| column | meaning | exposed to web? |
|---|---|---|
| `token_hash` | `sha256(plaintext token)`, PK | **NEVER** |
| `device_id` | `dev_*` (CLI) / `web_*` (browser session) — **not UNIQUE** (§9.4) | yes |
| `label` | human label ("bootstrap", "web", "paired", …) | yes (capped, §2.4) |
| `account_id` | owning tenant | no (it's the scope) |
| `user_id` | owning user | no |
| `created_at` | epoch ms | yes |
| `last_seen_at` | throttled (≤ every 10 min) epoch ms | yes |
| `expires_at` | **NULL = durable** (CLI/pair/device-code); **non-NULL = ephemeral web session** (1h, design 11) | only as derived `kind` |
| `revoked` | 0/1 | filtered (`revoked=0` only) |

`GET /v1/auth/devices` (`listDevices`, `apps/api/src/auth.ts`) already returns
`{ devices: [{ device_id, label, created_at, last_seen_at, isSelf }] }` for
`revoked = 0 AND account_id = ?`. **It is consumed by the shipped CLI (`rbox device
list`, `src/cli/auth-cmd.ts`), which parses snake_case** — so we must NOT repurpose
or rename its shape (§2, §9.3). It also has three real defects (§3) we deliberately
do not inherit.

### 1.2 Workspaces (`workspaces` table — migrations 0005 + 0006)
A "workspace" is a **per-account sync root**, keyed by `(workspace_id, project_id)`:
- `workspace_id` — server-assigned high-entropy `ws_<uuid>` (`createWorkspace`,
  `apps/api/src/authz.ts`); ownership set at creation (NULL `account_id` ⇒ 404).
- `project_id` — **arbitrary client input**, part of the primary key, stored verbatim
  and unvalidated (defaults to `"root"`). It is identity, not cosmetic (§2.4, §9.5).
- `created_at` — epoch ms.
- **No human name/path column exists.** Under full E2EE (design 12) the server is
  zero-knowledge: the manifest, the folder path, and the display name live only
  client-side. The server knows only `ws_3f9c…/root` (§4.2).

Created via `POST /v1/workspaces` (quota-capped, `planLimitsFor`). Counted by
`countWorkspaces`. The D1 `commits` table (migration 0011) is a **best-effort**,
non-authoritative mirror (the WorkspaceSync DO is the source of truth) and maintains
**no per-workspace summary** — so deriving activity counts from it does not scale
(§2.2, §9.6).

### 1.3 Auth & CORS (design 11 + `worker.ts`)
- Browser holds a Clerk session → `POST /v1/web/session` mints a short-lived (~1h)
  rbox device token (a `web_*` row) → sent as `Bearer`. `authenticate()` resolves it
  to `Principal { deviceId, accountId, userId, role }`.
- `corsHeaders()` reflects only `CLERK_ALLOWED_ORIGINS` origins; allows
  `GET, POST, OPTIONS` + `authorization, content-type`. **GET is already allowed**, so
  the new GET endpoints need zero CORS change.
- `api.ts` (`apps/web/src/lib/api.ts`) is the typed client; `authed()` does the
  token-exchange + single 401-retry. New helpers slot in beside `fetchUsage`.

### 1.3a Account model & linking — WHICH account this list shows (read this first)
The list is scoped to **the caller's `Principal.accountId`** — i.e. the account the
**Clerk identity maps to** (`clerk_users`, design 11). **This is not automatically the
account that holds a user's CLI machines or workspaces**, and under full E2EE it
usually isn't:

- **E2EE genesis is CLI-first.** An account's crypto world (genesis roster, MK,
  workspaces) is created on a **CLI device** (`rbox` bootstrap/connect, design 12). A
  fresh device's pairing-token enrollment requires E2EE **admission material**
  (`mkWrap` + `admissionGrant`) that **only an already-enrolled device can mint**
  (`createPairToken` stores it verbatim; the CLI redeem path expects it,
  `src/cli/e2ee-client.ts`).
- **The web/Clerk account is, by itself, an empty shell.** `webSession` provisions a
  *fresh* Clerk-mapped account (`apps/api/src/clerk.ts`) with **no enrolled device, no
  MK, no genesis roster**. The browser has no signing key or MK, so **the dashboard
  cannot mint E2EE admission material and cannot bootstrap an account's crypto world.**

**Therefore this doc makes no claim about how devices get into the Clerk account.** It
renders whatever the principal's account contains. Two real situations:
- The Clerk identity already resolves (via an account-link/claim flow) to the user's
  real CLI-genesis account → the list shows their machines and workspaces.
- It doesn't → the account is empty and we show an honest empty state (§4) that points
  at onboarding, **not** at a dashboard-minted pairing token (which can't carry E2EE
  admission anyway).

**The bootstrap-account ↔ Clerk-account linking/merge flow is unsolved and OUT OF
SCOPE** (owned by onboarding). It is the top open question (§8.1) and the single
biggest caveat on this feature's usefulness.

### 1.4 E2EE roster (design 12) — the *other* notion of "device"
Two device identities exist and can diverge:
- **Token identity** (`devices` table): "can this machine call the API right now?"
  Server-authoritative, server-enumerable.
- **Crypto identity** (E2EE roster, `rosters` table): the signed, hash-chained
  principal set — "can this device sign commits / unwrap MK?" The roster blob is
  **opaque to the server** (stored verbatim, never parsed), so the server **cannot
  enumerate roster membership**. Only a client that verifies from genesis **and pins
  local state** knows who's authoritatively `active`.

**Decision (§6):** the list is sourced from the **`devices` table** (server-enumerable;
matches "machines with API access"). We do **not** return any server-computed
crypto/roster status — §6 explains why it would be both unreliable and not
authoritative. This divergence is the crux of doc 19 (§7).

## 2. Endpoints — NEW, web-facing, leaving the CLI endpoint untouched

We add **new** endpoints rather than repurpose `GET /v1/auth/devices`, because that
route's response shape is a shipped CLI contract (snake_case) and its query is
account-scoped but unfiltered/uncapped (§3). New endpoints let the web surface evolve
(camelCase, filtering, pagination, E2EE-aware copy) without a CLI regression.

### 2.1 `GET /v1/account/devices` (new)
**Auth:** existing authed path (Principal), account-scoped (`account_id = p.accountId`).
**CORS:** unchanged (GET already allowlisted).

**Query params:**
- `include` — `cli` (default) | `all`. Default returns **durable devices only**
  (`expires_at IS NULL`). `all` additionally returns **live** (unexpired) web sessions.
- `limit` — default 50, hard max 100.
- `cursor` — **opaque, integrity-protected** keyset cursor (§2.3).

**WHERE (pinned exactly — account scope must never be OR-escaped):**
```sql
-- include=cli (default):
WHERE revoked = 0 AND account_id = ? AND expires_at IS NULL
-- include=all:
WHERE revoked = 0 AND account_id = ? AND (expires_at IS NULL OR expires_at > ?)
```
The parentheses around the `expires_at` disjunction are **load-bearing**: without them
`AND` binds tighter than `OR`, yielding `account_id=? AND expires_at IS NULL OR
expires_at > now`, which returns **every account's** live web sessions (cross-tenant
leak). `include=all` never returns **expired** ephemeral rows (§3.1). Order
`created_at ASC, rowid ASC`; fetch `limit+1` to compute `nextCursor`.

**Response (camelCase; secrets excluded):**
```jsonc
{
  "devices": [
    {
      "deviceId": "dev_1a2b3c",
      "label": "brian's macbook",   // capped to 256 chars in the projection (§2.4)
      "kind": "cli",            // "cli" (expires_at NULL) | "web" (ephemeral session)
      "createdAt": 1719600000000,
      "lastSeenAt": 1719700000000,   // may be null
      "isCurrent": false         // device_id === caller's principal deviceId
    }
  ],
  "nextCursor": null             // or an opaque string
}
```
**Explicitly NOT in the response:** `token_hash`, `account_id`, `user_id`,
`expires_at` (raw), `sig_pubkey`, `enc_pubkey`, `mk_wrap`, recovery material, and **no
crypto/roster-status field** (§6). `kind` is the only projection of `expires_at`.

### 2.2 `GET /v1/account/workspaces` (new)
**Auth/CORS:** same authed + account-scoped pattern.
**Query params:** `limit` (default 50, max 100), `cursor` (opaque, §2.3).
**WHERE:** `account_id = ?`. Order `created_at ASC, rowid ASC`; fetch `limit+1`.

**Response (v1 — identity + creation only):**
```jsonc
{
  "workspaces": [
    {
      "workspaceId": "ws_3f9c…",
      "projectId": "root",       // verbatim (it's a PK component, never truncated, §2.4)
      "createdAt": 1719600000000
    }
  ],
  "nextCursor": null
}
```
**Activity (`lastActivityAt`, `commitCount`) is intentionally deferred (§9.6).** The
`commits` mirror is keyed `(workspace_id, project_id, sequence)` with no maintained
summary, so a page of busy workspaces would scan large commit ranges. The correct
implementation is a per-`(workspace_id, project_id)` summary row (`commit_count`,
`last_commit_at`) maintained on the commit write-path (`workspace-sync.ts`) — a
separate change, owned outside this doc. Until then v1 shows creation time only.

### 2.3 Pagination cursors — stable, unique, non-reversible
Naive `(created_at, device_id)` cursors are **not schema-unique** (`device_id` is not
UNIQUE, §9.4; the workspace key is a tuple). Resolution:
- **Order/tiebreak** on `(created_at, rowid)`. `rowid` is SQLite's implicit unique row
  id (both tables are rowid tables). It is legal in `ORDER BY`/`WHERE`
  (`(created_at, rowid) > (?, ?)`) — it is **not** placed in a `CREATE INDEX` column
  list (that errors `no such column: rowid`, §3.4). The covering index's entries carry
  rowid implicitly, so the keyset scan stays index-ordered.
- **The wire `cursor` is opaque and integrity-protected** — an HMAC-tagged
  (server-secret) encoding of `(created_at, rowid)`, validated server-side and rejected
  if tampered. It is therefore **not** a reversible global-row-order oracle, and
  `token_hash` is **never** part of it (it is the PK but is secret).

### 2.4 Input that flows back out — caps vs identity
- **`label`** is cosmetic and user-controlled but not consistently capped at ingest
  (`bootstrap` stores `body.label` unsliced, `auth.ts`; pairing slices to 200). The
  projection **caps `label` to 256 chars** defensively; the UI truncates with ellipsis.
- **`projectId` is identity (a PK component) and is returned VERBATIM** — never
  truncated in the API, since truncation could collapse two distinct workspaces and
  corrupt copy/open/future actions (§9.5). It is the user's **own** data echoed back
  (account is the scope ⇒ no cross-tenant leak). The Svelte UI renders it as
  **auto-escaped text** (no `{@html}`) and truncates **display only** while keeping the
  full value for copy. Capping `label`/`projectId` at **ingest** is the real fix and is
  flagged §8.4.

## 3. The existing `listDevices` defects we avoid by adding a new endpoint

### 3.1 Expired & accumulating web sessions
Every dashboard 401 re-mints a `web_*` row (design 11; never GC'd). `listDevices`
filters only `revoked = 0`, so it would list **every historical web session, including
expired ones**. The new endpoint defaults to `expires_at IS NULL`, and `include=all`
still excludes expired rows.

### 3.2 The current device may be a filtered-out web session
With the default filter, the caller's own `web_*` session is excluded, so `isCurrent`
is usually false. Intended: the dashboard renders a synthetic **"This browser
session"** chip from client state (§5); the list is "your machines," not "your tabs."

### 3.3 No caps / no pagination
`listDevices` is unbounded `SELECT … ORDER BY created_at`. The new endpoint uses
`limit+1` keyset pagination, hard max 100 (§2.3).

### 3.4 No supporting indexes (pagination without indexes is cosmetic)
`devices` has only `devices_device_id`; `workspaces` only its PK; `commits` is PK'd by
sequence, not activity time. The new access patterns need composite indexes or they
table-scan (and for web-only accounts a bare `(account_id, created_at)` index still
scans accumulated `web_*` rows because `expires_at IS NULL` would be only a residual
filter). **A new migration adds:**
- `CREATE INDEX idx_devices_account_exp_created ON devices (account_id, expires_at, created_at)`
  — `expires_at` as the 2nd column makes the `IS NULL` filter a seek, not a residual;
  `created_at` gives the keyset order; rowid is the implicit final tiebreak. (`rowid`
  is **not** named as a column.)
- `CREATE INDEX idx_workspaces_account_created ON workspaces (account_id, created_at)`.

## 4. Edge cases & empty states

### 4.1 Devices
- **Zero durable devices** (empty/shell account, or web-first user): empty list →
  copy that points at **onboarding** ("Connect this dashboard to your rbox account, or
  set up rbox on a machine with the CLI"), **not** `rbox login` and **not** a
  dashboard-minted pairing token — neither can establish the account's E2EE world from
  the browser (§1.3a). The exact linking affordance is owned by onboarding (§8.1).
- Once a CLI machine is in the account, it appears as a durable (`kind:"cli"`) row.

### 4.2 Workspaces
- **Zero workspaces:** "No workspaces yet — your first `rbox` sync creates one."
- Anonymous ids by default: render `projectId` prominently and `workspaceId` as a muted
  monospace id with copy-to-clipboard.
- **Opt-in name carve-out (design `workspace-names`, LOCKED).** A workspace MAY carry an
  optional plaintext `name` the SERVER stores and this dashboard renders — a *deliberate,
  consensual metadata trade* that is **opt-in / default-off**, set ONCE at create by the
  first host (`rbox init`, first-writer-wins; no web edit / no PATCH route). When a row has
  a name, render `name` and use a softer, truthful line ("name is visible to rbox; contents
  stay end-to-end encrypted"). Unnamed rows keep `projectId` **and the strong private claim**
  ("rbox can't see your folder names — names live only on your devices"). The privacy promise
  is therefore per-row: unconditional for unnamed workspaces, an explicit user-controlled
  carve-out for named ones. NEVER apply the strong claim to a named row — it would be false.

## 5. UI (SvelteKit + Svelte 5 runes, design 15)

**Placement:** extend `/dashboard` with two read-only sections **below** plan/usage:
**Devices** and **Workspaces**. (Split to `/dashboard/devices` later if the page grows
— §8.6.)

**Data loading:** add `fetchDevices(clerk)` and `fetchWorkspaces(clerk)` to
`apps/web/src/lib/api.ts`, each using the existing `authed()` (exchange + single
401-retry). Load in `onMount` alongside `fetchUsage`, each with its own `$state` +
independent error capture so one failing list doesn't blank the others.

```svelte
let devices = $state<Device[] | null>(null);
let devicesError = $state('');
// onMount: try { devices = (await fetchDevices(authState.clerk)).devices } catch …
```
- Device row: label (or `deviceId` if unlabeled, both auto-escaped), a `kind` badge
  (`cli`/`web`), relative `lastSeenAt` ("2h ago"), and a **disabled "Revoke" button**
  with `title="Coming soon"` (the doc-19 tie-in). No crypto/roster badge in v1 (§6).
- "This browser session" chip from client state, separate from the device list.
- Loading skeletons; per-section error line (reuse `errMsg`); `WEB_AUTH_NOT_ENABLED`
  handled like the usage section.
- Pagination v1: render the first page; if `nextCursor` present, a "Show more" button.
  No infinite scroll.

**CORS:** none needed — same origin allowlist, GET already permitted.

## 6. E2EE confirmation (metadata only)

- The endpoints return **only token-side metadata** (ids, labels, timestamps, the
  `kind` enum, the `isCurrent` boolean). No `mk_wrap`, `sig_pubkey`/`enc_pubkey`,
  recovery wrap, manifest, or plaintext. MK and plaintext are never in scope.
- **No server-computed `e2eeEnrolled`/roster-status field.** Two reasons, both fatal:
  1. *Unreliable.* `putDeviceKeys` accepts **any** `deviceId` from any authenticated
     account principal (it doesn't require the key row to be the caller's own token
     device), so "a `device_keys` row exists" doesn't prove the named device is
     enrolled. The badge would lie. (`device_keys.device_id` is also a global PK while
     `devices.device_id` is non-unique — the join isn't even well-defined, §9.4.)
  2. *Wrong source of truth.* Crypto authority is **roster-`active`** status, verified
     from genesis **against locally pinned state** (`verifyAccount`,
     `src/engine/e2ee/session.ts`). The server can't compute it (opaque roster), and
     the **web dashboard can't authoritatively compute it either** — it has no device
     secret and no trust pin, so at most it could do public signature verification
     (no rollback protection). Authoritative device status lives on enrolled CLI
     devices (`rbox key status`), not the browser. v1 therefore shows token status
     only and makes no crypto claim.
- The roster is authoritative for crypto membership but opaque server-side; the
  `devices` table is the right source for an API-access read-only view.

## 7. Tie-in for revoke (design 19) — referenced, NOT designed here

- The list rows are where doc 19 mounts the Revoke control (today: disabled stub).
- The token-level primitive exists: `POST /v1/auth/devices/:deviceId/revoke` flips
  `devices.revoked = 1` (account-scoped). **But it updates `WHERE device_id = ? AND
  account_id = ?`, so a same-account `device_id` collision (§9.4) would revoke multiple
  rows.** Doc 19 needs a stable, unique device-row identity first (§8/§9.4).
- **Critical E2EE asymmetry doc 19 must resolve:** a full eviction is two operations —
  (a) flip the token, AND (b) author a signed `roster vN+1` marking the device
  `revoked` + rotate the epoch/keys (design 12). The **web dashboard can do only (a)**:
  it has no MK and no device signing key. So a web-initiated revoke cuts API access but
  leaves crypto membership and the device's already-downloaded keys until an **enrolled
  CLI device** rotates the roster/epoch. Doc 19 decides whether web revoke is
  "token-only (with a 'finish eviction from a CLI device' nudge)" or is gated to
  enrolled devices.
- Self-revoke guard: never offer Revoke on `isCurrent`/"this browser"; doc 19 owns the
  exact rule.

## 8. Open questions for the human

1. **Account unification (the big one).** Under E2EE, the account's crypto world is
   CLI-genesis; the Clerk/web account is a separate shell with no enrolled device. Is a
   bootstrap→Clerk account-link/claim flow planned (onboarding's job)? Until it exists,
   this dashboard often shows an empty account (§1.3a). Should this page actively detect
   "you have a separate CLI account" and guide the link?
2. **Web revoke scope (doc 19):** token-only browser revoke (fast, leaves crypto
   membership until a CLI rotates) vs gating revoke to enrolled CLI devices? (§7)
3. **Ephemeral-session cleanup:** expired `web_*` rows accumulate forever. Add a GC
   sweep (cron, like blob GC) to delete `revoked=0 AND expires_at < now - grace`? The
   list hides them; it doesn't delete them.
4. **Ingest-side validation/caps for `label` and `projectId`:** this doc caps `label`
   defensively in the projection and returns `projectId` verbatim (it's identity). The
   real fix is capping/validating both at ingest (`bootstrap`, `createWorkspace`).
   Worth a small migration + handler change?
5. **Device-row identity prerequisite (doc 19):** widen the `dev_*`/`web_*` id space
   (some are only 32-bit random) and/or add `UNIQUE(account_id, device_id)` so revoke
   targets exactly one row (§9.4). Do this with doc 19 or pull it forward?
6. **Workspace activity:** ship the per-`(workspace_id, project_id)` summary counter
   (maintained on commit) so the dashboard can show `commitCount`/`lastActivityAt`, or
   leave v1 at creation-time only?
7. **Section vs route:** dashboard sections (v1 here) or a dedicated `/dashboard/devices`
   route from the start?

## 9. Codex adversarial review

Two foreground passes (`codex exec`, gpt-5.5, xhigh, no web search). Round 1
(VERDICT: FAIL — 5 BLOCKER/4 SHOULD-FIX) and round 2 (VERDICT: FAIL — 2 Fatal/4
High/1 Medium) on the revised draft. Round 2's "Fatal/High" items are genuine and are
resolved **in this final doc** below, except where the only honest resolution is to
scope the work to an upstream/dependent doc (explicitly recorded as such). No
secret/token leakage was found in the response shapes in either pass.

| # | Finding | Resolution |
|---|---|---|
| R2-1 | **Web-first pairing story not implementable** — the browser has no MK/signing key, so the dashboard can't mint a pairing token with E2EE admission material; the empty-state path was a dead end. | **Accepted; design changed.** §1.3a now states E2EE genesis is CLI-first and the Clerk account is an empty shell; this doc makes **no** claim about how devices enter the account. The empty state (§4.1) points at onboarding, not a dashboard-minted pairing token. Account linking is the top open question (§8.1). |
| R2-2 | **Invalid migration** — `CREATE INDEX … (…, rowid)` errors (`no such column: rowid`); a bare `(account_id, created_at)` index still scans `web_*` rows. | **Fixed (§3.4).** Index is `(account_id, expires_at, created_at)` (no `rowid` column); `rowid` is used only in `ORDER BY`/cursor predicate, where it's legal (§2.3). |
| R2-3 | **camelCase rename breaks the shipped CLI** that parses `device_id`/`last_seen_at`/`isSelf` from `GET /v1/auth/devices`. | **Fixed (§2).** We add **new** endpoints `GET /v1/account/devices|workspaces` and leave `/v1/auth/devices` (the CLI contract) untouched. |
| R2-4 | **`device_id` non-uniqueness poisons identity & revoke** — revoke updates by `device_id+account_id`, so a same-account collision revokes multiple rows; some ids are only 32-bit random. | **Acknowledged as a doc-19 prerequisite (§7, §8.5).** The read-only list is unaffected for display; revoke needs a unique device-row identity first (widen id space and/or `UNIQUE(account_id, device_id)`). Flagged, not silently built upon. |
| R2-5 | **Capping `projectId` in the projection corrupts identity** (it's a PK component). | **Fixed (§2.4).** `projectId` is returned **verbatim**; only `label` (cosmetic) is capped. UI truncates `projectId` for **display only**, keeping the full value for copy. |
| R2-6 | **Workspace activity aggregation not scale-safe** — `COUNT/MAX` over `commits` with no maintained summary; a page of busy workspaces scans large ranges. | **Fixed by deferral (§2.2, §8.6).** v1 returns creation time only. Activity needs a per-`(workspace_id, project_id)` summary maintained on the commit write-path — a separate change. |
| R2-7 | **"Client computes roster status later" overstated** — the web dashboard has no trust pin or device secret, so it can't be crypto-authoritative. | **Fixed (§6).** v1 makes **no** crypto claim; authoritative device status lives on enrolled CLI devices (`rbox key status`). The browser could at most do non-authoritative public signature verification. |
| R2-meta | Cursor metadata: reversible base64 rowid cursor discloses global row order. | **Fixed (§2.3).** Cursor is opaque + HMAC integrity-protected, not a reversible global-order oracle; `token_hash` is never encoded. |
| R1-3 | **SQL precedence** — `… AND expires_at IS NULL OR expires_at > now` leaks cross-account live web sessions. | **Fixed (§2.1).** WHERE pinned with explicit parentheses around the disjunction. |
| R1-1/-2 | Account-account mismatch + empty-state dead end. | Superseded/expanded by R2-1 (§1.3a, §4.1, §8.1). |

**Residual FAIL, accepted:** round 2 ends FAIL primarily on R2-1/R2-4 — both are
**upstream/dependent** concerns (account linking owned by onboarding; unique device
identity owned with doc 19), not defects in the read-only list this doc designs. They
are recorded as explicit prerequisites and open questions rather than hidden. The
read-only listing design itself (endpoints, scoping, secret exclusion, pagination,
indexes, E2EE metadata-only stance) is internally consistent and secret-safe.
