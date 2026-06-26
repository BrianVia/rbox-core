# Design 02 — `.git` Atomic Mirroring (Milestone 2) — v2 (narrowed)

**Status:** draft v2 (narrowed scope after codex review #1 found 6 blockers) → pending review #2. M3 (large blobs) is now done, so packs are supported.
**Implements:** roadmap M2. **Decision:** D6 (mirror `.git`) — delivered as an **opt-in** trust decision (hooks/config are a code-exec/credential vector).
**Goal:** uncommitted git state — branch, staged/unstaged changes, local-only commits, stashes, reflog — follows you between machines so you continue mid-work on the other machine. **Never producing a corrupt `.git`, never silently losing committed work.**

> v1 was rejected (6 blockers). This v2 narrows scope hard and adds real git-level verification. The full review verdict is preserved in §10; every item is addressed here.

---

## 1. Hard scope guard (preflight) — supported repos only **[R#1-MAJOR worktrees/bare/alternates]**

`.git` sync engages for a project ONLY when ALL hold; otherwise `.git` stays ignored (today's behavior) and `rbox status` says why:
- `syncGit` is explicitly enabled for the workspace (opt-in; default **off**). Reason: syncing `.git` moves config and could move hooks → code execution / credential exposure. Opt-in is the honest trust boundary.
- `.git` is a real **directory** (reject worktrees & submodules, which use a `.git` **file** pointing elsewhere).
- repo is **non-bare** (has a working tree).
- **no alternates** (`.git/objects/info/alternates` absent) and no `commondir` indirection.
Preflight uses `git rev-parse --git-dir --is-bare-repository --show-toplevel` and a stat of `.git`. Unsupported → skip with a logged reason; never half-support.

**`.git/hooks/` is never synced** even when `syncGit` is on — hooks are machine-local and executable; syncing them lets one machine run code on another. Excluded by a built-in `.git/hooks/` ignore within the git-mirror path. (`.git/config` IS synced for branch-tracking etc., with the risk documented; machine-local config splitting is a later refinement.)

---

## 2. Model: content-addressed files, transactional + verified apply

`.git` files go in the manifest content-addressed (immutable git objects dedupe beautifully; large packs now ride M3 multipart). But scan and apply treat the `.git/` subtree as an **indivisible, git-verified unit**:
- scanned only at a **quiescent + consistent** instant (§3),
- applied only via **stage → `git fsck` → receiver-quiescence → atomic swap → quarantine** (§4),
- **hashcache is bypassed for `.git`** — git files mutate in place; the `(mtime,size)` fast-path's stale-reuse tradeoff is unacceptable here. Always re-hash `.git` entries. **[R#1-MAJOR]**

---

## 3. Sending side — quiescent, consistent snapshot **[R#1-BLOCKER quiescence + integrity]**

`.git` is snapshot-eligible only when quiescent AND git confirms consistency:
- **Quiescent:** none of `*.lock` anywhere under `.git`, `gc.pid`, `objects/pack/tmp_*`, `*.tmp`, `commit-graph` lock, multi-pack-index lock; AND the `.git` subtree is mtime-stable across two checks `GIT_QUIESCENCE_MS` (1s) apart. (Covers gc/repack/pack-objects/MIDX/commit-graph that hold no index.lock.)
- **Consistent (cheap git check):** `git rev-parse --verify HEAD` resolves and `git cat-file -e <HEAD>` (the HEAD commit object exists). This catches a torn snapshot without a full fsck on every cycle (full fsck runs on the receiver, §4).

**No hybrid carry-forward [R#1-BLOCKER hybrid]:** the daemon must never publish a manifest pairing a *fresh working tree* with a *stale `.git`* — that's the `git reset --hard` data-loss trap. Rule, evaluated per cycle:
- `.git` quiescent+consistent → snapshot it fresh; commit working tree + fresh `.git` together.
- `.git` busy BUT unchanged since the last snapshot (matches base) → safe to commit working-tree changes carrying the *identical* prior `.git` entries (`.git` isn't seen as changed/deleted).
- `.git` busy AND changed since base → **defer the entire repo commit** until `.git` settles (bounded; loud `status`/log if it stays busy). Working-tree changes wait for the repo to be consistent. Correctness over latency; git ops are usually sub-second.

**Immutable upload [R#1-BLOCKER snapshot]:** hashes and uploads come from a **staged copy** of `.git` (hard-link/copy into `.rbox/state/git-snap/<seq>/` at the quiescent instant), never from live `.git` (a pack can be repacked between scan and upload). M3's content-addressed upload dedupes the staged objects.

---

## 4. Receiving side — stage → fsck → quiescence → atomic swap → quarantine **[R#1-BLOCKER receiver swap]**

`.git` entries are never written into the live `.git`. Instead:
1. **Stage** all incoming `.git/` entries into `.git.rbox-staging-<id>/` (streamed from blob store).
2. **Deep verify:** `git --git-dir=.git.rbox-staging fsck --connectivity-only --no-dangling`. Failure → discard staging, skip this `.git` update (retry later). This is the real integrity gate (catches missing objects/packs, broken MIDX, `.idx`-without-`.pack`).
3. **Receiver quiescence:** the live `.git` must have no `*.lock` / active op. If the receiver is mid-`git` operation, **defer the swap** — never swap `.git` out from under a running local git (which could write into the quarantined dir and lose a commit).
4. **Whole-tree precondition:** the live `.git` must still match the reconcile base. If it changed locally since base → both sides diverged → **whole-`.git` conflict** (§5).
5. **Atomic swap:** `rename(.git → .git.rbox-quarantine-<ts>)`, `rename(staging → .git)`. The live `.git` is absent only between the two renames (sub-ms).
6. **Quarantine, don't delete [R#1-BLOCKER]:** keep `.git.rbox-quarantine-<ts>` (GC after a grace window) so anything a racing local op wrote into the old dir is recoverable. Quarantine/staging dirs use ignore-listed prefixes.

---

## 5. Whole-`.git` conflict — recoverable, surfaced **[R#1-MAJOR recoverability]**

Both sides changed `.git` → never a per-object merge. Before swapping in the remote `.git`, **preserve local recoverably**:
- `git bundle create .rbox/conflicts/<device>-<ts>.bundle --all` (+ stash/reflog refs) so every local-only commit is recoverable, plus a copy of the working-tree dirty state.
- Record the conflict in `rbox status` (loud), not just a hidden dir.
Then swap in remote. The user runs `git fetch .rbox/conflicts/<...>.bundle` to recover. No silent loss.

---

## 6. Files touched

| File | Change |
|---|---|
| `src/engine/git-mirror.ts` | **new** — preflight, quiescence+consistency, staged snapshot, fsck verify, atomic swap+quarantine, bundle-conflict |
| `src/engine/ignore.ts` | `.git/` ignored unless `syncGit`; always ignore `.git/hooks/`; staging/quarantine prefixes |
| `src/engine/manifest.ts` | when `syncGit`+eligible, snapshot `.git` via git-mirror (quiescent) or carry-forward; bypass hashcache for `.git` |
| `src/engine/reconcile.ts` | escalate any `.git/` divergence to a whole-subtree conflict |
| `src/engine/apply.ts` | route `.git/` actions to git-mirror transactional swap, not per-file |
| `src/cli/config.ts` | `syncGit` flag (default false) |
| `src/cli/daemon.ts` | defer whole-repo commit while `.git` non-quiescent+changed; pause git-area watch during swap |

---

## 7. Verification plan

**Unit:** preflight rejects worktree/bare/alternates; quiescence detects `index.lock`/`gc.pid`/`tmp_*`; hashcache bypassed for `.git`; deferral logic (busy+changed → defer; busy+unchanged → carry forward); fsck rejects a tampered staged tree; conflict path emits a bundle.

**Local integration:** real repo in dir A (commits, staged changes, a stash, a branch); daemon mirrors `.git` to B; `git -C B status/log/stash list` match A; **`git -C B fsck` clean**. Hammer commits during sync → B never corrupt (worst case stale). Diverge both repos → bundle conflict, both recoverable.

**Cross-machine (real test):** Mac repo ↔ prod host. Branch + staged change + local commit + stash on Mac → appears on prod, `git fsck` clean, `git status`/`git log`/`git stash list` match. Local commit on prod → returns to Mac. Diverge both → conflict bundle, recover local commits. Tear down `~/rbox-lab`.

---

## 8. Open questions for review #2

1. Deferral when `.git` is busy+changed: is "defer the whole repo commit" the right call, or should working-tree changes still flow with a clearly-tagged "git-pending" manifest the receiver won't reconcile `.git` from? Trade-off: latency vs a tagging mechanism.
2. Consistency smoke (`rev-parse HEAD` + `cat-file -e HEAD`) on send vs full `fsck` only on receive — enough on the send side, or do we need more (e.g. verify index parses, refs resolve)?
3. Receiver quiescence + whole-tree precondition: any remaining swap race if a local `git` starts *between* the precondition check and the rename? (Same class as M1's apply TOCTOU — bounded, documented?)
4. `syncGit` default off — agree given hooks/config risk, even though D6 said "mirror"? Hooks excluded always; is syncing `.git/config` acceptable or should it be filtered/split now?
5. Staged-snapshot cost: hard-link copy of `.git` at quiescence — acceptable for large repos, or should we snapshot only changed refs/objects since last sync?
6. Bundle-based conflict preservation: is `git bundle --all` + working-tree copy sufficient to fully reconstruct "mid-rebase" state, or are there states (REBASE_HEAD, MERGE_HEAD, sequencer) needing explicit capture?

---

## 9. (resolved-checklist for review #1 follows in §10)

## 10. Codex review #1 — blockers (now addressed in v2 above)

1. quiescence not a safety boundary → §3 (gc.pid/tmp_*/MIDX/commit-graph + 2-sample stability + git consistency check).
2. integrity too shallow → §4 (real `git fsck --connectivity-only` on the staged tree before swap).
3. sender lacks immutable snapshot → §3 (staged copy at quiescent instant; upload from staging).
4. receiver swap erases active op → §4 (receiver quiescence + whole-tree precondition + quarantine, never immediate delete).
5. carry-forward hybrid states → §3 (no fresh-tree+stale-git commit; defer when `.git` busy+changed).
6. depends on large blobs → resolved (M3 done).
7. `.git` not always a dir → §1 (preflight rejects worktrees/bare/alternates).
8. conflict recoverability → §5 (`git bundle` + surfaced in status).
9. pack churn defeats dedup → accepted; M3 multipart + content-addressing; gc/repack churn is a known cost (throttle later).
10. hooks/config hazard → §1 (`syncGit` opt-in; `.git/hooks/` never synced).
11. hashcache unsafe for `.git` → §2 (bypass cache for `.git`).
