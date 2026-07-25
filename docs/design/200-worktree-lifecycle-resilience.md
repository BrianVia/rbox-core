# 200 — Worktree lifecycle resilience: capturing out-of-band branch deletion

Status: DESIGN v5 — 2026-07-24. Codex round 3 (`REVIEW-200-R3-CODEX.md`, kept beside this
file) closed 10 of round 2's 17 findings and returned **NOT-ALIGNED** with 6 new blockers and
5 new majors (§13.3). **Two of the three items on its blocking list were P4's**, and folding
round 3 in produced a **founder product ruling of the same date (R5) that removes P4 from the
design entirely** (§4.4, §12 Q5). What remains — P1, P1b, P2, P3 — is smaller, cheaper, and
default-on with no staged flip.
Author: Claude, from first-hand field forensics on the founder's Mac, 2026-07-24.

Changes in v5 — the four that change what gets built:

1. **RULED (R5): P4 is CUT** (§4.4, §12 Q5). This reverses the same day's Q5 in-scope ruling,
   **on new evidence**:
   - **three shapes failed three adversarial rounds**, each on a *different* closed
     invariant — hybrid BASE (bundle coverage + the deep-equality dry-run, round 2),
     BASE-follows-published (the `logicalBaseRefs` physical pre-state guard, self-rejected in
     v4), mutual exclusivity (self-echo, because published values never enter BASE, round 3);
   - **the propagation win P4 was justified by already works.** The merged rig scenario
     `scripts/rig/scenarios/worktree-squash-lifecycle.ts` (`ad0b3408`, #446) asserts that an
     unrelated change reaches the peer past a live worktree hold, and that assertion **passes
     on merit today** through design 174's supersession, because the unrelated transition is a
     fast-forward.

   What P4 uniquely bought — publishing past a **divergent** held ref without carrying the
   pending section as bookkeeping — is bounded by the worktree's lifetime and consistent with
   the founder's ruled semantic that holding a ref while a worktree holds it is legitimate. Its
   real fix is a **per-ref wire model**, parked as
   **[design 201](./201-per-ref-git-publishing.md)**, likely 2.0-era alongside design 163's
   SQLite state plane. §4.4 is now a superseded record: the three shapes, the round-3 blocker
   list, and the `gitCommitAncestry(Y, Y)` landmine 201 must carry forward. The cut removes the
   design's only default-OFF step, its only bake condition, its only new persisted field, its
   only positive cost, and its only wire-content change.
2. **The omission is owed until it is published** (§3.6a step A″). Round-3 blocker 2: A′ closed
   "A written → BASE not retired", but "BASE retired → omission not published" let this
   device's **own** stale advertisement re-create the ref as an ordinary creation, destroying
   the receipt inside the creation's transaction (`branch-transition.ts:136-152`). A″ adds a
   durable `owed` predicate — BASE absent ∧ receipt ∧ strictly-absent live ref ∧
   `record.advertised.refs[R]` still naming the retired value — keyed on **durable state, not
   in-memory state**, so it survives any number of crashes. Nine-row double-crash matrix
   included; §7 invariant 2 now has the mechanism v4 asserted without one.
3. **One receipt projection, covering the settled-Z arm** (§3.2a). Round-3 M1: `priorOid` was
   projected for a live A (`follower-protocol.ts:87-100`) and **not at all** for a settled Z
   (`:105-107`), so a literal v4 implementation would carry forever on every receipt that had
   settled — the normal steady state. One `absenceReceipt` projection feeds the pre-probe (which
   today cannot even see it — `pendingSupersessionPreProbe(root, relPath, pending)`), the final
   proof, and A′/A″. **A″ cannot be written without it.**
4. **`gitStatus` gets one contract instead of two contradictory ones** (§3.3a). Round-3 M3: v4
   said "spawn/IO faults still reject" *and* mapped them to `code: null`, and no normalized
   result can reproduce today's four distinct failure shapes — a numeric `code`, a **string**
   `code` (`"ENOENT"`), and spawn-path `maxBuffer` errors with **no `code` at all**. v5 states it
   once: **nothing rejects; every failure is data**, carrying `exit: number | null` (numeric iff
   the child ran to completion) *and* `cause`, the exact error today's `gitRaw` throws — so
   `gitRaw` becomes `throw r.cause` and is byte-identical by construction rather than by
   reconstruction. Round-3 M2 rides along: A′'s locked proof gets a stated lock lifetime,
   `local-absence` joins the terminal-revalidation filter (`apply.ts:1900`), and that site's
   `readAllRefs` (`apply.ts:1903`) becomes a **fourth** mandatory strict-read location, because
   for an absent witness it compares `null !== null` and passes on a totally failed read.

Also in v5: the two `shared.ts` files the design had been conflating are disambiguated
(`src/engine/git/shared.ts` for the runner; `src/cli/sync-git/shared.ts` for
`incrementalCapturePlan`), and §9.6 carries an explicit instruction to **relax** the merged rig
scenario's phase-1 gag assertion to match the ruled semantic — tolerate a carried pending
section while the hold lives, keep asserting propagation and the absence of a whole-repo
deferral surface. That relaxation is **reversed** if design 201 ever ships.


**Earlier revisions, compressed — the full reasoning for each lives in the section named.**
Kept as pointers rather than prose because §12 (rulings) and §13 (review record) are the
authoritative versions, and three v4 items plus two v3 items are now mooted by R5.

*v4 (seven items):* **(1)** RULED **R4** — rbox promises *file* history, not Git history, which
removed the mass-absence circuit breaker and all its threshold arithmetic, the deleting device's
90-day keep-pin, and `rbox git deleted` (§3.0a, §3.5, §3.7, §7.2, §12 Q2/Q2b/Q3). **(2)** P1b's
absence receipt bound to the exact pending predecessor, `receipt.priorOid === pending.refs[R]`
(§3.2). **(3)** Crash recovery for an existing A artifact, above the unchanged shortcut — step
A′ (§3.6a). **(4, 5, 7)** P4's redesign: partial settlement replaced by "carrying and settling
are mutually exclusive", the merged section made refs-only with every other facet carried
verbatim, and §3.3b's restore detection re-framed as detection hardening rather than a
guarantee — ***(4) and (5) are mooted by R5*** (§4.4); (7) stands (§3.3b (iii)). **(6)** The
strict ref read given a real API (§3.3a, itself rewritten in v5).

*v3 (eight items):* the breaker's arithmetic corrected from `max()` to `OR` and the
counterexample recorded (**superseded by R4**, §3.5); the deleting-device pin added by R3
(**superseded by R4**, §3.7); the strict ref read introduced on every absence-authority path
(§3.3a); P1's control flow specified end to end (§3.6a); P3 demoted to cascade reduction and
structurally barred from destructive transitions (§4.3); the deletion semantic scoped honestly
to v1.6.8 and newer by R2 (§3.0); and two P4 items — the held-ref-aware publisher ACK and the
`partially-superseded` third outcome — both **mooted by R5** (§4.4).


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
(`130:177-187`) is right, and the guard is what enforces it. The fix is that **an
out-of-band deletion of a published branch must be captured as a first-class, locked
absence receipt** — the A-artifact transition rbox already performs, but today only
under explicit human confirmation — and then published through the existing design-130
tombstone path. Nothing on the wire changes.

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
stated plainly in §3.0a rather than mitigated with arithmetic.

Alongside it, two smaller changes make mode (a) cheaper: make the ownership hold held-skip
eligible (with a worktree-registry digest in the skip bracket), and stop a non-HEAD hold
deferring the whole repository. A third — the founder's validated patch-id recipe,
generalized to rbox's durable-roots model so it needs no `origin/main` concept — reduces
the *cascade* a squash-merged branch causes, and v3 is careful not to claim more than that
(§4.3).

**What this design does *not* do, stated here because v2–v4 all promised it — RULED
2026-07-24 (R5), §4.4.** None of P1–P3 ungags a repository whose worktree holds a
**divergent** branch: that repository keeps carrying its pending section for as long as the
worktree lives. v2 claimed P2 fixed it, v3 and v4 answered with **P4** (`pending ⊕ local`), and
R5 cuts P4 after three shapes failed three adversarial rounds. The residual is accepted and
bounded, and §4.2 states it in three parts: a divergent hold keeps the section carried;
unrelated work still propagates wherever its transition is a fast-forward, through design 174's
supersession — which the merged rig scenario shows **passes on merit today**; and everything
clears at worktree deletion through P1/P1b, which is the gate this design ships. The honest fix
is a per-ref wire model, parked as
**[design 201](./201-per-ref-git-publishing.md)**.

**Cost is negative in wall clock and free at rest, with no positive-cost item anywhere.** The
new checks are O(1) per BASE head in the negative case and are gated behind proofs that already
failed, while making ownership holds held-skip eligible removes a full follow per cycle from
exactly the repositories that suffer today. **P1's standing cost is zero** — v3 carried R3's
~900 hidden recovery refs and their effect on `git gc`, and R4 removed the pin, so the only
per-deletion work is one ref transaction and one state CAS. **R5 removed the last recurring
cost**: P4 would have replaced a byte-for-byte pending carry that uploads nothing with an
ordinary capture-encrypt-upload every cycle a hold was outstanding. v1's blanket "net cost is
negative" is true again for the whole design, which it was not in v3 or v4 (§6).

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
(`src/cli/sync-git/publisher-tombstones.ts:108-122`: `advertised.refs[R] = X`,
`candidate.refs[R] === undefined`, so a tombstone at `X` is emitted). But BASE keeps
`R = X`, so the composed BASE cannot deep-equal the candidate and
`pendingSupersessionAckConverges` (`pending-supersession.ts:35-62`, pinned by
`pending-supersession.test.ts:51-66`) refuses. And the next time anything forces a follow,
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

1. **Deletion is authoritative, so it must be receipted.** Publishing a deletion is a
   destructive claim about other machines' repositories. That is exactly why §3.2's
   absence receipt is a locked A artifact and not a BASE edit, and why §3.3's witness has
   eight conditions.
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
or lets a BASE member vanish without a receipt, walks straight back into that finding.

**The guard stays. The deletion should have been captured when it happened.**

### 3.2 The missing authority: a local-absence receipt

rbox already performs the required transition — but only under `manualResolution`, at
`follow.ts:875-888`:

```ts
const plan = await planManualBranchTransition({
  repoDir, binding, ref, physicalBeforeOid: null, afterOid: null, logicalBaseOid });
const committed = await commitPlannedBranchTransition(plan, async () => {
  const lockedRefs = await readAllRefs(opts.ctx.repoDir);
  const lockedOwned = await branchesCheckedOutElsewhere(opts.ctx);
  if (lockedRefs[ref] !== undefined || lockedOwned.has(ref))
    throw new Error("manual absent branch changed at locked proof");
});
```

This is the case design 130 anticipated at `130:940-957`: "If R is already absent while
prior BASE is present, confirmed manual authority uses `verify R absent + create A` before
BASE may become absent." It writes a real A artifact (`prepareBaseAbsentArtifact`, via
`branch-transition.ts:217`), commits it in one prepared expected-old transaction with a
locked second proof of absence, and yields an `absent` `BranchTransitionWitness` that
`composeRepoBase` accepts as authority to retire the BASE member.

**Proposal P1.** Promote that from human-confirmed to autonomous **absence capture**,
gated on a deletion witness (§3.3), with its own `ComposeRepoBaseAuthority` member so the
audit surface stays explicit:

```ts
| { kind: "local-absence"; lineageHash: string; repositoryIdentityHash: string;
    episode: string; branchWitnesses: Readonly<Record<string, BranchTransitionWitness>> }
```

It accepts only `absent` witnesses for `refs/heads/*`, requires
`before === witness.priorOid && requested === null`, and reuses `branchProofMatches`
(`base-composer.ts:246-260`) unchanged. Adding a member is deliberate rather than
reusing `manual`: `130:286-323` makes the union closed and
`base-composer-structure.test.ts` enforces exhaustiveness, so a new authority cannot be
smuggled in, and confusing autonomous absence with human confirmation would weaken the
`manual` arm's meaning.

**Where it runs.** In the apply lane, before `publishRefPlane`, using the artifact binding
and repository locks that `prepareFollowerBranchProtocol` has already established
(`follower-protocol.ts:61-71`). Running it before capture is not optional — see §3.6.

**Nothing on the wire changes.** Once BASE has retired `R`, the ordinary capture omits it
and `normalizePublishedGitSection` (`publisher-tombstones.ts:108-122`) authors the
authenticated tombstone at `X` it already knows how to author. Followers then run the
existing design-130 attestation path (`tombstone-attestation.ts`, consumed at
`follow.ts:774-787`) and prune only when live value, logical BASE, tombstone history and
locked proof all agree. Every receiver keeps its own veto.

**Proposal P1b — unblock the pending lane.** `pendingSupersessionPreProbe`
(`pending-supersession.ts:103-105`) and `provePendingSupersession` (`:198-209`) must stop
treating a missing head as an automatic carry. New per-ref rule for `refs/heads/*`:

| Local state of a pending head `R` | Disposition |
|---|---|
| present and equal, or a fast-forward descendant | supersede (today's rule) |
| absent, and a current-lineage A / settled-absence receipt exists **whose `priorOid` equals `pending.refs[R]`** | **supersede** (new) |
| absent, receipt exists but `priorOid !== pending.refs[R]` | **carry** (new in v4 — see below) |
| absent, no receipt | carry (today's rule — fail closed) |

Tags and `refs/stash` keep their exact-equality rule (`pending-supersession.ts:106-108`,
`:203-204`) untouched: safe refs have never had A/P/K semantics and design 130 forbids
substituting one witness class for the other.

**The receipt must name the value it retires — new in v4, and it is a blocker fix.** v3's
rule admitted an absent pending head whenever *any* current-lineage receipt existed for it.
That is not sufficient, and the counterexample destroys another writer's work:

> BASE and local hold `R = X`. Another writer advances `R` to `Y` and publishes; this device
> has not applied it, so `pending.refs[R] = Y`. The user then deletes `R` here, and absence
> capture writes an A artifact with `priorOid = X`. Under v3's rule that receipt authorizes a
> candidate omitting `R` — so the omission supersedes `Y`, and `Y` is retired fleet-wide by a
> device that never held it. The wire tombstone this device authors covers `X`, not `Y`, so
> the receivers' attestation would refuse the prune — but the *pending supersession* has
> already thrown `Y` away locally, and the next capture no longer carries it.

**The rule.** Supersession of an absent pending head requires
`receipt.priorOid === pending.refs[R]`. The receipt is the exact retirement of the exact
value the pending section claims. `follow.ts:857` **already gates its crash reconstruction on
exactly this equality** (`reconstructedAbsence?.priorOid === baseOid`), so the *rule* is a
transposition of an existing in-tree pattern onto a second consumer, not a new proof
obligation. What is **not** already in place is the projection it reads from — see below.

#### 3.2a The one receipt projection — new in v5, and it is a blocker fix

v4 said `priorOid` "is already projected" and cited
`absenceWitnesses[R].priorOid` (`follower-protocol.ts:83-114`). **That is true for the live-A
arm and false for the settled-Z arm**, and the Z arm is the *normal* steady state, so a literal
implementation of v4 would carry forever on every ref whose receipt had settled. Verified:

| Arm | What `prepareFollowerBranchProtocol` does today | `priorOid` available to a consumer? |
|---|---|---|
| **live A** (`scan.absent`, `follower-protocol.ts:87-100`) | deletes `logicalBaseRefs[ref]`, sets `disposition.absence = "valid-owning"`, **and** populates `absenceWitnesses[ref]` with `priorOid`, `artifactRef`/`artifactOid`, `source: "a"` | **yes** |
| **settled Z** (`follower-protocol.ts:105-107`) | deletes `logicalBaseRefs[ref]` and sets `disposition.settledAbsence = "valid-owning"` — **and nothing else** | **no.** No witness, no `priorOid`, even though the value being iterated (`settled.ledger.entries.values()`) *is* a `BaseAbsentPayload` carrying `priorOid` |

**The fix is smaller than it looks, and cheaper than codex's suggestion.** Codex proposed
feeding `lookupSettledAbsence` (`base-artifacts.ts:442-445`) into the consumers. That is not
needed: the Z loop already has the payload in hand. Populate `absenceWitnesses[payload.ref]`
from it in the same loop, with `source: "z"`:

- The witness type **already anticipates this shape** — the absent arm of
  `BranchTransitionWitness` is `{kind:"absent"; ref; priorOid; lineageHash;
  repositoryIdentityHash; artifactRef; artifactOid; source: "a" | "z"}`
  (`base-composer.ts:47-57`), and the `"z"` member exists today with live consumers that
  branch on it: `settleCommittedBranchArtifacts` skips a z-sourced witness rather than
  re-settling it (`apply.ts:1963`), and the pre-state-save revalidation re-reads the A
  artifact only when `witness.source === "a"` (`apply.ts:1910`). So this is filling in an
  anticipated projection, not widening a type.
- `artifactRef` is the Z ledger's ref and `artifactOid` the leaf OID for that branch
  (`ledger.entryOids.get(branchRefHash(ref))`, built at `base-artifacts.ts:432-436`).

**One projection, three consumers.** Define it once so no consumer can miss an arm:

```ts
/** The current-lineage absence receipt for R, from either the live A artifact or the
 *  settled-absence ledger. Absent ⇒ no receipt ⇒ carry (fail closed). */
type AbsenceReceipt = { priorOid: string; source: "a" | "z"; artifactRef: string; artifactOid: string };
absenceReceipt(R): AbsenceReceipt | undefined   // = branchProtocol.absenceWitnesses[R]
```

and feed it to **all three** places that need it, none of which can reach it today:

1. **`pendingSupersessionPreProbe`** — today `(root, relPath, pending)`
   (`pending-supersession.ts:87-91`), with no access to the protocol scan at all. It gains the
   projection as a fourth argument. Without it the pre-probe returns
   `carry / local repository lacks pending ref …` (`:105`) for every receipted absence, which
   is precisely the line the rig asserts must disappear (§9.6).
2. **`provePendingSupersession`** (`:198-209`) — the final proof, same projection, same rule.
3. **§3.6a's A′ and A″** — the crash-completion arm and the owed-omission suppression both key
   on `absenceReceipt(R).priorOid`, and A″ *cannot be stated at all* without the Z arm, because
   the suppression must survive the A→Z compaction.

**Ordering note.** This projection is therefore a **prerequisite** for §3.6a's A″, not merely
a tidy-up: the durable suppression predicate is keyed on a receipt that may be either A or Z,
and v4 could only see A.

**What happens on a mismatch: carry, then capture again with the new prior.** The mismatch
means the pending value arrived after the receipt was minted (or from a writer this device
never synced with). The sequence terminates in two cycles and loses nothing:

1. **Carry.** `pending` keeps `R = Y` and the local absence is *not* published for `R`. The
   A artifact stands; BASE has already retired `R` (that happened under the ref-transaction
   locks, bound to `X`, and is correct — this device did delete `X`).
2. **The apply lane re-creates `R = Y`.** With BASE retired, `logicalBaseRefs[R]` is absent
   and the live ref is absent, so `planBranchTransition({beforeOid: null, afterOid: Y,
   logicalBaseOid: null})` is an ordinary **creation** and the pre-state guard passes
   (`branch-transition.ts:105`). This is the same terminating argument §3.6a already makes
   for the remote-wins-the-race case: another device is still advertising `R` as present, so
   re-creating it is the correct answer, not a resurrection bug.
3. **If the user deletes it again**, the branch is now physically present at `Y` with a
   `pull-p` origin at `Y`, so the next absence capture mints an A with `priorOid = Y`, the
   equality holds, and the omission supersedes. If the user *does not* delete it again, the
   branch legitimately exists at `Y` and there is nothing to publish.

Neither branch loops: this device's tombstone chain for `R` covers `X` only, so the other
writer holds rather than prunes (§3.4), and once this device re-advertises `R = Y` the other
writer's hold clears by convergence.

**The §1.2 field wedge is still cleared by the tightened rule**, which is the check that
matters: there, `pending.refs[R] = 2c866687… = base.refs[R] = X`, so the A minted at
`priorOid = X` satisfies the equality exactly.

### 3.3 The deletion witness — what licenses an absence capture

Absence capture fires for a `refs/heads/*` ref `R` only when **all** of the following
hold. Any failure, any exception, any unreadable input leaves `R` exactly as it is today.

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
   foreign artifact. That is exactly `prepareFollowerBranchProtocol`'s
   `BranchArtifactDisposition` for `R` with all four fields `absent`/`clear`
   (`follower-protocol.ts:83-114`). An existing A means the deletion is already recorded;
   an existing P/K means a crashed transition owns this ref and `p-repair` must run first.
4. No sibling worktree owns `R` (`branchesCheckedOutElsewhere`) and `R` is not in a
   receiver-equivalent collision group (`receiverEquivalentCollisionNames`).
5. Git is not busy, preflight is `ok`, and the repository identity/lineage binding
   validates (`readRepoIdentityV1` / `readStateLineageV1`, `follower-protocol.ts:61-67`).
   **This rule does *not* catch a restore — see §3.3b.** v2 claimed it did; it does not.
6. The observation survives the locked second proof inside
   `commitPlannedBranchTransition` (`branch-transition.ts:300-321`), which must also be
   converted to the strict reader (`branch-transition.ts:309` is a `readAllRefs` call):
   `R` still absent, still unowned, while the ref transaction holds its locks.
7. **`R` is not the current HEAD symref target.** New in v3 — see §3.3b.
8. **No ref-database regression signal is present.** New in v3 — see §3.3b.

*(v3 had a ninth rule — "the repository-level circuit breaker has not tripped". **R4 removed
it** (§3.0a). The eight that remain are all per-ref evidence rules; there is no longer any
repository-level count in the predicate.)*

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
- returns `failed` with `code === 1` **and `stderr.trim() === ""`** → `{ status: "ok",
  refs: {} }`. Both conditions, because exit 1 *with* stderr is not the documented no-match
  case.
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
  instead of `(error as {code?}).code === 1`, `shared.ts:261-268`), because it is the one
  existing consumer of the same distinction and leaving it on `code` archaeology would keep two
  idioms for one rule.

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
| `apply.ts:1903` (pre-state-save terminal revalidation) | **New in v5.** For an absent witness `terminal` is `null`, so `(live[ref] ?? null) !== terminal` compares `null !== null` and **passes on a totally failed read** (`apply.ts:1906-1909`) — the same defeat as `branch-transition.ts:309`, at the last checkpoint before the state CAS. This is the site that must hold A′'s and A''s proof (§3.6a), so it is mandatory, not optional. |
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
therefore: absence capture refuses any `R` that is the current HEAD symref target, checked
at plan time **and** enforced in the `local-absence` authority arm by requiring
`locked.currentRef === false`.

Scoped deliberately to the new authority arm rather than fixing `branchProofMatches`
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
checkable locally with no new provenance and no new wire field.

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
  applies as an ordinary creation (`beforeOid = null`, `logicalBaseOid = null` after the
  A retirement — the guard passes).
- The local side is already lost: Git deleted the ref *and* its reflog before rbox ever
  ran. rbox is mirroring an accomplished fact, not performing a deletion.
- **rbox never destroys a reachable object here.** The A artifact retires a BASE member; it
  deletes no ref that exists (the ref is already gone) and no object. The follower prune it
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
*"some math is just not gonna prevent it; there's always a gap."* The absence-capture predicate
contains **no repository-level count anywhere**; §3.3's eight rules are all per-ref evidence, and
a capture that satisfies them all and is still wrong is accounted for in §3.0a rather than
mitigated. The full decision record, including both withdrawn rulings, is §12 Q2/Q2b.

Three facts kept here so nobody re-derives them:

- **The arithmetic.** `n >= max(K, ceil(F*N))` is a *conjunction* dominated by its larger leg, so
  with `K = 25`, `F = 0.25` the absolute leg dominates every repository under 100 heads — a
  24-head repository losing all 24 did not trip. A two-legged ref-count guard wants `OR`, and must
  not copy design 108's `AND` (`pushMassDeleteTrips`, `policy.ts:22-35`) without re-checking
  scale: 108's conjunction is defensible at `min = 1000` against file counts in the
  hundred-thousands and inverts at ref counts in the ones to hundreds.
- **The distribution that killed the fraction leg.** 110 repositories, ~203 BASE heads, **median
  1**, 84% at four or fewer. Any fraction of `N` is a hair-trigger there.
- **The file plane keeps its guards, and that is not a contradiction.** Design 44's pull-side
  guard (`policy.ts:11-15`, `pull.ts:276`) and design 108's push-side breaker (`policy.ts:22-35`,
  `push.ts:701`) are unchanged: they guard the plane rbox *promises*, at a scale where a fraction
  leg means something. R4 is exactly the ruling that the Git lane is not that plane. The
  **posture** 108 taught survives without a breaker — refuse on the publishing side, before any
  encrypt/upload/commit work, and fail closed — which is what every §3.3 rule does.

### 3.6 Ordering: absence capture must precede capture, not follow it

This is subtle enough to state on its own, because it is what makes P1 safe rather than a
re-run of the 174 R1 blocker. The ACK dry-run `pendingSupersessionAckConverges`
(`pending-supersession.ts:35-62`) requires the composed BASE to deep-equal the candidate
section. Because of `base-composer.ts:525-527`, a candidate that merely *omits* `R` can
never satisfy it while BASE holds `R`. That refusal is the structural defence design 174
chose against fleet-wide resurrection, and it must not be relaxed.

P1 satisfies it the right way round: the A artifact is committed and BASE is retired
**first**, under the ref-transaction locks; only then does capture produce a candidate
that omits `R`, and only then does the dry-run converge. The deletion is therefore backed
by a durable Git artifact at every instant, exactly as `130:177-187` requires. Any variant
that lets the pre-probe or the dry-run "just skip" a missing ref without a receipt is
rejected in §8.

### 3.6a Where absence capture runs — the exact handoff

v2 said only "in the apply lane, before `publishRefPlane`". That placement does not clear
either field wedge, and the reasons are two distinct control-flow facts.

**Defect 1 — the latent wedge never reaches the hook.** §2.3's shape is a stale positive
BASE member with **no pending** and an **unchanged remote**. `applyGitRepos` takes the
unchanged shortcut at `apply.ts:873`:

```ts
if (!remoteChanged && !pend && !resolutionChanged && !checkpointReproof && !(configDue && configTarget?.fresh)) {
```

and returns `{ result: "unchanged" }` at `apply.ts:879` — before any follow, and therefore
before any hook placed "before `publishRefPlane`". §5's promise that the latent wedge is
"reconciled on the next cycle, before it can arm" is unsatisfiable at that position.

**Defect 2 — retiring BASE inside the pass lets the same pass re-create the branch.** In
the observed pending wedge the incoming/effective section still says `R = X`. Retire BASE
for `R` and the very next iteration of the publish loop sees `oldOid = undefined`,
`logicalBaseOid = null` (retired), `newOid = X` — a perfectly legal **creation**
(`follow.ts:965-988` → `planBranchTransition` with `beforeOid: null`). The guard passes,
the branch comes back, and the deletion is never published. That is worse than the wedge:
it is a silent resurrection loop.

**The specified handoff, in order.**

- **A — Absence reconciliation runs before the unchanged shortcut.** A new per-repository
  step in `applyGitRepos`, positioned above `apply.ts:873`, not above `publishRefPlane`.
  - **Cheap gate first, and it is O(1) per BASE head with no subprocess:** the predicate
    "∃ `R` ∈ `record.base.refs` positive and absent from the live refs". In the
    overwhelmingly common case the candidate set is empty, the shortcut is taken exactly as
    today, and no protocol lock is acquired and no extra Git process is spawned. This is
    what keeps §6's "zero new Git subprocesses in the negative case" true at the new
    position — but note it now needs a live ref read on the unchanged path, so the strict
    read of §3.3a must be the one already taken for the cycle, not a new spawn.
  - Only a **non-empty** candidate set opens `prepareFollowerBranchProtocol`
    (`follower-protocol.ts:61-71`) and evaluates §3.3's eight rules.
