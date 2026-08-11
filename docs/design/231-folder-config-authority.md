# Design 231: User-owned folder configuration authority

**Status:** ALIGNED round 3; implementation authority
**Snapshot:** `origin/main` at `4950f62a153bc0c7f1ce5d7165a6483b4133c534`
**Product direction:** one readable `~/.rbox/config.json` lists the folders this
machine intends to sync, with global option defaults and per-folder overrides.

## 1. Problem

Design 230 made the ordinary CLI folder-first, but deliberately left the old
durable model in place. A user still cannot inspect one file and answer:

- which folders this machine intends rbox to manage;
- what defaults apply to all of them;
- which folder differs from those defaults; or
- whether a folder is configured but not yet bound to remote state.

The existing files answer different internal questions:

- `<root>/.rbox/workspace.json` owns a binding's remote stream/device identity,
  scope seal, and scope crash journal;
- `~/.rbox/workspaces.json` is a reconstructible binding registry and redundant
  scope witness;
- `~/.rbox/daemons/<key>/desired.json` owns running/stopped mode and maintenance
  obligations.

Turning any one of those into a user settings file would either expose remote
identity as product configuration or collapse independently crash-sensitive
facts into one record. Adding a fourth mirror without assigning exclusive facts
would be worse.

## 2. Outcome and schema

`~/.rbox/config.json` becomes the sole user authority for:

1. the ordered list of locally named synced-folder intents;
2. the path of each intent on this machine;
3. global user-option defaults; and
4. explicit per-folder option overrides.

```json
{
  "schemaVersion": 1,
  "globalOptions": {
    "syncGit": true,
    "git": {
      "incremental": true
    },
    "respectGitignore": false,
    "noDrift": false,
    "trash": {
      "days": 30,
      "maxBytes": 2147483648
    }
  },
  "folders": [
    {
      "name": "Development",
      "path": "~/Development",
      "options": {
        "respectGitignore": true,
        "trash": {
          "days": 14
        }
      }
    }
  ]
}
```

`folders` is an array. `name` is a local, user-editable label and is never an
identity key for remote data. `path` locates the folder. The hidden binding at
that path continues to carry `remoteWorkspaceId`.

The local name is distinct from `workspace.json.name`, which is the cached,
immutable, server-visible display name. Existing JSON output keeps its current
`workspaces[].name` meaning. The separate versioned `rbox config --json` surface
reports the local folder label; this design does not silently change the old
field.

## 3. Ownership map

### 3.1 New `FolderCatalog` Module

`src/cli/folder-config.ts` owns:

- strict schema parsing and validation;
- `~` / `~/…` expansion and friendly path collapse;
- normalized-path duplicate detection and physical-overlap diagnostics;
- local-name uniqueness;
- fieldwise global/per-folder option resolution;
- the config generation digest pinned by one operation;
- locked compare-before-write mutation, atomic rename, and directory fsync;
- catalog state inspection (`legacy`, `candidate`, `authoritative`, `damaged`)
  and durable publication of a caller-supplied, already-observed candidate;
- explicit add/update/remove operations.

It must never own:

- remote workspace creation, selection, or deletion;
- workspace/device/stream identity;
- credentials, encryption keys, or server URLs;
- daemon process transitions or desired modes;
- scope edits, pruning, adoption, or sync orchestration.

Its complete Interface is:

```ts
inspectFolderCatalog(): Promise<FolderCatalogState>
publishInitialFolderCatalog(candidate: FolderCatalogCandidate): Promise<FolderCatalogSnapshot>
readFolderCatalog(): Promise<FolderCatalogSnapshot>
recordFolder(root: string, seed: FolderSeed): Promise<FolderCatalogSnapshot>
forgetFolder(root: string): Promise<FolderCatalogSnapshot>
setFolderOptions(root: string, patch: FolderOptionsPatch): Promise<ResolvedFolderPolicy>
```

Callers receive validated entries and effective policy, never raw parse phases.

### 3.2 New `FolderInventory` Module

`src/cli/folder-inventory.ts` is the read-only composition root joining a
catalog snapshot, per-root binding observations, the compatibility registry,
and daemon desired rows. It alone classifies configured, unbound, missing,
detached, and projection-pending roots. Setup, status, doctor, boot
resume, and daemon Adapters consume its result instead of rebuilding joins.

