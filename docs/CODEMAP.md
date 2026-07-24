# CODEMAP — module ownership

One line per module: what it OWNS, what it must NEVER own. This is the
structure map design 113 (§6) exists to produce — specs cite these lines
instead of re-deriving structure from line numbers.

**Maintenance rule (AGENTS.md):** any PR that adds a module under these
trees, or changes what a module owns, updates its line here in the same PR.

Scope: the API Worker and sync engine — `apps/api/src/`, `src/cli/sync*`, `src/cli/daemon*`,
`src/cli/e2ee-remote*`, `src/cli/remote/`, `src/cli/publish-pipeline/`,
`src/cli/telemetry/`, `src/engine/`. Command files (`src/cli/*-cmd.ts`), dispatch, and UI helpers
are deliberately not mapped.

Barrels (`sync.ts`, `sync-git.ts`, `daemon.ts`, `crypto-pool.ts`,
`blob-batch.ts`, `remote.ts`, `git-state.ts`, the `index.ts` files) preserve
a stable public surface. Never: logic, state, or an export that isn't a
plain re-export. Internal modules never import their own barrel.

Files marked **§2.7** are named exceptions to the <600-line rule (single
closure/class over shared mutable state); carving them is a phase-B design
with its own review, never a move.

## `apps/api/src/` — API server Worker

```
apps/api/src/worker.ts — Worker entrypoint: fetch/scheduled/queue plumbing, ordered route dispatch, credential fast paths, route-template telemetry, token-kind gates, and CORS; exports WorkspaceSync/CachedReleases. Never: per-domain endpoint logic.
apps/api/src/routes/ — ordered thin HTTP method/path matchers over RouteCtx; delegates authenticated/public requests to domain modules. Never: domain policy, persistence, or protocol implementation.
apps/api/src/auth.ts + apps/api/src/auth/ — authentication/device lifecycle: bearer authentication, device/PAT minting, bootstrap, device-code, pairing, device/API-key/account-surface operations; auth.ts is the compatibility barrel. Never: route dispatch, billing, or E2EE key-material semantics.
apps/api/src/{billing,stripe,clerk,clerk-signin,plans}.ts — account commerce/identity integration: plan/quota policy, Stripe checkout/portal/webhooks/account repointing, Clerk JWT/web-session/user lifecycle, and sign-in-method projection. Never: blob storage or sync admission.
apps/api/src/blob*.ts + apps/api/src/pack-gc.ts — blob storage plane: single/multipart/batch/pack protocols, receipts-aware R2 reads/writes, pack inventory/tombstones, and pack garbage collection. Never: manifest/commit admission or account authentication.
apps/api/src/commit*.ts — commit-admission leaves: envelope parsing and ref-mode validation, sorted-refset delta/shadow classification, and quota/receipt/reference accounting. Never: Durable Object sequencing, route dispatch, or blob transfer.
apps/api/src/{account-delete,account-link,retention}.ts — account lifecycle: link/unlink/status, deletion grace and durable purge driving, and plan-based retention pruning. Never: authentication credential mechanics, billing-provider internals, or blob protocol serving.
apps/api/src/telemetry-ingest.ts — bounded fail-closed client telemetry and fleet sync-state envelope validation/normalization into low-cardinality Analytics Engine records. Never: client sync behavior or fleet alert policy.
apps/api/src/fleet-alerts.ts — persisted fleet drift/reporting-stopped alert evaluation, notification/resolution/renotification, and stale-alert pruning. Never: sync-state ingestion or sync decisions.
apps/api/src/metrics.ts — privacy-bounded server observability: operation spans, D1/R2/DO timings, commit/redeem/pack/batch phase records, and Analytics Engine emission. Never: feature/domain policy or raw identifiers in dimensions.
apps/api/src/util.ts — dependency-light Worker helpers: JSON responses, SHA/key formatting, constant-time comparison, hashing/HMAC, chunking, capped-body reads, and blob/pack/manifest object keys. Never: domain policy or persistence.
apps/api/src/db.ts — the single D1 routing seam between account-data (dbFor) and pre-account directory (dirDb) planes. Never: SQL queries or domain decisions.
apps/api/src/genesis-repair.ts — atomic-genesis tombstone observation, privileged repair/audit protocol, reconciliation, N=1 assertion, and shared mutation fences. Never: client cryptographic interpretation or command UX.
```

### Sanctioned cross-package protocol modules

The API Worker runtime's deliberate cross-package import boundary is limited to
`src/engine/{refset,pat-token,blob-pack,manifest-chain,manifest-validate,sha256-stream}.ts`.
All six modules are pinned in `apps/api/tsconfig.json`'s `include` as shared
wire-protocol code, not a layering violation. Any Worker import beyond this list
requires an explicit ownership/layering decision.

## `src/cli/sync/` — sync drivers (pull-then-push cycle)

```
src/cli/sync.ts               — barrel: pre-113-split public surface of sync/.
src/cli/sync/sync.ts          — sync(): one full cycle, pull then push, under the sync mutex. Never: per-phase logic.
src/cli/sync/pull.ts          — pull driver: scanManifestForPush, pull, applyPulledManifest (reconcile, two-phase ignore, mass-delete/trash safety, git apply, atomic state advance) + authenticated keep-mine publication-receipt reconciliation through full-head apply ordering, including caller-required uncached/unpruned scan mode. Never: push/commit logic, rendering, or adoption orchestration.
src/cli/sync/push.ts          — push retry orchestration (pushManifest) + single-attempt transaction (runPushAttempt) + recovery-page accumulation + stampManifestSchemaForCommit + synchronous keep-mine rider/result and transport-boundary receipt/409/accepted-ACK handling, including caller-required uncached/unpruned scan mode. Never: rendering, remote construction, pull-side apply policy, or adoption orchestration.
src/cli/sync/policy.ts        — sync policy & flags: filesFirstFlagEnabled, mass-delete trip predicates/constants, deferred-errno reporting, retry backoff, apiFor, scan/matcher adapters. Never: I/O drivers, rendering.
src/cli/sync/deps.ts          — SyncDeps injectable contract + cache/scan-stats/write-context wiring (withCache, withDircache, withReportScanStats, refreshWriteContext, CurrentWriteContext) + explicit full-scan request. Never: sync or adoption decisions.
src/cli/sync/format.ts        — compact stat/timing token rendering (formatCommitTimings, formatLatestTimings, formatApplyStats, formatScanStats). Format strings are load-bearing (privacy tests grep them). Never: state, I/O, policy.
```

