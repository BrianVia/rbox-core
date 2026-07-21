# 175 — Linux git-ref side-channel (a.k.a. 172B): event-driven refs for repos that appear after daemon start

Status: DRAFT v1 (2026-07-21). Investigation record: `RECOMMENDATION-172B.md`
(worktree root; codex xhigh, all claims independently source-verified) +
`PROBE-RESULTS.md` (empirical contract probe, 3/3 PASS). Prereq: design 172
(shipped, v1.7.13).

## Problem (field- and rig-proven)

Design 172 gives event-driven detection of `.git`-only changes (commit, amend,
branch op) — but ONLY for repos present when the daemon's Parcel watcher did
its initial crawl. Any repo that appears afterwards (`git init`, `git clone`,
atomic move-in, worktree add) never gets its ref surface watched: its
pure-`.git` commits are scan-bound at the (172-pinned) 60s floor until the
daemon restarts. Rig-diagnosed as GENERAL, not burst-specific — a 3-file
`git init` degrades identically to a 6243-file opencode clone
(run 20260720-230123: small-repo empty commit 39s scan-bound; big-repo 8.9s
scan-bound; seeded repo 3.5s event-driven).

Root cause, pinned in Parcel 2.5.6 source (verified, see RECOMMENDATION §2/§4):
the *initial* subscribe does a full FTS crawl and watches every admitted dir
(`InotifyBackend.cc:66-79`, `fts.cc:19-47`), but the *live* path for
`IN_CREATE|IN_MOVED_TO` adds ONLY the one reported directory — `watchDir`
never enumerates descendants (`InotifyBackend.cc:151-183`, `:81-94`). `.git`
subtree dirs created before Parcel arms their parent are invisible forever.
A live `inotify_add_watch` failure is silently swallowed (`:178-183`), and
`IN_Q_OVERFLOW` is silently discarded (`:96-123`). Parcel 2.6.0 does not fix
any of this. macOS is NOT affected (single FSEvents stream, full-path events,
no per-dir arming; field-verified on the founder's Mac 2026-07-21: settled
daemon, post-start repo, empty commit → event-driven).

## Fix: bounded Bun `fs.watch` ref side-channel (Linux + Parcel only)

Maintain a small registry of per-repo ref watches on Bun's built-in
`node:fs.watch`, fed by the engine's existing git discovery, signaling into
the existing 172 `SignalDebouncer` → `request("push")`. Bun's pinned 1.3.14
watcher does the two things Parcel can't (source-verified at the tag +
empirically probed):

- dynamic descendant walk: a new/moved dir under a recursive root is added
  AND its already-present children are walked (`path_watcher.zig:663-670`,
  `walkAndAdd :526-533`);
- separate process-global inotify fd + reader thread (`:454-466`) — a Parcel
  working-tree event storm cannot flood the ref queue.

Probe: 3/3 cases (fast init, atomic move-in, nested `refs/heads/a/b`), 5/5
attempts each, callback 2–17ms under 7–10k-op Parcel flood
(`scripts/probe/bun-refwatch-contract.ts`, PROBE-RESULTS.md).

### Watch roots (per unique physical repo; positive surface only)

1. shallow `gitDir` — accepts `HEAD`, `HEAD.lock`;
2. shallow `commonDir` — accepts `packed-refs`, `packed-refs.lock`; notices
   creation/replacement of `refs`;
3. shallow `commonDir/refs` — accepts `stash`, `stash.lock`; notices
   creation/replacement of `heads`/`tags`;
4. recursive `commonDir/refs/heads` + `commonDir/refs/tags`.

Shared common dirs (worktrees/submodules) are refcounted; `gitDir ===
commonDir` handles dedupe. Never watched: objects, logs, `refs/remotes`,
`refs/rbox-*`, reftable (stays scan-bound, same as 172), canonical targets
outside the sync root (no expansion of watch authority). Acceptance filtering
reuses/extends `isGitRefSignal` semantics — one predicate remains the single
source of truth for "is this a ref signal".

