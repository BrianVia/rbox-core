# 222 — U3 implementation design: the migration unit, the `Q` flip, and the whole-state adapter

> Status: DRAFT for adversarial review (step 1 of `/dev-cycle`). No implementation
> exists. This document is **not** implementation authority until Claude + codex
> align.
>
> Normative source: `docs/design/163-state-plane-sqlite.md` (ratified v10 +
> `MIGRATION-EXCLUSIVITY-v11`). Where this document and 163 disagree, **163
> wins** and this document is wrong. Build blueprint: `docs/design/notes/
> 2026-07-28-thermo-nuclear-sweep-4.md` Tier 1.
>
> Founder's bar, quoted because every section below is held to it:
>
> > "keep our domains clean and tight and as small as possible. No stupid long
> > comments. Build simple code that works and is easy to understand. Don't try
> > to be cute. Genius has the fewest moving parts."
>
> Operationally: prefer deleting mechanism to adding it. One responsibility per
> module, small, behind a facade when it is a family. Every module below that
> cannot state its responsibility in one sentence is a module this review should
> delete or merge.

## 0. What this unit is, and what it is not

U3 is the release that carries the **one-way authority change** from
`.rbox/state.json` to `.rbox/state/state.db`, and under backend-first sequencing
it carries nothing else. The scan/reconcile/apply engine is byte-identical
across the flip; it reads and writes through a whole-state compatibility adapter
over the U1 store.

U3 **is**:

1. the nine-module M0–M7 migration machine (sweep-4 T1.3);
2. the two deferred compatibility adapters, `adapters/sqlite-state-save.ts` and
   `adapters/whole-state-compat.ts` (sweep-4 T1.1 steps 4–5, deferred out of prep
   into this unit);
3. the two admitted entry points — `rbox upgrade`'s per-workspace stop window and
   a foreground `rbox migrate` — and the `migration-not-exclusive` refusal;
4. the halt taxonomy filled in behind `MigrationHaltCode` with plain-English
   doctor copy and its non-interactive twin;
5. the exit gates: F1–F6, the crash/disk-full/resume table row by row, the abort
   procedure, import fidelity, the no-regression harness, and the dual-binary
   rig.

U3 is explicitly **not**:

- ambient or on-boot migration, in any form (v11 founder decision 5);
- the paired-interval live-writer sampling and its `legacy-writer-live` refusal
  (v11 deletes them; lock ownership replaces them — do not build them);
- a generic capability framework (sweep-4 capability decision: consume
  `sqliteResetFacade` directly, reuse U1b's `StageLock`, use
  `withMigrationImporter`, use the merged `OwnedLock`→`CasOwnerToken` bridge);
- any engine port. `U4a–U4f` owns that, on `main`, as 2.x.

**Branch.** U3 is the only unit that opens the `2.0` branch. It is not opened by
this document.

### 0.1 Foundation actually merged on `main` (verified at `1a78fa32`)

