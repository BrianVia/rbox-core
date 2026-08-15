# 264 — SQLite behavior ports: telemetry binding and degraded saves

Status: ALIGNED v4 (round-3 fail-closed fold, self-certified per the
post-cap step-out rule: the R3 blocker's mechanism was eliminated rather
than repaired — degraded-on-Q saves refuse instead of persisting, which
removes the racing writer as a class; the PR's adversarial review
re-verifies this ruling against code)

This is SP-2a of design 262 v2. It completes exactly two live behaviors for an
already-selected SQLite authority:

1. telemetry binding mint/reuse through the selected state Adapter; and
2. state-save progress when the state lock primitive itself reports
   `unsupported`.

It does not change the default authority, migrate a workspace, or port
reset/rebind. It does include the exclusion invariant between its new direct
SQLite save and the already-live SQLite reset recovery path. SP-2b/design 265
owns the reset/rebind behavior and inherits that invariant (§8); 264 has no
shipping dependency on 265.

Verified against `ffab16f9eee7` on 2026-08-15.

## Round history

- **v1:** combined telemetry, degraded saves, reset/rebind, authorized lineage
  replacement, and a durable mutation gate. CODEX-264-R1A and
  CODEX-264-R1B both returned CHANGES-REQUIRED. They found a renamed rather
  than eliminated `forceLegacy` mechanism, an impossible parity matrix,
  incomplete caller and crash inventories, JSON behavior drift, unapproved
  deletion, scope overreach, and incomplete reset contracts.
- **v2:** applies the orchestrator's structural split. Reset/rebind and its
  exclusion machinery move to 265. This design eliminates only `forceLegacy`,
  makes the state-lock outcome the sole degraded-save decision, preserves all
  other legacy/compatibility mechanisms, restores JSON neutrality, and pins
  the remaining callers, matrices, suites, and acceptance order.
- **v3:** folds CODEX-264-R2. The direct SQLite path now shares
  `state.db.lock` with live reset recovery, with a non-nesting lock rule and a
  reset-race acceptance test; the inventory covers every production
  `applyStateSavePacket` edge and pins the four omitted suite counts; the
  acceptance order is executable; and the 265 handoff restores the explicit
  stage/refusal/witness table requirement.

## 1. Scope and protected-functionality ledger

| Protected contract | Owner after 264 | Evidence |
|---|---|---|
| Durable authority selection remains the only backend choice. Exact `Q` selects SQLite; JSON/absent/foreign behavior remains design 263's law. JSON-only execution does not evaluate `bun:sqlite`, and no unselected database is opened | authority coordinator and `whole-state-compat.ts` | import/open sentinels and authority-selection suites |
| Telemetry still returns `{ state, bindingId }`, mints one lowercase 16-hex ID from eight random bytes, reuses it, rejects mismatch/absence, preserves reporter caching/envelope/retry/failure swallowing, and changes no sync revision/generation | selected Adapter; JSON and SQLite physical owners | §4.1 and §6 |
| A save's persistence path is decided only by `acquireLock(stateLockPath(root))` at the selected Adapter: acquired uses ordinary CAS, `unsupported` may use the backend's existing/native fallback, held/error/lost ownership refuses | selected Adapter | §3 and §4.2 |
| JSON workspaces retain byte/behavior neutrality except for the explicitly approved removal of caller-forced legacy projection. Actual lock-unsupported JSON saves retain their current fallback; published-journal lock-unsupported JSON retains its current refusal/defer behavior | legacy JSON owner and current `sync-state.ts` policy | pre-change goldens and §4.2 |
| SQLite lock-unsupported saves apply the same packet and CAS predicates as healthy-lock SQLite saves, atomically, without the hardlink-backed sealed-stage path, without publishing JSON, and without dropping capable metadata/generations. Before any direct effect they acquire and validate the same `.rbox/state/state.db.lock` used by live SQLite reset recovery, so candidate replacement cannot discard an accepted transaction | SQLite packet owner; existing reset recovery remains the peer lock user | healthy-vs-unsupported SQLite differential matrix and reset-recovery race test |
| `allowLegacyStreamReplacement` and its authorization remain exactly as today. No missing mutex argument is reinterpreted as authority, and track/scope callers remain unauthorized | `sync-state.ts` and the six callers in §3.1 | call-site/negative inventory |
| Published-intent recovery retains `landed | already-semantic | superseded`, three bounded recomputes, generation predicates, and journal residue. JSON's unsupported row does not become a successful whole-state write | `savePublishedRepoIntent` | published-intent matrix |
| Commands, outputs, wire shapes, state/reset formats, migration/genesis/readiness paths, healthy-lock fast paths, Git semantics, scans, watchers, and daemon scheduling do not change | existing owners | preserved suites |

