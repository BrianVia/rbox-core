# 55 — Reconcile base continuity + the blast-radius guard

Status: DESIGN ONLY (not started). Origin: a 2026-07-02 near-miss while
dogfooding the login flow on a machine holding a large, real, already-populated
workspace. Extends design **44** (rebind safety: state ownership + mass-delete
guard) and design **50** (destructive-apply safety: trash tier + push guard) to
cover the one blast-radius direction those two leave open: not *deletes*, but
*conflict-driven overwrites* that arise when the reconcile base is empty.

## 1. The incident

A workspace containing several independent git repos/worktrees as
subdirectories — hundreds of files across each, plus a scatter of uncommitted
in-progress work — was tracked and syncing normally. To simulate a clean
machine for a login-flow test, the workspace was `rbox untrack`'d and then, a
little later, `rbox track`'d back to the **same** remote workspace on the
**same** device.

`untrack` removes the entire `<root>/.rbox/` binding (see §2), so the
last-synced baseline (`state.json`) was gone. The re-`track` produced a fresh
binding whose reconcile base was empty. On the next sync, `reconcile()` had no
common ancestor to reason from: for **every path whose local bytes differed
from the remote's**, both sides "diverged from base" (an empty base differs from
everything), and the algorithm's only move in that situation is `conflict` —
write the remote version to disk, park the pre-existing local version in a
`.conflict` sibling. Byte-identical files passed through cleanly (they're a
no-op, §3), so the damage tracked exactly the amount of genuine local divergence
present — which, on a machine full of in-progress work, was substantial.

Concretely this produced: dozens of `.conflict` sidecar files; dozens of
unrelated in-progress files silently overwritten with older/other-machine
content; and at least one **git-tracked** file whose *working-tree* content was
silently reverted to a stale revision.

Recovery was total but only because git was underneath it. rbox never touches
`.git/objects` (design 44 §6, 50 §1), so the affected repo's history and an
already-pushed PR were intact; recovery was a `git status` to see the reverts
followed by `git checkout`/`reset`. **In an all-uncommitted-work scenario, with
no git net, the silently-overwritten in-progress files would have been much
harder — or impossible — to get back.** The remote is the E2EE `versions`/
`restore` deferral (design 50 §5), so server-side history is not yet a practical
recovery path for a user in the moment.

The failure mode is symmetric to design 44's poisoned base, but the poison is
*absence*, not *mismatch*: an **empty base makes every genuine local edit look
like an independent divergence**, and reconcile resolves genuine-lineage
divergence and independent-edit divergence identically — because once the base
is gone, it can no longer tell them apart.

## 2. Root cause (walking the code)

**a. The reconcile three-way is content-hash based and base-dependent.**
`reconcile()` (`src/engine/reconcile.ts:41`) compares `local`/`remote` against
`base` with `sameContent()` (`src/engine/diff.ts:20`), which matches on
`sha256` + `type` + `symlinkTarget` + `mode` — **no mtime anywhere in the
comparison** (`diff.ts:26–28`, and the `FileEntry` doc-comment calls mtime
"intentionally absent"). This is correct and is a design principle worth
**preserving, not changing** (see §4). The per-path decision:

- `sameContent(l, r)` → skip (already equal) — `reconcile.ts:58`.
- `sameContent(l, b)` → local untouched since base; take remote — `:60`.
- `sameContent(r, b)` → remote untouched since base; local is ahead — `:66`.
- otherwise both diverged from base; **if `r && l` → `conflict`** — `:69–70`.

When `base` is empty for a path, `b` is `undefined`, so `sameContent(l, b)` and
`sameContent(r, b)` are both false (`diff.ts:21`, one-sided absence is not
equal). Any path present on **both** local and remote with differing content
therefore falls unconditionally into the `conflict` branch: remote written to
disk, local moved to `conflictName(p, device, now)` (`reconcile.ts:79–85`).
**There is no signal available in that branch** to distinguish "same lineage
that kept evolving locally" from "an independent, unrelated edit" — the base
that carried that information is gone. Any automatic tie-breaker here (mtime
included, §4) is a guess, not a resolution.

**b. `untrack` destroys the base.** `untrack` (`src/cli/untrack-cmd.ts:37`)
removes the **entire** `<root>/.rbox/` tree via a guarded recursive `rm`
(`removeRboxDir`, `:80–100`) — workspace.json, `state.json`, everything — and
also `removeDaemonRuntime(root)` (`:71`). The comment at `:16–18` is explicit
that it removes the whole nested `.rbox/` layout rather than enumerating files.
So the last-synced baseline is gone the moment you untrack.

