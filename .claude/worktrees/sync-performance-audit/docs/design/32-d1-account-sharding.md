# §32 — D1 account sharding (a routing seam, deployable at N=1 today)

**Status:** 🟢 PHASE 0 SHIPPED (2026-06-30, `6baa9a57`) — the `dbFor(env,
accountId)` / `dirDb(env)` routing seam is live at N=1 in
`apps/api/src/db.ts`; all call sites route through it (the one remaining
raw-binding ref, `diagnostics.ts:354`, is the metrics span-wrap clone, not a
bypass). Header verified against code 2026-07-10. **Phases 1+ (real shard
provisioning, the accounts split, data moves, cutover) remain UNBUILT**, and
the gating founder decision (split vs placement-constraint) remains open.
Shard tripwires recorded in docs/STATUS.md (D1 >2-3GB, recurring hot-path
429s, cron budget alarms). Original v4 header follows. v4 closes the last codex round
(NEEDS-WORK): the projection fail-closed guard must be **in-batch aborting** (FK / `BEFORE
INSERT ON blob_refs` trigger, like `accounts_cap_guard`), never a post-commit `changes===0`
check that fires after the grant already committed (§5); and `account_notify_prefs` is removed
from the §6a reclaim *blocker* enumeration — it is a settings artifact *cleaned* on reclaim,
not a blocker (`account-link.ts:294`), so it lives only in the teardown. Establishes the
`dbFor(accountId)`
indirection so that *future* sharding is **config + an opt-in data-move, never a code
rewrite**. Ships at N=1 (one shard = today's single D1) as a pure, behavior-preserving
refactor. v3 fully specifies the §5 `accounts` split that a codex round (NEEDS-WORK: 1
BLOCKER + 3 MAJORs) found underspecified: (1) **projection lifecycle is fail-closed** — every
account-creating path makes both the `dirDb` identity row and an idempotent shard accounting
projection, and `commitAccounting` aborts without granting if the projection is missing (§5);
(2) the split **boundary keeps cap math + retention shard-local** by placing `plan`,
`extra_storage_bytes`, `grace_until` on the projection alongside `used_bytes`/`cap_bytes` +
triggers, so `cap_bytes` derives from **both** plan and add-on storage as a local trigger and
retention's `workspaces×accounts` join stays on one shard (§5, §6c); (3) the reclaim two-DB
read is **fully enumerated** by plane, including the directory-plane *blocker* counts, not just
identity (§6a). v2 had already fixed the Phase-3 cutover (router freeze, not a DO lock — §7)
and the reclaim-cross-plane overclaim, and pinned the **no-cross-account-workspace-sharing**
invariant that makes `blobs` colocation sound (§4). The split vs. placement-constraint choice
remains the gating founder decision.

## Problem

Every byte of control-plane state lives in **one** D1 database. The binding is literally
named `rbox_dev_db` in *both* environments — dev (`apps/api/wrangler.jsonc:5-11`) and prod,
where the production env re-uses the same binding name pointing at `rbox-prod-db`
(`apps/api/wrangler.jsonc:66-72`), surfaced to code as `Env.rbox_dev_db: D1Database`
(`apps/api/src/env.ts:27`). The codebase reaches that one binding **across 15 files —
~156 lines, 157 `rg -o` occurrences** (one line names it twice):

| file | refs | file | refs |
|------|------|------|------|
| `account-link.ts` | 28 | `billing.ts` | 9 |
| `auth.ts` | 22 | `workspace-sync.ts` | 6 |
| `keys.ts` | 19 | `clerk.ts` | 6 |
| `notify.ts` | 17 | `authz.ts` | 6 |
| `stripe.ts` | 15 | `retention.ts` | 2 |
| `blobs.ts` | 12 | `metrics.ts` | 2 |
| `versions.ts` | 10 | `worker.ts` / `env.ts` | 1 / 1 |

D1 is SQLite hosted inside a single Durable Object: **one writer, single-threaded per
database**. The hot write path — commit accounting's atomic `db.batch()` that catalogs
`blobs`, charges `accounts.used_bytes` under the cap-guard trigger, and grants `blob_refs`
(`apps/api/src/commit-accounting.ts:116-167`) — plus the per-request auth read +
`last_seen_at` write (`apps/api/src/auth.ts:54-65`) **all serialize on that one database**.
Under concurrent multi-account load it is the shared ceiling. Everything else scales
horizontally: the `WorkspaceSync` DO is per-(workspace, project)
(`apps/api/src/workspace-sync.ts:122`), R2 is content-addressed, Workers are stateless. **D1
does not.** This is the lesson Dropbox learned sharding MySQL: partition the metadata by
account before the single instance melts, not after.

## Root cause

The work is *already* account-partitioned in its access pattern — almost every query is
`WHERE account_id = ?` — but the **transport is hardwired**. `env.rbox_dev_db` (and its
span-wrapped twin `op.env.rbox_dev_db`, produced by the metrics Proxy at
`apps/api/src/metrics.ts:170-172`) is referenced inline at every one of those sites. There
is **no seam** at which a request could be routed to a different database. So even though the data
model shards cleanly, the code cannot — adding a second D1 today means touching 156 call
sites by hand and re-reasoning every atomic `batch()`.

The fix is one indirection introduced *before* it is needed, validated at N=1 where it is a
no-op, so the eventual split is operational (provision a DB, move some rows) rather than a
refactor under load.

## Design

### 1. The routing seam: `dbFor(env, accountId)`

Introduce a single function — the only place that ever names a D1 binding:

```
// shard.ts (new)
export function dbFor(env: Env, accountId: string): D1Database { ... }   // account-data plane
export function dirDb(env: Env): D1Database { ... }                       // directory plane (§3)
```

At **N=1**, `dbFor` returns the one binding (renamed conceptually `SHARD_0`, physically
still `rbox_dev_db`) and `dirDb` returns the same database. **Zero behavior change.** The
refactor is mechanical: every `env.rbox_dev_db` / `op.env.rbox_dev_db` becomes
`dbFor(env, accountId)` (or `dirDb(env)` for the handful of directory reads, §3). The
metrics span still wraps whatever `dbFor` returns — `startOp` clones the env and replaces
the binding (`metrics.ts:170-172`); we keep that, applying the span to the *resolved* shard
so per-op telemetry is unchanged.

**Blast radius:** ~156 sites / 15 files. The overwhelming majority already have `accountId`
or `p.accountId` in lexical scope (they are account-scoped queries — `keys.ts`,
`billing.ts`, `blobs.ts`, `authz.ts`, the commit path). The exceptions are exactly the
**directory plane** below: reads that resolve a *credential* to an account and therefore
cannot know the shard yet.

### 2. Two planes: what shards, what is directory

A blunt "shard everything by account" is impossible because some tables are queried by a key
that *is not* the account id — they exist to **find** the account. Enumerating from the
migrations (`apps/api/migrations/*.sql`):

**Account-data plane — shards cleanly by `account_id` (the hot plane):**

| table | account key | migration |
|-------|-------------|-----------|
| `blob_refs` | `(account_id, sha256)` PK | `0006:144` |
| `accounts.used_bytes` / `cap_bytes` + guard trigger | `id` | `0007:175`, `0014:469-506` |
| `workspaces` | `account_id` col | `0006:163` |
| `uploads` / `upload_parts` | `account_id` col / via `uploads` | `0006:165`, `0003` |
| `device_auth` | `account_id` col | `0006:167` |
| `account_keys`, `device_keys`, `workspace_keys`, `rosters`, `account_key_states` | `account_id` | `0011` |
| `device_notifications`, `notification_deliveries`, `account_notify_prefs` | `account_id` / via token | `0016_device_notifications` |
| `audit_log` | `account_id` (nullable) | `0006:150` |
| `commits` | via `workspaces.account_id` join | `0011:278` |
| `blobs`, `gc_candidates` | **no `account_id`** → owned by committing account (§4) | `0001`, `0005` |

**Directory plane — queried by a credential, *before* the account/shard is known:**

| table | lookup key | call site |
|-------|-----------|-----------|
| `devices` | `token_hash` | `authenticate` (`auth.ts:54-61`) |
| `pairing_tokens` | `token_hash` | `redeemPairToken` (`auth.ts:266`) |
| `clerk_users` | `clerk_user_id` | web session / link (`account-link.ts:49,148`; `clerk.ts`) |
| `account_link_codes` | `poll_key` / `code_hash` | link ceremony (`account-link.ts:84,107,145`) |
| `account_link_events` | append-only log | `account-link.ts:216,330` |
| `stripe_events` | event id; account via `stripe_customer_id` | `stripe.ts` |

The directory plane is **read-heavy, write-light**: `authenticate` is one indexed `SELECT`
by `token_hash` plus a best-effort `last_seen_at` UPDATE already wrapped in `.catch()`
(`auth.ts:65`). It carries none of the O(blobs) write volume that saturates D1 — that all
lives in the account-data plane. So the strategy is:

> **Shard the account-data plane by `account_id`. Keep the directory plane on a single
> `dirDb` (today the same physical D1). `authenticate` reads `dirDb` → resolves
> `p.accountId` → every subsequent query routes through `dbFor(env, p.accountId)`.**

This removes the ceiling where it actually is (commit accounting), and leaves the light
directory reads on one small DB — itself splittable far later by credential-hash if it ever
becomes hot (§ Residual).

### 3. Routing function: HRW default + explicit override map + freeze-on-reshard

`accountId` is an opaque 64-bit random token, `acct_${randomHex(8)}`
(`apps/api/src/auth.ts:322`; also minted in `account-link.ts:314`, `unlinkAccount`). Two
candidate routers:

- **Explicit map only** (`account_id → shard_id` row, looked up per request). Total control,
  but a lookup on every request and a write at every account creation.
- **Consistent / rendezvous (HRW) hashing only** — `shard = argmax_s H(accountId ‖ s)` over
  live shards. No per-account state; deterministic. But adding a shard reshuffles ~`1/N` of
  *all* accounts with no per-account control — catastrophic when the thing you are trying to
  relieve is *one hot whale account*.

**Chosen: HRW for default placement, an explicit override map for exceptions, and
freeze-on-reshard.**

- `dbFor` resolves: `override = shard_assignments[accountId]; return shards[override ?? HRW(accountId, liveShards)]`.
- `shard_assignments` is a small **directory-plane** table (`account_id` PK → `shard_id`),
  authoritative when present. A brand-new account needs **no** write — HRW gives it a
  deterministic home for free.
- **Freeze-on-reshard:** the moment a shard is added, snapshot every *existing* account's
  current HRW home into `shard_assignments` (one bulk insert). Now existing accounts are
  pinned and **never move implicitly**; only *new* accounts HRW into the wider ring. Adding
  capacity is then pure config — no data moves until you choose to move a specific account.
- Migrating a chosen account (a whale) = copy its account-scoped rows + flip its one map row
  (§7), a deliberate, bounded, per-account data-move.

This is the "config + opt-in data-move, not a rewrite" property the milestone demands: HRW
keeps placement stateless at the margin; the map makes every *existing* placement explicit
and individually movable; freezing makes a topology change non-disruptive by construction.

At **N=1**, `liveShards = [SHARD_0]` and the map is empty → every account resolves to
`SHARD_0`. `dbFor` is a constant function. Nothing to test in prod but "it still points at
the one DB."

### 4. `blobs` / `gc_candidates` have no `account_id` — and don't need one

`blobs` is keyed solely by `sha256` (`0001_init.sql:7`), `gc_candidates` by `sha256`
(`0005_gc.sql:110`). On the surface that looks cross-account: many accounts could reference
one sha. **Convergent encryption makes that impossible across accounts.** Blob content is
AES-256-GCM under a key+nonce derived in one HKDF from `(workspace KEK, plaintextSha)` with
constant AAD `rbox/blob/v1` (`src/engine/crypto.ts:25,44-46`). The KEK is per-(workspace,
keyEpoch), wrapped under the **per-account Master Key**
(`src/engine/crypto.ts:16-17`; `workspace_keys`/`account_keys` are account-scoped,
`keys.ts:178-196`). Therefore:

> Two different accounts encrypting *identical plaintext* produce *different* ciphertext →
> **different `encSha`**. The `sha256` stored in `blobs` is `encSha`, so it is
> **account-unique**: every `blobs` row has exactly **one** owning account.

**Load-bearing invariant — no cross-account workspace sharing (v1).** This holds *only*
because a workspace belongs to exactly one account: `workspaces.account_id` is a single
owner (`0006:163`), authz refuses any non-owner (`authz.ts:35` `owner !== p.accountId →
404`), and the KEK is wrapped under that one account's MK (`kekWrapCtx(accountId, …)`,
`src/engine/e2ee/session.ts:144`). There is **no** schema for a workspace shared across
accounts (the `team` plan is many *users* in one account, not many accounts on one
workspace). **If cross-account workspace sharing is ever introduced**, two accounts could
share a KEK → a shared `encSha` → a `blobs` row with two owners, and the colocation in §4/§5
breaks. This invariant must be defended (or this design revisited) before any such feature.

