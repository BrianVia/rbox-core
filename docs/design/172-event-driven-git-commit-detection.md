# 172 — Event-driven git-commit detection

Status: **v1 — pending review**
Owner: Claude (founder-directed, 2026-07-21)
Origin: two-machine propagation measurement (design-170 follow-up). A commit on
host A took ~52 s to reach host B; **~31 s of that was host A's daemon simply not
noticing the commit.** The WebSocket + receive path is healthy (`notify_latency_ms=224`);
this is a pure *send-side detection* latency.

## Problem (field evidence)

Measured Mac→flat-meadow, both on v1.7.12, workspace idle otherwise:

| phase | time |
|---|---|
| commit → daemon **captures** it (`git-sync: captured 1`) | **~31 s** |
| capture → push published | ~11 s |
| push → host B receive (`notify_latency_ms=224`) + git-apply | ~10 s |

The ~31 s is not capture cost — it is *trigger* latency. Root cause, confirmed in
code:

1. **The file watcher hard-excludes `.git`.** Two layers in `src/engine/ignore.ts`:
   the native prune globs (`ALWAYS_NATIVE_PRUNE = {node_modules,.git,.rbox}` at
   `ignore.ts:150`, expanded to `**/.git` + `**/.git/**` by `nativePruneGlobs`
   `ignore.ts:161-168`) keep `.git` events off the OS stream entirely, and the
   authoritative JS matcher `isHardExcluded` (`ignore.ts:242-246`) drops any
   surviving `.git/**` event. A commit mutates **only** files under `.git/`
   (`HEAD`, `refs/heads/<b>`, `packed-refs`, `logs/HEAD`, `index`), so it produces
   **zero watcher events**.
2. **git-sync capture runs only on a push.** `planGitSections` is invoked inside
   the push phase (`src/cli/sync/push.ts:397-404` → `src/cli/sync-git/plan.ts:98`
   → `captureGitState`, `src/engine/git/capture.ts:177`). A push is requested only
   by: file-watcher settle (`daemon.ts:514-519` → `request("push")`), scan/pull
   completion (`daemon.ts:957-962,982` → `requestPush()`), or write-finish retries
   (`daemon.ts:1297`). **A git commit triggers none of these.**
3. **So a commit is noticed only when the periodic safety scan fires** and drives
   the follow-on push. The safety tick floors at `SAFETY_SYNC_MS = 60_000`
   (`policy.ts:6`), ±25 % jitter, and *doubles toward `SAFETY_SYNC_MAX_MS = 300_000`
   when idle* (`nextSafetyDelay`, `policy.ts:107-111`). A commit lands uniformly
   within the current interval ⇒ **expected wait ≈ 30 s** (worst steady-state ~75 s;
   minutes if idle-backed-off).

## Why the fix is small

The expensive machinery — capture, encrypt, bundle, upload — is downstream of a
**cheap, already-existing gate**. For an unchanged repo, `planGitSections` takes
the fingerprint fast path: stat-only on `.git`, **zero git subprocesses**
(`plan.ts:671-694`, `stats.fpHits++`; fingerprint reads `packed-refs` + the
`refs/` tree at `src/cli/sync-git/fingerprint.ts:204-214`). The per-repo
"changed?" decision is `carryMatrixMatches` (`src/cli/sync-git/shared.ts:68`)
comparing a plaintext identity key `head|indexTree|refs|ops`
(`src/engine/git/identity.ts:92`) against the persistent divergence cache
(`.rbox/state/git-divergence.json`, `divergence-cache.ts:10`).

**The only missing piece is a prompt `request("push")` when a commit lands.** The
capture path is unchanged.

## Mechanism

Add an **event-driven git ref-surface watch** that fires `request("push")` on
commit, so `planGitSections` runs within one debounce (~400 ms) instead of ~30 s.
The safety scan stays as the correctness backstop.

### What to watch (the ref surface, never objects)

Per discovered repo, watch **only** the commit-signal paths:
- `.git/HEAD` (branch switch / detached commit)
- `.git/refs/**` (loose refs — `refs/heads`, `refs/tags`, `refs/remotes/*`)
- `.git/packed-refs` (packed refs after gc/repack)
- Worktree/submodule equivalents: a linked worktree's per-worktree refs live under
  the base repo's `.git/worktrees/<name>/` (HEAD, refs), and its object store /
  logical history rides the base clone (see `plan.ts:735-746` skip policy) — watch
  the base commondir's ref surface + each worktree's `HEAD`.

