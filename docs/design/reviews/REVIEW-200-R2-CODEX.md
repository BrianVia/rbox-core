# Design 200 v3 — Codex final alignment review

Date: 2026-07-24

Verdict: **NOT-ALIGNED**

The six corrected citations in §13 are accurate, and `04c2aff8` first appears in
`v1.6.8` as claimed. The prior findings are not all closed, and the new pin and
partial-ACK machinery introduces fresh safety holes.

## Prior findings

### Blockers

1. **CLOSED — Q3 no-pin premise.** §3.7 now puts a tombstone-class keep pin on the
   deleting device, so single-device, concurrent-delete, never-delivered, and old-follower
   cases no longer rely on a follower prune for recovery; the crash implementation has a
   separate new blocker below.
2. **CLOSED — lossy ref read.** §3.3a specifies the required `code === 1` plus empty-stderr
   distinction and applies it to the plan-time and locked absence proofs and both
   `src/engine/git/capture.ts` reads; the cited existing API analogy is inaccurate and
   needs the new plumbing called out below.
3. **CLOSED — P4 provenance laundering.** §4.4 constraint 6 splits captured
   `advertisedRefs` from `carriedRefs`, requires a disjoint complete partition, and keeps a
   carried ref at its prior BASE without minting an origin.
4. **CLOSED — P1 control-flow placement.** §3.6a moves reconciliation above
   `apply.ts:873`, ends the apply pass with `result: "reconciled"`, and relies on the
   same-cycle push so the section still in hand cannot recreate the retired branch.
5. **NOT-CLOSED — provenance does not prove cause of absence.** With the ruled guarded
   breaker disabled for `N < 20`, a refs-only in-place restore in a repository with no
   `packed-refs` and a retained nonempty `logs/HEAD` passes both new heuristics and can
   publish every missing head as deletion; the design explicitly admits that no breaker
   covers this range.
6. **CLOSED — P3 false-positive/destructive boundary.** The apply-then-revert match is
   retained, but `content-equivalent` is barred when the incoming target is absent or the
   transition is non-fast-forward, with a real-loop disjointness test, so it cannot grant a
   destructive transition.
7. **NOT-CLOSED — accepted-ACK state machine.** `partially-superseded` is named, but its
   rules are internally inconsistent: carried refs remain at prior BASE while
   `pendingSupersessionAckConverges` still requires the composed BASE to deep-equal the
   candidate containing their pending values; the hybrid BASE also advances refs while
   retaining an older bundle/pack chain that may not cover those refs.

### Majors

8. **CLOSED — P2/P3 wedge claim.** §§4.2, 4.5, and 5 now say P2 only removes repository
   deferral/repeated follow cost, P3 only reduces cascades, and P4 alone ungags unrelated
   capture.
9. **NOT-CLOSED — rollout/rollback.** The dependency and switch text is improved, but the
   claimed safe redundant apply inherits the invalid hybrid BASE and under-covered
   incremental pack chain from finding 7, so the reverse migration is not yet safe.
10. **CLOSED — old-client behavioral skew.** The floor is verified as `v1.6.8`;
    `v1.6.6:follow.ts:556-565` does ancestry-only hold and has no tombstone-attestation
    waiver. The claim that a stale device which later also deletes the ref must carry
    forever is inaccurate, but does not change the version floor or primary skew behavior.
11. **NOT-CLOSED — recovery discoverability.** `KeepPinOrigin` remains only
    `{ref, episode, time, class}` (`keep-pins.ts:47-52`): it cannot distinguish own deletion
    from follower prune, and the already-GC'd `pinned:false` result has no specified
    persisted field or sidecar-only write path for `rbox git deleted` to enumerate.
12. **CLOSED — doctor privacy boundary.** The new worktree paths are held in a typed
    local-only projection excluded from `checks` and `buildDiagnosticsBundle`, while the
    uploaded projection contains no path text; the pre-existing raw-`checks` issue is
    explicitly out of scope.

## New findings

### BLOCKER — P1b can supersede a pending value the receipt does not witness

