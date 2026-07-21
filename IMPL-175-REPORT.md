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

## Required acceptance outputs

### `bun run typecheck`

```text
$ mkdir -p .cache/tsbuildinfo && tsc --noEmit --incremental --tsBuildInfoFile .cache/tsbuildinfo/root.tsbuildinfo && tsc -p apps/api --noEmit --incremental --tsBuildInfoFile .cache/tsbuildinfo/apps-api.tsbuildinfo
```

Exit status: 0.

### `bun test ./src/cli/ ./src/engine/`

```text
bun test v1.3.14 (0d9b296a)

2583 pass
16 skip
0 fail
30841 expect() calls
Ran 2599 tests across 211 files. [269.66s]
```

### `cd apps/api && WRANGLER_LOG_PATH=/tmp/w.log bunx vitest run --configLoader runner`

```text
RUN  v4.1.10 /home/via/Development/Personal/rbox-core/.claude/worktrees/172b-ref-sidechannel/apps/api

Test Files  46 passed (46)
Tests  781 passed | 4 skipped (785)
Start at  01:42:12
Duration  59.27s (transform 643ms, setup 0ms, import 1.26s, tests 57.26s, environment 0ms)
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
