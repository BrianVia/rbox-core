# Agent-ergonomics structural-refactor roadmap

Date: 2026-07-26

Audited commit: `77350e629769998a62b86f6c80fd293eefc88e93`

Scope: read-only structural review of:

- `src/cli/daemon/daemon.ts` — 3,790 lines;
- `src/cli/sync-git/apply.ts` — 2,291 lines;
- `src/cli/sync/push.ts` — 1,108 lines; and
- `src/cli/status-cmd.ts` — 922 lines.

No product code was changed for this review.

This roadmap supersedes the decomposition ordering in the two 2026-07-24
thermo-nuclear sweeps for these four files. It does not re-report completed
work: #422 (config split), #423 (git-command split), #425 (command hygiene),
or #448 (engine Git-state split).

## Decision

The target architecture is the semantic-transition mapping from
`2026-07-24-git-operation-mapping-and-worktree-reconciliation-audit.md`:

```text
one named rbox transition
  -> one deterministic, inspectable effect plan
  -> one execution receipt bound to that exact plan
  -> one durable Git BASE/state transition bound to that receipt
```

The optimization objective is **agent ergonomics**. A decomposition succeeds
only when a fresh agent changing one behavior can safely stop after reading:

1. the named transition contract;
2. its planner/executor/receipt;
3. one focused contract test; and
4. the narrow caller that composes it.

Moving a giant function, preserving mutable maps as `Context`, or adding a
re-export facade does not meet that bar. File size is evidence, not the
objective.

## Current context burden

| Hotspot | Structural burden |
|---|---|
| `daemon.ts` | `RboxDaemon` declares 162 private fields. Activity, WS state, the retained `Manifest`, `syncBase`, matcher state, wants, timers, recovery, and discovery authority are mutually reachable. Daemon tests cast through private internals because no public semantic seams exist. |
| `apply.ts` | `applyGitSections` spans 1,611 lines; nested `processRepo` is about 1,250 lines. Observation, recovery, absence, config, clean apply, divergent follow, proof creation, state composition, scheduling, and metrics share mutable output maps. |
| `push.ts` | `runPushAttempt` spans 651 lines. Candidate planning, pre-ACK saves, upload, remote commit, 409/422/epoch handling, keep-mine receipt handling, and accepted-ACK BASE advancement are one unit. |
| `status-cmd.ts` | `statusCmdWithDeps` spans 570 lines. It performs reset inspection, durable deferral hygiene, cache writeback, daemon attribution, disk/Git observation, remote/account probes, and three presentations. Several reads remain hidden globals. |

The current `GitPullOutcome` is not an execution receipt. It is a collection
of optional transition maps, proofs, metrics, journals, and callbacks that
`pull.ts` interprets again. Design 163 cannot adapt cleanly to seams that
expose `SyncState`, retained `Manifest`, `Action[]`, or whole-repository maps.
Its named ports require lineage snapshots, bounded plans, execution receipts,
repo-transition packets, and bounded status/outcome projections.

## Ranking method

For each cycle:

- `D` is the count of upcoming lanes for which the seam is a **direct
  prerequisite**: design 163 (`163`), the git-plan discovery successor
  (`DISC`), or the CLI surface rework (`CLI`). Each direct lane is worth 3.
- `E` is the count of those lanes that the seam materially **enables** but
  does not block. Each enabling lane is worth 1.
- `C` is agent-context reduction: 0 = cleanup only; 1 = a focused transition
  owner; 2 = removes a whole-state or authority dependency from that
  behavior's safe-change set.
- `V = 3D + E + C`.
- `R` is inherent risk: 1 = pure/presentation; 2 = read-only projection or
  non-authoritative queued side surface; 3 = effectful I/O or locked
  non-BASE transition; 4 = BASE/state authority, recovery, or multi-writer
  semantics. Existing tests do not lower inherent risk.
- `S` uses the **upper bound** of expected moved nonblank lines: 1 = up to
  200; 2 = 201–350; 3 = 351–550; 4 = over 550.
- `Priority = V / (R × S)`.

Movement is ownership leaving the named hotspot, not net deletion. Estimates
after a prerequisite exclude code already moved by that prerequisite.
Score ties are ordered by more direct lanes, then lower risk, then lower size.
Exact ties share a priority; their displayed order follows the dependency
waves below. Dependencies govern execution order, not the score.

