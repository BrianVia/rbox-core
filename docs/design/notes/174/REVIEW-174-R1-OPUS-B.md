# REVIEW-174-R1-OPUS-B — narrow/deep adversarial review of design 174 §4.2 (pending supersession)

Scope: ONLY §4.2 "B — Pending supersession (push side: probe before carry)" of
`docs/design/174-apply-side-perf-and-held-repo-livelock.md`. Everything else is
context. Read-only checkout at `.claude/worktrees/174-apply-side`.

Method: walked every `GitSection` field (`src/engine/types.ts:77-118`) and the
design-130 wire/authority contract against the clear-and-recapture path §4.2
prescribes, traced the publisher tombstone normalizer, the `advertised` write
site, the 409 retry loop, and the journal-recovery preamble.

---

## Finding 1 — BLOCKER: clearing a multi-writer pending section reverts another writer's branch deletion/rewrite fleet-wide and regresses the tombstone high-water mark

This is the field §4.2 loses. It is `refTombstones` + the *implicit deletion*
that a pending section encodes, and it is lost precisely because §4.2 replaces a
byte-for-byte **pending carry** (which today re-publishes the section verbatim,
`plan.ts:625-632`, and design-130 line 394 "On push, pending is carried
byte-for-byte") with a **fresh capture routed through the normalizer**.

Who authored the pending section? §4.2's own livelock target is the *one-writer*
case, where the pending `P` and this device's `RepoRecord.advertised` are the
**same** section (the seq-83 self-republish → pulled back as pending). There
`advertised.generation == P.generation` and the tombstone chains are identical,
so recapture is lossless — one-writer is safe. **But savvy-core is explicitly a
many-writer repo** (doc §1.2 lines 47-51: "many developers, frequent commits to
main, linked worktrees…this failure shape is the STEADY STATE"), and §4.2 makes
explicit multi-writer safety claims (lines 287-291). In the multi-writer case
the pending section is authored by **W2**, not by us:

Concrete interleaving:
1. Seq N: W2 pushes a section that **deletes** `refs/heads/feature/x` and
   advances `main→M2`. That authors `refTombstones["refs/heads/feature/x"]` at a
   new repository generation `G` (design-130 lines 70-118; authoring at
   `publisher-tombstones.ts:105-118`).
2. W1 pulls seq N. Local `main` is ahead of `M2` (normal writer progress) → the
   whole section is HELD, `pending[rel] = P` (`apply.ts:576-577`,
   `plan.ts:29-30`). `P.refs = {main:M2, …}` — it does **not** contain
   `feature/x` (deleted). `P.refTombstones[feature/x]=[oldX]`, `P.generation=G`.
   Because the section is held whole, W1 **still has `feature/x=oldX` locally**
   (never applied the deletion).
3. W1 pushes. §4.2 probe (lines 242-256) iterates **`P.refs` only**: `main`
   fast-forward-subsumed by local, tags equal → declares `P` **superseded**.
   The probe never considers `feature/x`, because a deletion is encoded as a
   ref **absent from `P.refs`**, not present in it.
4. Clear `P`, capture fresh. Fresh capture emits **no** `refTombstones`
   (`capture.ts:284-297` produces none). The normalizer sources tombstones only
   from `advertised` and the candidate (`publisher-tombstones.ts:65-70,163`;
   `generation = max(advertised.gen, candidate.gen)`, line 70). `advertised` is
   **W1's own last committed push only** (`push.ts:684-720`, `publisher-ack`);
   pull never writes it. W1's `advertised` predates W2's deletion, so it carries
   `feature/x=oldX` and **no** tombstone for it.
5. Result section: `refs` includes `feature/x=oldX` (**resurrected**),
   `refTombstones` **drops W2's `[feature/x]` chain**, `generation` regresses to
   W1's older value `< G`.
6. W1 commits at N+1. **No 409** — W1 saw the latest sequence N, so the
   parent-sequence guard (lines 288-290; `push.ts:103-106`) does not fire. The
   409 defense only covers "another writer advanced beyond what I saw"; here W1
   legitimately won the race and *still* published a regressed section.
7. Fleet fallout: followers that applied W2's deletion see `feature/x`
   re-created; followers holding `feature/x` pending W2's tombstone lose the
   authorization to prune it (followers consume `incoming.refTombstones` to
   authorize the prune — `follower-protocol.ts:116-129`, design-130 lines
   504-523). W2's deletion is reverted for the whole fleet, and the repo-wide
   generation monotonicity design-130 line 78-90 promises ("generations observed
   for one ref are strictly increasing even across expiry"; a smaller high-water
   mark "is invalid") is violated across the N→N+1 sections.

The doc's disclaimer (lines 284-291) is exactly the bug: "capture advertises
exactly what exists locally" **resurrects** any deletion/rewrite that `P`
encoded but local had not yet applied, and "supersession…deletes no refs" is
false in effect — it un-deletes one. This is a silent E2EE data-plane regression
shipped default-ON (§6: `RBOX_GIT_PENDING_SUPERSEDE` default on) straight at the
multi-writer repo it targets.

Evidence: `src/engine/git/capture.ts:284-297`;
`src/cli/sync-git/publisher-tombstones.ts:36-48,65-70,105-119,158-166`;
`src/cli/sync/push.ts:684-720`; `src/cli/sync-git/plan.ts:172-173,625-632`;
`src/cli/sync-git/follower-protocol.ts:116-129`; `src/cli/sync-git/apply.ts:576-577`;
design 130 lines 70-118, 394, 504-523; design 174 §4.2 lines 242-256, 284-291.

Minimal fix (conservative, preserves the one-writer target): the probe must
refuse supersession whenever `P` carries information that is **not already in
`RepoRecord.advertised`** — specifically (a) any `refTombstones` entry (or
generation) present in `P` but absent from `advertised`, and (b) any branch that
`advertised`/local holds but `P` (an `all`-scope section) omits (an encoded
deletion). In the one-writer livelock `P == advertised`, so both tests pass and
supersession still fires; the multi-writer deletion/rewrite case is refused and
falls back to today's verbatim pending carry (which correctly propagates W2's
tombstone). Both inputs are already in scope at the call site (`plan.ts:172`
reads `record.advertised`; `pending[rel]` is `P`).

---

## Finding 2 — MAJOR: the "every oid was provably already in local history" guarantee is proved at probe time but consumed at capture time, with no lock or re-check binding them

§4.2 lines 281-282 assert "no data destroyed (every oid in the old pending was
provably already in local history)." The probe (`merge-base --is-ancestor`) and
the fresh capture (`git bundle`) are **two separate git invocations** with no
shared snapshot. The founder works in savvy-core daily and user git operations
are **not** under rbox's workspace sync mutex, so between probe(t0) and
capture(t1) the user can move refs. If the user rewinds `main` past `P.main`
between t0 and t1, the probe said "superseded" against tip `T ⊒ P.main`, but the
capture publishes a rewound tip `T' ⊏ P.main`, and `P` has already been deleted.
`P.main`'s oid is then absent from the wire and GC-eligible; a follower that had
not yet applied `P` can lose it fleet-wide (the superseding section N+1 replaces
seq-N's section that carried it). The `attempt`-sidecar fingerprint gate (lines
259-261) is a single pre-capture read and does not close this window.

