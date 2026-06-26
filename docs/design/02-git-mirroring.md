# Design 02 — `.git` Atomic Mirroring (Milestone 2)

**Status:** ⛔ PAUSED — reordered behind M3. Codex adversarial review #1 returned NEEDS ANOTHER PASS with 6 BLOCKERS, the first being that **M2 hard-depends on M3 large-blob support** (real `.git/objects/pack/*.pack` exceed the 25MB Worker cap). Doing M3 first; this doc will be reworked (with a much narrower scope) before M2 is implemented. The full review verdict is preserved in §10 below — every item must be addressed in the next pass.

## 10. Codex review #1 — blockers to resolve before implementing (preserved verbatim intent)

1. **BLOCKER — quiescence is not a safety boundary.** `*.lock` + 1s mtime is insufficient: `git gc --auto`, `repack`, `pack-objects`/`index-pack`, `objects/pack/tmp_*`, `gc.pid`, multi-pack-index & commit-graph rewrites, fsmonitor, worktree gitdirs, and hooks all touch `.git` without the locks we check. Fix: resolve `gitdir`/`commondir` via git, reject unsupported layouts, scan ALL git temp/pid/lock patterns, require repeated full-tree stability, and verify with git itself.
2. **BLOCKER — integrity check far too shallow.** HEAD+ref+index-magic can pass while HEAD's commit/tree/blobs, parents, stash/reflog-only objects, or index blobs are missing; a `.idx` without its `.pack`, or broken MIDX, also passes. Fix: run `git fsck` (≥ connectivity-only with refs, reflogs, index roots) against the staged gitdir; reject alternates/promisor unless explicitly supported.
3. **BLOCKER — sender lacks an immutable snapshot.** `push` maps sha→path then reads live files later (`sync.ts:125,48`); a pack can be repacked/deleted between scan and upload. Fix: hash+upload `.git` from a staged immutable snapshot (or local blob cache), never from live `.git`.
4. **BLOCKER — receiver swap can erase an active local git op.** rename(live→old)/rename(staging→live)/`rm -rf old`: if local git holds `index.lock`, POSIX still renames the dir; git writes into the old dir, rbox deletes it. Open pack handles make macOS/Windows behavior platform-dependent. Fix: require RECEIVER-side git quiescence + whole-tree expected-local precondition before swap; quarantine old, never immediately delete.
5. **BLOCKER — carry-forward publishes hybrid states.** Carrying old `.git` while scanning current working tree can push tree=v2 with `.git`=v1; remote treats committed work as unstaged and `git reset --hard` discards it — and that hybrid becomes the saved base (`sync.ts:147`). Fix: if `.git` is stale, DEFER the whole-repo commit, or tag stale-git manifests so receivers don't apply/advance them. (Contradicts the §6 "mismatch harmless" claim — that claim is wrong.)
6. **BLOCKER — M2 depends on large-blob support (M3).** Worker caps blobs at 25MB (`worker.ts:17,87`); real packs exceed it. Fix: do M3 first (chosen), or hard-scope M2 to tiny repos with preflight rejection.
7. **MAJOR — `.git` is not always a directory.** Worktrees/submodules use a `.git` FILE; bare repos have none; alternates point elsewhere. Fix: M2 supports only ordinary non-bare in-root `.git` dirs; explicitly reject worktrees, bare, alternates, unsupported submodules.
8. **MAJOR — whole-`.git` conflict preserves bytes but not recoverability.** A moved-aside `.git` dir hides local-only commits. Fix: before swap, `git bundle` or namespaced `refs/rbox-conflicts/<device>/<ts>/*`, preserve dirty work as a patch/worktree copy, surface loudly in `status`.
9. **MAJOR — pack churn defeats dedup.** `gc`/`repack` rewrites packs to different bytes → giant re-uploads + possible cross-machine repack ping-pong. Fix: accept only after large-blob + throttling, or use git-aware object/bundle transfer.
10. **MAJOR — hooks/config are security & portability hazards.** Syncing `.git/hooks` lets one machine install code that runs on another; `.git/config` carries local paths, fsmonitor commands, credentials. Fix: `syncGit` opt-in/trusted; split or validate machine-local config/hooks.
11. **MAJOR — hashcache unsafe for `.git`.** `(mtime,size)` reuse is a deliberate perf tradeoff unacceptable for `.git`. Fix: bypass hashcache for `.git`; hash the staged snapshot strictly.

