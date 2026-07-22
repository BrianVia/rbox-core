## Audit result

The “halt” is a latched status record, not a stopped pump. Recovery continued, but the warning could clear only after a successful push. The successful pulls at 23:39–23:43 therefore did not clear it.

### 1. Exact pump behavior after halt

A failed operation is dequeued before execution: `want[op] = false` at [daemon.ts:1159](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1159). On error, the daemon:

1. Records/updates `activity.halt`.
2. Sleeps for a jittered ~750–1250 ms.
3. Continues the pump loop.

Evidence: [daemon.ts:1245](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1245), [daemon.ts:1306](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1306), [daemon.ts:1317](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1317).

But because the failed operation’s `want` was consumed, the sleep is not an autonomous retry. The loop exits unless another event has queued work. Retries come from:

- Watcher/Git events requesting pushes: [daemon.ts:595](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:595), [daemon.ts:715](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:715).
- Every successful pull unconditionally requesting a follow-up push: [daemon.ts:1200](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1200).
- Safety/deep scans, which subsequently request pushes: [daemon.ts:1167](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1167).
- Git-busy timers: [daemon.ts:872](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:872).

So the answer is: it does not stop, but it also does not own a guaranteed retry schedule. It retries opportunistically when ambient activity requeues push.

The priority order is `deepScan → fullScan → pull → push`, so sustained broadcasts/scans can delay a queued push: [daemon.ts:1124](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1124).

### 2. What clears the halt

A halt clears only when an operation of the same kind completes successfully:

```ts
const heals =
  !terminalBlocked &&
  activity.halt !== undefined &&
  activity.halt.op === op;
```

[daemon.ts:1219](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1219), [daemon.ts:1226](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1226), [daemon.ts:1232](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1232).

Therefore:

- Successful standalone pull does not clear a push halt.
- Successful 409-recovery pulls inside `pushManifest` do not clear it if the encompassing push eventually exhausts its retries.
- A successful no-op push is sufficient; it need not publish a commit.
- A successful safety scan is not sufficient.

This behavior is intentional and test-locked at [daemon-activity.test.ts:238](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon-activity.test.ts:238).

That exactly explains the artifact: the last successful pull was 23:43, while the last successful push remained 21:36 and the 23:20 push halt survived: [mac-activity.json:28](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:28), [mac-activity.json:33](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:33), [mac-activity.json:39](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:39).

Could an idle host show halted forever? Strictly, yes, because clearing depends on a future successful push rather than expiry or recovery evidence. Under a normally running read-write daemon it should eventually get a safety-scan/no-op push, generally within the 60-second-to-5-minute safety cadence. But long higher-priority work, continuous pulls, stopped/pull-only operation, or repeated scan failures can leave the record indefinitely. The current contract does not guarantee a bounded clear time.

### 3. The “13 conflicts” and fairness

`halt.count = 13` is not 13 HTTP 409s. It is 13 consecutive outer pump failures with the same error message: [daemon.ts:1261](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1261).

The timeline confirms:

- First outer failure at 21:41:50: [mac-daemon-0721.log:2470](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2470).
- Tenth at 23:03:12: [mac-daemon-0721.log:2781](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2781).
- Thirteenth persisted at 23:20:38: [mac-activity.json:40](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:40).

Each outer push has a bounded internal retry loop. `MAX_ATTEMPTS = 5`, but the initial attempt plus five retries means an all-409 exhaustion performs six commit attempts: [policy.ts:10](/home/via/Development/Personal/rbox-core/src/cli/sync/policy.ts:10), [push.ts:256](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:256), [push.ts:286](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:286). Absent other budget-consuming outcomes, 13 outer failures represent 78 commit 409s.

Backoff does exist:

- Before each 409 recovery pull, exponential jitter: `100ms × 2^attempt`, capped at 2 seconds, multiplied by `0.5–1.5`: [policy.ts:75](/home/via/Development/Personal/rbox-core/src/cli/sync/policy.ts:75), [push.ts:295](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:295).
- After an exhausted outer push, only the ~1-second daemon sleep.
- There is no cross-device lease, fairness token, or episode-level contention backoff.

The internal algorithm already does pull-before-push on every 409: backoff, pull, rescan, retry at [push.ts:295](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:295). The daemon also prioritizes pending pulls ahead of pushes. Therefore merely adding “pull before push” would not have broken this streak.

The incident’s expensive reconciliation made the small jitter ineffective. Pulls took roughly 20 seconds while locks were present, then about 75 seconds once Git applies resumed: [mac-daemon-0721.log:2903](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2903), [mac-daemon-0721.log:2912](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2912). A 50 ms–2.4 second jitter is insignificant beside that race window.

The daemons are also coupled by broadcasts: every remote commit queues a pull, and every completed pull queues a push, even if that push will ultimately be a no-op: [daemon.ts:2569](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:2569), [daemon.ts:1200](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1200). With deferred Git state preserving real local divergence, this becomes echo/publish contention rather than harmless no-op checks.

### 4. Proposed auto-recovery contract

The contract should be:

> A halt reports a currently reproducing condition. It must never remain merely because an earlier attempt failed.

Concrete behavior:

1. **Own a recovery timer.** Every halt schedules an operation-specific probe independently of watcher, WS, and safety activity. Use full-jitter exponential backoff, e.g. `uniform(0, min(2m, 5s × 2^n))`.

2. **For push-conflict exhaustion, recover as a transaction:**
   - Pull current head.
   - Reconcile/rescan.
   - If there is no publishable local divergence, clear immediately—an idle host has nothing left that can reproduce the push failure.
   - Otherwise attempt one push probe.
   - Success or no-op clears; another exhausted race refreshes `lastFailureAt`, increments the episode, and rearms the timer.

3. **Separate signal age from retry count.** Persist `firstFailureAt`, `lastFailureAt`, `consecutiveFailures`, `nextProbeAt`, and `lastProbeAt`. Do not overwrite `at` as though the condition were newly discovered on every repeat.

4. **Do not clear unrelated safety failures opportunistically.** A successful push should not clear a pull mass-delete guard. Instead, each guard gets its own periodic predicate recheck. When the guarded condition no longer reproduces, its record clears automatically; the operator may need to fix the cause, but never to clear the flag.

5. **Add real multi-writer fairness.**
   - Escalate contention backoff across outer exhausted pushes, not just within one six-attempt loop.
   - Reset it only after a successful/no-op push.
   - Prefer a server-provided writer lease or randomized `Retry-After` on 409. That gives actual fairness. Client-only jitter improves probability but cannot guarantee progress against a continuously publishing peer.
   - Suppress the unconditional immediate post-pull push when reconciliation proves no local publishable delta.

6. **Status semantics.** Show `retrying after conflict; next probe in …` while the timer is armed. Reserve “halted” for a currently reproduced safety refusal, not a historical failure while healthy applies are succeeding.

This would have made the July 21 record decay after Git recovery: the successful 23:39–23:43 pulls would trigger a bounded push-health probe—or clear immediately if reconciliation found no publishable delta—instead of leaving the 23:20 status latched.