The registry remains best-effort evidence. A configured path with a readable
binding is admitted even when its registry row is absent or conflicting.
Inventory never heals or mutates: the existing convergence Adapter may consume
its observation and repair the cache best-effort after admission. A conflicting
registry identity is diagnostic, not binding authority. The existing design-212 rule remains narrower and stronger:
a present scope witness escalates uncertainty and may fail closed to protect the
publication seal.

The Interface separates bounded one-root admission from machine inventory:

```ts
observeFolderAdmission(root: string, state?: FolderCatalogState): Promise<FolderAdmission>
listFolderInventory(state?: FolderCatalogState): Promise<FolderInventorySnapshot>
```

The optional input is the inspected catalog state, never a bare snapshot, so
reusing an observation cannot fabricate catalog authority.

`src/cli/folder-config-migration.ts` composes strict legacy observations into a pure
candidate and invokes `publishInitialFolderCatalog`. This prevents
`FolderCatalog` from importing binding-registry or autostart code and avoids an
authority cycle. Migration readers do not use tolerant cache APIs that collapse
corruption to empty; corrupt registry or desired rows refuse exact migration.

### 3.3 Existing records retain narrower facts

| Record | Exclusive authority after cutover |
|---|---|
| `~/.rbox/config.json` | user folder intent, local label, global options, per-folder overrides |
| `<root>/.rbox/workspace.json` | remote/device/stream binding identity, scope seal/journal, compatibility option projection |
| `~/.rbox/workspaces.json` | observed-binding compatibility registry and redundant scope witness |
| `~/.rbox/daemons/<key>/desired.json` | requested running/stopped state, pull-only mode, pending mode, maintenance |

`workspaces.json` remains internal. Its union with desired rows remains the
legacy discovery net, but after cutover it cannot add entries back to
`config.json` except through an explicit repair/migration operation. Failure to
write that registry can never make a valid configured binding unusable.

### 3.4 Binding-record mutation

`workspace-config.ts` gains one fieldwise, identity-checked mutation Interface
for compatibility policy projection. It acquires the established
scope-transition lock and then workspace mutex, re-reads the record after both
locks, verifies the expected stream/device identity and catalog generation,
patches only safe option projection fields plus an identity-bound projection
stamp, writes atomically, and fsyncs the containing directory. The stamp is
`{ schemaVersion: 1, catalogGeneration, streamId, deviceId }`. Rebind omits any
old stamp. It never carries the global catalog lock into this sequence and
refuses to publish unless the workspace mutex is exclusively owned rather than
degraded/unavailable.

Scope transitions, rebind, and projection therefore cannot overwrite one
another from stale whole-record snapshots. Existing scope writers retain their
journal protocol; the new Interface does not make scope a catalog concern.

## 4. Linking folders to remote identity

The config never stores a workspace ID.

```text
folders[] entry
    -> normalized local path
    -> <path>/.rbox/workspace.json
    -> remoteWorkspaceId + deviceId + stream coordinates
```

An inventory row is:

- **bound** when catalog membership and a readable binding are present;
- **unbound** when the path exists without a binding;
- **missing** when the configured path does not exist;
- **detached** when a legacy observed binding is not listed after cutover.

Names never establish or repair a binding. Registry `rebound` remains a
diagnostic about a best-effort observation; it is not catalog admission and
cannot stop a readable configured binding. Existing stream/reset/desired-state
checks continue to fence the identities they own. An unbound entry never creates
or joins remote state passively; guided setup performs that explicit transition.

## 5. Option model

The supported user options are exactly:

```ts
interface FolderOptions {
  syncGit?: boolean;
  git?: { incremental?: boolean };
  respectGitignore?: boolean;
  noDrift?: boolean;
  trash?: { days?: number; maxBytes?: number };
}
```

Nested objects merge field-by-field. `false` and `0` are values; only an absent
field inherits. Normative new-folder defaults are `syncGit: true`,
`git.incremental: true`, `respectGitignore: false`, `noDrift: false`,
`trash.days: 30`, and `trash.maxBytes: 2147483648` (2 GiB). `null`, unknown
keys, invalid types, and non-finite/non-integer numbers are errors. Catalog
trash values must already be integers within 0–365 days and 0–1099511627776
bytes (1 TiB); unlike legacy `workspace.json` normalization, user authority is
rejected rather than silently truncated or clamped. Migration snapshots the
legacy normalized result.

For a new folder:

```text
product default <- globalOptions <- folders[i].options
```

