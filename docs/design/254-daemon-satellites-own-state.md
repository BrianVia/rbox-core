# Design 254 — daemon satellites own their transition state

## Verdict

Invert both daemon transition satellites. `PublishLocalWorkspaceTransition`
becomes the owner of publish-local episode state and applies a classified push
result directly through one narrow per-operation port. `ApplyRemoteWorkspaceTransition`
evaluates pull trust from two facts snapshots around the existing pending-event
drain and applies a classified pull result directly through one narrow
per-operation port. Delete both effect unions, both per-variant effect
interfaces, both effect reducers, and both dispatch switches. The contract tests
will drive each machine through its public operation and assert observable state,
calls, receipts, and fail-closed attempt binding rather than restating an internal
effect protocol.

This is behavior-preserving. No durable record, wire shape, sync-engine policy,
operation scheduling rule, or crash boundary moves.

## Protected-functionality ledger

| Contract | Protection |
| --- | --- |
| Attempt identity | Every push and pull child receives a fresh identity. A mismatched outcome throws before any transition state or external effect changes. |
| Push request sealing | LOCAL manifest, applied BASE, GC-fenced paths, observation completeness/collision carry, and terminal fingerprint are read once before execution. GC deferral and preserve/authoritative semantics remain byte-for-byte equivalent. |
| Push result ordering | Capture success → committed LOCAL subset → collision/completeness adoption → conditional log → sequence adoption → committed activity slot → retry schedules → durable-state refresh → sync metric → report settlement remains the order. Terminal repeats still set the halt episode and refresh durable state only. |
| Pull trust P | F5/P1/P2/P5/P6/P7/P7-observation precede the drain. P3, P1, and P2 are read again after the awaited drain. Earlier refusal still avoids the drain. Every refusal keeps its exact token. |
| Pull fallback | A trusted-view refusal authorizes exactly one scan-backed child. A scan-backed refusal propagates. Chain repair, ignore-rule write, topology change, and watcher-drop retain F4/F3/F2/F1 precedence. |
| Pull result ordering | Chain-repair clear → propagation sample → immediate pull-report settlement → conflict metric → matcher refresh → post-BASE adoption/sequence note → patch-or-scan → provenance log remains the order. |
| #690 boundary settlement | `DaemonOperationScheduler` remains the sole operation-boundary owner. `settleOperationBoundary()` and the `drain_wait_ms` span are untouched; push report enqueue remains inside transition settlement and FIFO draining remains at the scheduler boundary. |
| #692 divergence routing | `divergenceNeedsPush` remains the one decision used by both post-pull and recovery paths. The transition does not add a queue or request a push. |
| #685 pending-carry suppression | `hasPublishableLocalDivergence()` and the `pending-carry` verdict remain untouched. Pull settlement never infers or schedules a push. |
| Crash safety | Durable SQLite/state saves, cache save, activity sidecar serialization, retry timers, and report boundary are not relocated. The same awaited calls retain the same order and failure propagation. |
| Compatibility/performance | Public CLI behavior and sync ports are unchanged. Trusted-view O(applied) refresh, scan fallbacks, GC-fence fast path, and one-drain/one-or-two-pull-call bounds are preserved. |

There is no feature retirement, migration removal, wire-format change, or
performance-path removal in this design.

## Measured complexity and ceremony deletion

### Publish before

- 12-member `DaemonPublishEffect` union.
- 13-method `DaemonPublishEffects` interface.
- `reduceDaemonPublishOutcome`, which expands one result into an effect list.
- 12-case `apply()` switch containing one-line delegations.
- 14 construction closures in `daemon.ts` that project private fields back into
  the satellite.
- Contract tests mirror effect kinds and ordering through `RecordingEffects`.

### Pull before

- 9-member `DaemonPullEffect` union.
- 9-method `DaemonPullEffects` interface.
- two reducers that expand settlement and refresh into effect lists.
- 9-case `applyEffect()` switch.
- 10-getter `PullTrustFacts` membrane plus a daemon method that manufactures it.
- 9 construction closures in `daemon.ts` and contract tests that mirror the
  effect vocabulary.

