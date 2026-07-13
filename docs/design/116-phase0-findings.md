# 116 Phase 0 — incident mechanism: confirmed

Status: **PHASE-0 COMPLETE** (2026-07-13). Field evidence captured, mechanism
bisected to a single live gate, and reproduced end-to-end on a scratch
two-host rig against current HEAD. This document is the evidence record the
design's Phase-0 section requires; design 116 must be amended per §"Design
disposition" below before implementation dispatch.

## Verdict

The chronic Mac deferral was **not** the drafted file/Git dirty-byte deadlock.
The review's adjudication was right: `localDivergedFromBase()` never fired on
working bytes, and none of the review's three named live-code candidates
(needsResolution identity freeze, busy-carry, pending suppression) is the
blocker. The confirmed mechanism is:

**Design 68 §3.2's whole-section worktree-collision defer** —
`worktreeCollision()` in `src/engine/git/apply.ts` (defined at ~line 67,
enforced inside `applyGitState()` at ~line 175):

```ts
// ref updates — every branch the section would publish
for (const ref of Object.keys(section.refs)) if (owned.has(ref)) return collision(ref);
...
if (ctx && (await exists(path.join(ctx.commonDir, "worktrees")))) {
  const reason = await worktreeCollision(ctx, section, deleteAbsent, ...);
  if (reason) return { applied: false, reason };   // defers the WHOLE section
}
```

If **any** branch named in the incoming section is checked out in **any**
non-prunable linked worktree of the receiver's clone, the **entire** git
section defers — HEAD, current branch, every other ref, index, op-state.
The check never compares OIDs, so an incoming ref whose OID **equals** the
receiver's current value (a pure no-op that could not possibly move the
sibling's checkout) still freezes everything. Because this repo's own dev flow
parks long-lived branches in `.claude/worktrees/<slug>`, and all-scope sections
carry every branch, the collision is quasi-permanent: nothing on either side
ever changes the colliding pair, so every retry hits the same refusal. The
file plane keeps syncing; git metadata freezes indefinitely. Design 116's
invariant 4 ("one protected ref does not freeze unrelated refs") names exactly
this failure class.

## Field evidence (Mac, `~/.rbox/daemons/Development-f1903d6b/`)

Immutable snapshot taken 2026-07-13 ~17:29Z (before any other action) to
`/tmp/116-phase0-evidence/` on the Mac and copied off-host; the daemon.log
retains 2026-07-07T15:47Z onward, covering the whole deferral window.

- **1,173 occurrences** of
  `git-sync deferred Personal/rbox-core: branch d93-git-config-sync checked out in linked worktree d93`
  from **2026-07-10T14:34:56Z** continuously through the snapshot moment
  (last at 2026-07-13T17:29:01Z) — i.e. the deferral was **still live after
  the manual remediation**, and remains live until the `d93` worktree is
  removed or the gate is fixed.
- One earlier same-gate hit with a different worktree:
  `branch rel-0913 checked out in linked worktree rig-p0` (2026-07-10T00:56:15Z)
  — the gate recurs whenever any synced branch sits checked out in any
  linked worktree.
- **The colliding update is a no-op**: the persisted `gitPendingRemote`
  section for `Personal/rbox-core` (workspace `state.json`) carries
  `refs/heads/d93-git-config-sync = e8366022…`, and the Mac's local branch
  (checked out in `.claude/worktrees/d93`) is at the **same** `e8366022…`.
- **Zero** `receiver git busy` lines for this repo in the retained window
  (busy-carry/stale-lockfile candidate: not the mechanism).
- **Two transient conflict checkpoints** (2026-07-11T02:40:43Z and
  03:24:50Z, plus 07-10T00:57 / 07-12T15:48): the needsResolution identity
  freeze engaged and cleared as local identity changed. Not chronic, not the
  blocker.
- **381 captures** of `Personal/rbox-core` in the window: the Mac's own
  push-side capture kept advancing the repo base to match local state, so
  `localDivergedFromBase()` stayed false and every pull routed into the CLEAN
  apply path (`src/cli/sync-git/apply.ts` → `applyGitState`) — where the
  collision gate then deferred. Pending carry (`[v5]`) worked as designed:
  `gitPendingRemote` holds the newest incoming section (head
  `ref: refs/heads/main` @ `2bea3dab…`, which the Mac's local `main` still
  lacks).
