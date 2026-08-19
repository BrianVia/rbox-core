# 279 — Delta-scoped state-CAS locks: stop re-proving carried partial markers

Status: **ALIGNED r3** (final serial delta-confirm, one conditional
sentence folded: observedRepos key-set invariance + assign-into-source
implementer clause). Review ledger: r1 → 2 parallel opus lanes, both
CHANGES-REQUIRED (refutation lane: found #785 + 5 gaps; framing lane:
layer confirmed right, marker compaction rejected with evidence, 3
blockers folded). r2 → final serial opus review, CHANGES-REQUIRED (7
findings: #785 is a half-persist not a no-op; pin/claim mismatches;
effectivePartial goes dead; arithmetic + anchors). r3 folds all seven.
Codex confirm pass owed (quota until 2026-08-20).

Issue: #749 residual (FM 11.3–13s/pull CAS acquire). Parent: design 268,
whose ledger queued "reduce N: what does the CAS actually protect per
ref?" Depends on: **#785 lands first** (see §0).

## 0. Sequencing: #785 first, and why it changes this design's meaning

The r1 review discovered, and the final serial review sharpened, that
CAS-window state mutations **half-persist** today: `savePulledState`
captures `values`/`source` from the outcome **before** the CAS window
opens (pull-state-save.ts:70–91 vs :98). Helpers that *reassign* a
container (`dropPartial`; `carryUnreadableRefDatabase`'s pending/prior-
base/repoProofs/deferrals arms) never reach the saved packet — but the
helpers' `delete` arms (committed-transition-withdrawal.ts:49, :53)
mutate in place and DO land, because `values.bases`/`branchBaseOrigins`
bind by reference. Filed as **#785**. Worst arm: a BASE withdrawal for a
repo with no prior base persists the *deletion* of the composed BASE
while the pending restore and deferral record are silently lost — the
repo loses both BASE and pending in one save. The settlement half is
unaffected: `settleCommittedBranchArtifacts` reads the live outcome
after the CAS (pull-state-save.ts:109) and already sees the reassigned
containers.

Consequences for this design:

- The invariant r1 asked permission to relax — "an unprovable marker must
  never survive the CAS" — is **already dead in production**: CAS-window
  drops of carried markers (pure reassigns) have never persisted. Carried
  markers are already pruned only at consumption (apply.ts:706
  `partial[rel] = null`, which runs in the apply phase before capture and
  does persist).
- **Slice 0 of this design is the #785 fix.** Landing it *revives*
  carried-marker GC at the CAS; Slice 1 then removes that GC explicitly
  for carried markers. Sequenced this way, the behavior change is a
  deliberate product ruling, not an accident of a bug fix.
- Slice 0 fix shape: build the **outcome-derived members only**
  (`values`, `repoProofs`) inside the save closure — NOT the whole
  `source`: pulling `scoped.probeKeys(observedRepoKeys(...))` and the
  elision receipt into the closure would add their I/O to the held-lock
  window on authoring pulls. Concretely: assign into the existing
  `source` literal inside the closure; do not reconstruct `source`
  (reconstruction drags probeKeys/elisionReceipt back in).
  `source.observedRepos` stays outside the closure: it derives from
  `values` (pull-state-save.ts:89), but the CAS-window mutations only
  *move* a rel between `values` members (`bases`→`pending`) or touch a
  rel already in `repoRecordsForState(state)`, so the key set
  `observedRepoKeys` produces is invariant across the window — pinned
  alongside the #785 fixture. Red-first pins per #785: production-shaped
  call order + forced unreadable withdrawal, asserted for BOTH arms
  (`prior.base` present ⇒ saved state carries `prior.base` + carry
  proof; `prior.base` undefined ⇒ pending restored + deferral recorded,
  never the half-state), plus the settlement side of the same repo stays
  consistent (withdrawn repo excluded from settlement, artifacts still
  settle).

## 1. Problem (field evidence, FM 2026-08-19)

Every steady **zero-change** pull on flat-meadow acquires **1,882 CAS
locks** (`locks1882 blocked0`), spending 12.0–12.9s in `acquire` — the
single biggest pole of FM's 21–22s pull (target ≤10s). The count is
exact:

- FM's state carries 53 repos with a persisted `partial` marker (the
  held/deferred checkout set: skippedHeld=49 + deferred=4 that pull).
