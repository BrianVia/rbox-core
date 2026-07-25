# Design 200 v7 — Codex alignment review, round 6

Date: 2026-07-24  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` v7, plus
`REVIEW-200-R2-CODEX.md` through `REVIEW-200-R5-CODEX.md`

## Verdict

**NOT-ALIGNED.**

The structural re-frame is materially better than v6: ACK-time retirement removes the
unbounded `BASE absent / wire X` interval, and the accepted section is available to the ACK
composer. I found no stale-ACK or replay path through the proposed six K checks.

Two blockers remain. First, a failed L proof has no safe outgoing-section disposition: the
capture has already omitted the ref, and the existing advertised-diff author can still put a
tombstone on that omission without the witness. Second, the landmine sweep calls R4 B1 N/A
even though v7 both admits the same-OID ABA and has a simpler local-recreation instance of it.

## Findings

### BLOCKER 1 — an L refusal cannot “drop R from the witnessed set” without still publishing R's omission

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:635-643`,
`:709-727`, `:2258-2283`, `:2304-2310`, `:2525-2557`;
`src/engine/git/capture.ts:257-260`;
`src/cli/sync-git/publisher-tombstones.ts:54-59`, `:108-122`, `:183-190`;
`src/cli/sync-git/plan.ts:533-551`.

The failure state is ordinary and reachable:

1. `BASE[R] = X`, local R is absent, and capture's strict read records R absent.
2. W admits R, but L is refused because R is locked, HEAD moved, or the transaction failed.
3. Per §3.2, the planner merely drops R from the witness and “leaves it exactly as today.”
4. The already-captured candidate still omits R. With no pending section, the normal plan can
   publish that whole local capture.
5. `normalizePublishedGitSection`'s existing advertised-diff loop is independent of the new
   witness input. If `advertised.refs[R] = X`, it authors exactly the tombstone at X that T and
   the kill switch claim only a successful W/L may author.
6. K correctly refuses to retire BASE because there is no `absentBranchProofs[R]`, but the wire
   nevertheless carries the omission and tombstone. A follower at live/BASE X can prune R.

This also breaks the rollout contract. Turning `RBOX_GIT_ABSENCE_CAPTURE=0` off suppresses the
new witness-backed authoring loop, but not the existing loop at
`publisher-tombstones.ts:108-122`; therefore the switch cannot currently promise that it
“can only stop new deletions from being published.”

There is no obvious per-ref repair inside the stated model:

- `deferOne` can safely reuse the whole pending or BASE section, but that suppresses all 23
  otherwise-valid deletions and violates §9.4's per-ref-independence AC.
- Restoring X only inside the outgoing candidate makes a hybrid captured/carried section,
  contradicting §9.2's “never a mixture” assertion and re-entering the P4/design-201 bundle,
  basis, and ACK-provenance landmines.
- Publishing the candidate without a tombstone still publishes an omission for which the
  design says no authority was obtained.

The design must name a coherent whole-section outcome for every W/L refusal and make **all**
branch-tombstone authoring conditional on the corresponding successful authority. It must
then reconcile that outcome with both “one failed ref does not suppress the other 23” and the
P4 cut. “Drop it from the witness” is not an outgoing representation.

### BLOCKER 2 — R4 B1 is still reachable; the post-L local same-OID case is even simpler than the recorded peer race

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:1352-1362`,
`:1368-1387`, `:2188-2190`, `:2969-2977`, `:3094`;
`src/engine/git/keep-pins.ts:188-204`, `:341-359`;
`src/cli/sync-git/tombstone-attestation.ts:96-112`.

The sweep labels R4 B1's same-OID ABA **N/A** at `:3094`, but v7 explicitly admits a
same-OID destructive race at `:1377-1387` and `:2969-2977`. The old unbounded intent latch is
gone, but the failure class is carried as a bounded accepted residual, not made
inexpressible.

There is also a local instance that needs no peer prune/re-create/publish round:

1. L verifies R absent and commits, releasing `R.lock`.
2. A local Git process re-creates R at the same X before POST/ACK.
3. The POST is accepted, but the ACK state CAS is lost, so durable BASE remains X.
4. The next pull sees the accepted omission and tombstone X while live R and logical BASE are
   both X. `checkTombstoneAttestation` therefore authorizes the prune and deletes the
   legitimate re-creation.

Section 3.6(d)'s statement that attestation refuses because `live != tombstoned OID` is false
for the case it expressly says includes recreation “at X.” It refuses after a successful ACK
because logical BASE is null, not because live differs. If that ACK save is the crash point,
both live and BASE still equal X and the destructive authorization succeeds.

This is not a defect in Git's L primitive. On the fleet floor, Git 2.46 specifies that
`verify R <zero-oid>` requires R not to exist, and `prepare` creates locks for all queued
references. The repo runner does hold those locks through its callback. But `commit` ends the
transaction, and the code returns before T, POST, and K. See the
[Git 2.46 `update-ref` transaction contract](https://git-scm.com/docs/git-update-ref/2.46.0).

Alignment requires either closing this race or explicitly carrying R4 B1 as the narrowed
accepted residual, broadening residual 8 to include local same-X recreation, correcting
case (d), and adding the missing lost-ACK/local-recreation test. An admitted reachable shape
cannot remain in the “N/A because the state does not exist” bucket.

### MAJOR 1 — the reused `local-commits` value has no path to the promised deletion-hold presentation

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:1251-1259`,
`:2160-2165`, `:2352-2358`, `:2559-2567`;
`src/cli/sync-state-model.ts:186-205`;
`src/cli/sync-git/follow.ts:718-724`, `:834-846`, `:1030-1037`;
`src/cli/sync-git/apply.ts:749-754`, `:1447-1450`;
`src/cli/sync-git/held-skip.ts:37-40`, `:56-64`;
`src/cli/status-view.ts:287-296`.

