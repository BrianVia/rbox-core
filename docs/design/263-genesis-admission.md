# 263 — Genesis admission closes the selector-to-authority loop

Status: ALIGNED v4
Round history: R1 wave (R1A locking + R1B scope, CHANGES-REQUIRED) → v2 →
R2 serial (CHANGES-REQUIRED: publication order, undecided daemon placement,
dependency shape) → v3 → R3 final (one HIGH with reviewer-supplied exact
placement + one editorial ledger row). R3's two residuals folded directly
and self-certified under the convergence rule: the HIGH was a point
correction whose fix the reviewer specified and pre-verified (placement
after refreshScopeAuthority + resetOperationBoundary, before
folderOperationBoundary, still preceding both scans); no new mechanism was
introduced by the fold. — SP-1 of design 262 v2's "finish the
state plane" loop. This slice resolves CODEX-262-A findings 1–2 only. It makes
the already-built genesis protocol reachable and recoverable from the normal
held-mutex state entries; it does not make any legacy-format product decision.

Round history: v1 proposed a borrowed-mutex genesis admission at the normal
selector seam. CODEX-263-R1A and CODEX-263-R1B both returned
CHANGES-REQUIRED. The orchestrator accepted every round-1 finding, with the
track addition cut from SP-1 rather than repaired here: v2 makes dispatch
intent-first for every format, revalidates both lock ownerships at the `Q`
publication boundary, closes all daemon pre-admission loads, states the JSON
read and crash-coverage deltas honestly, and makes the real-entry, suite, import,
size, and simplification gates explicit. CODEX-263-R2 returned
CHANGES-REQUIRED. The orchestrator accepted all three findings: v3 restores the
holder observation as the literal last operation before the `Q` rename, fixes
the migration-precedent account, places daemon admission at the top of the
held-mutex operation boundary, and makes settled selection SQLite-free with
genesis/lock machinery loaded only on the admission-required branch. It also
adds the missing daemon route rows, static-import/inventory gates, and cold/warm
settled-JSON measurements.

Depends on: 262 v2 (parent ordering), 222 (genesis and the state-plane lock
bundle), 163 (SQLite authority law), and the implemented U3 store slices.

Parent-plan note for **SP-3**: `track` is not an SP-1 admission entry. If SP-3
makes successful fresh `track` establish genesis after `saveConfig`, it must
fsync `.rbox` after the workspace-config rename and before publishing a genesis
intent. Atomic rename alone does not make that config durable enough to serve as
genesis evidence across power loss. SP-3 owns that product decision, durability
change, and its crash tests.

## 0. Yardstick

A normal foreground sync or daemon boot/pump entry can finish exactly one
SQLite genesis without calling the migration driver,
reacquiring a workspace mutex it already owns, or entering
`locks.ts`'s `loadRawState -> whole-state selector` recursion. A crash after
an intent is published is not terminal: the next real foreground or daemon
entry claims the surviving intent before dispatching on any authority format,
retires it on every non-corrupt recovery/refusal branch, then re-selects the
file-level authority before opening a store. A foreign/corrupt claimant is
claimed and fails closed rather than being bypassed or deleted.

The slice is successful when the following path is real:

```
held workspace mutex
  -> file-level authority observation
  -> genesis-only remaining fences (no whole-state inventory)
  -> genesis establish/resume
  -> file-level authority re-selection
  -> legacy JSON adapter or SQLite store adapter
```

`genesis.establish` remains the sole owner of the seven-step durable protocol.
Admission supplies exclusivity and routing; it does not duplicate a genesis
phase, infer an id, or manufacture a store result.

## 1. Protected-functionality ledger

| Contract protected by SP-1 | Owner after SP-1 | Proof |
|---|---|---|
| A settled JSON workspace still selects `legacy-json-store`; its result shapes, warnings, stream checks, resets, CAS writes, degraded-mutex fallback, telemetry behavior, and bytes do not change. A held-mutex load now performs one bounded genesis-intent existence/strict-decode read before returning JSON; with no intent it performs no mutex ownership check and takes no admission fence | admission coordinator, existing legacy adapter, and whole-state compatibility surface | read-count plus byte/residue differential matrix and existing legacy suites |
| `absent` without a healthy caller-held mutex retains the current compatibility selection; raw/diagnostic observations do not silently become mutating entries | state-authority selection in `authority-bootstrap.ts` | held-vs-unheld selector tests |
| Exact `Q` with no genesis intent selects SQLite without taking genesis fences or opening a second database | state-authority selection in `authority-bootstrap.ts`; open remains in `whole-state-compat.ts` | settled-`Q` fast-path test and open-count gate |
| A strictly decoded surviving genesis intent is claimed before format dispatch for `absent`, JSON, foreign, or `Q`; `genesis.establish` remains responsible for retiring it on every non-corrupt recovery/refusal branch and failing closed on corrupt foreign evidence | admission coordinator plus `genesis.ts` | intent×format matrix, including crashed `json + intent` cleanup |
| A live genesis intent blocks SQLite saves until it is retired, including the post-`Q` crash image | `assertAuthorityWritable` in `authority-bootstrap.ts` | G4's existing first-restart coverage plus the amended recovery-restart matrix and real-entry crash gate |
| Genesis intent shape, id custody, evidence binding, staged/active inode proof, `Q` publication order, and owned cleanup stay as implemented; publication is ordered final evidence → workspace-mutex ownership check → state-lock ownership check → final holder classification → `Q` rename, with holder classification immediately adjacent to rename | `genesis.ts`, `genesis-intent.ts`, and the existing lock primitives | amended genesis unit/crash matrices plus post-entry ownership-loss tests |
| Existing `rbox migrate`, retry/abort, and upgrade-window migration continue through `withStatePlaneLocks` and `establishStateAuthority` unchanged | migration coordinator and existing full lock entry | migration authority/lock suites |
| No database is opened until exact `Q` has selected it; the write fence stays file-level and SQLite-free | authority selector, compatibility adapter, write fence | import/open graph gates and residue tests |
| `track` remains completely outside SP-1: no new load, admission, lock duration, failure point, output, or state publication is added | `track-cmd.ts` | unchanged track suites and zero SP-1 diff under `track-cmd.ts` |

