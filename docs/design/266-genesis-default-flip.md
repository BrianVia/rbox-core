# 266 — Genesis is the absent-state default

Status: DRAFT v3 — SP-3 of design 262 v2; engineering ALIGNED after the capped
three review rounds. The filesystem product boundary and exact user copy in §1
still require founder sign-off. SP-2b/design 265 is still in flight. SP-2.5 may
proceed in parallel and gates the **implementation merge**, not this design
review.

This slice makes SQLite genesis the only ordinary way a bound workspace with no
state acquires authority, removes `rbox upgrade`'s automatic JSON→SQLite pass in
the same candidate, states the 1.x/candidate co-use rule, and supplies the
founder-fleet cutover runbook. It deliberately keeps existing JSON authority
working. JSON refusal and the migration-tree/legacy-store retirement remain
SP-4.

Depends on: 262 v2 (slice charter and order), CODEX-262-A finding 4 (upgrade
window/mixed-version hazard), 263 v4 (held-mutex genesis admission and the
post-config `.rbox` fsync prerequisite), 264 v5 (selected telemetry and
fail-closed SQLite saves), 265 v4 (selected reset/rebind), and SP-2.5's landed
rig/e2e authority dimension before implementation merge.

Authored against `f36c085ba` plus the visible SP-2b corrective worktree on
2026-08-15. Implementation rebases on the merged SP-2b commit and re-measures
every baseline in §8; provisional counts are not merge evidence.

## 0. Yardstick and gates

A successful fresh `rbox track`, `rbox init`, or setup flow returns only after:

```text
workspace config rename
  -> fsync .rbox
  -> healthy held-mutex genesis admission
  -> exact Q + matching state.db + retired genesis intent
  -> remaining binding/catalog work and optional first sync
```

Thus `track` closes its intentional no-first-sync gap: the command still does no
network sync, but it leaves SQLite authority before returning. `init --no-sync`
does the same. A later foreground or daemon entry remains the crash-recovery
backstop, not the first routine creator.

Two less-visible absent-state consumers obey the same prerequisite. Initial
adoption admits genesis before it journals or moves source entries; adoption
resume repairs a missing binding durably and admits genesis before continuing.
Each process-private export pull stages an ordinary config, fsyncs its `.rbox`,
holds a real workspace mutex, admits Q, and lends that mutex to `pull`. Export's
old no-mutex exemption is retired because uniqueness prevents contention but is
not proof of the owner-token lock required by SQLite saves.

The implementation is accepted only when all of these are simultaneously true:

1. `absent` is no longer a spelling of `legacy-json-store`. Observation may
   return `uninitialized`, but no ordinary state write, telemetry mint, capable-
   lineage initialization, or consent-free reset may publish new JSON.
2. Genesis requires both lock layers supported, acquired, and still owned. A
   proven hardlink-unsupported root receives the §1 refusal before an intent,
   database, authority marker, adoption journal, or adoption source move.
   Identity acquisition failure is a different refusal and never tells a person
   that moving the folder will fix their computer.
3. Existing JSON workspaces retain their reads, writes, reset/rebind, telemetry,
   degraded-lock fallback, bytes, and command behavior. They are not migrated by
   `rbox upgrade` and are not refused by this slice.
4. `rbox upgrade` still stops/replaces/restarts daemons, but has zero state-plane
   conversion call, output, or mutation. Explicit `rbox migrate` and doctor
   retry/abort remain until SP-4.
5. A 1.x binary and the candidate never operate on the same local workspace
   root. Separate devices on the same remote workspace may temporarily run 1.x
   JSON and candidate SQLite because workspace sync wire/API behavior is
   unchanged; the telemetry enum append is backward-compatible and unrelated.
6. SP-2.5's SQLite FAST dimension, fresh-install e2e, and JSON upgrade-path e2e
   are green on the exact candidate build. This is a hard implementation-merge
   gate, not a reason to block or weaken this design.
7. Every top-level genesis attempt refused specifically for proven filesystem
   lock capability records the stable local finding and, when an authenticated
   transport exists and telemetry is enabled, emits the exact §1.4 safety event.

## 1. Founder product decision — the filesystem boundary

This is a product boundary, not an implementation fallback:

> A workspace using rbox's current SQLite sync-record format requires a local
> filesystem on which rbox can acquire and retain both of its file locks. A
> fresh workspace on a lock-unsupported root does not fall back to JSON.

The capability is probed, not guessed from a filesystem name. APFS, ext4, a
mounted volume, and a network filesystem are not accepted or rejected by name.
The boundary is the lock primitive's actual atomic-hardlink publication at
`.rbox/state/sync.lock` and `.rbox/state.json.lock`. Host identity discovery and
lock-marker formation are prerequisites to that probe, but failures there are
**not** evidence about the root's filesystem.

### 1.1 What a person experiences

| Situation | Product result |
|---|---|
| fresh absent root; both locks healthy | config is made durable, genesis publishes SQLite, command continues |
| workspace mutex reports proven `hardlink-unsupported` | setup stops with the filesystem finding; no genesis intent/DB/`Q`; locking health durably records the layer or reports that evidence unavailable |
| canonical state lock reports proven `hardlink-unsupported` | same filesystem refusal/evidence rule at layer `state`; no genesis intent/DB/`Q` |
| host identity cannot be resolved or encoded | setup stops with the identity finding; never claim the disk is unsupported |
| hardlink returns `EMLINK` | setup stops with existing lock I/O/retry result; capacity is not a permanent root verdict |
| either lock is held | ordinary bounded busy/contended result, not “filesystem unsupported”; retry may succeed |
| lock acquisition has an I/O error | existing typed I/O failure; do not mislabel the disk permanently unsupported |
| ownership is lost after acquisition | fail closed at the existing adjacent owner checks; any owned crash image is resumable |
| existing JSON on an unsupported root | continues through the approved legacy degraded fallback until SP-4 |
| existing exact `Q` later moved to an unsupported root | reads may diagnose it; writes and telemetry mutation remain fail-closed per 264; never fall back to JSON |

The two lock checks are conjunctive. Passing the workspace mutex does not prove
the canonical state lock, and vice versa. A probe made before a remote call is
not authority because filesystem support can change; the checks that authorize
genesis remain inside the real held-mutex admission. `acquireLock` therefore
adds a closed cause to its existing `unsupported` result:

```ts
type LockUnsupportedReason =
  | "hardlink-unsupported"
  | "identity-unavailable"
  | "link-capacity";

type LockAcquireUnsupported = {
  readonly status: "unsupported";
  readonly reason: LockUnsupportedReason;
  readonly error: unknown;
};
```

Only `ENOTSUP`, `EOPNOTSUPP`, `ENOSYS`, `EXDEV`, or `EPERM` from atomic
hardlink publication after the same-directory temp was created produces
`hardlink-unsupported`: this root does not provide the required primitive.
`EMLINK` becomes `link-capacity`, a resource condition that refuses genesis with
the existing I/O/retry surface and never receives disk-move copy or telemetry.
Failure to acquire/refresh identity or format its marker produces
`identity-unavailable`. Other create, verify, or I/O failures remain
`status: "error"`; contention remains `held`. Existing JSON behavior is
preserved because `sync-mutex.ts` still degrades all three unsupported reasons
for selected JSON, but carries the closed reason instead of flattening them to
`identity-unavailable`.

`track`/`init` may already have created or selected a remote workspace when this
refusal is learned. SP-3 does not delete that remote workspace. A retry on
supported local storage reuses the known workspace id. Initial adoption moves
its `startAdoption` call after durable config and successful admission, so a
first refusal occurs before its journal or source moves. A resumed adoption may
of course already contain retained moves from an older attempt; the refusal
does no additional adoption mutation. Inventing remote cleanup would add a
second destructive protocol to solve a local capability refusal.