Consequences:

- **`blobs`/`gc_candidates` colocate cleanly on the owning account's shard.** No
  `account_id` column is *required* — the partition is implicit via colocation. The commit
  path already catalogs `blobs` in the *same* per-account `db.batch()` as the `blob_refs`
  grant and `used_bytes` charge (`commit-accounting.ts:123-148`), so routing that batch
  through `dbFor(accountId)` lands `blobs` on the right shard automatically.
- **Cross-account dedup was never real**, so sharding `blobs` by account costs nothing:
  `blob_refs` is already per-account (`0006:144`) and `used_bytes` charges each account the
  full size on first reference (`billing.ts:39-59`) — identical plaintext in two accounts is
  two ciphertexts, two charges, today. Sharding changes none of the storage economics.
- **The charge statement forces colocation.** The charge is
  `UPDATE accounts SET used_bytes = used_bytes + (… WHERE NOT EXISTS (SELECT 1 FROM blob_refs …)) WHERE id=?`
  inside one batch (`commit-accounting.ts:131-145`), and the cap guard is a trigger on
  `accounts.used_bytes` (`0014:500-506`). For that batch to stay atomic and for the guard to
  fire, **`accounts`(accounting columns), `blob_refs`, and `blobs` must be on the same
  shard.** They naturally are, since all three route by the same `accountId`. This is a hard
  invariant the router must preserve.

