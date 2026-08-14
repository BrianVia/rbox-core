# Design 255 — RemoteWakeupChannel owns remote-work belief

## Verdict

Extract the WebSocket, reconnect, keepalive, cursor, backstop, carrier,
catch-up, activity, and health-sampling machine from `RboxDaemon` into one deep
`RemoteWakeupChannel`. The daemon remains the sync Adapter: it supplies a pull
request callback and, when a queued pull reaches the scheduler boundary, asks
the channel to consume the winning wakeup and later credits an applied pull.
Carrier identity and every WS-health counter remain private to the channel.

This is behavior-preserving. No wire shape, timer value, log line, pull
coalescing rule, activity format, telemetry meaning, or scheduler behavior
changes.

## Protected-functionality ledger

| Contract | Protection |
| --- | --- |
| Notify-only correctness | A frame only requests the existing authenticated, head-seeking HTTP pull. Sequence remains observation/telemetry only. |
| Reconnect | Attempt 0 retains design 105's uniform 0–3s spread; later attempts retain `reconnectDelayMs`'s 500ms-derived exponential backoff, ±25% jitter and 30s base cap. Open resets the attempt. All `ws connected`, connect-failure, error, reconnect, half-open and cursor-failure log strings remain byte-identical. |
| Liveness | Keepalive stays 25s. Every inbound frame and native pong re-arms the exact 60s default deadline. A deadline immediately disconnects, counts once, best-effort closes, and reconnects. Stale socket callbacks cannot affect a replacement. |
| Cursor | Committed frames reset cadence. One cursor request is in flight. Timeout remains `min(10s, max(1ms, cadence-1))`. `(socket, wsGeneration, cursorEpoch)` fences timer, reply, reconnect, committed, reset-halt, and stop overlaps; invalidation aborts the pending reply and suppresses stale logs/pulls. |
| Backstop | First tick remains uniform `[0, interval)`; later ticks remain interval ±25%. Every tick nudges key delivery, increments/logs the cumulative attempt, raises a backstop carrier, requests pull, and reschedules. A committed frame re-phases it. Zero disables it. |
| Carrier arbitration | `notify > cursor > backstop > none`. A masked backstop survives WS generation changes; notify/cursor provenance and notify timestamp/sequence do not. Applying pulls alone receive carrier credit. Startup/reconnect catch-up and push-internal pulls receive none. |
| Catch-up handshake | Open mints a WS generation, sets pending catch-up, requests pull only while reset-ready, and marks activity caught-up only after that generation's successful pull. Failure restores the generation; a superseded generation cannot mark caught-up. |
| Notify latency | First pending notify time is retained through coalescing, newest sequence is retained, latency is measured at dequeue, logged/traced once even on pull failure, and not restored on failure. Count/sum/max saturate exactly as today and reset only when sampled. |
| Activity/status | Startup, open, disconnect, pong/unknown-frame refresh, committed sequence and caught-up projections retain exact fields, timestamps, persistence throttling, boot id and pid semantics. |
| Health telemetry | Window and connected exposure use a non-regressing monotonic high-water. Reconnect/half-open/backstop attempts sample deltas while cumulative log counters remain absolute. Applied-carrier and notify-latency totals reset per sample. Schema caps remain unchanged. |
| Degraded modes | WS-disabled preserves polling-only mode. Reliability-disabled zeros deadline/cursor/backstop and suppresses notify latency while committed frames still pull. Reset-halt disables cursor but not key-delivery nudges. Stop invalidates all epochs/timers and closes the live socket through the existing shutdown path. |
| Performance/crash | One socket, one cursor flight, one backstop timer, and the scheduler's existing boolean pull coalescing remain. No durable write or sync-engine crash boundary moves. |

There is no feature retirement, compatibility deletion, active migration
change, or performance fast-path deletion.

## Measured complexity and ownership

