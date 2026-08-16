# 270 — Held-followed repos join the held-skip fast path

Status: DRAFT r2. r1's coverage argument was REFUTED (opus review): the
refs/rbox-local artifact plane — the composer holds' primary input — is
deliberately fingerprint-excluded (isSyncableRef filters it), and the
attempt-shredder r1 proposed narrowing is the compensating control for
exactly that blind spot. r2 adopts the reviewer's mechanism whole. Evidence: GH #752 defect A (recon 2026-08-16, anchors
on main 4f544f462). Parents: design 176/241 (held-skip + its protected
ledger), 174 (the livelock class), 236 (deferral naming), #641 (the
9,381ms→8ms precedent). Codex quota-benched; opus lanes.

## 1. Problem — measured, mechanism named

Three Mac repos (`mach-email`, `Personal/hacker-news-favorite-books`,
`Dfinitiv/.github`) re-run a full ~3.1-3.7s follow EVERY cycle, forever
(751 follow lines today) — ~half the Mac's 7.4-8s per-cycle git-apply.
The fixpoint is self-sustaining: `composeFollowRepoTransition`
(`follow-repo-transition.ts:319-337`) on a held follow re-arms
`pending`, sets an `artifact`/`local-commits` deferral, reports
`applied` — and that exact state vetoes every cheap path next cycle:
the steady bypass (`apply.ts:1164-1171` — deferrals/pending/partial/
attempt each individually disqualify), the unchanged shortcut
(`apply.ts:630` — `pend`), and #641's held-skip, because
`blockersAfterComposer` (`held-skip.ts:66-120`) manufactures
`provenance:"composer", reason:"artifact"` blockers that are NOT in the
skip allowlist (`held-skip.ts:46-56`). The push lane is simultaneously
gagged ("carrying pending verbatim") — design 174's livelock verbatim.

Control group proving the fix shape: the two `local-index`/
`local-operation` held repos ARE allowlisted → 8-27ms per cycle with one
full re-prove per hour (`HELD_SKIP_SAFETY_FLOOR_MS`, `held-skip.ts:29`).
The target is that exact behavior for composer-held repos.

## 2. Mechanism — the missing bracket, then eligibility

### 2.1 Artifact-plane digest (the fix that licenses everything else)

A single `for-each-ref` over the rbox artifact namespaces
(`refs/rbox-local/base-{absent,present,present-keep}/v2`,
`refs/rbox-local/base-absent-settled/v1`,
`refs/rbox-recovery/base-present/v2` — `base-artifacts.ts:13-16`,
`base-artifact-scan.ts:45-48`), refname+oid hashed, bound into BOTH
`earlyHeldAttemptDecision` (`held-skip.ts:309-343`) and
`observeHeldInputs` (`:236-251`) — the same primitive as
`readWorktreeRegistryDigest` (`:184-193`). This closes the fingerprint's
deliberate rbox-ref blindness for the skip path only; `gitFingerprint`
itself is untouched (241 ledger: never widen it).

### 2.2 Early-gate inputs

The EARLY gate (where the 3.1-3.7s lives — the late matcher runs after
the expensive prepare) additionally gains `record.partial` identity
INCLUDING `pRepaired` (`p-repair-state.ts:78-90` is the durable trace of
a user repair; a skip must never survive one). Cost: the record is
already in hand at `apply.ts:1224`; no second predicate, no new I/O
beyond §2.1's one `for-each-ref`.

### 2.3 Allowlist, scoped

