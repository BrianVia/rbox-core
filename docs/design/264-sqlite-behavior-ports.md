# 264 — SQLite behavior ports: telemetry binding and degraded saves

Status: ALIGNED v5 (consistency reconciliation of the v4 ruling)

This is SP-2a of design 262 v2. It completes exactly two live behaviors for an
already-selected SQLite authority:

1. telemetry binding mint/reuse through the selected state Adapter; and
2. authority-specific state-save behavior when the state lock primitive is
   unavailable: JSON preserves its existing fallback, while exact `Q` refuses
   before opening or mutating the SQLite store.

It does not change the default authority, migrate a workspace, or port
reset/rebind. Because exact-`Q` lock-unavailable saves have no writer, this
slice adds no direct SQLite CAS and no save/reset exclusion mechanism.
SP-2b/design 265 owns reset/rebind (§8); 264 has no shipping dependency on 265.

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
- **v4:** the post-cap R3 fold eliminated the direct SQLite path: exact-`Q`
  saves fail closed when the save mutex is unsupported, held, erroneous, or
  no longer owned. No second CAS operation or reset-exclusion lock remains.
- **v5:** reconciles every older v2/v3 clause with that authoritative v4
  ruling. It changes no v4 behavior.

## 1. Scope and protected-functionality ledger

| Protected contract | Owner after 264 | Evidence |
|---|---|---|
| Durable authority selection remains the only backend choice. Exact `Q` selects SQLite; JSON/absent/foreign behavior remains design 263's law. JSON-only execution does not evaluate `bun:sqlite`, and no unselected database is opened | authority coordinator and `whole-state-compat.ts` | import/open sentinels and authority-selection suites |
| Telemetry still returns `{ state, bindingId }`, mints one lowercase 16-hex ID from eight random bytes, reuses it, rejects mismatch/absence, preserves reporter caching/envelope/retry/failure swallowing, and changes no sync revision/generation | selected Adapter; JSON and SQLite physical owners | §4.1 and §6 |
| A save's persistence path is decided only by the save-mutex outcome at the selected Adapter. Acquired and still-owned uses the authority's ordinary CAS. For exact `Q`, `unsupported`, held, error, or ownership loss is a typed retryable refusal before any store open or mutation; JSON retains its current unsupported fallback behavior | selected Adapter | §2.3 and §4.2 |
| JSON workspaces retain byte/behavior neutrality except for the explicitly approved removal of caller-forced legacy projection. Actual lock-unsupported JSON saves retain their current fallback; published-journal lock-unsupported JSON retains its current refusal/defer behavior | legacy JSON owner and current `sync-state.ts` policy | pre-change goldens and §4.2 |
| Exact-`Q` lock-unavailable saves never open SQLite, build a sealed stage, call a CAS operation, publish JSON, or mutate bytes. D19 races that refusal against live reset recovery and proves the absent writer cannot interfere with recovery | selected Adapter; existing reset recovery is unchanged | refusal/open/mutation sentinels and D19 |
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
| unsupported | current `unsupported` result; `saveStateSource` may use its existing legacy fallback, while published-intent recovery refuses | existing typed `unsupported` refusal; zero store opens/mutations |
| held | existing `busy`; no fallback | existing typed `busy` refusal; zero store opens/mutations |
| error | existing failure/busy translation; no fallback | same typed retryable refusal; zero store opens/mutations |
| ownership lost before write admission | current `owner-lost`; no fallback | typed retryable `busy` refusal with ownership-loss detail; zero store opens/mutations |

`sqlite-state-save.ts` continues to own exactly one packet-ingestion operation:

```ts
export async function applySavePacketToStore(
  store: StateStoreHandle,
  packet: StateSavePacket,
  ownerToken: OwnedLockCasToken,
): Promise<CasResult>;

```