| Merged | Provides |
|---|---|
| `state-plane/paths.ts` (#579) | `statePath`, `stateLockPath`, `stateIncarnationPath`, `sqliteResetPaths` |
| `adapters/legacy-json-store.ts` (#579, 488 lines) | `loadRawState`, `loadState`, `applyStateSavePacket`, `saveState`, `saveStateUnsafeLegacyOrTest`, `ensureTelemetryBindingId`, `installGenesisResetStateUnderHeldLock` |
| `adapters/legacy-json-publication.ts` | JSON publication primitive under the barrier |
| `store/owner-token.ts` (#579) | `casOwnerTokenFromLock(lock): OwnedLockCasToken` — the sole production mint site |
| `store/open.ts::initializeStateStore(file, install)` (#577) | Claimed-file initializer: `O_EXCL` create, pragmas, DDL, caller's `install(db)` in the same transaction, validation, cleanup on failure |
| `schema/application.ts` (#577) | `applySchemaV1` (behavior-free DDL) split from `installGenesisLineage` |
| `errors.ts` (#578) | `StateDataCorruptionError`, `decodeAuthorityRow`, `ProoflessBaseError`, `StateFormatTooNewError`, `StreamMismatchError`, `StateWriteRefusedError` |
| `codecs/git-section.ts` (#578) | Git-section codec closing the last unchecked `as unknown as` |
| `doctor-state-plane.ts` + `migration/health.ts` (#576) | `MigrationHaltCode = never`, `MigrationHalt`, `MigrationHealth`, `MIGRATION_HALT_COPY = {} satisfies Record<MigrationHaltCode, MigrationHaltCopy>` |
| `authority-marker.ts` (B0) | `AUTHORITY_MARKER_MAGIC`, `AUTHORITY_MARKER_BYTES = 58`, `classifyStateFormat`, `assertStateReadable`, `assertStatePublishable` |
| `migration/reserve.ts` (B0) | 128-byte header, `ensureStateReserve`, `inspectStateReserve`, `reserve-foreign` |
| `migration/last-writer-witness.ts` (B0) | `BARRIER_DOWNGRADE_FLOOR = "1.11.0"`, `verifyLastWriterWitness`, `WitnessVerdict` |
| `reset/index.ts` (U2) | `sqliteResetFacade`, `hasDbArtifactResetCapability` |
| `store/*` (U1a/U1b) | `initializeStateStore`, `applyCasPacket`, `CasPacket`, `StageLock`, sealed stages, transition stages, `buildCasRetryView`, `read-snapshot`, `local-plane` |

### 0.2 Foundation NOT merged — a hard prerequisite (RISK 1)

`migration/base-proof.ts`, `migration/import-stage.ts`
(`beginMigrationImportStage`), `store/transition-admission.ts::withMigrationImporter`,
and `sync-git/base-proof-selection.ts` are on the **unmerged** branch
`origin/fix/base-proof-authority` (sweep-4 **T0.1**, the first Tier 0 gate). They
are the seam that keeps blanket `migration` BASE authority out of ordinary engine
writes.

**U3 module M-5 (`import-json`) cannot be dispatched until T0.1 merges.** The
sweep's verdict is unambiguous: NO-GO for U3 dispatch until all four Tier 0 gates
close. T0.2–T0.4 are merged (`cfa873fc`). T0.1 is not. See §7 sequencing and §8
open question Q1.

---

## 1. Module-by-module

Design 163:3994 is the binding constraint: production files target **≤300
nonblank lines**; **400 lines or 25 KiB is a hard CI guard failure**; 301–399
requires an explicit review note. Every budget below is nonblank production
lines and every one is a ceiling this document commits to, not an estimate.

Every module also owes its one-line ownership rule in `docs/CODEMAP.md` in the
same change (163:3994).

### 1.1 The nine migration modules

All under `src/cli/state-plane/migration/`.

| # | Module | Single responsibility | Budget |
|---|---|---|---:|
| M-1 | `control-codec.ts` | Encode/decode the closed control union; nothing else | 300 |
| M-2 | `control-publication.ts` | The sole revision-CAS write path for the control record | 220 |
| M-3 | `classifier.ts` | Read-only artifact/control observation → one admitted row | 300 |
| M-4 | `admission.ts` | M0/M1 predicates: exclusivity, B0 evidence, reset, budgets | 280 |
| M-5 | `import-json.ts` | M2–M4: backup, import, digest round trip | 300 |
| M-6 | `finalize.ts` | M5–M6: publish DB, build Q sibling, the one authority flip | 280 |
| M-7 | `retirement.ts` | C1 source-change retirement cursor | 240 |
| M-8 | `cleanup.ts` | M6 cleanup cursor, the `b..b+4` runway, M7 | 320 |
| M-9 | `authority.ts` | Orchestration over typed phase receipts. No filesystem primitives | 200 |

Total production budget: **2,440 lines**. If the implementation exceeds it, the
correct response is to find the mechanism to delete, not to raise the number.

---

#### M-1 `migration/control-codec.ts` — the closed 64 KiB union

**Responsibility.** Turn control bytes into a typed record and back. It is a pure
codec: no `fs`, no `bun:sqlite`, no clock, no randomness.

```ts
export const CONTROL_MAX_BYTES = 65_536;

export type MigrationPhase = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";

export type HaltResourceDisposition =
  | "not-created" | "available" | "consumed-for-halt"
  | "retirement-intent" | "retirement-absent"
  | "cleanup-intent" | "cleanup-absent" | "retired";

export interface MigrationControl { /* the exact-schema closed record (163:2612) */ }

/** Canonical bytes for a control. Deterministic; the only encoder. */
export function encodeMigrationControl(control: MigrationControl): Buffer;

/** Strict decode. Unknown, extra, or missing fields REJECT (163:2612). */
export function decodeMigrationControl(bytes: Uint8Array): MigrationControl;
```

**May NOT touch.** The filesystem, SQLite, the state document, `paths.ts`
resolution against a live root (it takes paths as data, it does not compute
them), or any notion of "current" — it has no idea which control is on disk.

**Notes for review.** The eight witness shapes (163:2663) are eight variants of
one discriminated union keyed on `phase`. `futureControls` is part of the M6
witness, not a top-level optional extension, so it does not relax the
unknown-field rejection. Encoding must be canonical (same record → same bytes)
because the `b..b+4` runway hashes prepared bytes and compares them.

---

#### M-2 `migration/control-publication.ts` — the sole publisher

**Responsibility.** `publishMigrationControl` and nothing else: exclusive
revision-scoped sibling create → write canonical bytes → file fsync → rename over
`migration-v1.json` → `fsyncDirectory(.rbox/state)` → exact reread.

```ts
export interface PublishExpectation {
  migrationId: string | "absent";
  revision: number | "absent";
}

/** The ONLY writer of `.rbox/state/migration-v1.json`. Caller must hold the
 * complete lock set; this asserts it and does not acquire it. */
export function publishMigrationControl(
  root: string,
  expect: PublishExpectation,
  next: MigrationControl,
  locks: HeldMigrationLocks,
): MigrationControl;

/** Render a prepared future-control sibling without publishing it (the
 * `b..b+4` runway). Returns its exact identity. */
export function renderPreparedControl(
  root: string,
  revision: number,
  next: MigrationControl,
  locks: HeldMigrationLocks,
): PreparedControlIdentity;

export const controlPath = (root: string) => …;              // `.rbox/state/migration-v1.json`
export const revisionScopedPath = (root: string, revision: number) => …;
```

**May NOT touch.** Phase logic, halt selection, artifact cleanup, DB, or the
state document. It publishes whatever record it is given, having verified only:
the expectation matches the on-disk record, the bytes are ≤64 KiB, and the reread
is byte-exact.

**Why it is separate.** 163:2663 says "All control writes call one helper." A
single publisher is the only way "a crash during publication leaves the old exact
control, the new exact control, or a halting observation" is a property of the
code rather than of a convention.

**Path ownership.** `controlPath` / `revisionScopedPath` should arguably live in
`state-plane/paths.ts` (which already owns migration-control/staging paths per
T1.1 step 1 — but does not yet contain them). See open question Q4.

---

#### M-3 `migration/classifier.ts` — the read-only matrix

**Responsibility.** Observe `.rbox/state.json`, `.rbox/state/state.db`, the
control, and the named artifacts, and return **exactly one admitted row** of the
M0 authority matrix (163:2578) and the crash/resume table (163:3232), or a
corruption verdict. It performs **zero writes**.

```ts
export type StateAuthority = "json" | "sqlite" | "none" | "contradictory";

export type MigrationObservation =
  | { row: "no-control-json";       authority: "json";   /* … */ }
  | { row: "m0-resume";             authority: "json";   control: MigrationControl }
  /* … one variant per admitted table row … */
  | { row: "terminal-sqlite";       authority: "sqlite" }
  | { row: "corruption";            authority: "contradictory"; halt: MigrationHalt };

/** Observe without mutating. `lstat`-only, no-follow, bounded reads. */
export async function classifyMigrationState(root: string): Promise<MigrationObservation>;
```

**May NOT touch.** Anything. It opens no DB read-write, creates nothing, deletes
nothing, and publishes nothing. It may open the active DB **read-only** to check
`migration_completion`, application/schema/authority ids.

**Why it is separate, and why it is the highest-value module in the unit.** The
crash table is 17 rows and the authority matrix is 16; artifact-behind,
two-phases-ahead, foreign, special, sidecar-without-main, and phase/witness
mismatch all halt with zero writes. If observation and mutation live in the same
function, "zero writes" is a claim. Here it is a type: nothing in this module's
import graph can write.

**Test shape.** One table-driven test per row, constructing the exact artifact
set and asserting the returned row — plus a byte-for-byte zero-write snapshot of
`.rbox` taken before and after every corruption row.

---

#### M-4 `migration/admission.ts` — M0/M1 predicates

**Responsibility.** Answer "may this workspace begin (or continue) a migration
right now?" It owns the **single normative M0 predicate** of 163 §3 (five
conditions, consolidated in v7, amended by v11) and the M1 budget admission.

```ts
export type AdmissionRefusal =
  | { code: "degraded-fence" }
  | { code: "workspace-busy";           detail: string }
  | { code: "quarantine-pending" }
  | { code: "barrier-witness-missing";  verdict: WitnessVerdict }
  | { code: "migration-not-exclusive";  detail: string };

export type AdmissionVerdict =
  | { status: "admitted"; source: SourceIdentity }
  | { status: "refused"; refusal: AdmissionRefusal };

/** The five M0 conditions, in order, under the held lock set. Re-called
 * verbatim immediately before the M6 rename. */
export async function admitMigration(
  root: string,
  entry: MigrationEntryProof,
  locks: HeldMigrationLocks,
): Promise<AdmissionVerdict>;

/** M1: design 161's unchanged 52× admission, the 512 MiB hard cap, the
 * RSS/cgroup budget, and the advisory `statfs`. */
export async function admitMigrationBudget(
  sourceBytes: number,
): Promise<BudgetVerdict>;
```

The five conditions, exactly and in this order (163 §3 bullet 3):

1. workspace locking health is **not** `degraded-unlocked` → `degraded-fence`;
2. no other live rbox process holds or recently held a workspace operation,
   from existing daemon/lock ownership evidence plus a bounded wait →
   `workspace-busy`;
3. `.rbox/state/quarantine/` enumerates to absent (bounded, no-follow) →
   `quarantine-pending`;
4. `verifyLastWriterWitness` (merged) returns a match on all five fields and
   `writerVersion >= 1.11.0` → `barrier-witness-missing`;
5. the exclusivity window is proven (§3 below) → `migration-not-exclusive`.

**May NOT touch.** Any file it does not read. It publishes no control, creates no
artifact, and on refusal leaves `.rbox` byte-identical. Refusals are **refusals,
not halts** — they publish nothing and are retried freely (163: "a typed
`barrier-witness-missing` refusal, not a halt").

**The v11 deletion is a review assertion, not a comment.** There must be no
paired-interval sampling, no `legacy-writer-live` code, and a structural test
asserting the string `legacy-writer-live` appears nowhere in `src/`.

---

#### M-5 `migration/import-json.ts` — M2–M4

**Responsibility.** From an admitted source, produce a **proven staging DB**:
preserve the source (M2), durably create and build (M3), close and prove (M4).

```ts
/** M2 — preserve source. Preamble-prefixed streaming copies only; hard links
 * are forbidden (163 v7). Returns body + physical hashes for both backups. */
export async function preserveSource(root: string, source: SourceIdentity, locks): Promise<M2Witness>;

/** M3 — durably create and build. `O_EXCL` the staging main, fsync file and
 * parent, CAS-record its identity into the M2 revision, then run the import
 * through `initializeStateStore` with `migration_completion` inserted LAST in
 * the same transaction. */
export async function importSourceIntoStaging(
  root: string, control: MigrationControl, source: SourceIdentity, locks,
): Promise<M3Witness>;

/** M4 — close and prove: WAL takeover + `wal_checkpoint(TRUNCATE)`, close,
 * require `S0`, reopen read-only, recompute the semantic stream, validate
 * ids, `foreign_key_check`, full `integrity_check`, close, require `S0`
 * again, fsync, physical-hash under identity bracketing. */
export async function proveStaging(root: string, control: MigrationControl, locks): Promise<M4Witness>;
```

**Consumed seams (all existing; nothing new is invented here):**

- `store/open.ts::initializeStateStore(file, install)` — merged for exactly this
  (T1.2). `install` writes the imported rows and the completion row last.
- `migration/import-stage.ts::beginMigrationImportStage` — **T0.1, unmerged.**
  The only way to create a `migration`-tagged transition stage.
- `digest/state-semantic-v1.ts::stateSemanticDigest` — both sides of the round
  trip.
- `backup/publish.ts`, `store/artifact-proof.ts` (`assertNoSidecars`,
  `fsyncDirectory`, `PhysicalIdentity`).

**May NOT touch.** `.rbox/state.json` (except to read the already-identity-
bracketed source), the active `state.db`, the Q sibling, the control record
(it returns witnesses; M-9 publishes them), or cleanup.

**Fidelity contract.** `sourceSemanticDigest == sqlRoundTripSemanticDigest`, and
when manifest meta is present the canonical reconstructed manifest hash is
checked independently. Counts are diagnostic only.

**Budget risk.** This is the module most likely to exceed 300 lines: three
phases, each with real fsync choreography. If it does, the split is
`import-json.ts` (M3 only) + `preserve-source.ts` (M2) + `prove-staging.ts` (M4),
which is a clean cut along phase boundaries. Prefer that to a 400-line file. See
Q5.

---

#### M-6 `migration/finalize.ts` — M5, the Q sibling, and the one flip

**Responsibility.** Publish the prepared DB (M5) and perform the **single
authority flip** (M6's rename). This is the most dangerous file in the codebase
and it should be the shortest one that can do its job.

```ts
/** M5 — rename staging over `state.db`, remove only a redundant exact staging
 * name, require staging absent and active `S0`, fsync `.rbox/state`, and
 * return the witness with the Q-sibling path/bytes/sha prebound, disposition
 * `absent`. JSON remains authority throughout. */
export async function publishPreparedDatabase(root: string, control, locks): Promise<M5Witness>;

/** M6 — drive the Q sibling `absent → building → exact` through same-phase
 * CAS publications, then flip. */
export async function buildQSibling(root: string, control, locks): Promise<QSiblingDisposition>;

export type FlipOutcome =
  | { kind: "flipped"; witness: M6Witness }
  | { kind: "source-changed"; trigger: SourceIdentity }        // → C1 retirement
  | { kind: "legacy-write-detected"; observed: string };       // → C1 retirement

/** The flip. Revalidates source/backup/completion, then — as the LAST
 * operation before `fs.rename`, with no work between them — re-verifies the
 * live `state.json` body hash against the M3-imported source digest under the
 * held `stateLockPath`. */
export async function flipAuthority(root: string, control, locks): Promise<FlipOutcome>;
```

**May NOT touch.** Cleanup (M-8 owns it), the control publisher's revision
arithmetic beyond asking M-2 to publish, or the import path. It never deletes a
backup and never deletes the source.

**The two invariants review must attack:**

1. **The last-instant re-verify.** 163 v9: the body-hash re-verification is the
   *immediately preceding operation* to `fs.rename`, under the held state lock.
   Under v11 this is defense-in-depth against an excluded scenario, but it is
   still normative and F5's companion assertion tests it. There must be no
   fsync, no hash of another file, and no logging between the check and the
   rename.
2. **`m0Predicate` is re-checked here.** All five M0 conditions are re-checked
   immediately before the rename (163 §3, final line), not only at M0.

---

#### M-7 `migration/retirement.ts` — C1 source-change retirement

**Responsibility.** The durable source-change retirement subprotocol: arm the
closed retirement union before deleting anything, then run the one-item
correlated cursor to a complete prefix and retire the control.

```ts
/** Arm retirement: CAS-publish the closed union with `durablePrefix: 0` and no
 * intent, deriving `items` ONLY from the old exact control's own recorded
 * artifacts. Never discovers a path. */
export async function armRetirement(root: string, control, replacement: SourceIdentity, locks): Promise<MigrationControl>;

/** Advance the retirement cursor by exactly one position (163:2704 table). */
export async function stepRetirement(root: string, control, locks): Promise<RetirementStep>;
```

**May NOT touch.** The current source `L`, the immutable backup history, the
fixed backup, or any path not named in the armed vector. It never parses,
imports, restores, or deletes replacement `L`.

**The item vector is a fixed-role, deduplicated, ordered list** (163:2704):
Q sibling → staging `-journal`, `-wal`, `-shm` → staging main → prepared active
DB → migration-id private artifacts (role 5 only, and only revision-scoped
siblings the retiring control itself names) → emergency resource → claimed
reserve. Sidecars precede their main.

**The abort path routes here.** `rbox doctor --abort-state-migration` (pre-`Q`)
runs this vector to completion against its own migration id and unlinks the
control last. §6.3.

---

#### M-8 `migration/cleanup.ts` — M6 cleanup, the runway, M7

**Responsibility.** The correlated M6 cleanup cursor (exactly two items: generic
reserve, then emergency), the allocation-free `b..b+4` future-control preparation
runway, and M7's terminal proof.

```ts
/** Advance the M6 cleanup cursor by one position. Nonfinal items only. */
export async function stepCleanup(root: string, control, locks): Promise<CleanupStep>;

/** Drive the `b → b+4` preparation ledger one durable row at a time
 * (163:2951 table). Never creates a second pair; always resumes the same
 * ledger stage and inode. */
export async function stepFutureControlPreparation(root: string, control, locks): Promise<PreparationStep>;

/** At ready revision `r = b+4`: unlink the final item, fsync its parent, then
 * rename the prepared exact M7 sibling over control. On a caught failure
 * before that rename, rename the prepared halted-M6 sibling instead. */
export async function completeFinalItem(root: string, control, locks): Promise<FinalItemOutcome>;

/** M7 — assert every non-control artifact absent or exact-terminal (including
 * role-5 inert temps by `lstat` over the control's own recorded revision
 * interval), unlink the unused r+1 sibling if exact, fsync, then unlink the
 * control and fsync. */
export async function finishMigration(root: string, control, locks): Promise<void>;
```

**May NOT touch.** The active DB, `Q`, the Q sibling (already absent at M6), the
fixed or immutable backups, `cache-v1-retired/`, or any legacy reset artifact.
Roles 1–4 present at M6 are a `reserved-path` corruption halt with zero writes —
this module never sweeps them.

**No directory discovery, anywhere.** M7's role-5 assertion enumerates a closed
named set derived from the control's own recorded monotone revision interval.

**Budget note.** 320 is the highest budget in the unit and this module earns it:
it holds two cursors and a five-row ledger. If it exceeds it, the cut is
`cleanup.ts` (the cursor + M7) + `future-controls.ts` (the `b..b+4` ledger),
which is again a clean seam.

---

#### M-9 `migration/authority.ts` — the controller

**Responsibility.** Sequence the phases. It consumes typed phase receipts from
M-3..M-8 and asks M-2 to publish. It holds **no filesystem primitive**: no
`fs.*`, no `bun:sqlite`, no hashing.

```ts
export type MigrationOutcome =
  | { kind: "completed";  phases: MigrationPhase[]; elapsedMs: number }
  | { kind: "refused";    refusal: AdmissionRefusal }
  | { kind: "halted";     halt: MigrationHalt; durableHalt: boolean }
  | { kind: "retired";    reason: "source-changed" | "legacy-write-detected" };

export interface MigrationProgress {
  (event: { phase: MigrationPhase; elapsedMs: number }): void;
}

/** The single migration controller. Both entry points call exactly this. */
export async function runMigration(
  root: string,
  entry: MigrationEntryProof,
  onProgress: MigrationProgress,
): Promise<MigrationOutcome>;

/** Doctor's `--retry-state-migration`: CAS-clear the exact halted revision
 * under the same locks, then delegate to `runMigration`. Never a second
 * repair path (163:2663 "sole actor"). */
export async function retryHaltedMigration(root: string, locks): Promise<MigrationOutcome>;
```

**May NOT touch.** Anything on disk. The structural test: `authority.ts`'s import
graph contains no `node:fs`, no `node:crypto`, and no `bun:sqlite`.

**Why this shape.** 163:2663 "There is one protocol actor" and "a mutating doctor
acts only for explicit `--retry-state-migration`: it takes the identical locks,
CASes the exact halted `controlRevision`, and invokes this same controller rather
than implementing a second repair path." That sentence is only enforceable if
there is exactly one function to invoke.

---

### 1.2 The two deferred adapters

#### A-1 `adapters/sqlite-state-save.ts` — writes go native

**Responsibility.** Turn a `StateSavePacket` into sealed U1b stages and apply
them through the native CAS. It owns stage lifetime and stage cleanup, and
nothing else.

```ts
/** Build the sealed global + transition stages for this packet, apply
 * `applyCasPacket`, and clean up the stages on every path. */
export async function applySavePacketToStore(
  store: StateStoreHandle,
  packet: StateSavePacket,
  ownerToken: OwnedLockCasToken,
): Promise<CasResult>;
```

**Consumed seams (all merged):** `store/generations.ts::beginGeneration`,
`store/transition-stages.ts::beginRepoTransitionStage`,
`store/stage-artifacts.ts::StageLock` (U1b's anonymous-inode containment —
reused, per the sweep's capability decision, **not** re-implemented),
`store/write-packet.ts::applyCasPacket`,
`store/owner-token.ts::casOwnerTokenFromLock`.

**May NOT touch.** Authority selection (A-2 owns it), the JSON path, migration
control, or `CasResult` translation. It returns the raw `CasResult`.

**This is where the per-cycle full-serialize disappears** — at the flip, not in
U4. Authority writes become O(dirty rows).

**Budget: 260.**

#### A-2 `adapters/whole-state-compat.ts` — the sole authority selector

**Responsibility.** Decide which representation is authoritative and present the
legacy signatures over it. This is the **single permitted production use of
`loadState(): SyncState`** (163 §U3 adapter inventory).

```ts
/** THE authority-selection point. `classifyStateFormat` on `.rbox/state.json`
 * decides: JSON bytes → legacy adapter; the exact 58-byte `Q` → the store. */
export async function loadState(root, stream, warningSink?, heldMutex?): Promise<SyncState>;
export async function loadRawState(root: string): Promise<SyncState | undefined>;
export async function applyStateSavePacket(root, packet, options?): Promise<StateSaveResult>;
export async function ensureTelemetryBindingId(root, stream, randomBytes?): Promise<{ state; bindingId }>;
```

It additionally owns, per sweep T1.1 step 5 and T0.2:

- **stream checking** — the typed `StreamMismatchError` refusal on a
  different-stream read, on both backends. It never manufactures a genesis
  baseline (T0.2's fix; the `read-only.ts` policy wrapper stays deleted).
- **reset recovery and reset-lineage provenance** — shared across both backends.
- **exhaustive raw `CasResult` translation.** SQLite adds four rejection reasons
  and returns a bounded `CasRetryView` rather than whole state, versus the legacy
  union. Materialize against the retry view's **exact token**, close the view,
  and translate. **Do not widen `StateSaveResult`** — existing callers already
  distinguish fatal incarnation loss from recomputable drift, and deferral
  hygiene consumes the rejected winner state.

**May NOT touch.** Migration. The adapter observes `Q` and selects; it never
creates one, never runs M0–M7, and imports nothing from `migration/`. That
direction of the dependency is the point: migration knows about authority,
authority does not know about migration.

**Budget: 320.** This module carries three responsibilities that genuinely
belong together (selection is meaningless without the shared load/reset
semantics and the result translation). If it exceeds 320, the cut is
`whole-state-compat.ts` (selection + legacy signatures) +
`cas-result-translate.ts` (the raw→legacy union mapping), not a widening.

**Call-site inventory.** From this release forward CI counts `loadState()` call
sites; the count may only decrease and must reach zero by U4f. That counter test
ships in U3.

---

## 2. The M0–M7 phase machine

`control.phase` is the **highest durably completed phase**, never the phase about
to start. No phase is pre-published.

| Phase | Precondition | Work | Durable publication point | Crash-resume (163:3232 row) | Typed halts reachable |
|---|---|---|---|---|---|
| — | control absent, exact `L`, no reserved active DB | — | — | Rerun read-only M0 after fresh identity/hash. An inert revision-scoped M0 temp is never adopted; fresh M0 chooses a new id. Special/unreadable temp halts. | `reserved-path` |
| **M0** | The five admission conditions (§1.1 M-4) | Bounded-read `L` first; identity-bracket + hash; choose random migration/authority ids and the exact staging path | Publish M0 after fresh identity/hash. Failure to publish → in-process halt only, no durable phase, JSON authority | Row `M0`: exact source; reserve/emergency absent or exact id-scoped partial/complete; validate/create, rerun admission, publish M1 | `source-oversize`, `memory-admission`, `reserved-path` |
| **M1** | Exact M0; source revalidated | 52× admission, 512 MiB cap, RSS/cgroup budget, advisory `statfs`; validate/claim the B0 reserve or create it; create + fsync the id-bound emergency candidate | Publish M1 only after **both** identities and parents are durable | Row `M1`: source exact; history/fixed backup absent, exact temp, exact current, or a valid prior fixed backup. Resume M2 idempotently. Foreign/special backup halts | `source-oversize`, `memory-admission`, `disk-preflight`, `filesystem-full`, `reserve-foreign` |
| **M2** | Exact M1 | Preamble-prefixed **streaming copy** to `legacy-json/<body-sha>.json` (hard links forbidden); publish/reuse fixed `pre-163-latest.json.bak`, preserving a differing prior under its own verified body hash first | Publish M2 only after both exact backup witnesses and their parents are durable | Row `M2`: `stagingMain` witness `absent` or exact recorded identity. With `absent`, only the sole create-ahead shape may begin/finish M3 identity publication. Sidecar without main halts. An exact committed completion is the sole M3-artifact-ahead form | `filesystem-full`, `reserved-path`, `source-changed` |
| **M3** | Exact M2; source revalidated | `O_EXCL` no-follow create of staging main, fsync file + `.rbox/state`, revalidate identity, **CAS-record it into the M2 revision**; re-run 52×/RSS admission immediately before the sole guarded parse; compute the semantic stream; import all planes/records in one transaction with `migration_completion` **last** | Publish M3 only after the committed completion tuple is reread and exact. WAL sidecars allowed until M4 | Row `M3`: exact committed id-bound staging; its own WAL/SHM may exist. Open only as migration owner, recover, rerun all M4 work | `record-oversize`, `memory-admission`, `filesystem-full` (`SQLITE_FULL`), `verification`, `source-changed` |
| **M4** | Exact M3 | Recover the WAL if needed, `wal_checkpoint(TRUNCATE)` non-busy, close, require `S0`; reopen read-only, recompute SQL semantic stream/counts, validate application/user/DDL ids, `foreign_key_check`, full `integrity_check`; close, require `S0` **again**; fsync DB + state dir; physical-hash under identity bracketing | Publish M4 with the complete proof | Row `M4`: exact physical witness is staging-only, or the M5 rename ran ahead (active-only or both-exact). Revalidate identical hashes/completion, never move active backward, remove only a redundant exact staging name, publish M5. Missing both, nonexact active, or any sidecar halts | `verification`, `filesystem-full`, `durability-indeterminate` |
| **M5** | Exact M4 hash; source/control revalidated | Atomically rename staging → `state.db`; durably remove only a redundant exact staging name; require staging absent and active `S0`; fsync `.rbox/state` after convergence | Publish M5 with the Q-sibling path + 58-byte hash **prebound**, disposition `absent`. **JSON remains authority throughout** | Row `M5 + exact L`: Q sibling is exactly absent (+ the sole zero-byte create-ahead), recorded `building` inode at zero/partial/exact bytes, or recorded exact. Resume only the matching step. Foreign/changed identity halts. If JSON changed → arm C1 before any cleanup | `filesystem-full`, `reserved-path`, `source-changed`, `durability-indeterminate` |
| **M6** | Exact M5; exact Q sibling | `absent → building → exact` via same-phase CAS (each with fsyncs and identity brackets); revalidate live JSON + `.bak` + M5 active completion/hash; **then, as the last operation before the rename with nothing between, re-verify live `state.json` body sha against the M3 source digest under the held `stateLockPath`**; `fs.rename` sibling over `.rbox/state.json`; fsync `.rbox` | Publish M6 with sibling absent + the initial cleanup cursor. **Observing `Q` elects SQLite even if M6 control publication was interrupted** | Row `M5 + exact Q` (the sole M6-artifact-ahead form): SQLite already elected; never rename JSON back. Complete/retry the `.rbox` fsync, publish M6, keep writes blocked as `durability-indeterminate` until it succeeds. Row `M6`: only the current cleanup-intent item may be exact or absent | `filesystem-full`, `reserved-path`, `durability-indeterminate`, `source-changed`, `legacy-write-detected` |
| **M7** | Exact M6; complete nonfinal prefix; final intent item absent; prepared runway | Execute only the correlated M6 cursor; unlink the unused `r+1` halt sibling if exact-terminal and fsync; unlink the control last and fsync | Publish M7 from the prepared `r+2` sibling. Terminal proof: `Q` + matching complete DB + absent control | Row `M7`: durably remove the recorded sibling if needed, then unlink control and fsync. No earlier phase may rerun | `cleanup-deferred`, `durability-indeterminate` |

**Global rules the table encodes and every test must assert:**

- An unhalted control admits only its required artifact or the **explicitly
  printed one-next-phase artifact-ahead** state. Artifact-behind,
  two-phases-ahead, foreign, special, sidecar-without-main, or phase/witness
  mismatch halts with **zero writes** and is never repaired forward.
- `SIGKILL`, power loss, and unobserved crashes **never manufacture a halt**.
  Restart follows the unhalted high-water row.
- A halt never advances phase, retirement prefix, or cleanup prefix.
- Before `Q`, a durable halt suspends migration but not JSON authority. After
  `Q`, a halt can express only `durability-indeterminate` write-blocking or
  `cleanup-deferred`; it can never re-elect JSON.
- The `b..b+4` preparation runway is the **named scoped exception to f6**: a
  caught ENOSPC there publishes no alternate control, reports
  `durableHalt=false`, and stops. Do not "fix" this — it is deliberate, and
  publishing a durable halt there would need the allocation the runway exists to
  avoid.

---

## 3. Exclusivity: entering and proving the window

`MIGRATION-EXCLUSIVITY-v11`. The window is **exclusive ownership of this
workspace's mutation locks** — the workspace sync mutex and `stateLockPath` —
which every `>= 1.11.0` actor acquires before any state write. It is not machine
quiescence.

### 3.1 The two admitted entry points, and only two

```ts
export type MigrationEntryPoint = "upgrade-stop-window" | "foreground-migrate";

/** Proof that the caller is inside an admitted window. Constructible only by
 * the two entry sites; the type is not exported for structural construction. */
export interface MigrationEntryProof {
  readonly entry: MigrationEntryPoint;
  readonly mutex: WorkspaceSyncMutex;      // non-degraded, held
  readonly stateLock: OwnedLock;           // held, `stateLockPath(root)`
}
```

**Entry A — `rbox upgrade`'s per-workspace stop window.** `upgrade-cmd.ts`
already snapshots every live daemon under `~/.rbox/daemons`, stops each, and
restarts the safely-bound desired workspaces (`restartDaemonsAfterUpgrade`).
U3 inserts migration **between** the stop and the restart, per workspace: after
`stopDaemon(root)` returns and before the restart attempt, acquire the mutex and
state lock and call `runMigration`. A workspace whose migration refuses or halts
is reported in the existing per-workspace outcome list and does not block the
other workspaces' restarts.

**Entry B — foreground `rbox migrate`.** A new command. It refuses to run inside
a daemon process, acquires the same two locks, and runs the same controller
with progress rendering. Its `--json` twin emits structured phase progress and
the final outcome. Per the scriptable-path posture, the JSON twin is not
optional — the rig drives migration through it.

**No third entry.** A structural test asserts `runMigration` has exactly two
production call sites, and that `daemon.ts` / the pump reach neither.

### 3.2 Proving the window (`migration-not-exclusive`)

M0 admits only when **both** hold:

1. the caller presents a `MigrationEntryProof` whose `mutex` is non-degraded and
   currently held (`assertSyncMutex`) and whose `stateLock` is currently owned
   (`isOwnerSync()`), for this exact root; **and**
2. M0 independently confirms **no daemon is live for this workspace** from the
   existing pid-record/ownership evidence (`daemon-control.ts`
   `parseDaemonPid` / the mutex's live-blocker evidence).

Otherwise: `migration-not-exclusive`, publishing **no control and creating no
artifact**.

A daemon or foreground command that starts *after* M0's check does not defeat the
window: being `>= 1.11.0`, it blocks on the locks the migration holds until M7
releases them. What pid evidence cannot exclude — a lock-ignoring pre-`1.11.0`
actor — is exactly the drained population of the B0 gate, with the barrier, the
witness, M6's last-instant re-verify, and F2–F6 as the retained backstop.

**Locks are held continuously M0 → M7.** They are not re-acquired per phase. The
`HeldMigrationLocks` value threaded through every module signature is the proof
object; each module asserts, none acquires.

### 3.3 The pre-flip drain gate

U3 does not open until `rbox-admin` version telemetry shows the pre-`1.11.0`
population drained across the 4 external users and 3 fleet hosts (founder
decision 6 — the data source exists; issue #540 is closed invalid). This is a
**gate on opening the unit**, checked before dispatch and re-checked before the
2.0 tag.

---

## 4. The whole-state adapter

```
                     .rbox/state.json
                            │
                  classifyStateFormat()
                            │
        ┌───────── json ────┴──── Q (58 bytes) ─────────┐
        ▼                                               ▼
adapters/legacy-json-store.ts                 store-facade.ts (SQLite)
  loadRawState / loadState                      openReadSnapshot
  applyStateSavePacket (JSON CAS)               adapters/sqlite-state-save.ts
                                                  → applyCasPacket
        └──────────────► adapters/whole-state-compat.ts ◄──────┘
                    (the SOLE selector; legacy signatures out)
```

- **Writes go native.** `applyStateSavePacket` → `applySavePacketToStore` →
  sealed stages → `applyCasPacket`. Set-diffed into rows, O(dirty rows) at the
  flip. The per-cycle full-serialize disappears here.
- **Reads stay whole.** `loadState` / `loadRawState` materialize a complete
  `SyncState` from rows via `openReadSnapshot`, preserving every caller
  signature — at the cost of keeping the materialization peak until U4.
- **The selection point is singular.** No other production module may branch on
  `Q`. A structural test pins `classifyStateFormat`'s production callers to
  `whole-state-compat.ts` plus the B0 barrier sites (`assertStateReadable` /
  `assertStatePublishable`, which are refusals, not selections).
- **`StateSaveResult` is not widened.** SQLite's four extra rejection reasons and
  its `CasRetryView` are translated inside the adapter, exhaustively, with a test
  per raw reason.
- **Genesis.** `absent/absent/absent` uses the staged DB + `Q` path (163's M0
  matrix last-but-two row) and is allowed only with fenced
  config/incarnation/reset evidence. Genesis-path validation on a throwaway
  workspace with a 2.0 dev build is the **first fleet checkpoint** and an
  explicit U3 deliverable (§6.7).

---

## 5. Halts: copy and the non-interactive twin

Every new halt gets a member in `MigrationHaltCode` and an entry in
`MIGRATION_HALT_COPY`. The `satisfies Record<MigrationHaltCode, MigrationHaltCopy>`
already merged in `doctor-state-plane.ts` is the gate: a code without copy does
not compile. Copy is written for a non-technical user — two of the four external
users are.

**Refusals** (`admission.ts`) publish nothing and are freely retried.
**Halts** (`StateMigrationHaltError`) are durable when publication succeeds and
suspend migration until `rbox doctor --retry-state-migration`.

| Code | Kind | `human.problem` (plain English) | `human.safety` | `human.command` | `machine.id` / severity |
|---|---|---|---|---|---|
| `degraded-fence` | refusal | "This workspace's folder can't be safely locked on this disk, so rbox won't move its state here." | "Nothing changed. Your files and your sync are unaffected." | `rbox doctor` | `state-migration/degraded-fence` · warn |
| `workspace-busy` | refusal | "Something else in this workspace was still running." | "Nothing changed." | `rbox migrate` (again) | `state-migration/workspace-busy` · info |
| `quarantine-pending` | refusal | "There's a paused state repair to finish first." | "Nothing changed. Your data is intact." | `rbox doctor --resume-state-reset` | `state-migration/quarantine-pending` · warn |
| `barrier-witness-missing` | refusal | "This workspace was last written by an older rbox. It needs one ordinary sync with this version first." | "Nothing changed." | `rbox sync` | `state-migration/barrier-witness-missing` · info |
| `migration-not-exclusive` | refusal | "rbox only moves state while nothing else is using this workspace." | "Nothing changed." | `rbox stop` then `rbox migrate` | `state-migration/not-exclusive` · warn |
| `reserve-foreign` | refusal | "A file rbox reserved for safety doesn't look like rbox wrote it, so rbox left it alone." | "Nothing was deleted or changed." | `rbox doctor` | `state-migration/reserve-foreign` · warn |
| `source-oversize` | halt | "This workspace's state file is larger than rbox can convert (names the measured size)." | "Nothing changed; the workspace keeps working on the old format." | Run once on a machine with more memory, or re-adopt the workspace | `state-migration/source-oversize` · error |
| `memory-admission` | halt | "Converting this workspace needs more memory than this machine can spare (names measured size and required headroom)." | "Nothing changed." | Same two remedies; `RBOX_RESET_PARSE_BUDGET_BYTES` is the sanctioned escape hatch, printed with its exact value | `state-migration/memory-admission` · error |
| `record-oversize` | halt | "One entry in this workspace's state is too large to convert." | "Nothing changed." | `rbox doctor` | `state-migration/record-oversize` · error |
| `disk-preflight` | halt | "There isn't enough free disk space to convert safely (names required vs available)." | "Nothing changed." | Free space, then `rbox migrate` | `state-migration/disk-preflight` · error |
| `filesystem-full` | halt | "The disk filled up partway through. rbox stopped instead of leaving a half-converted workspace." | "Your old state is still the one in use and is intact." | Free space, then `rbox doctor --retry-state-migration` | `state-migration/filesystem-full` · error |
| `source-changed` | halt | "The workspace's state changed while rbox was converting it, so rbox threw the partial work away." | "Your current state is untouched and still in use." | `rbox migrate` | `state-migration/source-changed` · warn |
| `legacy-write-detected` | halt | "An older rbox wrote to this workspace during the conversion. rbox stopped before switching over." | "Your current state is untouched and still in use." | Upgrade every machine to 1.11.0+, then `rbox migrate` | `state-migration/legacy-write-detected` · error |
| `verification` | halt | "The converted state didn't match the original exactly, so rbox refused to switch to it." | "Your original state is untouched and still in use. A copy of it is saved." | `rbox doctor` (prints the backup path) | `state-migration/verification` · error |
| `reserved-path` | halt | "rbox found an unexpected file where it keeps its state and won't touch it." | "Nothing was deleted. Your state is unaffected." | `rbox doctor` (names the exact path) | `state-migration/reserved-path` · error |
| `durability-indeterminate` | halt | "rbox can't confirm the last write reached the disk, so it paused writing." | "No data was lost; rbox is being cautious." | `rbox doctor --retry-state-migration` | `state-migration/durability-indeterminate` · error |
| `cleanup-deferred` | halt | "The conversion finished; tidying up a leftover file didn't." | "Your workspace is fully working on the new format." | `rbox doctor --retry-state-migration` | `state-migration/cleanup-deferred` · warn |
| `legacy-overwrite-after-Q` | anomaly | "An older rbox overwrote the marker that says this workspace uses the new format." | "A copy of your state is saved (names the hash-addressed backup)." | Re-adopt per the printed procedure | `state-migration/legacy-overwrite-after-q` · error |

**Rules the copy is held to:**

- Never advise deleting `Q`. Never advise restoring a backup — after `Q` the only
  supported recovery is re-adoption, and doctor prints exactly that procedure on
  any post-`Q` authority halt.
- Every entry's `command` is a real, non-interactive-twinned command.
- The `migrating` health state (`rbox status`) renders in plain English past 5 s
  per phase, with the `--json` twin emitting structured phase progress.

---

## 6. Exit gates

Every gate below is a merge gate for the unit, not a nice-to-have. A gate that
cannot be run does not count as passed (see the sweep's own validation note about
`EROFS` non-evidence).

### 6.1 F1–F6 fixtures

Reframed by v11 as **excluded scenarios asserted by fixture** — they stay because
they are cheap, they pin B0's shipped machinery (#539), and a fixture is the only
thing that stops a documented outcome from silently drifting.

| Fixture | Construction | Assertion | Negative control |
|---|---|---|---|
| **F1** | Degraded-unlocked workspace + live legacy writer | M0 refuses `degraded-fence`; **no control published, no artifact created** | With the fence predicate removed, M0 proceeds — proving F1 exercises the fence |
| **F2** | `forceLegacy` writer on a **lockable** filesystem, suspended after its state read; full M0–M7; writer resumes | Writer fails closed with `StateFormatTooNewError`; `Q` byte-identical | With the barrier and lock-entry restriction removed, the same fixture **demonstrably destroys `Q`** |
| **F3** | F2's shape, but the writer is the **published, signed 1.10.x artifact**, released strictly after M6's rename | The *documented* outcome: `Q` destroyed; doctor reports `legacy-overwrite-after-Q` naming the immutable hash-addressed backup | — |
| **F4** | Two concurrent degraded writers | The **refusal**, not last-writer-wins | — |
| **F5** | Signed 1.10.x, `forceLegacy`, lockable fs, released so its rename lands inside M6's `check → rename` microwindow — driven by the `onStep` `"before-rename"` seam (`fsutil.ts:46`), **not by sleeping** | After M7: `state.json` is `Q`; DB and both M2 backups carry the *older* source digest; the writer's document is absent from every artifact; doctor emits **no anomaly** (the silence is asserted) | Companion: released one window *earlier* (before the body-hash re-verify), M6 must refuse `legacy-write-detected`, not rename, JSON still authoritative |
| **F6** | F5 extended: the lost save was the BASE advancement (writer had applied remote `B1`); revert the file to `B0`; run the post-flip pull against remote `B1` | The documented silent overwrite: `reconcile` returns an ordinary `write`, `apply` replaces the file with no conflict copy, no anomaly | — |

F5 and F6 assert **silence**. A future mechanism that starts detecting these
turns them red and forces the doc to be updated rather than letting the claim
drift. That is the point.

### 6.2 The crash/disk-full/resume table, row by row

Every row of 163:3232 is a test. Fault injection covers (163:3267):

- before/after every transaction, table, commit, checkpoint, close, verify,
  rename, and fsync;
- every M0–M7 control publication and its old/new record;
- the M2 same-phase staging-identity CAS; staging file + parent fsync;
- the Q-sibling `absent` / create-ahead / `building` / `exact` revisions; the Q
  rename and both power-loss images;
- every C1 entry/intent/unlink/parent-fsync/prefix/terminal-control boundary;
- every M6 cleanup intent/unlink/parent-fsync/prefix;
- the `b..b+4` runway: before/after each exclusive create, file fsync, parent
  fsync, building-identity CAS, every write/truncate prefix, exact reread, and
  exact-disposition CAS — restarting every printed row and rejecting
  disappearance, replacement inode, special type, wrong order, wrong
  revision/bytes, or an extra pair, each with a **byte-for-byte zero-write
  snapshot**;
- injected OS `ENOSPC` and `SQLITE_FULL` at every M0–M7 write class including
  reserve/halt publication and cleanup, and the M2 preamble-prefixed streaming
  copy (there is no hard-link fallback left to inject);
- retirement instantiated at M2 absent/incomplete/committed staging, M3 with each
  owned sidecar subset, every M4 form, and M5 with absent/building/exact sibling;
- valid-prior and foreign backup collisions; exact admitted/refused 512 MiB and
  >512 MiB; source mutation before M6; stale/foreign DB/control; repeated
  kill-switch JSON advances with immutable backup history; marker durability
  ambiguity; min/max RepoRecord codec admission; non-durable in-process
  suppression; old-binary read/write refusal.

**Reuse, do not rebuild.** U2 shipped `reset/crash-rig-child.ts` +
`crash-rig-model.ts` + `trace-fs.ts` (process kill and power-cut snapshots at
labeled boundaries). The migration crash rig is a second scenario set against the
same harness, not a second harness.

### 6.3 Abort — differential-asserted

There is one supported abort procedure and it is whole-workspace.

- **Before `Q` (any halt M0–M5):** `rbox doctor --abort-state-migration`. Under
  the complete lock set it runs the C1 retirement vector (M-7) to completion
  against its own migration id, unlinks the control **last**, and leaves exact
  `L` untouched and authoritative.
- **After `Q`:** no in-place downgrade. Doctor prints the re-adoption procedure.

**Gate.** Abort restores a workspace **indistinguishable from pre-migration**,
asserted differentially: snapshot `.rbox` byte-for-byte (paths, modes, sizes,
content hashes, and `dev`/`ino` where stable) before M0; abort from each of M0,
M1, M2, M3, M4, M5; assert the post-abort tree equals the pre-migration tree
modulo exactly the artifacts 163 says survive (the immutable backup history and
the fixed `pre-163-latest.json.bak`, both preamble-prefixed, plus the B0
reserve, which is a named inert non-reset member that survives on workspaces that
never migrate). Anything else in the diff fails the gate.

### 6.4 Import fidelity

- `sourceSemanticDigest == sqlRoundTripSemanticDigest` on **corpus-112k** and on
  each differential fixture.
- When manifest meta is present, the canonical reconstructed manifest hash is
  independently checked.
- Min/max `RepoRecord` codec admission; the `resolutionIntent` strip-before-digest
  disposition; the DDL-column ↔ `keyof RepoRecord` bijection minus the one named
  strip member.
- Exact admitted 512 MiB and refused >512 MiB.

### 6.5 The no-regression harness (backend-first condition 1)

**The flip may not ship unless trusted `rbox status` latency and daemon
steady-state RSS on corpus-112k are no worse than the 1.x baseline.** The adapter
keeps whole-state materialization and *adds* a SQLite page cache, so this is a
real risk, not a formality.

Protocol (reusing the ratified U5 kill-criterion protocol so the numbers are
comparable): 100 samples after 10 warmups, void-on-untrusted; RSS sampled over 5
minutes and judged on the maximum. Measured **pre-flip and post-flip on the same
host, same corpus, same binary build**, so the delta is the flip and nothing
else.

Ratified reference thresholds (163 v7 row 10): `status` p50 ≤ 200 ms, p95 ≤
400 ms, daemon RSS ≤ 1.5 GB. The U3 gate is the **pre/post delta**, not the
absolute — a regression inside the absolute thresholds still blocks.

**Migration duration budget:** complete M0–M7 in **≤ 60 s on corpus-112k**. Any
phase over 5 s must print progress. Exceeding the budget is a reportable finding,
not a silent success.

### 6.6 The dual-binary differential rig

- **Per-device binary overrides — already plumbed.** Verified on `main`:
  `scripts/rig/lib/binary.ts` exports `resolveRigBinaryPaths` (`--binary-a` /
  `--binary-b`, with the exact-absolute / regular-non-symlink / canonical /
  executable validation) and `prepareRigBinarySelection` stages each unique path
  once into `{a, b}`; `rig.ts` mounts `binaries.a.stagedDirectory` per device.
  163's "verified: `--binary` is a single global override" is **stale**. What
  remains is the two items below.
- **Version-difference assertion.** The scenario asserts the two devices report
  different `rbox --version` strings, so a silent single-binary run cannot
  masquerade as a differential.
- **Pinned 1.x provenance.** The 1.x side runs the **published, signed release
  artifact for `1.11.0`**, fetched from `rbox-releases` and verified against its
  recorded digest and detached signature — never a local build. The digest is
  recorded in the scenario so a re-run years later is reproducible.
- **Scenario:** one workspace, one candidate host and one 1.11.0 host, pull/push
  interleaved, including an ignore-rule change, a tracked-repo change, and a
  mass-delete-shaped change. Neither host may observe a spurious delete, a lost
  deferral, or a divergent manifest.
- **Same-corpus manifest diff:** corpus-112k pushed by 1.11.0 and by the
  candidate produces identical manifests (files, ordering, Git sections,
  deferral/carry decisions) modulo timestamps. Any difference is fixed or
  explicitly ratified; an unexplained one blocks the flip.

The flip is **not exempt** from this gate. It is the run where a difference is
*least expected* and therefore most informative — the backend, codecs, CAS
admission path, and reset/quarantine conversion all change underneath a
byte-identical engine.

### 6.7 First fleet checkpoint — the genesis path

A 2.0 dev build running a **throwaway workspace through the genesis path**
(`absent/absent/absent`). Reachable as soon as the store and reset support exist,
before migration is enabled on any real workspace. This is an explicit U3
deliverable and the first go/no-go the founder can personally observe. Per the
d169 rule, it validates on a dev build with throwaway accounts before any prod
release.

### 6.8 Structural / inventory gates

- Adapter inventory: `loadState()` production call sites counted from this
  release forward; may only decrease; zero by U4f.
- `authority.ts` imports no `node:fs`, `node:crypto`, or `bun:sqlite`.
- `classifier.ts` performs no writes (import-graph assertion + byte-for-byte
  `.rbox` snapshot on every corruption row).
- Exactly two production call sites of `runMigration`.
- No production `StateSavePacket` carries `authority.kind === "migration"`;
  migration authority originates only in `migration/import-json.ts` (T0.1's
  inventory contract — inherited, re-asserted here).
- `legacy-writer-live` and paired-interval sampling appear nowhere in `src/`.
- Every file ≤400 lines / 25 KiB (CI guard); 301–399 carries a review note.
- `docs/CODEMAP.md` gains one ownership line per new module in the same change.

---

## 7. Sequencing and the parallel-dispatch plan

**Gate 0 — before any dispatch.** T0.1 (`origin/fix/base-proof-authority`) merges.
The drain gate (§3.3) reads green off `rbox-admin` version telemetry. The `2.0`
branch opens from `main`.

Waves, with dependencies. Each PR is one agent, one self-contained spec, one
worktree (`isolation: 'worktree'` for the parallel lanes).

### Wave 1 — foundation, fully parallel (4 agents)

| Lane | Deliverable | Depends on | Suggested routing |
|---|---|---|---|
| **1A** | M-1 `control-codec.ts` + its round-trip/rejection tests | — | codex (bulk, spec-complete) |
| **1B** | M-2 `control-publication.ts` + publication crash fixtures | 1A's types (stub the record shape; integrate at merge) | **opus** — fail-closed seam |
| **1C** | A-1 `adapters/sqlite-state-save.ts` + write-path differential tests | merged U1b only | codex |
| **1D** | Rig: `rbox --version`-differs scenario assertion + pinned signed 1.11.0 artifact fetch/digest/signature verification (per-device mounts already exist — see Q2) | merged only | codex |

1A and 1B are the tightest coupling in the wave; if the review prefers, they
collapse into one lane at the cost of parallelism.

### Wave 2 — observation and admission, parallel (3 agents)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **2A** | M-3 `classifier.ts` + the table-driven row tests + zero-write snapshots | 1A | **opus** — the matrix is the safety net |
| **2B** | M-4 `admission.ts` + the five-condition tests + F1 + F4 | 1A | **opus** — fail-closed |
| **2C** | A-2 `adapters/whole-state-compat.ts` + `CasResult` translation tests + the call-site counter | 1C | **opus** — sole authority selector |

### Wave 3 — the phase bodies, parallel (3 agents)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **3A** | M-5 `import-json.ts` (M2–M4) + fidelity gate §6.4 | 1A, 1B, **T0.1** | codex (bulk, mechanical, well-specified) |
| **3B** | M-7 `retirement.ts` (C1) + its cursor tests + the abort differential §6.3 | 1A, 1B, 2A | **opus** |
| **3C** | M-8 `cleanup.ts` (M6 cursor + `b..b+4` runway + M7) + runway fault injection | 1A, 1B | **opus** — hardest correlation in the unit |

### Wave 4 — the flip, serial (1 agent)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **4A** | M-6 `finalize.ts` (M5 + M6) + F2/F3/F5/F6 | 1A, 1B, 2A, 2B, 3A, 3B | **opus, alone.** No parallel work touches this file |

### Wave 5 — assembly and gates, partially parallel (3 agents)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **5A** | M-9 `authority.ts` + the two entry points (`upgrade` stop window, `rbox migrate` + `--json`) + progress UX | all | **opus** |
| **5B** | Halt taxonomy: fill `MigrationHaltCode`, `MIGRATION_HALT_COPY`, doctor rendering, `--abort-state-migration`, `--retry-state-migration` | 2B, 4A | **opus** — user-facing copy needs taste ≥ 7 |
| **5C** | corpus-112k no-regression harness + migration duration budget + the differential rig scenario | 1D | codex |

### Wave 6 — validation, serial

Genesis-path fleet checkpoint on a dev build (§6.7) → full crash-rig sweep →
`/simplify` diff-scoped over the whole unit → final serial review → merge to the
`2.0` branch → dual-binary differential against signed 1.11.0 → tag.

**Founder-rule reminders that bind the dispatch:** codex always reviews (multi-
model alignment); implementation routes by risk — bulk to codex, fail-closed
seams to opus; review fan-outs default to opus at medium effort; 2–4 independent
reviewers in parallel, synthesized, then **one final serial review** before
ALIGNED; rig the FAST suite every ~3–4 merged sync-plane PRs and before any tag.

---

## 8. Open questions and risks for the review to resolve

**Q1 (blocking) — T0.1 is unmerged.** `migration/base-proof.ts`,
`migration/import-stage.ts`, and `withMigrationImporter` live on
`origin/fix/base-proof-authority`. Wave 3A cannot start without them, and the
sweep's NO-GO verdict is conditioned on all four Tier 0 gates. Does U3 dispatch
wait for that merge, or does Wave 1 + Wave 2 start against `main` on the
assumption T0.1 lands before Wave 3? My position: Waves 1–2 may start (they touch
none of it); Wave 3A does not.

**Q2 — RESOLVED while writing this doc; recorded so the review does not re-derive
it.** 163's dual-binary deliverable is **already mostly built**:
`resolveRigBinaryPaths` + `prepareRigBinarySelection` give per-device staged
artifacts and `rig.ts` mounts them per device. 163's "verified: `--binary` is a
single global override" no longer describes `main`. Lane 1D therefore shrinks to
two items: the `rbox --version`-differs scenario assertion, and fetching +
digest/signature-verifying the published signed `1.11.0` artifact from
`rbox-releases` with the digest pinned in the scenario. The design doc's
deliverable text should be corrected in 163 (or noted here as superseded) so the
next reader is not told to build what exists.

**Q3 — where does `retryHaltedMigration`'s lock acquisition live?** Doctor takes
"the identical locks" and delegates. Does doctor construct a
`MigrationEntryProof` (making it a *third* entry point, which §3.1's structural
test forbids), or does `retryHaltedMigration` take a distinct `DoctorRetryProof`?
I have specified the latter, but the design says "invokes this same controller",
and two proof types is one more moving part than the founder's bar likes. A
third option: `MigrationEntryPoint` gains a `"doctor-retry"` member and the
structural test counts three call sites. Review should pick one.

**Q4 — control/staging paths: `paths.ts` or `control-publication.ts`?** T1.1 step
1 said `paths.ts` centralizes "migration-control/staging" paths; the merged
`paths.ts` (25 lines) does not contain them yet. Putting them in `paths.ts` keeps
path policy in one place and matches the merged intent; putting them in
`control-publication.ts` keeps the revision arithmetic next to its only consumer.
I lean `paths.ts` for the two fixed paths (`migration-v1.json`, the staging
prefix) and `control-publication.ts` for `revisionScopedPath`, since the revision
interval is a publication concept. Not settled.

**Q5 — is `import-json.ts` really one module?** M2, M3, and M4 are three
independent fsync choreographies sharing only a control record. Budgeting them at
300 combined may be optimistic. I have named the fallback split
(`preserve-source` / `import-json` / `prove-staging`). Should the design commit to
the three-module split up front — making it a **twelve**-module unit, not nine —
rather than discovering it at implementation time? The same question applies to
`cleanup.ts` vs a separate `future-controls.ts`. Splitting up front costs
nothing and buys parallelism; splitting late costs a rebase.

**Q6 — what does `rbox migrate` do on an already-migrated workspace?** Design 163
covers the `Q`-present rows for the *controller*, but not the UX of a user typing
`rbox migrate` on a workspace already at `Q` with an absent control. My reading:
an ordinary success-shaped no-op ("this workspace already uses the new format"),
exit 0, not a refusal — but that is UX invention, not design, and the founder's
non-developer copy bar applies.

**Q7 — daemon behavior across the flip.** The default-on daemon catches
`StateMigrationHaltError` and enters `migration-halted`. But under v11 the daemon
never *runs* a migration. So `migration-halted` is now reached only by a daemon
that *starts* on a workspace with a durable halt already on disk. Is
`migration-halted` still the right health-state name, and should the daemon
refuse to start at all, or start read-only-ish and serve status/doctor? 163 says
"remains alive … suppresses every subsequent pump migration attempt … serves
status/doctor", which was written before v11 removed pump migration entirely.
There may be mechanism to **delete** here.

**Q8 — does the no-regression gate need a frozen machine profile?** The one
remaining open founder input blocks U5's kill criterion. The U3 gate is a
pre/post delta on one host, which is weaker and does not obviously need the
frozen profile — but if the reviewer thinks a delta on an unfrozen host is not
falsifiable, the gate needs a machine spec and the founder input becomes a U3
blocker too.

### Standing risks (named, not questions)

- **R1 — `whole-state-compat.ts` is the widest module in the unit at 320 lines
  and three responsibilities.** It is the one place I would expect a review to
  find over-scope. The fallback split is named in §1.2.
- **R2 — the no-regression gate is a real risk, not a formality.** Whole-state
  materialization *plus* a SQLite page cache on the same host. If it fails, the
  remedies are (a) tune the page cache, (b) start U4's cursor conversion early
  for `status`'s read path specifically, or (c) do not ship the flip. Option (c)
  must stay on the table; per the founder's revert rule, "net-unhelpful gets
  reverted" is a first-class outcome.
- **R3 — the F5/F6 fixtures assert silence.** They are the easiest tests in the
  unit for a future contributor to "fix" into passing differently. Their comments
  must say, in one line each, that the silence is the assertion.
- **R4 — 2,440 production lines across 11 new modules, one-way and
  unrevertible-after-`Q`.** This is the largest fail-closed surface rbox has
  shipped. The mitigation is the dispatch plan (small self-contained specs, fresh
  agent per lane) plus the one serial review before ALIGNED — not heroics inside
  any single lane.
