# 200 — Worktree lifecycle resilience: capturing out-of-band branch deletion

Status: DESIGN v7 — 2026-07-24. **v7 is a re-frame, not a sixth patch round.** Codex round 5
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
all **34** findings from rounds 2–5 under the new shape: **11 are N/A because the window they live
in no longer exists**, 13 remain moot under R4/R5, and 10 survive and are carried forward.

What survives unchanged, because none of it was ever about the window: the nine-rule deletion
witness and its fail-closed discipline (§3.3), the strict ref read at all its mandatory sites
(§3.3a), restore/unborn-branch detection (§3.3b), the possession invariant (§3.4), the **exact-OID
tombstone authorship** round 4 demanded and round 5 CLOSED (§3.2 — now the centrepiece rather than
a rider), P1b's binding to the exact value being retired (§3.2), rule 9's scoped-section refusal,
invariant 10, the `gitStatus`/`gitRaw` carried-cause contract (§3.3a), P2, P3, and every founder
ruling R1–R5.

Author: Claude, from first-hand field forensics on the founder's Mac, 2026-07-24.

**What v7 costs, stated up front rather than buried in §13.** Three residuals, each smaller than
the machinery it replaces:

1. **An unpublished deletion can be lost.** If a peer asserts the ref again *after* this device's
   omission is acknowledged, the assertion wins and the branch comes back; the user re-deletes it
   in one keystroke. That is C1's ruled direction — never destroy another writer's ref — and R4's
   ruled contract that the file plane, not the Git plane, is the durability promise (§13.4 item 6).
2. **"Deleted here, advanced there" is a two-sided divergence, and v7 says so** instead of deciding
   it unilaterally. The ref holds per-ref, the repository keeps carrying its pending section while
   it holds, and the human exit is `rbox git resolve keep-mine`, which stops refusing this shape.
   §10 has always reserved two-sided divergence for design 173 (§3.6 case (b), §13.4 item 7).
3. **One race survives**: a crash in the millisecond window between an accepted POST and its state
   CAS, followed *within one pull cycle* by a peer that prunes and re-creates the identical OID,
   can have that re-creation pruned. v6 spent a persisted field, four transitions and a three-row
   reconciliation table on this because v6's predicate latched **indefinitely**; v7's window is one
   cycle wide and closes itself from the wire (§13.4 item 8, reversal recorded as §12 C3).

**Earlier revisions, compressed — §12 (rulings) and §13 (review record) are authoritative.**
*v6:* replaced A″'s `advertised` conjunct with a durable omission intent, gave the omission
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

**Cost is negative in wall clock and free at rest, with no positive-cost item anywhere, and v7
removes v6's only per-deletion state write.** The new checks are O(1) per BASE head in the negative
case and are gated behind proofs that already failed, while making ownership holds held-skip
eligible removes a full follow per cycle from exactly the repositories that suffer today. **P1's
standing cost is one verify-only ref transaction per deleted branch** — no artifact, no extra state
save, no persisted field (§6).

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
| **L** — locked proof | plan, immediately after W, once per witnessed ref | One prepared **verify-only** ref transaction — `verify R 0000…0` plus `reserveNonRacingHead`'s HEAD line (`branch-transition.ts:72-91`) — that writes **no artifact and commits no mutation**. Success under `R.lock` is the locked absence proof (§3.3 rule 6). Any refusal — ref present, lock held by another Git process, HEAD moved, transaction error — drops `R` from the witnessed set and leaves it exactly as today. |
| **T** — tombstone | `normalizePublishedGitSection` | The candidate omits `R` by construction, because capture reads live refs. The normalizer authors one tombstone at **exactly** `X` (below). |
| **K** — acknowledgement | the push's ACK state CAS (`push.ts:955-975`) | `composeRepoBase` retires `BASE[R]` under `publisher-ack`, from the proof carried in the same packet — the same CAS, the same authority and the same crash story as every other ref that section advertised. |

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
What remains is a re-creation between L and the ACK, and it is benign and convergent — §3.6
case (d).

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
(`tombstone-attestation.ts:91-110`).

**Proposal P1b — unblock the pending lane.** `pendingSupersessionPreProbe`
(`pending-supersession.ts:103-105`) and `provePendingSupersession` (`:198-209`) must stop treating a
missing head as an automatic carry. The new per-ref rule for `refs/heads/*`:

