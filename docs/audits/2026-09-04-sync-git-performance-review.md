# Sync and Git state review — 2026-09-04

Examined checkout: `3c78a055a`. This is an audit and proposal, not an implementation or production measurement. Runtime available here: Bun 1.3.14, Apple Git 2.50.1, macOS ARM64; package.json requires Bun ^1.4.0. Three independent review lanes covered Git, file pipeline, and state/server behavior. The primary reviewer inspected their evidence and independently reproduced the split-index, unmerged-index, alternate-object environment, and server alarm failure experiments.

**Verdict:** There are credible 10× opportunities, and several correctness gaps worth fixing first. The strongest theme is to make the cost proportional to changed paths, changed objects, and changed refs. rbox already has sophisticated safety machinery and several successful incremental optimizations; a rewrite would throw away much of its value. The larger architecture opportunity is to model a shared Git repository and its individual checkouts separately, rather than choose between duplicate history capture and skipped checkout state.

**Priority order:** fix Git artifact completeness and cache correctness; eliminate deletion-batch amplification and repeated Git ancestry subprocesses; repair server post-commit liveness; remove remaining full-workspace cache/matcher work; then tackle shared worktree state and the commit wire protocol. Chunked large files and peer transfer are separate, workload-dependent bets.

## Evidence and the current baseline

The August 18 audit's 41–51 second propagation number is not a fresh baseline. Subsequent checked-in field reports describe state memoization, connectivity-defer skipping, and delta-scoped CAS locks shipping. `docs/STATUS.md:85` reports FM steady pull dropping to 8.2 seconds, with desktop push 1.5–1.9 seconds and Mac pull 2.0 seconds. These are historical field observations, not measurements of today's machines.

Already present, and worth preserving:

- Hash and directory caches; watcher-driven observation; trusted pull views with rescan refusal paths.
- Manifest delta envelopes, trusted-base folding, bounded chains, streaming canonical hashing.
- SQLite state plane, delta saves, state read memoization, packet-level CAS, producer-scoped Git CAS locks.
- Incremental Git bundles, common-directory fingerprint memoization, lazy probes, held-repository skip logic.
- Batch blob transport, default-on small-blob packing, adaptive transport mechanisms, fused crypto paths.
- File precondition checks, conflict retention/trash, Git quarantine, journals, recovery pins, and signature/rollback verification.

Do not pitch these as missing features. In particular, the opt-in publish pipeline has an earlier measured regression, and packing has a history of both regressions and subsequent implementation changes. More concurrency is not an evidence-backed universal improvement.

### Measurements from this review

| Experiment | Current result | Comparison | Interpretation |
|---|---:|---:|---|
| 124k manifest, 1,000 absent file-delete events | 1,172–1,244 ms | 15.7–16.9 ms | 70–77× faster **specific deletion path** in a prototype retaining the same lstat checks; not a complete replacement |
| 29 protected ancestor tips, one durable tip | 60 Git processes / 1,141 ms | existing batch primitive: 3 / 73 ms | 15.6× faster **ancestry common case**; full proof semantics still need differential validation |
| One changed cache entry, 124k encrypted-address entries | load median 319.7 ms; save 83.5 ms | writes about 22.8 MB | Clear O(N) persistence for O(1) change |
| Warm matcher construction, 100 repos / 1,100 dirs | median about 1.89 s | ignore-only construction about 0.28 ms | Repeated synchronous repository discovery dominates this synthetic case |
| State save, 119k entries | full save 1,738 ms | delta save 45.3 ms; compose 18.2 ms | Large optimization **already shipped**; keep callers on it |
| 124k-entry manifest, one content edit | refset 4,960,018 B | delta envelope 696 B | Content metadata delta is tiny; accounting carrier still scales with workspace |
| Same codec fixture | encode median 584.3 ms; fold 439.3 ms | 1k entries: 4.2 / 3.3 ms | Small change still incurs linear CPU |
| 250k disjoint refset fold, 5k chunks | 6,625,000 iterator visits | 250,000 unique refs | 26.5× traversal amplification, not a demonstrated 26.5× wall-clock win |

