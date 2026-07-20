# 166 — adopt-by-overlay: non-empty joins converge through the normal pipeline

Status: v2 — architecture pivoted per SYNTHESIS-166-R1.md (v1's engine-side
forward-carry ABANDONED after a 6-BLOCKER review wave, REVIEW-166-R1A/B —
wrong layer per the standing growing-complexity rule). Pending adversarial
review.
Owner: Claude (founder-directed 2026-07-19: highest priority)
Severity: core adoption flow — binding a machine whose content is ahead is
currently safe-but-parked with no manual escape (`keep-mine` unimplemented).

## Problem (unchanged from v1; field evidence)

Rig scenario `scripts/rig/scenarios/git-join-ahead.ts` (the gate): machine B
joins a workspace with the same repo on disk, shared history, two commits
ahead, plus an untracked file. Today: B's git plane parks
(`local-commits` hold → pending-carry suppresses capture forever), the file
plane reverts B's newer working copies to A's older bytes (conflict
siblings preserve the data), and the fleet never converges. Root cause of
the wedge shape: B's content exists BEFORE any baseline, so no plane can
classify it as "changes since the workspace state" — the engine's entire
safety model keys off exactly that classification.

## v2 mechanism — adopt-by-overlay (join-time orchestration, zero engine changes)

Make the missing baseline exist. `rbox init --workspace <id>` (and the
wizard path that reaches it) on a NON-EMPTY directory becomes a three-phase
join, owned entirely by init-cmd (the engine, wire format, capture,
classification, and reconcile are untouched):

### Phase 1 — aside-move (journaled, same-volume, never a delete)

- Enumerate the directory's existing content (excluding `.rbox`).
- Write an adopt journal (`.rbox/adopt/journal.json`): phase, the moved
  set, timestamps. fsync before any move.
- `rename(2)` the content into `.rbox/adopt/stash/` (same volume —
  atomic, O(entries), no copying). Nothing is ever unlinked in any phase.
- Disk/precondition checks first: same-filesystem verification for the
  stash root, headroom for phase-3 rewrites, refusal (with a clear
  message) if `.rbox/adopt` already exists from an interrupted run —
  `rbox doctor` offers resume/restore.

### Phase 2 — clean baseline join

- The directory is now empty: run today's EXACT empty-dir join
  (`init --workspace` + first pull). This path is the most-tested join in
  the product (every rig provisionPair run exercises it). The file BASE,
  repo records, and git BASEs are all established normally.

### Phase 3 — overlay (recreate "user changed things after sync")

Walk the stash and lay B's content back over the baseline, so the normal
machinery classifies everything with a real baseline underneath:

- **Plain files / untracked paths**: move B's version over the baseline
  path (baseline version is overwritten in the working tree only — it
  remains in the synced history/versions plane). A-only baseline files B
  never had are simply LEFT IN PLACE — overlay never deletes, so absence
  on B cannot become a deletion (kills v1's R1A-3 hazard by
  construction).
- **Git repos** (paths that are repo roots in the stash): compare stash
  repo vs baseline repo with ONE local read-only probe per repo:
  - baseline tips all ancestor-or-equal of stash tips (stash is
    ahead-or-equal) → replace the baseline repo dir with the stash repo
    (rename swap). The engine then sees "local commits on a known BASE" →
    next capture publishes, the fleet fast-forwards (the exact green path
    from git-ff's reverse-author step; post-165 followers converge).
  - stash strictly behind-or-equal → keep the baseline repo (B gains A's
    newer state; stash copy retained in the stash for the retention
    window).
  - anything else (diverged, unrelated, probe error) → replace with the
    stash repo anyway; the engine classifies it as local divergence from
    BASE → today's protective deferral + conflict machinery (correct for
    true divergence; never silent loss). The probe is a LOCAL
    ROUTING HEURISTIC only — a wrong call degrades to existing
    protective behavior, never to data loss, because both copies persist
    (stash retention) and the engine's own proofs re-run at sync time.
  - nested repos: process most-specific-first (deepest repo roots swap
    first, then ancestors treat the already-swapped subtree as opaque
    content); the engine's existing nested-repo handling owns semantics
    from there.
- Journal advances per entry (crash mid-overlay resumes idempotently:
  each entry is move-or-skip, re-runnable).
