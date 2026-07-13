# §30 — Large-ref commit accounting (lift the 6002-ref cap)

**Status:** DRAFT v3 — codex round-2 NEEDS-WORK was 2 BLOCKERs, **both** in the over-cap
*compensation*. v3 **removes compensation entirely** (codex's own endorsed option 1:
"keep successful prior batches charged/granted and make retries idempotent"), which
dissolves both blockers. Remaining MAJORs folded in below. Next gate: codex review of the
implementation diff.

## Problem (dogfood-confirmed, 2026-06-30)

Pushing a real workspace (`~/conductor/workspaces`, 74,005 files → **11,942 unique
blobs** after dedup) to prod uploaded every blob fine, then the commit was rejected:

```
commit failed: 413 {"error":"too_many_refs","max":6002}
```

`MAX_ACCOUNTING_REFS_PER_COMMIT = 6002` (`commit-accounting.ts:28`) caps the blob refs a
single commit may charge/grant. Any workspace with >~6000 unique blobs can't commit.

## Why the cap exists, and the real platform limits

A commit's accounting is **one atomic D1 `batch()`** (catalog `present=1` + charge via
NOT-EXISTS under `accounts_cap_guard` + grant), chunked at 33 rows/stmt for D1's
100-param limit. The original cap conservatively bounded total D1 work per commit.

**Verified platform facts** (Cloudflare docs, 2026-06):
- `batch()` "sends multiple SQL statements inside a single call" — it is **ONE
  subrequest**, executed as one SQLite transaction, regardless of statement count.
- A Worker invocation may make **≤1000 subrequests** to Cloudflare services (D1/R2/KV).
- Per-`batch()` ceiling is the **D1 isolate memory + CPU-time** for executing that
  transaction (docs: "split the query into smaller shards" on isolate reset).

So the binding constraint is **subrequest count per invocation**, and today's hog is
`validateCommitRefs`: 1 `.all()` SELECT per 90 refs = N/90 subrequests. Accounting is
currently ONE `batch()` (1 subrequest). Budget per commit invocation (≤1000 subreqs):

| refs | validate (N/90) | accounting batches (N/MAX_REFS_PER_TXN) | R2/other | total subreqs |
|------|-----------------|------------------------------------------|----------|---------------|
| 12k  | 134             | 4 (@3000)                                | ~3       | ~141  ✓       |
| 50k  | 556             | 17                                       | ~3       | ~576  ✓       |
| 100k | 1112            | 34                                       | ~3       | ~1149 ✗       |

→ **12k–50k is safe within one invocation; 100k is not** (validate SELECTs dominate).

## What makes the fix tractable (codex-CONFIRMED)

Codex round-1 confirmed: per-batch charge/grant ordering stays sound across super-
batches (D1 serialization + NOT-EXISTS ⇒ no double-charge/oversell for capped accounts);
crash-retry is sound (completed batches leave `blob_refs` + `present=1`, reclassified as
have-set on retry); head advances only after accounting ⇒ no published-head-unaccounted
path. Plus: direct-write sets `present=1` atomically with catalog (no `present=0` window).

## Design v2

### 1. Multi-`batch()` accounting (≤MAX_REFS_PER_TXN per batch)

`commitAccounting` loops super-batches of **MAX_REFS_PER_TXN = 3000** refs, each its own
atomic `db.batch()` (same 33-row catalog→charge→grant→un-condemn chunks). 3000 refs ≈
364 statements/batch — under the D1 isolate ceiling, and 1 subrequest each.

### 2. Validate in batched SELECTs (cut subrequests ~Nx)

`validateCommitRefs` groups its `present=1+entitled` SELECTs into ONE `db.batch()` per
super-batch instead of N/90 separate `.all()` round-trips. This collapses validate from
N/90 subrequests to ~N/3000, raising the safe ceiling well past 50k. (If batched-SELECT
isolate cost proves high, fall back to fewer-but-larger IN-lists.)

### 3. Over-cap: keep prior batches charged, idempotent retry (codex-endorsed option 1)

No compensation, no nonce, no rollback. On `over_cap` (the per-super-batch `cap_guard`
aborts that batch) we **return 402 and leave the completed super-batches charged+granted**.
This is correct because:

- Those refs are real entitlements: the account uploaded + possesses those blobs, charged
  exactly once (NOT-EXISTS). A concurrent commit validating against them sees finalized,
  durable `blob_refs` rows that are NEVER deleted — so codex round-2 BLOCKER 2 (validate
  against a transient grant) cannot occur.
