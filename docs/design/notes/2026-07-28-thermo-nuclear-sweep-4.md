# Thermo-nuclear sweep #4 — 2026-07-28 (the pre-U3 gate)

> Reviewer: codex gpt-5.6-sol, read-only, exclusion-listed against sweeps #1-#3
> and today's unit review histories. Verdict: NO-GO for U3 dispatch until the
> four Tier 0 gates close. T0.1 (opus) and T0.2-T0.4 (codex) dispatched
> 2026-07-28 late evening. Tier 1 is the U3 implementation blueprint.

Verdict: **NO-GO for U3 dispatch.** The substrate is broadly sound, but four Tier 0 gates are open—two semantic state-plane mismatches and two CI/regression gaps. The queued U3 adapter extraction is also now capacity-critical.

I did not re-derive the four excluded sweeps or re-audit U1/U2 internals. Where prior work was queued, this converts it into an ordered move list.

## Tier 0 — fix before U3 dispatch

### T0.1 Ordinary writes currently depend on migration-only BASE authority

Evidence:

- `StateSource.repoProofs` and `RepoTransition.baseProof` remain optional: [sync-state.ts:85](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state.ts:85), [sync-state-model.ts:322](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-model.ts:322).
- Missing proofs become `migrationRepoBaseProof()` while composing both the record and packet: [sync-state.ts:221](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state.ts:221), [sync-state.ts:280](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state.ts:280).
- The JSON writer repeats that fallback: [sync-state-store.ts:173](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:173).
- U1b correctly reserves migration authority for a tagged importer: [transition-admission.ts:32](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/transition-admission.ts:32); ordinary stages default to `importer:"engine"` at [transition-stages.ts:87](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/transition-stages.ts:87).
- Missing proof is exercised by live composition behavior, not hypothetical: [origin-retention.test.ts:24](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-git/origin-retention.test.ts:24).

As written, U3 must either reject writes JSON accepts or tag ordinary engine traffic as migration and launder blanket authority.

Executable plan:

1. Add one proof-selection helper beside `base-composer.ts`:
   - supplied purpose-bound proof → use it;
   - byte-semantically unchanged BASE/origins → derive `carryRepoBaseProof` from retained lineage;
   - changed BASE/origins without proof → throw `ProoflessBaseError`.
2. Use it in `sourceRecord`, `composeStateSavePacket`, published-intent recovery, and the JSON CAS.
3. Make every producer changing BASE/origins supply `repoProofs`.
4. Add an inventory contract: no ordinary `StateSavePacket` contains `authority.kind === "migration"`.
5. Allow migration authority only from `migration/import-json.ts`.

Blast radius: state composition plus pull/push/apply producers; no SQLite schema change.

### T0.2 SQLite wrong-stream reads manufacture genesis, and a test pins that bug

Evidence:

- The live contract says every different-stream read is a typed refusal: [sync-state-store.ts:294](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:294), with the throw at [sync-state-store.ts:337](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:337).
- SQLite instead returns a fresh empty baseline: [read-only.ts:125](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/adapters/read-only.ts:125).
- The substrate test explicitly expects that unsafe behavior: [substrate-integration.test.ts:47](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/substrate-integration.test.ts:47).
- The policy-shaped wrapper is otherwise unwired: [ports.ts:97](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/ports.ts:97), [read-only.ts:131](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/adapters/read-only.ts:131).

Executable plan:

1. Delete `loadStateFromStore(expectedStream)`, `StateStoreReadAdapters`, and `readOnlyAdapters`; retain raw/cursor/materialization primitives.
2. Move `StreamMismatchError` to `state-plane/errors.ts`.
3. Put stream checking, reset recovery, and reset-lineage provenance solely in `adapters/whole-state-compat.ts`.
4. Replace the pinned-empty assertion with JSON-versus-SQLite differential tests for exact error class/streams and absence of a manufactured baseline.

