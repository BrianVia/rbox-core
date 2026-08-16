# Verdict: CHANGES-REQUIRED

No CRITICAL findings. Three MAJOR contract/test failures block alignment.

## Findings

1. **MAJOR — Push-conflict recovery is not structurally receipt-less.**

   Both recovery paths call generic `pull()` at [push.ts:411](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:411) and [push.ts:834](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:834). That reaches `pullWithMetadata`, whose normal branch unconditionally sets `elisionEligible: true` at [pull.ts:114](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/pull.ts:114), allowing receipt minting at [pull-state-save.ts:48](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/pull-state-save.ts:48).

   This directly violates §3.0’s explicit recovery-adoption prohibition. It is not merely theoretical: unchanged repository records can elide even when `noActions=false`, attaching `elisionExpectation` to content-carrying recovery pulls.

   The provenance test is misleading: [save-elision.test.ts:497](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:497) manually supplies `elisionEligible: false` instead of exercising either real recovery path.

2. **MAJOR — The required `encSha`-only corruption regression is not present.**

   The helper at [save-elision.test.ts:38](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:38) does not set `encSha`. The alleged drift at [save-elision.test.ts:297](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:297) replaces seed `2` with `9`, changing plaintext `sha256`, `size`, and `mtimeMs`; it also never warms the fold cache.

   A regression that stopped binding `encSha` while still binding those other fields would pass this test. The design’s central r1 counterexample therefore remains unpinned.

3. **MAJOR — No fixture proves the exact `manifestFromMeta` operand.**

   Production correctly hashes:

   `canonicalManifestHashStreaming(manifestFromMeta(snapshot.lastSyncedManifest, persisted))`

   at [sync-state-elision.ts:69](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-elision.ts:69).

   But every test manifest has no Git section and every meta uses `gitRepos: {}` at [save-elision.test.ts:51](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:51) and [save-elision.test.ts:56](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:56). Thus hashing the raw persisted manifest is observationally identical throughout the suite. The mandated pending/local-Git divergence regression is missing.

4. **MINOR — The “red-first” claim is unsupported.**

   [save-elision.test.ts:165](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:165) removes provenance and verifies the old full-save behavior, so it passes before and after M1. Git history also places implementation commit `2d8e71625` before test commit `3981c4a05`; there is no checked-in red-first evidence.

5. **MINOR — The reset-migration empty-packet pin is missing.**

   The new suite tests lineage initialization at [save-elision.test.ts:506](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:506), but not the nonce-less reset migration at [reset-state.ts:434](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/reset-state.ts:434), despite §7/SPEC requiring both.

6. **MINOR — Ownership and acceptance gates are stale.**

   - [CODEMAP.md:250](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/CODEMAP.md:250) still says `whole-state-compat.ts` owns CAS-result translation, although ownership moved to the new `cas-translation.ts`. The new `pull-state-save.ts` module is also absent from the map, contrary to the repository’s same-PR ownership rule.
   - [save-elision.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:520) is 520 lines, violating SPEC’s 500-line ceiling.
   - `bun run lint:affected` reports 52 anti-slop warnings across touched files; SPEC requires zero.

## Contract audit

- **§3.2 predicate:** aligned in production. All four conditions are present, including unfiltered action emptiness, remote-base/meta identity, exact sequence equality, and the correct reconstructed-manifest hash operand. I found no real pull path where the global predicate passes with a required condition false.
- **§3.2b CAS:** aligned. SQLite checks the expectation inside `BEGIN IMMEDIATE` at [write-packet.ts:249](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:249) through [cas-steps.ts:86](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:86). JSON checks its under-lock reload at [legacy-json-store.ts:99](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/legacy-json-store.ts:99).
- **Rejection mapping:** aligned. `elision-drift` remains distinct from the terminal `state-revision → nonce` translation.
- **Receipt consumption:** aligned. [sync-state.ts:416](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:416) removes the receipt before retry. Drift can waste at most one attempt; there is no stale-receipt retry loop.
- **Concurrency:** content-carrying pulls commonly carry expectations because unchanged repos elide independently. One drift reduces the three-attempt budget to two. Exhaustion would require two further accepted mutations; current mutex serialization and ordering make that unlikely in normal single-daemon operation, and I found no deterministic daemon loop.
- **M2:** aligned. Projection is supplied only for an empty, expectation-bearing packet at [sync-state.ts:337](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:337). SQLite overlays lineage extras plus stream, sequence, nonce, revision, and telemetry binding at [sqlite-state-save.ts:70](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/sqlite-state-save.ts:70). All other acceptances and every rejection retain read-back.
- **Other fail-closed paths:** degraded, chain repair, resolution reconciliation, and unchanged direct packet callers are receipt-less. Push-conflict recovery is the exception and blocker.
- **Protected contracts:** digest grammar, stage lifecycle, deletion-path hash, Darwin pragmas, and direct empty-packet implementation were untouched.
- **Test honesty:** stale-receipt uses an accepted no-op interleave and proves attempt two is receipt-less/full. SQLite uses `toStrictEqual` against durable reload on ordinary, content-interleaved, stale-receipt, and telemetry paths.

## Validation

- `bun run typecheck`: passed.
- `bun test src/engine/manifest-delta.test.ts`: 18 passed.
- Focused elision suite: two pure tests passed; 18 filesystem-backed tests could not run because this review sandbox makes `/tmp` read-only (`mkdtemp` returned `EROFS`). This is an environment limitation, not an implementation failure.
- No deletion or protected-contract retirement is approved.