# §23.5 — Quota timing + orphan-byte reclamation

> Chunk of [§23](../23-upload-receipts.md). Owns the consequence of moving the
> authoritative quota charge to commit: uploaded-but-never-committed R2 bytes.
> **v4:** the whole `gc_candidates` resurrection model is **gone**. Uploads land in a
> per-account **staging** namespace; commit promotes them to canonical; GC deletes **only
> staging orphans**, which no committed head ever references. That structurally closes the
> B1/B5 data-loss race (no canonical delete can race a commit) instead of narrowing it.

## Problem
With the charge at commit (§23.4), a push can upload N blobs to staging then never commit
(over quota, crash, ^C). Those staging objects are unreferenced = **orphans** that cost storage
until reclaimed.

## Two namespaces (the structural fix)
- **Staging** `staging/{accountId}/{sha}` — where PUT writes (§23.2). Per-account, never
  referenced by any committed head. Safe to delete unconditionally once stale.
- **Canonical** `blobKey(sha)` — shared, content-addressed. Created ONLY by commit's promote step (§23.4 step 4). **§23 never deletes canonical objects.** A committed head
  references canonical keys, and since nothing in §23 deletes them, no head can ever dangle.

> Reclaiming *canonical* dedup'd blobs that reach zero `blob_refs` is a separate, rare,
> offline mark-sweep that requires a quiescence/lease protocol — **explicitly out of scope for
> §23** (tracked in backlog). Until it lands, canonical objects are retained. Storage is cheap;
> this trades a little disk for the removal of an unsolvable-on-R2 delete race.

## §23 removes the existing destructive canonical GC (B5 closure)
B5 stays closed ONLY if no in-scope code deletes canonical objects. So §23 **removes the
current scheduled `gc_candidates`/canonical purge** (the `runScheduledGc` path in
`apps/api/src/worker.ts` + `versions.ts`) and replaces it with staging-prefix reclamation
below. There is also **no legacy canonical-write path** (§23.2 → `426`): every canonical write
goes through the bounded commit promote. After §23 ships there is exactly one deleter (staging
GC) and it never touches canonical.

## No uncharged canonical (M7, via §23.4 v7 charge-before-promote)
v7 charges + grants in a D1 batch under `CHECK(used_bytes <= cap_bytes)` **before** promoting
staging→canonical. So **canonical bytes are only ever written after a durable charge** — there
is no uncharged canonical to bound, and no reservation/lease machinery. The M7 cumulative-parking
attack ("reserve up to cap, promote unique shas, let the lease expire, repeat") is impossible:
nothing uncharged is ever promoted. An attacker who charges then abandons (crash before promote)
just spends their *own* `used_bytes`, self-limiting at `cap`; their staging objects are reaped,
and no canonical object was written.

### Reconcile sweep (the crash tail)
A crash *after* the charge batch but *before* `present=1` leaves a **charged ref with
`blobs.present=0`** (`blob_refs` exists for billing, canonical not confirmed). By the v8
decoupling, a `present=0` ref is **missing to every consumer** — `missingBlobs`, commit-validate,
and head-validate all gate on `present=1` — so it **can never be in a published head and nobody
relies on it as present**. That is exactly what makes cleanup safe without proving
head-reachability. A periodic **reconcile sweep** (D1-authoritative; read-only R2 `head`, never an
R2 delete → no race) handles `present=0` rows older than a grace. It **checks canonical existence
BEFORE any refund** — this is the load-bearing order (a crash *after* the R2 copy but *before*
`present=1` leaves a real canonical object flagged `present=0`; refunding it would leave uncharged
canonical bytes, reopening M7). For each `present=0` sha:
1. **R2 `head(blobKey(sha))`** — does the canonical object exist?
   - **Yes** → the promote actually succeeded; the crash was between copy and flag. **Adopt it:**
     `UPDATE blobs SET present=1`. The charge is retained (correct — the bytes exist and are
     entitled). Never refund a sha whose canonical object exists.
   - **No** → canonical absent. Check staging:
     - staging object present (within `STAGING_GC_GRACE`) → **re-promote** → `present=1`.
     - staging gone → **revoke** (see the atomic guard below).
Because §23 never deletes canonical, a `head`=present result is durable, so adopting is race-free.
A `present=1` ref is never swept.

#### Revoke is atomic + lease-guarded (closes the revoke TOCTOU)
The R2 observations above are stale by the time the `DELETE` runs, so a concurrent commit could
re-upload + re-validate + set `present=1` in between. Two guards make revoke safe:
- **Lease timestamp.** Every grant / re-grant sets `blob_refs.granted_at = now` (§23.4 — the grant
  is `INSERT … ON CONFLICT DO UPDATE SET granted_at = now`). Reconcile only revokes refs with
  `granted_at < now − REVOKE_GRACE`, where `REVOKE_GRACE ≫ max commit duration` (a commit reaches
  `present=1` within seconds; pick e.g. 1h). So **no in-flight or recently-touched commit's ref is
  ever revoke-eligible** — a concurrent/retrying commit refreshes `granted_at`, pushing the ref
  out of the revoke window. (In practice the revoke branch only fires >`STAGING_GC_GRACE`=24h after
  upload, by which point the receipt has long expired (`RECEIPT_TTL`=12h) — but the lease guard is
  the load-bearing invariant, not the timing coincidence.)