### 1.2 Exact non-developer copy

The new closed filesystem refusal is `lock-unsupported`. Its canonical finding
is intentionally valid for a workspace root, an adoption continuation, and an
ephemeral export staging root:

| Field | Exact value |
|---|---|
| machine id | `state-genesis/lock-unsupported` |
| severity | `blocked` |
| problem | `rbox can't safely continue because this folder doesn't allow the locking rbox needs. Choose a folder on this computer's local storage, then try again.` |
| safety | `rbox stopped before syncing or changing any more files. Your synced data on the server and on your other computers was not changed.` |
| command | omitted: no command can honestly choose or move an arbitrary folder for the user |

Identity failure has a different canonical finding:

| Field | Exact value |
|---|---|
| machine id | `state-genesis/lock-identity-unavailable` |
| severity | `blocked` |
| problem | `rbox couldn't verify this computer's identity for safe locking, so it stopped. Restart this computer, then try again.` |
| safety | `rbox stopped before syncing or changing any more files. Your synced data on the server and on your other computers was not changed.` |
| command | omitted: restart is the truthful first action; `doctor` may describe the same finding but cannot repair host identity |

This deliberately does not say SQLite, authority, mutex, identity, degraded,
re-adopt, or “new format.” It does not recommend deleting `.rbox`, the marker,
or a database. It says what happened, what is safe, and the physical remedy a
person can perform. The founder must approve both the storage boundary and
these words before implementation merge.

### 1.3 Copy and occurrence inventory

The two findings above are exhaustive vocabulary rows in `state-plane-copy.ts`;
no caller authors a second paragraph. The implementation must surface the
cause-correct id and words at every applicable occurrence:

| Surface | Required occurrence |
|---|---|
| `track` / `init` / setup stderr | render once for the top-level refused attempt; refusal precedes adoption journal/source mutation; no preceding “continuing with legacy state saves” warning |
| `rbox adopt resume` | render once after the existing journal is safely parked; do not imply that prior retained moves were undone |
| `rbox export` | render once; ordinary refusal unwinding removes process-private staging and no final artifact is published; SIGKILL follows C9b |
| foreground sync and direct daemon startup | same typed refusal; the daemon latches the problem text rather than an internal exception |
| contended daemon scheduler entry | once when the real acquired boundary reaches admission; no count while merely queued |
| `rbox doctor` human + `--json` | render the exact durable `genesis-blocked` finding while authority is absent; facts may name layer/root but never interpolate errno/stack |
| status brief/detail + JSON | render only a durable `genesis-blocked` row; absence alone is never inferred as failure; exact `Q` uses existing write-blocked wording and JSON keeps truthful legacy-degraded wording |
| locking-health warning | replace the unconditional “continuing with legacy state saves” sentence with authority-neutral wording; only the selected JSON surface may claim the fallback |
| rig/e2e assertions | match the machine id, not only exit code or free-form text |

“Occurrence” means one top-level refused admission attempt, not every selector
read, lock retry, fence recheck, or later rendering of the same durable
`locking-health.json`.

### 1.4 Required occurrence telemetry

Design 264's deferred requirement is implemented, not renamed. Append
`"genesis_lock_unsupported"` to both the client and server closed
`safety_event.eventType` enums. The wire sample is exactly:

```json
{"kind":"safety_event","eventType":"genesis_lock_unsupported","count":1}
```

Only the `hardlink-unsupported` finding records this event. Identity, I/O,
contention, and owner-loss outcomes do not. The typed refusal bubbles to the
top-level Adapter, which records exactly once for that command/cycle; retries
inside lock acquisition and report rendering do not record. Track, init/setup,
adopt resume, export, and `LocalRuntime` use a one-shot `TelemetryQueue` over
their authenticated `RboxApi` when available, call `record` once, then await one
`flush(AbortSignal.timeout(1500))`. The daemon records on its existing queue and
immediately requests the same bounded flush before latching the refusal. Queue
transport remains `POST /v1/telemetry` with `retries: 0`.

The telemetry owner exposes one complete convenience, not six handwritten
queue lifecycles:

```ts
export async function flushSafetyEventOnce(
  transport: TelemetryTransport,
  eventType: SafetyEventType,
  signal: AbortSignal = AbortSignal.timeout(1500),
): Promise<void>;
```

It constructs the existing queue, records count 1, and awaits `flush(signal)`;
it catches every telemetry failure. `buildAuthedRemote` returns its already-
constructed `RboxApi` as `telemetryTransport` for `LocalRuntime`; it does not
add telemetry to `SyncDeps` or expose the transport to state-plane code. Init,
adoption resume, and export already own the credentials and remote coordinates
needed to construct the same `RboxApi`; track does so when it has credentials.
No authority coordinator,
store Adapter, or lock primitive imports telemetry.

Telemetry is best-effort and never changes the refusal: `RBOX_TELEMETRY=0`, no
credentials (permitted for offline `track --workspace`), timeout, 429, network
failure, or server rejection produces no retry sidecar and cannot hide or delay
the local finding beyond the 1.5 s bound. Every occurrence attempts the same
durable locking-health observation under §3.2; if that write succeeds, doctor
sees the latest condition rather than an event history. It is not a counter or
upload queue. Repeated user
invocations are distinct occurrences and may yield
distinct count-1 samples. Existing queue coalescing may combine multiple daemon
occurrences before a concurrent flush, in which case `count` is their exact sum.

The API adds only the enum value to its mirrored validator. The accepted point
remains `client.safety_event`, with blob `genesis_lock_unsupported` and double
`count`; no D1 migration, device/workspace identifier, filesystem name, path,
layer, errno, or new Analytics Engine index is added.

## 2. Protected-functionality ledger

| Protected contract | Owner after 266 | Acceptance evidence |
|---|---|---|
| Exact JSON remains a supported authority on this candidate: same whole-state values, bytes, generations, reset/rebind, telemetry binding, degraded-lock save, warnings, and stream mismatch behavior | legacy JSON Adapter and selected whole-state Adapter | §6 JSON differential and SP-2/2b suites |
| Exact `Q` retains 263–265's authority-id binding, one selected store, write fence, reset recovery, owner-token CAS, telemetry singleton, S0-at-rest law, and crash recovery | authority coordinator, whole-state Adapter, store/reset owners | §6 SQLite regression and SP-2.5 |
| `foreign`, malformed, too-new, corrupt marker/DB, standing reset, and genesis-intent rows keep their existing fail-closed classifications and owned cleanup limits | current file-level classifiers and protocol owners | authority/genesis/reset matrices |
| Raw read-only observation of absent state returns `undefined` and creates no authority; diagnostics do not become writers | authority observation + read-only Adapter | A0/A1 and whole-tree snapshots |
| Every ordinary absent-state mutation is preceded by successful genesis admission; direct save/telemetry/capable-lineage/reset paths cannot manufacture JSON | authority coordinator + selected Adapter | structural inventory and A2–A7 |
| Fresh `track` is still bind-only and makes no first network sync; its output and registry/catalog behavior remain, with SQLite durable before return | `track-cmd.ts` Adapter | T matrix and output golden |
| `init`/setup retain remote create/join, consent, config, folder-policy, encryption, first-sync direction, and summary behavior; SQLite exists even under `--no-sync` | `init-cmd.ts` Adapter + existing owners | I matrix and setup suites |
| Adoption retains consent, journal, source-retention, resume/abort, Git, and rollback semantics; initial file movement begins only after Q, and resume repairs config durability/Q before continuing | init/adopt Adapters + adoption owner | adoption crash/differential rows |
| Export retains account/workspace selection, same-directory atomic publication, cleanup, tree contents, marker, and tar behavior; its private pull tree now uses ordinary held-lock Q state | export Adapter | export differential and cleanup rows |
| The workspace-config rename is parent-durable before it may become genesis evidence | binding front doors using `fsyncDirectory(.rbox)` | C0–C4 power-cut matrix |
| Upgrade binary verification/replacement and daemon stop/restart/desired-mode behavior remain unchanged; state conversion and its lines are absent | `upgrade-cmd.ts` | U matrix and zero-state-tree differential |
| Explicit migration, retry/abort, migration controls, backups, copy, tests, and readiness paths remain supported for fleet cutover and SP-4 | state-plane command/migration owners | preserved migration suites |
| 1.x sees candidate `Q` as too new and refuses without mutation; candidate continues to read JSON | released/candidate compatibility contract | hermetic compatibility matrix + SP-2.5 signed dual-binary rig |
| Workspace sync/API, remote manifests/commits, encryption, Git semantics, scan/watch behavior, and fleet sync-state payload remain unchanged; §1.4's telemetry enum append is the sole wire delta | existing owners | differential fresh-install matrix + telemetry contract parity |
| Existing opt-out, queue bounds/backoff, telemetry endpoint authorization/rate limit/drop rules, and Analytics Engine index remain unchanged; one safety-event enum is appended | telemetry client/API owners | contract parity, queue, ingest, and occurrence suites |

