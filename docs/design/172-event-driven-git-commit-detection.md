# 172 — Event-driven git-commit detection

Status: **v3 — pending review**
Owner: Claude (founder-directed, 2026-07-21)
Origin: two-machine propagation measurement (design-170 follow-up). A commit on
host A took ~52 s to reach host B; **~31 s of that was host A's daemon simply not
noticing the commit.** The WebSocket + receive path is healthy
(`notify_latency_ms=224`); this is pure *send-side detection* latency.

**v3 fold (final serial review — BLOCKER confirmed CLOSED, 5 MAJORs folded):**
(1) ref *deletions* now classified before Parcel's `unlinkDir` branch via a
watcher-local discriminated event type; (2) git-signals routed through a **new,
separate `onGitSignal` callback** (not the file `onSettle` batch, which they'd
corrupt); (3) **reftable removed from the watch** entirely (co-mingled binary refs
can't be path-filtered → pin self-echo) — reftable repos are scan-bound + a
pre-existing fingerprint gap; `refs/stash` added to the syncable set; (4) **Parcel
2.5.6 silently swallows inotify overflow** — v2's "routes through onError" was
false, so the design pivots to a **descriptor-bounded watch set** (HEAD +
packed-refs + refs/heads, not recursive refs/**) to prevent overflow rather than
recover from an undetectable one; (5) native-prune completeness for nested modules.

**v2 fold (parallel review: codex + opus + fable, all CHANGES-REQUIRED, core
approach affirmed):** the ref-signal admit is moved OUT of the shared
manifest-exclusion matcher and INTO the watcher layer only (r1 consensus BLOCKER —
loosening `isHardExcluded` would let the *scanner* manifest/upload `.git` files);
parcel `ignore` proven to lack glob negation, so the native prune targets specific
noisy subtrees; predicate corrected to exclude `*.lock`, rbox scratch pins
(`refs/rbox-wip/*` self-echo), and `refs/remotes/**` (no sync signal), and to
include submodule (`.git/modules/**`) + linked-worktree (`.git/worktrees/*/`) ref
surfaces; staged-only and reftable states explicitly classified; spurious-event
cost stated honestly; anchors refreshed.

## Problem (field evidence)

Measured Mac→flat-meadow, both on v1.7.12, workspace otherwise idle:

| phase | time |
|---|---|
| commit → daemon **captures** it (`git-sync: captured 1`) | **~31 s** |
| capture → push published | ~11 s |
| push → host B receive (`notify_latency_ms=224`) + git-apply | ~10 s |

Root cause, confirmed in code:

1. **The file watcher hard-excludes `.git`** (`src/engine/ignore.ts:150`
   `ALWAYS_NATIVE_PRUNE`, `:161-168` `nativePruneGlobs`, `:242-246` `isHardExcluded`).
   A commit mutates **only** `.git/` (`HEAD`, `refs/heads/<b>`, `packed-refs`,
   `logs/HEAD`, `index`) → **zero watcher events**.
2. **git-sync capture runs only on a push** (`src/cli/sync/push.ts:397-404` →
   `src/cli/sync-git/plan.ts:98` → `captureGitState`, `src/engine/git/capture.ts:177`),
   and a push is requested only by file-watcher settle (`daemon.ts:554-558`),
   scan/pull completion (`daemon.ts:957-982`), or write-finish retries. **A commit
   triggers none of them.**
3. **So a commit is noticed only at the periodic safety scan** (`SAFETY_SYNC_MS =
   60_000`, `policy.ts:6`, ±25 % jitter, doubling toward `SAFETY_SYNC_MAX_MS =
   300_000` when idle, `policy.ts:107-111`). Uniform arrival within the interval ⇒
   **expected ~30 s**; worst steady-state ~75 s; minutes if idle-backed-off.

## Why the fix is small

Downstream of a **cheap, existing gate**: for an unchanged repo `planGitSections`
takes the fingerprint fast path — stat-only, zero git subprocesses
(`plan.ts:671-694`; fingerprint reads `packed-refs` + the `refs/` tree,
`fingerprint.ts:204-214`). The per-repo "changed?" test is `carryMatrixMatches`
(`shared.ts:68`) comparing plaintext `identityKey = head|indexTree|refs|ops`
(`identity.ts:92`) against the persistent divergence cache
(`.rbox/state/git-divergence.json`). **The only missing piece is a prompt
`request("push")` when a commit lands.** Capture is unchanged.

## Mechanism (v2 — watcher-layer only)

Add an event-driven git ref-surface signal that fires `request("push")` on commit
so `planGitSections` runs within one debounce (~400 ms) instead of ~30 s. The
safety scan stays the correctness backstop. **The `.git` file-plane exclusion is
NOT touched** — the change is entirely in the watcher's own two filter stages.

### The seam split (r1 consensus BLOCKER)

`isHardExcluded` / `BUILTIN_IGNORE` are the **shared** exclusion consulted by the
manifest scanner (`manifest.ts:284,319,343,357,364,577-605`), git-discovery
(`manifest.ts:577`), apply-receipt drift, and purge — plus a **second** copy in
`apply-receipt.ts:222`. Loosening them would make the scanner treat `.git/refs`
as syncable files (manifest + upload them; apply-side write refs into peers'
`.git`) — the exact hazard the exclusion prevents. **So they stay fully
exclusionary and are NOT edited.** Ref-signal handling lives only where the
watcher differs from the scanner:

1. **`nativePruneGlobs` (`ignore.ts:161-168`) — watcher-only.** These globs feed
   *only* `wrapper.subscribe`'s `ignore` (`watcher.ts:260`); the scanner does not
   use them. Parcel's `ignore` has **no cross-entry negation** (confirmed against
   `@parcel/watcher/wrapper.js` — each entry is an independent `picomatch` OR-term),
   so we cannot say "prune `.git/**` except refs". Instead prune the *specific
   noisy subtrees* and admit the ref surface: prune `**/.git/objects/**`,
   `**/.git/logs/**`; admit `**/.git/HEAD`, `**/.git/packed-refs`,
   `**/.git/refs/**`, `**/.git/worktrees/*/{HEAD,refs/**}`,
   `**/.git/modules/**/{HEAD,packed-refs,refs/**}`. Consequence (stated honestly):
   the *other* non-ref `.git` files (`index`, `FETCH_HEAD`, `COMMIT_EDITMSG`,
   `ORIG_HEAD`, top-level `*.lock`) now reach the JS layer on commit/fetch and are
   dropped there (step 2); and on Linux inotify places descriptors on the admitted
   `.git` ref subdirs (see Descriptor budget).
2. **A ref-signal classifier in `watcher.ts`, BEFORE `matcher.ignores`
   (`watcher.ts:253` and `:291`).** For each delivered event: if the path is a
   **git-ref-signal** (predicate below), emit it as a distinct event kind
   (`gitRefSignal`) routed to the daemon's push-request path and **do not** run it
   through `matcher.ignores`; otherwise fall through to today's `matcher.ignores`
   (which still drops every `.git/*`). The shared matcher is untouched, so the
   scanner/apply/purge planes remain fully `.git`-excluded.

Optional future generalization (non-blocking, r1 F4): expose this as a
watcher-level `registerSignal({ predicate, kind })` so future "watch-but-never-sync"
signals don't reach into ignore internals. v2 implements the git case directly;
the seam is the same.

### The git-ref-signal predicate (single source of truth)

A relPath is a git-ref-signal iff, relative to some ancestor git-control dir
`G ∈ { <repo>/.git, <repo>/.git/worktrees/<w>, <base>/.git/modules/<name>[/modules/<n2>…] }`,
the tail is exactly `HEAD`, `packed-refs`, under `refs/heads/`, under `refs/tags/`,
or exactly `refs/stash` — the full `isSyncableRef` set (`refs/heads/*` |
`refs/tags/*` | `refs/stash`, `manifest-validate.ts:263`) plus HEAD/packed-refs —
AND none of the exclusions:
- **NOT `*.lock`** (git writes every ref via lock+atomic-rename; the lock is the
  common case, not an edge — r1 opus F2/codex 4).
- **NOT `refs/rbox-*`** (rbox's own scratch pins `refs/rbox-wip/<…>`, `pins.ts:21`,
  written+deleted on *every* capture — including them self-echoes push→capture→
  push, r1 fable 2; mirrors `RBOX_INTERNAL_REFS_EXCLUDE`, `capture.ts:31`).
- **NOT `refs/remotes/**`** (not an `isSyncableRef`; carries no sync signal, so
  watching it turns every `git fetch` into a slow-probe push, r1 fable 6).
- **NOT `.git/reftable/**`** (final-review finding 3): a reftable stores syncable +
  remote + `refs/rbox-*` scratch updates **co-mingled in one binary file**, so a
  path-only predicate cannot admit "a head changed" while excluding a scratch-pin
  rewrite — watching it re-introduces the pin self-echo and can't be filtered.
  Reftable repos are therefore **scan-bound** (and a pre-existing fingerprint gap;
  see Consciously scan-bound). v2's "add reftable defensively" was inconsistent and
  is removed.

`refs/remotes` note: because `packed-refs` is always a signal but its rewrite may
concern only remotes, a `git fetch` that repacks refs CAN fire one carry-only push
(slow probe, no upload). The validation goal is "no *capture/upload* on fetch," not
"no push signal" — stated honestly (final-review finding on remotes).

**Descriptor-bounded watch set (final-review finding 4).** The *predicate* above
classifies events; the *watch set* (which paths we register / admit through the
native prune) is deliberately narrower to bound inotify descriptors on Linux:
admit `HEAD`, `packed-refs`, and `refs/heads` (+ `refs/tags`, `refs/stash`) — NOT
the entire recursive `refs/**` tree, whose per-namespace subdirs multiply
descriptors. See Watcher-health + Open decision 2 for why this matters for
*correctness of the fast path*, not just perf.

The predicate is used by BOTH the native admit-globs and the watcher classifier, so
they cannot drift.

### Trigger wiring — a SEPARATE callback, not the file settle batch

A git-signal must **not** flow through the file-event `onSettle` batch (final-review
finding 4/2): `onSettle`'s batch drives settled-state/`pendingEvents` accounting,
and a signal-only batch (no file events) corrupts it. Instead, add a dedicated
`onGitSignal?: () => void` to `WatchOptions` (`watcher.ts:16-30`, alongside the
existing `onError`/`onRawEvent`), with its **own** debounce independent of the file
batcher. The daemon binds it to `() => { this.noteChurn(); this.request("push"); }`.
git-signal paths are classified in `watcher.ts` and routed to `onGitSignal` **only** —
they never enter the file batcher, `pendingEvents`, the manifest, or upload.

**Classification runs for every event kind, including deletes** (final-review
finding 1): a deleted branch/tag (`git branch -d`, `update-ref -d`) is a valid
committed-state signal. Parcel emits deletes as `unlinkDir` covering the path +
`path/**` (`watcher.ts:237-243`), so the git-signal predicate must be evaluated at
the *normalized-event* stage **before** the add/change/delete fork, and a matching
delete of a watched ref path routes to `onGitSignal`. Use a watcher-local
discriminated event type (`{kind:"file"|"gitSignal", …}`) so *only* file-kind
events can ever inhabit `pendingEvents`.

No new stream: it rides the existing single recursive watcher (`startLiveWatch`,
`daemon.ts:507-511`), torn down in `stop()` (`daemon.ts:649-677`). A commit's
multi-file burst (HEAD + ref + packed-refs + transient lock create/delete)
coalesces via the signal debounce into one `request("push")`.

### Watcher-health / the Parcel silent-overflow reality (final-review finding 4/5)

**Correction from v2:** Parcel 2.5.6 **silently** discards inotify `IN_Q_OVERFLOW`
and silently returns on a failed `inotify_add_watch` for a new directory
(`node_modules/@parcel/watcher/src/linux/InotifyBackend.cc`, verified in the final
review). Those failures **cannot** reach `onError` / the untrusted-watcher health
transition (`daemon.ts:530-577`). So v2's "overflow routes through `onError`" was
**false** — the daemon cannot actively detect that the ref-watch fast path has
silently died on Linux.

This is a **degradation**, not a correctness break: the safety scan
(`policy.ts:6`, independent of the watcher) still catches the commit — the machine
just falls back to today's ~60 s (or backed-off) latency **without knowing it**.
Degrade-not-worse holds; active detection does not.

The design response is therefore **prevention, not recovery**: keep the watch set
**small enough to not overflow** in the first place. Per Descriptor-bounded watch
set above, admit only `HEAD` + `packed-refs` + `refs/heads` (+ optional
`refs/tags`/`refs/stash`) — a handful of paths per repo, not the recursive `refs/**`
subtree — so even at `MAX_GIT_REPOS = 256` the added inotify descriptors stay a
small fraction of `fs.inotify.max_user_watches` (Open decision 2 quantifies).
macOS/FSEvents is unaffected (single stream, no per-dir descriptors). The `onError`
routing for the errors Parcel *does* surface (init failure, backend death) stays
wired as today; we simply don't claim to catch the ones it swallows.

## Contracts

- **Ref-signal predicate** = single tested function, used by the native admit-globs
  and the watcher classifier. Committed-history change in a syncable namespace ⇒
  a watched path is written; the predicate excludes lock/rbox/remotes.
- **`.git` stays out of the sync plane, unchanged**: `isHardExcluded`,
  `BUILTIN_IGNORE`, `apply-receipt.ts:222`, and every `matcher.ignores`/`prunes`
  consumer are byte-for-byte unchanged. Ref-signal events are `request("push")`
  only — never manifested, never in `pendingEvents`, never uploaded as files.
- **Backstop preserved**: safety scan (`policy.ts:6`) + deep scan (`policy.ts:19`)
  unchanged; a dropped ref event self-heals at the next scan (except reftable — see
  below).
- **Cheap, not free, on spurious events (r1 corrected)**: a `git gc`/repack rewrites
  `packed-refs` with unchanged shas → ref event → prompt push → because the bytes
  changed and the 2 s racy-clean margin (`divergence-cache.ts:111`) blocks a fast
  fingerprint hit, `planGitSections` slow-paths the *touched* repo (~8-10 git
  subprocesses) → `identityKey` equal → `carryMatrixMatches` carries → `gitUnchanged`
  (`push.ts:506`) → **no capture, no network push.** Cost is one slow probe per
  event-burst per touched repo, bounded; other repos stay on the fast path.

## Consciously scan-bound (documented non-coverage)

These change `identityKey` (or the published section) without writing a watched
path; they remain detected by the safety scan, not the fast path. Accepted for a
*commit*-detection design:
- **Staged-only (`git add`/`rm --cached`)** — changes `indexTree` via `.git/index`
  (unwatched). Watching `index` would fire on every `git status`/IDE poll → churn;
  identity carries anyway, so it would be trigger cost for a non-commit state.
- **In-progress op-state** (`MERGE_HEAD`, `rebase-merge/`, `CHERRY_PICK_HEAD`) and
  **`.git/config`** — gitDir children, not under refs. Nearly always co-fire a
  worktree or ref write; the residual (all-ignored conflict paths) is scan-bound.
- **Linked worktree / submodule whose gitdir is OUTSIDE the workspace root** — the
  recursive watch can't see an external commondir; scan-bound by design.
- **reftable repos (git ≥2.45, r1 fable 5)** — commits touch only `.git/reftable/*`,
  invisible to BOTH this watch AND the existing fingerprint (`fingerprint.ts:204-214`
  reads `packed-refs`+`refs/`, inert under reftable), so the "scan backstop heals
  it" claim FAILS for them (a trusted stale fingerprint can carry a reftable commit
  forever). This is a **pre-existing** fingerprint gap, not introduced here.
  **Recommendation (separate follow-up): refuse reftable in `gitPreflight`
  (`preflight.ts:29-69`)** until fingerprint+watch both learn `.git/reftable/**`.
  v3 does **not** watch reftable (a path-only predicate cannot exclude co-mingled
  scratch-pin updates in the binary table → pin self-echo, final-review finding 3);
  reftable repos are consistently scan-bound here, with the real fix (preflight
  refusal or teaching the fingerprint) flagged as separate.

## Tests the implementation MUST write

1. **Ref-signal predicate** table: signals = `HEAD`, `packed-refs`, `refs/heads/x`,
   `refs/tags/x`, `worktrees/w/HEAD`, `worktrees/w/refs/heads/x`,
   `modules/m/refs/heads/x`, `modules/a/modules/b/HEAD`; NOT = `refs/heads/x.lock`,
   `packed-refs.lock`, `refs/rbox-wip/…`, `refs/remotes/o/x`, `objects/ab/cd`,
   `logs/HEAD`, `index`, `config`, any non-`.git`.
2. **Seam isolation**: after the change, `matcher.ignores('.git/refs/heads/main')`
   and `isHardExcluded(...)` still return excluded/true; a manifest scan still never
   manifests any `.git` path (regression guard on the BLOCKER).
3. **Detection latency (integration)**: a `git commit` triggers `request("push")`
   within the debounce window, NOT at the 60 s scan; assert push << 60 s.
4. **Push-not-reconcile**: a ref-signal event enqueues a push, adds nothing to
   `pendingEvents`, and no `.git` file enters the manifest/upload.
5. **Pin self-echo suppressed**: a capture that writes/deletes `refs/rbox-wip/*`
   does NOT trigger an extra push (predicate excludes them).
6. **Spurious repack is carry-only**: a sha-preserving `packed-refs` rewrite →
   push requested → git plan carries (0 captured), no upload (slow-probe allowed).
7. **Backstop still heals a dropped ref event** (suppress the watch → commit still
   captured by the scan).
8. **Worktree + submodule commit** detected (refs under `worktrees/<w>/` and
   `modules/<name>/`).
9. **Lock churn**: `refs/heads/x.lock` create+delete during a commit neither fires
   an independent signal nor wedges (debounce coalesces).
10. **Ref deletion** (`git branch -d`, `update-ref -d`) is classified as a signal —
    including via Parcel's `unlinkDir` delete path — and triggers a push; a delete
    of a non-ref/lock `.git` path does not.
11. **Signal-only batch isolation**: a burst containing *only* git-signal events
    routes to `onGitSignal` and leaves the file `onSettle`/`pendingEvents`/settled-
    state accounting untouched (regression guard on the separate-seam requirement).
12. **Reftable repo**: a commit in a reftable repo produces NO git-signal (not
    watched) and is left to the safety scan (documents the accepted gap).

## Non-goals

- **Not** editing `isHardExcluded`/`BUILTIN_IGNORE`/`apply-receipt` or any
  `matcher.ignores` consumer — `.git` stays out of the sync plane unchanged.
- **Not** watching `.git/objects` or `.git/logs` (volume/no-signal), `.git/index`
  (staged-state churn, scan-bound by decision), or `refs/remotes/**` (no signal).
- **Not** touching capture/bundle/encrypt/upload or the identity/fingerprint gating.
- **Not** fixing the reftable fingerprint blindness (pre-existing; flagged for a
  preflight-refuse follow-up) or two-writer spurious divergence (design 173).
- **Not** changing the safety-scan cadence — it stays the backstop.

## Validation

Founder-directed rig (stood up): a **dev build to the Mac (APFS) + flat-meadow
(EXT4)**, same Development workspace (flat-meadow pull-only). Re-run the A→B probe
(`scratchpad/ab-clean.sh`): expect the send-side capture phase ~31 s → sub-second,
A→B ~52 s → git-apply-bound (~10 s; the APFS/EXT4 git-apply gap is a separate line).
Verify on BOTH OSes that ref events flow, objects churn does not reach the daemon,
a `git fetch` (writes `refs/remotes` + `FETCH_HEAD`) does NOT spuriously push, and
the Linux host shows no inotify-overflow regression under a fetch-heavy repo.

## Open decisions (for the final review)

1. **Tags in the watch set** — `refs/tags/**` is syncable but rarely the
   latency-critical path; keeping it adds descriptors. Watch heads+tags (v2 default)
   vs heads-only? Decide on the descriptor-budget evidence (#2).
2. **Linux inotify descriptor budget — now correctness-adjacent, not just perf**
   (because Parcel silently swallows overflow, §Watcher-health): quantify watches
   added by admitting the ref surface for up to `MAX_GIT_REPOS = 256` repos
   (`manifest-validate.ts:22`) against `fs.inotify.max_user_watches`. The v3 default
   is the **bounded** set (`HEAD` + `packed-refs` + `refs/heads`, ~3 paths/repo ≈
   <800 descriptors at 256 repos) precisely to stay far under the limit so overflow
   never happens. Decide whether to also admit `refs/tags`/`refs/stash` (a few more
   per repo) or hold them scan-bound. Fallback if still tight: `logs/HEAD`
   single-file (Open decision 3) or the separate-watch approach (b).
3. **`logs/HEAD` single-file signal** — one path per repo, moves on every commit;
   a lower-descriptor alternative to the `refs/` subtree at the cost of watching a
   `logs/` path. Weigh vs the refs subtree once #2 is measured.
