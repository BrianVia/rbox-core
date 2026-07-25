# 200 — Worktree lifecycle resilience: capturing out-of-band branch deletion

Status: DESIGN v4 — 2026-07-24. Codex round 2 (`REVIEW-200-R2-CODEX.md`, kept beside this
file) closed 8 of round 1's 11 findings and returned **NOT-ALIGNED** on 3 of them plus
4 new blockers and 5 new majors (§13.2). Folded in alongside a **founder product ruling of
the same date (R4, §3.0a) that removes an entire protection layer from scope.**
Author: Claude, from first-hand field forensics on the founder's Mac, 2026-07-24.

Changes in v4 — the seven that change what gets built:

1. **RULED (R4): rbox promises *file* history, not Git history** (§3.0a, §12 Q2/Q2b/Q3). The
   durability contract is the file plane — trash plus server-side version history, 30/90/365
   days by plan (`apps/api/src/plans.ts:24-27`). The Git lane is convergence assistance and is **best-effort on history**.
   Three things leave the design as a direct consequence:
   - **the mass-absence circuit breaker and all of its threshold arithmetic** (v3 §3.5 —
     `K`, `F`, the `OR` form, the `N ≥ 20` guard, and the total-absence leg an earlier draft
     of this revision proposed). *"Some math is just not gonna prevent it; there's always a
     gap."*
   - **the deleting device's 90-day keep-pin** (v3 §3.7, ruling R3) and with it the
     `KeepPinOrigin` schema extension, the `expireTombstoneKeepPins` caller, and the pin's
     crash-ordering apparatus;
   - **`rbox git deleted`** (v3 §7.2), the recovery listing that existed to make the pin
     reachable.

   What replaces them is not a smaller mitigation but a **stated product semantic and an
   honestly-bounded residual** (§3.0a). Where v3 argued that publishing a deletion is safe
   *because the tip stays pinned*, v4 argues that it is acceptable *because file history is
   the promise and Git history is not* — a different argument, made explicitly rather than
   inherited.
2. **P1b's absence receipt is bound to the exact pending predecessor** (§3.2). An A receipt
   for `X` could supersede an unrelated writer's pending `Y`, destroying a value this device
   never held. Supersession now requires `receipt.priorOid === pending.refs[R]`; a mismatch
   carries. The codebase already uses this exact binding for crash reconstruction
   (`follow.ts:857`), so it is a transposition, not an invention.
3. **Crash recovery for an existing A artifact runs above the unchanged shortcut** (§3.6a
   step A′). A crash between the A transaction and the BASE CAS left the repository
   permanently wedged: §3.3 rule 3 excludes an existing A from *new* capture, the recovery
   inside the follow requires the incoming section to omit `R`, and the unchanged shortcut
   returns before the follow runs at all. A′ completes the retirement idempotently from the
   durable artifact.
4. **P4's partial settlement is redesigned, and the hybrid BASE is gone** (§4.4, §4.4a).
   Carrying a ref is now *structurally* incompatible with settling the pending section, so a
   repository that emits a merged section keeps its previous BASE entry wholesale — today's
   unsettled outcome. That removes the hybrid-BASE algebra, the bundle-coverage mismatch, and
   the lost-CAS overwrite hazard in one move, and it retires §4.4 constraint 6's authority
   widening.
5. **The merged section is refs-only; every other facet is carried verbatim** (§4.4). v3
   never said what happens to `head`, the index, op-state or config. Publishing this device's
   own would revert another writer's unapplied semantic state on the wire — the same class of
   defect as unproved ref supersession. Named, closed, and priced.
6. **The strict ref read gets a real API** (§3.3a): a structured `gitStatus` result carrying
   exit code, stdout and stderr across *both* of `gitRaw`'s execution paths. v3's cited
   precedent (`readLocalGitConfigEntries`) checks only the exit code, and the spawn path
   folds stderr into `Error.message`, so the load-bearing empty-stderr distinction was not
   implementable as written.
7. **§3.3b's restore detection changes character, and the doc says so** (§3.3b (iii)). With no
   breaker behind it, the packed-refs and reflog-store signals are *detection-correctness
   hardening*, not a guarantee. The in-place-restore hole is **accepted with a bounded
   consequence**, not closed.

Changes in v3 — the eight that changed what gets built:

1. **The mass-deletion breaker was arithmetically broken and is now `OR`** (R1, §3.5).
   `max(25, ceil(0.25·N))` is a *conjunction*, so it cannot trip at all below 25 heads and
   its fraction leg is inert below 100 — which covers nearly every repository in the
   workspace. Deleting all 24 heads of a 24-head repository did not trip it. The
   counterexample is recorded so nobody re-derives the broken form. The residual small-repo
   hair-trigger was subsequently **RULED (§12 Q2b)**: fraction leg gated
   on `N ≥ 20`, absolute floor 25.
2. **The deleting device now keeps its own 90-day recovery pin** (R3, §3.7). This reverses
   §8 item 10 and retires Q3a. The old premise — that a *follower's* prune pin is the
   recovery path — is false whenever no device prunes; the analysis is kept as the
   rationale.
3. **A strict ref read replaces the lossy one on every absence-authority path** (§3.3a).
   `readAllRefs` maps any `show-ref` failure to an empty map; verified empirically, one
   malformed loose ref does exactly that while every preflight still passes.
4. **The publisher ACK becomes held-ref-aware** (§4.4 constraint 6). Without it P4 mints
   physical-presence provenance for values this device never held, and P1 then reads that
   provenance as licence to publish a deletion.
5. **P1's control flow is specified end to end** (§3.6a) — absence reconciliation runs
   *before* apply's unchanged shortcut, and the deleting cycle's own push lane publishes
   the omission, so the retired ref cannot be re-created from the section still in hand.
6. **P3 is demoted to cascade reduction and structurally barred from destructive
   transitions** (§4.3). It has a real false positive (apply-then-revert) and its
   "waives holds only" boundary was a description, not a mechanism.
7. **P4's accepted-ACK state machine gets its third outcome** (§4.4a, `partially-superseded`),
   and the `gitIncomingKey` question is *decided*: the carried pending section is never
   rewritten, so nothing keyed on it moves.
8. **The deletion semantic is honestly scoped to v1.6.8 and newer** (R2, §3.0) — verified
   against the tag, not assumed — and a recovery command is specified (§7.2), because no
   existing surface exposes an OID.
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
(§4.3). **Corrected in v3: none of these ungags the capture lane** (§4.2). Only P4 does.

Finally — ruled in on 2026-07-24, and the largest single change here — the outgoing
section becomes **`pending ⊕ local`** (§4.4): a held ref carries its pending value while
every other ref publishes its local value, instead of today's all-or-nothing swap. That
is the structural fix that prevents the whole class rather than clearing one instance of
it, and it is why §11's landing order is inverted from v1's.

Cost is negative for P1–P3 in wall clock: the new checks are O(1) per BASE head in the
negative case and are gated behind proofs that already failed, while making ownership holds
held-skip eligible removes a full follow per cycle from exactly the repositories that
suffer today. **P1's standing cost is now zero** — v3 carried R3's ~900 hidden recovery refs
and their effect on `git gc`; R4 removes the pin, so the only per-deletion work is one ref
transaction and one state CAS.
**P4 is not free** — it replaces a byte-for-byte pending carry that uploads nothing with
an ordinary incremental capture per cycle while a hold is outstanding. That is the point
(local work keeps flowing past a held ref) but it is a real new cost and a real new blast
radius; §6 and §11 say so plainly.

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
value the pending section claims. `priorOid` is already on the artifact payload and already
projected: `prepareFollowerBranchProtocol` exposes it as
`absenceWitnesses[R].priorOid` (`follower-protocol.ts:83-114`, populated from
`payload.priorOid`), and `follow.ts:857` **already gates its crash reconstruction on exactly
this equality** (`reconstructedAbsence?.priorOid === baseOid`). So this is a transposition of
an existing in-tree pattern onto a second consumer, not a new proof obligation. Settled-absence
entries carry the same `BaseAbsentPayload` shape (`lookupSettledAbsence`,
`base-artifacts.ts:442-447`), so the same field is available for that arm.

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
   `130:214-234`). This is the load-bearing one — see §3.4. Under P4 it additionally
   requires that the origin was minted from a value this device *captured*, not one it
   *carried*; under P4 that is guaranteed structurally — a repository that carries any ref
   never settles, so no origin is minted for it at all (§4.4a).
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
`readLocalGitConfigEntries` (`shared.ts:261-268`). That claim is wrong in the load-bearing
half: `readLocalGitConfigEntries` inspects only `(error as {code?}).code === 1` and never
looks at stderr, so it is a precedent for the *exit-code* discipline and for nothing else.
And `gitRaw` has **two execution paths with different failure shapes**:

| Path | Taken when | Failure shape |
|---|---|---|
| Node `spawn` (`shared.ts:145-227`) | `opts.stdin` or `opts.onStdoutChunk` is set | `reject(Object.assign(new Error(stderr ⏐⏐ \`git exited with status N\`), { code: exitCode }))` (`shared.ts:177`) — stderr is **folded into the message**, and an empty stderr is replaced by fallback text |
| `promisify(execFile)` (`shared.ts:229-237`, `exec` bound at `:71`) | otherwise — including every `show-ref` read | Node's `execFile` rejection, which *does* carry `.stdout`/`.stderr`/`.code`, but whose `.code` is a **string** for spawn faults (`"ENOENT"`) and `undefined` when the child was signalled |

So "check `code === 1` and empty stderr" is implementable on one path by message
archaeology and on the other by a Node-specific property, and neither is a contract. Add the
contract instead:

```ts
export type GitRunResult =
  | { status: "ok"; stdout: string }
  | { status: "failed"; code: number | null; stdout: string; stderr: string };

/** Non-zero exits are DATA. Spawn/IO faults still reject. `code` is the numeric
 *  exit status, or null when the child was signalled or never ran. */
export async function gitStatus(root: string, args: string[], opts?: GitRunOptions): Promise<GitRunResult>;
```

- **The spawn path already buffers stdout and stderr separately** (`shared.ts:179-215`), so
  it resolves the structured failure directly rather than composing a message. That is a
  strict simplification of `finish()`.
- **The `exec` path** reads `.stdout`/`.stderr`/`.code` off the rejection and normalizes:
  `typeof code === "number" && Number.isInteger(code) ? code : null`. A `maxBuffer` overflow,
  an `ENOENT`, or a signal therefore all yield `code: null` — which the strict reader treats
  as unreadable, i.e. fail-closed by construction rather than by a rule someone must remember.
- **`gitRaw` keeps its exact current throwing contract** by wrapping `gitStatus` and
  re-throwing `Object.assign(new Error(stderr || fallback), { code })`. Nothing else in the
  tree changes, and no existing catch site sees a different error shape. This is the smallest
  refactor that makes the distinction a contract rather than a coincidence.