P1b admits an absent pending head when any current-lineage A/settled-absence receipt exists,
but never requires `receipt.priorOid === pending.refs[R]`. If BASE/local was `X`, pending is
another writer's `Y`, and this device deletes `X`, its A receipt for `X` can authorize a
candidate omitting `Y`, destroying a value this device never held. Bind the receipt to the
exact pending predecessor or carry `Y`.

### BLOCKER — pin+A crash recovery still misses the unchanged path

After the combined pin+A transaction commits but before the BASE CAS, §3.7 says the next
cycle uses the existing A-recovery path. The actual protocol preparation begins below the
unchanged shortcut, while §3.6a rule 3 excludes an existing A from new absence capture.
The new above-shortcut reconciliation step does not specify landing an existing owning A,
so positive BASE can remain wedged after exactly the crash point the table claims to heal.

There is a second unsupported crash claim: `prepareKeepPins` fsyncs the origin sidecar
before returning ref-transaction lines (`keep-pins.ts:612-618`). A crash before the
prepared transaction leaves an origin but no pin; `keep-pins.ts:425-428` is only generic
filter logic, not an existing reconciliation path, and has no production caller.

### BLOCKER — P4 partial settlement is not closed under ACK failure or incremental capture

Three independent failures remain:

- Keeping carried refs at prior BASE makes the existing deep-equality ACK convergence test
  fail whenever a pending carried value differs.
- Advancing captured BASE refs while retaining the prior `bundleSha`/`packChain` lets the
  next incremental capture exclude those new basis tips even though the retained chain
  does not contain them (`incrementalCapturePlan`, `shared.ts:135-141`).
- If the remote ACK lands but the local CAS is lost, the next pull sees the merged section
  as `remoteSec`; current apply writes it into `pending` (`apply.ts:1426,1448`) and binds
  partial/deferral state to its key, contradicting the claim that the original pending and
  `gitIncomingKey` never move. No durable partial-settle receipt or self-echo recovery rule
  is specified.

### MAJOR — strict-read stderr taxonomy lacks a stable API contract

The required algorithm is sound, but the cited precedent is not “this exact pattern”:
`readLocalGitConfigEntries` (`shared.ts:261-268`) checks only `code === 1`. `gitRaw` does
not define a typed, normalized rejection carrying raw stderr across both execution paths;
the cited `shared.ts:177` branch attaches `code` and folds stderr into `Error.message`.
Specify a structured `{code, stdout, stderr}` failure (or a dedicated status-returning
runner) before implementing the load-bearing empty-stderr distinction.

### MAJOR — carried absence has no representation

`carriedRefs: Record<string,string>` plus “union equals `Object.keys(section.refs)`” cannot
represent a held ref whose pending value is absence. That ref is not in the outgoing
section, yet partial settlement must still classify it as carried to preserve its prior
BASE and provenance. Use an explicit nullable/absent carried set and test this row.

### MAJOR — `pinned:false` and deletion provenance have no persisted shape

The missing-object path promises to record `pinned:false`, and `rbox git deleted` promises
to say whether the event was a local deletion or follower prune, but the unchanged origin
schema encodes neither fact. Skipping `prepareKeepPins` skips the only origin write;
including its returned create line fails on the missing object. Specify a durable event
record/sidecar schema and its crash ordering.

### MAJOR — tombstone-pin expiry can starve forever

The production caller is only after a successful capture. A repository that captures its
deletion once and then remains unchanged for more than 90 days need never capture again,
so its tombstone pins are never swept and the promised window remains unbounded. The
daily gate must run from a path reached by unchanged repositories.

### MAJOR — Q2b remains normatively contradictory

§3.5 and §12 still label the guarded form “STILL OPEN,” §9.4 still says “whichever the
founder rules,” and §7 invariant 4 states an unguarded fractional leg, while §13 says the
founder ruled the guard. The implementation predicate must be stated once as
`n >= 25 || (N >= 20 && n * 4 >= N)` and the stale alternatives removed or marked
historical.

## Final

**NOT-ALIGNED.** Shortest blocking list:

1. Bind P1b absence authority to the exact pending OID.
2. Make existing-A/pin crash recovery run above the unchanged shortcut.
3. Close the small-repository restore hole or require human confirmation for that range.
4. Redesign P4 partial settlement so ACK convergence, pending-key recovery, and pack-chain
   coverage are all valid together.