- Their `appliedRefs` sum to exactly 1,882.
- Per-lock cost on FM is the design-268 hardware floor (~2 dirty fsyncs
  ≈ 6ms × 1,882 ≈ 11.3s). The mechanism is at its floor; **N is the bug**.

`planStateCasLocks` (received-git-transition-commit.ts:95) requests one
lock per applied-partial ref for **every marker carried in state**
(`records[rel]?.partial`), not just what this pull touched. pegasus (508
refs) + savvy-core (419) — the #775 pair — are half of N alone. A no-op
pull performs O(workspace) durable work: the delta-scoped-work law
violated at the state CAS.

Two additional latent costs the r1 doc missed, both O(N in carried
markers) per pull:

- **Release is untimed**: `acquired?.release()` runs in the `finally`
  (received-git-transition-commit.ts:286) outside every span — N
  `releaseObservedLock` calls plus a full N-lock `observeLockMarker`
  re-scan (state-cas-locks.ts:235–255). Unattributed seconds inside the
  21–22s wall.
- **A hard cliff at N=4096**: `MAX_V2_LOCKS` throws the whole pull
  (state-cas-locks.ts:66–68). FM sits at 46% of a total sync outage that
  grows monotonically with held repos. This design removes the realistic
  path to that cliff.

## 2. What the CAS lock actually protects (the 268 question, answered)

