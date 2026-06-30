# §23.3 — `missingBlobs` stays no-oracle; receipts stay client-held

> Chunk of [§23](../23-upload-receipts.md). Depends on [§23.1](1-receipt-primitive.md).
> Keeps the M7 "unentitled sees missing" guarantee while letting a client use receipts it
> already earned from upload.

## Problem
`missingBlobs` (`blobs.ts:32`) is called before uploading to decide which refs still need
proof. §07 makes the privacy contract load-bearing: an unentitled caller must not learn
whether a sha exists globally in R2. The old "present but unentitled → return receipt"
shape would turn `missingBlobs` into a cross-account existence oracle.

## Design
`missingBlobs` remains account-scoped:
```
POST /v1/blobs/check  { shas: [...] }
→ { missing: [...], quota: { used, cap, remaining } }
```
- Entitled **AND `blobs.present=1`**: omitted. The client can reference it at commit with no
  receipt because the account holds it and the canonical object is confirmed present (and never
  deleted by §23, §23.5). Entitlement *plus the present flag* is what reliably implies the bytes
  exist — `blob_refs` alone is billing, not presence (§23.4 v8).
- Entitled but `present=0` (a ref whose promote hasn't confirmed yet): returned in `missing`,
  exactly like an unentitled ref. The client uploads → receipt → commit promotes it → `present=1`.
- Not entitled: returned in `missing`, even if the object exists globally in canonical R2 or
  in `blobs`. The client must either already hold a valid same-account upload receipt for
  that sha+size, or upload the bytes to its staging namespace to get one (§23.2).
- Advisory quota is returned here (§23.5). It is a user-experience preflight, not a
  reservation and not the authoritative cap gate (the commit `CHECK` is).

Implementation order must avoid timing/existence leaks:
1. Query `blob_refs` for the caller's account and requested shas.
2. Treat every non-entitled sha as `missing` without probing R2/global `blobs`.
   (v4 has no `gc_candidates` — there is nothing condemned to special-case.)

## Why not mint receipts here
Minting a receipt from global R2/`blobs` presence would assert "the platform has this sha"
to an account that has not proved possession. That violates §07's rule that unentitled
callers always see missing/404 and cannot distinguish "absent" from "belongs to another
account."

Receipts are therefore minted only after the server observes the caller upload hash-verified
bytes to its own staging namespace (§23.2). If a client loses a receipt, it re-uploads; the R2
write is idempotent by staging key, and the extra bandwidth is the cost of preserving the
no-existence-oracle guarantee. Commit does not R2-`head` each ref; it promotes the staging
object (proven by the receipt, guaranteed present by `RECEIPT_TTL < STAGING_GC_GRACE`) to
canonical (§23.4).

## Correctness
- No cross-account `present` bucket. `missing` intentionally conflates physically absent and
  globally present-but-unentitled from the caller's perspective.
- A same-account abandoned upload is usable only if the client still has the upload receipt.
  If not, it must upload again and get a fresh receipt. This preserves privacy over the
  optimization of avoiding all duplicate uploads.
- Entitlement is still NOT granted by `check` — only commit grants. `check` is a planning
  endpoint and advisory quota source.
- No PUT-side or check-side metadata writes at all; the no-oracle guarantee is purely a
  `blob_refs`-first query that never touches global `blobs`/R2 for unentitled shas.

## Tests
- Absent → `missing`; entitled → omitted; globally present but unentitled → `missing`
  with no receipt and indistinguishable body/status/timing budget from absent.
- Valid client-held PUT receipt for a `missing` sha is accepted by §23.4; tampered/expired
  receipt is rejected.
- Quota fields present and marked advisory; racing commit can make them stale.

## Depends on / Status
Depends on: §23.1. Status: **design**. Required by §23.4 (commit accepts these receipts).
