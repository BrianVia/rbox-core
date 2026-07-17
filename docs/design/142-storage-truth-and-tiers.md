# 142 — Storage truth and tiers: quota counts your files, history gets cheap

v8 (IMPLEMENTATION SCRUTINY FIX — the eight findings from the Phase-0
implementation scrutiny are binding in the addendum below). v7 (ALIGNED — self-certified after Round 6: the three residuals were
self-consistency edits and concrete values now folded (buckets defer to
Section-A predicates by reference; snapshot identity is the
head/pruneFloor/index_generation triple with 3 retries and a
100-sequence drift threshold; inventory reconciliation is
per-lifecycle-state). Rationale for closing at six rounds: this is a
READ-ONLY diagnostic whose failure mode is a visibly-wrong number in a
re-runnable report — review depth is proportionate to risk, unlike 138.
The implementation PR's scrutiny pass must sanity-check the report's
numbers against the founder account.) v6 pinned Round-5's reconciliation
semantics (below). v5 closed Round-4's residuals with executable contracts (below). v4 first named them (exact predicates, pinned snapshot, measurable physical inventory). v3 folded Round-2's five blockers (see rulings). v2 was RESCOPED per Round 1's own sequencing rule ("Round 2 should not start
until design 142 records the production measurements"). v2 IS the Phase-0
measurement design; the tiering/accounting architecture (Phases 1-3) is
deferred to a v3 written AFTER Phase 0's numbers exist, and must then
explicitly supersede design 89 (server pricing, idempotent ledger, K=4,
receipt-stuffing, rollout) per Round-1 findings. Round-1's factual
corrections are adopted throughout: retention IS enforced (design 66;
plans.ts:10-12 comment is false and gets fixed as a rider); the hourly
reconciler already computes entitlement-ledger truth and self-heals
stranded entitlements after ~48h of grace UNLESS Phase-1 fails closed for
the account; the dominant charge path is commit-accounting (billing.ts is
legacy); authoritative versions live in DO seq:* roots, not a relational
table; pack-gc runs in SHADOW mode in prod.

## Problem (live incident, 2026-07-17)

