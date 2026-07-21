# 174 — Apply-side performance: held-repo livelock, git-apply dark time, and pull/push tails

Status: ALIGNED v6 — v5 index-lane amendment folded per r4 focused review (4 findings, all accepted as prescribed); base ALIGNED v4 2026-07-21
Author: Claude (session 2026-07-21), field evidence from the live fleet
Relates: 172 (event-driven capture), 175 (ref side-channel), 130 (follow/ownership model),
173 (reserved: two-writer spurious divergence — this doc's item B is the ONE-writer sibling)

## 0. Summary

What began as "APFS git-apply is ~32s" decomposed, under live-fleet forensics, into
one severe correctness bug wearing a performance costume, plus three bounded
performance items. The headline: a **one-writer livelock** in the git plane —
a repo whose local checkout moves ahead of its last-published section gets its
apply-side HELD and its push-side capture GAGGED simultaneously, forever. The
victim repo re-runs a full ~30s follow on every pull with no convergence and no
self-heal. Live occurrence: `Dfinitiv/savvy-core` on the founder's Mac since
2026-07-20 21:59Z (left wedged deliberately as a repro; file-plane sync healthy).

## 1. Field evidence (author-observed on the live fleet, 2026-07-20/21;
no checked-in diagnostic fixture) [r1: C18]

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

- `2026-07-20T21:58:22` push publishes **sequence 83**: `blobs=112291`; this
  coincided with the v1.7.14 fingerprint-schema bump (4→5, design 175). This is
  raw timeline evidence; its former schema-bump seeding interpretation is
  retracted in §1.3. [r1: C14]
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

**RETRACTED seeding narrative.** The observed sequence-83 timeline above is raw
evidence, but neither the schema bump nor an ordinary commit-during-push race is
a code-supported seed: the fingerprint bump only invalidates the divergence
cache, accepted pushes fold their section into durable BASE, and daemon
operations serialize. The loop *after a pending section exists* is
code-confirmed; how this pending section was seeded remains an open forensic
question. Candidate hypotheses are pre-existing pending from an earlier hold,
accepted-commit/state-save crash recovery, or another writer's earlier section.
Implementation begins by reconstructing the live Mac's pre-83 `RepoRecord` and
sequence/ACK history; the rbox-created 2026-07-16 stash may explain a blocker
only after a real remote transition entered follow. [r1: C14]

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
  phase token, no per-step timing. The follow-path connectivity proof is
  `src/engine/git/checkout-txn.ts:282-284`, gated at `:563-566`;
  `src/engine/git/apply.ts:712` is the legacy diverged path. No connectivity
  subprocess was observed; it is not the pole. [r1: O5]
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
  eligible ownership blocker from O(full follow) to O(fingerprint compare).
  This protects only the complete blocker sets made entirely of
  `local-commits` and `local-stash`. Expected effect on the author-observed live
  Mac: pull 43s → ~13s immediately, even before B lands. [r1: C18]
- **B. Break the one-writer livelock (supersession)** — distinguish
  "local strictly ahead of incoming" from "diverged". A cheap probe admits a
  candidate capture; every semantic lane of the pending section must then be
  subsumed by that exact final candidate before an accepted ACK clears the
  hold. Must engage the design-130 ownership model on its own terms; the
  two-writer sibling (173) stays reserved but the proof machinery should be
  built to serve both. [r1: C5,C6,C7]
- **C. Light up the dark 20s** — sub-timers for the follow pipeline:
  exclusive ref-transaction, ownership, reflog, connectivity-proof, and
  index/op-state leaves plus residual; nested classification is reported but
  not summed. Extend `GitChainTimings` (shared.ts:17-27) + the `git-apply` log
  token so a regression here is never invisible again. Cheap, ships with A.
  [r1: C16,O5]
- **D. rbox-conflict ref retention** — 810 conflict refs inflate every ref
  transaction, fingerprint, and capture forever. Policy (founder-ratified
  2026-07-21): **prune-on-supersession** — a conflict ref whose commit is
  reachable from a current branch is deleted (the work made it back in);
  everything else falls under a generous **age floor (90 days)**; the live
  snapshot count is surfaced in `rbox status` so retention is never silent.
  No prune ever runs on refs younger than the floor unless superseded.
