# Design 02 — Git State Sync (Milestone 2) — v3 (git-native, bundle-based)

**Status:** ✅ IMPLEMENTED & VERIFIED (git-native v3). v1/v2 (file-mirror) rejected — copying a live `.git` is never atomic; v3 uses git's own consistent tools. A code review (FIX-FIRST) caught 5 safety gaps, all resolved (rollback on fsck-fail, section validation, ref-namespace restriction, temp-rename restores, fail-closed quarantine, non-clobbering conflict, write-tree stable identity). Verified: 3/3 isolation + 9/9 integrated CLI + **8/8 cross-machine Mac↔prod** — `git fsck` clean both ways, bidirectional, branches/staged/stash preserved.
**Implements:** roadmap M2. **Decision:** D6 (move git state) — delivered **opt-in** (`syncGit`, default off) because git config/hooks are a code-exec/credential vector.
**Goal:** branch, staged/unstaged changes, local-only commits, stashes, and in-progress ops follow you to the other machine, so you continue mid-work. **Never a corrupt repo, never lost committed work.**

> Review history (full detail in §11): v1 → 6 blockers; v2 → still NEEDS ANOTHER PASS (atomicity of live-tree copy; base-advance; staged-upload; bundle-`--all` gaps; preflight gaps). v3 dissolves the atomicity blocker by construction.

---

## 1. Why bundle, not file-mirror

`git bundle` / `git` object reads are **consistent on a live repo by design** — that's why you can clone a repo someone is actively committing in. Git objects are immutable and content-addressed; refs are read atomically. So:
- **History (objects + refs + stash):** captured by `git bundle` — consistent regardless of concurrent writes. This is the part whose torn state would be catastrophic, and git guarantees it for us.
- **Index, HEAD, op-state (MERGE_HEAD/REBASE_HEAD/sequencer/…):** small files git writes via **atomic rename**, so a plain copy is never torn. Captured individually.
- **Working tree (tracked edits + untracked files):** already synced by rbox as normal files — **not** part of this milestone's git artifacts.

Worst case under any race becomes "an in-progress rebase didn't transfer cleanly," never "corrupt object DB / lost commits."

---

## 2. Representation: a `git` section in the manifest (not in the working tree)

The manifest gains an optional `git` section, separate from `files`, holding content-addressed artifacts (uploaded as ordinary blobs, deduped, M3-sized) — **never materialized as working-tree files** (so we don't pollute the user's tree or recurse):

```
manifest.git = {
  bundleBlobs: string[]   // sha(s) of incremental bundle(s); basis chain
  basisRefs:   {ref: sha} // ref→sha snapshot this bundle chain reproduces
  head:        string     // HEAD contents ("ref: refs/heads/x" or detached sha)
  indexBlob?:  string     // sha of .git/index
  opState?:    {name: sha}// MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD, rebase-merge/**, rebase-apply/**, sequencer/**
  generatedAt: string
}
```

Reconcile treats `git` as **one indivisible unit** (3-way on its identity), never per-object. Its presence/identity is a single hash for diffing.

---

## 3. Preflight — supported repos only (hardened) **[R#2 preflight gaps]**