| Local state of a pending head `R` | Disposition |
|---|---|
| present and equal, or a fast-forward descendant | supersede (today's rule) |
| absent, §3.3's witness holds, and **`pending.refs[R] === record.base.refs[R] = X`** | **supersede** (new) |
| absent, witness holds, but `pending.refs[R] ≠ record.base.refs[R]` | **carry** (new in v4, kept) — the pending value arrived from a writer this device never followed, so superseding it would retire a value this device never held. §3.6 case (b) |
| absent, no witness | carry (today's rule — fail closed) |

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
   the proof exists and the durable record of a deletion does not — §13.6.)*
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
| **Push** (§3.2 steps W, L) | **all nine** | authorize the destructive act: omit `R`, author the tombstone at `X`, retire `BASE[R]` at the ACK | fail closed — the ref is published exactly as today (carried, or simply not omitted) |
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
   the follow **holds** `R`: one entry in the classification pass at `follow.ts:728-768`
   (`classifiedHolds.set(R, "local-commits")`), which the main loop consumes at `follow.ts:838-846`
   *before* any transition is planned. Nothing else changes. The hold is per-ref; it is not the
   incoming-HEAD whole-repository escalation (`follow.ts:708-711`); every other ref of the section
   applies normally; and the ordinary `held.length > 0` path retains the **whole** incoming section
   as `pending[rel] = remoteSec` with the per-ref split recorded separately in
   `partial.appliedRefs` / `partial.heldRefs` (`apply.ts:1426`, `:1448`).
2. **Push / plan — the publication.** Step W re-derives the witness, step L takes the locked absence
   proof, the capture omits `R`, step T authors the tombstone at `X`, and P1b lets the omitting
   candidate supersede the retained pending section when — and only when — `pending.refs[R] === X`.
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
side: `plan.ts:836-861`'s trusted-fingerprint carry must not skip a repository that has a positive
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
  (`follow.ts:1025`), and it is held-skip eligible like any other `local-commits` hold;
- it **clears automatically the moment either side moves**: the peer deleting `R` too reaches case
  (c); the user re-creating `R` reaches case (d); a peer advancing `Y` further changes nothing but
  costs nothing;
- the **human exit is `rbox git resolve <repo> keep-mine`**, which must stop refusing this shape.
  `resolve-command.ts:658-665` rejects exactly *"a pending branch absent locally that BASE holds
  present"* by name, and design 176 §2.4 admits it "does not clear either shape". Under confirmed
  `manual` authority the shape is **already expressible**: `planManualBranchTransition` with
  `physicalBeforeOid: null, afterOid: null` writes the A and the `manual` composer arm retires BASE
  (`base-composer.ts:425-440`). What changes is the refusal, the report line, and that the published
  section carries a tombstone at `X` — never at `Y`, so no follower prunes the value this device
  never held. Design 176's "resolve it explicitly" finally has a verb (§2.4);
- the **residual is the one §4.2 already accepts** for a divergent worktree hold, in the same class
  and for the same reason: a repository with an unreconcilable ref keeps carrying its section until
  that ref reconciles, and closing *that* needs per-ref publishing — design 201.

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
instant is a re-creation **between step L's locked proof and the ACK**, which retires BASE while the
ref exists locally. That state is neither a wedge nor a falsehood: the tombstone claims `X` was
deleted, which it was, and BASE records what this device published. The next cycle's follow sees
local `R` present while the incoming section omits it, so the ref is held (`tipOwnedByIncoming`
refuses at the new value and attestation refuses because live ≠ the tombstoned OID), the pending
section is carried, supersession succeeds because that pending section has **no** `R` entry, and the
next capture publishes the re-creation. Non-destructive, and converged in one further cycle.

**The crash table — six rows, every row re-derived from durable state.** `K` marks where the process
dies. There is no per-ref durable deletion state to be in the wrong half of, which is why this
replaces v6's eleven rows and its reconciliation table.

| # | Crash / failure point | Durable state after | What the next cycle does | Outcome |
|---|---|---|---|---|
| 1 | **K anywhere before the POST** — witness, locked proof, capture, encrypt, upload | nothing new: L writes no ref, no artifact, no state | W and L re-derive from BASE and the live refs; the ref is still held | Idempotent by construction, any number of times. |
| 2 | **The POST fails** — offline, quota, 422, rejected | nothing new | identical to row 1: the ref stays held, the omission is re-captured and re-published | The common failure. The deletion is not lost and the ref is not re-created. |
| 3 | **K after the server accepted the omission, before the state CAS** | BASE still positive; the wire's head omits `R` | case (c)'s arm retires BASE from the head that omits `R`. If the head has since moved on, the next capture re-publishes an identical omission and its ACK retires it | Converges with **no** local record of the attempt — this is the row v6 needed `record.absenceOmission` for. |
| 4 | **K after the ACK state CAS** | BASE retired, `advertised` omits `R` | nothing asserts `R`, nothing is owed | Converged. |
| 5 | **A peer asserts `R = X` after the omission was acknowledged** | BASE retired ⇒ no witness ⇒ no hold | the ordinary `null → X` creation applies | The deletion is lost and the branch comes back — C1's ruled direction (§13.4 item 6). **No omission is ever re-published after its own retirement**, which is why round 4's same-OID ABA is not expressible. |
| 6 | **A peer asserts `R = X` while the omission is genuinely unpublished** | BASE positive | case (a): held, and the same cycle publishes the omission; the peer then prunes on attestation | Bounded by one cycle. Our deletion is causally first here — nobody has seen a deletion of `R` yet. |

**Row 3 plus row 6 is where the last race lives**, and it is stated rather than defended: if row 3's
crash happens *and* a peer prunes `R`, re-creates it at the identical `X`, and publishes all before
this device's next pull, then row 6's re-publication tombstones a legitimate re-creation. The
conjunction is a millisecond-wide crash window followed by a deliberate same-OID re-creation inside
one cycle; the pruning peer still pins the displaced tip (`prepareTombstonePrunePins`,
`keep-pins.ts:635-654`) and the content is in the file plane (R4, §3.0a). v6 spent a persisted field,
four transitions and a three-row reconciliation table to close this window because **v6's predicate
latched indefinitely** — an armed intent stayed owed until something reconciled it, giving a peer
unbounded time. v7's window is one pull cycle wide and closes itself from the wire. §13.4 item 8
records the residual and §12 C3 records the reversal — a one-field pre-POST arm — so a founder can
order it without re-deriving the argument.

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
pass (`follow.ts:728-768`) with the existing persisted `local-commits` value; only the reported
blocker reason is new (§5.1, §9.6). Two consequences worth naming: the deletion hold inherits
held-skip eligibility for free, and an older client reading that record sees `local-commits`, which
is exactly today's meaning.

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
| Published branch deleted locally (`git branch -D`, `git branch -d`, agent cleanup — **not** `git worktree remove`, which changes no ref) | The ref is held for that cycle instead of throwing; the same cycle's capture omits it, proves the absence under `<ref>.lock`, and publishes a tombstone at the exact retired value; the ACK retires the BASE member and releases the hold. One bounded log line. **No local artifact, no persisted intent, no pin, no recovery listing** — §3.6, R4 §3.0a. |
| `pending` carried on a ref the local repository no longer has, at the value BASE holds | Supersedes in the same cycle the witness holds (§3.2 P1b). |
| Abandoned worktree holding a branch | Per-ref hold only; the repository is no longer *deferred* and the follow is held-skipped until the worktree registry changes. **A divergent hold still keeps the pending section carried** for the worktree's lifetime, and that is accepted (§4.2, R5). |
| Unrelated local work while a worktree hold is outstanding | **Propagates already, where the unrelated transition is a fast-forward** — design 174's supersession, verified by the rig's phase-1 assertion (§4.2 point 2, §9.6). A non-fast-forward change on another ref of the same repository waits for the hold; closing that needs **design 201** (§4.4). |
| Squash-merged branch cascading holds onto unrelated refs | Cascade broken by content equivalence. It does **not** lift the first-pass ownership hold on the merged branch itself (§4.3). |
| Stale positive BASE member left by a *past* deletion (the latent wedge, §2.3) | Published by the push lane, which runs whether or not the apply lane takes its unchanged shortcut; the trusted-fingerprint carry is gated on the same O(1) predicate so the repository is not skipped (§3.6). |
| The omission's push fails (offline, quota, rejected) or the process dies before it | Nothing durable was written, so the next cycle re-derives the witness and retries. The ref stays held meanwhile and is never re-created (§3.6 rows 1–2). |
| The omission is accepted but the ACK state CAS is lost to a crash | The next pull sees a head that omits the ref and retires BASE through design 130's ordinary `pull-ref-transaction` absent path (§3.6 case (c), row 3). |
| A peer legitimately re-creates the branch after the omission landed | Applied as an ordinary creation. rbox never re-publishes an omission after its own retirement, so a causally newer assertion is never contradicted (§3.6 row 5). |

**Still needs a human, and should say so loudly.** v3 led this table with the circuit
breaker; **R4 removed it** (§3.0a), so mass absence no longer stops for anyone — the row is
gone rather than reworded, and §3.0a is where that consequence is accounted for. v7 adds one row,
and it is a row v6 hid by deciding the case unilaterally.

| Situation | Why | What rbox should say |
|---|---|---|
| A ref read fails in a way that could be mistaken for "no refs" (§3.3a) | An absence proof derived from a failed read is a fleet-wide deletion waiting for one corrupt loose ref. | Defer the repository under `ref-read-unreadable`; name the repository and the exit code, never the message text. |
| **A branch is deleted here and advanced by another writer** (§3.6 case (b)) | Two-sided divergence — both facts are real, and rbox does not pick a side (§10 reserves this for design 173). Publishing the omission would retire a value this device never held (round-2 blocker 1). | Hold that one ref, keep the repository syncing everything else, and name the exit: `rbox git resolve <repo> keep-mine` to publish the deletion, or re-create the branch. The refusal at `resolve-command.ts:658-665` is removed so the verb exists (§3.6). |

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
| P1 witness evaluation, negative case (both lanes) | O(BASE heads) in-memory lookups against a ref map each lane already read. **Zero new Git subprocesses.** | ~203 property lookups per full pass. Unmeasurable. |
| §3.6's plan-side gate on the trusted-fingerprint carry | The same O(1) predicate against the probe's own identity refs, on repositories whose fingerprint *hit* — the hot path for converged repositories. No spawn, no protocol lock, no artifact scan unless a candidate exists. | Unmeasurable if implemented as specified; a new spawn per converged repository per cycle if not. **This is the line to watch in review** — it replaces v6's much riskier reconciliation above `apply.ts:873`. |
| P1 step L, the locked absence proof | One prepared verify-only ref transaction per witnessed ref — no artifact, no mutation, no state save. Runs only for a ref that already passed the other eight rules. | Tens of ms, once per deletion, not per cycle. |
| P1 step K, the ACK retirement | Additional fields on an authority object the ACK already builds (`push.ts:962-975`) and two extra conditions inside `composeRepoBase`. **No extra state save and no new persisted field.** | Zero. |
| §3.2's witness-backed tombstone | One extra loop over the witnessed refs inside a pure function that already loops over `advertised.refs`. | Zero. |
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
pinned refs), **R5** removed its only recurring transfer cost (P4), and **v7** removes its only
per-deletion write beyond the ACK itself (v6's armed intent). v1's blanket claim that "net cost is
negative" is true for the whole design again, which it was not in v3, v4 or v6.

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
   on the second. v7 leans on it harder than v6 did: it is the provenance P1b binds to now that
   there is no receipt — §3.2.)* **It proves possession, never the cause of a later absence** —
   §3.3b.
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
10. **A published deletion names the exact value it retires.** A wire tombstone authored by this
    device for `refs/heads/*` covers either a value its own last acknowledged section advertised
    (today's rule, `publisher-tombstones.ts:108-122`) or the exact `record.base.refs[ref]` of a
    ref whose deletion witness holds (§3.2). It never covers a value the device merely relayed,
    and an omission that can carry **no** attested deletion is never published — which is why
    §3.3 rule 9 refuses a scoped section and why the ACK refuses a retirement whose accepted
    section lacks the matching tombstone entry. *(New in v6, round-4 blocker 2; re-sourced in v7
    from the witness instead of a receipt, and strengthened by the ACK-side check.)*
11. **No local artifact retires a BASE member ahead of the wire.** A `refs/heads/*` member of BASE
    goes present→absent **only** in the transaction that performs it (design 130's blessed
    apply-side path: a prune this device performed under tombstone authority, a confirmed manual
    resolution, or journal recovery of either) **or** at the publisher ACK of a section that omits
    the ref, backed by a locked expected-absent proof taken in that same push (§3.2). There is no
    third path, and in particular no path in which a durable local record of a deletion outlives an
    unpublished omission. *(New in v7 — this is the invariant whose absence produced A′, A″, the
    `owed` predicate, `record.absenceOmission` and five rounds of findings. §13.6.)*

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
    the three residuals v7 pays instead are §13.4 items 6–8.

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
  transition loop runs, that `heldRefs[R]` persists as the existing `local-commits` value, that the
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
  re-created `R` reaches case (d) — and the human exit: `rbox git resolve <repo> keep-mine` no
  longer refuses at `resolve-command.ts:658-665`, publishes the omission with a tombstone at `X`
  **and never at `Y`**, and retires BASE through the `manual` arm.
- **Case (c) — the converged arm and the lost ACK.** With BASE positive at `X`, `R` absent, and an
  incoming section that **omits** `R`: assert BASE retires under `pull-ref-transaction` authority
  with the A artifact that transaction writes, that this is the same path as today's
  reconstruction (`follow.ts:856-869`) with the witness supplying what a pre-existing artifact used
  to, and that it is idempotent across a repeated cycle. Then the crash variant: accept the
  omission server-side, drop the ACK state CAS, and assert the next pull retires BASE from the head
  that omits `R` — with **no** local record of the attempt (§3.6 row 3).
- **Case (d) — re-created between the locked proof and the ACK.** Take step L's proof, re-create `R`
  at `X'` before the ACK, then let the ACK land. Assert: BASE retires (the tombstone's claim was
  true when taken), nothing is deleted locally, the next follow **holds** `R` rather than deleting
  it (attestation refuses at `X'`), supersession then succeeds because the pending section has no
  `R` entry, and the following capture publishes `R = X'`. Assert the whole sequence loses no
  object and needs no human.
- **The accepted race, pinned as accepted (§13.4 item 8).** Accept the omission, drop the ACK CAS,
  and deliver a peer section that re-creates `R` at exactly `X` at a **higher** sequence before the
  next pull. Assert the current behaviour — the re-published omission tombstones it — and name the
  test for what it is
  (`…_republishes_its_omission_over_a_same_oid_recreation_after_a_lost_ack_cas_v7_accepted_residual`),
  citing §13.4 item 8 and §12 C3, so the day someone adds the pre-POST arm the test changes
  deliberately rather than mysteriously starting to fail.
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

**Two structural rows, both about what the ACK may record.**

1. `composeRepoBase` must refuse an `absentBranchProofs` entry when any of §3.2's six checks fails,
   asserted one row per check: wrong ref class, non-hex `priorOid`, `priorOid ≠ previousRefs[ref]`,
   the candidate still asserting the ref, a `scoped` candidate, and — the row that would otherwise
   be invisible — **an accepted section with no `refTombstones` entry at that OID**. Every refusal
   must leave `after = before` and produce a `mismatched-branch-proof` hold, i.e. a `pending`
   disposition, never a silent retirement.
2. Assert that the outgoing section for a repository with any held ref is either the reused pending
   section (`publisher-tombstones.ts:183-186`) or a wholly local capture — **never a mixture**
   (re-homed from v4's §9.5). That single assertion is what keeps `provePendingSupersession` from
   ever seeing a value this device did not capture, and it is the property design 201 must replace
   with something stronger rather than weaken (§4.4's `gitCommitAncestry(Y, Y)` landmine).

*(v3's table had a "circuit breaker tripped" row and a "no keep-pin created" assertion on every
row; both are gone with R4. v6's table had an "`R` is owed" row; there is no owed state in v7, and
its replacement is the "no artifact and no persisted deletion state exists at any point" assertion
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
  all 24 are captured, one A artifact each, no deferral, no human prompt. This is the direct
  inversion of v3's headline row, and it is deliberately loud: if someone re-introduces a
  threshold, this is the test that fails and forces them to read §3.0a and §12 Q2.
- **Per-ref independence.** In the same repository, make one head fail rule 7 (HEAD symref) and
  assert the other 23 still capture — the nine rules are per-ref and one refusal never
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

- **The `equalOrFastForward(Y, Y)` trap** moves to §9.2's structural rows: the outgoing section for
  a held repository is either the reused pending section (`publisher-tombstones.ts:183-186`) or a
  fully local capture — never a mixture. That is the single assertion whose failure would re-open
  the whole class, and it is the one design 201 has to replace with something stronger.
- **The no-hold regression pair** — assert today's byte-for-byte carry is still taken when a
  repository has any held ref, and that a repository with none captures normally. This is a
  pure regression pin for the behaviour R5 preserves.
- **The switch-disabled fallback** — with `RBOX_GIT_ABSENCE_CAPTURE=0`, a locally-absent
  BASE-positive head must still be **carried**, never omitted from the published section, and its
  BASE member must not retire. *(v7 pairs it with the ungated half: with the switch off the ref is
  still **held** rather than thrown at `branch-transition.ts:105`, because the hold destroys
  nothing and refusing it re-opens today's whole-repository wedge — §11, §9.6.)*

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
  proof at `:155-158` forces both) — `ref-read-unreadable` (§3.3a) and the deletion hold's
  `ref-plane` reason (§3.6, §5). The deletion hold deliberately keeps the **existing**
  persisted `heldRefs` value `local-commits` (`sync-state-model.ts:198`), so no state schema
  changes and an older client reads it with today's meaning; assert both facts.
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
  - **No durable deletion state, ever.** Snapshot `state.json` and every `refs/rbox-*` ref at every
    injectable failure point between the witness and the ACK, and assert that **no snapshot
    contains a record of the deletion** — no A/Z artifact for `R`, no retired BASE member, no
    per-ref deletion field of any kind. This is invariant 11 as an executable assertion, and it is
    the single test that makes the whole class of round-3/4/5 findings unreachable.
  - **BASE and the wire never disagree about `R`.** Across the same injected failures, assert that
    `record.base.refs[R]` is positive exactly while the newest acknowledged section for that
    repository asserts `R`, and absent exactly while it omits `R`.
  - **The retirement is final.** After an acknowledged omission, assert no subsequent cycle
    re-authors a tombstone for `(R, X)` from the witness lane — the witness cannot hold, because
    BASE is absent — and that an incoming section asserting `R = X` at a higher sequence applies as
    an ordinary creation.
  - **Kill-switch off-state.** With `RBOX_GIT_ABSENCE_CAPTURE=0`: assert no witness is computed, no
    locked proof is taken, no tombstone is authored, no BASE member retires, and the pending
    section is carried — **and** that the apply-side hold still fires, so the repository degrades to
    a per-ref hold rather than to the `branch-transition.ts:105` throw and whole-repository defer
    (§11). Assert received tombstones are still attested and pruned normally, since that path never
    reads the flag.
- **What the rig asserts about recovery, after R4.** Device B, having pruned `C` under the
  tombstone, still pins the displaced OIDs — assert `refs/rbox-local/keep/<X>` exists on B with
  a `tombstone`-class origin for the authorized tip and `human` for the rest of `C`'s reflog,
  because that is **existing** design-116 behaviour and this design must not regress it. On
  device A — the one that deleted the branch — assert the opposite: **no** keep-pin and **no**
  artifact is created, and no `refs/rbox-local/keep/*` ref appears as a result of the deletion
  capture (R4, §3.0a; v7 invariant 11). The single-device variant therefore has no Git-side
  recovery at all, which is the accepted semantic and should be asserted as such rather than left
  to inference.
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
  expressible with the early BASE retirement v7 removes.
- **A durable record of an unpublished deletion.** Deliberately out of scope, and this is the
  design's central choice rather than an omission (§8 item 12, invariant 11, §13.6). The
  consequence — an unpublished deletion can be overtaken and lost — is §13.4 item 6, and the
  one-field reversal a founder could order is §12 C3.
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
| `RBOX_GIT_ABSENCE_CAPTURE=0` | on | **Authoring only** — §3.2's witness evaluation on the push side, its locked absence proof, the witness-backed tombstone, and the ACK's `absentBranchProofs`. It does **not** disable the apply-side hold, P1b's structural rule, or anything that consumes a tombstone already on the wire. See below. |
| `RBOX_GIT_CONTENT_EQUIV=0` | on | P3 (falls back to ancestry-only) |
| `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` | on | P2's held-skip eligibility **only** |
| `RBOX_GIT_OWNERSHIP_NO_ESCALATE=0` | on | P2's "no whole-repo defer for a non-HEAD ownership hold" |
| ~~`RBOX_GIT_PENDING_MERGE`~~ | — | **Gone with P4 (R5).** No switch, no bake condition, no staged flip. |

**Two switches for P2, corrected in v3.** v2 listed one switch and described it as disabling
P2. It does not: held-skip eligibility and the no-escalation change are independent code
paths, and a single `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` leaves the deferral-behaviour change
live. A kill switch that does not kill what the rollout section claims is worse than none,
because it is what someone reaches for at 2am.

**`RBOX_GIT_ABSENCE_CAPTURE=0` is a stop-authoring switch, and in v7 that sentence is finally
simple to state (round-4 blocker 4).** v5 had the rule right in prose and wrong in its table; v6
needed an eight-row table naming every read site, because with a durable receipt on disk the switch
could invert a receipt (disable A″ ⇒ `follower-protocol.ts:88`/`:106` drop logical BASE ⇒ the
ordinary `null → X` creation passes `branch-transition.ts:105` ⇒ `:136-152` destroys the receipt) or
wedge a repository permanently (disable A′). **v7 creates no durable state, so there is nothing for
the switch to strand.** Three sites, and only three:

| Site | Reads the flag? |
|---|---|
| §3.2 steps W, L, T, K — the witness, the locked proof, the tombstone, the ACK's `absentBranchProofs` | **Yes — off ⇒ none of them happens.** This is the whole switch. |
| §3.6 step 1 — the apply-side per-ref hold, and §3.6 case (c)'s converged retirement | **No.** Both are non-destructive and neither depends on authoring: the hold prevents a resurrection and a throw, and case (c) retires BASE only from a wire that *already* omits the ref, under design 130's pre-existing `pull-ref-transaction` authority. Gating them would trade a per-ref hold for today's whole-repository wedge and, in case (c), for §2.3's latent wedge. |
| P1b's structural rule (§3.2), design 130's tombstone attestation, §3.3a's strict reader and `gitStatus` | **No.** P1b cannot supersede anything without a witness the switch already suppressed; attestation consumes tombstones *other* devices published and predates this design; the readers are plumbing shared with older paths. |

Consequence, stated as the rollback contract: **flipping the switch off can only stop new
deletions from being published.** A device mid-flight has nothing to finish — its last cycle either
published or did not — and a device with the switch off behaves exactly like a pre-P1 client for
publication purposes, carrying those refs rather than re-creating them, while still holding the ref
per-ref instead of deferring the repository. §9.1 and §9.6 assert both halves.

**No new persisted field, and therefore no downgrade story to write.** v6 added
`record.absenceOmission`; v7 removes it along with the window it served. The only persisted-state
changes are additive **reported reasons** (§9.6) plus the existing `heldRefs` value `local-commits`
reused verbatim for the deletion hold, so an older client reads every record this design writes with
today's meaning. **Client skew** therefore reduces to a single sentence in each direction: an older
client never publishes a deletion (its capture omits what its P lacks, and its own ACK dry-run
refuses the mismatch, so it wedges exactly as today), and it processes a newer client's tombstone
through the unchanged design-130 attestation path. There is no state a newer client can leave behind
that an older one must read defensively — which is the part v6 could only bound, not eliminate.

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
3. **P1 + P1b + §3.2 + §3.2a + §3.3a's `gitStatus` + §3.3b + §3.6.** The authority change and
   everything that makes it safe: the nine-rule witness, the verify-only locked proof, the
   witness-backed exact tombstone, the ACK's `absentBranchProofs` and its six checks, the shared
   artifact-disposition reader, the strict ref read on its new structured runner, the
   restore/unborn-branch rules, and the apply-side hold with case (b)'s `keep-mine` un-refusal and
   case (c)'s converged retirement. These ship **together**, and the reasons are tighter than v6's
   because there are fewer parts:
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
     device never held (round-2 blocker 1).

   Validated on a dev build against the live wedge before any CLI release. **This is the last
   step**: with P4 cut there is no step 4, and everything inside step 3 is one unit.

*(v3's and v4's step 4 was P4 in two sub-steps with a four-part bake condition, an explicit reverse
migration and a `record.advertisedCarried` residual to read defensively on downgrade. **All of it is
removed by R5.** v6's step 3 additionally contained the omission intent, its arm/consume/reconcile
cycle, and A′/A″ — **all removed by v7**, §13.6.)*

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
**No founder question is open.** v6 adds two *designer* choices below (C1, C2) that a founder
ruling could reverse; they are recorded as choices, not as rulings.

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
v7 keeps C1, withdraws C2, and adds C3. All three follow from R4's ruled semantic rather than
contradicting it, and all three are places this design chooses to lose a *deletion* rather than a
*ref*.

| | Choice | Why | What reversing it would cost |
|---|---|---|---|
| **C1** | When another writer's assertion of a ref races this device's unpublished deletion of it, **fail toward never destroying the other writer's ref**: apply the assertion, do not re-publish the omission (§3.6 rows 5–6, case (b)) | Under R4 the durability contract is file history: a lost deletion is one keystroke to repeat and the content survives regardless, while a destroyed ref is unrecoverable on the Git plane. **v7 makes this cheap where v6 made it expensive** — with no durable owed state, "do not re-publish" is the default rather than a decision that needs evidence | Reversing it (re-assert the deletion on doubt) restores round-4's ABA verbatim. There is no third option that is decidable from local state — §3.6, and v6's two rejected alternatives, now recorded in §13.6 |
| **C2** | ~~One new local-only persisted field, `record.absenceOmission`~~ — **WITHDRAWN in v7** | v6 needed it to answer *"is this device still the reason the wire says `X`?"*, a question only the early-BASE-retirement window can pose. v7 does not open that window (invariant 11), so the question does not arise and the field has no reader | Re-adding it means re-adding the window, which is what §8 item 12 rejects on five rounds of evidence. The narrower, additive form is C3 |
| **C3** | **Do not add a pre-POST arm to close the lost-ACK-CAS re-creation race** (§13.4 item 8) | The window is one pull cycle wide and closes itself from the wire; closing it costs one persisted field plus a read that must decide what to do when the attempt's fate is unknown — which is where v6's reconciliation table came from. The conjunction required (a millisecond crash window plus a deliberate same-OID re-creation on a peer inside one cycle) does not justify re-opening that surface | Reversing it is **additive and independently shippable**: one repository-scoped `{ key, sequence }` written in the push's existing `beforeCommitSend` state save (`push.ts:791-816`), read only to **suppress** re-authoring a tombstone when the head has passed that sequence and is not our section. Because it can only suppress this device's own destructive act, it cannot resurrect a ref or invert anything — the failure direction stays "the deletion needs repeating". If a founder wants the window closed, this is the shape, and §9.1's accepted-residual test is the thing that changes |

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

Five rounds, kept so the next reviewer starts from here rather than re-deriving. Every code
claim in all five tables was re-verified against the worktree before being folded in, and
codex's mis-citations are corrected rather than propagated.

**Read §13.6 first.** Round 5 (§13.6) is the current state, and it is not a list of five fixes: its
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
8. **One race survives: a lost ACK CAS plus a same-OID re-creation inside one cycle** (§3.6, rows
   3 + 6). If the process dies between the server accepting the omission and the state CAS that
   records it, **and** a peer prunes the ref, re-creates it at the identical OID and publishes
   before this device's next pull, then this device's re-published omission tombstones a legitimate
   re-creation. The pruning peer still pins the displaced tip (`keep-pins.ts:635-654`) and the
   content is in the file plane. Recorded rather than closed because the reversal — a one-field
   pre-POST arm — re-opens the surface every round 3–5 finding lived on, for a window that is one
   pull cycle wide; §12 C3 states the exact shape a founder would order, and §9.1 pins the current
   behaviour as an accepted residual so the change would be deliberate.
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

*(v4's item 5 here was "P4's recurring-capture cost is unoptimized on purpose" — **gone with R5**,
§6. v6's items 6 and 7 were A″'s bounded delay and the undecidable racing-publication row — **both
gone with v7**: there is no suppression to delay a peer with, and no undecidable row, because the
question that was undecidable is no longer asked. Items 6, 7 and 8 above are what v7 pays instead,
and they are named so a reviewer can tell a residual from a regression.)*

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
**11 are N/A because the window they live in no longer exists**, 13 remain moot under R4 or R5
(unchanged answers, recorded so the sweep is complete), and **10 survive and are carried forward**.
Nothing in the "N/A" column is closed by an argument; it is closed by the absence of a state.

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
| **R3 M5** — P4's reverse migration has no clearing point | none — P4 cut | **MOOT** — and v7 has no persisted field of its own either (§11) | moot |
| **R4 B1** — `advertised` is neither necessary nor sufficient; the same-OID ABA | the omission intent + sequence reconciliation | **N/A.** No predicate asks whether this device is the reason the wire says `X`. The ABA's precondition — re-publishing an omission after its own retirement — cannot occur (§3.6 row 5). The residual race that remains is one cycle wide and named (§13.4 item 8) | N/A |
| **R4 B2** — a pulled-but-never-advertised `X` produces no deletion tombstone | receipt-backed exact-value authorship (CLOSED in R5) | **CARRIED — and it is now the centrepiece**, re-sourced from the witness plus an ACK-side check that the accepted section carries the entry (§3.2, invariant 10) | carried |
| **R4 B3** — A′ has neither the claimed lock nor Z revalidation | two lock paths + a Z arm | **N/A.** The only lock v7 takes is a prepared ref transaction whose refusal drops the ref (§3.2 step L); no BASE proof enters the state-CAS bracket | N/A |
| **R4 B4** — the kill switch disables the recovery existing receipts require | stop-authoring-only, eight read sites | **CARRIED**, and reduced to three sites, because there is no durable state to strand (§11) | carried |
| **R4 B5** — §9.6 retains a P4-only per-ref pending assertion | deleted the clause | **CARRIED** unchanged — and v7 *depends* on that relaxation, since its own hold carries a whole pending section for one cycle (§9.6) | carried |
| **R4 M1** — the push-side receipt projection has no producer | `readCurrentLineageAbsenceReceipts` | **CARRIED**, narrowed to `readCurrentLineageBranchArtifacts`: rule 3 needs dispositions, not `priorOid`s (§3.2a) | carried |
| **R4 M2** — design 201's deletion gate does not match design 200 | fixed in 201 | **CARRIED** unchanged, plus 201's landmine list updated for the re-frame | carried |
| **R4 m1** — the A→Z rationale contradicts corrected settlement | stated the real reasons | **N/A.** No A→Z rationale remains on the capture side | N/A |
| **R4 m2** — three `gitStatus` completeness nits | fixed | **CARRIED** unchanged — §3.3a, §9.6 | carried |
| **R4 m3** — 201's held-ref AC permits publishing a divergent held value | fixed in 201 | **CARRIED** unchanged | carried |
| **R5 B1** — an armed omission needs reconcile-before-apply | *(would have needed a distinct reconciler with a repo-generation CAS before `applyPulledManifest`)* | **N/A.** Nothing is armed; there is no reconciler, no ordering constraint, and no pull-vs-push entry-point question | N/A |
| **R5 B2** — first-seen incoming `Y` bypasses P1b and is overwritten | *(would have needed whole-section retention on every early return)* | **N/A.** There is no early return: the hold goes through the ordinary path, which already stores the whole section (`apply.ts:1426`, `:1448`). The `Y` case is then P1b's carry row and §3.6 case (b) | N/A |
| **R5 B3** — a blocked A′ lock still lets the BASE CAS run | *(would have needed the bracket to refuse on any blocked lock)* | **N/A.** No `local-absence` proof or repo proof reaches that bracket; a refused ref transaction fails closed in the planner (§3.2 step L, §9.2) | N/A |
| **R5 M1** — no `absenceOmission` state-source lane | *(would have needed a per-ref transition lane with CAS-recompute merge semantics)* | **N/A.** No persisted field. The ACK's proof map is an in-memory field on the authority object `push.ts:962-975` already builds, so a repo-generation retry recomposes from the same immutable inputs — the property M1 asked for, obtained by not persisting anything | N/A |

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
- **No durable deletion state exists.** §9.6's snapshot test is the executable form of invariant 11.
  If any code path v7 specifies writes an A/Z artifact, a retired BASE member or a per-ref field
  before the ACK, the window is back and so is every round 3–5 finding.

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
