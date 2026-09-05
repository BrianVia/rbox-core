# Git sync and worktree audit — read-only, 2026-09-04

Scope: current checkout `/Users/via/.codex/worktrees/a53f/rbox-core`, primarily `src/cli/sync-git`, `src/engine/git-{discover,spawn}.ts`. Read and applied simplify-codebase-primitives skill. No repository changes or fleet/prod actions. References below are repository-relative, one-based lines. Historical design docs establish intent, not a claim about current production performance.

## Verdict

The Git engine has substantial real safety engineering: scoped worktree refs, current sibling ownership checks, pre-decrypted artifacts, no-follow file reads, journal binding/recovery, expected-old ref transactions, quarantines/recovery pins, semantic index projection, and differential reachability tests. Keep those. The largest structural mistake to revisit is identifying a shared Git object/ref store with a checkout: in-tree worktrees avoid duplicate history by suppressing their independent Git section, while out-of-tree worktrees are captured and recreated standalone. Deduplicate the common object store while preserving each checkout's HEAD/index/operation state/topology.

Confirmed defects are chiefly portable-index closure and path parsing. An immediate performance opportunity is reusing the existing batched reachability primitive inside the still-sequential no-drop proof path; a synthetic microbenchmark demonstrated a 15.6x faster ancestry common case, not a guaranteed end-to-end gain or an already validated drop-in replacement.

## Protected functionality ledger

- Plain file sync independent from Git metadata; no remote absence may erase surviving local `.git` implicitly.
- Full (`dir`) versus scoped (`pointer`) ref semantics; shared stash/tags must not fan into each worktree.
- Dirty/staged, detached, in-progress merge/rebase, pseudo-ref object roots; branch/reflog preservation.
- Sibling checked-out branch ownership, concurrent Git locks, expected-old mutations, fail-closed unreadable evidence.
- E2EE transport, artifact SHA verification, decrypt-before-mutate, fresh-target rollback, quarantine and crash recovery.
- Cache correctness (racy-clean margins, identity versus raw serialization), bounded concurrency, incremental bundles and chain compaction.
- Existing version/format refusal, deliberate unsupported bare/alternates/superproject shapes, active migrations, rollout switches.
- No retirement/deletion approved. Challenge product constraints explicitly; do not infer deletion from static reachability.

## Confirmed findings

### P1: split indexes are captured but not portable

`capture.ts:279-283` copies the live index then only clears resolve-undo. The resulting split index still refers to `sharedindex.<oid>`. `capture.ts:383-405` transports only this index, and the section has no shared-index artifact. `git-state-apply.ts:710-713` installs the index then runs clear-resolve-undo, which fails without the sender's shared index. Fresh apply rolls back, so the observed result is inability to sync Git state, not demonstrated receiver corruption.

Reproduced with actual `git update-index --split-index`, actual encrypted capture, decrypting the serialized artifact, separate ordinary repo and fresh receiver. Preflight passes; capture succeeds; decrypted index is 205 B with the `link` extension; `ls-files --stage` in isolated repo fails `sharedindex.<oid>: index file open failed: No such file or directory`. Fresh `applyGitState` returns `applied:false`, same failure, and removes its newly created `.git`.

Fix: one private-index snapshot owner creates a self-contained wire index via Git's own `update-index --no-split-index` on a private copy while its dependency is readable; preserve flags, sparse semantics, index versions and staging. Keep local split index untouched. Verify no `link` dependency escapes the snapshot. Normalize on capture, not after receiver has mutated.

### P1: ordinary unmerged-index capture can omit stage-only objects

`capture.ts:311-315` swallows `stash create` failure (normal on unmerged indexes). Explicit staged object enumeration/pinning at `capture.ts:320-323` is gated on `opts.resolution`. Normal captures pin pseudo refs/AUTO_MERGE, but those need not reach stage-only objects. `stagedIndexObjectOids` exists at `capture.ts:132-143` and could support the missing invariant.

Reproducer uses Git plumbing to create a legal stage 1/2 entry for an object written by `hash-object -w --stdin` and reachable only through the index. Ordinary capture succeeds. Fresh apply fails post-apply fsck and rolls back (`git-state-apply.ts:717-729`). This is an unusual but legal repository state, relevant to partial conflict resolution, custom merge workflows, IDE/plumbing users; no claim that every merge reproduces it.

Fix: define object closure from the exact captured index on every capture. Pin the write-tree object for merged indexes; enumerate unmerged stage objects for raw indexes, in batches. Do not depend on stash success as the only way to preserve staging. Validate closure before publication, using an isolated/quarantine object store to avoid accidentally satisfying missing dependencies from sender's live objects.

