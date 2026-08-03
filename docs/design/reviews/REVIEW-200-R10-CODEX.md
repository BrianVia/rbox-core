# Design 200 v11 — Codex verification review, round 10

Date: 2026-07-25  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` v11,
`REVIEW-200-R2-CODEX.md` through `REVIEW-200-R9-CODEX.md`, and the current
implementation

## Verdict

**NOT-ALIGNED.**

The C3 subtraction itself is complete, the keep-pin implementation claims are
substantially correct, and round 9's hidden-anchor bookkeeping defect is fixed in
the specification. The accepted residual is not stated at its true bound:

1. one lost publisher ACK can prune **many** same-OID-restored heads, not one
   branch pointer; and
2. the trigger is any failure to durably save the publisher ACK, not only a
   process crash.

The first is the materially worse mass-deletion variant this verification was
asked to treat as a blocker.

## Round-9 findings

- **R9 B1 — MOOT.** The one-slot same-ref generation model, its arm and all of
  its consumers are deleted; no live C3 field exists to repair.
- **R9 B2 — MOOT.** The legacy/degraded writer cannot drop a field that v11 no
  longer defines or writes.
- **R9 B3 — CLOSED.** The hidden-anchor discard now removes the captured
  outgoing section and restores the **prior** `removedKey`; both clauses match
  the actual planner and state-writer path.
- **R9 B4 — MOOT.** The C3 map and its hard-cap overflow disposition are
  deleted.
- **R9 M1 — CLOSED.** The structural assertion and its core test are qualified
  by effective `refScope === "all"` and the scoped omission is named as an
  exception. The newly added “no dir repo publishes scoped” control has a
  separate new defect below.
- **R9 m1 — CLOSED.** The mandatory row executing v9's withdrawn survivor
  machinery is deleted with that machinery.
- **R9 m2 — CLOSED.** The active header, §3.6 and §5.2 now consistently say
  fifteen consumer sites plus five tests.

## Verification results

### C3 deletion completeness — CLOSED

The exact withdrawn names were swept, including:

`GitAbsencePublicationAttempt`, `GitAbsenceAttemptEntry`,
`GitAbsenceAttemptUpdate`, `RepoRecord.absencePublicationAttempt`,
`values.absencePublicationAttempt`, `{ arm, clearAsserted }`,
`attemptedSequence`, `attemptedGitIncomingKey`, `beforeCommitSend`,
`forcedHeldRefs`, the three drop conditions, amendments 1/1b/2/3,
push-entry reconciliation, the termination/latch rules and the C3 use of
`MAX_REF_TOMBSTONES_PER_REPO`.

No live type, state lane, transition, hold installation, cap disposition or
mandatory lifecycle test survives. The remaining hits are deletion inventories,
negative invariants, rejected alternatives, decisions, or review history.
`forcedHeldRefs` at design line 2287 describes an already-existing ownership
seam; it is not a C3 installation. The sole §9 exact-name hit restores the
negative assertion that no such field may exist.

### Keep-pin claims — CLOSED

- `GitRefTombstone` has exactly `oid`, `ts` and `generation`
  (`src/engine/types.ts:70-75`), and validation rejects any other key
  (`src/engine/manifest-validate.ts:69-75`). There is no publisher identity to
  filter on.
- The tombstone waiver is evaluated independently for every eligible
  `refs/heads/*` hold (`src/cli/sync-git/follow.ts:770-786`). Every destructive
  tombstone-authorized head reaches `prepareTombstonePrunePins` at
  `follow.ts:947-949` and is re-attested inside the prepared transaction at
  `:989-1000`.
- `prepareTombstonePrunePins` gives the authorized tip a `tombstone` origin and
  every distinct other OID in that ref's reflog a `human` origin
  (`src/engine/git/keep-pins.ts:635-654`; reflog enumeration includes old and
  new values at `src/engine/git/shared.ts:294-308`).
- Those create lines are spliced with the A artifact and
  `delete <ref> <oldOid>` (`src/cli/sync-git/branch-transition.ts:109-126`,
  especially `:119`) and committed by one prepared `git update-ref`
  transaction at `:301-325`. A pre-commit crash can leave an origin sidecar
  over-protecting, but cannot leave the branch deleted without the keep ref.
- The tip's tombstone-class origin is expirable in principle after
  `TOMBSTONE_PIN_RETENTION_MS` (`keep-pins.ts:68`, `:431-456`), but
  `expireTombstoneKeepPins` has no non-test production caller.
- The HEAD-reflog caveat is fair. A checkout-shaped re-creation leaves the OID
  in `logs/HEAD`; a bare `git branch` does not. A branch still checked out is
  ownership-held rather than pruned.
- The loss does not self-latch. The prune produces an absent witness and locked
  proof which become `pull-ref-transaction` authority
  (`src/cli/sync-git/apply.ts:1258-1282`). If its state save fails, the A
  artifact created with the delete also prevents a same-OID re-creation from
  being authorized on the retry; with the ref absent, `follow.ts:936` no-ops
  and BASE retirement is retried.

This verifies the implementation facts. It does **not** verify v11's claimed
cardinality or crash-only trigger, which fail below.

### R9 B3 repair — CLOSED

The actual route is:

- `planGitSections` copies the removal map at
  `src/cli/sync-git/plan.ts:147`;
- the identity-change re-add deletes `removedMem[rel]` at `:601-604`;
- the planner exports that map at `:284`;
- the commit-free and accepted-ACK saves pass it at
  `src/cli/sync/push.ts:669` and `:993`;
- `sourceRecord` emits `removedKey` only when that map names the repository
  (`src/cli/sync-state.ts:237-242`); and
- projection hides the retained BASE only while `repoAbsent` or `removedKey`
  suppresses it (`src/cli/sync-state-model.ts:455-458`).

V11's two clauses at design lines 990-1005 address exactly that route:

1. discard means delete `out[rel]` and `finalizedOutgoing[rel]`, remove capture
   membership and clear authored config bookkeeping, rather than install an
   undefined fallback; and
2. restore the saved **old** `record.removedKey`, not the changed leftover's
   identity.

The old key keeps the hidden anchor suppressed through either state writer but
allows the next cycle to clear it again and publish the re-add once L passes.
The §9.1 row also drives both state writers and a subsequent cycle. No remaining
B3 gap was found.

## New findings

### BLOCKER 1 — one lost ACK can delete many restored branches

Evidence: design lines 1275-1277, 1288-1328, 2187-2189, 3253-3277,
3977 and 4300-4318; `src/cli/sync-git/follow.ts:712-716`, `:773-786`,
`:834-1027`; `src/cli/sync-git/branch-transition.ts:109-126`, `:301`;
`src/engine/manifest-validate.ts:23-24`, `:59-66`.

The residual repeatedly says the defence is proportionate because it protects
“one branch pointer,” that “what is lost is a ref, once,” and that each
occurrence needs its own crash. The implementation is not cardinality-one.

A single captured section may omit and tombstone many proven heads. The design
even mandates a 24-head successful-deletion fixture at §9.4. On apply,
`follow`:

1. adds every live and BASE ref to `candidates`;
2. tombstone-authorizes each classified ref independently; and
3. iterates every candidate, preparing and committing one destructive branch
   transaction after another.

Construct the wider case:

1. delete and prove `R1 … Rn` in one repository;
2. let one POST containing all `n` tombstones be accepted and lose its local
   publisher-ACK save;
3. restore or bulk re-create all `n` non-current refs at their respective
   tombstoned OIDs before the pull; and
4. pull the accepted section.

Every ref independently satisfies live = BASE = tombstoned OID, so the one pull
prunes all `n`. The wire format permits hundreds of tombstone entries per
repository; twenty-four is already a mandatory in-design example. Every tip is
pinned, so this is not object loss, but it is exactly the **mass deletion**
variant the round-10 brief classifies as materially worse than the accepted
residual.

The §9.1 lost-ACK fixture is single-ref and cannot detect it. Alignment requires
the residual, founder-principles analysis, non-recurrence cardinality and test
plan to state and exercise the multi-ref bound. If that consequence is not
accepted, the withdrawal itself needs reconsideration.

### BLOCKER 2 — a process crash is not a necessary trigger

Evidence: design lines 1290-1301, 2165-2174, 2567-2569, 3977 and
4300-4318; `src/cli/sync/push.ts:825-839`, `:1000-1025`;
`src/cli/sync-state.ts:324-359`;
`src/cli/sync-state-store.ts:209-225`.

V11 says the crash “must” land after accepted POST and before state CAS, and
calls that the only trigger. The code permits the same durable state without a
crash.

After an accepted response, the publisher-ACK state save runs at
`push.ts:1000-1013`. For an ordinary absence publication there is no armed
resolution receipt, so any error is rethrown at `:1014-1025`; the wire commit
remains accepted and local BASE remains positive. `saveStateSource` can fail
without process death because the state lock is busy, stream/nonce/ownership
changed, three recomputes were exhausted, or the atomic file write failed
(`sync-state.ts:339-359`; `sync-state-store.ts:209-225`). A server-accepted POST
whose response is lost can also throw at `push.ts:825-839` before the ACK save
is attempted.

With the same-OID local re-creation already present, the next pull reaches the
same attestation and prune. The narrowest true trigger is therefore:

> a server-accepted omission whose publisher ACK is not durably saved locally,
> plus the same-OID local presence before the applying pull's ref observation.

“Crash” is one cause, not a required conjunct. Because the accepted tradeoff is
the centre of v11, all executive, normative, failure-table, decision and test
wording must use the true trigger.

### MAJOR 1 — “no dir repository publishes scoped” is false

Evidence: design lines 1115-1125, 1192-1199 and 3367-3376;
`src/engine/git/capture.ts:333-345`;
`src/cli/sync-git/follow.ts:608-614`;
`src/cli/sync-git/apply.ts:1426`, `:1447-1450`;
`src/cli/sync-git/plan.ts:533-543`, `:592`, `:971-974`.

The cited capture line proves only that a **fresh capture** of a `dir`
repository has `refScope: "all"`. It does not prove that every section a dir
repository later publishes is all-scoped.

A dir receiver explicitly accepts a scoped incoming section, may retain that
exact section as `pending`, and a later busy or failed-capture push publishes
the pending section byte-for-byte through `deferOne`. Thus a dir repository can
publish a scoped **carry**. That is safe because scoped omission remains inert,
but the new mandatory assertion is unsatisfiable and the “fixed by repository
kind” rationale is too broad.

Narrow the claim and test to “no freshly captured dir section is scoped.” The
effective-scope qualification itself remains correct.

### MAJOR 2 — active §3.2 still says the lost-ACK race is closed

Evidence: design lines 857-864 versus 1223-1328 and 3248-3270.

The normative authority section says an L→ACK re-creation is “closed for a lost
one by §3.2c.” V11's §3.2c and mandatory test now deliberately accept the
same-OID lost-ACK prune. This is a surviving v8-v10 closure claim in active
text, not historical review record.

Replace “closed” with the accepted residual, using the corrected trigger and
multi-ref bound from the blockers above.

### MAJOR 3 — the mandatory BASE/wire invariant rejects the accepted residual

Evidence: design lines 1297-1301, 2170-2175, 3248-3270 and 3645-3659.

Section 9.6 requires that, across every injected witness→ACK failure, BASE is
positive exactly while the newest acknowledged wire section asserts `R`, and
absent exactly while it omits `R`. The accepted residual is precisely the
opposite durable state: the server has accepted an omitting head while the
publisher-ACK state save has not retired BASE.

If “acknowledged” means only “locally persisted,” the row can pass but its title
and claim about **the wire** are false. If it means server-accepted, the row is
impossible. Add the accepted-POST/pre-save exception, or restate the property
against the last locally persisted publisher ACK.

### MAJOR 4 — file history is not a universal third recovery path

Evidence: design lines 719-725, 1275-1277, 1358-1361 and 3689-3692;
`src/cli/help-registry.ts:320-328`; `apps/api/src/plans.ts:23-27`.

The ruled contract promises versions of files that existed in the synced file
plane during the retention window. It does not materialize every tree of every
non-current Git branch. The residual expressly permits a bare
`git branch R X`; `X` may contain commits and file versions that were never
checked out in any synced workspace sequence.

Therefore “any content that lived only on that branch is recoverable through
the file plane” is too strong, and §9.6's universal branch-content recovery row
does not follow from `rbox restore`. The exact tip is recoverable today from the
atomic keep pin, so this review found no unrecoverable-object variant. State
file history accurately as the product durability contract for content it
actually observed, not as an independent recovery of arbitrary branch-only
work.

### MAJOR 5 — invariant 11's “nothing durable” strengthening is false

Evidence: design lines 1363-1374, 1919-1931, 2783-2797, 2818-2829,
2987-3002 and 3645-3655; `src/cli/sync-state-model.ts:169-205`,
`:227-245`, `:295-310`.

Invariant 11's safety-bearing first sentence is correct: no durable local record
may **retire or authorize** the transition before the wire. V11 then strengthens
that to “persists nothing,” “no durable local record, of any kind,” and a test
for “no per-ref deletion field of any kind.”

The same design requires durable deletion-related UX and skip metadata:

- `RepoRecord.deferrals` persists a `deletion-pending` reason;
- `RepoRecord.partial.heldRefs` persists the per-ref hold split; and
- `RepoRecord.attempt.blockers` persists typed ref-plane blockers, with §5.2
  explicitly widening that producer for `deletion-pending`.

Section 5.2 even states directly that deferral reasons live in local
`state.json` and that `attempt.blockers` is persisted. These records neither
retire nor authorize anything and are not the withdrawn C3 field, but they
falsify “nothing/of any kind” literally and make the corresponding test
ambiguous or impossible.

Keep the real invariant and narrow the prose/test to “no dedicated durable
per-ref authority or withholding field for an unpublished deletion.” Likewise,
§3.2c's “nothing durable behind” the re-derived hold must distinguish
non-authoritative reporting/cache state from the withdrawn protection state.

### MINOR 1 — §3.2c marks its current requirements superseded

At design line 1225, “This section is a superseded record” grammatically covers
the entire section, but lines 1288-1376 define v11's current residual,
non-recurrence and recovery requirements. Limit “superseded” to the withdrawn
field history.

### MINOR 2 — P1b's move left generic cross-references

P1b now has its own §3.2d heading at lines 1385-1388, but active references at
lines 2562, 2913-2914, 2943-2947 and 3823 still cite generic §3.2. Line 3881
already uses the unambiguous `§3.2d's P1b` form. Update the remaining citations.

### MINOR 3 — the lost-ACK fixture count is stale

Section 9.1 says “One fixture, five assertions” at line 3252, followed by six
active assertion bullets at lines 3254, 3258, 3264, 3271, 3275 and 3279.

## Founder-principles adjudication

The principles can fairly justify accepting a recoverable Git-pointer loss, but
v11 applies them to an understated consequence. The implementation does
provide an atomic exact-OID pin for every actually pruned tip, and no
unrecoverable object loss or propagation of the re-created value was found.
The ref loss also does not self-latch.

What is not fairly stated is the unit and frequency: one failed publisher-ACK
save can prune every matching restored head in the accepted section, and the
failure need not be a crash. “No thresholds,” “file history is the contract”
and “there is always a gap” do not turn that mass case into the stated
one-pointer residual. It must be disclosed and accepted at its real bound, or
defended.

## Shortest remaining list

1. State and test the multi-ref consequence of one lost publisher ACK.
2. Widen the trigger from “crash” to any publisher ACK that is not durably
   saved.
3. Remove the false dir/scoped control and correct the active invariant/test
   contradictions.
4. Qualify file history to content actually observed by the file plane.

**NOT-ALIGNED.**
