# 37 — Self-serve account + data deletion (GDPR/CCPA right-to-erasure)

Status: design — **codex-reviewed (two REWORK rounds addressed)**. Round 1 (8 findings, 1
CRITICAL): §4f routes orphaned canonical blobs through the existing reachability-GC instead of
a racy inline R2 delete (CRITICAL); §4g fixed `/purge` path (slash-`projectId` wedge); §5a
mint-path liveness guards + fail-closed `authenticate()`; §4h/§4i ledger-retention posture +
`audit_log.target` purge; §7 owner-token lease CAS + no-queue SLA; §6 the real HTTP-retry
idempotency contract. Round 2 (2 findings): §4f the staging cleanup is now fail-closed on the
MPU **abort** as well as the delete (a transient abort no longer drops the D1 handle); and the
GC reclamation §4f depends on is made **slash-safe** — `gcPurge`/`computeReachable` and
`retentionPrune` now address the DO via fixed `/roots`/`/prune` paths (ws/proj in the query),
so condemned blobs are actually reclaimed even when a slash-`project_id` workspace exists.
Implements `DELETE /v1/account` (owner-only) + a dashboard "Danger zone". Lets an account owner
irreversibly erase their account and all associated data without a support ticket.

## 1. Goals / non-goals

- **Goal:** an owner can delete their account end-to-end: every D1 row keyed to the
  account, every R2 object the account uniquely owns, the Stripe subscription, and the
  Clerk user(s). Idempotent, confirmation-gated, owner-only.
- **Non-goal:** partial deletion (single device/workspace — those already exist:
  revoke, GC), data export, multi-owner "majority vote", or admin-initiated deletion.
- **Non-goal:** a self-serve *undo* UI. A short grace window exists for operational
  recovery (support can clear the tombstone), but no user-facing restore endpoint ships
  here.

## 2. The Worker constraint (why this is async)

The `fetch` handler has **no `ExecutionContext` / no `ctx.waitUntil`** (see
`worker.ts` — handlers take `(req, env)` only). A request handler must finish its work
before it returns; there is no fire-and-forget. A full purge can touch **thousands of
R2 objects** (one `delete` subrequest each) and easily blow the per-invocation
subrequest/CPU budget. So the purge **cannot run inline** in the DELETE handler.

We reuse the **durable-outbox → queue → consumer → cron-backstop** shape already proven
by the new-device-email path (`notify.ts`, design 16 §2.4):

- The **source of truth** is a durable D1 row (`account_deletions`), never a queue
  message. "If the account is tombstoned, its deletion row exists" (written in the same
  atomic batch as the tombstone).
- A **cron backstop** (`scheduled()`, the existing daily 04:00 trigger) drives every
  past-grace deletion forward in bounded chunks, and is the only thing that *starts* a
  purge (so nothing runs before the grace window elapses).
- An **optional queue** (`ACCOUNT_DELETE_Q`, mirrors the optional `DEVICE_NOTIFY_Q`)
  provides *prompt continuation* for a large drain: each consumer pass does a bounded
  chunk and re-enqueues itself until done. Absent the queue (local/dev/tests), the cron
  backstop drains it — slower but identical and correct.

This is strictly better than inline and avoids inventing a new primitive.

## 3. Decision: soft-delete (tombstone) + grace, then irreversible hard-purge

`DELETE /v1/account` does **not** erase data synchronously. It **tombstones**:

1. Stamp `accounts.deleted_at = now`.
2. **Revoke every device** in the account (`devices.revoked = 1`) — durable CLI tokens
   *and* live web sessions. Access dies the instant the call returns.
3. Write the durable `account_deletions` row with `purge_after = now + GRACE`.

All three in **one atomic D1 batch**, so the tombstone and its work-ledger are
coextensive. The account is **inaccessible immediately** (defense-in-depth: `authenticate()`
also rejects any token whose account is tombstoned — see §6), but the irreversible
**hard-purge runs only after `purge_after`**, driven by cron/queue.

**Why grace (not immediate hard-delete)?**

