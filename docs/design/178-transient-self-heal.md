# 178 — transient hiccups heal themselves

Status: ALIGNED v5 — second field-trace R9 verdict ALIGNED after two review
passes. Pending mode is now an orthogonal durable user-intent register: stop
preserves it, bare start never authors it, explicit flags replace it before
daemon work, and matching boot-bound witnesses may promote it at start, stop,
or status without promotion being required for survival. v4's r3 verdict was
ALIGNED with three minor notes, folded:
vocabulary inventory completed (API allowlist telemetry-ingest.ts:118 —
deploy before/alongside the CLI addition — plus compile-enforced mappings
breadcrumb-veto.ts:56, git-cmd.ts:592); the mode witness carries `bootId`
in daemon.status.json compared against the live pidfile, with a
stale-status/new-boot rejection test; explicit mode-matrix tests
(bare/explicit × matching/different/unknown, spawn-before-witness, stopped
legacy-mode preservation). Implementation tranche 1 = workstream D +
workstream E's stopped-daemon-resume half. History: r3 was preceded by v3 — r2 certified D.3 (pure composer dry-run implementable;
order-insensitive semantic equality; sentinel sourceSeq documented) and
returned four substantive + two moderate gaps, all folded in v3: one pure
sanitizer applied at EVERY persistence site + config-lane baseline so
sanitation never authors a corrective echo (r2-1); a first-class composite
`recoveryProbe` scheduler operation with defined K and budget semantics
(r2-2); daemon-owned mode witness in the ambient status file, boot-bound,
with legacy-unknown handling and operator-driven restart on mismatch
(r2-3); stop carries the prior mode forward (r2-4); stale-unattributed is a
durable CATEGORICAL reason with display-time recomputed detail (r2-5);
unknown-reason byte preservation + shell/telemetry vocabulary updates
(r2-6). Previously v2 — synthesis of the 2026-07-21 incident's five forensic
reports (archived with evidence in `.claude/forensics-0721/`; cite them as
R1-timeline, R2-locks, R3-halt, R4-deferrals, R5-captureloop). r1
(gpt-5.6-sol, high) verdict CHANGES-REQUIRED; all eight findings accepted
and folded in v2: BASE=candidate proven by ACK-composer dry-run + deep
equality (r1-1), sanitized-vs-wire pending checkpoint specified (r1-2),
overlay uses durable pre-plan P (r1-3), R3 §4.5 fairness restored + bounded
probe service (r1-4), mode durability tri-state + persist-after-match with
E's live-transition half gated on A (r1-5), push recovery suspended in
pull-only (r1-6), shared classifier→action mapping incl. re-probed
stale-unattributed (r1-7), rig replay made constructible (r1-8). Round 2
pending.

## The standard (founder, verbatim)

"Shouldn't we more or less be able to auto heal from transient past hiccups
if our software is robust and we're not making any changes on a host? If rbox
can't get itself back into a naturally healthy state, why not? That's the
ultimate goal."

## The incident, compressed (R1)

One operator `rbox stop` at 21:33 UTC → SIGTERM during a 55-70s apply →
60-second clock-only **SIGKILL escalation** (daemon-control.ts:432) landed
inside the **unjournaled state-CAS witness-lock bracket** (apply.ts:1737:
one `wx` lockfile per applied ref, released only in a `finally`) → ~140
orphaned `refs/**/*.lock`. Existence-only busy probes (shared.ts:591)
deferred the whole 10-repo family for 2h; the stale git base made every push
a losing CAS race; 13 exhausted push episodes (~78 commit 409s) latched a
halt that only a successful push may clear (daemon.ts:1219); the failed
push's `want` was consumed and never restored (daemon.ts:1157), so retries
were ambient-only, and pull-priority starved them. Meanwhile the passive
replica — accidentally restarted without its pull-only flag — published 280
echo sequences in 2h50m via the advertised-over-pending comparison defect
(plan.ts:226), keeping the remote moving. Manual lock deletion + stopping
the replica healed everything in minutes. Every one of those minutes should
have been the software's.

## Mechanisms (six workstreams, ordered by causal depth)

### A. Crash-safe lock lifecycle (R2 — full draft in REPORT-2, adopt as spec)

