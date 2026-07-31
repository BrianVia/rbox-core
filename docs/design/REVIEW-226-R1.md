# Design 226 — review round 1

**Result:** CHANGES REQUIRED
**Snapshot:** `690544a28` (`origin/2.0`)
**Reviewers:** CLI/daemon, sync/Git/remote, state/engine

## Executable evidence

- Command grammar characterization: 38/38 flag, help-registry, and deprecation
  tests passed after making the fresh worktree use the repository's installed
  dependencies.
- Received-config contract: 15/15 focused contract tests passed.
- Wider received-config baseline: 42 passed / 8 existing failures. The failing
  integration rows involve pending/config outcomes and two absent
  `remote.upstream.url` reads.
- State read differential: 4/4 passed.
- Wider sync/state baseline reproduced the branch's current Bun
  `1.4.0-canary.1` capability failures: capable-lineage reservation reports
  `unsupported`, and SQLite sealed stages retain `-wal` sidecars.
- CLI/provisioning characterization: 97/101 passed; four environment-sensitive
  rows could not obtain system-incarnation evidence in the sandbox.
- Entry-arena characterization: 69/69 passed. It remains a separate active-U0
  follow-up, not part of this CLI/daemon implementation.

These are baseline observations before product-code edits. The design does not
weaken a check or reclassify a failing environment as passing.

## Findings and dispositions

### 1. Provisioning crossed the active U3 boundary

**Finding:** A Cycle-1 `WorkspaceProvisioner` would read/reset state, publish
binding/config/state, and start first sync while U3 is changing authority.
It also contradicted the rule that only `LocalRuntime` sequences multiple
runtime Modules.

**Disposition:** Removed from Cycle 1. Binding is deferred until U3 closes. Its
eventual owner is `LocalRuntime.bind`, with `WorkspaceBinding` remaining an
internal inspect/plan component. The design names the complete transaction and
the continuation concepts it will delete; no temporary ninth primitive is
introduced.

### 2. The pre-U3 no-touch boundary was implicit

**Finding:** The target `WorkspaceStore` could be mistaken for permission to
refactor the active migration.

**Disposition:** Added an explicit exclusion for state-plane, sync-state,
reset/recovery/genesis, state-related config entries, persisted shapes,
state-save/CAS ordering, caller-visible migration capabilities, and daemon
state-CAS integration. `WorkspaceStore` is target architecture only during U3.

### 3. Git logical semantics had two owners

**Finding:** `WorkspaceStore` and `GitReplica` both claimed BASE/P/A/K/tombstone
transition authority.

**Disposition:** Added one pure private `RepositoryState` reducer under
`GitReplica`. It returns a complete next `RepoRecord`; `WorkspaceStore`
persists it and owns no Git transition semantics. `LocalRuntime` does not merge
lanes.

### 4. Received config could become another lifecycle service

**Finding:** Replacing a public plan/executor/receipt with a public
`ReceivedConfigLane` would move, not delete, the protocol.

**Disposition:** Made the lane a private `GitReplica` implementation detail,
bound once to identity/prior lane/source sequence/effects. The three real
execution windows remain structural, fresh config cannot run before
materialization, and the follow path requires an unforgeable common-dir lock
scope. The crash and behavior-equivalence gates are explicit.

### 5. Daemon observation had no permanent home or deletion criteria

**Finding:** It risked becoming a temporary wrapper before
`WorkspaceObservation`.

**Disposition:** Defined it as a permanent read-only sub-observation and named
its exact scope and forbidden responsibilities. The design now requires removal
of independent process/binding/freshness truth calculations and covers the full
PID/binding/boot/ambient matrix.

### 6. Command catalog could absorb domain policy

**Finding:** Moving handler lookup into a descriptor risks encoding current
adapter orchestration as grammar.

**Disposition:** CommandShell remains after the bounded observations. Its
descriptors own syntax only; typed use cases retain domain validation and
orchestration.

## Round conclusion

The primitive direction survived review. The implementation wave is narrowed
to daemon observation and private received-config deepening, followed by the
syntax-only CommandShell. Round 2 is the alignment check.
