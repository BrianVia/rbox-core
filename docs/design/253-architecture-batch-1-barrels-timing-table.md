# Design 253 — architecture batch 1: identity barrels and Git timing metadata

## Verdict

Delete the four named identity-only barrels and point every importer at the
Module that owns the imported symbol. Retain the five audited high-fan-in
facades: each is an established compatibility or composition surface, and
removing it would be a broad dependency migration with no reduction in domain
concepts. Replace the three hand-enumerations of `GitChainTimings` presentation
metadata with one exhaustive ordered table. Do not otherwise reshape the
engine public API in this batch.

## Protected-functionality ledger

| Contract | Protection |
| --- | --- |
| Engine and CLI runtime exports | Direct imports preserve the same symbols and implementations; no command, alias, protocol, or dynamic dispatch path is removed. |
| Git command behavior | `main-dispatch.ts` keeps lazy command loading, now from each command owner. Existing command tests remain. The obsolete facade-shape test is deleted with the facade. |
| Blob-batch wire/config/gate behavior | Importers move independently to `wire.ts`, `config.ts`, `gate.ts`, `downloader.ts`, and `uploader.ts`; singleton gate ownership remains unchanged. |
| Crypto-pool singleton and budget contracts | Runtime imports move to `pool.ts`; the public engine surface obtains `CoalescedBlob` from `budget.ts`. No registry or worker lifecycle code moves. |
| Git-state behavior and public engine API | `engine/index.ts` continues exporting the same names, grouped by their real owners; the one internal state-plane caller imports `repoCtxFromDisk` from `git/shared.ts`. |
| Git apply metrics bytes | A complete pre-change fixture string is pinned with `toBe`; table order is the wire/log order. The formatter retains rounding, labels, abbreviations, spacing, inclusion, and omission behavior. |
| Timing-presence semantics | `residualMs` remains excluded from the presence predicate, matching the old disjunction; `chainLength` remains excluded only from distributions. |
| Compatibility, crash, and performance | No durable record, mutation order, crash recovery, concurrency primitive, or fast path changes. This is import routing plus pure rendering metadata. |

There is no feature retirement, active migration removal, or supported-format
change in this design.

## Item 7 — deletion evidence and ownership

### Delete

| File | Evidence | Replacement owners |
| --- | --- | --- |
| `src/engine/git-state.ts` | Pure re-export; live consumers are `engine/index.ts` and `state-plane/locks.ts`; no package export or generated-load owner. | `manifest-validate.ts` and the individual `engine/git/*` Modules already named in CODEMAP. |
| `src/cli/remote/blob-batch.ts` | Five re-export statements; live consumers are `remote/api.ts`, `e2ee-fake-server.ts`, `remote/blob-batch/blob-batch.test.ts`, and `remote/blob-batch/upload-grant.test.ts`. | The matching `wire.ts`, `config.ts`, `gate.ts`, `downloader.ts`, and `uploader.ts` Modules. |
| `src/engine/crypto-pool.ts` | Pure re-export; live consumers are `engine/index.ts`, `engine/apply.ts`, `cli/json-output.test.ts`, both `engine/crypto-pool/*` tests, and `rig/d99-p0/arm-a.ts`. | Runtime symbols move to `pool.ts`; `CoalescedBlob` moves to `budget.ts`. |
| `src/cli/git-cmd.ts` | Pure re-export; live consumers are `main-dispatch.ts`'s three lazy loads, `git-cmd.test.ts`, `sync-git/git-sync.test.ts`, and the facade-only `git-cmd-surface.test.ts`. | Runtime/type imports move to the matching `git/deferrals-command.ts`, `git/republish-command.ts`, `git/resolve-command.ts`, and `git/resolve-presentation.ts`; the facade-only test is deleted with the contract it alone pins. |

The CODEMAP entries for these four files and their names in CODEMAP's
introductory barrel inventory are deleted. Existing owner entries remain
authoritative. Documentation history and changelog prose are not live load
paths and are not rewritten.

### Audit and retain

| Facade | Import sites observed | Decision |
| --- | ---: | --- |
| `src/cli/sync-git.ts` | 14 | Retain. It is the established cross-lane CLI surface used by sync drivers, status adapters, tests, and `scripts/d83-parity.ts`. Mechanical removal would spread knowledge of many `sync-git/*` owners across callers without deleting behavior. |
| `src/cli/daemon.ts` | 13 | Retain. It is the stable daemon entry/composition surface, including `main-dispatch.ts` dynamic loading and test fixtures/mocks. Direct rewrites would lose the single daemon loading boundary. |
| `src/cli/sync-state-store.ts` | 27 | Retain. It is an explicit compatibility boundary during the active legacy-JSON/SQLite state-plane migration. Deleting it would erase migration intent and distribute backend knowledge. |
| `src/cli/daemon-control.ts` | 26 | Retain. It is the established process/runtime/log compatibility API with explicit surface tests and dynamic imports. The facade hides the three physical owners from adapters. |
| `src/cli/folder-config.ts` | 34 | Retain. It is the documented cross-CLI FolderCatalog Interface over four cohesive owners. High fan-in, dynamic import, and mocks make removal churn without conceptual reduction. |