**Open question (founder):** add a nullable `account_id` to `blobs`/`gc_candidates` *anyway*
for explicitness — making per-shard GC and any cross-shard audit trivially account-scoped,
backfillable from the single `blob_refs` owner? Recommended yes (additive, cheap), but it is
a schema change worth an explicit decision (§ Open questions).

### 5. The `accounts` table is split-brained — the crux decision

`accounts` carries **two unrelated concerns** in one row, pulling in opposite directions:
accounting **must** colocate with `blob_refs` on the account shard (§4); pure identity
**wants** to be on the directory plane so the cross-account link rebind stays single-DB.

**Recommendation: split `accounts` into an identity row (`dirDb`) and an accounting
projection (shard) — with the split boundary drawn so the cap math and the retention window
stay shard-local** (this is what dissolves the cap-derivation and retention cross-plane
hazards below):

- **Shard accounting projection** `(account_id PK, used_bytes, cap_bytes, plan,
  extra_storage_bytes, grace_until)` **+ all three triggers** `accounts_cap_guard` /
  `accounts_cap_sync` / `accounts_cap_on_insert` (`0014:469-506`,
  `0016_cap_bytes_insert_materialize`). `cap_bytes` is derived from **both** `plan` *and*
  `extra_storage_bytes` (`0014:470-496` — `extra_storage_bytes + CASE plan …`), so **both
  inputs live on the projection** and the cap stays a **local trigger** — no app-layer cap
  math, no guard skew. `grace_until` is consulted *with* `plan` by retention (`retention.ts:37,49`),
  so it lives here too, keeping the retention window shard-local (§6c).