- **F. Push-tail** — `missing` probe and `commit` cost on no-change pushes;
  measurement-first (one more instrumentation level), likely its own follow-up.

Non-goals: notify-pull scan reuse — designs 172/175
deliberately keep watcher signals latency-only because Parcel can silently drop
events and startup has a scan-to-watch gap; `lastSyncedManifest` is BASE rather
than local truth, so reuse can corrupt reconcile semantics and distort the
mass-delete guard, while daemon post-pull `replaceManifestFromScan` remains
regardless. A future design needs a loss-detecting baseline protocol first; C2
will quantify scan share to motivate it. [r1: C11,C12,C13] Other non-goals are
reworking design-130's ownership semantics beyond the supersession distinction;
two-writer divergence (173); any change to conflict-ref CREATION; and
APFS-specific filesystem tuning (the generic-APFS theory is dead — savvy-core's
cost is ref-surface × follow-work, not the filesystem).

## 3. Open questions — resolutions pinned in §4 (review anchors)

1. A's idempotence key → §4.1: a stable `gitFingerprint` bracket plus exact
   reflog digests and state/protocol bindings, gated by a complete typed blocker
   set rather than the collapsed display reason. [r1: C1,C2,C3,C4]
2. B's supersession proof → §4.2: capture first, then prove every lane against
   the exact final normalized candidate, and clear only on accepted ACK.
   [r1: C5,C6,C7]
3. The rbox-created-stash hold → subsumed by B only when P and the exact final
   candidate have the same stash oid (§4.2 stash lane); reflog-only content is
   device-local under existing stash semantics. [r1: C7,O8]
4. ~~D retention semantics~~ RESOLVED (founder, 2026-07-21): supersession +
   90-day age floor + status surfacing (see §2 D).
5. A's fingerprint-lie defense → §4.1 safety floor: 1h forced re-follow +
   loud divergence WARNING (canary, not silent self-heal), with the same
   outcome refreshing the attempt clock. [r1: C15]

## 4. Mechanism

Design-130 constraints this section obeys (non-negotiable): a PENDING section
carries byte-for-byte and is exempt from normalization while it exists
(changing it would orphan `gitIncomingKey`-bound partial progress and deferral
episodes); persisted `RepoRecord.base` moves ONLY through
`composeRepoBase(...)`'s closed authority union; branch mutations route
through the typed transition planner. Nothing below adds a BASE authority arm:
**A skips only after recovery/settlement; B stages a candidate while P remains
intact, then uses the EXISTING capture→commit→publisher-ACK path to re-establish
truth — sidecars clear only after an accepted commit, in the generation-CAS
publisher-ACK state transition (push.ts:680-738). Remote acceptance and the
local clear are NOT one atomic transaction: a crash between them safely leaves
the old sidecars for ordinary recovery.** [r1: C4,C5,C9; r2: 6]

### 4.1 A — Held-repo idempotence short-circuit (apply side)

Classification gains a complete typed blocker-set seam. `TypedBlocker` is a
CLOSED provenance-bearing union spanning BOTH classification and orchestration:
ref-plane and checkout blockers come from `FollowResult.blockers`, and the
apply orchestrator merges in composer disposition (a composer `pending` even
with empty `heldRefs`, apply.ts:1207-1222) and pre-follow protocol/artifact
holds (apply.ts:948-956) before the attempt outcome is recorded — the attempt
stores the MERGED set, never `FollowResult` alone. The existing singular
display reason is derived from that set and is never an eligibility input.
The skip predicate requires `blockers.length > 0 && blockers.every(allowlisted)`
— an empty set (e.g. composer-only pending recorded nowhere) can never
vacuously qualify. Indeterminate ownership, object-preservation, or graph
proofs produce an `indeterminate` blocker outside the allowlist, never a
`local-commits` or `local-stash` blocker. Preflight structurally rejects
`info/grafts` and shallow-adjacent graft files: the repo becomes `unsupported`,
which is never skippable. [r1: C2,C3; r2: 1]

