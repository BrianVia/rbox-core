# Sync pipeline audit — current checkout 3c78a055a

Read-only source audit and temporary-file probes, 2026-09-04. No repository changes, no fleet/prod operations. Measurements below ran on this Mac with installed Bun 1.3.14; package.json declares ^1.4.0, so these are local diagnostic measurements, not release-runtime acceptance. The parent agent separately measures codec/refset costs.

## High-confidence findings

### 1. File-deletion bursts perform a complete manifest traversal per deleted file

**Current path:** `src/cli/daemon/watcher.ts:380-385` translates every Parcel delete into `unlinkDir`, including ordinary file deletions, because Parcel does not distinguish types. `src/engine/manifest.ts:300-359` rechecks disk (correct), but absent paths go through `for (const k of [...map.keys()])` at **341**. Every deleted file therefore allocates another full key array and checks every remaining path for that nonexistent file's descendants. Existing-directory rescans have another whole-map traversal at **332**. At **272** each batch also rebuilds the manifest map; **383** sorts all resulting files.

**Reproduction:** `/private/tmp/rbox-delete-probe.ts` with 124,000 synthetic manifest entries and existing temp root containing none of the deleted files measured 25ms for 1 delete, 34ms for 10, 131ms for 100, and 1229ms for 1000. `/private/tmp/rbox-delete-comparison.ts` repeats 1000 deletions and compares the real implementation to an intentionally narrow prototype: same 1000 sequential `lstat` checks, then one filter checking exact deletion/ancestor membership. Exact result path equality passed each run. Real: **1190.8/1244.1/1172.3ms**. Prototype: **16.87/16.17/15.70ms**, **70.6–76.9×** faster. This is a demonstrated >10× improvement opportunity in a bounded hot path, NOT a 70× whole-sync claim. Prototype covers absent deletes only and is not proposed production code.

**Implement:** normalize absent deletion prefixes once and remove them with one ordered range/ancestor pass, or deepen the existing local-manifest owner with a path/prefix index that can remove only affected descendants. Preserve per-path disk reobservation, stale unlink behavior after a pull rewrite, file↔directory type flips, unreadable subtree deferrals, and event ordering. Do not simply reinterpret all events as ordinary file deletes. A batch-level classification phase plus existing safe reconciliation primitives should be enough; no new durable queue.

**Gate:** 124k entries × 1/10/100/1000/10000 deletes, plus overlapping parent/child deletes, deletion then recreation, recreated directory containing altered descendants, unreadable ancestors and files, rename/typeflip echoes, and interleaved writes. Require exact manifest+deferred+cache equality against current path and >10× 1000-delete gate. Add observed queue age/event-loop lag, since this CPU shares watcher and socket callbacks.

### 2. Scan-free trusted pulls still synchronously rebuild a full tracked-file matcher

`src/cli/sync/pull.ts:242-244` loads hashcache/dircache then unconditionally calls `matcherForState` before deciding at **257** to use the trusted view. `src/engine/ignore.ts:581-586` runs synchronous repository discovery and loads every repo's tracked set; **678-698** recursively `readdirSync`s the tree; **716** invokes git to find each index; **765-767** uses `spawnSync`. Even cached tracked sets require that git subprocess and JSON parsing. `src/cli/daemon/daemon.ts:2878-2894` already caches a matcher and explicitly documents why rebuilding per load is too costly. Pull dependencies at **2175-2190** pass hashcache but neither matcher nor dircache.

**Measured:** `/private/tmp/rbox-matcher-probe.ts` constructs 100 real git repositories and 1100 directories in temp storage. `respectGitignore=true` initial matcher build **3743ms**; four warm builds **1951/1828/1701/2033ms** (middle pair ~1889ms). `respectGitignore=false` warm builds ~**0.24–0.38ms**. These are synthetic representative measurements, not a live-fleet profile. The expensive path blocks the JS event loop for most of its duration.

