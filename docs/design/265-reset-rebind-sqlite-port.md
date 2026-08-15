# 265 — Reset/rebind through the selected state authority

Status: ALIGNED v4 — R3 confirmed all findings closed, no residuals (round history below)

Slice: SP-2b of design 262 v2.

Round history: v1 made SQLite reset reachable, proposed a root-occupancy
observation and one-use reset-effect permits, and included reset-lineage mode
retirement. `CODEX-265-R1A` and `CODEX-265-R1B` returned CHANGES-REQUIRED. v2
accepts every finding: consent again precedes every mutation; JSON no-state
behavior is byte/behavior neutral; SP-4 deletion is removed; ownership proof
moves inside each compound physical primitive at its actual syscall; the
owner-loss matrix tests that placement for JSON and SQLite; the refusal,
writable-open, suite, and size ledgers are complete; and the proposed
occupancy/permit/remote-context concepts are deleted.

`CODEX-265-R2` returned CHANGES-REQUIRED. v3 accepts both findings: the
syscall-adjacency contract and X matrix now cover E0 JSON genesis publication
and post-replacement last-writer witness publication, with both physical owners
included in the size ledger; and the missing-witness rule is qualified for the
consent-free E0 case.

Verified against `d2c2ef0db2a9ef167e8eb8e12ee3ae731798328f` on
2026-08-15. The SP-2 implementation baseline is `1ddcbea23`.

Depends on: 262 v2 (ordering/product rulings), 264 v5 (selected writes and
SP-4 inventory), 263 v4 (publication-order precedent), 138 v10 (consent and
LegacyV2 reset law), and 163/222 (SQLite reset/store law).

## 0. Yardstick

`resetSyncState` remains the complete-fence orchestrator but stops reading or
serializing a particular state format. The selected Adapter supplies state and
begins the authority-specific reset; `reset-journal.ts` supplies one
format-neutral standing-reset inventory/settlement boundary.

The order is intentionally the current order:

```text
read selected state + config, without mutation
  -> validate the complete consent tuple (or establish current no-state case)
  -> acquire healthy workspace mutex
  -> settle independently authorized standing reset/W1, then restart
  -> selected repository inventory + complete repository/state-lock fence
  -> recheck consent tuple, identities, state/config lineage, marker, barrier
  -> consume consent exactly once
  -> legacy-lineage and checkout/A/P/Z preparation
  -> authority-selected begin under canonical state lock
  -> release/reacquire the complete fence and settle
  -> remove the six old-binding sidecars in their existing order
```

No invalid, expired, replayed, missing where consent is required, or
tuple-mismatched witness may cause standing-reset recovery, W1 checkpointing,
directory creation, lock-file creation, reset-ref mutation, or any other
physical mutation.

Exact `Q` uses `.rbox/state.json.lock`, the lock ordinary selected writes use.
There is no mutation gate, new lock, durable record, schema, sidecar, mode,
plan, receipt, or backend enum. Doctor/quarantine keeps its existing explicit
operator authority and lock path.

## 1. Protected-functionality ledger

| Protected contract | Owner after 265 | Acceptance evidence |
|---|---|---|
| Consent inspection and full tuple validation precede **every** mutation, including standing reset and W1; D0 stays after the complete-fence rechecks | `reset-consent.ts`, `reset-state.ts` | §4 plus invalid/mismatch standing P/R/I/Z and W1 zero-effect fixtures |
| Current JSON no-state behavior is byte- and behavior-identical: an unselected DB, orphan reset candidate/archive, or inert reset temp does not become a new occupancy refusal | selected legacy Adapter and current genesis helper | E0/E7b full-tree, output, and residue differential |
| JSON reset remains LegacyV2 with identical bytes, P/R/I/Z rows, ref/phase order, archive/candidate names, marker law, crash convergence, and cleanup | legacy body inside `reset-journal.ts` | current 5 phase, 10 byte-tree, 4 ref, 2 normalization cases plus §6 |
| Exact `Q` uses the existing SQLiteV2 journal, authority/header/schema bindings, S0 and W1/W2/W3 laws, archive/candidate/marker/Z transitions, and 17-boundary crash grammar | bound SQLite reset owner | classifier/lifecycle/recovery/crash suites plus §6 |
| A `Q` workspace never parses `Q` or `.rbox/state.json` as JSON state | whole-state Adapter | P11/P12 and import/read sentinels |
| Standing JSON-v2/SQLite-v1 reset is recovered before fresh begin; legacy-v1, malformed/J0, missing/foreign stream, W2/W3, drift, or unlisted rows halt | format-neutral dispatcher | §5 |
| W1 is the only active-WAL takeover; consent is valid first, then every writable open/checkpoint requires the live canonical lock | SQLite lifecycle | B1 and O1/O2 |
| A stale reset owner cannot erase an accepted write: every physical owner validates the live lock at the actual rename/update-ref/unlink boundary | filesystem/ref owners | §2.2 and O/X matrices |
| Reset-authorized stream replacement works for JSON and SQLite behind the existing six-occurrence `allowLegacyStreamReplacement` authorization inventory | selected Adapter plus existing `saveStateSource` branch | L1-L8 and SP-4 structural inventory |
| Repository/checkout/A/P/K/Z refusals and safe-direction residue remain unchanged | existing Git protocol owners | P2/P5/P8 and existing reset-git suites |
| Six sidecars are removed sequentially only after completed recovery/genesis; only `ENOENT` is ignored | `reset-state.ts` | P9/P10 |
| Commands, copy, config-save ordering, wire/API, daemon halt, doctor/quarantine, migration/genesis readiness, normal save, and telemetry behavior are preserved | existing owners | §7 regression ledger |

