# 226 — Behavior-preserving CLI and daemon runtime primitives

**Status:** ALIGNED after round 3; Cycles 1-2 and bounded Cycle 3/4/6 slices implemented and validated
**Snapshot:** `690544a28` (`origin/2.0`, 2026-07-30)
**Scope:** `src/cli/**` and CLI-owned orchestration in `src/engine/**`
**Foundation:** the aligned, uncommitted design-223 audit from the older
`215020b36` snapshot, revalidated here against the active U3 state-plane work

## 1. Outcome

Make the CLI and daemon understandable as a small application made from a few
deep Modules:

1. `CommandShell`
2. `AccountSession`
3. `WorkspaceBinding`
4. `WorkspaceStore`
5. `FileReplica`
6. `GitReplica`
7. `RemoteWorkspace`
8. `LocalRuntime`

Commands and the daemon become Adapters. They parse, present, schedule, and
report. They do not independently reconstruct sync, recovery, state, Git, or
remote orchestration.

This is not a file-splitting exercise. A slice succeeds only when it removes
concepts or authorities from callers, makes a behavior local to one owner, and
deletes the old orchestration after differential equivalence.

## 2. Protected-functionality ledger

The refactor preserves, by default:

| Area | Protected functionality |
|---|---|
| CLI | Every supported command, alias, flag, help entry, stdout/stderr shape, JSON shape, exit behavior, prompt, progress stream, cancellation path, headless flow, and guided flow |
| Foreground | Pull, push, pull-then-push sync, push-only/pull-only semantics, mutex behavior, absent-daemon operation, reset, recovery, adoption, restore, and explicit Git resolution |
| Daemon | Optional operation, autostart, watcher and Git-ref signals, WS notification and polling backstop, coalescing, fairness, recovery probes, backoff, drift audit, key delivery, heartbeat/status, and graceful wind-down |
| File plane | Ignore semantics, unreadable-not-deleted rule, trusted incremental observation, full/deep correctness backstops, mass-delete consent, verified staging, atomic placement, conflict preservation, trash, and type-flip behavior |
| Git plane | Nested/pointer repositories, linked worktrees, current-checkout following, config sync, local edits/index/op-state/stash preservation, BASE and P/A/K lanes, tombstones, deferrals, keep-mine/take-theirs, pins, journals, and crash recovery |
| Remote | E2EE, signed anti-rollback history, delta/snapshot choice, blobs, batching/packs, capability fallback, retries, receipts, uncertain ACK recovery, history, and restore |
| State | Current JSON behavior, SQLite 2.0 authority, U3 reserve/import/migration/reset/readiness work, exact migration entry points, lineage/CAS, sidecars, and supported persisted formats |
| Performance | One shared workspace traversal where currently shared; watcher and cache fast paths; no-op sync; bounded hashing/crypto/upload; daemon idle cost; cached status; existing p50/p95 gates |
| Safety/privacy | One mutation owner, effect-before-checkpoint ordering, deterministic fail-closed recovery, containment, no-follow record handling, secret permissions, and privacy-bounded status/telemetry |

Anything uncertain remains protected until its owner and support window say
otherwise.

## 3. Verdict and structural diagnosis

The codebase is not mainly difficult because several files are large. It is
difficult because complete behaviors cross too many shallow protocol Modules
and callers must understand their intermediate plans, receipts, capabilities,
ports, lanes, and sidecars.

At the audited snapshot, the production surface is roughly 100,000 TypeScript
lines across more than 400 CLI/engine files. The hot path alone spans daemon,
sync, sync-git, state-plane, remote, publish-pipeline, and engine/git. A
conservative name scan finds hundreds of production declarations ending in
`Port`, `Plan`, `Receipt`, `Authority`, `Capability`, `Ledger`, `Transition`,
`Policy`, `Gate`, `Evidence`, or `Witness`. `daemon/daemon.ts` is 3,396 lines;
`sync-git/apply.ts` and `sync-git/plan.ts` remain about 1,500 lines each.

Those counts are evidence, not targets. The deeper problems are:

1. **Commands assemble the application.** `main-dispatch.ts`, setup, status,
   recovery, and Git commands construct remote, locking, state, scan, sync, and
   presentation behavior themselves.