### Lock events are pre-signals (deliberate)

Bun coalesces same-type events within ~1ms per handler — and the suppression
is BROADER than its own doc comment claims (`shouldEmit` `:133-144` suppresses
any same-type event within 1ms regardless of path; the comment `:124-127`
describes the opposite — trust the code, we verified it). So the final
`refs/heads/X` rename may be swallowed right after `X.lock`. Therefore an
accepted `*.lock` adjacent to a watched target ALSO wakes the debouncer. An
aborted ref transaction then costs one no-op push — acceptable; the quiet
debounce normally fires after the transaction completes anyway. (The probe's
observed callbacks were the `.lock` in all 15 runs — this is the common path,
not an edge.)

### Registry lifecycle

- **Input**: physical repo contexts from the ordinary push plan's
  `discoverGitRepos` walk (`src/engine/git-discover.ts`) + `repoCtxFromDisk`
  (`src/engine/git/shared.ts`) — returned to the daemon through the internal
  push result. NOT inferred from wire manifests.
- **New-repo promptness**: a created/moved `.git` dir or pointer file is
  classified (ahead of the sync matcher, same seam as 172's classifier) as a
  *repo-candidate* signal → requests a push/discovery. Signal-only: never a
  WatchEvent, never in `pendingEvents`.
- **Arm-then-push handshake**: after all roots for a newly discovered (or
  identity-replaced) repo are armed, push the SignalDebouncer once — a ref
  mutation before arming is caught by that follow-up push; after arming, by
  the watch. No capture-to-arm gap.
- **Bounds**: cap at the existing git admission ceiling
  (`src/cli/sync-git/shared.ts`); key handles by canonical path + mode; store
  `(dev, ino)` so delete/recreate forces detach + re-arm; close handles when
  the last owning repo disappears; failed attach → pending + capped-backoff
  retry on next candidate/plan/scan; `close()` fences in-flight reconcile.
- **Serialization**: reconciliation is serialized (one at a time), and every
  error path degrades toward the scan floor, never toward silence.

### Failure surfacing (why Bun and not Parcel, restated as contracts)

- Root open/add failures SURFACE (`path_watcher.zig:245-322,480-494` — root
  errors return to caller) → log, mark pending, pin floor, retry.
- Fatal reader failure emits error to every watcher (`:568-585`) → mark
  degraded, retry/re-arm.
- Descendant add failure is SILENT-success (`:490-493`) and overflow likely
  falls through the null `wd_map` check (`:596-617`, no Q_OVERFLOW branch) —
  BOTH remain possible → the 60s floor is retained unconditionally while any
  eligible repo exists (see below). We never claim perfect watcher health.

### Safety floor becomes dynamic

172 shipped `gitRefWatchActive` as a startup snapshot. Replace with a live
view: on Linux, ANY eligible repo — watched, attaching, failed, over-cap, or
scan-bound-by-shape — holds the safety floor at `SAFETY_SYNC_MS` (60s) via
the existing `pinToFloor` seam (`policy.ts`, daemon tick). macOS keeps normal
back-off (no side-channel there at all).

### Platform / backend matrix

| Platform + backend | Side-channel | Ref detection |
|---|---|---|
| Linux + Parcel | ON | event-driven incl. post-start repos; 60s floor backstop |
| Linux + Chokidar | OFF (chokidar rides Bun fs.watch — no queue isolation) | scan-bound, 60s floor |
| macOS (Parcel/FSEvents) | OFF | event-driven via the main stream (verified); normal back-off |

## The Bun contract test is load-bearing (Rust-rewrite proof)

Founder intel (2026-07-21): Bun is rewriting Zig→Rust imminently. All
`path_watcher.zig` citations WILL go stale. Therefore:

- `scripts/probe/bun-refwatch-contract.ts` (behavior-only, no version
  sniffing, no product imports) becomes a REQUIRED gate: any Bun version bump
  must pass it before release. Wire it as a CI job or a release-checklist
  step (implementation picks the seam; the requirement is non-negotiable).
- The design's dependency is the CONTRACT (recursive-root descendant
  re-crawl + separate-queue isolation + lock-event delivery), not the zig
  source. If a future Bun fails the contract, the side-channel disables
  itself at runtime detection? NO — simpler: the contract test failing blocks
  the upgrade; runtime keeps the 60s floor regardless, so a slipped
  regression degrades bounded, not silent.

