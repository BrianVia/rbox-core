# 200 — Worktree lifecycle resilience: capturing out-of-band branch deletion

Status: DESIGN v3 — 2026-07-24. Codex round 1 returned **NOT-ALIGNED, 7 blockers + 4 majors**;
all eleven are folded in (§13), together with three further founder rulings (R1–R3, §12).
Author: Claude, from first-hand field forensics on the founder's Mac, 2026-07-24.

Changes in v3 — the eight that change what gets built:

1. **The mass-deletion breaker was arithmetically broken and is now `OR`** (R1, §3.5).
   `max(25, ceil(0.25·N))` is a *conjunction*, so it cannot trip at all below 25 heads and
   its fraction leg is inert below 100 — which covers nearly every repository in the
   workspace. Deleting all 24 heads of a 24-head repository did not trip it. The
   counterexample is recorded so nobody re-derives the broken form. One residual small-repo
   hair-trigger is **STILL OPEN (Q2b)**.
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
suffer today. **P1 does carry one standing cost** — R3's 90-day recovery pins, ~900 hidden
refs at steady state on the founder's observed deletion rate, holding their objects against
`git gc` (§3.7). The founder accepted it explicitly; §11 measures it rather than assuming it.
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
   absence receipt is a locked A artifact and not a BASE edit, why §3.3's witness has
   seven conditions, and why §3.5's circuit breaker exists.
2. **Receivers still hold a veto.** "Removes it fleet-wide" is the *intent* of the
   published tombstone, not an instruction receivers must obey. A follower that has
   advanced the branch beyond the tombstoned OID holds instead of pruning (§3.4). Fleet
   authority is *the deleting device's own history*, never another device's.
3. **The objects survive the deletion for a bounded window, on the device that published
   it.** Publishing a deletion is only acceptable because the branch tip stays recoverable
   afterwards. v2 rested that on followers pinning during their prune; ruling **R3**
   (2026-07-24) replaced it with a pin on the *deleting* device, because the follower path
   produces nothing whenever nobody prunes. Specified in **§3.7**, with the rejected
   premise kept as rationale in §7.1 and the recovery command in §7.2.

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
   `130:214-234`). This is the load-bearing one — see §3.4. Under P4 it additionally
   requires that the origin was minted from a value this device *captured*, not one it
   *carried*; that is what §4.4 constraint 6 exists to guarantee.
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
7. The repository-level circuit breaker (§3.5) has not tripped.
8. **`R` is not the current HEAD symref target.** New in v3 — see §3.3b.
9. **No ref-database regression signal is present.** New in v3 — see §3.3b.

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

- `gitRaw(repoDir, ["show-ref"])` resolves → parse exactly as `readAllRefs` does.
- rejects with `code === 1` **and empty stderr** → `{ status: "ok", refs: {} }`. Both
  conditions, because exit 1 *with* stderr is not the documented no-match case.
- every other rejection → `{ status: "unreadable", marker }`, with `marker` derived from
  the exit code, never from the message text.

`gitRaw` already attaches the exit status: it rejects with
`Object.assign(new Error(stderr || …), { code: exitCode })` (`shared.ts:177`). **The
codebase already contains this exact pattern**, so this is a transposition rather than an
invention: `readLocalGitConfigEntries` (`shared.ts:261-268`) catches only `code === 1`
("Git's documented no-match result; every other subprocess failure remains loud") and
rethrows everything else.

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
capture for the whole repository for that cycle, records an `apply` deferral under the
same reason the circuit breaker uses, and emits one bounded line. It never degrades to
"assume no refs".

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
repository, and a restore that lost `refs/` while keeping `HEAD` all produce it. Rule 8 is
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

**(iii) The honest limit.** Neither signal is a proof, and a sufficiently careful restore
defeats both. **The actual protection against restore is the circuit breaker** (§3.5) —
mass simultaneous absence with the repository otherwise intact *is* the restore signature.
R1's `OR` form is what makes that protection real: under v2's `max()` form a 24-head
repository could be restored and publish all 24 deletions without tripping. The two
signals above exist to shrink the residual window in the 5–19-head range that Q2b's
proposed `heads ≥ 20` guard would otherwise leave uncovered, and they should be
understood as that and nothing more.

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

Therefore **BASE-positive + P-absent + no A/Z + valid lineage ⇒ this device held `R` at `X`
and no longer does.** It cannot mean "never delivered here": a ref that never arrived was
never in this device's BASE with a usable origin. That is the discriminator, and it is
checkable locally with no new provenance and no new wire field.

**Two things v2 asserted here that are not true, and are now handled elsewhere.**

- **The invariant proves historical possession, not the cause of the current absence.**
  "Held it, doesn't now" is compatible with deletion *and* with a restored ref database
  (§3.3b) *and* with an unborn-branch HEAD (§3.3b (i)). §3.3's rules 8 and 9 and §3.5's
  breaker are what narrow it to deletion; this section no longer claims to.
- **The invariant is not self-maintaining under P4.** `publisher-ack` mints an origin
  whenever the acked value equals the *advertised* value (`base-composer.ts:356-367`), and
  the advertised set today is the whole committed section (`push.ts:971`,
  `advertisedRefs: section.refs`). A merged `pending ⊕ local` section contains held refs at
  values this device never held, so shipping P4 without §4.4 constraint 6 would make this
  invariant false and hand P1 forged evidence. The invariant survives only because the ACK
  authority is being made held-ref-aware in the same design.

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
- **The objects survive the prune, on the deleting device itself, for 90 days.** Absence
  capture pins `X` under `refs/rbox-local/keep/<X>` with a `tombstone`-class origin, in the
  same ref transaction that writes the A artifact and strictly before BASE is retired
  (**§3.7**, ruling R3). Followers that prune under tombstone authority pin it too, as they
  already do. v2 rested this bullet entirely on the *follower* pin and was wrong to: that
  path produces nothing when no device prunes, which is a large and ordinary class of
  cases (§7.1). It is not optional to the argument — without a pin somewhere, the deletion
  can be the act that destroys the last copy.
- The alternative (resurrection) is strictly worse and re-opens
  `REVIEW-174-R1-OPUS-B.md:14`.

### 3.5 The circuit breaker — where a human is genuinely required

The one shape that must not auto-publish is "the repository was replaced": a restore from
backup, a `.git` swapped in place, a clone that lost its refs. §3.3b establishes that
identity and lineage binding do **not** catch it, so this breaker is not a backstop — it
is the primary detector.

**Rule — RULED 2026-07-24 (R1), superseding v2's `max()` form.** Per repository, per
cycle: let `n` be the number of BASE-positive heads that would be absence-captured and `N`
the number of BASE-positive heads. If

```
n >= K   OR   n * 100 >= P * N          // K = 25, P = 25 (i.e. 25%)
```

capture **none** of them, record an `apply` deferral under a new dedicated reason, and
print one bounded line naming the count. **Either leg trips it, whichever comes first.**
Tripping DEFERS the repository; it does not warn and proceed. The integer form (`n*100 ≥
P*N`) rather than `n ≥ ceil(F·N)` follows design 108's own "integer-safe" phrasing
(`policy.ts:22-35`) and avoids a float comparison in a safety predicate.

**Why v2's `max(K, ceil(F·N))` was wrong, recorded so nobody re-derives it.** `max` reads
as "both legs must agree", i.e. `n ≥ K ∧ n ≥ ceil(F·N)` — and the conjunction is dominated
by whichever leg is larger. For any repository with `N < K/F = 100` heads, `K = 25` is the
larger leg, so the fraction never contributes anything:

> **Counterexample.** A repository with 24 BASE heads. Delete **all 24**.
> `max(25, ceil(0.25 · 24) = 6) = 25`, and `24 ≥ 25` is **false**. A total wipe of the
> repository's entire ref set does not trip the breaker.

