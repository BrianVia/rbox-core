# Note — decomposing `src/cli/daemon/daemon.ts`

Status: MEASURED, NOT IMPLEMENTED (2026-07-29). No code change shipped from this
pass. This note exists so the future cycle starts from a map instead of a scroll.

Measured against `origin/2.0` @ `672d6cad`.

## Verdict

`daemon.ts` cannot be retired from the `file-size.test.ts` allowlist by the
pure-move method that worked for 194 / 195 / 198 / 199 / 214. Those files were
collections of top-level functions; a function moves. This file is **one class**.

```
total                 3392 lines / 3215 nonblank / 154.5 KiB
  imports (1-157)      157 nb
  module level         154 nb   <- movable
  class RboxDaemon     2827 nb  <- 88% of the file, not movable
    (lines 323-3311, 300 members, largest method 140 nb)
  tail functions        77 nb   <- movable
```

Everything genuinely movable by a certifiable pure move totals **210 nonblank
lines — 6.5% of the file**. A facade PR doing all of it leaves `daemon.ts` at
~3005 nonblank: still 7.5x the 400-line hard limit, allowlist entry intact.
That is churn, not progress, so nothing was shipped.

Splitting the class is a real refactor — collaborator extraction with
constructor threading and changed state capture — not a move. It needs a design
doc and an adversarial review round of its own, queued behind U3.

### Why a class does not pure-move

Three mechanical blockers, each independently fatal to the move method:

1. **Private access.** Every candidate module would read `this.<field>` for
   fields that are `private`. Moving methods out of the class requires
   relaxing ~90 field declarations to `protected`/public, or building a
   ports object per module — both are edits, not moves.
2. **Cyclic call graph.** The member scan (below) shows the domains are
   mutually recursive: `connect` → `request` → `pump` → `runPumpOperation` →
   `writeAmbientStatus` → `localSettled` → scheduler getters, and back. A
   linear base-class chain cannot express that without declaring most of the
   ~120-method surface abstractly in the base — a hand-written mirror of the
   whole class, which is obfuscation, not decomposition.
3. **Constructor-assigned `readonly`.** ~25 fields are `readonly` and assigned
   in the constructor. TypeScript only permits that in the declaring class, so
   they and the constructor cannot be separated.

Design 214 also set the precedent explicitly: *"No new generic repository,
service, dependency-injection, or class layer."* An inheritance or mixin
scaffold introduced purely to satisfy a line count would be against it.

### The repo has already been doing this correctly

**This is not a proposal for a new approach — it is the existing one, mapped.**
Nine collaborators have already been carved out of this daemon, one per cycle,
each with its own design and its own contract or policy test:

| collaborator | contract test |
|---|---|
| `DaemonOperationScheduler` | `daemon-operation-scheduler.contract.test.ts` |
| `LocalWorkspaceObserver` + `LocalRetryQueue` | `local-workspace-observer.contract.test.ts` |
| `GitDiscoveryContinuity` | `git-discovery-continuity.contract.test.ts` |
| `PublishLocalWorkspaceTransition` | `daemon-publish-transition.contract.test.ts` |
| `ApplyRemoteWorkspaceTransition` | `daemon-pull-transition.contract.test.ts` |
| `LocalAuthority` | `local-observation-transition.contract.test.ts` |
| `DaemonChainRepairPolicy` | `daemon-chain-repair-policy.test.ts` |
| `ResetHaltLogGate` | `reset-halt-policy.test.ts` |
| `KeyDeliveryFulfillmentFlight` | `key-delivery-fulfill.test.ts` |

The remaining 2827 lines are the residue that has not had its cycle yet. The
seam map below **continues that cadence** — one domain per cycle, each landing
its own collaborator plus contract test. It is deliberately not a plan for a
big-bang rewrite, and no cycle in it should be merged as part of another.

The route to <=400 is more of the same, one domain at a time — not one big diff.

## Movable now (if a small PR is ever wanted)

210 nonblank across 6 leaf modules. Listed for completeness; **not** recommended
on its own.

