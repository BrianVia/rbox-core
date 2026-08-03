# Design 200 v4 — Codex round 3 alignment review

Date: 2026-07-24

Verdict: **NOT-ALIGNED**

R4 is recorded honestly. The document does not pretend the restore hole, pin schema, pin
expiry, or listing problem was mechanically fixed: §3.0a says a careful in-place restore can
lose branch pointers fleet-wide with no tripwire, pin, or stopping count; §13.2 calls B3
“not closed — accepted” and M3/M4 “moot”; §§3.5, 3.7, 7.1, 7.2, 9.4, and 12 retain the
superseded history with dates. That product ruling is respected in this review. None of the
new blockers below asks for a threshold, recovery pin, or listing command.

## Round-2 findings

- **NOT-CLOSED (superseded by R4) — R2 prior #1 / R1 blocker 1.** The false follower-pin premise remains repudiated; v4 changes the product promise instead of claiming the Git recovery mechanism was fixed.
- **CLOSED — R2 prior #2, lossy ref read at the design level.** All deletion-authority reads are routed to a strict result; the runner contract still has M1 below.
- **CLOSED — R2 prior #3, carried-value `publisher-ack` provenance.** A carrying repository never settles, so the ACK cannot mint an origin for a carried value; the self-echo consequence is a new blocker, not provenance laundering.
- **NOT-CLOSED — R2 prior #4 / B2, control-flow and crash completion.** A′ is above the unchanged shortcut, but BASE-retired → push-not-published still resurrects the branch on the next pull.
- **NOT-CLOSED (accepted by R4) — R2 prior #5 / B3, restore cause.** The careful in-place-restore hole remains; v4 accurately calls it an accepted product residual rather than a fix.
- **CLOSED — R2 prior #6, P3 destructive boundary.** The content-equivalence waiver remains structurally barred from deletion and non-fast-forward transitions.
- **CLOSED narrowly — R2 prior #7, hybrid accepted-ACK state.** Mutual exclusivity removes the impossible hybrid BASE, deep-equality contradiction, and hybrid-chain coverage error; P4 itself still fails for independent reasons below.
- **CLOSED — R2 prior #8, P2/P3 wedge claims.** The document consistently says P4 alone is intended to ungag unrelated publication.
- **CLOSED narrowly — R2 prior #9, rollback inherited from the hybrid.** No hybrid BASE remains to unwind; the new P4 failures make the feature unshippable before rollback is reached.
- **CLOSED — R2 prior #10, deletion-version floor.** `04c2aff8` first appears in `v1.6.8`, and the old-client deletion behavior is still described correctly.
- **NOT-CLOSED (moot under R4) — R2 prior #11 / M3, recovery discovery and persisted pin facts.** No pin or listing ships; v4 says this is moot and preserves the schema/eviction facts without calling them solved.
- **CLOSED — R2 prior #12, doctor privacy boundary.** The new paths remain in a typed local-only projection and the bundle gets a path-free projection.
- **CLOSED — B1, exact receipt binding.** Requiring `receipt.priorOid === pending.refs[R]` closes the cross-value supersession bug; the mismatch path creates `P + R=Y` while retiring A/Z (`branch-transition.ts:136-176`), composes a `pull-p` origin at `Y`, and a later deletion can mint A(Y) without an immediate capture-gag loop.
- **NOT-CLOSED — B2, existing-A crash recovery.** A′ fixes only A-written → BASE-not-retired; it does not make the deletion handoff durable through BASE-retired → server-omission-not-published.
- **NOT-CLOSED (accepted by R4) — B3, small/careful restore.** The mechanism remains open by founder ruling, and the document states the residual plainly.
- **CLOSED narrowly — B4, the three v3 partial-settlement failures.** Keeping BASE wholesale closes the invalid deep-equality/hybrid-bundle/lost-ACK-CAS algebra. It does not make the replacement P4 state machine achieve its goal.
- **NOT-CLOSED — M1, stable strict-read API.** `gitStatus` is specified inconsistently and cannot preserve `gitRaw`'s exact current failure shape with the proposed normalized result.
- **CLOSED narrowly — M2, a value-level representation for carried absence.** A sorted ref-name list can encode absence without a wire sentinel; the operational partition using that list is incomplete (new major below).
- **NOT-CLOSED (moot under R4) — M3, `pinned:false`/deletion provenance.** Correctly recorded as moot, not fixed.
- **NOT-CLOSED (moot under R4) — M4, expiry starvation.** Correctly recorded as moot, not fixed; v4 explicitly preserves the fact that `expireTombstoneKeepPins` has no production caller.
- **CLOSED — M5, threshold contradiction.** The normative sweep is complete: no live absence-count predicate remains, and every old formula is dated historical text superseded by R4.

## New findings

### BLOCKER 1 — P4's self-echo re-gags every captured branch after one emit

