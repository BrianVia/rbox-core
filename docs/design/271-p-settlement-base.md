# 271 — First BASE for BASE-less records, typed settlement refusals, resolve legibility

Status: DRAFT r3, folding the r2 serial-confirm review (B1-B7, m1-m10). Every
anchor below was re-read on `main @ b9bb83d5d`; where the review's suggested
shape did not survive that reading, §6 records what replaced it.

r1's central mechanism stays REFUTED: a P cannot mint a BASE family
(`base-composer.ts:593` picks `previous.base` or `candidate.base` and re-refs
it; nothing is synthesized), and a minted family would advertise
never-uploaded pack links (`git-state.ts:247-259`).

## 1. Problem (as verified)

Fresh-join re-baseline leaves a repo record with a standing create-shaped P and
NO serialized BASE. Three facts compose into the wedge:

1. **The follow can never earn a first BASE.** With no BASE, `previousRefs` is
   `{}`, so for every incoming ref `before (null) !== requested` and
   `composeRepoBase:503-510` demands a per-ref witness. A follow only witnesses
   refs it MOVES, so every unmoved ref takes `missing-branch-proof` →
   `pending` → `family = previous.base = undefined` (`:592-597`) → no BASE is
   ever serialized.
2. **The standing-P gate fires before that composition anyway.**
   `apply.ts:857` → `settleExactPresentArtifact`, whose entry pre-check
   tolerates the absent BASE (`p-settlement.ts:73-75`: create-shaped P has
   `priorOid === null`, `currentBase` is `null`) and whose transaction then
   throws `P settlement BASE disappeared` (`:101`) → `{status:"hold"}` (`:161`)
   → `standing-branch-proof.ts:170-171` `held(...)` → `apply.ts:887-890`
   `defer(..., "artifact")`. The follow composition at `apply.ts:924` is
   NEVER REACHED. This is the 539/day `artifact` deferral on the Mac
   (~3.6s/cycle).
3. **Front doors mirror the refusal.** The post-CAS settlement throws
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

`settleExactPresentArtifact` gains ONE entry test before `:74`: a record with
no `base` at all returns `{status:"hold", code:"base-absent"}` without opening
the transaction. The in-transaction throw at `:101` is untouched — BASE
vanishing under the held locks is a concurrent-loss anomaly, not a
never-had-BASE record, and it keeps its generic hold.

Per-caller behaviour under the new code:

| caller | today | under `base-absent` |
|---|---|---|
| `standing-branch-proof.ts:171` | `held` → apply defers | new `kind:"landing"` result (below) |
| `received-git-transition-commit.ts:388` | throws, aborts pull | §2.3 hold |
| `reset-state.ts:170` | throws `unpreservable P` | unchanged; message names the code |
| `resolve-command.ts:511` | `{status:"hold"}` | unchanged; §2.4 gives it a code |
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

The P is left standing. It settles on the NEXT pull through the ordinary gate
(BASE now exists, `refs[ref]` equals its `nextOid`), or — if a newer section
landed in between — through bounded P-repair, whose `preserve-third`
disposition (`base-composer.ts:456-457`) concludes it. Same-pull settlement is
DROPPED; see §6/B3.

### 2.3 First BASE via a follow-time observed-landing composition

The composition site does not move: `composeFollowAuthority` /
`advanceFrom` in `follow-repo-transition.ts` remains the one persisted-BASE
construction site (its own `:58-62` contract), so design-130's allowlist keeps
counting exactly one. What changes is which authority it mints.

`FollowCommitInput` gains one optional field, built by the caller as the
module's contract requires:

```ts
readonly landingObservation?: Readonly<Record<string, string>>;
```

