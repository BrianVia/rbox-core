# SPEC 204-SIMPLIFY — apply the 4-lane cleanup rulings (diff f0bfb456..HEAD)

Behavior-preserving cleanup EXCEPT where a ruling below explicitly notes a
semantic change. Design contracts in docs/design/204-delta-scoped-publish.md
still bind (§5.2 stats shape, §7 cause enum, kill-switch byte-fidelity).

## Fixes to apply

1. src/cli/e2ee-remote.ts — replace the duplicated delta-eligibility logic
   (positive guard ~:822-825 + negated cause ternary ~:846-854) with ONE
   classifier, e.g. `deltaDisposition(...): {ok:true} | {ok:false; cause:
   MdeNonDeltaCause}` evaluating policy → force → no-base/rejection(from
   options.deltaBaseRejection) → integrity → epoch/chain-cap in a single
   ordered expression; the emit branch tests disposition.ok and the log uses
   disposition.cause. Eligibility and cause must be the same expression by
   construction. Preserve the exact current cause outcomes (tests pin them).
2. src/cli/sync-git/plan.ts — fingerprint bucket honesty: remove
   `measureFingerprint` from the two capture-pool call sites (~:667,669,
   they run CONCURRENTLY under poolMap) and delete the
   `fingerprintBracketDepth` counter; keep plain `measure` at the serial
   sites (~:944,977,1395). fingerprintMs ≤ totalMs must hold by
   construction. Adjust the C5 test if it asserted pooled attribution.
3. src/cli/sync/push.ts — memoize the base-integrity check per push()
   invocation (NOT per attempt): cache key
   `(appliedSequence, manifestMeta.encManifestSha, manifestMeta.manifestHash)`;
   a retry attempt with the same key skips recomputing
   canonicalManifestHashStreaming. Scope the cache to the push() call (a
   local Map threaded to runPushAttempt or a closure), not module state.
4. src/cli/sync-git/plan.ts — pre-loop ctx prefetch: immediately before the
   `for (const rel of keys)` pre-loop, `if (gitPlanLazy) await
   poolMap(keys, <existing capture concurrency const>, (rel) =>
   preCaptureRepoCtx(rel))` so the serial loop hits the memo. poolMap is
   already imported.
5. src/cli/sync-git/plan.ts — workspace realpath: wrap in asyncMemo called
   at the use site; delete the eager `gitPlanLazy ? await realpath : undefined`
   at ~:442 and the `workspaceRootReal!` assertion + second gitPlanLazy test
   in the loop (~:475-477). One branch at the use site.
6. src/cli/sync-git/plan.ts:~445 — delete the dead `const repoDir =
   repoDirOf(root, rel);` local.
7. src/cli/sync-git/plan.ts — timings plumbing: one
   `const timings = {discoverMs:0, journalPreloopMs:0, fingerprintMs:0,
   hygieneMs:0}` with `measure(key, fn)` keyed on `keyof typeof timings`;
   replace the untyped `Object.assign(stats, {...})` with a typed spread.
   KEEP otherMs and totalMs in GitPlanStats (design-pinned §5.2 — do not
   remove them).
8. src/cli/sync-git/plan.ts — narrow the test hook: keep ONLY the hygiene
   stage emission of `onPostCaptureCtx` (rename to `onHygieneCtx(rel, ctx)`
   if cleaner); delete the other four observer call sites (the fresh
   derivations themselves STAY — only the observer calls go). Update the
   one consuming assertion in git-sync.test.ts.
9. src/cli/sync-git/plan.ts:~448-454 — replace the inline
   lstat(checkoutJournalDir)/ENOENT probe in the resolution branch with
   `checkoutJournalPresent(root, rel)`. SEMANTIC CHANGE, RULED: on
   non-ENOENT errors the old code threw out of the planner; fail-open
   "present" now proceeds into binding/recovery whose existing catch defers
   with recoveryBlocked — strictly better than a planner crash. Drop the
   now-unused checkoutJournalDir import if nothing else uses it.
10. src/cli/e2ee-fake-server.ts remoteFor — add an optional ctx-override
    param; src/cli/e2ee-sync.test.ts `sinkRemoteFor` uses it instead of
    constructing E2eeRemote directly.
11. src/cli/publish-pipeline/pipeline.test.ts:~23-38 — replace the 16-line
    save/restore boilerplate with a beforeEach that deletes
    RBOX_PREFLIGHT_DELTA and RBOX_PREFLIGHT_FULL (mirror
    e2ee-sync.test.ts's pattern).
12. src/cli/sync-recovery.ts — add `fullAuditEnabled(forceFullAudit?)`
    next to preflightDeltaEnabled and use it at both duplicated sites
    (:~187, :~297).
13. src/cli/publish-pipeline/pipeline.ts — derive the 3-valued mode once
    (`"legacy" | "delta" | "full-audit"`) near the arg boundary and express
    the three flag-pair tests (~:208, :442, :484) in terms of it.

## Explicitly SKIPPED (do not do)
- Removing otherMs/totalMs from GitPlanStats (design-pinned).
- Removing validateManifest before the hash check (both load-bearing:
  shape vs content).
- Any change to the evidence-fold fallback's re-fetch behavior.
- scripts/e2e/dev-backed-scenario.test.ts (pre-existing main breakage).

## Acceptance (run yourself, report verbatim)
- bun test src/cli/sync-git/ src/cli/e2ee-sync.test.ts src/cli/publish-pipeline/
- bun run test:affected
- bun run typecheck