2. **Command behavior has multiple authorities.** Help, flag arity, hidden
   flags, aliases, validation, completion, known-command classification, and
   dispatch are related but not one closed declaration.
3. **Foreground and daemon mutations have different composition roots.** They
   reach the same lower layers through different mutex, cache, recovery,
   reporting, and retry wiring.
4. **Pull and push are chronology, not ownership.** Each crosses file, Git,
   state, remote, policy, telemetry, and rendering.
5. **Git complexity is real but leaks.** Sync, daemon, state, status, and
   commands know protocol phases that should be internal to one deep Git owner.
6. **The active SQLite migration risks becoming the permanent caller
   Interface.** Its separate authorities are justified during rollout, but
   ordinary runtime callers must not learn them.
7. **Status and doctor observe overlapping truth.** They should consume one
   point-in-time observation at explicitly cheap/local/remote depths.
8. **Move-only decomposition has reached its limit.** The current CODEMAP is
   detailed enough that many ownership sentences are longer than the Interface
   they describe. Another wave of helper extraction would improve navigation
   without reducing the mental model.

## 4. Ownership and dependency rule

```text
CommandShell ──────────────► AccountSession        (account-only operations)
             └────────────► LocalRuntime           (workspace operations)

DaemonLoop ────────────────► LocalRuntime
status / doctor ───────────► LocalRuntime.observe

LocalRuntime ──────────────► WorkspaceBinding      (internal inspect/plan)
             ├────────────► WorkspaceStore
             ├────────────► FileReplica
             ├────────────► GitReplica
             └────────────► RemoteWorkspace
```

Only `LocalRuntime` may sequence mutations across two or more runtime data
Modules. Replicas and remotes receive bounded read inputs and return opaque
outcomes/effect evidence; they never receive the general writable store.

Physical-effect recovery stays with the effect owner:

- file placement/trash journals: `FileReplica`;
- Git common-directory journals/artifacts: `GitReplica`;
- logical checkpoints, reset state, and publication intent:
  `WorkspaceStore`;
- lock order and cross-resource recovery: `LocalRuntime`.

A future pure, private `RepositoryState` reducer under `GitReplica` solely owns
complete `RepoRecord` evolution: BASE, pending, advertised, P/A/K, tombstones,
deferrals, config-lane fields, and proof consumption. `GitReplica` returns one
complete next record plus opaque effect evidence. `LocalRuntime` asks
`WorkspaceStore` to persist that record without reconstructing or merging Git
lanes. It lands only when all record lanes move together in Cycle 6; Cycle 1
does not introduce a config-only approximation.

## 5. Primitive Modules

### P1. `CommandShell`

| Field | Contract |
|---|---|
| Owns | Command paths, aliases, deprecations, visibility, flag spelling/arity/repeatability, validation, workspace requirement, JSON eligibility, help, completion projection, lazy dispatch, and exit mapping |
| Must never own | Account, workspace, sync, daemon, state, remote, or rendering-domain policy |
| Interface | `parse(argv): CommandInvocation`; `dispatch(invocation, handlers, presentation): Promise<CommandOutcome>`; read-only catalog queries for help/completion |
| Absorbs | Authority now split across `main-dispatch.ts`, `flags.ts`, `command-catalog.ts`, `help-registry.ts`, and `deprecations.ts` |
| Evidence | Adding or changing a command currently requires coordinated edits or parity tests across several authorities; flag arity is inferred from help prose and hidden flags live separately |
| Validation | Byte/exit differential for every command/alias/help/flag case; table parity; compiled CLI smoke |

The catalog stays declarative. Handlers remain focused and lazily loaded.
Interactive and streaming commands receive a typed presentation object rather
than being forced through a `render(): string` abstraction.

### P2. `AccountSession`

| Field | Contract |
|---|---|
| Owns | Credential/device identity lifecycle, account/master/workspace key access, login, enrollment, partial-keystore recovery, recovery destination selection, and private-record permissions |
| Must never own | Workspace file/Git state or sync orchestration |
| Interface | `inspect`, `login`, `enroll`, `recover`, `logout` |
| Absorbs | Coherent behavior spread through credentials, E2EE keystore/client, auth flows, recovery-kit flows, and setup enrollment branches |
| Evidence | Account-only commands currently enter several storage/network/interaction paths with partially overlapping recovery logic |
| Validation | Credential-state matrix; device enrollment; all recovery destinations; headless/interactive parity; permissions/no-follow tests |

