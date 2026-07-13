# 113 — Codebase modularization: splitting the sync-engine giants

**Status:** PLAN (scoping only — no code moves in this doc's cycle)
**Review:** round 1 CHANGES-REQUIRED → revised; ledger: [REVIEW-113](./REVIEW-113.md)
**Depends on:** `impl/110-111-instrumentation` merging first (see §7)
**Goal:** restore codex/agent navigability. Six files have accreted into
multi-responsibility giants (8,692 lines combined); comment content has
drifted into review archaeology. This plan splits them along natural seams
via behavior-preserving, move-only waves and relocates review history to the
design ledgers.

**Rules (non-negotiable, apply to every wave):**

1. Every new module has ONE owner-responsibility.
2. Files target <600 lines. Exceptions are named in §2.7 with a reason
   (single class / single function that cannot be split by moves).
3. No import cycles. Internal modules never import their own barrel; barrels
   only re-export.
4. Public entry points are preserved: `src/cli/index.ts` and
   `src/engine/index.ts` are untouched; every split file's original path
   becomes a thin re-export barrel, so **zero call sites ripple**.
5. Move-only: `git mv` + import/export fixes. No logic edits, no renames of
   symbols, no signature changes. Comment relocation is its own wave (§3),
   never mixed into a move wave (mixing breaks git rename detection, which is
   a verification gate). **One mechanical exception** (REVIEW-113 HIGH 2),
   forced by ES module semantics — imported bindings cannot be assigned from
   another module: where module-level *mutable* state crosses a new module
   boundary, the owning module adds thin exported setter/reset functions
   (single-assignment bodies) and existing callers/test hooks delegate to
   them. Every permitted setter is enumerated in §2; an agent adding one not
   listed there is out of spec.
6. Test files move with their subjects when they map 1:1; multi-subject tests
   stay put (they import barrels, which don't move). A moved test's entry in
   `scripts/ci-shard-tests.ts` (`HEAVY_WEIGHTS`/`SPLIT_FILES` are keyed by
   file path; `ci.yml` runs its guard on every PR) moves with it — see §4
   for who owns that file per wave.

---

## 1. Module map of today

Line counts at `main` (0e0fdcd5). Full per-range inventories were produced by
a codex analysis pass and spot-verified against source; ranges below are the
seams the splits follow.

### 1.1 Import graph between the six giants

```
daemon.ts ──► sync.ts        (pull, pushManifest, makeDeferErrnoReporter, SyncDeps)
daemon.ts ──► e2ee-remote.ts (E2eeRemote)
sync.ts ────► sync-git.ts    (planGitSections, applyGitSections, format*, gitBaseAfterCommit, …)
```

No other edges exist among the six. `sync-git.ts`, `e2ee-remote.ts`,
`crypto-pool.ts`, and `blob-batch.ts` import none of the other five.
(Adjacent, for orientation: `sync-git.ts` imports `sync-recovery.ts`
(`PER_FILE_UPLOAD_ATTEMPTS`) and `sync-state.ts`; `remote/api.ts` imports
both `e2ee-remote.ts` (types) and `blob-batch.ts` (classes); `daemon.ts` is
reached only via dynamic `import("./daemon.js")` in `main-dispatch.ts`.)

### 1.2 `src/cli/sync-git.ts` — 2,513 lines, six responsibilities

| Lines | Responsibility |
|---|---|
| 71–132 | Cross-lane orchestration policy: capture/apply concurrency, `envInt`, repo-cap/path helpers, scope projection/carry matrix, three log-once `Set`s shared by push AND apply |
| 134–233 | Config-lane capture model + receiver: `CachedLocalCfg`, `gitConfigHash`, `shouldPublishGitConfig`, `readLocalGitConfig`, `configReceiver`, `sameConfigShape` |
| 235–345 | Capture/locking primitives shared by plan AND apply: `incrementalCapturePlan`, `nestedRepoChains`, `chainLock`, `gitApplyMutationKey`, `capturePlannedGitSection` |
| 347–1085 | Push planner: `planGitSections` (424–1040, one 617-line function with closure helpers), plan contracts, `formatGitPushLine`/`formatGitPlanStats`, `gitBaseAfterCommit`, `gitForceForMissingBlobs` |
| 1087–1755 | Divergence fingerprint cache: `GIT_FINGERPRINT_VERSION` derivation, stat/tree/index tokenization, fingerprint construction & racy-clean trust, cache persistence/probe/classify |
| 1756–2342 | Pull-side apply: `applyGitSections` (1859–2342), apply metrics, config-lane transactions, conflict preservation, quarantine ordering |
| 2343–2513 | Read-only status: `gitDivergenceStatus`, `gitDivergenceCount` (mirrors planner suppressions) |

Consumers: `sync.ts` (planner + apply + formatters), `status-cmd.ts` /
`status-view.ts` (divergence status/count), 5 test files.

### 1.3 `src/cli/daemon.ts` — 2,003 lines, one giant class + satellites

| Lines | Responsibility |
|---|---|
| 71–76 | `RboxBarAmbientStatus` (ambient-status extension type, class-coupled) |
| 78–100 | Cadence/trust/WS timing constants |
| 105–137 | `DaemonChainRepairPolicy` (standalone class) |
| 138–233 | Mostly-standalone helpers: `classifyWatcherError`, `TrustState`/`worseTrust`, `scanStatsLine`, `summarizeActions`, `daemonConsumesWakeup`, `Wants` — but `ScanCoverage` (141) and `OpenDriftAudit` (163–186) inside this range are class-coupled and stay with `RboxDaemon` |
| 246–1963 | **`RboxDaemon`** — single-flight pump, watcher trust/retrust state machine, safety/deep scan cadence, push/pull drivers, retry fences, drift audits, activity/ambient-status persistence, WS channel (connect/keepalive/backstop/reconnect), ownership wind-down. ~90 methods over shared mutable state |
| 1965–2003 | `runDaemon` entry + `reconnectDelayMs`, `nextSafetyDelay`, `jitter` |

Consumers: `main-dispatch.ts` (dynamic import of `runDaemon`) + 11 test files
importing internals (`RboxDaemon`, policies, delay functions).

### 1.4 `src/cli/sync.ts` — 1,112 lines (28.9% pure comment lines)

| Lines | Responsibility |
|---|---|
| 52–134 | Policy & flags: `pushMassDeleteTrips`, `makeDeferErrnoReporter`, `filesFirstFlagEnabled`, backoff, scan/matcher adapters |
| 135–163 | Timing/stat rendering: `formatCommitTimings`, `formatLatestTimings`, `formatApplyStats`, `formatScanStats` |
| 165–171 | Manifest-schema bookkeeping: `stampManifestSchemaForCommit` (commit-prep concern, not rendering) |
| 174–288 | `SyncDeps` injectable contract + `withCache`/`withDircache`/`withReportScanStats`/`refreshWriteContext` |
| 290–532 | Pull driver: `scanManifestForPush`, `pull`, `applyPulledManifest` (reconcile, two-phase ignore, mass-delete/trash safety, git apply, atomic state advance) |
| 533–1098 | Push driver: `push`, `PushResult`, recovery-page accumulation, `pushManifest` retry orchestrator (675–769; options contract 668–673), `runPushAttempt` single-attempt transaction (795–1086) |
| 1101–1112 | `sync()` — pull then push |

Consumers: 9 production files (daemon, init/sync/recover/export/ignore-cmd,
chain-repair, e2ee-client, main-dispatch) + 14 test files.

### 1.5 `src/engine/crypto-pool.ts` — 1,059 lines

| Lines | Responsibility |
|---|---|
| 19–28 | Runtime abstraction: `BunWorker` type + ambient `Worker` declaration (used by slot AND pool spawn path) |
| 29–50 | Operating/fusion constants incl. `MODULE_DIR` |
| 51–65 | Status contract (`CryptoPoolStatus`) + queue records (`JobRecord`, `QueueWaiter`) |
| 67–79 | Process-global registry state: `activePool`, `disabledReason`, counters, `configuredWorkersCache`, embedded-worker state, test overrides, `poolScope` |
| 81–96 | `kekFingerprint` (KEK identity, feeds pool `matches`/selection) + env parsing |
| 98–143 | Ciphertext contracts: `CiphertextLocation`/`CiphertextLease`/`CoalescedBlob`, `CiphertextBudget`, fused-job records |
| 145–186 | Sizing/config: `configuredWorkers` (reads/writes `configuredWorkersCache`), `fileDescriptorWorkerCap`, `minJobs` |
| 188–258 | Worker artifact resolution (`embeddedWorkerFile`, `workerSpecifier` — **path-sensitive** AND stateful over `embeddedWorkerPath`/`embeddedWorkerDir`/`cleanupRegistered`/`workerPathOverrideForTests`, see §2.4/§2.7) + error rehydration |
| 260–336 | `CryptoWorkerSlot` — **bidirectionally coupled to `CryptoPool`**: slot stores/invokes `pool` (265, `afterWorkerSlotFreed`/`handleWorkerCrash` at 327–333); pool constructs slots (341, 899–903) |
| 338–955 | **`CryptoPool`** — ordinary queue + fused-lane scheduler, spill, crash recovery, close |
| 957–1059 | Process-wide selection (`selectCryptoPool`, `withCryptoPool`, `shutdownCryptoPool`), status rendering, `__cryptoPoolTestHooks` (mutates the :67–79 state at 1024–1038) |

Consumers: `engine/apply.ts` + `engine/index.ts` barrel (which serves
`cli/sync-recovery.ts`, `publish-pipeline/`, `crypto-smoke.ts`,
`doctor-cmd.ts`, `status-cmd.ts`, `cli/index.ts`).

### 1.6 `src/cli/e2ee-remote.ts` — 1,021 lines

| Lines | Responsibility |
|---|---|
| 42–92 | Sidecar policy + `blobRefsForManifest`, `mdeWriteCaps` |
| 95–184 | Pure contracts: `E2eeApi`, `AccountKeysDTO`, `WsKeyDTO`, `CommitChainResult`, `VersionInfo`, `VerifiedSuffixEntry`, `HeadPin`, `PinStore`, `E2eeContext`, `CurrentWriteKek` |
| 186–1020 | **`E2eeRemote`** — verified head + anti-rollback pins, manifest fetch/decrypt/fold (`decodeManifestAt` 239–430), history/restore/suffix/rebaseline, `commit` orchestration (749–934), blob delegation, account refresh, KEK cache |

Consumers: `daemon.ts`, `e2ee-client.ts`, `chain-repair.ts`, `doctor-cmd.ts`
(class); `remote/api.ts`, `remote/keys.ts`, `remote/commits.ts`,
`e2ee-fake-server.ts` (types only); 5 test files.

### 1.7 `src/cli/remote/blob-batch.ts` — 984 lines

| Lines | Responsibility |
|---|---|
| 13–49 | Wire constants (`BATCH_*`, mirror of `apps/api/src/blob-batch.ts`) interleaved with tuning defaults/caps (slots, flush delay, grant refresh, watchdog, fallback concurrencies) — two owners in one range, see §2.6 |
| 51–101 | Models: `BatchFrame`/`BatchConfig` (shared), `BatchRequest`/`AttemptKind` (downloader-only), `BatchPutWaiter`/`BatchPutGroup`/`BatchPutResponseRecord` (uploader/wire) |
| 103–133 | Process kill-switch flags (`downloadDisabledForProcess`/`uploadDisabledForProcess`), dispatch counter, `SingleGate`, test resets — **shared by both classes** |
| 135–207 | Streaming GET frame decoder `parseBatchFrames` |
| 209–570 | `BlobBatchDownloader` — queue/scheduler, batch GET, watchdog, single-lane degradation, race-safe publication |
| 573–920 | `BlobBatchUploader` — SHA coalescing, batch PUT, receipt accounting, degradation, close protocol |
| 923–984 | Env config (`uploadBatchConfig`/`downloadBatchConfig`) + response/status codecs |

Consumers: `remote/api.ts` (classes), `e2ee-fake-server.ts` (wire constants),
`blob-batch.test.ts`.

---

## 2. Target structure

Pattern for every split: `git mv` the giant onto its largest fragment, carve
the rest into sibling modules, recreate the original path as a **thin barrel**
that re-exports the exact current public surface. Importers (production and
tests) keep compiling unchanged.

### 2.1 `sync-git.ts` → `src/cli/sync-git/`

| New file | Owns (from today's lines) | ~Lines |
|---|---|---|
| `src/cli/sync-git/shared.ts` | 71–132 cross-lane orchestration policy (concurrency, `envInt`, repo cap/path helpers, scope projection/carry matrix, the three log-once `Set`s) + 235–345 capture/locking primitives (`chainLock`, `gitApplyMutationKey`, `nestedRepoChains`, `incrementalCapturePlan`, `capturePlannedGitSection`) — shared by plan AND apply (apply uses `chainLock`/`gitApplyMutationKey` at today's 2294/2324), so they live in one owner instead of plan-reaching-into-apply or vice versa | ~180 |
| `src/cli/sync-git/plan.ts` | 347–1085: `planGitSections` + plan contracts + push formatters + commit bookkeeping (`gitBaseAfterCommit`, `gitForceForMissingBlobs`) | ~740 ⚠ (§2.7) |
| `src/cli/sync-git/config-lane.ts` | 134–233: `CachedLocalCfg`, `gitConfigHash`, `shouldPublishGitConfig`, `readLocalGitConfig`, `configReceiver`, `sameConfigShape` | ~100 |
| `src/cli/sync-git/fingerprint.ts` | 1273–1487: filesystem tokenization + git fingerprint construction/trust + `GIT_FINGERPRINT_VERSION` / `gitFingerprintVersionForBounds` / `GitConfigWireBounds` (version derivation stays WITH the token code it versions) | ~310 |
| `src/cli/sync-git/divergence-cache.ts` | 1087–1272 cache schema/persistence/fast source, 1489–1755 probe build/classify/write/refresh | ~420 |
| `src/cli/sync-git/apply.ts` | 1756–2342: `applyGitSections`, apply metrics + `formatGitApplyMetrics`, config-lane transactions, conflict preservation, scheduler | ~590 |
| `src/cli/sync-git/status.ts` | 2343–2513: `gitDivergenceStatus`, `gitDivergenceCount` | ~175 |
| `src/cli/sync-git.ts` (barrel) | re-exports today's exact export list | ~40 |

The log-once `Set`s and lock primitives are module-level shared state:
`shared.ts` is their single owner; `plan.ts`, `apply.ts`, and `status.ts`
import them (single instance preserved — §5 gate 5). No setters needed here:
the `Set`s are mutated via methods, not rebound.

Tests: `git-sync.test.ts`, `sync-git-config-push.test.ts`,
`sync-git-config-pull.test.ts` → `src/cli/sync-git/` (imports fixed one
level). `git-config-sync.e2e.test.ts` and `apply-stats-format.test.ts` stay
(multi-subject: they also import `sync.ts`).

### 2.2 `daemon.ts` → `src/cli/daemon/`

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/daemon/policy.ts` | `DaemonChainRepairPolicy`, `classifyWatcherError`, `TrustState`/`worseTrust`, `daemonConsumesWakeup`, `Wants`, `reconnectDelayMs`, `nextSafetyDelay`, `jitter`, cadence/retrust/WS constants | ~200 |
| `src/cli/daemon/render.ts` | `scanStatsLine`, `summarizeActions`, `cleanPath`, `LOG_PATHS_MAX`, `log` | ~80 |
| `src/cli/daemon/daemon.ts` | `RboxDaemon` + `runDaemon` + the class-coupled types `OpenDriftAudit`, `ScanCoverage`, `RboxBarAmbientStatus` (they snapshot/extend class state and move WITH the class, not with the helpers) | ~1,720 ⚠ (§2.7) |
| `src/cli/daemon.ts` (barrel) | re-exports `runDaemon`, `RboxDaemon`, `ACTIVITY_HEARTBEAT_MS`, policies, render helpers, delay fns | ~20 |

Tests moving in: `daemon-chain-repair-policy.test.ts`,
`daemon-ws-reliability.test.ts`, `daemon-safety.test.ts`,
`daemon-activity.test.ts`, `daemon-watch-degrade.test.ts`,
`daemon-scan-defer.test.ts`, `daemon-binding.test.ts` →
`src/cli/daemon/`. `watcher-retrust.test.ts`, `sync-mutex.test.ts`,
`design85-*.test.ts` stay (multi-subject). Moved tests using
`mock.module("../engine/…")` get their relative specifiers fixed
(`../../engine/…`) — bun resolves these against the test file.

### 2.3 `sync.ts` → `src/cli/sync/`

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/sync/policy.ts` | 52–134: `pushMassDeleteTrips` + mass-delete constants, `makeDeferErrnoReporter`, `filesFirstFlagEnabled`, `MAX_ATTEMPTS`, backoff, `apiFor`, scan/matcher adapters, `CurrentWriteContext`/`WriteContextProvider` | ~110 |
| `src/cli/sync/format.ts` | 135–163: `fmt*`/`format*` render helpers + `ScanDetails` (rendering only — flag registry stays in `policy.ts`; `stampManifestSchemaForCommit` is NOT rendering and goes to `push.ts`) | ~50 |
| `src/cli/sync/deps.ts` | 174–288: `SyncDeps`, `withReportScanStats`, `withCache`, `withDircache`, `refreshWriteContext` | ~120 |
| `src/cli/sync/pull.ts` | 290–532: `scanManifestForPush`, `pull`, `applyPulledManifest` | ~250 |
| `src/cli/sync/push.ts` | 533–1098: `push`, `PushResult`, `RepairPushMode`, `accumulateRecoveryPage`, `reuploadOutcome`, `pushManifest`, `runPushAttempt`, `stampManifestSchemaForCommit`, `assertNoUnevaluatedPurgeDeletes` | ~590 |
| `src/cli/sync/sync.ts` | `sync()` orchestrator | ~20 |
| `src/cli/sync.ts` (barrel) | re-exports today's export list | ~30 |

Tests moving in: `sync.test.ts`, `push-guard.test.ts`,
`push-mass-delete.test.ts`, `sync-scan-defer.test.ts` → `src/cli/sync/`.
`files-first.test.ts`, `e2ee-sync.test.ts`, `versions-restore.test.ts`, etc.
stay (multi-subject).

### 2.4 `crypto-pool.ts` → `src/engine/crypto-pool/` (+ one same-level file)

| New file | Owns | ~Lines |
|---|---|---|
| `src/engine/crypto-worker-files.ts` | 188–227 resolver (`isCompiledRuntime`, `embeddedWorkerFile`, `workerSpecifier`, `cleanupEmbeddedWorker`, `MODULE_DIR`) **plus the mutable state it closes over** (today's 72–75: `embeddedWorkerPath`, `embeddedWorkerDir`, `cleanupRegistered`, `workerPathOverrideForTests`). Stays at `src/engine/` level so `path.join(MODULE_DIR, "crypto-worker.ts")` and `import("./generated/crypto-worker.bundle.js")` keep their exact relative depth — zero path rewrites in the compiled-binary-sensitive code. **Permitted setter (rule 5):** `setWorkerPathOverrideForTests(path: string \| undefined)` — `__cryptoPoolTestHooks.setWorkerPath`/`reset` delegate to it and to the existing `cleanupEmbeddedWorker` | ~75 |
| `src/engine/crypto-pool/config.ts` | 29–50 constants (minus `MODULE_DIR`), 85–96 env parsing, 145–186 sizing **plus its cache** (`configuredWorkersCache`, today :71). **Permitted setter (rule 5):** `resetConfiguredWorkersCacheForTests()` — called by `__cryptoPoolTestHooks.reset` (today :1030) | ~100 |
| `src/engine/crypto-pool/errors.ts` | 229–258: `rehydrateError`, `workerCrashError`, `closeError`, `streamCancelledError` | ~35 |
| `src/engine/crypto-pool/budget.ts` | 98–143: ciphertext contracts, `CiphertextBudget`, fused-job record types | ~55 |
| `src/engine/crypto-pool/pool.ts` | 260–336 `CryptoWorkerSlot` **+** 338–1059 `CryptoPool` + process registry (`activePool`, `poolScope`, remaining counters/overrides from :67–79, `selectCryptoPool`, `withCryptoPool`, `shutdownCryptoPool`, `cryptoPoolStatus`, `__cryptoPoolTestHooks`) + 19–28 `BunWorker`/`Worker` runtime abstraction + 51–65 `CryptoPoolStatus`/`JobRecord`/`QueueWaiter` + 81–83 `kekFingerprint`. Slot and pool are **bidirectionally coupled** (slot invokes `pool.afterWorkerSlotFreed`/`handleWorkerCrash`; pool constructs slots) — a slot.ts/pool.ts split would create exactly the cycle rule 3 forbids, so they stay together (REVIEW-113 HIGH 1) | ~740 ⚠ (§2.7) |
| `src/engine/crypto-pool.ts` (barrel) | re-exports today's export list (serves `engine/index.ts` unchanged) | ~15 |

`jobsRunTotal`/`workerExecutionsTotal` are mutated by slots and reset by
hooks — both live in `pool.ts` alongside slot+pool, so no setters are needed
for them. Tests: `crypto-pool.test.ts`, `crypto-fused.test.ts` →
`src/engine/crypto-pool/`. `crypto-pool-exit.test.ts` + fixture stay (they
exercise via the fixture/barrel).

### 2.5 `e2ee-remote.ts` → types split (minimal)

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/e2ee-remote-types.ts` | 95–184 **genuinely shared contracts only**: `E2eeApi`, `AccountKeysDTO`, `WsKeyDTO`, `CommitChainResult`, `VersionInfo`, `VerifiedSuffixEntry`, `HeadPin`, `PinStore`, `E2eeContext`, `CurrentWriteKek` — these are what `remote/api.ts`, `remote/keys.ts`, `remote/commits.ts`, and `e2ee-fake-server.ts` actually import | ~100 |
| `src/cli/e2ee-remote.ts` | `E2eeRemote` class **plus its implementation policy** — `HISTORY_DECRYPT_CONCURRENCY`, `EMPTY_MANIFEST`, `mdeWriteCaps` (write-capability policy), `blobRefsForManifest` (manifest traversal), `SIDECAR_THRESHOLD`: these are behavior, not contracts, and stay with the class (still exported here — `e2ee-sync.test.ts` imports two of them). Re-exports the types so no importer ripples | ~920 ⚠ (§2.7) |

This deliberately does NOT split the class (see §2.7). The types split still
matters: it lets `remote/*` and the fake server depend on pure contracts
without the ~920-line implementation in their import graph.

### 2.6 `blob-batch.ts` → `src/cli/remote/blob-batch/`

Today's 13–101 mixes four owners (wire constants, tuning defaults,
downloader-only models, uploader-only models); the split re-partitions by
owner instead of moving the range wholesale:

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/remote/blob-batch/wire.ts` | wire protocol only: `BATCH_BLOB_CONTENT_TYPE`/`BATCH_FRAME_HEADER_BYTES`/`BATCH_STATUS_BIT`/`BATCH_STATUS_MAX_BYTES`, `BatchFrame`, 135–207 `parseBatchFrames`, 952–984 codecs (`framedBytes`, `parseStatus`, `parseBatchPutResponse` + `BatchPutResponseRecord`) — the client half of the contract with `apps/api/src/blob-batch.ts` | ~150 |
| `src/cli/remote/blob-batch/gate.ts` | 103–133: process kill-switch flags, `dispatchCount` + getters/reset, `SingleGate`, `resetBatchBlobStateForTests` — single module = single instance for both classes. **Permitted setters (rule 5):** `disableDownloadForProcess()`/`disableUploadForProcess()`/`downloadDisabled()`/`uploadDisabled()` + `incrementDispatchCount()` if the flags/counter are today assigned from class code — the wave agent checks assignment sites and adds ONLY what cross-module assignment forces | ~50 |
| `src/cli/remote/blob-batch/config.ts` | `BatchConfig` + ALL tuning defaults/caps from 20–46 (`DEFAULT_BATCH_*`, `MAX_*_SLOTS`, `FLUSH_DELAY_MS`, `GRANT_REFRESH_AFTER_MS`, `SINGLE_*_CONCURRENCY`, watchdog defaults) + 923–950 `readBatchConfig`, `envIntFirst`, `uploadBatchConfig`, `downloadBatchConfig` | ~80 |
| `src/cli/remote/blob-batch/downloader.ts` | 209–570 `BlobBatchDownloader` + its private models `BatchRequest`/`AttemptKind` (65–80) + `debug` (sole user, :536) | ~390 |
| `src/cli/remote/blob-batch/uploader.ts` | 573–920 `BlobBatchUploader` + its private models `BatchPutWaiter`/`BatchPutGroup` (82–97) | ~370 |
| `src/cli/remote/blob-batch.ts` (barrel) | re-exports today's export list | ~15 |

Test: `blob-batch.test.ts` → `src/cli/remote/blob-batch/`, with two
non-obvious depth fixes the wave agent must make explicitly: the dynamic
`await import("../sync-recovery.js")` (today :471) becomes
`../../sync-recovery.js`, and the query-suffixed cache-busting import
`` await import(`../../engine/apply.ts?batch-e2e=…`) `` (today :594) becomes
`../../../engine/apply.ts?…` — grep the moved test for `import(` to catch
both.

### 2.7 Documented exceptions to the <600 rule (and what is load-bearing)

These are NOT split in this workstream because splitting them is not
achievable by moves — they are single closures/classes over shared mutable
state, and carving them means logic edits with real regression risk:

- **`planGitSections`** (~617-line function): closure helpers share cloned
  sidecars, admission counts, fingerprint run, and stats; helper ORDER is
  semantic (suppression before preflight, fast before slow, linked-pointer
  after `sectioned`). Moves as one unit into `sync-git/plan.ts`.
- **`RboxDaemon`** (~1,700 lines): one state machine — pump single-flight,
  watcher trust, scans, drift, WS, retries all mutate common fields. The
  founder-suggested seams (tick loop / watcher trust / WS channel) require
  delegate extraction with an explicit interface back into the pump — that is
  a **phase-B design of its own** (114 candidate), reviewed and tested as a
  behavior change, not smuggled into a move wave.
- **`CryptoPool` + `CryptoWorkerSlot` + process registry** (one module,
  `pool.ts`, ~740): slot and pool are bidirectionally coupled — slot stores
  the pool reference and calls `afterWorkerSlotFreed`/`handleWorkerCrash`,
  pool constructs slots — so a slot/pool file split is an import cycle by
  construction (REVIEW-113 HIGH 1). The fused lane is one scheduler. If a
  slot extraction is ever wanted, it is a phase-B interface refactor
  (callback seam), not a move.
- **`E2eeRemote`**: `verifiedHead`/`refreshAccount`/`pinFrom`/
  `retainedSegmentEndingAtHead` jointly implement ordering-sensitive
  anti-rollback; `commit` and `decodeManifestAt` close over shared KEK/pin/LRU
  state. Phase-B candidate (chain-reader vs commit-writer delegates), not now.
- **`applyGitSections`** (~480 lines incl. helpers): apply helpers mutate
  shared `applied`/`pending`/`removedMem`/`configLane` maps; `pack()` depends
  on all of them. Moves as one unit into `sync-git/apply.ts`.

Post-plan sizes of the six paths: sync-git.ts 2,513→40 (dir max 740),
daemon.ts 2,003→20 (dir max 1,720), sync.ts 1,112→30 (dir max 590),
crypto-pool.ts 1,059→15 (dir max 740), e2ee-remote.ts 1,021→920,
blob-batch.ts 984→15 (dir max 390).

---

## 3. Comment policy

Three classes, one rule each:

- **CONSTRAINT** (states an invariant the code can't express — crash-safety
  ordering, trust rules, wire-format mirrors): **STAYS**, verbatim. If it
  carries a review citation, the citation is stripped, the invariant prose
  kept. Example (`daemon.ts:522`): keep "the scan must return to its 60s
  cadence the moment there is churn to protect", drop "(codex R1)".
- **REVIEW-BREADCRUMB** (pure history: "codex round-6 MAJOR 2", "codex
  step-3 BLOCKER", "codex R4 P1"): **MOVES** to the design's review ledger.
  Destination: `docs/design/REVIEW-N.md` for designs ≥98; for older designs
  (43, 45, 49, 68, 85 …) the review-history section of the design doc itself
  (per `docs/design/README.md` convention). If the ledger already records the
  finding (most do — the comments were written FROM those reviews), the code
  comment is simply deleted; if not, a one-line entry is appended to the
  ledger first. When the design number isn't stated in the comment, `git
  blame` identifies the introducing commit/design before deletion.
- **DESIGN-REF** ("design 108 §3.6 (round-4 MAJOR 2)"): **COMPRESSES** to a
  bare doc pointer — "(design 108)". Section numbers rot as design docs get
  amended; the doc's own structure is the index.

Cluster inventory (from the repo-wide codex audit, spot-verified):

| File | Clusters | Breadcrumb → ledger | Design-ref → compress | Constraint → keep |
|---|---:|---:|---:|---:|
| `src/cli/sync.ts` | 38 | 7 → REVIEW-108 + design 45/93 headers | 20 | 11 |
| `src/cli/daemon.ts` | 31 | 7 → REVIEW-104/105 + design 45/49 headers | 15 | 9 |
| `src/cli/sync-git.ts` | 31 | 4 → design 43/68 headers | 10 | 17 |
| `src/cli/e2ee-remote.ts` | 8 | 2 → design 12 header / REVIEW-106 | 3 | 3 |
| `src/engine/crypto-pool.ts` | 1 | 0 | 1 | 0 |
| `src/cli/remote/blob-batch.ts` | 0 | 0 | 0 | 0 |
| rest of `src/` (notables: `main-dispatch.ts` 11 design-refs, `engine/git/apply.ts` 6, `git-nested.test.ts` 4 breadcrumbs, `config.ts` 11 clusters) | ~190 | ~25 | ~75 | ~90 |

Specific named clusters found and their destinations:

- `sync.ts:895/947/1036` "codex step-3 round-3 MAJOR", "Design 108 §3.6
  (round-4 MAJOR 2)", "(§28, codex M3)" → REVIEW-108 (breadcrumb part);
  invariant prose (try/finally must cover every post-arm exit; re-capture on
  missing bundle) stays.
- `sync-git.ts:533/933/1077/2052/2060/2239` "codex step-3 MAJOR/BLOCKER",
  "codex M4", "(§28, codex M3)" → design 43/68 review headers; the
  crash-safety ordering prose stays.
- `sync-git.ts:71–78` header: the `[v2]…[v6]` codex-rule tags are **rule IDs**
  cross-referencing design 43's numbered review rules — these are treated as
  CONSTRAINT markers and stay attached to the logic they govern (the header
  says so explicitly, and it is right).
- `daemon.ts:463/466/731/804/861/1025/1177` "codex R1/R2/R4 P1/M3" →
  REVIEW-104 (watcher trust) / REVIEW-105 (WS); invariants stay.
- `e2ee-remote.ts:788` "codex M2" (ciphertext-size advisory rule) → invariant
  stays, citation dropped.
- `sync.ts:111` "(codex round-6 MAJOR 1)" flag-off output compatibility →
  REVIEW-108; invariant ("flag-off `rbox init` emits exactly the pre-108
  output") stays.

The sweep also covers the ~190 clusters outside the six giants (same three
rules), in the same wave (§4 wave 4). Comment percentage targets after sweep:
sync modules ≤ ~15% (from 28.9%), daemon ≤ ~12%, others unchanged-ish —
constraints dominate what remains, which is the point.

---

## 4. Execution waves

All waves run in `.claude/worktrees/` branches, one codex agent per branch,
**file sets pairwise disjoint within a wave**. Every wave lands as its own PR,
green on the full gate (§5) before the next wave rebases. Move waves are pure
`git mv` + import/export fixes.

**Precondition (wave 0):** `impl/110-111-instrumentation` merged. Rebase this
plan's line ranges for `sync-recovery.ts`, `upload-lane-timing.ts`,
`remote/commits.ts`, `publish-pipeline/pipeline.ts`, and the new
`first-publish-overlap.test.ts` — none of those five are split by this plan,
but wave 3's `sync/push.ts` sits adjacent to them; re-verify §1 ranges for
`sync.ts` before wave 3 (the instrumentation spec does not edit `sync.ts`, so
drift should be nil, but verify anyway).

| Wave | Agents (parallel) | Files touched (disjoint) | Merge order |
|---|---|---|---|
| **1** | **1a** blob-batch split | `src/cli/remote/blob-batch.ts` → dir + `blob-batch.test.ts` | 1a, 1b, 1c in any order |
| | **1b** crypto-pool split | `src/engine/crypto-pool.ts` → dir + `crypto-worker-files.ts` + 2 tests | |
| | **1c** e2ee-remote types split | `src/cli/e2ee-remote.ts` + new `e2ee-remote-types.ts` | |
| **2** | **2a** sync-git split | `src/cli/sync-git.ts` → dir + 3 tests + `scripts/ci-shard-tests.ts` (its `SPLIT_FILES` key for `git-sync.test.ts`) | **2a first, then 2b** — both must edit `scripts/ci-shard-tests.ts`, which is the one file the waves share; 2b rebases its registry edit onto 2a's |
| | **2b** daemon satellite split | `src/cli/daemon.ts` → dir + 7 tests + `scripts/ci-shard-tests.ts` (`HEAVY_WEIGHTS` keys for the 4 moved daemon tests) | |
| **3** | **3a** sync split (single agent) | `src/cli/sync.ts` → dir + 4 tests + `scripts/ci-shard-tests.ts` (`HEAVY_WEIGHTS` key for `sync.test.ts`) | after 2a+2b merged |
| **4** | **4a** comment sweep (single agent — it appends to shared ledger files, so no parallelism) | all files with clusters (§3) + `docs/design/REVIEW-*.md` + design-doc headers | after 3a |
| **5** | **5a** CODEMAP + final review | `docs/CODEMAP.md`, `AGENTS.md` pointer; codex adversarial pass over cumulative diff | last |

Notes:

- Waves 1 and 2 have no file overlap and could in principle run as five
  concurrent agents; they are staged as two waves so a rename-detection or
  compiled-binary failure in wave 1 (the riskiest: crypto-pool worker paths)
  is bisected before more moves stack on top.
- Wave 3 is single-agent and last of the moves because `sync.ts` has the
  densest consumer fan-in (9 production + 14 test importers) and the deepest
  closure coupling.
- Wave 4 is deliberately AFTER all moves: comment edits in already-moved files
  keep move-wave diffs 100% rename-detectable.
- Test files move in the same PR as their subject (rule 6). Moved tests get
  relative-specifier fixes for imports, `mock.module("../engine/…")` paths,
  AND dynamic `import(…)` expressions (including query-suffixed ones — §2.6).
- **`scripts/ci-shard-tests.ts` is a serialized file**: its `HEAVY_WEIGHTS`
  and `SPLIT_FILES` registries are keyed by test file path, and `ci.yml` runs
  `bun scripts/ci-shard-tests.ts guard --shard-count 6` on every PR — a moved
  test with a stale registry key passes `bun test ./src/` locally while CI's
  registry points at a dead path. Each moving wave updates the keys for ITS
  tests in its own PR; when two agents in one wave both need it (wave 2),
  merge order is fixed and the second rebases. Registry key updates are
  path-only edits (weights/part lists unchanged).

---

## 5. Verification gates

Per move-wave PR (all must pass before merge):

1. `bun test ./src/` — full suite, not just moved tests (repo baseline:
   currently green on main).
2. `npm run typecheck` (root + apps/api project refs).
3. **CI shard-registry guard** (every wave, run locally before pushing):
   `bun scripts/ci-shard-tests.ts guard --shard-count 6` — this is what
   `ci.yml` runs; it fails on dead `HEAVY_WEIGHTS`/`SPLIT_FILES` paths and on
   split-name coverage drift after a test move.
4. **Carve-detection gate:** `git diff --find-copies-harder -C -C
   main...HEAD --stat` (plain `--find-renames` cannot attribute a one-to-many
   carve; copy detection can). Every carved module must show as a
   rename/copy from its giant; any hunk that is neither may contain ONLY
   import/export lines, the permitted rule-5 setters, and barrel files. As a
   belt-and-braces content check, the reviewer concatenates the carved
   modules minus import/export/setter lines and diffs against the original's
   corresponding regions — the result must be empty.
5. **Single-instance gate** (waves 1a, 1b, 2a): module-level mutable state
   that moved (`downloadDisabledForProcess`/`uploadDisabledForProcess`/
   `dispatchCount`/`SingleGate`; sync-git log-once sets + lock maps;
   crypto-pool registry/cache/override state) exists in exactly one module —
   `grep -rn` for each declaration name across `src/` shows one definition
   site — and every rule-5 setter added is on the §2 enumerated list.
6. **Compiled-runtime smoke** (wave 1b mandatory, others cheap enough to run
   anyway): build the compiled binary (dev-install flow) and run the crypto
   smoke path (`crypto-smoke.ts` exercises `withCryptoPool`/
   `cryptoPoolStatus`) — proves worker artifact resolution
   (`$bunfs`/embedded bundle/`MODULE_DIR`) survived the move.
7. **Zero-behavior-diff spot checks:** on the local test rig
   (`npm run rig`), one full sync cycle + `rbox status` before/after the
   wave; compare forensic log lines and compact stat tokens byte-for-byte
   (the format strings are load-bearing — `files-first.test.ts` privacy test
   greps them). Daemon wave additionally: start/stop daemon, confirm
   `activity.json` schema unchanged.
8. **Cycle gate (enforcing):** `bunx madge --circular --extensions ts src/`
   must exit 0 with zero cycles reported — the command's exit code is the
   gate (no `|| true`, no advisory mode). Baseline it once before wave 1; if
   main already has cycles, the gate is "no NEW cycles vs the recorded
   baseline list". Specifically forbidden: any internal module importing its
   own barrel.

Final (wave 5): codex adversarial pass over the whole cumulative restructure
(`git diff <pre-wave-1>…HEAD`) with the explicit brief "find any behavior
delta, any dropped comment that was a constraint, any double-instantiated
module state"; then the standard `/simplify` + `/antislop-codebase` pass per
AGENTS.md before the workstream closes.

---

## 6. Structure map artifact — `docs/CODEMAP.md`

Wave 5 creates `docs/CODEMAP.md`: one line per module — what it owns, what it
must never own. Format:

```
src/cli/sync/push.ts        — push retry orchestration + single-attempt transaction. Never: rendering, remote construction.
src/cli/sync/format.ts      — compact stat/timing token rendering. Never: state, I/O.
src/cli/sync-git/plan.ts    — git push planning (capture/carry/defer decisions). Never: apply-side mutation, status rendering.
src/cli/sync-git/apply.ts   — pull-side git materialization + config-lane txns. Never: planning policy.
src/cli/remote/blob-batch/gate.ts — process-wide batch kill switches. Never: per-request logic.
…
```

Scope: the ~35 modules of the sync engine (`src/cli/sync*`, `src/cli/daemon*`,
`src/cli/remote/`, `src/cli/publish-pipeline/`, `src/engine/`), not the
command files. Maintenance rule (added to AGENTS.md): any PR that adds a
module or changes a module's ownership updates its CODEMAP line — future
codex specs cite CODEMAP lines instead of re-deriving structure, which is the
navigability payoff this whole design exists for.

---

## 7. Sequencing against in-flight work

- `impl/110-111-instrumentation` (flags-off instrumentation; spec touches
  `upload-lane-timing.ts`, `remote/commits.ts`, `sync-recovery.ts`,
  `publish-pipeline/pipeline.ts` + tests): **merges first**. This plan does
  not split any of those four files, so the only interaction is textual
  adjacency in wave-3/4 files; wave 0 re-verifies ranges post-merge.
- Design 112 (batch fill + wire cap) will touch `blob-batch.ts` when it
  implements: if 112 lands before wave 1a, re-verify §1.7 ranges; if after,
  112's spec should target the post-split `blob-batch/` modules — this
  ordering question is decided when 112 is scheduled (the split makes 112's
  diff smaller either way; `wire.ts` + `config.ts` are exactly its blast
  radius).
- No `apps/` files are touched anywhere in this plan; Workers Builds and web
  deploys are unaffected.

## 8. Risk register (top movers)

1. **crypto-pool worker artifact resolution** (wave 1b): `MODULE_DIR`-relative
   `crypto-worker.ts` lookup and the `import("./generated/crypto-worker.bundle.js",
   { with: { type: "text" } })` embedded-bundle import are directory-depth
   sensitive and compiled-runtime (`$bunfs`) sensitive. Mitigation: keep
   `crypto-worker-files.ts` at `src/engine/` (zero depth change) + gate 6.
2. **`sync/push.ts` carve-out** (wave 3): `pushManifest`/`runPushAttempt`
   close over module helpers and the process-global `firstPublishTiming`;
   try/finally arming coverage is an explicit review invariant. Pure moves
   only; the wave-3 agent is forbidden from "tidying" anything in this file.
3. **sync-git fingerprint/cache split** (wave 2a): `GIT_FINGERPRINT_VERSION`
   must stay derived-from-and-adjacent-to the token code (`fingerprint.ts`),
   or a drifted constant silently invalidates (or worse, wrongly trusts)
   every cached divergence probe. Log-once sets + lock maps single-instance
   gate applies.
4. **blob-batch gate module** (wave 1a): kill-switch flags + `SingleGate` are
   process-wide negotiation state consumed by both classes (flags flipped
   from downloader :451 and uploader :734); a second instance (duplicated
   declaration instead of shared import) breaks 404/405 degradation. Gate 5
   covers it.
5. **daemon barrel + dynamic imports** (wave 2b): `main-dispatch.ts` does
   `await import("./daemon.js")` and `daemon-scan-defer.test.ts` imports
   `RboxDaemon` dynamically; the barrel must preserve those specifiers, and
   moved tests must fix `mock.module` relative paths. Compiled-binary smoke
   (gate 6) proves the dynamic-import graph still bundles.
6. **CI shard registry** (waves 2a, 2b, 3): `scripts/ci-shard-tests.ts` keys
   tests by path and its guard gates CI — a move without the registry update
   is green locally and red (or silently mis-sharded) in CI. Gate 3 runs the
   exact guard per wave; the file is serialized across agents (§4).

Known codex-analysis erratum (corrected here): the raw inventory claimed
`planGitSections` is imported by `sync-recovery.ts`; the actual edge is the
reverse (`sync-git.ts` imports `PER_FILE_UPLOAD_ATTEMPTS` from
`sync-recovery.ts`). The import graph in §1.1 is the verified one.