The persisted compatibility choice is reasonable, but the design specifies only
`classifiedHolds.set(R, "local-commits")` and persistence of that same value. Today:

- `follow` converts that value directly into a ref-plane typed blocker;
- `apply` derives the durable deferral reason directly from `heldRefs`;
- status renders it as “Local commits changed here”; and
- held-skip and composer-causality logic allowlist the literal `local-commits` reason.

Consequently a user who deleted a branch will be told that local commits changed. The new
`ref-plane` presentation promised in §9.6 has no producer or sideband that survives from
classification to `setDeferral`.

Simply changing the typed blocker to the new reason is not enough: it would make
`heldBlockersAllowSkip` false and stop matching `missing-branch-proof`, changing precedence
and held-skip behavior. Specify the ephemeral deletion-hold signal through
`FollowProgress`/`heldReasonOf`, its copy and precedence, and its interaction with
`heldBlockersAllowSkip` and `blockersAfterComposer`, while retaining the old persisted value
for downgrade compatibility.

### MAJOR 2 — case (b)'s keep-mine exit names an unreachable manual-authority path

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:1312-1336`,
`:2173-2180`, `:2962-2967`;
`src/cli/git/resolve-command.ts:603-614`, `:651-665`, `:755-775`, `:839-855`;
`src/cli/sync-git/plan.ts:754-775`, `:1020-1027`;
`src/cli/sync/push.ts:937-944`.

The shape is reachable today and `keep-mine` refuses it by name at
`resolve-command.ts:658-665`. v7 does provide an intended same-design exit, so it need not wait
for design 173, but the mechanism stated in the design cannot execute:

- `keep-mine` enters its own early branch, builds a resolution rider, calls
  `pushManifest`, and returns.
- The manual branch protocol is initialized only for `take-theirs`.
- `planManualBranchTransition` is below the keep-mine return and is therefore unreachable
  for this verb.

The resolution rider already bypasses ordinary P1b carry and forces a wholly local capture.
The viable v7 exit is therefore: remove the refusal, obtain W/L for the resolution capture,
author the X tombstone, pass its proof in `absentBranchProofs`, and retire BASE through
**publisher-ack** when that keep-mine push is accepted. It must never tombstone pending Y.

Revise §3.6(b), residual 7, and §9.1's test to name and exercise that publisher-ACK path.
Removing only the refusal while testing the unreachable `manual` composer arm does not prove
an exit.

### MINOR 1 — K is safe at its sole caller, but “six checks” overstates the composer's independent validation

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:665-681`,
`:2271-2278`;
`src/cli/sync/push.ts:961-979`, `:988-1009`;
`src/cli/sync-git/base-composer.ts:297-306`, `:356-367`;
`src/cli/sync-state.ts:206-229`;
`src/cli/sync-state-store.ts:143-170`.

The important safety question passes:

- the ACK loop has `committed.gitRepos[relPath]`, so it can inspect the exact accepted
  section's `refs`, `refScope`, and `refTombstones`;
- `incomingKey` is recomputed from that section;
- the proof and state values enter the same `saveStateSource`; and
- stale/replayed sources are fenced by stream, nonce, sequence, repo generation, and
  `sourceRecord`'s whole-record retention of a newer `sourceSeq`.

I found no replay that can retire a later BASE X: a stale packet loses the CAS or is retained
behind the newer record, and an exact `previousRefs[R] === priorOid` check still has to pass.

The wording should nevertheless be tightened. Today's publisher-ACK composer checks only
that `incomingKey` is non-empty; its equality to the accepted candidate is guaranteed by the
sole caller. Likewise `lockedProof.effectiveRefScope` is populated directly from the same
section and is not independent evidence. The §9.2 table enumerates the new proof checks but
omits malformed lineage, identity, source sequence, incoming key, and a mismatched locked
scope. Either state these as constructor invariants and freeze the sole caller structurally,
or add the missing negative rows.

