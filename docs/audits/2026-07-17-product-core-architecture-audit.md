# rbox product core architecture and simplification audit

**Date:** 2026-07-17

**Code baseline:** `3cd77ed` (`main`)

**Scope:** `apps/api`, the CLI under `src/cli`, and the directly coupled sync engine under `src/engine`

**Status:** Investigation complete; recommendations only; no product implementation in this audit

## Executive summary

rbox's core has good conceptual bones. The scan → diff → reconcile → apply model is
understandable, E2EE primitives are mostly isolated from transport, recovery actions
are explicit, and `docs/CODEMAP.md` provides unusually strong ownership language.
The system should not be broadly rewritten.

The main architectural problem is accumulated orchestration gravity. A few modules
now own several independent state machines, correctness-sensitive behavior exists in
parallel implementations, and compatibility or rollout seams have become permanent
architecture. The highest-leverage simplification is therefore to collapse execution
paths and make lifetimes and ownership explicit, not to replace the sync model.

Five findings should be handled as correctness or operational risks before ordinary
cleanup:

1. Canonical garbage collection has a deterministic fleet-wide workspace/root
   snapshot ceiling. At the current constants, a ninth qualifying workspace/project
   row makes mark and purge no-ops.
2. API JSON bodies and collection sizes are generally not bounded before parsing;
   `/v1/blobs/check` also lets duplicate identifiers amplify D1 work.
3. Noninteractive `untrack` fails open, and ordinary daemon stop may escalate to
   `SIGKILL` even though the interface implies that force controls that behavior.
4. Credential reads hide corruption as a signed-out state, while writes are direct
   rather than atomic and symlink-resistant.
5. Blob-pack acceptance appears to establish a rollback compatibility floor that is
   described in code but not mechanically enforced.

The strongest architectural opportunities are:

- replace the monolithic local `state.json` with a small transactional database plus
  immutable manifest snapshots;
- delete one of the two publish engines and collapse all upload scheduling into one
  attempt-scoped coordinator;
- separate long-lived authenticated remote context from attempt-scoped transfer
  sessions;
- split daemon and Git orchestration around state-machine/effect boundaries;
- introduce a typed API route registry and a shared protocol package used by both
  Worker and CLI;
- replace the hand-built CLI switch/help/flag relationship with declarative command
  specifications;
- mechanically enforce `CODEMAP.md`, import direction, runtime-cycle, and feature
  flag lifecycle rules.

## Priority map

| Priority | Finding | Primary risk or value |
|---|---|---|
| P0 | Canonical GC snapshot ceiling | Fleet-wide retained-data collection can stop |
| P0 | Bounded request parsing and collection limits | Memory/CPU/D1 amplification |
| P0 | `untrack` confirmation and daemon kill semantics | Destructive headless behavior and mid-Git termination |
| P1 | Atomic, typed credential persistence | Hidden corruption and unsafe secret writes |
| P1 | Blob-pack rollback-floor enforcement | Unsafe server rollback after format acceptance |
| P1 | One publish engine and one upload coordinator | Remove duplicated correctness-critical implementations |
| P1 | Local transactional state store | Remove whole-state parse/rewrite and reset complexity |
| P1 | Explicit remote/session lifetimes | Prevent optional forwarding and resource-lifetime failures |
| P1 | Daemon and Git state-machine decomposition | Make recovery and concurrency behavior testable |
| P2 | Typed route/command registries and shared protocol | Eliminate policy, help, wire, and client drift |
| P2 | WorkspaceSync and maintenance decomposition | Bound API orchestration and improve failure isolation |
| P2 | Structural and invariant gates | Stop architecture from silently drifting again |

## Method and evidence policy

This was a read-only architecture audit. It reviewed:

- `docs/STATUS.md`, `docs/CODEMAP.md`, and `docs/INVARIANTS.md`;
- the current Worker entry point, route handlers, Durable Objects, GC, retention,
  blob accounting, and maintenance paths;
- CLI entry, dispatch, flag/help handling, credentials, daemon control, daemon
  orchestration, local configuration/state persistence, remote transport, E2EE
  decoration, and user-facing lifecycle commands;
- the directly coupled sync, publish, Git apply/follow, reset, and engine surfaces;
- relevant tests as behavioral documentation where interface behavior was not
  obvious from the implementation.

The reviewed production surface is approximately 72,000 TypeScript lines across
roughly 300 files in `apps/api`, `src/cli`, and the coupled engine. This is a static
architecture review, not a fleet or rig validation. Deterministic findings cite the
current code; expected performance or complexity benefits are hypotheses that need
measurement before implementation decisions.