Before: 29 channel-specific daemon fields, 31 channel-specific methods, the
`Carrier` type/precedence table, and four constructor seams are distributed
across startup, pump, reset, shutdown, telemetry, and the file tail. Final
counts are produced from the move-fidelity audit rather than treated as a line
target.

`RemoteWakeupChannel` owns:

- socket identity, lifecycle, reconnect attempt/generation and all timers;
- cursor epoch, cancellation, reply rendezvous and local-head comparison;
- the pending carrier/backstop mask, notify timing/sequence and catch-up token;
- WS activity projection and persistence throttling;
- all WS-health cumulative/baseline/window counters and sampling resets.

It must never own scheduler queues, the sync mutex, pull execution, durable
sync BASE, key-delivery execution, telemetry transport, reset lifecycle, or
propagation tracing as a whole.

The stable constructor port contains only adjacent-owner facts/effects:

```ts
interface RemoteWakeupPort {
  requestPull(): void;
  appliedSequence(): number;
  enqueueKeyDelivery(requestId?: string): void;
  persistActivity(): void;
  log(line: string): void;
  traceCommitted(sequence: number): void;
  tracePullDequeue(sequence: number | undefined, latencyMs: number): void;
}
```

Configuration contains URL/token/device/boot/activity plus cadence values. One
`RemoteWakeupClock` names the three distinct time domains explicitly:
`wallNow()` for persisted ISO times and notify latency, `monotonicNow()` for the
non-regressing health window, and one timer scheduler plus `random()` for
cadence. Tests inject one logical scheduler while independently controlling
wall and monotonic reads. Native defaults preserve process-liveness details
exactly: cursor, pong and backstop timeouts are unref'd; keepalive intervals and
reconnect timeouts are not. Reconnect callbacks retain today's stopped check;
the channel stores the handles only so deterministic tests can drive them, not
to add new cancellation behavior. Socket construction is injectable solely at
the external transport boundary.

The public Interface is complete but narrow:

```ts
start(): void;                 // startup-disconnected activity projection
activate(): void;              // connect + first backstop after startup boundary
setReady(ready: boolean): void;// false invalidates; true re-arms cursor
beginPull(): PullWakeupReceipt;
settlePull(receipt, { succeeded, applied }): void;
healthSample(): WsHealthSample;
quiesce(): void;               // synchronous pre-drain edge: fence/disarm, no socket close
finalizeStop(): void;          // close socket after daemon drain
```

Committed, cursor and backstop events converge on one private `wake(carrier,
sequence?)` transition. `beginPull` is the only daemon-facing queue read. It
mints an identity-bound closed receipt containing only the two adjacent pull
facts (`notifyLatencyMs`, `notifyPendingAt`) plus an opaque identity; the newest
coalesced sequence stays internal and is passed directly to
`tracePullDequeue`, so latency is observed/logged/traced exactly once at
minting. `settlePull` ignores stale or
replayed identities, restores only a still-current catch-up generation after
failure, marks only that generation caught-up after success, and credits an
applied pull only when the daemon reports the pull adopted remote state. Notify
provenance never restores after failure. `healthSample` returns the schema
record; the daemon's existing telemetry timer remains the transport owner.

The channel initializes as not-ready and not-quiesced; it owns both facts rather
than polling duplicate daemon callbacks. `setReady(false)` is the complete
reset-halt and initial daemon-stop edge: increment cursor epoch,
clear cadence/reply state, abort an in-flight reply and suppress stale logs or
pulls. `setReady(true)` re-arms only the current open socket. `quiesce()` runs at
the synchronous pre-await prefix of `finishStop`; it repeats the idempotent
cursor fence and disarms liveness/backstop but deliberately leaves the socket
open. `finalizeStop()` performs the existing best-effort socket close only after
startup, scheduler, mutation, key-delivery and watcher drains.

## Consumers rewired

