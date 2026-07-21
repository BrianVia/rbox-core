# 174 — Apply-side performance: held-repo livelock, git-apply dark time, and pull/push tails

Status: DRAFT v0 (evidence + problem statement complete; mechanism/contracts in progress)
Author: Claude (session 2026-07-21), field evidence from the live fleet
Relates: 172 (event-driven capture), 175 (ref side-channel), 130 (follow/ownership model),
173 (reserved: two-writer spurious divergence — this doc's item B is the ONE-writer sibling)

## 0. Summary

What began as "APFS git-apply is ~32s" decomposed, under live-fleet forensics, into
one severe correctness bug wearing a performance costume, plus four bounded
performance items. The headline: a **one-writer livelock** in the git plane —
a repo whose local checkout moves ahead of its last-published section gets its
apply-side HELD and its push-side capture GAGGED simultaneously, forever. The
victim repo re-runs a full ~30s follow on every pull with no convergence and no
self-heal. Live occurrence: `Dfinitiv/savvy-core` on the founder's Mac since
2026-07-20 21:59Z (left wedged deliberately as a repro; file-plane sync healthy).

## 1. Field evidence (all from live fleet, 2026-07-20/21)

### 1.1 The loop

- Mac (`Development-f1903d6b`, APFS, 101 repos / 112k files): every pull ~42-44s,
  of which `git-apply ~30.5s`. Per-repo wall: p50 87ms, max ~30,200ms. The max is
  ALWAYS the same repo: `results=unchanged=100,applied=1`, `git-sync followed
  Dfinitiv/savvy-core` — **123 re-follows on 07-21 alone** (~62 min/day of churn).
- flat-meadow (EXT4, same workspace, pull-only): savvy-core `unchanged` at
  ~28ms/pull. Its own applied repo that day (small, e.g. Personal/blog) took
  ~880ms wall.
- Fleet git HEADs for savvy-core MATCH (ec399b9b on Mac and flat-meadow) — the
  "divergence" driving the loop is between the Mac's checkout and the STALE
  REMOTE SECTION, not between machines' working state.

### 1.2 Trigger timeline (Mac daemon log)

- `2026-07-20T21:58:22` push publishes **sequence 83**: `blobs=112291` — the
  v1.7.14 fingerprint-schema bump (4→5, design 175) forcing a full git-section
  republish of every repo.
- `2026-07-20T21:59:10` the very next pull: `git-sync followed Dfinitiv/savvy-core`
  followed 0.5s later by `git deferred 0m: local commits on branch main`.
- `2026-07-20T22:19:44` `git-sync deferred Dfinitiv/savvy-core: stash reflog
  contains receiver-only work; incoming checkout ref could not be published safely`.
- Every pull thereafter (every ~4-5 min, `ws backstop pull` cadence): re-follow,
  re-hold, 30s. Continuing at time of writing (>10h).
- The stash in question: `stash@{0}` created **by rbox itself** (`rbox <rbox@local>`,
  quarantine machinery, 2026-07-16) — "WIP on feat/studio-client-logger".
- savvy-core is the founder's employer monorepo: many developers, frequent
  commits to main, linked worktrees routinely created from main (12 at time of
  writing). I.e. the repo most likely to have its local tip advance between any
  two daemon operations — this failure shape is the STEADY STATE for an active
  writer, not an exotic corner.

### 1.3 The deadlock mechanism (code-confirmed)

Two sides each wait for the other:

- **Apply side** (`src/cli/sync-git/apply.ts` ~1180-1235): a follow that lands
  with non-empty `heldRefs` keeps `pending[rel] = remoteSec` and `setDeferral(...)`
  even on result "applied". There is **no idempotence short-circuit**: the next
  pull re-runs the entire follow (bundle fetch+decrypt, verify, import,
  classification, ref transaction) against the SAME incoming section and the
  same local state.
- **Hold classification** (`src/cli/sync-git/follow.ts:454-468` via
  `tipOwnedByIncoming`, `src/engine/git/reachability.ts:106-126`): a tip is
  "owned" iff reachable from the incoming section's roots. When the local
  checkout tip has commits BEYOND the incoming section's refs (local strictly
  ahead), the proof answers `unowned` → reason "local-commits" ("current tip has
  receiver-only commits"). The classifier cannot distinguish **local-ahead
  (supersedes incoming — normal writer progress)** from **genuinely diverged
  (receiver-only work at risk)**. Same for the stash lane (follow.ts:462-468):
  a stash oid not reachable from incoming roots → "local-stash" hold.
- **Push side** (`src/cli/sync-git/plan.ts:622-633`): a repo with a pending
  section is carried verbatim — "carry THE PENDING SECTION (the newest known
  truth), capture suppressed". The design assumption is that pending is NEWER
  than local. When local is AHEAD of pending, this gags the only writer that
  could refresh the remote section.