The only approved deletion is the caller-selected `forceLegacy` concept: both
option fields, both branches, the four production arguments, and tests whose
only purpose is selecting that mode. Its removal is ordered after parity is
green (§7.1). This approval does not cover another legacy helper, option,
branch, sidecar, format, export, or test.

## 2. Ownership and Interfaces

### 2.1 Selected behavior Adapter

`state-plane/adapters/whole-state-compat.ts` remains the one selector-facing
Adapter. It gains telemetry as one complete operation and owns the state-lock
outcome for save packets:

```ts
export async function ensureTelemetryBindingId(
  root: string,
  expectedStream: string,
  randomBytes?: (size: number) => Buffer,
): Promise<{ state: SyncState; bindingId: string }>;

export async function applyStateSavePacket(
  root: string,
  packet: StateSavePacket,
  options?: StateSaveOptions,
): Promise<StateSaveResult>;
```

There is no backend enum, behavior port object, plan, receipt, caller-selected
legacy/degraded parameter, mutex-derived save mode, or optional owner token.
The public telemetry export/result and save result vocabulary remain stable.
Dynamic SQLite imports remain behind exact authority selection.

The implementation PR updates the CODEMAP line for
`whole-state-compat.ts`: it owns selected whole-state reads, packet mutation,
and telemetry binding dispatch; it must never own caller sync policy, JSON/SQL
encoding, or reset/rebind.

### 2.2 Telemetry binding

The JSON branch delegates to `legacy-json-store.ensureTelemetryBindingId`
without semantic or byte changes.

The exact-`Q` branch performs one bounded operation:

```text
acquire state.json.lock
  -> assertAuthorityWritable(root) once
  -> re-select exact Q under the lock
  -> open and authority-bind one writable store
  -> BEGIN IMMEDIATE
  -> check live stream; reuse or mint the singleton
  -> recheck lock ownership immediately before COMMIT
  -> COMMIT
  -> materialize returned state on the same connection
  -> close writer
  -> release lock
```

The existing store singleton accepts the deterministic random source and an
authenticated owner token. It updates only
`state_lineage.telemetry_binding_id`; it never bumps `stateRevision`, BASE or
repository generations, local revision, or repository rows. Existing valid
binding wins over the random source. Stream mismatch uses the existing public
wording and rolls back.

`held`, `error`, `unsupported`, or ownership loss all fail telemetry exactly
as the corresponding JSON lock failure does. Telemetry has no degraded path.
`SyncStateReporter` still catches the failure and sends nothing; it uploads
only after the selected operation has closed its writer.

### 2.3 Lock-unsupported SQLite save

`applyStateSavePacket` first selects authority, then owns this total lock
outcome table:

| State-lock result | JSON authority | exact-`Q` authority |
|---|---|---|
| acquired | current JSON generation-CAS | current owner-token sealed-stage CAS |
| unsupported | current `unsupported` result; `saveStateSource` may use its existing legacy fallback, while published-intent recovery refuses | hardlink-free native SQLite CAS below |
| held | existing `busy`; no fallback | existing `busy`; no fallback |
| error | existing failure/busy translation; no fallback | same public failure class; no fallback |
| acquired then owner lost | `owner-lost`; no fallback | rollback/`owner-lost`; no fallback |

The SQLite `unsupported` arm is internal and reachable only from that exact
lock result. `sqlite-state-save.ts` owns both complete packet-ingestion forms:

```ts
export async function applySavePacketToStore(
  store: StateStoreHandle,
  packet: StateSavePacket,
  ownerToken: OwnedLockCasToken,
): Promise<CasResult>;

// (deleted in v4 — no second operation exists)
```

**v4 R3-fold (fail-closed ruling, orchestrator, post-cap step-out):** the
round-3 review proved the direct lock-unsupported persistence path
unimplementable as specified (the transaction operation cannot recheck a
DB lock only the Adapter holds; an owner capability was rejected; lease
loss was untested). Rather than add capability machinery, the state is
ELIMINATED: **on a SQLite-authority (`Q`) workspace, a save whose
workspace-mutex outcome is `unsupported` (or whose held mutex loses
validation) REFUSES** with the existing typed degraded-refusal taxonomy —
retryable, no store opened, no bytes written. Only a process holding a
validated workspace mutex ever writes the SQLite store, so the reset-race
class disappears structurally: reset recovery's `state.db.lock` + rename
can never overlap a writer that, by definition, does not exist without the
mutex. No lock-ordering rule, no lease-loss injection, no second CAS
driver.

