# Design 215: state-plane folder consolidation

Status: implementation dispatch

Source of truth: root `SPEC.md`, constrained by the Tier 1 state-plane finding
in `docs/design/notes/2026-07-28-thermo-nuclear-sweep-3.md`.

## Goal

Establish `src/cli/state-plane/` as the vertical owner of the existing
state-plane barrier, migration artifacts, legacy JSON publication adapter, and
SQLite runtime characterization. This is a move-only consolidation with no
behavior change except narrowing `afterStatePublication` from a `SyncState`
argument to its scalar `stream`.

## Exact layout

```text
src/cli/state-plane/
  index.ts
  authority-marker.ts
  authority-marker.test.ts
  errors.ts
  inventory.test.ts
  adapters/
    legacy-json-publication.ts
  migration/
    last-writer-witness.ts
    last-writer-witness.test.ts
    reserve.ts
    reserve.test.ts
  sqlite-contract/
    helpers.ts
    sqlite-contract.test.ts
```

- `authority-marker.ts` owns marker recognition, state-format classification,
  read/write guards, and barrier-error rethrowing. It imports the typed errors
  from `errors.ts`.
- `errors.ts` owns `StateFormatTooNewError`, `StateWriteRefusedError`, and
  `StateWriteRefusalReason`.
- `migration/last-writer-witness.ts` is the current
  `src/cli/state-witness.ts`, with import paths changed only.
- `migration/reserve.ts` is the current PR #551 version of
  `src/cli/state-reserve.ts`, with import paths changed only.
- `adapters/legacy-json-publication.ts` is the current
  `src/cli/state-publish.ts`, with import paths changed and
  `afterStatePublication(root, file, stream, body)` narrowed to the scalar
  stream.
- `sqlite-contract/` is moved intact from `src/engine/sqlite-contract/`, with
  relative import paths changed only where required.
- `index.ts` is a logic-free facade re-exporting the public surface.
- `inventory.test.ts` is the existing AST inventory moved under the vertical,
  with repository/sweep paths and expected owner paths updated. Its publication
  checks are strengthened from unordered callee-name co-occurrence to ordered
  structural contracts:
  - ordinary whole-document publication entry points must call the typed
    `legacy-json-publication` adapter, with `publishWholeState` preceding
    `afterStatePublication`;
  - `publishWholeState` must bind the publish primitive's `beforeRename`
    callback to `assertStatePublishable`, reassert lock ownership there, and
    directory-sync only after the publish primitive completes;
  - `afterStatePublication` must record the last-writer witness before ensuring
    the reserve;
  - transactional CAS writers that publish inline must prove the same
    assert-before-publish and witness/reserve-after-publish order without being
    rerouted through a throwing adapter;
  - reset byte-swap publications remain a separately explicit contract, because
    their recovery protocol intentionally records witnesses inline.

The ordering test uses AST source positions and callback containment rather than
flattening callees into a `Set`. No production function is restructured to make
the inventory pass.

No compatibility modules remain at the old paths.

## Consumer import rule

Consumers importing multiple symbols from the state plane use
`state-plane/index.ts`. Consumers importing one symbol use its owning module.
State-plane internals import owners directly and never import their own facade.
All changes outside `src/cli/state-plane/` are mechanical import changes, apart
from passing `.stream` at the four `afterStatePublication` call sites.

## Test split and fidelity

The assertions in `src/cli/state-barrier.test.ts` are partitioned without
rewriting:

- marker classification, guarded reads/writes, and barrier publication behavior
  move to `authority-marker.test.ts`;
- typed error construction assertions, if any can move without rewriting, move
  to `errors.test.ts`; the existing `rethrowIfStateBarrier` assertions stay in
  `authority-marker.test.ts`, beside that function's owner;
- witness assertions move to `migration/last-writer-witness.test.ts`;
- reserve assertions move to `migration/reserve.test.ts`.

Shared test helpers may be duplicated verbatim or placed in a test helper only
if doing so does not alter assertions. Before deleting old files, capture
baseline function bodies and compare them to destination bodies after
normalizing import declarations and the explicitly permitted scalar signature.

The implementation report separates:

1. production function bodies changed beyond imports — expected:
   `afterStatePublication` and its four callers, solely for the scalar stream
   argument; and
2. specification-authorized structural-test body changes in
   `inventory.test.ts` — exhaustively list the replaced unordered helper and
   strengthened test callbacks.

No other production or test function body may change. Test splitting preserves
the existing assertion callbacks and helpers byte-for-byte apart from import
paths.

## CODEMAP ownership

Add a `src/cli/state-plane/` section to `docs/CODEMAP.md` with one line for the
facade and each owner/module family. Each line states both ownership and
prohibited responsibilities. Remove the obsolete
`src/engine/sqlite-contract/` ownership line when relocating it to
`src/cli/state-plane/sqlite-contract/`; there must be exactly one canonical
owner.

## Hard exclusions

Do not touch:

- `src/cli/scope/**`
- `src/cli/sync-git/republish-requests.ts`
- `src/cli/git/republish-command.ts`
- the republish case in `src/cli/main-dispatch.ts`
- `src/engine/entry-arena/**`
- `CHANGELOG.md`
- `package.json`

No symbol rename, opportunistic cleanup, formatting pass, schema/store work, or
behavioral change is in scope. All resulting files remain at most 500 lines.

## Acceptance

Run and require green:

```sh
bun run typecheck
bun test src/cli/state-plane/
bun test src/cli/
rg -n 'state-barrier|state-witness|state-reserve|state-publish' src/ --glob '!**/state-plane/**'
```

The final search must produce no stale import. Any non-import textual hit must
be listed and justified. Also run the repository integration rig required by
the development flow (`bun run rig`) unless the rig documents a narrower
applicable state-plane invocation.

Stage by explicit path and commit on `refactor/state-plane-vertical`; do not
push.