No command, alias, output, wire/API shape, durable record, safety property,
compatibility path, migration/readiness path, or performance fast path is
approved for deletion. Existing JSON workspaces remain supported and `json`
continues to mean `legacy-json-store`; the intentional behavior delta is the
extra file-level intent check on held-mutex loads so a surviving intent cannot
be stranded behind JSON. Performance accounting additionally includes the cold
dynamic-import/module-evaluation cost of reaching the SQLite-free selector.

## 2. Module and exact Interface

### 2.1 `authority-bootstrap.ts` owns admission

`authority-bootstrap.ts` is already the only coordinator allowed to know both
genesis and migration and already owns the shared recovery-pending write fence.
It gains the genesis-only normal-entry operation and the file-level selection
value; no Adapter is allowed to reconstruct this orchestration.

```ts
export type StateAuthoritySelection =
  | {
      readonly kind: "legacy-json-store";
      readonly format: "absent" | "json" | "foreign";
    }
  | {
      readonly kind: "sqlite-store";
      readonly format: "authority-marker";
      readonly authorityId: string;
    };

/** File-level observation only. Never takes locks, opens SQLite, or mutates. */
export async function selectStateAuthority(
  root: string,
): Promise<StateAuthoritySelection>;

/**
 * Complete normal-entry genesis admission. `heldMutex` is borrowed: the caller
 * owns and releases it. The return value is a fresh post-operation selection,
 * never a projection of `GenesisOutcome`.
 */
export async function admitGenesisAuthority(
  root: string,
  heldMutex: WorkspaceSyncMutex,
): Promise<StateAuthoritySelection>;
```

`selectStateAuthority` preserves today's selector law exactly: only exact `Q`
returns `sqlite-store`; `absent`, `json`, and `foreign` return
`legacy-json-store`. For exact `Q`, it reads the marker id with the existing
bounded no-follow primitive and throws `StateAuthorityCorruptError` if the
marker changes between classification and id read. It reads no genesis intent
and opens no database.

The settled-selection dependency graph is SQLite-free. The Adapter reaches
`selectStateAuthority` and `admitGenesisAuthority` through a dynamic import of
`authority-bootstrap.ts`, preserving its existing prohibition on a static
coordinator import. The coordinator's statically reachable graph for intent
read, format classification, marker-id read, migration-control read, and the
write fence must contain no `bun:sqlite`, store facade, genesis implementation,
or lock implementation. `genesis.ts` and the borrowed-lock machinery are loaded
with dynamic `import(...)` only after the coordinator has decided admission is
required: state is `absent` or an intent is present. A settled JSON, foreign, or
exact-`Q` selection with no intent never evaluates the genesis/lock chunk. Type-
only imports may name their Interfaces but must erase from the runtime graph.
The existing operator coordinator may also load genesis lazily; this dependency
change does not alter its dispatch behavior.

The normal-entry branch shape is pinned, without adding an exported mode:

```ts
if (intent === undefined && selection.format !== "absent") return selection;
const [{ withGenesisAdmissionLocks }, genesis] = await Promise.all([
  import("./locks.js"),
  import("./genesis.js"),
]);
```

The imports occur after the first intent/selection decision, never speculatively
or at Adapter module evaluation. Bun's ordinary module cache supplies the warm
path; SP-1 adds no second cache or loading abstraction.

`admitGenesisAuthority` receives a caller-held handle but does not validate it
until mutation is required. A settled JSON/foreign/`Q` observation with no
intent returns before `assertHealthyOwnedSyncMutex`, preserving ordinary JSON's
released/wrong-root/ownership-lost behavior apart from the intent read. When
admission is required, the handle must be the live, non-degraded mutex for
`root`; the operation never acquires, releases, or replaces it. Callers with a
degraded handle retain their legacy compatibility path in SP-1. Supporting
SQLite writes on that degraded path belongs to SP-2.

The operation is exact and bounded:

1. Read the bounded genesis intent **before dispatching on format**, then observe
   with `selectStateAuthority`. A malformed/undecodable intent fails closed for
   every format; it is never treated as absence.