Approved behavior changes are exactly: absent authority defaults to genesis,
lock-unsupported fresh roots refuse instead of using JSON, config becomes
parent-durable before genesis, consent-free empty reset stops publishing JSON,
and upgrade no longer performs automatic migration. No existing JSON workspace
is refused, migrated, renamed, or deleted.

## 3. Ownership and exact Interfaces

### 3.1 Absence is an observation, not a backend

`authority-bootstrap.ts` remains the one authority decision owner. Its file-
level result stops encoding absence as legacy:

```ts
export type StateAuthorityObservation =
  | { readonly kind: "uninitialized"; readonly format: "absent" }
  | {
      readonly kind: "legacy-json-store";
      readonly format: "json" | "foreign";
    }
  | {
      readonly kind: "sqlite-store";
      readonly format: "authority-marker";
      readonly authorityId: string;
    };

/** File-level observation only. Never takes locks, opens SQLite, or mutates. */
export async function observeStateAuthority(
  root: string,
): Promise<StateAuthorityObservation>;
```

Renaming `selectStateAuthority` to `observeStateAuthority` is required because
`uninitialized` is not selected authority. There is no `backend?:`, boolean,
default flag, or caller-supplied mode.

Read-only Adapter behavior is total:

| Observation | `loadRawState` / reset-consent observation |
|---|---|
| `uninitialized` | `undefined`, zero mutation |
| JSON/foreign | current legacy read/classification |
| SQLite | current bound store read |

Mutation behavior is also total: `applyStateSavePacket`,
`ensureTelemetryBindingId`, `ensureCapableStateLineage`, and reset-lineage
replacement reject `uninitialized` with the typed admission-required result.
They never delegate it to the legacy writer. Ordinary production orchestration
must establish authority at its held-mutex boundary first; a direct lower-level
call cannot create a shadow default.

### 3.2 One complete genesis-default operation

The coordinator's existing normal-entry operation becomes total over the new
observation and returns only durable authority or a typed refusal:

```ts
export type GenesisAdmissionRefusal =
  | {
      readonly reason: "lock-unsupported" | "lock-identity-unavailable";
      readonly layer: "workspace" | "state";
      readonly health: "durable" | "unavailable";
    }
  | { readonly reason: GenesisRefusal };

export type GenesisAdmissionResult =
  | {
      readonly kind: "selected";
      readonly authority: Exclude<StateAuthorityObservation, { kind: "uninitialized" }>;
    }
  | { readonly kind: "refused"; readonly refusal: GenesisAdmissionRefusal };

export async function admitGenesisAuthority(
  root: string,
  heldMutex: WorkspaceSyncMutex,
): Promise<GenesisAdmissionResult>;
```

Rules:

1. Intent-first recovery remains exactly 263: a surviving intent is claimed for
   every observed format, including `Q + intent` and `json + intent`.
2. Settled exact JSON or `Q` with no intent returns selected without taking
   genesis locks or opening SQLite. If and only if an exact stale
   `genesis-blocked` health row exists, those two usable authorities durably
   clear it before success. `foreign` retains its existing artifact refusal and
   never attempts a clear that could mask it. The usable-authority clear is a
   bounded diagnostic-file read/unlink, not authority work.
3. `uninitialized` validates the borrowed workspace mutex. A degraded handle
   maps by its closed reason: `hardlink-unsupported` to the filesystem refusal,
   `identity-unavailable` to the identity refusal, and `link-capacity` to the
   existing lock I/O/retry outcome. Wrong-root, released, or lost-owner handles
   remain defects/transient ownership failures; they are not mislabeled
   unsupported.
4. `withGenesisAdmissionLocks` returns the canonical state-lock's closed
   unsupported reason rather than flattening it into an exception. The same
   cause mapping applies. `held`, `error`, and owner loss retain their existing
   distinct outcomes. No genesis body runs on any failed row.
5. A protocol refusal from `genesis.establish` is returned typed, then authority
   is freshly observed. `established`/`already-established` is accepted only as
   exact settled `Q` with no intent. A raced `legacy-present` returns selected
   JSON after its existing owned cleanup; artifact/evidence refusal cannot be
   converted into an uninitialized legacy backend.
6. `whole-state-compat.ts` consumes this one operation. It does not inspect lock
   support or genesis phases itself. A typed refusal is rendered through the
   central state-plane report/copy path; generic adapters do not author words.

The operation gains no telemetry port, callback, plan, receipt, capability
echo, or exported lock mode.

`sync-mutex.ts` remains the sole owner of `.rbox/state/locking-health.json` and
changes its degraded row to carry `LockUnsupportedReason` while preserving the
same selected-JSON fallback. It adds one durable, human-readable genesis row:

```ts
type GenesisBlockedLockingHealth = {
  readonly status: "genesis-blocked";
  readonly reason: "hardlink-unsupported" | "identity-unavailable";
  readonly layer: "workspace" | "state";
};

export function recordGenesisBlockedLockingHealth(
  root: string,
  finding: Omit<GenesisBlockedLockingHealth, "status">,
): Promise<{ readonly durable: true } | { readonly durable: false; readonly error: unknown }>;

export function clearGenesisBlockedLockingHealth(root: string): Promise<void>;
```

Recording is `writeFileAtomic` followed by
`fsyncDirectory(path.join(root, ".rbox", "state"))` and
`fsyncDirectory(path.join(root, ".rbox"))`; only then is `health: "durable"`.
The second barrier covers a state directory first created by the failed lock
attempt, not only the record's rename. Failure returns `health: "unavailable"`, preserves the
original lock refusal/canonical copy, adds the fact `rbox couldn't save this
finding for later diagnostics.`, and still never enters genesis. Telemetry may
still make its best-effort attempt. A diagnostic write failure never converts a
safe refusal into setup success and never replaces it with a misleading disk or
identity conclusion.

Clear first parses the bounded record and is a no-op unless it is exact
`genesis-blocked`. It unlinks that row (`ENOENT` is idempotent) and, when an
unlink occurred, fsyncs `.rbox/state`. Unlink or parent-fsync failure throws a
typed locking-health durability error before the top-level command can report
success; already-selected JSON/Q or newly settled Q is not rolled back, and
retry reselects the same authority and retries the clear. A healthy workspace-
lock acquisition clears an ordinary `degraded-unlocked` row as today but
preserves `genesis-blocked` for this authority-aware clear.

