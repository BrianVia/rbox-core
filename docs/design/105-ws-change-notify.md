# Design 105 — WebSocket change notification (notify-only hint channel)

## Status

Design pass + codex adversarial review (see `REVIEW-105.md`). **Retroactive**:
a WS notification channel already ships and has since the first daemon
(`M1`, commit `d87e29d9`) with the server-side fanout added by design 59
(`c43ace26`). It was never formally designed, has no measurement, no poll
backstop, no half-open liveness detection, and no kill switch. This document
(a) formalizes the invariants the existing channel must obey, (b) closes the
reliability gaps that make propagation latency unbounded in the field, and
(c) sets falsifiable gates. **Implementation waits for design 84 (manifest
delta) and design 102-enforce to land** — both touch the DO commit hot path
this design binds to; §9 sequences it. This design changes NO commit-path or
correctness code; the only new server surface is a socket-lifetime cap.

Bind to invariants and interfaces below, NOT to line numbers — the DO commit
path is under active change (84 build, 102 enforce, 103's `earlyStaleReject`
already precedes the CAS).

## 1. Problem and the number this kills

Measured ground truth (founder's `Brian.md` experiment, 2026-07-12 00:08–00:10Z):
keystroke→other-host = **41.5s**, receiver side **16.4s**. As the perf program
lands (102: commit ~12s→~2s; 84: manifest 41MB→single-digit; 85: pull
rescan→O(actions)), propagation latency becomes dominated by *when the receiver
learns a commit exists*.

**What actually exists today (the honest baseline):** a receiver learns of a
remote commit ONLY through the live WS `committed` frame, plus a one-shot
catch-up pull on socket (re)connect. There is **no periodic poll of `/latest`**
on a passive receiver:

- `request("pull")` fires from exactly three places: initial convergence, the
  WS `committed` handler, and the reconnect `open` handler.
- The safety scan (design 49/85, 60s→5m) and deep scan (30m) reconcile the
  LOCAL tree and only ever `requestPush()`. A no-op push on a receiver with no
  local changes **short-circuits before any network call** (`pushManifest`'s
  "nothing changed vs last-synced" guard) — so it is NOT a remote poll.
- The keepalive sends an app-level `"ping"` every 25s but **nothing verifies a
  `"pong"` came back**. A silently half-open socket (NAT/proxy idle-drop with no
  FIN/RST — the Mac-sleep and cellular-handoff case) produces no `close`/`error`
  event, so no reconnect, so no catch-up pull.

**Therefore the number this design kills is not a poll interval — it is the
absence of one.** Today a receiver's worst-case staleness after a lost or
undelivered notification is **unbounded** (healed only by an eventual TCP error,
a local edit that pushes and 409-recovers, or a daemon restart). The 16.4s
receiver figure is a WS-delivery/stale-socket artifact, not a cadence; §10
records the open question of which failure mode it was. This design replaces
"unbounded, WS-only, unmeasured" with "bounded backstop + half-open liveness +
measured," while keeping the fast path (WS push) exactly as fast.

## 2. Load-bearing invariants (FIXED)

1. **Notify-only. Never data. Never correctness.** The socket carries "workspace
   seq N exists." The daemon reacts by running the EXACT same authenticated HTTP
   pull it runs today. No E2EE material, no manifest bytes, no blob data ever
   touch the channel. Nothing in the correctness suite may depend on a frame.
2. **Every WS failure degrades to polling.** Dead socket → poll backstop. Lost
   frame → poll backstop. Spoofed/duplicate/reordered frame → at most one
   wasted, authenticated, harmless pull. Disabled channel → pure polling.
3. **The pull is idempotent and head-seeking.** A pull always fetches the
   authoritative `/latest` head, never a seq-by-seq replay. So a missing,
   duplicated, reordered, or coalesced-away frame is self-healing: the next pull
   (from any trigger) reconciles to true head. The frame's `sequence` is used
   only for status/metrics, never to drive which bytes are fetched.
4. **The channel is additive.** With WS + backstop both off, the daemon's pull
   triggers reduce to exactly the pre-notify set (initial + push-409-recovery) —
   the falsification config in G3.

## 3. Server — upgrade endpoint and auth handshake

### 3.1 Endpoint

`GET /v1/ws/:ws/proj/:proj/connect` with `Upgrade: websocket`. The Worker
router authenticates (`authenticate` → `Principal`) and authorizes
(`authorizeWorkspace`, READ level) BEFORE forwarding the un-rewrapped upgrade
request to `WORKSPACE_SYNC.idFromName(ws/proj)` — the same DO instance that
sequences commits for that workspace. The DO calls `ctx.acceptWebSocket(server)`
(Hibernation API) and stores `{deviceId}` via `serializeAttachment`. Cross- or
unowned-account → 404 (indistinguishable, no enumeration leak), identical to
every other workspace route.

### 3.2 What a stolen / expired token can and cannot do

- **Valid token:** may open a socket only to workspaces its own account owns
  (`authorizeWorkspace` same-account check). It then receives `{sequence}`
  integers for those workspaces. It CANNOT read data (needs blob entitlements +
  the KEK, neither on the channel), CANNOT commit (client→server frames are
  ignored; `webSocketMessage` is a no-op), and CANNOT notify anyone. Capability
  is **strictly ≤ polling `/latest`**, which the same token already permits. No
  escalation.
- **Expired / revoked token:** rejected at every NEW handshake (`authenticate`
  filters `revoked=0 AND (expires_at IS NULL OR expires_at > now)` and rejects
  tombstoned accounts). **Gap closed here:** an ALREADY-OPEN socket is authorized
  once at handshake and would otherwise outlive revocation. The bound this
  design enforces is on **information delivery, not connection existence**
  (§3.4): no `committed` frame is ever delivered on a socket older than
  `WS_MAX_SESSION_MS`, because the only code path that delivers frames (the
  post-commit `broadcast`) checks socket age BEFORE each `send` and closes
  over-age sockets instead of sending. An over-age socket on an IDLE workspace
  may stay connected longer (nothing wakes the DO to close it) — but an idle
  workspace emits nothing, so the lingering socket receives only runtime
  auto-pongs, which carry zero information. Net: a revoked device's eavesdrop
  window on seq hints is ≤ `WS_MAX_SESSION_MS` in all cases. "Capability ≤
  polling `/latest`" is scoped to a CURRENTLY-VALID token; post-revocation the
  socket's residual capability (nothing on idle workspaces, ≤ cap-window frames
  otherwise) is strictly below what polling granted before revocation.
  Immediate mid-session revocation is an explicit non-goal — the hint carries
  zero data and zero correctness leverage.

