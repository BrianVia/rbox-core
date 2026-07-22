# 182 — sync latency under continuous agent churn (capture in the gaps)

Status: DRAFT v3 — round 2 (gpt-5.6-sol, high) verdict CHANGES-REQUIRED, 9
findings (3 blockers), strictly narrower than round 1's 19/5 — convergence
real. All nine accepted (r2-5 accepted-modified: external-commonDir
worktrees are explicitly OUT of A1 coverage rather than newly admitted),
folded here. Key corrections: A0 generalizes staged/live EQUALITY and
staged-derived roots only — the in-progress presence veto stays
resolution-specific (ordinary sync intentionally transfers paused op-state,
design 43:160); A1's budget counts formed attempts at dequeue with tokens
inherited by causally-derived busy retries; E2 became a discriminated JSON
contract. Round 3 target: A0 semantics, A1 attempt/root contracts, E2
schema.

History: v2 folded round 1 (19 findings, 5 blockers; A0 prerequisite
created; B/C demoted to phase-2 requirement sets; E narrowed and
half-gated on 178 t3).

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
   (`src/engine/git/shared.ts:664` `gitBusy`), sampled once per push attempt
   at plan time (`src/cli/sync-git/plan.ts:573-594`) — so "deferred 1h"
   usually means "sampled unluckily," not "no safe moment existed."
2. **The deadline is not continuous — it's handoff.** Freshness matters at
   the moment another machine asks. That moment is observable (the peer
   pulls / comes alive on WS).
3. **BUT (r1-1): the probe is a POINT probe, not a bracket.** Capture
   launches later (`plan.ts:942-985`) and reads index/op-state/refs across
   seconds (`src/engine/git/capture.ts:234-304`); the end-to-end stability
   endpoint exists only for `opts.resolution` (`capture.ts:353-380`).
   Design 177 records this as a latent ordinary-push defect and hardened
   keep-mine only (`177:192-258`). Any mechanism that raises capture
   frequency raises exposure to it — hence A0 below.

## What the code actually provides today (recon 2026-07-22, corrected r1)

- **Content watcher policy differs by backend (r1-3):** Chokidar prunes
  `.git/` and admits only ref-signal paths (`watcher.ts:427-435`); default
  Parcel deliberately DESCENDS into `.git`, pruning only objects/logs
  (`src/engine/ignore.ts:227-242`), and routes matching Git targets before
  the ignore matcher (`watcher.ts:331-384`). The tail table
  (`GIT_REF_SIGNAL_TAIL_TABLE`, `ignore.ts:166-169`) is shared by BOTH
  classifiers — a "Linux-only" extension of it is not actually isolated
  from darwin.
- **A git-ref side-channel already watches lock files** —
  `GitRefWatchRegistry` (`git-ref-watch.ts:198`), Linux + Parcel only
  (`gitRefSideChannelEligible`, `git-ref-watch.ts:20-25`), signal wiring
  `daemon.ts:754-760` → debounced `requestPush` `daemon.ts:803`. The
  founder's Mac has no lock-event plane; git there is scan-bound (60s
  safety floor). Observed tails today: `HEAD.lock`, `packed-refs.lock`,
  `stash`, per-ref locks — NOT `index.lock` / `config.lock` / `gc.pid`,
  though the busy probe blocks on all of them. Busy-set physical roots
  (r1-2): `index.lock`+`HEAD.lock` under gitDir; `config.lock`,
  `packed-refs.lock`, `gc.pid` under commonDir (`shared.ts:664-678`) — a
  linked worktree has gitDir ≠ commonDir. `gc.pid` is not a `.lock` tail;
  it needs ordinary-target classification, not `lockPreSignal`.
- **No capture-side retry floor exists to relax.** Capture deferrals are
  re-probed on every push; the lever is push frequency (watcher signals on
  Linux + the 60s safety scan, `SAFETY_SYNC_MS`, `policy.ts:6`). Apply-side
  held-skip floors (`held-skip.ts:26`) are out of scope. Existing busy
  retries at 2s/8s add attempts (`daemon.ts:146,971-999`).
