# 228 — The billing flip: bill, show and gate on active bytes

Status: **IMPLEMENTED IN THIS BRANCH** (small design; design 225 shipped the
groundwork and §2.10 there deferred exactly this cycle). One adversarial round
folded — see §8 for what it changed and §9 for what it accepted.
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
| `migrations/0014_upload_receipts.sql:60` `accounts_cap_guard` | the authoritative hard gate | **flips** its comparison to billable (paid plans only, §2.1); still fires on the live counter |
| `billing.ts:88/139`, `commit-accounting.ts:211` charges | `used_bytes += size` | **stays** — the ledger is the ledger |
| `billing.ts:174` `releaseUsage`, `gc-phase1.ts:156/268` | GC decrement + reconciler | **stays** |
| `migrations/0016`/`0021` `accounts_cap_on_insert`, `accounts_cap_sync` | materialize `cap_bytes` | **stays** — cap side, not usage side |
| `account-link.ts:336` `judgeReclaimable` | "is this web shell empty?" | **stays** — a shell holding history bytes is not empty |
| `admin.ts:210` `SUM(used_bytes)` | founder cockpit total | **stays** — internal "bytes we are storing", not a bill |

## 2. Mechanism — one materialized number, one owner

### 2.1 The primitive

```
forgiven(account)  = paid plan ? history_overhang_bytes : 0
billable(account)  = MAX(0, used_bytes − forgiven)
```

`accounts.history_overhang_bytes` (new, `NOT NULL DEFAULT 0`) is **the ledger
bytes we have measured and decided not to bill**, and
`accounts.history_overhang_measured_at` (new, nullable) is **when that
measurement was taken**. Both are written by exactly one site, in one statement:
the fair-use scan's completion batch (§2.3). One statement means the number and
its provenance can never be read torn, and `usage()` reads both from the row it
was already reading.

**Only a paid plan forgives anything.** A locked (`none`) account has
`cap_bytes = 1`, and that one-byte fence is the entire mechanism stopping a
lapsed subscription from writing more data. A standing overhang from its paid
era would blunt the fence until the ledger climbed past the overhang, so a
paid→locked transition would leave a window in which real bytes land durably.
Two ways to close it were on the table; we took the second:

| Option | Cost |
|---|---|
| Zero the columns on every plan→`none` write | A duty spread across the Stripe webhook, admin set-plan and every future plan writer; one missed path silently reopens the hole. Also destroys a measurement a re-upgrade would want back. |
| **Decide it in the comparison itself** (chosen) | One `CASE` in the trigger, mirrored by `forgivenBytes()`. The property is structural — no writer can forget it — and the measurement survives a re-upgrade untouched. |

Unknown/garbage plan strings forgive nothing, matching `planFor`'s fail-closed
fallback to `none`.

Owner: `plans.ts` — `forgivenBytes(plan, overhang)`, `billableBytes(plan, used,
overhang)` (both pure) and `BILLABLE_BYTES_SQL`. `plans.ts` already owns
`capBytesFor`, i.e. the cap side of the comparison; this is the usage side. It
imports nothing, so `billing.ts` and `commit-accounting.ts` both use it with no
cycle.

**Admission checks must clamp the SUM, not add to a clamped value.** The trigger
evaluates `(used + incoming) − forgiven > cap`. An app check written as
`MAX(0, used − forgiven) + incoming > cap` is *stricter* whenever
`forgiven > used` — the pruned regime of §2.3 — so the advisory 402 would refuse
an upload D1 would have admitted. `wouldExceedCap` and `wouldExceedCapAggregate`
both go through one `wouldBreachCap()` helper carrying the trigger's exact
shape.

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
   SET history_overhang_bytes = MAX(0, used_bytes − (SELECT s.active_bytes …)),
       history_overhang_measured_at = ?
 WHERE id = ? AND EXISTS (… that scan row is now 'complete' at this completed_at,
                          AND this caller still holds the live lease …)