Therefore a state-lock-only refusal survives for doctor/status, a merely absent
workspace has no finding, and moving/retrying on supported storage removes
stale evidence only when authority is actually usable. Report precedence is
file-level authority first: doctor/status render `genesis-blocked` only with
`uninitialized`; exact JSON/Q suppress a crash-stale row before an admitted
clear, while foreign/malformed/corrupt observations suppress it in favor of
their protected artifact finding and leave it untouched. Read-only
doctor/status never probe a lock and never repair the record.

`readLockingHealth` now parses the existing bounded record rather than treating
every occupant as identity degradation. It accepts the old exact
`degraded-unlocked` shape and the new row; on absence it retains the existing
starvation lookup. Malformed, oversized, or unreadable content retains today's
conservative degraded result. No report reader writes or repairs the record.

The locking-health power matrix is mandatory:

| ID | Boundary | Permitted restart image/result |
|---:|---|---|
| H0 | record temp fsynced, before rename | prior/absent health; original admission refusal; no genesis artifact |
| H1 | record rename, before state-directory fsync | prior/new health under power model; original refusal; no genesis artifact |
| H2 | state-directory fsync, before `.rbox` fsync | if `state/` was new, power model permits the whole directory/row absent; original refusal; no genesis artifact |
| H3 | `.rbox` fsync complete | exact durable `genesis-blocked`; doctor/status render it only while uninitialized |
| H4 | Q/JSON selected, before health unlink | selected authority + stale health; readers suppress it; next admitted retry clears |
| H5 | health unlink, before state-directory fsync | present/absent under power model; selected authority unchanged; retry clears idempotently |
| H6 | clear directory fsync complete | selected authority + absent genesis health; command may report success |

### 3.3 Every config-to-genesis front door and the `.rbox` prerequisite

`track-cmd.ts` and `init-cmd.ts` are Adapters. Each performs the same three
ordered calls while already holding the real workspace mutex:

```ts
await saveConfig(root, cfg);
await fsyncDirectory(path.join(root, RBOX_DIR));
const admitted = await admitGenesisAuthority(root, syncMutex);
requireSelectedAuthority(admitted); // central typed copy on refusal
```

The calls are intentionally explicit at every production path that turns a
config into absent-state authority. Adding a `durable?: boolean` to
`saveConfig`, making all 70 test/production config writes pay a parent fsync, or
adding a one-line pass-through “bootstrap service” would increase concepts or
unrelated hot-path cost. `fsyncDirectory` is the existing boring durability
primitive.

For `track`, the sequence is inside the existing scope-transition + workspace-
mutex callback, immediately after `saveConfig` and before `rememberBinding`,
folder-catalog publication, include handling, or return. Existing JSON/Q
re-track returns through admission without genesis. A failed include after
successful genesis retains the command's existing “binding succeeded, restore
scope” semantics; genesis is not rolled back.

For `init`/setup, the sequence is immediately after `saveConfig` and before
binding registry, binding-scope witness, folder catalog, folder admission, key
precheck, or first sync. This covers `push`, `sync`, `pull`, and `none`, including
precreated-workspace continuation. Existing rebind consent/reset still occurs
before the new config. The remote workspace may already exist on a later local
refusal; it is retained and named by the known id.

A refused create/join is a typed local continuation, not permission to create a
second remote workspace. On retry, track and init/setup first recognize their
durable matching config with `uninitialized` authority, reuse its workspace id
and stream, then repeat fsync/admission. An explicitly different id still takes
the existing rebind-consent path. Tests assert that create-new → refusal → retry
performs one remote create total and that an offline `--workspace` retry needs
no remote lookup.

Initial adoption follows that same init sequence and then, only after selected
authority, calls `startAdoption`. This moves inventory/journal publication and
all source namespace mutation after the refusal boundary without changing the
adoption protocol itself. A crash after Q but before the journal is an ordinary
bound Q workspace; retry starts adoption once.

`ensureJournalConfig(journal, mutex)` becomes the adoption-resume owner. Whether
it finds the config or reconstructs it from the journal, it verifies the stream,
fsyncs `.rbox`, and invokes ordinary admission before folder authority,
registry/catalog repair, or `continueAdoption`. Reconstructed config follows
the exact save → fsync → admission order. Existing config is fsynced as a
recovery barrier because a pre-SP-3 process may have crashed after rename with
an adoption journal already durable. No adoption-only genesis variant exists.

`defaultPullWorkspace` in `export-cmd.ts` removes design 93's no-mutex state
exemption. Inside its already unique same-filesystem staging root it saves the
synthetic config, fsyncs `.rbox`, acquires an ordinary workspace mutex, admits
genesis, sets `deps.syncMutex` to that exact handle, and performs `pull` before
release. The staging tree and Q are removed after contents are lifted or on
ordinary exception/refusal unwinding; no `.rbox` enters the export artifact.
SIGKILL cannot run `finally` and follows C9b rather than inventing a stale-stage
reaper. A lock-unsupported export destination refuses and publishes no final
directory/tar/marker.

### 3.4 Consent-free empty reset no longer births JSON

Design 265 deliberately preserved E0's JSON publication pending this default
decision. SP-3 changes only that no-state row:

| Reset entry observation | SP-3 result |
|---|---|
| state absent, config absent, witness absent (E0) | perform the existing eligible post-reset cleanup, return the existing `void`, and leave authority absent |
| existing JSON | unchanged LegacyV2 reset |
| exact `Q` | unchanged SQLiteV2 reset |
| config-only, foreign, corrupt, standing, or witness-required rows | unchanged refusal/recovery law |

The implementation change is exactly removal of E0's
`installGenesisResetStateUnderHeldLock` call. `resetSyncState` remains
`Promise<void>`; E0 has no state-derived repository descriptors and gains no
invented return value. The binding caller then saves and fsyncs the new config
and invokes ordinary genesis. Genesis remains the sole SQLite birth protocol
and the config remains its evidence. Reset must not gain a second genesis
variant that accepts a raw `nextStream` without durable config.

`installGenesisResetStateUnderHeldLock` loses its sole production reach but is
not deleted in SP-3: the exported symbol, tests, facade, and structural guards stay as a
named SP-4 deletion candidate until the closure-complete retirement proof.
Feature retirement here is not used as evidence for broad legacy deletion.

### 3.5 Remove the automatic upgrade migration, keep manual migration

The same implementation PR removes the automatic caller completely:

- delete `src/cli/upgrade-state-window.ts` and
  `src/cli/upgrade-state-window.test.ts`;
- delete `cycleOneDaemon`'s dynamic import, conversion loop, conversion catch,
  and conversion-specific output; preserve stop → desired-state check → restart;
- collapse `EntryPoint` from the two-member union to the literal
  `"foreground-migrate"`; update migration admission and its exact caller gate;
- change the `establishStateAuthority` production caller inventory from two to
  exactly one (`state-plane-cmd.ts`);
- remove the CODEMAP line for the deleted Adapter and update `upgrade-cmd.ts`,
  `locks.ts`, `state-plane-report.ts`, and every living source comment that
  names the upgrade stop window as a migration entry; and
- amend historical living docs/STATUS statements that claim upgrade is a live
  migration entry, including the current summary in `docs/STATUS.md`.
  Historical numbered designs remain historical and receive no semantic rewrite.

`rbox migrate`, `rbox doctor --retry-state-migration`, and
`--abort-state-migration` remain. The explicit migrate coordinator still needs
its genesis-vs-migration fork to recover a pre-existing genesis intent and to
give a typed answer on an absent/corrupt operator invocation. Therefore
`authority-bootstrap.ts` does **not** collapse to genesis-only in SP-3. What
collapses now is the entry-point union and the second automatic caller; the
genesis/migration dispatch fork disappears only when SP-4 retires migration.

