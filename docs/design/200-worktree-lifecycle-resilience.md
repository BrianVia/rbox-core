# 200 — Worktree lifecycle resilience: capturing out-of-band branch deletion

Status: DESIGN v2 — 2026-07-24. Founder rulings on §12 folded in; not yet codex-reviewed.
Author: Claude, from first-hand field forensics on the founder's Mac, 2026-07-24.
Changes in v2: §12's open questions are ruled (2026-07-24). The per-ref pending lane
(`pending ⊕ local`) moves from follow-up into the design as **P4** (§4.4), which
re-orders the rollout (§11); the deletion semantic is stated (§3.0); the circuit
breaker's thresholds are fixed against design 108's precedent (§3.5); and the
recoverability window the "no safety pin" ruling depends on is stated and verified
in §7.1 — **with one gap the ruling's premise does not cover** (§7.1, "Where the
window does not hold").
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
fleet-wide.** `git branch -D` means what it says inside a synced workspace.

Alongside it, three smaller changes make mode (a) harmless: stop letting a per-ref hold
gag the repository, make the hold held-skip eligible (with a worktree-registry digest in
the skip bracket), and teach the no-drop proof that **content already merged by squash is
not lost work** — using the founder's validated patch-id recipe, generalized to rbox's
durable-roots model so it needs no `origin/main` concept.

Finally — ruled in on 2026-07-24, and the largest single change here — the outgoing
section becomes **`pending ⊕ local`** (§4.4): a held ref carries its pending value while
every other ref publishes its local value, instead of today's all-or-nothing swap. That
is the structural fix that prevents the whole class rather than clearing one instance of
it, and it is why §11's landing order is inverted from v1's.

Cost is negative for P1–P3: the new checks are O(1) per BASE head in the negative case
and are gated behind proofs that already failed, while making ownership holds held-skip
eligible removes a full follow per cycle from exactly the repositories that suffer today.
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

> **Deleting a published branch on one machine removes it fleet-wide.** Inside a synced
> workspace `git branch -D` means what it says: the deletion is an event rbox captures and
> publishes, not a local divergence rbox repairs by re-materializing the branch from the
> fleet.

The rejected alternative was to retire the BASE member locally and let the next incoming
section re-create the branch. It is strictly non-destructive, and it is wrong: it makes
branch deletion a no-op on every machine that syncs, silently and forever. The founder's
loop *is* create-branch → merge → delete-branch; a sync tool that cannot represent the
last step of that loop is not syncing the loop.

Three consequences are load-bearing and stated here so nothing later has to re-derive
them:

1. **Deletion is authoritative, so it must be receipted.** Publishing a deletion is a
   destructive claim about other machines' repositories. That is exactly why §3.2's
   absence receipt is a locked A artifact and not a BASE edit, why §3.3's witness has
   seven conditions, and why §3.5's circuit breaker exists.
2. **Receivers still hold a veto.** "Removes it fleet-wide" is the *intent* of the
   published tombstone, not an instruction receivers must obey. A follower that has
   advanced the branch beyond the tombstoned OID holds instead of pruning (§3.4). Fleet
   authority is *the deleting device's own history*, never another device's.
3. **The objects survive the deletion for a bounded window.** Publishing a deletion is
   only acceptable because the branch tip stays recoverable across the fleet after the
   prune. That window is the condition the founder attached to the "no safety pin"
   ruling, and it is stated, verified and bounded in **§7.1** — including where it does
   not hold.

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

