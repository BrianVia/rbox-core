# 237 — Watcher fuse: count episodes, and re-arm under supervision

Status: r4 — AT THE ROUND CAP (task #22; dual RCA 2026-08-13). r1 = 3-wave
structural, r2 = 2-wave contract edges, r3 serial confirm = every fold
coherent + replay fixture verified 11/11 fuses prevented + ONE remaining
CRITICAL (step-0→arm disk gap), whose reviewer-specified fix is folded as
publication condition 9. Per the 3-round cap this goes to the founder for
the implement/extra-confirm call rather than a round 4.

## 0. Yardstick (what "helped" means)

Helped = the Mac stops fusing at every boot: zero fuses across the next
several restarts under normal boot load, at least one field re-trust (today:
**0 re-trusts in 11 fuses over 3 days**), no more fused-era 100s scan-pulls,
RSS plateau off ~12GB. Worse-risks to guard: a wrong re-trust silently
misses file changes (cardinal sin — strictly worse than slow); added daemon
lifecycle complexity; re-arm churn if the backoff is too eager.

## 1. Field evidence (Mac, 3 days of logs)

- 11 fuses = 11 daemon boots. Every fuse used the transient 6-drop path;
  the coverage-changed path (daemon.ts:2980-2990) never fired. (All
  `daemon.ts` refs = src/cli/daemon/daemon.ts.)
- Every drop is FSEvents' "Events were dropped by the FSEvents client…"
  arriving in sub-second clusters during the daemon's own boot git-sync
  burst (103 repos). The complete raw drop/boot/fuse timeline is committed
  as `docs/design/data/237-mac-drop-timeline-20260811-13.txt` and MUST be
  turned into a deterministic replay fixture (§6) — the episode arithmetic
  is validated against it, not against prose claims. (r1 finding, all three
  reviewers: the earlier "10 of 11 prevented" figure was not recomputable
  from the doc; it is now a fixture-verified number, whatever it comes out
  to be.)
- The recovery arm is arithmetically unreachable today: `recoveryHoldMs`
  counts from the LAST drop (min 60s) while clusters land seconds apart.
- Once fused: trusted pull 54.8s → fused pulls ~101s with scan 57.1s,
  every ~100s, forever. RSS then climbs to ~12GB; fuses fire at 4-6GB, so
  memory is downstream.
- Design 104 deferred hot re-arm (docs/design/104-watcher-trust-recovery.md);
  review 206 (docs/design/reviews/REVIEW-206.md:40) recorded the exact
  overlap hole that deferral avoided — §4.2's witness is the answer to it.

## 2. Root cause, stated once

Two arithmetic defects in the trust policy, not watcher sickness:

a) `daemon.ts:909-923` counts **error callbacks**, not overflow episodes.
   One physical FSEvents overflow delivers several callbacks in a burst.
b) Fused is terminal (`daemon.ts:899-905`; the only trusted transition is
   gated `!== "suspect"`, daemon.ts:~2321). Restart is the only exit — and
   restart re-triggers the boot burst. A self-sustaining loop.

## 3. Substrate-primitive check

The daemon already owns the primitives: the unpruned full scan, the
clean-scan re-trust lane (design 104), and watcher subscription startup.
What r1 established (accepted): the suspect lane's evidence is NOT
sufficient testimony for fused re-arm — it lacks attempt identity,
subscription generation, matcher generation, and scan completeness. The fix
is still counting arithmetic plus wiring, but the wiring needs one new
narrow record (the attempt witness) and one explicit lifecycle owner. No
new correctness plane beyond that.

## 4. Mechanism

### 4.1 Episode coalescing (fixes defect a)