## 4. Exact behavior matrices

### 4.1 Authority/default matrix

| ID | Initial file-level state | Entry | Required result |
|---:|---|---|---|
| A0 | absent, no config | raw/doctor observation | `uninitialized` / `undefined`; zero authority mutation |
| A1 | absent, durable config | raw observation | `uninitialized` / `undefined`; zero authority mutation |
| A2 | absent, durable config, healthy held mutex | `track`, `init`, foreground, or daemon admission | exact matching `Q` + DB; no JSON; intent retired |
| A3 | absent, no held mutex | whole-state load/mutation | typed admission-required refusal; no JSON publication |
| A4 | absent | direct save / telemetry mint / capable-lineage init | typed admission-required refusal; no lock-unsupported fallback and no JSON |
| A5 | absent via consent-free E0 reset | reset then binding save/admission | reset returns void and publishes no state; binding fsyncs config; ordinary genesis publishes Q |
| A6 | JSON, no intent | every retained command | byte/behavior-identical JSON selection; no auto-migration |
| A7 | JSON + genesis intent | any admitted entry | 263 case 5 cleanup; JSON byte-identical; intent retired; JSON selected |
| A8 | exact Q, no intent | every retained command | current SQLite fast path; no genesis locks or extra open |
| A9 | Q + intent / absent + intent | real foreground, daemon, track/init/adopt/export retry | existing same-id recovery to settled Q |
| A10 | foreign/malformed/corrupt artifacts | any entry | existing typed zero-repair refusal; no inferred genesis |

### 4.2 Lock result matrix

| ID | Workspace lock | State lock | Result before genesis body |
|---:|---|---|---|
| L0 | acquired/owned | acquired/owned | proceed; existing adjacent rechecks remain |
| L1 | degraded: `hardlink-unsupported` | not attempted | `state-genesis/lock-unsupported`, layer `workspace`; durable health or explicit unavailable fact; no intent/DB/Q |
| L2 | acquired/owned | `hardlink-unsupported` | same finding, layer `state`; durable health or explicit unavailable fact; no intent/DB/Q |
| L2a | degraded: `identity-unavailable` | not attempted | `state-genesis/lock-identity-unavailable`, layer `workspace`; never disk copy |
| L2b | acquired/owned | `identity-unavailable` | same identity finding, layer `state`; never disk copy |
| L3 | held through bounded wait | not reached or held | existing busy/contended outcome; no permanent-disk claim |
| L4 | error | any | existing I/O/error outcome; no permanent-disk claim |
| L5 | wrong root/released | any | programmer/continuation refusal; no product reclassification |
| L6 | owner lost before body | any | ownership refusal; zero genesis mutation |
| L7 | owner lost at any publication boundary | acquired | existing resumable crash prefix; no stale publication |
| L8 | JSON + degraded workspace lock | n/a | existing legacy fallback and truthful JSON-only copy |
| L9 | Q + unsupported save/telemetry lock | n/a | 264 typed refusal with zero DB open/mutation; never JSON |

Each row snapshots all of `.rbox`; L1/L2/L2a/L2b permit only the owned
`locking-health.json` row plus a config that the front door already durably
published. The state-plane assertion excludes no other residue. The hardlink
rows each generate exactly one local occurrence and, with authenticated
telemetry enabled, one count-1 safety event.

### 4.3 Config/genesis crash matrix

| ID | Crash/power-cut boundary | Permitted image and restart result |
|---:|---|---|
| C0 | after config temp/file fsync, before rename | old/absent config; no genesis intent; retry follows existing binding rules |
| C1 | after config rename, before `.rbox` fsync | power model permits old/absent or new config; **no intent exists** in either image |
| C2 | after `.rbox` fsync, before genesis intent | durable config + absent authority; retry/real foreground/daemon creates Q |
| C3 | after intent through before Q rename | existing 263 crash grammar; retry keeps the same authority id |
| C4 | after Q rename through intent retirement | existing Q+intent recovery; config is already durable and evidence matches |
| C5 | after settled Q, before registry/catalog/scope work | Q remains authority; command retry completes its existing later work without second genesis |
| C6 | include rollback/restart failure after genesis | existing scope cursor owns retry; Q is not rolled back or replaced |
| C7 | initial adoption after Q, before journal | no source move; retry starts one journal against the same Q |
| C8 | resumed adoption after reconstructed config rename, before `.rbox` fsync/admission | old/new config under power model; no new genesis intent; retry fsyncs and admits before continuing |
| C9a | export throws/refuses after synthetic config through Q/pull | existing `finally` removes staging; no final artifact; retry gets a fresh private Q |
| C9b | export receives SIGKILL after staging publication, before final artifact | an unpublished `.rbox-export-staging-*` sibling may remain; final artifact/marker absent; retry uses a new random stage/Q and never adopts or overwrites the orphan |

Tests use the reset crash-rig power model for C0–C2/C8 and the existing fresh-
process SIGKILL machinery for C3–C7/C9b. C9a uses injected ordinary failures at
each stage. A process-kill test alone is insufficient
for C1 because the rename may survive process death while still being lost on
power failure.

### 4.4 Version compatibility contract

- **Prohibited:** a candidate daemon with a 1.x foreground CLI on the same root;
  alternating versions on one `.rbox`; downgrading a Q root in place; copying a
  Q `.rbox` to a host that will run 1.x; or treating 1.x's too-new refusal as
  permission to delete the marker.
- **Allowed during cutover:** 1.x on one device with local JSON and candidate on
  another device with local Q, both attached to the same remote workspace. The
  state plane is local and this slice changes no workspace sync/API format.
- **Required operator behavior:** stop the old daemon before installing/running
  the candidate on that root. Once Q is published, return to 1.x only by moving
  the whole candidate `.rbox` aside and deliberately rejoining; there is no
  downgrade converter.
- **Compatibility proof:** the released 1.x binary refuses a candidate-created
  Q tree with zero `.rbox` mutation; the candidate reads and syncs an unchanged
  1.x JSON fixture; the same remote workspace converges across distinct roots.

## 5. Differential fresh-install matrix — MUST write

The gold comparison is an external behavior differential, not JSON/SQLite byte
equality. Run each row once with the frozen pre-flip build/legacy fixture and
once with the candidate/SQLite default. Compare terminal output, exit status,
remote request sequence and bodies, resulting remote head/manifest, files, Git
refs, config, logical state projection, and restart convergence. The physical
state files, config parent-fsync event, authority id, lineage id, and approved
lock refusal are format-specific.

| ID | Front door / first action | Candidate assertion |
|---:|---|---|
| F0 | `track --workspace`, no first sync | Q exists before success output/return; remote untouched |
| F1 | interactive/bare track create-new | same as F0 after remote creation; selected id preserved |
| F2 | `init` new, first push | Q precedes scan/upload; logical seq/head equals legacy oracle |
| F3 | `init --workspace`, sync | Q precedes pull; two roots converge with same remote result |
| F4 | `init --workspace --pull-only` | Q precedes pull; zero publication remains true |
| F5 | `init --no-sync` new and join | Q exists before return despite no sync |
| F6 | guided setup and keyed/precreated continuation | both route through the same init admission; no alternate JSON birth |
| F7 | fresh track → first sync → pair second device → converge | SP-2.5 fresh-install e2e on exact candidate |
| F8 | existing JSON workspace on candidate | full tree/result/wire differential with pre-flip build; stays JSON |
| F9 | exact Q workspace | full logical/wire differential with SP-2.5 Q fixture |
| F10 | hardlink-unsupported track/init `--no-sync` | exact canonical refusal + durable layer/cause; no intent/DB/Q; one best-effort telemetry sample and no non-telemetry network after refusal is known |
| F11 | crash at C0–C9b, resume via other entry kind | one durable binding/authority for workspace flows; export has no final artifact and may retain only the unpublished C9b sibling |
| F12 | initial adoption + adoption resume with absent/config-repair states | Q precedes journal/source mutation; crash/retry preserves all adoption retention and convergence behavior |
| F13 | export one/many workspaces to directory and tar | private Q + held mutex during pull; exported content/marker/bytes equal oracle; no `.rbox` in artifact |
| F14 | export/adoption hardlink-unsupported | no final export or new adoption mutation; exact finding/health/event occurrence; ordinary cleanup/parked journal remains truthful |