- **Atomic conditional delete + refund-from-deleted.** The revoke is one statement:
  `DELETE FROM blob_refs WHERE account_id=? AND sha256=? AND (SELECT present FROM blobs WHERE
  sha256=?) = 0 AND granted_at < ? RETURNING sha256` — it deletes only if *still* `present=0` and
  still stale, and the refund is computed from the **rows actually returned** (0 rows → 0 refund).
  If a commit set `present=1` first, the DELETE matches nothing; if reconcile wins, the later
  commit's `present=1`/head-advance still sees no entitlement and re-grants (it holds a receipt).
This closes the "refund a sha whose canonical exists → uncharged parking" corner, the "revoke a
still-used ref" hazard, AND the revoke TOCTOU.

## Quota timing
### A. Fail-fast preflight (advisory)
`missingBlobs`/check returns `{ used, cap, remaining }` (§23.3). The client refuses a doomed
push locally **before** uploading. Advisory only (a racing commit can change `used`); the
authority is the commit-time `CHECK`.

### B. Commit-time authority (account-then-publish, §23.4 v7)
Commit charges + grants in one D1 batch under `CHECK (used_bytes <= cap_bytes)` (over-cap → 402,
batch rolls back, nothing promoted), THEN promotes staging→canonical for receipt-refs, THEN
advances head. Charge precedes promote, so canonical is only written after a durable charge.

## Orphan reclamation — staging only (M7)
A **staging** object older than `STAGING_GC_GRACE` is reclaimable with **zero data-loss race**,
because no committed head references the staging namespace. Two hot-path-free mechanisms,
either/both:
- **R2 lifecycle rule on the `staging/` prefix** — auto-expire objects older than the grace
  window (R2-native, zero Worker cost). Cloudflare lifecycle granularity is ~24h and multipart
  abandon defaults to 7 days, so set `STAGING_GC_GRACE` to the lifecycle floor (e.g. **24h**),
  NOT 1h — and derive `RECEIPT_TTL` from *that* (below). This is the backstop reaper.
- **Per-account PUT rate limit** (Cloudflare native binding, keyed on `accountId`; not per-blob
  D1). Caps PUT throughput, so the staging-orphan ceiling is bounded by
  `PUT_RATE × max_object_size × STAGING_GC_GRACE`, after which lifecycle reclaims. Over-limit
  PUTs → `429`. Sized so it only trips on abuse.
- Multipart: incomplete multipart uploads under `staging/` are reaped by R2's **incomplete-MPU
  abort rule**, whose default horizon is **7 days** (distinct from the ~24h object-age rule).
  So the multipart-orphan bound is `PUT_RATE × max_object_size × 7d`, and `RECEIPT_TTL` for a
  multipart-completed object must still be `< 7d` (12h satisfies both). Set the abort horizon
  explicitly rather than relying on the default.

Because deletion only ever targets staging, there is **no R2-head TOCTOU, no `marked_at`
re-check, no resurrection** — those existed only to make canonical deletion "safe," which v4
removes by not deleting canonical at all.

Net: committed bytes bounded by the `CHECK` cap; uncommitted (staging) bytes bounded by rate
limit + lifecycle. Neither touches the hot path; neither can lose a committed object.

## Correctness
- Uploaded + committed within `RECEIPT_TTL` → promoted to canonical (never deleted) → reachable
  forever by the published head. ✓
- Uploaded + never committed → staging object only → reaped after `STAGING_GC_GRACE`. ✓
- Uploaded + commit over cap → CHECK rolls back the batch *before* promote; nothing written to
  canonical; head not advanced; staging copy reaped. ✓
- DO 409 after a durable grant → canonical already promoted, never deleted → retry publishes
  with no re-upload. ✓
- Convergent dedup: two accounts promote the same content to the same canonical key (identical
  bytes, last-writer-wins harmless); each gets its own `blob_refs`; the shared object is never
  deleted by §23. ✓

## Constants (M11)
Driven by the staging lifecycle floor: `STAGING_GC_GRACE` ≈ **24h** (R2 lifecycle granularity).
`RECEIPT_TTL` MUST be **strictly less** so a valid receipt guarantees its staging object still
exists for commit to promote — pin **12h** (≪ 24h, comfortable margin). Assert
`RECEIPT_TTL < STAGING_GC_GRACE` at startup + in a unit test (fail closed). If the lifecycle
window changes, the assertion forces `RECEIPT_TTL` to follow.

## Tests
- PUT lands under `staging/{account}/`; never under canonical.
- Upload-then-abandon: staging object reaped after `STAGING_GC_GRACE`; no canonical object ever
  created; no `blobs` row.
- Commit promotes staging→canonical, then catalogs; a subsequent staging-GC pass does not touch
  the canonical object.
- Over-cap commit: CHECK rolls back BEFORE promote; head unchanged; staging reaped; no
  canonical object written.
- `RECEIPT_TTL < STAGING_GC_GRACE` assertion fails the build if violated.

## Depends on / Status
Depends on: §23.2 (staging PUT), §23.4 (promote + catalog), an R2 lifecycle rule on `staging/`,
the per-account PUT rate-limit binding. Canonical dedup-GC is a separate backlog item.
Status: **design (v10)**.
