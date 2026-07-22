# 178 — transient hiccups heal themselves

Status: DRAFT v1 — synthesis of the 2026-07-21 incident's five forensic
reports (archived with evidence in `.claude/forensics-0721/`; cite them as
R1-timeline, R2-locks, R3-halt, R4-deferrals, R5-captureloop). Codex review
loop pending.

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

### C. Deferral hygiene (R4 — contract in REPORT-4, adopt as spec)

A deferral is a current assertion about the world. A shared cause-aware
reconciler (first cause: `git-busy`) runs before every computed status and
on a daemon hygiene cadence: re-probe the recorded cause (common-dir-deduped
busy probe), clear exactly the stale lane on a negative, fail closed on
inspection errors, persist via state-nonce/repoGen CAS with exact episode
match, refresh `syncBase` so ambient status reflects it immediately. Records
for repos that left discovery (the pr8 case — structurally uncléarable
today) are in scope. The design-174 1h floor remains a held-apply
optimization bound and never doubles as deferral expiry.

### D. Pending state machine correctness (R5 — the loop's actual cause)

1. **PENDING has final precedence** in the expected-previous map: BASE, then
   advertised, then PENDING (plan.ts:226 currently lets `advertised`
   overwrite it) — carrying an exact pending section must compare
   `changed === false`.
2. Pending supersession is admitted only when a publisher-ACK binding exists
   and terminally advances BASE; otherwise carry exact P and defer.
3. End-to-end convergence regression: supersession ACK → pending absent →
   BASE = candidate → self-pull unchanged → next push no-op. Plus the
   savvy-core repro shape: why did an ACKed supersession reappear as pending
   on the next self-pull (BASE/ACK convergence — R5 flags the log lacks
   section identity keys to prove which; the fix must add that logging).
4. Capture cache idempotence (real, reproduced, but secondary): stash
   against the staged index copy; fingerprint excludes `refs/rbox-*`,
   reflog side-effects, and parent-dir mtimes; refresh the divergence cache
   after capture cleanup.

### E. Mode durability (tonight's operator trap)

`--pull-only` (and any daemon mode) persists in the workspace's desired
state; a bare `rbox start` resumes the persisted mode; changing mode
requires an explicit flag. `rbox upgrade` already preserves it — bare
stop/start must too. One-line status surface: `background sync running
(v1.7.19, pull-only)`.

### F. Observability floor (R1 finding)

The fleet sync-state reporter (zero retries, 1.5s timeout) failed at 21:07,
21:37, 22:16 — exactly when the fleet view mattered. Bounded retry with
backoff + a `report_failed` counter in client telemetry. A workspace that
was firing `sync_phase` outliers all evening should never be invisible on
the fleet panel.

## Priorities

D (the loop) and A (the locks) are the two that CAUSED tonight; B, C are
what kept the pain visible for hours after causes cleared; E is the operator
trap; F is the watchtower. Ship order: D+E (small, surgical), then C+B
(medium), then A (large, most safety-critical — full review loop), F rides
any train.

## Non-goals

- No changes to 176/177 resolution semantics (177's synchronous confirm
  already removed the daemon-stop choreography that triggered the incident).
- No auto-deletion of locks rbox cannot prove it owns (L2).
- No suppression of genuine safety refusals — the goal is that TRANSIENT
  causes self-clear, not that warnings get quieter.

## Tests

Each workstream adopts its report's test list (R2 §7 crash matrix, R3's
probe/clear/idle-host cases, R4's nine reconciler cases, R5's convergence +
comparison regressions), plus one end-to-end incident replay in the rig:
seed the 21:34 shape (SIGKILL mid-bracket via test hook, orphan locks,
peer publishing) and assert the fleet returns to quiescent-healthy with ZERO
operator actions within a bounded number of cycles.