- **Accidental / hostile deletion recovery.** The caller may be an ephemeral *web
  session* (allowed for the owner). A stolen ~1h web token shouldn't be able to
  *irreversibly* nuke an account with no recovery path. Tombstone-now/erase-later means
  the destructive part is reversible by support during the window, while the account is
  already locked from the attacker's perspective.
- **It costs nothing on the erasure clock.** GDPR/CCPA require erasure within a
  *reasonable* period (commonly read as ≤30 days); a short grace (default **7 days**,
  `DELETION_GRACE_MS`) is well inside that. The data at rest is E2EE ciphertext the
  server can't read, so "present but tombstoned" leaks nothing.
- **It matches the platform.** Mirrors GitHub/Google "scheduled deletion".

`GRACE` is a constant; set it to `0` to hard-purge on the next cron tick if a
jurisdiction ever demands immediate erasure.

## 4. The authoritative purge enumeration

Enumerated from `apps/api/migrations/*.sql` and cross-checked against
`account-link.ts::loadShellState` (which already exhaustively enumerates account-scoped
state for the reclaim predicate). **Every table below is accounted for.**

### 4a. D1 — keyed directly by `account_id` (DELETE … WHERE account_id = ?)

| Table | Migration | Notes |
|---|---|---|
| `accounts` (`id`) | 0006 | the account row itself — deleted **last** |
| `users` | 0006 | |
| `memberships` | 0006 | |
| `blob_refs` | 0006 | drives the dedup-safe R2 purge (§4d) — processed first |
| `blob_ref_candidates` | 0017 (§33) | per-account Phase-1 GC prune markers — account-scoped, so erased too (else orphan markers referencing removed refs) |
| `account_keys` | 0011 | E2EE recovery wrap |
| `device_keys` | 0011 | per-device key material |
| `workspace_keys` | 0011 | per-(workspace,epoch) KEK wraps |
| `rosters` | 0011 | signed roster history |
| `account_key_states` | 0011 | signed key-state chain |
| `devices` | 0004/0006/0010 | all (durable + web) |
| `device_auth` | 0004/0006 | in-flight device-authorization (account_id nullable) |
| `pairing_tokens` | 0008 | |
| `uploads` | 0003/0006 | in-flight MPUs — staging keys aborted/deleted in R2 (§4d) |
| `workspaces` | 0005/0006 | enumerate `(workspace_id, project_id)` first (§4c, §4e) |
| `clerk_users` | 0010/0016 | enumerate `clerk_user_id`(s) first (§5) |
| `device_notifications` | 0016 | enumerate `token_hash`(es) first (§4b) |
| `account_notify_prefs` | 0016 | |
| `audit_log` | 0006 | **erasure choice:** deleted (carries actor_user/device) |

### 4b. D1 — joined via `device_notifications.token_hash`

| Table | Migration | Predicate |
|---|---|---|
| `notification_deliveries` | 0016 | `token_hash IN (account's device_notifications)` |

### 4c. D1 — joined via `workspaces` (no `account_id` column of their own)

| Table | Migration | Predicate |
|---|---|---|
| `commits` | 0011 | `(workspace_id, project_id)` ∈ account's workspaces |
| `manifests` | 0001 | same (legacy/pre-E2EE; empty for E2EE workspaces, deleted anyway) |

### 4d. D1 — joined via `uploads.upload_id`

| Table | Migration | Predicate |
|---|---|---|
| `upload_parts` | 0002/0003 | `upload_id IN (account's uploads)` |

### 4e. D1 — keyed by the deleted Clerk identity / account (account-linking)

| Table | Migration | Predicate | Note |
|---|---|---|---|
| `account_link_codes` | 0014 | `clerk_user_id = <deleted sub>` OR `origin_account`/`pending_account = <acct>` | erasure choice: deleted |
| `account_link_events` | 0014 | `clerk_user_id = <deleted sub>` OR `from_account`/`to_account = <acct>` | forensic log — **deleted** for full erasure (documented tradeoff) |

### 4f. R2 (`rbox_dev_blobs` / `rbox_prod_blobs`)

