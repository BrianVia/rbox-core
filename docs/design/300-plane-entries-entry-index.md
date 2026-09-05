# Design 300: optional plane-entry reverse index

Status: implemented S2a.

## Ownership and protected behavior

The StateStore writer open path owns one optional physical index:

```sql
CREATE INDEX IF NOT EXISTS plane_entries_entry
ON plane_entries(entry_id,path,path_order)
```

Fresh initialization installs it after frozen v1 schema creation. Ordinary
writer open validates the database first and then installs it; WAL takeover
keeps its existing configure-then-validate order and installs it only after
validation. Read-only opens and immutable/foreign observations never install
it. The validator remains the sole compatibility authority.

The v1 DDL, DDL fingerprint, application/user versions, required-object list,
commands, formats, CAS behavior, sidecar cleanup, and collector activation are
unchanged. There are no approved deletion or retirement candidates in S2a and
no incidental requirements to challenge: both the orphan lookup and existing
foreign key require this reverse access path.

## Compatibility and crash proof

`validateOpen` requires the frozen objects but permits extras. A fixture with
the index and the same v1 header validates unchanged. Removing the index
produces an equally valid old-style v1 fixture: a read-only open leaves it
absent, while the first writer restores it and later writers are idempotent.
Old binaries therefore continue to open indexed stores.

SQLite makes `CREATE INDEX` atomic. A crash leaves the optional index wholly
present or absent; the next writer retries `IF NOT EXISTS`. Logical state does
not depend on the index in either case.

## Query-plan and performance proof

The exact collector DELETE with foreign keys enabled reports these composite
index probes:

```text
SEARCH p USING COVERING INDEX plane_entries_entry (entry_id=?)
SEARCH plane_entries USING COVERING INDEX plane_entries_entry (entry_id=? AND path=? AND path_order=?)
```

A single-column candidate serves the anti-join but the foreign-key probe only
searches `(entry_id=?)`. The composite is therefore the only candidate used
for both required lookups. Reproduction details and timings are in
`docs/design/notes/300/benchmark.md`.

## Rollback and remaining slices

Rollback first removes the writer installer, then drops
`plane_entries_entry`; no query or stored record depends on it. Dropping it
while the installer remains would only recreate it on the next writer open.

S2b still owes bounded exact-candidate cleanup under the existing locks. S2c
still owes a budgeted historical keyset sweep and observability. S2d still
owes an evidence-gated physical compaction policy. This slice activates no
collector, delete, maintenance loop, cursor, or compaction.

## Validation gates

- Compatibility: indexed/unindexed v1, read-only non-installation, writer
  idempotency, frozen header equality.
- Crash: SQLite atomic index creation plus retry on the next writer.
- Differential: existing inventory, delta-CAS, fused-consume, and the complete
  state-plane suite remain unchanged and green.
- Performance: exact collector plans and the 200k-row fixture benchmark.