No command, format, branch, fallback, export, test, compatibility path,
migration/readiness path, or performance fast path is approved for deletion.
In particular, every SP-4 item listed in §2.4 remains.

## 2. Ownership and Interfaces

### 2.1 `reset-journal.ts` is the format-neutral reset boundary

The only new public proof is an opaque fence observation. Root occupancy is
private reset-entry reasoning and has no public type or equality API.

```ts
declare const resetFenceObservationBrand: unique symbol;
export interface ResetFenceObservation {
  readonly [resetFenceObservationBrand]: true;
}

export interface ResetFenceInventory {
  settlement: "none" | "required";
  requests: readonly RepositoryProtocolFenceRequest[];
  observation: ResetFenceObservation;
}

export async function inspectResetFenceInventory(
  root: string,
  callerStream?: string,
): Promise<ResetFenceInventory>;

export async function settleStandingResetUnderHeldFence(
  root: string,
  callerStream: string | undefined,
  expected: ResetFenceObservation,
  heldStateLock: OwnedLock,
  hooks?: ResetJournalHooks,
): Promise<"none" | "complete">;

export async function settleStandingReset(
  root: string,
  heldMutex: WorkspaceSyncMutex,
  callerStream?: string,
  hooks?: ResetJournalHooks,
): Promise<"none" | "complete">;

export async function beginSelectedReset(
  root: string,
  nextStream: string,
  expectedOld: { stream: string; stateNonce: string },
  z: readonly ResetZEntry[],
  authorization: ResetJournalAuthorization,
  heldStateLock: OwnedLock,
  hooks?: ResetJournalHooks,
): Promise<{ recoveryStream: string }>;
```

The observation authenticates authority bytes/id, journal bytes or absence,
W row, Z/ref inventory, and normalized repository requests. The borrowed form
validates canonical lock path, protocol-fence coverage, current ownership, and
exact reinspection before dispatch; it never reacquires. The standalone form
validates the caller's healthy mutex, acquires the observed repository fence
and canonical state lock, then delegates. JSON absence and SQLite S0 return
`none`; JSON-v2/SQLite-v1 recover; W1 takes over; halt rows remain halts.

`beginSelectedReset` reselects authority under the held canonical lock. JSON
does a bounded exact read and requires expected stream/nonce before publishing
LegacyV2. Exact `Q` asserts the selected write fence and calls the existing
SQLite reset facade. Both return a total recovery stream. The two
`reset-state.ts` journal gates, two `locks.ts` legacy-reader decisions, and
`reset-lineage.ts` private presence lstat stop being authorities; the legacy
reader/export itself remains for compatibility.

### 2.2 The canonical `OwnedLock` reaches every physical mutation owner

v1's `ResetEffectAuthority`, `ResetEffectPermit`, `ResetPhysicalEffect`,
`authorizeNext`, and WeakMap protocol are removed. Dispatcher validation passes
the real canonical `OwnedLock` into the existing deep physical owners. A bare
object or an ordinary CAS token cannot satisfy these Interfaces; each owner
also checks `path.resolve(owner.path) === path.resolve(stateLockPath(root))`.

The publication invariant is design 263's wired order, at every rename:

```text
all awaited preparation and final evidence
  -> workspace-mutex ownership check where the operation borrows it
  -> canonical state-lock ownership check
  -> synchronous final source/row observation
  -> fs.rename(source, destination)
```

The final observation is literally adjacent to `fs.rename`. No await, hook,
trace read, callback, promise construction, logging, or other filesystem call
may occur between it and the rename. Validation in the caller of a compound
wrapper is not authority. The wrapper that issues the syscall owns the final
check.