- **`readLocalGitConfigEntries` moves onto `gitStatus`** in the same change, because it is
  the one existing consumer of the same distinction and leaving it on message/`code`
  archaeology would leave two idioms for one rule.

Exact semantics of the reader, stated once so the implementation has no latitude:

```
r = await gitStatus(repoDir, ["show-ref"])
r.status === "ok"                                   → { ok, refs: parse(r.stdout) }
r.code === 1 && r.stderr.trim() === ""              → { ok, refs: {} }
otherwise                                           → { unreadable, marker: `exit-${r.code ?? "nonnumeric"}` }
```

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

**Two things v2 asserted here that are not true, and are now handled elsewhere.**

- **The invariant proves historical possession, not the cause of the current absence.**
  "Held it, doesn't now" is compatible with deletion *and* with a restored ref database
  (§3.3b) *and* with an unborn-branch HEAD (§3.3b (i)). §3.3's rules 7 and 8 narrow it
  further; nothing narrows it completely, and §3.0a is where that residual is accounted for.
  This section no longer claims to.
- **The invariant is not self-maintaining under P4.** `publisher-ack` mints an origin
  whenever the acked value equals the *advertised* value (`base-composer.ts:356-367`), and
  the advertised set today is the whole committed section (`push.ts:971`,
  `advertisedRefs: section.refs`). A merged `pending ⊕ local` section contains held refs at
  values this device never held. v3 protected the invariant by widening the ACK authority
  (constraint 6); **v4 protects it structurally instead** — a repository that carries any ref
  is never in `settledPending`, so its ACK never advances BASE and never mints an origin for
  *any* ref, let alone a carried one (§4.4a). Same guarantee, no new authority member.

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

v2 and v3 specified a repository-level mass-absence breaker: per cycle, if the number of heads
about to be absence-captured reached an absolute floor **or** a share of the repository's
positive BASE heads, capture none and defer for a human. R1 fixed its arithmetic; Q2b then
gated the fraction leg on `N >= 20`.

**All of it is out of scope as of R4 (§3.0a): there are no thresholds** — *"some math is just
not gonna prevent it; there's always a gap."* The absence-capture predicate now contains **no
repository-level count anywhere**: §3.3's eight rules are all per-ref evidence, and a capture
that satisfies all of them and is still wrong is accounted for in §3.0a rather than mitigated.

Three things kept so nobody re-derives them:

- **The arithmetic.** `n >= max(K, ceil(F*N))` is a *conjunction* dominated by its larger leg,
  so with `K = 25`, `F = 0.25` the absolute leg dominates every repository under 100 heads —
  a 24-head repository losing all 24 did not trip. A two-legged ref-count guard wants `OR`, and
  must not copy design 108's `AND` (`pushMassDeleteTrips`, `policy.ts:22-35`) without
  re-checking scale: 108's conjunction is defensible at `min = 1000` against file counts in the
  hundred-thousands and inverts at ref counts in the ones to hundreds.
- **The distribution that killed the fraction leg.** 110 repositories, ~203 BASE heads,
  **median 1**, 84% at four or fewer. Any fraction of `N` is a hair-trigger there.
- **The file plane keeps its guards, and that is not a contradiction.** Design 44's pull-side
  guard (`policy.ts:11-15`, `pull.ts:276`) and design 108's push-side breaker
  (`policy.ts:22-35`, `push.ts:701`) are unchanged: they guard the plane rbox *promises*, at a
  scale where a fraction leg means something. R4 is exactly the ruling that the Git lane is not
  that plane. The **posture** 108 taught survives without a breaker: refuse on the publishing
  side, before any encrypt/upload/commit work, and fail closed — which is what every §3.3 rule
  does.

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
the capture lane.** The bridge from mode (a) to mode (b) described in §1.5 — a hold gagging
capture while the user keeps deleting merged branches — is closed by **P4 alone**. That is a
materially stronger argument for P4 being in scope than v2 made, and §4.5, §5 and §11 are
corrected to match.

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

### 4.4 The per-ref pending lane: `pending ⊕ local` (P4)

**RULED IN SCOPE 2026-07-24.** v1 proposed this as a follow-up (§12 Q5); the founder
overruled that. It is the structural fix that prevents the whole class instead of clearing
one instance of it, and it is now part of the design.

**Proposal P4.** While a repository has any held ref, the outgoing section stops being the
carried incoming section and becomes a **merge**: the carried `pending` value verbatim for
each held ref, the live local value for every ref rbox may publish. Today
`apply.ts:1447-1450` sets `pending[rel] = remoteSec` for the whole repository and
`normalizeOutgoingGitSections` republishes it by identity
(`publisher-tombstones.ts:183-186`: when `gitIncomingKey(pendingSection) ===
gitIncomingKey(section)` the pending section is reused unparsed and unnormalized). One
held ref therefore freezes every other ref's published value for as long as the hold
lasts. P2 stops that from *deferring* the repository and stops it *gagging capture*; only
P4 stops it from **freezing the outgoing section**.

#### 4.4.0 The merged section, defined exactly — rewritten in v4

v3 said "the carried pending value for each held ref, the live local value for every ref
rbox may publish" and left three things unstated that turn out to decide the whole design:
which refs may take a local value, what happens to every *non-ref* facet of the section, and
where the objects come from. All three are specified here, and the resulting shape is
materially simpler than v3's.

**(a) The partition is over `pending.refs`, and it has four classes, not two.** For each ref
in the pending section:

| Class | Test | Published value |
|---|---|---|
| **proved** | present locally and `equalOrFastForward(pending[R], live[R])` for heads (`pending-supersession.ts:179-181`); exact equality for `refs/tags/*` and `refs/stash` (`:203-204`) | the **local** value |
| **receipted-absent** | absent locally, and a current-lineage A / settled-absence receipt exists with `priorOid === pending.refs[R]` (§3.2 P1b) | **omitted** |
| **carried** | held — `heldRefs[R]` is set for any reason | the **pending** value, verbatim (or omitted, if the pending section omits it: see (b)) |
| **unproved** | anything else | *nothing.* **The merged emit is refused for this repository** and the whole-section carry runs, exactly as today |

The fourth class is new in v4 and it is not a formality. v3's partition was "held vs not
held", which silently assumed every non-held pending ref is safe to publish at its local
value. It is not: a ref whose transition **threw** inside the publish loop
(`follow.ts:1021-1027` catches, records `checkoutRefDetail`, and defers the repository) is
neither applied nor held, so its live value is unrelated to the pending value and publishing
it would revert another writer's work with no proof at all. Refusing the merged emit for the
whole repository is the only fail-closed answer, and it reuses the existing per-ref tests
rather than inventing new ones — P4 becomes a *per-ref application* of
`provePendingSupersession`'s existing predicates instead of a new proof system.

**Local refs absent from the pending section** are published at their local values with no
extra test: there is nothing to revert. Omitting one that BASE holds positive still needs
P1b's receipt (constraint 4).

**(b) Carried absence has a representation — the M2 fix.** A held ref whose pending value is
*absence* (the other writer deleted it and shipped a tombstone; this device holds local work
and the attestation refuses the prune) is carried but appears in no refs map. v3's
`carriedRefs: Record<string,string>` plus "the union equals `Object.keys(section.refs)`"
cannot express it.

The representation is a **sorted list of ref names**, not a map:

```ts
/** Refs in the emitted section whose value this device carried rather than captured.
 *  A name present here with no entry in `section.refs` is a CARRIED ABSENCE. */
carriedRefs: readonly string[];
```

The value is already unambiguous from the section itself — present at that OID, or absent —
so a map adds nothing and cannot encode the absent case. The well-formedness predicate
becomes total:

```
capturedRefs        = Object.keys(section.refs) \ carriedRefs
carriedRefs ∩ capturedRefs = ∅                                   (by construction)
∀ h ∈ carriedRefs :  section.refs[h] === pending.refs[h]         (both may be undefined)
∀ h ∈ carriedRefs :  h ∈ Object.keys(pending.refs) ∪ Object.keys(base.refs)
```

**This is local-only state and never goes on the wire — verified, not assumed.** A wire
sentinel was considered and is impossible: `validateGitSection` requires every value of
`refs` to be 40-hex (`manifest-validate.ts:387-390`) and rejects the whole section — and
therefore the whole manifest — otherwise, so any sentinel would make every older client drop
the repository. `carriedRefs` is persisted in the repo record beside `advertised`
(`record.advertisedCarried`), which is exactly where its one consumer needs it (constraint 3).

**(c) Only `refs/heads/*` may be carried.** If any held ref is a tag or `refs/stash`, the
merged emit is refused and the whole-section carry runs. `heldRefs` genuinely can contain
them — `local-stash` is a hold class (`follow.ts:841`) and a receiver-equivalent collision
group can force a tag (`:721`) — and safe refs have exact-equality semantics with no
provenance model (`base-composer.ts:464-513` has no carried case and would emit
`mismatched-safe-ref-proof`). Inventing safe-ref carry semantics is out of scope; refusing is
one predicate and loses nothing this design was trying to win.

**(d) Every non-ref facet is carried verbatim from the pending section. New in v4, and it
closes a hole nobody had named.** v3 never said what the merged section's `head`, index,
op-state or config are. If they were this device's own, the merged emit would **publish this
device's head and index over another writer's unapplied ones** — the same class of defect as
publishing an unproved ref value, and the reason `provePendingSupersession` checks
`pending.head === candidate.head`, exact op-state equality and index cleanliness
(`pending-supersession.ts:194-196`, `:214`) before it will supersede anything.

So the merged section `M` is defined as **the pending section with two things changed**:

| Facet | Value in `M` |
|---|---|
| `refs` | the merge from (a) |
| `bundleSha`/`bundleEncSha`/`bundleCipherSize`/`packChain` | this device's new capture, per (e) |
| `head`, `indexSha`/`indexEncSha`/`indexCipherSize`/`indexTree`, `opState`, `config`, `refScope` | **the pending section's, verbatim** |
| `refTombstones`, `refTombstoneGeneration` | the pending section's as the **pre-normalization seed**, then `normalizePublishedGitSection` folds and authors over it as it does for any candidate — authoring **only** for captured refs, per constraint 3's two-sided bar |

`M` is a valid section by construction: a symbolic `head` names a branch the pending section
carried, and every class in (a) keeps that branch present in `M.refs` (a receipted-absent or
carried-absent HEAD branch cannot occur — a ref that is the current HEAD symref target is
refused by §3.3 rule 7, and a *pending* head naming a ref the pending section omits would
already have failed `validateGitSection` on arrival).