The absolute leg dominates every repository under 100 heads, which is essentially all of
them — the founder's whole Mac carries ~203 heads across 110 repositories (§1). v2's
prose ("the `K` floor exempts small repositories … the `F` leg catches large ones")
described the intent correctly and the arithmetic backwards. Under `OR` the mapping
inverts and is now correct: the **fraction** leg is what protects small repositories from
a proportional wipe, and the **absolute** leg is what caps blast radius in large ones. On
the measured 304-head `Personal/rbox-core`, `OR` trips at `min(25, 76) = 25`.

**Design 108's precedent is `AND`, and this design deliberately departs from it.** Worth
being explicit, because §12 Q2 cited 108 as the shape being copied.
`pushMassDeleteTrips` is `deletes ≥ min ∧ deletes·100 ≥ pct·baseCount` (`policy.ts:22-35`)
— a genuine conjunction, defensible there because `min = 1000` against file counts in the
hundred-thousands leaves the fraction leg dominant for any realistic workspace. Transposed
to ref counts in the *ones to hundreds*, the same conjunction inverts and the floor eats
the fraction. **What this design copies from 108 is its posture** — refuse on the
publishing side, before any encrypt/upload/commit work, fail closed, human consent as the
only override — not its boolean operator.

> **STILL OPEN — 2b. The `OR` form is a hair-trigger on small repositories.** `n ≥ 0.25·N`
> means a 4-head repository trips on **one** deletion and an 8-head repository on **two**.
> The founder's workspace averages ~1.8 BASE heads per repository (203 across 110), so
> taken literally R1 would defer nearly every repository on the first routine
> `git branch -D` — which is the exact loop this design exists to make self-healing.
> **Recommended amendment: gate the fraction leg on `N >= 20`**, so its minimum meaningful
> trip is 5 deletions:
>
> ```
> n >= 25   OR   (N >= 20 && n * 4 >= N)
> ```
>
> This keeps R1's counterexample resolved (24 heads → trips at 6) and keeps small repos
> usable. The cost is a 5–19-head window where neither leg fires on a restore; §3.3b's
> packed-refs and reflog-store signals are what cover it, and they are weaker than a
> breaker. **The rest of this design assumes the guarded form.** If the founder prefers the
> unguarded `OR`, §3.3b's signals become load-bearing rather than supplementary and the
> "no human in the loop" claim of §0 has to be softened for small repositories.

**Precedent.** This is the file plane's shape, scaled for ref counts in the hundreds
rather than file counts in the hundred-thousands. rbox already runs two mass-delete
breakers, and it is worth being precise about which one this copies, because they are
different:

| Guard | Design | Predicate | Where |
|---|---|---|---|
| Pull-side mass-delete guard | 44 | `deletes ≥ 100 ∧ deletes·2 ≥ baseFiles` (i.e. `≥ 100` **and** `≥ 50%`) | `policy.ts:11-15`, applied at `pull.ts:276` |
| Push-side mass-delete breaker | 108 (`docs/design/108-scan-fault-isolation.md:79-88` — note it is that 108, not `108-files-first-publish.md`) | `deletes ≥ min ∧ deletes·100 ≥ pct·baseCount`, defaults `min = 1000`, `pct = 20`; env-overridable via `RBOX_MASS_DELETE_MIN` / `RBOX_MASS_DELETE_PCT`. The design states the intent as `deletes >= max(PCT% of last-synced count, MIN)` and the code as the "integer-safe" two-legged form. | `pushMassDeleteTrips`, `policy.ts:22-35`, applied at `push.ts:701` |

108 is the right precedent for **posture**, not for the predicate: it guards the
*publishing* side, which is what absence capture is — the point where this device's local
observation is about to become everyone else's reality — and `push.ts:694-708` refuses
**before any encrypt/upload/commit work**, exactly as absence capture must refuse before
any A artifact is written or any keep-pin is created. Design 44's is an absolute floor
ANDed with a *half*-the-tree fraction and it guards the receiving side, so it is the wrong
precedent on both counts.

Both file-plane guards fail closed with human consent as the only override — `policy.ts:14`
states it as "fails closed until a human says otherwise", and the daemon deliberately never
consents (`push.ts:698-699`), so a runaway wipe halts background sync instead of publishing
it. **Defer, not warn**, follows directly: a warning that proceeds is a breaker that does
not break. The difference from the file plane is only the override verb — the file plane
has `--allow-mass-delete`; this breaker's escape is `rbox git resolve <repo> show-me`
followed by the existing resolve arms, because the shape it guards is a repository-level
question, not a one-flag consent.

**Why `25` and `25%` and not 108's `1000` and `20%`.** Blast radius per unit. The founder's
whole Mac carries ~203 branch heads across 110 repositories (§1); `Personal/rbox-core`
alone has 304 BASE refs. One branch is a unit of human work, not a byte, so the floor has to
sit near the top of a plausible day's churn — ~10 deleted branches/day observed (§8 item 10)
— and well below a wipe. `K = 25` is ~2.5 days of the founder's observed rate. `P = 25%` is
tighter than 44's 50% and looser than 108's 20% because ref sets are two to three orders of
magnitude smaller than file sets.

Trip points under the recommended guarded `OR` form, for the sizes that actually occur:

| BASE heads `N` | trips at `n` = | governed by |
|---:|---:|---|
| 1–19 | 25 (unreachable — `n ≤ N`) | never trips; §3.3b signals only |
| 20 | 5 | fraction |
| 24 | 6 | fraction (**R1's counterexample, now caught**) |
| 100 | 25 | both, simultaneously |
| 304 (measured) | 25 | absolute |

The `N ≤ 19` row is the Q2b trade-off made visible: those repositories are protected by
provenance, artifacts, HEAD-symref and ref-database checks, but not by a breaker.

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
    (`follower-protocol.ts:61-71`), evaluates §3.3's nine rules, and applies §3.5's breaker.
- **B — Durable receipt, then BASE.** For each surviving candidate, in one prepared
  expected-old ref transaction: the §3.7 keep-pin lines **and** the A artifact. Then, and
  only after that transaction commits, the state CAS retiring `BASE[R]` under the new
  `local-absence` authority. The ordering is the whole safety argument (§3.1, §3.6): a
  durable Git artifact backs the retirement at every instant.
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

### 3.7 The deleting device's recovery pin — RULED 2026-07-24 (R3)

**Ruling: whichever device publishes a deletion also pins the commit locally for 90 days.**
This reverses §8 item 10 and retires §12 Q3a. The founder explicitly accepted the cost.

**Why the old premise failed.** v2 argued no local pin was needed because "the fleet still
holds the objects". That is true only when *some device prunes the branch under tombstone
authority*, because the prune is what calls `prepareTombstonePrunePins`
(`follow.ts:947-949` → `keep-pins.ts:635-654`). It produces nothing in at least four
ordinary situations, and the first three are not exotic:

1. A single-device workspace — no follower, no prune, ever.
2. Both devices delete the branch before either applies the other's tombstone; each side
   then takes the `!oldOid && !newOid` path and prunes nothing.
3. A device that never received the ref has nothing to pin.
4. Every follower is pre-1.6.8 (§3.0): it *holds* rather than pruning, so no pin.

Recovery therefore depended on a coincidence. R3 replaces it with a guarantee on the one
device that is certain to exist: the one that ran `git branch -D`.

**The pin, concretely.** Reuse design 116's machinery unchanged — no new ref namespace, no
new retention constant, no new sidecar format.

| Element | Value |
|---|---|
| Ref | `keepPinRef(X)` = `refs/rbox-local/keep/<X>` (`keep-pins.ts:66`) |
| Origin | `{ ref: R, episode, time, class: "tombstone" }` — the shape `prepareTombstonePrunePins` already writes for the authorized tip (`keep-pins.ts:645`); `KeepPinOrigin` is declared at `keep-pins.ts:47-52` and already carries the branch name and timestamp, which §7.2's listing needs |
| Retention | `TOMBSTONE_PIN_RETENTION_MS` = 90 days (`keep-pins.ts:68`), deliberately equal to `REF_TOMBSTONE_RETENTION_MS` (`publisher-tombstones.ts:10`) |
| Reaper | `expireTombstoneKeepPins` (`keep-pins.ts:434-457`) — see "who calls it" below |

`class: "tombstone"` rather than `"human"` is the decision that makes 90 days mean 90 days:
`expireTombstonePinOrigins` ages only `entry.class === "tombstone"` (`keep-pins.ts:119-120`).
A `human` origin would never expire, which is the accumulation the founder's original
rejection was worried about.

**Placement, and why it is crash-safe.** The pin is created in the **same prepared ref
transaction** as the A artifact, and strictly **before** the BASE retirement CAS —
i.e. inside step B of §3.6a:

1. `prepareKeepPins(repoDir, [X], { ref: R, episode, time, class: "tombstone" })` writes
   the origin sidecar (fsynced) and returns `create refs/rbox-local/keep/<X> <X>` lines.
2. Those lines are passed as `extraTransactionLines` to the absence planner, alongside the
   A artifact's own lines (`branch-transition.ts:217-224` is the absent-branch artifact
   path; `extraTransactionLines` is already the mechanism `prepareTombstonePrunePins` uses
   at `follow.ts:962`). One `runPreparedUpdateRefTransaction` commits both.
