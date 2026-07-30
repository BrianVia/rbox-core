# 228 — The billing flip: bill, show and gate on active bytes

Status: **IMPLEMENTED IN THIS BRANCH** (small design; design 225 shipped the
groundwork and §2.10 there deferred exactly this cycle).
Depends on: 225 (`fairuse_scans.active_bytes`, `history_computed=0`).

Founder ruling (verbatim, 2026-07-29): **"we only ever bill on active bytes not
history."**

## 0. Level-set — what "helped" means

**Helped (falsifiable):** for an account with a completed active-only scan,
every number rbox shows the customer, and every plan-cap comparison that can
block them, is derived from that scan's `active_bytes` — not from
`accounts.used_bytes`, which counts every ref the account has ever uploaded and
not yet had pruned. On the founder's prod account that is the difference between
**120.96 GB** (ledger) and **~3.91 GB** (active): today the dashboard says he is
over a 50 GB plan and the D1 cap guard would block his next push, for bytes we
have ruled we do not bill.

**What could get worse:** the cap stops binding. If the flip forgives more than
the real history, an account can store more than it pays for. Every forgiveness
below is therefore derived from a *measured* number, defaults to zero, and
self-corrects on the next hourly scan.

## 1. Consumers of `accounts.used_bytes` — the complete ledger

| Site | What it does | Verdict |
|---|---|---|
| `billing.ts:15` `account()` | reads plan/extra/used | **flips** — also reads the overhang, exposes `billable` |
| `billing.ts:29` `wouldExceedCap` | advisory pre-upload 402 | **flips** to billable |
| `billing.ts:40` `wouldExceedCapAggregate` | advisory pack-PUT 402 | **flips** to billable |
| `billing.ts:187` `usage()` → `usedBytes`, `readOnly` | THE dashboard/CLI number | **flips** to billable |
| `commit-accounting.ts:171/300` over-cap report | the `used`/`cap` in the 402 body | **flips** to billable (report only) |
| `migrations/0014_upload_receipts.sql:60` `accounts_cap_guard` | the authoritative hard gate | **flips** its comparison to billable; still fires on the live counter |
| `billing.ts:88/139`, `commit-accounting.ts:211` charges | `used_bytes += size` | **stays** — the ledger is the ledger |
| `billing.ts:174` `releaseUsage`, `gc-phase1.ts:156/268` | GC decrement + reconciler | **stays** |
| `migrations/0016`/`0021` `accounts_cap_on_insert`, `accounts_cap_sync` | materialize `cap_bytes` | **stays** — cap side, not usage side |
| `account-link.ts:336` `judgeReclaimable` | "is this web shell empty?" | **stays** — a shell holding history bytes is not empty |
| `admin.ts:210` `SUM(used_bytes)` | founder cockpit total | **stays** — internal "bytes we are storing", not a bill |

## 2. Mechanism — one materialized number, one owner

### 2.1 The primitive

```
billable_bytes(account) = MAX(0, used_bytes − history_overhang_bytes)
```

`accounts.history_overhang_bytes` (new, `NOT NULL DEFAULT 0`) is **the ledger
bytes we have measured and decided not to bill**. It is written by exactly one
site: the fair-use scan's completion batch (§2.3).

Owner: `plans.ts` — `billableBytes(used, overhang)` (pure) and
`BILLABLE_BYTES_SQL`. `plans.ts` already owns `capBytesFor`, i.e. the cap side
of the comparison; this is the usage side. It imports nothing, so
`billing.ts` and `commit-accounting.ts` both use it with no cycle.

**Why materialize instead of joining `fairuse_scans` at each read.** Three
reasons, any one decisive:

- `wouldExceedCap` runs per upload. A second D1 read per upload is a real cost
  on the hot path; reading one more column of a row we already read is free.
- The D1 cap-guard trigger cannot afford a correlated subquery into
  `fairuse_scans` on every `used_bytes` charge. `cap_bytes` is materialized on
  `accounts` (`0014`, `0016`) for exactly this reason; this follows the
  established pattern rather than inventing a second one.
- Because the trigger and the app read the *same column*, the advisory check and
  the authoritative guard **agree by construction**. A flip that moved only the
  advisory checks would be worse than no flip: the user would pass the fast-fail
  and then get a 402 from the trigger anyway.

### 2.2 Why this is not commit-time `active_bytes` (the settled constraint)

Delta admission never sees the full ref set, so commit-time `active_bytes` is
unsound — settled, not re-litigated here. The live counter stays the admission
input. What changes is the *allowance*:

```
used_bytes − overhang  =  active_bytes(last scan)  +  net ledger delta since that scan
```

which is precisely design 225 §2.10's "a live delta term on top of the last
completed epoch", with the delta term supplied by the counter that was already
there. No new counter, no new admission read, no commit-time ref-set knowledge.

### 2.3 Where the overhang is written

`completeScan` (`fairuse.ts`) is already **the single site** that writes
`fairuse_scans.active_bytes`. It becomes a two-statement `db.batch` — one D1
transaction, statements applied in order, so the second sees the first:

