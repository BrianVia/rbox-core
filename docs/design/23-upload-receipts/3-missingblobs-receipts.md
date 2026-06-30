# §23.3 — `missingBlobs` returns receipts for already-present blobs

> Chunk of [§23](../23-upload-receipts.md). Depends on [§23.1](1-receipt-primitive.md).
> Closes the "present in R2 but unentitled to me" gap so the client never re-uploads
> existing content yet can still reference it at commit.

## Problem
`missingBlobs` (`blobs.ts:32`) is called *before* uploading to decide what to PUT. With
receipts, three states exist per encSha:
1. **absent** in R2 → client must upload (PUT → receipt).
2. **present in R2, already entitled** to this account → reference directly at commit
   (the `blob_refs` row exists). No upload, no receipt needed.
3. **present in R2, NOT entitled** to this account (prior abandoned push, or convergent
   dedup across accounts) → client should NOT re-upload, but has nothing to present at
   commit. **This is the gap.**

## Design
`missingBlobs` returns three buckets instead of one:
```
POST /v1/blobs/check  { shas: [...] }
→ { missing: [...],                  // absent in R2 → upload
    present: [{ sha, receipt }, ...], // in R2, not entitled → carry receipt to commit
    // (entitled shas are simply omitted: nothing to do)
  }
```
For each `present` sha the server confirms R2/`blobs` existence and **mints a receipt**
(§23.1) so the client can reference it at commit without uploading.

It also returns advisory quota (§23.5): `{ used, cap, remaining }`.

## Why mint here (not let commit R2-head each blob)
Alternative: commit verifies "present" refs by R2 `head` per blob. That reintroduces a
per-blob server op at commit (the thing we're removing). Minting the receipt in the
already-happening `check` call (which already does the `blobs IN (…)` lookup) is free-ish
and keeps commit to O(chunks).

## Correctness
- A receipt minted for a `present` blob asserts existence at check time; if GC condemns it
  between check and commit, commit's `DELETE gc_candidates` + the `blobs` row keep it alive
  (resurrect). RECEIPT_TTL < GC grace guarantees the window is safe (§23.5).
- Entitlement is still NOT granted by `check` — only commit grants. `present` just means
  "don't re-upload."
- Privacy: returning "present" reveals cross-account byte-equality, which convergent
  encryption already leaks within a key epoch (documented). No new leak.

## Tests
- absent → `missing`; entitled → omitted; present-unentitled → `present` with a valid
  receipt that §23.4 accepts. Quota fields present. Tampered returned receipt → commit rejects.

## Depends on / Status
Depends on: §23.1. Status: **design**. Required by §23.4 (commit accepts these receipts).
