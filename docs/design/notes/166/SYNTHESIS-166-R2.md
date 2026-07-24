# 166 r2 synthesis — orchestrator rulings for v3 (all findings accepted)

r2a: CHANGES-REQUIRED, 7 BLOCKERs + 5 HIGHs (safety/crash). r2b:
CHANGES-REQUIRED, 1 BLOCKER + 3 HIGHs (equivalence mechanics). Both confirm
the LAYER is right ("architectural pivot is directionally better"); the state
machine and routing authority are not. v3 directives, binding:

## D1 — git plane becomes FETCH-UNION, killing dir swaps entirely
No repo-directory swaps exist in v3 (dissolves r2a-2 partially, r2a-5
entirely, r2b-2 entirely — the baseline .git inode/identity is never
replaced). Per stash repo, against the baseline repo at the same path:
`git fetch <stash-repo> +refs/*:refs/adopt/incoming/*` (object-store UNION —
loses nothing by construction), then per branch: fast-forward the baseline
ref ONLY where its current tip is an ancestor (git update-ref CAS enforces);
NON-fast-forwardable refs stay parked under `refs/adopt/incoming/*` (not
refs/heads → never captured/synced) and are REPORTED to the user — nothing
divergent ever publishes automatically (dissolves r2a-1's authority BLOCKER:
the probe routes between ff-now and park-locally; both outcomes are
non-authoritative). B's index file and op-state are NOT transplanted; B's
working-tree files arrive via the file overlay (below) and classify as
ordinary working-tree state. B's stash/tags land in the union as
refs/adopt/* (reported, locally recoverable). Detached-HEAD stash repos:
tip parked under refs/adopt/incoming/HEAD.
r2a-8's behind case dissolves: union adds nothing new to publish; B's
extras persist locally under refs/adopt/*; no "keep" route discards planes.

## D2 — file plane is per-FILE overlay with an explicit collision policy
No directory renames. Walk stash files (no-follow lstat walk, containment
guards per src/engine/fsutil.ts:81-148 precedent, symlink-parent refusal,
special-file policy: fifo/device/socket entries are SKIPPED + reported):
- destination absent → rename in (pure move).
- destination present, same type → RETAIN baseline copy INTO
  `.rbox/adopt/displaced/<path>` (move, not delete), then move B's in.
  Stash slot empties as entries land; the DISPLACED tree + journal are the
  reversibility story (fixes r2a-3's retention contradiction: pre-join
  copies live at final paths OR displaced/, exact locations journaled).
- type collision (file↔dir↔symlink) → baseline stays; B's entry stays in
  stash under a journaled `unplaced/` set; reported. Never evict a
  directory (r2a-2's type-flip rule).
- A-only baseline paths: untouched by construction (walk is stash-driven).

## D3 — journal is an exact-identity crash protocol (reset-journal precedent)
Per-entry records carry exact identities (size/mtime/inode or content hash
for small entries) so recovery CLASSIFIES states, never guesses
(src/cli/reset-journal.ts:324-379 is the named precedent). Ordered
parent-directory fsyncs before each journal state advance
(fsyncDirectory, r2a-3); crash scope = power-loss included. Headroom model
restated honestly: peak = full B tree (stash) + full A baseline live.

## D4 — adopt state is a GLOBAL fence
Typed adopt record consulted UNDER THE WORKSPACE MUTEX by every sync owner
(daemon operation boundary, one-shot sync, push, pull — the four sites
r2a-4 cites); any incomplete adopt → refuse with guidance. Adoption
REFUSES degraded mutex (sync-mutex.ts:140-155). Kill switch stops NEW
adoptions only; recovery of an existing journal is unconditional.
Completion publishes: journal complete → caches invalidated (r2b-1: an
explicit mutation boundary — drop dircache/scan tokens for the workspace,
force full rescan on the finish sync) → fence lifted.

## D5 — scope and consent narrowed to reality (r2a-6/7/11)
Adoption applies ONLY to: `init --workspace` join, default firstSync=sync,
NOT already-bound roots (same-stream re-init REFUSES with guidance), NOT
pull-only, NOT keyed/agent setup (setup-keyed keeps its --force contract),
NOT --no-sync. Wizard passes a typed adoption-consent witness (the wizard's
no-interactive flag construction at setup-cmd.ts:58-70 is the cited trap);
headless requires an explicit `--adopt` flag — default-on applies to the
CONSENTED path, absence of consent = today's behavior (this satisfies
default-on: the feature is on wherever it can be, consent is the gate the
reviews proved necessary, founder can veto in review of v3 if he wants
flagless).

## D6 — finish step honesty (r2b-3)
The finish sync is an ORDINARY large-change sync: no atomicity claim;
sequences may be multiple; the fence lifts only after the journal is
complete and BEFORE the finish sync (the engine state is coherent then;
publication is incremental like any big local change day). State this and
test with 20+ repos.

## D7 — recovery surface (r2a-12)
`rbox adopt status|resume|abort` as a direct-path command that validates
the journal WITHOUT workspace-config discovery (crash-before-config case).
Abort semantics per phase (pre-phase-2 abort = restore stash moves by
journal; post-phase-2 abort = keep baseline, restore displaced, report).
`displaced/`+`unplaced/` retention: listed by `rbox adopt status`, cleared
by explicit `rbox adopt clean`; no auto-expiry in v1 of the feature.

## D8 — ignore independence (r2a-10)
The overlay walk is ignore-INDEPENDENT (restores every non-.rbox entry).
Rule files (.rboxignore/.gitignore) overlay like any file; the finish sync
rebuilds matchers from the final tree (pull's own rule-file-first
precedent, pull.ts:151-163).

## Test matrix additions (binding, from both reviews)
A-only-in-repo untracked file survives overlay AND next push (no deletion,
r2a-2); type-flip collisions both directions; same-stream re-init refusal;
pull-only/keyed/no-sync refusals; wizard consent + decline; crash at every
journal state (kill -9) with classifier-driven resume AND power-loss-shaped
partial-rename states; degraded-mutex refusal; daemon-start-mid-adopt
refusal (fence); hardlink topology; symlinked-parent escape attempt;
mode-000 dirs; mount-point source; refs/adopt parking for diverged branch +
report; detached HEAD; stash/tags union; scan-cache invalidation proven by
finish-sync detecting overlaid identical-mtime files (r2b-1's incidental-
timestamp attack); 20+ repo finish sync; B-behind union no-op + local
extras preserved.

Fold rule: v3 rewrites the mechanism sections around D1-D8; keeps problem
statement + layer rationale; cites r2a/r2b per fold site; status "v3 —
pending final serial review".
