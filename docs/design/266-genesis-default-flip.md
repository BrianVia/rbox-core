# 266 — Genesis is the absent-state default

Status: **ALIGNED v4** — R3 closed all substantive findings; editorial residuals (STATUS staleness, literal hash command) fixed and self-certified by the orchestrator

Founder decision (2026-08-15, pinned): a fresh workspace that cannot prove the
locking required by SQLite refuses immediately. There is no log-only phase,
degraded fresh-state path, or JSON fallback. The refusal is ephemeral and typed;
the existing safety telemetry event counts proven occurrences. It creates no
durable diagnostic state.

Round history:

- v1: initial SP-3 design.
- v2: accepts every finding in both round-1 reviews and the orchestrator rulings.
- v3: folds the three accepted round-2 findings: exact ordinary create-new init
  continuation, a fully ephemeral daemon refusal with no activity latch, and
  complete `lock-io` copy/doctor rendering.

Authored against `44f0e9171733e6ce887021513078a5aecd58888f`. SP-2b commit
`52c736540` is in this HEAD. SP-2.5 commit `567356dad` is not; its three
scenario amendments in §6 are an integration prerequisite, not landed evidence.

This is SP-3 of design 262 v2. It makes held-lock SQLite genesis the only
ordinary transition from absent state, removes the automatic upgrade-window
**call**, and proves the one-way 1.x-to-candidate takeover. Existing JSON remains
supported. Physical deletion of the retired upgrade module and retirement of
JSON/migration stay in SP-4.

## 0. Decision yardstick

A successful fresh `track`, `init`, guided setup, adoption binding, or private
export staging returns past binding only after:

```text
workspace config rename
  -> fsync .rbox
  -> healthy held workspace mutex + canonical state lock
  -> exact Q + matching state.db + retired genesis intent
  -> remaining binding/catalog/adoption/export/sync work
```

`track` remains bind-only and performs no first network sync, but Q exists before
it returns. `init --no-sync` has the same authority guarantee. Foreground and
daemon entry remain recovery backstops, not routine first creators.

The candidate is acceptable only if:

1. `absent` is never represented as `legacy-json-store`; no production path can
   publish new JSON from absence.
2. Genesis begins only while both lock layers are supported, acquired, and
   owned. Every other result refuses before genesis mutation.
3. Existing JSON keeps the exact contract in §1. The automatic upgrade call is
   the one approved JSON behavior change.
4. The shared genesis/migration bootstrap dispatch is gone. Ordinary admission
   owns genesis; the explicit command owns migration.
5. No concurrent or alternating mixed-version operation occurs. After Q is
   published, never run 1.x on that root outside the isolated negative compat
   test.
6. The exact-candidate SP-2.5 gates and the pinned 1.11.4 dual-binary gate in §6
   are green.

No kill switch is added. A flag would create two fresh-state defaults.

## 1. Protected functionality and approved deltas

### 1.1 Protected-functionality ledger

Protected without reinterpretation: exact JSON (§1.2); Q binding, one store,
write fence, owner-token CAS, S0-at-rest, reset/genesis recovery, and fail-closed
saves; all foreign/malformed/too-new/corrupt/reset/control/intent
classifications; track/init/adoption/export product behavior; explicit
migrate/retry/abort; upgrade daemon lifecycle/mode; workspace wire, encryption,
Git, scan/watch; and telemetry transport policy. Their existing owners remain
owners. Prove them with SP-1/2/2b, SQLite/crash, output/tree/wire differential,
migration, upgrade, and telemetry parity suites. Read-only absence alone changes
to `uninitialized`/`undefined` with zero mutation.

### 1.2 JSON-neutrality ledger

The **one approved existing-JSON behavior change** is removal of the automatic
JSON-to-SQLite upgrade-window call, including its conversion output and
mutation. `rbox upgrade` still replaces the binary and preserves daemon desired
state/mode.

Everything else for a selected JSON workspace is byte- and output-exact:

- `locking-health.json` remains the exact legacy `degraded-unlocked` row with
  reason `identity-unavailable`;
- the exact warning remains `continuing with legacy state saves`;
- unsupported-cause detail used by fresh genesis is invocation-local and never
  changes that row or warning;