```

The predicate must make **"statement 2 applied ⟹ statement 1 applied"
structurally true**, and `status='complete' AND completed_at=?` alone does not:
`nowMs` is injected, so two attempts can share it, and the loser — whose own
completion UPDATE changed nothing — would match the winner's row and rewrite the
overhang against a different `used_bytes`. Repeating the **lease** check fixes
it: only the lease holder passes either statement. `fairuse_scans` rows are
unique per `(account_id, epoch)`, so the subquery is single-valued.

**Deploy day is why the timestamp lives here too.** An earlier draft derived it
from `fairuse_scans.completed_at` in a second query. Every account that already
had a completed scan would then have reported a real measurement date against a
completely unforgiven ledger (`overhang` still `DEFAULT 0`) — two numbers
describing different things — and `usage()` could tear if a scan completed
between its two reads. Migration 0036 therefore **backfills** both columns from
each account's latest completed scan, and both are read from one row thereafter.

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

`history_overhang_bytes` defaults to `0` and `history_overhang_measured_at` to
`NULL`, so **billable ≡ ledger** and both the displayed number and the cap
behaviour are byte-for-byte what they are today. `measuredAt` is `null` and the
surfaces say so in plain English. `measured_at IS NULL ⟺ never measured` is the
invariant the backfill preserves: it writes a timestamp only where a completed
scan actually exists.

Why this and not "treat as pending / do not enforce": with no scan we have no
measurement that separates active from history, so the only two options are
"count everything" (today's behaviour) or "count nothing" (unbounded free
storage on an unmeasured account). We keep today's behaviour and label it.

The brief's "never enforce a cap breach on history alone" is therefore vacuous
in this state — there is no evidence identifying any byte as history. It is not
a regression: no account is worse off than before this change, and an account
young enough to have no scan has not accumulated history yet (history only
exists after commits, and the scan ticks hourly).

`0` is deliberately not overloaded on the *bytes* column: a completed scan that
measured zero history also writes `0`, and both mean the same thing — *nothing
is forgiven*. The "was it measured" question is answered by
`history_overhang_measured_at`, on the same row.

## 4. Staleness — surfaced, never gated

Scans are hourly-ticked, so the billable number can be up to an hour old, and
older if the scanner is unhealthy.

- **Surfaced:** `GET /v1/account/usage` gains `measuredAt` (epoch ms,
  `null` if never measured), read from the same `accounts` row as `usedBytes`.
  `rbox usage` renders "measured 41 minutes ago" / "still being measured"; the
  dashboard renders an **absolute** time ("Measured 30 Jul 2026, 3:41 pm")
  because a derived relative age freezes at whatever `Date.now()` was when
  `usage` last changed, and that panel can sit open for hours.
  It normally equals `fairUse.lastCompletedEpochAt`, but it is a separate field
  on a separate table: a client rendering `usedBytes` must not have to know the
  `fairUse` sub-object to state that number's provenance, and only the
  `accounts` copy is guaranteed consistent with the bytes beside it.
- **Never gated.** The overhang does not expire and no code path treats a stale
  measurement as absent. Expiring it would re-impose the history block exactly
  when the scanner is broken — the failure this cycle exists to remove. A stale
  number is a visible ops problem (the cockpit and `measuredAt` show it), not a
  customer-facing block.
- Bounded drift in both directions is analysed in §2.3.

## 5. Copy (non-developer bar)

- CLI, measured: `storage: 3.9 GiB / 50.0 GiB (8%, measured 41 minutes ago)`
- CLI, never measured: `storage: 3.9 GiB / 50.0 GiB (8%, still being measured)`
- Dashboard: `Measured 30 Jul 2026, 3:41 pm` / `Still being measured`.

**Where we say nothing at all.** A locked account (`1 B / 1 B`) and an
unlimited-storage plan both drop the measurement line entirely. Neither has a
quota anyone is reading the number against, so "still being measured" there is
pure noise — and on a locked account it would be actively confusing, since the
number shown is the raw ledger by design (§2.1).

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
6. **Clamped-regime boundary** — with `forgiven > used`, the advisory check and
   the fence agree on both sides of the cap.
7. **A locked account is fenced at one byte** however large its overhang, both
   through the app layer and by a direct `used_bytes` UPDATE against D1.
8. **The lost-lease completion attempt** does not rewrite the measurement.
9. **Migration 0036's backfill**, run from `TEST_MIGRATIONS` against a seeded
   pre-state: latest completed scan wins, incomplete scans are ignored, and an
   account that never completed one keeps `measured_at NULL`.
10. **The over-cap 402 body** reports billable bytes with a nonzero overhang —
    the only exercise of `BILLABLE_BYTES_SQL` in `commit-accounting`.
11. Existing suites are the regression net for "overhang defaults to 0 ⇒ nothing
    changes": every pre-existing billing/quota assertion runs with `overhang = 0`
    and must pass untouched.

## 7. Known gaps and accepted risks

Documented, not fixed this cycle. All three are consequences of the ruling or of
design 225's shape, and all fail in the revenue-safe direction.

- **`active_bytes` double-counts blobs shared across an account's workspaces.**
  225 §2.2 sums per workspace-group without a cross-group union, on the argument
  that per-workspace KEKs make ciphertexts disjoint. Where that does not hold,
  `active_bytes` is overstated, so the overhang (`used − active`) is
  **understated** and can clamp to `0`. The customer is charged more, never
  less; it is also not a regression, since today they are charged for everything.
- **Accounts with more than 64 workspaces never complete a scan**
  (`FAIRUSE_MAX_WORKSPACES`), so the flip never reaches them and they stay on
  the ledger fallback (§3) — over-charged relative to the ruling. Nobody is
  above 5 today. It becomes urgent only when someone approaches 64.
- **The new code requires 0036 to have applied.** `account()` and
  `BILLABLE_BYTES_SQL` select `history_overhang_bytes` unconditionally, so a
  worker deployed against an unmigrated database would 500 on every quota read.
  That ordering is exactly what `deploy-api.yml` guarantees — migrations apply,
  then deploy, then version upload, stopping at the first failure — and the DEV
  Workers Builds config does the same. Tolerating an unmigrated database would
  mean a `COALESCE`-shaped fallback whose deletion condition never arrives.
- **The plan cap no longer bounds physical R2 bytes.** Once history is forgiven,
  the only thing limiting what an account actually stores is the plan's
  365-day retention. That is the direct, founder-accepted consequence of
  "never bill history"; the admin cockpit's billed-vs-stored columns are where
  the divergence is visible.

## 8. What the adversarial round changed

Two independent reviews (codex + opus). The shape survived; four fixes landed:
the deploy-day/torn-read defect that produced
`history_overhang_measured_at` and the 0036 backfill (§2.1, §2.3); the locked
account's one-byte fence, restored by making forgiveness plan-aware (§2.1); the
advisory-stricter-than-fence arithmetic in the clamped regime (§2.1); and the
lease predicate that makes the overhang write structurally dependent on the
completion write (§2.3).

## 9. Non-goals

- **Not** moving admission to `active_bytes` (settled: unsound).
- **Not** deleting history, `history_bytes`, or the retained-history relations.
- **Not** changing `cap_bytes`, the plan table, or Stripe.
- **Not** touching the SQLite/2.0 (U3) migration branch.
- **Not** adding a staleness alarm/gate (§4) — visibility only this cycle.
