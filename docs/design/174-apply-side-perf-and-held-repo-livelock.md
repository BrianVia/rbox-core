# 174 — Apply-side performance: held-repo livelock, git-apply dark time, and pull/push tails

Status: DRAFT v1 — ready for adversarial review round 1
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
  transaction, fingerprint, and capture forever. Policy (founder-ratified
  2026-07-21): **prune-on-supersession** — a conflict ref whose commit is
  reachable from a current branch is deleted (the work made it back in);
  everything else falls under a generous **age floor (90 days)**; the live
  snapshot count is surfaced in `rbox status` so retention is never silent.
  No prune ever runs on refs younger than the floor unless superseded.
- **E. Notify-pull scan-skip** — when the pull was event-triggered and the
  file plane reports no candidate changes, skip/downgrade the full scanManifest.
- **F. Push-tail** — `missing` probe and `commit` cost on no-change pushes;
  measurement-first (one more instrumentation level), likely its own follow-up.

Non-goals (v0, to be ratified): reworking design-130's ownership semantics
beyond the supersession distinction; two-writer divergence (173); any change to
conflict-ref CREATION; APFS-specific filesystem tuning (the generic-APFS theory
is dead — savvy-core's cost is ref-surface × follow-work, not the filesystem).

## 3. Open questions — resolutions pinned in §4 (review anchors)

1. A's idempotence key → §4.1: `gitIncomingKey` + reused `gitFingerprint`,
   with the git-state-only reason allowlist doing the "could this follow make
   progress" gating. Reviewers: attack the allowlist's coverage claim.
2. B's supersession proof → §4.2: per-lane, same-name fast-forward
   subsumption only; index/config differences BLOCK supersession (v1
   conservative). Reviewers: hunt lanes where "refs subsumed" still loses
   information.
3. The rbox-created-stash hold → subsumed by B iff the stash oid is locally
   reachable (§4.2 stash lane); no special-case annotation. Reviewers: check
   the 07-16 quarantine-stash shape against that rule.
4. ~~D retention semantics~~ RESOLVED (founder, 2026-07-21): supersession +
   90-day age floor + status surfacing (see §2 D).
5. A's fingerprint-lie defense → §4.1 safety floor: 1h forced re-follow +
   loud divergence WARNING (canary, not silent self-heal).

## 4. Mechanism

Design-130 constraints this section obeys (non-negotiable): a PENDING section
carries byte-for-byte and is exempt from normalization while it exists
(changing it would orphan `gitIncomingKey`-bound partial progress and deferral
episodes); persisted `RepoRecord.base` moves ONLY through
`composeRepoBase(...)`'s closed authority union; branch mutations route
through the typed transition planner. Nothing below touches BASE composition
or adds an authority arm: **A skips work; B clears sidecar state and lets the
EXISTING capture→commit→fold path re-establish truth.**

### 4.1 A — Held-repo idempotence short-circuit (apply side)

New per-repo sidecar (in `RepoRecord`, alongside the existing partial/pending
bookkeeping; never wire-visible):

```ts
attempt?: {
  incomingKey: string;          // gitIncomingKey of the section this attempt saw
  localFingerprint: string;     // gitFingerprint of local git state at attempt time
  reasons: GitDeferralReason[]; // hold reasons produced by that attempt
  at: string;                   // ISO timestamp of the attempt
}
```

- `localFingerprint` REUSES the existing capture-side `gitFingerprint`
  machinery (`src/cli/sync-git/fingerprint.ts`, incl. its racy-clean margin
  and `GIT_FINGERPRINT_VERSION` coupling) — no new fingerprint scheme. The
  divergence cache already proves this primitive sound for skip decisions on
  the push side.
- **Skip rule.** On apply, for a repo with `pending[rel]` present, the full
  follow is SKIPPED iff ALL of:
  1. incoming section's `gitIncomingKey` equals `attempt.incomingKey`;
  2. current `gitFingerprint` (trusted, non-racy) equals
     `attempt.localFingerprint`;
  3. every recorded reason is in the **git-state-only** set
     `{"local-commits", "local-stash"}` — reasons whose classification inputs
     (ownership proofs over refs/reflogs) are fully covered by the git
     fingerprint. Any other reason (`local-edits`, `local-index`,
     `local-operation`, `unreadable`, …) depends on inputs the fingerprint
     does not cover → always re-follow.
  4. the safety floor has not elapsed (below).
- A skip preserves everything: deferral episode, pending, partial, BASE,
  status banner. It emits no `git-sync followed` line; it bumps a counter
  surfaced in the pull summary (`git-apply … skippedHeld=N`).
- **Invalidation** is automatic: any local commit, ref move, stash change,
  or incoming-section change alters one of the two keys → full follow. A
  successful follow or any terminal transition clears `attempt`.
- **Safety floor:** a skipped repo is force-re-followed when
  `now - attempt.at > 1h` (constant, not configurable). If the forced
  re-follow produces a DIFFERENT outcome with both keys unchanged, that is a
  fingerprint-coverage bug: log loudly
  (`git-sync WARNING <rel>: held-skip fingerprint miss`) — this is the
  canary, not a silent self-heal.
- The attempt record is lineage-scoped like all 130 sidecar state: a state
  nonce change, repo identity change, or `GIT_FINGERPRINT_VERSION` bump
  discards it (fail open to full follow).

Effect: steady-state deferral cost drops from O(full follow) (~30s on
savvy-core) to one fingerprint computation (~ms), for EVERY deferral reason
in the git-state-only set, independent of B.

### 4.2 B — Pending supersession (push side: probe before carry)

Definition. A pending section `P` for repo `rel` is **superseded by local**
iff every piece of information it carries is already reflected in the local
repository, per-lane:

- for every `R ∈ P.refs` with `R.startsWith("refs/heads/")`: the LOCAL live
  ref `R` exists and `P.refs[R]` is equal to or an ancestor of local `R`
  (`git merge-base --is-ancestor`, the same primitive as
  `tipOwnedByIncoming` — errors/shallow/missing-object → NOT superseded);
- for every tag in `P.refs`: local tag exists at the SAME oid (tags don't
  fast-forward; any mismatch → not superseded);
- `refs/stash` in `P`: the stash oid is reachable from local stash reflog
  oids or local branch tips (its content is present locally);
- every opState commit candidate in `P`: owned by local tips;
- `P.head`, index artifact, config: compared for information content —
  v1 rule: symbolic `P.head` names a branch that exists locally; a pending
  index artifact or config DIFFERENT from local's current projection blocks
  supersession (conservative: only refs-plane staleness is provable cheaply).

Same-name fast-forward subsumption is deliberately per-ref: a pending branch
`X` that the local repo lacks (or holds non-fast-forward) keeps the pending
section and the hold — that is exactly the "receiver-only work at risk" case
the hold exists for. No ancestry-through-another-ref laundering.

Where it runs: `planGitSections`, at the current pending-carry decision
(plan.ts:622-633). For each pending repo, BEFORE carrying:

1. Fingerprint-gate the probe with the same `attempt` sidecar (don't re-probe
   unchanged state every push).
2. If NOT superseded → carry pending verbatim (today's behavior, unchanged).
3. If superseded → **clear the pending state and capture fresh**:
   - delete `gitPendingRemote[rel]`, `partial[rel]`, the apply deferral
     record, and the `attempt` sidecar;
   - quarantine-then-clear any standing follow journal for `rel` exactly the
     way absence-supersession does today (a stale journal must not be
     resurrectable by later recovery);
   - BASE is NOT touched (it stays the pre-pending value; the composer's
     post-commit fold advances it wholesale when the fresh capture commits —
     the existing terminal path);
   - the repo enters the normal capture pool this same push
     (`git-sync superseded pending for <rel>: local history subsumes the
     unapplied remote section` — one bounded log line).

Livelock resolution trace (savvy-core): push probe proves pending.main ⊑
local main → pending cleared → fresh capture publishes current refs → remote
section now contains local tip → next pull: incoming roots own local tip →
no hold → deferral clears → `unchanged` thereafter. One push + one pull,
no manual intervention, no data destroyed (every oid in the old pending was
provably already in local history).

Non-interaction with 130's tombstone plane: supersession authors no
tombstones and deletes no refs — capture advertises exactly what exists
locally, and `RepoRecord.advertised` continues to gate deletion authoring
as today. Multi-writer safety: if another writer HAS advanced the remote
section beyond `P` meanwhile, our commit's parent-sequence guard (409) makes
the push lose, the next pull delivers the NEWER section as pending, and the
probe re-evaluates against that — supersession never overwrites unseen
remote truth.

### 4.3 C — Follow instrumentation (ships with A)

Extend `GitChainTimings` (`src/engine/git/shared.ts:17-27`) with:
`refTxnMs` (checkout-txn prepare+commit), `ownershipMs` (all
`tipOwnedByIncoming`/`partitionOwnedByIncoming` calls), `reflogMs` (stash +
preservation enumeration), `fsckMs` (apply.ts:712), `classifyMs`
(classifyCheckout total). Emit in the existing per-repo `repoMs` token
(`L4fd…bv…gi…` gains `rt…ow…rl…fk…cl…`) and the p50/p95 aggregates. Budget:
timer plumbing only, no behavior. Acceptance for the dark-time question is
that the savvy-core repro's 30s becomes fully attributed (sum of sub-timers
≥ 90% of repo wall).

### 4.4 D — Conflict-ref retention (policy ratified §2)

At the end of a successful capture (push side, repo already quiet), a bounded
retention pass over `refs/rbox-conflict/*`:

- prune when the snapshot commit is reachable from any current local branch
  tip (supersession — work made it back in);
- else prune when older than 90 days (namespace timestamp segment);
- else keep. Cap the pass (e.g. 64 deletions per push) so one push never
  stalls on a 810-ref backlog; the backlog drains across pushes.
- `rbox status` gains `conflict snapshots: N (M prunable)` when N > 0.
- Deletions use plain `update-ref -d` batches — conflict refs are
  non-syncable scratch (already allowlisted for raw update-ref in 130's
  structural tests) and never appear in BASE/capture.

### 4.5 E — Notify-pull scan-skip

When `doPull` runs with a watcher in healthy event mode and the file plane
reports no dirty candidates since the last completed scan (the same
authority 172/175 established: watcher generation current + no pending
debounce + no safety-floor breach), `pull()` reuses `lastSyncedManifest`'s
scan output instead of re-walking (pull.ts:131-142 gains the same
`mode=steady` reuse the git plane already has). The safety scan cadence and
deep-scan carriers are UNTOUCHED — this only removes the per-notify-pull
full walk. Fleet effect: Mac −7.5s, flat-meadow −4.6s per pull. A reused
scan is marked in the summary (`scan 0.0s reuse=watcher`) so forensics can
always tell.

### 4.6 F — Push tail: instrumentation only in 174

`missing` (server existence probe) and `commit` get sub-timing detail
(chunk count, per-chunk p95, payload bytes) in the push summary. Any
optimization (e.g. manifest-diff-scoped missing-set) is a separate design
seeded by that data. Explicit non-goal here.

## 5. Tests the implementation MUST write

1. **Livelock end-to-end regression** (the savvy-core shape): writer repo
   with pending section older than local main (local ahead ≥1 commit) +
   rbox-created stash whose parent is off a side branch → assert: push
   probe clears pending, capture publishes, follower converges, deferral
   clears, NO ref/stash content lost (every old pending oid still reachable).
2. **A-skip correctness**: held repo (local-commits), unchanged keys →
   second pull performs zero git subprocesses for that repo (spawn-count
   probe); any local commit/ref-move/stash mutation → full follow resumes.
3. **A never skips non-git-state reasons**: local-edits / local-index /
   local-operation holds re-follow every pull even with unchanged keys.
4. **A safety floor**: elapsed floor forces re-follow; divergent outcome
   with unchanged keys emits the fingerprint-miss WARNING.
5. **B refuses partial subsumption**: pending contains branch X absent
   locally (or non-ff) → carry + hold persist exactly as today; pending
   with equal-oid refs everywhere → superseded.
6. **B multi-writer race**: concurrent remote advance (parent-sequence 409)
   → superseded-clear does not clobber; next pull re-establishes newer
   pending; probe re-evaluates.
7. **B journal hygiene**: standing follow journal for the superseded repo is
   quarantined, not recoverable into a resurrection of the cleared pending.
8. **D reachability prune**: conflict ref reachable from a branch tip →
   pruned; unreachable + young → kept; unreachable + >90d → pruned; cap
   respected across pushes; status line counts match.
9. **E manifests equality**: notify-pull with healthy watcher and no dirty
   paths produces byte-identical manifest to a full walk (differential test
   under concurrent file mutation → reuse DISABLED when dirty).
10. **C attribution**: instrumented follow on a many-ref fixture attributes
    ≥90% of wall to named sub-timers.
11. **Structural**: `attempt` sidecar discarded on stateNonce / identity /
    fingerprint-version change; skip path emits no BASE writes (composer
    call-count zero for skipped repos).

## 6. Rollout

Default ON (founder default-on rule; kill switches per surface):
`RBOX_GIT_HELD_SKIP=0` (A), `RBOX_GIT_PENDING_SUPERSEDE=0` (B),
`RBOX_PULL_SCAN_REUSE=0` (E). C/D have no switches (instrumentation +
bounded hygiene). Validation on the LIVE repro: upgrade the Mac dev build
while savvy-core is still wedged; watch it self-heal (§4.2 trace) — the
strongest possible field test, already provisioned by leaving the wedge in
place. Then the rig scenario (test 1) guards it forever.