For a migrated folder, its exact legacy effective values are written as
explicit `folders[i].options`. This is intentionally verbose: old persisted
values do not reveal whether the user chose them or accepted a historical
default. Guessing inheritance could turn Git sync on or change ignore/trash
behavior. Users may delete individual per-folder fields to opt into inheritance.

Existing bind flags retain their supported meaning:

- an explicit `--git true|false` becomes an explicit folder override;
- an explicit respect-gitignore choice becomes an explicit folder override;
- low-level `init`/`track` default behavior remains its historical concrete
  value when no catalog exists;
- guided setup on an authoritative catalog inherits global values unless the
  user explicitly chooses otherwise;
- same-workspace re-track preserves today's flag-derived result by updating the
  corresponding override; and
- a different-workspace rebind preserves local folder options unless an
  explicit bind flag replaces them. Identity/scope never carry from the old
  stream.

The init plan records option provenance (inherited versus explicit/compatibility
default) so the catalog writer does not infer it from a final boolean.

The environment override `RBOX_NO_DRIFT=1` retains its existing final
precedence. `encrypted` is a safety invariant, not a preference.

The following are rejected from generic options:

- `scope`, `scopeGeneration`, and `scopeIntent` — the design-212 publication
  seal and journaled filesystem transaction;
- `pullOnly` — daemon desired-mode authority;
- identity, server, credential, and E2EE fields.

Schema v1 is closed at every object level. Required fields are
`schemaVersion`, `globalOptions`, `folders`, and each entry's `name`/`path`;
`options` is optional. Limits are 1 MiB total bytes, 1,024 folders, 128 Unicode
scalar values per local name, and 4,096 UTF-8 bytes per path. Names must be
valid Unicode scalar sequences, already NFC-normalized, non-empty, free of
leading/trailing whitespace, and unique by exact NFC spelling. Case-distinct
names remain distinct and name-addressed commands require exact spelling.
Unsupported `~user`, NUL, lone UTF-16 surrogates,
non-absolute post-expansion paths, unknown keys, `null`, and a schema version
newer than 1 fail with actionable errors. Existing missing paths use lexical
normalization. Normalized-identical absolute paths are rejected. Physical aliases
and ancestor/descendant roots are accepted by the codec and reported by
inventory when observable; guided add may refuse introducing a new overlap.
Neither observation rewrites stored spelling.

## 6. Authority cutover and migration

### 6.1 Durable states

An internal `~/.rbox/config-authority.json` marker distinguishes legacy absence
from damaged authority. Its closed schema is
`{"schemaVersion":1,"activatedAt":"<ISO>"}`;
an unparseable/unknown marker is damaged authority, not legacy absence.

| Config | Marker | Meaning |
|---|---|---|
| absent | absent | legacy mode; current behavior byte-for-byte |
| present | absent | cutover config published; validate it, finish marker |
| present | present | folder catalog authoritative |
| absent/corrupt | present | damaged authority; fail closed with repair copy |

Publication order is config atomic rename + file/directory durability, then
marker atomic rename + directory durability. A marker is never published before
the config whose authority it activates. The marker records activation only; it
does not hash mutable user text. Every later read validates current config bytes
directly, so legitimate hand edits need no marker mutation and malformed edits
fail closed without changing activation provenance. A corrupt candidate with no
marker errors without cutting over; legacy state remains available after the
user repairs/removes that unactivated candidate.

### 6.2 Activation trigger

A fresh machine publishes its first catalog only after the first binding has
been durably written. An upgraded machine stays byte-for-byte in legacy mode
until the user runs `rbox config migrate`; ordinary status/sync/start commands
never create or cut over config implicitly. Creating a hand-authored
`config.json` is itself an explicit activation request; the next command merely
validates those already-present bytes and publishes the marker without importing
omitted legacy roots.

`folder-config-migration.ts` owns strict migration-only evidence readers for the
registry and daemon desired rows; unlike tolerant runtime cache readers, they
refuse corrupt bytes. `rbox config migrate` gathers their complete union plus the
currently resolved binding, then builds one candidate through
`FolderInventory`. This makes the trigger and observation set explicit and
prevents a current pre-registry root from becoming detached during its own
migration.

### 6.3 Legacy seed

Explicit upgrade cutover snapshots the full effective legacy discovery union,
not merely the current root:

1. read persisted registry entries plus daemon desired rows;
2. classify missing/rebound rows before publication;
3. read every available binding;
4. derive local labels from path basenames, adding stable numeric suffixes for
   collisions;