A transient drop belongs to the current episode iff its monotonic timestamp
lies in the half-open interval `[first, first + RETRUST_EPISODE_COALESCE_MS)`
where `first` is the episode's FIRST drop (constant 5_000; a drop at
exactly first+5000 starts a NEW episode). All episode/window arithmetic
uses the daemon's clamped monotonic clock (daemon.ts:2645), and an episode
enters the rolling `RETRUST_DROP_WINDOW_MS` budget at its FIRST drop's
timestamp with the window's existing strict `ts > now - W` eviction rule
(daemon.ts:911) unchanged (r2 minor, accepted: predicates now explicit).
(r1 ruling, all reviewers: anchoring to the last drop makes an episode
infinitely extendable — drops every 4.9s would never fuse; anchored to the
first drop, a continuous storm still produces one episode per 5s and fuses
in ~30s, so no secondary raw-drop ceiling is needed.) The `RETRUST_FUSE_DROPS`-in-`RETRUST_DROP_WINDOW_MS`
budget counts episodes; the env knobs keep their names, and the unit change
(callbacks → episodes) is documented at the constant and in CHANGELOG
(r1 minor: `_M`'s unit changes — that is the point, and it is stated, not
silent). `recoveryHoldMs` keeps its formula, measured from the episode's
last drop.

### 4.2 Supervised re-arm (fixes defect b) — parcel-only, witness-bound

`fused` stops being terminal on the parcel backend. Chokidar
(`RBOX_WATCHER=chokidar`, legacy fallback) keeps today's terminal fuse:
its `watch()` returns before watch admission completes (watcher.ts:429,474
— no `ready` await), so an "armed" boundary cannot be honestly minted
without new barrier machinery for a backend the fleet does not run
(r1 CRITICAL, accepted-modified: exclude rather than build).

**One lifecycle owner.** A single watcher-session replace operation —
extracted so boot (`startLiveWatch`) and re-arm share it — owns: the
subscription, the git signal debouncer (disposed on close, watcher.ts:417),
the Linux git-ref registry (`attachRefBackend` overwrites without closing,
git-discovery-continuity.ts:130 — the replace op must close the old one),
generation-fenced callbacks (a late callback from a closed subscription
must be a no-op — fence on session generation at callback entry), safety/
deep timers NOT re-armed on re-arm (they are boot-owned; startLiveWatch
currently arms them at daemon.ts:847 — the shared op takes subscription
lifecycle only), and startup-failure cleanup. The r1 "no new module"
sentence is withdrawn; the owner may be a small module if that is the
clearest shape (r1 MAJOR, accepted).

**The arm protocol** (r2 CRITICALs 1-2, accepted — order is load-bearing):

0. **Rebuild matcher authority from disk synchronously** → generation G and
   the exact native-admission fingerprint F (the nativePruneGlobs input,
   ignore.ts:227) computed once. This closes the dropped-ignore-event hole
   (a `.rboxignore` change whose event was itself dropped leaves the
   in-memory matcher stale relative to disk; matcher-generation equality
   alone would testify falsely — r2-1 finding 3).
1. Allocate `attemptId` and a provisional session generation BEFORE calling
   subscribe; all callbacks are fenced on that generation from birth.
2. Capture `errorGenBeforeSubscribe`; call subscribe with F. The watcher
   adapter returns an **arm receipt at native-subscribe resolution**
   (watcher.ts:345), BEFORE the git-discovery await (watcher.ts:403) —
   capturing the baseline after `startWatcher()` returns would ABSORB an
   error that fired during that window into the baseline instead of
   detecting it (both r2 reviewers, accepted).
3. The arm is valid iff errorGen at the arm receipt ===
   `errorGenBeforeSubscribe`. Witness =
   `{attemptId, sessionGen, errorGenAtArm, matcherGen: G, admission: F}`.

**The testifying scan.** The attempt schedules an unpruned full scan. The
scan captures the witness AT SCAN START and returns it in its receipt;
`doFullScan` stops discarding the observer receipt's matcher generation,
completeness, and commit disposition (daemon.ts:2743/:250 today return
coverage+errorGen only — extended, not replaced). Trust is published iff
ALL hold at publication:

1. receipt.attemptId === the live attempt's id;
2. receipt.sessionGen === current session generation;
3. current errorGen === witness.errorGenAtArm (zero errors since arm);
4. current matcherGeneration === witness.matcherGen === the generation the
   subscription was created under — any rebuild while an attempt is live
   invalidates it eagerly (hook where `rebuildMatcher` calls the staleness
   guard, daemon.ts:2947; the guard's fused early-return at :2978 gets the
   supervisor hook);
