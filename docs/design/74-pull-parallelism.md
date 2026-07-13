# 74 - Pull parallelism: measure first, then remove the serial git tail

Status: DRAFT v2 - Phase 0 measures the pull tail including `git-apply`; Phase 1 pools git apply by resolved `commonDir` and raises fresh-join download concurrency only when measurements justify it.
Origin: 2026-07-07 live measurements on rbox/conductor workloads.
Depends on: design 27 download grants, design 35 phase metrics, design 43 nested git
sync, design 49 daemon IO priority, design 50 destructive apply safety, design 68
worktree git sync.

## 1. Baseline and problem

The motivating observations are two different workloads and must stay separate:

1. Rig conductor pull: operator-measured push 73s, pull 198s, 19.7k files. That
   2.71x gap is a symptom, not proof of a git bottleneck.
2. Fresh device-2 join: operator-measured 109k files / 17GB, about 1.5h. This is
   primarily a cold materialization shape, so git-section pooling can only help the
   git slice; file download/decrypt throughput remains the obvious fresh-join lever.
3. The draft's uncited "121-repo" count is cut. The tree contains a
   `conductor-initial-sync` rig, but that scenario explicitly disables git-sync and
   records only the synced file count (`scripts/rig/scenarios/conductor-initial-sync.ts:64-75`,
   `scripts/rig/scenarios/conductor-initial-sync.ts:87-94`). Phase 0 must record the
   actual `gitRepos` key count for the git-heavy rig before Phase 1 is allowed to
   claim a repo-count-sensitive win.

## 2. Current code facts

1. Pull currently creates the phase report after `api.latest()` and then measures
   `scan` and the file `apply` block (`src/cli/sync.ts:128-139`,
   `src/cli/sync.ts:196-210`).
2. Git apply is outside that pull report today: cache invalidation/save finishes,
   then `applyGitSections()` runs, then `saveState()` writes the new base
   (`src/cli/sync.ts:213-236`). So the reported pull tail can hide git work.
3. The existing phase schema has no `git-apply` phase; the pull display order ends
   with `download`, `decrypt`, `apply` (`src/engine/phase-report.ts:28-31`).
4. File apply already runs a bounded download/decrypt/write pool. The default is
   currently 64, with `RBOX_DOWNLOAD_CONCURRENCY` clamped 1..256
   (`src/engine/apply.ts:100-113`).
5. The codebase's own sweep note says a 4287-blob clone improved about 14% from
   32 to 64 and about 25% by 128, with no D1 plateau (`src/engine/apply.ts:105-111`).
6. Pull-side git apply is serial over sorted keys: `keys` is the union of remote,
   base, and pending repo sections, and the loop awaits one `processRepo(rel)` at a
   time (`src/cli/sync-git.ts:786-806`, `src/cli/sync-git.ts:981-992`).
7. Steady pulls can short-circuit unchanged sections before mutation, so a steady
   2.7x pull/push gap may not be git apply at all (`src/cli/sync-git.ts:889-896`).
8. Push already uses a bounded git capture pool with default width 4
   (`src/cli/sync-git.ts:50-51`, `src/cli/sync-git.ts:369-396`); that is the
   conservative starting point for apply-side git subprocess and artifact IO work.

## 3. Phase 0 - instrumentation gate

Ship this first. It has no behavior change except measurement.

1. Move or create the pull `PhaseReport` early enough to time `latest/open-manifest`
   as well as scan, file apply, git apply, cache save, and state save. Keep the
   current `apply` phase as file apply for compatibility, and add an explicit
   `git-apply` phase to `PhaseName` and `PHASE_ORDER`.
2. Wrap `applyGitSections()` in `report.phase("git-apply", ...)` and record at
   least `count = keys.length`. The summary line must make it impossible for git
   work to disappear into unclassified pull wall time.
3. Inside git apply, record per-repo queue and wall timing for the rig artifact:
   repo count, unchanged/applied/deferred/conflict result buckets, and effective
   `commonDir` group count. The normal `PhaseReport` summary stays aggregate and
   path-free, matching the existing no-path/no-hash privacy rule
   (`src/engine/phase-report.ts:7-15`).
4. Classify every rerun as fresh or steady. Fresh means the receiver has no useful
   local/base git state and is materializing a tree; steady means base exists and
   unchanged git sections may take the short-circuit in
   `src/cli/sync-git.ts:889-896`.