```sql
UPDATE accounts
   SET history_overhang_bytes = MAX(0, used_bytes − (SELECT s.active_bytes …))
 WHERE id = ? AND EXISTS (… that scan row is now 'complete' …)
```

The `EXISTS` makes it a no-op when the guarded completion UPDATE did not apply,
so a lost lease or a stale epoch never rewrites the overhang. `fairuse_scans`
rows are unique per `(account_id, epoch)`, so the subquery is single-valued.

**`used_bytes` is read at completion, not at capture — deliberately.**
`active_bytes` is as-of head snapshots taken during the pass, so bytes uploaded
between the snapshot and completion are counted into the overhang and briefly
forgiven. Bounded by one epoch's uploads (≤1 h), and self-correcting: the next
scan's `active_bytes` includes those bytes and the overhang shrinks back. The
alternative — snapshotting `used_bytes` at capture — is conservative in the
other direction and would under-forgive, i.e. keep blocking a legitimate
customer for an hour. Given the ruling, erring toward not blocking is correct,
and it costs one fewer column.

Symmetric drift: GC prunes history → `used_bytes` falls while the overhang
stands, so billable is briefly understated. Same bound, same self-correction.

## 3. Fallback — an account with no completed scan

`history_overhang_bytes` defaults to `0`, so **billable ≡ ledger** and both the
displayed number and the cap behaviour are byte-for-byte what they are today.
`measuredAt` is `null` and the surfaces say so in plain English.

Why this and not "treat as pending / do not enforce": with no scan we have no
measurement that separates active from history, so the only two options are
"count everything" (today's behaviour) or "count nothing" (unbounded free
storage on an unmeasured account). We keep today's behaviour and label it.

The brief's "never enforce a cap breach on history alone" is therefore vacuous
in this state — there is no evidence identifying any byte as history. It is not
a regression: no account is worse off than before this change, and an account
young enough to have no scan has not accumulated history yet (history only
exists after commits, and the scan ticks hourly).

`0` is deliberately not overloaded: a completed scan that measured zero history
also writes `0`, and both mean the same thing — *nothing is forgiven*. The
"was it measured" question is answered by the presence of a completed
`fairuse_scans` row, which `usage()` already reads.

## 4. Staleness — surfaced, never gated

Scans are hourly-ticked, so the billable number can be up to an hour old, and
older if the scanner is unhealthy.

- **Surfaced:** `GET /v1/account/usage` gains `measuredAt` (epoch ms of the
  scan the number came from, `null` if never measured). `rbox usage` and the
  dashboard render it as "measured N minutes ago" / "still being measured".
  Equals `fairUse.lastCompletedEpochAt`; it is repeated at the top level because
  a client rendering `usedBytes` must not have to know the `fairUse` sub-object
  to state that number's provenance.
- **Never gated.** The overhang does not expire and no code path treats a stale
  measurement as absent. Expiring it would re-impose the history block exactly
  when the scanner is broken — the failure this cycle exists to remove. A stale
  number is a visible ops problem (the cockpit and `measuredAt` show it), not a
  customer-facing block.
- Bounded drift in both directions is analysed in §2.3.

## 5. Copy (non-developer bar)

- CLI, measured: `storage: 3.9 GiB / 50.0 GiB (8%, measured 41 minutes ago)`
- CLI, never measured: `storage: 120.9 GiB / 50.0 GiB (100%, still being measured)`
- Dashboard: the same two strings under the storage bar.

No mention of "active bytes", "epochs", "ledger" or "overhang" reaches a user.
The number is "storage used"; the only new idea we ask them to hold is *when it
was measured*.

## 6. Tests

1. **Flip.** A completed scan writes `history_overhang_bytes = used − active`;
   `usage()` reports `usedBytes = active_bytes` and a non-null `measuredAt`.
2. **Fallback.** No completed scan → `usedBytes` is the ledger, `measuredAt` is
   `null`, `history_overhang_bytes` is `0`.
3. **Cap comparison uses billable.** An account whose ledger is over cap but
   whose billable is under it: `wouldExceedCap` returns `over:false`,
   `usage().readOnly` is `false`, and the D1 cap guard **admits** a charge that
   would have aborted on the ledger.
4. **Admission unchanged.** The grant still adds the full size to
   `used_bytes` (the ledger is not rewritten), and a charge that exceeds the
   *billable* cap still aborts `over_cap`, so the fence still fences.
5. **`billableBytes` is clamped** — a stale overhang larger than the ledger
   yields `0`, never a negative allowance.
6. Existing suites are the regression net for "overhang defaults to 0 ⇒ nothing
   changes": every pre-existing billing/quota assertion runs with `overhang = 0`
   and must pass untouched.

## 7. Non-goals

- **Not** moving admission to `active_bytes` (settled: unsound).
- **Not** deleting history, `history_bytes`, or the retained-history relations.
- **Not** changing `cap_bytes`, the plan table, or Stripe.
- **Not** touching the SQLite/2.0 (U3) migration branch.
- **Not** adding a staleness alarm/gate (§4) — visibility only this cycle.
