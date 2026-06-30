# §23.5 — Quota timing + orphan-byte reclamation

> Chunk of [§23](../23-upload-receipts.md). Owns the consequence of moving the
> authoritative quota charge to commit: uploaded-but-never-committed R2 bytes.

## Problem
With the charge at commit (§23.4), a push can upload N blobs to R2 then never commit
(over quota, crash, ^C). Those R2 objects are unreferenced (no `blobs`/`blob_refs` row) =
**orphans** that cost storage and, if a stale receipt outlived GC, could be wrongly grantable.

## Design — two halves

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

### B. Orphan reclamation (the coupling that makes it safe)
- **Invariant: `RECEIPT_TTL < GC_GRACE`.** A receipt can only resurrect a blob while the
  blob is still within GC grace → a receipt can never grant a blob GC already purged.
- An R2 object with **no `blobs` row** older than `RECEIPT_TTL` is an orphan → eligible for
  deletion. (A committed blob always has a `blobs` row from §23.4's batch.)
- Reclamation runs as the §P2 **reconciliation Queue / cron** (`docs/backlog.md` #7): list
  R2 by prefix, left-anti-join against `blobs`, delete objects past TTL via R2 batch delete
  (≤1000 keys/call). Never on the commit hot path.

## Correctness
- A blob uploaded, referenced at commit within TTL → gets a `blobs` row → never orphaned. ✓
- A blob uploaded, never committed → no `blobs` row → orphan, reaped after TTL. ✓
- A `present` blob (already had a `blobs` row from a prior commit) is never an orphan even
  if this push abandons. ✓
- Convergent dedup: two accounts uploading the same content both create the same R2 object;
  the first to commit creates the `blobs` row; the object is shared. Orphan logic keys on
  the `blobs` row, not per-account — correct (R2 object is account-agnostic; entitlement is
  per-account in `blob_refs`).

## Open question
Pick `RECEIPT_TTL` (e.g. 1h) and confirm `GC_GRACE` (current retention/GC condemnation
window) is comfortably larger. Document the relationship next to both constants.

## Tests
- Upload-then-abandon leaves an R2 object with no `blobs` row; reconciliation deletes it
  after TTL, not before. Receipt expires before GC grace (assert TTL < grace in a test).
- Over-cap push: advisory remaining warns; if forced, commit 402s; orphans reaped.

## Depends on / Status
Depends on: §23.4 (commit owns the `blobs` row), backlog #7 (reconciliation worker).
Status: **design**.
