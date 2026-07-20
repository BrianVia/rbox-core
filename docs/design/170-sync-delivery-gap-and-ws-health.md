# 170 — Sync delivery-gap: WebSocket-health telemetry (Phase 1) + gap recovery (Phase 2)

Status: **v3 — pending review**
Owner: Claude (founder-directed, 2026-07-20)
Origin: field report — a paying-adjacent user (Max) observed a small commit
taking ~4 minutes to propagate between two of his machines.

**v3 fold (closes REVIEW-170-R2 findings 19–24):** cursor server contract pinned
to `webSocketMessage` (not the HTTP dispatch); counter bookkeeping reworked to a
non-double-counting queue-owned accumulator with explicit at-least-once
transport; single cursor-timer-epoch; **carrier-attribution machinery moved into
Phase 1** (it is required for the applied-pull counts); the fleet signal
relabeled as a broad non-notify recovery proxy with a WS-connected exposure
denominator and alert threshold; `windowMs`/latency-sum domains + monotonic clock
+ cockpit formulas pinned.

**Reframe (r1 finding 17):** this is a *hypothesis consistent with the timing*,
not a confirmed root cause. The keepalive mechanism below is proven in code; the
field attribution is not, and Max's two-machine logs are pending. The design is
split so the part that does not depend on the root cause ships first and *is
what confirms the hypothesis fleet-wide*:

- **Phase 1 (ship now): honest fleet WS-health telemetry** + the notify/backstop
  carrier-attribution needed to count applied pulls correctly.
- **Phase 2 (gated on field confirmation): delivery-gap recovery** via a WS
  cursor frame. Only built if Phase 1 or Max's logs confirm alive-socket-but-
  behind is real and recurring.

## Problem (field evidence)

A single small commit took ~4 minutes to appear on a second machine. The healthy
path is sub-second: a push settles in 0.4–3 s (`src/cli/daemon/watcher.ts:210-211`),
the server broadcasts a `committed` frame **synchronously** on commit
(`apps/api/src/workspace-sync.ts:689-718`), and the receiver pulls immediately —
the `committed` type branch is `daemon.ts:2194`, the `request("pull")` at
`daemon.ts:2197`.

~4 minutes is one **backstop-poll** cycle: `POLL_BACKSTOP_DEFAULT_MS = 300_000`,
subsequent ticks ±25 % = 3.75–6.25 min (`policy.ts:26`, `daemon.ts:2280-2286`;
first tick uniform `[0, interval)`).

### The proven mechanism: liveness is decoupled from delivery

The server registers a Cloudflare **edge auto-response** for keepalives
(`apps/api/src/workspace-sync.ts:124-127`):

```
this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
```

The client pings every `WS_PING_MS = 25_000` (`daemon.ts:2221-2230`). The edge
answers `pong` **without waking the Durable Object**; Bun delivers that text
`pong` through the client `message` listener (`daemon.ts:2324-2326`), which
re-arms the half-open deadline *before* recognizing it as a pong
(`daemon.ts:2184-2190`); the protocol `pong` event re-arms too
(`daemon.ts:2327-2330`). Default deadline `WS_PONG_DEADLINE_DEFAULT_MS = 60_000`
(`policy.ts:25`). Therefore:

- **Liveness (pong) is decoupled from delivery (`committed` frames).** An
  application auto-pong keeps the no-frame deadline from ever firing.
- **Half-open detection (`onPongDeadline`, `daemon.ts:2252`) cannot fire while
  auto-pongs arrive** — it only triggers when *no* frame at all arrives for 60 s
  (a fully-dead pipe), not a pipe that drops one `committed` frame.
- **For a genuinely missed `committed` frame on an otherwise-open socket, the
  only recovery is the 5-min backstop.** (Precisely: "only recovery" holds for an
  idle daemon whose socket stays open and which gets no other pull trigger — a
  later local change, reconnect, or safety scan would also recover it.)