### P2: worktree porcelain parser is not safe for newline paths

`git-state.ts:196-215` splits `git worktree list --porcelain` output on newline; `git-state.ts:221` does not request `-z`. `git-state-apply.ts:114-120` realpaths the resulting truncated path to decide self versus sibling ownership.

Real worktree path `work\ntree`: Git emits the literal newline. Parser returns path ending `/work`; ownership map from inside that same checkout contains both main and its own `refs/heads/topic` branch. This creates false sibling ownership/holds and wrong labels. Normal spaces are not the same issue.

Fix: NUL-framed `worktree list --porcelain -z`, structurally strict parser, roundtrip tests for newline/tab/quote/backslash/Unicode and realpath aliases. Parsing malformed authoritative output should return unreadable rather than a partial ownership map. Capability gate if ancient Git support needs it.

### P2: SHA-256 Git repositories pass preflight then fail after expensive capture

`preflight.ts:43-110` refuses reftable and shallow shapes but does not check object format. `git-state.ts:17-18` and manifest protocol use 40-hex OIDs throughout. Real `git init --object-format=sha256`: preflight `{ok:true,kind:'dir'}`, capture fails `capture failed self-validation: bad ref sha refs/heads/main` after bundle/encryption work.

Immediate fix: authoritative early object-format check and actionable structural refusal. Larger feature: explicit protocol object format and typed variable-width OIDs, fresh init with correct format, compatibility reader gates. Do not simply replace every `{40}` with `{40,64}`: bundle/hash-algorithm compatibility and old receivers matter.

### P2: inherited alternate object directories survive Git environment cleanup

`engine/git-spawn.ts:19-34` clears GIT_DIR/GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR/GIT_WORK_TREE/GIT_INDEX_FILE but retains `GIT_ALTERNATE_OBJECT_DIRECTORIES`. `preflight.ts:99-107` checks on-disk alternates only. Real probe: write a unique blob in foreign repo, set this environment variable to foreign `.git/objects`, invoke rbox `git(root,['cat-file','-p',foreignOid])`; it successfully reads `foreign object` from outside the repo.

Risk: wrapper/hook-inherited object sources change the object universe used by validation/capture despite the stated cleanup contract. No malicious environment or end-to-end exploit is assumed. Fix an explicit repository-routing environment policy, clearing inherited alternate-object lookup and reviewing namespace/config/shallow/replace routing as separate characterized cases. Do NOT claim GIT_CONFIG_COUNT override was reproduced: observed `rev-parse --is-bare-repository` stayed false.

## Product/worktree gaps to prioritize

### Preserve checkout state independently of shared history

`plan.ts:326-357` skips linked pointers whenever an in-tree main repo is sectioned (subject to force/pending/resolution exceptions). `plan-accumulator.ts:202-214` then carries an old base or omits a new pointer section. The main capture intentionally uses `--single-worktree --all` (`capture.ts:232-244,328-338`), excluding detached sibling HEADs and capturing only the main index/op-state. Therefore independent worktree HEAD/index/rebase state is not represented merely because branches travel in the main history bundle. Existing tests explicitly prove detached sibling commits do not ride the main bundle (`git-nested.test.ts`, design 68 V9).

This is deliberate current policy, not a new regression. It cannot satisfy seamless topology/state continuity. Proposed model: RepositoryStore (common object database, refs, common config) plus Checkout (workspace-relative identity, common-store link, HEAD, private index, operation state). Capture each store once and each checkout cheaply. On receiver use native `git worktree add --no-checkout`/worktree metadata management to reconstruct links where safe; never copy sender absolute gitfiles. Preserve standalone fallback for out-of-tree parents and old manifests. Relocation/reconnect is a topology transaction; never silently attach to a coincidentally named foreign clone.

Additional feature axes, needing explicit support decisions: bare common stores and separated git-dir primary clones, worktree-specific config/sparse checkout patterns, submodule superproject/gitlink closure, shallow/partial clones, reftable, SHA-256, linked-worktree moves/prunes/locks, git LFS object availability. Distinguish local capability from wire portability. Worktree-specific sparse configuration may need separate capture from the raw index; do not assume copied CE_SKIP_WORKTREE bits reproduce future Git behavior.

### Partial clones and Git subprocess cancellation