3. `commitPlannedBranchTransition` runs the locked second proof (strict ref read, §3.3a;
   ownership; `currentRef === false`, §3.3b).
4. **Only then** the state CAS retires `BASE[R]`.

Crash points, exhaustively:

| Crash after | State | Recovery |
|---|---|---|
| 1, before 2 | origin sidecar names `X`, no pin ref | over-retention only; the existing originless/pinless reconciliation handles it (`keep-pins.ts:425-428`) |
| 2/3, before 4 | pin + A artifact durable, BASE still positive | next cycle re-derives the retirement from the durable A artifact (existing A-recovery path); the pin already exists and `keepPinRef` is content-addressed, so re-creating it is a no-op |
| 4 | converged | — |

**The state that must never exist — BASE retired without a pin — is unreachable**, because
the pin is in the same transaction as the artifact and the retirement is strictly after it.

**The one case where the pin cannot be created, and what happens then.** The branch was
deleted with `git branch -D`; §1.2 verified that both `git rev-parse` and `git reflog` fail
for `R`. The *object* usually still exists — Git only removes unreachable objects at `gc`,
with `gc.pruneExpire` defaulting to two weeks — but not always, and the founder's own
phantom ref is weeks old. `git update-ref` refuses to create a ref pointing at a missing
object, so the pin can fail.

**Decision: probe, proceed without the pin, and record the fact.** Absence capture runs
`git cat-file -e <X>^{commit}` before planning; if the object is gone it skips the pin,
emits a distinct bounded log line, and **still publishes the deletion**. The alternative —
fail closed and refuse the capture — would leave the §1.2 field wedge permanently unfixed,
because that is exactly a weeks-old OID. The cost is honest and bounded: for that ref the
answer to "can I get it back?" is "not from here", which §7.2's listing must say in those
words rather than implying a pin exists. The pin is a *guarantee when the object survives*,
not a resurrection of objects Git already collected.

**Who calls `expireTombstoneKeepPins`.** Today: nobody. It is exported through
`src/engine/index.ts:284` and referenced only by `keep-pins.test.ts:166`. Tombstone pins
are created and never aged, so the 90 days is currently a ceiling, not a window — which
was safe while nothing depended on it and is not acceptable once the design *promises* 90
days and the founder has accepted an accumulation cost priced at that number.

The sweep, specified:

- **Where.** At the end of a repository's **push-lane** work, after a successful capture,
  outside every other lock scope — `expireTombstoneKeepPins` takes its own
  `withRepoProtocolLocks(repoDir, { origins: true })` (`keep-pins.ts:439`) and must not be
  nested inside one.
- **How often.** At most once per repository per 24 h, driven by a `keepPinSweptAt`
  timestamp in the repo record. 110 repositories × one `for-each-ref` over
  `refs/rbox-local/keep/*` per cycle is not affordable; once a day is.
- **Cheap gate first.** Skip entirely when `readKeepPinOrigins` (`keep-pins.ts:400`, one
  file read) shows no `tombstone`-class origin. Most repositories have none.
- **Behaviour change, named as one.** Wiring the reaper converts an existing unbounded
  retention into a 90-day one for pins created by the *follower prune* path as well. That
  is a real change to already-shipped behaviour and it ships under the same kill switch as
  P1 (`RBOX_GIT_ABSENCE_CAPTURE=0` disables the sweep too), so a device that opts out of
  absence capture does not silently start reaping pins it created before the upgrade.

**Cost, accepted by the founder and recorded so it is measurable rather than assumed.** At
the observed ~10 deleted branches/day, ~900 hidden refs at steady state under a 90-day
window, spread across repositories. They are ordinary refs under `refs/rbox-local/keep/`,
so they hold their commits against `git gc` for the window — that is their entire purpose —
and they participate in `git gc`'s reachability walk. §6 carries the line; §11's bake
condition measures it.

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
2. **`gitIncomingKey` stability — DECIDED in v3, not left to the implementation.**
   `130:119-123` is explicit that the carry passes byte-for-byte *precisely* so the key
   does not move, "because normalizing it would change `gitIncomingKey` and orphan partial
   progress and deferral episodes bound to that key". A merged section has a different key
   by construction — `refs`, `bundleSha` and `packChain` all participate
   (`shared.ts:85-103`). v2 said "whichever key story the implementation chooses", which is
   not implementable.

   **The decision: the carried pending section is never rewritten.** `pending[rel]` keeps
   the remote's unapplied section verbatim, exactly as today; the merge produces a
   *separate outgoing* section. Every consumer keyed on the incoming key therefore does not
   move at all, because every one of them is an **apply-lane** record keyed on the
   *pending/incoming* section, never on the outgoing one:

   | Consumer | Key source | Effect of P4 |
   |---|---|---|
   | `GitHeldAttempt.incomingKey` (`sync-state-model.ts:228-245`) | incoming section, set in the apply lane | none |
   | `partial[rel]` | apply lane | none |
   | `setDeferral(rel, "apply", …, incomingKey, …)` (`apply.ts:1447-1450`) | incoming section | none |
   | tombstone attestation binding (`follow.ts:779-782`, `:994-998`) | `gitIncomingKey(opts.incoming)` | none |

   What *does* change is that `normalizeOutgoingGitSections` stops taking the
   reuse-by-identity path (`publisher-tombstones.ts:183-186`: reuse iff
   `gitIncomingKey(pendingSection) === gitIncomingKey(section)`), which is the intended
   behaviour of P4 and not a key migration.

   **Enforced, not assumed:** a structural test asserting that no outgoing merged section's
   `gitIncomingKey` is ever written into `deferrals`, `attempt` or `partial`. If a future
   change binds anything to the outgoing key, that test is the thing that fails.
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