New per-repo sidecar (in `RepoRecord`, alongside the existing partial/pending
bookkeeping; never wire-visible): [r1: C1,C4,O2,O4]

```ts
attempt?: {
  incomingKey: string;                 // gitIncomingKey this attempt saw
  localFingerprint: string;            // equal stable before/after bracket value
  reflogs: { path: string; digest: string }[]; // sorted, exact consulted logs
  blockers: TypedBlocker[];             // complete set, with provenance
  repoIdentity: string;
  stateNonce: string;
  baseOriginsHash: string;              // exact BASE + origins snapshot
  partialDisposition: string;           // exact revalidated partial disposition
  at: string;                           // ISO timestamp of the attempt
}
```

- `localFingerprint` reuses the existing capture-side `gitFingerprint`
  machinery (`src/cli/sync-git/fingerprint.ts`, including its racy-clean margin
  and `GIT_FINGERPRINT_VERSION` coupling). Recording and checking an attempt
  use the divergence-cache pattern: clear common-dir memoization and require
  equal trusted fingerprints before and after reading every bound input. The
  attempt also digests the exact bytes of `logs/refs/stash` and every branch
  reflog consulted by the boundary proof; classification enumerates that path
  list and the attempt persists it in sorted order. Any read error or unstable
  bracket fails open to a full follow. [r1: C1,C4,O2,O4]
- **Placement.** A runs strictly after journal recovery, follower-protocol/P
  settlement, and partial revalidation. A journal-present or standing-P
  observation invalidates the old attempt before settlement; any partial
  disposition, BASE/origins snapshot, repo identity, state nonce, incoming
  section, or fingerprint-version change also invalidates it. Only a new stable
  post-settlement observation may replace it. [r1: C4,O4]
- **Skip rule.** On apply, for a repo with `pending[rel]` present, the full
  follow is SKIPPED iff the current incoming key, stable fingerprint bracket,
  exact sorted reflog path/digest set, repo identity and state nonce,
  BASE/origins hash, and partial disposition all equal the attempt; every
  blocker in the complete set is one of `{local-commits, local-stash}`; and the
  safety floor has not elapsed. The collapsed display reason is irrelevant.
  [r1: C1,C3,C4]
- A skip preserves pending, partial, BASE, and the same visible deferral
  episode, but refreshes that episode's `lastSeen` through an ordered
  sidecar-only update bound to its predecessor `lastSeen`. It emits no
  `git-sync followed` line and bumps the pull-summary counter
  (`git-apply … skippedHeld=N`). [r1: C15]
- **Invalidation** is fail-open: any bound-input change triggers a full follow.
  A successful follow or any terminal transition clears `attempt`.
- **Safety floor:** a skipped repo is force-re-followed when
  `now - attempt.at > 1h` (constant, not configurable). If the forced
  re-follow produces a DIFFERENT outcome with all bound inputs unchanged, that
  is a fingerprint-coverage bug: log loudly
  (`git-sync WARNING <rel>: held-skip fingerprint miss`) — this is the
  canary, not a silent self-heal. When the forced follow returns the same
  outcome, it refreshes `attempt.at`. [r1: C15]

Per-input skip coverage replaces the old blanket divergence-cache claim:
[r1: C1,C2,C3,C4,O2,O4]

| Decision input | Coverage in the attempt |
| --- | --- |
| Incoming section | `incomingKey` |
| Refs, HEAD, index, locks, op-state, shallow/alternates/config/worktrees | stable trusted `gitFingerprint` before/after bracket |
| Stash ownership | exact digest of `logs/refs/stash` bytes |
| Checkout-boundary ownership | exact digest and recorded path for every consulted branch reflog |
| Graph/object proof uncertainty | `indeterminate` non-allowlisted blocker; graft files are structurally unsupported |
| Classification completeness | full provenance-bearing `TypedBlocker[]`, never the display reason |
| Protocol and logical authority | post-recovery placement plus repo identity, state nonce, BASE/origins hash, and partial disposition |