The matrix also runs with files-first on/off, Git on/off, scoped pull-only,
empty/non-empty local trees, interrupted adoption, and directory/tar export
where those dimensions change existing semantics. It does not multiply
irrelevant prompt cosmetics into authority modes.

## 6. Test and suite disposition ledger

Counts are re-pinned after SP-2b merges. No existing case may disappear merely
because its old fixture accidentally depended on absent→JSON; JSON suites must
seed explicit JSON, while default/fresh suites must use genesis Q.

| Suite/group | Disposition |
|---|---|
| `engine/lockfile.test.ts`, `sync-mutex.test.ts`, `state-plane/locks.test.ts` | **amend** closed hardlink-vs-identity unsupported cause, unchanged JSON degradation, typed genesis layer result, H0–H6 durable health lifecycle/failures, and non-conflation with held/error/owner loss |
| `state-plane/authority-bootstrap.test.ts` | **amend** for `uninitialized`, total admission result, both layers/both unsupported causes, health durable/unavailable result, clear failure/retry, fresh reselection, and retained explicit migration fork |
| `state-plane/adapters/whole-state-compat.test.ts` | **amend** A0–A10 and the complete L matrix; absent direct read is inert and every mutation refuses rather than writing JSON; preserve JSON/Q lazy-import, open-count, telemetry, reset replacement, and CAS rows |
| `state-plane/genesis-admission-crash-gate.test.ts` / `genesis-crash-matrix.test.ts` | **amend** real track/init/adopt entries plus C0–C8; retain all 263 foreground/daemon cross-resume and post-Q cleanup cells |
| `track-cmd.test.ts` / `track-untrack.test.ts` | **amend** F0/F1/F10, config-fsync-before-intent ordering, same-stream JSON/Q re-track, output/registry/catalog/include rollback, and no first network sync |
| `init-cmd.test.ts`, `setup-cmd.test.ts`, keyed rebind | **amend** F2–F6/F10, all four first-sync directions, continuation ownership, refusal order, and Q before folder admission/network sync |
| `adopt-lifecycle.test.ts`, `adopt-binding-matrix.test.ts`, `adopt-git.test.ts`, `adopt-overlay.test.ts` + journal crash suites | **amend** initial Q before `startAdoption`, existing/reconstructed config fsync + admission on resume, C7/C8/F12/F14, no added source move on refusal, and unchanged abort/retention/Git behavior |
| `export-cmd.test.ts` + export disk-safety/fresh-process suites | **amend** private config/fsync/Q/borrowed-mutex pull, C9a/C9b/F13/F14, ordinary refusal cleanup, SIGKILL orphan allowance, zero final artifact, and byte/content/marker differential |
| `local-runtime` fixture/tests + foreground/daemon admission suites | **amend** one typed occurrence per top-level cycle, existing authenticated transport reuse, bounded flush, and no retry-level duplicates |
| reset consent/journal/namespace + SQLite reset suites | **amend only E0** to no-state/no-JSON followed by binding genesis; preserve every JSON/SQLite P/R/I/Z, consent, owner-loss, and crash row from 265 |
| `sync-state-store.test.ts`, `sync-state.test.ts`, telemetry state tests | **amend** absent direct-save/binding/capable-lineage expectations; explicit JSON fixtures retain exact fallback and bytes; Q tests unchanged |
| `compat-matrix.test.ts` | **amend hermetic rows only**: candidate reads explicit 1.x JSON fixtures and current parser rejects future/near-miss markers; it does not claim released-binary proof |
| SP-2.5 dual-binary rig | **required** signed released 1.x status/sync/doctor against candidate Q with byte-identical `.rbox`, plus reverse candidate-on-1.x-JSON and separate-root convergence |
| `upgrade-state-window.test.ts` | **delete with its sole production Adapter**; its behavior is intentionally retired, not redistributed |
| `upgrade-cmd.test.ts`, `upgrade-daemons.test.ts`, `main-dispatch-upgrade.test.ts` | **amend/preserve** stop/restart, stopped desired state, pull-only resume, binary swap, and output; add zero state-plane import/mutation and no conversion-line assertions |
| migration authority/admission/command/retry/abort/crash suites | **amend caller inventory only, otherwise preserve**: exactly one `establishStateAuthority` production caller and one entry literal; all explicit migration behavior remains |
| state-plane report/copy + doctor/status/locking-health suites | **amend** §1.2–1.3 exact human/JSON/machine ids, unavailable-health fact, authority-first precedence, no absent inference, crash-stale suppression, and authority-sensitive degraded wording; all ids remain unique/namespaced |
| `telemetry/contract.test.ts`, `telemetry/queue.test.ts`, daemon telemetry tests | **amend** exact `genesis_lock_unsupported` enum/sample, count coalescing, opt-out, one-shot/daemon bounded flush, 429/network failure, and never-affects-refusal behavior |
| `apps/api/test/telemetry-ingest.test.ts` + client/server contract parity | **amend** accept exact new enum to existing `client.safety_event`; reject near misses/extra fields; preserve rate limit, auth, caps, drops, and positional shape |
| state-plane inventory/duplicate declarations/file size/CODEMAP | **amend** observation union/sites, zero absent legacy writes, deleted upgrade Adapter, one migration entry, and landed sizes; weaken no existing sweep |
| SP-2.5 rig FAST + e2e | **required merge gate**: every FAST Q dimension, F7 fresh install, F8 JSON upgrade path, and lock-refusal machine-id row green on the exact candidate |

Also run the complete SP-1, SP-2a, and merged SP-2b suite ledgers; pull/push,
LocalRuntime, daemon direct/contended scheduler, sync-git state CAS, doctor,
status, `e2ee-sync`, `git-config-sync.e2e`, `bun run typecheck`, and
`bun run lint:affected`. Then run `bun run rig` FAST with the SP-2.5 dimension.

## 7. Ordered acceptance and rollout gates

1. Rebase on merged SP-2b and freeze explicit-JSON, exact-Q, track/init/adoption/
   export output and trees, upgrade stop/restart, and pre-flip fresh-install
   goldens.
2. Introduce `uninitialized` observation and make every lower mutation path
   refuse it. Structural and unit gates must prove zero new absent→JSON writes
   before front doors are flipped.
3. Split hardlink-unsupported from identity-unavailable at the lock primitive,
   retain JSON degradation for both, and make health lifecycle/L rows green.
4. Change E0 to no publication. Add post-config `.rbox` fsync + complete genesis
   admission to track, init, adoption recovery, and export staging; move initial
   adoption mutation after admission. Make A/C/F matrices green.
5. Add canonical copy, durable-health doctor/status handling, and required
   occurrence telemetry; remove the false generic legacy-fallback sentence.
6. Delete the automatic upgrade Adapter/caller and collapse the entry inventory.
   Keep explicit migration green for the cutover.
7. Run every §6 suite and size/structural/performance gate. Build the candidate.
8. **Do not merge** until SP-2.5's exact-candidate Q FAST dimension, fresh-install
   e2e, and JSON upgrade-path e2e are green.