| Rank | Cycle | Hotspot | Direct | Enabling | V | R | S | Score | Movement |
|---:|---|---|---|---|---:|---:|---:|---:|---:|
| 1 | `AcknowledgePublishedGitTransitions` | push | 163, DISC | — | 8 | 4 | 1 | 2.00 | 135–175 |
| 2 | `RenderWorkspaceStatusSurface` | status | CLI | — | 4 | 1 | 2 | 2.00 | 300–350 |
| 3 | `RecordGitCaptureObservation` | push | 163 | DISC | 5 | 3 | 1 | 1.67 | 95–125 |
| 4 | `ProjectWorkspaceStatusDetail` | status | 163 | CLI | 6 | 2 | 2 | 1.50 | 260–340 |
| 5 | `CommitLocalObservation` | daemon | 163 | DISC | 6 | 4 | 1 | 1.50 | 120–180 |
| 6 | `RecoverStateAuthorityAtDaemonBoundary` | daemon | 163 | — | 5 | 4 | 1 | 1.25 | 130–180 |
| 7 | `RefreshStatusDeferralAssertions` | status | 163 | CLI | 5 | 4 | 1 | 1.25 | 35–60 |
| 8 | `SettleStandingBranchProof` | apply | 163 | — | 5 | 4 | 1 | 1.25 | 130–165 |
| 9 | `PublishLocalWorkspaceTransition` | daemon | 163 | DISC | 5 | 4 | 1 | 1.25 | 120–170 |
| 10 | `ExecuteManifestCommit` | push | 163, DISC | CLI | 9 | 4 | 2 | 1.13 | 180–225 |
| 11 | `PreparePublishCandidate` | push | 163 | DISC | 6 | 3 | 2 | 1.00 | 180–240 |
| 12 | `MaintainGitDiscoveryContinuity` | daemon | DISC | 163 | 6 | 3 | 2 | 1.00 | 230–300 |
| 13 | `ObserveLocalWorkspace` | daemon | 163 | DISC | 6 | 3 | 2 | 1.00 | 250–340 |
| 14 | `PublishDaemonRuntimeObservation` | daemon | — | 163, CLI | 4 | 2 | 2 | 1.00 | 250–310 |
| 15 | `ApplyReceivedGitConfig` | apply | 163 | — | 5 | 3 | 2 | 0.83 | 240–285 |
| 16 | `ReconcileRemoteRepositoryDeletion` | apply | 163 | — | 5 | 4 | 2 | 0.63 | 175–210 |
| 17 | `PlanAndMaterializeReceivedRepository` | apply | 163 | — | 5 | 4 | 2 | 0.63 | 225–275 |
| 18 | `ComposeFollowRepoTransition` | apply | 163 | — | 5 | 4 | 2 | 0.63 | 175–225 |
| 19 | `CommitReceivedGitTransition` | apply/pull | 163 | — | 5 | 4 | 2 | 0.63 | 305–350 |
| 20 | `ApplyRemoteWorkspaceTransition` | daemon | 163 | — | 4 | 4 | 3 | 0.33 | 280–360 |
| 21 | `ServiceNextDaemonOperation` | daemon | — | 163 | 3 | 4 | 4 | 0.19 | 450–560 |

The table is authoritative and must be re-sorted if estimates change.

## Cycle contracts

### `AcknowledgePublishedGitTransitions`

This is the receipt-driven state transition missing from the current
architecture. It alone derives advertised refs, publisher-ACK authority,
incoming keys, BASE, pending clears, partial/attempt retirement, and
resolution-receipt retirement from an accepted publication.

The planner seals a `PublicationIdentity`:

```ts
interface PublicationIdentity {
  candidateHash: string;
  parentSequence: number;
  stream: string;
  lineageToken: string;
  resolutionEpisode?: string;
}

acknowledgePublishedGitTransitions(
  candidate: SealedPublishedCandidate,
  accepted: AcceptedPublicationReceipt,
  state: RepoTransitionPort,
): Promise<
  | { kind: "acknowledged"; receipt: PublisherAcknowledgementReceipt }
  | {
      kind: "accepted-state-pending";
      publication: AcceptedPublicationReceipt;
      transitionId: string;
      reason: StatePersistenceFailure;
    }
>
```

Both candidate and receipt carry the exact `PublicationIdentity`; mismatch is
a typed refusal before BASE composition. Freeze first in a focused
`publisher-ack-transition.contract.test.ts`:

- matching plan/receipt advances the exact repository rows and sequence;
- any identity-field mismatch performs no state transition;
- pending BASE does not advance;
- settled pending clears only the exact partial/attempt/deferral/resolution
  sidecars; and
- ordinary or keep-mine state-save failure after remote acceptance returns the
  bound `accepted-state-pending` result without pretending BASE advanced.

Keep the existing design-200 structure guard, pending/ACK integration tests,
and lost-ACK tests as regression gates, relocating syntax ownership to this
sole constructor. Risk: **critical**. Direct: **163, DISC**. Movement:
135–175 lines.

### `RenderWorkspaceStatusSurface`

After `ProjectWorkspaceStatusDetail`, `status-cmd.ts` becomes
`refresh if allowed -> project once -> select renderer -> emit`. Do not move
rendering into the already-large `status-view.ts`.

```ts
renderStatusJson(projection: WorkspaceStatusProjection<"json">): JsonValue
renderStatusBrief(projection: WorkspaceStatusProjection<"brief" | "git">): string[]
renderStatusVerbose(projection: WorkspaceStatusProjection<"verbose">): string[]
```