| Local state of a pending head | Disposition |
|---|---|
| present and equal, or a fast-forward descendant | supersede (today's rule) |
| absent, and a current-lineage A / settled-absence receipt exists for it | **supersede** (new) |
| absent, no receipt | carry (today's rule — fail closed) |

Tags and `refs/stash` keep their exact-equality rule (`pending-supersession.ts:106-108`,
`:203-204`) untouched: safe refs have never had A/P/K semantics and design 130 forbids
substituting one witness class for the other.

### 3.3 The deletion witness — what licenses an absence capture

Absence capture fires for a `refs/heads/*` ref `R` only when **all** of the following
hold. Any failure, any exception, any unreadable input leaves `R` exactly as it is today.

1. `record.base.refs[R] = X` is positive, and `record.branchBaseOrigins[R]` is a
   `usableOrigin` for `X` in the **live** lineage (`base-composer.ts:223-225`;
   `130:214-234`). This is the load-bearing one — see §3.4.
2. The live repository has no `R` — `readAllRefs`, already read once per cycle, so free —
   and no `R` again at the locked boundary.
3. The protocol artifacts for `R` are clear: no A, no P/K, no settled absence, no active
   foreign artifact. That is exactly `prepareFollowerBranchProtocol`'s
   `BranchArtifactDisposition` for `R` with all four fields `absent`/`clear`
   (`follower-protocol.ts:83-114`). An existing A means the deletion is already recorded;
   an existing P/K means a crashed transition owns this ref and `p-repair` must run first.
4. No sibling worktree owns `R` (`branchesCheckedOutElsewhere`) and `R` is not in a
   receiver-equivalent collision group (`receiverEquivalentCollisionNames`).
5. Git is not busy, preflight is `ok`, and the repository identity/lineage binding
   validates (`readRepoIdentityV1` / `readStateLineageV1`, `follower-protocol.ts:61-67`).
   A `.git` that was restored, replaced or rebound fails here and never reaches capture.
6. The observation survives the locked second proof inside
   `commitPlannedBranchTransition` (`branch-transition.ts:301-321`): `R` still absent,
   still unowned, while the ref transaction holds its locks.
7. The repository-level circuit breaker (§3.5) has not tripped.

### 3.4 Why this cannot lose work

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

Therefore **BASE-positive + P-absent + no A/Z + valid lineage ⇒ the ref was deleted
out-of-band on this machine, after rbox last observed it.** It cannot mean "never
delivered here": a ref that never arrived was never in this device's BASE with a usable
origin. That is the discriminator, and it is checkable locally with no new provenance and
no new wire field.

From there, publishing the deletion cannot lose work:

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
- **The objects survive the prune across the fleet for a bounded window.** Every follower
  that prunes `R` pins the tombstoned tip under `refs/rbox-local/keep/<X>` for
  `TOMBSTONE_PIN_RETENTION_MS`, and pins the rest of that branch's reflog permanently. This
  is what makes "no safety pin" (§12 Q3) safe rather than merely cheap, and it is stated in
  full — with its two gaps — in **§7.1**. It is not optional to the argument: without it,
  the last machine to sync destroys the only copy.
- The alternative (resurrection) is strictly worse and re-opens
  `REVIEW-174-R1-OPUS-B.md:14`.

### 3.5 The circuit breaker — where a human is genuinely required

The one shape that must not auto-publish is "the repository was replaced": a restore from
backup, a `.git` swapped in place, a clone that lost its refs. Identity and lineage
binding (§3.3 rule 5) catches most of it, but not a same-identity repository whose refs
were mass-deleted.

**Rule — RULED 2026-07-24.** Per repository, per cycle: if the number of BASE-positive
heads that would be absence-captured reaches `max(K, ceil(F · |BASE heads|))`, capture
**none** of them, record an `apply` deferral under a new dedicated reason, and print one
bounded line naming the count. **`K = 25`, `F = 0.25` — both legs, and tripping DEFERS the
repository rather than warning and proceeding.**

Both legs, because each covers a case the other cannot. The `K` floor **exempts small
repositories**: a 12-head repository hits 25% at three branches, which is one afternoon's
cleanup, and nagging there buys nothing because its blast radius is three branches. The `F`
leg **catches large ones**: a 300-head repository blows past any absolute floor worth
setting in its first wiped cycle. `max` is the honest way to say "both must be true":
`n ≥ max(K, ceil(F·N))` ⟺ `n ≥ K ∧ n ≥ ceil(F·N)`. This is design 108's own stated
rationale, transposed: "the `MIN` floor means workspaces under ~5,000 files … are never
nagged — their blast radius is small … the 20% leg catches large workspaces before a full
wipe" (`108-scan-fault-isolation.md:84-88`).

**Precedent.** This is the file plane's shape, scaled for ref counts in the hundreds
rather than file counts in the hundred-thousands. rbox already runs two mass-delete
breakers, and it is worth being precise about which one this copies, because they are
different:

| Guard | Design | Predicate | Where |
|---|---|---|---|
| Pull-side mass-delete guard | 44 | `deletes ≥ 100 ∧ deletes·2 ≥ baseFiles` (i.e. `≥ 100` **and** `≥ 50%`) | `policy.ts:11-15`, applied at `pull.ts:276` |
| Push-side mass-delete breaker | 108 (`docs/design/108-scan-fault-isolation.md:79-88` — note it is that 108, not `108-files-first-publish.md`) | `deletes ≥ min ∧ deletes·100 ≥ pct·baseCount`, defaults `min = 1000`, `pct = 20`; env-overridable via `RBOX_MASS_DELETE_MIN` / `RBOX_MASS_DELETE_PCT`. The design states the intent as `deletes >= max(PCT% of last-synced count, MIN)` and the code as the "integer-safe" two-legged form. | `pushMassDeleteTrips`, `policy.ts:22-35`, applied at `push.ts:701` |

The `max(fraction, floor)` shape this design adopts is **design 108's push-side breaker**,
not design 44's — design 44's is an absolute floor ANDed with a *half*-the-tree fraction,
and it guards the receiving side. 108 is the right precedent for the additional reason
that it guards the *publishing* side: like absence capture, it is the point where this
device's local observation is about to become everyone else's reality, and
`push.ts:694-708` refuses **before any encrypt/upload/commit work**, exactly as absence
capture must refuse before any A artifact is written.

Both file-plane guards fail closed with human consent as the only override — `policy.ts:14`
states it as "fails closed until a human says otherwise", and the daemon deliberately never
consents (`push.ts:698-699`), so a runaway wipe halts background sync instead of publishing
it. **Defer, not warn**, follows directly: a warning that proceeds is a breaker that does
not break. The difference from the file plane is only the override verb — the file plane
has `--allow-mass-delete`; this breaker's escape is `rbox git resolve <repo> show-me`
followed by the existing resolve arms, because the shape it guards is a repository-level
question, not a one-flag consent.

**Why `25` and `0.25` and not 108's `1000` and `20%`.** Blast radius per unit. The founder's
whole Mac carries ~203 branch heads across 110 repositories (§1); `Personal/rbox-core`
alone has 304 BASE refs. One branch is a unit of human work, not a byte, so the floor has to
sit near the top of a plausible day's churn — ~10 deleted branches/day observed (§8 item 10)
— and well below a wipe. `K = 25` is ~2.5 days of the founder's observed rate. `F = 0.25` is
tighter than 44's 50% and looser than 108's 20% because ref sets are two to three orders of
magnitude smaller than file sets, so a quarter of them is still a number no normal cleanup
reaches. On the measured repository the breaker trips at `max(25, ceil(0.25 · 304)) = 76`.

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
- **No whole-repo escalation for a non-HEAD ref.** `follow.ts:709-711` (incoming HEAD
  owned) must stay a whole-repo defer — rbox cannot attach the primary checkout to a
  branch a sibling holds. Everything else stays per-ref, and `apply.ts:1447-1450` must
  distinguish held refs the incoming section actually wants to change from held refs that
  are already convergent; only the former justifies a deferral record.
- **Capture is not gagged by a hold alone.** With P1b in place, a repository whose only
  held ref is worktree-owned reaches `pendingSupersessionPreProbe` and supersedes as soon
  as local ≥ pending for every other ref, so ordinary local work keeps flowing.

P2 makes the hold cheap and stops it gagging the repository. It does **not** make the
outgoing section per-ref: while a hold is outstanding the whole section is still carried
verbatim. That last step is **P4**, ruled in scope on 2026-07-24 and specified in §4.4.

### 4.3 Content-equivalence: teach the no-drop proof about squash merges

Even with P2, a worktree-held branch that is squash-merged is still classified as
receiver-only work by every proof that touches it, because merged-ness is ancestry-only
(§2.1). That is what makes an abandoned worktree feel permanent rather than merely untidy,
and it is where the founder's validated recipe belongs.

**Proposal P3.** Extend `noDropProof` (`reachability.ts:208-238`). Today a protected tip
`T` that is not an ancestor of any durable root `D` returns `{status:"would-drop"}`
immediately. Before returning, run a bounded content-equivalence probe for each `D`:

```
base  = git merge-base D T
# patch-id of the whole base..T range, as one synthetic change:
pid   = git diff-tree -p --no-commit-id base T | git patch-id --stable
# patch-ids of everything D gained since the fork point:
match = git log -p --format=%H --no-merges base..D | git patch-id --stable | grep pid
```

If any `D` matches, return `{status: "proven", marker: "content-equivalent"}`.

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
- **Content equivalence may waive a hold. It may never authorize a deletion.** Deleting a
  branch still requires a design-130 tombstone attestation or a P1 absence receipt.
  patch-id equality says the *diff* survives; it says nothing about commit SHAs, messages,
  authorship or signatures, and those are not rbox's to discard on evidence this weak.
- Cache on `(T, D)`. Both are immutable OIDs, so the answer is a pure function of the key
  and never needs invalidation. Persist alongside `divergence-cache.ts`'s store, bounded
  LRU.

### 4.4 The per-ref pending lane: `pending ⊕ local` (P4)

**RULED IN SCOPE 2026-07-24.** v1 proposed this as a follow-up (§12 Q5); the founder
overruled that. It is the structural fix that prevents the whole class instead of clearing
one instance of it, and it is now part of the design.

**Proposal P4.** While a repository has any held ref, the outgoing section stops being the
carried incoming section and becomes a **merge**: the carried `pending` value verbatim for
each held ref, the live local value for every ref rbox may publish. Today
`apply.ts:1447-1450` sets `pending[rel] = remoteSec` for the whole repository and
`normalizeOutgoingGitSections` republishes it by identity
(`publisher-tombstones.ts:184-187`: when `gitIncomingKey(pendingSection) ===
gitIncomingKey(section)` the pending section is reused unparsed and unnormalized). One
held ref therefore freezes every other ref's published value for as long as the hold
lasts. P2 stops that from *deferring* the repository and stops it *gagging capture*; only
P4 stops it from **freezing the outgoing section**.

**Why it is not just a map merge.** Five things are entangled with the all-or-nothing
carry, and each needs its own answer:

1. **Bundle coverage.** A merged section advertises held tips this device does not hold in
   any publishable ref. `capture.ts:291-295` builds the bundle from `dirAllArgs` + stash +
   scratch pins, and `RBOX_INTERNAL_REFS_EXCLUDE = "--exclude=refs/rbox-*"`
   (`capture.ts:32`) excludes every rbox namespace. The incoming objects *are* imported
   during apply — but into `refs/rbox-incoming/<ts>-<rand>` (`apply.ts:343`), which
   `cleanupIncoming` tears down after publish or defer (`apply.ts:335-339`). **So the held
   pending tips must be durably pinned into the capture's scratch-pin set
   (`createScratchPins`, `capture.ts:282`) at capture time**, not borrowed from the
   apply-time namespace. Publishing a refs map whose tips are absent from the bundle is
   not a deferral, it is a broken section every follower fails to import.
2. **`gitIncomingKey` stability.** `130:119-123` is explicit that the carry passes
   byte-for-byte *precisely* so the key does not move, "because normalizing it would
   change `gitIncomingKey` and orphan partial progress and deferral episodes bound to that
   key". A merged section has a different key by construction — `refs`, `bundleSha` and
   `packChain` all participate (`shared.ts:85-103`). Every consumer keyed on it needs a
   decided story before the first merged section is emitted: `GitHeldAttempt.incomingKey`
   (`sync-state-model.ts:228-245`), the `partial` record and `setDeferral`'s
   `subjectKey` (`apply.ts:1448-1450`), and the tombstone attestation binding
   (`checkTombstoneAttestation({ incomingKey: gitIncomingKey(opts.incoming), … })`,
   `follow.ts:779-782` and `:995-998`). This is the load-bearing constraint, not the
   bundle.
3. **Tombstone authorship on held refs.** The carry is *exempt* from
   `normalizePublishedGitSection`; a merged section is not, so it runs the supersession
   authoring loop at `publisher-tombstones.ts:108-122`, which mints a tombstone for every
   advertised head whose candidate value differs. For a **held** ref the merged value is
   another writer's pending value, not something this device superseded. Authoring a
   tombstone there would claim a supersession this device never performed and would
   advance the repository high-water mark on someone else's behalf — 174-I3's hazard.
   **Held refs must be structurally excluded from tombstone authorship**, not merely
   expected not to differ.
4. **Per-ref omission needs the per-ref receipt.** A merged section publishes local values
   ref by ref, so a ref that is locally absent is *omitted* ref by ref. Omission alone has
   never been deletion authority (§8 item 3), and at per-ref granularity the failure is
   worse than the whole-section version 174 R1 caught, because it no longer looks like a
   section swap anyone would inspect. P1b's receipt rule is what makes a per-ref omission
   legitimate. This is an ordering constraint, not a caveat — see below.
5. **ACK convergence.** `pendingSupersessionAckConverges` (`pending-supersession.ts:35-62`)
   requires the composed BASE to deep-equal the candidate. BASE composition has to accept
   the merged shape — held refs at their pending values, everything else at local — or
   every merged section refuses its own dry-run and carries forever, which is the wedge
   again with extra steps.

**Ordering constraints.** §3.6 already establishes one: P1b's receipt must be committed
*before* capture, or the ACK dry-run refuses the omitting candidate. P4's are analogous
and are stated with the same force.

- **P1 + P1b must land before P4.** Constraint 4 above. Without the receipt rule, the
  per-ref lane manufactures exactly the deletion-by-omission that §8 item 3 rejects, at a
  granularity that makes it harder to see. This inverts v1's landing order, which shipped
  the authority change last.
- **P2 must land before P4.** P4 composes over "the set of held refs". If
  `apply.ts:1447-1450` still promotes any held ref to a repository-wide pending disposition,
  that set is either empty or everything, and there is nothing to merge. P2's "no whole-repo
  escalation for a non-HEAD ref" is what produces the per-ref hold set P4 consumes.
- **P3 is independent, but should land before P4 anyway.** Content equivalence only turns
  `would-drop` into `proven` inside `noDropProof`; it changes which refs are held, never how
  the section is composed. Landing it first *shrinks* the held set on the founder's machine
  (four of ten worktree branches, §1.1), which makes P4's first real exposure smaller. That
  is a validation argument, not a correctness one.
- **Inside P4, bundle coverage and key derivation precede the merged emit.** Sub-step 4a:
  pin held pending tips into the capture, decide and migrate the `gitIncomingKey` story,
  and structurally exclude held refs from tombstone authorship — all provable without
  emitting a single merged section. Sub-step 4b: actually emit `pending ⊕ local`. Emitting
  first and fixing the key afterwards silently orphans in-flight partial progress on the
  first merged push, and that is not observable until someone is already wedged.

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
- the repository is not deferred, capture is not gagged, and the follow is skipped on
  subsequent cycles until the worktree registry actually changes;
- the four squash-merged branches stop counting as endangered local work, so the
  `noDropProof` fixpoint stops cascading holds onto unrelated refs;
- the phantom ref is captured as an absence within one cycle and the wedge clears itself.

P4 then closes the remaining gap: while any of those holds is outstanding, the repository's
*outgoing* section stops being frozen at the incoming value and publishes local work for
every ref that is not held. P1–P3 clear both field wedges; P4 is what stops the class from
re-forming the next time an agent leaves a worktree behind.

## 5. The self-healing contract

**Becomes automatic — no human, no `rbox git resolve`:**

| Situation | New behavior |
|---|---|
| Published branch deleted locally (`git branch -D`, `git worktree remove`, agent cleanup) | Absence receipt written, BASE retired, deletion published as a tombstone, `pending` superseded. One bounded log line. |
| `pending` carried on a ref the local repository no longer has | Supersedes as soon as the absence receipt exists. |
| Abandoned worktree holding a branch | Per-ref hold only; the repository keeps syncing; the follow is held-skipped until the worktree registry changes. |
| Squash-merged branch classified as endangered local work | Recognized as content-preserved; stops forcing holds on other refs. |
| Stale positive BASE member left by a *past* deletion (the latent wedge, §2.3) | Reconciled on the next cycle, before it can arm. |

**Still needs a human, and should say so loudly:**

| Situation | Why | What rbox should say |
|---|---|---|
| Circuit breaker trips (§3.5) | Mass absence is indistinguishable from a replaced repository, and the wrong guess is fleet-wide deletion. | Name the count and repository; point at `rbox git resolve <repo> show-me`. |
| A worktree holds a ref the incoming section wants to move | Git's own hazard; rbox must never move a branch under a live worktree. | Name the branch. **Not the worktree's absolute path — not yet** (§5.1). Today the message carries `path.basename(e.path)` (`apply.ts:118`); the actionable path goes in `rbox doctor` instead. |
| Genuine two-sided divergence on a branch | Unchanged; rbox does not pick a side. | Unchanged (`resolve-command.ts:672-677`). |
| Local commits whose content is *not* preserved anywhere | Unchanged; this is real work. | Unchanged. |

### 5.1 Surfaces — RULED 2026-07-24

**`rbox doctor` gains a leftover-worktree section. Deferral messages do not print absolute
worktree paths yet.** Two decisions, one shared reason.

**Doctor: yes.** A section listing leftover linked worktrees — count, and per entry the
branch, the **full absolute path**, `prunable`, and whether it currently holds a synced ref.
Ten accumulated silently on the founder's Mac and the first signal was a sync deferral.
`path.basename(e.path)` alone (`apply.ts:118`) is useless at that scale precisely because
the founder's worktrees are all *named after their branches* — the basename repeats the one
field the message already prints. `rbox doctor` runs locally on the machine that owns those
paths, so a full path there reveals nothing the operator does not already have.

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
| P1 absence capture, positive case | One prepared ref transaction + one state CAS per deleted branch — the same shape as any other branch transition. | Tens of ms, once per deletion, not per cycle. |
| P1b pending pre-probe | Today's loop plus one artifact-disposition lookup per missing head. | Unmeasurable. |
| P3 content equivalence | Runs **only** on tips the ancestry proof already rejected — normally 0 per cycle. Per probe: 1 `merge-base` + 1 `diff-tree｜patch-id` + 1 walk of `base..D` capped at 5,000 commits. Cached on immutable `(T, D)`. | Cold worst case (all ~203 heads unowned, e.g. first sync of a heavily squashed workspace): ~600 spawns ≈ 6–12 s **once**. Steady state ≈ 0. |
| P2 held-skip for `worktree-ownership` | One extra `git worktree list --porcelain` per repository per cycle for the digest. | **Removes** a full follow per cycle for every ownership-held repository — on the observed data, roughly the whole 9 s p95 for `Personal/rbox-core`. |
| **P4 per-ref pending lane** | **Positive cost, and the only one here.** Today a held repository republishes the carried pending section *by identity* — `normalizeOutgoingGitSections` reuses `pendingSection` unparsed when the incoming keys match (`publisher-tombstones.ts:184-187`), so it re-advertises the same `bundleEncSha` and uploads **nothing**. A merged section is a new section, so every cycle with an outstanding hold now runs an ordinary capture: bundle build, encrypt, upload. | Incremental, so the increment is the local delta plus the pinned held tips, not a full repack — `capturePlannedGitSection` reuses the pack chain until `exceedsPackChainByteBound` forces recompaction (`shared.ts:236-249`). Order of a normal capture for that repository, once per cycle, for as long as the hold lasts. |

**Net, restated for v2.** P1–P3 are net negative, and the only new per-cycle work among
them is a hash of a `git worktree list` output the follow already spawns five times.
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

1. **Positive BASE provenance implies prior physical presence.** A `refs/heads/*` member
   of BASE carrying a usable current-lineage origin was physically held by this device at
   that OID. *(Today emergent from `base-composer.ts:227-229, 364-367, 418`; now pinned,
   because §3.4 depends on it.)*
2. **A published branch deleted locally is captured, never resurrected.** BASE-positive +
   P-absent + clear artifacts yields a locked absence receipt, never a branch creation.
3. **Absence capture is fail-closed.** Any missing origin, stale lineage, existing A/P/K,
   sibling ownership, busy repository, unreadable identity, or unstable second observation
   leaves the ref untouched.
4. **Mass absence defers to a human.** More than the configured share of a repository's
   positive BASE heads vanishing at once captures none of them.
5. **Content equivalence waives holds, never authorizes deletion.** A patch-id match may
   only convert `would-drop` to `proven`; deletion authority remains tombstone attestation
   or an absence receipt.
6. **A pending section is superseded only against a proved candidate.** Supersession
   requires either local presence at an equal-or-descendant OID or a durable absence
   receipt for every pending head — never mere omission. *(Pins
   `REVIEW-174-R1-OPUS-B.md:14`'s resolution, which is currently unpinned in
   `INVARIANTS.md`.)*
7. **Worktree ownership is observed regardless of containment.** Sibling worktrees outside
   the workspace still hold their refs; containment affects only reporting.
8. **A published deletion stays recoverable for a bounded window.** Every device that
   prunes a branch under tombstone authority pins the tombstoned tip for
   `TOMBSTONE_PIN_RETENTION_MS`, and pins every other reflog OID for that branch
   permanently. Publishing a deletion may never be the act that destroys the last copy of
   the objects. *(This is the condition §12 Q3's ruling rests on; §7.1 states it in full,
   including where it does not hold.)*
9. **Held refs are published, never superseded.** In a `pending ⊕ local` outgoing section
   (P4), a held ref carries its pending value verbatim and is excluded from tombstone
   authorship. Composing a section is never authority over a ref this device does not hold.

"Branch equality is not deletion authority" (since 130) remains true and unweakened: a
local-absence receipt is not equality, it is a locked proof of physical absence against
positive provenance. `follow.ts:894-895` keeps holding; it simply stops being reachable
for refs absence capture has already reconciled.

### 7.1 The recoverability window — the condition on the "no safety pin" ruling

§12 Q3 was ruled **no pin, conditional on tombstone recoverability being stated first**.
The condition is real: §3.4's argument for skipping the pin is "the fleet still holds the
objects", and if that stops being true the last machine to sync destroys the only copy.
This section states what is recoverable, from where, by what command, and for how long —
verified against the code, including the two places the premise does not hold.

**The mechanism is the keep-pin, not the tombstone record.** This distinction matters and
the ruling's phrasing elides it. A `GitRefTombstone` is `{ oid, ts, generation }`
(`src/engine/types.ts:71-75`) — **metadata only**. `REF_TOMBSTONE_RETENTION_MS`
(`publisher-tombstones.ts:10`, 90 days), enforced as an expiry cutoff at `:125-136`,
retains the *OID*. It does not retain a single Git object. "Recoverable via the tombstone
retention" is true only because a **second, deliberately equal-valued** retention governs
the objects:

```ts
export const TOMBSTONE_PIN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;   // keep-pins.ts:68
export const REF_TOMBSTONE_RETENTION_MS  = 90 * 24 * 60 * 60 * 1_000;  // publisher-tombstones.ts:10
```

**What is recoverable, and from where.** When a follower prunes branch `R` because a
tombstone authorized it, `follow.ts:947-949` calls `prepareTombstonePrunePins`
(`keep-pins.ts:635-654`), whose transaction lines are spliced into the *same* ref
transaction as the prune (`follow.ts:962`, `:974`/`:985` → `extraTransactionLines`). That
call creates, under `refs/rbox-local/keep/<oid>` (`keep-pins.ts:66`):

- the **exact tombstone-authorized tip** — pinned with a `class:"tombstone"` origin, aged
  out after 90 days (`keep-pins.ts:646`, expiry at `:116-124`); and
- **every other OID in that branch's reflog** — pinned with a `class:"human"` origin,
  which ageing never touches (`keep-pins.ts:647`, and `expireTombstonePinOrigins` filters
  only `entry.class === "tombstone"`, `:119-120`).

So the recoverable thing is a real Git object, reachable by a real ref, on **every device
in the fleet that pruned the branch**. The prune is what creates the pin — a device that
never had the branch has nothing to pin and nothing to lose.

**By what command.** The keep-pin ref *names the OID*, so no state-file archaeology is
needed. On any device that pruned it:

```sh
# X is the tombstoned OID: read it from `rbox git resolve <repo> show-me`, or from the
# still-published tombstone chain (same 90-day window), or from the A artifact's payload.
git -C <repo> branch <name> refs/rbox-local/keep/<X>
```

That is a plain Git command against a plain Git ref, which is the point: recovery does not
depend on an rbox verb that does not exist.

**Where the window does not hold.** Three gaps. None of them invalidates the ruling, but
the ruling's premise is narrower than its phrasing, and the difference should not be
papered over.

1. **The deleting device pins nothing.** The A artifact does *not* pin the tip. It writes a
   canonical blob holding `{ lineageHash, priorOid, ref, repositoryIdentityHash, v:2 }` and
   points `refs/rbox-local/base-absent/v2/<lineage>/<refHash>` at **that blob**
   (`base-artifacts.ts:145-149`, `:218-224`) — it records the OID as *text*, and nothing
   keeps the commit reachable. Contrast the P artifact, which creates genuine keep-refs
   directly at `priorOid` and `nextOid` (`basePresentKeepRef`, `base-artifacts.ts:114-118`,
   spliced at `:237-244`). This asymmetry is deliberate and it is exactly what §8 item 10
   proposed changing. **Consequence: recoverability is a fleet property, not a local one.**
   On the machine that ran `git branch -D`, the objects are unreachable and `git gc` will
   prune them on its own schedule. §3.4 already concedes this ("the local side is already
   lost: Git deleted the ref *and* its reflog before rbox ever ran"), and it is consistent
   — rbox is mirroring an accomplished fact — but it means the answer to "can I get it
   back?" is always "from another machine", never "from here".
2. **A single-device workspace has no fleet.** If no other device ever applies the section,
   no device ever prunes, so no tombstone keep-pin is ever created. Combined with gap 1,
   a published deletion on a one-device account is recoverable only until that device's
   next `git gc`. This is the one case where the ruling's premise is simply false, and it
   is called out as still-open in §12 Q3.
3. **The 90-day bound is currently a ceiling, not an enforced window.**
   `expireTombstoneKeepPins` (`keep-pins.ts:434-457`) is exported through
   `src/engine/index.ts:284` but has **no production caller** — the only reference outside
   its own definition is `keep-pins.test.ts:166`. Tombstone pins are therefore created and
   never aged out today. That errs toward over-retention, so it is safe for this ruling;
   but the design must not claim an *enforced* 90-day window while nothing enforces it,
   and whoever wires the expiry later is turning a currently-unbounded guarantee into a
   90-day one. That is a behaviour change and needs to be reasoned about as one.

**Not a recovery path (checked, and recorded so nobody re-derives it).** The objects also
survive server-side inside historical versions' Git bundle blobs: GC reachability is
computed from the DO's *retained* roots, not just the head (`gc-phase1.ts:44-58`,
`reachableFromWorkspaces`, `versions.ts:66+`), and history pruning is globally disabled
(`retention.ts:36`). But this is not usable as a recovery story. The retention window is
the account's plan window — 30 / 90 / 365 days by tier (`plans.ts:24-27`) — which is not
90 and is not coupled to either tombstone constant; and, decisively, **there is no command
that restores a Git ref from a historical version.** `rbox restore <file>@<seq>` is
file-plane only (`help-registry.ts:322-330`). The server copy is a backstop against total
loss, not an operator-reachable recovery path.

**Conclusion.** The condition holds for the multi-device case, by a mechanism whose
retention constant was deliberately set equal to the tombstone's, with a one-line plain-Git
recovery command. **No pin is added.** The residual single-device gap is recorded as open
in §12 Q3 rather than silently absorbed.

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
   result is the wedge in §1.2. A better refusal message is still worth having for the
   circuit-breaker case.
10. **Pin every auto-captured deletion under a recovery ref.** **RULED 2026-07-24 —
    rejected, conditionally, and the condition was checked (§7.1).** The proposal was to
    pin `X` before retiring BASE, reusing design 116's keep-pin machinery — i.e. to give
    the A artifact the keep-refs the P artifact already has (`basePresentKeepRef`,
    `base-artifacts.ts:114-118`, `:237-244`). It is rejected because at ~10 deleted
    branches/day it accumulates refs and holds objects on the founder's own machine
    indefinitely, and because the local reflog is already gone by the time rbox looks — the
    pin would preserve one OID rbox learned from BASE, not the branch's history.
    The founder ruled "no pin" **conditional on published deletions remaining recoverable**.
    That condition is verified in §7.1: they are, via the tombstone keep-pin
    (`TOMBSTONE_PIN_RETENTION_MS`, 90 days, deliberately equal to
    `REF_TOMBSTONE_RETENTION_MS`) on every device that prunes the branch, recoverable with
    `git branch <name> refs/rbox-local/keep/<X>`. **It does not hold on a single-device
    workspace**, which §12 Q3 keeps open.

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
  deferral.
- Assert the **ordering** requirement of §3.6 explicitly: with the A artifact suppressed,
  the dry-run must still refuse the omitting candidate.

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
  content matches but under `GIT_NO_REPLACE_OBJECTS=0`-style object replacement.
- Bound: a fork point beyond the walk cap returns `would-drop`, asserted by injecting a
  low cap rather than building a 5,000-commit fixture.
- Structural test (in the spirit of `base-composer-structure.test.ts`): the
  `content-equivalent` marker never appears on any deletion-authority path.

### 9.2 Adversarial table

Table-driven, in the shape of `tombstone-attestation.test.ts:66-83`. Absence capture must
**not** fire when any single one of these holds, with everything else valid: existing A;
existing Z / settled absence; existing P/K; foreign artifact; sibling worktree owns the
ref; receiver-equivalent collision group; origin missing; origin OID mismatched; origin
lineage stale; `git` busy; preflight failure; repository identity changed; ref absent at
plan time but present at the locked second proof; circuit breaker tripped. Each case
asserts BASE unchanged, no artifact written, no wire tombstone authored.

### 9.3 Multi-writer

Reproduce the §3.4 interleaving as a test: W1 publishes `R = X`; W2 advances `R = Y` and
publishes; W1 deletes `R` locally and absence-captures. Assert W1's tombstone chain covers
`X` only, W2 **holds** `R` at `Y` rather than pruning, and W1 subsequently re-creates `R`
at `Y` through the ordinary creation path.

### 9.4 Circuit breaker

Delete `K+1` BASE-positive heads at once; assert zero captures, one deferral with the new
reason, one bounded log line, and that a single subsequent deletion (after the mass state
is resolved) captures normally.

### 9.5 Per-ref pending lane (P4)

New in v2, because P4 was a non-goal when §9 was written. Each item maps to one of §4.4's
five entanglements, so a missing test is visible as a missing row.

- **Bundle coverage.** Compose `pending ⊕ local` where held ref `H` sits at a pending OID
  this device holds in no publishable ref. Assert the emitted section's bundle *contains*
  that tip — by importing the published section into a fresh clone and resolving `H` —
  and assert it still contains it when the apply-time `refs/rbox-incoming/*` namespace has
  already been torn down (`apply.ts:335-339`). This is the test that fails if the
  implementation borrows the incoming namespace instead of pinning at capture.
- **`gitIncomingKey` migration.** Assert that emitting a merged section does not orphan
  in-flight state: a repository with a recorded `GitHeldAttempt`
  (`sync-state-model.ts:228-245`), a `partial` record and a deferral episode must still
  resolve all three after the first merged emit. Whichever story §4.4 constraint 2 chooses
  — stable derivation or deliberate invalidation — the test asserts the *chosen* one
  explicitly rather than whatever falls out.
- **No tombstone authorship on held refs.** Merge a section where a held ref's pending
  value differs from this device's `advertised` value. Assert `refTombstones` gains **no**
  entry for that ref and `refTombstoneGeneration` does not advance on its account. Pair it
  with a structural test in the spirit of `base-composer-structure.test.ts`: the held-ref
  set and the supersession-authoring loop (`publisher-tombstones.ts:108-122`) cannot both
  claim the same ref.
- **Per-ref omission still needs a receipt.** With `RBOX_GIT_ABSENCE_CAPTURE=0` (P1b
  disabled) and P4 enabled, a locally-absent BASE-positive head must be **carried, not
  omitted**, from the merged section. This is the regression test for §4.4's ordering
  constraint — it is the one that fails loudly if P4 ever ships ahead of P1b.
- **ACK convergence on a merged shape.** `pendingSupersessionAckConverges` must return
  true for a merged candidate whose held refs sit at pending values and whose remaining
  refs sit at local values, and false if any held ref was silently taken from local.
- **Ordering/regression pair.** Assert today's byte-for-byte carry is still taken when the
  repository has **no** held refs (`publisher-tombstones.ts:184-187` reuse path), so P4
  narrows the carry rather than replacing it.

### 9.6 Surfaces and rig

- Doctor redaction grammar: extend `src/cli/design176-grammar-freeze.test.ts` for the new
  log lines so `redactGitLogLines` (`doctor-cmd.ts:171-215`) still recognizes and rewrites
  them. The grammar freeze is the *only* thing keeping free-text details out of an
  uploaded report (§5.1), so a new line that misses the `git-sync ` prefix is a privacy
  regression, not a cosmetic one — assert the new lines round-trip to closed enums.
- `rbox doctor` leftover-worktree section: assert it lists absolute paths locally, and
  assert those paths do **not** appear in the uploaded projection.
- `rbox git deferrals` / `rbox status`: the new circuit-breaker reason needs a
  `DEFERRAL_REASON_PRESENTATION` entry (`status-view.ts:287-305`) and a rank in
  `GIT_DEFERRAL_REASON_PRECEDENCE` (`sync-state-model.ts:149-153`; the compile-time
  totality proof at `:155-158` forces this).
- `bun run rig`: two devices; device A holds a worktree on branch `B`, deletes a
  squash-merged branch `C` while the hold is outstanding, then removes the worktree.
  Assert both devices converge with **no** `rbox git resolve`, that `C` is gone everywhere,
  and that `B` and all unrelated work are intact. **With P4**, extend it: while the hold on
  `B` is outstanding, device A commits to an unrelated branch `D` and asserts `D` reaches
  device B *before* the hold clears — that is the behaviour P4 exists to produce and the
  rig is the only place it is observable end to end.
- **Recoverability (§7.1), asserted rather than assumed.** After device B prunes `C` under
  the tombstone, assert `refs/rbox-local/keep/<X>` exists on B, that
  `git branch c-recovered refs/rbox-local/keep/<X>` restores the branch at exactly `X`, and
  that the pin's origin class is `tombstone` for the authorized tip and `human` for the
  rest of `C`'s reflog. This is the test that turns §12 Q3's ruling condition from prose
  into a gate.
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

## 11. Rollout

Default-ON with kill switches, following the founder's standing rule and the existing
`gitPendingSupersedeEnabled` pattern (`pending-supersession.ts:26-27`) — with **one
deliberate exception**, P4, argued below.

| Switch | Default | Disables |
|---|---|---|
| `RBOX_GIT_ABSENCE_CAPTURE=0` | on | P1 + P1b (falls back to today's carry/refuse) |
| `RBOX_GIT_CONTENT_EQUIV=0` | on | P3 (falls back to ancestry-only) |
| `RBOX_GIT_OWNERSHIP_HELD_SKIP=0` | on | P2 held-skip eligibility |
| `RBOX_GIT_PENDING_MERGE=1` | **off, then on at bake** | P4 `pending ⊕ local` (falls back to today's whole-section carry) |

**Landing order — revised in v2, and inverted from v1.** v1 shipped the authority change
(P1 + P1b) last, on the reasoning that it was the riskiest. With P4 in scope that ordering
is not merely suboptimal, it is **unsafe**: §4.4 establishes that P4's per-ref omission is
only legitimate because P1b's receipt rule exists, so P1b must precede P4, and P2 must
precede both because it is what produces a per-ref hold set at all. Each step remains
independently shippable and independently revertible.

1. **P2 + reporting.** Held-skip eligibility with the worktree digest, no whole-repo
   escalation for non-HEAD holds, `rbox doctor` leftover-worktree section (absolute paths
   local-only, §5.1). No authority change; pure performance and UX. *Precondition for
   steps 3 and 4.*
2. **P3.** Content equivalence in `noDropProof`. Waives holds only; cannot delete anything.
   Independent of the rest; landed here because it shrinks the held set P4 will first be
   exposed to.
3. **P1 + P1b.** The authority change. Validated on a dev build against the live wedge
   before any CLI release. *Precondition for step 4 — see §4.4.*
4. **P4, in two sub-steps.**
   - **4a — no behaviour change.** Pin held pending tips into the capture's scratch-pin set,
     settle and migrate the `gitIncomingKey` story, structurally exclude held refs from
     tombstone authorship. All of it provable by §9.5's tests without emitting a single
     merged section.
   - **4b — the merged emit.** Turn on `pending ⊕ local`. This is the only step in the
     design that changes what a device publishes for refs it is not authoritative over.

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
4. No `gitIncomingKey`-bound state (partial progress, deferral episodes, held attempts)
   observed orphaned across the first merged emit.

Steps 1–3 do **not** wait on this; they ship default-on as v1 planned.

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

All six of v1's open questions were ruled by the founder on **2026-07-24**. They are kept
here as a decision record rather than deleted; the questions are stated as they were asked,
followed by the ruling and its reasoning. Anything still genuinely open is marked
**STILL OPEN** and is the only thing in this section that needs another answer.

**1. Publish the deletion, or re-materialize the branch from the fleet?**
*RULED 2026-07-24 — **publish**.* This confirms the design's own recommendation, so nothing
changed except its status: it is now a stated decision in the body (**§3.0**) rather than a
question, because §3.1–§3.6, §4.4, §5 and §7 all rest on it. The semantic is explicit:
**deleting a branch on one machine removes it fleet-wide; `git branch -D` means what it says
inside a synced workspace.** The rejected alternative (retire BASE locally, let the remote
re-create the branch) is non-destructive and wrong — it makes branch deletion a permanent
no-op on every synced machine, and the founder's development loop's last step is exactly
branch deletion. §3.0 records the three consequences that follow: deletion is authoritative
and therefore must be receipted; receivers still hold a veto; and the objects must survive
the prune for a bounded window (§7.1).

**2. Circuit-breaker shape and thresholds.**
*RULED 2026-07-24 — **defer at `max(K = 25, F = 0.25)`**.* Both legs, not one. Tripping
**defers** the repository; it does not merely warn and proceed. Recorded in **§3.5** with
the arithmetic and the precedent.
The precedent is worth stating carefully because the ruling's framing attributed it to the
wrong design and the numbers to the wrong guard. rbox runs two file-plane mass-delete
guards: design **44**'s pull-side guard trips at `deletes ≥ 100 ∧ deletes·2 ≥ baseFiles`
(≥ 100 files **and** ≥ half the tree — `policy.ts:11-15`, `pull.ts:276`), and design **108**'s
push-side breaker trips at `max(20%, 1000)` (`pushMassDeleteTrips`, `policy.ts:22-35`,
`push.ts:701`; framing at `docs/design/108-scan-fault-isolation.md:79-88`). **The
`max(fraction, floor)` shape this design copies is 108's, not 44's** — 44's is an absolute
floor ANDed with a *half*-the-tree fraction. The "fails closed until a human says otherwise"
phrasing is verbatim from the comment on 44's constant (`policy.ts:14`) and is true of both.
108 is also the better precedent on the merits: it guards the *publishing* side, refusing
before any encrypt/upload/commit work, which is structurally what absence capture must do.
The ruled numbers stand — `25` and `0.25` are 108's shape rescaled from file counts in the
hundred-thousands to ref counts in the hundreds (§3.5).

**3. Safety pin for auto-captured deletions?**
*RULED 2026-07-24 — **no pin**, conditional on tombstone recoverability being stated first.*
The pin is rejected in **§8 item 10**; the condition is discharged in **§7.1**, which was
written for this ruling and verified against the code.
**The condition holds for the multi-device case, but not by the mechanism the ruling names,
and not universally.** A tombstone is `{oid, ts, generation}` — metadata only
(`types.ts:71-75`); `REF_TOMBSTONE_RETENTION_MS` retains the *OID*, not one Git object. What
actually retains the objects is a second, deliberately equal-valued constant:
`TOMBSTONE_PIN_RETENTION_MS = 90 days` (`keep-pins.ts:68`). Every device that prunes the
branch under tombstone authority pins the authorized tip at
`refs/rbox-local/keep/<X>` for that window and pins the rest of the branch's reflog
*permanently* (`follow.ts:947-949` → `keep-pins.ts:635-654`). Recovery is
`git branch <name> refs/rbox-local/keep/<X>` on any such device. Three caveats, all in §7.1:
the deleting device pins nothing (the A artifact records the prior OID as blob *text*, it
does not pin the commit — `base-artifacts.ts:145-149`, `:218-224`); the 90-day bound is
currently a ceiling rather than an enforced window, because `expireTombstoneKeepPins` has no
production caller (`keep-pins.ts:434`, referenced only from `index.ts:284` and its own test);
and:

> **STILL OPEN — 3a. Single-device workspaces.** The ruling's premise ("the fleet still
> holds the objects") requires a fleet. On a one-device account no other device ever prunes,
> so no tombstone keep-pin is ever created, and — because the deleting device pins nothing —
> a published deletion is recoverable only until that device's next `git gc`. This is the
> one case where the premise is false. Options: (i) accept it, on the grounds that a
> one-device workspace has no sync partner to lose work to and `git branch -D` on an
> unsynced repository behaves identically; (ii) pin only when the account has one device,
> which is the cheap case precisely because there is no ~10-branches/day fleet churn to
> accumulate; (iii) pin always, i.e. reverse the ruling. **Recommendation: (ii)** — it costs
> nothing in the case the founder actually runs and closes the only real hole.

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
  dry-run refuses". P2 must precede both, because it is what produces a per-ref hold set to
  merge over at all. P3 is independent but is landed early because it shrinks P4's first
  exposure.
- **The cost analysis no longer nets negative.** v1's "net cost is negative" was written
  assuming P4 was deferred. P4 replaces a carry that re-advertises the same bundle and
  uploads nothing (`publisher-tombstones.ts:184-187`) with an ordinary capture per cycle
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
