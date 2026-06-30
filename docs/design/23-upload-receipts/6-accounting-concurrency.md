# §23.6 — Account accounting under concurrency (no double-charge)

> Chunk of [§23](../23-upload-receipts.md). The correctness decision behind §23.4's
> `newBytes`: how to charge exactly-once when commits for one account race.

## Problem
One account can have **multiple workspaces** committing concurrently. Each commit (§23.4)
computes `newBytes` (sum of sizes of refs newly granted to the account) and charges
`used_bytes`. Two hazards:
1. **Read-then-write race** — if a commit does `SELECT existing refs` in the Worker, then
   `UPDATE used_bytes`, two concurrent commits can both see a ref as "new" and double-charge,
   or both pass the cap check and overspend.
2. **Cross-statement disagreement** — the set used to compute `newBytes` must equal the set
   actually inserted into `blob_refs`, atomically.

## Options

### Option A — D1 batch, charge from actual inserts (preferred if expressible)
Within one `batch()` (transactional):
- `INSERT OR IGNORE INTO blob_refs …` — only truly-new rows insert.
- Charge `used_bytes` by the sizes of *exactly those inserted rows*, in the same transaction.

The trick: D1 can't trivially "sum sizes of just-inserted rows" in one UPDATE. Approaches:
- Carry sizes via the `blobs` table: after `INSERT OR IGNORE blobs`, do
  `UPDATE accounts SET used_bytes = used_bytes + (SELECT COALESCE(SUM(b.size_bytes),0)
   FROM blobs b WHERE b.sha256 IN (…just-inserted blob_refs…))` — but "just-inserted" needs
  capturing. SQLite `RETURNING` on the `INSERT OR IGNORE` gives the inserted shas; if D1
  supports `RETURNING` in a batch, sum those. **Validate D1 `RETURNING` support** (it's the
  crux — codex flagged D1's single-threaded transactional batch as the right tool but the
  per-row sum is the open detail).
- The conditional cap `UPDATE … WHERE used_bytes + n <= cap` then guards overspend atomically.

If A is cleanly expressible → simplest (no new infra). **Spike this against D1 first.**

### Option B — AccountAccounting Durable Object (fallback, robust)
One DO per account (`idFromName(accountId)`) owns `used_bytes` + the entitled-ref set in
DO storage; serializes all grants in-memory; the commit calls it once with the candidate
refs; it returns `{ granted, newBytes, over }` and flushes to D1 as a mirror/admin index.
- Pro: trivially race-free (single-threaded DO), exact, no D1 RETURNING dependency.
- Con: another DO in the path, a second storage of truth (DO storage vs D1) to keep
  consistent, migration of existing `used_bytes`/`blob_refs` into the DO.
- Mirrors Dropbox's "one clear control thread for coordination" (Nucleus lesson, §22).

## Decision rule
Try **A** (D1 `RETURNING` + transactional batch). If D1 can't express the
sum-of-just-inserted race-safely, adopt **B**. Either way the **conditional cap UPDATE**
provides the overspend guard; the open question is only exact attribution of `newBytes`.

## Tests
- Two concurrent commits (same account, different workspaces) referencing an overlapping
  new blob → charged exactly once total; used_bytes correct.
- Concurrent commits that together exceed cap → exactly one fails (402); used_bytes ≤ cap.
- Idempotent retry → 0 additional charge.

## Depends on / Status
Depends on: §23.4. Status: **design** — the A-vs-B spike is the first task here, and the
load-bearing risk for the whole §23 change. **Codex-review this chunk specifically.**
