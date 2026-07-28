# 213 — Pull-only daemons run a live watcher

**Status:** DRAFT r1 (2026-07-28) — one codex adversarial round, folded but
**incomplete** (the session wedged before its final report; two high-severity
findings landed and are folded — see §10). NOT ALIGNED: a second round is owed.
Awaiting founder go/no-go.
**Issue:** #477. **Depends on:** design 202 (trusted local view for pull),
design 178 (durable daemon modes, pull-only hygiene cadence), design 41/49
(watcher backends, safety-scan cadence), design 104 (watcher re-trust).

## 1. Problem

`RboxDaemon.start()` starts a live filesystem watcher only when the daemon is
read-write (`src/cli/daemon/daemon.ts:752-756`):

```ts
    if (this.pullOnly) {
      this.scheduleSafetyScan();
      this.scheduleDeepScan();
    }
    else await this.startLiveWatch();
```

A pull-only daemon therefore boots into what its own ready line calls
*"periodic-scan mode; no live watch"* (`daemon.ts:764`) and stays there for the
life of the process. Every consequence follows from that one branch:

- **Every pull pays a full-workspace scan.** Design 202's trusted view is
  gated on `P1 = watcherTrustedForPull()`, which is
  `watcherLive() && trustState === "trusted" && !watcherDegraded`
  (`daemon.ts:1841-1843`), and `watcherLive()` is
  `this.watcher !== undefined && this.watcherHealthy` (`daemon.ts:1836-1838`).
  With no watcher object, `buildTrustedPullView` returns `{ skip: "p1-watcher" }`
  on its second clause, forever (`daemon-pull-transition.ts:45`). **202's fast
  path is structurally unreachable in pull-only mode** — not rare, not
  probabilistic: unreachable.
- Field cost: flat-meadow pays ~4.6s of scan per pull. The founder's desktop
  rejoined the fleet pull-only on 2026-07-27 (`~/Development`, 83,711 files,
  101 git repos); each ~5-minute backstop cycle burns 22–24s of scan plus
  git-apply probing and pins ~44 GB of page cache. That is a permanent tax on
  the founder's primary desk machine, around the clock.
- The desktop stays pull-only long-term (until an agent-scratch `.rboxignore`
  lands), so this is not a transient configuration.

The gate is not defending anything. §2 shows why.

## 2. Why the gate exists: historical accident, not coupling

`git log -S` puts the branch's birth in `47e28d46` ("design 87 v1: agent sync
keys", 2026-07-08). That commit introduced pull-only wholesale, and in the same
hunk it introduced both of these:

```ts
-    await this.startLiveWatch();
+    if (!this.pullOnly) await this.startLiveWatch();
...
+  private requestPush(): void {
+    if (!this.pullOnly) this.want.push = true;
+  }
```

In July 2026 the watcher had exactly **one** consumer: it enqueued pushes. A
daemon that never pushes had no use for it, so skipping it was a pure resource
saving and the two lines above are the same thought written twice. Design 87's
own prose calls `--daemon` "starts the background watcher" and never discusses
suppressing it — there is no recorded rationale, no test asserting the absence,
and no comment. `92bf8c4b` (design 178 t3) later added `scheduleDeepScan()` to
the pull-only arm, treating the branch as settled fact.

Design 202 (merged 2026-07-26) gave the watcher a **second** consumer — it is
now the evidence source for local quiescence, which is what lets a pull skip its
scan. Nobody revisited the 87-era branch. That is the whole bug.

**There is no publish coupling to unwind.** Verified, both directions:

- `requestPush()` is already an unconditional no-op in pull-only
  (`daemon.ts:1073-1078`), and `request("push")` delegates to it
  (`daemon.ts:1129`). The watcher's settle callback calls `this.request("push")`
  (`daemon.ts:791`); the git-signal batch handler calls `requestPush(...)` three
  times (`daemon.ts:893-895`). **Every one of those is already suppressed.**
- `recordRecoveryFailure` refuses to queue a push op in pull-only
  (`daemon.ts:1310`), and `armStandingRecovery` parks a push halt as
  `suspendedPushHalt` (`daemon.ts:1267-1273`).
