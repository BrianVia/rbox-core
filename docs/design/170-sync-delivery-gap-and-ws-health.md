# 170 — Sync delivery-gap recovery + WebSocket-health telemetry

Status: **v1 — pending review**
Owner: Claude (founder-directed, 2026-07-20)
Origin: field report — a paying-adjacent user (Max) observed a small commit
taking ~4 minutes to propagate between two of his machines. Root-caused here to
a structural gap in the live-notification path, not a regression.

## Problem (field evidence)

A single small commit took ~4 minutes to appear on a second machine. The
healthy path is sub-second: a push settles in 0.4–3 s (watcher debounce,
`src/cli/daemon/watcher.ts:210-211`), the server broadcasts a `committed`
frame **synchronously** on commit (`apps/api/src/workspace-sync.ts:715`), and
the receiver pulls immediately on that frame (`src/cli/daemon/daemon.ts:2194`).

~4 minutes is one **backstop-poll** cycle: `POLL_BACKSTOP_DEFAULT_MS = 300_000`
±25 % = 3.75–6.25 min (`src/cli/daemon/policy.ts:26`, `daemon.ts:2280-2286`).
The receiver only fell to the backstop because the WebSocket `committed`
notification never arrived — yet the socket was *not* detected as dead.

### Why the socket looks healthy while dropping messages

The server registers a Cloudflare **edge auto-response** for keepalives:

```
this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
```
(`apps/api/src/workspace-sync.ts:126`)

The client pings every `WS_PING_MS = 25_000` (`daemon.ts:2221-2231`). The edge
answers `pong` **without waking the Durable Object**, and every inbound frame —
including that auto-pong — re-arms the client's half-open deadline
(`armPongDeadline`, `daemon.ts:2187`; default `WS_PONG_DEADLINE_DEFAULT_MS =
60_000`, `policy.ts:25`). So:

- **Liveness (pong) is decoupled from delivery (`committed` frames).** A socket
  can be perfectly "alive" per keepalive yet miss a broadcast. The client has
  no signal that it is behind.
- **Half-open detection cannot fire for this case** — the auto-pong keeps the
  deadline alive. `onPongDeadline` (`daemon.ts:2252`) only triggers when *no*
  frame (not even a pong) arrives for 60 s, i.e. only for a fully-dead pipe,
  not a lossy one.
- **The only recovery for a missed `committed` frame is the 5-min backstop.**

The broadcast itself is correct — it enumerates `ctx.getWebSockets()`
(`apps/api/src/ws-fanout.ts:27`), which survives hibernation, and swallows a
per-socket `send` failure so one dead socket can't abort the fanout
(`ws-fanout.ts:39-41`). That swallow is the point: **a dropped or failed
delivery to one receiver is silent and unrecoverable until the backstop.**
Candidate triggers for a single missed frame (exact mix to be confirmed from
field logs, see Non-goals / Open decision): a reconnect race (old socket
`CLOSING`, new socket not yet accepted at broadcast time — skipped at
`ws-fanout.ts:28`), a transient `ws.send` throw (`ws-fanout.ts:39`), or a
hibernation edge. The fix below is deliberately **independent of which
trigger** — it does not rely on delivery being reliable.

### Second problem: the failure mode is invisible fleet-wide

The design-120 telemetry pipeline (`POST /v1/telemetry` → Analytics Engine,
`apps/api/src/telemetry-ingest.ts`) records five client kinds — `propagation`,
`first_publish`, `upload_lane`, `capability`, `safety_event`
(`src/cli/telemetry/contract.ts:26-64`). The cockpit renders a "Client apply
delay" panel from `client.propagation`. But:

- `propagation` is recorded **only when `notifyPendingAt` is set**
  (`daemon.ts:1371-1372`), and `notifyPendingAt` is set in exactly one place —
  receipt of a `committed` WS frame (`daemon.ts:2196`). A **backstop-carried
  pull emits no `propagation` sample at all.** The apply-delay metric is
  survivorship-biased to the fast path; the slow syncs we care about are
  literally absent from it.
- The WS-health counters that *would* reveal the gap — `wsReconnects`,
  `wsBackstopPulls`, `wsHalfOpenDetected` (`daemon.ts:295-297`), and the raw
  `notify_latency_ms` value — are written **only to the local daemon log**
  (`daemon.ts:965-969, 2255, 2283`). No telemetry path exists. That is why
  diagnosing Max required asking him to paste logs by hand.

## Goals

1. **Bound worst-case propagation to ~one cursor interval (target ≤ 60 s)**
   even when a `committed` frame is missed, without relying on delivery
   reliability and without shortening the 5-min backstop fleet-wide.