- reads, writes, generations, reset/rebind, telemetry, mismatch behavior, and
  degraded saves remain unchanged; and
- no existing JSON root is refused, renamed, migrated, or deleted by SP-3.

The other approved changes apply only to absent authority: absence selects no
backend, E0 reset publishes no JSON, config is parent-durable before genesis,
and a fresh root that cannot prove locking refuses.

## 2. Fresh-genesis lock boundary

### 2.1 Invocation-local classification

The real same-directory hardlink publication at
`.rbox/state/sync.lock` and `.rbox/state.json.lock` is authoritative. Filesystem
names are not. Host-identity discovery is a prerequisite, not filesystem proof.

```ts
type LockUnsupportedReason = "hardlink-unsupported" | "indeterminate"
  | "identity-unavailable" | "link-capacity";
```

Classification is closed:

| Observation | Classification | Fresh-genesis result |
|---|---|---|
| link returns `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`, or same-directory `EXDEV` | `hardlink-unsupported` | filesystem refusal + safety event |
| link returns `EPERM` | `indeterminate` | neutral policy/filesystem refusal; no disk claim/event |
| link returns `EMLINK` | `link-capacity` | existing resource/I/O retry refusal |
| identity cannot be read/refreshed/encoded | `identity-unavailable` | identity refusal |
| `EEXIST`/held | contention | bounded busy result |
| any other create/link/verify I/O failure | typed I/O error | generic refusal; no permanent claim |
| owner lost after acquisition | owner-loss | fail closed at adjacent checks |

`sync-mutex.ts` receives this detail only for the current acquisition. If JSON
is already selected it deliberately flattens every unsupported result through
the exact legacy row/warning contract in §1.2.

Both lock layers are conjunctive. A preflight probe is advisory only; the real
held-mutex admission rechecks them. Passing one does not prove the other.

Probe cleanup is not assumed infallible. `atomicCreateMarker` must surface temp
unlink failure as a typed I/O/indeterminate result. The command still refuses,
does not emit the proven-unsupported event, and may leave only the named
same-directory `.<lock>.<pid>.<random>.tmp` residue. Tests assert that bounded
grammar and cleanup on retry; they do not claim an impossible zero-residue law.

### 2.2 Ephemeral refusal and exact copy

```ts
type GenesisAdmissionRefusal = {
  readonly reason: "lock-unsupported" | "lock-indeterminate"
    | "lock-identity-unavailable" | "lock-io";
  readonly layer: "workspace" | "state";
  readonly error?: unknown;
};
```

This value exists only for the invocation. There is no `genesis-blocked` record,
record variant, write/clear API, report precedence, health lifecycle, or new
crash grammar. Doctor/status never infer a refusal from mere absence. Existing
logging may show the current process's refusal, but activity/status state may
not; it is not a new durable state machine.

All four findings have exact severity `blocked` and exact safety copy:
`Your files are safe. rbox stopped before syncing or changing any more files;
synced copies on the server and other computers were not changed.` Their exact
machine ids and problem copy are:

| Machine id | Exact problem |
|---|---|
| `state-genesis/lock-unsupported` | `rbox can't safely continue because this folder doesn't allow the locking rbox needs. Move this entire workspace folder, including its hidden .rbox folder, to a local disk, then run the same command there.` |
| `state-genesis/lock-indeterminate` | `rbox couldn't create the lock it needs in this folder. Check this folder's permissions and storage or security policy, then run the same command again. If it still fails, run rbox doctor.` |
| `state-genesis/lock-identity-unavailable` | `rbox couldn't verify this computer's identity for safe locking. Restart this computer, then run the same command again.` |
| `state-genesis/lock-io` | `rbox couldn't complete a storage operation needed to create, verify, or clean up the lock in this folder. Check that the disk has free space and that this folder is readable and writable, then run the same command again. If it still fails, run rbox doctor.` |

The first row's move instruction applies only to proven incapability. The
indeterminate row is neutral between host policy and filesystem cause. No row
advises deleting `.rbox`, a marker, or a database.

`state-plane-copy.ts` owns these four closed `OperatorCopy` rows, including the
shared safety line; command, daemon, and doctor Adapters do not rebuild their
words. `lock-io` covers `EMLINK`, other create/link/verify I/O, and surfaced
probe-cleanup failure. Like `EPERM`/`lock-indeterminate`, it makes no permanent
filesystem claim and emits no safety event.

