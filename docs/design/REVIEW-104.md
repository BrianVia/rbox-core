# Review ledger — Design 104 (watcher trust recovery)

Adversarial codex (gpt-5.6-sol, read-only) review loop against
`docs/design/104-watcher-trust-recovery.md`. Cap 4 rounds to ALIGNED.

## Round 1 — VERDICT: CHANGES REQUIRED (3 MAJOR, 4 MINOR)

- **M1 (Axis 4, MAJOR)** — an audit spanning a drop can still classify drift as
  `confirmed`: candidates are stamped with post-scan `errorGen` (`daemon.ts:1263`)
  and classification (`drift-audit.ts:60-66`) uses *global* health, not the
  audit's monotonic stamp. If a drop lands mid-deep-scan and re-trust happens
  before the settle-window classification, `continuityBroken` is false and the
  contaminated candidate is falsely attributable. Re-trust introduces a hole that
  cannot exist today (health never recovers). **Fix:** OR the audit's monotonic
  `watcherHealthy` into the continuity context so any drop-spanning audit forces
  its candidates `unattributable`. Test drop-during-deep-scan → re-trust-before-settle.
- **M2 (Axis 6, MAJOR)** — P2 treats silence from a FUSED/dead stream as
  filesystem quiescence: `churnSinceSafety` is only set by watcher callbacks, so a
  dead stream auto-produces K quiet ticks and P2 stretches the only healer from
  60s to 300s — regressing the dead-watcher case. **Fix:** restrict degraded
  backoff to `suspect` (stream believed alive, still delivering), never `fused`.
- **M3 (Axis 1, MAJOR)** — `scanWasUnpruned: boolean` is a caller assertion, not
  durable coverage proof (a future Layer A change to `doFullScan` leaves a stale
  `true`); and "errorGen advanced" is only checked as stability-since-pump, not
  against a stored last-trusted generation. **Fix:** return structured evidence
  `{coverage, errorGenAtStart}` from the scan op itself; maintain
  `lastTrustedErrorGeneration`; re-trust only when `coverage==="full-tree" &&
  errorGenAtStart===current && current>lastTrusted`.
- **m4 (Axis 2, MINOR)** — specify transition atomicity: centralize in a single
  `setTrustState` helper that derives `watcherHealthy` and emits status once.
- **m5 (Axis 3, MINOR)** — fuse eviction predicate underspecified; pin `(now-W,
  now]` (evict `ts <= now-W`) with W-1/W/W+1 boundary tests.
- **m6 (constants, MINOR)** — 21 drops/48h does not prove max density <6 per
  10-min window. Reframe M/W as conservative rollout defaults; add soak
  shadow-logging of window density + would-fuse decisions; env-overridable.
- **m7 (Axis 5, MINOR)** — the unconditional derived invariant conflicts with
  flag-off (`watcherHealthy=false` but `trustState` inert ⇒ `false!==true`).
  Scope the invariant + new `trustState=` token strictly to flag-on; flag-off
  drift line byte-identical. Add a flag-off golden test.

Otherwise-clean: Axis 4 audit display, Axis 2 races, Axis 3 window retention.

Resolution: design revised for all 7 (M1 continuity OR-in; M2 suspect-only P2;
M3 structured coverage + lastTrustedErrorGeneration; m4 setTrustState; m5 exact
predicate; m6 defaults + soak shadow + env override; m7 flag-scoped invariant/token).

## Round 2 — VERDICT: CHANGES REQUIRED (3 MAJOR; m4-m7 resolved)

- **M1 STILL OPEN (deeper)** — the settle-time OR-in only protects candidates
  classified *at their origin audit's* settle. Unresolved candidates become
  `survivors`, persisted via `mergePending` with no monotonic origin-health stamp
  (`drift-audit.ts:13-28`); a later/overlapping audit can classify a survivor
  under its own healthy stamp after re-trust → falsely `confirmed`. **Fix:** stamp
  each candidate at birth with `originUntrusted = (audit.trustState !==
  "trusted")` and OR it into `continuityBroken`, so contamination travels with the
  candidate through survivor merges. Test must classify via a *subsequent* audit.
- **M2 STILL OPEN** — `suspect` (substring classification) does not prove the
  stream is still alive; a stream can emit the overflow text then silently die and
  stay `suspect`; a clean full-tree scan proves FS coverage, not watcher liveness.
  P2 could still stretch the healer to 5m for a dead-but-suspect stream. **Fix:**
  gate P2 on positive post-drop watcher liveness — at least one watcher callback
  (`noteChurn`) delivered since the last drop (`watcherLivenessSinceDrop`). A dead
  stream never earns it → never backs off; in the real transient-churn scenario
  the post-drop churn supplies it immediately, preserving P2's value.
- **M3-new lifecycle hole** — `hasCompletedCleanUnprunedScanThisEpisode` had no
  reset rule; a second drop while `suspect` could let P2 back off without a
  full-tree scan covering the newer window. **Fix:** reset all episode state
  (this flag, quiet-tick counter, `watcherLivenessSinceDrop`) on *every* transient
  drop incl. suspect→suspect; set the flag only on a `coverage==="full-tree"` &&
  `errorGenAtStart===current` completion.