Codec measurements use one warmup and three measured runs, uncompressed envelopes, synthetic distinct encrypted addresses, and medians. At 124k entries canonical hash alone was 342.7 ms, refset serialization 141.9 ms, parsing 182.7 ms. These timings overlap conceptually with the encode/fold totals; **do not add them all together**. Refset size follows the exact format `18 + 40*N`; a real workspace with duplicate contents has fewer unique refs than files.

## Correctness and compatibility fixes

### 1. Make every transmitted Git index self-contained

**Confirmed defect.** Capture can accept a split index and upload its raw bytes, retaining its `link` extension but omitting `sharedindex.<sha>`. The receiver has no such dependency. Our captured artifact was 205 bytes; copying it into an independent repo made `git ls-files --stage` fail with “index file open failed.” Fresh apply also refuses and rolls back. This is an inability to sync supported-looking staging, not observed silent data loss.

Evidence: `src/cli/sync-git/capture.ts` index snapshot/upload; `index-identity.ts:49` deliberately locates the private probe beside the original so split-index lookup works locally; `fingerprint.ts:143` fingerprints the shared dependency. The latter two demonstrate awareness of split indexes but do not transport their dependency.

**Fix:** normalize a private index copy with Git's own `update-index --no-split-index` before upload. Never rewrite the user's live index. Bind the normalized bytes and their semantic identity to the same capture attempt. Verify stages, executable modes, intent-to-add, skip-worktree, assume-unchanged, resolve-undo, and sparse behavior survive; do not assume a clean-tree hash proves staging equivalence.

**Acceptance:** source with split index and staged edits → independent receiver without access to source object/index directories → identical semantic staging. Repeat during index replacement and capture crash.

### 2. Include all objects reachable only through an unmerged index

**Confirmed defect.** A legal unmerged index can contain stage-only blobs that no branch reaches. Ordinary capture can publish an artifact whose bundle lacks those blobs; receiver post-apply fsck then fails and rolls back. The experiment constructed conflict stages with `git update-index --index-info` and a locally written blob; capture succeeded, application returned `post-apply fsck failed — rolled back`.

Evidence: `capture.ts:128` already has `stagedIndexObjectOids`, but pinning through it is specific to resolution capture. Ordinary capture depends on mechanisms that cannot create a normal tree from unresolved stages.

**Fix:** make complete index object closure part of *every* capture's bundle-root calculation. Reuse the existing enumeration/pinning primitive. Batch object checks instead of one process per entry. Include resolve-undo and operation-state references in the closure review; preserve foreign submodule/gitlink semantics rather than demanding every gitlink object exist locally.

**Acceptance:** merge/rebase/cherry-pick conflicts with stage-only blobs; staged resolutions; sparse directory entries; annotated tags; detached HEAD; source GC after capture; receiver fsck and staging equivalence.

### 3. Strengthen the tracked-files ignore cache

**Confirmed defect.** `src/engine/ignore.ts:756` and `:786` trust index path, mtime, and size. A same-size replacement preserving mtime can return yesterday's tracked set. Our fixture swapped force-tracked `a.secret` for `b.secret`, restored the index mtime, and rebuilt the matcher. Git reported `b.secret`; rbox still considered `a.secret` tracked and `b.secret` ignored.

**Fix:** use identity and change evidence at least as strong as the existing hash/fingerprint caches: device/inode, ctime, size, mtime, a stable before/after observation, and a racy-timestamp fallback. Account for split-index dependencies. Invalid/unreadable evidence must not authorize exclusions or deletions. Merely persisting the matcher longer would make this bug worse.

**Acceptance:** same-size/same-mtime atomic index replacement, split-index mutation, force-add/remove of ignored paths, watcher loss, and index unreadability. Assert manifest membership and deletion behavior, not only cache hits.

### 4. Parse worktree paths without newline or quoting ambiguity

