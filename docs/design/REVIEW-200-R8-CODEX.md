# Design 200 v9 — Codex verification review, round 8

Date: 2026-07-25  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` v9,
`REVIEW-200-R2-CODEX.md` through `REVIEW-200-R7-CODEX.md`, and the current
implementation

## Verdict

**NOT-ALIGNED.**

Step D is viable on the ordinary active-BASE path: capture has the ref snapshot before
finalization, L can run after that snapshot, and `revertCapture` can replace either `out` or
`finalizedOutgoing` while undoing the successful-capture bookkeeping. The signed-sequence plumb
is also complete in every production caller of `applyGitSections`.

The amended C3 lifecycle is not complete. Amendment 2 prevents overwrite by carrying the whole
section, but that carry also prevents the captured assertion which amendment 3 needs to clear the
surviving entry. The exact round-7 B4 fixture therefore creates a permanent non-current latch once a
second ref is deleted. B5's proposed clear is additionally not implementable from the values the
ACK loop actually has, and its literal equality clears on `undefined === undefined` even though the
section asserts nothing.

Two smaller specification gaps remain around step D: a positive `record.base` does not imply that
`base[rel]` exists because removal/suppression deliberately hides the provenance anchor, and the
new step-D capture deferral has no producer mapping to `deletion-pending`.

## Per-finding verification

### Round-6 carry-forward

- **R6 B1 — CLOSED:** for an active projected BASE, step D gives every refused W/L outcome a safe whole-section carry and avoids both bare omission and G's uncovered ref.
- **R6 B2 — NOT-CLOSED:** C3 still has a destructive premature-clear edge and amendment 2 creates a new permanent survivor state.
- **R6 M1 — NOT-CLOSED:** the follow/apply reason path is specified, but step D's capture deferral still maps through `captureReason` to `other` or `artifact`, not `deletion-pending`.
- **R6 M2 — CLOSED:** case (b) is now accurately specified on the synchronous `GitResolutionRider` / publisher-ACK path shipped by design 177.

### Round-7 findings

- **R7 B1 — CLOSED:** G is withdrawn; an active BASE/pending carry reuses already-published pack links and never asks the deleted local object to cover a synthetic ref assertion.
- **R7 B2 — CLOSED:** the undecidable normalizer refusal is deleted, and a post-apply omission with retired BASE remains publishable.
- **R7 B3 — CLOSED:** drop condition 2 now uses the authenticated incoming sequence before apply, and every production `applyGitSections` path receives that exact verified sequence.
- **R7 B4 — NOT-CLOSED:** reconcile-before-arm prevents overwrite, but the specified wholesale survivor defer prevents condition 3 from ever clearing the old entry in the stated `R`-recreated/`S`-deleted case.
- **R7 B5 — NOT-CLOSED:** the literal condition-3 predicate is missing a positive-assertion conjunct and neither `live.refs` nor the composed post-ACK BASE is present at the ACK call site as claimed.
- **R7 M1 — CLOSED:** deleting the normalizer refusal deletes its missing per-repository error path; step D is a planner disposition.
- **R7 M2 — CLOSED:** the current-branch non-exit is now correctly derived, disclosed, tested, and given checkout/keep-mine exits; the new non-current latch is B4, not this disclosure.
- **R7 M3 — NOT-CLOSED:** the vocabulary sweep is substantially complete, but it misses the new step-D producer at `plan.ts:224-232`.
- **R7 M4 — CLOSED:** v9 matches the actual ephemeral rider, confirm-boundary re-derivation, one mutex scope, and user-rerun behavior.
- **R7 m1 — CLOSED:** unchanged OIDs retain their prior origin; the design no longer claims publisher re-minting or device-local authorship.
- **R7 m2 — CLOSED:** the status ordering and non-self-clear repair copy now match the implementation.
- **R7 m3 — CLOSED:** the field is correctly described as enabling conservative routing while enabling no destructive or authority-granting path.

## New findings

### BLOCKER 1 — amendment 2 turns the B4 overwrite race into an undisclosed permanent non-current latch

Evidence: design 200 §§3.2c amendment 2 and termination, §9.1; `src/cli/sync/push.ts:272-273`;
`src/cli/sync/pull.ts:174-200`; `src/cli/sync-git/plan.ts:174-183`, `:987-1055`;
`src/cli/sync-git/pending-supersession.ts:99-105`; `src/cli/sync-git/follow.ts:720-726`,
`:773-786`.

The requested fresh trace starts correctly. When the first omission POST landed but its ACK state
save was lost, the next push need not wait for a separately initiated pull:

1. push entry fetches the authenticated head and applies it before continuing, following the
   existing `resolutionReceipt` pattern;
2. with locally re-created non-current `R` present, the C3 entry force-holds R while that accepted
   omission is applied;
3. BASE remains at the prior R value and the entry survives reconciliation.

The defect begins after that valid reconciliation. Use v9's own round-7 B4 test:

1. arm omission attempt A for R, accept it, lose the ACK state save;
2. re-create non-current R;
3. delete a different BASE-positive S;
4. push again before a separate pull.

A safe second publication would have to assert live R while omitting proven S. That would need a
new attempt generation protecting S while the old generation still protects R. V9 deliberately
refuses that representation. Amendment 2 instead says the repository takes step D and carries its
last section.

That carry is normally the pending section installed while applying A. It omits R. Therefore:

- the acknowledged section never asserts R, so drop condition 3 cannot fire;
- BASE still holds R's `priorOid`, so condition 1 cannot fire;
- the authenticated head is at or beyond A's sequence, so condition 2 cannot fire;
- S remains absent, so every later attempt reaches the same whole-section carry.

This is not the disclosed current-branch exception. R can be non-current and the latch still
stands indefinitely.

The design's explanation that step D's existing trigger “already fires” is also false for the
protected pair in this fixture. Step D requires a BASE-positive ref absent from the strict read with
no L proof. R is present, so R does not satisfy the trigger; S is absent but has a passing proof.
An additional survivor gate could force the carry, but that is exactly the latch above. Without
that gate the second arm overwrites A, which is round-7 B4.

The one-field/one-generation choice cannot both preserve A and publish the R assertion plus S
omission. Alignment needs overlapping attempt generations, a staged representation that can first
retire A without publishing S's omission, or the per-ref wire model parked in design 201. The
current “refuse and carry” answer is not self-consuming.

### BLOCKER 2 — condition 3's written equality can clear an omission against an absent live ref

Evidence: design 200 §3.2c amendment 3 and §9.1; `src/cli/sync-git/plan.ts:174-183`,
`:1029-1055`; `src/cli/sync/push.ts:942-1009`; `src/cli/sync-state.ts:221-261`.

The prose says condition 3 applies when the acknowledged section **asserts** the ref at its live
value. Its executable expression is only:

```ts
committed.gitRepos[relPath].refs[ref] === live.refs[ref]
```

That expression is also true when both sides omit the ref. The missing presence check is
correctness-bearing.

A surviving attempt can have local R absent and BASE still positive when an authenticated omitting
head could not complete case (c)'s BASE retirement—for example, the deletion witness has a standing
refusal. Step D then carries the exact omitting pending section. If an unrelated file change causes
that section to be acknowledged, the literal condition evaluates `undefined === undefined` and
clears the attempt while composed BASE still holds `priorOid`. A local `git branch R X` before the
next apply is then again exposed to the accepted tombstone with live and logical BASE both X—the
round-6 destructive race C3 exists to close.

Condition 3 needs an explicit positive assertion, not JavaScript equality over two optional map
lookups. At minimum, require the acknowledged section to own a valid positive `refs[ref]` entry and
bind that assertion to the capture observation used for the attempt transition.

### MAJOR 1 — the ACK clear is specified at a site that has neither claimed derived input

Evidence: `src/cli/sync/push.ts:942-1009`; `src/cli/sync-git/plan.ts:25-71`, `:169-183`;
`src/cli/sync-state.ts:206-261`, `:326-358`; `src/cli/sync-state-store.ts:158-183`;
`src/engine/git/capture.ts:333-345`, `:353-378`.

At the ACK call site the code actually has:

- `committed.gitRepos`;
- `gitPlan`, including captured-vs-carried membership;
- pre-save `ackRecords`;
- `pendingAfterAck`; and
- `stateGit`, which is the requested BASE candidate from `gitBaseAfterCommit`.

It does **not** have `live.refs`. Ordinary capture puts the captured refs into its returned
`GitSection`; no separate live map reaches `GitPushPlan`. Resolution capture alone performs a
second stability read, and that local variable is discarded before the plan returns.

It also does not yet have the composed post-ACK BASE. `composeRepoBase` runs inside
`sourceRecord` while `saveStateSource` constructs each generation-CAS packet
(`sync-state.ts:221-229`) and again inside the transactional writer
(`sync-state-store.ts:165-180`). `stateGit` at `push.ts:944` is not that result.

The mechanism is repairable, but the ordering must be specified:

- carry the exact capture assertion/proven-candidate fact in `GitPushPlan`, or redefine condition 3
  over a value the plan already returns;
- evaluate the BASE half inside `sourceRecord` after composition, on every CAS recomputation, rather
  than precomputing a blanket null transition from stale caller state; and
- preserve the field when a newer record wins the `current.sourceSeq > sourceGlobalSeq` retention
  arm.

“Both inputs are already in the ACK loop” is false, and copying the existing
`resolutionReceipt?: value | null` lane without this derived merge is not sufficient.

### MAJOR 2 — step D is not total for a positive hidden BASE anchor

Evidence: design 200 §3.2b; `src/cli/sync-state-model.ts:285-300`, `:436-464`;
`src/cli/sync-git/plan.ts:141-153`, `:533-551`, `:601-605`, `:797-825`;
`src/cli/sync-git/apply.ts:691-735`.

V9 argues that `pending[rel] ?? base[rel]` cannot be absent because the trigger requires positive
`record.base.refs[R]`. The state model deliberately makes that implication false.

`RepoRecord.repoAbsent` and `removedKey` retain `record.base` as a non-authoritative provenance
anchor while `stateFromRepoRecords` hides it from
`state.lastSyncedManifest.gitRepos` (`sync-state-model.ts:455-458`). A normal remote repository
removal with a surviving local `.git` produces exactly this shape: apply deletes the projected
section, preserves BASE under carry authority, and records `removedKey`
(`apply.ts:691-718`).

If that leftover later changes identity, the push planner clears the removal memory and captures it
as a re-add (`plan.ts:601-605`). At that point `record.base.refs[R]` may be positive while
`base[rel]` and `pending[rel]` are both absent. A refused W/L therefore reaches step D with no
specified fallback. Passing `undefined` to `revertCapture` is not type-correct; treating it as an
outgoing section fails normalization; and resurrecting the hidden anchor would contradict the
repository-removal suppression.

The trigger and structural assertion must distinguish an active projected BASE from a hidden
provenance anchor. The safe natural disposition for a deferred re-add is to keep the repository
section absent, but that is not v9's stated “carry a section asserting exactly what record BASE
asserts” property. Add the suppression/removal gate and its re-add test.

### MAJOR 3 — step D's `deletion-pending` capture reason has no producer

Evidence: design 200 §§3.2b, 5.2, 13.4 item 10; `src/cli/sync-git/plan.ts:224-232`,
`:273-279`; `src/cli/sync-state-model.ts:130-167`.

Step D records its defer through `deferred`, and `plan()` turns that free-form reason into a typed
capture deferral via `captureReason`. That function has no `deletion-pending` arm. An exact
`"deletion-pending"` detail falls through to `other`; a detail containing the word “capture” matches
the artifact regex and becomes `artifact`.

The fourteen-site vocabulary inventory covers the apply-side deletion hold but misses this new
push-side producer. Consequently the standing-refusal residual that v9 promises to report under
`deletion-pending` is displayed as the wrong condition.

Make the step-D helper accept an explicit typed reason, or add an exact non-regex classification
before the existing heuristics. This also needs a capture-lane status test; the apply-side
`FollowProgress.blockers` test does not cover it.

### MINOR 1 — non-normative summaries still name the helper v9 warns implementers not to use

Evidence: design 200 header item 1, §6 cost table, §13.8 B1/M1; normative §3.2b.

The normative section correctly explains that post-capture step D must use `revertCapture` with the
explicit `pending[rel] ?? base[rel]` fallback and that `deferOne` can silently lose the disposition
after finalization or drop a forced section. The header, cost table, and round-7 disposition table
still call the replacement “today's `deferOne`.”

Use “the existing per-repository carry machinery” in summaries, or name `revertCapture` consistently.
The current split invites exactly the implementation mistake §3.2b is trying to prevent.

## Fresh-eyes conclusions

1. **Step D evaluation point:** viable on the active-BASE path. Capture returns the strict ref map in
   the section before normalization; W/L can run after `commitCapture`, and `revertCapture` updates
   both `out` and `finalizedOutgoing`, removes `captured`, clears authored config/repo-absence
   bookkeeping, and records the defer (`plan.ts:169-183`, `:987-1055`). The hidden-BASE case in
   MAJOR 2 is the totality exception.
2. **Accepted POST + lost ACK before a separate pull:** push entry can reconcile it by fetching and
   applying the authenticated head exactly as `resolutionReceipt` does
   (`push.ts:272-273` → `pull.ts:174-200`). The deadlock occurs after reconciliation, when
   amendment 2's carry prevents the assertion needed to clear the survivor.
3. **Post-ACK state actually in hand:** committed section, captured/carried plan membership, old
   records, pending-after-ACK, and an uncomposed requested BASE. No live ref snapshot and no final
   composed BASE exist at `push.ts:963-980`.
4. **Current-branch recreation:** real but acceptably disclosed as a non-destructive residual if
   that product decision stands. `git branch -D` first leaves R non-current, but ordinary agent churn
   can run `git checkout -b R X` during the unlocked L-to-POST interval; conjoined with an accepted
   POST and lost ACK save, it reaches the durable hold. Switching away from R is a genuine exit, and
   the synchronous keep-mine rider is a second exit once B4's survivor rule is repaired. It is a
   literal field wedge, but a reported, safe one with named exits—not a hidden destructive state.
5. **`sourceGlobalSeq` verification:** resolved. The sole non-test caller of `applyGitSections` is
   `applyPulledManifest`, which always passes its `sequence` (`pull.ts:363-372`). Its three
   production entry paths supply either `E2eeRemote.latest()`'s signed head
   (`e2ee-remote.ts:449-480`; `pull.ts:89-105`), the same authenticated head during receipt
   reconciliation (`pull.ts:174-200`), or `manifestAtSeq`'s verified historical sequence during
   chain repair (`chain-repair.ts:52-60`). Direct calls that omit the option are tests only. Make the
   value required for the new reconciliation rather than relying on the older fallback.

## Shortest remaining list

1. Replace amendment 2's wholesale survivor carry with a representation/lifecycle that can preserve
   the old protected generation while publishing the assertion that clears it and any newly proved
   omission.
2. Make B5's per-entry clear positive-assertion-only and place its live/candidate and composed-BASE
   derivation inside the generation-CAS-safe state transition.
3. Gate step D on active projected BASE (or define the hidden-anchor outcome), and produce the
   promised `deletion-pending` capture reason.

**NOT-ALIGNED.**