5. collapse home paths to `~/…`;
6. snapshot each binding's current effective safe options as explicit folder
   overrides;
7. refuse exact migration when a missing/rebound row cannot supply its prior
   effective options, naming `restore`, `rbox untrack`, or an explicit
   `--skip-unavailable` choice;
8. validate the complete candidate;
9. durably publish config, then marker.

A pre-registry track-only root remains a protected compatibility case. Operating
inside it continues to work and records the observed binding. After cutover it
is surfaced as `detached`, never silently inserted over a user's omission. An
explicit `rbox setup`, `rbox track`, or config repair adds it.

Ancestor/descendant roots and lexical/physical aliases are always codec-valid;
inventory reports them diagnostically. Migration therefore cannot retire
layouts current releases support. CLI-owned `recordFolder` and guided setup
refuse introducing a newly observed physical overlap, while a hand-authored
catalog remains readable and diagnosable rather than depending on unavailable
grandfather provenance.

### 6.4 Compatibility projection

New binaries resolve options from the catalog. They materialize the resolved
safe option fields plus a catalog generation into each bound `workspace.json`
through the identity-checked binding mutation Interface so a sequential
downgrade uses the most recently converged behavior.

Projection is compatibility data, not new-binary authority after cutover.
Catalog publication queues an idempotent all-root convergence pass. Each patch
aborts if the catalog generation changed. Convergence is derived directly from
each current binding's identity-bound projection stamp; there is no progress
sidecar. A stamp proves only the named `(streamId, deviceId, generation)` and is
invalid after rebind. Hand edits are reconciled by `rbox config apply`.
`rbox config status` reads every reachable binding and is the only claim that
all of them are safe for sequential downgrade.

Admission never performs projection. `rbox config apply` and post-command
best-effort convergence invoke the projection Interface only from a no-workspace-
lock context, after any foreground operation releases its mutex. The Interface
then independently acquires scope-transition → workspace locks and rechecks the
catalog generation and binding identity. A degraded/unowned mutex produces a
pending result, never a projection write.

A crash after catalog publication but before all projections leaves the catalog
authoritative and progress visibly pending. Strict concurrent use of an old and
new binary cannot be made atomic across multiple roots and is not promised.
After a released-old binary changes a projected field, the authoritative
catalog wins when the candidate runs again; users must edit `config.json` to
make that change durable under the new model.

No old record is deleted in this cycle.

## 7. Operation semantics

### 7.1 Setup, init, track, and adoption

- Validate/create the local directory through existing guarded flows.
- Remote create and join remain explicit existing transitions.
- Persist and fsync the binding before adding the catalog entry.
- A crash between those steps leaves a valid detached binding, not an orphaned
  remote effect; repair/explicit setup can record it without creating again.
- `recordFolder` is skipped for export's synthetic staging binding.
- Rebind preserves the local catalog entry/options but replaces binding identity;
  scope and old stream state never carry.
- Adoption's lifecycle owner mints a typed `JournalPinnedFolderPolicy` from an
  admitted snapshot and stores it in the adoption journal. It contains the
  catalog generation plus all resolved safe fields: `syncGit`,
  `git.incremental`, `respectGitignore`, `noDrift`, and normalized trash days/
  maxBytes. Journal validation owns its closed codec. Resume never re-resolves
  current policy until the physical transaction completes; later edits apply
  afterward.
- Export's staging owner mints a typed `EphemeralExportPolicy` with its current
  synthetic semantics: `syncGit: true`, `git.incremental: true`,
  `respectGitignore: false`, `noDrift: false`, `trash.days: 0`, and
  `trash.maxBytes: 2147483648`. It remains outside catalog
  membership because its synthetic staging binding is not a machine folder.
  Neither case is represented by a generic bypass boolean.

### 7.2 Untrack and manual removal

`rbox untrack` retains its guarded destructive ordering:

1. stop and acknowledge the daemon;
2. remove the proven internal `.rbox` tree;
3. remove daemon runtime;
4. remove the catalog entry;
5. strictly forget the compatibility row.

A crash leaves a visible missing/detached condition and retry converges. A hand
edit removing a folder does **not** delete `.rbox` or user data. New binaries
stop/skip its daemon at the next safe boundary while retaining desired-state and
binding records as dormant recovery evidence. Re-adding resumes the prior
desired mode; `rbox untrack` is the explicit destructive cleanup.

### 7.3 Daemon and foreground operations

