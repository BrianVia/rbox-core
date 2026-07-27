1. **HIGH — Matcher generation does not cover the live watcher’s matcher; trusted pull can re-engage over stale state.**

   `rebuildMatcher` replaces `this.matcher` ([daemon.ts:3170](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:3170)), but the watcher captured the previous matcher object when started ([daemon.ts:791](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:791)). Parcel continues filtering through that captured matcher ([watcher.ts:364](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/watcher.ts:364)); Chokidar’s persistent `ignored` callback does likewise ([watcher.ts:411](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/watcher.ts:411)).

   Concrete failure sequence:

   1. Existing matcher ignores/prunes `x`.
   2. An ignore-rule or topology change makes `x` observable.
   3. Daemon rebuilds its matcher and full-scans, stamping the manifest with the new generation ([daemon.ts:1995](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:1995), [daemon.ts:3022](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:3022)).
   4. The live watcher still filters with the old matcher and misses a later edit to `x`.
   5. P1/P2/P5/P7 and generation equality all pass, so trusted pull consumes stale state.

   This is directly relevant to topology changes when `respectGitignore` is enabled: `knownGitRepos` affects trackedness and pruning, not merely purge diagnostics. The fix must update watcher filtering too—preferably through a stable matcher facade that delegates to the current matcher, or by safely restarting/re-arming the watcher with an explicit trust downgrade across the gap.

2. **MED — The discriminated skip-result migration is underspecified and breaks the production caller.**

   `doPull` currently passes the return directly to `pull`, mutates it after refusal, dereferences `.manifest`, and uses undefined checks for fallback/logging ([daemon.ts:2197](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2197), [daemon.ts:2253](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2253), [daemon.ts:2298](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2298)). Replacing the return type with `{view}|{skip}` without specifying this rewrite is a compile-time and behavioral break.

   The design should require separate variables, e.g. `initialSkip` and `trustedLocal`. A trusted-view refusal must clear `trustedLocal` without inventing a predicate `skip=` cause; the existing `refused=` line remains its explanation.

3. **MED — The “additive-only” logging compatibility claim is false.**

   There is an exact assertion for the old bare line:

   [daemon-trusted-pull.test.ts:424](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon-trusted-pull.test.ts:424)

   It will fail once the kill switch emits `pull local=scan skip=kill-switch`. Direct view consumers at lines 216 and 284 must also unwrap `.view`, beyond the P-matrix changes already named by the design.

   Also, the current P-matrix directly calls `buildTrustedPullView`; it cannot assert an *emitted log token*. It can assert the returned discriminant, or separate end-to-end pull tests must verify logging.

4. **MED — The stated stale-matcher blast radius is materially incorrect.**

   The design says `knownGitRepos` feeds only `unevaluatedGitRepoForPath`. In fact it seeds `knownRepoRelSet` ([ignore.ts:369](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:369)), which becomes `trackedRepos` ([ignore.ts:550](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:550)). Those records affect:

   - trackedness ([ignore.ts:460](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:460));
   - whether directories may be pruned ([ignore.ts:473](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:473));
   - ignore and prune decisions ([ignore.ts:508](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:508)).

   This invalidates the argument that stale matcher state mostly affects the latch and strengthens finding 1.

5. **MED — The matcher rebuild cost claim is overstated.**

   Rule files are synchronously read on every build ([ignore.ts:355](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:355)), but repository discovery occurs only when tracked evaluation is enabled ([ignore.ts:370](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:370), [ignore.ts:550](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:550)). `git ls-files` is conditional on a tracked-cache miss at [ignore.ts:681](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/engine/ignore.ts:681). The guard remains justified, but the prose should say rebuilds *may* discover repositories and invoke Git.

6. **LOW — Existing nested rebuild sites can double-bump the generation.**

   After adding the guard to `loadSyncBase`, calls shaped as `rebuildMatcher(await loadSyncBase())` can rebuild once inside `loadSyncBase` and again outside it ([daemon.ts:2000](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2000), [daemon.ts:2284](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2284), [daemon.ts:3246](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:3246)). Their subsequent scans stamp the latest generation, so this is redundant work rather than a correctness flaw. The design should acknowledge or refactor it.

7. **LOW — “Every new base” and field-verification claims need qualification.**

   `loadSyncBase` is the primary base funnel, not the sole one: `observeDurableGitState` directly assigns `syncBase` ([daemon.ts:2343](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:2343)), including hygiene at line 2367. The proposed mirrored guard is therefore necessary; otherwise a later `this.syncBase ?? loadSyncBase()` can bypass provenance repair.

   The Mac version, timings, and 35-minute burn-in are external field evidence and cannot be verified from the requested repository files.

The rest of the mechanism checks out:

- The guarded rebuild in `loadSyncBase` is sufficient for base-key provenance and correctly located at the durable-state load boundary.
- Mirroring it in `observeDurableGitState` is necessary.
- `rebuildMatcher` is synchronous and does not acquire the workspace mutex, so calling it while the pump holds that mutex creates no deadlock or reentrancy ([daemon.ts:1639](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:1639), [daemon.ts:3170](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/src/cli/daemon/daemon.ts:3170)).
- All daemon manifest assignments are centralized in `installManifest`; the only full-workspace install is the scan path. Seed, push, watcher, and pull-patch installs are correctly partial or unstamped.
- Monotonic generation safely handles A→B→A topology cycles.
- Push, pull, safety scan, and deep scan are pump/mutex serialized; watcher callbacks only enqueue. Aside from the captured-watcher-matcher hole above, no interleaving can stamp a scan under the wrong generation.
- Design 202’s F2 claim that the fallback scan itself realigns matcher provenance is indeed false at [design 202:184](/home/via/Development/Personal/rbox-core/.claude/worktrees/pull-fast-path/docs/design/202-pull-trusted-local-manifest.md:184).

**Verdict: CHANGES-REQUIRED.** The base-latch repair and generation stamping are sound, but the watcher must participate in matcher provenance before the stated anti-stale invariant is true.