Evidence: §4.2 lines 242-244 (probe primitive), 264-275 (clear + capture as
distinct steps), 281-282 (the stale guarantee); `capture.ts:278-297` (capture
reads live refs independently). Mutex scope: design 130 lines 779-793 (mutex
covers rbox ops, not user git).

Minimal fix: verify subsumption against the **captured section's** refs
(post-capture), not a pre-capture probe — the captured section already contains
the live refs, so assert `P.refs ⊑ captured.refs` immediately before deleting
`gitPendingRemote[rel]`. Cheap, and it collapses the TOCTOU into a single
observation. (Combines cleanly with Finding 1's guard.)

---

## Finding 3 — MINOR: the journal-quarantine claim mis-cites its "reusable primitive"; the real safeguard is the plan-side recovery preamble, and the doc's step has no obvious call site

§4.2 lines 267-269 require clearing "any standing follow journal for `rel`
exactly the way absence-supersession does today (a stale journal must not be
resurrectable by later recovery)." Absence-supersession (`apply.ts:587-631`)
does **not** touch the follow journal at all — it deletes `pending/needsRes/
partial/idxProj` and returns "removed". Journals are landed-or-quarantined by
the shared per-repo **preamble** that runs earlier in the same pass
(`apply.ts:520-560`; on the push side `plan.ts:262-317`,
`recoverAndLandFollowJournal`/`quarantineUnboundFollowJournal`). So the
resurrection risk §4.2 worries about is in practice already contained *before*
the probe runs: a standing journal for `rel` is either (a) landed at
`plan.ts:293-307`, which installs `record.pending` into `pending[rel]` **and**
clears the on-disk journal (`follow.ts:276-278`, `intentSettled →
clearFollowJournal`), after which §4.2 deletes that in-memory pending — nothing
on disk survives to resurrect; or (b) `recoveryBlocked`, in which case `rel` is
handled at `plan.ts:608-620` and **never reaches the §4.2 probe site
(`plan.ts:625`)** at all. The capture path itself writes no follow journal
(journals are apply-side).

Net: not a correctness hole, but the doc points the implementer at a primitive
that does not live where it says. The prose should either (i) drop the extra
"quarantine-then-clear" step as redundant given the preamble already settles the
journal before line 625, or (ii) name the actual primitive
(`quarantineUnboundFollowJournal`, `follow.ts:285-293`) and the actual guarantee
(preamble ordering), so nobody implements a second, differently-behaved clear.

Evidence: `apply.ts:520-560,587-631,1624`; `plan.ts:262-317,608-620,625-632`;
`follow.ts:268-298`; §4.2 lines 267-269.

---

## Finding 4 — MINOR: `opState` and symbolic-`head` subsumption are weaker than "no information lost"

§4.2 (lines 247-251) treats an opState candidate as subsumed when "owned by
local tips," and `head` when it "names a branch that exists locally." A pending
section can carry an in-progress operation (MERGE_HEAD / rebase-merge, per
`types.ts:107-108`) that W2 was mid-flight on; every referenced commit can be
"owned by local tips" while the *operation-in-progress* semantics are still
information the section carries and the recapture drops (local isn't mid-merge).
This is per-device working state and far less severe than Finding 1, but it means
the "every piece of information it carries is already reflected in local"
definition (lines 236-237) is not literally met for the opState lane. Acceptable
if scoped as intentional loss of a device-local in-flight operation; call it out
rather than assert full subsumption.

Evidence: `types.ts:107-108,88-89`; §4.2 lines 236-237,247-251.

---

## Points examined and cleared (no finding)

- **409-retry against stale pending (task item 2):** NOT a bug. A 409 classifies
  as `pull-first` → PULL (absorbs W2) → **RE-SCAN + re-plan** with a fresh
  manifest (`push.ts:99-106,234-267`), so `planGitSections` re-runs the probe
  against the freshly delivered pending. The doc's re-evaluation claim (lines
  289-291) holds for the *pre-commit* race. It does **not** cover Finding 1,
  which is a no-409 win.
- **Pruned/missing objects in `P` (task item 3):** safe. Probe uses
  `merge-base --is-ancestor`; §4.2 lines 242-243 route "errors/shallow/
  missing-object → NOT superseded" — conservative and correct.
- **index / config lanes:** §4.2 blocks supersession on any index/config
  difference (lines 250-251). Conservative; costs livelock coverage for
  staged-index repos but loses no fleet information. Fine for v1.
- **BASE untouched:** consistent with design-130's composer contract (lines
  178-180, 270-272); the post-commit fold advances BASE wholesale via the
  existing terminal path. No authority-arm violation.

---

## Verdict: CHANGES-REQUIRED (scoped to §4.2 only)

The one-writer livelock fix is sound and lossless (advertised == pending). The
multi-writer generalization the section explicitly claims is not: clearing a
W2-authored pending section and recapturing reverts W2's branch deletions/
rewrites and regresses the tombstone generation fleet-wide (Finding 1, BLOCKER),
and the no-data-lost guarantee is not bound to the capture it is spent on
(Finding 2, MAJOR). Both have small, conservative fixes that keep the actual
livelock target working.