Renderers perform zero I/O and accept only their mode's projection. Freeze
first with the existing exact verbose golden, brief-vs-verbose suppression,
JSON health/halt, and shared Git-line tests, plus a direct test that each
renderer rejects no data by reaching outside its input. Risk:
**low-to-medium** because output is public but golden coverage is strong.
Direct: **CLI**. Movement: 300–350 lines. Dependency:
`ProjectWorkspaceStatusDetail` must land first even though this cycle's ratio
is higher.

### `RecordGitCaptureObservation`

This transition owns the durable pre-publication observation of capture/config
deferrals, packed-ref identity, pending protection, and file-byte
intersection. Its input is a bounded projection, not the whole `GitPushPlan`.

```ts
recordGitCaptureObservation(
  state: RepoObservationWritePort,
  token: LineageSnapshot,
  observation: GitCaptureObservation,
): Promise<CaptureObservationReceipt>
```

Freeze first in `git-capture-observation.contract.test.ts`:

- exact observed repository set and accepted state revision;
- exact capture/config lane updates;
- protected pending is untouched; and
- a no-change observation performs no write.

Keep the current pre-ACK sidecar, standing-deferral, and all-hit plan tests as
regression gates. Risk: **high** because this is a generation-CAS state write,
though it does not mint BASE. Direct: **163**; enabling: **DISC**. Movement:
95–125 lines.

### `ProjectWorkspaceStatusDetail`

This is pure read-only projection after `RefreshStatusDeferralAssertions`. It
owns reset short-circuiting, daemon attribution, trusted-vs-scanned local
observation, Git projection, mode-specific remote/account probes, locking,
trash, and path warnings. It does not reconcile deferrals or write hashcache.

```ts
projectWorkspaceStatusDetail<M extends StatusMode>(
  root: string,
  request: StatusRequest<M>,
  port: StatusReadPort<M>,
  refresh: StatusRefreshReceipt,
): Promise<WorkspaceStatusProjection<M>>
```

The mode discriminant preserves current I/O:

- JSON alone fetches account usage;
- verbose alone fetches account summary/metrics;
- brief alone reads identity/update state;
- Git detail alone computes companion detail.

`StatusReadPort` owns every read; no hidden config/state/activity/reset/account
or trash globals remain. Under design 163 it is backed by the bounded
read-only `StatusProjectionPort`, never whole `SyncState`.

Freeze first in `status-projection.contract.test.ts`:

- one invocation performs one projection and its renderer performs zero I/O;
- reset halt never dereferences state;
- trusted local skips hashcache and manifest scan;
- base mismatch re-reads before fallback scan; and
- each mode performs only its admitted probes.

Existing JSON/verbose/Git parity tests remain regression gates. Risk:
**read-only medium**. Direct: **163**; enabling: **CLI**. Movement:
260–340 lines.

An all-workspaces CLI must not map this detail projection over every
workspace. CLI rework needs a separate bounded `WorkspaceStatusSummary`
contract over registry/ambient/indexed state; detailed scan/network fallback
remains one-root-only.

### `CommitLocalObservation`

This transition alone advances LOCAL head/revision/completeness from a sealed
observation receipt produced by `ObserveLocalWorkspace`.

```ts
commitLocalObservation(
  snapshot: LineageSnapshot,
  receipt: SealedLocalObservationReceipt,
  state: LocalAuthorityPort,
): Promise<LocalObservationCommitReceipt>
```

The observation and commit carry the same identity:
`{observationId, lineageToken, priorLocalRevision, logicalDigest}`. Mismatch,
replay, or stale revision performs no transition. Freeze first in
`local-observation-transition.contract.test.ts`:

- complete scan advances exactly once;
- incomplete/deferred scan cannot authorize deletion;
- watcher patch touches only named paths;
- receipt replay is idempotently rejected/recognized; and
- identity mismatch performs no write.

Risk: **critical**—LOCAL and deletion authority. Direct: **163**; enabling:
**DISC**. Movement: 120–180 lines after `ObserveLocalWorkspace`.

### `ExecuteManifestCommit`

This executor consumes a fully sealed `ManifestCommitEffectPlan`; it performs
no delta/snapshot choice or other planning. It owns exact wire materialization,
keep-mine authority arming immediately before POST, remote commit, and
response classification.

```ts
executeManifestCommit(
  plan: ManifestCommitEffectPlan,
): Promise<ManifestCommitExecutionReceipt>
```

Every result carries the plan's exact `PublicationIdentity`. The result is a
closed union:

- `accepted`;
- `conflict`;
- `epoch-stale`;
- `unsatisfied`;
- `ack-uncertain`; or
- `resolution-transition`.

The last variant contains a nested closed receipt for keep-mine arm, POST,
disarm/reload, lost-ACK reconciliation, conflict pull, and authentication
failure. No failure-capable work may occur between durable arm and POST.

Freeze first in `manifest-commit-executor.contract.test.ts`:

- exact plan bytes/identity reach POST;
- keep-mine arm is immediately followed by POST;
- each response maps to one exact receipt;
- disarm/reload occurs on epoch/422;
- lost ACK reconciliation and resolution-conflict pull are explicit; and
- the executor never advances BASE.

