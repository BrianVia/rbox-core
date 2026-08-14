# 260 — Git state belongs to sync-git

Status: proposed for architecture-loop task #41

## 0. Yardstick

Delete the historical `cli -> engine/git` ownership seam. Generic process
primitives become `src/engine/lockfile.ts` and `src/engine/git-spawn.ts`; every
Git-state owner moves under `src/cli/sync-git/`. The engine Worker seam remains
exactly as-is: `apps/api/**` and its direct imports from Worker-safe engine
modules are untouched.

This is a location and dependency-direction change, not a new abstraction or
behavior change. Existing function bodies move verbatim except where the
required whole-file anti-slop cleanup forces a behavior-neutral type/shape
rewrite. Tests move with their modules without body edits; only their imports
and path-bearing fixture strings may change.

## 1. Protected-functionality ledger

| Contract | Owner after the change | Proof |
|---|---|---|
| Git subprocess argv, environment scrubbing, stdin/stdout streaming, max-buffer failures, observer callbacks, and thrown causes stay exact | `engine/git-spawn.ts` | moved tests + sync-git/engine suites |
| Generic advisory locks retain marker formats, liveness/incarnation decisions, no-follow observations, atomic hardlink publication, common-dir fences, and hook/crash ordering | `engine/lockfile.ts` | byte-fidelity audit + lockfile/state-plane tests |
| Capture/apply, config transactions, refs, quarantine/rollback, journals, checkout transaction, pins, P-repair, lineage, reachability, and protocol-lock behavior retain their present branches and effect ordering | individual `cli/sync-git/*` modules | moved tests, full sync-git/engine suites, typecheck |
| Existing engine barrel callers resolve the same implementations during migration | callers import the new concrete owner; `engine/index.ts` stops re-exporting CLI-owned Git state | typecheck + import census |
| Manifest/config wire shapes and Worker builds do not cross the new CLI boundary | existing Worker-safe engine owners, unchanged | `apps/api/**` has no engine/git import; API typecheck remains in `bun run typecheck` |
| Test inventory and assertions remain complete | tests move with their owner, body-identical wherever imports do not force edits | before/after test-file census and checksums |

No command, output, persisted/wire format, safety property, crash-recovery path,
compatibility path, migration/readiness path, or performance fast path is
approved for deletion. No additional Git subprocess, filesystem read, lock,
hash, traversal, cache read, or state read is introduced.

## 2. Ownership and move map

### Real primitives

- `src/engine/git/lockfile.ts` -> `src/engine/lockfile.ts`: generic
  cross-process advisory locking and lock-safety substrate. It must never know
  what a lock protects.
- The subprocess slice of `src/engine/git/shared.ts` ->
  `src/engine/git-spawn.ts`: Git process execution, environment isolation,
  streamed stdout/stdin, structured failure, observer seam, and thin Git
  execution helpers. It must never own repository state or sync policy.

The split is closed and reviewable. `git-spawn.ts` owns
`setGitSpawnObserver`, `cleanGitEnv`, `GitRunOptions`, private
`gitRawLegacy`, `GitRunResult`, private `GitLegacyFailure` and
`gitFailureOutput`, `gitStatus`, `gitRaw`, `git`, `gitWithIndexFile`, and
`gitOk`. `git-state.ts` owns every other old `shared.ts` declaration, including
`GitRepoKind`, OID constants, no-follow file reads, `warnOnce`, config parsing
and `readLocalGitConfigEntries`, `clearIndexResolveUndo`, reflog enumeration,
repo/worktree context, state-shape helpers, artifact I/O, and busy inspection.
It imports only the complete runner operations it needs from `git-spawn.ts`.

### Git-state owners

The exact exceptional moves are:

- `src/engine/git/lockfile.ts` -> `src/engine/lockfile.ts`
- `src/engine/git/lockfile.test.ts` -> `src/engine/lockfile.test.ts`
- `src/engine/git/apply.ts` -> `src/cli/sync-git/git-state-apply.ts`
- `src/engine/git/apply.test.ts` ->
  `src/cli/sync-git/git-state-apply.test.ts`
- the non-spawn remainder of `src/engine/git/shared.ts` ->
  `src/cli/sync-git/git-state.ts`
- `src/engine/git/shared.test.ts` ->
  `src/cli/sync-git/git-state.test.ts` (one import is partitioned between the
  runner and state owners; the test body stays intact)
- `src/engine/git-state.test.ts` ->
  `src/cli/sync-git/capture-identity.test.ts`
- `src/engine/git-nested.test.ts` ->
  `src/cli/sync-git/git-nested.test.ts`

Every other tracked `src/engine/git/*.ts` file—including all tests and
`v1724-journal-{fixture,writer}.test-helper.ts`—moves by identical basename to
`src/cli/sync-git/`. This rule plus the eight exceptions above exhausts the
45-file census (25 production files, 18 tests, and two test helpers); the final
report expands it into a literal old-path -> new-path table.

The collision files remain separate because merging either old `apply.ts` into
the existing 1,277-line `sync-git/apply.ts`, or old `shared.ts` into the
existing 324-line `sync-git/shared.ts`, would trip the hard size gate. No pin is
raised. Root-level Git-state tests (`engine/git-state.test.ts` and
`engine/git-nested.test.ts`) move to sync-git with collision-free names, and
the CI shard inventory follows the latter path.