| Physical owner | Required v3 change |
|---|---|
| `state-plane/reset/trace-fs.ts` | its production factory closes over `root` and the canonical `OwnedLock`; `atomicWrite`, `exactWrite`, `copyExact`, direct `rename`, and `remove` validate inside the primitive after tracing/preparation and at the real rename/unlink |
| `engine/fsutil.ts::writeFileAtomic` | add a synchronous pre-rename assertion slot executed after awaited `onStep("before-rename")` and immediately before final observation + `fs.rename`; every reset call supplies it |
| `reset-io.ts::boundedCopy` | same synchronous slot after streaming/fsync/hooks and before final observation + `fs.rename`; JSON and SQLite reset copies supply it |
| `legacy-json-publication.ts::publishWholeState` | retain its asynchronous format/owner preparation, and also pass the held canonical lock through the synchronous `writeFileAtomic` slot at the actual rename; E0 genesis supplies it |
| legacy `reset-journal.ts` writes/rename/unlink | carry the held lock to `writeFileAtomic`, `boundedCopy`, direct candidate replacement, journal/phase/marker publication, and cleanup; no outer-only check remains |
| `last-writer-witness.ts::recordLastWriterWitness` | accept the held canonical lock for reset publication and wire it through the synchronous `writeFileAtomic` slot after state sampling/serialization and at the actual witness rename; preserve best-effort post-publication semantics |
| `reset-z-runtime.ts` | after identity/ref reads, validate immediately before the actual `git update-ref` spawn; batched active-group deletion is one checked syscall |
| SQLite lifecycle/store | require the held lock at W1 open/checkpoint, active quiesce open/checkpoint, and seed create/checkpoint; synchronous DB writes recheck before first write and COMMIT |

`quiesceActiveDbForReset`, `recoverOrdinaryWalCrash`, and
`prepareEmptyResetDbSeed` therefore require the held canonical lock. A normal
fresh SQLite begin has **two** writable opens: (1) active DB quiescence and
(2) `createStateStore` for the temporary seed. Both, including both checkpoint
boundaries, are counted and rejected before open when ownership is absent.
Seed cleanup never disguises an authority failure.

Unlink/remove and Git effects use the same rule: finish awaited classification,
validate ownership synchronously in the physical owner, then invoke the actual
`fs.rm`/`unlink` or `git update-ref` process with no intervening await/hook.
Owner loss throws the existing typed state-lock refusal and leaves the last
classified durable row. Reacquisition always reinspects; no cached row grants
the next effect.

### 2.3 `reset-state.ts` keeps current consent and no-state ordering

1. Reject empty `nextStream`; read selected state and config without mutation.
   Exact `Q` uses a read-only selected snapshot/predecode here; W1/W2/W3 may
   be observed or halted but cannot checkpoint, normalize, or open writable.
2. Validate witness shape, freshness, one-use state, and exact
   root/old-stream/old-nonce/revision/next-stream tuple. If state/config is
   absent, a supplied witness refuses. **Nothing mutates before this finishes.**
3. Acquire/validate a non-degraded workspace mutex. Inspect standing reset; if
   settlement is required, settle and restart at step 1. Thus an older journal
   may mutate only after the fresh witness has proved valid.
4. Materialize selected state, derive repository requests, acquire the sorted
   repository fence and canonical state lock, and re-read the fence inventory.
5. Recheck repository identities, state/config tuple, barrier, and marker.
   Consume consent once for a bound root.
6. Run existing legacy-lineage and checkout/A/P/Z preparation, final selected
   lineage check, and `beginSelectedReset`.
7. Release/reacquire through `settleStandingReset`, then run the unchanged
   six-sidecar cleanup.

There is no `ResetRootOccupancyObservation` and no namespace-wide emptiness
rule. Consent-free eligibility remains exactly the current
`selected state === undefined && config === undefined` decision. Authority
corruption and standing journals retain their existing earlier refusals, but
unselected stores and inert reset residue do not become new reasons to refuse
JSON genesis. The current raw JSON block at `reset-state.ts:288-296` disappears;
authority-specific exact evidence moves into `beginSelectedReset`.

CODEMAP changes with implementation: `reset-state.ts` owns orchestration,
never encoding; `reset-journal.ts` owns format-neutral inventory/begin/settle;
`reset/recovery.ts` owns SQLite physical recovery under a passed canonical
lock; `trace-fs.ts`, `reset-io.ts`, `fsutil.ts`, and `reset-z-runtime.ts` own
their actual syscall-adjacent checks; `legacy-json-publication.ts` owns the E0
active-state publication check; `last-writer-witness.ts` owns the
post-replacement witness publication check; `whole-state-compat.ts` owns
selected replacement.

### 2.4 Reset-lineage replacement is ported, not retired

SP-2b adds SQLite replacement behind the **existing** authorization:

```ts
options: { apply?: typeof applyStateSavePacket;
           allowLegacyStreamReplacement?: boolean }
```

The option, its branch, and all four expressions (one pull, three push) remain
byte-for-byte as the caller policy boundary. Track and scope still omit it.
Inside the already-authorized stream-rejection branch, the selected Adapter
does this:

| Authority | Required behavior |
|---|---|
| JSON | current `legacyState` projection and `saveStateUnsafeLegacyOrTest`, including current lock-unsupported fallback and exact bytes |
| exact `Q` | acquire canonical state lock; recheck `.db` reset provenance and live stream/nonce/revision/seq-0 tuple; atomically replace stream and apply the packet through the existing sealed-stage/CAS machinery; preserve SQLite-only metadata/generations/proofs |

`sqlite-state-save.ts` remains the sole `StateSavePacket -> sealed stages ->
CasPacket` translator and is amended rather than duplicated. The SQLite
transaction rolls back on proof/generation/owner failure and rechecks owner
immediately before COMMIT. `stateWasStreamMismatch` remains both replacement
authorization evidence and files-first capture policy.