Keep ordinary 409/422/epoch and design-177 integration tests. Risk:
**critical**. Direct: **163, DISC**; enabling: **CLI**. Movement:
180–225 lines.

### `RecoverStateAuthorityAtDaemonBoundary`

This transition owns reset-journal classification, halt/retry state,
three-way bootstrap agreement, and the unconditional pump boundary. It does
not own scheduling.

```ts
ResetRecoveryController.advance(input): Promise<
  | { kind: "unchanged-ready" }
  | { kind: "recovered"; stateHead: StateHead }
  | { kind: "halted"; reason: string; journalIdentity: string; retryAt: number }
>
```

The design-163 version is scheduled after its store/migration port exists; do
not extract a legacy `SyncState` controller only to rewrite it immediately.
Freeze `reset-halt-state.test.ts` plus
`reset-boundary.contract.test.ts`: one input yields one receipt and performs
no daemon scheduling. Risk: **critical recovery/state authority**. Direct:
**163**. Movement: 130–180 lines.

### `RefreshStatusDeferralAssertions`

Status currently hides an authority-changing write: deferral hygiene can
recover locks and apply a repo-transition CAS. Separate it from read-only
projection.

```ts
refreshStatusDeferralAssertions(
  root: string,
  writer: StatusMaintenancePort,
): Promise<StatusRefreshReceipt>
```

It is invoked only for one-root detail status under the current writer
ownership rules; all-workspaces summary never calls it. Design 163 may
delegate hygiene to the daemon/single writer rather than let a read-only
connection mutate state.

Fallback hashcache save remains a tiny, explicit best-effort effect in
`status-cmd.ts`'s composition root. It consumes `StatusCacheHint` emitted by
the detail projection, returns `StatusCacheWriteReceipt`, never changes
authority, and is not counted as part of this transition.

Freeze first in `status-maintenance.contract.test.ts`: success returns the
fresh state token; unavailable writer preserves prior durable deferrals;
multi-workspace summary triggers zero maintenance; cache ownership loss skips
writeback in the separate composition-root cache-effect test. Risk:
**critical** for hygiene's recovery/state-CAS path. Direct: **163**;
enabling: **CLI**. Movement: 35–60 lines of command orchestration; the
canonical hygiene implementation remains in its owner.

### `SettleStandingBranchProof`

Extract a bounded proof transition, not a moved closure:

```ts
settleStandingBranchProof(input: {
  lineage: LineageSnapshot;
  relPath: string;
  expectedRepoGeneration: number;
  expectedIncomingKey: string;
  priorAttempt?: HeldAttemptToken;
  protocol: BoundFollowerProtocol;
  retryBudget: number;
}, effects: StandingProofPort): Promise<
  | {
      kind: "settled";
      refreshedLineage: LineageSnapshot;
      record: RepoRecordProjection;
      protocol: BoundFollowerProtocol;
      disposition: SettlementDisposition;
    }
  | { kind: "held"; hold: GitTransitionHold }
  | { kind: "retry-exhausted"; lastProof: ProofFailureReceipt }
>
```

No mutable `applied`, `records`, `defer`, or install callback crosses the
seam. Freeze first in `standing-branch-proof.contract.test.ts`: refresh/retry,
prepared-ref rejection, shutdown after prepare, attempt invalidation, and
retry exhaustion. Existing P-repair/P-settlement/held-skip suites remain
regression gates. Risk: **critical proof/recovery authority**. Direct:
**163**. Movement: 130–165 lines.

### `PublishLocalWorkspaceTransition`

This daemon adapter invokes one narrow push port and consumes a closed outcome;
it does not own Git planning.

```ts
PushTransitionPort.execute(
  request: DaemonPushRequest,
): Promise<DaemonPushOutcome>

interface DaemonPushFacts {
  attemptId: string;
  topology:
    | { kind: "none" }
    | { kind: "observed"; observation: CurrentGitTopologyObservation };
  local:
    | { kind: "unchanged" }
    | { kind: "observe"; plan: SealedLocalObservationPlan };
  retry:
    | { kind: "none" }
    | { kind: "git-busy"; repositoryIds: readonly string[]; schedule: LocalRetrySchedule };
  recoveryPull:
    | { kind: "none" }
    | { kind: "applied"; receipt: PullApplyReceipt };
  collisions: CaseCollisionObservationReceipt;
  runtime: DaemonRuntimeObservation;
}

type DaemonPushOutcome = DaemonPushFacts & (
  | { kind: "committed"; publication: AcceptedPublicationReceipt }
  | { kind: "not-committed"; reason: PushNoCommitReason }
  | { kind: "repair-conflict"; receipt: RepairConflictReceipt }
);
```

