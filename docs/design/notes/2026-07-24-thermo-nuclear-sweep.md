# Thermo-nuclear structural sweep — 2026-07-24

Eight parallel opus reviewers, one per subsystem (engine/git, engine core,
sync data plane, sync-git plane, daemon, CLI command layer, remote/transport,
API worker), with the already-known decomposition roadmap excluded
(194–199 done; daemon.ts-WS / sync-git apply+follow / sync push /
key-delivery-fulfill / setup-cmd / status-cmd / e2ee-client planned;
plan.ts / credentials.ts / e2ee-remote.ts deliberate leave-alones).
Every finding below carries reviewer-verified file:line evidence; cleared
areas were cleared with reasons, not silence.

## Tier 0 — behavior-adjacent; fix promptly regardless of refactor cadence

1. **`remote/auth-command-wire.ts` fetches have no abort deadline**
   (`postJson` :6-12, `listDevicesAuth` :45; no caller adds one).
   Reintroduces the unbounded-hang class `resilient.ts` documents killing,
   on the pre-enrollment login path. Fix: route through context-free
   `fetchWithDeadline` (retries stay 0 — mint calls are non-idempotent).
2. **Recovery-probe op bodies have silently diverged from the pump**
   (`daemon.ts` `runRecoveryProbe` :1525-1566 vs dispatch :1632-1679):
   recovery scans omit `maybeClearWatcherDegradedAfterScan` and recovery
   pulls omit notify-latency recording — a recovery full-scan won't clear a
   watcher-degraded surface. Fix: extract shared `executeOp(op, {recovery})`;
   decide each divergence explicitly. Needs characterization tests.
3. **`doctor-cmd.ts:32-36` hand-copies the 16 `GitDeferralReason` strings as
   a `Set`** — the only copy TypeScript can't exhaustiveness-check; a 17th
   reason silently misclassifies in doctor while typed consumers fail
   loudly. Fix: derive the union from one exported runtime tuple.

## Tier 1 — dead code / pure deletes

4. Dead pairing lane: `remote/keys.ts` `pairCreate` :89-96 +
   `api.ts:165-167` + `PAIR_TOKEN_MINT_RERUN_HINT` — zero callers since the
   auth split's wire module took the route; CODEMAP documents both owners.
5. `daemon.ts:1695` `const heals = false` + statically-dead block :1700-1702
   — neutered mechanism's leftover scaffolding through four expressions.
6. `adopt-cmd.ts:182` raw `console.log(JSON.stringify(...))` → `emitJson`;
   `doctor-cmd.ts` diagnostics-preview block rendered twice (:608-611 vs
   :616-621).
7. **GATED (founder call + fleet sweep):** `engine/git/journal.ts` v1.7.24
   legacy checkout-journal recovery plane (~250-300 lines: legacy shapes,
   validators, `legacy ?` forks through recovery). A surviving legacy
   journal requires a v1.7.24 crash never recovered since; fleet is 1.9.0.
   One-time sweep of the 4 external hosts + fleet for pre-1.8 journal
   files, then delete the plane wholesale.

## Tier 2 — canonical-helper consolidations (batch 2-3 PRs by area)

8. `engine/fsutil.ts` errno module (`errCode`/`isAbsent`/`isEEXIST`/
   `isPresentButUnreadable`) — today reimplemented in apply-receipt :101,
   apply :523, manifest :16-28, trash :88 (+ inline comparisons).
9. `moveNoClobber` + `~N` suffix-claim loop duplicated byte-for-byte between
   `engine/apply.ts:497-521` and `engine/trash.ts:281-298` — a crash-safety
   primitive (INVARIANTS "conflict copies never overwrite") → fsutil.
10. `remote/errors.ts` `errorCode(text)` on the existing safe-parser —
    replaces 4 hand-rolled `JSON.parse` discriminators (keys :13/:21,
    commits :234/:353).
11. `prompt.ts` `confirmDestructive({headless: policy})` — six commands
    hand-roll the TTY-gate/--yes/prompt triple with divergent headless
    policies (untrack proceeds, ignore/key throw, adopt denies, doctor
    requires --yes); make the policy an explicit named argument.
12. API: `platformSecretMatches` (ctEqual check duplicated authz.ts:71 vs
    workspace-sync.ts:1237); fair-use lease-liveness EXISTS fragment
    inlined 6× (fairuse.ts:1053-1122, 401).