- **Debouncer bounds emission, not ingestion (r1-4):** every raw event
  still iterates contributors (`git-ref-watch.ts:742-762`) and resets
  timers (`watcher.ts:189-210`); 400ms of quiet emits a batch; maxWait 3s
  is not a minimum attempt interval (`daemon.ts:672-676`). Commands spaced
  ~400ms apart can each trigger a whole-workspace push; single-flight
  (`daemon.ts:1211-1216`) coalesces only while the pump runs.
- **WS plane is notification-only broadcast**: `{type:"committed",
  sequence, deviceId}` (`workspace-sync.ts:715`); clients pull on it
  (`daemon.ts:2917-2925`). Old servers ignore non-`cursor` inbound messages
  (`workspace-sync.ts:1319-1327`) and old clients ignore unknown JSON types
  — wire-compat for NEW message types is safe in both directions (r1-7).
  BUT the socket's `deviceId` attachment is the CLIENT'S query parameter,
  serialized untouched (`ws-fanout.ts:10-16`; `routes/sync.ts:48-54`
  forwards unchanged) — it authenticates nothing (r1-9). Connect is
  read-level authz including viewers (`authz.ts:32-40`), and inbound
  messages are not session-age-checked (r1-10).
- **Deferral state reaches the server as aggregates only**, per
  (device, workspace, project, binding) row (`0027_device_sync_state.sql`),
  POST-only (`worker.ts:374-384`) with an exact-`v:1`, unknown-key-rejecting
  envelope (`telemetry-ingest.ts:257-336`) — a new field is NOT additive
  for old servers (state dropped on 202 / 400 on v2), and the reporter
  fingerprints before checking `dropped` (`sync-state.ts:90-102`),
  suppressing retries (r1-7). There is no read/delivery path back to
  clients (r1-6). API-key principals cannot POST sync-state at all
  (`worker.ts:367-371`, `telemetry-ingest.ts:260-267`) — a coverage gap
  for agent-churn machines (r1-18).
- **Design 120's metadata threat model** rejected repo paths AND path
  hashes leaving the machine (`120:230-238`); design 105 pinned the WS
  information ceiling to sequence integers (`105:85-103`). Any per-repo
  advertisement supersedes both and must say so (r1-5).

## Mechanisms

### A0 (prerequisite, from r1-1): capture-stability hardening for ordinary pushes

Generalize design 177's keep-mine capture hardening to ordinary capture —
WITH a scope carve-out (r2-1): what generalizes is scratch-ref-pinned
bundle roots, the staged/live stability EQUALITY endpoint (staged index
bytes, staged op-state, presence bits observed on both sides), and
staged-derived pin roots (`177:192-258`). What does NOT generalize is the
in-progress presence VETO: ordinary sync intentionally captures and
transfers paused op-state so a rebase paused here can continue on another
machine (design `43:160`; E2E `git-sync.test.ts:697,726`) — the veto stays
resolution-specific (`capture.ts:252`). For ordinary capture, a STABLE
in-progress state publishes as today; only INSTABILITY (staged ≠ live)
defers.

Resource contract at ordinary-push volume (r2-2):
- Scratch-ref pinning uses ONE batched `git update-ref --stdin` transaction
  per repo per capture (creation and cleanup), never a subprocess per OID
  (`pins.ts:36,53` is per-call today); an explicit per-repo pinned-ref
  bound (default 512; beyond it, defer with reason rather than degrade).
- Check placement: the keep-mine substrate uploads artifacts BEFORE the
  stability check (`capture.ts:283-353`); at ordinary volume that lets
  churn repeatedly upload refused bytes. Ordinary capture runs the
  stability comparison BEFORE artifact upload (staged bytes are local at
  that point); if reordering is infeasible for a path, a per-repo
  rejected-bytes budget per hour bounds waste and defers beyond it.