2. If no intent exists, return immediately for `json`, `foreign`, or settled
   exact `Q`. These states take no admission locks and do not validate the
   borrowed mutex. `absent` still enters admission.
3. Enter genesis admission for `absent` without an intent, or for a surviving
   strictly decoded intent with **any** observed format. Format never hides an
   intent.
4. Borrow the caller's mutex and acquire the remaining fences through
   `withGenesisAdmissionLocks` (§2.2). Inside that window, re-read intent first
   and then re-observe format. If an intent survives, always call
   `genesis.establish(root, mintIds, locks)`: its existing lines 67/113/205
   claim the intent, decide the current format, remove only owned artifacts,
   and retire the intent. If no intent survives, call establish only for
   rechecked `absent`; a raced JSON/foreign/settled `Q` returns fresh selection
   without genesis mutation.
5. This normal-entry operation never constructs an `EntryProof`, never accepts
   a `MigrationDriver`, and can never dispatch migration. It adds no import from
   `state-plane/migration/**`; the pre-existing migration imports used by the
   operator coordinator and write fence do not become admission dependencies.
6. Re-run `selectStateAuthority` **after** `genesis.establish` and while the
   remaining fences are still held. Also re-read the intent. An
   `established`/`already-established` outcome requires `sqlite-store` and no
   intent; disagreement is `StateAuthorityCorruptError`. A genesis refusal is
   not converted into authority: the fresh bytes decide (`legacy-present`
   therefore re-selects JSON; an untouched absent/artifact refusal remains the
   existing compatibility selection).
7. Return only that fresh selection. Neither an outcome's `authorityId` nor a
   pre-lock observation may be used to choose or open the backend.

The existing `establishStateAuthority(root, entry, runMigration)` stays for the
two migration-era operator coordinators. Normal admission does not call it and
shares no helper whose dependency graph reaches a migration driver: injecting a
driver that "should never run" would preserve the migration branch as accidental
normal runtime authority and is rejected. SP-1 adds zero `migration/**` imports
and makes zero production edits under `migration/**`.

### 2.2 `locks.ts` owns the borrowed-mutex remaining fences

`locks.ts` gains one narrow sibling to the existing full acquisition:

```ts
export async function withGenesisAdmissionLocks<T>(
  root: string,
  heldMutex: WorkspaceSyncMutex,
  fn: (locks: HeldStatePlaneLocks) => Promise<T>,
  options?: StatePlaneLockOptions,
): Promise<T>;
```

This function is the only additional mint site for the existing branded
`HeldStatePlaneLocks`, and it mints the same proof, not a weaker genesis proof.
It borrows `heldMutex`; both success and throw paths leave that mutex owned and
unreleased for the caller. It acquires and releases every remaining fence in
this exact order:

```
assertHealthyOwnedSyncMutex(heldMutex, root)
  -> read reset-only inventory
  -> withRepositoryRecoveryFence(reset requests, state identity, ...)
  -> acquire <state>.lock
  -> re-read and fingerprint reset-only inventory; bounded restart on change
  -> recover a standing reset journal to completion
  -> verify state-lock ownership before body entry
  -> mint HeldStatePlaneLocks and call body
  -> at the Q publication boundary, after final evidence and before the final
     holder classification, revalidate borrowed-mutex ownership and then
     state-lock ownership
  -> release state lock and repository fence (never the borrowed mutex)
```

The **reset-only inventory** contains the durable config stream and every
repository named by a standing reset journal. It deliberately does not read
the current sync state. This is sufficient because genesis itself never
touches a repository, an absent authority names no state repositories, and a
resumed genesis database is accepted only by `genesis.ts`'s existing finishing
conjunction with `repo_count = 0` and `entry_count = 0`. Reset recovery is the
only adjacent operation that may touch repositories, so its journal supplies
the complete repository request set.

This is the recursion breaker. Neither reset-only inventory pass may call or
import through `loadRawState`, `loadState`, `selectStateAuthority`,
`admitGenesisAuthority`, or `whole-state-compat`. In particular it must not
reuse `inspectInventory`'s current line-169 whole-state read. A private common
lock runner may be factored inside `locks.ts`, but its inventory reader is an
injected private function; there is no exported mode boolean and the existing
`withStatePlaneLocks` behavior remains byte/order equivalent.

A standing reset that cannot be decoded or recovered fails closed before
genesis. A degraded, wrong-root, released, or no-longer-owned borrowed mutex
also fails before any genesis artifact. SP-1 adds no unlocked genesis fallback.

The entry-time checks are not publication authority. In `genesis.ts`'s
`finishWithQ`, the publication order is exactly: **final evidence → mutex ownership check → state-lock ownership check → final holder classification → rename**.

```
final evidence
  -> assertHealthyOwnedSyncMutex(locks.mutex, root)
  -> locks.stateLock.isOwner()
  -> final holder classification
  -> sibling-to-state.json rename
```