The post-change ceremony-kill target is deletion of those four effect
enumerations/interfaces/switches, the 10-getter trust membrane, the two
effect-kind test helpers, and the corresponding CODEMAP wording that requires
an “ordered effect plan.” The exact deleted-member and line counts will be
reported from the final diff.

## Ownership and Interfaces

### `PublishLocalWorkspaceTransition`

Owns:

- `lastPublishedSequence` (the current `daemon.lastLoggedSeq`), including
  adoption from startup/pull and duplicate-log suppression;
- `terminalBlocked` and `lastTerminalBlockFingerprint`, including recovery
  clearing and duplicate terminal-log suppression;
- the copied `activeCaseCollisions` observation used by push sealing, watcher
  collision intersection, and pull trust;
- the publish activity-slot mutation (`activity.lastPush`) and its dirty signal;
- attempt numbering, request sealing, identity validation, result classification
  boundary, and direct ordered settlement.

Its public Interface is the operation `publish(provenance, port) → receipt` plus
small state-owner operations required by other daemon lanes: read/adopt sequence,
read/adopt collision observation, read/clear terminal episode. These are domain
operations on one owner, not callbacks that reproduce an effect protocol.

The concrete shape is:

```ts
interface PublishTransitionState {
  root: string;
  local: LocalAuthority;
  retries: LocalRetryQueuePort;
  activity: DaemonActivity;
  metrics: SyncMetrics;
  telemetry: TelemetryRecorder;
}

interface PublishTransitionServices {
  log(line: string): void;
  refreshDurableState(): Promise<void>;
}

interface PublishOperationPort {
  readonly appliedBase: Manifest | undefined;
  execute(request: SealedPublishRequest): Promise<DaemonPushOutcome>;
  settleReport(publishTransitionMs: number): void;
}
```

The stable state references are existing deep owners, not projections of daemon
private scalars. The transition reads LOCAL, retry GC fences, collision state, and
the terminal fingerprint itself to create one `PublishAttemptInputs` value. It
directly commits LOCAL, schedules retries, updates metrics with `saveMetrics`, and
records capture telemetry. The only constructor callbacks are logging and the
cohesive durable-state refresh (load BASE + surface durable deferrals); the only
per-op methods are the real sync-engine/report lifecycle seam. There is no method
corresponding to capture success, subset commit, collision adoption, sequence,
activity, retry kind, or metric effect, so the old per-effect membrane cannot be
reconstructed.

Both transitions are declared without class-field initializers and are constructed
at the end of `RboxDaemon`'s constructor, after LOCAL, retry queue, telemetry,
chain-repair policy, watcher/local observers, and scheduler have been assigned.
The `metrics` record keeps one object identity for the daemon lifetime: startup
copies the fields from `loadMetrics` into that record instead of replacing it.
Thus transition references cannot capture `undefined` or a pre-load counter object.
Contract/integration coverage starts metrics at nonzero values and proves publish
and pull increment and persist that same loaded record.

`activity.lastPush` and its dirty bit are one satellite-owned operation. The
transition holds the shared activity record reference, writes the slot and sets
its own `publishActivityDirty` synchronously, exposes that bit to pump settlement,
and clears it only when the daemon's existing activity write boundary acknowledges
the snapshot. Pull has its separate existing dirty bit. This preserves the atomic
old pair without giving two writers authority over one publish-dirty transition.

Must never own Git planning, push execution, publisher ACK, durable state schema,
the retry timer implementation, the activity record as a whole, or scheduler
settlement.

### `ApplyRemoteWorkspaceTransition`

Owns attempt numbering, trust admission, the single authorized scan fallback,
identity validation, action summary, F4/F3/F2/F1 refresh choice, and direct
ordered settlement.

`PullTrustFacts` becomes two concrete snapshots; the only function is the lazy
trusted-view projection inside the post-drain snapshot:

```ts
interface PullTrustBeforeDrain {
  killSwitchOff: boolean;
  watcherTrusted: boolean;
  manifestSettled: boolean;
  fullWorkspaceSinceSeed: boolean;
  resetReady: boolean;
  matcherMatchesBase: boolean;
  matcherObservationCurrent: boolean;
}

interface PullTrustAfterDrain {
  pendingEmpty: boolean;
  watcherTrusted: boolean;
  manifestSettled: boolean;
  trustedView(): TrustedLocalView;
}

interface PullOperation {
  seal(): Promise<PullAttemptInputs & { beforeDrain: PullTrustBeforeDrain }>;
  drainPendingEvents(): Promise<void>;
  afterDrain(): PullTrustAfterDrain;
  open(): PullTransitionPort;
}
```

`seal()` captures BASE/F1/notify and the seven pre-drain values together. Only if
those values admit trust does the transition await the drain, then synchronously
obtain one post-drain value containing P3/P1/P2 and a synchronous trusted-view
thunk. The transition evaluates all three refusal clauses before calling that
thunk, so the O(workspace) projection is constructed only for an admitted pull;
there is no `await` between the post-drain snapshot, those checks, and projection.
The read-only deferred set remains the live pump-owned alias. A pre-drain refusal
does not call either drain or `afterDrain`. This retains the live rechecks without
ten getter callbacks and forbids sealing a pre-drain view.

The transition is constructed with stable references to the existing chain-repair
policy, telemetry recorder, metrics record/root, publish transition (for sequence
adoption), and LOCAL authority. Five cohesive services remain external because
their owners genuinely sit next door: log, refresh matcher, load+surface post-BASE,
install the F1-guarded patch, and scan LOCAL. The per-operation pull port contains
only engine `execute` and immediate report `settleReport`. The transition calls
these owners directly in the protected order; there is no per-effect method set,
effect list, or replayable plan.

```ts
interface PullTransitionServices {
  log(line: string): void;
  refreshMatcher(): Promise<void>;
  loadAndSurfacePostBase(): Promise<SyncState>;
  installPullPatch(
    view: TrustedLocalView,
    actions: readonly Action[],
    postBase: Manifest,
    watcherErrorGeneration: number,
  ): "watcher-drop" | undefined;
  scanLocal(previous: Manifest): Promise<void>;
}
```

These five services are not an effect vocabulary: each is an existing cohesive
adjacent-owner operation, and none covers chain clear, propagation, report,
conflict metrics, topology choice, sequence adoption, or provenance decisions.

Must never own reconciliation, Git apply, mass-delete policy, durable BASE,
watcher lifecycle, matcher construction, scheduler queues, or report-boundary
draining.

## Field-by-field move

| Before in `Daemon` | After owner | Cross-lane access |
| --- | --- | --- |
| `lastLoggedSeq` | publish transition | startup/pull adopt; status reads |
| `pushTerminalBlocked` | publish transition | recovery reads/clears |
| `lastTerminalBlockFingerprint` | publish transition | internal terminal-log suppression only |
| `activeCaseCollisions` | publish transition | watcher observation adopts; event intersection and pull trust read |
| `activity.lastPush` write + publish dirty bit | publish transition | one synchronous `recordLastPush`; pump reads/acknowledges the satellite's dirty bit at the existing persistence boundary |

`local`, `retryQueue`, `metrics`, `activity`, durable state, matcher, telemetry,
and chain-repair policy remain with their existing owners. Stable deep owners are
constructor state, the named cohesive services are constructor services, and each
per-operation port contains only engine execution plus its report lifecycle.
Transferring those entire owners would create new cross-plane ownership rather
than deepen the transition.

## Safe-deletion proof

The effect unions, effect interfaces, reducers, switches, and `PullTrustFacts`
are internal TypeScript constructs referenced only by the two transition files,
their contract tests, `daemon.ts`, and the two CODEMAP entries. They are not CLI
commands, package exports, dynamic imports, generated loads, persisted formats,
wire values, automation hooks, or migration surfaces. `rg` after implementation
must show no surviving symbol or effect-kind reference. Their behavior is
absorbed directly by the owning transitions and covered through the public
machine Interfaces before deletion.