**Explicitly NOT watched:** `.git/objects/**` (loose-object churn on every fetch =
huge volume + inotify-descriptor blowup, and carries no ref signal), `.git/logs/**`
(reflog; `logs/HEAD` moves on every commit but is redundant with refs and noisy),
`.git/index` / `.git/*.lock` (working-index churn, already covered by the normal
file path for tracked working-tree files; not a committed-state signal).

### Cross-OS: ride the existing watcher, don't add an OS-specific path

The daemon already runs one recursive `@parcel/watcher` stream (FSEvents on macOS =
O(1); inotify per-dir on Linux), selected by `loadHostBinding` (`watcher.ts:188-202`),
with a coalescing batcher (debounce 400 ms / maxWait 3000 ms, `watcher.ts:210-211`).
**Decision (pinned): approach (a) — narrow the `.git` prune** so the ref surface
flows through the *same* stream, rather than standing up a second watch mechanism.
Rationale: one cross-OS abstraction, one batcher, one lifecycle; a separate
per-repo watch would add ~low-hundreds of inotify descriptors on Linux and a
parallel teardown path. Approach (b) (separate targeted watch) is the fallback if
the carve-out proves too invasive.

The carve-out is an **allow-list that runs before the `.git` hard-exclude**, in the
two ignore layers:
1. **`isHardExcluded` (`ignore.ts:242-246`)** — before the `.git/` clauses, admit
   an exact allow-set: a path is a git-ref-signal iff it matches
   `(^|/)\.git/(HEAD|packed-refs|refs/.*)$` OR `(^|/)\.git/worktrees/[^/]+/(HEAD|refs/.*)$`.
   Ref-signal paths bypass the exclude; everything else under `.git/` stays hard-excluded.
2. **`nativePruneGlobs` / `ALWAYS_NATIVE_PRUNE` (`ignore.ts:150,161-168`)** — replace
   the blanket `**/.git` + `**/.git/**` prune with a set that prunes the noisy
   subtrees (`**/.git/objects/**`, `**/.git/logs/**`, plus the many non-ref files)
   but admits `**/.git/HEAD`, `**/.git/packed-refs`, `**/.git/refs/**`,
   `**/.git/worktrees/*/HEAD`, `**/.git/worktrees/*/refs/**`. Parcel's `ignore`
   takes globs; confirm negation/precedence semantics (see Open decisions).
3. `BUILTIN_IGNORE` `.git` entry (`ignore.ts:12-17`) consulted by `ignores()`/
   `prunes()` — same carve-out.

### Trigger wiring

A ref-surface event must route to a **push request only**, not the normal file
reconcile (these paths are NOT synced as files). At the watcher→daemon seam
(`daemon.ts:514-519` `onSettle`), classify events: a ref-signal event calls
`this.noteChurn(); this.request("push")` **without** pushing the path into
`pendingEvents` (it is not a workspace file to reconcile). Everything else keeps
today's behavior. Because `planGitSections` runs on every push and is
fingerprint-gated, no other change is needed downstream.

- Lifecycle: no new timer/stream — it rides the existing watcher started in
  `startLiveWatch` (`daemon.ts:507-511`) and torn down in `stop()` (`daemon.ts:649-677`).
- Debounce: the existing batcher already coalesces the multi-file burst of one
  commit (HEAD + ref + packed-refs) into one settle → one push.

## Contracts

- **Ref-signal predicate** (single source of truth, unit-tested): a relPath is a
  git-ref-signal iff, for some ancestor `.git` dir, it is exactly `HEAD`,
  `packed-refs`, under `refs/`, or under `worktrees/<w>/{HEAD,refs/}`. Used by BOTH
  the ignore carve-out (admit) and the daemon classifier (push-not-reconcile).
- **No file-sync of `.git`**: ref-signal paths are never added to `pendingEvents`,
  never manifested, never uploaded as files. `.git` remains excluded from the file
  manifest exactly as today; only *watcher visibility* of the ref surface changes.
- **Backstop preserved**: the safety scan (`policy.ts:6`) and deep scan
  (`policy.ts:19`) still run unchanged; ref-watch is a latency optimization on top,
  and a dropped ref event self-heals at the next scan (identical to how dropped
  file events heal today).
