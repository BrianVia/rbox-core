# §57 — D1 → PlanetScale (break-glass control-plane migration)

**Status:** DRAFT v1 — design only, **contingency**. Nothing to build now. This is the
"if D1 stops being enough" escape hatch, written so that the decision — and the port —
is a known, scoped operation rather than a scramble under load. It is deliberately
positioned *against* [§32 (D1 account sharding)](./32-d1-account-sharding.md): both docs
answer the **same** trigger (the D1 storage cap / single-writer ceiling), and §32 is the
already-decision-complete, CF-native first answer. **§57 exists because there is exactly
one failure mode §32 cannot cover** (a single account whose own metadata exceeds one D1),
and because a managed multi-writer SQL engine is the lower-operational-burden path if
per-shard fan-out ever costs more to run than it saves. Read §32 first; this doc assumes
its vocabulary (`dbFor` / `dirDb`, the two planes, the account-data hot path).

## Problem

Every byte of control-plane state lives in **one** D1 database per environment — the
binding `rbox_dev_db` in both dev and prod (`apps/api/wrangler.jsonc:5-11`, `:89-95`),
surfaced as `Env.rbox_dev_db: D1Database` (`apps/api/src/env.ts:35`). D1 is SQLite in a
single Durable Object: **one writer, single-threaded per database**, with a **~10 GB
per-database storage cap** (Workers Paid — verify the current figure at
`/d1/platform/limits/` before relying on it). §32 already enumerated why this is a
ceiling: the hot write path (commit accounting's atomic `db.batch()` cataloging `blobs`,
charging `accounts.used_bytes` under the cap-guard trigger, and granting `blob_refs` —
`apps/api/src/commit-accounting.ts:110-186`) plus the per-request auth read
(`apps/api/src/auth/authenticate.ts:24-30`) **all serialize on that one database**, and
the convergent-ciphertext metadata (`blobs`, `blob_refs`) grows with total stored content
toward the storage cap.