1. **Ownership journal for the state-CAS bracket**: before the first lock,
   durably record txn id, owner incarnation (host/boot/pid/start), common-dir
   identity, the complete lock-path allowlist, and a per-lock random marker;
   the lockfile CONTAINS the marker (git only needs the path to exist).
   Release = exact compare-before-unlink (the current unconditional unlink at
   apply.ts:1774 can delete a successor's lock even without a crash — fix
   included).
2. **Recovery**: at startup (post-mutex, pre-pump) and on stable busy
   fingerprints in steady state, classify each blocking lock:
   `live` / `recoverable-rbox` (valid journal + dead owner → reap under a
   common-dir fence, retry immediately) / `stale-unattributed` (preserve,
   surface actionable attention with lock count + age + repair command —
   never auto-delete unowned locks) / `indeterminate` (fail closed).
   One recovery episode per common dir, not per linked worktree.
3. **Graceful stop**: shutdown gate checked before every mutation boundary;
   prepared-but-uncommitted transactions abort, committed ones drain;
   `rbox stop` NEVER clock-SIGKILLs a declared critical section — it reports
   the active phase and keeps waiting; ancillary close failures cannot bypass
   the drain (settle, don't await serially).
   Invariants L1-L7 and the crash-injection test matrix in R2 §6-7 are
   adopted verbatim.

### B. Halt = currently reproducing condition (R3 — contract in REPORT-3 §4)

1. Every halt owns a **recovery timer** (full-jitter exponential backoff,
   cap ~2min) independent of ambient activity; the failed op's `want` is
   restored, not consumed.
2. Push-conflict recovery is a transaction: pull head → reconcile → if no
   publishable local divergence, CLEAR immediately → else one push probe;
   success or no-op clears; another exhaustion refreshes the episode.
3. Episode fields separate signal age from retry count (`firstFailureAt`,
   `lastFailureAt`, `consecutiveFailures`, `nextProbeAt`).
4. Safety-guard halts (mass-delete) keep requiring their own predicate to
   stop reproducing — never cleared by an unrelated success, never requiring
   an operator to clear the FLAG (only ever the cause).
5. Status copy: "retrying after conflict; next probe in Ns" while armed;
   "halted" is reserved for a currently-reproduced safety refusal.
6. **Fairness + bounded probe service (r1-4, restoring R3 §4.5; mechanism
   per r2-2; fixes R1 decision 8):** recovery is a FIRST-CLASS composite
   scheduler operation, `recoveryProbe` = pull → reconcile → conditional
   push, distinct from the four ordinary wants (policy.ts:78) — never
   represented as a bare restored `want.push` that re-enters at the bottom
   of the strict priority order. Service bound: once due, after **K = 8
   actually DEQUEUED non-probe operations** (scans count — r2-2: deep/full
   scans self-replenish and would defeat a pulls-only count), the probe
   outranks all ambient operations for one slot. Mutex-contention loops
   that dequeue nothing do not consume the budget; multiple due probes
   coalesce into one composite run; `nextProbeAt` persists in the episode,
   the K counter is in-memory (a restart re-arms the timer, not the
   starvation count). Episode-level contention backoff escalates across
   exhausted push episodes and resets only on success/no-op; the
   unconditional post-pull push request is suppressed when reconciliation
   proves no publishable local delta; server-side randomized Retry-After on
   409 is the durable fairness follow-up (own workstream, apps/api).
   Deterministic scheduler tests drive the pump loop directly (the
   continuous-peer rig case is corroboration, not the proof — wants
   coalesce into booleans and are timing-sensitive).
7. **Pull-only discipline (r1-6):** push recovery (want restoration and
   probes) is SUSPENDED in pull-only mode and rearms only on an explicit
   read-write transition; a durable push-halt episode surviving a restart
   into pull-only mode stays dormant. Lock recovery (A) always requeues
   pull; it requeues push only in read-write mode. Test: restart with a
   standing push halt into pull-only → no push attempts, episode retained
   dormant.

### C. Deferral hygiene (R4 — contract in REPORT-4, adopt as spec)

A deferral is a current assertion about the world. A shared cause-aware
reconciler (first cause: `git-busy`) runs before every computed status and
on a daemon hygiene cadence: re-probe the recorded cause (common-dir-deduped
busy probe), clear exactly the stale lane on a negative, fail closed on
inspection errors, persist via state-nonce/repoGen CAS with exact episode
match, refresh `syncBase` so ambient status reflects it immediately. Records
for repos that left discovery (the pr8 case — structurally unclearable
today) are in scope. The design-174 1h floor remains a held-apply
optimization bound and never doubles as deferral expiry.

**Shared classifier→action mapping (r1-7), one table used by A's recovery
AND C's reconciler** (the deferral reason union in config.ts:237 grows a
`stale-unattributed` state):

