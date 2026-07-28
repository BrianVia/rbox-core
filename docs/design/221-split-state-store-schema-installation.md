# Design 221: Split state-store schema installation

Status: **PROPOSAL — T1.2 move-only preparation for U3.**

## 1. Problem and invariant

Thermo sweep 4 T1.2 records that `createStateStore` is the only fresh-store
path and directly calls `applySchemaV1`, while `applySchemaV1` combines the
v1 DDL, genesis rows, and the genesis `migration_completion` row. Design 163
requires an imported store's completion row to be inserted last in the same
transaction as all imported rows. A future importer therefore cannot reuse the
safe claimed-file lifecycle while owning that transaction.

This change creates that seam only. It adds no migration code and does not
touch the 2.0 branch. Genesis creation must retain the frozen semantic digest
vectors unchanged.

## 2. Ownership

`schema/application.ts` has two direct operations:

- `applySchemaV1(db)` executes only `SCHEMA_V1_DDL`.
- `installGenesisLineage(db, genesis)` validates the genesis input and, in one
  transaction, inserts the lineage, metadata, plane heads, and the genesis
  `migration_completion` row last.

`store/open.ts` exports one internal vertical initializer:

```ts
initializeStateStore(file, install: (db: Database) => void): StateStoreHandle
```

It exclusively claims the destination (`O_EXCL` via `"wx"`), pins the SQLite
header and writer pragmas, applies the behavior-free v1 DDL, invokes the
caller's installer, validates/readbacks the resulting store, constructs the
handle, and removes only its claimed database and sidecars on failure.

`createStateStore(file, genesis)` remains the public genesis wrapper and calls
the initializer with `installGenesisLineage`. A future importer may pass an
installer that owns its import transaction and writes its completion row last;
this design does not provide or implement that installer.

## 3. Behavior and failure preservation

- Exclusive-create collision behavior is unchanged.
- Genesis validation, row values, insertion order, and completion payload are
  unchanged.
- Failed creation still closes SQLite and removes only the claimed main file
  and its `-wal`, `-shm`, and `-journal` sidecars.
- Successful creation still validates the frozen schema/header and pinned
  pragmas before exposing a writer handle.
- No new conditionals, modes, generic store builder, or migration concepts are
  introduced.

## 4. Verification

- `bun run typecheck`
- `bun test src/cli/state-plane/`
- `bun test src/cli/`
- Frozen schema/genesis digest vectors in `schema/inventory.test.ts` and
  `store/substrate-integration.test.ts` must pass without expectation changes.
- Both touched production files remain below 500 lines.