- **A′ — Complete an existing absence receipt, at the same position, before A. New in v4,
  and it is a blocker fix.** The gate in A finds *every* BASE-positive head that is absent
  locally, including one whose A artifact is **already durable** because a previous cycle
  crashed between the ref transaction and the state CAS. §3.3 rule 3 refuses those (an
  existing A means "a crashed transition owns this ref"), so without a separate arm they are
  refused forever — and, as v3 was written, nothing else recovers them either:
  - the recovery inside `publishRefPlane` (`follow.ts:853-874`) fires only when the
    **incoming section also omits `R`** (`!newOid && oldOid === undefined`). In this crash
    shape the push never ran, so the remote still advertises `R = X` and `newOid = X`;
  - worse, with `logicalBaseRefs[R]` already deleted by the durable A
    (`follower-protocol.ts:88`), that path plans `beforeOid: null → afterOid: X` against
    `logicalBaseOid: null` — a legal **creation**. The crash point the design claimed to heal
    was a resurrection instead;
  - and in the §2.3 latent shape (no pending, unchanged remote) the follow is never reached
    at all, because `apply.ts:873` returns first. **Permanently wedged.**

  So A′ is its own arm, above the shortcut, with the *inverse* of rule 3:

  | Requirement | Source |
  |---|---|
  | `record.base.refs[R] = X` positive, `R` absent under the strict read (§3.3a) | same gate as A |
  | The artifact disposition for `R` is `absence === "valid-owning"` **or** `settledAbsence === "valid-owning"` | `follower-protocol.ts:83-114` |
  | `absenceWitnesses[R].priorOid === X` — the durable receipt names the exact BASE value being retired | `follower-protocol.ts:88-100`; the same equality `follow.ts:857` already uses |
  | No active foreign artifact for `R`, no P/K | `BranchArtifactDisposition` |
  | A fresh locked second proof: `R` still absent (strict), still unowned, `currentRef === false` | §3.3 rules 4, 6, 7 re-run |

  Then retire `BASE[R]` under the `local-absence` authority using the reconstructed witness
  and that fresh locked proof. **This writes no new Git artifact** — it materializes a
  transition already proved by a durable one, which is exactly the act `130:177-187`
  permits ("those paths may materialize a transition already proved by its durable Git
  artifact; they may never manufacture one"). It is idempotent: re-running it after another
  crash re-derives the same retirement from the same artifact.

  Two deliberate asymmetries with A, both stated so they are not read as oversights:
  - **A′ does not re-evaluate §3.3 rule 1** (origin usability). The destructive claim was
    already made and durably recorded under the locks; refusing to *finish* it because a
    lineage has since rotated would leave the repository wedged with no other exit. What A′
    must not do is *widen* the claim, which is why `priorOid === X` is mandatory.
  - **If `R` is present again**, A′ refuses and does nothing: a durable A plus a live ref is a
    stale-artifact shape design 130 already owns (rule 3 keeps refusing new capture, and the
    existing artifact-retirement paths apply). A′ never deletes a ref.

  **A′'s locked proof has a stated lifetime, and it is revalidated at state save. New in v5
  (round-3 M2).** v4 said "a fresh locked second proof" and never said how that observation
  stays authoritative until the BASE CAS, which is a real gap: if `R` is re-created after the
  verify-only proof releases its lock but before state save, the committed result is
  BASE-absent + live `R` + an owning A/Z — the ref exists with no BASE member, which is the
  §1.2 shape from the other side.

  - **Lock lifetime.** A′'s proof is taken under the repository protocol locks that step A
    already holds (`prepareFollowerBranchProtocol`, `follower-protocol.ts:61-71`) and those
    locks are held until the state CAS commits. A′ writes no ref transaction, so it has no
    transaction of its own to hold locks for; the protocol lock is therefore the only thing
    standing between the proof and the CAS, and it must not be released between them.
  - **Terminal revalidation must cover `local-absence`, and today it cannot.** The
    pre-state-save revalidation loop skips every authority except two:
    `if (proof.authority.kind !== "pull-ref-transaction" && proof.authority.kind !== "journal-recovery") continue;`
    (`apply.ts:1900`). A `local-absence` proof would be silently skipped. Add it to that
    filter — and note that the loop's *body* already does exactly the right thing for an
    absent witness: it requires `locked.liveOid === terminal` and `(live[ref] ?? null) ===
    terminal` with `terminal = null` (`apply.ts:1906-1909`), and it re-reads the A artifact and
    compares `targetOid` when `witness.source === "a"` (`apply.ts:1910-1917`). So the fix is
    the filter plus one thing the filter cannot give:
  - **That site is a fourth mandatory strict-read location (§3.3a).** The loop reads
    `const live = await readAllRefs(ctx.repoDir)` (`apply.ts:1903`), and for an absent witness
    the comparison is `(live[ref] ?? null) !== null` — which **passes on a totally failed
    read**, exactly as `branch-transition.ts:309` does. The one check that is supposed to prove
    "`R` is still absent at state save" is defeated by the same lossy reader §3.3a exists to
    replace. §3.3a's table now lists it.
  - **`local-absence` does not settle A→Z.** `settleCommittedBranchArtifacts` filters
    `repoProofs` to `pull-ref-transaction`/`journal-recovery` (`apply.ts:1944-1946`,
    `:1957`), so an A committed under `local-absence` authority stays a **live A** rather than
    compacting into the Z ledger. That is deliberate and is stated so nobody reads the omission
    as an oversight: A′ is the only reader that needs it, rule 3 already refuses new capture
    while it exists, and adding `local-absence` to the settlement filter would move the
    receipt to a different artifact class inside the same crash window this step exists to
    close. §3.2a's projection covers both arms regardless, because a receipt written by an
    *ordinary pull* transition on the same ref does settle.
- **A″ — the omission is owed until it is published. New in v5, and it is a blocker fix
  (round-3 blocker 2).**

  **The defect.** A′ closes "A written → BASE not retired". It does **not** close "BASE
  retired → omission not yet published", and that window inverts the receipt into a creation:

  - Start with a durable A(X), `BASE[R]` retired, `R` physically absent, and the server still
    advertising `R = X` — because the omitting push has not landed yet. Crash, or merely fail
    the push.
  - On the next pull, `prepareFollowerBranchProtocol` deletes `R` from `logicalBaseRefs` on the
    strength of the receipt — for the A arm at `follower-protocol.ts:88`, for the Z arm at
    `:106`.
  - The ordinary follow then plans `beforeOid: null → afterOid: X` against
    `logicalBaseOid: null`. `branch-transition.ts:105` **passes** (`null === null`), and the
    creation path *destroys the receipt in its own transaction*: it splices
    `delete <A.ref> <A.targetOid>` for a live A (`branch-transition.ts:136-141`) or retires the
    Z leaf (`:142-152`).
  - So the deleting device inverts its **own** durable receipt, and does it without any race:
    the only writer involved is this device, and the value it re-creates is the value its own
    last publish is still advertising. That is a direct violation of §7 invariant 2.

  **The rule.** A ref whose retirement is recorded but whose omission has not been published is
  **owed**, and an owed ref is excluded from incoming apply. Owed is a predicate over durable
  state only — no in-memory flag survives a crash, so nothing here is allowed to be one:

  > `owed(rel, R)` ⟺ all four of:
  > 1. `record.base.refs[R]` is **absent**;
  > 2. `absenceReceipt(R)` exists for the current lineage (§3.2a — A **or** Z), with
  >    `priorOid = X`;
  > 3. `R` is **absent** under the strict read (§3.3a);
  > 4. `record.advertised?.refs[R] === X` (`sync-state-model.ts:290`) — *this device's own last
  >    published section still advertises the exact value its receipt retired.*

  Conjunct 4 is the whole mechanism, and it needs no new persisted state: `advertised[rel]` is
  set to the committed section on every accepted push (`push.ts:962`), so it is precisely the
  durable answer to "is this device still the reason the wire says `R = X`?". Conjunct 3 is
  what makes the predicate *release* rather than latch: if the user re-creates `R`, it is not
  owed, the ordinary transition applies, and `branch-transition.ts:136-141` retires the stale
  receipt as design 130 already specifies. Conjunct 2 is why §3.2a is a prerequisite — after an
  ordinary pull compacts A into Z, only the Z arm can answer.

  **A′ and A″ can never fire for the same ref, so their relative order is irrelevant** — and
  that is by construction, not by luck: A′ requires `record.base.refs[R]` **positive** (the
  retirement is unfinished) while `owed` conjunct 1 requires it **absent** (the retirement is
  finished but unpublished). Together they cover the two halves of the crash window with no gap
  and no overlap: A′ owns "receipt written, BASE not retired", A″ owns "BASE retired, omission
  not published". Both run at the same position — above the unchanged shortcut at
  `apply.ts:873` — for the same reason step A does (§3.6a defect 1).

  **The mechanism is step C, made durable — not a per-ref set inside the publish loop.** When
  any ref of a repository is owed, the repository's apply ends for this cycle with
  `result: "reconciled"` exactly as step C specifies, *before* the follow runs, so no incoming
  section can create it. This is deliberate:

  - It reuses the one suppression §3.6a already has. The alternative — pass a `suppressedRefs`
    set into `publishRefPlane` — is the alternative step C **already rejected**, because it puts
    a second, weaker source of pre-state truth next to `logicalBaseRefs` inside the hottest
    loop. That objection does not get weaker because the set is now durable.
  - It keys on the **artifact**, not on the cycle. v4's suppression was implicit in
    control flow ("the same cycle's push publishes the omission, so cycle N+1 sees no `R`"),
    which is only true if the cycle completes. A″ derives the same suppression from state that
    outlives any crash.
  - **Cost is zero in the steady state.** On the happy path step D publishes the omission in
    the *same* cycle, so `advertised` no longer names `R` by the next pull and A″ never fires.
    It fires only in the window a crash or a failed push actually opens.

  **The liveness bound, stated because it is a whole-repository stall.** While a ref is owed,
  that repository's Git apply does not progress — the same posture as today's apply deferral,
  and fail-closed in the right direction (we deleted the branch; we do not want it back). It is
  released by the omission publishing, which the push lane retries every cycle. If the push can
  never succeed — offline, quota, a persistent capture failure — the repository stalls until it
  can, and `rbox git deferrals` shows the reconciliation, not a blocker (step C records no
  blocker: nothing failed). A repository that stalls forever on an unpublishable omission is a
  push-lane problem, not an absence-capture problem, and it does not lose or resurrect
  anything.

  **The double-crash matrix, worked through.** `K` marks where the process dies. `A_live`/`Z`
  is the receipt's artifact class; `adv` is `record.advertised.refs[R]`.

  | # | Crash point | Durable state after | What the next cycle does | Outcome |
  |---|---|---|---|---|
  | 1 | **K after the A ref transaction, before the BASE CAS** | `A_live`, `BASE[R] = X`, `adv = X` | Step A′ matches (`priorOid === X`, fresh locked proof) and retires `BASE[R]` | Completed. v4's fix, unchanged. |
  | 2 | **K after the BASE CAS, before capture/push** | `A_live`, `BASE[R]` absent, `adv = X` | **A″ fires** (all four conjuncts), `reconciled`, no follow; the same cycle's push retries the omission | No inversion. This is codex's blocker, closed. |
  | 3 | **K again, in the same window** (crash twice) | identical to row 2 — nothing new was written | A″ fires again; idempotent by construction, because the predicate is a *function of durable state*, not a counter | No inversion, any number of times. |
  | 4 | **K after A′ retires BASE but before A′'s own state CAS** | `A_live`, `BASE[R] = X` (the CAS was lost) | Row 1 again: A′ re-derives the same retirement from the same artifact | Idempotent. |
  | 5 | **K after the server accepted the omitting push, before the push's state CAS** | `A_live`, `BASE[R]` absent, `adv` still `X` (stale) | A″ fires one extra cycle; the next capture re-publishes an omitting section (the server already omits `R`, so it is a no-op on the wire), the ACK updates `adv` | Suppression lifts. Stale `adv` errs toward suppression, which is the safe direction. |
  | 6 | **K after the push's state CAS** | `adv` omits `R` | Not owed. The newest wire section omits `R`, so there is nothing for the follow to create | Converged. |
  | 7 | **User re-creates `R` at any point above** | receipt + live `R` | Conjunct 3 fails ⇒ not owed; A′ also refuses (present-again). The ordinary transition applies and retires the stale receipt (`branch-transition.ts:136-152`) | Design 130's existing stale-artifact path; A″ never latches. |
  | 8 | **Another writer genuinely re-creates `R` at a different `Y`** | receipt at `X`, incoming `R = Y` | Conjunct 4 compares `adv[R]` to the receipt's `X`; the incoming value is irrelevant to the predicate, so once `adv` omits `R` the creation at `Y` applies through the ordinary path — §3.2's terminating mismatch case | Correct: another device holds it, so it comes back. |
  | 9 | **Another writer re-creates `R` at the same `X` while the omission is still owed** | receipt at `X`, `adv = X` | Owed, so the creation waits until this device's omission publishes and `adv` clears — one cycle on the happy path | Bounded. Recorded as the one case where A″ delays a legitimate creation; it never refuses it. |
- **B — Durable receipt, then BASE.** For each surviving candidate from A, one prepared
  expected-old ref transaction writes the A artifact. Then, and only after that transaction
  commits, the state CAS retires `BASE[R]` under the new `local-absence` authority. The
  ordering is the whole safety argument (§3.1, §3.6): a durable Git artifact backs the
  retirement at every instant, and a crash between the two is exactly what A′ completes.
  *(v3 also spliced keep-pin lines into this transaction. R4 removed the pin (§3.0a), so B is
  now a single-artifact transaction and the "pin before BASE" ordering constraint is gone
  with it.)*
- **C — End the repository's apply for this cycle.** After any successful retirement,
  return without applying the section in hand — a new `result: "reconciled"` alongside
  `unchanged`/`deferred`, which clears the apply deferral, leaves `pending` untouched, and
  emits one bounded line. It does **not** record a blocker: nothing failed.
  - *Rejected alternative:* pass a `suppressedRefs` set into `publishRefPlane` so `R` is
    dropped from `candidates` for this pass. It works, and it introduces a second, weaker
    source of pre-state truth inside the hottest loop, next to `logicalBaseRefs`. Design
    130's value is that BASE is the *only* pre-state authority; one extra cycle is a
    cheaper price than a second one.
- **D — The same cycle's push lane publishes the omission.** This is what makes C
  sufficient rather than a one-cycle delay of the same bug. `sync()` is pull-then-push
  within a single cycle — `sync.ts:9-19`, "One full cycle: take remote changes, then
  publish local ones" — so the push lane runs **after** step B in the same cycle, with the
  retired BASE already committed. There:
  - `pendingSupersessionPreProbe` returns `maybe` for `R` under P1b's new receipt row
    instead of `carry / local repository lacks pending ref …`;
  - capture omits `R`, and `normalizePublishedGitSection` authors the wire tombstone at `X`
    (`publisher-tombstones.ts:108-122`);
  - `pendingSupersessionAckConverges` now converges, because BASE no longer holds `R` and
    `base-composer.ts:525-527` therefore has nothing to re-add.

  So the server's newest section for the repository omits `R` **before** the next pull. On
  cycle N+1 the apply lane sees a section without `R` and there is nothing to re-create.

**What if the remote wins the race and re-delivers `R = X` first?** Then the branch is
legitimately re-created — and that is correct, because another device is still advertising
it as present. The loop terminates rather than ping-ponging: this device's published
tombstone at `X` is what retires `R` on that device, tombstone generations are monotone,
and once it prunes it stops advertising. Stated here explicitly so the objection is
answered rather than left to the reader.

### 3.7 ~~The deleting device's recovery pin~~ — REMOVED 2026-07-24 by R4

v2 argued no local pin was needed because a *follower* pins the displaced OIDs when it prunes
(`follow.ts:947-949` -> `prepareTombstonePrunePins`, `keep-pins.ts:635-654`). Codex showed that
premise is structurally unreliable — the prune *is* what creates the pin, so nothing is pinned
anywhere in four ordinary cases (§7.1) — and **R3** put a 90-day `tombstone`-class pin on the
deleting device instead, in the A artifact's transaction and before the BASE CAS, plus the
missing `expireTombstoneKeepPins` caller.

**R4 supersedes R3: there is no pin** (§3.0a). Codex's round-2 majors on the pin's persisted
shape and its expiry cadence are **mooted rather than answered** (§13.2, M3/M4). What that
changes elsewhere:

- **§3.6a step B is a single-artifact transaction** — no pin lines, no `extraTransactionLines`,
  no `cat-file -e` probe, no "pin before BASE" ordering rule. One crash point, which A′ completes.
- **No `KeepPinOrigin` change — and that avoided a downgrade hazard, not just some code.**
  `parseKeepPinOrigins` rejects any record whose key set is not exactly
  `["class","episode","ref","time"]` and any `class` outside `"human" | "tombstone" | "tracking"`
  (`keep-pins.ts:88-104`), so a newer client's extended sidecar would fail every
  `readKeepPinOrigins`/`prepareKeepPins` call on an older one.
- **The follower prune path is untouched**, and `expireTombstoneKeepPins` still has no
  production caller — those pins are still retained indefinitely, exactly as they ship today.
  Wiring the reaper would convert an existing unbounded retention into a 90-day one for
  already-shipped behaviour; with no promise resting on the number, that has no justification.
- **`createScratchPins` is a different mechanism and is unaffected.** §4.4's coverage discussion
  mentions capture-time scratch pins (`capture.ts:282`); they live in the `refs/rbox-*` namespace
  the bundle excludes and are torn down with the capture.

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
- **"Capture is not gagged by a hold alone" is wrong, and P1b does not fix it.** The held
  ref's own pending value is, by the point above, different from its live value. Both
  `pendingSupersessionPreProbe` (`pending-supersession.ts:103-105`) and
  `provePendingSupersession` (`:198-203`) evaluate **every** pending ref, and for heads the
  test is `equalOrFastForward(repoDir, pendingOid, candidateOid)` — literally
  `gitCommitAncestry(pending, candidate) !== "not-ancestor"` (`pending-supersession.ts:179-181`),
  i.e. the *remote's* value must be an ancestor of the local one. A worktree-held ref the
  remote advanced fails that, and P1b adds only an **absent + receipt** row, which does not
  apply to a ref that is present and divergent. So supersession still refuses and
  `apply.ts:1447-1450` still sets `pending[rel] = remoteSec`.

**What P2 therefore actually delivers:** the ~9 s per-cycle follow disappears (held-skip),
and a non-HEAD ownership hold stops deferring the whole repository. **It does not unfreeze
the capture lane.**

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
3. **Everything clears at worktree deletion, through P1 + P1b.** Once the worktree goes and
   the branch is deleted, absence capture retires the BASE member, the same cycle's push
   publishes the omission, and the pending section supersedes (§3.6a). That is the gate this
   design ships.

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

**RULED 2026-07-24 (R5): P4 is out of scope for design 200.** This reverses the same day's
Q5 ruling that put it in scope (§12 Q5). It is a reversal **on new evidence**, not a change
of mind about the goal: three shapes failed three adversarial rounds, and the rig showed that
the win P4 was justified by already works today. The parked follow-up is
**[design 201](./201-per-ref-git-publishing.md)** — a per-ref wire model, its honest
prerequisite, likely 2.0-era alongside design 163's SQLite state plane.

**What P4 was.** While a repository had any held ref, the outgoing section stopped being the
carried incoming section and became a merge: the carried `pending` value verbatim for each
held ref, the live local value for every ref rbox may publish. Today `apply.ts:1447-1450`
sets `pending[rel] = remoteSec` for the whole repository and `normalizeOutgoingGitSections`
republishes it by identity (`publisher-tombstones.ts:183-186`), so one held ref freezes every
other ref's published value for as long as the hold lasts.

**The three shapes, and why each failed.** Every failure is structural — a collision with an
existing closed invariant — not a defect in the write-up:

| Shape | Killed by | Why |
|---|---|---|
| **Hybrid BASE** — v3's third ACK outcome `partially-superseded`: captured refs advance to the committed values, carried refs keep their prior BASE value, non-ref fields keep theirs | round 2 (B4) | Two independent breaks. **(i) Bundle coverage.** `incrementalCapturePlan` derives the next capture's negative basis and chain from BASE (`src/cli/sync-git/shared.ts:137-139`) and `captureGitState` passes those tips as `^tip` exclusions (`capture.ts:296-304`), so a BASE whose *refs* advanced while its *bundle and chain* stayed put excludes objects the advertised chain does not contain — the next section is unimportable by every follower. **(ii) The deep-equality dry-run.** `pendingSupersessionAckConverges` requires `isDeepStrictEqual(composed.base, candidate)` (`pending-supersession.ts:61`); under the hybrid, `composed.base` holds carried refs at their *prior* values while the candidate holds them at their *pending* values, so the dry-run refuses every merged section that carries anything — i.e. every merged section there is. |
| **BASE follows the published section** — settle BASE to the emitted section, carried values included, with per-ref carrier origins so a carried value never acquires `publisher-ack` provenance | v4, self-rejected | **It re-arms the §1.2 wedge via `logicalBaseRefs`.** That map starts as a copy of `base.refs` (`follower-protocol.ts:80`) and is compared against the **physical** `beforeOid` — `branch-transition.ts:105` throws `branch transition does not match logical BASE pre-state` on any mismatch. A positive BASE member at a carried value `Y` this device never held makes the logical pre-state name a physical state that never existed here, so the moment the hold clears and the apply tries to move the ref to `Y`, the guard refuses and the repository wedges in exactly the shape §1.2 documents. Carrier provenance does not help: the guard reads `base.refs`, not the origin. |
| **Mutual exclusivity** — v4: a repository whose emitted section carries any ref is never settled, so BASE never advances and no origin is minted for any of its refs | round 3 (B1) | **Self-echo, because published values never enter BASE.** The bar that keeps carried values out of BASE also keeps *captured* ones out of it. On the next pull `remoteSec` is this device's own merged section `M` and live `D = Z`, but `logicalBaseOid`/`baseOid` are still `X` and there is no P/A witness — so the equality path takes `heldRefs[D] = "local-commits"` (`follow.ts:895`, *"equality cannot invent branch P/A authority"*). Each captured ref publishes past the hold exactly **once** and then freezes; a later advance to `Q` is also unowned by incoming `Z`, so it is carried too. "No origin for any ref of a carrying repository" and "captured refs keep publishing" cannot both hold with the current follower. |

**The round-3 blocker list that killed the last shape**, recorded so 201 starts from it
rather than re-deriving it (`REVIEW-200-R3-CODEX.md`, kept beside this file):

1. **B1 — self-echo re-gags every captured branch after one emit.** Above. Codex's shortest
   blocking list named it as needing "a self-echo authority that preserves the captured
   partition without granting authority to carried refs" — i.e. per-ref authority, which is
   the thing 201 exists to design.
2. **B3 — the refs-only splice is not *operationally* v1.6.8-compatible.** The wire schema is
   compatible (v1.6.8 knows every `GitSection` field and `packChain`, and `carriedRefs` never
   goes on the wire). But `M` moves pending's current bundle into a historical chain link
   while copying pending's index/`indexTree`/op-state, and both v1.6.8 and current
   `importGitPackChain` **skip** a historical link whose commit tips are already present,
   relying on the invariant that restored index/op-state objects belong only to the
   **current** link (`v1.6.8:src/engine/git/shared.ts:493-506`; current
   `src/engine/git/shared.ts:529-540`). A receiver can hold every pending commit tip while
   lacking a staged-only blob, then skip the only bundle that contains it. A v1.6.8 reader
   parses `M` and can still fail to restore it.
3. **B4 — `M` excludes BASE prerequisites that its chain does not carry.** The basis
   `gitSectionTips(pending) ∪ gitSectionTips(base)` becomes `^tip` exclusions
   (`capture.ts:296-304`) while `M.packChain` contains only pending's chain plus pending's
   newest link, so a BASE-only tip can be excluded without appearing anywhere in `M`'s chain.
   Every negative basis tip must be *proved* covered by the emitted chain.
4. **B5 — repeated self-echo exhausts `MAX_PACK_CHAIN`.** `M.packChain = pending.packChain +
   newestLink(pending)`, and the next pull replaces pending with `M`, so each emit adds a
   link. From length 0 the emits at lengths 1–7 are valid and the next trips
   `pending.packChain.length + 2 > MAX_PACK_CHAIN` (8, `manifest-validate.ts:19`), falling
   back to whole-section carry **forever** while the hold remains; a pending section already
   at length 7 disables the feature immediately. This contradicted the 7-day bake narrative
   directly.
5. **B6 — a receipted pending HEAD can make `M` invalid.** §3.3 rule 7 rejects the **local
   current** symref target, not the branch named by `pending.head`. Omitting a
   receipted-absent ref that `pending.head` names produces exactly the shape
   `validateGitSection` rejects (`manifest-validate.ts:380-392`).

Two round-3 majors belong to the same shape and are recorded with it: **M5**, that the
persisted `record.advertisedCarried` had no proved clearing point (the reverse migration said
the field outlives the flag *and* that an empty set is harmless, which cannot both be true
without an atomic clearing barrier); and **M4**, that the carried/captured partition was not
total (§13.3 — moot with the cut, and why).

**The landmine 201 must carry forward: `gitCommitAncestry(Y, Y)` succeeds.** For a carried
ref the candidate value *equals* the pending value, so
`equalOrFastForward(pending[R], candidate[R])` is `gitCommitAncestry(Y, Y)` — which returns
`"equal"`, which is not `"not-ancestor"`, which is **proven**. Any per-ref publishing model
must bar the carried partition *explicitly*: without that bar, a section carrying a relayed
value declares the pending superseded without this device ever applying it, clears
`pending[rel]`, advances BASE wholesale and mints `publisher-ack` origins for values this
device never held — every hazard the design worried about, reached through the **success**
path rather than through a bug. It fails closed today only by luck: if the carried object is
absent locally the `rev-parse --verify` throws (`git-ancestry.ts:13-16`) and
`provePendingSupersession`'s outer `catch { return false }` (`pending-supersession.ts:215-217`)
swallows it. **Depending on not having an object is not a safety argument.**

**What the cut costs, stated exactly.** What P4 uniquely bought was publishing past a
**divergent** held ref *without* carrying the pending section as bookkeeping. Two things
bound that loss:

- **The unrelated-change propagation P4 was justified by already works.** The rig scenario
  `scripts/rig/scenarios/worktree-squash-lifecycle.ts` (merged as `ad0b3408`, #446)
  demonstrates it empirically: its phase-1 assertion that an unrelated commit on `main`
  propagates A→B *past a live worktree hold* **passes on merit today**, through design 174's
  pending supersession, because the unrelated ref's transition is a fast-forward. The
  carried pending section is bookkeeping in that window, not a gag on the refs that matter.
- **The residual is bounded by the worktree's lifetime**, and is consistent with the
  founder's ruled semantic that holding a ref for as long as a worktree holds it is
  legitimate. Everything clears at worktree deletion through P1/P1b (§3.6a, §4.2).

§4.2 and §5 state the surviving behaviour without P4, and §10 records it as a non-goal again
with a pointer to 201.

### 4.5 Recommendation

Ship P2 and P3 together with P1 (§11). P4 is **cut** (§4.4, R5), so this is the whole design.
On the founder's Mac the P1–P3 result is:

- the abandoned `~/.codex` worktrees hold their own branches and nothing else;
- the repository is not *deferred*, and the follow is skipped on subsequent cycles until the
  worktree registry actually changes;
- the four squash-merged branches stop cascading holds onto unrelated refs through the
  `noDropProof` fixpoint;
- the phantom ref is captured as an absence, published in the **same cycle's** push lane
  (§3.6a step D), and the wedge clears itself.

**Corrected in v3, and still true in v5: a *divergent* hold keeps the section carried after
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
  manufacture phantom refs — but P1 now reconciles each one automatically at deletion time
  and the wedge no longer accumulates into a state with no exit. Breaking the chain at its
  cause needs per-ref publishing, which is **design 201** (§4.4, R5).

## 5. The self-healing contract

**Becomes automatic — no human, no `rbox git resolve`:**

| Situation | New behavior |
|---|---|
| Published branch deleted locally (`git branch -D`, `git worktree remove`, agent cleanup) | Absence receipt written, BASE retired, deletion published as a tombstone in the **same cycle's push lane**, `pending` superseded. One bounded log line. **No pin and no recovery listing** — R4, §3.0a. |
| `pending` carried on a ref the local repository no longer has | Supersedes as soon as the absence receipt exists. |
| Abandoned worktree holding a branch | Per-ref hold only; the repository is no longer *deferred* and the follow is held-skipped until the worktree registry changes. **A divergent hold still keeps the pending section carried** for the worktree's lifetime, and that is accepted (§4.2, R5). |
| Unrelated local work while a worktree hold is outstanding | **Propagates already, where the unrelated transition is a fast-forward** — design 174's supersession, verified by the rig's phase-1 assertion (§4.2 point 2, §9.6). A non-fast-forward change on another ref of the same repository waits for the hold; closing that needs **design 201** (§4.4). |
| Squash-merged branch cascading holds onto unrelated refs | Cascade broken by content equivalence. It does **not** lift the first-pass ownership hold on the merged branch itself (§4.3). |
| Stale positive BASE member left by a *past* deletion (the latent wedge, §2.3) | Reconciled before apply's unchanged shortcut (§3.6a step A), so it clears without waiting for a divergence to arm it. |
| A durable absence receipt whose BASE retirement was lost to a crash | Completed idempotently from the artifact, above the unchanged shortcut (§3.6a step A′). New in v4; this shape was permanently wedged in v3. |

**Still needs a human, and should say so loudly.** v3 led this table with the circuit
breaker; **R4 removed it** (§3.0a), so mass absence no longer stops for anyone — the row is
gone rather than reworded, and §3.0a is where that consequence is accounted for.

| Situation | Why | What rbox should say |
|---|---|---|
| A ref read fails in a way that could be mistaken for "no refs" (§3.3a) | An absence proof derived from a failed read is a fleet-wide deletion waiting for one corrupt loose ref. | Defer the repository under `ref-read-unreadable`; name the repository and the exit code, never the message text. |
| A worktree holds a ref the incoming section wants to move | Git's own hazard; rbox must never move a branch under a live worktree. | Name the branch. **Not the worktree's absolute path — not yet** (§5.1). Today the message carries `path.basename(e.path)` (`apply.ts:118`); the actionable path goes in `rbox doctor` instead. |
| Genuine two-sided divergence on a branch | Unchanged; rbox does not pick a side. | Unchanged (`resolve-command.ts:672-677`). |
| Local commits whose content is *not* preserved anywhere | Unchanged; this is real work. | Unchanged. |

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

## 6. Cost

Baseline, measured (§1.3): `ownershipMs` p95 ≈ 9 s, 867 s wedged, 635 ownership candidates
for one repository. Scale: ~203 branch heads across 110 repositories.

| Change | Complexity | Expected wall clock |
|---|---|---|
| P1 witness evaluation, negative case | O(BASE heads) in-memory lookups against `live.refs`, already read once per cycle. **Zero new Git subprocesses.** | ~203 property lookups per full pass. Unmeasurable. |
| P1 absence capture, positive case | One prepared ref transaction (the A artifact alone) + one state CAS per deleted branch — the same shape as any other branch transition. | Tens of ms, once per deletion, not per cycle. |
| ~~§3.7 keep-pin accumulation~~ / ~~expiry sweep~~ | **Gone — R4 (§3.0a).** v3 carried ~900 hidden refs at steady state holding their commits against `git gc`, plus a per-repository origin-sidecar read per cycle as the sweep gate. Both were the design's only unbounded-in-time costs. | Zero. |
| §3.6a step A′ (existing-A recovery) | Runs only when the A gate in step A found a candidate **and** an owning A artifact already exists for it — normally never. Reuses the protocol scan step A already opened; writes no artifact. | Zero in steady state. |
| §3.3a strict ref read | Same `git show-ref` invocation, different error handling. **Zero additional subprocesses.** | Zero. |
| §3.6a position change | Moving reconciliation above `apply.ts:873` adds an O(BASE heads) in-memory predicate to the *unchanged* path — the hot path for converged repositories. It must reuse the cycle's existing ref read and must not acquire a protocol lock when the candidate set is empty. | Unmeasurable if implemented as specified; a new spawn per converged repository per cycle if not. This is the line to watch in review. |
| P1b pending pre-probe | Today's loop plus one artifact-disposition lookup per missing head. | Unmeasurable. |
| P3 content equivalence | Runs **only** on tips the ancestry proof already rejected — normally 0 per cycle. Per probe: 1 `merge-base` + 1 `diff-tree｜patch-id` + 1 walk of `base..D` capped at 5,000 commits. Cached on immutable `(T, D)`. | Cold worst case (all ~203 heads unowned, e.g. first sync of a heavily squashed workspace): ~600 spawns ≈ 6–12 s **once**. Steady state ≈ 0. |
| P2 held-skip for `worktree-ownership` | One extra `git worktree list --porcelain` per repository per cycle for the digest. | **Removes** a full follow per cycle for every ownership-held repository — on the observed data, roughly the whole 9 s p95 for `Personal/rbox-core`. |
| ~~**P4 per-ref pending lane**~~ / ~~**P4 first-emit follow**~~ | **Gone — R5 (§4.4).** These were the design's only positive costs: a merged section is a new section, so every cycle with an outstanding hold would have run an ordinary capture (bundle build, encrypt, upload) instead of re-advertising the carried section's `bundleEncSha` by identity (`publisher-tombstones.ts:183-186`), and the incoming key would have moved once per emit, costing one full follow. | Zero. The carried-section identity reuse stays exactly as it ships today. |

**Net, restated for v5.** The design is **net negative in wall clock and free at rest**, with
no positive-cost item left anywhere. The only new per-cycle work is a hash of a
`git worktree list` output the follow already spawns five times. **R4** removed the design's
only standing at-rest cost (v3's ~900 pinned refs) and **R5** removed its only recurring
transfer cost (P4's per-cycle capture while a hold is outstanding). v1's blanket claim that
"net cost is negative" is therefore true again for the whole design, which it was not in v3
or v4.

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
   BASE carrying a usable current-lineage origin was physically held by this device at that
   OID; and no BASE member ever advances to a value this device only *relayed*. *(Today
   emergent from `base-composer.ts:227-229, 364-367, 418`; now pinned, because §3.4 depends on
   the first half and `logicalBaseRefs` vs `beforeOid` — `branch-transition.ts:105` — depends
   on the second.)* **It proves possession, never the cause of a later absence** — §3.3b.
   *(v4 added a rider about carried refs never acquiring such an origin. With P4 cut (R5) the
   second half of the statement — "never advances to a value this device only relayed" — is
   again true by construction, since every advertised section is captured from local refs.
   The clause is kept in the invariant anyway: it is what any future per-ref publishing model
   must not break, and §4.4 records it as design 201's first constraint.)*
2. **A published branch deleted locally is captured, never resurrected.** BASE-positive +
   P-absent + clear artifacts yields a locked absence receipt, never a branch creation. A
   durable receipt whose BASE retirement was interrupted is **completed**, never re-decided
   and never inverted into a creation — §3.6a step A′. **A retirement whose omission has not
   yet been published is not open to re-creation from any incoming section, across any number
   of crashes** — §3.6a step A″ (new in v5; the *durable* half of this invariant, which v4
   asserted without a mechanism).
3. **Absence capture is fail-closed.** Any missing origin, stale lineage, existing A/P/K,
   sibling ownership, busy repository, unreadable identity, HEAD symref naming the ref,
   ref-database regression signal, or unstable second observation leaves the ref untouched.
   *(Every rule is per-ref evidence. There is deliberately no repository-level count —
   §3.0a, R4.)*
4. **Content equivalence waives holds, never authorizes deletion.** A patch-id match may
   only convert `would-drop` to `proven`, and only for a non-destructive transition; a
   `content-equivalent` waiver and an `afterOid === null` transition are disjoint by
   construction. Deletion authority remains tombstone attestation or an absence receipt.
5. **An absence proof is never derived from a failed ref read.** Every read that feeds a
   deletion, a locked absence proof, or a published section distinguishes "no refs" from
   "could not read refs" and fails closed on the latter. *(New in v3 — §3.3a.)*
6. **A pending section is superseded only against a candidate proved from local state.**
   Supersession requires, for every pending ref, either local presence at an
   equal-or-descendant OID or a durable absence receipt **naming that exact pending value** —
   never mere omission, and never a value the candidate relayed. *(Pins
   `REVIEW-174-R1-OPUS-B.md:14`'s resolution, which is currently unpinned in
   `INVARIANTS.md`. The `priorOid` binding is §3.2, and its receipt projection is §3.2's
   `absenceReceipt`. The relay bar has no live consumer now that P4 is cut — no candidate this
   design composes ever contains a relayed value — but it stays in the statement because
   `gitCommitAncestry(Y, Y)` returns `"equal"`, so a future per-ref model that relays a value
   would *prove* supersession by accident. §4.4 records that landmine.)*
7. **Worktree ownership is observed regardless of containment.** Sibling worktrees outside
   the workspace still hold their refs; containment affects only reporting.
8. **rbox never destroys a reachable Git object to publish a deletion.** An absence capture
   retires a BASE member and writes an artifact; it deletes no live ref and no object. A
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

*(v4 had a tenth invariant — "every published section's refs are covered by its own bundle
chain" — introduced because P4 was the first shape that could violate it. **P4 is cut**
(R5, §4.4), so it is emergent again: every section is captured from local refs and its bundle
is built from them. It is not proposed as an `INVARIANTS.md` entry here; it is recorded in
§4.4 as a design-201 prerequisite, together with the round-3 blockers B3 and B4 that are the
two concrete ways to violate it.)*

"Branch equality is not deletion authority" (since 130) remains true and unweakened: a
local-absence receipt is not equality, it is a locked proof of physical absence against
positive provenance. `follow.ts:894-895` keeps holding; it simply stops being reachable
for refs absence capture has already reconciled.

### 7.1 The recoverability analysis — kept as history, superseded by R4

**The mechanism discussion is superseded by R4 (§3.0a); the facts are still true and are why
neither earlier answer should come back** (full record: §12 Q3). Four of them:

1. **A tombstone retains an OID, not an object.** `GitRefTombstone` is `{oid, ts, generation}`
   (`src/engine/types.ts:71-75`); `REF_TOMBSTONE_RETENTION_MS` (`publisher-tombstones.ts:10`,
   cutoff at `:125-136`) retains the OID. What retains *objects* is the deliberately
   equal-valued `TOMBSTONE_PIN_RETENTION_MS` (`keep-pins.ts:68`) on the **keep-pin** — a
   different mechanism with a different creator. Anyone writing "recoverable via the tombstone
   retention" has conflated them.
2. **The follower pin is created by the prune**, so it does not exist when nobody prunes: a
   single-device workspace; both devices deleting before either applies the other's tombstone
   (each takes the `!oldOid && !newOid` path, `follow.ts:936` — a *likely* interleaving for the
   founder's loop); a device that never received the ref; a pre-1.6.8 follower that holds
   instead of pruning. R4 does not resurrect that argument — it stops claiming a Git-side
   guarantee at all.
3. **The A path really does lack the keep-refs the P path has, and that is now deliberate.** The
   A artifact records the OID as *text* in a canonical blob (`baseAbsentPayload`,
   `base-artifacts.ts:145-149`, `:218-224`); the P artifact creates real keep-refs at `priorOid`
   and `nextOid` (`basePresentKeepRef`, `:114-118`, spliced at `:237-244`). The P artifact's
   keep-refs serve a crash-window rollback (a correctness need); the A path's would have served
   user-facing recovery — now the file plane's job.
4. **`expireTombstoneKeepPins` has no production caller** (exported at
   `src/engine/index.ts:284`, referenced only by `keep-pins.test.ts:166`) and does not get one.
   Pre-existing over-retention, erring safe. Codex's expiry-starvation major is **mooted, not
   fixed** (§13.2, M4).

### 7.2 ~~Finding a deleted branch~~ — REMOVED 2026-07-24 by R4

v3 specified `rbox git deleted <repo> [--restore <branch>] [--json]` because R3's pin was
recoverable but not *discoverable*. R4 removes the pin, so there is nothing to list; codex's
round-2 major on its persisted shape (M3) is **mooted**. Four verified facts are kept, because
they constrain any future recovery surface:

- **`rbox git resolve … show-me` structurally cannot print an OID.** `buildSnapshot` computes
  local-only entries with their OIDs (`resolve-command.ts:238`, `:259`) and the public projection
  strips them (`:296`); the JSON path replaces any 40-hex token with `[commit]` (`:320-322`), and
  `git-cmd.test.ts:222-235` pins that contract by name.
- **The tombstone chain evicts long before it expires.** `MAX_REF_TOMBSTONES_PER_REF = 16` /
  `MAX_REF_TOMBSTONES_PER_REPO = 512` (`manifest-validate.ts:23-24`) are applied after the age
  cutoff (`publisher-tombstones.ts:124-146`). At ~10 deletions/day the oldest entries are gone
  well inside 90 days: the retention constant is a maximum, never a guarantee.
- **The keep-pin origin sidecar cannot carry new facts** (`keep-pins.ts:88-104`, §3.7). A future
  surface needs a **separate versioned sidecar** older clients ignore, and `pinned` is best
  *derived* (origin present, pin ref absent) rather than stored.
- **The server-side copy is not a recovery path.** The objects do survive in historical versions'
  bundle blobs — reachability is computed from the DO's retained roots
  (`apps/api/src/gc-phase1.ts:44-58`, `versions.ts:66+`) and history pruning is disabled in every
  deployed environment (`apps/api/src/retention.ts:36`) — but the window is the plan window
  (`apps/api/src/plans.ts:24-27`), not 90 days, and **no command restores a Git ref from a
  historical version**: `rbox restore <file>@<seq>` is file-plane only
  (`help-registry.ts:322-330`). §3.0a lists it as the unpromised manual backstop it is.

## 8. Rejected alternatives

1. **Relax `logicalBaseOid !== beforeOid` to permit create-over-positive-BASE.**
   Rejected — §3.1. It is the resurrection path, it makes BASE and P disagree about a
   transition's predecessor, and it turns `git branch -D` into a no-op fleet-wide.
2. **Silently drop the BASE member ("forget" the ref) and let the remote re-materialize
   the branch.** Same resurrection outcome, and it manufactures a BASE deletion with no
   receipt — precisely what `130:177-187` forbids. It also destroys the provenance the
   correct fix depends on.
3. **Let the pre-probe / ACK dry-run skip a pending ref the local repository lacks.**
   The cheap-looking version of P1b. Rejected: it is exactly
   `REVIEW-174-R1-OPUS-B.md:14`'s blocker in a new costume — a deletion is encoded as an
   *absence* from `P.refs`, and permitting supersession on absence alone lets one writer's
   stale section revert another writer's deletion fleet-wide and regress the tombstone
   high-water mark. The receipt is what makes the skip safe (§3.6).
4. **Let `publisher-ack` remove BASE members** (make capture authoritative for deletion).
   Rejected: a capture snapshot is taken without the repository protocol locks and without
   a locked R-absence proof. A capture racing a concurrent checkout, fetch or `update-ref`
   would author fleet-wide deletions from a torn read. `130:302-303` is right that ACK is
   add/advance-only; the answer is a properly locked receipt, not a weaker ACK.
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
   result is the wedge in §1.2.
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
- Assert **after**: an A artifact is committed for `R`; BASE retires `R`; the composed
  origins drop `R`; `pendingSupersessionAckConverges` now returns true for the candidate
  that omits `R`; the outgoing section omits `R` and carries a tombstone at `X`; the
  pre-probe returns `maybe`; the repository reaches `unchanged` on the next cycle with no
  deferral. **No keep-pin is created and none is expected** (R4, §3.0a) — assert
  `refs/rbox-local/keep/*` is untouched by an absence capture, so a future change that adds one
  has to say so.
- Assert the **ordering** requirement of §3.6 explicitly: with the A artifact suppressed,
  the dry-run must still refuse the omitting candidate.
- **§3.6a control flow, asserted at both defects v2 missed:**
  - *Latent wedge before the shortcut.* A repo with a stale positive BASE member, **no
    pending**, and an **unchanged** remote must be reconciled — pinning that the unchanged
    shortcut at `apply.ts:873` is not reached before absence reconciliation. The negative
    twin matters as much: a repo with no absent BASE heads must still take the shortcut with
    no new Git subprocess and no protocol lock acquired.
  - *No re-creation in the same pass.* After a retirement, assert the cycle ends with
    `result: "reconciled"` and that `publishRefPlane` does **not** create `R` from the
    section still in hand. Then assert the same cycle's push lane publishes the omitting
    section plus the tombstone at `X`, so cycle N+1 sees a section without `R`.
- **§3.6a step A′ — the crash the design used to wedge on. New in v4, and it is the highest-
  value new test here.** Kill the process between the A-artifact transaction and the BASE CAS,
  leaving a durable owning A with `BASE[R] = X` still positive. Then assert, in order:
  - **the v3 bug, as a negative:** with the remote still advertising `R = X` and **no**
    pending, the unchanged shortcut at `apply.ts:873` would return first — so assert step A′
    runs above it and the repository does **not** report `unchanged`;
  - **no resurrection:** assert `publishRefPlane` does not create `R` at `X` from the section
    in hand (the `logicalBaseOid === null` creation path, `follow.ts:965-988`) — this is the
    row that fails if A′ is placed below the follow instead of above the shortcut;
  - **completion:** `BASE[R]` is retired under `local-absence` authority, no *new* artifact is
    written, and re-running the cycle is a no-op (idempotence);
  - **the binding:** with the A artifact's `priorOid` mutated to some `X' ≠ X`, A′ refuses and
    leaves BASE positive;
  - **the present-again case:** with `R` re-created locally, A′ refuses, deletes nothing, and
    leaves both the artifact and BASE untouched.
  - **the lock lifetime (v5, round-3 M2):** re-create `R` after A′'s locked proof returns but
    before state save, and assert the state CAS **fails** rather than committing BASE-absent
    with a live `R`. This requires `local-absence` in the terminal-revalidation filter at
    `apply.ts:1900` — assert directly that a `local-absence` proof is not skipped there, because
    the skip is silent and the row above is the only thing that would catch it.
  - **the lossy read at the last checkpoint:** with the ref database made unreadable (the
    malformed loose ref below) between the proof and state save, assert the revalidation
    **refuses** rather than passing on `null !== null` (`apply.ts:1903`, `:1906-1909`).
- **§3.6a step A″ — the double-crash leg. New in v5, and the highest-value new test after A′.**
  Drive the process to each row of §3.6a's matrix and assert the outcome named there. The three
  rows that must exist as named tests, because each is a distinct failure if wrong:
  - **the inversion, as a negative (row 2):** with `BASE[R]` retired, a durable receipt at
    `priorOid = X`, `R` absent, and the incoming section still advertising `R = X` from this
    device's own last publish (`record.advertised.refs[R] === X`), assert the repository reports
    `reconciled` and that `publishRefPlane` does **not** create `R`. Then assert the *inverse
    without A″*: with the suppression disabled, `planBranchTransition` accepts
    `beforeOid: null → afterOid: X` and the transaction contains `delete <A.ref>`
    (`branch-transition.ts:136-141`) — i.e. pin the bug the fix exists to prevent, so a
    regression is a failing named test rather than a silent resurrection.
  - **idempotence across repeated crashes (rows 3, 4):** re-run the cycle N times in the owed
    window and assert identical durable state each time, and that A′'s retirement is re-derived
    rather than re-decided.
  - **release (rows 5, 6):** with the omitting push accepted but `advertised` stale, assert one
    extra suppressed cycle and then release once `advertised` omits `R`. Pair it with row 7
    (`R` re-created locally ⇒ not owed, stale receipt retired through the ordinary path) and
    row 8 (another writer's `R = Y` applies once the omission has published), so the predicate
    is proved to *release* and not merely to latch.
  - **the Z arm (§3.2a):** run the whole matrix a second time with the receipt compacted into
    the settled-absence ledger instead of a live A. **This is the row that fails if the Z
    projection is missing**, because conjunct 2 of `owed` cannot be evaluated without it.
- **§3.2a's receipt projection, directly.** With a settled-absence ledger entry for `R` and no
  live A, assert `prepareFollowerBranchProtocol` exposes `absenceWitnesses[R]` with the correct
  `priorOid` and `source: "z"` — and assert the *consumer* consequence, which is the one that
  actually bites: `pendingSupersessionPreProbe` returns `maybe` rather than
  `carry / local repository lacks pending ref …` (`pending-supersession.ts:105`). Pin today's
  behaviour as the negative first (no witness for the Z arm, `follower-protocol.ts:105-107`), so
  the test documents why the projection was needed.
- **§3.2 receipt binding — the P1b blocker, as a table.** With `base.refs[R] = X`,
  `pending.refs[R] = Y ≠ X`, and a valid A at `priorOid = X`: assert the pre-probe returns
  **carry** and `provePendingSupersession` returns **false**, so the omitting candidate is
  refused. Then apply the incoming section, assert `R` is created at `Y` through the ordinary
  creation path, delete it again, and assert the *second* absence capture (now at
  `priorOid = Y`) supersedes. Paired with the equality case (`pending.refs[R] === X`, the §1.2
  field shape) which must supersede on the first pass.
- **§3.3a strict read.** Build a repository with one malformed loose ref (write
  `not-a-sha` into `.git/refs/heads/<b>`), then assert: `readAllRefs` returns `{}`;
  `readAllRefsStrict` returns `unreadable`; absence capture refuses for the whole
  repository; the locked second proof in `commitPlannedBranchTransition` refuses; and a
  capture in that state does **not** emit a section advertising zero refs. Plus the
  positive twin: a freshly `git init`-ed repository (exit 1, empty stderr) returns
  `{ status: "ok", refs: {} }`.
- **§3.3b restore and unborn branch.** (i) `git checkout -b feature` with HEAD naming an
  absent `R` must never absence-capture, asserted both at plan time and via
  `locked.currentRef`. (ii) Replace `.git/refs` and `.git/packed-refs` in place from a
  snapshot, leaving the commonDir inode untouched, and assert `repositoryIdentityHash` is
  **unchanged** (this is the test that pins *why* rule 5 is insufficient) while the
  packed-refs inode signal refuses the capture. **(iii) The accepted residual, pinned as
  accepted — new in v4.** Do the same restore but preserve the `packed-refs` inode, advance its
  mtime, and retain a non-empty `logs/HEAD`: assert the capture **proceeds** and publishes the
  deletions. Name the test for what it is (`…_publishes_deletions_after_a_careful_in_place_restore_R4_accepted_residual`)
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

Table-driven, in the shape of `tombstone-attestation.test.ts:66-83`. Absence capture must
**not** fire when any single one of these holds, with everything else valid: existing A;
existing Z / settled absence; existing P/K; foreign artifact; sibling worktree owns the
ref; receiver-equivalent collision group; origin missing; origin OID mismatched; origin
lineage stale; `git` busy; preflight failure; repository identity changed; **`show-ref`
unreadable at plan time**; **`show-ref` unreadable at the locked second proof**; **`R` is the
current HEAD symref target**; **packed-refs inode changed or mtime regressed**; **`logs/HEAD`
missing while BASE recorded ≥ 1 head**; ref absent at plan time but present at the locked second
proof; **`R` is owed** (§3.6a A″ — the retirement is recorded but the omission is unpublished, so
no new capture may be decided for it either). Each case asserts BASE unchanged, no artifact
written, and no wire tombstone authored.

**Plus one structural row, re-homed from v4's §9.5 (see §9.5).** Assert that the outgoing
section for a repository with any held ref is either the reused pending section
(`publisher-tombstones.ts:183-186`) or a wholly local capture — **never a mixture**. That single
assertion is what keeps `provePendingSupersession` from ever seeing a value this device did not
capture, and it is the property design 201 must replace with something stronger rather than
weaken (§4.4's `gitCommitAncestry(Y, Y)` landmine).

*(v3's table had a "circuit breaker tripped" row and a "no keep-pin created" assertion on every
row. Both are gone with R4. The one keep-pin assertion worth keeping is the positive one in
§9.1: an absence capture must leave `refs/rbox-local/keep/*` **untouched**.)*

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
  all 24 are captured, one A artifact each, no deferral, no human prompt. This is the direct
  inversion of v3's headline row, and it is deliberately loud: if someone re-introduces a
  threshold, this is the test that fails and forces them to read §3.0a and §12 Q2.
- **Per-ref independence.** In the same repository, make one head fail rule 7 (HEAD symref) and
  assert the other 23 still capture — the eight rules are per-ref and one refusal never
  suppresses the rest.

### 9.5 ~~Per-ref pending lane (P4)~~ — no tests, because P4 is cut

**Removed with R5 (§4.4).** v4 specified fifteen rows here — carried-chain bundle coverage,
basis filtering, chain-bound refusal, carried absence, safe-ref refusal, non-ref facet carry,
`carry ⇒ never settled`, the `equalOrFastForward(Y, Y)` trap, both halves of the tombstone
authorship bar, the self-echo, the `gitIncomingKey` binding, unproved-ref refusal, the
receipt-disabled fallback, and the no-hold regression pair. None of them applies: nothing in
this design composes a merged section.

**Three of those rows are re-homed rather than deleted, because they test properties that are
load-bearing *today*:**

- **The `equalOrFastForward(Y, Y)` trap** moves to §9.2's adversarial table as a *carried-value*
  row: assert that `provePendingSupersession` is never reached with a candidate value the device
  did not capture. Today that is true by construction (the carry is byte-for-byte), so the test
  is a **structural** assertion that the outgoing section for a held repository is either the
  reused pending section (`publisher-tombstones.ts:183-186`) or a fully local capture — never a
  mixture. That is the single assertion whose failure would re-open the whole class, and it is
  the one design 201 has to replace with something stronger.
- **The no-hold regression pair** — assert today's byte-for-byte carry is still taken when a
  repository has any held ref, and that a repository with none captures normally. This is a
  pure regression pin for the behaviour R5 preserves.
- **The receipt-disabled fallback** — with `RBOX_GIT_ABSENCE_CAPTURE=0`, a locally-absent
  BASE-positive head must still be **carried**, never omitted from the published section. That
  row was written for P4's per-ref omission but the property it pins is P1b's, and §9.1 already
  needs it: omission is only ever licensed by a receipt.

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
- `rbox git deferrals` / `rbox status`: the new `ref-read-unreadable` reason (§3.3a) needs a
  `DEFERRAL_REASON_PRESENTATION` entry (`status-view.ts:287-305`) and a rank in
  `GIT_DEFERRAL_REASON_PRECEDENCE` (`sync-state-model.ts:149-153`; the compile-time
  totality proof at `:155-158` forces this). *(v3 also added a circuit-breaker reason; R4
  removed it, so this is the only new reason.)*
- **`gitStatus` (§3.3a), directly — rewritten for v5's contract.** Table-driven over **both**
  execution paths (`opts.stdin` set ⇒ spawn; otherwise `exec`), with one row per failure shape:
  a clean exit; a non-zero exit with stderr; a non-zero exit with **empty** stderr; a signalled
  child; a `maxBuffer` overflow on stdout; a `maxBuffer` overflow on stderr; and a `git` binary
  that does not exist (`ENOENT`). Assert, for every row:
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
  | `P2 no-escalation: capture must not be gagged (no carried pending section)` (`:374-376`) — requires `heldRecord.pending` to be absent while a divergent ref is held | **Wrong under R5.** Holding a divergent ref for a live worktree's lifetime *is* legitimate (§4.2), and the carried pending section is its bookkeeping. Only P4 could have satisfied this, and P4 is cut. | **RELAX to tolerate a carried pending section while the hold lives.** Keep asserting what the ruled semantic does promise: the pending section names **only** held refs (it must not carry refs that applied cleanly), and it disappears once the worktree is removed. |
  | `P2 no-escalation: repo must not carry a whole-repo apply deferral while one ref is held` (`:371-373`) | **Keep, unchanged.** This is P2's actual deliverable — no whole-repo deferral surface for a non-HEAD hold. | none |
  | `P2 no-escalation: unrelated incoming ref applies while one ref is held` (`:377-379`) | **Keep, unchanged.** | none |
  | `P2 no-escalation: unrelated change on main must still propagate A→B past a live worktree hold` (`:391-393`) | **Keep, unchanged — and note in the scenario that it passes on merit *today*** via design 174 supersession (the transition is a fast-forward), which is the empirical evidence R5 rests on (§4.2 point 2, §4.4). | add the comment |
  | every phase-2 / post-deletion / soak assertion | **Keep, unchanged.** These are P1's gate and are what must flip from RED to GREEN. | none |

  Net: phase 1 asserts **propagation of unrelated changes plus no whole-repo deferral
  surface**, and *tolerates* a carried pending section while the hold lives. Phase 2 remains
  the unrelaxed deletion gate. **If design 201 ever ships, the relaxation is reversed** — the
  stricter original assertion becomes 201's gate, which is why it is relaxed rather than
  deleted.
- **What the rig asserts about recovery, after R4.** Device B, having pruned `C` under the
  tombstone, still pins the displaced OIDs — assert `refs/rbox-local/keep/<X>` exists on B with
  a `tombstone`-class origin for the authorized tip and `human` for the rest of `C`'s reflog,
  because that is **existing** design-116 behaviour and this design must not regress it. On
  device A — the one that deleted the branch — assert the opposite: **no** keep-pin is created,
  and no `refs/rbox-local/keep/*` ref appears as a result of the absence capture (R4, §3.0a).
  The single-device variant therefore has no Git-side recovery at all, which is the accepted
  semantic and should be asserted as such rather than left to inference.
- **The file-plane promise, asserted in the rig.** In the same single-device run, assert that
  every file whose content lived only on branch `C` is still recoverable through the file plane
  at a prior sequence. That is the durability contract R4 rests on, and a rig that asserts the
  Git-side loss without asserting the file-side survival is asserting the wrong half.
- Field validation before any release, per the design-169 dev-build-first rule: a dev build
  on the founder's Mac against the live wedge, with `state.json` snapshotted before and
  after.

## 10. Non-goals

- **Two-writer non-fast-forward divergence** — still reserved for design 173. This design
  touches only the one-sided shape where BASE is positive and P is absent.
- **The per-ref pending lane / `pending ⊕ local` outgoing section (P4)** — a non-goal again,
  **CUT 2026-07-24 by R5** after three shapes failed three adversarial rounds (§4.4, §12 Q5).
  Parked as **[design 201](./201-per-ref-git-publishing.md)**; its honest prerequisite is a
  per-ref wire/state model, not another composition rule. This is a *cut with a recorded
  reason*, not a deferral of an agreed design.
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
  it only in the new `local-absence` authority arm. `branchProofMatches`
  (`base-composer.ts:246-260`) is shared by every branch transition and tightening it
  changes paths this design has not analysed — a real gap, recorded rather than closed.
- **Retiring the pre-1.6.8 hold behaviour.** §3.0 accepts that a lagging device defers that
  repository's Git plane until upgraded. Making old clients converge without upgrading would
  need a wire or protocol change and is out of scope.
- **Any threshold, count or breaker over ref deletions** — **removed by R4** (§3.0a, §3.5). Not
  "deferred": a future design that wants one has to re-open the product ruling first, because
  the ruling is that thresholds are the wrong instrument, not that this one was mistuned.
- **Any Git-side recovery guarantee, pin, or recovery command** — **removed by R4** (§3.0a,
  §3.7, §7.2). The durability contract is file history.
- **Publishing *anything* while a hold is outstanding, beyond what design 174's supersession
  already publishes.** A held repository keeps carrying its pending section byte-for-byte
  (`publisher-tombstones.ts:183-186`), so neither refs nor `head`, index, op-state nor config
  flow past a *divergent* hold. §4.2 states what does still propagate and why the residual is
  bounded by the worktree's lifetime. *(v4 scoped out only the non-ref facets, because P4 let
  refs through. With P4 cut the whole item is the non-goal, and it is design 201's subject.)*
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
| `RBOX_GIT_ABSENCE_CAPTURE=0` | on | P1 + P1b + §3.6a steps A′ and A″ (falls back to today's carry/refuse). *(v3 also had it disable §3.7's keep-pin and expiry sweep; R4 removed both.)* |
| `RBOX_GIT_CONTENT_EQUIV=0` | on | P3 (falls back to ancestry-only) |
| `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` | on | P2's held-skip eligibility **only** |
| `RBOX_GIT_OWNERSHIP_NO_ESCALATE=0` | on | P2's "no whole-repo defer for a non-HEAD ownership hold" |
| ~~`RBOX_GIT_PENDING_MERGE`~~ | — | **Gone with P4 (R5).** No switch, no bake condition, no staged flip. |

**Two switches for P2, corrected in v3.** v2 listed one switch and described it as disabling
P2. It does not: held-skip eligibility and the no-escalation change are independent code
paths, and a single `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` leaves the deferral-behaviour change
live. A kill switch that does not kill what the rollout section claims is worse than none,
because it is what someone reaches for at 2am.

**One thing `RBOX_GIT_ABSENCE_CAPTURE=0` must *not* do — new in v5.** With receipts already on
disk, turning it off must leave those refs **carried**, exactly as a pre-P1 client carries them —
never expose them to re-creation. It is a *stop authoring* switch, never a *resume applying*
switch. §9.1 asserts it.

**Landing order — corrected again in v5.**

1. **P2 + reporting.** Held-skip eligibility with the worktree digest, no whole-repo
   escalation for non-HEAD holds, `rbox doctor` leftover-worktree section behind §5.1's
   local-only projection. No authority change; pure performance and UX. **Not a precondition
   for anything.** Landed first because it is the cheapest real improvement and it makes the
   founder's machine observable while the rest bakes.
2. **P3.** Content equivalence in `noDropProof`, with §4.3's destructive-transition bar.
   Cascade reduction only. Independent. *(v3 and v4 landed it here "because it shrinks the held
   set P4 will first be exposed to". P4 is cut, so that reason is gone; it stays second because
   it is independent and it shrinks the held set P1 is first exposed to on the founder's
   machine — four of ten worktree branches, §1.1.)*
3. **P1 + P1b + §3.2a + §3.3a's `gitStatus` + §3.3b + §3.6a (A, A′, A″, B–D).** The authority
   change and everything that makes it safe: the one receipt projection, the strict ref read on
   its new structured runner, the restore/unborn-branch rules, and the reconciliation placement
   including A′'s crash completion and A″'s owed-omission suppression. These ship **together**,
   and v5 tightens why:
   - a P1 without §3.3a is a fleet-wide deletion waiting for one corrupt loose ref;
   - a P1 without A′ can wedge permanently on a crash it caused itself;
   - **a P1 without A″ can invert its own receipt into a creation** on the next pull after any
     crash or failed push in the retire→publish window (§3.6a A″, round-3 blocker 2);
   - **A″ cannot be implemented without §3.2a**, because the suppression must survive the A→Z
     compaction and only the Z projection can answer then.

   Validated on a dev build against the live wedge before any CLI release. **This is the last
   step**: with P4 cut there is no step 4, and everything inside step 3 is one unit.

*(v3's and v4's step 4 was P4 in two sub-steps, 4a "no behaviour change" and 4b "the merged
emit", with a four-part named bake condition, an explicit reverse migration, and a
`record.advertisedCarried` residual to read defensively on downgrade. **All of it is removed by
R5** — there is no new persisted field, so there is no reverse migration to specify and nothing
outlives a downgrade. §4.4 records why the shape failed; design 201 inherits the sequencing
question.)*

**Correction retained: "P2 must precede P1" was wrong.** `publishRefPlane` already returns a
per-ref held set — built per ref and returned both as a set (`follow.ts:1041`) and as a map
(`follow.ts:1047`) — and `apply.ts:1447` merely ignores the detail by consuming `held.length`.
P1 never needed P2. The ordering above is a *validation* sequence, not a dependency graph.

**Wire compatibility.** Nothing here changes the wire *format* **or its content**. Deletions
travel as design-130 `refTombstones`; every published section is still captured from local refs.
*(v4 had to carve out P4 as a wire-content change; **that carve-out is gone with R5**, and its
absence is the single largest reduction in this design's blast radius.)*

**Client skew.** An older client on the same account never authors absence receipts. Its
own BASE keeps the stale positive member, so for that repository it degrades to exactly
today's behavior (hold, `pending`, deferral) — no worse than before — and it cannot
resurrect the ref on the wire, because its capture omits what its P lacks and its own
ACK dry-run refuses the mismatch. A newer client's tombstone is processed by an older
client through the unchanged design-130 attestation path.

**Skew in the other direction.** An older client cannot re-create a ref from a newer client's
omitting section — that section does not advertise the ref at all. The dangerous echo was always
the deleting device's **own** stale advertisement, which is why A″ keys on `record.advertised`
rather than on anything a peer sends (§3.6a A″ conjunct 4).


## 12. Decisions

All six of v1's open questions were ruled by the founder on **2026-07-24**. Five further
rulings (**R1–R5**) were issued the same day, and four of them *change* earlier rulings. They
are kept here as a decision record rather than deleted; the questions are stated as they were
asked, followed by the ruling and its reasoning, in date order with each supersession named.
**Nothing in this section is open.**

**The five later rulings, R1–R5 (2026-07-24), in one place, in the order issued:**

| | Ruling | Changes | Where |
|---|---|---|---|
| **R1** | Mass-deletion breaker trips if **either** leg trips, whichever comes first — `n ≥ 25 OR n ≥ 25% of N` | **Supersedes Q2's `max()` form**, which was arithmetically incapable of tripping on any repository under 100 heads. **Itself superseded by R4.** | §3.5, Q2 below |
| **R2** | Deletion is not instantly fleet-wide; state the version floor honestly | Narrows Q1's stated semantic without changing the decision | §3.0, Q1 below |
| **R3** | The **deleting** device pins the commit locally for 90 days | **Reversed Q3** and retired Q3a. **Itself superseded by R4.** | §3.7, §8 item 10, Q3 below |
| **R4** | **rbox promises FILE history, not Git history.** No thresholds, no pins, no recovery command. | **Supersedes Q2, Q2b and R1** (the breaker) and **Q3 and R3** (the pin), and retires §7.2. The most consequential ruling in the design: it decides how much machinery a *wrong* capture deserves. | §3.0a, §3.5, §3.7, §7.1, §7.2, Q2/Q2b/Q3 below |
| **R5** | **P4 is CUT from design 200.** The per-ref pending lane is parked as design 201. | **Reverses Q5's in-scope ruling** on new evidence — three shapes failed three adversarial rounds, and the rig showed the propagation win P4 was justified by already works. Removes the design's only default-OFF step, its only bake condition, its only new persisted field, its only positive cost, and its only wire-content change. | §4.4, §4.2, §6, §9.5, §10, §11, Q5 below |

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

The two withdrawn rulings are kept below because each records a fact worth not re-deriving.

**Why the first ruling was withdrawn.** `max()` encodes a conjunction —
`n ≥ max(K, ceil(F·N))` ⟺ `n ≥ K ∧ n ≥ ceil(F·N)` — and the larger leg dominates. With
`K = 25` and `F = 0.25`, the absolute leg dominates for every repository under `K/F = 100`
heads, which is essentially all of them. The verified counterexample: a **24-head repository
whose entire ref set is deleted** yields `max(25, 6) = 25` and `24 ≥ 25` is false, so a total
wipe does not trip. The v2 prose ("the `K` floor exempts small repositories, the `F` leg
catches large ones") described the intent correctly and the arithmetic backwards; under `OR`
the mapping inverts and becomes correct.

**The precedent claim is also corrected.** v2 said this design copies design 108's
`max(fraction, floor)` shape. It does not, and 108's shape is not a `max`:
`pushMassDeleteTrips` is `deletes ≥ min ∧ deletes·100 ≥ pct·baseCount` (`policy.ts:22-35`)
— a genuine conjunction, defensible at file scale where `min = 1000` against hundreds of
thousands of files leaves the fraction dominant, and inverted at ref scale where counts are
in the ones to hundreds. What this design takes from 108 is its **posture** — publishing-side,
refuse before any encrypt/upload/commit work, fail closed, human consent as the only
override — not its boolean operator. Design 44's pull-side guard
(`deletes ≥ 100 ∧ deletes·2 ≥ baseFiles`, `policy.ts:11-15`, `pull.ts:276`) is the wrong
precedent on both counts. The "fails closed until a human says otherwise" phrasing is
verbatim from the comment on 44's constant (`policy.ts:14`) and is true of both.

> **~~2b. Small-repository hair-trigger under the `OR` form.~~ RULED, then MOOTED — both on
> 2026-07-24.** The question: `n ≥ 0.25·N` trips on one deletion in a 4-head repository and two
> in an 8-head one, and the founder's workspace has **median 1** BASE head per repository (110
> repos, ~203 heads, 84% at four or fewer), so R1 taken literally defers nearly every
> repository on the first routine `git branch -D` — the exact loop this design exists to
> automate. It was **ruled** as the guarded form, `n ≥ 25 OR (N ≥ 20 && n·4 ≥ N)`, with the
> 5–19-head window explicitly accepted. It is now **mooted by R4**: with no breaker there is no
> guard to place and no window to accept, and the whole size distribution is irrelevant to the
> predicate.
>
> **An extension was drafted for this revision and is WITHDRAWN, not deferred.** Codex's round-2
> blocker 3 showed that a sub-20-head in-place restore trips neither ruled leg, and the proposed
> close was a *total-absence* leg: `n ≥ 25 || (N ≥ 20 && n·4 ≥ N) || (a === N && N ≥ 2)`, where
> `a` counts observed absences before the per-ref rules (so one ref excluded by rule 7 could not
> hide a total wipe) and the `N ≥ 2` floor conceded that a one-head repository losing its only
> head is indistinguishable from the ordinary deletion of a just-created repository. It was
> never ruled, and R4 withdrew the whole line of attack. **It is recorded here only so nobody
> re-proposes it as new** — the founder's position is that thresholds are the wrong instrument,
> not that this one was mistuned. The shape it was meant to catch is now §3.0a's accepted
> residual and §9.1's deliberately-named accepted-residual test.

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

The R3 reasoning is kept below, because its *facts* are still true and its *mechanism* claim is
the one a future reviewer will re-propose.

**Why the reversal.** The conditional ruling's premise was that recovery is available from
a *follower's* prune pin. Codex showed the premise is not merely narrow but structurally
unreliable: the pin is created **by the prune** (`follow.ts:947-949` →
`prepareTombstonePrunePins`, `keep-pins.ts:635-654`), so it does not exist whenever nobody
prunes — a single-device workspace, both devices deleting before either applies the other's
tombstone, a device that never received the ref, or a fleet still on pre-1.6.8. The v2
analysis was also right about the mechanism and worth keeping: a `GitRefTombstone` is
`{oid, ts, generation}` — metadata only (`types.ts:71-75`) — and
`REF_TOMBSTONE_RETENTION_MS` retains the *OID*, not one Git object; what retains objects is
the deliberately equal-valued `TOMBSTONE_PIN_RETENTION_MS = 90 days` (`keep-pins.ts:68`).

R3 gives the A path the keep-refs the P path always had (`basePresentKeepRef`,
`base-artifacts.ts:114-118`) — closing an asymmetry, not inventing a mechanism. That
observation is still correct, and **§7.1 now records why the asymmetry is deliberate**: the P
artifact's keep-refs serve a crash-window rollback (a correctness need), while the A path's
would have served user-facing recovery (now the file plane's job).

Two consequences R3 had to carry, both gone with it: the object may already have been
`gc`-pruned before rbox looks (so the pin was a guarantee only when the object survived — a
guarantee with an exception is a poor foundation for a promise), and the 90 days meant nothing
until `expireTombstoneKeepPins` (`keep-pins.ts:434`, still referenced only from
`index.ts:284` and its own test) got a caller. R4 removes the need for both.

> **~~3a. Single-device workspaces.~~ RETIRED 2026-07-24 by R3, and still retired under R4.**
> Q3a asked whether to pin only when the account has one device. It was moot under R3 (the
> single-device case is one instance of recovery depending on somebody else pruning, and R3
> fixed the general case) and it is moot under R4 (there is no pin for anyone). Recording the
> retirement rather than deleting the question, because "pin only for single-device accounts" is
> exactly the kind of narrow optimization a future reviewer will re-propose; the answer is that
> the multi-device cases — concurrent deletion, never-delivered ref, old followers — are just as
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

Three rounds, kept so the next reviewer starts from here rather than re-deriving. Every code
claim in all three tables was re-verified against the worktree before being folded in, and
codex's mis-citations are corrected rather than propagated.

**Read §13.3 first.** Round 3 is where the design's largest scope decision was made: two of its
three blocking items were P4's, and the accumulated evidence across all three rounds is what
ruling **R5** acted on (§12 Q5, §4.4). Rounds 1 and 2 are preserved as written — including rows
whose *answers* R5 later mooted, which are marked in §13.3 rather than rewritten in place, so
the record shows what was believed when.

### 13.1 Round 1 — what was caught and how it was answered

**Verdict: NOT-ALIGNED — 7 blockers, 4 majors.** Round 2 confirmed 8 of the 11 closed. The
resolutions below are as v3 recorded them; **where R4 or round 2 later changed the answer, the
row says so** rather than being quietly rewritten.

### Blockers

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | Q3's no-pin premise is false even multi-device — recovery depended on a *follower* pruning, which does not happen in several ordinary cases | v3: **resolved by R3** (deleting-device pin). **v4: the finding stands and the *answer* changed — R4 removes the pin and answers the recoverability question at the product layer instead (§3.0a).** Codex was right that the follower-pin premise was unreliable; that premise is not restored. | §3.0a, §3.7, §7.1, §12 Q3 |
| 2 | P1 turns a ref-read error into fleet-wide deletion — `readAllRefs` maps any `show-ref` failure to `{}` | **Resolved.** Strict reader specified with the exit-code discipline the codebase already uses at `shared.ts:261-268`; mandatory site list includes the locked proof at `branch-transition.ts:309` and both capture sites. Reproduced empirically | §3.3a |
| 3 | P4 destroys P1's provenance invariant — carried values acquire `publisher-ack` origins | v3: held-ref-aware ACK authority. v4: same guarantee via "carry ⇒ never settled". **Moot under R5** — no section this design composes contains a relayed value, so the invariant is self-maintaining again (§3.4). The observation survives as design 201's first constraint (§4.4). | §3.4, §4.4 |
| 4 | P1's control flow does not clear the field wedge — the unchanged shortcut precedes the hook, and retiring BASE mid-pass lets the section re-create the branch | **Resolved.** Reconciliation moved above `apply.ts:873` with an O(1) cheap gate; `result: "reconciled"` ends the pass; the same cycle's push lane publishes the omission (`sync.ts:9-19` is pull-then-push) | §3.6a |
| 5 | BASE provenance proves possession, not the cause of absence — an in-place ref restore preserves identity | v3: §3.4 stops claiming otherwise; HEAD-symref rejection and ref-database signals added; **the breaker named as the primary restore detector**. **v4: the breaker is gone (R4), so this is now "detection hardening plus an accepted residual" — see round-2 blocker B3 and §3.0a.** | §3.3b, §3.4, §3.0a |
| 6 | P3 has a false positive and can authorize deletion — "waives holds only" is not a mechanism | **Partly resolved, honestly scoped.** `--verbatim` closes the whitespace half; the apply-then-revert false positive is **left standing and pinned by a test**; the boundary is made structural (waiver barred from destructive transitions + disjointness test); P3 re-described as cascade reduction | §4.3, §9.1 |
| 7 | P4's accepted-ACK state machine is undecided | v3: `partially-superseded` + hybrid BASE. Round 2 reopened it (B7); v4 replaced it with mutual exclusivity; round 3 killed that (B1). **Moot under R5.** | §4.4 |

### Majors

| # | Finding | Resolution | Where |
|---|---|---|---|
| 8 | P2/P3 do not fix wedge (a) as claimed — a hold only exists for refs the incoming section wants to change | **Accepted; claims corrected.** `follow.ts:732` precedes `:734`, so the "already convergent" filter is a no-op and supersession still refuses. P4 is now stated as the *only* fix for the capture gag | §4.2, §4.5, §5 |
| 9 | Rollout ordering and rollback independence overstated | **Accepted; corrected.** P2 demoted from precondition (`follow.ts:1041`, `:1047` already return a per-ref held set); P2's switch split in two; P4 given an explicit reverse migration and a receipt-disabled fallback rule | §11, §4.4 |
| 10 | 1.6.6 skew is behavioural, not schema | **Resolved by R2**, with the floor corrected to **v1.6.8** (commit `04c2aff8`) from the verified tag rather than assumed | §3.0, §12 Q1 |
| 11 | Recovery window not discoverable — tombstones evict before they expire and `show-me` structurally omits OIDs | v3: `rbox git deleted` specified. **v4: MOOT — R4 removes the pin, so there is nothing to enumerate; the *facts* (eviction caps, the OID scrubber, the closed origin schema) are kept in §7.2 because they constrain any future recovery surface.** | §7.2, §3.0a |
| 12 | doctor privacy boundary — the bundle uploads `ctx.checks` unredacted | **Resolved for the new surface.** Typed local-only projection excluded from `checks` and from the bundle; the pre-existing `ctx.checks` exposure stays scoped out | §5.1, §10 |

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

### 13.2 Round 2 — `REVIEW-200-R2-CODEX.md`, and how v4 answers it

**Verdict: NOT-ALIGNED.** Round 2 confirmed 8 of the 11 round-1 findings closed, left 3
not-closed, and added 4 blockers and 5 majors. It also verified the six corrected citations in
§13.1 and confirmed `04c2aff8` first appears in `v1.6.8`.

**Round-1 findings left not-closed, and their v4 disposition:**

| R1 # | Round-2 objection | v4 |
|---|---|---|
| 5 | Provenance does not prove cause of absence: with the guarded breaker inert below 20 heads, a refs-only in-place restore passes both new heuristics and publishes every missing head | **Answered by ruling, not by mechanism.** R4 (§3.0a) accepts the residual explicitly, §3.3b (iii) re-frames the signals as detection hardening, and §9.1 pins the accepted behaviour as a named test. The proposed total-absence leg is **withdrawn** (§12 Q2b). |
| 7 | `partially-superseded` is internally inconsistent — carried refs at prior BASE vs a deep-equality ACK check, and a hybrid BASE with an under-covering pack chain | v4: resolved by redesign — no hybrid, no third outcome. Round 3 then killed the replacement (B1); **moot under R5** (§4.4, §13.3). |
| 9 | Rollout/rollback inherits finding 7's invalid hybrid BASE | v4: resolved — no hybrid, so no BASE state to unwind. **Moot under R5**: with no new persisted field there is no reverse migration at all (§11). |

**New blockers:**

| # | Finding | Resolution | Where |
|---|---|---|---|
| B1 | P1b can supersede a pending value the receipt does not witness — an A for BASE/local `X` authorizes omitting another writer's unseen `Y` | **Resolved.** Supersession requires `receipt.priorOid === pending.refs[R]`; a mismatch **carries**, the apply lane then re-creates `R` at `Y` through the ordinary creation path, and a second deletion mints a receipt bound to `Y`. The binding already exists in-tree at `follow.ts:857`. | §3.2, §9.1 |
| B2 | Pin+A crash recovery still misses the unchanged path — an existing A is excluded by rule 3, the in-follow recovery needs the incoming section to omit `R`, and the shortcut returns first | **Resolved.** New **step A′** above the unchanged shortcut completes the retirement idempotently from the durable artifact, with the inverse of rule 3 and a fresh locked proof. The second half of the finding — that `keep-pins.ts:425-428` is generic filter logic with no production caller, so v3's crash-row-1 claim was false — is **moot now the pin is gone** (R4), and §7.1 records that `expireTombstoneKeepPins` still has no caller and deliberately does not get one. | §3.6a A′, §7.1, §9.1 |
| B3 | Sub-20-head restore hole: an in-place refs restore with retained logs/HEAD bypasses both heuristics and the guarded breaker cannot trip below 20 heads | **Not closed — accepted.** A total-absence leg (`a === N && N ≥ 2`) was drafted for this revision and **withdrawn by R4**: no thresholds. §3.0a states the residual, its recovery sources and the founder's acceptance; §9.1 pins it as an accepted-residual test. **This is the one round-2 blocker answered by a product ruling rather than by code.** | §3.0a, §3.3b (iii), §12 Q2b |
| B4 | P4 partial settlement is not closed under ACK failure or incremental capture — deep-equality vs retained prior BASE, advanced BASE refs with a pack chain that does not cover them (`incrementalCapturePlan`, `src/cli/sync-git/shared.ts:135-141`), and a lost ACK CAS overwriting the verbatim pending section | v4: resolved by redesign (no hybrid BASE — "carrying and settling are mutually exclusive"), having first worked out and rejected the "BASE follows the published section" alternative. **Round 3 then killed the replacement too (B1), and R5 cut P4** — all three shapes and their exact failure mechanisms are in §4.4. | §4.4, §13.3 |

**New majors:**

| # | Finding | Resolution | Where |
|---|---|---|---|
| M1 | Strict-read stderr taxonomy has no stable API — the cited precedent checks only the exit code, and `gitRaw`'s two paths expose failure differently | **Resolved.** Structured `gitStatus(root, args)` returning `{status:"ok"}` or `{status:"failed", code, stdout, stderr}` across both paths, with `code` normalized to `null` for signals/spawn faults; exact reader semantics stated as three lines; `gitRaw` re-implemented over it with a byte-identical throwing contract; `readLocalGitConfigEntries` moved onto it in the same change. | §3.3a, §9.6 |
| M2 | Carried absence has no representation — a `Record<string,string>` cannot express a held ref whose pending value is deletion | v4: `carriedRefs` became a sorted **list** of ref names, after verifying no wire sentinel is possible (`refs` values must be 40-hex, `manifest-validate.ts:387-390`, and an invalid one rejects the whole section). Round 3 then found the partition using it **not total** (M4). **Moot under R5** — no partition, no persisted field (§13.3 M4). | §4.4, §13.3 |
| M3 | `pinned:false` and deletion provenance have no persisted shape — `KeepPinOrigin` encodes neither | **MOOT under R4** — no pin, no listing. The finding's *analysis* is kept because it constrains any future recovery surface: `parseKeepPinOrigins` rejects unknown fields and unknown `class` values (`keep-pins.ts:88-104`), so extending it is a downgrade hazard; a separate versioned sidecar is required, and `pinned` is best derived (origin present, pin ref absent) rather than stored. | §7.2, §3.7 |
| M4 | Tombstone-pin expiry can starve forever — the only caller would be after a successful capture | **MOOT under R4** — no pin, so no sweep. Recorded honestly: `expireTombstoneKeepPins` still has **no production caller**, so already-shipped follower-prune pins are still retained indefinitely. That is pre-existing over-retention, it errs safe, and this design deliberately does not change it. *(Had a sweep been needed, the right host was the daemon's cycle-level `runDeferralHygiene()` tick (`daemon.ts:2197-2223`) — which visits repo records regardless of whether they captured — and **not** `reconcileGitDeferrals` itself, which returns early when no reconcilable deferral exists, nor `rbox status`, which must not mutate refs.)* | §3.7, §7.1 |
| M5 | Q2b remains normatively contradictory — §3.5 and §12 say "STILL OPEN", §9.4 says "whichever the founder rules", §7 invariant 4 states the unguarded leg | **Resolved by sweep, to a different answer than the one the finding assumed.** Every occurrence now says **no thresholds** (R4): §3.5 is a removal record, §7's invariant 4 is deleted (the invariant list renumbered), §9.4 becomes two negative tests, §12 Q2/Q2b carry dated supersessions, and the v3 changelog entry points at §12. Grepped for `Q2b`, `STILL OPEN`, `unguarded`, `hair-trigger` and `breaker` to confirm no stale normative statement survives. | §3.5, §7, §9.4, §12 |

### 13.3 Round 3 — `REVIEW-200-R3-CODEX.md`, and how v5 answers it

**Verdict: NOT-ALIGNED.** Round 3 confirmed **10 of round 2's 17 findings closed** (four of
them "narrowly"), left the three R4-accepted or R4-mooted ones correctly recorded as such, and
added **6 blockers and 5 majors**. Its shortest blocking list had three items, and **two of the
three were P4's** — which is what made R5 the right answer rather than a fourth composition
rule.

**Round-3 findings, and their disposition in v5:**

| # | Finding | v5 |
|---|---|---|
| **B1** | P4's self-echo re-gags every captured branch after one emit: the bar that keeps carried values out of BASE keeps captured ones out too, so `heldRefs[D] = "local-commits"` (`follow.ts:895`) after the first emit | **MOOT — P4 cut (R5).** Recorded in §4.4 as the third failed shape, with the mechanism, because it is design 201's central problem. |
| **B2** | A′ is not idempotent across a second crash or failed push: after BASE retirement, a crash before the omission publishes lets this device's own stale advertisement re-create `R` and destroy the receipt | **RESOLVED — §3.6a step A″.** A durable `owed` predicate over `base` / receipt / strict live read / `record.advertised`, releasing exactly when the omission publishes, with the nine-row double-crash matrix worked through. Codex's citation of A→Z compaction is **corrected**: `settleCommittedBranchArtifacts` filters to `pull-ref-transaction`/`journal-recovery` (`apply.ts:1944-1946`, `:1957`), so a `local-absence` A does **not** settle — but the finding stands regardless, because `follower-protocol.ts:88` (A) and `:106` (Z) both drop `R` from `logicalBaseRefs` and `branch-transition.ts:136-152` retires either artifact inside the creation. |
| **B3, B4, B5, B6** | Four independent ways the merged section `M` is unshippable: not operationally v1.6.8-importable (`importGitPackChain` skips a historical link whose tips are present); excludes BASE prerequisites its own chain lacks; exhausts `MAX_PACK_CHAIN` under repeated self-echo (which falsified the 7-day bake narrative, hence no bake in §11); and can be made invalid by a receipted pending HEAD | **MOOT — P4 cut (R5).** All four are kept verbatim in §4.4 as design-201 prerequisites. One is *not* mooted and is restated there: §3.3 rule 7 checks the **local current** symref target, so any future model that omits refs from a section must separately check that section's own `head`. |
| **M1** | P1b and A′ do not define a usable settled-Z receipt projection: `absenceWitnesses` is populated only from live A entries, and the settled loop supplies no witness or `priorOid` | **RESOLVED — §3.2a.** One `absenceReceipt` projection covering both arms, fed to the pre-probe, the final proof, and A′/A″. Codex's fix (call `lookupSettledAbsence`) is **improved on**: the Z loop already iterates the `BaseAbsentPayload`, so the witness is populated in place, and the `source: "z"` member already exists with live consumers (`apply.ts:1910`, `:1963`). Codex was right that a literal v4 implementation "can miss the normal Z receipt and carry forever". |
| **M2** | A′'s locked proof is not connected to state-save revalidation — pre-state-save terminal revalidation handles only `pull-ref-transaction` and `journal-recovery`, so `local-absence` would be skipped | **RESOLVED — §3.6a A′.** Lock lifetime stated (the protocol lock from step A, held to the CAS), `local-absence` added to the filter at `apply.ts:1900`, and the loop's existing absent-witness body reused. **Plus one thing codex did not name:** that site reads `readAllRefs` (`apply.ts:1903`) and compares `null !== null` for an absent witness, so it is defeated by the same lossy reader as `branch-transition.ts:309` — it is now a **fourth mandatory strict-read site** (§3.3a). |
| **M3** | `gitStatus` has two incompatible fault contracts — "spawn/IO faults still reject" vs `code: null` for ENOENT/maxBuffer/signal, and `gitRaw` cannot then recreate today's exact `message` and `code` | **RESOLVED — §3.3a**, which tabulates all four of today's failure shapes and states one rule: **nothing rejects; every failure is data**, carrying `exit` plus `cause` (the exact error `gitRaw` throws), so `gitRaw` is byte-identical by construction rather than by reconstruction. |
| **M4** | The carried/captured partition is not total — the universe `pending.refs` cannot discover a carried absence, and `capturedRefs = keys(section.refs) \\ carriedRefs` omits every captured absence | **MOOT — P4 cut**, and moot *completely*: the partition existed only to compose a merged section, `carriedRefs`/`record.advertisedCarried` only to represent it, and no surviving mechanism partitions a section's refs at all — the carry is whole-section and byte-for-byte. Recorded because the underlying requirement is design 201's (§4.4): an **explicit universe** over pending ∪ BASE ∪ local/candidate ∪ held names, all four classes, and sorted-unique validation on anything gating destructive tombstone authorship. |
| **M5** | P4's reverse migration does not state when carried authorship state becomes safe to clear | **MOOT — P4 cut.** With no new persisted field there is no reverse migration (§11). Recorded in §4.4 with the other same-shape majors. |

**Round-2 findings round 3 re-examined, and the two that need no further work:**

- **B1 (exact receipt binding) — CLOSED clean.** Codex verified the mechanism end to end,
  including that the mismatch path creates `P + R=Y` while retiring A/Z
  (`branch-transition.ts:136-176`), composes a `pull-p` origin at `Y`, and terminates without a
  capture-gag loop. Nothing folded; §3.2 is unchanged apart from the projection §3.2a adds
  beneath it.
- **B3 (the careful in-place restore) — NOT-CLOSED, accepted under R4**, and round 3 explicitly
  respected the ruling: *"None of the new blockers below asks for a threshold, recovery pin, or
  listing command."* Left exactly as it is (§3.0a, §13.4 item 2).
- **M3/M4 (pin schema, expiry starvation) — moot under R4**, confirmed correctly recorded.
- **M5 (threshold contradiction) — CLOSED** after v4's sweep; round 3 re-grepped and found no
  stale normative statement. v5 does not reopen it.

**Two round-3 verdicts worth reading as warnings rather than as closures**, because both were
"CLOSED **narrowly**" and both narrowed onto P4:

1. *"CLOSED narrowly — hybrid accepted-ACK state. Mutual exclusivity removes the impossible
   hybrid BASE… P4 itself still fails for independent reasons below."*
2. *"CLOSED narrowly — the three v3 partial-settlement failures. Keeping BASE wholesale closes
   the invalid algebra. It does not make the replacement P4 state machine achieve its goal."*

Three rounds of closing the *stated* objection while the feature failed for a new reason each
time is the pattern the founder's standing rule names: a model that breaks on a new exotic input
every round is on the wrong plane. That is the reasoning R5 acted on.

### 13.4 What is deliberately left standing

1. **P3's apply-then-revert false positive** (§4.3). Not a founder question — a scope
   decision, taken deliberately: an exact result-state proof is a separate design, and P3's
   structural bar against destructive transitions is what makes leaving it acceptable. If a
   reviewer disagrees that the bar is sufficient, P3 should be cut rather than expanded.
2. **The in-place-restore residual** (§3.0a, round-2 B3). Accepted by ruling, bounded by the
   file-history contract, pinned by a named test. A reviewer who finds another uncovered restore
   shape has found an instance of an accepted residual; what would be a genuine blocker is a
   shape in which rbox publishes a deletion for a ref whose absence it never observed under the
   strict read, or for which no current-lineage origin proves prior possession.
3. **`branchProofMatches` still ignores `locked.currentRef` in general** (§3.3b (i), §10).
   Enforced only in the new `local-absence` arm; the general gap is recorded, not closed.
4. **`ctx.checks` is still uploaded unredacted** (§5.1, §10). This design must not add to that
   exposure, and does not; closing it is a separate change.
5. **A divergent worktree hold still keeps the pending section carried, for the worktree's
   lifetime** (§4.2, §4.4, R5). Deliberate, and the largest thing this design chooses not to
   fix: unrelated fast-forward work still propagates via design 174 supersession, everything
   clears at deletion via P1/P1b, and the honest fix is a per-ref wire model —
   **[design 201](./201-per-ref-git-publishing.md)**. A reviewer who finds a shape where this
   *loses* work rather than *delaying* it has found a blocker; a reviewer who finds another
   shape where it delays publication has found this item.
6. **A″'s suppression can delay a legitimate re-creation of the same ref at the same OID by
   another writer**, for as long as this device's own omission is unpublished (§3.6a A″, matrix
   row 9). Bounded by one cycle on the happy path, never a refusal, and the alternative — letting
   the device's own stale advertisement win — is the inversion round 3 blocked.

*(v4's item 5 here was "P4's recurring-capture cost is unoptimized on purpose". **Gone with
R5** — there is no recurring cost left to leave unoptimized, §6.)*