§32's answer is to **shard D1 by `account_id`** — stay CF-native, add a router, move whales
between shards on demand. That is the right first move and it is decision-complete
(§32's founder-decisions block). **This doc is the second move**: replace D1 wholesale with
a single managed, horizontally-scalable SQL engine (PlanetScale) so the storage cap and the
single-writer ceiling both disappear *without* an app-level shard router — at the cost of a
non-CF dependency, network latency, and a one-time SQL-dialect + transaction-semantics port.

**The one thing only §57 can do.** §32 shards *by account*, so its partition grain is one
account. A single account whose own control-plane metadata (its `blob_refs`, `blobs`,
`commits`, key rows) exceeds one D1's storage cap **cannot be relieved by §32** — there is no
sub-account shard key in the app-level scheme. PlanetScale/Vitess shards *below* the account
grain transparently (or simply gives that account a far larger single primary), so it is the
only escape from a single-whale-over-cap. That, not raw throughput, is §57's unique
justification; everything else §32 also solves.

## What is (and isn't) "PlanetScale on Cloudflare"

Stated precisely, because the architecture turns on it: **PlanetScale is not a Cloudflare
product.** It is a managed database (Vitess-sharded MySQL, or the newer PlanetScale for
Postgres) running in an AWS/GCP region. "On Cloudflare" here means *accessed from our
Cloudflare Workers*, not *colocated inside Cloudflare*. The consequences that dominate this
design:

- **Every query becomes a cross-network call** from a globally-distributed Worker to a
  single-region database. D1 today is read-replicated and effectively colocated; the auth
  read (`authenticate.ts:24`) and the commit batch are cheap and egress-free. Against
  PlanetScale, a Worker far from the DB region pays real RTT **per round trip** — this is the
  single largest risk (§ Latency).
- **Two access paths from Workers:**
  1. **`@planetscale/database`** — the fetch-based serverless HTTP driver. No TCP, no
     `nodejs_compat`, works natively on Workers (our `compatibility_date` is
     `2026-06-23`; no flag change needed). Positional `?` placeholders — **which matches
     D1's `?` binding exactly** (all 229 `.prepare()` sites, below). This is the
     low-friction path and the one this doc assumes.
  2. **Hyperdrive + a TCP driver** (`cloudflare:sockets` → `mysql2`/`pg`). Adds
     Cloudflare-edge connection pooling and read-query caching in front of the external DB —
     attractive for latency, but needs `nodejs_compat` and a heavier driver. Fold in later
     as a latency mitigation, not for the initial port.

Everything else in the stack is **unaffected**: R2 (content-addressed blobs — never moved),
the `WorkspaceSync` DO (the authoritative commit log; D1's `commits` table is only a
best-effort mirror — `apps/api/migrations/0011_e2ee.sql`), Workers, Queues, the entire
E2EE/convergent-encryption model. **The blast radius is exactly the D1 tables and the code
that names the binding.**

## Design

### 1. Lean on §32's seam — swap the *implementation*, not the 229 call sites

§32 already did the expensive part: **every** binding access funnels through two functions
(`apps/api/src/db.ts:44-53`):

```
export function dbFor(env: Env, accountId: string): D1Database   // account-data plane
export function dirDb(env: Env): D1Database                        // directory plane
```

and the metrics layer clones `env` with a span-wrapped binding so timing is centralized
(`apps/api/src/metrics.ts:135-154`, `startOp` at `:170-172`). There are **229 `.prepare()`
sites and 28 `.batch()` sites across 25 files**, but they never name a binding directly —
they receive a `D1Database` from `dbFor`/`dirDb`. **This is the migration's best friend.**

**Strategy: a `D1Database`-shaped adapter over PlanetScale, returned by `dbFor`/`dirDb`.**
Implement `class PsDatabase implements D1Database` exposing `.prepare(sql).bind(...).first()
/ .all() / .run() / .raw()` and `.batch([...])`, backed by `@planetscale/database`'s
`conn.execute()` / `conn.transaction()`. Then `dbFor`/`dirDb` return a `PsDatabase` instead
of `env.rbox_dev_db`, and **the 229 call sites and the metrics Proxy are untouched** — the
Proxy wraps whatever object the binding resolves to (`metrics.ts:147-153`), adapter included,
so per-op D1 timing/counting keeps working verbatim.

This is the same philosophy §32 used at N=1: *one indirection, validated where it is a
near-no-op, so the eventual change is centralized rather than a 156-/229-site rewrite.* We do
**not** rewrite the query layer onto Drizzle/Kysely — that is a larger blast radius than a
contingency justifies. The adapter keeps the diff concentrated in three places: `db.ts` (what
`dbFor`/`dirDb` return), a new `ps-adapter.ts` (the shim), and the SQL dialect (§2).

**What the adapter must faithfully emulate** (or the 229 callers break):

- **Result shapes.** `.first<T>()` → first row or `null`; `.all<T>()` → `{ results: T[] }`;
  `.run()` → `{ meta: { changes, last_row_id } }` (the `changes===0` and `last_row_id`
  semantics some callers read); `.batch<T>()` → an **ordered** array of per-statement result
  objects, run in **one transaction** (§3). Map PlanetScale's `{ rows, rowsAffected,
  insertId }` onto these.
- **`?` positional binds** — 1:1 with MySQL. (Postgres would force `$1`-rewriting every
  statement; see the MySQL-vs-Postgres decision in §5.)
- **Error identity.** `isOverCapAbort` / `isUniqueViolation` (`apps/api/src/auth.ts:15`,
  re-exported from `auth/shared.ts`) currently sniff SQLite error text. The adapter must
  surface engine errors in a shape those predicates can still classify (§3, §4).

### 2. SQL dialect port — the SQLite-isms that must change

The 20 migration files (`apps/api/migrations/`) are SQLite. A **one-time** translation to
MySQL DDL is required. The specific idioms in use (grepped from the migrations), and their
MySQL equivalents:

| SQLite (today) | MySQL (target) | Where |
|---|---|---|
| `TEXT PRIMARY KEY` (e.g. `blobs.sha256`, `accounts.id`) | `VARCHAR(n)` PK — MySQL indexes need a bounded key length; size each to its real max (`sha256`→`VARCHAR(64)`, ids→`VARCHAR(40)`) | `0001`, `0006` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGINT AUTO_INCREMENT` | `audit_log` `0006:26`, `account_link_events` `0014_account_linking` |
| `INSERT OR IGNORE` | `INSERT IGNORE` | `commit-accounting.ts:133`, migrations |
| `ON CONFLICT(a,b) DO UPDATE SET x=excluded.x` | `ON DUPLICATE KEY UPDATE x=VALUES(x)` | grant upsert `commit-accounting.ts:150-151` |
| `unixepoch()*1000`, `strftime('%s','now')*1000` | `UNIX_TIMESTAMP()*1000` (or bind server `nowMs`, which the hot path already does) | `0011`, `0014_account_linking` |
| `randomblob(8)` / `hex(...)` | `RANDOM_BYTES(8)` / `HEX(...)` — or, better, mint ids in app code (already done: `acct_${randomHex(8)}`) | `0014_account_linking` de-dup |
| `CURRENT_TIMESTAMP` TEXT defaults | `TIMESTAMP DEFAULT CURRENT_TIMESTAMP`, or keep epoch-ms `BIGINT` (the codebase already prefers epoch-ms integers) | `0001` |
| **Triggers with `RAISE(ABORT,'over_cap')`** | **`SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='over_cap'`** | cap guard — §3, the load-bearing one |

