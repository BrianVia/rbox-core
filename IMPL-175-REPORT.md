# Design 175 implementation report

Status: U1 through U6 implemented in order. Each unit's focused tests were green
before advancing, and the complete acceptance matrix is green.

## Units completed

| Unit | Result |
|---|---|
| U1 | Added the shared ref-tail table, role-aware side-channel classifier, exact `.git` lifecycle classifier, and bounded atomic signal/candidate debouncer payload. Ref/candidate inputs remain outside raw/settled file events. |
| U2 | Added `GitRefWatchRegistry`: stable role contributors, canonical physical-root ownership, generation dirtiness, epoch/latest-only reconcile, complete-snapshot-only shrinking, containment, namespace admission budgets, exponential jittered retry, reader-death latch, and close/late-result fences. |
| U3 | Added awaited discovery and git-busy seams, `packed-refs.lock` busy/fingerprint coverage, config-authoritative reftable refusal in preflight and registry, and fingerprint schema version 5 with old-cache regression coverage. |
| U4 | Wired the Linux+Parcel registry lifecycle into the daemon, including candidate discovery, arm handshake, dir-backed/backend-independent safety floor, scan-only release, push provenance dequeue snapshots, normal-return-only terminal counting, and absolute +2s/+8s git-busy retry episodes. |
| U5 | Added additive `git_capture` client telemetry, failure/concurrency-safe queue snapshots, exact server contract mirror, positional Analytics Engine layout, ingest/drift tests, and the documented admin query. |
| U6 | Added the required Bun contract CI job, compiled Linux release probes, Darwin zero-handle release assertion, Bun 1.3.14 rig image, event-driven small/big empty-commit rig expectations, CODEMAP ownership, and a real-Parcel daemon flood integration test. |

## Focused evidence

The final focused design suites reported:

```text
bun test src/cli/daemon/git-ref-watch.test.ts src/cli/daemon/daemon-git-ref-integration.test.ts
23 pass
0 fail
129 expect() calls
Ran 23 tests across 2 files. [2.03s]

bun test src/cli/daemon/git-ref-watch.test.ts src/cli/daemon/watcher.test.ts src/cli/daemon/daemon-git-capture.test.ts src/cli/daemon/daemon-safety.test.ts src/cli/telemetry/queue.test.ts
74 pass
0 fail
279 expect() calls
Ran 74 tests across 5 files. [8.70s]

cd apps/api && WRANGLER_LOG_PATH=/tmp/w.log bunx vitest run --configLoader runner test/telemetry-ingest.test.ts
Test Files  1 passed (1)
Tests  12 passed (12)

bun test scripts/rig
136 pass
0 fail
501 expect() calls
Ran 136 tests across 21 files. [1107.00ms]
```

The retry audit specifically exercises the lower and upper ±20% jitter edges,
1s doubling through the 60s base cap, the single-earliest-timer invariant, and
retention of live coverage during a sleeping replacement retry.

## Fix round — SCRUTINY-175

All seven findings were accepted. Finding 6 follows the orchestrator's modified
ruling: eligibility is based on the backend actually selected and reported by
the watcher, not on a platform-string prediction.