Nothing in this batch approves deletion or retirement of these five facades.

### `src/engine/index.ts` report-only shrink plan

`src/engine/index.ts` is a 413-nonblank-line allowlisted compatibility barrel.
Do not migrate its callers here. A later dedicated cycle should:

1. inventory production, test, package, generated-bundle, and cross-package
   consumers by exported symbol;
2. classify consumers into coherent Interfaces (manifest/scan, apply,
   crypto, Git, E2EE/wire) and identify which external/public compatibility
   consumers truly require the aggregate surface;
3. move internal CLI callers mechanically to those existing owner Modules,
   one Interface at a time, with typecheck and focused differential tests;
4. retain a deliberately small compatibility export surface only where an
   actual package or embedding consumer needs it;
5. delete `engine/index.ts` and its allowlist/ratchet entry only after command,
   import, export, build, generated-load, automation, documentation, support
   window, and owner checks are all green.

This batch changes only the sources of existing exports needed to remove
`git-state.ts` and `crypto-pool.ts`; that is not execution of the shrink plan.

## Item 8 — one exhaustive ordered timing table

`apply-metrics.ts` will define one constant with this compile-time contract:

```ts
as const satisfies Record<keyof GitChainTimings, { abbr: string; label: string }>
```

Insertion order exactly matches the existing per-repository byte format. The
three consumers derive as follows:

- presence scans the table entries, preserving the special exclusion of
  `residualMs`;
- distributions scan every table entry except `chainLength`;
- per-repository compact rendering scans every entry, including `chainLength`.

Thus a new timing field fails typecheck until its one table row is supplied,
then automatically reaches presence, distributions, and compact rendering.
`chainLength` and `residualMs` remain structural exceptions because their
existing semantics differ; they are not duplicated metadata lists.

The `as const` literal preservation makes `Object.values(table)` retain the
literal union of the table's `label` properties, and each label is the
corresponding `GitChainTimings` key. The
three loops therefore index `chain[field.label]` without widening to `string`,
without an assertion, and without a new local type declaration. The formatter
test adds one complete `toBe` golden containing every label and abbreviation,
rounding-sensitive values, and the full old line. A separate residual-only
fixture proves that `residualMs` alone still does not make a chain present.

## Requirement challenges

| Requirement | Complexity cost | Evidence | Recommendation / decision |
| --- | --- | --- | --- |
| Preserve the five larger facades | Small identity layer remains. | 13–34 import sites plus dynamic imports, mocks, compatibility tests, and active migration intent. | Retain; deletion is not a local simplification. |
| Preserve the aggregate engine barrel | 413 nonblank lines and broad coupling. | Explicit size allowlist and many compatibility exports. | Separate shrink cycle; no deletion approved here. |
| Preserve exact metric bytes | Ordered metadata table must carry serialization order. | Existing output is operational telemetry and tests assert tokens. | Keep table insertion order load-bearing and pin a full old fixture string. |

No product decision is required for this batch because no incidental behavior
is being removed.

## Validation gates

Exit-code-gated, without snapshots or size re-pins:

1. pre-change formatter fixture captured and focused formatter test green;
2. `bun test src/cli/sync-git src/engine/git src/cli/state-plane/file-size.test.ts`;
3. repository typecheck command;
4. inventory the final touched-file warning set, fix every anti-slop warning
   in those whole files without suppressions, chained/unsafe casts, or new
   local type declarations, run a direct `oxlint` over the exact surviving
   touched-file list and require empty warning output, then run
   `bun run lint:affected`;
5. final import/reference audit proves the four deleted paths are absent;
6. final diff and staged-name audit proves no unrelated behavior or allowlist
   pin changed. The planned cleanup includes the approximately 44 baseline
   findings exposed by the direct-import rewrites, even where the finding
   predates this batch; behavior is covered by the focused suites and final
   typecheck rather than inferred from lint's warning-level exit code.

Crash and performance validation are non-applicable beyond regression tests:
the patch changes no effect ordering, durable state, concurrency, I/O count, or
algorithmic path. Compatibility is covered by preserved exports, direct command
tests, typecheck, and the byte-exact formatter fixture.