| Module | Contents | nb |
|---|---|---:|
| `daemon-clocks.ts` | `GitBusyRetryClock`, `RecoveryProbeClock`, `CursorClock`, `ScanCadenceClock`, `DaemonShutdownClock` | 13 |
| `daemon-failure.ts` | `RecoveryProbePreflightError`, `RecoveryConditionPersistsError`, `ClassifiedOperationFailure`, `classifyOperationFailure` | 60 |
| `daemon-deferral-visibility.ts` | `GitDeferralLogSeen`, `projectedRepoRecords`, `durableGitDeferralLines` (already has `daemon-deferral-visibility.test.ts`) | 46 |
| `daemon-op-provenance.ts` | `PushProvenance`, `gitCaptureSampleForProvenance`, `Carrier`, `CARRIER_PRECEDENCE`, `ScanCoverage` | 10 |
| `daemon-scan-admission.ts` | `caseCollisionEventsRequireScan` (already has `daemon-case-collision.test.ts`) | 16 |
| `daemon-drift-window.ts` | `OpenDriftAudit` | 24 |
| `daemon-shutdown-handler.ts` | `createDaemonShutdownHandler` | 41 |

`classifyOperationFailure` is the only method in the class body with **zero**
`this` references — the sole in-class pure-move candidate out of 300 members.

`runDaemon` (34 nb) is deliberately excluded: it constructs `RboxDaemon`, so
moving it creates a `daemon.ts` -> `daemon-entry.ts` -> `daemon.ts` cycle.

## The class's real internal seams

Derived by scanning every member's `this.` references. Sizes are nonblank lines
and approximate (comment blocks between members are not attributed).

Ranked by extraction order — narrowest seam first.

### 1. WS notification channel — ~330 nb, ~30 owned fields (best single win)

`wsBase`, `markWsStartupDisconnected`, `markWsOpen`, `markWsDisconnected`,
`markWsCaughtUp`, `refreshWsAtThrottled`, `recordCommittedFrame`,
`handleWsMessageData`, `handleWsClose`, `handleWsError`, `startWsKeepalive`,
`stopWsKeepalive`, `armPongDeadline`, `clearPongDeadline`,
`invalidateCursorSchedule`, `resetCursorSchedule`, `armCursorCheck`,
`cursorStale`, `runCursorCheck`, `onPongDeadline`, `startBackstop`,
`scheduleNextBackstop`, `armBackstop`, `onBackstopTick`, `clearBackstop`,
`maybeConnect`, `connect`, `scheduleReconnect`, plus the carrier quartet
(`raiseQueuedCarrier`, `takeQueuedCarrier`, `discardQueuedWsCarrier`,
`creditAppliedCarrier`) and the health sampler (`readMonotonicMs`,
`accrueWsConnectedUntil`, `observeNotifyLatency`, `sampleWsHealth`).

Owns: `ws`, `wsKeepaliveTimer`, `wsPongDeadlineTimer`, `cursorTimer`,
`cursorEpoch`, `cursorAbortController`, `cursorReplyResolve`, `backstopTimer`,
`notifyPullPendingAt`, `queuedCarrier`, `queuedBackstopPending`, `wsGeneration`,
`pendingCatchUpGeneration`, `lastWsKeepaliveWrite`, `reconnectAttempt`,
`wsReconnects`, `wsBackstopPulls`, `wsHalfOpenDetected`, `*AppliedPulls`,
`lastSampled*`, `notifyLatency*`, `monotonic*`, `wsConnected*`,
`wsHealthWindowStartedMs`.

Seam to the daemon (~15 calls each way): needs `request`, `log`, `api`, `cfg`,
`stopped`, `resetLifecycle`, `syncBase.lastSyncedSequence`, `bootId`,
`activity.ws`, `writeWsActivity`, `keyDeliveryFlight`, `telemetry`,
`cursorClock`. Called back into by `start`, `finishStop`, `stop`,
`resetOperationBoundary`, `enterResetHalt`, `executeOp`, `doPull`,
`startTelemetryTimers`, `runPumpOperation`.

The file already frames this as optional ("live notification channel (optional;
correctness never depends on it)"), which is what makes it the safest big cut.

### 2. Drift audit orchestration — ~125 nb, 4 owned fields

`mutateDriftState`, `resolveDriftFromAppliedEvents`,
`scheduleDriftClassification`, `runDriftAuditNow`, and the `OpenDriftAudit`
type. Owns `openDriftAudits`, `driftState`, `driftIo`, `driftSaveFailedLogged`.