**The named limitation this creates, stated rather than discovered later:** while a hold is
outstanding, this device's local **head, index, op-state and config changes do not publish**.
Only refs flow. That is a narrowing of what "local work keeps flowing" means, and it is the
right narrowing: the founder's case is an agent worktree holding branch `B` while unrelated
commits land on branch `D`, and `D`'s commits are refs. A device that also wants its staging
area published has to wait for the hold to clear — which is what happens today for
*everything*, so this is strictly better and never worse. Recorded in §10 as a scoped
non-goal.

**(e) Object coverage comes from chaining the pending section's bundle, not from pinning.**
This replaces v3 constraint 1, which was unimplementable in the case that matters.

v3 said the held pending tips "must be durably pinned into the capture's scratch-pin set
(`createScratchPins`, `capture.ts:282`) at capture time". That assumes this device *has* those
objects. It may not: the incoming objects are imported into `refs/rbox-incoming/<ts>-<rand>`
(`apply.ts:343`) and `cleanupIncoming` tears that namespace down after publish or defer
(`apply.ts:335-339`), leaving them unreachable and `gc`-eligible. `git update-ref` cannot pin an
object Git no longer has, so the plan fails exactly when the hold has lasted long enough to
matter — and a section advertising a tip absent from its chain is not a deferral, it is a
section every follower fails to import.

The chain is the answer, and it needs no local objects at all:

```
M.packChain = [...(pending.packChain ?? []), gitSectionNewestLink(pending)]
M.bundle    = this device's incremental bundle
```

- The pending section's own bundle covers all of the pending section's tips — it was a valid
  section — so every carried value, the carried `head` OID and the carried `indexTree` are
  covered by the chain, with no local possession required. Its blobs stay server-side for as
  long as something references them, and `M` is what references them.
- **The basis for `M`'s own bundle** is `gitSectionTips(pending) ∪ gitSectionTips(base)`
  **filtered to objects that exist locally** (`cat-file -e`), because `git bundle create
  ... ^tip` fails outright on a tip the repository lacks. `capturePlannedGitSection` already
  degrades to a full bundle on that failure (`onBasisFallback`, `shared.ts:236-241`), so an
  unfiltered basis would silently pay a full repack every cycle; filtering keeps the
  increment incremental.
- **Chain bound.** `MAX_PACK_CHAIN` is 8 (`manifest-validate.ts:19`, enforced at `:352`).
  If `pending.packChain.length + 2 > MAX_PACK_CHAIN`, the merged emit is **refused** and the
  whole-section carry runs. A full bundle is not an escape here: this device cannot bundle
  objects it does not have, so recompaction is unavailable for a section with carried tips.
  One predicate, fail-closed, and it degrades to today's behaviour.

**Why it is not just a map merge.** With (a)–(e) fixed, three of v3's six entanglements
survive as stated, one is replaced, one dissolves, and one is retired:

1. ~~**Bundle coverage via scratch pins.**~~ **Replaced by (e)** — the mechanism was wrong for
   the case it existed to serve.
2. **`gitIncomingKey` stability — DECIDED in v3, amended in v4.**
   `130:119-123` is explicit that the carry passes byte-for-byte *precisely* so the key
   does not move, "because normalizing it would change `gitIncomingKey` and orphan partial
   progress and deferral episodes bound to that key". A merged section has a different key
   by construction — `refs`, `bundleSha` and `packChain` all participate
   (`shared.ts:85-103`). v2 said "whichever key story the implementation chooses", which is
   not implementable.

   **The decision: the push lane never rewrites `pending[rel]`.** It keeps the remote's
   unapplied section verbatim, exactly as today; the merge produces a *separate outgoing*
   section. Every consumer keyed on the incoming key is an **apply-lane** record keyed on the
   *pending/incoming* section, never on the outgoing one:

   | Consumer | Key source | Effect of P4 |
   |---|---|---|
   | `GitHeldAttempt.incomingKey` (`sync-state-model.ts:228-245`) | incoming section, set in the apply lane | none |
   | `partial[rel]` | apply lane | none |
   | `setDeferral(rel, "apply", …, incomingKey, …)` (`apply.ts:1447-1450`) | incoming section | none |
   | tombstone attestation binding (`follow.ts:779-782`, `:994-998`) | `gitIncomingKey(opts.incoming)` | none |

   **v4 amendment — the *apply* lane does move the key on the next pull, and v3's flat claim
   that "nothing keyed on it moves" was wrong.** Once `M` is published this device is the
   repository's newest publisher, so the next pull's `remoteSec` **is** `M`, and every deferral
   path writes `pending[rel] = remoteSec` unconditionally (`apply.ts:1426`, `:1448`, and nine
   other sites). The verbatim pending section is replaced by this device's own merged section one
   cycle after the first merged emit — on the happy path, not only after a crash. That is
   **safe, and it is (d) that makes it safe**: `M ⊒ pending` on every facet the apply lane still
   has to do, so the cost is purely performance — the held-skip bracket misses once and one
   `partial` record is discarded, costing one full follow, and the work that record described is
   re-derived from the section in hand. **The honest version of the claim: the outgoing key is
   never bound to anything, and the incoming key moves exactly once per merged emit, to a section
   that dominates the one it replaces.**

   **Enforced, not assumed:** a structural test asserting that no outgoing merged section's
   `gitIncomingKey` is ever written into `deferrals`, `attempt` or `partial`, plus the §9.5
   assertion that after the self-echo the apply lane still holds the same ref set.
3. **Tombstone authorship on held refs — widened in v4.** The carry is *exempt* from
   `normalizePublishedGitSection`; a merged section is not, so it runs the supersession
   authoring loop at `publisher-tombstones.ts:108-122`, which iterates `advertised.refs` and
   mints a tombstone for every head whose candidate value differs. Two distinct hazards, and
   v3 named only the first:
   - **The candidate side.** For a carried ref, the merged value is another writer's pending
     value, not something this device superseded. Authoring a tombstone there claims a
     supersession this device never performed and advances the repository high-water mark on
     someone else's behalf — 174-I3's hazard.
   - **The advertised side — new in v4.** `advertised[rel]` is set to the whole committed
     section on every accepted push (`push.ts:962`), and today, for a held repository, that
     committed section *is* the carried pending section. So `advertised.refs[R]` can already
     hold a value this device never captured, and the authoring loop reads it as this device's
     own prior claim. Concretely: this device advertised `R = L` (captured), then carries
     `R = Y` in a later merged section; the loop sees `advertised.refs[R] = L ≠ Y` and mints a
     tombstone retiring `L` — a value this device still holds locally and never superseded.

   **The rule: authorship is barred for any ref that is carried in the candidate *or* whose
   advertised value was itself carried.** The second half is what `record.advertisedCarried`
   (from (b)) exists for, and it is why the partition is persisted rather than recomputed.
   Structural, not "expected not to differ".
4. **Per-ref omission needs the per-ref receipt.** A merged section publishes local values
   ref by ref, so a ref that is locally absent is *omitted* ref by ref. Omission alone has
   never been deletion authority (§8 item 3), and at per-ref granularity the failure is
   worse than the whole-section version 174 R1 caught, because it no longer looks like a
   section swap anyone would inspect. P1b's receipt rule — **including v4's `priorOid`
   binding** (§3.2) — is what makes a per-ref omission legitimate. This is an ordering
   constraint, not a caveat.
5. **ACK convergence — dissolved in v4, and this is the keystone.**
   `pendingSupersessionAckConverges` (`pending-supersession.ts:35-62`) requires the composed
   BASE to deep-equal the candidate. v3 tried to make BASE composition *accept* the merged shape,
   which is what produced the hybrid BASE and every problem that came with it. v4 does the
   opposite — it makes carrying and settling **mutually exclusive**, so the dry-run is never
   asked about a merged section at all (§4.4a).
6. ~~**Held-ref-aware ACK authority.**~~ **RETIRED in v4 — no longer needed.** v3 widened
   `ComposeRepoBaseAuthority`'s `publisher-ack` member with a `carriedRefs` map plus a
   disjointness rule so a carried value could reach a settled ACK without acquiring an origin.
   Under §4.4a a carried value **never reaches a settled ACK** at all, so the guarantee falls out
   of the settlement rule and `ComposeRepoBaseAuthority` stays exactly as design 130 closed it —
   which matters, because `130:286-323` and `base-composer-structure.test.ts` make every member
   of that union a permanent commitment. The property both versions deliver, unchanged: **a ref
   this device has only ever carried never acquires a usable origin, so it can never satisfy
   §3.3 rule 1, so P1 can never publish a deletion for it.**


**Ordering constraints.** §3.6 establishes one: P1b's receipt must be committed *before*
capture, or the ACK dry-run refuses the omitting candidate.

- **P1 + P1b must land before P4 — real.** Constraint 4: without the receipt rule, the per-ref
  lane manufactures exactly the deletion-by-omission that §8 item 3 rejects, at a granularity
  that makes it harder to see. *(v3 claimed a converse edge — "without the held-ref-aware ACK,
  P4 forges the provenance P1 trusts". v4 retires it with constraint 6: a carried value can no
  longer reach a settled ACK at all, so there is nothing to forge and the edge is gone. The
  forward dependency stands on its own.)*
- **~~P2 must land before P4.~~ Not a real dependency — corrected in v3.** `publishRefPlane`
  already returns a per-ref held set today: `heldRefs` is built per ref and returned both as
  a set (`follow.ts:1041`) and as a map (`follow.ts:1047`). `apply.ts:1447` consumes only
  its cardinality (`held.length > 0`), but the per-ref information is already there for P4
  to merge over. P2 is a performance and deferral-reporting change; it is neither a
  prerequisite for P4 nor for P1. It is still landed first in §11, for validation-sequencing
  reasons, but §11 no longer claims it is required.
- **P3 is independent, and lands early for exposure reasons only.** Content equivalence only
  turns `would-drop` into `proven` inside `noDropProof`; it changes which refs are held,
  never how the section is composed. Landing it first *shrinks* the held set on the
  founder's machine (four of ten worktree branches, §1.1), which makes P4's first real
  exposure smaller. That is a validation argument, not a correctness one.

### 4.4a P4's accepted-ACK settlement — REDESIGNED in v4

v2 left this undecided. v3 answered it with a third outcome, `partially-superseded`, whose
BASE was a **hybrid**: captured refs advanced to the committed values, carried refs kept their
previous BASE values, and every non-ref field kept its previous BASE value. Codex found three
independent failures in that shape, and working through them produced a simpler answer that
removes the hybrid entirely.

**Today there are exactly two outcomes**, and both are whole-section:

- **settled** — the repo is in `supersededPending ∪ resolvedPending`, so `push.ts:926-945`
  removes it from `pendingAfterAck` and `gitBaseAfterCommit` (`plan.ts:1155-1167`) lets
  BASE advance to the whole committed section;
