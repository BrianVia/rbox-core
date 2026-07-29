# 222 — U3 implementation design: the migration unit, the `Q` flip, and the whole-state adapter

> Status: **r2**, revised against the codex adversarial review of r1 (verdict
> NOT-ALIGNED, 6 CRITICAL + 11 HIGH/ruling items). Every finding is folded below;
> §9 records what changed per finding and the one place I do not comply.
> Not implementation authority until Claude + codex align.
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
> Operationally, and refined by the review: a module owns **one cohesive
> protocol outcome**, not literally one function or one phase. Prefer deleting
> mechanism to adding it. Splitting a module is not free — it adds interfaces
> and merge surfaces — so split only on measured evidence, never to manufacture
> parallelism.

## 0. What this unit is, and what it is not

U3 carries the **one-way authority change** from `.rbox/state.json` to
`.rbox/state/state.db`, and nothing else. The scan/reconcile/apply engine is
byte-identical across the flip; it reads and writes through a whole-state
compatibility adapter over the U1 store.

U3 **is**: the nine-module M0–M7 machine (sweep-4 T1.3); the two deferred
adapters (T1.1 steps 4–5); the genesis path (§1.3); the two admitted entry
points plus one doctor-authorized retry; the halt/refusal/disposition taxonomy
with plain-English copy and a non-interactive twin; and the exit gates.

U3 is **not**: ambient or on-boot migration in any form; the paired-interval
live-writer sampling (v11 deletes it — do not build it); a generic capability
framework; any engine port.

**Branch.** U3 is the only unit that opens the `2.0` branch. This document does
not open it.

### 0.1 Foundation verified merged on `origin/main` (`1a78fa32`, re-verified this round)