## `src/cli/sync-git/` — git lane (capture, plan, apply, status)

```
src/cli/sync-git.ts                  — barrel: pre-113-split public surface of sync-git/.
src/cli/sync-git/shared.ts           — cross-lane orchestration policy (capture/apply concurrency, repo cap/path helpers, scope projection/carry matrix, log-once sets) + capture/locking primitives (chainLock, gitApplyMutationKey, nestedRepoChains, capturePlannedGitSection). SINGLE owner of the module-level state shared by plan AND apply. Never: plan or apply decisions themselves.
src/cli/sync-git/plan.ts             — push planner: planGitSections (§2.7 — one closure unit, helper order is semantic), pending-supersession candidate admission/final-proof flow, ephemeral keep-mine rider admission + typed disposition + final-report/pin execution, post-proof conflict-ref hygiene dispatch, plan contracts, push formatters, gitBaseAfterCommit, gitForceForMissingBlobs. Never: persisted resolution authority, apply-side mutation, status rendering.
src/cli/sync-git/pending-supersession.ts — design-174 pending admission gate plus final normalized candidate-vs-pending semantic proof. Never: clear pending/sidecars, publish a candidate, mutate refs, or grant BASE authority.
src/cli/sync-git/resolution-intent.ts — keep-mine preview binding plus preliminary/final directional discard reports, canonical report hashing, ephemeral rider contract, and lane authorization projection. Never: persist resolution authority/receipts, publish candidates, mutate refs, or grant BASE authority.
src/cli/sync-git/apply.ts            — pull-side git materialization: applyGitSections with uniform pending behavior, held-skip orchestration, post-settlement attempt-rebind dispatch, receiver-equivalent repo-key admission, exclusive-leaf apply metrics, config-lane transactions, conflict preservation, quarantine ordering. Never: keep-mine reservation or planning policy.
src/cli/sync-git/follow.ts           — design-116/126 checkout orchestration: artifact/index-equivalence staging guards, all-guard and breadcrumb-waiver classification, independent safe-ref publication, journaled checkout commit/recovery adapters, and follow leaf-timer plumbing. Never: ORIG_HEAD preservation mechanics, D4a journal/reachability/index/pin mechanics, or state-file persistence.
src/cli/sync-git/held-skip.ts        — design-174 stable held-attempt input observation, exact consulted-reflog binding, eligibility, safety-floor/kill-switch helpers, and batched generation-CAS attempt rebind after P/K settlement. Never: follow/ref mutation, BASE composition, or unrelated state persistence.
src/cli/sync-git/breadcrumb-veto.ts  — closed design-126/130 BreadcrumbVetoGate universe, exact total order, deferral mapping, and boot-bounded logVetoOnce. Never: gathering Git proof facts or deciding ref mutations.
src/cli/sync-git/tombstone-attestation.ts — strict wire-to-immutable §130 tombstone attestation conversion and mutation-boundary binding checks. Never: parsing Git artifacts from disk or performing ref mutations.
src/cli/sync-git/branch-transition.ts — typed non-checkout branch A/P/K transition planner and prepared expected-old executor. Never: checkout-plane HEAD/index changes, BASE composition, or tombstone authorization policy.
src/cli/sync-git/follower-protocol.ts — current-lineage artifact scan, logical-BASE overlay, foreign same-branch classification, and pre-ref-plane attestation orchestration. Never: ref mutation or BASE persistence.
src/cli/sync-git/orig-head.ts        — design-126 ORIG_HEAD preservation mechanics: exact no-follow read, valid-object recovery-ref planning/pruning, malformed-byte durable quarantine, worktree discriminator. Never: waiver eligibility/classification, journal/checkout commit, or state persistence.
src/cli/sync-git/git-deferral-json.ts — stable JSON projection of per-repo git deferral lanes, episode timestamps/ages, byte-change flag, and checkout shape for status/git commands. Never: deferral policy, persistence, or rendering.
src/cli/sync-git/deferral-hygiene.ts  — cause-aware durable deferral reprobe/classification, orchestration of the injected state-CAS recovery port, exact-episode generation-CAS clear/upgrade, and ephemeral lock display evidence. Never: ownership proof or lock deletion mechanics (state-cas-locks owns both), planner/apply decisions, or rendering.
src/cli/sync-git/state-cas-locks.ts   — design-178 state-CAS Git-lock ownership journal, exact marker acquisition/release, dead-owner classification, common-dir-fenced recovery, and post-recovery validation. Never: deferral persistence, apply proof policy, or generic workspace locking.
src/cli/sync-git/base-composer.ts    — design-130 pure mandatory BASE constructor: closed authority/witness model, branch provenance, safe-ref totality, mixed/terminal whole-family composition. Never: Git/artifact/state-file I/O, follower planning, or publisher normalization.
src/cli/sync-git/p-repair-state.ts   — composer-backed generation-CAS adapter for P-repair: changes only BASE[R] plus its P-bound typed receipt while retaining unrelated journal members. Never: Git/Q/pin mutation or tombstone authorization.
src/cli/sync-git/p-settlement.ts     — exact-P preflight settlement: prepared R/P/K verification, episode-reflog proof, composer-backed state CAS, then artifact retirement. Never: moved-P repair, tombstone authorization, or ordinary follow planning.
src/cli/sync-git/config-lane.ts      — config-lane capture model + receiver: CachedLocalCfg, gitConfigHash, shouldPublishGitConfig, readLocalGitConfig, configReceiver, sameConfigShape. Never: fingerprinting, apply transactions.
src/cli/sync-git/fingerprint.ts      — divergence fingerprint construction: stat/tree/index tokenization, racy-clean trust, GIT_FINGERPRINT_VERSION derivation (version MUST stay adjacent to the token code it versions — design 113 §8). Never: cache persistence, probing.
src/cli/sync-git/divergence-cache.ts — divergence cache schema/persistence + probe build/classify/write/refresh. Never: fingerprint token construction.
src/cli/sync-git/conflict-retention.ts — bounded refs/rbox-conflict reachability/age inspection and old-OID transactional pruning. Never: granting push carry/capture authority, deleting other namespaces, or state persistence.
src/cli/sync-git/status.ts           — read-only divergence and conflict-snapshot status: gitDivergenceStatus, gitDivergenceCount (mirrors planner suppressions). Never: mutation of repos, cache, or state.
```

