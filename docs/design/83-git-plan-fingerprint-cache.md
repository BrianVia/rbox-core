# 83 - git-plan subprocess floor: stat-fingerprint cache for per-repo git planning

Status: Draft v2 (post adversarial review, codex gpt-5.5 REDESIGN-as-harden +
cross-cutting seam review; directives integrated and verified against code).
Pending phase-0 falsification (section 5) and the per-host dev-build gate
(section 7). Client-only. No wire or manifest change; one on-disk cache format
version bump (v4 fingerprint, section 3.2) with a self-healing one-time cold
recompute per host.
Origin: post-v0.9.10 per-phase instrumentation of steady-state syncs on the real
workspace (`ws_2b6e15da`, ~116,879 files / 98 top-level git repos, Mac WiFi plus
wired Linux host). Design 82 phased the previously-invisible zone; with the
O(N²) encrypt-cache path gone, `git-plan` is the largest phase of the shared
no-op daemon tick.
Method lineage: this continues the designs 79-82 discipline — measure, falsify,
then redesign — and it generalizes, rather than reinvents, the design-69/status
stat-fingerprint cache (`git-divergence.json`).

All numbers marked *measured* were observed on the founder's real workspace on
2026-07-08 unless noted. *Inferred* means the estimate follows from those
measurements but still needs the section 7 gate. Light local re-measurement for
this draft was structural (repo counts, cache shape, a single-repo subprocess
batch timing); treat wall-clock figures as approximate — another agent may have
been measuring the same workspace concurrently.

## 1. Problem and evidence

1. **`git-plan` is the largest phase of the shared no-op tick, measured.** On
   the v0.9.10 compiled binary with `RBOX_METRICS=1` on the Mac (98 repos), the
   `git-plan` phase runs 24.2-25.5s; the wired Linux replica runs the same phase
   in ~2.3s. It runs in EVERY push and EVERY sync, including no-op daemon ticks:
   a no-op push measured 41s total = state-load 0.1 + scan 15.0 + git-plan 25.5.
   Within that shared tick, git-plan (25.5s) exceeds scan (15s) and everything
   else; scan-phase and commit-envelope costs are owned by their own designs
   (section 8) — this design claims only the git-plan share.
2. **All 98 repos come back unchanged yet each pays its subprocess cost,
   measured.** A steady-state run reported `mode=steady repos=98 commonDirs=98
   results=unchanged=98` with per-repo timings of roughly 85-195ms of work each
   and queue delay ramping toward ~1.5s under a concurrency-capped pool. (That
   line is `formatGitApplyMetrics`, the pull/apply side; `git-plan` is the
   push-side `planGitSections` and its main loop is worse — it is *serial*, see
   root cause.) Zero repos changed; every repo still spawned git.
