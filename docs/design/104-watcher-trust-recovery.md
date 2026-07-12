# Design 104 — Watcher trust recovery on transient FSEvents drops

**Status: designed 2026-07-11. Diagnosis (below, §Problem) came from a live
read-only investigation 2026-07-12 and is treated as ground truth. This revision
adds the P1 (trust classification + recovery) and P2 (degraded-cadence hedge)
design, co-designed with design 85's R1 F8 invariant. P3/P4 are out of scope
(host config; a later session owns them). Everything here ships behind ONE env
flag `RBOX_WATCHER_RETRUST`, DEFAULT OFF; flag-off behavior is byte-identical to
today, including the sticky-false pin in `daemon-safety.test.ts`.**

## Problem (measured)

On macOS, `@parcel/watcher`'s FSEvents backend periodically emits the transient
kernel error *"Events were dropped by the FSEvents client. File system must be
re-scanned."* under churn bursts (heavy git/agent activity). The daemon treats
ANY watcher `onError` as **permanent** loss of trust for the process lifetime
(`src/cli/daemon.ts:352–365`; sticky-false is deliberate and test-pinned,
`src/cli/daemon-safety.test.ts:130`). Untrusted watcher ⇒ `nextSafetyDelay`
(`daemon.ts:1657–1660`) pins full safety scans to the 60s floor with no idle
backoff.

Measured on the Mac fleet host (2026-07-11, ~116k files / ~23k dirs):

- 21 sessions over 48h hit ≥1 FSEvents drop; within one session `errorGen`
  reached 21. Every session flips unhealthy at its first drop and never
  recovers until restart.
- Degraded steady state: ~57–64 full stat-sweeps/hr × ~6.5s ≈ **~11% continuous
  I/O duty cycle**; ~670 unnecessary scans ≈ **~70 min of wasted stat I/O in
  one day**, all against a quiescent workspace (`quiescent=y rawEvents=0`
  throughout).
- Ubuntu (inotify) on the same corpus: 0 errors ever, 39/39 healthy audits —
  inotify does not surface this transient class.
- Correctness is NOT at risk (the safety scans are the healer). This is a
  performance/battery regression — and it means **design 85's scan-elimination
  is largely unrealizable on macOS** until fixed: 85 treats watcher un-trust as
  rare/restart-recoverable; on the Mac it is the steady state.

## Fix plan (ranked; P1+P2 together, P4 independent hygiene)

1. **P1 — classify transient vs fatal + re-trust behind an unpruned scan.**
   Transient overflow ("were dropped"/"must be re-scanned"): run the recovery
   rescan (already happens via `pinSafetyFloor`) but KEEP the stream trusted —
   re-arm `watcherHealthy` only after an unpruned safety scan completes with
   `errorGen` advanced (design 85 R1 F8 permits re-trust only behind an
   unpruned scan — do not just clear the flag), with exponential backoff and a
   fuse (M drops in a rolling window ⇒ permanent un-trust, today's behavior).
   Genuine stream death stays permanently un-trusted.
2. **P2 — cheaper degraded mode (independent hedge).** When repeatedly
   `quiescent=y rawEvents=0` while untrusted, back the cadence off toward ~5×
   floor instead of a hard 60s; optionally apply design 85 Layer A dircache
   pruning in degraded mode. Pure `nextSafetyDelay` refinement.
3. **P3 — reduce FSEvents pressure.** Broaden `nativePruneGlobs`
   (`src/cli/watcher.ts:260`); investigate FSEvents coalescing latency.
4. **P4 — raise the Mac daemon FD limit.** `ulimit -n = 256` today (kern
   limits are fine). Not the root cause (FSEvents is one FD) but a latent
   hazard for the 99-repo + encrypt-cache daemon and any future kqueue
   fallback. LaunchAgent `SoftResourceLimits` → ~10240.

## Design

Everything below is gated on `RBOX_WATCHER_RETRUST=1`. Flag off ⇒ the existing
code path runs unchanged (see §Flag-off identity).

### Trust state machine

One field replaces the sticky boolean's *semantics* (the boolean stays as the
derived signal every consumer already reads):

```
type TrustState = "trusted" | "suspect" | "fused";
```

- **trusted** — steady state. `watcherHealthy = true`. Idle safety backoff runs
  (design 49). This is boot state.