## `src/cli/daemon/` — background daemon

```
src/cli/daemon.ts            — barrel: pre-113-split public surface of daemon/ (main-dispatch's dynamic import("./daemon.js") lands here).
src/cli/daemon/daemon.ts     — RboxDaemon (§2.7 — one state machine: pump single-flight, first-class halt recovery probes/fair service, reset-journal halt/recover/bootstrap, watcher trust/retrust, safety/deep scan cadence, adopt cache-generation observation/full-scan acknowledgement, push/pull drivers, retry fences, drift audits, activity/ambient-status persistence, WS channel, ownership wind-down) + runDaemon + class-coupled types. Never: reusable policy, adoption lifecycle mutation, or rendering (those live in siblings).
src/cli/daemon/key-delivery-fulfill.ts — design-189 daemon key-delivery fulfillment flight: exact fetch/submit wire validation, persisted release preference + crash journal, verified admin roster admission, committed-wrap adoption, bounded retry/timeout/drain, and WS-nudge parsing. Never: workspace sync pump/mutex work, login enrollment, server state-machine ownership, or new crypto primitives.
src/cli/daemon/policy.ts     — daemon policy, pure: recovery-probe selection/full-jitter/service bound, DaemonChainRepairPolicy, classifyWatcherError, TrustState/worseTrust, daemonConsumesWakeup, Wants, cadence/retrust/WS constants, reconnectDelayMs/nextSafetyDelay/jitter. Never: class state, I/O.
src/cli/daemon/reset-halt-policy.ts — pure bounded per-message LRU log gate and hourly reset-recovery retry constant. Never: daemon lifecycle state, journal inspection, or I/O.
src/cli/daemon/render.ts     — daemon log-line rendering: scanStatsLine, summarizeActions, path cleaning. Format strings are load-bearing. Never: state, decisions, sink ownership.
src/cli/daemon/logger.ts     — per-daemon synchronous dated-log ownership: append/rollover, crash-channel pointers/fallback, unlink recovery, and filename-date retention. Never: daemon sync state or reader/follow policy.
src/cli/daemon/ambient-status.ts — ambient daemon/prompt status contracts, validation, projection, and rendering over persisted runtime records. Never: writing daemon status or driving daemon state.
src/cli/daemon/ambient-status-writer.ts — best-effort atomic persistence/removal of ambient daemon status records. Never: status projection, rendering, or daemon decisions.
src/cli/daemon/watcher.ts    — native/chokidar watcher adapter, ignore filtering, settled-file batching, and isolated Git-ref signal debouncing. Never: daemon trust/retry policy or sync decisions.
src/cli/daemon/git-ref-watch.ts — Linux bounded Git-ref side-channel classification + GitRefWatchRegistry (§2.7 — one ownership/reconcile/backoff/close-fence state machine). Never: manifest/file-plane events, sync planning, safety cadence, or telemetry attribution.
src/cli/daemon/watcher-selftest.ts — compiled-release watcher and I/O-priority smoke probe with machine-readable exit codes. Never: production daemon orchestration.
src/cli/daemon/drift-audit.ts — watcher-drift measurement contracts, persistence, candidate diff/coverage/continuity classification, and bounded pending resolution. Never: scan scheduling, watcher trust policy, or telemetry emission.
```

## `src/cli/telemetry/` — opt-out operational telemetry

```
src/cli/telemetry/contract.ts — client/server telemetry wire schemas (including fixed sync-phase axes), numeric/enum domains, corpus buckets, fleet sync-state contract, and RBOX_TELEMETRY enablement. Never: queueing, transport, or measurement.
src/cli/telemetry/queue.ts — best-effort bounded in-memory sample coalescing/rings (including sync-phase), single-flight flush, backoff, rejection/drop handling, and TelemetryRecorder/Transport contracts. Never: producing measurements or sync-state summaries.
src/cli/telemetry/sync-state.ts — privacy-bounded fleet sync-state projection plus daemon change/heartbeat reporting with stable binding identity and serialized best-effort sends. Never: alert evaluation or sync-state mutation.
src/cli/telemetry/lane-accumulator.ts — AsyncLocalStorage-scoped per-push upload-lane byte/time/op accumulation and completion samples. Never: upload scheduling, transport selection, or network I/O.
src/cli/telemetry/sync-phase.ts — per-daemon independent pull/push cadence and tail sampling plus privacy-bounded PhaseReport projection. Never: sync execution, queue transport, or repo identifiers.
```

## `src/cli/` — sync-adjacent singles

