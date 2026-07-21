# Design 175 adversarial review — round 1 (Codex)

## Verdict: CHANGES-REQUIRED

The central diagnosis survives review: Parcel 2.5.6 does a recursive initial Linux crawl but only attaches the one newly reported directory on the live create/move path, and it discards `IN_Q_OVERFLOW` (`node_modules/@parcel/watcher/src/linux/InotifyBackend.cc:66-94,96-123,151-183`). Bun 1.3.14 has a separate process-global inotify manager and its recursive live-add path walks an arriving directory's existing descendants (`bun-v1.3.14/src/runtime/node/path_watcher.zig:419-477,659-670`). A Linux-only Bun side-channel is therefore technically plausible.

The proposed contract is not yet implementable without violating several of its own invariants, however. Four issues are blockers: the single boolean classifier is incompatible with lock/structural events and unchanged macOS behavior; `(dev, ino)` does not safely detect replacement; reftable is not healed by the claimed scan floor; and the telemetry rider would be silently dropped by the deployed ingest contract. The lifecycle/result seam, dynamic floor, resource bound, retry model, ownership graph, and load-bearing tests also need normative revision.

## Findings

1. **BLOCKER — The lock/structure contract, single-predicate invariant, pointer-repo support, and “macOS unchanged” cannot all be true.**

   Design 175 requires shallow watchers to accept `HEAD.lock`, `packed-refs.lock`, and `stash.lock`, and to react to the structural names `refs`, `heads`, and `tags (`docs/design/175-git-ref-sidechannel.md:50-77`). It simultaneously says `isGitRefSignal` remains the one classification truth, side-channel semantics may not fork it, and macOS behavior is unchanged (`docs/design/175-git-ref-sidechannel.md:155-165`). The existing truth explicitly rejects every `.lock`, does not recognize the structural directories, and recognizes only paths beneath a literal `.git` segment (`src/engine/ignore.ts:160-200`). The predecessor deliberately made locks false (`docs/design/172-event-driven-git-commit-detection.md:148-169,278-282`), and its tests pin that behavior (`src/engine/ignore.test.ts:70-100`). The platform-independent Parcel callback invokes this predicate before the matcher (`src/cli/daemon/watcher.ts:285-316`), so making it return true for locks/structure also makes aborted locks and structural churn request pushes on macOS. Filtering those classes only in the new registry instead forks the promised truth.

   Pointer repos make the boolean seam still less viable. `repoCtxFromDisk` permits an arbitrary in-tree gitdir/commondir name (`src/engine/git/shared.ts:299-328`); a callback rooted at `control/worktree-7/HEAD` has no `.git` segment and can never satisfy the existing predicate.

   Replace the boolean contract with one semantic classifier over `(watch role, target-relative tail)`, returning at least `target`, `lock-pre-signal`, `structure`, `repo-candidate`, and `none`. Then state backend policy explicitly: all backends accept committed targets; only the Linux side-channel accepts lock/structure classes; candidates are lifecycle hints, not ref signals. Revise invariants 3 and 6 accordingly. If lock pushes on macOS are intended, say so and remove “UNCHANGED.”

2. **BLOCKER — `(dev, ino)` does not make delete/recreate force re-arm; a dead watch can compare equal.**

   The claimed replacement guarantee is false (`docs/design/175-git-ref-sidechannel.md:93-97`). Inotify watches the old inode. Bun consumes `IN_IGNORED`, removes the wd from its maps, and emits no lifecycle notification for that event (`bun-v1.3.14/src/runtime/node/path_watcher.zig:602-615`). The probe callback also drops null filenames and retains the handle (`scripts/probe/bun-refwatch-contract.ts:176-201`).

   I reproduced the counterexample with the pinned Bun 1.3.14 on this worktree filesystem: recursively watch `refs`, remove it, recreate it at the same path, then write `HEAD`. The old and new stats were the identical tuple `(dev=66311, ino=29127651)`; the only callback was `rename, filename=null`, and the new `HEAD` produced no callback. Inode reuse is legal, so a reconcile that compares only `(dev, ino)` retains a dead handle.

   Root-self rename/null callbacks and every structural/candidate replacement signal must mark the handle generation dirty and force detach/re-attach regardless of stat equality. A richer identity such as `ctimeNs` is useful diagnostics, not a sufficient correctness fence. Add a contract and product test that recreates until the tuple is reused and then proves a mutation below the replacement root is observed.

3. **BLOCKER — Invariant 4 is false for reftable: the 60-second scan does not heal it.**

   The design calls reftable “scan-bound” and includes scan-bound-by-shape repos in the Linux floor (`docs/design/175-git-ref-sidechannel.md:59-62,112-118`), then claims every failure degrades to that floor rather than silence (`docs/design/175-git-ref-sidechannel.md:162-163`). The actual fingerprint reads `packed-refs` and recursively fingerprints `refs`, plus per-worktree `HEAD`/index/op-state; it reads no reftable storage (`src/cli/sync-git/fingerprint.ts:204-224,266-295`). A safety scan can therefore reuse a trusted stale fingerprint forever. The predecessor explicitly records this exception and recommends preflight refusal or fingerprint support (`docs/design/172-event-driven-git-commit-detection.md:298-321`).

   This must be resolved in 175, not described as bounded. Either refuse reftable in `gitPreflight` until supported, or teach the fingerprint enough reftable state to invalidate the fast carry path. If it remains a non-goal, carve it out of invariant 4 and state that the design does not provide eventual correctness for that repo shape.

4. **BLOCKER — The telemetry rider is not end-to-end; the server will accept HTTP 202 while dropping every `git_capture` sample.**

   The design specifies only a new client sample and client queue test (`docs/design/175-git-ref-sidechannel.md:144-153,191-192`). The wire kind is duplicated strictly on the server (`src/cli/telemetry/contract.ts:25-84,112-132`; `apps/api/src/telemetry-ingest.ts:26-81`). An unknown kind is normalized as `unknown_kind` (`apps/api/src/telemetry-ingest.ts:142-148`), counted as dropped, and still receives HTTP 202 (`apps/api/src/telemetry-ingest.ts:216-236`). On any 202 the client removes every submitted sample before merely logging the server's dropped count (`src/cli/telemetry/queue.ts:115-128,131-147`). Thus a client-only implementation silently destroys the metric it calls fleet-visible.

   Make the rider explicitly cross-surface: client schema/types/accumulator, queue snapshot/removal, API schema and normalization/Analytics Engine layout, drift test, ingest test, and the chart/query consumer. The existing contract guard requires exact client/server equality (`apps/api/test/telemetry-ingest.test.ts:61-79`). The sizing and deployment/verification section must include `apps/api/**`; this is not a ~client-only addition.

5. **MAJOR — The described terminal `PushResult` seam cannot deliver “every completed plan,” cannot preserve discovery across later failure, and creates a close-after-result race.**

   Discovery and context resolution occur in the middle of planning (`src/cli/sync-git/plan.ts:246-268`), while `pushManifest` may execute several plans in its retry loop and returns only the terminal attempt (`src/cli/sync/push.ts:235-301`). `PushResult` currently has no context field (`src/cli/sync/push.ts:87-95`), and the daemon sees it only after all later capture/upload/commit work succeeds (`src/cli/daemon/daemon.ts:1177-1215`). A plan followed by upload, commit, recovery, or terminal failure loses its authoritative eligibility snapshot. The files-first branch also returns immediately after discovery without resolving contexts (`src/cli/sync-git/plan.ts:217-227`). That contradicts “after every completed plan” and can let an eligible repo back off after precisely the failure that prevented result delivery.

   Shutdown makes terminal-result reconciliation unsafe. `stop()` marks the daemon stopped, closes the watcher, and only then drains an in-flight pump (`src/cli/daemon/daemon.ts:699-735`). A push already in progress can therefore produce contexts after `watcher.close()` has completed. Fencing only the reconcile that happened to be in flight at close is insufficient.

   The seam is feasible without a layering violation, but it should be an internal `SyncDeps` observer invoked immediately after each discovery/context-resolution phase, before later failure, not a terminal result field. `SyncDeps` already carries daemon-owned callbacks into the sync layer (`src/cli/sync/deps.ts:31-75`), and the scanner already offers `onGitRepo` before `.git` pruning (`src/engine/manifest.ts:98-110,566-570`). Make the observer best-effort and awaited through registry settlement: successful arms or explicit pending/floor state, followed by the handshake push. Specify a monotonic registry `closed` bit set before the first close await; every later reconcile is a no-op, every attach path checks it after each await, and a handle created after closure is closed before publication. Test late result delivery after close, not only close while attach was already running.

6. **MAJOR — A getter sampled at the next safety tick is not a live floor, and Chokidar currently has no source for eligibility.**

   The daemon computes the next delay when a tick fires and immediately arms that delay (`src/cli/daemon/daemon.ts:669-696`). If `watchRequired` changes false→true after a quiet tick armed 120–300 seconds, a “live view” alone leaves that long timer in place. The existing imperative `pinSafetyFloor()` is what pulls an already-armed timer forward (`src/cli/daemon/daemon.ts:639-656`). Every false→true eligible transition must invoke that seam immediately, including startup/plan/scan discovery, attach failure, over-cap disposition, out-of-root/reftable shape, and backend fallback.

   Eligibility must also be tracked independently of active handles. Chokidar returns no `gitRefWatchActive` and prunes `.git` (`src/cli/daemon/watcher.ts:347-388`), yet the matrix promises Linux+Chokidar a 60-second floor (`docs/design/175-git-ref-sidechannel.md:120-126`). Use authoritative plan/scan snapshots to maintain a backend-independent `gitSafetyFloorRequired`; use a separate `gitSidechannelActive/Pending` view for handles. Only an authoritative full snapshot may clear the floor—an incremental delete candidate must not do so by itself.

7. **MAJOR — A lock callback is only a pre-signal, not proof that a transaction completed; the current planner has no Git-busy retry path.**

   The signal debouncer may flush at its 400 ms quiet delay or 3 s max-wait (`src/cli/daemon/watcher.ts:140-165,249-259`). If that push reaches planning while the transaction still holds a lock, the planner carries/defer-returns on `isGitBusy` (`src/cli/sync-git/plan.ts:458-478`). The daemon's prompt retry machinery is driven only by file deferrals in `PushResult` (`src/cli/daemon/daemon.ts:1235-1245`); Git plan deferrals are not returned there (`src/cli/sync/push.ts:87-95`). A max-wait flush can therefore consume the only usable lock pre-signal, and a swallowed or lost terminal ref rename leaves the capture to the safety scan.

   Add a bounded post-busy Git retry/lock-release recheck, independent of file deferrals. Test a transaction held beyond both debounce and max-wait while injecting only the lock callback; the final target callback must be suppressible for the test to prove the pre-signal contract by itself.

8. **MAJOR — The repo-candidate seam omits update/delete and therefore misses pointer retargeting and lifecycle invalidation.**

   The design names only a created/moved `.git` directory or pointer (`docs/design/175-git-ref-sidechannel.md:85-88`). Parcel provides `create`, `update`, and `delete` before matcher filtering (`src/cli/daemon/watcher.ts:192-204,274-317`). An in-place rewrite of a `.git` pointer changes the `gitDir`/`commonDir` derived from file contents (`src/engine/git/shared.ts:303-328`) but is neither a current ref signal nor a syncable file event; without an `update` candidate the registry remains attached to the old target until a scan. A delete must likewise invalidate ownership immediately, even if a subsequent recreate is coalesced.

   Classify every event on an exact `.git` entry—create/update/delete—as signal-only lifecycle input. Update and delete must dirty the old generation; create/update request discovery; none may enter `onRawEvent`, `pendingEvents`, or the manifest. This also supplies the forced replacement invalidation required by finding 2.

9. **MAJOR — Bun fatal-reader “retry/re-arm” cannot recover inside the process.**

   The design says a fatal reader error marks degraded and then retries/re-arms (`docs/design/175-git-ref-sidechannel.md:101-110`). Bun's manager is process-global, created once, and never destroyed (`bun-v1.3.14/src/runtime/node/path_watcher.zig:27-70`). Linux initialization creates one fd and detached reader thread (`bun-v1.3.14/src/runtime/node/path_watcher.zig:419-465`). On a fatal read error that thread emits errors and returns (`bun-v1.3.14/src/runtime/node/path_watcher.zig:568-585`); it does not clear the global manager or start a replacement. A later `fs.watch` merely adds wds to the same manager/fd with no reader.

   Model this as process-lifetime fatal degradation: close side-channel handles, latch the 60-second floor, suppress futile attach backoff, and recover only through a deliberate daemon process restart (if desired and separately bounded). Root attach failures remain retryable; reader death does not.

10. **MAJOR — The load-bearing probe does not test either load-bearing property it claims strongly enough.**

    First, the nested case creates `refs/heads/a`, waits 15 ms, and only then creates `a/b` (`scripts/probe/bun-refwatch-contract.ts:324-329`). That proves Bun attaches the immediate new directory before a later child write; it does not prove the required recrawl of descendants that already exist when a populated directory is moved/created. `PROBE-RESULTS.md:61-63` overstates this as dynamic descendant establishment. Build a populated multi-level subtree outside the recursive root, atomically move its top directory under the root, then mutate a pre-existing deepest descendant and require its callback.

    Second, the “7–10k-op Parcel flood” creates each `generation-N` directory after subscription and immediately writes beneath it (`scripts/probe/bun-refwatch-contract.ts:205-249`). That is the exact Parcel no-recrawl race: today's runs delivered only 5–7 Parcel callback entries for thousands of issued operations (I reran the probe on Bun 1.3.14: 7,290/6,852/10,648 operations versus 5/7/5 Parcel events). The assertion requires only `parcelEvents > 0` (`scripts/probe/bun-refwatch-contract.ts:298-302`), so it does not establish material main-queue pressure or isolation. Pre-establish the Parcel-watched directories, confirm a baseline child event, then flood directly within them and assert a meaningful delivered-event lower bound while the Bun ref callback still succeeds.

    The gate also lacks root delete/recreate/null-filename coverage (`scripts/probe/bun-refwatch-contract.ts:187-201`) and the reported smoke is a `--target=bun` bundle, not `bun build --compile`, and is not executed (`PROBE-RESULTS.md:64-66`). Those cases belong in the contract before it is called Rust-rewrite proof.

11. **MAJOR — The proposed cap is not a bound on the resource that can exhaust, and the retry/backoff contract has no executable semantics.**

    `gitRepoCap()` bounds newly discovered capture work; base/pending repos are deliberately always carried (`src/cli/sync-git/shared.ts:54-61`; admission occurs at `src/cli/sync-git/plan.ts:586-595`). Reusing that number as a watch-registry ceiling needs its own deterministic selection/retention rule. More importantly, capping repos or JS handles does not cap Linux descriptors: each recursive `refs/heads` or `refs/tags` watcher walks and installs one wd per descendant directory (`bun-v1.3.14/src/runtime/node/path_watcher.zig:419-477`). One repo can contain an unbounded number of nested branch/tag namespace directories and exhaust the per-user inotify budget despite remaining under the 256-repo manifest ceiling (`src/engine/manifest-validate.ts:22,114`). The design may still choose this tradeoff, but it cannot call the registry bounded without a ref-directory budget or an honest explicit exception plus floor behavior.

    “Capped-backoff retry on next candidate/plan/scan” (`docs/design/175-git-ref-sidechannel.md:93-99`) does not specify base, cap, jitter, per-root versus global state, how an event before `nextAttemptAt` schedules the eventual attempt, reset conditions, or how candidate storms are coalesced. Define these values and state transitions. Root attach failures should retain desired ownership, pin immediately, maintain one timer for the earliest pending target, use per-target exponential backoff with jitter, reset only after successful attach, and distinguish process-fatal failures from retryable ones. Add fake-clock tests; otherwise “retry” can mean “skip until some unrelated future scan.”

12. **MAJOR — Shared-common-dir refcounting is underspecified at the filter-role level and can either drop coverage or retain the wrong semantics.**

    Keying only by canonical path+mode is not enough (`docs/design/175-git-ref-sidechannel.md:93-97`). In a normal repo, `gitDir === commonDir`, so one shallow physical handle combines two roles: `HEAD` filters and `packed-refs`/`refs` filters. A linked worktree may simultaneously contribute only the common-dir role to that same handle (`src/engine/git/shared.ts:281-328`). If the main checkout disappears while the linked worktree remains, handle-level refcounting alone either closes a still-needed common handle or retains stale `HEAD` acceptance; replacement can also transfer ownership within one reconciliation generation.

    Specify contributors as stable `(repo owner, role)` records, aggregate accepted-name refcounts per `(canonical root, mode)`, build the entire next desired graph before mutating the current graph, publish newly armed handles before retiring superseded ones, and close only after the last next-generation contributor is absent. Test normal+linked-worktree sharing, removal of either owner, simultaneous owner transfer, `gitDir===commonDir` filter union, and identity replacement during reconciliation.

13. **MAJOR — `git_capture` attribution is undefined under the daemon's actual coalescing and push retry model.**

    The daemon represents a pending push as one boolean (`src/cli/daemon/policy.ts:78-83`; `src/cli/daemon/daemon.ts:747-764`). A safety scan requests a push (`src/cli/daemon/daemon.ts:1009-1018`), a ref signal requests the same push, and either may coalesce before dequeue. `pushManifest` may plan repeatedly after 409/epoch/reupload recovery (`src/cli/sync/push.ts:245-301`). The design does not define whether a capture with both signal and scan ancestry increments one counter, both, or which one; whether the unit is push attempts or repos in `GitPushPlan.captured`; or how failed/retried plans avoid double counting. The two numbers will not measure the latency cliff consistently until that is specified.

    Carry a provenance bitset/lattice separately from `Wants`: snapshot pending reasons when a push dequeues, retain them across that push's internal retries, and leave signals arriving during the active push pending for the next operation. Define mutually exclusive attribution (for example, `signal` wins if present; `scan` means scan-only), count terminal captured repos exactly once, and specify failure behavior. The plan already exposes `captured`, but only internally; the current optional `onGitLog` plan context (`src/cli/sync/deps.ts:65-69`) is not a sufficient accounting contract.

14. **MAJOR — The platform/evidence matrix is broader than the executable gates, and the tightened rig scenario is not currently a nightly or PR gate.**

    The product loader supports only darwin-arm64 and glibc linux-x64/linux-arm64; every other host falls back (`src/cli/daemon/watcher.ts:233-246`). The matrix should therefore name Linux glibc release targets, Linux Parcel-unavailable/unsupported fallback, macOS+forced-Chokidar, and unsupported architectures rather than generic “Linux + Parcel” and “macOS.” The release matrix has native smoke legs for darwin-arm64, linux-x64, and linux-arm64 (`.github/workflows/release.yml:86-114`), but the contract evidence was run only as source on one Linux x64 host. Wire the behavior contract into the compiled release self-test on both native Linux release legs; separately assert on the macOS leg that no side-channel handles are created.

    `git-commit-propagation` is excluded from `FAST_SUITE` (`scripts/rig/scenarios/index.ts:33-47`), while the scheduled workflow invokes `all`, which means that fast suite (`.github/workflows/e2e.yml:21-30,60-65`). The workflow also documents that no self-hosted runner is registered (`.github/workflows/e2e.yml:1-8`). Tightening the two empty-commit rounds in the scenario (`scripts/rig/scenarios/git-commit-propagation.ts:443-463,504-520`) creates no automatic gate unless the workflow explicitly schedules that scenario on an operational runner. State whether this is a required manual validation or add a dedicated job; do not describe it as nightly under the current registry.

15. **EDITORIAL — The rig pin rationale and sizing are already stale.**

    The Dockerfile says `.bun-version` is empty and `package.json` declares no Bun engine while pinning 1.3.5 (`scripts/rig/Dockerfile:8-10`), but `package.json` declares `"bun": "^1.3.14"` (`package.json:6-8`). Update the comment with the pin. The production/test estimate (`docs/design/175-git-ref-sidechannel.md:201-205`) also omits the API telemetry contract, compiled cross-arch contract gate, provenance plumbing, and explicit rig workflow; revise it after the contracts above settle.

## Required revision before round 2

At minimum, the next design should:

1. replace the boolean path predicate with semantic signal classes and backend-specific acceptance;
2. define a generation-based registry with forced replacement invalidation, role/filter ownership, monotonic close, and an immediate plan/scan observer seam;
3. separate live Linux eligibility/floor state from active side-channel handles and imperatively pin on false→true transitions;
4. either refuse reftable or make its fingerprint scan-detectable;
5. distinguish retryable attach failure from unrecoverable Bun reader death and specify executable backoff/resource bounds;
6. strengthen the contract probe for populated descendant move-in, actual Parcel queue pressure, root replacement, and compiled native Linux targets;
7. define push provenance and implement `git_capture` through the API and consumer, not only the client; and
8. make the rig/platform validation an actual gate or label it honestly as manual evidence.

The discovery/threading feasibility question is therefore **yes, with a revised seam**: `discoverGitRepos` and `repoCtxFromDisk` already produce the required physical truth, `SyncDeps` already supports daemon-owned observers, and `scanManifest` already exposes a pre-prune repo hook. Returning contexts only in the final push result is the part that does not satisfy the lifecycle contract.