`preflight.ts:76-80` comment says shallow or promisor/partial, but code only checks shallow. That is not by itself a bug: design 147 documents successful online hydration of partial clones. `reachability.ts:53-54` sets `GIT_NO_LAZY_FETCH=1` and `GIT_NO_REPLACE_OBJECTS=1` for proof paths, whereas capture bundle/stash paths allow native lazy fetch. `GitRunOptions` (`git-spawn.ts:39-48`) has no deadline/AbortSignal, and spawn/exec lanes do not impose a timeout. Slow/offline filters, credential helpers, lazy hydration, or other hung Git subprocesses can occupy capture slots indefinitely.

Recommend explicit capture transport policy and cancellation: pure local proof operations never network; allowed hydration has bounded per-repo deadlines and user-visible state. Preserve large legitimate bundles via cancellable progress/inactivity limits rather than a tiny global timeout. Killing an operation must preserve scratch pin lifetime until child exit/reap and clean up journal state safely.

### Known content-equivalence false positive is a product decision

`reachability.test.ts:352-367` deliberately expects squash-then-revert to return `proven/content-equivalent`. `reachability.ts:349-389` looks for a matching patch in durable history, not necessarily in the final tree. Existing recovery pin logic may preserve recoverability; do not label this proven data loss. Challenge the name/UX contract: history contains work versus current branch still contains work versus safe to abandon checkout. Consider immutable recovery pins + clear user evidence, final-content validation where meaningful, or narrower automatable policy. Do not quietly change semantics during a performance refactor.

## Measured performance and high-value changes

### 15.6x synthetic ancestry common case using existing primitive

Real temp repo: 30 consecutive commits, 29 distinct protected tips, final tip as durable root, shallow:false context.

- `noDropProof`: 60 Git subprocesses, 1141.10 ms, `{status:'proven'}`.
- `partitionOwnedByIncoming`: 3 subprocesses, 73.23 ms, all 29 owned.

`reachability.ts:265-303` still calls serial `peelAndVerify` and nested `merge-base --is-ancestor`; `partitionOwnedByIncoming` at `188-263` already batch-checks objects, validates graph, streams the root graph. `ref-plane-observation.ts:207-229` invokes noDropProof per candidate within a fixed-point loop, multiplying root peeling/walk work.

Implement a shared observation for one common store/decision, batch all candidates against one durable-root set, reuse immutable peeled OIDs and content-equivalence evidence, rerun only affected proofs if holds change. Preserve exact marker ordering, per-tip missing object independence, shallow failures, corruption, annotations, empty inputs, replacement suppression, content-equivalence fallbacks and recovery pin decisions. The benchmark isolates existing APIs on an easy common case; it is not proof they are already interchangeable. Report p50/p95 on real workloads before claiming overall 10x.

### Private index projection costs five process launches/traversals

`index-identity.ts:63-67` runs five sequential ls-files views, then sorts and materializes multiple full strings (`73-78`). One tracked file measured 95.5 ms/5 spawns. Do not simply parallelize: the comment correctly describes shared private-index lock races. Combine compatible Git output views, cache one projection for the exact index/dependency token through a decision, stream/hash bounded records, or use a narrowly scoped mature Git library after differential coverage. A native parser is a later option, not the first choice. Large repos hit maxBuffer=16MiB in the runner, causing conservative deferral rather than a successful identity.

### Batch pin mutations and checks

`pins.ts:63-84` creates/deletes each scratch ref with separate update-ref subprocesses; `pins.ts:115-138` verifies pseudo-ref objects individually. `capture.ts:132-143` verifies every stage-entry object individually, even before deduplicating repeated OIDs. Batch object checking and a single update-ref transaction per pin set can reduce O(N) process/lock events to O(1). Keep per-capture unique namespaces, expected-old cleanup, watch suppression boundary and crash retention semantics. This becomes especially important when fixing arbitrary raw-index object closure.

### Deduplicate Git packs by store, not checkout

Incremental bundles already exist (`shared.ts:188-200`), MAX_PACK_CHAIN=8 (`manifest-validate.ts:25`), and byte-based compaction avoids unbounded chain growth. Do not recommend implementing incrementals from scratch. Improvements: common-store pack stream reused across checkouts, resumable validated receiver possession catalog, checkpoint compaction off critical interaction path, and stable object-group chunking for better dedup when repacking changes bundle bytes. Git commit-graph/MIDX/bitmaps may improve real graph/pack workloads but require measurements and maintenance scheduling; do not prescribe aggressive gc in active user repos.

### Discovery and repository topology observation