6. **Held-ref-aware ACK authority — new in v3, and the one that protects P1.** This is the
   entanglement v2 missed entirely, and it is the most dangerous of the six because it
   silently falsifies the invariant P1's safety rests on.

   On an accepted push, `push.ts:962-972` mints the `publisher-ack` authority with
   `advertisedRefs: section.refs` — **every** ref in the committed section. `composeRepoBase`
   then mints a `publisher-ack` origin for a ref purely because
   `authority.advertisedRefs[ref] === requested` (`base-composer.ts:356-367`). Under P4 the
   committed section contains held refs at *carried* values this device never physically
   held. Those values would therefore acquire physical-presence provenance — and §3.4's
   invariant, which P1 reads as licence to publish a deletion, becomes false. Excluding held
   refs from tombstone *authorship* (constraint 3) does not touch this: authorship is about
   claiming a supersession, provenance is about claiming possession.

   **The fix: the ACK authority carries the captured set and the carried set separately.**

   ```ts
   { kind: "publisher-ack"; lineageHash; repositoryIdentityHash; incomingKey; sourceSeq;
     advertisedRefs: Readonly<Record<string, string>>;   // captured from THIS device's P
     carriedRefs:    Readonly<Record<string, string>>; } // carried from the pending section
   ```

   - `push.ts` populates `advertisedRefs` with `section.refs` **minus** the held/carried
     refs, and `carriedRefs` with exactly those.
   - `base-composer.ts`'s `publisher-ack` arm gains one rule ahead of the existing ones: if
     `ref ∈ carriedRefs`, then `after = before` and **no origin is minted** — the same
     shape as today's `requested === null` case at `base-composer.ts:356`. BASE keeps its
     prior value and prior origin for that ref. No hold code: carrying is legitimate, not a
     mismatch.
   - The authority is rejected outright unless `advertisedRefs` and `carriedRefs` are
     disjoint and their union is exactly `Object.keys(section.refs)`. That closes the
     obvious attack of moving a ref between the two sets to launder provenance.

   **Consequence, and it is the desirable one:** a ref this device has only ever *carried*
   never acquires a usable origin, so it can never satisfy §3.3 rule 1, so P1 can never
   publish a deletion for it. The two features protect each other rather than one
   undermining the other. Enforced by `base-composer-structure.test.ts`-style exhaustiveness
   over the widened authority, which `130:286-323`'s closed union already forces.

**Ordering constraints.** §3.6 establishes one: P1b's receipt must be committed *before*
capture, or the ACK dry-run refuses the omitting candidate. v3 corrects two of v2's three.

- **P1 + P1b must land before P4 — real, and now doubly so.** Constraint 4: without the
  receipt rule, the per-ref lane manufactures exactly the deletion-by-omission that §8
  item 3 rejects, at a granularity that makes it harder to see. Constraint 6 adds the
  converse direction: without the held-ref-aware ACK, P4 forges the provenance P1 trusts.
  Neither is safe alone; the ordering is P1/P1b first, and constraint 6 ships **with P4**,
  in sub-step 4a, never after it.
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

### 4.4a P4's accepted-ACK state machine — the third outcome

v2 left this undecided; it is the difference between a specification and a sketch.

**Today there are exactly two outcomes**, and both are whole-section:

- **settled** — the repo is in `supersededPending ∪ resolvedPending`, so `push.ts:938-941`
  removes it from `pendingAfterAck` and `gitBaseAfterCommit` (`plan.ts:1155-1167`) lets
  BASE advance to the whole committed section;
- **unsettled** — the repo stays in `pendingAfterAck`, and `gitBaseAfterCommit` restores the
  **old** BASE section wholesale ("the saved git BASE must keep the OLD entry (or none) so
  the next pull still sees remote != base and retries the apply", `plan.ts:1150-1154`).

A merged section is neither: this device applied and captured most refs but has not applied
the held ones.

**The third outcome: `partially-superseded`.**

| Facet | Rule |
|---|---|
| **Section BASE refs** | advance to the committed section's value for every ref in `advertisedRefs` (the captured set); keep the previous BASE value for every ref in `carriedRefs`. `gitBaseAfterCommit` moves from "pick old or new section" to "merge per ref" **for this outcome only**. |
| **Section BASE non-ref fields** | `head`, `bundleSha`, `packChain`, `config`, opState and index projection all keep their **previous BASE** values. They describe a state this device has not applied; advancing them would make the next pull read "unchanged" and never retry the apply — the exact regression `plan.ts:1150-1154` was written to prevent. |
| **Design-130 branch BASE** | handled entirely by §4.4 constraint 6: carried refs get `after = before` and no origin. No separate mechanism. |
| **`pending[rel]`** | **retained verbatim, never rewritten.** The apply lane still needs the whole section — head, index, bundle — to finish applying. This is also what makes constraint 2's key decision work. |
| **Deferral subject** | unchanged: the apply deferral keeps the incoming key. The push lane records **no** deferral for a partial settle; it emits one bounded line naming the carried refs. |
| **Held attempt** | unchanged, keyed on the incoming section. The held-skip bracket is unaffected: held-skip short-circuits the *follow*, and the push lane recomposes the merge from live refs every cycle regardless. |
| **Partial progress** | unchanged; `partial[rel]` continues to record the follow's applied/held refs. |
| **Crash recovery** | the partial-settle BASE update is part of the same post-ACK state CAS as everything else in `push.ts`. If the push is accepted and the CAS is lost, the next cycle re-derives from unchanged BASE + unchanged pending + unchanged live refs, recomposes a content-identical merged section, and re-pushes; the existing `supersededPending` path absorbs it. No new recovery code. |

**What "partial progress" means to a follower: nothing.** A merged section is an ordinary
`GitSection`. The partial-settle outcome is entirely a publisher-side bookkeeping state; no
receiver can observe it and none needs to.
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
| Published branch deleted locally (`git branch -D`, `git worktree remove`, agent cleanup) | Tip pinned for 90 days (§3.7), absence receipt written, BASE retired, deletion published as a tombstone in the **same cycle's push lane**, `pending` superseded. One bounded log line. |
| `pending` carried on a ref the local repository no longer has | Supersedes as soon as the absence receipt exists. |
| Abandoned worktree holding a branch | Per-ref hold only; the repository is no longer *deferred* and the follow is held-skipped until the worktree registry changes. **Capture is still gagged until P4** (§4.2) — corrected from v2. |
| Unrelated local work while a worktree hold is outstanding | **P4 only.** Publishes per-ref past the hold. Nothing before P4 changes this. |
| Squash-merged branch cascading holds onto unrelated refs | Cascade broken by content equivalence. It does **not** lift the first-pass ownership hold on the merged branch itself (§4.3). |
| Stale positive BASE member left by a *past* deletion (the latent wedge, §2.3) | Reconciled before apply's unchanged shortcut (§3.6a step A), so it clears without waiting for a divergence to arm it. |

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
| P1 absence capture, positive case | One prepared ref transaction + one state CAS per deleted branch — the same shape as any other branch transition — plus §3.7's `cat-file -e` probe and keep-pin lines inside the *same* transaction. | Tens of ms, once per deletion, not per cycle. |
| §3.7 keep-pin accumulation | ~10 deletions/day × 90 days ≈ **~900 hidden refs** at steady state, spread across repositories, each holding its commit against `git gc`. **The only unbounded-in-time cost in the design**, and the one the founder explicitly accepted. | Measured, not assumed — §11's separate bake. |
| §3.7 expiry sweep | One `readKeepPinOrigins` file read per repository per cycle as the gate; a `for-each-ref refs/rbox-local/keep/*` at most once per repository per 24 h, and only when a `tombstone`-class origin exists. | Negligible; most repositories skip at the gate. |
| §3.3a strict ref read | Same `git show-ref` invocation, different error handling. **Zero additional subprocesses.** | Zero. |
| §3.6a position change | Moving reconciliation above `apply.ts:873` adds an O(BASE heads) in-memory predicate to the *unchanged* path — the hot path for converged repositories. It must reuse the cycle's existing ref read and must not acquire a protocol lock when the candidate set is empty. | Unmeasurable if implemented as specified; a new spawn per converged repository per cycle if not. This is the line to watch in review. |
| P1b pending pre-probe | Today's loop plus one artifact-disposition lookup per missing head. | Unmeasurable. |
| P3 content equivalence | Runs **only** on tips the ancestry proof already rejected — normally 0 per cycle. Per probe: 1 `merge-base` + 1 `diff-tree｜patch-id` + 1 walk of `base..D` capped at 5,000 commits. Cached on immutable `(T, D)`. | Cold worst case (all ~203 heads unowned, e.g. first sync of a heavily squashed workspace): ~600 spawns ≈ 6–12 s **once**. Steady state ≈ 0. |
| P2 held-skip for `worktree-ownership` | One extra `git worktree list --porcelain` per repository per cycle for the digest. | **Removes** a full follow per cycle for every ownership-held repository — on the observed data, roughly the whole 9 s p95 for `Personal/rbox-core`. |
| **P4 per-ref pending lane** | **Positive cost, and the only one here.** Today a held repository republishes the carried pending section *by identity* — `normalizeOutgoingGitSections` reuses `pendingSection` unparsed when the incoming keys match (`publisher-tombstones.ts:183-186`), so it re-advertises the same `bundleEncSha` and uploads **nothing**. A merged section is a new section, so every cycle with an outstanding hold now runs an ordinary capture: bundle build, encrypt, upload. | Incremental, so the increment is the local delta plus the pinned held tips, not a full repack — `capturePlannedGitSection` reuses the pack chain until `exceedsPackChainByteBound` forces recompaction (`shared.ts:236-249`). Order of a normal capture for that repository, once per cycle, for as long as the hold lasts. |

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
   because §3.4 depends on it.)* **It proves possession, never the cause of a later
   absence** — §3.3b. **A carried ref never acquires such an origin** — §4.4 constraint 6.