5. Phase 1's git pool is gated on the Phase 0 report showing `git-apply` as the
   dominant tail in a git-heavy steady or changed-git rig. If file `apply`,
   `download`, or `decrypt` dominates, the git pool stays design-only.

## 4. Phase 1A - git-section apply pool, gated

If Phase 0 proves the serial git tail is material, replace only the serial loop in
`applyGitSections()`.

1. Add `RBOX_GIT_APPLY_CONCURRENCY`, default 4, clamp 1..32. Default 4 matches the
   already-shipped push git-capture pool and is safer than deriving a higher value
   from one workstation.
2. Process the sorted `keys` through a bounded settled pool. One repo failure still
   records pending/deferred state for that repo and does not abort independent repos,
   preserving the current per-repo failure discipline (`src/cli/sync-git.ts:981-992`).
3. Workers must not mutate the shared `applied`, `removedMem`, `needsRes`, or
   `pending` maps directly. Each worker returns a per-`relPath` delta: base advance,
   pending write/delete, removal-memory write/delete, needs-resolution write/delete,
   and log lines. Merge deltas in sorted key order after the pool settles. The maps
   are already keyed by rel path (`src/cli/sync-git.ts:786-795`); the sorted merge is
   the deterministic barrier once execution becomes concurrent.
4. The only serialization grain is the resolved Git `commonDir`, not relPath prefix,
   path ancestry, or lexical grouping. Resolve it through `repoCtx` or
   `repoCtxFromDisk`, which resolve pointer files and out-of-tree `commondir`
   metadata to absolute `gitDir` / `commonDir` paths (`src/engine/git/shared.ts:48-55`,
   `src/engine/git/shared.ts:89-110`).
5. Same-`commonDir` work runs strictly serially. Different `commonDir`s may run in
   parallel. The guard covers every mutation against that ref store, including
   clean-materialization quarantine/wipe hooks, bundle fetch into the repo,
   `update-ref` publish/delete, `HEAD` writes, index/op-state restore, fsck, rollback,
   and scratch-ref cleanup (`src/engine/git/apply.ts:278-299`,
   `src/engine/git/apply.ts:307-347`).
6. Fresh targets with no existing `.git` have no resolved `commonDir` yet and do not
   share a ref store. They remain independent by target path, guarded by the existing
   containment and TOCTOU recheck immediately before `git init`
   (`src/engine/git/apply.ts:249-264`).
7. Keep design 68's checked-out-branch collision rule inside `applyGitState()`: a
   collision defers the whole section before mutation, never a partial publish
   (`src/engine/git/apply.ts:54-86`, `src/engine/git/apply.ts:158-165`).
8. Do not overstate the remaining risk. Object import already uses a randomized
   incoming namespace, which is exactly the sibling-concurrency safety property this
   design relies on (`src/engine/git/apply.ts:289-299`). The commonDir gate protects
   the shared ref/index/op-state store, not the object-import namespace.

## 5. Phase 1B - fresh-join download concurrency

Fresh joins need a different lever. If Phase 0 confirms the 17GB-class join is still
file download/decrypt bound, change the default download concurrency from 64 to 128.

1. This is a one-line default change at the `dlConc` fallback, keeping the env clamp
   and user override behavior (`src/engine/apply.ts:104-113`).
2. The reason is the recorded sweep in `apply.ts`: 128 was still improving clone
   wall time and showed no D1 plateau (`src/engine/apply.ts:105-111`).
3. This is not evidence for git pooling; it is the fresh-join lever. Git pooling is
   for steady or changed-git pulls where `git-apply` dominates.
4. If 128 improves the fresh join by less than 15%, keep the measurement and open a
   follow-up for decrypt parallelism or file-apply scheduling instead of raising the
   default again.
5. Concurrency defaults are chosen for foreground `rbox pull/sync`, where the user is
   waiting and the process keeps normal IO priority. The daemon shares the knobs, but
   design 49 already moves daemon IO to the background/throttle tier while leaving
   one-shot commands foreground (`docs/design/49-daemon-io-priority.md:25-42`,
   `src/cli/daemon.ts:160-168`).

## 6. Crash and recovery semantics