- The scheduler is therefore incapable of running a `push` op in pull-only. No
  code the watcher touches can reach `doPush`.

Echo suppression is likewise not a reason: a pull's own writes are absorbed by
`installPullPatch` (`daemon.ts:1881-1895`), which patches the manifest
synchronously with the applied action set and marks conflict copies unsettled.
That path is mode-independent and already exercised by read-write daemons.

## 3. What pull-only actually needs from a watcher

Exactly one thing: **local-quiescence evidence**, so `buildTrustedPullView`
can hand `pull()` the in-memory manifest instead of rebuilding it from disk.
Concretely, the watcher must supply:

1. **A live, trusted watcher object** — P1 (`daemon.ts:1841`).
2. **A drained pending-event queue** — P3: `drainPendingEvents()` →
   `applyPendingWatchEvents()` (`daemon.ts:1776`), then `pendingEmpty()`
   (`daemon-pull-transition.ts:53-54`).
3. **Continuous incremental manifest maintenance** — `localObserver.observe({
   kind: "watch-batch", … })` (`daemon.ts:1797`) keeps `this.local.manifest`
   equal to disk in O(changed) so the projection handed to `pull()` is truthful.

The other predicate clauses already hold in pull-only after boot: P5
(`fullWorkspaceSinceSeed`) is satisfied by the startup full-workspace scan
(`daemon.ts:725`); P6/P7 are mode-independent.

It needs **nothing** from the publish side, and §2 shows it cannot accidentally
get it. The one structural change this design makes to the watcher wiring is
therefore not "disable publish reaction" — that is already off — it is
**giving the pending-event queue a drain owner in pull-only mode** (§4.2).

## 4. Design

### 4.1 The gate

```ts
    this.armStandingRecovery();
    if (this.pullOnly && !pullOnlyWatchEnabled()) {
      this.scheduleSafetyScan();
      this.scheduleDeepScan();
    } else await this.startLiveWatch();
```

`startLiveWatch()` already calls `scheduleSafetyScan()` + `scheduleDeepScan()`
as its first two statements (`daemon.ts:778-779`) — deliberately, so the
correctness floor exists before the watcher can fail — so the two arms stay
equivalent when the watcher does not come up. No reordering, no new ordering
invariant.

`pullOnlyWatchEnabled()` lives beside the existing flags in
`src/cli/daemon/policy.ts` and follows their shape exactly:

```ts
export const pullOnlyWatchEnabled = (): boolean => process.env.RBOX_PULL_ONLY_WATCH !== "0";
```

### 4.2 Drain owner: the one real coupling

In read-write mode `this.pendingEvents` has two drains: `doPush()` calls
`applyPendingWatchEvents()` unconditionally (`daemon.ts:1664`), and the P3
clause drains it when the trust predicate gets that far. In pull-only there is
no `doPush`, so **P3 becomes the only drain** — and P3 is reached only after
P1/P2/P5/P6/P7 all pass. A pull-only daemon whose watcher is degraded, or whose
kill switch is off, or whose matcher provenance is stale, would accumulate
`WatchEvent` objects without bound for as long as that condition lasts.

That is a real leak introduced by this change (today the array is only written
by the watcher callback, which does not exist in pull-only). Fix, in
`executeOp`'s pull branch, before the trust view is sealed:

```ts
    if (op === "pull") {
      …
      if (this.pullOnly) await this.drainWatchEventsForPullOnly();
```

where the drain is **contained**, not bare:

```ts
  /** Pull-only's sole drain owner. Watcher bookkeeping must never fail a pull:
   *  in read-write mode this call lives inside `doPush`, so a throw fails a PUSH
   *  op; routing it through the pull op would newly let an observer error record
   *  a pull recovery halt. Events stay queued for the next attempt; the safety
   *  and deep scans remain the correctness floor either way. */
  private async drainWatchEventsForPullOnly(): Promise<void> {
    try {
      await this.applyPendingWatchEvents();
    } catch (error) {
      this.log(`watch-event drain failed: ${error instanceof Error ? error.message : String(error)} — pull continues on the scan path`);
      this.markLocalUnsettledFromWatchEvent();
    }
  }
```