- **m4 RESOLVED** (setTrustState atomicity), **m5 RESOLVED** (exact predicate),
  **m6 RESOLVED** (defaults + shadow + env), **m7 RESOLVED** (flag-scoped;
  "byte-identical" ⇒ observable-behavior-identical). **M3 (r1) RESOLVED** subject
  to capturing `errorGenAtStart` synchronously immediately before traversal
  (after the awaited config reload) and originating `coverage` at the walker.

Resolution: design revised — M1 per-candidate `originUntrusted` stamp threaded
through `diffForDrift`/`continuityBroken`; M2 `watcherLivenessSinceDrop` gate;
M3-new explicit per-drop episode-state reset; capture-point + wording tightened.

## Round 3 — VERDICT: CHANGES REQUIRED (2 MAJOR; M2 + M3-new resolved)

- **M1 residual** — `originUntrusted` stamped once at `diffForDrift` birth misses
  a drop landing *between* birth and the settle transaction: the audit is
  downgraded but the already-born candidate persists `false`. **Fix:** re-OR at
  survivor construction — `originUntrusted = candidate.originUntrusted ||
  (audit.trustState !== "trusted")` using the origin audit's monotonically-
  downgraded state — capturing the birth→settle window too.
- **flag-off identity vs persisted field** — adding a required `originUntrusted`
  to the serialized `DriftCandidate` changes flag-off sidecar bytes and the v1
  loader/validator (`drift-audit.ts:127-136`) enumerates fields. **Fix:** flag-off
  `trustState` stays `"trusted"` (setTrustState never called), so
  `originUntrusted` is computed `false`; serialize it **only when true**
  (omit-when-false), and the loader defaults a missing value to `false`. Flag-off
  the field never appears ⇒ sidecar byte-identical; no version bump (optional,
  false-default, backward-compatible with pre-upgrade persisted state).
- **M2 RESOLVED**, **M3-new RESOLVED**, R1 F8 / drop-during-recovery / fuse all
  confirmed resolved. MINOR: qualify the "post-drop churn supplies liveness
  immediately" claim (conservatively-safe, not guaranteed) — done.

Resolution: design revised — survivor-merge re-OR of `originUntrusted`;
omit-when-false serialization + false-default loader; qualified P2 perf claim.

## Round 4 — VERDICT: ALIGNED

Both round-3 MAJORs confirmed RESOLVED (two-point `originUntrusted` OR covers the
complete origin-audit lifetime; omit-when-false serialization + false-default
loader make flag-off sidecar byte-identical with no version bump). Final sweep
found no new BLOCKER/MAJOR. Design aligned in 4 rounds (Claude + gpt-5.6-sol).

Constants chosen: **W=10min, M=6, K=3**, recovery-hold cap = SAFETY_SYNC_MAX_MS
(5min); all env-overridable, soak-shadowed. Flag `RBOX_WATCHER_RETRUST` (default
off).

---

# Implementation review (codex adversarial, read-only, against the working tree)

## Impl round 1 — VERDICT: CHANGES REQUIRED (3 MAJOR)

- **M1 — `dedupePending` dropped contamination.** Oldest-wins kept the oldest
  object unchanged; a clean-oldest + contaminated-newer same-path pair lost the
  `originUntrusted` bit. Fix: OR `originUntrusted` across all same-path duplicates
  (drift-audit.ts:102-114). Added a direct `mergePending` OR test.
- **M2 — `coverage` hardcoded in the scan wrappers**, not originating at the
  walker (design req 1: Layer A must not be able to testify with a stale literal).
  Fix: `replaceManifestFromScan` now returns `coverage` (the layer that invokes
  `scanManifest`); `doFullScan`/`doDeepScan` forward it (daemon.ts).
- **M3 — the mandatory drop-spanning test was a stub** (hand-built candidate +
  `continuityBroken`), not end-to-end. Fix: added a real test driving
  drop→deep-scan→survivor→re-trust→subsequent audit that asserts
  `unattributable=1 confirmed=0`, with errorGen matched + watcher healthy so
  `originUntrusted` is the SOLE decider (would be `confirmed=1` without the fix).

Regression fixed along the way: the flag-off "clear degraded" check must key on the
PUMP-OP-START generation (today's semantics), not the inside-scan `errorGenAtStart`
— split the hook into `maybeClearWatcherDegradedAfterScan(opWatcherErrorGeneration,
cov)` (restored `daemon-activity.test.ts` "second error during covering scan").

Post-fix: `bun test ./src/` 1297 pass / 2 tolerated host-only fails; tsc clean.

## Impl round 2 — VERDICT: ALIGNED

All 3 round-1 MAJORs confirmed RESOLVED (dedupePending ORs contamination; coverage
originates at `replaceManifestFromScan`; the drop-spanning test drives the real
paths and would fail without `originUntrusted`). Fresh full sweep found no
BLOCKER/MAJOR correctness or flag-off-identity hole. Implementation aligned in 2
rounds. tsc clean; `bun test ./src/` 1297 pass / 2 tolerated host-only fails.