2. **A published branch deleted locally is captured, never resurrected.** BASE-positive +
   P-absent + clear artifacts yields a locked absence receipt, never a branch creation.
3. **Absence capture is fail-closed.** Any missing origin, stale lineage, existing A/P/K,
   sibling ownership, busy repository, unreadable identity, HEAD symref naming the ref,
   ref-database regression signal, or unstable second observation leaves the ref untouched.
4. **Mass absence defers to a human.** Either an absolute count **or** a share of a
   repository's positive BASE heads vanishing at once captures none of them. *(The `OR` is
   the invariant; a conjunction of the two legs is not equivalent and is unsafe — §3.5.)*
5. **Content equivalence waives holds, never authorizes deletion.** A patch-id match may
   only convert `would-drop` to `proven`, and only for a non-destructive transition; a
   `content-equivalent` waiver and an `afterOid === null` transition are disjoint by
   construction. Deletion authority remains tombstone attestation or an absence receipt.
6. **An absence proof is never derived from a failed ref read.** Every read that feeds a
   deletion, a locked absence proof, or a published section distinguishes "no refs" from
   "could not read refs" and fails closed on the latter. *(New in v3 — §3.3a.)*
7. **A pending section is superseded only against a proved candidate.** Supersession
   requires either local presence at an equal-or-descendant OID or a durable absence
   receipt for every pending head — never mere omission. *(Pins
   `REVIEW-174-R1-OPUS-B.md:14`'s resolution, which is currently unpinned in
   `INVARIANTS.md`.)*
8. **Worktree ownership is observed regardless of containment.** Sibling worktrees outside
   the workspace still hold their refs; containment affects only reporting.
9. **A published deletion stays recoverable for a bounded window, from the device that
   published it.** The device performing an absence capture pins the tombstoned tip under
   `refs/rbox-local/keep/<X>` with a `tombstone`-class origin, in the same ref transaction
   as the A artifact and strictly before BASE is retired — so BASE is never retired without
   a pin. Devices that prune under tombstone authority pin it too, as they already do.
   Publishing a deletion may never be the act that destroys the last *reachable* copy of an
   object that still exists. *(§3.7, ruling R3. The one admitted exception — the object was
   already `gc`-pruned before rbox looked — is recorded there and surfaced by §7.2 rather
   than hidden.)*
10. **Held refs are published, never superseded.** In a `pending ⊕ local` outgoing section
   (P4), a held ref carries its pending value verbatim and is excluded from tombstone
   authorship. Composing a section is never authority over a ref this device does not hold.

"Branch equality is not deletion authority" (since 130) remains true and unweakened: a
local-absence receipt is not equality, it is a locked proof of physical absence against
positive provenance. `follow.ts:894-895` keeps holding; it simply stops being reachable
for refs absence capture has already reconciled.

### 7.1 The recoverability window — why the follower-pin premise failed

**Superseded by R3 (§3.7).** v2's §12 Q3 was ruled "no pin, conditional on tombstone
recoverability being stated first"; codex demolished the condition and the founder reversed
the ruling on 2026-07-24. This section is kept — reframed — because the *analysis* is the
rationale for R3, and a future reviewer who deletes it will re-propose the follower-pin
model. What follows is the mechanism that does exist, followed by the four places it
produces nothing.

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

**Why that is not sufficient — the four cases the follower pin does not cover.** The prune
is what creates the pin, so no prune means no pin. v2 listed two gaps; there are four, and
three of them are ordinary rather than exotic.

1. **The deleting device pinned nothing** (before R3). The A artifact does *not* pin the
   tip. It writes a canonical blob holding
   `{ lineageHash, priorOid, ref, repositoryIdentityHash, v:2 }` and points
   `refs/rbox-local/base-absent/v2/<lineage>/<refHash>` at **that blob**
   (`baseAbsentPayload`, `base-artifacts.ts:145-149`; `:218-224`) — it records the OID as
   *text*, and nothing keeps the commit reachable. Contrast the P artifact, which creates
   genuine keep-refs directly at `priorOid` and `nextOid` (`basePresentKeepRef`,
   `base-artifacts.ts:114-118`, spliced at `:237-244`). **R3 closes exactly this
   asymmetry**, by giving the A path the keep-refs the P path always had.
2. **A single-device workspace has no fleet.** No other device applies the section, so none
   prunes, so no pin is ever created anywhere.
3. **Concurrent deletion on both devices.** Each side deletes locally before applying the
   other's tombstone; each then takes the `!oldOid && !newOid` path (`follow.ts:936`) and
   prunes nothing. Neither pins. This is a *likely* interleaving for the founder's loop —
   the same agent cleanup runs on both machines — not a race that needs constructing.
4. **A device that never received the ref, or that runs pre-1.6.8** (§3.0), has nothing to
   pin or holds instead of pruning.

**So recovery depended on a coincidence**, which is why the ruling was reversed. With R3 the
guarantee attaches to the one device certain to exist: the one that performed the deletion.

**The 90-day bound was, and until §3.7's sweep lands still is, a ceiling rather than a
window.** `expireTombstoneKeepPins` (`keep-pins.ts:434-457`) is exported through
`src/engine/index.ts:284` and has **no production caller**; the only other reference is
`keep-pins.test.ts:166`. Tombstone pins are created and never aged out today. That errs
toward over-retention, which was harmless while nothing depended on the number — but R3
prices an accumulation cost *at* 90 days, so §3.7 specifies the caller, the cadence, the
cheap gate, and names the resulting change to already-shipped follower-pin behaviour as a
behaviour change under the same kill switch.

### 7.2 Finding a deleted branch — the command, because none exists today

R3 makes the object recoverable. It does not make it **discoverable**, and v2's instruction
for finding the OID does not survive contact with the code.

**Why the v2 instruction fails.** It said to read `X` from `rbox git resolve <repo> show-me`
or from the published tombstone chain. Neither works:

- **`show-me` structurally cannot print an OID.** `buildSnapshot` computes local-only
  entries with their OIDs internally (`resolve-command.ts:238`, `:259`) and the public
  projection strips them: `localOnlyCommits: localOnly.map(({ labels, subject }) => …)`
  (`resolve-command.ts:296`). The JSON path additionally replaces any 40-hex token with
  `[commit]` (`resolve-command.ts:320-322`), and `git-cmd.test.ts:222-235` pins that
  contract by name. `refTombstones` appears nowhere in `resolve-command.ts` or
  `resolve-presentation.ts`.