**Implement:** have the local observation owner supply the valid matcher into pull, keyed to rule/topology/index generation, while preserving pull's existing two-phase rule-file application (`pull.ts:291-303`). Avoid introducing a second authoritative matcher cache in the pull adapter. Lazily acquire dircache only when an actual scan is required; `withDircache` currently parses on every invocation (`sync/deps.ts:154-161`) and `LocalWorkspaceObserver.observeScan` independently reloads at `local-workspace-observer.ts:286`.

**Gate:** trusted pulls without rule/topology/index changes spawn zero git processes for matcher construction and load zero dircache JSON files. Index changes, newly discovered repositories, imported Git state, and ignore-rule actions must invalidate/rebuild correctly. A raw shared matcher without freshness proof is not acceptable.

### 3. Reproduced tracked-file cache correctness defect: index mtime+size are treated as identity

`src/engine/ignore.ts:754-759` collects only index size+mtime, and **786-798** accepts cached tracked paths when index path+size+mtime match. Unlike the hashcache, it does not check ctime, device/inode, or index checksum.

**Exact reproduction:** `/private/tmp/rbox-pipeline-probe.ts` creates a repo with `.gitignore=*.secret`, force-adds `a.secret`, pins index mtime to a fixed valid timestamp, builds the matcher, removes a from index and force-adds equal-length `b.secret`, then restores that same index mtime. Both index files are **104 bytes**. Fresh `git ls-files` returns **b.secret**, but a newly constructed matcher returns **a tracked=true, b tracked=false, b ignored=true**. This is conditional on same-size index replacement with restored/coincident mtime, not claimed for every normal git add. It can cause tracked content to be omitted by ignore protection, and stale old tracked paths to remain allowed.

**Implement:** reuse the project's Git index identity primitive if suitable; at minimum ctime+dev+ino plus stable pre/post observation, including split-index dependencies if supported. Preserve the deliberate distinction between genuinely unborn/absent index and unreadable index (`ignore.ts:701-711`): unreadability must not silently authorize deleting formerly protected files. Fix this before relying on a longer-lived matcher.

### 4. Internal caches still rewrite large human-unreadable JSON records

`EncryptAddressCache.load` reads/parses all entries and reconstructs maps (`src/engine/encrypt-address-cache.ts:208-215`, constructor **101-123**). A single changed entry makes save sort all hashes and path arrays and JSON serialize the entire map (**200-225**). Every changed push loads this cache (`sync-recovery.ts:156`) and its finally block prunes and synchronously awaits flush (**526-532**). Even no-op push loads/prunes it (`sync/push.ts:682-684`, `sync-recovery.ts:120-123`). HashCache has analogous whole-file JSON save (`engine/hashcache.ts:100-105,143-159`). This contradicts the repo's desired SQLite primitive for internal state, although cached data is safely discardable rather than authoritative sync state.

**Measured** `/private/tmp/rbox-pipeline-probe.ts`, three samples per size:

| Cache entries | Serialized bytes | Median load | Median save for one changed entry |
|---:|---:|---:|---:|
| 1000 |184,278|1.83ms|10.03ms|
|10,000|1,840,278|17.60ms|25.80ms|
|124,000|22,816,278|319.69ms|83.49ms|

The save wall includes current atomic/fsync path. The changed row is tiny; ~22.8MB still written. The no-op path pays read/materialization even when nothing can be pruned.

**Implement:** key/epoch-scoped indexed SQLite cache with batched upserts/deletes and owner-held handle; preserve safe corrupt-cache discard, deterministic convergence, exact account/workspace/key scoping, and interrupted-first-publish reuse. Explicit changed/deleted path sets should drive pruning, with periodic full sweep as backstop. One deep cache owner is preferable to three competing JSON/cache services. Expected >10× fewer bytes/rows touched is clear; no end-to-end 10× claim from this ~0.4s microbenchmark.

### 5. Several paths described as O(change) are actually O(workspace) in memory

`applyWatchEvents` map rebuild/sort described above; `/private/tmp/rbox-pipeline-probe.ts` sends a single ignored event (no fs/hash work) and measures median **0.096ms at 1k**, **0.665ms at 10k**, **9.357ms at 124k**. This particular lower-bound cost is modest on this machine, not the top current bottleneck.