Effect: steady-state deferral cost drops from O(full follow) (~30s on
savvy-core) to a fingerprint plus bounded reflog digest comparison for complete
blocker sets containing only the two eligible ownership reasons, independent
of B.

### 4.2 B — Pending supersession (push side: capture, prove, then swap)

B is **capture-then-prove-then-swap**. `P` and every pending/partial/deferral/
attempt sidecar remain byte-for-byte intact throughout planning, capture,
normalization, upload, and commit. At the existing pending-carry decision
(`src/cli/sync-git/plan.ts:622-633`), a cheap fingerprint-gated pre-probe asks
only whether local *may* supersede `P`; a maybe result admits the repo to the
capture pool without granting authority to clear anything. A probe that sees
git-busy carries `P` and also surfaces a capture `git-busy` observation, arming
the existing +2s/+8s retries. [r1: C5,C6,O3,B2,C15]

The existing plan-side recovery preamble
(`src/cli/sync-git/plan.ts:262-317`) is a hard precondition. B proceeds only
after recovery reaches one of: none, rolled-back, landed-and-cleared, or
quarantined-binding-mismatch. Recovery defer, corruption, required human
intervention, or `fresh-quarantined` (journal.ts:89-96 — the push prepass
already blocks capture for it, plan.ts:308-316) blocks supersession and
carries `P`. The B gate switches exhaustively over
`JournalRecoveryResult.status` with a compile-time `never` check so a future
disposition cannot default to proceeding. B invents no journal clear or
absence-supersession quarantine primitive. [r1: C10,B4a,B3,O9; r2: 4]

Capture and normal outbound normalization then produce the exact final
candidate `C`.
The normalizer takes validated `P.refTombstones` and
`P.refTombstoneGeneration` as an explicit retention source alongside the
advertised and candidate sources; the retained high-water mark is
`max(advertised, P, candidate)`. Tombstone authoring-predecessor semantics stay
advertised-based. [r1: C8,O1,B1]

Only that final candidate is the supersession proof subject. `P` is superseded
iff every lane passes: [r1: C6,C7,O7,B4b]

