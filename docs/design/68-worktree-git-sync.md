# 68 — Git-state sync for main clones with linked worktrees

Status: draft, codex-reviewed (v2 — resolutions folded in below)
Origin: 2026-07-06 founder stress test — a 140-repo workspace push
Depends on: design 28 (git-state sync), design 43 (nested-repo capture + preflight)

## 1. Problem — the flagship feature no-ops for the flagship customer

The stress test's git-sync summary line told the story in one breath:
**captured 127 · deferred 12 · failed 1**, and 10 of the 12 deferrals were
`.git/worktrees present — unsupported — section not captured`. The deferred
list was not long-tail junk — it was `rbox-core`, `savvy-core`, and the whole
conductor workspace: the founder's *primary* repos.

The v1 refusal (design 43 §4, `src/engine/git/preflight.ts:55-58`) produces an
inversion that is worse than a plain gap:

- A **main clone with linked worktrees** — real branches, real stash, the
  uncommitted work git-state sync exists to carry — is refused outright.
- Its **linked worktree checkouts** (gitfile-pointer repos) are *supported*,
  and each one's capture runs `git bundle --all` against the **shared** object
  store. A repo with 8 agent worktrees uploads its full history 8 times to
  carry 8 disposable scratch states — while the main clone's state travels
  not at all.

Every agent-workflow developer (`.claude/worktrees/`, Conductor, worktree-based
parallel agents) — rbox's stated target buyer — has this shape on their most
active repos. Today they get the N×-bytes cost and none of the benefit, and
the only disclosure is a deferral reason in the sync log.

## 2. Current behavior (facts, with cites)

