# §23.4 — Commit-time batched grant (the D1 win)

> Chunk of [§23](../23-upload-receipts.md). Depends on §23.1–17.3.
> Where the per-blob D1 work collapses into O(chunks) per commit.

## Problem
Per-blob D1 accounting must happen somewhere. The commit is the right place: it already
knows the full ref set (or fetches the §24 sidecar), runs once per push, and is the
publish point (entitlement only matters once content is referenced).

## Design
In the `workspace-sync` commit handler, BEFORE advancing head:

1. **Resolve refs** — from the commit body or §24 sidecar: `[{ encSha, size }]`.
2. **Validate each ref** — require ONE of:
   - already in `blob_refs(account_id, encSha)` (entitled), or
   - a valid receipt (§23.1 verify: HMAC, unexpired, account+sha+size match).
   Otherwise → `422 { error: needs_upload, shas: [...] }`. (Client uploads, retries.)
3. **Compute deltas** — `newRefs` = refs not already entitled; `newBytes = Σ newRefs.size`.
4. **One D1 `batch([...])`** (transactional), chunked to D1 limits (≤100 bound params,
   ≤100 KB/statement → multi-row INSERTs in groups of ~50, multiple batches if needed):
   ```sql
   INSERT OR IGNORE INTO blobs(sha256,size_bytes)        VALUES …(newRefs)…;
   INSERT OR IGNORE INTO blob_refs(account_id,sha256)    VALUES …(newRefs)…;
   DELETE FROM gc_candidates WHERE sha256 IN (…newRefs…);
   UPDATE accounts SET used_bytes = used_bytes + ?newBytes
     WHERE id = ? AND used_bytes + ?newBytes <= ?cap;          -- conditional charge
   ```
5. **Quota gate** — if the conditional `UPDATE` changed 0 rows → over cap → `402`, **do not
   advance head**, grant rolled back (batch is atomic). Orphan R2 bytes reaped by GC (§23.5).
6. **Advance head** — unchanged DO sequencer (`seq=parent+1`, signed-chain checks).

## D1 limits (verified, §22)
100 bound params / statement, 100 KB / statement, 30 s / batch, single-threaded per DB.
→ chunk `newRefs` into batches of ~40–50 rows; cap total refs (already `MAX_BLOB_REFS`).

## newBytes correctness (the subtle part) — see §23.6
`newBytes` must reflect only refs that were NOT already entitled, computed race-safely
against concurrent same-account commits. Deriving it from `INSERT OR IGNORE … blob_refs`
**actual `changes`** (rows truly inserted) inside the transaction is the goal; if D1's
batch semantics can't express "sum of sizes of just-inserted rows," fall back to the
AccountAccounting DO (§23.6). This chunk assumes the D1-batch path; §23.6 owns the decision.

## Idempotency
A commit retried after a 409 (parent moved) or a network blip must not double-charge:
`INSERT OR IGNORE` makes ref inserts idempotent; `newBytes` derived from actual inserts
(not a pre-count) means a re-run inserts 0 new rows → charges 0. Safe.

## Tests (worker)
- Commit with all-entitled refs → 0 new charge, head advances.
- Commit with receipts → grants in one batch, used_bytes += Σ new sizes, head advances.
- Missing receipt+unentitled → 422, head unchanged.
- Over-cap → 402, head unchanged, no partial grant.
- Duplicate-content refs (same encSha twice) → charged once.
- Retry same commit → no double-charge.

## Depends on / Status
Depends on: §23.1–17.3 (+ §24 for large ref sets). Status: **design**.
The throughput payoff lives here — bench before/after with `push-sweep`.
