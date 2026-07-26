# 203 — Lazy per-repo probes in applyGitSections

Status: ALIGNED (r3 — parallel wave + serial gate + focused re-check; 2026-07-26)
Companion: [202 — Pull consumes the watcher-maintained manifest](202-pull-trusted-local-manifest.md)
(shared pull seam; review jointly). See 202 §Combined steady state for the
joint contract — P and this design's laziness are independent gates whose
only shared artifact is the oracle (`pull.ts:347` → `opts.oracle`), so a 202
staleness defect can present as a 203-shaped symptom (repos silently
deferring); the kill switches MUST stay independent for bisection.

## Problem

`applyGitSections` (`src/cli/sync-git/apply.ts:287`) visits every repo in
remote ∪ base ∪ pending on every pull (`apply.ts:364`). The per-repo steady
state — nothing changed anywhere — still pays, **before** the unchanged
shortcut at `apply.ts:900-914` is consulted:

- `isGitBusy` (`apply.ts:688`) — `repoCtx` = 2 git spawns
  (`engine/git/shared.ts:405-416`) feeding `gitBusy`
  (`engine/git/shared.ts:721-736`, probe itself at
  `engine/git/preflight.ts:120`): 5 lock lstats plus a recursive
  `refs/` walk for `*.lock`;
- `gitIdentity(repoDir)` (`apply.ts:698`, `identity.ts:21`) — ~5 more spawns
  (`rev-parse` ×2, HEAD verify, `show-ref`/scoped read, `write-tree`) plus a
  byte copy of the whole index into a tempdir;
- design-116 journal machinery (`repoCtxFromDisk`, `checkoutJournalBinding` =
  3 realpaths + common-dir identity capture) run unconditionally
  (`apply.ts:630-682`);
- for config-bearing sections (the normal case), the `configDue` computation
  (`apply.ts:820-849`): `repoCtxFromDisk` → `configReceiver` (3 realpaths +
  bigint stat, `config-lane.ts:88-106`) → `readConfigSnapshot` (lstat +
  guarded read + second stat bracket, `engine/git/config-txn.ts:149-155`,
  `:238-245`) — ~10 fs syscalls.

≈7 subprocess spawns + an index copy + a refs-tree walk + the config cluster
per repo ≈ the measured ~65ms/repo constant. Field evidence (prod AE, 48h to
2026-07-26): `git-apply` is 45.9s of the fleet's 64.5s sample-weighted
pull-wall p50; on the founder's 110-repo workspace a flat ~7s in every pull,
including pulls whose only change was one non-git file.

The shortcut's *decision inputs* are almost entirely pure: `remoteChanged`
compares `projectedKey` (documented "Pure — never touches the repo",
`sync-git/shared.ts:99`, `engine/git/identity.ts:76-95`), and `pend`,
`needsRes[rel]`, `removedMem[rel]`, deferral/attempt/partial records are
in-memory state reads (`apply.ts:326-330`, `:426-449`).

Principle (founder, 2026-07-26): work proportional to the delta, never to the
workspace.

## Mechanism: demand-driven probes, same state machine

No second shortcut, no skip-list, no shrinking of `keys`. The per-repo state
machine and every transition stay identical; only *when* expensive inputs are
computed moves. **Zero git subprocess spawns on the steady state** is the
headline contract; residual per-repo fs work (lock lstats, refs-lock walk,
config cluster, journal lstat) remains and is priced honestly below.

