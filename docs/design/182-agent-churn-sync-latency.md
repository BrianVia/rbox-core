# 182 — sync latency under continuous agent churn (capture in the gaps)

Status: ALIGNED v8 — round 8 (gpt-5.6-sol, high) certified r7-1/2/3
closed with zero findings. Eight-round loop, strictly narrowing:
19/5 → 9/3 → 7/2 → 7/2 → 5/1 → 1 blocker → 3 protocol findings → 0.
Ship order stands (E1 → A0 → A1 → E2 → B's own design rounds → C → A2);
A0 and the E2 witness carry named interface requirements ON 178 t3
(always-live criticalPhase witness with the reservation entry protocol;
pin-journal ownership discipline).

History (loop): v7 folded r6 (fail-closed publish-or-defer); v8 folded
r7 (entry/stop linearization, retry liveness, acceptance matrix).

History: v5 folded round 4 (7/2: journal-pin sweep, E2 gating, doPush
governor, argv cliff, fanout behind debounce, distinct-OID benchmark).
v6 folded round 5 (concrete criticalPhase interface; governed-attempt
ceiling; indeterminate pins preserved indefinitely).

History: v2 folded round 1 (19 findings, 5 blockers; A0 prerequisite
created; B/C demoted to phase-2 requirement sets; E narrowed and
half-gated on 178 t3). v3 folded round 2 (9/3: A0 presence-veto carve-out,
dequeue-token budget, external-commonDir out of coverage, E2 discriminated
stop-verdict).

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

Resource contract at ordinary-push volume (r2-2, tightened r3-1..4):
- Scratch-ref pinning uses batched `git update-ref --stdin` transactions
  (chunked; never a subprocess per OID — `pins.ts:36,53` is per-call
  today). No publication-blocking cardinality cliff (r3-2): the bound is
  an abuse valve only (default 100k pins), far above legitimate ref
  counts; the 10k-ref benchmark must assert SUCCESSFUL publication, not
  just cost.
- Check placement (r3-3): the stability endpoint runs BEFORE every
  artifact upload for ordinary capture, unconditionally. No escape hatch —
  the staged bytes are local at comparison time; there is no path that
  needs to upload first.
- ABA semantics (r3-4): A0 adopts 177's contract — an index/ref A→B→A flip
  around a capture whose staged closure is pinned publishes COHERENTLY
  (`177:290-298`); instability-defer applies when the final live state
  does not equal the staged snapshot. The acceptance matrix encodes both:
  ABA-publishes-coherently, A→B-defers.
- Bundle input bound (r4-4): chunked pin CREATION is not enough — capture
  currently passes every pin/ref as `git bundle create` argv
  (`capture.ts:291` → `shared.ts:141`), which hits ARG_MAX (~2MiB) far
  below the abuse valve. A0 moves bundle revision input to a non-argv
  mechanism (`git bundle create --stdin`), so the valve is the only
  cardinality bound anywhere in the path.
- Pin ownership (r3-1, r4-1): scratch-ref reaping gets the same
  ownership discipline as t3's lock journal — pins are created under a
  namespace carrying owner incarnation (host/boot/pid/start) and a
  journal record listing the pinned names. The existing age-only sweep
  (`pins.ts:57`, runs pre-capture at `capture.ts:231`) is REPLACED for
  journal-bearing namespaces — age alone never deletes a pin whose
  journal classifies `live` or `indeterminate` (r4-1: the sweep deleting
  a >1h-old live sibling's pins is exactly the 178 fail-closed violation).
  The age guard survives ONLY for legacy journal-less namespaces (pre-A0
  leftovers). Startup reap classifies
  `live` (owner alive → preserve; linked-worktree siblings share the ref
  store, so a live sibling capture's pins are untouchable) /
  `recoverable-rbox` (valid record + dead owner → reap under the
  common-dir fence) / `indeterminate` (preserved INDEFINITELY — r5-3:
  never age-reaped; the age-guarded sweep at `pins.ts:33-74` applies to
  legacy journal-less namespaces only). "Restart → no stale refs" applies
  only to provably-owned dead pins.
- Benchmarks required before ship: ref-heavy repo with 10k DISTINCT
  captured OIDs (r4-6: pin roots dedup through a Set, `capture.ts:274` —
  10k refs on one OID exercises nothing), forcing multiple
  pin-transaction chunks and asserting successful publication; shared
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
  classifier consults a precomputed per-root role mask that ELIMINATES
  contributor iteration from raw-event classification (r3-6: the current
  hot path loops contributors per event, `git-ref-watch.ts:742-761` —
  that loop must not run for a raw-event classify/reject decision).
  Contributor fanout moves BEHIND the debounce boundary (r4-5): a
  classified signal sets an O(1) pending bit; the debouncer flush
  performs contributor fanout once per window. Per-raw-event work is
  O(1); per-WINDOW work is O(contributors) and bounded by the window
  rate — signal events are the churn workload, so this is the property
  that keeps ingestion flat. Asserted across INCREASING shared-worktree
  counts (1/4/16): raw-event cost flat, windowed fanout linear-in-
  contributors but window-rate-bounded. The shared
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
- **Attempt budget (r1-4, r2-3, r2-4, r4-3), the actual contract:** the
  governor sits at EVERY `doPush` entrance, not only the ordinary push
  dequeue — recovery probes are separate dequeued operations that also
  consume pending push provenance and invoke `doPush`
  (`daemon.ts:1373,1402`; `policy.ts:92`). Contract: token consumption is
  observed at `doPush` entry regardless of operation kind; a recovery
  probe consuming the signal token COUNTS against the window but is NEVER
  floor/ceiling-suppressed (178's recovery fairness dominates); ordinary
  signal-attributed attempts are governed, and suppression retains +
  re-arms per the retention rule below. Per-daemon (one workspace root):
  a minimum-interval
  floor between signal-attributed attempts (default 5s) and a rolling
  60s-window ceiling (default 12 attempts). Token state machine (r3-5):
  the signal token is STICKY on the pending want until dequeue — merging
  with non-signal causes into the single push-want boolean
  (`daemon.ts:951-963`) never erases it; the formed attempt is
  signal-attributed if ANY contributing cause was. Causally-derived busy
  retries (the 2s/8s follow-ups, `daemon.ts:971-994`, which today
  re-enter as `other`) inherit the token and count against the same
  window. Coalescing that under-counts is fine; attempts that escape
  counting (an uncounted bypass) are not (r3-5 phrasing fix: a bypass is
  an undercount of the governor, and undercounted ATTEMPTS are the
  hazard).
- **Retention (r2-4, r3-5) — floor AND ceiling:** the governor RETAINS
  (never drops) suppressed work. A signal inside the floor arms a
  next-eligible timer that fires one attempt at floor expiry; work
  suppressed by CEILING exhaustion stays pending and re-arms at the
  earliest rolling-window eligibility. Both timers are cleared on
  shutdown. Otherwise a create-edge burns the budget and the remove-edge —
  the entire point of A1 — lands inside it and is lost.
- Raw-event ingestion cost O(1) per event, no allocation growth;
  acceptance on the rig under a synthetic agent-churn loop (git commit
  every 300ms for 5min): ordinary GOVERNED signal-attributed attempts ≤
  ceiling (r5-2: recovery-probe overrides execute regardless, are counted,
  and may push the counted total past the ceiling — asserted separately:
  overrides run, are counted, and suppress subsequent ordinary attempts),
  CPU delta
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
   transfers, not stop hazards). Fail-closed precedence, in evaluation
   order (r4-7): (1) no live daemon (pidfile absent/dead) →
   `"not-running"`, even when halt/reset records exist; (2) stale
   heartbeat, daemonVersion skew vs the CLI, or a state the CLI cannot
   classify → `"unknown"`; (3) live critical section → `"waits"`;
   (4) otherwise → `"stops-cleanly"`. No ETA — there is no bounded
   estimator (pull does not wire `onGitProgress`).
   BOTH positive live outcomes gate on 178 t3 (r4-2): `"waits"` AND
   `"stops-cleanly"` require t3's critical-phase witness to be ALWAYS-LIVE
   and boot-bound — not a shutdown-time record (a witness first published
   after the mutation gate closes cannot answer the pre-stop question,
   and pre-t3 `"stops-cleanly"` is unprovable while stop can still
   SIGKILL at 60s, `daemon-control.ts:510-563`).
   Concrete interface (r5-1), a named requirement ON t3:
   - Standing field in `daemon.status.json`:
     `criticalPhase: {"state":"idle"} | {"state":"active",
     "phase":<t3 enum>, "since":<iso>} | {"state":"degraded"}`
     (`degraded` → `"unknown"`), valid only when the record's
     `bootId` matches the live v2 pidfile (same rule as 178's mode
     witness). Field ABSENT (old daemon) → both positive outcomes
     unavailable → `"unknown"`.
   - Happens-before rule (r6-1, fail-CLOSED): the `active` publication is
     written (fsync + atomic rename) and AWAITED before critical-section
     work begins — entry into the mutation gate blocks on the
     acknowledged status write, replacing the current fire-and-forget
     callback shape (a synchronous void hook queuing an unawaited,
     error-suppressed write lets a critical section start while status
     still shows idle → false `"stops-cleanly"` for up to the stale
     window). If the `active` write FAILS, the daemon attempts to publish
     an explicit degraded witness (`criticalPhase:{"state":"degraded"}` +
     the boot-sticky `witnessDegraded` bit); if THAT also fails, the
     critical entry does not proceed — the operation DEFERS with reason
     and retries later. Work never runs behind a same-boot `idle` record.
     Exit publishes `idle` best-effort AFTER the section (a crash
     mid-section leaves `active`, which reads conservative).
   - Entry/stop linearization (r7-1): the gate's close-vs-enter safety
     currently assumes synchronous run-to-completion
     (`mutation-gate.ts:32` in the t3 worktree), and awaiting a
     publication breaks that. Protocol: (1) take a SYNCHRONOUS gate
     reservation before awaiting any publication — stop's drain counts
     reservations, so it cannot complete under a tentative entrant;
     (2) after the awaited publication, re-check the gate — if it closed
     while awaiting, release the reservation and defer WITHOUT doing
     work; (3) reservation release is unconditional (finally) on every
     path — success, publication failure, and gate-closed — so a failed
     entrant can never wedge drain.
   - Defer/retry liveness (r7-2): a publication-failure defer RETAINS the
     operation (the want is not lost), retries under the existing
     busy-retry pacing (bounded backoff, coalescing with other pending
     wants — never a hot loop), and is shutdown-aware: once the gate
     closes, the retry is canceled and never re-arms; a deferred entrant
     holds no reservation and never blocks drain.
   - Durability scope (r6-editorial): "durable" means atomically visible
     to same-boot readers (fsync of the temp file + rename); parent-dir
     fsync / power-loss durability is NOT required — a power loss ends
     the boot, and the witness is bootId-invalid on the next one.
   Pre-t3, E2 ships `"not-running" | "unknown"` only. Vocabulary
   compile-enforced in the shell/telemetry allowlist like 178's mode
   witness.

## Relationship to existing work

- 177: A0 IS 177's named ordinary-push follow-up; keep-mine machinery
  (scratch refs, staged snapshot) is the implementation substrate.
- 178 t2 (shipped): deferral hygiene floor. 178 t3 (in implementation):
  lock classification + graceful stop — its always-live standing witness
  gates BOTH positive E2 outcomes, and it is the prerequisite for
  trusting lock-plane signals.
- 176: frozen deferral grammar bounds E1. 174: held-apply floors untouched.
- 120/105: B's advertisement supersedes their metadata ceilings and must
  say so explicitly in B's own design doc.

## Priorities / ship order (v2)

1. **E1** (copy companions) — small, no gates.
2. **A0** (ordinary-capture stability hardening) — closes a today-defect;
   gates everything else.
3. **A1** (side-channel busy-set observation, Linux) — after A0.
4. **E2** (agent verdict) — `not-running`/`unknown` may ship anytime;
   BOTH positive outcomes (`stops-cleanly` AND `waits`) after 178 t3's
   always-live witness ships (r4-2).
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

- A0: 177 crash/flip matrix generalized to ordinary capture with 177's
  semantics (r3-4): A→B→A index/ref flip around a pinned staged closure
  publishes COHERENTLY; A→B (final live ≠ staged) defers via instability;
  op-state root APPEARING mid-capture defers via instability — AND the
  carve-out: a STABLE paused rebase/merge publishes and round-trips as
  today (the design-43 E2E stays green). Chunked batched pin transactions
  (abuse valve honored, no publication cliff; benchmark = 10k DISTINCT
  captured OIDs forcing multiple pin-transaction chunks, publication
  asserted); bundle revisions via --stdin (an over-ARG_MAX ref set
  publishes); stability-check strictly before upload; pin-ownership
  classification (dead-owner reap under fence, live-sibling pins
  preserved, journal-bearing INDETERMINATE pins preserved indefinitely —
  the age backstop applies to legacy journal-less namespaces only);
  kill-mid-capture → restart → provably-owned dead pins reaped.
- A1: root-mapping classification for in-workspace linked worktrees
  (gitDir ≠ commonDir); external-commonDir worktree degrades to scan-bound
  (no signal, no error); table split leaves content-watcher classification
  unchanged on both backends; token consumption observed at every doPush
  entrance (ordinary and recovery-probe) with busy-retry token
  inheritance (a 2s/8s follow-up cannot escape the window's accounting);
  trailing-edge retention (create-edge inside floor → remove-edge still
  yields exactly one attempt at floor expiry; timer cleared on shutdown);
  floor + rolling ceiling under synthetic churn (injected clock); O(1)
  raw-event ingestion (allocation/CPU assertion on the rig); busy-probe
  bounce on signal-attributed attempt.
- E1: frozen-grammar bytes unchanged (fixture diff); companions present.
- E2: vocabulary compile-enforced; `--json` parity; precedence order
  asserted (`not-running` before `unknown` before `waits` before
  `stops-cleanly`: no live daemon → `not-running` even when halt/reset
  records exist; stale heartbeat or version skew with a live pidfile →
  `unknown`); BOTH `waits` AND `stops-cleanly` absent (→ `unknown`) until
  the boot-bound `criticalPhase` witness exists and is bootId-valid;
  witnessDegraded bit forces `unknown` for the rest of the boot.
  Entry-protocol matrix (r7-3), deterministic (injected writer + clock):
  active-publish success → work runs behind `active`; active fails +
  degraded succeeds → no work, status `unknown`, one retained retry;
  both publications fail → ZERO mutation, one retained paced retry;
  stop racing an awaited publication → drain waits for the reservation,
  the entrant observes the closed gate post-await, releases, and no
  retry re-arms post-stop.
- B/C: test lists live in their own design rounds.
