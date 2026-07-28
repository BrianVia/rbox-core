# Design 221 review — round 1

Verdict: **ALIGNED**

The design matches T1.2 and design 163's completion-row transaction
requirement:

- `applySchemaV1(db)` becomes DDL-only.
- `installGenesisLineage(db, genesis)` preserves validation, row order,
  payloads, one genesis transaction, and inserts `migration_completion` last.
- `initializeStateStore(file, install)` owns exactly the shared claimed-file
  lifecycle: exclusive claim, SQLite header/pragmas, DDL, caller installer,
  validation/readback, handle construction, and claimed-artifact cleanup.
- `createStateStore` remains the thin genesis wrapper.
- No importer, migration policy, mode flags, generic builder layer, or 2.0
  work enters scope.
- Both production files remain comfortably below 500 lines.

Implementation note: retain the current validation statements, insert order,
completion payload, and failure cleanup loop as moves.