| Finding | Fix | Adversarial regression |
|---|---|---|
| 1. Ref-storage authority failed open | `gitRefStorage` now distinguishes an absent key (Git exit 1) from probe faults, `gitPreflight` turns authority faults into transient failures, and registry authority faults enter a dedicated retry target without opening handles or running the arm handshake. | `shared.test.ts` covers absent versus malformed authority and preflight failure. `git-ref-watch.test.ts` injects a first-probe rejection followed by authoritative `reftable`, proving zero handles/handshakes before the retry and refusal afterward. |
| 2. Plan discovery could not raise the backend-independent floor | The daemon records additive plan-discovered dir owners independently of the optional registry, includes them in floor computation, and clears that claim only on a complete scan snapshot. | `daemon-safety.test.ts` starts with no registry, an empty authoritative snapshot, and a 300s delay; plan discovery pins the delay to 60s and the complete shrinking snapshot releases it. |
| 3. Namespace admission did not retry | Namespace admission faults/budget failures now retain desired ownership under a per-namespace retry key, obey the shared exponential due-time gate, and reset retry state after successful admission. | `git-ref-watch.test.ts` forces a fail-shallow directory-budget result, proves one pending target/one timer and non-preemption by an unrelated upsert, removes the crowding directory, and proves recursive coverage arms at +1s. |
| 4. Contributor-only changes reopened physical handles | Physical-handle replacement no longer depends on contributor-map equality; unchanged `(canonicalRoot, mode)` handles receive role/refcount filters in place and close only after their final contributor disappears. | `git-ref-watch.test.ts` keeps the exact common-root handle across owner removal and role transfer, asserts no close/reopen, and verifies the live filter changes. |
| 5. Admission followed symlinked namespace roots | Each pending `refs/heads`/`refs/tags` root is now `lstat`-checked and refused unless it is a real directory before `opendir` can follow it. | `git-ref-watch.test.ts` points `refs/heads` at a deep external tree and proves refusal as a non-real namespace root, no budget traversal failure, and no recursive external handle. |
| 6. Construction eligibility predicted unsupported targets | Watchers report the backend they actually selected. Initial discovery is retained until watcher startup returns, and the registry is constructed only on Linux when that reported backend is `parcel`; the self-test uses the same observed result. | `daemon-safety.test.ts` returns a watcher-reported `chokidar` backend on Linux and proves no registry is constructed while the safety floor remains pinned. The Parcel self-test reports and checks its actual backend. |
| 7. Mandatory lock/busy episode regression was absent | The daemon's existing absolute +2s/+8s episode is exposed through an injectable clock for deterministic lifecycle verification; normal runtime still uses native timers. | `daemon-git-capture.test.ts` runs real branch-ref and `packed-refs.lock` episodes through actual registry listener routing and the real debounce/max-wait path. Both locks remain held past max-wait, only the pre-signal is delivered, the final target callback is suppressed, +2s remains busy without resetting the episode/timers, +8s captures the exact OID, the second retry resets, and daemon close cancels the next episode's timers and prevents a late push. |

## Simplify fold

| Finding | Change |
|---|---|
| EFFICIENCY-1 | Registry inputs retain epoch/touch ordering but request reconciliation only for ownership/kind/generation/forced-target changes, snapshot removal, or a currently due retry. Future retries remain timer-driven; refused/outside owners defer re-probe to the next dirty input or any due retry. Added an identical-upsert probe-count regression. |
| EFFICIENCY-2 | `classifyRepoCandidate` now rejects paths that are not `.git` entries before splitting or allocating. |
| EFFICIENCY-3 | Added narrow `floorRequired` and `activeHandles` getters and moved daemon/self-test hot readers off the sorted diagnostic state snapshot. |
| EFFICIENCY-4+5 | Contributor scans are allocation-free, candidate/target scans exit once matched, overflow dirtiness forces active keys in one target pass, listener tails are validated once, and equality table lookups use `includes`. |
| REUSE-7 / SIMPL-1 | Shared owner insertion/kind-flip handling moved to `#mergeOwner`. |
| SIMPL-2 | The three owner generation-dirty paths now share `#dirtyOwner`. |
| SIMPL-3 / EFF-6 | Daemon candidate discovery passes unsorted/undeduped repositories to the registry, which normalizes inputs; authoritative snapshots use exported `ownerOrder`. |
| SIMPL-4 | Removed `Watcher.gitRefWatchActive`; initial discovery continues through `onInitialGitRepos`, which the watcher tests now assert directly. |
| SIMPL-5 | Removed the `onGitSignal` fallback seam; watcher signal tests inject `createSignalDebouncer`. |
| SIMPL-7 | Collapsed `isTarget` to the namespace projection and shared table lookup. |
| SIMPL-9 | Busy-retry stages are generated from `GIT_BUSY_RETRY_DELAYS_MS`, with the terminal stage derived from its length. |
| SIMPL-11 | `packed-refs.lock` now uses its stat identity token without content hashing. |