The founder's own pro account hit `⛔ out of storage — 250.0 GiB of 250.0
GiB` while his actual working set (~/Development, 175k files) is a small
fraction of that. Three compounding causes:

1. **Version history is never pruned.** `plans.ts` documents it:
   `retentionDays` is "NOT yet ENFORCED — no plan-driven prune runs it"
   (design 06 specified versions-GC; it was never implemented). Every
   version of every file across 9,885 syncs is still charged.
2. **`used_bytes` may drift from reality.** It is a running counter
   (charged in `billing.ts:59-113`, conditional `used_bytes += size`),
   and `worker.ts:161` references a known leak + reconciler — some
   unknown fraction of the 250GiB may be phantom.
3. **The quota model itself charges history against the headline number.**
   Users reason about "my files"; being blocked by invisible history is a
   trust-destroying surprise. The paying customer (solo, 50GiB) is walking
   toward the same wall.

## Founder product decision (binding for this design)

> "It should just be whatever is my active state of files; everything else
> can be put in a lower tier of storage."

- **The user-facing quota counts the ACTIVE state**: the bytes of the
  current synced manifest across the account's workspaces (what you'd get
  materializing every workspace today). This is the number in `rbox usage`,
  `rbox status`, and the cap that blocks pushes.
- **History (non-head versions), within retention, moves to a lower tier**:
  R2 Infrequent Access storage class for blobs referenced ONLY by non-head
  versions. History does not count against the headline quota (a separate,
  generous history budget or plan-level fair-use line is the review
  question — the founder's framing implies it is not the user's problem).
- **Retention finally enforced**: versions older than the plan's
  `retentionDays` are pruned (design 06's spec is the starting point;
  this design supersedes where they conflict).

## Mechanism — Phase 0: the storage-truth report

A read-only measurement job (admin-triggered, per-account) structured as
TWO honestly-labeled sections (Round-2 f1: only the entitlement buckets
partition; the rest are diagnostics):

**Section A — the entitlement PARTITION** — exact predicates (Round-3):
one pure classifier function assigns every `blob_refs` row exactly one
label. Let HeadSet(acct) = union of SHAs referenced by each workspace's
CURRENT head root (pinned snapshot); let RetainedSet(acct) = union over
**every root currently retained by the pinned authoritative DO snapshot —
NOT window-filtered** (Round-4 f1: the DO may retain an expired root
until pruning catches up; it is still reachable — window/prune-lag
belongs in diagnostics, where the report separately shows
retained-but-window-expired bytes). Base partition per row (acct, sha):
`active-head` iff sha ∈ HeadSet; else `retained-history` iff sha ∈
RetainedSet; else `stranded` with EXACTLY these four sub-predicates
(Round-4): `fresh` (grant_age < GRACE_1), `aged-unmarked` (older, no
prune marker), `marked-young` (marker_age < GRACE_1), `purge-eligible`
(marked, marker aged past GRACE_1). **Anomalies are ORTHOGONAL FLAGS on
the base partition, not replacement labels** (Round-4): `missing-catalog`
(no `blobs` row — bytes unknown, counted) and `inconsistent` (exact
predicates, named columns: a `blob_locations` row whose pack id is absent
from pack inventory; or `blob_locations.length` ≠ `blobs.size_bytes` for
the same sha; whole-pack byte totals are NOT compared to per-blob sizes —
they measure different things) — a row keeps
its reachability label AND carries flags; partition totals remain
exactly-once. The **R−E diagnostic is restored**: roots referencing SHAs
with NO entitlement row for the account (reachable-but-unentitled),
reported in Section B. Buckets, bytes + counts:

1. **Active head**: blobs referenced by current DO head roots (reusing
   Phase-1's retained-reachable-set machinery, `gc-phase1.ts:42-56`, but
   split head vs non-head).
2. **Retained history**: blobs reachable only from non-head retained roots
   (within the plan's retention window).
3. **Stranded entitlements**: `blob_refs` reachable from NO retained root —
   subdivided by age vs the two GRACE_1 windows (i.e., "Phase 1 will purge
   these within 48h" vs "these have survived multiple passes — why?").
**Section B — DIAGNOSTICS** (overlapping views, labeled as such):

4. **Arithmetic drift**: `used_bytes` minus `SUM(blob_refs⋈blobs)` — the
   pure counter error `reconcileUsage` would fix.
5. **Phase-1 health — CURRENT-run probe** (Round-2 f2: historical
   completion is unprovable from existing evidence): the report RUNS the
   classification live and reports this run's outcome plus measured
   proximity to every fail-closed cap (unique-root count vs 750k,
   dropped-index pages vs 16, sequence-root pages vs 4 —
   `versions.ts:21-30,51-53,76-120`). Rider: per-account Phase-1 outcome
   logging is ADDED going forward (one structured log line per account per
   pass) so the historical question becomes answerable next incident.
6. **Physical inventory — GLOBAL, measurable, reconciling** (Round-2 f5,
   Round-3): (a) canonical object bytes from a bounded, resumable,
   READ-ONLY R2 listing of the canonical prefix; (b) ready-pack bytes from
   pack inventory; (c) each pack classified exactly once as
   active-only | history-only | mixed | orphan using `blob_locations`
   joined against the union of ALL accounts' pinned Head/Retained sets —
   tractable because the fleet is a handful of accounts, and the design
   states this scale assumption explicitly (at true multi-tenant scale
   this section degrades to sampled classification, flagged in-report);
   (d) pack objects are OBSERVED DIRECTLY and reconciliation is
   PER-KEY, PER-STATE for BOTH prefixes (Round-5): every listed R2 key is
   classified `matched` (in inventory, size agrees) | `size-mismatch`
   (in inventory, size differs — named physical anomaly) | `r2-only`
   (physical orphan) ; every inventory row absent from the listing is
   `inventory-only`, and inventory rows are grouped by their LIFECYCLE
   state first (staging | ready | condemned — each has a different
   expected R2 presence: staging may legitimately be absent, ready must
   be present, condemned may be either pending deletion), so `missing
   object` is only an anomaly for the states that promise presence. Bytes and
   counts per state per prefix; (e) the reconciliation identity is
   computed from those states — `matched + r2-only (+ size-mismatch
   observed side) = observed physical` per prefix, both sides printed;
   (f) LISTING SKEW is measurable, not hand-waved: the runner records
   listing start/end timestamps, excludes objects whose upload timestamp
   postdates the listing start, and prints the catalog-known bytes
   granted during the listing window as the skew bound — the identity
   must hold within exactly that bound.

**Snapshot protocol (Round-3, tightened Round-4 f2)**: roots reads are
THEMSELVES bounded keyset pages (never whole-list requests — the runner
must survive the exact cap-exceeding accounts it diagnoses): each roots
page is bounded, cursor-ordered, and carries a **snapshot identity TRIPLE** —
(head sequence, pruneFloor, index_generation) — since pruning and index
folding each mutate retained roots without advancing head
(`workspace-sync.ts:734-803,937-960,1006-1024`); if any page returns a
different triple the pin is stale — the runner's policy is re-pin-and-restart
the roots read (**3 retries**, then abort with a stale-pin report, never silently
blending generations). Acceptance gains CAP-EXCEEDING FIXTURES with EXACT assertions (Round-5):
each fixture is constructed to known numbers (e.g. 750k+K unique roots
across W workspaces) and the test asserts the runner (a) completes, (b)
reports page counts and cap-proximity figures EQUAL to the constructed
values, (c) classifies every constructed row into its intended bucket —
not merely "did not crash". The runner pins head sequence + retained root pages at scan
start (recorded in the report), then
classifies all pages against that pinned set. `blob_refs` enumeration is
strict keyset pagination (ordered `(account_id, sha)`, `>` cursor, bounded
pages ≤2000 rows, resumable from any cursor). Rows granted after the pin
are classified against the pinned roots and the report states the pin
sequences plus how far heads advanced during the scan; if head advanced by more than **100 sequences** during the scan the
runner offers a re-scan rather than silently blending epochs.

**Execution model (Round-2 f3/f4)**: the enumeration does NOT run inside
the worker sharing `reachableFromWorkspaces()`'s in-memory caps — it is a
**disk-backed local runner** (operator-invoked script) that pages
authoritative data via bounded READ-ONLY requests and spools to local
disk, so measuring a caps-exceeding account cannot itself fail closed.
Roots are read through a **strictly read-only path**: the existing
`GET /roots` can mutate DO state during bootstrap, so the runner uses a
new read-only variant (or a storage-level read that provably triggers no
bootstrap writes) — verified by a test asserting zero DO writes across a
full measurement run.

Output: JSON + human report per account; NO prod mutation of any kind.
Acceptance: runs against the founder's real account; Section A proven a
partition by construction; Section B labeled; the zero-DO-writes test
passes.

### Phase-0 implementation scrutiny addendum (v8)

This addendum is the executable contract for the fix round and supersedes
implementation details above where they differ:

1. **Live roots surface and adapter.** The Worker exposes fixed, slash-safe
   `GET /v1/admin/roots-inspect?ws=…&proj=…` before bearer authentication. It
   uses the same platform-secret gate as the existing read-only
   `delta-soak`, `multipart-inventory`, and pack-tombstone admin routes:
   `isPlatform()` constant-time compares `x-rbox-platform` with
   `RBOX_PLATFORM_SECRET`, and an unauthorized request is cloaked as 404.
   The route allowlists inspection parameters and forwards to the DO's
   pre-bootstrap `GET /roots-inspect` handler. The real source adapter folds
   the DO's independent dropped-index, sequence-root, and raw-gap cursors into
   one versioned opaque cursor, sums per-page `droppedRows` and `seqRootRows`,
   and expands sidecar descriptors with strictly validated read-only R2 GETs.
   Its zero-argument operator factory derives a transient sourceless Wrangler
   config from the selected checked-in environment, includes only D1 and blob
   R2, and marks both bindings `remote: true`; ordinary local-dev bindings stay
   local.
2. **Root times and retention lag.** The route enriches every returned root
   sequence with `commits.created_at` using read-only D1 queries. This is the
   same best-effort server clock the current retention job uses; a missing
   required time makes the workspace `uninspectable` rather than silently
   non-expired. The runner computes expiry as `!head && committedAt <
   startedAt - retentionDays*86_400_000`; an exact-cutoff root is not expired,
   any SHA also present in the head is not counted as expired, and a SHA with
   several historical references uses its latest retained commit time (so one
   recent reference prevents a false expiry).
3. **Full-run zero-write proof.** An end-to-end test drives
   `measureStorageTruth()` through the real roots adapter, admin forwarder,
   and `WorkspaceSync.rootsInspect` handler with a fake DO context. It includes
   all three cursors and a sidecar R2 read, while rejecting/counting KV, SQL,
   transaction, alarm, D1, and R2 mutations across the whole run.
4. **Disk checkpoint contract.** Workspaces, catalog, entitlements, fleet
   reachability, both inventory prefixes, both R2 listings, and their opaque
   cursors are persisted in the spool SQLite. Each page and its next cursor
   commit in one transaction. A matching account/schema spool resumes; a
   mismatch fails explicitly. Inventory/object reconciliation and pack-member
   classification are per-key SQL joins over the persisted tables—never
   whole-stream arrays or Maps. The listing start is persisted before its
   first page and the end only after every physical stream reaches terminal.
5. **Epoch disclosure timing.** Root pins are retained during entitlement
   enumeration. Only after the entitlement cursor is terminal does the runner
   re-read every workspace's current head, compute `headAdvance`, and decide
   whether to offer a rescan.
6. **Failure and cleanup.** Declared inspection/protocol unavailability returns
   a structured `status: "uninspectable"` report naming the workspace and
   reason. Snapshot churn still returns `status: "stale-pin"` after the three
   allowed retries. The spool database is closed in `finally` for every return
   or thrown transport error; thrown physical-stream errors retain committed
   cursors for retry.
7. **Required recovery fixture.** A roots source that becomes stale once on a
   continuation page and then recovers must finish with `retries === 1` and
   exact final bucket totals, proving the abandoned partial attempt was removed.
8. **Observability and CI.** The DO inspection SQL catch logs only the structured
   event and `errClass` (never account/root data or the raw message). Runner
   tests have a named package script, are included by `test:all`, and execute in
   PR CI. Acceptance is `bun run typecheck`, `bun run test:api`, the runner test
   script, `bun run test:all`, and the full-run zero-write test.

### Riders (same PR)

- Fix the false `plans.ts:10-12` retention comment (cite design 66).
- If bucket 5 shows the founder account fail-closed: file the cap-raise /
  pagination fix as an immediate follow-up issue with the measured numbers
  (NOT built in this design).

## Deferred to v3 (post-measurement) — recorded, not designed

Active-state quota semantics (saga across pre-CAS D1 work and DO
publication), IA tiering with mixed-pack relocation-or-accept economics
(CopyObject mechanics, IA minimums/retrieval costs, fleet cost model),
stuffing bounds and per-account quota-flip sequencing, and the full
acceptance matrix from Round 1's item 8. Every one of these is sized by
Phase 0's numbers — e.g., if buckets 3-5 dominate the founder's 250GiB, the
architecture may collapse to "fix Phase-1 caps + run reconcile"; if bucket 2
dominates, tiering economics lead.

## Founder rulings (2026-07-17, pre-v2)

- **Pricing unchanged.** Margins hold even at full standard-class utilization
  (~$3.75 COGS on $20 pro worst-case). Tiering is optimization, not rescue.
- **History fair-use policy (statement now, enforcement deferred)**: history
  rides free up to a multiple of the active quota (working number: 5×);
  beyond it, retention shortens oldest-first — never a surprise block. The
  v2 doc carries this as PLAN COPY + a stated future mechanism; **accelerated
  pruning enforcement is explicitly TABLED** until any account approaches the
  line (it is a parameter change to the existing retention job, so deferral
  costs nothing structurally).
- **Site copy follow-up**: once 142 ships, the rbox-home pricing page
  (Personal/rbox-home-page repo) gains the history/fair-use language —
  quota = your files; history included within fair use. Sequenced AFTER the
  shipped semantics, same week.