```
src/cli/sync-mutex.ts         — the one workspace-wide sync mutex (acquire/release/withWorkspaceSyncMutex), global adopt-journal fence/recovery authority, invocation-local baseline continuation capability, degraded lock-unsupported fallback, and CLI vs daemon acquisition policy. Never: the lockfile primitive itself (engine/git/lockfile.ts) or adoption content/Git mutation.
src/cli/adopt-consent.ts      — opaque single-use adoption-consent witnesses bound to root/stream/workspace and their three affirmative routes. Never: prompting, inventory, or mutation.
src/cli/adopt-journal.ts      — versioned adoption protocol types, strict direct-path load/save/fence inspection, full no-follow identities, and retention path definitions. Never: lifecycle policy or namespace mutation.
src/cli/adopt-inventory.ts    — phase-0 no-follow source inventory, headroom inputs, mount/readability checks, and ordinary-vs-linked Git source admission. Never: journal publication or source movement.
src/cli/adopt-fs.ts           — dirfd-held no-follow traversal plus native no-replace rename and scaffold-directory primitives. Never: overlay disposition or lifecycle policy.
src/cli/adopt-git.ts          — retained-source exact-OID fetch-union, target scope/ownership/index gates, journaled branch CAS/index recovery, containment/incarnation checks, and Git abort inverses. Never: sync-engine classification, capture, reconcile, or BASE authority.
src/cli/adopt-overlay.ts      — ignore-independent B-driven per-leaf overlay, collision displacement/unplaced policy, closed move classification, and file abort inverses. Never: ordinary matcher/reconcile policy or Git administrative mutation.
src/cli/adopt-cache.ts        — adoption cache-class invalidation, durable workspace cache generation, and per-owner acknowledgement. Never: scanning, matcher construction, or daemon scheduling.
src/cli/adopt-lifecycle.ts    — phases 0–4 orchestration over journal/retain/baseline/Git/overlay/cache/finish hooks plus resume nonce refresh and abort sequencing. Never: sync-engine classification, reconcile, capture, or BASE authority.
src/cli/sync-recovery.ts      — within-attempt churn recovery for file blobs: encryptAndUpload (bounded per-file retry, address-cache reuse, defer-on-churn, design-98 pipeline routing, flag-gated serialized receipt-drainer wiring) + deferManifest/reportDeferred. Never: whole-attempt retry (sync/push.ts), encrypt/upload mechanics (engine + remote).
src/cli/config.ts             — explicit compatibility facade for workspace-config, sync-state-model, sync-state-store, and reset-state. Never: behavior, wildcard exports, filesystem I/O, validation, state projection, locking, or reset policy.
src/cli/workspace-config.ts   — machine-local workspace binding contract, trash normalization, stream identity, root discovery, typed config absence, and atomic secret-stripping workspace.json persistence. Never: credentials/keystore loading, sync-state persistence, reset authorization, or repository state.
src/cli/sync-state-model.ts   — durable sync-state/repository/deferral/packet contracts, manifest-meta validation, legacy-record migration, BASE/pending sanitization and record projection, plus shared counter normalization. Never: filesystem I/O, locks, journal recovery, telemetry identity creation, or reset policy.
src/cli/sync-state-store.ts   — state.json/incarnation-marker persistence, raw/stream-checked loads, generation-CAS publication, capable-lineage and telemetry initialization, restricted whole-state compatibility writes, and narrow held-lock reset marker/genesis operations. Never: reset consent, complete repository fencing, artifact preparation, or workspace config serialization.
src/cli/reset-state.ts        — complete-fence reset orchestration: repository inventory, checkout/A/P/Z preflight, P settlement/repair stabilization, consent rechecks, reset-journal preparation/recovery, and old-binding sidecar cleanup. Never: state/marker serialization, workspace config parsing, reset-journal durability, or consent semantics.
src/cli/sync-state.ts         — sync state-transition composition + CAS save (composeStateSavePacket, saveStateSource, episode-aware published-checkout recovery, config-lane state, daemonBindingMatches). Never: state-file persistence format (sync-state-store.ts owns saveState/applyStateSavePacket).
src/cli/reset-consent.ts      — design-138 opaque two-stage setup consent capabilities: stream-selecting tuple binding, create-result narrowing, fenced inspection, and single-use consumption. Never: prompting, remote creation, reset mutation, or durable authorization storage.
src/cli/reset-io.ts           — design-138 bounded reset reads/streams, hard byte counters, post-read identity verification, streaming hash/copy/equality, and dynamic parse-memory admission. Never: journal semantics, JSON schema policy, or reset phase decisions.
src/cli/reset-memory-benchmark.ts — design-138 JSON grammar flood-family measurement and admission-multiplier calibration. Never: production reset orchestration or filesystem mutation.
src/cli/reset-journal-classifier.ts — design-138 pure correlated journal-v2 physical row-table classifier and next recovery-action projection. Never: filesystem/Git I/O, mutation, or authorization minting.
src/cli/reset-journal.ts      — design-138 journal-v2 authorization validation, bounded physical observation, correlated-row recovery, candidate/archive/recovery-Z cutover, and deterministic retirement; legacy v1 halts. Never: ordinary BASE composition, consent minting, or P-repair policy.
src/cli/reset-halt-inspection.ts — read-only adapter from reset-journal inspection to daemon/status halt safety. Never: side-file writes, recovery, quarantine, or lifecycle transitions.
src/cli/reset-health.ts       — daemon-owned bounded atomic reset-halt health side-file contract and reader. Never: journal classification, status rendering, or non-daemon writes.
src/cli/reset-quarantine.ts   — design-138 fenced crash-resumable reset quarantine/restore bundles, manifest inventory, durable COMMITTED publication, and inert-first/journal-last restore. Never: doctor CLI policy, daemon healing, or deterministic recovery-ref deletion.
src/cli/reset-journal-doctor.ts — doctor reset-journal pre-state dispatch, complete-fence reinspection, quarantine eligibility, and restore orchestration. Never: daemon lifecycle, ordinary doctor collection, or unfenced reset mutation.
src/cli/daemon-control.ts     — compatibility facade for the established daemon-control API. Never: behavior, state formats, process policy, or log consumption.
src/cli/daemon/runtime-state.ts — daemon runtime filesystem state: binding/pid formats and records, workspace identity, incarnation key, lifecycle state mutations, whole-runtime removal. Never: process inspection/signalling, mode policy, or log consumption.
src/cli/daemon/process-control.ts — daemon process lifecycle: spawn/start/stop, liveness/PID ownership, mode admission/witnesses, spawn crash-sink preparation. Never: record serialization, the daemon sync loop, or log consumption.
src/cli/daemon/log-reader.ts  — daemon log discovery, bounded tails, chronological merging, and lifecycle-pinned follow. Never: process control or runtime-state mutation.
src/cli/git-cmd.ts            — compatibility facade for the git command surface. Never: behavior.
src/cli/git/deferrals-command.ts — `rbox git deferrals` projection, remediation copy, resolve-offer policy. Never: resolution transactions or presentation bodies.
src/cli/git/resolve-command.ts — `rbox git resolve` snapshot/confirm/discard workflow, manual-protocol preflight/settlement, refusal semantics. Never: deferrals policy or output formatting bodies.
src/cli/git/resolve-presentation.ts — resolve output rendering, human/JSON emission, root scrubbing. Never: state machines or filesystem access.
src/cli/upload-lane-timing.ts — push-side timing instrumentation: the process-global firstPublishTiming singleton (SINGLE definition site), uploadLaneTiming + batch-dispatch/pack-lane telemetry accumulators, overlap math, summary formatters. Never: network or file I/O.
src/cli/push-tail-timing.ts — AsyncLocalStorage-scoped missing/commit chunk timing and exact request-payload byte accumulation for one complete push retry loop. Never: retry, request, or upload policy.
src/cli/e2ee-remote.ts        — E2eeRemote (§2.7 — ordering-sensitive anti-rollback): verified head + pins, manifest fetch/decrypt/fold, history/restore/suffix/rebaseline, commit orchestration, blob delegation, KEK cache + its implementation policy (sidecar threshold, write-caps, manifest blob traversal). Never: raw HTTP (remote/), crypto primitives (engine/e2ee), pure contracts (e2ee-remote-types.ts).
src/cli/e2ee-remote-types.ts  — pure shared contracts: E2eeApi, AccountKeysDTO, WsKeyDTO, CommitChainResult, VersionInfo, VerifiedSuffixEntry, HeadPin, PinStore, E2eeContext, CurrentWriteKek. Never: behavior, policy constants.
src/cli/e2ee-client.ts        — atomic genesis orchestration, verified enrollment classification consumption, exact-attempt replay/completion, plus pairing/recovery/web-delivery admission glue. Never: raw HTTP transport or generic workspace sync policy.
src/cli/login-attempt-journal.ts — design-189 pre-account login key staging, request-bound ownership/resume, persisted-before-ACK checkpointing, and TTL terminalization. Never: genesis artifact classification, server transport, or roster construction.
src/cli/genesis-durable.ts    — hardened genesis artifact writer, staged RK, journal phases, completion intent, RETARGET witness, and byte-bound local enrollment-witness schemas. Never: server observation classification or command UX.
src/cli/genesis-locks.ts      — non-materializing global/account genesis lock namespaces and global-to-account acquisition order. Never: enrollment classification or credential mutation.
src/cli/genesis-quarantine.ts — manifest-first, hash-checked repaired-legacy and abandoned-attempt archival with durable terminal markers. Never: deciding whether quarantine is authorized.
src/cli/genesis-enrollment.ts — strict pending-artifact inspection and the shared crypto-backed closed enrollment classifier. Never: transport or interactive completion choices.
src/cli/genesis-seam.ts       — thin injectable design-179 adapter over design-180 global→account locking, classification, staged-RK, completion-intent, RETARGET, receipt, and cleanup APIs; lower-level proofs are scoped to the held lock. Never: independent genesis state, fallback production behavior, or command UX.
```