- **Canonical blobs** `blobs/sha256/<aa>/<sha>` (`util.ts::blobKey`). Content-addressed
  and **deduplicated across accounts** via `blob_refs`. Account deletion **drops this
  account's `blob_refs` entitlements**, then for each sha now referenced by **no** account
  it **CONDEMNS** the sha to the existing reachability-GC pipeline (`INSERT OR IGNORE INTO
  gc_candidates (sha, 'blob', now)`) — it does **NOT** inline-delete the canonical R2
  object or the `blobs` row.
  - **Why not inline-delete (the CRITICAL fix).** R2 has no conditional delete. A bespoke
    "blob_refs gone → `NOT EXISTS` → delete R2 + `blobs`" sequence is **racy across
    tenants**: another live account B can be mid-upload of the same sha — the receipt PUT
    path writes the canonical R2 object **first, with no D1 ref** (`blobs.ts`), and the
    later commit inserts `blobs`/`blob_refs` **without re-checking R2**
    (`commit-accounting.ts`). So B can end up with `blob_refs` + `blobs.present=1` pointing
    at an object this purge just deleted. The per-account-E2EE intuition does **not** make
    this safe — the server accepts arbitrary client-supplied shas, so cross-tenant safety
    cannot rely on client crypto.
  - **Routing through `gc_candidates` is race-safe by construction.** `versions.ts::gcPurge`
    re-derives the reachable set from authoritative DO roots and **un-condemns** anything
    reachable; `blobPut`/`commitAccounting` `DELETE gc_candidates` on (re-)reference. So if B
    re-references the sha, it is resurrected before any deletion — account deletion can never
    erase a blob a live account is mid-referencing. We **inherit** the existing pipeline's
    race posture rather than **widening** it with a second, unprotected delete path. Residual
    posture (explicit): canonical R2 reclamation is **deferred** to the GC sweep (which the
    platform already runs quiescently, off-cron); the bytes are E2EE ciphertext, reclaimed on
    the next sweep — well within a reasonable erasure window.
  - **§33 interop.** §33 split GC into Phase 1 (per-account entitlement prune, marks
    `blob_ref_candidates` + `gc_candidates` via `perAccountReachable`) and Phase 2 (the
    manual/quiescent canonical R2 sweep, `worker.ts /v1/admin/gc` → `versions.ts::gcPurge`, now
    recomputing reachability via `reachableFromWorkspaces`). Account deletion condemns to
    **`gc_candidates`** (Phase-2 canonical), which is exactly right: removing the account's
    `blob_refs` is what makes its shas globally-unreferenced, and Phase 2 re-checks reachability
    before any R2 delete. The Phase-1 **`blob_ref_candidates` barrier** (the `NOT EXISTS` in the
    commit preflight that re-satisfies on re-grant) is **moot** for a deleted account — no commit
    can run against a tombstoned account — but its rows are account-scoped, so §4a still erases
    them; we drop them in `finishD1` together with `blob_refs`, leaving no marker dangling on a
    removed ref.
  - **The GC reclamation this depends on must itself be slash-safe** (or the condemned blobs
    leak forever). `gcPurge`→`computeReachable` and `retentionPrune` previously addressed each
    DO via a **positional** `…/proj/:proj/roots`/`…/prune` path built from the D1 `project_id`.
    For a `project_id` containing `/`, that mis-parses → 404 → `gcMark`/`gcPurge` abort
    **fail-closed** and collect **no** candidates, so any condemned canonical blob is **never**
    reclaimed whenever *any* slash-project workspace exists. Both now use the DO's **fixed**
    `/roots` / `/prune` paths with `ws`/`proj` in the **query** (still bootstrap-seeded),
    matching the `/purge` fix (§4g). Audited every server-initiated DO call (`purge`, `roots`,
    `prune`) — all fixed consistently. (The client-forwarded sync paths are unchanged: the
    client owns its own path encoding.)
- **Staging keys** `staging/<sha>/<uuid>` from in-flight `uploads.staging_key`: `purgeUpload`
  aborts the MPU **and** deletes the staged object. Per-upload-unique (UUID), unambiguously
  this account's. **Fail-closed on BOTH operations:** the `uploads`/`upload_parts` D1 rows are
  dropped **only after** R2 confirms *both* the MPU abort and the staging delete succeeded (an
  already-gone MPU — `NoSuchUpload`/already-completed — counts as abort success; only a genuine
  R2 5xx/transient error fails). A failure on **either** keeps the rows and forces a `progress`
  retry — never delete the pointer before the pointee, else a transient *abort* error strands
  uploaded MPU parts in R2 (until their TTL) with no retry handle.