**Confirmed defect.** Worktree-list parsing uses newline-delimited porcelain output. A legal path containing a newline is truncated/quoted differently and can classify the current checkout's branch as owned by a sibling, producing a false hold.

**Fix:** `git worktree list --porcelain -z`, parsed as NUL-framed records, with realpath-aware identity comparison. Audit other Git path outputs separately: `git()` trims stdout, which is fine for OIDs and wrong for some path-valued outputs. Reuse raw-output primitives where byte preservation matters.

**Acceptance:** whitespace, tabs, newlines, Unicode, symlinked workspace roots, `/var` versus `/private/var`, moved worktrees and prunable registrations.

### 5. Make Git feature admission explicit and cheap

**Confirmed mismatch:** SHA-256 repositories pass preflight but the protocol and several parsers require 40-character OIDs; capture later fails self-validation after doing work. Ref-format support already explicitly refuses reftable. Apply the same admission discipline to object format.

**Immediate fix:** detect unsupported object format before bundling; keep ordinary file sync available and show a precise Git limitation. **Larger option:** version the Git section to identify the object algorithm and initialize receivers accordingly. Do not replace a regex and assume the bundle, ref transaction, index, tombstone, and compatibility contracts all follow.

Shallow repositories, alternates, submodule superprojects, bare layouts and reftable have explicit limitations. Partial clones are subtler: earlier designs deliberately support hydrated partial clones, despite a broad preflight comment. Treat missing-object hydration as a fetch/cancellation/product-policy question; do not silently retire already supported cases.

### 6. Finish subprocess environment isolation

**Confirmed observation:** `cleanGitEnv` clears several repository-routing variables, but retains `GIT_ALTERNATE_OBJECT_DIRECTORIES`. A normal rbox Git call could read an object found only in a foreign object database supplied through that inherited variable. This makes observation dependent on how the daemon was launched and bypasses the on-disk alternates check.

**Fix:** centralize a reviewed environment policy for all Git subprocesses, including synchronous Git calls in ignore discovery. Clear inherited repository/object-routing variables unless a particular internal operation deliberately supplies them. Test namespaces, alternates and config overlays; do not indiscriminately erase user settings that are part of intended behavior. We did not establish a config-overlay exploit or an external security vulnerability.

### 7. Decouple accepted commits from alarm/fanout failure

**Reproduced with production WorkspaceSync class and stubbed storage.** `apps/api/src/workspace-sync.ts:758` awaits alarm arming after committing the new head and before WebSocket fanout. Injecting `setAlarm` failure yielded: durable head 1, retained index `lagging`, zero fanout, zero mirror, and a thrown request. Retry returned 409. Reconstructing the object and calling `/latest` succeeded but did not rearm the absent alarm because `initializeIndex` returns immediately for any existing `index_state` (`:284`).

This is an ambiguous-acknowledgment and maintenance-liveness gap. It is not proof of data loss or a Cloudflare platform incident. Later successful activity may heal it; an otherwise idle workspace has no demonstrated rearm on this path.

**Fix:** keep durable head acceptance as the authority; make notification and mirror failures independently recoverable. Persist/recognize pending maintenance through existing index state and rearm on activation/read when needed. Make identical accepted-commit retries return a safe acknowledgment where the hash and parent binding prove identity. Moving the await alone is insufficient if maintenance can still be stranded. Preserve admission/GC fencing before acceptance.

### 8. Bound local state growth

**Confirmed defect in lifecycle ownership.** `entry_values` interns exact values, including mtime, while saves replace their `plane_entries` references. `collectUnreferencedEntryValues` exists (`state-plane/store/plane-promotion.ts:193`) but has no runtime caller in the inspected tree. Fifty mtime-only saves of one path left fifty values and one live row; collection removed forty-nine.

`plane_entries` has no index beginning with `entry_id` (`schema/v1.ts:81`). EXPLAIN for collection shows a correlated full scan and foreign-key scan. Simply enabling the current collector could trade gradual disk growth for a pause.

