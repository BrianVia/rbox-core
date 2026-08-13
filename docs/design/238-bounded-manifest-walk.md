# 237 — Bounded manifest walk and watcher backend pin

Status: implementation-ready. Founder-approved scope is `SPEC.md` at the
worktree root. Baseline execution before implementation: `bun test src/engine/`
ran 883 tests (878 pass, 5 skip), and `bun test
src/cli/daemon/watcher.test.ts` ran 21 tests (21 pass).

## 1. Protected functionality

`src/engine/manifest.ts` remains the sole owner of disk-to-manifest traversal.
The change preserves canonical sorted `FileEntry` output, ignore/prune and Git
discovery calls, symlink treatment, hash/dircache fast paths, discovery
callbacks, scan counters, warning routing, per-file deferral, fail-loud
directory enumeration, the Darwin bulk listing path, and the single bounded
pruned-to-unpruned retry. `applyWatchEvents` continues to reuse the same walk.

`src/cli/daemon/watcher.ts` remains an adapter. It preserves native pruning,
authoritative JS filtering, Git signals, batching, degradation, and cleanup.
It only selects the already-supported native backend explicitly.

No command, protocol, format, migration, compatibility path, safety property,
or fast path is approved for deletion or retirement.

## 2. Current code and corrected citations

- Canonical manifest sorting is defined at `manifest.ts:177-180` and invoked at
  lines 73 and 136.
- `walk` begins at line 429. Child recursion is serial at line 566; file stats
  are serial at lines 598 and 604. The Darwin bulk branch is lines 461-479.
- The Parcel subscribe call begins at `watcher.ts:345`.
- Resolved Parcel watcher 2.5.6 declares `Options.backend?: BackendType`, with
  `"inotify"` and `"fs-events"`; `wrapper.js` preserves `backend` while
  normalizing `ignore`, then forwards the same options to subscribe/unsubscribe.

Two requested test descriptions conflict with protected current behavior.
Unreadable directory enumeration is intentionally fatal (design 108 and the
existing fault test), not deferred. `RulesChangedDuringPrune` is internal and
causes one unpruned retry, not a public rejection. Tests will pin the current
fatal classification and the public retry/abort contract while verifying that
no queued work starts after the abort fence.

## 3. Unit 1 — one shared walk pool

`runWalk` owns one private dynamic task pool with a constant limit of 16.
Directory tasks perform the existing directory-local listing/conversion logic,
then enqueue child directory tasks and file-stat tasks into that same pool.
They never await queued descendants, so all slots remain usable and recursive
semaphore deadlock is impossible. Symlink reads stay directory-local. The
existing bounded hash phase remains unchanged and runs after the walk drains.

The pool owns queueing, active count, first fatal error, and the abort fence.
The first fatal error synchronously closes the fence, discards queued work,
waits for already-running siblings, and rejects with the original error. Rule
inventory detection closes that fence at the detection site before throwing,
so no new work starts afterward. Per-file deferrable failures are caught inside
their task and never reject the pool.

A recursion scheduled from a reused dircache listing receives an absence scope.
Descendants of every task kind (directory, file-stat, and directory-local
symlink read) inherit it until a nearer reused boundary. Exact `isAbsent`
classification (`ENOENT` or `ENOTDIR`) happens before global-fatal
classification: it cancels queued-not-started work in that scope, including
nested scopes, and is swallowed, matching the existing recursive catch
boundary. Other errors abort globally. A focused reused-listing disappearance
test pins both the benign absence and completion of a real sibling.

Accounting keys and wrappers remain. Concurrent walk buckets become cumulative
task-time; exactly one code comment records that fact. The accounting test keeps
the fixed keys, non-negative finite values, residual-bucket identity, wall
interval, and attempt boundaries, but drops the now-invalid assertion that
overlapping operation task-time sums to wall time. No union/wall attribution is
added. Final sorting makes stable-tree manifests byte-identical despite
completion order.

Validation: an independent serial reference fixture (nested directories,
symlink, ignored subtree, empty directory, hash-needed files) freezes time and
compares every manifest field plus sorted per-path invocation multisets for
`prunesForGitDiscovery`, `prunes`, and `ignores`. Three-run determinism also
freezes `generatedAt`. The abort test uses a controlled filesystem mock: it
saturates the pool, releases one task so rule discovery closes the fence, marks
the unpruned retry, and proves queued starts occur only after that retry marker.
Other gates cover reused-listing disappearance, unreadable-directory
classification, existing dircache/bulk/fault suites, the full engine suite,
typecheck, and affected lint. A scratch 50k-file script compares production
pool-16 `scanManifest` with an in-script serial/pool-1 reference; the production
constant has no environment or public test knob.

## 4. Unit 2 — backend selection at the adapter boundary

Extend only the private Parcel wrapper option type and pass
`backend: process.platform === "darwin" ? "fs-events" : "inotify"` alongside
the existing ignore list. `loadHostBinding` already admits only Darwin and
Linux, so no extra fallback or platform mode is needed. An isolated subprocess
mocks the host native binding and asserts the normalized options reaching it,
avoiding contamination from the module-global wrapper cache.

## 5. Complexity and requirement challenge ledger

The only new concept is the private queue required to express bounded dynamic
tree work; it is owned wholly by the scan producer and exposes only enqueue,
abort, and drain internally. No CODEMAP ownership line changes.

Rejected scope: matcher memoization, native/io_uring traversal, changes to
ignore/dircache/Darwin bulk modules, environment knobs, Watchman fallback, and
wall-time attribution machinery. The spec's directory-deferral and public-abort
wording would weaken established safety behavior, so current behavior remains
the requirement unless separately approved.

## 6. Commit and acceptance plan

Commit 1 contains this design/reviews, bounded walk, five Unit 1 tests, and the
bench. Commit 2 contains only the watcher backend pin and binding-boundary test.
Acceptance is the four commands in `SPEC.md`, plus direct new-test and benchmark
runs. The final diff is reviewed for byte behavior, abort/fault/crash semantics,
compatibility, accounting, and warm performance.