- **`dirDb` identity row** `(id PK, name, origin, reclaimed_at, stripe_customer_id,
  stripe_subscription_id)` + the `clerk_users` linkage. Pure identity/billing-linkage, never
  on the commit hot path.

**Billing becomes a rare cross-plane saga.** `adminSetPlan` / the Stripe webhook
(`billing.ts:96-113`, `stripe.ts`) write `{plan, extra_storage_bytes, grace_until}` to the
**shard projection** (its triggers materialize `cap_bytes` locally) and `{stripe ids}` to the
`dirDb` identity row. Rare (billing events, not commits) and idempotent.

**Projection lifecycle — fail-closed (closes the creation/charge gap).** Every account-creating
path must create **both** rows: bootstrap (`auth.ts:322`) and `unlinkAccount`'s new shell
(`account-link.ts:320`) become a small saga — `dirDb` identity insert **and** an idempotent
`INSERT OR IGNORE` of the shard projection (the `accounts_cap_on_insert` trigger materializes
`cap_bytes` on the shard, excluding `'default'`). **`commitAccounting` must fail closed if the
projection is missing:** today the charge `UPDATE accounts … WHERE id=?`
(`commit-accounting.ts:131`) cannot affect zero rows because the row always exists; after the
split a missing projection would silently update zero rows **and still grant `blob_refs`** in
the *same already-committing batch* (`commit-accounting.ts:142`) — an unaccounted, unguarded
reference. **A post-batch `changes===0` check is insufficient** — it detects the miss only
*after* `db.batch()` has committed the grant, which cannot then be rolled back. The guard must
be **in-batch and aborting**, exactly like `accounts_cap_guard` (`0014:500-506`): the cleanest
mechanism is a foreign key `blob_refs.account_id → accounts_accounting(account_id)` (so the
grant INSERT itself fails and aborts the whole transaction when the projection is absent), or
an equivalent `BEFORE INSERT ON blob_refs` trigger that `RAISE(ABORT)`s on a missing
projection. Either way the missing projection rolls back catalog+charge+grant together and the
commit 500s without leaving a reference. This is a hard requirement of the split, not an
optimization.

