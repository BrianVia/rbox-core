# REVIEW-100 — adversarial review ledger for design 100 (fresh-join cold apply)

Reviewer: `codex exec` (gpt-5.6-sol) in read-only mode, attacking apply
atomicity, interrupted-join resume, watcher interaction, symlink/case trie
edges, gate falsifiability, re-proposals of shipped work, and pack-cache scope
creep. Cap: 5 rounds. Target: `VERDICT: ALIGNED`.

## Round 1 — VERDICT: REVISE (18 items)

Raw output: scratchpad/review-100-r1.txt. Items and disposition:

1. **Pre-pass breaks stage-before-displace atomicity.** ACCEPTED. Rewrote §3.1
   to make the trie pre-pass optimize the CLEAN case only; ANY obstruction (or
   an existing on-disk node that is not cleanly a directory) demotes the WHOLE
   affected subtree to today's unchanged serial `applyActions` obstruction path
   (the reviewer's offered "leave obstructed subtrees wholly on the current
   path"). No new obstruction protocol is invented.
2. **`parentPrepared` TOCTOU / symlink race.** ACCEPTED. §3.1 now states the
   contract removes only the redundant `mkdir`, never a safety check: publish
   still runs `assertWithinRoot` (ancestor symlink-traversal defense) and the
   `rename` still fails safe (ENOENT/ENOTDIR) if an ancestor was replaced, which
   defers that entry via the existing per-entry failure path. Added replacement-
   race tests (after-prepare, after-stage, before-rename) to §4.
3. **Interrupted-join resume asserted too strongly (SIGKILL).** ACCEPTED. §4.3
   now inventories every persistent intermediate (published files, `.rbox`
   temps, `.ct` temps, git scratch refs, prefetched artifact temps, partial
   `git fetch` state / index.lock) and gives per-item rerun behavior, and
   acknowledges SIGKILL runs no cleanup.
4. **No-conflict-copy resume expectation false.** ACCEPTED. §4.3 reframed:
   convergence rests on the next run's scan+reconcile (not apply internals);
   require "no user bytes lost," conflict copies only where the user actually
   diverged — dropped the zero-conflict claim.
5. **Watcher ignores staging events / deferred queue.** ACCEPTED. §4.4 now notes
   apply ALREADY stages temps beside targets today (so temp events are not new;
   only empty-dir creation is), requires the temp prefix be matcher-pruned,
   and adds a drain-the-queue-after-join test (not just pending-set inspection).
6. **Case/normalization trie not implementable.** ACCEPTED. §3.1/§4.5 replaced
   "filesystem equivalence key" with EXACT-BYTE trie nodes; on-disk identity is
   learned through fs ops (EEXIST), any collision/alias demotes the subtree.
   Added APFS-case-sensitive / case-insensitive / Unicode / casefold-ext4 tests.
7. **Case-collision success test incomplete.** ACCEPTED. §4.5 test matrix
   expanded: file/file (`A/x` vs `a/x`), dir/file case, Unicode-equivalent,
   deterministic rejection of unrepresentable pairs.
8. **Symlink handling contradictory.** ACCEPTED. §3.1/§4.5: existing node is
   `lstat`'d only when the single `mkdir` hits EEXIST/ENOTDIR (not a whole-tree
   sweep); the exact preserved semantic (obstruction → conflict copy; directory
   type-flip → trash) is named against apply.ts lines. Added symlink-chain,
   dangling, out-of-root, ancestor-replacement tests.
9. **`DirectoryPlan` can't execute its own fallback.** ACCEPTED. Interface now
   carries in-memory `path` on obstructions; privacy rule clarified to prohibit
   SERIALIZATION/logging of paths, not in-memory use.
10. **Git prefetch pseudocode doesn't pipeline.** ACCEPTED. §3.3 replaced the
    await-all-then-import shape with an ordered bounded producer/consumer (≤K
    ready artifacts, import consumes in order, cancel-on-failure, cleanup,
    global byte AND task caps).
11. **Presence-skip underspecified.** ACCEPTED. §3.3: presence check runs BEFORE
    acquisition for historical links (never download a present link) and is
    revalidated before ordered import — stated as preservation of shipped
    design-53 behavior.