### MINOR 2 — §9.4 retains an A-artifact assertion that contradicts v7

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:630-633`,
`:2153-2155`, `:2297-2310`.

The 24-head test still says “one A artifact each.” v7's defining property is zero capture-side
artifacts, and §9.1 correctly asserts that none is created. Change the §9.4 expectation to
zero A/Z artifacts for all 24 deletions.

### MINOR 3 — the landmine totals are arithmetically wrong

Evidence: `docs/design/200-worktree-lifecycle-resilience.md:3070-3107`.

Counting grouped R3 B3–B6 as four findings, the table marks:

- 11 N/A;
- 12 moot; and
- 11 carried.

It claims 11/13/10. The total remains 34, but the class totals and the request for “the prior
10 carried findings” do not match the rows. I audited all 11 rows actually labeled carried
below.

## Landmine-table spot check

I prioritized the N/A claims and checked eleven rows:

| Finding | Result | Reason |
|---|---|---|
| R2 B2 | N/A is correct | No capture-side artifact or pre-ACK BASE retirement remains to recover. |
| R3 B2 | N/A is correct for the old A-prime/A-double-prime inversion | The unbounded retire-then-publish state is gone; the bounded lost-ACK ABA is a different carried residual. |
| R3 M1 | N/A is correct | No capture-side receipt projection consumes `priorOid`; case (c)'s apply artifact remains separate. |
| R3 M2 | N/A is correct | No `local-absence` proof enters the state-CAS revalidation filters. |
| R4 B1 | **N/A is false — blocker** | The design admits a bounded same-OID ABA, and local same-X recreation plus lost ACK reaches it directly. |
| R4 B3 | N/A is correct for the old claim | The nonexistent continuous A-prime/state-CAS lock is gone. L's narrower L-to-K TOCTOU is real and must be described accurately. |
| R4 m1 | N/A is correct | Capture-side A-to-Z reasoning is removed. |
| R5 B1 | N/A is correct | There is no armed omission reconciler that must run before apply. |
| R5 B2 | N/A is correct | The ordinary held path retains the whole incoming section at `apply.ts:1447-1450`; there is no v6 early return. |
| R5 B3 | N/A is correct only for the old BASE-CAS bug | No refused A-prime lock can flow into a BASE CAS, but v7's refused-L outgoing-section bug is BLOCKER 1. |
| R5 M1 | N/A is correct | The proof can stay on the in-memory ACK authority; the exact committed candidate is available in the same state source. |

## Prior carried findings

The document says ten, but its table labels eleven findings carried. One line on each:

1. **R2 B1 — P1b exact binding:** correctly carried in the successful-proof path by requiring
   `record.base.refs[R] === pending.refs[R]`.
2. **R2 B3 — careful in-place restore:** correctly retained as a named accepted residual.
3. **R2 M1 — stable strict-read API:** correctly carried by the single `gitStatus` result/cause
   contract.
4. **R3 M3 — incompatible `gitStatus` fault contracts:** correctly carried by preserving the
   original thrown `cause` while making status collection non-rejecting.
5. **R4 B2 — exact tombstone authorship:** correct on a successful witness, but not globally
   handled until BLOCKER 1 prevents the legacy advertised loop from authoring after W/L refusal.
6. **R4 B4 — stop-authoring kill switch:** not yet correctly handled; BLOCKER 1 leaves the
   pre-existing advertised-diff author active when the proposed capture switch is off.
7. **R4 B5 — whole pending retention:** correctly carried; ordinary apply retains `remoteSec`
   and records the per-ref split separately.
8. **R4 M1 — push-side artifact reader producer:** correctly narrowed to the named
   current-lineage artifact/disposition reader.
9. **R4 M2 — design-201 deletion gate:** correctly amended in design 201 to treat
   publisher-ACK removal and relayed omissions as landmines.
10. **R4 m2 — `gitStatus` completeness:** correctly carried in §9.6's two-path, exact-cause
    matrix.
11. **R4 m3 — design-201 held-ref AC:** correctly carried; design 201 now says the held ref
    publishes no replacement value or tombstone.

## Shortest remaining list

1. Specify a safe outgoing whole-section disposition for every failed/disabled W or L, gate
   the legacy advertised tombstone loop on the same authority, and reconcile that with the
   23-of-24 per-ref AC without reintroducing a hybrid/P4 section.
2. Reclassify or close the surviving same-OID ABA; include the local recreation between L and
   ACK plus lost state CAS, correct case (d), and test it.
3. Define the deletion-hold reason's end-to-end ephemeral data path, copy, precedence, and
   held-skip/composer behavior while preserving the old persisted value.
4. Put case (b)'s keep-mine exit on the actual resolution-push/publisher-ACK path and test the
   proof/tombstone/retirement there.

Until those are specified, **NOT-ALIGNED**.