- Crash bounds: pins from a killed capture are reaped at the next startup
  recovery pass (rides 178 t3's classification machinery); acceptance
  includes a kill-mid-capture → restart → no stale scratch refs test.
- Benchmarks required before ship: ref-heavy repo (10k refs) and shared
  common-dir (N worktrees) capture cost, before/after, on the rig.

182 makes A0 the gate: **no mechanism that increases capture frequency
ships before A0.** A0 is valuable standalone (agent churn tickles the
latent defect at today's 60s cadence). Acceptance: the 177 crash/flip
matrix rerun against ordinary capture (minus the presence-veto cases);
mismatch → defer-with-reason (base carry), never publish.

### A1: event-driven micro-gap capture (after A0)

Extend lock observation to the busy set, with corrected placement (r1-2)
and explicit bounds (r1-3, r1-4):

- **Targets and roots (r1-2, r2-6):** two NEW side-channel-only, role-
  indexed structures — `lockBases` (`index`, `config` → their `.lock`
  tails; `index` under the gitDir role, `config` under the commonDir role)
  and `literalTargets` (`gc.pid` under the commonDir role). The registry
  classifier consults a precomputed per-root role mask; classification
  cost is independent of contributor count (contributor iteration at
  `git-ref-watch.ts:751` is bounded by the shared-root owner set, which is
  what the O(1)-per-event ingestion assertion measures). The shared
  `GIT_REF_SIGNAL_TAIL_TABLE` used by content-watcher classifiers is
  untouched, so darwin Parcel behavior does not change and the NEW busy
  targets cannot double-signal (existing HEAD/packed-refs/ref signals are
  already visible on both planes on Linux — that pre-existing duplication
  is out of scope and noted, not fixed).
- **Coverage limit (r2-5, accepted-modified):** the registry admits only
  canonical roots inside the sync root (`git-ref-watch.ts:663`); a linked
  worktree whose commonDir lives OUTSIDE the workspace is explicitly out
  of A1 coverage and stays scan-bound (60s floor). No external-commonDir
  watching — that is a scope/permissions hazard, not a table entry. The
  linked-worktree acceptance test covers the in-workspace shape
  (gitDir ≠ commonDir, both inside the root) and asserts the external
  shape degrades to scan-bound, not that it signals.
- **Attempt budget (r1-4, r2-3, r2-4), the actual contract:** the counted
  unit is a FORMED push attempt at pump dequeue (`daemon.ts:1470` area),
  not a `requestPush` admission (`requestPush` only ORs a want bit,
  `daemon.ts:951`). Per-daemon (one workspace root): a minimum-interval
  floor between signal-attributed attempts (default 5s) and a rolling
  60s-window ceiling (default 12 attempts). A signal-attributed attempt's
  causally-derived busy retries (the 2s/8s follow-ups, `daemon.ts:971`)
  inherit the originating token — they count against the same window and
  cannot bypass the governor by reclassifying as `other`. Coalescing
  under-counts are fine; bypass over-counts are not.
- **Trailing-edge retention (r2-4):** the governor RETAINS (never drops) a
  suppressed signal: a signal arriving inside the floor arms a next-
  eligible timer that fires one attempt when the floor expires (cleared on
  shutdown). Otherwise a create-edge burns the floor and the remove-edge —
  the entire point of A1 — lands inside it and is lost.
- Raw-event ingestion cost O(1) per event, no allocation growth;
  acceptance on the rig under a synthetic agent-churn loop (git commit
  every 300ms for 5min): signal-attributed attempts ≤ ceiling, CPU delta
  < 5% vs baseline.
- Safety: every attempt still passes the point probe AND (post-A0) the
  staged-snapshot stability endpoint; the remove edge finds gaps, the
  bracket proves them.

### A2 (gated): darwin eligibility

Unchanged from v1: expanding `gitRefSideChannelEligible` to darwin requires
a source-verification spike (Bun `fs.watch` on darwin: create+remove
delivery, shallow/recursive semantics vs `git-ref-watch.ts:599-634`),
delivered as a rig platform test. Until then the Mac stays scan-bound —
which also means A1's benefit is Linux-only and the founder's primary
machine needs A2 or B to feel anything.

### B (phase 2 — separate design rounds required): demand-driven flush

Round 1 established B's v1 sketch was under-specified on five fronts.
B stays in this doc as a REQUIREMENT SET; its wire contract gets its own
design rounds before any implementation:

1. **Identity (r1-9, r1-12):** the Worker overwrites the socket attachment
   with the AUTHENTICATED `p.deviceId` + bindingId; the DO rejects
   attachments it did not stamp. Routing is binding-scoped end to end
   (advertisement, attachment, demand), never device-only.
2. **Authorization + session (r1-10):** demand-senders must hold write-level
   authz (viewers cannot induce work); inbound demand frames AND targeted
   sends apply the same fail-closed session-age check as outbound
   broadcast (`ws-fanout.ts:20-58`).
3. **DO work bounds (r1-11):** fixed frame-size limit, schema with
   fixed-width fields, per-sender token bucket, bounded target lookup via
   WebSocket tags (not a full `getWebSockets()` scan), capped fanout.
4. **Advertisement (r1-5..8, r1-18, r2-7):** capture-lane-only (apply/
   config lanes are not demandable); repo identity is a fixed-width
   domain-separated MAC under a workspace E2EE secret with a CANONICAL
   input pinned in B's doc (domain tag ‖ accountId ‖ workspaceId ‖
   bindingId ‖ canonical repo relpath, fixed encoding), rotation +
   collision rules, and explicitly-accepted equality/cardinality leakage —
   superseding 120's prohibition in writing; ages not timestamps (120's
   rule); bounded by BOTH entry count (N=8) and a max advertisement body
   size in bytes; a SHORT freshness TTL (minutes, not the fleet-alert
   2.5h) after which the server treats the advertisement as withdrawn;
   explicit withdrawal (an upload with no advertisable lanes clears it —
   this is what makes "CLEARED advertisement = success" in item 5
   mechanically real); defined ordering relative to `committed` frames;
   old-client rule pinned (a report from a client too old to carry the
   field withdraws any stored advertisement rather than preserving stale
   state); a defined DELIVERY path to B with authenticated, bounded
   responses (candidates: pull-response piggyback like the §27 download
   grant, or an initial WS frame — decided in B's own round 1); envelope
   evolution as v2 with server-first deploy AND old-server dual-post
   fallback, fixing the fingerprint-before-drop-check suppression
   (`sync-state.ts:90-102`) first; an API-key-principal story
   (least-privilege state reporting or explicit device-credential-only
   scope).
5. **Loop prevention (r1-13) + service guarantee (r1-14):** demands are
   deduped by advertisement generation; resend cooldown; an active window
   never re-arms from its own traffic; only a CLEARED advertisement (not a
   `committed` frame) counts as success. On A, the demand escalation is a
   first-class scheduler operation with 178-recoveryProbe-style fairness
   (bounded service guarantee, K-dequeue outrank) — not a `want.push`
   boolean, which is whole-workspace and lowest-priority
   (`policy.ts:104-111`) and could receive zero service inside the window.
   Additionally (r2-8): escalation carries its own capture-side token/
   backoff policy (the registry's `#recordRetry` covers watch-plane
   failures only, not capture planning — a capture that keeps bouncing
   busy inside a window backs off within the window), and a contention
   contract with design 177's bounded FOREGROUND keep-mine lock
   acquisition (`177:55-70`): foreground resolution always outranks a
   demand window; a window never delays or interleaves with an active
   keep-mine execution.

### C (phase 2, after A1 field data): churn-as-heat

Round 1 (r1-15) showed the current signal shape cannot support it:
`onSignal` carries no owner, the debouncer keeps a boolean, over-cap repos
emit nothing (lexicographic admission, `git-ref-watch.ts:522-535`), and
capture-pool reordering cannot help a repo already bounced at the busy
probe. C's requirement set: attributed signals (repo identity on the
side-channel callback), a decayed bounded heat map, shared-common-dir
attribution policy, admission hysteresis so hot repos can enter the cap,
an aging bound preventing cold-repo starvation, and a defined scheduler
seam. Not designed further until A1 ships and field data shows reordering
matters.