**v4 R3-fold (fail-closed ruling, orchestrator, post-cap step-out):** the
round-3 review proved the direct lock-unsupported persistence path
unimplementable as specified (the transaction operation cannot recheck a
DB lock only the Adapter holds; an owner capability was rejected; lease
loss was untested). Rather than add capability machinery, the state is
ELIMINATED: **on a SQLite-authority (`Q`) workspace, a save whose
save-mutex outcome is `unsupported`, held, error, or ownership-lost
REFUSES** with the existing typed retryable-refusal taxonomy: no store is
opened and no bytes are written. Only a process holding a validated save
mutex may enter the existing owner-token SQLite writer. The reset-race class
therefore disappears structurally: a lock-unavailable save has no writer to
overlap reset recovery's candidate replacement. No reset-exclusion lock,
lock-ordering rule, direct-path lease-loss injection, or second CAS driver
exists.

Population impact today: zero (no `Q` workspaces exist in the field; JSON
degraded saves continue unchanged until SP-4). Standing limitation with an
owner: **rbox SQLite-authority workspaces require lock-capable
filesystems.** Making genesis refuse on a lock-unsupported root is explicitly
SP-3's boundary, not an SP-2 implementation change: SP-3 must refuse before
creating a workspace that cannot save and surface telemetry for any occurrence.

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
unlanded, and changes no state bytes. Exact `Q` + `unsupported` also refuses
with its existing typed retryable result, without opening or mutating the
store; it never falls through to JSON or to another SQLite operation.

### 3.3 Direct `applyStateSavePacket`: six production edges

These edges call the changed behavior port without going through
`saveStateSource` or `savePublishedRepoIntent`; all therefore participate in
the same total fail-closed exact-`Q` lock-outcome contract.

| Production edge | Current role | 264 disposition |
|---|---|---|
| `state-plane/adapters/whole-state-compat.ts:159` | capable-lineage initialization | preserve genesis-only admission and raced-winner handling; exact-`Q` lock-unavailable initialization refuses without opening the store. Refusing authority genesis on a lock-unsupported root remains SP-3 |
| `sync/pull.ts:170` | resolution-receipt completion | preserve exact/non-exact receipt clearing and failure residue; an exact-`Q` lock-unavailable refusal cannot clear the receipt or mutate state |
| `sync-git/held-skip.ts:406` | held-attempt persistence | preserve whole-packet CAS and post-save reload; held/error/DB-lock refusal cannot partially replace attempts |
| `sync-git/p-repair-state.ts:93,163` | receipt-only and BASE-changing P-repair writes | preserve both writes, their injected `stateSaveOptions`, proofs, and accepted/rejected vocabulary; lock-unavailable refusal cannot bypass proof admission or mutate state |
| `sync-git/p-settlement.ts:145` | post-ref-commit P settlement | preserve the protocol-lock class and mutation-gate boundary; a save refusal remains a settlement hold/error rather than an untracked state effect |
| `sync/push.ts:804` | keep-mine receipt arming | preserve durable-arm-immediately-before-POST ordering; only an accepted ordinary transaction may authorize the POST; lock-unavailable refusal never authorizes it |

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
2. **Healthy SQLite preservation.** For the same `StateSavePacket`, an
   acquired, still-owned exact-`Q` save retains the existing owner-token CAS
   result, materialized state, metadata, digest, generations, proofs, rows,
   callbacks, and recompute behavior. There is no second SQLite oracle.
3. **Approved post-removal behavior.** Callers no longer force the legacy
   projection because the workspace mutex degraded. If the later state lock is
   acquired, both authorities use ordinary CAS. If that lock is unsupported,
   JSON keeps its current actual-unsupported fallback while exact `Q` returns a
   typed retryable refusal before any store open or mutation. Those authority-
   specific results are explicit and are never asserted equal.