Narrow seam: `root`, `log`, `local.manifest`, `pendingEvents`,
`retryQueue.deferredPaths`, `bootId`, `watcherSessionId`,
`watcherErrorGeneration`, `watcherLive()`, `trustState`. The pure computation
already lives in `drift-audit.ts`; this is only the daemon-side window
lifecycle. Watch out: `runDriftAuditNow` is a **public test seam** and must stay
reachable on `RboxDaemon`.

### 3. Scan cadence and watcher trust — ~110 nb, ~16 owned fields

`noteChurn`, `pinSafetyFloor`, `scheduleSafetyScan`, `scheduleDeepScan`,
`runSafetyCadenceTick`, `advanceSafetyCadenceForTick`, `watcherLive`,
`watcherTrustedForPull`, `watcherScanMode`, `maybeClearWatcherDegradedAfterScan`,
`setTrustState`, `resetSuspectEpisodeState`, `maybeClearWatcherUnsettledAfterOp`,
`markLocalUnsettledFromWatchEvent`.

Owns `safetyDelay`, `churnSinceSafety`, `watcherHealthy`, `trustState`,
`transientDropTimestamps`, `lastTransientDropMs`, `recoveryHoldMs`,
`watcherLivenessSinceDrop`, `hasCleanUnprunedScanThisEpisode`,
`consecutiveQuietSafetyTicks`, `watcherDegraded`, `watcherErrorGeneration`,
`watcherSessionId`, `lastSafetyCompletedMs`, `watcherUnsettled(+Generation)`.

Cohesive and mostly self-referential. **Highest-risk-per-line, though**: this is
design 49 backoff + design 104 re-trust + design 178 coalescing, and
`daemon-activity.test.ts` has a timing history against it. Do not do this one
without the rig.

### 4. Reset-halt and boundary authority — ~105 nb

`scheduleResetRetry`, `enterResetHalt`, `bootstrapAgreement`,
`resetOperationBoundary`, `loadSyncBase`, `seedFromState`,
`recoverOwnedLocksAtBoundary`, `recoverStateCasWithGate`,
`refreshScopeAuthority`, `openOperationBoundary`. Owns `resetLifecycle`,
`resetRetryTimer`, `nextResetRetryAt`, `resetHaltIdentity`, `resetHaltReason`,
`startupLockRecoveryDone`, `scoped`, `scopeGeneration`, `pullOnly`, `syncBase`.

### 5. Push composition — ~165 nb

`doPush`, the `publishTransition` ports block, `terminalPushBlock`,
`logTerminalPushBlocked`, `recordOutOfStorage`, `applyPendingWatchEvents`,
`observeCaseCollisions`.

### 6. Pull composition — ~145 nb

`pullTrustFacts`, `buildTrustedPullView`, `installPullPatch`, `runPull`,
`doPull`, the `pullTransition` ports block, `manifestSettledForPull`,
`bumpConflict`.

### 7. Matcher / config / cache / scans — ~145 nb

`pruneCache`, `rebuildMatcher`, `ensureMatcherProvenance`,
`downgradeWatcherIfBackendStale`, `currentMatcherFacade`,
`adoptionCacheGenerationBoundary`, `reloadWorkspaceConfigIfChanged`,
`doFullScan`, `doDeepScan`. Design 206's three sections live here.

### 8. Pump core — ~420 nb (split it before extracting it)

`request`, `requestPush`, `takePushProvenance`, `recordGitCaptureSuccess`, the
git-busy quartet, `pump`, `nextPumpOperation`, `armStandingRecovery`,
`recordRecoveryFailure`, `recordClassifiedFailure`, `clearRecoveryHalt`,
`hasPublishableLocalDivergence`, `executeOp`, `runRecoveryProbe`,
`beginPumpOperation`, `runPumpOperation`, `settleAfterDrain`, scheduler getters.

`runPumpOperation` alone is **140 nonblank — the largest method in the file**.
Roughly 80 of those are the catch-block failure epilogue, which is a separable
policy function before any module boundary is drawn.

### 9. Activity / ambient status writers — ~300 nb (extract LAST)