- startup: `markWsStartupDisconnected` becomes `start`; healthy startup explicitly calls `setReady(true)` before post-boundary `activate`, while a boot entering reset halt calls `setReady(false)`;
- reset enter/recovery and committed frames: cursor invalidation/resume move behind channel operations;
- pull dequeue/settlement: pending notify/carrier/catch-up scalar reads become one identity-bound receipt plus one settlement operation;
- shutdown: the initial `RboxDaemon.stop()` edge calls `setReady(false)`; the pre-await `finishStop` prefix calls `quiesce`; only the post-drain suffix calls `finalizeStop`;
- telemetry: `sampleWsHealth` records `healthSample()`;
- key-delivery nudges, scheduler pull requests, sync BASE sequence, propagation trace, activity persistence and log sink stay owned by their existing Modules and are called through the stable port.

## Ceremony deletion and safe-deletion proof

Delete the `daemon.ts` CODEMAP phrase that enumerates “WS channel” as daemon
ownership and replace it with a dedicated channel owner line. Delete the
channel fields/methods, carrier precedence, split cursor-only clock/random
seams, and reliability tests' fabricated `DaemonInternals` view of those
private members. These are internal TypeScript symbols with no command, export,
wire, durable, package, build, automation, migration, or support-window role.
Their behavior is absorbed and contract-tested through the channel Interface.

No file, flag, env switch, telemetry field, activity field, log format, or
supported feature is approved for deletion. The existing `daemon.ts` size
allowlist/ratchet remains unchanged; the new production module must stay below
400 nonblank lines without a pin.

## Requirement challenges

| Requirement | Complexity cost | Evidence | Decision |
| --- | --- | --- | --- |
| Keep test access to ~30 daemon private members | Couples reliability tests to the loose implementation and made deterministic time cursor-only. | `daemon-ws-reliability.test.ts` fabricates the large view; `daemon-activity.test.ts` also directly exercises WS activity transitions. | Rewire both suites only at Interface names; add direct contract tests. No product change. |
| Separate real clocks for pong/backstop/reconnect and logical clock for cursor | Leaves FLAKE-001/004 behavior partly dependent on sleeps and makes cross-timer arbitration untestable. | Flaky registry names wall-time scheduling as the root cause. | One injected clock/random seam, native by default. |
| Let daemon parse/attribute WS wakeups | Recreates split ownership and leaks carrier precedence/tokens. | No consumer needs raw carrier state; pump needs one closed dequeue receipt. | Keep parsing/arbitration inside channel. |
| Preserve key-delivery WS nudges in this channel | They are not remote-work belief, but share the socket transport. | Existing branch intentionally runs before reset readiness. | Preserve as one callback; do not move key-delivery state/execution. |

## Contract and validation plan

Add direct logical-clock tests for: first/subsequent backstop cadence and
notify re-phasing; cursor cadence suppression and epoch fences across committed,
reconnect and stop; silent half-open cycling/reconnect; carrier arbitration and
masked-backstop preservation; catch-up generation restoration/fencing; and
health counter/window reset semantics. Add reset-halt during both scheduled and
in-flight cursor states, distinct wall/monotonic regression/non-finite cases,
and a parked daemon-drain test proving quiesce precedes and socket close follows
the drain. The dequeue contract asserts the newest coalesced sequence and exact
latency reach `tracePullDequeue` once even when settlement fails. The shutdown
test pins all three edges: `setReady(false)` aborts cursor work, `quiesce`
disarms liveness/backstop while leaving the socket open, and `finalizeStop`
closes it exactly once after the parked drain releases. No sleeps control these claims.

`daemon-ws-reliability.test.ts` remains the integration/differential suite and
changes only at channel Interface names. `daemon-activity.test.ts` remains the
status/activity differential suite and changes only at those names. A direct
exact-line table pins all eight formats: connected, connect-failed, reconnect,
error, cursor-failed, half-open, backstop, and notify-latency (including the
optional sequence); integration retains the notify token appended to pull logs.

## Corrective test-by-test coverage mapping