12. **Still risks re-proposing shipped work.** ACCEPTED. Added explicit
    implementation-diff boundaries; Phase 2 states design 39's size-aware
    scheduler is NOT shipped for cold apply (Finding 12 recommends it as future
    work) and is scoped to the cold-apply write pool only; Phase 3 narrowed to
    within-repo acquisition pipelining; all gates attribute under existing repo
    parallelism / presence-skip / batch GET / 48-slot knee.
13. **Gates not falsifiable.** ACCEPTED. §5 gates now carry numeric minimum
    effect sizes, a noise-band rule (effect must exceed the p95 noise band over
    N samples), and resource-regression ceilings. G1 is a prospective kill.
14. **G2 denominator ambiguous.** ACCEPTED. G2 now separates mkdir API calls,
    component walks, successful creations, EEXIST classifications, and requires
    an end-to-end apply-wall improvement, not just asymptotic counters.
15. **Phase 0 over-broad / can deadlock.** ACCEPTED. §3.0 split into MANDATORY
    minimal per-phase evidence vs. optional fleet characterization; each phase's
    own gate can proceed independently; owners/collection named.
16. **Pack cache leaked into G0.** ACCEPTED. Removed R2 critical-path from G0 and
    rollout; it is now at most an optional client-observable network-wait metric
    noted for a FUTURE pack-cache design, never a blocker.
17. **Phase 4/5 scope creep.** ACCEPTED. Phase 4 (streaming decrypt) and Phase 5
    (local plaintext) reduced to measurement + disposition notes only;
    implementation explicitly handed to separate designs if triggered. This
    design's implementable envelope is Phases 0–3.
18. **Atomicity needs directory-level failure tests.** ACCEPTED. §4.1 adds
    failure-injection during obstruction discovery, descendant staging,
    displacement, dir recreation, and multi-file publication, with the
    subtree-recoverability invariant.

## Round 2 — VERDICT: REVISE (9 items)

Raw output: scratchpad/review-100-r2.txt. Items and disposition:

1. **`assertWithinRoot` claim factually wrong** (it runs once at writeEntry top,
   no re-check before rename). ACCEPTED — verified in code (apply.ts:206 is the
   only call). Invariant (a) rewritten honestly: the TOCTOU window exists TODAY;
   Phase 1's obligation is only to not widen it (check placement unchanged);
   closing it (anchored openat/O_NOFOLLOW) added to §7 out-of-scope as an
   independent hardening project.
2. **Case plan can lose a manifest entry** (concurrent renames racing one
   physical target). ACCEPTED. §3.1 adds a conservative fold-key (NFC+casefold)
   collision-group pass BEFORE the parallel pool: >1 exact-byte member → the
   group is applied SERIALLY through today's per-entry path in byte order, so
   the second entry deterministically hits the precondition/conflict-copy path.
3. **Alias demotion incomplete.** ACCEPTED. Demotion is by fold-key GROUP, not
   exact-byte subtree — no alias continues concurrently against the same
   physical subtree; in-memory grouping never merges names (safe on
   case-sensitive volumes, only serializes).
4. **index.lock breaks the convergence gate.** ACCEPTED. §4.3 gate split into
   two tiers: file plane converges unconditionally; git plane
   converges-or-defers-LOUDLY per repo (stale foreign lock = loud single-repo
   deferral, pre-existing exposure; auto-reclaim is §7 out-of-scope).
5. **Watcher correctness asserted, not designed.** ACCEPTED. §4.4 names the
   three states (pulled manifest / daemon in-memory manifest / persisted
   lastSyncedManifest) and the existing handoff (state.json written under the
   mutex; queued events applied via applyWatchEvents converge the daemon view;
   next push diffs against updated lastSyncedManifest → join-authored bytes
   show zero divergence). Concurrent user edits MUST survive the drain as a
   pending push — tested.
6. **`parentPrepared` not implementable.** ACCEPTED. §3.1 specifies the
   plumbing: WriteEntryOptions gains the boolean (preparedTmp precedent); the
   batch downloader's per-payload record carries it from enqueue; dropped on
   ANY retry/fallback leg; no invalidation protocol needed (skip-only hint,
   failure routes through the existing per-entry error path).