The holder classification remains the literal final operation before rename,
with no intervening filesystem operation, matching `genesis.ts:184`'s
deliberate last-op invariant and `reset-journal.ts:342`'s wired
ownership-check → final-state-read → rename pattern. Loss of either ownership
after body entry refuses publication and leaves the intent for a later owner.
Migration `admission.ts:151` is a useful helper pattern because its
`exclusivityWindow` checks both ownerships, but it is called in production only
at initial admission through `begin.ts:103`; the authority flip at
`authority-flip.ts:306` does **not** re-call it. It is therefore not a wired
publication-boundary precedent. These are direct invariant checks, not a new
port, plan, receipt, or cached capability.

`locks.ts` is currently 298 nonblank lines and 14,298 bytes. Its SP-1 landed
budget is at most **360 nonblank lines and 20 KiB**, preserving headroom beneath
the hard **400 nonblank / 25,600-byte** gate; no allowlist entry is permitted.
The implementation review records the final nonblank/byte count. If a cohesive
new lock module is required instead, it must own real lock acquisition rather
than relay one call, update CODEMAP, enter the size acceptance table at its
landed count, and remain under the same hard gate.

### 2.3 `whole-state-compat.ts` remains the Adapter

The Adapter stops owning the authority decision and consumes the two operations
above:

- `loadRawState` and `applyStateSavePacket`, which have no caller-held workspace
  mutex in their Interface, call `selectStateAuthority` and retain current
  absent/JSON behavior.
- `loadState(root, stream, warningSink, heldMutex)` calls
  `admitGenesisAuthority` only when `heldMutex` is present and non-degraded;
  otherwise it calls `selectStateAuthority`.
- The returned selection routes to the existing legacy or SQLite branch.
  SQLite open, authority-id/header equality, stream checking, reset-lineage
  provenance, and CAS translation remain where they are.

There is no recursive call back into `loadState` after admission: the
coordinator returns the post-operation selection. There is also no
"established means SQLite" shortcut in the Adapter.

`docs/CODEMAP.md` changes in the implementation PR: `authority-bootstrap.ts`
owns file-level authority selection plus genesis admission;
`whole-state-compat.ts` consumes a selection and owns only backend adaptation;
and `locks.ts` accurately owns both full and borrowed-mutex lock ordering plus
publication-boundary ownership proof. No new production module is planned; the
budgeted cohesive-module escape above is allowed only if `locks.ts` cannot land
within its stated budget without becoming shallower.

## 3. Exactly where admission runs

SP-1 adds two real entry families, both converging on the held-mutex `loadState`
selector path:

1. **Foreground CLI sync.** `LocalRuntime.run` already acquires one workspace
   mutex and supplies it as `SyncDeps.syncMutex`; pull/push/sync already pass
   that handle to `loadState`. Their first state load therefore admits an
   absent workspace or resumes a live intent before any scan, pull, push, or
   state save.
2. **Daemon.** Direct startup already calls
   `loadSyncBase(startupMutex.handle)`. For contended startup, genesis admission
   runs inside `openOperationBoundary(syncMutex)` **after
   `refreshScopeAuthority` and `resetOperationBoundary`, and before
   `folderOperationBoundary`** [R3#1 fold — the round-2 "top of boundary"
   placement would have let genesis mutate state before scope-authority
   acceptance (daemon.ts:1562 fails closed on missing/corrupt authority) and
   let reset load failures escape the durable reset-halt lifecycle
   (daemon.ts:1256); the corrected placement still precedes both scan sites
   (daemon.ts:2783 uncached scan, :2893 recycle)]. Under the already-held
   workspace mutex:

   ```ts
   await this.loadSyncBase(syncMutex);
   ```

   This placement is before `folderOperationBoundary`, adoption-cache
   reconciliation, any matcher rebuild, and any recycle scan. It therefore
   precedes both the uncached adoption-generation scan at `daemon.ts:2783` and
   the recycle path beginning at `daemon.ts:2893`, including the recycle-only
   arm that can scan without taking its conditional matcher load. All later
   boundary consumers reuse the admitted `syncBase`; if a later boundary step
   invalidates it and must reload, that reload also receives `syncMutex`. The
   final binding check must not fall back to an unheld `loadSyncBase()`.
   Direct and contended startup thus both reach one
   `loadSyncBase -> loadState(..., heldMutex)` admission before any scan or
   state save; no daemon method calls admission directly.

`track` is cut from SP-1. This slice makes no `track-cmd.ts` or track-test change
and does not extend its locks, add a post-config state load, recover JSON reset
work, or introduce a post-config failure. A later foreground or daemon entry
admits the fresh workspace. The parent-plan note above carries the `.rbox`
fsync prerequisite if SP-3 chooses to close track's no-first-sync gap.

The trigger is deliberately not "every selector call". Held-mutex-less reads,
raw observations, diagnostics, and direct save routing keep the current absent
selection in SP-1. This is the boundary between admission and SP-3's product
default flip.

## 4. Contracts and invariants

### 4.1 Single writer

- Genesis mutation requires one healthy, live-owned workspace mutex, the
  repository recovery fence over the reset-only inventory, and the exact state
  lock. There is no optional or degraded mutation path.
