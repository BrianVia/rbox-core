# Design 175 adversarial review — round 2 (Codex)

## Verdict: CHANGES-REQUIRED

V2 resolves much of round 1's structure: the `(role, tail)` classifier removes
the literal-`.git` dependency for already-discovered pointer repositories; forced
generation dirtiness fixes inode reuse; the fatal-reader disposition, executable
attach backoff, role-level ownership graph, cross-surface telemetry scope, and
manual-vs-CI evidence matrix are now sound.

It is not yet safe for implementation dispatch. The reftable refusal does not
match a real reftable layout, and the new pointer-floor definition is internally
unsatisfiable. The namespace pre-count also cannot bound Bun's recursive watcher,
while the busy retry, discovery observer, generation ordering, candidate payload,
and provenance seams each still leave load-bearing behavior to the implementer.

## Findings

1. **BLOCKER — C-3's reftable refusal does not reject a real reftable repo and can be bypassed by a trusted pre-v2 probe.** (`docs/design/175-git-ref-sidechannel.md:212-222`)

   The specified detector is “`refs/heads` absent + `reftable/` present.” A local
   source-backed reproduction with Git 2.54 (`git init --ref-format=reftable`)
   creates `.git/reftable/` and creates `.git/refs/heads` as a **regular file**
   containing the reftable sentinel text. The path is therefore present, so a
   literal implementation of the normative predicate admits exactly the shape it
   is meant to refuse. Reftable commits leave that sentinel unchanged, while the
   fingerprint still reads only `packed-refs` and `refs` and never the reftable
   store (`src/cli/sync-git/fingerprint.ts:204-224,266-295`). Invariant 4 remains
   false.

   Correcting only `gitPreflight` is still insufficient. The trusted carry path
   accepts a cached `preflightOk` probe without rerunning live preflight
   (`src/cli/sync-git/plan.ts:671-688`; `src/cli/sync-git/divergence-cache.ts:254-273`),
   and the divergence-cache file version is the fingerprint version
   (`src/cli/sync-git/divergence-cache.ts:11-13,88-97`). A reftable repo probed by
   pre-175 code can therefore retain the old verdict indefinitely.

   Replace the detector sentence with: “A single helper, used by both
   `gitPreflight` and the registry before attach, reads
   `extensions.refStorage` through the repository and structurally refuses the
   exact value `reftable` for dir and pointer repos; filesystem layout is not the
   authority. This change increments `GIT_FINGERPRINT_SCHEMA_VERSION`, thereby
   invalidating the divergence cache before the refusal ships.” Add a regression
   that seeds an old-version trusted `preflightOk` cache entry for a reftable repo.

   This is not a new round-2 subject: round 1 found the reftable blocker and
   required refusal or fingerprint support. The faulty filesystem predicate first
   appeared in v2, so round 1 could not test this resolution.

2. **BLOCKER — The v2 floor formula and pointer-parity rule cannot both be implemented.** (`docs/design/175-git-ref-sidechannel.md:191-210,285-293,304-316`)

   `gitSafetyFloorRequired` is true when **any** registry root is
   armed/attaching/failed, but the same paragraph and mandatory test say a
   pointer-only workspace does not pin. A supported in-root pointer repo must arm
   at least its `gitDir` role and normally its common-ref roles
   (`docs/design/175-git-ref-sidechannel.md:108-112`), so it necessarily satisfies
   the root-state disjunct. Conversely, excluding pointer-owned roots preserves
   172 parity but contradicts invariant 4 for admitted pointer shapes. The
   contradiction is sharpest for an out-of-root pointer: current preflight admits
   it (`src/engine/git/preflight.ts:63-69`), invariant 5 forbids watching its
   control roots, and v2 also says it does not pin.

   The design must choose one policy: either pointer roots/pointer watch refusal
   pin the 60-second floor (delete the parity sentence and test), or only
   dir-backed ownership pins (explicitly carve pointer-only and out-of-root
   pointer repos out of invariant 4 and the event-driven guarantee). Also state
   that every candidate watch root is `realpath`-canonicalized and containment-
   checked before attach; `repoCtxFromDisk` currently performs only lexical
   `path.resolve` and does not enforce the no-outside-authority invariant
   (`src/engine/git/shared.ts:299-328`).

   This blocker is new because v2 folded two individually understandable rules
   beside each other: O-3's “pointer-only does not pin” parity ruling and C-6's
   new “any registry root state pins” formula. V1, reviewed in round 1, contained
   neither combined formula nor its impossible required test.

