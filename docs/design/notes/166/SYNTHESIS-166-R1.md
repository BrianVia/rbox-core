# 166 r1 synthesis — orchestrator ruling: WRONG LAYER, v2 pivots to adopt-by-overlay

Both reviews CHANGES-REQUIRED with 6 BLOCKERs total, all accepted. The
findings compose into one meta-finding: v1 tried to teach the sync engine a
new multi-plane proof ("strictly-ahead is safe to publish") and every review
pass surfaced another plane the proof doesn't cover — refs, then
index/op-state/working (R1A-2), then sender-only untracked shadowing that
manufactures REAL deletions under the push breaker floor (R1A-3), then
nested-repo ownership (R1A-5), then per-ref scope/tag/stash matrix (R1A-6),
then BASE-composer authority shapes (R1A-7), with no implementable TOCTOU
fallback (R1A-4/R1B-4) and the fixture parked on two OTHER gates anyway
(R1A-1/R1B-1: local-edits + local-index fire before local-commits).

Per the standing founder rule (growing-complexity-means-wrong-layer): a
model that breaks on a new exotic input every round means the fix is on the
wrong plane. Find the battle-tested primitive.

## v2 direction — adopt-by-overlay (join-time orchestration, ZERO engine changes)

The entire problem exists because B's content predates the baseline, so
nothing can diff against it. Invert that at JOIN TIME, in init-cmd, outside
the sync engine:

1. `init --workspace` on a non-empty dir: atomically MOVE the existing
   content aside (same-volume rename to a journaled `.rbox/adopt-stash/`),
2. pull the baseline CLEAN (empty-dir join — today's fully-tested path),
3. OVERLAY the user's content back as ordinary post-sync local state:
   - plain files: write-back B's bytes over the baseline → classified by
     the NORMAL machinery as local edits → win and push. A-only files were
     materialized in (2) and overlay never deletes → no phantom deletions,
     no shadowing (kills R1A-3 by construction).
   - git repos: per-repo, replace the baseline copy with B's copy → the
     normal machinery sees "local repo changed after sync": strictly-ahead
     = local commits on a known base → capture publishes, fleet
     fast-forwards (the EXACT green path from git-ff's reverse-author
     step); truly diverged = today's protective deferral (correct);
     B-behind repos: skip overlay when B's copy is behind-or-equal
     (local heuristic only — worst case of a wrong call is today's
     protective deferral, never loss).
4. Crash safety: the aside-move is journaled; recovery = finish overlay or
   restore; user content is never in a delete path at any step.

Why this wins: every hard question the reviewers raised (index/op-state
ordering, oracle contracts, per-ref scope matrix, nested repos, BASE
authority, TOCTOU) is answered by machinery that ALREADY handles it for
the "user edited after sync" shape — because after overlay that is
literally the state. New code = file moves + a journal in init-cmd, where
every failure degrades to existing protective behavior.

Open questions v2 must pin (for the next wave):
- Overlay ordering vs the first capture/push (overlay fully, then one
  ordinary sync? daemon not yet started — sequencing is init-owned).
- adopt-stash retention/cleanup policy + explicit user messaging.
- The behind-or-equal skip heuristic's exact predicate and its journal
  record (so a wrong skip is visible + reversible from the stash).
- Disk headroom check before the aside-move (large workspaces).
- Interaction with `--respect-gitignore` / ignore layering during overlay.

## Bookkeeping

- v1's engine-side mechanism is ABANDONED, not folded. REVIEW-166-R1A/B
  stand as the record of why. Design doc rewrites to v2 around the overlay
  mechanism; the git-join-ahead rig scenario stays the gate with the same
  end-state contract (upgraded assertions from v1's test plan remain valid:
  convergence to B, no siblings, both settled, mixed ahead+diverged
  variant, B-behind variant).
- R1A-8's extra matrix (untracked A-only/B-only/differing, op-state,
  nested combos) carries into v2's test plan against the overlay mechanism.
