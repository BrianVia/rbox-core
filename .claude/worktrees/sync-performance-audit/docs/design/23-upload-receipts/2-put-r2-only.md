# §23.2 — PUT becomes ~R2-only, writes to a staging key (returns a receipt)

> Chunk of [§23](../23-upload-receipts.md). Depends on [§23.1](1-receipt-primitive.md).
> The change that removes the per-blob D1 storm from the hot path.
> **v4:** PUT targets a **staging** key, not the canonical content key — this is what makes
> orphan GC race-free (§23.5). Commit promotes staging→canonical (§23.4).

## Problem
`blobPut` (`apps/api/src/blobs.ts:52`) today does R2 put **+ ~5 D1 ops** (INSERT blobs,
DELETE gc_candidates, INSERT blob_refs, UPDATE used_bytes, plus a cap SELECT). Those D1
writes are the measured plateau. They belong at commit (§23.4), not per PUT.

## Why staging, not canonical
If PUT wrote the canonical content key `blobKey(sha)`, an uploaded-but-never-committed object
would be an orphan *at the canonical key* — and reclaiming it races any concurrent commit that
references the same sha (R2 has no conditional delete; same-key PUT/DELETE is last-writer-wins,
per Cloudflare docs). Writing to a per-account **staging** key makes orphans live in a
namespace that **no committed head ever references**, so GC can delete staging freely with zero
data-loss race (§23.5 closes B1/B5/M7 this way).

## Design
New `blobPut`:
```
auth → account
key = stagingKey(account, sha)                  //  staging/{accountId}/{sha}
R2 put(key, body, { sha256: sha })              //  R2 verifies the hash; sha_mismatch → 400
return 200 { ok, sha, size, receipt: mintReceipt(env,{account,sha,size,now}) }
```
- **No** `blobs` / `blob_refs` / `used_bytes` / `gc_candidates` writes here. PUT mutates only
  the staging R2 object and returns proof that this account supplied these bytes.
- `size` from the R2 `put` result (`obj.size`) — authoritative, server-measured ciphertext size.
- Staging key is **account-scoped** so one account's staging churn/lifecycle/rate-limit never
  touches another's, and a staging object is never a shared canonical object.
- Same path for `multipartComplete` (`blobs.ts:166`) — it assembles into the staging key and
  returns a receipt. (Multipart parts also live under the staging prefix.)
- The receipt binds `(account, sha, size)`; the staging key is derivable from `(account, sha)`,
  so commit can locate the exact object to promote.

## What this removes / keeps
- Removes: lines 66–68 (INSERT blobs, DELETE gc_candidates, grantEntitlementWithQuota).
- Keeps: R2 sha-verified put (content integrity), the `SINGLE_PUT_MAX` → multipart gate.
- The content-store boundary is strict: no canonical metadata, quota, entitlement, head, or
  GC state changes on the upload path. The only deviation from "pure R2" is the per-account
  PUT **rate-limit check** (Cloudflare native binding) that bounds orphan accrual (§23.5.D / M7).

## Backward compatibility — no legacy canonical-write path
The legacy per-PUT path **wrote canonical bytes + granted on PUT**. Keeping it as a fallback
reopens M7: a legacy PUT writes canonical, and if its grant later fails (over quota), removing
canonical GC (§23.5) leaves those bytes parked permanently — a serial, unbounded bypass of the
v6 reservation. Since **rbox controls all clients** (and has essentially no third-party-binary
install base), we do NOT keep that path. The server requires `X-Rbox-Protocol: upload-receipts-v1`;
a request without it gets `426 Upgrade Required`. The single staging-PUT + receipts protocol is
the only upload path, so every canonical write goes through the bounded commit promote. (Enforce
a min-CLI version; the CLI already self-updates.)

## Correctness
- PUT succeeds in R2 but response lost → client retries PUT (idempotent by staging key) → new
  receipt. Fine.
- No entitlement granted here → an unentitled account uploading bytes gains **no read access**
  and the bytes are not even at the canonical key, so there is no cross-account existence
  signal — strengthens the M7 "unentitled gets 404 / no oracle" property.
- A successful PUT is not a quota reservation. If the later commit is over cap (CHECK fails,
  §23.4), the head does not advance, nothing is promoted to canonical, and the staging object
  is reaped by staging-prefix GC.
- A valid receipt is younger than `RECEIPT_TTL < STAGING_GC_GRACE` (§23.1/§23.5), so its
  staging object is guaranteed to still exist for commit to promote — no resurrection logic,
  no R2-head dance.

## Tests (worker / vitest)
- PUT writes the **staging** key and performs **zero D1 writes** (assert via a D1 spy).
- Bad sha → 400 (R2 verify) and no receipt. Oversize → 413 → multipart.
- PUT without `X-Rbox-Protocol: upload-receipts-v1` → `426 Upgrade Required` (no canonical
  write, no grant).
- Lost response / retry returns a fresh receipt without extra metadata writes.
- Over-account-rate-limit PUT → 429.

## Depends on / Status
Depends on: §23.1. Status: **design (v4)**. Pairs with §23.3 (missingBlobs) + §23.4 (commit
promote+grant).