Mutual exclusivity lets the first unrelated update publish, but it prevents the publisher
from accepting its own proof on the next pull.

Let BASE contain `D=X`, let pending have held `H`, and let local `D=Z`. The first merged
section M carries H and captures `D=Z`. Its ACK deliberately retains pending, restores the
old BASE wholesale, and mints no origin (`sync/push.ts:926-944`,
`sync-git/plan.ts:1155-1166`, design §4.4a).

On the next pull, `remoteSec=M` and live `D=Z`. The equality path sees
`logicalBaseOid/baseOid=X`, not Z, and has no P/A witness. It therefore executes:

```ts
heldRefs[ref] = "local-commits"; // equality cannot invent branch P/A authority.
```

at `follow.ts:848-895`. If local D later advances to Q, the ownership proof also treats Q as
unowned by incoming Z, so P4 carries Z. D publishes past H once and then freezes. This
directly falsifies §5 and the rig requirement at §9.6:2410-2416, and §9.5's claim that the
self-echo recomputes “the same held set.”

The design needs durable/self-echo authority for the captured partition, without granting
authority to the carried partition. “No origin for any ref of a carrying repository” and
“captured refs continue publishing” cannot both hold with the current follower.

### BLOCKER 2 — A′ is not idempotent across a second crash or failed push

Start with durable A(X), serialized `BASE[R]=X`, physical R absent, and the server still
advertising X. A′ correctly runs above `apply.ts:873-879` and retires BASE. Now crash—or
merely fail the push—before the omission is accepted remotely.

On the next pull, BASE is absent, A has normally been compacted to Z after state save
(`pull.ts:378-413`, `apply.ts:1962-1970`), and this device's own stale remote still says
`R=X`. `prepareFollowerBranchProtocol` deletes R from `logicalBaseRefs` for either A or Z
(`follower-protocol.ts:86-108`). The ordinary follow then plans
`beforeOid:null → afterOid:X`; `branch-transition.ts:105,136-176` accepts the creation and
atomically retires A/Z. No other writer won a race: the deleting device inverted its own
durable receipt because its push had not completed.

This violates invariant 2 (§7:2000-2003), which says an interrupted receipt is completed
and “never inverted into a creation.” It also affects the first A capture, not only A′:
same-cycle pull-then-push is not an atomic durability boundary. A durable
“omission still owed” state, or an equivalent pre-apply suppression until a remote omission
is observed, is required.

### BLOCKER 3 — the refs-only splice is not operationally compatible with v1.6.8

The wire schema is compatible: v1.6.8 already knows every `GitSection` field and
`packChain`, and no `carriedRefs` field goes on the wire. Operational compatibility is
false.

M copies pending's index/indexTree/op-state but moves pending's current bundle into a
historical chain link (§4.4.0(d/e)). Both v1.6.8 and current
`importGitPackChain` skip a historical link when its commit tips are already present,
explicitly relying on the invariant that restored index/op-state objects belong only to the
**current** link (`v1.6.8:src/engine/git/shared.ts:493-506`; current
`shared.ts:529-540`). A receiver can have every pending commit tip while lacking a
staged-only blob. It then skips the only bundle containing that blob; M's current bundle
contains the publisher's local staged objects, not pending's.

Thus a v1.6.8 reader parses M but can fail to restore it. Either restrict P4 to non-ref
facets with no pending-only object dependency, or supply a composition that preserves the
old reader's current-link invariant.

### BLOCKER 4 — M excludes BASE prerequisites that its chain does not carry

The proposed current bundle uses locally-present
`gitSectionTips(pending) ∪ gitSectionTips(base)` as negative basis, but
`M.packChain` contains only pending's chain plus pending's newest link (§4.4.0(e)).
Every basis becomes a `^tip` exclusion at `capture.ts:296-304`.

A BASE-only tip therefore can be excluded without being present in M's chain. Concrete
case: BASE/all has `D=X`, pending/scoped omits D, and §4.4.0(a) publishes local D while M
retains pending's `refScope`. M advertises X (or a descendant whose bundle declares X as a
prerequisite), but a fresh receiver has neither X nor a chain link containing it. The
section is unimportable.

Every negative basis tip must be proved covered by the emitted chain; otherwise it must not
be excluded. The fresh-import test in §9.5 covers a pending carried tip but misses this
BASE-only case.

### BLOCKER 5 — repeated self-echo consumes `MAX_PACK_CHAIN` and permanently disables P4

Even if blocker 1 gained a valid self-echo proof, the chain grows monotonically:

```text
M.packChain = pending.packChain + newestLink(pending)
```

The next pull replaces pending with M, so each merged emit adds another link. Starting at
chain length zero, lengths 1 through 7 are valid; the next cycle trips
`pending.packChain.length + 2 > MAX_PACK_CHAIN` and falls back to whole-section carry
forever while the hold remains. A pending section already at length 7 disables P4
immediately. This contradicts the multi-day/7-day bake narrative and the stated recurring
cost analysis. The design needs bounded compaction or a self-echo/unchanged-captured path
that does not re-chain, plus a proof for how later local changes still advance.

