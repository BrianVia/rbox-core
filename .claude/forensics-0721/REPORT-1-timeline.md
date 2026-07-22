I read all 2,923 daemon-log lines, the entire activity snapshot, and the incident note. All timestamps below are UTC as written in the artifacts.

The central correction: the causal event happened at **21:34 UTC, which is 17:34 EDT**. `INCIDENT.md` used the founder’s local wall clock while asserting “all UTC.” More importantly, the evidence points to the 60-second **SIGKILL escalation**, not SIGTERM itself, interrupting the apply.

## 1. Minute-resolution state timeline

| UTC | savvy-core family | Push pump |
|---|---|---|
| 17:30 | Healthy: pull reports all 101 repositories unchanged. [log:1825](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1825) | No-op push succeeds. [log:1826](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1826) |
| 17:31 | Daemon cleanly stops. [log:1827–1828](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1827) | Off. |
| 17:34–17:36 | New boot/start; main is deferred for **local edits**, not Git locks. Pulls remain `unchanged=101`; daemon becomes ready. [log:1829–1837](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1829) | Running normally. |
| 17:37–17:42 | Another clean stop, boot, local-edits defer, then ready. [log:1840–1851](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1840) | Running normally. |
| 17:45–17:48 | Conductor `savvy-core-v1` is captured; main has `keep-mine snapshot changed`. Receiver follows conductor at 17:47. [log:1854](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1854), [log:1864](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1864) | Publishes sequences 110, 111, 112. [log:1855](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1855), [log:1860](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1860), [log:1868](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1868) |
| 17:57–19:17 | Same manual-review/keep-mine state, with conductor changes captured. A clean stop/restart at 18:08 does not introduce locks. [log:1882](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1882), [log:1903–1914](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1903) | Successfully publishes 113–121. [log:1883](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1883), [log:1930](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1930), [log:2023](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2023) |
| 19:38–19:47 | Stop at 19:38, reboot at 19:43; main still local-edit deferred. At 19:45–46 workspace mutex contention backs off through 250ms→30s. Stops again at 19:47. [log:2052–2077](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2052) | Temporarily requeued by workspace-lock contention. |
| 20:00–20:37 | Boot. At 20:02 main first follows successfully; local commits are then captured as superseding pending remote state. This follow→capture cycle repeats throughout the interval. [log:2078–2091](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2078) | Publishes sequences 125–139. [log:2090](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2090), through [log:2233](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2233) |
| 20:38–20:51 | Main briefly changes to `other git issue`; two more lifecycle restarts occur. At 20:49 main follows but local commits remain deferred 10m. [log:2238](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2238), [log:2248–2278](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2248) | Sequence 142 publishes despite final candidate not superseding pending. [log:2284–2285](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2284) |
| 20:51–21:34 | Main is repeatedly and successfully followed, roughly every 1–2 minutes. Last fully reported pre-incident apply is at 21:32. [log:2288](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2288), [log:2409–2411](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2409) | Healthy. |
| **21:34** | At `21:34:13`, old process emits `git-sync followed`. At `21:34:15`, a new daemon boots with **no preceding `rbox daemon stopped`**. First `receiver git busy` appears at `21:34:42`. [log:2415–2423](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2415) | Restarted while prior apply had not completed its aggregate state/lock phase. |
| **21:35** | All nine linked worktrees become `lock present`; main is `git busy (pending supersession probe)`: total family deferred = 10. A separate `Personal/blog` tombstone-collision warning begins. [log:2430–2440](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2430) | Still able to plan using carried state. |
| 21:36 | Family remains deferred. | Last successful push, sequence 204. [log:2443–2445](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2443); corroborated by [activity:28–31](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:28). |
| 21:41 | Main and worktrees remain busy. | First surfaced exhausted-conflict episode: `too many conflicts`. [log:2470](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2470) |
| 21:42–23:03 | Pull applies and capture plans repeatedly re-probe, but all see the same locks. Family remains deferred=10. | Conflict recovery continues. At 23:03 the coalesced log reaches `(x10)`. [log:2781](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2781) |
| 23:19 | FSEvents reports dropped events. `savvy-core-pr8` disappears from the capture list, reducing family deferrals from 10 to 9 without a success line. [log:2842–2845](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2842) | Still failing. |
| 23:20 | Main remains receiver-busy; family summary remains deferred=9. [log:2846–2847](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2846) | Activity persists the latest failed push episode at `23:20:38`, count 13. There is no matching log line because only failures 1, 10, 20… are logged. [activity:39–44](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:39) |
| 23:20–23:29 | A safety scan takes **519.642 seconds** and file count falls 112,383→108,054. [log:2852](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2852) | No push; an eight-minute processing/visibility gap covers the persisted 23:20 failure. |
| 23:29 | WS half-open detector reaches count 7; reconnect succeeds. Deep scan still says `watcherHealthy=n errorGen=2`. [log:2848–2854](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2848) | Halt record remains. |
| 23:30–23:38 | Main remains receiver-busy on every pull, including at 23:37 and 23:38. [log:2857](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2857), [log:2906](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2906) | No successful push. |
| 23:39 | First proof locks are gone: main follows successfully and apply lane clears; local commits now become the remaining main-repo condition. [log:2910–2912](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2910) | A pull succeeds, but that cannot clear a push halt. |
| 23:41, 23:43 | Two more successful main follows; 23:43 also applies one ordinary file write. [log:2915–2921](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2915) | Still no post-cleanup push. |
| End, 23:44 | WS caught up to broadcast 415; local base is 412; 108,283 tracked, 4,331 pending deletes, unsettled; scan active. [activity:3–26](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:3) | Last push remains 21:36 sequence 204; last pull is 23:43; push failure count remains 13. [activity:28–44](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:28) |