Population impact today: zero (no `Q` workspaces exist in the field; JSON
degraded saves continue unchanged until SP-4). Standing limitation with an
owner: **rbox SQLite-authority workspaces require lock-capable
filesystems.** SP-3's design MUST surface this as a product boundary —
genesis itself should refuse on a lock-unsupported root (do not create a
workspace that cannot save), with telemetry naming any occurrence. The
founder sees this boundary in the SP-3 review.

The ordinary owner-token path is unchanged: both owner checks and its
sealed artifacts retained; shared predicates may move behind private
functions in `write-packet.ts` / `cas-steps.ts`.

### 2.4 `forceLegacy` elimination and preserved compatibility inventory

After §7.1 step 1 is green, remove:

- `forceLegacy` from `saveStateSource`'s options and its early whole-state arm;
- `forceLegacy` from `savePublishedRepoIntent` and its whole-state merge arm;
- the one pull and three push `forceLegacy` arguments; and
- tests that call the option as a mode, replacing them with characterized
  goldens and real lock-outcome fixtures.

Do not rename or reconstruct it as `degraded`, `legacy`, `unlocked`, a mutex
field, a packet bit, a store option, or a second caller-selected operation.
Workspace-mutex degradation still disables the config lane and remains
diagnostic evidence; it has no state-persistence authority. The later state
lock outcome alone chooses the save mechanism.

SP-4 inventory, listed and **not deleted by 264**:

- `allowLegacyStreamReplacement` (option, branch, and four caller expressions);
- `legacyState`, `saveStateUnsafeLegacyOrTest`, and the JSON
  `StateSaveResult.unsupported` fallback;
- legacy sidecar projections and their caps;
- the JSON adapter/format, migration/genesis compatibility paths, witness and
  reserve machinery, commands, exports, tests, guards, and documentation.

## 3. Complete save-call inventory

### 3.1 `saveStateSource`: six production callers

| Caller | Current authorization/options | 264 disposition |
|---|---|---|
| `sync/pull.ts:447-480` | derives `allowLegacyStreamReplacement` from absent `deps.syncMutex` plus private state provenance; passes `forceLegacy` from workspace degradation | remove only `forceLegacy`; preserve the authorization expression and config-lane degradation |
| `sync/push.ts:560-569` observation save | same | same |
| `sync/push.ts:600-609` carry-on-no-op save | same | same |
| `sync/push.ts:919-931` acknowledgement save | same | same |
| `track-cmd.ts:59` rollback save | holds a workspace mutex but passes no options and is not replacement-authorized | unchanged; omission must remain unauthorized |
| `scope/scope-transaction.ts:202` scope-prune save | enclosing operation holds a workspace mutex but passes no options and is not replacement-authorized | unchanged; omission must remain unauthorized |

`saveStateSource` does not derive replacement authorization from a missing
mutex parameter. The existing explicit `allowLegacyStreamReplacement` value
is preserved until SP-4. Track and scope get negative tests proving the 264
signature edit cannot widen their stream-rejection path.

### 3.2 Published intent

The sole production call is `sync-git/follow-journal.ts:64`; it passes no
options. Removing the unused `forceLegacy` option does not alter it. In
particular, JSON + state-lock `unsupported` still throws
`sync state transactional save unsupported`, leaves the published journal
unlanded, and changes no state bytes. Exact `Q` + `unsupported` may complete
through native SQLite CAS and is compared with healthy-lock SQLite, not with a
fictional successful JSON fallback.

### 3.3 Direct `applyStateSavePacket`: six production edges

These edges call the changed behavior port without going through
`saveStateSource` or `savePublishedRepoIntent`; all therefore participate in
the total lock-outcome and reset-exclusion contract.