- Foreground and daemon borrow the same workspace-mutex primitive; two entrants
  serialize before either can mint a genesis intent. The second entry sees
  settled `Q` or resumes the first entry's intent; it never mints a second live
  attempt.
- The reset inventory is fingerprinted before and under the repository fence.
  Change restarts acquisition within the existing bounded attempt count; the
  body never proceeds on stale reset requests.
- The state lock is owned before reset recovery and genesis, and released before
  the borrowed workspace mutex. Callback scope is the lifetime of the branded
  bundle.
- Entry-time ownership is not cached. `genesis.ts` revalidates both the borrowed
  workspace mutex and the exact state lock at the `Q` publication boundary.
  Losing either after callback entry prevents the rename and leaves the intent
  as retry authority.
- Genesis may remove only paths its existing intent/inode/evidence conjunction
  owns. Admission grants no deletion authority of its own.

### 4.2 Write fence during admission

`assertAuthorityWritable(root)` is unchanged. From the instant the genesis
intent is durable until `genesis.ts` retires it last, every SQLite save refuses
with:

```ts
new StateWriteRefusedError(
  "authority-recovery-pending",
  statePath(root),
  `genesis attempt ${intent.authorityId} has not been retired`,
)
```

That includes `Q + intent`: reads may prove and resume the authority, but no
SQLite CAS may land first. Before the intent exists, the complete lock bundle
is the single-writer fence. Before `Q`, an old or external JSON writer that does
not participate in the new admission can still race; genesis's existing final
holder check is the backstop and preserves `L` byte-for-byte, removes only its
own artifacts, retires its intent, and returns `legacy-present`. SP-1 does not
change `assertStatePublishable` or add an intent check to the legacy writer.

### 4.3 Crash points and exact recovery

| Crash image | Next admitted entry |
|---|---|
| after staged inode claim, before intent | `state.json` remains absent and no record owns the zero-byte strand; a fresh admission mints new ids and leaves the inert strand untouched |
| after intent publication, before/during staged-store build | `absent + intent`; resume uses the intent's ids and recorded inode, repairing the same inode where authorized |
| after active DB rename, before `Q` preparation/publication | `absent + intent`; resume proves the active DB, seals it at rest, and continues with `Q` |
| after `Q` sibling fsync, before authority rename | `absent + intent`; resume reuses the intent and exact sibling/DB proof |
| process crash/SIGKILL after authority rename, before `.rbox` fsync | the next process observes `Q + intent`; admission runs despite the marker, proves marker+DB+evidence, and resumes cleanup |
| power loss after authority rename, before `.rbox` fsync | durability forks: either `Q + intent` if the rename persisted or `absent + intent` if it rolled back; both reuse the same intent/id, with the absent arm recovering through the existing active-DB case 2 |
| crash during post-`Q` recovery after repeated `.rbox` fsync, sibling unlink, sibling-parent fsync, intent unlink, or intent-parent fsync | every intermediate is restart-safe; an unlink not yet parent-fsynced must be tested in both permitted outcomes (name present again or durably absent), and recovery either repeats owned cleanup or selects settled `Q` |
| after intent retirement | settled `Q`; no admission locks, no replay, ordinary SQLite selection |
| `L` appears before the final `Q` rename | existing case 5: preserve `L`, delete only intent-owned artifacts, retire intent; post-operation selection is `legacy-json-store` and normal migration is **not** dispatched |
| foreign marker/database/evidence or an undecodable intent | fail closed with the existing corruption type; zero inferred repair and no foreign deletion |

Recovery is idempotent across entry kinds: a foreground-killed image may be
resumed by the daemon and a daemon-killed image by foreground sync. The intent
remains the sole source of both ids on every resume. The existing G4 test proves
one kill after the `Q` rename followed by uninterrupted recovery; it does **not**
prove crashes during the recovery cleanup, so v2 requires those restart cells
rather than calling G4 exhaustive.

## 5. Tests the implementation MUST write

### 5.1 Interface and lock tests

1. Extend `locks.test.ts` with a real acquired workspace mutex proving
   `withGenesisAdmissionLocks` takes stages in the specified order, leaves the
   borrowed mutex live/owned after return and throw, releases the state lock,
   and never calls `acquireWorkspaceSyncMutex` or `releaseWorkspaceSyncMutex`.
2. Add a recursion gate: both absent and `Q + intent` admission complete while
   the whole-state inventory function is replaced by a throwing sentinel. A
   structural assertion also pins that the reset-only inventory's reachable
   calls contain no `loadRawState`, `loadState`, or whole-state selector call.
3. Pin wrong-root, released, degraded, and ownership-lost mutexes as zero-genesis-
   residue failures. Pin reset-inventory change as bounded restart and a
   standing reset as recovered-before-body or fail-closed.
4. Add post-entry loss injection for each ownership independently: remove the
   borrowed workspace-mutex marker after genesis body entry but before `Q`
   publication, then repeat for the state-lock marker. Each must refuse before
   the authority rename, preserve the live intent and owned artifacts, and let
   a later real owner resume. A negative control pins both ownership checks
   **before** the final holder observation and pins that holder observation
   immediately adjacent to rename; an earlier holder observation must still be
   shown capable of losing to a raced `L`.