3. **MAJOR — C-11's pre-arm namespace count is neither a bounded walk nor a lifetime descriptor bound.** (`docs/design/175-git-ref-sidechannel.md:140-148`)

   Bun performs its own complete recursive walk after the application precheck
   (`bun-v1.3.14/src/runtime/node/path_watcher.zig:469-477`). After arming, a new
   or moved-in directory causes Bun to add that directory and recursively add all
   existing descendants before the JS batch is flushed (`:659-675`). Thus a repo
   can pass at 512, grow between count and attach, or receive an arbitrarily large
   populated subtree later; the registry cannot close at 513 before those wds
   have already been installed. The pre-count does not make recursive mode
   bounded.

   Even the pre-count is underspecified: “cheap bounded walk” gives no streaming
   early stop, visited-entry ceiling (large ref-file populations matter even when
   directory count is small), combined heads+tags accounting, symlink rule, or
   read-fault disposition. The JS-handle claim is also false for a pointer whose
   `gitDir !== commonDir`: the listed roots are `gitDir`, `commonDir`, `refs`,
   `heads`, and `tags` — five, not at most four
   (`docs/design/175-git-ref-sidechannel.md:108-112,143`). Pointer admission order
   is absent as well; only dir repos receive a deterministic selection rule.

   An early-stop sentence alone cannot repair the lifetime bound. Choose either a
   registry-owned, shallow per-directory graph that refuses to install beyond a
   hard combined/global budget, or explicitly withdraw the strict “bounded” claim
   and document dynamic-growth exhaustion as an exception with floor behavior.
   In either case specify: streaming `opendir`, no symlink following, immediate
   close/stop at budget+1 or the visited-entry cap, and any read/entry overflow as
   no-recursive-roots + pending/floor. Test both count-to-attach growth and a
   post-arm populated move-in above budget.

4. **MAJOR — C-7 still misses `packed-refs.lock`, and its explicit implementation choice includes the already-rejected terminal-result failure mode.** (`docs/design/175-git-ref-sidechannel.md:87-104`)

   `packed-refs.lock` is a named `lockPreSignal`, but the live busy check omits it
   (`src/engine/git/shared.ts:562-572`) and the common-dir fingerprint omits the
   lock (`src/cli/sync-git/fingerprint.ts:204-224`). A trusted fast-path probe can
   therefore carry the old packed refs without reaching `isGitBusy`
   (`src/cli/sync-git/plan.ts:671-688`), report no busy deferral, and schedule no
   +2s/+8s retry. With the final target callback suppressed, the pre-signal still
   strands capture at the safety floor.

   “SyncDeps observer or a `gitDeferred` field — implementation picks” is also not
   decision-complete. A terminal field can be lost to a later upload/commit error,
   exactly as round 1 explained for discovery. Replace it with: “
   `packed-refs.lock` participates in both `gitBusy` and fingerprint invalidation.
   `SyncDeps.onGitBusyDeferred` is the sole reporting seam; it is invoked
   non-throwingly immediately after each completed `planGitSections` result and
   before later state-save/upload/commit work. The first report opens one
   workspace episode with absolute +2s and +8s retries; reports from those retries
   do not reset or extend it; close cancels it and the episode resets after the
   second retry.” Add the final-callback-suppressed test specifically for
   `packed-refs.lock`.