`applyPendingWatchEvents` can genuinely throw — it calls `loadSyncBase()` and
`localObserver.observe(...)` (`daemon.ts:1792-1797`). Swallowing it here is not
hiding a fault: the pull then fails P2/P3 and takes the scan path, which is
today's behavior, and the failure is logged. Note the asymmetry this leaves
untouched: P3's own `drainPendingEvents()` inside `buildTrustedPullView`
(`daemon-pull-transition.ts:53`) is *not* wrapped, in either mode — that is
pre-existing read-write behavior and out of scope here.

Placed on the pull op (the pump's guaranteed-recurring op in pull-only: the
backstop tick calls `this.request("pull")` on every interval
(`daemon.ts:3190`), and WS notify and the startup boundary queue it too) and
*before* `doPull`. The recovery probe's pull branch routes through the same
`executeOp` call (`daemon.ts:1465-1467`), so the drain covers it as well. With
it in place the
trusted-view path sees an already-drained queue and P3's own drain becomes a
no-op re-check rather than the sole owner. `applyPendingWatchEvents` is
idempotent on an empty queue (`daemon.ts:1777`) and is the same call read-write
mode makes from `doPush`, so no new failure surface.

`maybeClearWatcherUnsettledAfterOp` already treats `op === "pull"` as
refreshing local truth (`daemon.ts:2170`), so the unsettled flag clears on the
same schedule read-write mode uses.

### 4.3 Safety-tick cadence must not change

`advanceSafetyCadenceForTick` feeds `watcherLive: this.watcherLive()` into
`nextSafetyDelay` (`daemon.ts:963-968`), and `nextSafetyDelay` backs the delay
off geometrically to 5m **only when a watcher is live**
(`policy.ts:137-142`). Today a pull-only daemon has no watcher, so it never
backs off: its 60s safety tick runs `runDeferralHygiene()`
(`daemon.ts:946`) at a fixed 60s cadence. Design 178 t2's review wave fixed
that cadence deliberately ("H2 pull-only hygiene cadence", `45021b4d`).

Starting a watcher flips `watcherLive()` to true and would silently stretch
pull-only deferral hygiene from 60s to 5m — an unrelated regression smuggled in
by this change. Therefore:

```ts
    this.safetyDelay = nextSafetyDelay(this.safetyDelay, {
      watcherLive: this.watcherLive(),
      churned: this.churnSinceSafety,
      degradedBackoffEligible,
      pinToFloor: this.pullOnly || this.gitDiscovery.floorRequired,
    });
```

`pinToFloor` is the first clause of `nextSafetyDelay` and returns the 60s floor
outright, so pull-only cadence is byte-identical to today's.

### 4.4 The degraded-watcher healer

`maybeClearWatcherDegradedAfterScan` — the only path back to `trusted` after a
drop — runs from `executeOp`'s scan branch (`daemon.ts:1438`). In pull-only,
`request("fullScan")` is dropped on the floor (`daemon.ts:1131`:
`if (this.pullOnly && kind !== "pull" && kind !== "deepScan") return;`), so the
only scan a pull-only daemon can run is the 30-minute deep scan.

Without a change, a watcher drop on a pull-only daemon means up to 30 minutes of
`local=scan` pulls before re-trust. That is exactly today's behavior, so it is
*safe* — but it is a 30-minute hole in the benefit, and the safety scan is
supposed to be the healer (design 49).

So: in pull-only, the safety tick runs a full scan **only while a watcher
object exists and is not trusted**, and hygiene otherwise:

```ts
  private async runSafetyCadenceTick(): Promise<void> {
    …
      if (!this.pullOnly || this.pullOnlyNeedsHealingScan()) this.request("fullScan");
      else await this.runDeferralHygiene();
    …
  }

  /** Pull-only has no push op, so the safety scan is the ONLY route back to
   *  `trusted` after a watcher drop. `suspect` is the ONLY state the healer can
   *  promote (`maybeClearWatcherDegradedAfterScan`: `if (this.trustState !==
   *  "suspect") return;`, daemon.ts:2189) — so this is exactly the window where
   *  a scan buys something. */
  private pullOnlyNeedsHealingScan(): boolean {
    return this.watcher !== undefined && retrustEnabled() && this.trustState === "suspect";
  }
```

**The predicate must be `suspect`, not "not trusted".** The obvious form —
`this.watcher !== undefined && !this.watcherTrustedForPull()` — is a severe
foot-gun: `trustState === "fused"` is *permanent* (`daemon.ts:828-834`,
`844-846`), and with `RBOX_WATCHER_RETRUST=0` a single backend error sets
`watcherHealthy = false` with no recovery path at all (`daemon.ts:806-820`).
Either state would then satisfy "not trusted" forever, and — because §4.3 pins
pull-only to the 60s floor — the daemon would run a **full workspace scan every
60 seconds for the life of the process**. On the desktop that is a 22-second
scan per minute: dramatically worse than the ~5-minute cadence this design
exists to fix. Keying on `suspect` (and on `retrustEnabled()`, since `suspect`
is unreachable with the flag off) means a fused or flag-off daemon falls back to
hygiene-only ticks — exactly today's pull-only behavior — which is the correct
terminal state for "this watcher will never be trusted again."

and `request()`'s pull-only filter admits `fullScan` under the same predicate:

```ts
      if (this.pullOnly && kind !== "pull" && kind !== "deepScan"
          && !(kind === "fullScan" && this.pullOnlyNeedsHealingScan())) return;
```

Two properties fall out, both wanted:

- Deferral hygiene is not lost during the healing window: `executeOp`'s scan
  branch calls `runDeferralHygiene()` itself (`daemon.ts:1437`), so a healing
  tick does strictly more than a hygiene tick.
- The healing scan is `unpruned`: `watcherScanMode()` returns `"pruned"` only
  when `watcherLive()` (`daemon.ts:2612-2614`), and a degraded watcher has
  `watcherHealthy === false`. Re-trust requires `cov.coverage === "full-tree"`
  (`daemon.ts:2187`), so the healer produces exactly the evidence re-trust
  demands. No new interaction.

A daemon with **no** watcher object (kill switch off, or watcher init failed —
§5) never satisfies `pullOnlyNeedsHealingScan()`, so it keeps today's
hygiene-only tick byte-for-byte. So does a fused one.

### 4.5 Skip the Linux git-ref side channel in pull-only

`startLiveWatch` attaches the ref side channel when
`gitRefSideChannelEligible(process.platform, backend)` — `linux && parcel`
(`git-ref-watch.ts:20-25`). Its outputs are `signalDebouncer.push(...)` →
`handleGitSignalBatch` → three `requestPush(...)` calls that are already no-ops
in pull-only, plus `gitDiscovery.observe({ kind: "signal", … })`.

On the founder's Linux desktop that is 101 repos' worth of `fs.watch`
registrations and a retry/arming state machine bought entirely to trigger
publishes that cannot happen. Pull-only therefore takes the existing else-arm:

```ts
      if (!this.pullOnly && gitRefSideChannelEligible(process.platform, this.watcher.backend)) {
        await this.gitDiscovery.attachRefBackend({ … });
      } else this.gitDiscovery.noteRefBackendUnavailable();
```

`noteRefBackendUnavailable()` sets `floorRequired` on Linux
(`git-discovery-continuity.ts:141-145`), which pins the safety tick to its 60s
floor — which §4.3 already pins unconditionally in pull-only. No change in
observable cadence; `absenceProof` keeps its non-registry semantics, the same
ones every pull-only daemon runs under today.

This is a cost cut, not a correctness requirement; it can be dropped from the
change without affecting anything else in §4.

### 4.6 Companion cut: skip the post-pull divergence probe in pull-only

`executeOp`'s pull branch ends with:

```ts
      if (await this.hasPublishableLocalDivergence() !== "none") this.requestPush("other");
```