### 3.3 Notify semantics

- **Emitted AFTER the commit transaction, never before the CAS.** The head
  advance is a synchronous `transactionSync` (no await inside); the broadcast
  runs in the same awake invocation, after the txn returns success, before the
  best-effort D1 mirror. Because `/latest` reads the DO's authoritative head
  (already committed in the txn), a client that receives the frame and pulls
  cannot observe a head older than the frame's `sequence` (no read-your-notify
  race). A conflicted/stale commit (409/epoch_stale) emits NOTHING.
- **Frame:** `{type:"committed", sequence:<int>, deviceId:<committer>}`.
  `workspace` is IMPLICIT — one DO per (ws,proj), so the connection identity is
  the workspace; a multi-workspace daemon holds one socket per workspace. No
  workspace field on the wire.
- **Epoch bumps: no separate event.** Key rotation (C4) is not broadcast. An
  epoch change is absorbed by the same head-seeking pull (the client's
  roster/epoch check is authoritative) or by the backstop; adding an epoch frame
  would put correctness-adjacent state on a notify-only channel — rejected.
- **Coalescing / rapid commits:** the server sends one frame per committed
  sequence (no server-side batching). Safe because the CLIENT coalesces: `want.pull`
  is an idempotent boolean, so N frames during one in-flight pull collapse to at
  most one queued follow-up pull, which seeks the newest head. Server-side
  batching would add DO state for no benefit.
- **Self-notify:** the committer's own device receives its own frame.
  **Decision: conditional client-side skip-self** — skip the pull iff
  `frame.deviceId === self` AND the locally persisted `lastSyncedSequence ≥
  frame.sequence`. The second conjunct closes the divergent-base cases the
  deviceId alone cannot (cloned credentials, a duplicated device identity across
  two roots, a second daemon process sharing the id): any same-id socket whose
  base has NOT actually advanced to `sequence` still pulls. With the conjunct
  true the skipped pull is a genuine no-op by definition (base already at or
  past the notified head). NOT load-bearing either way (worst case if never
  skipped: one harmless no-op pull per own-commit; worst case of a wrong skip
  is impossible under the conjunct, and the backstop bounds any residual). The
  server keeps broadcasting to all sockets (simpler; the same device may
  briefly hold two sockets across a reconnect).

