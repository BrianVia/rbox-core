# 95 — GC purge automation: Phase 2 goes on the cron

Status: ✅ ALIGNED v10, 2026-07-10 — 10 adversarial rounds (REVIEW-95.md),
codex (sol) final verdict ALIGNED; the round-10 I2 prose NIT folded. v9 was:
(1) receipt validity anchors to the FENCE-CHECK time (`checkTime` captured
at/before the D1 fence read becomes the receipt's `t` — a paused request
cannot mint late authority; D1 read failure → 503, never mint); (2) every
intent-removing D1 batch (P3 + activity-unwind) is lease-guarded — it
no-ops unless the executor still owns `purge_lease` — and the pre-delete
check requires the intent row still open, so an expired holder's late D1
continuation cannot drop a fence a successor is relying on; (3) the stale
post-hoc intent-read sentence removed from the protocol core (the caught
super-batch is the only failure identity); (4) the sentinel query names the
real `(workspace_id, project_id)` columns; obsolete cursor sentence gone.
(Prior header for history:)
v8's two closing moves: (A) FENCE-AWARE RECEIPT MINTING — the upload paths
refuse to mint/publish while a fence is open (one amortized D1 point-read
per upload batch), giving the terminal invariant: publication authority
issued BEFORE the fence expires (12h TTL) strictly before any delete (24h
quiescence); authority AFTER the fence is never issued. The last
PUT-before-delete ordering dies with no timestamp reasoning. (B) BOUNDED-
DEADLINE EXECUTORS + TAKEOVER QUIESCENCE — every P2/P3 executor self-caps
its dispatch window (cron ≤15min platform; admin handler enforces a 60s
code deadline), and lease takeover waits TTL + 30min, chosen ≫ any R2
op's in-flight lifetime, so an expired holder's delete cannot land after a
successor acts. Plus: abort recovery keyed on the caught super-batch (not
post-hoc intent reads), legacy 503 mapped to the daemon's existing deferred
mechanism, the round-4 sentinel-W algorithm restored verbatim, and the two
cursor indexes added to the migration.
(Superseded header follows for history:)
Round 6 confirmed the trigger fence closes every publication race WHILE the
fence stands; v7 fixes how the fence comes down: (1) VERIFY-AFTER-DELETE —
P2 is delete → head-verify → P3; the fence drops only after confirming the
key is absent, so any PUT after our delete keeps its bytes (the only
authorized deleter already fired); (2) EXCLUSIVE EXECUTOR LEASE in gc_state
(CAS acquire, TTL'd) — cron and the manual drain can never both hold P2;
the invocation-lifetime premise is withdrawn (HTTP has no duration cap);
(3) the undefined "young object" pre-classification is DELETED (no longer
load-bearing); activity-unwind now REMOVES candidacy (Phase 1 re-marks if
truly garbage) killing the restamp loop; (4) fence-abort recovery specified
end-to-end for all four caller shapes; (5) separate P1/P2 cursors + honest
24–48h execution window; (6) combined per-invocation arithmetic.
Pending round 7 (convergence).
Founder decisions locked 2026-07-10 (docs/STATUS.md). The rejected DO
delete-barrier stays rejected: the fence is one RAISE-ABORT trigger on
tables the publication batch already writes — zero hot-path lookups, zero
serialization hops.
Prerequisite of: design 89 (§6/§8 step 0).

## 1. Problem and evidence

Phase 2 (`gcPurge`, `apps/api/src/versions.ts:81`) is the only deleter of
canonical blob/manifest R2 objects, manual-only, never run. 2026-07-08:
111.8 GiB in R2 vs 44.9 referenced; 70,040 candidates. 2026-07-10: 376,420
blobs / 145.4 GiB tracked vs 83.1 GiB referenced. Missing: **purge** and
**mark** (`gcMark`, `versions.ts:58`; Phase 1 cannot see zero-D1
receipts-path uploads, `blobs.ts:165-184`).

## 2. The protocol

R2 has no conditional delete; D1 is the serialization point; worker-captured
timestamps cannot prove PUT-vs-delete ordering (round-5 blocker 3 — the
epoch approach is unsound in principle). So the protocol never reasons about
ordering at all — it makes overlap IMPOSSIBLE:

**Day N — P1 (intent).** For each eligible candidate (7-day `marked_at`
grace G3, zero refs G5, fresh global reachability G4, fail-closed G4):
`UPDATE gc_candidates SET deleting_at=? WHERE sha256=? AND deleting_at IS
NULL AND <zero-refs>`. One guarded statement; changes=0 → skip.

**Fence-aware minting (round-7 blocker 1).** Publication AUTHORITY is never
issued while a fence is open: the receipts PUT paths (single + batch,
`blobs.ts:165-184` / the design-80 batch) check
`gc_candidates.deleting_at IS NOT NULL` for the uploaded sha(s) — one
point-read, amortized to one `IN (…)` query per upload batch — and return
`503 retry_later` WITHOUT minting when fenced (the bytes may land in R2;
they carry no authority and P2 deletes them freely). **Time anchor
(round-8 blocker 1): `checkTime` is captured AT OR BEFORE the fence read
and becomes the receipt's signed `t` (its expiry derives from `t`, not from
a later `Date.now()` at mint)** — so a request that passes the check, gets
overtaken by P1, and stalls arbitrarily long still holds authority that
expires 12h after the CHECK, i.e. strictly before P2's ≥24h quiescence.
Both single and batch PUT paths. A failed/unavailable D1 fence read FAILS
CLOSED: 503, no receipt (bytes may sit in R2 unpublished; P2 reaps them).
Legacy no-receipt paths publish through the trigger and need no anchor.
Terminal inequality: authority anchored before P1 expires before any
delete; authority after P1 is never issued. No publication authority spans
a delete.

