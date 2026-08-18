# 277 — One state load per operation (+cross-cycle reuse) and the pull-only watcher

Status: ALIGNED r3 (codex delta-confirm 2026-08-17; 2 parallel reviews + final serial + delta) · Closes the build half of #661; closes #477.
r1 → r2: folded two independent REVISE reviews (codex gpt-5.6-sol + opus).
r2 → r3: folded final serial review (probe columns confirmed sufficient;
receipt reshaped to evidence-carrying; enqueue-time cap; audit reshaped).
Baseline: docs/design/data/277-baseline-2026-08-17.md (field capture, fleet on
2.0.0-beta.4-dev+505738e). All daemon anchors are src/cli/daemon/daemon.ts.

## 0. Problem, in numbers (field-measured; ×4 count review-verified exact)

- Desktop zero-change push: **7.2–7.7s**. The steady no-op daemon push cycle
  performs exactly **four full O(N) state materializations**
  (`loadRawStateFromStore`, adapters/read-only.ts:79; ~1.8s each at 127k
  files):
  1. `openOperationBoundary` → `loadSyncBase()` (daemon.ts:1625) —
     uninstrumented; it is the "start→state-load 1.9–2.3s" gap.
  2. `reconcileResolutionReceipt` (sync/push.ts:310 → sync/pull.ts:199) —
     the function already accepts `input?.state` (pull.ts:194-199); the push
     call site simply doesn't pass one, so it re-loads and discards when no
     receipt exists (the 100% steady case).
  3. The instrumented `state-load` span (sync/push.ts:503) — per *attempt*.
  4. `refreshDurableState` inside publish_transition
     (daemon-publish-transition.ts:206 → daemon.ts:754) — it IS the
     1.8–2.2s `publish_transition` reading. Runs for not-committed (no-op)
     outcomes too.
  All other load sites are conditional and quiet on the steady cycle
  (verified: daemon.ts:1340/:1636/:1792/:1978/:2128/:2948/:918/:3014 —
  reset-recovery, `?? syncBase` hits, catch arms, ignore-rule reloads,
  startup). The exceptions list in §A4 keeps them honest.
- The pull lane pays its own loads independently (pull.ts:83-95 direct
  `loadState`; post-apply `loadAndSurfacePostBase`,
  daemon-pull-transition.ts:243-252 → daemon.ts:770-774) — Slice A covers
  both lanes explicitly; nothing is "shared for free".