| Merged | Provides |
|---|---|
| `state-plane/paths.ts` (#579) | `statePath`, `stateLockPath`, `stateIncarnationPath`, `sqliteResetPaths`. **25 lines — U3 adds every migration path constructor here (Q4 ruling).** |
| `adapters/legacy-json-store.ts` (#579) | `loadRawState`, `loadState`, `applyStateSavePacket`, `saveState`, `saveStateUnsafeLegacyOrTest`, `ensureTelemetryBindingId`, `installGenesisResetStateUnderHeldLock` |
| `store/owner-token.ts` (#579) | `casOwnerTokenFromLock(lock): OwnedLockCasToken` — sole production mint site |
| `store/open.ts::initializeStateStore(file, install)` (#577) | Claimed-file initializer: `O_EXCL` create, pragmas, DDL, caller's `install(db)` in the same transaction, validation, cleanup on failure |
| `schema/application.ts` (#577) | `applySchemaV1` (behavior-free DDL) split from `installGenesisLineage` |
| `errors.ts` (#578) | `StateDataCorruptionError`, `decodeAuthorityRow`, `ProoflessBaseError`, `StateFormatTooNewError`, `StreamMismatchError`, `StateWriteRefusedError` |
| `codecs/git-section.ts` (#578) | Git-section codec |
| `doctor-state-plane.ts` + `migration/health.ts` (#576) | `MigrationHaltCode = never`, `MigrationHealth`, `MIGRATION_HALT_COPY = {} satisfies Record<MigrationHaltCode, MigrationHaltCopy>` |
| `authority-marker.ts` (B0) | `AUTHORITY_MARKER_BYTES = 58`, `classifyStateFormat`, `assertStateReadable`, `assertStatePublishable` |
| `migration/reserve.ts` (B0) | 128-byte header, `ensureStateReserve`, `inspectStateReserve`, `parseReserveHeader` |
| `migration/last-writer-witness.ts` (B0) | `BARRIER_DOWNGRADE_FLOOR = "1.11.0"`, `verifyLastWriterWitness` |
| `reset/index.ts` (U2) | `sqliteResetFacade`, `hasDbArtifactResetCapability` |
| `reset-health.ts` (U2) | `ResetHaltHealthV1`, `readResetHaltHealth`, `writeResetHaltHealth`, `clearResetHaltHealth` — **the precedent U3's standing-halt projection copies (finding 14)** |
| `store/*` (U1a/U1b) | `applyCasPacket`, `CasPacket`, `StageLock`, sealed stages, transition stages, `buildCasRetryView`, `read-snapshot`, `local-plane` |
| `scripts/rig/lib/binary.ts` | `resolveRigBinaryPaths` (`--binary-a`/`--binary-b`), `prepareRigBinarySelection` → per-device staged artifacts; `rig.ts` mounts per device |

### 0.2 NOT merged — a hard prerequisite (RISK, retained)

`migration/base-proof.ts`, `migration/import-stage.ts`
(`beginMigrationImportStage`), `store/transition-admission.ts::withMigrationImporter`,
and `sync-git/base-proof-selection.ts` are on **PR #574**
(`origin/fix/base-proof-authority`, sweep-4 **T0.1**).

**Re-verified this round, after the review's conditional instruction to delete
this section if `main` had advanced:** `origin/main` is still `1a78fa32`;
`gh pr view 574` reports `state: OPEN`, `mergedAt: null`;
`src/cli/state-plane/migration/` contains only `health.ts`, `reserve.ts`,
`last-writer-witness.ts` and their tests. **T0.1 is not merged.** No wave starts
until it does (§7 Gate 0). See §9's closing note.

### 0.3 Claims in r1 that were wrong, corrected here

The review caught four places where r1 asserted a seam that does not exist. All
verified against the checkout this round:

| r1 claimed | Reality on `1a78fa32` | Consequence |
|---|---|---|
| `stateSemanticDigest` serves "both sides of the round trip" | `stateSemanticDigest(db: Database)` — **SQL projection only**. There is no legacy-object normalization or JSON-side digest entry point anywhere | U3 must **build** the JSON side. Owner assigned in §1.1 M-5 |
| `assertSyncMutex` proves the window | `assertSyncMutex` (`sync-mutex.ts:272`) is a shape check; **`assertHealthyOwnedSyncMutex` (`:325`) is the one that verifies live ownership** | §3 uses the latter |
| The daemon "catches `StateMigrationHaltError`" and enters `migration-halted` | No `StateMigrationHaltError`, no `migration-halted`, no migration pump, and no such catch exists. There is also no `StateAuthorityCorruptError` | Deleted (§9 finding 14). Standing halts project into status/doctor the way `reset-health.ts` already does |
| Dual-binary rig plumbing is a U3 deliverable (163's text) | Per-device staging and mounting already exist | Lane reduced to two items (§6.6) |

---

## 1. Module-by-module

Design 163:3994: production files **target ≤300 nonblank lines**, **301–399 is
permitted with an explicit review note**, and **400 lines or 25 KiB is the hard
CI failure**. The review's ruling (finding 13 / Q5) is adopted: **nine modules,
not twelve.** Sweep T1.3 mandates exactly these nine and deliberately groups
M2–M4 and M6-cleanup/runway/M7 because each group is one protocol outcome. The
fallback splits named in r1 are retained only as contingency, to be taken on
measured line-count evidence and never to create parallelism.

Every module owes its one-line `docs/CODEMAP.md` ownership rule in the same
change.

### 1.1 The nine migration modules

All under `src/cli/state-plane/migration/`.

| # | Module | The one protocol outcome it owns | Budget |
|---|---|---|---:|
| M-1 | `control-codec.ts` | The control record as a value: closed union, canonical bytes, pure predicates | 300 |
| M-2 | `control-publication.ts` | Every durable transition of the canonical control file | 260 |
| M-3 | `classifier.ts` | One admitted observation row, without mutating anything | 320 |
| M-4 | `admission.ts` | May a migration (or genesis) begin/continue right now | 300 |
| M-5 | `import-json.ts` | A **proven staging DB** derived from an admitted source | 340 |
| M-6 | `finalize.ts` | The prepared DB becomes authority — the one flip | 300 |
| M-7 | `retirement.ts` | C1: a superseded migration's artifacts are gone | 260 |
| M-8 | `cleanup.ts` | Terminalization: cursor, runway, M7 | 360 |
| M-9 | `authority.ts` | Sequencing over typed receipts. No filesystem primitives | 240 |

Budgets are ceilings. Three (M-3, M-5, M-8) sit in the 301–399 band that requires
a review note; that note is this paragraph: each is one cohesive outcome that 163
specifies as a single correlated machine, and cutting it would split a durable
correlation across a module boundary — the exact failure mode finding 3 caught in
r1. Total production budget: **2,680 lines**.

---

#### M-1 `migration/control-codec.ts` — the control record as a value

**Outcome.** A control is a value with canonical bytes and total predicates over
it. Pure: no `fs`, no `bun:sqlite`, no clock, no randomness.

```ts
export const CONTROL_MAX_BYTES = 65_536;
export type MigrationPhase = "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";

export type HaltResourceDisposition =
  | "not-created" | "available" | "consumed-for-halt"
  | "retirement-intent" | "retirement-absent"
  | "cleanup-intent" | "cleanup-absent" | "retired";

export interface MigrationControl { /* the exact-schema closed record (163:2612) */ }

export function encodeMigrationControl(control: MigrationControl): Buffer;
/** Strict. Unknown, extra, or missing fields REJECT (163:2612). */
export function decodeMigrationControl(bytes: Uint8Array): MigrationControl;

/** The post-`Q` write fence, as a pure predicate. TRUE only for a durable
 * `durability-indeterminate` halt; `cleanup-deferred` is explicitly FALSE
 * (163:3343). Consumed by A-2 at the SQLite save boundary — finding 5. */
export function blocksSqliteWrites(control: MigrationControl): boolean;

/** Is this the one halt whose clear is a promotion, not a CAS-clear? */
export function isFinalIntentPromotedHalt(control: MigrationControl): boolean;
```

**May NOT touch.** The filesystem, SQLite, the state document, or any notion of
"current" — it has no idea which control is on disk. It computes no paths (Q4:
`paths.ts` owns them).

**Notes.** The eight witness shapes (163:2663) are eight variants of one union
keyed on `phase`. `futureControls` is part of the M6 witness, not a top-level
optional, so it does not relax unknown-field rejection. Encoding must be
canonical — the `b..b+4` runway hashes prepared bytes and compares them.

---

#### M-2 `migration/control-publication.ts` — every durable control transition

**Outcome.** The canonical control file changes only through this module. r1
violated this: `cleanup.ts` renamed prepared siblings over the control directly.
163:2663 says "All control writes call one helper," and that guarantee includes
the two prepared-sibling promotions.

```ts
export interface PublishExpectation {
  migrationId: string | "absent";
  revision: number | "absent";
}

/** The ordinary path: exclusive revision-scoped sibling → write canonical bytes
 * → file fsync → rename over control → fsync `.rbox/state` → exact reread.
 * Caller must hold the complete lock set; this asserts, never acquires. */
export function publishMigrationControl(
  root: string, expect: PublishExpectation, next: MigrationControl, locks: HeldMigrationLocks,
): MigrationControl;

/** Render a prepared future-control sibling WITHOUT publishing it (`b..b+4`).
 * Returns its exact identity for the ledger CAS. */
export function renderPreparedControl(
  root: string, revision: number, next: MigrationControl, locks: HeldMigrationLocks,
): PreparedControlIdentity;

/** FINDING 3 — the allocation-free promotion. Rename an ALREADY-EXACT prepared
 * sibling over the canonical control under `expect`, fsync `.rbox/state`, and
 * reread exactly. Allocates nothing: no temp, no write, no truncate. `cleanup`
 * decides WHEN; this decides HOW, so the sole-publisher guarantee holds on the
 * halted-M6 and M7 branches too. */
export function promotePreparedControl(
  root: string, expect: PublishExpectation, prepared: PreparedControlIdentity, locks: HeldMigrationLocks,
): MigrationControl;

/** FINDING 4 — durable halt publication, including its runway. Publishes the
 * SAME phase with an incremented revision, the exact
 * `halt:{reason,phase,underlyingCode,required,available}`, and updated
 * `haltResources`. If publication needs space, it releases/unlinks the exact
 * previously-available reserve and records it `consumed-for-halt`. It NEVER
 * consumes a retirement- or cleanup-vector item as runway, and never relabels a
 * current intent. On failure it returns `durableHalt: false` and the caller
 * performs no further migration write. */
export function publishMigrationHalt(
  root: string, control: MigrationControl, halt: MigrationHalt, locks: HeldMigrationLocks,
): { control: MigrationControl; durableHalt: boolean };

/** Bounded read + strict decode of the canonical control. No mutation. */
export function readCanonicalControl(root: string): MigrationControl | undefined;
```

**May NOT touch.** Phase logic, artifact cleanup, the DB, or the state document.
It publishes the record it is given, having verified only: the expectation
matches disk, bytes ≤64 KiB, the reread is byte-exact. Path *constructors* live
in `paths.ts`; this module owns revision **arithmetic and validation** (safe
integers, exact spacing, the monotone `r → r+2` gap being the only permitted one).

**Why halt publication lives here (finding 4).** "Publish a durable record even
when the disk is full" is a publication concern, and the only mechanism that
makes it possible — releasing the pre-allocated reserve — is an allocation
concern of the same act. Splitting them would put the reserve-unlink in one
module and the write it exists to enable in another.

---

#### M-3 `migration/classifier.ts` — one admitted row, zero writes

**Outcome.** Given a workspace, return exactly one admitted row of the M0
authority matrix (163:2578) / crash-resume table (163:3232), or a corruption
verdict. **Zero writes**, enforced by import graph.

```ts
export type MigrationObservation =
  | { row: "no-control-json" }                                    // JSON authority, eligible for M0
  | { row: "genesis-candidate" }                                  // absent/absent/absent — §1.3
  | { row: "m0-resume" | "m1-resume" | "m3-resume" | "m4-resume"; control: MigrationControl }
  | { row: "m2-resume"; control: MigrationControl; staging: StagingMainObservation }
  | { row: "m5-resume"; control: MigrationControl; sibling: QSiblingObservation }
  | { row: "source-changed"; control: MigrationControl; replacement: SourceIdentity }
  | { row: "retirement-cursor"; control: MigrationControl; cursor: RetirementCursor }
  | { row: "m5-artifact-ahead-q"; control: MigrationControl }     // SQLite already elected
  | { row: "m6-cleanup"; control: MigrationControl; cursor: CleanupCursor }
  | { row: "m7"; control: MigrationControl }
  | { row: "terminal-sqlite" }
  | { row: "halted"; control: MigrationControl; halt: MigrationHalt }
  | { row: "corruption"; halt: MigrationHalt };

/** Observe without mutating. `lstat`-only, no-follow, bounded reads; the active
 * DB is opened READ-ONLY. Caller must have completed standing reset recovery
 * (finding 8) and hold the lock set. */
export async function classifyMigrationState(
  root: string, locks: HeldMigrationLocks,
): Promise<MigrationObservation>;
```

**Deleted per finding 14.** The `StateAuthority` field is gone. Authority follows
from the row and is derived, never carried redundantly.

**Contradictory authority is not a halt (finding 5).** Exact `Q` with an absent,
wrong-authority-id, or incomplete DB is a hard `StateAuthorityCorruptError` with
**zero repair writes** (163:2602) — a new error class in `state-plane/errors.ts`,
not a `MigrationHaltCode`. It is not retryable and doctor never offers
`--retry-state-migration` for it.

**Why it is separate.** The crash table is 17 rows and the authority matrix 16.
If observation and mutation share a function, "zero writes" is a claim; here it
is a type. Test shape: one table-driven test per row, plus a byte-for-byte
`.rbox` snapshot before/after every corruption row.

**Consumed by M-5, M-6, M-7, M-8 (finding 15).** Those modules take a classifier
receipt as input; none re-derives its own row. This is what keeps the matrix
single-sourced.

---

#### M-4 `migration/admission.ts` — may this begin or continue

**Outcome.** A verdict on entry. It publishes nothing and creates nothing; on
refusal `.rbox` is byte-identical.

```ts
/** FINDING 11 — this is the complete list 163 names. `workspace-busy` is
 * DELETED: 163 has no such code, and live-operation evidence failing is
 * `migration-not-exclusive`. `reserve-foreign` is here, as an M1 REFUSAL with
 * zero mutation (163 B0 contents item 3), not a halt. */
export type AdmissionRefusal =
  | { code: "degraded-fence" }
  | { code: "quarantine-pending" }
  | { code: "barrier-witness-missing"; verdict: WitnessVerdict }
  | { code: "migration-not-exclusive"; detail: string }
  | { code: "reserve-foreign"; detail: ReserveForeignDetail };

export type AdmissionVerdict =
  | { status: "admitted"; source: SourceIdentity }
  | { status: "refused"; refusal: AdmissionRefusal };

/** The five M0 conditions, in order, under the held lock set. Re-called
 * verbatim immediately before the M6 rename. */
export async function admitMigration(
  root: string, entry: MigrationEntryProof, locks: HeldMigrationLocks,
): Promise<AdmissionVerdict>;

/** M1: design 161's unchanged 52× admission, 512 MiB hard cap, RSS/cgroup
 * budget, advisory `statfs`, and the reserve claim. `reserve-foreign` returns a
 * refusal here with nothing adopted, claimed, truncated, or deleted. */
export async function admitMigrationBudget(
  root: string, sourceBytes: number, stream: string,
): Promise<BudgetVerdict>;

/** §1.3 — genesis has its own predicate: fenced config/incarnation/reset
 * evidence, absent legacy path, absent DB, absent control. */
export async function admitGenesis(
  root: string, entry: MigrationEntryProof, locks: HeldMigrationLocks,
): Promise<GenesisVerdict>;
```

The five M0 conditions, exactly and in order (163 §3 bullet 3):

1. locking health is **not** `degraded-unlocked` → `degraded-fence`;
2. no other live rbox process holds or recently held a workspace operation
   (daemon/lock ownership evidence plus a bounded wait) →
   **`migration-not-exclusive`**;
3. `.rbox/state/quarantine/` enumerates to absent → `quarantine-pending`;
4. `verifyLastWriterWitness` matches all five fields and
   `writerVersion >= 1.11.0` → `barrier-witness-missing`;
5. the exclusivity window is proven (§3) → `migration-not-exclusive`.

**Refusals are refusals, not halts.** They publish no control, create no
artifact, and are freely retried.

**The v11 deletion is a test, not a comment.** A structural test asserts the
string `legacy-writer-live` and any paired-interval sampling appear nowhere in
`src/`.

---

#### M-5 `migration/import-json.ts` — a proven staging DB

**Outcome.** From an admitted source, a staging DB that is durably created,
completely imported, and independently proven. M2–M4 are one outcome; 163
correlates them through a single control lineage and ruling 13 keeps them
together.

```ts
/** M2 — preamble-prefixed STREAMING copies only (hard links forbidden, v7).
 * Preserves a differing prior fixed backup under its own verified body hash
 * first. Returns body + physical hashes for both backups. */
export async function preserveSource(
  root: string, source: SourceIdentity, locks: HeldMigrationLocks,
): Promise<M2Witness>;

/** FINDING 2 — M3 is three steps, because its ordering requires an interstitial
 * control publication this module must not perform.
 *
 * Step 1: `O_EXCL` no-follow create the staging main, fsync the empty file,
 * fsync `.rbox/state`, revalidate its exact regular-file identity. */
export async function claimStagingMain(
  root: string, control: MigrationControl, locks: HeldMigrationLocks,
): Promise<StagingMainIdentity>;

/** Step 2 is M-9's: CAS-publish the SAME-PHASE M2 revision recording that exact
 * identity (163:3163). Only then may step 3 open SQLite.
 *
 * Step 3: re-run 52×/RSS admission immediately before the sole guarded parse,
 * compute the JSON-side semantic stream, and import every plane/record in ONE
 * transaction through `initializeStateStore`, with `migration_completion`
 * inserted LAST. Opens only the exact owned file the published identity names. */
export async function importOwnedStaging(
  root: string, control: MigrationControl, source: SourceIdentity, locks: HeldMigrationLocks,
): Promise<M3Witness>;

/** M4 — WAL recover if needed, `wal_checkpoint(TRUNCATE)` non-busy, close,
 * require `S0`; reopen read-only, recompute the SQL semantic stream/counts,
 * validate application/user/DDL ids, `foreign_key_check`, full
 * `integrity_check`; close, require `S0` again; fsync DB + state dir;
 * physical-hash under identity bracketing. */
export async function proveStaging(
  root: string, control: MigrationControl, locks: HeldMigrationLocks,
): Promise<M4Witness>;
```

**FINDING 7 — the JSON side of the digest does not exist and U3 builds it.**
`digest/state-semantic-v1.ts` today exports only
`stateSemanticDigest(db: Database)`, the SQL projection. The round trip is
meaningless without a JSON-side entry point over the *same grammar*, so U3 adds,
**in that same file** (74 lines today, comfortably inside budget):

```ts
/** The named v1 normalization of a legacy `SyncState`: strips `resolutionIntent`
 * BEFORE the digest (never routed to `extras_cjson`, no shape-presence bit),
 * normalizes invalid repo counters to zero, and derives the source-shape flags.
 * The one place legacy shape becomes canonical. */
export function normalizeLegacyStateV1(state: SyncState): NormalizedLegacyState;

/** Same grammar, same token stream, JSON side. */
export function legacyStateSemanticDigest(normalized: NormalizedLegacyState): StateSemanticDigest;
```

Keeping both entry points in one file is the point: a grammar divergence between
the two sides is the failure this digest exists to catch, and it cannot diverge
if it is written once. `import-json.ts` calls them; it does not own the grammar.

**Consumed seams:** `initializeStateStore` (merged, #577);
`beginMigrationImportStage` (**PR #574, unmerged**); `backup/publish.ts`;
`store/artifact-proof.ts` (`assertNoSidecars`, `fsyncDirectory`,
`PhysicalIdentity`).

**May NOT touch.** `.rbox/state.json` beyond reading the identity-bracketed
source, the active `state.db`, the Q sibling, the control record, or cleanup. It
returns witnesses; M-9 publishes them.

**Fidelity contract.** `legacyStateSemanticDigest(normalizeLegacyStateV1(source))`
must equal `stateSemanticDigest(staging)`, and when manifest meta is present the
canonical reconstructed manifest hash is checked independently. Counts are
diagnostic only.

---

#### M-6 `migration/finalize.ts` — the one flip

**Outcome.** The prepared DB becomes authority. The most dangerous file in the
codebase; it should be the shortest one that can do its job.

```ts
/** M5 — rename staging over `state.db`, durably remove only a redundant exact
 * staging name, require staging absent and active `S0`, fsync `.rbox/state`.
 * Returns the witness with the Q-sibling path/bytes/sha PREBOUND, disposition
 * `absent`. JSON remains authority throughout. */
export async function publishPreparedDatabase(root, control, locks): Promise<M5Witness>;

/** M6 — drive the Q sibling `absent → building → exact`. This performs each fs
 * step and returns the next disposition; M-9 performs each same-phase CAS. */
export async function stepQSibling(root, control, locks): Promise<QSiblingStep>;

/** FINDING 1 — the flip's non-success outcomes are DISPOSITIONS that arm C1
 * retirement, not halts. Neither is initially a durable halt; both leave JSON
 * authoritative and zero artifacts mutated. */
export type FlipOutcome =
  | { kind: "flipped"; witness: M6Witness }
  | { kind: "arm-retirement"; reason: "source-changed"; trigger: SourceIdentity }
  | { kind: "arm-retirement"; reason: "legacy-write-detected"; observedBodySha256: string };

/** The flip. Revalidates source/backups/completion; then — as the LAST operation
 * before `fs.rename`, with NOTHING between them — re-verifies the live
 * `state.json` body hash against the M3-imported source digest under the held
 * `stateLockPath`. Then renames, and fsyncs `.rbox`. */
export async function flipAuthority(root, control, locks): Promise<FlipOutcome>;
```

**May NOT touch.** Cleanup (M-8 owns it), the control's revision arithmetic
beyond asking M-2, or the import path. It never deletes a backup or the source.

**Two invariants review must keep attacking:**

1. **The last-instant re-verify** (163 v9). No fsync, no other hash, no logging
   between the check and the rename. F5's companion assertion tests exactly this.
2. **All five M0 conditions are re-checked here**, immediately before the rename,
   not only at M0.

---

#### M-7 `migration/retirement.ts` — C1

**Outcome.** A superseded migration's artifacts are gone, one durably-correlated
item at a time, with the control retired last.

```ts
/** Arm retirement: CAS-publish the closed union with `durablePrefix: 0` and no
 * intent, BEFORE deleting anything. `items` derives ONLY from the old exact
 * control's own recorded artifacts; it never discovers a path. Entry publication
 * requires every listed item to match its control-owned starting disposition. */
export async function armRetirement(
  root: string, control: MigrationControl, outcome: ArmRetirementReason, locks,
): Promise<MigrationControl>;

/** Advance the cursor by exactly one position (163:2704 table). */
export async function stepRetirement(root, control, locks): Promise<RetirementStep>;
```

**May NOT touch.** The current source `L`, the immutable backup history, the
fixed backup, or any path not in the armed vector. It never parses, imports,
restores, or deletes replacement `L`.

**The vector** (163:2704), fixed-role, deduplicated, ordered: Q sibling →
staging `-journal`, `-wal`, `-shm` → staging main → prepared active DB →
migration-id private artifacts (role 5 only, and only revision-scoped siblings
the retiring control itself names) → emergency resource → **the claimed
reserve**. Sidecars precede their main.

**A retirement halt differs from every other halt.** A caught failure publishes a
phase-preserving `source-changed`/`filesystem-full` halt carrying the **exact
cursor**. Halt publication consumes **no** vector item as runway and never
relabels a current intent as `consumed-for-halt`. Retry resumes only that
cursor's current target and never resets an absent disposition to `available`.

**The pre-`Q` abort path routes here.** §6.3.

---

#### M-8 `migration/cleanup.ts` — terminalization

**Outcome.** After the flip, every migration artifact reaches its terminal
disposition and the control is gone. One correlated machine: two cleanup items, a
five-row preparation ledger, and M7.

```ts
/** Advance the M6 cleanup cursor by one position. Nonfinal items only. */
export async function stepCleanup(root, control, locks): Promise<CleanupStep>;

/** Drive `b → b+4` one durable ledger row at a time (163:2951 table). Never
 * creates a second pair; always resumes the same ledger stage and inode.
 * Renders through `renderPreparedControl`; a caught ENOSPC here publishes NO
 * alternate control (the named scoped f6 exception) and reports
 * `durableHalt: false`. */
export async function stepFutureControlPreparation(root, control, locks): Promise<PreparationStep>;

/** At ready `r = b+4`: re-read and byte-exactly re-match the 128-byte reserve
 * header before unlinking role 7; unlink the final item; fsync its recorded
 * parent; then ask M-2 to `promotePreparedControl` the exact M7 sibling under
 * expected revision `r`. On a caught failure BEFORE that promotion begins, it
 * may instead promote the prepared halted-M6 sibling under the same expectation.
 * Once either promotion begins, the other is never published. */
export async function completeFinalItem(root, control, locks): Promise<FinalItemOutcome>;

/** FINDING 4 — the one halt whose clear IS a promotion. Doctor authorizes; this
 * performs the single already-intended mutation and promotes the prepared M7
 * sibling under expected revision `r+1`. There is no separate CAS-clear, and no
 * intermediate unhalted revision may consume `r+2`. */
export async function retryPromotedHalt(root, control, locks): Promise<FinalItemOutcome>;

/** M7 — published FIRST from the prepared `r+2` sibling, converting resources to
 * `retired`; THEN unlink the unused `r+1` halt sibling if exact-terminal and
 * fsync; THEN unlink the control and fsync (163's order — finding 9). Asserts
 * role-5 inert temps by `lstat` over the control's own recorded revision
 * interval; no directory discovery. */
export async function finishMigration(root, control, locks): Promise<void>;
```

**May NOT touch.** The active DB, `Q`, the Q sibling (already absent at M6), the
backups, `cache-v1-retired/`, or any legacy reset artifact. Roles 1–4 present at
M6 are a `reserved-path` corruption halt with zero writes — this module never
sweeps them.

**Role 7's byte-exact reread is mandatory** (163:4318): all 128 header bytes must
equal the CAS-recorded header immediately before the unlink; a mismatch is a
corruption halt with zero writes.

---

#### M-9 `migration/authority.ts` — sequencing

**Outcome.** Phases happen in order. It consumes typed receipts and asks M-2 to
publish. It holds **no filesystem primitive**: no `fs.*`, no `node:crypto`, no
`bun:sqlite`.

```ts
export type MigrationOutcome =
  | { kind: "completed"; phases: MigrationPhase[]; elapsedMs: number }
  | { kind: "already-migrated" }                    // Q6: terminal row, zero mutation
  | { kind: "refused"; refusal: AdmissionRefusal }
  | { kind: "retired"; reason: "source-changed" | "legacy-write-detected" }
  | { kind: "halted"; halt: MigrationHalt; durableHalt: boolean };

/** FINDING 14 / Q3 — ONE private driver. There is no exported, structurally
 * forgeable `DoctorRetryProof`. The module exposes exactly two fresh-entry
 * functions and one doctor-authorized retry, all delegating here. */
async function drive(root: string, locks: HeldMigrationLocks, start: DriveStart): Promise<MigrationOutcome>;

/** Fresh entry — the two admitted entry points call these and nothing else. */
export async function runMigration(root, entry: MigrationEntryProof, onProgress): Promise<MigrationOutcome>;
export async function runGenesis(root, entry: MigrationEntryProof, onProgress): Promise<MigrationOutcome>;

/** FINDING 4 — doctor retry, with per-halt semantics, NOT a blanket CAS-clear:
 *  - ordinary M0–M5 halt: first recreate/fsync any `consumed-for-halt` or
 *    `not-created` resource and CAS-publish the same phase with both
 *    dispositions `available`; only then clear and resume;
 *  - retirement / M6-cleanup halt: preserve the exact cursor, clear, resume ONLY
 *    the current target; never reset an absent disposition to available;
 *  - final-intent `promotedHalt`: NO clear. Validate, then delegate one
 *    single-use in-process attempt to `cleanup.retryPromotedHalt`. */
export async function retryHaltedMigration(root, locks: HeldMigrationLocks): Promise<MigrationOutcome>;

/** Pre-`Q` abort: run C1 to completion against its own migration id. */
export async function abortMigration(root, locks: HeldMigrationLocks): Promise<MigrationOutcome>;
```

**Structural tests.** `authority.ts`'s import graph contains no `node:fs`,
`node:crypto`, or `bun:sqlite`; and production has exactly **two fresh-entry call
sites** plus **one doctor authorization site**.

---

### 1.2 The two deferred adapters

#### A-1 `adapters/sqlite-state-save.ts` — writes go native

```ts
/** Build the sealed global + transition stages for this packet, apply
 * `applyCasPacket`, and clean the stages up on every path. */
export async function applySavePacketToStore(
  store: StateStoreHandle, packet: StateSavePacket, ownerToken: OwnedLockCasToken,
): Promise<CasResult>;
```

Consumes only merged seams: `beginGeneration`, `beginRepoTransitionStage`,
`StageLock` (U1b's containment — reused, per the sweep's capability decision),
`applyCasPacket`, `casOwnerTokenFromLock`.

**May NOT touch.** Authority selection, the JSON path, migration control, or
`CasResult` translation. It returns the raw `CasResult`. **Budget: 260.**

#### A-2 `adapters/whole-state-compat.ts` — the sole authority selector

```ts
export async function loadState(root, stream, warningSink?, heldMutex?): Promise<SyncState>;
export async function loadRawState(root: string): Promise<SyncState | undefined>;
export async function applyStateSavePacket(root, packet, options?): Promise<StateSaveResult>;
export async function ensureTelemetryBindingId(root, stream, randomBytes?): Promise<{ state; bindingId }>;
```

Owns: authority selection via `classifyStateFormat`; typed `StreamMismatchError`
on a different-stream read on **both** backends, never a manufactured genesis
baseline (T0.2's fix — `read-only.ts`'s policy wrapper stays deleted); shared
reset recovery and reset-lineage provenance; and exhaustive raw `CasResult`
translation, materializing against the retry view's **exact token**, closing the
view, and **not widening `StateSaveResult`**.

**FINDING 5 — the one narrow migration dependency, a deliberate exception.** r1
said "A-2 may not touch migration." That constraint is unimplementable: a
restarted process could otherwise write through a durable
`durability-indeterminate` halt. A-2 therefore performs exactly one check, at the
SQLite save boundary only, under the already-held state lock:

```ts
const control = readCanonicalControl(root);          // M-2, bounded read + decode
if (control && blocksSqliteWrites(control)) throw new StateWriteRefusedError("migration-write-blocked");
```

That is the whole dependency: one read, one pure predicate, on the write path
only. `cleanup-deferred` returns `false` and writes proceed. A-2 still never
runs, resumes, or repairs a migration, and imports nothing else from
`migration/`. The direction still holds — migration knows about authority;
authority knows one bit about migration.

**Also:** contradictory authority (exact `Q` + absent/wrong/incomplete DB) throws
`StateAuthorityCorruptError` from selection, with zero repair writes. Not a halt,
not retryable.

**Budget: 340** (301–399 review note: selection, shared load/reset semantics, and
result translation are one boundary; separating them puts the translation in a
module that cannot see which backend produced the result). Contingency split if
measured over: `cas-result-translate.ts`.

**Call-site inventory.** CI counts `loadState()` production call sites from this
release; may only decrease; zero by U4f.

### 1.3 Genesis — the owner, assigned (FINDING 6)

`absent/absent/absent` must produce a staged DB + `Q` with
`origin_kind: "genesis"`, absent source hash/digest/bytes, and its source-shape
flags (163:3772). r1 promised this and assigned it to nobody. It is **not** a
tenth module — it is a reduced traversal of the existing nine:

| Step | Owner | Notes |
|---|---|---|
| Classify `genesis-candidate` | M-3 | absent legacy path, absent DB, absent control |
| Admit | M-4 `admitGenesis` | Requires fenced config/incarnation/reset evidence; otherwise **halt** (163's matrix row). Conditions 1, 2, 3, 5 apply; condition 4 (barrier witness) does **not** — there is no prior writer |
| Build the staged DB | `schema/application.ts` gains `installGenesisCompletion(db, {authorityId, migrationId})` beside the existing `installGenesisLineage`, run through `initializeStateStore` | Behavior-free row insertion, next to the row installer that already exists. No new file |
| Publish + flip | M-6 `publishPreparedDatabase` → `stepQSibling` → `flipAuthority`, **unchanged** | `flipAuthority` takes a source witness that is `null` for genesis: there is no live JSON to re-verify and the rename target does not exist. Every other property — the prebound sibling, the `absent → building → exact` ladder, the single rename — is identical |
| Cleanup | M-8 | Genesis claims no reserve and no emergency candidate, so the cleanup vector is empty and M7 is reached immediately |
| Sequence | M-9 `runGenesis` | The second fresh-entry function |

This is the **first fleet checkpoint** (§6.7) and therefore the earliest
falsifiable signal in the unit.

---

## 2. The M0–M7 phase machine

`control.phase` is the **highest durably completed phase**, never the phase about
to start. No phase is pre-published.

### 2.1 Three outcome kinds, kept distinct (FINDING 1, FINDING 11)

r1 collapsed these. They are not the same thing and 163 treats them differently:

| Kind | Publishes | Suspends migration | Cleared by | Examples |
|---|---|---|---|---|
| **Refusal** | Nothing; `.rbox` byte-identical | No | Nothing — retry freely | `degraded-fence`, `quarantine-pending`, `barrier-witness-missing`, `migration-not-exclusive`, `reserve-foreign` |
| **Disposition** | Arms C1 retirement (a control revision, not a halt) | No — retirement proceeds automatically | Reaching the terminal retirement prefix | `source-changed` trigger, `legacy-write-detected` |
| **Halt** | Same-phase revision with exact `halt` + updated `haltResources` | Yes, until explicit retry | `rbox doctor --retry-state-migration`, per-halt semantics (§1.1 M-9) | `filesystem-full`, `verification`, `reserved-path`, `durability-indeterminate`, `cleanup-deferred`, `source-oversize`, `memory-admission`, `record-oversize`, `disk-preflight`, and `source-changed` **only as a retirement-cursor halt** |

**The one r1 got wrong.** A changed exact `L` observed during M0–M5, and a
`legacy-write-detected` body-hash mismatch at M6, are **dispositions**: the
controller arms C1 retirement before any artifact mutation and JSON stays
authoritative. Neither is initially a durable halt. `source-changed` appears in
163's halt-reason list only as the halt a *caught failure during retirement*
publishes, carrying the exact retirement cursor.

### 2.2 Phase table

| Phase | Precondition | Work | Durable publication point | Crash-resume row | Reachable halts |
|---|---|---|---|---|---|
| — | control absent, exact `L`, no reserved active DB | — | — | Rerun read-only M0 after fresh identity/hash. An inert revision-scoped M0 temp is never adopted; fresh M0 picks a new id. Special/unreadable temp halts | `reserved-path` |
| **M0** | The five admission conditions | Bounded-read `L` first; identity-bracket + hash; random migration/authority ids; exact staging path | Publish M0 after fresh identity/hash. Failure to publish → in-process halt only, no durable phase, JSON authority | Row `M0`: exact source; reserve/emergency absent or exact id-scoped partial/complete; validate/create, rerun admission, publish M1 | `source-oversize`, `memory-admission`, `reserved-path` |
| **M1** | Exact M0; source revalidated | 52× admission, 512 MiB cap, RSS/cgroup budget, advisory `statfs`; validate/claim the B0 reserve or create it; create + fsync the id-bound emergency candidate | Publish M1 only after **both** identities and parents are durable | Row `M1`: source exact; history/fixed backup absent, exact temp, exact current, or valid prior fixed backup. Resume M2 idempotently. Foreign/special backup halts | `source-oversize`, `memory-admission`, `disk-preflight`, `filesystem-full` |
| **M2** | Exact M1 | Preamble-prefixed **streaming copy** to `legacy-json/<body-sha>.json`; publish/reuse fixed `pre-163-latest.json.bak`, preserving a differing prior under its own verified body hash first | Publish M2 only after both exact backup witnesses and parents are durable | Row `M2`, **both branches**: (a) `stagingMain: "absent"` — no file, or the sole create-ahead shape (exact path, no-follow regular zero-byte 0600, no sidecars), may begin/finish the M3 identity publication; (b) **`stagingMain` = an exact recorded identity — an incomplete id-owned main and only its own sidecars may be recovered/removed and rebuilt** (the row r1 omitted). Sidecar without main halts. An exact committed completion is the sole M3-artifact-ahead form | `filesystem-full`, `reserved-path` |
| **M3** | Exact M2 | `claimStagingMain` → **M-9 CAS-publishes the same-phase M2 revision recording that identity** → `importOwnedStaging`: re-run 52×/RSS admission immediately before the sole guarded parse; `normalizeLegacyStateV1` + `legacyStateSemanticDigest`; import all planes/records in one transaction with `migration_completion` **last** | Publish M3 only after the committed completion tuple is reread and exact. WAL sidecars allowed until M4 | Row `M3`: exact committed id-bound staging; its own WAL/SHM may exist. Open only as migration owner, recover, rerun all M4 work | `record-oversize`, `memory-admission`, `filesystem-full` (`SQLITE_FULL`), `verification` |
| **M4** | Exact M3 | Recover WAL if needed, `wal_checkpoint(TRUNCATE)` non-busy, close, require `S0`; reopen read-only, recompute the SQL digest/counts, validate ids, `foreign_key_check`, full `integrity_check`; close, require `S0` **again**; fsync DB + state dir; physical-hash under identity bracketing | Publish M4 with the complete proof | Row `M4`: exact physical witness is staging-only, or the M5 rename ran ahead (active-only or both-exact). Revalidate identical hashes/completion, never move active backward, remove only a redundant exact staging name, publish M5. Missing both, nonexact active, or any sidecar halts | `verification`, `filesystem-full`, `durability-indeterminate` |
| **M5** | Exact M4 hash; source/control revalidated | Rename staging → `state.db`; remove only a redundant exact staging name; require staging absent and active `S0`; fsync `.rbox/state` after convergence | Publish M5 with the Q-sibling path + 58-byte hash **prebound**, disposition `absent`. **JSON remains authority** | Row `M5 + exact L`: sibling is exactly absent (+ the sole zero-byte create-ahead), recorded `building` at zero/partial/exact bytes, or recorded exact. Resume only the matching step. Foreign/changed identity halts | `filesystem-full`, `reserved-path`, `durability-indeterminate` |
| **M6** | Exact M5; exact Q sibling | `absent → building → exact` via same-phase CAS; revalidate live JSON + `.bak` + M5 completion/hash; **then, as the last operation before the rename with nothing between, re-verify live `state.json` body sha against the M3 source digest under the held `stateLockPath`**; rename sibling over `.rbox/state.json`; fsync `.rbox` | Publish M6 with sibling absent + the initial cleanup cursor. **Observing `Q` elects SQLite even if M6 publication was interrupted** | Row `M5 + exact Q` (the sole M6-artifact-ahead form): SQLite already elected; never rename JSON back. Complete/retry the `.rbox` fsync, publish M6, keep writes blocked as `durability-indeterminate` until it succeeds. Row `M6`: only the current cleanup-intent item may be exact or absent | `filesystem-full`, `reserved-path`, `durability-indeterminate` |
| **M7** | Exact M6; complete nonfinal prefix; final intent item absent; prepared runway | **Publish M7 first** from the prepared `r+2` sibling, converting resources to `retired`; **then** unlink the unused `r+1` sibling if exact-terminal and fsync; **then** unlink the control and fsync | M7 itself is the durable record of the final cleanup-absent prefix | Row `M7`: exact Q + matching DB, all resource cleanup complete, the recorded `r+1` sibling exact-terminal or delete-ahead absent. Durably remove it if needed, then unlink control and fsync. No earlier phase may rerun | `cleanup-deferred`, `durability-indeterminate` |

### 2.3 The rows that are not phases (FINDING 1, FINDING 9)

| Row | Observation | Only action | Authority |
|---|---|---|---|
| **ordinary M0–M5 + changed exact `L`** | Every non-source artifact still matches the ordinary old phase row exactly; the sole mismatch is a freshly identity-bracketed, legacy-guard-admitted current `L` at the same path. A malformed/special/unreadable replacement or any second mismatch halts | Publish the initial C1 retirement revision **before any artifact mutation**. Nothing else | JSON |
| **`source-change-retirement` from M0–M5** | Exact `L` plus precisely the printed prefix/intent correlation. Only the current intent target may be owned-present or absent | Resume that one target, or at complete prefix retire the control | JSON |
| **halted `source-change-retirement`** | Same correlation, plus its durable halt | Automatic cleanup suspended at the exact cursor. Doctor may clear only that halt and delegate the same current-target action | JSON |
| **exact halted M0–M7** | The same phase/artifact correlation must match; the halt excuses no mismatch | Doctor clears under full locks per §1.1 M-9's per-halt semantics, then the same controller resumes. **Except** the final-intent `promotedHalt`, where the prepared-M7 promotion *is* the clear | JSON before `Q`, SQLite after |
| **terminal absent control + exact `Q`** | Matching complete active DB, no standing control | Ordinary SQLite startup. `rbox migrate` here is `already-migrated`, exit 0, zero mutation (Q6) | SQLite |
| **foreign/malformed/inconsistent control or artifacts** | — | No phase inference, cleanup, DB open, sentinel write, or backup restoration. Zero-write corruption halt | Existing exact `L`/`Q` predicate only |
| **exact `Q` + absent/`P/F`/wrong authority id DB** | — | Hard `StateAuthorityCorruptError`, zero repair writes. **Not a halt, not retryable** | Contradictory |

### 2.4 Global rules every test asserts

- An unhalted control admits only its required artifact or the **explicitly
  printed one-next-phase artifact-ahead** state. Artifact-behind,
  two-phases-ahead, foreign, special, sidecar-without-main, or phase/witness
  mismatch halts with **zero writes** and is never repaired forward.
- `SIGKILL`, power loss, and unobserved crashes **never manufacture a halt**.
- A halt never advances phase, retirement prefix, or cleanup prefix, and never
  consumes a retirement/cleanup vector item as runway.
- Before `Q`, a durable halt suspends migration but not JSON authority. After
  `Q`, only `durability-indeterminate` (write-blocking, enforced at the A-2 save
  boundary) and `cleanup-deferred` (not write-blocking) are expressible; neither
  can re-elect JSON.
- The `b..b+4` runway is the **named scoped exception to f6**: a caught ENOSPC
  there publishes no alternate control, reports `durableHalt=false`, and stops.
  Deliberate — do not "fix" it.

---

## 3. Exclusivity: entering and proving the window

`MIGRATION-EXCLUSIVITY-v11`. The window is **exclusive ownership of this
workspace's mutation locks**, not machine quiescence.

### 3.1 The lock bundle and what precedes it (FINDING 8)

```ts
/** The complete lock set 163 requires: non-degraded workspace sync mutex,
 * repository fence where applicable, and the state lock. Constructed only by
 * the entry sites; every module asserts, none acquires. */
export interface HeldMigrationLocks {
  readonly mutex: WorkspaceSyncMutex;
  readonly repoFence: RepositoryFence | undefined;   // required where repositories are present
  readonly stateLock: OwnedLock;
}
```

Order of operations at every entry, including doctor retry:

1. Acquire the workspace sync mutex; **`await assertHealthyOwnedSyncMutex(handle, root)`**
   — not `assertSyncMutex`, which is a shape check that does not verify live
   ownership (`sync-mutex.ts:272` vs `:325`).
2. Acquire the repository fence where repositories are present.
3. Acquire `stateLockPath(root)`; assert `isOwnerSync()`.
4. **Run standing reset recovery to completion** (163:3127 — migration runs
   "after standing-reset recovery"). Quarantine enumeration alone is not
   sufficient: a resumable reset must actually be recovered before any
   classification, or the classifier observes a mid-reset artifact set.
5. Only then classify (M-3) and admit (M-4).

### 3.2 The two admitted entry points, and one doctor authorization (Q3)

```ts
export type MigrationEntryPoint = "upgrade-stop-window" | "foreground-migrate";

export interface MigrationEntryProof {
  readonly entry: MigrationEntryPoint;
  readonly locks: HeldMigrationLocks;
}
```

There is **no `DoctorRetryProof`** (finding 14). Doctor authorizes a retry by
calling `retryHaltedMigration(root, locks)` with the same authenticated bundle;
that function is the single authorization site and delegates into the same
private driver. Structural test: exactly **two fresh-entry call sites** plus
**one doctor authorization site**.

**Entry A — `rbox upgrade`'s per-workspace stop window, with a `finally`-level
guarantee (FINDING 17).** `restartDaemonsAfterUpgrade` today performs `stop` and
`resumeDesiredDaemon` inside **one `try`** (`upgrade-cmd.ts:143–158`), with
`continue` statements inside it. Inserting migration between them as-is can
strand a still-valid JSON workspace's daemon if migration refuses, halts, or
throws. Normative for U3:

```
try {
  await stop(root);
  if (desired.state === "stopped") return;
  try { await runMigration(root, entryProof, onProgress); }   // all pre-Q outcomes are recoverable
  catch (error) { recordWorkspaceOutcome(error); }            // never rethrows past here
} finally {
  // Every outcome — completed, refused, retired, halted, or thrown — reaches
  // this restart. A workspace still on JSON is a workspace that must get its
  // daemon back.
  await restartDesiredDaemonIfAny(row.desired);
}
```

The restart is unconditional. A post-`Q` `durability-indeterminate` halt also
restarts the daemon; the A-2 write fence, not a missing daemon, is what stops
writes.

**Entry B — foreground `rbox migrate`.** New command. Refuses inside a daemon
process, acquires the same bundle, runs the same controller with progress
rendering, and has a `--json` twin that emits structured phase progress and the
final outcome. The rig drives migration through the JSON twin.

### 3.3 Proving the window (`migration-not-exclusive`)

M0 admits only when **both** hold: (1) the caller presents a
`MigrationEntryProof` whose mutex is non-degraded and live-owned and whose state
lock is currently owned for this exact root; and (2) M0 independently confirms
**no daemon is live for this workspace** from existing pid-record/ownership
evidence. Otherwise `migration-not-exclusive`, publishing no control and creating
no artifact.

An actor starting *after* M0's check does not defeat the window: being
`>= 1.11.0` it blocks on the locks the migration holds until M7 releases them.
What pid evidence cannot exclude — a lock-ignoring pre-`1.11.0` actor — is the
drained population of the B0 gate, with the barrier, the witness, M6's
last-instant re-verify, and F2–F6 as the retained backstop.

Locks are held continuously M0 → M7; they are not re-acquired per phase.

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
              sole selector · stream refusal · CasResult translation
              · post-Q write fence (readCanonicalControl + blocksSqliteWrites)
```

- **Writes go native** — sealed stages → `applyCasPacket`, O(dirty rows). The
  per-cycle full-serialize disappears here, not in U4.
- **Reads stay whole** — `SyncState` materialized from rows, preserving every
  caller signature, at the cost of the materialization peak until U4.
- **The selection point is singular.** A structural test pins
  `classifyStateFormat`'s production callers to `whole-state-compat.ts` plus the
  B0 barrier sites (`assertStateReadable` / `assertStatePublishable`, which are
  refusals, not selections).
- **`StateSaveResult` is not widened.** One test per raw rejection reason.
- **Standing-halt visibility without a daemon lifecycle** (finding 14 / Q7). U3
  does **not** add a `migration-halted` daemon state, a migration pump, or a pump
  catch — none of those exist and v11 forbids daemon migration. A standing
  durable halt is *projected* from the control into the existing doctor/status
  surface, exactly as U2's `reset-health.ts` (`ResetHaltHealthV1`,
  `readResetHaltHealth`) already does for reset. Enforcement lives at write
  admission, not in a lifecycle.

---

## 5. Halts, refusals, dispositions: copy and the twin

Every halt code gets a member in `MigrationHaltCode` and an entry in
`MIGRATION_HALT_COPY`; the merged `satisfies Record<…>` is the gate. Refusals and
dispositions use the same copy shape through the same doctor renderer. Copy is
written for a non-technical user.

### 5.1 Refusals (publish nothing; freely retried)

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `degraded-fence` | "This workspace's folder can't be safely locked on this disk, so rbox won't move its state here." | "Nothing changed. Your files and your sync are unaffected." | `rbox doctor` | `state-migration/degraded-fence` · warn |
| `quarantine-pending` | "There's a paused state repair to finish first." | "Nothing changed. Your data is intact." | `rbox doctor` | `state-migration/quarantine-pending` · warn |
| `barrier-witness-missing` | "This workspace was last written by an older rbox. It needs one ordinary sync with this version first." | "Nothing changed." | `rbox sync` | `state-migration/barrier-witness-missing` · info |
| `migration-not-exclusive` | "rbox only moves state while nothing else is using this workspace." | "Nothing changed." | `rbox stop`, then `rbox migrate` | `state-migration/not-exclusive` · warn |
| `reserve-foreign` | "A file rbox keeps as a safety reserve doesn't look like rbox wrote it, so rbox left it alone." | "Nothing was deleted, claimed, or changed." | `rbox doctor` (names the exact path) | `state-migration/reserve-foreign` · warn |

### 5.2 Dispositions (arm C1; JSON stays authoritative)

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `source-changed` | "The workspace's state changed while rbox was converting it, so rbox is throwing the partial work away." | "Your current state is untouched and still in use." | `rbox migrate` (after cleanup finishes) | `state-migration/source-changed` · info |
| `legacy-write-detected` | "An older rbox wrote to this workspace during the conversion, so rbox stopped before switching over." | "Your current state is untouched and still in use." | Upgrade every machine to 1.11.0+, then `rbox migrate` | `state-migration/legacy-write-detected` · error |

### 5.3 Halts (`MigrationHaltCode`; suspend until explicit retry)

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `source-oversize` | "This workspace's state file is larger than rbox can convert (names the measured size)." | "Nothing changed; the workspace keeps working on the old format." | Run once on a machine with more memory, or re-adopt the workspace | `state-migration/source-oversize` · error |
| `memory-admission` | "Converting this workspace needs more memory than this machine can spare (names measured size and required headroom)." | "Nothing changed." | Same two remedies; `RBOX_RESET_PARSE_BUDGET_BYTES` printed with its exact value | `state-migration/memory-admission` · error |
| `record-oversize` | "One entry in this workspace's state is too large to convert." | "Nothing changed." | `rbox doctor` | `state-migration/record-oversize` · error |
| `disk-preflight` | "There isn't enough free disk space to convert safely (names required vs available)." | "Nothing changed." | Free space, then `rbox migrate` | `state-migration/disk-preflight` · error |
| `filesystem-full` | "The disk filled up partway through. rbox stopped instead of leaving a half-converted workspace." | "Your old state is still the one in use and is intact." | Free space, then `rbox doctor --retry-state-migration` | `state-migration/filesystem-full` · error |
| `source-changed` (retirement cursor only) | "Cleaning up after an interrupted conversion didn't finish." | "Your current state is untouched and still in use." | `rbox doctor --retry-state-migration` | `state-migration/retirement-source-changed` · warn |
| `verification` | "The converted state didn't match the original exactly, so rbox refused to switch to it." | "Your original state is untouched and still in use. A copy of it is saved." | `rbox doctor` (prints the backup path) | `state-migration/verification` · error |
| `reserved-path` | "rbox found an unexpected file where it keeps its state and won't touch it." | "Nothing was deleted. Your state is unaffected." | `rbox doctor` (names the exact path) | `state-migration/reserved-path` · error |
| `durability-indeterminate` | "rbox can't confirm the last write reached the disk, so it has paused writing to this workspace." | "No data was lost; rbox is being cautious." | `rbox doctor --retry-state-migration` | `state-migration/durability-indeterminate` · error |
| `cleanup-deferred` | "The conversion finished; tidying up one leftover file didn't." | "Your workspace is fully working on the new format and syncing normally." | `rbox doctor --retry-state-migration` | `state-migration/cleanup-deferred` · warn |

### 5.4 Not halts, and never offered a retry

| Condition | Surface |
|---|---|
| `StateAuthorityCorruptError` (exact `Q` + absent/wrong/incomplete DB) | "This workspace says it uses the new format, but its state database is missing or doesn't match." Safety: "rbox has changed nothing and will not try to repair this automatically." Command: the printed re-adoption procedure. `state-plane/authority-corrupt` · error |
| `legacy-overwrite-after-Q` (F3's documented outcome) | "An older rbox overwrote the marker that says this workspace uses the new format." Safety: "A copy of your state is saved (names the hash-addressed backup)." Command: re-adoption. `state-migration/legacy-overwrite-after-q` · error |

**Rules the copy is held to.** Never advise deleting `Q`. Never advise restoring
a backup — after `Q` the only supported recovery is re-adoption, and doctor
prints exactly that. Every `command` is real and non-interactively twinned. The
`migrating` state renders in plain English past 5 s per phase, with the `--json`
twin emitting structured phase progress.

---

## 6. Exit gates

### 6.1 F1–F6 fixtures

Excluded scenarios asserted by fixture. Content unchanged from r1.

| Fixture | Construction | Assertion | Negative control |
|---|---|---|---|
| **F1** | Degraded-unlocked workspace + live legacy writer | M0 refuses `degraded-fence`; no control, no artifact | Fence predicate removed → M0 proceeds |
| **F2** | `forceLegacy` writer on a **lockable** fs, suspended after its state read; full M0–M7; writer resumes | Writer fails closed with `StateFormatTooNewError`; `Q` byte-identical | Barrier + lock-entry restriction removed → the same fixture **demonstrably destroys `Q`** |
| **F3** | F2's shape, writer is the **published signed 1.10.x artifact**, released strictly after M6's rename | The documented outcome: `Q` destroyed; doctor reports `legacy-overwrite-after-Q` naming the immutable backup | — |
| **F4** | Two concurrent degraded writers | The **refusal**, not last-writer-wins | — |
| **F5** | Signed 1.10.x, `forceLegacy`, lockable fs, rename landing inside M6's `check → rename` microwindow — driven by the `onStep` `"before-rename"` seam (`fsutil.ts:46`), **not by sleeping** | After M7: `state.json` is `Q`; DB and both M2 backups carry the *older* digest; the writer's document is absent from every artifact; doctor emits **no anomaly** | Companion: released one window earlier → M6 must refuse `legacy-write-detected`, not rename, JSON still authoritative |
| **F6** | F5 extended through the post-flip pull against remote `B1` after reverting the file to `B0` | The documented silent overwrite: `reconcile` returns an ordinary `write`, `apply` replaces with no conflict copy, no anomaly | — |

F5/F6 assert **silence**; their comments say so in one line each.

### 6.2 Crash/disk-full/resume coverage

Every row of §2.2 and §2.3 is a test. Fault injection covers 163:3267's full
list, plus the four items r1 omitted (FINDING 9):

- **M2's recorded-identity branch**: an incomplete id-owned staging main with
  each owned-sidecar subset, recovered/removed and rebuilt; sidecar-without-main
  halts.
- **M7's normative order**: publish M7 → unlink the `r+1` sibling → unlink the
  control. A test asserts no ordering in which the control is retired before M7
  is published can occur, and that **no prepared sibling survives terminal
  control unlink**.
- **Final-runway faults after `b+4`**: item present/absent at ready M6; the
  direct-M7 promotion; the caught-failure promotion to the prepared halt; process
  kill and power cut at **both** promotions and both parent fsyncs; explicit
  promoted-halt retry with the item present and absent; repeated failure before
  retry promotion; immutable M7 validation on both halt-sibling terminal
  observations. Tests assert **no retry creates a new pair**.
- **Role 7's byte-exact reserve-header reread** immediately before the unlink,
  with a mismatch asserted as a zero-write corruption halt.

Plus, unchanged from 163:3267: every M0–M7 control publication old/new record;
the M2 same-phase staging-identity CAS; the Q-sibling ladder and the rename's
both power-loss images; every C1 and M6 cursor boundary; the `b..b+4` ledger with
byte-for-byte zero-write snapshots on every rejected observation; injected OS
`ENOSPC` and `SQLITE_FULL` at every write class including halt publication and
cleanup; backup collisions; exact-512-MiB admitted and >512 MiB refused; min/max
`RepoRecord` codec admission; non-durable in-process suppression; old-binary
read/write refusal.

**Reuse, do not rebuild.** U2's `reset/crash-rig-child.ts`, `crash-rig-model.ts`,
and `trace-fs.ts` are the harness; migration is a second scenario set on it.

### 6.3 Abort — differential, and phase-specific (FINDING 10)

- **Before `Q` (any halt M0–M5):** `rbox doctor --abort-state-migration` runs the
  C1 vector to completion against its own migration id under the complete lock
  set, unlinks the control **last**, and leaves exact `L` untouched and
  authoritative.
- **After `Q`:** no in-place downgrade; doctor prints the re-adoption procedure.

**Gate.** Snapshot `.rbox` byte-for-byte before M0; abort from each of M0…M5;
diff. r1 asserted one expectation for all phases and was wrong — the claimed
reserve is **in the C1 vector and is retired**:

| Abort from | Expected residue beyond the pre-migration tree |
|---|---|
| **M0** (before the M1 claim) | No backup history yet, no fixed `.bak` yet. **The B0 reserve survives** — M0 has not claimed it |
| **M1** | The reserve is claimed, so it is a vector item and is **retired (absent)**. The emergency candidate is likewise retired. A later `ensureStateReserve` may recreate it; the abort itself leaves it absent |
| **M2–M5** | As M1, **plus** the immutable `legacy-json/<body-sha>.json` entry and the fixed `pre-163-latest.json.bak`, both preamble-prefixed, both of which 163 says are never deleted on failure |

Anything else in the diff fails the gate.

### 6.4 Import fidelity

`legacyStateSemanticDigest(normalizeLegacyStateV1(source))` equals
`stateSemanticDigest(staging)` on corpus-112k and every differential fixture;
canonical reconstructed manifest hash independently checked when meta is present;
min/max `RepoRecord` codec admission; `resolutionIntent` strip-before-digest; the
DDL-column ↔ `keyof RepoRecord` bijection minus the one named strip member;
exact-512-MiB admitted and >512 MiB refused.

### 6.5 No-regression gate (backend-first condition 1)

**The flip may not ship unless trusted `rbox status` latency and daemon
steady-state RSS on corpus-112k are no worse than the 1.x baseline.**

Protocol: 100 samples after 10 warmups, void-on-untrusted, measured **pre-flip
and post-flip on the same host, same build, same corpus**, so the delta isolates
the flip.

**RSS, made falsifiable (Q8 ruling).** r1's "5-minute window, judged on the
maximum" imported U5's unresolved sampling shape and is too weak to claim steady
state. Replaced with a **paired interval defined by the workload, not the
clock**: run a fixed scripted workload (N = 3 full sync cycles over corpus-112k
after one warm cycle), sample RSS at 1 Hz for the whole run, and compare the
**post-flip p95 against the pre-flip p95 of the same scripted run**. The gate is
`post_p95 <= pre_p95 * 1.05`. Falsifiable without the frozen machine profile,
which stays a U5 blocker.

Reference absolutes (163 v7 row 10, context only — the U3 gate is the delta):
`status` p50 ≤ 200 ms, p95 ≤ 400 ms, daemon RSS ≤ 1.5 GB. A regression inside the
absolutes still blocks.

**Migration duration budget:** M0–M7 in **≤ 60 s on corpus-112k**; any phase over
5 s prints progress; exceeding the budget is a reportable finding.

### 6.6 The dual-binary differential rig

Per-device staging and mounting already exist (`resolveRigBinaryPaths`,
`prepareRigBinarySelection`, `rig.ts`'s per-device mounts). Remaining U3 work is
exactly two items:

1. a scenario assertion that the two devices report **different `rbox --version`
   strings**, so a silent single-binary run cannot masquerade as a differential;
2. fetching the **published, signed `1.11.0` artifact** from `rbox-releases` and
   verifying it against its recorded digest and detached signature, with the
   digest pinned in the scenario for reproducibility. Never a local build.

Scenario: one workspace, one candidate host and one 1.11.0 host, pull/push
interleaved, including an ignore-rule change, a tracked-repo change, and a
mass-delete-shaped change. Neither host may observe a spurious delete, a lost
deferral, or a divergent manifest. Plus the same-corpus manifest diff on
corpus-112k. The flip is **not exempt** — it is the run where a difference is
least expected and therefore most informative.

### 6.7 First fleet checkpoint — genesis

A 2.0 dev build taking a **throwaway workspace through the genesis path**
(§1.3). Reachable before migration is enabled on any real workspace; the first
go/no-go the founder can personally observe. Dev build, throwaway accounts, per
the d169 rule.

### 6.8 The B0 enablement gate — all five conditions (FINDING 12)

r1 reduced this to "drain". 163:4342 requires **all** of the following before U3
may be *enabled*, not merely written:

1. `1.11.0` released on the **stable channel**;
2. adopted by **all 4 external users and all 3 fleet hosts**, read from the
   existing `rbox-admin` version view;
3. **baked ≥ 2 weeks** of ordinary fleet use with **zero barrier-related
   incidents**;
4. **F1–F6 pass**, including both negative controls and F5's companion
   assertion;
5. the pre-`1.11.0` population **demonstrably drained** in that same version
   view.

Known population as of 2026-07-28: one external user on 1.6 (nudge directly), two
on 1.9.x upgrading frequently, founder fleet on dev builds. Condition 4 is the one
U3 itself produces; 1–3 and 5 are calendar/fleet prerequisites that must be
recorded, dated, and re-checked before the 2.0 tag.

### 6.9 Structural / inventory gates

- `loadState()` production call sites counted; may only decrease; zero by U4f.
- `authority.ts` imports no `node:fs`, `node:crypto`, or `bun:sqlite`.
- `classifier.ts` performs no writes (import graph + `.rbox` byte snapshots).
- Exactly two fresh-entry call sites of the driver, plus one doctor
  authorization site.
- The canonical control file is written only by `control-publication.ts` —
  including both prepared-sibling promotions.
- No production `StateSavePacket` carries `authority.kind === "migration"`;
  migration authority originates only in `import-json.ts` (T0.1's contract,
  re-asserted).
- `legacy-writer-live` and paired-interval sampling appear nowhere in `src/`.
- Every file ≤400 lines / 25 KiB; 301–399 carries a review note.
- `docs/CODEMAP.md` gains one ownership line per new module in the same change.

---

## 7. Sequencing and dispatch (revised per FINDING 15)

**Gate 0 — nothing starts before this closes.** All four Tier 0 gates closed
(T0.2–T0.4 merged at `cfa873fc`; **T0.1 / PR #574 is still OPEN** — §0.2). B0
enablement conditions 1–3 and 5 (§6.8) on track. The `2.0` branch opened from
`main`. Q1 ruling adopted: **wait.** r1's "Waves 1–2 may start early" exception
contradicted its own Gate 0 and is withdrawn.

**One integration owner.** Every lane touches `docs/CODEMAP.md` and the inventory
tests. The 5A agent owns those files; other lanes propose their one-line entries
in the PR body and the integration owner applies them. This removes the collision
the review named.

### Wave 1 — the control record (2 lanes)

| Lane | Deliverable | Routing |
|---|---|---|
| **1A** | **M-1 + M-2 merged into one lane** (finding 14: 1B depended on 1A's exact canonical schema, so stubbing it was fiction). Codec, publisher, `promotePreparedControl`, `publishMigrationHalt`, `readCanonicalControl`, all migration path constructors into `paths.ts`, **plus the initial `MigrationHaltCode` union and its `MIGRATION_HALT_COPY` entries** — the codes are needed from Wave 1 onward, not Wave 5 | **opus** — fail-closed seam |
| **1B** | A-1 `adapters/sqlite-state-save.ts` + write-path differential tests | codex |

### Wave 2 — observation, admission, compat (3 lanes)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **2A** | M-3 `classifier.ts` + `StateAuthorityCorruptError` + table-driven row tests + zero-write snapshots | 1A | **opus** |
| **2B** | M-4 `admission.ts` + the five conditions + the lock bundle + standing-reset-recovery ordering + F1 + F4 | 1A | **opus** |
| **2C** | A-2 `whole-state-compat.ts` + `CasResult` translation + the post-`Q` write fence + call-site counter | 1A, 1B | **opus** |

### Wave 3 — the phase bodies (3 lanes; each consumes classifier receipts)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **3A** | M-5 `import-json.ts` (M2 / split-M3 / M4) + `normalizeLegacyStateV1` + `legacyStateSemanticDigest` + fidelity gate | 1A, 2A, **T0.1** | codex |
| **3B** | M-7 `retirement.ts` + cursor tests | 1A, 2A | **opus** |
| **3C** | M-8 `cleanup.ts` (cursor + `b..b+4` ledger + `retryPromotedHalt` + M7 in normative order) + runway fault injection | 1A, 2A | **opus** — hardest correlation in the unit |

### Wave 4 — the flip (serial, alone)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **4A** | M-6 `finalize.ts` — M5, the Q-sibling ladder, `flipAuthority` with its two arm-retirement dispositions. **Unit and crash-rig coverage only.** F2/F3/F5/F6 move to Wave 5 (finding 15: they require cleanup, controller, entry points, doctor, and a post-flip pull, none of which exist yet) | 1A, 2A, 2B, 3A, 3B, 3C | **opus, alone** |

### Wave 5 — assembly, ordered (finding 15: serial, not parallel)

| Step | Deliverable | Routing |
|---|---|---|
| **5A** | M-9 `authority.ts` — the private driver, `runMigration`, `runGenesis`, the two entry points (`upgrade` stop window **with the `finally` guarantee**, `rbox migrate` + `--json`), progress UX. Integration owner for `CODEMAP.md` and inventory tests | **opus** |
| **5B** | Doctor integration: `retryHaltedMigration`'s three per-halt paths, `--abort-state-migration`, the standing-halt projection modeled on `reset-health.ts`, final copy pass | **opus** — user-facing copy |
| **5C** | Integrated gates: **F2/F3/F5/F6**, the abort differential (§6.3), corpus-112k no-regression harness, duration budget, rig scenario. Harness *preparation* (corpus fixture, signed-artifact fetch, version assertion) may run in parallel from Wave 3 onward; the fixtures themselves cannot | codex (harness) + **opus** (fixtures) |

### Wave 6 — validation, serial

Genesis fleet checkpoint on a dev build (§6.7) → full crash-rig sweep →
`/simplify` diff-scoped → parallel review fan-out → **one final serial review** →
merge to `2.0` → dual-binary differential against signed 1.11.0 → §6.8 re-checked
→ tag.

**Founder rules binding the dispatch:** codex always reviews; bulk→codex,
fail-closed seams→opus; review fan-outs default to opus at medium effort; 2–4
parallel reviewers synthesized then one final serial review before ALIGNED; rig
the FAST suite every ~3–4 merged sync-plane PRs and before any tag.

---

## 8. Risks, re-ranked (FINDING 16)

r1's ranking was wrong. Corrected:

1. **The classifier / control-schema / M6 cleanup-runway cross-product.** The top
   correctness risk. Three interlocking closed enumerations — the observation
   rows, eight witness shapes, and a five-row ledger with two promotion branches
   — where every combination must be either admitted or a zero-write halt. The
   sharpest edges are **prepared-control promotion** (finding 3, only just given
   an owner) and the **specialized promoted-halt retry** (finding 4, whose clear
   is a rename rather than a CAS-clear). Mitigation: 1A and 2A get the same
   opus-quality tier as the flip itself, and 3C is not dispatched until 2A's row
   enumeration is merged and stable.
2. **The post-`Q` write fence and the genesis owner.** Both were *missing* in r1,
   not merely mis-specified — a missing fence is a silent write through a
   write-blocking halt, and a missing genesis owner means the first fleet
   checkpoint cannot run. Both now have owners (§1.2, §1.3); the residual risk is
   that they were invisible until a review executed the plan against the code.
3. **M3's interstitial CAS.** The staging identity must be published between the
   claim and the SQLite open. r1's API made that impossible. It is now three
   functions with the publication between them, and the crash rig must prove all
   three boundaries.
4. **`whole-state-compat.ts` — the top PERFORMANCE/COMPATIBILITY risk, not the
   top safety risk.** Whole-state materialization plus a SQLite page cache on the
   same host. If §6.5 fails: (a) tune the page cache, (b) pull U4's cursor
   conversion forward for `status`'s read path only, or (c) **do not ship the
   flip**. Option (c) stays on the table per the founder's revert rule.
5. **F5/F6 assertion maintenance.** Not a leading implementation risk — the
   deterministic `onStep` seam already exists. The risk is a future contributor
   "fixing" an asserted silence. Mitigated by a one-line comment on each.
6. **2,680 production lines of one-way, unrevertible-after-`Q` fail-closed
   surface.** Mitigated by the dispatch plan and the one serial review, not by
   heroics in any lane.

---

## 9. Disposition of every review finding

| # | Finding | Disposition |
|---|---|---|
| 1 | Source changes misclassified as halts | **Folded.** §2.1 introduces the three-kind taxonomy; §2.3 adds the changed-`L` restart row, the retirement-cursor rows, and the halted-retirement row; M-6 returns `arm-retirement` dispositions; `source-changed` survives as a halt reason **only** as the retirement-cursor halt; `legacy-write-detected` becomes a disposition with its own copy entry |
| 2 | M3's API cannot perform its ordering | **Folded.** M-5 splits into `claimStagingMain` → (M-9 publishes the same-phase M2 revision) → `importOwnedStaging`, same module. §2.2's M3 row states the ordering |
| 3 | M-2 is not the sole publisher | **Folded.** `promotePreparedControl(root, expect, prepared, locks)` added to M-2, allocation-free; M-8 chooses when. Structural gate added in §6.9 |
| 4 | Halt publication and retry have no owner | **Folded.** `publishMigrationHalt` assigned to M-2, with rationale; M-9's `retryHaltedMigration` specifies three distinct paths (ordinary M0–M5 resource recreation, retirement/cleanup cursor preservation, promoted-halt promotion-as-clear); `cleanup.retryPromotedHalt` owns the last |
| 5 | Post-`Q` write admission missing | **Folded.** `blocksSqliteWrites` (pure, M-1) + `readCanonicalControl` (M-2) consumed by A-2 at the save boundary under the held state lock; r1's "A-2 may not touch migration" narrowed to one read and one predicate, stated as a deliberate exception. `StateAuthorityCorruptError` added as a hard, non-retryable error |
| 6 | Genesis has no owner | **Folded.** §1.3 assigns every step across the existing nine modules plus one `installGenesisCompletion` beside the merged `installGenesisLineage`. No tenth module |
| 7 | `stateSemanticDigest` seam overstated | **Folded, and the false claim is recorded in §0.3.** U3 builds `normalizeLegacyStateV1` + `legacyStateSemanticDigest` in the same file as the SQL projection, so the grammar cannot diverge |
| 8 | Entry preconditions incomplete/fictitious | **Folded.** §3.1 adds standing reset recovery *before* classification, the repository fence to the lock bundle, and replaces `assertSyncMutex` with `assertHealthyOwnedSyncMutex` |
| 9 | Crash/resume account incomplete | **Folded.** M2's recorded-identity recovery branch added to §2.2; M7's order corrected to publish→sibling→control in both §2.2 and M-8; the post-`b+4` runway cases, promoted-halt retry, both promotions, and the no-sibling-leak assertion enumerated in §6.2; role-7's byte-exact reserve-header reread made mandatory in M-8 and §6.2 |
| 10 | Abort differential wrong | **Folded.** §6.3 is now a per-phase table: the reserve survives an M0 abort and is retired by an M1–M5 abort, because it is a C1 vector item once claimed |
| 11 | Refusal taxonomy invents/contradicts | **Folded.** `workspace-busy` deleted; condition 2's failure is `migration-not-exclusive`; `reserve-foreign` is one M1 refusal with zero mutation, in `AdmissionRefusal` and in the refusal copy table |
| 12 | B0 gate reduced to drain | **Folded.** §6.8 records all five conditions with the known population and the requirement that 1–3 and 5 be dated and re-checked before the tag |
| 13 | Nine modules, not twelve | **Adopted.** Q5 withdrawn; budgets restated against the real rule (≤300 target / 301–399 with note / 400 hard fail); three modules carry an explicit review note; fallback splits retained as contingency only. The founder test is restated as "one cohesive protocol outcome" |
| 14 | Delete named mechanism | **Adopted, all six.** Daemon `migration-halted`/pump/catch deleted (verified absent from `main`; standing halts project like `reset-health.ts`); `DoctorRetryProof` deleted for one authenticated bundle + private driver; `StateAuthority` deleted; `workspace-busy` deleted; all path constructors moved to `paths.ts`; 1A/1B merged |
| 15 | False wave boundaries | **Adopted.** M-1/M-2 merged; halt codes pulled into Wave 1; M-5/M-7/M-8 consume classifier receipts; F2/F3/F5/F6 moved from Wave 4 to Wave 5C; Wave 5 made serial with only harness prep parallel; one named integration owner |
| 16 | Top risks wrong | **Adopted.** §8 re-ranked: classifier/control-schema/runway cross-product first, missing fence + genesis owner second, M3's interstitial CAS third, `whole-state-compat` demoted to top perf/compat risk, F5/F6 demoted to assertion maintenance |
| 17 | Upgrade restart needs `finally` | **Folded.** §3.2 Entry A specifies the restructured block with the restart in a `finally`, unconditional for every outcome, and states why post-`Q` also restarts |
| Q1 | Wait for Tier 0 | **Adopted, with one correction — below** |
| Q2 | Rig confirmed resolved | **Adopted.** §6.6 reduced to two items |
| Q3 | No third beginning | **Adopted.** Two fresh-entry sites + one doctor authorization into a private driver |
| Q4 | Paths in `paths.ts` | **Adopted**, including revision-scoped sibling paths; M-2 keeps revision arithmetic/validation only |
| Q5 | Nine, not twelve | **Adopted** |
| Q6 | `rbox migrate` on a migrated workspace | **Adopted.** `already-migrated`, exit 0, classify the terminal row, zero M0–M7 mutation |
| Q7 | Delete daemon migration lifecycle | **Adopted.** §4's last bullet |
| Q8 | Frozen profile is U5's | **Adopted, with the sampling shape replaced.** §6.5 defines a workload-paired p95 comparison instead of the invented 5-minute window |

### The one place I do not comply

**Q1's conditional instruction to delete §0.2 "if central `main` has advanced."**
It has not. Re-verified this round: `origin/main` is `1a78fa32`;
`gh pr view 574` returns `state: OPEN`, `mergedAt: null`; and
`src/cli/state-plane/migration/` contains only `health.ts`, `reserve.ts`,
`last-writer-witness.ts` and their tests — no `base-proof.ts`, no
`import-stage.ts`, and no `withMigrationImporter` anywhere in `src/`. #576, #577,
#578, and #579 are all merged and are reflected in §0.1; **#574 is not**.

I have adopted the substance of the ruling — **no wave starts until every Tier 0
gate closes**, and r1's early-start exception is withdrawn — but §0.2 stays, with
its evidence, because deleting it would assert a merge that has not happened.

### Open questions r2 does not answer

r1's Q1–Q8 are all resolved by the rulings above. Two new ones, both narrow:

**N1 — where does the repository fence come from at the `rbox upgrade` entry?**
§3.1 requires it "where repositories are present", but the upgrade stop window
operates per workspace from `~/.rbox/daemons` records and does not today hold a
repository fence. Either the entry acquires it after `stop`, or `admitMigration`
refuses a repo-bearing workspace from that entry and only `rbox migrate` can
migrate one. The first is better UX; the second is smaller. Not settled.

**N2 — does `installGenesisCompletion` belong in `schema/application.ts`?**
§1.3 puts it beside `installGenesisLineage` because both are behavior-free row
installers run inside `initializeStateStore`. The counter-argument is that
`migration_completion` is a migration concept and `schema` "owns no runtime
policy" (163:3994). The row is constant-valued for genesis, which is why I chose
`schema`, but a reviewer may reasonably rule it into `import-json.ts` instead.