`followBaseProof` mints `observedLandingRepoBaseProof`-shaped authority
(`base-composer.ts:634-643`) when, and only when, `prior.base === undefined`
AND the observation is present; otherwise it mints today's
`pull-ref-transaction` authority unchanged. Its `lockedProof` is built from
`FollowTransitionIdentity` (`repoKind`, `effectiveRefScope`) — NOT the
`{repoKind:"dir", effectiveRefScope:"all"}` literal that
`observedLandingRepoBaseProof` hardcodes for the legacy journal caller.

The observation is `readAllRefsStrict(repoDir)` taken after this execution's
ref phase. Ordering obligation: `followComposition()` reads a value that is
`undefined` until that read succeeds, so every composition taken earlier —
including the journal intent via `makeIntended` (`apply.ts:1004`) — composes
exactly as today (pending, no BASE). A journal that lands later still gets its
first BASE from the legacy observed-landing recovery path
(`follow-journal.ts:55-63`); the two paths converge on the same authority kind.

Safety comes from the composer, not from new checks. `composeRepoBase:389-395`
installs a candidate ref only where it equals the observation and pushes
`missing-branch-proof` otherwise; any hold ⇒ `pending` ⇒
`family = previous.base = undefined` ⇒ **no first BASE**. So the first BASE
lands only when EVERY governed ref landed at its incoming value, and it can
never claim a value the repository was not seen to hold. A held ref (local
commits, ownership) therefore blocks the landing by construction; no separate
`heldRefs`-empty precondition is needed or asserted.

The landed family is `remoteSec` verbatim. No GitSection field is synthesized.

### 2.4 CAS-time reachability of the observation

`revalidateCommittedBranchProofs:216` currently skips every non-
`pull-ref-transaction`/`journal-recovery` proof, which would leave the landing
observation never re-read under the state-CAS boundary. It gains one branch for
`observed-landing`: re-read `readAllRefsStrict`, and if the database is
unreadable OR any branch ref of the composed BASE no longer equals the
observation, WITHDRAW — never throw. Withdrawal reuses
`carryUnreadableRefDatabase:161-205` verbatim (candidate → pending, prior BASE
restored — for a BASE-less record that means no BASE at all, `:172` —
`repoProofs` demoted to a carry proof, `artifactSettlementProofs` keeping the
real proof, partial dropped, apply deferral written), parameterized only by the
deferral reason: `ref-read-unreadable` for an unreadable database, `git-busy`
for a moved observation (a concurrent writer moved a ref inside the CAS window;
that is what `git-busy` names).

No new CAS locks are planned. `planStateCasLocks:134-147` and
`settleCommittedBranchArtifacts:349/:361` keep their filters unchanged: an
observed-landing authority carries no `branchWitnesses`, so there is nothing
for them to lock or settle. The residual race — a ref moving between the
revalidation read and the CAS commit — records that ref at its pre-move value.
That is the safe direction: BASE is never newer than what disk was seen to
hold, and a stale BASE ref is classified by the next pull as ordinary local
divergence (held), never as an installable advance.

### 2.5 Post-CAS abort → hold (r1-m4, B7)

`received-git-transition-commit.ts:388` becomes a typed hold that writes the
repository's apply deferral, which today's throw does not. It must not race the
rebind CAS at `:395`, so the deferral is applied as its own one-repo
carry-proof packet and its reloaded state is threaded into the loop's `state`
variable — the pattern `:386` already uses for a settled branch. The rebind CAS
then sees fresh state. `rebindHeldAttemptsAfterSettlement` is NOT widened to
author deferrals (held-attempt binding is not the deferral owner).

Scope of "the batch continues" (m10): the refused REPOSITORY stops — its ref
loop breaks after one deferral is recorded — and the loop continues with the
remaining repositories, followed by the rebind. It is not a claim that the
refused repository finishes its remaining refs.

Sound because the batch CAS already committed and the refusal fires before
p-settlement's nested CAS: the module header's "resumable boundary, not a
rollback point" is honored, and nothing after the CAS falsifies the BASE it
committed.

### 2.6 Resolve legibility

