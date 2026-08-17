# 271 — First BASE for BASE-less records, typed settlement refusals, resolve legibility

Status: DRAFT r4, folding the r3 confirm (R1-R5, m1-m8) onto the r3 mechanism,
which the confirm left standing. Every anchor was re-read on `main @ b9bb83d5d`;
§6 records where a review's suggested shape did not survive that reading.

r1's central mechanism stays REFUTED: a P cannot mint a BASE family
(`base-composer.ts:593` picks `previous.base` or `candidate.base` and re-refs
it; nothing is synthesized), and a minted family would advertise
never-uploaded pack links (`git-state.ts:247-259`).

## 1. Problem (as verified)

Fresh-join re-baseline leaves a repo record with a standing create-shaped P and
NO serialized BASE. Four facts compose into the wedge:

1. **The follow can never earn a first BASE.** With no BASE, `previousRefs` is
   `{}`, so for every incoming ref `before (null) !== requested` and
   `composeRepoBase:503-510` demands a per-ref witness. A follow only witnesses
   refs it MOVES, so every unmoved ref takes `missing-branch-proof` →
   `pending` → `family = previous.base = undefined` (`:592-597`) → no BASE is
   ever serialized.
2. **The ref plane calls the same shape local divergence.** For a ref already
   at the incoming value (`ref-plane-publication.ts:106` `oldOid === newOid`),
   a BASE-less record gives `baseOid = null` (`:107`) and
   `logicalBaseOid = null` (`follower-protocol.ts:73` seeds
   `logicalBaseRefs` from `input.base?.refs ?? {}`), so `:128` cannot match and
   the `:160-161` fallthrough mints `heldRefs[ref] = "local-commits"`. That is
   a FALSE user-facing classification, and it keeps the section pending
   independently of fact 1.
3. **The standing-P gate fires before either.** `apply.ts:857` →
   `settleExactPresentArtifact`, whose entry pre-check tolerates the absent
   BASE (`p-settlement.ts:73-75`: create-shaped P has `priorOid === null`,
   `currentBase` is `null`) and whose transaction then throws
   `P settlement BASE disappeared` (`:101`) → `{status:"hold"}` (`:161`) →
   `standing-branch-proof.ts:170-171` `held(...)` → `apply.ts:887-890`
   `defer(..., "artifact")`. The follow composition at `apply.ts:924` is NEVER
   REACHED. This is the 539/day `artifact` deferral on the Mac (~3.6s/cycle).
4. **Front doors mirror the refusal.** The post-CAS settlement throws
   (`received-git-transition-commit.ts:388`) and aborts the whole pull with no
   deferral written and no rebind; `reset-state.ts:170` throws; resolve's
   preflight returns the hold (`resolve-command.ts:511`); P-repair's state port
   CAS rejects on `!record.base` (`p-repair-state.ts:123`).

Evidence: GH #752-B, bug-pinned rig scenario #753.

## 2. Mechanism

### 2.1 `base-absent` is a typed hold code, and it opens the landing

`ExactPSettlementResult`'s hold member gains an optional code:

```ts
| { status: "hold"; reason: string; code?: "base-absent" }
```

`settleExactPresentArtifact` gains ONE entry test before `:74`:
`!currentRecord?.base` returns `{status:"hold", code:"base-absent"}` without
opening the transaction. The test is on the OPTIONAL chain deliberately: a
repository with no record at all (`repoRecordsForState(state)[relPath]`
undefined — reachable when a P stands on disk for a repo the lineage no longer
projects) has no BASE to settle against either, and the landing composition
treats it identically (`prior.base === undefined`). Routing it to a generic
hold would re-create the wedge for the rarer shape. The in-transaction throw at
`:101` is untouched — BASE vanishing under the held locks is a concurrent-loss
anomaly, not a never-had-BASE record, and it keeps its generic hold.

Per-caller behaviour under the new code:

| caller | today | under `base-absent` |
|---|---|---|
| `standing-branch-proof.ts:171` | `held` → apply defers | new `kind:"landing"` result (§2.2) |
| `received-git-transition-commit.ts:388` | throws, aborts pull | §2.5 hold |
| `reset-state.ts:170` | throws `unpreservable P` | unchanged; message names the code |
| `resolve-command.ts:511` | `{status:"hold"}` | unchanged; §2.6 gives it a code |
| `p-repair-state.ts:123` | CAS `rejected` | unchanged — port stays 2-valued |