## Telemetry rider: make the drop fleet-visible

Add a `git_capture` sample to the existing client telemetry (additive
accumulator pattern, same envelope):
`{ kind: "git_capture", signalCaptures: n, scanCaptures: n }` — counting, per
window, captures whose triggering push request came from the ref/repo signal
path vs a safety scan. This is the send-side metric that lets the admin chart
the 172/175 latency cliff (receive-side ws_health/propagation can't see it).
Keep it minimal: two counters, no latency histogram (the daemon log carries
per-event forensics already).

## Inviolable invariants (carry-forward from 172 + new)

1. Ref/repo-candidate signals NEVER enter `pendingEvents`/manifest/upload.
2. Scanner/manifest `.git` exclusion untouched; receiver repos stay
   fsck-clean (rig-asserted).
3. `isGitRefSignal` remains the single classification truth; side-channel
   filtering may not fork its semantics.
4. Every failure mode degrades toward the 60s floor, never toward silence;
   the floor holds while ANY eligible repo exists on Linux.
5. No new external watch authority: nothing outside the sync root is watched.
6. macOS behavior is UNCHANGED by this design (no handles, no floor change).

## Tests the implementation MUST write

From RECOMMENDATION §5, normative here (unit/integration):
1. Watcher-first `git init` → empty commit → signal <10s; `settled`, raw
   events, `pendingEvents` all empty of git paths.
2. `git init` inside an existing dir AND at workspace root → repo-candidate
   → discovery → arm → follow-up push.
3. Atomic move-in of a populated repo → converge → empty commit event-driven.
4. Rapid nested namespace creation (`refs/heads/a/b`, tags) — lock
   pre-signals accepted; eventual push sees the ref; no `.lock` in the file
   plane.
5. Detached/worktree HEAD, packed-refs, stash, branch/tag delete,
   missing-then-created `refs/{heads,tags}`, shared-common-dir dedupe,
   pointer repos, out-of-root refusal.
6. Injected failures: root attach fail, runtime error, delete/recreate same
   relPath, over-cap, reconcile race, close-during-attach — all stay at the
   floor, retry, no handle leaks.
7. The compiled Bun contract test wired as an upgrade gate.
8. (macOS CI/dev-run) no side-channel handles created.
9. Rig: `git-commit-propagation` rounds `small-repo-empty` and
   `big-repo-empty` TIGHTEN from `degrade-bounded` back to `event-driven`
   (<30s coarse ceiling) — the scenario comments already mark them as
   awaiting this design. Rig image Bun pin must move 1.3.5 → 1.3.14 first
   (load-bearing: the dynamic descendant walk shipped between them).
10. `git_capture` telemetry: counters increment on the right trigger paths;
    contract-tested in the telemetry queue like ws_health.

## Non-goals

- No macOS side-channel; no chokidar support; no reftable watching; no
  Watchman; no Parcel fork/patch (upstream issue optional, later); no polling.
- No changes to capture/bundle/encrypt/upload, apply, purge, identity gating.
- Not addressing two-writer divergence (173) or apply-side throughput (174).

## Sizing

~300–450 production lines (new `src/cli/daemon/git-ref-watch.ts` ~200–260;
watcher.ts ~60–100; plan/push seam ~30–60; daemon wiring ~30–60; CODEMAP
line) + ~250–400 test lines + rig tightening + Dockerfile pin bump.