OS keychain, 1Password, file, stdout, phrase, and in-memory destinations remain
real Adapters at real Seams.

### P3. `WorkspaceBinding`

| Field | Contract |
|---|---|
| Owns | Read-only binding inspection and deterministic planning for create/join/rebind/track/setup/init, scope, adoption admission, registry publication, and first-sync intent |
| Must never own | Mutation execution, remote data sync, or presentation |
| Interface | `inspect(request): BindingPreparation`; `plan(preparation, choice): BindingPlan` |
| Absorbs | Transactional planning in setup/init/track/init-plan/setup-keyed, binding registry, and scope admission |
| Evidence | Binding mutations currently assemble account, config, state, registry, adoption, and first-sync work in command paths |
| Validation | Fresh/non-empty/rebind/adopt/scoped/headless matrix; unknown create outcome; crash between every publication step |

`LocalRuntime` executes the opaque plan under the same lease and recovery
boundary as every other mutation.

### P4. `WorkspaceStore`

| Field | Contract |
|---|---|
| Owns | Persistence, workspace lineage/CAS, snapshots, reset/recovery and publication-intent records, migrations, and format compatibility |
| Must never own | Git transition semantics, file/Git physical effects, scope policy, daemon scheduling, or best-effort runtime summaries |
| Interface | Reader: `snapshot`, `inspectRecovery`; writer: `commit`, `recover`, `reset` over a closed union of complete domain transitions |
| Absorbs | Steady-state `sync-state*`, state store façade/packets/stages/sidecars, and state-backed status fragments after caller cutover |
| Evidence | Runtime callers currently see rows, packets, stages, retry views, migration capabilities, and store-specific protocols |
| Validation | JSON/SQLite differential; crash injection; lineage/CAS; reset; migration/static-graph gates |

The active U3 migration remains protected beneath this boundary. Ordinary store
open never starts migration. The U3 authority selector, coordinator, genesis
installer, reserve, import/migration machine, last-writer witness, one-way
authority flip, reset façade, health projection, and doctor-authorized retry
retain their exact owners and entry points until the documented rollout gate.
`WorkspaceStore` is target architecture until that gate closes, not an
implementation tranche during U3.

### P5. `FileReplica`

| Field | Contract |
|---|---|
| Owns | Ignore evaluation, full/incremental observation, caches, watcher-trust evidence, reconciliation, mass-delete policy, verified staging, placement, conflicts, trash, effect journal, and recovery |
| Must never own | Remote transport, logical workspace checkpoint persistence, Git protocol, or presentation |
| Interface | `observe(request): FileObservation`; `apply(request): FileApplyOutcome`; `recover(request): FileRecoveryOutcome` |
| Absorbs | File choreography split between engine scan/reconcile/apply, sync pull/push, and daemon watcher/scan methods |
| Evidence | Callers currently choose scan/cache modes and interpret actions/effect details |
| Validation | Old/new differential corpus; unreadable/type-flip/concurrent-edit/mass-delete/ignore/trash cases; crash matrix; scan A/B |

One full observation carries an opaque Git discovery inventory so `GitReplica`
does not traverse the workspace again.

### P6. `GitReplica`

| Field | Contract |
|---|---|
| Owns | Repository observation, capture, apply, follow, config, linked worktrees, the private `RepositoryState` reducer for BASE/tombstones/P/A/K and all other `RepoRecord` semantics, deferrals, resolution, pins, physical journals/artifacts, effect recovery, and status projection |
| Must never own | General workspace state persistence, remote transport, command presentation, or daemon scheduling |
| Interface | `observe`; `apply({ priorRecord, ... })` returning one complete `nextRecord` plus effect evidence; `resolve`; `recover`; `status` |
| Absorbs | `sync-git/**`, CLI-owned `engine/git/**` orchestration, and Git portions of sync/daemon/status/commands |
| Evidence | Git plans/receipts/proofs and optional maps leak across multiple packages; a complete transition is hard to change locally |
| Validation | Real-repo corpus: nested/pointer/linked, refs/config/index/op-state/stash, tombstones, P/A/K, keep/take, packed refs, crashes, compatibility, and performance |