- `gitPreflight` refuses dir-repos when `.git/worktrees` (or `modules`, or
  `objects/info/alternates`) exists — `structural: true`, so the section is
  DROPPED, not carried (`preflight.ts:55-58`). Design 43 recorded this as an
  explicit v1 non-goal ("syncing a main clone's `.git/worktrees/*`
  administrative linkage").
- Gitfile-pointer repos (worktree/submodule checkouts) pass preflight and are
  captured with the gitdir resolved through the pointer
  (`capture.ts:17,55`), bundling the resolved (shared) object store.
- The fail-closed posture has earned its keep: design 43's live validation
  caught `bundle --all` on a *shallow* clone silently omitting history. New
  shapes get enabled only with a validation matrix, and this doc keeps that
  discipline.

## 3. Design

### 3.1 Tier 1 — capture main clones with linked worktrees

Remove `worktrees` from the dir-repo refusal list. Capture proceeds exactly
as for an ordinary dir repo, because everything the capture touches is either
shared (and complete) or main-checkout-local:

| Captured artifact | With linked worktrees present |
|---|---|
| bundle | **`git bundle create … --single-worktree --all`** (v2: codex caught that plain `--all` examines *every* worktree's HEAD — rev-list semantics — so a detached linked-worktree HEAD would smuggle tier-2 state into the bundle). `--single-worktree` restricts to the main checkout's view; branches checked out in worktrees are still ordinary `refs/heads/*` and travel. Validation V9 pins the detached-worktree case (live-repro'd 2026-07-06, git 2.50.1: `rev-list --all`=3 commits incl. the worktree's detached HEAD, `--single-worktree --all`=2, and the worktree's *branch* still rides in the bundle). |
| index | The **main checkout's** index (its own gitdir path). Worktree indexes live under `.git/worktrees/<n>/index` and are untouched. |
| stash | `refs/stash` is shared — captured as today. |
| op-state (rebase/merge heads) | Main-gitdir paths only; per-worktree op-state is per-worktree (tier 2). |

Quiescence: the busy probe (design 43 §7) checks index/HEAD/ref locks. A
*worktree-local* operation locks `.git/worktrees/<n>/…`, not the main index —
main capture is not blocked by a busy worktree. Shared-ref locks (gc,
branch -f) are already probed. One addition: **prunable-only worktrees**
(stale `.git/worktrees/` entries whose checkout dirs are gone) must not gate
anything — treat a worktrees dir whose every entry is prunable as absent
(the `git worktree prune` case; validation item V7).

**Explicit non-goal (tier 2):** capturing per-worktree index/HEAD/op-state.
That requires a worktree-identity mapping across machines (paths differ, the
set of worktrees differs) and a restore story for "this worktree doesn't
exist here." Nothing in tier 1 forecloses it.

### 3.2 Restore side — the checked-out-branch collision rule

The one real hazard is on **apply**, not capture — and (v2 correction, codex
BLOCKER) **git does NOT protect us here**: rbox's apply fetches into
`refs/rbox-incoming/…` and publishes via `git update-ref`
(`apply.ts:255,263`), and `update-ref` **silently moves** a branch that a
sibling worktree has checked out — the code documents this exact hazard
itself (`apply.ts:36`). The porcelain-refusal safety net only exists for
`checkout`/`fetch` porcelain, which apply does not use.

Rule (mandatory safety logic, not an error-message nicety): before ANY
publish, apply computes the destination repo's checked-out set —
`git worktree list --porcelain` → every worktree's branch plus detached
HEADs — and intersects it with the section's ref updates, ref deletions, and
HEAD move. **Any intersection defers the WHOLE section** this cycle with no
mutation (existing apply-side defer: `gitPendingRemote`, base not advanced —
`sync-git.ts:541`), reason `branch <b> checked out in linked worktree <n>`.
No partial application (v2: applying non-colliding refs while deferring the
rest would mutate local refs against an un-advanced base — a correctness
hole, and partial-scope filtering is design-43 §7 territory, not this doc).
Next cycle after the user moves/removes the worktree, the section applies.

### 3.3 Dedup — in-tree pointer worktrees stop full-store capture

New rule for **linked-worktree pointer** repos ONLY (v2: submodule pointers
are exempt — their `commonDir` resolves to `.git/modules/…` of a superproject
that stays structurally refused, so no parent bundle would carry their
object store; skipping them would *regress* today's support): if the owning
main clone's toplevel is inside the same workspace root **and that main
clone was actually captured in this cycle's manifest** (passed preflight —
not merely present), skip the pointer repo — reason `linked worktree of
captured in-tree repo <path> — history travels with the main clone`.

Skip semantics (v2, codex MAJOR — a naive structural-style drop would fight
the removal-memory machinery: receivers stamp removal memory on remote
absence, `sync-git.ts:443`, and push suppresses re-adds over it,
`sync-git.ts:231`): a policy skip is a **base-carry, never a drop**. An
existing captured section for a now-skipped pointer repo is carried forward
unchanged — the remote never observes an absence, so no removal memory is
stamped anywhere and nothing needs healing. Fresh sections are simply never
authored for skip-eligible repos. When eligibility ends (main clone leaves
the tree or stops being captured), capture resumes over the carried base.
Cost stated plainly: a carried section pins its (possibly large) bundle
blobs in GC until the repo is genuinely removed — accepted for v1; the
alternative (explicit policy-tombstone section kind) is a schema change left
to a follow-up if the retained bytes prove material.

- Out-of-tree main clone (the Conductor layout design 43 §1 explicitly
  targets — worktree in the synced tree, clone elsewhere): **unchanged**,
  full capture, since nothing else carries that history.

What this costs: an in-tree scratch worktree's *uncommitted* index/untracked
state no longer travels (its committed branches still do, via the parent's
bundle). That is the right trade — scratch worktrees are disposable by
convention, and the current alternative is uploading the shared store once
per worktree. In the stress test this rule alone eliminates the dominant
staging cost (~8× savvy-core history, 3× rbox-core, GRDB `.build` checkout
junk).

### 3.4 Disclosure — no more log archaeology

- `rbox status` gains a per-workspace git-sync exclusions line when any repo
  is skipped/deferred: `git-state: 127 synced · 12 skipped (worktrees 10,
  alternates 1, failed 1)` — reasons summarized, `rbox logs` for detail.
- `docs/usage.md` git-state section documents the supported shapes and the
  worktree caveat (interim honesty ships with this doc; deleted when tier 1
  lands).
- Marketing homepage git-state blurb gets the same one-line caveat
  (rbox-home-page repo, separate PR).

## 4. What stays refused (unchanged, each with a validated corruption story)

Shallow clones (silently incomplete bundles — design 43 live finding), bare
repos, `objects/info/alternates` (incomplete store), submodule
**superprojects** (`.git/modules/` present) — the modules half of the v1
refusal keeps its own future design; nothing here touches it.

## 5. Validation matrix (gate for enabling — design-43 discipline)

- V1 capture: main clone + 2 linked worktrees; assert bundle refs == non-worktree twin's, index/stash captured, no `.git/worktrees` paths in artifacts.
- V2 restore onto a machine with no worktrees: full apply.
- V3 restore onto a machine where a linked worktree has branch B checked out; incoming updates B → that section defers with the collision reason; others apply. Next cycle after `git worktree remove` → applies.
- V4 worktree-branch commits made *in* a worktree on machine A appear on machine B via the parent bundle.
- V5 busy worktree (mid-rebase in the worktree) during main capture → capture proceeds; busy **main** checkout still defers as today.
- V6 in-tree pointer skip: `.claude/worktrees/<x>` not captured, reason line present; same worktree with main clone *outside* the root → captured.
- V7 prunable-only `.git/worktrees` entries → treated as no worktrees (capture proceeds).
- V8 mixed cycle: one repo deferring on collision must not gate other repos' sections (per-repo isolation as today).
- V9 detached linked-worktree HEAD: with `--single-worktree --all`, the detached commit does NOT ride in the main bundle (v2, from the §3.1 correction).
- V10 branch DELETION collision: incoming section deletes branch B while a destination worktree has B checked out → whole-section defer, no mutation.
- V11 skip-then-heal: pointer worktree with an existing captured base becomes skip-eligible (base carried, no removal memory anywhere), then the main clone is removed from the tree → pointer capture resumes over the carried base.
- V12 mixed versions: old CLI + new CLI on one workspace (see §6a) — no removal-memory stamping against main-clone or pointer sections, old client leaves new main-clone sections pending, both directions converge after upgrade.
- V13 prunable worktree entries at APPLY time: stale `.git/worktrees` entries don't produce phantom collisions (checked-out set ignores prunable entries).
- V14 submodule pointer under a refused superproject: captured exactly as today (the §3.3 skip must not touch it).

## 6a. Mixed-version workspaces (v2 — codex BLOCKER)

During rollout, old and new CLIs author the same workspace: old clients
capture pointer worktrees and refuse main clones; new clients do the
reverse. The §3.3 base-carry skip is what makes this benign — analysis:

- **New client, pointer sections:** carried forward, never dropped — an old
  client observing the manifest sees no absence, stamps no removal memory.
- **Old client, pointer sections:** continues fresh-capturing them
  (redundant bytes, harmless; converges when it upgrades).
- **New client, main-clone sections:** a NEW section kind of authorship old
  clients never produced. An old client's apply-side preflight refuses
  dir-repos with worktrees → the section parks as `gitPendingRemote` (base
  never advances) — pending, not corrupted, and it applies after upgrade.
- **Old client authoring a commit that omits the main-clone section:** it
  can't "omit" it — old clients don't author main-clone sections at all, and
  section absence in a *push* only affects repos that client captured before.
  The one real hazard would be an old client treating the new section's repo
  as REMOVED (removal-memory stamp on remote absence, `sync-git.ts:443`) —
  that stamping keys on a section that *disappears*, and main-clone sections
  never disappear once authored (they defer, carry, or update). Validation
  V12 pins exactly this two-version convergence.

No capability gate is required for tier 1 under these semantics; the release
note still says "upgrade all machines for worktree state to apply
everywhere," because pending sections don't apply until the destination CLI
understands them.

## 6. Rollout

1. This doc + usage.md caveat (docs PR, now).
2. Preflight relax + capture (3.1) behind the validation matrix, pointer-dedup
   (3.3), apply-side collision defer (3.2) — one implementation PR; matrix
   runs as tests plus one live two-machine validation before release notes
   claim worktree support.
3. Status exclusions line (3.4) — can ride with the implementation PR or
   separately.
4. Marketing caveat removal + "worktrees supported" release note only after
   V1–V8 pass live.

---

## v2 — codex review resolutions (2026-07-06)

Codex adversarial review: 2 BLOCKER + 4 MAJOR + 2 MINOR, all accepted and
folded into the sections above. Recorded here per repo convention:

- **B1 (apply collision):** the claim "git already refuses updating a
  checked-out branch" was FALSE for rbox's apply path — it publishes via
  `git update-ref`, which silently moves a sibling worktree's checked-out
  branch (`apply.ts:36` documents the hazard). §3.2 now makes the
  worktree-list pre-check mandatory safety logic intersecting updates,
  deletions, and HEAD moves.
- **B2 (mixed-version rollout):** unaddressed in v1. New §6a analyzes
  old/new-CLI coexistence; the §3.3 base-carry skip is what keeps removal
  memory out of the fight; V12 pins convergence.
- **M1 (`bundle --all` sees worktree HEADs):** rev-list `--all` examines all
  worktrees; fixed to `--single-worktree --all` (§3.1, V9).
- **M2 (partial apply):** "non-colliding refs proceed" contradicted
  base-carry semantics; whole-section defer, no partial mutation (§3.2).
- **M3 (submodule regression):** the pointer skip must not sweep submodule
  checkouts (their superproject stays refused; nothing else carries their
  store). Skip is linked-worktrees-only, and only when the owning clone was
  captured this cycle (§3.3, V14).
- **M4 (removal-memory fight):** a drop-style skip would stamp removal
  memories and suppress resurrection; skip is now base-carry with the GC
  retention cost stated (§3.3, V11).
- **M5 (matrix gaps):** V9–V14 added.
- **m6/m7:** usage.md caveat reworded to "primary clones ineligible /
  pointer checkouts captured today"; backlog citation paths corrected.
