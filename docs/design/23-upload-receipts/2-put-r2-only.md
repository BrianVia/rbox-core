# §23.2 — PUT becomes ~R2-only (returns a receipt)

> Chunk of [§23](../23-upload-receipts.md). Depends on [§23.1](1-receipt-primitive.md).
> The change that removes the per-blob D1 storm from the hot path.

## Problem
`blobPut` (`apps/api/src/blobs.ts:52`) today does R2 put **+ ~5 D1 ops** (INSERT blobs,
DELETE gc_candidates, INSERT blob_refs, UPDATE used_bytes, plus a cap SELECT). Those D1
writes are the measured plateau. They belong at commit (§23.4), not per PUT.

## Design
New `blobPut`:
```
auth → account
R2 put(blobKey(sha), body, { sha256: sha })   // R2 verifies the hash; sha_mismatch → 400
return 200 { ok, sha, size, receipt: mintReceipt(env,{account,sha,size,now}) }
```
- **No** `blobs` / `blob_refs` / `used_bytes` / `gc_candidates` writes here. `PUT`
  mutates only the R2 content object and returns proof that this account supplied bytes.
- `size` from the R2 `put` result (`obj.size`) — authoritative, server-measured.
- Same path for `multipartComplete` (`blobs.ts:166`) — it also returns a receipt.
- Quota fail-fast moves to `missingBlobs`/preflight as advisory information (§23.3/§23.5).
  The authoritative charge is only the commit transaction (§23.4). This intentionally
  accepts temporary orphan R2 bytes for pushes that never commit.

## What this removes / keeps
- Removes: lines 66–68 (INSERT blobs, DELETE gc_candidates, grantEntitlementWithQuota).
- Keeps: R2 sha-verified put (content integrity), the `SINGLE_PUT_MAX` → multipart gate.
- The content-store boundary is strict: no canonical metadata, quota, entitlement, head, or
  GC-condemnation state changes on the upload path.

## Backward compatibility
Old clients ignore the `receipt` field and expect entitlement-on-PUT. Gate by a request
header / CLI protocol version: if the client is pre-receipts, fall through to the **legacy
per-PUT grant** path (today's code, kept behind a flag) so a v0.1.x binary still works.
Deprecate after the min-CLI version moves past the receipts release.

## Correctness
- A PUT that succeeds in R2 but whose response is lost → client retries PUT (idempotent R2
  put by sha) → new receipt. Fine.
- No entitlement is granted here, so an unentitled account uploading bytes gains **no read
  access** until commit — preserves the M7 "unentitled gets 404" property.
- A PUT to an object that was previously in `gc_candidates` does not delete the candidate
  row. The successful commit does that atomically (§23.4). Until then, GC safety comes from
  object-age rechecks plus `RECEIPT_TTL < GC_GRACE` (§23.5), not from a per-PUT D1 mutation.
- A successful PUT is not a quota reservation. If the later commit is over cap, the head does
  not advance, no entitlement is granted, and the uploaded R2 bytes are reclaimed as orphans.

## Tests (worker / vitest)
- PUT returns `{receipt}` and performs **zero D1 writes** (assert via a D1 spy / no row deltas).
- Bad sha → 400 (R2 verify) and no receipt. Oversize → 413 → multipart.
- Legacy-flag PUT still grants entitlement (fallback path) and returns ok.
- Lost response / retry returns a fresh receipt without extra metadata writes.

## Depends on / Status
Depends on: §23.1. Status: **design**. Pairs with §23.3 (missingBlobs) + §23.4 (commit grant).