### 2.2 The landing result

`StandingBranchProofResult` gains a fourth member:

```ts
| { readonly kind: "landing"; readonly carry: StandingProofCarry; readonly protocol: FollowerBranchProtocol }
```

`settleStandingBranchProof` returns it when `settleExactArtifact` reports
`base-absent`: the P cannot settle because there is nothing to settle it
against, so the transition stops settling and licenses the caller to LAND a
first BASE instead. `apply.ts` treats `landing` exactly like `settled` (same
protocol, same `followProof`) with one addition: it arms the landing
observation of §2.3.

The P is left standing. It settles on the next pull that routes this repository
through the follow path (BASE now exists, `refs[ref]` equals its `nextOid`), or
— if a newer section landed in between — through bounded P-repair, whose
`preserve-third` disposition (`base-composer.ts:456-457`) concludes it.
Same-pull settlement is DROPPED; see §6/B3. What actually drives that next
follow is stated honestly in §4.

### 2.3 First BASE via a follow-time observed-landing composition

The composition site does not move: `composeFollowAuthority` / `advanceFrom` in
`follow-repo-transition.ts` remains the one persisted-BASE construction site
(its own `:58-62` contract), so design-130's allowlist keeps counting exactly
one. What changes is which authority it mints.

`FollowCommitInput` gains one optional field, built by the caller as the
module's contract requires:

```ts
readonly landingObservation?: Readonly<Record<string, string>>;
```

`followBaseProof` mints observed-landing authority when, and only when,
`prior.base === undefined` AND the observation is present; otherwise it mints
today's `pull-ref-transaction` authority unchanged. Its doc comment ("the one
pull-ref-transaction proof constructor of the follow path", `:136`) is updated
to name both authorities and the condition that selects them.

`observedLandingRepoBaseProof` (`base-composer.ts:634-643`) gains an OPTIONAL
locked-proof identity parameter (`repoKind`, `effectiveRefScope`) so it stays
the ONE constructor of that authority; the follow passes its
`FollowTransitionIdentity`, and the legacy journal caller
(`follow-journal.ts:59`) passes today's `dir`/`all` literal explicitly.

**Safety is observation-versus-candidate alone.** `composeRepoBase:389-395`
installs a candidate branch ref only where it equals the observation and pushes
`missing-branch-proof` otherwise; `:551-558` applies the same rule to safe
refs; any hold ⇒ `pending` ⇒ `family = previous.base = undefined` ⇒ **no first
BASE**. The invariant is not stated in terms of held refs — after §2.4 the
landing shape mints none, and a genuinely diverged ref is caught because the
follow did not move it, so disk ≠ incoming ≠ observation.

Two facts outside the composer complete the gate:

- **Durable owner of "first BASE only": `expectedRepoGen`** (`apply.ts:954` →
  the packet's per-repo generation CAS). The `prior.base === undefined` test is
  COMPILE/COMPOSE-time only; if another writer installs a BASE between
  composition and the CAS, the generation CAS rejects the packet. No structural
  `before === null` gate is available inside `composeRepoBase`, because the
  legacy journal caller legitimately advances an EXISTING BASE under the same
  authority kind.
- **`checkoutComplete: false` on the deferred path is load-bearing.**
  `composeFollowRepoTransition:302` composes a deferred outcome with
  `checkoutComplete = false`, and `composeRepoBase:592` makes that `pending`
  unconditionally. So a deferred follow can never land a first BASE even with a
  valid observation in hand.

The observation is `readAllRefsStrict(repoDir)` taken after `followDivergedRepo`
returns and before the two `commitFollowTransition` calls (`apply.ts:1056`,
`:1067`). Consequences of that read point, all safe-direction:

- The journal intent built by `makeIntended` (`apply.ts:1004`) composes before
  the observation exists, so it carries no first BASE. `apply.ts:954` always
  sets `intended.baseProof`, so `follow-journal.ts:55` short-circuits and the
  legacy observed-landing recovery never runs for a journal this rbox wrote.
  A recovered journal therefore lands its pending intent and the first BASE
  arrives on the FOLLOWING pull — one extra cycle, no wrong state. The legacy
  path continues to serve only pre-proof journals.
- The held-attempt binding at `apply.ts:1019` also composes without the
  landing, so `boundBase` stays undefined for a landing repo. The attempt then
  fails closed at the next `steadySkip` and the follow redoes its work once.

The landed family is `remoteSec` verbatim. No GitSection field is synthesized.

### 2.4 The ref plane must stop calling the landing shape divergence

`ref-plane-publication.ts:160-161`'s fallthrough gains one condition: when the
record has NO serialized base, a branch ref already at the incoming value is
NOT local divergence — it is the landing shape — and no `heldRefs` entry is
minted.

Blast radius, verified: reaching `:160` requires `oldOid === newOid` (disk
already equals incoming) on a branch that is not otherwise classified. With
`base === undefined` the only reason `:160` fires today is the vacuous
`null !== newOid`. Genuine divergence with no BASE presents as
`oldOid !== newOid`, which never reaches `:106` at all — it takes the apply
path, or the `:95` `hold = "local-commits"` when no branch protocol stands. So
the condition cannot mask a real divergence: it is confined to the branch where
disk and incoming AGREE, where there are by definition no local-only commits on
that ref. Records that DO have a BASE keep `:160-161` exactly as it is, which is
where the stale-BASE protection it actually provides lives.

The ref deliberately does NOT gain an `appliedRefs` entry. Recording it as
`{kind:"direct"}` (the `:128` precedent) would buy per-ref CAS locks and
partial revalidation, at the cost of one `.lock` per landed ref on the pull's
hot path and a partial marker claiming work this pull did not do. §2.5's
CAS-time re-read covers the same claim without either.

### 2.5 CAS-time reachability of the observation

`revalidateCommittedBranchProofs:216` currently skips every non-
`pull-ref-transaction`/`journal-recovery` proof, which would leave the landing
observation never re-read under the state-CAS boundary. It gains one branch for
`observed-landing`: re-read `readAllRefsStrict`, and if the database is
unreadable OR any BRANCH ref or SAFE ref of the composed BASE no longer equals
the observation, WITHDRAW — never throw. The safe-ref half is explicit parity,
not an afterthought: `composeRepoBase:551-558` installs safe refs from the same
observation, so revalidating only branches would leave half the composed BASE
unproven at the CAS.

Withdrawal reuses `carryUnreadableRefDatabase:161-205` verbatim (candidate →
pending, prior BASE restored — for a BASE-less record that means no BASE at
all, `:172` — `repoProofs` demoted to a carry proof,
`artifactSettlementProofs` keeping the real proof, partial dropped, apply
deferral written), parameterized only by the deferral reason:
`ref-read-unreadable` for an unreadable database, `git-busy` for a moved
observation (a concurrent writer moved a ref inside the CAS window; that is
what `git-busy` names).

No new CAS locks are planned. `planStateCasLocks:134-147` and
`settleCommittedBranchArtifacts:349/:361` keep their filters unchanged: an
observed-landing authority carries no `branchWitnesses`, so there is nothing
for them to lock or settle. The residual race — a ref moving between the
revalidation read and the CAS commit — records that ref at its pre-move value.
That is the safe direction: BASE is never newer than what disk was seen to
hold, and a stale BASE ref is classified by the next pull as ordinary local
divergence (held), never as an installable advance.

### 2.6 Post-CAS abort → hold (r1-m4, B7)

`received-git-transition-commit.ts:388` becomes a typed hold that writes the
repository's apply deferral, which today's throw does not. It must not race the
rebind CAS at `:395`, so the deferral is applied as its own one-repo
carry-proof packet and its reloaded state is threaded into the loop's `state`
variable — the pattern `:386` already uses for a settled branch. The rebind CAS
then sees fresh state. `rebindHeldAttemptsAfterSettlement` is NOT widened to
author deferrals (held-attempt binding is not the deferral owner).

The refused repository's held attempt is deliberately SKIPPED: the ref loop
breaks before `:391-392`, so nothing is pushed to `attemptsToRebind`. Rebinding
would bind an attempt to a post-settlement state this repository never reached.
Leaving it unbound makes the next `steadySkip` fail closed on the stale nonce
and redo the follow — extra work, never a false skip.

Scope of "the batch continues" (m10): the refused REPOSITORY stops after one
deferral is recorded; the loop continues with the remaining repositories,
followed by the rebind. It is not a claim that the refused repository finishes
its remaining refs.

Sound because the batch CAS already committed and the refusal fires before
p-settlement's nested CAS: the module header's "resumable boundary, not a
rollback point" is honored, and nothing after the CAS falsifies the BASE it
committed.

### 2.7 Resolve legibility

1. Typed codes are raised at the five literal throw sites inside the resolve
   mutex body, in two classes:
   - `:1074` (incomplete checkout), `:1076` (journal could not be recovered),
     `:1078` (P settlement refused) are in the mutex body proper and
     emit-and-return a `refused` line directly.
   - `:931` (`manual lineage proof unavailable`) and `:1001`
     (`manual BASE proof is incomplete`) are BOTH inside `makeIntended`
     (`:929-1018`), a callback the follow executor invokes. They cannot emit
     and return; each throws a typed error CLASS that the `:1082` catch
     classifies into its code and curated message.
2. At `:1078` the curated text REPLACES `pSettled.error`: that string is a raw
   hold reason (`p-settlement.ts:158` stringifies arbitrary errors) and may
   carry filesystem paths, which today never reach output only because the
   catch-all swallows it.
3. **No new `--json` field.** The refusal contract is already
   `{status, verb, repo, code, message}` and `code` is already a code
   (`:1070` emits `code: follow.reason`); the five sites emit their own `code`
   instead of falling into the catch-all's `operation-failed`. r2's additive
   `reasonCode` would have been a second code field for the same question —
   dropped. The `toEqual` pin at `git-cmd.test.ts:1273` is the sync-busy case
   and is UNCHANGED by this.
4. The catch-all at `:1082` keeps its sanitized generic default for everything
   else. Raw `Error.message` is never printed.
5. Persisted deferral detail: `GitDeferral` (`sync-state-model.ts:169-180`)
   gains an OPTIONAL `detail?: string` plus its `GIT_DEFERRAL_FIELD_COVERAGE`
   entry (`codecs/coverage.ts:123-133`); old records decode with `undefined`.
   This is a state-shape change and is named as one.
   - **One author.** `detail` is curated at the DEFERRAL-WRITING site only —
     `nextDeferral` callers in the apply/settlement path pass an already-curated
     string; no renderer, projection, or codec may compose or extend it. A
     refusal that has no curated text writes no `detail`.
   - **Three projection sites, all required.**
     `sync-git/status.ts:39-45` declares `GitDivergenceStatus["deferrals"]`;
     `laneDeferrals` (`status-projection.ts:57-58`) builds it with a
     `{relPath: repo, ...deferral}` spread, so `detail` would ride along at
     runtime while being undeclared — it must be added to that type or it is
     contractually invisible on exactly one of the two paths.
     `status-projection.ts:332-338` narrows explicitly (`relPath`, `lane`,
     `reason`, `deferredSince`, optional `bytesChanged`) and DROPS anything not
     listed. `status-view.ts:414-428` builds the rendered row; a field absent
     there never reaches the renderer.
   - **Never folded into `displayReason`** (`status-view.ts:417`), which is a
     CODE consumed by `gitDeferralReasonPrecedence` (`:433`),
     `doctor-triage.ts:108`'s `REPOSITORY_PROVEN_HEALTHY` set, and the
     `activity.ts:435` telemetry line.
6. Step progress for take-theirs/keep-mine EXTENDS the shipped stderr seam
   (`resolve-command.ts:319-326`, `:568`, `:654-663`); stdout stays byte-clean
   for `--json`.

## 3. Protected contract

- A P NEVER mints a BASE family. The landing family is the incoming wire
  section verbatim; no GitSection field is synthesized.
- **Amended standing-P invariant** (`standing-branch-proof.ts:117-123`): *a
  standing P makes serialized positive BASE unavailable until exact settlement
  or bounded repair completes — except where NO BASE is serialized at all, in
  which case a full landing may serialize the FIRST BASE. That BASE is not an
  advance: it installs the value disk was observed to hold, which is the P's own
  `nextOid` in the wedged shape, or a later value that bounded P-repair then
  owns. No existing BASE is ever advanced while a P stands.* The transition's
  types already tolerate an absent BASE (`:23`, `:38`, `:112`, `:139`), so
  nothing else in its shape moves.
- Design-130's persisted-BASE write allowlist keeps ONE site. The commentary
  that names it (`follow-repo-transition.ts:58-62`, `:86-88`) is updated to say
  the site now composes under either of two authorities, not that a second site
  exists.
- `composeRepoBase` semantics, `GIT_SECTION_FIELD_COVERAGE`, pack-link
  advertisement (`git-state.ts:247-259`), republish gating: untouched.
- `ref-plane-publication.ts:160-161` keeps its stale-BASE hold for every record
  that HAS a BASE; only the BASE-less, already-at-incoming shape is exempted.
- Resolve output sanitization (`git-cmd.test.ts:1279-1308` — token/path/
  control-char redaction) is a protected contract, named and unchanged.
- The observed-landing safe-ref branch (`base-composer.ts:551-558`) runs BEFORE
  the `dir`/`all` scope gate (`:559`). Harmless today (the sole caller hardcodes
  `dir`/`all`); once §2.3 supplies a real `repoKind`/`effectiveRefScope` it
  would let safe refs install outside scope. Fixed in scope by moving the
  branch after the gate — behaviour-preserving for the existing caller and for
  `base-proof-authority.test.ts:198`.
- NEWLY REACHABLE consequence of that fix: a pointer or scoped repository
  (`repoKind !== "dir"` or `effectiveRefScope !== "all"`) whose incoming
  section names any safe ref takes `scope-refused` ⇒ `pending` ⇒ **no first
  BASE for that shape**. This is the same rule every other authority already
  obeys, not a new restriction; those repositories keep today's behaviour
  (pending section, deferral) rather than gaining the landing.
- NAMED ROW, not fixed here: `follow-journal.ts:59`'s legacy recovery still
  asserts `dir`/`all` regardless of the real repository — now passed
  explicitly through the new parameter rather than hidden in the constructor.
  Pre-existing; changing it changes journal-recovery behaviour and needs its
  own cycle.
- Origin-less first BASE: `composeRepoBase` mints no `BranchBaseOrigin` under
  observed-landing, and a BASE-less record has no prior origins to carry
  (`:518-522`). So the first BASE carries none, `recordOriginLineage` returns
  `undefined` (`:249-258`), later carry proofs stamp `legacy-untrusted`, and
  `prepareFollowerBranchProtocol` (`follower-protocol.ts:119`) builds tombstone
  attestations from an empty origin map — tombstoned deletions stay
  unattestable until each ref next moves through a pull-p. Safe direction
  (refuse/defer, never delete), and the same shape a legacy-adopted record
  already has.
- 200's locks/witnesses, 236 naming, 244 split, 270 held-skip: untouched.
- The rig scenario's `FIX_FLIPS` flip rides the PR; `FAST_SUITE` promotion is
  DROPPED from this design (separate decision with a recorded budget).

## 4. Validation

- **Rig flip, rescoped.** First post-rebuild pull: the serialized BASE covers
  EVERY incoming ref, AND — the part that makes a rename fail, not pass — any
  deferral that survives must name a ref whose DISK value differs from the
  incoming value. A deferral over a ref that is already at the incoming value
  fails the assertion whatever its reason string says. No exit 1, no
  `BASE disappeared`. Second pull: no deferral at all, and the standing P is
  retired.
- **Landing is all-or-nothing.** The held-ref fixture is pinned to a
  GENUINELY differing disk value (a local commit on one branch, so
  `oldOid !== newOid`): no BASE written, section stays pending, deferral names
  that ref. The `oldOid === newOid` companion fixture asserts the opposite —
  no held ref, no deferral, BASE lands (this is the §2.4 regression).
- **CAS-time withdrawal**: fixtures for (a) unreadable ref database, (b) a
  BRANCH ref moved and (c) a SAFE ref moved between composition and
  revalidation → BASE withdrawn, section pending, deferral
  `ref-read-unreadable` / `git-busy`, pull exits 0.
- **`base-absent` termination**: typed at every caller; reset refuses by name;
  P-repair's port still returns `rejected`; reachable for at most the one pull
  before the landing composition runs — proven by a two-cycle fixture. A
  record-less repository with a standing P takes the same landing path.
- **Post-CAS hold**: deferral written, remaining repositories settled, rebind
  CAS accepted, and the refused repository's attempt is absent from the rebind
  (proving the skip, not just the absence of a throw).
- **Journal**: a crash after `makeIntended` recovers a pending intent with no
  first BASE, and the following pull lands it. Asserted as two cycles, not one.
- **Resolve**: three emit-and-return codes plus two error classes classified at
  `:1082` reach stdout and `--json`; sanitization tests UNCHANGED and green;
  the `:1273` `toEqual` pin UNCHANGED; progress on stderr only; `detail`
  round-trips codec + coverage gate and reaches `rbox status` through all three
  projection sites.
- **Deployed-state self-heal, honestly re-derived.** The Mac's wedged
  rbox-core needs no jolt: the standing-P gate returns `landing`, §2.4 stops the
  false `local-commits`, and the follow lands the first BASE on the first
  post-deploy pull that carries a section for that repository. What settles the
  P afterwards is the next pull that ROUTES the repository through the follow
  path — `apply.ts:774` requires local divergence, checkpoint reproof, forced
  held refs, or `remoteChanged && baseSec`. Nothing schedules a follow for a
  quiescent repository, so the P can stand until that repository next changes.
  Verified acceptable: it writes nothing, is consulted only by
  `prepareFollowerBranchProtocol` on the follow path and by reset/resolve (all
  of which settle it), and the wedge is already gone because no deferral is
  written. The design does NOT claim the next scheduled pull retires it.
  Field close-out: BASE present with full ref coverage, 539/day line stops,
  git-apply residual ~3.6s → ~0 on both lanes, P retired on the next follow.
  Mac probe pre-merge (darwin rule).

## 5. Expected effect

Mac steady git-apply 4.4s → ~0.8s; #752 closes whole; the false
`local-commits` classification for already-landed refs stops; resolve UX debt
(3 papercuts) closes; reset stops being reachable-only-by-luck on this shape.

## 6. Where a review's shape did not survive verification

- **B3, same-pull settlement**: dropped rather than resolved. The
  `carryUnreadableRefDatabase:179-186` split exists to keep a
  `pull-ref-transaction` proof settling after its BASE was withdrawn; an
  observed-landing authority has no `branchWitnesses` at all, so there is
  nothing to put in `artifactSettlementProofs` without MINTING a settlement
  proof outside the follow path. Next-pull settlement costs one cycle and zero
  new code at three filter sites.
- **B5, `heldRefCount === 0` precondition**: not asserted, and after §2.4 it
  would have been actively wrong to assert — the landing shape used to mint a
  held ref. The invariant is observation-versus-candidate alone.
- **B1, invariant argument**: the landed value equals the P's `nextOid` only in
  the wedged steady shape. A newer section landing in the same pull makes it
  later, so §3's amended invariant covers both and hands the second case to
  bounded P-repair.
- **B1 anchors `:75`/`:103`**: those are `StandingRepairAttempt.effectiveRefScope`
  and `resumeAcceptedRepair`. The shape that tolerates an absent BASE is
  `:23`, `:38`, `:112`, `:139`.
- **B2/m5, `reasonCode`**: challenged and removed. `code` is already the code
  field.
- **m3 (r2), the reset clause**: dropped as factually wrong —
  `reset-state.ts:170` throws immediately on a hold; it never loops to the
  1,024 pass cap. Reset stays a refusal and unwedges via the pull.
- **R1 anchor `:159-160`**: the fallthrough is `:160-161`.
- **m7 (r3), only `:931`**: `:1001` is inside the SAME `makeIntended` callback
  (`:929-1018`), so it needs the identical error-class treatment. Two sites,
  not one.
- **m8 (r3), "the daemon's next scheduled pull settles the P"**: does not hold
  as stated. `apply.ts:774`'s `routeThroughFollow` requires a reason to follow;
  a quiescent repository is never re-followed, so the P persists harmlessly
  instead. §4 states the residual rather than claiming the schedule closes it.