### D. Don't guess transience (policy, unchanged)

Sync everything; let deletion propagate; content-addressing makes
doomed-work bandwidth cheap. Hygiene = ghost-record cleanup (pr8 class, in
178 t3) and remnant pruning — not prediction.

### E. Agent-readable status contract (narrowed r1-16, r1-17)

1. **Calm copy, bounded by 176's frozen grammar (r1-17):** the shared
   `git deferred` line keeps exact bytes (logs, doctor redaction, parsers,
   rig fixtures — `176:127-154`); only companion/status lines change. CLI
   `rbox status` deferral companions state what, since when, no action
   needed.
2. **Structured agent verdict, gated on 178 t3 (r1-16, r2-9):** the
   verdict answers exactly ONE question — "what happens if you run
   `rbox stop` right now?" — which makes the values mutually exclusive by
   construction (r2-9: "safe to leave running" and "stop will wait" are
   not exclusive; answers to the stop question are). Discriminated JSON
   object in `rbox status --json`:
   `{"agentStopVerdict": {"outcome": "stops-cleanly" | "waits" |
   "not-running" | "unknown", "phase"?: <t3 critical-phase enum>}}` plus
   one derived stable text line. `phase` appears only with `"waits"` and
   its domain is EXACTLY the critical-section enum 178 t3's graceful-stop
   witness authors (not the transfer-phase union, which describes
   transfers, not stop hazards). Fail-closed precedence: stale heartbeat,
   daemonVersion skew vs the CLI, or a reset/halt state the CLI cannot
   classify → `"unknown"`; no live daemon (pidfile absent/dead) →
   `"not-running"` (round 1's conservative stopped outcome). No ETA —
   there is no bounded estimator (pull does not wire `onGitProgress`).
   `"waits"` is only truthful once t3's graceful stop ships (today's stop
   still SIGKILLs at 60s, `daemon-control.ts:510-563`); until then the
   field ships with the other three outcomes only. Vocabulary
   compile-enforced in the shell/telemetry allowlist like 178's mode
   witness.