1. File writes remain temp-stage plus atomic rename, with decrypt and plaintext-sha
   verification before publish (`src/engine/apply.ts:145-168`,
   `src/engine/apply.ts:185-202`).
2. Git artifacts are fetched, decrypted, and verified before gitdir mutation
   (`src/engine/git/apply.ts:203-220`). Normal thrown failures still enter the existing
   rollback/fresh-cleanup branches (`src/engine/git/apply.ts:333-347`).
3. A process kill during git mutation is recoverable, not idempotent. A kill can skip
   the rollback branch after some refs, `HEAD`, index, or op-state have been published.
   Recovery is the existing next-pull divergence/conflict path: preserve the remote
   bundle, keep local work, checkpoint needs-resolution, and retry or require manual
   resolution (`src/cli/sync-git.ts:912-922`, `src/cli/config.ts:95-104`).
4. Parallelism increases the number of in-flight repos to the pool width, but
   `commonDir` serialization bounds the worst case to at most one partial mutation per
   shared ref store.
5. State remains manifest-last. `saveState()` is still a single atomic write
   (`src/cli/config.ts:204-206`), and Phase 1 must not save a successful git base until
   file actions and git deltas are both known.

## 7. Acceptance and verification

The old "pull <= 1.3x push" target is removed. It was not tied to the measured phase
responsible for the tail.

1. Phase 0 acceptance: pull reports include `git-apply`; rig artifacts classify fresh
   versus steady; each git-heavy run records actual repo count, `commonDir` group count,
   and per-repo queue/wall timing.
2. Git pool acceptance: on the git-heavy rig where Phase 0 shows git apply dominant,
   `git-apply` wall time shrinks roughly with effective pool width; file apply timing is
   unchanged; no file conflict, trash, ignore-rule, linked-worktree collision, pending
   remote, or git divergence regression appears.
3. Fresh-join acceptance: on the 109k-file / 17GB-class workload, the 64 to 128 default
   bump improves fresh-join wall time by at least 15%, with no fd/RSS pressure, R2 error
   spike, or daemon-contention regression.
4. Sweep `RBOX_GIT_APPLY_CONCURRENCY=1,2,4,8,16` before choosing any default above 4.
   The default stays 4 unless the higher width wins materially without commonDir lock
   contention, fd pressure, or git-process failures.
5. Tests for Phase 1A: independent repos apply concurrently; two relPaths resolving to
   the same `commonDir` serialize; one repo failing/deferred does not block another repo
   base advance; checked-out branch collision still defers the whole section; fresh
   materialization still rechecks before `git init`.
6. Tests for Phase 1B: default `dlConc` is 128 when env is unset; env overrides still
   clamp 1..256; a forced env value of 64 keeps the old behavior for comparison runs.

## 8. Explicit non-goals

1. No `filePendingRemote` in this design. File apply is already parallel, and adding
   persisted file pending state would be a resilience/state-machine change touching
   forward-only file deferral, push/pull mass-delete counts, and conflict semantics,
   not the measured pull-performance change (`src/engine/apply.ts:100-125`,
   `src/cli/sync.ts:168-177`, `src/cli/sync.ts:460-473`,
   `src/cli/sync.ts:488-498`).
2. Do not add per-file grant refresh or change design 27. The recorded download sweep
   says throughput, not D1 entitlement reads, is the current fresh-join lever
   (`src/engine/apply.ts:105-111`).
3. Do not weaken ignore-rule barriers, ancestor type-flip preflight, trash handling,
   checked-out branch collision checks, manifest validation, or E2EE artifact
   verification.
4. Do not implement design 68 tier-2 linked-worktree state.
5. Do not change the server protocol, manifest wire format, or blob encryption format.
6. Do not solve scan narrowing, size-aware file write scheduling, or decrypt
   parallelism here; those are follow-ups only if Phase 0/1 measurements show they are
   the remaining bottleneck.

## Code-comment provenance (113 wave 4)

Review citations relocated from code comments by design 113 wave 4 (comment
sweep). The invariant prose remains at each cited site; the review round that
produced it is recorded here.

- `src/cli/sync-git/apply.ts` (fresh-run classification): was "review finding" — non-sequence-keyed classification invariant retained in code.
- `src/engine/apply.ts` (lane timing): was "design 74/76 reviews" — per-blob cost decomposition invariant retained with bare design pointers.