5. receipt.coverage === "full-tree" AND receipt.completeness ===
   "complete" with no deferred/unread paths
   (local-workspace-observer.ts:169,300);
6. **receipt commit disposition === advanced/installed** — the observer can
   return a complete receipt whose LOCAL commit was refused as stale
   (local-workspace-observer.ts:253,328; pinned by
   local-observation-transition.contract.test.ts:373); an uncommitted scan
   observed the gap but installed nothing and is not testimony
   (r2-1 CRITICAL 1, accepted);
7. the kill switch is still enabled — re-checked when scheduling, when the
   backoff timer fires, and immediately before publication;
8. the daemon is not stopping (`!stopped`);
9. **post-arm recertification** (r3 CRITICAL, accepted): immediately after
   the arm receipt, re-read matcher authority from disk and recompute the
   admission fingerprint F′; the attempt is valid only if F′ === F (a rule
   change in the step-0→arm gap advances no generation — it must be caught
   by re-reading disk while the candidate subscription is live). After
   recertification the set is complete by construction: any later rule
   change either arrives as an event through the armed subscription
   (condition 4) or is dropped with a watcher error (condition 3). The
   witness binds the recertified generation. Test: deterministic
   `.rboxignore` mutation between step 0 and arm → attempt rejected.

**Dispositions** (r2 MAJORs, accepted): a receipt whose attemptId does NOT
match the live attempt is INERT — logged, no state change, no backoff
consumed (stale completions from the boolean scan scheduler,
daemon-operation-scheduler.ts:143,336, must not fail a newer attempt). A
receipt that matches and fails any condition → remain fused, next backoff
step (2min, 4min, 8min, then every 30min; constants, no env knob). A
THROWN scan revokes the live attempt and schedules the next backoff step —
it must not divert watcher recovery into the generic operation-halt path
(daemon.ts:1684). A fatal-classified error aborts the in-flight attempt
immediately — the fused early-return (daemon.ts:899-905) runs BEFORE
classification today; the supervisor hooks error callbacks ahead of that
short-circuit.

**Supervisor ownership** (r2-1 MAJOR, accepted): the supervisor owns ONE
cancellable backoff timer and the live attempt; daemon stop, watcher
replacement, and kill-switch disable each clear both synchronously
(joining the existing shutdown drain, daemon.ts:1089), and shutdown drains
any in-flight replacement before watcher/ref-registry teardown.

Invariant, now provable: **trust is only granted on a witness-bound clean
COMPLETE unpruned scan that started after the currently live subscription
armed, under the matcher generation that subscription was built with, with
zero watcher errors since arm.** The coverage-changed fuse
(daemon.ts:2980-2990) joins the same loop — step 2's fresh subscription
under current matcher inputs is exactly its repair.

### 4.3 Riders (small, evidence-backed)

- `resilient.ts` transient classifier learns Bun's **exact error code**
  `FailedToOpenSocket` (add to TRANSIENT_CODES at resilient.ts:34) —
  never a message-text match (a malformed URL must stay a loud config
  error). Tests: exact-code positive, wrapped-cause, message-only negative
  (r1 minor, accepted as narrowed).
- Drop diagnostics: each transient drop logs a monotonic timestamp and an
  event-loop-lag sample — SUPPORTING evidence for H1 (starvation) vs H2
  (volume), not a settlement (r2 minor accepted: a post-error one-shot
  cannot retrospectively prove pre-error starvation; no standing lag
  monitor is added).
- Status copy (status-view.ts:674): the renderer only sees
  `"suspect" | "fused"` (ambient-status.ts:31), so ONE truthful message
  covers every fused mode (r2-1 minor, accepted-modified — no new ambient
  field): "watcher reliability reduced — syncing continues by scan;
  restarting rbox restores reactive sync." Automatic recovery is a bonus
  the copy does not promise. Decision (pinned): fused stays in the
  headline-blocked set (status-view.ts:643) — sync IS degraded (60s scan
  cadence); softening the headline would hide a real cost.

