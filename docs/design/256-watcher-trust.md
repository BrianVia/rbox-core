# Design 256 — WatcherTrust owns the episode

## Verdict

Extract one stateful `WatcherTrust` Module from `RboxDaemon`. It owns the
design-104 one-way fuse/recovery arithmetic, design-237 first-drop episode
coalescing and supervised re-arm trust publication, watcher degradation,
native-admission staleness, and the watcher-local unsettled generation. The
daemon remains the sync Adapter: it reports observations and consumes cohesive
trust reads; it no longer reconstructs the episode from loose fields.

This is behavior-preserving. No watcher backend, subscription lifecycle,
trusted-pull clause, safety/deep cadence, drift classification, ambient format,
log text, kill switch, timer, wire shape, or durable record changes.

## Protected-functionality ledger

| Contract | Protection |
| --- | --- |
| Design 104 fuse | Flag-off keeps sticky `watcherHealthy=false` with `trustState=trusted`. Flag-on transient errors enter suspect, fatal errors fuse, and six episodes inside the strict ten-minute window fuse. Trust never improves without the existing clean-scan or supervised witness gate. |
| Design 237 episodes | Coalescing stays first-drop anchored over `[first, first+5s)`, rolling-window eviction stays `ts > now-W`, hold stays measured from the last callback, and all arithmetic uses one injected clamped monotonic clock. |
| Suspect re-trust | Only a live watch plus stable full-tree scan under the current error generation records clean evidence. The existing exponential hold and last-trusted-generation check gate publication; pruned, stale, missing-watch, or fused scans never publish. |
| Supervised re-arm | `WatcherSessionSupervisor` remains sole subscription/replacement/witness owner. Its nine-condition gate, parcel-only recovery, chokidar terminal behavior, attempt/generation identity, backoff, scan-thrown handling, recertification, and stop drain remain unchanged. `WatcherTrust` supplies the error/matcher/certification facts and receives the successful publication. |
| Kill switch | `RBOX_WATCHER_RETRUST=0` remains restart-scoped and sampled at every existing supervisor decision. Flag-off logs/status/cadence/drift behavior remains byte-identical. |
| Pull P1 | Trusted pull remains `watcher present && watcher healthy && trustState=trusted && !degraded`, both before and after pending-event drain. F1 still compares the operation's captured error generation with the current generation. |
| Scan pruning/cadence | A pruned safety scan still requires a present healthy stream. A suspect stream may back off only after post-drop liveness, a clean unpruned scan, and K quiet ticks. Churn and watcher errors still pull an armed backed-off timer to the floor. |
| Local settlement | Every raw watcher event synchronously marks the local surface unsettled and advances its generation. Only a non-recovery operation that refreshed local truth, saw no newer event, and left no pending event clears it. Retry and active-operation clauses remain daemon-owned inputs. |
| Ambient status | The existing `watcherDegraded` and public `suspect|fused` projection remain unchanged, including write timing on every state edge. |
| Drift audit | An open audit is monotonically contaminated on trust loss; its opening snapshot, candidate `originUntrusted`, continuity generation/health, flag-off log omission, and final log tokens remain unchanged. |
| Matcher/native coverage | Every matcher rebuild still compares the current backend's installed native admission and semantic coverage. Chokidar rebuilds and coverage expansion fuse; unchanged Parcel inputs do not. The same supervisor loop receives coverage-change fuses. |
| Performance/crash | No extra scan, filesystem traversal, matcher rebuild, subscription, durable write, or timer is added. State is process-local as before and restart resets it to trusted. |

There is no feature retirement, migration removal, compatibility change, or
fast-path removal in this design.

## Measured complexity and ownership

Before, `daemon.ts` is 3,097 nonblank lines and directly holds 16 trust/settlement
scalars (the prompt's 14 plus native-admission fingerprint and the clamped clock
high-water), approximately 13 transition helpers, and repeated compound reads in
pull admission, safety cadence, scan mode, ambient status, drift audit, and the
watcher supervisor construction.

`WatcherTrust` owns:

- `watcherHealthy`, `trustState`, `watcherDegraded`, and
  `watcherErrorGeneration`;
- `lastTrustedErrorGeneration`, episode starts/current first drop, last drop,
  recovery hold, post-drop liveness, clean-scan evidence, and quiet ticks;
- watcher-local unsettled boolean/generation;
- the installed native-admission fingerprint;
- the clamped monotonic clock used by all episode arithmetic and diagnostics;
- every transition among those fields, including fatal/transient error
  classification, scan recovery, re-arm publication, watcher-unavailable and
  backend-stale observations.

It must never own the watcher subscription, re-arm attempt/witness/backoff,
matcher construction/generation, scan execution, daemon scheduler/timers,
pending event buffer, retry queue, open drift-audit records, status persistence,
or pull/push execution.

The stable constructor port is limited to adjacent-owner effects/facts:

```ts
interface WatcherTrustPort {
  watcher(): { backend: "parcel" | "chokidar" } | undefined;
  respectGitignore(): boolean;
  knownGitRepos(): readonly string[];
  fuseSession(): void;
  fatalSession(): void;
  contaminateAudits(input: { watcherHealthy: false; trustState?: TrustState }): void;
  statusChanged(): void;
  pinSafetyFloor(): void;
  log(line: string): void;
}
```