3. **The subprocess floor is 13 spawns per unchanged repo, counted from code.**
   Design 82 phase-0 CPU profiling attributed ~55.6s of subprocess-spawn
   self-time per full push to per-repo git identity + capture + apply. Counting
   the unchanged-path spawns in `planGitSections` directly:
   - `isGitBusy(repoDirOf(...))` (`sync-git.ts:386`) resolves its own `RepoCtx`
     via `repoCtx` (`src/engine/git/shared.ts:114-125`) = **2 spawns**
     (`rev-parse --absolute-git-dir`, `rev-parse --git-common-dir`); the lock
     probe itself is fs-only.
   - `gitPreflight(repoDirOf(...))` (`sync-git.ts:416`) resolves `RepoCtx`
     AGAIN (**2**) plus 4 probes (`rev-parse --is-inside-work-tree`,
     `--is-bare-repository`, `--is-shallow-repository`, `--show-toplevel`) =
     **6 spawns**.
   - `gitIdentity(repoDirOf(...))` (`sync-git.ts:435`) resolves `RepoCtx` a
     THIRD time (**2**) plus `rev-parse --verify HEAD`, `show-ref` (dir repos;
     pointer repos run `rev-parse --verify <branch>` instead), and `write-tree`
     = **5 spawns**. `readOpState` hashes files without spawning.
   That is **13 spawns per unchanged repo — 6 of them redundant re-resolutions
   of the same repo context** — not the 7 a naive read suggests. A single real
   repo's 7-spawn preflight+identity batch measured ~0.12s wall (`user 0.04 /
   sys 0.05`); the true 13-spawn sequence is proportionally higher, and repos
   with large indexes (`write-tree` reads and can refresh the whole index) push
   the observed per-repo cost toward the ~200ms range that sums to the measured
   24-25s across 98 serial repos.
4. **The prior art to skip this already exists in-repo and is already warm,
   measured.** `src/cli/sync-git.ts` carries a full stat-fingerprint cache for
   the STATUS/divergence path: `gitFingerprint` (internal version 3) hashes a
   repo's git metadata stats, and `cachedDivergenceProbe` stores, keyed by that
   fingerprint, a `probe` with exactly the fields `planGitSections` recomputes
   by spawning: `busy`, `preflightOk`, `preflightStructural`, `preflightKind`,
   `identityKey`, `parentRel`. The on-disk cache
   `.rbox/state/git-divergence.json` on the real Mac workspace is version 2,
   **149 entries**, each `{ fingerprint, identityKey, kind, probe }`.
   `gitDivergenceCount` (the status/front-door path) writes it;
   `planGitSections` (the push path) ignores it and spawns anyway.

The gap in one line: **the push path recomputes by subprocess the exact per-repo
git identity that the status path already caches by stat-fingerprint.**

## 2. Root cause

`planGitSections` (`src/cli/sync-git.ts:246`) walks every repo key in a *serial*
`for (const rel of keys)` loop. For the overwhelmingly common case — a repo
whose git state has not moved since the last push — it still executes, per repo
and in order, the 13-spawn sequence itemized in §1.3 (three independent
`repoCtx` resolutions, four preflight probes, and the three identity reads),
then compares `gitIdentityKey(id)` against `gitIdentityKey(baseSec)` under the
design-43 §7 shape×scope carry matrix (`sync-git.ts:452-464`). When they match —
98/98 of the time in steady state — it carries `baseSec` unchanged and throws the
freshly-computed identity away. The subprocess work was pure waste: the answer
was "unchanged", and the inputs that determine "unchanged" (HEAD, refs, index,
op-state) are all observable by `stat` (plus a few tiny content reads, §3.2)
without spawning git.

The status path already exploits this. When design 69 made `rbox status` fast, it
added `gitFingerprint` + `cachedDivergenceProbe`: fingerprint the repo's git
metadata by stat, and on a fingerprint hit reuse the cached `identityKey` and
preflight outcome instead of spawning. The push path never adopted it. Design 82
§7.3 explicitly parked this: *"cache identity by stat-fingerprint on the PUSH
path the way `git-divergence.json` already does for status."* This is that work.

Two secondary costs ride along and are scoped here for honesty:

- Warm pointer repos are not zero-spawn even after a fingerprint carry: the
  post-loop design-68 §3.3 worktree skip calls `inTreeWorktreeParentRel`
  (`sync-git.ts:486-490`), which resolves `repoCtx` (`shared.ts:139-141` →
  `shared.ts:114-124`) = 2 more spawns per pointer repo. Section 3.5 removes
  this on cache hits.
- `planGitSections` also runs its own full-tree walk via `discoverGitRepos`
  (`sync-git.ts:309`), ~2.3s on the Mac. This design does NOT remove that walk;
  see section 8.7.

## 3. Design - publish-grade fingerprint cache, shared with status

Do not build a second cache. **Generalize the existing one** — same file, same
entry shape, one shared fingerprint schema upgraded to publish grade for both
readers — and have `planGitSections` consult it before spawning.

### 3.1 Shared probe surface

The reusable unit is already present as three private functions in
`sync-git.ts`: `gitFingerprint(run, root, rel)`, `probeDivergenceRepo(root, rel,
ctx)`, and the cache load/save pair. Lift the cache-hit logic of
`cachedDivergenceProbe` into a helper both callers share:

```ts
// returns a cached probe on a trusted fingerprint hit, else undefined (caller spawns).
function fingerprintHitProbe(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  cache: GitDivergenceCache,
): Promise<{ probe: CachedDivergenceProbe; kind?: GitRepoKind } | undefined>
```

`planGitSections` grows two inputs it does not have today: the loaded
`GitDivergenceCache` and a `GitFingerprintRun`. It loads the cache once at entry
and saves it once at exit, exactly as `gitDivergenceCount` does
(`sync-git.ts:1345-1386`), including the same prune-stale-entries step so the
two writers converge on one file rather than fighting over it.

### 3.2 The v4 publish-grade fingerprint (resolves former Open Decisions 9.1/9.2)

Adversarial review resolved the fingerprint question: **one shared v4 schema for
BOTH the status and push paths** — not a status-grade/publish-grade fork —
shipped as a cache version bump. Old-version entries are treated as misses, so
each host pays exactly one cold (spawning) plan/status run and self-heals; no
dual-shape reader code.

v4 changes relative to the v3 stat-only inputs
(`src/cli/sync-git.ts:724-731,773-797,831,856-858`):

1. **`ctimeMs` on every statted input.** mtime can be forged backwards
   (`touch -t`, backup restores, rsync `-a`); ctime cannot be set by user code
   on APFS/ext4. Every `StatToken`/`DotGitToken`/`TreeToken`/summary gains
   `ctimeMs` next to `mtimeMs`/`size`.
2. **Content-hash of `.git/HEAD` and loose ref files.** These are ≤41-byte
   files; reading them costs less than a stat pipeline miss. This closes the
   same-millisecond same-size loose-ref flip outright — the fingerprint sees the
   bytes, not the timestamp.
3. **Content-hash of `packed-refs` when it is < 1MB; stat-only (mtime+size+
   ctime) above.** On this fleet packed-refs is far below the threshold; huge
   packed-refs degrade gracefully to stat coverage rather than an unbounded
   read.
4. **The index stays stat-based — `mtime + size + ctime + ino` — never hashed.**
   Hashing a multi-MB index per fingerprint would rebuild the cost this design
   removes. Its same-shape race is closed by the margin rule below.
5. **The racy-clean margin rule**, borrowed from git's own index discipline: a
   fingerprint HIT is only *trusted* when the newest constituent timestamp
   (max over every `mtimeMs`/`ctimeMs` in the freshly-computed fingerprint) is
   **strictly older than the cache entry's write time minus a 2s granularity
   margin**. Concretely: the v4 cache entry records `writtenAtMs` at write
   time; the fingerprint computation returns `{ hash, maxTsMs }`; a hit is
   trusted iff `hash` matches AND `maxTsMs < writtenAtMs - 2000`. A repo
   touched within the margin of when its entry was written ALWAYS spawns — the
   same reason git treats an index entry whose mtime equals the index's own
   mtime as racily clean. This kills the remaining same-shape races (clock
   granularity, in-flight writes straddling the cache write) without hashing
   the index.

The margin rule and content hashes apply to both readers — it is one schema and
one trust predicate. Status gets strictly stronger too; its extra cost is a few
41-byte reads per repo, noise against its existing stat pipeline.

### 3.3 The fast path, and its exact guard

Inside the per-repo loop, BEFORE the 13-spawn sequence, attempt the fast path.
It fires ONLY when every one of these holds — any failure falls through to the
unchanged full-subprocess path (fail-safe by construction):

1. `!force.has(rel)` — a 422 recapture must spawn and capture, never carry.
2. `!pending[rel]` and `needsRes[rel] === undefined` and `removedMem[rel] ===
   undefined` — the fast path handles ONLY the clean carry case; the
   pending/conflict/removal branches keep their existing subprocess logic
   verbatim (they are rare and their correctness is load-bearing).
3. `kindByPath.has(rel)` — the repo was DISCOVERED this run. The live planner's
   `!kind` branch (`sync-git.ts:358-378`) — removal detection, gitignored-carry,
   no-usable-.git defer — must never be bypassed by a cache hit; a cache entry
   for a repo the walk no longer sees proves nothing about the present.
4. `baseSec` exists — the fast path's only possible outcome is a base-carry, so
   with no base there is nothing it is allowed to produce (a new repo must go
   through admission + capture).
5. The v4 fingerprint HITS under the §3.2 trust predicate (hash match AND
   margin rule) and the entry has a `probe`.
6. The cached probe is plannable-clean AND shape-complete: `!probe.busy`,
   `probe.preflightOk`, `!probe.preflightStructural`, and
   `probe.preflightKind` is a valid `GitRepoKind` — the carry matrix branches on
   preflight kind (`pf.kind === "dir"` at `sync-git.ts:454`), so a probe without
   a usable kind cannot drive the decision.
7. The cached `probe.identityKey` reproduces the SAME carry decision the
   subprocess path would reach — i.e. run the design-43 §7 matrix
   (`sync-git.ts:452-464`) with `probe.identityKey`/`probe.preflightKind` in
   place of the freshly-spawned `gitIdentity`. On carry → `out[rel] = baseSec;
   carried.push(rel); continue;` with zero spawns. On a non-carry decision (the
   identity genuinely differs from base) → fall through and spawn, because a
   non-carry means the repo must be CAPTURED, and capture needs the live repo.

The invariant that makes this safe: **the fast path can only ever produce a
base-carry, never a capture and never a drop.** Its single write is `out[rel] =
baseSec` — byte-identical to what the subprocess path writes when it reaches the
same carry decision. A fingerprint miss, an untrusted (margin-violating) hit, a
busy/structural/kind-less probe, an undiscovered repo, a missing base, or a
non-carry identity all route to the unchanged existing code. The fast path
cannot author a section, cannot remove one, cannot clear a removal memory, and
cannot touch `needsRes`/`pending`. Its blast radius is exactly "skip 13 spawns
and carry the base we would have carried anyway."

### 3.4 No cross-repo common-dir memoization on the publish path (review BLOCKER)

`GitFingerprintRun` memoizes common-dir fingerprints ACROSS repos
(`sync-git.ts:648,836-843,864-865`): the first repo touching a common dir
computes its fingerprint once and every later repo sharing that store reuses the
promise. For linked worktrees sharing one ref store, that means a later repo's
"current" fingerprint can be a snapshot taken tens of seconds earlier — a ref
move mid-plan would be invisible to the later repo's hit check, and it could
carry stale state.

On the **publish path the fingerprint is computed per-decision**: each repo's
fast-path check stats the common dir fresh (memo reuse is allowed only WITHIN
one repo's own decision, e.g. between its hit check and its write-back). The
cost is re-statting a shared common dir once per worktree that points at it —
bounded by repo count and trivially cheap next to one spawn.

The **status path may keep the cross-repo memo**: divergence counting is
advisory (a number in `rbox status`), and its existing tolerance is unchanged.
The memo policy is a parameter of the shared helper, not a fork of the code.

### 3.5 Cached `parentRel` for the design-68 worktree skip (former Open Decision 9.4 — resolved: INCLUDE)

Warm pointer repos are not zero-spawn today even when carried: the post-loop
design-68 §3.3 skip calls `inTreeWorktreeParentRel` (`sync-git.ts:486-490`),
which resolves `repoCtx` via two `git rev-parse` spawns
(`shared.ts:139-141,114-124`) for every pointer repo in `toCapture ∪ carried`.
Without fixing this, the section 7 zero-spawn gate is unachievable on any
workspace with pointer repos.

Resolution: on a trusted fingerprint hit, use the cached `probe.parentRel`
directly in the skip pass. This is sound because `parentRel` is derived from the
same fingerprinted state as the carry decision — `probeDivergenceRepo` computes
it from the repo's resolved ctx (`sync-git.ts:879`), and the fingerprint covers
the `.git` pointer file, the resolved ctx paths, and the common dir's
`worktrees` token; a hit that justifies trusting `identityKey` equally justifies
`parentRel`. Any repo that missed, fell through, or lacks a cached `parentRel`
uses the live `inTreeWorktreeParentRel` computation exactly as today. The skip
pass's own logic (`sectioned` membership, base-carry-never-drop) is untouched.

### 3.6 Write-back so the push path warms the cache too

On a fingerprint MISS (or any fall-through that ends up spawning), the loop
already computes a fresh identity + preflight. Store it back into the cache
entry (`fingerprint`, `writtenAtMs`, `identityKey`, `kind`, `probe`) using the
same 2-attempt fingerprint-stabilization loop `cachedDivergenceProbe` uses
(probe, re-fingerprint, accept when the fingerprint settles or the probe
repeats). This means a daemon-only host that never runs `rbox status` still
self-warms after its first plan, and the status and push paths keep one shared,
mutually-warmed cache.

### 3.7 Why this is generalization, not duplication

`gitFingerprint`, `CachedDivergenceProbe`, `GitDivergenceCache`, and the
2-attempt stabilization loop are reused with one shared schema upgrade (v4,
§3.2). The new code is (a) the shared `fingerprintHitProbe` helper with its
memo-policy parameter, (b) the ~20-line guard at the top of the
`planGitSections` loop, and (c) the cached-`parentRel` branch in the skip pass.
No second cache, no forked fingerprint. One cache, two readers, two writers,
converged by the shared prune-and-save.

## 4. Correctness - what the fingerprint must cover for a skip to be safe

A skip is safe iff **every input to the carry decision is covered by the
fingerprint** — so that any real change which would flip carry→capture also
changes the fingerprint (or violates the margin rule) and forces a miss. The
carry decision consumes `gitIdentityKey` = `head | indexTree | refs | opState`
plus the preflight outcome and (via §3.5) `parentRel`. Map each to its v4
coverage:

| identity/preflight input | v4 fingerprint coverage |
|---|---|
| `head` (symbolic-ref or detached sha) | **content hash** of `.git/HEAD` (§3.2.2) + stat(+ctime) |
| `refs` (`show-ref` / scoped `rev-parse`) | **content hash** of each loose ref (≤41B, §3.2.2); `packed-refs` content-hashed < 1MB else stat+ctime; refs/ tree summary (count, maxMtime, maxCtime, totalSize) |
| `indexTree` (`write-tree`) | stat of `.git/index`: mtime+size+**ctime+ino** — never hashed; the §3.2.5 margin rule closes its same-shape race |
| `opState` (MERGE_HEAD, rebase-merge, …) | stat(+ctime) of every `OP_STATE_FILES` + tree of every `OP_STATE_DIRS` |
| preflight shape (shallow/bare/alternates/modules/worktrees) | stat(+ctime) of `shallow`, `objects/info/alternates`, `config`, `modules`, `worktrees`, `gc.pid` in the common dir |
| repo kind / pointer resolution / `parentRel` | `dotGitToken` (dir vs gitfile pointer + resolved target) + `ctx` (kind, gitDir, commonDir) + the common dir `worktrees` token |
| in-flight writes | `index.lock` / `HEAD.lock` stats + the cached `probe.busy` guard + the margin rule |

### 4.1 Where mtime-based fingerprints lie, and how each fails SAFE

Enumerated, with the failure direction that matters (a WRONG SKIP is a real
local git change that silently fails to publish — a sync miss, not corruption,
but a correctness bug; a WRONG MISS merely costs one subprocess run):

1. **Touch without content change** (editor rewrites HEAD/ref with same bytes,
   `git status` refreshing index stat). Timestamps bump → margin rule or hash
   path forces a MISS → full spawn. Fails SAFE. This is the common over-capture
   and is acceptable.
2. **Content change without mtime change** — the historically dangerous
   direction (a loose ref or index rewritten within the same timestamp
   granularity, size unchanged since a sha is fixed-length). **Closed in v4**:
   loose refs and HEAD are content-hashed (§3.2.2), so byte changes are seen
   regardless of timestamps; the index is protected by ctime+ino plus the
   §3.2.5 margin rule — any write inside the trust margin spawns.
3. **Clock skew / mtime forged backwards** (restore from backup, `touch -t`,
   rsync `-a`). **Closed in v4**: ctime cannot be forged by user-space writes on
   APFS/ext4, and ref/HEAD content is hashed anyway. A filesystem-level restore
   that also rewinds ctime while keeping index size+mtime+ino identical to
   different content is the residual theoretical case, and the margin rule means
   it is only trusted if the entry was written 2s+ after the newest timestamp — a
   deliberate-forgery scenario, not an operational one. Accepted.
4. **`git gc` / repack rewriting files.** gc packs loose refs into
   `packed-refs`, repacks objects, may drop `gc.pid`. packed-refs hash/stat +
   refs/ summary + `gc.pid` stat all move → MISS → full spawn. Fails SAFE — and
   the fast path never runs while `gc.pid` exists because guard-6 requires
   `!probe.busy` and `gitBusy` checks `gc.pid`.
5. **Filesystem timestamp granularity.** APFS (Mac) and ext4 (Linux) are
   sub-second; the fleet is fine. Coarse filesystems (NTFS 2s, FAT) are exactly
   what the 2s margin rule is sized for: within-granularity writes are never
   trusted.
6. **Submodules / linked worktrees.** Submodule superprojects are refused by
   preflight (structural) and never pass guard-6. Linked worktrees are the
   reason for §3.4's per-decision fingerprinting (no cross-repo memo on the
   publish path) and §3.5's parentRel provenance argument. The skip pass only
   ever consumes a base-carry the fast path was already allowed to produce.

## 5. Phase-0 - measure first, falsify the prior

Before writing the fast path, prove the premises on both hosts with the v0.9.10
compiled binary:

1. **Confirm the spawn floor is the cost, not I/O wait.** With `RBOX_METRICS=1`,
   confirm `git-plan` is 24-25s Mac / ~2.3s Linux on a no-op push, and that the
   per-repo self-time is dominated by the 13-spawn sequence (spawn+wait), not
   index read. Falsify the alternative that `write-tree` disk I/O dominates: if
   it does, the fingerprint still wins (write-tree is skipped on a hit) but the
   redundant-`repoCtx` share of the projection changes.
2. **Confirm cache warmth in practice.** Instrument a real steady-state push to
   report, for the 98 repos: v4 fingerprint hits vs misses (after one warming
   run — the version bump makes run #1 all-miss by construction). Premise is
   that steady state is ~98 trusted hits. If real fleet churn (build.log-driven
   repos, editors refreshing indexes inside the margin window) keeps the hit
   rate materially below that, the hit rate — not the per-hit saving — is the
   real lever, and the gate target must be set from the MEASURED hit rate, not
   an assumed 98/98.
3. **Confirm carry-decision parity offline.** For all 98 repos, compare
   `probe.identityKey` from the cache against a freshly-spawned
   `gitIdentityKey`, and assert the §7 matrix reaches the identical
   carry/no-carry verdict for every repo — and that cached `parentRel` matches
   live `inTreeWorktreeParentRel` for every pointer repo. Zero mismatches is the
   go/no-go for trusting the cached probe. Any mismatch is a
   fingerprint-coverage bug and blocks the design until explained.

If phase-0 falsifies premise 2 (cold cache under real churn), stop and redesign —
do not ship a fast path the workload never hits.

## 6. Instrumentation

Design 82 established that an unphased cost is an invisible cost. Per the
convention shared across designs 83/84/85: **sub-decomposition goes in
`recordDetails` on the existing phase — `PhaseName`/`PHASE_ORDER` are not
touched.** Add, under `RBOX_METRICS=1`, to the existing `git-plan` phase record
(`sync-git.ts:489` already calls `report.record("git-plan", …)`):

- `fpHits` / `fpMisses` — repos served from the fingerprint cache vs spawned,
  with `fpUntrusted` counted separately (hash matched but the margin rule
  refused — the racy-window signal).
- `spawnedRepos` — repos that ran the full preflight/identity sequence (the
  residual floor), and `parentRelCached` — pointer repos whose design-68 skip
  used the cached parentRel.
- `carried` / `captured` counts are already in the plan; surface them here so
  the phase line reads `git-plan repos=98 fpHits=98 spawned=0 carried=98
  captured=0` in the steady state and `spawned=N` whenever a real change lands.

This makes the section 7 gate self-evidencing and turns any future regression
(hit-rate collapse) into a visible metric rather than a silent slowdown.

## 7. Dev-build gate - per host, objective

Same discipline as designs 81-82: compiled dev build vs v0.9.10, A/B on both
fleet hosts, daemons stopped for the timed runs. Fleet rule: **only one
design's A/B gate window runs on the shared WAN at a time** — designs 83/84/85
are being gated in sequence, so schedule this design's window accordingly.

1. **Mac warm no-change git-plan (gate 1): PASS if** a no-op `RBOX_METRICS=1
   rbox push` (no touch, second run after the v4 warming run) reports
   `git-plan` **≤ 4s** (from 24-25s), with `fpHits=98`, `spawned=0` — including
   pointer repos, which §3.5 makes reachable. Target rationale: the remaining
   floor is the `discoverGitRepos` tree walk (~2.3s Mac, §8.7) plus 98
   fingerprints at fs-stat + tiny-read cost; > 8s means investigate before
   merge.
2. **Linux warm no-change git-plan (gate 2): PASS if** the same run on the wired
   replica reports `git-plan` **≤ 1.5s** (from ~2.3s). The Linux floor is
   already small; the win is proportionally smaller but must not regress.
3. **A changed repo is NEVER skipped (gate 3, the correctness gate): PASS if**,
   with the daemons stopped, each of these single-repo mutations forces
   `spawned≥1` for that repo AND publishes it, verified end-to-end to the other
   host: (a) `git commit` moving HEAD; (b) `git checkout -b` new branch;
   (c) `git add` staging a file (index change → `write-tree` differs);
   (d) `git tag` a new tag; (e) a mid-rebase op-state (`rebase --interactive`
   paused); (f) `git pack-refs --all` (loose→packed migration). Every case must
   MISS (or margin-refuse) and capture. Zero silent skips.
4. **Racy-window probe (gate 3b): PASS if** a scripted same-repo loose-ref
   rewrite to a different same-length sha, done as fast as the shell allows, is
   caught. Under v4 this MUST pass (the ref bytes are hashed); this gate is now
   verification of the §3.2 mechanism, not a decision input. Additionally, a
   write landing inside the 2s margin of a cache-entry write must show up as
   `fpUntrusted` and spawn.
5. **Full push wall (gate 4): PASS if** a 1-file-change `RBOX_METRICS=1 rbox
   push` on Mac lands with `git-plan` ≤ 4s + one spawned repo, total wall
   improved by ≈ the git-plan delta (~20s), no phase regressions elsewhere.
6. **Correctness suite (gate 5): PASS if** full `bun test ./src/` is green
   (modulo the known-local json-output environmental fail noted in design 82
   §6.1); `git-divergence.json` after an A/B push pair is semantically
   consistent between the status writer and the push writer (same
   fingerprint→identity mapping); and a cross-host rename/branch-switch
   round-trips. Also verify the one-time v4 cold recompute: the first dev-build
   run reports all-miss, the second all-hit, and `rbox status` stays correct
   across the bump on both hosts.
7. **Daemon soak (gate 6): PASS if** both daemons run one natural churn cycle
   each on the dev build with `fpHits`/`spawned` logged; steady no-op ticks
   show `spawned=0` and the capture-to-publish gap holds ≤ its design-82 level.

## 8. Non-goals

Owned by other designs / other agents — do NOT touch here:

1. **Scan-phase cost.** Scan is ~15s of the no-op push; incremental/daemon-fed
   scan is separate work.
2. **Commit-envelope O(N) encoding.** The ~47MB manifest re-encode/re-encrypt
   per commit is design 84 (manifest delta encoding). Not this design.
3. **Cold-join / first-publish git costs.** The fast path only helps warm,
   steady-state planning; a cold host has no cache and legitimately spawns.
   Cold git capture (bundling) is out of scope.
4. **Encrypt / crypto / worker-pool.** Designs 79/81 territory. Untouched.
5. **Raising the plan loop's concurrency.** The plan loop is serial; pooling
   the *residual* misses (like the divergence path's concurrency-8) is a real
   second lever but orthogonal — call it out, do not bundle it, so the
   fingerprint win is measured in isolation. (Open Decision 9.3, deferred.)
6. **The `build.log` echo publish loop.** Content hygiene, not engine work
   (design 82 §7.4).
7. **The `discoverGitRepos` walk inside git-plan.** `planGitSections` runs its
   own full-tree walk (`sync-git.ts:309`), ~2.3s Mac, which this design does
   not remove — it is the dominant term left inside the gate-1 budget. The
   scan already has a purpose-built feed for exactly this: the `onGitRepo`
   discovery hook on `buildManifest` (`src/engine/manifest.ts:43,231-232`),
   which fires per discovered repo during the scan walk and has **zero
   consumers today**. Folding a discovered-repo feed from the scan into
   git-plan is future work shared with design 85 — referenced here, not
   designed here.

## 9. Open decisions

Resolved by adversarial-review adjudication (recorded for the trail):

1. **Fingerprint grade (was 9.1): RESOLVED — publish-grade v4, shared.** One
   schema for both status and push (§3.2): ctime everywhere, content-hashed
   HEAD/loose-refs, packed-refs hash < 1MB, stat-only index, 2s racy-clean
   margin rule. Rationale: the failure mode of a status-grade hit on the
   publish path is a silently unpublished commit; forking two fingerprint
   schemas would double the maintenance surface for no safety gain; the v4
   additions cost tiny reads.
2. **Cache versioning (was 9.2): RESOLVED — version bump + one cold recompute
   per host.** Self-healing, no dual-shape reader. The first post-upgrade run
   is all-miss (no slower than today's every-run behavior) and the second run
   is warm.
3. **Pool the residual misses now or later? DEFERRED (unchanged).** A genuine
   multi-repo change (branch switch across many repos, a gc sweep) still spawns
   its misses in series. Adopting the divergence path's concurrency-8 pool for
   the miss set is a small, separable follow-up design — kept out so this
   change's evidence stays clean.
4. **Cached `parentRel` (was 9.4): RESOLVED — INCLUDE (§3.5).** Without it,
   warm pointer repos keep a 2-spawn floor (`inTreeWorktreeParentRel` →
   `repoCtx`) and the zero-spawn gate is unachievable. Provenance argument: the
   cached `parentRel` derives from the same fingerprinted state as the carry
   decision, so a hit that justifies one justifies the other; live fallback on
   any miss or absent field.

## 10. Risks

1. **Silent unpublished change (highest).** A wrong skip does not corrupt, but
   it withholds a real local commit from the fleet until something else
   invalidates the fingerprint. Mitigated by fail-safe construction (miss →
   spawn), the v4 content hashes + ctime + margin rule (§3.2), the guard list
   (§3.3), and gates 3/3b.
2. **Two-writer cache: last-writer-wins, accepted.** Status and push both write
   `git-divergence.json`. Both writes are atomic full-snapshot writes
   (`writeFileAtomic`), so a reader never sees a torn file; a concurrent
   status run and push can lose one writer's snapshot to the other. That is
   acceptable by design: a lost write costs exactly one recompute on the next
   run — never correctness, because the cache only ever short-circuits toward
   the same answer the spawn path produces. No merge or lock machinery is
   added.
3. **Cold-cache pessimism.** The v4 version bump makes each host's first run
   all-miss (no slower than today, plus fingerprint cost); only steady state
   wins. Expected; gate 5 verifies the two-run warm-up shape.
4. **Hit-rate collapse under churn.** If real fleet churn keeps fingerprints
   invalidating — including margin-rule refusals on hot repos
   (`fpUntrusted`) — the win shrinks toward zero without any correctness loss.
   The §6 metrics make this observable rather than a mystery regression.
5. **Stale common-dir snapshots.** The cross-repo memo hazard is removed from
   the publish path by §3.4 (per-decision fingerprinting); the status path
   keeps its memo and its existing advisory tolerance. A future refactor
   re-unifying the memo policy must re-read §3.4's linked-worktree scenario
   first.

## 11. Lessons (to fold in on ship)

The fastest code is the subprocess you never spawn — but only if a cheap,
already-warm observation can prove the spawn was going to say "nothing
changed." This design ships almost no new mechanism: the fingerprint, the
cache, and the stabilization loop all already existed for `rbox status`. The
bug was architectural, not algorithmic — two code paths asking the same
question, one cheaply and one expensively, and no one had wired the cheap
answer into the expensive path. When two paths compute the same identity, make
them share the cache before you make either faster. And when a cache graduates
from advisory (status) to load-bearing (publish), re-derive its trust predicate
from the new consequence — that is where the v4 hardening came from.