`writeActivity`, `writeWsActivity`, `enqueueActivityWrite`,
`writeHeartbeatSurfaces`, `localSettled`, `localSnapshot`, `ambientStatusFrom`,
`activitySnapshot`, `saveAmbientStatusIfOwned`, `enqueueAmbientStatusWrite`,
`writeAmbientStatus`, `pausedAmbientStatus`, `writePausedAmbientStatus`,
`canPersistTrustedSurface`, `canPersistAmbientStatus`, `beginOwnershipWindDown`,
`onTransferProgress`, `noteTypeFlip`, `recordPullApplied`,
`emitDurableGitDeferrals`, `observeDurableGitState`, `runDeferralHygiene`.

Highest fan-in in the file: `writeAmbientStatus` / `writeActivity` are called
from essentially every other cluster, and `localSettled` reads the scheduler,
the retry queue and `pendingEvents`. Extracting it early would force a ports
object wider than the module it creates. It gets cheap only after 1-8 land.

### 10. Lifecycle — ~320 nb (the residue that stays in `daemon.ts`)

`start`, `startLiveWatch`, `handleGitSignalBatch`, `stop`, `finishStop`,
`startUpdateChecks`, the four heartbeat start/stop pairs,
`startTelemetryTimers`, `writeStartupBinding`, the constructor and the field
block. This is the composition root and should end up being the facade.

## Suggested cycle order

Each is its own design doc + adversarial review + rig validation, per CLAUDE.md,
landing one collaborator plus its contract test — the same cadence that produced
the nine collaborators tabled above. None of these should be bundled together.

> **Do not "solve" the private-field blocker with a framework.** Design 214 is
> binding here: *"No new generic repository, service, dependency-injection, or
> class layer. Existing direct functions and explicit parameters remain."* The
> blocker is resolved per cycle by giving each collaborator its own constructor
> ports object — exactly how `DaemonOperationScheduler` (`DaemonSchedulerPorts`)
> and `LocalWorkspaceObserver` already do it — not by introducing a container, a
> service locator, an inheritance chain, or a mixin scaffold. A generic
> mechanism that makes all ten seams cheap at once is the wrong answer; it
> re-couples what the cycles exist to separate.

1. WS notification channel (largest win, weakest correctness coupling)
2. Drift audit orchestration (narrowest seam, measurement-only failure mode)
3. Split `runPumpOperation`'s failure epilogue out (in place, no new module)
4. Matcher / config / cache
5. Push composition, then pull composition
6. Reset-halt and boundary authority
7. Scan cadence and watcher trust (rig-gated)
8. Activity / ambient status writers (cheapest last)

After 1-8 the residual composition root is ~400-500 nb and the allowlist entry
can finally be retired.

## Spotted while reading — NOT fixed

1. **Import back-edge / cycle.** `daemon-publish-transition.ts` imports
   `PushProvenance` from `./daemon.js`, so `daemon.ts` <-> that module is a
   cycle. Moving `PushProvenance` to a leaf (see the table) fixes it. 194 set
   the precedent for repointing an inner module off the facade.
2. **Duplicated guard.** `runPumpOperation` tests `if (clearsOutOfStorage)` in
   two consecutive statements (daemon.ts:1605 and :1608). Behaviorally
   identical to one block; pure redundancy.
3. **Un-cancelled reconnect timer.** `scheduleReconnect` (daemon.ts:3305) calls
   bare `setTimeout` without retaining or `unref`-ing the handle, so it is the
   one WS timer absent from `finishStop`'s teardown list. `connect()` re-checks
   `this.stopped`, so correctness holds, but a stopping daemon can hold the
   loop open for up to the backoff delay.
4. **Non-injectable jitter.** `startBackstop` (daemon.ts:3227) uses
   `Math.random()` directly while every sibling cadence takes an injected
   random (`cursorRandom`, `recoveryRandom`). The first backstop tick's spread
   is therefore untestable.
5. **Duplicated render/persist block.** `enqueueActivityWrite` and
   `writeHeartbeatSurfaces` each hand-roll the same ~15 lines of shell line +
   shell deferrals + ambient status rendering and chaining. Divergence risk
   whenever one surface gains a field.

None of these were touched: this pass shipped no code.
