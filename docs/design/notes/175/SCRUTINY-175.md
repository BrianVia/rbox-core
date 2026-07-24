# SCRUTINY 175 — post-implementation contract audit

Scope: `fec82dd..HEAD` against normative `docs/design/175-git-ref-sidechannel.md` (ALIGNED v4) and `SPEC-175-IMPL.md`.

Verdict: **DRIFT-FOUND**

## Findings

1. **HIGH — Reftable config authority fails open on probe errors.**  
   `src/engine/git/preflight.ts:21` and `src/cli/daemon/git-ref-watch.ts:555`

   `gitRefStorage()` maps every `git config` execution/read failure to the same `undefined` used for an authoritative “key absent,” and the registry independently catches any injected helper rejection and maps it to `undefined` again. It then admits the repo, opens the file-ref handles, and queues the arm handshake unless the returned value is exactly `reftable`.

   This violates the Reftable contract that config authority must refuse reftable before preflight/attach and undermines invariant 4’s “reftable is refused (not admitted)” premise. A one-shot config probe failure on a real reftable repo can let the remaining preflight probes succeed and cache `preflightOk`; because subsequent reftable-only ref changes are outside the file-ref fingerprint, that trusted entry can carry stale Git state indefinitely. The schema bump invalidates old caches but cannot protect a new cache entry minted through this fail-open path.

   Adversarial reproduction: an injected `refStorage` rejection resulted in `state="armed"`, four open handles, and one handshake. The existing registry test at `src/cli/daemon/git-ref-watch.test.ts:615` covers only the exact successful return value `"reftable"`, not an authority read failure. “Unset” and “could not establish authority” need distinct outcomes; the latter must remain pending/retried and must not author trusted `preflightOk`.

2. **HIGH — Plan discovery cannot raise the backend-independent floor when the registry is absent.**  
   `src/cli/daemon/daemon.ts:727` and `src/cli/daemon/daemon.ts:1330`

   The plan observer only calls `this.gitRefRegistry?.upsert(repos)` and then recomputes the floor. On Linux+Chokidar the registry is deliberately absent, so neither `authoritativeGitRepos` nor any other daemon-owned additive floor state receives the discovered dir repo. `refreshGitSafetyFloor()` therefore still sees the previous scan snapshot and leaves `gitSafetyFloorRequired` false.

   This directly violates the Floor sentences that the state is maintained from plan/scan snapshots “so Linux+Chokidar ... gets the floor,” that plan-observer and candidate discovery are enumerated false→true imperative pin sites, and that only a scan-completion snapshot clears the claim. After a zero-repo scan has cleared fallback state, a push triggered without usable watcher churn can discover a newly present dir repo while a 120–300s timer remains armed; later `.git`-only changes on Chokidar are then outside the promised 60s degradation bound.

   Adversarial reproduction with no registry, an empty prior authoritative snapshot, and `safetyDelay=300000`: executing the plan-observer body with a dir repo left both `gitSafetyFloorRequired=false` and the delay at 300000. The current floor test (`src/cli/daemon/daemon-safety.test.ts:125`) mutates `authoritativeGitRepos` directly and therefore does not exercise this transition site.

3. **MEDIUM — Namespace admission failures never enter the specified retry/backoff state.**  
   `src/cli/daemon/git-ref-watch.ts:568`, `src/cli/daemon/git-ref-watch.ts:641`, and `src/cli/daemon/git-ref-watch.ts:730`

   A namespace budget excess or admission read fault sets `ownerFailures` and omits the recursive roots, but it never calls `#recordRetry`, adds a pending retry key, or arms the shared earliest-target timer. The owner reports `failed` while `pendingTargets` is zero. Recovery occurs only when an unrelated plan/candidate/safety input happens to reconcile again; conversely, frequent unrelated inputs can immediately repeat the expensive admission walk without the required `nextAttemptAt` gate.

   This differs from the Bounds contract (“read fault ... no-recursive-roots ... + pending/floor”) and executable Retry contract (1s exponential per-target retry, one earliest timer, non-preemption before `nextAttemptAt`, failures retain desired ownership). Adversarial reproduction of an entry-budget failure produced `state="failed"`, `pendingTargets=0`, and zero scheduled timers. The existing budget test at `src/cli/daemon/git-ref-watch.test.ts:633` asserts only shallow-handle count and `failed`, allowing this drift to stay green.

4. **MEDIUM — Contributor-only ownership changes close and reopen still-owned physical handles.**  
   `src/cli/daemon/git-ref-watch.ts:427`

   `changed` includes every contributor-map difference, so removing one owner or changing a role/refcount always creates a replacement watcher and closes the old one even when the same `(canonicalRoot, mode)` remains present in the complete next graph. The intended in-place filter/refcount update at `src/cli/daemon/git-ref-watch.ts:472` is unreachable for an actual contributor change because that change already forced the replacement path.

   This violates the Ownership sentence that a physical handle closes only when its last next-generation contributor is gone. It also introduces unnecessary `ENOSPC`/attach-failure exposure during ordinary owner removal or simultaneous transfer. If such a replacement fails, the retained old handle still has the old role filter and can miss the newly transferred role until retry/floor recovery.

   Adversarial reproduction: with a normal repo and linked worktree sharing the common root, a complete snapshot that removed only the normal owner closed the existing common-root handle and opened another while the pointer still owned that root. The current sharing test (`src/cli/daemon/git-ref-watch.test.ts:221`) asks for `latest()` after each removal and checks only active count/filter behavior, so it masks the reopen.

