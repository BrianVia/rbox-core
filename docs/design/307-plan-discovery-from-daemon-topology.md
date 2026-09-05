# 307 — Plan discovery from daemon topology

Status: design-ready. Scope: F3b-lite; no wire, durable-state, or product-policy change.
Baseline: `847fb5571`. On via-desktop an unchanged push reports `discover=1000`
while walking about 194K entries before planning 125 repositories.

## 1. Protected contract

| Preserve | Rule |
|---|---|
| Discovery | Same `DiscoveredGitRepo { relPath, kind }`, ignore pruning, stable order, nested repos, symlink refusal, and repo cap as `discoverGitRepos`. |
| Planning | BASE/pending/needs-resolution carry, forced recapture, config capture, journal recovery, pointer pre-skip (`pps`), busy defer, and output. Only `kindByPath`'s source varies. |
| Absence | Candidate data never removes a cached entry. A plan-cache absence never prunes state directly. §9 still requires its own `.git` `lstat`; only a scan-horizon, unpruned snapshot may shrink continuity's authoritative registry set or mint `DeferralDiscoveryAuthority`. |
| Degraded paths | Foreground callers, cold daemon, watcher absence/error/overflow/distrust, stale matcher, pending topology work, and incomplete discovery walk as today. |
| Genesis | `filesFirstDefer` always walks so it can decide whether commit 2 is owed, then reports that walk to continuity. |
| Compatibility/performance | No state/schema/wire/CLI change and no flag. Revert restores unconditional walks. Trusted unchanged daemon pushes require `discover < 50ms`; fallbacks retain current cost. |

No command, alias, migration, compatibility path, fast path, module, or test is
approved for deletion. `discoverGitRepos` and `onGitReposDiscovered` remain required.

## 2. Current flow and complexity

`push.ts:521,541-551` builds the push matcher and calls `planGitSections`.
`plan.ts:1098-1106` walks for files-first; `:1128-1146` walks for every ordinary
plan, builds `kindByPath`, then joins BASE/pending keys. The ordinary walk is the
measured 1,000ms term; capture is not required to pay it.

The daemon reports plan walks at `daemon.ts:1986`; `LocalWorkspaceObserver` reports
scan discoveries; `handleGitSignalBatch` reports candidates (`daemon.ts:1034-1043`).
`GitDiscoveryContinuity.authoritative` is replaced only by scan-kind unpruned
snapshots. Plan/signal inputs currently arm the ref registry but do not update it,
and watcher trust, queued candidate work, and matcher provenance live elsewhere.
Returning `authoritativeRepos` directly would therefore be unsafe.

## 3. Freshness inventory

“Prompt” is the watcher debounce (400ms quiet, 3s maximum) plus candidate discovery;
the safety floor is about 60s. The periodic unpruned/deep scan is every row's backstop.

| Change after certification | Existing input and latency | Reuse response |
|---|---|---|
| `git init` or clone | Exact `.git` create is classified before matcher filtering by Parcel/Chokidar (`watcher.ts:364-368,470-477`), then `discoverUnder`; candidate-map overflow requests `discoverAll`. Populated atomic move-in is design 175's executed watcher contract. Prompt. | Invalidate synchronously before debounce; candidate-before-accessor walks. Candidate-after-accessor queues a following push, which walks. |
| `git worktree add` | New worktree `.git` file create follows the same path; Linux ref arming completes before its handshake push. Prompt. | Walk or later complete plan certificate must contain `kind:"pointer"`. |
| Repo/worktree removal | Exact `.git` delete dirties its candidate; parent `unlinkDir` enters the file plane. Prompt. | Drop the plan certificate; candidate absence cannot shrink it or authorize §9 memory pruning. The fallback walk plus existing `lstat` may prune after genuine absence. |
| `.git` file ↔ directory | Update or delete/create is `{dirty:true, discover:true}`; `discoverUnder` reads final kind. Prompt. | Drop before debounce so stale kind cannot drive `pps`; fallback reads the final kind. |
| Rename/move of repo directory | Exact move-out/move-in `.git` lifecycle is the design-175 contract. Some backends may report only parent `unlinkDir`/`addDir`. Prompt. | Raw structural event also invalidates; a fallback full walk finds the new relPath even without a descendant event. |
| `.gitignore`/`.rboxignore` prune/unprune | Raw rule event precedes prologue rebuild/full scan (`daemon.ts:2071-2082`). | Invalidate at raw enqueue, then generation mismatch keeps reuse off until a complete current-matcher observation. |
| `rbox` config (`respectGitignore`, `ignorePaths`, Git policy) | Operation-boundary stat tokens rebuild or require uncached unpruned recycle (`daemon.ts:3038-3170`). Binding/scope change halts/restarts. | Pending rebuild/recycle and generation mismatch reject reuse. |
| Watch/kernel/daemon queue overflow or error | `WatcherTrust` increments error generation, degrades/fuses, and pins safety (`watcher-trust.ts:207-256`; `daemon.ts:2041-2054`). | `trustedForPull() === false` rejects until existing witnessed full-tree recovery. |
| Daemon restart | Continuity and its plan certificate start empty; watcher startup discovery only arms refs. | First ordinary plan or returned unpruned scan must complete before reuse. Nothing is persisted. |
| Existing repo ref, index, or split-index dependency changes | Ref paths request push; index-only changes may emit ordinary file events or none. They change capture/trackedness, not repo path/kind. | This slice reuses no matcher/tracked set. Push still builds `matcherForState`; fingerprints, preflight, and F1 identity stay authoritative. Topology need not invalidate. |
| Pull/409 recovery changes local Git or rules | `applyGitState` may `git init` an absent repo; file actions may write `.gitignore`/`.rboxignore`. `onPullAdopted` runs even for Git-only pulls (`pull.ts:489`). | Invalidate directly on pull adoption before retry; never wait for asynchronous watcher delivery. The immediate next plan attempt walks. |

