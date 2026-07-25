# 200 — Worktree lifecycle resilience: capturing out-of-band branch deletion

Status: DESIGN v11 — 2026-07-25. **v11 is a subtraction round: §12 C3 is WITHDRAWN and the entire
§3.2c field apparatus is deleted.** Codex round 9 (`REVIEW-200-R9-CODEX.md`, kept beside this file)
returned NOT-ALIGNED with four blockers. **Three of the four landed in §3.2c's arm/merge/clear
lifecycle** — B1 same-ref generations, B2 the legacy/degraded state writer, B4 the hard-cap overflow
latch — and the fourth, B3, landed in §3.2b step D's own bookkeeping. Counting C3's findings across
rounds 6, 7, 8 and 9 gives **twelve**, and no round left its lifecycle correct as written. Every
blocker of the last four rounds landed in one of the two mechanisms v8 and v9 added; **the v7 core has
now been untouched for four consecutive rounds.** Round 9 additionally **CLOSED** `sourceGlobalSeq` and
`gitPlan.captured` as strict-read evidence.

**So v11 stops repairing it.** Under the founder's ruled principles — *"some math is just not gonna
prevent it; there's always a gap"*, **rbox promises FILE history, not Git history**, and **no pins, no
thresholds** (all R4, §3.0a) — the proportionate answer to a one-branch-pointer loss inside one crash
window is to **state the residual, not to defend it with a persisted field that has failed four review
rounds**. Deleted: `record.absencePublicationAttempt` and its types, its state-source lane and merge
instruction, its pre-POST arm, amendments 1/1b/2/3, drop conditions 1–3 and their evaluation sites, the
push-entry reconciliation, the hard cap and its overflow disposition, the termination derivation and
latch test, and **every `forcedHeldRefs` install this design proposed**. Four things v11 does:

1. **The residual is stated, and it is the design's answer to the race.** *A crash inside the window
   between an accepted POST and its state CAS, **plus** a local re-creation of the deleted branch at
   **exactly** the OID the accepted tombstone names, before this device's next pull, lets the apply lane
   consume this device's own accepted tombstone against the re-created ref — deleting that ref locally,
   **once**.* Every conjunct is cited to code in §3.2c, including why a re-creation at any other OID is
   hard-vetoed (`tombstone-attestation.ts:102-105`) and why the loss **does not recur without another
   crash**: the prune's own apply pass retires `BASE[R]` under `pull-ref-transaction` authority
   (`apply.ts:1258-1275`, invariant 11's first arm), so the race's precondition is consumed by the loss;
   and if *that* state save is also lost, the next pull retires BASE with no ref left to delete
   (§3.6 case (c)), so nothing latches.
2. **Recovery path 1 is VERIFIED to fire on this exact path, not assumed.** The self-consumption goes
   through the same design-116 prune-with-pins transaction as any follower prune — nothing filters
   tombstones by author (`GitRefTombstone` has no publisher field, `src/engine/types.ts:71-75`) — so
   `follow.ts:947-949` calls `prepareTombstonePrunePins`, which creates `refs/rbox-local/keep/<oid>` for
   the pruned tip **and every other OID in that ref's reflog** (`keep-pins.ts:635-654`) in the **same**
   prepared `git update-ref` transaction as the delete (`branch-transition.ts:119`). There is no window
   in which the ref is gone and the pin is not. The other two paths are the user's HEAD reflog (only
   when the re-creation was a checkout — stated honestly) and file history, the ruled contract.
3. **Round 9's blocker 3 is a real step-D bug and is fixed on its own merits, because it never was
   about C3.** The hidden-anchor route reaches step D by *clearing* the removal memory
   (`plan.ts:604`), and the planner publishes that cleared map as `gitReposRemoved` (`:284`) into both
   push saves (`push.ts:669`, `:993`) — so discarding the capture without restoring the memory drops
   `removedKey` and **reprojects the hidden BASE as active** (`sync-state-model.ts:458`), after which
   the next refusal carries a stale pre-removal section. §3.2b now requires the discard to *remove*
   rather than replace, and the removal suppression to be **restored to its prior key**; §9.1 asserts
   the state save, not only the planner output.
4. **The sweep items are closed.** Round-9 **major 1** — the structural pin and its test are qualified
   with effective `refScope === "all"`, which is what makes them consistent with §3.2b's own scoped
   partition (§3.2b, §9.1). **Minor 1** — the row that ran withdrawn machinery goes with the machinery.
   **Minor 2** — the `deletion-pending` consumer inventory is **fifteen** sites and the prose now says
   so everywhere (header item 5 below, §3.6, §5.2). **v11 carries no UNVERIFIED claim.**

*v10's header, compressed to the record.* v10 was the final-mile round on the two mechanisms v9 rebuilt.
Its items 1 and 2 — amendment 2's overlapping attempt generations, and amendment 3's affirmative
capture-bound clear with condition 1 at the composition boundary — are **withdrawn with the field**.
Its item 3 **survives in full**: step D's active-BASE gate (`repoAbsent` / `removedKey` retain
`record.base` as a hidden anchor, `sync-state-model.ts:455-458`, so the `pending[rel] ?? base[rel]`
fallback needs the gate to be total) and step D's **typed** `deletion-pending` capture-lane producer
(`captureReason` is a regex classifier that would have shown `other`, or `artifact` for any detail
containing the word *capture*). So does round 8's minor: every non-normative summary says **the existing
per-repository carry machinery** and names `revertCapture` first.

*v9's header, kept for the record.* **v9 replaces the two auxiliaries v8 added; it does not touch v7's
core.** Codex rounds 6 and 7 (`REVIEW-200-R6-CODEX.md`, `REVIEW-200-R7-CODEX.md`, both kept beside
this file) **validated the re-frame twice**: no stale-ACK or replay path through the ACK's six checks,
Git 2.46's `verify R <zero-oid>` means exactly what step L needs, a bare omission really is
destructive, and the apply lane really is the destructive lane for a lost ACK. **All five of round 7's
blockers landed on the two mechanisms v8 invented** — step G's re-advertisement and §3.2c's persisted
field — and neither survives v9 in v8's form. Applying the same discipline v7 applied to the
primitive, v9 **replaces one and rebuilds the other's lifecycle out of parts that already exist**:

1. **Step G is WITHDRAWN and replaced by step D — defer the capture** (§3.2b, §8 item 13). G put
   `record.base.refs[R]` into the outgoing candidate *after* capture, so a full, forced,
   basis-fallback or recompacted section could assert a tip its own `packChain` could not reach
   (round-7 B1). It is not repairable by feeding the tip into capture either: **R4 keeps no pin on the
   deleting device**, so after `git gc` the object may not exist locally at all. Instead, when any
   witnessed-absent head lacks a passing L proof **and the repository's projected BASE is active**
   (v10's gate, round-8 major 2), **the repository's capture defers wholesale for that cycle** through
   **the existing per-repository carry machinery** — `revertCapture` (`plan.ts:174-183`) after a
   committed capture, or `deferOne` (`:533-551`) if W/L are hoisted ahead of it — carrying the last
   synced section, whose pack links the wire has already carried and which still asserts `R = X`, so no
   follower prunes.
   **The cost is one sync cycle of Git-plane latency per refusal, stated in §3.2b, priced in §6, and
   pinned by a named test**; §9.4's per-ref-independence AC is amended rather than quietly dropped, and
   a *standing* refusal makes that carry standing — a new named residual, §13.4 item 10.
2. **The normalizer refusal is DELETED, not narrowed** (§3.2b). Round 7 showed the predicate is
   undecidable where v8 put it — `advertised` positive + candidate absent is also the shape a
   legitimate already-applied remote deletion produces (B2) — and that the normalizer has no
   per-repository refusal path anyway (M1). The gate moves to the plan, which can see BASE, the live
   refs and the proof map at once, and it is a **structural test** rather than a runtime throw.
3. ~~**§12 C3 stays TAKEN; its lifecycle is rebuilt on round 7's own prescriptions**~~ — **the whole
   item is WITHDRAWN in v11 (§3.2c, §12 C3).** It is kept here because it is the record of what the
   withdrawal is a withdrawal *of*: all three of v8's transitions failed round 7 (B3 the drop test, B4
   the overwriting arm, B5 the unrelated ACK's clear), all three of v9's replacements failed round 8
   (B1 the survivor latch, B2 the absence-equality clear, M1 the missing clear-site inputs), and both of
   v10's replacements failed round 9 (B1 same-ref generations, B2 the legacy writer). **The
   wire-authorship alternative was tried and rejected on code and that rejection still stands**
   (§8 item 14): `deviceId` is signed and unforgeable but cannot attribute a *tombstone*.
4. **Case (b)'s exit is respecified against the binary, for the third time and this time against HEAD**
   (§3.6 case (b), round-7 M4). v7 named an unreachable `manual` path; v8 fixed the authority to
   `publisher-ack` — correctly — but specified the *execution* as design 176's persisted intent, which
   **design 177 deleted and replaced with a synchronous ephemeral rider** (`177:1`, `:31-47`,
   `:164-173`; shipped in PR #390). Every claim in the rewritten section is cited to code, including
   that steps W/L/T/D **do not exist in the binary** and must be added to that capture.
5. **The `deletion-pending` consumer inventory is completed** (§5.2, round-7 M3): **fifteen** sites plus
   five tests — fourteen found in v9, four of them missed by v8's five-site table, one (the API's
   17-element cap fixture) that round 7 did not name either, and step D's own **capture-lane** producer
   as the **fifteenth**, which needs a typed reason because `captureReason` would classify it `other` or
   `artifact` (round-8 major 3). **v11 makes the prose agree with the table everywhere** (round-9 minor
   2). **The kill-switch rollback contract is restated for the last time and made true**: off restores
   the pre-200 binary *exactly*, unproven-omission author included, and §9.5's "still carried, never
   omitted" row is withdrawn (§11).

Plus round 7's three minors folded in place: invariant 1's strength (held, not published; origins are
retained, never re-minted, at an unchanged OID), the status-order rationale (`gitDeferralReasonPrecedence`
selects the displayed lane, it is not only an age tie-break) with a repair line that no longer promises
self-clearance, and invariant 11's honest verb *(that minor is **moot in v11**: with the C3 field gone
the invariant needs no clause about a withholding record at all — §7 invariant 11)*. Every claim v9
flagged UNVERIFIED was **CLOSED as VERIFIED by round 8**; **v11 carries no UNVERIFIED claim.**

*v8's header, kept for the record.* v8 was a convergence round on v7's shape that closed round 6's four
wiring findings: step G's outgoing representation for an unproven absence, §12 C3's TAKEN persisted
field, the `deletion-pending` deferral reason with its argued precedence slot and its one real compat
constraint (the deployed API **rejects the whole sync-state telemetry packet** on an unknown reason,
`apps/api/src/telemetry-ingest.ts:324-330`, so the API list ships and is promoted *before* the CLI that
can emit it), and case (b)'s keep-mine exit re-homed onto the **publisher-ACK** arm `176:93-99` already
rules. **Items 1, 2 and part of 4 are superseded above; C3's persisted field is WITHDRAWN in v11; the
compat constraint and the authority correction stand.**

*v7's own header, kept because it is the argument this design rests on.* **v7 was a re-frame, not a
sixth patch round.** Codex round 5
(`REVIEW-200-R5-CODEX.md`, kept beside this file) **closed** v6's receipt-backed tombstone
authorship, its kill switch and its pending assertion, and returned **NOT-ALIGNED** with three
more blockers and one major — all four, again, inside the same mechanism (§13.6). Five rounds have
now failed *one* mechanism in a new way each time: A′ (R3) → A″ plus the same-OID ABA (R4) →
reconciliation ordering, first-seen retention, the state-CAS lock gap, the omission state lane
(R5). Under the founder's standing rule — *a model that breaks on a new exotic input every round
is on the wrong plane* (quoted in §13.3) — v7 stops fixing the mechanism and removes the primitive
that keeps generating it.

**The primitive that was wrong: early BASE retirement.** v2–v6 retired `BASE[R]` locally, under a
durable A artifact, and published the omission *afterwards*. That ordering creates a window in
which **BASE says the branch is gone while the wire still says it is present** — and every piece of
machinery rounds 3, 4 and 5 argued about exists only to manage that window: A′, A″, the `owed`
predicate, `record.absenceOmission` and its four-transition lifecycle, the three-row sequence
reconciliation, reconcile-before-apply ordering, the `local-absence` BASE authority with its
state-CAS lock and revalidation filters, and the `absenceOmission` state-source lane. **No other
Git transition in rbox has such a window**: everything else publishes by capture, and BASE advances
only at the publisher ACK, atomically with the publication it records.

**v7: deletion is an ordinary captured transition.** The capture omits the ref and authors the
tombstone at the exact value it retires; the **publisher ACK retires `BASE[R]`** in the same state
CAS that records the acknowledged section; and the apply lane — instead of throwing §1.2's
pre-state error or re-creating the ref — puts that one ref into a **per-ref hold** until the ACK
retires BASE. Nothing durable records the deletion ahead of the wire, so there is nothing to
reconcile, nothing owed, and no state in which this device can believe the wire is asserting `X`
*because of itself*. That last clause is why round 4's ABA is not merely fixed but **inexpressible**
(§3.6 row 5).

What that deletes, verbatim: **§3.2b (the omission intent and its persisted field), §3.6a's steps
A, A′, A″ and C, the `owed` predicate, the eleven-row double-crash matrix, the sequence
reconciliation table, the `local-absence` `ComposeRepoBaseAuthority` member, the `local-absence`
state-CAS lock and revalidation filters, and v5's settled-Z witness projection.** §13.6 re-answers
all **34** findings from rounds 2–5 under the new shape. **v8 corrects that sweep's arithmetic and
one row** (round-6 minors 3 and blocker 2): the classes are **10 N/A because the window they live in
no longer exists**, 12 moot under R4/R5, and **12 carried** — v7's prose claimed 11/13/10 while its
own rows totalled 11/12/11, and R4 B1 moves from N/A to carried now that §12 C3 closes its
destructive half.

What survives unchanged, because none of it was ever about the window: the nine-rule deletion
witness and its fail-closed discipline (§3.3), the strict ref read at all its mandatory sites
(§3.3a), restore/unborn-branch detection (§3.3b), the possession invariant (§3.4), the **exact-OID
tombstone authorship** round 4 demanded and round 5 CLOSED (§3.2 — now the centrepiece rather than
a rider), P1b's binding to the exact value being retired (§3.2), rule 9's scoped-section refusal,
invariant 10, the `gitStatus`/`gitRaw` carried-cause contract (§3.3a), P2, P3, and every founder
ruling R1–R5.

Author: Claude, from first-hand field forensics on the founder's Mac, 2026-07-24.

**What this design costs, stated up front rather than buried in §13** — residual 3 was *closed* by v8's
persisted field and is **re-opened as a stated residual by v11**, which is the deliberate trade of this
revision, and **residual 4 was added by v9** because step D buys its safety with latency. Four
residuals, each smaller than the machinery it replaces:

1. **An unpublished deletion can be lost.** If a peer asserts the ref again *after* this device's
   omission is acknowledged, the assertion wins and the branch comes back; the user re-deletes it
   in one keystroke. That is C1's ruled direction — never destroy another writer's ref — and R4's
   ruled contract that the file plane, not the Git plane, is the durability promise (§13.4 item 6).
2. **"Deleted here, advanced there" is a two-sided divergence, and v7 says so** instead of deciding
   it unilaterally. The ref holds per-ref, the repository keeps carrying its pending section while
   it holds, and the human exit is `rbox git resolve keep-mine`, which stops refusing this shape.
   §10 has always reserved two-sided divergence for design 173 (§3.6 case (b), §13.4 item 7).
3. **One race survives, and after four rounds of trying to close it v11 states it instead
   (§3.2c, §12 C3 WITHDRAWN, §13.4 item 8).** A crash in the window between an accepted POST and its
   state CAS, **plus** a local re-creation of the deleted branch at **exactly** the OID the accepted
   tombstone names, before this device's next pull, lets the apply lane consume this device's own
   accepted tombstone against the re-created ref — deleting that ref locally, **once**. Round 6 was
   right that this needs no peer (a purely local `git branch <R> <X>` between step L's `commit` and the
   lost ACK reaches it, because the post-ACK refusal comes from a *retired* logical BASE,
   `tombstone-attestation.ts:109-111`, which a lost ACK is exactly the state that lacks). v8 closed it
   with a persisted field; rounds 6–9 then put **twelve** blockers inside that field's lifecycle and no
   round left it correct. So the field is deleted and the residual is named, with **three recovery
   paths** — the tombstone-prune keep-pin, which is **verified** to fire on this exact path and lands in
   the same `git update-ref` transaction as the delete (`follow.ts:947-949`, `keep-pins.ts:635-654`,
   `branch-transition.ts:119`); the user's HEAD reflog when the re-creation was a checkout; and file
   history, R4's ruled contract — and a **non-recurrence** argument: the prune's apply pass retires
   `BASE[R]` (`apply.ts:1258-1275`), consuming the race's own precondition, and if that save is lost too
   the next pull retires BASE with no ref left to delete. **What is lost is one branch pointer per
   occurrence, and every occurrence needs its own crash inside the window and its own same-OID
   re-creation — recoverable from a pin the delete's own `git update-ref` transaction wrote.**
4. **An absence rbox cannot prove costs that repository's Git plane a cycle — or a standing carry.**
   New in v9. Step D defers the whole repository's capture when any witnessed-absent head lacks a
   locked proof **and that repository's projected BASE is active** (§3.2b; the gate is v10's, round-8
   major 2 — a *hidden* BASE anchor takes no defer and publishes no section at all), because there is no
   per-ref outgoing representation whose bundle can cover the deleted tip. Transient refusals (lock
   contention, a HEAD move, a busy repository) cost one cycle; **standing** refusals (no usable origin, a
   stale owning A, an unborn-branch HEAD, a non-clearing ref-database signal) keep that repository
   carrying its last synced section until the cause goes. The file plane is untouched, nothing is
   destroyed anywhere, and it is reported under `deletion-pending` — through a **typed** capture-lane
   reason as of v10, because the regex classifier would have shown `other` or `artifact` instead
   (round-8 major 3; §13.4 item 10). The honest fix for the class is design 201.

**Earlier revisions, compressed — §12 (rulings) and §13 (review record) are authoritative.**
*v8–v10:* **§12 C3 TAKEN and its lifecycle rebuilt three times — all of it WITHDRAWN in v11** (§3.2c,
§13.10); what survives from those revisions is step D (§3.2b), its active-BASE gate and typed reason,
the exact-value tombstone ACK checks, the `deletion-pending` reason with its complete consumer
inventory, and the corrected kill-switch rollback contract. *v7:* the re-frame — deletion is an
ordinary captured transition, and early BASE retirement is deleted (**the core, untouched by rounds 6
through 9**). *v6:* replaced A″'s `advertised` conjunct with a durable omission intent, gave the omission
exact-value tombstone authorship, bound A′'s proof to the state-CAS locks, and made the kill switch
stop-authoring-only — **the tombstone authorship and the kill-switch rule survive; the intent and
A′'s locks are deleted with the window.** *v5:* RULED **R5** — P4 **CUT**, parked as
**[design 201](./201-per-ref-git-publishing.md)** — plus step A″, the settled-Z projection, and
`gitStatus`'s single contract (**the last survives**). *v4:* RULED **R4** — rbox promises *file*
history, so no breaker, no keep-pin, no `rbox git deleted` — plus P1b's exact binding, step A′, and
the strict reader's API (**all survive except A′**). *v3:* the strict ref read on every absence
path, P3 demoted to cascade reduction, and the verified v1.6.8 floor (**R2**).

Relates: 130 (follower branch hygiene — closed BASE authority, A/P/K, tombstones;
this design adds the one authority 130 left unwritten), 176 (wedge UX — §2.4
*refuses* the exact shape found tonight and says so explicitly), 174 (held-repo
livelock, pending supersession; its R1 resurrection blocker is the safety
argument this design must survive), 116 + 116-phase0 (per-ref worktree
ownership; the field wedge that keeps re-forming), 128 (batched proofs),
165 (checkout follow ownership), 182 (agent churn).

## 0. Summary

The founder's development loop is: an LLM agent creates a Git worktree and a branch,
work happens, the branch is squash-merged on GitHub, and both the branch and the
worktree are abandoned. That loop — not an exotic corner — **permanently wedges rbox's
Git sync, and nothing self-heals.** Two failure modes were reproduced and root-caused
tonight; they are causally linked, and the first manufactures the second.

- **Mode (a)** — a spent linked worktree holds a branch. rbox holds that ref, keeps the
  repository's `pending` section, and thereby gags the repository's *capture* lane. The
  hold is not held-skip eligible, so the full ~9 s ownership proof re-runs every cycle
  for as long as the worktree exists. This is design 116-phase0's wedge, re-forming in a
  new place.
- **Mode (b)** — while capture is gagged, the user deletes a branch rbox has already
  published. **rbox has no authority anywhere in the system to record that a published
  branch was deleted locally**, so BASE keeps a positive member that physically does not
  exist. The apply lane then tries to *resurrect* it and is correctly refused by the
  logical-BASE pre-state guard; the push lane refuses to supersede `pending` because the
  local repository lacks a pending ref. Each lane waits on the other. `rbox git resolve
  keep-mine` refuses this shape **by name**, and design 176 §2.4 says in so many words
  that it "does not clear" it. `docs/STATUS.md:496` already recorded the same shape on
  2026-07-21 as "PERMANENTLY unprovable — no path forward even with
  `--force-discard-incoming`".

The fix is *not* to weaken the pre-state guard. Design 130's central invariant
(`130:177-187`) is right, and the guard is what enforces it. The fix is that **an out-of-band
deletion of a published branch must travel the same way every other ref transition travels: it is
captured, it is published, and BASE follows the acknowledgement.** Concretely (§3.2): the capture
omits the ref, a locked verify-only ref transaction proves the absence, the published section
carries a design-130 tombstone at the exact value being retired, and the publisher ACK retires the
BASE member in the same CAS that records the accepted section. Nothing on the wire *format*
changes. **What v7 deliberately does not do is retire BASE first and publish afterwards** — that
ordering is the primitive five adversarial rounds kept breaking (§8 item 12, §13.6).

The semantic that follows from capturing rather than re-materializing is stated once, in
§3.0, because everything else depends on it: **deleting a branch on one machine removes it
from every device running v1.6.8 or newer.** `git branch -D` means what it says inside a
synced workspace. The version floor is verified, not assumed, and a device below it holds
the branch until it upgrades rather than losing or resurrecting anything (§3.0).

**What backs that semantic is a product decision, not a mechanism — RULED 2026-07-24 (R4),
§3.0a.** rbox promises **file** history; the Git lane is convergence assistance and is
best-effort on history. So this design deliberately ships **no threshold breaker and no
git-side recovery pin**: an absence capture is fail-closed on evidence (§3.3), and a
wrongly-propagated deletion is recovered from file history — the promise — with the
server's retained bundles and un-applied devices as unpromised backstops. The residual is
stated plainly in §3.0a rather than mitigated with arithmetic. The same ruling is why v7 can
accept, rather than defend, the case where an unpublished deletion is overtaken by a peer's
assertion (§3.6 row 5): a lost deletion is one keystroke to repeat, and the content never
depended on the ref.

Alongside it, two smaller changes make mode (a) cheaper: make the ownership hold held-skip
eligible (with a worktree-registry digest in the skip bracket), and stop a non-HEAD hold
deferring the whole repository. A third — the founder's validated patch-id recipe,
generalized to rbox's durable-roots model so it needs no `origin/main` concept — reduces
the *cascade* a squash-merged branch causes, and v3 is careful not to claim more than that
(§4.3). P2's per-ref hold machinery does double duty in v7: it is also what keeps the deletion's
own publish window from either wedging the repository or resurrecting the ref (§3.6).

**What this design does *not* do, stated here because v2–v4 all promised it — RULED
2026-07-24 (R5), §4.4.** None of P1–P3 ungags a repository whose worktree holds a
**divergent** branch: that repository keeps carrying its pending section for as long as the
worktree lives. v2 claimed P2 fixed it, v3 and v4 answered with **P4** (`pending ⊕ local`), and
R5 cuts P4 after three shapes failed three adversarial rounds. The residual is accepted and
bounded, and §4.2 states it in three parts: a divergent hold keeps the section carried;
unrelated work still propagates wherever its transition is a fast-forward, through design 174's
supersession — which the merged rig scenario shows **passes on merit today**; and everything
clears once the worktree goes **and the branch is deleted**, through P1/P1b, which is the gate
this design ships — removing a worktree alone changes no ref (§9.1), and a surviving branch clears
through ordinary ownership follow instead. **v7 adds one member to that same residual class**: a
ref deleted here while another writer advanced it is a two-sided divergence, so it holds and its
repository keeps carrying, until either side moves or a human resolves it (§3.6 case (b)). The
honest fix for the whole class is a per-ref wire model, parked as
**[design 201](./201-per-ref-git-publishing.md)**.

**Cost is negative in wall clock and free at rest, with exactly one positive-cost item and it is
latency, not compute.** The new checks are O(1) per BASE head in the negative case and are gated behind
proofs that already failed, while making ownership holds held-skip eligible removes a full follow per
cycle from exactly the repositories that suffer today. **P1's standing cost is one verify-only ref
transaction per deleted branch** — no artifact, no persisted field, no extra state *save*, and nothing
at rest or per cycle (§6). *(v7 said "no persisted field"; v8 added exactly one, §12 C3 / §3.2c, and
**v11 removes it again** — §3.2c.)* **v9 adds the one positive item:
step D trades a repository's Git-plane publication for one cycle whenever a proof is refused** (§3.2b,
§6), which is what buys the property step G could not deliver — every published section's refs are
covered by its own bundle chain.

## 1. Field evidence

Observed first-hand on 2026-07-24 on the founder's Mac. Host: workspace `~/Development`,
108,763 files, 110 Git repositories, rbox `1.9.0-dev+621aed4`, ~203 branch heads.
No checked-in fixture; §9.1 shows how to build one.

### 1.1 Mode (a) — a spent worktree blocks the repository

```
git-sync deferred Personal/rbox-core: branch fix/follow-checkout-ref-detail
  is checked out in linked worktree follow-ref-detail
```

- `git worktree list` showed **10 leftover worktrees**, two under `~/.codex/worktrees/`
  — *outside* the synced workspace. rbox never syncs those directories, but Git still
  registers them as linked worktrees of a repository that *is* synced, and rbox's
  ownership check still sees them.
- Removing that one worktree unblocked that specific deferral.
- **It never self-clears, because of squash-merge.** `git branch --merged origin/main`
  returns nothing for these branches: the squash commit on `main` is not a descendant of
  the branch tip. Confirmed on a branch merged twenty minutes earlier.
- A working detection *does* exist. Validated against all 10 real branches:

  ```sh
  base=$(git merge-base origin/main "$branch")
  synth=$(git commit-tree "$branch^{tree}" -p "$base" -m _)
  git cherry origin/main "$synth"   # "-" prefix ⇒ content already in main
  ```

  It identified 4 of 10 as squash-merged (`codex/daemon-control-decompose`,
  `fix/follow-checkout-ref-detail`, `ci/rebalance-src-shards`, `feat/workers-ci-shards`)
  and left the other 6 alone. All 10 worktrees were clean (`dirty=0`). Any failure of the
  probe leaves the branch classified "unmerged", i.e. today's behavior — it fails closed.

### 1.2 Mode (b) — a phantom ref permanently wedges the repository

Once the worktree was removed the real error surfaced. It had been masked until
`621aed46` (#439, "keep the Git error when a ref publish fails"):

```
git-sync deferred Personal/rbox-core: publishing ref
  refs/heads/fix/coupon-slack-notification failed:
  branch transition does not match logical BASE pre-state
```

thrown at `src/cli/sync-git/branch-transition.ts:105`.

Persisted state for that ref in `<root>/.rbox/state.json`,
`repoRecords["Personal/rbox-core"]` (ref abbreviated `R`):

| Field | Value |
|---|---|
| `base.refs[R]` | `2c866687e7a979727cd80985997f785d6c383620` (304 refs total) |
| `pending.refs[R]` | `2c866687e7a979727cd80985997f785d6c383620` (306 refs total) |
| `partial.appliedRefs[R]` | **absent** (304 entries) |
| `advertised` | contains `R` |
| `branchBaseOrigins[R]` | `{ v:1, oid:2c866687…, kind:"publisher-ack", sourceSeq:468, lineageHash:… }` |

The local repository has **no such ref and no reflog for it** — both `git rev-parse` and
`git reflog` fail. The branch name (`fix/coupon-slack-notification`) has nothing to do
with this repository's work: it is an agent worktree branch that was created, published,
squash-merged and deleted.

Every cycle also logged, from `src/cli/sync-git/plan.ts:788`:

```
git-sync pending carry Personal/rbox-core: local repository lacks pending ref
  refs/heads/fix/coupon-slack-notification. Your local Git work is safe while rbox retries.
```

It retries forever and never converges.

### 1.3 Cost, as measured

`ownershipMs` p95 ≈ **9 s** per cycle in steady state, and **867 s** while wedged. The
`rbox git resolve … show-me` preview reported *"proving ownership of 635 candidates"* for
this one repository.

### 1.4 This is a recurrence, not a novelty

- `116-phase0-findings.md:50-55` — 1,173 identical
  `git-sync deferred Personal/rbox-core: branch d93-git-config-sync checked out in linked
  worktree d93` lines over three days, from a `.claude/worktrees/*` checkout.
  `116-phase0-findings.md:150-156` already warned that any long-lived worktree of a synced
  branch freezes that repository's Git plane on that host.
- `130:11-16` — "the Mac rbox-core replica accumulated **83 local-only commits across
  dozens of stale side branches**. Every branch had been squash-merged and deleted on the
  publisher." Design 130 solved the **follower** side of squash-merge with tombstones.
  Mode (b) is the **publisher** side of the same workflow, and it was never covered.
- `docs/STATUS.md:496` (2026-07-21) — "a pending branch whose oid exists nowhere
  (squash-merge + deleted worktree + deleted origin branch) is PERMANENTLY unprovable —
  no path forward even with `--force-discard-incoming`."
- `176:93-99` — design 176 knowingly declined it: keep-mine "refuses, with a plain
  explanation, the branch presence/absence shape that arm cannot express — a pending
  branch absent locally that BASE holds present … **It does not clear either shape.**"

### 1.5 How the two modes connect

Mode (a) is the trigger; mode (b) is the trap. A worktree hold sets
`pending[rel] = remoteSec` for the whole repository, which gags capture. While capture is
gagged the user keeps deleting merged branches. Each such deletion becomes a phantom ref.
When the worktree is finally cleaned up, mode (a) clears and mode (b) is already locked
in — and mode (b) has no exit at all.

## 2. Root cause

### 2.1 Mode (a): the ownership hold is unfiltered, unskippable, and gags capture

**Detection.** `branchesCheckedOutElsewhere` — `src/engine/git/apply.ts:112-121` — shells
`git worktree list --porcelain` (`listWorktrees`, `src/engine/git/shared.ts:420-441`),
skips `prunable` and detached entries (`apply.ts:116`), and returns every branch whose
worktree realpath differs from this one (`apply.ts:118`). **The only comparison is
`real !== selfReal`.** There is no containment filter: no workspace-root check, no
ignore-matcher, no use of `inTreeWorktreeParentRelFromCtx`
(`src/engine/git/shared.ts:395-405`), which exists and is used — but only on the capture
side (`src/cli/sync-git/plan.ts:932-935`). A worktree at `~/.codex/worktrees/foo`,
entirely outside the workspace and never synced, therefore holds a branch inside it.

**Per-ref hold.** `publishRefPlane` computes `owned` once at
`src/cli/sync-git/follow.ts:673`, holds each owned candidate at `follow.ts:734-739`
(where the founder's log line is composed), records it at `follow.ts:842-847`, re-proves
it at the publish boundary (`follow.ts:916-935`), and emits one
`{provenance:"ref-plane", reason:"worktree-ownership", ref}` blocker per held ref at
`follow.ts:1030-1037`. So far this is exactly what design 116 phase-0 intended: per-ref,
not whole-apply.

**Three escalations undo that.**

1. If the owned ref is the *incoming HEAD*, `follow.ts:709-711` sets a whole-repo
   `checkoutRefReason`, which flows through `classifyCheckout` (`follow.ts:552-555`,
   ranked by `firstReason`, `follow.ts:458-465`) to a whole-repository
   `{status:"defer", reason:"worktree-ownership"}` at `follow.ts:1204`.
2. Regardless of which ref is held, `src/cli/sync-git/apply.ts:1447-1450` does
   `pending[rel] = remoteSec` and `setDeferral(rel, "apply", …)` whenever
   `Object.keys(follow.heldRefs).length > 0`. **That one line converts a one-branch hold
   into a whole-repository capture gag** — `plan.ts:776-790` then carries `pending`
   instead of capturing. It is the bridge from mode (a) to mode (b). Note it contradicts
   design 116's hard invariant #4 ("One protected ref does not freeze unrelated refs",
   `116:66-91`) in the *capture* direction, which 116 only ever reasoned about in the
   *apply* direction.
3. `worktree-ownership` is not held-skip eligible — the allowlist at
   `src/cli/sync-git/held-skip.ts:37-41` is `local-commits | local-stash | local-index`
   (`local-index` added by the 176 v5 amendment, `176:176`), gate at
   `apply.ts:1209-1210`. So the cheap sidecar-refresh path is never taken and the entire
   follow — bundle fetch, decrypt, verify, import, classification, the per-tip ownership
   proof and the `noDropProof` fixpoint — re-runs every cycle. That is the observed 9 s
   p95.

**Why the ownership proof is expensive.** The sync path uses the *unbatched* proof:
`tipOwnedByIncoming` → `tipOwnedByIncomingDetailed`
(`src/engine/git/reachability.ts:106-126`) costs roughly `3 + 2·|roots|` Git subprocesses
*per candidate tip*, with no memoization. `noDropProof` (`reachability.ts:208-238`) runs
inside a fixpoint loop (`follow.ts:791-830`) at up to `|protected|·|durable|`
`merge-base --is-ancestor` invocations. `branchesCheckedOutElsewhere` and `readAllRefs`
are re-spawned *inside* the per-ref publish loop (`follow.ts:916-917`). The batched
implementation with ~4 subprocesses total exists (`partitionOwnedByIncoming`,
`reachability.ts:135-206`, design 128) but is wired only to `rbox git resolve`.

**Why the hold never self-heals.** Merged-ness in rbox is *always* pure ancestry —
`merge-base --is-ancestor` at `reachability.ts:113-121` and `:223-236`,
`gitCommitAncestry` at `src/cli/sync-git/git-ancestry.ts:8-25`. There is no `--merged`,
no `patch-id`, no `cherry` anywhere in `src/`. A squash-merged branch is therefore
permanently "receiver-only work", exactly as the founder measured, and exactly as
`130:20-23` and `165:34-47` describe.

### 2.2 Mode (b): a two-lane deadlock over a BASE member that cannot be retired

Let `R = refs/heads/fix/coupon-slack-notification`, `X = 2c866687…`.

**The apply lane.** `R ∈ candidates` (`follow.ts:712-716`: with `refScope:"all"` on a
`dir` repo, candidates include every `base.refs` key). `oldOid = live.refs[R] = undefined`;
`newOid = effective.refs[R] = X` (from the carried `pending` section). They differ, so the
publish loop reaches `follow.ts:966-988` and calls

```ts
planBranchTransition({ ref: R, beforeOid: null, afterOid: X,
                       logicalBaseOid: opts.branchProtocol.logicalBaseRefs[R] })
```

`logicalBaseRefs` starts as a copy of `base.refs`
(`src/cli/sync-git/follower-protocol.ts:80`) and is reduced only by valid A artifacts
(`:88`) or settled-absence entries (`:106`). There is neither here, so
`logicalBaseOid = X`, and `branch-transition.ts:105` throws:

```ts
if (input.logicalBaseOid !== input.beforeOid)
  throw new Error("branch transition does not match logical BASE pre-state");
```

The throw is caught at `follow.ts:1021-1027`, which sets `checkoutRefReason ??= "other"`
and the observed `publishing ref … failed` detail. Nothing is mutated; the repository is
deferred. Until `621aed46` the detail was discarded, which is why mode (a) appeared to be
the whole story.

**The push lane.** Because `pending` exists, `plan.ts:776-790` carries it byte-for-byte
instead of capturing, unless `pendingSupersessionPreProbe` says otherwise. That probe
iterates every pending ref and bails at `src/cli/sync-git/pending-supersession.ts:103-105`:

```ts
const live = identity.refs[ref];
if (live === undefined)
  return { status: "carry", reason: `local repository lacks pending ref ${ref}` };
```

`provePendingSupersession` would fail the same way at `pending-supersession.ts:199-200`
(`if (candidateOid === undefined) return false`). So the section is carried forever and
the local deletion is never published.

**Why BASE cannot retire `R` in either lane.** This is the real root cause. Design 130
made BASE a closed-authority object; the enumeration is `ComposeRepoBaseAuthority`,
`src/cli/sync-git/base-composer.ts:121-153`. Only two members can turn a positive branch
absent:

- `pull-ref-transaction` / `journal-recovery` with an `absent` branch witness
  (`base-composer.ts:442-449` → `branchProofMatches`, `:246-260`), which requires a real
  A artifact committed under a locked proof; and
- `manual` with an `artifact` decision carrying an `absent` witness
  (`base-composer.ts:425-440`).

`publisher-ack` — the authority behind *every capture* — explicitly cannot:

```ts
} else if (authority.kind === "publisher-ack") {
  if (requested === null) after = before;                    // base-composer.ts:357
```

and any previous ref the capture omitted is re-added wholesale:

```ts
if (!pending && authority.kind === "publisher-ack") {
  for (const [ref, value] of Object.entries(previousRefs))
    if (candidateRefs[ref] === undefined) refs[ref] = value; // base-composer.ts:525-527
}
```

Design 130 states it in words (`130:302-303`): "`publisher-ack` may add or advance present
members this device advertised, but **may not remove them**"; and (`130:319-321`)
"present→absent requires locked R absence plus the exact current-lineage A or
settled-absence entry". `130:914-919` gives the motive: "BASE admits present additions and
advances with exact `publisher-ack` origins but **retains every omitted ref and its
matching origin. This prevents resurrection** and repeat re-supersession without claiming
an unperformed deletion."

So: **there is no code path by which a locally-deleted published branch is removed from
BASE without a human.** The deadlock is not a bug in either lane; it is a missing
authority.

### 2.3 The same shape wedges even without `pending`

Suppose there had been no worktree hold and capture had run normally. Capture omits `R`
(P lacks it), and `normalizePublishedGitSection` even authors the correct wire tombstone
(`src/cli/sync-git/publisher-tombstones.ts:108-121`: `advertised.refs[R] = X`,
`candidate.refs[R] === undefined`, so a tombstone at `X` is emitted). **v8 corrects what v2–v7 said
next, because round 6 depends on the correction and so does §3.2b.** v7 said the publication is then
refused because BASE keeps `R = X` and `pendingSupersessionAckConverges` (`pending-supersession.ts:35-62`,
pinned by `pending-supersession.test.ts:51-66`) cannot deep-equal the candidate. That is true **only
when a pending section exists**: the dry run runs solely for `pendingSupersessionCandidates`
(`plan.ts:1027-1041`), and a repository with **no** pending section publishes its capture with nothing
consulting BASE at all. **So today's binary already publishes this omission and its tombstone, with no
locked proof anywhere** — followers at live/BASE `X` prune, and BASE keeps its stale positive member
locally. That is the latent wedge *and* the pre-existing hole **step D** closes (§3.2b): the case v7
read as "refused" is the case that publishes. And the next time anything forces a follow,
the publish loop takes the `oldOid === newOid` (both `undefined`) branch at
`follow.ts:848` and falls to:

```ts
} else if (baseOid !== (newOid ?? null)) {
  heldRefs[ref] = "local-commits"; // equality cannot invent branch P/A authority.
}                                                            // follow.ts:894-895
```

— design 130's "branch equality is not deletion authority". The repository is held again,
`pending` is set again, and we are back in mode (b). **A stale positive BASE member is a
latent wedge that arms itself on the next divergence.** Today it is invisible only because
a converged repository is not followed.

### 2.4 The manual remedy also refuses

`rbox git resolve <repo> keep-mine` — the designed human escape (design 176) — refuses
this exact shape by name, at `src/cli/git/resolve-command.ts:658-665`:

```ts
const absentPublisherBranch = Object.entries(incoming.refs).find(([ref]) =>
  ref.startsWith("refs/heads/") && record!.base?.refs[ref] !== undefined
  && localRefs.get(ref) === undefined);
if (absentPublisherBranch) { /* refused, code "conflict" */ }
```

> `keep-mine can't remove branch <R> — it is deleted here but rbox still tracks it as
> synced. Restore the branch, or resolve it explicitly, then retry`

There is no "resolve it explicitly" verb. The two things that actually work today are
(1) `rbox git resolve <repo> take-theirs`, which **resurrects** the deleted branch and
quarantines other local Git work in that repository, or (2) `git update-ref refs/heads/R X`
by hand, from an OID the user has to read out of `state.json`. Both are wrong answers, and
neither is a normal user action.

## 3. What should happen when a published branch is deleted locally

### 3.0 The semantic: a deletion is published, not re-materialized

**RULED 2026-07-24 — publish.** This was the design's own recommendation (§12 Q1) and it
is now a stated decision rather than a question, because §3.1–§3.6, §4.5, §5 and §7 all
rest on it.

> **Deleting a published branch on one machine removes it from every device running
> v1.6.8 or newer.** Inside a synced workspace `git branch -D` means what it says: the
> deletion is an event rbox captures and publishes, not a local divergence rbox repairs by
> re-materializing the branch from the fleet.

**The version qualifier is not hedging — RULED 2026-07-24 (R2), and verified.** v1 and v2
said "fleet-wide" without qualification. That is false for devices predating design 130,
and the honest statement is worth more than the clean one.

- Design 130's tombstone attestation (`src/cli/sync-git/tombstone-attestation.ts`) first
  shipped in **v1.6.8**, commit `04c2aff8` (#297). `git tag --contains 04c2aff8` puts
  v1.6.8 first; v1.6.6 and v1.6.7 do not contain it.
- **What a pre-1.6.8 device actually does, read off the tag rather than assumed.** In
  `v1.6.6:src/cli/sync-git/follow.ts`, a ref present locally at `X` whose incoming section
  omits it runs `tipOwnedByIncoming(repoDir, X, roots)` in the first-pass hold loop
  (`v1.6.6:follow.ts:556-565`). For a **squash-merged** branch `X` is an ancestor of
  nothing in `roots`, so the proof returns `unowned` and the ref is classified
  `local-commits` and **held**. There is no tombstone waiver in that version to lift the
  hold — the waiver loop does not exist. (For a branch whose tip *is* reachable from the
  incoming roots the same version does delete it, after pinning the displaced OIDs; the
  hold is specific to the squash-merge shape, which is the shape this design is about.)
- **It cannot resurrect the branch either.** A held ref sets the whole-repository
  `pending[rel] = remoteSec` gag in that version too, so the lagging device never captures
  and never re-advertises `R`. If the user also deletes `R` there, capture omits it, its
  own BASE re-adds the omitted member (`base-composer.ts:525-527`) and the ACK dry-run
  refuses — it carries, forever, without publishing anything.

**So the honest semantic is: deletion is eventually fleet-wide, not instantly fleet-wide.**
A lagging device keeps the branch and defers *that repository's* Git plane until it is
upgraded; on upgrade the unchanged design-130 attestation path prunes and it converges.
Nothing is lost and nothing is resurrected; the fleet is briefly inconsistent, and one
repository on one stale device stops syncing Git in the meantime. That last part is the
real cost and it is worth stating out loud rather than filing under "degrades gracefully".

The founder's phrasing was "1.7.x and newer". That is a safe superset of the verified
floor and is the right thing to say to a user — 1.6.x has been superseded for months — but
the design records **v1.6.8** because that is what the code says, and a future skew
argument that starts from the wrong constant will reach the wrong conclusion.

The rejected alternative was to retire the BASE member locally and let the next incoming
section re-create the branch. It is strictly non-destructive, and it is wrong: it makes
branch deletion a no-op on every machine that syncs, silently and forever. The founder's
loop *is* create-branch → merge → delete-branch; a sync tool that cannot represent the
last step of that loop is not syncing the loop.

Three consequences are load-bearing and stated here so nothing later has to re-derive
them:

1. **Deletion is authoritative, so it must be proved, not inferred.** Publishing a deletion is a
   destructive claim about other machines' repositories. That is exactly why §3.2 takes a locked
   expected-absent ref transaction rather than trusting a plain read, why the omission carries a
   tombstone at the exact value it retires, and why §3.3's witness has nine conditions. *(v2–v6
   also made the proof **durable**, as an A artifact written before publication; v7 keeps the
   proof and drops the artifact — §8 item 12.)*
2. **Receivers still hold a veto.** "Removes it fleet-wide" is the *intent* of the
   published tombstone, not an instruction receivers must obey. A follower that has
   advanced the branch beyond the tombstoned OID holds instead of pruning (§3.4). Fleet
   authority is *the deleting device's own history*, never another device's.
3. **What happens when the capture is *wrong* is a product question, not an engineering
   one** — and it is answered by **R4** in §3.0a. v2 answered it with a follower's prune
   pin, v3 with a 90-day pin on the deleting device; R4 answers it with the durability
   contract itself. The mechanism sections that used to carry that weight (v3 §3.5's
   breaker, v3 §3.7's pin, v3 §7.2's recovery command) are **out of scope as of R4**.

### 3.0a What rbox promises when a deletion propagates wrongly — RULED 2026-07-24 (R4)

**Ruling: rbox promises FILE history, not Git history.** The file plane is the durability
contract — trash plus server-side version history, 30 / 90 / 365 days by plan
(`apps/api/src/plans.ts:24-27`). The Git lane is *convergence assistance*: it makes every device agree,
and it is **best-effort on history**.

This is the single most consequential ruling in the design, because it decides how much
machinery the *wrong* case deserves. The founder's reasoning, recorded verbatim because it
is the whole argument: **"some math is just not gonna prevent it; there's always a gap."**
Every threshold has an under-threshold case, and every under-threshold case is a
false-absence that publishes. Buying a partial defence with permanent complexity — a
breaker with two or three legs, ~900 hidden refs holding objects against `git gc`, a reaper
with a cadence and a kill switch, and a new CLI verb to make the reaper's output
reachable — is not the right trade when a *complete* defence already exists one plane over.

**Where a wrongly-propagated branch deletion is recovered from, in order of strength:**

| Source | Strength | What it gives back |
|---|---|---|
| **File history** — trash + server version history (`apps/api/src/plans.ts:24-27`: `retentionDays` 30 / 90 / 365 for solo / team / pro; `rbox restore <file>@<seq>`, `help-registry.ts:322-330`) | **PROMISED.** This is the product's durability contract. | Every tracked file's content at every synced sequence in the plan window. Not refs, not commit objects — *the work*. |
| The server's retained Git bundles inside the plan window | Best-effort, **unpromised**, manual. GC reachability is computed from the DO's retained roots, not just the head (`apps/api/src/gc-phase1.ts:44-58`, `reachableFromWorkspaces`, `versions.ts:66+`), and history pruning is disabled in every deployed environment (`apps/api/src/retention.ts:36` gates on `RBOX_HISTORY_PRUNE_DISABLED`, set to `"1"` for both dev and prod in `apps/api/wrangler.jsonc:105` and `:194`) — so the objects are usually still there. **There is no command that restores a Git ref from a historical version** — v3 §7.2 verified this and it is still true. | A commit object, extractable by hand by someone who knows the internals. |
| Another device that has not yet applied the tombstone, or has applied it and not yet `gc`'d | Incidental. Depends on timing and on `gc.pruneExpire` (default two weeks). Devices that prune under tombstone authority *do* pin the displaced OIDs, unchanged from design 116 (`prepareTombstonePrunePins`, `keep-pins.ts:635-654`) — that behaviour ships today and is untouched here. | The branch tip, if you get there in time. |

**The residual, stated plainly because the founder accepted it explicitly.** A *systematic*
false absence — most concretely §3.3b's in-place ref-database restore, where `refs/` and
`packed-refs` are replaced under a `.git` whose commonDir inode never changed — propagates
**fleet-wide with no tripwire**. There is no breaker to defer it, no per-device pin to
recover from, and no count at which rbox stops and asks. What bounds it is the file-history
contract: the *files* are recoverable for the plan window, and the branch pointers are not.

Two honest riders:

- **rbox never destroys a reachable object as part of this.** Absence capture mirrors a
  deletion Git already performed locally; the follower prune it authorizes still pins the
  displaced OIDs on the pruning device. The failure mode is *lost branch pointers across the
  fleet*, not lost blobs on any single machine.
- **This weakens no correctness invariant.** Nothing in §3.1's pre-state argument, §3.2's
  receipt, §3.4's provenance discriminator, §3.6's ordering or §4.4's publication rules ever
  depended on the breaker or the pin; they depended on the *evidence* rules of §3.3, which
  are unchanged and still fail closed on every input. The breaker and the pin were the
  *consequence-mitigation* layer for a capture that passed all the evidence rules and was
  still wrong. Removing them changes what happens when the design is wrong, not whether it
  is right. **If a future reviewer finds a place where a correctness argument leans on either,
  that is a bug in this revision and should be raised as a blocker, not patched with a
  threshold.**

### 3.1 The pre-state guard is correct. Keep it.

`branch-transition.ts:105` enforces design 130's central invariant, quoted verbatim from
`130:177-187`:

> **`BASE[R]` may move from a present OID to absent only in the same successful
> expected-absent CAS ref transaction by which rbox performs and records that
> transition.**
>
> An absent live ref, an already-converged shortcut, a wholesale section carry, partial
> progress, journal recovery, or a state-file CAS is not equivalent to that act. Those
> paths may materialize a transition already proved by its durable Git artifact; **they
> may never manufacture one.**

`beforeOid` is physical CAS evidence; `logicalBaseOid` is the protected logical pre-state,
and `130:377` is explicit that they are different things. If `beforeOid = null` were
allowed to pass against `logicalBaseOid = X`, three things break at once:

1. The follower would **resurrect** a branch the user deleted. For this workflow that is
   worse than the wedge: `git branch -D` would stop meaning anything, on every machine,
   forever.
2. BASE and P would record incompatible histories — the created P artifact claims
   `priorOid: null` while BASE says the predecessor was `X`. The A/P/K crash-recovery
   reconstruction reads those predecessors as authoritative (`130:606, 838, 853`;
   `p-repair`'s `preserve-absent` / `preserve-third` dispositions at
   `base-composer.ts:388-399`).
3. It would make the branch-*creation* path a general-purpose BASE overwrite, which is
   exactly what "BASE has closed authority" forbids.

The resurrection hazard is not hypothetical.
`docs/design/notes/174/REVIEW-174-R1-OPUS-B.md:14-92` is a BLOCKER finding titled
"clearing a multi-writer pending section reverts another writer's branch
deletion/rewrite fleet-wide", whose mechanism is precisely that "**a deletion is encoded
as a ref absent from `P.refs`, not present in it**". Design 174 resolved it structurally
(`FOLD-PLAN-174-R1.md:46-82`) via capture-then-prove-then-swap plus the
`pendingSupersessionAckConverges` dry-run. Any proposal here that lets a branch reappear,
or lets a BASE member vanish without a locked proof and a published tombstone, walks straight back
into that finding.

**The guard stays. The deletion should have been captured when it happened.**

### 3.2 The missing authority: an ACK that may retire what its section omits

rbox already takes the exact locked proof this design needs — but only under human confirmation,
and only bundled with a durable artifact. `follow.ts:875-893` plans
`planManualBranchTransition({ physicalBeforeOid: null, afterOid: null, logicalBaseOid })`, whose
physical transaction line is `verify <ref> 0000…0` (`branch-transition.ts:224`) — Git's assertion
that the ref **does not exist** — and commits it as one prepared transaction whose second proof runs
while the transaction holds `<ref>.lock` (`commitPlannedBranchTransition`,
`branch-transition.ts:294-321`). This is the case design 130 anticipated at `130:940-957`: *"If R
is already absent while prior BASE is present, confirmed manual authority uses `verify R absent +
create A` before BASE may become absent."*

**v7 takes the proof from that path and leaves the artifact behind.** The artifact is what produced
five rounds of findings: a durable local record of a deletion the wire has not yet heard about
(§13.6). The proof is what makes the claim honest, and it does not need to be durable — it needs to
be *fresh*, and it is taken in the same push that publishes the omission.

**Proposal P1 — capture-side deletion.** In the push lane, per repository, per `refs/heads/*` ref
`R`:

| Step | Where | What |
|---|---|---|
| **W** — witness | plan, before the candidate is finalized | Evaluate §3.3's nine rules for every `R` where `record.base.refs[R] = X` is positive and `R` is absent from the capture's own **strict** ref read (§3.3a, `capture.ts:259`). O(1) per BASE head against a map the capture already read; **zero new Git subprocesses** in the negative case. |
| **L** — locked proof | plan, immediately after W, once per witnessed ref | One prepared **verify-only** ref transaction — `verify R 0000…0` plus `reserveNonRacingHead`'s HEAD line (`branch-transition.ts:72-91`) — that writes **no artifact and commits no mutation**. Success under `R.lock` is the locked absence proof (§3.3 rule 6). Any refusal — ref present, lock held by another Git process, HEAD moved, transaction error — drops `R` from the **proven** set, and step D below then defers that whole repository's capture for the cycle. **The lock's lifetime is the transaction, and the transaction ends at `commit`** — well before T, POST and K. That is Git 2.46's contract (`prepare` creates the locks, `commit` releases them) and it is what round 6 verified; §3.6 case (d) states the resulting L-to-K window as an accepted one-cycle window rather than claiming a lock that is not held. |
| **D** — defer | plan, after L, in the same pass that decides this repository's outgoing section | **New in v9 (round-7 blocker 1), replacing v8's step G; gated and given a typed reason in v10 (round-8 major 2 and 3).** If **any** `refs/heads/*` ref of this repository has `record.base.refs[R]` positive, is absent from the capture's strict read, has an effective capture `refScope` of `all`, and has **no** passing L proof — **and the repository's projected BASE is active** (`record.repoAbsent !== true && record.removedKey === undefined`, `sync-state-model.ts:455-458`) **and it is not itself being retired this pass** — the repository's capture is **deferred wholesale for this cycle** and its last synced section is carried, through the existing per-repository carry machinery (`revertCapture`, `plan.ts:174-183`, or `deferOne`, `:533-551`, if W/L are hoisted ahead of the capture; §3.2b picks the property, not the helper). When the gate is false the repository's section simply **stays absent** — a hidden provenance anchor is never resurrected. The defer records a **typed** `deletion-pending` capture deferral rather than a regex-classified string (§3.2b, `plan.ts:224-232`). Per-repository, not per-ref; §9.4's per-ref-independence AC is amended accordingly and the latency is stated in §3.2b. |
| **T** — tombstone | `normalizePublishedGitSection` | For a ref with a passing L proof the candidate omits `R` by construction, because capture reads live refs. The normalizer authors one tombstone at **exactly** `X` (below) from the locked-proof map. The pre-existing advertised-diff loop (`publisher-tombstones.ts:108-122`) remains a **second** author of deletion tombstones, and v9 stops claiming otherwise — §3.2b states the one case it authors and why that case is correct. |
| **K** — acknowledgement | the push's ACK state CAS (`push.ts:955-1005`) | `composeRepoBase` retires `BASE[R]` under `publisher-ack`, from the proof carried in the same packet — the same CAS, the same authority and the same crash story as every other ref that section advertised. A ref that only step D's carried section asserts is not part of `absentBranchProofs` at all, so its ACK is a no-op for it: BASE keeps `X` and **retains its prior origin verbatim** — `publisher-ack` mints a new origin only when `requested !== before` (`base-composer.ts:363-367`) and the shared tail re-uses `priorOrigin` when `before === after` (`base-composer.ts:457-461`), which is also why a re-assertion cannot launder a `pull-p` origin into a `publisher-ack` one (round-7 minor 1). |

**The authority change, stated as precisely as the code.** `publisher-ack`
(`base-composer.ts:127-135`) gains one field:

```ts
| { kind: "publisher-ack"; lineageHash; repositoryIdentityHash; incomingKey; sourceSeq;
    advertisedRefs: Readonly<Record<string, string>>;
    /** Refs the accepted section deliberately omits, each with the exact BASE value a
     *  locked verify-only absence proof retired in this same push. */
    absentBranchProofs: Readonly<Record<string, { priorOid: string }>>; }
```

Two sites consult it, and **both are required** — the first decides the branch map, the second
re-adds whatever the first left out:

- `base-composer.ts:357` — `if (requested === null) after = before;` becomes `after = before`
  **unless** `absentBranchProofs[ref]` passes every check below, in which case `after = null` and
  the ref contributes no origin;
- `base-composer.ts:525-527` — the wholesale re-add of every omitted `previousRefs` member skips a
  ref retired by a passing proof.

The checks are pure and every input is already in `composeRepoBase`'s hands:

1. `isBranch(ref)` and `HEX40.test(proof.priorOid)`;
2. `previousRefs[ref] === proof.priorOid` — the proof retires the exact value BASE holds;
3. `candidateRefs[ref] === undefined` — the accepted section really omits it;
4. `candidate.refScope === "all"` and `lockedProof.effectiveRefScope === "all"` — a scoped section
   cannot express whole-repository ref truth (§3.3 rule 9);
5. the accepted section's own `refTombstones[ref]` contains an entry at `proof.priorOid` — **the
   wire this ACK is recording must itself carry the attested deletion.** Without this check a
   retirement could be recorded for an omission no follower could ever act on, which is exactly the
   silent failure round 4's blocker 2 found;
6. every `publisher-ack` shape check already at `:357-362` — lineage, identity, `sourceSeq`,
   `incomingKey`.

Any failure leaves `after = before` and pushes the existing `mismatched-branch-proof` hold, which
already produces a `pending` disposition. Fail-closed, with no new hold code and no new
disposition.

**This is §8's rejected alternative 4, un-rejected on evidence, and the difference is the lock.**
v2–v6 rejected *"let `publisher-ack` remove BASE members"* because *"a capture snapshot is taken
without the repository protocol locks and without a locked R-absence proof. A capture racing a
concurrent checkout, fetch or `update-ref` would author fleet-wide deletions from a torn read."*
That objection is about the **read**, not about the ACK. Step L supplies precisely the missing
locked proof, step W supplies the nine-rule witness, and check 5 makes the wire self-consistent.
What remains is a re-creation between L and the ACK, and it is benign and convergent for a live ACK
(§3.6 case (d)) and closed for a lost one by §3.2c.

**This amends design 130, deliberately, in one sentence.** `130:177-187` says `BASE[R]` may move
present→absent *"only in the same successful expected-absent CAS ref transaction by which rbox
performs and records that transition"*, and `130:302-303` says `publisher-ack` *"may not remove"*
present members. The amendment:

> **A present→absent BASE transition may also be recorded by the publisher ACK of a section that
> omits the ref, when a locked expected-absent ref transaction proved that absence in the same push
> and the accepted section carries the tombstone at that exact value.**

The *evidence* design 130 demands is unchanged — a locked expected-absent transaction. What moves
is only **when BASE is written**: at the acknowledgement, like every other member, instead of ahead
of it. The prohibition design 130 actually needs is preserved and promoted to invariant 11: **no
local artifact retires a BASE member ahead of the wire.** `130:914-919`'s motive ("this prevents
resurrection and repeat re-supersession without claiming an unperformed deletion") is satisfied
more strongly than before: an omission alone still cannot retire anything, and a retirement now
cannot exist without the publication that justifies it.

**Exact tombstone authorship — round 4's blocker 2, re-sourced from the witness.**
`normalizePublishedGitSection` authors new tombstones only by diffing `advertised.refs` against the
candidate (`publisher-tombstones.ts:108-122`), so a ref this device *pulled* and never published —
or published at an *older* value than the one it deleted — produced an omission with **no attested
deletion**, and every v1.6.8+ follower at live/BASE `X` correctly held instead of pruning, silently
defeating §3.0. The gap is wider than "never advertised": whenever
`advertised.refs[R] !== record.base.refs[R]`, which any applied advance produces, the authored
tombstone covers the *wrong* OID. v6 closed this from a durable receipt; v7 closes it from the
witness, which is the same evidence one step earlier:

- a fourth input beside `advertised` / `pendingRetention` / `candidate`: this repository's witnessed
  deletions, `{ ref → priorOid }`, exactly as step W computed them;
- one entry per witnessed ref at `++generation`, `refs/heads/*` only, only where
  `candidate.refs[ref] === undefined`, only where `candidate.refScope === "all"` (matching the
  existing loop's gate at `:108`), `priorOid` 40-hex **and** equal to `record.base.refs[ref]`;
- deduped by `(ref, oid)` against the advertised-diff loop, so a value both loops name is authored
  once and cannot double-increment the generation. The chain *merge* is already `(ref, oid)`-keyed
  with a max-generation rule (`:79-86`), so the dedup is a guard on the two **authoring** loops, not
  on the merge.

The function stays pure, the wire *format* is unchanged, and the entry is validated by exactly
today's validator (`manifest-validate.ts:52-66`) and consumed by exactly today's attestation path
(`tombstone-attestation.ts:91-110`). **The fourth input's name matters and v8 changes it**: it is the
**locked-proof map**, `{ ref → { priorOid } }`, i.e. exactly the `absentBranchProofs` step L
produced — not "what W witnessed". One producer, **three** consumers (T, the dry run and the ACK), no
re-derivation. *(v10 had a fourth — §3.2c's attempt record — which is withdrawn in v11.)*

#### 3.2b Step D — an unproven absence defers the repository's capture (round-7 blocker 1)

**v8's step G is withdrawn, not patched.** G re-advertised the unproven ref inside the outgoing
candidate (`candidate.refs[R] = record.base.refs[R]`). Round 7 killed it on bundle coverage
(B1), on the normalizer backstop it leaned on (B2), and on the absence of any per-repository
refusal path in that normalizer (M1). Two of those are wiring; **the first is not repairable at
all**, and v9 says so before proposing anything:

- **A full capture builds its bundle from the live refs, where `R` is absent** (`capture.ts:189`,
  `:198`, `:344`; the incremental basis is a `^tip` exclusion over `gitSectionTips(base)`,
  `capture.ts:296-304`). Incremental capture is off when configured off (`git.incremental:false`
  → `shared.ts:136`), when capture is forced, when the basis falls back, when the chain cap is
  hit, or when byte-bound recompaction runs. In every one of those paths a section carrying
  `R = X` has no pack link covering `X`, and a fresh receiver that imports exactly
  `packChain + newest` cannot materialize the ref. That is the bundle-coverage half of the P4
  landmine, exactly as round 7 states it.
- **Making G "participate in capture inputs" does not fix it, because the object may not exist.**
  `R` was deleted; `X` is unreachable; **R4 ruled that the deleting device keeps no pin** (§3.0a,
  §3.7, §12 Q3). After `git gc` — `gc.pruneExpire` default two weeks, `gc.auto` on ordinary
  churn — `X` is gone from the local object store, so no capture in any mode can bundle it. A
  mechanism whose correctness depends on an object R4 deliberately declined to retain is not a
  wiring gap.

**So the outgoing representation cannot be per-ref, and v9 stops trying to make it one.** Step D
is the whole-repository answer, and it is today's answer for every other repository that cannot be
captured safely right now:

> For a repository whose effective capture `refScope` is `all` **and whose projected BASE is active**:
> if **any** `refs/heads/*` ref `R` has `record.base.refs[R]` positive, is absent from this capture's
> strict ref read (§3.3a), and has **no** passing step-L proof, the repository's capture is **deferred
> for this cycle** and its last synced section is carried.

**The active-BASE gate, and why a positive `record.base.refs[R]` does not imply a carriable section
(round-8 major 2).** v9 argued that `pending[rel] ?? base[rel]` is total because the trigger requires
`record.base.refs[R]` positive. The state model deliberately makes that implication false:

- `RepoRecord.repoAbsent` and `removedKey` **retain `record.base` as a non-authoritative provenance
  anchor while hiding it from the projection** — `stateFromRepoRecords` builds
  `state.lastSyncedManifest.gitRepos` from `record.repoAbsent !== true && record.removedKey === undefined
  ? record.base : undefined` (`sync-state-model.ts:455-458`), and `base` in the planner *is* that
  projection (`plan.ts:141`). So `record.base.refs[R]` can be positive while `base[rel]` is absent.
- A remote repository removal with a surviving local `.git` produces exactly that shape: apply drops the
  projected section, preserves BASE under **carry** authority, and records `removedKey`
  (`apply.ts:691-718` — `delete applied[rel]`, `repoProofs[rel] = carryRepoBaseProof(...)`,
  `removedMem[rel] = …`). `pending[rel]` is deleted in the same arm (`apply.ts:702`).
- If that leftover later changes identity, the push planner clears the removal memory and captures it as
  a **re-add** (`plan.ts:599-604`). At that moment `record.base.refs[R]` may be positive with `base[rel]`
  **and** `pending[rel]` both absent — so v9's fallback is `undefined`, `revertCapture`'s `fallback:
  GitSection` parameter is not optional (`plan.ts:174`), treating `undefined` as an outgoing section
  fails normalization, and resurrecting the hidden anchor would contradict the very suppression that
  hid it.

**So the gate is part of the trigger, and the hidden-anchor disposition is named rather than left to the
fallback.** Step D applies only when the repository's BASE is *active* — equivalently
`state.lastSyncedManifest.gitRepos[rel] !== undefined`, i.e. `record.repoAbsent !== true &&
record.removedKey === undefined` — **and** the repository is not itself being retired in this same pass
(`plan.ts:813-817` drops the section and sets `repoAbsent[rel]` when the directory is gone; the
removal-memory arm at `plan.ts:599-604` returns before any capture when the identity still matches).
When the gate is false:

> **The repository's section stays absent** — no defer disposition, no carried section, and no
> `revertCapture` call with a `base[rel]` fallback. That is already the correct wire outcome and it
> destroys nothing: a hidden anchor asserts nothing on the wire (the removal has been applied, so the
> wire has no section for `rel`), the outgoing map has no entry for `rel`, so
> `normalizeOutgoingGitSections` never iterates it (`publisher-tombstones.ts:180-193`) and **no
> tombstone is authored for `R` or for anything else**.

**"Stays absent" is a claim about the persisted record too, and v10's version was not — round-9
blocker 3.** The hidden-anchor fixture reaches step D *because* the leftover's identity changed, and the
planner's re-add path gets there by **clearing the removal memory**: `delete removedMem[rel]`
(`plan.ts:604`), against the copy it took at `plan.ts:147`. That copy is exactly what the planner
publishes as `gitReposRemoved` (`plan.ts:284`), and both push state saves feed it straight into the
record — `removed: gitPlan.gitReposRemoved` (`push.ts:669` commit-free bookkeeping, `:993` accepted
ACK) → `removedKey` present only when the map names `rel` (`sync-state.ts:241`). So discarding the
capture without touching the memory writes a record with **no** `removedKey`, and
`stateFromRepoRecords` then projects the hidden anchor **active** again (`sync-state-model.ts:458`).
The next cycle finds `baseSec` truthy, the gate **true**, and a second proof refusal carries the
**stale pre-removal BASE section** — publishing a section the wire does not have. Round 9 is right that
v10's required conjunction is unreachable as specified. The repair is two clauses, both normative:

1. **The discard removes rather than replaces.** `out[rel]` and `finalizedOutgoing[rel]` are
   **deleted**, `rel` is removed from `captured`, and the authored config hash is cleared — the
   `revertCapture` bookkeeping (`plan.ts:174-183`) with *no* fallback section rather than with an
   `undefined` one, which is the type-level statement round-8 major 2 asked for. Hoisting W/L ahead of
   `commitCapture` for this route, so there is no committed capture to undo, is equally acceptable; the
   design does not pick, and the published-map postcondition is identical.
2. **The removal suppression is restored, not left cleared.** `removedMem[rel]` is re-set to the
   `record.removedKey` value `plan.ts:604` deleted — the same source `plan.ts:409` reads — so
   `gitPlan.gitReposRemoved` still names `rel`, both saves re-write `removedKey`, and `record.base`
   stays hidden at `sync-state-model.ts:458`. The **old** key is restored, never the leftover's new
   identity: restoring the new identity would make the leftover look like untouched removal residue
   forever and the re-add would never publish at all. Restoring the old key means the next cycle clears
   the memory again, captures again, and publishes the re-add on the first cycle L passes — which is
   what *"a deferred re-add publishes on a later cycle exactly as an undeferred re-add would"* has to
   mean to be true. For the `repoAbsent` sub-shape the equivalent clause is that `repoAbsent[rel]` is
   left set.

This makes the fallback `pending[rel] ?? base[rel]` **total** by the gate rather than by assumption, and
§9.1's re-add row now asserts the *state save* as well as the planner output. Note that the gate is a
strict narrowing: it can only
*reduce* the set of repositories that defer, and every repository it excludes was already publishing no
section for `R`, so it cannot re-open round-7 blocker 1.

**Which helper, and why the answer is probably not `deferOne` — stated because getting it wrong is a
silent bookkeeping bug.** The two per-repository primitives differ in exactly the places that matter
here:

| | `deferOne` (`plan.ts:533-551`) | `revertCapture` (`plan.ts:174-183`) |
|---|---|---|
| Fallback | chosen internally: `pending[rel]` → (forced-repo drop) → `base[rel]` → nothing | an **explicit argument** |
| `finalizedOutgoing` | not written — so a call after `plan.ts:987-989` is **silently ignored**, because `plan()` publishes `finalizedOutgoing` when it is set (`plan.ts:235-237`) | written (`:176`), which is what that line exists for |
| `captured` / `repoAbsent` / `authoredCfgHashByRepo` | leaves `captured` alone | removes `rel` from `captured`, clears `repoAbsent[rel]` and the authored config hash |

Step W is specified against *"a map the capture already read"* (§3.2 step W, `capture.ts:259`), so on
the natural implementation the section has already been captured and `commitCapture` has already run
(`plan.ts:169-173`). In that ordering the correct helper is
**`revertCapture(rel, pending[rel] ?? base[rel], reason)`** — it is the one that undoes a *successful*
capture, and it is the one that patches the finalized map. `deferOne` is correct only if W and L are
hoisted to run **before** the capture is committed for that repository, which is a real option (BASE
and a strict `show-ref` are both available earlier) and is cheaper, because it skips a bundle build
that will be thrown away. **Either is acceptable and the design does not pick for the implementer; what
it fixes is the property**: the published outgoing map for that repository must end up holding the
carried section, and `captured` must not claim a capture that was discarded. §9.1 asserts the published
map, not the helper.

**Bundle coverage is trivially satisfied, and this is the whole reason to prefer it.** Both primitives
carry a section they did not build — `deferOne`'s three arms are the clearest statement of where the
bytes come from:

```ts
const protectedSection = pending[rel];
if (protectedSection) { out[rel] = protectedSection; /* … */ return; }   // plan.ts:536-543
if (force.has(rel)) { /* 422 recapture: section dropped */ return; }     // plan.ts:544-547
const b = base[rel];
if (b) out[rel] = b; // defer-with-base-carry: never regress a synced repo  // plan.ts:548-549
```

Both carried sections are sections the wire has already carried, with their own `bundleSha` /
`bundleEncSha` / `packChain` spread through `normalizePublishedGitSection` untouched
(`publisher-tombstones.ts:166`). The pending branch is additionally byte-exact by identity — the
normalizer short-circuits on `gitIncomingKey(pending) === gitIncomingKey(section)`
(`publisher-tombstones.ts:183-187`), and `out[rel]` *is* `pending[rel]` (`revertCapture` gets the same
property by writing that object straight into `finalizedOutgoing`, `plan.ts:176`). **Nothing is
composed, so there is nothing whose coverage has to be argued.**

**One branch of `deferOne` is not a carry, and step D must not reach it.** The middle arm drops the
repository's section from the commit entirely when `force.has(rel)` and no pending section exists
(`plan.ts:544-547`) — the 422 recapture case, where BASE references blobs the server lost. That arm is
correct for its own cause and wrong for this one: dropping the section would omit **every** ref,
including `R`. Step D's fallback is therefore explicit — `pending[rel] ?? base[rel]` — and the
degenerate case where neither exists (a repository that has never published) cannot arise, because the
trigger requires a positive `record.base.refs[R]`. §9.1 asserts the forced-recapture row.

**And the carried section still asserts `R = X`, which is the property G was reaching for.**
`base[rel]` is `state.lastSyncedManifest.gitRepos[rel]`, projected from `record.base`
(`sync-state-model.ts:457-458`), and BASE holds `R` positive by the trigger's own premise — a
`publisher-ack` composition re-adds every omitted previous member (`base-composer.ts:525-527`). So
the wire keeps asserting exactly what BASE asserts, the candidate never omits `R`, and the
pre-existing advertised-diff loop's first statement skips it:

```ts
if (candidate.refs[ref] === priorOid) continue;                 // publisher-tombstones.ts:112
```

**No deletion tombstone is authored, with zero normalizer change.** That is the part v8 needed a
new refusal rule for, and step D gets it by construction.

**Step D's own deferral reason needs a producer, because the capture lane classifies by regex
(round-8 major 3).** §5.2 specifies `deletion-pending` and §13.4 item 10 promises the standing-refusal
residual is *reported* under it — but §5.2's producer is the **apply**-lane hold (`follow.ts:717-767`,
`:1030-1037`), and step D lives in the **push** lane. Round 8 traced what v9's free-form reason string
actually becomes:

- `revertCapture` / `deferOne` record `deferred.push({ relPath, reason })` — a **string**
  (`plan.ts:159`, `:182`, `:540`, `:550`).
- `plan()` classifies every non-config item with `captureReason(item.reason)` (`plan.ts:224-232`,
  applied at `:275-278`), whose arms are ordered regexes ending in `return "other"`.
- There is no `deletion-pending` arm. An exact `"deletion-pending"` detail falls through to **`other`**;
  worse, any natural phrasing containing the word *capture* — "deletion capture deferred", which is what
  a reason line for this condition wants to say — matches `/capture|artifact|blob|decrypt|import|bundle/`
  and is classified **`artifact`**. Both are the wrong sentence: the user is told rbox had an artifact
  problem, or an unclassified one, rather than that rbox is finishing a branch they deleted.

**The decision: step D mints its reason as a typed value, through the deferral channel's own existing
metadata plumbing.** `deferred`'s items are already tagged out-of-band **by object identity** for the
config lane — `configLaneDefers` and `configLaneItems` are `Set<(typeof deferred)[number]>`
(`plan.ts:160-161`) consulted before `captureReason` runs (`plan.ts:275-278`). v10 uses the same seam
rather than a new one:

> The deferral item gains an optional typed reason —
> `deferred: Array<{ relPath: string; reason: string; typedReason?: GitDeferralReason }>` — and
> `plan()`'s classification becomes
> `captureDeferrals[item.relPath] = item.typedReason ?? captureReason(item.reason)`. Step D's call passes
> `typedReason: "deletion-pending"` explicitly; every existing producer is unchanged and keeps its regex
> classification. `revertCapture` (`plan.ts:174-183`) and `deferOne` (`:533-551`) each take the optional
> reason through to the item they push.

An exact non-regex arm at the top of `captureReason` (`if (reason === "deletion-pending") return
"deletion-pending";`) is an acceptable alternative **only** if it is placed before the `artifact` arm and
the reason string is exactly that literal — but it makes the human-readable detail line and the machine
classification the same string, which is why the typed field is the specified form: the log line
`git-sync deferred <rel>: finishing a branch deletion rbox could not prove (…)` and the enum stay
independent. §5.2's inventory gains this producer as a row, and §9.1 asserts it on the **capture** lane
(the apply-lane `FollowProgress.blockers` test does not cover it).

**One consequence about `refScope`, verified, because it removes the largest permanent class.**
The trigger is gated on `refScope === "all"` and that gate is not decoration: an omission inside a
**scoped** section is inert on every receiver. `effectiveRefs` sets
`deleteAbsent: incoming.refScope === "all"` for a `dir` repo and `false` otherwise
(`follow.ts:609`, `:614`), and the candidate set only absorbs `base.refs`/`live.refs` keys when
`effective.deleteAbsent` holds (`follow.ts:713`). So a scoped section's omitted head never reaches
`planBranchTransition({ afterOid: null })` and never reaches the attestation path. §3.3 rule 9's
refusal therefore does **not** trigger step D — a `scoped` repository publishes its omission
exactly as today, and that omission destroys nothing anywhere. `refScope` is fixed by repository
kind (`capture.ts:344`: `ctx.kind === "dir" ? "all" : "scoped"`), so this is a stable partition,
not a per-cycle accident.

**What step D costs, stated as latency rather than buried.** Round 6 named `deferOne` and rejected
it because it "suppresses all 23 otherwise-valid deletions and violates §9.4's per-ref-independence
AC". That objection is correct on the facts and v9 accepts the cost rather than engineering around
it:

- **24 deletions, one refused L ⇒ all 24 wait one cycle, and so does every other change in that
  repository's Git plane** — refs, `head`, index, op-state and config all ride the same section.
  The file plane is unaffected: `deferOne` is a `planGitSections` decision and files sync on their
  own lane.
- **The refusals that produce this are transient by construction.** Step L is one prepared
  verify-only transaction; it fails on `<ref>.lock` contention (another Git process creating or
  deleting the *same* absent ref — rare), on a HEAD move between planning and
  `reserveNonRacingHead`'s `symref-verify`/`verify` line (`branch-transition.ts:72-91`), or on a
  transaction error. Every one of those clears when the concurrent Git operation ends. The same is
  true of §3.3's rules 5 (git busy / preflight) and 3's P/K arm (`p-repair` runs first). **One
  cycle of latency for a routine `git branch -D` batch is the honest price, and it is cheaper than
  a section whose refs its own bundle cannot cover.**
- **Some refusals are *standing*, and that is a new named residual (§13.4 item 10), not a
  self-clearing wait.** Rule 1 (no usable current-lineage origin for `X`), rule 3's stale owning A
  (the §10 non-goal), rule 4 (a sibling worktree whose HEAD names the absent ref), rule 7 (`R` is
  the HEAD symref target — an unborn branch) and rule 8's missing `logs/HEAD` on a repository with
  reflogs disabled all persist until their cause does. While one stands, that repository's Git
  plane carries its last synced section and publishes nothing new. **This is §4.2's and §13.4 item
  5/7's residual class with a new member — an unreconcilable ref forces a whole-section carry —
  and its honest fix is the same one: per-ref publishing, design 201.** It is reported, not silent:
  the repository records a `deletion-pending` deferral (§5.2) and the exits that exist today are
  clearing the cause, `git branch <R> <X>` from a value the fleet still has, or
  `rbox git resolve <repo> take-theirs` (§2.4). **`keep-mine` is not an exit for this class**,
  because §3.6 case (b) lifts its refusal only where the witness licenses the absence, and by
  construction it does not here. Widening `keep-mine` to publish a *human-authorized* deletion that
  rbox could not auto-prove is the obvious next verb and is recorded as a follow-up in §10 rather
  than shipped here.
- **What step D is *not*: a threshold.** It counts nothing. One unproven head defers the
  repository; twenty-four proven heads publish together. R4's ruling stands untouched (§3.0a).

**The kill switch, worked out rather than asserted (round-4 blocker 4, restated honestly).**
`RBOX_GIT_ABSENCE_CAPTURE=0` disables the entire push-side lane: W, L, T's proof-map arm, **step D
itself**, and the ACK's `absentBranchProofs`. With no witness evaluation there is no defer trigger,
the capture omits the locally-absent BASE-positive head the way it does today, and the pre-existing
advertised-diff loop authors a tombstone at the advertised value with no proof input of any kind
(`publisher-tombstones.ts:108-121`). **That is exactly the pre-200 binary, bug included — which is
what a kill switch is for.** The alternative, keeping D live with the switch off, would defer every
repository holding a phantom BASE head the moment someone flips the switch at 2am; a switch whose
off-state manufactures wedges is worse than no switch.

So the **rollback contract is restated**, because v7 asserted one code did not honour and v8
asserted step G made it true: *flipping the switch off restores the pre-200 publication behaviour
exactly.* It does **not** promise that no unproven deletion is published, because the author that
publishes one predates this design and is not behind the switch. §9.5's "switch-disabled ⇒ still
carried, never omitted" row is **withdrawn** — it was a v7 assertion with no mechanism, v8 backed
it with step G, and v9 has no step G. §11 carries the corrected table.

**The structural pin, at the layer where the predicate is decidable.** v8 put the backstop in
`normalizePublishedGitSection`. Round 7 showed both halves of that fail: the normalizer cannot see
BASE, so its predicate has to be written over `advertised`, and `advertised` positive + candidate
absent is **also** the shape a legitimate already-applied remote deletion produces (B2), which the
refusal would then reject forever; and the normalizer is a total map transform with no per-repository
refusal path anyway (M1). **v9 adds no normalizer refusal.** The plan *is* the layer that can see
BASE, the live refs and the proof map together, so the assertion belongs there and it is a test, not
a runtime throw:

> Over the real `planGitSections`, no section in the published outgoing map **whose effective
> `refScope` is `all`** ever **omits** a `refs/heads/*` ref that this device's `record.base.refs` holds
> positive, unless step L produced a passing proof for it in the same push.

**The `refScope === "all"` qualifier is part of the assertion, not a detail of it — round-9 major 1.**
v10 wrote the pin universally while the paragraph above it establishes the opposite for `scoped`
sections: rule 9's refusal does **not** trigger step D, a `scoped` repository publishes its omission
with no proof exactly as today, and that omission is inert on every receiver. Those two statements are
mutually unsatisfiable for the scoped fixture, which §9.1 asserts explicitly. Qualifying the pin — and
its test — with the effective scope is what makes them consistent, and it costs no coverage: the scoped
partition is fixed by repository kind (`capture.ts:344`), so no `dir` repository escapes the pin by
drifting into `scoped`.

Three exceptions belong in that assertion's own statement rather than in its implementation, because
all three are correct:

1. **BASE no longer holds the ref.** After an incoming tombstone retires `BASE[R]` under
   `pull-ref-transaction` (§3.6 case (c)), the next capture legitimately omits `R` with no proof and
   the trigger is false — `record.base.refs[R]` is absent. This is round-7 blocker 2's scenario and
   it composes without a special case: **the defer keys off BASE, and BASE is already retired.**
2. **`advertised` may still hold it, and the advertised-diff loop may re-author a deletion tombstone
   at the advertised value.** That is today's behaviour on any carry or capture whose BASE has moved
   ahead of `advertised`, the deletion in question was already proved and applied by whoever
   published it, and re-publishing it is idempotent. It is precisely why v8's refusal could not
   ship, and precisely why **v8's "one authority for authoring a branch-deletion tombstone" claim is
   withdrawn**: there are two authors, the second one is correct, and the design says so.
3. **The section's effective `refScope` is `scoped`.** Rule 9 refuses the *capture* of that absence, but
   the section still publishes with the ref omitted and no proof, because a scoped omission reaches no
   receiver's `planBranchTransition` (`follow.ts:609`, `:614`, `:713`) and destroys nothing. This is the
   qualifier above, restated as the exception it is.

**A later successful L needs no cleanup.** Step D writes nothing durable. The next cycle re-derives
W and L from BASE and the live refs; if L passes, the capture omits `R`, T authors the tombstone at
`record.base.refs[R]`, and K retires it. Invariant 11 is untouched.

#### 3.2c The lost-ACK window — §12 C3 **WITHDRAWN 2026-07-25 (round 9)**. The race is an accepted residual.

**This section is a superseded record.** v8 TOOK §12 C3 and closed this window with a persisted
field, `record.absencePublicationAttempt`; v9 and v10 rebuilt that field's lifecycle twice.
**v11 deletes the field and every part of its apparatus and accepts the race as a stated residual
with named recovery paths.** §3.2's steps W/L/T/K, §3.2b's step D, §3.6's per-ref hold and §3.2d's
P1b are untouched — none of them ever read the field.

**The window, unchanged from round 6's finding, because the finding was correct.**

1. L proves `R` absent and its transaction **commits**, releasing `R.lock` (§3.2 step L).
2. Any local Git process re-creates `R` at the same `X` before the POST — an agent, a
   `git checkout -b`, a `git branch <R> <X>` from a value the user still has in a terminal.
3. The POST is accepted; the ACK state CAS is lost to a crash. **BASE was never retired.**
4. The next pull sees the accepted omission and its tombstone at `X` while live `R` and logical BASE
   are *both* `X`. `checkTombstoneAttestation` requires exactly
   `liveOid === oid && logicalBaseOid === oid` (`tombstone-attestation.ts:109-111`) — both hold — so
   it **authorizes** and the legitimate re-creation is pruned.

v7's §3.6 case (d) claimed attestation refuses "because live ≠ the tombstoned OID". That is false for
the case case (d) expressly includes ("re-created … at `X`"): after a *successful* ACK the refusal
comes from `logicalBaseOid === null`, and a lost ACK is exactly the state in which BASE is still `X`.
§3.6 case (d) is corrected there.

**Why the field is withdrawn: four consecutive rounds of blockers, all inside its lifecycle.**

| Round | Findings inside the C3 field or its interactions |
|---|---|
| **6** | B2 — the race itself; the field is TAKEN as the answer |
| **7** | B3 drop condition 2 is true in the exact state the field must protect; B4 a second arm overwrites the first; B5 an unrelated ACK clears a still-advertising omission; M2 the current-branch shape does not terminate |
| **8** | B1 the survivor rule is an undisclosed **permanent** non-current latch; B2 the clear predicate is true when both sides omit the ref; M1 the clear site holds neither of its two claimed inputs |
| **9** | B1 one slot per ref is not overlapping generations — a same-ref re-arm still loses a generation; B2 the production legacy/degraded state writer drops the whole field and bypasses the condition-1 boundary; B4 the hard-cap overflow disposition **recreates** round 8's latch at the advertised bound |

Twelve findings across four rounds, every one of them in this single mechanism, and no round in which
its lifecycle was correct as written. *(Round 9's fourth blocker, B3, is the only one of the last four
rounds' blockers that landed elsewhere — in §3.2b step D's own bookkeeping, where it is fixed on its
merits and not by this withdrawal.)* Round 9's B2 is the decisive one, because it is not a predicate
error: the field would have to survive `legacyState`, which deliberately writes
`repoRecords: undefined` and reprojects only `gitDeferrals` / `gitPartial`
(`sync-state.ts:289-321`, `sync-state-model.ts:373-420`) — a path taken by **all three** push state
saves and by degraded-mutex pull through `forceLegacy` (`push.ts:622-631`, `:674-683`, `:1001-1013`;
`pull.ts:379-412`; `sync-state.ts:332-351`). Closing it means either teaching the compat writer a
projection for the field or making Git publication **fail closed** whenever transactional state
persistence is unavailable. Both are new machinery in a lane this design otherwise never touches.

Under the founder's ruled principles that is where the defence stops being proportionate to what it
defends:

- **"Some math is just not gonna prevent it; there's always a gap"** (R4, §3.0a, recorded verbatim).
  Every round closed the stated defect and the next found a reachable state the lifecycle mishandled.
  R4 used exactly that reasoning to retire the mass-deletion breaker *and* the deleting device's pin;
  it applies unchanged to a field defending the same class of loss.
- **rbox promises FILE history, not Git history** (R4, §3.0a). What this field defends is one
  **branch pointer**, on one device, inside one crash window. The durability contract is one plane
  over and this race does not touch it.
- **No pins, no thresholds** (R4). By v10 the field carried a hard cap at
  `MAX_REF_TOMBSTONES_PER_REPO`, an overflow disposition, a per-entry generation annotation, a merge
  rule, a composition-boundary evaluation site, a push-entry reconciliation and four ACK-side
  conjuncts — and round 9 added a legacy-writer preservation requirement. That is v6's
  `absenceOmission` apparatus re-grown under a new name, which §8 item 12 refuses on five rounds of
  evidence.
- **A model that breaks with a new exotic input every review round means the wrong plane** (the
  standing rule §13.3 quotes). v7 applied it to early BASE retirement. Round 9 applies it to the field
  that replaced it.

**The residual, stated exactly. This is the design's answer to the race.**

> A crash inside the window between an accepted POST and its state CAS, **plus** a local re-creation
> of the deleted branch at **exactly** the OID the accepted tombstone names, before this device's next
> pull, lets the apply lane consume this device's own accepted tombstone against the re-created ref —
> deleting that ref locally, **once**.

Every conjunct is load-bearing and each one is code:

1. **The crash must land inside the accepted-POST→state-CAS window.** That is the only state in which
   BASE still holds `priorOid` while the wire already carries the tombstone.
   `checkTombstoneAttestation` demands `facts.liveOid === facts.oid && facts.logicalBaseOid ===
   facts.oid` (`tombstone-attestation.ts:109-111`); after a successful ACK `logicalBaseOid` is `null`
   and the identical re-creation is hard-vetoed.
2. **The re-creation must be at exactly the tombstoned OID.** Authority is looked up as
   `map.entries[facts.ref]?.[facts.oid]`, keyed by the **live** OID
   (`tombstone-attestation.ts:102`), so a re-creation at any other value has no entry and hard-vetoes
   at `:103-105`. A re-creation at `X' ≠ X` is held, not pruned.
3. **It must precede the pull that applies the accepted omission.** If `R` is absent when that pull
   lands, no ref is deleted at all (`follow.ts:936`'s `!oldOid && !newOid` continue) and BASE retires
   through §3.6 case (c)'s `pull-ref-transaction` arm; every later re-creation is then an ordinary
   creation against an absent BASE member.
4. **What is lost is a ref, once, on one device** — and the non-recurrence argument below is why
   "once" is exact rather than optimistic.

**It does not recur, and the precision matters — two different transactions are involved and v11 says
which.** The **pin** is in the same `git update-ref` transaction as the delete (recovery path 1 below).
The **BASE retirement** is in that same apply pass's state save: the prune is design 130's blessed
apply-side present→absent path, so the follow's `branchLockedProofs` / `branchWitnesses` feed a
`pull-ref-transaction` authority composed in the save that pass performs (`apply.ts:1258-1275`;
invariant 11's first arm). Once it lands, BASE is absent for `R`, so a second `git branch R X` faces
`logicalBaseOid === null` and is hard-vetoed by the same predicate that would have refused it after a
successful ACK (`tombstone-attestation.ts:109-111`); §3.3 rule 2 also fails for a present ref, so no
witness, no proof and no tombstone are produced, and the capture asserts the re-created ref as an
ordinary present head whose ACK publishes it. **And if that state save is *also* lost to a crash,
nothing latches**: the next pull sees the head still omitting `R` with `R` absent locally, takes
`follow.ts:936`'s no-op branch and retires BASE through §3.6 case (c) with no ref to delete. So the
retirement is retried unconditionally and is idempotent. What that leaves is honest and bounded: **each
occurrence of the loss requires its own crash inside the window *and* its own same-OID re-creation
before the next pull.** The residual is one-shot per crash, not self-sustaining, and it is not a latch —
which is exactly the property every version of the withdrawn field failed to guarantee for itself.

**The three recovery paths, verified rather than asserted.**

1. **The tombstone-prune keep-pin — VERIFIED to fire on this exact path.** The self-consumption goes
   through the same design-116 prune-with-pins transaction as any follower prune, because nothing
   anywhere filters tombstones by author: `GitRefTombstone` is `{ oid, ts, generation }` with no
   publisher field (`src/engine/types.ts:71-75`), enforced by exact key-set equality in validation
   (`manifest-validate.ts:71`), and the apply lane has no self-authorship branch at all (§8 item 14).
   Concretely, for every tombstone-authorized `refs/heads/*` prune `follow.ts:947-949` calls
   `prepareTombstonePrunePins(repoDir, ref, oldOid, …)`, which creates
   `refs/rbox-local/keep/<oldOid>` with a `tombstone`-class origin for the pruned tip and
   **permanent `human`-class origins for every other OID in that ref's reflog**
   (`keep-pins.ts:635-654`; tip at `:646`, reflog set at `:644-647`). The pin lines and the
   `delete <ref> <beforeOid>` line are **one** prepared `git update-ref` transaction
   (`branch-transition.ts:119`, committed at `:301`), so there is no instant in which the ref is gone
   and the pin is not there. Recovery is `git branch <R> <oid>` with the OID read from the pin ref's
   own name. Three honest limits, none of which is new to this design: the tip's origin is
   `tombstone`-class and therefore expirable in principle after `TOMBSTONE_PIN_RETENTION_MS`
   (`keep-pins.ts:68`), which never happens today because `expireTombstoneKeepPins` has **no
   production caller** (§7.1 item 4); nothing *surfaces* the pin to a user, because R4 removed
   `rbox git deleted` and `show-me` structurally cannot print an OID (§7.2); and **this does not
   reverse R4** — R4 ruled that the *deleting* device writes no pin at *capture* time, whereas this
   pin is written by the *prune* in the apply lane and is pre-existing behaviour this design must not
   regress (§3.7, §9.6).
2. **The user's own reflog, when the re-creation was a checkout.** `git checkout -b R X` /
   `git switch -c` moves HEAD, so `logs/HEAD` still carries `X` and the branch is one
   `git branch R X` away. A bare `git branch R X` does not touch HEAD, and a ref's own reflog goes
   with the ref — which is precisely why path 1 enumerates and pins the whole reflog set *before* the
   delete rather than only the authorized tip.
3. **File history — the ruled contract.** Any content that lived only on that branch is recoverable
   through the file plane at a prior sequence for the plan window (`rbox restore <file>@<seq>`,
   `help-registry.ts:322-330`; `apps/api/src/plans.ts:24-27`). That is R4's promise and §3.0a's first
   row, and it is the reason this residual is a *pointer* loss rather than a work loss.

**What the withdrawal deletes, listed so nothing is left half-wired.** The
`GitAbsencePublicationAttempt` / `GitAbsenceAttemptEntry` types; `RepoRecord.absencePublicationAttempt`;
the `values.absencePublicationAttempt` state-source lane and its `{ arm, clearAsserted }` merge
instruction; the pre-POST arm inside `beforeCommitSend`; amendments 1, 1b, 2 and 3; drop conditions
1–3 and their evaluation sites (including the composition-boundary hook at
`sync-state-store.ts:165-180`); the push-entry reconciliation; the per-lane withhold table; the
termination derivation, the latch test and the `MAX_REF_TOMBSTONES_PER_REPO` bound with its overflow
disposition; and the downgrade paragraph. **It also deletes every `forcedHeldRefs` install this
design proposed**: after v11, design 200 adds no `forcedHeldRefs` member anywhere, and the only hold
it installs is §3.6 step 1's `classifiedHolds` entry, re-derived each cycle from BASE and the live
refs with nothing durable behind it. §9.1's five C3 rows go, and §9.6's invariant-11 snapshot row
returns to its **unnarrowed** form. §8 items 13 and 14 **stay**, as the record of two rejected
alternatives; item 14's closing sentence is corrected, because the durable floor it pointed at no
longer exists.

**What a future reviewer must not re-propose without new evidence.** Any durable local record of an
unpublished deletion — under any name, in any lane, authorizing or merely withholding — is §8 item 12
plus §12 C2 and C3 together: five rounds killed the authorizing form and four killed the withholding
form. The next honest move for this race is **not** a smaller field. It is design 201's per-ref wire
model, which dissolves the whole-section coupling the race lives inside, or a founder ruling that
reverses R4 for the Git plane.

#### 3.2d Proposal P1b — unblock the pending lane

*(P1b was written under §3.2c's heading through v10 and never depended on the withdrawn field; v11
gives it its own subsection so the withdrawal above cannot be read as touching it.)*

`pendingSupersessionPreProbe`
(`pending-supersession.ts:103-105`) and `provePendingSupersession` (`:198-209`) must stop treating a
missing head as an automatic carry. The new per-ref rule for `refs/heads/*`:

| Local state of a pending head `R` | Disposition |
|---|---|
| present and equal, or a fast-forward descendant | supersede (today's rule) |
| absent, **step L produced a passing locked proof**, and **`pending.refs[R] === record.base.refs[R] = X`** | **supersede** (new) |
| absent, proof passed, but `pending.refs[R] ≠ record.base.refs[R]` | **carry** (new in v4, kept) — the pending value arrived from a writer this device never followed, so superseding it would retire a value this device never held. §3.6 case (b) |
| absent, no passing proof (W refused, L refused, or the kill switch is off) | carry (today's rule — fail closed) |

*(v8 states the second and fourth rows against **L's proof** rather than against "the witness":
round-6 blocker 1's shape is a passing witness with a refused proof, and P1b must fail closed on
exactly that. **v9 notes that the fourth row is now unreachable through this table**, because step D
(§3.2b) defers the whole repository's capture before the pre-probe is ever consulted for a ref with
no passing proof — the row stays as the fail-closed statement of record and as the behaviour if step
D is ever gated off, but the code path that reaches it is the defer, not the carry. The two are the
same outcome for that repository, one cycle, retried next cycle.)*

Tags and `refs/stash` keep their exact-equality rule (`pending-supersession.ts:106-108`, `:203-204`)
untouched: safe refs have never had A/P/K semantics and design 130 forbids substituting one witness
class for the other.

**The binding is the one round 2 demanded and round 3 closed clean; only its source moved.** v4–v6
required `receipt.priorOid === pending.refs[R]`; v7 requires
`record.base.refs[R] === pending.refs[R]` under a live locked witness. Both say *"the omission
retires exactly the value the pending section asserts"*, and BASE-plus-origin is the stronger
provenance of the two: §3.4's invariant makes it proof that **this device physically held that ref
at that OID**, which is exactly what the A payload recorded. `follow.ts:857` already gates its crash
reconstruction on the identical equality against `baseOid`. Round 2's counterexample is refused for
the same reason it was before — a device holding `X` may not retire another writer's `Y`.

**The ACK dry-run must see the same proofs.** `pendingSupersessionAckConverges`
(`pending-supersession.ts:35-62`) composes BASE with a `publisher-ack` authority built from the
candidate and requires `isDeepStrictEqual(composed.base, candidate)`. It therefore takes the same
`absentBranchProofs`; without them the composed BASE re-adds `R` (`base-composer.ts:525-527`) and
the dry run refuses every deletion. **The dry run (`plan.ts:1037`) and the real ACK (`push.ts:962`)
must be handed the same immutable proof map produced by step L** — one producer, two consumers, no
re-derivation between them, which is the same discipline `gitIncomingKey`-bound proofs exist to
enforce elsewhere.

**The §1.2 field wedge is cleared by exactly this path**: `pending.refs[R] = base.refs[R] =
2c866687…`, `R` absent, artifacts clear, so the witness holds, `L` proves the absence, the omitting
candidate supersedes, the tombstone names `2c866687…`, and the ACK retires the BASE member that has
been unretirable since 2026-07-21.

#### 3.2a One artifact-disposition reader, both lanes — round-4 major 1, narrowed

§3.3 rule 3 (no A, no P/K, no settled absence, no active foreign artifact for `R`) is the one
witness rule that needs the protocol scan. The apply lane already has it:
`prepareFollowerBranchProtocol` returns `artifacts[ref]: BranchArtifactDisposition`
(`follower-protocol.ts:81-115`). The push lane has nothing — `plan.ts:781` calls the pre-probe with
`(root, rel, pend)` and no protocol object at all, which is why round 4 refused v5's "add a fourth
argument". So the reader is named once and shared:

```ts
/** Current-lineage branch artifact dispositions for one repository, or undefined.
 *  undefined ⇒ nothing is proved ⇒ every consumer carries (fail closed). */
readCurrentLineageBranchArtifacts(root, relPath, state, ctx)
  : Promise<Readonly<Record<string, BranchArtifactDisposition>> | undefined>
```

- It resolves the binding exactly as `prepareFollowerBranchProtocol` does — `readRepoIdentityV1` →
  `readStateLineageV1` → `artifactBinding` (`follower-protocol.ts:61-67`) — then `scanBaseArtifacts`
  + `readSettledAbsence` (`:68-71`), and returns **`undefined`** on every shape that makes
  `prepareFollowerBranchProtocol` return `hold`: no capable state nonce, a
  malformed/colliding/unclassifiable artifact, an invalid foreign entry, or any throw. There is no
  partial result.
- `prepareFollowerBranchProtocol` derives `artifacts` from the same helper over the same scan, so
  the two lanes cannot drift: one reader, one binding rule, one failure rule.
- The push planner calls it **once per repository that has a witness candidate** — never on the
  converged path — and passes the same immutable object to the pre-probe, the final proof and the
  tombstone authorship.

**What is left of the A/Z artifacts, exactly.** Nothing on the capture side: v7 mints no artifact to
publish a deletion, which is the entire point of the re-frame. Their existing apply-side jobs are
untouched — a `pull-ref-transaction` writes an A when *this* device prunes under an incoming
tombstone (`branch-transition.ts:109-124`), the settled-absence ledger compacts those A's,
`p-repair` and `journal-recovery` keep reading both, and §3.6 case (c) uses that same blessed path
to retire BASE when the **wire already omits the ref**. Two consequences, stated so their absence is
not read as an oversight:

- **v5's settled-Z witness projection is deleted, not deferred.** It existed so `owed`, A′ and P1b
  could read a `priorOid` out of the Z ledger; v7's consumers read `record.base.refs[R]` instead,
  and the only thing they need from the ledger is `disposition.settledAbsence`, which
  `follower-protocol.ts:105-107` already sets. Round-3 major 1's underlying observation (the Z arm
  populates no witness) is therefore **moot for this design** and remains an unfixed gap that no
  design-200 consumer depends on.
- **A pre-existing owning A over a positive BASE is not v7's shape, and v7 leaves it alone.** It is
  reachable only from a crashed *manual* resolution, where `follow.ts:875-893` writes the artifact
  and the `manual` composer decision retires BASE in a separate CAS (`base-composer.ts:425-440`).
  Today the next apply either reconstructs the retirement, when the incoming section also omits `R`
  (`follow.ts:856-869`), or re-creates the ref and retires the stale artifact inside the creation
  (`branch-transition.ts:136-152`) — losing that deletion and destroying nothing. v6 invented step
  A′ for that shape because v6's own capture path manufactured it on every deletion; v7's path never
  creates it, so the pre-existing manual window is left exactly as it is and recorded as a follow-up
  (§10).

### 3.3 The deletion witness — what licenses an absence capture

The witness fires for a `refs/heads/*` ref `R` only when **all** of the following hold. Any
failure, any exception, any unreadable input leaves `R` exactly as it is today. The rules are
unchanged from v4–v6 except where noted; v7 changes only *where* they are evaluated, which is
stated after the list.

1. `record.base.refs[R] = X` is positive, and `record.branchBaseOrigins[R]` is a
   `usableOrigin` for `X` in the **live** lineage (`base-composer.ts:223-225`;
   `130:214-234`). This is the load-bearing one — see §3.4. *(v3 and v4 added a P4 rider here
   about origins minted from carried values. **P4 is cut** (R5, §4.4), so every origin is
   minted from a value this device captured, which is the pre-existing guarantee
   `base-composer.ts:227-229, 356-367, 418` already provides.)*
2. The live repository has no `R`, read through the **strict** ref reader of §3.3a — never
   `readAllRefs`. This rule was the design's weakest point in v2: the lossy reader turns
   any `show-ref` failure into "no refs at all", which is precisely the input that makes
   every BASE head look deliberately deleted.
3. The protocol artifacts for `R` are clear: no A, no P/K, no settled absence, no active
   foreign artifact. That is exactly a `BranchArtifactDisposition` for `R` with all four fields
   `absent`/`clear` (`follower-protocol.ts:81-115`), read in the push lane through §3.2a's named
   reader. An existing A means some other authority already owns this ref's absence; an existing
   P/K means a crashed transition owns it and `p-repair` must run first.
4. No sibling worktree owns `R` (`branchesCheckedOutElsewhere`) and `R` is not in a
   receiver-equivalent collision group (`receiverEquivalentCollisionNames`).
5. Git is not busy, preflight is `ok`, and the repository identity/lineage binding
   validates (`readRepoIdentityV1` / `readStateLineageV1`, `follower-protocol.ts:61-67`).
   **This rule does *not* catch a restore — see §3.3b.** v2 claimed it did; it does not.
6. **The absence survives a locked expected-absent ref transaction** — §3.2's step L: one prepared
   `verify R 0000…0` transaction plus `reserveNonRacingHead`'s HEAD line, whose second proof runs
   while the transaction holds `<ref>.lock` and re-checks, through the strict reader, that `R` is
   still absent, still unowned, and still not the HEAD symref target
   (`commitPlannedBranchTransition`, `branch-transition.ts:294-321`; its `readAllRefs` call at
   `:309` is one of §3.3a's mandatory conversions). *(v2–v6 obtained this proof as a side effect of
   writing the A artifact. v7 takes the same transaction shape with the artifact lines removed, so
   the proof exists and the durable record of a deletion does not — §13.6.)* **The proof is fresh,
   not standing:** `runPreparedUpdateRefTransaction` releases `<ref>.lock` at `commit`, so nothing
   is locked from there to T, POST or K. §3.6 case (d) states that window, and §3.2c states its one
   destructive shape as an accepted residual with named recovery paths.
7. **`R` is not the current HEAD symref target.** New in v3 — see §3.3b.
8. **No ref-database regression signal is present.** New in v3 — see §3.3b.
9. **The repository's effective capture-side `refScope` is `all`.** New in v6. A scoped section
   cannot express whole-repository ref truth, so `normalizePublishedGitSection` refuses to author
   any tombstone for it (`publisher-tombstones.ts:108` gates the whole loop on
   `refScope === "all"`, and §3.2's witness-backed arm carries the same gate). Publishing an
   omission that can carry no attested deletion would tell every follower to hold forever, so the
   precondition is checked *before* anything is published, not discovered afterwards.

**Where the rules are evaluated, and why the split is safe.** v7 reads the witness in both lanes,
for two different jobs:

| Lane | Rules | Job | If it is wrong |
|---|---|---|---|
| **Push** (§3.2 steps W, L) | **all nine** | authorize the destructive act: omit `R`, author the tombstone at `X`, retire `BASE[R]` at the ACK | fail closed — **step D defers this repository's capture for the cycle** and the last synced section is carried (§3.2b), so the wire keeps asserting exactly what BASE asserts and the ACK is a no-op for it. **Rule 9 is the one exception and it does not defer**: a `scoped` section's omission is inert on every receiver (`follow.ts:609`, `:713`). *(v7 said "carried, or simply not omitted" with no mechanism; v8's step G had a mechanism whose bundle could not cover it; round 7 §13.8.)* |
| **Apply** (§3.6 step 1) | **1–5, 7, 8, 9** — every rule except 6's locked transaction | hold `R` for this cycle instead of throwing §1.2's pre-state error or re-creating the ref | the ref is held one cycle longer than necessary. A hold is non-destructive by construction |

The apply lane deliberately does not take the locked transaction: it is not authorizing anything,
and paying a ref-transaction lock on the read path would put an exclusive Git operation inside the
follow. The two evaluations cannot disagree in a harmful direction — the apply lane's predicate is
*weaker*, so every ref the push may publish is also a ref the apply lane holds, and a ref the apply
lane holds but the push refuses is simply held (the pre-v7 outcome for that repository, minus the
whole-repository defer).

*(v3 had a different ninth rule — "the repository-level circuit breaker has not tripped". **R4
removed it** (§3.0a). All nine that remain are per-ref or per-repository *evidence* rules; there
is no longer any repository-level **count** in the predicate.)*

### 3.3a The strict ref read — absence is only evidence if the read cannot fail silently

This is the single most load-bearing correction in v3, because every other safeguard in
§3.3 is evaluated against the output of one function.

**The defect.** `readAllRefs` (`src/engine/git/refs.ts:6-15`) is:

```ts
const out = await git(repoDir, ["show-ref"]).catch(() => "");
```

Any failure of `git show-ref` — for any reason — yields an **empty ref map**, which is
byte-for-byte what a repository with no refs yields. Absence capture reads that map and
concludes that every positive BASE head was deliberately deleted.

**Verified empirically** (Git 2.54.0), because the exact failure mode matters:

| Repository state | `git show-ref` | stderr | `git rev-parse HEAD` | `git status` |
|---|---|---|---|---|
| healthy, 3 refs | exit 0, 3 lines | empty | exit 0 | exit 0 |
| **one malformed loose ref** (`.git/refs/heads/b1` = `not-a-sha`) | **exit 128**, `fatal: git show-ref: bad ref refs/heads/b1 (0000…)` | non-empty | **exit 0** | **exit 0** |
| freshly `git init`, no commits | exit 1, no output | **empty** | exit 128 | exit 0 |

So: a single corrupt loose ref makes `show-ref` fail hard while the preflight, HEAD read
and working-tree check all still succeed — exactly the codex blocker, reproduced. And the
`.catch` is not gratuitous: exit 1 with empty output is Git's documented "no matching
refs", which a legitimately ref-less repository produces.

**The strict reader.** Add, beside `readAllRefs` and without changing it:

```ts
export type StrictRefRead =
  | { status: "ok"; refs: Record<string, string> }
  | { status: "unreadable"; marker: string };

export async function readAllRefsStrict(repoDir: string): Promise<StrictRefRead>;
```

- `gitStatus(repoDir, ["show-ref"])` (below) returns `ok` → parse exactly as `readAllRefs`
  does.
- returns `failed` with **`exit === 1`** **and `stderr.trim() === ""`** → `{ status: "ok",
  refs: {} }`. Both conditions, because exit 1 *with* stderr is not the documented no-match
  case. *(v5's prose said `code === 1` here while the exact predicate below correctly said
  `exit`; `GitRunResult` has no `code`. Corrected in v6 — round-4 minor 2.)*
- **anything else** → `{ status: "unreadable", marker }`, with `marker` derived from the exit
  code (or the literal `"nonnumeric"`), never from the message text.

**The plumbing this needs, because it does not exist yet — new in v4.** v3 claimed "the
codebase already contains this exact pattern" and cited
`readLocalGitConfigEntries` (`src/engine/git/shared.ts:261-268`). That claim is wrong in the load-bearing
half: `readLocalGitConfigEntries` inspects only `(error as {code?}).code === 1` and never
looks at stderr, so it is a precedent for the *exit-code* discipline and for nothing else.
And `gitRaw` has **two execution paths with different failure shapes**:

| Path | Taken when | Failure shape |
|---|---|---|
| Node `spawn` (`src/engine/git/shared.ts:146-231`) | `opts.stdin` or `opts.onStdoutChunk` is set | `reject(Object.assign(new Error(stderr ⏐⏐ \`git exited with status N\`), { code: exitCode }))` (`shared.ts:177`) — stderr is **folded into the message**, and an empty stderr is replaced by fallback text |
| `promisify(execFile)` (`src/engine/git/shared.ts:232-239`, `exec` bound at `:71`) | otherwise — including every `show-ref` read | Node's `execFile` rejection, which *does* carry `.stdout`/`.stderr`/`.code`, but whose `.code` is a **string** for spawn faults (`"ENOENT"`) and `undefined` when the child was signalled |

So "check `code === 1` and empty stderr" is implementable on one path by message
archaeology and on the other by a Node-specific property, and neither is a contract.

**The contract, pinned in v5 — round-3 M1.** v4 proposed `gitStatus` but left the contract
self-contradictory, and codex was right to refuse it: v4's doc comment said *"spawn/IO faults
still reject"* while its prose mapped exec-path `ENOENT`, `maxBuffer` and signals to a
structured failure with `code: null`. Both cannot hold. Worse, once the result retains only
`number | null`, `gitRaw` **cannot** reproduce today's thrown shape, because today's shapes are
not uniform — verified, all four of them:

| Path | Failure | Today's thrown shape |
|---|---|---|
| spawn | non-zero exit | `Object.assign(new Error(stderr ⏐⏐ \`git exited with status N\`), { code })`, where `code` is the close-handler's `number \| null` (`shared.ts:177`, set at `:219`) |
| spawn | `maxBuffer` overflow | `new Error("git stdout exceeded maxBuffer")` / `"git stderr exceeded maxBuffer"` — **no `code` property at all** (`shared.ts:195`, `:214`, rejected at `:175`) |
| spawn | never ran / IO fault | the raw Node error, rejected verbatim, so `code` is a **string** like `"ENOENT"` (`shared.ts:217`) |
| `exec` | anything | Node's `execFile` rejection: `.code` is a number for a completed non-zero exit, a **string** for `ENOENT` and for `maxBuffer` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`), and null/absent for a signalled child, with `.signal` set (`shared.ts:232-239`, `exec` bound at `:71`) |

**So the answer is not to re-compose the error — it is to carry it.** Stated once, and it is
the only statement: **nothing rejects. Every failure is data, and the data retains the exact
error `gitRaw` would have thrown.**

```ts
export type GitRunResult =
  | { status: "ok"; stdout: string }
  | { status: "failed"; exit: number | null; stdout: string; stderr: string; cause: unknown };

/** Every outcome is data; this never rejects.
 *  `exit` is the numeric exit status IFF the child ran to completion, and `null`
 *  otherwise — never spawned, signalled, or aborted for maxBuffer. `stdout`/`stderr`
 *  are the bytes buffered so far and are NOT evidence when `exit === null`.
 *  `cause` is the exact error `gitRaw` throws for this outcome. */
export async function gitStatus(root: string, args: string[], opts?: GitRunOptions): Promise<GitRunResult>;
```

- **`exit` is a single, total question: did the child run to completion?** A number means yes,
  with that status. `null` means every other failure — signalled (the spawn path's
  `close(code)` already delivers `null` there, `shared.ts:218-221`), never spawned (`ENOENT`),
  or aborted for `maxBuffer`. The exec path normalizes with
  `typeof code === "number" && Number.isInteger(code) ? code : null`, which maps its string
  codes to `null` by the same rule rather than by a separate one.
- **`gitRaw` becomes a two-line wrapper and is byte-identical by construction, not by
  reconstruction:** `const r = await gitStatus(...); if (r.status === "ok") return r.stdout;
  throw r.cause;`. Because `cause` is the very object the current code rejects with, no
  existing catch site can observe a change — including sites that read a *string* `code`, which
  is the case v4's normalized result could not have preserved. The spawn path composes its
  `Error(stderr || fallback)` exactly where it does today (`shared.ts:177`) and stores it as
  `cause` instead of rejecting with it; the other three shapes are captured verbatim.
- **The spawn path needs no new buffering** — it already accumulates stdout and stderr
  separately (`shared.ts:179-215`), so the structured result is a strict simplification of
  `finish()`.
- **`readLocalGitConfigEntries` moves onto `gitStatus`** in the same change (`r.exit === 1`
  instead of `(error as {code?}).code === 1`, `shared.ts:261-268`).
- **It is not the only `code === 1` consumer, and the second one deliberately stays put — new in
  v6 (round-4 minor 2).** `parseConfigSnapshot` has the identical idiom at
  `config-txn.ts:211-213`, but it runs Git through an **injected** `GitConfigRunner`
  (`runGit: GitConfigRunner = gitRaw`) whose contract is the throwing one, and whose test doubles
  throw. Moving it would change that seam's contract for no gain: because `cause` is carried
  verbatim, `throw r.cause` keeps that site byte-identical. So the claim is narrowed — v6 does not
  say the second idiom is eliminated, only that the *strict-read* rule has exactly one idiom.
- **"Never rejects" has to mean the whole function, including its `finally` — new in v6 (round-4
  minor 2).** The four failure shapes above are the *child's*; the spawn path can also throw
  before or beside the child, and every one of these is verified: the
  `gitSpawnObserver?.(root, args)` call at `shared.ts:145`; `fs.mkdtemp` / `fs.writeFile` /
  `fs.open` for the stdin temp (`:148-153`); an `onStdoutChunk` callback that throws, on either
  `data` (`:184-189`) or the decoder's `end` (`:200-206`); a non-`EPIPE` stdin error (`:223`);
  and `stdinFile.close()` / `fs.rm` in the `finally` (`:228-230`). `gitStatus` therefore wraps
  the **entire** legacy operation — its `try`, its `finally`, and the observer call — and maps any
  such throw to `{ status: "failed", exit: null, stdout: "", stderr: "", cause: error }`, which
  `gitRaw` re-throws unchanged. §9.6 adds a cleanup-failure row and a callback-throw row to the
  table-driven test for exactly this reason.

Exact semantics of the reader, stated once so the implementation has no latitude:

```
r = await gitStatus(repoDir, ["show-ref"])
r.status === "ok"                                   → { ok, refs: parse(r.stdout) }
r.exit === 1 && r.stderr.trim() === ""              → { ok, refs: {} }
otherwise                                           → { unreadable, marker }
   where marker = r.exit === null ? "no-exit" : `exit-${r.exit}`
```

**Why this is fail-closed by construction and not by a remembered rule.** The empty-map arm
requires `exit === 1`, and `exit` is a number *only* when the child ran to completion. Every
fault that could be mistaken for "no refs" — a `git` that never launched, a killed child, a
truncated read — carries `exit === null` and therefore cannot reach that arm. The marker is
derived from `exit` alone and never from message text, so no path text can leak into a
deferral line (§5.1).

*(One consequence worth naming: `stdout`/`stderr` on an `exit === null` result are partial
buffers, and the contract says so. No predicate in this design reads them in that state.)*

**`git for-each-ref` is not the answer, and the reason is worth recording.** It looks
stricter — it exits 0 on the corrupt repository above — but that is the problem: it
**silently omits the broken ref**, emitting only `warning: ignoring broken ref
refs/heads/b1` on stderr. A reader that drops refs and reports success is strictly worse
for a fail-closed absence proof than one that fails loudly.

**Where the strict reader is mandatory.** Not a blanket conversion of all ~25 `readAllRefs`
call sites — that is a separate sweep — but every site where an empty map is read as
authority over deletion:

| Site | Why |
|---|---|
| §3.3 rule 2, plan-time absence read | the witness itself |
| `branch-transition.ts:309` (inside `commitPlannedBranchTransition`) | the locked second proof. For an absent-target transition `plan.beforeOid` is `null`, so `(refs[plan.ref] ?? null) !== plan.beforeOid` compares `null !== null` and **passes on a totally failed read**. The one check that is supposed to prove "R is still absent under the locks" is exactly the check the lossy read defeats. This is a pre-existing hole for *every* branch transition, not only P1's. |
| `follow.ts:990` (locked second proof in the publish loop) | same shape |
| `apply.ts:1903` (pre-state-save terminal revalidation) | **New in v5.** For an absent witness `terminal` is `null`, so `(live[ref] ?? null) !== terminal` compares `null !== null` and **passes on a totally failed read** (`apply.ts:1906-1909`) — the same defeat as `branch-transition.ts:309`, at the last checkpoint before the state CAS. **v6 needed this site because A′'s BASE proof passed through it; v7 sends no proof of its own there, so the row is now a fix for the *pre-existing* absent-witness hole on the `pull-ref-transaction`/`journal-recovery` paths — including §3.6 case (c)'s retirement, which travels one of them.** It stays mandatory: it is the same defect, it is one line, and case (c) is a deletion path. |
| `capture.ts:259`, `capture.ts:357` | a lossy read here produces a section advertising **zero refs**, and `normalizePublishedGitSection` then authors a wire tombstone for every advertised head (`publisher-tombstones.ts:108-122`). A single `show-ref` failure on the publishing device becomes a fleet-wide deletion of the whole repository. This design's deletion semantic rests on capture omission being meaningful, so it must also make capture omission trustworthy. |

`follow.ts:882`, `:917` and `:1548` are deliberately **not** on the list: an empty read
there over-pins and over-holds, which fails in the safe direction. Say so explicitly so a
later reader does not assume the omission was an oversight.

**Fail-closed behavior.** `{ status: "unreadable" }` at any of these sites aborts absence
capture for the whole repository for that cycle, records an `apply` deferral under a new
dedicated reason (`ref-read-unreadable` — it needs a `DEFERRAL_REASON_PRESENTATION` entry
and a `GIT_DEFERRAL_REASON_PRECEDENCE` rank, §9.6), and emits one bounded line. It never
degrades to "assume no refs". *(v3 shared the circuit breaker's reason here; R4 removed the
breaker, so this reason now stands alone — it is the only new deferral reason in the
design.)*

### 3.3b Absence is not evidence of *why* — restore and unborn-branch detection

v2's §3.3 rule 5 claimed that identity and lineage binding catch "a `.git` that was
restored, replaced or rebound". **It does not, and the design must stop saying it does.**

`repositoryIdentityHash` hashes `relPath`, `kind`, `worktreeId`, `gitDirReal`,
`commonDirReal`, and the commonDir's `dev`/`ino`/`birthtime`
(`repo-lineage.ts:69-76`, read by `readRepoIdentityV1`, `:82-95`). Restoring `.git/refs`
and `.git/packed-refs` **in place** — a `tar -x` over the ref database, a
`rsync` from a backup, a botched `git gc` recovery — changes none of those. The commonDir
inode is untouched, so identity is stable, lineage is current, the artifacts are clear,
preflight passes, and every origin remains usable. §3.4's invariant ("this device held
that ref at that OID") is still *true* — and irrelevant, because it proves historical
possession, not that the current absence is a deletion.

Two additions, plus one honest limit.

**(i) Reject the current symref target.** `reserveNonRacingHead` (`branch-transition.ts:72-91`)
returns `lines: []` with `reservation.currentRef = true` when `HEAD` is `ref: R` and `R` is
the transition's own ref — i.e. HEAD is permitted to point at the ref being retired. And
`branchProofMatches` (`base-composer.ts:246-260`) checks `liveOid`, `artifactsClear`,
`ownershipStable` and `reflogStable`, but **never inspects `locked.currentRef`**, even
though `commitPlannedBranchTransition` records it (`branch-transition.ts:318-322`).

A repository whose HEAD symref names `R` while `R` is absent is an **unborn branch**, not a
deletion: `git checkout -b feature` before the first commit, a fresh clone of an empty
repository, and a restore that lost `refs/` while keeping `HEAD` all produce it. Rule 7 is
therefore: the deletion witness refuses any `R` that is the current HEAD symref target, checked
at plan time **and** re-checked inside §3.2 step L's verify-only transaction, whose
`reserveNonRacingHead` line (`branch-transition.ts:72-91`) makes a racing `checkout -b R` fail the
transaction and whose `headReservation.currentRef` must be `false`.

Scoped deliberately to this design's own paths rather than fixing `branchProofMatches`
globally: that predicate is shared by every branch transition and tightening it is a
behaviour change for paths this design has not analysed. **The general gap is recorded in
§10 as a follow-up, not silently closed.**

**(ii) Ref-database regression signals.** All fail-closed, all cheap, none of them a proof:

- **packed-refs identity.** Record `{dev, ino, size, mtimeMs}` for
  `<commonDir>/packed-refs` in the repo record beside `branchBaseOrigins`. Refuse absence
  capture when a previously-recorded tuple exists and the current one has a *different
  inode* or an *older mtime* while BASE-positive heads are absent. An ordinary
  `git pack-refs` advances mtime and keeps the file; an in-place restore replaces it.
- **Reflog-store corroboration.** Refuse when `<commonDir>/logs/HEAD` is missing or empty
  while BASE recorded at least one head. A repository that lost `refs/` almost always lost
  `logs/` with it, and a repository that has ever had a branch has a HEAD reflog.

**(iii) The honest limit — rewritten in v4, because R4 changed what these signals are for.**
Neither signal is a proof, and a sufficiently careful in-place restore defeats both. v2 and
v3 both answered that by pointing one layer down: "the *actual* protection against restore is
the circuit breaker; mass simultaneous absence with the repository otherwise intact *is* the
restore signature." **That layer no longer exists** (§3.0a, R4), and the honest statement is
therefore different in kind:

- These signals are **detection-correctness hardening**, not a guarantee. They exist because
  a cheap, fail-closed signal that catches the *careless* restore — the `tar -x` that
  replaces `packed-refs` and drops `logs/`, which is what an actual botched recovery looks
  like — is worth having on its own merits. They are not a substitute for a breaker and must
  never be described as one.
- The residual is **accepted with a bounded consequence, not closed.** A restore careful
  enough to preserve the `packed-refs` inode, advance its mtime, and retain a non-empty
  `logs/HEAD` will pass every rule in §3.3 and publish every missing head as a deletion,
  at any repository size, with no count at which rbox stops. That is R4's accepted residual,
  and §3.0a states what it costs and what recovers from it.
- **Do not re-propose a threshold here.** The founder's ruling is that there is always a gap;
  a reviewer who finds an uncovered restore shape has found an instance of an accepted
  residual, not a new blocker. What *would* be a new blocker is an uncovered shape in which
  rbox publishes a deletion for a ref whose absence it never observed under the strict read,
  or for which no current-lineage origin proves prior possession — i.e. a break in §3.3 or
  §3.4, not in the size of the blast radius.

### 3.4 Why this cannot lose work *that rbox promised to keep*

The argument rests on one property of the existing system, worth writing down because the
whole design leans on it:

> **A positive `refs/heads/*` member of BASE with a usable current-lineage
> `branchBaseOrigin` is proof that *this device* physically held that ref at that OID at
> the moment BASE was composed.**

It holds for each origin kind:

- `pull-p` (`base-composer.ts:227-229`) is minted only from a `present` witness produced
  by a committed ref transaction whose locked proof asserted `locked.liveOid === after`
  (`branchProofMatches`, `:257`);
- `publisher-ack` (`:364-367`) is minted only when the acked wire value equals the
  advertised value this device captured from its own P (`:358`), and `130:214-234`
  restates it: "an accepted push ACK may write `publisher-ack` only for a value this
  device actually captured and committed";
- `manual` (`:418`) is minted under a fresh confirmed snapshot and a locked live-OID proof
  (`:409-413`).

Therefore **BASE-positive + P-absent + no A/Z + valid lineage ⇒ this device held `R` at `X`
and no longer does.** It cannot mean "never delivered here": a ref that never arrived was
never in this device's BASE with a usable origin. That is the discriminator, and it is
checkable locally with no new provenance and no new wire field. **v7 leans on it twice**: it is
what licenses the tombstone at `X` (§3.2's authorship reads `record.base.refs[R]`, not
`advertised`), and it is what P1b binds supersession to now that there is no receipt to bind to.

**One thing v2 asserted here that is not true, and is now handled elsewhere.**

- **The invariant proves historical possession, not the cause of the current absence.**
  "Held it, doesn't now" is compatible with deletion *and* with a restored ref database
  (§3.3b) *and* with an unborn-branch HEAD (§3.3b (i)). §3.3's rules 7 and 8 narrow it
  further; nothing narrows it completely, and §3.0a is where that residual is accounted for.
  This section no longer claims to.

*(v3 and v4 carried a second bullet here: the invariant is not self-maintaining under P4,
because `publisher-ack` mints an origin whenever the acked value equals the *advertised*
value (`base-composer.ts:356-367`) and the advertised set is the whole committed section
(`push.ts:971`, `advertisedRefs: section.refs`), so a merged `pending ⊕ local` section would
mint origins for values this device never held. **P4 is cut** (R5, §4.4): every advertised
section is captured from local refs, so the invariant is self-maintaining again. The
observation is preserved in §4.4 as a constraint on design 201, because it is the reason a
per-ref wire model needs per-ref origins.)*

From there, publishing the deletion cannot lose work **that rbox promised to keep** — the
qualifier is R4's (§3.0a) and it is load-bearing, because v3's version of this list ended
with a bullet about a 90-day pin that no longer exists:

- The branch was published (`publisher-ack`, `sourceSeq:468`), so its objects reached the
  server and the fleet. This is not a device-local history that exists only here.
- Followers are not obliged to obey. Deletion arrives as a design-130 tombstone, and each
  receiver still runs `tipOwnedByIncoming` / `noDropProof` / `checkTombstoneAttestation`
  before pruning (`follow.ts:739-787`, `:941-999`). Concretely: if W2 advanced `R` from
  `X` to `Y` while W1 deleted it, W1's tombstone chain authorizes `X` only, W2's live
  value is `Y`, the attestation fails, and W2 **holds** — "tombstones authorize exact
  history only". W2's work survives, and its next push re-advertises `R = Y`, which W1
  applies as an ordinary creation (`beforeOid = null`, `logicalBaseOid = null` once the ACK has
  retired the member — the guard passes).
- The local side is already lost: Git deleted the ref *and* its reflog before rbox ever
  ran. rbox is mirroring an accomplished fact, not performing a deletion.
- **rbox never destroys a reachable object here.** The publication retires a BASE member; it
  deletes no ref that exists (the ref is already gone), writes no artifact, and touches no object. The follower prune it
  authorizes still pins the displaced OIDs on the pruning device, unchanged from design 116
  (`prepareTombstonePrunePins`, `keep-pins.ts:635-654`). What a *wrong* capture costs is
  branch pointers across the fleet — priced, sourced and accepted in §3.0a.
- **The file plane is the durability contract, and it is untouched by any of this.** No file
  content is deleted, no version history is affected, and `rbox restore <file>@<seq>` keeps
  working across the whole plan window regardless of what happens to a ref.
- The alternative (resurrection) is strictly worse and re-opens
  `REVIEW-174-R1-OPUS-B.md:14`.

### 3.5 ~~The circuit breaker~~ — REMOVED 2026-07-24 by R4

v2 and v3 specified a repository-level mass-absence breaker; R1 fixed its arithmetic and Q2b
gated its fraction leg. **All of it is out of scope as of R4 (§3.0a): there are no thresholds** —
*"some math is just not gonna prevent it; there's always a gap."* §3.3's rules are all per-ref
evidence, and a capture that satisfies them all and is still wrong is accounted for in §3.0a rather
than mitigated. The full decision record, including both withdrawn rulings, is §12 Q2/Q2b. Three
facts kept so nobody re-derives them:

- **The arithmetic.** `n >= max(K, ceil(F*N))` is a *conjunction* dominated by its larger leg, so
  with `K = 25`, `F = 0.25` the absolute leg dominates every repository under 100 heads — a 24-head
  repository losing all 24 did not trip. A two-legged ref-count guard wants `OR`, and must not copy
  design 108's `AND` (`pushMassDeleteTrips`, `policy.ts:22-35`) without re-checking scale.
- **The distribution that killed the fraction leg.** 110 repositories, ~203 BASE heads, **median
  1**, 84% at four or fewer. Any fraction of `N` is a hair-trigger there.
- **The file plane keeps its guards, and that is not a contradiction.** Design 44's pull-side guard
  (`policy.ts:11-15`, `pull.ts:276`) and design 108's push-side breaker (`policy.ts:22-35`,
  `push.ts:701`) are unchanged: they guard the plane rbox *promises*, at a scale where a fraction leg
  means something. R4 is exactly the ruling that the Git lane is not that plane. The **posture** 108
  taught survives without a breaker — refuse on the publishing side, before any
  encrypt/upload/commit work, and fail closed — which is what every §3.3 rule does.

### 3.6 Ordering: publish the omission, let BASE follow the ACK

This is the section five adversarial rounds were fought in, and v7's version is short because the
ordering now does the work the machinery used to do.

**Why the old order needed all that machinery.** The ACK dry-run
`pendingSupersessionAckConverges` (`pending-supersession.ts:35-62`) requires the composed BASE to
deep-equal the candidate, and `base-composer.ts:525-527` re-adds every omitted ref, so under v2–v6's
rules a candidate that merely *omits* `R` could never converge while BASE still held `R`. That is
why the retirement had to come **first** — and once it did, every cycle between the retirement and
the acknowledged omission was a cycle in which BASE said "gone" while the wire said `X`. Managing
that cycle is the whole content of A′, A″, the `owed` predicate, `record.absenceOmission` and its
reconciliation table. §3.2's `absentBranchProofs` removes the premise: the dry run and the real ACK
compose the same retirement from the same proof, so the omission converges **without** BASE having
moved beforehand, and the window never opens.

**What runs where, in one cycle.** `sync()` is pull-then-push — `sync.ts:9-19`, *"One full cycle:
take remote changes, then publish local ones"*.

1. **Pull / apply — the per-ref hold.** For every `refs/heads/*` ref with `record.base.refs[R]`
   positive, `R` absent under this cycle's strict read, and §3.3's rules 1–5, 7, 8 and 9 satisfied,
   the follow **holds** `R`: one entry in the classification pass at `follow.ts:728-767`
   (`classifiedHolds.set(R, "deletion-pending")`), which the main loop consumes at
   `follow.ts:838-846` *before* any transition is planned. Nothing else changes. The hold is per-ref;
   it is not the incoming-HEAD whole-repository escalation (`follow.ts:708-711`); every other ref of
   the section applies normally; and the ordinary `held.length > 0` path retains the **whole**
   incoming section as `pending[rel] = remoteSec` with the per-ref split recorded separately in
   `partial.appliedRefs` / `partial.heldRefs` (`apply.ts:1426`, `:1448`). **The reason is its own —
   `deletion-pending`, new in v8 (round-6 major 1); the *persisted* `heldRefs` value stays
   `local-commits` so no state schema changes.** §5.1 has the copy, the precedence argument and the
   complete consumer inventory that must learn it — **fifteen** sites plus five tests (round-7 major 3
   plus round-8 major 3; the count is corrected everywhere in v11 for round-9 minor 2).
2. **Push / plan — the publication.** Step W re-derives the witness from BASE and the live refs and
   nothing else, step L takes the locked absence proof, the capture omits `R`, step T authors the tombstone
   at `X` for the proven ones, and P1b lets the omitting candidate supersede the retained pending
   section when — and only when — `pending.refs[R] === X` under a passing proof. **If any
   locally-absent BASE-positive head lacks a proof, step D defers this repository's capture for the
   cycle instead** (§3.2b).
3. **ACK — the retirement.** `BASE[R]` retires in the state CAS that records the accepted section
   (§3.2 step K). The hold's own precondition (`record.base.refs[R]` positive) is now false, so the
   hold is released by the same save that published the deletion. There is nothing to reconcile and
   nothing owed.

**Two things the hold is deliberately not.**

- **It is not a claim about the wire.** It says only *"our durable state and the incoming section
  disagree about this ref, and our own publication has not resolved it yet"*. It never concludes
  that the wire is asserting `X` **because of us**, which is the inference round 4 killed and the
  reason no ABA is expressible here (row 5 below).
- **It is not v6's step C.** There is no early `result: "reconciled"` return and no suppressed
  follow, so the incoming section is retained by the ordinary path — which is precisely what round
  5's blocker 2 required and what v6's early return could not give it. Round 5's blocker 1
  (reconcile-before-apply ordering) has no subject at all: there is no reconciliation lane to order.

**Why the hold does not gag its own publication.** A hold sets `pending[rel] = remoteSec`, which is
what normally makes a repository carry instead of capture (`plan.ts:776-790`). For this shape the
pending section's `R` is exactly `X` — it is BASE's own value, being echoed by the wire — so P1b's
new row supersedes it in the *same* cycle and the capture proceeds. The hold and the publication are
therefore not in conflict: the hold protects the ref from the apply lane while the push lane
publishes the fact that resolves it. Where the pending value is **not** `X`, P1b carries by design,
and that is case (b).

**Where the latent wedge is reached, and why v7 needs no reconciliation above the unchanged
shortcut.** §2.3's shape — a stale positive BASE member with no pending and an unchanged remote —
never reaches the apply lane at all, because `applyGitRepos` returns `{ result: "unchanged" }` at
`apply.ts:873-879`. v6 answered by moving absence reconciliation above that shortcut, which is where
its ordering problems began. v7 does not need to: **deletion is a push-lane event, and the push lane
runs every cycle regardless of the apply shortcut.** The one gate v7 adds there is on the *plan*
side: the trusted-fingerprint carry — gate at `plan.ts:837`, carry decision at `:844`, `out[rel] =
baseSec` at `:848` — must not skip a repository that has a positive
BASE head absent from the live refs. That is an O(1) predicate over `record.base.refs` against the
probe's own identity refs — no new subprocess, evaluated only on repositories whose fingerprint hit
— and it is the entire cost of covering the latent wedge (§6).

**The four incoming shapes, worked through.** `X = record.base.refs[R]`; `R` is absent locally.

**(a) The incoming section asserts `R = X`** — the ordinary case, and the §1.2 field wedge. Today
this reaches `planBranchTransition({ beforeOid: null, afterOid: X, logicalBaseOid: X })`, throws at
`branch-transition.ts:105`, is caught at `follow.ts:1021-1027` and defers the whole repository.
Under v7 the ref is held before the planner sees it, the same cycle publishes the omission, and the
ACK retires BASE. Nothing is re-created. `X` may be a stale echo of this device's own last
publication or a peer's genuine assertion of a ref it still holds — **v7 does not need to know
which**, and that is the point of the re-frame: it publishes its own truth and lets the server's
ordering decide the result. A peer that still holds `R = X` prunes it on attestation, because live
`X`, logical BASE `X` and the tombstone at `X` all agree (`tombstone-attestation.ts:91-110`), which
is the correct outcome under §3.0. A peer that has advanced past `X` holds instead, which is §3.4.

**(b) The incoming section asserts `R = Y ≠ X`** — deleted here, advanced there. P1b **carries**:
the binding refuses to retire a value this device never held (round-2 blocker 1). So the deletion is
not published, the ref stays held, and the repository keeps carrying its pending section while it
holds. **v7 calls this what it is: a two-sided divergence** — this device deleted the ref, another
writer advanced it, and both facts are real. §10 has reserved two-sided divergence for design 173
since v1. v6 resolved it unilaterally in the peer's favour (retire BASE, let `Y` apply as an
ordinary creation, publish nothing), which is only expressible with the early retirement v7 removes.
What v7 gives instead:

- the hold is **per-ref and cheap**, not the whole-repository defer this shape produces today
  (`follow.ts:1025`), and it is held-skip eligible like any other human-divergence hold (§5.1);
- it **clears automatically the moment either side moves**: the peer deleting `R` too reaches case
  (c); the user re-creating `R` reaches case (d); a peer advancing `Y` further changes nothing but
  costs nothing;
- the **human exit is `rbox git resolve <repo> keep-mine`** — and **v8 respecifies it against how
  keep-mine actually works, because v7 named an unreachable path** (round-6 major 2). See below;
- the **residual is the one §4.2 already accepts** for a divergent worktree hold, in the same class
  and for the same reason: a repository with an unreconcilable ref keeps carrying its section until
  that ref reconciles, and closing *that* needs per-ref publishing — design 201.

**Case (b)'s exit, respecified against the binary — v9, round-7 major 4.** This section has now been
written twice against a lifecycle that does not exist, so v9 states the ground truth first and every
claim below is verified against HEAD rather than against a design.

- **v7** put the exit on `planManualBranchTransition` / the `manual` composer arm. Unreachable:
  `keep-mine` takes its own early branch and returns (`resolve-command.ts:755-770`), and the manual
  branch protocol is initialized only for `take-theirs` (`resolve-command.ts:604-617`).
- **v8** corrected the authority to `publisher-ack` — which `176:93-99` does rule, and which is
  right — but then specified the *execution* as design 176's token-bound persisted intent "executed
  by the next ordinary push". **Design 177 deleted that.** `177:1` is titled *"keep-mine executes at
  confirm time (kill the intent gap)"*; `177:31-47` names the intent gap as the field defect;
  `177:164-173` lists the deletion, including *"the persisted `resolutionIntent` record field and
  its entire lifecycle"*. 177's status line is `IMPLEMENTED — shipped in PR #390 (merged
  2026-07-21)` (`177:3`).
- **Verified in code, not inferred.** `GitResolutionIntent` does not exist anywhere in `src/`.
  `RepoRecord.resolutionIntent` does not exist; the only two remaining mentions are by-name strips —
  `stripObsoleteResolutionIntents` (`sync-state-model.ts:353-367`, sole caller
  `sync-state-store.ts:89`) and the defensive projection strip at `sync-state-model.ts:397-401`. The
  planner keys exclusively off `options.resolution`; there is no record read.
- **A rider replaces it.** `GitResolutionRider` — *"Ephemeral authority carried only by the
  foreground confirmed push"* — is `{ repo, verb: "keep-mine", confirmedReport, authorizedLanes,
  forceDiscardIncoming }` (`resolution-intent.ts:44-51`), an in-memory object literal built at
  `resolve-command.ts:755` and handed to `pushManifest(..., { resolution })` at
  `resolve-command.ts:769-770`. It rides `PushManifestOptions.resolution` (`push.ts:227`) →
  `PushAttemptState.resolution` (`push.ts:410`, surviving 422/409/epoch resets) →
  `GitPlanOptions.resolution` (`plan.ts:109`).
- **One lock scope, no gap.** Everything runs inside the `withWorkspaceSyncMutex` opened at
  `resolve-command.ts:540` and closed at `:1003`, with 177's waiting acquisition at
  `resolve-command.ts:529-539` (60 s default, *"waiting for the current sync cycle to finish…"*), and
  the confirm-boundary re-derivation at `resolve-command.ts:709-750` (reload state, re-`repoCtx`,
  re-`takeSnapshot`, re-check the token, `isGitBusy`, `hasInProgressOpState`,
  `branchesCheckedOutElsewhere`, fresh preliminary report whose discard decision must still match).
- **There is no automatic retry.** A pre-ACK failure persists **no** resolution state — the rider is
  a stack value. `plan.ts:740-748` keeps `P` authoritative on a recovery refusal and
  `revertCapture(rel, p, reason)` restores the exact pending section on the two post-capture proof
  failures (`plan.ts:995-1010`). A throw unwinds to `resolve-command.ts:1004-1017`. **The user
  re-runs the command** (177 acknowledges this regression at `177:237-248`). A daemon push carries no
  rider, so no later cycle can execute the resolution.
- **Also worth recording so the next reader is not misled: design 176 was never amended.**
  `176:42` still says *"The intent is executed only by the next ordinary push"* and 176 §2 still
  describes the intent sidecar. 177's status line is the authority. Design 200's one 176-side
  amendment (below) is therefore an amendment to a section whose *execution model* is already dead;
  it changes only the refusal sentence.

**The exit, exactly, as it composes with the code above:**

1. `rbox git resolve <repo> keep-mine` **stops refusing** this shape at
   `resolve-command.ts:657-666`. The refusal's predicate — *"any `refs/heads/*` in `incoming.refs`
   that BASE holds and the local repository lacks"* — becomes *"…that **design 200's witness does not
   license**"*: the refusal is lifted for exactly those absent heads where §3.3's rules 1–5 and 7–9
   hold (whatever the incoming value, `X` or `Y`), and it is retained verbatim for every other absent
   head — no usable current-lineage origin, artifacts not clear, sibling-owned, the current HEAD
   symref target, a ref-database regression signal, or a `scoped` section. A repository with any
   retained refusal still refuses as a whole, so the verb never publishes a section carrying one
   licensed and one unlicensed absence. Where the refusal lifts, its message is replaced by the
   ordinary preview.
2. **The confirmed report's branch lane for `R` is `not-subsumed`, and this needs no 176 or 177
   amendment.** `reportCore`'s branch arm is
   `candidateOid === undefined ? "not-subsumed" : await equalOrDescendant(...)`
   (`resolution-intent.ts:219`) — never `indeterminate`, so it does not hit the indeterminate refusal
   — and the lane carries `incomingOids: [pendingOid]` (`:220`), so `discardedIncomingOids`
   (`:348-352`) still enumerates `Y`.
3. **Confirmation requires `--force-discard-incoming`, and the requirement is exact rather than
   permissive.** `forceRequired` is `lanes.some(lane => lane.disposition === "not-subsumed")`
   (`resolution-intent.ts:245`), and the CLI enforces `forceDiscardIncoming === forceRequired` in
   both directions (`resolve-command.ts:693-703`, re-asserted at `:745-748`). **That is correct
   here**: in case (b) the omission really does discard another writer's `Y`, which is exactly the
   decision the flag exists to make explicit.
4. **The same in-process push executes it — synchronously, under the lock already held.** The rider
   forces a wholly local capture for that repository: `plan.ts:758-777` selects the resolution arm
   with `{ resolution: true, forceCapture: true }`, which bypasses P1b entirely — that is *why*
   keep-mine can publish case (b) while an ordinary push carries it. **Design 200's steps W, L, T and
   D must run on that capture, and v9 states plainly that this is new work rather than an existing
   path**: the resolution push today is the ordinary pipeline (capture → `finalResolutionReport` →
   `reportAuthorized` → `pinDisplaced` → commit → publisher-ACK, `plan.ts:990-1028`), and W/L/T/D do
   not exist in the binary at all. Two consequences follow and both are load-bearing:
   - the published section omits `R` and carries the tombstone at **`record.base.refs[R]` = `X`,
     never at `Y`**. The normalizer cannot author at `Y`: its advertised-diff loop reads
     `advertised.refs` (`publisher-tombstones.ts:109-111`) and its `pendingRetention` input
     contributes only existing *chains*, never new entries from pending's refs (`:80-88`);
   - **if step L refuses on that capture, step D defers and the command fails cleanly.** The
     repository carries, `pending` is intact, nothing is persisted, and the user re-runs — which is
     177's own contract for every pre-ACK failure, not a new failure mode. The defer and the
     synchronous verb compose because the verb's whole premise is that L can be taken *now*, under
     the workspace lock, with the world quiesced.
5. **Only the accepted ACK retires BASE.** The publisher-ACK authority is minted after the accepted
   commit from `committed.gitRepos[relPath]` (`push.ts:963-980`), and design 200 adds
   `absentBranchProofs[R] = { priorOid: X }` to it with its six checks — all of which pass:
   `previousRefs[R] === X`, the candidate omits `R`, `refScope === "all"`, and the accepted section
   carries the tombstone at `X`. Every failure before that ACK leaves `pending` intact
   (`plan.ts:995-1010`, `:1055`), which is 176 item 3's substance preserved under 177's execution.
   The one durable pre-ACK write is 177's own publication receipt (`push.ts:785-820`), whose sole job
   is lost-ACK reconciliation (`pull.ts:174-200`) — **and design 200 adds nothing to that save**, because
   §3.2c's attempt record is withdrawn.

**Preservation is not weakened by any of this**: the discarded `Y` is pinned when it is still
reachable locally — `discardedIncomingOids(report)` filtered by `cat-file -e`, pinned under
`ref: keep-mine:<rel>`, `class: "human"` (`plan.ts:1011-1022`).

**The one 176-side amendment, stated precisely so it can be applied there:** `176`'s item 4 sentence
*"At intent time it refuses … a pending branch absent locally that BASE holds present … It does not
clear either shape"* becomes *"At intent time it refuses the reserved-173 non-FF-divergent remote. A
pending branch absent locally that BASE holds present is cleared under design 200's deletion witness
and the publisher-ACK arm's `absentBranchProofs`; every other locally-absent shape still refuses."*
Nothing else in 176 changes — not the token, not the report, not the lane list, not the clearing
order, and not item 5's "no locked-proof claim" (the locked proof belongs to design 200's step L on
the *push* side, which is where 176 already says the concurrency boundary is). **The amendment is to
176's refusal sentence only; 176's execution model is already superseded by 177 and design 200 must
not restate it** — that is what round-7 major 4 caught, twice.

**(c) The incoming section omits `R`** — converged: a peer deleted it too, or this device's own
omission landed and its ACK CAS did not. `oldOid === newOid === undefined`, so the equality path at
`follow.ts:848-896` runs. Today it retires BASE only when a durable A already exists
(`reconstructedAbsence?.priorOid === baseOid && disposition?.absence === "valid-owning"`, `:856-858`)
and otherwise falls to `heldRefs[ref] = "local-commits"` at `:894-895` — which is §2.3's latent
wedge. v7 adds one arm: **when §3.3's witness holds and the artifacts are clear, plan the ordinary
absent transition** — the shape already at `:875-893`, gated on the witness instead of on
`opts.manualResolution` — and retire BASE under the **existing** `pull-ref-transaction` authority
with the A artifact that transaction writes (`branch-transition.ts:224` supplies the
`verify R 0000…0` physical line, since there is no live ref to delete). That is design 130's blessed
present→absent path, unchanged, and it opens **no** window: the wire already omits `R`, so the
artifact is *behind* the wire rather than ahead of it. This arm is also the recovery for a lost ACK
CAS and for a peer's deletion that beat ours, and it is why v7 needs no `owed` predicate anywhere.

**(d) `R` is present again** — the user re-created it, at `X` or anything else. The witness fails at
rule 2, so there is no hold, no locked proof, no tombstone and no retirement: the ordinary transition
applies, and if a stale artifact exists it is retired inside that transition
(`branch-transition.ts:136-152`), exactly as design 130 already specifies. The only interesting
instant is a re-creation **between step L's `commit` and the ACK** — and v8 states that window
accurately, because round 6 showed v7 described it wrongly.

**The window is real and unlocked, and that is accepted.** `runPreparedUpdateRefTransaction` holds
`<ref>.lock` for the duration of the transaction and releases it at `commit`
(`commitPlannedBranchTransition`, `branch-transition.ts:294-321`); T, POST and K all run afterwards.
So a local `git branch <R> <X>` in that interval is possible, and no lock prevents it. **Accepted as
a one-cycle window**, for the same reason §12 Q4 rejected a settling window: Git deletion is atomic,
the proof was true when it was taken, and a window cannot observe anything the second locked proof
does not — it only defers the same outcome. What the window costs, split by whether the ACK landed:

- **The ACK landed** (BASE retired). Non-destructive and convergent, but v7's stated reason was
  wrong. The tombstone claims `X` was deleted, which it was; BASE records what this device published.
  The next follow sees local `R` present while the incoming section omits it, so the ref is held —
  and **the attestation refusal for a re-creation at exactly `X` comes from the retired logical BASE,
  not from a differing live value**: `checkTombstoneAttestation` requires
  `facts.liveOid === facts.oid && facts.logicalBaseOid === facts.oid`
  (`tombstone-attestation.ts:107-109`), and after the retirement `logicalBaseOid` is `null`. (For a
  re-creation at `X' ≠ X` both conjuncts fail; v7's sentence was true only for that sub-case.) The
  pending section is carried, supersession succeeds because that pending section has **no** `R` entry,
  and the next capture publishes the re-creation. Converged in one further cycle.
- **The ACK was lost** (BASE still `X`). Then live `X`, logical BASE `X` and the tombstone at `X` all
  agree and attestation **authorizes** the prune of a legitimate re-creation. That is round-6
  blocker 2, it needs no peer, and after four rounds of failed defences it is **an accepted residual
  rather than a closed race** — §3.2c states it, cites every conjunct, verifies its three recovery
  paths (the tombstone-prune keep-pin fires in the same `git update-ref` transaction as the delete) and
  proves it does not latch, because the prune's own apply pass retires `BASE[R]` and the next pull
  retires it anyway if that save is lost. A re-creation at any value
  other than `X` is unaffected: both attestation conjuncts fail and the ref is held.

**The crash table — six rows, every row re-derived from durable state.** `K` marks where the process
dies. **v8 added one field to that durable state and v11 removes it again (§3.2c), so the table is
back to v7's six rows over v7's durable state** — BASE, `pending`, the wire and nothing else. That is
why it still replaces v6's eleven rows and its reconciliation table.

| # | Crash / failure point | Durable state after | What the next cycle does | Outcome |
|---|---|---|---|---|
| 1 | **K anywhere before the POST** — witness, locked proof, capture, encrypt, upload | nothing new: L writes no ref, no artifact, no state | W and L re-derive from BASE and the live refs; the ref is still held | Idempotent by construction, any number of times. |
| 2 | **The POST fails** — offline, quota, 422, rejected | nothing new | identical to row 1: the ref stays held, the omission is re-captured and re-published | The common failure. The deletion is not lost and the ref is not re-created. |
| 3 | **K after the server accepted the omission, before the state CAS** | BASE still positive; the wire's head omits `R`; nothing new is persisted anywhere | `R` absent locally: case (c)'s arm retires BASE from the head that omits `R`. If the head has since moved on, the next capture re-publishes an identical omission and its ACK retires it. `R` **present** locally at a value other than `X`: attestation hard-vetoes on both conjuncts (`tombstone-attestation.ts:102-111`) and the ref is held. `R` **present** locally at exactly `X` (re-created in the L-to-ACK window): **this is §3.2c's accepted residual** — the ref is pruned once, the delete's own `git update-ref` transaction pins the OID, and the apply pass's state save retires BASE (retried on the next pull if lost), so nothing latches | Converges in every sub-case except the same-OID re-creation, which loses that one branch pointer once and is recoverable from the pin (§3.2c). **v7 said this row needed no local record; round 6 showed the present-locally sub-case is destructive; v8–v10 spent a persisted field on it and rounds 6–9 falsified every version — v11 states it instead.** |
| 4 | **K after the ACK state CAS** | BASE retired, `advertised` omits `R` | nothing asserts `R`, nothing is owed | Converged. |
| 5 | **A peer asserts `R = X` after the omission was acknowledged** | BASE retired ⇒ no witness ⇒ no hold | the ordinary `null → X` creation applies | The deletion is lost and the branch comes back — C1's ruled direction (§13.4 item 6). **No omission is ever re-published after its own retirement**, which is why round 4's same-OID ABA is not expressible. |
| 6 | **A peer asserts `R = X` while the omission is genuinely unpublished** | BASE positive; nothing else | case (a): held, and the same cycle publishes the omission; the peer then prunes on attestation | Bounded by one cycle. Our deletion is causally first here — nobody has seen a deletion of `R` yet. Unchanged from v7 in every revision. |

**Row 3 is where the last race lives, and v11 states it rather than defending it.** v7 stated it as
row 3 plus row 6: a crash between acceptance and the state CAS *and* a peer that prunes, re-creates at
the identical `X` and publishes before this device's next pull. Round 6 showed the conjunction is
weaker than that — **no peer is needed**, because a purely local `git branch <R> <X>` in the unlocked
L-to-K window (§3.2 step L) reaches the same state, and `checkTombstoneAttestation` then authorizes the
prune for the plain reason that a lost ACK is exactly the state in which logical BASE was *not* retired
(`tombstone-attestation.ts:109-111`). v8 TOOK §12 C3 and answered with a persisted withholding field;
rounds 6, 7, 8 and 9 then put twelve blockers inside that field's lifecycle and no round left it
correct. **So §12 C3 is WITHDRAWN (2026-07-25) and §3.2c is the residual statement**: the loss is one
branch pointer per occurrence, pinned by the `git update-ref` transaction that takes it, with BASE
retired by the same apply pass so nothing latches. §13.4 item 8 records the reversal and what remains.

**What if the remote wins the race and re-delivers `R = X` first?** Then the branch is legitimately
re-created and that is correct: another device is still advertising it as present, and v7 has
published nothing that says otherwise. The loop terminates rather than ping-ponging, because a
deletion is only ever published from a *fresh* witness — never re-asserted from memory of a past
one. *(Nothing in this design rests on cross-writer tombstone-generation ordering, which is just as
well: `refTombstoneGeneration` is a `Math.max` over `advertised`/`pending`/`candidate`
(`publisher-tombstones.ts:73`), so a publisher with a stale `advertised` regresses it — §13.4
item 9.)*

### 3.7 ~~The deleting device's recovery pin~~ — REMOVED 2026-07-24 by R4

v2 argued no local pin was needed because a *follower* pins the displaced OIDs when it prunes
(`follow.ts:947-949` → `prepareTombstonePrunePins`, `keep-pins.ts:635-654`). Codex showed that
premise is structurally unreliable — the prune *is* what creates the pin, so nothing is pinned
anywhere in four ordinary cases (§7.1) — and **R3** put a 90-day `tombstone`-class pin on the
deleting device instead. **R4 supersedes R3: there is no pin** (§3.0a), and codex's round-2 majors on
the pin's persisted shape and its expiry cadence are **mooted rather than answered** (§13.2, M3/M4).
What that changes elsewhere:

- **The deletion writes no artifact and no pin at all in v7** — not a single-artifact transaction, as
  v3–v6 had, but a verify-only proof (§3.2 step L). One fewer crash point than v6 and no
  `extraTransactionLines`, no `cat-file -e` probe, no ordering rule.
- **No `KeepPinOrigin` change — and that avoided a downgrade hazard, not just some code.**
  `parseKeepPinOrigins` rejects any record whose key set is not exactly
  `["class","episode","ref","time"]` and any `class` outside `"human" | "tombstone" | "tracking"`
  (`keep-pins.ts:88-104`), so a newer client's extended sidecar would fail every
  `readKeepPinOrigins`/`prepareKeepPins` call on an older one.
- **The follower prune path is untouched**, and `expireTombstoneKeepPins` still has no production
  caller — those pins are still retained indefinitely, exactly as they ship today.
- **`createScratchPins` is a different mechanism and is unaffected** (`capture.ts:282`); those refs
  live in the `refs/rbox-*` namespace the bundle excludes and are torn down with the capture.

## 4. Mode (a): should a spent worktree block at all?

Three layers were on the table. The recommendation is: **layer (ii) is the real fix, layer
(iii) is wrong, and layer (i) is worth doing but for a different reason than it looks.**

### 4.1 Containment — should out-of-workspace worktrees be ignored? No.

Tempting, since `~/.codex/worktrees/*` is never synced. But the hazard
`branchesCheckedOutElsewhere` defends against is *physical, not topological*:
`git update-ref refs/heads/x` from one worktree silently moves a branch a sibling has
checked out and leaves that sibling inconsistent — `git branch -f` refuses, `update-ref`
does not (`apply.ts:106-111`, design 43 §7 [v4], design 68 V13). That is equally true
whether the sibling lives in the workspace or in `/tmp`. Filtering by containment would
make rbox corrupt working trees it cannot see, and would break the invariant "sibling
worktree branches never move" (`INVARIANTS.md:187-193`, since 68).

Containment has exactly one legitimate use here: **reporting**. rbox should name the
worktree's location so a human or agent can act in seconds (§5).

### 4.2 A per-ref hold must not defer the repository or gag its capture lane

This is the fix. Design 116 phase-0 already decided that ordinary sibling-owned refs are
per-ref holds; `apply.ts:1447-1450` then throws that away by promoting *any* held ref to a
repository-wide `pending` + deferral.

**Proposal P2.**

- **Held-skip eligibility.** Add `worktree-ownership` to the allowlist at
  `held-skip.ts:37-41`. This requires widening the skip bracket: the current fingerprint
  covers refs/HEAD/index, and *removing* a worktree changes none of them, so a skip could
  outlive its cause — the same class of defect the 176 v6 amendment fixed for
  classification identity (`176:190-226`). Add a **worktree-registry digest** — a hash of
  the `path`/`branch`/`prunable` triples from `listWorktrees` — to `GitHeldAttempt`
  (`sync-state-model.ts:228-245`) and require it to match. Cost: one
  `git worktree list --porcelain` per repository per cycle, which the follow already
  spawns five times (`follow.ts:673, 916, 991, 1471, 1549`).
- **No whole-repo escalation for a non-HEAD ref.** `follow.ts:708-711` (incoming HEAD
  owned) must stay a whole-repo defer — rbox cannot attach the primary checkout to a
  branch a sibling holds. Everything else stays per-ref.

**P2's machinery is also what carries v7's deletion window (§3.6 step 1), and that is not a
coincidence.** A locally-deleted BASE-positive head is exactly a ref whose local truth and incoming
truth disagree while some other lane resolves it — the same shape as a sibling-held branch, and it
wants the same treatment: hold this one ref, do not defer the repository, do not plan a transition,
and re-decide next cycle from durable state. v7's addition is one entry in the same classification
pass (`follow.ts:728-767`) keeping the existing persisted `heldRefs` value `local-commits`, with a
**new reported reason, `deletion-pending`** (§5.1, §9.6). **v8 corrects the "for free" claim v7 made
here (round-6 major 1):** held-skip eligibility is *not* inherited by a new reason —
`heldBlockersAllowSkip` allowlists the three literals `local-commits | local-stash | local-index`
(`held-skip.ts:37-40`) and `blockersAfterComposer`'s causal mapping pairs the literal
`local-commits` with `missing-branch-proof` (`held-skip.ts:57-62`), so both must learn the new reason
or the deletion hold silently loses held-skip and starts emitting an unmatched composer blocker.
§5.2's inventory lists every site (round-7 major 3 completed it). The persisted-value half of the claim does hold: `heldRefs` keeps
`local-commits`, so no state schema changes.

**Two claims v2 made here are false, and correcting them changes what P2 is for.**

- **"Distinguish held refs the incoming section wants to change from held refs that are
  already convergent" is a no-op for ownership holds.** The publish loop's very first
  statement is `if (oldOid === newOid) continue;` (`follow.ts:732`), *before*
  `if (!hold && owned.has(ref))` (`follow.ts:734`). A convergent ref is skipped before
  ownership is ever consulted, so **every** ordinary sibling-worktree hold is by
  construction a ref the incoming section wants to change. There is no second category to
  filter out. (The exceptions are the pre-seeded holds — `ambiguousRefs` at
  `follow.ts:730` and `forcedHeldRefs` at `:731` — which do bypass the equality skip; they
  are not the worktree case this bullet was written for.)
- **"Capture is not gagged by a hold alone" is wrong, and P1b does not fix it in general.** The
  held ref's own pending value is, by the point above, different from its live value. Both
  `pendingSupersessionPreProbe` (`pending-supersession.ts:103-105`) and
  `provePendingSupersession` (`:198-203`) evaluate **every** pending ref, and for heads the
  test is `equalOrFastForward(repoDir, pendingOid, candidateOid)` — literally
  `gitCommitAncestry(pending, candidate) !== "not-ancestor"` (`pending-supersession.ts:179-181`),
  i.e. the *remote's* value must be an ancestor of the local one. A worktree-held ref the
  remote advanced fails that, and P1b adds only an **absent + witness at the exact BASE value**
  row, which does not apply to a ref that is present and divergent. So supersession still refuses
  and `apply.ts:1447-1450` still sets `pending[rel] = remoteSec`. *(The one place P1b's row does
  clear the gag is v7's own deletion hold, where the pending value **is** BASE's value — §3.6.)*

**What P2 therefore actually delivers:** the ~9 s per-cycle follow disappears (held-skip),
and a non-HEAD ownership hold stops deferring the whole repository. **It does not unfreeze
the capture lane for a divergent hold.**

**What happens instead, now that P4 is cut — stated plainly, because this is the design's
honest answer to wedge (a) (R5, §4.4).** Three facts, and they are all that is claimed:

1. **While a worktree holds a *divergent* branch, the repository keeps its carried pending
   section.** The held ref's own pending value differs from its live value by construction
   (the equality skip at `follow.ts:732` precedes the ownership test at `:734`), and both
   `pendingSupersessionPreProbe` (`pending-supersession.ts:103-105`) and
   `provePendingSupersession` (`:198-203`) evaluate **every** pending ref, so supersession
   refuses and `apply.ts:1447-1450` still sets `pending[rel] = remoteSec`. That is a real
   residual and it is **accepted for the worktree's lifetime**: holding a ref for as long as
   a live worktree holds it is the founder's ruled semantic, not a defect.
2. **Propagation of unrelated work still happens, via design 174 supersession, wherever the
   unrelated transition is a fast-forward** — which is the ordinary case, because unrelated
   local work advances its own branch. `equalOrFastForward` is
   `gitCommitAncestry(pending, candidate) !== "not-ancestor"`
   (`pending-supersession.ts:179-181`), so a fast-forward on every *other* pending ref lets
   the whole section supersede even while the divergent ref is held. The rig scenario
   `worktree-squash-lifecycle` demonstrates exactly this: its phase-1 assertion that an
   unrelated commit on `main` reaches the peer past a live hold **passes on merit today**
   (§9.6). The carried section is bookkeeping in that window, not a gag on the refs that
   matter.
3. **Everything clears once the worktree goes *and the branch is deleted*, through P1 + P1b.**
   Removing a worktree changes no ref (§9.1), so that alone clears the *hold* and nothing else;
   when the branch is deleted too, the witness holds, the same cycle's push publishes the omission
   and its tombstone, the pending section supersedes, and the ACK retires the BASE member (§3.6).
   That is the gate this design ships.

**One more member of the same residual class, added by v7 and not by P4's absence.** A ref this
device deleted while another writer advanced it (§3.6 case (b)) is held, and its repository keeps
carrying, until either side moves or a human runs `keep-mine`. It sits here rather than in a
separate residual because it has the same cause (an unreconcilable ref forces a whole-section
carry), the same bound (it clears when the ref clears), and the same honest fix (per-ref
publishing — design 201).

What is *not* fixed is the case where a divergent hold coexists with a **non**-fast-forward
change on another ref of the same repository; that repository's Git plane waits for the hold.
Closing it needs a per-ref wire model — **design 201**, parked (§4.4, §10).

### 4.3 Content-equivalence: cascade reduction for squash-merged branches (P3)

Even with P2, a worktree-held branch that is squash-merged is still classified as
receiver-only work by every proof that touches it, because merged-ness is ancestry-only
(§2.1). That is what makes an abandoned worktree feel permanent rather than merely untidy,
and it is where the founder's validated recipe belongs.

**P3 is cascade reduction, not a merged-ness proof.** v3 renames what it claims, because
codex found both a false positive and a boundary that was prose rather than mechanism. Read
the rest of this section with that framing: P3's job is to stop a squash-merged branch from
forcing holds onto *unrelated* refs through the `noDropProof` fixpoint. It is not evidence
about deletion and it is structurally barred from influencing one.

**Proposal P3.** Extend `noDropProof` (`reachability.ts:208-238`). Today a protected tip
`T` that is not an ancestor of any durable root `D` returns `{status:"would-drop"}`
immediately. Before returning, run a bounded content-equivalence probe for each `D`:

```
base  = git merge-base D T
# patch-id of the whole base..T range, as one synthetic change:
pid   = git diff-tree -p --no-commit-id base T | git patch-id --verbatim
# patch-ids of everything D gained since the fork point:
match = git log -p --format=%H --no-merges base..D | git patch-id --verbatim | grep pid
```

If any `D` matches, return `{status: "proven", marker: "content-equivalent"}`.

**`--verbatim`, not `--stable`.** `git patch-id --stable` ignores all whitespace within the
patch, so a branch that differs from its supposed squash only in indentation matches.
`--verbatim` preserves whitespace and, per Git's own documentation, "implies `--stable`" —
so it is strictly stronger with no ordering cost. It was added in Git 2.39; rbox already
requires Git ≥ 2.46 (`checkGitCapability`, `doctor-cmd.ts:372-386`), so it is always
available. This closes half of codex's objection outright.

This is the founder's recipe with two deliberate changes:

- **No `origin/main`.** rbox has no upstream concept; `D` is drawn from the no-drop
  proof's existing durable roots (planned refs ∪ held refs ∪ recovery pins). "The work is
  preserved because its content is already in something that will survive this apply" is
  the right formulation for rbox's model, and it generalizes to repositories with no
  remote, a differently-named default branch, or several.
- **No `git commit-tree`.** The recipe's synthetic commit writes a loose object into the
  user's repository on every probe. `diff-tree -p base T | patch-id --stable` computes the
  identical patch-id with no side effect.

**Bounds and fail-closed discipline.**

- Skip the probe (returning `would-drop`, i.e. today's answer) when
  `git rev-list --count base..D` exceeds a cap — proposed 5,000. An ancient fork point
  against a busy `main` is exactly where the walk is expensive and the answer is almost
  certainly "no".
- Any non-zero exit, unparsable output, shallow store or missing object returns
  `would-drop`. **Never `indeterminate`** — per `FIX-PLAN-174-QUALITY.md:8`, an
  indeterminate proof must emit only the `indeterminate` typed blocker, and this probe
  must never be able to manufacture one. It may only *improve* an already-negative answer.
- All Git invocations use the existing `graphEnv` (`GIT_NO_LAZY_FETCH=1`,
  `GIT_NO_REPLACE_OBJECTS=1`, `reachability.ts:32`) — `REVIEW-174-R2-CODEX.md:17` requires
  ancestry over the literal object graph, and the same requirement applies to patch-ids.
- Cache on `(T, D)`. Both are immutable OIDs, so the answer is a pure function of the key
  and never needs invalidation. Persist alongside `divergence-cache.ts`'s store, bounded
  LRU.

**The remaining false positive, stated rather than hidden.** Searching `base..D` for `T`'s
range patch-id matches an **apply-then-revert**: if `D` once contained the branch's work
and later reverted it, the historical commit is still in `git log base..D` even though
`D`'s tree no longer has the work. The probe answers "did this diff ever appear on the way
to `D`", not "is this diff present in `D`". Fixing that properly means an exact
result-state proof — comparing `T`'s tree against `D`'s tree restricted to the paths the
range touches, and reasoning about intervening edits — which is a different and much larger
design. **v3 does not attempt it.** It is acceptable to leave because of the boundary
below, and it is listed as a required negative test in §9.1.

**The boundary, made structural.** v2 wrote "content equivalence may waive a hold; it may
never authorize a deletion" and left it as a sentence. It is not self-enforcing, and codex
was right that the sentence is false as written:

- `noDropProof` returning `proven` is precisely how a ref **avoids** being held
  (`follow.ts:815`, `if (proof.status === "proven") continue;`); and
- a `refs/heads/*` ref that is not held and whose incoming target is absent flows into
  `planBranchTransition` with `afterOid: null` (`follow.ts:975-987`), which builds the A
  artifact and a `delete` line (`branch-transition.ts:109-124`) — with **no** attestation
  check, because the attestation check at `follow.ts:993-999` is gated on
  `tombstoneAuthorized.has(ref)`.

So "not holding" *is* the authorization. Two mechanisms, both required:

1. **A `content-equivalent` waiver may not clear a hold on a destructive transition.** In
   the fixpoint at `follow.ts:806-816`, when `proof.marker === "content-equivalent"`, keep
   the hold if the ref's planned transition is destructive — `newOid === undefined`
   (incoming omits it), or `oldOid` is not an ancestor of `newOid`. Only fast-forward and
   convergent transitions may take the waiver.
2. **A structural test**, in the spirit of `base-composer-structure.test.ts`: the set of
   refs whose hold was waived by `content-equivalent` and the set of refs reaching
   `planBranchTransition` with `afterOid === null` are disjoint, asserted over the real
   publish loop rather than by inspection.

**How much reach P3 actually has, verified.** Less than v2 implied, and the honest number
matters for §11's sequencing argument. The *ordinary* squash-merge deletion is already
caught one stage earlier, by the first-pass `tipOwnedByIncoming` loop at
`follow.ts:744-765`, which P3 does not touch: a squash-merged tip is an ancestor of nothing
in `roots`, returns `unowned`, and is held as `local-commits` before `noDropProof` ever
runs. The only thing that lifts that first-pass hold today is tombstone attestation
(`follow.ts:768-786`). So P3's realistic effect is confined to the **second-pass fixpoint**,
where a squash-merged tip that survived the first pass would otherwise cascade holds onto
unrelated refs — which is exactly the "cascade reduction" framing, and exactly the win §1.1
measured (4 of 10 worktree branches stop forcing holds). Describing it as "teaching rbox
about squash merges" oversold it.

### 4.4 ~~The per-ref pending lane: `pending ⊕ local`~~ (P4) — CUT 2026-07-24 by R5

**RULED 2026-07-24 (R5): P4 is out of scope for design 200**, reversing the same day's Q5 ruling
(§12 Q5) **on new evidence**: three shapes failed three adversarial rounds, each on a *different*
closed invariant, and the rig showed the propagation win P4 was justified by already works today.
The parked follow-up is **[design 201](./201-per-ref-git-publishing.md)** — a per-ref wire model,
likely 2.0-era alongside design 163's SQLite state plane.

**What P4 was.** While a repository had any held ref, the outgoing section stopped being the carried
incoming section and became a merge: the carried `pending` value verbatim for each held ref, the live
local value for every ref rbox may publish. Today `apply.ts:1447-1450` sets `pending[rel] = remoteSec`
for the whole repository and `normalizeOutgoingGitSections` republishes it by identity
(`publisher-tombstones.ts:183-186`), so one held ref freezes every other ref's published value for as
long as the hold lasts.

**The three shapes, and the closed invariant each collided with** (full mechanisms in
`REVIEW-200-R2/R3-CODEX.md`, kept beside this file):

| Shape | Killed by | Why, in one line |
|---|---|---|
| **Hybrid BASE** — v3's `partially-superseded`: captured refs advance, carried refs keep their prior BASE value | round 2 (B4) | `incrementalCapturePlan` derives the next capture's negative basis from BASE (`src/cli/sync-git/shared.ts:137-139`) so an advanced-refs/stale-bundle BASE excludes objects the chain does not contain (unimportable sections); **and** `pendingSupersessionAckConverges` requires `isDeepStrictEqual(composed.base, candidate)` (`pending-supersession.ts:61`), which no carrying section can satisfy |
| **BASE follows the published section** — settle BASE to the emitted section, carried values included, with per-ref carrier origins | v4, self-rejected | A positive BASE member at a carried value `Y` this device never held makes `logicalBaseRefs` (`follower-protocol.ts:80`) name a physical state that never existed here, so `branch-transition.ts:105` refuses the moment the hold clears — the §1.2 wedge, re-armed. *(v7's ACK-side retirement is **not** this shape: it records only values this device captured, and only absences it proved — §3.2, invariant 1.)* |
| **Mutual exclusivity** — a repository whose emitted section carries any ref is never settled | round 3 (B1) | The bar that keeps carried values out of BASE keeps *captured* ones out too, so on the next pull the equality path takes `heldRefs[D] = "local-commits"` (`follow.ts:895`, *"equality cannot invent branch P/A authority"*): each captured ref publishes past the hold exactly **once**, then freezes |

**The round-3 blocker list that killed the last shape**, recorded so 201 starts from it rather than
re-deriving it:

1. **B1 — self-echo re-gags every captured branch after one emit.** Above. It needs per-ref
   authority, which is the thing 201 exists to design.
2. **B3 — the refs-only splice is not *operationally* v1.6.8-compatible.** `M` moves pending's
   current bundle into a historical chain link while copying pending's index/op-state, and both
   v1.6.8 and current `importGitPackChain` **skip** a historical link whose commit tips are already
   present (`v1.6.8:src/engine/git/shared.ts:493-506`; current `shared.ts:529-540`). A receiver can
   hold every pending commit tip while lacking a staged-only blob, then skip the only bundle
   containing it.
3. **B4 — `M` excludes BASE prerequisites its chain does not carry.** `gitSectionTips(pending) ∪
   gitSectionTips(base)` becomes `^tip` exclusions (`capture.ts:296-304`) while `M.packChain` holds
   only pending's chain, so a BASE-only tip can be excluded without appearing anywhere in `M`. Every
   negative basis tip must be *proved* covered by the emitted chain.
4. **B5 — repeated self-echo exhausts `MAX_PACK_CHAIN`.** Each emit adds a link, so from length 0 the
   emits at 1–7 are valid and the next trips `pending.packChain.length + 2 > 8`
   (`manifest-validate.ts:19`), falling back to whole-section carry forever.
5. **B6 — a receipted pending HEAD can make `M` invalid.** §3.3 rule 7 rejects the **local current**
   symref target, not the branch named by `pending.head`; omitting a ref that `pending.head` names
   produces exactly the shape `validateGitSection` rejects (`manifest-validate.ts:380-392`). **Any
   future model that omits refs from a section must separately check that section's own `head`.**

Two round-3 majors belong to the same shape: **M5**, that persisted `record.advertisedCarried` had no
proved clearing point; and **M4**, that the carried/captured partition was not total (§13.3 — moot
with the cut, and why).

**The landmine 201 must carry forward: `gitCommitAncestry(Y, Y)` succeeds.** For a carried ref the
candidate value *equals* the pending value, so `equalOrFastForward(pending[R], candidate[R])` is
`gitCommitAncestry(Y, Y)` → `"equal"` → **proven**. Any per-ref publishing model must bar the carried
partition *explicitly*: without that bar, a section carrying a relayed value declares the pending
superseded without this device ever applying it, clears `pending[rel]`, advances BASE wholesale and
mints `publisher-ack` origins for values this device never held — every hazard the design worried
about, reached through the **success** path. It fails closed today only by luck: if the carried object
is absent locally the `rev-parse --verify` throws (`git-ancestry.ts:13-16`) and
`provePendingSupersession`'s outer `catch { return false }` (`pending-supersession.ts:215-217`)
swallows it. **Depending on not having an object is not a safety argument.**

**What the cut costs, stated exactly.** What P4 uniquely bought was publishing past a **divergent**
held ref *without* carrying the pending section as bookkeeping. Two things bound that loss: the
unrelated-change propagation P4 was justified by **already works** — the rig scenario
`scripts/rig/scenarios/worktree-squash-lifecycle.ts` (merged as `ad0b3408`, #446) asserts it and
**passes on merit today** through design 174's supersession, because the unrelated ref's transition is
a fast-forward — and the residual is bounded by the worktree's lifetime, consistent with the founder's
ruled semantic. §4.2 and §5 state the surviving behaviour, and §10 records it as a non-goal again.
**v7 adds one member to the same residual class and inherits the same fix**: a ref deleted here while
a peer advanced it (§3.6 case (b)) waits with its repository's section, because one ref cannot wait
alone until publishing is per-ref.

### 4.5 Recommendation

Ship P2 and P3 together with P1 (§11). P4 is **cut** (§4.4, R5), so this is the whole design.
On the founder's Mac the P1–P3 result is:

- the abandoned `~/.codex` worktrees hold their own branches and nothing else;
- the repository is not *deferred*, and the follow is skipped on subsequent cycles until the
  worktree registry actually changes;
- the four squash-merged branches stop cascading holds onto unrelated refs through the
  `noDropProof` fixpoint;
- the phantom ref is held for exactly one cycle instead of throwing, that cycle's push omits it
  with a tombstone at `2c866687…`, the ACK retires the BASE member, and the wedge clears itself
  (§3.6).

**Corrected in v3, and still true in v7: a *divergent* hold keeps the section carried after
P1–P3.** v2 claimed P2 ungagged it. It does not (§4.2): a worktree hold is by construction on
a ref the incoming section wants to change, so `provePendingSupersession`'s
equal-or-fast-forward test refuses for *that ref* and `apply.ts:1447-1450` still sets
`pending[rel] = remoteSec`. So the honest statement is:

- **P1 + P1b clear both observed field wedges** — mode (b) directly, and mode (a) once the
  worktree is actually removed. That is the gate, and it is what the rig asserts (§9.6).
- **Unrelated work still propagates while the hold lives**, wherever its transition is a
  fast-forward, through design 174's supersession (§4.2 point 2) — verified by the rig's
  phase-1 propagation assertion, which passes on merit today.
- **The §1.5 causal chain is broken at its *consequence*, not at its cause.** A hold still
  keeps the pending section carried, so an agent leaving a worktree behind can still
  manufacture phantom refs — but each one is now published as an ordinary omission at deletion
  time and the wedge no longer accumulates into a state with no exit. Breaking the chain at its
  cause needs per-ref publishing, which is **design 201** (§4.4, R5).

## 5. The self-healing contract

**Becomes automatic — no human, no `rbox git resolve`:**

| Situation | New behavior |
|---|---|
| Published branch deleted locally (`git branch -D`, `git branch -d`, agent cleanup — **not** `git worktree remove`, which changes no ref) | The ref is held for that cycle under `deletion-pending` instead of throwing; the same cycle's capture omits it, proves the absence under `<ref>.lock`, and publishes a tombstone at the exact retired value; the ACK retires the BASE member and releases the hold. One bounded log line. **No local artifact, no pin, no recovery listing, and nothing that retires BASE ahead of the wire** — §3.6, R4 §3.0a, invariant 11. |
| `pending` carried on a ref the local repository no longer has, at the value BASE holds | Supersedes in the same cycle the witness holds (§3.2 P1b). |
| Abandoned worktree holding a branch | Per-ref hold only; the repository is no longer *deferred* and the follow is held-skipped until the worktree registry changes. **A divergent hold still keeps the pending section carried** for the worktree's lifetime, and that is accepted (§4.2, R5). |
| Unrelated local work while a worktree hold is outstanding | **Propagates already, where the unrelated transition is a fast-forward** — design 174's supersession, verified by the rig's phase-1 assertion (§4.2 point 2, §9.6). A non-fast-forward change on another ref of the same repository waits for the hold; closing that needs **design 201** (§4.4). |
| Squash-merged branch cascading holds onto unrelated refs | Cascade broken by content equivalence. It does **not** lift the first-pass ownership hold on the merged branch itself (§4.3). |
| Stale positive BASE member left by a *past* deletion (the latent wedge, §2.3) | Published by the push lane, which runs whether or not the apply lane takes its unchanged shortcut; the trusted-fingerprint carry is gated on the same O(1) predicate so the repository is not skipped (§3.6). |
| The omission's push fails (offline, quota, rejected) or the process dies before it | The next cycle re-derives the witness and retries. The ref stays held meanwhile and is never re-created (§3.6 rows 1–2). Nothing durable was written, so there is nothing to reconcile. |
| The omission is accepted but the ACK state CAS is lost to a crash | The next pull sees a head that omits the ref and retires BASE through design 130's ordinary `pull-ref-transaction` absent path (§3.6 case (c), row 3). |
| **The branch is re-created locally between the locked proof and a lost ACK** | At any value other than the tombstoned one, attestation hard-vetoes and the ref is held (`tombstone-attestation.ts:102-111`). At **exactly** the tombstoned value it is pruned **once** — §3.2c's accepted residual — and the delete's own transaction pins the OID at `refs/rbox-local/keep/<oid>` while the apply pass's state save retires BASE, so the next re-creation is captured normally. **This is the shape round 6 found; v8–v10 defended it with a persisted field and rounds 6–9 falsified every version (§12 C3 WITHDRAWN).** |
| A peer legitimately re-creates the branch after the omission landed | Applied as an ordinary creation. rbox never re-publishes an omission after its own retirement, so a causally newer assertion is never contradicted (§3.6 row 5). |
| **A deletion this device could not prove** — L refused (lock contention, HEAD moved), or a witness rule other than rule 9 refused | **The repository's capture defers for that cycle and its last synced section is carried**, so the wire keeps asserting exactly what BASE asserts and no follower learns of a deletion rbox could not prove. Retried next cycle; the other 23 deletions in that repository wait with it, which is the honest cost (§3.2b step D). A `scoped` repository (rule 9) does not defer — its omission is inert on every receiver. |
| `RBOX_GIT_ABSENCE_CAPTURE=0` | **Not self-healing, by design.** The switch disables the whole push-side lane including step D, so the capture omits the head and the pre-existing advertised-diff author publishes an unproven deletion tombstone — i.e. **exactly the pre-200 binary, bug included**. That is what the kill switch is for; a switch whose off-state defers repositories is a worse 2am tool (§3.2b, §11). |

**Still needs a human, and should say so loudly.** v3 led this table with the circuit
breaker; **R4 removed it** (§3.0a), so mass absence no longer stops for anyone — the row is
gone rather than reworded, and §3.0a is where that consequence is accounted for. v7 adds one row,
and it is a row v6 hid by deciding the case unilaterally.

| Situation | Why | What rbox should say |
|---|---|---|
| A ref read fails in a way that could be mistaken for "no refs" (§3.3a) | An absence proof derived from a failed read is a fleet-wide deletion waiting for one corrupt loose ref. | Defer the repository under `ref-read-unreadable`; name the repository and the exit code, never the message text. |
| **A locally-absent BASE-positive head whose witness refusal is *standing*** — no usable current-lineage origin (rule 1), a stale owning A (rule 3), a sibling worktree whose HEAD names it (rule 4), it is this repository's HEAD symref target (rule 7), or a ref-database regression signal that does not clear such as reflogs disabled (rule 8) | rbox cannot prove the absence and must not publish it, and step D's carried section cannot be replaced until it can (§3.2b, §13.4 item 10). The file plane is unaffected. | Report the repository under `deletion-pending` and name the cause. The exits that exist today are clearing the cause, `git branch <R> <X>` from a value the fleet still holds, or `rbox git resolve <repo> take-theirs`. **`keep-mine` is deliberately not an exit for this class** — §3.6 case (b) lifts its refusal only where the witness licenses the absence. Widening it to publish a human-authorized unprovable deletion is a recorded follow-up (§10). |
| **A branch is deleted here and advanced by another writer** (§3.6 case (b)) | Two-sided divergence — both facts are real, and rbox does not pick a side (§10 reserves this for design 173). Publishing the omission would retire a value this device never held (round-2 blocker 1). | Hold that one ref under `deletion-pending`, keep the repository syncing everything else, and name the exit: `rbox git resolve <repo> keep-mine` to publish the deletion, or re-create the branch. The refusal at `resolve-command.ts:657-665` is narrowed so the verb exists, and the exit runs through design 176's intent and the publisher-ACK arm (§3.6 case (b)). |

### 5.1 Surfaces — RULED 2026-07-24

**`rbox doctor` gains a leftover-worktree section. Deferral messages do not print absolute
worktree paths yet.** Two decisions, one shared reason.

**Doctor: yes — but through a local-only projection that never reaches the bundle.** A
section listing leftover linked worktrees — count, and per entry the branch, the **full
absolute path**, `prunable`, and whether it currently holds a synced ref. Ten accumulated
silently on the founder's Mac and the first signal was a sync deferral.
`path.basename(e.path)` alone (`apply.ts:118`) is useless at that scale precisely because
the founder's worktrees are all *named after their branches* — the basename repeats the one
field the message already prints. `rbox doctor` runs locally on the machine that owns those
paths, so a full path there reveals nothing the operator does not already have.

**The exclusion mechanism — new in v3, because `checks` is uploaded raw.**
`buildDiagnosticsBundle` (`doctor-cmd.ts:523-541`) applies `redactGitLogLines` only to
`daemonLogTail` (`:527`) and passes `checks: ctx.checks` **unredacted** (`:535`) — and at
least one existing check already puts a raw `Error.message` into it
(`doctor-cmd.ts:351`). Putting absolute worktree paths into a `DoctorCheck` would upload
them. So:

- The leftover-worktree data lives in a **separate field on `DoctorContext`** — say
  `ctx.localOnly.leftoverWorktrees` — that is **not** a `DoctorCheck` and is **not** an
  argument to `buildDiagnosticsBundle`. Only the human printer reads it.
- The bundle instead receives a redacted projection: the count, and per entry the branch
  name, `prunable`, and a `holdsSyncedRef` boolean. **No path text, no basename, no
  parent-directory name.** If path *shape* turns out to be diagnostically useful later, add
  a salted digest, not a truncation.
- **Typed, not filtered at runtime.** The local-only projection and the bundle projection
  are distinct types, and the local-only type is not assignable to the bundle's — so
  "forgot to strip it" is a compile error rather than a review miss.
- **Tested:** `JSON.stringify(await buildDiagnosticsBundle(ctx))` contains none of the
  absolute paths the local section printed (§9.6).

This closes the new exposure. It does **not** close the pre-existing one — `ctx.checks` is
still uploaded raw, and `doctor-cmd.ts:351` is still a raw `Error.message`. That stays
scoped out (§10); the rule here is only that this design must not add to it.

**Deferral messages: not yet, and the reason is a redaction gap, not a UX preference.**
`rbox doctor` output can be uploaded (`POST /v1/diagnostics`), and an independent review
found that absolute paths already reach local logs through this exact channel:

- `protocol-locks.ts:158-159` and `:167-168` embed the absolute lock path in their `Error`
  messages (`protocol lock held: ${lockPath} …`), where `lockPath` is
  `path.join(await fs.realpath(commonDir), "rbox-operation.lock")`
  (`protocol-locks.ts:174-177`) — e.g. `/mnt/private/client-project.git/rbox-operation.lock`.
- **PR #439 is what surfaces them.** `621aed46` added
  `checkoutRefDetail ??= \`publishing ref ${ref} failed: ${boundedRefFailure(error)}\``
  (`follow.ts:1026`) to a catch that previously classified the error and then discarded it.
  That detail is the raw Git error, truncated but not scrubbed. (The founder's framing
  attributed the paths to #439 authoring `protocol-locks.ts`; it did not — `621aed46`
  touches only `follow.ts`, +3 lines. #439 is the change that lets those paths *escape*,
  which is the part that matters here.)

The redaction rule then has to be understood for what it actually is, because it is not a
path scrubber. `redactGitLogLines` (`doctor-cmd.ts:171-215`) is a **fail-closed
allowlist**: a line is processed only if it starts with `git-sync `, `git-sync:`,
`git deferred` or `lock starved:` (`doctor-cmd.ts:181-182`), and a recognized line is
**rewritten into a closed enum** — the free text where a path would live is discarded, not
masked (`classifyGitLogMessage`, `doctor-cmd.ts:129-166`, consumed at `:196`). So a path
inside a well-formed `git-sync deferred …` line is safe today. But:

- Ordinary daemon-log lines occurring **before** the first Git-family line pass through
  **verbatim** (`doctor-cmd.ts:183-185`).
- `redactGitLogLines` is applied only to the daemon log tail (`doctor-cmd.ts:527`).
  `ctx.checks` is bundled **unredacted** (`doctor-cmd.ts:535`), and at least one check
  puts a raw `Error.message` straight into it (`doctor-cmd.ts:351`).

**Therefore:** the protection is the *grammar*, not a path rule. It holds only for as long
as every path-bearing line keeps its `git-sync ` prefix — which is what
`src/cli/design176-grammar-freeze.test.ts` pins (it freezes the literal prefixes, and names
the doctor classifier as a consumer at `:20`). Adding more absolute paths to user-visible
surfaces before that is confirmed to cover worktree paths — including the unredacted
`checks` channel — widens an exposure nobody has audited. Full paths in **local** `doctor`
output are fine; the **uploaded** path is what needs the rule.

**Follow-up, outside this design:** confirm or extend the diagnostics redaction rule to
cover absolute filesystem paths as a class (not as a side effect of the git-sync grammar),
and close the unredacted `ctx.checks` channel. When that lands, printing the worktree's
absolute path in the deferral message becomes a one-line change and should be made — it is
the obviously better message, and this is a sequencing decision, not a rejection.

### 5.2 The deletion hold's own reason — `deletion-pending` (new in v8, round-6 major 1)

v7 reused `local-commits` for the deletion hold and specified a new "`ref-plane` presentation" with no
producer. Round 6 traced what actually happens: `follow.ts:1030-1037` derives the typed blocker's
reason from the `heldRefs` value; `heldReasonOf` (`apply.ts:749-753`) derives the durable deferral
reason from the same map; `status-view.ts:291` renders `local-commits` as *"Local commits changed
here."*; and `held-skip.ts:37-40`/`:57-62` allowlist the literal. **So a user who deleted a branch is
told that local commits changed, and there is no sideband that survives from classification to
`setDeferral`.** The fix is one new reason, and the tuple that carries it is now
compile-enforced-total (PR #438), so the addition is a decision the type system forces rather than
one someone can forget.

**The tuple addition.** `GIT_DEFERRAL_REASONS` (`sync-state-model.ts:130-134`) gains
`"deletion-pending"`. `GIT_DEFERRAL_REASON_PRECEDENCE` (`:149-153`) must then place it or
`_AllGitDeferralReasonsRanked` fails to compile (`:156-158`), and the load-time duplicate/size check
at `:165-167` is the second line of defence. `contract.ts`'s telemetry vocabulary (`:120-127`) has the
mirror-image assertion and must gain it too.

**The precedence slot: rank 5, immediately after the human-divergence family and before `conflict`.**

```
local-edits, local-index, local-operation, local-commits, local-stash, DELETION-PENDING,
conflict, worktree-ownership, git-busy, stale-unattributed, unreadable, artifact, config,
ignored-target, containment, unsupported, other
```

The ordering is user-visible: `firstReason` (`follow.ts:458-464`) picks exactly **one** reason per
repository from the rank table, so a slot is an argument about which sentence a person reads. Three
reasons, in the order they bind:

1. **Below every `local-*` reason.** Those name work that may still need a human decision, and a
   `deletion-pending` hold does not. If the same repository has both, the actionable one must be the
   one shown — hiding "local commits changed here" behind a deletion that clears itself is the same
   masking that cost three days in §1.2, where mode (a)'s `worktree-ownership` hid mode (b) until
   `621aed46` stopped discarding the detail.
2. **Above `conflict` and `worktree-ownership`.** Both of those say *"rbox will not proceed until
   something changes"*; `deletion-pending` says *"rbox is part-way through finishing what you asked
   for"* — strictly more informative about the same repository, and true without the user doing
   anything. This is the direction the §1.2 lesson points.
3. **It belongs at the tail of the human-divergence family because that is its cause.** The tuple's
   own comment groups *"human-divergence reasons (the user's own work)"* first, then durable
   structural conditions, then environmental ones. `deletion-pending` is transient and mechanical like
   `git-busy`, but it is **user-caused** like `local-commits`, and cause is what the existing grouping
   sorts on. Placing it with `git-busy` would file the user's own `git branch -D` under
   "environment".

**`status-view.ts`'s second ordering — v8's rationale was wrong about what it does (round-7 minor 2).**
v8 said `gitDeferralReasonPrecedence` (`status-view.ts:319-328` — a `switch (reason: string)` with
`default: return 5` and no exhaustiveness) is "used only to break chronic-age ties" and therefore
needs no change. It has **two** consumers with different roles, and only the second matches that
description:

- `status-view.ts:382-388` — it is the **primary sort key that selects which lane and reason a
  repository displays**: `ordered = [...lanes].sort((a,b) => precedence(a.reason) - precedence(b.reason)
  || deferredSince…)`, then `display = ordered[0]`, which sets `displayReason` (`:411`),
  `displayLane` (`:412`), `reasonSince` (`:413`), the presentation and remediation class (`:394-406`)
  and `alsoDeferred` (`:407`). Age is the *tie-break inside* it, not the thing it breaks.
- `status-view.ts:425-429` — here it *is* only a tie-break, after `oldestDeferredSince`, which is
  computed independently at `:389-392` and never consults precedence.

So `default: 5` leaves `deletion-pending` **tied** with `conflict`, `worktree-ownership`, `git-busy`,
`config` and the rest at `:382-388`, with the tie decided by timestamps and then lane name — which is
not the ordering §5.2 argues for. **The decision:** add an explicit `case "deletion-pending": return 5;`
and push the reasons that were at 5 down by one, or (better) have this function read
`GIT_DEFERRAL_REASON_RANK` and stop being a second hand-written ordering. Either way it needs a test
asserting the *ordering* rather than the constants, and the repo-level nag view at `:425-429` is
genuinely unaffected. The two orderings may still disagree — a self-clearing deletion is the right
*reason* to show for one repository and the wrong repository to nag about — but that disagreement has
to be chosen, not inherited from a `default`.

**The copy (non-developer bar).** One `DEFERRAL_REASON_PRESENTATION` entry (`status-view.ts:287-304`):

| Field | Value |
|---|---|
| `label` | `finishing a branch deletion` |
| `text` | `rbox is finishing a branch you deleted here.` |
| `repair` | `rbox retries this on its own. If it stays, run \`rbox doctor\`.` |
| `transient` | `true` |

No OID, no ref name, no "BASE", no "tombstone", no "witness". **v9 corrects the `repair` line
(round-7 minor 2):** v8's *"Nothing to do — this clears once rbox publishes the deletion"* is false
for the two shapes this design names — §3.6 case (b) and §3.2b's standing-refusal residual — both of
which need movement or `keep-mine`. *(v10 listed a third, §3.2c's current-branch termination; it goes
with the withdrawn field.)* The shared sentence
must not promise self-clearance unconditionally; where an exit exists it comes from the ref-plane
blocker's own detail line and from `renderGitDeferralCompanion` (`status-view.ts:475-481`, which
consumes `presentation.repair` and is otherwise reason-tolerant), not from this shared copy.

**Doctor classification.** `gitReasonOf` (`doctor-cmd.ts:107-127`) first matches any
`GIT_DEFERRAL_REASON_SET` member as a substring, and that set is **derived from the tuple**
(`doctor-cmd.ts:23` imports it, `:34` builds the set), so `deletion-pending` classifies itself once it
is in the tuple. Add one explicit regex arm **before** the `local-commits` arm at `:115` — otherwise a
detail line saying "branch deleted here" falls into
`/local commits?|diverg|held refs?|\bheads?\b/` and is reported as `local-commits`, reproducing the
same lie one layer down. The new log lines must keep the `git-sync ` prefix so `redactGitLogLines`'s
fail-closed grammar (`:129-166`, `:171+`) still rewrites them into closed enums (§5.1, §9.6).

**The complete consumer inventory — v9, round-7 major 3.** v8 listed five call sites. The sweep
found **fourteen** plus five tests — **fifteen with v10's capture-lane producer below, which is the
count this section and every summary of it now use** (round-9 minor 2) — and four of the misses are not
cosmetic: two are typecheck
breaks, one aborts an entire user-visible sidecar at runtime, and one is a test that *silently stops
asserting what it claims*. PR #438 made **precedence over the tuple** compile-enforced-total —
`UnrankedGitDeferralReason` / `_AllGitDeferralReasonsRanked` (`sync-state-model.ts:156-158`) plus a
module-eval permutation guard (`:165-167`) — which is why the rank slot is forced, but it does not
force anything else in this table.

*Compile-time exhaustive — typecheck fails without the member:*

| Site | Change |
|---|---|
| `sync-state-model.ts:130-134`, `:149-153` | tuple member + precedence slot; `:156-158` is the compile gate, `:165-167` the load-time permutation check |
| `telemetry/contract.ts:120-127` | the mirror tuple, `satisfies readonly GitDeferralReason[]` with `MissingGitDeferralReason` / `_AllGitDeferralReasonsCovered` |
| `status-view.ts:287-304` | `Record<GitDeferralReason, GitDeferralReasonPresentation>` — the presentation entry above |
| `git/resolve-presentation.ts:113-133` | **MISSED IN v8.** `refusalMessage`'s `const messages: Record<GitDeferralReason, string>`; consumed at `resolve-command.ts:992`. Needs one refusal sentence |
| `sync-git/breadcrumb-veto.ts:56-76` | **MISSED IN v8, and it forces a real decision, not boilerplate.** `breadcrumbGateForReason` switches over the union with `default: return assertNever(reason)` (`:74`, helper `:52-54`). It must decide which `BreadcrumbVetoGate` a deletion hold maps to; `BreadcrumbVetoGate` is a *separate* closed union with its own totality proof (`:107-114`) and its own rank tuple (`:27-45`), so choosing a new `reason-deletion-pending` gate is a second, deliberate slot |
| `sync-state-model.ts:203-204` | `TypedBlocker`'s `ref-plane` reason union — a widening, not a break, but the producer at `follow.ts:1031-1037` cannot emit the new reason without it. `heldRefs`'s persisted union is **unchanged** |
| `git/resolve-command.ts:101-102`; `sync-git/follow.ts:198-199` | `Extract<GitDeferralReason, "local-edits" \| … \| "local-stash">` (`HumanReason` / `manualResolution.waivedReasons`). No break; the **decision** is that `deletion-pending` does **not** join the manual-waiver set — the hold is mechanical, not a human divergence a resolution waives |
| `config-surface.typecheck.ts:10`, `:77`; `git-cmd-surface.test.ts:7`, `:14` | structural equality / type-only re-export lists. No change |

*Runtime allowlists — wrong behaviour, not a failed build:*

| Site | Consequence if missed |
|---|---|
| `apps/api/src/telemetry-ingest.ts:118-122` (`SERVER_GIT_DEFERRAL_REASONS`), `:324` (length cap), `:326-330` (`find` → `return null`) | the **whole sync-state packet** is dropped as `bad_state` (`:339-354`) for any device that can emit the reason. Hand-copied tuple with no type link to the CLI. This is why the API ships and is promoted first (§11 step 0) |
| `shell-init.ts:189-190` | **MISSED IN v8, and worse than "rejects the file".** The generated zsh `case $reason in …|other) ;; *) … return 0` closes the fd and returns on the first unknown row (`:190`), so the **entire** sidecar yields no prompt indicator for **every** repository in that workspace. Reachable the first cycle the reason is displayed, because the writer emits `projection.displayReason` verbatim (`activity.ts:398-417`) |
| `sync-git/held-skip.ts:37-40` (`heldBlockersAllowSkip`) | not allowlisted ⇒ the sidecar skip is never taken. Over-work, safe; add it |
| `sync-git/held-skip.ts:57-62` (`causallyMapped`) | pair `deletion-pending` with `missing-branch-proof`, else a spurious composer blocker |
| `sync-git/apply.ts:749-753` (`heldReasonOf`) | a hand-rolled chain that can never produce the new reason. **Derive it from `progress.blockers`' `ref-plane` entries via `firstReason` over `GIT_DEFERRAL_REASON_RANK`**, falling back to today's chain when that set is empty (all-indeterminate holds carry `provenance: "indeterminate"` instead, `follow.ts:1031`). Behaviour-identical today — the only ref-plane reasons today are `heldReasonOf`'s three and their ranks reproduce its order — and total tomorrow. `FollowProgress` already carries `blockers` as its *"complete classification seam"* (`follow.ts:128-132`) |
| `sync-git/follow.ts:717-767`, `:1030-1037` | the **apply-lane** producer: classify the deletion hold as `deletion-pending` and emit it on the ref-plane blocker while `heldRefs[ref]` persists `local-commits` |
| `sync-git/plan.ts:159`, `:174-183`, `:224-232`, `:275-278`, `:533-551` | **MISSED IN v9 — the capture-lane producer (round-8 major 3).** Step D lives in the push lane, records its defer as a free-form string, and `plan()` classifies it with `captureReason`, whose arms are regexes with no `deletion-pending` member: an exact `"deletion-pending"` detail becomes **`other`** and any detail containing the word *capture* becomes **`artifact`** via `/capture\|artifact\|blob\|decrypt\|import\|bundle/`. So the residual §13.4 item 10 promises to report under `deletion-pending` is displayed as the wrong condition. **Fix:** the deferral item gains `typedReason?: GitDeferralReason`, `plan()` prefers it (`item.typedReason ?? captureReason(item.reason)`), and step D passes `"deletion-pending"` explicitly — the same out-of-band per-item tagging `configLaneDefers` / `configLaneItems` already use by object identity (`plan.ts:160-161`). Needs a **capture-lane** status test; the apply-side `FollowProgress.blockers` test does not cover it |
| `doctor-cmd.ts:34`, `:107-127` | derived from the tuple, so recognition is automatic; the explicit regex arm above is still required |
| `daemon/ambient-status.ts:185-198`; `status-view.ts:306-312` | tolerant by design (`isKnownGitDeferralReason`, `UNKNOWN_GIT_DEFERRAL_PRESENTATION`). No change — this is the documented safe-downgrade path |
| `sync-git/deferral-hygiene.ts:27-44`, `:125-126` | keyed on `GitBusyClassification`, not on `GitDeferralReason`. **Decision: no change** — the lock-doctor hygiene sweep is about lock provenance, and a deletion hold has none |
| `apps/api/src/fleet-alerts.ts:27`, `:233`, `:291`; `migrations/0027_device_sync_state.sql:10`; `apps/web` | render or store the token verbatim; no schema change and no web surface |

*Tests:*

| Site | Effect |
|---|---|
| `telemetry/contract.test.ts:48` | `toHaveLength(16)` → 17. Hard fail |
| `apps/api/test/telemetry-ingest.test.ts:82` | `SERVER_GIT_DEFERRAL_REASONS` `toEqual` the CLI tuple — hard fail unless both gain the member **in the same position**. This is the site that makes "same PR" mandatory rather than tidy |
| `apps/api/test/telemetry-ingest.test.ts:262` | **Not named by round 7, and it is the sharpest one.** The invalid case builds a 17-long `deferralReasons` array to trip the `length >` cap at `:324`. With 17 tuple members it no longer exceeds the cap, dedups to one valid reason, and is **accepted** — the test's own assertion (`dropped: invalid.length`) fails, and if someone "fixes" it by relaxing the assertion the cap stops being tested. Bump the fixture to 18 |
| `status-view.test.ts:143` | a hard-coded 16-string list in a test named *"the reason vocabulary is exhaustive"*. It does **not** fail — it silently stops being exhaustive. Replace the literal with `GIT_DEFERRAL_REASONS` |
| `sync-git/deferral-precedence.test.ts:11-22`, `:26-45` | self-updating: it compares sorted `PRECEDENCE` against sorted tuple, `Object.keys(RANK)` against the tuple, and runs a per-member `firstReason` identity loop. These are the guards that make the addition safe; the pairwise winners at `:26-45` survive an insertion at rank 5 |
| `shell-init.test.ts:167`, `:184`, `:195-203`, `:222` | no change required; add a positive row for the new reason so the `:189` edit is covered |
| rig scenarios (`git-entanglement.ts:416`, `:465`; `git-shapes.ts:668-669`, `:747`, `:752`; `git-fixtures.ts:81`; `git-held-livelock.ts:167`) | per-scenario expected reasons; not exhaustive lists. Touch only if a scenario's expected reason changes |

*(Also stale, not functional: `docs/design/120-telemetry-ingest.md:262` and `:374` still describe a
15-value union. Worth a one-line fix in that design when this lands.)*

**Compat, and the one real constraint the sweep found.** There is no wire exposure — deferral reasons
live only in local `state.json` (`GitDeferral` on `RepoRecord`) and are never projected onto a
manifest. Two channels do carry the string, and they behave differently:

- **Local downgrade is safe by design and needs no guard.** `gitDeferralReasonPresentation` takes a
  `string` and falls back to `UNKNOWN_GIT_DEFERRAL_PRESENTATION` (`status-view.ts:280-285`, `:306-308`),
  `isKnownGitDeferralReason` returns false, and `ambient-status.ts:191-198` then substitutes the
  unknown presentation and the `apply-unavailable` remediation class. So an older binary reading a
  newer binary's `state.json` shows *"unrecognized Git issue"* — imprecise, never wrong, never
  rejected. The persisted `TypedBlocker` reason inside `attempt.blockers` degrades the same safe way:
  `heldBlockersAllowSkip` returns false for an unrecognized reason, so the older binary simply runs
  the full follow instead of the sidecar skip, and `causallyMapped` emits an extra composer blocker.
  Over-work, never a wrong action.
- **Telemetry is the real constraint, and it is a release-ordering one.** The deployed API's
  `validateSyncState` **rejects the entire sync-state packet** when any reason is outside
  `SERVER_GIT_DEFERRAL_REASONS` (`apps/api/src/telemetry-ingest.ts:118-122`, `:324-330`: `return null`
  on the first unknown member), and it also caps `deferralReasons.length` at that list's length. A
  device on a CLI that can emit `deletion-pending` would therefore have **all** of its sync-state
  telemetry silently dropped — blinding the deferral view for that device entirely, not just for this
  reason. Client-side coercion is not the answer (mapping it to `local-commits` on the wire restores
  the lie in the admin view, and dropping it can produce the empty-list-with-`reposDeferred > 0`
  shape the same validator rejects at `:331-335`). **The guard is ordering:** add the member to
  `SERVER_GIT_DEFERRAL_REASONS` and to `contract.ts`'s vocabulary in the same PR, and **promote
  `apps/api` to `production` before tagging the CLI release that can emit it** — the two ship through
  different pipelines (`docs/DEPLOYMENTS.md`: the API from the `production` branch, the CLI from a
  `v*` tag), so this is a real sequencing step and it is recorded in §11. Dev needs nothing extra: the
  merge to `main` deploys the DEV API automatically.

## 6. Cost

Baseline, measured (§1.3): `ownershipMs` p95 ≈ 9 s, 867 s wedged, 635 ownership candidates
for one repository. Scale: ~203 branch heads across 110 repositories.

| Change | Complexity | Expected wall clock |
|---|---|---|
| P1 witness evaluation, negative case (both lanes) | O(BASE heads) in-memory lookups against a ref map each lane already read. **Zero new Git subprocesses.** | ~203 property lookups per full pass. Unmeasurable. |
| §3.6's plan-side gate on the trusted-fingerprint carry | The same O(1) predicate against the probe's own identity refs, on repositories whose fingerprint *hit* — the hot path for converged repositories. No spawn, no protocol lock, no artifact scan unless a candidate exists. | Unmeasurable if implemented as specified; a new spawn per converged repository per cycle if not. **This is the line to watch in review** — it replaces v6's much riskier reconciliation above `apply.ts:873`. |
| P1 step L, the locked absence proof | One prepared verify-only ref transaction per witnessed ref — no artifact, no mutation, no state save. Runs only for a ref that already passed the other eight rules. | Tens of ms, once per deletion, not per cycle. |
| P1 step K, the ACK retirement | Additional fields on an authority object the ACK already builds (`push.ts:962-975`) and two extra conditions inside `composeRepoBase`, plus one lane cleared in the save that already runs. **No extra state save.** | Zero. |
| §3.2's witness-backed tombstone | One extra loop over the witnessed refs inside a pure function that already loops over `advertised.refs`. | Zero. |
| **§3.2b step D, the unproven-absence defer** | One boolean over the same W/L outputs plus the active-BASE gate (two record-field lookups, v10), then **the existing per-repository carry machinery** — `revertCapture` (`plan.ts:174-183`) after a committed capture, or `deferOne` (`:533-551`) if W/L are hoisted ahead of it. No new subprocess, no new state, no new section. | **Zero compute; one sync cycle of Git-plane latency** for that repository whenever a witness or proof refusal occurs, and a standing carry while a *standing* refusal persists (§13.4 item 10). This is the design's one deliberately-bought latency and §3.2b states it rather than amortizing it. |
| §3.2a's push-side artifact reader | One `scanBaseArtifacts` + `readSettledAbsence` per repository that has a witness candidate *or* an existing pending section — never on the converged path. | Unmeasurable; strictly less than the probe it feeds. |
| §3.6's apply-side hold | One map entry in a classification pass that already runs. It **removes** work: the throw at `branch-transition.ts:105`, its catch, and the whole-repository defer it caused. | Negative. |
| §3.3a strict ref read | Same `git show-ref` invocation, different error handling. **Zero additional subprocesses.** | Zero. |
| P1b pending pre-probe | Today's loop plus one BASE lookup and one artifact-disposition lookup per missing head. | Unmeasurable. |
| P3 content equivalence | Runs **only** on tips the ancestry proof already rejected — normally 0 per cycle. Per probe: 1 `merge-base` + 1 `diff-tree｜patch-id` + 1 walk of `base..D` capped at 5,000 commits. Cached on immutable `(T, D)`. | Cold worst case (all ~203 heads unowned, e.g. first sync of a heavily squashed workspace): ~600 spawns ≈ 6–12 s **once**. Steady state ≈ 0. |
| P2 held-skip for `worktree-ownership` | One extra `git worktree list --porcelain` per repository per cycle for the digest. | **Removes** a full follow per cycle for every ownership-held repository — on the observed data, roughly the whole 9 s p95 for `Personal/rbox-core`. |
| ~~§3.7 keep-pin accumulation~~ / ~~expiry sweep~~ | **Gone — R4 (§3.0a).** v3 carried ~900 hidden refs at steady state holding their commits against `git gc`. | Zero. |
| ~~**P4 per-ref pending lane**~~ | **Gone — R5 (§4.4).** The design's only recurring positive cost: a merged section is a new section, so every cycle with an outstanding hold would have run a full capture-encrypt-upload instead of re-advertising the carried section by identity (`publisher-tombstones.ts:183-186`). | Zero. |
| ~~**v6's omission intent**~~ / ~~**A′/A″ recovery arms**~~ | **Gone — v7 (§13.6).** v6 paid one extra state save per omitting push (the pre-POST arm), one persisted field per unpublished deletion, and an artifact scan plus a reconciliation CAS on the pull path in the owed window. | Zero. |

**Net, restated for v7.** The design is **net negative in wall clock and free at rest**, and every
one of v7's remaining costs is per-deletion rather than per-cycle. The only new per-cycle work is a
hash of a `git worktree list` output the follow already spawns five times, plus two O(1) predicates
over maps that were already read. **R4** removed the design's only standing at-rest cost (v3's ~900
pinned refs), **R5** removed its only recurring transfer cost (P4), and **v7** removed its only
per-deletion write beyond the ACK itself (v6's armed intent). **v8 bought one of those back — §12 C3's
attempt record — and v11 gives it back**: the field is WITHDRAWN (§3.2c), so design 200's durable
footprint is again zero bytes per deletion beyond the ACK the push already performs, and there is no
per-repository map, no hard cap and no reconciliation on the pull path. v1's blanket claim that "net
cost is negative" is true for the whole design without qualification, which it was not in v3, v4, v6 or
v8.

Two things v4 said here are worth keeping as constraints on **design 201**, since they are
why P4's cost was larger than it looked:

- **Held-skip does not suppress a capture.** Held-skip short-circuits the *follow* (apply
  lane); capture runs on the *push* lane. A repository held-skipped every cycle would still
  have captured every cycle under P4, so the two optimizations do not compose.
- **A long-lived hold would have been a recurring upload**, because a carrying repository
  never settled, so BASE never advanced and each emit bundled the whole local delta since the
  last *settled* BASE rather than since the last publish. Any per-ref model needs a basis
  derived from what it last *published*, not from BASE.

Out of scope but worth recording: the sync path still uses the unbatched per-tip ownership
proof (`reachability.ts:106-126`) while design 128's ~4-subprocess batched implementation
(`:135-206`) is wired only to `rbox git resolve`. Moving the follow onto
`partitionOwnedByIncoming` is the single largest available win in this area and belongs in
a follow-up to design 174, not here.

## 7. Invariants

`docs/INVARIANTS.md` has no invariant naming the pending lane, `advertised`, or
`publisher-ack` — designs 174/176/177 shipped without adding one, against that file's own
maintenance rule (`INVARIANTS.md:1-3`; corroborated at
`docs/design/notes/2026-07-24-thermo-nuclear-sweep-2.md:99` and `docs/STATUS.md:121`).
This design closes part of that gap. New entries, in the file's format (heading is the
identifier; statement, `Enforced:`, `Proven:`, `Since: 200`):

1. **Positive BASE is always a value this device holds or held.** A `refs/heads/*` member of
   BASE carrying a usable current-lineage origin was **physically held by this device at that
   OID**; and no BASE member ever advances to a value this device only *relayed*. *(Today
   emergent from the two origin mints — `pullOrigin` at `base-composer.ts:227-228` and the
   `publisher-ack` mint at `:364-367` — plus `:418`; now pinned, because §3.4 depends on the
   first half and `logicalBaseRefs` vs `beforeOid` — `branch-transition.ts:105` — depends on the
   second. v7 leans on it harder than v6 did: it is the provenance P1b binds to now that there is
   no receipt — §3.2.)* **It proves possession, never the cause of a later absence** — §3.3b.
   **v9 states the strength exactly, because v8 overstated it (round-7 minor 1):** the invariant
   proves the device *held* the OID, **not** that it captured and published it. A value applied
   from a peer carries a `pull-p` origin (`base-composer.ts:227-228`), and a later re-assertion at
   the same OID does not launder it — `publisher-ack` mints an origin only when
   `requested !== before` (`:363-367`) and the shared tail retains `priorOrigin` when
   `before === after` (`:457-461`). Any text or test that says "already published by this device"
   or "re-mints a publisher-ACK origin" for the equal-value case is wrong; the correct statement is
   *held, and the wire has already carried an object source for it*.
2. **A published branch deleted locally is captured, never resurrected while its capture is in
   flight.** BASE-positive + locally-absent + clear artifacts yields, for that one ref, a **hold**
   — never a branch creation and never a pre-state throw — until the publication that records the
   deletion is acknowledged (§3.6). The dual half is equally binding: **once the omission has been
   acknowledged, the retirement is final and is never re-published**, so an incoming assertion of
   the same OID afterwards is a *newer* writer's and is applied. *(v5's `owed` predicate and v6's
   durable omission intent were two attempts to state this over a window v7 does not open —
   §13.6.)*
3. **Absence capture is fail-closed.** Any missing origin, stale lineage, existing A/P/K,
   sibling ownership, busy repository, unreadable identity, HEAD symref naming the ref,
   ref-database regression signal, scoped section, or refused locked transaction leaves the ref
   untouched. *(Every rule is per-ref evidence. There is deliberately no repository-level count —
   §3.0a, R4.)*
4. **Content equivalence waives holds, never authorizes deletion.** A patch-id match may
   only convert `would-drop` to `proven`, and only for a non-destructive transition; a
   `content-equivalent` waiver and an `afterOid === null` transition are disjoint by
   construction. Deletion authority remains tombstone attestation or a deletion witness.
5. **An absence proof is never derived from a failed ref read.** Every read that feeds a
   deletion, a locked absence proof, or a published section distinguishes "no refs" from
   "could not read refs" and fails closed on the latter. *(New in v3 — §3.3a.)*
6. **A pending section is superseded only against a candidate proved from local state.**
   Supersession requires, for every pending ref, either local presence at an
   equal-or-descendant OID or a deletion witness whose retired value is **exactly** the pending
   value — `record.base.refs[R] === pending.refs[R]`, under §3.3's rules (§3.2 P1b) — never mere
   omission, and never a value the candidate relayed. *(Pins `REVIEW-174-R1-OPUS-B.md:14`'s
   resolution, which is currently unpinned in `INVARIANTS.md`. v4–v6 expressed the binding as
   `receipt.priorOid === pending.refs[R]`; v7 reads the same fact from BASE plus its origin, which
   invariant 1 makes the stronger provenance. The relay bar has no live consumer now that P4 is
   cut — no candidate this design composes ever contains a relayed value — but it stays in the
   statement because `gitCommitAncestry(Y, Y)` returns `"equal"`, so a future per-ref model that
   relays a value would *prove* supersession by accident. §4.4 records that landmine.)*
7. **Worktree ownership is observed regardless of containment.** Sibling worktrees outside
   the workspace still hold their refs; containment affects only reporting.
8. **rbox never destroys a reachable Git object to publish a deletion.** A deletion capture
   omits a ref and retires a BASE member; it deletes no live ref and no object. A
   follower pruning under tombstone authority still pins the displaced OIDs, unchanged from
   design 116. *(§3.4. What rbox does **not** promise is that a branch pointer survives a
   wrongly-published deletion — the durability contract is file history, R4, §3.0a. That is a
   product semantic, deliberately not an invariant.)*
9. **Composing a section is never authority over a ref this device does not hold.** A held
   ref is never superseded, never tombstoned on this device's behalf, and never contributes a
   published value this device did not capture. *(Enforced today by the whole-section carry
   itself — `publisher-tombstones.ts:183-186` reuses the pending section unparsed — which is
   exactly why the carry is what remains after R5. Kept as an invariant because it is the
   property design 201 must preserve *without* the carry.)*
10. **A published deletion names the exact value it retires, and an unproven absence is never
    published as a deletion at all.** A wire tombstone authored by this device for `refs/heads/*`
    covers either a value its own last acknowledged section advertised (today's supersession rule,
    `publisher-tombstones.ts:108-121`) or the exact `record.base.refs[ref]` of a ref for which step L
    holds a **passing locked proof** (§3.2). It never covers a value the device merely relayed, and a
    published section never **omits** a `refs/heads/*` ref that this device's BASE holds positive
    unless such a proof exists — **the repository's capture defers and its last synced section is
    carried instead (§3.2b step D)**. *(New in v6, round-4 blocker 2; re-sourced in v7 from the
    witness instead of a receipt; **v8 added the second half**, which round-6 blocker 1 showed the
    first half does not imply: a bare omission with no tombstone is still destructive for a follower
    whose tip is reachable from the incoming roots — `follow.ts:743-751` sets no hold for an owned tip
    and `follow.ts:990-998`'s attestation check never runs for it. **v9 changes the second half's
    mechanism, not its content**, and states its two boundaries so the invariant stays true rather
    than aspirational: it is scoped to sections whose `refScope` is `all`, because a scoped section's
    omission never reaches a receiver's transition planner at all (`follow.ts:609`, `:713`); and it
    does not constrain a ref BASE **no longer** holds — after an incoming tombstone retires
    `BASE[R]`, the next capture legitimately omits `R` with no proof and the pre-existing
    advertised-diff loop may re-author the already-authorized deletion at the advertised value. That
    second boundary is round-7 blocker 2, and it is why v8's normalizer refusal could not ship.)*
11. **No durable local record ever retires or authorizes a BASE member's present→absent
    transition ahead of the wire.** A `refs/heads/*` member of BASE goes present→absent **only** in
    the transaction that performs it (design 130's blessed apply-side path: a prune this device
    performed under tombstone authority, a confirmed manual resolution, or journal recovery of
    either) **or** at the publisher ACK of a section that omits the ref, backed by a locked
    expected-absent proof taken in that same push (§3.2). There is no third path. *(New in v7 — this
    is the invariant whose absence produced A′, A″, the `owed` predicate, `record.absenceOmission`
    and five rounds of findings. §13.6.)* **v8 states the verb the invariant always turned on —
    *retire or authorize*** — and that wording stands, but **v11 needs no clause about a withholding
    record at all**: §12 C3 is WITHDRAWN, so design 200 persists **nothing** about an unpublished
    deletion (§3.2c). v8's carve-out for `record.absencePublicationAttempt`, v9's correction of its
    "cannot enable any code path" overstatement (round-7 minor 3) and the narrowed §9.6 snapshot row
    that policed the distinction all go with the field. The invariant returns to its v7 form: **no
    durable local record, of any kind, about a present→absent transition the wire has not heard.**
    The executable form is §9.6's snapshot test, which asserts no *retired* BASE member, no A/Z
    artifact **and no per-ref deletion field of any kind** at any injectable failure point.

*(v4 had a different tenth invariant — "every published section's refs are covered by its own
bundle chain" — introduced because P4 was the first shape that could violate it. **P4 is cut**
(R5, §4.4), so it is emergent again: every section is captured from local refs and its bundle
is built from them. It is not proposed as an `INVARIANTS.md` entry here; it is recorded in
§4.4 as a design-201 prerequisite, together with the round-3 blockers B3 and B4 that are the
two concrete ways to violate it.)*

"Branch equality is not deletion authority" (since 130) remains true and unweakened: a
deletion witness is not equality, it is a locked proof of physical absence against positive
provenance, published before BASE moves. `follow.ts:894-895` keeps holding; for a witnessed ref it
simply holds under a named reason with a publication already in flight.

### 7.1 The recoverability analysis — kept as history, superseded by R4

**The mechanism discussion is superseded by R4 (§3.0a); the facts are still true and are why neither
earlier answer should come back** (full record: §12 Q3). Four of them:

1. **A tombstone retains an OID, not an object.** `GitRefTombstone` is `{oid, ts, generation}`
   (`src/engine/types.ts:71-75`) and `REF_TOMBSTONE_RETENTION_MS` (`publisher-tombstones.ts:10`)
   retains the OID. What retains *objects* is the deliberately equal-valued
   `TOMBSTONE_PIN_RETENTION_MS` (`keep-pins.ts:68`) on the **keep-pin** — a different mechanism with a
   different creator. Anyone writing "recoverable via the tombstone retention" has conflated them.
2. **The follower pin is created by the prune**, so it does not exist when nobody prunes: a
   single-device workspace; both devices deleting before either applies the other's tombstone (each
   takes the `!oldOid && !newOid` path, `follow.ts:936` — a *likely* interleaving for the founder's
   loop); a device that never received the ref; a pre-1.6.8 follower that holds instead of pruning.
3. **The A path really does lack the keep-refs the P path has, and that is deliberate.** The A
   artifact records the OID as *text* in a canonical blob (`base-artifacts.ts:145-149`, `:218-224`)
   while the P artifact creates real keep-refs at `priorOid`/`nextOid` (`:114-118`, spliced at
   `:237-244`). P's keep-refs serve a crash-window rollback (a correctness need); A's would have
   served user-facing recovery — now the file plane's job.
4. **`expireTombstoneKeepPins` has no production caller** (exported at `src/engine/index.ts:284`,
   referenced only by `keep-pins.test.ts:166`) and does not get one. Pre-existing over-retention,
   erring safe; codex's expiry-starvation major is **mooted, not fixed** (§13.2, M4).

### 7.2 ~~Finding a deleted branch~~ — REMOVED 2026-07-24 by R4

v3 specified `rbox git deleted <repo> [--restore <branch>] [--json]` because R3's pin was recoverable
but not *discoverable*. R4 removes the pin, so there is nothing to list; codex's round-2 major on its
persisted shape (M3) is **mooted**. Four verified facts are kept, because they constrain any future
recovery surface:

- **`rbox git resolve … show-me` structurally cannot print an OID.** `buildSnapshot` computes
  local-only entries with their OIDs (`resolve-command.ts:238`, `:259`) and the public projection
  strips them (`:296`); the JSON path replaces any 40-hex token with `[commit]` (`:320-322`), pinned
  by name at `git-cmd.test.ts:222-235`.
- **The tombstone chain evicts long before it expires.** `MAX_REF_TOMBSTONES_PER_REF = 16` /
  `MAX_REF_TOMBSTONES_PER_REPO = 512` (`manifest-validate.ts:23-24`) are applied after the age cutoff
  (`publisher-tombstones.ts:124-146`): the retention constant is a maximum, never a guarantee.
- **The keep-pin origin sidecar cannot carry new facts** (`keep-pins.ts:88-104`, §3.7). A future
  surface needs a **separate versioned sidecar** older clients ignore, and `pinned` is best *derived*
  (origin present, pin ref absent) rather than stored.
- **The server-side copy is not a recovery path.** The objects do survive in historical versions'
  bundle blobs — reachability is computed from the DO's retained roots (`apps/api/src/gc-phase1.ts:44-58`,
  `versions.ts:66+`) and history pruning is disabled in every deployed environment
  (`apps/api/src/retention.ts:36`) — but the window is the plan window (`apps/api/src/plans.ts:24-27`)
  and **no command restores a Git ref from a historical version**: `rbox restore <file>@<seq>` is
  file-plane only (`help-registry.ts:322-330`). §3.0a lists it as the unpromised manual backstop it is.

## 8. Rejected alternatives

1. **Relax `logicalBaseOid !== beforeOid` to permit create-over-positive-BASE.**
   Rejected — §3.1. It is the resurrection path, it makes BASE and P disagree about a
   transition's predecessor, and it turns `git branch -D` into a no-op fleet-wide. v7 does not
   relax it; it holds the ref so the planner is never reached with that shape (§3.6).
2. **Silently drop the BASE member ("forget" the ref) and let the remote re-materialize
   the branch.** Same resurrection outcome, and it manufactures a BASE deletion with no
   evidence — precisely what `130:177-187` forbids and what invariant 11 now pins. It also
   destroys the provenance the correct fix depends on (§3.4).
3. **Let the pre-probe / ACK dry-run skip a pending ref the local repository lacks.**
   The cheap-looking version of P1b. Rejected: it is exactly
   `REVIEW-174-R1-OPUS-B.md:14`'s blocker in a new costume — a deletion is encoded as an
   *absence* from `P.refs`, and permitting supersession on absence alone lets one writer's
   stale section revert another writer's deletion fleet-wide and regress the tombstone
   high-water mark. The witness bound to the exact BASE value is what makes the skip safe (§3.2).
4. **Let `publisher-ack` remove BASE members from a bare omission** (make capture authoritative
   for deletion with no proof). Still rejected, and this is the finding v7 had to answer rather
   than inherit: *"a capture snapshot is taken without the repository protocol locks and without a
   locked R-absence proof. A capture racing a concurrent checkout, fetch or `update-ref` would
   author fleet-wide deletions from a torn read."* v7 does **not** do this. It gives the ACK three
   things the bare version lacked — §3.3's nine-rule witness, §3.2 step L's locked
   expected-absent transaction, and an ACK-side check that the accepted section itself carries the
   tombstone at the retired value — and only then lets the acknowledgement record the retirement
   (§3.2, invariant 11). `130:302-303` is right that a *bare* ACK is add/advance-only; the answer
   was never "a weaker ACK", and v2–v6's answer ("a locked receipt, retired locally, published
   later") turned out to be the wrong half of the fix.
5. **Ignore worktrees outside the synced workspace.** Rejected — §4.1. The hazard is
   physical, not topological, and it would break the "sibling worktree branches never
   move" invariant.
6. **Auto-remove or auto-prune abandoned worktrees.** Rejected: rbox syncs the user's Git,
   it does not garbage-collect it. `git worktree prune` only clears registrations that are
   already `prunable`, and those are already skipped (`apply.ts:116`). Removing a live
   registration is destructive and out of remit. Report, don't reap.
7. **Use `git branch --merged` to detect spent branches.** Rejected on the founder's own
   measurement: with squash-merge the tip is not an ancestor of `main`, so `--merged`
   reports nothing twenty minutes after the merge.
8. **Use per-commit `git cherry` without the synthetic range diff.** Rejected: a
   multi-commit branch squashed into one commit has no per-commit patch-id match. The
   whole-range patch-id is what makes the probe work.
9. **Keep the human in the loop with a new `rbox git resolve` verb for this shape.**
   Rejected as the primary answer: routine branch deletion is not a conflict, and any
   design that asks a human about it has not solved the founder's complaint. Design 176
   already tried the refusal-with-a-good-message approach here (`176:93-99`) and the
   result is the wedge in §1.2. *(v7 does un-refuse `keep-mine` for the genuinely two-sided
   shape — deleted here, advanced there, §3.6 case (b) — which is the opposite decision for a
   different question: that case is a conflict, and rbox does not pick sides in conflicts.)*
10. **Pin every auto-captured deletion under a recovery ref.** *Rejected in v2, un-rejected in
    v3 by ruling R3, and **rejected again 2026-07-24 by R4** — the full round trip is recorded
    in §12 Q3 and §3.7 because each turn was decided for a different reason.*
    - v2's rejection was **half wrong**: it argued the pin preserves one OID rather than the
      branch's history, which is true and irrelevant — one OID *is* the branch tip, and
      `git branch <name> <tip>` restores it. Preserving the tip was always the whole ask.
    - v2's rejection was also **conditional on a coincidence**: recovery via a *follower's*
      prune pin produces nothing in four ordinary cases (§7.1). R3 was right to kill that.
    - **R4's rejection is on different grounds and does not depend on either:** Git-side
      recoverability is not part of the durability contract, so a permanent at-rest cost
      (~900 hidden refs holding objects against `git gc`) plus a reaper plus a CLI verb buys a
      guarantee rbox does not owe — and one with an exception anyway, since the object may
      already have been `gc`-pruned before rbox looks. §3.0a.
11. **Any threshold, count or share of a repository's heads that stops an absence capture.**
    Rejected 2026-07-24 by R4 (§3.0a, §3.5). Every threshold has an under-threshold case that
    publishes, and the founder's workspace distribution (median 1 BASE head) makes any fraction
    of `N` a hair-trigger on the ordinary case. Recorded as a rejected alternative rather than a
    non-goal because two versions of this design shipped one and a third drafted an extension to
    it: the instrument is wrong, not merely mistuned.
12. **Retire the BASE member locally under a durable receipt, then publish the omission
    afterwards** — the shape of v2, v3, v4, v5 and v6, **rejected 2026-07-24 in v7 after five
    adversarial rounds.** This is the design's most expensive rejection, so the reason is stated
    structurally rather than as a list of bugs: the ordering creates a per-ref window in which
    durable local state says "deleted" while the wire still says "present", and **local state
    cannot decide, inside that window, whether an incoming assertion of the retired OID is its own
    stale echo or a newer writer's re-creation.** Every mechanism the rounds produced was an
    attempt to answer that undecidable question with more evidence — `record.advertised` (round 4:
    neither necessary nor sufficient), a durable omission intent plus the server's assigned
    sequence (round 5: sound, but requiring a reconciliation CAS before apply, a first-seen-section
    retention rule, a state-source lane and a lock bracket, and still leaving an undecidable row) —
    and each round closed the stated objection while the mechanism failed for a new reason. The
    window is not a bug in any of those answers; it is the primitive. Removing it removes the
    question: v7's capture publishes first, the ACK retires BASE, and no local state ever claims a
    deletion the wire has not heard (invariant 11). The full round-by-round evidence is §13.6, and
    the three residuals v7 pays instead are §13.4 items 6–8, and item 8 is the one v11 re-states
    rather than defends (§3.2c).
13. **Re-advertise the unproven ref inside the outgoing candidate** — v8's step G,
    **rejected in v9 on bundle coverage** (round-7 blocker 1, §3.2b). A full capture builds its bundle
    from the live refs, where the ref is absent, and a section asserting a tip its own
    `packChain + newest` cannot reach is unimportable on a fresh receiver. It is not repairable by
    feeding the tip into capture's inputs either: the deleted branch's tip is unreachable, **R4 ruled
    that the deleting device keeps no pin**, and after `git gc` the object is gone — so a mechanism
    whose correctness depends on retaining an object the design deliberately declined to retain is not
    a wiring gap. The replacement is step D's whole-repository defer, whose carried section's pack
    links are ones the wire has already carried. *(A reviewer who wants per-ref outgoing behaviour is
    asking for design 201, not for this.)*
14. **Decide "is this tombstone mine?" from the wire's authenticated authorship instead of a persisted
    attempt record** — **rejected in v9 on three verified counts** (§3.2c). The `deviceId` in the
    signed commit body is real, signature-covered and unforgeable
    (`src/engine/e2ee/commit.ts:45`, `:142-144`, `:175-180`; `session.ts:308-314`, `:350-360`), and
    plumbing it into the apply lane is only a four-hop local parameter pass
    (`e2ee-remote.ts:132-139` drops it today; `cfg.deviceId` is already in scope at
    `apply.ts:1326-1352`). But **per-commit authorship cannot attribute a tombstone**:
    `GitRefTombstone` is `{oid, ts, generation}` (`src/engine/types.ts:71-75`), and a peer that applies
    an omission and republishes **re-authors the entry from its own `advertised` diff** while a peer
    publishing anything else carries it forward, so the head's author is routinely not the tombstone's
    author (§13.4 item 9). And **there is no durable floor** from which "my unacknowledged publication"
    could be derived: the anti-rollback pin advances on the accepted POST before the caller's state CAS
    (`e2ee-remote.ts:839`), and `record.sourceSeq` is stamped by every pull source including a
    deferring one (`sync-state.ts:231`, `apply.ts:1314`). **v11 keeps this item after withdrawing the
    field it was contrasted with, and the point survives the withdrawal**: wire authorship is not a
    cheaper way to close §3.2c's residual, because it does not close it at all — it stops protecting the
    ref one peer commit after the lost ACK. The durable floor such a rule would need is exactly the
    thing §12 C3 tried four times to build and v11 declined to build.

## 9. Tests the implementation MUST write

### 9.1 Fixtures

**Mode (b) is constructible purely from the state shape in §1.2** — no live repository
history is needed:

- Build a `RepoRecord` with `base.refs[R] = X`, `pending.refs[R] = X`, `advertised`
  containing `R`, `branchBaseOrigins[R] = { v:1, oid:X, lineageHash:L,
  kind:"publisher-ack", sourceSeq:468, incomingKey:… }`, and `partial.appliedRefs` without
  `R`.
- Build a real on-disk repository containing every other ref but **not** `R`, and with no
  reflog for `R`.
- Assert **before**: `publishRefPlane` throws `branch transition does not match logical
  BASE pre-state` for `R` (pins today's behavior and the §2.2 trace), and
  `pendingSupersessionPreProbe` returns
  `carry / local repository lacks pending ref refs/heads/…`.
- Assert **after**, in the order the cycle performs them (§3.6):
  - the follow **holds** `R` under the new reason and **does not** reach `planBranchTransition`
    for it — assert no throw, no whole-repository deferral, and that every other ref of the
    section applied;
  - the same cycle's push takes one verify-only locked absence transaction for `R`, the
    pre-probe returns `maybe`, `provePendingSupersession` returns true, and
    `pendingSupersessionAckConverges` returns true **for the candidate that omits `R`**;
  - the published section omits `R` and carries a tombstone at exactly `X`, at one higher
    generation, not duplicated;
  - the ACK retires `BASE[R]`, drops its origin, clears `pending`, and releases the hold in that
    **one** state save;
  - the repository reaches `unchanged` on the next cycle with no deferral;
  - **no artifact and no keep-pin is created anywhere by any of this** — assert
    `refs/rbox-local/keep/*` and the A/Z artifact refs are untouched, so a future change that adds
    one has to say so (R4 §3.0a; v7 invariant 11).
- Assert the **ordering** requirement of §3.6 explicitly, as a negative: with
  `absentBranchProofs` suppressed, `pendingSupersessionAckConverges` must **refuse** the omitting
  candidate — pinning that the dry run and the real ACK compose the same retirement and that an
  omission alone still converges with nothing.
- **The apply-side hold, as its own unit.** With BASE positive at `X`, `R` absent, artifacts clear
  and the incoming section asserting `R = X`: assert `classifiedHolds` contains `R` before the
  transition loop runs **classified as `deletion-pending`**, that the ref-plane blocker carries that
  reason, that `heldRefs[R]` persists as the existing `local-commits` value, that the
  whole incoming section is retained as `pending[rel]` with the split in `partial`
  (`apply.ts:1426`, `:1448`) — this is round-5 blocker 2's requirement, and it is satisfied by
  *not* returning early — and that no `result: "reconciled"` disposition exists anywhere in the
  design.
- **The latent wedge (§2.3), on the push lane.** A repository with a stale positive BASE member,
  **no pending** and an **unchanged** remote must still publish the omission: assert the apply lane
  takes its unchanged shortcut at `apply.ts:873` (unchanged from today) **and** that the plan's
  trusted-fingerprint carry is not taken, because the O(1) absent-BASE-head predicate fires. The
  negative twin matters as much: a repository with no absent BASE heads must take the fingerprint
  carry with **no** new Git subprocess, no artifact scan and no ref transaction.
- **Case (b) — deleted here, advanced there (§3.6).** `base.refs[R] = X`, `pending.refs[R] = Y ≠ X`,
  `R` absent locally. Assert: the pre-probe returns **carry**, `provePendingSupersession` returns
  **false**, no tombstone is authored, `BASE[R]` is untouched, the ref is **held** (not thrown, not
  created at `Y`), and the repository records no whole-repository deferral. Then assert the two
  automatic exits — a subsequent section omitting `R` reaches case (c) and retires BASE; a locally
  re-created `R` reaches case (d) — and the human exit, **respecified in v9 against the binary
  design 177 actually shipped** (round-7 major 4): `rbox git resolve <repo> keep-mine` no longer
  refuses at `resolve-command.ts:657-666`; its discard report shows `branch:R` as **`not-subsumed`,
  not `indeterminate`** (`resolution-intent.ts:219`), so confirmation requires
  `--force-discard-incoming` and the flag requirement is asserted **in both directions**
  (`resolve-command.ts:693-703`); `discardedIncomingOids` enumerates `Y` and it is pinned when locally
  reachable (`plan.ts:1011-1022`, `class: "human"`); the resolution executes **synchronously in the
  same command, under the workspace mutex** (`resolve-command.ts:540`–`:1003`) through the ephemeral
  `GitResolutionRider` (`resolution-intent.ts:44-51`) — assert the rider reaches
  `GitPlanOptions.resolution` and that **no persisted intent is written anywhere**, which is the
  assertion that would have caught v8; the resolution capture omits `R` and carries a tombstone at
  `X` **and never at `Y`**; and BASE retires through the **`publisher-ack`** arm with
  `absentBranchProofs[R]` in the accepted ACK. Assert explicitly that `planManualBranchTransition` is
  **never called** and no A artifact is written — the `manual` arm is what v7 named and it is
  unreachable for this verb (`resolve-command.ts:604-617`, `:755-770`). Two negative rows complete it:
  a pre-ACK failure leaves `pending` intact and **persists nothing** (`plan.ts:995-1010`, `:1055`;
  `resolve-command.ts:1004-1017`), and **there is no automatic retry** — assert that a later daemon
  push, which carries no rider, does not execute the resolution.
- **The lost-ACK race, pinned as the ACCEPTED RESIDUAL it is again (§12 C3 WITHDRAWN, §3.2c).** v7's
  test asserted the destructive behaviour and named itself `…_v7_accepted_residual`; v8–v10 replaced it
  with five lifecycle rows for a field that four rounds falsified. **v11 restores an accepted-residual
  test and makes it stronger than v7's, because it pins the recovery and the non-recurrence rather than
  only the loss.** One fixture, five assertions, named for what it accepts
  (`…_prunes_a_same_oid_recreation_after_a_lost_ack_v11_accepted_residual`):
  - **The loss, asserted exactly once.** Accept the omission, drop the ACK CAS, re-create `R` locally at
    exactly `X`, then pull. Assert the ref **is pruned** and that this is the *only* fixture in the
    suite for which design 200 permits a local ref to disappear. Cite §3.2c in the test body so the day
    someone re-proposes a persisted field the test is what they have to argue with.
  - **The keep-pin exists, in the same transaction.** Assert `refs/rbox-local/keep/<X>` exists after the
    prune with a `tombstone`-class origin for `X` and `human`-class origins for every other OID that was
    in `R`'s reflog (`keep-pins.ts:635-654`), and assert it by **injecting a failure between prepare and
    commit**: either both the delete and the pins land or neither does
    (`branch-transition.ts:119`, `:301`). A pin that is merely created *after* the delete would pass a
    naive assertion and fail this one.
  - **BASE retires in that apply pass, so the loss does not latch.** Assert `record.base.refs[R]` is
    absent after the pass's state save (`apply.ts:1258-1275`), then `git branch R X` again and assert the
    second re-creation **survives** every subsequent pull and is published by the next capture. Then the
    row that pins the honest half: **drop that state save too** and assert the next pull retires BASE
    through §3.6 case (c) with no ref transition (`follow.ts:936`) — so a second occurrence requires a
    second crash *and* a second same-OID re-creation, and never happens on its own. This is the
    executable form of §3.2c's non-recurrence argument.
  - **The near misses are not losses.** Same fixture, re-create at `X' ≠ X`: assert the ref is **held**,
    that attestation hard-vetoes (`tombstone-attestation.ts:102-105` on the missing entry, `:109-111`
    on the equality), and that nothing is pruned. And with `R` left **absent**: assert no ref transition
    at all (`follow.ts:936`) and that BASE retires through §3.6 case (c)'s `pull-ref-transaction` arm.
  - **The negative control is now a state assertion, not a field assertion.** Assert that no state
    snapshot at any injectable point in the fixture contains any per-repository field about the
    unpublished deletion — this is §9.6's invariant-11 row applied to the one fixture that would most
    tempt someone to add one back.
  - **The peer variant, re-specified without the field.** Accept the omission, drop the ACK CAS, deliver
    a peer section re-creating `R` at exactly `X` at a **higher** sequence, then pull with `R` still
    absent locally. Assert this is ordinary §3.6 case (a): the ref is held under `deletion-pending`, no
    tombstone is re-authored from a remembered witness, the same cycle re-publishes the omission from a
    **fresh** witness, and the peer prunes on attestation. Assert explicitly that **no step-D defer
    occurs while L passes** — v10's version of this row required a defer, which was an artefact of the
    withdrawn field's push-lane withhold rule and is not what the code does without it.
- **Step D — the unproven absence (§3.2b, round-7 blocker 1).** For a repository with BASE positive at
  `X`, `R` absent locally and **no** passing L proof (run the row once per cause: L refused for lock
  contention, L refused because HEAD moved, W refused on rule 3, W refused on rule 7), assert: the
  repository is **deferred**; the published outgoing map for it is **the carried
  section by identity** — `pending[rel]` where a pending section exists (`plan.ts:536-543` / `:176`,
  and `gitIncomingKey` equality makes the normalizer install the pending bytes,
  `publisher-tombstones.ts:183-187`), otherwise `base[rel]` (`plan.ts:548-549`); that carried section
  still asserts `refs[R] === X`; **no** deletion tombstone at `X` is authored; `BASE[R]` is unchanged
  after the ACK **with its prior origin retained verbatim, not re-minted** (`base-composer.ts:363-367`,
  `:457-461` — v8's test text said "re-minted at the same OID" and that is not what the code does,
  round-7 minor 1); and no `absentBranchProofs` entry exists. Then the rows that make it a gate rather
  than a convention:
  - **The destructive-omission control.** With step D disabled, assert the same fixture publishes a
    section omitting `R`, and that a follower whose tip is **reachable from the incoming roots**
    deletes the ref *with no tombstone at all* — `tipOwnedByIncoming` returns owned, no hold is set
    (`follow.ts:743-751`), and the attestation check never runs (`follow.ts:990-998`). This is the
    finding; without this row the gate reads like belt-and-braces.
  - **The bundle-coverage row that killed step G, kept as a regression bar.** Build the same fixture
    with incremental capture **off** (`git.incremental: false` → `shared.ts:136`) and assert that no
    published section ever asserts a `refs/heads/*` ref whose object is absent from the union of its
    own bundle and its declared `packChain`. Run it a second time with `X` **unreachable and
    `git gc`-pruned**, and assert the design's chosen path still holds — the carried section's links
    are the previously published ones, so coverage does not depend on the local object store at all.
    This is the assertion any future per-ref re-advertisement proposal has to satisfy first.
  - **The forced-recapture row, because one `deferOne` branch drops rather than carries.** With the
    repository in the 422 force set and **no** pending section, assert step D still publishes the
    **BASE carry** and never `deferOne`'s section-dropping arm (`plan.ts:544-547`) — a drop would omit
    every ref of that repository, `R` included, which is the destructive outcome step D exists to
    prevent. Assert `captured` no longer names the repository and that `finalizedOutgoing[rel]` holds
    the carried section, so the bookkeeping half is pinned too.
  - **The `refScope` partition, asserted rather than assumed.** For a `scoped` repository (rule 9
    refusing), assert **no defer**: the section publishes with `R` omitted, and a receiving `dir` repo
    takes `deleteAbsent: false` (`follow.ts:609`) so the omitted head never enters `candidates`
    (`follow.ts:713`), never reaches `planBranchTransition`, and is not pruned anywhere.
  - **The latency, asserted as the accepted cost.** In a 24-head repository delete all 24 and make
    exactly one fail L. Assert **zero** of the 24 publish this cycle, that an unrelated commit on
    another ref of the same repository also waits, that the file plane still syncs, and that on the
    next cycle — with the contention gone — all 24 publish with tombstones in one section and the ACK
    retires 24 BASE members. Name the test for what it is
    (`…_defers_the_whole_repository_for_one_cycle_v9_accepted_latency`) so the day someone re-proposes
    a per-ref outgoing representation the test is the thing they have to argue with.
  - **A standing refusal is a standing carry, and it is reported.** Make one head fail rule 1 (no
    usable current-lineage origin) permanently. Assert the repository carries indefinitely, publishes
    nothing new, records a `deletion-pending` deferral with a repair line that does **not** promise
    self-clearance, and that `take-theirs` clears it while `keep-mine` still refuses. Name it for
    §13.4 item 10.
  - **The reason is `deletion-pending` on the CAPTURE lane, not `other` and not `artifact`** (round-8
    major 3). Over the real `planGitSections`, assert `plan().captureDeferrals[rel] ===
    "deletion-pending"` for a step-D defer, and assert it for a defer whose human-readable detail line
    **contains the word "capture"** — under `captureReason`'s regex order that detail classifies as
    `artifact` (`plan.ts:229`), so this row is what proves the typed reason is carried rather than
    re-derived. Then the surface: `status-view` displays *"finishing a branch deletion"* for that
    repository, and `firstReason` picks `deletion-pending` over a co-occurring `git-busy` and **under**
    a co-occurring `local-commits` (§5.2's rank argument). The apply-side `FollowProgress.blockers` test
    does not cover any of this — assert it on the push lane explicitly.
  - **The hidden provenance anchor — step D does not apply, and nothing is resurrected** (round-8
    major 2). Build a repository with `record.base.refs[R]` positive and `removedKey` set (drive it
    through the real remote-removal arm, `apply.ts:691-718`, so BASE is preserved under carry authority
    and `pending` is deleted), verify `state.lastSyncedManifest.gitRepos[rel]` is **absent**
    (`sync-state-model.ts:455-458`), then change the leftover's identity so the planner clears the
    removal memory and captures it as a re-add (`plan.ts:599-604`), and make `R`'s L proof refuse.
    Assert: **no** step-D defer; **no** `revertCapture` call with an `undefined` fallback (the
    type-level statement of the finding); the published outgoing map has **no entry** for `rel`; and no
    tombstone is authored anywhere for `R`. **Then run the state save, because that is where round 9's
    blocker 3 lives and where v10's version of this row stopped.** Drive both writers — the commit-free
    bookkeeping save (`push.ts:669`) and an accepted-ACK save (`push.ts:993`) — and assert after **each**
    that `record.removedKey` is still set, that `state.lastSyncedManifest.gitRepos[rel]` is still
    **absent** (`sync-state-model.ts:458`), and that `gitPlan.gitReposRemoved` still names `rel`. Then
    run one more cycle with the proof still refusing and assert the repository does **not** publish the
    stale pre-removal BASE section — the failure round 9 predicted. Assert the restored key is the
    **prior** `record.removedKey`, not the leftover's new identity, by clearing the refusal on the next
    cycle and asserting the re-add **does** publish. Then the positive control: with `removedKey` and
    `repoAbsent` both clear, the identical fixture **does** take step D and carries
    `pending[rel] ?? base[rel]`, which is now total. Run the second half of the gate too: a repository
    whose directory is genuinely gone takes `plan.ts:813-817`'s removal and **not** step D.
  - **No normalizer refusal exists, and the already-applied omission is not refused.** Hand
    `normalizePublishedGitSection` a candidate that omits a `refs/heads/*` ref present in
    `advertised.refs` with no matching locked proof and assert it **authors the ordinary tombstone at
    the advertised value and does not throw** — because that is the legitimate post-apply shape
    (round-7 blocker 2) and v8's proposed refusal would have wedged it forever. The gate is the
    plan-level structural assertion below, not a normalizer throw.
  - **The plan-level structural assertion, qualified by effective `refScope` — round-9 major 1.** Over
    the real `planGitSections`: no section in the published outgoing map **whose effective `refScope` is
    `all`** omits a `refs/heads/*` ref that `record.base.refs` holds positive without a passing proof in
    the same push. Assert it holds across a full capture, a forced 422 recapture, a basis fallback and a
    recompaction, so the property is proved where BASE is visible rather than where it is not. **The
    qualifier is required for the suite to be satisfiable at all**: the `refScope` partition row above
    asserts that a `scoped` repository publishes exactly that omission with no proof and no defer, so an
    unqualified pin contradicts it (round 9 found the two rows mutually unsatisfiable). Add the
    complementary assertion that no `dir` repository ever publishes a `scoped` section
    (`capture.ts:344`), so the qualifier cannot become an escape hatch.
- **§3.3a strict read.** Build a repository with one malformed loose ref (write
  `not-a-sha` into `.git/refs/heads/<b>`), then assert: `readAllRefs` returns `{}`;
  `readAllRefsStrict` returns `unreadable`; the witness refuses for the whole repository (both
  lanes: no hold **and** no publication); the locked second proof inside
  `commitPlannedBranchTransition` refuses; and a capture in that state does **not** emit a section
  advertising zero refs. Plus the positive twin: a freshly `git init`-ed repository (exit 1, empty
  stderr) returns `{ status: "ok", refs: {} }`.
- **§3.3b restore and unborn branch.** (i) `git checkout -b feature` with HEAD naming an
  absent `R` must never witness a deletion, asserted both at plan time and inside the locked
  transaction via the HEAD reservation. (ii) Replace `.git/refs` and `.git/packed-refs` in place
  from a snapshot, leaving the commonDir inode untouched, and assert `repositoryIdentityHash` is
  **unchanged** (this is the test that pins *why* rule 5 is insufficient) while the
  packed-refs inode signal refuses the capture. **(iii) The accepted residual, pinned as
  accepted — new in v4.** Do the same restore but preserve the `packed-refs` inode, advance its
  mtime, and retain a non-empty `logs/HEAD`: assert the capture **proceeds** and publishes the
  deletions. Name the test for what it is
  (`…_publishes_deletions_after_a_careful_in_place_restore_R4_accepted_residual`)
  and cite §3.0a in it, so the day someone adds a threshold the test is the thing that changes
  deliberately rather than the thing that mysteriously starts failing.

**Mode (a):**

- `git worktree add` a second worktree on branch `B`, once inside the workspace root and
  once outside it. Assert identical ownership classification (containment is not a
  filter), a per-ref hold only, no repository-level deferral when `B` is not the incoming
  HEAD, and that capture proceeds.
- Second cycle: assert the held-skip path is taken. Then `git worktree remove` (which
  changes no ref) and assert the skip bracket is invalidated by the worktree-registry
  digest and the follow re-runs.
- Assert the incoming-HEAD case still defers the whole repository (`follow.ts:709-711`
  unchanged).

**Squash equivalence:**

- Branch `B` off `main` with 3 commits; `git merge --squash B && git commit` on `main`.
  Assert `noDropProof` returns `would-drop` today and `proven` with
  `marker:"content-equivalent"` after.
- Negatives that must remain `would-drop`: an unmerged branch; a branch merged with a
  *modified* squash (one extra hunk); a rebased-but-not-merged branch; a branch whose
  content matches but under `GIT_NO_REPLACE_OBJECTS=0`-style object replacement; and a
  **whitespace-only** difference, which `--stable` would match and `--verbatim` must not.
- **The known false positive, asserted as known.** Apply the branch's work onto `D` and
  then revert it. The historical commit is still in `base..D`, so the probe **matches** and
  returns `proven`. Pin that as the current behaviour with the reason in the test name, so
  the day someone builds an exact result-state proof the test is the thing that changes
  deliberately rather than the thing that silently starts failing.
- Bound: a fork point beyond the walk cap returns `would-drop`, asserted by injecting a
  low cap rather than building a 5,000-commit fixture.
- **Destructive-transition bar (§4.3).** A ref whose incoming target is **absent** and whose
  tip is content-equivalent to a durable root must stay **held** — the waiver must not
  clear it. Same for a non-fast-forward target.
- Structural test (in the spirit of `base-composer-structure.test.ts`): the set of refs
  whose hold was waived by `content-equivalent` and the set reaching `planBranchTransition`
  with `afterOid === null` are disjoint, evaluated over the real publish loop.

### 9.2 Adversarial table

Table-driven, in the shape of `tombstone-attestation.test.ts:66-83`. The deletion witness must
**not** license a publication when any single one of these holds, with everything else valid:
existing A; existing Z / settled absence; existing P/K; foreign artifact; sibling worktree owns the
ref; receiver-equivalent collision group; origin missing; origin OID mismatched; origin lineage
stale; `git` busy; preflight failure; repository identity changed; **`show-ref` unreadable at plan
time**; **`show-ref` unreadable inside the locked transaction**; **`R` is the current HEAD symref
target**; **packed-refs inode changed or mtime regressed**; **`logs/HEAD` missing while BASE
recorded ≥ 1 head**; **the effective capture `refScope` is `scoped`** (rule 9); ref absent at plan
time but present when the locked transaction prepares; **the verify-only transaction is refused for
any reason** (lock contention, HEAD moved, transaction error). Each case asserts BASE unchanged, no
tombstone authored, no artifact written, and — for the rows that are also apply-side rules — that
the ref is *not* held on false evidence.

**Two structural rows, both about what the ACK may record — with v8 completing the first and
restating the second (round-6 minor 1).**

1. `composeRepoBase` must refuse an `absentBranchProofs` entry when any of §3.2's checks fails,
   asserted one row per check. v7 enumerated six and listed rows for five of them; round 6 was right
   that check 6 ("every `publisher-ack` shape check already at `:357-362`") is not a row, it is five.
   The full row list is therefore: wrong ref class; non-hex `priorOid`;
   `priorOid ≠ previousRefs[ref]`; the candidate still asserting the ref; a `scoped` candidate; **a
   `scoped` `lockedProof.effectiveRefScope` against an `all` candidate**; an accepted section with
   **no `refTombstones` entry at that OID** — the row that would otherwise be invisible; **a
   mismatched `lineageHash`**; **a mismatched `repositoryIdentityHash`**; **a malformed `sourceSeq`**;
   and **an empty or mismatched `incomingKey`**. Every refusal must leave `after = before` and
   produce a `mismatched-branch-proof` hold, i.e. a `pending` disposition, never a silent retirement.
   **Two of those inputs are constructor invariants rather than independent evidence, and the design
   says so instead of implying otherwise**: today's publisher-ACK composer only checks that
   `incomingKey` is non-empty — its equality to the accepted candidate is guaranteed by the sole
   caller, which recomputes it from `committed.gitRepos[relPath]` (`push.ts:969`) — and
   `lockedProof.effectiveRefScope` is populated from that same section (`push.ts:975`). So the sole
   caller is frozen structurally, in the spirit of `base-composer-structure.test.ts`: assert that
   every `publisher-ack` authority in `src/` derives `incomingKey` and `effectiveRefScope` from the
   *same* section object it passes as `candidate`. That is the assertion that makes the negative rows
   meaningful rather than decorative.
2. Assert that the outgoing section for a repository with any held ref is either the reused pending
   section (`publisher-tombstones.ts:183-186`) or a wholly local capture — **never a mixture**
   (re-homed from v4's §9.5). **v9 restores this row verbatim**, because v8 had to restate it as
   "never a *relayed* value" only in order to place step G inside the line, and **step G is
   withdrawn** (§3.2b). Step D composes nothing: `deferOne` installs a section this device already
   published or already carried, by identity in the pending case (`plan.ts:536-543`,
   `publisher-tombstones.ts:183-187`) and whole in the BASE case (`plan.ts:548-549`). So the strict
   "captured or carried, never mixed" partition is intact, `provePendingSupersession` never sees a
   value this device did not capture, §4.4's `gitCommitAncestry(Y, Y)` landmine stays barred, and this
   remains the property design 201 must replace with something stronger rather than weaken.

*(v3's table had a "circuit breaker tripped" row and a "no keep-pin created" assertion on every
row; both are gone with R4. v6's table had an "`R` is owed" row; there is no owed state in v7, and
its replacement is the "no artifact and no *retired BASE member* exists at any point" assertion
in §9.1.)*

### 9.3 Multi-writer

Reproduce the §3.4 interleaving as a test: W1 publishes `R = X`; W2 advances `R = Y` and
publishes; W1 deletes `R` locally and absence-captures. Assert W1's tombstone chain covers
`X` only, W2 **holds** `R` at `Y` rather than pruning, and W1 subsequently re-creates `R`
at `Y` through the ordinary creation path.

### 9.4 ~~Circuit breaker~~ — no tests, because there is no breaker

**Removed with R4 (§3.0a).** v3 specified a table over `(N, n)` — 24/24 trips, 24/6 trips,
24/5 captures, 304/25 trips, 304/24 captures, plus the two rows that made Q2b's cost visible.
None of it applies: absence capture has no repository-level count. Two tests replace the whole
table, and they are both *negative*:

- **No count anywhere.** Delete **every** BASE head of a 24-head repository at once and assert
  all 24 are captured, **zero A and zero Z artifacts** — v7's defining property is zero capture-side
  artifacts and §9.1 already asserts none is created, so v7's "one A artifact each" was a v6 leftover
  (round-6 minor 2) — no deferral, no human prompt. This is the direct inversion of v3's headline row,
  and it is deliberately loud: if someone re-introduces a threshold, this is the test that fails and
  forces them to read §3.0a and §12 Q2.
- **Per-ref independence — AMENDED in v9, and the amendment is the honest part (round-7 blocker 1).**
  v3–v8 asserted that one refused head never suppresses the other 23. **That is no longer true on the
  publish side and the AC says so**: step D defers the whole repository for the cycle (§3.2b), because
  no per-ref outgoing representation exists that its own bundle can cover. So the row splits in two:
  - **Per-ref independence survives where it is real — the apply lane.** In the same repository make
    one head fail rule 7 (HEAD symref) and assert it is held **per-ref**, that no whole-repository
    deferral is recorded for that cause, and that every other ref of the incoming section applies.
    The nine rules are per-ref and one refusal never turns into a whole-apply refusal.
  - **On the publish side it is replaced by a bounded-latency AC.** Make one head fail step L and
    assert **zero** of the 24 publish that cycle, and that all 24 publish in one section on the next
    cycle once the refusal clears. The AC is now *"one refused proof costs the repository one cycle,
    never a lost or unproven deletion"*, and §9.1's named latency test is its executable form. A
    *standing* refusal makes that carry standing (§13.4 item 10), which is the residual §3.2b states.

### 9.5 ~~Per-ref pending lane (P4)~~ — no tests, because P4 is cut

**Removed with R5 (§4.4).** v4 specified fifteen rows here — carried-chain bundle coverage,
basis filtering, chain-bound refusal, carried absence, safe-ref refusal, non-ref facet carry,
`carry ⇒ never settled`, the `equalOrFastForward(Y, Y)` trap, both halves of the tombstone
authorship bar, the self-echo, the `gitIncomingKey` binding, unproved-ref refusal, the
receipt-disabled fallback, and the no-hold regression pair. None of them applies: nothing in
this design composes a merged section.

**Three of those rows are re-homed rather than deleted, because they test properties that are
load-bearing *today*:**

- **The `equalOrFastForward(Y, Y)` trap** moves to §9.2's structural rows: the outgoing section for
  a held repository is either the reused pending section (`publisher-tombstones.ts:183-186`) or a
  fully local capture — never a mixture. That is the single assertion whose failure would re-open
  the whole class, and it is the one design 201 has to replace with something stronger.
- **The no-hold regression pair** — assert today's byte-for-byte carry is still taken when a
  repository has any held ref, and that a repository with none captures normally. This is a
  pure regression pin for the behaviour R5 preserves.
- ~~**The switch-disabled fallback**~~ — **WITHDRAWN in v9 (round-7 blocker 1).** v7 asserted that
  with `RBOX_GIT_ABSENCE_CAPTURE=0` a locally-absent BASE-positive head *"must still be **carried**,
  never omitted from the published section"*, and had no mechanism that produced it; v8 backed it with
  step G; v9 has no step G, and deliberately does **not** keep D live with the switch off (§3.2b,
  §11). **The row is replaced by its honest inverse:** with the switch off, assert that the section
  omits the head and that the pre-existing advertised-diff author publishes its tombstone with no
  proof (`publisher-tombstones.ts:108-121`) — i.e. assert the switch restores the **pre-200 binary
  exactly, bug included** — and assert the two things that stay ungated: `BASE[R]` does not retire (no
  `absentBranchProofs` exists) and the ref is still **held** rather than thrown at
  `branch-transition.ts:105`. An assertion that the switch produces *safer* behaviour than the binary
  it rolls back to is an assertion no kill switch can honour, and pinning the false one for two
  revisions is how round 6 and round 7 both found it.

Everything else in the old §9.5 is recorded in §4.4's superseded account as the failure
evidence, and belongs to design 201's test plan when it is written.

### 9.6 Surfaces and rig

- Doctor redaction grammar: extend `src/cli/design176-grammar-freeze.test.ts` for the new
  log lines so `redactGitLogLines` (`doctor-cmd.ts:171-215`) still recognizes and rewrites
  them. The grammar freeze is the *only* thing keeping free-text details out of an
  uploaded report (§5.1), so a new line that misses the `git-sync ` prefix is a privacy
  regression, not a cosmetic one — assert the new lines round-trip to closed enums.
- `rbox doctor` leftover-worktree section: assert it lists absolute paths locally, and
  assert `JSON.stringify(await buildDiagnosticsBundle(ctx))` contains **none** of them —
  not the full path, not the basename, not the parent directory name (§5.1). Plus a
  type-level assertion that the local-only projection is not assignable to the bundle's
  type, so the exclusion cannot regress into a runtime filter someone forgets.
- `rbox git deferrals` / `rbox status`: **two** new reasons need a
  `DEFERRAL_REASON_PRESENTATION` entry (`status-view.ts:287-305`) and a rank in
  `GIT_DEFERRAL_REASON_PRECEDENCE` (`sync-state-model.ts:149-153`; the compile-time totality
  proof at `:156-158` forces both) — `ref-read-unreadable` (§3.3a) and the deletion hold's
  **`deletion-pending`** (§5.2). The deletion hold deliberately keeps the **existing**
  persisted `heldRefs` value `local-commits` (`sync-state-model.ts:198`), so no state schema
  changes; assert both facts. **v8 adds five rows for `deletion-pending` (§5.2), because round 6
  showed the reason does not arrive by itself:**
  - **The copy actually reaches the user.** From a deletion-hold fixture, assert `rbox status` and
    `rbox git deferrals` print the `finishing a branch deletion` label and **never** the string
    `Local commits changed here.` — that sentence on a branch the user deleted is the finding.
  - **The precedence slot, asserted as an ordering rather than a constant.** A repository holding one
    deletion-pending ref **and** one genuine `local-commits` ref reports `local-commits`; a
    repository holding one deletion-pending ref **and** one `worktree-ownership` ref reports
    `deletion-pending`. Those two rows are the whole §5.2 argument, and they fail loudly if the slot
    is moved.
  - **`heldReasonOf` derives from the blockers, and is behaviour-identical today.** Assert the
    persisted deferral reason for every pre-existing combination of held reasons is byte-identical to
    today's, and that a repository whose only held refs are *indeterminate* still takes the fallback
    chain (`follow.ts:1031` emits no ref-plane blocker for those).
  - **Held-skip and the composer mapping.** Assert a deletion-pending-only attempt is held-skip
    eligible (`heldBlockersAllowSkip`) and produces **no** unmatched composer blocker (its
    `missing-branch-proof` hold is causally mapped). Then the downgrade twin: an *older* allowlist
    over the same persisted `attempt.blockers` returns false, so the repository runs the full follow —
    assert that this is the degradation, not a wrong action.
  - **The telemetry vocabulary and the deployed validator.** Assert `contract.ts`'s vocabulary and
    `apps/api`'s `SERVER_GIT_DEFERRAL_REASONS` contain the member, and add an API-side row proving
    `validateSyncState` **accepts** a packet carrying it — with the negative control that a packet
    carrying an unknown reason is still rejected wholesale (`telemetry-ingest.ts:324-330`). That
    negative row is what documents the release ordering in §11.
- **`gitStatus` (§3.3a), directly.** Table-driven over **both** execution paths (`opts.stdin`
  set ⇒ spawn; otherwise `exec`), with one row per failure shape: a clean exit; a non-zero exit
  with stderr; a non-zero exit with **empty** stderr; a signalled child; a `maxBuffer` overflow on
  stdout; a `maxBuffer` overflow on stderr; a `git` binary that does not exist (`ENOENT`); an
  `onStdoutChunk` callback that throws (both on `data`, `shared.ts:184-189`, and on the decoder's
  `end`, `:200-206`); a throwing `gitSpawnObserver` (`:145`); and a cleanup failure in the
  `finally` (`stdinFile.close()` / `fs.rm`, `:228-230`). Assert, for every row:
  - `exit` is the child's numeric status **only** when it ran to completion, and `null` for the
    signalled, `maxBuffer` and `ENOENT` rows — on both paths, from the same normalization rule;
  - **`gitStatus` never rejects**;
  - **`throw r.cause` is the identical error object today's `gitRaw` rejects with** — same
    constructor, same `message`, and same `code` *including its type*: numeric for a completed
    non-zero exit, the string `"ENOENT"` for the spawn-fault row, and **absent** for the spawn
    path's `maxBuffer` rows. Asserting the *type* of `code` is the point: it is what v4's
    normalized `number | null` result could not have preserved, and it is what makes this land
    as a refactor rather than a behaviour change.
  - the strict reader's three-line predicate over those rows: only `exit === 1` with empty
    stderr yields `{ ok, refs: {} }`; every `exit === null` row yields `unreadable`; and the
    marker never contains message text.
- **The verify-only locked absence proof (§3.2 step L), directly.** Assert it (a) commits nothing —
  no artifact ref, no reflog entry, no ref change, and a byte-identical `packed-refs`/`refs/`
  afterwards; (b) **refuses** when the ref exists, when HEAD's symref target changed since the
  reservation, and when another process holds `<ref>.lock`; (c) refuses rather than throwing past
  the caller, so a refusal drops the ref from the witnessed set and publishes nothing; and (d)
  leaves no A/Z artifact behind on either outcome — the assertion that distinguishes v7's proof from
  v6's receipt.
- `bun run rig`: two devices; device A holds a worktree on branch `B`, deletes a
  squash-merged branch `C` while the hold is outstanding, then removes the worktree.
  Assert both devices converge with **no** `rbox git resolve`, that `C` is gone everywhere,
  and that `B` and all unrelated work are intact.
- **Instruction for the merged rig scenario, now that P4 is cut — do this in the
  implementation PR, not in the design PR.** The acceptance gate
  `scripts/rig/scenarios/worktree-squash-lifecycle.ts` (merged as `ad0b3408`, #446, expected
  RED until this design lands) has one phase-1 assertion that no longer matches the ruled
  semantic and **must be relaxed before it is used as the gate**:

  | Assertion | Verdict | Action |
  |---|---|---|
  | `P2 no-escalation: capture must not be gagged (no carried pending section)` (`:374-376`) — requires `heldRecord.pending` to be absent while a divergent ref is held | **Wrong under R5.** Holding a divergent ref for a live worktree's lifetime *is* legitimate (§4.2), and the carried pending section is its bookkeeping. Only P4 could have satisfied this, and P4 is cut. | **RELAX to tolerate the *unchanged, whole* pending section while the hold lives** — and it must disappear once the worktree is removed and the branch is deleted. **Do NOT assert that the section "names only held refs"** (round-4 blocker 5): current apply deliberately stores the whole incoming section (`pending[rel] = remoteSec`, `apply.ts:1426` and `:1448`) and records the per-ref split separately in `partial.appliedRefs` / `partial.heldRefs`. Shrinking `pending.refs` to held refs would change the section's identity, partition a section, and drag in bundle/HEAD/non-ref semantics — the P4 problem, re-entering through a test assertion. If the rig needs to prove *which* refs applied, it inspects `record.partial`, which already carries exactly that. **v7 depends on this relaxation for its own deletion hold**, whose one cycle of carried pending is how the omission reaches the wire (§3.6). |
  | `P2 no-escalation: repo must not carry a whole-repo apply deferral while one ref is held` (`:371-373`) | **Keep, unchanged.** This is P2's actual deliverable — no whole-repo deferral surface for a non-HEAD hold. | none |
  | `P2 no-escalation: unrelated incoming ref applies while one ref is held` (`:377-379`) | **Keep, unchanged.** | none |
  | `P2 no-escalation: unrelated change on main must still propagate A→B past a live worktree hold` (`:391-393`) | **Keep, unchanged — and note in the scenario that it passes on merit *today*** via design 174 supersession (the transition is a fast-forward), which is the empirical evidence R5 rests on (§4.2 point 2, §4.4). | add the comment |
  | every phase-2 / post-deletion / soak assertion | **Keep, unchanged.** These are P1's gate and are what must flip from RED to GREEN. | none |

  Net: phase 1 asserts **propagation of unrelated changes plus no whole-repo deferral
  surface**, and *tolerates* the unchanged whole pending section while the hold lives. Phase 2
  remains the unrelaxed deletion gate. **If design 201 ever ships, the relaxation is reversed** —
  the stricter original assertion becomes 201's gate, which is why it is relaxed rather than
  deleted.
- **The publish-before-retire ordering, asserted as a property rather than a sequence of steps —
  new in v7, and these are the tests that would have caught rounds 3–5 before they were written:**
  - **No durable state that *retires or authorizes*, ever.** Snapshot `state.json` and every
    `refs/rbox-*` ref at every injectable failure point between the witness and the ACK, and assert
    that **no snapshot contains an A/Z artifact for `R`, no snapshot has `record.base.refs[R]` retired,
    and no snapshot contains a per-ref deletion field of any kind**. This is invariant 11 as an
    executable assertion, and it is the single test that makes the whole class of round-3/4/5 findings
    unreachable. **v8 narrowed the third clause away to make room for §3.2c's
    `absencePublicationAttempt`, and v11 restores it**, because §12 C3 is WITHDRAWN and the design
    persists nothing about an unpublished deletion (§3.2c). The unnarrowed form is the stricter and the
    simpler of the two, and it is the row that makes re-adding such a field a visible decision rather
    than a passing test.
  - **BASE and the wire never disagree about `R`.** Across the same injected failures, assert that
    `record.base.refs[R]` is positive exactly while the newest acknowledged section for that
    repository asserts `R`, and absent exactly while it omits `R`.
  - **The retirement is final.** After an acknowledged omission, assert no subsequent cycle
    re-authors a tombstone for `(R, X)` from the witness lane — the witness cannot hold, because
    BASE is absent — and that an incoming section asserting `R = X` at a higher sequence applies as
    an ordinary creation.
  - **Kill-switch off-state — restated in v9, because the old row asserted a contract no switch can
    honour (round-7 blocker 1).** With `RBOX_GIT_ABSENCE_CAPTURE=0`: assert no witness is computed, no
    locked proof is taken, no proof-backed tombstone is authored, **no repository is deferred by step
    D**, and no BASE member retires. Then assert the *true* rollback contract: the published section
    **omits** the locally-absent BASE-positive head and the pre-existing advertised-diff author emits
    its tombstone at the advertised value with no proof (`publisher-tombstones.ts:108-121`) — the
    pre-200 binary's behaviour, reproduced exactly. **And** assert the two ungated safeties: the
    apply-side hold still fires, so the repository degrades to a per-ref hold rather than to the
    `branch-transition.ts:105` throw and whole-repository defer, and received tombstones are still
    attested and pruned normally, since that path never reads the flag (§11).
- **What the rig asserts about recovery, after R4.** Device B, having pruned `C` under the
  tombstone, still pins the displaced OIDs — assert `refs/rbox-local/keep/<X>` exists on B with
  a `tombstone`-class origin for the authorized tip and `human` for the rest of `C`'s reflog,
  because that is **existing** design-116 behaviour and this design must not regress it. On
  device A — the one that deleted the branch — assert the opposite: **no** keep-pin and **no**
  artifact is created, and no `refs/rbox-local/keep/*` ref appears as a result of the deletion
  **capture** (R4, §3.0a; v7 invariant 11). The single-device variant therefore has no Git-side
  recovery at all, which is the accepted semantic and should be asserted as such rather than left
  to inference. **One row is added in v11, and it is the assertion §3.2c's first recovery path rests
  on**: in the lost-ACK same-OID fixture, where device A prunes under **its own** accepted tombstone,
  assert the pin **is** created on A — `refs/rbox-local/keep/<X>` with a `tombstone`-class origin, in
  the same prepared transaction as the delete — and state in the test why this does not contradict the
  row above: the capture writes no pin, the **prune** does, and here A is the pruning device. Assert the
  distinction by fixture rather than by comment, since the two rows would otherwise read as
  contradictory.
- **The file-plane promise, asserted in the rig.** In the same single-device run, assert that
  every file whose content lived only on branch `C` is still recoverable through the file plane
  at a prior sequence. That is the durability contract R4 rests on, and a rig that asserts the
  Git-side loss without asserting the file-side survival is asserting the wrong half.
- **Pull-only, asserted as a semantic rather than discovered as a bug.** Run a pull-only device
  (`RBOX_DAEMON_PULL_ONLY=1`, `daemon.ts:3459`; the push lane is never requested — `:1440`,
  `:1387`) and delete a published branch on it. Assert: the ref is **held**, no witness is
  published, no BASE member retires, no artifact is written, the repository keeps applying every
  other ref, and there is **no whole-repository stall**. That is the correct outcome — a pull-only
  device propagates nothing, by definition — and it is worth pinning because v6's apply-lane
  capture would have retired BASE locally and then stalled that repository's apply lane forever
  (§13.6, §10).
- Field validation before any release, per the design-169 dev-build-first rule: a dev build
  on the founder's Mac against the live wedge, with `state.json` snapshotted before and
  after.

## 10. Non-goals

- **Two-writer non-fast-forward divergence** — still reserved for design 173. This design
  touches the one-sided shape where BASE is positive and the ref is locally absent. **v7 makes one
  boundary explicit that v6 blurred:** a ref deleted here *and advanced by another writer* is
  two-sided divergence, so design 200 holds it, reports it, and offers `keep-mine`; it does not
  decide it (§3.6 case (b)). v6 decided it unilaterally in the peer's favour, which was only
  expressible with the early BASE retirement v7 removes. **v8 keeps the boundary and moves the exit
  onto a path that exists** — design 176's intent plus the publisher-ACK arm, with the one 176-side
  amendment named in §3.6 case (b); the `manual`-authority exit v7 described is unreachable for
  `keep-mine` and 176 itself already ruled that keep-mine never uses manual authority (`176:93-99`).
- **A durable record that *authorizes* an unpublished deletion.** Deliberately out of scope, and this
  is the design's central choice rather than an omission (§8 item 12, invariant 11, §13.6). The
  consequence — an unpublished deletion can be overtaken and lost — is §13.4 item 6. **v8 narrowed
  this non-goal by exactly one field and v11 restores it whole**: §12 C3 is **WITHDRAWN**, so design 200
  persists *no* record about an unpublished deletion, authorizing or withholding (§3.2c, §13.4 item 8).
  Four rounds of blockers inside the withholding form are the evidence that the non-goal was right as
  first stated. A future proposal for either form is refused by §8 item 12 together with §12 C2 and C3;
  the test that would have told them apart is §9.6's snapshot row, which returns to its unnarrowed
  form.
- **Completing a crashed *manual* resolution's BASE retirement.** A pre-existing owning A over a
  positive BASE (`follow.ts:875-893` committed, the `manual` composer CAS lost) is unchanged from
  today: the next apply either reconstructs it (`follow.ts:856-869`) or re-creates the ref and
  retires the stale artifact (`branch-transition.ts:136-152`). v6 built step A′ for that shape
  because its own capture path created it on every deletion; v7's never does, so the pre-existing
  manual window is recorded here rather than closed (§3.2a).
- **The per-ref pending lane / `pending ⊕ local` outgoing section (P4)** — a non-goal again,
  **CUT 2026-07-24 by R5** after three shapes failed three adversarial rounds (§4.4, §12 Q5).
  Parked as **[design 201](./201-per-ref-git-publishing.md)**; its honest prerequisite is a
  per-ref wire/state model, not another composition rule. This is a *cut with a recorded
  reason*, not a deferral of an agreed design.
- **A `keep-mine` verb that publishes a deletion rbox could not auto-prove.** New follow-up in v9.
  §3.2b's *standing* witness refusals (no usable origin, a stale owning A, an unborn-branch HEAD, a
  ref-database regression signal that does not clear) leave the repository's Git plane carrying its
  last synced section indefinitely (§13.4 item 10), and the exits that exist today are clearing the
  cause, re-creating the branch by hand, or `take-theirs`. Widening `keep-mine` to publish the
  omission under explicit human authority — `--force-discard-incoming` plus a refusal message that
  names the unprovable evidence — is the obvious next verb and it is what §2.4's missing "resolve it
  explicitly" was asking for. It is **not** shipped here because it hands a human the one authority
  §3.3 exists to withhold from the machine, which is a founder-level product question rather than a
  wiring gap, and because R4's posture is that human consent is the only override *for a decision the
  design has framed*. Framing it is the follow-up.
- **Batching the follow's ownership proof** onto `partitionOwnedByIncoming` — a design-174
  follow-up (§6).
- **A diagnostics redaction rule for absolute filesystem paths as a class** — needed before
  deferral messages may print worktree paths, and before the unredacted `ctx.checks`
  channel (`doctor-cmd.ts:535`) can be trusted. Scoped out here, recorded in §5.1.
- **Touching working-tree bytes.** Unchanged from `116:106-109`: the Git plane never writes
  working bytes, and nothing here introduces a worktree-writing Git command.
- **Any wire-format change.** Deletions travel as design-130 `refTombstones`, unchanged.
- **An exact result-state proof for P3.** The apply-then-revert false positive (§4.3) is
  left standing and pinned by a test. Replacing patch-id matching with a tree-restricted
  result-state comparison is a separate design; P3's structural bar is what makes leaving it
  acceptable.
- **A general strict-ref-read sweep.** §3.3a converts the sites where an empty map is read
  as deletion authority. The other ~20 `readAllRefs` call sites keep the lossy reader
  because an empty read there over-pins or over-holds; auditing them one by one is a
  follow-up, not this design.
- **Making `branchProofMatches` inspect `locked.currentRef` in general.** §3.3b (i) enforces
  it only where this design needs it — the witness's rule 7 and the locked transaction's HEAD
  reservation. `branchProofMatches` (`base-composer.ts:246-260`) is shared by every branch
  transition and tightening it changes paths this design has not analysed — a real gap, recorded
  rather than closed.
- **Retiring the pre-1.6.8 hold behaviour.** §3.0 accepts that a lagging device defers that
  repository's Git plane until upgraded. Making old clients converge without upgrading would
  need a wire or protocol change and is out of scope.
- **Any threshold, count or share of a repository's heads that stops an absence capture** —
  **removed by R4** (§3.0a, §3.5). Not "deferred": a future design that wants one has to re-open
  the product ruling first, because the ruling is that thresholds are the wrong instrument, not
  that this one was mistuned.
- **Any Git-side recovery guarantee, pin, or recovery command** — **removed by R4** (§3.0a,
  §3.7, §7.2). The durability contract is file history.
- **Publishing *anything* while a hold is outstanding, beyond what design 174's supersession
  already publishes.** A held repository keeps carrying its pending section byte-for-byte
  (`publisher-tombstones.ts:183-186`), so neither refs nor `head`, index, op-state nor config
  flow past a *divergent* hold. §4.2 states what does still propagate and why the residual is
  bounded. *(v7's deletion hold is the one hold that reliably clears in the same cycle, because
  its pending value is BASE's own — §3.6.)*
- **Three P4-only non-goals are retired with it**, and recorded here so their absence is not
  read as a widening of scope: an `advertised`-derived incremental-capture basis (it existed
  only to price P4's recurring upload); safe-ref (tag / `refs/stash`) carry semantics (there is
  no carry to give them); and publishing this device's own non-ref facets past a hold (nothing
  is published past a divergent hold at all). All three are constraints on **design 201**.

## 11. Rollout

Default-ON with kill switches, following the founder's standing rule and the existing
`gitPendingSupersedeEnabled` pattern (`pending-supersession.ts:26-27`). **v4's one deliberate
exception was P4, which shipped default-OFF behind a bake condition; R5 cuts P4 (§4.4), so
there is no exception left and the whole design ships default-on.**

| Switch | Default | Disables |
|---|---|---|
| `RBOX_GIT_ABSENCE_CAPTURE=0` | on | **The whole push-side lane** — §3.2's witness evaluation, its locked absence proof, the proof-backed tombstone, **§3.2b step D's defer**, and the ACK's `absentBranchProofs`. It does **not** disable the apply-side hold, §3.6 case (c)'s converged retirement, or anything that consumes a tombstone already on the wire. Off ⇒ the publication path is the pre-200 binary's, bug included. See below. |
| `RBOX_GIT_CONTENT_EQUIV=0` | on | P3 (falls back to ancestry-only) |
| `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` | on | P2's held-skip eligibility **only** |
| `RBOX_GIT_OWNERSHIP_NO_ESCALATE=0` | on | P2's "no whole-repo defer for a non-HEAD ownership hold" |
| ~~`RBOX_GIT_PENDING_MERGE`~~ | — | **Gone with P4 (R5).** No switch, no bake condition, no staged flip. |

**Two switches for P2, corrected in v3.** v2 listed one switch and described it as disabling
P2. It does not: held-skip eligibility and the no-escalation change are independent code
paths, and a single `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` leaves the deferral-behaviour change
live. A kill switch that does not kill what the rollout section claims is worse than none,
because it is what someone reaches for at 2am.

**`RBOX_GIT_ABSENCE_CAPTURE=0` restores the pre-200 binary, and v9 stops claiming more than that
(round-4 blocker 4, round-6 blocker 1, round-7 blocker 1).** v5 had the rule right in prose and wrong
in its table; v6 needed an eight-row table naming every read site, because with a durable receipt on
disk the switch could invert a receipt (disable A″ ⇒ `follower-protocol.ts:88`/`:106` drop logical
BASE ⇒ the ordinary `null → X` creation passes `branch-transition.ts:105` ⇒ `:136-152` destroys the
receipt) or wedge a repository permanently (disable A′). **After v11 this design creates no durable
state at all, so there is nothing for the switch to strand.** Four sites:

| Site | Reads the flag? |
|---|---|
| §3.2 steps W, L, T, K — the witness, the locked proof, the proof-backed tombstone, the ACK's `absentBranchProofs` | **Yes — off ⇒ none of them happens.** |
| **§3.2b step D — the unproven-absence defer** | **Yes, and v9 reverses v8's answer deliberately.** With no witness evaluation there is no defer trigger. Keeping D live with the switch off would defer **every** repository holding a phantom BASE head the instant someone flips the switch — a switch whose off-state manufactures wedges is worse than no switch, and 2am is exactly when it gets flipped. |
| §3.6 step 1 — the apply-side per-ref hold, and §3.6 case (c)'s converged retirement | **No.** Both are non-destructive and neither depends on authoring: the hold prevents a resurrection and a throw, and case (c) retires BASE only from a wire that *already* omits the ref under design 130's pre-existing `pull-ref-transaction` authority. Gating them would trade a per-ref hold for today's whole-repository wedge, and in case (c) for §2.3's latent wedge. *(v10 had a third member here — §3.2c's withholding — which is WITHDRAWN.)* |
| P1b's structural rule (§3.2), design 130's tombstone attestation, §3.3a's strict reader and `gitStatus` | **No.** P1b cannot supersede anything without a passing proof the switch already suppressed; attestation consumes tombstones *other* devices published and predates this design; the readers are plumbing shared with older paths. |

**The rollback contract, restated for the third and last time — this version is the one code can
honour.** *Flipping the switch off restores the pre-200 publication behaviour exactly.* A device
mid-flight has nothing to finish (its last cycle either published or did not); with the switch off the
capture **omits** a locally-absent BASE-positive head and the **pre-existing** advertised-diff author
publishes a tombstone for it with no proof input of any kind (`publisher-tombstones.ts:108-121`),
while the apply lane still holds the ref per-ref instead of deferring the repository. It does **not**
promise that no unproven deletion is published: that author predates design 200, is not behind this
switch, and is the behaviour of the binary the operator just rolled back to. **v7 asserted the
stronger contract and round 6 falsified it in code; v8 asserted step G made it true and round 7
falsified step G. The contract itself was the overclaim.** §9.1 and §9.6 assert the true one,
including the row that the omission *is* published with the switch off.

**No new persisted field at all, and that is the whole downgrade story.** v6 added
`record.absenceOmission` with a window to defend; v7 removed both; v8 added
`record.absencePublicationAttempt`; **v11 removes that too (§12 C3 WITHDRAWN, §3.2c)**. What remains
additive is the **reported reasons** (§5.2, §9.6), while `heldRefs` keeps `local-commits` verbatim for
the deletion hold. Downgrade, in each direction:

- **Older client, newer state.** There is no new record field to preserve or strip. It renders an
  unknown deferral reason as
  `UNKNOWN_GIT_DEFERRAL_PRESENTATION` (`status-view.ts:280-285`, `:306-308`,
  `ambient-status.ts:191-198`) and treats an unknown persisted `TypedBlocker` reason as not
  held-skip-eligible, i.e. it runs the full follow. Every degradation is over-work or vaguer copy,
  never a wrong action. **The real risk in this direction is not the new state at all**: a pre-200
  binary re-publishes an unproven omission for the §2.3 shape on its own, because its normalizer has
  no proof input — which is the behaviour of the binary the user chose to run, and which §3.2b's gate
  is precisely what a newer binary stops doing.
- **Newer client, older state.** Every deletion publishes on its own evidence, as it does on a fresh
  record; an older client never published one (its capture omits what its P
  lacks and its own ACK dry-run refuses the mismatch, so it wedges exactly as today), and it processes
  a newer client's tombstone through the unchanged design-130 attestation path.
- **Older *server*, newer client — the one real ordering constraint (§5.2).** `validateSyncState`
  rejects the whole sync-state telemetry packet on an unknown deferral reason
  (`apps/api/src/telemetry-ingest.ts:324-330`). So `SERVER_GIT_DEFERRAL_REASONS` must be extended and
  **`apps/api` promoted to `production` before the CLI release that can emit `deletion-pending` is
  tagged** — two different pipelines (`docs/DEPLOYMENTS.md`), one order. This is a release step, not a
  code guard, and §9.6 pins both halves with an accept row and an unknown-reason reject row.

**Landing order — corrected again in v5, simplified in v7.**

1. **P2 + reporting.** Held-skip eligibility with the worktree digest, no whole-repo
   escalation for non-HEAD holds, `rbox doctor` leftover-worktree section behind §5.1's
   local-only projection. No authority change; pure performance and UX. **Not a precondition
   for anything**, but it lands first because it is the cheapest real improvement, it makes the
   founder's machine observable while the rest bakes, and step 3 reuses its per-ref hold
   machinery (§4.2).
2. **P3.** Content equivalence in `noDropProof`, with §4.3's destructive-transition bar.
   Cascade reduction only. Independent. It stays second because it shrinks the held set P1 is
   first exposed to on the founder's machine — four of ten worktree branches, §1.1.
0. **The API's deferral-reason vocabulary, promoted to `production` first.** One member added to
   `SERVER_GIT_DEFERRAL_REASONS` (`apps/api/src/telemetry-ingest.ts:118-122`) and to `contract.ts`'s
   mirror, merged and promoted **before** any CLI release that can emit `deletion-pending`. It is
   listed as step 0 rather than a footnote because the failure mode is silent: an older deployed API
   rejects the *entire* sync-state packet, so every device on the new CLI vanishes from the deferral
   view (§5.2, §11's downgrade story). Nothing else in this design depends on it, and it depends on
   nothing.
3. **P1 + §3.2 + §3.2a + §3.2b + §3.2d's P1b + §3.3a's `gitStatus` + §3.3b + §3.6 + §5.2.** The
   authority change and everything that makes it safe: the nine-rule witness, the verify-only locked
   proof, **step D's unproven-absence defer**, the proof-backed exact
   tombstone, the ACK's `absentBranchProofs` and its checks, the shared
   artifact-disposition reader, the strict ref read on its new structured runner, the
   restore/unborn-branch rules, and the apply-side hold under its own `deletion-pending` reason, with
   case (b)'s narrowed `keep-mine` refusal and case (c)'s converged retirement. These ship
   **together**, and the reasons are tighter than v6's because there are fewer parts:
   - a P1 without §3.3a is a fleet-wide deletion waiting for one corrupt loose ref;
   - a P1 without the locked proof of step L is §8 item 4's torn read, which is why that
     alternative was rejected for five revisions;
   - a P1 without §3.2's exact tombstone authorship publishes deletions no follower can attest,
     so the ref is never pruned anywhere and §3.0's semantic silently fails (round-4 blocker 2);
   - a P1 without the ACK-side check that the accepted section carries that tombstone can record a
     retirement for an omission the fleet will ignore — the same failure one layer down;
   - a P1 without §3.6's hold either throws (today's wedge) or lets the same cycle's pull re-create
     the ref before the push can publish its absence, which is the resurrection loop v6 documented
     as its own defect 2;
   - P1b without the exact `record.base.refs[R] === pending.refs[R]` binding retires a value this
     device never held (round-2 blocker 1);
   - **a P1 without step D publishes deletions it could not prove** (round-6 blocker 1) — a bare
     omission is destructive on its own for a follower whose tip is reachable from the incoming roots,
     so D is not a refinement of the tombstone gate but the gate itself. It also has to be D rather
     than a per-ref re-advertisement, because a re-advertised tip's objects may not exist locally at
     all (round-7 blocker 1, §3.2b);
   - **a P1 accepts one race rather than defending it**: the lost-ACK same-OID re-creation
     (round-6 blocker 2) is §3.2c's stated residual, pinned by the accepted-residual test in §9.1 and
     by §9.6's keep-pin row rather than by a persisted field — four rounds of blockers inside that
     field are why (§12 C3 WITHDRAWN);
   - **a P1 without §5.2's reason tells a user who deleted a branch that "local commits changed
     here"**, and silently loses held-skip if the reason is added without its two allowlist sites
     (round-6 major 1) — and adding the reason without §5.2's **complete** inventory fails typecheck in
     two places, aborts the whole shell-prompt sidecar in one, and silently un-asserts two tests
     (round-7 major 3).

   Validated on a dev build against the live wedge before any CLI release. **This is the last
   step**: with P4 cut there is no step 4, and everything inside step 3 is one unit.

*(v3's and v4's step 4 was P4 in two sub-steps with a four-part bake condition, an explicit reverse
migration and a `record.advertisedCarried` residual to read defensively on downgrade. **All of it is
removed by R5.** v6's step 3 additionally contained the omission intent, its arm/consume/reconcile
cycle, and A′/A″ — **all removed by v7**, §13.6. v8 adds no step and no bake condition: step 0 is a
server-side vocabulary entry, and everything else lands inside the existing step 3.)*

**Correction retained: "P2 must precede P1" was wrong.** `publishRefPlane` already returns a
per-ref held set — built per ref and returned both as a set (`follow.ts:1041`) and as a map
(`follow.ts:1047`) — and `apply.ts:1447` merely ignores the detail by consuming `held.length`.
P1 never needed P2. The ordering above is a *validation* sequence, not a dependency graph.

**Wire compatibility.** Nothing here changes the wire *format*, its validator, or where a
published section's values come from: deletions travel as design-130 `refTombstones` and every
section is still captured from local refs. **One wire-content change, unchanged from v6 and stated
plainly rather than buried:** an omission may now carry a tombstone at the exact value BASE holds
even when this device's last acknowledged section did not advertise that value (§3.2, round-4
blocker 2). It is an entry of exactly today's shape, produced by exactly today's normalizer,
consumed by exactly today's attestation path — and it is the entry the deletion was always supposed
to carry; without it the omission is unattestable and no follower ever prunes. *(v4 had to carve out
P4 as a wire-content change of a different kind — relayed values inside a merged section. **That
carve-out is gone with R5**, and its absence is still the single largest reduction in this design's
blast radius.)*

## 12. Decisions

All six of v1's open questions were ruled by the founder on **2026-07-24**. Five further
rulings (**R1–R5**) were issued the same day, and four of them *change* earlier rulings. They
are kept here as a decision record rather than deleted; the questions are stated as they were
asked, followed by the ruling and its reasoning, in date order with each supersession named.
**No founder question is open.** v6 added two *designer* choices below (C1, C2) that a founder
ruling could reverse; v7 added C3 as reserved, **v8 TOOK it (2026-07-25)**, and **v11 WITHDRAWS it the
same day** after four review rounds inside its lifecycle. They are recorded as choices, not as
rulings — and C3's arc is the record of a designer choice that was tried, instrumented and reversed on
evidence rather than quietly dropped.

**The five later rulings, R1–R5 (2026-07-24), in one place, in the order issued:**

| | Ruling | Changes | Where |
|---|---|---|---|
| **R1** | Mass-deletion breaker trips if **either** leg trips, whichever comes first — `n ≥ 25 OR n ≥ 25% of N` | **Supersedes Q2's `max()` form**, which was arithmetically incapable of tripping on any repository under 100 heads. **Itself superseded by R4.** | §3.5, Q2 below |
| **R2** | Deletion is not instantly fleet-wide; state the version floor honestly | Narrows Q1's stated semantic without changing the decision | §3.0, Q1 below |
| **R3** | The **deleting** device pins the commit locally for 90 days | **Reversed Q3** and retired Q3a. **Itself superseded by R4.** | §3.7, §8 item 10, Q3 below |
| **R4** | **rbox promises FILE history, not Git history.** No thresholds, no pins, no recovery command. | **Supersedes Q2, Q2b and R1** (the breaker) and **Q3 and R3** (the pin), and retires §7.2. The most consequential ruling in the design, because it decides how much machinery a *wrong* capture deserves — and, in v7, how much machinery an *unpublished* one deserves (§13.4 item 6). | §3.0a, §3.5, §3.7, §7.1, §7.2, Q2/Q2b/Q3 below |
| **R5** | **P4 is CUT from design 200.** The per-ref pending lane is parked as design 201. | **Reverses Q5's in-scope ruling** on new evidence — three shapes failed three adversarial rounds, and the rig showed the propagation win P4 was justified by already works. Removes the design's only default-OFF step, its only bake condition, its only positive cost, and its only *relayed-value* wire-content change. *(v6 re-added one local-only persisted field and one exact-value tombstone; **v7 removes the field again** and keeps the tombstone — §12 C2, §13.6.)* | §4.4, §4.2, §6, §9.5, §10, §11, Q5 below |

**Three designer choices a founder ruling could reverse — recorded here so they are visible, not
buried in §3.6.** None is a founder ruling. C1 and C2 were taken in v6 to close round-4 blockers;
v7 keeps C1, withdraws C2, and adds C3 as *reserved*. **v8 TOOK C3 (2026-07-25)** on round-6 evidence
that the window it declined to close is not one cycle wide and needs no peer — and **v11 WITHDRAWS C3
(2026-07-25)** on rounds 6–9's evidence that its lifecycle could not be made correct. C1 and C2 follow
from R4's ruled semantic and are places this design chooses to lose a *deletion* rather than a *ref*;
**C3 is the one place it accepts losing a *ref* — one pointer per occurrence, on one device, from a pin
the delete's own transaction writes** (§3.2c, §13.4 item 8), which is the trade R4 explicitly authorizes for the Git plane.

| | Choice | Why | What reversing it would cost |
|---|---|---|---|
| **C1** | When another writer's assertion of a ref races this device's unpublished deletion of it, **fail toward never destroying the other writer's ref**: apply the assertion, do not re-publish the omission (§3.6 rows 5–6, case (b)) | Under R4 the durability contract is file history: a lost deletion is one keystroke to repeat and the content survives regardless, while a destroyed ref is unrecoverable on the Git plane. **v7 makes this cheap where v6 made it expensive** — with no durable owed state, "do not re-publish" is the default rather than a decision that needs evidence | Reversing it (re-assert the deletion on doubt) restores round-4's ABA verbatim. There is no third option that is decidable from local state — §3.6, and v6's two rejected alternatives, now recorded in §13.6 |
| **C2** | ~~One new local-only persisted field, `record.absenceOmission`~~ — **WITHDRAWN in v7** | v6 needed it to answer *"is this device still the reason the wire says `X`?"*, a question only the early-BASE-retirement window can pose. v7 does not open that window (invariant 11), so the question does not arise and the field has no reader | Re-adding it means re-adding the window, which is what §8 item 12 rejects on five rounds of evidence. The narrower, additive form is C3 |
| **C3** | ~~Do not add a pre-POST arm to close the lost-ACK-CAS re-creation race~~ — **TAKEN 2026-07-25 (v8), reversing v7's reservation; lifecycle AMENDED in v9 and RE-AMENDED in v10; WITHDRAWN 2026-07-25 (v11). The reservation v7 wrote stands again, for a different reason than v7 gave.** | v7 declined the field because the window looked *one pull cycle wide and closed from the wire*. **Round 6 falsified that**: no peer is needed — a purely local `git branch <R> <X>` between step L's `commit` and a lost ACK reaches it — and the post-ACK refusal comes from a **retired logical BASE** (`tombstone-attestation.ts:109-111`), which a lost ACK is precisely the state that lacks. So the shape is real and it deletes a ref, and v8 was right to stop calling it exotic. **What v11 rejects is not the finding but the defence.** The field was `record.absencePublicationAttempt = { omitted: Record<ref, { priorOid, attemptedSequence, attemptedGitIncomingKey }> }`, armed in the push's existing pre-POST state save, read only to withhold. Rounds 6–9 put **twelve** blockers inside its lifecycle — round 7 killed all three of v8's transitions (B3 the drop test, B4 the overwriting arm, B5 the unrelated clear), round 8 killed all three of v9's (B1 the survivor latch, B2 the absence-equality clear, M1 the missing clear-site inputs), and round 9 killed both of v10's (B1 same-ref generations, B2 the legacy/degraded writer) while showing its hard-cap overflow **recreated** round 8's latch (B4). No round left it correct. | **Reversing the withdrawal means re-proposing a durable local record of an unpublished deletion, which is §8 item 12 plus C2 above: five rounds killed the authorizing form and four killed the withholding form.** What v11 pays instead is stated, not hidden: §3.2c's residual — a crash in the accepted-POST→state-CAS window **plus** a same-OID local re-creation before the next pull prunes that ref **once** — with three recovery paths (the tombstone-prune keep-pin, **verified** to land in the same `git update-ref` transaction as the delete; the HEAD reflog for a checkout-shaped re-creation; file history, R4's contract) and a non-latching proof (the prune's apply pass retires `BASE[R]`, `apply.ts:1258-1275`, and the next pull retires it regardless if that save is lost). Full statement in **§3.2c**; §9.1 has the accepted-residual test and §9.6 the keep-pin row. The next honest move for this race is design 201's per-ref wire model, not a smaller field |

**0. What does rbox promise about Git history? — RULED 2026-07-24 (R4).**
*Not one of v1's questions; it is the question underneath Q2 and Q3, and answering it retired
both.* **The file plane is the durability contract; the Git lane is convergence assistance and
is best-effort on history.** Reasoning, verbatim: *"some math is just not gonna prevent it;
there's always a gap."* Every threshold has an under-threshold case; every under-threshold case
publishes. Buying a partial defence with permanent complexity is the wrong trade when a
complete defence exists one plane over. Stated in full, with the recovery sources and the
accepted residual, in **§3.0a**.

**1. Publish the deletion, or re-materialize the branch from the fleet?**
*RULED 2026-07-24 — **publish**.* This confirms the design's own recommendation, so nothing
changed except its status: it is now a stated decision in the body (**§3.0**) rather than a
question, because §3.1–§3.6, §4.4, §5 and §7 all rest on it. The semantic is explicit:
**deleting a branch on one machine removes it fleet-wide; `git branch -D` means what it says
inside a synced workspace.** The rejected alternative (retire BASE locally, let the remote
re-create the branch) is non-destructive and wrong — it makes branch deletion a permanent
no-op on every synced machine, and the founder's development loop's last step is exactly
branch deletion. §3.0 records the three consequences that follow: deletion is authoritative
and therefore must be receipted; receivers still hold a veto; and what happens when a capture
is *wrong* is a product question, answered by R4 in §3.0a. *(v3's third consequence was "the
objects survive the prune for a bounded window"; R4 replaced it.)*

***AMENDED 2026-07-24 by R2 — "fleet-wide" is scoped to v1.6.8 and newer.*** The decision is
unchanged; its *statement* was overclaimed. **§3.0 is the authoritative version** and carries the
verification: design 130's tombstone attestation first shipped in **v1.6.8**, commit `04c2aff8`
(#297), confirmed with `git tag --contains`; a pre-130 device meets a squash-deleted branch with
`tipOwnedByIncoming` returning `unowned`, classifies it `local-commits` and **holds**, and cannot
resurrect it either because its whole-repository pending gag stops it re-advertising. So the
honest semantic is **eventually** fleet-wide: a lagging device keeps the branch and defers that
repository's Git plane until it upgrades. The founder's phrasing was "1.7.x and newer" — a safe
superset and the right thing to tell a user; the design records the verified constant so a future
skew argument does not start from the wrong one.

**2. Circuit-breaker shape and thresholds.**
*~~RULED 2026-07-24 — defer at `max(K = 25, F = 0.25)`.~~*
*~~SUPERSEDED 2026-07-24 by R1 — defer at `n ≥ 25` OR `n ≥ 25% of N`.~~*
**SUPERSEDED 2026-07-24 by R4 — there is no breaker and there are no thresholds.**

> **RULED 2026-07-24 (R4): no thresholds.** *"Some math is just not gonna prevent it; there's
> always a gap."* The durability contract is file history, and Git history is not promised, so
> a partial defence is not worth permanent complexity. Recorded in **§3.0a**; the removal and
> what is kept from the analysis are in **§3.5**.

The two withdrawn rulings are kept below in compressed form because each records a fact worth not
re-deriving. **Why the first was withdrawn:** `max()` encodes a conjunction —
`n ≥ max(K, ceil(F·N))` ⟺ `n ≥ K ∧ n ≥ ceil(F·N)` — so the larger leg dominates, and with `K = 25`,
`F = 0.25` the absolute leg dominates every repository under `K/F = 100` heads. Verified
counterexample: a **24-head repository whose entire ref set is deleted** yields `max(25, 6) = 25`, and
`24 ≥ 25` is false, so a total wipe did not trip. v2's prose described the intent correctly and the
arithmetic backwards; under `OR` the mapping inverts and becomes correct. **The precedent claim is
also corrected:** design 108's shape is not a `max` — `pushMassDeleteTrips` is
`deletes ≥ min ∧ deletes·100 ≥ pct·baseCount` (`policy.ts:22-35`), a genuine conjunction, defensible
at file scale where `min = 1000` against hundreds of thousands of files leaves the fraction dominant
and inverted at ref scale. What this design takes from 108 is its **posture** — publishing-side,
refuse before any encrypt/upload/commit work, fail closed, human consent as the only override — not
its boolean operator. Design 44's pull-side guard (`policy.ts:11-15`, `pull.ts:276`) is the wrong
precedent on both counts.

> **~~2b. Small-repository hair-trigger under the `OR` form.~~ RULED, then MOOTED — both on
> 2026-07-24.** `n ≥ 0.25·N` trips on one deletion in a 4-head repository, and the founder's
> workspace has **median 1** BASE head (110 repos, ~203 heads, 84% at four or fewer), so R1 taken
> literally defers nearly every repository on the first routine `git branch -D` — the exact loop this
> design exists to automate. It was **ruled** as the guarded form `n ≥ 25 OR (N ≥ 20 && n·4 ≥ N)`
> with the 5–19-head window accepted, and is now **mooted by R4**: no breaker, no guard to place, and
> the size distribution is irrelevant to the predicate. **A total-absence extension**
> (`… || (a === N && N ≥ 2)`) was drafted for round-2 blocker 3 and is **WITHDRAWN, not deferred** —
> recorded only so nobody re-proposes it as new. The founder's position is that thresholds are the
> wrong instrument, not that this one was mistuned; the shape it targeted is §3.0a's accepted residual
> and §9.1's deliberately-named accepted-residual test.

**3. Safety pin for auto-captured deletions?**
*~~RULED 2026-07-24 — no pin, conditional on tombstone recoverability being stated first.~~*
*~~REVERSED 2026-07-24 by R3 — the deleting device pins the commit locally for 90 days.~~*
**SUPERSEDED 2026-07-24 by R4 — no pin, and not conditional on anything Git-side.**

> **RULED 2026-07-24 (R4): no pin.** The first ruling said "no pin" for the wrong reason (a
> follower's prune pin, which does not exist when nobody prunes). R3 then said "pin" for a
> reason that was correct but bought a permanent cost — ~900 hidden refs holding objects against
> `git gc`, plus a reaper and a CLI verb. R4 says "no pin" for the right reason: **Git-side
> recoverability is not promised, file history is.** §3.0a lists what a wrongly-propagated
> deletion is recovered from and states the residual; §3.7 records the removal; §7.1 keeps the
> analysis, which is still the reason neither earlier answer should come back.

**§8 item 10 is un-struck**: pinning every auto-captured deletion is a rejected alternative
again, now on R4's grounds rather than v2's.

The R3 reasoning is compressed here, because its *facts* are still true and its *mechanism* claim is
the one a future reviewer will re-propose. **Why R3 reversed the first ruling:** that ruling's premise
was recovery from a *follower's* prune pin, and the pin is created **by the prune**
(`follow.ts:947-949` → `prepareTombstonePrunePins`, `keep-pins.ts:635-654`), so it does not exist
whenever nobody prunes — a single-device workspace, both devices deleting before either applies the
other's tombstone, a device that never received the ref, or a fleet still on pre-1.6.8. **Why R3 was
itself superseded:** it bought a permanent at-rest cost (~900 hidden refs holding objects against
`git gc`) plus a reaper plus a CLI verb, for a guarantee rbox does not owe and one with an exception
anyway (the object may already have been `gc`-pruned). R3's *observation* stands and is recorded in
§7.1: giving the A path the keep-refs the P path always had (`base-artifacts.ts:114-118`) closes an
asymmetry rather than inventing a mechanism — and §7.1 also records why the asymmetry is deliberate.
Two consequences R3 had to carry are gone with it: the already-pruned-object exception, and that
90 days meant nothing until `expireTombstoneKeepPins` (`keep-pins.ts:434`) got a caller.

> **~~3a. Single-device workspaces.~~ RETIRED 2026-07-24 by R3, and still retired under R4.** Q3a
> asked whether to pin only when the account has one device. Moot twice over — R3 fixed the general
> case, R4 removed the pin for everyone — and recorded rather than deleted because "pin only for
> single-device accounts" is exactly the narrow optimization a future reviewer re-proposes. The answer
> is that the multi-device cases (concurrent deletion, never-delivered ref, old followers) are just as
> unpinned, and that the plane rbox promises is not this one.

**4. Settling window?**
*Not separately ruled; the design's own recommendation is taken as decided (2026-07-24).*
**One locked double-proof suffices — no N-cycle window.** Absence capture proves the ref
absent at plan time (§3.3 rule 2) and again inside the ref transaction while it holds its
locks (§3.3 rule 6, `branch-transition.ts:301-321`). The reasoning is unchanged from v1:
Git deletion is atomic and irreversible, so a settling window cannot observe anything the
second proof does not — a ref that reappears between the two proofs fails the locked check
and is left untouched, which is precisely the outcome a window would produce, only sooner.
A window would add latency to every convergence in exchange for no additional evidence.

**5. Per-ref pending lane — in scope now, or follow-up?**
*~~RULED 2026-07-24 — **IN SCOPE NOW**, overruling the design's own recommendation of a
follow-up.~~*
**SUPERSEDED 2026-07-24 by R5 — CUT.** The original recommendation stands after all, and the
follow-up is **[design 201](./201-per-ref-git-publishing.md)**.

> **RULED (R5): P4 is out of scope.** The reversal is on **new evidence**, not a re-weighing of
> the same facts: **(a)** three shapes failed three adversarial rounds, each on a *different*
> closed invariant — which is the signal that the model is on the wrong plane rather than one
> fix away — and **(b)** the propagation win Q5 was ruled on **already works today** via design
> 174 supersession, proved by the merged rig scenario's phase-1 assertion. §4.4 has both, with
> the code. What P4 uniquely bought is narrower than Q5 assumed — publishing past a *divergent*
> held ref without carrying the pending section — and is bounded by the worktree's lifetime,
> consistent with the founder's own ruled semantic. Its real fix is a per-ref wire model: a
> different design, likely 2.0-era alongside design 163.

**What the cut removes from this design**, listed because each was a v3/v4 commitment: the only
default-OFF step (`RBOX_GIT_PENDING_MERGE`) and its four-part bake condition; the only new
persisted field (`record.advertisedCarried`), and therefore the only reverse migration and the
only downgrade-defensive read; the only positive cost (a recurring capture-encrypt-upload per
cycle while a hold is outstanding); the only wire-*content* change; two proposed invariants and
fifteen test rows. §6, §9.5, §10 and §11.

**What v3/v4 wrote here that is superseded, kept so the record is legible:** that the landing
order inverts because P1b must precede P4's per-ref omission (true, but there is no P4 to
sequence — P1b's receipt rule stays on its own merits, §3.2); that P4's held-ref-aware ACK stops
it forging the provenance P1 trusts (*retired in v4* by "carry ⇒ never settled", which is what
round 3 then killed); that P2 must precede both (*wrong* — `follow.ts:1041`, `:1047`); and that
the cost analysis no longer nets negative (**it does again**, §6).

**6. Surfaces.**
*Not separately ruled; taken as decided (2026-07-24).* **§5.1 is the authoritative version** —
this entry is the decision, not a second copy of the reasoning.

- **`rbox doctor` gains a leftover-worktree section** — count, and per entry the branch, the full
  absolute path, `prunable`, and whether it holds a synced ref. With ten worktrees
  `path.basename` (`apply.ts:118`) is useless precisely because they are all named after their
  branches, so it only repeats the branch the message already prints.
- **Deferral messages do not print absolute worktree paths yet**, and the blocker is a redaction
  gap, not a UX preference: `redactGitLogLines` is a fail-closed **grammar** allowlist that
  rewrites recognized `git-sync ` lines into closed enums (`doctor-cmd.ts:171-215`), with two
  holes — non-Git-family lines before the first Git-family line pass through verbatim (`:183-185`)
  and `ctx.checks` is uploaded **unredacted** (`:535`). ***AMENDED in v3:*** "local paths are
  fine" is a statement about the *channel*, not the display — a `DoctorCheck` carrying a worktree
  path **is** an uploaded path — so §5.1 specifies a typed local-only projection that never
  reaches `buildDiagnosticsBundle`, plus a path-free bundle projection. Closing the general
  redaction rule is scoped out (§10) and is the precondition for putting the path in the deferral
  message, which remains the better message.


## 13. Codex review record

Nine rounds, kept so the next reviewer starts from here rather than re-deriving. Every code
claim in all nine tables was re-verified against the worktree before being folded in, and
codex's mis-citations are corrected rather than propagated.

**Read §13.10 first.** Round 9 (§13.10) is the current state and it is where the design's biggest
subtraction is argued: rounds 6, 7, 8 and 9 put **twelve** findings inside one mechanism, §12 C3's
persisted field, and v11 withdraws the field rather than repairing it a fourth time. §13.9 (round 8)
and §13.8 (round 7) are the two rounds immediately behind it, and their C3 rows are marked **MOOT in
v11** in place rather than deleted, because the sequence of failed repairs *is* the argument. Round 6
(§13.7) is the round that first **validated** the mechanism — the design-130 amendment's ACK fencing
and L's zero-OID Git semantics both held — and its blocker 2 is the finding v11 now accepts as a
residual rather than closes. Round 5 (§13.6) is why the mechanism looks the way
it does, and it is not a list of five fixes: its
three blockers and one major, taken together with rounds 3 and 4, are the evidence that the
*mechanism* was wrong rather than incomplete, and §13.6 records the re-frame that removes it plus a
sweep of **all 34** findings from rounds 2–5 under the new shape. Read §13.5 (round 4) next, because
its two structural lessons survive the re-frame — `record.advertised` is a push-time snapshot and
not a lease on the remote value, and an omission that carries no attested deletion is a silent
failure — and then §13.3 (round 3), where the design's largest scope decision was made: two of its
three blocking items were P4's, and the accumulated evidence across those rounds is what ruling
**R5** acted on (§12 Q5, §4.4). Rounds 1 and 2 are preserved as written — including rows whose
*answers* R5, round 4 or v7 later changed, which are marked in the later tables rather than
rewritten in place, so the record shows what was believed when.

### 13.1 Round 1 — what was caught and how it was answered

**Verdict: NOT-ALIGNED — 7 blockers, 4 majors.** Round 2 confirmed 8 of the 11 closed. Compressed to
one row per finding; **where R4, R5 or v7 later changed the *answer*, the row says so** rather than
being quietly rewritten, and §13.6's sweep is the authoritative current disposition.

| # | Finding | Where it landed |
|---|---|---|
| B1 | Q3's no-pin premise is false even multi-device — recovery depended on a *follower* pruning | Codex was right; the premise is not restored. v3 answered with R3's pin, **R4 answers at the product layer instead** (§3.0a, §3.7, §7.1, §12 Q3) |
| B2 | P1 turns a ref-read error into fleet-wide deletion (`readAllRefs` maps any `show-ref` failure to `{}`) | **Resolved and still live in v7** — the strict reader, its exact predicate, and its mandatory sites, reproduced empirically (§3.3a) |
| B3 | P4 destroys P1's provenance invariant — carried values acquire `publisher-ack` origins | **Moot under R5**; the invariant is self-maintaining again (§3.4, §7 invariant 1) and the observation is design 201's first constraint (§4.4) |
| B4 | P1's control flow does not clear the field wedge — the unchanged shortcut precedes the hook, and retiring BASE mid-pass lets the section re-create the branch | v3–v6 answered by moving reconciliation above `apply.ts:873`; **v7 answers by moving the deletion to the push lane**, where the shortcut is irrelevant, and by holding the ref so no pass can re-create it (§3.6) |
| B5 | BASE provenance proves possession, not the cause of absence — an in-place ref restore preserves identity | §3.4 stops claiming otherwise; HEAD-symref rejection and ref-database signals added; the breaker that was named as the primary detector is **gone (R4)**, leaving detection hardening plus an accepted residual (§3.3b, §3.0a) |
| B6 | P3 has a false positive and can authorize deletion | **Partly resolved, honestly scoped**: `--verbatim` closes the whitespace half, the apply-then-revert false positive is left standing and pinned by a test, and the boundary is structural (§4.3, §9.1) |
| B7 | P4's accepted-ACK state machine is undecided | v3's `partially-superseded` → v4's mutual exclusivity → round-3 B1 → **moot under R5** (§4.4) |
| M8 | P2/P3 do not fix wedge (a) as claimed | **Accepted; claims corrected** — `follow.ts:732` precedes `:734`, so the "already convergent" filter is a no-op (§4.2, §4.5, §5) |
| M9 | Rollout ordering and rollback independence overstated | **Accepted; corrected** — P2 demoted from precondition (`follow.ts:1041`, `:1047`), P2's switch split in two (§11) |
| M10 | 1.6.6 skew is behavioural, not schema | **Resolved by R2**, floor corrected to **v1.6.8** (`04c2aff8`) from the verified tag (§3.0, §12 Q1) |
| M11 | Recovery window not discoverable | **Moot under R4** — no pin to enumerate; the eviction/scrubber/schema facts are kept in §7.2 because they constrain any future surface |
| M12 | doctor privacy boundary — the bundle uploads `ctx.checks` unredacted | **Resolved for the new surface** via a typed local-only projection; the pre-existing exposure stays scoped out (§5.1, §10) |

### Corrections to codex's own citations

Kept because a wrong line number propagates further than a wrong argument.

- `push.ts` is `src/cli/sync/push.ts`, not `src/cli/sync-git/push.ts`. `advertisedRefs:
  section.refs` is at **`:971`** (cited as `:961`); the `publisher-ack` authority block is
  `:962-972`.
- The unchanged shortcut's condition is **`apply.ts:873`** (cited as `:869`, which is the
  start of the comment above it).
- `buildDiagnosticsBundle` begins at `doctor-cmd.ts:523`; the unredacted field is
  **`checks: ctx.checks` at `:535`**, and `redactGitLogLines` is applied at `:527`.
- The `proven` short-circuit is **`follow.ts:815`** (cited as `:807`).
- The pending-supersession fast-forward test is `equalOrFastForward` at
  **`pending-supersession.ts:202`**, defined at **`:179-181`** (cited as `:198`, the start of
  the enclosing block).
- `plan.ts`'s pending/BASE rule is `gitBaseAfterCommit` at **`:1155-1167`** (cited as
  `:1150`, the start of its doc comment).

### 13.2 Round 2 — `REVIEW-200-R2-CODEX.md`

**Verdict: NOT-ALIGNED.** Round 2 confirmed 8 of the 11 round-1 findings closed, left 3 not-closed
(R1 B5 → accepted by R4; R1 B7 and M9 → P4, moot under R5), added **4 blockers and 5 majors**, and
verified both the six corrected citations in §13.1 and that `04c2aff8` first appears in `v1.6.8`.
Current dispositions are in §13.6's sweep; the one-line record:

| # | Finding | Disposition |
|---|---|---|
| B1 | P1b can supersede a pending value the receipt does not witness — an A for BASE/local `X` authorizes omitting another writer's unseen `Y` | **Closed in v4 and carried into v7**, re-sourced: supersession requires the retired value to equal the pending value, `record.base.refs[R] === pending.refs[R]` (§3.2). The mismatch **carries**, and §3.6 case (b) states what happens next |
| B2 | Pin+A crash recovery misses the unchanged path — rule 3 excludes an existing A, the in-follow recovery needs the incoming section to omit `R`, and the shortcut returns first | v4 answered with step A′; **v7 makes the shape unreachable** — no artifact is written before publication (§13.6). The finding's second half (`keep-pins.ts:425-428` is generic filter logic with no production caller) is moot with the pin |
| B3 | Sub-20-head restore hole: an in-place refs restore with retained `logs/HEAD` bypasses both heuristics and the guarded breaker cannot trip below 20 heads | **Not closed — accepted.** The total-absence leg was drafted and **withdrawn by R4**. §3.0a states the residual and its recovery sources; §9.1 pins it as a named accepted-residual test. **The one round-2 blocker answered by a product ruling rather than by code** |
| B4 | P4 partial settlement is not closed under ACK failure or incremental capture | v4 redesigned it, round 3 killed the replacement, **R5 cut P4** — all three shapes and their exact failure mechanisms are in §4.4 |
| M1 | Strict-read stderr taxonomy has no stable API | **Resolved and still live**: `gitStatus` with `exit: number \| null` plus the carried `cause`, so `gitRaw` is byte-identical by construction (§3.3a) |
| M2 | Carried absence has no representation | v4's sorted `carriedRefs` list; **moot under R5** |
| M3 | `pinned:false` and deletion provenance have no persisted shape | **Moot under R4.** The analysis is kept in §7.2 because `parseKeepPinOrigins` rejects unknown fields, making any extension a downgrade hazard |
| M4 | Tombstone-pin expiry can starve forever | **Moot under R4**, recorded honestly: `expireTombstoneKeepPins` still has no production caller and deliberately does not get one (§7.1) |
| M5 | Q2b remains normatively contradictory | **Resolved by sweep to a different answer than the finding assumed** — every occurrence now says *no thresholds* (§3.5, §7, §9.4, §12 Q2/Q2b) |

### 13.3 Round 3 — `REVIEW-200-R3-CODEX.md`

**Verdict: NOT-ALIGNED.** Round 3 confirmed **10 of round 2's 17 findings closed** (four of them
"narrowly"), correctly recorded the R4-accepted and R4-mooted ones as such, and added **6 blockers and
5 majors**. Its shortest blocking list had three items and **two of the three were P4's** — which is
what made **R5** the right answer rather than a fourth composition rule. Current dispositions are in
§13.6's sweep; the record:

| # | Finding | Disposition |
|---|---|---|
| **B1** | P4's self-echo re-gags every captured branch after one emit: the bar keeping carried values out of BASE keeps captured ones out too, so `heldRefs[D] = "local-commits"` (`follow.ts:895`) after the first emit | **Moot — P4 cut (R5).** §4.4 keeps the mechanism because it is design 201's central problem |
| **B2** | A′ is not idempotent across a second crash or a failed push: after BASE retirement, this device's own stale advertisement re-creates `R` and the creation destroys the receipt | v5 answered with step A″ + the `owed` predicate; **v7 removes the window instead** (§13.6). Codex's A→Z compaction citation was **corrected** (`local-absence` does not settle — `apply.ts:1944-1946`, `:1957`) while the finding stood regardless, because `follower-protocol.ts:88`/`:106` drop `R` from `logicalBaseRefs` and `branch-transition.ts:136-152` retires either artifact inside the creation |
| **B3–B6** | Four independent ways the merged section `M` is unshippable: not operationally v1.6.8-importable; excludes BASE prerequisites its own chain lacks; exhausts `MAX_PACK_CHAIN` under repeated self-echo (falsifying the 7-day bake narrative); and can be made invalid by a receipted pending HEAD | **Moot — P4 cut (R5)**, all four kept verbatim in §4.4 as design-201 prerequisites. B6's rule is *not* mooted and is restated there: any model that omits refs from a section must separately check that section's own `head` |
| **M1** | P1b and A′ define no usable settled-Z receipt projection — `absenceWitnesses` is populated only from live A entries | v5 answered with one projection over both arms; **v7 deletes the need** — its consumers read `record.base.refs[R]` (§3.2a). Codex was right that a literal v4 implementation "can miss the normal Z receipt and carry forever" |
| **M2** | A′'s locked proof is not connected to state-save revalidation (`apply.ts:1899-1919` handles only two authorities) | v5/v6 answered inside that bracket; **v7 has no proof in it** (§13.6). **One thing codex did not name is still live**: that site reads `readAllRefs` and compares `null !== null` for an absent witness, so it is a mandatory strict-read site (§3.3a) |
| **M3** | `gitStatus` has two incompatible fault contracts, and `gitRaw` cannot then recreate today's exact `message`/`code` | **Resolved and still live** — nothing rejects, every failure is data, `cause` is carried (§3.3a) |
| **M4** | The carried/captured partition is not total | **Moot — P4 cut**, completely: no surviving mechanism partitions a section's refs. The underlying requirement (an explicit universe over pending ∪ BASE ∪ local ∪ held, all four classes, sorted-unique validation on anything gating destructive authorship) is design 201's (§4.4) |
| **M5** | P4's reverse migration does not state when carried authorship state becomes safe to clear | **Moot — P4 cut**, and v7 adds no persisted field of its own either (§11) |

**Two round-3 verdicts worth reading as warnings rather than closures**, because both were "CLOSED
**narrowly**" and both narrowed onto P4: *"Mutual exclusivity removes the impossible hybrid BASE… P4
itself still fails for independent reasons below"*, and *"Keeping BASE wholesale closes the invalid
algebra. It does not make the replacement P4 state machine achieve its goal."* Three rounds of closing
the *stated* objection while the feature failed for a new reason each time is the pattern the
founder's standing rule names: **a model that breaks on a new exotic input every round is on the wrong
plane.** That is the reasoning R5 acted on for P4 — and, two rounds later, the reasoning v7 acts on
for the absence mechanism itself (§13.6).

### 13.4 What is deliberately left standing

1. **P3's apply-then-revert false positive** (§4.3). Not a founder question — a scope
   decision, taken deliberately: an exact result-state proof is a separate design, and P3's
   structural bar against destructive transitions is what makes leaving it acceptable. If a
   reviewer disagrees that the bar is sufficient, P3 should be cut rather than expanded.
2. **The in-place-restore residual** (§3.0a, round-2 B3). Accepted by ruling, bounded by the
   file-history contract, pinned by a named test. A reviewer who finds another uncovered restore
   shape has found an instance of an accepted residual; what would be a genuine blocker is a
   shape in which rbox publishes a deletion for a ref whose absence it never observed under the
   strict read *and* under the locked transaction, or for which no current-lineage origin proves
   prior possession.
3. **`branchProofMatches` still ignores `locked.currentRef` in general** (§3.3b (i), §10).
   Enforced only where this design needs it — rule 7 and the locked transaction's HEAD
   reservation; the general gap is recorded, not closed.
4. **`ctx.checks` is still uploaded unredacted** (§5.1, §10). This design must not add to that
   exposure, and does not; closing it is a separate change.
5. **A divergent worktree hold still keeps the pending section carried, for the worktree's
   lifetime** (§4.2, §4.4, R5). Deliberate, and the largest thing this design chooses not to
   fix: unrelated fast-forward work still propagates via design 174 supersession, everything
   clears at deletion via P1/P1b, and the honest fix is a per-ref wire model —
   **[design 201](./201-per-ref-git-publishing.md)**. A reviewer who finds a shape where this
   *loses* work rather than *delaying* it has found a blocker; a reviewer who finds another
   shape where it delays publication has found this item.
6. **An unpublished deletion can be lost.** Between the local `git branch -D` and the ACK that
   records it, any peer assertion of that ref wins: while BASE is still positive the ref is held and
   the omission retries (§3.6 rows 1–2, 6), but once the retirement has landed rbox never
   re-publishes it, so a later assertion applies as an ordinary creation and the branch comes back
   (§3.6 row 5). **This is v7's central trade and it is deliberate** (§12 C1): v2–v6 defended the
   deletion across that window with A′, A″, an `owed` predicate, a persisted intent and a sequence
   reconciliation, and five rounds showed that the defence cannot be made sound without deciding an
   undecidable question. A lost deletion is one keystroke to repeat and the file plane holds the
   content (R4, §3.0a). A reviewer who finds a shape where this loses *work* rather than a
   *deletion* has found a blocker; a reviewer who finds another shape where a deletion needs
   repeating has found this item.
7. **A branch deleted here while another writer advanced it holds until a human or a change
   resolves it** (§3.6 case (b), §5). rbox does not pick a side in a two-sided divergence — §10 has
   reserved that for design 173 since v1 — so the ref holds, the repository keeps carrying its
   pending section while it holds, and `rbox git resolve keep-mine` is un-refused so the human exit
   exists. v6 decided this case unilaterally in the peer's favour, which required the early
   retirement §8 item 12 rejects. The bound is the same as item 5's and the fix is the same one:
   design 201.
8. **One race survives, and v11 states it instead of defending it: a lost ACK CAS plus a same-OID local
   re-creation before the next pull deletes that ref once** (round-6 blocker 2; §3.2c, §12 C3
   **WITHDRAWN**). v7 recorded this as an accepted residual on the grounds that it needed a peer to
   prune, re-create at the identical OID and publish inside one cycle. Round 6 showed the honest shape
   is smaller and worse: a purely **local** `git branch <R> <X>` in the unlocked interval between step
   L's `commit` and a lost ACK reaches the same state, and `checkTombstoneAttestation` then *authorizes*
   the prune for the plain reason that a lost ACK is the state in which logical BASE was never retired
   (`tombstone-attestation.ts:109-111`). **v8 TOOK C3 and closed it with a persisted withholding field;
   rounds 6, 7, 8 and 9 then put twelve blockers inside that field's lifecycle and no round left it
   correct, so v11 deletes the field and accepts the race.** This is therefore the **one** item in this
   list where what is lost is a *ref* rather than a *deletion* — and it is bounded on all four sides:
   the re-creation must be at **exactly** the tombstoned OID (any other value hard-vetoes,
   `tombstone-attestation.ts:102-105`); it must land before the pull that applies the omission; the
   OID is **pinned by the same `git update-ref` transaction that deletes the ref**
   (`follow.ts:947-949` → `keep-pins.ts:635-654`, spliced at `branch-transition.ts:119`), so `git
   branch <R> <oid>` recovers it; and the loss **does not latch**, because the prune's own apply pass
   retires `BASE[R]` under `pull-ref-transaction` authority (`apply.ts:1258-1275`) — the race's own
   precondition — and the next pull retires it regardless if that save is lost too, so a second
   occurrence needs a second crash *and* a second same-OID re-creation. Under R4 — file history is the contract, and the
   file plane is untouched — that is the proportionate answer, and four rounds of failed defences are
   the evidence for it. §9.1's `…_v11_accepted_residual` test pins the loss, the pin, the
   non-recurrence and the near misses; §9.6 pins the pin on the *self*-consuming device specifically.
   *(v9's extra sub-case — a current-branch re-creation holding until a checkout move or `keep-mine` —
   goes with the field: without a forced hold there is no whole-checkout defer to be stuck in.)*
9. **Design 130's tombstone lane is not causally ordered across writers, and this design does not
   fix it** — verified in v6 and unchanged: chains are merged only from `advertised` ∪
   `pendingRetention` ∪ `candidate` (`publisher-tombstones.ts:74-86`) and `advertised` is written
   only at push ACK (`push.ts:962`), so a peer that applies an omission and then republishes a
   captured section **drops** the chain and **regresses** `refTombstoneGeneration` (a `Math.max`
   over those three sources, `:73`). Two consequences are recorded rather than closed: re-creating a
   branch at an exactly-tombstoned OID is not expressible on the wire (carrying the chain forward
   would make the re-creation prune itself under `tombstone-attestation.ts:91-110`), and nothing in
   this design may rest on cross-writer generation ordering — after v7 nothing does, because no
   decision reads a generation at all. Fixing it is a design-130 change with its own attestation
   question.
10. **An absence rbox cannot prove keeps that repository's capture deferred — one cycle for a transient
    refusal, indefinitely for a standing one.** New in v9 (round-7 blocker 1, §3.2b step D). The
    transient half is pure latency and it is bounded: `<ref>.lock` contention, a HEAD move, a busy
    repository or a pending `p-repair` all clear, and the next cycle publishes all 24 deletions in one
    section. The standing half is the residual: rule 1's missing current-lineage origin, rule 3's stale
    owning A, rule 4's sibling worktree, rule 7's unborn-branch HEAD and rule 8's non-clearing
    ref-database signal each leave the repository carrying its last synced section and publishing
    nothing new on the Git plane until the cause goes. **This is §13.4 items 5 and 7's class with a
    third member** — an unreconcilable ref forces a whole-section carry — with the same bound (it clears
    when the ref clears) and the same honest fix (per-ref publishing, design 201). Three things keep it
    from being mode (b) again: **the file plane is untouched** and file history is the durability
    contract (R4, §3.0a); it is **reported**, under `deletion-pending` with a repair line that no longer
    promises self-clearance (§5.2) — **and v10 makes that reporting real rather than nominal**, because
    round-8 major 3 found the capture lane had no producer for the reason and would have displayed
    `other` or `artifact` instead (§3.2b, §5.2's new inventory row); and it is **non-destructive** — the
    carried section keeps asserting
    exactly what BASE asserts, so nothing anywhere prunes. A reviewer who finds a shape where this
    *loses* work has found a blocker; a reviewer who finds another standing refusal has found this item.
    A reviewer who thinks the standing half needs a machine exit is asking for §10's `keep-mine`
    follow-up or for design 201.

*(v4's item 5 here was "P4's recurring-capture cost is unoptimized on purpose" — **gone with R5**,
§6. v6's items 6 and 7 were A″'s bounded delay and the undecidable racing-publication row — **both
gone with v7**: there is no suppression to delay a peer with, and no undecidable row, because the
question that was undecidable is no longer asked. Items 6, 7 and 8 above are what v7 pays instead,
and they are named so a reviewer can tell a residual from a regression. **v8 closed item 8 with a
persisted field and v11 re-opens it as a stated residual**, which is a reversal recorded in §12 C3 and
§13.10 rather than a regression.)*

### 13.5 Round 4 — `REVIEW-200-R4-CODEX.md`, and how v6 answers it

**Verdict: NOT-ALIGNED.** Round 4 confirmed the landing order, the three-shape P4 record, A′/A″
predicate disjointness, the `gitStatus`/`gitRaw` carried-cause contract, the strict-reader
predicate and its fourth site, and this design's own correction that `local-absence` does not
settle A→Z. It then added **5 blockers, 2 majors and 3 minors — every blocker inside the
absence-capture machinery**, and its shortest list had four items. Every code claim below was
re-verified against the worktree before being folded in; **nothing in round 4 was rebutted.**

| # | Finding | v6 |
|---|---|---|
| **B1** | `advertised[R] === X` is neither necessary nor sufficient for an owed omission: a pulled-never-advertised `X` produces a false negative (round-3's inversion with another writer as the source of `X`), and a peer's same-OID re-creation after an accepted omission produces a false positive whose retry authors a destructive tombstone (`publisher-tombstones.ts:108-122` → `tombstone-attestation.ts:91-110`) | **RESOLVED — §3.2b.** Conjunct 4 becomes a durable **omission intent** minted in the same state CAS as the BASE retirement, consumed by the ACK, and reconciled against the server's **assigned sequence** in the one uncertain window (`attempt.sequence` vs the head's, mirroring `reconcileResolutionReceipt`, `pull.ts:170-197`). Both codex states are now matrix rows (5, 9, 10, 11). The two cheaper answers a reviewer will propose — read the incoming tombstone chain; compare section identity — are **worked out and rejected in §3.2b**, with the reasons verified: chains are merged only from `advertised` ∪ `pending` ∪ `candidate` (`publisher-tombstones.ts:74-86`) and `advertised` is written **only** at push ACK (`push.ts:962`), so a peer's republication drops the chain *and* regresses `refTombstoneGeneration`; and `gitIncomingKey` is content identity, so a same-`X` re-creation can reproduce the pre-deletion key exactly. |
| **B2** | A pulled-but-never-advertised `X` produces no deletion tombstone, so a v1.6.8+ follower at live/BASE `X` holds instead of pruning and §3.0's semantic silently fails | **RESOLVED — §3.2b**, and the finding is **widened rather than narrowed**: the gap is not "never advertised" but `advertised.refs[R] !== receipt.priorOid`, which any applied advance produces. The omission gets **exact-value tombstone authorship** from the receipt, gated on `refs/heads/*`, `candidate.refs[ref] === undefined`, `refScope === "all"` and `priorOid === absenceReceipt(ref).priorOid`, deduped by `(ref, oid)`. New §3.3 rule 9 refuses to capture an absence a scoped section could never publish, and §7 gets invariant 10. Codex's alternative — narrow the scope to refs this device published — was **rejected**: it fails the ordinary field lifecycle (branch created on the other machine, or advanced by it before deletion) and leaves a deleted ref carried until another device happens to notice. |
| **B3** | A′ has neither the claimed continuous lock nor Z revalidation: `prepareFollowerBranchProtocol` holds no lock, `apply.ts:1847`'s lock-request filter excludes `local-absence`, and the terminal body re-reads only `source === "a"` | **RESOLVED — §3.2 and §3.6a A′.** The false lock claim is **corrected in place** (`follower-protocol.ts:59-115` takes no operation lock — it is a binding and a scan). The authoritative bracket is `withRevalidatedGitPartialApplies` (`apply.ts:1796`), and v6 specifies all four missing pieces: the lock **request** filter plus **two** lock paths per ref (`${witness.ref}.lock` and `${witness.artifactRef}.lock`, proof `expectedOid: null`, a shape `validateJournalProofs` already handles at `state-cas-locks.ts:399-412`); the revalidation filter; a **Z arm** that re-reads the ledger and requires the exact leaf (`entryOids.get(branchRefHash(ref))`); and the strict read at `:1903`. |
| **B4** | The kill switch disables the recovery that existing receipts require — the §11 table and the paragraph under it said opposite things, and the table's literal behaviour wedges or resurrects | **RESOLVED — §11.** The table row now says *new capture only*, and an eight-row table names **every** site that reads the flag and which side of the line it is on. Both hazards are spelled out with their code paths: A″ off ⇒ `follower-protocol.ts:88`/`:106` → `branch-transition.ts:105` → `:136-152` inverts the receipt; A′ off ⇒ rule 3 keeps refusing while §2.3's shape never reaches the follow ⇒ permanent wedge. §9.6 adds a kill-switch off-state test asserting all four recovery paths still run and no new receipt is minted. |
| **B5** | §9.6 retains a P4-only per-ref pending assertion — the relaxed gate still requires the carried section to "name only held refs" | **RESOLVED — §9.6.** The clause is deleted and replaced with the verified state: `pending[rel] = remoteSec` stores the **whole** section (`apply.ts:1426`, `:1448`) and the split lives in `partial.appliedRefs`/`heldRefs`, which is what the rig inspects. The design says explicitly that shrinking `pending.refs` would re-enter the P4 problem through a test assertion. |
| **M1** | The push-side receipt projection has no specified producer — `plan.ts:781` calls the pre-probe before any `FollowerBranchProtocol` exists, so "add a fourth parameter" leaves the caller with nothing to pass | **RESOLVED — §3.2a.** One named producer, `readCurrentLineageAbsenceReceipts(root, relPath, state, ctx)`, with its binding rule (`readRepoIdentityV1` → `readStateLineageV1` → `artifactBinding`), its scan (`scanBaseArtifacts` + `readSettledAbsence`), its total failure rule (`undefined` on every shape that makes `prepareFollowerBranchProtocol` hold, no partial result), one call per repository, and the **same immutable object** passed to the pre-probe and the final proof. `prepareFollowerBranchProtocol` populates `absenceWitnesses` from the same helper so the lanes cannot drift. |
| **M2** | Design 201's deletion gate does not match design 200 — removing a worktree changes no ref, so P1/P1b do not run for a present branch | **RESOLVED in 201**, not by weakening 200: `201`'s acceptance criterion now says the branch must also be deleted, cites §4.2 and the §9.1 fixture note (`git worktree remove` changes no ref), and states that a surviving ref clears through ordinary ownership follow instead. |
| **m1** | The A→Z rationale contradicts the corrected settlement behaviour — §3.2a and §11 said Z is needed because suppression "must survive A→Z compaction", which §3.6a and §13.3 correctly deny | **RESOLVED — §3.2a**, with the *real* reasons stated: A′ must be able to complete a retirement whose receipt has settled (a Z deletes `logicalBaseRefs[R]` at `follower-protocol.ts:106` while serialized BASE keeps the positive member — that gap is what `unmaterializedAbsenceRefs` describes), and P1b must **see** a settled receipt to distinguish "receipt with no owed omission ⇒ carry" from "no receipt at all". §11's step-3 bullet is rewritten to match. |
| **m2** | Three `gitStatus` completeness nits: `code === 1` in the prose, an incomplete fault surface, and a second `error.code === 1` consumer | **RESOLVED — §3.3a.** The prose says `exit === 1`; the fault surface is completed and each item cited (`gitSpawnObserver` at `shared.ts:145`, stdin temp setup `:148-153`, `onStdoutChunk` throws `:184-189`/`:200-206`, non-`EPIPE` stdin `:223`, `finally` cleanup `:228-230`) with the rule that `gitStatus` wraps the **entire** legacy operation including its `finally`; and `parseConfigSnapshot` (`config-txn.ts:211-213`) is named, with the claim narrowed rather than the site migrated — it runs an **injected** `GitConfigRunner` whose contract is the throwing one, and the carried `cause` keeps it byte-identical. §9.6 gains the cleanup and callback rows. |
| **m3** | Design 201's held-ref AC literally permits publishing this device's local divergent held value | **RESOLVED in 201**: the criterion now states that the held incoming transition remains pending and no replacement value is authored while the hold lives. |


### 13.6 Round 5 — `REVIEW-200-R5-CODEX.md`, and the v7 re-frame

**Verdict: NOT-ALIGNED.** Round 5 **closed** three of v6's five answers outright — the
receipt-backed exact-value tombstone authorship (*"a tombstone at `X` cannot prune a peer at a
different `Y`"*, with §3.3 rule 9 and invariant 10 closing the unpublishable-scoped-receipt case),
the stop-authoring-only kill switch (*"both unsafe interpretations are stated"*), and §9.6's
pending assertion. It also verified, independently, that v6's two rejected alternatives were
rejected for the right reasons: the tombstone-chain shortcut (`publisher-tombstones.ts:65-86` merges
only `advertised`/`pendingRetention`/`candidate`, so a peer's applied section is never a source) and
the section-identity shortcut (`gitIncomingKey` hashes content, `shared.ts:86-99`, so identical
content reproduces the key). It then returned three blockers and one major:

| # | Round-5 finding | Where it lived |
|---|---|---|
| **B1** | An armed omission needs a reconciliation CAS **before** `applyPulledManifest`, unlike keep-mine — copying `reconcileResolutionReceipt`'s ordering (`pull.ts:174-199`) lets apply run against an armed intent, so A″ is false, the ordinary `null → X` creation passes, and its transaction retires the receipt. "At the next pull" is not a specification. | the omission intent's reconciliation |
| **B2** | A first-seen incoming `Y` bypasses P1b and is overwritten: every early `reconciled` return leaves `pending` untouched (§3.6a step C), and apply initializes `pending` only from the already-persisted map (`apply.ts:320-327`), so the section carrying `Y` is never retained and the next capture commits over it. Matrix row 8's "applies on the next cycle" was false. | step C's early return |
| **B3** | A requested A′ lock can be **blocked** and the BASE CAS still runs: `acquirePreparedStateCasLocks` returns blocked locks separately and the caller only sets `outcome.partial[rel] = null` (`apply.ts:1878-1896`) without removing `outcome.repoProofs[rel]`, so a terminal read can pass while another Git process owns the branch or artifact lock. | A′'s state-CAS lock bracket |
| **M1** | The raw packet can carry `absenceOmission` (`sync-state-model.ts:315-332`) but the normal state-source lane cannot: apply and ACK saves build records from `StateSource.values`, whose closed `RepoStateValues` projection has no such lane (`sync-state.ts:53-81`, `:206-257`), so mint/arm/consume/discard need a per-ref transition lane with CAS-recompute merge semantics. | the persisted intent |

**All four are correct, and all four are N/A in v7 — because all four live in the window.** The
right-hand column is the finding: every round-5 item is a property of *the omission intent and the
early return*, which exist only because BASE was retired before the wire heard about it.

**The round-count evidence, which is the actual argument for re-framing.** One mechanism, five
rounds, a different failure every time — and every failure inside the same window:

| Round | What was found | What was added to defend the window |
|---|---|---|
| R2 (B2) | An existing A over a positive BASE is refused by rule 3, the in-follow recovery needs the incoming section to omit `R`, and the unchanged shortcut returns first ⇒ permanently wedged | **step A′** + reconciliation above `apply.ts:873` |
| R3 (B2) | A′ is not idempotent across a *second* crash: after BASE retirement, a crash before the omission publishes lets this device's own stale advertisement re-create `R` and destroy the receipt | **step A″** + the `owed` predicate over durable state |
| R4 (B1) | `record.advertised` is neither necessary (a pulled-never-advertised `X` is invisible) nor sufficient (a peer's same-OID re-creation satisfies every conjunct ⇒ its ref is pruned) | **`record.absenceOmission`** + arm/consume/disarm + sequence reconciliation |
| R4 (B3) | A′'s "continuous protocol lock" does not exist; the state-CAS lock request and revalidation filters both exclude `local-absence`; the Z arm is never revalidated | **two lock paths per ref** + a Z-leaf revalidation arm |
| R5 (B1, B2, B3, M1) | The reconciliation must be a CAS *before* apply; the first-seen section must be retained; a blocked lock must refuse the CAS; the intent needs a state-source transition lane | *(not added — the design was re-framed instead)* |

Each round closed the objection it was given. None of them made the mechanism safe, because the
question the mechanism exists to answer — *"is the wire asserting `X` because of us, or because of a
newer writer?"* — is **undecidable from local state**, and the window is what forces it to be asked.
Two rounds in a row closing the stated objection while the same mechanism failed for a new reason is
the pattern the founder's standing rule names, quoted in §13.3: *a model that breaks on a new exotic
input every round is on the wrong plane.* Five rounds is not ambiguous.

**The re-frame, and what authority it has.** v7 is a **designer decision applying that standing
rule**, not a new founder ruling; §12 records it as choices C1–C3 rather than as R6, and a founder
ruling could reverse any of them. What it changes is one ordering, stated as invariant 11: **no local
artifact retires a BASE member ahead of the wire.** The capture omits the ref, the publication
carries the tombstone, the ACK retires BASE, and the apply lane holds that one ref in between. With
the window gone, the undecidable question is never asked: before the ACK there is nothing to defend
(the omission simply retries), and after the ACK there is nothing to re-publish (the witness needs a
positive BASE member, which no longer exists). That is why round 4's ABA is not merely closed but
**inexpressible** (§3.6 row 5).

**The sweep — every finding from rounds 2 through 5, re-answered under the new shape.** 34 findings.
**v8 corrected the totals and one row (round-6 minor 3 and blocker 2); round 7 verified the corrected
arithmetic, and v9 reclassifies nothing** — the split stays **10 N/A / 12 moot / 12 carried = 34**, and
the sweep's scope stays rounds 2–5 (rounds 6 and 7 have their own tables in §13.7 and §13.8; two of
v8's round-6 answers are marked superseded in place there). v7's prose said 11 N/A / 13
moot / 10 carried; its own rows said 11 / 12 / 11 (counting grouped R3 B3–B6 as four findings, which
is how they are listed). The one row that moved is **R4 B1, from N/A to carried**: v7 called it N/A while admitting a bounded same-OID residual, which round
6 was right to refuse as a category error, and §12 C3 now closes its destructive half. Nothing in the
"N/A" column is closed by an argument; it is closed by the absence of a state.

| Finding | What the old shape did | v7 | Class |
|---|---|---|---|
| **R2 B1** — P1b can supersede a pending value the receipt does not witness | required `receipt.priorOid === pending.refs[R]` | **CARRIED**, re-sourced: `record.base.refs[R] === pending.refs[R]` under §3.3's witness. Same test, stronger provenance (invariant 1) | carried |
| **R2 B2** — pin+A crash recovery misses the unchanged path | step A′ above `apply.ts:873` | **N/A.** No artifact is written before publication, so there is no half-finished retirement to recover. The pre-existing *manual* version of the shape is unchanged and recorded (§3.2a, §10) | N/A |
| **R2 B3** — careful in-place restore bypasses both signals | accepted by R4 | **CARRIED** unchanged — §3.0a, §9.1's named accepted-residual test | carried |
| **R2 B4** — P4 partial settlement not closed | three shapes, all failed | **MOOT** — P4 cut (R5), §4.4 | moot |
| **R2 M1** — strict-read taxonomy has no stable API | `gitStatus` with a carried `cause` | **CARRIED** unchanged — §3.3a | carried |
| **R2 M2** — carried absence has no representation | sorted `carriedRefs` list | **MOOT** — P4 cut | moot |
| **R2 M3** — `pinned:false` has no persisted shape | mooted by R4 | **MOOT** — no pin | moot |
| **R2 M4** — tombstone-pin expiry can starve | mooted by R4 | **MOOT** — no pin, no sweep | moot |
| **R2 M5** — Q2b normatively contradictory | swept to "no thresholds" | **MOOT** — R4 | moot |
| **R3 B1** — P4 self-echo re-gags every captured branch | killed the third shape | **MOOT** — P4 cut; recorded as design 201's central problem | moot |
| **R3 B2** — A′ is not idempotent across a second crash / the retire→publish inversion | step A″ + `owed` | **N/A.** There is no retire→publish window: BASE moves at the ACK. A crash before the POST leaves nothing (§3.6 row 1); a crash after acceptance is resolved from the wire (row 3) | N/A |
| **R3 B3, B4, B5, B6** — four independent ways the merged section `M` is unshippable | none — P4 cut | **MOOT** — kept verbatim in §4.4 as design-201 prerequisites | moot (×4) |
| **R3 M1** — no usable settled-Z receipt projection | populate `absenceWitnesses` for the Z arm | **N/A.** No v7 consumer reads a receipt `priorOid`; the only ledger fact anyone needs is `disposition.settledAbsence`, already set at `follower-protocol.ts:105-107`. The gap remains unfixed and undepended-on (§3.2a) | N/A |
| **R3 M2** — A′'s locked proof is not connected to state-save revalidation | `local-absence` in both filters | **N/A.** No `local-absence` proof exists; `apply.ts:1847`/`:1900` are untouched | N/A |
| **R3 M3** — `gitStatus` has two incompatible fault contracts | one contract: nothing rejects | **CARRIED** unchanged — §3.3a | carried |
| **R3 M4** — the carried/captured partition is not total | none — P4 cut | **MOOT** — §13.3 | moot |
| **R3 M5** — P4's reverse migration has no clearing point | none — P4 cut | **MOOT** — and after v11 there is no persisted field of any kind to need a clearing point (§3.2c, §11) | moot |
| **R4 B1** — `advertised` is neither necessary nor sufficient; the same-OID ABA | the omission intent + sequence reconciliation | **CARRIED (v8 reclassification).** Its *first* half stays N/A on the same grounds: no predicate asks whether this device is the reason the wire says `X`, and re-publishing an omission after its own retirement cannot occur (§3.6 row 5). Its *second* half — the same-OID ABA — was **admitted as a bounded residual while being filed N/A**, which round 6 correctly refused: an admitted reachable shape is carried, not absent. v8 closed it with §12 C3's withholding field; **v11 WITHDRAWS that field and accepts the shape as a stated residual with three recovery paths and a non-recurrence proof (§3.2c, §13.4 item 8)**. The classification is unchanged either way — **carried**, because an admitted reachable shape is carried, not absent, which is round 6's own rule | carried |
| **R4 B2** — a pulled-but-never-advertised `X` produces no deletion tombstone | receipt-backed exact-value authorship (CLOSED in R5) | **CARRIED — and it is now the centrepiece**, re-sourced from the witness plus an ACK-side check that the accepted section carries the entry (§3.2, invariant 10) | carried |
| **R4 B3** — A′ has neither the claimed lock nor Z revalidation | two lock paths + a Z arm | **N/A for the original claim** — the nonexistent continuous A′/state-CAS lock is gone, and no BASE proof enters the state-CAS bracket. **v8 states L's own narrower lock lifetime accurately** (round 6): the prepared transaction holds `<ref>.lock` only until `commit`, so the L-to-K interval is unlocked, which §3.2 step L and §3.6 case (d) now say plainly and §3.2c states as an accepted residual | N/A |
| **R4 B4** — the kill switch disables the recovery existing receipts require | stop-authoring-only, eight read sites | **CARRIED**, and reduced to four sites, because there is no durable state to strand (§11). **v8 completes it**: round 6 showed v7's rollback contract was false in code — the switch suppressed the new authoring arm and left the pre-existing advertised-diff author live — and step G (§3.2b), deliberately *not* behind the switch, is what makes the contract true. **v9 closes it differently and more honestly** (round-7 blocker 1): step G is withdrawn, step D **is** behind the switch, and the contract itself is corrected — off restores the pre-200 binary exactly, unproven-omission author included. §9.5's "still carried, never omitted" row is withdrawn with it | carried |
| **R4 B5** — §9.6 retains a P4-only per-ref pending assertion | deleted the clause | **CARRIED** unchanged — and v7 *depends* on that relaxation, since its own hold carries a whole pending section for one cycle (§9.6) | carried |
| **R4 M1** — the push-side receipt projection has no producer | `readCurrentLineageAbsenceReceipts` | **CARRIED**, narrowed to `readCurrentLineageBranchArtifacts`: rule 3 needs dispositions, not `priorOid`s (§3.2a) | carried |
| **R4 M2** — design 201's deletion gate does not match design 200 | fixed in 201 | **CARRIED** unchanged, plus 201's landmine list updated for the re-frame | carried |
| **R4 m1** — the A→Z rationale contradicts corrected settlement | stated the real reasons | **N/A.** No A→Z rationale remains on the capture side | N/A |
| **R4 m2** — three `gitStatus` completeness nits | fixed | **CARRIED** unchanged — §3.3a, §9.6 | carried |
| **R4 m3** — 201's held-ref AC permits publishing a divergent held value | fixed in 201 | **CARRIED** unchanged | carried |
| **R5 B1** — an armed omission needs reconcile-before-apply | *(would have needed a distinct reconciler with a repo-generation CAS before `applyPulledManifest`)* | **N/A.** Nothing is armed; there is no reconciler, no ordering constraint, and no pull-vs-push entry-point question | N/A |
| **R5 B2** — first-seen incoming `Y` bypasses P1b and is overwritten | *(would have needed whole-section retention on every early return)* | **N/A.** There is no early return: the hold goes through the ordinary path, which already stores the whole section (`apply.ts:1426`, `:1448`). The `Y` case is then P1b's carry row and §3.6 case (b) | N/A |
| **R5 B3** — a blocked A′ lock still lets the BASE CAS run | *(would have needed the bracket to refuse on any blocked lock)* | **N/A.** No `local-absence` proof or repo proof reaches that bracket; a refused ref transaction fails closed in the planner (§3.2 step L, §9.2) | N/A |
| **R5 M1** — no `absenceOmission` state-source lane | *(would have needed a per-ref transition lane with CAS-recompute merge semantics)* | **N/A for the proof map**: it is an in-memory field on the authority object `push.ts:962-975` already builds, so a repo-generation retry recomposes from the same immutable inputs — the property M1 asked for, obtained by not persisting it. v8's one persisted field answered M1 by reusing `resolutionReceipt`'s lane member for member, and **v11 removes the field, so M1 has no subject at all** (§3.2c) | N/A |

**Two answers a reviewer will propose for v7's remaining race, and why neither works — retained
from v6 because round 5 verified both refutations.**

1. *"Read the incoming section's tombstone chain: if it already carries `(R, X)`, our omission
   landed."* Unavailable: `normalizePublishedGitSection` merges chains from `advertised` ∪
   `pendingRetention` ∪ `candidate` only (`publisher-tombstones.ts:65-86`), never from the section a
   publisher just applied, and `record.advertised` is written **only** at push ACK (`push.ts:962`),
   so a peer that pulls our omission and republishes a captured section drops the chain and
   *regresses* `refTombstoneGeneration` (`Math.max`, `:73`). A causality test cannot rest on a value
   that moves backwards.
2. *"Compare the incoming section's identity to the one we contradicted."* Unsound: `gitIncomingKey`
   is content identity (`src/cli/sync-git/shared.ts:86-98`), so a peer that prunes `R` and
   re-creates it at the same `X` republishes a section whose key equals the pre-deletion one. Content
   equality is the same ABA one level up.

**What would falsify v7, stated so the next round can aim at it.** The claims that matter are
narrow and each is checkable against code:

- **The ACK can record a retirement.** If `composeRepoBase`'s two sites cannot be given
  `absentBranchProofs` without a `RepoStateValues` lane — i.e. if the ACK's authority object is not
  in fact reconstructed from `gitPlan` at `push.ts:962-975` — then v7 has round-5 M1's problem after
  all. *(Verified: the authority is built there from `gitPlan.publisherAckBindings[relPath]`, and
  `repoProofs` is passed to `saveStateSource` alongside `values`; the composer's `candidate` is
  `ackValues.bases[rel]`.)*
- **The dry run and the ACK agree.** If `pendingSupersessionAckConverges` cannot be given the same
  proofs, every deletion refuses at `plan.ts:1037` and nothing publishes.
- **The hold is reachable before the planner.** If a locally-absent, BASE-positive head cannot be
  classified in `follow.ts:728-768` — e.g. because the candidate set does not contain it — then the
  throw at `branch-transition.ts:105` is still reachable and case (a) is still a wedge. *(Verified:
  `candidates` includes every `base.refs` key when `effective.deleteAbsent` holds,
  `follow.ts:712-716`.)*
- **Case (b) does not stall anything but its own ref.** If a held deletion of one ref blocks
  *another* repository's or another ref's progress beyond the accepted pending carry, that is a
  blocker, not a residual.
- **No durable deletion state *authorizes* anything.** §9.6's snapshot test is the executable form of
  invariant 11. If any code path this design specifies writes an A/Z artifact or a retired BASE member
  before the ACK, the window is back and so is every round 3–5 finding. *(v7 phrased this as "or a
  per-ref field"; v8 narrows it to the two facts that matter, because §12 C3's withholding field is a
  per-ref field that cannot retire or authorize anything — and **v11 removes even that**, so invariant 11 is back to its v7 form: no durable local record of any kind, §3.2c.)*

**One thing v7 looked for and did not find, recorded because its absence is load-bearing.** The
re-frame was tested against the case that killed each previous shape — a peer asserting the deleted
ref at the same OID, at a different OID, and not at all — and against the crash points of each of
those rounds. It survives all of them, but **not for free**: the different-OID case turned out to be
un-decidable *by design* rather than by mechanism failure (this device deleted, another advanced —
two real facts), and v7's answer is to classify it as the two-sided divergence §10 already reserves
for design 173 rather than to decide it. If a reviewer judges that a held ref plus a carried section
plus `keep-mine` is not an acceptable answer for that shape, the correct response is **not** to
re-add the early retirement (§8 item 12) but to bring design 201's per-ref publishing forward, since
that is the only thing that lets one ref wait without its repository's section waiting with it.

### 13.7 Round 6 — `REVIEW-200-R6-CODEX.md`, and how v8 answers it

**Verdict: NOT-ALIGNED — but the first round that validated the mechanism instead of breaking it.**
Round 6 is the pivot in this design's review record and the difference is worth stating before the
table, because it is what makes v8 a convergence round rather than a seventh mechanism:

- **The design-130 amendment passed.** *"I found no stale-ACK or replay path through the proposed six
  K checks."* The ACK loop has `committed.gitRepos[relPath]`, so it can inspect the exact accepted
  section's `refs`, `refScope` and `refTombstones`; `incomingKey` is recomputed from that section; the
  proof and the state values enter the same `saveStateSource`; and stale or replayed sources are fenced
  by stream, nonce, sequence, repo generation and `sourceRecord`'s retention of a newer `sourceSeq`.
  A stale packet loses the CAS or is retained behind the newer record, and an exact
  `previousRefs[R] === priorOid` check still has to pass. **That is the claim §13.6 said would falsify
  v7 if it failed, and it held.**
- **L's zero-OID Git semantics passed, checked against the fleet floor.** Git 2.46 specifies that
  `verify R <zero-oid>` requires `R` not to exist, and `prepare` creates locks for all queued
  references; the repo runner does hold those locks through its callback. Round 6 also drew the right
  conclusion from the same contract — `commit` **ends** the transaction, so the lock does not extend to
  T, POST or K, which v8 now states in §3.2 step L instead of implying otherwise.
- **The re-frame's structural claims survived the sweep.** Ten of the eleven N/A rows round 6
  spot-checked were confirmed correct, including every one that mattered: no capture-side artifact to
  recover (R2 B2), no retire-then-publish window (R3 B2), no receipt `priorOid` consumer (R3 M1), no
  `local-absence` proof in the state-CAS filters (R3 M2, R4 B3), no armed reconciler (R5 B1), whole
  incoming-section retention through the ordinary path (R5 B2), and the in-memory proof map (R5 M1).

What remained were **four wiring findings and three minors** — every one of them a place where the
re-frame's edges were not connected to the code that already exists.

| # | Round-6 finding | v8 |
|---|---|---|
| **B1** | A refused or disabled L has no safe outgoing disposition: the capture has already omitted the ref, and the pre-existing advertised-diff author can still tombstone that omission with no witness (`publisher-tombstones.ts:108-121`). It also breaks the rollout contract, because the kill switch suppresses only the new arm | **~~RESOLVED — §3.2b, step G~~ — SUPERSEDED in v9 by step D; round 7 reopened this as its own blocker 1 (§13.8).** v8's answer was: The candidate **re-advertises** the ref at `record.base.refs[R]` unless step L holds a passing proof; total by construction (driven by BASE and the strict read, not by W's verdict), per-ref (23 of 24 still publish), with the normalizer refusing a candidate that omits an advertised head without a proof as the structural backstop. Round 6's three rejected repairs are answered rather than re-proposed: `deferOne` is not used (it suppresses all 24); the section is not a **hybrid**, because the re-advertised value is one this device captured, not a relayed one — §9.2's row is restated as *never a relayed value*; and a bare omission is not published, because round 6's own evidence chain shows an *unattested* omission is destructive for an owned tip (`follow.ts:743-751`, `:990-998`) | **Why it failed:** bundle coverage. G was specified *after* capture, so a full, forced, basis-fallback or recompacted section carried `R = X` with no pack link reaching `X` — and it cannot be fixed by feeding the tip into capture either, because R4 keeps no pin and `git gc` may already have removed the object (§8 item 13). v9's step D defers the repository and carries a section whose links the wire has already carried. |
| **B2** | R4 B1's same-OID ABA is reachable, and the post-L local case is simpler than the recorded peer race: L commits and releases the lock, a local process re-creates `R` at `X`, the POST is accepted, the ACK CAS is lost, and `checkTombstoneAttestation` authorizes the prune — §3.6(d)'s "live ≠ tombstoned OID" is false for the case it names | **The FINDING stands and is permanently recorded; the RESOLUTION is SUPERSEDED by §13.10 — §12 C3 is WITHDRAWN in v11 and the shape is an accepted residual (§3.2c, §13.4 item 8).** v8's answer, kept for the record: **§12 C3 TAKEN, §3.2c.** One local-only field on the validated `resolutionReceipt` lane shape, minted in the push's existing pre-POST save, read **only to withhold**: force-holding the ref in the apply lane (where round 6 correctly located the destructive act) and not witnessing the pair in the push lane. §3.6 case (d) is corrected in place — the post-ACK refusal comes from `logicalBaseOid === null` (`tombstone-attestation.ts:107-109`) — R4 B1 is reclassified **carried**, residual 8 is closed, and §9.1's accepted-residual test becomes a closed test **plus a negative control** that fails if the field is removed |
| **M1** | The reused `local-commits` value has no path to the promised deletion-hold presentation: `follow` derives the blocker from `heldRefs`, `apply`'s `heldReasonOf` derives the durable reason from the same map, status renders *"Local commits changed here"*, and `held-skip` allowlists the literal | **RESOLVED — §5.2.** `deletion-pending` joins the compile-enforced-total tuple with an argued precedence slot (rank 5, tail of the human-divergence family), non-developer copy, a doctor regex arm, and all five call sites named — including the two round 6 warned about (`heldBlockersAllowSkip`, `causallyMapped`). `heldReasonOf` is re-derived from `FollowProgress.blockers` via `firstReason` over `GIT_DEFERRAL_REASON_RANK`, which is behaviour-identical today and total tomorrow, and the persisted `heldRefs` value stays `local-commits`. The compat sweep found one constraint round 6 did not ask for and it is the sharpest one: the deployed API **rejects the whole telemetry packet** on an unknown reason (`telemetry-ingest.ts:324-330`), so the API vocabulary is step 0 of the landing order |
| **M2** | Case (b)'s keep-mine exit names an unreachable manual-authority path: keep-mine takes its own early branch and `planManualBranchTransition` is below that return and gated on `take-theirs` | **~~RESOLVED — §3.6 case (b)~~ — HALF RESOLVED; round 7 reopened the execution half as its own major 4 (§13.8).** v8's authority correction was right and stands; its *execution* model was design 176's persisted intent, which **design 177 deleted** (`177:1`, `:31-47`, `:164-173`, shipped in PR #390). v8's answer was: Respecified onto the path keep-mine actually takes, which is also the one **design 176 already ruled** (`176:93-99`: keep-mine *"never routes BASE through manual authority"* and folds through the **publisher-ack** arm). The intent machinery needs **no** amendment for an absent local ref — `resolution-intent.ts:219` classifies a candidate-absent branch lane as `not-subsumed`, never `indeterminate`, and carries its `pendingOid` for preservation pins — so the only 176-side change is the refusal sentence in its item 4, stated verbatim in §3.6. §9.1 asserts the publisher-ACK path and that `planManualBranchTransition` is never called |
| **m1** | "Six checks" overstates the composer's independent validation: `incomingKey` is only checked non-empty and `effectiveRefScope` comes from the same section, and the §9.2 table omits five negative rows | **RESOLVED — §9.2 row 1.** Eleven rows enumerated, the two constructor invariants named as such, **and the sole caller frozen structurally** — a `base-composer-structure.test.ts`-style assertion that every `publisher-ack` authority derives `incomingKey` and `effectiveRefScope` from the same section it passes as `candidate` |
| **m2** | §9.4 still says "one A artifact each", contradicting v7's zero-capture-side-artifact property | **RESOLVED — §9.4.** Changed to **zero A and zero Z artifacts** for all 24, matching §9.1 |
| **m3** | The landmine totals are arithmetically wrong: the rows are 11 N/A / 12 moot / 11 carried, the prose says 11/13/10 | **RESOLVED — §13.6 header and the header at the top of this file.** v7's rows totalled 11/12/11; with R4 B1 reclassified (B2 above) v8's split is **10 / 12 / 12 = 34** |

**What v8 said the next round should aim at, and what round 7 actually hit.** v8 named four claims:
that step G's re-advertisement is not a relayed value; that §3.2c terminates; that §3.2c cannot enable
anything; and that the `deletion-pending` slot is a UX claim. **Round 7 hit three of the four, and it
came in from the side on the first one.** G's value was indeed not relayed — that claim was true and
irrelevant, because the problem was never provenance but *bundle coverage*. §3.2c's termination broke
for the current-branch case. "Cannot enable anything" was literally false. Only the fourth stood.
**The lesson v9 records for the next round: v8's self-directed attack list tested the claims v8 found
interesting, not the boundaries its two new auxiliaries touched.** Both auxiliaries were new in v8;
all five of round 7's blockers landed on them, and none landed on the v7 core. *(v11's note: that
pattern then repeated for rounds 8 and 9 on the surviving auxiliary, which is the evidence §13.10 acts
on.)*

### 13.8 Round 7 — `REVIEW-200-R7-CODEX.md`, and how v9 answers it

**Verdict: NOT-ALIGNED — and the shape of the round is the finding.** Rounds 6 and 7 together
validated the v7 re-frame twice over: the capture→tombstone→ACK ordering, the per-ref hold, the
design-130 amendment's ACK fencing, and step L's zero-OID Git semantics all held again, and round 7
independently **closed** the "verified claims that do close" list below. **Every one of round 7's five
blockers landed inside the two auxiliaries v8 added, and neither auxiliary survives v9 in the form v8
gave it.** That is the same signal the founder's standing rule names, applied one level down: v8 was a
convergence round on the core and a *first* round on two new mechanisms, and both of those failed on
first contact with code.

So v9 does to the auxiliaries what v7 did to the primitive: **replaces rather than patches**, where
the replacement is a mechanism that already exists in the codebase.

| # | Round-7 finding | v9 |
|---|---|---|
| **B1** | Step G can advertise an OID the section's pack links do not contain — full/forced/basis-fallback/recompacted captures build the bundle from live refs, where `R` is absent, so a fresh receiver importing `packChain + newest` has no path to `X` | **RESOLVED by replacement — §3.2b step D.** Step G is **withdrawn** (§8 item 13). It is not repairable: feeding the tip into capture's inputs cannot work either, because R4 keeps no pin on the deleting device and `git gc` may already have removed `X`. The replacement is **the existing per-repository carry machinery** — `revertCapture` (`plan.ts:174-183`) after a committed capture, or `deferOne` (`:533-551`) if W/L are hoisted ahead of it; §3.2b picks the property, not the helper, and **v10 uses that phrasing everywhere so no summary names the helper §3.2b warns implementers off** (round-8 minor 1). The repository's capture defers wholesale and the last synced section is carried, so **bundle coverage is trivial (the carried section's links are ones the wire already carried)** and the carried section still asserts `R = X` so no follower prunes. The cost is one cycle of Git-plane latency, stated in §3.2b, priced in §6, amended into §9.4's AC, and pinned by a named test in §9.1. **v10 adds the active-BASE gate** that makes the carry total (round-8 major 2) and a **typed** `deletion-pending` reason (round-8 major 3) |
| **B2** | The proposed normalizer refusal rejects a fully authorized remote deletion: after an incoming tombstone retires `BASE[R]`, `advertised` stays positive, the candidate legitimately omits `R`, and no proof exists — so the backstop refuses forever, and only an ACK could advance `advertised` | **RESOLVED by deletion — §3.2b.** v9 adds **no normalizer refusal**. The predicate is not decidable where v8 put it (the normalizer cannot see BASE), and the shape B2 names is *correct behaviour* that must keep working. The gate moves to the layer that can see BASE, the live refs and the proof map at once — the plan — and it is a **structural test over `planGitSections`**, not a runtime throw. §9.1 asserts the legitimate case is authored and does **not** throw, which is the executable form of this finding |
| **B3** | C3 drop condition 2 (`record.sourceSeq < attemptedSequence`) is true in the exact lost-ACK state it must protect — a landed POST with a lost ACK leaves `sourceSeq = N` | **MOOT in v11 — §12 C3 WITHDRAWN, there is no drop condition to test (§13.10).** v9's answer, kept for the record: **§3.2c amendment 1.** The test becomes `headSequence < attemptedSequence` against the pull's **signed** head sequence (`e2ee-remote.ts:474-478`, already in `pull()`'s hands at `pull.ts:89-95`), reconciled **before** the tombstone transition is planned. Amendment 1b additionally finishes the attempt on every *known-negative* POST outcome exactly as `resolutionReceipt` already does (`push.ts:846-851`, `:901-905`, `:853-899`), so what stays armed is only the genuinely uncertain set. §9.1 has the two-row pair with opposite required outcomes that v8's predicate cannot tell apart |
| **B4** | arm → lose ACK → arm can overwrite the ref the first attempt protected; push startup reconciles only `resolutionReceipt` | **MOOT in v11 — there is no arm (§13.10).** v9's answer was half wrong, round 8 caught it, round 9 caught v10's replacement, and that sequence is the withdrawal's evidence. Kept for the record: The half that stands: **reconcile at push entry**, in the same place the receipt is reconciled (`push.ts:272-273` → `pull.ts:174-200`). The half **WITHDRAWN in v10**: "refuse to arm over a survivor and let the repository take step D's defer". Round 8 showed step D's trigger does not even fire for the protected pair (`R` is *present*), and that adding a survivor gate to force it creates a **permanent non-current latch**. v10 keeps one entry per **ref** and **merges** on arming, each entry carrying its own `attemptedSequence` / `attemptedGitIncomingKey` — the "overlapping generations" option round 7 offered and v9 declined for a reason (§3.2c amendment 2) that was wrong: the publication that clears a survivor is an *assertion*, not another omission |
| **B5** | Clearing C3 on every ACK can clear an ACK that still advertises the omission — `revertCapture` reinstates the exact pending section, and "this ACK recorded a section for the repository" is not enough | **MOOT in v11 — there is nothing to clear (§13.10).** Kept for the record, because the counterexample is a real path through `revertCapture`: Per `(ref, priorOid)` clearing against post-ACK state is right and stands. v9's *predicate* was not implementable: the ACK site holds neither `live.refs` nor the composed BASE, and `committed.gitRepos[rel].refs[ref] === live.refs[ref]` is **true when both are absent**, which clears an entry against an absent ref. v10 splits it: condition 3 is an **affirmative** assertion (`gitPlan.captured` membership + a positive well-formed `refs[ref]` + `refScope === "all"`) evaluated at the ACK site from plan-carried facts, and condition 1 moves to the composition boundary (`sync-state-store.ts:165-180`). §9.1 pins the retained row, the `undefined === undefined` row, the positive twin and both placement assertions |
| **M1** | The normalizer has no specified per-repository refusal path — throwing aborts the whole push, returning a finding still publishes | **RESOLVED by B2's deletion.** There is no refusal to plumb. The per-repository failure primitive this design uses is the existing carry machinery (`revertCapture` / `deferOne`), which already records a typed deferral through the `deferred` → `captureReason` channel (`plan.ts:224-232`, `:275-278`). **v10 corrects one thing v9 asserted here** (round-8 major 3): `captureReason` is a regex classifier with **no `deletion-pending` arm**, so step D's reason would have been reported as `other` or `artifact`. The channel is right; the reason needed a typed producer, specified in §3.2b and added to §5.2's inventory |
| **M2** | C3's current-branch example does not terminate in the promised two cycles: a forced hold on `live.currentRef` produces a whole-checkout defer, and the changed HEAD makes pending supersession carry | **MOOT in v11 — no forced hold exists, so there is no non-terminating shape (§13.10).** v9's answer, kept for the record: **§3.2c termination, §13.4 item 8.** The non-current `git branch R X` shape terminates in **one** cycle (not two), because the same cycle's capture asserts `R` at its live value and that ACK drops the entry. The current-branch `git checkout -b R X` shape does **not** terminate automatically and v9 says so, names the two exits (switch off it, or `keep-mine`), and adds a §9.1 row that asserts the entry still stands after two further cycles. The ref is safe in both |
| **M3** | The `GitDeferralReason` consumer inventory is not total | **RESOLVED — §5.2's complete inventory.** Fourteen sites plus five tests, classified as compile-time exhaustive, runtime allowlist, or test. Four were missed by v8's five-site table: `resolve-presentation.ts:113-133` (`Record<GitDeferralReason, string>` — typecheck), `breadcrumb-veto.ts:56-76` (`assertNever`, plus a second deliberate slot in the separate `BreadcrumbVetoGate` union at `:27-45`/`:107-114`), `shell-init.ts:189-190` (aborts the **whole** prompt sidecar for every repository, not one row), and `status-view.test.ts:143` (silently stops being exhaustive). **One site round 7 did not name is the sharpest**: `apps/api/test/telemetry-ingest.test.ts:262` builds a 17-long array to trip the length cap, so a 17th member makes that fixture *valid* and the cap stops being tested — it must become 18. Also `apps/api/test/telemetry-ingest.test.ts:82` asserts tuple **equality** including position, which is what makes "same PR, same slot" mandatory rather than tidy |
| **M4** | Case (b) specifies the lifecycle design 177 deleted | **RESOLVED — §3.6 case (b), rewritten against HEAD.** `GitResolutionIntent` and `RepoRecord.resolutionIntent` do not exist in `src/`; the only survivors are two by-name strips (`sync-state-model.ts:353-367` with its sole caller `sync-state-store.ts:89`, and `:397-401`). The carrier is the ephemeral `GitResolutionRider` (`resolution-intent.ts:44-51`), built at `resolve-command.ts:755`, pushed synchronously at `:769-770`, inside one `withWorkspaceSyncMutex` scope (`:540`–`:1003`) with a confirm-boundary re-derivation at `:709-750`. A pre-ACK failure persists nothing and **the user re-runs** — there is no automatic retry, because a daemon push carries no rider. v9 also states plainly that steps W/L/T/D **do not exist in the binary** and must be added to that capture, and that a step-D defer there fails the command cleanly rather than silently. **Design 176 was never amended and still says "next ordinary push" (`176:42`)**; that is recorded so the next reader is not misled |
| **m1** | The "not relayed / re-minted origin" rationale overstates invariant 1 | **RESOLVED — invariant 1, §3.2 step K, §9.1.** Verified: `publisher-ack` mints an origin only when `requested !== before` (`base-composer.ts:363-367`) and the shared tail retains `priorOrigin` when `before === after` (`:457-461`), so a peer-applied value keeps its `pull-p` origin (`:227-228`). The invariant proves the device **held** the OID, not that it published it, and every "re-minted at the same OID" phrasing — including one in §9.1's test text — is corrected to "retained verbatim" |
| **m2** | The secondary status-order rationale and the repair copy are inaccurate | **RESOLVED — §5.2.** `gitDeferralReasonPrecedence` is the **primary key selecting the displayed lane and reason** at `status-view.ts:382-388` (age is the tie-break *inside* it) and only a repo-level tie-break at `:425-429`, with `oldestDeferredSince` computed independently at `:389-392`. So `default: 5` leaves the new reason tied with `conflict` and friends and the "needs no change" claim is withdrawn: it needs an explicit case (or the shared rank table) plus an ordering test. The repair line no longer promises self-clearance, because three named shapes need movement or `keep-mine` |
| **m3** | C3 does enable a conservative code path | **MOOT in v11 — invariant 11 needs no clause about a withholding record at all (§7, §13.10).** v9's answer, kept for the record: `Object.keys(forcedHeldRefs ?? {}).length > 0` is an explicit `routeThroughFollow` disjunct (`apply.ts:1011-1013`). The invariant is now "enables no **destructive or authority-granting** path"; conservative classification and hold paths it may enable, which is over-work in the safe direction |

**What round 7 verified as closed, recorded because it is what v9 is allowed to keep building on**:
today's no-pending behaviour (the advertised-diff loop authors the tombstone; `pendingSupersessionAckConverges`
is consulted only for `pendingSupersessionCandidates`); that **a bare omission is destructive** and is
therefore load-bearing (`follow.ts:743-751`, `:773-786`, `:975-998`); that C3's destructive lane is the
apply lane and that `forcedHeldRefs` is installed before transition planning and excluded from the
tombstone-waiver loop; the telemetry compatibility analysis and its server-first release order; the
landmine table's arithmetic (10 N/A / 12 moot / 12 carried = 34, with R4 B1 carried); §9.4's zero-A /
zero-Z expectation; step L's transaction-scoped lock lifetime; and that no persistent tombstone war is
introduced by concurrent peer deletion. The rounds-2-to-5 sweep in §13.6 keeps its scope and its
totals — v9 reclassifies nothing in it.

**What v9 deliberately did not do, so round 8 can aim at it.** It adds no subsystem and no new
primitive: step D is a boolean plus a call to a helper that has existed since design 174, §3.2c's
amendments are three orderings copied from `resolutionReceipt`'s own lane *(all withdrawn in v11)*, and
the case-(b) exit is 177's shipped rider. **Four claims are the ones worth attacking, and they are deliberately narrower
than v8's list:**

- **Step D's carried section is bundle-complete because it is not composed.** If a reviewer finds a
  path by which `deferOne` installs a section whose refs its own `packChain` cannot cover — including
  the BASE-carry branch after a server-side blob loss forces `force.has(rel)` and the section is
  *dropped* rather than carried (`plan.ts:544-547`) — then step D has G's problem and the whole
  outgoing question is open again. §9.1 asserts coverage across full, forced, fallback and recompacted
  captures.
- **Step D's standing-refusal residual is a carry, never a loss.** §13.4 item 10 claims the repository
  keeps asserting exactly what BASE asserts and the file plane is untouched. A shape where a standing
  refusal *loses* work, or where the carried section prunes something on a follower, is a blocker.
- **§3.2c's amended lifecycle has no state in which an entry is both live and unreachable by its three
  drop conditions, other than the named current-branch case.** That is the latch test, and v8 failed it
  three ways. **Round 8 found that v9 failed it a fourth way (§13.9 blocker 1), and round 9 found that
  v10 failed it a fifth (§13.10 blocker 1).** The claim was the right one to publish, it broke every
  time it was published, and that record is the argument v11's withdrawal rests on.
- ~~**UNVERIFIED, and flagged as such rather than asserted:** whether `opts.sourceGlobalSeq` is the
  *signed* head sequence on **every** entry point into `applyGitSections`.~~ **CLOSED — VERIFIED in
  round 8 and re-confirmed by round 9. The trace is preserved here because it is a durable fact about
  the codebase; **its consumer — §3.2c's drop condition 2 — is withdrawn in v11, so nothing in this
  design reads it any more** (§13.10).**
  `applyGitSections`' sole non-test caller is `applyPulledManifest`, which always passes its own
  `sequence` (`pull.ts:363-372`). All three production entry paths supply an authenticated value:
  `pull()`'s `api.latest()`, which returns `verifiedHead()`'s signed seq and refuses a server that pairs
  a valid commit with a different number (`e2ee-remote.ts:132-139`, `:449-481`);
  `reconcileResolutionReceipt`'s `head.sequence`, the same value (`pull.ts:184-193`); and chain repair's
  `manifestAtSeq(seq)`, verified through `verifyHistorySegment` against the verified head's hash
  (`chain-repair.ts:52-60`, `e2ee-remote.ts:520-535`). Direct calls omitting the option are tests only,
  so `state.lastSyncedSequence` (`apply.ts:1314`) is dead as a production fallback. **v10 nevertheless
  takes round 8's recommendation** and makes the value a **required** parameter of the new
  reconciliation rather than inheriting the optional one — a required parameter cannot silently acquire
  a fourth caller with weaker provenance. **v10 introduces no new UNVERIFIED claim.**

### 13.9 Round 8 — `REVIEW-200-R8-CODEX.md`, and how v10 answers it

**Verdict: NOT-ALIGNED, and the shape of the round is that the core is now settled and the auxiliary
lifecycle is the only thing still moving.** Round 8 verified step D on the ordinary active-BASE path
(capture has the ref snapshot before finalization, W/L can run after it, and `revertCapture` replaces
both `out` and `finalizedOutgoing` while undoing the successful-capture bookkeeping), **closed the one
claim v9 shipped as UNVERIFIED**, and left the v7 core untouched for a third consecutive round. All
three of its findings land inside §3.2b's trigger and §3.2c's field lifecycle, and **all three are
refinements: nothing in the design's shape changed, one clause was withdrawn, and two predicates were
respecified against verified call-site inputs.**

| # | Round-8 finding | v10 |
|---|---|---|
| **B1** | Amendment 2's survivor rule turns round-7 B4's overwrite race into an undisclosed **permanent non-current latch**: step D's trigger does not fire for the protected pair (`R` is present), and a survivor gate that forces the defer carries the omitting pending section, after which conditions 1, 2 and 3 are all unreachable while `S` stays absent | **MOOT in v11 — round 9 showed v10's repair still lost a generation and its hard-cap fallback recreated this very latch, so the field is WITHDRAWN (§13.10).** v10's answer, kept for the record: **withdrawal plus the option round 8 named first — §3.2c amendment 2.** The survivor-defer clause is **withdrawn**; arming now **merges**, and each entry carries its own `attemptedSequence` / `attemptedGitIncomingKey` (the field was already a per-ref map — v9's error was hoisting the slot onto the record, which is exactly what made two live pairs inexpressible). v10 also records **why the disclose-and-bound option was rejected**: the latch is *not* bounded by the next pull, because a pull-lane BASE retirement for a locally-present ref is inexpressible — `branchProofMatches` requires `locked.liveOid === after` for an `after === null` retirement (`base-composer.ts:246-258`) and `publisher-ack` preserves BASE for any ref the candidate omits without L's locked proof (`:356-357`). So condition 1 is unreachable by construction and the latch is unbounded. Amendment 2 walks B4's own fixture to termination in one cycle, and §9.1 adds the **latch regression bar** that fails under v9's rule |
| **B2** | Condition 3's written equality `committed.gitRepos[rel].refs[ref] === live.refs[ref]` is **true when both sides omit the ref**, so a step-D carry of the omitting pending section that gets acknowledged clears the entry while composed BASE still holds `priorOid` — re-exposing the round-6 destructive race to the next `git branch R X` | **MOOT in v11 — there is no clear predicate (§13.10).** v10's answer, kept for the record: **§3.2c amendment 3, condition 3.** The clear now requires **affirmative** evidence, in four conjuncts: `gitPlan.captured.includes(relPath)` (round 8's "bind that assertion to the capture observation" — and the thing that replaces the missing `live.refs`, because a captured section's `refs` **are** the strict ref read, `capture.ts:259`, `:333-345`); a positive well-formed `refs[ref]` (`hasOwnProperty` + `HEX40`), which is the presence check v9 omitted; `refScope === "all"`; and no `absentBranchProofs` entry for the same ref in the same push. Being stricter only **retains** entries, which is the safe direction. §9.1 pins the `undefined === undefined` row explicitly, followed by a `git branch R X` that must not be pruned |
| **M1** | The clear is specified at a site that has neither claimed derived input: no `live.refs` reaches `GitPushPlan`, and `stateGit` (`push.ts:944`) is `gitBaseAfterCommit`'s **requested** candidate, not the composed BASE — `composeRepoBase` runs later and twice, inside `sourceRecord` on every CAS recomputation and again inside the transactional writer | **MOOT in v11 — no condition is evaluated anywhere (§13.10); the composition-boundary hook is deleted.** v10's answer, kept for the record: **§3.2c amendment 3, condition 1 and the lane.** Verified against the site: the loop holds `committed.gitRepos`, `gitPlan` (with `captured` / `carried` membership and `publisherAckBindings`), pre-save `ackRecords`, `pendingAfterAck` and `stateGit` — and nothing else. So condition 3 is respecified over plan-carried facts only (B2 above), and **condition 1 moves to the composition boundary**: it is evaluated inside the transactional writer immediately after `composeRepoBase` returns and before the record is written (`sync-state-store.ts:165-180`), which is the only place the persisted composed BASE exists and which runs once per accepted packet on every recompute (`sync-state.ts:339-356`). The state-source lane therefore carries a **merge instruction** (`{ arm, clearAsserted }` \| `null`) rather than `resolutionReceipt`'s replacement value, and the `current.sourceSeq > source.sourceGlobalSeq` retention arm (`sync-state.ts:211-216`) already gives round 8's "preserve the field when a newer record wins" for free |
| **M2** | Step D is not total for a positive **hidden** BASE anchor: `repoAbsent` / `removedKey` retain `record.base` while hiding it from the projection, so a re-add after an identity change can reach step D with `base[rel]` and `pending[rel]` both absent — and `revertCapture`'s fallback is not optional | **RESOLVED and STILL LIVE, then extended by round-9 blocker 3, which found the gate's postcondition did not survive the state save (§13.10).** v10's answer, which stands with v11's two added bookkeeping clauses: **§3.2b, the active-BASE gate.** The trigger gains *"and whose projected BASE is active"* (`record.repoAbsent !== true && record.removedKey === undefined`, the exact predicate at `sync-state-model.ts:455-458`) **and** *"and which is not itself being retired this pass"* (`plan.ts:813-817`; the removal-memory arm returns before capture at `plan.ts:599-604`). When the gate is false the repository's **section stays absent** — round 8's own "safe natural disposition for a deferred re-add" — and v10 states why that is not a hidden `base[rel]` carry: the wire has no section for `rel`, the outgoing map has no entry, so `normalizeOutgoingGitSections` never iterates it and no tombstone is authored. The gate is a strict narrowing, so it cannot re-open round-7 B1. §9.1 adds the re-add row driven through the real removal arm (`apply.ts:691-718`) plus its positive control |
| **M3** | Step D's `deletion-pending` capture reason has no producer: the defer goes through `deferred` as a free-form string and `captureReason` has no such arm, so an exact `"deletion-pending"` detail becomes `other` and any detail containing *capture* becomes `artifact` | **RESOLVED — §3.2b's producer paragraph and a new §5.2 inventory row.** The deferral item gains `typedReason?: GitDeferralReason` and `plan()` prefers it (`item.typedReason ?? captureReason(item.reason)`, `plan.ts:275-278`), which is the same out-of-band per-item tagging `configLaneDefers` / `configLaneItems` already do by object identity (`plan.ts:160-161`) — the deferral channel's own existing reason plumbing rather than a new one. Round 8's alternative (an exact non-regex arm ahead of the `artifact` regex) is recorded as acceptable but not chosen, because it fuses the human detail line and the machine enum. §9.1 asserts it on the **capture** lane, including the adversarial detail line containing the word *capture*, since the apply-side `FollowProgress.blockers` test does not cover it |
| **m1** | Non-normative summaries still call step D's replacement "today's `deferOne`", the helper §3.2b warns implementers not to use after finalization | **RESOLVED — header item 1, §6's cost row, §13.8's B1 and M1.** All four now say **"the existing per-repository carry machinery"** and name `revertCapture` (`plan.ts:174-183`) first, with `deferOne` as the hoisted-W/L alternative. §3.2b's normative table is unchanged; the split that invited the mistake is gone |

**What round 8 verified as closed, recorded because it is what v10 builds on.** Step D's evaluation
point is viable on the active-BASE path — capture returns the strict ref map in the section before
normalization, W/L can run after `commitCapture`, and `revertCapture` updates both `out` and
`finalizedOutgoing`, removes `captured`, clears the authored config hash and repo-absence bookkeeping,
and records the defer (`plan.ts:169-183`, `:987-1055`). An accepted POST with a lost ACK **is**
reconcilable at push entry by fetching and applying the authenticated head exactly as
`resolutionReceipt` does (`push.ts:272-273` → `pull.ts:174-200`) — round 8 confirmed the ordering v9
specified; only what happened *after* that reconciliation was wrong. The current-branch residual is
"real but acceptably disclosed … a literal field wedge, but a reported, safe one with named exits", and
round 8 notes the keep-mine rider becomes a **second** exit once the survivor rule is repaired — which
amendment 2 does *(both statements are moot in v11)*. And `sourceGlobalSeq` is **resolved for every
production caller** (§13.8's closed bullet). **Round 8 reclassified nothing in §13.6's rounds-2-to-5
sweep, so the landmine arithmetic is unchanged at 10 N/A / 12 moot / 12 carried = 34** — and round 9
reclassified nothing either, so it is still 34 in v11 (§13.10).

**Nothing in round 8 contradicted v9 in a way that needed adjudication.** Every disagreement resolved
in round 8's favour on code that v10 re-read at the cited lines, and two of its findings are
*narrowings* of claims v9 itself flagged as the ones worth attacking (the latch test and step D's
totality). One clause of round 8's prescription was **not** taken, and the reason is recorded rather
than elided: its shortest-list item 1 offers three repairs — overlapping generations, a staged
representation, or design 201's per-ref wire model — and v10 takes the **first**, because the field is
already a per-ref map and the repair is a per-entry annotation rather than a new representation. Round
8's own alternative for M3 (an exact string arm in `captureReason`) is likewise recorded as acceptable
and not chosen.

**What v10 deliberately did not do, so round 9 could aim at it — and round 9 hit all three of the named
claims, which is why v11 subtracts instead of patching.** It restructured nothing: amendment 2
moves two scalars into a map that already existed, amendment 3 moves one condition to the composition
site that already runs it, step D gains a two-field gate, and the reason gains a typed field on a
channel that already tags items out of band. **Three claims are the ones worth attacking:**

- **Amendment 2's merge makes the latch test hold universally.** The proof obligation is that a
  repository can always publish a section that *asserts* every live entry-named ref. A reachable state
  where it cannot — where the assertion is itself blocked by a hold, a defer or a supersession carry
  that the entry causes — is a blocker, and it is the same class of finding as round-8 B1.
- **Condition 3's four conjuncts are sufficient as well as necessary.** They are deliberately
  over-strict, so the risk is not a wrong clear but a *never*-clear: if `gitPlan.captured` can exclude a
  repository whose acknowledged section genuinely came from this device's capture, the entry survives an
  event that should have ended it and the latch test fails from the other side.
- **The active-BASE gate's "section stays absent" outcome is safe for every reachable hidden-anchor
  shape.** v10 argues it from "the wire has no section for `rel`". A shape where a hidden anchor
  coexists with a live wire section for the same repository would make that argument false.

### 13.10 Round 9 — `REVIEW-200-R9-CODEX.md`, and the v11 withdrawal

**Verdict: NOT-ALIGNED — and for the fourth consecutive round every blocker landed in one of the two
auxiliary mechanisms v8 and v9 added, never in the v7 core.**
Round 9 verified the v7 core again, **CLOSED** two claims outright (`sourceGlobalSeq` is authenticated
on every production entry path and should stay a required parameter; `gitPlan.captured` really is
strict-read evidence, since `captured` is added only by `commitCapture` from
`capturePlannedGitSection` and forced capture, basis fallback, recompaction and resolution capture all
preserve that invariant), and **CLOSED** step D's typed producer and its retiring-this-pass gate. Its
four blockers were B1, B2 and B4 inside §3.2c's field lifecycle and B3 inside §3.2b's active-BASE gate's
bookkeeping — three in the field, one in step D.

**The editorial decision of this revision, stated as a decision rather than as a fix.** Rounds 6, 7, 8
and 9 produced **twelve** findings against §3.2c's arm/merge/clear lifecycle — B2 in round 6; B3, B4,
B5, M2 and m3 in round 7; B1, B2 and M1 in round 8; B1, B2 and B4 in round 9 — and no round left it
correct. Each round closed the defect it was given and the next found a
new reachable state the lifecycle mishandled — the exact signature the founder's standing rule names,
and the signature R4 used to retire the mass-deletion breaker and R5 used to cut P4. **So v11 withdraws
§12 C3 and deletes the field rather than repairing it a fourth time**, and the race becomes a stated
residual with three verified recovery paths and a non-recurrence proof (§3.2c). The three principles
this rests on are quoted in §3.2c and all three are R4's: *"some math is just not gonna prevent it;
there's always a gap"*, **file history is the contract**, and **no pins, no thresholds**.

| # | Round-9 finding | v11 |
|---|---|---|
| **B1** | One slot per ref is not overlapping generations: for the same ref an arm executes `omitted[ref] = newEntry`, the newer entry wins and the older generation is irretrievable — contradicting amendment 1b's promise that finishing the entries matching the new candidate "leaves every older pair standing". The reachable state is v10's own ACK-clear fixture, where attempt A is retained and a later push arms B for the same `R`; either B's known-negative outcome clears the only stored entry, or condition 2 drops it against a raised slot, and A's protection is gone while logical BASE is still positive | **MOOT by withdrawal — §3.2c, §12 C3.** The finding is correct and it is the third distinct way the same representation lost a live protection (round-7 B4 overwrote, round-8 B1 latched, round-9 B1 loses a generation). Alignment would have required a per-ref generation *collection* plus a proved rule forbidding same-ref re-arm — a fourth representation change to a field whose every representation has failed. **v11 deletes the field instead.** The shape B1 protects is now §3.2c's residual, which is bounded by same-OID equality, pinned by the prune transaction and non-recurring |
| **B2** | The production legacy/degraded writer drops the field entirely: `saveStateSource` takes `legacyState` on `forceLegacy`, an unsupported transactional write or an allowed stream replacement, and `legacyState` writes `repoRecords: undefined`, reprojecting only `gitDeferrals` and `gitPartial`. `repoRecordsForState` has no legacy projection that could reconstruct `absencePublicationAttempt`. Degraded-mutex pull and **all three** push state saves pass `forceLegacy`, and the route also bypasses the proposed condition-1 boundary in `applyStateSavePacket` | **MOOT by withdrawal, and it is the decisive finding — §3.2c.** This is not a predicate error that a better predicate fixes: closing it means either teaching the compat writer a projection for a design-200 field (`sync-state.ts:289-321`, `sync-state-model.ts:373-420`) or making **Git publication fail closed whenever transactional state persistence is unavailable** — new machinery in a lane this design otherwise never touches, to defend one branch pointer in one crash window. Round 9's own framing ("the lane must survive legacy persistence, or Git publication needing C3 must fail closed") is the cost statement that made the withdrawal obviously right |
| **B4** | The hard-cap fallback recreates the permanent survivor latch: with 512 retained entries whose refs were re-created non-current plus a newly deleted, proved 513th BASE ref `S`, the cap rule ("do not arm, take step D's defer") carries the prior omitting section, after which conditions 1, 2 and 3 are all unreachable and every cycle proposes the same forbidden arm. It also asks for step D where step D's own predicate is false, since `S` has a passing proof | **MOOT by withdrawal — §3.2c.** Round 9 is right on both halves, and the second half is the sharper one: the cap rule reached *into* step D to borrow a disposition step D does not offer, which is precisely the coupling that made every C3 repair leak into another lane. v10 introduced the cap to satisfy "an unbounded map in a state file must be impossible by construction"; the cap then reintroduced round-8 B1 at the bound. **There is no map, so there is no bound to enforce** |
| **B3** | The hidden-anchor route clears the suppression that keeps BASE hidden: the fixture changes the leftover's identity, so the planner deletes `removedMem[rel]` before capture (`plan.ts:599-604`); with `rel` absent from the planner's `gitReposRemoved`, `sourceRecord` omits `removedKey`, carry composition still preserves the hidden `record.base`, and `stateFromRepoRecords` projects that BASE **active** again (`sync-state-model.ts:455-458`). The next cycle's refusal then carries the stale pre-removal BASE section, so v10's required conjunction is unreachable | **FIXED on its own merits — §3.2b, §9.1.** This finding has **nothing to do with C3** and survives the withdrawal intact; it is a real defect in step D's own bookkeeping and v11 repairs it in two normative clauses: the discard **removes** rather than replaces (`out[rel]` and `finalizedOutgoing[rel]` deleted, `rel` out of `captured`, config hash cleared — `revertCapture` with no fallback section, which is round-8 M2's type-level statement), and **the removal suppression is restored to its prior `record.removedKey`**, never to the leftover's new identity, so both `push.ts:669` and `:993` re-write `removedKey` and the anchor stays hidden. §9.1's re-add row now drives **both** state writers and asserts one further cycle does not publish the stale section |
| **M1** | The normative structural pin and its test universally forbid an outgoing section omitting a BASE-positive head without a same-push proof, which is mutually unsatisfiable with the scoped partition three paragraphs above it (a `refScope !== "all"` omission is inert on the receiver and publishes with no step D and no L proof) | **FIXED — §3.2b, §9.1.** Both the pin and its test are qualified with **effective `refScope === "all"`**, a third exception states the scoped case explicitly, and §9.1 gains the complementary assertion that no `dir` repository ever publishes a `scoped` section (`capture.ts:344`) so the qualifier cannot become an escape hatch |
| **m1** | The test plan requires executing withdrawn machinery: after testing v10's R/S merge, the row asks for the fixture to be run "against v9's rule" to assert the withdrawn survivor defer latches forever, which is not an executable implementation requirement | **FIXED by deletion — §9.1.** The row goes with the machinery it exercised, along with the other four C3 lifecycle rows. §9.1's lost-ACK entry is now the accepted-residual test |
| **m2** | The completed reason inventory still says fourteen sites plus five tests while the table contains v10's fifteenth | **FIXED — the header, §3.6 and §5.2 all say fifteen.** The fifteenth is step D's capture-lane producer |

**What round 9 verified as closed, recorded because v11 keeps depending on it.** `sourceGlobalSeq` is
authenticated for every production entry path and remains a **required** reconciliation parameter in
spirit even though its C3 consumer is gone — the fact is a durable property of the codebase and is kept
in §13.8. `gitPlan.captured` is strict-read evidence on every capture path (forced capture only changes
incremental selection, basis fallback uses the same read, recompaction re-reads refs, config embedding
and normalization never rewrite `refs`, and `revertCapture` removes the membership); v11 no longer reads
it for a clear predicate, but §3.2b's discard clause and §9.1's assertions rely on the same property.
Step D's typed `deletion-pending` producer and its retiring-this-pass gate are both CLOSED.
**Round 9 reclassified nothing in §13.6's rounds-2-to-5 sweep, so the landmine arithmetic is unchanged
at 10 N/A / 12 moot / 12 carried = 34** — R4 B1 stays **carried**, because an admitted reachable shape
is carried whether the design closes it or accepts it, which is round 6's own rule.

**One disagreement with round 9's prescription, recorded rather than elided.** Its shortest list asks
to *"preserve multiple same-ref attempt generations, and give cap overflow a non-latching
disposition"* and to *"preserve/reduce the field in the legacy writer or fail closed when transactional
state persistence is unavailable"*. Both are correct repairs to the field. **v11 does neither, because
it removes the field**, which discharges all three of that list's first two items at once and leaves
item 3 (hidden-anchor suppression) and item 4 (the scoped qualifier and the withdrawn-rule test) fixed
on their own merits. A reviewer who believes the field is recoverable should read §12 C3's reversal cost
first: five rounds killed the authorizing form and four killed the withholding one.

**What v11 deliberately did not do, so round 10 can aim at it.** It adds no mechanism at all — this
revision is a deletion plus two bookkeeping clauses plus a scope qualifier. **Three claims are the ones
worth attacking:**

- **The residual is exactly as narrow as §3.2c says, and it does not latch.** Every conjunct is cited,
  but the conjunction is the claim. Three shapes would be blockers: a reachable state where a *second*
  consumption happens **without a second crash inside the window**; a re-creation at a value other than
  the tombstoned OID being pruned; or a path where neither the prune's own apply-pass state save
  (`apply.ts:1258-1275`) nor the next pull's §3.6 case (c) arm retires `BASE[R]`. The third is the
  sharpest, because non-latching rests on the retirement being **retried unconditionally** rather than
  on it landing the first time.
- **Recovery path 1 fires for every reachable form of this consumption.** It is verified for the
  tombstone-authorized `refs/heads/*` prune. A reachable variant of the same loss that reaches a
  *different* delete path — one where `prepareTombstonePrunePins` is not the pin producer, or where the
  current-branch checkout transition takes `prepareDisplacementPins` instead and the pin class matters —
  would narrow the recovery claim, and the honest response would be to state that narrowing here.
- **§3.2b's restored removal suppression composes with every other writer of `gitReposRemoved`.** v11
  restores the prior key inside the planner's copy and argues the two push saves therefore re-write
  `removedKey`. A writer that composes `removed` from somewhere other than `gitPlan.gitReposRemoved`, or
  a pull-side path that clears the memory between the planner and the save, would break it.