## 2. Every missed self-heal decision

1. **Graceful SIGTERM was converted into a destructive SIGKILL after 60 seconds.**

   The signal handler awaits `daemon.stop()`, and `stop()` explicitly drains the active pump before logging `rbox daemon stopped`. [daemon.ts:803–848](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:803), [daemon.ts:2808–2822](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:2808)

   But `rbox stop` sends SIGKILL if the process has not exited in 60 seconds. [daemon-control.ts:432–448](/home/via/Development/Personal/rbox-core/src/cli/daemon-control.ts:432)

   Immediately preceding applies were taking roughly 55–68 seconds. Therefore a SIGTERM around 21:33:13 could still be draining when the 60-second SIGKILL landed at 21:34:13. The missing `daemon stopped` line proves graceful drain did not finish. This is the first wrong decision.

2. **The leaked mass ref locks were not durably journaled.**

   After individual follow code has already logged `git-sync followed`, the aggregate state-save phase creates one `ref.lock` per branch/artifact using `open(..., "wx")`. [apply.ts:1737–1747](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1737)

   Those locks are removed only by the JavaScript `finally`. [apply.ts:1771–1778](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1771)

   SIGKILL bypasses `finally`. Unlike checkout-transaction locks, this aggregate lock set has no durable ownership journal, which exactly explains “followed” followed by roughly 140 orphan ref locks.

3. **Narrow checkout-journal recovery existed, but could not claim these locks.**

   Checkout transactions persist intent before prepare, then persist inode tokens after prepare. [checkout-txn.ts:580–602](/home/via/Development/Personal/rbox-core/src/engine/git/checkout-txn.ts:580) Recovery deletes only locks proven by token or exact expected bytes. [journal.ts:265–299](/home/via/Development/Personal/rbox-core/src/engine/git/journal.ts:265)

   Apply runs this recovery before its busy test. [apply.ts:545–599](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:545) No recovery/quarantine line appears, so the observed aggregate witness locks fell outside that mechanism.

4. **Generic Git-busy handling treats mere existence as permanent authority to defer.**

   `gitBusy()` returns true for `index.lock`, `HEAD.lock`, `config.lock`, `packed-refs.lock`, `gc.pid`, or any `refs/**/*.lock`. It checks no age, owner PID, content, inode provenance, or dead daemon. [shared.ts:565–573](/home/via/Development/Personal/rbox-core/src/engine/git/shared.ts:565), [shared.ts:591–601](/home/via/Development/Personal/rbox-core/src/engine/git/shared.ts:591)

   Pull then records pending remote state and immediately returns deferred. [apply.ts:601–610](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:601) Capture likewise base-carries and returns. [plan.ts:540–560](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:540) Pending supersession also refuses on the same probe. [pending-supersession.ts:49–59](/home/via/Development/Personal/rbox-core/src/cli/sync-git/pending-supersession.ts:49)

5. **Busy “recovery” only re-probes twice and never escalates.**

   The special retry episode schedules only 2-second and 8-second retries, after which it clears itself. [daemon.ts:137](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:137), [daemon.ts:874–907](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:874) Subsequent traffic happened to keep retrying, but nothing could classify or reap an orphan owned by the previous daemon.

6. **Conflict recovery bounded each push episode without recognizing unchanged causal state.**

   Each 409 performs pull-first, rescan, and retry, but `MAX_ATTEMPTS=5`; exhaustion throws the quoted error. [push.ts:256–312](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:256), [push.ts:727–769](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:727), [policy.ts:10](/home/via/Development/Personal/rbox-core/src/cli/sync/policy.ts:10)

   Because every recovery pull carried the locked Git base, it could not change the condition. The activity count of 13 is **13 exhausted pump episodes**, not 13 individual races; each episode permits up to six failed commit attempts before throwing.

7. **The generic error path does not preserve the failed push as an explicit pending request.**

   The pump clears `want[op]` before execution. [daemon.ts:1157–1163](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1157) On generic failure it writes `activity.halt`, sleeps, and continues, but does not restore `want.push`. [daemon.ts:1301–1315](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1301) Further retries therefore depend on unrelated scans, notifications, or filesystem activity.