The missing observations are the pre-debounce interval and in-process pull mutation:
exact candidates bypass `onRawEvent`, matcher generation changes only when a queued rule
event is applied, and a 409 pull can retry before either watcher path delivers anything.
Add one synchronous topology-invalidating callback before `SignalDebouncer.push`, and
invalidate from `onRawEvent` for rule files and every `addDir`/`unlinkDir`. This also
closes a backend's parent-only populated-move report without another crawler. Invalidate
again from the existing daemon `onPullAdopted` callback before control returns to retry.

## 4. Owner and certificate

`GitDiscoveryContinuity` remains the sole topology owner, but separates two facts:

- `authoritative` + `absenceProof`: registry/floor continuity; candidate/plan inputs
  are additive, and only the existing shrinking scan snapshot removes entries.
- one ephemeral exact **plan topology certificate**: repositories from a complete
  plan walk or returned unpruned scan under a witnessed matcher/watch generation.
  A complete plan walk replaces this cache exactly but does not touch absence proof.

```ts
trustedTopologyForPlan(gate: PlanTopologyGate):
  readonly DiscoveredGitRepo[] | undefined
```

The daemon-owned callback supplies live `PlanTopologyGate`: current matcher generation,
watcher error generation and `trustedForPull()`, matcher rebuild/recycle flags, plus the
signal debouncer's derived queued-work bit. Continuity compares those to its certificate,
its topology epoch, and its in-flight candidate count. Any mismatch returns `undefined`.
The returned sorted array is readonly and exact for that matcher; no filtering or policy
is rebuilt in `plan.ts`.

| Fact | Existing owner | Minimal change |
|---|---|---|
| Shrinking topology/absence | `GitDiscoveryContinuity` | Unchanged authority. Successful candidate results only add/replace paths by kind. |
| Exact planner topology | None | One in-memory certificate in continuity; complete plan result replaces it, complete unpruned scan seeds it, candidate/delete never certifies it. |
| Matcher provenance | `RboxDaemon.matcherGeneration`, rebuild/recycle flags | Certificate stores generation; rebuild invalidates. Scan snapshot carries its start generation. |
| Raw or in-process topology/rule race | Watcher raw callback; pull adoption callback | One monotonic topology epoch; bump before candidate debounce, on raw rule/dir events, and synchronously on every pull adoption. |
| Queued/in-flight candidates | `SignalDebouncer` map/`discoverAll`; continuity `observeSignal` | Expose a derived queued getter; one in-flight count brackets awaited discovery/reconcile. No queue is added. |
| Watch health/overflow | `WatcherTrust` | Reuse its verdict/error generation; do not duplicate its state machine. |
| Walk completeness | `engine/git-discover.ts` currently hides `readdir` failure as `[]` | Add an optional fault sink and pass `{repos, complete}` to the existing observer. Planning keeps the same partial-result behavior, but partial results never certify reuse. |