`engine/index.ts` loses only re-exports whose implementation moved to the CLI.
Callers import those symbols from their concrete sync-git owner. Engine-owned
manifest/types/hash/blobstore/fs primitives remain engine exports. This removes
the upward facade dependency rather than recreating it.

## 3. Move fidelity and lint deltas

1. Record a complete source/test census, baseline oxlint counts, and hashes.
2. Extract the Git-spawn slice without altering function bodies. The remaining
   old `shared.ts` functions move into `git-state.ts`; imports are the only
   mechanical boundary edits.
3. Move every other file intact, update relative imports, and update external
   callers. Do not merge modules merely to reduce file count.
4. Run whole-file anti-slop cleanup on substantively changed production files.
   Each change must be a type/shape restructuring with the same branches,
   evaluation order, error text, and effects; never suppress a rule. Moved tests
   retain their bodies and are import/path-only exempt.
5. Compare moved function bodies after normalizing imports and approved lint
   deltas. Any logic delta outside the lint ledger stops the change.

The implementation baseline is captured per file immediately before edits;
round-1 review measured 185 production warnings plus 17 test warnings. This
task burns production warnings down rather than grandfathering them. Moved test
bodies remain byte-identical and their import/path-only changes retain the
explicit lint exemption; their warning counts are still reported before/after.

## 4. Safe deletion and ceremony kill

After imports, builds, tests, and inventories prove the move:

- delete the old `src/engine/git/` CODEMAP heading and all 25 old-path entries;
  to satisfy the repository's current ownership-map rule, record the two real
  primitives in the engine section and the moved Git-state owners in the
  existing sync-git section. This is explicitly transitional ceremony until
  the architecture-loop capstone deletes CODEMAP, but it must describe the
  current tree meanwhile;
- re-key every still-needed `src/engine/git/*` size allowlist and ratchet entry
  to its new path with an equal or smaller measured ceiling. This preserves the
  active size safety rule; it is not an upward re-pin. Delete an entry only when
  the moved/split file naturally clears both hard limits;
- remove the engine-index Git-state export blocks and any path freeze/guard or
  CI-shard key that names an old path. Active guards are re-keyed, not weakened:
  `base-composer-structure.test.ts` retains identical raw-update-ref counts at
  new paths, and `scripts/ci-shard-tests.ts` retains the nested-test split and
  weights at its new path;
- remove the `engine/index.ts` size pin too if the barrel naturally clears both
  hard limits after those exports disappear.

Live imports in `scripts/rig/lib/git-fixtures.test.ts`, the guest import in
`scripts/rig/scenarios/git-shapes.ts`, and `scripts/bench/state-plane.ts` move
to the new owners. The synthetic `scripts/guards.test.ts` old-path fixture is
not a live import and remains unchanged. Historical documentation and
version-labelled fixture comments are evidence,
not live guards; they retain old release paths unless they describe the current
tree. Tests are never deleted.

## 5. Requirement challenges

| Requirement | Complexity cost | Evidence | Decision |
|---|---|---|---|
| Preserve `engine/index.ts` as a Git-state compatibility facade | Recreates an engine -> CLI cycle or leaves the false seam | private package; all live imports are repository-controlled | remove only Git-state exports and rewrite live callers |
| Merge collision files for fewer files | Produces giant mixed owners and violates the hard gate | measured 1,277+786 and 324+790 lines | keep separate, explicitly named modules |
| Keep engine/git size pins under dead paths | Dead path ceremony, but the size rule itself is active | moved large files still exceed a hard band | re-key equal/lower ceilings; delete only naturally cleared entries |
| Rewrite old release-path comments | Destroys compatibility/fixture provenance | v1.7.24 fixture comments intentionally name historical source | preserve historical references |

No unsupported feature retirement or test deletion is authorized.

## 6. Validation

- Differential/move fidelity: before/after file census, function-body audit,
  unchanged test bodies, no new subprocess/filesystem/lock effects.
- Crash and compatibility: existing journal, checkout, lockfile, protocol-lock,
  P-repair, state-plane, and sync-git tests run unmodified in semantics.
- Performance: import-only relocation; no new Git commands or state reads.
- Boundary/guard census: `rg 'engine/git' apps/api` stays empty;
  `base-composer-structure` counts stay identical; the CI-shard guard passes
  with the nested test's existing split/weight under its new path.
- Required gates with recorded exit codes: `bun run typecheck`;
  `bun test src/cli/sync-git src/engine` (per-file fallback only if the guard
  refuses); `bunx oxlint --config .oxlintrc.json` on every touched file;
  `bun run lint:affected`; `git diff --check`;
  `bun test src/cli/state-plane/file-size.test.ts`; and
  `bun test src/cli/state-plane/duplicate-declarations.test.ts`.
- Non-unit validation: run `bun run rig` and record its exit code. If the local
  Docker/runtime environment cannot start the rig, report that environmental
  blocker explicitly rather than weakening or substituting unit coverage.
- Adversarial review is capped at three rounds and at least one round executes
  code/tests. A round-three structural disagreement stops for founder choice.
