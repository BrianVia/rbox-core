# 96 — Retained roots at O(churn): the dropped-set index

Status: ✅ ALIGNED v5, 2026-07-10 — 5 adversarial rounds (REVIEW-96.md), codex (sol) verdict ALIGNED; round-5 prose nits folded. v5 closed round 4: the
cardinality cap is enforced DURING local-set construction (per-insert
budget check against global.size + local.size), seqRootsPage gets its own
independent request cursor (fromSeq) with explicit exhausted-stream
semantics, and §6 now names the §4.2 heap/CPU/two-DO gate verbatim.
Pending round 5 (convergence). v4 was:
(1) per-ISOLATE fold mutex (module-level — two WorkspaceSync objects in one
isolate never fold concurrently; the loser re-arms +5s) + a two-DO
concurrent rig fixture as an explicit acceptance gate; (2) caller
reachability is SEQUENTIAL per workspace (Promise.all dropped — peak = one
local Set + the merged global, enforced against MAX_UNIQUE_ROOTS before
each merge; retries dispose the local Set first); (3) heap AND CPU are
MEASURED rig acceptance gates (250k×250k disjoint fixture, <110 MiB heap /
<20s CPU, with the pre-authorized paired-cap-lowering contingency);
(4) the wire schema replaced with the actual v3 shape and §4.6's constant
corrected to 90; (5) terminal transitions: seed txn sets ready when
F+1 == H; a genesis workspace (no commits) initializes ready-empty
atomically; (6) I2/I4 restated in full. Earlier: round 2 accepted;
the data algebra is now proven (codex round 2 validated inclusive-base gap
exactness AND that intermediate fold chunks need no generation bump). v3
closes the bounds/lifecycle findings: atomic seed incl. seq_roots(F+1),
iterator-based diff with FOLD_MAX_REFS = 250k (matching commit admission)
+ a measured rig gate with named contingency, a caller unique-root cap,
prune-deferral lifecycle (base term cleared at ready; permanent-lag is a
named degraded state with runbook), MAX_SNAPSHOT_RETRIES = 2 with
PER_WORKSPACE_ROOTS_COST = 90 total, and a bounded one-event-per-sequence
chunk protocol with CPU math. v2 was: the
indexed set is now the COMPLETE root set (data refs + per-seq manifest and
sidecar-carrier shas via a seq_roots table), gap reads are inclusive of the
synced base, backfill seeds from the first retained sequence and prune
defers rather than destroying unfolded inputs, fold memory/CPU is bounded
with lean string-set parsing + prev-set reuse + chunked SQL subcursors,
pages pin an index generation, gap responses carry usable descriptors,
alarm semantics and lag mode specified, design-95 costs become hard
fail-closed caps, and the hot-path claim is corrected (commit already
parses sidecars; alternatives compared in §8). Pending round 2.
Origin: the 2026-07-10 `/roots` OOM incident (contained by #198; full
diagnosis in the incident scratchpad, summarized in docs/STATUS.md).
Unblocks: design 95 rollout (G4 reachability), the manual GC drain, and by
extension design 89. Supersedes the diagnosis's "option 1" (raw-refset
pagination) — see §2 for why pagination alone cannot serve the primary
workspace.

## 1. Problem and evidence

`WorkspaceSync.roots()` enumerates every retained sequence and materializes
its FULL refset (`workspace-sync.ts:463-496` pre-#198): at the primary
workspace's scale (~102,660 refs/sequence × 1,070 retained sequences) that
is ~110M SHA occurrences ≈ 6.85 GiB of JSON built inside a 128 MiB DO —
deterministic OOM, fleet WS collateral (shared isolate), hourly
`phase1_account_failed`. #198 contains it with fail-closed caps (64
sequences / 500k refs), which leaves GC unavailable for exactly the
workspace that holds the ~62 GiB of reclaimable garbage.