`hasPublishableLocalDivergence` diffs the manifests and then calls
`gitDivergenceStatus` over every tracked repo (`daemon.ts:1383-1390`,
`sync-git/status.ts:65+`). Its **only** consumer is `requestPush`, a no-op in
pull-only. On a 101-repo workspace this is a per-pull git sweep bought for
nothing. Guard it:

```ts
      if (!this.pullOnly && await this.hasPublishableLocalDivergence() !== "none") this.requestPush("other");
```

Independently valuable, independently revertable; listed here because it is in
the same five lines and the same measurement.

## 5. Failure containment

The requirement is: **a watcher problem in pull-only degrades to today's
periodic-scan behavior and never blocks or corrupts a pull.** Each failure mode,
against the code:

| Failure | Mechanism | Result |
|---|---|---|
| Watcher init rejects (no native binding, inotify exhaustion, unsupported FS) | `startLiveWatch`'s `try/catch` (`daemon.ts:879-886`) logs `live watch unavailable: … — degrading to periodic scan`, sets `watcherDegraded`, leaves `this.watcher` undefined | `watcherLive()` false → P1 skip → `local=scan` per pull = today's behavior exactly. Safety + deep scans were already scheduled at `startLiveWatch`'s top. |
| Post-init backend error (FSEvents stream death, inotify overflow) | existing `onError` handler (`daemon.ts:805-856`): `watcherDegraded = true`, `watcherErrorGeneration++`, trust state machine, `pinSafetyFloor()` | P1 fails → next pull scans. §4.4's healer re-earns trust on a clean full-tree scan. |
| Repeated transient drops | design 104 fuse: `RETRUST_FUSE_DROPS` within `RETRUST_DROP_WINDOW_MS` → `trustState = "fused"`, permanent (`daemon.ts:844-846`) | Permanently back to today's behavior for that process, hygiene-only ticks included (§4.4's `suspect` keying). Correct, and the log line says so. |
| Watch-event drain throws (observer/state-load error) | §4.2's `drainWatchEventsForPullOnly` catch | Logged, events retained, pull proceeds on the scan path. A pull is never failed by watcher bookkeeping. |
| Watcher event arrives mid-pull | `installPullPatch` re-checks `watcherErrorGeneration` against the op-start value and returns `"watcher-drop"` (F1, `daemon.ts:1887`) | Post-pull refresh falls back to a scan. Mode-independent, unchanged. |
| Pending events accumulate | §4.2's unconditional pull-op drain | Bounded by the pull cadence, not by the trust predicate. |
| Trusted view is wrong (bug) | The scan path remains the permanent fallback for every clause; `RBOX_PULL_TRUST_WATCHER=0` disables 202 wholesale on any daemon | Two independent kill switches (202's and this design's). |

Nothing in this design adds a code path that can *fail a pull*. The watcher is
purely additive evidence; every negative answer routes to the scan that runs
today.

Resource containment on the desktop is the one genuinely new exposure: an
83,711-file / 101-repo tree under Linux inotify. `nativePruneGlobs` keeps
`.git` and `node_modules` out of the subscription (`daemon.ts:868`,
`watcher.ts` prune wiring), which is the same subscription a read-write daemon
on that machine ran before it rejoined pull-only — so the watch count is known
to be servable on that host. If it is not on some other host, inotify
exhaustion surfaces as an init rejection or an overflow error, both of which
land in the table above.

## 6. Mode flips

`this.pullOnly` is `private readonly`, assigned once in the constructor
(`daemon.ts:482`, `daemon.ts:578`) from `opts.pullOnly`, which `runDaemon`
reads from `RBOX_DAEMON_PULL_ONLY` (`daemon.ts:3314`), which `startDaemon`
stamps into the child env from `requested.mode` (`process-control.ts:388`).
**There is no in-process mode flip**, so keying the watcher decision off
`this.pullOnly` inside `start()` keys it off the effective boot mode by
construction — the requirement is met with no new machinery.