5. Race two real held-mutex entries and assert one authority id, one active DB,
   no live intent, no sidecars, and no second id mint.

### 5.2 Selector and compatibility tests

1. In `whole-state-compat.test.ts`, a healthy held-mutex `loadState` on absent
   state must return the genesis empty state **from SQLite after re-selection**;
   assert exact `Q`, matching DB authority id, genesis completion tuple, absent
   intent, and no legacy JSON document.
2. Plant each real post-`Q` crash image, call held-mutex `loadState`, and assert
   the same authority id is retained, the intent is retired before return, and
   an ordinary SQLite save then passes the write fence. Cover both power-loss
   durability outcomes after the `Q` rename: `Q + intent` and
   `absent + active DB + intent`.
3. Pin the non-flip: absent `loadRawState`, absent held-mutex-less `loadState`,
   and direct save routing preserve their SP-1 legacy behavior. A settled `Q`
   performs no admission lock acquisition and no extra SQLite open.
4. Run a JSON matrix through held/unheld raw reads, loads, and saves. With no
   intent, assert the whole `.rbox` tree and result/error shapes are
   differential with the pre-SP-1 baseline; exactly one bounded intent check is
   observed on held-mutex load, no mutex ownership validation/fence occurs, and
   no intent, DB, marker, or SQLite sidecar appears. Released, wrong-root, and
   ownership-lost handles on settled JSON retain their prior result/error shape.
   With `json + intent`, assert intent-first dispatch reaches existing genesis
   case 5, preserves JSON byte-for-byte, removes only intent-owned artifacts,
   retires the intent, and returns `legacy-json-store`. `foreign` never bypasses
   a surviving intent and retains its fail-closed foreign-artifact behavior.
5. Add a coordinator test proving normal admission cannot invoke a migration
   driver or construct an `EntryProof`; existing explicit migration dispatch
   tests remain green.

### 5.3 Real-entry crash gate — not direct `genesis.establish`

Add `genesis-admission-crash-gate.test.ts`. Its fresh-process fault child uses
the existing syscall-level SIGKILL technique but drives these production
entries:

- **foreground:** `LocalRuntime.run` with its real workspace-mutex acquisition,
  real sync-driver first state load, and real `loadState` selector path. Remote
  transport and folder-admission dependencies may be deterministic test ports,
  but `LocalRuntime`, the mutex, the first load, selection, and admission locks
  may not be mocked;
- **daemon direct start:** `RboxDaemon.start` with its real startup mutex and
  real `loadSyncBase -> loadState` path;
- **daemon contended start:** force the startup mutex miss, enqueue through the
  real scheduler, release contention, and enter `openOperationBoundary` with
  the real acquired mutex. Its table has separate adoption-generation and
  recycle-only rows. The adoption-generation row must take the uncached scan at
  `daemon.ts:2783`; the recycle-only row must enter the `daemon.ts:2893` recycle
  path without relying on the conditional matcher load. In both rows, prove the
  top-of-boundary held-mutex admission completes before the scan, matcher
  rebuild, or other folder-policy work. Network, watcher, and timers may be
  inert test ports, but scheduler, mutex, policy-boundary routing,
  admission/selection, and admission locks may not be mocked.

For `after-intent-rename`, `after-active-rename`, and
`after-Q-rename`, kill each entry once and resume it through the other entry.
Every cell asserts the on-disk premise before resume, convergence to the same
intent authority id (except the existing pre-intent-strand case), retired
intent, exact matching `Q`, valid genesis completion tuple, store at rest, and
a writable post-recovery authority. The `after-Q-rename` cells additionally
assert `assertAuthorityWritable` refuses before resume and succeeds after it.

Amend `genesis-crash-matrix.test.ts` with restart injection during the existing
post-`Q` recovery sequence: after the repeated `.rbox` fsync; after owned sibling
unlink before and after its parent fsync; and after intent unlink before and
after its parent fsync. For each pre-fsync unlink, run both permitted durability
outcomes (the name reappears and the name stays absent), restart again, and
assert convergence. These cells amend G4; G4 itself remains the narrower
kill-then-uninterrupted-recovery proof.

The gate must contain no import or call of `genesis.establish`; add a structural
assertion for that prohibition. It must drive at least one foreground and each
daemon entry above, not satisfy "daemon" with direct startup alone. The amended
protocol matrix proves recovery mechanics; the new gate proves real product
entries reach them.

### 5.4 Existing-suite disposition ledger

