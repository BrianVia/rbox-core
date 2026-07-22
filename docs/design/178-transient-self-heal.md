# 178 — transient hiccups heal themselves

Status: DRAFT v2 — synthesis of the 2026-07-21 incident's five forensic
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
6. **Fairness + bounded probe service (r1-4, restoring R3 §4.5; fixes R1
   decision 8):** an armed recovery probe gets BOUNDED service — after K
   consecutive scheduler passes where a due probe loses to pulls, the probe
   wins the next slot (the strict deepScan>fullScan>pull>push order at
   daemon.ts:1124 otherwise starves it indefinitely, tonight's exact
   pattern). Episode-level contention backoff escalates across exhausted
   push episodes and resets only on success/no-op; the unconditional
   post-pull push request is suppressed when reconciliation proves no
   publishable local delta; server-side randomized Retry-After on 409 is
   the durable fairness follow-up (own workstream, apps/api).
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
| `stale-unattributed` | retain lane, upgrade reason to the durable diagnosis (lock count/sample/oldest age + repair command), and KEEP re-probing on the hygiene cadence so external resolution clears it — a latched diagnosis is the same disease as a latched git-busy |
| `indeterminate` | retain byte-for-byte, escalate if chronic |

### D. Pending state machine correctness (R5 — the loop's actual cause)

1. **PENDING has final precedence** in the expected-previous map: BASE, then
   advertised, then PENDING (plan.ts:226 currently lets `advertised`
   overwrite it) — carrying an exact pending section must compare
   `changed === false`. The overlay reads the DURABLE pre-plan checkpoint
   `state.gitPendingRemote`, never the planner's mutable pending map
   (r1-3: `syncGit:false` legitimately deletes planner entries at
   plan.ts:285, and a baseless removal must not masquerade as unchanged);
   regression pins the distinction.
2. **Sanitized vs wire pending (r1-2):** apply strips invalid incoming
   config before persisting P (apply.ts:516), so persisted P is not always
   the byte-exact wire predecessor. Ruling: comparison uses the SANITIZED
   form on both sides — the sanitizer is deterministic, so re-deriving the
   comparator's expected-previous through the same sanitation makes exact
   carries compare unchanged, and corrective sanitation of the remote's
   invalid field deliberately waits for the next genuine local change
   (publishing solely to strip an invalid field is echo-class noise, the
   disease this workstream cures). Pin the sanitizer-determinism assumption
   with a test.
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
`--pull-only`, and a new explicit `--read-write` inverse. Desired state
persists ONLY after the live daemon's actual mode matches the request
(daemon-control.ts:330 currently returns `already-running` without a mode
comparison and the caller records the requested mode anyway — a lie).
`already-running` with a DIFFERENT mode → refuse with "restart required:
rbox stop && rbox start --<mode>", never silently record.

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