- Timeline (Mac repo reflog, `rbox-core-reflog.txt` in the snapshot): local
  git activity on `main` through 07-10; a local `git checkout` moved the
  primary checkout to `Codex/perf-improvement-search` (@ `df44d366`,
  v0.9.18-era tip) on 2026-07-10 22:35 EDT; manual remediation
  (`checkout -f main` + `reset --hard origin/main`) on 2026-07-13 12:06 EDT.
  In between, the gate blocked every incoming section, so neither HEAD nor
  the stale local `main` ref could follow the stream — the field incident.
  (The retained log cannot confirm anything before 07-07; the confirmed
  continuous freeze is 07-10 → present.)

Evidence retained at `/tmp/116-phase0-evidence(.tar.gz)` on the Mac and in the
investigating host's session scratchpad. Log lines quoted here contain local
branch/worktree names only — per the design's privacy boundary they must not
enter uploaded diagnostics.

## Reproduction (scratch rig, current HEAD, 2026-07-13)

Two scratch workspace dirs on one throwaway prod workspace, driven by one-shot
`bun src/cli/index.ts push|pull` from this worktree (Linux host; the
containerized rig is macOS-only). Junk workspace ids created (record for
purge): `ws_50e1b93a0e3e4a4a8a3ca6ce80b20b59`,
`ws_b24e5046b4bf4db0957d6000c4475395`, `ws_d632dd086dbd4aa5af4337aac6ea63d1`
(final run).

1. Sender: repo with `main` and side branch `d93-side` at the same tip; push.
2. Receiver: join, pull (git section applies; repo materializes).
3. Receiver: `git worktree add ../receiver-wt-d93 d93-side` — the incident
   shape; the worktree branch OID equals the incoming section's OID.
4. Sender: edit tracked file, commit on `main`, push. Receiver pulls.

Observed, three consecutive rounds:

```text
git-sync deferred repo: branch d93-side checked out in linked worktree receiver-wt-d93
receiver a.txt: one two more-2 more-3      # file plane keeps following
receiver main:  c970eb1   sender main: e48ef55   # git plane frozen
receiver d93-side == sender d93-side == c970eb1  # the collision is a no-op update
```

Control: `git worktree remove` → next pull logs `git-sync applied repo` and
receiver `main`/HEAD follow to `e48ef55`. The collision gate is the **sole**
blocker; the deferral is permanent for as long as the worktree exists.

## Design disposition — does 116 as drafted address it?

**Architecturally yes, narratively no. Amendments required:**

1. **Root-cause section**: replace the file/Git dirty-byte deadlock narrative
   with this confirmed mechanism. The applied-manifest oracle remains the
   correct *safety proof* for checkout follow (sync-dirt vs human-dirt), but
   it must not be credited as the incident fix — the incident never involved
   working-byte classification.
2. **Explicitly supersede design 68 §3.2's whole-section defer.** The
   checkout/ref/config plane split and `heldRefs` (reason
   `worktree-ownership`) must be specified as *replacing* the ANY-intersection
   → defer-all rule for dir targets: a branch checked out in a sibling
   worktree is held (per-ref), while checkout, HEAD, index, op-state, and all
   unrelated refs advance. Design 68's underlying hazard (`update-ref`
   silently moving a sibling's checked-out branch) stays fully guarded — per
   ref, not per section.
3. **No-op equality rule** (minimal incident fix, worth shipping first): an
   incoming ref update whose OID equals the receiver's current value is not a
   collision — nothing moves, nothing is held. This alone unfreezes the field
   incident and the repro.
4. **Regression tests must pin this shape**: dir repo + linked worktree with
   a section-named branch checked out at (a) identical OID → follow with no
   hold, and (b) diverged OID → hold that ref (`worktree-ownership`), checkout
   and unrelated refs still follow. The planned `git-entanglement` churn
   round should add the linked-worktree case; the current draft's
   tracked-file round alone would not have caught this.
5. **Visibility requirement is validated by the field data**: 1,173 identical
   per-pull log lines with no durable age. The design's `GitDeferrals` +
   chronic `deferredSince` would have surfaced `git deferred 3d:
   worktree-ownership …` in `rbox status` from 07-10 onward.
6. **Operational note (until the fix ships)**: any fleet host holding a
   long-lived `.claude/worktrees/*` checkout of a synced branch freezes that
   repo's entire git plane on that host. The Mac's `d93` worktree still
   exists and rbox-core git sync there is still frozen; removing (or
   detaching) the worktree unblocks it immediately.

The review's other Phase-0 candidates are cleared by evidence: needsResolution
freezes were transient (identity changes cleared them), busy-carry never fired
for this repo, and pending carry behaved per `[v5]` (newest incoming section
carried, no echo/resurrection observed).
