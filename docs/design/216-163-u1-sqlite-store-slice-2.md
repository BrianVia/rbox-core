# 163-U1a SQLite state-store substrate

Status: founder-selected split of design 163 U1. This note narrows the
implementation unit; it does not amend the ratified state-plane design.

## Scope

U1a freezes and tests the SQLite substrate without introducing a mutation
seam:

- schema-v1 DDL, genesis creation, cheap-open validation, and pragma pinning;
- exhaustive bounded FileEntry and RepoRecord codecs;
- canonical digest framing plus authority-state and manifest digests;
- short-lived bounded read cursors and legacy-shaped read-only adapters;
- compacted, verified, fsynced, atomic no-clobber backup publication; and
- the focused Bun SQLite contract lane at the supported Bun floor.

Production sync, reset, migration, and daemon flows remain on JSON. No U1a
module is wired into those flows.

U1a intentionally contains no generation-stage builder, transition-stage
builder, sealed-stage verifier, CAS packet writer, LOCAL-plane writer, or
operation-plan helper. It exports no dormant mutation contracts. U1b will
design and implement that seam afresh from `docs/design/notes/163/U1B-FINDINGS.md`.

## Frozen substrate decisions

1. `createStateStore(path, genesis)` exclusively creates a new authority file
   and admits only an empty genesis lineage. It is not a whole-state write
   adapter. `openStateStore(path, { readonly? })` never initializes a missing,
   empty, foreign, or structurally invalid file.
2. Writer open pins and verifies page size 4096, application id `RBOX`, schema
   version 1, WAL, FULL synchronous, foreign keys, autocheckpoint 1000, cache
   -32768, journal limit 67108864, busy timeout 5000, and FILE temp storage.
   Darwin also pins both full-fsync settings. Read-only open pins query-only,
   cache -8192, timeout 250, autocheckpoint 1000, and Darwin full-fsync settings
   on its own connection while verifying persistent authority values.
   Genesis BASE is complete; genesis LOCAL is incomplete until a full scan
   records its trust epoch.
3. Canonical extension blobs use a total JSON codec. Known members map to
   named columns, unknown members survive in `extras_cjson`, and obsolete
   `resolutionIntent` is stripped. Canonical byte and retained-size limits are
   enforced before persistence.
4. Digest tokens are framed as an unsigned 64-bit big-endian byte length
   followed by UTF-8 or opaque bytes. Authority-state records are ordered by
   their stored UTF-16BE keys. Schema and empty-genesis digest vectors are
   pinned in tests.
5. A `ReadSnapshot` is a bounded optimistic projection token. Each cursor page
   uses a short transaction and checks the token before and after its query;
   callers must call `finishProjection()` before publishing assembled output.
   Files, repositories, manifest chain, and both Git roles all route through
   this one token. The exported manifest materializer requires an exact
   projection token and a `wire-snapshot|wire-delta` purpose.
6. `publishStateBackup` uses `VACUUM INTO` to an id-scoped sibling, validates
   the closed compacted artifact, fsyncs it, publishes without replacement,
   fsyncs the parent directory, and returns its SHA-256 plus byte size.
   Compacted backups are artifacts, not ordinary WAL-mode authority opens.
7. `src/engine/**` never imports `bun:sqlite`; SQLite ownership remains inside
   the CLI state-plane vertical. The production `state-plane/index` facade is
   also SQLite-free; store APIs exist only at the explicit `store-facade`
   subpath.
8. `entry_values.exact_fingerprint` is a non-unique lookup key. `entry_id` is
   independently allocated so a fingerprint collision still reaches exact
   row comparison.

## Validation

Focused tests cover schema application and inventory, wrong identity/version
refusal, writer/read-only pragma readback, codecs and hostile inputs, bounded
read projections, authority-state digest vectors, backup integrity and
no-clobber publication, and the SQLite-free engine boundary.

Required acceptance:

```text
bun run typecheck
bun test src/cli/state-plane/
bun test src/cli/
```