`src/cli/daemon/manifest-update.ts:75-77` calls post-pull refresh O(applied), but **111-125** copies the entire trusted file array, and **139-147** verifies full post-base sort order before binary lookups. This avoids an expensive filesystem scan and previous map/sort, but it is O(N), not O(K).

`src/engine/manifest-delta.ts:354-365` validates two complete manifests, rediscoveries changes, hashes target; fold **530,554,558-559** rebuilds/sorts/hashes/validates all files. Parent agent is independently measuring those costs. Long term unify delta-aware indexed local state and manifest codec around one owner, materializing arrays only at legacy/full-snapshot boundaries; Merkle/incremental roots are a later wire-format migration. Do not remove boundary validation merely to make a benchmark fast.

## Other credible opportunities, separated from measured wins

1. **Locally satisfy new worktrees from already-present bytes.** Design 52 is drafted but not implemented in current apply path: `src/engine/apply.ts:339-356` always fetches encrypted file content from store. Build plaintext-SHA candidate lookup from the local view; reflink/copy sibling content to the normal staging temp, hash it, then existing expected-local check and atomic publish. Never hardlink mutable worktree files. >10× network-byte reduction is plausible for >90% identical sibling worktrees; wall gain depends on Git/materialization share. Mutating local source mid-copy must fall back safely. Especially aligned with user's worktree emphasis.
2. **Parallel multipart parts.** Still serial at `src/cli/remote/multipart.ts:117-140`. Add bounded per-object parts under global byte/FD budget, retain server-authoritative completed parts, digest verification, resume identity and one final completion. Measure 2GiB incompressible/compressible transfers and completion wall separately. It cannot exceed physical bandwidth.
3. **Large blob chunking.** Current FileEntry has one ciphertext address and whole-file content hash (`engine/types.ts:12-42`), no content-defined chunk references. A 1MB edit to a 1GB frequently rewritten artifact could produce >100× byte savings with content-defined chunking, but measure the actual large-mutating-file cohort first. Existing design 40 is not an implementation. E2EE per-chunk derivation, chunk-level authentication, root accounting, garbage collection, bounded reassembly, and old-client negotiation must be solved before shipping.
4. **Reduce staging passes and duplicate directory work.** Apply serially lstats every distinct ancestor (`engine/apply.ts:152-160`), then per-file mkdir (**273**), and downloader mkdir before writing and publishing (`remote/blob-batch/downloader.ts:378,388`). Encrypted bytes land at .ct and are reread/decrypted (`apply.ts:349-363`). Large encrypt path snapshots+hashes+compresses+hashes+encrypts+hashes (`crypto.ts:255-323`). A single verified-staging primitive can hash while writing/streaming, and a directory plan can prepare ancestors once. Preserve verify-before-displace and final expectedLocal guard (**288-311**). Source-heavy joins historically spent little time decrypting; do not inflate this opportunity.
5. **Network preparation outside serialized mutation lane.** Scheduler prioritizes deepScan > fullScan > pull > push (`daemon/policy.ts:130-136`). Prestage verified remote data while another operation owns mutation lane; stage sender ciphertext during debounce (`watcher.ts:330-331`). Bound speculative bytes and discard stale work safely. This must not preempt critical Git/apply sections. Current WS frames are hints (`remote-wakeup-channel.ts:232-245`), so coupling verified envelope+delta delivery can remove repeated RTTs, but account revocation and chain pin validation stay mandatory. Parent API audit covers protocol design.
6. **Reliability floor caps latency improvements.** WS cursor checks 45s and polling backstop300s (`daemon/policy.ts:30-31`), and startup not-ready frames are dropped (`remote-wakeup-channel.ts:232`), though catch-up-on-ready exists elsewhere. Payload/cursor-aware delivery-gap detection and bounded pending latest-head coalescing deserve attention; do not call this guaranteed lost updates since catch-up is a safety path.

## Existing wins and failed ideas that must NOT be rediscovered as new