| probe | today | becomes |
|---|---|---|
| `gitApplyMutationKey` + chain lock (`apply.ts:1775-1780`) | wraps every repo | **UNCHANGED.** r1 proposed skipping it on the unchanged path; refuted twice in review: the key is the *input to the common-dir chain lock* that serializes linked worktrees (design-116 comment at `apply.ts:627-628`), and the unchanged shortcut is not mutation-free — `applyConfigOnly()` (`apply.ts:901`) can write `.git/config`. It is also already spawn-free (`repoCtxFromDisk` + lstat fallback, `sync-git/shared.ts:224-230`), so there is nothing to save. |
| `isGitBusy` (`apply.ts:688`) | `repoCtx` via 2 spawns, then locks probe | **stays eager for every repo with a remote section** (behavior-exact: today `busy && remoteSec ⇒ defer` fires before any identity read, `apply.ts:689-694` — an unchanged-remote repo mid-rebase must KEEP deferring, not advance base through the shortcut), but derives its context **spawn-free** via `repoCtxFromDisk` (the same fs-based twin `gitApplyMutationKey` already uses), falling back to spawn-based `repoCtx` only when the fs derivation is ambiguous. Residual cost: 5 lock lstats + the refs-lock walk. |
| `gitIdentity` / `localId` (`apply.ts:698`) | unconditional | lazy memoized thunk — the big win (~5 spawns + index copy skipped when nothing demands it). Demanders: needs-resolution release (`apply.ts:874-885`), removal-memory pruning (`:790-806`), converged shortcut (`:915-943`), partial re-proof (`:945-959`), index-divergence path (`:963-1027`), every apply/conflict arm. **Contract: any demand for `localId` requires `isGitBusy` already known** — computing identity under a held `index.lock` flips `write-tree` onto the `raw:<sha>` fallback (`identity.ts:57-67`) and a transient key would wrongly release removal memories / resolution checkpoints. Busy-eager (row above) satisfies this globally; the contract is stated so no future arm reorders it. |
| design-116 recovery (`apply.ts:630-682`) | unconditional machinery | gated on a journal-path existence `lstat`, where the journal path is derived without `repoCtxFromDisk`; when a journal exists, the FULL machinery runs exactly as today — including the no-`recoveryCtx` arm (`apply.ts:670-682`, `quarantineUnboundFollowJournal`, which can itself defer). Mutating arms re-check for a journal under the chain lock (the existence probe is advisory; the lock-held check is authoritative), preserving "journal is the first per-repo operation in every arm" against a journal published between probe and lock. |
| config lane (`apply.ts:606-625`, `:820-855`) | stat-cluster based | **stays eager** — it is the sole detector of manual config edit/delete (heals through the unchanged shortcut; pinned by `sync-git-config-pull.test.ts:154`), and config-due work is mutation work (runs under the chain lock, which row 1 keeps unconditional). Cost honestly ~10 syscalls for config-bearing repos, not "1 stat"; the no-incoming-config baseline arm (`:606-625`) gates its realpath cluster on the pure state marker it exists to clear. |
| `commonDirGroupFor` under `collectMetrics` (`apply.ts:572`) | per repo when metrics on | already a no-op when metrics are off (`apply.ts:395-396`); when on, reuse the memoized fs-derived context instead of a second `repoCtxFromDisk`. Minor. |

Steady-state per-repo cost after this: pure key comparison + journal lstat +
busy lock lstats + refs-lock walk + config cluster when the section carries
config. Zero subprocess spawns, no index copy. If a future round finds the
residual fs work still hot at fleet scale, the established next primitive is
the capture-side warm fingerprint (`git-sync.test.ts:3107` pins its zero-spawn
property) — extend it, don't invent.

### The visited set does not shrink

`keys` stays remote ∪ base ∪ pending. Every local-side trigger class keeps
its detection: state-keyed (pending carry, needs-resolution, removal memory,
deferral/attempt/partial, held attempts) — pure reads whose presence demands
the probes; cheap-stat-keyed (config token, journal existence, `.git`
type/existence for fresh-config and absence); pure (remote change incl.
absence — "processed even when busy", invariant at `apply.ts:685-687` —
receiver-equivalent key collisions, scope projection).

Preserved consequences (each a test): cross-scope base advance on unchanged
repos (`applied[rel] = remoteSec`, `apply.ts:904`); deferral/attempt/partial
clearing (`:906-908`); **total-map emission** of `pending`/`removedMem`/
`needsRes` — seeded by copy (`apply.ts:326-330`) and load-bearing because
omission deletes: the record spread carries a value only when present
(`sync-state.ts:256-258` — no `current.*` fallback, unlike
`partial`/`attempt` at `:261-266`) and the save packet's `observedRepos`
handling finalizes the deletion (`sync-state-store.ts`); a repo that returned
early without its map entries would get its sidecar state silently dropped.
`revalidateGitPartialApplies` iterates records independent of arm taken;
progress denominator and `GitApplyMetrics.repos` remain `keys.length`.