Until the split ships, `accounts` stays whole on the account shard and the link ceremony /
plan change run as cross-plane sagas (§6). The split is the single most important schema
decision here and is flagged for the founder.

### 6. Cross-shard operations that break, and how they're handled

**(a) account-link confirm / unlink — the sharp edge.** `confirmLink` does *one* atomic
`env.rbox_dev_db.batch([...])` (`account-link.ts:210-238`) that rebinds `clerk_users`
origin→X, stamps `account_link_codes`, appends `account_link_events`, and — on shell reclaim
— mutates the **origin** account's `accounts/memberships/users/devices/account_notify_prefs`
(`account-link.ts:219-231`). The rebind inherently spans **two accounts** (origin and target
X). If origin and X live on different shards, a single `batch()` cannot be atomic across them
(D1 `batch()` is one-DB-only). `unlinkAccount` similarly creates a *new* account + rebinds in
one batch (`account-link.ts:316-331`).

Handling (relies on §2 + §5). Split the operation into its **atomic, user-visible** part and
its **best-effort teardown**, because the reclaim genuinely reads/writes the origin shell's
*data* shard and therefore **cannot** be one `dirDb` batch:

- **The rebind is the atomic commit, on `dirDb`.** The single user-visible mutation is
  `clerk_users` origin→X plus stamping `account_link_codes`/`account_link_events`; with the §5
  split, the `accounts` *identity* row and `memberships`/`users`/`devices` for the web shell
  are also directory rows. This stays one atomic `dirDb` batch — the moment after which "C
  manages X" is true and durable.
