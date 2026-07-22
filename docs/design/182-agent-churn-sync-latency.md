# 182 — sync latency under continuous agent churn (capture in the gaps)

Status: DRAFT v1 — contract-level mechanisms, grounded in code recon
2026-07-22 (all anchors verified that day). Supersedes v0's sketch. Ready
for the adversarial review loop; no rounds yet. Implementation queued
behind 178 t3.

## The paradigm (founder, lightly compressed — kept verbatim from v0)

LLM/agent-driven development is becoming the primary use of software: heavy
file churn from agents running on many developer machines, often in
parallel, sometimes in worktrees, sometimes on branches. It's hard to know
what is truly deferrable — if we defer a busy repo long enough and the user
then switches from desktop to laptop, the code has to already be on the
other machine. We can't defer indefinitely. That's the trade-off, and we
don't have a good solution yet.

Field evidence, same day: a codex agent on the founder's Mac STOPPED the
rbox daemon to avoid "recreating a deferral" while it modified 15 files —
trading one repo's capture lag for zero replication of the whole machine.
Second agent (after the 2026-07-21 incident operator stop) to misread
deferral as a hazard. Status output is now an agent API; alarming copy
causes agent behavior loops.

## Why the trade-off is softer than it looks

1. **"Busy" is measured too coarsely.** Git holds locks for milliseconds;
   agent workloads create thousands of tiny lock windows with real quiet
   gaps between tool calls. The busy probe is existence-only and fail-closed
   (`src/engine/git/shared.ts:664` `gitBusy`; plan site
   `src/engine/git/preflight.ts:123`, apply site
   `src/engine/git/apply.ts:320`), sampled only when a push attempt runs —
   so "deferred 1h" usually means "sampled unluckily," not "no safe moment
   existed." The unsafe windows (ref transactions, index writes) are
   milliseconds; the object store is immutable and always safe to read.
2. **The deadline is not continuous — it's handoff.** Freshness matters at
   the moment another machine asks. That moment is observable (the peer
   pulls / comes alive on WS).

## What the code actually provides today (recon 2026-07-22)

- **Content watcher excludes `.git/**` entirely** (`watcher.ts:427-435`
  prunes `.git/`; only the `.git` lifecycle entry itself is admitted,
  `git-ref-watch.ts:72-85`).
- **A git-ref side-channel already watches lock files** —
  `GitRefWatchRegistry` (`git-ref-watch.ts:198`) attaches `fs.watch` roots
  per repo and classifies `.lock` events (`classifySafeRefEvent`,
  `git-ref-watch.ts:37-45`) into `lockPreSignal` → `onSignal` → debounced
  `requestPush("signal")` (`daemon.ts:744-753`, `:793`). BUT:
  - It is **Linux + Parcel only** (`gitRefSideChannelEligible`,
    `git-ref-watch.ts:20-25`). The founder's Mac has no lock-event plane at
    all; git there is fully scan-bound (60s safety floor).
  - The observed tail set (`GIT_REF_SIGNAL_TAIL_TABLE`,
    `src/engine/ignore.ts:166-169`) covers `HEAD.lock`, `packed-refs.lock`,
    `stash`, and per-ref locks — **NOT `index.lock`, `config.lock`, or
    `gc.pid`**, all of which the busy probe treats as busy. `index.lock` is
    the dominant agent-churn lock (every add/commit/checkout), so the
    highest-frequency gap-closing edge generates no event today.
  - Signals are **edge-agnostic** (create and remove both fire); the
    fail-closed busy probe downstream is what makes that safe.
- **There is no capture-side retry floor to relax.** Capture deferrals carry
  no suppression timer; they are re-probed on every push. The lever is push
  frequency: watcher signals (Linux) + the 60s safety scan
  (`SAFETY_SYNC_MS`, `policy.ts:6`). The hours-scale floor the v0 sketch
  worried about is apply-side held-skip (`held-skip.ts:26`), out of scope.
- **WS plane is notification-only broadcast.** One payload:
  `{type:"committed", sequence, deviceId}` (`workspace-sync.ts:715`,
  fan-out `apps/api/src/ws-fanout.ts:20`); clients react by pulling
  (`daemon.ts:2909-2915`). No peer relay exists, but each socket is tagged
  with its `deviceId` attachment (`ws-fanout.ts:16`) — a targeted send is
  buildable on that.