`syncGit` engages only when ALL hold (else `.git` stays ignored, `status` says why):
- `syncGit` enabled (opt-in trust decision); `.git/hooks/` is **never** captured (machine-local, code-exec).
- `git rev-parse --is-inside-work-tree` true, **not** bare (`--is-bare-repository` false), and `--show-toplevel` **=== the sync root** (the repo isn't a parent/child of root).
- `.git` is a real directory (reject gitfile worktrees/submodules).
- No alternates (`objects/info/alternates`), no `.git/worktrees/` (this repo is a primary with linked worktrees — refuse), no `.git/modules/` submodule object stores in scope.
- No `GIT_DIR`/`GIT_OBJECT_DIRECTORY` env contamination (resolve via a clean git invocation).
Resolution runs git directly; any ambiguity → refuse (never half-support).

---

## 4. Sending — incremental bundle + atomic small-file capture

When `syncGit` and the repo is quiescent-enough (no `*.lock`/`gc.pid`/`tmp_*`; HEAD resolves), produce the `git` section into a temp staging dir (nothing read from live `.git` except via git itself):
1. **Enumerate refs:** `git show-ref` + `git rev-parse HEAD` + stash (`refs/stash`) + any pseudo-refs that name commits (MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD) so reflog/pseudoref-only commits are included. **[R#2: `--all` insufficient]**
2. **Incremental bundle:** if a prior `basisRefs` synced and its commits exist locally, `git bundle create staged.bundle <reachable-not-in-basis>` (basis chain); else a full bundle (bootstrap). `git bundle verify` it. Upload as a blob (M3). Keep the basis chain so receivers can apply in order.
3. **Index/HEAD/op-state:** copy `.git/index`, HEAD, and present op-state files (atomic-rename-written by git → never torn). Upload as blobs.
4. Assemble `manifest.git`. Because history rides the bundle (git-consistent) and the rest are atomic single files, **the snapshot needs no whole-tree copy and no fragile quiescence for object consistency** — quiescence only gates the small-file capture, and those are individually atomic anyway.

**No hybrid commit [R#1/R#2]:** the `git` section and working-tree `files` are committed together. There is no "fresh tree + stale git" because the git section is regenerated each commit from the same instant; if git is mid-write we still get a consistent bundle (git guarantees it) — the only deferral is if `git rev-parse HEAD` fails (repo genuinely inconsistent, e.g. fresh `git init` with no commits → then `git` section is empty/НЕ-applied, working tree syncs normally).

---

## 5. Receiving — add objects, set refs, restore state, atomically, under receiver quiescence **[R#2 receiver]**

Applying a remote `git` section (when it differs from local) under **receiver quiescence** (no local `*.lock`; if the local user is mid-git-op, defer):
1. Download bundle blob(s) to temp; `git bundle verify` each.
2. **Add objects (non-destructive):** `git fetch <bundle> 'refs/*:refs/rbox-incoming/*'` then verify connectivity — objects are immutable, this never harms local.
3. **Whole-repo precondition:** if local refs/HEAD/index changed vs base (both sides diverged) → **conflict** (§6) before mutating anything.
4. **Publish refs/HEAD:** update local refs to the remote `basisRefs` set, set HEAD, restore `index` and op-state via atomic writes. (Ref updates are atomic per-ref; the object DB already has everything from step 2.)
5. `git fsck --connectivity-only` + `git status` sanity. On failure, roll back refs/HEAD/index from a pre-change quarantine bundle (step 6).
6. **Quarantine prior:** before step 4, `git bundle create .rbox/quarantine/<ts>.bundle --all` of the local state so the pre-apply repo is fully recoverable. GC after a grace window.

No `.git` directory swap, no "absent for a moment" window — the live repo is only ever fast-forwarded with new objects + atomic ref/index updates.

**Base-advance correctness [R#2 BLOCKER]:** the reconcile base for the `git` section advances to the remote's `git` section **only if the git apply actually succeeded**. If it deferred (receiver busy) or failed (fsck), `saveState` keeps the *prior* git-section base so the next cycle retries — never recording an unapplied remote git state as the base (which would later push stale local git over remote committed work). `pull` returns the actually-applied git identity; state is saved from that, not blindly from remote.

---

## 6. Conflict — whole-repo, recoverable, surfaced **[R#1/R#2 recoverability]**

Both sides changed git state → never per-object. Preserve local fully first: `git bundle create .rbox/conflicts/<device>-<ts>.bundle --all` plus stash + pseudo-refs, and a copy of `index`/op-state, recorded loudly in `rbox status`. Then apply remote (§5). The user recovers via `git fetch .rbox/conflicts/<...>.bundle 'refs/*:refs/rbox-recovered/*'`. Committed work is always recoverable.

---

## 7. Files touched

| File | Change |
|---|---|
| `src/engine/git-state.ts` | **new** — preflight, ref/bundle/index/op-state capture, bundle verify, receiver apply (fetch+refs+restore), conflict bundle, quarantine |
| `src/engine/types.ts` | `Manifest.git?` section type |
| `src/engine/manifest.ts` | when `syncGit`+eligible, populate `manifest.git` via git-state (bundle, not file walk); `.git/` excluded from `files` |
| `src/engine/diff.ts`/`reconcile.ts` | treat `git` section as one unit; 3-way; whole-repo conflict |
| `src/engine/apply.ts` | apply `git` section via git-state receiver flow (separate from file actions); report applied identity |
| `src/cli/sync.ts` | thread applied-git identity into saved base (base-advance correctness) |
| `src/cli/config.ts` | `syncGit` flag (default false) |
| `src/cli/index.ts` | `rbox status` surfaces git-sync state + conflicts |

---

## 8. Verification plan

**Unit:** preflight rejects worktree-file/bare/alternates/`.git/worktrees`/`GIT_DIR`/toplevel≠root; bundle round-trips a repo's refs+stash; incremental bundle basis chain reconstructs; index/op-state capture+restore; base does NOT advance when git apply is deferred.

**Local integration:** repo A with commits, staged changes, a stash, a feature branch, and a paused `git rebase -i` (REBASE_HEAD/sequencer); sync to B; on B: `git fsck` clean, `git log`/`git status`/`git stash list`/`git branch` match A, and the rebase can be continued. Hammer commits during sync → B never corrupt. Diverge both → conflict bundle, both recoverable.

**Cross-machine (real test):** Mac repo ↔ prod host. Branch + staged + local commit + stash on Mac → prod matches, `git fsck` clean. Local commit on prod → returns to Mac. Diverge both → conflict bundle; recover local commits. Tear down `~/rbox-lab`.

---

## 9. Open questions for review #3
1. Incremental bundle basis chain: store basis as refs→shas; if the receiver lacks a basis commit (gc'd remotely), fall back to a full bundle — detection/sequencing right?
2. Ref publishing in §5 step 4: set local refs to exactly the remote set, including deletions of local refs absent remotely (when local==base). Safe via the conflict gate? Any ref a user expects kept that we'd drop?
3. Is `git fetch <bundle>` into `refs/rbox-incoming/*` + connectivity check the right non-destructive object import, vs `git bundle unbundle`/`git index-pack`?
4. Op-state completeness for "continue mid-rebase": REBASE_HEAD + rebase-merge/ + sequencer/ + ORIG_HEAD + index — is that the full set, or are there more (e.g. `rebase-apply/` for `am`, `.git/MERGE_MSG`)?
5. Performance: full bundle on bootstrap of a large repo is heavy but one-time; incremental after. Acceptable for opt-in M2, or gate bundle generation behind a debounce so rapid commits don't re-bundle each time?
6. Base-advance: is threading "applied git identity" through `pull`→`saveState` the cleanest fix, or should the git section be a separate sync stream with its own sequence?

## 10. (review history)
## 11. Prior review verdicts
- **v1 (file-mirror):** 6 blockers — quiescence not a safety boundary; shallow integrity; no immutable snapshot; receiver swap erases active op; hybrid carry-forward; depends on large blobs; `.git`-as-file; conflict recoverability; pack churn; hooks/config; hashcache. (M3 done resolves the large-blob dependency.)
- **v2 (narrowed file-mirror):** NEEDS ANOTHER PASS — live-tree copy still not atomic (the recurring root cause); base-advance BLOCKER; staged-upload must not read live `.git`; `bundle --all` misses reflog/pseudoref commits; preflight gaps. v3 addresses all by switching to git-native capture: history via consistent `git bundle`, atomic single-file index/op-state, explicit pseudo-ref enumeration, hardened preflight, base-advance-only-on-success, non-destructive receiver fetch.