| ID | Scenario | JSON required | exact-`Q` required |
|---:|---|---|---|
| D1 | degraded workspace mutex; state lock acquired | ordinary JSON CAS; no forced projection | ordinary owner-token SQLite CAS |
| D2 | state lock identity-unsupported | current legacy fallback and exact byte golden | typed retryable refusal; zero store opens/mutations |
| D3 | state lock hardlink-unsupported | same as D2 | same refusal as D2; `fs.linkSync`, stage, and store-open sentinels untouched |
| D4 | pull global + repository packet | current lock-derived JSON result | ordinary healthy-lock result, or the D2/D3 refusal; config lane remains disabled from workspace degradation |
| D5 | push observation packet | current lock-derived JSON result and callbacks | ordinary healthy-lock result/callbacks, or refusal with no callback/state effect |
| D6 | push repo-only carry packet | no unintended global advance | ordinary healthy-lock result, or refusal with no BASE/global advance |
| D7 | push acknowledgement packet | current transition semantics | ordinary healthy-lock transition, or refusal with no acknowledgement mutation |
| D8 | published journal; lock acquired | current `landed/already-semantic/superseded` | same disposition and semantic transition |
| D9 | published journal; lock unsupported | current refusal/defer; state bytes and journal residue unchanged | typed retryable refusal; state/store and journal residue unchanged; retry after lock support is idempotent |
| D10 | global/repository generation drift | current bounded recompute | transaction-snapshot rejection and same legal serialized result as healthy SQLite |
| D11 | two lock-unsupported SQLite save attempts | n/a | both refuse before store open; no partial/lost effect |
| D12 | lock held | busy/refusal; no fallback | typed retryable refusal; zero store opens/mutations |
| D13 | lock error | failure; no fallback | typed retryable refusal; zero store opens/mutations |
| D14 | acquired lock loses ownership before write admission | current `owner-lost`; no fallback | typed retryable `busy` refusal with ownership-loss detail; zero store opens/mutations and no second operation |
| D15 | exact `Q` with throwing JSON writer | n/a | healthy and refused rows both avoid the JSON writer; marker bytes unchanged |
| D16 | healthy-lock throw/crash before, during, and after COMMIT | JSON atomic-write law unchanged | existing owner-token path rolls back or lands one complete packet; reopen/retry converges |
| D17 | stream/nonce/BASE-proof refusal | current terminal/refusal result | same result as healthy-lock SQLite and zero row subset |
| D18 | TEMP/size/proof admission failure | n/a | refuse before durable row change; no filesystem stage or TEMP residue after close |
| D19 | reset recovery races an unsupported-mutex save against exact `Q` | n/a | save returns the typed retryable refusal with zero store opens/mutations; reset recovery completes; no accepted save or second CAS exists |

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
| SQLite packet ingestion | sealed/hardlink owner-token path only | unchanged; lock-unavailable outcomes never enter it |
| durable arbitration files/schemas | none for this behavior | none added |
| telemetry physical implementations | JSON and SQLite, but public caller reaches JSON only | same two owners behind one selected operation |
| reset/rebind concepts in 264 | reset port, replacement transaction, mutation gate, recovery lock order | none added; reset behavior remains entirely in 265 and D19 proves the absent lock-unavailable writer cannot interfere with existing recovery |

There remains one complete SQLite ingestion operation, protected by the
existing owner token. The Adapter owns the fail-closed lock outcome and never
opens the store to emulate unsupported persistence. Shared durable CAS steps
remain private to their one owner; callers do not duplicate them.

Measured production baselines at `ffab16f9eee7` (nonblank lines / bytes):

| Module | Baseline | Acceptance |
|---|---:|---|
| `whole-state-compat.ts` | 268 / 12,134 | selected telemetry and one lock-outcome branch only; hard 400 / 25,600 |
| `sqlite-state-save.ts` | 140 / 5,081 | retains one packet-ingestion operation; no growth; hard 400 / 25,600 |
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

### 6.1 Core suites — 105 baseline / 125 landed tests