| A's classification | C's reconciler action |
|---|---|
| `quiescent` | clear the exact stale lane |
| `recoverable-rbox` | fenced recovery (A), then re-probe and clear |
| `live` | retain — genuine busy |
| `stale-unattributed` | retain lane, upgrade reason to the durable CATEGORICAL `stale-unattributed` (r2-5: `GitDeferral` carries no evidence payload and doesn't grow one — lock count/sample/oldest age and the repair command are RECOMPUTED at display time by the same cheap probe status already runs), and KEEP re-probing on the hygiene cadence so external resolution clears it — a latched diagnosis is the same disease as a latched git-busy |
| `indeterminate` | retain byte-for-byte, escalate if chronic |

**Vocabulary + compatibility (r2-6):** the reconciler selects ONLY exact
`git-busy` and `stale-unattributed` records and preserves every
unknown/future reason byte-for-byte (state loading is an unchecked cast,
config.ts:470 — forward records must round-trip). The new reason is added
to every closed vocabulary: shell reader (shell-init.ts:188), telemetry
contract's exhaustive reason list (telemetry/contract.ts:120), and
status-view's display mapping (unknown reasons stay opaque/non-actionable
per the existing convention).

### D. Pending state machine correctness (R5 — the loop's actual cause)

1. **PENDING has final precedence** in the expected-previous map: BASE, then
   advertised, then PENDING (plan.ts:226 currently lets `advertised`
   overwrite it) — carrying an exact pending section must compare
   `changed === false`. The overlay reads the DURABLE pre-plan checkpoint
   `state.gitPendingRemote`, never the planner's mutable pending map
   (r1-3: `syncGit:false` legitimately deletes planner entries at
   plan.ts:285, and a baseless removal must not masquerade as unchanged);
   regression pins the distinction.
2. **Sanitized vs wire pending (r1-2, tightened r2-1):** the sanitizer
   becomes ONE pure, input-immutable helper applied at EVERY P/BASE
   persistence site — including the outer collision and exception paths
   that today persist the raw wire section (apply.ts:1607/:1615/:1629) —
   so "persisted state is sanitized" is an invariant, not a tendency. The
   comparator compares sanitized-to-sanitized and exact carries are
   unchanged. The corrective-echo hole r2-1 found is closed in the config
   lane itself: `shouldPublishGitConfig` (config-lane.ts:23) additionally
   consults the config-lane baseline (`cfgSynced`) — an unchanged local
   config over a sanitized-away incoming one is NOT republished; corrective
   sanitation of the remote's invalid field waits for the next genuine
   local config change. Tests: sanitizer determinism + purity; collision
   and exception persistence paths; unchanged-nonempty-local-config over
   invalid-incoming publishes nothing.
3. **Supersession admission proves BASE convergence (r1-1):** "terminal
   disposition" is insufficient — the composer deliberately preserves
   BASE-only branches (base-composer.ts:335/:494), so a candidate omitting
   a BASE branch can be terminal while BASE ≠ candidate, re-arming the loop.
   Admission requires a DRY RUN of the exact final normalized candidate
   through the publisher-ACK composer with DEEP EQUALITY between the
   composed BASE and the candidate section; anything less carries exact P
   and defers.
4. End-to-end convergence regression: supersession ACK → pending absent →
   composed BASE deep-equals candidate → self-pull unchanged → next push
   no-op. Plus the savvy-core repro shape: why did an ACKed supersession
   reappear as pending on the next self-pull (BASE/ACK convergence — R5
   flags the log lacks section identity keys to prove which; the fix must
   add that logging).
5. Capture cache idempotence (real, reproduced, but secondary): stash
   against the staged index copy; fingerprint excludes `refs/rbox-*`,
   reflog side-effects, and parent-dir mtimes; refresh the divergence cache
   after capture cleanup.

### E. Mode durability (tonight's operator trap; scoped per r1-5)

Tri-state start intent: ABSENT (= preserve the persisted mode — today's
`main-dispatch.ts:386` collapses absence to `false`, the exact trap),
`--pull-only`, and a new explicit `--read-write` inverse.

