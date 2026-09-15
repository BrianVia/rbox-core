# Baseline reconciliation for roadmap287 / first fixture slice288

**Read-only source comparison:** approved audit/MDX baseline `3c78a055a` → execution baseline `c4aa22bbb`, in `.claude/worktrees/astra-sync-git`. No product edits or tests executed. Prior audit timings/reproductions remain historical evidence and must not be presented as fresh measurements of this baseline. The approved decisions were imported into this worktree's `docs/plans/sync-git-improvements/plan.mdx`; design281 is already occupied on current main, so the roadmap is287 and first fixture slice288.

## Package disposition

| Package | Landed since audit | Remaining scope / avoid duplicate work |
|---|---|---|
| **F1 tracked-index identity** | Ignore configuration gained machine-local `ignorePaths` (`2bd4d8919`) and explicit purge behavior (`4f7e49aa5`), but not stronger index identity. | **Still open.** `src/engine/ignore.ts:734-750,772-777,804-815` still persists/accepts index path+mtime+size only. Retain same-size/restamped-index and read-only-gitdir fixtures. Preserve new config-path/purge semantics when touching matcher construction. |
| **F2 deletion batching** | No changes to `src/engine/manifest.ts` between the two baselines. | **Still open.** `applyWatchEvents` still builds the full map at272, scans all map keys per directory/unknown delete at332/341 and sorts at383. Parcel still supplies file deletes through unlinkDir. Implement the bounded absent-delete-run improvement, not a second watcher architecture. |
| **F3 matcher/dircache reuse** | `4a215540e` (#845/#818) already added `SyncDeps.matcherFor`, daemon-provided matcher, and one resident daemon dircache shared with local observer and pull. | **Split into landed plumbing and remaining freshness.** Do not re-add provider/owner or claim all trusted pulls still reconstruct a matcher. F1-derived index/dependency freshness remains absent from provider's checks. Lazy dircache acquisition remains useful only for callers without supplied cache; resident daemon pulls already avoid disk reload. |
| **F4 disposable caches** | `4c11fcda1` (#844/#822) already moved encryption cache to a separate SQLite DB, default on, with indexed SHA lookup/path ownership, immediate row upsert, epoch context reconciliation, legacy JSON import and close lifecycle. | **Encryption JSON-rewrite fix landed.** Preserve its schema/API and migration; do not create another cache DB/migration. Remaining measured-design candidates: O(N) live-path prune, per-op opening/closing, and HashCache JSON persistence. Gate refinements on current-baseline measurements. |
| **G5 Git batching** | `29e16b2b0` (#864/#863) batches ref cleanup via `deleteRefsBatch`, with metrics and per-ref fallback on a failed atomic batch. `d81f6af4c` (#868) adds pristine-index classification; `e3881c3e4` (#881) adds ff-only shadow observation. | **Ancestry batching still open; ref-deletion batching already landed.** Scratch creation still loops one update-ref per SHA; five-probe semantic index oracle remains. Do not describe shadow ff-only evaluation as replacement of the authoritative no-drop proof. |
| **S1 alarm/ACK recovery** | `apps/api/src/workspace-sync.ts` is unchanged between baselines. | **Still open.** Head acceptance then awaited alarm then fanout/response and existing-index bootstrap early return remain. The commit titled “folds never wedge” (#848) addresses client manifest-cap/folding behavior, not this DO scheduling defect. |

## Concrete current seams

### F3: extend existing plumbing, not a new provider

- `src/cli/sync/deps.ts:40-47` defines `matcherFor(state)` with undefined fallback; `src/cli/sync/pull.ts:244` consumes it.
- `src/cli/daemon/daemon.ts:2242-2243` passes matcher provider and shared dircache. The resident dircache is hydrated once at910 and supplied to `LocalWorkspaceObserver` at606; observer now uses `effects.dircache()` (`local-workspace-observer.ts:211-217,285-288`). Save/reset ownership already exists.
- `daemon.ts:2998-3000` accepts a matcher when no config rebuild is pending and known-repository topology matches. It does **not** verify current index/dependency identity. `ensureMatcherProvenance` at2985-2986 similarly checks only topology. The approved F3 index-only change tests/probes therefore remain relevant and should exercise this existing provider.
- `pull.ts:243` still calls `withDircache` before deciding scan versus trusted view; `deps.dircache` makes the daemon path cheap. Scope any lazy-acquisition PR to actual absent-provider cases; do not claim the old daemon JSON parse cost remains.
- Existing coverage to retain, not results claimed here: `sync/pull-deps-matcher.test.ts`, `daemon/daemon-trusted-pull.test.ts`, `daemon/local-workspace-observer.contract.test.ts`.

### F4: SQLite already owns encryption-address caching

- `src/cli/sync-recovery.ts:127-131` dynamically opens `openEncryptAddressCacheStore`; `RBOX_ENCRYPT_CACHE_SQLITE=0` selects the preserved JSON fallback.
- `src/cli/state-plane/encrypt-cache.ts:14-19,39-66` defines a **separate disposable database**, context metadata, path-primary-key addresses and SHA index. Repeating descriptor bodies per path is intentional current design, not a missing normalization layer.
- `record` at217-220 writes one upsert; `save` at196-197 is a no-op. Historical ~22.8MB JSON rewrite/320ms parse claims no longer describe default encryption-cache behavior.
- `prune` at231-242 still populates TEMP `live_paths` from every supplied live path and runs a whole-address anti-membership delete. The no-op and changed-push callers still pass full live sets and close the DB (`sync-recovery.ts:133-140` and final upload cleanup). This is the concrete remaining change-proportional opportunity; no new timings were collected.
- `src/engine/hashcache.ts` is unchanged and still serializes full JSON. Tests/rig already exist for migrated encryption behavior: `state-plane/encrypt-cache.test.ts`, `state-plane/encrypt-cache-rig.ts`. Reset code now includes the encryption DB lifecycle; preserve it.

### G5: existing batch cleanup and new consumers

`pins.ts:77-92` implements `deleteRefsBatch` with one NUL-framed `update-ref --stdin` and original per-ref tolerance on failure. `deleteScratchPins` at115-116 and stale pruning reuse it; follow cleanup also routes through it. This intentionally preserves prior unverified old-value deletion behavior; adding expected-old semantics is a distinct safety change requiring compatibility/ownership tests, not simply “finish batching.”

`createScratchPins` at98-107 still creates refs serially. `reachability.ts:noDropProof` at269-305 still loops protected tips × durable roots with `merge-base --is-ancestor`; `ref-plane-observation.ts:227` still calls it. Existing `partitionOwnedByIncoming` remains the candidate primitive for the approved differential optimization.

`index-identity.ts:plainIndexIdentity` was added after the original five-probe `indexIdentityV2`; pristine-index follow classification consumes it. Any projection optimization must cover both consumers and preserve their fail-closed semantics. New `git-shadow.ts` is diagnostic shadow work; do not let G5 accidentally promote its simpler policy into the mutation authority.

## Adjacent landed changes affecting validation and priority

- #845 also implements account refresh prefetch overlapping upload (`sync/push.ts:720`, `e2ee-remote.ts:190-216`, dedicated account-prefetch tests). This portion of S4/F6 preparation is already present; the broader signed-frame/current-account freshness requirements remain separate.
- `e9dc03e12` (#803, occupied design281) changes apply precondition handling to prevent echo pulls clobbering newer local edits. `engine/apply-target.ts` now owns target settlement and `apply.ts` routes through it. Any future F5/F6 staging integration must preserve that newer boundary and its conflict-copy hooks rather than patch the old audit's writeEntry shape. No change to F2's manifest patcher is implied.
- Current rig renamed `git-shapes` to **`git-layouts`** (`scripts/rig/scenarios/git-layouts.ts` and registry). Update roadmap/test-slice scenario references when importing them.
- New base-hash attestation and manifest hash options also landed under `src/cli/sync/base-hash-attestation.ts` / `src/engine/manifest-delta.ts`. X1 follow-up must account for that already-reused base evidence; this note does not reopen its audit.

**Recommended execution adjustment:** keep F1, F2, authoritative no-drop ancestry batching and S1 characterization in the first substantive priorities. Mark F3 provider/daemon-dircache plumbing, F4 encryption SQLite migration, G5 ref cleanup batching and sender account-prefetch as already landed. First fixture slice288 should pin remaining defects against `c4aa22bbb`, preserve new apply/config behavior, and avoid rebuilding those completed portions. No new benchmark or test pass is asserted by this reconciliation.