2. **Make the failure mode observable fleet-wide** — upload WS-health and count
   backstop-carried syncs — so we can watch the fix land and catch regressions
   without a human in the loop. (Value scales with the user base.)
3. **Self-heal on upgrade.** The WS layer holds no persisted state; every
   daemon restart re-establishes the socket fresh. The fix must ship as an
   ordinary binary that resolves on `rbox upgrade` / stop-start, with nothing
   to migrate or reset.

## Mechanism

### Part A — delivery-gap recovery: an idle sequence cursor check

Add a client-driven **cursor check** that learns the server's head sequence and
pulls if the local applied sequence is behind — independent of whether any
`committed` frame was delivered.

- **Wire shape.** A lightweight request to the workspace DO that wakes it and
  returns the current head: `{ head: <sequence> }` (the DO already holds
  `head.sequence` in KV, `workspace-sync.ts:111,262`). Reuse the existing
  authenticated sync channel; this is a read of already-authorized state, no
  new privilege. Prefer a tiny HTTP `GET …/head` on the existing RboxApi over a
  new WS message type, so it is trivially testable and stateless. (Decision
  pinned: HTTP over a new WS frame — the WS frame would need its own
  request/response correlation; the head read is cheap and cacheless.)
- **Cadence — `WS_CURSOR_CHECK_MS`, target 45 s**, sitting between the 25 s
  keepalive and the 300 s backstop. Adaptive to avoid defeating hibernation
  fleet-wide:
  - Only armed while the WS is believed connected (when disconnected, reconnect
    already does a catch-up pull, `daemon.ts:2321`; the backstop covers the
    rest).
  - **Reset on every `committed` frame** (`daemon.ts:2194` path): a workspace
    receiving live notifications never pays for cursor checks. The check only
    fires during a notification *gap* — exactly the missed-frame case.
  - On a check that finds the client behind, emit a `propagation`-equivalent
    sample tagged as cursor-carried (see Part B) and `request("pull")`.
- **Cost.** Each fired check wakes the DO once. Because it fires only after
  `WS_CURSOR_CHECK_MS` of notification silence, an actively-syncing pair pays
  nothing; a fully-idle connected daemon wakes its DO ~1×/45 s (far cheaper
  than the alternative of removing the auto-response and waking on every 25 s
  ping). With the backstop retained as the ultimate safety net, this is purely
  additive latency reduction.

This is robust to **both** candidate failure modes: a missed fan-out (socket
alive, frame lost) is caught within `WS_CURSOR_CHECK_MS`; a truly dead socket
is still caught by the existing half-open path, and the cursor request failing
gives a second, faster signal to cycle.

Reliability, not correctness: like all notification-path logic, the cursor
check is an optimization over the backstop. If it fails, behavior degrades to
today's 5-min backstop — never worse.

### Part B — WebSocket-health + backstop-carried telemetry

Two additive changes to the design-120 pipeline (append-only; never reorder
existing fields — the declaration order is the positional AE `doubles` order,
`telemetry-ingest.ts:24-27`):

1. **New `ws_health` telemetry kind**, flushed on the existing 120 s timer
   (`TELEMETRY_FLUSH_MS`, `daemon.ts:124`), carrying the counters that are
   currently log-only:
   - numbers: `notifyLatencyP50Ms`, `notifyLatencyP95Ms` (from observed
     `notify_latency_ms` values since last flush), `wsReconnects`,
     `wsBackstopPulls`, `wsHalfOpenDetected`, `cursorBehindPulls` (Part A).
     These are deltas since last flush (counters snapshot-and-reset), so AE
     aggregation is additive.
   - Append the schema to **both** `TELEMETRY_SAMPLE_SCHEMAS`
     (`src/cli/telemetry/contract.ts`) and `SERVER_TELEMETRY_SAMPLE_SCHEMAS`
     (`apps/api/src/telemetry-ingest.ts`); the drift test that imports both
     copies keeps them in lockstep.
   - Add a queue ring in `src/cli/telemetry/queue.ts` (coalesced, like
     `capability`), gated by the existing `RBOX_TELEMETRY` opt-out
     (`contract.ts:19-21`).
   - AE index/blob1 `client.ws_health`; emit via the existing
     `emitClientMetric` path (`telemetry-ingest.ts:106`).

2. **Emit `propagation` on non-notification pulls.** Today `propagation` is
   skipped when `notifyPendingAt` is undefined (`daemon.ts:1371`). Extend it so
   a backstop- or cursor-carried pull that applies changes also records a
   `propagation` sample, with a new enum field `carriedBy`
   (`notify | cursor | backstop`). This makes slow syncs visible in the exact
   panel that currently hides them, and lets the cockpit split apply-delay by
   carrier. (Append `carriedBy` as a new trailing enum — existing
   `deliveryToApplyMs` number stays first.)

