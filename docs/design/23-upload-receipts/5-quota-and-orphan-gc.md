# §23.5 — Quota timing + orphan-byte reclamation

> Chunk of [§23](../23-upload-receipts.md). Owns the consequence of moving the
> authoritative quota charge to commit: uploaded-but-never-committed R2 bytes.

## Problem
With the charge at commit (§23.4), a push can upload N blobs to R2 then never commit
(over quota, crash, ^C). Those R2 objects are unreferenced (no `blobs`/`blob_refs` row) =
**orphans** that cost storage and, if a stale receipt outlived GC, could be wrongly grantable.

## Design — three phases

### A. Fail-fast preflight (cheap, advisory)
Keep users from uploading a doomed push:
- `missingBlobs`/check returns `{ used, cap, remaining }` (§23.3). The client knows its
  total push size and refuses locally if `total > remaining` — **before** any upload.
- This is advisory (a racing commit could change `used`); the authoritative gate is the
  commit conditional `UPDATE` (§23.4). Advisory + authoritative = no surprise mid-upload,
  no double-source-of-truth.
- Explicitly NOT a reservation: reservations need their own cleanup/TTL and a second DO/D1
  write per push. The advisory-remaining + commit-authority + GC-for-orphans combination is
  simpler and self-healing.

### B. Commit-time authority
- `PUT` creates only an R2 object + receipt (§23.2). It does not create `blobs`, grant
  `blob_refs`, clear `gc_candidates`, or reserve quota.
- Commit is the first authoritative metadata mutation: it validates entitlement/receipts,
  inserts `blobs`/`blob_refs`, deletes `gc_candidates` for receipt-revived refs, and
  conditionally charges `used_bytes` (§23.4).
- If commit returns 402/422/409 or the client abandons the push, no entitlement exists and
  any uploaded-only R2 objects remain temporary orphans. That is accepted by design.

### C. Orphan reclamation (the coupling that makes it safe)
- **Invariant: `RECEIPT_TTL < GC_GRACE`.** A receipt expires before the current R2 object
  version can be orphan-purged. Therefore commit never accepts a receipt for bytes that
  platform GC is allowed to have already deleted.
- An R2 object with **no `blobs` row** whose current R2 `uploaded`/last-modified time is
  older than `GC_GRACE` is an orphan eligible for deletion. A committed blob always has a
  `blobs` row from §23.4's batch.
- Reclamation runs as the §P2 **reconciliation Queue / cron** (`docs/backlog.md` #7): list
  R2 by prefix, left-anti-join against `blobs`, and delete orphan objects older than
  `GC_GRACE` via R2 batch delete (≤1000 keys/call). Never on the commit hot path.

## `gc_candidates` lifecycle
The old per-PUT path deleted `gc_candidates` to resurrect a condemned blob. The receipt path
cannot do that without putting D1 back on the upload hot path, so ownership changes:
- `missingBlobs` treats any candidate as `missing` (§23.3). The client must have a valid
  receipt already or upload to get one.
- `PUT` may overwrite the canonical R2 key and mint a receipt, but it still does **not**
  delete the candidate row.
- Successful commit deletes `gc_candidates` for receipt-revived refs in the same transaction
  that inserts `blob_refs` and charges quota (§23.4).
- GC purge must re-check the current R2 object before deletion. If the candidate row's
  `marked_at` predates the current R2 object version/last-modified time, the candidate is
  stale from before a new upload; clear/re-mark it, but do not purge it on that pass.
- The purge rule is therefore: delete only when the current object is still unreferenced,
  still candidate/uncataloged, and older than `GC_GRACE`. Since `RECEIPT_TTL < GC_GRACE`,
  any receipt for that current object has already expired.

## Correctness
- A blob uploaded, referenced at commit within TTL → gets a `blobs` row → never orphaned. ✓
- A blob uploaded, never committed → no `blobs` row → orphan, reaped after `GC_GRACE`. ✓
- A blob uploaded, then commit over cap → no `blobs`/`blob_refs`/quota mutation → orphan,
  reaped after `GC_GRACE`. ✓
- A cataloged blob (already had a `blobs` row from a prior commit) is never an orphan even
  if this push abandons. ✓
- Convergent dedup: two accounts uploading the same content both create the same R2 object;
  the first to commit creates the `blobs` row; the object is shared. Orphan logic keys on
  the `blobs` row, not per-account — correct (R2 object is account-agnostic; entitlement is
  per-account in `blob_refs`).
- A candidate overwritten by a new PUT is not purged based on the old candidate mark; purge
  sees the newer current R2 object version and leaves it for commit or the next orphan cycle. ✓

## Open question
Pick `RECEIPT_TTL` (e.g. 1h) and confirm `GC_GRACE` (current retention/GC condemnation
window) is comfortably larger. Document the relationship next to both constants.

## Tests
- Upload-then-abandon leaves an R2 object with no `blobs` row; reconciliation deletes it
  after `GC_GRACE`, not before. Receipt expires before GC grace (assert TTL < grace in a test).
- Over-cap push: advisory remaining warns; if forced, commit 402s; orphans reaped.
- Candidate overwrite race: candidate marked at T0, PUT overwrites at T1>T0, purge at
  T0+grace observes current R2 last-modified T1 and does not delete; successful commit
  clears the candidate row.

## Depends on / Status
Depends on: §23.4 (commit owns the `blobs` row), backlog #7 (reconciliation worker).
Status: **design**.
