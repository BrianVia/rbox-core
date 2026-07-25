# Design 200 v10 — Codex verification review, round 9

Date: 2026-07-25  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` v10,
`REVIEW-200-R2-CODEX.md` through `REVIEW-200-R8-CODEX.md`, and the current
implementation

## Verdict

**NOT-ALIGNED.**

The three requested closure lines are:

- **(1) Survivor latch / overlapping attempt generations — NOT-CLOSED.** The R-then-S
  fixture is repaired, but the type still stores only one generation per ref. A same-ref
  re-arm overwrites the older slot, and the cap fallback recreates the withdrawn survivor
  defer.
- **(2) Clear predicate and composition-boundary placement — NOT-CLOSED.** The
  transactional predicate and `gitPlan.captured` stand-in are sound, but the production
  legacy/degraded state writer drops the entire protection field and bypasses condition 1.
- **(3) Step-D gates and typed producer — NOT-CLOSED.** The typed producer and
  retiring-this-pass gate close; the hidden-anchor route does not preserve `removedKey`,
  so the next state save reprojects the supposedly hidden BASE.

`sourceGlobalSeq` is verified for every production entry path and should remain a required
parameter. No `gitPlan.captured` path was found whose acknowledged `refs` did not originate
in the strict capture read: forced capture, basis fallback, full recompaction and resolution
capture all preserve that invariant.

## New findings

### BLOCKER 1 — one slot per ref is not overlapping generations

Evidence: design 200 §3.2c, especially lines 1257–1269, 1328–1329, 1387–1398 and
1535–1539; §9.1 lines 3530–3561; `src/cli/sync/push.ts:322-381`,
`:846-851`, `:901-905`; `src/cli/sync-git/plan.ts:961-985`.

V10 calls amendment 2 “overlapping attempt generations,” but its representation is:

```ts
omitted: Record<ref, { priorOid, attemptedSequence, attemptedGitIncomingKey }>
```

For the same ref, a new arm executes `omitted[ref] = newEntry` and may raise
`attemptedSequence`. The newer entry wins; the older generation is irretrievable. This
directly contradicts amendment 1b's promise that finishing the entries matching the new
candidate and slot “leaves every older pair standing.”

The distinction is safety-bearing, not editorial. V10's own ACK-clear test requires a
reachable state in which an omitting section has been acknowledged while R is absent,
BASE remains positive after a refused retirement, and attempt A is retained
(lines 3545–3555). A later push can reconcile that state, then obtain a passing proof and
arm omission B for the same R after the earlier refusal clears. B overwrites A.

If B is definitely negative, amendment 1b clears the only stored entry. If B is uncertain
but did not land, the next signed head is below B's raised slot and condition 2 drops it.
In both cases A may have landed, but its protection no longer exists. A same-OID local
re-creation can therefore meet A's accepted tombstone while logical BASE is still positive,
reopening round-6 blocker 2.

The R-then-S test at lines 3530–3544 exercises only two different map keys and cannot catch
this. Alignment requires a per-ref generation collection, or a proved and tested rule that
forbids same-ref re-arm until the older generation has been safely discharged.

### BLOCKER 2 — the legacy/degraded writer drops the C3 field

Evidence: `src/cli/sync-state.ts:289-321`, `:326-356`;
`src/cli/sync-state-model.ts:373-420`; `src/cli/sync/pull.ts:379-412`;
`src/cli/sync/push.ts:622-631`, `:674-683`, `:1001-1013`;
`src/cli/sync-state-store.ts:165-183`.

The normal transactional route is correctly placeable:

- `saveStateSource` recomputes from fresh state after a generation rejection;
- `savePublishedRepoIntent` starts from `currentInput`, replaces only its enumerated
  apply/config fields, and therefore preserves the new lane;
- the inspected direct packet writers spread the current record and remain generation-CAS
  fenced.

The compatibility writer is different. `saveStateSource` takes `legacyState` on explicit
`forceLegacy`, an unsupported transactional write, or allowed stream replacement
(`sync-state.ts:332-351`). `legacyState` computes records and then deliberately writes
`repoRecords: undefined`, reprojecting only `gitDeferrals` and `gitPartial`
(`:289-321`). `repoRecordsForState` has no legacy projection from which it could reconstruct
`absencePublicationAttempt` (`sync-state-model.ts:373-420`).

This is a production path: degraded-mutex pull and all three push state saves pass
`forceLegacy`. It also bypasses the proposed condition-1 boundary in
`applyStateSavePacket`.

An accepted omission with a lost ACK can therefore leave a valid C3 entry, have a degraded
pull conservatively hold R for that one apply, and then lose the only durable protection in
the legacy save while BASE stays positive. A later apply can consume the accepted tombstone
before an asserting publication lands.

The lane must survive legacy persistence and condition 1 must run after legacy composition,
or Git publication needing C3 must fail closed whenever transactional persistence is
unavailable.

### BLOCKER 3 — the hidden-anchor route clears the suppression that keeps BASE hidden

Evidence: design 200 §3.2b lines 938–965 and §9.1 lines 3625–3634;
`src/cli/sync-git/plan.ts:599-604`; `src/cli/sync/push.ts:659-683`,
`:988-1013`; `src/cli/sync-state.ts:221-245`;
`src/cli/sync-state-model.ts:455-458`.

The new active-BASE gate avoids calling `revertCapture` with an undefined fallback, but its
claimed postcondition does not survive the state save.

The hidden-anchor fixture changes the leftover repository's identity. The planner therefore
deletes `removedMem[rel]` before capture (`plan.ts:599-604`). V10 then requires the refused
re-add's outgoing section to stay absent, while `record.base` remains unchanged and is not
projected back.

Both the commit-free bookkeeping save and the accepted-ACK save write the planner's
`gitReposRemoved` map. With `rel` absent from that map, `sourceRecord` omits `removedKey`;
carry composition still preserves the hidden `record.base`. `stateFromRepoRecords` now sees
neither `repoAbsent` nor `removedKey` and projects that BASE active again
(`sync-state-model.ts:455-458`).

On the next cycle, another proof refusal takes ordinary step D and carries the stale
pre-removal BASE section. Thus the test's required conjunction—BASE unchanged, outgoing
absent, and BASE not reprojected—cannot hold with the specified bookkeeping.

Discarding the re-add capture must also restore/preserve the removal suppression (or install
an equivalent explicit state), and the test must cover the subsequent no-op/ACK state save,
not only the planner output.

### BLOCKER 4 — the hard-cap fallback recreates the permanent survivor latch

Evidence: design 200 §3.2c lines 1399–1401 and 1426–1437;
`src/engine/manifest-validate.ts:23-24`.

V10 says no survivor gate exists anywhere, then adds one at the 512-entry cap: if a new arm
would exceed `MAX_REF_TOMBSTONES_PER_REPO`, do not arm and take step D's whole-repository
defer.

Take 512 retained entries whose refs have been re-created non-current, plus a newly
deleted/proved 513th BASE ref S. The candidate that would assert the 512 live refs and omit S
is the condition-3 exit. The cap rule instead carries the prior omitting section:

- condition 1 remains false because BASE keeps the 512 prior OIDs;
- condition 2 remains false because the authenticated head is past their slots;
- condition 3 cannot fire because the carry asserts none of them;
- S remains absent, so every cycle proposes the same forbidden 513th arm.

This is round 8's permanent non-current latch at the advertised bound. It also asks to “take
step D” when the ordinary step-D predicate is false: S has a passing proof. The design needs
a non-latching overflow disposition and a cap test.

### MAJOR 1 — the structural assertion contradicts the scoped-ref rule

Evidence: design 200 §3.2b lines 1071–1080 and 1135–1146; §9.1 lines 3595–3600
and 3641–3645.

The scoped partition correctly says that `refScope !== "all"` omissions are inert on the
receiver and publish without step D or an L proof. The normative structural pin and its test
then universally require that no outgoing section omit a BASE-positive head without a
same-push proof.

Those requirements are mutually unsatisfiable for the scoped fixture. Qualify both the
structural assertion and its test with effective `refScope === "all"`.

### MINOR 1 — the test plan requires executing withdrawn machinery

Evidence: design 200 §9.1 lines 3539–3544.

After testing v10's R/S merge, the row requires running the fixture “against v9's rule” and
asserting that the withdrawn survivor defer latches forever. The v10 implementation should
not contain that rule, so this is not an executable implementation requirement.

Keep the positive v10 non-latch assertion. If the historical counterexample is valuable,
make it a pure model test outside the mandatory implementation matrix.

### MINOR 2 — the completed reason inventory still has the v9 count

Evidence: design 200 header lines 100–105, §3.6 line 2176 and §5.2 lines 3017–3019,
3047–3049.

V10 adds the capture-lane producer as the fifteenth site, and the table contains it, but the
“complete” inventory is still described in multiple places as fourteen sites plus five tests.
Update the totals so the prose and table agree.

## Fresh-eyes conclusions

1. **Same-ref merge semantics:** the newer arm wins and the older attempt is lost. The
   cross-ref R/S repair does not generalize to two generations of R.
2. **Every state writer:** transactional state sources, direct CAS writers and
   `savePublishedRepoIntent` can preserve the lane; `legacyState` cannot.
3. **`gitPlan.captured` as strict-read evidence:** **CLOSED.** `captured` is added only by
   `commitCapture` from `capturePlannedGitSection` (`plan.ts:169-172`, `:961-970`).
   Forced capture only changes incremental selection; basis fallback uses the same read;
   recompaction calls capture again and rereads refs; config embedding and normalization do
   not rewrite `refs`; `revertCapture` removes the membership.
4. **Step-D producer:** **CLOSED.** An optional typed reason on the existing deferral item
   composes with both carry helpers and leaves the config identity tags and regex-classified
   producers unchanged.
5. **Retiring-this-pass gate:** **CLOSED.** `plan.ts:813-817` exits before capture for a
   genuinely gone repository. The hidden-anchor failure is the separate removal-memory
   transition above.
6. **`sourceGlobalSeq`:** **CLOSED.** The sole production caller of `applyGitSections` is
   `applyPulledManifest` (`pull.ts:363-372`), and its ordinary pull, receipt-reconciliation
   and historical-repair entry paths all supply authenticated sequences. Keeping the new
   reconciliation parameter required is correct.

## Shortest remaining list

1. Preserve multiple same-ref attempt generations, and give cap overflow a non-latching
   disposition.
2. Preserve/reduce the field in the legacy writer or fail closed when transactional state
   persistence is unavailable.
3. Preserve hidden-anchor suppression when a re-add capture is discarded.
4. Qualify the structural pin for scoped refs and remove the withdrawn-rule test.

**NOT-ALIGNED.**