The broadcast itself is correct — `ctx.getWebSockets()` survives hibernation
(`ws-fanout.ts:27`), non-OPEN/over-age sockets skipped, and a per-socket `send`
throw is swallowed so one dead socket can't abort the fanout (`ws-fanout.ts:37-41`).
That swallow (`ws-fanout.ts:39`) is the one *unhandled* way a single frame is
silently lost to an otherwise-healthy connection. Other candidate triggers are
already self-healing and are **not** evidence of a persistent gap (r1 finding 17):
a reconnect race is followed by an unconditional catch-up pull on new open
(`daemon.ts:2315-2322`), and hibernation is supported by accepted hibernatable
sockets + `getWebSockets`. **Whether Max hit a real alive-socket delivery gap is
unconfirmed until logs; Phase 1 is how we find out.**

### Second problem: the failure mode is invisible fleet-wide

The design-120 pipeline (`POST /v1/telemetry` → Analytics Engine,
`apps/api/src/telemetry-ingest.ts`) records five client kinds
(`src/cli/telemetry/contract.ts:27-66`). But:

- `propagation` apply-delay is recorded **only when a `committed` frame set
  `notifyPendingAt`** (`daemon.ts:1371-1373`, stamp `daemon.ts:2194-2197`). A
  backstop-carried pull emits **no** `propagation` sample. The panel is
  survivorship-biased to the fast path.
- The WS-health counters that would reveal the gap — `wsReconnects`,
  `wsBackstopPulls`, `wsHalfOpenDetected` (`daemon.ts:295-297`) and raw
  `notify_latency_ms` (`daemon.ts:965-969`) — are **log-only** (reconnect
  `daemon.ts:2144-2145`, half-open `daemon.ts:2255`, backstop `daemon.ts:2283`).
  No telemetry path. That is why diagnosing Max needs hand-pasted logs.

## Goals

1. **Observable fleet-wide** (Phase 1): upload honest WS-health signal so a
   delivery gap shows up as a fleet trend. Data source for a future alert cron
   (design 171: scheduled worker → `pingns(env, "fleet_alert", …)` via the
   existing `apps/api/src/ns.js` #rbox-alerts webhook; gated behind this PR).
2. **Bound worst-case propagation** when a `committed` frame is missed (Phase 2,
   gated), without shortening the backstop fleet-wide and without polling every
   idle daemon over the authenticated HTTP path.
3. **Self-heal on upgrade.** The WS layer holds no persisted state; every restart
   re-establishes the socket fresh. Both phases ship as ordinary binaries.

## Phase 1 — WS-health telemetry + carrier attribution

### Carrier attribution (required in Phase 1; r2 finding 22)

The daemon coalesces all pull reasons into one `want.pull` boolean
(`daemon.ts:703-713`) and clears the notify stamp at dequeue before running the
pull (`daemon.ts:947-973`). To count *which mechanism carried an applied change*,
Phase 1 adds a carrier token with **separate queued and active state**:

- `queuedCarrier` on the pending pull, and a dequeue-local `activeCarrier`.
- A trigger merges into `queuedCarrier` by **precedence** `notify > backstop`
  (Phase 2 inserts `cursor` between them). At dequeue, `activeCarrier =
  queuedCarrier`; `queuedCarrier` resets to `none`.
- On pull **failure**, merge `activeCarrier` back into `queuedCarrier` by
  precedence (attribution is not lost to a transient failure).
- On an **applying** success only — `pull()` calls `onPullApplied` iff its
  reconciled `actions` array is non-empty (`src/cli/sync/pull.ts:196-209,311-319`;
  hook at `daemon.ts:1337-1348,1781-1799`) — increment the matching
  `*AppliedPulls` for `activeCarrier`, then consume it. A **no-op** pull
  increments nothing. "Applied" means a local file-tree action, never merely
  advancing `lastSyncedSequence`.
- A WS **generation change** (`daemon.ts:2119-2137`) discards any stale queued
  WS-origin carrier.
- **Non-carrier pulls use `none` and neither inherit nor consume a token:**
  startup pull (`daemon.ts:473-484`), reconnect catch-up (`daemon.ts:2315-2322`),
  and push-internal conflict recovery (`daemon.ts:1117-1140`). This prevents a
  reconnect-applied change from being falsely counted as backstop-applied.

Phase 2 adds only the `cursor` carrier and its precedence slot.

### New `ws_health` telemetry kind (additive; existing families untouched)

A *new* kind does not shift any existing family's positional doubles (r2 verified
non-finding). Emitted on the existing 120 s flush timer (`daemon.ts:124,1477-1481`),
gated by `RBOX_TELEMETRY` opt-out (`contract.ts:19-21`).