Livelock: apply holds (incoming lacks local tip) → pending persists → push
carries pending, capture suppressed → remote section never advances → apply
holds again. No other writer exists to break the tie (flat-meadow is pull-only;
in general the active dev machine IS the repo's only writer). The designed
escape hatches — manual resolution, or another writer refreshing the section —
do not exist on this topology.

Seeding: any window where the local tip advances after the section that the
next pull delivers was captured (here: the schema-bump republish at seq 83
followed by normal work on main; equally reachable by an ordinary
commit-during-push race). The rbox-created 2026-07-16 stash likely contributed
the initial "local-stash" hold via the same ownership proof.

### 1.4 Where the 30 seconds go (live subprocess sampling, ~0.5s period, one pull)

- Timed by existing `GitChainTimings`: fetchDecrypt ~140ms, bundleVerify ~86ms,
  gitImport ~130ms, indexOpState 0ms — **~350ms total**.
- `git -C …/savvy-core update-ref --stdin` (the FIFO-fed atomic ref transaction,
  `src/engine/git/checkout-txn.ts:135`): single pid observed etime 0→8s —
  **~8.5s**. Repo ref surface: **1,319 refs**, of which **810 are
  `refs/rbox-conflict/*`** (accumulated from conflict episodes 07-06..07-13,
  no retention/pruning exists), 328 tags, 69 heads; 302k objects, 44 packs,
  12 linked worktrees.
- Remaining **~20s: NO git subprocess visible** in any sample → in-process
  follow computation (ownership proofs over the ref set, reflog reads,
  journal/tombstone work, classification) — currently completely dark: no
  phase token, no per-step timing. `git fsck --connectivity-only` (apply.ts:712)
  was NOT observed; it is not the pole.
- Corroboration that this is not "APFS is slow" generically: the other 100
  repos on the same filesystem average 87ms.

### 1.5 The other measured tails (unchanged from earlier findings)

- **Notify-pull full scan**: every pull runs `scanManifest` — Mac ~7.5s,
  flat-meadow ~4.6s — even though post-172/175 the triggering signal is
  event-carried and pulls with `changed=0B` dominate. (pull.ts:131-142.)
- **Push tail** (Mac, 112k files): `missing` 4.4-7.8s (server blob-existence
  probe, sync-recovery.ts:317), `commit` 4.5s (manifest commit, push.ts:646),
  `git-plan` 2.7-7.1s on no-change pushes.

## 2. Scope (impact order)

- **A. Held-repo idempotence short-circuit** — a held/pending repo whose
  incoming section key AND relevant local git state are unchanged since the
  last follow attempt skips the re-follow entirely. Turns every steady-state
  deferral from O(full follow) to O(fingerprint compare). This protects ALL
  deferral reasons, not just this livelock. Expected effect on the live Mac:
  pull 43s → ~13s immediately, even before B lands.
- **B. Break the one-writer livelock (supersession)** — distinguish
  "local strictly ahead of incoming" from "diverged". When every root of the
  pending section is owned by (reachable from) local tips, the pending section
  is PROVABLY superseded: clear the hold, release capture, let the next push
  publish fresh truth. Must engage the design-130 ownership model on its own
  terms; the two-writer sibling (173) stays reserved but the proof machinery
  should be built to serve both.
- **C. Light up the dark 20s** — sub-timers for the follow pipeline:
  refTxnMs (checkout-txn), ownershipProofMs, reflogMs, fsckMs, classification;
  extend `GitChainTimings` (shared.ts:17-27) + the `git-apply` log token so a
  regression here is never invisible again. Cheap, ships with A.
- **D. rbox-conflict ref retention** — 810 conflict refs inflate every ref
  transaction, fingerprint, and capture forever. Define a retention/pruning
  policy (age? superseded-by-resolution? cap?) — founder input wanted on
  retention semantics before mechanism.
- **E. Notify-pull scan-skip** — when the pull was event-triggered and the
  file plane reports no candidate changes, skip/downgrade the full scanManifest.
- **F. Push-tail** — `missing` probe and `commit` cost on no-change pushes;
  measurement-first (one more instrumentation level), likely its own follow-up.

Non-goals (v0, to be ratified): reworking design-130's ownership semantics
beyond the supersession distinction; two-writer divergence (173); any change to
conflict-ref CREATION; APFS-specific filesystem tuning (the generic-APFS theory
is dead — savvy-core's cost is ref-surface × follow-work, not the filesystem).

## 3. Open questions (for review rounds)

1. Exact idempotence key for A: incoming section key + local HEAD/refs
   fingerprint + index/opState projection? Must be strictly cheaper than the
   work it skips and NEVER skip a follow that could make progress (e.g. local
   state changed in a way that unblocks the hold).
2. B's supersession proof: is "every pending root owned by local tips"
   sufficient on all lanes (branches, tags, stash, opState commit candidates)?
   What about pending sections carrying config/index artifacts newer than local?
3. Does B subsume the 22:19 stash-lane hold, or does the rbox-created-stash
   case ("receiver-only" stash oid that rbox itself minted locally) need its
   own ownership annotation?
4. D retention semantics — founder call.
5. Where does the safety floor sit for A if the fingerprint lies (defense in
   depth: periodic full follow anyway? every Nth pull?).

## 4. Mechanism (TODO — next draft)

To be written after a full read of the design-130 follow/base-composer model:
exact state machine for pending supersession, the idempotence fingerprint
contract, telemetry token schema, and the MUST-test list.