SP-4 inventory, **listed and not deleted here**:

- `allowLegacyStreamReplacement` option, branch, and four caller expressions;
- `legacyState`, `saveStateUnsafeLegacyOrTest`, and JSON
  `StateSaveResult.unsupported` fallback;
- legacy sidecar projections/caps, JSON Adapter/format, migration/genesis
  compatibility paths, witness/reserve machinery, commands, exports, tests,
  guards, and documentation.

## 3. Empty, bound, marker, and residue table

| ID | Initial observation | Required result |
|---:|---|---|
| E0 | selected state and config absent; witness absent | current consent-free JSON genesis and exact cleanup behavior |
| E1 | same, witness supplied | consent refusal; unconsumed; zero mutation |
| E2 | JSON state and/or config | exact witness; LegacyV2 reset |
| E3 | exact `Q` + healthy S0 and/or config | exact witness; SQLiteV2 reset; `Q` remains authority |
| E4 | JSON incarnation marker only | current synthesized lineage: no witness refuses; valid witness is consumed, then missing active JSON bytes refuse; never genesis |
| E5 | exact `Q` marker with absent/foreign/mismatched DB | typed authority corruption; witness unconsumed if observable before D0; no writable open |
| E6 | config only | exact witness and current config/lineage fence behavior; no consent-free path |
| E7a | standing journal with no usable recovery stream | current halt; no fresh genesis |
| E7b | no selected state/config/journal, but unselected DB, orphan candidate/archive, or inert reset temp exists | **current JSON no-state behavior exactly**: do not scan it into eligibility, do not add a refusal, and preserve its bytes/residue except effects current genesis/cleanup already performs |

E7b is a differential compatibility contract, not an endorsement of the
residue. Cleanup/retirement belongs to SP-4 or explicit product approval.

## 4. Normative witness/refusal table

“Reusable” means a valid unconsumed witness may retry if its tuple still
matches. “Unconsumed/unusable” means reset did not consume it, but it was
invalid, expired, replayed, or made stale. Every semicolon-separated injection
below is a separately named expanded test, not a hidden loop.

| Stage | Executable refusal injections | Effect before refusal | Witness |
|---|---|---|---|
| A0 | empty `nextStream` | none | reusable |
| A1 | invalid/non-narrowed shape; expired; replayed; wrong root; old stream; old nonce; revision; next stream | none, including standing P/R/I/Z and W1 | unconsumed/unusable |
| A2 | bound state without witness; config without witness; witness on no-state/config; JSON foreign state; malformed JSON; oversized JSON; corrupt/malformed incarnation state; Q marker/DB/application/schema/authority corruption | none | absent/reusable/unusable as applicable |
| B0 | workspace mutex acquire error; degraded mutex | no reset/Git effect | reusable |
| B1a | LegacyV1; malformed journal/codec/J0; missing recovery stream; foreign config stream; W2; W3; unlisted P/R/I/Z | none | reusable/stale |
| B1b, W1 | writer-open failure; incomplete lineage; marker/DB authority mismatch; expected stream; nonce; revision; pre-checkpoint hook; checkpoint; post-checkpoint hook; first S0 check; DB/parent fsync; final S0 or authority reread | checkpoint may have landed only for checkpoint/post-checkpoint/S0/fsync/final-reread failures; no fresh-reset effect | reusable/stale |
| B1c, standing recovery | repository missing; repository identity replacement; journal/authority/Z/ref/request-set drift; physical row becomes unlisted; every filesystem/ref error named in D7 | only the older journal's allowed classified prefix | reusable/stale |
| B2 | materialized BASE/origin repository unavailable | none from fresh reset | reusable |
| B3 | repository disappears; real/common-dir/identity hash changes under fence | none from fresh reset | reusable |
| B4 | canonical lock held; error; unsupported; wrong path; owner lost | none from fresh reset | reusable |
| C0 | fenced stream; nonce; revision/config mismatch | none from fresh reset | reusable/stale |
| C1 | barrier changes state or config | none | reusable |
| C2 | stale marker; corrupt marker | none | reusable |
| C3 | consume-time expiry; consume-time tuple mismatch | none | unconsumed/unusable |
| **D0** | successful consume | witness record only | **consumed from here** |
| D1 | JSON genesis atomic/partial failure; owner loss at the actual E0 active-state rename | current genesis law only; no stale genesis publication | n/a |
| D2 | legacy-lineage CAS refusal; lineage drift; owner loss | at most accepted capable-lineage CAS | consumed |
| D3 | published/unreadable checkout journal; malformed/foreign A/P/K/Z; P hold/cap; residual journal namespace | current A/P repair prefix | consumed |
| D4 | JSON disappeared/changed/oversized/malformed; Q authority/stream/nonce/revision/hash changed; marker-only active bytes absent | D3 prefix only; no journal | consumed |
| D5a, common begin | invalid authorization; invalid clock/random; candidate collision; journal codec/publication failure; owner loss at actual journal rename | no journal unless its atomic rename occurred | consumed |
| D5b, JSON begin | exact old read disappears; foreign/malformed/oversized bytes; stream/nonce/revision drift; archive/candidate mismatch; recovery-ref wrong target/delete failure; marker precondition | only completed ref normalization or other existing pre-journal normalization | consumed |
| D5c, SQLite active quiesce | active writer open; lineage select/incomplete; authority mismatch; checkpoint; close; first S0; active DB/parent fsync; final S0/authority reread | checkpoint/fsync effects may have landed; active DB remains the old lineage | consumed |
| D5d, SQLite seed | seed mkdir; **seed writable create**; seed checkpoint; close; S0 check; DB/parent fsync; exact seed read; seed cleanup/fsync; active hash; archive baseline; ref observe/delete; marker precondition | inert/partial seed residue allowed by current cleanup/crash law plus completed ref normalization; no journal | consumed |
| D6 | throw/crash after LegacyV2/SQLiteV2 journal rename or parent fsync | authenticated journal and allowed P row | consumed; journal owns retry |
| D7a, prepared | candidate atomic/exact publication; archive copy; recovery-ref creation; ready-phase publication; row/repository drift; physical I/O/ref failure; syscall-adjacent owner loss | only P0/P0A/P1/P2/P3.g prefix | consumed |
| D7b, replace | final active observation/hash; candidate-to-active rename; destination fsync; last-writer witness; source unlink; source-parent fsync; competing accepted save; owner loss at actual active or witness rename | only admitted R0/R1/R2; competing accepted state and witness are never overwritten by stale owner | consumed |
| D7c, installed | active hash; marker publication/fsync; active-group validation/update-ref; installed/z-retired phase publication; row drift/owner loss | only I0/I1/I2/I3.g prefix | consumed |
| D7d, terminal | Z0 validation; journal unlink/fsync; candidate cleanup; owner loss or I/O failure at each | Z0 or steady; no active rollback | consumed |
| D8 | non-`ENOENT` cleanup failure at sidecar 1; 2; 3; 4; 5; 6 | reset complete; failed and later sidecars remain | consumed |

