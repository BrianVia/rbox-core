# Design 200 v12 — Codex verification review, round 11

Date: 2026-07-25  
Reviewed: `docs/design/200-worktree-lifecycle-resilience.md` v12,
`REVIEW-200-R2-CODEX.md` through `REVIEW-200-R10-CODEX.md`, and the current
implementation

## Verdict

**NOT-ALIGNED.**

The plural cardinality is now stated honestly, the absent-both citation is
corrected, and the M2/M4/M5 and minor restatements hold. The two questions v12
left open do not verify as written:

1. the current-branch form is reachable and uses `prepareDisplacementPins`, not
   `prepareTombstonePrunePins`; and
2. the ACK trigger taxonomy is incomplete. More seriously, degraded-unlocked
   legacy persistence can regress a successfully saved ACK, and the claimed
   post-rename durability lacks the required parent-directory fsync.

The final sweep also found that the M1 and M3 replacements are themselves
false: a scoped carry need not equal BASE, and putting BASE plus `advertised`
in one packet does not make their ref maps semantically equal. The latter
directly contradicts the design's required kill-switch-off state.

## Round-10 findings — one-line disposition

- **R10 B1 (plural bound) — CLOSED.** The loss is correctly bounded by the
  accepted publication's deletion set, evaluated once per ref; the separate
  current-ref pin-producer overclaim is a new finding below.
- **R10 B2 (trigger width) — NOT-CLOSED.** The six-path/three-non-member
  taxonomy omits reachable opening paths and misclassifies legacy and
  post-rename behavior.
- **R10 M1 (fresh `dir` scope) — NOT-CLOSED.** The narrowing to fresh capture
  is right, but its new assertion that a scoped carry equals BASE is false.
- **R10 M2 (§3.2 stale closure claim) — CLOSED.** Active §3.2 now names the
  accepted residual rather than claiming it is closed.
- **R10 M3 (BASE/wire invariant) — NOT-CLOSED.** The new BASE/`advertised`
  equality is not implied by one packet and is false in a required switch-off
  state.
- **R10 M4 (file-history recovery) — CLOSED.** The normative recovery promise
  is limited to content the file plane observed, and the uncovered case plus
  negative rig twin are present.
- **R10 M5 (invariant 11) — CLOSED.** The authority/withholding boundary and
  named permit-list match the real readers; `plan.ts` reads none of
  `deferrals`, `partial.heldRefs`, or `attempt.blockers`.
- **R10 m1 (superseded scope) — CLOSED.**
- **R10 m2 (§3.2d citations) — CLOSED.**
- **R10 m3 (assertion count) — CLOSED.** The accepted-residual fixture has
  eight active bullets.
- **Absent-both route precision fix — CLOSED.** Equality at `follow.ts:848`,
  witness reconstruction at `:856-869`, and continuation at `:912` are the
  operative path; `:936` is only the defensive re-check.

The round-10 verification of C3 deletion, the ordinary non-current
tombstone-prune transaction, and the round-9 B3 hidden-anchor repair remains
valid. No withdrawn C3 machinery has reappeared.

## Open item 1 — current branch / displacement pins

**NOT-CLOSED as written. The form is reachable, but the broad recoverability
conclusion survives with a different pin producer and origin class.**

`live.currentRef` is excluded from tombstone authorization and the ordinary
per-ref mutation loop:

- `follow.ts:773-778` refuses to add the current ref to
  `tombstoneAuthorized`; and
- `follow.ts:834-835` skips it because the checkout transaction owns it.

That is not an exclusion from deletion. The checkout path separately reads the
current ref, its old tip and its effective incoming value
(`follow.ts:1247-1251`). When an all-scope incoming section omits it,
`oldOid && !newOid && effective.deleteAbsent` plans a branch deletion
(`:1273-1294`). Reachability is demonstrated by the existing checked-out
deletion test: with no incoming containing root the checkout defers, but when a
durable incoming descendant contains the tip the checked-out branch is deleted
and HEAD switches away (`follow.test.ts:979-1011`). The accepted-residual state
adds stale positive logical BASE at the same OID, which is exactly the
`planBranchTransition` precondition.