| Production edge | Current role | 264 disposition |
|---|---|---|
| `state-plane/adapters/whole-state-compat.ts:159` | capable-lineage initialization | preserve genesis-only admission and raced-winner handling; literal SQLite lock-unsupported uses the direct path under `state.db.lock` |
| `sync/pull.ts:170` | resolution-receipt completion | preserve exact/non-exact receipt clearing and failure residue; direct acceptance must return the same installed packet as healthy SQLite |
| `sync-git/held-skip.ts:406` | held-attempt persistence | preserve whole-packet CAS and post-save reload; held/error/DB-lock refusal cannot partially replace attempts |
| `sync-git/p-repair-state.ts:93,163` | receipt-only and BASE-changing P-repair writes | preserve both writes, their injected `stateSaveOptions`, proofs, and accepted/rejected vocabulary; no direct path may bypass proof admission |
| `sync-git/p-settlement.ts:145` | post-ref-commit P settlement | preserve the protocol-lock class and mutation-gate boundary; a save refusal remains a settlement hold/error rather than an untracked state effect |
| `sync/push.ts:804` | keep-mine receipt arming | preserve durable-arm-immediately-before-POST ordering; only an accepted direct transaction may authorize the POST |

## 4. Differential and crash matrices

### 4.1 Telemetry binding — 14 pinned cells

Every applicable cell runs through the public operation over paired logical
JSON/exact-`Q` fixtures.

| ID | Boundary/input | Required result |
|---:|---|---|
| T1 | valid existing binding | reuse it; zero document/row write |
| T2 | missing binding + deterministic eight bytes | same 16-hex ID returned and persisted; only binding changes |
| T3 | second process/different random source | reuse winner |
| T4 | concurrent first mint | one durable winner; both later loads agree |
| T5 | expected stream mismatch | same public failure; byte/row/digest-identical; no upload |
| T6 | absent JSON state | current refusal; no state manufactured |
| T7 | exact `Q` with missing/foreign/mismatched DB | typed authority corruption before mutation |
| T8 | lock held/error/unsupported | existing failure class; no telemetry fallback or upload |
| T9 | owner loss after `BEGIN IMMEDIATE` | rollback; no binding or upload |
| T10 | throw/crash before COMMIT | old binding state; retry mints/reuses once |
| T11 | after COMMIT but before materialization/close | binding remains durable; no partial state and no upload; retry reuses the same ID |
| T12 | after close but before reporter upload | binding remains durable; no upload occurred; retry reuses the same ID before uploading |
| T13 | reporter upload fails or non-202 | binding remains durable; existing failure counter/log cadence and retry behavior |
| T14 | JSON lazy-import/format check | complete JSON tree matches golden; SQLite runtime was not evaluated |

T11 and T12 are distinct injection boundaries. The test seam records commit,
materialization, close, and transport-call order rather than inferring it from
the final ID.

### 4.2 Degraded saves — consistent three-oracle matrix

The old design incorrectly demanded byte-identical legacy JSON while also
demanding SQLite retain fields the legacy projection deletes. This design uses three
separate oracles:

1. **Deleted-mode characterization.** Before deletion, capture the exact
   `forceLegacy` JSON result: `manifestMeta`, `stateNonce`, `stateRevision`, and
   `repoRecords` are absent; reconstruction assigns legacy repositories
   `repoGen: 0`; the complete JSON tree is golden. This proves what is being
   retired; it is not the SQLite expected result.
2. **Native SQLite equivalence.** For the same `StateSavePacket`, exact-`Q`
   lock-unsupported CAS must equal healthy-lock SQLite CAS in accepted/rejected
   status, materialized state, manifest metadata, semantic digest, lineage and
   repository generations, BASE proofs, rows, callbacks, and recompute result.
   Only sealed filesystem stages and the external owner token differ.
3. **Approved post-removal behavior.** Callers no longer force the legacy
   projection because the workspace mutex degraded. If the later state lock is
   acquired, both authorities use ordinary CAS. If that lock is unsupported,
   JSON keeps its current actual-unsupported fallback while SQLite keeps its
   capable metadata and generations. Those representation/legacy-loss
   differences are explicit and are never asserted equal.