Fields — declaration order is load-bearing (= AE `doubles` order,
`telemetry-ingest.ts:24-27`). **Every field is valid at zero** (the validator
requires each declared number, `telemetry-ingest.ts:133-138`); daemon-side
percentiles are *not* sent (a percentile-of-percentiles is not fleet-composable —
r1 finding 12). Interval deltas, not absolutes:

```
ws_health:
  numbers (all integers ≥ 0, valid at 0):
    windowMs               // monotonic elapsed wall time this sample covers
    wsConnectedMs          // subset of windowMs the socket was OPEN (honest
                           //   denominator for socket-health claims; r2 #23/#24)
    wsReconnects
    wsHalfOpenDetected
    backstopAttempts       // every scheduled backstop tick (was wsBackstopPulls)
    backstopAppliedPulls   // backstop-carried pulls that applied a change
    cursorAppliedPulls     // Phase 2; always 0 until Phase 2 ships (reserved slot)
    notifyAppliedPulls     // committed-carried pulls that applied a change
    notifyLatencyCount     // # of notify_latency_ms observations this window
    notifyLatencySumMs     // Σ notify_latency_ms (own sum domain, not single-obs MS)
    notifyLatencyMaxMs     // max (0 when count==0)
  enums: []
```

Field domains (r2 finding 24): `windowMs`/`wsConnectedMs` use a **monotonic
elapsed clock** (not the injectable `Date.now`, which can jump — `daemon.ts:401-425`),
so no negative intervals; a window exceeding the 7-day `MS` domain
(`contract.ts:9-10`) saturates at that max (a >7-day flush is degenerate). Count
fields cap at a per-window sane bound. `notifyLatencySumMs` gets its own sum
domain (multiple observations), distinct from the single-observation `MS` max.

### Counter bookkeeping — no double-count, at-least-once (r2 finding 20)

The existing counters stay **absolute/cumulative** so the log lines remain
truthful running counts (`daemon.ts:2144,2255,2283` unchanged). Export state is
separate and does **not** wait on ack:

- Keep a `lastSampledAbsolute` per counter. **Every** 120 s sampling tick computes
  `delta = absolute − lastSampledAbsolute`, sets `lastSampledAbsolute = absolute`,
  and **adds** `delta` into a queue-owned pending accumulator. The high-water
  advances every tick, so a delta is never re-derived from a stale baseline (this
  was the v2 double-count bug: a failed flush left the baseline at 0 and the next
  tick re-derived the full absolute).
- On flush, snapshot the accumulator and send that snapshot. On **202**, subtract
  the exact snapshot from the accumulator; deltas added *during* the in-flight
  request stay pending. On **failure** (throw/429/5xx, retained per
  `queue.ts:61-85`, `retries:0`) the accumulator keeps snapshot + new deltas and
  resends next interval — the diagnostic outage does not erase its own evidence.
- Pin `ws_health` **above** the 64-sample batch cap priority so it is never the
  family silently dropped (`queue.ts:64-73`).