- State memoization design277 shipped: historical docs/STATUS.md:156-159 report desktop push7.4→1.5s, Mac2.7s; no-op state materialization fix already exists. These are dated field observations, not measurements of current release.
- Trusted daemon pulls, pull-only live watcher, bounded scan concurrency, native watcher, ciphertext compression, worker crypto, batch transfer, delta manifests, change preflight, receipt draining, incremental Git packs and held-defer skipping already exist.
- Connectivity-defer skip278 shipped; historical STATUS:161-178 reports FM pull44.3→20.5–21s. Do not pitch repeated bundle refetch fix as missing.
- Overlapped publish pipeline is implemented, **default off**, not absent (`sync-recovery.ts:67,71,192`; `publish-pipeline/pipeline.ts:1-13`). Historical field gate **315s serialized vs540s pipeline (+71%)** at `docs/STATUS.md:2106`. Default 256MiB shared disk budget (`pipeline.ts:52,85`) and FIFO budget (`budget.ts:46-54`) admit oversized objects alone, which is a plausible large-object head-of-line mechanism, not independently proven root cause. Rebenchmark and repair scheduling before enabling; simply making work concurrent is not sufficient.
- Blob packing exists but field result historical **~16% slower** despite20,408→45 R2 PUTs (`docs/STATUS.md:2100`). More packing or more slots are hypotheses, not free wins.

## Protected-functionality and ownership ledger

Preserve: E2EE account/key separation and authenticated commits; server/receiver content digests; snapshot stability under writers; ignore and tracked-path authority; stale-event/typeflip behavior; concurrent local edit preservation; verify-before-displace; atomic publish; trash/conflict recovery; missing/unreadable distinctions; watcher overflow → distrust → scan; safe no-op and legacy/full-snapshot fallbacks; bounded memory/FD/temp disk; serialized physical mutation; worktree mutable-file independence.

Proposed owners:
- LocalWorkspaceObserver/LocalAuthority owns file observation, matcher freshness, indexed local paths, dirtiness and trusted-view provenance; never network publication or Git mutation.
- Existing sync/Git index observation owner supplies complete stable index identity; never let ignore adapter invent weaker identity.
- Cache owner owns scoped disposable indexes/transactions; never logical base/receipt authority.
- Verified staging/transfer primitive owns bounded acquisition, decrypt/hash/temporary bytes; apply owns expected-local comparison, conflict preservation, rename and mutation fence.
- Existing publisher/remote owner owns commit protocol; do not add per-adapter alternate publication orchestration.

No implementation proved safe for deletion in this read-only audit. Do not delete the off-by-default pipeline/pack routes merely because their old performance gate failed; usage, support, docs, dynamic imports, packaging, CI and product retirement gates remain unproven. Staged migration/checkpoint/compatibility and fallback paths remain protected.

Requirement challenges requiring product/format decisions: whether full workspace membership/refsets must travel every small commit; whether mtime belongs in portable canonical metadata when documented as local hint; whole-file transport for huge mutable artifacts; waiting out debounce before any useful preparation; WAN fetch for locally identical sibling files. None is approval to reduce correctness or existing supported behavior.

## Validation actually executed

`bun test ./src/engine/manifest-stability.test.ts ./src/engine/manifest-scan-fault.test.ts ./src/engine/manifest-walk-concurrency.test.ts ./src/cli/daemon/watcher-trust.test.ts` — **23 pass,0 fail,42 assertions**,2.22s. This confirms a small protected-contract baseline, not exhaustive project health. Temporary probes above complete successfully and clean fixture directories. No rig/fleet measurement executed.

Recommended implementation order: fix tracked-index freshness defect; batch deletion O(KN); reuse correct matcher/lazy dircache; transactional cache row updates; locally satisfy sibling-worktree bytes; then measure remaining codec and protocol critical path before larger architecture changes. Any meaningful claimed sync gain needs fixed-corpus p50/p95 end-to-end create/change/delete/rename/checkout workloads with old/new binaries, crash injection, dropped events, slow/offline peers, current/old formats, and multiple worktrees sharing one repository.