- **The reclaim *decision* is a two-database read, not a single statement.** Today
  `loadShellState` gathers everything in **one** SQL statement (`account-link.ts:257-283`);
  across planes that statement is impossible, and its inputs straddle **both** databases — so
  it must become **two point reads** (`dirDb` + the shell's one shard), combined by
  `judgeReclaimable` (`account-link.ts:289-297`) unchanged. Enumerated by plane:
  - **from `dirDb`** — identity columns (`origin`, `stripe_customer_id`,
    `stripe_subscription_id`, `reclaimed_at`) **and** the directory-plane *blockers*: durable
    `devices` count (`account-link.ts:269`), active `pairing_tokens` (`:273`), `clerk_users`
    count (`:277`), `memberships` owner count (`:278`);
  - **from `dbFor(shellAccountId)`** — the accounting projection (`used_bytes`, `plan`,
    `extra_storage_bytes`, `grace_until`, `cap_bytes`, per §5) **and** the data-plane blocker
    counts: `account_keys`, `device_keys`, `rosters`, `account_key_states`, `workspace_keys`,
    `workspaces`, `blob_refs`, `uploads`, `device_auth`, `device_notifications`, `commits`
    (via the `workspaces` join). These are exactly the keys `judgeReclaimable` tests
    (`account-link.ts:294`).

  Both are single-DB point reads (the shell is one account → one shard), not scatter-reads. The
  earlier "identity from dirDb + data counts from dbFor(shell)" was right in shape but
  under-enumerated: the directory plane carries *blocker* counts too, not just identity. Note
  `account_notify_prefs` is **not** a reclaim blocker — it is a settings artifact *cleaned* on
  reclaim (`account-link.ts:226-230`), so it appears only in the teardown bullet above, never in
  this decision read.
- **The shell teardown is a guarded, idempotent follow-up — and some of it lands on the data
  shard.** The cleanup DELETEs include `account_notify_prefs` (`account-link.ts:230`), an
  account-data-plane table that lives on the shell's shard, so the teardown is **not** a pure
  `dirDb` write. This is safe to do *after* the rebind because a reclaimable shell is *provably
  empty of data-bearing state* (`judgeReclaimable` required zero `blob_refs`/`workspaces`/keys)
  and every teardown statement is already conditioned on the `orphan` NOT-EXISTS predicate
  (`account-link.ts:206,222-231`) — so running it as a separate per-shard batch (or letting a
  sweep reclaim it) strands nothing and double-applies harmlessly.

The billing re-point (`repointBillingToAccount`, `account-link.ts:184`) already crosses the
Stripe/D1 boundary non-transactionally and is unchanged. **Net:** the link is atomic where it
*matters* (the directory rebind), and the shell GC is a best-effort cross-plane teardown — not
the false "one `dirDb` batch does everything" the v1 draft implied. **Open question:** if the
founder rejects the `accounts` split (§5), the fallback is a *placement constraint* — pin a
linkable target's shard equal to the origin's, so the two accounts in any link are always
co-resident, collapsing the whole ceremony back to one shard — at the cost of constraining
whale-migration of linked accounts.

**(b) global GC — coupled, deferred to §33.** `computeReachable` enumerates **all**
`workspaces` (`versions.ts:14`), asks every DO for roots, and marks/purges the **single**
`blobs` table + R2 bucket (`versions.ts:33-85`); the purge decrements each owner via
`releaseUsage` per `blob_refs` row (`versions.ts:74-75`). Under sharding this becomes a
**per-shard fan-out**: each shard enumerates its own `workspaces` → its DOs → its `blobs`,
and `releaseUsage` runs on the shard owning that `blob_refs`/`accounts` row (satisfied by §4
colocation). R2 objects stay in one content-addressed bucket keyed by the account-unique
`encSha` — not moved, deleted by key as today. The **mechanics** of per-shard reachability
(and the existing cron note that destructive GC runs only while no push is active,
`worker.ts:69-73`) are deferred to **§33**; §32 only guarantees the colocation that makes
per-shard GC *possible* (blobs + blob_refs + accounts on one shard).

**(c) retention prune — shard-local *because of the §5 boundary*.** `retentionPrune` joins
`workspaces × accounts` reading only `a.plan` and `a.grace_until` (`retention.ts:35-40,49,53`),
then `commits` for the floor (`retention.ts:61`). This is shard-local **only** because §5 places
`plan` and `grace_until` on the **shard accounting projection** (not the `dirDb` identity row) —
had they stayed on identity, this join would be cross-plane. With the §5 boundary, `workspaces`,
the projection's `plan`/`grace_until`, and `commits` all colocate, so retention runs per shard
and the daily cron (`worker.ts:69`) fans out across `liveShards`. (If the founder rejects the
split and keeps `accounts` whole on the shard, retention is trivially shard-local too.)

**(d) the platform `default` account.** `devices.account_id` defaults to `'default'`
(`0004:77`); that account's `cap_bytes=0` deliberately disables the guard
(`0014:498-499`, `0016:534` exclude `id='default'`). It is a singleton — **pin it in
`shard_assignments` to `SHARD_0`** (or to `dirDb`), explicitly, so it never hashes elsewhere.

**(e) admin / platform endpoints** (gated by `RBOX_PLATFORM_SECRET`, `authz.ts:66`).
`adminSetPlan` takes the target `accountId` in the path (`worker.ts:161-163`) → route
identity write to `dirDb`, cap propagation to `dbFor(accountId)` (§5 saga). `gc` / `retention`
(`worker.ts:151-158`) → fan out over `liveShards`. The Stripe webhook → `stripe_events`
idempotency + `stripe_customer_id → account` index on `dirDb` (`stripe_customer_id` is an
identity column), then `dbFor(account)` for any shard write.

**(f) the new-device notify fan-out** (`notify.ts`) reads `device_notifications` (account-data
plane, on the account's shard) and resolves recipients (`recipient_clerk_id` → email) via
`clerk_users` on `dirDb` — a bounded two-plane read per event, consistent with §2. The outbox
row is written in the same per-account batch as the `devices` insert (`0016_device_notifications`),
so it stays on the account shard with the credential it describes.

### 7. Cloudflare limits & a no-downtime split path

**Platform limits (verify exact figures at `/d1/platform/limits/` before multi-shard):**

- **Per-database storage cap ≈ 10 GB (Workers Paid; 500 MB Free).** This is a *hard* reason a
  single D1 must eventually split **regardless of throughput** — the `debug-d1` error
  catalog's "Exceeded maximum DB size → shard your data into multiple databases" is the
  explicit guidance. Convergent ciphertext metadata (`blobs` rows, `blob_refs`) grows with
  total stored content, so a popular single account or many accounts will reach this.
- **Throughput / single writer.** D1 is single-threaded SQLite; the overload errors "D1 DB is
  overloaded. Requests queued for too long / Too many requests queued" (debug-d1 catalog) are
  the concurrency ceiling. Under concurrent multi-account commit load this bites **before**
  the storage cap — it is the real reason to shard.
- **Databases per account ≈ 50,000 (Paid).** Ample shard headroom.
- **Bound databases per Worker.** Statically binding thousands of D1s is impractical (Worker
  metadata + config sprawl; Worker size cap 10 MB, env-var/binding limits in the platform
  limits table). Beyond a handful of static shard bindings, `dbFor` resolves databases
  **dynamically** — via the D1 Sessions / HTTP binding or a Workers-for-Platforms dispatch
  namespace — so the binding count is **not** a wall. `dbFor` is precisely the seam that
  hides static-vs-dynamic resolution from all 156 call sites. (Confirm the documented
  "max bound databases per Worker" number before relying on static bindings past ~a dozen.)
- **Subrequests.** Each shard query is still one subrequest; sharding does **not** change a
  *single* account-commit's per-invocation subrequest budget (that is §30's concern) — it
  removes *cross-account* serialization. A commit only ever touches one account's shard.

**No-downtime migration path (single D1 → N):**

- **Phase 0 (ship now, N=1):** land `dbFor`/`dirDb` returning the one binding. Pure
  behavior-preserving refactor of all 156 sites. The *only* change that must ship today.
- **Phase 1 (still N=1):** add `shard_assignments` + HRW with `liveShards=[SHARD_0]`. Routing
  is exercised in prod with one shard; all accounts resolve to `SHARD_0`.
- **Phase 2 (add SHARD_1, no data move):** provision + bind shard 1; **freeze** — snapshot
  every existing account's HRW home into `shard_assignments` (all → `SHARD_0`); add `SHARD_1`
  to `liveShards` so *new* accounts hash into `{0,1}`. No existing data moves. No downtime.
- **Phase 3 (rebalance a chosen account):** per-account live migration — metadata only (R2
  objects are content-addressed and never moved):
  1. set `shard_assignments[A] = 'migrating'` and enable dual-read for A (read new shard, fall
     back to old);
  2. **freeze A's writes at the router, not at a DO.** Note the `WorkspaceSync` DO is
     per-(workspace, project) (`workspace-sync.ts:122`), so account A has *many* DOs — there is
     **no** single DO that locks the account. The write freeze is therefore a **router gate**:
     while `shard_assignments[A]='migrating'`, the account-mutating endpoints (commit,
     `blobPut`, `multipart*`, `keys/*`, billing) check that state for A and return `503
     Retry-After` (a short, client-retryable stall — `rbox push` already retries). This gate is
     the cutover lock, replacing the false "the DO is the per-account lock" of earlier drafts;
  3. copy A's account-scoped rows old→new (bounded, `WHERE account_id = A` SELECT/INSERT) while
     frozen; the per-workspace `transactionSync` sequencer (`workspace-sync.ts:333`) still makes
     each workspace's commit log internally consistent, but DO storage is *not* part of the D1
     move — only A's D1 metadata copies;
  4. flip `shard_assignments[A] = SHARD_1`, lift the freeze, drop old rows. Because writes were
     gated off for A across the copy+flip, no commit can straddle the move — every post-freeze
     commit lands wholly on `SHARD_1`.

  The freeze duration is bounded by A's metadata size (typically small — `blob_refs` rows, not
  blob bytes); a very large account can be migrated with a copy-then-replay-delta variant to
  shrink the freeze window, but the router gate remains the cutover point.