`docs/STATUS.md` already queues an `apply.ts` split and closure of unproven
invariants. This audit agrees with those goals and proposes the seams around which
the split should occur.

## Architecture worth preserving

The following are strengths, not cleanup targets:

- the scan → diff → reconcile → apply vocabulary;
- separation of E2EE primitives/session behavior from ordinary I/O;
- explicit push recovery actions rather than unstructured retry loops;
- trash and resurrection protection;
- preconditioned Git apply and anti-rollback pins;
- bounded retry and journaling where no transactional replacement exists;
- `CODEMAP.md`'s one-owner/never-owner vocabulary.

Reorganization should make these guarantees easier to see and enforce. It should
not trade them for superficially smaller files.

## Finding 1: canonical GC has a hard fleet-wide ceiling

### Evidence

Canonical GC constructs an authoritative roots snapshot under a fixed payload
budget. At the current constants, its maximum workspace/project row count is:

~~~text
floor((800 - 10 - 3) / 90) = 8
~~~

The snapshot path returns `null` beyond its computed maximum:

- `apps/api/src/versions.ts:193-203`

Mark treats the condition as a budget-exceeded no-op:

- `apps/api/src/versions.ts:210-215`

Purge independently computes the same ceiling and becomes a no-op:

- `apps/api/src/versions.ts:494-499`

There is a separate fleet-wide `MAX_UNIQUE_ROOTS = 750_000` bound:

- `apps/api/src/versions.ts:28`

### Assessment

This is a deterministic scale cliff rather than graceful degradation. Once the
ninth qualifying row exists, increasing unrelated capacity or waiting for another
scheduled pass cannot restore progress. Raising the constant merely moves the
cliff and preserves the full-fleet snapshot architecture.

### Recommendation

Immediate containment:

1. Publish current row/root utilization and the computed limit as an admin health
   signal.
2. Alert before the limit and make a budget-exceeded mark/purge observable rather
   than an ordinary successful no-op.
3. Add a test whose ninth row proves that the current path cannot silently claim
   successful maintenance.

Architectural fix:

- process reachability in durable, cursored partitions with explicit checkpoints;
- isolate failures per account/workspace rather than invalidating a global pass;
- preferably generate orphan candidates from last-reference transitions and use a
  slow full reconciler only as a correctness backstop.

The long-term invariant should be that adding one workspace cannot stop collection
for every other workspace.

## Finding 2: request parsing and collection work are not consistently bounded

### Evidence

`/v1/blobs/check` parses the body directly and creates arrays before applying an
explicit byte or item-count bound:

- `apps/api/src/routes/blobs.ts:120-125`

The receipt-aware branch queries the deduplicated SHA set, but the legacy branch
queries the original request array:

- `apps/api/src/routes/blobs.ts:143`
- `apps/api/src/routes/blobs.ts:179-198`

Repeated identical SHAs therefore create additional D1 batch work without changing
the response. The generic batch helper deliberately imposes no total caller cap:

- `apps/api/src/d1-batch.ts:33-35`

Other route families, including key and device flows, also call `req.json()`
directly. In some cases parsing occurs before the cheapest applicable rejection or
rate-limit decision.

### Recommendation

Create a single request primitive:

~~~ts
const body = await cappedJson(request, schema, {
  maxBytes: 64 * 1024,
  maxItems: 1_000,
  maxStringBytes: 128,
});
~~~

Every route specification should declare:

- accepted content type;
- maximum bytes before parsing;
- maximum item count and relevant nested/string limits;
- runtime schema;
- whether duplicate identifiers are legal and, if so, when they are deduplicated.

Rate-limit before parsing when the limiter does not require body content. Query the
deduplicated collection in every branch. Keep `d1-batch` generic, but require its
callers to provide an already bounded set.

## Finding 3: `untrack` and stop semantics fail open

### Evidence

The dispatcher supplies an automatic `true` confirmation in noninteractive mode:

- `src/cli/main-dispatch.ts:161-172`

`untrack` then recursively removes `.rbox`:

- `src/cli/untrack-cmd.ts:66-73`
- `src/cli/untrack-cmd.ts:81-102`

The help text describes `--force` as skipping confirmation and killing a stuck
daemon, but ordinary `stopDaemon` escalates to `SIGKILL` after its timeout regardless
of the flag:

- `src/cli/help-registry.ts:237-243`
- `src/cli/daemon-control.ts:425-451`

The same module explicitly recognizes that forced termination can land in the
middle of a Git mutation and avoids doing so during rebind:

- `src/cli/daemon-control.ts:349-354`

`ignore --purge` contains the safer precedent: headless destructive use fails
closed without explicit consent.

- `src/cli/ignore-cmd.ts:70-88`

### Recommendation

Model two independent permissions:

1. permission to delete local rbox metadata;
2. permission to force-kill a daemon that did not shut down cleanly.

Noninteractive `untrack` should require explicit `--yes`. `--force` should be the
only operation that permits kill escalation, or there should be a separately named
`--kill-stuck-daemon` flag if combining consent and process behavior is too subtle.
Without that permission, return a clear recovery command and leave `.rbox` intact.

The normal stop result should distinguish `requested`, `acknowledged`, `timed out`,
and `force killed` rather than collapsing them into one success/failure path.

## Finding 4: credential persistence hides corruption and is not atomic

### Evidence

`loadCredentials()` catches every read and parse failure and returns `undefined`:

- `src/cli/credentials.ts:38-52`

An absent file, unreadable file, truncated JSON document, invalid schema, and future
unsupported version therefore all appear to be the same signed-out state.

`saveCredentials()` writes directly to the final path and changes permissions only
after the write:

- `src/cli/credentials.ts:63-66`

That permits a crash to leave a partial credential document and does not explicitly
reject an existing symlink destination.

### Recommendation

- Return a typed load result: `absent | valid | corrupt | unreadable |
  unsupported-version`.
- Validate the decoded DTO rather than trusting parsed JSON.
- Create the replacement with mode `0600`, fsync it, and atomically rename it.
- Refuse symlink destinations and verify the containing directory.
- Make corruption actionable: preserve the damaged file and tell the user exactly
  how to reauthenticate or recover it.

This primitive should become the model for all local secret material.

## Finding 5: blob-pack rollback compatibility is documentary

### Evidence

The deployed environment configuration accepts blob-pack format 1 in both dev and
production:

- `apps/api/wrangler.jsonc:93`
- `apps/api/wrangler.jsonc:184`

The pack implementation explains that accepting a format makes older builds cease
to be safe rollback targets, while the literal rollback-floor value remains unset:

- `apps/api/src/blob-pack.ts:23-30`

### Recommendation

Represent the minimum compatible build or accepted storage format as deployed
state. Deployment and rollback should reject a build below that floor before it can
serve traffic. A release gate should verify that every accepted writer format is
readable by every allowed rollback target.

## Finding 6: local sync state is a whole-document database

### Evidence

`src/cli/config.ts` is approximately 1,272 lines and owns:

- workspace configuration schemas and discovery;
- sync-state schemas and complete last-synced manifests;
- compare-and-set storage behavior;
- legacy migration;
- reset/rebind orchestration and engine integration.

Its cross-domain imports begin at:

- `src/cli/config.ts:1-47`

The sync-state model and full manifest records appear at:

- `src/cli/config.ts:129-175`

Every accepted state update loads and rewrites a complete prettified JSON document:

- `src/cli/config.ts:513-599`
- `src/cli/config.ts:589-591`

`docs/STATUS.md` records fleet state files around 77 MB. Reset I/O now carries large
parse-expansion and memory-budget machinery:

- `src/cli/reset-io.ts:6-18`

### Recommendation

Replace `.rbox/state.json` with two layers:

1. a small local SQLite database containing the global baseline pointer, sequence,
   incarnation, per-repository records/generations, operation state, and CAS
   versions;
2. immutable content-addressed or compressed manifest snapshots stored separately.

Benefits:

- row-level compare-and-set rather than complete-document CAS;
- atomic reset and rebind transactions;
- bounded reads for status and per-repository work;
- no 77 MB parse/rewrite for a small accepted update;
- fewer bespoke reset journals once equivalent transactions exist;
- explicit migration/version history.

A lower-risk precursor is splitting the current module into:

- `workspace-config/{types,store,discovery}`;
- `sync-state/{types,projection,store}`;
- `manifest-snapshot`;
- `reset-orchestrator`.

The split is useful only if ownership moves; merely distributing the same cyclic
responsibilities across four files would not simplify the system.

## Finding 7: publish correctness exists in two engines

### Evidence

The new publish pipeline remains default-off:

- `src/cli/sync-recovery.ts:64-65`
- `src/cli/sync-recovery.ts:177`

The fallback path beginning around `src/cli/sync-recovery.ts:210` independently
performs encryption, cache interaction, missing-blob checks, upload, receipt
handling, retry, and cleanup. The newer implementation lives in:

- `src/cli/publish-pipeline/pipeline.ts:79`

Shared helpers exist partly to keep the implementations behaviorally aligned.

### Recommendation

Run both paths through the rig under:

- file churn during publish;
- abort at every phase boundary;
- receipt redemption failure;
- 422 recovery;
- tiny workspaces where pipeline overhead dominates;
- large and mixed-size workloads.

Select the implementation with the clearest correctness and recovery story, ship a
short rollback window, then delete the other. A default-off pipeline should not
remain an indefinitely maintained second publish engine.

## Finding 8: upload scheduling has multiple owners

### Evidence

An upload may currently pass through a ready queue/resource budget, the batch
uploader's queue, pack or batch selection, a separate single-upload gate, and
multipart logic:

- `src/cli/remote/uploader.ts:50`
- `src/cli/remote/uploader.ts:105`
- `src/cli/remote/uploader.ts:397`
- `src/cli/remote/uploader.ts:460`
- `src/cli/remote/blobs.ts:82`
- `src/cli/remote/gate.ts:1`

Fallbacks cross those ownership boundaries, so concurrency, cancellation, fairness,
and drain completion are not controlled by one abstraction.

### Recommendation

Create one attempt-scoped `UploadCoordinator` that exclusively owns:

- work ordering and backpressure;
- byte and concurrency budgets;
- cancellation;
- receipt draining;
- retry classification;
- selection among pack, batch, single, and multipart strategies.

Transport strategies should accept work and return a typed result. They should not
recursively enqueue work through another strategy or own process-global gates.

## Finding 9: remote interfaces encode missing lifetime boundaries

### Evidence

`SyncRemote` describes itself as minimal but contains optional lifetime-sensitive
capabilities such as `ownsUploadLaneTiming`, `closeUploader`, and `receiptPort`:

- `src/cli/remote/api.ts:36-49`

`E2eeRemote` manually forwards these optional capabilities. A source comment notes
that omitting `receiptPort` once disabled draining fleet-wide:

- `src/cli/e2ee-remote.ts:946`

It cannot simply forward `closeUploader`, because closing on attempt abort would
permanently close a daemon-lived uploader:

- `src/cli/e2ee-remote.ts:848-869`

### Recommendation

Define explicit lifetimes:

- `AuthenticatedContext`: long-lived auth, account, route, and retry context;
- `UploadSession`: attempt-scoped queue, cancellation, transport, and drain state;
- required narrow `BlobTransferPort`, `CommitPort`, `ManifestReader`, and
  `ReceiptPort` interfaces;
- an E2EE decorator that owns key/manifest transformation rather than resource
  lifetime forwarding.

Required capabilities should replace optional duck typing. Closing an attempt
session should never be capable of closing the daemon's long-lived context.

## Finding 10: the daemon is several state machines in one class

### Evidence

`RboxDaemon` is approximately 2,366 lines. Its fields show separate state machines
for reset lifecycle, watcher trust, pump requests, mutex backoff, drift audit,
activity/status surfaces, telemetry timers, and WebSocket generation/reconnection:

- `src/cli/daemon.ts:272-398`

The pump at `src/cli/daemon.ts:914` is the correct high-level serialization point.
Status persistence is spread across closely related paths:

- `src/cli/daemon.ts:1652-1717`

The notification/WebSocket subsystem is a large contiguous concern:

- `src/cli/daemon.ts:2087-2332`

### Recommendation

Keep one daemon pump as the only high-level sequencer, but extract:

- `DaemonSurfacePublisher` for heartbeat, activity, and status persistence;
- `DaemonNotificationChannel` for WebSocket generation and reconnect policy;
- `WatcherTrustController`;
- `SyncAttemptScheduler` for wants, backoff, and attempt admission.

The ambitious target is a reducer-like core:

~~~text
DaemonEvent + DaemonState -> next state + declared effects
~~~

Disconnects, watcher overflow, reset, shutdown, mutex contention, and coalesced pump
requests could then be model-tested without real timers and processes.

## Finding 11: Git apply and follow need decision/effect seams

### Evidence

- `src/cli/sync-git/apply.ts` is approximately 1,672 lines.
- `src/cli/sync-git/follow.ts` is approximately 1,358 lines.

`applyGitSections` begins around:

- `src/cli/sync-git/apply.ts:260`

It coordinates observation, planning, journals, metrics, branch transitions,
checkout effects, repair state, and sync-state deltas. Follow has comparable stage,
classification, publication, and checkout responsibilities:

- `src/cli/sync-git/follow.ts:320`
- `src/cli/sync-git/follow.ts:542`
- `src/cli/sync-git/follow.ts:914`

### Recommendation

Both paths should follow the same architecture:

1. observe local and remote state;
2. produce a closed, pure decision union;
3. execute fenced effects;
4. compose the resulting sync-state delta.

Metrics/types/rendering in `apply.ts` are an easy leaf extraction. The important
change is moving Git commands and persisted repair state behind an effect boundary,
so every decision variant documents its preconditions and recovery action.

### Radical product alternative

Import synchronized Git metadata into `refs/rbox/*` by default and never mutate
HEAD, index, or worktree automatically. Users would explicitly enable or invoke
`rbox git follow`.

This could delete much of the checkout journal, branch transition, breadcrumb, and
repair machinery from the ordinary sync path. It is also a material product
semantic change and should be tested with real workflows before becoming a design.

## Finding 12: API route identity and policy are duplicated

### Evidence

Route knowledge appears separately in dispatch/grant fast paths, telemetry
vocabulary, browser allowlists, and API-key allowlists:

- `apps/api/src/worker.ts:248-333`
- `apps/api/src/worker.ts:350-359`
- `apps/api/src/worker.ts:398-418`
- `apps/api/src/worker.ts:427-440`

The API-key path recognizes broad prefixes such as `/v1/blobs`, while the browser
policy is exact/default-deny. A future route under an existing prefix can therefore
inherit policy unintentionally.

### Recommendation

Define a typed `RouteSpec` that owns:

- method and path/parameter matching;
- accepted principal/token kinds;
- body schema and limits;
- rate limiter;
- telemetry identity;
- CORS/cache policy;
- lazy handler loader.

Generate dispatch and policy tables from the registry. Route modules should own
domain translation, not repeat transport/security configuration.

Domain operations should return typed result unions rather than `Response` objects;
the HTTP adapter can translate them. Scheduled and administrative callers should
not have to invoke a domain operation through an HTTP-shaped return type and discard
the result.

## Finding 13: wire and control-plane contracts need one home

### Evidence

Batch wire implementations explicitly warn that client and server definitions are
duplicated and nothing makes divergence fail compilation:

- `src/cli/remote/batch/wire.ts:4-7`
- `apps/api/src/blob-batch.ts:10-13`

Telemetry runtime contracts are likewise duplicated:

- `apps/api/src/telemetry-ingest.ts:25-28`
- `src/cli/telemetry/contract.ts:23-27`

The API TypeScript configuration currently permits a small hand-selected set of
shared engine modules:

- `apps/api/tsconfig.json:14`

CLI account, billing, usage, setup, status, and authentication commands issue raw
fetches independently. `/v1/account/usage` is implemented in several commands with
slightly different handling.

### Recommendation

Create a dependency-free `src/protocol` package containing:

- batch framing;
- telemetry schemas;
- route request/response DTOs and error codes;
- signed capability payloads;
- runtime validators.

Use it to implement a typed `ControlPlaneClient` with consistent version headers,
deadlines, bounded response parsing, retry classification, and friendly error
translation. This client should be the only ordinary CLI owner of control-plane
HTTP details.

## Finding 14: WorkspaceSync is a domain host, not a thin Durable Object

### Evidence

`apps/api/src/workspace-sync.ts` is approximately 1,384 lines and contains:

- request/WebSocket adaptation near line 129;
- bootstrap near line 189;
- commit admission/sequencing near line 367;
- alarm/index folding near line 738;
- root operations near line 947;
- repair/admin behavior near line 1195;
- receipt, retention, prune, and purge behavior around those paths.

### Recommendation

Keep the Cloudflare Durable Object class as a thin runtime adapter. Extract domain
components behind narrow storage ports:

- `CommitSequencer`;
- `CommitStore`;
- `RootsIndex`;
- `RetentionPolicy`;
- `WorkspaceRepair`;
- `WorkspaceAdmin`.

The more ambitious improvement is to persist roots-index deltas transactionally at
commit time or through an outbox rather than refolding complete sets during alarms.
That turns index maintenance into change-proportional work and makes recovery state
explicit.

## Finding 15: maintenance loops need one cursored job runner

### Evidence

GC, retention, fleet alerts, and administrative sweeps independently implement
iteration, work budgets, error handling, and continuation:

- `apps/api/src/retention.ts:35`
- `apps/api/src/gc-phase1.ts:287`
- `apps/api/src/fleet-alerts.ts:222`
- `apps/api/src/worker.ts:52`

