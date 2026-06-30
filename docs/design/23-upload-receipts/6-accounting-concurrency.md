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

#### D1 spike pass criteria
Option A is acceptable only if the spike proves all of this against the real dev D1
environment (local SQLite/Miniflare alone is not enough):
- A single transactional D1 operation can capture the exact `sha256` rows inserted by
  `INSERT OR IGNORE INTO blob_refs(account_id, sha256) ... RETURNING sha256`, excluding
  duplicates and pre-existing entitlements.
- The same transaction can compute `newBytes = SUM(blobs.size_bytes)` for exactly that
  inserted set and use it in
  `UPDATE accounts SET used_bytes = used_bytes + newBytes WHERE used_bytes + newBytes <= cap`.
- If the cap update affects 0 rows or any later statement fails, the inserted `blob_refs`,
  inserted `blobs`, and `DELETE gc_candidates` effects roll back together.
- The implementation stays inside D1 limits after chunking (`≤100` bound params,
  `≤100 KB` statements, `30 s` batch) without splitting one logical commit into
  separately-committed charge phases.
- Returned/affected-row metadata is available to the Worker so the response can distinguish
  success, over-cap, and malformed/missing proof without a follow-up read that changes the
  accounting decision.

#### D1 spike fail criteria
Choose Option B immediately if any of these are true:
- D1 rejects `RETURNING` in `batch()`/transaction, or returns rows only after the transaction
  commits in a way that cannot feed the conditional quota update.
- The only workable D1 design computes `newBytes` from a Worker-side pre-read of
  `blob_refs`, from total candidate refs, or from `changes()`/row counts that cannot map
  rows to sizes. Those all reintroduce double-charge risk.
- Over-cap handling requires committing `blob_refs` before discovering the cap failure.
- Correctness depends on timing, retry order, or "D1 is single-threaded" without an atomic
  data dependency between inserted rows and the quota update.

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

## Required concurrency tests
Run these against whichever option is chosen. For Option A, they are also the D1 spike's
pass/fail suite and must run against dev D1, not only local SQLite.

1. **Overlapping concurrent grants**
   - Setup: same account, two different workspaces, no existing refs, cap comfortably high.
   - Commit A refs: `{x:10, y:20}`. Commit B refs: `{x:10, z:30}`.
   - Run A and B concurrently for many iterations from a clean DB.
   - Expected: both commits can succeed; `blob_refs` has x/y/z once for the account;
     `used_bytes` increases by exactly 60, never 70.

2. **Concurrent cap race**
   - Setup: same account, cap leaves room for only one of two disjoint commits.
   - Commit A refs total 60; Commit B refs total 60; remaining cap 80.
   - Run concurrently.
   - Expected: exactly one succeeds and one returns 402; `used_bytes` increases by 60 and
     never exceeds cap; failed commit leaves no `blob_refs`, `blobs` rows that were created
     solely for the failed grant if no other account/ref needs them, or `gc_candidates`
     cleanup from that failed transaction.

3. **Idempotent retry / duplicate submit**
   - Setup: same account/workspace parent conflict avoided by testing the grant helper or
     by retrying after a simulated lost response before head advance.
   - Submit the exact same ref set twice.
   - Expected: first grant charges the unique new refs; second grant inserts 0 refs,
     charges 0 bytes, and is safe whether it runs after or concurrently with the first.

4. **Candidate rollback**
   - Setup: candidate row exists for sha `x`; account has a valid receipt; cap too low.
   - Commit referencing `x` returns 402.
   - Expected: `gc_candidates(x)` remains. Repeat with sufficient cap: commit succeeds and
     `gc_candidates(x)` is deleted in the same transaction as the grant.

5. **Cross-account sharing**
   - Setup: accounts A and B commit the same sha concurrently with valid receipts.
   - Expected: one physical/catalog `blobs` row, one `blob_refs` row per account, and each
     account's `used_bytes` changes according to its own first entitlement only.

## Depends on / Status
Depends on: §23.4. Status: **design** — the A-vs-B spike is the first task here, and the
load-bearing risk for the whole §23 change. **Codex-review this chunk specifically.**