### 3.4 Hibernation lifecycle and cost model

- **Hibernatable sockets survive DO eviction.** After ~10s idle the DO
  hibernates; `getWebSockets()` still returns the (hibernated) sockets and
  `send()` on the next commit delivers. The defensible cost statement is: **the
  notify adds no DO wake beyond the commit invocation itself** — it is always
  emitted from inside the commit handler, which by definition has the DO in
  memory. Marginal notify cost = N `send()` calls of a ~70-byte frame (N =
  sockets on that workspace) plus the serialized `{deviceId, connectedAt}`
  attachment per socket — small but not literally free; both scale with device
  count per workspace, which is the account's own device fleet (single-digit
  today).
- **Keepalive is wake-free.** The DO registers
  `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))`.
  The daemon's 25s app-level `"ping"` matches and is answered by the runtime
  WITHOUT waking a hibernated DO and WITHOUT billable duration (request/response
  each limited to 2048 chars; ours are 4). This claim is about the APP-level
  auto-response mechanism only; WebSocket protocol-level ping frames are a
  separate runtime concern and this design does not rely on them.
- **Eviction mid-commit is impossible to observe as torn:** eviction requires
  ~10s with no in-flight work; an in-flight commit keeps the DO resident, so the
  broadcast always runs in the same invocation as its CAS. If the isolate dies
  AFTER the CAS but BEFORE the broadcast (power loss/OOM), the frame is simply
  lost → backstop/next-commit/reconnect heals it (invariant 2). The CAS itself
  is durable regardless.
- **Max socket lifetime (§3.2):** `acceptConnection` stamps `connectedAt` into
  the attachment; `broadcast` checks age BEFORE each `send` and CLOSES over-age
  sockets instead of sending. This is deliberately NOT an alarm-driven sweep:
  the DO alarm is owned by the roots-index fold (design 96) and adding a second
  alarm consumer complicates that machinery for no security gain — the
  check-at-delivery placement already guarantees the actual security property
  ("no frame delivered past the cap," §3.2), because frame delivery and the
  check are the same code path. What it does NOT guarantee — and the design
  does not claim — is that an idle socket's TCP connection closes at 6h; it
  closes at the first commit after 6h, or when the client's own reconnect
  cycle replaces it. `WS_MAX_SESSION_MS` = 6h rationale: ≥ a typical work
  session (reconnects stay rare, ≤4/day per socket, so reconnect-churn cost is
  noise) while bounding a revoked token's frame-visibility window to well
  under a day; it is a policy knob, not a tuning constant.
- **The over-age close intentionally drops the triggering frame — explicit
  lifecycle contract:** a LEGITIMATE (non-revoked) device whose socket crosses
  the cap misses exactly the frame whose broadcast performed the close. This
  is a deliberate instance of invariant 2, healed by the standard ladder: the
  client observes `close` → reconnects under normal backoff (the fresh
  handshake re-authenticates; a still-valid token succeeds) → the `open`
  handler's MANDATORY catch-up pull seeks the authoritative head and picks up
  the very commit whose frame was dropped. If the close is NOT observed (the
  socket was also half-open), the client's pong deadline (≤60s, §4) or the
  backstop (≤~5m, §4) fires instead — the same floor every other lost frame
  gets. Cap-induced staleness is therefore bounded by reconnect + one pull in
  the common case, and by the backstop in the worst case.
- **`connectedAt` fail-closed:** the "no frame past cap" guarantee must not
  depend on attachment hygiene. In `broadcast`, a missing, malformed,
  non-numeric, or FUTURE-dated `connectedAt` is treated as over-age: close,
  do not send. This also covers the deploy-time migration from today's
  `{deviceId}`-only attachments — pre-deploy sockets are closed on the first
  post-deploy broadcast (one-time reconnect churn, absorbed by the normal
  backoff + catch-up-pull path above) rather than grandfathered into an
  unbounded session.

## 4. Client — lifecycle (daemon, Bun WebSocket client)