This route always prepares **displacement** pins
(`follow.ts:1252-1266`). `prepareDisplacementPins` takes the per-ref protocol
locks and forcibly includes the exact `oldOid` even if the reachability walk
did not classify it as a displaced reflog OID (`keep-pins.ts:745-761`). Its
origin is `human`, not `tombstone`
(`follow.ts:1260-1266`; `keep-pins.ts:149-155`).

The atomic recovery property still holds. The pin lines enter the current
branch plan beside its A artifact and delete
(`follow.ts:1275-1294`; `branch-transition.ts:107-119`). Since an omitted
current branch must cease to be HEAD's target, the plan is assigned to the
post-HEAD transaction (`follow.ts:1295-1297`), whose prepared lines commit
together at `checkout-txn.ts:872-903`.

Required restatement:

- non-current tombstone-authorized consumption uses
  `prepareTombstonePrunePins` and gives the authorized tip a tombstone origin;
- reachable current-ref consumption uses `prepareDisplacementPins` and gives
  the exact old tip a permanent human origin; and
- the test plan needs a current-ref accepted-residual twin with an
  incoming-owned/contained tip, asserting the checkout deletion and human pin.

Thus §3.2c lines 1530-1563, §3.6 row 3, §12 C3, §13.4 item 8, and the generic
§9.1/§9.6 tombstone-origin assertions are too narrow. V12's header also says it
has no unverified claim while §13.11 explicitly leaves this route open
(design lines 5231-5239).

## Open item 2 — ACK trigger completeness

**NOT-CLOSED. The six-path enumeration and the three named non-members are not
complete.**

### A successful `forceLegacy` save can be regressed

Push passes `forceLegacy` at `push.ts:1012`. That arm builds `legacyState` from
the caller's snapshot and writes the entire file through
`saveStateUnsafeLegacyOrTest` (`sync-state.ts:332-335`;
`sync-state-store.ts:330-361`). It takes neither the state lock nor a
generation CAS. The surrounding mutex contract expressly calls this mode
**degraded-unlocked** and says callers continue through the unlocked legacy
state path (`sync-mutex.ts:13-17`, `:140-154`).

Consequently:

1. operation A can accept and successfully legacy-save the omitting ACK,
   retiring BASE;
2. a concurrent degraded operation B, composed from a stale positive-BASE
   snapshot, can finish second and overwrite A's whole state; and
3. the wire retains A's accepted omission while local BASE/`advertised` have
   regressed.

That opens the same residual after a **successful** publisher-ACK save. The
statement at design lines 1477-1484 that `forceLegacy` is categorically outside
the trigger set is therefore false. The unsupported transactional fallback and
allowed stream-replacement fallback use the same unsafe writer
(`sync-state.ts:342-351`) and need the same analysis.

### Pre-write failures are omitted

The transactional path can throw before `writeFileAtomic`: `.rbox` directory
creation is at `sync-state-store.ts:119`, and the locked durable-state read is
at `:137`. `loadRawState` performs bounded state/incarnation reads and may
throw for I/O, corruption, size, identity, parse, or memory-admission failures
(`sync-state-store.ts:87-102`; `reset-io.ts:304-326`). Those errors propagate
through the unguarded `apply` await at `sync-state.ts:340` and are rethrown by
push at `push.ts:1024`. They are not `busy`,
`stream`/`nonce`/`owner-lost`, CAS exhaustion, or the cited atomic-write error
at `sync-state-store.ts:215`.

The branch classification is also conditional: `stream` throws only when
`allowLegacyStreamReplacement` is false. When true it successfully takes the
legacy fallback (`sync-state.ts:348-351`; push supplies the option at
`push.ts:1011`). `unsupported` likewise successfully falls back at
`sync-state.ts:342-345`. Both are omitted from the claimed complete non-member
set.

### A post-rename throw is not proven durable