- **suspect** — a *transient* overflow drop occurred; the stream stays
  subscribed; the safety floor is pinned (existing `pinSafetyFloor`); the safety
  scan is the healer for the dropped-events window. `watcherHealthy = false`
  while suspect (so every existing untrust consumer — cadence, drift continuity,
  ambient status — behaves exactly as it does for today's permanent un-trust).
  Exits to **trusted** when an *unpruned* safety/deep scan completes cleanly
  under the post-drop generation AND the exponential recovery hold has elapsed;
  exits to **fused** when the drop fuse trips.
- **fused** — permanent un-trust for the process lifetime (today's behavior).
  Entered by a *fatal* error (any non-transient / unknown `onError`) OR by the
  transient fuse (≥ M drops in rolling window W). `watcherHealthy = false`
  forever; no re-trust is ever attempted again.

Derived invariant (**flag-on only**, see §Flag-off identity): `watcherHealthy ===
(trustState === "trusted")`. Every site that reads `this.watcherHealthy` keeps
working with no change.

**All transitions go through one synchronous helper** `setTrustState(next,
reason)` (codex R1 m4): it assigns `trustState`, derives `watcherHealthy =
(next === "trusted")` in the same synchronous step, monotonically downgrades open
audits (§Drift-audit visibility), logs the transition, and returns; the caller
calls `writeAmbientStatus()` exactly once after it returns. Because the daemon
event loop is single-threaded and the helper does no `await`, no async consumer
can observe `watcherHealthy` and `trustState` disagreeing — the derived invariant
holds at every yield point. Flag-off, `setTrustState` is never called; `onError`
sets `watcherHealthy = false` directly (today's body, verbatim).

```
                    fatal onError (unknown / non-overflow)
        ┌──────────────────────────────────────────────────────────┐
        │                                                           ▼
   ┌─────────┐  transient drop (d<M)   ┌──────────┐  drop count d≥M in W   ┌───────┐
   │ trusted │ ──────────────────────▶ │ suspect  │ ─────────────────────▶ │ fused │
   │ hlthy=T │                         │ hlthy=F  │                        │hlthy=F│
   └─────────┘ ◀────────────────────── └──────────┘                        └───────┘
        ▲    unpruned clean scan (errorGen     │  (permanent — no exit)
        │    stable) AND hold elapsed          │
        └──────────────────────────────────────┘
             another transient drop while suspect: stay suspect,
             recompute hold from new window count, re-pin floor
```

### Classification (transient vs fatal)

At `onError(err)` (flag on):

- **Transient overflow** iff `err.message`, lower-cased, contains `"were
  dropped"` OR `"must be re-scanned"` (conservative substring match against the
  exact FSEvents kernel text; nothing else qualifies). Feeds the transient path:
  record the drop in the rolling window, `errorGen++`, `pinSafetyFloor()`, enter
  (or stay) **suspect** unless the fuse trips → **fused**.
- **Fatal (everything else, including unknown messages)** → straight to
  **fused** (permanent un-trust). This is *today's* behavior for every error and
  is the safe default: an error we cannot positively identify as the recoverable
  overflow class is treated as genuine stream death.

Classification is a pure function `classifyWatcherError(message): "transient" |
"fatal"` (unit-tested with a table).

### Re-trust conditions (design 85 R1 F8 — MANDATORY subsection)

**Coverage evidence comes from the scan operation itself, not the caller** (codex
R1 M3). `doFullScan`/`doDeepScan` return a `ScanCoverage = { coverage:
"full-tree" | "pruned"; errorGenAtStart: number }`, where `errorGenAtStart` is
`this.watcherErrorGeneration` captured **synchronously immediately before the
tree traversal begins** — after the awaited `reloadWorkspaceConfigIfChanged()`
(`daemon.ts:1224,1235`) so that a drop during config reload advances the
generation and blocks re-trust, and before `scanManifest` so any drop during the
walk changes `this.watcherErrorGeneration` away from the captured value. The
`coverage` value **originates at the walker / scan-mode decision** (today always
full-tree), never hard-coded by the completion-hook caller. Today both scans walk
the whole tree ⇒ `coverage: "full-tree"`. **When design 85 Layer A lands, a
pruned safety scan MUST return `coverage: "pruned"`** — the descriptor is emitted
by the code that does the walking, so Layer A physically cannot leave a stale
`true` behind at a call site (85 R1 F8, `85-incremental-scan.md:318–335`). A
pruned scan may HEAL but can never TESTIFY. The completion hook
(`maybeClearWatcherDegradedAfterScan`, called after `doFullScan`/`doDeepScan` at
`daemon.ts:524,528`) takes this `ScanCoverage`.

The daemon also stores `lastTrustedErrorGeneration` (init 0; set to the current
`errorGen` on every re-trust and on boot-as-trusted). Re-trust (`suspect →
trusted`) fires ONLY when **all** hold:

1. **Flag on** and `trustState === "suspect"`.
2. **The completing scan was UNPRUNED:** `coverage === "full-tree"`.
3. **`errorGen` covered by this scan and strictly advanced past the last trusted
   generation:** `errorGenAtStart === this.watcherErrorGeneration` (no drop
   arrived between this scan's true start and completion, so it fully covers the
   dropped-events window) AND `this.watcherErrorGeneration >
   lastTrustedErrorGeneration` (this scan recovers a genuinely newer drop, never
   a stale re-affirmation). The stability half is the exact machinery that
   already gates `watcherDegraded` clearing; the strict-advance half is new and
   makes "errorGen advanced" a real check against stored trusted state rather
   than mere stability-since-pump.
4. **The exponential recovery hold has elapsed:** `now - lastDropMs >=
   recoveryHoldMs`, where `recoveryHoldMs = min(SAFETY_SYNC_MS * 2^(d-1),
   RETRUST_HOLD_MAX_MS)` and `d` is the number of transient drops currently in
   the rolling window W (§Fuse). Per-drop exponential backoff: repeated drops
   make the daemon dwell longer in `suspect` (pinned floor = today's behavior)
   before it will re-arm trust, damping trusted↔suspect flap.

On re-trust: `setTrustState("trusted")` (derives `watcherHealthy = true`),
`watcherDegraded = false`, `lastTrustedErrorGeneration = this.watcherErrorGeneration`,
resume idle backoff. **`errorGen` is NOT bumped on re-trust** (only drops bump
it) — a bump would mark live drift candidates unattributable. A nice
consequence: post-recovery drift becomes *attributable* again
(`continuityBroken` sees `errorGenAtScan === errorGeneration` and
`watcherUnhealthySince === false` for candidates born after re-trust), which
never happens today (the daemon is stuck unhealthy for life).

### Fuse (transient thrash ⇒ permanent un-trust)

Rolling window of transient-drop timestamps. On each transient drop, with `now =
Date.now()`: **evict every timestamp `ts` with `ts <= now - W`** (retain the
half-open window `(now-W, now]`; codex R1 m5 — "older than W" must be the `<=
now-W` predicate, not `< now-W`), then append `now`, let `d = window.length`.

- `d >= RETRUST_FUSE_DROPS` (M) ⇒ **fuse**: `trustState = "fused"`, permanent,
  log `watcher trust FUSED: <d> transient drops within <W>ms — reverting to
  permanent un-trust (safety-scan-only)`. No further re-trust attempts.
- else ⇒ **suspect** with `recoveryHoldMs = min(SAFETY_SYNC_MS * 2^(d-1),
  RETRUST_HOLD_MAX_MS)`.

The window is **time-rolling, never reset on re-trust** — M drops within any W
fuse even if trust was re-armed between them (that IS the "relentless thrash"
signal we want to catch).

Constants (rationale in §Constants):

| Const | Value | Meaning |
|---|---|---|
| `RETRUST_DROP_WINDOW_MS` (W) | `10 * 60_000` (10 min) | rolling fuse window |
| `RETRUST_FUSE_DROPS` (M) | `6` | drops-in-W that fuse |
| `RETRUST_HOLD_MAX_MS` | `SAFETY_SYNC_MAX_MS` (5 min) | recovery-hold cap |
| `DEGRADED_BACKOFF_MIN_QUIET_TICKS` (K) | `3` | P2 quiet ticks before `suspect` backoff |

Recovery-hold ladder (d → hold): 1→60s, 2→120s, 3→240s, 4→300s(cap),
5→300s(cap), 6→**fuse**.

### P2 — degraded-cadence hedge (independent; same flag)

Today `nextSafetyDelay` forces the 60s floor whenever the watcher is not live-
and-healthy — that is the measured ~11% duty cycle on a *quiescent* untrusted
Mac. P2 lets a **`suspect`** watcher back its safety cadence off after
demonstrated quiescence, WITHOUT re-trusting it.

**Suspect only, and only after PROVEN post-drop liveness (codex R1 M2, R2).**
Two things must both hold before P2 may stretch the cadence, because neither
`suspect` alone nor a clean full-tree scan proves the *watcher* is alive (the
scan proves filesystem coverage; classification is substring-only, so a stream
can emit the overflow text and then silently die yet stay `suspect`):

- **`fused` never backs off** — it may be genuinely dead (fatal error) or
  declared untrustworthy (thrash fuse); its silence is meaningless. It keeps the
  hard 60s floor, exactly as un-trust does today.
- **`suspect` backs off only after a real post-drop watcher callback.** We track
  `watcherLivenessSinceDrop`, set true by `noteChurn` (any settled OR raw watcher
  callback, `daemon.ts:339,345`) and reset to false on every transient drop. This
  is positive proof the stream still delivers *after* the drop. A silently-dead
  stream never earns it → never backs off (stays at the 60s floor = today's safe
  behavior). In the real transient scenario the drop is *caused by* a churn burst,
  so post-drop churn *typically* supplies the liveness signal soon after (though
  not guaranteed — if every churn callback preceded `onError`, the reset erases
  them and P2 simply stays at the 60s floor until the next callback; conservatively
  safe, never unsafe). Once liveness is observed and the workspace quiets, P2
  reclaims the idle I/O. Silence alone never justifies backoff.

- Track `consecutiveQuietSafetyTicks`: at each safety tick, if
  `churnSinceSafety` was true (any watch activity in the interval, `noteChurn`
  sets it) reset to 0; else `++`. This is the `quiescent=y rawEvents=0` condition
  the drift line reports, evaluated at the 60s safety cadence.
- **Degraded-backoff eligibility** (flag on): `trustState === "suspect" &&
  watcherLivenessSinceDrop && hasCompletedCleanUnprunedScanThisEpisode &&
  consecutiveQuietSafetyTicks >= K`. The `hasCompletedClean…` clause means at
  least one `coverage==="full-tree"` scan with `errorGenAtStart === current
  errorGen` has completed since the drop that opened/renewed this episode (manifest
  is currently coherent). When eligible, `nextSafetyDelay` may double (60s→…→cap)
  toward `min(5 * SAFETY_SYNC_MS, SAFETY_SYNC_MAX_MS)` = 300s.
- **Any raw event or churned (unquiescent) tick resets** the quiet counter to 0
  and snaps the cadence back to the floor via the existing `noteChurn →
  pinSafetyFloor` path — no new reset code.

**Episode-state lifecycle (codex R2 M3-new).** All three P2 signals —
`watcherLivenessSinceDrop`, `hasCompletedCleanUnprunedScanThisEpisode`,
`consecutiveQuietSafetyTicks` — are reset in the transient-drop path on **every**
transient drop, including `suspect → suspect` (a second drop must re-earn liveness
and a fresh full-tree scan covering the *newer* window before backing off again).
`hasCompletedCleanUnprunedScanThisEpisode` is set true only inside the completion
hook when `coverage==="full-tree" && errorGenAtStart===this.watcherErrorGeneration`;
`watcherLivenessSinceDrop` is set true only by `noteChurn`. Boot state: all false
until the first drop (moot — P2 only runs in `suspect`).

K=3 requires ~3 min of demonstrated quiescence before a proven-alive `suspect`
watcher stretches its cadence. The 30m deep scan is the unconditional floor
beneath both (`daemon.ts:333`). Confined to a `suspect` stream we have observed
delivering since the drop, P2's worst case (a change arriving in the ≤5m gap) is
bounded like the healthy idle-backoff worst case: the next delivered event snaps
the cadence to the floor via `noteChurn`, and the deep scan is the backstop.

### Drift-audit visibility

- `OpenDriftAudit` gains a `trustState` field, captured at audit OPEN alongside
  `watcherHealthy` (`daemon.ts:1241–1247`).
- On any drop (`onError`, transient or fatal), open audits are **downgraded**
  (never upgraded), inside `setTrustState`: `audit.watcherHealthy = false`
  (as today, `daemon.ts:360`) and `audit.trustState` moves toward the worse state
  (trusted→suspect→fused, monotonic). Re-trust NEVER upgrades an open audit — an
  audit spanning any untrusted moment reports the untrusted state. This preserves
  today's semantic: *audits open during an un-trusted window stay stamped false.*
- **Classification honors the origin audit's contamination, and it travels with
  the candidate (codex R1 M1, R2).** Two layers, both no-ops flag-off:
  1. **Per-candidate origin stamp (primary).** Each `DriftCandidate` gains an
     optional `originUntrusted?: boolean`, stamped `true` iff the origin audit was
     ever untrusted during the candidate's life. It is set at **two monotonic OR
     points** so no drop in the candidate's lifetime is missed (codex R2/R3):
     - **at birth** in `diffForDrift` (`daemon.ts:1261–1264`, after the scan) as
       `audit.trustState !== "trusted"` (a drop *during* the scan; equivalently
       `!audit.watcherHealthy`, which `onError` downgrades for every open audit,
       `daemon.ts:360`);
     - **at survivor construction** in the settle transaction
       (`daemon.ts:1373–1403`), re-ORed: `candidate.originUntrusted ||
       (audit.trustState !== "trusted")`, capturing a drop landing *between* birth
       and settle (the origin audit's `trustState`/`watcherHealthy` is
       monotonically downgraded, so at settle it reflects any drop across the whole
       birth→settle window).

     `continuityBroken` (`drift-audit.ts:60–66`) returns true if
     `candidate.originUntrusted`. The bit is **persisted with the candidate
     through `mergePending`/survivors**, so even a *later or overlapping* audit
     that holds the survivor via `horizonInputs` and classifies it under its own
     (possibly re-trusted, healthy) stamp still forces `unattributable`. This
     closes the survivor-carry hole (R2) and the birth→settle hole (R3).

     **Serialization (flag-off byte-identity, codex R3).** `originUntrusted` is
     written to the drift sidecar **only when `true`** (omit-when-false); the v1
     loader/validator (`drift-audit.ts:127–136`) treats a missing value as
     `false` (backward-compatible with pre-upgrade persisted state — no version
     bump). Flag-off, `setTrustState` is never called so every audit's
     `trustState` stays `"trusted"`, `originUntrusted` computes `false`, the field
     is never emitted, and the sidecar is byte-identical to today. Flag-on, a
     genuinely contaminated candidate serializes `originUntrusted: true` — correct
     new behavior.
  2. **Settle-time OR-in (defense in depth).** The continuity context built at
     settle (`daemon.ts:588–592`) also OR-s in the *classifying* audit's health:
     `watcherUnhealthySince: !this.watcher || !this.watcherHealthy ||
     !audit.watcherHealthy`, catching an audit contaminated by a drop between its
     diff and its settle.

  Both are safe flag-off: today any error leaves global `watcherHealthy=false`
  permanently, so a post-drop candidate is already `unattributable` via the
  existing global term; before any drop, `originUntrusted=false` and the audit is
  healthy, so neither layer changes the result. They ship unconditionally.
- The deep-scan drift line (`daemon.ts:1410`) gains a `trustState=<state>` token
  next to the existing `watcherHealthy=` / `errorGen=` **only when the flag is
  on** (flag-off the line is byte-identical, §Flag-off identity). Combined with
  the explicit `watcher re-trusted …` and `watcher trust FUSED …` transition
  logs, both the re-trust event and the fuse trip are visible in the audit stream.

## Correctness requirements

1. **Design 85 R1 F8 (no pruned scan re-trusts).** Re-trust is gated on the scan
   op's own `coverage === "full-tree"` descriptor (not a caller-supplied
   boolean). Today both scans are full-tree; the descriptor is produced by the
   walking code so Layer A cannot silently weaken this. A pruned scan heals but
   never testifies. (Mandatory test.)
2. **No window where a pruned scan is trusted as recovery evidence.** Follows
   from (1): the only re-trust site consumes the scan-emitted coverage; there is
   no other path that sets `trustState` to `trusted`. Re-trust additionally
   requires `errorGen` strictly greater than `lastTrustedErrorGeneration`, so a
   stale/duplicate completion cannot re-affirm trust.
3. **Drop-spanning candidates never testify as clean (codex R1 M1, R2).** A
   candidate born in an audit that overlapped an untrusted moment carries a
   monotonic `originUntrusted` stamp that persists through survivor merges;
   `continuityBroken` forces it `unattributable` no matter which later/overlapping
   audit classifies it, even after global re-trust. (Mandatory test:
   drop-during-deep-scan → survivor held → classified by a *subsequent* audit
   after re-trust → still `unattributable`.)
4. **No event loss between drop and re-trust.** The stream stays subscribed
   through `suspect` (as today — `onError` never unsubscribes, `watcher.ts:228`);
   the pinned 60s safety scan heals the dropped-events window continuously; re-
   trust only fires *after* a clean unpruned scan has already covered that
   window. The healer is unchanged — P1 changes only trust bookkeeping and
   cadence, never the reconcile loop.
5. **Drop-during-recovery race.** A drop landing mid-scan bumps `errorGen`, so
   the in-flight scan's `errorGenAtStart` no longer matches at completion ⇒ it
   does NOT re-trust; the daemon stays `suspect`, re-pins the floor, and waits
   for the *next* clean scan. A drop after re-trust re-enters `suspect` from
   `trusted` (window preserved → fuse arithmetic intact). All transitions run in
   the synchronous `setTrustState` helper, so `watcherHealthy` and `trustState`
   are never observably inconsistent (codex R1 m4).
6. **Fuse arithmetic.** `d = |{drops in (now-W, now]}|` after evicting every `ts
   <= now-W` and appending the current drop. `d >= M` fuses; `d < M` sets hold
   `min(60s * 2^(d-1), 5min)`. Window is time-rolling and survives re-trust. M-1
   drops in W never fuses; the M-th does, deterministically.
7. **Flag-off identity (codex R1 m7).** With `RBOX_WATCHER_RETRUST` unset/`!=
   "1"`: `onError` runs the current body verbatim (permanent un-trust,
   `watcherHealthy=false` set *directly* — `setTrustState` is not called,
   `errorGen++`, `pinSafetyFloor`); `nextSafetyDelay` gets no eligibility bit and
   forces the floor for any non-live-healthy watcher exactly as today; no
   classification, no state machine, no P2. **The derived invariant and the new
   `trustState=` drift token are strictly flag-on**: flag-off, `trustState` is
   never read, has no behavioral effect, and the drift line omits the token so its
   observable output/state is identical to today. The M1 tightenings are no-ops
   flag-off: `originUntrusted` computes `false` (`trustState` stays `"trusted"`)
   and is omit-when-false, so the drift sidecar bytes are unchanged; the
   continuity OR-in is redundant with the always-false global health after any
   error (per §Drift-audit visibility). The sticky-false test
   (`daemon-safety.test.ts:130`) passes verbatim, and a new flag-off golden test
   asserts the drift line carries no `trustState` token.

## Gates (falsifiable)

Simulated via the injectable `startWatcherFn.onError` seam (no real FSEvents),
driving `nextSafetyDelay`/state transitions deterministically:

1. **Cadence recovers.** After a single transient drop, with the flag on, a
   clean unpruned scan under the post-drop generation re-trusts within the d=1
   hold (60s), and idle backoff resumes; the safety cadence is back off the floor
   within **N = 5 min** of the last drop. Zero missed-drift: any real drift
   introduced during `suspect` is still surfaced by the pinned safety/deep scan
   and its audit candidate is stamped untrusted (not falsely "clean").
2. **Fuse trips at M.** Injecting M transient drops within W transitions to
   `fused` and no subsequent clean scan ever re-trusts; injecting M-1 within W
   does not fuse (stays `suspect`, still re-trustable).
3. **Pruned scan does not testify.** A scan completion returning `coverage:
   "pruned"` never re-trusts, even with `errorGen` stable and hold elapsed.
4. **Audit stamping + classification.** An audit opened while `suspect`/`fused`
   reports `watcherHealthy=n` and `trustState=suspect|fused` on its drift line
   even if re-trust happens before it closes; and a candidate born in a
   drop-spanning deep scan classifies `unattributable` even after re-trust (M1).
5. **P2 backoff + liveness + reset.** In `suspect`, with post-drop liveness
   observed AND a clean full-tree scan completed this episode, K consecutive quiet
   ticks let the cadence double toward 300s; a single raw/churned tick snaps it
   back to 60s. A `suspect` stream that has delivered NO callback since the drop
   never backs off (dead-stream guard); a `fused` watcher never backs off; a new
   transient drop resets liveness + the episode scan flag + the quiet counter.

Acceptance: `bun test ./src/` + `bun x tsc --noEmit -p tsconfig.json` green
(tolerated host-only failures: same-SHA metadata heal, `shellStateOf`, ctime
flake).

## Constants (rationale)

**These are conservative rollout DEFAULTS, not evidence-derived optima (codex R1
m6).** The measured evidence (21 drops over 48h in one session) establishes an
*average* density but no rolling-window histogram — all 21 could in principle have
clustered in one burst — so the exact fuse point cannot be derived from it. The
defaults are chosen to be safe (a fuse only reverts to today's behavior, never
worse) and are **env-overridable** (`RBOX_WATCHER_RETRUST_M`,
`RBOX_WATCHER_RETRUST_W_MS`, `RBOX_WATCHER_RETRUST_K`) so the soak can tune them
without a rebuild. The soak also runs the fuse in **shadow first**: on every drop,
log the current rolling-window count and the would-fuse decision (`retrust drop:
window=<d>/<M> wouldFuse=<y/n>`) so the real density distribution is captured
before permanent fusion is trusted.

- **W = 10 min, M = 6.** ≥6 overflow drops inside any 10-min window means the
  watcher is dropping faster than roughly one per safety-scan-plus-recovery-hold
  cycle — recovery is not keeping up and the stream is effectively unusable;
  permanently reverting to the safety-scan-only steady state (today's behavior)
  is correct and avoids endless flap cost. At the measured *average* density
  (~1 drop / 2.3h) a 10-min window rarely accumulates 6, so most bursts recover
  behind a clean scan and the daemon reclaims the idle backoff (~70 min/day of
  wasted stat I/O on the Mac corpus). W ≈ 10 safety cycles at the floor: long
  enough to see a genuine thrash cluster, short enough that ordinary spaced-out
  drops rarely co-occur. Soak validates whether real bursts stay under M.
- **Recovery-hold cap = `SAFETY_SYNC_MAX_MS` (5 min).** Matches the existing
  idle-backoff cap; the hold ladder reaches it at d=4 (see table), so a
  worsening-but-sub-fuse burst dwells at the 5-min ceiling in `suspect` — which
  is exactly today's untrusted floor cadence, i.e. no regression during a burst,
  full recovery after it.
- **K = 3.** ~3 min of demonstrated quiescence before a `suspect` watcher
  stretches its cadence. Short enough to reclaim most idle I/O within minutes,
  long enough to avoid stretching during active-but-bursty periods. (`fused`
  never stretches — codex R1 M2.)

## Rollout

1. **Flag off (default) — merge.** Byte-identical to today; the sticky-false
   test guards it. Ships dark.
2. **Mac-only flag-on soak.** Restart the Mac fleet daemon with
   `RBOX_WATCHER_RETRUST=1`. Watch the deep-scan drift lines: `trustState`
   transitions, `watcher re-trusted …` / `watcher trust FUSED …` logs, and that
   `confirmed`/`unattributable` drift counts do NOT rise vs the flag-off baseline
   (the correctness proof: recovery must not introduce missed drift). Confirm the
   stat-sweep rate drops from ~57–64/hr toward the idle-backoff floor during
   quiescent windows. (Daemon restart + watch is a *main-session* action — this
   design does not touch daemon/host config.)
3. **Default-on decision.** After a clean multi-day Mac soak (re-trust working,
   fuse rarely if ever tripping, zero missed-drift regression), flip the default
   on in a follow-up.

## Out of scope

- **P3 — FSEvents pressure reduction** (`nativePruneGlobs` breadth, coalescing
  latency). Independent hygiene; not required for recovery.
- **P4 — Mac daemon FD limit** (LaunchAgent `SoftResourceLimits` → ~10240). Host
  config; a later session owns it. Not the root cause.

Both are host/config-owned and explicitly deferred to the main session.

## Key references

Un-trust handler `src/cli/daemon.ts:352–365`; scan-completion re-trust hook
`maybeClearWatcherDegradedAfterScan` `:966–970` (called `:524,:528`); backoff
`:405–416`, `nextSafetyDelay` `:1657–1660`; audit open/stamp `:1241–1247,:360`;
drift line `:1410`; drift continuity `src/cli/drift-audit.ts:60–66`; sticky-false
test `daemon-safety.test.ts:113–144`; FSEvents subscribe/onError forward
`src/cli/watcher.ts:204–261`; design-85 R1 F8 invariant
`docs/design/85-incremental-scan.md:318–335, 710–719`.
