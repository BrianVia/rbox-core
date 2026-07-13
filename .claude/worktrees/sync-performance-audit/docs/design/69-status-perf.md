# 69 — `rbox status` must be fast (cache the hashes, pool the git, publish the daemon's answer)

Status: draft, codex-reviewed (v2 — resolutions folded in below)
Origin: 2026-07-06 founder incident — `rbox status` took 90 seconds on the
140-repo / 131,667-file `~/Development` workspace (measured twice: 81s cold,
93s warm — warm cache didn't help, which is itself the diagnosis)
Depends on: design 45 (status health), design 59 (probe elision), design 28/43/68 (git-state)

## 1. Measured diagnosis

Reproduced on the incident machine (`time bun src/cli/index.ts status
~/Development`): **~28s user + ~34s system, 90s wall**, both runs. The wall
time decomposes into two unconditional phases that run **serially**
(`status-cmd.ts:96` is awaited before `:104` starts):

1. **Full uncached content hash of the tree** (`scanManifest` at
   `status-cmd.ts:96`, called WITHOUT the `HashCache` third argument).
   Every non-ignored file is read and SHA-256'd, 16-wide
   (`manifest.ts:202,257-268`). The cache exists on disk —
   `.rbox/state/hashcache.json`, 113MB on this workspace, maintained by the
   daemon (`daemon.ts:164`) and sync (`sync.ts:107`) — status just never
   loads it. This is the ~28s of user time.
2. **Serial per-repo git divergence** (`gitDivergenceCount`,
   `sync-git.ts:636-704`): a plain `for...of` over every repo
   (`:652`, no pooling despite `poolMap` existing) spawning ~13 git
   subprocesses each — `repoCtx` recomputed **3×** per repo (by `isGitBusy`,
   `gitPreflight`, `gitIdentity` — 6 redundant spawns), plus a
   `git write-tree` (index refresh; the expensive one). 140 repos ×
   ~13 ≈ **1,800 serial spawns** — the ~34s of system time, and why a warm
   filesystem cache changes nothing (fork/exec doesn't warm).
3. Lesser: a **second full tree walk** (`discoverGitRepos`,
   `git-discover.ts:28-53`) that re-traverses all 131k entries just to find
   repos, and (human mode) a non-elided 3.5s-budget account fetch — noise at
   this scale, but the walk is pure waste.

Root cause in one sentence: designs 45/59 made status *read* cheaply
(state file, elided probe) but left it *computing* both truth sides from
scratch — full hash scan + full git identity — uncached, unpooled, and
serial, so cost scales linearly with tree size.

## 2. Targets

| Scenario | Today | Target |
|---|---|---|
| Daemon live + fresh (any tree size) | 90s on the incident tree | **< 300ms** (no tree work at all) |
| Daemon down, warm caches, incident tree | 90s | **< 8s** |
| Daemon down, cold caches, incident tree | 90s | < 45s (bounded by one honest hash pass) |
| Typical single-repo workspace (≤5k files) | ~1s | unchanged or better |

## 3. Design

Four independent fixes, ordered by leverage. Each stands alone; together
they hit the targets.

### 3.1 Load the HashCache (one-line class of fix)

`statusCmd` loads `.rbox/state/hashcache.json` (`HashCache.load(root)`) and
passes it to `scanManifest`. Write-back is pid-guarded (v2): status persists
the updated cache ONLY when no daemon pidfile is live (atomic rename) — a
live daemon owns the file exclusively; daemon-down statuses warm each other. Unhashed-but-unchanged files (mtime+size
hit) skip the read+hash entirely; the scan drops to a stat walk. A 113MB
cache parse is ~1-2s — acceptable against the 28s it removes; if profiling
shows the parse dominating small workspaces, gate the load on manifest-size
heuristics later (not in v1).

### 3.2 Divergence overhaul: pool, dedupe, fingerprint-cache

`gitDivergenceCount` (and only it — the capture path in `planGitSections`
keeps its own semantics):

- **Pool** the per-repo loop with the existing `poolMap`, concurrency 8
  (read-only probes; higher than capture's 4 is safe — no bundle I/O).
- **Dedupe context**: compute `repoCtx` once per repo and thread it through
  `isGitBusy`/`gitPreflight`/`gitIdentity` (add an optional ctx parameter,
  default = compute, so capture-path callers are untouched). 13 → ~7 spawns
  per changed repo.
- **Fingerprint cache** (the big one): persist per-repo
  `{ fingerprint, identityKey }` under `.rbox/state/git-divergence.json`.
  The fingerprint must cover EVERY input to the divergence decision (v2 —
  codex BLOCKER: the v1 set missed op-state, preflight sentinels, and the
  worktree gitDir/commonDir split; `git rebase --edit-todo` alone breaks a
  refs/index-only fingerprint). Per repo, mtime+size (or existence) of:
  the `.git` entry itself (dir vs gitfile pointer + pointer target), the
  resolved `gitDir` and `commonDir` paths, `<gitDir>/HEAD`, `<gitDir>/index`,
  the op-state file set `readOpState` reads (`MERGE_HEAD`,
  `CHERRY_PICK_HEAD`, `rebase-merge/`, `rebase-apply/` — max-mtime over the
  set), preflight sentinels (`<commonDir>/shallow`,
  `<commonDir>/objects/info/alternates`, `<commonDir>/config` mtime for
  core.bare flips, `<commonDir>/worktrees` state), and
  `<commonDir>/packed-refs` + max(mtime) over `<commonDir>/refs/**`
  (commonDir, NOT gitDir — pointer worktrees share refs; the walk reuses
  `isGitBusy`'s existing `walkFiles`). Still ~a dozen stats + one small dir
  walk per repo.
  Unchanged fingerprint → reuse the cached `identityKey`, **zero git
  spawns for that repo**. Changed → full probe as today, then update the
  entry. Any git write (commit, checkout, stage, stash, ref update, rebase
  step) touches index/HEAD/refs mtimes, so staleness is bounded by
  filesystem mtime semantics — the same trust the HashCache already places
  in mtime+size, applied to gitdirs. The cache is advisory and status-only:
  corrupt/missing → recompute all (one slow run heals it). Writer: status
  itself may write this file (it's status-derived state, not sync state);
  write atomically (temp+rename), tolerate a concurrent daemon status.
  Expected: warm daemon-down divergence on 140 repos ≈ 140 fingerprint
  stats ≈ hundreds of ms; cold ≈ pooled ~7×140 spawns ≈ a few seconds.

### 3.3 One walk, not two

`scanManifest`'s walk visits every directory, but (v2 correction — codex)
`.git` entries are hard-pruned BEFORE any callback fires today, so the
collector must hook the walk's directory-entry evaluation ahead of the
ignore prune: for any entry named `.git` (directory OR gitfile pointer),
emit the parent dir's relPath, then prune as today. `statusCmd` collects
repo paths during the ONE scan and passes the list into
`gitDivergenceCount` (new optional param; default = discover as today for
other callers, preserving design-68's pointer-parent skip semantics which
key on the same discovery output shape). Kills the second full traversal.

### 3.4 Daemon-live fast path: publish the computed answer (design-45 extension)

v2: reviewed shape — see git history

The daemon already owns the expensive local truth: it keeps a cache-warm
manifest (`src/cli/daemon.ts:170`, `src/cli/daemon.ts:186`) and runs the
real sync plan. Extend the design-45 activity contract by adding a
top-level `local` slot to `.rbox/state/activity.json`, as a sibling of
`active`, `halt`, and `ws` (`src/cli/activity.ts:25-61`) — not nested under
`active`, and not in a separate sidecar:

```ts
local?: {
  at: string;
  stream: string;
  baseSequence: number;
  trackedFiles: number;
  added: number;
  changed: number;
  deleted: number;
  settled: boolean;
  sourceVersion: 1;
};
```

No paths are stored, matching `activity.json`'s existing privacy posture.
`bootId` is not duplicated: `local` inherits attribution by riding the
same object whose `ws.bootId` is checked by `attributeDaemonForStatus`,
which already nulls the whole activity object on boot mismatch
(`src/cli/status-view.ts:56-99`). `gitChangedRepos` is deliberately not in
`local`: it is dead weight there, and a future reader trusting it would
reopen the design-59 B2 `.git`-invisible-to-watcher hole. Git divergence is
still computed locally from settled git state, below.

`loadActivity` keeps its known-shape, slot-isolated contract
(`src/cli/activity.ts:73-145`): add `local` validation alongside the other
nested slots, and if `local` alone is malformed, drop only `local` and fall
back to the scan path. A bad optional snapshot must never crash status or
poison the rest of the daemon activity render.

Trust predicate:

- `status` consumes `local` only from `attributed.activity`, never from
  `rawActivity`. The existing flow reads `rawActivity` and then calls
  `attributeDaemonForStatus` (`src/cli/status-cmd.ts:157-169`); the
  §3.4 fast path must branch only after that attribution gate. This is what
  makes a daemon restart safe: a new live pidfile boot id plus old
  `activity.json.local` is suppressed by attribution and falls back to the
  local scan.
- The snapshot is trusted only when `local.stream === state.stream` and
  `local.baseSequence === state.lastSyncedSequence`. These counts are a
  diff against a specific `state.json` baseline (`src/cli/config.ts:75-105`);
  an async pull can advance state between the daemon's write and the status
  process's read.
- `local.settled` must be true and `local.at` must be fresh under its own
  60s ceiling. This is not `ELIDE_MAX_AGE_MS` (30s, used for the remote
  elision window in `src/cli/status-view.ts:38-39`). Missing, stale,
  mismatched, unsettled, malformed, or unattributed means "degrade to
  §3.1-3.3" — slow but correct, never wrong.

This requires an honest ordering change in `statusCmd`: today status loads
the hash cache and scans before it even reads activity
(`src/cli/status-cmd.ts:138-143`, then `src/cli/status-cmd.ts:157-177`).
The §3.4 PR must load state, load+attribute activity, branch, and on the
trusted branch skip both `HashCache.load` and `scanManifest`. Only the
untrusted branch pays the hash-cache parse and full walk. This inversion is
why §3.4 stays a separate, higher-risk PR from §3.1-3.3.

Git remains local and walk-free. Even on the trusted `local` branch,
`gitDivergenceCount` must not fall back to `discoverGitRepos`; the current
fallback does exactly that when no repo source is supplied
(`src/cli/sync-git.ts:1027-1029`), which would reintroduce the second full
walk §1.3 called pure waste. For the fast path, source the repo list by
unioning the keys of `.rbox/state/git-divergence.json` (loaded/written at
`src/cli/sync-git.ts:516-536`) with
`Object.keys(state.lastSyncedManifest.gitRepos ?? {})`, then run the
fingerprint stats on that list. Persist repo `kind` in each divergence
cache entry: today the cache entry is `fingerprint`/`identityKey`/`probe`
only (`src/cli/sync-git.ts:459-463`), while `kindByPath` is populated from
discovered repos (`src/cli/sync-git.ts:1024-1033`). The walk-free source
therefore needs cached `kind`; a legacy entry without it is treated as
unknown and re-probed for that repo, not as permission to run
`discoverGitRepos`.

`settled` is cleared at raw watcher-event receipt, before debounce and
before the pump. The current watcher coalesces raw events through
`createBatcher` and emits only after the quiet window
(`src/cli/watcher.ts:90-113`), with raw backend callbacks feeding the
batcher at `src/cli/watcher.ts:214-248`. Add a raw-event hook there so the
daemon flips `local.settled = false`, stamps `local.at`, and enqueues the
activity write immediately. Clearing after the debounced batch would leave a
small but real window where status could render a fresh "in sync" snapshot
after a user edit landed.

Write policy: `local` rides the existing serialized activity write chain,
not a new cadence. The daemon already writes visible changes, a 30s idle
heartbeat, and transfer progress through one ordered promise
(`src/cli/daemon.ts:360-382`, `src/cli/daemon.ts:624-670`,
`src/cli/daemon.ts:736-745`). The idle heartbeat re-stamps `local.at` while
the daemon is still settled, re-attesting "still N changes as of now" so an
idle, in-sync workspace continues to elide. A real change re-stamps via the
raw watcher path well inside the 60s window. Snapshots never add
unconditional per-cycle writes.

Boundary with design 73: `local` is settled-state only. Live per-phase
counts — including any founder-visible "N discovered / N encrypted /
N uploaded" copy — stay in the `active` slot (`src/cli/activity.ts:45-47`),
and design 73 extends `active` with optional bytes. The founder-visible
git-sync line renders from `active.phase === "gitcap"` (`done/total`) plus
the settled git divergence count; it must not read live progress from
`local` (`src/cli/status-cmd.ts:230-252`).

One-directional safety: `local` is daemon-written and status-read-only.
Status may write advisory cache files already covered by §3.1-3.2, but it
does not write `activity.local`; the daemon never reconstructs runtime
state from any status-written file, preserving the v0.9.2 reload-clobber
lesson (`src/cli/daemon.ts:795-802`).

This keeps the daemon-live path <300ms on the incident tree: one attributed
activity read, no `HashCache.load`, no `scanManifest`, no `discoverGitRepos`,
and only warm fingerprint stats over the walk-free repo list.

§3.4-specific verification:

- Daemon-restart stale-sidecar suppression: old `local`, new live boot id →
  `attributed.activity` suppresses it → scan fallback.
- `baseSequence` mismatch → scan fallback.
- Debounce-window honesty: a raw watcher event persists `settled:false`
  before the debounced pump runs.
- Idle elision: a 31s-old snapshot re-stamped by the 30s heartbeat still
  elides; a 61s-old snapshot does not.
- Synthetic 140-repo / 130k-file fixture asserts <300ms on the trusted path
  and proves no `discoverGitRepos` call, via spawn counting or a probe hook.

## 4. What deliberately does NOT change

- The verdict logic (`healthLine`), trails, halt display — untouched.
- The capture path's git semantics (design 43/68) — `gitIdentity` for sync
  keeps `write-tree` precision; only status's *divergence count* rides the
  fingerprint cache.
- The human-mode account fetch stays (design 59 non-goal) — v2 correction:
  today it is awaited at the END of rendering (status-cmd.ts:196), not
  concurrent; 3.1-3.3's implementation starts it alongside the local work
  (a free ~1-3s in the daemon-down case), still error-swallowed.
- `--json` contract (v2 correction): today's JSON has NO local-counts or
  source fields — this design ADDS them additively (`local: { added,
  changed, deleted, gitChangedRepos, source: "daemon"|"computed", ageMs }`),
  registered in the design-67 json registry and covered by
  json-output tests; existing fields unchanged.

## 5. Validation

- V1 incident-tree benchmark: the four scenarios in §2 measured on a
  140-repo fixture (rig can synthesize; numbers recorded in the PR).
- V2 correctness: fingerprint cache — commit/stage/stash/branch/checkout in
  a repo each flip the fingerprint and change the count; an untouched repo
  yields zero spawns (assert via spawn-counting test seam).
- V3 daemon snapshot: live+fresh → no scan (assert scanManifest not called
  via seam), stale → full local compute; snapshot counts match a from-
  scratch compute on the same tree.
- V4 cache corruption: garbage git-divergence.json → status correct (slow
  path) and healed after one run. Garbage/missing hashcache.json → status
  correct but cold (v2 honesty: scanManifest updates the cache in-memory
  only; status does not persist it, so a cold hash cache stays cold until
  the daemon or a sync saves one — EXCEPT status MAY write it back when no
  daemon pidfile is live [pid-guarded, atomic], which turns repeated
  daemon-down statuses warm; a live daemon owns the file exclusively).
- V5 concurrent daemon: no TORN files ever (atomic renames); hashcache.json
  is never written by status while a daemon pidfile is live; concurrent
  git-divergence.json writers may lose entries (advisory, self-healing) —
  the test distinguishes torn-file corruption (forbidden) from lost
  advisory updates (accepted); stable-pair rule verified under a mid-probe
  git mutation.
- V6 no regression on the single-repo happy path (time-boxed test).

## 6. Rollout

1. This doc (codex-reviewed) → implement 3.1-3.3 in one PR (pure CLI/engine,
   no daemon changes), 3.4 as a second PR (daemon contract + status
   consumption) — separable risk, and 3.1-3.3 already deliver the
   daemon-down targets.
2. Benchmark numbers from the incident tree go in both PR descriptions.
3. Backlog follow-up (not this design): the account-summary fetch elision,
   and hashcache.json's 113MB JSON footprint (binary/sharded format) if
   parse time shows up once everything else is fast.

---

## v2 — codex review resolutions (2026-07-06)

2 BLOCKER + 4 MAJOR + 1 MINOR, all accepted and folded above:

- **B1 fingerprint completeness** (§3.2): v1 missed op-state
  (`rebase --edit-todo`), preflight sentinels (shallow/alternates/config),
  and the pointer-worktree gitDir/commonDir split. Fingerprint now covers
  every divergence input; refs fingerprinted on commonDir.
- **B2 local freshness** (§3.4): ws-attribution is not local currency and
  the watcher can't see `.git`. Resolved by splitting the snapshot: files
  elided under a dedicated settled+age policy; git NEVER elided (the fixed
  fingerprint makes it ~free), which deletes the git-staleness hole.
- **M1 collector placement** (§3.3): `.git` is pruned before callbacks;
  hook fires pre-prune for `.git` entries (dir + gitfile pointer).
- **M2 HashCache heal honesty** (§3.1/V4): status doesn't persist the
  cache; V4 reworded; pid-guarded write-back allowed when no daemon lives.
- **M3 advisory races** (V5): stable-pair rule (re-stat after compute);
  torn files forbidden, lost advisory updates accepted.
- **M4 JSON contract** (§4): local counts/source are an explicit additive
  contract change, not an existing field.
- **m5 account-fetch wording** (§4): it's awaited-at-end today; made
  concurrent as part of the implementation.