## Residual risk / limits

- **The directory plane becomes the new single-DB ceiling.** It carries `authenticate`'s
  per-request read (`auth.ts:54`) + the `last_seen_at` write (`auth.ts:65`). Far lighter than
  commit accounting, but still O(requests). Mitigations, in order: (1) cache `token_hash →
  {accountId, role, shard}` in KV or a DO so `authenticate` skips D1 on the hot path; (2) make
  `last_seen_at` sampled/async (it is already best-effort `.catch()`); (3) if it *still*
  saturates, split `dirDb` by credential-hash with a second HRW — a later, independent
  problem, because directory writes are not O(blobs).
- **The `accounts` identity/accounting split (§5)** is the load-bearing schema change. Until
  it lands, link + plan changes are cross-plane sagas and the `accounts` row stays on the
  account shard (so the link placement-constraint fallback in §6a applies).
- **GC / retention per-shard mechanics are deferred to §33.** §32 only locks the colocation
  invariant (blobs + blob_refs + accounts on one shard) that makes them tractable.
- **Cross-plane skew windows** (plan→cap_bytes propagation) are bounded and self-correcting —
  the next commit re-reads the materialized `cap_bytes` under the guard.

## Test + rollout plan

- **Unit (router):** `dbFor(accountId)` is stable across calls for a given id; HRW
  freeze-snapshot keeps every pre-existing id on its old shard after a shard is added; an
  explicit override beats HRW; `'default'` is pinned to `SHARD_0`; the colocation invariant
  holds — `blob_refs`, the `accounts` accounting projection, and `blobs` for one account
  always resolve to the same `D1Database`.
