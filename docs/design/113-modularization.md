# 113 — Codebase modularization: splitting the sync-engine giants

**Status:** PLAN (scoping only — no code moves in this doc's cycle)
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
   a verification gate).
6. Test files move with their subjects when they map 1:1; multi-subject tests
   stay put (they import barrels, which don't move).

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

### 1.2 `src/cli/sync-git.ts` — 2,513 lines, five responsibilities

| Lines | Responsibility |
|---|---|
| 71–345 | Config-lane capture model: `readLocalGitConfig`, `configReceiver`, `gitConfigHash`, `shouldPublishGitConfig`, capture planning + `chainLock` primitives |
| 347–1085 | Push planner: `planGitSections` (424–1040, one 617-line function with closure helpers), plan contracts, `formatGitPushLine`/`formatGitPlanStats`, `gitBaseAfterCommit`, `gitForceForMissingBlobs` |
| 1087–1755 | Divergence fingerprint cache: `GIT_FINGERPRINT_VERSION` derivation, stat/tree/index tokenization, fingerprint construction & racy-clean trust, cache persistence/probe/classify |
| 1756–2342 | Pull-side apply: `applyGitSections` (1859–2342), apply metrics, config-lane transactions, conflict preservation, quarantine ordering |
| 2343–2513 | Read-only status: `gitDivergenceStatus`, `gitDivergenceCount` (mirrors planner suppressions) |

Consumers: `sync.ts` (planner + apply + formatters), `status-cmd.ts` /
`status-view.ts` (divergence status/count), 5 test files.

### 1.3 `src/cli/daemon.ts` — 2,003 lines, one giant class + satellites

| Lines | Responsibility |
|---|---|
| 78–100 | Cadence/trust/WS timing constants |
| 105–137 | `DaemonChainRepairPolicy` (standalone class) |
| 138–233 | Standalone helpers: `classifyWatcherError`, `TrustState`/`worseTrust`, `scanStatsLine`, `summarizeActions`, `daemonConsumesWakeup`, `Wants` |
| 246–1963 | **`RboxDaemon`** — single-flight pump, watcher trust/retrust state machine, safety/deep scan cadence, push/pull drivers, retry fences, drift audits, activity/ambient-status persistence, WS channel (connect/keepalive/backstop/reconnect), ownership wind-down. ~90 methods over shared mutable state |
| 1965–2003 | `runDaemon` entry + `reconnectDelayMs`, `nextSafetyDelay`, `jitter` |

Consumers: `main-dispatch.ts` (dynamic import of `runDaemon`) + 11 test files
importing internals (`RboxDaemon`, policies, delay functions).

### 1.4 `src/cli/sync.ts` — 1,112 lines (28.9% pure comment lines)

| Lines | Responsibility |
|---|---|
| 52–134 | Policy & flags: `pushMassDeleteTrips`, `makeDeferErrnoReporter`, `filesFirstFlagEnabled`, backoff, scan/matcher adapters |
| 135–171 | Timing/stat rendering: `formatCommitTimings`, `formatLatestTimings`, `formatApplyStats`, `formatScanStats`, `stampManifestSchemaForCommit` |
| 174–288 | `SyncDeps` injectable contract + `withCache`/`withDircache`/`withReportScanStats`/`refreshWriteContext` |
| 290–532 | Pull driver: `scanManifestForPush`, `pull`, `applyPulledManifest` (reconcile, two-phase ignore, mass-delete/trash safety, git apply, atomic state advance) |
| 533–1098 | Push driver: `push`, `PushResult`, recovery-page accumulation, `pushManifest` retry orchestrator (650–769), `runPushAttempt` single-attempt transaction (795–1086) |
| 1101–1112 | `sync()` — pull then push |

Consumers: 9 production files (daemon, init/sync/recover/export/ignore-cmd,
chain-repair, e2ee-client, main-dispatch) + 14 test files.

### 1.5 `src/engine/crypto-pool.ts` — 1,059 lines

| Lines | Responsibility |
|---|---|
| 19–96 | Constants, process-global registry state (`activePool`, counters, test overrides, `poolScope`), env parsing |
| 98–143 | Ciphertext contracts: `CiphertextLocation`/`CiphertextLease`/`CoalescedBlob`, `CiphertextBudget`, fused-job records |
| 145–186 | Sizing/config: `configuredWorkers`, `fileDescriptorWorkerCap`, `minJobs` |
| 188–258 | Worker artifact resolution (`embeddedWorkerFile`, `workerSpecifier` — **path-sensitive**, see §2.7/§4) + error rehydration |
| 260–336 | `CryptoWorkerSlot` protocol |
| 338–955 | **`CryptoPool`** — ordinary queue + fused-lane scheduler, spill, crash recovery, close |
| 957–1059 | Process-wide selection (`selectCryptoPool`, `withCryptoPool`, `shutdownCryptoPool`), status rendering, `__cryptoPoolTestHooks` |

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
| 13–101 | Wire constants + frame/request/group models (mirrors `apps/api/src/blob-batch.ts`) |
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
| `src/cli/sync-git/plan.ts` | push planner: 71–132 shared policy/constants, 235–345 capture primitives, 347–1085 `planGitSections` + contracts + push formatters + commit bookkeeping | ~880 ⚠ (§2.7) |
| `src/cli/sync-git/config-lane.ts` | 134–233: `CachedLocalCfg`, `gitConfigHash`, `shouldPublishGitConfig`, `readLocalGitConfig`, `configReceiver`, `sameConfigShape` | ~110 |
| `src/cli/sync-git/fingerprint.ts` | 1273–1487: filesystem tokenization + git fingerprint construction/trust + `GIT_FINGERPRINT_VERSION` / `gitFingerprintVersionForBounds` / `GitConfigWireBounds` (version derivation stays WITH the token code it versions) | ~310 |
| `src/cli/sync-git/divergence-cache.ts` | 1087–1272 cache schema/persistence/fast source, 1489–1755 probe build/classify/write/refresh | ~420 |
| `src/cli/sync-git/apply.ts` | 1756–2342: `applyGitSections`, apply metrics + `formatGitApplyMetrics`, config-lane transactions, conflict preservation, scheduler | ~590 |
| `src/cli/sync-git/status.ts` | 2343–2513: `gitDivergenceStatus`, `gitDivergenceCount` | ~175 |
| `src/cli/sync-git.ts` (barrel) | re-exports today's exact export list | ~40 |

The three module-global log-once `Set`s (today 85–92) are shared by plan and
apply: they move to `plan.ts` and are imported by `apply.ts` (single instance
preserved — see §5 gate).

Tests: `git-sync.test.ts`, `sync-git-config-push.test.ts`,
`sync-git-config-pull.test.ts` → `src/cli/sync-git/` (imports fixed one
level). `git-config-sync.e2e.test.ts` and `apply-stats-format.test.ts` stay
(multi-subject: they also import `sync.ts`).

### 2.2 `daemon.ts` → `src/cli/daemon/`

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/daemon/policy.ts` | `DaemonChainRepairPolicy`, `classifyWatcherError`, `TrustState`/`worseTrust`, `daemonConsumesWakeup`, `Wants`, `reconnectDelayMs`, `nextSafetyDelay`, `jitter`, cadence/retrust/WS constants | ~200 |
| `src/cli/daemon/render.ts` | `scanStatsLine`, `summarizeActions`, `cleanPath`, `LOG_PATHS_MAX`, `log` | ~80 |
| `src/cli/daemon/daemon.ts` | `RboxDaemon` + `runDaemon` + `OpenDriftAudit` + `RboxBarAmbientStatus` | ~1,720 ⚠ (§2.7) |
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
| `src/cli/sync/format.ts` | 135–171: all `fmt*`/`format*` render helpers + `ScanDetails` (flag registry stays in `policy.ts`; this file is rendering only) | ~60 |
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
| `src/engine/crypto-worker-files.ts` | 188–227: `isCompiledRuntime`, `embeddedWorkerFile`, `workerSpecifier`, `cleanupEmbeddedWorker`, `MODULE_DIR`. **Stays at `src/engine/` level** so `path.join(MODULE_DIR, "crypto-worker.ts")` and `import("./generated/crypto-worker.bundle.js")` keep their exact relative depth — zero path rewrites in the compiled-binary-sensitive code | ~55 |
| `src/engine/crypto-pool/config.ts` | 29–50 constants, 85–96 env parsing, 145–186 `configuredWorkers`/`fileDescriptorWorkerCap`/`minJobs` | ~90 |
| `src/engine/crypto-pool/errors.ts` | 229–258: `rehydrateError`, `workerCrashError`, `closeError`, `streamCancelledError` | ~35 |
| `src/engine/crypto-pool/budget.ts` | 98–143: ciphertext contracts, `CiphertextBudget`, fused-job record types | ~55 |
| `src/engine/crypto-pool/slot.ts` | 260–336: `CryptoWorkerSlot` | ~80 |
| `src/engine/crypto-pool/pool.ts` | 338–1059: `CryptoPool`, process registry (`activePool`, `poolScope`, counters, `selectCryptoPool`, `withCryptoPool`, `shutdownCryptoPool`, `cryptoPoolStatus`, `__cryptoPoolTestHooks`) — registry state stays WITH the class it registers | ~660 ⚠ (§2.7) |
| `src/engine/crypto-pool.ts` (barrel) | re-exports today's export list (serves `engine/index.ts` unchanged) | ~15 |

Tests: `crypto-pool.test.ts`, `crypto-fused.test.ts` →
`src/engine/crypto-pool/`. `crypto-pool-exit.test.ts` + fixture stay (they
exercise via the fixture/barrel).

### 2.5 `e2ee-remote.ts` → types split (minimal)

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/e2ee-remote-types.ts` | 95–184 contracts (`E2eeApi`, DTOs, `PinStore`, `HeadPin`, `E2eeContext`, `CurrentWriteKek`, `VersionInfo`, `VerifiedSuffixEntry`, `CommitChainResult`) + 42–92 (`SIDECAR_THRESHOLD`, `blobRefsForManifest`, `mdeWriteCaps`) | ~150 |
| `src/cli/e2ee-remote.ts` | `E2eeRemote` class; re-exports the types so `remote/api.ts`, `remote/commits.ts`, `remote/keys.ts`, `e2ee-fake-server.ts` don't ripple | ~870 ⚠ (§2.7) |

This deliberately does NOT split the class (see §2.7). The types split still
matters: it lets `remote/*` and the fake server depend on contracts without
the 870-line implementation in their import graph.

### 2.6 `blob-batch.ts` → `src/cli/remote/blob-batch/`

| New file | Owns | ~Lines |
|---|---|---|
| `src/cli/remote/blob-batch/wire.ts` | 13–101 constants + models, 135–207 `parseBatchFrames`, 952–984 codecs (`framedBytes`, `parseBatchPutResponse`, `parseStatus`) — the client half of the wire contract with `apps/api/src/blob-batch.ts`, in one place | ~210 |
| `src/cli/remote/blob-batch/gate.ts` | 103–133: process kill-switch flags, `dispatchCount` + getters/reset, `SingleGate`, `resetBatchBlobStateForTests` — single module = single instance for both classes | ~40 |
| `src/cli/remote/blob-batch/config.ts` | 923–950: `BatchConfig`, `readBatchConfig`, `envIntFirst`, `uploadBatchConfig`, `downloadBatchConfig` + slot constants | ~60 |
| `src/cli/remote/blob-batch/downloader.ts` | 209–570: `BlobBatchDownloader` | ~370 |
| `src/cli/remote/blob-batch/uploader.ts` | 573–920: `BlobBatchUploader` | ~360 |
| `src/cli/remote/blob-batch.ts` (barrel) | re-exports today's export list | ~15 |

Test: `blob-batch.test.ts` → `src/cli/remote/blob-batch/`.

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
- **`CryptoPool`** + its process registry: slots and pool are bidirectionally
  coupled (crash/freed callbacks, in-flight flags); the fused lane is one
  scheduler. Registry functions stay with the class.
- **`E2eeRemote`**: `verifiedHead`/`refreshAccount`/`pinFrom`/
  `retainedSegmentEndingAtHead` jointly implement ordering-sensitive
  anti-rollback; `commit` and `decodeManifestAt` close over shared KEK/pin/LRU
  state. Phase-B candidate (chain-reader vs commit-writer delegates), not now.
- **`applyGitSections`** (~480 lines incl. helpers): apply helpers mutate
  shared `applied`/`pending`/`removedMem`/`configLane` maps; `pack()` depends
  on all of them. Moves as one unit into `sync-git/apply.ts`.

Post-plan sizes of the six paths: sync-git.ts 2,513→40 (dir max 880),
daemon.ts 2,003→20 (dir max 1,720), sync.ts 1,112→30 (dir max 590),
crypto-pool.ts 1,059→15 (dir max 660), e2ee-remote.ts 1,021→870,
blob-batch.ts 984→15 (dir max 370).

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
| **2** | **2a** sync-git split | `src/cli/sync-git.ts` → dir + 3 tests | 2a, 2b in any order |
| | **2b** daemon satellite split | `src/cli/daemon.ts` → dir + 7 tests | |
| **3** | **3a** sync split (single agent) | `src/cli/sync.ts` → dir + 4 tests | after 2a merged |
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
  relative-specifier fixes for imports AND `mock.module("../engine/…")`
  paths.

---

## 5. Verification gates

Per move-wave PR (all must pass before merge):

1. `bun test ./src/` — full suite, not just moved tests (repo baseline:
   currently green on main).
2. `npm run typecheck` (root + apps/api project refs).
3. **Rename-detection gate:** `git diff --find-renames main...HEAD --stat`
   must show every carved module as a rename/copy from its giant; hunks that
   are not pure renames may contain ONLY import/export lines and barrel
   files. Reviewer greps the diff for any non-import logic line.
4. **Single-instance gate** (waves 1a, 2a): module-level mutable state that
   moved (`downloadDisabledForProcess`/`uploadDisabledForProcess`/
   `dispatchCount`/`SingleGate`; sync-git log-once sets; crypto-pool registry)
   exists in exactly one module — `grep -rn` for each declaration name across
   `src/` shows one definition site.
5. **Compiled-runtime smoke** (wave 1b mandatory, others cheap enough to run
   anyway): build the compiled binary (dev-install flow) and run the crypto
   smoke path (`crypto-smoke.ts` exercises `withCryptoPool`/
   `cryptoPoolStatus`) — proves worker artifact resolution
   (`$bunfs`/embedded bundle/`MODULE_DIR`) survived the move.
6. **Zero-behavior-diff spot checks:** on the local test rig
   (`npm run rig`), one full sync cycle + `rbox status` before/after the
   wave; compare forensic log lines and compact stat tokens byte-for-byte
   (the format strings are load-bearing — `files-first.test.ts` privacy test
   greps them). Daemon wave additionally: start/stop daemon, confirm
   `activity.json` schema unchanged.
7. Barrel-cycle gate: `bunx madge --circular src/ || true` equivalent (or a
   simple script) — no new cycles; specifically no internal module importing
   its own barrel.

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
   `crypto-worker-files.ts` at `src/engine/` (zero depth change) + gate 5.
2. **`sync/push.ts` carve-out** (wave 3): `pushManifest`/`runPushAttempt`
   close over module helpers and the process-global `firstPublishTiming`;
   try/finally arming coverage is an explicit review invariant. Pure moves
   only; the wave-3 agent is forbidden from "tidying" anything in this file.
3. **sync-git fingerprint/cache split** (wave 2a): `GIT_FINGERPRINT_VERSION`
   must stay derived-from-and-adjacent-to the token code (`fingerprint.ts`),
   or a drifted constant silently invalidates (or worse, wrongly trusts)
   every cached divergence probe. Log-once sets single-instance gate applies.
4. **blob-batch gate module** (wave 1a): kill-switch flags + `SingleGate` are
   process-wide negotiation state consumed by both classes; a second instance
   (e.g. duplicated declaration instead of shared import) breaks 404/405
   degradation. Gate 4 covers it.
5. **daemon barrel + dynamic imports** (wave 2b): `main-dispatch.ts` does
   `await import("./daemon.js")` and `daemon-scan-defer.test.ts` imports
   `RboxDaemon` dynamically; the barrel must preserve those specifiers, and
   moved tests must fix `mock.module` relative paths. Compiled-binary smoke
   (gate 5) proves the dynamic-import graph still bundles.

Known codex-analysis erratum (corrected here): the raw inventory claimed
`planGitSections` is imported by `sync-recovery.ts`; the actual edge is the
reverse (`sync-git.ts` imports `PER_FILE_UPLOAD_ATTEMPTS` from
`sync-recovery.ts`). The import graph in §1.1 is the verified one.
