# Design 229: Ban unbounded unknown records with Oxlint

## Status

Implemented. The founder explicitly waived the usual arbitrage loop for this
tooling migration.

## Problem

The repository has no root lint command. It currently contains 387
`Record<string, unknown>` references in 162 TypeScript files. That type erases
both the key vocabulary and value domain while still looking more precise than
`unknown`, so it tends to spread validation and casts across callers.

The desired end state is a hard Oxlint error for the exact instantiated type,
with no suppressions, aliases, spelling substitutions, or baseline that lets
the same semantics survive under another name.

## Protected-functionality ledger

This is a type/tooling migration. It must preserve:

- every CLI, daemon, HTTP, worker, rig, and script command and output;
- persisted state, manifest, journal, diagnostic, telemetry, and wire formats;
- validation strictness for untrusted JSON and database rows;
- crash recovery, migration/readiness, and compatibility paths;
- performance fast paths and current build/package inventories;
- the existing `test`, `typecheck`, `guards`, mutation-gate, Workers, and rig
  entry points.

No runtime branch, protocol, format, command, or compatibility path is approved
for removal or retirement by this design.

## Ownership and migration rules

Oxlint owns the syntactic invariant: source code must not instantiate
`Record<string, unknown>`. The Module that consumes a value continues to own
its semantic validation and domain shape. The linter must never become a
runtime validator.

Each violation is migrated according to what the value actually represents:

1. **Closed application shape:** introduce or reuse a named interface/type with
   only the fields the Module consumes or emits.
2. **Untrusted boundary:** accept `unknown`, narrow to a closed shape at the
   owning boundary, and keep property access behind that narrowing.
3. **Arbitrary JSON object:** use a shared recursive `JsonValue`/`JsonObject`
   type only when the contract truly allows arbitrary JSON. This retains an
   unbounded key set but constrains values to the wire/storage domain.
4. **Typed dictionary:** use `Record<Key, Value>` with a meaningful key or
   value domain.
5. **Test fixture/override:** type the fixture from the production contract
   (`Partial<T>`, a request/response type, or a narrow fixture-only shape).

Forbidden migrations:

- `{ [key: string]: unknown }` or an alias/interface for it;
- `Record<PropertyKey, unknown>`, `Record<string, any>`, or `object` plus an
  unchecked cast solely to evade the rule;
- Oxlint disable comments, ignored files, baselines, or warning severity;
- widening a closed production type just to keep a permissive test fixture.

## Tooling interface

- Add the current Oxlint package as an exact dev dependency in the Bun lock.
- Add `bun run lint` and `bun run lint:fix` at the repository root.
- Add a root `.oxlintrc.json` with the TypeScript plugin and
  `typescript/no-restricted-types` configured as an error for the normalized
  `Record<string, unknown>` instantiation.
- Keep this adoption narrow: default Oxlint correctness diagnostics are not a
  new merge gate in this migration. Configure categories so the new command
  reports only intentionally adopted rules.
- Add `bun run lint` to the existing CI checks job after dependency install.
- Install a checked-in pre-commit hook during `bun install`. The hook reuses
  `bun run lint` as the sole policy owner and rejects violations; it must not
  guess semantic type replacements or create a second lint configuration.

## Complexity and requirement challenges

| Requirement | Cost | Decision |
|---|---|---|
| Ban all existing uses in one change | Broad 162-file review and validation surface | Required by the referenced scope; do not ratchet or suppress |
| Enable Oxlint's default correctness category | Introduces unrelated findings and policy | Defer; this change adopts one restriction only |
| Replace an existing ESLint setup | None exists at the root | Not applicable |
| Create a universal unknown-object helper | Recreates the banned concept behind an Interface | Rejected |
| Share recursive JSON primitives | One cross-cutting type dependency | Allowed only for genuine JSON contracts |

## Implementation slices

1. Add and verify the isolated Oxlint configuration and scripts.
2. Inventory diagnostics and classify violations by semantic category.
3. Migrate shared production boundary types first, then their tests.
4. Migrate remaining scripts/rig fixtures from their real contracts.
5. Wire the passing lint command into CI.
6. Run diff-scoped cleanup and search for semantic evasions.

## Validation gates

- **Lint:** `bun run lint` reports zero errors; targeted negative fixtures prove
  whitespace-normalized `Record < string, unknown >` forms fail.
- **Compatibility:** `bun run typecheck`, `bun run guards`, and the full existing
  test entry points pass without changing snapshots or wire fixtures merely to
  satisfy types.
- **Differential:** serialization and validation tests around JSON, manifest,
  journal, diagnostics, telemetry, and API routes remain byte/behavior stable.
- **Crash/migration:** existing state-plane crash matrices and migration tests
  remain green; no recovery code is deleted.
- **Performance:** no runtime wrappers or repeated validation are added to hot
  paths solely for lint compliance; the test rig remains the final integration
  gate if local prerequisites are available.
- **Packaging:** frozen Bun install succeeds from the updated lockfile.
- **Hook:** dependency setup resolves the checked-in pre-commit hook, a clean
  tree passes it, and a temporary restricted-type fixture makes it fail.

## Safe deletion candidates

None. This change may remove redundant local type aliases only when all imports,
exports, tests, builds, scripts, and docs prove them unused. It does not approve
feature retirement or deletion of runtime behavior.

## Validation result

- `bun run lint`, `bun run typecheck`, `bun run guards`, frozen install, and
  `git diff --check` pass.
- A temporary negative fixture proved the rule rejects the whitespace-normalized
  `Record < string, unknown >` spelling.
- The API suite passes all 885 tests (4 skipped); focused engine, state-plane,
  CLI-fixture, storage-truth, and rig-library tests exercise the changed shapes.
- The full root suite remains locally limited by the existing unavailable lock
  identity/state-plane runtime prerequisite. Rig tests retain two unrelated
  fixture-environment failures; the changed rig parser tests pass.
