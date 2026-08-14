# 247 — Trusted-view push (design-202 pattern, sender side)

Status: **REJECTED** (2026-08-14, review round 1 — premise falsified; recorded
so nobody rebuilds it).

## Why rejected (round-1 findings, verified)

- **The premise is false.** The daemon's only publish call site passes
  `this.local.manifest` (watcher-maintained) directly to `pushManifest`;
  `scanManifestForPushResult` runs only on CLI one-shots, resolution-receipt
  reconciliation, and 409/epoch recovery arms. There is no scan in the
  `state-load→git-plan` window to delete — the mechanism below is a no-op.
- **The superset claim has a counterexample.** The trusted view's manifest is
  entry-STRIPPED for deferred paths (pull needs omission); publish needs the
  opposite (carry — design 108: an omitted path IS a deletion; founding
  incident 126,557 phantom deletes). Handing the view to push publishes one
  deletion per unsettled path.
- **The refusal is not pre-effect on the push side** (capture.execute takes a
  commit lease + durable observation write before the breaker), and the
  mass-delete breaker only catches fleet-scale defects (≥1000 & ≥20%) — a
  poisoned view under those thresholds publishes executed deletes fleet-wide.
- **The 2.9s "scan gap" conviction was instrument deletion, not elimination.**
  The plausible real occupant: `projectLocalManifest` + `diffManifests` —
  O(workspace) matcher evaluation per push, delta-able with no trust view.

## What replaces it

1. Projection-only spans (start after `matcherForState`, stop before
   `capture.execute`; leg breakdown inside `projectLocalManifest`) via
   `appendDetails` — one Mac line convicts or exonerates.
2. If convicted: delta-scoped projection (incremental ignore-carry +
   collision fold from the same watcher deltas that maintain the manifest).
   No trust machinery; publishes identical bytes.
3. SEPARATE safety question recorded on #661: the publish path has NO trust
   gate today, and its failure mode (executed deletes fleet-wide) is worse
   than pull's. If ever built, it needs push-correct deferral carry, a
   pre-effect refusal point, and an answer for "what does an untrusted push
   do" — a safety design, not a latency one.

---

Original (rejected) text follows for the record.

## Problem (field evidence, 2026-08-14, fleet on e63c116)

Every daemon push op runs `scanManifestForPushResult` — a full workspace scan
— even when the daemon's watcher-maintained manifest is trusted. On the Mac
(31k files, 103 repos) this is the 2.9s `state-load→git-plan` gap, convicted
by elimination (`state_lineage=0.0s`, `matcher=1.8ms`, projection span
deleted; the scan is the only remaining occupant of the window). Desktop pays
~0.2s. Pulls stopped paying this cost in design 202; pushes never got the
same treatment. Slice 1 of the #661 build order.

Yardstick (phase 0): Mac no-op push cycle 7.8s → ~5s (gap ~0); desktop
unchanged (~7.0s content, gap already ~0.2s); zero convergence or safety
regression. Could get worse: a push planned against a stale view publishes
wrong bytes — the entire design is the gate that makes this impossible; and
conflict-retry pushes get slightly slower (deliberate: they always rescan).

## Mechanism

1. **One trust gate, one owner.** Reuse `buildTrustedPullView`
   (`src/cli/daemon/daemon-pull-transition.ts:44`) VERBATIM — same facts, same
   8 clauses (kill switch, watcher trust, observation settled, seed, reset,
   matcher-base, matcher-observation, drain+pending-empty with re-reads). The
   function is renamed `buildTrustedView` (mechanical; both call sites) since
   it now serves both ops. No second gate, no push-specific clauses: the
   invariants a pull needs from the local view are a superset of what a push
   needs (a push additionally never mutates the tree, so nothing weakens).
2. **Push accepts the view.** `pushManifest` gains the same optional
   daemon-only argument pull has (`TrustedLocalView` — the existing exported
   type from `sync/policy.ts`; no new type). When present:
   - `scanManifestForPushResult` is skipped; `manifest = view.manifest`,
     and `view.deferred` plays exactly the scan-omission role
     (`deferManifest` + oracle exemption list), mirroring design 202's pull
     semantics.
   - The push-side mass-delete breaker (design 108) evaluates over
     `view.manifest` with the identical predicate — the breaker compares
     candidate deletes against the last-synced base, so its inputs are
     unchanged in kind. It MUST keep firing; a poisoned watcher view is
     precisely what it exists to catch, and `TrustedViewRefusalError`
     (existing, design 202) is reused: on refusal the daemon re-runs the push
     scan-backed, never halts on the trusted attempt. Only the scan-backed
     re-run may throw `MassDeleteGuardError`.
