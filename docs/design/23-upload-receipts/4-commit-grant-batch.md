# §23.4 — Commit-time batched grant (the D1 win)

> Chunk of [§23](../23-upload-receipts.md). Depends on §23.1–23.3.
> Where the per-blob D1 work collapses into O(chunks) per commit.
> **v3** (supersedes v2's publish-then-account): adopts **account-then-publish** — catalog +
> charge + grant land durably in ONE D1 batch *before* the head advances, and over-cap aborts
> that batch via a **CHECK constraint** (not a 0-row UPDATE). Rationale below.
> **v4:** commit **promotes staging→canonical** (server-side R2 copy) before cataloging, and
> the `gc_candidates` resurrection path is **removed** — GC only deletes staging orphans
> (§23.5), so no commit step ever races a canonical delete (closes B1/B5).
> **v5/v6** (superseded): promote-before-charge + a `commit_leases` reservation — couldn't bound
> *cumulative* uncharged-canonical parking. **v7:** charge+grant before promote. **v8** (current)
> adds the missing piece v7 lacked: an explicit **`blobs.present` flag** set only after promote,
> so "entitled" (billing) and "canonical present" are no longer conflated. Reuse / head-advance /
> `missingBlobs` gate on `present=1`, NOT on `blob_refs` existence. A `present=0` ref is *missing
> to every consumer*, never enters a published head, and is therefore freely revocable.
> Order: validate → **D1 batch (catalog `present=0` + charge + grant, under CHECK)** → promote
> staging→canonical (receipt-keyed, idempotent) → **set `present=1`** → advance head.

## Why account-then-publish (the B1 reversal)
v2 tried publish-then-account (advance head, then charge). Codex correctly killed it: the
published head *references* blobs, so if the post-publish D1 write crashes, the head points at
blobs with **no `blobs` row** → other devices read them as unentitled/404, and orphan GC
(which deletes objects lacking a `blobs` row) can **delete a published commit's bytes → data
loss**. That is strictly worse than the original B1.

So the catalog (`blobs` row) and entitlement (`blob_refs`) MUST be durable *before* the head
that depends on them publishes. The two orderings' failure modes:

| order | crash/abort failure mode | severity |
|---|---|---|
| publish-then-account | published head → missing `blobs` row → 404 + GC data loss | **unacceptable** |
| account-then-publish | grant durable, then head 409s → account holds entitled-but-unreferenced blobs it genuinely uploaded | bounded, recoverable quota leak |

We take account-then-publish. The 409 tail is benign: the bytes are really the account's
(it uploaded them with a valid receipt); on retry (new parent) the refs are already entitled
→ `newBytes = 0`, no double charge, and the retry publishes them. Abandon-after-409 leaves a
quota leak reclaimable by a per-account unreferenced-`blob_refs` sweep (backlog) — never data
loss, never an unreadable head.

## Ordering
In the `workspace-sync` commit handler:

1. **Resolve refs** — from the commit body / §24 sidecar: `[{ encSha, size }]`. `size` is the
   *server-measured ciphertext* size carried by the receipt / `blobs.size_bytes`; the
   client-supplied plaintext `blobRefs.size` is advisory and ignored for billing (B4).
2. **Validate each ref** — require ONE of: **`blobs.present=1` AND entitled** in
   `blob_refs(account_id, encSha)` (canonical confirmed + this account holds it), OR a valid
   receipt (§23.1: HMAC + domain tag, `v===1`, `t` not future, unexpired, account+sha+size match).
   A ref that is entitled but `present=0` does NOT count as satisfied — it needs a receipt like
   any absent ref. Else → `422 { error: needs_upload, shas }`. Receipts are required for every
   charged object including `encManifestSha` (B4).
3. **One pre-publish D1 `batch([...])` — catalog(`present=0`) + charge + grant under CHECK**
   (transactional), chunked to D1 limits (≤100 params, ≤100 KB/stmt → multi-row INSERTs in groups
   of ~40–50, `MAX_ACCOUNTING_REFS_PER_COMMIT` total — M8). `cap_bytes` materialized (below):
   ```sql
   INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES …(refs, receipt sizes, 0)…;  -- catalog, NOT present
   UPDATE accounts SET used_bytes = used_bytes + (                            -- charge: NOT-EXISTS
     SELECT COALESCE(SUM(b.size_bytes),0) FROM blobs b
      WHERE b.sha256 IN (…refs…)
        AND NOT EXISTS (SELECT 1 FROM blob_refs r
                        WHERE r.account_id=?acc AND r.sha256=b.sha256))
     WHERE id = ?acc;                                  -- CHECK(used_bytes <= cap_bytes) guards
   INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES …(refs, now)…   -- grant (billing) after charge
     ON CONFLICT(account_id, sha256) DO UPDATE SET granted_at = excluded.granted_at;  -- refresh lease
   ```
   The grant refreshes `granted_at` (the revoke lease, §23.5) on every reference, so a concurrent
   reconcile can never revoke a ref this commit just touched. The charge's `NOT EXISTS` still runs
   *before* the grant, so a re-grant of an already-held ref charges 0 (idempotent).
   - **B2 (hard cap):** an over-cap charge violates `CHECK(used_bytes <= cap_bytes)` → statement
     failure → whole `batch()` rolls back → `402`, no charge/grant/catalog. D1 serializes
     per-account, so the "100 workspaces × 1 GiB → 100 GiB" storm cannot happen.
   - **B3 (exactly-once):** order **catalog → charge → grant** — the charge's `NOT EXISTS` reads
     the pre-grant `blob_refs` state and sums sizes of exactly the refs this account didn't hold;
     D1 serialization makes it exactly-once (§23.6). Sizes are the server-measured receipt sizes.
   - The grant is **billing only**: `blob_refs` now means "charged," NOT "bytes present." Presence
     is `blobs.present`, set in step 5. Decoupling these is the v8 fix.
4. **Promote staging→canonical (after the durable charge)** — for every ref the client **uploaded
   this push** (carries a receipt) and that is not yet `present=1`, **R2 server-side copy**
   `stagingKey(acct,sha)` → `blobKey(sha)` (S3 `CopyObject`, no worker egress). Idempotent
   (content-addressed). Receipt-keyed, so a retry after a crash re-promotes (staging still present,
   `RECEIPT_TTL < STAGING_GC_GRACE`). No uncharged canonical is ever written (charge precedes this).
5. **Set `present=1`** — once promote confirms the canonical object, `UPDATE blobs SET present=1
   WHERE sha256 IN (…promoted…)`. Only now is the ref reusable / referenceable. If promote fails
   or the worker crashes before this, the ref stays `present=0`: **missing to every consumer**
   (step 2 + `missingBlobs` + head-validate all gate on `present=1`), so it can never enter a
   published head and never be relied upon. No active compensation is needed — the §23.5 reconcile
   sweep later either drives `present=0` → `1` (re-promote within TTL) or **safely revokes**
   it (`DELETE blob_refs` + refund), safe precisely because a `present=0` ref is in no head.
6. **Advance head** — the DO sequencer (`seq=parent+1`). Head-validate requires every new ref to
   be `present=1`, so **committed head ⟹ canonical present**. On `409`/epoch the grant + present
   flag are durable; the client retries with the new parent → `newBytes = 0`, refs already
   `present=1`, no re-upload, no re-promote.

### Schema (migration)
- `accounts.cap_bytes` — materialized from `plan` + extra-storage (the CHECK needs a concrete
  column); every plan/extra change (Stripe webhook, admin) updates it in the same write.
- `CHECK (used_bytes <= cap_bytes)` on `accounts` (same-row invariant). No `reserved_bytes`,
  no `commit_leases` — charge precedes promote, so there is nothing to reserve.
- `blobs.present INTEGER NOT NULL DEFAULT 0` — `1` only after a confirmed canonical promote.
  Reuse, `missingBlobs`, and head-validate all gate on `present=1`; existing rows backfill to
  `1` (they predate §23 and already have canonical objects). This is the v8 decoupling of
  "charged" (`blob_refs`) from "canonical present" (`blobs.present`).
- `blob_refs.granted_at` — the revoke-lease timestamp, refreshed on every (re-)grant; reconcile
  may revoke a `present=0` ref only when `granted_at < now − REVOKE_GRACE` (§23.5). Backfill
  existing rows to their creation time (all `present=1` anyway → never swept).

## D1 limits (verified, §22)
100 params/stmt, 100 KB/stmt, 30 s/batch, single-threaded per DB → chunk refs into ~40–50-row
statements inside one transaction; enforce `MAX_ACCOUNTING_REFS_PER_COMMIT` (M8). Larger
commits need §24 (sidecar) + a proven large-commit path first.

## Receipt semantics at commit
- Valid receipt + authorized workspace = permission to create the `blob_refs` row *if the cap
  CHECK passes*. Over-cap → 402, nothing granted.
- Expired receipt → `422 needs_upload`; client re-PUTs (R2 dedups) + retries.
- Replay across retries / same-account commits is safe: after the first grant the ref is
  entitled, so the `NOT EXISTS` charge sums 0.

## Idempotency
Retry after 409 (parent moved): prior attempt's grant is durable; retry charges 0 for the now
already-entitled refs and publishes. Retry after a *lost-response* successful publish: head
won't re-advance (seq taken → 409) and the batch is `INSERT OR IGNORE` + `NOT EXISTS` → 0 new,
0 charge. Safe either way.

## Tests (worker)
- All-entitled refs → 0 new charge, head advances.
- Receipts → grant in one pre-publish batch, `used_bytes += Σ new ciphertext sizes`, head
  advances.
- Missing/expired receipt + unentitled → 422, head unchanged, D1 untouched.
- Over-cap → CHECK aborts batch → 402, **assert `blobs`/`blob_refs`/`used_bytes` all
  unchanged** (no partial grant) — the B2 case.
- Concurrent same-account commits that together exceed cap → exactly the ones that fit
  succeed; `used_bytes` never exceeds `cap_bytes`.
- DO 409 after a successful grant → refs entitled & durable, canonical bytes promoted; retry
  charges 0 and publishes with no re-upload.
- Duplicate-content refs (same encSha twice) → promoted once, charged once.
- Receipt for a sha whose staging object still exists → promoted to canonical + granted.
  (Staging is guaranteed present because `RECEIPT_TTL < STAGING_GC_GRACE`.)

## Depends on / Status
Depends on: §23.1–23.3 (+ §24 for large ref sets), a migration adding `accounts.cap_bytes` +
`CHECK (used_bytes <= cap_bytes)`. Status: **design (v8)**. First implementation task is the
§23.6 D1 spike: confirm (a) the in-SQL `NOT EXISTS` charge is exactly-once and (b) a
CHECK-constraint violation rolls back the whole `batch()`.