### Part C — cockpit panel (rbox-admin)

Add a "Sync delivery health" fetcher + panel:
- `fetchWsHealth` in `rbox-admin/src/lib/server/client-telemetry.ts` reading
  `index1='client.ws_health'` — fleet + per-account reconnect rate, backstop
  rate, half-open rate, cursor-behind rate, notify-latency p50/p95.
- Split the existing propagation panel by `carriedBy` so
  backstop/cursor-carried apply-delay is visible next to notify-carried.
- Panel in `rbox-admin/src/lib/components/ClientTelemetryPanels.svelte` under
  "Sync experience". A red tile when an account's backstop rate is high relative
  to its `committed`-notify rate — that is the signature of Max's situation and
  should surface without anyone pasting logs.

## Contracts

- `WS_CURSOR_CHECK_MS` (default 45_000) and env override
  `RBOX_DAEMON_WS_CURSOR_CHECK_MS`; `0` disables (parity with the existing
  `wsReliabilityDisabled` switch, `daemon.ts:426-430`). Under
  `RBOX_DAEMON_WS_RELIABILITY_DISABLED=1` the cursor check is off, matching the
  existing disabled semantics.
- `GET …/head` returns `{ head: number }`; the client pulls iff
  `head > localAppliedSequence`. No body, cacheless, authenticated as the
  existing device principal.
- `ws_health` sample fields and order fixed as above; `carriedBy` appended to
  `propagation`. Both mirrored in the server schema and covered by the
  contract-drift test.
- Counters (`wsReconnects`, `wsBackstopPulls`, `wsHalfOpenDetected`,
  `cursorBehindPulls`) become snapshot-and-reset deltas per flush; the local
  log lines are unchanged (still absolute running counts).

## Tests the implementation MUST write

1. **Cursor closes a missed-frame gap.** Simulate a `committed` frame that is
   dropped (server broadcasts to a socket whose `send` is stubbed to no-op);
   assert the receiver pulls within `WS_CURSOR_CHECK_MS`, not at the backstop.
2. **Cursor is suppressed under live notifications.** With `committed` frames
   arriving, assert zero cursor checks fire (no DO wake) — proves the adaptive
   reset.
3. **Backstop-carried pull emits `propagation carriedBy=backstop`.** The exact
   regression for the invisibility bug: a pull with `notifyPendingAt` undefined
   still records a sample.
4. **`ws_health` round-trips the schema** through both contract copies
   (extend the existing drift test) and is rejected/counted correctly by
   `telemetry-ingest.ts` (bad field → `client.telemetry.drops`).
5. **Opt-out honored.** `RBOX_TELEMETRY=0` emits no `ws_health`;
   `RBOX_DAEMON_WS_CURSOR_CHECK_MS=0` fires no cursor checks; behavior falls
   back to today's backstop exactly.
6. **Degrade-not-worse.** With the cursor endpoint returning 5xx/timeouts, the
   daemon still backstops on schedule and never wedges.

## Non-goals

- **Not** removing the edge auto-response (it is the correct cheap-liveness /
  hibernation optimization; the fix adds a delivery-gap signal alongside it,
  not instead of it).
- **Not** shortening `POLL_BACKSTOP_DEFAULT_MS` as the primary fix (crude, adds
  fleet-wide poll load, and still can't tell "alive but behind").
- **Not** touching the commit sequencer, fanout enumeration, or E2EE. This is
  notification-path reliability + observability only.
- **Not** server-side root-causing the specific single-frame-drop trigger in
  this doc. The fix is trigger-independent by design; if field telemetry later
  shows one dominant trigger (e.g. a reconnect race), that becomes a separate,
  smaller follow-up. This is the deliberate altitude choice: recover from a
  missed frame generically rather than chase every way one can be missed.

## Open decision (pending field logs)

Max's two-machine logs (grep of `notify_latency_ms | ws backstop pull |
ws half-open | ws_reconnect | ws connected | pull applied | push: published`)
will confirm the failure-mode mix: predominantly `ws backstop pull` with **no**
`ws half-open`/`ws_reconnect` churn ⇒ missed-fanout (this doc's primary target,
cursor check is the fix); heavy half-open/reconnect churn ⇒ a dead-socket
component too, which would additionally motivate revisiting keepalive/pong
tuning. The **telemetry half (Parts B/C) ships regardless** — it is what turns
that one-off log grep into a standing fleet signal. The cursor cadence
(`WS_CURSOR_CHECK_MS`) is the one tunable to revisit once the field data
quantifies the gap.
```