## `src/cli/remote/` — HTTP transport to the API worker

```
src/cli/remote.ts                — barrel: stable import surface for the remote/ control-plane client.
src/cli/remote/api.ts            — RboxApi facade (implements SyncRemote) + the SyncRemote interface: wires RemoteContext + blobs/commits/keys/batch modules into the surface sync depends on. Never: HTTP/crypto details (sibling domain modules).
src/cli/remote/context.ts        — shared transport core: RemoteContext (base URL, auth token, ws/project ids, auth headers, upload-receipts accumulator, download/upload-grant caches (§27/§109), fetch/postJson/missingBlobs primitives). Never: domain-specific endpoints.
src/cli/remote/auth-command-wire.ts — exact raw-fetch compatibility wire for legacy auth commands (device start/poll/bootstrap, delivery ACK, approve/list/revoke, pair creation); returns raw Response with no retry/translation. Never: prompting, persistence, response policy, enrollment, or RemoteContext.
src/cli/remote/blobs.ts          — single-blob PUT/GET transport (putBlob, getBlob, getBlobToFile), single-vs-multipart threshold, download integrity re-fetch. Never: multipart mechanics (multipart.ts), batch scheduling (blob-batch/).
src/cli/remote/commits.ts        — manifest/commit transport: commit/commitSigned/commitsSince/latest/commitTimes/redeemReceipts + CommitRejectedError/CommitOptions/CommitTimings, with push-tail request timing hooks. Never: blob transfer, key/roster crypto.
src/cli/remote/keys.ts           — E2EE key/pairing/device-admission transport (bootstrapKeys, account/device/workspace key endpoints, roster append, API-key CRUD). Never: verifying or interpreting the crypto material (engine/e2ee + e2ee-client.ts).
src/cli/remote/multipart.ts      — resumable multipart blob upload: init/part/complete attempt loop, resume-token files, mismatch/retry-later/quota recovery. Never: streaming primitives (stream.ts), metrics (multipart-metrics.ts).
src/cli/remote/multipart-metrics.ts — multipart upload metrics (MultipartMetrics distributions + summary formatting). Never: performing uploads.
src/cli/remote/errors.ts         — typed remote-error classes + classification/translation (NetworkError, QuotaExceededError, BlobShaMismatchError, isRetryLater, translateRemoteError, …). Never: network calls.
src/cli/remote/resilient.ts      — network-resilience mechanics: transient-fault classification, fetchResilient (abort deadline + bounded retry), transfer timeout sizing, envInt. Never: retrying HTTP 4xx/5xx responses (returned untouched for typed handling).
src/cli/remote/stream.ts         — leaf I/O helpers: fileStream (ReadableStream over a file/range), readJson. Never: business logic.
src/cli/remote/timings.ts        — defensive parser readNumericFields for numbers-only server-timing payloads. Pure. Never: I/O.
src/cli/remote/multipart-fake-server.ts — test-only in-process fake of the server multipart protocol (mirrors apps/api/src/blobs.ts part sizing) with injectable latency/failure. Never: production use.
```

## `src/cli/remote/blob-batch/` — batched blob transfer

```
src/cli/remote/blob-batch.ts            — barrel: pre-113-split public surface of blob-batch/.
src/cli/remote/blob-batch/wire.ts       — client half of the wire contract with apps/api/src/blob-batch.ts: framing constants, BatchFrame, parseBatchFrames, codecs (framedBytes, parseStatus, parseBatchPutResponse). Change in lockstep with the server twin. Never: tuning knobs, scheduling.
src/cli/remote/blob-batch/gate.ts       — process-wide batch/pack kill switches + pack-latch subscriber fanout + monotonic records ceiling + dispatch counter + SingleGate + shared UploadSlotArbiter. SINGLE definition site for upload permit accounting and process-wide degradation (a second instance breaks concurrency/degradation). Never: per-request logic.
src/cli/remote/blob-batch/config.ts     — all tuning defaults/caps + fill/pack policy selectors + wire-cap constants + BatchConfig/PackConfig + RBOX_BATCH_*/RBOX_PACK_* env readers (uploadBatchConfig/downloadBatchConfig/packUploadConfig) + pack fill constants. Never: wire framing constants, class logic.
src/cli/remote/blob-batch/downloader.ts — BlobBatchDownloader: queue/scheduler, batch GET, watchdog, single-lane degradation, race-safe publication + its private models. Never: upload logic, wire codecs.
src/cli/remote/blob-batch/uploader.ts   — BlobBatchUploader: SHA coalescing, fill-v1/v2 dispatch policy, pack-vs-batch routing under one arbiter, batch PUT, 400 skew-latch trigger (ceiling lives in gate.ts), receipt accounting, degradation, close protocol + its private models. Never: pack framing, download logic, wire codecs.
src/cli/remote/blob-batch/packer.ts     — streaming temp-file rbox-pack-v1 construction + whole-pack hashing and size assertions. Never: network dispatch, queue policy, server auth.
src/cli/remote/blob-batch/pack-uploader.ts — BlobPackUploader: activation/fill/carving, pack PUT scheduling, pack-only degradation, waiter ownership transfer, receipt settlement, pack telemetry recording + temp cleanup. Never: batch grant refresh/auth policy, pack binary encoding, download logic.
```