## 5. Standing-reset matrix

| ID | Observation | Result before fresh begin |
|---:|---|---|
| S0/S1 | JSON or exact-Q S0, no journal | `none`; Q has zero writable opens |
| S2/S3 | authenticated LegacyV2/SQLiteV2 listed P/R/I/Z row | recover/retire, then restart at consent observation |
| S4/S5 | LegacyV1 or malformed/J0 | current typed halt/doctor path; zero writes |
| S6/S7 | no recovery stream or config names neither old nor next | halt; zero recovery action |
| S8 | Q + W1 | after consent validity, canonical-lock checkpoint to S0 and restart |
| S9/S10 | journal + sidecars (W2), or no journal + orphan candidate/archive sidecar (W3) | halt before DB open |
| S11/S12 | repository unavailable/replaced, or journal/authority/Z/request inventory changes | refuse; no later effect |
| S13 | eligible JSON lineage lacks nonce | existing post-D0 held-lock capable-lineage CAS |
| S14/S15 | Q lineage incomplete/foreign, or final active lineage replaced | corruption/refusal; no fresh journal |
| S16/S17 | listed residue prefix, or any `other`/non-prefix/mixed group | resume only listed next action; otherwise halt |

## 6. Differential, crash, compatibility, and performance gates

### 6.1 Public-entry parity P1-P12

| ID | Scenario/oracle |
|---:|---|
| P1 | bound empty-repository reset: same next lineage/seq-0/empty manifest and authority-specific bytes |
| P2 | BASE/origin + A/P/Z: identical inventory, repairs, sorted Z, refs, retirement, and archive semantics |
| P3/P4 | standing then fresh begin: settle first; SQLite journal never reaches legacy decoder |
| P5 | unavailable/replaced repo, checkout journal, malformed A/P/K/Z, residual namespace: same refusal and residue |
| P6/P7 | E4/E5 marker-only and E0/E1 empty-root behavior |
| P8 | final JSON-byte or Q-lineage replacement after D0: consumed, no journal |
| P9/P10 | six-sidecar exact success order and each failure index; only `ENOENT` ignored |
| P11 | JSON full-tree/byte golden; no SQLite module evaluation |
| P12 | Q full table/pragmas/digest golden; no JSON state I/O; every writable open has live canonical owner, including seed writer |

### 6.2 Replacement parity L1-L8

| ID | Required oracle |
|---:|---|
| L1 | authorized stream-only rejection: JSON exact current projection; Q atomic stream+packet and retained metadata/generations |
| L2/L3 | no provenance, seq nonzero, unmarked snapshot, or live tuple drift: refusal and zero replacement |
| L4 | packet proof/generation/nonce refusal: JSON safe direction; Q whole transaction rollback |
| L5 | held/error/unsupported/owner loss: **preserve current JSON outcomes including unsupported fallback**; Q refuses with zero mutation |
| L6 | owner loss before JSON publication/Q COMMIT: old complete image |
| L7 | one pull + three push effects unchanged; track/scope never replace |
| L8 | later save/reload and `.json`/`.db` provenance/files-first behavior unchanged |