**Fix:** add the referencing index through a schema migration and bounded, scheduled collection owned by the state plane. Keep retained values referenced by any plane. Measure WAL/checkpoint growth and local DB size under day-long agent churn. Keep collection outside publication's latency-critical transaction.

## The highest-return performance changes

### A. Batch deletion reconciliation instead of scanning the manifest per event

`src/cli/daemon/watcher.ts:380` maps every Parcel delete to `unlinkDir`, since Parcel does not identify the vanished object's type. `src/engine/manifest.ts:341` then scans a fresh array of all manifest keys for each absent path. A thousand deleted ordinary files in a 124k-file workspace means roughly a hundred million prefix checks.

The safe optimization is to retain disk rechecks, then process confirmed absent prefixes together using one ordered range/ancestor pass. Longer term the existing local observation owner should maintain a path index. Do not just map every event to `unlink`: a directory deletion must remove descendants, and a stale deletion event can arrive after a path was recreated.

**Measured prize:** 70–77× in the narrow absent-delete batch. **Gate:** complete old/new equality for manifest entries, deferred paths, cache invalidations and type-flip behavior across overlapping deletes, recreation, permission failures and interleaved writes. This directly targets worktree removal, generated-tree cleanup and agent churn.

### B. Reuse the existing batched ancestry primitive

`sync-git/reachability.ts:265` performs serial peel/verify and nested ancestry calls in `noDropProof`. `partitionOwnedByIncoming` (`:188`) already provides batched graph machinery. `ref-plane-observation.ts:207` invokes proofs repeatedly while computing which refs can move.

Capture one immutable graph observation for a common store and root set, classify the candidate set in batches, and recompute only proof inputs changed by a new hold. The experiment's 60→3 subprocess reduction needs no new Git implementation. Scratch pin creation/deletion and staged object existence checks also use per-object subprocesses and are candidates for Git's native batched plumbing.

