# Design 227 — Unwedge Phase 2 GC (keep every belt, fix the stale constant)

**Status:** ALIGNED — round-3 serial confirm passed (2026-07-30); round-2
findings 9, 10 and 11 ruled and folded. Ready to implement.
Supersedes and deletes
`227-phase2-gc-drop-reachability.md`, whose thesis is falsified (§5.1).

Phase 2 GC has been inert since production's 9th workspace. The previous
revision concluded the subrequest budget could not be raised and therefore
proposed deleting the reachability belts. **That premise is false.** The
paid-plan ceiling is 10,000 subrequests per invocation, not 1,000.
`GC_BUDGET_SAFE = 800` was sized against a limit this account has never been
subject to, and was never revisited.

So the design inverts. Every belt design 95 ratified stays. We raise one
constant, fix two pre-existing bugs the review lanes found while looking at the
old proposal, and gate the rollout on the more serious of the two.

---

## §0 Level-set — what "helped" means, falsifiably

**Helped** (all three must hold):

1. `GET /v1/admin/gc?phase=health` at 12 workspaces stops reporting
   `roots_budget_exceeded` (via `purge.outcome`),
   and a `gcPurge` tick reaches `executePage` instead of returning at the
   `if (!workspaces)` branch (`gc-purge.ts:235`).
2. One supervised purge tick opens intents and purges objects with intent-time
   reachability, execute-time reachability, and the per-key `head()` verify all
   still executing.
3. A test that stalls an upload across a Phase 2 delete fails closed — no
   receipt, no `present=1` row (§2.2).

**Worse** (honest):

- The mint path gains one D1 point-read per upload *request* (amortized across
  a batch, not per blob) — a second query of the shape the batch path already
  runs. Cost recorded at implementation.
- `driveAccountDeletion` gets slower per chunk: the DO purge moves ahead of the
  ref drop, so a multi-workspace account spends its early chunks on DO
  round-trips before any `blob_refs` row disappears.
- The reachability fan-out is now genuinely paid every tick: 12 × 90 = 1,080
  subrequests, where before the tick aborted at ~2. That is what the budget buys.
- The publishing super-batch and the legacy publication path each gain a
  D1-evaluated time guard (§2.2). That is more SQL on the hottest write path,
  and a stalled request that used to publish now fails closed and makes the
  client re-upload. Both are deliberate: the alternative is publishing refs to
  bytes that no longer exist.
- A platform limit was hardcoded for the wrong plan and never revisited for a
  year. That class needs a `docs/learnings.md` entry, not just a fixed number.

---

## §1 The falsified premise

### 1.1 What actually wedged GC

`gcPurge` computes its workspace bound before doing anything else —
`maxW = floor((GC_BUDGET_SAFE − GC_FIXED_COST − GC_PER_EXECUTE − GC_P1_COST −
1) / PER_WORKSPACE_ROOTS_COST)` (`gc-purge.ts:223`) — which with
`gc-policy.ts`'s `800, 10, 5, 3, 90` is `floor(781/90) = 8`.
`workspaceSnapshot(env, 8)` returns `null` when it sees more, so every tick at
12 workspaces takes the `if (!workspaces)` branch (`gc-purge.ts:235`), emits
`roots_budget_exceeded`, and returns `purged: 0` — before the lease, before
`executePage`, before any R2 call. `gcMark` is dead the same way
(`floor((800 − 10 − 3)/90) = 8`, `gc-mark.ts:21`), as is `gcAudit`
(`gc-audit.ts:16`).

### 1.2 The number was wrong