This Module may remain internally large. Depth comes from hiding the protocol
behind complete operations, not forcing every internal phase into another
public abstraction.

### P7. `RemoteWorkspace`

| Field | Contract |
|---|---|
| Owns | Authenticated workspace data, verified head, anti-rollback pins, manifest crypto/folding, blob transfer, batching/packs, commit admission, receipts, retry/fallback, history/restore, and notifications |
| Must never own | Credential lifecycle, local state, file/Git effects, or mutation sequencing |
| Interface | `latest`, `publish`, `history`, `restore`, `notifications` |
| Absorbs | `remote/**`, `e2ee-remote*`, publish-pipeline, sync-recovery, and scattered remote construction |
| Evidence | Transport, encryption, publication, receipt, retry, and compatibility policy are exposed to sync callers |
| Validation | HTTP/fake differential; old-server fallback; anti-rollback/epoch; missing blobs; delta/snapshot; packs; uncertain ACK; notification reconnect |

Account-level unauthenticated and membership/create operations use an internal
`AccountControlPlane`, not `RemoteWorkspace`.

### P8. `LocalRuntime`

| Field | Contract |
|---|---|
| Owns | Composition, workspace lease, recovery-before-mutation, operation ordering, restricted store ports, effect/checkpoint ordering, publication intent, and outcome aggregation |
| Must never own | Command presentation, daemon cadence/scheduling, file/Git implementation details, transport details, or store format mechanics |
| Interface | `prepareBinding`; `run(operation)` over a closed operation union; `observe(depth)` |
| Absorbs | Caller-specific composition in foreground commands, sync-cmd, setup/init/track, reset/recovery/adopt/restore/Git resolution, and daemon operation executors |
| Evidence | Foreground and daemon callers currently reconstruct different versions of the same mutation rules |
| Validation | Foreground/daemon differential; live/absent/broken daemon; simultaneous commands; stale owner; reboot/upgrade/shutdown; effect/store crash matrix |

The operation union preserves bind, sync, pull, push, reset, recover, adopt,
resolve-Git, scope change, restore, and daemon maintenance triggers. Maintenance
triggers carry their evidence: watcher batch and generation, Git repository/ref
signals, remote source/cursor/head hint, safety/deep reason, or retry episode.

`LocalRuntime` owns cross-resource sequencing, recovery order, publication
intent creation/retirement, and effect-before-checkpoint enforcement.
`WorkspaceStore` owns logical-state recovery only. File/Git owners perform
physical recovery and return opaque evidence; they never receive the general
writable store. Reset explicitly distinguishes logical baseline reset from
binding/config reset and from physical file/Git reset.

### Supporting Adapter: `DaemonLoop`

The daemon owns subscriptions, timers, scheduling, coalescing, fairness,
backoff, key delivery, telemetry, liveness publication, and wind-down. It calls
`LocalRuntime`; it does not implement sync transitions.

### Supporting read model: `WorkspaceObservation`

One point-in-time observation feeds status, doctor, and daemon status. Depth is
explicit (`ambient`, `local`, `remote`). Default status remains cheap and
read-only. Maintenance writes become explicit runtime operations.

`DaemonObservation` is a permanent read-only sub-observation composed unchanged
by `WorkspaceObservation`. It owns only PID/process proof, root/workspace
binding, boot agreement, mode witness, ambient freshness/future skew, and trust
rejection reasons. It must never own cleanup, desired state, presentation,
state authority, migration health, recovery decisions, maintenance writes, or
sync policy.

## 6. Requirement-challenge ledger

No challenged requirement is removed without a product decision.