Bun's client takes a `{ headers }` constructor option (Bun extension; used for
`Authorization: Bearer <device-token>`) and has **no built-in auto-reconnect or
pong-deadline** — both are implemented manually in the daemon. The client owns
all liveness; the server is passive.

- **Connect / backoff / jitter (exists):** on `close`/`error`, reconnect with
  `min(RECONNECT_MAX_MS, RECONNECT_BASE_MS · 2^attempt)` (500ms→30s), each delay
  jittered ±25% (`jitter()`), `attempt` reset to 0 on `open`.
- **Half-open liveness (NEW — the core reliability fix):** a ONE-SHOT
  `WS_PONG_DEADLINE_MS` deadline, **armed on `open`** and re-armed on EVERY
  inbound frame (`pong` or `committed`). The initial arm on `open` matters: a
  socket that opens and then goes silent before its first pong is caught by
  the same bound — without it, a first-pong failure would recreate exactly the
  unbounded half-open this design exists to kill. Deadline semantics: the
  socket is declared dead exactly `WS_PONG_DEADLINE_MS` after the later of
  `open` and the last inbound frame (not "some multiple of a polling tick"),
  then `close()` + reconnect. Value: **60s = 2 ping intervals (50s) + 10s
  network grace** — two consecutive lost pongs, not one (a single lost pong
  under transient congestion must not cycle a healthy socket).
  Detection bound: a silent half-open is detected in ≤60s after the last frame,
  instead of never. Sleep-wake and network-change are the same case: the
  deadline fires (or the OS surfaces an error) → reconnect → the `open`
  handler's catch-up pull reconciles to head (this IS the seq-compare: the pull
  fetches `/latest` and no-ops iff local base already equals head, so any gap
  during the outage is caught in one round-trip).
- **Poll backstop (NEW — the honest fallback):** an always-on
  `RBOX_DAEMON_POLL_BACKSTOP_MS` timer (proposed **300000 = 5 min**) that fires
  `request("pull")` regardless of socket state. Rationale for 5m: it matches
  the safety scan's idle cap (design 49) — remote staleness gets the same bound
  the local tree already has; no new worst-case class is introduced. On a
  healthy socket it covers a lone lost frame; on a dead socket it bounds
  staleness to ≤~5m even while reconnect is flapping. Set to `0` to disable.
  **Timer phasing (explicit):** first tick at `uniform(0, interval)` after
  daemon start (so simultaneous fleet/host boots never phase-align), each
  subsequent tick at `interval ± 25%` re-sampled per tick (the existing
  `jitter()` idiom).
  **Honest cost model (full request path, not just the DO):** each backstop
  pull that reaches the network is a `/latest` GET = Worker invocation +
  `authenticate` (1 directory-shard D1 read + 1 account-shard D1 read; a
  `last_seen` write at most once per 10m due to the existing throttle) +
  `authorizeWorkspace` (1 D1 read) + DO `latest()` (storage read) + optional
  worker-side grant mint, ~1–2KB response. Call it ~3–4 D1 queries per poll.
  At 12/h: ~40–50 D1 queries/workspace/hour. Fleet aggregate = 12 × (total
  daemon-workspace pairs) per hour — at today's fleet (≈3 hosts × ≈2
  workspaces) ≈ 72 polls/h; re-model before any fleet 100× today's. Battery
  impact is NOT asserted here; it is measured by G2.
- **Kill switch (NEW):** `RBOX_DAEMON_WS_DISABLED=1` ⇒ `connect()` is never
  called; the daemon runs on the backstop poll alone (a provable, pure-polling
  degraded mode). `WS off + backstop off` reproduces today's exact pull triggers
  (G3 falsification config).
- **Timers per socket, stated exactly:** one 25s keepalive `setInterval`
  (exists; NOT jittered today — its phase is set by connect time, and
  alignment across daemons is harmless because pings are answered by the
  wake-free auto-response, §3.4), one 60s one-shot pong deadline (re-armed per
  inbound frame), one backstop timer (phased + jittered as above). A host runs
  one daemon PROCESS per workspace root, so per-host totals scale linearly
  with workspace count: W workspaces ⇒ W sockets, 3W timers. There is no
  architectural cap on W; G2 is therefore evaluated at the HOST aggregate with
  the founder's real workspace count, and the answer is a measured number, not
  an assumption of smallness.