The mode a boot resolves is `resolveStartMode(previous, deps)`
(`autostart-cmd.ts:230+`, via `explicitMode` at `:225`): an explicit
`--pull-only` / `--read-write` wins; otherwise the previous desired record's
`pullOnly` flag decides, defaulting to read-write for legacy/absent records
(`desiredMode`, `autostart-cmd.ts:206-210`). So:

- `rbox stop && rbox start` with no flags re-reads the recorded mode and
  respawns with the same `RBOX_DAEMON_PULL_ONLY` value. A pull-only daemon
  comes back pull-only *and* re-runs the §4.1 decision — it gets a watcher.
- `rbox upgrade` restarts each daemon with its existing pull-only setting
  (`upgrade-cmd.ts:159`, `resumeMode`). Same outcome.
- A flip in either direction is a respawn, so the read-write arm and the
  pull-only arm each get a fresh process and a fresh decision. There is no
  state to migrate and nothing to tear down mid-flight.

The only thing to *not* do is cache the decision anywhere else — e.g. derive it
from `this.watcher !== undefined` at some later point as a proxy for mode.
`pullOnlyNeedsHealingScan()` (§4.4) reads `this.watcher` deliberately, but only
to mean "a watcher was started", never to mean "this daemon is read-write".

## 7. Rollout

**Default-ON with a kill switch: `RBOX_PULL_ONLY_WATCH=0`.**

Per the founder's standing rule, new behavior ships on unless there is a
wire-compat, breaking-change, or named-bake-condition reason to stage it. None
applies:

- **No wire change.** Nothing in this design touches a payload, a manifest
  encoding, a commit body, or an API route. `apps/api` is untouched. A
  pull-only daemon with a watcher and one without produce identical requests.
- **No breaking change / no client skew story needed.** The change is entirely
  within one process's own scheduling. A v1.10.1 daemon and a v1.11 daemon on
  the same workspace interoperate exactly as before.
- **No safety bake condition.** The mechanism being enabled (design 202's
  trusted view) has been default-on for read-write daemons since 2026-07-26 and
  is itself independently kill-switched (`RBOX_PULL_TRUST_WATCHER=0`). This
  design does not make the trusted path more trusted; it makes an existing,
  already-shipping predicate reachable in a second mode.

Staging it behind an opt-in would mean the founder's desktop — the machine
paying the cost — runs the old path by default, which is the opposite of what
the change is for.

`RBOX_PULL_ONLY_WATCH=0` restores the §4.1 gate exactly (no watcher, no
healing-scan branch, hygiene-only ticks), so the kill switch is a true
one-variable revert to today's behavior without a redeploy.

## 8. Validation plan

Test hosts: **flat-meadow** (small workspace, fast iteration) and the
**founder's desktop** (`~/Development`, 83,711 files, 101 repos — the machine
the issue is about). Both run dev builds per the standing fleet rule.

### 8.1 Evidence sources

All three are already emitted by default; nothing new is needed to observe the
change.

1. `pull local=trusted` / `pull local=scan skip=<clause>` —
   `daemon-pull-transition.ts:254`, one line per pull, in
   `<root>/.rbox/daemon.log`. **This is the primary verdict.** Today a
   pull-only daemon emits `pull local=scan skip=p1-watcher` on every pull,
   with no exceptions.
2. The phase summary line — `metricsReport?.logSummaryTo(this.log)`
   (`daemon.ts:1972`), on by default (`metricsEnabled()` is
   `RBOX_METRICS !== "0"`, `metrics.ts:20`). Carries per-phase wall times
   including `scan=`. **This is the cost measurement.**
3. `pull applied: …` (`daemon.ts:2454`) plus `activity.lastPull` — proves the
   pull actually moved bytes, i.e. that a trusted pull is a real pull and not a
   no-op that trivially skipped its scan.

### 8.2 Acceptance checks

**A — the fast path is reached (flat-meadow, then desktop).**
Bind pull-only, start the daemon, let it settle, push a one-file change from
another fleet host. In `daemon.log`:
- the boot line reads `rbox daemon ready` (not `ready (periodic-scan mode; no
  live watch)`) — proves `this.watcher` came up;
