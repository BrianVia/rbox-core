# 201 — Per-ref Git publishing (the held-ref publication lane)

Status: **PLACEHOLDER / PARKED** — 2026-07-24. Not designed, not scheduled, not reviewed.
This file exists so the problem and its acceptance criteria survive the cut; it is a parking
record, not a specification.
Origin: **cut from design 200 as P4 by founder ruling R5 (2026-07-24)** after three shapes
failed three adversarial codex rounds. Read
[200 §4.4](./200-worktree-lifecycle-resilience.md) (the superseded record, with the three
shapes and the code that killed each) and [200 §13.3](./200-worktree-lifecycle-resilience.md)
(the round-3 findings) before proposing anything here.
Relates: 200 (the cut), 174 (pending supersession — the mechanism that already covers the
fast-forward case), 130 (BASE authority, A/P/K artifacts, tombstones), 116 phase-0 (per-ref
worktree ownership), 163 (SQLite state plane — the likely 2.0-era home for per-ref state).

## Use case

A repository with a **held ref** — most commonly a live Git worktree holding a branch that has
diverged from what the fleet advertises — should still publish its *other* refs normally,
without carrying the whole incoming `pending` section as bookkeeping for the duration of the
hold. Today the wire unit is a whole `GitSection`: one held ref makes
`apply.ts:1447-1450` set `pending[rel] = remoteSec` for the entire repository, and
`normalizeOutgoingGitSections` then republishes that section by identity
(`publisher-tombstones.ts:183-186`), so the section's capture lane is gagged for as long as the
hold lasts. Unrelated work does still propagate in the ordinary case — design 174's pending
supersession clears the section whenever every pending ref's transition is a **fast-forward**,
which the rig scenario `worktree-squash-lifecycle` demonstrates empirically — but a *divergent*
hold alongside a *non*-fast-forward change on another ref of the same repository leaves that
repository's Git plane waiting for the worktree to go away. Design 200 accepts that residual as
bounded by the worktree's lifetime; this design is what would remove it.

## Why it is parked

Three shapes were specified and each failed on a **different** closed invariant, which is the
signal that per-ref publishing is fighting the whole-section wire model rather than being one
fix away: the **hybrid BASE** (round 2) broke bundle coverage — `incrementalCapturePlan` derives
the next basis and chain from BASE — and simultaneously contradicted
`pendingSupersessionAckConverges`'s deep-equality dry-run; **BASE-follows-published** re-armed
design 200 §1.2's wedge, because `logicalBaseRefs` is compared against the *physical* `beforeOid`
and a BASE member at a value this device never held names a pre-state that never existed here;
and **mutual exclusivity** (round 3) self-echoed, because a bar that keeps carried values out of
BASE also keeps captured ones out, so each ref publishes past the hold exactly once and then
freezes. Round 3 added four further blockers on the merged section itself — not operationally
v1.6.8-importable, prerequisite-incomplete, `MAX_PACK_CHAIN`-exhausting under self-echo, and
invalidatable by a receipted pending HEAD. The conclusion, and the ruling: the honest
prerequisite is a **per-ref wire/state model** — per-ref origins, per-ref BASE members, per-ref
settlement — not a fourth composition rule over whole sections. That is likely 2.0-era work,
plausibly alongside design 163's SQLite state plane, which is where per-ref state stops being
expensive to represent.

## Acceptance criteria

From the founder's ruled semantics, and deliberately stated as outcomes rather than mechanisms:

- While a worktree holds a divergent branch, **every other ref of that repository publishes
  normally**, with **no carried pending section** for the repository.
- The **held ref itself waits** — it is neither published at a value this device does not hold
  nor superseded — and its waiting produces **no whole-repository surface**: no repo-level
  deferral, no repo-level gag, nothing a user or agent has to act on.
- **Everything still clears at worktree deletion**, through design 200's absence-capture gate
  (P1/P1b) — this design must not weaken or bypass it.
- **No regression of the rig scenario** `scripts/rig/scenarios/worktree-squash-lifecycle.ts`.
  Specifically: design 200 §9.6 **relaxes** that scenario's phase-1 assertion
  `P2 no-escalation: capture must not be gagged (no carried pending section)` to tolerate a
  carried pending section while the hold lives. **This design REVERSES that relaxation** — the
  stricter original assertion becomes the gate again, and is the scenario-level definition of
  done.

## Landmines for the implementer

Each of these is verified against the tree as of 2026-07-24 and killed at least one earlier
shape. None is optional reading.

- **`gitCommitAncestry(Y, Y)` succeeds.** For any relayed/carried value the candidate equals the
  pending value, so `equalOrFastForward` is `gitCommitAncestry(Y, Y)`, which returns `"equal"` —
  not `"not-ancestor"` — and therefore **proves** supersession. Without an explicit bar on the
  relayed partition, a section declares the pending superseded without ever applying it, clears
  `pending[rel]`, advances BASE wholesale, and mints `publisher-ack` origins for values the
  device never held — reached through the **success** path, not a bug. It fails closed today only
  by luck (an absent object makes `rev-parse --verify` throw, and
  `provePendingSupersession`'s outer `catch { return false }` swallows it). Depending on not
  having an object is not a safety argument.
- **Publisher-ACK provenance must never be minted for a carried value.** `publisher-ack` is
  minted whenever the acked value equals the *advertised* value
  (`base-composer.ts:356-367`), and `advertised` is the whole committed section
  (`push.ts:962`, `:971`). Design 200 §3.3 rule 1 reads that provenance as licence to publish a
  **deletion**, so a forged origin here becomes a fleet-wide branch deletion two designs later.
- **Bundle coverage for any BASE that advances past held refs.** `incrementalCapturePlan`
  (`src/cli/sync-git/shared.ts:135-141`) derives the negative basis and the chain from BASE, and
  `captureGitState` passes those tips as `^tip` exclusions (`capture.ts:296-304`). Any model in
  which BASE's refs and BASE's bundle/chain can disagree produces sections that no follower can
  import. Every negative basis tip must be *proved* covered by the emitted chain, and
  `MAX_PACK_CHAIN` (8, `manifest-validate.ts:19`) bounds how long any chaining scheme survives.
- **The `logicalBaseRefs` physical pre-state guard.** `logicalBaseRefs` starts as a copy of
  `base.refs` (`follower-protocol.ts:80`) and is compared against the physical `beforeOid`;
  `branch-transition.ts:105` throws `branch transition does not match logical BASE pre-state` on
  any mismatch. **A positive BASE member must always be a value this device physically holds or
  held** (design 200 §7 invariant 1). This is the invariant that makes "just settle BASE to what
  we published" wrong, and it is not negotiable — it is what stops resurrection.
- **Old-reader compatibility is operational, not just schematic.** `importGitPackChain` skips a
  historical chain link whose commit tips are already present, relying on the invariant that
  restored index/op-state objects belong only to the **current** link
  (`src/engine/git/shared.ts:529-540`; same in `v1.6.8`). A section that is schema-valid for an
  old client can still be unrestorable by it.
- **The partition must be total.** Any per-ref model needs an explicit universe — pending ∪ BASE
  ∪ local/candidate ∪ held names — and all four classes (captured-present, captured-absent,
  carried-present, carried-absent). A universe of `pending.refs` alone cannot express a carried
  *absence*. Anything persisted that gates destructive tombstone authorship needs
  sorted-unique validation and a proved clearing point.
