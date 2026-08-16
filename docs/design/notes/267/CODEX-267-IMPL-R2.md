# Verdict: CHANGES-REQUIRED

The production elision/retry mechanism is now structurally sound, and all four opus majors are closed in code. However, the branch does not yet satisfy the complete review contract: the AST sweep introduces a real production escape hatch, the required warmed-fast-fold `encSha` regression remains absent, and several acceptance claims remain untrue.

## Blocking findings

1. **MAJOR — `.test-helper.ts` is now an unguarded escape from the design-130 authority sweep.**

   [base-composer-ast-sweep.mjs](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-git/base-composer-ast-sweep.mjs:211) excludes every `*.test-helper.ts` based only on its filename. Nothing prevents production code from importing such a file: [tsconfig.json](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/tsconfig.json:13) includes all of `src` and excludes only `*.test.ts`, while the release bundler follows imports from the CLI entry point.

   The current helpers are genuinely test-only—I found no production importer—so removing `v1724-journal-fixture.test-helper.ts` does not change present runtime behavior. But the closed allowlist can now be bypassed by placing `update-ref`, BASE mutation, or state-plane operations in a file with that suffix and importing it from production.

   The simplest safe fix is to revert this exclusion and restore the fixture’s explicit allowlist row. Alternatively, add a production-entry-graph gate proving no production module can import or re-export `*.test-helper.ts`.

2. **MAJOR — R1 finding 2 is only partially closed: the `encSha` drift is isolated, but the required warmed fast-fold cache is still not exercised.**

   [save-elision.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:156) now correctly changes only `encSha`; every other file field remains equal, and the full save heals it. Production’s direct reconstructed-manifest hash is also correct.

   But the fixture seeds SQLite directly and manually supplies the receipt/meta. It never runs through a warmed `E2eeRemote.latest()` fast-fold/cache path. The real-pull provenance fake likewise ignores `LatestOptions`, so it does not close that portion of R1 or design §7. Add one real warmed-fold regression where cached remote evidence remains unchanged while durable `encSha` alone drifts.

3. **MAJOR — the primary performance acceptance evidence is absent.**

   The minimal-packet benchmark is honest, but it measures only `applySavePacketToStore`. Design §7 explicitly says the field trace is authoritative and requires desktop zero-change pull/push plus Mac one-blob before/after numbers to be appended at [design 267](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:395). No results are present, so the sub-second objective is not yet demonstrated.

## R1 closure ledger

| R1 finding | Status | Evidence |
|---|---|---|
| 1. Push recovery could mint receipts | **Closed** | Both real push recovery arms pass `"recovery"` at [push.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:413) and [push.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:836). Direct `applyPulledManifest` callers default to recovery at [pull.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/pull.ts:451). |
| 2. `encSha` regression inadequate | **Partially closed** | Drift is now `encSha`-only and heals, but no warmed fast-fold/LRU path is exercised. |
| 3. Exact `manifestFromMeta` operand unpinned | **Closed** | The fixture creates meta-wire Git/local-projection divergence, asserts the raw/reconstructed hashes differ, and still elides at [save-elision.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:187). |
| 4. Red-first claim unsupported | **Not closed** | History still places implementation `2d8e71625` before tests `3981c4a05`; the test labelled “red-first” at [save-elision.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision.test.ts:22) characterizes the receipt-less path and would pass before M1. Rename/amend the claim or provide honest mutation/revert evidence. |
| 5. Reset-migration pin missing | **Closed** | The nonce-less empty-packet migration now verifies nonce mint, exactly one revision advance, and equality of all other state at [save-elision-races.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/save-elision-races.test.ts:263). |
| 6. Ownership/file-size/lint gates | **Partially closed** | CODEMAP ownership is corrected and all new split files are below 500 lines. However, `bun run lint:affected` still reports three warnings at [sync-state-model.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:135), [sync-state-model.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:283), and [sync-state-model.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-model.ts:321). They are compatibility-bound durable field names, but the contract says zero warnings in every touched file. Amend that gate explicitly rather than claiming it passed. |

## Four opus majors

All four are genuinely closed in production code:

- **Stale receipt after any rejection:** `receiptBoundTo` compares the original nonce/revision against every recomposition snapshot at [sync-state-elision.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state-elision.ts:54). The rejection handler no longer owns receipt consumption.
- **Push-recovery provenance:** explicit `standalone | recovery` provenance is carried through the pull path, with both push recovery sites named.
- **Repo elision gated to global proof:** repo transitions are elided only when `proven`—the successful global proof—is present at [sync-state.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:300).
- **Projection verified by adapter:** `translateCasResult` independently requires an expectation, no global, and zero repo transitions before using `acceptedProjection`; every other accepted result reads back at [cas-translation.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/cas-translation.ts:38).

## Structural receipt retry

The standing retry works after deletion of the special-case handler:

1. The adapter samples the live SQLite token under the state lock.
2. An accepted interleaving save has advanced the live revision, while the packet retains the receipt’s original revision.
3. The normal live-token predicates pass, then the receipt predicate rejects as **`elision-drift`** at [cas-steps.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/cas-steps.ts:89). Legacy JSON returns the same reason at [legacy-json-store.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/legacy-json-store.ts:113).
4. Translation preserves `elision-drift`; it is not folded into terminal `nonce`.
5. [saveStateSource](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:390) treats only `stream`, `nonce`, and `owner-lost` as terminal. Thus `elision-drift`, `repo-generation`, and `global-sequence` all take the standing retry.
6. Recomposition against `result.state` fails `receiptBoundTo`, producing the full packet without rebinding the proof.

That behavior is correct in code, not dependent on the old special-case branch.

## Other requested second opinions

- **`sync-mutex.test.ts` pin:** net stricter. The generic forwarding regex is individually broader than the old exact `toContain`, but the added exact-count-two assertion at [sync-mutex.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-mutex.test.ts:238) requires both recovery calls to have the complete provenance argument. The combined gate is stronger.
- **Real-pull provenance test:** sound and materially better than the old hand-built input. It distinguishes outcomes using durable BASE generation and verifies the save still advances revision.
- **Test split:** coherent by responsibility, and the helper is genuinely test-only today. The problem is solely the global AST exclusion described above.
- **`jsonRoundTrip` bounding:** sound. It removes exactly JSON-inexpressible `undefined` members, then uses strict deep equality; it does not broadly loosen semantic comparison.
- **Lint refactors:** `jsonText/jsonObject/jsonCounter`, repo sanitation extraction, and statement-ordered record construction appear behavior-preserving. No suppressions, unsafe casts, or protected stage-lifecycle changes were introduced.
- **Protected contracts:** stage grammar, artifact consume/delete hashing, Darwin pragmas, `BEGIN IMMEDIATE`, `synchronous=FULL`, accepted-save revision advancement, empty-packet lineage initialization, and legacy housekeeping remain intact. No deletion or retirement is approved.

## Validation

- `bun run typecheck`: passed.
- `bun test src/engine/manifest-delta.test.ts`: 18 passed.
- Pure receipt-identity test: passed.
- `bun run lint:affected`: exited successfully but emitted the three warnings above.
- Filesystem-backed focused tests could not execute in this review sandbox because `/tmp` is read-only (`EROFS`); this is environmental, not a test failure.
- The AST child also could not run here because TypeScript’s sync channel could not acquire its expected pipe.
- `git diff --check` reports two extra EOF blank lines in `docs/papercuts.md` and `whole-state-compat.ts`.

The core implementation is close and the concurrency model is now correct, but the unguarded structural-gate exclusion plus the two missing acceptance proofs prevent `ALIGNED`.