## 5. Interaction table

| Concern | Interaction | Resolution |
|---|---|---|
| Safety scan (49/85) | scan reconciles local→push; notify triggers pull | Both route through the single want-flag pump under the sync mutex → serialize. Notify never touches `safetyDelay`/`noteChurn`, so the scan backoff is undisturbed. A notify-pull that APPLIES remote bytes generates watcher events → `noteChurn` pulls the safety timer forward — correct (applied changes should reconcile). |
| Sync mutex (93) | notify-pull vs an in-flight sync | The pump acquires the mutex per op; a notify arriving mid-op only sets `want.pull=true`. Contention requeues (never consumes) the tick with backoff. No corruption; 93 stays the ownership boundary. |
| Pull coalescing | notify during an in-flight pull | `want.pull` is idempotent; ≥1 notify during one pull ⇒ exactly one follow-up pull to the newest head. Bounded regardless of frame rate. |
| Multi-workspace daemons | one process per root | W workspaces = W processes = W sockets = 3W timers, no architectural cap (§4). Per-workspace DO fan-out is bounded by that account's device count. Battery gate G2 is evaluated at the host aggregate with the real workspace count. |
| API deploys | new code version closes all sockets (Close 1001) → fleet reconnects | `attempt` was reset on the prior `open`, so the first reconnect is ~500ms — a synchronized spike. Mitigation: spread the FIRST post-close reconnect `uniform(0, 3s)`. **Capacity argument:** the spread turns S simultaneous fleet sockets into ~S/3 handshakes/s. The per-workspace DO is never the choke point (it sees only that workspace's device count, ≪ its 1,000 req/s soft limit); the shared path is Worker + auth D1 (~3 queries per handshake ⇒ ~S D1 queries/s at S/3 handshakes/s). Stated validity envelope: fine to S ≈ 1,000 fleet-wide sockets; the design must be re-derived (wider spread or staged close) beyond that. Storm gate G5 (§7) tests this. Distinct from EVICTION (socket survives transparently, no reconnect). Backstop timers are NOT deploy-synchronized (deploys don't restart daemons); startup alignment is handled by the initial `uniform(0, interval)` phase (§4). |
| 84 / 102-enforce | both rewrite the commit path around the CAS | This design adds only a post-CAS `broadcast` (already present) + a lifetime check; it binds to "emit after the txn on head advance," which both keep. §9 sequences implementation after they land. |

## 6. Metrics (design 97 discipline; numbers-only)

- **`notify→pull-start` latency token** in the pull phase-report line and as a
  metric event: integer ms from `committed`-frame receipt to the pull op
  actually dequeuing from the pump. Disambiguates "notify was slow to arrive/
  dequeue" (this design's concern) from "pull itself was slow" (84/85's). A pull
  not caused by a notify omits the token.
- **Connection state in `rbox status`:** already surfaced via `activity.ws`
  (`connected`, `caughtUp`, `lastBroadcastSequence`). Keep; add nothing that
  isn't a number or a boolean.
- **Privacy:** the `deviceId` in a frame is used only for skip-self and travels
  only on the `wss` wire; it is NEVER written to a metric or log line (existing
  `log("ws connected")`-style lines already carry no ids). Metrics stay
  numbers-only; the status file persists `lastBroadcastSequence` (a number), not
  `deviceId`. New metric events: `notify_latency_ms`, `ws_reconnect`
  (count/reason-bucketed), `ws_backstop_pull` (count), `ws_half_open_detected`
  (count) — all counts/integers.

## 7. Gates (falsifiable)