**Mode witness (r2-3):** the daemon writes its ACTUAL running mode into the
ambient status file each persistence (`mode: "pull-only" | "read-write"` —
same additive pattern as the `daemonVersion` field shipped in v1.7.19),
bound to the existing boot-id record. "Actual live mode matches" is read
from that witness, never inferred from the spawn request. Legacy daemons
without the field → mode UNKNOWN: bare start treats the persisted desired
mode as the intent but never silently rewrites it; explicit-flag start
against an unknown-mode live daemon refuses with the restart instruction.
The desired record separates daemon liveness from accepted mode. A successful
spawn immediately publishes `state: "running"`; that fact never waits for an
ambient-status heartbeat. The accepted mode keeps its compatibility encoding
(`pullOnly: true` for pull-only, absence for the historical read-write
default), and changes ONLY after the daemon-owned witness matches. Before any
daemon admission work, an explicit request is durably parked as
`pendingModeIntent: "pull-only" | "read-write"`, distinct from the accepted
mode. The exact parked desired generation fences all later live/spawn callbacks,
so a newer explicit request or stop cannot be overwritten by stale work.
`startDaemon` exposes an awaited post-pidfile spawn hook so the desired writer
can publish running state before witness polling begins; production waits
exactly 15s and retains injectable timeout/poll seams through the desired-state
wrapper. Hook failure is fatal: `startDaemon` best-effort terminates the child
whose pidfile it just published and propagates the persistence error, rather
than returning an ordinary retry with an unrecorded live daemon.

A bare `rbox start` resolves its resume mode as
`pendingModeIntent ?? acceptedMode ?? "read-write"`. It never authors or
replaces `pendingModeIntent`: only an explicit `--pull-only` or `--read-write`
request may do that. A bare spawn therefore publishes `state: "running"` while
carrying the exact accepted and pending fields it read; it cannot manufacture a
read-write pending merely because read-write is the compatibility default.
Matching a live, boot-bound witness may opportunistically promote pending into
accepted mode and clear `pendingModeIntent`; differing refuses and reports the
restart-required actual/requested modes without rewriting accepted mode;
still-unknown leaves the running+pending record intact and asks for another
retry. Promotion is an optimization, never a prerequisite for intent survival.

Boot resume and managed restart likewise choose pending ahead of accepted mode,
so a reboot or upgrade cannot turn an unresolved pull-only request into a
writer. Each resume carries the exact enumerated desired generation into the
shared reconciler; if a user stop changes that generation before the resume
claims it, the stale resumer skips (or terminates a child spawned in the
eligibility race) rather than publishing running again. Promotion rechecks
under the desired-record mutation lock that the same pending intent remains and
that the current pidfile plus ambient witness name the exact admitted boot. All
desired mutations use the same per-workspace cross-process lock plus
same-directory fsync+rename publication, so the parked intent is neither a
truncate-write corruption risk nor a lost update. Stop holds that mutation lock
across witness observation, daemon stop, and stopped-record publication;
ordering therefore makes stop win on liveness while preserving the latest user
mode intent, and a spawn hook that loses the race to stop rejects the stale
boot.

Repeated flags complete the matrix: the same explicit mode as the parked
intent reconciles as pending (UNKNOWN retains pending and asks to retry; MATCH
promotes). A conflicting explicit mode replaces `pendingModeIntent` under the
desired lock before daemon work: the operator changed their mind, so a
hookless deferral, UNKNOWN, or MISMATCH retains the replacement intent while
reporting/retrying, and only a live MATCH may accept it. A non-spawning
deferral (for example, a prior rebound daemon still exiting) does not
manufacture `running`; a bare call authors no pending value, while an explicit
call leaves its already-parked user intent durable. `already-running` with a witnessed
match also promotes. For every confirmed current-workspace live daemon,
including DIFFERENT and UNKNOWN admission outcomes, the live-observation hook
first records independent `state: "running"` while preserving accepted and
pending mode fields; mismatch may then throw its restart instruction. An
unknown legacy daemon with no pending request therefore keeps accepted mode but
still records the independently observed desired state as running.
If a bare start racing a newer explicit request has already spawned the older
mode, it carries the newer pending value but may not promote the older witness
over it; restart remains required to realize the newer intent.

