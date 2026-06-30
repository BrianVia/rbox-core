# §23.6 — Account accounting under concurrency (no double-charge)

> Chunk of [§23](../23-upload-receipts.md). The correctness decision behind §23.4's
> `newBytes`: how to charge exactly-once when commits for one account race.
> **v2:** resolves the codex B3 finding. The charge is computed **in-SQL via `NOT EXISTS`**
> inside one transactional batch — no `RETURNING`, no Worker-side pre-read. D1's
> single-threaded-per-DB serialization makes it exactly-once. The `RETURNING`-based "Option A"
> and the AccountAccounting-DO "Option B" of v1 are demoted to a contingency (below).

## Problem
One account can have **multiple workspaces** committing concurrently. Each commit (§23.4)
charges `used_bytes` by `newBytes` (Σ sizes of refs newly granted to the account). Two hazards:
1. **Read-then-write race** — if a commit does `SELECT existing refs` in the Worker, then
   `UPDATE used_bytes`, two concurrent commits can both see a ref as "new" and double-charge.
2. **Cross-statement disagreement** — the set used to compute `newBytes` must equal the set
   actually inserted into `blob_refs`, atomically.

## Why the in-SQL `NOT EXISTS` charge is exactly-once
The §23.4 post-publish batch runs, in one transaction, in this order:
```
catalog:  INSERT OR IGNORE blobs(sha256, size_bytes) …
charge:   UPDATE accounts SET used_bytes = used_bytes
            + (SELECT COALESCE(SUM(b.size_bytes),0) FROM blobs b
               WHERE b.sha256 IN (…) AND NOT EXISTS
                 (SELECT 1 FROM blob_refs r WHERE r.account_id=? AND r.sha256=b.sha256))
          WHERE id = ?
grant:    INSERT OR IGNORE blob_refs(account_id, sha256) …
```
Two facts combine to make this correct:
- **The charge reads `blob_refs` BEFORE the grant writes it** (charge statement precedes the
  grant statement). So within one commit, `newBytes` = sizes of refs this account did not
  already hold.
- **D1 is single-threaded per database.** `batch()` is one transaction; two concurrent
  `batch()` calls for the same account DB cannot interleave at the statement level — one runs
  fully, commits, then the other runs. So a second commit's `NOT EXISTS` observes the first
  commit's grant and charges 0 for the shared refs.

Therefore: no Worker-side read-then-write window (hazard 1 gone — the read and the dependent
write are the same SQL statement), and the charged set equals the granted set by construction
(hazard 2 gone). Disjoint refs across two racing commits each charge once; shared refs charge
exactly once total, to whichever transaction D1 serializes first.

This is the load-bearing assumption. The **first implementation task is a D1 spike** that
proves it against the real dev D1 (not just local SQLite/Miniflare). See pass/fail below.

## Quota: hard cap via CHECK constraint (B2)
The charge runs in the same pre-publish batch (§23.4 v3). Over-cap is enforced by a table
**`CHECK (used_bytes <= cap_bytes)`** on `accounts`, NOT by a conditional `WHERE used+n<=cap`
(a 0-row UPDATE does not roll back a D1 `batch()` — codex B2). When the charge `UPDATE` would
exceed cap the CHECK fails the statement → the whole transaction (catalog + charge + grant)
rolls back → 402, head not advanced. Because D1 serializes each account's batches, the CHECK
in commit *k* sees the committed `used_bytes` of commits `1..k-1`, so N concurrent workspaces
cannot each pass an independent preflight and overshoot — the "100 workspaces × 1 GiB →
100 GiB" storm is impossible; every commit past `cap` aborts. The §23.3 advisory `remaining`
is now pure UX; the CHECK is the authority.

## D1 spike — pass criteria
The in-SQL charge is acceptable only if the spike proves ALL of this against dev D1:
- A single transactional `batch()` computes `newBytes` from `SUM(blobs.size_bytes)` over
  exactly the referenced shas `WHERE NOT EXISTS (… blob_refs …)`, evaluated against the
  pre-grant state, and applies it to `used_bytes` in the same transaction.
- The subsequent `INSERT OR IGNORE blob_refs` grants exactly that set; a re-run grants 0 and
  charges 0.
- Two concurrent same-account batches serialize: total `used_bytes` delta = Σ sizes of the
  union of new refs, never the multiset sum (no double-charge on shared refs).
- A `CHECK (used_bytes <= cap_bytes)` violation on the charge `UPDATE` **rolls back the entire
  `batch()`** (catalog + charge + grant) — confirm D1 surfaces it as a statement error, not a
  silently-swallowed constraint. This is the B2 hard-cap gate.
- Everything stays within D1 limits after chunking (≤100 bound params, ≤100 KB/stmt,
  ≤30 s/batch) without splitting one logical commit into separately-committed phases.
- Affected-row metadata lets the Worker shape the response (success / soft-overage / malformed
  proof) without a follow-up read that changes the accounting decision.

## D1 spike — fail criteria → fall back to Option B
Adopt the AccountAccounting DO if any of these hold:
- D1 cannot evaluate the `NOT EXISTS` subquery against pre-grant state within the same
  transaction as the grant (e.g. statement-level snapshot surprises).
- Two concurrent batches are observed to double-charge a shared ref (serialization weaker than
  assumed).
- Chunking the charge across multiple statements breaks the single-transaction guarantee.

### Option B — AccountAccounting Durable Object (contingency)
One DO per account (`idFromName(accountId)`) owns `used_bytes` + the entitled-ref set in DO
storage, serializes all grants in-memory, returns `{ granted, newBytes }`, and mirrors to D1
for admin queries. Trivially race-free, no D1 transaction-semantics dependency. Cost: another
DO hop on commit, a second source of truth to reconcile, and migrating existing
`used_bytes`/`blob_refs` into the DO. Only if the spike fails.

## Required concurrency tests
These ARE the spike's pass/fail suite (run against dev D1, not only local SQLite):

1. **Overlapping concurrent grants** — same account, two workspaces, no existing refs, high
   cap. A refs `{x:10,y:20}`, B refs `{x:10,z:30}`, run concurrently many iterations from a
   clean DB. Expect: both succeed; `blob_refs` has x/y/z once; `used_bytes` += exactly 60.

2. **Concurrent shared-ref race** — A and B both reference only `{x:10}`. Expect: x granted
   once; `used_bytes` += exactly 10 (charged to whichever serializes first), never 20.

3. **Idempotent retry / duplicate submit** — submit the same ref set twice. Expect: first
   charges the unique new refs; second inserts 0 refs, charges 0.

4. **Promote + grant atomicity** — account holds a valid receipt for staging sha `x`. Commit
   promotes `staging→canonical` then grants in the batch. Assert the canonical object exists
   after a successful commit and is untouched by a subsequent staging-GC pass. If the DO 409s
   after the grant, the canonical object and `blob_refs(x)` are durable (retry charges 0).

5. **Cross-account sharing** — accounts A and B commit the same sha concurrently with valid
   receipts. Expect: one `blobs` row, one `blob_refs` row per account, each account's
   `used_bytes` reflects only its own first entitlement.

## Depends on / Status
Depends on: §23.4. Status: **design (v2)** — the D1 spike is the first implementation task and
the load-bearing risk for the whole §23 change. **Codex-review this chunk specifically.**