- Finish: journal marked complete; ONE ordinary `sync` (pull+push) runs;
  stash is RETAINED at `.rbox/adopt/stash/` until the user clears it
  (`rbox trash`-style messaging: "your pre-join copies are kept at … —
  remove after verifying"). Retention is the safety net for every
  heuristic above.

### What the engine sees

After phase 3, the machine state is indistinguishable from "synced
workspace + user edits/commits made afterward": modified files push as
local changes; ahead repos publish; diverged repos defer; behind repos
already converged in phase 2. Every invariant the v1 reviews attacked
(index/op-state ordering, oracle contracts, per-ref scope/tag/stash
matrix, BASE authority, mass-delete proofs, TOCTOU) is enforced by the
machinery that already enforces it for that everyday shape. No new engine
semantics exist to be wrong.

## Scope rules

- Applies to `init --workspace` (join) on a non-empty directory, including
  the wizard route. `init --new` (create) is untouched — its existing
  content IS the workspace-to-be.
- Interactive route says what will happen before doing it ("this folder
  already has content — rbox will sync the workspace baseline first, then
  merge your newer files/commits on top; pre-join copies kept at …") with
  confirm; `--no-interactive` proceeds (default-on) with the same
  messaging printed.
- Ignore layering: the overlay walk applies the SAME effective ignore
  rules as a normal scan (builtin + gitignore-respect setting +
  .rboxignore from the pulled baseline) — ignored paths overlay to disk
  but simply won't sync, exactly like today's untracked-by-rbox files.
- `RBOX_ADOPT_OVERLAY=0` kill switch: falls back to today's behavior
  (join-in-place), for containment only.

## Safety analysis (each claim mapped to a test)

- Nothing is ever deleted in any phase (moves only; stash retained) — a
  crash at ANY point leaves every byte in either the workspace or the
  journaled stash, with `rbox doctor` resume/restore.
- A-only content: materialized in phase 2, untouched by overlay → synced
  state keeps it; B gains it. No deletion can be manufactured (v1's
  worst hazard, closed structurally).
- B-only content: overlays as new files/repos → pushes as additions.
- Colliding tracked files (B ahead): B's bytes overlay → local edit →
  push wins; A's version remains in version history. No conflict sibling
  for the strictly-ahead shape; genuinely concurrent edits still produce
  today's conflict handling at sync time.
- Second machine publishes during the join: phases are local; the
  post-overlay sync uses the ordinary CAS/pull-first machinery.
- Large workspaces: phase 1/3 are renames (O(entries), no data copy)
  except the git behind-or-equal keep-case (no copy either — keep =
  no-op). Headroom check covers journal + baseline coexistence with the
  stash (baseline content B lacks is the only net-new disk).
- Mixed versions: no wire/schema change at all; other machines see
  ordinary pulls/pushes.

## Tests the implementation MUST provide

Rig (`git-join-ahead` upgraded to the v1 contract, unchanged):
1. Current safety assertions stay green; PLUS: no conflict siblings for
   the ahead repo; B tree clean vs B HEAD; B's push publishes; A
   fast-forwards within one cycle; both records settle; idle cycle stays
   settled; A-only baseline file present on B and NEVER deleted on any
   subsequent push (explicit assertion, v1-R1A-3's hazard).
2. Mixed variant: one repo ahead (converges forward), one repo truly
   diverged (defers with today's machinery), plain colliding file (B
   wins), A-only untracked file (survives everywhere).
3. B-behind variant: baseline kept, B gains A's state, stash retains B's
   old copy.
4. Crash-resume: kill between phases 1/2 and mid-phase-3; doctor resumes
   or restores; no byte lost (assert full content inventory vs pre-join).
5. Kill switch: `RBOX_ADOPT_OVERLAY=0` reproduces today's parked behavior.
Unit: journal state machine (all phase transitions + idempotent re-runs);
ancestry probe routing matrix (ahead/equal/behind/diverged/unrelated/
probe-error → swap/keep/swap); nested most-specific-first ordering;
ignore-layer parity with normal scans; headroom refusal.

## Non-goals

- Any engine/classification/capture change (that was v1; abandoned).
- `keep-mine`/bulk resolve UX (this design removes the founder scenario's
  need; the verb gap remains backlog).
- Adopting INTO `init --new`, or merging two long-diverged workspaces.

## Rollout

Default-on next 1.7.x (founder priority #1), `RBOX_ADOPT_OVERLAY=0`
containment. Founder's desktop bind is the live validation AFTER the rig
gate is green — the stash retention makes even that first live run
fully reversible.