5. **MAJOR — The SyncDeps discovery placement is sound, but v2 does not require the awaited settlement that closes genesis/blocked-push/close races.** (`docs/design/175-git-ref-sidechannel.md:163-189`)

   The named placement is feasible: discovery occurs in both the files-first
   branch and the ordinary path (`src/cli/sync-git/plan.ts:217-227,246-268`), before
   upload/commit and terminal blocking; `repoCtxFromDisk` resolves arbitrary
   pointer control-dir names (`src/engine/git/shared.ts:299-328`); and the monotonic
   close fence matches the real shutdown order, which closes the watcher before
   draining the pump (`src/cli/daemon/daemon.ts:699-735`). This mechanism can close
   all three races.

   V2 merely says the observer is “invoked.” It does not say awaited versus
   fire-and-forget, define rejection behavior, or require registry settlement
   before the genesis return. It also spells the payload `{repoPath, kind}` even
   though the source contract is `DiscoveredGitRepo { relPath, kind }`
   (`src/engine/git-discover.ts:5-12`). Add: “
   `SyncDeps.onGitReposDiscovered?: (repos: readonly DiscoveredGitRepo[]) =>
   Promise<void>` is awaited immediately after both discovery calls. It never
   rejects into planning and resolves only after each input is either published as
   armed or recorded pending/floor and any arm handshake is queued; a closed
   registry resolves as a no-op. Initial/plan/candidate inputs are additive
   upserts; they never shrink ownership.”

6. **MAJOR — Generation dirtiness has no latest-wins publication or authoritative-snapshot horizon.** (`docs/design/175-git-ref-sidechannel.md:114-138,169-182`)

   Close fencing prevents post-close publication, but nothing prevents an older
   async `repoCtxFromDisk`/attach run from publishing after a newer candidate or
   replacement generation. “Build the entire next graph” does not define input
   serialization or stale-result disposal.

   The sole shrinking input has a second race. A safety discovery can pass a
   directory, then a candidate can discover and arm a new repo, and finally the
   older safety snapshot can complete without that repo and erase the newer owner.
   Simple FIFO application by completion order is wrong. Nor is the existing
   discovery result automatically authoritative: `discoverGitRepos` converts any
   `readdir` failure into an empty directory (`src/engine/git-discover.ts:35-52`),
   so “completed” can mean incomplete.

   Add: “All registry inputs enter one serialized reconcile pump with a monotonic
   input epoch; only the latest generation may publish, and a superseded run closes
   handles it created. A safety snapshot carries its start epoch and a completeness
   bit; it may remove only owners not touched by post-start inputs, and any discovery
   I/O failure or relevant epoch advance makes the snapshot non-shrinking and
   preserves the floor until a later complete snapshot.” Test stale attach
   completion and candidate-after-directory-pass/before-scan-completion, not only a
   generic “reconcile race.”

7. **MAJOR — The shared payload-free debouncer loses both targeted-candidate state and `signal`/`candidate` provenance.** (`docs/design/175-git-ref-sidechannel.md:70-78,179-180,231-239`)

   V2 requires exact candidate paths plus create/update/delete semantics for
   targeted discovery and generation invalidation, and independently requires a
   reason lattice. The current shared seam is `SignalDebouncer.push(): void` with a
   no-argument flush callback (`src/cli/daemon/watcher.ts:98-101,140-165`); the
   daemon receives only `onGitSignal(): void` (`src/cli/daemon/watcher.ts:41-42`;
   `src/cli/daemon/daemon.ts:572-575`). There is nowhere to retain candidate owner,
   event disposition, or reason bits. Raising provenance at raw-event time is not a
   substitute: an already-queued unrelated file push can dequeue before the
   candidate's debounce flush and be falsely attributed to the candidate.

   Add: “`SignalDebouncer.push(reason, candidate?)` ORs reason bits and a bounded
   per-owner `{dirty, discover}` map; update/delete dirtiness is monotonic across a
   coalesced recreate. Flush atomically snapshots and clears both, passes candidate
   work to targeted registry discovery, and only then merges the reasons into the
   queued push provenance. Candidate-map overflow requests ordinary full-plan
   discovery and remains signal-only.” This is the missing end-to-end carrier for
   pointer retarget/delete. Once a pointer context is armed, the `(role, tail)`
   classifier itself correctly covers control dirs containing no `.git` segment.