`PublishLocalWorkspaceTransition` reduces that result into one
`DaemonPublishReceipt`; `MaintainGitDiscoveryContinuity`,
`ObserveLocalWorkspace`, `CommitLocalObservation`, and
`PublishDaemonRuntimeObservation` consume the required topology,
local-observation plan/receipt, and runtime-observation facts. The adapter
passes a sealed local plan to `ObserveLocalWorkspace`, then passes that
receipt to `CommitLocalObservation`; the push engine never fabricates the
observer's output. No optional callback bag crosses the seam.

Freeze first in `daemon-publish-transition.contract.test.ts`: every outcome
variant produces exact downstream receipts, provenance is consumed once,
busy retry is preserved, 409 recovery is attributed, and terminal fingerprint
is carried. Existing daemon Git-capture/activity tests remain regression
gates. Risk: **critical**. Direct: **163**; enabling: **DISC**. Movement:
120–170 lines, excluding collision/retry/local-commit owners assigned below.

### `PublishDaemonRuntimeObservation`

This queued transition owns ordered activity, shell-line, shell-deferral, and
ambient-status publication, including ownership revalidation.

```ts
interface DaemonObservationPublicationTicket {
  id: string;
  settled: Promise<DaemonObservationPublicationReceipt>;
}

DaemonObservationPublisher.publish(input): DaemonObservationPublicationTicket
DaemonObservationPublisher.publishPaused(input): DaemonObservationPublicationTicket
DaemonObservationPublisher.drain(): Promise<void>
```

The receipt reports each surface as
`written | unchanged | ownership-lost`; a chain failure returns
`{kind:"chain-failed", failedSurface, error}` or rejects the ticket exactly as
the frozen current behavior requires. Inputs are immutable scalars and bounded
deferral projections—never `Manifest` or `SyncState`.

Freeze first in `daemon-observation-publisher.contract.test.ts`: one input to
ordered receipt, ownership-loss skip, exact current chain-failure semantics,
and drain. Failure isolation is a separate behavior change, not part of the
move lock.
Keep existing activity/ambient/graceful-stop tests as regression gates. Risk:
**medium queued side effects**, no workspace authority. Enabling: **163,
CLI**. Movement: 250–310 lines and its exclusively owned fields.

### `PreparePublishCandidate`

`planGitSections` is effectful, so this cannot be a pure relocation. One
semantic cycle establishes the nested boundary:

```text
PlanPublishCandidate
  -> GitCaptureEffectPlan
  -> GitCaptureExecutionReceipt
  -> sealed PushDecisionPlan
```

```ts
preparePublishCandidate(
  snapshot: LineageSnapshot,
  local: LocalObservation,
  capture: GitCapturePort,
  policy: PublishPolicy,
): Promise<SealedPushDecisionPlan>
```

The final plan is bound to the capture receipt and `PublicationIdentity`; it
owns file projection/diff, files-first admission, no-op, mass-delete, and the
candidate's bounded/file-backed state. It does not encrypt, upload, POST, or
advance BASE.

Freeze first in `publish-candidate.contract.test.ts`: capture plan/receipt
mismatch; zero-commit no-op; collision authority; files-first fallback;
purge refusal; Git busy/base carry; and no mutating Git effect outside the
capture executor. Keep current sync/git integration tests. Risk: **high
effectful planning**. Direct: **163**; enabling: **DISC**. Movement:
180–240 lines after `RecordGitCaptureObservation` removes
capture-observation persistence.

### `MaintainGitDiscoveryContinuity`

This is behavior-preserving extraction of today's additive plan/signal
discoveries, authoritative scan discoveries, repository kind, and safety-floor
continuity.

```ts
GitDiscoveryContinuity.observe(
  observation: CurrentGitTopologyObservation,
): Promise<CurrentGitTopologyReceipt>
```

Freeze first in `git-discovery-continuity.contract.test.ts`: additive
observation cannot authorize absence; authoritative unpruned scan can;
safety-floor state is preserved; and current registry/topology actions are
exact. Keep daemon safety, ref-watch, trusted-pull topology, and Linux
integration tests.

Candidate epochs, accepted-publication retirement, overflow/restart poison,
rename semantics, and `kindByPath` reconstruction are **not current behavior**
and are not surface-lock refactoring. The DISC design extends this extracted
owner later with:

```ts
acknowledgeDiscoveryCandidate(
  ack: DiscoveryCandidateAcknowledgement,
): Promise<DiscoveryEpochReceipt>
```

It accepts `{candidateEpoch, acceptedPublicationId}`, not a transport receipt.
Risk: **high** because authoritative absence/safety floor are sensitive.
Direct: **DISC**; enabling: **163**. Movement: 230–300 lines, excluding
observation commit and push/pull adapters.

### `ObserveLocalWorkspace`

This unit performs watcher-batch or scan observation and returns a sealed
receipt. It does not advance LOCAL authority.

```ts
observeLocalWorkspace(
  plan: WatchBatchObservationPlan | ScanGenerationPlan,
  effects: LocalObservationEffects,
  retries: LocalRetryQueuePort,
): Promise<SealedLocalObservationReceipt>
```