## `src/cli/publish-pipeline/` — overlapped first-publish (design 98)

```
src/cli/publish-pipeline/pipeline.ts        — runPublishPipeline: producer-consumer graph (dynamic encrypt lane, rolling missingBlobs batching, budgeted upload scheduler) under one abort scope; flag-gated alternative to the serialized path in sync-recovery.ts. Never: leaf helpers (shared.ts), transport.
src/cli/publish-pipeline/budget.ts          — ResourceBudget: generic FIFO-fair reservation/release counter (items/bytes/heap axes). Pure concurrency primitive. Never: domain knowledge of blobs/uploads.
src/cli/publish-pipeline/ready-queue.ts     — ReadyQueue: budgeted producer→consumer channel of ready ciphertexts (backpressure, EOF, disposition-gated release). Never: encryption or upload themselves.
src/cli/publish-pipeline/receipt-drainer.ts — ReceiptDrainer + its shared threshold default: single-flight, generation-safe, error-latched mid-upload receipt redemption and backpressure waiting over a ReceiptPort abstraction. Never: the HTTP transport directly.
src/cli/publish-pipeline/shared.ts          — leaf helpers shared by the serialized path AND the pipeline (cipher-descriptor mapping, classifyCacheHit, churn/error helpers, concurrency clamps, lease materialization). Never: importing sync-recovery.ts (keeps the graph acyclic).
src/cli/publish-pipeline/stale-temp.ts      — stale enc-* temp-dir reclamation at push start (reclaimStaleTemps, createRunTempDir) under the sync mutex. Best-effort. Never: correctness-bearing state.
```

## `src/engine/` — workspace engine (scan/diff/reconcile/apply/crypto)

```
src/engine/index.ts                 — barrel: the full public engine API for src/cli. Never: logic.
src/engine/types.ts                 — core types only: FileEntry, FileType, Manifest, GitSection/GitArtifactRef/GitPackLink/GitRefScope. Never: logic, I/O.
src/engine/manifest.ts              — the filesystem scan producer: scanManifest (ignore rules + dircache/hashcache reuse), applyWatchEvents, ScanStats, present-vs-absent error classification. Owns "what's on disk" → manifest. Never: diffing, wire encoding.
src/engine/apply-receipt.ts         — applied-manifest oracle + shared receiver-equivalence probe/key helpers: lazy derived/persisted per-repo receipt proof, token-first re-proof, scoped inventory/hash widening. Never: Git follow decisions or workspace-wide per-repo scans.
src/engine/manifest-delta.ts        — manifest wire envelope codec: canonical (JCS float-tolerant) manifest hashing, snapshot/delta envelopes, delta ops diff/fold, ManifestChainError. Owns the on-wire manifest format. Never: scanning.
src/engine/manifest-chain.ts        — pure validator: readManifestChain bounds/validates a manifest's delta chain. Never: I/O.
src/engine/manifest-validate.ts     — dependency-free (no node:*) manifest/path/git-section validation shared by client AND Worker (isSafeRelPath, validateManifest, validateGitSection, schema/size constants). Pure string logic — must stay bundleable into the Worker.
src/engine/diff.ts                  — pure manifest diffing: diffManifests, sameContent (content identity: hash/type/symlink/mode; deliberately mtime-insensitive). Never: I/O.
src/engine/reconcile.ts             — pure three-way reconcile (local/remote/base → Action[]), conflictName. Decides WHAT changes. Never: filesystem mutation (apply.ts).
src/engine/apply.ts                 — applies Actions to the working tree (write/delete/conflict, blob upload/download orchestration): applyActions, restoreEntryToPath, uploadManifestBlobs. Never: content addressing, encryption itself (crypto/crypto-pool), stats accumulation (apply-stats.ts).
src/engine/mutation-gate.ts          — process-local synchronous shutdown admission gate, mutation leases, irreversible-boundary arbitration, and drain registry. Never: daemon signals/status persistence or filesystem mutation itself.
src/engine/apply-stats.ts           — process-global apply syscall/timing counters (valid under the single sync mutex). Pure accumulator. Never: I/O decisions.
src/engine/blobstore.ts             — BlobStore interface + LocalBlobStore (sha256 content-addressed local backend). Never: encryption, manifest logic.
src/engine/blob-pack.ts             — dependency-free locked rbox-pack-v1 structural codec shared by client + Worker. Never: hashing (callers hash directories, members, and whole packs).
src/engine/hash.ts                  — sha256 of files/bytes via node:crypto (client-side hashing primitive). Never: caching (hashcache.ts).
src/engine/sha256-stream.ts         — pure-JS streaming SHA-256 for the workerd runtime ONLY (client uses hash.ts). Never: node:crypto.
src/engine/hashcache.ts             — persistent (mtime,size,ctime)→sha256 cache (.rbox/state/hashcache.json). Safe to discard. Never: authoritative identity.
src/engine/dircache.ts              — persistent per-directory-listing cache driving scan pruning/racy-clean reuse. Owns its cache-correctness invariants. Never: the scan walk itself (manifest.ts).
src/engine/encrypt-address-cache.ts — persistent plaintext→ciphertext-address cache scoped per account/workspace/epoch. Never: encryption itself.
src/engine/ignore.ts                — ignore-rule engine: BUILTIN_IGNORE/HARD_PRUNE_DIRS, .rboxignore support, buildIgnoreMatcher, and the pure watcher-only Git-ref signal predicate. Owns what never syncs. Never: the walk.
src/engine/crypto.ts                — convergent per-blob AES-256-GCM encrypt/decrypt (design 12), KEK generation/phrase encode, zstd, inline + temp-file encrypt/decrypt paths. Never: pool orchestration (crypto-pool/), key wrapping (e2ee/keys.ts).
src/engine/fsutil.ts                — filesystem safety primitives: writeFileAtomic, fsyncDirectory, safe plain-directory-chain creation/ancestor publication, assertWithinRoot, RBOX_TMP_PREFIX. Never: domain logic.
src/engine/pool.ts                  — generic bounded-concurrency poolMap (fail-fast). Never: crypto-pool specifics.
src/engine/trash.ts                 — local trash tier: atomic rename soft-delete, prune/list/restore, cross-process .active marker. Owns "never destroy bytes on apply". Never: the decision to delete (reconcile.ts).
src/engine/phase-report.ts          — pure per-run phase timing/byte accumulator, no PII by construction. Never: emission I/O (caller owns).
src/engine/git-discover.ts          — ignore-pruned walk finding every nested git repo (dir or pointer). Never: repo-boundary stops, symlink following.
src/engine/git-state.ts             — barrel: stable git-state API over git/* + validate helpers. Never: implementation.
src/engine/detect.ts                — pure ecosystem/package-manager detection for hydration (fixed in-binary allowlist). Never: disk I/O, execution.
src/engine/doctor.ts                — pure host-vs-project readiness judging for hydration. Never: tool probing/execution (caller's job).
src/engine/darwin-bulk-walk.ts      — macOS-only bulk directory enumeration (bun:ffi getattrlistbulk) scan fast path. Never: fallback logic (caller falls back).
src/engine/encoding.ts              — base64url encode/decode. Pure leaf. Never: dependencies.
src/engine/pat-token.ts             — personal-access-token generate/validate (+CRC32). Self-contained. Never: transport.
src/engine/refset.ts                — dependency-free binary codec for the rbox-refset-v1 sidecar (locked format; bundles into client + Worker). Never: hashing (caller hashes).
```