Blast radius: the unwired read adapter and future U3 dispatcher. Without this, a post-flip configuration mismatch becomes a destructive empty reconcile base.

### T0.3 The script type gate is both blind and currently red

Today’s #560→#565 interaction escaped because the TUI scripts importing the renamed rig helper have no static typecheck owner.

Evidence:

- Root TypeScript includes only `src`: [tsconfig.json:15](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/tsconfig.json:15).
- The rig project includes only `scripts/rig`: [scripts/rig/tsconfig.json:6](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/rig/tsconfig.json:6).
- Both unchecked TUI entrypoints import the rig binary resolver: [tui-compiled-smoke.ts:5](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/tui-compiled-smoke.ts:5), [tui-performance-budget.ts:6](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/tui-performance-budget.ts:6).
- Ordinary CI runs only root+API typecheck: [ci.yml:181](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/.github/workflows/ci.yml:181).
- `bun run typecheck:rig` currently fails at [worktree-squash-lifecycle.ts:235](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/rig/scenarios/worktree-squash-lifecycle.ts:235): the conditional object infers optional `undefined` fields incompatible with `Record<string,string>`.

Executable plan:

1. Fix the environment object by explicitly constructing a `Record<string,string>`.
2. Add `scripts/tsconfig.json` covering rig production sources and both TUI entrypoints.
3. Replace the orphan `typecheck:rig` command with `typecheck:scripts`.
4. Make ordinary `bun run typecheck` and the required CI check invoke it before compiled jobs.

Blast radius: scripts, package commands, and CI only. This is load-bearing because U3 next modifies the dual-binary rig surface.

### T0.4 Remove the stale TUI exit-code waiver

Evidence:

- The performance probe accepts both exit 0 and 1 for outside-workspace `status`: [tui-performance-budget.ts:13](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/tui-performance-budget.ts:13), applied to both workloads at [line 22](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/tui-performance-budget.ts:22).
- #498 (`5720f852`) is already an ancestor of HEAD.
- CI builds the baseline from the PR base/previous commit, not an old released binary: [ci.yml:445](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/.github/workflows/ci.yml:445), [ci.yml:458](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/.github/workflows/ci.yml:458).

Executable plan: require literal exit `0` for `status` and `status --json`, delete the transition constant/comment, and run the compiled TUI performance lane.

Blast radius: one performance probe. It restores detection of outside-workspace status regressions.

## Tier 1 — structural moves before U3 lands

### T1.1 Land the compatibility boundary in this order

`sync-state-store.ts` grew from 460 to 506 lines today—the only new production crossing of 500—and still owns path policy, reads, JSON CAS, whole writes, telemetry, and reset installation: [paths/read start](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:48), [CAS](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:131), [telemetry/reset tail](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:428).

Move sequence:

1. `state-plane/paths.ts`
   - Centralize legacy authority/lock, SQLite authority/lock, incarnation, migration-control/staging, and Q-sibling paths.
   - Today these are split between [sync-state-store.ts:48](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-store.ts:48) and [reset/artifacts.ts:26](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/reset/artifacts.ts:26).

2. `adapters/legacy-json-store.ts`
   - Move raw JSON access, JSON CAS, unsafe whole writes, telemetry mutation, and incarnation publication.
   - Keep public signatures in a thin `sync-state-store.ts` facade.

3. `store/owner-token.ts`
   - Add a private, branded `CasOwnerToken` derived from the exact held `OwnedLock`.
   - The current lock can only check asynchronously at [lockfile.ts:1331](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/engine/git/lockfile.ts:1331), while SQLite checks synchronously both before writes [cas-steps.ts:68](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/cas-steps.ts:68) and immediately before commit [write-packet.ts:252](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/write-packet.ts:252).
   - Add a no-follow synchronous observation method to `OwnedLock`; keep the CLI token factory in state-plane so engine does not import CLI types.

4. `adapters/sqlite-state-save.ts`
   - Build sealed global/transition stages, apply native CAS, and own stage cleanup.

