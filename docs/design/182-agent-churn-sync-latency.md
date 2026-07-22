# 182 — sync latency under continuous agent churn (capture in the gaps)

Status: DRAFT v2 — round 1 (gpt-5.6-sol, high) verdict CHANGES-REQUIRED with
19 findings (5 blockers); all accepted or accepted-modified, none overruled,
folded here. Structural consequence: a new prerequisite A0 (generalize
design 177's capture-stability hardening to ordinary pushes) gates every
mechanism that raises capture frequency; B and C are reframed as phase-2
designs with their round-1 constraints pinned as requirements; E is
narrowed and half-gated on 178 t3. Round 2 should re-attack A0/A1/E and the
B/C requirement sets.

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

Generalize design 177's keep-mine capture hardening — scratch-ref-pinned
bundle roots, stability endpoint against the STAGED snapshot (staged index
bytes, staged op-state, presence bits), staged pin roots, in-progress
presence veto (`177:192-258`) — to ordinary capture. 177 already names this
"a separate follow-up since it is a latent general defect"; 182 makes it
the gate: **no mechanism that increases capture frequency ships before
A0.** A0 is valuable standalone (it closes a today-defect that agent churn
already tickles at 60s cadence). Acceptance: the 177 crash/flip matrix
rerun against ordinary capture; mismatch → defer-with-reason (base carry),
never publish.

### A1: event-driven micro-gap capture (after A0)

Extend lock observation to the busy set, with corrected placement (r1-2)
and explicit bounds (r1-3, r1-4):

- **Targets:** `index` → gitDir root; `config` → commonDir root; literal
  `gc.pid` → commonDir root as an ordinary target (not a `.lock` tail).
  Linked-worktree test required (gitDir ≠ commonDir).
- **Table split (r1-3):** lock-base targets live in a NEW side-channel-only
  table consumed by `GitRefWatchRegistry`'s classifier; the shared
  `GIT_REF_SIGNAL_TAIL_TABLE` used by the content-watcher classifiers is
  unchanged, so darwin Parcel behavior does not silently change and Linux
  cannot double-signal one edge on two planes.
- **Attempt budget (r1-4), the actual contract:** a per-workspace
  minimum-interval floor between signal-triggered push attempts (default
  5s) plus a global ceiling (default 12 attempts/min) enforced where the
  debounced signal converts to `requestPush` — not in the debouncer.
  Raw-event ingestion cost must be O(1) per event with no allocation
  growth; acceptance ceiling measured on the rig under a synthetic
  agent-churn loop (git commit every 300ms for 5min): signal-triggered
  attempts ≤ the ceiling, CPU delta < 5% vs baseline.
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
4. **Advertisement (r1-5, r1-6, r1-8, r1-7, r1-18):** capture-lane-only
   (apply/config lanes are not demandable); repo identity is a fixed-width
   domain-separated MAC under a workspace E2EE secret (never a bare hash —
   supersedes 120's prohibition explicitly, with rotation + collision
   rules, and accepts equality-cardinality leakage in the doc); ages not
   timestamps (120's rule); a defined DELIVERY path to B (candidates:
   pull-response piggyback like the §27 download grant, or an initial WS
   frame — decided in B's own round 1); envelope evolution handled as a
   v2 envelope with server-first deploy AND old-server dual-post fallback,
   fixing the fingerprint-before-drop-check suppression
   (`sync-state.ts:90-102`) first; an API-key-principal story (least-
   privilege state reporting or explicit device-credential-only scope).
5. **Loop prevention (r1-13) + service guarantee (r1-14):** demands are
   deduped by advertisement generation; resend cooldown; an active window
   never re-arms from its own traffic; only a CLEARED advertisement (not a
   `committed` frame) counts as success. On A, the demand escalation is a
   first-class scheduler operation with 178-recoveryProbe-style fairness
   (bounded service guarantee, K-dequeue outrank) — not a `want.push`
   boolean, which is whole-workspace and lowest-priority
   (`policy.ts:104-111`) and could receive zero service inside the window.

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
2. **Structured agent verdict, gated on 178 t3 (r1-16):** a JSON field (not
   a prose line) in `rbox status --json` + one stable text line:
   `agent-verdict: safe-to-leave-running | stop-will-wait (<phase>) |
   unknown`. No ETA — there is no bounded estimator (pull does not wire
   `onGitProgress`; ambient phases are coarse). "stop-will-wait" is only
   truthful once t3's graceful stop ships (today's stop still SIGKILLs at
   60s, `daemon-control.ts:510-563`); until then the field ships with
   `safe-to-leave-running | unknown` only. Vocabulary compile-enforced in
   the shell/telemetry allowlist like 178's mode witness.

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
  flip, ref move mid-capture, op-state root appearing mid-capture →
  defer-with-reason, nothing published).
- A1: root-mapping classification incl. linked worktrees (gitDir ≠
  commonDir); table split leaves content-watcher classification unchanged
  on both backends; attempt floor + global ceiling under synthetic churn
  (injected clock); O(1) raw-event ingestion (allocation/CPU assertion on
  the rig); busy-probe bounce on signal-triggered attempt.
- E1: frozen-grammar bytes unchanged (fixture diff); companions present.
- E2: vocabulary compile-enforced; `--json` parity; `unknown` on stale
  status; `stop-will-wait` absent until the t3 witness exists.
- B/C: test lists live in their own design rounds.