1. Typed codes are raised AT the five literal throw sites inside the resolve
   mutex body — `:931` (`manual lineage proof unavailable`), `:1001`
   (`manual BASE proof is incomplete`), `:1074`
   (`incomplete checkout`), `:1076` (`journal could not be recovered`),
   `:1078` (P settlement refused) — each emitting a `refused` line with
   curated, non-developer-bar text. At `:1078` the curated text REPLACES
   `pSettled.error`: that string is a raw hold reason (`p-settlement.ts:158`
   stringifies arbitrary errors) and may carry filesystem paths, which today
   never reach output only because the catch-all swallows it.
2. **No new `--json` field.** The refusal contract is already
   `{status, verb, repo, code, message}` and `code` is already a code
   (`:1070` emits `code: follow.reason`); the five sites simply emit their own
   `code` instead of falling into the catch-all's `operation-failed`. r2's
   additive `reasonCode` would have been a second code field for the same
   question — dropped. The `toEqual` pin at `git-cmd.test.ts:1273` is the
   sync-busy case and is UNCHANGED by this.
3. The catch-all at `:1082` keeps its sanitized generic default for everything
   else. Raw `Error.message` is never printed.
4. Persisted deferral detail: `GitDeferral` (`sync-state-model.ts:169-180`)
   gains an OPTIONAL `detail?: string` (curated text, never raw errors) plus
   its `GIT_DEFERRAL_FIELD_COVERAGE` entry (`codecs/coverage.ts:123-133`); old
   records decode with `undefined`. This is a state-shape change and is named
   as one. Its status projection is a CONTRACT, not a consequence:
   - `status-projection.ts:332-338` builds an explicit narrowed projection
     (`relPath`, `lane`, `reason`, `deferredSince`, optional `bytesChanged`);
     a field not added there renders nowhere, on either the computed or the
     daemon-projected (`:312`, `:373`) path.
   - `detail` must NEVER be folded into `displayReason`
     (`status-view.ts:417`), which is a CODE consumed by
     `gitDeferralReasonPrecedence` (`:433`), `doctor-triage.ts:108`'s
     `REPOSITORY_PROVEN_HEALTHY` set, and the `activity.ts:435` telemetry line.
     It is a separate optional field the renderer appends.
5. Step progress for take-theirs/keep-mine EXTENDS the shipped stderr seam
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
- `composeRepoBase` semantics, `GIT_SECTION_FIELD_COVERAGE`, pack-link
  advertisement (`git-state.ts:247-259`), republish gating: untouched.
- Resolve output sanitization (`git-cmd.test.ts:1279-1308` — token/path/
  control-char redaction) is a protected contract, named and unchanged.
- The observed-landing safe-ref branch (`base-composer.ts:551-558`) runs BEFORE
  the `dir`/`all` scope gate (`:559`). Harmless today (the sole caller hardcodes
  `dir`/`all`); once §2.3 supplies a real `repoKind`/`effectiveRefScope` it
  would let safe refs install outside scope. Fixed in scope by moving the
  branch after the gate — behaviour-preserving for the existing caller and for
  `base-proof-authority.test.ts:198`.
- NAMED ROW, not fixed here: `follow-journal.ts:59`'s legacy recovery still
  hardcodes `dir`/`all` in its `lockedProof` regardless of the real repository.
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

- **Rig flip, rescoped**: the green side asserts the specific invariant — an
  `(lane: apply, reason: artifact)` deferral over an absent BASE never survives
  a pull that lands every incoming ref — not deferral-generality. First
  post-rebuild pull: BASE present covering every incoming ref, no exit 1, no
  `BASE disappeared` line. Second pull: the standing P settles and retires.
- **Landing is all-or-nothing**: fixture with one held ref (local commits) over
  a BASE-less record → no BASE written, section stays pending, deferral reason
  is the held reason, and the next full landing still succeeds.