## `src/engine/crypto-pool/` — worker-based crypto pool

```
src/engine/crypto-pool.ts           — barrel: pre-113-split public surface of crypto-pool/ (serves engine/index.ts unchanged).
src/engine/crypto-pool/pool.ts      — CryptoPool + CryptoWorkerSlot (§2.7 — bidirectionally coupled; a slot/pool file split is an import cycle by construction, REVIEW-113 HIGH 1) + process-wide registry/selection (selectCryptoPool, withCryptoPool, shutdownCryptoPool, cryptoPoolStatus, test hooks) + kekFingerprint. Never: worker artifact resolution (crypto-worker-files.ts), sizing config (config.ts), the algorithm (crypto.ts), the worker body (crypto-worker.ts).
src/engine/crypto-pool/config.ts    — operating constants, env parsing, worker sizing (configuredWorkers + its cache, fileDescriptorWorkerCap, minJobs). Owns configuredWorkersCache (permitted test reset lives here). Never: pool state/scheduling, worker paths.
src/engine/crypto-pool/budget.ts    — ciphertext contracts + CiphertextBudget (reserve/convert/release/wait) + fused-job record types. Never: worker spawning, I/O.
src/engine/crypto-pool/errors.ts    — worker-boundary error (de)serialization: rehydrateError, workerCrashError, closeError, streamCancelledError. Pure. Never: state.
src/engine/crypto-worker-files.ts   — worker artifact resolution (embeddedWorkerFile, workerSpecifier, cleanupEmbeddedWorker) + the embedded-worker mutable state it closes over. Lives at src/engine/ level ON PURPOSE: MODULE_DIR-relative lookup and the generated-bundle import are depth- and compiled-runtime ($bunfs) sensitive — never move into crypto-pool/. Never: pool logic, protocol.
src/engine/crypto-worker-protocol.ts — types only: the pool↔worker postMessage wire protocol + SerializedError + FUSE_MAX_FILE_BYTES. Never: logic.
src/engine/crypto-worker.ts         — the worker-thread entrypoint: receives protocol messages, calls crypto.ts inline paths, serializes errors back. Never: main-thread scheduling.
```

## `src/engine/e2ee/` — end-to-end-encryption primitives & session logic

```
src/engine/e2ee/index.ts          — barrel: the E2EE public surface for src/cli. Never: logic.
src/engine/e2ee/primitives.ts     — WebCrypto-backed low-level primitives shared by Bun client and Workers (randomBytes, hex, sha256, hkdf, aesGcm, ctEqual). Pure, runtime-portable. Never: node:-only APIs.
src/engine/e2ee/jcs.ts            — RFC 8785 canonical JSON (canonicalize, parseStrict). Consensus-critical byte-identical encoding for every signed object; rejects floats/NaN/bigint on purpose. Never: I/O.
src/engine/e2ee/asym.ts           — asymmetric primitives on node:crypto: Ed25519 sign/verify (+from-seed), RSA-OAEP-3072 wrap/unwrap, PKCS8/SPKI codecs. Never: object formats (commit/roster/epoch).
src/engine/e2ee/keys.ts           — key hierarchy + wrap wire formats: WrapContext, AES-GCM/RSA wraps, MK/KEK generation, wrapHash. Never: blob-level key derivation (crypto.ts), manifest keys (manifest-crypto.ts).
src/engine/e2ee/manifest-crypto.ts — manifest-specific encryption (own HKDF domain, fresh nonce per commit): deriveManifestKey, encryptManifest, decryptManifest. Never: blob content encryption.
src/engine/e2ee/commit.ts         — signed hash-chained commit codec: buildSignedCommit, parseCommit, verifyCommitSig, validateManifestChain, validateBlobRefset. Owns the signed-commit wire shape. Never: chain-walk verification (session.ts).
src/engine/e2ee/roster.ts         — signed, versioned, hash-chained device roster (trust root for commit signatures): builders + verifyRosterChain + activeSigners. Never: transport.
src/engine/e2ee/epoch.ts          — account key-state / epoch transitions: AccountKeyState, buildKeyState, verifyKeyStateChain (genesis trust root, revocation rotation). Never: roster internals.
src/engine/e2ee/recovery.ts       — BIP39 recovery-phrase codec + recovery-key derivation (rkToPhrase/phraseToRk, rkWrapKey, recoverySignKeyPair). Never: the BIP39 PBKDF2 seed function.
src/engine/e2ee/bip39-wordlist.ts — data only: the fixed 2048-word BIP39 list, index-is-value, never reorder. Never: logic.
src/engine/e2ee/session.ts        — top-level E2EE orchestration composing all of the above (bootstrapAccount, buildCommit, verifyAccount, verifyCommitChain, pairing/admission/redeem, recoverMasterKey). Pure logic over data + secrets. Never: network or filesystem (src/cli wires those).
```

