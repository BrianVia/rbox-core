I audited every cited anchor against HEAD/origin/main `6538c91ab` and ran the relevant watcher, scheduler, trust, pull, safety, and oracle suites: 179 passed, 0 failed. The current contracts are green; the design is not.

1. CRITICAL — §4.1 misidentifies the macOS failure and proposes the wrong backend

The claim that “`.git` is pruned from the file watcher” is false for Parcel. The native prune set explicitly excludes `.git`, pruning only `.git/objects` and `.git/logs`, precisely so ref signals remain visible ([ignore.ts:227](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/ignore.ts:227)). Parcel supports `darwin-arm64` ([watcher.ts:290](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/watcher.ts:290)) and routes Git-ref signals before normal matcher filtering ([watcher.ts:331](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/watcher.ts:331)). Those signals bypass the ordinary file batcher and enter `gitSignalDebouncer`, so `.git` events do not pollute file batches.

Chokidar is different: it deliberately prunes those signals and remains scan-bound for Git ([watcher.ts:409](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/watcher.ts:409)).

The gated “side channel” is not the existing FSEvents/chokidar backend. It is a separate `fs.watch` registry documented and owned as Linux-specific ([git-ref-watch.ts:188](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/git-ref-watch.ts:188), [CODEMAP.md:148](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/docs/CODEMAP.md:148)). It opens several roots per repository ([git-ref-watch.ts:600](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/git-ref-watch.ts:600)), while its continuity/floor semantics are also explicitly Linux-only ([git-discovery-continuity.ts:113](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/git-discovery-continuity.ts:113)).

Therefore widening `linux && parcel` to Darwin would:

- Redundantly layer `fs.watch` over Parcel on normal Apple Silicon installations.
- Not repair Chokidar fallback behavior.
- Introduce unverified Darwin recursive-watch, resource-budget, duplicate-signal, close-race, and safety-floor behavior.

The round-5 cadence may be real, but the code does not support the proposed cause. Instrument the selected backend and whether Parcel emitted/classified/debounced the relevant ref event before designing another watcher.

2. CRITICAL — self-inflicted drop attribution is unknowable and reopens design-104’s safety hole

Parcel delivers an asynchronous callback containing only `Error`; there is no causal timestamp, event ID, originating mutation, or kernel interval ([watcher.ts:331](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/watcher.ts:331)). At receipt, the daemon can know only what operation happens to be active then ([daemon.ts:870](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:870)).

Neither candidate attribution source solves that:

- `activePumpOp` is callback-delivery overlap, not causation.
- The mutation gate records currently active process-local mutations ([mutation-gate.ts:32](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/mutation-gate.ts:32)); scans are reads, and external changes may happen concurrently with any lease.

A drop caused before an operation but delivered during it would be falsely exempted. Conversely, a daemon-caused drop delivered after the operation would be counted as external.

This is exactly the ambiguity design 104 resolved conservatively: every drop increments `errorGen`, repeated transient drops feed a never-reset rolling fuse, and re-trust requires a clean full-tree scan with stable generation ([104-watcher-trust-recovery.md:134](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/docs/design/104-watcher-trust-recovery.md:134), [daemon.ts:887](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:887), [daemon.ts:2290](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:2290)).

If an asynchronously delivered external drop is labeled “self,” leaving trust armed permits the next trusted pull to consume a stale local manifest. Even if it still temporarily marks the watcher suspect, excluding it from the fuse means a repeatedly unreliable stream can re-enter trust indefinitely. Both weaken the corruption defense.

Safe disposition: record “overlapped daemon operation” as telemetry only. It must not affect `errorGen`, trust, or fuse accounting unless the watcher backend supplies genuine causal evidence.

Also, `activity.halt` is the wrong visibility surface. A halt controls scheduler eligibility and recovery probes ([daemon-operation-scheduler.ts:182](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon-operation-scheduler.ts:182)); watcher health already has the distinct `watcher-degraded` status reason ([ambient-status.ts:205](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/ambient-status.ts:205)).

3. CRITICAL — §4.4 does not define a safe or actually O(delta) manifest contract

`reconcile` currently indexes and traverses the union of complete base/local/remote manifests ([reconcile.ts:41](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/reconcile.ts:41)).

A partial local manifest plus full base/remote can produce correct actions if delta completeness is separately proven, but it remains O(workspace) because base and remote are still fully indexed and traversed. Projecting all three to delta paths obtains O(delta), but destroys the mass-delete denominator: it is explicitly the complete scoped baseline count ([pull.ts:311](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/sync/pull.ts:311), [pull-scope.ts:36](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/scope/pull-scope.ts:36)). Calling that denominator “per-path” is incorrect.

The oracle is not per-path either; its public proof unit is a complete repository subtree ([apply-receipt.ts:20](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/apply-receipt.ts:20)). `oracleFromPull` builds expected state by applying actions to the entire `preScan` manifest ([apply-receipt.ts:715](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/apply-receipt.ts:715)). With a delta-only `preScan`, unchanged repository entries disappear from expected; inventory alignment then fails and widens to a full repo scan ([apply-receipt.ts:414](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/apply-receipt.ts:414), [apply-receipt.ts:461](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/apply-receipt.ts:461)). That preserves safety by abandoning the fast path, not by proving the proposed O(delta) path.

