# 270 — Held-followed repos join the held-skip fast path

Status: DRAFT r4 (serial-confirm fold: D1-D3 factual corrections + D4 blast-radius decision; both open questions RULED). r3 replaces r2's *inferred* root cause with a
**verified** one, read out of the Mac's live durable state
(`~/Development/.rbox/state/state.db`, `repo_records`, 2026-08-16
20:46Z) rather than from code reading alone. The r2 mechanism SURVIVES
whole and gets narrower: the eligibility predicate is tightened from
`code !== undefined` to the two "no proof was minted" hold codes, which
turns out to leave every existing eligibility pin green. r1's coverage
argument stays REFUTED (opus review): the refs/rbox-local artifact plane
— the composer holds' primary input — is deliberately fingerprint-
excluded, and r3 §2.5 now *proves* the artifact digest is load-bearing
rather than merely prudent. Evidence: GH #752 defect A (recon
2026-08-16, anchors on main 4f544f462). Parents: design 176/241
(held-skip + its protected ledger), 174 (the livelock class), 236
(deferral naming), #641 (the 9,381ms→8ms precedent). Codex
quota-benched; opus lanes.

## 1. Problem — root cause verified, not inferred

Three Mac repos (`mach-email`, `Personal/hacker-news-favorite-books`,
`Dfinitiv/.github`) re-run a full ~3.5s follow EVERY cycle, forever —
~half the Mac's 7.4-8s per-cycle git-apply. The fixpoint is
self-sustaining: `composeFollowRepoTransition`
(`follow-repo-transition.ts:321-331`) on a held follow re-arms
`pending`, sets an apply-lane deferral, retains the held attempt, and
reports `applied` — and that exact state vetoes every cheap path next
cycle: the steady bypass (`apply.ts:1168-1172` — deferrals/pending/
partial/attempt each individually disqualify), the unchanged shortcut
(`apply.ts:630` — `pend`), and #641's held-skip.

### 1.1 The single failing gate

`RBOX_TRACE_HELD` puts all three repos at `earlySkip=0
matchConsulted=1 mismatch=none earlyReason=retention-ineligible`.
`earlyReason=retention-ineligible` is written at exactly one place —
`held-decision.ts:191` — and means precisely: **the early matcher
MATCHED (`decision.matches === true`) and `retain()` refused.**
So the inputs, the classifier key, the fingerprint, the safety floor
and the racy-clean margin all already agree; only retention refuses.

`retain()` (`held-decision.ts:153-164`) has exactly two gates:

1. `heldBlockersAllowSkip(priorAttempt.blockers)` (`held-skip.ts:46-57`);
2. a standing apply deferral, OR ownership-only-with-no-escalate.

**Gate 2 is not the problem — refuted with durable state.** The
prior working hypothesis was that the composer transition's
`deferral: {kind:"set"}` lands somewhere `env.deferrals.standingApply`
cannot see. It does not: `standingApply` is
`currentDeferral(rel, "apply")` (`apply.ts:283`), which reads this
pull's transition and otherwise falls back to
`records[rel]?.deferrals?.apply` (`apply.ts:249-254`) — the **same**
durable repo-record map that `commitFollowTransition` →
`setDeferral` (`apply.ts:981-982`) writes the composer's directive
into. There is no second ledger and no split owner. Confirmed in the
field: all three repos carry a live `deferrals.apply` in
`repo_records.deferrals_cjson` right now —

| repo | `deferrals.apply.reason` | `reasonSince` |
|---|---|---|
| `mach-email` | `artifact` | 2026-08-16T06:34:43Z |
| `Personal/hacker-news-favorite-books` | `artifact` | 2026-08-16T06:34:11Z |
| `Dfinitiv/.github` | `local-commits` | 2026-08-16T06:34:44Z |

**Gate 1 IS the problem — confirmed with durable state.** Each repo's
stored `attempt.blockers` (`repo_records.attempt_cjson`) contains a
`provenance:"composer", reason:"artifact"` blocker minted by
`blockersAfterComposer` (`held-skip.ts:96-102`):

| repo | stored attempt blockers |
|---|---|
| `mach-email` | 1 × composer/artifact `missing-branch-proof` @ `refs/heads/main` |
| `Personal/hacker-news-favorite-books` | 1 × composer/artifact `missing-branch-proof` @ `refs/heads/main` |
| `Dfinitiv/.github` | 1 × composer/artifact `missing-branch-proof` @ `refs/heads/chore/cdk-diff-frontend-artifact-reuse` + 6 × ref-plane `local-commits` |