- **Transport is at-least-once.** The envelope has no sample-id/idempotency key
  (`contract.ts:94-100`), so an accepted-but-response-lost flush resends and
  over-counts at AE. We accept a rare small over-count for a health metric rather
  than risk loss; the cockpit treats counts as at-least-once. (A future
  idempotency key is out of scope.)
- Restart: on boot, counters and `lastSampledAbsolute` start at 0; one short
  window is emitted. Counters are monotonic within a boot.

### Wire + drift safety (r1 findings 2, 15)

- No change to `propagation` (r1 findings 2, 3). The carried-vs-notify story lives
  entirely in `ws_health` counts.
- Mirror the schema in **both** `TELEMETRY_SAMPLE_SCHEMAS` (`contract.ts`) and
  `SERVER_TELEMETRY_SAMPLE_SCHEMAS` (`telemetry-ingest.ts`); **server-first**
  rollout so an old server drops unknown `ws_health` cleanly
  (`telemetry-ingest.ts:200-216`) without affecting other samples.
- Extend the hard-coded AE-layout test (`test/telemetry-ingest.test.ts:76-95`) to
  assert exact `ws_health` doubles positions, and add an **ordered** field-name
  comparison for every family (the current drift test compares objects, ignoring
  order — `test:61-67`).
- AE index/blob1 `client.ws_health` via `emitClientMetric` (`telemetry-ingest.ts:101`).

### Cockpit (Phase 1) — fleet-only (r1 finding 1)

Design 120 forbids account/device/workspace IDs in AE
(`docs/design/120-telemetry-ingest.md:79-97`), so there is **no per-account
grouping** and no per-account tile. Fleet-only:
- `fetchWsHealth` in `rbox-admin/src/lib/server/client-telemetry.ts` reading
  `index1='client.ws_health'`.
- Cockpit formulas are explicit (r2 finding 24): event rates =
  `SUM(count) / NULLIF(SUM(windowMs),0)`; notify mean =
  `SUM(notifyLatencySumMs) / NULLIF(SUM(notifyLatencyCount),0)`; fleet max =
  `MAX(notifyLatencyMaxMs)`; zero denominator → no-data, not zero.
- **Signal semantics (r2 finding 23).** The Phase-1 headline is a *broad
  non-notify recovery proxy*, explicitly **not** proof of an alive-socket gap
  (the backstop runs even when the WS is disabled/disconnected —
  `daemon.ts:424-432,487-490,2293-2295`): `backstopAppliedPulls /
  (backstopAppliedPulls + notifyAppliedPulls)`, **shown against `wsConnectedMs`
  exposure** so WS-disabled/disconnected time is visible and separable. It is
  labeled as "changes arriving via recovery rather than live notify," and it is
  the trend that says *look closer / ask for logs* — not a confirmed incident.
  Alerting requires a minimum event/exposure threshold so one sparse carried pull
  is not a fleet incident.
- Per-account attribution, if later needed, is a separate privacy-reviewed D1
  path — explicit **non-goal** here.

## Phase 2 — delivery-gap recovery (GATED on field confirmation)

Built only if Phase 1 or Max's logs confirm a recurring alive-socket-but-behind
mode. Mechanism is a **WebSocket control frame** (socket already authenticated at
connect — no per-check auth/D1, no new HTTP route):

- **Server contract — pinned to `webSocketMessage` (r2 finding 19).** A non-`ping`
  text frame bypasses the exact `"ping"→"pong"` auto-response and is delivered to
  the DO's hibernation `webSocketMessage(ws, message)` handler — currently empty
  (`workspace-sync.ts:1314-1327`), **not** the HTTP `fetch()` dispatch at
  `160-184`. Implement there: accept only exact text `"cursor"` (ignore
  binary/unknown), synchronously read
  `readHead(this.ctx.storage.kv.get("head")).sequence`, and
  `ws.send(JSON.stringify({ head }))` with send failure contained. No
  `ensureBootstrap`/HTTP dispatch — a KV-only read. Test the hibernation callback
  surface and the exact response, not a fabricated `fetch()` action.