For a configured but `uninitialized` root, doctor's existing `locking` check may
run the same advisory, same-directory probe (never admission or genesis). When
that current doctor invocation directly re-observes `lock-indeterminate` or
`lock-io`, its exact `DoctorCheck` row is:

| Refusal | `ok` | `label` | `status` | `message` | `hint` | `finding` |
|---|---|---|---|---|---|---|
| `lock-indeterminate` | `false` | `locking` | `state-genesis/lock-indeterminate` | the exact problem above | omitted | the same central id, `blocked` severity, problem, and safety copy |
| `lock-io` | `false` | `locking` | `state-genesis/lock-io` | the exact problem above | omitted | the same central id, `blocked` severity, problem, and safety copy |

The row has no invented durable evidence and no self-referential doctor command;
the human finding omits `command` because doctor cannot know which front-door
command the user was running. A later doctor invocation reports either row only
if its own probe re-observes it. Mere absence, an old daemon log line, and
`activity.json` are never evidence. Probe cleanup and possible bounded temp
residue retain §2.1's law.

### 2.3 Occurrence telemetry

Append `genesis_lock_unsupported` to the existing client/server
`safety_event.eventType` enum. The wire sample is:

```json
{"kind":"safety_event","eventType":"genesis_lock_unsupported","count":1}
```

Only `hardlink-unsupported` emits it. Identity, `EPERM`, capacity, I/O,
contention, owner loss, rendering, and lock retries do not. One top-level
track/init/adopt/export/foreground/daemon attempt owns one occurrence. Reuse the
existing authenticated `RboxApi` and `TelemetryQueue`; no state-plane telemetry
port or new queue/sidecar is introduced. A one-shot caller records once and
awaits one retry-zero flush bounded by 1.5 seconds. The daemon uses its existing
queue. Opt-out, absent credentials, timeout, 429, or network failure never
changes or obscures refusal.

## 3. Modules, Interfaces, and entry ownership

### 3.1 Observation and ordinary admission

`authority-bootstrap.ts` owns file-level observation and ordinary genesis
admission, but no longer dispatches between genesis and migration:

```ts
type StateAuthorityObservation =
  | { readonly kind: "uninitialized"; readonly format: "absent" }
  | { readonly kind: "legacy-json-store"; readonly format: "json" | "foreign" }
  | { readonly kind: "sqlite-store"; readonly format: "authority-marker"; readonly authorityId: string };

function observeStateAuthority(root: string): Promise<StateAuthorityObservation>;

type GenesisAdmissionResult =
  | { readonly kind: "selected"; readonly authority: Exclude<StateAuthorityObservation, { kind: "uninitialized" }> }
  | { readonly kind: "refused"; readonly refusal: GenesisAdmissionRefusal };

function admitGenesisAuthority(
  root: string,
  heldMutex: WorkspaceSyncMutex,
): Promise<GenesisAdmissionResult>;
```

Observation never locks, opens SQLite, or mutates. Raw read of `uninitialized`
returns `undefined`. Direct save, telemetry binding, capable-lineage, and reset
replacement refuse it; none delegates to the legacy writer.

Admission validates the borrowed mutex, acquires the canonical state lock,
recovers a surviving genesis intent, and freshly observes the result. Settled
JSON/Q remains the no-extra-lock fast path. `established` is accepted only as
exact Q with no intent; raced legacy stays exact JSON after genesis's existing
owned cleanup. Lock refusal returns the ephemeral value above.

The Interface gains no callback, mode, receipt, plan, durable record, or
telemetry dependency.

### 3.2 Config-to-genesis front doors

Each owner performs, under its real workspace mutex:

```ts
await saveConfig(root, config);
await fsyncDirectory(path.join(root, RBOX_DIR));
requireSelected(await admitGenesisAuthority(root, mutex));
```

The explicit owners and ordering are:

- `track-cmd.ts`: before registry/catalog/include completion or return;
- `init-cmd.ts`: before registry, folder admission, adoption start, key
  precheck, or first sync;