**The fence (immediate, trigger-enforced).** A new D1 trigger — the
`accounts_cap_guard` RAISE-ABORT pattern (`migrations/0014/0016/0021`) — on
the publication writes (`blob_refs` INSERT and the `blobs` presence upsert):
`WHEN EXISTS (SELECT 1 FROM gc_candidates c WHERE c.sha256 = NEW.sha256 AND
c.deleting_at IS NOT NULL) → RAISE(ABORT)`. Trigger failure fails the
statement, which **rolls back the entire `db.batch()` transaction** — real
whole-publication abort, not conditional no-ops (round-5 blocker 2 closed;
no per-statement predicates, no `changes` inspection, works unchanged for
multi-sha super-batches and the aggregate `used_bytes` statement). The
caller catches the abort and treats the CAUGHT SUPER-BATCH's shas as the
immutable failure unit returned in `needsUpload` (§3.1b — never a post-hoc
intent re-read); the client re-stages and siblings re-commit on retry.
Validation-time steering (§3.1) makes the abort rare.

**Day N+1..N+2 — P2/P3 (execute; 24–48h window under daily cron jitter).**
Only under the EXECUTOR LEASE (below). For intents with
`deleting_at < now − INTENT_QUIESCENCE_MS` (24h):
1. Re-check zero-refs in D1 (a publication that won before the fence landed
   is visible here) — refs > 0 → **activity-unwind**: DELETE the candidate
   row entirely (it is demonstrably live; Phase 1 re-marks if it becomes
   garbage again — no ordinary-candidate leftover, no restamp loop).
2. `R2.delete(sha)` — idempotent; the fence still stands.
3. **Head-verify**: `head(sha)` AFTER the delete.
   - Object PRESENT → a PUT landed after our delete; those bytes are intact
     (the only lease-holding deleter already fired) → **activity-unwind**
     (delete the candidate row; the fence drops; the waiting publication
     proceeds against real bytes).
   - Object ABSENT → our delete stood; proceed.
4. P3 cleanup batch: guarded `DELETE FROM blobs / blob_refs /
   gc_candidates` (zero-ref predicates). Only now does the fence drop —
   and the key is verified empty: any later PUT is a genuine fresh world.
   (A PUT between step 3's head and step 4 keeps its bytes for the same
   reason as step 3-present; its publication was fenced until P3 and
   publishes cleanly after.)

