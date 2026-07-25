# Design 200 v13/v13.1 — Codex verification review, round 12

Date: 2026-07-25  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` at
`82d7bb37` (v13.1), `REVIEW-200-R2-CODEX.md` through
`REVIEW-200-R11-CODEX.md`, the design-branch implementation, and shipped
`origin/main` commit `2a7f821e` (PR #448)

## Verdict

**NOT-ALIGNED — no class-A mechanism defect, but three class-B claim
corrections remain.**

The machinery remains sound. The reachable current-branch route pins the exact
old tip with permanent human provenance in its destructive post-HEAD
transaction; the non-current route uses the existing tombstone-prune
transaction. The durable-state trigger is the right property, family (ii) is
real, the two false equalities are gone, and the switch-enabled qualification
is now present at both universal sites. PR #448 also fixes the state-directory
durability bug in shipped code with the required ordering.

The remaining problems are claims, not mechanisms:

1. `savePublishedRepoIntent`'s `forceLegacy` arm exists as a dormant option but
   no repository caller selects it. Recovered checkout journals do not reach it, and
   degraded plan/apply deliberately use `land: false`. The design's “four
   arms” claim and four-arm test matrix are therefore false.
2. `via-desktop-ubuntu` has no tracked workspace, non-test daemon runtime, or
   current daemon log. The fleet conclusion is supported, but “current daemon
   logs of every fleet host” is not.
3. PR #448 is already merged as `2a7f821e`; the v13.1 paragraph still says
   “Once merged.”

Under the requested classification:

- **Class A — mechanism defect:** none.
- **Class B — false claim:** one major and two minors, below. These must be
  corrected before alignment.
- **Class C — truthfully stated risk whose acceptability is a founder ruling:**
  the degraded-unlocked policy question stated at the end. It is not a review
  finding.

## Round-11 dispositions

### 1. Current-branch consumption — VERIFIED, except no longer misstated

The disposition is correct.

`live.currentRef` is excluded from `tombstoneAuthorized`
(`follow.ts:773-778`) and from the ordinary candidate loop
(`follow.ts:834-835`), but not from deletion. The checkout path separately
reads the current ref and its old/incoming values (`follow.ts:1247-1250`) and
plans deletion for
`oldOid && !newOid && effective.deleteAbsent`
(`follow.ts:1273-1294`).

That route calls `prepareDisplacementPins` (`follow.ts:1260-1266`).
`prepareDisplacementPins` forcibly includes `oldOid` when reflog reachability
did not already include it (`keep-pins.ts:745-760`), and
`humanDisplacementOrigin` assigns `class: "human"`
(`keep-pins.ts:149-155`). The pin lines are passed as
`extraTransactionLines` to the same branch plan as the A artifact and delete
(`follow.ts:1280-1293`; `branch-transition.ts:107-119`). When HEAD switches
away, that whole plan becomes the post-HEAD transaction
(`follow.ts:1295-1297`), which prepares, re-proves, and commits all lines
together (`checkout-txn.ts:872-903`).

The non-current route remains distinct: an attested ref enters
`tombstoneAuthorized`, calls `prepareTombstonePrunePins`
(`follow.ts:947-950`), and receives a tombstone origin for the authorized tip
plus human origins for other reflog OIDs (`keep-pins.ts:635-653`).

I independently reran the cited fixture:

```text
bun test src/cli/sync-git/follow.test.ts \
  --test-name-pattern 'design 165 all-scope checked-out branch deletion'