- `adopt-cmd.ts`: before initial journal/source mutation and, on resume, before
  any existing-journal mutation; and
- `export-cmd.ts`: in the private stage before its mutex-borrowing pull.

`saveConfig` itself does not gain a durability flag or make unrelated callers
pay the fsync.

Track continuation is decided in `track-cmd.ts` before create-new/rebind logic:
matching durable config + `uninitialized` reuses that config's remote workspace
id/stream and enters fsync/admission. It does not throw create-style rebind
consent and does not create a second remote. An explicitly different stream
retains existing consent. Same-stream JSON/Q re-track retains current behavior.

Init continuation is decided at the two real `init-cmd.ts` decision points:
`preflightInitRebind` before its current already-bound/rebind-consent branches,
and the workspace-selection branch in `executeInitPlan` before
`createRemoteWorkspace`/`createWorkspaceWithConsent`.

For an ordinary create-new retry (no `PrecreatedWorkspaceContinuation`, and no
reset-consent witness already carrying its own created-id continuation),
`preflightInitRebind` returns an invocation-local continuation **iff** all of
these are true:

1. `plan.workspace.kind === "new"`;
2. `loadConfigIfPresent(plan.root)` returns a config whose normalized
   `rootPath`, `remoteUrl`, `projectId`, optional `name`, `syncGit`,
   `respectGitignore`, and optional `scope` exactly equal the resolved plan;
3. file-level `observeStateAuthority(plan.root)` is exactly `uninitialized`
   (a surviving genesis intent does not disqualify the retry; admission owns its
   same-id recovery); and
4. the config contains a non-empty `remoteWorkspaceId`.

That classification runs before today's `oldStream`/`nextKnown` decision (a
new-workspace plan deliberately has no `nextKnown` stream). The returned value
captures the config's `remoteWorkspaceId` and matching fields. It is not a
durable record and carries no mutex. `executeInitPlan` consumes it in the
workspace-selection branch, reuses that ID, and does not call either remote
creation function. After acquiring the ordinary init mutex, the execution owner
re-reads config and authority and requires the same predicate before config
save/fsync/admission; drift refuses this invocation without creating a remote.

A matching explicit join and an in-memory precreated-workspace continuation
retain their existing paths. JSON/Q keeps today's “already bound; use `rbox
sync`” refusal, and any create-new config mismatch follows today's rebind-consent
decision rather than being adopted as a retry. Tests crash after durable config
at each later init boundary, then prove one remote creation total and reuse of
its ID on the next ordinary invocation.

Initial adoption calls `startAdoption` only after selected authority. Resume
acquires its fence through an outcome that preserves the closed lock cause; the
mutex helper may not convert unsupported locking into a generic adoption error.
Under that mutex, `ensureJournalConfig` validates or reconstructs matching
config, saves if needed, fsyncs `.rbox`, and admits genesis **before**
`refreshAdoptionContinuation`, registry/catalog repair, folder admission, or
`continueAdoption`. Thus refusal adds no journal mutation or source move. Moves
retained by an older attempt remain truthful and untouched.

Export removes its no-mutex exemption. Its private stage saves config, fsyncs,
acquires a real mutex, admits, lends that handle to pull, then publishes without
`.rbox`. Ordinary refusal cleans the stage; SIGKILL may retain only the existing
random unpublished stage, never a final artifact.

### 3.3 Real genesis/migration fork collapse

`establishStateAuthority`, `AuthorityOutcome`, `MigrationDriver`, `dispatch`,
`claimsGenesis`, and the shared genesis/migration import boundary are removed.
This is a concept deletion, not a relocation into another shared helper.

`state-plane-cmd.ts` owns the explicit `rbox migrate` entry decision:

| File-level row | `rbox migrate` result |
|---|---|
| exact JSON or migration control | invoke the existing migration coordinator under `foreground-migrate` locks |
| exact Q, no control | existing already-SQLite/no-op report |
| absent, no genesis intent | typed “there is no legacy state to migrate; run track/init first”; zero mutation |
| surviving genesis intent | invoke ordinary `admitGenesisAuthority` once to recover it, then report Q/refusal; never enter migration |
| foreign/malformed/corrupt | existing fail-closed report |

There is one `EntryPoint` literal, `foreground-migrate`; it may become a literal
field instead of a union. Retry/abort remain migration-only. The ordinary
admission Interface remains the only genesis owner.

### 3.4 Upgrade call removal, not module deletion

SP-3 removes from `cycleOneDaemon` the dynamic import/call of
`migrateStateInUpgradeWindow`, its conversion loop/catch, and conversion output.
Stop → desired-state check → restart remains. `upgrade-state-window.ts`, its
tests, exports, and CODEMAP row remain physically present, marked retired and
unreachable from production; SP-4 owns closure-complete deletion. No SP-3 step,
size gate, or inventory may smuggle that deletion.

Candidate-side removal cannot change the inode of an already-running old
`rbox upgrade` process. Therefore the first transition from any hook-bearing
binary is ordered as:

```text
old rbox stop
  -> binary-only stable/next installer (never `rbox upgrade`)
  -> candidate `rbox --version` + expected version/hash verification
  -> candidate `rbox migrate` or re-genesis recipe
  -> candidate `rbox start [--pull-only]`