- The runtime boundary consumes one `FolderAdmission` from `FolderInventory`:

  ```ts
  type FolderAdmission =
    | { kind: "admitted"; generation: string; policy: ResolvedFolderPolicy }
    | { kind: "legacy"; policy: ResolvedFolderPolicy }
    | { kind: "unbound" | "missing" | "detached" | "damaged"; reason: string };
  ```

- Every foreground sync and daemon cycle pins one validated admission after
  acquiring the workspace mutex.
- A concurrent edit applies on the next cycle, never halfway through a
  scan/pull/push.
- A configured folder's effective safe fields are attached without replacing
  runtime-injected `encrypted`, KEK, account/epoch, token, or credential URL.
- A malformed/missing authoritative config halts before the next pull/publish
  boundary and surfaces the exact parse/authority error.
- A removed entry stops at daemon startup or the next operation boundary; it
  never triggers binding deletion. Detached bindings permit read-only
  status/doctor/config diagnosis only. `sync`, `pull`, `push`, `start`,
  `recover`, `ignore` mutation, and `include` mutation require the idempotent
  explicit transition `rbox config add <path>`; no command silently re-adds it.
- Boot resume skips missing, detached, and unbound entries.

Daemon construction adds an admission check before authenticated runtime work;
startup cannot wait for the later ordinary boundary. Reload copies only the
resolved safe policy fields onto the existing boot object, preserving
runtime-injected E2EE/credential fields exactly as the current
`respectGitignore` regression requires. `respectGitignore` hot-applies with a
matcher rebuild; `trash` applies at the next operation boundary; `noDrift` is a
foreground completion concern and causes no daemon transition; `syncGit` and
`git.incremental` changes require an acknowledgement-gated daemon recycle and
uncached rescan. No field mutates an in-flight operation.

### 7.4 Moves and copies

Hand-editing `path` does not silently infer a safe move. The candidate is a move
only when the new path carries a binding whose `rootPath` names the old path,
the old path is absent, and no configured/observed path carries the same
`(workspaceId, deviceId)` pair. Otherwise status reports an ambiguous copy or
rebound condition and no daemon starts.

The first implementation requires an explicit repair/move command to rewrite
`rootPath`, registry projection, and daemon runtime key. It must not treat a
matching workspace ID alone as proof because multiple devices may legitimately
bind the same remote folder.

Existing ancestor/descendant and lexical-alias roots remain supported. New
guided setup refuses a newly introduced physical overlap because two new sync
owners over the same bytes would compete, but direct parsing/migration keeps
grandfathered layouts readable and diagnosable.

## 8. Concurrency and durability

- One global config lock serializes CLI mutations.
- Mutations re-read and compare the source digest immediately before atomic
  publication so an editor change observed since planning is usually rejected.
  This is best-effort stale-edit detection, not true CAS against an editor that
  can race between comparison and rename.
- No config lock is held across network calls, daemon shutdown, filesystem
  scans, adoption, or scope transitions.
- Readers take no lock and see complete old/new bytes through atomic rename.
- Every authoritative config/marker/binding publication calls
  `fsyncDirectory` after `writeFileAtomic`; the helper fsyncs file bytes but does
  not make the parent-directory rename durable by itself.
- User authority parse errors never degrade to an empty folder list.
- Folder mutations and scope transactions touch disjoint owned fields;
  compatibility projection must preserve identity and scope bytes.

## 9. Protected functionality ledger

| Protected behavior | Owner | Required evidence |
|---|---|---|
| Create vs join and first push/pull ordering | existing setup/init Modules | differential setup/init tests + onboarding rig |
| Binding/stream/device identity | `workspace-config.ts` + reset/state gates | identity byte fixtures, reset compatibility |
| Scope publication seal and journal | `scope/*` + registry witness | scope crash/mismatch matrix |
| Non-empty adoption/collision retention | adoption Modules | adoption resume/crash tests |
| Running/stopped/pull-only/maintenance intent | autostart Modules | desired-state transition tests |
| E2EE runtime attachment survives reload | auth remote + daemon | v0.9.2 regression and daemon reload tests |
| Legacy config absence is byte-identical | existing config path | old/new differential fixtures |
| Missing/rebound roots remain visible | binding registry + aggregate status | aggregate health tests |
| Old JSON workspace/name fields | status/doctor JSON adapters | byte/schema compatibility tests |
| Explicit untrack guards and ordering | untrack Module | crash-step matrix |
| Environment drift override | sync completion policy | existing env tests |
| Trash bounds/defaults | workspace config normalization | fieldwise boundary tests |