| Suite | Disposition and reason |
|---|---|
| `genesis-crash-matrix.test.ts` | **amend**: G4 does not crash during recovery; add the post-`Q` restart cells and both outcomes of each un-fsynced unlink |
| `authority-bootstrap.test.ts` | **amend**: pin intent-first dispatch for every classified format, fresh post-operation selection, the exact final-evidence → mutex-check → state-lock-check → holder-observation → rename publication order, and zero new `migration/**` import/call edges |
| `compat-matrix.test.ts` and `whole-state-compat.test.ts` | **amend**: record the intent-existence read on settled JSON, preserve JSON result/bytes, cover absent, JSON+intent, `Q`+intent, held/unheld/degraded handles, and preserve `whole-state-compat.test.ts:234`'s gate forbidding a static coordinator/store import |
| `state-plane/inventory.test.ts` [path corrected — the selector site-count declarations live here (inventory.test.ts:67), not in schema/inventory.test.ts, which owns DB-schema gates and is preserved unchanged] | **amend with named inventory changes**: move the selector entry from `selectSqliteAuthority` to `selectStateAuthority`, update its file/site counts and guards, add the genesis-admission/read-intent and dynamic-import sites, and preserve the real-CLI eager static-closure gate proving no `bun:sqlite`; do not weaken any existing state-path guard |
| `locks.test.ts` and `file-size.test.ts` | **amend/preserve**: add borrowed-lock ordering and post-entry loss coverage; the existing 400/25 KiB gate stays unchanged and no allowlist entry is added |
| daemon startup/scheduler/policy tests | **amend**: separate direct and forced-contention paths; in the contended table add distinct adoption-generation (`daemon.ts:2783`) and recycle-only (`daemon.ts:2893`) rows, each proving admission precedes scan and matcher work |
| explicit migration authority, lock, retry/abort, and crash suites | **preserve unchanged**: SP-1 changes no migration command, behavior, production file under `migration/**`, or migration import edge |
| track suites | **preserve unchanged**: track is SP-3 scope and receives no SP-1 production or test edit |
| cold/warm settled-JSON load measurements | **add** [R3#2 fold]: measure cold and warm `loadState` on a settled-JSON workspace before and after SP-1 (the desktop dev build is the field bench); the accepted delta is the one bounded intent-existence read — any `bun:sqlite` chunk evaluation on the settled path is a regression against §the dependency shape and fails the slice |

## 6. Validation

- **Differential/compatibility:** run the existing whole-state compatibility,
  legacy store, reset, LocalRuntime, daemon startup/scheduler/policy, migration
  authority, and genesis suites according to §5.4. Track suites run unchanged.
  Record before/after JSON fixture residue and result shapes. No released 1.x
  compatibility claim changes in this slice.
- **Crash:** the amended protocol matrix plus the new real-entry cross-resume
  gate; every durable image includes whole-`.rbox` residue and SQLite sidecars.
  Report G4 as one existing restart cell, not exhaustive recovery-crash proof.
- **Single-writer:** real concurrent foreground/daemon admission attempts,
  state-lock contention, independent post-entry loss of both lock ownerships,
  and reset-inventory restart.
- **Performance:** every held-mutex admission call, including settled JSON,
  performs one bounded genesis-intent existence/strict-decode read before format
  dispatch. Settled JSON and settled `Q` then take no admission locks, perform no
  mutex ownership check, evaluate no genesis/lock machinery, and open no extra
  SQLite connection; `Q` opens the authority store exactly once in the Adapter.
  Genesis inventory performs no whole-state materialization or duplicate
  repository traversal. Record before/after p50/p95 for settled `Q` and for both
  **cold** and **warm** settled-JSON loads: cold means a fresh process/module
  graph, while warm means repeated loads after the selection chunk is resident.
  The accepted JSON cost includes the bounded intent read and cold dynamic-
  import/module-evaluation overhead; it is not described as only one read or as
  free.
- **Structural:** normal admission has no migration driver/`EntryProof` reach;
  SP-1 adds zero imports from or production edits under `migration/**`;
  reset-only inventory has no selector reach; `genesis.ts` still imports no
  migration module and `migration/**` no genesis module; only `locks.ts` (or the
  one budgeted cohesive lock module) mints `HeldStatePlaneLocks`. The import gate
  distinguishes the pre-existing `authority-bootstrap.ts` migration imports
  used by the operator coordinator/write fence from the zero new admission
  edges. Preserve `whole-state-compat.test.ts:234`'s no-static-coordinator/store
  gate and extend `state-plane/inventory.test.ts`'s real-CLI static-closure inventory:
  the settled-selection closure contains no `bun:sqlite`, while dynamic
  genesis/lock chunks are reachable only from the admission-required branch.
- **Size acceptance:** record `locks.ts` at baseline 298 nonblank/14,298 bytes,
  projected ceiling 360/20 KiB, and actual landed count; fail above 400/25,600
  bytes or on any new allowlist. Any approved new cohesive module enters this
  table at its actual landed nonblank/byte count and the same hard limits.
- **Required gates:** targeted tests for every suite in §5.4; `bun run typecheck`;
  `bun run lint:affected`; then `bun run rig` FAST against a dev
  build so fresh foreground, daemon direct start, and daemon contended start
  all run on SQLite state.

## 7. Standing simplification mandate

SP-1 applies design 262 v2's standing mandate to every touched state-plane
module. The concept-count delta is explicit:

- **Collapsed now:** `whole-state-compat.ts`'s private
  `selectSqliteAuthority` and the new admission decision become one
  `selectStateAuthority`/`admitGenesisAuthority` owner in
  `authority-bootstrap.ts`; foreground and all daemon paths consume the same
  held-mutex `loadState` Interface; full and borrowed lock acquisition share one
  private runner with different private inventory readers. The private runner
  is an implementation detail, not an exported mode.
- **Not introduced:** no admission port, phase plan, receipt, capability echo,
  wrapper, queue, flag, fallback, or exported mode relays a single in-process
  call. The only new public operation completes admission and returns the fresh
  durable selection; callers do not learn genesis phases or lock stages.
- **Left deliberately for later:** migration `EntryProof`, `MigrationDriver`,
  full whole-state inventory, legacy JSON write/reset/telemetry ownership,
  degraded-mutex policy, absent-default selection, and migration/default
  retirement remain owned by SP-2 through SP-4. SP-1 neither duplicates nor
  disguises them.
- **Types:** `StateAuthoritySelection` is one closed discriminated union with no
  booleans or identity echo. SP-1 is not scheduled to touch a store/codec module;
  if implementation necessity does, that touched module must leave the parent
  plan's four anti-slop type rules at zero and keep JSON boundaries as
  `JsonValue`/JSON-comparable durable aliases.
- **Module depth:** the optional new lock module is allowed only if it owns a
  coherent acquisition/invariant responsibility and reduces concepts in
  `locks.ts`; a file split that leaves pass-through calls or duplicated lock
  knowledge is rejected even if it improves the size number.

The accepted delta is one complete normal-entry operation and one borrowed-lock
route, while deleting the Adapter-owned selector decision. Everything else is
either made private or deferred to its already-named slice.

## 8. Requirement challenges

| Requirement | Complexity cost | Evidence | SP-1 decision |
|---|---|---|---|
| Make every observation of absent state mutate immediately | Turns raw reads/diagnostics into lock-taking writers and activates incomplete SQLite paths | 262 v2 assigns the global default flip to SP-3 | reject for SP-1; admit only through foreground and daemon healthy held-mutex entries |
| Reuse `withStatePlaneLocks` unchanged | Reacquires the caller's mutex and recursively reaches the selector through full state inventory | CODEX-262-A #1 and `locks.ts`' current inventory call | reject; share a private lock runner with reset-only genesis inventory |
| Pass a no-op migration driver to `establishStateAuthority` | Keeps migration dispatch reachable from ordinary sync and makes a fake port a safety invariant | coordinator's current signature and SP-4 retirement goal | reject; one genesis-only operation |
| Add any track admission in SP-1 | Extends track's locks and failure surface, can trigger JSON reset recovery, and requires config-parent durability before config becomes genesis evidence | design 262 assigns the default flip/cutover to SP-3; R1A#4/R1B#2 | cut entirely; SP-3 receives the `.rbox` fsync prerequisite in the parent-plan note |
| Treat `GenesisOutcome.established` as authority proof | Skips the durable bytes that are the actual authority and misses `legacy-present`/race outcomes | CODEX-262-A requires re-selection | reject; always re-select under the remaining fences |
| Add an intent check to legacy JSON publication now | Changes JSON behavior and spreads SP-2/SP-3 policy into SP-1 | genesis already preserves a raced `L`; JSON remains supported | reject; preserve the existing legacy writer |
| Skip intent reads for settled JSON | Saves one file existence check but strands `json + intent` after case-5 interruption | R1A#2 and `genesis.ts:67/113/205` | reject; intent-first dispatch for every format and accept the measured settled-JSON read cost |

No requirement is silently removed. The held-mutex-only boundary is deliberate
rollout containment, not a permanent second mode; SP-3 owns its deletion when
the default flips.

## 9. Non-goals and deletion ruling

- **No default flip.** SP-1 does not change held-mutex-less/raw/direct-save
  `absent -> legacy-json-store` selection and does not declare SQLite ready for
  every live behavior. The foreground and daemon admission families are the
  recovery primitive SP-3 will later make universal.
- **No JSON refusal.** Existing JSON workspaces continue to run. No new copy,
  doctor row, exit code, or start-fresh instruction lands here. The only JSON
  delta is the held-mutex path's bounded intent check required for recovery.
- **No migration/default retirement.** The automatic upgrade window, `rbox
  migrate`, retry/abort, migration controls, legacy store, and all readiness
  paths remain.
- **No deletion.** SP-1 deletes no command, export, module, test, durable
  format, compatibility arm, guard, or documentation. There are no safe
  deletion candidates in this slice; SP-4 owns the closure-complete proof.
- No SP-2 ports of telemetry binding, degraded-mutex writes, or reset/rebind.
- No track admission, 1.x/candidate co-use policy, or founder fleet cutover;
  those are SP-3.
- No genesis record/schema/phase-order change, no new durable artifact, no
  background queue, flag, mode, fallback store, or kill switch. The new
  publication-boundary ownership recheck strengthens the existing step-7 gate.
- No wire/API, D1, remote workspace, encryption, Git, scan, or watcher change.

SP-1 therefore adds one missing operation and one missing lock route. It does
not claim the state plane is finished; it makes finishing and recovering
genesis possible while preserving the JSON authority semantics that still
carry the fleet and accounting honestly for both their extra intent read and
their cold selector-import cost.