Most of this is mechanical. The **triggers are the sharp part** and get their own section,
because the cap guard is a security-relevant invariant, not a convenience.

### 3. Transactions + the cap-guard trigger — the load-bearing port

The commit hot path depends on two D1 properties that must survive the move intact
(`commit-accounting.ts:110-186`):

1. **`db.batch([...])` is one atomic transaction in one subrequest.** Catalog `blobs`
   (present=1) → charge `used_bytes` via a `NOT EXISTS` sub-select → grant `blob_refs` →
   clear GC candidacy, **all roll back together** if any statement fails.
2. **The cap guard is a `BEFORE UPDATE OF used_bytes` trigger that `RAISE(ABORT,'over_cap')`**
   (`0014_upload_receipts.sql:60-66`), caught by `isOverCapAbort(e)` which aborts *the whole
   super-batch* and returns a 402 (`commit-accounting.ts:171-177`). The guard being **in the
   DB, not the app**, is a deliberate §30/§16 invariant — *no code path can grant over cap*.

**Porting property (1): PlanetScale/Vitess atomicity fits rbox perfectly if `account_id` is
the Vitess sharding key.** Every account-data-plane query is `WHERE account_id = ?` (§32 §2),
and the commit batch touches exactly one account. Declare a Vitess **VIndex on `account_id`**
(the same partition key §32's router uses), and the entire commit transaction is
**single-shard** — Vitess's atomicity restrictions (which bite only on *cross-shard*
transactions) never apply. The account-data plane thus keeps full ACID commit semantics with
zero app-level routing: **Vitess does §32's sharding transparently, keyed on the same column,
and the app never sees a shard.** The `@planetscale/database` driver's `conn.transaction(cb)`
maps onto the adapter's `.batch()` (one HTTP transaction round trip; see § Latency for the
round-trip cost this adds vs D1's single-subrequest batch).

> **Colocation invariant carries over verbatim.** §32 §4's hard rule — `blobs`, `blob_refs`,
> and the `accounts` accounting columns for one account must live together — is exactly the
> Vitess "same VIndex value → same shard" guarantee. The convergent-encryption fact that every
> `blobs.sha256` (an `encSha`) has exactly one owning account (§32 §4) is what makes
> `account_id` a sound shard key even though `blobs` has no `account_id` column today.
> **Recommendation: add the nullable `account_id` to `blobs`/`gc_candidates`** that §32's
> founder-decision already adopted — under Vitess it stops being optional-for-explicitness and
> becomes the **sharding column**, so this is a prerequisite, not a nicety.

**Porting property (2): the cap-guard trigger becomes a MySQL trigger that `SIGNAL`s.**

```sql
CREATE TRIGGER accounts_cap_guard BEFORE UPDATE ON accounts
FOR EACH ROW
BEGIN
  IF NEW.cap_bytes > 0 AND NEW.used_bytes > OLD.used_bytes AND NEW.used_bytes > NEW.cap_bytes THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'over_cap';
  END IF;
END;
```