The sync, encryption, upload, server, and wire protocols are unchanged.

Machine status/doctor JSON schema v1 remains registry/binding-shaped and keeps
its closed `binding` values and remote `name` meaning. Human aggregate output
may add a separate configured-but-unbound section. `rbox config --json` owns a
new schema-v1 folder-intent/status payload including local names, unbound,
detached, and projection state; no new enum is inserted into the old schema.

## 10. Requirement challenges

| Requirement | Complexity cost | Decision |
|---|---|---|
| Put workspace IDs in user config | exposes implementation identity and makes hand edits dangerous | rejected |
| Treat folder name as remote identity | collisions/renames could bind wrong data | rejected |
| Make scope a normal override | bypasses prune/journal/publication seal | rejected |
| Config addition auto-creates remote state | passive typo could cause network mutation | rejected |
| Config removal deletes `.rbox` | destructive side effect from text edit | rejected |
| Config membership replaces desired daemon mode | collapses separate crash-sensitive intent | rejected |
| Guess which legacy values were explicit | may change existing sync behavior | rejected |
| Delete `workspace.json`/`workspaces.json` now | active identity, witness, downgrade paths | not approved |
| Concurrent old/new binary correctness | multi-root cross-file atomicity is unavailable | sequential downgrade only |
| Put new folder states into machine JSON v1 | changes a protected closed schema | separate `rbox config --json` surface |

## 11. Implementation slices

1. **Dormant foundation PR:** strict bounded catalog/marker codecs, path
   normalization, pure fieldwise resolution, catalog state inspection, atomic
   durable publication, best-effort stale-edit detection, and pure candidate
   construction from caller-supplied seeds including unavailable-policy refusal;
   no legacy observation, activation, or runtime caller changes.
2. **Behavior-preserving prerequisites:** identity-checked binding option
   projection under scope→workspace locks with directory fsync; read-only
   `FolderInventory` initially reproducing registry behavior; strict migration-
   evidence codecs/readers; typed adoption/export policy witnesses; projection
   progress/convergence.
3. **Atomic activation:** add fresh-bind creation and explicit upgrade migration,
   then switch setup/track/untrack, ignore mutation, foreground runtime, daemon
   startup/boundaries, boot resume, and human/config status together. Existing
   machine JSON v1 remains unchanged.
4. Add explicit move/copy repair, compiled CLI validation, downgrade fixtures,
   and the real onboarding/daemon/scoped rigs.

The dormant foundation may land alone because it changes no behavior. Authority
activation may not land partially: all admission/runtime/lifecycle consumers
switch in one reviewed activation PR or none do. Do not ship a second live
authority with ambiguous ownership.

## 12. Validation gates

### Differential and compatibility

- config+marker absent produces byte-identical legacy reads and commands;
- migration preserves true, false, omitted, zero, and partial nested values;
- existing JSON status/error/name schemas remain byte-compatible;
- candidate projects effective options for sequential released-old use;
- released-old mutation followed by candidate restart has a documented,
  deterministic winner.

### Crash and concurrency

- inject failure at config temp write/fsync/rename/dir-fsync and marker stages;
- marker with missing/corrupt config fails closed;
- bind crash after remote effect, binding write, registry write, catalog write;
- untrack crash after every durable/destructive step;
- human edit and two CLI mutations race through digest compare;
- config edit during daemon scan/pull/push applies only next cycle;
- scope edit racing option projection cannot lose scope intent/witness;
- global projection failure at every folder converges on retry.

### Filesystem identity

- `~` expansion and `~user` rejection;
- lexical, realpath, symlink, case, duplicate-name, duplicate-path cases;
- missing, unbound, rebound, detached, move, copied-device identity;
- new guided overlap refusal plus grandfathered legacy overlap acceptance.

### Runtime

- focused config/binding/setup/track/untrack/status/doctor/autostart/daemon/scope
  suites;
- typecheck, lint, mutation gates, and compiled CLI smoke;
- onboarding rig for create+join and a daemon restart after option edit;
- scoped pull-only rig proving scope remains outside the generic option plane.

## 13. Retirement and deletion statement

Nothing is approved for deletion in this cycle. `workspaces.json` can retire
only after its scope witness moves, the released-old support window closes,
snapshot tooling migrates, and aggregate/downgrade tests prove replacement.
Option projections in `workspace.json` can retire only after every supported
binary resolves policy from the catalog. Daemon desired rows remain independent.