- **Cursor correctness.** Client pulls iff `head > localAppliedSequence`, compared
  against the current stream's `syncBase.lastSyncedSequence` (`config.ts:129-142`;
  lower-sequence writes rejected `config.ts:545-579`; E2EE verifies the unsigned
  head against the signed chain `e2ee-remote.ts:449-480`). The head is only an
  untrusted wake hint; the normal pull keeps all correctness checks.
- **Cadence — `WS_CURSOR_CHECK_MS` target 45 s, jittered.** Env override
  `RBOX_DAEMON_WS_CURSOR_CHECK_MS`; `0` disables; off under
  `RBOX_DAEMON_WS_RELIABILITY_DISABLED=1` (parity, `daemon.ts:426-430`). Armed
  only while connected; reset (fresh jitter) on every `committed` frame. Honest
  residual: one DO-waking frame per notification gap ≥ cadence, plus one every
  cadence while idle-connected. DO-wake-only — no HTTP auth/D1.
- **Single timer owner + scheduling epoch (r2 finding 21).** One timer owns the
  cursor schedule. Every reset (committed frame) increments a `cursorEpoch` and
  installs the sole timer, replacing any prior. A completion/`finally` may re-arm
  **only if** its captured epoch is still current and no newer handler armed a
  timer. Prevents the two-owner duplicate-wake race.
- **One in flight, bounded, generation-fenced (r2 findings 6, 8).** At most one
  cursor frame outstanding; a cursor-specific timeout below cadence; self-schedule
  after completion. Capture `(socket, wsGeneration, cursorEpoch)` before awaiting;
  discard a reply whose generation/epoch advanced; abort/clear on `committed`,
  disconnect, reset-halt, `stop()` (`daemon.ts:649-684`) via one `AbortController`
  (which cancels the local waiter, not an in-flight frame — hence the epoch fence).
  A stale completion re-reads the local sequence and skips if a newer pull already
  advanced it.
- **Failure = degrade-not-worse, no socket cycling (r1 finding 7).** A failed
  cursor frame is caught, logged, timer re-armed. It does **not** cycle the socket
  — cycling stays with the existing half-open/close/error paths, so an API/DO
  incident cannot trigger a fleet reconnect herd. Worst case = today's 5-min
  backstop exactly.
- **Attribution.** Phase 2 inserts `cursor` into the precedence chain
  (`notify > cursor > backstop`) and increments `cursorAppliedPulls` on an
  applying cursor-carried pull, reusing the Phase-1 token machinery.
- **Post-Phase-2 health signal (r2 finding 23):**
  `(cursorAppliedPulls + backstopAppliedPulls) / (notifyAppliedPulls +
  cursorAppliedPulls + backstopAppliedPulls)`, with cursor and backstop shown
  separately — because cursor recovery would otherwise *mask* the gap in the
  backstop-only ratio.

## Contracts

- `ws_health` fields + order fixed as above; every field valid at zero; monotonic
  clock for windows; interval deltas via queue-owned accumulator; at-least-once.
- Carrier token: `queuedCarrier`/`activeCarrier`, precedence `notify > backstop`
  (Phase 2: `notify > cursor > backstop`); merge-back on failure; consume on
  applying success; `none` for startup/reconnect/push-recovery; generation-
  discard of stale WS carriers. **Phase 1.**
- Phase 2: `cursor` DO message handled in `webSocketMessage` → `{ head:number }`;
  client pulls iff `head > syncBase.lastSyncedSequence`; `WS_CURSOR_CHECK_MS`
  default 45_000 + jitter, env-overridable, disabled under the reliability switch;
  one in flight; epoch + generation fenced; failure re-arms without cycling.

## Tests the implementation MUST write

**Phase 1**
1. `ws_health` round-trips both contract copies; a bad field →
   `client.telemetry.drops`; the AE-layout test asserts exact doubles positions
   and ordered field names per family.