Then **`isOverCapAbort` must be updated to recognize the MySQL signal** — SQLSTATE `45000`
with message `over_cap` — instead of the SQLite `RAISE(ABORT)` text. This is a small, isolated
change in `auth/shared.ts`, but it is **the highest-risk line in the port**: get it wrong and
either over-cap commits slip through (guard silently disabled) or every commit 500s. It needs
a dedicated test that drives an account over cap and asserts a 402, byte-for-byte matching
today's `commit-accounting.test`. The `accounts_cap_sync` / `accounts_cap_on_insert`
materializer triggers (`0014_upload_receipts.sql:45-58`, `0016_cap_bytes_insert_materialize.sql`)
port the same way (`AFTER UPDATE`/`AFTER INSERT` … `SET cap_bytes = …`), and their `CASE plan`
arithmetic is dialect-neutral. **`isUniqueViolation`** likewise re-targets MySQL error `1062`.

**Note — PlanetScale MySQL historically disabled foreign keys** (Vitess). rbox does **not**
rely on FKs anywhere in the schema (the migrations declare none; integrity is app-enforced),
so this is a non-issue — but it is worth stating explicitly so nobody adds an FK during the
port expecting it to be enforced.

### 4. What the adapter must NOT paper over

- **`db.batch()` result ordering and `changes` counts.** Callers read `.meta.changes` (e.g.
  idempotency checks) and rely on batch result order. The adapter maps `rowsAffected`/order
  from PlanetScale; a mismatch is a silent correctness bug, so this needs golden tests against
  the existing suite.
- **The `batchedInLookup` / `SELECTS_PER_BATCH` chunking** (`apps/api/src/d1-batch.ts`,
  `commit-accounting.ts:23-37`) exists to respect **D1's ≤100 bound-params/statement** limit.
  MySQL's `max_prepared_stmt_count` and `max_allowed_packet` are different limits — the
  chunk constants (`CHUNK=33`, `IN_LIST_CHUNK=80`, `STMTS_PER_BATCH=34`) stay *safe* under
  MySQL but may no longer be *optimal*. Leave them as-is for the port (correctness first),
  tune later. Do **not** remove the chunking — a single 50k-ref commit
  (`MAX_REFS_PER_COMMIT`, `commit-accounting.ts:37`) still needs bounded transactions.
- **`last_row_id` / `AUTOINCREMENT` semantics.** `audit_log` and `account_link_events` use
  autoincrement PKs; MySQL `insertId` maps to `last_row_id`, but only for single-row inserts —
  verify no caller reads it after a multi-row insert.

### 5. MySQL/Vitess vs PlanetScale-Postgres — the one real engine choice

Both are PlanetScale products. The trade-off:

- **MySQL/Vitess (recommended).** (a) **`account_id`-keyed Vitess sharding is the whole point**
  — it dissolves *both* the storage cap and the single-writer ceiling transparently, keyed on
  the exact column rbox already partitions by, and makes the commit transaction single-shard
  (§3). (b) **`?` placeholders match all 229 sites 1:1** — the adapter is a thin shim. (c) It
  is the battle-tested, proven-at-Dropbox-scale path §32 explicitly invokes ("the lesson
  Dropbox learned sharding MySQL"). Cost: `RAISE(ABORT)`→`SIGNAL`, `ON CONFLICT`→`ON DUPLICATE
  KEY`, no FKs.
- **PlanetScale for Postgres.** Dialect is *closer to SQLite* (`ON CONFLICT` native,
  `RAISE EXCEPTION`, richer types), so the trigger/upsert port is cheaper. But: `$1`
  placeholders force rewriting every one of the 229 `?` statements (or a driver shim that
  translates), and the Vitess-style transparent account-sharding story is the newer, less-proven
  path. The dialect saving is real but one-time; the placeholder mismatch is friction at every
  call site.

**Recommendation: MySQL/Vitess.** The placeholder match + account-keyed sharding are
structural wins that recur; the dialect port is a bounded one-time cost. Flagged as a founder
decision because it is irreversible-ish once data lands.

### 6. Schema migration tooling — a genuine upgrade over D1

D1 today = `wrangler d1 migrations` over numbered `.sql` files, applied at deploy. Two options
on PlanetScale:

- **PlanetScale branches + deploy requests** — the native flow. **Online, non-blocking schema
  changes** (add a column to a live multi-GB table with no lock) are a PlanetScale *strength*
  and a real improvement over D1's apply-and-hope. Adopt going forward.
- **Keep the numbered `.sql` files** as the source of truth, translated to MySQL, applied via
  the PlanetScale CLI in CI (mirrors today's wrangler step). Lower workflow change; forgoes the
  branching ergonomics.

Either way the **20 existing migrations translate once** (§2). Recommend: translate to MySQL,
adopt branch-based deploy requests for *new* migrations, so the online-DDL benefit accrues from
day one.

### 7. Data cutover — metadata only, small, freeze-and-copy

Only control-plane rows move; **R2 blobs and DO storage do not** (content-addressed / DO is
authoritative — §32 Phase 3 made the same observation). Control-plane metadata is *small*
(`blob_refs` rows, not blob bytes). Path:

1. **Export:** `wrangler d1 export --output dump.sql` per environment.
2. **Transform:** SQLite dump → MySQL (the §2 dialect map, scriptable).
3. **Load** into a PlanetScale branch; validate row counts + a checksum sample per table.
4. **Cutover.** Because §32's `dbFor`/`dirDb` seam exists, a **dual-read/dual-write shim can
   live inside the adapter**: write both, read D1, backfill, then flip reads to PlanetScale,
   then drop D1. For a small control plane a simpler **freeze-and-copy** is viable — the §32
   Phase-3 router gate (return `503 Retry-After` on account-mutating routes during the copy;
   `rbox push` already retries) bounds the write-freeze to the copy duration, which is short
   because it is metadata, not blobs. Do the cutover **dev-first** (AGENTS.md), verify, then
   prod on a merge.

## Cross-cutting concerns

### Latency — the dominant risk

D1 is colocated + read-replicated; PlanetScale is one region reached over the network. Impact
and mitigations, in priority order:

1. **Region-pin PlanetScale near the Worker's traffic centroid.** Single biggest lever —
   collapse the base RTT.
2. **Cache the auth hot read.** `authenticate` does one `SELECT … FROM devices … WHERE
   token_hash=?` per request plus a throttled `last_seen_at` write already wrapped in
   `.catch()` (`authenticate.ts:24-44`). §32 § Residual already prescribes caching
   `token_hash → {accountId, role, …}` in KV/DO so the hot path skips the DB entirely — that
   mitigation becomes **more** valuable here (it removes a cross-network hop, not just a
   D1 read). The `last_seen_at` write is already best-effort/sampled.
3. **Hyperdrive** (§ path 2) in front of PlanetScale for edge connection-pooling + read-query
   caching once the port is stable.
4. **Round-trip count matters more than before.** D1's `db.batch()` is one subrequest; the
   HTTP-driver transaction is one HTTPS round trip but to a distant region. The commit path is
   *already* aggressively batched (§30) — that pays off doubly here. Audit for any remaining
   serial `await stmt` chains and fold them into transactions/batches during the port.

### Cost

D1 is serverless-metered (rows read/written + storage) and egress-free from Workers.
PlanetScale is a **provisioned** database (scale-based pricing) **plus Worker→PlanetScale
egress** — a new always-on line item versus D1's included model. For a contingency that is
justified only when D1's *limits* (not its cost) bind, this is an accepted trade, but it must
be sized before committing. Hyperdrive adds its own pricing.

### Vendor / operational surface

Today the control plane is one throat to choke (Cloudflare: Workers + D1 + R2 + DO). §57 adds a
**hard dependency on a non-CF provider** for the control plane — availability becomes CF ∧
PlanetScale ∧ the network path between them. R2/DO/Workers stay CF. This is the philosophical
cost of the move and the reason it is break-glass, not default: §32 keeps everything inside one
provider; §57 trades that for a database that scales past D1's walls without an app-level shard
router to build and operate.

## §57 vs §32 — the honest comparison

| | §32 (shard D1) | §57 (PlanetScale) |
|---|---|---|
| Storage cap | Split across N D1s, per-account grain | Gone (Vitess shards below account grain) |
| Single-writer ceiling | Relieved per shard | Gone (multi-writer) |
| **Single account > 10 GB** | **Cannot fix** (shards *by* account) | **Fixed** (only §57 does) |
| Latency | CF-native, lowest | Cross-network (mitigable) |
| Vendor | All Cloudflare | + PlanetScale dependency |
| Cost | D1-metered | Provisioned DB + egress |
| Build/operate | Shard router + per-shard GC/retention fan-out + whale rebalancing | Adapter + one-time dialect/data port; DB is managed |
| Online DDL | D1's apply-at-deploy | Native non-blocking |
| SQL dialect | Unchanged (SQLite) | One-time port |
| Status | **Decision-complete, Phase 0 seam shipped** | **This draft** |

**Net:** §32 is the correct first response and is already the plan. §57 is the escape hatch for
(a) a single-whale-over-cap, or (b) when per-shard operational burden (GC/retention across many
shards, whale migrations) outweighs running one managed multi-writer DB. The two are not
mutually exclusive by accident: **§32's `dbFor`/`dirDb` seam is precisely what makes §57 a
centralized adapter swap rather than a 229-site rewrite.** Building §32 Phase 0 was the right
call *even if* §57 is where we eventually land.

## Test + rollout plan

- **Adapter conformance:** run the **existing** `apps/api/test/*` suite against the
  `PsDatabase` adapter (local MySQL/PlanetScale branch). The bar is *zero behavior diff* —
  same result shapes, same `.batch()` ordering/atomicity, same `changes` counts. Any suite
  that passes on D1 must pass on the adapter unchanged.
- **Cap-guard equivalence (highest risk):** drive an account over `cap_bytes`; assert a **402**
  and **zero** `blob_refs` written — the `SIGNAL`→`isOverCapAbort` path must be byte-for-byte
  equivalent to today's `RAISE(ABORT)` path. Add a unique-violation test for `isUniqueViolation`
  (MySQL `1062`).
- **Single-shard commit atomicity:** a mid-batch failure rolls back catalog+charge+grant
  together on the account's Vitess shard; a >`MAX_REFS_PER_TXN` commit runs several
  independently-atomic super-batches exactly as on D1 (`commit-accounting.ts:118-124`).
- **Dialect port golden:** every migration's MySQL form reproduces the same constraints
  (PKs, unique indexes like `uq_clerk_users_account` `0014_account_linking`, trigger effects).
- **Cutover integration:** export→transform→load a seeded D1 into a PlanetScale branch; assert
  row-count + checksum parity per table; run a dual-write window then flip reads; a commit
  issued during the freeze gets `503 Retry-After` and lands wholly on PlanetScale after the flip.
- **Latency budget:** measure p50/p99 of `authenticate` and the commit batch against a
  region-pinned PlanetScale from a dev Worker; confirm the KV auth-cache (§ Latency) keeps the
  per-request hot path off the network. Deploy **dev-first**, verify, then prod (AGENTS.md).

## Open questions for the founder

1. **Trigger, not "if" — engine choice (§5):** MySQL/Vitess (recommended: `?`-match +
   account-keyed sharding) vs PlanetScale-Postgres (cheaper dialect port, `$1` friction)?
   Effectively irreversible once data lands.
2. **What pulls the §57 lever vs §32?** Concretely: a single account approaching the D1
   storage cap (§57-only), OR a sustained per-shard operational burden that outweighs a managed
   DB? Both §32 and §57 sit behind the same §25 telemetry trigger — this doc argues §32 fires
   first and §57 only on the whale-over-cap or operational-burden signal.
3. **Adapter vs rewrite:** confirm the `D1Database`-shaped adapter (minimal blast radius, keeps
   §32's seam) over a full Drizzle/Kysely query-layer rewrite?
4. **Access path:** start on the `@planetscale/database` HTTP driver (no `nodejs_compat`), add
   Hyperdrive later as a latency mitigation — or adopt Hyperdrive from the start?
5. **Do §32 and §57 coexist?** Once on Vitess, its transparent sharding *replaces* §32's
   app-level router — is §32 then retired, or kept as the CF-native option for a
   PlanetScale-outage fallback? (Affects whether we keep the router code alive.)