- A retry of the same commit re-validates: the charged refs are now have-set (charge 0),
  the loop resumes at the first uncharged ref. Idempotent. Identical semantics to the
  **existing** head-409-after-accounting path (`workspace-sync.ts:221`).
- The orphan-when-abandoned case is reclaimed by global GC once the blob is globally
  unreachable; a globally-shared orphan persists under the pre-existing per-account-pruning
  gap (design 07b §d) — NOT introduced here.

This is the simplest correct design and matches what codex explicitly endorsed.

### 4. No pre-flight needed (codex MAJOR 3 dissolved)

We add NO stale-read pre-flight (codex correctly noted it only narrows false 402s). It
turns out none is needed: an account **already at/over cap** trips the `cap_guard` on the
**first** super-batch → that batch aborts → **zero charge, clean 402**. Partial charge can
only occur in the partial-fit case (`used < cap < used+total`), which §3 handles as
idempotent-retryable. So the authoritative per-batch `cap_guard` is the sole quota gate —
no stale estimate, no false 402.

### 5. Memory + ceiling (codex MAJOR 4)

- `MAX_REFS_PER_COMMIT = 50,000` (was the 6002 reject) as the hard sanity reject. But the
  **real ceiling is D1 isolate CPU/memory, not subrequests** (codex round-2 MAJOR): 50k is
  thousands of SQL statements + receipt verifications. We **ship + validate 12k on the real
  workload first**; 50k stays as the reject bound but is "behind dev measurement" until a
  load test at 25k/50k confirms the isolate holds. The §25 commit telemetry (count/latency)
  is the measurement surface.
- Guard the request body by ACTUAL bytes read (`readBodyCapped`, not the spoofable/absent
  Content-Length) and keep `MAX_REQUEST_BODY = 8MB` — sized so even a pathological JSON parses
  to a safe heap (~40-60MB) in the 128MB isolate (codex r4 MAJOR). This is a SECOND axis from
  the ref-COUNT ceiling: a cold push's receipt map must also fit 8MB (validated 12k ≈ 4MB);
  incremental pushes (few new receipts) reach `MAX_REFS_PER_COMMIT` freely.
- Cache the imported HMAC `CryptoKey` per key-string in `verifyReceipt` (codex MAJOR 4):
  12k receipts must not re-`importKey` 12k times.
- Sidecar allocation stays bounded by the R2 size gate (`sidecar.ts:40`).

### 6. cap_bytes must be non-zero everywhere (codex BLOCKER 5)

`accounts_cap_guard` only fires when `cap_bytes > 0` (`0014_upload_receipts.sql:60`), but
`unlinkAccount` (`account-link.ts:310`) and any other `INSERT INTO accounts` that omits
`cap_bytes` leave it 0 → the guard is DISABLED for that account, breaking the §4
compensation/oversell guarantee. Fix: set the free-plan `cap_bytes` on every account
insert (bootstrap, unlink, web-shell), and a one-time backfill/assert that no tenant
account has `cap_bytes <= 0`.

### 7. Name every cap touched (codex MINOR 6)

`MAX_ACCOUNTING_REFS_PER_COMMIT` (→ removed/renamed `MAX_REFS_PER_COMMIT`=50k), plus the
independent sidecar sanity cap in `workspace-sync.ts:12,60` — reconcile both to 50k so
there is no second hidden ceiling.

## No client change

Client already uploads all blobs + builds the sidecar (>4000 refs → sidecar). Once the
server accepts the refs the existing `rbox push` succeeds.

## Test + validation plan

- Unit (vitest, apps/api `test/spike-d1-charge.test.ts`, real workerd D1): N > MAX_REFS_PER_TXN
  charges/grants every ref exactly once across super-batches; idempotent re-run charges 0;
  over-cap mid-loop keeps the completed super-batches charged (NOT rolled back, NOT 0) and
  returns overCap; retry-after-cap-raise completes the rest; the 0016 trigger materializes
  cap_bytes on a tenant insert (and leaves platform `default` at 0).
- **Empirical (the real measurement):** deploy to **dev**, push `~/conductor/workspaces`
  (11,942 blobs) → commit succeeds; observe actual subrequest/latency; then prod; pull on
  flat-meadow; verify byte-identical; capture before/after timing.