`writeFileAtomic` fsyncs the temp file and renames it, but never fsyncs the
parent directory (`fsutil.ts:35-89`, especially `:60` and `:83`). The
`lstat`/`rm` operations at `sync-state-store.ts:219-223` happen before the only
following directory fsync, and that fsync is conditional on an incarnation
marker having existed (`:224`). With no marker, even successful completion
does not fsync the directory.

Therefore a throw after rename proves process-visible publication, not
power-loss durability of the rename. The categorical non-member at design
lines 1427-1431 and the negative test at lines 3551-3552 need either a
parent-directory fsync in the machinery or a weaker term than “durably saved.”

### The positive test list omits a named member

The design includes the server-accepted/lost-response throw at
`push.ts:825-839` in its six-path set, but §9.1 lines 3544-3548 do not execute
it. The row therefore does not run “once per injectable cause” as claimed.

## New findings

### BLOCKER 1 — degraded legacy persistence can erase a successful ACK

Evidence: design lines 1477-1484, 5192 and 5240-5245;
`src/cli/sync/push.ts:1000-1013`;
`src/cli/sync-state.ts:332-351`;
`src/cli/sync-state-store.ts:330-361`;
`src/cli/sync-mutex.ts:13-17`, `:140-154`.

This is wider than v12's stated trigger, “the publisher ACK is not durably
saved.” The ACK can be saved and then overwritten by a stale concurrent
whole-file writer precisely because the selected mode is unlocked. It also
invalidates v12's rate argument: degraded-mode concurrency is neither a crash
nor a three-CAS-exhaustion event. Alignment requires the residual and tests to
include stale legacy overwrite, or machinery that prevents the regression.

### BLOCKER 2 — post-rename is not a durability boundary in this writer

Evidence: design lines 1427-1431, 3551-3552, 5192 and 5240-5245;
`src/engine/fsutil.ts:35-89`;
`src/cli/sync-state-store.ts:215-224`.

The design makes a power-loss claim from a rename with no unconditional parent
directory fsync. The named negative can lose the renamed directory entry
across a crash, so it cannot be excluded from a trigger defined in terms of
durability. This needs a machinery fix or a statement/test that does not call
the state crash-durable.

### MAJOR 1 — scoped carry is safe, but not because it equals BASE

Evidence: design lines 1182-1198, 1271-1277 and 3678-3687;
`src/cli/sync-git/apply.ts:1416-1428`, `:1437-1450`;
`src/cli/sync-git/plan.ts:533-540`.

A scoped incoming section can omit `R` while the receiver's BASE retains
`R = X`. Apply composes BASE fail-closed, yet stores the whole `remoteSec` as
pending. `deferOne` later republishes that pending section byte-for-byte.
Therefore the v12 counter-example's required assertion that the carry “asserts
exactly what `record.base.refs` asserts” is false.

The safety argument is simpler and already present elsewhere: a scoped
omission is inert because `effective.deleteAbsent` is false. Delete the
BASE-equality assertion and test that inertness instead.

### MAJOR 2 — BASE and `record.advertised` can disagree after one accepted CAS

Evidence: design lines 3973-3987 and 5195;
`src/cli/sync-state.ts:218-236`;
`src/cli/sync-git/base-composer.ts:356-362`, `:515-526`;
design lines 1235-1250, 3992-4001 and 4166-4175.

`sourceRecord` composes BASE and writes `advertisedValue` independently.
Putting them in the same packet guarantees atomic co-publication, not semantic
ref equality. When an omitting publisher proof is absent or mismatched, the
composer preserves positive BASE while `advertised` records the omitting
section.

The design's own kill-switch contract requires exactly this after a successful
save: switch-off publishes an all-scoped omission and tombstone without
`absentBranchProofs`, while BASE does not retire. This is not the
accepted-POST/pre-save exception §9.6 added; it is a durable post-save
counterexample. The mandatory “positive exactly while advertised asserts”
property is therefore unsatisfiable and M3 remains open.

### MAJOR 3 — the structural pin and invariant 10 contradict the kill switch

Evidence: design lines 1235-1263, 3208-3226, 3853-3858, 3992-4001 and
4166-4175.