| ID | Scenario | JSON required | exact-`Q` required |
|---:|---|---|---|
| D1 | degraded workspace mutex; state lock acquired | ordinary JSON CAS; no forced projection | ordinary owner-token SQLite CAS |
| D2 | state lock identity-unsupported | current legacy fallback and exact byte golden | hardlink-free native CAS equal to healthy SQLite oracle |
| D3 | state lock hardlink-unsupported | same as D2 | same as D2; `fs.linkSync`/stage sentinels untouched |
| D4 | pull global + repository packet | current lock-derived JSON result | same native SQLite result as healthy lock; config lane remains disabled from workspace degradation |
| D5 | push observation packet | current lock-derived JSON result and callbacks | same native SQLite result/callback state as healthy lock |
| D6 | push repo-only carry packet | no unintended global advance | same, with no BASE/global generation advance |
| D7 | push acknowledgement packet | current transition semantics | same native SQLite transition as healthy lock |
| D8 | published journal; lock acquired | current `landed/already-semantic/superseded` | same disposition and semantic transition |
| D9 | published journal; lock unsupported | current refusal/defer; state bytes and journal residue unchanged | same disposition/state as healthy-lock SQLite; idempotent replay |
| D10 | global/repository generation drift | current bounded recompute | transaction-snapshot rejection and same legal serialized result as healthy SQLite |
| D11 | two lock-unsupported SQLite writers | n/a | SQLite serializes; busy or stale/recompute; no partial/lost accepted effect |
| D12 | lock held | busy/refusal; no fallback | busy/refusal; no direct transaction |
| D13 | lock error | failure; no fallback | failure; no direct transaction |
| D14 | acquired lock loses ownership | owner-lost; no fallback | rollback/owner-lost; no direct fallback |
| D15 | exact `Q` with throwing JSON writer | n/a | all rows avoid the writer; marker bytes unchanged |
| D16 | throw/crash before, during, and after COMMIT | JSON atomic-write law unchanged | rollback or one complete packet; reopen/retry converges |
| D17 | stream/nonce/BASE-proof refusal | current terminal/refusal result | same result as healthy-lock SQLite and zero row subset |
| D18 | TEMP/size/proof admission failure | n/a | refuse before durable row change; no filesystem stage or TEMP residue after close |
| D19 (v4: replaced — degraded-on-Q saves REFUSE; the test drives an unsupported-mutex save against a Q workspace concurrently with reset recovery and asserts refusal + zero store mutation + recovery completes) | reset recovery races a degraded-process direct save | n/a | both contend on `state.db.lock`: a save that sees a standing/non-steady reset refuses, while a save that follows completed replacement reselects and CASes the installed DB; every returned `accepted` packet remains present after both processes finish, with no candidate rename losing it |

Cross-format comparisons cover only shared logical fields where both current
formats represent them. `manifestMeta`, capable nonce/revision, `repoRecords`,
and repository generations are checked against the format's own oracle, never
against legacy projection loss.

## 5. Simplification and change ledger

| Concept/owner | Before | After 264 |
|---|---|---|
| caller-selected `forceLegacy` | two option fields, two branches, four production arguments | zero |
| caller-selected successor save modes | none | none; structural gate enforces zero |
| state-persistence decision inputs | workspace degradation can bypass CAS before authority selection | selected authority + actual state-lock outcome at one Adapter |
| SQLite packet ingestion | sealed/hardlink path only | sealed owner-token path plus one internal connection-TEMP path for literal `unsupported` |
| durable arbitration files/schemas | none for this behavior | none added |
| telemetry physical implementations | JSON and SQLite, but public caller reaches JSON only | same two owners behind one selected operation |
| reset/rebind concepts in 264 | reset port, replacement transaction, mutation gate, recovery lock order | reset behavior remains in 265; 264 owns only the direct-save exclusion invariant by reusing live recovery's `state.db.lock` and forbidding nested state-lock acquisition |

The necessary physical seam is two complete SQLite ingestion operations, not a
boolean inside one operation. Removing it would either forge the external-lock
owner token or reuse hardlinks on the filesystems where the path must work.
Shared durable CAS steps have one owner; callers and Adapters do not duplicate
them.

Measured production baselines at `ffab16f9eee7` (nonblank lines / bytes):

| Module | Baseline | Acceptance |
|---|---:|---|
| `whole-state-compat.ts` | 268 / 12,134 | selected telemetry and one lock-outcome branch only; hard 400 / 25,600 |
| `sqlite-state-save.ts` | 140 / 5,081 | owns both packet-ingestion operations; hard 400 / 25,600 |
| `write-packet.ts` | 307 / 14,761 | shared transaction control and telemetry; hard 400 / 25,600 |
| `cas-steps.ts` | 319 / 18,492 | shared predicates/steps; hard 400 / 25,600; existing chained cast is fixed, not copied |
| `sync-state.ts` | 599 / 31,483 | must shrink; both landed metrics below baseline |
| `sync/pull.ts` | 511 / 27,738 | remove one argument; no growth |
| `sync/push.ts` | 947 / 50,118 | remove three arguments; no growth |
| `telemetry/sync-state.ts` | 101 / 5,193 | import reroute only; at or below baseline + 5 nonblank |
| `legacy-json-store.ts` | 392 / 19,995 | behavior-neutral and no growth |