`heldBlockersAllowSkip` admits only `local-commits`, `local-stash`,
`local-index`, `local-operation`, `deletion-pending`, and (flagged)
`worktree-ownership`. `reason:"artifact"` is in none of them, and the
predicate is an `.every()`, so one composer blocker disqualifies the
whole repo. That is the entire defect. **Root cause: the retention
allowlist, `held-skip.ts:50-56`, consulted at `held-decision.ts:154`.**

Why the composer blockers exist at all in these three: two of them
(`mach-email`, `hacker-news-favorite-books`) have an EMPTY ref-plane
classification, so `causallyClassifiable` (`held-skip.ts:80-85`)
is false and every hold survives unmapped; `.github`'s hold is at a
branch its classification does not name, so `causallyMapped`
(`:86-92`) cannot neutralize it. Both are legitimate composer output —
270 does not touch that mapping.

### 1.2 A trace blind spot to fix alongside

The trio prints `blocker=none`, which is NOT evidence about their
blockers. `emitTrace` (`held-decision.ts:288-295`) only names a blocker
from `noteBlockers` (called only on the `follow.status === "defer"`
path, `apply.ts:1045`) or from the standing deferral **when
`result === "deferred"`**. The composer-held path returns
`result: "applied"` (`follow-repo-transition.ts:319`), so neither
source fires. The diagnostic is blind on exactly the population it was
added to explain. r3 extends the deferral fallback to any result whose
repo carries a standing apply deferral (one-line, diagnostic-only) so
the field close-out can read the blocker without a state dump.

### 1.3 Control group

The two healthy held repos — `Personal/rbox-admin`
(checkout/`local-commits`) and `Personal/home-dashboard`
(`local-index`/`local-operation`) — are allowlisted → `earlySkip=1` at
25-37ms with one full re-prove per hour
(`HELD_SKIP_SAFETY_FLOOR_MS`, `held-skip.ts:29`). `Personal/rbox-core`
is a fourth, unrelated case: `storedAttempt=0
earlyReason=no-attempt`, the attempt-shredder (`apply.ts:833-836`)
firing every cycle — that is #752-B and out of scope here.

## 2. Mechanism — one gate widened, one bracket added

### 2.1 The fix: admit "no proof was minted" composer holds

Widen the ONE consumer of the allowlist. Eligibility predicate for a
composer blocker:

```
provenance === "composer" && reason === "artifact"
  && (code === "missing-branch-proof" || code === "missing-safe-ref-proof")
```

`heldBlockersAllowSkip` stays a single `.every()` over the existing
reason allowlist plus this disjunct; it keeps its one call site
(`held-decision.ts:154`) and its existing signature. No new predicate,
no new authority, no change to `blockersAfterComposer`'s output.

Why exactly these two codes. `RepoBaseHoldCode` splits cleanly into
"the follow minted no proof for this ref" (`missing-branch-proof`,
`missing-safe-ref-proof`) and "a proof exists and CONTRADICTS the
composer" or "the request was structurally refused"
(`mismatched-branch-proof`, `mismatched-safe-ref-proof`,
`p-repair-shape-mismatch`, `manual-proof-mismatch`, `scope-refused`,
`wrong-ref-class`, plus the synthetic `checkout-incomplete`). The
first class is the same causal shape as a ref-plane hold — the ref did
not advance, and re-running the follow reproduces the same nothing.
The second class is an independent veto, or evidence of a state the
skip's input bracket does not observe; it stays ineligible. The
existing suite already drew this exact line by hand
(`held-skip.test.ts:166, 225, 236, 257, 268, 284` all pin
mismatched/`scope-refused`/`checkout-incomplete`/foreign-provenance to
`false`), so **every existing eligibility pin stays green under the new
predicate** — the change is purely additive at a boundary the tests
already encode. r2's `code !== undefined` did not have this property:
it would have admitted `scope-refused` and `checkout-incomplete` and
flipped two deliberate pins.