This needs a first-class delta-reconcile interface carrying:

- A completeness proof for the remote delta.
- The complete scoped baseline count for mass-delete protection.
- Full untouched expected authority for oracle receipts.
- An explicit projection/merge contract.

Passing a “partial Manifest” through complete-manifest APIs is not sound.

4. MAJOR — notify priority lacks ownership and an ambient-scan service bound

The carrier is daemon-owned and consumed only after scheduler selection ([daemon.ts:407](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:407), [daemon.ts:1616](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:1616)). `policy.ts` sees only four boolean wants ([policy.ts:85](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/policy.ts:85)). Therefore “policy.ts gains carrier awareness” is not a local priority edit; urgency must become scheduler-owned request metadata.

The existing recovery bound can remain intact because every ambient dequeue counts and a due probe is forced after eight ([policy.ts:93](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/policy.ts:93), [daemon-operation-scheduler.ts:334](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon-operation-scheduler.ts:334)). No-progress and mutex backoff are also preservable if selection still requires a queued pull and ordinary `request()` semantics remain unchanged.

But there is no comparable bound for scans. A continuous stream of notify pulls can keep reasserting `pull` and starve an already-armed full/deep scan forever, violating the intended unconditional reconciliation floor ([daemon.ts:985](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:985)). Specify a one-slot/bounded-burst bypass followed by forced service of the oldest scan. Existing scheduler tests cannot merely “pass unmodified”; new carrier retention, scan-service-bound, recovery-bound, contention, and after-dequeue-arrival contracts are required.

5. MAJOR — F2 is neither universal nor narrowly scopeable with current ownership

F2 does not “fire on every applying pull in a git-heavy workspace.” It fires only when repository keys change or a mutation-affecting Git section identity changes ([manifest-update.ts:162](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/manifest-update.ts:162), [shared.ts:125](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/sync-git/shared.ts:125)).

Its full scan is deliberate: it repairs ref-registry ownership, safety-floor state, matcher provenance, and topology discovery ([daemon-pull-transition.ts:217](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon-pull-transition.ts:217)). The observation owner currently supports a full-workspace scan or a named watcher patch—there is no repository-scoped authoritative scan/merge transition ([local-workspace-observer.ts:270](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/local-workspace-observer.ts:270)).

A scoped F2 would require a new partial-authority receipt defining subtree deletion, matcher generation, topology ownership, collision completeness, deferred paths, and merge lineage. It is not a simple fallback variant.

6. MAJOR — §7’s slices are not independently landable as written

The benchmark requires a “server timestamp in the committed frame” ([design:116](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/docs/design/232-reactive-propagation.md:116)), while the non-goals promise the WS frame shape is untouched ([design:44](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/docs/design/232-reactive-propagation.md:44)). The actual frame contains only `type`, `sequence`, and `deviceId` ([workspace-sync.ts:761](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/apps/api/src/workspace-sync.ts:761)). That is a protocol change unless the benchmark uses separately correlated server telemetry.

Other dependency failures:

- The macOS slice is based on the wrong watcher model.
- Priority requires carrier ownership migration and a new starvation contract.
- Drop attribution must not land in its proposed form.
- Delta apply requires new authority and oracle interfaces.
- “Restart-free supervised retrust” contradicts the preserved hard, terminal fuse.
- The deferral cap changes retry behavior while deferral semantics are assigned to design 234.

Instrumentation is independently landable; most other slices are not yet specified sufficiently.

7. MINOR — instrumentation-first is correct, but the proposed buckets are incomplete

The evidence identifies only the phase: residual is wall time minus five counters ([format.ts:18](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/sync/format.ts:18)). It does not identify the cause.

The untimed hot loop includes path construction, rule checks, Git discovery, cache lookup, and entry allocation ([manifest.ts:586](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/manifest.ts:586)). Rule inventory validation does run before and after a pruned walk, but only over recorded rule files ([manifest.ts:147](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/manifest.ts:147), [dircache.ts:164](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/dircache.ts:164)); a third rule-file stat pass occurs while rebuilding the inventory ([manifest.ts:181](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/engine/manifest.ts:181)). Nothing yet justifies naming double validation as the 56.9-second cause.

Instrument mutually exclusive residual buckets with high-resolution timing and measure the instrumentation overhead. Keeping delta-scoped design blocked on that result is the right ordering.

8. MINOR — two anchor descriptions are inaccurate

- The settled ordinary file-event callback calls scheduler `request("push")`, not `requestPush` ([daemon.ts:852](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:852)). The behavioral claim—immediate scheduling after debounce—is still correct.
- The cited F1–F4 range contains F4/F3/F2 only ([daemon-pull-transition.ts:224](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon-pull-transition.ts:224)); F1 is the watcher-generation check during patch installation ([daemon.ts:1984](/home/via/Development/Personal/rbox-core/.claude/worktrees/232-reactive-propagation/src/cli/daemon/daemon.ts:1984)).

**NOT-ALIGNED**