The old design asserted "12 × 90 = 1,080 against Cloudflare's hard 1,000
subrequests-per-invocation limit". The hard limit for Workers Paid is **10,000
per invocation** (raisable to 10M). The repo already held both halves:
`docs/design/112-batch-fill-wire-cap.md:112` ("and 10,000 subrequests/request",
citing the live limits page) and `docs/learnings.md:206` ("**Account is Workers
Paid**"). `GC_BUDGET_SAFE = 800` is design-95-era margin under the *free-plan*
1,000. Phase 2 did not hit a platform wall; it hit a constant nobody re-derived.

### 1.3 Field state (2026-07-29, prod D1)

- **1,336,499** rows in `gc_candidates`, ~**375 GB** of unreclaimable R2.
- **64,195** carry `kind = 'canonical'` with an identical
  `marked_at = 1783500000000`; **835** of those already have an open intent
  (`deleting_at` set), frozen since 07-20. **Zero** rows carry
  `kind = 'manifest'`.
- No code in this tree writes `'canonical'`. The schema comments the column as
  `'blob' | 'manifest'` with no CHECK constraint (`migrations/0005_gc.sql:16-18`),
  and the three in-repo writers write `'blob'` or a list-prefix-derived kind:
  `gc-mark.ts:60-61`, `gc-phase1.ts:207`, `account-delete.ts:250-252`.
  Provenance is the out-of-band storage-truth reconciliation of 07-08.

---

## §2 Mechanism

### 2.1 Part 1 — raise the budget (the unwedge)

`GC_BUDGET_SAFE: 800 → 8_000` (`gc-policy.ts:1`). Derivation: the platform
ceiling is 10,000/invocation; 8,000 leaves 20% for what the Worker does outside
the GC accounting (request handling, observability writes, lease renewal) and
for that accounting being approximate. A margin under a real wall — and this
time the wall is cited (§1.2).

Nothing else in `gc-policy.ts` changes. `PER_WORKSPACE_ROOTS_COST = 90` stays:
it is a worst-case per-workspace DO allowance (`gc-roots.ts` pages roots under
`MAX_DROPPED_PAGES = 16` / `MAX_SEQROOTS_PAGES = 4`); re-deriving it is out of
scope.

Resulting bound, identical at all three sites: **`maxW = 88`** —
`gc-purge.ts:223` and `gc-audit.ts:16` share
`floor((8000 − 10 − 5 − 3 − 1)/90) = floor(7981/90)`; `gc-mark.ts:21` computes
`floor((8000 − 10 − 3)/90) = floor(7987/90)`. Production has 12. At 88 a tick
would spend 7,920 subrequests on reachability alone, which is why 88 is the
bound and not the target.

**Consolidate the formula.** All three sites already import the same constants,
so the constant does not diverge — but the *expression* is copy-pasted with two
different fudge terms (`gc-mark` subtracts a bare `3`). Export one
`gcMaxWorkspaces()` from `gc-policy.ts` and call it from all three: one owner
for one invariant. Today's divergence is exactly how a future raise reaches two
sweeps out of three.

**Throughput does not rise automatically — flagged.** `gcExecuteLimit` does not
scale with the budget:

```
gcExecuteLimit(12) = max(0, min(200, floor((8000 − 1 − 1080 − 10 − 3)/5)))
                   = min(200, 1381) = 200
```

`GC_MAX_EXECUTE_ROWS = 200` clamps it. And `gcPurge` runs **once per day**, at
`GC_PURGE_UTC_HOUR = 9` (`worker.ts:74`, `:159`) — the cron fires hourly but GC
claims one hour. So the standing pipeline reclaims **200 objects/day** and
opens **200 intents/day** (`GC_P1_MAX_ROWS = 200`).

Both row caps deliberately stay at 200 (§2.4). Actual per-tick draw at 12
workspaces and limit 200 is `10 + 1080 + 5×200 + 3 + 1 = 2,094` — 26% of
budget, comfortable for the first supervised runs. `wrangler`'s `limits` config
could pin a higher ceiling; not needed, not proposed.

### 2.2 Part 2 — the mint-after-delete ABA (BLOCKER, gates rollout)

**This bug exists today and is independent of this design.** It blocks only
because Part 1 arms the executor that can trigger it.

On the receipts path the canonical R2 object is written **first** and the fence
is read **after**: `directWriteVerified` puts the canonical key
(`blobs.ts:42-54`, put at `:49`); `mintFenceCheckedReceipts` then captures
`checkTime = Date.now()` (`:64`), reads `gc_candidates` for an open intent
(`:68-71`), and mints (`:80-85`); `directWriteWithReceipt` composes them in
that order (`:96-97`). The batch path is the same shape — per-record writes at
`blob-batch.ts:279`, one amortized fence read + mint at `:268`.

Interleaving:

1. sha has an open intent; `deleting_at` is set.
2. Upload PUTs the canonical object (`blobs.ts:49`); bytes are in R2. The
   request then stalls before `blobs.ts:64`.
3. The daily tick executes: deletes the R2 object (`gc-purge.ts:132`),
   head-verifies absent (`:133`), and `cleanupCandidate` removes the
   `gc_candidates` row (`:40`) — the fence itself is gone.
4. The request resumes. The fence read at `:68-71` finds nothing and mints a
   valid 12h receipt for bytes that no longer exist.
5. Commit admits on the receipt (`commit-accounting.ts:142-144`), creates
   `blobs.present = 1` and `blob_refs`, head advances. The client 404s on read.

The legacy paths share the shape with a different fence mechanism: single PUT
(`blobs.ts:266` put → `:272` `INSERT INTO blobs` → `:282` grant) and multipart
complete (`:518` → `:526` → `:537`) rely on the `blobs_insert_delete_fence` /
`blob_refs_delete_fence` triggers (`migrations/0024_gc_state.sql:17-45`). Those
fire on `EXISTS (… gc_candidates … deleting_at IS NOT NULL)` — once step 3
deletes the row they are silent. Same ABA, same window.

Design 95 already requires the fix: I2 anchors authority before the fence
(`95:303-311`), and the minting section requires `checkTime` be captured "AT OR
BEFORE the fence read" (`95:77-82`). The code satisfies the letter — but the
whole pair sits *after* the R2 write, which is what the invariant meant to
exclude.

**Remedy step 1 — move the authority anchor ahead of the canonical write:**

- Read the fence **before** `directWriteVerified` (one fail-closed `IN (…)`
  point-read for the request's sha set), capturing the anchor `preReadTime` at
  or before that read. Fenced or unreadable → `503 retry_later`, no R2 write.
- Mint with that pre-write anchor, so the receipt's 12h expiry derives from it.
- Keep the existing post-write read unchanged. It no longer carries the whole
  correctness argument, but it is an existing fail-closed early abort that
  avoids minting authority for bytes P2 is about to reap; removing it is a
  separate decision needing its own justification.

#### The principle round 2 forced out (one rule, three applications)

Moving the anchor is necessary and **not sufficient**. Round 2 found three
separate holes — a stale `deleting_at` stamp, a receipt that verifies before it
publishes, and legacy paths whose fence row can vanish between write and
publication. They are one defect wearing three hats:

> design 95's terminal inequality (24h quiescence > 12h authority) is currently
> enforced with `Date.now()` values read in JavaScript, arbitrarily far from
> the durable D1 writes they are supposed to guard.

A Worker request may stall indefinitely between any two `await`s — Cloudflare
documents no wall-clock request bound, only CPU time — so a JavaScript-side
comparison proves nothing about the instant the write actually lands. Hence:

> **Every time comparison the delete-fence safety argument relies on must be
> evaluated by D1, inside the same transaction that performs the durable
> write.**

One rule, three applications, **zero new constants**.

**Owner (round-2 finding 10).** The publication-fence invariant has exactly one
owner: **the D1-time-guarded publishing transaction** — the single `db.batch`
that performs a path's durable publication (`commit-accounting.ts:266` for the
receipt paths; the new single transaction wrapping the blobs insert and the
grant for legacy PUT and multipart, §2.2c). That transaction carries the
deadline comparison and refuses its own writes; no caller, route, adapter, or
background loop re-decides publication eligibility, and no second time check is
added anywhere else to compensate. `deleting_at` stamping (a) is the mirror of
the same rule on the delete side, owned by `openIntents`' `UPDATE`.

**(a) `deleting_at` must be stamped with D1's clock.** `gcPurge` captures
`nowMs` at invocation start (`gc-purge.ts:219`), runs reachability and the whole
execute page, and only then passes that same value to `openIntents`
(`:293`), which binds it as the intent's opening time (`:184`). Execute
eligibility later trusts the stored value (`:70`, `:72`). A purge that stalls
after `nowMs` and before the P1 `UPDATE` stamps an intent with an *old* time,
so a receipt anchored in between can be outlived by an intent that is already
quiescence-eligible. Remedy: stamp the `UPDATE` with a D1-evaluated timestamp —
`CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)`, the expression this
codebase already uses for exactly this reason in fairuse's `leaseLiveExists`
(`fairuse.ts:215`, expression at `:220`).

**(b) receipt expiry must be enforced by the publishing transaction.** Commit
(`workspace-sync.ts:544`) and redeem (`:907`) capture request-start time, verify
receipts against it (`:552`, `:925`), and publish `blobs.present = 1` plus
`blob_refs` much later, in the accounting super-batch (`commit-accounting.ts:196`,
`:213`, committed at `:266`). A receipt can verify one millisecond before
expiry, the request can then pause through P1, 24h quiescence, execute and fence
cleanup, and the batch publishes into a world where the trigger's fence row is
gone. Remedy: carry the authenticated receipt expiry `e` into commit accounting
and guard every publishing statement in the super-batch with
`WHERE <D1-now> < ?e`, binding the minimum `e` over that super-batch's
receipt-authorized refs. The batch is one D1 transaction (`db.batch`,
`commit-accounting.ts:266`), so the comparison and the write are inseparable. A
guarded-out publish writes nothing; detect the shortfall after the batch and
return it through the existing `needsUpload` rejection (`:270`) so the client
re-uploads. The signed `e` remains the sole owner of that window — **no new
constant**.

**(c) legacy single PUT and multipart need one guarded publication.** The
pre-write read alone does **not** protect them: pre-read passes → P1 opens the
intent → the canonical write lands (`blobs.ts:266`, `:518`) → the request
pauses → P2 deletes the object and `cleanupCandidate` removes the candidate row
(`gc-purge.ts:132`, `:140`) → publication resumes and the triggers are **silent,
because the fence row they test for is gone** (`migrations/0024_gc_state.sql:17`,
`:27`, `:37`). Today the blobs insert (`blobs.ts:272`, `:526`) and the
entitlement grant (`:282`, `:537`) are separate statements with no shared
deadline. Remedy: publish both in one transaction carrying a D1-evaluated
deadline anchored at the pre-write fence read — publication is refused when
D1-now exceeds `preReadTime + RECEIPT_TTL_MS` (`receipts.ts:10`). Refusal maps
to the `503 retry_later` these paths already return (`:276`, `:531`). Reusing
the receipt TTL is deliberate: it is the same authority window the receipt
paths get, and 12h < 24h quiescence is what keeps the inequality true. **No new
constant.**

**(d) minting must reject a stale anchor.** This upgrades the post-write read
from "belt" to "contract". After a long stall the post-write read can find no
fence row *because P3 already removed it*, and `mintReceipt` (`receipts.ts:114`)
would then sign `e = anchor + RECEIPT_TTL_MS` (`:121`) off an anchor that is
already expired — returning 200 with dead authority, contradicting the
"must 503, must not mint" contract §3's ABA tests assert. Minting rejects with `503 retry_later` and
no receipt whenever the post-write read is observed later than
`preReadTime + RECEIPT_TTL_MS`. Same constant, **no new one**.

**Why this restores the inequality.** Any intent able to delete these bytes
carries a D1-stamped `deleting_at` strictly after the D1-observed pre-read (a),
so it cannot execute until +24h (`INTENT_QUIESCENCE_MS`, `gc-policy.ts:8`);
every authority derived from that anchor — a minted receipt (b, d) or a legacy
publication deadline (c) — is refused by D1 itself at +12h. The gap is 12h of
D1-evaluated time, not of hope.

**Scope:** receipts single (`blobs.ts:89-98`), receipts batch
(`blob-batch.ts:268`/`:279`), legacy single PUT (`blobs.ts:264-296`), multipart
complete (`blobs.ts:516-549`), `openIntents` (`gc-purge.ts:152-197`), commit
accounting's publishing super-batch (`commit-accounting.ts:185-270`).

### 2.3 Part 3 — account-delete ordering

`driveAccountDeletion` drops this account's `blob_refs`
(`account-delete.ts:242`), condemns the now-zero-ref shas (`:248-255`), and
only *later* purges the workspace DOs (`:306`) and deletes the `workspaces`
rows (`:313`). Steps 3–4 (uploads, diagnostics) sit between them, each able to
return `progress` and end the chunk.

Across that multi-tick window the condemned shas are **reachable with zero
refs**: `workspaceSnapshot` still returns the rows, the DO still answers
`/roots`. With the belts kept, a purge tick in that window either unwinds the
intent (`gc-purge.ts:120-122`) or `openIntents` resurrects the candidate
outright (`:179-180`). Nothing re-condemns — the chunk loop has moved past step
2, and its re-read of `blob_refs` is empty. This is the one real harm the old
design attributed to the belt. It is not a belt defect; it is an ordering
defect in account-delete.

**Remedy.** Move the DO purge and the `workspaces`/`commits`/`manifests`
deletion (today `:301-318`) **ahead** of the ref drop and condemn (today
`:229-257`). The account is already claimed and marked `status = 'purging'` at
`:203-211`, before either block, so tombstoning is unaffected. Once the
`workspaces` rows are gone, `workspaceSnapshot` cannot return them, `/roots` is
never asked, and the condemned shas are unreachable — which is the truth. Both
blocks are already chunked with their own `progress` returns; this is a swap of
two chunk stages, not a restructure.

**Also in the implementation surface:**
`.agents/skills/account-cleanup/SKILL.md:42` documents the purge order as
"blob_refs → orphans → Phase-2 R2 reclaim, uploads, workspace DOs" — stale the
moment this reorder lands (verified in the worktree; round-2 finding 11 cited
`:37`, which is the dashboard sign-in step). One line, updated in the same
change.

### 2.4 Part 4 — carried-forward round-1 fixes

Full round-1 disposition table lives in `notes/227/REVIEW-LOG.md`.

**`openIntents` kind filter — REJECTED as written.** F1 proposed adding
`kind IN ('blob','manifest')` to match `executePage`. `executePage` has no such
filter (`gc-purge.ts:72`, `:77`); the mapping that matters is `:131`, which
sends everything except `kind='manifest'` to `blobKey`. With zero `manifest`
rows in prod and the 64,195 `canonical` rows being blobs keyed at `blobKey`
(§1.3), the filter would **strand the ~63,360 canonical rows that have no
intent yet**: `openIntents` selects only `deleting_at IS NULL`
(`gc-purge.ts:166`, fallback `:171`), so those rows would never be stamped and
never become executable. It could not *re*-fence the 835 already-open canonical
rows and could not jam the cursor — those rows are past `openIntents` entirely
and drain on `executePage`'s independent execute cursor (`:67`, `:69-74`).
Wrong mechanism, right decision: **do not add it.** `canonical` is in the
drainable set.

**`openIntents` batching — OUT of scope this cycle.** It builds one statement
per row and dispatches them as a single `db.batch` (`gc-purge.ts:176-191`), so a
200-row pass is 200 statements. That is real, but standing throughput after the
raise is bounded by `GC_MAX_EXECUTE_ROWS = 200`/day and the external drain owns
the backlog, so reshaping the statement batching buys nothing measurable in a
safety-critical unwedge. **Named follow-up**, to be specified with the
rows-vs-statements distinction stated explicitly: `ACCOUNTING_INSERT_CHUNK = 33`
(`commit-accounting.ts:29`) is *rows per statement*, while `d1-batch.ts`'s
`STMTS_PER_BATCH = 34` (`:24`) is *statements per batch* — the two are not
interchangeable, and reachable rows need `DELETE` (`gc-purge.ts:180`) while
unreachable rows need `UPDATE` (`:184`), so any set-based rewrite is at least
two statement families, not one.

**Chunked/batched execute — DEFERRED, and the reason is arithmetic.** At
200/day the backlog takes ~18 years; even raising `GC_MAX_EXECUTE_ROWS` to its
budget maximum of 1,381 gives ~2.7 years. Neither clears 1.34M rows, so the
external drain (running now, ~9 days) is mandatory either way and batching
changes nothing this cycle. The standing pipeline only has to keep up with
*new* garbage. **Named follow-up:** after one week of enabled ticks, compare
`gc.intents.opened` against the growth of `gc_candidates`; if the steady state
does not keep up, raise the row caps first (a one-constant change fully inside
budget) and only then consider batching.

**`gcMark` — leave alone.** It keeps its reachability; the old design's
pure-predicate rewrite is dead. Codex finding 6 (a probe-to-insert race,
fixable by making the write `INSERT … WHERE NOT EXISTS`) is recorded as cheap
hardening **only if `gcMark` is opened for another reason**. Otherwise touch it
no further than the shared `gcMaxWorkspaces()` call.

**`gc-health` workspace-count thresholds — RULED: DELETE, do not re-base.**
`GC_MAX_WORKSPACE_ROWS = 8` and `GC_WARN_WORKSPACE_ROWS = 6`
(`gc-health.ts:7-8`) were derived from the old `maxW = 8`; at 12 workspaces
`warn` is permanently true (`gc-health.ts:39`), which is why the signal is
worthless today. Re-basing them on `gcMaxWorkspaces()` would create a **second
owner of the workspace bound** whose only job is to restate a number
`gcMaxWorkspaces()` already owns — and the health surface never needed to be a
capacity gauge: `gcPurge`'s own `roots_budget_exceeded` outcome already reports
the bound being hit, and it is already surfaced through `purge.outcome`.
So: delete both constants, delete the `rows >= GC_WARN_WORKSPACE_ROWS`
disjunct at `:39`, and delete the `maxRows` field — the literal-`8` type at
`gc-health.ts:14`, its population at `:46`, and its echo in the hourly warning
log at `:67`. `rows` itself stays (it is the observation §4.4 reads). `warn`
keeps the roots-cardinality and `roots_cap_exceeded` disjuncts and **gains the
orphan-ref D1-integrity count** below as its third: non-zero ⇒ `warn`.

**Wire surface:** dropping `maxRows` is a response-shape change to
`GET /v1/admin/gc?phase=health` (`routes/admin.ts:142-144`, platform-secret
gated). Codex verified in round 2 that `rbox-admin` has no consumer of
`maxRows`, `GcHealthV1`, or that endpoint (its panel reads D1/AE directly), and
this tree has none either — no `scripts/` or CLI reader. Removal is unblocked.

**Implementation note — two different `maxRows`.** `gc-purge.ts:248` and
`gc-mark.ts:38` also emit `maxRows: maxW` **in the GC observation**, which is a
different field on a different surface and **stays** (it becomes 88). Only the
`GcHealthV1` field is deleted. Tests to re-base: `apps/api/test/gc-purge.test.ts`
imports `GC_MAX_WORKSPACE_ROWS` (`:15`, used `:658-659`) and the
"health uses exact row thresholds" case (`:849-872`) asserts the row trigger and
`maxRows: 8` at `:867`; the observation assertions at `:676`/`:728` are the
other field and only change with the new bound.

**Observability — add the orphan-ref alarm, as a D1-integrity alarm.** One
indexed query: `SELECT COUNT(*) FROM blob_refs r WHERE NOT EXISTS (SELECT 1
FROM blobs b WHERE b.sha256 = r.sha256)`. Non-zero means D1 itself is
inconsistent. `gcPurge` owns the query: emit it alongside the existing
`gc.intents.*` metrics (`gc-purge.ts:299-304`) **and** record the count in the
purge observation (an optional numeric field beside `rows`/`purged`/`opened`,
`gc-observability.ts:34-45`). `gcHealthData` reads it from that stored
observation and warns on non-zero — the same read-a-stored-sample shape
`uniqueRoots` already uses, so health stays three D1 reads and the daily tick
remains the single place the scan runs.

**It does NOT catch the §2.2 ABA** — that claim is deleted. ABA publication
runs through commit accounting, which recreates `blobs.present = 1` and
`blob_refs` in the same transaction (`commit-accounting.ts:196`, `:213`,
`:266`); D1 is perfectly consistent while R2 is empty. **Named follow-up (not
in scope):** an entitled-and-present-versus-R2 canary — a bounded sampled
`head()` over `blobs.present = 1` rows — is the only shape that can see that
divergence, and it costs subrequests, so it needs its own budget derivation.

---

## §3 Tests the implementation MUST write

1. **Budget** — `gcMaxWorkspaces()` returns 88; a 12-workspace fixture reaches
   `executePage`, not the `roots_budget_exceeded` branch; and
   `gcExecuteLimit(12) === 200`, asserting the clamp explicitly so a future
   budget raise cannot silently change throughput.
2. **ABA, receipts** — open an intent, PUT the object, run a purge tick that
   deletes it *and* removes the candidate row, then resume the mint. Must
   `503`, must not mint, must leave no `blobs` row. Batch path too.
3. **ABA, legacy** — same interleaving against single-PUT and multipart. Must
   `503 retry_later`; no `present = 1`.
4. **Anchor ordering** — no canonical R2 write dispatched before a successful
   fence read (spy on the R2 binding).
5. **D1-stamped `deleting_at` (§2.2a)** — stall P1 between `gcPurge`'s `nowMs`
   capture and the `openIntents` `UPDATE`; the stamped `deleting_at` must
   reflect the later D1 time, so an anchor taken during the stall is *not*
   immediately outlivable. Assert just-before and just-after the boundary.
6. **Expired receipt cannot publish (§2.2b)** — verify a receipt, then advance
   D1's clock past its `e` before the accounting super-batch commits: nothing
   publishes (no `present = 1`, no `blob_refs`) and the request returns the
   existing `needsUpload` rejection. Commit and redeem paths.
7. **Legacy publication deadline (§2.2c)** — pre-read passes, canonical write
   lands, P2 deletes the object *and* the candidate row, then publication
   resumes past `preReadTime + RECEIPT_TTL_MS`: `503 retry_later`, no `blobs`
   row, no grant — proving the fix does not depend on the trigger, whose fence
   row is gone by then.
8. **Stale-anchor mint rejection (§2.2d)** — post-write read observed later
   than `preReadTime + RECEIPT_TTL_MS` must `503` with no receipt, not a 200
   carrying already-expired authority.
9. **account-delete ordering** — one workspace, one zero-ref sha: after the
   reorder, a purge tick interleaved at every chunk boundary never unwinds or
   resurrects the condemned sha.
10. **Kind filter regression (§2.4)** — an ordinary `kind='canonical'` row with
    `deleting_at IS NULL` gets an intent opened and drains; a
    `kind='canonical'` row that *already* carries an open intent drains through
    `executePage`. Both must stay green so a future "match `executePage`"
    filter cannot be reintroduced silently.
11. **Belts still run** — `reachableFromWorkspaces` is called by `gcPurge`, a
    reachable candidate is unwound, and the per-key `head()` verify
    (`gc-purge.ts:133-137`) still gates `cleanupCandidate`.
12. **Orphan-ref alarm** — 0 on a healthy fixture, non-zero after a forced
    ref-without-blob. It is a D1-integrity assertion; it is *not* an ABA test
    (tests 2, 3, 6, 7 are).

---

## §4 Rollout — numbered preconditions

Phase 2's kill switch is `RBOX_GC_PURGE_DISABLED`, read at `worker.ts:160`. Its
**current prod value is `"0"` — enabled** (`wrangler.jsonc:194`; dev also `"0"`
at `:104`). It is inert today only because `maxW = 8 < 12`. **Raising
`GC_BUDGET_SAFE` arms the executor on the next 09-UTC tick.** Therefore:

1. Set `RBOX_GC_PURGE_DISABLED = "1"` in the prod env block **in the same
   change** that raises `GC_BUDGET_SAFE`. Not optional, not a follow-up commit.
2. §2.2 (the ABA fix) merged and deployed before the flag is cleared.
3. External manual drain **stopped** before promotion — two executors against
   one candidate set is outside the lease's design.
4. Promote with purge still disabled; verify `GET /v1/admin/gc?phase=health`
   (platform-secret header, `routes/admin.ts:142`) reports `rows: 12`
   without `roots_budget_exceeded`.
5. Supervised `gcAudit` dry-run (read-only, no lease, `gc-audit.ts:14`).
   Confirm `wouldIntent`/`wouldDelete` are plausible. **Conditional
   expectation:** they are only required to be non-zero if candidates remain; a
   completed drain legitimately makes them zero, and zero-after-completion is a
   pass, not a fault.
6. **One** supervised execute via the admin escape hatch. Confirm `purged`,
   `unwound`, and the orphan-ref alarm.
7. **Backlog gate.** Do not enable the cron until the external drain is
   **complete**, or the founder approves a named residual threshold. At
   ~113 rows/s the drain finishes around 2026-07-30, so by any plausible deploy
   date this is already satisfied — the gate stays anyway because it is free to
   check and it stops a 200/day pipeline from being pointed at a 1.34M-row
   backlog on the strength of an assumption.
8. **48-hour clean soak** (design 95's requirement, `95:355`) after the
   supervised execute: no `ReceiptFenceError` spike, no orphan-ref count, no
   stale-intent growth. Restored — round 1 dropped it without evidence.
9. Only then set `RBOX_GC_PURGE_DISABLED = "0"` and let the daily cron run.
10. Add the `docs/learnings.md` entry for the stale-platform-constant class.

**Leaving the 08 UTC mark enabled throughout is safe** and is the intended
posture: `gcMark` writes candidates with `deleting_at = NULL`, and nothing
fences on those — both the SQL triggers (`migrations/0024_gc_state.sql:19`,
`:29`, `:39`) and the receipt fence require an *open* intent. **State the
consequence anyway:** fresh ordinary candidates make the legacy `missingBlobs`
preflight (`blobs.ts:213`) report those shas as missing, so clients take the
re-upload path. That is
correct and safe, but it is a client-visible behavior that must be stated here
rather than discovered during the soak.

---

## §5 Settled — do not re-litigate

1. **"Delete reachability because the budget cannot rise" is DEAD.** The paid
   ceiling is 10,000 subrequests/invocation, recorded at
   `docs/design/112-batch-fill-wire-cap.md:112` and `docs/learnings.md:206`.
   Any future proposal to drop a belt must argue safety, never arithmetic.
2. **Design 95's belts are ratified and KEPT.** The execute protocol's own
   steps are zero-refs + quiescence + lease, but intent-time reachability (G4,
   `95:66-67`) and the per-key head-verify are ratified parts of the same
   design and stay.
3. **`INSERT OR IGNORE` does NOT downgrade the fence trigger.** Proven
   empirically on real D1 by the execute lane: `RAISE(ABORT)` in a
   `BEFORE INSERT` trigger fires regardless of the conflict clause. Nobody
   re-tests this.
4. **The `canonical` rows are blobs**, audited against prod R2: all resolve at
   `blobKey`, none at `manifestKey`, zero `kind='manifest'` rows in prod. They
   drain through the normal path (§2.4). **The 835 already-open canonical
   intents must drain or be explicitly unwound** — leaving them permanently
   fenced is a silent leak plus a jammed intent cursor.
5. **7-day grace, 24h quiescence, in-transaction zero-refs, every lease guard:
   unchanged.** Shortening the grace requires first explaining how a client
   holding a valid 12h receipt gets its bytes back.
6. **Phase 1 keeps its reachability.** `gc-phase1.ts:50-55` is per-account and
   inside budget; not in scope.
7. **`manifestKey` has no writer.** Latent, recorded, not fixed here — with
   zero `manifest` rows in prod it is unreachable today.
8. **Time checks that guard deletion are D1-transaction-evaluated — never
   JS-side.** Any comparison the delete-fence safety argument depends on is
   evaluated by D1 in the same transaction as the durable write it guards
   (§2.2). A future reviewer proposing a fresh `Date.now()` check as a fix for
   any fence race is re-opening the exact hole round 2 closed: a Worker request
   can pause indefinitely between two `await`s.
9. **No `kind` filter on `openIntents`.** It would strand the ~63,360 canonical
   rows that have no intent yet, and it could not re-fence the 835 that already
   do (they are past `openIntents`, on the execute cursor). Both regression
   tests are §3.10. Do not reintroduce it "for symmetry with `executePage`" —
   `executePage` has no such filter.

---

## §6 Anchor corrections against the founding brief

Flagged, not smoothed over. Detail in the cited section.

1. **`gcExecuteLimit` does NOT rise with the budget** — `GC_MAX_EXECUTE_ROWS =
   200` clamps it (`gc-policy.ts:6`, `:13`). The brief said "~1,380/tick". §2.1
2. **`gcPurge` runs DAILY**, at `GC_PURGE_UTC_HOUR = 9` (`worker.ts:74`,
   `:159`); mark at 08 UTC (`:73`, `:142`). Real throughput is 200
   objects/day — which is what makes the batching deferral correct. §2.4
3. **`RBOX_GC_PURGE_DISABLED` is `"0"` — ENABLED — in prod today**
   (`wrangler.jsonc:194`). The brief expected it already disabled. §4.1
4. **The three `maxW` sites share `GC_BUDGET_SAFE`**; only the *expression*
   diverges (`gc-mark.ts:21` subtracts a bare `3`). Consolidation is still
   right, for a different reason. §2.1
5. **The `kind IN ('blob','manifest')` filter is REJECTED, not carried
   forward** — `executePage` has no such filter to match. Round 2 corrected the
   *reason*: it would strand the ~63,360 unopened canonical rows, not re-fence
   the 835 open ones or jam the cursor. §2.4, §5.9
6. **Legacy PUT and multipart are fenced by D1 TRIGGERS, not an app-level
   read** (`migrations/0024_gc_state.sql:17`, `:27`, `:37`). Round 2 corrected
   the follow-on: the trigger is **not** a sufficient remedy, because P2 removes
   the very row it tests. They need the same D1-evaluated publication deadline
   as everything else. §2.2c
7. **Design 95's invariant is already satisfied in the letter** — `checkTime`
   (`blobs.ts:64`) *is* captured at-or-before the fence read (`:68`). The
   violation is that the pair sits after the R2 write; the brief implied the
   anchor was simply missing. §2.2
8. **"Reject when elapsed exceeds the authority window" is BACK, reused not
   invented** — round 1 dropped it as a moving part with no job. Round 2 showed
   moving the anchor is necessary but not sufficient, so publication and
   minting do reject on elapsed time. It costs no new constant: the receipt
   paths use the signed `e`, the legacy paths reuse `RECEIPT_TTL_MS`
   (`receipts.ts:10`). §2.2b–d
9. **`openIntents` batching is deferred, and rows ≠ statements** —
   `ACCOUNTING_INSERT_CHUNK = 33` (`commit-accounting.ts:29`) is rows per
   statement; `STMTS_PER_BATCH = 34` (`d1-batch.ts:24`) is statements per
   batch. Round 1's "≤33 statements per batch" conflated them. §2.4
10. **The orphan-ref alarm does not catch the ABA** — commit accounting
    re-creates `blobs` and `blob_refs` in one transaction
    (`commit-accounting.ts:196`, `:213`, `:266`), so D1 stays consistent while
    R2 is empty. Kept as a D1-integrity alarm only. §2.4
11. **Minor line drift** (conclusions unaffected): `directWriteVerified`
   `:42-54` not `:42-50`; `mintFenceCheckedReceipts` `:56-87` not `:56-83`;
   `directWriteWithReceipt` `:89-98` not `:89-97`; legacy single PUT `:264-296`
   not `:264-295`; multipart `:516-549` not `:493-553` (`:493` is the MPU
   assemble); account-delete's condemn is `:248-255`, not a single `:250`.
12. **Unverifiable from the repo, carried on the execute lane's authority:**
    the 835-open-intent and zero-`manifest` counts, and the R2 audit that the
    `canonical` rows resolve at `blobKey`. No `'canonical'` literal exists in
    this tree — the rows came from the out-of-band 07-08 reconciliation.
    Re-confirm both counts against prod D1 before §4.6.