| Requirement | Complexity cost | Current evidence | Recommendation | Decision needed |
|---|---:|---|---|---|
| Disabled `deps` command implementation remains in production source | Disabled bodies, help comments, engine hydration evaluator, tests, and aliases create a shadow product | Dispatch/help explicitly disable it; automatic post-sync drift nudge is separate and live | Prove external reachability, then delete disabled command implementation while retaining the live nudge | Confirm no supported external/script entry and no planned support window |
| Every internal rollout/tuning knob is an untyped `RBOX_*` environment variable | Cross-cutting branches and hidden process protocol | Large inventory mixes public config, rollout, tests, diagnostics, and internals | Introduce an internal typed runtime settings snapshot; preserve public vars and active kill switches | Classify public/support/rollout/test-only and give rollout vars deletion gates |
| Status performs maintenance writes | Read path needs mutation authority and makes aggregation risky | Deferral hygiene and related recovery can occur during detail status | Move to explicit runtime maintenance while preserving current user-visible healing | Decide whether status synchronously waits for maintenance or reports it pending |
| Command metadata permits undocumented hidden flags | Separate arity/validation authority | Setup/init/track retain hidden allowlists | Declare hidden supported flags in the catalog with visibility metadata | Decide whether each hidden flag is supported, internal, or retirement-bound |
| Daemon has separate mutation composition for performance/reliability | Duplicated rules and wide state machine | Real fast paths, recovery probes, and evidence-carrying triggers exist | Keep scheduling/evidence in daemon, move mutation execution to `LocalRuntime` | None for behavior; performance gates decide cutover |
| JSON and SQLite state implementations coexist | Dual authority, format adapters, migration machinery | U3 migration is active and has exact rollout gates | Preserve behind `WorkspaceStore`; delete legacy only after fleet gate | Existing U3 owner/fleet decision |
| Fine-grained Git protocol types cross Module boundaries | Very high concept count | Some are required at physical/logical boundary; many only relay one in-process phase | Internalize plans/receipts; export only complete outcomes and opaque evidence | Per transition: prove whether another Module genuinely varies/consumes it |

## 7. Reachability candidates and proof state

No candidate is approved for deletion yet.

| Candidate | Current proof | Missing proof |
|---|---|---|
| `src/cli/hydrate-cmd.ts` | `deps` dispatch and aliases are commented; no live command | scripts/automation/docs/owner/support-window check |
| `src/cli/deps-notify.ts` | Its production command path is disabled | preserve the distinct live `deps-drift.ts` post-sync nudge |
| `src/engine/doctor.ts` | Production consumer appears to be disabled hydration doctor | ensure no package/API embedding; do not confuse with state migration health |
| `src/cli/lock-doctor.ts` | No obvious command/import/package entry | generated load, external automation, owner |
| `src/engine/sha256-stream.ts` | No obvious CLI consumer | API Worker build inventory still includes it; owner/build check |
| Pass-through barrels/wrappers | Some add no behavior | supported import/package/embedding compatibility |
| Legacy JSON state path | Superseded direction exists | active U3 fleet/support gate has not closed |

A deletion requires command/alias, import/export, build/bundle/generated-load,
script/hook/CI/installer, docs/runbook, persisted/wire support window, external
automation, and owner evidence.

## 8. Implementation cycles

### Cycle 0 — characterize and gate

- Check in command/flag/alias/help/output parity.
- Record current import cycles, concept counts, hot-file sizes, and runtime
  environment knobs.
- Preserve the current known baseline failures on the available Bun runtime.
- Establish p50/p95 fixtures for cached status, no-op sync, watcher publish,
  notify apply, scans, Git capture/apply/follow, first publish, and daemon idle.

### Pre-U3 exclusion

Until U3 ships and its compatibility gates close, this refactor makes no
structural changes to `state-plane/**`, `sync-state*`, reset/recovery/genesis
machinery, state-related `config.ts` paths or entry points, persisted state
shapes, state-save/CAS inputs or ordering, caller-visible migration
capabilities, or daemon state-CAS integration.

Binding/provisioning is therefore deferred. The eventual operation is
`LocalRuntime.bind(...)`, with `WorkspaceBinding` as its internal inspect/plan
component. It will hold one lease across rebind authorization, remote create,
binding/config/state publication, and the complete initial push,
pull-then-push, or no-sync transaction, returning `InitOutcome`. That later
tranche will delete `workspaceFlags`, `PrecreatedWorkspaceContinuation`,
`adoptPrecreatedWorkspaceResources`, and
`continueInitWithPrecreatedWorkspace`; no temporary `WorkspaceProvisioner`
Module will be introduced.

### Cycle 1 — delete bounded orchestration protocols

Land two independent, current-snapshot tranches before widening the
composition root:

1. **`DaemonObservation`:** make one closed observation own process identity,
   binding attribution, boot agreement, ambient freshness/future-skew, and
   whether daemon-owned status is trustworthy. Route doctor, machine triage,
   and status through it. Remove `daemonBindingStatus` as an independent truth
   calculation, direct PID/boot/freshness reconstruction from
   `doctor-machine.ts`, duplicate evidence gating from `doctor-evidence.ts`,
   and reduce `status-view.ts::attributeDaemonForStatus` to presentation over
   the closed observation.
2. **received Git config lane:** make a private `GitReplica` detail that binds
   repository identity, immutable prior lane, source sequence, and effect
   adapters once. It returns the existing `ConfigLaneState` transition to its
   immediate apply caller, which writes the existing in-flight `configLane`
   map. It does not change state shapes, `sync-state*`, CAS inputs, or commit
   ordering. Internalize the public phase/plan/executor/receipt/identity-echo
   protocol.

These are deliberately not new framework layers. Each absorbs one existing
protocol and deletes invalid caller combinations.

The received-config implementation preserves its three real execution windows
structurally: existing/config-only, fresh/after-materialization, and
follow/common-dir-locked. The locked operation receives an unforgeable scope
from the actual common-directory lock holder; fresh application is
unrepresentable before materialization. Public protocol types disappear only
after those constraints replace their mismatch checks.

The entry-arena audit found a fourth large simplification opportunity, but it is
active U0 work with no production caller. Keep it as a separate follow-up
design so this CLI/daemon refactor does not mix application architecture with
an unintegrated engine optimization.

### Cycle 2 — `CommandShell`

- Make one closed command catalog drive help, arity, repeatability, validation,
  aliases/deprecations, completion, known-command classification, and lazy
  dispatch lookup.
- Keep the existing switch handlers initially, then move handler selection into
  the catalog one group at a time.
- Delete duplicate maps/inference only after byte/exit parity.

This follows the first typed use-case owners so the command catalog describes
the desired application boundary rather than cementing accidental status/doctor
orchestration. Command descriptors own syntax only. Domain validation remains
in typed use-case inputs; catalog migration may route handlers but must never
absorb workspace, auth, sync, daemon, doctor, or update orchestration.

### Cycle 3 — `LocalRuntime` mutation boundary

- Introduce one operation context with held lease, mutation gate, recovery
  boundary, restricted store/journal operations, and reporting sink.
- Route foreground pull/push/sync first.
- Route reset/recover/adopt/restore/Git resolution next.
- Route daemon maintenance evidence through the same operations without
  weakening watcher, Git-signal, WS, retry, or cache fast paths.
- Delete caller-specific assembly as each differential cutover lands.

### Cycle 4 — `WorkspaceObservation`

- Collect status/doctor facts once.
- Make evaluation and renderers pure.
- Keep aggregate summary bounded and one-root detail explicit.
- Move hidden maintenance into a runtime operation.

### Cycle 5 — deepen `FileReplica` and `RemoteWorkspace`

- Internalize scan/apply actions and transfer/publication protocols.
- Preserve one workspace traversal and all fast paths.
- Break sync/remote import cycles by replacing protocol-phase exports with
  complete outcomes.

### Cycle 6 — deepen `GitReplica`

- Move follow, apply, capture, resolution, status, and physical recovery behind
  the five complete operations.
- Introduce the complete private `RepositoryState` reducer when all `RepoRecord`
  lanes can move together; replace the transitional in-flight lane maps in one
  behavior-differential sequence.
- Internalize plans/receipts/proofs that have no genuine outside consumer.
- Keep logical state commits exclusively in `LocalRuntime`.

### Cycle 7 — shrink `DaemonLoop`

- Leave scheduling, subscriptions, liveness, key delivery, telemetry, and
  wind-down.
- Remove file/Git/remote/state transition implementation.
- Retire the `daemon.ts` size exception only when the shared mutable-state
  colocation reason is actually gone.

### Cycle 8 — retire gated compatibility

- Delete only fully proven dead code.
- Retire JSON/rollout paths only after the U3 fleet gate.
- Remove flags, tests, formats, and docs in the same retirement change.

## 9. Validation gates

1. **Differential:** old/new primitive on identical file, Git, state, remote,
   scope, credential, and command fixtures.
2. **Crash:** kill before/after every file/Git/remote effect and logical commit.
3. **Compatibility:** released-old, current, and candidate binaries across
   state/reset/wire formats.
4. **Foreground/daemon:** live, absent, broken, simultaneous, stale owner,
   reboot, upgrade, and shutdown.