Eligibility predicate: `provenance === "composer" && reason ===
"artifact" && code !== undefined`. Explicitly excluded: the vacuous
composer mint (`held-skip.ts:111-118` — an unexplained pending
disposition must stay non-vacuously blocking, its own comment's rule,
pinned by test); `checkout-incomplete` (unreachable in stored attempts —
the only recordClassification feed passes `checkoutComplete` hard-true,
`apply.ts:1029-1034` — and if ever reachable it is working-tree-shaped,
241's exact exclusion); protocol/checkout/boundary provenances that also
mint `reason:"artifact"` (`sync-state-model.ts:214-216` — never
analyzed, never admitted). Guarded invariant (reviewer N11): composer
eligibility additionally requires the stored proof's `checkoutComplete
=== true`, so a future composer call site with a working-tree-dependent
disposition cannot silently inherit the license.

### 2.4 The attempt-shredder stays

`standingPInvalidatedAttempt` (`apply.ts:833-836`, incl. the `pRepaired`
disjunct) is KEPT VERBATIM — provenance (#385) shows it shipped as
held-skip eligibility hardening: it is the one pre-digest place a pull
re-reads the artifact plane. With §2.1 it becomes redundant rather than
load-bearing; retiring it is a separate change with its own evidence per
the feature-retirement rule. r1's narrowing is WITHDRAWN.

### 2.5 Not changed

`composeFollowRepoTransition` re-arm/deferral semantics; the hourly
floor; ordered deferral refresh; every 241 ledger row; push-side gag
(174/#752-B owns convergence — this design removes cost only);
`blockersAfterComposer` output shape; design 251 buckets. Pin (reviewer
N10): the skip re-stands the STORED `subjectKey`; a bundle recapture
staling it drops `reproof` on the next full follow — asserted as a
fixture, not assumed away.

## 3. Protected contract (241's ledger, inherited whole)

Pre-fetch skip placement; semantic-key invalidation on semantic section
change; legacy late-match upgrade; blocker-plane retention; hourly
forced retry; fail-open observation (skip decisions never fail the
apply); state nonce/BASE/partial/reflog bindings; ordered deferral
refresh; pending/partial/BASE authority; NO second predicate in
apply.ts; NO widening git fingerprint to workspace content; NO manifest
oracle in the early gate. Plus: `blockersAfterComposer`'s output shape
unchanged (only the allowlist + key coverage change); design 251 bucket
accounting unchanged.

## 4. Per-repo evidence (RBOX_TRACE_HELD, Mac, 2026-08-16) + expected effect

[EVIDENCE TABLE PENDING — trace collection running; one row per repo:
storedAttempt / earlySkip / matchConsulted / mismatch / earlyReason /
blocker set. The allowlist fix is licensed only for repos whose
disqualifier IS the allowlist; `.github` (deferral reason
`local-commits`) may be disqualified elsewhere — candidate: its
classification includes `local-operation`, which `heldBlockersAllowSkip`
admits but `causallyClassifiable` (`held-skip.ts:80-85`) does NOT list,
leaving composer duplicates as artifact blockers. If so this design
fixes 2 of 3 and says so; the `.github` residual gets its own row.]

Expected: each fixed repo 3.4s → 10-30ms/cycle (control-group numbers);
hourly full re-prove retained. Field close-out per the perf rule.

## 5. Validation

- Red-first: composer-held fixpoint repo re-follows on identical inputs
  → skips after; hourly floor still forces full re-prove.
- Artifact-plane invalidation (the C1 scenario, pinned): write/delete a
  `refs/rbox-local/base-present/v2/*` ref between cycles → NEXT pull
  runs the full path (no hour-long pin after a user repair); same for a
  `pRepaired` write.
- Semantic invalidation: remote section change → full; bundle recapture
  with identical section → skip retained; subjectKey-drift fixture
  (N10).
- Vacuous-mint exclusion + provenance scoping fixtures (protocol-,
  checkout-, boundary-minted `artifact` blockers stay ineligible).
- Differential (re-specified per reviewer M8): durable record equality
  after N cycles (`base`, `branchBaseOrigins`, `pending`, `partial`,
  `deferrals`, `attempt`, `idxProj`) skip-on vs skip-off, PLUS the
  journal published-and-cleared pair asserted as a no-op — NOT naive
  per-cycle record identity (the held follow legitimately writes
  baseAdvance/indexProjection/journal that a skip does not).
- Kill switch: NEW scoped flag `RBOX_GIT_HELD_SKIP_COMPOSER` (default
  ON, defaults-ledger registered; owner: this design; deletion
  condition: one clean fleet soak). `RBOX_GIT_HELD_SKIP=0` remains the
  whole-mechanism lever — wrong blast radius for rolling back only this
  change (it would revert #641's shipped win too).
- Field: Mac re-measured; trio (or pair + named residual) follow lines
  drop to ~hourly; both lanes.