No file split is accepted merely to satisfy a line gate. Any ownership change
under the sync/state-plane trees updates CODEMAP in the same implementation.

## 6. Test and suite disposition ledger

Counts are pinned at `ffab16f9eee7`. A count is the number Bun reports for the
file; no existing case may disappear. Parameterized additions must also pin
their expanded row count.

### 6.1 Core suites — 105 existing tests

| Suite | Baseline | Disposition |
|---|---:|---|
| `telemetry/sync-state.test.ts` | 7 | **amend** to all T1–T14 public-operation cells; preserve exact JSON bytes, summary/envelope, heartbeat, kill switch, failure swallowing, and no-network-on-binding-failure |
| `state-plane/store/cas-operations.test.ts` | 21 | **amend** for deterministic telemetry, owner-loss/precommit checks, row diff, and healthy-vs-lock-unsupported SQLite CAS over D2–D3/D10–D19 |
| `state-plane/adapters/whole-state-compat.test.ts` | 27 | **amend** for selected telemetry, total lock outcome, fence/reselection/open/close order, lazy import, and JSON-writer sentinels |
| `sync-state.test.ts` | 31 | **amend** for the ordered deletion, six-caller authorization guard, D1–D14, published-journal JSON refusal, and preserved three-recompute behavior |
| `manifest-meta.test.ts` | 7 | **amend** the one caller-mode row into deleted-mode characterization plus native SQLite retention; preserve the other six |
| `sync-mutex.test.ts` | 12 | **preserve**; workspace degradation still owns config-lane/diagnostic behavior and gains no persistence capability |

The focused six-file run currently reports 105 passing together. An isolated
`cas-operations.test.ts` run reproduced its known unchanged heap-budget
baseline failure (20 pass, 1 fail; about 26.4 MiB growth against 16 MiB).
That baseline is not waived: the implementation must make the complete suite
green or separately re-baseline it with measured approval.

### 6.2 Structural and integration suites

| Suite/group | Baseline | Disposition |
|---|---:|---|
| `state-plane/inventory.test.ts` | 9 | **amend** exact write sites/guards, selected telemetry, direct SQLite reach, and zero `forceLegacy`; no reset inventory edit |
| `sync-git/base-composer-structure.test.ts` | 9 | **amend** exact call counts after only the two `forceLegacy` branches disappear; composer/proof ownership remains |
| `state-plane/duplicate-declarations.test.ts` | 4 | **amend** telemetry's two physical owners behind one Adapter; add no allowlist for a successor mode |
| `config-surface.test.ts` | 3 | **preserve public export set** while rerouting implementation; `config-surface.typecheck.ts` remains green |
| pull attribution/trusted-view + push guard/mass-delete + publisher-ack contract | 32 (1 + 5 + 6 + 3 + 17) | **preserve and run** across the four edited pull/push sites; add lock-outcome assertions without deleting cases |
| `sync-git/base-proof-authority.test.ts` | 13 | **preserve and run**; direct ingestion admits the same engine proof and published intent cannot mint authority |
| `sync-state-store.test.ts` | 5 | **amend** the selected write boundary for the literal-unsupported route; retain raw-save/load and lock behavior |
| `state-plane/store/write-differential.test.ts` | 4 | **amend** into the healthy-lock versus lock-unsupported SQLite oracle while preserving all JSON comparisons |
| `state-plane/store/reads-leave-the-store-at-rest.test.ts` | 6 | **amend** direct-write rows; every close still leaves the store at rest |
| `state-plane/authority-marker.test.ts` | 12 | **preserve and run**; exact `Q`, marker/DB equality, and marker bytes do not change |
| `sync-git/deferral-hygiene.test.ts` | 21 | **preserve and run**; its injected saves retain packet/result behavior |
| `sync-git/held-skip.test.ts` | 16 | **preserve and run**; the held-attempt production edge retains whole-packet CAS, reload, and refusal behavior under the total lock-outcome table |
| `sync-git/p-repair-state.test.ts` | 1 | **amend and run** across both P-repair writes; preserve receipt-only and BASE-changing proof admission and accepted/rejected behavior |
| `sync-git/p-settlement.test.ts` | 4 | **preserve and run**; direct-save exclusion cannot move the ref-commit/mutation-gate boundary or turn a refused state CAS into settlement |
| `sync/manifest-commit-executor.contract.test.ts` | 25 | **preserve and run**; receipt arming remains the durable effect immediately before POST, with all refusal and acknowledgement classifications unchanged |
| `state-plane/migration/reserve.test.ts` | 10 | **preserve and run**; reserve/witness and migration compatibility are not deleted |
| `sync-git/follow-matrix.test.ts` / `follow.test.ts` | 6 / 116 declared cases | **preserve**; targeted published-journal rows live in the unit/integration matrix above |
| `e2ee-sync.test.ts` / `git-config-sync.e2e.test.ts` | 55 / 11 | **preserve unchanged**; their existing `saveStateSource` calls gain no mode or authorization |
| owner-token typecheck, store schema inventory, file-size ratchet | compile / existing counts | **tighten**: no forgeable/optional token, no authority-store schema change, and actual landed file counts replace baselines |

