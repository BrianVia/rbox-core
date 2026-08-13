# 243 — Name the git-plan's hidden costs (instrumentation slice)

Status: DRAFT r2 (issue #661 slice 2; r1's whole-plan reuse mechanism CUT
after a 2-reviewer wave — see §5)

## 0. Yardstick

Helped = the next zero-change field push tells us exactly where git-plan's
3.4s and the 2.1s pre-plan gap go, in named buckets, so the next
optimization slice targets a measured cost instead of a guessed one.
Worse-risks: none material — pure instrumentation; the only trade is a few
extra timing fields on the phase line.

## 1. Evidence (first instrumented push, Mac, 2026-08-13 19:13Z)

`rbox push files=0 blobs=0 … 6.0s | git-plan 3.4s hit100m0u0
ms[t3397 d818 j20 f488 h98 o1973]` — one hundred fingerprint HITS, zero
misses, yet the plan still paid 3.4s. The buckets we have: discover
d=818ms, journal j=20ms, fingerprint f=488ms, hygiene h=98ms — and
**o=1973ms unbucketed inside the plan loop**, the single largest cost,
with no name. Separately the state-load→git-plan gap is 2.1s and has no
span at all: the existing `candidate_projection_ms` span is NOT a
projection-only measure — it opens before lineage/matcher work
(push.ts:506) and closes after `preparePublishCandidate`, so it contains
the entire git-plan phase, and `formatPushSpan` renders it in seconds
despite the `_ms` name (format.ts:11). The 2.1s residual is suspected
lineage/matcher work, unnamed until this slice.

We do not know what 4s of a 6s push is. That is the problem this slice
solves. No optimization ships until the cost has a name.

## 2. Mechanism

1. **Split plan `otherMs` into named constituents.** Inside the plan loop
   and its epilogue, time each real phase separately — carry bookkeeping,
   removal-memory pruning, current-state projection, divergence-cache
   refresh/save (anchors: plan.ts:462-1496). The buckets MUST form a
   mutually exclusive top-level partition of wall time: publisher-lineage
   binding already lives inside `journalPreloopMs` (plan.ts:505 within
   482-556) and conflict-ref retention already IS `hygieneMs`
   (plan.ts:1427) — anything nested inside an existing bucket is a
   drill-down detail excluded from the `t ≈ Σbuckets` reconciliation,
   never a second top-level bucket (`otherMs` subtracts all timings from
   wall time at plan.ts:391; overlap would double-count). Rendered into
   the existing `ms[…]` fragment by `formatGitPlanStats` (plan.ts:1515).
   `o` should shrink to a residual near zero.
2. **Name the 2.1s pre-plan gap.** Wrap `ensureCapableStateLineage` and
   `matcherForState` (push.ts:506-513) with named spans surfaced through
   the #679 phase-report details (`PhaseReport.appendDetails`,
   phase-report.ts:206).
3. No caching, no gating, no behavior change. The semantic plan surface
   (excluding `gitPlanStats`, which intentionally gains fields), physical
   effects, recovery paths, and control flow remain identical — matching
   how existing parity tests already strip stats (git-sync.test.ts:405).

## 3. Non-goals

- **No workspace-level plan reuse** (r1's mechanism — cut, see §5).
- No matcher memoization (issue #663; becomes slice 3 only if the new
  spans convict matcher construction).
- No commit-RTT work, no scheduler changes, no knobs.

## 4. Validation

- Existing plan differential/parity suites green (stats are already
  excluded from parity surfaces — git-sync.test.ts:405).
- One field push on the Mac shows the split buckets; sum of named buckets
  ≈ old `t` total (no double-counting, no gaps > ~50ms).

## 5. Rejected: whole-plan reuse gate (r1, 2026-08-13 wave)

Two independent codex reviews (CODEX-R1-1/2, both CHANGES-REQUIRED)
refuted r1's `workspacePlanKey` reuse mechanism structurally, not
editorially. The kill reasons, preserved so nobody rebuilds this shape:

- The plan loop is not a pure function: even an all-hit run performs
  checkout-journal crash recovery, discovery/topology observation,
  removal-memory pruning, time-based conflict-ref deletion (90-day
  retention), and divergence-cache maintenance. Reuse skips mandated
  recovery and hygiene indefinitely.
- The proposed key omitted correctness-bearing inputs (BASE/pending/
  resolution state, forceGitRecapture from 422s, republish sidecar,
  journal contents, tombstone time, policy switches) — closing it means
  binding "all planner state," i.e. an epoch, i.e. a new authority.
- The git signal channel is pathless (`push("signal")`, `onSignal():
  void`) — the per-repo dirty set would be new machinery, not a feed.
- A rotating re-fingerprint sweep cannot catch a fingerprint-beating
  mutation by definition; the safety valve as specified was impossible.
- The gate site (shared push adapter) has no access to watcher
  trust/backend; the borrowed P1 predicate doesn't exclude chokidar.

Verdict: wrong layer. If a plan-cost slice is still needed after the
buckets land, design it against the *named* cost (e.g. cache repo
discovery, or make the specific dominant sub-phase delta-scoped), not
against the whole plan output.

## 6. Ownership

plan.ts owns its buckets; push.ts owns the two new spans; the phase
report owns rendering. No new state, no new owner.