| Suite | Baseline | Landed | Disposition |
|---|---:|---:|---|
| `telemetry/sync-state.test.ts` | 7 | 15 | **amend** to all T1–T14 public-operation cells; preserve exact JSON bytes, summary/envelope, heartbeat, kill switch, failure swallowing, and no-network-on-binding-failure |
| `state-plane/store/cas-operations.test.ts` | 21 | 22 | **amend** for deterministic telemetry and preservation of the one healthy owner-token CAS; lock-unavailable refusal is Adapter-owned and never reaches this suite's store operation |
| `state-plane/adapters/whole-state-compat.test.ts` | 27 | 36 | **amend** for selected telemetry, total lock outcome, fence/reselection/open/close order, lazy import, and JSON-writer sentinels |
| `sync-state.test.ts` | 31 | 33 | **amend** for the ordered deletion, six-caller authorization guard, D1–D14, published-journal JSON refusal, and preserved three-recompute behavior |
| `manifest-meta.test.ts` | 7 | 7 | **amend** the one caller-mode row into deleted-mode characterization plus healthy SQLite retention and lock-unavailable refusal; preserve the other six |
| `sync-mutex.test.ts` | 12 | 12 | **preserve**; workspace degradation still owns config-lane/diagnostic behavior and gains no persistence capability |

The corrective focused six-file run reports 125 passing together. The isolated
`cas-operations.test.ts` run also reports 22 passing, including its heap-budget
gate; no baseline waiver or re-baseline is used.

### 6.2 Structural and integration suites

| Suite/group | Baseline | Disposition |
|---|---:|---|
| `state-plane/inventory.test.ts` | 9 | **amend** exact write sites/guards, selected telemetry, one SQLite packet operation, fail-closed unsupported reach, and zero `forceLegacy`; no reset inventory edit |
| `sync-git/base-composer-structure.test.ts` | 9 | **amend** exact call counts after only the two `forceLegacy` branches disappear; composer/proof ownership remains |
| `state-plane/duplicate-declarations.test.ts` | 4 | **amend** telemetry's two physical owners behind one Adapter; add no allowlist for a successor mode |
| `config-surface.test.ts` | 3 | **preserve public export set** while rerouting implementation; `config-surface.typecheck.ts` remains green |
| pull attribution/trusted-view + push guard/mass-delete + publisher-ack contract | 32 (1 + 5 + 6 + 3 + 17) | **preserve and run** across the four edited pull/push sites; add lock-outcome assertions without deleting cases |
| `sync-git/base-proof-authority.test.ts` | 13 | **preserve and run**; the ordinary ingestion path admits the same engine proof and published intent cannot mint authority |
| `sync-state-store.test.ts` | 5 (landed 6) | **amend** the selected write boundary for the literal-unsupported refusal; retain raw-save/load and lock behavior |
| `state-plane/store/write-differential.test.ts` | 4 (landed 5) | **amend** to preserve healthy authority-specific writes and prove exact-`Q` lock-unavailable refusal/zero-open while preserving all JSON comparisons |
| `state-plane/store/reads-leave-the-store-at-rest.test.ts` | 6 (landed 7) | **amend** refusal rows; every opened healthy store still closes at rest and refused saves open none |
| `state-plane/authority-marker.test.ts` | 12 | **preserve and run**; exact `Q`, marker/DB equality, and marker bytes do not change |
| `sync-git/deferral-hygiene.test.ts` | 21 | **preserve and run**; its injected saves retain packet/result behavior |
| `sync-git/held-skip.test.ts` | 16 | **preserve and run**; the held-attempt production edge retains whole-packet CAS, reload, and refusal behavior under the total lock-outcome table |
| `sync-git/p-repair-state.test.ts` | 1 | **amend and run** across both P-repair writes; preserve receipt-only and BASE-changing proof admission and accepted/rejected behavior |
| `sync-git/p-settlement.test.ts` | 4 | **preserve and run**; fail-closed save refusal cannot move the ref-commit/mutation-gate boundary or turn a refused state CAS into settlement |
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

1. **deleted-mode characterization plus selected telemetry and exact-`Q`
   fail-closed proof;** freeze the
   pre-change `forceLegacy` JSON byte/behavior goldens, including metadata and
   generation loss, all four call-site effects, and the published journal's
   actual no-option unsupported refusal. Implement selected telemetry while the
   old option still exists; make T1–T14, healthy SQLite preservation, and the
   D2–D19 refusal/open/mutation cells green. No second SQLite CAS operation is
   introduced. D1 is deliberately not a pre-removal gate because production
   callers still select the old mode in this phase.