Also structurally excluded, for free: the vacuous composer mint
(`held-skip.ts:111-118` — no `code`, no `ref`; an unexplained pending
disposition must stay non-vacuously blocking, its own comment's rule);
`checkout-incomplete` (`:103-110` — no `ref`, and working-tree-shaped,
241's exact exclusion); and protocol/checkout/boundary provenances that
also mint `reason:"artifact"` — never analyzed, never admitted.
`missing-safe-ref-proof` is admitted by symmetry with
`missing-branch-proof` (it is the safe-ref mirror of the same "no
witness" outcome, and `causallyMapped` already pairs it with
`local-stash`); it is unexercised in today's field data, so it ships
with its own fixture rather than on inference.

Guarded invariant (reviewer N11) retained: composer eligibility
additionally requires the stored proof's `checkoutComplete === true`.
Today the only `recordClassification` feed passes `checkoutComplete`
hard-true (`apply.ts:1028-1034`), so this is a pin, not a branch —
but it stops a future composer call site with a working-tree-dependent
disposition from silently inheriting the license. If it cannot be read
from the stored attempt without widening `GitHeldAttempt`, the
`checkout-incomplete` blocker's presence is its durable proxy and the
`ref`-bearing predicate above already excludes it.

### 2.2 What this fix is NOT

Two candidate owners were considered and rejected as **fixes to a
non-defect**: (a) making `composeFollowRepoTransition` "register" the
standing apply deferral — it already produces the directive, and
`commitFollowTransition` already writes it to the one durable lane;
(b) making `retain()` consult the record's deferral map — it already
does, through `currentDeferral`'s fallback. The deferral lane has one
owner and it works. The re-standing semantics at
`held-decision.ts:157-163` (restand on skip, clear only for
ownership-only under no-escalate) are therefore UNCHANGED, and stay
coherent: composer-held repos always take the `restandApply` arm
because a composer blocker makes `ownershipBlockersArePerRefOnly`
false by construction.

### 2.3 The artifact-plane digest — now proven necessary

r2 carried this as the bracket that "licenses everything else". r3
verifies the argument end to end, and it holds:

1. Composer holds are a function of the artifact plane. `composeRepoBase`
   gates branch proofs on `locked.artifactsClear`
   (`base-composer.ts:493`), and the P/K artifact refs are what a user
   repair mutates.
2. `gitFingerprint` cannot see it: it filters refs through
   `isSyncableRef` (`fingerprint.ts:195, 215`), and the rbox artifact
   namespaces are non-syncable by construction
   (`base-artifacts.test.ts:163, 285`).
3. The compensating control — `standingPInvalidatedAttempt`
   (`apply.ts:833-836`) — is computed AFTER
   `prepareFollowerBranchProtocol`, i.e. inside the expensive path. It
   protects the LATE gate (`apply.ts:909-910` passes
   `!standingPInvalidatedAttempt`) and **cannot** protect the EARLY gate
   at `apply.ts:1224`, which by design runs before any of that work.
4. #641's shipped allowlist never needed it: `local-*` blockers have
   worktree/ref-plane causes the fingerprint already covers. Composer
   holds are the first eligible class whose cause is fingerprint-
   invisible.

So the two fixes COMPOSE and neither is sufficient alone: §2.1 is why
these repos do not skip; §2.3 is what makes skipping them sound. Ship
them together.

Mechanism unchanged from r2: a single `for-each-ref` over the rbox
artifact namespaces (`refs/rbox-local/base-{absent,present,
present-keep}/v2`, `refs/rbox-local/base-absent-settled/v1`,
`refs/rbox-recovery/base-present/v2` — `base-artifacts.ts:13-16`,
`base-artifact-scan.ts:45-48`), refname+oid hashed, produced by
`observeHeldInputs` (so it lands in the stored attempt via
`createHeldAttempt`) and compared by `earlyHeldAttemptDecision`
(`held-skip.ts:309-343`) — the same primitive as
`readWorktreeRegistryDigest` (`:184-193`). This closes the
fingerprint's deliberate rbox-ref blindness for the skip path only;
`gitFingerprint` itself is untouched (241 ledger: never widen it).

### 2.4 Early-gate partial identity

The early gate compares only version/registry-typeof/attempt-time/
floor/classifier-key/fingerprint (`held-skip.ts:318-338`) — it never
looks at `record.partial`, so a `pRepaired` write
(`p-repair-state.ts:78-90`, the durable trace of a user repair) is
invisible to it, and the shredder that would catch it is again
downstream. The stored attempt ALREADY carries the whole partial
canonically as `partialDisposition` (`held-skip.ts:226-228`), so this
is one comparison against a field that already exists: the record is in
hand at `apply.ts:1224`. No second predicate, no new I/O beyond §2.3's
one `for-each-ref`.

### 2.5 The attempt-shredder stays

`standingPInvalidatedAttempt` (`apply.ts:833-836`, incl. the `pRepaired`
disjunct) is KEPT VERBATIM — provenance (#385) shows it shipped as
held-skip eligibility hardening: it is the one pre-digest place a pull
re-reads the artifact plane. Note it is NOT made redundant by §2.3 the
way r2 assumed: the digest covers the early gate, the shredder covers
the late gate's `presentArtifacts` signal, and only the shredder sees
protocol-prepare output. Retiring it is a separate change with its own
evidence per the feature-retirement rule. r1's narrowing stays
WITHDRAWN.

### 2.6 Not changed

`composeFollowRepoTransition` re-arm/deferral semantics; the hourly
floor; ordered deferral refresh; every 241 ledger row; push-side gag
(174/#752-B owns convergence — this design removes cost only);
`blockersAfterComposer` output shape; design 251 buckets;
`retain()`'s deferral re-standing/clearing arms (§2.2). Pin (reviewer
N10): the skip re-stands the STORED `subjectKey`; a bundle recapture
staling it drops `reproof` on the next full follow — asserted as a
fixture, not assumed away. The ONE other edit in this design is
diagnostic-only: `emitTrace`'s `blocker=` fallback stops requiring
`result === "deferred"` (§1.2), so an `applied`-but-held repo names its
standing deferral instead of printing `none`.

## 3. Protected contract (241's ledger, inherited whole)

Pre-fetch skip placement; semantic-key invalidation on semantic section
change; legacy late-match upgrade; blocker-plane retention; hourly
forced retry; fail-open observation (skip decisions never fail the
apply); state nonce/BASE/partial/reflog bindings; ordered deferral
refresh; pending/partial/BASE authority; NO second predicate in
apply.ts; NO widening git fingerprint to workspace content; NO manifest
oracle in the early gate. Plus: `blockersAfterComposer`'s output shape
unchanged (only the allowlist + key coverage change); design 251 bucket
accounting unchanged.

## 4. Per-repo evidence + honest expected effect

`RBOX_TRACE_HELD=1`, Mac, 2026-08-16 20:42-20:43Z, joined with the
durable `repo_records` row read at 20:46Z (`state.db`; blockers and
deferral columns are state, not trace).

| repo | storedAttempt | earlySkip | matchConsulted | mismatch | earlyReason | trace blocker | allMs | durable `attempt.blockers` | `deferrals.apply` |
|---|---|---|---|---|---|---|---|---|---|
| `mach-email` | 1 | 0 | 1 | none | retention-ineligible | none¹ | ~3.5s | composer/artifact `missing-branch-proof` @ `refs/heads/main` | `artifact` |
| `Personal/hacker-news-favorite-books` | 1 | 0 | 1 | none | retention-ineligible | none¹ | ~3.5s | composer/artifact `missing-branch-proof` @ `refs/heads/main` | `artifact` |
| `Dfinitiv/.github` | 1 | 0 | 1 | none | retention-ineligible | none¹ | ~3.5s | composer/artifact `missing-branch-proof` @ `refs/heads/chore/cdk-diff-frontend-artifact-reuse` + 6 × ref-plane `local-commits` | `local-commits` |
| `Personal/rbox-admin` (control) | 1 | 1 | — | — | none | checkout/`local-commits` | 25-37ms | checkout/`local-commits` (×N) | — |
| `Personal/home-dashboard` (control) | 1 | 1 | — | — | none | `local-index`/`local-operation` | 25-37ms | `local-index`, `local-operation` | — |
| `Personal/rbox-core` (#752-B) | 0 | 0 | 0 | none | no-attempt | apply/`artifact` | — | *(none — shredded every cycle)* | `artifact` |

¹ `blocker=none` here is the §1.2 instrumentation blind spot, not an
absent blocker. The durable columns are the authority.

Expected effect, per repo:

- `mach-email`, `Personal/hacker-news-favorite-books` — FIXED. Their
  only blocker is an admitted `missing-branch-proof`, the matcher
  already returns `matches`, and the standing deferral is present, so
  `retain()` succeeds on the first cycle after the change: ~3.5s →
  25-37ms, with the hourly full re-prove retained.
- `Dfinitiv/.github` — FIXED. r2 guessed this one might be disqualified
  elsewhere; the durable row refutes that. Its six ref-plane
  `local-commits` blockers were already allowlisted and its single
  composer blocker is a `missing-branch-proof`, so the whole `.every()`
  passes. Same 3 of 3, not 2 of 3.
- `Personal/rbox-core` — UNAFFECTED, by design. It never reaches
  retention (`storedAttempt=0`): the shredder clears its attempt every
  cycle because standing P work is present. That is #752-B's defect and
  #752-B's fix; 270 must not be credited or blamed for it.
- Controls (`rbox-admin`, `home-dashboard`) — UNCHANGED. The predicate
  only adds a disjunct; their blockers already passed.

Workspace-level: ~10.5s of per-cycle git-apply removed on the Mac
(3 × ~3.5s), leaving `rbox-core`'s follow as the dominant remaining
cost. Field close-out re-measures both lanes per the perf rule.

### 4.1 Field close-out watch items (implementation round)

Three consequences are expected, bounded, and NOT defects — but the Mac
close-out should name each explicitly rather than discover it as a
surprise:

1. **Shared-ref-store invalidation on worktree-heavy hosts.** The
   artifact plane lives in the shared common dir, so every linked
   worktree of one repository reads the SAME digest. A P/K write for any
   one of them invalidates the stored attempt of ALL of them. On hosts
   with many linked worktrees per repo this dents the skip hit-rate in a
   way the single-worktree field data does not show. It is correct — the
   composer reads that same shared plane — but it is the first thing to
   check if measured hit-rate lands below §4's prediction.
2. **One re-follow per held repo on the first pull after upgrade.**
   Attempts stored before this change carry no digest, so every held
   repo takes the full path exactly once while the digest is minted
   (~5 × 3.5s on the Mac, one time). A second consecutive pull showing
   the same cost is the real signal; the first one is expected.
3. **Reflog-only moves stay invisible to the early gate** until the
   hourly floor. That is #641's deliberate subset — the early gate never
   observed reflogs, only the late matcher's `reflogs` digest does — but
   270 now points that gate at a hold class whose `missing-safe-ref-proof`
   arm is stash/reflog-adjacent. The bound is one hour, and §7 D2's
   coverage argument (stash reflog is an attempt input via
   `finalReflogPaths`, tags/stash are fingerprint-covered) is what keeps
   it sound; re-read that argument if a stash-shaped repo misbehaves.

## 5. Validation

- Red-first: composer-held fixpoint repo re-follows on identical inputs
  → skips after; hourly floor still forces full re-prove.
- Artifact-plane invalidation (the C1 scenario, pinned): write/delete a
  `refs/rbox-local/base-present/v2/*` ref between cycles → NEXT pull
  runs the full path (no hour-long pin after a user repair); same for a
  `pRepaired` write.
- Semantic invalidation: remote section change → full; bundle recapture
  with identical section → skip retained; subjectKey-drift fixture
  (N10).
- Vacuous-mint exclusion + provenance scoping fixtures (protocol-,
  checkout-, boundary-minted `artifact` blockers stay ineligible).
- Hold-code scoping: `held-skip.test.ts`'s existing eligibility pins
  (`:166, 225, 236, 257, 268, 284`) and `follow.test.ts:2264, 2302` must
  stay green UNMODIFIED — the predicate is additive at the line those
  tests already drew. NEW pins: `missing-branch-proof` and
  `missing-safe-ref-proof` (alone, and mixed with allowlisted ref-plane
  reasons) → eligible; every other `RepoBaseHoldCode` → ineligible,
  enumerated so a new code added later defaults to refusing.
- Trace regression: an `applied`-but-held repo prints its standing
  `apply/<reason>` blocker (§1.2), and a skipped repo still prints the
  attempt's named blocker.
- Differential (re-specified per reviewer M8): durable record equality
  after N cycles (`base`, `branchBaseOrigins`, `pending`, `partial`,
  `deferrals`, `attempt`, `idxProj`) skip-on vs skip-off, PLUS the
  journal published-and-cleared pair asserted as a no-op — NOT naive
  per-cycle record identity (the held follow legitimately writes
  baseAdvance/indexProjection/journal that a skip does not).
- Kill switch: NEW scoped flag `RBOX_GIT_HELD_SKIP_COMPOSER` (default
  ON, defaults-ledger registered; owner: this design; deletion
  condition: one clean fleet soak). `RBOX_GIT_HELD_SKIP=0` remains the
  whole-mechanism lever — wrong blast radius for rolling back only this
  change (it would revert #641's shipped win too).
- Field: Mac re-measured; all three trio repos' follow lines drop to
  ~hourly (§4 predicts 3 of 3 — a residual is a falsified prediction,
  not an acceptable outcome); `Personal/rbox-core` expected UNCHANGED
  until #752-B lands; both lanes.

## 6. Open questions (r3)

1. `checkoutComplete` is not a field of `GitHeldAttempt`. §2.1 keeps
   reviewer N11's guard via the structural proxy (a `checkout-incomplete`
   blocker is refless, so the predicate excludes the whole set). If a
   reviewer wants the invariant asserted directly, that costs a new
   attempt field and a compatibility path — decide before implementation,
   not during.
2. `missing-safe-ref-proof` is admitted on symmetry, not on field
   evidence. Alternative: ship `missing-branch-proof` only and add the
   safe-ref code when a repo exhibits it. Cheaper to ship both with a
   fixture than to re-open the predicate later; flagged for the review
   round.
3. Why do `mach-email` and `hacker-news-favorite-books` produce a
   composer hold at `refs/heads/main` with an EMPTY ref-plane
   classification at all? 270 removes the cost of re-deriving that
   answer every cycle but does not answer it — it is the same
   convergence question as 174/#752-B, and the hourly re-prove remains
   the only thing that will ever clear it. Worth naming in #752-B.
4. `Dfinitiv/.github`'s hold ref is a branch its classification does not
   list. Benign for eligibility, but it means `causallyMapped` cannot
   neutralize holds for refs the classifier stayed silent about —
   possible follow-up for the mapping's own owner, out of scope here.


## 7. Serial-confirm fold (r4)

- D1/D2 corrections: `checkoutComplete === false` IS reachable in stored
  attempts (`apply.ts:1033` passes the live value) — the exclusion is by
  CODE, proven as a biconditional: composer blockers exist only under a
  pending disposition (`held-skip.ts:76`); `!checkoutComplete` there
  unconditionally mints the `checkout-incomplete` blocker (`:103-110`);
  that code is not admitted → composer eligibility ⟺ checkoutComplete.
  §6-Q1 CLOSED: no GitHeldAttempt widening, no compat path.
- D3: r2's `code !== undefined` predicate would have flipped ≥7 pins
  (not two) — retrospective corrected; the tightening's case is stronger.
- §6-Q2 CLOSED: ship BOTH codes. Safe-ref inputs are a strict subset of
  the branch bracket (tags/stash are SYNCABLE → fingerprint-covered;
  `lockedProof.safeRefs` never consults artifactsClear; stash reflog is
  an attempt input via `finalReflogPaths`) — provable coverage, not
  symmetry. Fixture stays.
- D4 DECIDED: `RBOX_GIT_HELD_SKIP_COMPOSER` gates §2.1 (predicate) AND
  §2.3 (artifact digest) together — off = digest neither observed nor
  stored, so the flag's radius equals the change's; one self-healing
  mismatch cycle on toggle. §2.4 (partial identity incl. pRepaired at
  the early gate) stays UNFLAGGED: it closes a live pre-existing #641
  hole (early skip runs before the shredder, so a pRepaired write could
  be skipped past today) — a correctness tightening for all attempts.
- §5 additions: control-group regression pin (existing local-* held repo
  still skips across N cycles with the digest live); artifact-plane
  WRITER-ORDERING requirement (every writer must land before
  classification or inside rebindHeldAttemptsAfterSettlement's
  pull-ref-transaction/journal-recovery reach — enumerate writers at
  implementation, red-first case backstops); impl notes: early gate
  gains repoDir from before.diskCtx (fail-open new reason when absent),
  digest read sits inside the two-fingerprint bracket, §2.4 reuses
  partialDisposition's exact canonicalization and earlySkip's input
  widens by records[rel].partial.
- Pre-existing gap noted, not owned here: no RBOX_GIT_*HELD_SKIP* flag
  is defaults-ledger-registered today; the new flag WILL be.