- the resulting pull logs `pull local=trusted`;
- it also logs `pull applied: …` naming the file — proves 8.1(3);
- the phase line for that pull carries **no `scan=` component**, or a
  sub-millisecond one.

Baseline for the same host with `RBOX_PULL_ONLY_WATCH=0`: `pull
local=scan skip=p1-watcher`, `scan=4600` (flat-meadow) / `scan=22000-24000`
(desktop). Report both runs side by side.

**B — steady-state cost, desktop, 24h.**
Leave it bound pull-only for a full day of normal agent activity. Extract every
`pull local=` line and every phase line:
- ≥90% of pulls are `local=trusted`;
- median pull-line `scan=` drops from ~22–24s to absent;
- every `skip=` that does appear names a clause, and the distribution is
  explainable (expect `p3-pending` under heavy agent churn, `p2-observation`
  around case collisions, `p7-*` right after an ignore-rule edit). A skip
  clause appearing that §3 says should not is a finding, not noise.
- page-cache residency: compare `free -w` buff/cache growth over the day
  against the pre-change ~44 GB figure.

**C — degradation, both hosts.**
Force a watcher drop (Linux: exhaust the inotify instance limit for the daemon
user, or send the synthetic overflow the design-104 tests use). Confirm in
order: `watcher error … safety scan pinned`, then a `fullScan` runs on the next
safety tick (§4.4 healer — visible as a phase line with a large `scan=` and a
`deferral hygiene` effect), then `watcher trust trusted (re-trusted after clean
full-tree scan …)`, then `pull local=trusted` resumes. Pulls must keep applying
throughout — no gap in `pull applied:` for changes pushed during the window.

**D — kill switch.**
`RBOX_PULL_ONLY_WATCH=0 rbox start` on a pull-only root reproduces today's log
transcript exactly: `ready (periodic-scan mode; no live watch)` and
`skip=p1-watcher` on every pull. Diff the transcript against a pre-change build
on the same workspace.

**E — mode flips (flat-meadow).**
`rbox stop && rbox start` on a pull-only root → watcher present, `local=trusted`
resumes. Then `rbox start --read-write` → normal read-write behavior including
pushes. Then back to `--pull-only`. Confirm the recorded desired mode and the
observed watcher state agree at every step (`rbox status`, `daemon.log` boot
line).

**F — no unbounded pending queue.**
With `RBOX_PULL_TRUST_WATCHER=0` (202 off ⇒ P3 never reached) on a pull-only
daemon, generate sustained churn for 30 minutes and confirm daemon RSS is flat.
This is the direct test of §4.2's drain.

### 8.3 Automated coverage

- Unit: pull-only boot starts a watcher; pull-only boot with
  `RBOX_PULL_ONLY_WATCH=0` does not. (Extends the existing
  `daemon-watch-degrade.test.ts` / `layer-a-watcher-gating.test.ts` harnesses,
  which already drive `startLiveWatch` directly.)
- Unit: pull-only + live trusted watcher yields a trusted view from
  `buildTrustedPullView` (`daemon-trusted-pull.test.ts` gains a pull-only case).
- Unit: pull-only + watcher init failure → hygiene-only tick, no `fullScan`
  request, `skip=p1-watcher` (containment).
- Unit: pull-only safety cadence stays at the 60s floor with a live watcher
  (§4.3 regression guard — this is the assertion that would have caught the
  hygiene-cadence regression).
- Unit: pull-only pull op drains `pendingEvents` even when the trust predicate
  short-circuits before P3 (§4.2).
