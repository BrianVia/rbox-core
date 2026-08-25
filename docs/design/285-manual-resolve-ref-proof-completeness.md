# 285 — manual resolve: every changed ref gets a decision (fix #829)

**Status:** v4 — codex round 2 amendments folded · **Blocks:** the v2.0.0 tag (founder
ruling 2026-08-25) · **Issue:** #829

## Problem

`rbox git resolve <repo> take-theirs` deterministically fails with
"the resolution may have partially applied and could not be fully proven"
whenever any ref differs between `record.base` and the incoming state
without an explicit decision reaching `composeRepoBase`. A missing decision
mints a `missing-branch-proof` hold (`base-composer.ts:503`), holds force
`disposition: "pending"` (`:595`), and the manual caller throws
`ManualBaseProofIncompleteError` (`resolve-take-theirs.ts:212`). One
orphaned ref fails the whole resolution.

The orphan gaps (all verified against source; codex round 1 narrowed them):

- **G1 — the current ref is skipped by publication outright**
  (`ref-plane-publication.ts:94`) and only earns a decision via a
  `checkoutBranchPlan` (tips must differ, `ref-plane-transaction.ts:171`)
  or the `manualBranchTerminals` fallback (`:244`), whose guard requires
  `incomingHeadRef === liveBefore.currentRef` AND `logicalBefore !== null`.
  HEAD on a different branch than incoming → orphan.
- **G2 — a `null` logical base is suppressed everywhere.** The fallback
  refuses it (`:248`), `no-p.beforeOid` is non-nullable
  (`base-composer.ts:115`, `follow-types.ts:79`), and the composer requires
  `before !== null` (`:471-477`). A null base predecessor conflates two
  physical states: (a) ref physically present at the candidate (base
  record merely never learned it — plausible fleet-wide after the v2
  crossover genesis), and (b) ref physically unborn (a real `null → oid`
  install).
- Side refs are NOT a gap: publication already mints terminals for
  non-current refs whose live value equals the candidate
  (`ref-plane-publication.ts:107-133`); genuinely divergent side refs land
  in `heldRefs` and are correctly refused.

Field confirmations (founder fleet 2026-08-25): Mac dynomite
(HEAD=incoming, planned) ✅ completes with verified quarantine; Mac
rbox-admin (HEAD off-incoming, G1) ❌; FM dynomite (HEAD=main, suspected
G2-null-base from crossover genesis) ❌ — identical failure live, settled,
and daemon-stopped.

Withdrawn from v1 (codex round 1): the exit-code fix (already exits 1 —
my field "exit=0" was a `$?`-after-pipe artifact; test at
`git-cmd.test.ts:1409` asserts 1) and the "move the check pre-publication"
claim (completeness already runs pre-checkout-commit inside `makeIntended`
during journal construction, `ref-plane-transaction.ts:277-289`; only
independent-ref publication precedes it, under the protected ref-first
recovery contract at `follow.ts:108-112`, which this design does NOT
touch).

## Fix

**Principle: the manual episode emits an explicit, race-protected decision
for every ref it consciously leaves in place; a ref it can neither plan
nor prove refuses BEFORE the checkout journal, naming the ref.**

### F0 — scope constraint (ox-alpha): current ref ONLY, no general sweep

Publication already owns terminal-minting for every non-current governed
ref (`ref-plane-publication.ts:131-133`); a general "enumerate all changed
refs" sweep at the transaction site would LAUNDER deliberately held refs —
the stale-BASE hold fires exactly when live==candidate with unclear
artifacts (`ref-plane-publication.ts:161-168`) — converting an
artifacts/ownership refusal into silent BASE acceptance. The fix is
therefore confined to the one producer publication cannot cover: the
current-ref skip (`:94`). Any future widening must exclude
`heldRefs ∪ classifiedHolds` explicitly.

### F1 — current-ref no-op terminal, properly guarded (G1)

In `ref-plane-transaction.ts`'s fallback (~:244): mint
`manualBranchTerminals[currentRef]` whenever ALL of:
- a positive effective candidate exists for the current ref;
- the physical live tip equals it;
- no `checkoutBranchPlan` owns the ref (existing exclusion stays);
- **the ref is reserved through the checkout boundary** (see F3).

The `incomingHeadRef === liveBefore.currentRef` conjunct is dropped: where
incoming HEAD lands is unrelated to whether the old current branch
deliberately remains at the candidate value (codex point 5).

### F2 — null logical base, split by physical state (G2)

- **Physically present at the candidate**: widen the no-op predecessor to
  `string | null` end-to-end — `manualBranchTerminals.beforeBaseOid`
  (`follow-types.ts:79`), `no-p.beforeOid` (`base-composer.ts:115`), and
  relax only the composer's `before !== null` restriction for `no-p`
  (`:471-477`; `requested !== null` stays). Reservation required as in F1.