The receipt contains completeness, deferred/unsettled path cursor, collisions,
matcher generation, cache hints, and the
`MaintainGitDiscoveryContinuity` topology observation.
The observation executor alone owns the bounded per-path
`LocalRetryQueuePort`: executing the sealed plan arms/cancels write-finish and
GC-fence retry IDs, and the receipt reports the exact schedule. The daemon
scheduler receives only typed retry wakeups; it does not own the per-path
queue.

Freeze first in `local-workspace-observer.contract.test.ts`: deferred scan
cannot claim absence, watcher patch observes only named paths, matcher changes
invalidate a scan, collision/deferred facts are bounded, and retry facts are
exact. Keep trusted-pull P-matrix, scan-defer, and watcher regressions. Risk:
**high effectful observation**, no LOCAL commit. Direct: **163**; enabling:
**DISC**. Movement: 250–340 lines after
`MaintainGitDiscoveryContinuity`.

### `ApplyReceivedGitConfig`

Use a discriminated phase plan rather than a dispatcher over the same
conditionals:

```ts
type ReceivedGitConfigPlan =
  | { phase: "sanitize-present"; ... }
  | { phase: "wire-absent"; ... }
  | { phase: "config-only"; ... }
  | { phase: "after-materialization"; ... }
  | { phase: "inside-follow-lock"; commonDirToken: string; ... };

applyReceivedGitConfig(
  plan: ReceivedGitConfigPlan,
  executor: GitConfigExecutor,
): Promise<GitConfigExecutionReceipt>
```

The executor rejects a plan at the wrong phase/lock. Freeze first in
`received-git-config.contract.test.ts`: phase legality, invalid config
baseline/no corrective echo, genuine later edit, pointer/standalone
transition, independent retry, and common-dir serialization. Keep existing
config pull/push tests. Risk: **high locked filesystem mutation**. Direct:
**163**. Movement: 240–285 lines.

### `ReconcileRemoteRepositoryDeletion`

This transition owns genuine wire absence, pending/partial supersession,
removal memory, required journal-key clearing, advisory preservation, and
best-effort empty-skeleton cleanup.

```text
planRemoteRepositoryDeletion
  -> BoundRemoteRepositoryDeletionPlan
  -> executeRemoteRepositoryDeletion
  -> RemoteRepositoryDeletionReceipt
```

The bound plan covers repository/input identity, required journal clear,
advisory preservation, best-effort skeleton sweep, exact effect order, and
the intended repo transition. Plan and receipt carry the same deletion
identity; mismatch is a typed refusal.

The current code mutates in-memory outcome maps before later durable CAS; it
does **not** durably record absence before preservation. The receipt states:

- required journal clear succeeded;
- advisory conflict preservation succeeded/failed;
- skeleton cleanup was attempted/result;
- the complete repo transition is eligible for later CAS.

Freeze first in `remote-repository-deletion.contract.test.ts`: journal-clear
failure leaves every transition field byte-exact; advisory/skeleton failures
do not falsify required disposition; pending/partial absence cannot resurrect;
and no local `.git` mutation occurs for a genuinely gone repo. Keep
design-207 and pending/deletion integration suites. Risk: **critical state
authority/crash ordering**. Direct: **163**. Movement: 175–210 lines.

### `PlanAndMaterializeReceivedRepository`

Protocol preparation belongs in the planner; the executor consumes an already
bound plan:

```text
planCleanMaterialization
  -> BoundCleanMaterializationPlan
  -> executeCleanMaterialization
  -> CleanMaterializationReceipt
```

The plan binds artifact inventory, repository/worktree identity, branch and
safe-ref witnesses, expected old values, quarantine/wipe authority, config
phase, inverse/recovery action, and intended BASE transition. The executor
performs no authority discovery or protocol preparation.

Freeze first in `clean-materialization.contract.test.ts`: plan/receiver
identity mismatch; recreate-at-removed-path quarantine/wipe; sibling-worktree
hold; no-owner success; missing bundle no mutation; and physical Git plus
intended logical transition asserted from the same receipt. Risk:
**critical Git/state authority**. Direct: **163**. Movement: 225–275 lines.

### `ComposeFollowRepoTransition`

This name is intentionally not “commit”: it is a pure authority composer that
consumes a complete immutable `FollowExecutionReceipt` plus the
`SettleStandingBranchProof` receipt and returns one `RepoTransition`. It
performs no Git or state I/O.

```ts
composeFollowRepoTransition(
  input: FollowCommitInput,
  execution: FollowExecutionReceipt,
  proof: StandingBranchProofReceipt,
): RepoTransition
```

The preceding follow executor work must first make its result complete:
terminal refs/index/op-state, held refs, inverse/recovery disposition, proof
artifact state, and exact input identity. Freeze first in
`follow-repo-transition.contract.test.ts`: each disposition to exact record,
receipt/input mismatch, held-skip, terminal carry, and squash-prune physical
refs plus intended BASE. Keep the full follow suite as regression. Risk:
**critical proof/BASE composition**. Direct: **163**. Movement: 175–225 lines.