### Index-divergence reachability: answered

r1 left this open; review closed it from the code. The semantic
index-divergence block (`apply.ts:963-1027` — `assume-unchanged`,
`skip-worktree`, sparse edits invisible to `write-tree`) begins strictly
after both shortcuts `return` (`:900-914`, `:915-943`) and is further guarded
(`:964`). For a repo with no pending/resolution/config work and an unchanged
remote it is **unreachable today**. Lazification that reproduces the shortcut
preconditions exactly is therefore behavior-preserving here by construction.
Test 8 pins this as a reachability test so a future re-order can't silently
change it. No new index-token trigger is added — adding one would be NEW
steady-state work and NEW behavior, out of scope.

## Kill switch

`RBOX_GIT_APPLY_LAZY=0` restores today's unconditional probe order. Default
ON. Independent of 202's switch (bisection requirement).

## Tests the implementation MUST write

1. **Spawn-count pin (headline):** warm unchanged multi-repo fixture through
   `applyGitSections` issues **zero** git spawns — extend the
   `observeGitSpawns` harness (`git-sync.test.ts:306`) to the apply side.
2. Unchanged repo still advances base cross-scope and clears
   attempt/deferral/partial (extend `origin-retention.test.ts:20` coverage);
   assertion includes **map totality** — every repo in keys has its
   `pending`/`removed`/`resolutions` value emitted, none dropped.
3. Each state-keyed trigger demands its probe (needs-resolution release,
   removal-memory prune, partial re-proof, pending retry): expensive probe
   ran, outcome identical to today.
4. Busy semantics: (a) busy repo + **unchanged** remote ⇒ still defers
   `git-busy`, base does NOT advance, deferral NOT cleared (the r1 hole);
   (b) busy + pending ⇒ defers; (c) busy probe issues zero spawns on the
   fs-derivable path.
5. Identity-under-lock: repo with removal memory + held `index.lock` ⇒
   removal memory NOT pruned on a `raw:` fallback identity (busy known
   first).
6. Journal: present ⇒ full recovery first, both arms incl. unbound
   quarantine; absent ⇒ no recovery machinery on the unchanged path;
   published-between-probe-and-lock ⇒ caught by the lock-held re-check.
7. Manual `.git/config` delete still heals through the unchanged shortcut
   (`sync-git-config-pull.test.ts:154` passes unmodified); config apply
   still serialized across linked worktrees sharing a common dir.
8. Index-divergence reachability pin (above).
9. Remote absence processed even when busy (`apply.ts:685-687`).
10. Metrics/progress: `repos === keys.length`, `results` classes unchanged,
    `repoTimings` one entry per repo, `onProgress` denominator unchanged.
11. Kill switch ⇒ probe order and spawn counts match today's baseline.
12. Joint (with 202): both-on integration pull converges; each switch off
    independently converges.

## Non-goals

- No shrinking of the visited repo set; no skip-list; no new cache; no new
  index-token trigger.
- No change to section identity/serialization, wire shapes, or the WS frame.
- No change to capture/plan-side fingerprinting.
- No concurrency-model change: `poolMap`, nested-repo chains, and the
  mutation-key/chain-lock wrapping are byte-identical.
- Pull's non-git costs are design 202's scope.

## Resolved decisions

- **Lazify, don't skip** — a skip-list would re-prove all local-trigger
  classes forever; lazification keeps one state machine and moves only when
  inputs are computed.
- **Mutation key/chain lock unconditional** (r2, reversing r1): it is the
  worktree serialization boundary, the unchanged path mutates config, and
  the key is spawn-free — the r1 row saved nothing and broke two invariants.
- **Busy probe eager but spawn-free** (r2, reversing r1's demand-driven
  busy): unchanged-remote busy repos must keep deferring; the cost lives in
  the spawns, which `repoCtxFromDisk` removes, not in the probe itself.
- **Config stat cluster stays eager** — sole tamper detector; priced
  honestly at ~10 syscalls, accepted.
- **Index-divergence: pinned unreachable, no new trigger** — reviewer-
  verified from control flow; the test preserves the fact.