- **Physically unborn**: build a real `checkoutBranchPlan` with
  `physicalBeforeOid: null` — `planManualBranchTransition` already accepts
  it (`branch-transition.ts:227`) and emits the CAS create + present
  artifact (`:295-323`); the composer's artifact branch already accepts
  `beforeBaseOid: null` (`:489-500`). Remove the `oldOid &&` suppression
  at `ref-plane-transaction.ts:171` for the manual path only.

### F3 — reservations + recovery coverage make the terminals proofs

Two windows to close (codex + ox-alpha independently):

The workspace mutex excludes the daemon, not external git writers
(`resolve-command.ts:153`, `resolve-take-theirs.ts:116`); real exclusion is
`refReservations` — checkout takes `<ref>.lock` with an expected-OID check
and holds it across commit (`checkout-txn.ts:798-815`, release `:1009`).
Every minted `manualBranchTerminals` entry must be added to those
reservations (`reserveRef(ref, terminal.afterOid)`) before checkout, so
`makeIntended`'s manufactured `artifactsClear/ownershipStable/reflogStable`
claims (`resolve-take-theirs.ts:162-173`) are lock-backed rather than
asserted. Race test required: a `git update-ref` attempted from the
lock-bound second-proof callback must not be able to alter a reserved
terminal's ref.

**Crash window — WITHDRAWN (codex round 2, verified in source):**
published-journal recovery is deliberately NOT an exact-match gate
(`journal.ts:~868`, design 200): observed-landing authority installs only
refs the repository was actually seen to hold — a journal claiming a ref
not on disk can never install it. Minted terminals are therefore no worse
off in the crash window than today's planned refs, and no recovery-side
change or test is needed. The claimed "boundary re-pin" was also unwired
even for the existing fallback (`boundaryInput` receives `progress`, not
`postProgress`, `ref-plane-transaction.ts:304`) — the claim is dropped
rather than plumbed; the reservation's `<ref>.lock` + expected-OID held
across commit is the pinning guarantee, with `secondProof`'s untouched-ref
check (`resolve-take-theirs.ts:43-71, 261-264`) as the in-process net.
Terminals still register in `appliedRefs` (matching `:246`) for parity
with the existing shape, without claiming boundary semantics for it.

**Base-record identity (ox-alpha):** the minted terminal's `beforeBaseOid`
must come from the same base view the composer validates
(`record.base` as surfaced to the transaction as `logicalBefore`) — never
from `branchProtocol.logicalBaseRefs` — so a divergence between the two
records cannot turn every terminal into a `manual-proof-mismatch` hold.

### F4 — residual holds are NAMED, not pre-checked (reshaped in round 2)

A separate pre-check throw in the fallback is the wrong shape: every
current-ref tip difference now earns a plan (F1/F2b), making that branch
unreachable, while residual holds can still arise elsewhere (e.g. F0's
preserved stale-BASE side-ref holds where live==candidate with unclear
artifacts). The honest-refusal mechanism is therefore AT THE COMPOSER
RESULT: when `composeRepoBase` returns non-terminal at the `makeIntended`
site, `ManualBaseProofIncompleteError` carries the holds (ref + code), and
`resolve-command.ts:~289` maps them to copy that names each ref and
discloses that the repo's other branches were already shared (independent
refs publish first by the protected `follow.ts:108-112` contract) while
<ref> and working files were not touched. The false "retry after Git state
settles" advice is deleted. New mapping + test at the command site.

### F5 — silence the red-herring log under manual resolution

Gate `logVetoOnce` on `!manualResolution` at `follow-classify.ts:217`.
Do NOT recompute `breadcrumbVetoGate` post-waiver-deletion — that would
change the returned classification field for automatic follow (codex
round 1). `breadcrumbVetoGate` itself is untouched.

## Validation

1. **Unit (first coverage for `manualBranchTerminals`)**: G1 off-HEAD
   no-op; G2a null-base-present no-op; G2b unborn install plan; F4 genuine
   conflict refuses pre-journal naming the ref; existing planned-path shape
   unregressed.
2. **Race test** (F3): update-ref from the second-proof window cannot move
   a reserved ref; resolution either completes against the reserved value
   or refuses — never composes a stale terminal.
3. **Rig**: two-VM scenario — HEAD on a side branch + one null-base ref;
   take-theirs completes; quarantine bundle heads verified; working files
   hash-identical.
4. **Field acceptance (tag gate)**: Mac `Personal/rbox-admin` resolves
   cleanly (confirmed G1 shape). FM `Personal/dynomite` — shape NOT yet
   confirmed (suspected G2 null-base) — must either complete or refuse
   with the named ref and the honest disclosure copy; a bare
   "may have partially applied" on any fleet repo fails acceptance. Mac
   `Personal/dynomite`'s working shape unregressed; the fleet campaign
   then completes with each repo resolved or honestly named.

## Non-goals

- No reordering of independent-ref publication (protected contract,
  `follow.ts:108-112`).
- No change to automatic follow / veto taxonomy semantics.
- No `--under` bulk take-theirs.
- No exit-code changes (already correct).
