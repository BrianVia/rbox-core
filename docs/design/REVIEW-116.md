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

## Open review work

- Confirm the Phase-0 incident reproduction and actual failing control-flow
  seam.
- Adversarially prove or reject the schema-5 common-store tracking convergence
  rule; if rejected, ship config-only remote tracking and split actual
  `refs/remotes/*` into a separate design.
- Verify the checkout linearization contract against real Git lock behavior and
  injected concurrent file/Git operations.
- Run formal arbitrage rounds to alignment before implementation dispatch.