7. **Gates inconsistent/non-falsifiable.** ACCEPTED. §5 now has a uniform
   measurement protocol (named workload, alternating control/candidate, ≥5
   valid samples with documented-discard-only rule, noise-band pass rule, 1Hz
   resource sampling with 10% p50-peak ceiling, "≈" defined as within 2% or
   ±16). M-P1 aligned to ≥5 samples. G1/G3/G4 restated as
   trigger + control/candidate ship gates.
8. **Pack-cache still leaked into Phase 0.** ACCEPTED. The "optional
   network-wait metric" removed entirely; §1.5/§3.0/§7 now say no Finding-15
   instrumentation of any kind in this design.
9. **Early presence-skip repackaged as preservation.** ACCEPTED. §3.3 and the
   boundary table restated: import-time skip stays verbatim and authoritative;
   the producer-side early check is a NEW deliverable of Phase 3 with defined
   semantics (presence only grows during an apply; producer miss → consumer
   skip catches it; one-sided failure mode = wasted download, never a
   correctness input).

## Round 3 — VERDICT: REVISE (6 items; item 7 = shipped-work + pack-cache boundaries now acceptable)

Raw output: scratchpad/review-100-r3.txt. Items and disposition:

1. **Unrepresentable manifest pairs don't converge** (conflict-copy path
   churns on every re-join). ACCEPTED. §3.1 adds an explicit terminal-state
   contract: first member (byte-order) published; remaining colliding members
   skipped with LOUD per-path deferral (counts in metrics, paths only in the
   forensic log), NOT conflict-copied, NOT re-fetched — stable across re-runs.
   §4.3's file-plane convergence scoped to representable entries. The
   push-side semantic (un-materialized entry must not become a remote delete)
   is a PRE-EXISTING exposure recorded as founder open question #4, not solved
   here.
2. **Fold grouping not prefix-closed; §3.1/§4.5 contradiction.** ACCEPTED.
   Fold keys now computed over EVERY path prefix; a colliding prefix pulls its
   entire descendant action set into one group (transitively closed); groups
   are wholly excluded from the trie pre-pass (the EEXIST-confirm shortcut is
   for non-colliding paths only — contradiction resolved) and applied
   serially. The false "exotic equivalences land serially" claim replaced with
   the honest statement: missed groups remain in the parallel pool — exactly
   today's behavior, so the heuristic is strictly risk-reducing, a mitigation
   not a proof.
3. **Early presence-skip reverse transition (producer HIT → consumer ABSENT
   under external prune) had no artifact.** ACCEPTED. §3.3 adds the late-fetch
   rule: consumer performs the ordinary fetch+decrypt for that link under the
   same global budgets, then verifies/imports in order; failure defers the
   repo. The early check now has no correctness role on either transition;
   tested by injected tip removal.
4. **parentPrepared "retry" didn't exist** (poolMap is fail-fast). ACCEPTED —
   verified (`src/engine/pool.ts:7–10`). Contract restated against reality: a
   flagged ENOENT/ENOTDIR fails the apply run exactly as staging failures do
   today; recovery is the §4.3 re-run with a fresh plan. Batch-internal retry
   legs (which do exist) MUST clear the flag. Both paths tested.
5. **Watcher gate needed the same-target adversarial case.** ACCEPTED. §4.4
   test (b) is now: user edits path P after join publishes P but before P's
   queued events drain (coalesced add/change/unlink for one path, two
   authors) → applyWatchEvents re-stats final disk truth, the edit survives as
   divergence, nothing lost, no join-authored version misattributed.
6. **1 Hz sampling can't falsify a peak gate.** ACCEPTED. §5 resource ceiling
   now uses true peaks where obtainable (ru_maxrss/VmHWM for RSS; exact byte
   accounting by the owning code for temp disk; owned FD open/close accounting
   with sampling only as a labelled lower-bound backstop), and states that the
   HARD configured caps (semaphore byte/task caps, lane FD/RSS budgets) are
   the actual safety invariant, with measurement as evidence.
7. Shipped-work + pack-cache boundaries acceptable — no action.

## Round 4

Status: pending (running)
