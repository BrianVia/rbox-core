# 290 — Batch consecutive confirmed directory deletions

Status: ALIGNED after Claude round 1 conditional approval and source-verified clarifications below; implemented and locally validated. Complexity probe reproduced on baseline `c4aa22bbb`, Bun 1.4.0. Implements only roadmap 287 F2a.

## Problem and smallest primitive

`applyWatchEvents` in `src/engine/manifest.ts` copies and traverses every remaining manifest key for each `unlinkDir`, including consecutive notifications whose paths have already disappeared. A 124,000-entry fixture with 1,000 absent directory events visits **123,500,500 map keys**, even though only 1,000 entries change. The isolated red probe `/private/tmp/rbox-290-complexity-probe.mjs` checks both the expected 123,000 survivors and a ceiling of two manifest traversals; baseline fails only that complexity assertion. Its instrumented wall time was 2,249.7 ms; this is diagnostic instrumentation, not a speedup baseline.

Use one local `Set<string>` of confirmed absent roots and the existing path map. No prefix tree, observer API, persistent index, flag, wire field or schema change. Preserve current full-manifest output sorting; this slice removes repeated deletion scans, not all O(N) work.

## Protected behavior and ownership

The existing manifest observer owns ordered event interpretation and the returned map. `HashCache` owns invalidation/dirty state, and the existing caller-provided deferred set retains its meaning. Keep stale-event re-observation, present directory rescans, directory-to-file/symlink replacements, ignore/prune decisions, mid-write preservation, unreadable preservation, exact path boundaries, and final manifest sorting. Keep root-path events ignored. No feature or compatibility retirement is proposed.

Only `isAbsent(error)` (`ENOENT` or `ENOTDIR`) establishes an eligible absent observation. Do not broaden this optimization to other lstat failures. Existing handling of other errors remains unchanged, including its current unclassified-error behavior; correcting that behavior would be a separate reviewed change.

## Ordered algorithm

1. Retain sequential event processing and sequential `lstat` calls. Before any non-`unlinkDir` event (including ignored/empty events), flush pending deletions before its matcher/stat/hash/cache/map/deferred effects.
2. For `unlinkDir`, perform its existing `lstat`. An `isAbsent` exception adds its path to the pending set and continues. A subsequent absent `unlinkDir` can join that run: these observations neither consult the manifest/cache nor add deferred entries.
3. If `lstat` instead observes a present object, unreadability, or another error, flush the pending run before applying this event's existing handling. Then preserve that original branch unchanged. There must be no matcher, cache lookup, map-dependent rescan, or deferred mutation between an earlier queued deletion and this flush.
4. To flush, visit each current map key once. Delete/invalidate the key if it equals a pending root or if any slash-delimited ancestor belongs to the set. Iterate slash positions with `indexOf`, checking membership at segment boundaries; `foo` must never delete `foobar`. Delete safely during native Map iteration; do not allocate a complete key array.
5. Also invalidate each pending exact root, even if absent from the manifest; the old code does this and the cache may contain such an entry. Clear the pending set. Flush once at completion before generating the final sorted manifest.

For N current files and K absent events, the deletion pass performs O(N × path depth + K) membership work per consecutive absent run, plus unchanged O(K) sequential filesystem observations and existing output sorting. Overlapping/repeated roots naturally coalesce. No batching crosses an intervening event. Mixed workloads with many separated single deletions retain their previous asymptotic cost; broad watcher reduction is outside this slice.

Cache invalidations inside an absent-only run become grouped and may be deduplicated/reordered. This preserves actual `HashCache` contents and dirty state: invalidate is synchronous/idempotent and no consumer reads or records the cache inside the run. Exact invalidation callback counts are not a public contract. Review must explicitly accept this distinction from preserving the event-dependent state at each observation boundary. No new injection seam is needed.

The pending set is disposable observation state. A process crash produces no new durable state. Pending deletions are flushed before all later event handling that can throw, so no extra exception/finally machinery is required. Existing exception propagation remains unchanged.

## Validation and implementation slices