- **The tombstone chain evicts before it expires.** Chains are capped at
  `MAX_REF_TOMBSTONES_PER_REF = 16` and `MAX_REF_TOMBSTONES_PER_REPO = 512`
  (`manifest-validate.ts:23-24`), and `normalizePublishedGitSection` applies the age cutoff
  first and then evicts by `evictionOrder` down to those caps
  (`publisher-tombstones.ts:124-146`). At ~10 deletions/day a busy repository's oldest
  tombstones are gone long before 90 days. The retention constant is a *maximum*, not a
  guarantee.
- **Nothing enumerates keep pins.** `keepPinRef` (`keep-pins.ts:66`) has no importer under
  `src/cli/`; the only `for-each-ref` over `refs/rbox-local/keep/*` lives inside
  `keep-pins.ts` itself. `help-registry.ts:188-212` shows the complete `git` surface —
  `deferrals` and `resolve`, nothing else — and `main-dispatch.ts:527-546` matches it
  exactly.

So today the only recovery path is state-file archaeology, which is not a recovery path.

**`rbox git deleted <repo>` — new verb, local-only, scriptable.**

- **Source of truth: the keep-pin origin sidecar**, not `state.json` and not the wire.
  `readKeepPinOrigins` (`keep-pins.ts:400`) is one file read, and `KeepPinOrigin` already
  carries `{ ref, episode, time, class }` (`keep-pins.ts:47-52`) — the branch name and the
  timestamp are already there, which is why no new persisted field is needed.
- **Lists**, newest first: branch name, when it was deleted, whether the pin was created by
  *this device's own deletion* or by *pruning another device's tombstone*, whether the
  object is still present, and the OID.
- **`--restore <branch>` recreates it** without the user typing or pasting an OID —
  automatic beats acknowledge-a-match beats copy-paste. It refuses if the branch name is
  taken, and it is a plain `create` ref transaction, nothing more.
- **`--json` for the scriptable twin**, so an agent or the rig can assert recovery end to
  end without a human. Unlike `show-me`, this command's entire purpose is to emit the OID,
  so the 40-hex scrubber must **not** be applied to it — and that difference has to be
  deliberate and tested, because it is an exception to an existing pinned contract.
- **Local-only.** It is never part of the diagnostics bundle, under §5.1's rule: branch
  names and OIDs are user content.
- **It must say when there is nothing to restore.** For the §3.7 case where the object was
  already `gc`-pruned, the entry is listed with the deletion recorded and the object marked
  gone. "No pin exists for this one" is a real answer and is better than an empty list that
  reads as "nothing was deleted".

Underneath, the manual escape hatch still works and is still worth documenting, because it
depends on no rbox verb at all:

```sh
git -C <repo> branch <name> refs/rbox-local/keep/<X>
```

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

**Conclusion.** The follower pin is real and stays — it is free, it already ships, and on a
multi-device fleet it gives a second copy. It is simply not a *guarantee*, because four
ordinary situations produce no prune. R3 adds the guarantee at the deleting device (§3.7)
and §7.2 adds the command that makes it reachable. Q3a — the single-device gap v2 recorded
as open — is **RETIRED**: it was one instance of a general defect, and the general defect is
now fixed.

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
10. ~~**Pin every auto-captured deletion under a recovery ref.**~~ **NO LONGER REJECTED —
    reversed 2026-07-24 by ruling R3, and moved into the design as §3.7.**
    The v2 rejection rested on two arguments. One was a cost the founder has now explicitly
    accepted (at ~10 deleted branches/day the pins accumulate — ~900 hidden refs at steady
    state under the 90-day window, and they hold objects against `git gc`; §3.7 prices it
    and §11 measures it). The other was **wrong**: "the local reflog is already gone, so the
    pin preserves one OID rather than the branch's history" is true and irrelevant — one
    OID *is* the branch tip, and `git branch <name> <tip>` restores the branch. Preserving
    the tip was always the whole ask.
    What actually killed the rejection was that its fallback did not exist: recovery via a
    *follower's* prune pin produces nothing in four ordinary cases (§7.1), so "no pin here,
    because there is a pin there" was conditional on a coincidence. §12 Q3 records the
    reversal and retires Q3a.

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
- **§3.7 pin, at every crash point.** Assert `refs/rbox-local/keep/<X>` exists with a
  `tombstone`-class origin naming `R`; that it is created in the *same* ref transaction as
  the A artifact (kill the process between the transaction and the BASE CAS and assert the
  pin and artifact are both durable and BASE is still positive, then assert the next cycle
  converges); and that BASE is **never** observed retired without the pin.
- **§3.7 object-already-gone path.** With `X` unreachable and `gc`-pruned, assert the
  capture still publishes the deletion, records `pinned: false`, and that §7.2's listing
  reports the object as gone rather than omitting the entry.
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
  packed-refs inode signal and the breaker between them refuse the capture.

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
lineage stale; **origin minted from a *carried* value rather than a captured one** (§4.4
constraint 6); `git` busy; preflight failure; repository identity changed; **`show-ref`
unreadable at plan time**; **`show-ref` unreadable at the locked second proof**; **`R` is
the current HEAD symref target**; **packed-refs inode changed or mtime regressed**;
**`logs/HEAD` missing while BASE recorded ≥ 1 head**; ref absent at plan time but present at
the locked second proof; circuit breaker tripped. Each case asserts BASE unchanged, no
artifact written, **no keep-pin created**, and no wire tombstone authored.

### 9.3 Multi-writer

Reproduce the §3.4 interleaving as a test: W1 publishes `R = X`; W2 advances `R = Y` and
publishes; W1 deletes `R` locally and absence-captures. Assert W1's tombstone chain covers
`X` only, W2 **holds** `R` at `Y` rather than pruning, and W1 subsequently re-creates `R`
at `Y` through the ordinary creation path.

### 9.4 Circuit breaker

Table-driven over `(N, n)`, because the v2 predicate passed every test anyone thought to
write and still failed the case that matters:

| `N` | `n` | Expected |
|---:|---:|---|
| 24 | 24 | **trips** — R1's counterexample; under v2's `max()` form this case *captured all 24*, and this row is the regression test for it |
| 24 | 6 | trips (fraction leg) |
| 24 | 5 | captures |
| 304 | 25 | trips (absolute leg) |
| 304 | 24 | captures |
| 19 | 19 | captures under the recommended Q2b guard; **trips** under the unguarded `OR`. Whichever the founder rules, this row asserts the ruled behaviour explicitly rather than whatever falls out. |
| 2 | 1 | captures under the guard; trips unguarded — the row that makes Q2b's cost visible in CI |