2. **removal of fields, branches, and four arguments;** delete both
   `forceLegacy` fields, both branches, the one pull and three push arguments,
   and mode-only tests in one ordered change; add no successor mode.
3. **post-removal D1 and full regression/structural gates.** Make D1 green through
   the production entrypoints, then run every §6 suite, the rest of D1–D19,
   and all §7.2–§7.3 gates. Any red characterization, refusal, concurrency,
   compatibility, or structural cell rejects the landed change.

### 7.2 Structural gates

- zero production `forceLegacy` identifiers;
- zero caller-selected `legacy`, `degraded`, `unlocked`, or backend parameter
  on `saveStateSource`, `savePublishedRepoIntent`,
  `applyStateSavePacket`, `StateSavePacket`, or either store operation;
- zero declarations, imports, exports, or calls named
  `applyLockUnsupportedSavePacketToStore` (or any successor second CAS
  operation); the selected Adapter returns directly from exact-`Q`
  lock-unavailable outcomes before a store open;
- `workspaceSyncMutexDegraded` remains usable for config-lane/diagnostic law
  but cannot select a state writer or packet shape;
- all six `saveStateSource` callers and all six direct
  `applyStateSavePacket` production edges are inventoried; track/scope
  omission is explicitly unauthorized; the six current production
  `allowLegacyStreamReplacement` occurrences remain;
- no save-side reset-exclusion lock or `state.db.lock` edge is added; D19 proves
  the unsupported save refuses with zero store opens/mutations while existing
  reset recovery completes;
- no JSON writer, hardlink/stage builder, optional/fake owner token, or
  post-transaction result reread is reachable from the exact-`Q`
  lock-unavailable refusal;
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
- Crash/throw at every applicable T and healthy-write D boundary. Reopen
  through the public Adapter and prove one stable telemetry ID or one
  old/complete-new packet; every lock-unavailable exact-`Q` row instead proves
  the stable old image and zero opens/mutations.
- Run D19 with barriers that hold reset recovery at its existing boundaries
  while the unsupported-mutex save refuses; assert the refusal, zero store
  opens/mutations, and completed recovery. No accepted-save branch exists.
- Healthy telemetry uses one state-lock acquisition, one writer open, and one
  singleton transaction. Existing-binding reuse performs no update.
- Healthy-lock save retains its current open/stage/transaction counts. The
  exact-`Q` unsupported path performs zero store opens, writer transactions,
  filesystem stages, and whole-state JSON materializations. Record p50/p95 and
  open/read counts; any healthy-path regression or refused-path open blocks
  acceptance.
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
- any exclusion needed by future live reset begin and re-entry paths. Design
  264 adds no save-side `state.db.lock` acquisition because its unsupported
  exact-`Q` save has no writer. If 265 proves a stable mutation gate necessary
  for additional reset stages, 265 owns its schema, initialization/recovery
  law, inventory, CODEMAP entry, performance cost, and deletion condition;
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
  reset-facing addition is D19 coverage proving the absent unsupported-save
  writer cannot interfere with the already-live recovery path.
- No deletion beyond the approved `forceLegacy` mode after its ordered parity
  gate. Every other legacy-only candidate remains listed for SP-4, supported,
  and tested.

264 succeeds by deleting caller policy and deepening the existing state
boundary: telemetry selects its physical owner once, and a save reacts to the
actual state-lock outcome once. Exact `Q` enters its one existing owner-token
CAS only while the mutex is acquired and valid; every unavailable outcome
refuses before opening the store. It is rejected if the implementation renames
`forceLegacy`, widens another authorization, adds a second CAS or save-side
reset-exclusion mechanism, changes JSON published-journal behavior, or weakens
the healthy SQLite owner-token path.