**Measured prize:** 15.6× ancestry common case. **Caution:** the APIs are not interchangeable proofs; negative, missing-object, annotation, shallow, graph corruption and content-equivalence branches need differential coverage. Git provides buffered batch object queries; a permanent native daemon/library is a later experiment, not the necessary first step. [Git cat-file documentation](https://git-scm.com/docs/git-cat-file.html).

### C. Make trusted pulls actually reuse trusted observation work

`sync/pull.ts:242` constructs a matcher and loads caches before choosing the trusted local view. Matcher construction synchronously discovers repos and invokes Git, while `daemon/daemon.ts:2878` already owns a cached matcher. The daemon's pull dependency object (`:2175`) passes the hash cache but not its matcher or directory cache.

Thread the correctly versioned observation into pull; keep rule-file application and index/topology invalidation explicit. Load the directory cache only if a scan is necessary. This is plausibly a seconds-level saving on workspaces containing many repos; the local 100-repo fixture spent roughly 1.9 seconds rebuilding the matcher. It is not proof that every pull currently loses 1.9 seconds.

### D. Finish the move from whole JSON caches to indexed updates

SQLite state exists, but encrypted-address and other disposable caches still load, sort, rewrite and fsync full JSON records. `encrypt-address-cache.ts:200` and `sync-recovery.ts:526` show the one-change full rewrite. Use an indexed, key-scoped cache with batched upserts/deletes, retained connection ownership and bounded pruning. Keep disposable cache failures separate from authoritative state failure.

Also repair `entry_values` reclamation described above. A scratch reverse index took its current collector from 873.9 to 11.3 ms on 3,000 obsolete / 3,000 live values—about 77× collector-only. Do not put a full sweep or VACUUM after every sync.

### E. Reuse identical local file contents when creating another worktree

A new sibling checkout contains mostly bytes already present locally, yet `engine/apply.ts:339` ordinarily obtains content through remote blob storage. Use the observed plaintext hash to find a local candidate, copy/reflink it to the normal staging temp, verify it, and finish through the existing expected-local guard and atomic replacement.

**Do not hardlink mutable working-tree files.** A write in one checkout must never modify its sibling. A source that changes during copy is a failed candidate, with ordinary remote transfer as fallback.

This can cut network bytes by over 10× when more than 90% of the required content is available locally. It does not imply a 10× checkout wall-time gain; filesystem materialization and Git work still remain. Measure one repository with 1/10/100 checkouts, with cold and warm caches.

### F. Remove server maintenance traversal amplification and unbounded responses

Keep one live refset iterator across the 5k transaction chunks in `workspace-sync.ts:834`, rather than restarting iteration and skipping the already processed prefix in `diffChunk` (`:1480`). Persist the same recovery cursor; on restart seek once. Compare roots, dropped refs and cursor state after every injected crash.

Separately, `commits?since` builds one parsed array and JSON response (`:1280`) bounded by 5,000 commits but not aggregate bytes. With near-1MiB accepted bodies the theoretical response budget is gigabytes. This is a static upper-bound concern, not a reproduced OOM. Add byte-capped pages or a bounded stream while preserving verification continuity and rollback pins.

## What seamless worktrees would require

**The main product gap:** an in-tree worktree may skip capture when its main clone is already sectioned (`sync-git/plan.ts:326`). `plan-accumulator.ts:202` carries its previous section or omits it. The main bundle deliberately uses `--single-worktree --all`; it does not preserve an independent sibling index, operation state, or detached-only HEAD merely by carrying shared branches.

That policy avoids redundant history but does not represent every checkout's state. It is an existing deliberate tradeoff, not a newly introduced regression. It matters directly to “continue this agent's work on the other machine.” Out-of-tree pointers have a different path and can become standalone receivers; syncing files does not mean recreating the original linked topology.

Git itself distinguishes shared refs/objects from per-worktree HEAD/index and other state. The redesign should follow that native split. [Git worktree documentation](https://git-scm.com/docs/git-worktree.html).

| Representation | Owns | Does not own |
|---|---|---|
| Repository store | object closure, shared refs, safe common config, bundle/checkpoint stream | a particular checkout's staging or filesystem location |
| Checkout | portable store association, HEAD, semantic/private index, operation state, workspace-relative path | another checkout's HEAD/index or an independent copy of shared history |
| Local topology mapping | canonical common-dir identity, actual local paths, sibling ownership, relocation | remote absolute paths or identity inferred solely from remote URL |

**Concrete behavior to implement:**

1. Capture shared history once, plus small independent snapshots for every checkout.
2. Recreate linked worktrees through native Git operations when a verified local store association is available; preserve a standalone materialization path for old formats and external parents.
3. Represent detached HEADs explicitly and include their object closure even without a branch.
4. Treat worktree moves/removals/reconnections as topology operations with identity checks. An absent directory, unreadable pointer, prunable registration and intentional deletion are different observations.
5. Keep checked-out branch ownership current at mutation time. Parallelize stores; serialize conflicting effects within one common store.
6. Add real support decisions for bare stores, separate git-dir layouts, sparse checkout/config.worktree, submodules, SHA-256 and reftable. Never infer support from `.git` being a file alone.
7. Make the receive policy for independently edited checkout state explicit: conflicts preserve both versions; two devices should not silently overwrite each other's active index/rebase state.

**Benchmarks:** one object store with 100 sibling worktrees; one sibling commit; 100 detached siblings; create/remove/move bursts; parent outside sync root; missing/pruned parent; simultaneous commits in different siblings; lock contention on the same branch; clone on a different absolute root; local bytes reused versus cold network. Require history upload and shared graph probes to scale with stores/changed objects, not the number of sibling checkouts.

## The larger wire-protocol opportunity

Manifest deltas are already implemented, but accounting still sends full membership. In the measured fixture a one-file edit encoded to 696 bytes while its refset was 4.96 MB. `e2ee-remote.ts:775` still serializes/uploads the whole refset; the server reads parent and child sets and later folds roots. Delta admission enforcement reduces D1 work, not these bytes.

**Implement in independent slices:**

- Parent-bound signed refset deltas plus authenticated full checkpoints. Maintain server roots incrementally, keeping quota, entitlement, GC deletion fences, chain retention and rollback protection. This is a wire/storage evolution, not “stop validating blobs.”
- Let bounded receipt sets and the encrypted manifest envelope ride the commit request. Current `remote/commits.ts:328` redeems receipts separately and then sends an empty receipt object.
- Put the already available signed commit, and optionally its small encrypted envelope, into bounded WebSocket frames. Receivers verify signatures, ancestry and pins before using it. Old clients, missing frames and mismatches retain the authenticated pull path.
- Overlap independent account-key refresh with upload while maintaining the epoch check at signing.
- Remove nonauthoritative D1 mirror latency from the sender acknowledgment only once eventual mirror recovery has a clear owner.
- Prefetch immutable ciphertext while the receive mutation lane is busy. During sender debounce, optionally prepare/upload stable candidate bytes under a strict byte budget. Preparation never grants permission to commit stale content.

The small-change target becomes a blob-upload lane plus one commit round trip, then verified delivery and change-proportional apply. It is a plausible route to much lower end-to-end latency, but an overall 10× claim needs a new fleet baseline. Existing 45-second cursor checks and 300-second backstops can dominate the tail after a missed notification; preserve catch-up and improve gap detection rather than trusting delivery.

**Subsequent option:** a versioned Merkle/radix manifest representation so a changed path updates O(log N) authenticated nodes rather than hashing a full canonical manifest. First remove avoidable repeated validation/diff/materialization behind an identity-bound boundary; never skip validation of untrusted data. A Merkle representation brings node fanout, compaction, retained roots and compatibility costs and should earn its place against measured CPU after simpler fixes.

## Ambitious experiments worth considering

| Idea | Why it might win | What could make it lose / decisive test |
|---|---|---|
| Content-defined chunks for large mutable files | A small edit need only transfer changed chunks, potentially 100×+ fewer bytes | More object refs, crypto operations and GC; test insertion/overwrite/random rewrite, byte identity, memory and old-reader refusal |
| Parallel multipart parts | Large single files currently upload parts serially (`remote/multipart.ts:117`) | Bandwidth/CPU saturation and memory; use global byte/FD limits and resumable per-part retries, not unbounded fanout |
| Shared Git object delivery across workspaces | Multiple checkouts/clones may have nearly identical history | Never dedup across unrelated encryption/authorization scopes; measure bundle repack churn before inventing a new store |
| Git object knowledge / missing-object negotiation | Avoid repeatedly sending history a receiver demonstrably has | Possession evidence can become stale after GC; retain full verified repair checkpoint and corruption handling |
| Local peer transfer between owned devices | Large transfers can avoid the WAN bottleneck | Authentication, peer discovery and hostile LANs; transfer ciphertext, verify hashes, retain cloud commit authority and fallback |
| Hydrate files from local Git objects | Much of a clean checkout may already exist in its object database | Filters/LFS/smudge and working bytes differ from stored blobs; only reuse after matching expected plaintext identity |
| Verified streaming staging | Fewer ciphertext/plaintext temp passes and rereads | Must authenticate before displacing user content; test truncated streams, tag/hash failures, source edits and crash cleanup |
| Background checkpoint compaction | Keep history/pack chains shallow without delaying interactive edits | Compaction races and extra bandwidth; publish immutable artifacts and preserve old roots until references retire |
| Portable work sessions | Capture “checkout + staging + operation state” as a first-class unit for agent handoff | Requires the topology model, object closure and explicit concurrent-edit policy above; avoid shipping machine-specific hooks/config |
| Signed history checkpoints / authenticated skip links | Long-offline clients need less verification work | A server-created checkpoint is not automatically trusted; prove anti-rollback/fork properties and key-revocation semantics |
| Native Git plumbing service or library | Amortize launch/parsing overhead after batching | Compatibility burden and another long-lived process; first establish that native batched Git commands remain dominant |
| Per-account server sharding | Higher aggregate throughput if shared D1 becomes limiting | Migration, directory/account split and GC coordination; not a single-user 10× latency claim; require contention telemetry first |

Do not enable the existing optional pipeline merely because overlap sounds faster. Checked-in historical evidence records 315 seconds serialized versus 540 seconds pipelined. Historical packing experiments also reduced requests while increasing elapsed time. These findings argue for isolated, reversible A/B experiments, not against all future pipeline or pack improvements.

## Ownership, protected behavior, and requirement decisions

The measured source map, excluding test/fixture files by filename: engine 72 TypeScript files / 17,101 lines; sync-git 85 / 25,444; sync spine 11 / 3,043; state-plane 75 / 11,890; daemon 30 / 11,907; remote adapters 20 / 4,105; API source 75 / 17,873. These are directory counts, not a claim that each file is a Module. There are 131 distinct RBOX_* symbols across non-test source, including paths/constants as well as configuration—**not 131 feature flags**.

Large files are investigation signals: daemon 3,173 lines, lockfile 1,623, Git apply 1,359, Git plan 1,256. Splitting them without reducing authorities would not address the problem.

| Owner / Interface direction | Absorbs / improves | Protected boundary |
|---|---|---|
| LocalWorkspaceObserver: observe changes, provide trusted view | path index, matcher freshness, directory state, changed-path knowledge | Never publishes or mutates Git; untrusted watcher requires truth scan |
| Git store + checkout snapshot: capture complete state, classify graph | shared graph probes, portable index, object closure, topology relationship | Never substitutes cached evidence for final expected-old mutation checks |
| Existing Git effect/recovery owner: apply/recover | native ref/index/worktree transaction details | Physical recovery remains distinct from SQLite logical checkpoint |
| StateStore: save/CAS, bounded maintenance | indexed cache updates where appropriate, orphan collection | One lineage/nonce/generation authority; no parallel journal invented |
| Verified staging: obtain and validate bytes | local reuse, network fetch, decrypt/hash/temp lifecycle | Existing apply owner controls preconditions, conflicts and replacement |
| WorkspaceSync: accept, deliver, maintain retained roots | coalesced transport and incremental root maintenance | One sequence authority; server remains unable to read encrypted content |

**Protected-functionality ledger:** E2EE/key scoping; signature and anti-rollback verification; supported manifests/journal versions and migrations; full versus scoped ref semantics; local staging and unmerged states; concurrent local edit preservation; expected-old transactions; branch ownership; recovery pins/quarantine/trash; missing versus unreadable distinction; mass-deletion guard; watcher distrust/rescan; byte/hash/tag validation; quota/entitlement/GC fencing; bounded memory, descriptors and staging disk; current successful fast paths.

**Requirement challenges needing product decisions:**

| Current requirement / tradeoff | Complexity cost | Recommendation / decision |
|---|---|---|
| In-tree pointer capture omitted when main is captured | Loses independent checkout-state representation | Replace with shared-store + per-checkout state; approve new wire/topology semantics |
| Raw index as portable artifact | Host-local dependencies and volatile serialization | Normalize private capture through Git; retain semantic staging contract |
| Full refset every commit | O(N) bytes/CPU regardless of edit size | Parent-bound deltas/checkpoints with compatibility and GC proof |
| Whole-file address for large files | Tiny edits retransmit large content | Threshold-based chunk experiment, based on actual workload |
| Local mtime carried in canonical portable metadata | Local hint creates exact-value/hash churn | Separate local observation hint from portable identity only through explicit format/behavior review |
| “Patch occurred in history” as content equivalence | Can classify squash-then-revert as content-equivalent | Existing test explicitly expects it; review abandonment/UX policy separately, preserve recoverability |
| Supported degraded lock/runtime paths | Extra modes and refusal behavior | Characterize support; do not remove by assumption or disable safety to run tests |
| Numerous rollout switches / old journal readers | Branching and test surface | Retire only after owner, deployed-reader floor, rollback window and usage evidence |

**Deletion ledger:** no production implementation has been proven safe to delete here. The uncalled collector needs ownership and integration, not automatic deletion. Duplicate orchestration can be absorbed only after routing all callers through the owner and differential testing. No commands, protocols, migration/readiness paths, recovery logic or performance backstops are approved for retirement by this audit.

## Delivery sequence and acceptance gates

1. **Correctness cycle:** portable split index; raw/unmerged object closure; robust tracked-index cache identity; NUL worktree parser; early object-format refusal; environment isolation. Real independent Git receivers, exact staging semantics, source mutation races and rollback checks.
2. **Measured local speed cycle:** deletion batching and batched no-drop proofs. Keep tests for existing negative/error/content-equivalence behavior. Require operation-count budgets and fixed-corpus latency distributions, not only successful common-case timings.
3. **Liveness and maintenance cycle:** alarm recovery, indexed bounded state GC, linear server fold, byte-bounded history. Crash every durable boundary; recover without requiring a second user edit.
4. **Observation/caches cycle:** trusted matcher reuse, lazy directory cache, SQLite row updates, verified local file reuse. Force watcher loss, index replacement, ignore changes, corrupt caches and source edits.
5. **Worktree model cycle:** shared-store/per-checkout schema and native reconstruction. Old/new client compatibility, detached/in-progress checkouts, external/missing parents, branch collisions, path relocation and simultaneous sibling mutations.
6. **Wire cycle:** signed delivery payloads and coalesced commit, then refset deltas/checkpoints. Assert exact requests/bytes for one-file edits; preserve 409/422/quota/key-epoch/revocation/rollback semantics.
7. **Experiments:** chunking, peer transfer, Git object negotiation, manifest trees and native plumbing only against their specific measured ceilings.

For every cycle run the supported Bun runtime, build the compiled CLI, and execute appropriate real rig scenarios (`git-shapes`, `git-entanglement`, `worktree-squash-lifecycle`, `git-held-livelock`, `git-rebuild-settlement`, commit propagation). Record p50/p95/p99 edit-to-applied latency, CPU/event-loop delay, subprocess count, fsync count, wire bytes/requests, peak working memory, queue age, staged disk, DB growth and time spent held. Compare cold/warm, one/many repos, one/many worktrees, local/offline/slow peers and released-old/candidate clients.

Tenfold component gains do not multiply automatically. If an optimized phase is only 10% of total latency, even eliminating it entirely improves overall latency by only about 11%. Publish an end-to-end 10× claim only when the actual critical path measurement supports it.

## Verification performed and limits

- Codec/refset baseline: 31 passed, 0 failed.
- File scan/stability/concurrency/watcher trust baseline: 23 passed, 0 failed.
- State delta/fused-consume baseline: 20 passed, 0 failed.
- Git baseline: 79 passed, 7 failed, 1 unhandled error across 86 tests. Five existing-target failures were traced to unavailable compatible lock identity in this environment; another had `/var` versus `/private/var` expectation mismatch; setup also hit Apple tooling/timeouts. These are not seven newly discovered product defects.
- Broader state memo/elision run: 34 passed, 15 failed, with lock-runtime limitations on failing branches. This overlaps focused suites and is not an additional independent pass count.
- Temporary real Git and filesystem experiments reproduced the concrete findings above. The server alarm experiment uses stub storage, not workerd; collector changes were temporary-DB-only; deletion prototype covers the explicitly described absent-delete subset; ancestry comparison covers the simple owned-ancestor case.
- No production/fleet mutation, deployment, remote issue filing or live rig acceptance was performed. No sync implementation changed. This review cannot certify full project health or a fleet speedup.

Detailed lane notes and reproduction sources are retained in `data/2026-09-04-sync-git/`. They contain absolute imports for this checkout and should be adapted to the checkout location before reuse. Some Git probes retain temporary repositories for inspection. The report is the recommendation; those probes are diagnostic artifacts, not proposed production implementations.