- flat-meadow is pull-only again ("periodic-scan mode; no live watch");
  every pull logs `local=scan skip=p1-watcher` and pays a 10–17s full scan
  inside 51–63s pulls. Design-202 trusted pulls are structurally unreachable
  in pull-only mode (#477): `startLiveWatch()` is gated on read-write
  (daemon.ts:950-956).

Founder target: ≤10s e2e; push op 4–5s (#661 round-6 ruling).

Out of scope, filed as #775: the FM deferred-repo bundle refetch
(12–17s/pull) and the 11–12s cas acquire residual. Stated so the
differential is judged against the right expectation (FM pulls land ~40s
after Slice B, not ≤10s — the rest is #775's two poles).

## Slice A (#661): one durable-state authority, loaded once per boundary

### A0. Ownership rule (answers both reviews' "competing authorities" finding)

The daemon's resident `syncBase` (daemon.ts:388) is already the single
in-process durable-state slot, updated by `loadSyncBase` (:1229) and by
accepted-save adoption (`observeDurableGitState`, :2215-2219). This design
adds **no second cache**. Every mechanism below is a rule about when
`loadSyncBase` may *skip the O(N) materialization*, and every accepted state
transition keeps updating the same slot. `loadSyncBase`'s two side effects —
`this.syncBase = state` and `ensureMatcherProvenance(state)` (:1231-1234,
load-bearing for design-206 P7 re-baselining) — run on every path, reuse or
reload.

### A1. Thread the boundary's state through the push operation (×4 → ×1)

The boundary load (daemon.ts:1625, mutex held from
daemon-operation-scheduler.ts:380 to :415) becomes the cycle's only
materialization on the steady path:

- **Load 2**: pass the boundary state at the one call site — push.ts:310
  becomes `reconcileResolutionReceipt(root, cfg, deps, { state })` (the
  parameter already exists; pull.ts:113 already uses it). Two other call
  sites keep loading, deliberately: push.ts:830 (inside the retry loop,
  post-commit — stale by construction) and push.ts:117 (entry without a
  boundary). **Receipt-path gate:** when `reconciled.status !== "none"`, the
  reconcile has durably mutated state (applyPulledManifest,
  finishResolutionReceipt — pull.ts:207/:216), so load 3 must do a REAL
  load. Elision of load 3 is conditional on `status === "none"`.
- **Load 3**: `runPushAttempt` accepts an optional pre-loaded
  `{state, revision}` from the daemon (CLI one-shot keeps loading).
  **Single-use, consumed BEFORE the first invocation** and cleared
  independently of the retry-budget counter — the `files-first-fallback`
  rerun (push.ts:373) re-invokes `runPushAttempt` WITHOUT incrementing
  `attempt`, and that first invocation may already have persisted capture
  state, so "attempt 1 only" is not expressible via the counter. Every
  re-invocation re-loads — the retry loop runs recovery pulls and rescans
  between attempts (push.ts:411) that invalidate any snapshot; reuse there
  would build commits against a superseded parent and surface as a 409
  storm, not a clean refusal. The span still stamps (0.0 on reuse); span
  vocabulary unchanged — the gap cardinality owner is
  src/cli/telemetry/contract.ts:19-26 and its equality test in
  telemetry/sync-phase.test.ts, untouched.
- **Load 4** (`refreshDurableState` in publish_transition) — replaced by an
  **evidence-carrying durable-state receipt**, NOT an outcome-inferred one.
  Final-review correction: a "no-op" push is not writeless — candidate
  preparation always runs `capture.observe` (can save, push.ts:562), a
  git-enabled no-op runs `carryBaseOnNoOp` (saves and discards the returned
  state, push.ts:601), and `ensureCapableStateLineage` can write before
  admission (publish-candidate.contract.test.ts:302 proves a no-op runs
  both effects). So `committed:false` is NOT evidence that nothing wrote.
  Mechanism: one operation-local receipt value
  `durable: { state: SyncState } | { disposition: "reload" }`, initialized
  to the boundary state, and **updated by every state-writing port in the
  operation** — `capture.observe`'s save, `carryBaseOnNoOp`, capable-
  lineage initialization, the acknowledgement save (push.ts:919), the pull
  save, and receipt reconciliation. Each either installs the exact accepted
  state the save returned or degrades the receipt to `reload` (any writer
  that cannot return its accepted state, any thrown/terminal/uncertain
  path, any re-invocation of `runPushAttempt`). Settle adopts
  `receipt.state` through the `loadSyncBase`-equivalent seam (syncBase +
  matcher provenance) or performs today's full reload on `reload`.
  Threading: AttemptOutcome → PushResult (`durable?`) → doPush →
  PublishTransitionServices — four modules, one exported type; costed,
  accepted. The terminal-block arm (daemon-publish-transition.ts:146-150)
  keeps its real reload. There is no existing runtime gate proving adopted
  === durable (r1 miscited a reset-lineage test); the receipt invariant
  gets its own red-first test: for each receipt path — boundary-carry,
  each in-op save site, and `reload` — settle's adopted state deep-equals
  a fresh `loadRawState` of the store.

**Pull lane (same receipt pattern):** the daemon pull passes the boundary
state into the pull's initial load (pull.ts:83-95 gains the same optional
pre-load, single-use, daemon-only), and `loadAndSurfacePostBase`
(daemon-pull-transition.ts:243-252) adopts the pull's own post-save returned
state instead of re-loading, with the same uncertain⇒reload rule.

Expected effect: desktop push 7.4s → ~3.6s; Mac 6.6s → ~4.2s; pull lanes
drop their 1.7–2.2s state-load similarly. Meets the 4–5s push-op target
without A2.

### A2. Cross-cycle reuse of `syncBase` (kills load 1's cost)

At the next `openOperationBoundary`, `loadSyncBase` runs a **freshness
probe** instead of materializing: one row read of
`{active_lineage_id, state_nonce, state_revision, telemetry_binding_id}`
from the store header. All four match the retained values ⇒ reuse
`syncBase`; any mismatch ⇒ full load. Probe rules (from the writer audit):

- **Writer audit (replaces r1's false "all writers take the mutex" claim):**
  foreground state writers take the workspace sync mutex (init/adopt/reset/
  export/state-plane/setup cmds — verified); CAS-accepted saves bump
  `state_revision`; reset-lineage replacement changes `active_lineage_id`;
  the ONE writer that bumps nothing is `ensureStoreTelemetryBindingId`
  (write-packet.ts:348-371, deliberately non-CAS, minted once per
  workspace, invoked by the daemon itself OFF-mutex via `afterSyncTick`,
  daemon.ts:1748 → telemetry/sync-state.ts:82 → whole-state-compat.ts:193)
  — which is why `telemetry_binding_id` is IN the probe. Final review
  confirmed the four columns are sufficient against the CURRENT mutation
  surface (stream/nonce/revision writes bump revision in-transaction,
  write-packet.ts:296/:302; `last_synced_sequence` and
  `active_base_generation` ride revision-bumping transactions,
  cas-steps.ts:174, schema/v1.ts:166; `local_revision` is LOCAL-plane, not
  part of `SyncState` materialization — explicit exemption). The guard for
  the FUTURE is an **allowlisted mutator audit**, not a `state_lineage`
  UPDATE grep (which would miss a direct `repo_records`/BASE/manifest-chain
  write that forgot to bump revision): a test enumerating every production
  store mutator that affects `loadRawStateFromStore` output and asserting
  each either bumps a probed token atomically, changes active
  authority/lineage, or is the explicitly probed telemetry writer.
- The probe opens the store normally (NOT `immutable=1` — skips the WAL,
  not a freshness oracle). Authority selection, genesis admission under the
  held mutex, and `recoverStandingResetJournal` run exactly as today — only
  the O(N) cursor materialization is skipped.
- Any reset-journal recovery, authority-marker change, or
  `stateWasStreamMismatch` invalidates retention unconditionally.
- **Legacy JSON authority: no probe, no reuse** — legacy loads stay
  per-boundary full loads (the probe is a SQLite header read; parity for a
  dying path is not worth a JSON token scheme).
- Kill switch: `RBOX_STATE_LOAD_CACHE=0` reverts to per-boundary
  materialization (default-on; deletion condition: two clean fleet weeks).

Expected effect: steady zero-change cycles perform zero O(N)
materializations (probe ≈ms). Desktop push → ~2s territory.

### A3. Explicitly NOT in this slice

- No matcher cache / delta ignore-carry. Tonight's `matcher=0.0` readings
  are **config-gated, not a fix**: `matcherForState` builds uncached every
  attempt (policy.ts:115), but the expensive tracked-evaluation legs
  (`discoverGitReposSync` + per-repo git, ignore.ts:582-584) only run under
  `respectGitignore`/purge — off on the measured hosts. A host with
  `respectGitignore` on re-hits the ~1.7s. Re-convict per host config
  before building; recorded so nobody builds from (or is deceived by) the
  0.0.
- No git-plan slimming (Mac d≈1.2s): measured decision after A1+A2 only if
  the Mac misses the target.
- Design 247's ruling stands: no trusted-view push. A1/A2 publish
  byte-identical manifests (same state object ⇒ identical plan inputs).

### A4. Enumerated load exceptions (unchanged behavior, on the record)

Ignore-rule/collision reloads (daemon.ts:1962-1981), keep-mine arm/disarm +
pull-first recovery (push.ts:800-838), post-apply receipt reconcile
(pull.ts:189-214), terminal/thrown reloads
(daemon-publish-transition.ts:146-149, daemon.ts:1786-1797), startup
(daemon.ts:918), reset-recovery (daemon.ts:1340). The red-first count test
pins the CLEAN fixture: zero pending events, no receipt, no config change,
no retry, no failure — asserts 4 loads today, 1 after A1, 0 materializations
after A2 (probe excluded).

## Slice B (#477): pull-only daemons start the live watcher

### B1. The change

Collapse the mode branch at daemon.ts:950-956: every non-scoped boot runs
`startLiveWatch()` (it already arms the same two timers first,
daemon.ts:987-991). The ready line self-corrects (:974-978 keys off watcher
presence). P1 becomes satisfiable; FM's 10–17s scan leg dies.

### B2. Fused re-arm witness must reach fullScan — via a pumped request

Pull-only `request()` drops every `fullScan` (daemon.ts:1218-1227), but the
fuse-recovery loop publishes re-trust ONLY from a witnessed full-tree scan
(watcher-session-supervisor.ts:313 `requestFullScan`; `settleScan` gated on
the `fullScan` op at daemon.ts:1573; `deepScan` does NOT substitute).
Without a route, a fused pull-only watcher re-arms forever.

Fix: a dedicated daemon method (the supervisor's `requestFullScan` effect
rewires to it) that is mode-independent and does BOTH
`scheduler.queue("fullScan")` AND `void this.pump()` — bare `queue()` only
sets a bit and never wakes the loop (scheduler docstring; both reviews).
Ambient `fullScan` requests keep being dropped in pull-only; the supervisor
owns the sole exception, with the constraint in a comment.

### B3. pendingEvents: unconditional pull-side drain (fixes a today-latent inversion)

r1's "drains at P3" was wrong: the drain (daemon-pull-transition.ts:40) sits
BEHIND P1/P2 (:33-35). A fused/untrusted watcher makes every pull skip at
`p1-watcher` before the drain line — events accumulate unboundedly on a
headless pull-only host for the whole fuse interval, and a non-empty queue
also holds `externalLocalWorkSettled` false (daemon.ts:649), interlocking
against the very trust recovery that would restore P1. (Read-write daemons
escape via the push-prologue drain; pull-only has no push.)

Fix, two parts (final review split them correctly):
- **Drain**: move the pull-side drain ABOVE the predicate chain — every
  pull drains `pendingEvents` first, then evaluates P1..P3 (trust
  eligibility sampled AFTER the drain; the pull keeps its original pre-op
  base). Applying watch events to the local observer is mode- and
  trust-independent bookkeeping, identical to the push-prologue drain
  read-write daemons already run. Also removes the latent read-write
  pull-lane inversion.
- **Cap at ENQUEUE, not drain**: a drain-time check bounds apply work, not
  resident memory — events accumulate between pulls. `pendingEvents`
  becomes a saturating buffer (64k) with an **overflow latch**: at
  saturation, further events are dropped and the latch sets.
  `externalLocalWorkSettled` (daemon.ts:647) treats a set latch as
  unsettled. A pull atomically consumes the latch: clears it, marks local
  observation incomplete (P2 false ⇒ scan-backed pull — today's fallback),
  and proceeds; re-trust cannot make an incomplete local view eligible
  until the covering scan completes. Owner: the daemon's event intake;
  deletion condition: none (it is the overflow contract).

Safety-tick ruling unchanged from r1: pull-only keeps hygiene-only ticks;
`liveEnoughToSkipSafetyScan()` backing the hygiene cadence off toward 5m is
accepted and named in the PR body. First pull after a large apply may skip
trusted (`p2-observation`/`p3-pending`) — self-clearing; accepted.

### B4. Scoped bindings — gate on the existing signal

Scope-forced pull-only (daemon.ts:1671-1683) destructively overwrites
`pullOnly`, so the flag carries no provenance — but `this.scoped` (:491,
set :1674, refreshed at :898 before the boot gate) is the authoritative
signal. Gate: `scoped` boots keep today's no-watcher behavior (no new
boolean); unscoped pull-only boots watch. The scope-generation stop
(:1686) already handles scope transitions by restart.

### B5. Effect and non-effect on FM

Kills the 10–17s scan leg: FM pulls 51–63s → ~40s steady. The remaining
poles are #775 (fetchDecrypt refetch, cas acquire) — explicitly not this
design. Key-release opt-out (daemon.ts:556), push suppression
(`requestPush` no-op), push-halt suspension (:1385-1404), and upgrade mode
preservation all unchanged.

## Validation

- Red-first: (A1) `spyOn(storeFacade, "loadRawStateFromStore")` (existing
  pattern, telemetry/sync-state.test.ts:267-303 — the facade indirection
  makes the spy live on the daemon path) counting loads on the pinned clean
  fixture: 4 → 1 → 0-materializations; revert-sensitive. (A1-receipt) per
  receipt path — boundary-carry, each in-op save site (`capture.observe`,
  `carryBaseOnNoOp`, capable-lineage, ack save, pull save), and `reload` —
  settle's adopted state deep-equals a fresh `loadRawState`. (A1-single-use)
  attempt-2 path AND the non-budget-consuming files-first rerun both assert
  a REAL load. (A1-receipt-gate) `status !== "none"` asserts load 3
  reloads. (A2) foreground write between cycles ⇒ probe mismatch ⇒ full
  reload; `ensureStoreTelemetryBindingId` between cycles ⇒ probe mismatch
  (negative control for the non-CAS writer); no write ⇒ reuse.
  (A2-mutator-audit) allowlisted audit over every production store mutator
  affecting `loadRawStateFromStore` output (probed-token bump ∨
  authority/lineage change ∨ the telemetry writer), LOCAL-plane exempt. (B)
  pull-only boot starts the watcher session; steady pull logs
  `local=watcher`; fused → re-arm → pumped fullScan witness → re-trust
  completes under pull-only while ambient fullScan requests still drop;
  (B3) fused-watcher pull still drains pendingEvents (red against r1-shape
  code); enqueue saturation sets the latch and drops events; latch ⇒
  `externalLocalWorkSettled` false; pull consumes the latch ⇒ P2 false ⇒
  scan-backed pull; overflow followed by scan FAILURE keeps P2 false
  (re-trust cannot bless the incomplete view); (B4) scoped boot asserts no
  watcher.
- Existing suites: push-spans, daemon-activity, whole-state-compat,
  daemon-trusted-pull P-matrix, watcher-session-supervisor, daemon-safety
  (pull-only never queues push — with the watcher now ON in that fixture),
  upgrade-daemons, telemetry gap-cardinality (contract.ts + sync-phase
  tests, untouched vocabulary).
- Perf differential (close-out rule): before = baseline data file; after =
  same three hosts, both lanes. Acceptance: desktop push ≤5s, Mac push
  ≤5s, FM steady pull `local=watcher` with scan ≤0.5s, no pull-lane
  regression on desktop/Mac.
- Crash/compat: CAS-refusal semantics untouched (saves unchanged); kill
  switch restores per-boundary materialization byte-identically; legacy
  JSON authority unaffected by construction; FM overnight soak before
  close-out.

## Protected functionality (explicit)

Design 247 rejection (no trusted-view push; deferral carry; recorded
no-trust-gate finding); 267 §6 contract (digest goldens, CAS refusals,
Darwin trilogy, BEGIN IMMEDIATE crash semantics, SP-2 fail-closed degraded
saves); 206/104 fuse semantics (chokidar fuse terminal; parcel re-arm
only); 202 P-predicate order (drain moves ABOVE the chain; predicate order
itself unchanged); purge-path matcher independence (policy.ts:118-132);
telemetry gap cardinality (contract.ts:19-26); pull-only push suppression;
upgrade preserves mode; design-206 P7 matcher provenance re-baselining
(`ensureMatcherProvenance` on every syncBase adoption).