Plus: on a trip, assert zero captures, zero A artifacts, **zero keep-pins created**, one
deferral with the new reason, one bounded log line, and that a single subsequent deletion
(after the mass state is resolved) captures normally. The keep-pin assertion matters because
§3.7 adds a side effect ahead of the artifact and the breaker must refuse before *all*
of it (§3.5's 108-posture argument).

### 9.5 Per-ref pending lane (P4)

New in v2, because P4 was a non-goal when §9 was written. Each item maps to one of §4.4's
five entanglements, so a missing test is visible as a missing row.

- **Bundle coverage.** Compose `pending ⊕ local` where held ref `H` sits at a pending OID
  this device holds in no publishable ref. Assert the emitted section's bundle *contains*
  that tip — by importing the published section into a fresh clone and resolving `H` —
  and assert it still contains it when the apply-time `refs/rbox-incoming/*` namespace has
  already been torn down (`apply.ts:335-339`). This is the test that fails if the
  implementation borrows the incoming namespace instead of pinning at capture.
- **`gitIncomingKey` non-migration.** §4.4 constraint 2 decides that the carried pending
  section is never rewritten, so the assertion is now concrete: after the first merged
  emit, a repository with a recorded `GitHeldAttempt` (`sync-state-model.ts:228-245`), a
  `partial` record and a deferral episode still resolves all three, **and**
  `gitIncomingKey(pending[rel])` is byte-identical to its pre-merge value. Paired with the
  structural test that no outgoing merged section's key is ever written into `deferrals`,
  `attempt` or `partial`.
- **Held-ref-aware ACK (§4.4 constraint 6) — the provenance test.** Publish a merged
  section whose held ref `H` carries a pending value this device never held; accept the
  ACK; then assert `branchBaseOrigins[H]` is **unchanged** (no fresh `publisher-ack` origin
  minted) and BASE keeps its prior value for `H`. Then delete `H` locally and assert
  absence capture **refuses** it for want of a usable origin. That last step is the whole
  point: it proves P4 cannot hand P1 forged evidence.
- **ACK authority shape.** Reject an authority whose `advertisedRefs` and `carriedRefs`
  overlap, and one whose union is not exactly `Object.keys(section.refs)`.
- **Third outcome (§4.4a).** Accept a push for a repository with one held ref and assert
  `partially-superseded`: section BASE refs advanced for the captured set, unchanged for
  the carried set, **non-ref fields all at their previous BASE values**, `pending[rel]`
  retained verbatim, no push-lane deferral, one bounded line. Crash between the accepted
  ACK and the state CAS and assert the next cycle recomposes a content-identical section
  and converges.
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
  repository has **no** held refs (`publisher-tombstones.ts:183-186` reuse path), so P4
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
- **`rbox git deleted` (§7.2):** assert it lists a branch absence-captured on this device
  with its OID and origin class; that `--restore <branch>` recreates the branch at exactly
  `X` without the user supplying an OID; that `--json` emits the OID (i.e. is deliberately
  exempt from `show-me`'s 40-hex scrubber, `resolve-command.ts:320-322`); that an entry
  whose object was `gc`-pruned is listed as unrecoverable rather than omitted; and that the
  command's output never enters the diagnostics bundle.
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
- **Recoverability (§3.7), asserted rather than assumed, on both sides.** After device B
  prunes `C` under the tombstone, assert `refs/rbox-local/keep/<X>` exists on B with a
  `tombstone`-class origin for the authorized tip and `human` for the rest of `C`'s reflog.
  **And on device A — the one that deleted it** — assert the same pin exists from the
  absence capture, that `rbox git deleted <repo> --restore C` recreates it at exactly `X`,
  and that this holds in the **single-device** variant of the rig where no follower ever
  prunes. That last case is the one that used to have no recovery at all, so it is the gate
  for R3.
- **Pin expiry sweep (§3.7).** With an injected clock past `TOMBSTONE_PIN_RETENTION_MS`,
  assert `expireTombstoneKeepPins` is actually invoked by the push lane, at most once per
  repository per 24 h, skipped entirely when no `tombstone`-class origin exists, and that
  `human`-class origins survive. The clock must **advance** across the assertion rather than
  being pinned far-future — a pinned clock neutralizes the very invariant this tests.
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

## 11. Rollout

Default-ON with kill switches, following the founder's standing rule and the existing
`gitPendingSupersedeEnabled` pattern (`pending-supersession.ts:26-27`) — with **one
deliberate exception**, P4, argued below.

| Switch | Default | Disables |
|---|---|---|
| `RBOX_GIT_ABSENCE_CAPTURE=0` | on | P1 + P1b (falls back to today's carry/refuse), **and** §3.7's keep-pin and expiry sweep |
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
3. **P1 + P1b + §3.3a + §3.3b + §3.7 + §7.2.** The authority change and everything that
   makes it safe: the strict ref read, the restore/unborn-branch rules, the deleting-device
   pin and its expiry sweep, and the recovery command. These ship **together** — a P1
   without §3.3a is a fleet-wide deletion waiting for one corrupt loose ref, and a P1
   without §3.7 publishes deletions that may not be recoverable. Validated on a dev build
   against the live wedge before any CLI release. *Genuine precondition for step 4.*
4. **P4, in two sub-steps.**
   - **4a — no behaviour change.** Pin held pending tips into the capture's scratch-pin set,
     structurally exclude held refs from tombstone authorship, and **ship §4.4 constraint
     6's held-ref-aware ACK authority**. Constraint 6 belongs here and not in 4b: it must be
     in place before the first merged section is accepted, or that ACK mints forged
     provenance. All of it provable by §9.5's tests without emitting a merged section.
   - **4b — the merged emit.** Turn on `pending ⊕ local` and the `partially-superseded`
     outcome (§4.4a). The only step in the design that changes what a device publishes for
     refs it is not authoritative over.

**Correction: "P2 must precede P1/P4" was wrong.** `publishRefPlane` already returns a
per-ref held set — built per ref and returned both as a set (`follow.ts:1041`) and as a map
(`follow.ts:1047`) — and `apply.ts:1447` merely ignores the detail by consuming
`held.length`. So P4 has a per-ref hold set to merge over with or without P2, and P1 never
needed P2 at all. The ordering above is a *validation* sequence, not a dependency graph,
with exactly one hard edge: **step 3 before step 4**, for the two mutually-reinforcing
reasons in §4.4 ("Ordering constraints").

**Reverse migration for P4 — required, because "independently revertible" is false for it.**
v2 claimed each step was independently revertible while simultaneously admitting P4's revert
is not free. Both cannot be true. The reverse path, specified:

- **Exact carry is always reconstructible.** P4 never rewrites `pending[rel]` (§4.4
  constraint 2), so the byte-for-byte section the pre-P4 code would have carried is still
  in state. Turning the flag off returns `normalizeOutgoingGitSections` to its
  reuse-by-identity path (`publisher-tombstones.ts:183-186`) with no reconstruction step.
- **No BASE origin needs undoing.** Carried refs never received an origin (constraint 6),
  which is byte-identical to the pre-P4 shape for a ref this device never advertised.
- **The one real cost: a redundant apply.** The section BASE may have advanced per-ref under
  `partially-superseded`. With the flag off, `gitBaseAfterCommit` reverts to whole-section
  semantics, the next pull sees `remote != base` and re-applies. That is *safe* — re-apply
  is idempotent — and it is a real extra cycle of work per affected repository. Accepted,
  and named here rather than discovered during a rollback.
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
4. No `gitIncomingKey`-bound state (partial progress, deferral episodes, held attempts)
   observed orphaned across the first merged emit — and `gitIncomingKey(pending[rel])`
   verified byte-identical across it (§4.4 constraint 2).
5. **No carried ref observed with a fresh `publisher-ack` origin** after a merged section is
   acked. This is constraint 6's field check; it is the one that would show a forged
   provenance leak before P1 could act on it.

Steps 1–3 do **not** wait on this; they ship default-on as v1 planned.

**A separate, smaller bake for §3.7's pin accumulation**, which does not gate P4: after
seven days with absence capture on, count `refs/rbox-local/keep/*` on the founder's Mac,
measure `git gc` wall clock on `Personal/rbox-core` against its pre-change baseline, and
confirm the expiry sweep actually ran. The founder accepted this cost; the point of
measuring is to find out whether the number he accepted is the number he gets.

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

All six of v1's open questions were ruled by the founder on **2026-07-24**. Three further
rulings (**R1–R3**) were issued the same day, after codex's round-1 review, and two of them
*change* earlier rulings. They are kept here as a decision record rather than deleted; the
questions are stated as they were asked, followed by the ruling and its reasoning. Anything
still genuinely open is marked **STILL OPEN** and is the only thing in this section that
needs another answer.

**The three later rulings, R1–R3 (2026-07-24), in one place:**

| | Ruling | Changes | Where |
|---|---|---|---|
| **R1** | Mass-deletion breaker trips if **either** leg trips, whichever comes first — `n ≥ 25 OR n ≥ 25% of N` | **Supersedes Q2's `max()` form**, which was arithmetically incapable of tripping on any repository under 100 heads | §3.5, Q2 below |
| **R2** | Deletion is not instantly fleet-wide; state the version floor honestly | Narrows Q1's stated semantic without changing the decision | §3.0, Q1 below |
| **R3** | The **deleting** device pins the commit locally for 90 days | **Reverses Q3** and **retires Q3a** | §3.7, §8 item 10, Q3 below |

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
the prune for a bounded window (§3.7).

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
*~~RULED 2026-07-24 — defer at `max(K = 25, F = 0.25)`.~~* **SUPERSEDED 2026-07-24 by R1 —
defer at `n ≥ 25` **OR** `n ≥ 25% of N`, whichever trips first.** Tripping **defers** the
repository; it does not merely warn and proceed. Recorded in **§3.5** with the arithmetic,
the counterexample, and the trip table.

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

> **STILL OPEN — 2b. Small-repository hair-trigger under the `OR` form.** Stated in full in
> §3.5. `n ≥ 0.25·N` trips on one deletion in a 4-head repository and two in an 8-head one;
> the founder's workspace averages ~1.8 BASE heads per repository, so R1 taken literally
> would defer nearly every repository on the first routine `git branch -D`. Recommended
> amendment: gate the fraction leg on `N ≥ 20`, giving `n ≥ 25 OR (N ≥ 20 && n·4 ≥ N)`,
> which keeps R1's 24-head counterexample caught (trips at 6) and leaves a 5–19-head window
> covered only by §3.3b's weaker ref-database signals. **The design assumes the guarded
> form**; if the founder prefers the unguarded `OR`, §3.3b's signals become load-bearing and
> §0's "no human in the loop" claim has to be softened for small repositories.

**3. Safety pin for auto-captured deletions?**
*~~RULED 2026-07-24 — no pin, conditional on tombstone recoverability being stated first.~~*
**REVERSED 2026-07-24 by R3 — the deleting device pins the commit locally for 90 days.**
Specified in **§3.7**; §8 item 10's rejection is struck; §7.1 is kept as the rationale.

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
`base-artifacts.ts:114-118`) — closing an asymmetry, not inventing a mechanism. The founder
explicitly accepted the accumulation cost (~900 hidden refs at steady state, and their
effect on `git gc`); §6 prices it and §11 measures it. Two consequences recorded in §3.7:
the object may already have been `gc`-pruned before rbox looks, in which case the deletion
still publishes and the missing pin is **reported** rather than hidden; and the 90 days only
means anything once `expireTombstoneKeepPins` (`keep-pins.ts:434`, today referenced only
from `index.ts:284` and its own test) has a caller, which §3.7 specifies.

> **~~STILL OPEN — 3a. Single-device workspaces.~~ RETIRED 2026-07-24 by R3.** Q3a asked
> whether to pin only when the account has one device. It is moot: the single-device case
> was one instance of a general defect — recovery depending on somebody else pruning — and
> R3 fixes the general case by pinning on the deleting device unconditionally. Recording the
> retirement rather than deleting the question, because "pin only for single-device
> accounts" is exactly the kind of narrow optimization a future reviewer will re-propose;
> the answer is that the multi-device cases (concurrent deletion, never-delivered ref, old
> followers) are just as unpinned.

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
  so it ships *with* P4 and never after; and ~~P2 must precede both~~ was wrong —
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

## 13. Codex review round 1 — what was caught and how it is answered

Recorded so the next reviewer starts from here rather than re-deriving. **Verdict:
NOT-ALIGNED — 7 blockers, 4 majors.** Every code claim below was re-verified against the
worktree before being folded in; three of codex's citations were off by a few lines and are
corrected here rather than propagated. All eleven are answered; **two residual questions are
left open on purpose** and are marked as such.

### Blockers

| # | Finding | Resolution | Where |
|---|---|---|---|
| 1 | Q3's no-pin premise is false even multi-device — recovery depended on a *follower* pruning, which does not happen in several ordinary cases | **Resolved by R3.** §7.1 rewritten around the deleting-device pin; the follower-pin analysis kept as the rationale; Q3a retired | §3.7, §7.1, §12 Q3 |
| 2 | P1 turns a ref-read error into fleet-wide deletion — `readAllRefs` maps any `show-ref` failure to `{}` | **Resolved.** Strict reader specified with the exit-code discipline the codebase already uses at `shared.ts:261-268`; mandatory site list includes the locked proof at `branch-transition.ts:309` and both capture sites. Reproduced empirically | §3.3a |
| 3 | P4 destroys P1's provenance invariant — carried values acquire `publisher-ack` origins | **Resolved.** Held-ref-aware ACK authority: `advertisedRefs` (captured) and `carriedRefs` (carried) split, disjointness enforced, carried refs get `after = before` and no origin | §4.4 constraint 6 |
| 4 | P1's control flow does not clear the field wedge — the unchanged shortcut precedes the hook, and retiring BASE mid-pass lets the section re-create the branch | **Resolved.** Reconciliation moved above `apply.ts:873` with an O(1) cheap gate; `result: "reconciled"` ends the pass; the same cycle's push lane publishes the omission (`sync.ts:9-19` is pull-then-push) | §3.6a |
| 5 | BASE provenance proves possession, not the cause of absence — an in-place ref restore preserves identity | **Resolved.** §3.4 stops claiming otherwise; HEAD-symref rejection and ref-database regression signals added; the breaker named as the primary restore detector, which R1 is what makes real | §3.3b, §3.4 |
| 6 | P3 has a false positive and can authorize deletion — "waives holds only" is not a mechanism | **Partly resolved, honestly scoped.** `--verbatim` closes the whitespace half; the apply-then-revert false positive is **left standing and pinned by a test**; the boundary is made structural (waiver barred from destructive transitions + disjointness test); P3 re-described as cascade reduction | §4.3, §9.1 |
| 7 | P4's accepted-ACK state machine is undecided | **Resolved.** Third outcome `partially-superseded` specified across BASE refs, BASE non-ref fields, pending, deferral subject, held attempt, partial progress and crash recovery; the key question *decided* (pending is never rewritten) | §4.4a, §4.4 constraint 2 |

### Majors

| # | Finding | Resolution | Where |
|---|---|---|---|
| 8 | P2/P3 do not fix wedge (a) as claimed — a hold only exists for refs the incoming section wants to change | **Accepted; claims corrected.** `follow.ts:732` precedes `:734`, so the "already convergent" filter is a no-op and supersession still refuses. P4 is now stated as the *only* fix for the capture gag | §4.2, §4.5, §5 |
| 9 | Rollout ordering and rollback independence overstated | **Accepted; corrected.** P2 demoted from precondition (`follow.ts:1041`, `:1047` already return a per-ref held set); P2's switch split in two; P4 given an explicit reverse migration and a receipt-disabled fallback rule | §11, §4.4 |
| 10 | 1.6.6 skew is behavioural, not schema | **Resolved by R2**, with the floor corrected to **v1.6.8** (commit `04c2aff8`) from the verified tag rather than assumed | §3.0, §12 Q1 |
| 11 | Recovery window not discoverable — tombstones evict before they expire and `show-me` structurally omits OIDs | **Resolved.** `rbox git deleted <repo> [--restore <branch>] [--json]` specified against the keep-pin origin sidecar, which already carries branch name and timestamp | §7.2 |
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

### Still open after this round

1. **Q2b — the small-repository hair-trigger** under R1's `OR` form (§3.5, §12 Q2). Needs a
   founder decision between the unguarded `OR` and the recommended `N ≥ 20` gate on the
   fraction leg. The design assumes the gate.
2. **P3's apply-then-revert false positive** (§4.3). Not a founder question — a scope
   decision, taken deliberately: an exact result-state proof is a separate design, and P3's
   structural bar against destructive transitions is what makes leaving it acceptable. If a
   reviewer disagrees that the bar is sufficient, P3 should be cut rather than expanded.