Immutable constructor data is `{root, monotonicNow}`. `root` is used for the
same `nativePruneGlobs`, `nativePruneCoverageComplete`, and
`effectiveIgnoreRules` reads as today; the injected clock owns the one clamped
high-water. The session calls are domain operations on the existing lifecycle owner, not an
effect vocabulary. The callback closures are constructed once; there is no
effect union, reducer, switch, replayable plan, or per-field getter membrane.

The public Interface is one observation entry plus cohesive reads:

```ts
observe(
  | { kind: "error"; error: Error }
  | { kind: "watch-activity" }
  | { kind: "raw-event" }
  | { kind: "scan"; operationErrorGeneration: number; receipt: ScanCoverage }
  | { kind: "operation-complete"; operationEventGeneration: number; pendingEvents: boolean; refreshedLocalTruth: boolean }
  | { kind: "safety-tick"; churned: boolean }
  | { kind: "session-installed"; admissionFingerprint: string }
  | { kind: "watch-unavailable" }
  | { kind: "rearmed"; errorGeneration: number }
  | { kind: "matcher-rebuilt"; matcher: IgnoreMatcher }
): void | { wasUnsettled: boolean };

trustedForPull(): boolean;
liveForPrunedScan(): boolean;
liveEnoughToSkipSafetyScan(): boolean;
localSettled(): boolean;
captureOperation(): { errorGeneration: number; eventGeneration: number };
snapshot(): { live; state; degraded; errorGeneration; eventGeneration; retrustEnabled };
armAuthority(matcherGeneration, matcher): WatcherArmAuthority;
armCertification(matcher): WatcherArmCertification;
```

`raw-event` performs both transitions: it records watch activity, advances the
unsettled generation, and returns the prior unsettled fact. The daemon keeps the
exact existing adjacent-owner predicate before enqueueing the non-ambient
activity write: no BASE means no write; otherwise write unless the prior episode
was already projected unsettled. This preserves the case where an event arrives
before BASE, BASE is later installed without clearing the episode, and a second
event must perform the first projection write.

`statusChanged` means only the existing ambient-status enqueue. It fires once
for a flag-off error, once after a flag-on error completes its suspect/fused
transition, once for a stable visible-degradation scan clear, once for suspect
re-trust (not an extra call for its intermediate clear), once for supervised
re-arm publication, once for watch-unavailable, and once for backend-staleness
fusion. Flag-off error handling contaminates audits with
`{watcherHealthy:false}` and returns before error classification or supervisor
fatal/fused signaling; suspect/fused contamination also supplies the worse
trust state.

`liveEnoughToSkipSafetyScan` folds the current `watcherLive ||
degradedBackoffEligible` decision into the owner; `liveForPrunedScan` deliberately
does not, because suspect evidence may stretch cadence but may never authorize a
pruned scan. `snapshot.live` is explicitly watcher-present-and-healthy, never the
raw boot-default health bit. It is one value read for status/drift consumers,
not mutable state exposure.

## Consumer rewiring

- watcher-session construction: `errorGeneration()` reads WatcherTrust while
  `matcherGeneration()` continues to read the daemon's matcher owner directly;
  arm authority receives the current matcher generation and matcher as adjacent
  authority, while certification and successful publication route
  through `WatcherTrust`; session installation and unavailable-start become
  observations;
- watcher callbacks: settled file batches and Git signal batches report
  `watch-activity`; raw callbacks report only `raw-event`, which subsumes watch
  activity and additionally advances local-unsettled generation. Errors become
  observations. Daemon still buffers paths,
  schedules work, and records audit event coverage. A drop resets prior liveness
  exactly as today;
- pull P1/F1: both trust snapshots call `trustedForPull`; pull patch F1 and
  request sealing use `captureOperation().errorGeneration`;
- safety cadence: each tick reports churn, then passes
  `liveEnoughToSkipSafetyScan` to `nextSafetyDelay`; scan mode uses only
  `liveForPrunedScan`;
- full/deep scan: start generations come from one operation snapshot and scan
  completion is observed before the supervisor consumes a witnessed full-scan
  receipt;
- ambient status: one snapshot supplies degradation and trust state;
- drift audit: one snapshot supplies opening present-and-healthy liveness,
  state/error generation,
  candidate contamination, continuity generation/health, and conditional log
  state;
- local status: operation start captures the event generation; raw events mark
  unsettled; non-recovery completion reports whether it refreshed local truth
  and the pending-buffer fact; the settled-to-unsettled callback preserves the
  exact existing activity persistence predicate using the returned prior-state
  fact; `localSettled` combines the owned watcher fact with daemon-owned retry
  and scheduler facts read through one `externalLocalWorkSettled` port;
- matcher rebuild: supervisor attempt invalidation remains explicit, then one
  trust observation performs native-admission staleness classification/fusion.

## Ceremony deletion and safe-deletion proof