Some loops are serial across the fleet, construct broad response state, or permit
one failed workspace to prevent later work in the same invocation.

### Recommendation

Build one durable job runner with:

- cursor/checkpoint persistence;
- page, item, and deadline budgets;
- per-item failure isolation;
- retry/outbox support;
- bounded result summaries;
- explicit completion and partial-progress semantics;
- shard enumeration if database topology becomes real.

Consider separate public API, admin, maintenance, and release Workers. This is less
about repository cosmetics than least privilege, deployment isolation, and keeping
scheduled fleet work from sharing one oversized runtime entry point.

## Finding 16: the database topology abstraction is undecided

### Evidence

`dbFor()` and `dirDb()` currently return the same constant D1 binding:

- `apps/api/src/db.ts:42-52`

Code nevertheless contains cross-plane vocabulary and batches whose atomicity would
not survive real sharding. Examples include account linking, mint/admission, and
notification flows:

- `apps/api/src/account-link.ts:204`
- `apps/api/src/auth/mint.ts:148`
- `apps/api/src/notify.ts:119`

### Recommendation

Choose explicitly:

- If one D1 database is the foreseeable topology, remove speculative sharding noise
  and make atomic behavior obvious.
- If sharding is a real target, introduce a topology API, shard enumeration,
  durable sagas/outboxes, and secondary indexes. Do not rely on cross-plane batches
  accidentally remaining atomic.

## Finding 17: blob availability predicates are repeated

The same semantic predicate—present, entitled, not deletion-marked, not fenced by
pack/blob GC—appears in route handlers, commit accounting, and WorkspaceSync SQL.
This invites subtle divergence in the product's most important storage invariant.

Create a `BlobCatalog` repository that owns:

- availability and entitled-subset queries;
- grant/regrant transitions;
- deletion-candidate fencing;
- pack membership and purge eligibility;
- accounting-visible state transitions.

Batch GET currently performs per-item entitlement checks where a set-based
`entitledSubset` operation already exists. Route-level transport should not encode
availability SQL.

## Finding 18: CLI command parsing, help, and dispatch can drift

### Evidence

The help registry acknowledges that it is not the parser or dispatcher source of
truth:

- `src/cli/help-registry.ts:1-10`

Dispatch is a large switch:

- `src/cli/main-dispatch.ts:145-543`

The flag parser infers arity from display-oriented definitions and produces an
untyped record:

- `src/cli/flags.ts:10-45`

Hidden flags are a separate list:

- `src/cli/flags.ts:48-65`

Invalid values and extra positionals are handled inconsistently across commands.
Some commands reject malformed numbers, others silently use a default, and several
ignore unexpected arguments.

### Recommendation

Define a declarative `CommandSpec` that owns:

- command path, aliases, and deprecation state;
- positional schema;
- typed flags, defaults, conflicts, and environment equivalents;
- JSON support and output schema version;
- handler loader;
- help and completion generation.

The parser should either return the command's typed input or a standardized usage
error. Help, dispatch, completion, and hidden/deprecated behavior should be generated
from the same definition.

The public surface is large enough to consider task-oriented default help with
`help --all` for the full registry. JSON output should use a versioned envelope
rather than command-specific ad hoc objects.

## Finding 19: lightweight CLI commands perform heavyweight startup work

### Evidence

The entry point imports API-base side effects and the engine shutdown surface before
knowing which command will run:

- `src/cli/index.ts:1`
- `src/cli/index.ts:11-19`

The main dispatcher statically imports many command families and refreshes lock
identity before handling lightweight commands such as help/version:

- `src/cli/main-dispatch.ts:1-22`
- `src/cli/main-dispatch.ts:83-107`

That refresh can involve lock and persistence behavior:

- `src/cli/lockfile.ts:433`

### Recommendation

Add a tiny pre-parser for prompt status, help, version, and completions. Lazy-load
command families after parsing. Register crypto-pool or engine cleanup only when the
resource is instantiated. Avoid lock, identity, or API configuration side effects
for commands that do not require them.

The existing `RBOX_API` warning for prompt status is pinned behavior, so changing it
requires an intentional UX decision rather than assuming it is accidental:

- `src/cli/__tests__/dispatch-json.test.ts:35`

## Finding 20: daemon lifecycle lacks serialization and readiness

### Evidence

`startDaemon` follows a check → clean → spawn → write sequence without a lifecycle
lock:

- `src/cli/daemon-control.ts:330-395`

Concurrent starts can both conclude that no healthy daemon exists. The parent
reports success after spawning/unref, not after the child has loaded state and
declared itself ready:

- `src/cli/daemon-control.ts:379`

Autostart separately persists desired-running state:

- `src/cli/autostart-cmd.ts:191`

### Recommendation

- serialize start/stop/rebind through a per-runtime lifecycle lock;
- have the child publish a nonce-matching ready record or socket response;
- bound startup and return the child's initialization error to the caller;
- distinguish desired-running state from current process health;
- require graceful shutdown acknowledgment before normal stop succeeds.

## Finding 21: internal health depends on human log text

`sync-mutex` imports daemon-control behavior and reverse-scans human logs with regular
expressions to infer lock health:

- `src/cli/sync-mutex.ts:55-93`

`daemon-control.ts` itself combines runtime-record formats, supervision, lifecycle,
and log reading in approximately 715 lines.

Publish a structured lock-health sidecar or event record containing owner,
operation, start time, heartbeat, and generation. Split daemon runtime records,
supervisor/lifecycle, and human log reading into separate modules. Logs should be
observational output, never a machine-readable correctness API.

## Finding 22: feature flags need lifecycle ownership

The client/core contains dozens of `RBOX_*` variables. Not all are feature flags,
but many select alternate behavior or rollout paths: publish pipeline, manifest
delta encoding, preflight delta, scan bulk/pruning, watcher retrust, files-first, and
others.

Create one typed feature snapshot that records, per behavior flag:

- default and environment override;
- maturity: experiment, rollout, escape hatch, or permanent configuration;
- owner;
- required telemetry;
- removal condition and target release.

Log the resolved snapshot once per process/attempt where appropriate. Delete flags
and alternate code paths after graduation. A flag that permanently selects between
two complete implementations is architecture debt, not configuration.

Comment-toggled dependency behavior in main/help/setup should either be deleted,
archived in history, or become an actual supported plugin. Comment blocks are not a
safe feature system.

## Finding 23: `CODEMAP.md` and import boundaries are not enforced

### Evidence

The ownership map requires one entry for every module in its scoped trees and
documents an exception convention for large modules. Current drift includes:

- scoped files without a corresponding map entry;
- `apply.ts`, `follow.ts`, `push.ts`, and `lockfile.ts` above the documented size
  convention without consistent exceptions;
- modules whose imports/construction behavior exceed their stated ownership;
- a runtime circular dependency: `activity.ts` imports
  `projectGitDeferralRepos` from `status-view.ts`, while `status-view.ts` imports
  `ACTIVE_STALE_MS` from `activity.ts`.

Relevant cycle:

- `src/cli/activity.ts:17`
- `src/cli/status-view.ts:14`

### Recommendation

Add structural CI that:

- enumerates every `CODEMAP.md`-scoped module and requires exactly one entry;
- checks runtime import cycles, excluding type-only edges;
- enforces domain import directions and explicit facade/barrel boundaries;
- flags large modules without a documented exception;
- detects prohibited construction or ownership imports.

For the current runtime cycle, extract the shared activity/status projection
contract into a leaf module rather than choosing either side as the new owner.

## Finding 24: invariant closure needs a test strategy, not isolated test growth

`docs/INVARIANTS.md` contains approximately 15 `NONE FOUND` or partial proof gaps.
The highest-value gaps concern:

- lock-health internals remaining local;
- fresh random root keys and revoke/rotate behavior;
- headless recovery phrases never entering logs;
- pair-local secrets being omitted from real HTTP;
- pairing tokens being hashed at rest and consumed material scrubbed;
- retry identity and signed account identity precedence;
- secrets never entering argv/log output;
- device-key immutability;
- trash never resynchronizing;
- propagation using one clock;
- bounded shutdown telemetry;
- one failed alert/maintenance item not blocking later work.

Create an invariant matrix mapping each guarantee to:

- its single owning module;
- proof type: unit, property, state model, fault injection, rig, or fleet assertion;
- adversarial events;
- current evidence and missing evidence.

Use model tests and injected faults for lifecycle/security properties instead of
adding more query-spelling or implementation-coupled unit tests. The test should
survive a refactor while continuing to prove the product guarantee.

## Smaller cleanup opportunities

These do not justify architecture projects alone, but fit naturally into the larger
work:

- Exact-match queue dispatch. The Worker currently detects account deletion through
  string inclusion and treats other messages as notifications; separate queues or
  a discriminated message envelope would be safer.