No existing reset, reset-journal, reset-consent, reset-crash,
doctor/quarantine, activity, or path-warning case is removed or behavior-edited
by 264. The D19 cross-boundary test exercises live SQLite reset recovery from
the save-side acceptance matrix; the complete reset-suite disposition remains
with 265.

## 7. Ordered acceptance gates

### 7.1 Executable parity-before-elimination order

The parent plan's condition is a hard order, not a retrospective assertion:

1. **deleted-mode characterization plus native SQLite parity;** freeze the
   pre-change `forceLegacy` JSON byte/behavior goldens, including metadata and
   generation loss, all four call-site effects, and the published journal's
   actual no-option unsupported refusal. Implement selected telemetry and the
   internal lock-unsupported SQLite operation while the old option still
   exists; make T1–T14 and D2–D19 green against the format's own oracle. D1 is
   deliberately not a pre-removal gate because production callers still select
   the old mode in this phase.
2. **removal of fields, branches, and four arguments;** delete both
   `forceLegacy` fields, both branches, the one pull and three push arguments,
   and mode-only tests in one ordered change; add no successor mode.
3. **post-removal D1 and full regression/structural gates.** Make D1 green through
   the production entrypoints, then run every §6 suite, the rest of D1–D19,
   and all §7.2–§7.3 gates. Any red characterization, parity, concurrency,
   compatibility, or structural cell rejects the landed change.

### 7.2 Structural gates

- zero production `forceLegacy` identifiers;
- zero caller-selected `legacy`, `degraded`, `unlocked`, or backend parameter
  on `saveStateSource`, `savePublishedRepoIntent`,
  `applyStateSavePacket`, `StateSavePacket`, or either store operation;
- exactly one production edge from the selected Adapter's literal
  state-lock-`unsupported` arm to
  `applyLockUnsupportedSavePacketToStore`;
- `workspaceSyncMutexDegraded` remains usable for config-lane/diagnostic law
  but cannot select a state writer or packet shape;
- all six `saveStateSource` callers and all six direct
  `applyStateSavePacket` production edges are inventoried; track/scope
  omission is explicitly unauthorized; the six current production
  `allowLegacyStreamReplacement` occurrences remain;
- exactly one shared reset-exclusion lock path exists for direct SQLite save
  and SQLite reset recovery; neither state lock is acquired while the other is
  held, and D19 proves candidate replacement loses no accepted transaction;
- no JSON writer, hardlink/stage builder, optional/fake owner token, or
  post-transaction result reread is reachable from direct SQLite CAS;
- JSON's static/evaluated closure stays free of `bun:sqlite`; exact `Q` never
  republishes `.rbox/state.json`;
- no new durable file/schema, flag, mode, sidecar, queue, or kill switch; and
- touched store/codec/Adapter files end at zero new `any`, unknown
  alias/parameter, unsafe dictionary, chained/widen-then-assert escape, or
  suppression. Existing touched violations are simplified rather than copied.

### 7.3 Runtime, compatibility, and performance gates

- Run every suite/count in §6, `bun run typecheck`, and
  `bun run lint:affected`.
- Differentially snapshot full JSON trees and complete SQLite table dumps,
  semantic digests, revisions/generations, marker bytes, and sidecar residue.
- Crash/throw at every T and D boundary. Reopen through the public Adapter and
  prove one stable telemetry ID or one old/complete-new packet.