## `src/engine/git/` — git-native repo state capture/apply

```
src/engine/git/shared.ts      — dependency root for git/*: git spawn wrappers (git/gitRaw/gitOk/gitWithIndexFile, including stdin + non-retaining streamed stdout), safe regular-file reads, RepoCtx/detectGitKind, generic reflog reads, worktree listing, importGitPackChain, gitSectionTips/BlobRefs/PackLinks, GitChainTimings. Never: policy.
src/engine/git/preflight.ts   — decides whether a repo's shape is syncable (dir vs pointer, worktrees, alternates, submodule superprojects, busy-check): gitPreflight, isGitBusy (structural vs transient refusal). Never: capture or apply.
src/engine/git/identity.ts    — stable plaintext-only identity of a repo's git state for change detection (gitIdentity, projectIdentity, gitIdentityKey), scope-aware. Never: the stored GitSection shape (types.ts).
src/engine/git/capture.ts     — git-native state capture (design 43): history bundles, index/HEAD/op-state snapshot, stable change identity, scratch-dir rooting/sweep, GitCaptureDeferredError. Owns "what to upload for a repo this cycle". Never: apply.
src/engine/git/apply.ts       — mutating git-state apply (design 43/130): fetch/decrypt/import pack chain, receiver-equivalent ref holds, NFF displacement pins, invoke state-supplied typed branch transitions and exact inverses, move index/op-state into place, quarantine + rollback on failure. Never: capture, lineage/BASE authority planning.
src/engine/git/quarantine.ts  — pre-mutation quarantine (bundle + index/op-state copy) + post-failure conflict preservation (quarantineLocal, quarantineAndWipeGitState, preserveGitConflict). Never: the apply itself.
src/engine/git/rollback.ts    — local pre-apply snapshot/restore of refs+HEAD+index+op-state+stash reflog (snapshotLocal, restoreLocal with pointer scoping and typed-transition exclusions). Never: quarantine policy or reconstructing branch-transition inverses.
src/engine/git/refs.ts        — low-level ref/op-state enumeration and restore (readAllRefs, listRefs, readOpState/restoreOpState). Pure plumbing wrappers. Never: policy.
src/engine/git/pins.ts        — scratch-ref pinning under refs/rbox-wip/* so bundles can reference unreachable commits (createScratchPins, pruneStaleScratchRefs). Never: bundle creation.
src/engine/git/containment.ts — single safety check: assertGitTargetWithinRoot (refuses targets escaping the workspace root, incl. via symlinks). Never: anything else.
src/engine/git/lockfile.ts    — generic cross-process advisory lockfile plus the shared lock-safety substrate: liveness/incarnation classification, no-follow exact observations, bounded-parent validation, common-directory identity fences, acquisition/release. Never: what a lock protects or journal recovery policy.
src/engine/git/config-sync.ts — pure (node-free, bundles into Worker) grammar/projection/canonicalization for git config sync (design 93): allowlisted keys, canonicalizeGitConfig, credential/value safety. Never: I/O.
src/engine/git/config-txn.ts  — transactional on-disk git config read/write: lockfile-guarded atomic apply, fault classification, orphan sweep. The stateful counterpart to config-sync.ts. Never: the grammar.
src/engine/git/index-identity.ts — semantic GitIndexIdentityV2 projection from a private index copy. Never: follow authorization or live-index mutation.
src/engine/git/reachability.ts — fail-closed single-tip and batched incoming-ownership/no-drop graph proofs plus full stash-reflog enumeration. Never: ref mutation or follow policy.
src/engine/git/journal.ts      — durable two-phase checkout journal write/mark/clear, exact-evidence lock recovery under the common-directory fence, and atomic old/new/third-value arbitration. Never: CLI state interpretation or checkout planning.
src/engine/git/checkout-txn.ts — prepared expected-old ref transaction + observation-bound journaled ref/HEAD/index-lock checkout commit and capability/boundary proof protocol. Never: classifier policy, recovery policy, or state saving.
src/engine/git/keep-pins.ts    — content-addressed recovery pins, strict bounded provenance sidecar, pin-first P-repair origin/cleanup primitives, and reflog-displacement discovery. Never: ref-plane classification or state composition.
src/engine/git/p-repair.ts     — pure bounded §130 P-repair Q schema/projection/hash constructor and BASE/reason disposition tables. Never: Git/state I/O, lock acquisition, or retry orchestration.
src/engine/git/p-repair-transaction.ts — §130 P-repair observation stabilization, cumulative Skeep pin/origin protocol, Q enumeration/eviction, prepared ref-side transaction, and dependency-injected state-CAS boundary. Never: tombstone authorization, checkout mutation, or inventing BASE authority outside the composer-backed state port.
src/engine/git/repo-lineage.ts — exact design-130 RepoIdentityV1/state-lineage byte encodings, realpath/stat construction, and hashes. Never: Git protocol artifacts or follower authority.
src/engine/git/base-artifacts.ts — strict design-130 A/P/K/Z protocol-ref payload, validation, capacity, immutable-tree, and A→Z transaction primitives. Never: follower authorization, state composition, P-repair/Q, reset, or lock orchestration.
src/engine/git/base-artifact-scan.ts — common-dir A/P/K namespace inventory, current-lineage strict classification, orphan-K detection, and foreign-lineage surfacing. Never: artifact creation/retirement or follower mutation decisions.
src/engine/git/protocol-locks.ts — §130/§138 lock-class ordering/tracing, canonical multi-common-dir complete recovery fences (operation→reflog→origin→git→state), held-class assertions, and the isolated post-HEAD compatibility exception. Never: mutation policy, Git transactions, or state composition.
```