Delete the daemon-local `watcherRetrustEnabled()` guard/wrapper: once
WatcherTrust owns the restart-scoped kill-switch decision, retaining a second
daemon guard would recreate split authority. The `RBOX_WATCHER_RETRUST` flag and
all its decisions remain supported inside the owner. This is the architecture
loop's concrete ceremony kill. Also delete the daemon CODEMAP phrase assigning “watcher trust arithmetic” to
`daemon.ts`, and add one owner line for `watcher-trust.ts`. Delete the loose
fields/methods and test-only fabricated access to those individual daemon
members. Their behavior is absorbed behind `WatcherTrust` and verified through
its Interface plus the unchanged integration tests.

These symbols are private process-local implementation: `rg` shows no command,
alias, package export, dynamic/generated load, persisted/wire format, build hook,
automation, migration, or support-window dependency. No source file, protected
test, flag, log format, CODEMAP file, or supported behavior is approved for
deletion. The existing daemon size ratchet is not edited and the new Module must
stay below 400 nonblank lines without an allowlist entry.

## Requirement challenges

| Requirement | Complexity cost | Evidence | Decision |
| --- | --- | --- | --- |
| Preserve direct test mutation of ~16 daemon private fields | Makes tests a second writer of the episode and prevents one owner. | `watcher-retrust`, daemon safety/activity/trusted-pull tests fabricate private views; production has one logical state machine. | Keep every protected test name and assertion intent, changing only test-harness access to the `WatcherTrust` Interface and injected clock. Add direct deterministic contract tests. |
| Keep pure episode arithmetic in `policy.ts` | Splits policy from state, but it is already a small reusable deterministic predicate with field replay coverage. | `recordWatcherDropEpisode`, `classifyWatcherError`, `worseTrust`, and `TrustState` contain no effects/state. | Preserve and compose them; do not duplicate them in the Module. |
| Move watcher-session re-arm into WatcherTrust | Would merge logical trust authority with physical subscription lifecycle and its async witness protocol. | Design 237 gives replacement, attempt identity, and nine-condition testimony to `WatcherSessionSupervisor`. | Preserve the supervisor; connect it through five cohesive facts/operations. |
| Keep `localSettled` in daemon because it reads scheduler/retry state | Leaves the watcher-unsettled invariant split and invites direct field reads. | Only the final boolean uses adjacent facts; event generation/clear authority is entirely watcher trust. | `WatcherTrust.localSettled()` owns the decision while one port reports whether adjacent daemon work is settled. |

## Tests and validation

Add `watcher-trust.test.ts` with an injected clock and fake port. It directly
pins: flag-off sticky failure; transient/fatal transitions; first-drop episode
boundaries and six-episode fuse; suspect hold arithmetic; pruned/stale/no-watch
scan refusal; post-drop liveness + K quiet ticks; re-arm publication; backend
staleness; local-unsettled generation; and exact existing log lines/port calls.
It separately pins settled-batch, raw-event, and Git-batch liveness sources;
absent-watcher boot health; health-only flag-off audit contamination; push with
and without applied pending events; the recovery-probe exclusion; and the
two-event no-BASE→BASE activity-write edge.

Keep every test in `src/cli/watcher-retrust.test.ts`,
`daemon-safety.test.ts`, `daemon-activity.test.ts`, and
`daemon-trusted-pull.test.ts`; test harnesses replace direct elapsed-time/state
mutation with clock advancement and controlled observations, but no protected
case or assertion intent is removed. The design-237
nine-condition cases remain supervisor/daemon integration tests rather than being
reimplemented in the trust Module. Every existing individual supervisor gate
negative remains: mid-arm matcher rebuild, both arm/publication
recertifications, structural conflict, scan-thrown, stale attempt, flag sampling,
Parcel-only recovery, and Chokidar terminality. Scan receipt fields and
`WatcherSessionSupervisor.settleScan` are unchanged.

Exit-code-verified gates:

1. focused WatcherTrust, watcher-retrust, daemon-safety, activity and
   trusted-pull tests during migration;
2. at least one adversarial review round executes focused code/tests, no more
   than three rounds total, final rollup zero;
3. `bun test src/cli/daemon src/cli/sync` with zero failures, plus the protected
   `bun test src/cli/watcher-retrust.test.ts` because it lives one directory up;
4. repository typecheck;
5. direct whole-file oxlint for every touched source/test plus
   `bun run lint:affected`, with zero touched-file warnings;
6. `bun test src/cli/state-plane/file-size.test.ts`, no size allowlist/ratchet
   edit, and before/after nonblank counts;
7. final move-fidelity `rg` showing no duplicate daemon fields/helpers and a
   diff audit of P1/F1, drift, cadence, ambient status, matcher staleness, flag,
   logs, and supervisor witness conditions;
8. `sg docker -c 'bun scripts/rig/rig.ts run two-device-live'` passes.

Differential integration tests protect compatibility and the existing fast
paths; deterministic Interface tests protect arithmetic. There are no durable
effects in this Module, so crash validation is the unchanged supervisor identity
and operation-boundary suite rather than invented persistence injection.