```

The installer only swaps the binary and cannot run the hook. The old daemon is
already stopped, and no old upgrade process survives to restart it. The first
managed `rbox upgrade` on that host therefore runs only after the candidate is
installed, so its executable contains no call. This is the SP-3 ordering
guarantee; using old `rbox upgrade` for the boundary is prohibited.

### 3.5 Daemon refusal owners

Both paths catch `GenesisAdmissionRefusal` in the daemon Adapter, render the
central copy, record at most one event for that top-level attempt, and stop that
attempt without inventing a durable state-plane row:

- direct startup: `runDaemon` owns the catch around `daemon.start()`, whose
  startup `loadSyncBase` reaches admission;
- contended scheduler entry: `RboxDaemon.openOperationBoundary` owns the catch
  around its `loadSyncBase`; `DaemonOperationScheduler` remains policy-only and
  receives a parked/stop result rather than state-plane knowledge.

There is no refusal latch, including no field on `RboxDaemon` and no addition to
`DaemonActivity`. In particular, the refusal never enters `activity.json`,
`activity.halt`, `shell.line`, `shell.deferrals`, or another status sidecar. The
direct-start catch logs once and exits that start attempt. The contended path
re-runs admission on every scheduler attempt and routes identical refusal text
through daemon.ts's existing pump-error dedup (`lastErrMsg`/`errRepeat`): log the
first occurrence and every tenth identical repeat, with the existing `(xN)`
suffix. It bypasses `recordClassifiedFailure` and every `writeActivity` call.
This existing invocation-memory log discipline bounds noise without creating a
new state concept. Each actual attempt independently applies §2.3's occurrence
rule and asks the existing queue for its bounded flush; merely queueing work
emits nothing. Process restart simply reattempts admission, with no clear
protocol because nothing was persisted.

## 4. Required behavior and crash matrix

The authority matrix is total: raw absent with or without config is inert;
held-lock absent admits exact Q; absent mutation without admission refuses; E0
reset returns its existing `void` but publishes nothing; JSON and JSON+intent
retain exact selection/owned cleanup; Q retains its fast path; Q/absent+intent
recover the same id; malformed/foreign/corrupt remains zero-repair refusal.

The lock matrix is also total: both owned proceeds; proven unsupported at either
layer uses its layer and one event; `EPERM` is indeterminate with no event;
identity/capacity/I/O/cleanup use their typed non-disk results; held remains
contention; wrong/released/lost ownership runs no body; JSON degradation is
exact; Q writes remain fail-closed. Refusal permits only pre-existing config and
the bounded probe temp from surfaced cleanup failure—never health, intent, DB,
or Q.

### 4.1 Config/genesis crash boundaries

| ID | Boundary | Restart law |
|---:|---|---|
| C0 | config temp fsynced, before rename | old/absent config; no intent |
| C1 | rename, before `.rbox` fsync | old/absent/new config under power model; no intent |
| C2 | `.rbox` fsync, before intent | durable config + absent; any admitted entry creates Q |
| C3 | intent through before Q rename | design 263 same-id recovery |
| C4 | Q rename through intent retirement | Q+intent recovery |
| C5 | Q before registry/catalog/scope | retry completes later work; no second genesis |
| C6 | include rollback failure after Q | scope cursor owns retry; Q stays |
| C7 | adoption after Q, before journal | no source move; retry starts one journal |
| C8 | resumed adoption before admission | no resume mutation; config follows C0–C2 |
| C9 | export exception/SIGKILL | ordinary cleanup; SIGKILL may leave one unpublished random stage only |

No crash matrix is added for refusal persistence because refusal is ephemeral.

### 4.2 Version contract

The operator rule is: **no concurrent or alternating mixed-version operation;
after Q publication never run 1.x on that root.** Sequential one-way takeover of
a stopped 1.x JSON root by the candidate is required and is not “co-use.”
Distinct devices may temporarily use local 1.x JSON and candidate Q against the
same remote because the sync wire is unchanged.

The candidate reads and syncs unchanged 1.x JSON. A released 1.11.4 binary sees
Q as too new and refuses without mutation. There is no downgrade converter.

## 5. Differential product matrix

Compare pre-flip legacy oracle vs candidate for exit/output, remote requests and
bodies, remote head/manifest, files, Git refs, config, logical state, and restart
convergence. State-file bytes differ only where the approved format changes.

Required rows: bind-only track creates Q before success with no sync; a refused
create-new retry reuses one remote id; every init/setup direction creates Q
before scan/network/return; paired Q roots converge; JSON stays byte/output/wire
exact; settled Q keeps its fast path; every refusal cause has exact copy and
event law; C0–C9 cross-entry restarts converge; adoption never mutates before Q;
directory/tar export uses private held-lock Q and publishes no `.rbox`; and JSON
upgrade performs zero state-plane call/read/mutation/output.

## 6. Test and suite dispositions

All existing SP-1, SP-2a, and SP-2b ledgers remain MUST. No case disappears
because its fixture relied on absent→JSON; legacy tests seed explicit JSON and
fresh tests expect Q.

| Suite/group | Required disposition |
|---|---|
| lockfile, sync-mutex, state-plane locks | classify `EPERM` indeterminate; preserve exact JSON row/warning; both layers; cleanup-failure residue |
| authority-bootstrap, whole-state Adapter | observer rename, A/L matrices, zero absent legacy writes, no shared migration dispatch |
| genesis/reset crash suites | C0–C8; E0 publishes nothing; all 263/265 rows preserved |
| track/init/setup | F0–F3/F7; fsync order; exact continuation predicates; one remote create |
| adoption suites | admission before resume mutation; preserved unsupported cause; C7/C8/F9/F11 |
| export suites | real mutex/Q, C9, byte/cleanup differential |
| daemon/LocalRuntime | direct and contended catch ownership; re-refusal per attempt; existing first/every-tenth pump-log dedup; no activity/halt/shell latch or durable refusal row |
| JSON/store/telemetry state | exact explicit-JSON bytes, health, warning, fallback; absent writes refuse |
| upgrade suites | preserve lifecycle/mode; assert zero state-plane call/output; keep retired module/tests physically present |
| migration suites | explicit-command-only inventory; absent/genesis-intent rows in §3.3; retry/abort unchanged |
| copy/report/doctor/status | exact four-row §2 copy; current-probe indeterminate/I/O doctor rows; absence alone is neutral; no `genesis-blocked` schema/API |
| telemetry client/API | exact enum/sample, opt-out/failure, count ownership, parity |
| inventory/CODEMAP/size | one genesis owner, one migration literal, retired upgrade module still present, current baselines |

SP-2.5 amendments are SP-3 merge deliverables:

1. `sqlite-fresh-install` asserts Q immediately after each `track`; remove the
   explicit `rbox migrate` crutch before that assertion.
2. `json-upgrade-path` constructs its JSON fixture before any candidate entry
   that would genesis the root; candidate then enters and preserves it.
3. `scripts/rig/lib/state-view.ts` imports/calls `observeStateAuthority`, not the
   removed `selectStateAuthority` symbol.

Released compatibility is also an SP-3 deliverable:

- turn the released-binary `compat-matrix.test.ts` `test.todo` row into MUST;
- add a dual-binary rig scenario declaring explicit dual-binary support, pinning
  released **1.11.4** against the candidate;
- have 1.11.4 create/sync/stop a JSON root, then let the verified candidate take
  it over sequentially and prove JSON byte compatibility before explicit
  migration;
- after candidate migration, run isolated negative 1.11.4 status/sync/doctor
  probes against snapshots of Q and require too-new refusal plus byte-identical
  `.rbox`; this test-only probe is not operator permission to run 1.x after Q;
- prove a separate 1.11.4 JSON root and candidate Q root converge through one
  remote workspace; and
- persist both binary paths, SHA-256 values, and observed versions in the rig
  report.

Run the full affected suites, `bun run typecheck`, `bun run lint:affected`, and
`bun run rig` FAST plus the amended and dual-binary scenarios on the exact
candidate.

## 7. Ordered implementation and validation

1. Freeze JSON/Q/output/wire/upgrade/adoption/export goldens at this HEAD.
2. Add `uninitialized`; close every absent mutation path; rename the observer.
3. Split invocation-local lock causes, `EPERM`, and cleanup failure while
   preserving the exact selected-JSON health/copy path.
4. Flip E0 and add config fsync/admission to all four front doors. Fix track/init
   continuation and adoption-resume ordering.
5. Centralize ephemeral refusal copy and occurrence telemetry; add both daemon
   catches.
6. Collapse shared genesis/migration dispatch. Remove only the upgrade caller
   and its output; retain the retired module/tests for SP-4.
7. Amend SP-2.5 and add the 1.11.4 dual-binary proof.
8. Run §6, structural/performance gates, and build the exact candidate.
9. Use §9's installer-only boundary on the founder fleet. SP-4 begins only after
   every root is Q/healthy and backups remain outside the workspaces.

### 7.1 Structural gates

- zero `absent` member under `legacy-json-store` and zero absent→JSON production
  write;
- one observer and one complete genesis-admission Interface;
- zero shared genesis/migration dispatch symbols/import boundary;
- exactly four config-to-genesis owners with save/existing config → `.rbox`
  fsync → admission before mutation;
- zero production E0 call to `installGenesisResetStateUnderHeldLock`; retain the
  symbol/tests as an SP-4 deletion candidate;
- zero `upgrade-cmd.ts` import/call of `upgrade-state-window`; module/test/CODEMAP
  row still exist and are marked retired;
- exact JSON health row and warning goldens unchanged;
- zero `genesis-blocked` type, API, durable row, clear path, report branch, or
  crash test;
- zero daemon refusal latch and zero refusal projection into activity, halt, or
  shell sidecars; existing `lastErrMsg`/`errRepeat` remains the sole repeat-log
  discipline;
- one client/server event enum, emitted only for proven unsupported causes;
- zero new flag, fallback, queue, sidecar, route, index, or durable record;
- JSON evaluated closure remains free of `bun:sqlite`; ordinary raw authority
  observation evaluates no SQLite/genesis/lock chunk (doctor's explicit
  configured-root advisory probe is the named exception); and
- CODEMAP updates changed ownership without deleting the retired module line.

### 7.2 Current size and performance anchors

At `44f0e917`, the corrected formerly blank anchors are `reset-state.ts` 461 /
25,974 and `legacy-json-store.ts` 398 / 20,232. The retired
`upgrade-state-window.ts` is 121 / 6,600 and must remain present;
`upgrade-cmd.ts` is 499 / 23,827 and must shrink. Other populated v1 baselines
were verified exact in round 1. Re-measure the implementation base; line count
is a warning, not a file-splitting target, and no suite count is claimed without
runner output.

Record before/after p50/p95 and operation counts for settled JSON/Q load, raw
absence, track/init admission, adoption before first move/resume, export pull,
refused telemetry, and upgrade per daemon. JSON/Q keep their no-admission-lock
fast paths. Raw absence performs one bounded format read. Each fresh front door
pays one required directory fsync and one genesis, without duplicate walks,
state materialization, or store opens. Upgrade performs zero state-plane reads.

## 8. Requirement challenges and deletion boundary

Rejected requirements and their avoided costs: fresh JSON fallback (two births),
filesystem allowlists (false positives), `EPERM` as disk proof (false advice),
durable blocked-genesis state or daemon activity latch
(record/API/clear/crash protocol), universal config
fsync mode (unrelated hot paths), authoritative preflight probe (TOCTOU), durable
telemetry counter (replay/dedup), automatic migration (hidden authority choice),
and SP-3 module deletion (retirement without closure proof). The replacements
are the single admission primitive, ephemeral refusal, existing event queue,
caller removal, and SP-4 deletion proof.

SP-3 does not delete/refuse existing JSON, migration/retry/abort, reset/genesis
recovery, the retired upgrade module, or export stages after SIGKILL. It adds no
remote cleanup, downgrade converter, filesystem allowlist, flag/mode, D1
migration, telemetry route/index, or new diagnostic record.

## 9. Founder-fleet cutover

Preserve every backup until SP-4 ships and is separately verified. Record per
root: workspace id/name, scope, `.rboxignore`, `syncGit`, `respectGitignore`,
folder `noDrift` and trash policy, desired daemon mode, remote head/sequence,
Git deferrals, candidate hash/version, and `doctor --json`.

### 9.1 Mandatory binary boundary

On every host still running a hook-bearing build:

```text
old rbox stop
curl -fsSL https://rbox.to/next/install.sh | sh   # binary-only candidate swap
sha256sum ~/.rbox/bin/rbox                        # verify against the release manifest hash before start
candidate rbox --version                          # verify expected version/hash
```

Do not use `rbox upgrade` for this transition. After candidate verification,
use exactly one recipe below. Re-assert daemon mode explicitly at the end; do
not rely on moved config or old desired-state inference.

### 9.2 In-place JSON migration

```text
candidate rbox migrate
candidate rbox doctor --json
candidate rbox sync
candidate rbox start --pull-only   # if recorded pull-only
# OR
candidate rbox start               # if recorded read-write
```

Require exact 58-byte Q, matching at-rest DB, no intent/control or WAL/SHM,
healthy doctor, explained remote convergence, and witnessed intended mode. If
migration refuses, keep the root stopped or use only the candidate; never
delete markers/databases ad hoc.

### 9.3 Re-genesis

Use only after sync is settled and policy/id are recorded.

1. Stop and verify no process uses the root.
2. Rename the entire live `<root>/.rbox` to a timestamped backup **outside
   `<root>`**, for example `<root-parent>/rbox-cutover-backups/<root-name>-<ts>/.rbox`.
   Never create `<root>/.rbox.pre-*`; only exact `.rbox/` is built-in ignored and
   such a sibling can be published.
3. Run candidate `rbox track <root> --workspace <id>` with the captured Git and
   ignore policy, then restore the captured name, scope, folder no-drift/trash
   policy, and `.rboxignore` before any sync. Verify those values from the live
   config/folder projection; do not accept defaults silently.
4. Verify Q + matching DB + no intent before sync.
5. Start explicitly with `candidate rbox start --pull-only` or
   `candidate rbox start` according to the recorded policy. Verify the daemon
   reports that mode before allowing convergence.
6. Resolve each Git deferral deliberately; preserve the external backup.

If an external backup location is impossible, add its exact relative path to
the live `.rboxignore`, verify the matcher reports it ignored, and only then
rename; outside-root backup is preferred.

### 9.4 Flat Meadow

FM remains parked until desktop and Mac are healthy Q publishers. Use the same
outside-root backup and complete policy capture/restore. After Q verification,
the first daemon command is literally:

```text
candidate rbox start --pull-only
```

Confirm files, remote sequence, Git deferrals, daemon health, pull-only witness,
and zero echo publication. Change to read-write only after founder approval and
then re-assert it explicitly with `candidate rbox start`.

SP-4 may begin only after desktop, Mac, and FM each have verified candidate
version/hash, Q + matching at-rest DB, no intent/control, healthy locks, an
ordinary converged sync, witnessed intended daemon mode, and a named retained
backup outside the workspace.

SP-3 succeeds when absence has one meaning—no authority—and one birth protocol:
held-lock SQLite genesis. It fails if absence reaches JSON, JSON bytes/copy drift
outside the one approved upgrade-call removal, adoption mutates before
admission, old upgrade code can execute at the boundary, a backup is publishable,
or 1.x is allowed back onto a Q root.