### `CommitReceivedGitTransition`

This transition owns exact-ref revalidation, common-dir state-CAS locks,
unreadable-terminal carry fallback, durable save, journal clear, A/P/K
settlement, and held-attempt rebinding.

```ts
commitReceivedGitTransition(
  receipt: GitApplyExecutionReceipt,
  state: RepoTransitionPort,
): Promise<
  | { kind: "not-committed"; reason: CommitRefusal }
  | { kind: "committed-and-settled"; transitionId: string; stateHead: StateHead }
  | { kind: "committed-settlement-pending"; transitionId: string; stateHead: StateHead; pending: SettlementCursor }
>
```

`transitionId` is durably bound to the receipt/expected generations. Replay
uses an explicit CAS/idempotency rule; TypeScript shape alone does not claim
single consumption. The result models current non-atomic reality: BASE CAS
can succeed before journal/A/P/K settlement, which may remain pending.

Freeze first in `received-git-transition-commit.contract.test.ts`: plan/receipt
mismatch, CAS refusal, crash after CAS, settlement replay, shutdown between
CAS/settlement, exact-P settlement, terminal carry, and held-attempt rebind.
Keep state-CAS real-process tests. Risk: **critical**. Direct: **163**.
Movement: 305–350 lines across `apply.ts` and `pull.ts`.

### `ApplyRemoteWorkspaceTransition`

This daemon adapter invokes one narrow pull port and consumes a closed
outcome; it does not own Git policy.

```ts
PullTransitionPort.execute(
  request: DaemonPullRequest,
): Promise<DaemonPullOutcome>

interface DaemonPullFacts {
  attemptId: string;
  topology:
    | { kind: "none" }
    | { kind: "observed"; observation: CurrentGitTopologyObservation };
  runtime: DaemonRuntimeObservation;
}

type DaemonPullOutcome = DaemonPullFacts & (
  | { kind: "applied"; receipt: PullApplyReceipt; local: { kind: "observe"; plan: SealedLocalObservationPlan } }
  | { kind: "partial"; receipt: PullPartialReceipt; local: { kind: "observe"; plan: SealedLocalObservationPlan } }
  | { kind: "local-untrusted"; reason: TrustedViewRefusal; fallback: ScanFallbackPlan }
  | { kind: "refused"; reason: PullRefusal }
);
```

The daemon returns one `DaemonPullReceipt`; variant-required outputs are
consumed only through
`MaintainGitDiscoveryContinuity`, `ObserveLocalWorkspace`,
`CommitLocalObservation`, and `PublishDaemonRuntimeObservation`. Applied and
partial outcomes supply an observation plan; only
`ObserveLocalWorkspace` may turn it into the receipt consumed by
`CommitLocalObservation`. A
`local-untrusted` result authorizes exactly one scan-backed second
`PullTransitionPort.execute` for the whole daemon transition; both calls share
one parent attempt identity and the final receipt links both child receipts.
Freeze first in `daemon-pull-transition.contract.test.ts`: one engine call for
ordinary variants; exactly two linked calls for the one authorized fallback;
trusted/refused behavior; no-loss stale-entry conflict; mass-delete retry;
watcher-drop/topology fallback; and catch-up generation. Keep the complete
trusted-pull suite as regression, not as the focused seam lock. Risk:
**critical**. Direct: **163**. Movement: 280–360 lines, excluding
local/topology/runtime owners.

### `ServiceNextDaemonOperation`

Extract scheduling last. The scheduler encapsulates, rather than receives,
queue/wants, recovery episode, fairness counters, mutex backoff/starvation,
active operation, stop/gate, single-flight, and drain state.

```ts
DaemonOperationScheduler.request(wakeup: DaemonWakeup): void
DaemonOperationScheduler.service(executor: DaemonOperationExecutor): Promise<void>
DaemonOperationScheduler.stop(): Promise<DaemonSchedulerDrainReceipt>
```

The executor port exposes typed reset, push, pull, scan, and surface
transitions. An alternative pure reducer/interpreter design is acceptable;
splitting queue ownership between caller and scheduler is not.

Freeze first in `daemon-operation-scheduler.contract.test.ts`: fairness,
contention does not consume a request, halt heals only through its matching
operation, wakeup during exit is not lost, and shutdown drains committed
mutation. Keep daemon activity/lock/shutdown suites as regression. Risk:
**critical**. Enabling: **163**. Movement: 450–560 lines and its exclusively
owned fields.

## Current-symbol ownership ledger

This prevents overlapping movement claims:

| Current symbol/region | Sole destination |
|---|---|
| Push pre-ACK deferral save (`push.ts` capture/config sidecar block) | `RecordGitCaptureObservation` |
| Push accepted ACK state construction/save | `AcknowledgePublishedGitTransitions` |
| Push remote commit + resolution receipt response handling | `ExecuteManifestCommit` |
| Push candidate projection/admission + Git capture orchestration | `PreparePublishCandidate` |
| `statusCmdWithDeps` hygiene coordination | `RefreshStatusDeferralAssertions` |
| Status hashcache writeback | explicit best-effort effect retained in the `status-cmd.ts` composition root |
| Status state/disk/network observation | `ProjectWorkspaceStatusDetail` |
| Status JSON/brief/verbose emission branches, including reset render | `RenderWorkspaceStatusSurface` |
| Daemon activity/shell/ambient snapshot, queue, persistence, drain | `PublishDaemonRuntimeObservation` |
| Daemon `doPush` request/outcome reduction only | `PublishLocalWorkspaceTransition` |
| Current daemon topology continuity fields and signal/plan/scan reducer | `MaintainGitDiscoveryContinuity` |
| `applyPendingWatchEvents`, scan observation, collision/defer/retry facts | `ObserveLocalWorkspace` |
| LOCAL head/revision/completeness mutation | `CommitLocalObservation` |
| Daemon `doPull` request/outcome reduction only | `ApplyRemoteWorkspaceTransition` |
| Reset boundary/controller fields and methods | `RecoverStateAuthorityAtDaemonBoundary` |
| Pump fairness/recovery/mutex/queue/single-flight state | `ServiceNextDaemonOperation` |

If an implementation moves a listed symbol in an earlier cycle, later
movement estimates must be reduced; moving it again between extracted modules
is not hotspot reduction.

## Dependency-aware execution waves

The score table is the prioritization. Safe implementation order is:

1. **Status:** `RefreshStatusDeferralAssertions`, then
   `ProjectWorkspaceStatusDetail`, then `RenderWorkspaceStatusSurface`.
2. **Push receipt spine:** `RecordGitCaptureObservation` and
   `PreparePublishCandidate`; `ExecuteManifestCommit`; then
   `AcknowledgePublishedGitTransitions`.
3. **DISC prerequisite:** `MaintainGitDiscoveryContinuity` immediately after
   the push receipt spine. Candidate epoch/ACK behavior remains the successor
   design, not this refactor.
4. **First receive transition:** `ReconcileRemoteRepositoryDeletion`, then
   `ApplyReceivedGitConfig` and `PlanAndMaterializeReceivedRepository`.
5. **Follow/receive commit:** `SettleStandingBranchProof`, then
   `ComposeFollowRepoTransition`, then `CommitReceivedGitTransition`.
6. **Design-163 daemon foundations:**
   `RecoverStateAuthorityAtDaemonBoundary` after the store/migration port
   exists; then `PublishDaemonRuntimeObservation`.
7. **LOCAL authority:** `MaintainGitDiscoveryContinuity`, then
   `ObserveLocalWorkspace`, then `CommitLocalObservation`, then
   `PublishLocalWorkspaceTransition`.
8. **Pull and scheduling:** `ApplyRemoteWorkspaceTransition`, then
   `ServiceNextDaemonOperation`.

Every implementation cycle must:

- create its focused contract test before moving behavior;
- preserve exact output, effect order, failure classification, and
  physical-Git-plus-logical-state assertions;
- bind plan, execution receipt, and state transition with an exact identity;
- retain broad existing suites as regression gates, not substitute them for
  a seam test;
- update `docs/CODEMAP.md` for every new/changed owner under governed trees;
- avoid permanent facades unless external import stability requires one; and
- report before/after minimum safe-change context, not only line count.

## Do not schedule as decomposition wins

- Moving `apply.ts` metrics/formatting (~185 lines) or pool scheduling
  (~90 lines): cleanup only; neither changes behavior ownership.
- Moving `processRepo` wholesale: a new ~1,250-line god function.
- Moving `runPushAttempt` wholesale: a new ~650-line file.
- Extracting the push retry loop ahead of candidate/commit/ACK boundaries:
  the typed recovery union already names orchestration; the missing
  architecture is inside the attempt.
- Splitting clean/follow files before bounded inputs and receipts exist.
- Starting with daemon timers, mutex, WS, or drift audit: unrelated lines,
  no required future port. Notification transport can split after
  `ServiceNextDaemonOperation`.
- A generic `DaemonContext`, `ApplyContext`, or optional-map receipt.
- Mapping units to Git porcelain or arbitrary argv wrappers.
- Treating `GitRefWatchRegistry` as discovery authority: it is
  backend-incomplete.
- Calling new DISC epoch/ACK/overflow/restart behavior a behavior-preserving
  surface-lock refactor.

## Target end state

The four files become composition roots:

- `status-cmd.ts`: authorize optional maintenance, project once, render once,
  emit;
- `push.ts`: retry orchestration over sealed candidate plans, bound commit
  receipts, and publisher acknowledgements;
- `sync-git/apply.ts`: order bounded per-repository transitions and collect
  immutable receipts;
- `daemon.ts`: lifecycle wiring plus a scheduler over typed push, pull, LOCAL
  observation, discovery, reset, and surface-publication ports.

The desired review question becomes “does this transition preserve its
plan/receipt/state identity?” rather than “which of 162 fields and five
neighboring giant modules might this branch affect?”