**Executor lease + takeover quiescence (round-7 blocker 2).**
`gc_state['purge_lease'] = {owner, acquired, expires}`; CAS acquire, TTL
20 min. Every executor is BOUNDED-DEADLINE by construction: the cron
invocation is platform-capped (15 min); the admin execute handler enforces
a code deadline — it dispatches no new R2 delete after 60s from invocation
start (self-imposed, tested). Takeover rule: a new holder may CAS-acquire
only when `now > expires + TAKEOVER_QUIESCENCE_MS` (30 min) — chosen so
that expiry + quiescence strictly exceeds any prior holder's last possible
delete dispatch (deadline) plus the R2 binding's in-flight op lifetime
(seconds; generous margin). Platform assumption, stated: an R2 binding op
dispatched by invocation X completes or fails well within 30 min — if
Cloudflare ever changes that, the margin is one constant. An expired
holder's late delete therefore cannot land after a successor's P3. **And
its late D1 continuation cannot either (round-8 blocker 2): every
intent-removing batch — P3 cleanup AND activity-unwind — carries a lease
guard (`WHERE …` subquery requiring `gc_state.purge_lease` to name THIS
executor's token) so it no-ops for a holder that lost the lease; and every
executor's final pre-delete D1 check requires the intent row to still be
open.** A paused holder resuming after takeover can neither delete bytes
(quiescence bounds its R2 ops) nor drop a fence (lease guard bounds its D1
writes).

**The correctness core** (round-6 restated — no invocation-lifetime claims):
- While the fence stands, NO publication commits (trigger; round-6
  confirmed this covers commit accounting, redeem, and both legacy upsert
  shapes).
- The fence drops in exactly two ways, both safe: activity-unwind (bytes
  demonstrably present or referenced — publication proceeds against real
  bytes) or P3 after head-verify-absent (key verified empty — any later
  PUT is fresh-world).
- A receipt minted before P1 expires ≤12h < 24h quiescence — its commit
  hits the fence and re-stages.
- Concurrent deleters are excluded by the lease; the residual zombie-HTTP
  ordering is prevented by per-chunk lease re-verification and the
  verify-after-delete rule (see lease note).

**Dropped as no longer needed**: mint-time rule (an accepted receipt for an
ordinary condemned row grants refs to bytes still in R2 — nothing deleted
pre-intent — and the existing grant-time un-condemn is correct);
`deleted_at`; publication epochs; the 2s δ. G1 collapses to "open intent →
not satisfiable"; design 33's "incl. receipt-satisfied refs" is met by the
trigger.

**Residual**: NONE in the publication-vs-delete space (by construction).
Remaining accepted imperfections: a client whose sha is fenced retries
across the 24–48h intent window (bounded UX delay on content that was
garbage for 7+ days); a fence abort fails an entire commit super-batch →
one client retry (recovery contract §3.1b).

## 3. Design details

### 3.1 Steering (fast path; the trigger is the authority)

`validateCommitRefs` (`commit-accounting.ts:64-104`) and `redeemReceipts`
(`workspace-sync.ts:405-460,661-675`): shas with open intents →
`needsUpload` up front (avoids fence aborts). `blobsCheck` (both modes,
`blobs.ts:70-139`): report open-intent shas as `missing`. Legacy verified
uploads (`blobs.ts:187-196,379-387`): keep their flow; their standalone
pre-grant candidate clear is removed (the grant batch's existing clear
covers it; clearing an open-intent row is prevented by making that clear
`AND deleting_at IS NULL` — an intent row must only be cleared by P2's
unwind). Resurrection (`versions.ts:87-91`): ordinary candidates only
(`deleting_at IS NULL`). Account-delete `INSERT OR IGNORE`: compatible.

### 3.1b Fence-abort recovery, per caller (round-6 finding 4)

The trigger message carries no sha; the safe unit of failure is the WHOLE
aborted batch. On catching the abort (`rbox_delete_fence` in the D1 error):

- **Commit accounting** (receipts commit): the failure unit is the CAUGHT
  super-batch — `commitAccounting` has it in scope
  (`commit-accounting.ts:137-191`); its shas are returned in the 422
  `needsUpload` DIRECTLY from the catch (round-7 finding 3: a later
  intent re-read is not a safety identity — P2/P3 may have resolved the
  intent in between). Re-validation may run only as an optimization for
  sibling batches, never to shrink the failed batch's re-stage set. The
  client's existing 422 contract drives re-stage
  (`src/cli/remote/commits.ts:158-180`).
- **`/receipts/redeem`**: same server-side conversion to its unsatisfied
  response; the CLI's redeem caller treats it as partial-redeem and falls
  back to per-blob staging (extend `commits.ts:124-145` to consume the 422
  shape rather than treating every non-2xx as fatal — small client change,
  shipped with the same release).
- **Legacy single/multipart upload publish** (`blobs.ts:187-196,379-387`):
  their standalone `INSERT OR IGNORE INTO blobs` can trigger-abort OUTSIDE
  a grant batch; map to HTTP 503 `retry_later`. Round-7 finding 4: the
  CLI's shared transport deliberately does NOT retry HTTP responses
  (`resilient.ts:197-219`), so this ships with a small client change:
  single PUT (`blobs.ts:95-110`) and multipart COMPLETE
  (`multipart.ts:132-156`) treat `503 retry_later` as a DEFERRED file —
  the daemon's existing write-finish/deferred retry machinery
  (`daemon.ts` deferredRetryPaths + safety tick) re-syncs it later, hours
  not milliseconds, matching the 24–48h fence window. Not an immediate
  transport retry (which would deterministically re-503 and re-upload the
  whole object).

### 3.2 Budgets and cursors (round-6 findings 5–6)

Constants: `BUDGET_SAFE = 800`, `FIXED = 10` (W snapshot, lease CAS +
renewal, two cursor writes, metrics), `PER_EXECUTE = 5` (refs re-check +
delete + head-verify + P3-batch share + margin), `P1_COST = 3` (one bounded
candidate SELECT + one multi-row UPDATE batch — a db.batch IS one D1
subrequest — + margin), `P1_MAX_ROWS = 200`.

**W snapshot algorithm (restored verbatim from rounds 4–6; round-7
finding 5 caught the v7 regression):** the invocation FIRST runs
`SELECT workspace_id, project_id FROM workspaces LIMIT maxW+1` (the real
0005/0006 schema — the exact rows reachability fans out to) where
`maxW = BUDGET_SAFE − FIXED − PER_EXECUTE − P1_COST − 1`; if the sentinel
row is present → emit `gc.budget_exceeded` and EXIT before any DO call.
The returned rowset IS the reachability fan-out input — count and
enumeration cannot diverge. Mark uses the identical gate:
`1 + W + 1 (list) + 1 (insert batch) + FIXED ≤ BUDGET_SAFE` or exit.

Combined worst case per purge-hour invocation:
`1 + W (reachability) + FIXED + P2_chunk × PER_EXECUTE + P1_COST ≤ BUDGET_SAFE`
⇒ `P2_chunk = max(0, min(200, floor((BUDGET_SAFE − (1+W) − FIXED − P1_COST) / 5)))`
— **an explicit zero-chunk exit**: at `P2_chunk = 0` the run emits metrics
and performs no P2/P1 work (the sharding signal), never a partial pass.
Order within the invocation: P2 (execute quiescent intents) then P1 (stamp
new intents), with P1's SELECT excluding rows P2 touched this invocation
(in-memory set) — no same-run restamp.

**Two cursors** (round-6 finding 5): `execute_cursor` iterates OPEN INTENTS
keyset-ordered by `(deleting_at, sha256)` — oldest intents first, so no
intent waits behind the 70k ordinary backlog; `intent_cursor` iterates
ordinary eligible candidates by `(marked_at, sha256)`. Both wrap; both
loss-tolerant. Execution window promise: 24–48h after stamping (daily cron
jitter), enforced-observable via the stale-intent metric at 72h.

Mark: `1+W` + 1 list page + 33-row statements in ONE batch + FIXED.
No tombstone sweep (no tombstones); stale-intent metric replaces it.

### 3.3 Migration 0024

```sql
CREATE TABLE IF NOT EXISTS gc_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
ALTER TABLE gc_candidates ADD COLUMN deleting_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_gc_candidates_execute
  ON gc_candidates (deleting_at, sha256) WHERE deleting_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_gc_candidates_intent
  ON gc_candidates (marked_at, sha256) WHERE deleting_at IS NULL;
-- gc_state holds purge_lease {owner,acquired,expires}, execute_cursor,
-- intent_cursor, mark_cursor. (No single purge_cursor — superseded.)
CREATE TRIGGER IF NOT EXISTS blob_refs_delete_fence
BEFORE INSERT ON blob_refs FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM gc_candidates c WHERE c.sha256 = NEW.sha256
             AND c.deleting_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'rbox_delete_fence'); END;
-- plus the analogous trigger on the blobs presence upsert (INSERT and
-- UPDATE OF present) — exact table/column names verified at impl time
-- against 0005_gc.sql/0017 (sha256, not sha — round-5 finding 4).
```


### 3.4 Scheduling, kill switch, observability, audit

`MARK_UTC_HOUR = 8`; `PURGE_UTC_HOUR = 9` runs P2/P3 for quiescent intents
FIRST, then stamps new P1 intents for tomorrow (same invocation, both
chunked within budget; regular phases: exactly 22 ticks/day; mark runs
regardless of the purge kill switch). `GRACE_2_MS` is subsumed by G3 +
INTENT_QUIESCENCE_MS (7d marked + 1d fenced ≈ the founder's 7-day intent).
`RBOX_GC_PURGE_DISABLED=1` gates the cron purge phase only (Env + both
wrangler vars blocks); admin endpoint immune. Metrics via `startOp`:
intents-opened, unwound (refs/young), purged, bytes, fence-aborts observed,
stale intents, cursors. Audit `?dryRun=1&cursor&limit` (server-clamped):
zero mutations — dry-run NEVER stamps intents; reports would-intent /
would-delete per page. Rollout expectation = sum over a full paging pass.
`releaseUsage` deleted from Phase 2 (I4). Fix `worker.ts:125-127` comment;
rewrite the `worker.ts:106-110` standing-decision comment.

### 3.5 Out of scope

IA tiering (design 89); §32 sharding; Queue continuation.

## 4. Invariants

- **I1 — fail closed** on any DO `/roots` error.
- **I2 — no publication AUTHORITY ever spans a delete, and D1 never durably
  claims R2 has bytes it lacks.** While a fence stands, no publication
  commits (trigger) and no authority is minted (checkTime-anchored
  refusal); authority anchored before the fence expires (12h) strictly
  before any delete (24h quiescence). Unpublishable bytes written during a
  fence MAY be deleted by P2 — by design; their uploader holds no authority
  and re-syncs via the deferred path. The fence drops only via
  lease-guarded activity-unwind (bytes referenced/present) or P3 after
  head-verify-absent. No residual ordering.
- **I3 — re-entrant**: the intent row is the durable handle; every
  worker-death point (before/after P1, before/during/after P2, during P3)
  resolves on a later run (enumerated §2); stale intents surface as
  metrics, and dual execution (cron + manual drain overlap) is idempotent —
  a dead invocation's work never resumes.
- **I4 — Phase 2 never changes `accounts.used_bytes`.**
- **I5 — manual escape hatch survives** (admin endpoint, kill-switch-immune).
- **I6 — observable; audit mutates nothing, intents included.**
- **I7 — budget-safe by construction** (bounded W snapshot gates AND feeds
  fan-out; defined constants).

## 5. Validation

1. **Unit** — fence trigger: multi-sha batch with one fenced sha aborts
   atomically; commit → 422 needsUpload conversion; redeem → partial-redeem
   fallback; legacy upload publish → 503 retry_later and succeeds after
   unwind (all four §3.1b contracts). Protocol: P1 guarded/idempotent and
   excludes same-run P2-touched rows (no restamp loop); publication-before-
   P1 → refs re-check activity-unwind DELETES candidacy; receipt-minted-
   before-P1 expires before execution (clock test); **PUT-between-delete-
   and-head-verify → present → activity-unwind → publication proceeds,
   bytes intact (round-6 blocker-1 test)**; PUT-between-head-verify-and-P3
   → fenced until P3, publishes after, bytes intact; **dual-executor: B
   holds lease, A's acquire fails (round-6 blocker-2 test)**; lease expiry
   + per-chunk re-verification; **check-wins → P1 stamps → DELAYED MINT
   still expires 12h after checkTime, for single AND batch receipt PUTs,
   and a D1 fence-read error mints nothing (round-8 blocker-1 tests)**;
   **A pauses before P3/activity-unwind → lease expires + quiescence → B
   takes over and dispatches → A's resumed intent-removal batch NO-OPS on
   the lease guard → B completes safely (round-8 blocker-2 test)**;
   worker-death matrix incl. death between delete and head-verify (intent
   stays open, next holder re-executes idempotently); resurrection ordinary-only; grants never clear open
   intents. Cursors: execute vs intent independence — a fresh intent
   executes within the window despite a 70k ordinary backlog. Budgets:
   sentinel W; combined P2+P1 arithmetic; mark one-batch math; audit clamp
   + never-stamps-intents. Kill switch; hour guards; I4; stale-intent
   metric at 72h.
2. **Dev rig / dev worker**: seed → age → mark → P1 (verify fence blocks a
   commit; client re-stage loop) → fast-forward quiescence (config
   override) → P2/P3 → R2 gone, restores work, usage untouched; re-upload
   purged content afterward → publishes cleanly (fresh world).
3. **Prod rollout**: deploy `RBOX_GC_PURGE_DISABLED=1` → full paginated
   audit (≈62 GiB / ≈70k summed) → founder eyeballs → supervised manual
   drain (intents day 1, executes day 2+) → 48h clean → flip the flag.

## 6. Size estimate

~450–600 net LoC across ~9 files — SMALLER than v5 (the epoch/tombstone
machinery is gone): trigger migration + fence-abort handling in both
publication paths (~80–110), two-phase purge + unwind + cursors + budgets
(~140–170), mark batching (~50), steering (~40), cron/kill switch/env
(~50), admin audit (~15), drain script (~50), tests (~250–350).