The lock path is `<commonDir>/<ref>.lock` — **git's own per-ref lock**.
Holding it excludes any concurrent git ref writer on exactly that ref
between the final exact-ref proof and the state save. That is load-bearing
**for refs this commit newly claims**, and per-ref granularity must stay
(a repo-level lock would not be honored by git's ref writers).

For *carried* markers the proof protects nothing, because no consumer
trusts one (r1 review enumerated every reader; verdict: all re-prove or
are identity-only):

- **apply.ts:689–707** — consumption is gated on
  `gitIncomingKey(pend) === recordedPartial.incomingKey`, then
  `partialRefsStillMatch` re-proves against live refs; mismatch forces
  `local-commits` holds (fail-closed). `checkoutPending: false` is
  independently re-checked (`checkoutMatchesIncoming`, :699).
- **held-skip / held-decision** — the marker is an identity key only, and
  the steady skip is additionally gated on `localFingerprint`, which
  hashes loose-ref contents, packed-refs, and HEAD
  (fingerprint.ts:189–200, :270–290, :339) — an externally moved ref
  refuses the skip independently of the marker.
- **ref-plane-publication.ts:169–177** — persisted witness reuse sits
  inside `if (oldOid === newOid)` where `oldOid` is the live read, and
  requires `persisted.afterOid === newOid`. Never blind.
- **pRepaired receipts** (standing-branch-proof, reset-state,
  resolve-artifacts) — re-inspected against live artifacts at use;
  `partialRefsStillMatch` never covered them anyway (it iterates
  `appliedRefs` only; `heldRefs` likewise has no CAS-time proof today).
- **p-repair-state.ts** — writes on its own CAS and only ever *deletes*
  from `appliedRefs`; never injects unproven refs.
- **status / doctor / activity / json-output** — zero readers of
  `partial`. No user surface presents the marker as truth.

**Why the marker must persist per-ref (compaction rejected):** the marker
is the **divergence mask**, not a crash hint. `withoutRboxAuthoredRefs`
(apply.ts:74–89) needs per-ref identity to keep rbox's own applied refs
out of local-divergence detection; `forcedHeldRefs` enumerates per ref;
p-repair deletes individual refs; publication reuses per-ref witnesses.
Collapsing it to a held summary would make every held repo read as
locally diverged. The disease is O(marker) durable work per pull, not
marker size.

The invariant, restated as the product ruling this design requests:

> No marker **this commit writes** survives the CAS unproven. A carried
> marker keeps the proof it was committed with; every consumer re-proves
> before acting. (Post-#785 this is a deliberate choice, not the
> accidental status quo.)

## 3. Mechanism (Slice 1 — one function, no new state)

`planStateCasLocks` scopes to the transition set:

- **Partial locks**: iterate `Object.entries(outcome.partial ?? {})` only
  — rels whose marker this pull **authored** (non-null). The union with
  `Object.keys(records)` is deleted. Null entries (drops) plan no locks,
  as today. With both callers (`planStateCasLocks`,
  `revalidateGitPartialApplies`) iterating authored entries only,
  `effectivePartial`'s `records` fallback can never fire —
  **`effectivePartial` is deleted** (inline `outcome.partial?.[rel]`),
  along with `planStateCasLocks`' now-unused `repoRecordsForState`
  plumbing. No vestigial resolver survives the slice.
- **Branch-proof artifact locks**: unchanged — `outcome.repoProofs` is
  already delta-scoped.

`revalidateGitPartialApplies` delta-scopes identically (drop the `records`
arm of its rel set). Keeping a global unlocked re-proof was considered and
rejected: a mid-write observation could spuriously drop a valid marker
and force refs held — user-visible misclassification to save nothing.

Contract edits (owed, not incidental): `planStateCasLocks`' header
(:91–94) is rewritten to the §2 invariant. The two hygiene side-effects
that existed only for carried markers — the untrusted-`repoCtx` drop
(:110–113) and the lock-path-escape drop (:117–121) — now fire only for
authored markers; carried-marker hygiene's owner is consumption
(apply.ts:695→706). §5 records the residue.

Untouched: journal format, recovery, batching, release mechanics,
`revalidateCommittedBranchProofs` (already proof-scoped). N shrinks;
mechanism identical.

Instrumentation rider: time the release path into the existing
`casStepMs` channel (a `release` step observed around the `finally`
release) so the field differential can attribute both ends.

## 4. Effect (projected, then field-confirmed per perf close-out)

Steady no-op pull ⇒ **0 locks**, traced per class (r1 review confirmed
each return path):

- 49 held repos: `steadySkip` returns (apply.ts:932–939) with no
  steady-state `partial[rel]` or `repoProofs[rel]` write (the three
  assignment sites that precede it — :513/:516 published-checkout journal
  recovery, :637 config-apply failure — do not fire in steady state).
- 4 deferred repos: deferral returns (:414, :428, :450, :468) write
  `setDeferral` only — no partial.
- Converged/unchanged repos write `partial[rel] = null` (:655, :681) ⇒ no
  locks today either.
- Steady `repoProofs` carry only carry/`observed-landing` authorities;
  planStateCasLocks:133 admits only `pull-ref-transaction` /
  `journal-recovery`. Zero artifact locks.

Numbers: acquire 12.5s → ~0, plus the untimed release O(N) and the 53
per-carried-repo `repoCtxFromDisk` reads in `plan` also collapse. FM pull
21–22s → **~8–9s** by the bottom-up sum (git-apply ~4.5s + state-save
2.7s + validate/reconcile ~1s ≈ 8.2s; the spread over the naive
21.5−12.5 top-down number is the release + plan overhead that was never
in any span) — under the ≤10s yardstick. First
pull/join: locks = what the pull actually applied (same set as today);
268's floor still governs; the K-batch lever stays parked. Desktop/Mac:
fsyncs ~free; both lanes still measured per the close-out rule.

## 5. Safety analysis and named residue

- **Stale-marker exposure**: unchanged from production reality (§0) —
  CAS-window drops never persisted; consumers re-prove (§2). Post-#785,
  Slice 1 explicitly declines the revived GC for carried markers.
- **Marker immortality (named residue)**: a held repo whose pending
  advances past the marker's `incomingKey` never consumes it; the marker
  persists indefinitely. True today (drops don't persist), unchanged by
  this design — but now it is deliberate. It is bounded state (largest
  per-repo record member), invisible to any user surface. Ruling
  requested: **markers are immortal until consumption, by design**; if
  that ever bites, the remedy is a consumption-time GC slice, not
  CAS-time re-proof.
- **Blocked-lock asymmetry in shared common dirs**: `requested` maps one
  lockPath to a rel *set*; today a blocked lock drops every rel's marker
  (in-window — i.e., it never persisted anyway); post-change the carried
  sibling's marker survives while the authoring repo's drops. Fail-closed
  at use; pinned (§7).
- **Cross-repo incidental lock coverage**: linked-worktree siblings'
  carried locks today incidentally cover refs an `observed-landing`
  revalidation reads; the module already deliberately declines to lock
  for observed-landing, so removing accidental coverage is consistent —
  recorded, not defended.
- **Converged-shortcut abortability window**: today one carried marker
  anywhere makes the lease `committed` before revalidation; post-change a
  steady pull stays abortable through `revalidate-*` until the save's
  `beginCommit` (:277). A converged-shortcut BASE advance can now be
  discarded by `rbox stop` where today it was not — it re-converges next
  pull. Accepted, named.
- **Lease attribution**: `mutationRepos` narrows, so shutdown ambient
  status (daemon/daemon.ts:2395 → ambient-status.ts:425) reports the
  state-cas phase without `repository` on steady pulls.
  Observability-only, intended.
- **Crash window**: fewer locks ⇒ smaller journal ⇒ strictly less
  recovery surface; recovery is journal-driven and makes no
  full-coverage assumption over persisted partials (r1-verified,
  state-cas-lock-recovery.ts).
- **Zero-lock pull**: `prepareStateCasLocks` returns undefined; the
  :271–274 arm becomes the fleet's common path — no journal written, no
  directory residue (pinned).

## 6. Kill switch

`RBOX_CAS_DELTA_LOCKS=0` restores the carried+authored union in both
functions (one guard at rel-set construction; default on). Named caveats:

- On a host whose carried set exceeds `MAX_V2_LOCKS` (4096), the flip
  reinstates today's hard-throw cliff — the switch is diagnostic, not a
  safe steady mode; the cliff is pre-existing behavior, documented here
  rather than mechanized around.
- Post-#785, the flipped-on revalidation *does* persist its drops: a
  drifted carried marker is dropped and its next consumption re-derives
  holds per-ref. One-time cleanup cost on flip, not a symmetric restore.

Deletion condition: two clean fleet weeks.

## 7. Validation

- **#785 pins (Slice 0, red-first)**: production-shaped call order +
  forced `revalidateCommittedBranchProofs` withdrawal, both arms:
  `prior.base` present ⇒ saved state carries `prior.base` + carry proof;
  `prior.base` undefined ⇒ pending restored + deferral recorded (never
  the half-state). Same fixture asserts the settlement side: withdrawn
  repo excluded from `settlementRepos`, artifacts still settle.
- **Counting pins (red-gating)**: (a) a steadySkip repo contributes
  nothing to `outcome.partial` (asserted at the apply.ts:932–939 seam —
  this is where "→0" lives); (b) steady no-op pull with N carried markers
  plans **0** locks and writes **no journal**; (c) an authoring pull
  plans exactly its authored refs; (d) kill switch restores the union;
  (e) linked-worktree collision: two repos sharing a commonDir + refname
  dedupe to one lock with both rels' proofs; (f) blocked-lock asymmetry:
  a `blocked` outcome on a shared lockPath drops only the authoring
  repo's marker — the carried sibling's survives (the §5 residue,
  asserted).
- **Abortability pin**: on a steady zero-lock pull, `rbox stop` before
  the save's `beginCommit` (:277) discards the converged-shortcut BASE
  advance cleanly and it re-converges next pull (the §5 semantics
  change, asserted).
- **Immortal-marker inertness pin**: a carried marker whose
  `incomingKey` no longer matches pending is never consumed, never
  locks, and never alters classification (the apply.ts:694 gate is the
  only thing making immortality harmless — pin it).
- **Consumer re-proof pin**: carried marker goes stale (external ref
  move, no intervening consumption); next consuming pull drops + holds —
  the use-time defense carries what the CAS-time proof gave up.
- **Crash matrix on an authoring pull** (the seams are unreachable on a
  zero-lock pull): 268's real-process matrix re-run where a repo authors
  a partial; assertions unchanged.
- **Rig FAST suite** including git-entanglement before merge.
- **Field**: FM steady-pull differential (locks + acquire + release +
  total), desktop+Mac push/pull both lanes, per the perf close-out rule.

## 8. Requirement-challenge ledger

| Requirement | Cost | Alternative | Decision |
|---|---|---|---|
| Re-prove carried markers at every CAS | 11.3s+release/pull × forever — to compute drops that (pre-#785) were discarded | Prove-at-write + re-prove-at-use (this design) | **requested here** |
| Per-ref lock granularity for authored refs | ~6ms/ref on FM, only when authoring | none — git's own exclusion primitive; coarsening breaks it | keep |
| `git update-ref --stdin` `verify` as the proof | — | cheaper multi-ref proof under git's own locking, but cannot HOLD across the state save — the hold is the point | examined, rejected |
| Per-repo ref-DB fingerprint compare for the carried set (53 reads vs 1,882 locks) | keeps CAS-time staleness detection | fallback if field data ever shows a large authored set | recorded, not built |
| Marker compaction (held summary) | — | breaks the divergence mask (§2) | rejected with evidence |
| `configBase` carried but read by no one (apply.ts:539 carry-forward only) | dead durable state | deletion candidate, own evidence cycle | queued, separate |
| 268's K-batched appends | ~4.5s on join shape only | moot for steady state here | parked |