Desired accepted mode therefore persists ONLY after the witness matches the
request (daemon-control.ts:330 previously returned `already-running` without
any mode comparison and the caller recorded the requested mode anyway — a
lie), while desired running state persists as soon as spawn succeeds.
`already-running` with a DIFFERENT witnessed mode → refuse with "restart
required: rbox stop && rbox start --<mode>" — the restart is
OPERATOR-DRIVEN until workstream A's graceful stop ships; no automatic
restart is promised anywhere in E.

**Stop preserves accepted mode and pending user intent (r2-4, corrected by the
second slow-witness field trace):** `stopDaemonAndRecordDesired` carries both
fields into the stopped record. Before stopping, while holding the desired
mutation lock, it may promote a matching boot-bound witness; without such a
match it preserves the pending value byte-for-byte. Consequently an explicit
pull-only start whose witness is slow, followed directly by stop and a bare
start, still launches pull-only even though no start re-run ever promoted the
request. Status and start re-run use the same conditional promotion helper;
none is required for survival.

Parsing accepts `pendingModeIntent` only as the closed two-mode union on both
running and stopped records. Park, live-observation, promotion, and stop each
mint their operation timestamp when their locked mutation publishes; promotion
is conditional rather than an unconditional rewrite of an earlier snapshot.

Ship split (r1-5): the stopped-daemon resume half (bare start resumes the
persisted mode) is independent and ships early with D. The LIVE-transition
half necessarily traverses stop/start and therefore ships WITH workstream
A's graceful stop — a mode change must not ride the 60s SIGKILL hazard.
One-line status surface either way: `running (v1.7.19, pull-only)`.

### F. Observability floor (R1 finding)

The fleet sync-state reporter (zero retries, 1.5s timeout) failed at 21:07,
21:37, 22:16 — exactly when the fleet view mattered. Bounded retry with
backoff + a `report_failed` counter in client telemetry. A workspace that
was firing `sync_phase` outliers all evening should never be invisible on
the fleet panel.

## Priorities

D (the loop) and A (the locks) are the two that CAUSED tonight; B, C are
what kept the pain visible for hours after causes cleared; E is the operator
trap; F is the watchtower. Ship order (revised per r1-5): D + E's
stopped-daemon-resume half (small, surgical), then C+B (medium), then A +
E's live-transition half (large, most safety-critical — full review loop);
F rides any train. The server-side Retry-After fairness item (B.6) is an
apps/api follow-up on its own promotion cadence.

## Non-goals

- No changes to 176/177 resolution semantics (177's synchronous confirm
  already removed the daemon-stop choreography that triggered the incident).
- No auto-deletion of locks rbox cannot prove it owns (L2).
- No suppression of genuine safety refusals — the goal is that TRANSIENT
  causes self-clear, not that warnings get quieter.

## Tests

Each workstream adopts its report's test list (R2 §7 crash matrix, R3's
probe/clear/idle-host cases, R4's nine reconciler cases + the
pull-only/dormant-halt case, R5's convergence + comparison regressions),
plus one end-to-end incident replay in the rig, made constructible per
r1-8:

- Mode durability regressions pin the second field trace exactly: explicit
  pull-only -> slow/unseen witness -> stop -> bare start launches pull-only and
  leaves either pending or accepted pull-only; an explicit opposite flag
  replaces the pending intent; and stop promotes when it observes the matching
  boot-bound witness before shutdown.

- A one-shot TEST-ONLY rendezvous hook in the state-CAS bracket (env-gated,
  like capture's testHooks) that signals lock acquisition and blocks until
  killed — the rig SIGKILLs the guest daemon at that rendezvous to seed the
  exact orphan-lock shape.
- The harness defines "restart" as an explicit in-guest `rbox start` (the
  rig image's PID 1 is `sleep infinity` — Dockerfile:38 — so boot-resume is
  simulated, not assumed); "zero operator actions" starts AFTER that
  restart.
- Peer publication is FINITE (a bounded burst) unless the scenario is
  explicitly exercising B.6 fairness, which gets its own case with a
  continuously publishing peer and asserts the bounded-service guarantee.
- Health oracle goes beyond file-tree convergence (convergence.ts:31
  excludes .rbox and .git, so it proves nothing here): no owned locks and
  no journal remnants under the common dir, no pending/deferrals/halt in
  state, Git refs/BASE agreement across guests, and a stable remote
  sequence over a settle window measured in daemon cycles, not wall-clock
  polls.