**c. A fresh `track` produces an empty base with no recovery attempt.**
`track` (`src/cli/track-cmd.ts:27`) is bind-only: it writes `workspace.json` and
stops. For a re-track of the *same* stream it deliberately does **not** call
`resetSyncState` (`:84–91` only resets on a stream *change*) and preserves the
existing device id — but there's no `state.json` left to preserve, so the next
`loadState(root, stream)` (`src/cli/config.ts:171`) hits the ENOENT path and
returns `fresh` = `{ stream, lastSyncedSequence: 0, lastSyncedManifest:
EMPTY_MANIFEST }` (`:172,177`). **There is currently no attempt anywhere to
recover a prior base for the same `remoteWorkspaceId`, even one that exists
elsewhere on this device or account.** `loadState`'s corrupt-file guard
(`:183–189`) and stream-stamp guard (`:191–197`) are both about *rejecting* a
wrong base; neither *restores* a right one.

**d. The existing blast-radius precedent is delete-only.** The mass-delete
guard (`src/cli/sync.ts:34` `MASS_DELETE_MIN_FILES = 100`; enforcement at
`:150–160`) fails a pull closed — before any action touches disk — when it
would `delete ≥ 100 files AND ≥ half the baseline`, requiring
`--allow-mass-delete` (`SyncDeps.allowMassDelete`, `:73–76`) to proceed once.
The daemon never sets that flag, so background sync **halts loudly** rather than
destroying the tree (design 44 §3). This is exactly the shape fix 2 wants — a
large-blast-radius guard that fails closed and demands explicit consent — but it
only watches the *delete* direction. **A pull that overwrites N local files via
conflict-resolution passes it untouched**, because conflicts aren't deletes.
That is the gap this incident fell through.

**Relationship to 44/50.** Design 44 fixed the *mismatched* base (stream stamp)
and added the delete guard. Design 50 added the trash tier and the *push*-side
delete guard, and explicitly left the guard's thresholds "exactly as is". This
doc adds the missing case: an *absent/untrustworthy* base, and a guard for the
*overwrite* direction. It **extends** both; it changes neither `sameContent()`
nor the existing delete guard.

## 3. A clarifying detail worth stating

The incident is often described as "every shared file conflicted." Precisely:
only paths whose local and remote **content differs** conflict; byte-identical
files short-circuit at `reconcile.ts:58` and are no-ops even with an empty base.
This matters for both fixes:

- It's why the blast radius equals the amount of genuine local divergence, which
  is what makes it dangerous specifically on a working machine (lots of
  in-flight edits) and invisible on a pristine one (nothing differs → nothing
  conflicts → the bug hides during testing).
- It's why fix 1's restored base is *safe even when slightly stale*: files that
  still match the stashed base reconcile as "unchanged since base" and never
  conflict; only genuinely-diverged files are in play, which is exactly the set
  fix 2 then guards.

## 4. Alternatives considered — mtime as a tie-breaker (rejected)

The tempting "fix" is to break the empty-base conflict by keeping whichever side
has the newer mtime. **Rejected**, for two concrete reasons:

1. **Clock skew across independent machines is unbounded and unverifiable.**
   Using mtime as a winner picks a *total order* out of each machine's
   self-reported wall clock — precisely the problem Lamport/vector clocks exist
   to avoid. rbox already refuses to trust wall time this way; sequence numbers
   are the ordering authority.

2. **mtime is stamped by tools that have nothing to do with meaningful edits.**
   `git checkout`/`reset`/`rebase`, stash-pop, atomic-write-via-rename on every
   save, archive extraction — all restamp mtime to "now" on content that did not
   meaningfully change. This is **literally what happened during recovery from
   this incident**: the `git reset` that restored the affected repo stamped
   "now" on every file, even though the restored bytes are the *older*, correct,
   already-pushed version. A latest-mtime tie-breaker would have read that
   recovery reset as the most authoritative edit in the workspace and propagated
   the wrong direction.

rbox's content-hash `sameContent()` is architecturally correct. The fix is to
**restore the missing base** (fix 1) and to **fail closed when the base can't be
trusted** (fix 2) — not to invent an ordering signal that doesn't exist.

## 5. Decision

Two complementary fixes. They are designed to **compose**: fix 1 removes the
common cause of an empty base, and fix 2 is the net for every remaining case
where the base is empty, too stale to trust, or lost — including the case where
fix 1's stashed base turns out not to match reality.

### 5.1 Fix 1 — preserve base continuity across untrack → re-track (same workspace, same device)

