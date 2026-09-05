# Design 291 implementation validation

The local implementation stores lossless bigint `dev`, `ino`, `size`, `mtimeNs`, and `ctimeNs` alongside the resolved main-index path. It validates complete cache records before deciding freshness, compares fields without JSON ordering assumptions, and re-stats both cache hits and fresh native observations. One complete retry handles main-index drift; continued instability preserves unavailable trackedness.

Valid version 1 records become misses and may be upgraded after stable ordinary enumeration. Malformed, unreadable, and future-version records preserve the existing possibly-tracked/no-prune/no-purge outcome and are not overwritten. An unavailable observation is never an empty tracked set.

Only positively observed ordinary indexes can populate `dependency: "none"` records. Native Git calls pin `core.splitIndex=true`, `core.fsmonitor=false`, and `core.untrackedCache=keep` so repository configuration cannot hide the dependency or invoke a monitor hook. Dependency discovery accepts the exact ordinary null-OID sentinel or empty success; other nonempty output must have a valid shared-index basename. Split indexes enumerate fresh every time, with stable main-index bracketing and no cache publication. Missing shared files produce unavailable trackedness.

Final focused validation under supported Bun 1.4.0:

- `bun test src/engine/ignore.test.ts src/engine/manifest.test.ts`: **70 pass, 0 fail, 1,102 assertions**; 68 ignore tests plus two parent-owned manifest tests. Local output: `/private/tmp/rbox-291-final-tests.txt`.
- The same-size/restamped replacement and same-inode in-place rewrite were demonstrated RED before implementation and now pass. Bigint assertions establish their identity preconditions.
- Admission tests cover serialized nanosecond fields, key-order-independent cache hits, v1 migration, eight malformed/future cases, cache read failure, nonregular indexes, source changes during fresh enumeration and warm cache reading, bounded retry, and owned-temp cleanup after rename failure.
- Native fixtures cover ordinary/split transitions, missing dependency, actual split bytes with configured split=false and an executable monitor hook, and readable0555 Git metadata. Existing linked-worktree and committed/unborn absence safety tests remain passing.
- Subprocess counts: ordinary warm 1, ordinary cold 3, split 3 per evaluation. Continuous source drift stops after two complete attempts.
- `bun run typecheck`: root, API and scripts passed.
- `./node_modules/.bin/oxlint src/engine/ignore.ts src/engine/ignore.test.ts`: clean without new suppressions or JSON casts.
- Scoped `git diff --check`: passed.

[Review round 2](../../reviews/REVIEW-291-2.md) is ALIGNED based on supplied design and execution evidence; the unsuccessful earlier invocation had no verdict. Compiled rig and broader integration remain parent-owned. These figures supersede the early 48-test implementation note; no claim is made here about the current state of unrelated capture suites.

The review's optional unique-temp suggestion is already satisfied by PID/random filenames, exclusive creation, and ownership-scoped cleanup. Crash leftovers do not force reuse of a fixed temporary name. No sweep or new recovery subsystem is added.

Normal concurrent Git commands may refresh or rewrite the main index, changing ctime/inode without changing the set of tracked names. Rejecting that token yields a safe cold miss or bounded retry, not a warm-hit regression. Track cold-miss frequency separately during the deferred 100-repository/large-index latency evaluation. Full split-cache performance stays deferred: Git refreshes shared-index timestamps during reads, so these timestamps are not a stable cache witness.

## Final structural gate repair

The complete observation/cache owner moved to `src/engine/tracked-repo.ts` behind the same operation and typed result; see [round-3 addendum](owner-boundary-addendum.md). No matcher tests or F1 semantics changed. The repeated supported-Bun run remains 70/70 with 1,102 assertions; typecheck and targeted lint pass. The integrated module-size guard passes all six tests (189 assertions). The remaining ignore ratchet tightened to 676 nonblank/31,292 bytes; the new owner is 188/8,918 and needs no exception. Final independent review is [ALIGNED in round 3](../../reviews/REVIEW-291-3.md), and the root source review also aligned. The parent-owned compiled integration rerun was still running at this update.
