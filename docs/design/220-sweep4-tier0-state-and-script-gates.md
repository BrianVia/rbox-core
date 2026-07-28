# design 220 — Sweep 4 Tier-0 state and script gates

Status: revised after adversarial review round 1

## Scope

Resolve `SWEEP-FINDINGS.md` T0.2, T0.3, and T0.4 only. T0.1 is being
implemented independently, so this change must not edit `sync-state.ts`,
`sync-state-model.ts`, or `sync-git/base-composer*`.

## T0.2 — remove the false SQLite whole-state policy

The SQLite substrate exposes raw state projection, cursors, and manifest
materialization. It must not expose a second, unwired interpretation of
`loadState(root, expectedStream)`. Delete:

- `loadStateFromStore(expectedStream)`
- `readOnlyAdapters`
- `StateStoreReadAdapters`

Keep `loadRawStateFromStore`, `materializeManifestFromStore`, and the cursor
interfaces. Remove the deleted exports from `store-facade.ts`.

Move `StreamMismatchError` from `sync-state-store.ts` to
`state-plane/errors.ts`, preserving its public constructor, fields, name, and
message. `sync-state-store.ts` imports, uses, and explicitly re-exports that
class so `config.ts` can retain its existing stable re-export.

Replace the substrate assertion that expects a fabricated empty state with an
honest JSON/SQLite differential over a realistic, non-empty authority:

1. Persist equivalent authority for stream `observed` in legacy JSON and
   SQLite, including nonzero sequence plus non-empty manifest/repository
   witnesses.
2. Exercise real JSON `loadState(root, expected)` and assert its typed
   `StreamMismatchError` fields.
3. Read SQLite only through `loadRawStateFromStore`; assert it retains the
   observed stream, sequence, manifest, and repository witnesses unchanged and
   cannot return an expected-stream genesis.
4. A clearly test-only backend-neutral translator may turn the observed SQLite
   mismatch into the stable error for exact class/stream/message parity. The
   test must label that assertion compatibility-boundary contract evidence,
   not a production SQLite expected-stream read.
5. Add compile-time/runtime surface assertions that
   `loadStateFromStore`, `readOnlyAdapters`, and `StateStoreReadAdapters` remain
   absent after deletion.

Production SQLite remains policy-free until the real whole-state compatibility
adapter is wired; removing and guarding the unsafe expected-stream API makes
fabrication unavailable in production.

## T0.3 — make production scripts a required TypeScript project

At `worktree-squash-lifecycle.ts`, construct `env` as an explicit
`Record<string, string>` and assign the direction-specific concurrency key
imperatively. This prevents the conditional-object union from introducing
optional `undefined` values.

Add `scripts/tsconfig.json`, extending the root config and including:

- `rig/**/*.ts`
- `tui-compiled-smoke.ts`
- `tui-performance-budget.ts`

Exclude `rig/**/*.test.ts`, `rig/runs/**`, and `rig/cache/**` explicitly.
Delete the superseded `scripts/rig/tsconfig.json` so there is one owner and no
drifting second project.

Replace `typecheck:rig` with `typecheck:scripts`. Make root `typecheck` invoke
the root project, API project, and scripts project. Keep the CI checks job
calling `bun run typecheck`, and rename its label to state all three owners
explicitly so omission is visible in review.

## T0.4 — retire the outside-workspace transition waiver

Delete `OUTSIDE_WORKSPACE_STATUS_EXIT` and its transition comment. Give both
`status` workloads literal `expectedExit: 0`. Simplify `measure` to accept one
number and report one expected value; no workload needs a set-valued exit
contract.

## Validation

- `bun run typecheck`
- `bun test src/cli/state-plane/`
- `bun scripts/tui-compiled-smoke.ts` and
  `bun scripts/tui-performance-budget.ts` reach their usage/help-level parsing
  with no import or parse failure
- If usable baseline and candidate binaries can be built locally, run
  `bun run tui-budget <baseline> <candidate>`; otherwise record the concrete
  environmental or artifact blocker
- Diff-scoped simplification and forbidden-file audit
- Stage only named implementation/design/review files; leave
  `SWEEP-FINDINGS.md` unstaged

## Rollback and risk

The only state behavior removed is an unwired API whose mismatch branch was
unsafe. The stable JSON error surface is preserved. Script-gate changes can
increase CI failures only by exposing existing production-script type errors,
which is the intended fail-closed behavior.