The structural assertion and invariant 10 universally forbid an all-scoped
published omission of a positive BASE head without a same-push proof. The
switch-off contract deliberately disables W/L/D/`absentBranchProofs` and
publishes that exact omission. Both statements need an explicit
feature-enabled qualification; the pre-200 rollback exception cannot remain
only in the switch section.

### MAJOR 4 — current-ref recovery uses a different, untested pin contract

Evidence: `src/cli/sync-git/follow.ts:773-778`, `:834-835`,
`:1247-1297`; `src/engine/git/keep-pins.ts:149-155`, `:745-761`;
`src/engine/git/checkout-txn.ts:872-903`;
`src/cli/sync-git/follow.test.ts:979-1011`.

The exact OID remains atomically recoverable, so the consequence bound does
not widen. But every universal claim and test that requires
`prepareTombstonePrunePins` or a tombstone-class origin is false for this
reachable form. Restate path 1 as two variants and add the checkout twin.

### MAJOR 5 — the trigger test matrix is incomplete

Evidence: design lines 3544-3553; `src/cli/sync/push.ts:825-839`;
`src/cli/sync-state.ts:342-351`.

The mandatory positive rows omit lost response. The negative rows omit the
successful unsupported and allowed-stream legacy fallbacks, and the stated
`forceLegacy` negative is absent despite being central to the disposition.
After blocker 1, the matrix also needs the degraded stale-overwrite positive.

### MAJOR 6 — “consumed at most once” lacks its strongest executable row

Evidence: design lines 1496-1513 and 3560-3568;
`src/cli/sync-git/tombstone-attestation.ts:102-118`;
`src/cli/sync-git/follow.ts:682-685`.

The failed-apply-save test leaves `R` absent before the next pull, so it
exercises only the absent-both retirement. It does not re-create `R = X` again
before that retry. That is the interleaving which proves the first prune's
owning A artifact vetoes a second tombstone authorization while serialized
BASE is still positive. Add that re-creation and assert the ref survives/is
held before the retry retires BASE.

### MINOR 1 — “n refs means n pins” is too literal for OID-keyed keep refs

Evidence: design lines 1405-1408, 1535-1554 and 5191;
`src/engine/git/keep-pins.ts:590-608`, `:745-760`.

Keep refs are content-addressed by OID. Two consumed refs at the same OID share
`refs/rbox-local/keep/<oid>`; the later delete transaction may have no
pin-create line because the keep ref already exists. The true property is:
each ref has its own destructive transaction, and that transaction commits
only after all required keep refs exist. There can still be n recovery
operations, but not necessarily n distinct pin refs or pin-create commands.

### MINOR 2 — one file-plane absolute remains after the M4 narrowing

Evidence: design lines 1569-1587.

The section correctly limits recovery to versions the file plane observed,
then says a branch developed in the synced workspace has “every one of its
file versions” in the file plane. Versions between sync observations are not
promised. Narrow that sentence to versions which reached a synced sequence;
the §9.6 positive and negative rows already use the correct form.

### MINOR 3 — stale citations and a duplicate heading remain

- Design line 12 calls `follow.ts:936-1007` the per-candidate loop; the loop
  starts at `:834`.
- Lines 1530-1554 cite only the non-current pin path while making a universal
  claim; the current path is `follow.ts:1247-1297`.
- The hidden-anchor test calls `push.ts:993` the ACK save; the save begins at
  `:1001`.
- Design line 2383 cites attestation equality at `:107-109`; it is at
  `:109-111`.
- `### 9.6 Surfaces and rig` appears twice at design lines 3865-3866.

## Shortest remaining list

1. State the degraded legacy overwrite and all pre-write/fallback trigger
   branches; either establish the post-rename durability boundary in code or
   stop excluding it.
2. Replace the false scoped-carry/BASE and BASE/`advertised` equalities, and
   qualify the structural pin plus invariant 10 for switch-enabled operation.
3. Split recovery path 1 into non-current tombstone pins and current-ref human
   displacement pins, with the missing current-ref and repeat-recreation tests.

**NOT-ALIGNED.**
