# 170 — Sync delivery-gap: WebSocket-health telemetry (Phase 1) + gap recovery (Phase 2)

Status: **v2 — pending review**
Owner: Claude (founder-directed, 2026-07-20)
Origin: field report — a paying-adjacent user (Max) observed a small commit
taking ~4 minutes to propagate between two of his machines.

**Reframe from v1 (r1 finding 17):** this is a *hypothesis consistent with the
timing*, not a confirmed root cause. The keepalive mechanism below is proven in
code; the field attribution is not, and Max's two-machine logs are still
pending. The design is therefore split so the part that does not depend on the
root cause ships first and *is what confirms the hypothesis fleet-wide*:

- **Phase 1 (ship now): honest fleet WS-health telemetry.** Does not assume the
  cause. Turns the one-off "ask the user to paste logs" into a standing fleet
  signal. This is the deliverable that tells us whether — and how often — the
  delivery gap actually happens.
- **Phase 2 (gated on field confirmation): delivery-gap recovery.** Only built
  if Phase 1 (or Max's logs) confirms alive-socket-but-behind is a real,
  recurring mode. Mechanism reworked to be DO-wake-only (r1 finding 4).

## Problem (field evidence)

A single small commit took ~4 minutes to appear on a second machine. The
healthy path is sub-second: a push settles in 0.4–3 s (`src/cli/daemon/watcher.ts:210-211`),
the server broadcasts a `committed` frame **synchronously** on commit
(`apps/api/src/workspace-sync.ts:689-718`), and the receiver pulls immediately
on that frame — the `committed` type branch is `daemon.ts:2194`, the
`request("pull")` at `daemon.ts:2197`.

~4 minutes is one **backstop-poll** cycle: `POLL_BACKSTOP_DEFAULT_MS = 300_000`,
subsequent ticks ±25 % = 3.75–6.25 min (`src/cli/daemon/policy.ts:26`,
`daemon.ts:2280-2286`; first tick is uniform `[0, interval)`).

### The proven mechanism: liveness is decoupled from delivery

The server registers a Cloudflare **edge auto-response** for keepalives
(`apps/api/src/workspace-sync.ts:124-127`):

```
this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
```

The client pings every `WS_PING_MS = 25_000` (`daemon.ts:2221-2230`). The edge
answers `pong` **without waking the Durable Object**, and Bun delivers that
text `pong` through the client `message` listener (`daemon.ts:2324-2326`), which
re-arms the half-open deadline *before* recognizing it as a pong
(`daemon.ts:2184-2190`); the protocol `pong` event re-arms too
(`daemon.ts:2327-2330`). Default deadline `WS_PONG_DEADLINE_DEFAULT_MS = 60_000`
(`policy.ts:25`). Therefore:

- **Liveness (pong) is decoupled from delivery (`committed` frames).** An
  application auto-pong keeps the no-frame deadline from ever firing.
- **Half-open detection (`onPongDeadline`, `daemon.ts:2252`) cannot fire while
  auto-pongs arrive** — it only triggers when *no* frame at all arrives for
  60 s (a fully-dead pipe), not a pipe that drops one `committed` frame.
- **For a genuinely missed `committed` frame on an otherwise-open socket, the
  only recovery is the 5-min backstop.** (Precisely: "only recovery" holds for
  an idle daemon whose socket stays open and which gets no other pull trigger —
  a later local change, reconnect, or safety scan would also recover it.)

The broadcast itself is correct — `ctx.getWebSockets()` survives hibernation
(`ws-fanout.ts:27`), non-OPEN/over-age sockets are skipped, and a per-socket
`send` throw is swallowed so one dead socket can't abort the fanout
(`ws-fanout.ts:37-41`). That swallow (`ws-fanout.ts:39`) is the one *unhandled*
way a single frame is silently lost to an otherwise-healthy connection. Other
candidate triggers are already self-healing and are **not** evidence of a
persistent gap (r1 finding 17): a reconnect race is followed by an unconditional
catch-up pull on new open (`daemon.ts:2315-2322`), and hibernation is supported
by accepted hibernatable sockets + `getWebSockets`. **Whether Max hit a real
alive-socket delivery gap is unconfirmed until logs; Phase 1 is how we find
out.**

### Second problem: the failure mode is invisible fleet-wide

The design-120 pipeline (`POST /v1/telemetry` → Analytics Engine,
`apps/api/src/telemetry-ingest.ts`) records five client kinds
(`src/cli/telemetry/contract.ts:27-66`). But:

- The `propagation` apply-delay metric is recorded **only when a `committed`
  frame set `notifyPendingAt`** (`daemon.ts:1371-1373`, stamp at
  `daemon.ts:2194-2197`). A backstop-carried pull emits **no** `propagation`
  sample. The panel is survivorship-biased to the fast path.
- The WS-health counters that would reveal the gap — `wsReconnects`,
  `wsBackstopPulls`, `wsHalfOpenDetected` (`daemon.ts:295-297`) and raw
  `notify_latency_ms` (`daemon.ts:965-969`) — are **log-only** (reconnect log
  `daemon.ts:2144-2145`, half-open `daemon.ts:2255`, backstop `daemon.ts:2283`).
  No telemetry path. That is why diagnosing Max needs hand-pasted logs.

## Goals

1. **Make the failure mode observable fleet-wide** (Phase 1): upload honest
   WS-health signal so a delivery gap shows up as a fleet trend, not a support
   anecdote. Value scales with the user base, and it is the data source for a
   future alerting cron (see Future work).
2. **Bound worst-case propagation** when a `committed` frame is missed (Phase 2,
   gated), without shortening the 5-min backstop fleet-wide and without polling
   every idle daemon over the authenticated HTTP path.
3. **Self-heal on upgrade.** The WS layer holds no persisted state; every daemon
   restart re-establishes the socket fresh. Both phases ship as ordinary
   binaries that resolve on `rbox upgrade` / stop-start, nothing to migrate.

## Phase 1 — honest fleet WS-health telemetry

### New `ws_health` telemetry kind (additive; existing families untouched)

Adding a *new* kind does not shift any existing family's positional doubles
(r1 verified non-finding). It is emitted on the existing 120 s flush timer
(`daemon.ts:124,1477-1481`), gated by `RBOX_TELEMETRY` opt-out
(`contract.ts:19-21`).

Fields (declaration order is load-bearing = AE `doubles` order,
`telemetry-ingest.ts:24-27`). **All fields must be valid at zero observations**
(the validator requires every declared number, `telemetry-ingest.ts:133-138`),
and daemon-side percentiles are *not* sent — a percentile-of-percentiles is not
composable into a fleet percentile (r1 finding 12). Instead we send count + sum
+ max so the cockpit can compute fleet mean/max and a real distribution later:

```
ws_health:
  numbers (interval deltas since last successful flush, all ≥ 0, valid at 0):
    windowMs                 // wall time this sample covers (for rate denominators)
    wsReconnects
    wsHalfOpenDetected
    backstopAttempts         // every scheduled backstop tick (was wsBackstopPulls)
    backstopAppliedPulls     // backstop ticks whose pull APPLIED a change
    cursorAppliedPulls       // Phase 2; always 0 until Phase 2 ships
    notifyAppliedPulls       // committed-carried pulls that applied a change
    notifyLatencyCount       // # of notify_latency_ms observations this window
    notifyLatencySumMs       // Σ notify_latency_ms (fleet mean = Σsum/Σcount)
    notifyLatencyMaxMs       // max (0 when count==0)
  enums: []
```

Rationale for the count fields (r1 finding 13): the old `wsBackstopPulls`
increments on *every* tick before `request("pull")` (`daemon.ts:2280-2285`), so
every healthy idle account has a steady backstop-attempt rate. "A sync had to be
carried by the backstop" is `backstopAppliedPulls`, not attempts. The alert
signature (a workspace repeatedly getting changes via backstop instead of
notify) is `backstopAppliedPulls / (backstopAppliedPulls + notifyAppliedPulls)`
— a real ratio with a real denominator, not attempt volume.

### Counter bookkeeping (r1 findings 10, 11)

- The existing counters stay **absolute/cumulative** so the log lines remain
  truthful running counts (`daemon.ts:2144,2255,2283` unchanged). Interval
  deltas are derived against a `lastFlushedBaseline` snapshot taken **only after
  a flush is acknowledged 2xx** — never on enqueue.
- The queue entry is an **additive accumulator**, not "coalesced like
  capability" (which overwrites, `queue.ts:40-50`). On a failed/deferred flush
  (network throw / 429 / 5xx, `queue.ts:61-85`, `retries:0`) the pending sample
  is *retained and the next interval's deltas are added into it*, so the outage
  the metric is meant to diagnose does not erase itself. Baseline advances only
  on ack.
- Restart/overflow: on daemon boot counters start at 0 and baseline at 0 (a
  restart just emits one short window; acceptable). Counters are monotonic
  within a boot.

### Wire + drift safety (r1 findings 2, 15)

- No change to the `propagation` sample. We do **not** append `carriedBy` to it
  (r1 finding 2: the server allow-lists exact keys and requires every enum, so
  appending a required field breaks mixed-version rollout in both directions;
  r1 finding 3: a carried pull has no honest `deliveryToApplyMs` anyway). The
  carried-vs-notify story lives entirely in the `ws_health` counts above.
- Mirror the schema in **both** `TELEMETRY_SAMPLE_SCHEMAS`
  (`src/cli/telemetry/contract.ts`) and `SERVER_TELEMETRY_SAMPLE_SCHEMAS`
  (`apps/api/src/telemetry-ingest.ts`).
- Extend the hard-coded AE-layout test (`apps/api/test/telemetry-ingest.test.ts:76-95`)
  to assert the exact `ws_health` doubles positions, and add an **ordered**
  field-name comparison for every family (the current drift test compares
  objects, which ignores order — `test:61-67`).
- Add a queue ring for `ws_health` in `queue.ts` and AE index/blob1
  `client.ws_health` via the existing `emitClientMetric` (`telemetry-ingest.ts:101`).

### Cockpit (Phase 1) — fleet-only (r1 finding 1)

Design 120 forbids account/device/workspace identifiers in AE
(`docs/design/120-telemetry-ingest.md:79-97`), so **there is no per-account
grouping** and no per-account red tile. Part C is fleet-only:
- `fetchWsHealth` in `rbox-admin/src/lib/server/client-telemetry.ts` reading
  `index1='client.ws_health'`: fleet backstop-carried ratio, reconnect rate,
  half-open rate, notify-latency mean/max — all over the `windowMs`
  denominator, 7-day trend.
- A "Sync delivery health" panel in `ClientTelemetryPanels.svelte` under "Sync
  experience", trending the backstop-carried ratio. A rising fleet ratio is the
  signal that the delivery gap is real and worsening.
- Per-account attribution, if later required, needs a separate
  privacy-reviewed path (D1, not AE) — explicit **non-goal** here.

## Phase 2 — delivery-gap recovery (GATED on field confirmation)

Built only if Phase 1 or Max's logs confirm a recurring alive-socket-but-behind
mode. Mechanism reworked from v1's HTTP `/head` (r1 findings 4, 9) to a
**WebSocket control frame**, which the socket already authenticated at connect —
no per-check directory/account/workspace D1 auth work, no new HTTP route:

- **Cursor frame.** Client sends a non-`ping` text frame (e.g. `cursor`) which
  is *not* the auto-response key, so it falls through to `webSocketMessage`,
  wakes the DO, which replies `{ head: <sequence> }` from KV
  (`workspace-sync.ts` head write `689-693`, authoritative read `1187-1192`).
  Add a `cursor` action to the DO message dispatch (`workspace-sync.ts:160-184`)
  + a test; no Worker HTTP route changes.
- **Cursor correctness.** Client pulls iff `head > localAppliedSequence`, where
  the compared value is the current stream's `syncBase.lastSyncedSequence`
  (`src/cli/config.ts:129-142`; lower-sequence writes rejected `config.ts:545-579`;
  E2EE verifies the unsigned server head against the signed chain
  `src/cli/e2ee-remote.ts:449-480`). The head is only an untrusted wake hint;
  the normal pull retains all correctness checks.
- **Cadence — `WS_CURSOR_CHECK_MS`, target 45 s, with jitter** (r1 finding 5).
  Env override `RBOX_DAEMON_WS_CURSOR_CHECK_MS`; `0` disables; off entirely
  under `RBOX_DAEMON_WS_RELIABILITY_DISABLED=1` (parity, `daemon.ts:426-430`).
  Armed only while connected; reset (with fresh jitter) on every `committed`
  frame so a live pair pays nothing *during* live notifications. Honest residual
  cost: one DO-waking frame per notification gap ≥ cadence, plus one every
  cadence while idle-connected. This is DO-wake-only — no HTTP auth/D1 — which
  is the entire point of the mechanism change.
- **One in flight, bounded, generation-fenced** (r1 findings 6, 8). At most one
  cursor frame outstanding; a cursor-specific timeout well below cadence;
  self-schedule only after completion. Capture `(socket, wsGeneration)` before
  awaiting (`daemon.ts:2119-2137,2150-2153,2184-2187`); on reply, discard if the
  generation advanced; abort/clear on `committed`, disconnect, reset-halt, and
  `stop()` (`daemon.ts:649-684`) via a single `AbortController`; re-arm in
  `finally`. A stale completion must re-read the local sequence and skip if a
  newer pull already advanced it.
- **Failure = degrade-not-worse, no socket cycling** (r1 finding 7). A failed
  cursor frame is caught, logged, and the timer re-armed. It does **not** cycle
  the socket — cycling is left to the existing half-open/close/error paths, so
  an API/DO incident cannot trigger a fleet reconnect herd. Worst case falls
  back to today's exact 5-min backstop.
- **Attribution** (r1 finding 14). The daemon coalesces all pull reasons into one
  `want.pull` (`daemon.ts:703-713`) and clears the notify stamp at dequeue
  (`daemon.ts:963-979`). Define a queued **carrier token** with precedence
  `notify > cursor > backstop`, generation-tagged, carried through a failed pull
  until an *applying* success (then increment the matching `*AppliedPulls`
  counter) or explicitly discarded on a newer higher-precedence trigger. A no-op
  pull increments nothing. This makes the counts in Phase 1 unambiguous.

## Contracts

- `ws_health` fields + order fixed as above; valid at zero observations;
  interval deltas via ack-advanced baseline; additive accumulation on failed
  flush.
- Phase 2: `cursor` DO message → `{ head:number }`; client pulls iff
  `head > syncBase.lastSyncedSequence`; `WS_CURSOR_CHECK_MS` default 45_000 +
  jitter, env-overridable, disabled under the existing reliability switch; one
  in flight; generation-fenced; failure re-arms without cycling.

## Tests the implementation MUST write

**Phase 1**
1. `ws_health` round-trips through both contract copies; a bad field →
   `client.telemetry.drops`; the AE-layout test asserts exact doubles positions
   and ordered field names per family.
2. Additive accumulation across a **failed** flush: network-throw, 5xx, and 429
   across multiple 120 s intervals do **not** lose deltas; baseline advances only
   on 2xx.
3. Counters valid at zero: a reconnect/backstop-only window emits
   `notifyLatencyCount=0`, `notifyLatencyMaxMs=0`, no rejection.
4. Log lines stay absolute after a flush reset (cumulative counters unchanged).
5. `RBOX_TELEMETRY=0` emits no `ws_health`.
6. `backstopAppliedPulls` increments only when a backstop-carried pull applied a
   change; a no-op backstop tick increments only `backstopAttempts`.

**Phase 2 (when built)**
7. A dropped `committed` frame (fanout `send` stubbed no-op) → receiver pulls
   within `WS_CURSOR_CHECK_MS`, not at the backstop; `cursorAppliedPulls`
   increments once.
8. Live `committed` frames suppress cursor frames (no DO wake).
9. Blackholed cursor frame (no reply, not just 5xx) → bounded by the cursor
   timeout, one in flight, socket **not** cycled, backstop still fires on time.
10. Races: in-flight cursor vs `committed`, vs reconnect (generation bump), vs
    `stop()` — no double-apply, no false `cursorAppliedPulls`, no close of the
    replacement socket.

## Non-goals

- **Not** removing the edge auto-response (correct cheap-liveness / hibernation
  optimization; Phase 2 adds a delivery signal alongside it).
- **Not** shortening `POLL_BACKSTOP_DEFAULT_MS` as the fix (crude; adds
  fleet-wide poll load; still can't tell "alive but behind").
- **Not** per-account WS-health in AE (design-120 privacy contract). A future
  account-scoped path is a separate design.
- **Not** touching the commit sequencer, fanout enumeration, or E2EE.
- **Not** server-side root-causing the specific single-frame-drop trigger;
  Phase 2 recovers generically from a missed frame rather than chasing every way
  one can be missed. If Phase 1 telemetry later isolates one dominant trigger,
  that becomes a separate follow-up.

## Future work (adjacent, not in scope)

Phase 1's `ws_health` family is shaped to be **alert-friendly** (rates over an
explicit `windowMs` denominator). A follow-on design (171) can add a Cloudflare
**scheduled worker** that runs the same AE SQL the cockpit uses and posts to a
**Slack incoming webhook** when a fleet threshold trips (e.g. backstop-carried
ratio, 5xx, ingest drops), with simple per-alert state to avoid re-paging. The
cron + AE-query pieces already exist (diagnostics sweep uses a scheduled
handler; the cockpit already queries AE); the only new dependency is the Slack
webhook secret. Gated behind this PR landing so the alert queries target real
`ws_health` data.

## Open decision (pending field logs)

Max's two-machine log grep (`notify_latency_ms | ws backstop pull | ws half-open
| ws_reconnect | ws connected | pull applied | push: published`) confirms the
failure-mode mix: predominantly `ws backstop pull` with **no** half-open/reconnect
churn ⇒ alive-socket delivery gap (Phase 2's target). Heavy half-open/reconnect
churn ⇒ a dead-socket component, which would instead motivate keepalive/pong
tuning. **Phase 1 ships regardless** and quantifies this fleet-wide; the Phase 2
`WS_CURSOR_CHECK_MS` cadence is the one knob to set once field data exists.