No test is retired. The protected file is restored, all 27 original names
survive, and each case now drives only the public `RemoteWakeupChannel`
Interface plus its transport/clock ports. The mapping is therefore an identity
mapping, not a claim that the 14 additional channel tests substitute for the
protected regression suite.

| Old test name | Surviving channel test | Why the mapping is complete |
| --- | --- | --- |
| `pong deadline closes a silent socket and counts the half-open` | Same name in `daemon-ws-reliability.test.ts` | Advances the injected deadline and still asserts one close plus one sampled half-open. |
| `every inbound frame re-arms the pong deadline` | Same name in `daemon-ws-reliability.test.ts` | Sends an inbound frame partway through the deadline and proves close occurs only after the full re-armed interval. |
| `pong deadline disconnects immediately and schedules recovery` | Same name in `daemon-ws-reliability.test.ts` | Asserts disconnected activity, immediate close, timeout reconnect accounting, and construction of the recovery socket. |
| `reconnect delay spreads the first attempt and preserves capped jitter` | Same name in `daemon-ws-reliability.test.ts` | Retains every original boundary assertion against `reconnectDelayMs`. |
| `scheduleReconnect advances the attempt sequence used by reconnectDelayMs` | Same name in `daemon-ws-reliability.test.ts` | Two failed connections prove attempt 0 reconnects at zero while attempt 1 waits the 750 ms minimum. |
| `a stale socket deadline cannot close the replacement` | Same name in `daemon-ws-reliability.test.ts` | Makes a second socket current, fires the stale socket callback, and asserts the replacement stays connected with no half-open credit. |
| `backstop pulls and reschedules itself` | Same name in `daemon-ws-reliability.test.ts` | Advances two deterministic backstop deadlines and asserts two requests, two attempts, and no applied credit. |
| `committed notification resets the backstop and records a latency token` | Same name in `daemon-ws-reliability.test.ts` | Proves the old backstop deadline is displaced, the new cadence fires, and dequeue retains timestamp, sequence, and latency log. |
| `failed notified pull logs latency at dequeue without restoring the timestamp` | Same name in `daemon-ws-reliability.test.ts` | Fails the minted receipt, then proves latency was logged/counted once, notification time was consumed, and no apply was credited. |
| `failed catch-up pull restores its generation until a healing pull` | Same name in `daemon-ws-reliability.test.ts` | Failed settlement leaves activity uncaught-up; the next successful settlement for the restored generation marks it caught-up. |
| `a stale socket message cannot trigger a pull or notify token` | Same name in `daemon-ws-reliability.test.ts` | Delivers a committed frame through a replaced socket and asserts neither pull request nor notify receipt state appears. |
| `reliability master switch disables deadline, backstop, and notify token` | Same name in `daemon-ws-reliability.test.ts` | Advances far beyond every configured timer and proves no close/cursor/backstop occurs while committed frames still request a pull without a notify token. |
| `a missed committed frame is recovered by cursor before the backstop and credited once` | Same name in `daemon-ws-reliability.test.ts` | A newer cursor head requests one pull before the 10 s backstop, and one applied receipt credits cursor only once. |
| `live committed frames reset the cursor cadence before it can wake the DO` | Same name in `daemon-ws-reliability.test.ts` | Twelve committed frames dominate more than three minimum-jitter cadence windows under logical time and assert exactly zero cursor sends. |
| `a blackholed cursor is bounded, single-flight, does not cycle the socket, and preserves backstop` | Same name in `daemon-ws-reliability.test.ts` | Pins one send through the reply timeout, a second only after a fresh cadence, zero closes/cursor credit, then advances to and observes the still-armed backstop. |
| `cursor epoch fences committed, reconnect, and stop overlaps` | Same name in `daemon-ws-reliability.test.ts` | Exercises all three invalidations: committed beats a stale cursor reply, reconnect fences the old socket, and stop prevents all later sends before closing once. |
| `cursor scheduling stays off while reset-halted and resumes once ready` | Same name in `daemon-ws-reliability.test.ts` | `setReady(false)` suppresses cursor sends indefinitely and `setReady(true)` re-arms the current socket at the exact cadence. |
| `WS-disabled plus zero backstop is the pure-polling falsification config` | Same name in `daemon-ws-reliability.test.ts` | Disabled activation creates no socket, request, or key nudge; the otherwise identical enabled configuration creates a socket. |
| `an applying backstop pull increments attempts and backstop attribution` | Same name in `daemon-ws-reliability.test.ts` | One deadline plus one applied receipt yields exactly one attempt and one backstop credit, with no notify credit. |
| `a failed notify is discarded and a fresh applying backstop gets the credit` | Same name in `daemon-ws-reliability.test.ts` | Failed notify settlement earns no credit; a later backstop receipt applies and credits only backstop. |
| `notify wins over cursor, coalesced backstop, and a carrier-less catch-up` | Same name in `daemon-ws-reliability.test.ts` | Coalesces open catch-up, backstop, newer-head cursor, and committed notify before dequeue; the applied receipt credits notify alone. |
| `a WS generation change discards notify but preserves a masked backstop` | Same name in `daemon-ws-reliability.test.ts` | Raises backstop then notify, opens a new generation, and proves the applied receipt credits preserved backstop rather than discarded notify. |
| `a WS generation change discards cursor but preserves a masked backstop` | Same name in `daemon-ws-reliability.test.ts` | Raises backstop then cursor, opens a new generation, and proves the applied receipt credits preserved backstop rather than discarded cursor. |
| `startup and reconnect catch-up applying pulls are attributed to neither carrier` | Same name in `daemon-ws-reliability.test.ts` | Applies catch-up receipts for two generations and proves all carrier counters remain zero while the current generation becomes caught-up. |
| `a push-internal recovery pull is attributed to neither carrier` | Same name in `daemon-ws-reliability.test.ts` | Applies a receipt with no channel wake and proves all carrier counters remain zero. |
| `sampling exports absolute counter deltas and leaves cumulative log counters intact` | Same name in `daemon-ws-reliability.test.ts` | Samples backstop, reconnect, and half-open after five then three events, asserting deltas `[5, 3]` while each cumulative log reaches event 8. |
| `monotonic WS exposure never exceeds its window and never goes negative` | Same name in `daemon-ws-reliability.test.ts` | Retains the exact connected/window sequence for open, disconnect, and regressing time, plus the nonnegative and bounded invariant. |