2 pass
0 fail
13 expect() calls
```

The recovery bound therefore survives. The current-ref member is reachable,
exact-OID pinned, permanently human-originated, and atomic with its delete; it
is not a tombstone-prune member.

### 2. Trigger changed from enumeration to defining property — VERIFIED

The normative trigger at design lines 1496-1501 is the correct form:

> the BASE retirement carried by a server-accepted publication's publisher ACK
> is not present in the durable local state that this device's next applying
> pull reads

That is the state predicate on which destructive self-consumption depends.
Attestation requires live OID = tombstoned OID = logical BASE OID
(`tombstone-attestation.ts:102-111`). If the ACK retirement is present in the
state read by the pull, logical BASE is absent and the same-OID re-creation is
refused. If it is missing, the equality gate can authorize, subject to the
other explicitly stated conjuncts.

Family (i)'s examples are correctly non-exhaustive and the newly named members
are real:

- the accepted-response/lost-response throw occurs before the ACK save
  (`push.ts:825-839`);
- `.rbox` creation and locked `loadRawState` can throw before the atomic write
  (`sync-state-store.ts:119`, `:137`);
- `busy`, stream/nonce/owner loss, exhausted recomputes, and write failures
  propagate through the one ACK save (`sync-state.ts:339-358`;
  `push.ts:1000-1025`).

Because examples are no longer the definition, another cause would amend the
examples rather than falsify the trigger. The claim is no longer vulnerable to
an incomplete failure-mode list.

### 3. Family (ii), per-window non-recurrence, rate, and surfaces — PARTLY VERIFIED

The important part is real. `saveStateSource` constructs `legacyState` from the
caller's `snapshot` (`sync-state.ts:289-321`) and sends it to
`saveStateUnsafeLegacyOrTest` on its production legacy fallbacks
(`sync-state.ts:332-351`). `writeWholeStateUnsafe` writes the whole file
without a state lock, generation CAS, or durable re-read
(`sync-state-store.ts:330-376`).

`sourceRecord`'s newer-`sourceSeq` retention is not a guard. Its `current`
record comes from the stale caller snapshot (`sync-state.ts:206-215`,
`:265`, `:289-291`), so the newer landed ACK is absent from the comparison.
The legacy projection also discards the state nonce/revision fence
(`sync-state.ts:316-318`). A stale writer can therefore finish after an ACK,
restore positive BASE, and reopen the window.

The resulting qualifications are honest:

- non-recurrence is **once per window**, not absolute;
- ordinary concurrency is sufficient on a degraded-unlocked workspace;
- `locking-health.json`, `rbox status`, and `rbox doctor` expose the condition
  (`sync-mutex.ts:120-151`; `status-cmd.ts:441`;
  `status-view.ts:666`; `doctor-cmd.ts:428`);
- the consequence class remains the same: exact-match refs only, each consumed
  once per fresh full precondition, each exact tip atomically pinned, with the
  file plane untouched.

The claimed **fourth production arm is false**, however. See class-B major 1.
There are three production `saveStateSource` arms relevant to this statement:
explicit degraded `forceLegacy`, `unsupported`, and allowed stream
replacement. The separate `savePublishedRepoIntent` option is not reached by
recovered checkout journals.

### 4. Post-rename durability and PR #448 — VERIFIED IN SHIPPED CODE

Round 11's diagnosis and v13's stronger diagnosis were correct on the design
branch: `writeFileAtomic` syncs the temp bytes and renames, while the following
conditional sync targeted the marker's parent, not `state.json`'s parent.

Shipped `origin/main` commit `2a7f821e` fixes the ordering:

1. `writeFileAtomic(statePath(...))` returns after the rename;
2. `fsyncDirectory(path.dirname(statePath(root)))` runs;
3. the incarnation marker is removed; and
4. if the marker existed, its own parent is synced.

These are `sync-state-store.ts:215-232` at `2a7f821e`. The same commit adds the
missing state-parent sync after the other three `state.json` publications:
`writeWholeStateUnsafe` (`:369-370`), `ensureTelemetryBindingId`
(`:410-414`), and `installGenesisResetStateUnderHeldLock` (`:451-452`).
The genesis marker publication also syncs its own parent (`:453-458`).

The syscall-order regression test asserts:

```text
rename state.json
fsync <state.json parent>
unlink marker
fsync <marker parent>
```

I ran the shipped test file at the exact merge commit:

```text
bun test src/cli/sync-state-store.test.ts