At each ordinary plan attempt, the daemon callback captures `{topologyEpoch,
matcherGeneration, watcherErrorGeneration}` immediately before the accessor read and
retains it in that push-scoped, sequential callback pair for the fallback observer.
Certification requires unchanged before/after witnesses, no queued/in-flight work,
current matcher, and trusted watcher. Files-first reports additively but cannot certify
because it intentionally bypasses the accessor/witness. A race costs another walk.
Update the `Never:` headers in continuity and watcher/session modules to name this
certificate/invalidation ownership; adapters still never own planning policy.

## 5. Plan adapter

```ts
interface GitPlanOptions {
  trustedGitTopology?: () => readonly DiscoveredGitRepo[] | undefined;
}
```

Both discovery sites make their policy explicit. Files-first (`plan.ts:1101`) bypasses
the accessor, walks, and reports. Ordinary planning (`:1130`) reads the accessor once;
on `undefined`, it runs/measures the current walk and reports `{repos, complete}`.
When reuse succeeds, `onGitReposDiscovered` is not called: re-feeding a cached result
would circularly certify it. Foreground/CLI callers omit the option. `SyncDeps`,
`push.ts`, and daemon composition only thread the optional callback.

## 6. Tests and fixture shapes

- Continuity table test: a complete 125-item scan/plan certificate returns a frozen,
  sorted view; each gate (trust, error, matcher, rebuild, queue, in-flight, epoch,
  incomplete read) independently returns `undefined`.
- Candidate races: seed empty; create `new/.git/HEAD`. Before accessor, raw candidate
  forces fallback and includes `new`; after accessor, it queues a follow-up whose walk
  includes `new`. Repeat with only parent `addDir` for populated move-in.
- Removal: seed repo and `gitReposRemoved`; delete `.git`. Candidate result cannot remove
  cache or memory. Fallback absence alone cannot prune; its existing successful `lstat`
  does. A stale cache may delay but never cause pruning.
- Kind flip: directory ↔ valid gitfile before debounce rejects reuse; `kindByPath` sees
  final kind before `pps`. Matcher rule/config changes similarly force one full walk.
- Distrust/restart/incomplete I/O: watcher error and queue overflow force fallback; a new
  continuity owner has no certificate; injected nested `EACCES` preserves plan behavior
  for that attempt but refuses certification.
- In-process recovery: start certified, force a 409 pull that materializes an absent repo
  or writes an ignore rule, suppress watcher delivery, and prove the immediate retry walks
  and matches fresh planning. Each retry captures a distinct witness.
- Stable differential: 0/1/125-repo nested fixtures run with certificate and forced walk;
  compare Git sections, sidecars, deferrals, `pps`, and removal/changed results exactly,
  excluding timing only. Repeat after `git add -f`, `git rm --cached`, incoming index
  replacement, and split-index dependency change to prove this is topology-only.
- Crash/race: candidate, raw rule/dir, matcher, or watcher-error generation changes during
  fallback refuses certification; thrown discovery/observer retains no partial certificate
  and never changes `absenceProof`.

Run focused continuity/watcher/git-plan suites, `bun run typecheck`, compiled CLI smoke,
and Git-layout rig. Record same-host warm p50/p95 `discover=` for 20 unchanged pushes on
the 125-repo workspace. Accept median and p95 below 50ms, exact differentials, and no
reproducible >10% p95 fallback regression.

## 7. Requirements, delivery, rollback, verdict

| Challenge | Decision |
|---|---|
| Persist topology or add a flag | Reject: restart fallback and revert are sufficient. |
| Reuse matcher/tracked sets (full F3b) | Reject: F1 freshness remains separate; this slice reuses topology only. |
| Targeted crawl for every structural event | Reject: one invalidation plus existing full walk is rarer and simpler. Revisit only if fallback measurements fail. |

Implementation order within one PR: (1) red freshness/completeness/differential fixtures;
(2) continuity certificate + raw invalidation; (3) optional plan/deps wiring; (4) focused,
compiled, rig, and 20-run measurement gates. Rollback is a revert; rejected gates already
restore the walk per operation. The certificate fields may be deleted when planning uses
the same sealed `LocalWorkspaceObserver` receipt instead of separate discovery.

**Verdict: safe as one bounded PR after including enqueue-time and pull-adoption
invalidation plus the completeness receipt above.** Exact `.git` candidates cover normal
appearance; raw `addDir` closes parent-only move-in; direct pull invalidation closes the
409 retry race; distrust and scan remain fail-closed backstops. These are small parts of
one cache-admission boundary, not a preceding product fix. Without them, reuse is unsafe.