`engine/git-discover.ts:46-66` recursively reads directories serially. Full scan already has discovery-collector coverage and observer fast paths elsewhere; preserve them. Persist topology index keyed by canonical common store and worktree identity, update from watcher events, bounded full reconciliation after overflow/reconnect. Coalesce repeated common-dir/preflight/worktree enumeration across sibling checkouts, with mutation-boundary refresh for safety.

## Proposed ownership map

1. GitRepositoryStore owns object closure, immutable object observations, ref graph and native batch plumbing. Never owns UI/fleet/network policy. Interface: observe graph for a set of roots, stage/import verified objects, transact refs with exact expected-old evidence.
2. GitCheckoutSnapshot owns self-contained index + HEAD + operation snapshot, object roots and stable semantic identity. Never owns common-store ref policy or publication. Interface: capture/check snapshot, compare, materialize/recover checkout under existing transaction owner.
3. RepositoryTopology owns stable store/checkout relationships, safe discovery/relocation and sibling ownership observations. Never owns arbitrary branch mutation or invents identity from URLs/path names alone.
4. Existing checkout/ref transaction owner remains sole physical-effect/recovery owner; existing state CAS owner remains logical checkpoint authority. Keep their boundary explicit and avoid a new parallel journal authority.

Absorb repeated reads/orchestration behind these complete operations; do not just split large files. No move-only refactor recommendation.

## Ranked cycles and validation

1. Portable private-index closure + ordinary unmerged-stage objects + newline parser + object-format preflight. Add small real Git roundtrip tests, cold separate receiver, exact staging/flags/sparse semantics. Confirm rollback remains unchanged.
2. Batch noDrop proof through current graph owner; old/new differential fixture matrix, fail-injected graph reads and per-ref order, count subprocesses and wall time on 30/500/5000 refs and long histories. Measure before/after on compiled rig, not only microbench.
3. Capture index/probe/pin batching; raw index size 1/100k/1M entries; split/sparse/resolve-undo/ITA/assume-unchanged/staged conflict states; process count and memory/latency budgets.
4. Versioned store/checkout topology model; standalone↔linked↔relocated↔external-parent and old/new client matrix; 100 siblings, detached branches, deleted/locked/prunable worktrees, active sibling commits. Crash inject every topology/native metadata change and publication boundary.
5. Transport/capability expansion only after explicit requirement decisions (SHA-256, partial/shallow, reftable, submodules, bare stores). Preserve current supported behavior and fast paths during migration.

Safe deletion ledger: no implementation proven dead in this audit. Existing legacy proof oracle has production fallback callers; not dead despite its name. Old wire readers, journal versions, rollback, migration artifacts, and safety fallbacks have no deletion approval.

## Evidence / reproducibility

Scripts are absolute-import, temp-directory-only Bun scripts:
- `/private/tmp/rbox-git-probes.ts`: newline worktree/self-ownership, split preflight/capture, SHA-256 refusal.
- `/private/tmp/rbox-git-probes2.ts`: split fresh receiver failure, index identity cost.
- `/private/tmp/rbox-git-probes3.ts`: decrypt serialized split index and test in separate repo, unmerged stage-only closure failure, inherited alternate-directory effect. Contains a config override experiment that did NOT reproduce and is not claimed.
- `/private/tmp/rbox-git-perf-probe.ts`: 29 unique tip sequential/batched ancestry measurements.
- `/private/tmp/rbox-git-baseline-probe.ts`: explains existing-target test failure via missing compatible lock runtime.

Execute e.g. `bun /private/tmp/rbox-git-probes3.ts`. Runtime here Bun 1.3.14 / Apple Git 2.50.1; package asks Bun ^1.4.0. Timings are one-shot developer-machine measurements, not fleet benchmarks.

Focused existing tests:
`bun test src/cli/sync-git/git-state.test.ts src/cli/sync-git/git-nested.test.ts src/cli/sync-git/capture-stability.test.ts src/cli/sync-git/reachability.test.ts`
Result 79 pass / 7 fail / 1 unhandled error, 86 tests, 54.57 sec. Log `/private/tmp/rbox-git-tests.log`.
- Five existing-target apply failures are reproducible as `protocol lock unavailable ... compatible lock identity unavailable` in this environment; not claimed as five new sync bugs.
- Strict worktree-list test compares /var temp spelling with Git's canonical /private/var path, causing expectation failure.
- One setup timed out through Apple xcodebuild confstr/cache/FSEvents failures; dangling process was killed by test harness.
- Batched reachability oracle, 500-candidate constant subprocess test, core worktree capture/pseudo-ref tests passed.
No rig/fleet run was performed; do not claim production validation.