## Sub-400 implementation budget

The current loose bodies total roughly 401 nonblank lines because separate
methods repeatedly implement clear/arm/mark phases. The Module removes that
ceremony rather than copying it:

| Responsibility | Budget |
| --- | ---: |
| imports, types, native seam, fields, constructor | 75 |
| lifecycle + socket callbacks + reconnect/keepalive/pong | 90 |
| cursor cadence, reply and epoch fence | 65 |
| wake arbitration + receipt settlement + backstop | 70 |
| activity projection + health sampling | 75 |
| total | 375 |

Named collapses: startup/open/disconnect/caught-up activity projections share
one internal activity commit; keepalive/pong clear/arm share one liveness
transition; cursor invalidate/reset/stale/arm become epoch transition + one
schedule operation; backstop start/next/arm becomes one schedule operation;
carrier raise/take/discard/credit and catch-up restoration become receipt mint
and settle. If the faithful implementation exceeds 400 nonblank, implementation
stops and the design is re-framed; no helper-file split or size re-pin is allowed.

Gates, exit-code checked: focused channel and daemon reliability tests; one
adversarial review round that executes code/tests and rollup zero (maximum three
rounds); `bun test src/cli/daemon src/cli/sync`; repository typecheck;
whole-file oxlint plus `bun run lint:affected` at zero warnings; file-size gate
with no allowlist/ratchet edit and measured nonblank deltas; final symbol/log
move-fidelity audit; and direct `bun scripts/rig/rig.ts run two-device-live`
after `sg docker` fallback if needed.