Design 24 predicted this ("many retained sidecars could exceed DO limits…
promote a retained-root index if needed") — this design is that promotion.

## 2. Why not paginate the raw refsets

Pagination fixes the DO's memory, not the caller's budget: a page bounded
at ~200k refs carries 1–2 of this workspace's sequences, so a full
reachability pass costs 500–1,000+ subrequests for ONE workspace against a
~1,000/invocation platform budget (design 30) — before the rest of Phase 1.
Consecutive full-state commits share ~99.9% of their refs; shipping the
repetition and deduplicating at the caller is intrinsically the wrong
algorithm. The information GC actually needs is the UNION, and the union's
delta per commit is the churn, which is small.

## 3. The invariant that makes the index small

For retention floor F and head H, a sha is retained-reachable iff it
appears in ANY sequence in (F, H]. Equivalently:

> reachable = ROOTS(H) ∪ { sha : dropped_last_seq(sha) > F }
>             ∪ { manifest_sha(s), carrier_sha(s) : F < s ≤ H }

where `ROOTS(s)` is the COMPLETE per-sequence root set — the data refset
PLUS that sequence's `encManifestSha` and (for sidecar commits) the
`sidecarSha` carrier (round-1 blocker 1: `versions.ts:25-44` and
`workspace-sync.ts:477-504` retain all three today; carriers must survive
or future reachability proofs die). Data shas dedupe across sequences via
the dropped index; manifests/carriers are per-sequence-unique and are kept
in a tiny `seq_roots` table (2 shas/seq — 1,070 retained seqs ≈ one page).
Proof for the data part: a sha in refs(H) is reachable via H; a sha not in
refs(H) is reachable iff some retained s references it; its LAST such s is
its drop point (re-adds delete the row; later re-drops re-insert with the
newer seq). Only churned data shas need rows.

Index size = cumulative churn within retention, not workspace size. For
this workspace: 376,420 total blobs ever minus ~102,660 live ≈ ≤274k
dropped rows worst case (most of that is stress-join garbage that purge
will remove); steady-state churn is thousands, not millions.

## 4. Design

### 4.1 Storage — `dropped_index` in the DO

SQLite-backed DO storage (`ctx.storage.sql` — same backend as the existing
`storage.kv`; implementation verifies API availability in this runtime):

```sql
CREATE TABLE IF NOT EXISTS dropped_index (
  sha256   TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL      -- last sequence that referenced this sha
);
CREATE INDEX IF NOT EXISTS idx_dropped_last ON dropped_index (last_seq);
CREATE TABLE IF NOT EXISTS seq_roots (   -- per-seq manifest + carrier shas
  seq          INTEGER PRIMARY KEY,
  manifest_sha TEXT NOT NULL,
  carrier_sha  TEXT                       -- NULL for inline commits
);
-- kv keys: index_synced_seq, index_generation (bumped in each fold's
-- FINAL chunk txn only — intermediate chunks are union-neutral, round 2),
-- index_state ('building' | 'ready' | 'lagging'), backfill_cursor,
-- fold_subcursor (intra-sequence SQL chunk position).
```

`ctx.storage.sql` is available by existing guarantee: `WorkspaceSync` is
bound under the v1 `new_sqlite_classes` migration in BOTH wrangler env
blocks (`wrangler.jsonc:24-46,120-134`) — SQLite-backed DOs expose `sql`
and `kv` on the same backend. This is DO-internal storage, NOT a D1
migration (0025 stays free). Schema init: idempotent `CREATE IF NOT
EXISTS` in the DO constructor's existing bootstrap; the vitest fake DO
state gains a `sql` shim (test plan §6).

### 4.2 Maintenance — async diff per commit

Commit-time cost today already includes one sidecar fetch/hash/parse
(`resolveSidecarBytes`, `workspace-sync.ts:280-305`); this design adds ONE
preserve-earliest `setAlarm` write and nothing else synchronous — commit
stays O(1)-shaped, marginally not identically (round-2 NIT). After a
commit is accepted, the DO schedules an ALARM
that folds pending sequences into the index, one bounded step at a time:

- For each unfolded sequence s in (index_synced_seq, head]:
  - Obtain `refs(s−1)` — from the PREV-SET CACHE when stepping
    sequentially (the previous step's `refs(s)` is this step's base:
    halves R2 fetches and bounds live sets to two), else one R2 fetch.
  - Obtain `refs(s)` (R2 fetch or inline from the stored body).
  - **Lean parse + iterator diff (round-2 blocker 2)**: refsets parse
    directly to `Set<string>` (parser variant beside `refset.ts:82-103`);
    `removed`/`probe` are ITERATORS over the sets (never materialized as
    additional sets). `FOLD_MAX_REFS = 250_000` — equal to the commit
    admission cap (`commit-accounting.ts:35-40`), so no legal commit can
    exceed it. Budget at the cap: 2×(10 MiB buffer, freed after parse) +
    2×~25 MiB sets + chunk bindings ≈ 65–75 MiB transient per fold step.
    **Per-isolate fold mutex (round-3 blocker 1)**: a module-level
    (isolate-global) mutex permits ONE fold event per isolate at a time —
    two colocated WorkspaceSync objects never hold two fold budgets; the
    loser re-arms +5s (starvation-free: alarms retry, folds are seconds).
    §6 carries MEASURED acceptance gates: peak isolate heap < 110 MiB and
    fold CPU < 20s (vs the 30s alarm budget) on a 250k×250k disjoint
    fixture WITH a concurrent 250k-sidecar commit, live WS connections,
    AND a second DO attempting to fold (asserting the mutex defers it).
    **Named contingency if either gate fails: lower commit admission and
    FOLD_MAX_REFS together** (pre-authorized product decision).
  - `removed = refs(s−1) \ refs(s)` → UPSERT `dropped_index(sha, s−1)`;
    `probe = refs(s) \ refs(s−1)` (added only — round-1 finding 4) →
    DELETE matching dropped rows; INSERT `seq_roots(s, manifest, carrier)`
    from the stored body. **Bounded event protocol (round-2 finding 5)**:
    ONE alarm event processes ONE sequence completely — parse both sets
    once, then apply all mutation chunks (≤5k rows per `transactionSync`,
    deterministic order: removals by sha, then additions by sha, then
    seq_roots) in that same event; `fold_subcursor = {phase, lastSha}`
    persists per chunk SOLELY for crash-resume (a resumed event re-parses
    once and skips committed chunks via the subcursor);
    `index_synced_seq` + `index_generation` advance only in the final
    chunk's transaction. CPU math at the cap: parse 2×250k ≈ 2–4s + set
    diff ≈ 1s + ≤100 5k-row txns ≈ 3–6s ⇒ ~10s worst case against the
    30s alarm CPU budget — bounded, single event, no cross-event refset
    caching needed.
- **Alarm discipline (round-1 finding 7)**: one DO alarm exists;
  `setAlarm` writes only if no earlier alarm is pending (preserve-earliest
  helper); the handler re-arms on every exit path (success, caught error
  with backoff); commit-time arming uses the same helper. `ready` is set
  only when `index_synced_seq == current head` compared INSIDE the final
  transaction. If commit arrival outpaces folding, `index_state` reports
  `lagging` with a gap metric — an explicit mode, not an assumption.

### 4.3 Reads — `/roots` v2, paged over the small set

`GET /roots?fromSha=<cursor>&limit=<n>` returns, fail-closed:

```
-- request: ?fromSha=<dropped cursor>&fromSeq=<seq_roots cursor>&limit=<n>
--          &pinHead=&pinFloor=&pinGen=   (pins absent on the first page)
-- the two page streams advance INDEPENDENTLY via their own cursors; an
-- exhausted stream omits its next* field and the caller passes the
-- sentinel value 'done' to stop receiving that stream.
{ head, pruneFloor, indexGeneration, indexSyncedSeq,
  gap: [ { seq, manifestSha, carrierSha?,        -- [indexSyncedSeq, head]
          inlineRefs? | sidecar: {sha,count,size} } … ],  -- ≤ GAP_MAX+1
  droppedPage:  [sha…], nextSha?,                -- keyset, server-clamped
  seqRootsPage: [{seq,manifestSha,carrierSha?}…], nextSeq? }
-- the head's descriptor is gap's last element (inlineRefs for an inline
-- head); pages 2+ MUST carry the pin triplet and 409 on any mismatch.
```

- `index_state == 'building'` → 503 `index_building` (fail-closed, #198
  shape). `lagging` beyond `GAP_MAX (8)` unfolded sequences → 503
  `index_lagging`.
- **Gap contract (round-1 blockers 2 + finding 6)**: the gap is
  `[index_synced_seq, head]` — INCLUSIVE of the synced base (a sha present
  at the base and dropped within the gap exists nowhere else; reading the
  base closes it). For each gap seq the response carries a USABLE
  descriptor from the stored body: `{seq, manifestSha, carrierSha?,
  inlineRefs? | sidecar:{sha,count,size}}` — the caller fetches gap
  sidecars from R2 by descriptor (no extra DO round-trips). The head
  entry is just the last gap element (`inlineRefs` for inline heads —
  round-1 finding 1's dual-mode gap).
- `droppedPage` filtered `WHERE last_seq > pinnedFloor`, keyset-paged,
  `limit` server-clamped (20k ≈ 1.3 MiB). `seqRootsPage` for
  manifests/carriers `(F, H]`, same pagination (usually 1 page).
- **Snapshot pin (round-1 blocker 5)**: every page carries and the DO
  validates `{head, pruneFloor, indexGeneration}` — any fold, commit, or
  prune between pages changes one of them → 409 `snapshot_changed` →
  the caller discards THAT WORKSPACE's partial accumulator and retries it.
  Caller change (round-3 blocker 2): `reachableFromWorkspaces` processes
  workspaces SEQUENTIALLY (the `Promise.all` fan-out is removed — this is
  a cron path; wall time is cheap, memory is not). Each workspace builds a
  LOCAL accumulator with the budget enforced DURING construction: every
  batch of insertions checks `global.size + local.size` against
  `MAX_UNIQUE_ROOTS` and aborts fail-closed the moment the account budget
  is exhausted (round-4 blocker: a post-hoc pre-merge check would allow
  the peak it exists to prevent — e.g. 500k merged + a 500k local). A 409
  retry disposes the local Set before re-attempting. Peak caller memory ≤
  MAX_UNIQUE_ROOTS entries total by construction; the multi-workspace
  peak (A merges 500k, B attempts 500k) is the §6 test oracle.
- **Hard caps, fail-closed (round-1 finding 9; round-2 findings 2/4)**:
  `MAX_DROPPED_PAGES (16)`, `MAX_SEQROOTS_PAGES (4)`, `GAP_MAX (8)`;
  **`MAX_SNAPSHOT_RETRIES = 2`** per workspace per pass (a third 409 →
  fail-closed abort of that account's pass); **caller cardinality cap
  `MAX_UNIQUE_ROOTS = 750k` per account pass** (~75 MiB of Set strings in
  the Worker) — exceeding it aborts fail-closed with a metric (a
  pathological-but-legal 9×250k-disjoint-gap workspace fail-closes
  rather than OOMing the Worker). Worst-case per-workspace subrequests:
  `(1 + 16 + 4 + 8 + 1) × (1 + MAX_SNAPSHOT_RETRIES) = 30 × 3 = 90` —
  design 95 imports `PER_WORKSPACE_ROOTS_COST = 90` (its sentinel/chunk
  formulas re-derive at implementation; "unchanged interface" is scoped
  to the returned fail-closed Set only). Primary-workspace expected cost:
  ≈6–20.

### 4.4 Backfill — resumable, alarm-driven, fail-closed until done

Existing workspaces start `building`. **Base transition (round-1
blocker 3; round-2 blocker 1)**: the first retained sequence `F+1` SEEDS
the walk — its full root set is read, it produces no dropped rows, and the
seed transaction ATOMICALLY writes `seq_roots(F+1)` + `index_synced_seq =
F+1` + `backfill_cursor` + `index_generation` (crash-tested); folding
starts at `F+2 vs F+1`. Without the seed's seq_roots row, m/c(F+1) vanish
once the cursor passes it. (`F=0` ⇒ base is `seq 1`; there is no `seq:0`.) **Terminal transitions
(round-3 finding 5)**: if `F+1 == H`, the seed transaction ITSELF sets
`index_state='ready'` (compared against current head inside the txn); a
genesis workspace with no commits (`H == F == 0`) initializes atomically
as ready-empty (no seed sequence exists; the index is trivially exact). With prev-set reuse the walk costs ~1 R2 fetch per
step; ~1,070 steps at continuous alarm re-arm ≈ 1–3s/step ⇒ ~20–55 min
expected, bounded by the lag metric not a promise. Commits during
backfill extend `head`; the walk simply continues past the old head (same
fold step). Crash/eviction/retry-exhaustion: `backfill_cursor` +
`fold_subcursor` resume exactly; a manual admin `?rebuild=1` restarts from
scratch as the escape hatch.
**Prune vs unfolded inputs (round-1 blocker 3b; round-2 finding 3)**:
`/prune` REJECTS (409, retried each hourly retention tick) any floor
advance ≥ `index_synced_seq` (the backfill-base term applies ONLY while
`index_state='building'` and is cleared at `ready` — otherwise it would
veto every future prune). Lifecycle, stated honestly: while the index
lags, retention is deferred and retained storage grows — this is a NAMED
DEGRADED STATE (`gc.index_lag` metric + `prune_deferred` counter), not a
"brief" event. Recovery: normal lag self-heals (fold throughput ≫ commit
rate in practice — measured in §6); permanent lag (commit arrival ≥ fold
throughput sustained, or a FOLD_MAX_REFS alert) pages the operator with a
runbook choice: admin `?rebuild=1` rebase-to-current-floor, or admission
throttling (deliberate product decision, out of scope here). Fail-safe
direction is always: retention defers, data survives.
`/roots` 503s until `ready`; #198's caps remain as outer
belt-and-suspenders, raised above the new bounded shapes.

### 4.5 Prune interaction

Floor advance makes `dropped_index` rows with `last_seq ≤ F` (and
`seq_roots` rows with `seq ≤ F`) dead weight; a bounded sweeper
(`DELETE … LIMIT 500`) rides the existing alarm. Prune DEFERS to the index
when it would outrun `index_synced_seq` (§4.4) — the read-side
`last_seq > pinnedFloor` filter is authoritative regardless of sweep lag.

### 4.6 Interaction with design 95

95's G4 consumes the same fail-closed Set; everything else about the call
changes (pages, R2 fetches, sequential local accumulators) and 95's
sentinel/chunk arithmetic MUST be re-derived with
`PER_WORKSPACE_ROOTS_COST = 90` (the retry-inclusive hard cap, §4.3)
replacing the flat per-workspace term — a named integration task in 96's
implementation, not a drive-by. 95 merges kill-switched
before 96; 96's landing flips 95's rollout gate.

### 4.7 Hot-path facts and rejected alternatives (round-1 finding 10)

Correction: sidecar commit acceptance ALREADY fetches/hashes/parses the
sidecar (`resolveSidecarBytes`, `workspace-sync.ts:280-305`) — the fold's
`refs(s)` fetch duplicates that one parse. Accepted: reusing the in-memory
parse would couple commit latency to index writes (O(refs) SQL inside the
commit event) — the alarm keeps commits at today's cost plus one
preserve-earliest `setAlarm` write. Compared and rejected: (a) full
`last_seen` live index — exact and single-read, but O(live)=102k SQL
writes per commit, the coupling we just refused; (b) client-authored
delta/Merkle refsets — O(churn) by construction but a cross-version
client protocol change with signature-verification gaps (the server
cannot verify commit signatures), wrong blast radius for an
availability fix; (c) raw-refset pagination — §2.

## 5. Invariants

- **I1 — fail closed, everywhere**: building/lagging/snapshot-changed/page
  error → non-2xx → the account's GC pass aborts. Partial roots are never
  emitted with a 2xx (the cardinal rule; #198 precedent).
- **I2 — the union is exact at the snapshot**: ROOTS(H) ∪ dropped(>F) ∪
  seq_roots(F, H] at a pinned {H, F, generation} equals the brute-force
  complete-root union over (F, H] (§3, round-2-proven); the inclusive raw
  gap [indexSyncedSeq, head] closes index lag.
- **I3 — commit hot path preserved**: all index work is alarm-async; the
  only synchronous addition is one preserve-earliest `setAlarm` write.
- **I4 — bounded memory, measured**: a fold holds 2 lean sets ≈ 50 MiB +
  transient buffers ≈ 65–75 MiB, ONE fold per isolate (mutex), gated
  <110 MiB and <20s CPU in the rig; the caller holds one sequential local
  Set + the global, capped by MAX_UNIQUE_ROOTS before each merge.
- **I5 — idempotent, resumable maintenance**: any alarm step can crash and
  re-run; the index converges; `index_synced_seq` is monotone.

## 6. Validation

1. Unit: §3 equivalence — randomized commit/churn sequences, index union
   === brute-force union across floors/re-adds/re-drops; fold-step
   idempotence under injected crashes; gap handling incl. GAP_MAX 503;
   snapshot_changed on head/floor movement mid-pagination; backfill
   resume; sweeper; index_building 503; page clamp.
2. Rig: seed a large multi-sequence workspace, backfill, verify GC Phase 1
   completes where pre-96 it fail-closed. **Acceptance gates (normative,
   §4.2): on the 250k×250k disjoint fold fixture with a concurrent
   250k-sidecar commit, live WS connections, and a second DO whose fold
   the mutex must defer — peak isolate heap < 110 MiB and fold CPU < 20s;
   either failure triggers the pre-authorized paired lowering of commit
   admission + FOLD_MAX_REFS.** Verify /connect stays healthy throughout.
3. Prod rollout: deploy (backfill starts via alarm on first touch),
   watch index_state/synced metrics until the primary workspace reads
   `ready`, then a manual dry-run mark → the supervised GC drain (the
   design-95 rollout finally executes).

## 7. Size

~400–550 net LoC: DO index table + alarm fold/backfill/sweep (~180–230),
/roots v2 + caller pagination (~120–150), design-95 budget-constant touch
(~10), metrics (~30), tests (~150–250).