- **G1 — fast-path propagation (event-correlated, clock-safe). This is
  explicitly a p50 FAST-PATH gate**; the recovery tail is G1b's job, not
  median-smuggling. Measurement: a single-writer experiment on the fleet with
  commits spaced > one pull apart (each event individually observable — no
  superseded sequences). Quantities, exactly: `e2e_i` = (receiver's
  file-visible wall timestamp − writer's keystroke wall timestamp), cross-host,
  offset-corrected; `push_i` = the writer's push DURATION for the commit that
  published seq *i* (its phase-report total wall, a duration not a timestamp);
  `pull_i` = the receiver's pull DURATION for the pull that first made seq *i*
  visible. Correlation is by commit sequence. **Eligibility:** only events
  whose receiving pull was NOTIFY-TRIGGERED (carries the §6 notify token)
  enter the residual population — a backstop- or reconnect-triggered discovery
  is evidence the fast path FAILED for that event and would corrupt the
  statistic; if one head-seeking pull applies several sequences (should not
  happen under the spacing rule, but networks), only the newest is eligible.
  Ineligible-event RATE is itself gated: > 20% ineligible ⇒ the run FAILS
  (the fast path must actually be the common path, or the gate is
  meaningless). Clock safety: cross-host offset is measured against the same
  NTP source immediately before and after the run and must be < 250ms
  drift-stable, or the run is invalid; the measured offset is subtracted from
  `e2e_i`. Pass rule: over ≥ 20 eligible events in one run window,
  **median(e2e_i − push_i − pull_i) ≤ 1s** (the residual is what the notify
  path owns: frame delivery + pump dequeue + mutex wait). This is deliberately
  NOT "p50(e2e) ≤ p50(push)+p50(pull)+1s" — sums of independent quantiles are
  not a bound. Evaluated AFTER 84 + 85 land.
- **G1b — bounded recovery (the tail).** In the SAME run — which therefore
  MUST use a positive backstop interval (a backstop-disabled run cannot
  evaluate G1b and is invalid for it) — every event, including ineligible
  ones, must be visible on the receiver within
  `RBOX_DAEMON_POLL_BACKSTOP_MS × 1.25 (max jitter) + pull_i + 30s slack`,
  measured **from the writer's commit-success timestamp** (the wall time the
  writer's push observed the 200 `{sequence}` response — one instrumented
  point, on the writer's clock, corrected by the same measured NTP offset as
  `e2e_i`) to the receiver's file-visible timestamp. Zero exceptions; one
  unbounded event fails the run. This is the falsifiable form of "worst-case
  staleness is now bounded" (§1).
- **G2 — battery / wakeup budget (numeric).** On the Mac, A/B over ≥ 3 paired
  10-minute `powermetrics --samplers tasks` samples with the host otherwise
  idle, at the founder's REAL workspace count: (WS-on + backstop-on) minus
  (both off). Pass: **added idle-wakeups ≤ 1/s averaged, and added CPU time
  ≤ 0.5% of one core**, host aggregate. These defaults are proposed pass/fail
  numbers (founder may re-set them before the run, §10) — but the gate ships
  WITH numbers; "within an agreed ceiling" is not a gate.
- **G3 — flag-off trigger-equivalence.** With `RBOX_DAEMON_WS_DISABLED=1` AND
  `RBOX_DAEMON_POLL_BACKSTOP_MS=0`, a daemon test asserts the precise
  observables: (a) no request to `/connect` ever occurs, (b) no timer-driven
  `/latest` occurs, (c) the set of pull-trigger call sites that can fire is
  exactly the pre-notify set {initial convergence, push-409-recovery}. This is
  behavioral trigger-equivalence, not byte-identity of binaries — named
  accordingly. (The shipping DEFAULT is WS-on + backstop-on; this config exists
  solely to prove additivity.)
- **G4 — notify-fault equivalence + zero correctness-suite changes.** (a) The
  head-authority / manifest-integrity / apply-atomicity suites are untouched
  and green, and no correctness assertion depends on frame delivery. (b) A
  fault-injection fixture drives one writer + one receiver daemon through a
  scripted commit sequence under each of: frames dropped (including ALL
  frames), duplicated, reordered, delayed-past-coalescing, and socket killed
  mid-sequence — and asserts the receiver converges to the SAME observables as
  the all-frames-delivered run: final authoritative head sequence, persisted
  `lastSyncedSequence` + base manifest, on-disk tree bytes, and
  conflict-artifact set. **Convergence deadline (falsifiable):** the fixture
  runs with a test-configured backstop (e.g. `RBOX_DAEMON_POLL_BACKSTOP_MS`
  = 2s) and every fault case must reach the converged observables within
  **3 backstop intervals of the last injected commit** — a deterministic bound
  that the all-frames-dropped case can only meet via the backstop, which is
  the point. The fixture must RECORD per-phase durations (backstop-fire time,
  pull wall, apply wall) so a deadline miss is attributable — "backstop never
  fired" (a design/implementation bug) vs "pull/apply exceeded the window"
  (an environment problem; fixture trees must stay small enough that
  pull+apply ≪ one backstop interval). Tests MAY observe frames to assert
  their non-authority; they may not require them for convergence.