- Run D19 with barriers in both lock-winning orders and an accepted-result
  postcondition against the final active DB; a busy/refused save is legal, but
  an `accepted` result absent after recovery is a release blocker.
- Healthy telemetry uses one state-lock acquisition, one writer open, and one
  singleton transaction. Existing-binding reuse performs no update.
- Healthy-lock save retains its current open/stage/transaction counts. The
  unsupported path performs one writer transaction, no filesystem stage, and
  no whole-state JSON materialization. Record p50/p95 and open/read counts;
  any healthy-path regression or duplicate SQLite open blocks acceptance.
- Existing JSON workspaces, exact-`Q` authority bytes, migration/genesis
  controls, public errors/results, wire/API behavior, and supported runtimes
  remain compatible except for the explicitly approved caller-forced legacy
  projection removal after §7.1 is green.

## 8. Moved to SP-2b / design 265

The following left 264 in full and forms design 265's charter. It is not an
implementation appendix or optional follow-up to this design:

- the authority-selected reset/rebind begin operation, removal of raw
  `.rbox/state.json` reads from `reset-state.ts`, JSON-v2 versus SQLite-v1
  physical preparation, recovery dispatch, crash law, advisory-sidecar cleanup,
  and reset/rebind suite disposition;
- the two legacy-only journal-presence consumers identified by R1A#4:
  `resetSyncState`'s pre-preparation and post-initiation `readResetJournal`
  calls. Design 265 must replace them with format-neutral presence/recovery
  handling and cover both fresh SQLite initiation and re-entry over a prepared
  SQLite journal;
- R1A#5's state-lock lease rechecks for SQLite recovery: at minimum before the
  first reset mutation and immediately before candidate-to-active rename, with
  owner-loss injection at every durable/ref boundary;
- extension of 264's exclusion invariant to the future live reset begin and
  re-entry paths. Design 265 inherits `state.db.lock` as the shared physical
  exclusion owner and the rule that `state.json.lock` and `state.db.lock` are
  never nested in either direction; it may not make 264 depend on a later gate.
  If 265 proves a stable mutation gate necessary for additional reset stages,
  265 owns its schema, initialization/recovery law, inventory, CODEMAP entry,
  performance cost, and deletion condition without replacing 264's shippable
  recovery exclusion;
- the reset-provenance authorized stream/lineage replacement port. Until 265,
  264 preserves `allowLegacyStreamReplacement` and the existing JSON branch;
- R1B#5's consent-free truly empty-root genesis versus destructive bound-state
  consent rule;
- R1B#6's marker-only/no-state refusal behavior;
- R1B#7's explicit **stage × refusal × witness-reusable/consumed table**, with
  exact consent-consumption boundaries and every refusal classified as leaving
  the witness reusable or consumed;
- R1B#8's complete standing-journal/refusal/inventory matrix: pre-existing
  SQLite-v1 and JSON-v2, legacy-v1, malformed/J0, missing config, repository
  unavailable/replaced, preparation/checkout refusals, W1/W2/W3,
  missing-recovery-stream, lineage migration, final-state replacement, and all
  P/R/I/Z/ref residue; and
- the exact six-sidecar cleanup order/error semantics plus complete reset suite
  counts, including classifier/codec, five legacy phase crashes, ten byte-tree
  boundaries, four ref boundaries, two normalization cases, seventeen SQLite
  SIGKILL boundaries, ten direct recovery boundaries, quarantine/doctor,
  authority-marker/config/activity/path-warning, and entrypoint coverage.

## 9. Non-goals and deletion ruling

- No default flip, fleet cutover, migration retirement, JSON refusal, release,
  deployment, wire/API change, or authority/reset schema change.
- No reset/rebind product implementation; that is design 265. The only
  reset-facing addition is D19 coverage of the already-live recovery path's
  shared exclusion lock.
- No deletion beyond the approved `forceLegacy` mode after its ordered parity
  gate. Every other legacy-only candidate remains listed for SP-4, supported,
  and tested.

264 succeeds by deleting caller policy and deepening the existing state
boundary: telemetry selects its physical owner once, and a save reacts to the
actual state-lock outcome once, then direct SQLite persistence shares one
physical exclusion lock with reset recovery. It is rejected if the
implementation renames `forceLegacy`, widens another authorization, nests the
two state locks, loses an accepted transaction to reset replacement, adds
durable arbitration for the moved reset scope, changes JSON published-journal
behavior, or weakens the healthy SQLite owner-token path.