5. **File:** unreadable, mass delete, type flip, concurrent edit, conflict,
   trash, ignore, scope, watcher trust/fallback.
6. **Git:** nested/pointer/linked, packed refs, index/op-state/stash, branch
   deletion, tombstones, P/A/K, keep/take, recovery.
7. **Remote:** anti-rollback, epoch, delta/snapshot, missing blobs, receipts,
   packs, old-server fallback, uncertain ACK.
8. **CLI:** every command/flag/alias/help/JSON/error/exit/prompt/progress stream.
9. **State:** JSON/SQLite differential, U3 coordinator/genesis/migration/retry,
   reset, no-regression, and SQLite-free static graph where still required.
10. **Performance:** checked-in A/B p50/p95 plus one-traversal assertion.
11. **Packaging:** typecheck, compiled CLI, watcher/crypto self-tests, and rig.

Cycle-1 `DaemonObservation` specifically covers absent/malformed/dead/reused
PID, absent or mismatched binding, missing/corrupt/stale/future ambient record,
boot mismatch, and live-but-unreported daemon. It preserves doctor
inconclusive-versus-failed distinctions and prevents stale sidecars from
becoming live truth.

Cycle-1 received-config specifically preserves scoped-config rejection,
credential exclusion, warning-once behavior, shape invalidation, wire-absence
healing, kill-switch behavior, pointer/linked-worktree ownership, independent
config retry, follow-lock serialization, and clean materialization. Physical
config mutation completes before logical state is returned. Failure leaves the
lane byte-exact. A crash after atomic replacement but before store commit must
reconstruct the same lane from disk without creating a corrective publication.
Fresh completion derives hashes, shape, and token from the installed config.
Sanitize-present and wire-absent remain logical-only transitions; post-commit
warning failures remain non-fatal. Removed phase-mismatch tests are replaced by
behavior tests proving that fresh config cannot write before materialization and
follow config cannot write outside the held common-directory lock.

Baseline failures are recorded honestly and compared like-for-like. Tests or
safety checks are not weakened to make an incapable environment green.

## 10. Architecture gates and success criteria

- Production import graph trends to acyclic and may not gain a cycle.
- Only `LocalRuntime` sequences two or more runtime data Modules.
- Only a held lease can obtain the writable store boundary.
- Commands and daemon do not import data-Module internals after their cutover.
- Command behavior has one catalog authority.
- Ordinary store open cannot initiate migration.
- U3 migration Interfaces do not leak into ordinary callers.
- No public plan/receipt/authority type without a real cross-Module consumer.
- Internal Modules do not import their own barrel.
- A new Module must pass the deletion test: removing it would make complexity
  reappear in several callers.
- Files over 1,000 lines require a documented colocation invariant; splitting
  for line count alone is rejected.
- Foreground and daemon mutations share one implementation.
- Status and doctor share one observation.
- Git functionality is complete behind one deep Interface.
- Code deletion exceeds code movement over the full program.
- Differential, crash, compatibility, rig, and performance evidence show no
  supported behavior regression.

## 11. Explicit non-approval

This design does **not** approve:

- removing a command, alias, flag, output, prompt, or headless path;
- weakening Git safety or dropping a Git lane because it looks complicated;
- deleting any state-plane migration/readiness/reset Module;
- retiring JSON or another persisted/wire format before its support gate;
- replacing one traversal/fast path with unconditional full work;
- deleting any reachability candidate without the complete proof;
- creating a generic service container, framework, or port/plan/receipt layer
  that merely renames existing calls;
- moving code into more files without reducing concepts or caller knowledge.

## 12. Cycle-1 implementation outcome

The first bounded tranche landed three independent authority reductions:

1. `daemon/observation.ts` now owns the complete read-only daemon verdict used
   by status and doctor. Process identity is a lower-level primitive; lifecycle
   code retains mutation and compatibility re-exports.
2. `help-registry.ts` is now the typed command-grammar authority for flag
   arity/repetition/visibility, aliases, help, completion, and command
   classification. `command-catalog.ts` and `deprecations.ts` were deleted.
3. `createReceivedGitConfig` binds one repository, its prior lane, its wire
   input, effects, and held common-directory scope. The former public
   plan/phase/executor/receipt/ledger vocabulary was deleted without changing
   the caller's `ConfigLaneState` map or state-CAS order.