## 5. What this deliberately does NOT do

- No FSEvents kernel-exclusion work (8-path API cap; field-gate on
  post-fix drop rates). No boot scheduling changes.
- No watchman/backend selection work (lane B PR, in flight).
- No chokidar re-arm (terminal fuse preserved there; deletion condition:
  chokidar backend retirement).
- No new env knobs. `RBOX_WATCHER_RETRUST=0` (exact string) remains the
  kill switch; precise current semantics preserved: under it, ordinary
  errors set sticky `watcherHealthy=false` with `trustState` remaining
  "trusted" (daemon.ts:876-877) and the coverage-change path still enters
  fused (daemon.ts:2990) — both stay byte-identical, and the supervisor
  never runs (r1 minor: behavior-equivalent, now stated precisely).
- No changes to trusted-pull gating, safety cadence, suspect-lane
  semantics, or design-104 window/hold formulas beyond the episode unit.

## 6. Validation

- **Field-replay fixture** built from
  docs/design/data/237-mac-drop-timeline-20260811-13.txt (RE-EXTRACTED
  untruncated after r2 caught the first copy at 10 boots/9 fuses; the full
  file carries all 11 FUSED records). Replay grammar, explicit (r2-2
  MAJOR): a `watcher error (transient…)` line and its same-timestamp
  `retrust drop` line are ONE callback; a `watcher trust FUSED` line IS the
  6th callback (the fuse branch does not emit `retrust drop`,
  daemon.ts:915). Run the timeline through the new episode arithmetic;
  assert the computed number of prevented fuses (r2's independent replay of
  the truncated file already showed 9/9 prevented — the fixture makes that
  claim mechanical over all 11).
- Episode arithmetic units: first-drop anchoring (drops at 0/4.9/9.8s =
  episodes {0,4.9},{9.8} …), 6 spaced episodes still fuse, continuous
  sub-5s storm fuses in ~30s, hold reachable after one burst.
- Re-arm state machine: every §4.2 publication condition violated
  individually → stays fused (attempt-id mismatch, generation change,
  error since arm incl. during-subscribe window, matcher rebuild mid-arm,
  incomplete scan, kill switch flipped mid-attempt); happy path → trusted;
  fatal during re-arm aborts; backoff sequence; late callback from closed
  session is a no-op (generation fence).
- Lifecycle: re-arm does not duplicate safety/deep timers; old git-ref
  registry closed on replace; debouncer replaced not leaked.
- Coverage-changed fuse recovers via the same loop.
- Classifier rider: exact-code positive + message-only negative + wrapped
  cause; existing `NetworkError`-never-reretried rule intact
  (resilient.ts:79).
- Existing design-104 suite green except pins on "fused is terminal" —
  intentionally replaced citing this design; watcher-retrust.test.ts:51
  default-on pin stays.
- Re-arm edge tests added per r2: stale receipt (old attemptId) is inert
  and consumes no backoff; thrown scan revokes attempt + next backoff (no
  operation-halt diversion); error during the subscribe window invalidates
  the arm (baseline captured BEFORE subscribe); matcher rebuild during
  subscribe/git-discovery invalidates; dropped-ignore-event case (disk
  rules newer than in-memory matcher) forces the §4.2 step-0 rebuild to
  pick them up; uncommitted-but-complete scan (contract-test shape,
  local-observation-transition.contract.test.ts:373) does NOT publish;
  exact 5s and 10min boundary drops; daemon stop mid-attempt cancels timer
  and attempt.
- Field acceptance, split metrics (r2 minor accepted): (a) boot-fuse rate:
  0 fuses across the next 5 Mac daemon boots; (b) if any fuse occurs, a
  logged successful re-trust within 30min; (c) Mac RSS stays under 8GB
  across 24h of normal use. All three reported at close-out.

## 7. Ownership

Trust-state arithmetic stays at the daemon trust site; constants in
policy.ts; the watcher-session replace operation is the single owner of
subscription lifecycle (shared by boot and re-arm — possibly a small new
module, one owner either way); the attempt witness is in-memory only (a
restart resets it — correct: restart re-arms by definition).