## Required acceptance outputs

### `bun run typecheck`

```text
$ mkdir -p .cache/tsbuildinfo && tsc --noEmit --incremental --tsBuildInfoFile .cache/tsbuildinfo/root.tsbuildinfo && tsc -p apps/api --noEmit --incremental --tsBuildInfoFile .cache/tsbuildinfo/apps-api.tsbuildinfo
```

Exit status: 0.

### `bun test ./src/cli/ ./src/engine/`

```text
bun test v1.3.14 (0d9b296a)

2590 pass
16 skip
0 fail
30915 expect() calls
Ran 2606 tests across 211 files. [273.67s]
```

### `cd apps/api && WRANGLER_LOG_PATH=/tmp/w.log bunx vitest run --configLoader runner`

```text
RUN  v4.1.10 /home/via/Development/Personal/rbox-core/.claude/worktrees/172b-ref-sidechannel/apps/api

Test Files  46 passed (46)
Tests  781 passed | 4 skipped (785)
Start at  02:29:20
Duration  59.42s (transform 653ms, setup 0ms, import 1.27s, tests 57.42s, environment 0ms)
```

### `bun scripts/probe/bun-refwatch-contract.ts`

Source execution:

```text
bun --version: 1.3.14
execution mode: source
attempts per case: 5; callback deadline: 5000ms
fast git init -> empty commit  PASS  5/5  3.6-4.7ms  churnOps=205056  parcelEvents=4661-4672  refs/heads/main.lock
atomic move-in -> empty commit PASS  5/5  3.9-4.3ms  churnOps=205056  parcelEvents=4665-4672  refs/heads/main.lock
populated ref subtree move-in  PASS  5/5  1.4-2.0ms  churnOps=205056  parcelEvents=4663-4672  refs/heads/x/y/z/deepest
root replacement REPORT: tuple=(66311,29127672) reused after 1 recreation(s); removal callbacks within 5000ms=rename/<null>; post-recreate callbacks within 5000ms=none; expected=rename/<null> then none
Bun ref-watch contract PASSED (3/3 cases)
```

Compiled execution from the same command:

```text
bun --version: 1.3.14
execution mode: compiled
attempts per case: 5; callback deadline: 5000ms
fast git init -> empty commit  PASS  5/5  3.8-4.4ms  churnOps=204608  parcelEvents=4658-4672  refs/heads/main.lock
atomic move-in -> empty commit PASS  5/5  3.9-4.1ms  churnOps=205504  parcelEvents=4660-4672  refs/heads/main.lock
populated ref subtree move-in  PASS  5/5  1.5-2.6ms  churnOps=206400  parcelEvents=4660-4667  refs/heads/x/y/z/deepest
root replacement REPORT: tuple=(66311,29127672) reused after 1 recreation(s); removal callbacks within 5000ms=rename/<null>; post-recreate callbacks within 5000ms=none; expected=rename/<null> then none
Bun ref-watch contract PASSED (3/3 cases)
Compiled execution PASSED (3/3 cases)
```

### `git diff --check`

```text
(no output)
```

Exit status: 0.

Additional guard output:

```text
$ bun scripts/guards.ts
ci-shard-tests: 211 files and 230 runtime units covered across 6 shards
inquirer-import guard: checked src/; only src/cli/prompt.ts may import @inquirer
```

## Deferred / external validation

- `bun run rig git-commit-propagation`: **pending-orchestrator**. The spec assigns
  this Docker/device scenario to the orchestrator; Docker is unavailable in this
  sandbox. Both `small-repo-empty` and `big-repo-empty` now require the
  event-driven path and the sub-30s ceiling.
- Native `linux-arm64` and `darwin-arm64` release execution is carried by the
  release matrix added in U6. This x64 sandbox executed the compiled x64 probe;
  it cannot natively execute the other target binaries. The Darwin leg asserts
  zero side-channel handles, and both Linux legs execute their compiled probes.

No implementation work is deferred.