8. **After locks cleared, pull priority starved the healing push.**

   Operation selection is strictly `deepScan > fullScan > pull > push`. [daemon.ts:1124–1127](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1124) Every successful pull does request a push, [daemon.ts:1176–1200](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1176), but the 75-second notified pulls at 23:39, 23:41, and 23:43 repeatedly won selection. No push ran before artifact end.

9. **A recovered pull is forbidden from clearing a push failure.**

   Halt clears only after a successful operation whose kind equals `halt.op`. [daemon.ts:1219–1243](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1219) Thus three successful post-lock pulls could not clear the standing push warning. That rule is sensible for mass-delete guards, but no special decision exists for a transient conflict halt whose prerequisite reconciliation has now succeeded.

10. **Family attention lanes clear independently and no post-lock push reconciled them.**

    Successful main follow clears only its apply deferral. [apply.ts:1361–1374](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1361) Linked-worktree capture deferrals clear only when a later push plan observes them without a capture reason. [push.ts:439–455](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:439) Status enumerates all durable lanes, so main applying successfully cannot itself clear the remaining family warnings.

## 3. Contradictions with `INCIDENT.md`

- **Timezone:** `17:34 UTC` is false. The matching event is 21:34 UTC = 17:34 EDT. The actual 17:34 UTC event is a healthy boot after a clean 17:31 stop. [log:1828–1835](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:1828)

- **Signal type:** the log cannot prove SIGTERM at the causal second. The shutdown invariant and missing stop line strongly indicate SIGKILL/crash; the likely chain is SIGTERM about 60 seconds earlier followed by `rbox stop`’s SIGKILL escalation.

- **Failure duration:** Git-lock deferrals did not run 17:34–23:36 UTC. They began at 21:34:42. Successful applies and publications continue for nearly four hours after 17:34.

- **“13 races”:** count 13 is 13 exhausted push operations, each containing multiple 409 attempts, not 13 individual conflicts.

- **“Pump halts at 23:20”:** the first error was 21:41. `23:20:38` is the latest persisted failure/count-13 timestamp. Generic failures are nonterminal and the status implementation calls them “sync failing … will be retried.” [status-view.ts:477–484](/home/via/Development/Personal/rbox-core/src/cli/status-view.ts:477)

- **“Locks deleted at 23:37; applies immediately succeed”:** busy remains logged at 23:37:06, 23:37:37, and 23:38:18. First success is 23:39:59.

- **Ten repos until cleanup:** the family silently drops from ten to nine at 23:19 when `savvy-core-pr8` disappears, before the main recovery.

- **The log does not directly record lock creation or manual deletion.** Creation is inferred from the unclean apply boundary plus subsequent probes; deletion is bounded between the last busy result at 23:38:18 and first follow at 23:39:59.

## 4. Additional missed failure modes

- **The incident predates the locks.** From about 14:20 onward main already cycles through index/base/incoming divergence, receiver-only commits, ORIG_HEAD/REBASE_HEAD, held refs, local edits, and unstable keep-mine snapshots. Locks were not the sole source of pre-existing Git attention.

- **Lifecycle churn:** numerous clean stops/restarts occur at 17:02, 17:19, 17:31, 17:37, 18:08, 19:38/43/47, and 20:40/44/45, followed by the unclean 21:34 replacement.

- **FSEvents and scan failure:** dropped events at 23:19 are followed by a 519.642-second safety scan, unhealthy watcher, and an apparent 4,329-file reduction. Persisted state reports 4,331 pending deletes and `settled:false`. This was never pushed, but is a major uninvestigated local-tree event.

- **Push starvation can be indefinite:** continuous notified pulls outrank push. The exact post-cleanup behavior demonstrates the mechanism.

- **WebSocket degradation:** half-open detection reaches seven; notify latencies reach hundreds of seconds. This amplifies pull backlog and push starvation.

- **Fleet observability failed during the incident:** `sync-state report failed` occurs at 21:07, 21:37, and 22:16. The reporter uses zero retries and a 1.5-second timeout. [sync-state.ts:88–101](/home/via/Development/Personal/rbox-core/src/cli/telemetry/sync-state.ts:88)

- **Independent tombstone-lineage warnings:** `Personal/blog: dropped 1 colliding tombstone entry` repeats during the lock episode. The code deliberately discards generation collisions. [publisher-tombstones.ts:195–202](/home/via/Development/Personal/rbox-core/src/cli/sync-git/publisher-tombstones.ts:195)

- **Activity snapshot is internally incoherent:** top-level `at=23:44:02.301` precedes child timestamps `23:44:04.097`; active scan has `done=105500,total=0`; local base 412 trails broadcast 415. [activity:2–26](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-activity.json:2)

The strongest reconstructed chain is:

`rbox stop` SIGTERM → apply takes longer than stop’s 60s allowance → SIGKILL during unjournaled aggregate witness-lock phase → orphan `refs/**/*.lock` files → existence-only busy probes defer forever → stale Git base causes repeated bounded 409 episodes → pull-first traffic and later watcher degradation starve the post-cleanup push needed to clear both the halt and capture deferrals.