5. **MEDIUM — The admission walk follows symlinked `heads`/`tags` roots.**  
   `src/cli/daemon/git-ref-watch.ts:644`

   The walk passes `commonDir/refs/heads` and `.../tags` directly to `opendir()`, which follows a symlink at the root. The `entry.isSymbolicLink()` guard at line 665 only prevents following symlink children after that root has already been followed. This differs from the explicit pre-arm admission contract “opendir streaming, no symlink following.”

   Adversarial reproduction: a `refs/heads` symlink to an external tree was traversed deeply enough to trip the directory budget. The later realpath containment check prevents an out-of-root watch from being published, so this is not an invariant-5 watch escape; it is still out-of-contract pre-admission I/O outside the namespace and defeats the no-follow heuristic.

6. **LOW — The construction eligibility predicate admits unsupported Linux targets.**  
   `src/cli/daemon/git-ref-watch.ts:20`

   `gitRefSideChannelEligible()` checks only `platform === "linux"` and a non-Chokidar environment. It has no architecture/libc or confirmed-Parcel-availability dimension, so it returns true on unsupported Linux arches/libcs and the daemon constructs a registry before Parcel loading later fails.

   The Gates platform matrix says ON only for linux-x64-glibc and linux-arm64-glibc with Parcel available, and OFF for unsupported arches and Parcel-unavailable fallbacks. Production currently fails the later Parcel load before initial discovery can open handles, which limits the immediate safety impact, but the advertised single construction gate and release self-test predicate do not implement the matrix as written.

7. **MEDIUM — The mandatory lock-pre-signal/busy-retry regression test was not implemented.**  
   `src/cli/daemon/daemon-git-capture.test.ts:23` and `src/cli/sync-git/git-sync.test.ts:1165`

   The daemon test only asserts that the exported delay constant equals `[2000, 8000]`. The sync test proves that an `index.lock` reports through `onGitBusyDeferred`, but no test drives the daemon episode, absolute timers, non-resetting reports, second-retry reset, or close cancellation. There is no required scenario holding a branch-ref lock and `packed-refs.lock` past both debounce and max-wait while suppressing the final target callback, then proving the pre-signal plus retries alone captures.

   No runtime defect in the episode implementation was proven by this audit, but this is still explicit implementation drift: the normative lock section and design test 4 say that exact safety regression test **must** be written. The current green suite would not catch a broken connection between the pre-signal, busy seam, and the scheduled retry pushes.

## Requested checks that were clean

- Signal isolation is intact: ref/lock/structure/candidate inputs stay out of `pendingEvents`, `onRawEvent`, the manifest, and upload.
- `src/engine/ignore.ts` changes only factor the ref-tail classifier through the shared table. The scanner/manifest `.git` hard exclusion is unchanged, and the main-path `isGitRefSignal` predicate remains behavior-equivalent, including lock/reftable/remotes/rbox exclusions.
- The registry epoch pump, stale-snapshot non-shrinking horizon, latest-generation publication checks, and close-after-await fencing match the Registry contracts. Safety scan enumeration fails loudly before `applySnapshot(..., true)`, so the caller’s completeness value is valid on its reached path.
- Both daemon registry construction and floor eligibility retain the required `process.platform === "linux"` gate; Darwin opens zero side-channel handles. Finding 6 is the narrower supported-target matrix drift.
- No production `want.push = true` remains outside `requestPush(reason)`; former enqueue sites map to signal/candidate/scan/other, and provenance snapshot/normal-return recording boundaries match the Telemetry contract.
- `packed-refs.lock` participates in both `gitBusy` and the fingerprint.
- `GIT_FINGERPRINT_SCHEMA_VERSION` is bumped from 4 to 5, the divergence-cache file version derives from it, and old-version cache loading invalidates entries before trusted carry.
- The server telemetry drift test really compares the complete transformed server schema to the client schema, including kind and positional field order; `git_capture` ingest is pinned to doubles `[signal, candidate, scan]`.

## Verification performed

- Focused repository suites: 68 pass, 0 fail across registry, daemon integration/safety/provenance, fingerprint, packed-lock, and client telemetry tests.
- API telemetry ingest/drift suite: 12 pass, 0 fail.
- `bun run typecheck`: pass.
- `git diff --check fec82dd..HEAD`: pass.
- Six temporary adversarial proofs reproduced findings 1–6; the scratch test was removed and was not added to the worktree.

SCRUT175-DONE