13. sync-git small trio: shared `presentWitnessFromPreparedRef` (byte-dup
    p-settlement:44 / p-repair-state:48), shared git-ancestry primitive
    (resolution-intent:133 / pending-supersession:178 — preserve each
    caller's fail-closed mapping), hoisted default-P-repair partial.
14. e2ee `session.ts` DeviceSecrets/device-upload packaging built
    field-by-field 3× (:119, :513, :564) → two pure helpers.

## Tier 3 — state-plane consolidation (single focused PR; follow-on to 198)

15. `applyComposedBase(target, composed, candidateBase?)` in
    base-composer.ts — the compose→apply epilogue incl. the
    pending-disposition rule is copy-pasted 4× (sync-state-store :165-182,
    sync-state :221-260, :502-511, sync-state-model :408-418).
16. Promote `sanitizeRepoRecordInput`/`sanitizeCarriedRecords` into
    sync-state-model — the loop is inlined 3 ways (store :199-208,
    sync-state :293-295, :519-521).
17. One canonical `REPO_STATE_LANES` list — the git-lane key set is
    hand-enumerated in 5 places (store :320-327, :243-248, model :348-356,
    sync-state :361-378, :550-559); missed entries fail silently.
18. Fold `savePublishedRepoIntent` (sync-state.ts:396-544) onto the
    `saveStateSource` CAS-retry/forceLegacy driver — it is a second full
    save engine whose only unique part is the lane-merge core. Needs
    characterization tests.
19. Rider: sync-mutex.ts:208 fence predicate → hoist `fenceEngaged`.

## Tier 4 — decomposition seams (one dev-cycle each; my suggested order)

20. **API `versions.ts` → `storage-gc.ts`** + relocate the 12-line
    `versionsList` — a mislabeled 950-line GC engine, absent from CODEMAP
    (the only unowned API module). Mechanical, high clarity value.
21. **`engine/git/lockfile.ts` 3-way split** — identity/boot-ledger
    (~330L) + storage-locality probe (~95L) out to siblings; the DI seams
    already exist; leaves ~800L of pure lock mechanics. Mechanical.
22. **`engine/apply-receipt.ts` → extract `receiver-equivalence.ts`**
    (~200L toolkit consumed by three git-lane modules that have nothing to
    do with the applied-manifest oracle). Mechanical.
23. **Daemon `Scheduler`/`TimerSet` seam** — 15 timer fields, 3 alias clock
    interfaces, 4 duplicated clock literals, hand-written teardown, plus
    parallel backoff scaffolds in git-ref-watch/watcher. Do this BEFORE the
    planned WS extraction (it shrinks it). Large, careful.
24. **`MutexContentionController`** — 6 fields + 7 methods lift out of the
    daemon god-class behind an `onContended/onAcquired/signalEarlyReprobe/
    abort` interface (daemon.ts :152-254, :541-546, :1279-1361).
25. **API `WorkspaceSync.commit()`** (370L, four seams): envelope
    validation belongs in commit-envelope.ts (owner of the types already);
    receipts-admission + shadow-compare to private methods; plus
    `readGapEntry` dedupe (roots :1006-1027 ≡ rootsInspect :1113-1132 —
    feeds GC and fair-use, must never diverge). Needs characterization
    tests for commit; gap-entry dedupe is careful-small.
26. **engine/git apply.ts `publishRefTransition`** — the ancestry-proof →
    displacement-pin → typed-vs-plain commit → hold sequence triplicated
    (:524-567, :568-605, :635-700; witness literal 4×). Needs
    characterization tests (design-116/130 hot path).
27. checkout-txn.ts: track `MarkerObservation` only, derive `OwnedGitLock`
    on demand (kills 6 lockstep nullable locals); `transactionLines` reuses
    `refUpdateLines`.
28. telemetry `queue.ts` `AdditiveCounters<F>` — gitCapture/wsHealth twin
    ~28-line blocks incl. the presence-token residual trick.
29. apply-receipt: unify `inventory`/`scopedScan` walkers over one
    `walkRepoSubtree` (churn-token anti-TOCTOU bookkeeping single-sourced).
    Needs characterization tests.
30. daemon `renderSurfaces` builder under writeHeartbeatSurfaces/
    enqueueActivityWrite (~85% shared pipeline); autostart reconciler
    guard/flag consolidation (lowest priority — correct but subtle;
    autostart tests as harness first).

## Design inputs (not standalone PRs)

- **WS extraction seam pinned** (daemon reviewer): pump-shared surface is
  exactly Carrier + 6 carrier helpers, `pendingCatchUpGeneration`/
  `markWsCaughtUp`, `notifyPullPendingAt`, read-only lastSyncedSequence.
  Injected interface: `{requestPull(carrier), markCaughtUp(gen),
  localAppliedSequence(), keyDelivery.enqueue()}` — fold into the daemon.ts
  design doc when that cycle starts.
- `status-view.ts` (934L) three-surface split couples naturally to the
  planned status-cmd split — do them together.

## Cleared with reasons (do not re-litigate)

Dispatcher switch (registry already exists + parity test); git-cmd raw
JSON.stringify (redacting replacer); translateRemoteError vs
friendlyHttpError (different lanes/copy); per-endpoint retry policies
(deliberate, commented); the two D1 lease primitives (genuinely different
CAS models); blob_ref prune barrier inlining (CODEMAP-endorsed);
upload-lane vs push-tail timing (different lifetime models);
composeRepoBase authority switch (closed, pinned by structure test);
state-cas-locks/orig-head/held-skip ordering (INVARIANTS);
shared.ts gitBusy fast path (documented); keep-pins FIFO plumbing
(load-bearing); ignore.ts (irreducible precedence); manifest-delta dual
canonicalizer (memory bound, documented); crypto verifier trio (distinct
trust rules); freshly-split runtime-state/process-control/log-reader and
auth//git//config facades (boundaries verified clean).

## Suggested sequencing

Tier 0 + Tier 1(4-6) as one batch of small PRs now; Tier 1(7) after the
fleet sweep + founder call. Tier 2 as 2-3 grouped PRs (engine, remote+cmd,
api). Tier 3 as one focused state-plane PR. Tier 4 one per dev-cycle
interleaved with feature work — 20/21/22 first (mechanical), 23 before the
WS extraction, 25/26/29 only behind characterization harnesses. Every PR
through the move-fidelity audit + surface-lock pattern (194–199 precedent).
Net effect if fully executed: roughly 800–1,000 lines deleted outright,
~1,000 relocated behind honest boundaries, and four latent drift hazards
closed.