No source file or supported feature is approved for deletion. No size allowlist
or ratchet entry may be added or re-pinned. `daemon.ts` must shrink; if either
satellite exceeds 400 nonblank lines, deepen the design instead of allowlisting.

## Requirement challenges

| Requirement | Complexity cost | Evidence | Recommendation / decision |
| --- | --- | --- | --- |
| Return effect arrays in receipts | Makes internal implementation a public test protocol and forces every action to be named four times. | Only contract tests inspect `receipt.effects`; runtime consumes sequence/local/fallback identity facts. | Delete effect arrays; receipts report only closed operation outcomes needed by callers. No product behavior changes. |
| Preserve pure effect reducers | Retains a second orchestration language whose only interpreter is the adjacent switch. | Reducers have no independent production consumer; tests largely echo kinds/order. | Absorb decisions into direct machine methods and assert behavior at the Interface. |
| Move all adjacent state objects into satellites | Would make LOCAL, metrics, activity, retry, matcher, and durable BASE jointly owned or leak them back to daemon. | These objects serve watcher/status/recovery paths and already have owners. | Move only transition-specific scalar/episode state; use one narrow operation port for real adjacent-owner effects. |
| Preserve exact ordering | Direct code must retain careful sequencing without an effect-list fixture. | Report FIFO, collision authority, and refresh ordering are supported safety/observability behavior. | Preserve and test observable calls/state; no decision needed. |

## Contract-test rewrite

The publish contract test will use a small stateful harness implementing the one
operation port. It will assert the sealed request, final transition-owned state,
LOCAL/retry/activity/metric/log behavior, report enqueue, identity mismatch
no-op, terminal behavior, and actual call order where ordering is a supported
contract. It will not import an effect type, reducer, or `RecordingEffects`.
One integration case begins with nonzero loaded sync/conflict counters and proves
settlement increments and persists the same stable record rather than an initial
captured object.

The pull contract test will provide value snapshots and a stateful operation
port. It will assert named trust refusals (including post-drain invalidation),
one fallback execution, final patch/scan choice, metrics/log/report behavior,
identity mismatch no-op, and actual ordering. It will not import effect types,
reducers, `PullTrustFacts`, or `RecordingEffects`.

Daemon activity/trusted-pull tests remain behavior tests. They change only where
test-only access names moved to the new state owner.

## Validation gates

All commands are exit-code checked and never piped through `tail`:

1. focused contract tests and daemon activity/trusted-pull tests during the
   migration;
2. one adversarial review round that executes focused tests, with at most three
   rounds total and rollup zero before implementation is accepted;
3. `bun test src/cli/daemon src/cli/sync` with zero failures;
4. repository typecheck command;
5. direct whole-file oxlint over every touched source/test file, then
   `bun run lint:affected`, both with zero warnings for touched files;
6. `bun test src/cli/state-plane/file-size.test.ts`, with no allowlist/ratchet
   edit and measured before/after nonblank counts;
7. final `rg` deletion audit for all removed membrane symbols and CODEMAP
   “effect plan” wording;
8. final diff audit for #690 settlement/`drain_wait`, #692
   `divergenceNeedsPush`, #685 `pending-carry`, durable writes, and report FIFO;
9. `sg docker -c 'bun scripts/rig/rig.ts run two-device-live'` must pass.

The full daemon/sync suites provide differential and compatibility coverage.
Failure-injection contract tests also freeze the crash-sensitive settlement
prefixes through observable state: publish sequence/activity/retries before
durable refresh and metrics persistence before report enqueue; pull report,
conflict metrics, matcher refresh, BASE load, and sequence adoption. Identity
mismatch and terminal/refusal tests retain the remaining fail-closed evidence;
the size gate plus unchanged call bounds protect the performance paths. The rig
is the required end-to-end fleet validation.