- **G5 — reconnect storm (NEW).** A rig test opens N ≥ 100 simulated WS
  clients against the dev worker across ≥ 10 simulated workspaces, then
  force-closes all simultaneously (deploy simulation). Two scenarios:
  - **(a) Healthy server.** Assertions: every client reconnected (completion =
    client-side `open` event, measured from the close instant); completion
    p95 ≤ 5s (uniform(0,3s) spread + handshake, no retries expected); zero
    auth-path 5xx; and the spread itself validated STATISTICALLY, not with a
    false per-second cap. First-attempt counts per fixed 1s bucket (three
    buckets aligned to the close instant) are Binomial(N, 1/3) with
    σ = √(2N/9); assert **max bucket ≤ ⌈N/3 + 4.5σ⌉** (for N=100: 33.3 +
    4.5·4.71 → ≤ 55, threshold rounded UP). A no-spread implementation puts
    ~N in bucket 0 and fails decisively; a correct uniform spread passes with
    wide margin. A plain "≤ N/3 per second" would fail healthy randomization
    on normal bucket variance — rejected.
  - **(b) Per-client first-attempt failure.** The rig rejects EXACTLY the
    first reconnect handshake of EACH client (a per-client fault, not a
    timed outage — a fixed-duration outage cannot reject exactly one attempt
    per client when attempts are spread over 0–3s: late clients would miss
    it, early clients could fail twice), then accepts. Expected completion:
    ≤3s spread + failed handshake + one backoff step (attempt 1: ~1s ± 25%)
    + retry handshake ≈ ≤5.5s nominal. Assertions: **completion p95 ≤ 8s**
    and zero clients abandoned. Sustained-outage behavior is NOT this gate:
    beyond one retry the 500ms→30s backoff and the poll backstop govern, by
    design (a multi-minute outage is an availability event, not a storm).
  Run once before fleet rollout; re-run when fleet socket count grows 10×.

## 8. Non-goals

Guaranteed/at-least-once delivery; ordered delivery; server-driven pushes of
manifest/blob data; a browser-dashboard live channel (out of scope; this is the
daemon channel); immediate mid-session token revocation (frame DELIVERY is
bounded by the 6h cap instead — connection existence on an idle workspace is
not, and leaks nothing, §3.2/§3.4); replacing the pull with a seq-replay
protocol.

## 9. Rollout and sequencing

1. **Implementation waits for design 84 (manifest delta) and 102-enforce** to
   land — both rewrite the commit path this design's post-CAS broadcast binds to.
   Rebasing onto a moving CAS is avoided by sequencing, not by racing.
2. **Flag off → single-host → fleet.** Land the liveness + backstop + kill
   switch + metrics behind defaults that preserve today's behavior where risky
   (backstop default-on is the one intentional behavior change — it is a
   correctness-floor improvement, validated single-host first via the
   propagation analyzer before fleet rollout).
3. Ship the server socket-lifetime cap with the client changes (the cap is inert
   without clients that reconnect cleanly, which they already do).
4. Run the storm rig (G5) against the dev worker before fleet rollout.
5. Verify on the fleet with the propagation analyzer (G1) and a Mac battery A/B
   (G2) before declaring done.

## 10. Open founder questions

- **Which failure mode was the 16.4s receiver figure** — a stale/half-open
  socket (this design's backstop+liveness fix) or a slow pull on the 41MB
  pre-84 manifest (84/85's fix)? The new `notify→pull-start` token is the
  arbiter; re-measure once it exists.
- **G2 budget ratification:** the gate ships with proposed numbers (≤1
  added wakeup/s, ≤0.5% of one core, §7); the founder may re-set them BEFORE
  the measurement run — after it, they are the gate.
- **Backstop cadence:** 5 min proposed (= the safety scan's idle cap, §4).
  Tighten (e.g., 90s) if the analyzer shows lost-frame-on-live-socket events
  are common, or loosen if G2 is tight. Data-driven post-rollout.
- **First-reconnect spread** for deploy storms: `uniform(0, 3s)` is derived for
  a ≤1,000-socket fleet (§5); re-derive (wider spread or server-side staged
  close) beyond that.