The implementation does not touch `state-plane/**`, `sync-state*`, reset,
genesis, persisted state shapes, migration capabilities, or CAS sequencing.
`docs/CODEMAP.md` records every changed owner.

Validation re-measured in the PR-remediation worktree:

```text
$ bun test ./src/cli/sync-git/received-git-config.contract.test.ts
bun test v1.4.0-canary.1 (6c12afd8e)

 19 pass
 0 fail
 47 expect() calls
Ran 19 tests across 1 file. [534.00ms]
```

```text
$ bun test ./src/cli/sync-git/clean-materialization.contract.test.ts
bun test v1.4.0-canary.1 (6c12afd8e)

 18 pass
 0 fail
 52 expect() calls
Ran 18 tests across 1 file. [66.00ms]
```

```text
$ bun test ./src/cli/sync-git/sync-git-config-pull.test.ts
bun test v1.4.0-canary.1 (6c12afd8e)

 12 pass
 0 fail
 76 expect() calls
Ran 12 tests across 1 file. [2.00s]
```

```text
$ bun test ./scripts/rig/
bun test v1.4.0-canary.1 (6c12afd8e)

 153 pass
 0 fail
 547 expect() calls
Ran 153 tests across 24 files. [1074.00ms]
```

The live two-device rig was not run in this documentation-only remediation.

No feature or compatibility deletion is approved by this implementation.

## 13. Runtime primitive wave outcome

The second implementation wave landed three behavior-preserving ownership
reductions without entering the U3 exclusion zone:

1. `LocalRuntime` is the sole foreground composition owner for pull, push, and
   pull-then-push sync. It holds one workspace lease across authenticated remote
   construction, reporting, the complete mutation, presentation completion, and
   the advisory drift check. `main-dispatch.ts` no longer imports sync engines,
   remote construction, reports, or progress projection; it still imports
   `withWorkspaceSyncMutex` for export, restore, and Git republish. `LocalRuntime`
   remains the sole workspace-mutex owner for foreground pull, push, and sync.
   Only reachable direct/sync mass-delete policies are representable.
2. `WorkspaceObservation` owns bounded config/daemon attribution and the
   explicitly ambient/local observations shared by status and doctor. Status
   retains its reset-halt fast path and defers activity I/O until admitted.
   Diagnostic sidecars are read through one exact operation that validates the
   workspace binding both before and after the read, discarding bytes if a
   daemon rebinds during collection. The observation is deliberately documented
   as non-atomic; it does not claim a filesystem snapshot or hide maintenance.
3. `materializeCleanGit` replaces the clean/fresh receive path's public
   planner, bound/refused plans, config phase, effects port, physical receipt,
   identity echo/mismatch error, and executor. Ignore-first containment,
   capable-lineage admission, lazy local-ref reads, wipe authority, typed A/P/K
   mutation, Git-before-config ordering, BASE/pending/partial composition, and
   deferral precedence remain inside the one complete operation.

The first adversarial implementation review rejected two drafts. The accepted
code removes the proposed always-open foreground shutdown gate, keeps drift
inspection under the lease, removes an impossible pull-consented/push-guarded
state, keeps CLI remedy copy outside the runtime, closes the test-only services
bypass, and hardens diagnostic attribution against a mid-read rebind. These are
implementation corrections, not deferred findings.

Protected functionality remains the ledger in section 2. No command, flag,
output, wire/persisted shape, state-plane path, CAS order, daemon scheduling
path, migration/readiness capability, Git lane, or fast path was retired. The
only deletion candidates executed in this wave were internal protocols with a
single immediate caller and no package/script/barrel consumer. All challenged
product requirements in section 6 remain preserved pending their decisions.

The received-config, clean-materialization, config-pull, and rig commands and
raw output above are the re-measured validation for this wave. Earlier unscoped
aggregate and host-failure counts are intentionally removed because they did
not name a reproducible file set or command. Live rig preflight was not run in
this documentation-only remediation.

This wave does not claim that all later cycles are complete. Daemon mutation
cutover, complete state-snapshot consolidation, remaining Git operations,
FileReplica, RemoteWorkspace, and gated compatibility retirement remain
separate behavior-differential cycles.