9. Install the candidate on the founder fleet under §10, verify all founder
   roots Q/healthy, and preserve backups. SP-4 starts only after that evidence.

No kill switch is added. A flag would create two absent-state defaults and let
the fleet drift into the same mixed authority state this slice removes.

## 8. Size, performance, and structural accounting

Current provisional production measurements are nonblank lines / bytes; re-pin
after SP-2b merge.

| Module | Provisional baseline | Acceptance |
|---|---:|---|
| `authority-bootstrap.ts` | 185 / 9,032 | owns observation + admission result; hard 240 / 13 KiB; no Adapter policy |
| `whole-state-compat.ts` | 399 / 19,118 | must not exceed 400 / 25,600; simplify absent dispatch to offset refusal handling; no split/pass-through module |
| `locks.ts` | 357 / 16,538 | carry the closed unsupported cause from both lock layers without exported mode; hard 400 / 25,600 |
| `genesis.ts` | 362 / 18,745 | protocol unchanged except closed refusal typing if required; no growth above 375 / 21 KiB |
| `track-cmd.ts` | 243 / 13,207 | one fsync + one complete admission + Adapter occurrence report; hard 300 / 18 KiB |
| `init-cmd.ts` | 716 / 38,046 | existing debt file; admission sequence/adoption reorder/occurrence report only, no new orchestration object; below current + 24 nonblank / + 2 KiB and existing ratchet |
| `reset-state.ts` / legacy JSON publication owner | re-pin after 265 | E0 production reach shrinks; no new genesis implementation |
| `state-plane-copy.ts` / `state-plane-report.ts` | 334 / 16,645; 361 / 16,922 | two exhaustive rows + one typed rendering path; each remains below 400 / 25,600 |
| `engine/lockfile.ts` | 1,393 / 66,975 | one closed unsupported-cause discriminator at the primitive; below current + 16 nonblank / + 1 KiB; no state-plane policy |
| `sync-mutex.ts` | 326 / 16,022 | closed degraded cause + sole locking-health lifecycle + truthful warning; hard 375 / 22 KiB; no authority selection/import |
| `local-runtime.ts` | 145 / 6,327 | reuse authenticated transport for one typed-refusal flush; hard 165 / 8 KiB; no state-plane policy |
| `export-cmd.ts` | 367 / 14,951 | replace no-mutex exemption with ordinary config/fsync/admission/borrowed pull; hard 390 / 17 KiB |
| `adopt-cmd.ts` | 249 / 13,060 | config durability/admission repair only; hard 275 / 15 KiB; no second genesis path |
| `telemetry/contract.ts` / `telemetry/queue.ts` | 209 / 9,072; 255 / 12,033 | append one enum and reuse queue/flush; contract below + 4 lines, queue below + 12 lines; no new queue type |
| `e2ee-client.ts` | 772 / 53,337 | expose the already-created API only as `telemetryTransport`; below current + 3 nonblank / + 192 bytes; no second client or `SyncDeps` port |
| `daemon/daemon.ts` | 2,895 / 143,813 | existing debt file; one record + bounded flush at typed refusal catch; below current + 8 nonblank / + 768 bytes |
| `doctor-state-plane.ts` / `doctor-cmd.ts` / `status-projection.ts` | 183 / 9,220; 961 / 45,037; 431 / 19,208 | read/render existing locking-health only; each below current + 16 nonblank / + 1 KiB; no probe/write |
| `apps/api/src/telemetry-ingest.ts` | 429 / 20,603 | append mirrored enum only; below current + 4 lines / + 256 bytes; no route/index/schema |
| `upgrade-state-window.ts` | 121 / 6,600 | deleted with sole feature |
| `upgrade-cmd.ts` | 499 / 23,827 | must shrink by the removed state-conversion block; no replacement helper |

Required structural gates:

- zero `"absent"` members under `legacy-json-store` and zero production legacy
  publication reachable from an `uninitialized` observation;
- exactly four production config-to-genesis owners: `track-cmd.ts`,
  `init-cmd.ts`, `adopt-cmd.ts`, and `export-cmd.ts`; every path has
  `save/existing config -> fsyncDirectory(.rbox) -> admitGenesisAuthority`
  before state mutation and borrows a real held workspace mutex;
- zero `loadState` call added merely to trigger genesis; front doors call the
  complete admission operation directly and do not recover JSON reset by
  accident;
- zero production E0 call to `installGenesisResetStateUnderHeldLock`;
- zero production import/reference to `upgrade-state-window`, exactly one
  `establishStateAuthority` caller, and no `upgrade-stop-window` literal;
- zero new flag, environment switch, backend enum, fallback, queue, sidecar,
  telemetry route, Analytics Engine index, or bootstrap queue type; the only
  durable addition is a closed row in the already-owned locking-health record;
- exactly one client/server `genesis_lock_unsupported` enum member, zero event
  on identity/I/O/contention rows, and one Adapter-level record site per
  top-level track/init/adopt/export/foreground/daemon occurrence;
- every `genesis-blocked` record rename is followed by `.rbox/state` then
  `.rbox` fsync, and every successful unlink by `.rbox/state` fsync; zero
  command-success path remains after a failed durable clear, and doctor/status
  never mutate or lock while rendering it;
- zero export stale-stage scan/reaper/adoption; C9b's random unpublished sibling
  is preserved as existing crash residue, never mistaken for a final artifact;
- JSON static/evaluated closure remains free of `bun:sqlite`; raw absent
  observation also evaluates no SQLite/genesis/lock chunk;
- touched modules end at zero new `any`, unknown aliases/parameters, unsafe
  dictionaries, widened/assert casts, or suppressions; and
- CODEMAP reflects every changed owner and the deleted upgrade Adapter.

Performance gates record before/after p50/p95 and operation counts for: settled
JSON load, settled Q load, raw absent observation, fresh track admission, init
before first-sync scan, adoption before first source move/resume, one export
pull, refused one-shot telemetry, and `rbox upgrade` per daemon. Settled JSON/Q
must retain 263's no-admission-lock fast path. Raw absent observation is one
bounded file-format read and no dynamic SQLite/genesis/lock evaluation. Each
config-to-genesis path pays one required directory fsync and one genesis; no
duplicate namespace walk, whole-state materialization, or second store open is
accepted. Telemetry disabled pays no network; enabled refusal performs at most
one retry-zero POST bounded by 1.5 s. Upgrade should be faster and perform zero
state-plane reads after caller deletion.

## 9. Simplification and requirement challenges

### 9.1 Concept-count delta

| Before SP-3 | After SP-3 |
|---|---|
| absence impersonates the legacy backend | one explicit non-authoritative `uninitialized` observation |
| normal held-mutex admission plus track/export/adoption absent-state gaps | one complete admission used by every config-to-authority owner |
| JSON E0 is a second state-birth protocol | E0 publishes nothing; genesis is the sole birth protocol |
| two migration entry-point kinds and two `establishStateAuthority` callers | one explicit foreground migration entry/caller |
| upgrade owns stop/restart plus hidden state conversion policy | upgrade owns daemon lifecycle only |
| generic degraded copy promises legacy saving for every authority | authority-neutral lock warning plus one selected authority finding |
| one `unsupported` bucket mixes disk and host identity | one primitive result with a closed cause; only proven hardlink failure crosses the filesystem product boundary |
| telemetry requirement has no one-shot occurrence owner | existing safety-event schema/queue reused at top-level Adapters; no state-plane network port |

The authority-bootstrap **dispatch fork does not collapse yet**. Manual
migration and recovery remain supported through the fleet cutover; deleting
that active readiness path before SP-4 would violate the parent order. SP-3
does collapse the authority-bootstrap caller set, the entry-point union, and
the Adapter's absent/legacy conflation.