- **No used_bytes reconciliation needed:** the account's row (and its counter) is deleted;
  surviving accounts' `used_bytes` already counts only blobs they reference.

### 4g. Durable Objects (`WorkspaceSync`)

Each `(workspace, project)` has a DO holding the **authoritative** commit log + head
(D1 `commits` is only a mirror). For real erasure the DO gains a `purge` action that
calls `ctx.storage.deleteAll()`, driven per enumerated workspace before the D1 mirror
rows are dropped.

- **Fixed `/purge` path (no wedge).** The purge request targets the DO by
  `idFromName(ws/proj)` (the canonical key commit uses) and posts the **constant** path
  `/purge` — **not** `…/ws/:ws/proj/:proj/purge`. `createWorkspace` accepts an arbitrary
  client `projectId`; embedding it in a positionally-parsed path lets a `projectId`
  containing `/` mis-parse the action segment → a 404 → the driver loops forever
  (`progress` with no progress). A fixed path can't mis-parse for **any** `projectId`, and
  `deleteAll` needs no ws/proj. The DO matches `/purge` **before** bootstrap/seed and before
  any positional parsing.

### 4h. External

- **Stripe:** if `stripe_subscription_id` set, `DELETE /v1/subscriptions/{id}` (cancel
  now); then `DELETE /v1/customers/{id}` to erase the customer's PII at Stripe. Both
  idempotent (tolerate `resource_missing`/404). A late `customer.subscription.deleted`
  webhook then matches no account row → no-op.
- **Clerk:** for each mapped `clerk_user_id`, `DELETE https://api.clerk.com/v1/users/{id}`
  (idempotent, tolerate 404). Erases the identity + signs them out everywhere.

> **Platform audit rows (`audit_log`).** Most audit rows carry `account_id` and are purged
> by `WHERE account_id = ?`. But platform actions (`billing.ts::adminSetPlan`) write rows
> with `account_id = NULL` and the account id encoded in `target` (`<acct>` or
> `<acct>:<plan>`). The purge therefore also deletes `audit_log WHERE account_id = ? OR
> target = ? OR target LIKE '<acct>:%'`, so no account-identifying audit row survives.

### 4i. Intentionally retained

- `stripe_events` — global webhook-idempotency ledger keyed by Stripe `evt_…`; holds no
  account PII (id, type, timestamp). Deleting it could resurrect a since-processed
  webhook on redelivery. Kept by design.
- `account_deletions` (the deletion ledger itself) — **retained as a minimized
  proof-of-erasure / compliance record**: `{account_id, requested_at, purge_after, status,
  confirmed_with}` only. It stores **no** user PII — `account_id` is an internal pseudonym
  whose every linkage (the Clerk identity, email, all account data) has been erased by the
  time the row reads `done`, so it is effectively anonymized; `confirmed_with` is the
  *method* (`'email'`/`'account_id'`), never the typed value. This is the GDPR-permitted
  minimal record demonstrating the erasure happened and gating idempotent re-drives.
- `gc_candidates` rows for shas that remain shared (only orphaned shas are condemned in §4f).

## 5. Confirmation gate + owner-only authorization

- **Owner-only.** `p.role === 'owner'` AND a live `memberships(role='owner')` row for
  `p.userId` (re-checked, never the viewer-by-absence default). Any non-owner → **403**.
  A web session for the owner is accepted (added to the `webTokenAllowed` allowlist and
  CORS `DELETE`); a non-owner web session is rejected by the same role check.
- **Confirmation.** The request body must carry `confirm`, matching **either** the
  account owner's verified email (cached `clerk_users.email`) **or** the literal
  `accountId`. Compared after `trim().toLowerCase()` via constant-time equality. Email is
  the dashboard path; `accountId` is the always-available fallback for a pure-CLI account
  with no email on file. Mismatch → **400 `confirmation_mismatch`** (no tombstone).