Instead of `untrack` destroying the baseline unrecoverably, **stash the
last-known base manifest** so a later re-track of the same remote workspace on
the same device can resume from real lineage rather than `EMPTY_MANIFEST`.

- **What is stashed.** The `SyncState` at untrack time — at minimum
  `lastSyncedSequence` + `lastSyncedManifest`, carrying its `stream` stamp so
  design 44's ownership guard still validates it on restore. (The git-sync
  sidecar maps in `SyncState` — `gitReposRemoved`, `gitNeedsResolution`,
  `gitPendingRemote`, `config.ts:91–101` — should ride along too; they are
  per-binding memory and are equally lost by untrack today.)

- **Where it lives.** *Outside* the workspace's `.rbox/`, which untrack deletes.
  The natural home is the existing global state root `~/.rbox/`
  (`daemon-control.ts:16`, `RBOX_HOME`-overridable), which already holds
  per-workspace runtime under `~/.rbox/daemons/<workspaceKey(root)>/`
  (`:33`, key = `<basename>-<sha8(absRoot)>`, `:22–27`). A sibling such as
  `~/.rbox/bases/<key>/<remoteWorkspaceId>.json` keeps the stash keyed by both
  device-local root *and* remote workspace id, so a re-track only restores a
  base that belongs to the same `(root, workspaceId)` pairing.

  - **Open question / cross-reference to design 54.** The pending workspace
    registry (design 54, PR #57 — `~/.rbox/workspaces.json`) is the natural
    index to hang this off, and if it lands, the stash should key off the
    registry's canonical `(device, workspaceId)` identity rather than a second
    ad-hoc scheme. **This doc does NOT hard-depend on 54.** The storage location
    is chosen independently (a `bases/` dir under `~/.rbox` needs nothing from
    54); the adjacency is noted so the two don't grow divergent keying.

- **How restore works.** On `track` targeting an existing `remoteWorkspaceId`
  (or on the first `loadState` after such a track), if no `<root>/.rbox/
  state.json` exists but a stash for `(root, workspaceId)` does, **restore it as
  the base** instead of returning `fresh`. `reconcile()` then sees real lineage:
  files unchanged since the stash reconcile as "unchanged," not conflicts; only
  files that genuinely changed while untracked are in play — and those flow into
  fix 2's guard rather than silently conflicting.

- **Retention.** Proposed: retain until explicitly cleared, with a generous TTL
  as a floor (e.g. 90 days) so a stash can't resurrect an ancient, wildly-stale
  base months later. A stash is small (one manifest) and the safety upside is
  large, so bias toward *keeping* it. `untrack --purge` (or a future
  `rbox base clear`) forgets it deliberately. A genuine rebind to a *different*
  workspace never restores it (keyed by workspace id; also caught by design 44's
  stream stamp).

- **Composition guarantee (the important part).** A restored stash is **not
  trusted as ground truth** — it is fed to `reconcile()`, which re-derives local
  truth from disk (`scanManifest`) every time. If the user deleted or replaced
  files while untracked, those paths simply no longer match the stashed base and
  reconcile treats them as divergence — which fix 2 then guards. The stash can
  therefore only ever *reduce* the conflict count from the empty-base worst case;
  it can never manufacture a wrong apply that fix 2 wouldn't also catch. Fix 1
  and fix 2 must be reasoned about **together**: fix 1 makes the common case
  correct, fix 2 makes every residual case safe.

### 5.2 Fix 2 — a blast-radius guard on conflict-heavy syncs (untrustworthy/empty base)

Symmetric to the existing mass-delete guard, but for the overwrite direction:
when a single reconcile produces a large wave of `conflict` actions — the
signature of a missing or untrustworthy common ancestor — **fail the pull closed
before any action touches disk** and require explicit consent.

- **When it applies.** Any first-materialization-shaped reconcile: a first-ever
  track of a directory with real pre-existing content that happens to match an
  existing remote workspace; a fix-1 stash judged too stale/mismatched to trust;
  corrupted or lost local state. The common tell is *many conflicts at once*,
  which healthy incremental sync essentially never produces (real concurrent
  edits to the same file are rare and few).

- **Threshold.** Mirror the delete guard's shape as the starting point
  (`sync.ts:34,150–160`): trip when planned `conflict` actions
  `≥ CONFLICT_GUARD_MIN_FILES (100)` **AND** `≥ half the larger of {baseline,
  local scan}` file count. The two-condition AND keeps small workspaces from
  tripping on routine divergence (same rationale as design 44 §3). Because the
  dangerous case is precisely an *empty* baseline (denominator 0), the guard
  must measure the ratio against the **local scan** count too, not the baseline
  alone — otherwise an empty base makes "half the baseline" trivially true or
  trivially false depending on how you read a zero. Ratio against local scanned
  files is the meaningful blast radius: "this pull is about to shove remote
  content over N% of what's on your disk."

- **What it does when it trips.** Throw before applying (whole pull fails closed,
  nothing partial — identical discipline to the delete guard), so the **daemon
  halts loudly** on the existing error/⚠ surface (design 44 §3, 45/46) and never
  self-consents. A human proceeds once with an explicit flag.

- **The flag.** `--allow-mass-reconcile` (parallel to `--allow-mass-delete`;
  wired the same way through `SyncDeps` as an op-scoped consent field, kept
  **separate** from the delete consent flags for the same reason design 50 §7 B2
  kept push/pull consent separate — a pull-recovery inside push must not inherit
  overwrite consent). Name chosen to read as what it authorizes: "yes, apply
  this large reconcile/conflict wave." An alternative considered —
  `--allow-mass-conflict` — was set aside because it describes the *symptom*
  (conflicts) rather than the *action being consented to* (applying a bulk
  reconcile).

- **What the user sees.** A clear count and a review path, not a bare go/no-go:
  `"sync would create N conflict copies over M of your L local files —
  refusing (blast-radius guard). Review with rbox status / rbox sync --dry-run,
  then rbox sync --allow-mass-reconcile to apply once."` The point is that the
  user reviews *before* committing, exactly the affordance this incident lacked.

## 6. What is deliberately NOT changed

- `sameContent()` stays content-hash based; no mtime, ever (§4).
- The mass-delete guard (44/50) is untouched — this is an *additional* guard for
  a different direction, not a rework.
- No interactive confirm inside `pull`/`reconcile` itself; consent stays an
  explicit flag set by the caller (design 44 §6 rule — the CLI is also driven
  headless, and the daemon must never self-consent).
- No change to the conflict-copy mechanism itself (`conflictName`) — it remains
  the correct behavior for *genuine* concurrent edits with a real base. The fix
  is to stop *manufacturing* conflicts from an absent base, and to guard the
  bulk case, not to change what a real conflict does.

## 7. Open questions

1. **Stash retention policy.** Forever-until-cleared vs. a TTL floor (§5.1). Bias
   is toward keeping (small cost, large safety upside), but a hard cap avoids
   resurrecting a base months stale.
2. **Keying under design 54.** If the workspace registry lands, migrate the
   stash key onto its canonical `(device, workspaceId)` identity rather than the
   `workspaceKey(root)`-derived path (§5.1). Until then, key independently.
3. **Guard denominator for an empty base.** §5.2 proposes ratio-against-local-
   scan; confirm this doesn't over-trigger on a legitimate first-ever populate of
   a large *empty* remote (there, conflicts are ~0 because remote has nothing to
   conflict with — the guard should be quiet, and by construction it is, since
   conflicts require content on *both* sides).
4. **Does fix 1 alone make fix 2 rare enough to defer?** No — fix 2 covers
   first-ever-track and lost/corrupt state, which fix 1 can't. Both ship; fix 2
   is the load-bearing safety net, fix 1 is the ergonomic fix that keeps the net
   from tripping in the common untrack→re-track case.
5. **Interaction with the trash tier (design 50).** Should the pre-existing
   local versions that a *consented* mass-reconcile displaces go to `.rbox/trash`
   in addition to (or instead of) `.conflict` siblings, so a bulk overwrite is as
   recoverable as a bulk delete already is? Likely yes; specify in implementation.

## 8. Test plan sketch

- **Reconcile unit:** empty base + differing local/remote at a path → conflict
  (documents current behavior); byte-identical local/remote + empty base →
  no-op (documents the §3 short-circuit).
- **Fix 1:** track → sync → untrack → re-track same workspace/device →
  `loadState` restores the stash → reconcile produces zero conflicts for
  unchanged files; a file edited-while-untracked reconciles as divergence (and,
  below threshold, a normal conflict; above threshold, trips fix 2).
- **Fix 1 staleness composition:** stash present but disk wholly replaced →
  restore does not silently misapply; the diverged set flows to fix 2's guard.
- **Fix 2:** first-ever track over a populated dir matching a populated remote →
  guard trips, pull fails closed, nothing on disk touched, daemon halts;
  `--allow-mass-reconcile` applies once; small workspace stays under the AND
  threshold and does not trip.
- **Consent isolation:** `--allow-mass-reconcile` does not imply
  `--allow-mass-delete` (and vice-versa) through any shared `SyncDeps` path,
  including push's 409-recovery pull.
