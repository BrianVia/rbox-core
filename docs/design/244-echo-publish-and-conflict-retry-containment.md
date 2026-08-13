# 244 — Echo-publish ring + conflict-retry containment (issue #683)

## Problem (field evidence, 2026-08-13)

Two compounding daemon bugs, root-caused by two independent review lanes
(opus + gpt-5.6-sol) with all anchors re-verified:

1. **Echo-publish ring (desktop, root cause).** A permanently pending git
   section makes `gitDivergenceStatus` report `indeterminate` with `count=0`
   (`src/cli/sync-git/status.ts:198-201` — "unapplied remote truth is carried,
   never local divergence"). `daemon.ts:1546` re-arms push on
   `hasPublishableLocalDivergence() !== "none"` after every pull, so
   `indeterminate` re-arms forever: push publishes an **empty** sequence
   (field-proven: `mde delta ops=0 bytes=400` → `published sequence 2177`) →
   server notifies → daemon pulls its own sequence → re-arm. Self-sustaining at
   the pull round-trip period (~40-50s; STATUS 2026-08-12 recorded 7,003
   pushes/day at 3-4s). Design 178 §B.6 required the post-pull push request be
   suppressed when reconciliation proves no publishable delta — `indeterminate`
   is not proof, so the suppression never fires.
2. **Conflict-retry starvation (Mac, downstream).** The peer's sequence churn
   makes a slow host (368s pulls, 103 repos) lose every push 409 race. The
   internal push retry loop (`push.ts:364-423`, MAX_ATTEMPTS=5 ⇒ six attempts)
   redoes a full pull + workspace rescan + git-plan per attempt with ≤3s
   backoff — 5-10 min of continuous CPU per op. The daemon episode ladder never
   climbs because pushes *do* eventually commit, clearing the episode; the next
   409 re-enters at tier 1. "next probe in 0s" is a starvation display (probe
   due, op lane busy), not a zero delay. Result: 45+ min at 120% CPU, RSS
   9.5→22.7GB, backstop lanes starved.

Yardstick (phase 0): desktop no-op push cadence drops from ~1/45s to ~0
(safety-scan-triggered only); Mac exits the conflict loop and drains its
pending uploads; no convergence regression (a genuinely-busy repo still
converges ≤ next safety scan, 60s).
Could get worse: nothing on the convergence path. Only a PENDING-carrying repo
loses its post-pull re-arm, and a pending section cannot be published until it is
accepted; every other trigger is untouched, so a genuinely-busy repo still
converges on the watcher/git-ref fast path (400ms-3s debounce) with the adaptive
safety scan (60s floor, backing off to 5m when idle) as the backstop. Recovery
episodes now survive a committed push whose intent is unresolved (longer visible
"retrying" states, by design).

## Fixes (smallest correct seams, existing owners)

- **b1 (root cause):** `indeterminate` conflated two different facts, so the fix
  is at the verdict owner first. `status.ts` splits its indeterminacy sources and
  reports `pendingOnly` on the existing `GitDivergenceStatus`: true only when
  EVERY source was a pending repo (permanent — unapplied remote truth this host
  carries), false as soon as one busy/unprobed repo contributed (transient —
  unprovable this instant). `hasPublishableLocalDivergence` maps that to a
  `pending-carry` outcome, and `daemon.ts:1546` suppresses the post-pull re-arm
  for `pending-carry` alone. This PRESERVES review M2 ("a busy repo must still
  re-arm the push") rather than reversing it; only the permanent case, which no
  push can resolve, stops arming. The scheduler stays the sole arming authority;
  safety-scan re-arm, watcher signals and the git-busy ladder are untouched.
- **a1:** `runRecoveryProbe` post-push clear fires only when the push
  committed **and** `hasPublishableLocalDivergence()` is not `"some"` —
  otherwise return with the episode standing so `recordRecoveryFailure`
  escalates. Refines design 178 §B.6 "success" to "intent resolved", not "one
  commit landed". No new types; reuses the existing tri-state union.
- **a2:** the push op's internal 409 loop surrenders on an elapsed-time budget in
  addition to MAX_ATTEMPTS: once the op has spent `PUSH_CONFLICT_SURRENDER_MS`
  losing pull-first races, throw `PushConflictExhaustedError` and hand retry to
  the daemon probe (the module that owns backoff). The budget is checked at the
  TOP of each loop iteration, not only when the next 409 lands — a single 368s
  recovery pull outlasts it on its own and must not be followed by another full
  attempt. The constant is sync-owned (`sync/policy.ts`) and mirrors the daemon's
  `RECOVERY_PROBE_CAP_MS` = 120s by design, so a surrendered op lands in the
  probe's cadence without sync importing daemon policy. Push keeps
  internal-attempt ownership; it stops monopolising the op lane.
- **b2 (instrumentation only, this cycle):** when the plan's deep-compare
  found no section change but `changed` was armed by the unconditional flags
  (`plan.ts:390-391`), log which flag and its size. The suspected culprit is
  `authoredCfgHashByRepo` re-arming every cycle (its comment says the ACK
  bounds it as one-shot; the field says it isn't). Fix lands at the authorship
  site in a follow-up once the log names the flag — NOT by gating
  `publish-candidate.ts:309` on an empty delta (supersession/resolution
  publishes are legitimate empty-delta publications whose durable effect is the
  ACK; gating them strands pending sections — designs 178 §B / 226 flush
  contract).

## Explicitly rejected

- Minimum-delay clamp on `recoveryProbeDelayMs`: violates the documented,
  tested full-jitter `[0, ceiling)` invariant (design 178); the "0s" display
  was starvation, not jitter.
- Blanket no-op gate on `plan.changed` flags: strands pending supersession
  ACKs (above).
- Changing `RECOVERY_PROBE_SERVICE_BOUND` (8 dequeues): design-178 r2-2 chose
  dequeue-counting deliberately; a time-cap on the service bound is raised as a
  product question, not patched here.

## Protected behavior

Unchanged-files+unchanged-git publishes zero commits; pending remote sections
stay byte-exact until accepted supersession; supersession/resolution/config
authorship still publish; arm-then-push handshake intact; 409 recovery still
pulls+rescans before each retry; design-178 probe fairness and full-jitter
untouched; safety-scan and watcher push triggers untouched.

## Tests the implementation MUST add

1. Daemon: post-pull re-arm does NOT fire for a pending-only carry (the echo-ring
   regression) and STILL fires for a busy repo (review M2). Both construct real
   state through the actual `gitDivergenceStatus` path, not a stubbed verdict.
2. Daemon: recovery episode survives a committed recovery push when publishable
   divergence remains (`consecutiveFailures` continues climbing; `firstFailureAt`
   preserved); clears when divergence is gone.
3. Push: internal 409 loop surrenders via elapsed budget with an injected clock
   advanced during the recovery pull (attempts < MAX_ATTEMPTS but budget exceeded
   ⇒ `PushConflictExhaustedError`, and no further attempt starts).
4. Plan: the b2 log line fires exactly when flags arm `changed` with an empty
   deep-compare, and names the flag.