## 5a. Tombstone liveness — mint-path guards (close the post-tombstone window)

The tombstone revokes every existing device, but a credential mint that *races* the
tombstone could otherwise create a fresh, usable device for a deleted account. Three layers
close this:

- **Pre-mint liveness read (fast-fail).** `redeemPairToken` (folded into its live-authority
  check), `pollDeviceAuth` (device-code claim, before the one-time claim), and `webSession`
  (returning web login on a deleted account → **403**) each read `accounts.deleted_at IS NULL`
  before minting, so a clearly-dead account fails early without burning a one-time token/claim.
- **The device INSERT is COUPLED to liveness (closes the TOCTOU).** A pre-read alone is racy —
  deletion could tombstone the account *between* the read and the insert, leaving an orphan
  `devices` row (no access bypass, since `authenticate()` re-checks, but it violates "no mint
  creates a device row for a tombstoned account"). So `prepareMintDevice` writes a **guarded
  `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL) OR
  ?='default'`** — it lands **0 rows** if the account was tombstoned, and the new-device
  notification outbox INSERT is guarded **identically** so device + notification stay coextensive
  (neither is written). `mintWithRetry` detects `changes==0` on the device insert and throws
  `AccountGoneError`; the three public mint routes catch it and return a clean account-deleted
  error (no `devices` row written). `bootstrap` mints into the account it just created (live), so
  it's unaffected; the `'default'` legacy account is the sole bypass (matching `authenticate()`).
  *§32:* the `accounts` sub-select (account-data plane) co-batches with the `devices` insert
  (directory plane) — one binding at N=1, a cross-plane coupling under sharding (flagged in code).
- **`authenticate()` is fail-closed on a missing/tombstoned account.** A token is valid only
  if its `accounts` row **exists** and `deleted_at IS NULL` — **OR** the account is the legacy
  platform `'default'` (which may have no row). So a tombstoned account, *and* an orphan device
  whose account row is already gone (a redeem that beat the purge), reject every token. (Prior
  draft let a missing row pass — that's now closed.)

> **Overlap note.** This overlaps the device-auth credential-kind P0 another agent is doing;
> fixed here independently, to be reconciled at merge.

## 6. Idempotency

- **Concurrent double-submit (function level).** Two `DELETE`s that both authenticated before
  the tombstone landed: the first tombstones; the second hits `deleted_at != NULL` → **200**
  with the same `{status, purgeAfter}`, never re-stamping `deleted_at` (grace not extended) or
  re-revoking. Tombstone UPDATE is `… WHERE deleted_at IS NULL`; ledger INSERT is `INSERT OR
  IGNORE` on `account_id`.
- **Sequential HTTP retry (real contract).** A retried `DELETE` re-authenticates first, and
  because the tombstone revoked every device + `authenticate()` rejects the tombstoned account,
  it gets **401** — *acceptable idempotency*: no error, no second tombstone, no extended grace.
  The client (dashboard) signs out on the first 200, so it never retries in practice.
- **Purge.** Every step is `DELETE … WHERE account_id = ?` / condemn / R2 delete / external
  cancel — all no-ops on retry. The drain re-reads the ledger and resumes; partial progress is
  fine. `status` moves `pending → purging → done`; `done`/missing → no-op.

## 7. The drain (`driveAccountDeletion`) — bounded + re-entrant

For one `account_id` whose `purge_after <= now`:

1. Claim (leased with a per-driver **owner token**, so concurrent drains can't double-run
   *and* a stale driver can't clobber a fresh owner's lease): `UPDATE … SET status='purging',
   attempts=attempts+1, last_attempt_at=?, lease_token=<fresh uuid> WHERE account_id=? AND
   purge_after<=? AND (status='pending' OR last_attempt_at < ?-LEASE)`. `changes==0` → a fresh
   lease is held elsewhere (or not due / done) → **skip**. The lease is **released** only by a
   **CAS on `lease_token`** (`releaseAndProgress`), so a slow stale driver returning after its
   lease was legitimately stolen finds `changes==0` and leaves the new owner's lease intact.
2. **External, once-ish** (bounded): Stripe cancel+customer-delete, Clerk user delete.
   Idempotent; a transient failure → `blocked` (lease held, cron backs off and retries).
3. **Canonical-blob chunk** (`SHA_BATCH`): drop `blob_refs`, **condemn** now-orphaned shas to
   `gc_candidates` (§4f — no inline canonical R2 delete). Then the **uploads chunk**: MPU
   abort + staging delete, **fail-closed** (drop the D1 row only after R2 confirms). Anything
   left, or an R2 delete that must retry → `progress`.
4. **DO chunk**: POST the fixed `/purge` to each remaining workspace's DO (§4g), then drop its
   D1 mirror rows.
5. **D1 finish:** delete every §4a–4e table in one atomic batch (set-based), accounts row last,
   mark `status='done'`.

Subrequest budget: the canonical chunk is now **pure D1** (delete refs + condemn — no per-sha
R2 call), so `SHA_BATCH` can be large; the uploads/DO chunks bound their own R2/DO calls under
the 1000/invocation cap, with continuation for the rest.

**No-queue SLA.** With `ACCOUNT_DELETE_Q`, a large purge continues promptly across queue
messages (each `progress` re-enqueues). **Without** it, the daily cron resumes the durable
ledger up to `MAX_CHUNKS_PER_TICK` chunks per account per tick — correct and bounded, but a
multi-million-blob account erases over several daily ticks. The parent provisions the queue for
the prompt path; the cron fallback guarantees eventual completion regardless.

## 8. Dashboard (Danger zone)

`apps/web` settings page gains a **Danger zone → Delete account** section:
typed-confirmation (re-type email or account id) → `DELETE /v1/account` via the existing
authed client → on 200, show "scheduled for deletion", then **sign out** of Clerk and
redirect to `/`. Copy states it's irreversible after the grace window and lists what's
erased (devices, workspaces, files, billing, login).

## 9. Tests (business logic only)

1. **Purge enumeration + dedup safety:** seed an account with a row in *every* §4 table
   (incl. a platform `audit_log` row keyed only via `target`) + a blob shared with a second
   account + an A-only orphan blob + an in-flight upload. Run the drain. Assert every
   account-scoped row is gone (incl. the `target`-keyed audit row); the **orphan** sha is
   **condemned** to `gc_candidates` (R2 object still present — handed to the GC pipeline, not
   inline-deleted); the **shared** sha is **never condemned**, its R2 object survives; the
   staging object is deleted fail-closed; the **second account is wholly untouched**.
2. **Owner-gating:** non-owner (editor) `DELETE` → 403; data intact.
3. **Confirmation:** wrong `confirm` → 400, no tombstone; correct email/id → 200.
4. **Idempotency:** concurrent double-call → 200 twice (single tombstone, grace not
   extended); **retried HTTP `DELETE` → first 200, second 401** (tombstoned account no
   longer authenticable); double drain → no-op `skip`.
5. **Grace window:** before `purge_after`, the sweep purges **nothing** (data present) but
   the account is inaccessible (`authenticate` rejects); after `purge_after`, the hard purge runs.
6. **Slash `projectId` (no wedge):** `purgeWorkspaceDO` posts a fixed `/purge` path; a
   workspace whose `projectId` contains `/` drains to `done` without the driver looping.
7. **Lease CAS:** a fresh foreign `lease_token` blocks a concurrent claim and a stale driver
   cannot reset it.
8. **Upload fail-closed (finding A):** when `purgeUpload` fails the `uploads`/`upload_parts`
   handle is **kept** and the drive returns `progress` (not `done`); a successful retry then
   completes. `purgeUploadR2` returns `false` (and keeps the staging object) on an abort error,
   `true` after a real MPU abort + staging delete.
9. **Slash-safe GC addressing (finding B):** `gcPurge`/`computeReachable` and `retentionPrune`
   address the DO via a **fixed** `/roots` / `/prune` path with `ws`/`proj` in the query — a
   `project_id` containing `/` is carried intact, never split into path segments (so the sweep
   doesn't 404-abort and the condemned blobs are reclaimed).

No type-only assertions.