- **Deferral state already flows to the server, aggregated.**
  `SyncStateReporter` → `POST /v1/fleet/sync-state` with `reposDeferred`,
  `oldestDeferralAgeMs`, `deferralReasons` (`sync-state.ts:6-39`, contract
  `telemetry/contract.ts:168-176`), landing in `device_sync_state` for
  fleet alerts only. The reporter's change fingerprint already computes
  per-repo per-lane boundaries (`sync-state.ts:79-82`) — the detail exists
  client-side and is collapsed before upload.
- **Bounding machinery exists**: signal debouncer
  (`watcher.ts:153-211`), single-flight pump (`daemon.ts:1201-1203`),
  per-target reconcile backoff (`git-ref-watch.ts:798-806`, exp cap 60s),
  repo admission cap (`gitRepoCap`, `git-ref-watch.ts:233`).

## Mechanisms

### A. Event-driven micro-gap capture (extend the existing side-channel)

Not a new plane — two extensions of `GitRefWatchRegistry`:

**A1 (small, Linux ships first): observe the busy-set locks.** Add `index`,
`config` to the `gitDir` targets and `gc.pid`'s base to the common-dir
targets in `GIT_REF_SIGNAL_TAIL_TABLE`, so their create AND remove edges
emit `lockPreSignal`. The remove edge is the micro-gap detector: lock
clears → debounced signal → `requestPush("signal")` → the fail-closed
`gitBusy` probe either captures in the gap or bounces off the next lock.
No new scheduling code: the debouncer coalesces bursts, the single-flight
pump serializes attempts, and the probe preserves never-capture-mid-
operation. Expected effect: capture latency for churny repos on Linux drops
from worst-case 60s-per-sample-with-bad-luck to
first-quiet-gap-after-debounce.

- Contract: tail-table extension only; no changes to `classifySafeRefEvent`
  shape, no new signal kinds. The debounce window and pump remain the
  attempt bound; no per-lock-event capture attempts.
- Risk pinned: `index.lock` churn is high-frequency; the debouncer's
  maxWait must keep signal cost O(window), not O(events). Measure with the
  rig before/after (attempts/min under a synthetic agent-churn loop).

**A2 (gated): macOS eligibility.** The founder's primary machine gets zero
benefit from A1. Expanding `gitRefSideChannelEligible` to darwin requires a
source-verification spike FIRST (standing rule: read the dependency's
source when a design hinges on its behavior): does `fs.watch` on darwin
(FSEvents/kqueue under Bun) deliver create+remove events for dotfile-
adjacent paths with the same shallow/recursive semantics the registry
assumes (`git-ref-watch.ts:599-634`)? Deliverable of the spike is a
platform-behavior test in the rig, not a doc claim. Until then A2 is
explicitly unshipped and the Mac stays scan-bound.

### B. Demand-driven flush (deferral becomes "until demanded")

**B1: advertise per-repo deferred lanes.** Promote the per-repo, per-lane
boundary detail the reporter already computes into the sync-state envelope
as an additive, versioned field (bounded: top-N repos by age, N=8, repo
paths NOT included — a stable repo digest + lane + deferredSince; paths are
workspace-local information the server does not need). Server stores
latest-per-device alongside the existing `device_sync_state` row.

**B2: targeted demand relay.** New client→server WS message
`{type:"flushDemand", targetDeviceId, repoDigest}` sent by device B when it
(a) connects or completes a pull, and (b) the server-advertised state shows
device A holding deferred lanes for repos B tracks. The DO relays it to A's
socket(s) selected by the existing `deviceId` attachment — first targeted
send on this plane, same notification-only contract: **delivery is never
required for correctness**; the 60s safety floor and ordinary push path
remain the guarantee. No ACK protocol.

**B3: demand escalation on A.** Receiving a `flushDemand` for a repo with a
deferred capture lane arms a bounded escalation window for that repo:
elevated gap-hunting (tight re-probe cadence, e.g. 2s interval, window
≤60s, one window at a time per repo, re-arm only by a fresh demand) inside
the existing pump/single-flight machinery. Success = capture + push →
ordinary `committed` broadcast tells B; failure = window expires, repo
returns to ambient cadence. Escalation respects the registry's per-target
backoff (`#recordRetry`) — a repo whose reconciles are failing does not get
hammered because a peer is impatient.

- Flood control: per-device inbound demand budget on A (per-repo window
  dedup + global cap, e.g. ≤4 concurrent escalation windows); DO drops
  demands for devices not currently connected (no queueing — the next
  sync-state upload re-advertises anyway).