- **Idempotent / cheap on spurious events**: a `git gc`/repack rewrites
  `packed-refs` with no logical change → a ref event → prompt push →
  `planGitSections` computes the same identity key → `carryMatrixMatches` carries →
  `gitUnchanged` (`push.ts:506`) → **no capture, no network push**. Spurious ref
  events cost one stat-fingerprint, not a push. (This is the detection-side of the
  founder's "don't push what the server already has"; the *separate* two-writer
  bundle-nondeterminism divergence is design 173, not in scope here.)

## Tests the implementation MUST write

1. **Ref-signal predicate** table test: `HEAD`, `packed-refs`, `refs/heads/x`,
   `refs/tags/x`, `refs/remotes/o/x`, `worktrees/w/HEAD`, `worktrees/w/refs/heads/x`
   are signals; `objects/ab/cd…`, `logs/HEAD`, `index`, `config`, `HEAD.lock`,
   `refs/heads/x.lock`, and any non-`.git` path are NOT.
2. **Carve-out**: the ignore matcher admits ref-signal paths and still hard-excludes
   `objects/**`, `logs/**`, `index`, arbitrary `.git/foo`; a `.rboxignore` cannot
   re-hide the ref surface, and cannot un-hide `objects`.
3. **Detection latency (integration)**: with a live watcher, a `git commit` in a
   tracked repo triggers a `request("push")` within the debounce window, NOT at the
   60 s safety-scan tick. Assert a push runs << 60 s after commit.
4. **Push-not-reconcile**: a ref-signal event enqueues a push but adds nothing to
   `pendingEvents`; `.git` files never enter the file manifest.
5. **Spurious repack is a no-op**: simulate a `packed-refs` rewrite with unchanged
   ref shas → a push is requested → the git plan carries (0 captured), no upload.
6. **Backstop still heals a dropped ref event**: with the ref-watch suppressed, the
   commit is still captured by the safety scan (regression guard that we didn't
   remove the floor).
7. **Worktree commit**: a commit in a linked worktree (refs under
   `worktrees/<w>/`) is detected.
8. **Lock/partial-write hygiene**: a `refs/heads/x.lock` create/delete during a
   commit does not spuriously fire or wedge (debounce coalesces; lock files are not
   signals).

## Non-goals

- **Not** watching `.git/objects`, `.git/logs`, or the index (volume/no-signal).
- **Not** touching the capture/bundle/encrypt/upload machinery or the identity/
  fingerprint gating — the fix is purely the *trigger*.
- **Not** syncing `.git` as files — `.git` stays out of the manifest.
- **Not** fixing two-writer spurious divergence (identical logical state, different
  bundle/pack bytes ping-ponging) — that is a separate, deeper design (173).
- **Not** changing the safety-scan cadence — the scan remains the backstop.

## Validation

Founder-directed rig (already stood up): a **dev build to the Mac (APFS) and
flat-meadow (EXT4)**, both on the same Development workspace (flat-meadow pull-only).
Re-run the A→B probe (`scratchpad/ab-clean.sh` shape): expect the send-side capture
phase to collapse from ~31 s to sub-second, so A→B propagation drops from ~52 s to
~git-apply-bound (~10 s, itself a separate APFS/EXT4 line of investigation). Verify
on BOTH OSes (macOS FSEvents + Linux inotify) that ref events flow and objects
churn does not. Check no descriptor/overflow regression on the Linux host under a
`git fetch`-heavy repo.

## Open decisions (for review)

1. **Parcel `ignore` glob precedence** — does `@parcel/watcher`'s `ignore` support
   the admit-narrow-subtree pattern, or does it only *add* prunes (no negation)? If
   it can't express "prune `.git/**` except `refs/**`", the native layer must prune
   the *specific* noisy subtrees (`objects`, `logs`, …) rather than all of `.git`,
   and the JS matcher does the fine-grained admit. Confirm against the parcel binding.
2. **Descriptor budget on Linux** — un-pruning `refs/**` for ~100 repos adds inotify
   watches per refs subdir. Quantify against `fs.inotify.max_user_watches`; if a
   concern, fall back to watching only `HEAD` + `packed-refs` + `refs/heads` (drop
   `refs/tags`/`remotes`) or approach (b).
3. **`logs/HEAD` as a cheaper single-file signal** — one file per repo, moves on
   every commit; a lower-descriptor alternative to the `refs/` subtree, at the cost
   of watching a `logs/` path we otherwise prune. Weigh vs the refs subtree.