The option/branch/four expressions remain after L1-L8. Deletion is not an
acceptance step for 265.

### 6.3 High-level owner-loss/crash matrix O1-O12

| ID | Boundary and required result |
|---:|---|
| O1/O2 | W1 before open/checkpoint and after checkpoint: no unowned open; restart sees W1 or exact S0 |
| O3/O4 | active quiesce and seed durability: old active exact; only current inert seed residue |
| O5/O6 | each ref normalization and journal publication: exact preceding prefix; no journal means no replacement authority |
| O7 | each prepared effect/ref creation: one listed P prefix |
| O8 | wrapper entered/outer validation passed; during its awaited preparation lease is replaced and competing ordinary save commits; the **in-primitive** final check refuses before actual active rename and preserves the competing save |
| O9 | owner loss at final active rename without competitor: R0 remains; retry fully reinspects |
| O10 | rename through destination/source fsync: only admitted R0/R1/R2 |
| O11 | marker and each active-group ref boundary: only I prefixes |
| O12 | z-retired, journal unlink, candidate cleanup: Z0/steady; never active rollback |

Each O row has named before/after loss cases. Existing 17 SQLite SIGKILL and
10 direct empty-Z boundaries remain.

### 6.4 Syscall-adjacency matrix X1-X7

Each cell runs twice: (a) loss after a stale outer check but during awaited
wrapper preparation, and (b) a test hook after all preparation but immediately
before the in-primitive final owner check. Both replace the lease; rename/update-
ref cells also commit a competing accepted save where meaningful. These tests
would pass with v1's outer permit consumption and fail unless validation is at
the actual syscall.

| ID | JSON physical syscall | SQLite physical syscall | Required result |
|---:|---|---|---|
| X1 | journal/phase/marker `writeFileAtomic` rename | journal/phase/marker `atomicWrite` rename | typed owner loss; temp/current row retained; no publication |
| X2 | `boundedCopy` candidate/archive rename | `exactWrite`/`copyExact` candidate/archive rename | no unowned destination publication |
| X3 | candidate -> active `fs.rename` | candidate -> active `fs.rename` after trace source read | competing accepted active state remains byte/digest exact |
| X4 | recovery-ref create/delete and active-group `git update-ref` spawn | same shared helpers | no unowned ref change; previous prefix remains |
| X5 | journal/candidate `fs.rm`/unlink | journal/candidate `remove` | no unowned retirement/cleanup; retry resumes classified row |
| X6 | E0 genesis `publishWholeState` active-state `writeFileAtomic` rename | n/a | loss after its asynchronous owner check but before the synchronous rename slot publishes no stale genesis; a competing accepted state remains byte-exact |
| X7 | post-replacement `recordLastWriterWitness` `writeFileAtomic` rename | n/a | loss after state sampling/preparation but before the synchronous rename slot leaves the competing accepted save's state and witness exact; no stale witness publication |

Structural tests assert the exact order `awaited prep -> owner checks ->
synchronous final observation -> syscall` and prohibit an awaited hook between
observation and rename/spawn.

## 7. Suite disposition ledger

Baselines are Bun expanded cases at verified HEAD. No existing case/snapshot
may disappear. The named X cases add fourteen JSON and ten SQLite expanded
cases (two timings for X1-X7 where the authority has that boundary); they are
not hidden inside one loop.

