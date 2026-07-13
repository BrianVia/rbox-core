# REVIEW-116 — checkout follows sync

Design class: active Git correctness and no-clobber behavior.

Status: initial-draft scrutiny complete; formal `/arbitrage` alignment loop has
not run. The design remains **INITIAL**, not implementation-approved.

## Initial source and adversarial pass — CHANGES-REQUIRED

Three parallel read-only passes inspected the current apply/state model,
designs 43/93, status/daemon paths, and the drafted design. Findings folded
into the initial document:

1. **Reported root cause did not match current HEAD.** Current
   `localDivergedFromBase()` and `applyGitState()` do not read working-tree
   dirt. The design now requires a Phase-0 reproduction against the incident
   release/state and forbids changing the predicate on narrative alone.
2. **Shared tracking-ref fan-out.** Per-pointer complete `refs/remotes/*`
   snapshots could regress a common store like design 43's stash fan-out. The
   design now takes one bracketed snapshot per source commonDir and reduces
   receiver cohorts once by authenticated source sequence, with a cross-shape
   convergence gate.
3. **Object presence was mistaken for incoming ownership.** The design now
   separates incoming logical roots from the planned durable no-drop graph and
   excludes scratch/recovery names from ownership proof.
4. **Checkout TOCTOU holes.** Per-file tokens missed new paths and slow
   ref/config work left a race. The design now requires a second complete
   subtree proof plus HEAD/index/op/ref reclassification at the checkout
   lock/linearization boundary.
5. **Tracking absence and kill-switch false ACK.** Tracking is now a complete
   present-or-no-assertion lane; schema 4 cannot mean delete-all. `=0` disables
   only oracle-authorized checkout movement while safe ref/config/tracking
   progress and visibility remain unconditional.
6. **Partial state could not encode symbolic refs or newer config/tracking
   truth.** `appliedRefs` now uses direct/symbolic values and `incomingKey` is a
   canonical hash over every mutation-relevant field.
7. **Config independence contradiction.** A config failure no longer blocks or
   rolls back a safe checkout; config's existing lane markers retry it.
8. **Chronic age reset.** `deferredSince` now survives newer incoming sections
   and reason changes; `reasonSince` records the narrower episode.
9. **Diagnostics privacy gap.** Redaction now covers legacy and new raw Git log
   forms structurally, with omission as the fail-closed fallback.
10. **Self-busy checkout lock.** Busy probing is now ordered before owned lock
    acquisition, with ownership-aware probing afterward.
11. **Config merge-base loss.** Partial state retains the prior canonical
    config required for design-93 three-way retry after Git base advance.
12. **Current versus non-current local commits.** Only incoming-owned current
    tips authorize checkout; unrelated local refs are held while checkout
    follows, and recovery refs can prove no-drop but never authorize follow.
13. **Push-side invisible deferrals.** Capture/config/apply have independent
    generation-CAS episodes, including sidecar-only saves for no-op base carry.
14. **Partial marker trust.** Live refs are revalidated on every retry/save;
    partial state is a hint, never authority over a later human ref move.
15. **Index and stash semantic holes.** The design now defines a canonical
   semantic index projection and protects every local stash-reflog root, not
   only `indexTree`/the stash tip.
16. **Split-index transport.** Capture normalizes a bracketed private index copy
    to a self-contained full index before projection/encryption; receivers
    never depend on an uncaptured `sharedindex.*`.
17. **Post-plan failure hid capture age.** Capture lane set/clear transitions
    now save locally immediately after planning, independently of later remote
    push success.

## Round 1 (codex, 2026-07-13) — CHANGES-REQUIRED

1 BLOCKER + 8 MAJOR + 1 MINOR. All ten adjudicated against code and adopted
(no misreads this round); folded into the design marked `(r1 Fn)`:

- **F1 [BLOCKER] checkout crash atomicity.** `applyGitState` publishes refs,
  HEAD, index, op-state as separate mutations; `restoreLocal` is in-process
  only — power loss mid-publish leaves the half-moved checkout the design
  forbade while claiming the old rollback boundary sufficed. Adopted: durable
  gitdir checkout journal (old+new values, keyed by `incomingKey`), written
  before first checkout mutation, recovered before any classification (roll
  forward or back; any third value → conflict path), cleared in the state
  save; kill-injection tests at every boundary.
- **F2 [MAJOR] no receiver path-equivalence model.** Validation rejects only
  `toLowerCase()` twins; APFS case/Unicode-normalization aliases could make
  the oracle reason about a different namespace than Git's index. Adopted:
  byte-exact first, probed FS-equivalence for spelling mismatches, collisions
  and scan-deferred paths → `indeterminate`.
- **F3 [MAJOR] lock protocol unimplementable as written.** `update-ref
  --stdin` prepare takes ref locks; naive Git commands between prepare and
  commit self-block (current `clearIndexResolveUndo` runs `git update-index`);
  HEAD needs `symref-update` (modern Git only). Adopted: pinned sequence
  (private candidate index → transaction+prepare → index.lock → lock-free
  second proof → commit), capability probe, typed `unsupported` defer.
- **F4 [MAJOR] tracking-only changes never re-capture.** `gitIdentity`/carry
  matrix exclude `refs/remotes/*`; the LWW convergence claim was vacuous.
  Adopted: per-common-store `trackingKey` capture-dirt predicate, cache
  integration, `gitDivergenceStatus` mirror.
- **F5 [MAJOR] reachability proofs not fail-closed on shallow/partial/
  incremental stores.** Adopted: closure walks with lazy-fetch disabled,
  explicit tag peel, any missing object → `indeterminate`; shallow receiver
  defers checkout; chain-link tip-presence skip is not closure proof.
- **F6 [MAJOR] reflog-only commits lost on ref delete/replace; recovery-pin
  collisions unspecified.** Adopted: stash rule generalized — enumerate and
  pin unreachable reflog OIDs for every deleted/NFF-replaced ref in the same
  transaction; pins are create-only (expected-absent).
- **F7 [MAJOR] Phase-0 scrub-first ordering destroys evidence.** Adopted:
  daemon stop + immutable raw snapshot first, scrubbed archive derived from
  it; check live current-code candidates (needsResolution identity freeze,
  busy-carry incl. stale editor lockfile, pending suppression) before bisect.
- **F8 [MAJOR] schema-5 authorship interlock undefined.** Adopted: checked-in
  build constant `GIT_TRACKING_AUTHORSHIP`, false in the reader release, all
  stamp sites enumerated by a static test.
- **F9 [MAJOR] matrix under-crosses the state space.** Adopted: index/op-state
  divergence as crossed dimensions, pairwise closure over 12 dimensions × 3
  topologies, crash-injection rows per mutation boundary, alias rows.
- **F10 [MINOR] tracking map "applied once" overstated atomic observability.**
  Adopted: transactional all-or-none commit, subset-visible to concurrent
  readers, rbox proofs serialized.

Codex verified sound: the Phase-0 premise (current `localDivergedFromBase`
reads no working bytes; file apply precedes Git apply), scan-defer omission
behavior, ignored-path byte preservation, ownership/no-drop root separation,
stash-reflog enumeration, checkout/ref plane split, absence-supersedes-pending
and partial-hint revalidation, `=0` arm semantics, and the second-scan TOCTOU
closure.

## Open review work

- Confirm the Phase-0 incident reproduction and actual failing control-flow
  seam.
- Adversarially prove or reject the schema-5 common-store tracking convergence
  rule; if rejected, ship config-only remote tracking and split actual
  `refs/remotes/*` into a separate design.
- Verify the checkout linearization contract against real Git lock behavior and
  injected concurrent file/Git operations.
- Run formal arbitrage rounds to alignment before implementation dispatch.