### BLOCKER 6 — a receipted pending HEAD can make M invalid

§4.4.0(a) omits a receipted-absent pending ref, while §4.4.0(d) copies `pending.head`
verbatim. The claim that this cannot omit the HEAD branch confuses local HEAD with pending
HEAD: §3.3 rule 7 rejects the **local current** symref target, not the branch named by
`pending.head`.

If local HEAD is Q, pending HEAD is R, pending has `R=X`, and local R has an exact A(X),
composition omits R but keeps `head: ref: refs/heads/R`. Current and v1.6.8
`validateGitSection` reject that exact shape (`manifest-validate.ts:380-392`; v1.6.8
lines 349-361). P4 must carry/refuse when the pending symbolic HEAD target would be
omitted, and test the case.

### MAJOR 1 — P1b and A′ do not define a usable settled-Z receipt projection

The ordinary successful pull compacts A to Z before push (`pull.ts:413`), but current
`absenceWitnesses` is populated only from live A entries
(`follower-protocol.ts:86-100`). The settled loop marks
`settledAbsence="valid-owning"` and deletes logical BASE but supplies no witness or
`priorOid` (`:105-108`). `pendingSupersessionPreProbe` also receives only
`root, relPath, pending` (`pending-supersession.ts:87-91`).

`lookupSettledAbsence` exposes the needed `BaseAbsentPayload` (`base-artifacts.ts:442-445`),
so this is fixable, but the design must define one current-lineage A/Z receipt projection
and feed it to both the pre-probe and final proof. As written, a literal implementation can
miss the normal Z receipt and carry forever.

### MAJOR 2 — A′'s locked proof is not connected to state-save revalidation

A′ says “fresh locked second proof” but writes no ref artifact and does not say how that
observation remains authoritative until the BASE CAS. Existing pre-state-save terminal
revalidation handles only `pull-ref-transaction` and `journal-recovery`
(`apply.ts:1899-1919`). A new `local-absence` authority would currently be skipped.

If R is recreated after the verify-only proof releases its lock but before state save, the
result is BASE absent + live R + owning A/Z. Specify the lock lifetime and add
`local-absence` to terminal revalidation using the strict reader and exact A/Z target and
binding.

### MAJOR 3 — `gitStatus` has two incompatible fault contracts

§3.3a says “spawn/IO faults still reject,” but also says a child that never ran returns a
structured failure with `code:null`, and specifically maps exec-path ENOENT/maxBuffer/signal
to that result. Current execFile ENOENT has string `code:"ENOENT"`; current spawn maxBuffer
and error paths do not have the same shape (`shared.ts:169-177,195,214,217,232-239`).

Once `GitRunResult` retains only `number | null`, `gitRaw` cannot recreate today's exact
`message` and `code`, contrary to §9.6:2405-2409. Preserve a raw compatibility cause/code
internally, or drop the byte-identical claim and audit callers; state once whether spawn/IO
faults reject or become data.

### MAJOR 4 — the carried/captured partition is not total

§4.4.0(a) says the universe is `pending.refs`, but its carried-absence test requires a ref
present in neither `pending.refs` nor `section.refs` (§9.5:2332-2336). The algorithm cannot
discover that row from the stated universe. Likewise,
`capturedRefs = Object.keys(section.refs) \ carriedRefs` omits every captured absence, even
though tombstone authorship is said to run only for captured refs.

Define an explicit universe including pending, BASE, local/candidate, and held names, then
classify captured-present, captured-absent, carried-present, and carried-absent. Persisted
`advertisedCarried` also needs sorted-unique valid-ref validation because it gates destructive
tombstone authorship.

### MAJOR 5 — P4 reverse migration does not state when carried authorship state becomes safe to clear

Constraint 3 says persisted `record.advertisedCarried` is required to stop a later
normalization from authoring a tombstone for a relayed value. The reverse migration then says
the field outlives the flag but “the tombstone-authorship bar simply finds an empty set”
(§11:2556-2559). Those statements are incompatible without a proved exact-carry barrier and
an atomic clearing point after every carried value has been physically applied.

Specify that lifecycle. A binary downgrade cannot read the new local-only field, so the
compatibility argument must prove from pending/BASE state that old normalization cannot run
until the values are locally authoritative; “absent ⇒ empty” only prevents a fault, not a
false tombstone.

## Shortest blocking list

1. Make the deletion handoff durable across BASE retirement followed by crash/push failure.
2. Give P4 a self-echo authority that preserves the captured partition without granting
   authority to carried refs.
3. Redesign M so it is always valid, v1.6.8-importable, prerequisite-complete, and bounded
   under repeated self-echo.

**NOT-ALIGNED.**