3. **View lifetime = one attempt.** The view is read once at attempt start.
   On ANY `pull-first` (409) retry, `rescanReset()` performs a REAL scan —
   deliberate: the recovery pull just mutated the tree, invalidating the
   view, and post-#685/#690 conflicts are rare. No view refresh mid-op.
4. **Exclusions (view never used).** Foreground `rbox push`/`rbox sync` (no
   daemon facts exist); `purgeIgnored` publishes (`purgeSafety` matcher
   differs from the watcher's — the purge flow keeps its scan and its
   refusal semantics, `assertNoUnevaluatedPurgeDeletes` untouched);
   `deps.forceFullScan` / `RBOX_PREFLIGHT_FULL=1`; any repair/recovery push
   the daemon marks scan-backed today.
5. **Kill switch.** `RBOX_TRUSTED_PUSH=0` disables view construction for
   pushes only (default ON per founder default-on rule; design-202's pull
   switch stays independent so one mechanism can be rolled back without the
   other). With the switch off the daemon behaves byte-for-byte as today.
6. **Observability.** The existing scan phase simply disappears from
   view-backed push lines (scan spans print only when a scan ran); the push
   line gains the existing pull-style `fold=trusted` marker via
   `PhaseReport.recordDetails` on state-load — one token, no new format
   machinery. `drain_wait`/gap accounting unchanged and will show the win.

## Ownership

The daemon (adapter) owns view construction and the decision to offer it —
identical to pulls. `sync/push.ts` (domain) owns consuming it and every
fallback. The gate stays in `daemon-pull-transition.ts` (renamed export);
no CLI/HTTP surface changes.

## Skill audit (simplify-codebase-primitives)

- **Concept count:** zero new concepts. The view, its type, the gate, the
  refusal error, and the optional-argument seam all exist for pulls; push
  gains a second consumer of each, not a sibling mechanism.
- **New flag with owner + deletion condition:** `RBOX_TRUSTED_PUSH` — owner:
  daemon view-construction site. Deletion condition: after a two-week fleet
  bake with zero trusted-push refusals/regressions, collapse to a single
  `RBOX_TRUSTED_VIEW` switch governing both ops (or delete both if 202's has
  already earned deletion) — tracked as a checklist line in this doc on
  merge.
- **Challenged requirement:** does push need its own switch at all?
  Kept deliberately for the bake period only — a trusted-PUSH defect
  publishes wrong bytes fleet-wide (worse blast radius than a pull defect,
  which the receiver-side guards also catch), so independent rollback is
  worth one temporary flag. The deletion condition above is the exit.
- **Crash safety:** the view is consumed read-only inside one attempt; no
  new durable records, journals, or recovery paths. A crash mid-push behaves
  exactly as today (the attempt never persisted anything view-specific).
- **Compatibility:** no wire, state, or CLI surface change; kill switch off
  is byte-identical to today.
- **Safe deletion candidates:** none in this change (the scan path must
  remain for foreground/purge/fallback). The candidate this design CREATES
  is the flag itself, per its deletion condition.

## Non-goals

Delta-scoped git-plan (that's build-order slice 3); any change to pull's
trusted view; foreground command behavior; watcher trust semantics; the
mass-delete thresholds.

## Tests the implementation MUST write

1. View-backed push publishes the identical manifest a scan-backed push
   would for the same tree (differential: run both against one fixture).
2. Every withheld-view clause (P1-P7, kill switch) forces the scan path —
   reuse the existing pull-side clause fixtures pattern.
3. Mass-delete breaker on a poisoned view: trusted attempt raises
   `TrustedViewRefusalError`, scan-backed re-run runs, halts only per
   design-108 rules.
4. 409 retry after a view-backed first attempt rescans for real (assert the
   scan phase appears on the retry).
5. `purgeIgnored` and `forceFullScan` never consume a view even when trusted.
6. Kill switch off ⇒ scan path, byte-identical push line shape.

## Validation

Differential fixture (test 1) + full daemon/sync suites + rig FAST + field:
Mac push line gap `state-load→git-plan` drops to ~0 with `fold=trusted`;
desktop unchanged; one fleet soak day with the kill switch available.