- Deployment ordering: server (B1 ingest + B2 relay) deploys before any
  client sends `flushDemand` — same server-first contract as design 180.
  Old servers receiving unknown WS message types must ignore them (verify,
  don't assume — review round item).
- UX (B, receiving side): while a demanded pull is pending, status may show
  "catching up from <device>…" — copy in a later round; mechanism first.

### C. Churn-as-heat scheduling

A repo generating constant lock traffic is the most valuable repo on the
machine, not the least. With A1 in place, heat = debounced signal count per
repo per window (in-memory, decayed). Heat only REORDERS capture attention
within existing budgets: hot repos get probed first within a pump pass and
keep their side-channel attention under the admission cap
(`gitRepoCap`) — heat never bypasses per-target backoff, never adds
attempts beyond the debounce/pump bound, and failure is not heat (probe
bounces don't raise it). This inverts today's implicit defer-and-back-off
without touching safety.

### D. Don't guess transience (policy, unchanged from v0)

Agent worktrees that get squash-merged and deleted an hour later are
indistinguishable in advance from the one that matters. Sync everything;
let deletion propagate; content-addressing makes doomed-work bandwidth
cheap. The hygiene work is ghost-record cleanup (pr8 class, in 178 t3) and
remnant pruning — not prediction.

### E. Agent-readable status contract

Status output is an agent API (two documented agent daemon-stops in two
days). Two parts:

1. **Calm copy everywhere** — deferral language never implies malfunction.
   The bar half shipped (PR #401: deferrals no longer render "Degraded");
   CLI `rbox status` copy gets the same audit (deferral lines state what,
   since when, and that no action is needed).
2. **An explicit machine-parseable verdict line** in `rbox status` (and
   `--json`): `agent: safe-to-leave-running` /
   `agent: do-not-stop (mid-apply, ~Ns remaining)` — one stable line whose
   vocabulary is versioned in the shell/telemetry allowlist like 178's mode
   witness vocabulary. Agents told "do not stop" need a reason and a bound,
   or they stop anyway.

## Relationship to existing work

- 178 t2 (shipped v1.7.21): deferrals self-clear and report honestly — the
  hygiene floor this builds on.
- 178 t3 (in implementation): lock ownership classification + gone-directory
  ghost clearing — prerequisite for trusting lock-plane signals; also the
  graceful-stop half of E2's "do-not-stop" honesty.
- 176/177: resolution semantics unchanged; A/B/C move CAPTURE timing only.
- Design 174's held-apply bounds are apply-side and untouched.

## Priorities / ship order (proposed, for review)

1. **E** (copy audit + agent verdict line) + **A1** (tail-table extension,
   Linux) — small, independent, immediate value.
2. **B1** (advertisement) then **B2+B3** (relay + escalation), server
   first — the handoff-latency fix; needs its own review round on the wire
   contract before implementation.
3. **C** (heat reordering) — after A1 field data shows where reordering
   matters.
4. **A2** (darwin) — gated on the fs.watch source-verification spike.

## Non-goals (pinned)

- No capture of mid-operation git state, ever. Latency is bought with
  better gap detection and demand signals, not weakened safety — every new
  trigger path still funnels through the fail-closed `gitBusy` probe.
- No transience prediction / selective sync.
- No new daemon-stop choreography; the whole point is that stopping is
  never the answer.
- No correctness dependence on WS delivery (preserves the ws-fanout
  notification-only contract).
- No relaxation of the 60s safety floor; event planes are additive.

## Tests the implementation must write (per mechanism)

- A1: tail-table classification for index/config/gc create+remove; debounce
  coalescing under synthetic index.lock churn (injected clock); a signal
  arriving mid-capture does not re-enter (single-flight); busy probe still
  bounces a mid-operation attempt triggered by a signal.
- B1: envelope stays within bounds at >N deferred repos; digest stability;
  old-server tolerance (unknown field ignored) — contract test.
- B2: DO relays only to sockets whose attachment matches targetDeviceId;
  unknown message types ignored by old clients/servers; disconnected target
  drops silently.
- B3: escalation window arms once per demand, expires, respects per-target
  backoff, honors the concurrent-window cap; success clears via the
  ordinary push path.
- C: heat reorders within a pass without changing attempt counts; probe
  bounces do not accumulate heat.
- E: verdict-line vocabulary compile-enforced against the allowlist;
  `--json` parity.
