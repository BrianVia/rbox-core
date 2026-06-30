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
[cheap cap pre-check]   // see §23.5: advisory only, from cached/approx used_bytes
R2 put(blobKey(sha), body, { sha256: sha })   // R2 verifies the hash; sha_mismatch → 400
return 200 { ok, sha, size, receipt: mintReceipt(env,{account,sha,size,now}) }
```
- **No** `blobs` / `blob_refs` / `used_bytes` / `gc_candidates` writes here.
- `size` from the R2 `put` result (`obj.size`) — authoritative, server-measured.
- Same path for `multipartComplete` (`blobs.ts:166`) — it also returns a receipt.

## What this removes / keeps
- Removes: lines 66–68 (INSERT blobs, DELETE gc_candidates, grantEntitlementWithQuota).
- Keeps: R2 sha-verified put (content integrity), the `SINGLE_PUT_MAX` → multipart gate.
- The cap pre-check stays but becomes a cheap advisory read (§23.5), not the authoritative
  per-blob charge — that moves to §23.4.

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

## Tests (worker / vitest)
- PUT returns `{receipt}` and performs **zero D1 writes** (assert via a D1 spy / no row deltas).
- Bad sha → 400 (R2 verify) and no receipt. Oversize → 413 → multipart.
- Legacy-flag PUT still grants entitlement (fallback path) and returns ok.

## Depends on / Status
Depends on: §23.1. Status: **design**. Pairs with §23.3 (missingBlobs) + §23.4 (commit grant).