5. `adapters/whole-state-compat.ts`
   - Sole JSON/SQLite authority selection.
   - Shared load/reset/provenance semantics.
   - Exhaustive raw `CasResult` translation.
   - SQLite adds four rejection reasons and returns a bounded retry view rather than whole state: [ports.ts:66](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/ports.ts:66), versus the legacy union at [sync-state-model.ts:340](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state-model.ts:340). Existing callers distinguish fatal incarnation loss from recomputable drift: [sync-state.ts:340](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-state.ts:340), and deferral hygiene consumes the rejected winner state: [deferral-hygiene.ts:450](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/sync-git/deferral-hygiene.ts:450).
   - Materialize against the retry view’s exact token, close the view, and test every raw reason. Do not widen `StateSaveResult`.

Blast radius: state persistence internals and differential tests; all current callers retain signatures.

### T1.2 Split schema installation from store creation before writing the importer

Evidence:

- `createStateStore` only creates genesis and directly calls `applySchemaV1`: [open.ts:208](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/open.ts:208).
- `applySchemaV1` combines DDL, genesis rows, and a genesis completion row: [application.ts:21](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/schema/application.ts:21).
- U3 requires migration completion to be inserted last in the same transaction as imported rows: [design 163:2647](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/design/163-state-plane-sqlite.md:2647).

Executable plan:

- Split behavior-free DDL application from `installGenesisLineage`.
- Add one claimed-file initializer in `store/open.ts` owning exclusive create, pragmas, cleanup, validation, and handle construction.
- Keep `createStateStore` as the genesis wrapper.
- Let `migration/import-json.ts` run its import transaction through the initializer and write `migration_completion` last.

Blast radius: store creation, schema tests, reset seed creation, and importer only.

### T1.3 Split M0–M7 before implementation

The design’s original three-file migration target is too coarse. The protocol has eight witness shapes [design 163:2663](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/design/163-state-plane-sqlite.md:2663), a revision-CAS publication protocol [line 2679](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/design/163-state-plane-sqlite.md:2679), and an independent M6 cleanup machine [line 2783](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/design/163-state-plane-sqlite.md:2783). The analogous reset controller is already 471 lines, while design 163 hard-fails production files at 400: [line 3994](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/design/163-state-plane-sqlite.md:3994).

Land:

- `migration/control-codec.ts` — closed 64 KiB union.
- `migration/control-publication.ts` — sole revision-CAS/fsync/rename/reread.
- `migration/classifier.ts` — read-only artifact/control matrix.
- `migration/admission.ts` — M0/M1 exclusivity, B0, and reset predicates.
- `migration/import-json.ts` — M2–M4 backup/import/digest round trip.
- `migration/finalize.ts` — M5 and Q-sibling construction/flip.
- `migration/retirement.ts` — source-change C1.
- `migration/cleanup.ts` — M6 cursor/runway and M7.
- `migration/authority.ts` — orchestration over typed phase receipts only; no filesystem primitives.

Blast radius: new U3 code plus required CODEMAP/inventory entries.

### T1.4 Add the missing Git-section codec and authority-row corruption error

There are zero production `any` escapes in state-plane, but 24 `as unknown as` casts. FileEntry/RepoRecord casts re-enter validators; GitSection does not.

Evidence:

- Canonical parsing validates spelling only: [digest/codecs.ts:43](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/digest/codecs.ts:43).
- Stage input accepts unchecked path/section: [generations.ts:107](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/generations.ts:107).
- Sealed and authority reads cast directly: [sealed-stages.ts:188](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/sealed-stages.ts:188), [read-snapshot.ts:203](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/read-snapshot.ts:203).
- The canonical semantic validator already exists: [manifest-validate.ts:137](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/engine/manifest-validate.ts:137), and RepoRecord uses it correctly: [repo-record.ts:117](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/codecs/repo-record.ts:117).

Executable plan:

- Add `codecs/git-section.ts` for safe path, semantic shape, canonical encoding, and byte accounting.
- Route builder, sealed-stage, and authority reads through it.
- Caller malformation → `TypeError`; sealed mutation → `StageChangedError`; bad authority row → new `StateDataCorruptionError(entity,key,cause)`.
- Wrap FileEntry/RepoRecord authority decoding in the same corruption taxonomy.

Blast radius: state persistence decoding only; no wire or Git execution changes.

### T1.5 Extract state-plane doctor policy before adding fifteen migration halts

Today’s reserve merge grew `doctor-cmd.ts` past 1,000 lines and required changes in the checker, positional `Promise.all`, result object, and render list: [check](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/doctor-cmd.ts:401), [tuple](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/doctor-cmd.ts:725), [render](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/doctor-cmd.ts:882). U3 adds roughly fifteen halt classes with human and machine copy: [design 163:4482](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/design/163-state-plane-sqlite.md:4482).

Executable plan:

- `migration/health.ts`: closed `MigrationHaltCode`/health union.
- `doctor-state-plane.ts`: current state/reserve checks plus exhaustive `satisfies Record<MigrationHaltCode,...>` human and machine mapping.
- Replace doctor’s positional arrays/key lists with named check descriptors.
- Keep `doctor-cmd.ts` orchestration/rendering only.

Blast radius: doctor and migration health contracts; no persistence changes.

## Capability decision

Do not create a generic capability framework before U3.

- Entry arena’s WeakMap/lexical colocation protects isolate-local object construction and lifetime: [owner.ts:1](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/engine/entry-arena/owner.ts:1).
- U2’s hidden lexical token protects completeness and reachability of the reset executor set: [reset/owner.ts:49](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/reset/owner.ts:49), [line 66](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/reset/owner.ts:66). U3 should consume `sqliteResetFacade` directly.
- U1b’s StageLock/anonymous-inode containment protects filesystem identity intervals: [stage-artifacts.ts:66](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/stage-artifacts.ts:66), [line 211](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/cli/state-plane/store/stage-artifacts.ts:211). Reuse it for compatibility packet stages.

The only pre-U3 convergence needed is shared vocabulary—mint site, authentication, lifetime/revocation—and the concrete `OwnedLock`→`CasOwnerToken` bridge.

## Tier 2 — queued

- Do not split the 495-line entry-arena owner: colocation is its invariant. Delete only the genuinely dead `OwnerHandle.token` and `ownerId`, declared at [owner.ts:393](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/engine/entry-arena/owner.ts:393) and stored at [line 448](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/src/engine/entry-arena/owner.ts:448).
- Split `credentials.test.ts` (1,003 lines) by marker/fence protocol and `cas-operations.test.ts` (689 lines) by admission, ownership, retry, and cleanup contracts. Test-only blast radius.
- No new state-plane feature flag was found; the read adapter is pre-U3 dead policy, handled by T0.2.
- Do **not** add generic timer-suite shard pinning. FLAKE-006 was a real lstat/open product race: [flaky-tests.md:91](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/docs/flaky-tests.md:91). CI already has process anti-affinity [ci-shard-tests.ts:51](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/ci-shard-tests.ts:51) and weighted placement [line 196](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-4/scripts/ci-shard-tests.ts:196). Continue using injected clocks and causal gates; add anti-affinity only after measured resource contention.

## Validation

- Root TypeScript: passed.
- API TypeScript: passed.
- Shard guard: passed — 339 files, 358 runtime units, six shards.
- Two pure BASE-proof composition tests: passed.
- Rig TypeScript: failed at the Tier 0 scripts issue above.
- Filesystem-backed state-plane tests could not create `/tmp` workspaces because this environment is read-only (`EROFS`); those attempts were not counted as product failures or green evidence.
- No residual defect was found in the repaired #557×#558 interaction or U2 narrowing. The #560×TUI class remains structurally open through T0.3.