**Narrowed M2 scope for the redo:** ordinary non-bare repos with in-root `.git` directory ONLY (reject worktrees/bare/alternates/exotic submodules with a clear preflight); receiver-side quiescence + whole-tree precondition before swap; staged immutable upload; deep `git fsck` verification; NO hybrid carry-forward (defer whole-repo commit when `.git` is stale); conflict preservation via bundle/namespaced refs surfaced in `status`; hashcache bypassed for `.git`; `syncGit` an explicit opt-in trust decision. Requires M3 (large blobs) underneath.

---
_Original draft below (superseded by the narrowed scope above; kept for context)._

**Implements:** roadmap M2. **Decision:** D6 (mirror `.git` atomically).
**Goal:** uncommitted git state — current branch, staged/unstaged changes, local-only commits, stashes, reflog — follows you between machines, so you sit down at the other machine mid-rebase and just keep going. **Without ever producing a corrupt `.git`.**

> Why this is dangerous: a `.git` is a consistent graph. Sync it file-by-file and you get torn states — a ref pointing at an object that hasn't arrived, an `index` referencing a tree that isn't there, a `packed-refs` mid-rewrite. Git then reports corruption or silently loses work. So `.git` must move as an **atomic, quiescent, integrity-checked snapshot**, never per-file into a live repo.

---

## 1. Current state

`.git/` is in `BUILTIN_IGNORE` (`src/engine/ignore.ts`) — excluded entirely. M2 makes it a first-class, specially-handled subtree.

---

## 2. Model: content-addressed files, transactional apply

Three candidate representations:
- **(A) tar/pack the whole `.git` into one blob** — trivial atomicity, but one byte change re-uploads the entire `.git` (packs are large). Kills dedup. Rejected.
- **(B) per-file in the normal manifest** — great dedup (git objects are immutable + already content-addressed → near-perfect blob reuse across machines), but the normal per-file apply produces torn states. Unsafe alone.
- **(C) per-file in the manifest, but apply the `.git` subtree as ONE transaction** — dedup of (B) + atomicity of (A). **Chosen.**

So `.git` entries live in the manifest like any file (content-addressed, deduped), but **both scan and apply treat the `.git/` subtree as an indivisible unit**: scanned only at a quiescent instant, applied only via stage→verify→atomic-swap.