- Consolidate signed-capability crypto shared by receipts and grants.
- Make `Principal.role` a closed union rather than an arbitrary string.
- Remove or justify unused entitlement helpers such as `grantEntitlement`.
- Collapse redundant JSON response helpers.
- Replace global/nonparallel Worker storage tests and SQL-query-spelling fakes with
  domain-port tests plus a smaller number of real D1 integration tests.
- Establish a deprecation policy. Aliases annotated for removal around v0.3 remain
  in a v1.6-era CLI surface.
- Stop the release script from rewriting the checked-in CLI version module. Inject
  build identity through a generated scratch module or bundler define:
  `scripts/release.ts:123-125`, `src/cli/version.ts:1`.

## Deliberately ambitious options

These ideas have unusually high simplification upside but require product or
platform validation:

### Local transactional core

Treat `.rbox` as a small embedded database with immutable content-addressed
snapshots, not a directory of JSON documents and journals. This is the broadest way
to simplify local CAS, reset, migration, status, and crash recovery together.

### No automatic Git checkout

Make `refs/rbox/*` the default sync result. Following into HEAD/index/worktree becomes
an explicit product mode. This sharply narrows ordinary sync risk at the cost of a
different user promise.

### Reducer-driven daemon

Represent the daemon as a deterministic state transition system with declared
effects. Real filesystem, watcher, network, timer, and process behavior becomes an
adapter around the model.

### Generated protocol and clients

Generate Worker dispatch metadata, CLI client methods, runtime validators, telemetry
route names, and documentation from one protocol description. This trades some code
generation complexity for compile-time drift prevention.

### Split public, admin, maintenance, and release Workers

Give each runtime the minimum bindings and deployment cadence it needs. Shared
domain packages remain local, while failures and privileges stop accumulating in
one Worker.

### Event-driven retention and orphan discovery

Generate retention/GC candidates from reference transitions, then continuously
reconcile a bounded partition. Full-fleet snapshots become diagnostic proof rather
than the critical maintenance path.

## Suggested implementation sequence

### Phase 0: containment and measurement

1. Instrument GC utilization and no-op reasons.
2. Add request byte/item limits and deduplicate `/v1/blobs/check` work.
3. Make noninteractive destructive confirmation fail closed.
4. Separate normal daemon stop from forced kill permission.
5. Make credential state typed and writes atomic.
6. Enforce the blob-pack rollback floor.

### Phase 1: delete duplicate execution paths

1. Qualify and select one publish engine.
2. Introduce the attempt-scoped upload coordinator.
3. Remove the losing publish/upload scheduling path.
4. Centralize feature resolution and assign removal conditions.

### Phase 2: repair boundaries

1. Separate remote context and attempt session lifetimes.
2. Split daemon surfaces, notification channel, watcher trust, and scheduler while
   retaining one pump.
3. Split Git observe/decide/effect/state-delta phases.
4. Extract WorkspaceSync domain components behind storage ports.
5. Introduce the reusable maintenance runner.

### Phase 3: unify contracts and front doors

1. Add the shared protocol package.
2. Build the typed route registry and control-plane client.
3. Replace CLI switch/help/flag duplication with command specifications.
4. Add structural `CODEMAP`, cycle, and import-direction gates.
5. Close the invariant matrix with model, fault, rig, and fleet proofs.

### Phase 4: local persistence decision

Prototype SQLite plus immutable manifest snapshots against real 77 MB fleet state.
Compare:

- small accepted update latency;
- reset and crash recovery;
- status/read amplification;
- migration and rollback behavior;
- filesystem portability and support diagnostics;
- rig behavior under process kill at each transaction boundary.

Proceed only if the prototype deletes more bespoke state/recovery complexity than it
introduces.

### Phase 5: product-level simplification experiments

Test explicit Git follow, task-oriented CLI help, and split Worker deployment with
real workflows and operational drills. These are high-upside choices, not automatic
refactors.

## Success criteria for the simplification program

The program should be judged by deleted states and paths, not file count alone:

- one publish implementation;
- one upload queue/budget owner;
- no optional lifetime forwarding on the remote interface;
- no full-state JSON rewrite for a small state transition;
- no global GC cliff based on fleet row count;
- every HTTP route has declared auth, body, limiter, and telemetry policy;
- every CLI command has one parser/help/dispatch definition;
- every daemon/Git decision variant has explicit preconditions and recovery;
- no runtime import cycles in the product core;
- every documented invariant has a durable proof;
- feature flags that select implementations have removal dates and disappear.

The target is not merely smaller modules. It is fewer independent sources of truth,
fewer hidden lifetimes, fewer global cliffs, and fewer ways for two correct-looking
paths to behave differently.
