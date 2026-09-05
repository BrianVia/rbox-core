# 294 — Maintenance bootstrap recovery

## Scope and owner

`WorkspaceSync` owns accepted sequence authority, retained-roots maintenance, and the alarm wakeup channel. S1a adds one internal complete operation, `ensureMaintenanceScheduled()`, as the sole owner of deciding whether roots maintenance is owed. It reads the durable head, `index_synced_seq` (defaulting to `pruneFloor`), and `index_state`; it arms the existing alarm when the synced sequence trails the head or the state is `building` or `lagging`.

Bootstrap calls that operation after index initialization on both valid existing-head paths: a successfully migrated numeric head and a `StoredHead`. Repair calls it after index initialization as well, preserving the existing fresh-index wakeup without keeping a second arming rule. No key, queue, schema, wire field, mode, or fallback is added.

## Protected behavior

- Commit conflict, head-watermark, and account-epoch checks remain in their current transaction and order.
- `commit()` continues to await alarm scheduling after durable acceptance and before fanout, D1 mirror, and response; S1a neither swallows nor reorders that exception.
- One `alarm()` invocation folds at most one sequence. The isolate-wide fold guard and its delayed re-arm remain unchanged.
- Existing `alarm()` success and failure re-arm rules remain unchanged, including immediate continuation while behind and the five-second retry after a fold failure or isolate contention.
- Fresh index state writes remain byte-for-byte unchanged. Existing ready state at `head == index_synced_seq` does not create a wakeup.
- D1 mirror behavior and replay acknowledgment semantics remain unchanged.

## Regression and validation

The API test reproduces a `setAlarm` failure after commit acceptance, verifies durable head 1 plus lagging index and no alarm, reconstructs `WorkspaceSync` over the same storage, and verifies `/latest` arms exactly once. Differential bootstrap cases verify ready/equal does not arm and building does arm once. Full API tests, typecheck, and affected-file lint protect compatibility; the focused reproducer is the crash-boundary check. This slice adds no performance-sensitive traversal or additional durable write.

## Rollback and later slices

Rollback is a source revert. There is no schema or wire change and no new durable state to migrate or remove.

S1b still owes workerd proof and atomic scheduling/recovery plus any fanout-order change. S1c still owes bounded D1 mirror catchup and any earlier ACK. S1d still owes authenticated exact-replay acknowledgment semantics. None is approved by this design.

## Primitive-first audit

Protected functionality is listed above. Ownership stays in the existing `WorkspaceSync` module and the interface is one private complete operation. There are no safe-deletion candidates beyond replacing the old inline `head > floor` arming rule, and no product requirement is challenged or retired. Differential, crash, compatibility, and performance validation are specified above; no command, protocol, migration, recovery path, or fast path is approved for deletion.