- **unsettled** — the repo stays in `pendingAfterAck`, and `gitBaseAfterCommit` restores the
  **old** BASE section wholesale ("the saved git BASE must keep the OLD entry (or none) so
  the next pull still sees remote != base and retries the apply", `plan.ts:1150-1154`).

**Why the hybrid had to go.** All three of codex's failures are real, and the third one is not
repairable inside the hybrid model:

1. **The acceptance check contradicts the settlement.** `pendingSupersessionAckConverges`
   requires `isDeepStrictEqual(composed.base, candidate)` (`pending-supersession.ts:61`). Under
   the hybrid, `composed.base` holds carried refs at their *prior* values while `candidate`
   holds them at their *pending* values, so the dry-run fails for every merged section that
   carries anything — i.e. for every merged section there is.
2. **The hybrid BASE has no bundle that covers it.** `incrementalCapturePlan` derives the next
   capture's negative basis from **`gitSectionTips(baseSec)`** and its chain from
   **`baseSec.packChain` + `gitSectionNewestLink(baseSec)`** (`shared.ts:135-141`), and
   `captureGitState` passes those tips as `^tip` exclusions (`capture.ts:296-298`). A BASE whose
   *refs* advanced to newly-captured values while its *bundle and chain* stayed at the previous
   BASE therefore excludes objects the advertised chain does not contain — the next section is
   unimportable. Advancing the non-ref fields instead would fix coverage and break the reason
   v3 froze them.
3. **An ACK whose state CAS is lost has nowhere to recover from.** The remote has accepted `M`;
   the local record still says "previous BASE, verbatim pending". The next pull's `remoteSec`
   **is** `M`, and the deferral paths write `pending[rel] = remoteSec` (`apply.ts:1426`,
   `:1448`) — so the verbatim pending section and its key are replaced by our own merged
   section, which the hybrid model had explicitly promised would never happen. There is no
   durable partial-settle receipt to reconcile against.

**Was the alternative shape better — "BASE follows the published section"?** It was worth
working out properly, because it makes coverage true by construction: settle BASE to the
*published* section (all refs, including carried values, plus that section's bundle and chain)
and record per-ref origins so carried refs get carrier provenance instead of publisher-ack.
**It does not work, and the reason is the design's own central invariant.** `logicalBaseRefs`
starts as a copy of `base.refs` (`follower-protocol.ts:80`) and is compared against the
*physical* `beforeOid` in `planBranchTransition` (`branch-transition.ts:105`,
`logicalBaseOid !== beforeOid` throws). Advancing `BASE[h]` to a carried value `Y` this device
does not have makes the logical pre-state name a physical state that never existed here — so
the moment the hold clears and the apply tries to move `h` from its live value to `Y`, the
pre-state guard refuses, and the repository is wedged in exactly the shape §1.2 documents.
Carrier provenance does not help: the guard reads `base.refs`, not the origin. **A positive
BASE member must always be a value this device physically holds or held** — that is invariant 1
in §7, and it is why the carried refs cannot advance.

**The v4 settlement: carrying and settling are mutually exclusive.** One rule replaces the
whole third outcome:

> **A repository whose emitted section carries any ref is never settled.** Its post-ACK state
> is today's *unsettled* outcome, unchanged: `gitBaseAfterCommit` keeps the previous BASE entry
> wholesale, `pending[rel]` is retained, and `advertised[rel]` advances to the committed
> section.

This is **enforced, not emergent**, and the enforcement is one bar in an existing predicate:

- `provePendingSupersession` and `pendingSupersessionAckConverges` operate **only on the
  captured partition**, and return false whenever the carried partition is non-empty.
- The bar is needed on its own merits, because without it the existing test *passes by
  accident and dangerously*: for a carried ref the candidate value **equals** the pending
  value, so `equalOrFastForward(pending[R], candidate[R])` is `gitCommitAncestry(Y, Y)`, which
  is "equal", which is not `"not-ancestor"` — **proven**. A merged section would therefore
  declare the pending superseded without this device ever applying it, clear `pending[rel]`,
  advance BASE wholesale to the merged section, and mint `publisher-ack` origins for carried
  values — every hazard constraint 6 was written to prevent, arrived at through the *success*
  path rather than a bug. (Verified against the helper: `gitCommitAncestry` returns `"equal"`
  as soon as both `rev-parse --verify` calls agree, without consulting `merge-base` at all
  — `git-ancestry.ts:13-17`. It fails closed today only by luck: if the carried object is
  absent locally the `rev-parse` **throws**, and `provePendingSupersession`'s outer
  `catch { return false }` (`pending-supersession.ts:215-217`) swallows it. Depending on not
  having an object is not a safety argument.)
- Stated positively: **supersession requires the candidate value to be proved from local
  state.** A value the candidate merely relayed is not evidence about anything.

**What follows, and this is why the shape is preferred:**

| Consequence | Why it matters |
|---|---|
| **No hybrid BASE.** BASE is unchanged wholesale for a carrying repository. | Kills codex finding (a) — the dry-run is never asked — and finding (b): an unchanged BASE is covered by its own unchanged bundle and chain, by induction. No new `gitBaseAfterCommit` semantics, no per-ref merge in the composer. |
| **No new BASE outcome and no new authority member.** | `ComposeRepoBaseAuthority` stays as design 130 closed it (`130:286-323`), and `gitBaseAfterCommit` keeps its two-branch shape. Both are permanent commitments; not adding to them is worth real money. |
| **No origin is minted for any ref of a carrying repository** — captured ones included. | Fail-closed in the right direction: §3.4's invariant cannot be falsified, and P1 simply has less to act on until the hold clears. The *wire* claim still advances (`advertised[rel] = M`), which is what tombstone authorship reads (`publisher-tombstones.ts:108-122`), so a later deletion is still tombstoned at the value this device actually published. |
| **The lost-CAS case becomes a no-op** — codex finding (c). | Nothing new was written at ACK time, so a lost CAS leaves exactly the pre-push state. The next cycle observes `remoteSec = M`, and because `M ⊒ pending` on every unapplied facet (§4.4.0(d)) the self-echo loses nothing; the same held set is recomputed and the same merged section is recomposed. |
| **The self-echo is the same event on the happy path and after a crash.** | One behaviour to reason about and one test to write, instead of a crash-recovery special case. §9.5 asserts it. |

**The cost this shape pays, named rather than buried.** Because BASE does not advance, the
next merged emit's incremental basis is still the *last settled* BASE, so each cycle's bundle
contains the whole local delta since that BASE rather than the delta since the last publish.
Over a hold lasting days, that is a re-upload of the same accumulating increment every cycle
in which local work happened (identical bytes dedupe to the same `bundleEncSha`, so an idle
cycle uploads nothing). The natural optimization is to derive the basis from
`record.advertised` — the last section this device *published*, which by construction covers
its own tips — instead of from BASE. It is a transport-layer change with no authority
consequences, and it is **deliberately not in scope for 4b**: §11's bake condition measures
the unoptimized cost first, because "we assumed it was too expensive" is how the v1 cost
analysis went wrong.

**Everything else about the outcome, restated for the v4 shape:**

| Facet | Rule |
|---|---|
| **Section BASE (refs and non-ref fields)** | **unchanged, wholesale.** Today's unsettled path (`gitBaseAfterCommit`, `plan.ts:1155-1167`) already does exactly this; no code change. |
| **Design-130 branch BASE + origins** | unchanged; no origin minted. The ACK composes `candidate = previous base`, so every ref has `before === requested` and the composer's `publisher-ack` arm mints nothing (`base-composer.ts:356-367`). Verified against the composer, not assumed. |
| **`pending[rel]`** | retained by the **push** lane; replaced by `M` on the next pull's apply, which is safe by §4.4.0(d) and costs one full follow (constraint 2). |
| **`advertised[rel]`** | advances to `M`, as it does for any committed section (`push.ts:962`). **Plus `record.advertisedCarried`**, the carried partition from §4.4.0(b), written in the same CAS — the input tombstone authorship needs (constraint 3). |
| **Deferral subject** | unchanged: the apply deferral keeps the incoming key. The push lane records **no** deferral for a merged emit; it emits one bounded line naming the carried refs. |
| **Held attempt / partial progress** | unchanged in mechanism. Both re-key once when the incoming key moves to `M` (constraint 2). |
| **Crash recovery** | nothing to recover: no new state is written at ACK. A lost CAS is indistinguishable from a push that never happened, except that the remote already holds `M` — which the next pull absorbs as an ordinary incoming section. |

**What "carried" means to a follower: nothing.** A merged section is an ordinary `GitSection`;
`carriedRefs` is local-only (§4.4.0(b)). No receiver can observe the distinction and none
needs to.

**Sub-steps, corrected for v4.** 4a is *smaller* than v3's, because constraint 6 is gone and
the pinning plan is replaced by chaining:
- **4a — no behaviour change.** Land the carried/captured partition and `advertisedCarried`,
  the tombstone-authorship bar (constraint 3, both halves), the safe-ref and chain-bound
  refusals (§4.4.0(c), (e)), and the supersession bar on the carried set (§4.4a). Every one is
  provable by §9.5's tests without emitting a single merged section.
- **4b — the merged emit.** Compose and publish `M`.

**Blast radius, honestly.** P1–P3 only change *whether* rbox acts on refs it already
reasons about. P4 changes **what this device publishes for refs it is not authoritative
over**, for every repository with any hold, and every follower consumes it. Nothing on the
wire *format* changes — a merged section is an ordinary `GitSection` — but the wire
*content* changes for a case that today is byte-stable by construction. That is the
largest behavioural delta in this design and it is why §11 stages P4 differently from
everything else.


### 4.5 Recommendation

Ship P2 and P3 together with P1, then P4 as a separate, separately-gated step (§11). On
the founder's Mac the P1–P3 result is:

- the abandoned `~/.codex` worktrees hold their own branches and nothing else;
- the repository is not *deferred*, and the follow is skipped on subsequent cycles until the
  worktree registry actually changes;
- the four squash-merged branches stop cascading holds onto unrelated refs through the
  `noDropProof` fixpoint;
- the phantom ref is captured as an absence, published in the **same cycle's** push lane
  (§3.6a step D), and the wedge clears itself.

**Corrected in v3: capture is still gagged after P1–P3.** v2 claimed P2 ungagged it. It does
not (§4.2): a worktree hold is by construction on a ref the incoming section wants to change,
so `provePendingSupersession`'s equal-or-fast-forward test refuses and
`apply.ts:1447-1450` still sets `pending[rel] = remoteSec`. So the honest statement is:

- **P1 + P1b clear both observed field wedges** — mode (b) directly, and mode (a) only once
  the worktree is actually removed;
- **P4 is the only change that breaks the §1.5 causal chain**, because it is the only one
  that lets unrelated local work publish past an outstanding hold. Without it, an agent
  leaving a worktree behind still gags capture and still manufactures phantom refs — which
  P1 now cleans up automatically, but only after the fact.

That strengthens the case for P4 rather than weakening it, and it is why §11 keeps P4 in
scope despite its being the only step that ships default-OFF.

## 5. The self-healing contract

**Becomes automatic — no human, no `rbox git resolve`:**

| Situation | New behavior |
|---|---|
| Published branch deleted locally (`git branch -D`, `git worktree remove`, agent cleanup) | Absence receipt written, BASE retired, deletion published as a tombstone in the **same cycle's push lane**, `pending` superseded. One bounded log line. **No pin and no recovery listing** — R4, §3.0a. |
| `pending` carried on a ref the local repository no longer has | Supersedes as soon as the absence receipt exists. |
| Abandoned worktree holding a branch | Per-ref hold only; the repository is no longer *deferred* and the follow is held-skipped until the worktree registry changes. **Capture is still gagged until P4** (§4.2) — corrected from v2. |
| Unrelated local work while a worktree hold is outstanding | **P4 only.** Publishes per-ref past the hold. Nothing before P4 changes this. |
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
| **P4 per-ref pending lane** | **Positive cost, and the only one here.** Today a held repository republishes the carried pending section *by identity* — `normalizeOutgoingGitSections` reuses `pendingSection` unparsed when the incoming keys match (`publisher-tombstones.ts:183-186`), so it re-advertises the same `bundleEncSha` and uploads **nothing**. A merged section is a new section, so every cycle with an outstanding hold now runs an ordinary capture: bundle build, encrypt, upload. | **Larger than v3 claimed, and now correctly derived.** Because a carrying repository is never settled (§4.4a), BASE does not advance, so the incremental basis stays at the last *settled* BASE and each emit bundles the whole local delta since then — not the delta since the last publish. Identical bytes dedupe (same `bundleEncSha`), so an idle cycle uploads nothing; a cycle with new local work re-uploads the accumulated increment. Chain length is fixed, so `exceedsPackChainByteBound` never fires and there is no repack. §11's bake measures it; §4.4a records the `advertised`-based basis optimization it is measured *against*. |
| **P4 first-emit follow** | The incoming key moves once per merged emit (§4.4 constraint 2), so the held-skip bracket misses once and one `partial` record is discarded. | One extra full follow per merged emit — on the observed data ~9 s once, not per cycle. |

**Net, restated for v4.** P1–P3 are net negative, and the only new per-cycle work among
them is a hash of a `git worktree list` output the follow already spawns five times. **R4
removed the design's only standing cost** — v3's ~900 pinned refs — so P1 is now free at rest
as well as in wall clock.
**P4 is net positive** and v1's blanket "net cost is negative" no longer covers the design
as a whole. Two things are worth being explicit about, because v1's cost analysis was
written assuming P4 was deferred:

- **P2's held-skip does not suppress P4's capture.** Held-skip short-circuits the *follow*
  (apply lane); capture runs on the *push* lane. A repository that is held-skipped every
  cycle still captures every cycle under P4. The two optimizations do not compose the way
  the v1 table implies.
- **A long-lived hold is now a recurring upload.** The founder's own case — an abandoned
  worktree holding a branch for days — is exactly the shape that pays this. That is the
  intended trade (local work keeps flowing past the hold instead of freezing behind it),
  and P3 shrinks how often it applies by retiring squash-merged holds, but it is a real
  cost on a real observed workload and should be measured on the dev build before P4's
  bake condition (§11) is called met.

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
   **A carried ref never acquires such an origin, because a carrying repository never
   settles** — §4.4a.
2. **A published branch deleted locally is captured, never resurrected.** BASE-positive +
   P-absent + clear artifacts yields a locked absence receipt, never a branch creation. A
   durable receipt whose BASE retirement was interrupted is **completed**, never re-decided
   and never inverted into a creation — §3.6a step A′.
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
   `INVARIANTS.md`. The `priorOid` binding is §3.2; the relay bar is §4.4a and is what makes
   "carry ⇒ never settled" true rather than hoped for.)*
7. **Worktree ownership is observed regardless of containment.** Sibling worktrees outside
   the workspace still hold their refs; containment affects only reporting.
8. **rbox never destroys a reachable Git object to publish a deletion.** An absence capture
   retires a BASE member and writes an artifact; it deletes no live ref and no object. A
   follower pruning under tombstone authority still pins the displaced OIDs, unchanged from
   design 116. *(§3.4. What rbox does **not** promise is that a branch pointer survives a
   wrongly-published deletion — the durability contract is file history, R4, §3.0a. That is a
   product semantic, deliberately not an invariant.)*
9. **Held refs are published, never superseded, and never settle a section.** In a
   `pending ⊕ local` outgoing section (P4), a carried ref keeps its pending value verbatim, is
   excluded from tombstone authorship on both the candidate and the advertised side, and makes
   the whole section unsettleable. Composing a section is never authority over a ref this
   device does not hold. *(§4.4.0, §4.4a.)*
10. **Every published section's refs are covered by its own bundle chain.** A section whose
   `refs`, `head` or `indexTree` names an object absent from `packChain` + `bundleSha` is
   unimportable by every follower, so a merged section chains the section it carried from
   rather than assuming local possession. *(§4.4.0(e). Emergent today because every section is
   captured from local refs; P4 is the first shape that can violate it.)*

"Branch equality is not deletion authority" (since 130) remains true and unweakened: a
local-absence receipt is not equality, it is a locked proof of physical absence against
positive provenance. `follow.ts:894-895` keeps holding; it simply stops being reachable
for refs absence capture has already reconciled.

### 7.1 The recoverability analysis — kept as history, superseded by R4

**The mechanism discussion is superseded by R4 (§3.0a); the facts are still true and are why
neither earlier answer should come back.** Four of them:

1. **A tombstone retains an OID, not an object.** `GitRefTombstone` is `{oid, ts, generation}`
   (`src/engine/types.ts:71-75`) — metadata only; `REF_TOMBSTONE_RETENTION_MS`
   (`publisher-tombstones.ts:10`, cutoff at `:125-136`) retains the OID. What retains *objects*
   is the deliberately equal-valued `TOMBSTONE_PIN_RETENTION_MS` (`keep-pins.ts:68`) on the
   **keep-pin** — a different mechanism with a different creator. Anyone writing "recoverable via
   the tombstone retention" has conflated them.
2. **The follower pin is created by the prune**, so it does not exist when nobody prunes:
   a single-device workspace; both devices deleting before either applies the other's tombstone
   (each takes the `!oldOid && !newOid` path, `follow.ts:936` — a *likely* interleaving for the
   founder's loop, since the same agent cleanup runs on both machines); a device that never
   received the ref; a pre-1.6.8 follower that holds instead of pruning. So "no pin here because
   there is a pin there" was conditional on a coincidence. R4 does not resurrect that argument —
   it stops claiming a Git-side guarantee at all.
3. **The A path really does lack the keep-refs the P path has, and that is now deliberate.** The
   A artifact records the OID as *text* in a canonical blob (`baseAbsentPayload`,
   `base-artifacts.ts:145-149`, `:218-224`); the P artifact creates real keep-refs at `priorOid`
   and `nextOid` (`basePresentKeepRef`, `:114-118`, spliced at `:237-244`). R3 wanted to close the
   asymmetry; R4 leaves it open, because the P artifact's keep-refs serve a crash-window rollback
   (a correctness need) while the A path's would have served user-facing recovery — now the file
   plane's job.
4. **`expireTombstoneKeepPins` has no production caller** (exported at `src/engine/index.ts:284`,
   referenced only by `keep-pins.test.ts:166`) and does not get one. Pre-existing over-retention,
   erring safe; see §3.7. Codex's expiry-starvation major is **mooted, not fixed** (§13.2, M4).

### 7.2 ~~Finding a deleted branch~~ — REMOVED 2026-07-24 by R4

v3 specified `rbox git deleted <repo> [--restore <branch>] [--json]` because R3's pin was
recoverable but not *discoverable*. R4 removes the pin, so there is nothing to list. Codex's
round-2 major on its persisted shape (M3) is **mooted**. Four verified facts are kept, because
they constrain any future recovery surface:

- **`rbox git resolve … show-me` structurally cannot print an OID.** `buildSnapshot` computes
  local-only entries with their OIDs (`resolve-command.ts:238`, `:259`) and the public projection
  strips them (`:296`); the JSON path replaces any 40-hex token with `[commit]` (`:320-322`), and
  `git-cmd.test.ts:222-235` pins that contract by name.
- **The tombstone chain evicts long before it expires.** Caps of
  `MAX_REF_TOMBSTONES_PER_REF = 16` / `MAX_REF_TOMBSTONES_PER_REPO = 512`
  (`manifest-validate.ts:23-24`) are applied after the age cutoff
  (`publisher-tombstones.ts:124-146`). At ~10 deletions/day the oldest entries are gone well
  inside 90 days: the retention constant is a maximum, never a guarantee.
- **The keep-pin origin sidecar cannot carry new facts** (`keep-pins.ts:88-104`, §3.7). A future
  surface needs a **separate versioned sidecar** older clients ignore, and `pinned` is best
  *derived* (origin present, pin ref absent) rather than stored.
- **The server-side copy is not a recovery path.** The objects do survive in historical versions'
  bundle blobs — reachability is computed from the DO's retained roots
  (`apps/api/src/gc-phase1.ts:44-58`, `reachableFromWorkspaces`, `versions.ts:66+`) and history
  pruning is disabled in every deployed environment (`apps/api/src/retention.ts:36`) — but the
  window is the plan window (`apps/api/src/plans.ts:24-27`), not 90 days, and **no command
  restores a Git ref from a historical version**: `rbox restore <file>@<seq>` is file-plane only
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
lineage stale; **origin missing because the value was only ever *carried*** (§4.4a — the
repository never settled, so no origin was minted); `git` busy; preflight failure; repository
identity changed; **`show-ref` unreadable at plan time**; **`show-ref` unreadable at the locked
second proof**; **`R` is the current HEAD symref target**; **packed-refs inode changed or mtime
regressed**; **`logs/HEAD` missing while BASE recorded ≥ 1 head**; ref absent at plan time but
present at the locked second proof. Each case asserts BASE unchanged, no artifact written, and
no wire tombstone authored.

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

### 9.5 Per-ref pending lane (P4) — rewritten for v4

Each item maps to a numbered piece of §4.4.0 or §4.4a, so a missing test is visible as a
missing row.

- **Bundle coverage via the carried chain (§4.4.0(e)).** Compose a merged section where held
  ref `H` sits at a pending OID this device holds in **no** ref and whose objects are **absent
  locally** (import the incoming section, let `cleanupIncoming` tear down
  `refs/rbox-incoming/*` at `apply.ts:335-339`, then `git gc --prune=now`). Assert the emitted
  section resolves `H` when imported into a fresh clone — i.e. coverage came from
  `pending.packChain + newestLink(pending)`, not from a local pin. **This is the test that
  fails if the implementation follows v3's "pin the held tips at capture" plan**, because that
  plan cannot pin an object Git no longer has.
- **Basis filtering.** With one basis tip present locally and one absent, assert the capture
  passes only the present one as `^tip` and does **not** degrade to a full bundle
  (`onBasisFallback` is not invoked, `shared.ts:236-241`).
- **Chain bound refusal.** With `pending.packChain.length + 2 > MAX_PACK_CHAIN` (8,
  `manifest-validate.ts:19`), assert the merged emit is refused and the whole-section carry
  runs, with one bounded line — and that no full-bundle recompaction is attempted.
- **Carried absence (§4.4.0(b)) — the M2 row.** Hold a ref whose pending value is *absence*
  (the other writer deleted it and shipped a tombstone; this device holds local work and the
  attestation refuses the prune). Assert: the ref appears in `carriedRefs` while appearing in
  **neither** `section.refs` nor `pending.refs`; the well-formedness predicate accepts it; and
  no tombstone is authored for it on either the candidate or the advertised side. Then assert a
  `Record<string,string>` representation **cannot** express the row — a type-level test, so the
  representation cannot silently regress to a map.
- **Safe-ref refusal (§4.4.0(c)).** With `refs/stash` held (`local-stash`) or a tag forced held
  by a receiver-equivalence group, assert the merged emit is refused and the whole-section
  carry runs.
- **Non-ref facets are carried (§4.4.0(d)).** Emit a merged section while this device's local
  `head`, index and op-state all differ from the pending section's. Assert the published
  section's `head`, `indexSha`, `indexTree`, `opState` and `config` are **byte-identical to the
  pending section's**, and that only `refs` and the bundle fields differ. This is the test that
  fails if the implementation composes the merged section from a local capture and patches the
  refs in.
- **Carry ⇒ never settled (§4.4a) — the keystone row.** Accept a push for a repository with one
  carried ref and assert: the repository is **not** in `supersededPending`/`resolvedPending`;
  `gitBaseAfterCommit` keeps the previous BASE entry **wholesale** (refs *and* non-ref fields);
  `branchBaseOrigins` is **unchanged for every ref**, captured ones included; `advertised[rel]`
  advanced to the merged section; and `record.advertisedCarried` names exactly the carried set.
- **The accidental-supersession trap (§4.4a).** With the carried ref's objects **present**
  locally, assert `provePendingSupersession` returns **false**. Without the explicit carried-set
  bar this returns *true* — `equalOrFastForward(Y, Y)` is "equal" — and the repository settles
  a section it never applied. Name the test for the trap, because the failure mode is a success
  path.
- **Tombstone authorship, both halves (§4.4 constraint 3).** (i) Candidate side: a carried ref
  whose pending value differs from this device's advertised value gains **no** `refTombstones`
  entry and does not advance `refTombstoneGeneration`. (ii) **Advertised side — new in v4:**
  with `advertised.refs[R] = L` captured earlier and `R` now carried at `Y ≠ L`, assert no
  tombstone is authored at `L` — a value this device still holds and never superseded. Pair
  both with a structural test that the carried set and the authoring loop
  (`publisher-tombstones.ts:108-122`) cannot claim the same ref.
- **The self-echo, on the happy path and after a lost CAS (§4.4a).** After a successful merged
  emit, run another cycle and assert: `remoteSec` is this device's own merged section;
  `pending[rel]` becomes it; the same held set is recomputed; and nothing is lost — every facet
  the original pending section carried is still present in the new pending section. Then repeat
  with the post-ACK state CAS dropped and assert the **same** observable outcome, so the crash
  path needs no separate recovery code.
- **`gitIncomingKey` binding.** The structural test that no outgoing merged section's key is
  ever written into `deferrals`, `attempt` or `partial`; plus the honest positive: after the
  first merged emit the incoming key **does** move (to the merged section's), the held-skip
  bracket misses exactly once, and the discarded `partial` record costs one full follow and no
  correctness.
- **Unproved refs refuse the whole emit (§4.4.0(a)).** Construct a pending ref that is neither
  applied nor held — force the transition to throw so `follow.ts:1021-1027` catches it — and
  assert the merged emit is refused for the repository and the whole-section carry runs. This
  is the row that fails if the partition is implemented as "held vs not held".
- **Per-ref omission still needs a receipt.** With `RBOX_GIT_ABSENCE_CAPTURE=0` (P1b
  disabled) and P4 enabled, a locally-absent BASE-positive head must be **carried, not
  omitted**, from the merged section. This is the regression test for §4.4's ordering
  constraint — it is the one that fails loudly if P4 ever ships ahead of P1b.
- **Ordering/regression pair.** Assert today's byte-for-byte carry is still taken when the
  repository has **no** held refs (`publisher-tombstones.ts:183-186`'s reuse path), so P4
  narrows the carry rather than replacing it.

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
- **`gitStatus` (§3.3a), directly.** Table-driven over the two execution paths: a clean exit,
  a non-zero exit with stderr, a non-zero exit with **empty** stderr, a signalled child, and a
  `maxBuffer` overflow. Assert `code` is `null` for the last two on **both** paths, and that
  `gitRaw`'s thrown error shape (`message`, `code`) is byte-identical to today's for every row —
  that is the test that lets this land as a refactor rather than a behaviour change.
- `bun run rig`: two devices; device A holds a worktree on branch `B`, deletes a
  squash-merged branch `C` while the hold is outstanding, then removes the worktree.
  Assert both devices converge with **no** `rbox git resolve`, that `C` is gone everywhere,
  and that `B` and all unrelated work are intact. **With P4**, extend it: while the hold on
  `B` is outstanding, device A commits to an unrelated branch `D` and asserts `D` reaches
  device B *before* the hold clears — that is the behaviour P4 exists to produce and the
  rig is the only place it is observable end to end.
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
- ~~**The per-ref pending lane / `pending ⊕ local` outgoing section**~~ — **no longer a
  non-goal.** Ruled in scope 2026-07-24 (§12 Q5); specified as P4 in §4.4, sequenced in
  §11.
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
- **Publishing this device's own `head`, index, op-state or config while a hold is
  outstanding.** §4.4.0(d): the merged section carries every non-ref facet from the pending
  section verbatim, so only refs flow past a hold. A device wanting its staging area published
  waits for the hold to clear, which is what happens today for everything.
- **Advancing the incremental-capture basis to the last *published* section.** §4.4a names it as
  the natural optimization for P4's recurring-upload cost and deliberately leaves it out of 4b
  so the unoptimized cost is measured first.
- **Safe-ref (tag / `refs/stash`) carry semantics.** §4.4.0(c) refuses the merged emit instead.
  Safe refs have exact-equality semantics and no provenance model; inventing one is a separate
  design.

## 11. Rollout

Default-ON with kill switches, following the founder's standing rule and the existing
`gitPendingSupersedeEnabled` pattern (`pending-supersession.ts:26-27`) — with **one
deliberate exception**, P4, argued below.

| Switch | Default | Disables |
|---|---|---|
| `RBOX_GIT_ABSENCE_CAPTURE=0` | on | P1 + P1b + §3.6a step A′ (falls back to today's carry/refuse). *(v3 also had it disable §3.7's keep-pin and expiry sweep; R4 removed both, so the switch is narrower and cleaner.)* |
| `RBOX_GIT_CONTENT_EQUIV=0` | on | P3 (falls back to ancestry-only) |
| `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` | on | P2's held-skip eligibility **only** |
| `RBOX_GIT_OWNERSHIP_NO_ESCALATE=0` | on | P2's "no whole-repo defer for a non-HEAD ownership hold" |
| `RBOX_GIT_PENDING_MERGE=1` | **off, then on at bake** | P4 `pending ⊕ local` (falls back to today's whole-section carry) |

**Two switches for P2, corrected in v3.** v2 listed one switch and described it as disabling
P2. It does not: held-skip eligibility and the no-escalation change are independent code
paths, and a single `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` leaves the deferral-behaviour change
live. A kill switch that does not kill what the rollout section claims is worse than none,
because it is what someone reaches for at 2am.

**Landing order — corrected again in v3.** v1 shipped the authority change last; v2
inverted that, correctly, but justified it with a dependency that does not exist.

1. **P2 + reporting.** Held-skip eligibility with the worktree digest, no whole-repo
   escalation for non-HEAD holds, `rbox doctor` leftover-worktree section behind §5.1's
   local-only projection. No authority change; pure performance and UX. **Not a
   precondition for anything** — see the correction below. Landed first because it is the
   cheapest real improvement and it makes the founder's machine observable while the rest
   bakes.
2. **P3.** Content equivalence in `noDropProof`, with §4.3's destructive-transition bar.
   Cascade reduction only. Independent; landed here because it shrinks the held set P4 will
   first be exposed to.
3. **P1 + P1b + §3.3a's `gitStatus` + §3.3b + §3.6a (A, A′, B–D).** The authority change and
   everything that makes it safe: the strict ref read on its new structured runner, the
   restore/unborn-branch rules, and the reconciliation placement including A′'s crash
   completion. These ship **together** — a P1 without §3.3a is a fleet-wide deletion waiting
   for one corrupt loose ref, and a P1 without A′ can wedge permanently on a crash it caused
   itself. Validated on a dev build against the live wedge before any CLI release. *Genuine
   precondition for step 4.* **Smaller than v3's step 3**, which also carried §3.7's pin, its
   expiry sweep and §7.2's command; R4 removed all three.
4. **P4, in two sub-steps.**
   - **4a — no behaviour change.** Land the carried/captured partition and
     `record.advertisedCarried` (§4.4.0(b)), the tombstone-authorship bar on both the candidate
     and advertised sides (constraint 3), the safe-ref and chain-bound refusals (§4.4.0(c),
     (e)), and **the supersession bar on the carried set** (§4.4a). That last one is the piece
     that must precede the first merged emit — without it a merged section can settle a pending
     section it never applied, via the accidental `equalOrFastForward(Y, Y)` pass. All of it
     provable by §9.5's tests without emitting a merged section. *(v3's 4a instead shipped the
     scratch-pin plan and constraint 6's ACK authority; both are gone — the first was
     unimplementable (§4.4.0(e)), the second unnecessary (§4.4a).)*
   - **4b — the merged emit.** Compose and publish `M` (§4.4.0). The only step in the design
     that changes what a device publishes for refs it is not authoritative over.

**Correction: "P2 must precede P1/P4" was wrong.** `publishRefPlane` already returns a
per-ref held set — built per ref and returned both as a set (`follow.ts:1041`) and as a map
(`follow.ts:1047`) — and `apply.ts:1447` merely ignores the detail by consuming
`held.length`. So P4 has a per-ref hold set to merge over with or without P2, and P1 never
needed P2 at all. The ordering above is a *validation* sequence, not a dependency graph,
with exactly one hard edge: **step 3 before step 4**, for the single reason left in §4.4
("Ordering constraints") — P1b's receipt is what makes a per-ref omission legitimate. v3 also
claimed a converse edge; v4 retires it (constraint 6).

**Reverse migration for P4 — required, because "independently revertible" is false for it.**
v2 claimed each step was independently revertible while simultaneously admitting P4's revert
is not free. Both cannot be true. The reverse path, specified:

- **Exact carry is always reconstructible.** P4 never rewrites `pending[rel]` (§4.4
  constraint 2), so the byte-for-byte section the pre-P4 code would have carried is still
  in state. Turning the flag off returns `normalizeOutgoingGitSections` to its
  reuse-by-identity path (`publisher-tombstones.ts:183-186`) with no reconstruction step.
- **No BASE state needs undoing at all — better in v4 than in v3.** A carrying repository is
  never settled (§4.4a), so its BASE section, its branch BASE and its origins are all exactly
  what the pre-P4 code would have left. v3's reverse migration had to reason about a hybrid BASE
  that had advanced per-ref and about the redundant apply that unwinding it would force; that
  paragraph is **deleted rather than reworded**, because the state it described can no longer
  exist. The remaining revert cost is one stale `advertised` section naming a merged shape,
  which the next ordinary capture replaces.
- **The one residual: `record.advertisedCarried` outlives the flag.** With P4 off it is never
  written again, and the tombstone-authorship bar simply finds an empty set. It must therefore
  be *read* defensively (absent ⇒ empty) rather than assumed present, so a downgrade does not
  fault. One line, and it is the only reverse-migration requirement left.
- **Receipt-disabled fallback, stated as a rule and not only as a test.** With
  `RBOX_GIT_ABSENCE_CAPTURE=0` and `RBOX_GIT_PENDING_MERGE=1`, a locally-absent BASE-positive
  head must be **carried at its pending value**, never omitted from the merged section. The
  merged section degrades to exact carry per ref whenever the receipt that would license an
  omission is unavailable — for any reason, not only the flag. §9.5 asserts it.

**Why P4 stages OFF-then-ON, when everything else ships default-on.** The founder's standing
rule is default-on with a kill switch; the named exceptions are wire-compat, breaking, or a
**named bake condition**. P4 is the third. Its blast radius is categorically different from
P1–P3 (§4.4): those change whether this device acts on its own refs, P4 changes the bytes
this device publishes on behalf of refs another writer owns, for every repository with any
hold, consumed by every follower. Shipping that default-on and discovering a composition
bug means every held repository in the fleet has already published a bad section — and
`gitIncomingKey` moves, so the usual "revert and re-converge" is not free.

**Named bake condition for flipping `RBOX_GIT_PENDING_MERGE` to default-on** (all four, on
the dev build, before any CLI release carries it on):

1. The rig's P4 assertions (§9.5) and the extended two-device rig case (§9.6) pass.
2. Seven consecutive days on the founder's Mac with the flag on, at least one merged section
   actually emitted, and no `rbox git resolve` invoked.
3. The recurring-capture cost measured (§6) on a repository held for ≥ 24 h, and judged
   acceptable against the observed baseline rather than assumed to be.
4. **The incoming-key move behaves as specified, not as v3 hoped.** `gitIncomingKey(pending[rel])`
   is expected to move **once** per merged emit, to the merged section's key (§4.4 constraint 2's
   v4 amendment). The field check is that the *held set is unchanged across the move* and that
   no deferral episode, partial record or held attempt survives pointing at a key nothing holds —
   i.e. the re-key costs one follow and nothing else. *(v3's condition demanded the key be
   byte-identical across the emit, which is unachievable: the apply lane rewrites `pending[rel]`
   from `remoteSec` unconditionally.)*
5. **No `publisher-ack` origin observed for any ref of a carrying repository** after a merged
   section is acked — captured refs included. Under §4.4a a carrying repository settles nothing,
   so *any* fresh origin there means the supersession bar leaked, which is the one failure that
   could hand P1 forged evidence.

Steps 1–3 do **not** wait on this; they ship default-on as v1 planned.

*(v3 also specified a separate bake for keep-pin accumulation — count `refs/rbox-local/keep/*`,
measure `git gc` wall clock, confirm the sweep ran. **R4 removed the pin, so that bake is gone**
and the design has no at-rest cost left to measure.)*

**Wire compatibility.** None of this changes the wire *format*. P4 changes the wire
*content* for held repositories — a merged section is an ordinary `GitSection`, so every
follower parses it, but it is no longer byte-identical to the section the follower sent.
That is a behaviour change worth naming separately from "no wire-format change", which v1
stated and which remains true.

**Client skew.** An older client on the same account never authors absence receipts. Its
own BASE keeps the stale positive member, so for that repository it degrades to exactly
today's behavior (hold, `pending`, deferral) — no worse than before — and it cannot
resurrect the ref on the wire, because its capture omits what its P lacks and its own
ACK dry-run refuses the mismatch. A newer client's tombstone is processed by an older
client through the unchanged design-130 attestation path.

For P4 specifically: a merged section is a well-formed `GitSection` with no new or changed
fields, so an older client applies it exactly as it applies any other section — it has no
way to tell a merged section from a captured one, and does not need one. The asymmetry runs
the other way: an older client keeps carrying whole sections, so a mixed fleet simply has
some devices that publish per-ref and some that do not. Both behaviours already have to
interoperate today, because a device with no holds publishes per-ref by construction.

## 12. Decisions

All six of v1's open questions were ruled by the founder on **2026-07-24**. Four further
rulings (**R1–R4**) were issued the same day, and three of them *change* earlier rulings. They
are kept here as a decision record rather than deleted; the questions are stated as they were
asked, followed by the ruling and its reasoning, in date order with each supersession named.
**Nothing in this section is open.**

**The four later rulings, R1–R4 (2026-07-24), in one place, in the order issued:**

| | Ruling | Changes | Where |
|---|---|---|---|
| **R1** | Mass-deletion breaker trips if **either** leg trips, whichever comes first — `n ≥ 25 OR n ≥ 25% of N` | **Supersedes Q2's `max()` form**, which was arithmetically incapable of tripping on any repository under 100 heads. **Itself superseded by R4.** | §3.5, Q2 below |
| **R2** | Deletion is not instantly fleet-wide; state the version floor honestly | Narrows Q1's stated semantic without changing the decision | §3.0, Q1 below |
| **R3** | The **deleting** device pins the commit locally for 90 days | **Reversed Q3** and retired Q3a. **Itself superseded by R4.** | §3.7, §8 item 10, Q3 below |
| **R4** | **rbox promises FILE history, not Git history.** No thresholds, no pins, no recovery command. | **Supersedes Q2, Q2b and R1** (the breaker) and **Q3 and R3** (the pin), and retires §7.2. The most consequential ruling in the design: it decides how much machinery a *wrong* capture deserves. | §3.0a, §3.5, §3.7, §7.1, §7.2, Q2/Q2b/Q3 below |

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
unchanged; its *statement* was overclaimed. Design 130's tombstone attestation
(`src/cli/sync-git/tombstone-attestation.ts`) first shipped in **v1.6.8**, commit
`04c2aff8` (#297) — verified with `git tag --contains`, not assumed. Read off
`v1.6.6:src/cli/sync-git/follow.ts`, a pre-130 device meets a squash-deleted branch with
`tipOwnedByIncoming` returning `unowned`, classifies it `local-commits`, and **holds**;
there is no attestation path to waive that hold, and the resulting whole-repository pending
gag means it also never re-advertises the ref, so it cannot resurrect it either. The honest
semantic is therefore **eventually** fleet-wide: a lagging device keeps the branch and
defers that repository's Git plane until it upgrades, then converges through the unchanged
attestation path. Nothing is lost; the fleet is briefly inconsistent; one repository on one
stale device stops syncing Git in the meantime. §3.0 states all three. The founder's
phrasing was "1.7.x and newer", which is a safe superset and the right thing to tell a user;
the design records the verified constant so a future skew argument does not start from the
wrong one.

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
*RULED 2026-07-24 — **IN SCOPE NOW**. This overrules the design's recommendation*, which
proposed a follow-up. It is the largest change in v2. Specified as **P4** in **§4.4**,
sequenced in **§11**, costed in **§6**, tested in **§9.5**, and removed from **§10**'s
non-goals. Consequences worth surfacing here rather than leaving spread across the document:
- **The landing order inverts.** v1 shipped the authority change (P1 + P1b) last. P4's
  per-ref omission is only legitimate because P1b's receipt rule exists, so P1b must now
  precede P4 — the analogue of §3.6's "the receipt must land before capture, or the ACK
  dry-run refuses". **v3 adds the converse edge and removes a false one:** P4's
  held-ref-aware ACK (§4.4 constraint 6) is what stops P4 forging the provenance P1 trusts,
  so it ships *with* P4 and never after — ***superseded in v4:*** constraint 6 is retired and the
  guarantee comes from §4.4a's "carry ⇒ never settled" instead, so the converse edge is gone;
  and ~~P2 must precede both~~ was wrong —
  `publishRefPlane` already returns a per-ref held set (`follow.ts:1041`, `:1047`), so P2 is
  a validation-sequencing choice, not a dependency. P3 is independent and landed early
  because it shrinks P4's first exposure.
- **The cost analysis no longer nets negative.** v1's "net cost is negative" was written
  assuming P4 was deferred. P4 replaces a carry that re-advertises the same bundle and
  uploads nothing (`publisher-tombstones.ts:183-186`) with an ordinary capture per cycle
  while a hold is outstanding, and P2's held-skip does not suppress it because held-skip
  short-circuits the follow while capture runs on the push lane. §6 says so plainly.
- **The blast radius is categorically larger.** P1–P3 change whether this device acts on
  its own refs; P4 changes the bytes this device publishes for refs another writer owns.
  Under the founder's default-on-with-kill-switch rule this qualifies for the "named bake
  condition" exception: **P4 alone ships default-OFF** behind `RBOX_GIT_PENDING_MERGE`, with
  a four-part bake condition in §11, and flips default-on once met. Everything else still
  ships default-on.

**6. Surfaces.**
*Not separately ruled; taken as decided (2026-07-24).* Recorded in **§5.1**.
- **`rbox doctor` gains a leftover-worktree section** — count, and per entry the branch, the
  full absolute path, `prunable`, and whether it holds a synced ref. With ten worktrees,
  `path.basename` (`apply.ts:118`) is useless precisely because they are all named after
  their branches, so the basename only repeats the branch the message already prints.
- **Deferral messages do not print absolute worktree paths yet.** An independent review
  found that absolute paths already reach local logs through this channel:
  `protocol-locks.ts:158-159`/`:167-168` embed the absolute lock path in their errors, and
  PR #439 (`621aed46`) added `checkoutRefDetail` (`follow.ts:1026`) to a catch that
  previously discarded that text. (The review's attribution was slightly off — #439 touches
  only `follow.ts`, +3 lines; it is what *surfaces* the paths, not what authored them.) The
  redaction rule must be confirmed to cover worktree paths **before** more absolute paths
  are added to user-visible surfaces. §5.1 records what that rule actually is: not a path
  scrubber but a fail-closed grammar allowlist that rewrites recognized `git-sync ` lines
  into closed enums (`doctor-cmd.ts:171-215`), with two holes — non-Git-family lines before
  the first Git-family line pass through verbatim (`:183-185`), and `ctx.checks` is uploaded
  unredacted (`:535`). **Full paths in local `doctor` output are fine; the uploaded path is
  what needs the rule.** Closing that rule is scoped out (§10) and is the precondition for
  putting the path in the deferral message, which remains the better message.
  ***AMENDED in v3:*** v2 left "local paths are fine" as an assertion about where the output
  is *displayed*. It is not — `ctx.checks` is bundled and uploaded raw (`doctor-cmd.ts:535`),
  so a `DoctorCheck` carrying a worktree path *is* an uploaded path. §5.1 now specifies a
  typed local-only projection that never reaches `buildDiagnosticsBundle`, plus a redacted
  bundle projection with no path text of any kind.

## 13. Codex review record

Two rounds, kept so the next reviewer starts from here rather than re-deriving. Every code claim
in both tables was re-verified against the worktree before being folded in, and codex's
mis-citations are corrected rather than propagated.

### 13.1 Round 1 — what was caught and how it was answered

**Verdict: NOT-ALIGNED — 7 blockers, 4 majors.** Round 2 confirmed 8 of the 11 closed. The
resolutions below are as v3 recorded them; **where R4 or round 2 later changed the answer, the
row says so** rather than being quietly rewritten.

### Blockers

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | Q3's no-pin premise is false even multi-device — recovery depended on a *follower* pruning, which does not happen in several ordinary cases | v3: **resolved by R3** (deleting-device pin). **v4: the finding stands and the *answer* changed — R4 removes the pin and answers the recoverability question at the product layer instead (§3.0a).** Codex was right that the follower-pin premise was unreliable; that premise is not restored. | §3.0a, §3.7, §7.1, §12 Q3 |
| 2 | P1 turns a ref-read error into fleet-wide deletion — `readAllRefs` maps any `show-ref` failure to `{}` | **Resolved.** Strict reader specified with the exit-code discipline the codebase already uses at `shared.ts:261-268`; mandatory site list includes the locked proof at `branch-transition.ts:309` and both capture sites. Reproduced empirically | §3.3a |
| 3 | P4 destroys P1's provenance invariant — carried values acquire `publisher-ack` origins | v3: held-ref-aware ACK authority (`advertisedRefs`/`carriedRefs` split). **v4: same guarantee, no new authority member** — a carrying repository never settles, so no origin is minted for any of its refs (§4.4a). Constraint 6 retired. | §4.4a |
| 4 | P1's control flow does not clear the field wedge — the unchanged shortcut precedes the hook, and retiring BASE mid-pass lets the section re-create the branch | **Resolved.** Reconciliation moved above `apply.ts:873` with an O(1) cheap gate; `result: "reconciled"` ends the pass; the same cycle's push lane publishes the omission (`sync.ts:9-19` is pull-then-push) | §3.6a |
| 5 | BASE provenance proves possession, not the cause of absence — an in-place ref restore preserves identity | v3: §3.4 stops claiming otherwise; HEAD-symref rejection and ref-database signals added; **the breaker named as the primary restore detector**. **v4: the breaker is gone (R4), so this is now "detection hardening plus an accepted residual" — see round-2 blocker B3 and §3.0a.** | §3.3b, §3.4, §3.0a |
| 6 | P3 has a false positive and can authorize deletion — "waives holds only" is not a mechanism | **Partly resolved, honestly scoped.** `--verbatim` closes the whitespace half; the apply-then-revert false positive is **left standing and pinned by a test**; the boundary is made structural (waiver barred from destructive transitions + disjointness test); P3 re-described as cascade reduction | §4.3, §9.1 |
| 7 | P4's accepted-ACK state machine is undecided | v3: third outcome `partially-superseded` with a hybrid BASE. **Round 2 reopened it (B7) and v4 replaced it: no third outcome, no hybrid — carrying and settling are mutually exclusive (§4.4a).** | §4.4a |

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
| 7 | `partially-superseded` is internally inconsistent — carried refs at prior BASE vs a deep-equality ACK check, and a hybrid BASE with an under-covering pack chain | **Resolved by redesign** (§4.4a): no hybrid, no third outcome, no new composer semantics. |
| 9 | Rollout/rollback inherits finding 7's invalid hybrid BASE | **Resolved.** With no hybrid there is no BASE state to unwind; §11's reverse migration shrinks to one defensive read of `record.advertisedCarried`. |

**New blockers:**

| # | Finding | Resolution | Where |
|---|---|---|---|
| B1 | P1b can supersede a pending value the receipt does not witness — an A for BASE/local `X` authorizes omitting another writer's unseen `Y` | **Resolved.** Supersession requires `receipt.priorOid === pending.refs[R]`; a mismatch **carries**, the apply lane then re-creates `R` at `Y` through the ordinary creation path, and a second deletion mints a receipt bound to `Y`. The binding already exists in-tree at `follow.ts:857`. | §3.2, §9.1 |
| B2 | Pin+A crash recovery still misses the unchanged path — an existing A is excluded by rule 3, the in-follow recovery needs the incoming section to omit `R`, and the shortcut returns first | **Resolved.** New **step A′** above the unchanged shortcut completes the retirement idempotently from the durable artifact, with the inverse of rule 3 and a fresh locked proof. The second half of the finding — that `keep-pins.ts:425-428` is generic filter logic with no production caller, so v3's crash-row-1 claim was false — is **moot now the pin is gone** (R4), and §7.1 records that `expireTombstoneKeepPins` still has no caller and deliberately does not get one. | §3.6a A′, §7.1, §9.1 |
| B3 | Sub-20-head restore hole: an in-place refs restore with retained logs/HEAD bypasses both heuristics and the guarded breaker cannot trip below 20 heads | **Not closed — accepted.** A total-absence leg (`a === N && N ≥ 2`) was drafted for this revision and **withdrawn by R4**: no thresholds. §3.0a states the residual, its recovery sources and the founder's acceptance; §9.1 pins it as an accepted-residual test. **This is the one round-2 blocker answered by a product ruling rather than by code.** | §3.0a, §3.3b (iii), §12 Q2b |
| B4 | P4 partial settlement is not closed under ACK failure or incremental capture — (a) deep-equality vs retained prior BASE, (b) advanced BASE refs with a retained pack chain that does not cover them (`incrementalCapturePlan`, `shared.ts:135-141`), (c) an ACK whose CAS is lost overwrites the verbatim pending section and its key | **Resolved by redesign.** (a) and (b) dissolve because BASE does not advance at all for a carrying repository (§4.4a); (c) is answered by making the self-echo *safe by construction* — the merged section carries every unapplied facet of the pending section verbatim (§4.4.0(d)), so replacing `pending[rel]` with it loses nothing, on the happy path and after a crash alike. The alternative "BASE follows the published section" shape was worked out and **rejected with a reason**: advancing BASE to a carried value makes `logicalBaseRefs` name a physical pre-state that never existed here, and `branch-transition.ts:105` then refuses the very apply that would install it. | §4.4.0, §4.4a, §9.5 |

**New majors:**

| # | Finding | Resolution | Where |
|---|---|---|---|
| M1 | Strict-read stderr taxonomy has no stable API — the cited precedent checks only the exit code, and `gitRaw`'s two paths expose failure differently | **Resolved.** Structured `gitStatus(root, args)` returning `{status:"ok"}` or `{status:"failed", code, stdout, stderr}` across both paths, with `code` normalized to `null` for signals/spawn faults; exact reader semantics stated as three lines; `gitRaw` re-implemented over it with a byte-identical throwing contract; `readLocalGitConfigEntries` moved onto it in the same change. | §3.3a, §9.6 |
| M2 | Carried absence has no representation — a `Record<string,string>` cannot express a held ref whose pending value is deletion | **Resolved.** `carriedRefs` becomes a **sorted list of ref names**, so a name with no entry in `section.refs` *is* a carried absence; the well-formedness predicate is restated as a total rule. Wire schema checked before choosing: `refs` values must be 40-hex (`manifest-validate.ts:387-390`) and an invalid one rejects the whole section, so **no sentinel is possible** — the partition is local-only, persisted as `record.advertisedCarried`. | §4.4.0(b), §9.5 |
| M3 | `pinned:false` and deletion provenance have no persisted shape — `KeepPinOrigin` encodes neither | **MOOT under R4** — no pin, no listing. The finding's *analysis* is kept because it constrains any future recovery surface: `parseKeepPinOrigins` rejects unknown fields and unknown `class` values (`keep-pins.ts:88-104`), so extending it is a downgrade hazard; a separate versioned sidecar is required, and `pinned` is best derived (origin present, pin ref absent) rather than stored. | §7.2, §3.7 |
| M4 | Tombstone-pin expiry can starve forever — the only caller would be after a successful capture | **MOOT under R4** — no pin, so no sweep. Recorded honestly: `expireTombstoneKeepPins` still has **no production caller**, so already-shipped follower-prune pins are still retained indefinitely. That is pre-existing over-retention, it errs safe, and this design deliberately does not change it. *(Had a sweep been needed, the right host was the daemon's cycle-level `runDeferralHygiene()` tick (`daemon.ts:2197-2223`) — which visits repo records regardless of whether they captured — and **not** `reconcileGitDeferrals` itself, which returns early when no reconcilable deferral exists, nor `rbox status`, which must not mutate refs.)* | §3.7, §7.1 |
| M5 | Q2b remains normatively contradictory — §3.5 and §12 say "STILL OPEN", §9.4 says "whichever the founder rules", §7 invariant 4 states the unguarded leg | **Resolved by sweep, to a different answer than the one the finding assumed.** Every occurrence now says **no thresholds** (R4): §3.5 is a removal record, §7's invariant 4 is deleted (the invariant list renumbered), §9.4 becomes two negative tests, §12 Q2/Q2b carry dated supersessions, and the v3 changelog entry points at §12. Grepped for `Q2b`, `STILL OPEN`, `unguarded`, `hair-trigger` and `breaker` to confirm no stale normative statement survives. | §3.5, §7, §9.4, §12 |

### 13.3 What is deliberately left standing

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
5. **P4's recurring-capture cost is unoptimized on purpose** (§4.4a, §11 bake condition 3). The
   `advertised`-derived basis is the obvious fix and is deliberately measured against rather
   than assumed into the first landing.