8. **MINOR — C-13's snapshot lattice is implementable, but the named enqueue and terminal-success boundaries are incomplete.** (`docs/design/175-git-ref-sidechannel.md:224-248`)

   Snapshotting where `want[op]` is consumed is a valid seam
   (`src/cli/daemon/daemon.ts:998-1005`), and holding that snapshot around
   `pushManifest` naturally retains it across the internal retry loop
   (`src/cli/sync/push.ts:245-301`). However, the design says provenance is raised
   at `request("push")`, while scan completion, pull completion, and startup use
   direct `requestPush()`/`want.push` sites (`src/cli/daemon/daemon.ts:515-516,
   1009-1017,1038-1042`). It also does not say whether normal
   `PushResult { committed:false }` returns count, or what happens to the active
   snapshot on a throw/terminal-blocked return (`src/cli/daemon/daemon.ts:1177-1215`).

   Add: “Every enqueue flows through `requestPush(reason)`: debounced ref/lock =
   signal, debounced `.git` lifecycle = candidate, completed full/deep scan = scan,
   and startup/file/pull/retry/handshake = other. `successful` means every normal
   `pushManifest` return, including `committed:false`; thrown and terminal-blocked
   operations do not increment and discard only their active snapshot; reasons
   arriving meanwhile remain queued for the next push. `other` emits no
   `git_capture` counter.” Record immediately after the normal `pushManifest`
   return, before later daemon bookkeeping.

9. **EDITORIAL — One accepted fold test and the mandatory ownership-map edit disappeared from v2's dispatch scope.** (`FOLD-PLAN-175-R1.md:50-53`; `docs/design/175-git-ref-sidechannel.md:295-338`)

   The F8 ruling explicitly adds a product-level integration flood test covering
   registry + debouncer + daemon under real Parcel churn. V2 retains the standalone
   behavior probe and rig but does not include that product integration test in its
   mandatory list. Add it verbatim; the probe has no product imports and is not a
   substitute for wiring/floor retention.

   V2 also adds `src/cli/daemon/git-ref-watch.ts`, but `docs/CODEMAP.md:7-12`
   requires a same-PR entry for every new daemon/sync-engine module. Add the CODEMAP
   update to scope, including the new module's ownership/never-own boundary and any
   ownership moved out of `watcher.ts` or `ignore.ts` (`docs/CODEMAP.md:95,202`).

## Round-1 closure ledger

| Round-1 item | V2 disposition after source verification |
|---|---|
| C-1 classifier/backend split | Classifier mechanism resolved; candidate carrier remains open in finding 7. |
| C-2 inode reuse | Forced generation dirtiness resolved; stale async publication remains open in finding 6. |
| C-3 reftable | Not resolved: finding 1. |
| C-4 cross-surface telemetry | Resolved: client, API normalization/AE/drift test, ingest test, and consumer are all in scope. |
| C-5 discovery/close | Placement and monotonic close are sound; awaited settlement and ordering remain open in findings 5-6. |
| C-6 live floor | Imperative false→true pin is resolved against `pinSafetyFloor`; pointer policy is contradictory in finding 2. |
| C-7 lock pre-signal | Not resolved for packed refs and not decision-complete: finding 4. |
| C-8 candidate lifecycle | Create/update/delete set is resolved; payload/targeted-discovery transport remains open in finding 7. |
| C-9 fatal Bun reader | Resolved as process-lifetime degradation with latched floor and no futile retries. |
| C-10 behavior probe | Resolved at design level with populated move-in, real Parcel pressure, replacement, source CI, and compiled Linux release legs. |
| C-11 bounds/backoff | Retry/backoff is executable; descriptor/resource bound is not resolved: finding 3. |
| C-12 shared common-dir ownership | Resolved with `(repoOwner, role)` contributors, next-graph construction, publish-before-retire, and required transfer tests. |
| C-13 attribution | Precedence/dequeue/internal-retry model is sound; enqueue carrier and terminal boundary need findings 7-8. |
| C-14 platform/rig evidence | Resolved: real release targets named, compiled Linux gates required, and rig honestly manual. |
| C-15 sizing editorial | Resolved for API, provenance, CI/release, and rig scope; CODEMAP omission remains finding 9. |

The design is close at the architectural level, but the two blockers and the
remaining carrier/ordering contracts prevent a clear-spec implementation dispatch.

R175R2-DONE