- **Phase-0 golden (behavior-preserving):** with `liveShards=[SHARD_0]`, every former
  `env.rbox_dev_db` site routes through `dbFor`/`dirDb` and hits the *same* DB; the existing
  `apps/api/test/worker.test.ts` suite stays green (diff behavior main vs. seam = none).
- **Migration integration (two local D1s):** push to account A on `SHARD_0`; run the Phase-3
  copy+cutover to `SHARD_1`; pull on a second host → byte-identical; a commit issued while
  `shard_assignments[A]='migrating'` gets a `503 Retry-After` (router freeze) and, on retry
  after the flip, lands wholly on `SHARD_1` — never split across shards.
- **Reclaim cross-plane read (§6a):** `loadShellState` split into a `dirDb` read (identity +
  directory-plane blocker counts) + a `dbFor(shell)` read (projection + data-plane blocker
  counts) reproduces the *exact* `judgeReclaimable` verdict the single-DB query gives today
  (same accept/reject on the §21 fixtures); the shell teardown is idempotent under the `orphan`
  predicate when replayed.
- **Projection lifecycle fail-closed (§5):** with the projection absent, the `blob_refs` grant
  INSERT aborts the whole `db.batch()` (FK / `BEFORE INSERT` trigger), so catalog+charge+grant
  roll back together and the commit 500s with **zero** `blob_refs` written — asserting the
  rollback, not a post-commit `changes===0` detection; bootstrap/unlink create both rows
  idempotently, and `accounts_cap_on_insert` materializes `cap_bytes` on the shard (excluding
  `'default'`).
- **Cross-shard link:** a link whose origin and target would hash to different shards still
  confirms/​unlinks atomically on `dirDb` (post-split), or is correctly blocked/co-located
  under the placement-constraint fallback.
- **Empirical:** deploy Phase 0 to **dev** (assert no behavior/latency change vs. main), then
  Phase 2 with a synthetic `SHARD_1`; route a test account there and confirm isolation —
  saturating `SHARD_1` does not slow a concurrent commit on `SHARD_0` (the whole point).

## Open questions for the founder

1. **`accounts` identity/accounting split (§5)** — adopt the split (identity on `dirDb`,
   `used_bytes`/`cap_bytes`+guard on the shard), or keep `accounts` whole on the shard and use
   the link **placement-constraint** fallback (§6a)? This is the gating schema decision.
2. **`account_id` on `blobs`/`gc_candidates` (§4)** — add the explicit column (recommended,
   cheap, additive) or keep the partition implicit-by-colocation?
3. **Shard-count strategy & when to actually shard** — what trigger pulls Phase 2? (a D1
   storage-% threshold, a sustained overload-error rate, or a per-account write-QPS whale
   signal from §25 telemetry?) Phases 0–1 are safe to ship now regardless.
4. **Cross-shard account-link** — confirm the directory-plane approach (§6a), or accept the
   placement constraint (linked accounts co-resident, limiting whale-migration of linked
   accounts)?
5. **Directory-plane scaling horizon** — is the auth-read/`last_seen` load on a single `dirDb`
   acceptable indefinitely with the KV cache (§ Residual), or should the token→account cache
   be in scope for the first sharding milestone?
</content>
</invoke>

---

## Founder decisions (2026-06-30) — spec is now decision-complete

- **accounts modeling:** **placement-constraint fallback** (NOT the identity/accounting split). Keep the `accounts` row whole on its shard; linked accounts are forced co-resident. Simpler; accepts limited whale-migration of linked accounts. §5's split is shelved.
- **`account_id` on `blobs`/`gc_candidates`:** **ADD** the explicit nullable column (cheap, backfillable from the single `blob_refs` owner). Don't rely on implicit-by-colocation.
- **When to shard:** triggered by D1 storage-% approaching the ~10 GB/DB cap OR a sustained overload-error signal from §25 telemetry. Phases 0–1 ship regardless of trigger.
- **Cross-shard account-link:** the placement constraint (co-residence) handles it — no directory-plane cross-shard resolution needed in v1.
- **Directory-plane KV cache:** deferred to the first actual sharding milestone (not Phase 0).
- **BUILD NOW:** **Phase 0 only** — the `dbFor(env, accountId)` / `dirDb(env)` seam at N=1 (behavior-preserving). HRW routing + multi-shard provisioning wait for the shard trigger.