3 pass
0 fail
9 expect() calls
```

The design correctly does not depend on the fix: its state predicate also
covers an older binary or a power loss before the new parent sync. The only
remaining problem here is the stale future tense “Once merged”; see class-B
minor 2.

### 5. Scoped carry and BASE/advertised equalities — VERIFIED CLOSED

Both v12 equalities are gone and the replacements match the code.

Apply stores `remoteSec` wholesale in `pending` while composing BASE
independently and fail-closed (`apply.ts:1416-1428`, `:1437-1450`).
`deferOne` republishes those pending bytes unchanged (`plan.ts:533-540`).
Thus a scoped carry can omit `R` while BASE remains positive.

The safety argument is correctly inertness, not equality.
`effectiveRefs` gives a scoped section `deleteAbsent: false`
(`follow.ts:608-614`), and BASE/live keys enter the candidate set only when
`deleteAbsent` is true (`follow.ts:713-716`). The omitted scoped ref cannot
reach a destructive branch plan or attestation regardless of how its bytes
compare with BASE. The remaining universal is correctly only “no freshly
captured `dir` section is scoped,” with the scoped-carry counterexample stated
explicitly.

Likewise, one ACK packet provides atomic co-publication, not semantic equality.
`advertised` takes the committed section verbatim (`push.ts:962`), while BASE
passes through `composeRepoBase`. In the current tree
`absentBranchProofs` does not exist, so an omitting publisher ACK retains the
prior branch BASE (`base-composer.ts:356-362`) while `advertised` omits it. The
§9.6 row now requires exactly what exists: co-publication, a positive
switch-off divergence, and a separate wire-vs-BASE residual row for both
trigger families.

### 6. Structural pin and invariant 10 — VERIFIED CLOSED

The structural assertion is now explicitly prefixed with
“While `RBOX_GIT_ABSENCE_CAPTURE` is enabled” at design lines 1336-1339.
Invariant 10 carries the same qualification at lines 3537 onward. Both
neighbourhoods also state the switch-off behavior: the pre-200
advertised-diff author may publish an unproved all-scoped omission.

The switch-off state therefore no longer contradicts a universal invariant.

## Findings, ranked

### CLASS B — MAJOR 1: the fourth legacy-writer arm is not production-reachable

Evidence:

- design lines 1530-1538, 3905-3914, 5747, and 5752;
- `src/cli/sync-state.ts:396-401`, `:516-524`;
- `src/cli/sync-git/follow.ts:321-332`;
- `src/cli/sync-git/plan.ts:395-403`;
- `src/cli/sync-git/apply.ts:623-637`;
- every repository call found by
  `rg 'savePublishedRepoIntent\\(' src`.

`savePublishedRepoIntent` does define
`options: { forceLegacy?: boolean }`, and that internal arm would write through
the unsafe whole-file writer if a caller selected it. No production caller
does.

The cited recovered-journal call is:

```ts
savePublishedRepoIntent(workspaceRoot, state, relPath, recovery.intended)
```

It passes no options (`follow.ts:330`). More decisively, both normal planner and
apply recovery call `recoverAndLandFollowJournal` with
`land: !degradedMutex` (`plan.ts:396`; `apply.ts:624-627`). In degraded mode
they retain the journal and defer with “awaits non-degraded state save”
(`plan.ts:399-402`; `apply.ts:629-636`). They do not select a legacy landing.
Manual resolve callers also omit the option and run under the required
non-degraded workspace mutex.

The only direct uses of the option-bearing function outside its definition are
these optionless production and test calls. Therefore
`savePublishedRepoIntent.forceLegacy` is a dormant dead arm, not a fourth
production family-(ii) arm, and “which is how a recovered checkout journal
lands its published intent” is false.

Required correction:

- state **three production arms**, not four;
- either label `savePublishedRepoIntent.forceLegacy` an unreachable dead arm
  or omit it from the residual examples;
- remove its required production positive/negative rows from §9.1; and
- correct the four-arm statements in §3.2c, §9.1, §13.12, and the summary.

This narrows an overstatement only. It does not close family (ii), change the
defining trigger, weaken the degraded-workspace rate statement, or reveal a
mechanism defect.

### CLASS B — MINOR 1: the fleet paragraph attributes a current log to a host that has none

I followed the repository's read-only fleet-observation procedure and checked
the three named hosts on 2026-07-25. I searched each current non-test dated
daemon log for all of:

```text
degraded
workspace locking unavailable
legacy state saves
identity-unavailable
```

The observed snapshot was:

| Host | Tracked `~/Development` workspace | Current non-test daemon log | Warning matches | Filesystem | `locking-health.json` |
|---|---:|---:|---:|---|---:|
| MacBook | yes | `daemon-2026-07-25.log` | 0 | APFS | absent |
| `flat-meadow-prod-main-01` | yes | `daemon-2026-07-25.log` | 0 | ext4 | absent |
| `via-desktop-ubuntu` | **no** | **none** | N/A | ext4 | N/A |

The two active fleet workspaces therefore support the substantive snapshot:
neither is degraded-unlocked, both are on local hard-link-supporting
filesystems, and both have current successful daemon activity. The desktop
also uses local ext4, but it has no rbox workspace whose mutex or log can be
observed.

The sentence “zero `degraded` occurrences in the current daemon logs of every
fleet host” is nevertheless false: one fleet host has no current daemon log.
Replace it with the measured fact, for example:

> The two hosts with tracked workspaces have zero degraded-locking warnings in
> their current daemon logs and no locking-health marker; the desktop currently
> has no tracked workspace or daemon log. Their Development filesystems are
> local APFS/ext4.

The paragraph's conclusion — no degraded-unlocked workspace exists in the
fleet at this snapshot — remains true. The explicit “snapshot, not invariant”
qualification is correct and should remain.

### CLASS B — MINOR 2: PR #448 is merged, not pending merge

Design lines 1630-1638 first say the missing parent sync “is fixed in code,”
then say “Once merged.” `origin/main` is already at `2a7f821e`, whose subject
is `fix(state): fsync state.json's own parent after the atomic rename (#448)`.
The exact code and test above verify the fix.

Replace “Once merged” with “Merged as `2a7f821e`;” (or equivalent present
tense). The design branch need not contain that implementation commit for the
design's property to remain valid, but the shipped-state sentence must not
describe a completed merge as future.

## Class-C founder question

Should design 200 knowingly allow same-OID branch-pointer consumption to become
a routine concurrency outcome on any future degraded-unlocked workspace,
relying on `status`/`doctor` surfacing rather than fail-closed Git publication?

That is the recorded R4 reversal question, not a mechanism or truth finding.

## Shortest path to alignment

1. Change the family-(ii) inventory and tests from four production arms to
   three, treating `savePublishedRepoIntent.forceLegacy` as an unreachable dead
   arm.
2. Rewrite the fleet snapshot to say that two hosts have current logs and the
   desktop has no tracked workspace/log.
3. Change PR #448's “Once merged” to present tense and cite `2a7f821e`.

No mechanism change is required. After those class-B claims are corrected, the
remaining issue is class C only and the verdict should be **ALIGNED** under the
requested rule.

**NOT-ALIGNED.**