## Relationship to existing work

- 177: A0 IS 177's named ordinary-push follow-up; keep-mine machinery
  (scratch refs, staged snapshot) is the implementation substrate.
- 178 t2 (shipped): deferral hygiene floor. 178 t3 (in implementation):
  lock classification + graceful stop — prerequisite for E2's
  "stop-will-wait" and for trusting lock-plane signals.
- 176: frozen deferral grammar bounds E1. 174: held-apply floors untouched.
- 120/105: B's advertisement supersedes their metadata ceilings and must
  say so explicitly in B's own design doc.

## Priorities / ship order (v2)

1. **E1** (copy companions) — small, no gates.
2. **A0** (ordinary-capture stability hardening) — closes a today-defect;
   gates everything else.
3. **A1** (side-channel busy-set observation, Linux) — after A0.
4. **E2** (agent verdict) — `safe/unknown` immediately post-A0 review;
   `stop-will-wait` after 178 t3 ships.
5. **B** — own design doc + rounds against the requirement set above.
6. **C** — after A1 field data. **A2** — after the darwin spike.

## Non-goals (pinned)

- No capture of mid-operation git state: post-A0 this is enforced by a
  staged-snapshot bracket, not a point probe.
- No transience prediction / selective sync.
- No new daemon-stop choreography.
- No correctness dependence on WS delivery (105's contract).
- No relaxation of the 60s safety floor; event planes are additive.
- No repo paths or reversible path hashes off-machine (120's rule; B may
  supersede it only with the MAC'd-digest contract).

## Tests the implementation must write

- A0: 177 crash/flip matrix generalized to ordinary capture (A→B→A index
  flip, ref move mid-capture, op-state root APPEARING mid-capture →
  defer-with-reason via instability, nothing published) — AND the
  carve-out: a STABLE paused rebase/merge publishes and round-trips as
  today (the design-43 E2E stays green). Batched pin transaction (one
  update-ref --stdin per repo, pinned-ref bound honored);
  stability-check-before-upload ordering (or the rejected-bytes budget);
  kill-mid-capture → restart → no stale scratch refs.
- A1: root-mapping classification for in-workspace linked worktrees
  (gitDir ≠ commonDir); external-commonDir worktree degrades to scan-bound
  (no signal, no error); table split leaves content-watcher classification
  unchanged on both backends; attempt accounting at dequeue with busy-
  retry token inheritance (a 2s/8s follow-up cannot exceed the window);
  trailing-edge retention (create-edge inside floor → remove-edge still
  yields exactly one attempt at floor expiry; timer cleared on shutdown);
  floor + rolling ceiling under synthetic churn (injected clock); O(1)
  raw-event ingestion (allocation/CPU assertion on the rig); busy-probe
  bounce on signal-attributed attempt.
- E1: frozen-grammar bytes unchanged (fixture diff); companions present.
- E2: vocabulary compile-enforced; `--json` parity; `unknown` on stale
  status; `stop-will-wait` absent until the t3 witness exists.
- B/C: test lists live in their own design rounds.