After approval, add a focused behavior suite and minimal observer edit together. Cover overlapping/duplicate roots; sibling-prefix collisions; exact-root cache entries absent from the manifest; nested cached children and preserved siblings; ENOTDIR; ignored paths; empty events; boundaries before add/change/unlink/addDir; stale present directory, file, and symlink events; permission-denied deferral; and failure propagation. Prefer compact table-driven fixtures plus existing `apply-safety`, `engine-m1`, `manifest-scan-fault`, `manifest-torn-scan` and ignore tests to duplicating their coverage. Stateful boundary fixtures should demonstrate later hashing cannot reuse an earlier deleted cache identity, and deferred children are not incorrectly deleted.

Use the frozen baseline observer as a temporary differential oracle only if needed; do not ship a second implementation in production or mirror the entire function in permanent tests. Retain the isolated complexity probe as evidence, then run a reproducible committed opt-in benchmark without prototype instrumentation: 124,000 entries / 1,000 absent deletes, one warm-up, three measured runs, report median and survivors. Compare baseline and changed code with the same Bun 1.4.0 and fixture. Report the actual measured benefit; the historical approximately 70× deletion prototype is a hypothesis until this ordered implementation is timed.

Run focused tests, affected engine tests (full engine suite where practical), TypeScript check and `bun run lint:affected` with Bun 1.4.0. Inspect touched-file anti-slop warnings, preserving proper narrow types and avoiding suppression. Root owns the overall integrated rig/release acceptance; this local observer slice introduces no fleet or production operation. At most three design/review rounds; this executed probe supplies the required non-paper evidence.

Rollback is a source revert: no durable/wire migration or compatibility flag exists. Acceptance requires identical manifest/cache/deferred outcomes at event boundaries and bounded traversal growth, not merely an improved wall time. No supported behavior may be dropped to meet the benchmark.

## Round 1 clarifications verified against baseline source

Claude Fable 5.1 accepted the primitive and idempotent invalidation grouping, conditionally ALIGNED after three explicit clarifications; no further design round requested. The root authorized implementation after source verification.

1. The exact old absent branch effects are `map.delete(k)` and `cache?.invalidate(k)` for each prefix descendant, followed by `map.delete(rel)` and `cache?.invalidate(rel)` for the exact root, including a cache-only root. **There is no deferred-set removal or other per-key side effect.** The new flush preserves these effects and leaves pre-existing deferred entries intact. A focused regression asserts that a deleted manifest path can remain deferred, matching baseline. `indexByPath(base)` creates a new working Map once; neither the input array nor its entries are mutated.
2. `unlinkDir` performs `lstat` before consulting ignore rules. When absent, the old `st && !matcher.ignores(rel)` condition short-circuits, so **absent-but-ignored roots are deleted without calling the matcher** and are eligible for the run. Present/pruned or unreadable events cannot join and flush first. The focused fixture uses a throwing matcher on an absent run to preserve this behavior.
3. `WatchEvent.relPath` and `FileEntry.path` specify POSIX-relative paths; watcher-produced directory roots ordinarily lack leading/trailing slashes. The implementation must nevertheless preserve **literal** existing comparisons, not normalize event roots. For every slash position in key `k`, `k.slice(0, slash) === rel` is exactly equivalent to the old `k.startsWith(rel + '/')`. This also handles repeated/trailing slashes literally. Empty roots remain ignored. The odd-spelling fixture covers `gone/`, `./gone`, backslash-containing roots, repeated separators and an empty event; `gone/` must not remove canonical `gone/child`.

The absent-only benchmark is an upper-bound workload opportunity: real watcher streams may interleave file unlinks or other observations, splitting runs. Such streams retain O(N) work per run; this slice makes no general 10× claim.

## Implementation and measured validation

The observer change uses a local Set and one ancestor-membership pass per absent run. Existing present-object/error branches remain, with explicit flush boundaries. Source changes also move the existing `isDeferrableFileError` guard to its two filesystem catch sites so `deferWalkFault` accepts a narrowed `NodeJS.ErrnoException`; this resolves the touched-file oxlint warning without suppression, casts, or changing fault classification.

Bun **1.4.0**, same fixture and machine, one warmup then three measured observations:

| Measurement | Baseline | Implemented |
|---|---:|---:|
| 124k files / 1k consecutive absent `unlinkDir`, median | 1,401.45 ms | 26.95 ms |
| Three measured times | 1,438.83 / 1,401.45 / 1,397.83 ms | 26.95 / 27.82 / 26.12 ms |
| Isolated map-key visits | 123,500,500 | 124,000 |
| Surviving entries | 123,000 | 123,000 |

This is **52.0×** on the absent-only fixture, including original sequential lstats, index construction and final sorting. The deterministic complexity probe is green at 124,000 visits (ceiling 248,000). It instruments Map iteration only in its isolated process and is excluded from wall-time measurements. Reproduce uninstrumented current timing with `bun scripts/bench/absent-delete-batching.ts`. Interleaved-event performance is explicitly unclaimed.

Focused regression command: `bun test src/engine/manifest-absent-delete.test.ts src/engine/manifest-scan-fault.test.ts src/engine/manifest-torn-scan.test.ts src/engine/apply-safety.test.ts src/engine/engine-m1.test.ts`: **68 pass, 0 fail**, including 10 new deletion tests, after lint cleanup. The new suite checks cache dirty-state transition and preserves a cache-only descendant absent from the manifest: baseline does not invalidate such descendants merely by prefix.

`bun run typecheck` passed (root, API, scripts). `bun run lint:affected` passed with **zero warnings** after the typed catch-boundary cleanup. A broader initial 115-test run including `ignore.test.ts` produced 114 passes and the independently introduced F1 red fixture `tracked cache rejects a same-size index replacement with restored mtime`; it is unrelated to deletion batching and remains owned by the parallel F1 slice. Local logs: `/private/tmp/rbox-290-tests.log`, `/private/tmp/rbox-290-typecheck.log`, `/private/tmp/rbox-290-lint.log`. No fleet, API or production mutation was performed. Root will record compiled-rig integration separately.

## Cohesion audit and formatting-only polish (round 2 ALIGNED)

The batch state remains local to `applyWatchEvents`: its pending roots, working Map and invalidations are one ordered observation operation. Extracting only the flush into a separate file would pass those same authorities through a shallow helper without reducing decisions or ownership. A larger extraction of the complete observation/walker interface could be meaningful, but would be an independent design rather than a prerequisite for this measured, bounded correction. This finding does not excuse arbitrary future growth or declare the whole manifest module permanently exempt from architecture review.

Restored the pre-format candidate from an inverse reconstruction. Formatting that reconstructed file with the exact prior Prettier 3.8.4 configuration (`parser: typescript`, `printWidth: 140`, `trailingComma: none`) reproduced the previous candidate **byte-for-byte** before adding the ownership header. Thus the broad formatting churn was removed without changing the parsed program. A one-line `Never:` header now identifies the existing local-observation owner and excludes remote transfer, Git/ref mutation and durable sync-state publication; no responsibility moved.

Final measured `src/engine/manifest.ts`: **755 nonblank lines / 35,863 bytes**, versus raw baseline **727 / 34,743**, an increase of **28 lines / 1,120 bytes**, including the ownership header and typed error-boundary cleanup. The single manifest allowlist reason now begins `audited cohesive (design 290)` and its recorded ratchet is **687 / 32,603**: `ceil(actual / 1.1)`. Under the unchanged 10% rule this permits at most 755 nonblank lines and 35,863 bytes: there is no additional whole-line or whole-byte growth allowance. No global threshold, slack multiplier or other module's allowance changed in this polish.

Validation after restoration/header/allowlist update: Bun 1.4.0 focused F2 suite **68 pass / 0 fail / 246 assertions**; module-size suite **6 pass / 0 fail / 189 assertions**. `bun run lint:affected` exits 0 with no F2 or size-guard findings; it currently reports four warnings in the independently edited `fingerprint.ts`, owned by the parallel Git slice. `git diff --check` passes. The earlier deletion benchmark remains applicable because the program is formatter-equivalent. Root independently reviewed this audit, and Claude Fable 5.1 at medium effort returned ALIGNED in round 2. Nonblocking error-path and literal-spelling confirmations match existing fixtures; no third round or source change was required. See `docs/design/reviews/REVIEW-290-2.md`, which also corrects a reviewer misreading: the 32.98 ms timing is the parent agent rerunning the same fixture, not evidence from a different workload or an order-independence benchmark.