- every same-name branch in `P` exists in `C` at an equal or fast-forward oid;
- every tag in `P` exists in `C` at exactly the same oid;
- `refs/stash` is exactly equal in `P` and `C`;
- HEAD is exactly equal, both for symbolic and detached forms;
- `refScope` is exactly equal;
- the index lane is subsumed. AMENDED v6 (maiden rig run + r4 focused review,
  2026-07-21): exact `indexIdentityV2` equality between `P` and `C` — the r1
  rule — is VACUOUS for the healing case (rig-proven: an ahead writer's clean
  index can never equal the stale pending's; "final candidate did not
  supersede pending section" on the seeded wedge). The sound rule is
  **clean-and-plain against `P`'s own head** [r4: 1,2,3]:
  * `pendingHeadOid`: resolved from `P` ALONE after `validateGitSection(P)` —
    detached `P.head` is the trimmed 40-hex value itself; symbolic `P.head`
    parses the exact `refs/heads/…` target and reads `P.refs[target]`
    (validation guarantees the key). Never live refs, never a hard-coded
    `main`. Peel `${pendingHeadOid}^{commit}` under `graphEnv`; missing/
    non-commit/unpeelable → block. [r4: 2]
  * CLEAN: `git diff-index --cached --quiet <peeledPendingHead> --` with the
    absolute `GIT_INDEX_FILE` at `P`'s materialized index artifact + graphEnv.
    Exit 0 alone passes; exit 1 (dirty) blocks; ANY other status or thrown
    error blocks. Artifact materialization must succeed and the fetched file
    must be a regular file BEFORE Git runs — a nonexistent `GIT_INDEX_FILE`
    reads as a new empty index and could false-pass on an empty tree. The
    old `null === null` absent-lane equality does not survive; an absent
    index lane on either side keeps the r1 exact-presence rule (both absent
    → lane vacuously subsumed; one-sided absence → block). [r4: 3]
  * PLAIN: reject any non-stage-0 entry, intent-to-add, assume-unchanged
    (`CE_VALID`), skip-worktree, sparse-directory entry, or resolve-undo
    data in `P`'s index — a tree-clean index can still carry these
    index-only semantics, which design 116 counts as follower-visible state
    (`indexIdentityV2` includes them; losing them is `local-index` data
    loss). Reuse the existing index-identity parser to decide plain-ness —
    no new index parsing. A metadata-preserving supersession may be designed
    later; v6 blocks. [r4: 1]
  A clean-and-plain pending index carries no information beyond `P`'s
  committed history, which the branch lane has already proven subsumed.
  `C`'s own index needs no comparison — it is this writer's current truth,
  published as-is;
- the complete op-state path→artifact map is exactly equal;
- canonical config is exactly equal.

No ancestry-through-another-ref laundering is allowed, and ancestry is defined
over the LITERAL object graph: every peel/walk/ancestor subprocess in the
supersession proof runs with `GIT_NO_REPLACE_OBJECTS=1` (alongside the existing
`GIT_NO_LAZY_FETCH=1`), because `refs/replace/*` is non-syncable and absent
from the published candidate — a local replacement must not make a divergent
pending tip appear ancestral. Any proof error, shallow repository, missing
object, absent lane, or mismatch fails closed and discards `C` in favor of
carrying `P` byte-for-byte. This candidate-bound proof is the only publication
authority; the cheap pre-probe is never spent as one. [r1: C6,C7; r2: 2]

On any failure—preflight, config, capture, upload, 422, commit, or 409—`P` and
all its sidecars remain byte-for-byte intact and the today-path carries `P`; no
regression candidate is published. Only the
accepted-commit ACK transition clears state, through the existing publisher-ACK
composer arm and ordered sidecar transitions: pending becomes absent,
`partial[rel]=null`, `attempt=null`, and the apply-lane deferral clears bound to
its predecessor `lastSeen`. BASE is not replaced wholesale: under existing
composer rules the accepted candidate advances present members, while omitted
prior refs/anchors and their required origins remain retained. [r1: C5,C9,O3,B2]

Livelock resolution trace (savvy-core): the pre-probe admits capture; final
candidate.main proves `pending.main ⊑ candidate.main`; the candidate commits;
its ACK atomically clears pending and sidecars; the next pull is unchanged.
One accepted push resolves the wedge without manual intervention. The no-drop
claim applies to branch and tag lanes proved against the final candidate.
Reflog-only stash content remains device-local under existing stash-sync
semantics. [r1: C5,C6,O8]

Multi-writer CAS remains airtight for unseen remote sequences: a remote advance
after the observed parent yields 409. B does not promise that the newer section
then becomes pending—it may apply cleanly—but ACK-gated clearing makes the case
trivially safe because no pending or sidecar state was cleared. [r1: C5,O3]

### 4.3 C — Follow instrumentation (ships with A)

Extend `GitChainTimings` (`src/engine/git/shared.ts:17-27`) with exclusive leaf
intervals `fetchDecryptMs`, `bundleVerifyMs`, `gitImportMs`,
`refTxnExclusiveMs`, `ownershipMs`, `reflogMs`, `connectivityProofMs`, and
`indexOpStateMs`, plus an explicit residual. `classifyMs` is a nested parent,
reported separately and excluded from the leaf sum. The connectivity leaf
times the follow-path proof at `src/engine/git/checkout-txn.ts:282-284` (gated
at `:563-566`), not the legacy diverged-path fsck at
`src/engine/git/apply.ts:712`. Emit the leaves, nested parent, and residual in
the existing per-repo token and p50/p95 aggregates. Budget: timer plumbing
only, no behavior. Acceptance is
`repoWall − union(leafIntervals) ≤ 10%`; overlapping nested intervals can never
satisfy it by double-counting. [r1: C16,O5]

**C2 — fleet phase telemetry (founder ask, 2026-07-21).** Today NO phase
timing leaves the device: the wire kinds are propagation / first_publish /
upload_lane / ws_health / safety_event / git_capture — coarse or count-only.
The author-observed savvy-core loop (62 min/day of churn) produced zero remote
signal; it was found only by SSH log forensics. New telemetry kind:

```ts
interface SyncPhaseSample {
  kind: "sync_phase";
  op: "pull" | "push";
  wallMs: number;
  phases: Record<string, number>;   // PhaseName -> ms, straight from PhaseReport.toJSON()
  gitApplyMaxRepoMs?: number;       // max per-repo wall inside git-apply
  gitApplySkippedHeld?: number;     // A's skip counter
}
```

Sampling: emit every Nth completed op (N=8) AND unconditionally when
`wallMs` exceeds a per-op static outlier bound (pull > 20s, push > 15s) so
tails are never sampled away. Rides the existing design-120 ingest queue,
accumulator, and fleet-only privacy model unchanged; no new endpoint. The
admin cockpit chart (phase p50/p95 over time per device) consumes it — this
also supplies the before/after drop-off chart for 174 itself. Repo PATHS are
never in the sample (privacy: durations and counts only).

### 4.4 D — Conflict-ref retention (policy ratified §2)

An independently bounded hygiene phase may run after either a stable
fingerprint-gated probe/carry or a capture. It performs a bounded pass over
`refs/rbox-conflict/*`: [r1: C17,O6]

- prune when the snapshot commit is reachable from any current local branch
  tip (supersession — work made it back in);
- else prune when older than 90 days (namespace timestamp segment);
- else keep. Cap the pass (e.g. 64 deletions per push) so one push never
  stalls on a 810-ref backlog; the backlog drains across pushes.
- `rbox status` gains `conflict snapshots: N (M prunable)` when N > 0.
- Deletions use old-OID-checked `update-ref -d` transactions, fail closed on
  any reachability error, and refresh or invalidate that repo's
  divergence-cache entry after every batch. Conflict refs are non-syncable
  scratch (already allowlisted for raw update-ref in 130's structural tests)
  and never appear in BASE/capture.

D does not run on a still-wedged repo until B clears it; A removes the interim
per-pull cost. Once B lands, independent carry-side hygiene drains the backlog
without waiting for unrelated captures. [r1: C17,O6]

### 4.5 F — Push tail: instrumentation only in 174

`missing` (server existence probe) and `commit` get sub-timing detail
(chunk count, per-chunk p95, payload bytes) in the push summary. Any
optimization (e.g. manifest-diff-scoped missing-set) is a separate design
seeded by that data. Explicit non-goal here.

## 5. Tests the implementation MUST write

1. **Livelock end-to-end regression** (the savvy-core shape): writer repo
   reaches pending through a real transition—a second writer advancing the
   section or the documented accepted-commit/state-save crash-recovery path—
   then has local main ahead ≥1 commit plus an rbox-created stash whose parent
   is off a side branch. Assert capture, candidate proof, and the accepted ACK
   clearing EXACTLY: pending absent, `partial[rel]=null`, `attempt=null`, only
   the predecessor-bound apply deferral episode cleared, while an omitted
   prior branch and its origin remain retained in BASE; then follower
   convergence. Do not construct the fixture from the retracted seq-83
   schema-bump narrative. The fixture's local-ahead commit MUST change tree
   content so `indexIdentityV2(P) !== indexIdentityV2(C)` is asserted — the
   rig stays a direct v6 vacuity regression. [r1: C14; r2: 5; r4: 4]
2. **A-skip correctness**: held repo (local-commits), unchanged keys →
   after the mandatory prepass (journal recovery, protocol/P settlement,
   partial revalidation — which MAY invoke git and MUST be asserted to have
   run first), the second pull performs zero fetch/decrypt/import/follow/
   ref-transaction work for that repo; any local commit/ref-move/stash
   mutation → full follow resumes. [r2: 3]
3. **A never skips non-git-state reasons**: local-edits / local-index /
   local-operation holds re-follow every pull even with unchanged keys.
4. **A safety floor**: elapsed floor forces re-follow; divergent outcome
   with unchanged bound inputs emits the fingerprint-miss WARNING, while the
   same outcome refreshes `attempt.at`. [r1: C15]
5. **B refuses partial subsumption**: pending contains branch X absent
   locally (or non-ff) → carry + hold persist exactly as today; pending
   with equal-oid refs everywhere → superseded.
5b. **B index lane (v6, real artifacts)**: (a) P clean-and-plain at commit A,
   C clean at fast-forward B, `indexIdentityV2` values asserted UNEQUAL →
   supersession succeeds; (b) P with staged work relative to its head →
   blocks; (c) tree-clean P carrying each of assume-unchanged, skip-worktree,
   sparse-directory, and resolve-undo → blocks; (d) non-main symbolic head,
   detached head, head unresolvable from P, and corrupt/missing index
   artifact → blocks (never a false-pass via the empty-index read).
   [r4: 1,2,3,4]
6. **B tombstone retention**: three-device case where P alone carries a
   branch tombstone chain/generation and advertised lacks it → superseding
   normalization preserves the chain and high-water mark. [r1: C8,O1]
7. **B pre-ACK failure table**: each failure class — capture, upload, 422,
   commit error, and 409 — leaves pending, partial, attempt, AND the deferral
   byte-for-byte intact and publishes no regression section. [r1: C5; r2: 5]
8. **B candidate-vs-probe race**: reset a ref between the maybe pre-probe and
   capture so the final candidate no longer subsumes P → carry P. [r1: C6]
9. **B multi-writer 409**: a 409 during a superseding push leaves pending and
   deferral byte-for-byte intact; the subsequent pull may apply or establish
   newer pending according to normal follow semantics. [r1: O3]
10. **A key/ordering adversaries**: dropping `stash@{1}` in a T→U→T
    reflog-only mutation invalidates the attempt; `info/grafts` makes the repo
    unsupported; `local-commits + indeterminate/unreadable` never skips;
    `local-stash + worktree-ownership` never skips; a composer-only pending
    outcome (empty classification blockers) never skips (non-empty
    requirement); a held-ref (`local-commits`) follow whose composer
    INDEPENDENTLY returns pending records the composer blocker in the merged
    set and never skips; a `refs/replace/*` entry making a divergent pending tip
    appear ancestral → B carries P; and a journal-present pull performs
    recovery rather than skipping. [r1: C1,C2,C3,C4; r2: 1,2]
11. **B journal precondition**: terminal none/rolled-back/landed-and-cleared/
    quarantined-binding-mismatch dispositions may proceed; defer, corruption,
    human-intervention, AND fresh-quarantined dispositions carry P; the gate's
    switch is exhaustive over `JournalRecoveryResult.status`.
    [r1: C10,B4a,B3; r2: 4]
12. **D reachability prune**: conflict ref reachable from a branch tip →
    pruned; unreachable + young → kept; unreachable + >90d → pruned; cap
    respected across carry pushes; each prune batch refreshes/invalidates the
    divergence-cache entry; status line counts match. [r1: C17,O6]
13. **C2 telemetry**: `sync_phase` emits for outlier operations and every Nth
    completed operation, and samples contain no repo paths. [r1: C11,C12,C13]
14. **C exclusive attribution**: an instrumented many-ref follow satisfies
    `repoWall − union(leafIntervals) ≤ 10%`; nested `classifyMs` is excluded
    from the sum and residual is explicit. [r1: C16,O5]
15. **Structural**: `attempt` sidecar discarded on stateNonce / identity /
    fingerprint-version change; the FINAL skip performs no BASE mutation
    (prerequisite composer/git calls from the mandatory prepass are allowed
    and asserted to have run first). [r2: 3]

## 6. Rollout

Default ON (founder default-on rule; kill switches per surface):
`RBOX_GIT_HELD_SKIP=0` (A), `RBOX_GIT_PENDING_SUPERSEDE=0` (B). C/D have no
switches (instrumentation + bounded hygiene). Validation on the LIVE repro:
upgrade the Mac dev build while savvy-core is still wedged; watch it self-heal
(§4.2 trace) — the strongest possible field test, already provisioned by
leaving the wedge in place. Then the rig scenario (test 1) guards it forever.