| Suite | Baseline -> minimum landed | Disposition |
|---|---:|---|
| `reset-consent.test.ts` | 7 -> 17 | amend A-D witness order; every §4 injection is named in this suite or its owning suite and asserts reusable/consumed |
| `reset-journal-classifier.test.ts` | 6 -> 6 | preserve all admitted/deviation rows and indivisible groups |
| `reset-journal-codec.test.ts` | 9 -> 9 | preserve v2 branches, strict limits/UTF-8/schema/hash and Z boundary |
| `sync-git/reset-journal.test.ts` | 54 pass + 2 skips -> 83 pass + 2 skips | +15 P/public-entry sentinels and +14 JSON X cases, including E0 publication and post-replacement witness rename; preserve phase/byte/ref/normalization/snapshots |
| `state-plane/reset/recovery.test.ts` | 3 -> 37 | +24 O before/after and +10 SQLite X cases; preserve ten direct recovery boundaries |
| `state-plane/reset/crash-rig.test.ts` | 39 -> 39 | amend real-lock signatures; preserve 17 reset SIGKILL, P0A, backup, W1, quarantine, power cuts |
| `state-plane/reset/classifier.test.ts` | 4 -> 4 | **amend signature** for facade recovery capture; preserve J0/W1/W2/W3 and zero-write predecode |
| `state-plane/reset/lifecycle.test.ts` | 2 -> 4 | add active+seed writable-open ownership and W1 takeover; zero unvalidated opens |
| reset capability / consumer consistency | 2 / 1 -> 5 / 5 | wrong path/object/token refusals; two reset gates, two lock inventories, sole facade reach |
| `reset-namespace-inventory.test.ts` | 21 -> 22 | add E7b neutrality/residue preservation; inventory is not genesis eligibility |
| quarantine / SQLite quarantine | 25 / 8 -> 25 / 8 | preserve operator authority; amend SQLite fixture signature only |
| doctor / health / reset I/O | 5 / 3 / 13 -> 6 / 3 / 15 | Q doctor row; preserve health; add `boundedCopy` adjacent-check cases |
| `state-plane/locks.test.ts` | 13 -> 17 | paired standing inventories, drift, borrowed W1, halt rows |
| daemon reset halt/state | 2 / 6 -> 2 / 6 | preserve |
| whole-state compatibility | 36 -> 42 | selected replacement L1-L6, canonical owner, JSON/Q closure; retain current JSON L5 |
| `sync-state.test.ts` | 33 -> 39 | four authorized callers, track/scope negatives, option/branch/fallback **retained** |
| store write differential / reads-at-rest | 5 / 7 -> 6 / 8 | selected lineage transaction; Q writers close at S0 |
| `state-plane/store/cas-operations.test.ts` | 22 -> 23 | amend packet transaction with reset-lineage replacement/rollback |
| git-section codec | 13 -> 13 | preserve all fields/proofs |
| `sync-state-store.test.ts` | 7 -> 8 | `.json`/`.db` provenance and zero unsafe-Q replacement |
| state-plane inventory / authority marker / config surface | 9 / 12 / 3 -> unchanged | amend inventory counts; preserve marker and exports; six `allowLegacyStreamReplacement` occurrences remain |
| `sync-git/base-composer-structure.test.ts` | 9 -> 9 | amend exact unsafe whole-state writer allowlist/counts for changed `sync-state.ts`; no weakened sweep |
| activity / path warnings | 22 / 8 -> 22 / 8 | preserve empty-root and cleanup behavior |
| setup / init / keyed rebind | 65 / 18 / 1 -> 66 / 19 / 1 | selected-Q real entries; preserve refusal-before-POST/key/config order |

Also run without deletion: owner-token typecheck, store schema/duplicate/file-
size inventories, pull attribution/trusted-view, push guard/mass-delete,
publisher acknowledgement, P repair/settlement/held-skip, doctor/status,
migration/genesis authority suites, `bun run typecheck`,
`bun run lint:affected`, and the existing local crash rig. SP-2.5 owns the new
Docker/e2e authority dimension.

## 8. Size and structural accounting

Production baselines are nonblank lines / bytes.

| Module | Baseline | Acceptance |
|---|---:|---|
| `reset-state.ts` | 462 / 25,389 | shrinks; raw JSON/parser and both journal gates gone |
| `reset-journal.ts` | 460 / 26,286 | format-neutral operations; hard 560 / 32,768 |
| `reset-z-runtime.ts` | 113 / 6,014 | mandatory held-lock syscall checks; hard 150 / 8,192 |
| `reset-lineage.ts` / `locks.ts` | 98 / 4,472; 353 / 16,640 | presence lstat gone; two inventory replacements, locks <= baseline + 8 lines |
| whole-state / legacy JSON Adapters | 319 / 14,164; 392 / 20,038 | selected replacement; JSON byte behavior, fallback, and closure retained; hard 400 each |
| **`sqlite-state-save.ts`** | **140 / 5,081** | owns packet-to-sealed/CAS translation for lineage replacement; hard 190 / 8,192; no duplicate translator |
| reset recovery / lifecycle | 460 / 21,410; 169 / 6,950 | passed canonical lock and active+seed checks; hard 520 / 28,672 and 230 / 12,800 |
| **`trace-fs.ts`** | **132 / 5,756** | owns real SQLite reset rename/unlink checks; hard 180 / 10,240 |
| **`reset-io.ts` / `engine/fsutil.ts`** | **335 / 15,752; 251 / 10,015** | synchronous pre-rename slot; non-reset behavior unchanged; hard 370 / 20,480 and 280 / 14,336 |
| **`legacy-json-publication.ts` / `last-writer-witness.ts`** | **51 / 2,525; 204 / 9,347** | E0 active-state and post-replacement witness renames wire the held lock through the synchronous slot; ordinary publication and best-effort witness semantics unchanged; hard 80 / 4,096 and 240 / 12,800 |
| reset owner/index / facade | 111 / 4,382; 20 / 595; 49 / 2,095 | signature forwarding only; no new facade method |
| owner-token / write-packet / cas-steps | 28 / 1,678; 317 / 15,121; 319 / 18,492 | reuse ordinary token and private CAS steps; hard 80 / 5,120 and 400 / 25,600 for each CAS file |
| `sync-state.ts` | 589 / 31,067 | retain option/branch/fallback; selected dispatch must not grow above 620 / 35,840 |
| pull / push | 510 / 27,677; 944 / 49,913 | four authorization expressions unchanged; no production edit required |
| sync-state-store / namespace inventory | 27 / 1,157; 395 / 15,212 | compatibility only; inventory not added to emptiness path |
| crash-rig child | 228 / 10,521 | real canonical lock setup; hard 260 / 14,336 |