2. **No double-count across a failed flush:** with the absolute counter advancing
   5→8 while the first flush fails, the resend emits 8 total (not 13); throw, 5xx,
   and 429 across multiple intervals lose no deltas.
3. **In-flight concurrency:** deltas added while a flush is in flight remain
   pending and are not dropped by the 202 subtraction.
4. **Accepted-response-lost:** a resend after a lost 202 over-counts (documents
   at-least-once), never under-counts.
5. **Batch-cap:** `ws_health` is never the family dropped when >64 samples queue.
6. Counters valid at zero: a reconnect/backstop-only window emits
   `notifyLatencyCount=0`, `notifyLatencyMaxMs=0`, no rejection.
7. Log lines stay absolute after a sampling tick (cumulative counters unchanged).
8. `RBOX_TELEMETRY=0` emits no `ws_health`.
9. **Carrier attribution:** `backstopAppliedPulls` increments only on a
   backstop-carried *applying* pull; a no-op backstop tick increments only
   `backstopAttempts`; a reconnect/startup/push-recovery applied pull increments
   **neither** notify nor backstop; a notify pull that fails then a backstop pull
   that applies is attributed to backstop; precedence and merge-back hold.
10. `wsConnectedMs ≤ windowMs`; monotonic clock yields no negative interval.

**Phase 2 (when built)**
11. A dropped `committed` frame (fanout `send` stubbed no-op) → receiver pulls
    within `WS_CURSOR_CHECK_MS`, not at the backstop; `cursorAppliedPulls`
    increments once; the DO answers `"cursor"` from `webSocketMessage` only.
12. Live `committed` frames suppress cursor frames (no DO wake).
13. Blackholed cursor frame (no reply) → bounded by the cursor timeout, one in
    flight, socket **not** cycled, backstop still fires on time.
14. **Exactly one** subsequent timer/frame after committed-vs-cursor and
    reconnect-vs-cursor overlaps (epoch fence); no double-apply, no false
    `cursorAppliedPulls`, no close of the replacement socket.

## Non-goals

- **Not** removing the edge auto-response (correct cheap-liveness / hibernation
  optimization; Phase 2 adds a delivery signal alongside it).
- **Not** shortening `POLL_BACKSTOP_DEFAULT_MS` as the fix.
- **Not** per-account WS-health in AE (design-120 privacy contract).
- **Not** exactly-once telemetry (at-least-once, no idempotency key).
- **Not** touching the commit sequencer, fanout enumeration, or E2EE.
- **Not** server-side root-causing the specific single-frame-drop trigger; Phase 2
  recovers generically. If Phase 1 telemetry isolates one dominant trigger, that
  is a separate follow-up.

## Future work (adjacent, not in scope)

Design 171: a Cloudflare **scheduled worker** runs the same AE SQL the cockpit
uses and calls the existing `pingns(env, "fleet_alert", …)` primitive
(`apps/api/src/ns.js` → #rbox-alerts via `nS_ALERTS_WEBHOOK_URL`; self-gating,
never-throws; already used in `stripe.ts` and `apps/api/tail`) when a fleet
threshold trips, with per-alert dedup state. The cron + AE-query + Slack pieces
all already exist; 171 wires them to `ws_health`. Gated behind this PR landing.

## Open decision (pending field logs)

Max's two-machine grep (`notify_latency_ms | ws backstop pull | ws half-open |
ws_reconnect | ws connected | pull applied | push: published`) confirms the
failure-mode mix: predominantly `ws backstop pull` with **no** half-open/reconnect
churn ⇒ alive-socket delivery gap (Phase 2's target). Heavy half-open/reconnect
churn ⇒ a dead-socket component (keepalive/pong tuning instead). **Phase 1 ships
regardless** and quantifies this fleet-wide; the Phase 2 `WS_CURSOR_CHECK_MS`
cadence is the one knob to set once field data exists.