### 9.2 Challenged requirements

| Requirement | Complexity cost | Evidence | Ruling |
|---|---|---|---|
| fall back to JSON when fresh locking is unsupported | preserves two state births and strands new users on the format SP-4 will refuse | 264 proves Q cannot safely write unlocked; founder boundary in §1 | reject; refuse before genesis artifacts |
| identify supported filesystems by name | platform tables, false positives, permanent maintenance | existing lock primitive already probes real capability | reject; capability, not filesystem branding |
| treat every lock `unsupported` as a disk verdict | moving a folder cannot repair host identity and yields false product copy | primitive currently merges hardlink and identity failures | reject; add a closed cause and separate finding |
| probe before remote workspace creation and trust it later | TOCTOU plus a second lock acquisition; still cannot authorize genesis | real admission must check held locks | reject as authority; remote workspace may survive a later local refusal |
| make every `saveConfig` call parent-durable | adds fsync latency to unrelated scope/config hot paths and 70 test/production sites | only genesis evidence requires this order | reject; four explicit config-to-genesis owners fsync |
| pass `durable`, `defaultSqlite`, or backend flags | cross-cutting modes and two product defaults | one founder decision applies to all fresh bindings | reject; closed observation + complete operation |
| omit remote telemetry because authority/binding is unfinished | violates design 264 and hides the population that proves the filesystem boundary | existing authenticated `RboxApi`, safety-event schema, queue, endpoint, and opt-out already solve transport | reject; reuse them for count-1 Adapter occurrences, best-effort and non-durable |
| store a durable telemetry counter before SQLite exists | new queue state, atomic increments, replay/dedup, deletion policy | best-effort telemetry plus durable diagnostic health meets the contract without pretending at-least-once delivery | reject; health is evidence, never an upload queue |
| automatically migrate during upgrade “for convenience” | host desired-state differences silently choose authority; mixed fleet from CODEX-262-A#4 | current stopped daemons skip the hook | remove in the same PR |
| delete all migration code now that auto-upgrade is gone | removes the manual founder cutover/recovery path before use and skips closure proof | SP-4 charter | reject; only sole-purpose upgrade Adapter is proven deletable |

## 10. Operations appendix — founder-fleet cutover

This appendix is operational, not a product command contract. Preserve every
backup until SP-4 is merged, released, and separately verified.

### 10.1 Preconditions

1. SP-2b is merged and its corrective gates are green.
2. SP-2.5 is green on the exact SP-3 candidate.
3. The mirrored API telemetry enum is verified in dev and promoted to
   production before the candidate fleet, so refusal samples are accepted
   rather than counted as `bad_enum` drops. Follow `docs/DEPLOYMENTS.md`.
4. The candidate contains the upgrade-window deletion. Confirm the structural
   gate reports no `upgrade-state-window` import before using `rbox upgrade`.
5. Record each root, workspace id, desired daemon mode, current head/sequence,
   deferred Git repositories, and `rbox doctor --json` result.
6. Stop the daemon on the host being cut over. Do not run any 1.x CLI against
   that root after the candidate first runs.

### 10.2 Desktop and Mac — prefer in-place manual migration

For each healthy JSON root, one host at a time:

```text
rbox stop
rbox migrate
rbox doctor --json
rbox sync
rbox start            # add the host's intended mode, e.g. --pull-only
```

Acceptance per host:

- `.rbox/state.json` is the exact 58-byte authority marker;
- `.rbox/state/state.db` exists, names the same authority id, passes schema and
  completion checks, and is at rest with no `-wal`/`-shm`;
- genesis intent and live migration control are absent after success;
- `rbox doctor --json` has no state/genesis/migration/locking blocker;
- one ordinary sync converges to the recorded remote head or advances it by an
  explained local change; and
- daemon desired mode survives restart.

If manual migration refuses before Q, keep the JSON root stopped or resume it
only with the candidate; inspect the canonical report. Do not improvise marker
or database deletion. If the JSON baseline is not worth preserving, use the
re-genesis recipe below instead.

### 10.3 Re-genesis alternative

Use only after sync is settled and the workspace id is recorded:

1. `rbox stop` and confirm no process is using the root.
2. Move the whole `.rbox` directory to a timestamped sibling backup; do not copy
   individual state files and do not delete the backup.
3. Run `rbox track <root> --workspace <id>` with the candidate.
4. Before any sync, verify exact Q + matching DB + no genesis intent. This is the
   field proof that track's no-first-sync gap is closed.
5. Start the daemon rather than looping one-shot syncs; allow its bounded retry
   to converge. Resolve each resulting Git deferral deliberately. `keep-mine`
   publishes this computer's checkout; `take-theirs` follows the other
   computer. The 103-repository desktop incident proves this choice is not
   cosmetic.

### 10.4 Flat Meadow rejoins here

FM remains parked until desktop and Mac are healthy Q publishers.

1. Record FM's workspace id, run `rbox stop`, and confirm no FM process is using
   the root.
2. Move FM's entire live `.rbox` to a timestamped sibling backup. Do not leave
   `state.json` in the live root: track correctly preserves existing JSON and
   therefore cannot re-genesis while it remains.
3. With the candidate, run `rbox track <FM-root> --workspace <id>` and verify Q
   **before** starting sync.
4. Rejoin initially in pull-only mode so the two verified hosts remain remote
   authority while FM catches up. Confirm files, remote sequence, Git deferral
   list, daemon health, and no echo publication.
5. Restore FM's founder-decided long-term mode only after convergence evidence.

### 10.5 Fleet completion gate for SP-4

SP-4 may begin only when desktop, Mac, and FM each have:

- candidate version recorded;
- exact Q + matching at-rest DB;
- no genesis intent or migration control;
- healthy locking;
- successful ordinary sync and healthy daemon in intended mode; and
- retained, named pre-cutover backup.

External 1.x devices are not migrated by this appendix. They keep JSON on their
own roots until the separate 2.0 product rollout; their presence on the same
remote workspace is allowed by §4.4.

## 11. Non-goals and deletion ruling

- No refusal, rename, migration, quarantine, or deletion of an existing JSON
  workspace. That is SP-4.
- No deletion of the migration tree, `legacy-json-store`, manual migrate,
  retry/abort, doctor migration evidence, backups, guards, or external tests.
- No automatic migration anywhere else to replace the upgrade hook.
- No 1.x in-place downgrade or JSON export from Q.
- No export orphan discovery/reaping protocol; C9b preserves the existing
  unpublished random staging residue after uncatchable process death.
- No new telemetry kind/endpoint/index, state-store/reset schema, D1 migration,
  remote workspace cleanup, filesystem allowlist, flag, mode, kill switch,
  sidecar, queue, or durable telemetry record. The only wire change is the exact
  safety-event enum append; the only diagnostic-record change is the closed
  locking-health row in §3.2.
- No redesign of genesis's seven steps, ids/evidence, marker format, store
  schema, reset P/R/I/Z grammar, CAS transaction, Git conflict policy, or daemon
  scheduler.
- No SP-2.5 implementation in this slice. Its already-building authority
  dimension is consumed as a merge gate.
- No release or fleet mutation in the implementation PR itself. The appendix is
  performed explicitly after the candidate is built and validated.

SP-3 succeeds when “no state yet” has one honest meaning—authority has not been
created—and one safe transition—held-lock SQLite genesis. It fails if absence
can still reach a JSON writer, unsupported locking silently selects legacy,
track returns before Q, adoption/export can reach an absent-state writer,
config can be lost after its evidence is journaled, upgrade still chooses
authority, or a 1.x binary is permitted to share a local Q root.
