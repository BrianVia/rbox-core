Verdict: **CHANGES-REQUIRED**

1. **HIGH — Default-on FAST_PULL opens a new persisted-state corruption failure class.**

   `pullWithMetadata` passes reconstructed state evidence without first hashing it ([pull.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/sync/pull.ts:90)). Exact-head evidence validates the manifest hash ([e2ee-remote.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/e2ee-remote.ts:188)), but the grown-chain path does not: it supplies the persisted `manifestHash` as `trustedBaseHash` ([e2ee-remote.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/e2ee-remote.ts:264)). `foldDelta` therefore skips recomputing the corrupted base hash when that trusted string matches the delta header ([manifest-delta.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/engine/manifest-delta.ts:487)); the eventual result-hash mismatch becomes `ManifestChainError`.

   With FAST_PULL off, the authenticated cold walk self-heals this local corruption. With it default-on, the daemon invokes chain repair, whose convergence probe cold-reads successfully, then immediately retries the same fast pull with the same corrupt evidence. That retry escapes the one-level repair catch ([daemon.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/daemon/daemon.ts:2226)). This can repeatedly wedge an otherwise healthy remote chain.

   Require either pre-hashing `fastFoldBase.manifest` before suffix admission or treating any evidence-fold failure as a cold-walk miss. Add a real-pull regression: corrupted persisted manifest + valid meta + advanced delta head must cold-walk and self-heal.

2. **MEDIUM — FAST_PULL default-on changes raw-v0 state semantics, but r2 neither acknowledges nor tests it.**

   Default-on pull sets `recordEvidence: true` ([pull.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/sync/pull.ts:97)). That forces metadata collection even when `RBOX_MDE_SNAPSHOT=0` ([e2ee-remote.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/e2ee-remote.ts:136)), and raw-v0 decoding then synthesizes `manifestMeta` ([e2ee-remote.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/e2ee-remote.ts:327)).

   Consequently, the existing mixed-fleet test’s “raw-v0 without manifest meta” expectations will invert ([e2ee-sync.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/e2ee-sync.test.ts:704)). This does not break decoding or the proposed master write policy, but it is an unreviewed behavior change and requires an explicit ruling plus test updates.

3. **MEDIUM — §7’s O16 failure discriminator is still false.**

   “Snapshot walls on EVERY push ⇒ a `deltaBase` precondition is failing” is not exhaustive. A valid `deltaBase` can be constructed and then lose the economic comparison on every push ([e2ee-remote.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/cli/e2ee-remote.ts:782)). Persistent snapshots can also be intentional under either kill switch or repair.

   The diagnostic must distinguish at least:

   - policy/master kill;
   - missing or integrity-rejected `deltaBase`;
   - force-snapshot/repair;
   - economic rejection;
   - chain-cap compaction.

4. **MEDIUM — The enforce-mode endpoint test names a response field that does not exist.**

   The endpoint returns `{ error: "unsatisfied_blobs", missing, missingTotal }`, not `unsatisfiedBlobs` ([commit-envelope.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/apps/api/src/commit-envelope.ts:31)); existing endpoint tests assert `missing` ([commit-delta-shadow.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/apps/api/test/commit-delta-shadow.test.ts:182)). Test 3 is therefore not writable exactly as specified.

   Otherwise, the regression is feasible in the current harness: it already constructs `WorkspaceSync` directly with real D1/R2 and a retained fake DO state. `testEnv` merely needs to accept `"enforce"`. Probe-over-cap requires 50,001 markers because `FENCE_SET_MAX` is 50,000, so fixture setup should use batched/bulk insertion.

5. **LOW — O15’s “fully qualified anchors” ruling was a silent no-op.**

   r2 still contains many bare anchors, including `workspace-sync.ts:1273-1300`, `push.ts:158-171`, `plan.ts:404-417`, and `e2ee-sync.test.ts:774-785`.

   There are also exact anchor errors:

   - economic guard is line 782, not 781;
   - the journal pair is `plan.ts:419-420`, not `418-419`;
   - `e2ee-remote.ts:77-83` is only a rollout-history comment, not reader-support implementation evidence.

6. **LOW — C2’s stage description is inaccurate around `plan.ts:502`.**

   The eight-call inventory is correct, but line 502 is invoked from `captureWithConfig` after repository capture at line 1000, not during a pre-capture “stage-2 decision read.” The intended design remains sound only if the memo is explicitly cleared before the capture pool and line 502 necessarily performs a post-boundary fresh derivation. State that placement directly.

Verified without additional findings:

- All round-one rulings other than O15/O16 are materially represented in r2.
- The §3.2 narrowing accurately matches current admission: prune-marked carried refs enter admission; unmarked `present=0` is missed by enforce delta admission, and the legacy branch is not `present`-aware.
- `canonicalManifestHash` exists as the Promise-returning facade at [manifest-delta.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/publish-fast-path/src/engine/manifest-delta.ts:195); the direct synchronous helper is `canonicalManifestHashStreaming` at line 96. It adds one synchronous O(manifest-bytes) canonical traversal per delta-eligible push, on top of `validateManifest`. It closes the precise A7 content-binding hole, assuming authenticated provenance of `encManifestSha` and `chain`.
- Raw-v0 remains readable by `decodeEnvelope`, historical readers, restore, and ordinary pulls. `chainDiagnostic` deliberately reports a chain-free head without fetching it, so raw-v0 does not break doctor.
- C1’s narrowed pair and eager publisher-binding/quarantine work match current `plan.ts` dependencies.