- Unit: a throwing `applyPendingWatchEvents` in pull-only does **not** fail the
  pull op and does **not** record a recovery halt (§4.2's containment).
- Unit: a **fused** pull-only daemon requests no `fullScan` — hygiene-only
  ticks, forever (§4.4's foot-gun guard). Same with `RBOX_WATCHER_RETRUST=0`.
- Unit: a pull-only daemon never queues a `push` op no matter how many watcher
  events arrive (§2's claim, asserted rather than argued).
- Rig: FAST suite before merge, per the every-few-PRs rule.

## 9. Implementation shape

Small. All of it is in `src/cli/daemon/daemon.ts` plus one constant in
`policy.ts`:

- `policy.ts`: `pullOnlyWatchEnabled()`.
- `daemon.ts:752-756`: the gate (§4.1).
- `daemon.ts:869`: `!this.pullOnly &&` on the ref-side-channel condition (§4.5).
- `daemon.ts:941-951` + `1128-1133`: healing-scan branch and its `request()`
  admission (§4.4), plus `pullOnlyNeedsHealingScan()`.
- `daemon.ts:963-968`: `pinToFloor` (§4.3).
- `daemon.ts:1409-1434`: pull-op drain (§4.2) and the divergence-probe guard
  (§4.6).

Zero `apps/api` changes, zero wire changes, zero migration. The risk is not in
the diff size; it is in the interaction surface (cadence, trust state machine,
drain ownership), which is what §4.3/§4.4/§4.2 exist to pin down and what §8.3
asserts.

## 10. Review log

### r1 — codex (`gpt-5.6-sol`) adversarial round, 2026-07-28

The round read the design against `src/`, ran the relevant suites
(`daemon-pull-transition.contract`, `daemon-trusted-pull`, `daemon-safety`,
`layer-a-watcher-gating`, `watcher-retrust`, `daemon-watch-degrade`,
`daemon-git-capture` — 103 tests, green), and then **wedged** on an internal
tool-router error (`error=timeout_ms must be at least 10000`) before emitting
its final report. It had already published two findings, both verified
independently against the source and both folded. The session was killed after
40 minutes of no further output. **A second round should be run before this
doc is marked ALIGNED** — the round below is real but incomplete, and the
report it would have written was not produced.

**Folded — F1 (high): the unconditional drain can fail a pull.**
> *"the proposed unconditional drain can throw before `doPull` and turn watcher
> bookkeeping into a pull failure"*

Verified: `applyPendingWatchEvents` calls `loadSyncBase()` and
`localObserver.observe(...)` (`daemon.ts:1792-1797`), both of which can reject.
In read-write mode the call sits inside `doPush` (`daemon.ts:1664`), so a throw
fails a *push* op. Routing it through the pull op would newly let watcher
bookkeeping record a **pull** recovery halt on a daemon that today cannot fail
that way. §4.2 now specifies `drainWatchEventsForPullOnly()` with an explicit
catch that logs, retains the events, marks local unsettled, and lets the pull
proceed on the scan path. Added to §5's table and §8.3's test list.

**Folded — F2 (severe): the healer predicate is a foot-gun in terminal states.**
> *"the healer predicate treats terminal `fused`/fatal states as needing a full
> scan every 60 seconds forever"*

Verified and worse than stated: `fused` is permanent (`daemon.ts:828-834`), and
with `RBOX_WATCHER_RETRUST=0` one backend error clears `watcherHealthy`
irrecoverably (`daemon.ts:806-820`). Combined with §4.3's `pinToFloor`, the
draft's `!watcherTrustedForPull()` predicate would have run a **full workspace
scan every 60s for the life of the process** — on the desktop, a 22-second scan
per minute, far worse than the problem this design fixes. §4.4's predicate is
now `watcher !== undefined && retrustEnabled() && trustState === "suspect"`,
which is precisely the window `maybeClearWatcherDegradedAfterScan` can act on
(`daemon.ts:2189`). Terminal states fall back to hygiene-only ticks — today's
behavior. Two regression tests added.

**No findings were rejected in this round** — it produced exactly two before
wedging, and both were correct. The alternatives and citation-accuracy sweep it
was asked for were never delivered; that is the gap a second round must close.

### Self-corrections made while drafting (not codex findings)

For honesty about provenance: §4.2 (drain ownership), §4.3 (`pinToFloor`), §4.4
(healer branch), §4.5 (ref side channel), §4.6 (divergence probe) and §2's
`47e28d46` archaeology were found during the author's own trace of the code
before the review round, not by codex. Codex's contribution was finding that
two of those proposals were themselves wrong.