Structural acceptance:

- zero raw state-byte/parser use in `reset-state.ts`; zero production legacy
  journal decisions in its two gates, `locks.ts`, or `reset-lineage.ts`;
- zero normal SQLite reset acquisition of `state.db.lock`; all normal writable
  opens use the validated canonical lock, including active quiescence **and the
  seed writer**;
- all reset `writeFileAtomic`, `boundedCopy`, trace-fs writes/copies/renames,
  E0 `publishWholeState`, post-replacement `recordLastWriterWitness`, ref
  mutations, and unlinks carry the real lock to the physical owner; no
  outer-only ownership callback or permit remains;
- only selected begin/settle call facade begin/recover; doctor/quarantine is
  the named operator exception;
- exactly six production `allowLegacyStreamReplacement` occurrences remain;
  JSON unsupported fallback and four caller expressions remain; track/scope
  remain unauthorized;
- zero unsafe JSON writer reach from exact `Q`; JSON closure remains free of
  `bun:sqlite`; no second packet translator/CAS driver;
- no new durable file/schema/flag/mode/sidecar/queue/kill switch/lock class;
  no new `any`, unsafe cast/dictionary, suppression, or widened backend API;
- CODEMAP and file-size ratchet are updated at landed counts.

Performance acceptance records p50/p95 and open/read counts for P1, S0/S1,
W1, and L1. JSON no-journal adds no SQLite evaluation and E7b adds no occupancy
scan. Q fresh begin counts one active writable open plus one seed writable
open; bounded recovery opens remain itemized separately. No duplicate namespace
walk or whole-DB materialization is accepted.

## 9. Simplification and requirement challenges

Real landed concept reductions, not file splitting:

| Removed baseline concept | Replacement |
|---|---|
| raw JSON read/hash/parse in reset orchestration | authority-selected begin owns physical evidence |
| two reset-entry journal gates, two lock-inventory legacy decisions, one lineage lstat | one format-neutral fence inventory/settlement owner |
| normal reset's separate `state.db.lock` authority | existing canonical state lock shared with accepted saves |
| nullable post-begin recovery stream + defensive impossible branch | total result from selected begin |

v2 also refuses to introduce v1's root-occupancy proof, effect permits/effect
union/WeakMap, or remote-sync context wrapper. It does **not** claim deletion of
the retained SP-4 mode/fallback as simplification.

| Challenged requirement | Cost | Ruling |
|---|---|---|
| new mutation gate | schema/recovery/lock order and second authority | reject; canonical lock + adjacent checks suffice |
| retain `state.db.lock` for normal reset | two physical authorities and lost-write race | remove as normal-reset authority; do not rename it |
| namespace-wide empty-root purity | changes supported JSON no-state behavior | reject; preserve E7b exactly |
| one-use reset permits/effect protocol | brands, union, WeakMap, wrapper TOCTOU | reject; pass real lock to physical owner |
| retire replacement authorization in SP-2b | unapproved deletion of explicit SP-4 inventory | reject; port behind existing branch |
| byte equality across JSON and SQLite | format coupling | authority-specific physical goldens + semantic differential |

## 10. Ordered acceptance gates

1. Freeze current JSON E0-E7b bytes/output/residue, §4 witness order,
   P1-P10, L1-L8, phase/byte/ref/normalization crashes, and sidecar behavior.
2. Add format-neutral inventory/settlement and selected begin. Invalid/mismatch
   standing P/R/I/Z and W1 fixtures must prove zero mutation before any recovery
   fixture is allowed to run.
3. Move normal SQLite reset to the canonical lock; thread that lock into every
   physical owner and both writable begin opens. Make O1-O12 and X1-X7 green,
   including the real competing accepted write.
4. Add SQLite lineage replacement behind the retained authorization. Make all
   L cells green; do **not** remove any SP-4 item.
5. Run every §7 suite, structural/size/performance gate, typecheck, lint, and
   existing crash rig. Any red consent, adjacency, row, compatibility, or
   closure cell rejects the implementation.

## 11. Non-goals and deletion ruling

- No default flip, absent-state SQLite genesis, fleet cutover, upgrade-window
  change, Docker/e2e expansion, reset/store schema, wire/API, config, daemon
  scheduling, or user-copy change.
- No JSON/legacy codec/migration/genesis/doctor/quarantine/sidecar/test/guard/
  documentation deletion. No SP-4 inventory item is removed or renamed.
- No redesign of checkout/A/P/Z, quarantine, doctor, or the correlated
  physical-signature grammar.

265 succeeds when setup/rebind resets either selected authority through one
complete-fence orchestration, consent validity precedes every mutation, current
JSON no-state behavior is exact, and lease loss inside a compound primitive
cannot erase a competing accepted write. It fails if ownership is checked only
outside the actual syscall owner, E0 genesis or the last-writer witness can
rename after losing ownership, the seed writer opens without authority, `Q`
reaches JSON I/O, or any SP-4 behavior disappears.