`.git` sync is gated by a workspace config flag `syncGit` (default **on**, per D6; opt-out for users who don't want history weight). When off, `.git/` stays ignored exactly as today.

---

## 3. Sending side: quiescent snapshot

### 3.1 Quiescence detection (the heuristic, prototyped first)

Only snapshot `.git` when git isn't mid-operation. Signals that it IS busy:
- Any `*.lock` under `.git/` (`index.lock`, `refs/**/*.lock`, `packed-refs.lock`, `HEAD.lock`, `*.lock` in `objects/`). Git holds these during writes.
- `.git/` (recursively, cheaply: top-level + refs + objects/pack mtimes) modified within the last `GIT_QUIESCENCE_MS` (default 1000ms).

If busy → **defer**: this scan **carries forward the previous manifest's `.git/` entries unchanged** (does NOT re-scan, does NOT drop them — dropping would propagate a `.git` deletion). Retry on the next settle/tick. This means the daemon must hand the scanner the prior `.git` snapshot to carry forward.

If quiescent → walk `.git/` normally (content-addressed entries), producing a fresh consistent snapshot.

### 3.2 Sender integrity check

Before accepting a fresh `.git` snapshot into the manifest, a lightweight consistency check (not a full `git fsck` — too slow):
- `HEAD` parses (a ref `ref: refs/...` or a 40-hex detached sha).
- the ref `HEAD` names exists (in `refs/` or `packed-refs`).
- `index` (if present) has the git index magic (`DIRC`) and parses its header.
If the check fails, the snapshot is torn (lost a quiescence race) → defer, carry forward previous.

---

## 4. Receiving side: stage → verify → atomic swap

`.git` entries in the apply set are **never written into the live `.git/`**. Instead:
1. Stage **all** incoming `.git/` entries into a sibling staging dir `.git.rbox-staging-<pid>/` (atomic file writes, content from blob store).
2. Run the same integrity check (§3.2) on the staged tree. Fail → discard staging, skip the `.git` update this round (retry later); never swap in a bad tree.
3. **Atomic swap:** `rename(.git → .git.rbox-old-<ts>)`, `rename(.git.rbox-staging → .git)`, then `rm -rf .git.rbox-old`. The live `.git` is absent only between the two renames (sub-millisecond).
4. Pause the local daemon's own git-area watching during the swap so the swap's file churn doesn't feed back.

Staging dir and old-dir names use ignore-listed prefixes so they're never scanned.

---

## 5. Whole-repo conflict (never per-object)

If both machines diverged `.git/` from base, a per-object merge is meaningless and dangerous. Reconcile escalates: **if ANY `.git/` path conflicts (or both sides changed any `.git` content vs base), treat the entire `.git/` as one conflict** — move the local `.git/` aside to `.git.<device>.<ts>.conflict/` (preserving the local repo state in full) and swap in the remote `.git/` wholesale. The user keeps both repo states and can `git fsck`/recover from the conflict copy. No partial graphs ever.

---

## 6. Interaction with the working tree

The working tree (source files) and `.git` are reconciled in the same manifest/cycle, but they can legitimately be momentarily inconsistent during sync (e.g. working-tree files arrive a beat before/after the `.git` swap). That's fine — git tolerates a working tree that's ahead/behind its index transiently, and the next safety-net reconcile converges them. We do **not** attempt to make working-tree + `.git` jointly atomic (impossible and unnecessary); each is internally consistent, which is what matters.

---

## 7. Files touched

| File | Change |
|---|---|
| `src/engine/ignore.ts` | `.git/` ignored only when `syncGit` is off; add staging/old-dir temp prefixes |
| `src/engine/git-mirror.ts` | **new** — quiescence detection, integrity check, `.git` snapshot scan, atomic swap apply |
| `src/engine/manifest.ts` | scan: when `syncGit`, snapshot `.git` via git-mirror (quiescent) or carry forward prior entries |
| `src/engine/apply.ts` | group `.git/` actions; apply them via git-mirror transactional swap, not per-file |
| `src/engine/reconcile.ts` | escalate any `.git/` divergence to a whole-subtree conflict |
| `src/cli/config.ts` | `syncGit` flag (default true) |
| `src/cli/daemon.ts` | pass prior `.git` snapshot for carry-forward; pause git-area watch during swap |

---

## 8. Verification plan

**Unit:** quiescence detects `index.lock`; carry-forward preserves `.git` when busy; integrity check rejects a torn snapshot (HEAD→missing ref); atomic-swap apply replaces `.git` wholesale and leaves no staging dirs; whole-`.git` conflict moves local aside and takes remote.

**Local integration:** real repo in dir A — make commits/stage changes; daemon syncs `.git` to dir B; `git -C B status` / `git -C B log` match A (same branch, staged state, local commits). Run `git fsck` on B → clean. Hammer with a loop of commits during sync → B never corrupt (worst case stale, never torn).

**Cross-machine (the real test):** Mac repo ↔ prod host. Make a branch + staged change + local commit on Mac; confirm it appears on prod (`git log`, `git status`, `git fsck` clean). Make a local commit on prod; confirm it returns to Mac. Diverge both → whole-`.git` conflict copy, both recoverable. Tear down.

---

## 9. Open questions for review

1. Quiescence heuristic: is `*.lock` absence + 1s stability sufficient, or are there git operations that hold no lock yet leave `.git` inconsistent (e.g. background `gc`, `pack-objects`)? Should we also check for `.git/gc.pid` / `.git/objects/pack/*.tmp`?
2. Integrity check depth: is HEAD+named-ref+index-magic enough, or do we need to verify the HEAD commit object is actually present in `objects/` or a pack? (Cheap-ish: resolve HEAD sha, check loose object path or pack index.)
3. Atomic swap window: any way to shrink the "`.git` absent between two renames" gap further, or is it acceptable given it's sub-ms and the daemon pauses its own watch?
4. `syncGit` default — on (per D6) or off given `.git` size/bandwidth? Plan-gate it later?
5. Carry-forward coupling: scanner needs the prior `.git` snapshot when non-quiescent. Cleanest place to thread that — daemon in-memory manifest only, or also persist for CLI one-shots?
6. Huge `.git` (packs hundreds of MB): does the 25MB dev blob cap (pre-M3) block large pack files? Likely yes → M2 may need M3's large-blob path first, or a temporary higher cap. Sequencing question.