- **CAS-time withdrawal**: fixtures for (a) unreadable ref database and (b) a
  ref moved between composition and revalidation → BASE withdrawn, section
  pending, deferral `ref-read-unreadable` / `git-busy`, pull exits 0.
- **`base-absent` termination**: typed at every caller; reset refuses by name;
  P-repair's port still returns `rejected`; and the code is reachable for at
  most the one pull before the landing composition runs — proven by a
  two-cycle fixture, not by argument.
- **Post-CAS hold**: deferral written, remaining repositories settled, rebind
  CAS accepted (proving the state-threading, not just the absence of a throw).
- **Resolve**: five typed codes reach stdout and `--json`; sanitization tests
  UNCHANGED and green; the `:1273` `toEqual` pin UNCHANGED; progress on stderr
  only; `detail` round-trips codec + coverage gate and appears in `rbox status`
  through the narrowed projection.
- **Deployed-state self-heal, honestly re-derived**: the Mac's wedged
  rbox-core needs no jolt IF its first post-deploy pull is a full landing — the
  standing-P gate now returns `landing` instead of deferring, and the follow
  composes the first BASE. If any ref is held at that moment, the pull defers
  with the held reason (not `artifact`) and heals on the first later pull that
  lands everything. The `artifact`-over-absent-BASE loop cannot recur either
  way. Field close-out: BASE present with full ref coverage, P retired within
  two cycles, 539/day line stops, git-apply residual ~3.6s → ~0 on both lanes.
  Mac probe pre-merge (darwin rule).

## 5. Expected effect

Mac steady git-apply 4.4s → ~0.8s; #752 closes whole; resolve UX debt (3
papercuts) closes; reset stops being reachable-only-by-luck on this shape.

## 6. Where the r2 review's shape did not survive verification

- **B3, same-pull settlement**: dropped rather than resolved. The
  `carryUnreadableRefDatabase:179-186` split exists to keep a
  `pull-ref-transaction` proof settling after its BASE was withdrawn; an
  observed-landing authority has no `branchWitnesses` at all, so there is
  nothing to put in `artifactSettlementProofs` without MINTING a settlement
  proof outside the follow path. Next-pull settlement costs one cycle and zero
  new code at three filter sites; the same-pull claim cost a minted proof plus
  a lock-planning widening. Smaller wins.
- **B5, `heldRefCount === 0` precondition**: not asserted. The
  `heldRefCount === 0` ⇒ `artifact` implication at
  `follow-repo-transition.ts:333` is sound but runs the wrong way for the Mac,
  whose deferral is minted at `apply.ts:889` (where the follow never ran, so
  held refs are unobserved). The composer already enforces the stronger
  property — any held ref means the ref is not at its incoming value, so the
  observation holds and no BASE lands — so §2.3 relies on that instead of on a
  precondition.
- **B1, invariant argument**: the landed value equals the P's `nextOid` only in
  the wedged steady shape. A newer section landing in the same pull makes it
  later, so the amended invariant in §3 covers both and hands the second case
  to bounded P-repair.
- **B1 anchors `:75`/`:103`**: those are `StandingRepairAttempt.effectiveRefScope`
  and `resumeAcceptedRepair`. The shape that actually tolerates an absent BASE
  is `:23`, `:38`, `:112`, `:139`.
- **B2/m5, `reasonCode`**: challenged and removed. `code` is already the code
  field; a second one would answer the same question twice.
- **B6**: taken both ways — the safe-ref ordering is fixed in scope (it is two
  lines and we are the ones making it load-bearing), and the legacy
  `follow-journal` hardcode is a named protect-and-defer row.
- **B7**: state-threading (`:386` pattern) chosen over folding into the rebind
  packet, to keep deferral authorship out of `held-skip.ts`.
- **m3, the reset clause**: dropped as factually wrong — `reset-state.ts:170`
  throws immediately on a hold; it never loops to the 1,024 pass cap. Reset
  stays a refusal, and unwedges via the pull, not via itself.
