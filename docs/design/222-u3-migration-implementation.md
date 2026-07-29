# 222 — U3 implementation design: the migration unit, the `Q` flip, and the whole-state adapter

> Status: **r3**, revised against the codex review of r2 (NOT-ALIGNED, 6 CRITICAL
> + 5). §10 records the per-finding disposition. Not implementation authority
> until Claude + codex align.
>
> **The structural change in r3: genesis is no longer a migration.** Findings 5,
> 6, and 10 were all genesis, and 10 asked to delete mechanism r2 had just added
> for it. Genesis is now its own small operation (§2) outside the M0–M7 machine
> entirely, and every "unless genesis" branch is gone from the nine migration
> modules. §2.5 records the one 163 amendment this requires and argues it.
>
> Normative source: `docs/design/163-state-plane-sqlite.md` (ratified v10 +
> `MIGRATION-EXCLUSIVITY-v11`). Where this document and 163 disagree, **163
> wins** — except at §2.5, which proposes an explicit, argued, one-row amendment
> and says so. Build blueprint: sweep-4 Tier 1.
>
> Founder's bar:
>
> > "keep our domains clean and tight and as small as possible. No stupid long
> > comments. Build simple code that works and is easy to understand. Don't try
> > to be cute. Genius has the fewest moving parts."
>
> A module owns **one cohesive protocol outcome**, not one function or one phase.
> Splitting is not free. Split only on measured evidence, never to manufacture
> parallelism.

## 0. Scope

U3 carries the **one-way authority change** from `.rbox/state.json` to
`.rbox/state/state.db`, and nothing else. The scan/reconcile/apply engine is
byte-identical across the flip.

U3 **is**: the nine-module M0–M7 migration machine (sweep-4 T1.3); the genesis
operation (§2); the two deferred adapters (T1.1 steps 4–5); two entry points plus
one doctor-authorized retry; the halt/refusal/disposition taxonomy with
plain-English copy and a non-interactive twin; the exit gates.

U3 is **not**: ambient or on-boot migration; the paired-interval live-writer
sampling (v11 deletes it); a generic capability framework; any engine port.

U3 is the only unit that opens the `2.0` branch. This document does not open it.

### 0.1 Foundation verified merged on `origin/main` (`1a78fa32`)

| Merged | Provides |
|---|---|
| `state-plane/paths.ts` (#579) | `statePath`, `stateLockPath`, `stateIncarnationPath`, `sqliteResetPaths`. 25 lines — **U3 adds every migration and genesis path constructor here** |
| `adapters/legacy-json-store.ts` (#579) | `loadRawState`, `loadState`, `applyStateSavePacket`, `saveState`, `ensureTelemetryBindingId`, `installGenesisResetStateUnderHeldLock` |
| `store/owner-token.ts` (#579) | `casOwnerTokenFromLock(lock): OwnedLockCasToken` — sole production mint site |
| `store/open.ts::initializeStateStore(file, install)` (#577) | Claimed-file initializer. **Opens `"wx"` — requires the path ABSENT** (`open.ts:218`). See finding 1 |
| `schema/application.ts` (#577) | `applySchemaV1`; `installGenesisLineage`, which **already inserts the `migration_completion` singleton with `origin_kind='genesis'` and `authority_id`, last in its own transaction** (`application.ts:67`) |
| `errors.ts` (#578) | `StateDataCorruptionError`, `decodeAuthorityRow`, `ProoflessBaseError`, `StateFormatTooNewError`, `StreamMismatchError`, `StateWriteRefusedError(reason, file, detail?)` |
| `codecs/git-section.ts` (#578) | Git-section codec |
| `doctor-state-plane.ts` + `migration/health.ts` (#576) | `MigrationHaltCode = never`, `MIGRATION_HALT_COPY = {} satisfies Record<…>` |
| `authority-marker.ts` (B0) | `AUTHORITY_MARKER_BYTES = 58`, `classifyStateFormat`, `assertStateReadable`, `assertStatePublishable` |
| `migration/reserve.ts`, `migration/last-writer-witness.ts` (B0) | 128-byte reserve header; `BARRIER_DOWNGRADE_FLOOR = "1.11.0"`, `verifyLastWriterWitness` |
| `reset/index.ts`, `reset-health.ts` (U2) | `sqliteResetFacade`; `ResetHaltHealthV1` / `readResetHaltHealth` — **the standing-halt projection precedent** |
| `store/*` (U1a/U1b) | `applyCasPacket`, `StageLock`, sealed stages, transition stages, `buildCasRetryView`, `read-snapshot` |
| `engine/git/protocol-locks.ts` | `withRepositoryRecoveryFence(requests, stateIdentity, fn, options)` — **callback-scoped, not a handle** |
| `scripts/rig/lib/binary.ts` | `resolveRigBinaryPaths`, `prepareRigBinarySelection` → per-device staged artifacts |

### 0.2 NOT merged — a hard prerequisite

`migration/base-proof.ts`, `migration/import-stage.ts`, `withMigrationImporter`,
`sync-git/base-proof-selection.ts` are on **PR #574** (sweep-4 T0.1).
Re-verified this round: `origin/main` is `1a78fa32`; `gh pr view 574` →
`state: OPEN`, `mergedAt: null`. No wave starts until it merges (§8 Gate 0).

### 0.3 Seams r1/r2 claimed that do not exist

| Claimed | Reality | Fix |
|---|---|---|
| `stateSemanticDigest` serves both sides | `stateSemanticDigest(db: Database)` — SQL only | U3 builds the JSON side (§1.1 M-5) |
| `assertSyncMutex` proves the window | It is a shape check; `assertHealthyOwnedSyncMutex` (`:325`) verifies live ownership | §3.1 |
| A daemon `migration-halted` state exists | No `StateMigrationHaltError`, no pump, no catch, no `StateAuthorityCorruptError` | Deleted; halts project like `reset-health.ts` |
| `initializeStateStore` can adopt a claimed file | It opens `"wx"` and rejects an existing path | §1.1 M-5 / finding 1 |
| `RepositoryFence` is a holdable handle | The fence is callback-scoped | §3.1 |
| `migration-write-blocked` is a `StateWriteRefusalReason` | It is not, and the error requires a file path | §1.2 A-2 |

---

## 1. Module-by-module

163:3994: production files **target ≤300 nonblank lines**, **301–399 permitted
with a review note**, **400 lines / 25 KiB is the hard CI failure**. Ruling
adopted: **nine migration modules, not twelve.**

### 1.1 The nine migration modules (`src/cli/state-plane/migration/`)

| # | Module | The one protocol outcome it owns | Budget |
|---|---|---|---:|
| M-1 | `control-codec.ts` | The control record as a value: closed union, canonical bytes, pure predicates, the C1 trigger type | 300 |
| M-2 | `control-publication.ts` | Every durable transition of the canonical control file | 280 |
| M-3 | `classifier.ts` | One admitted observation row, mutating nothing | 300 |
| M-4 | `admission.ts` | May a migration begin or continue right now | 260 |
| M-5 | `import-json.ts` | A **proven staging DB** derived from an admitted source | 340 |
| M-6 | `finalize.ts` | The prepared DB becomes authority — the one flip | 280 |
| M-7 | `retirement.ts` | C1: a superseded migration's artifacts are gone | 260 |
| M-8 | `cleanup.ts` | Terminalization: cursor, runway, M7 | 360 |
| M-9 | `authority.ts` | Sequencing over typed receipts. No filesystem primitives | 240 |

M-3, M-5, and M-8 sit in the 301–399 band; the review note is that each is one
correlated machine 163 specifies as a unit, and cutting it would split a durable
correlation across a module boundary — the failure r2's finding 3 caught.

**Migration production budget: 2,620 lines** (down from r2's 2,680 — genesis
branches removed from four modules, offset by the retry buckets and typed
receipts). Genesis adds a separate 180 (§2). Adapters add 600 (§1.2).

---

#### M-1 `control-codec.ts`

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

/** FINDING 9 — the C1 trigger. The OUTWARD disposition is either
 * `source-changed` or `legacy-write-detected`, but 163's closed retirement
 * record has literal `reason: "source-changed"` and exactly one durable reason
 * (163:2711). This type makes the mapping explicit and total, so a second
 * durable reason cannot be added by accident. It lives HERE, not in
 * `finalize.ts`, so Wave 3 does not depend on Wave 4. */
export type C1Trigger =
  | { disposition: "source-changed"; replacement: SourceIdentity }
  | { disposition: "legacy-write-detected"; observedBodySha256: string };

/** Total, and the only encoder of the durable reason. */
export const durableRetirementReason = (_: C1Trigger): "source-changed" => "source-changed";

/** FINDING 3 — the post-`Q` write fence, as a pure predicate over the canonical
 * control observed on the SQLite-selected branch. TRUE for:
 *   - a durable `durability-indeterminate` halt, AND
 *   - any control whose phase is BELOW M6 — i.e. the exact `M5 + Q`
 *     artifact-ahead row, where the flip happened but M6 publication and its
 *     parent fsync did not (163:3253 requires writes to stay blocked until
 *     recovery finishes).
 * FALSE for `cleanup-deferred`, which is explicitly writable. */
export function blocksSqliteWrites(control: MigrationControl): boolean;

/** The one halt whose clear is a promotion rather than a CAS-clear. */
export function isFinalIntentPromotedHalt(control: MigrationControl): boolean;
```

**May NOT touch.** The filesystem, SQLite, the state document, path computation
(`paths.ts` owns paths), or any notion of "current".

**No genesis variants.** `origin_kind` is a DB column, not a control phase.

---

#### M-2 `control-publication.ts`

```ts
export interface PublishExpectation { migrationId: string | "absent"; revision: number | "absent" }

/** FINDING 7 — ordinary publication and prepared promotion share ONE private
 * canonical-replacement primitive: revalidate the target under `expect`,
 * no-follow revalidate the source inode/length/hash/canonical bytes, rename,
 * fsync `.rbox/state`, exact reread. Neither exported entry point implements
 * its own rename. */
function replaceCanonicalControl(root, expect, source: ExactControlBytes, locks): MigrationControl;

/** Exclusive revision-scoped sibling → canonical bytes → file fsync → replace. */
export function publishMigrationControl(root, expect, next: MigrationControl, locks): MigrationControl;

/** Render a prepared future-control sibling WITHOUT publishing it (`b..b+4`). */
export function renderPreparedControl(root, revision: number, next: MigrationControl, locks): PreparedControlIdentity;

/** FINDING 3 (r2) + FINDING 7 (r3) — allocation-free promotion of an
 * ALREADY-EXACT prepared sibling. Immediately before the rename it no-follow
 * revalidates the recorded inode, byte length, SHA-256, and canonical bytes for
 * its fixed kind/revision; anything else is foreign and it does not rename.
 * Allocates nothing: no temp, no write, no truncate. `cleanup` decides WHEN. */
export function promotePreparedControl(root, expect, prepared: PreparedControlIdentity, locks): MigrationControl;

/** FINDING 8 — a discriminated result. The nondurable branch carries NO next
 * control, so a caller cannot keep publishing after a failed halt. */
export type HaltPublication =
  | { durable: true;  control: MigrationControl }
  | { durable: false; reason: unknown };            // no control — nothing to continue from

/** Publishes the SAME phase with an incremented revision, the exact
 * `halt:{reason,phase,underlyingCode,required,available}`, and updated
 * `haltResources`. If publication needs space it releases/unlinks the exact
 * previously-available reserve and records it `consumed-for-halt`. It NEVER
 * consumes a retirement- or cleanup-vector item as runway and never relabels a
 * current intent. */
export function publishMigrationHalt(root, control, halt: MigrationHalt, locks): HaltPublication;

export function readCanonicalControl(root: string): MigrationControl | undefined;
```

**May NOT touch.** Phase logic, artifact cleanup, the DB, the state document, or
path construction. It owns revision **arithmetic and validation** (safe integers,
exact spacing, the monotone `r → r+2` gap as the only permitted one).

**Why halt publication lives here.** "Publish a durable record even when the disk
is full" is a publication concern, and the mechanism that makes it possible —
releasing the pre-allocated reserve — is an allocation concern of the same act.

---

#### M-3 `classifier.ts`

```ts
export type MigrationObservation =
  | { row: "no-control-json" }                                   // JSON authority, eligible for M0
  | { row: "genesis-candidate" }                                 // absent/absent/absent → §2
  | { row: "genesis-finish-ahead"; authorityId: string }         // §2.5 — the one amendment
  | { row: "m0-resume" | "m1-resume" | "m3-resume" | "m4-resume"; receipt: PhaseReceipt }
  | { row: "m2-resume"; receipt: PhaseReceipt; staging: StagingMainObservation }
  | { row: "m5-resume"; receipt: PhaseReceipt; sibling: QSiblingObservation }
  | { row: "source-changed"; receipt: PhaseReceipt; trigger: C1Trigger }
  | { row: "retirement-cursor"; receipt: PhaseReceipt; cursor: RetirementCursor }
  | { row: "m5-artifact-ahead-q"; receipt: PhaseReceipt }        // SQLite elected, writes blocked
  | { row: "m6-cleanup"; receipt: PhaseReceipt; cursor: CleanupCursor }
  | { row: "m7"; receipt: PhaseReceipt }
  | { row: "terminal-sqlite" }
  | { row: "halted"; receipt: PhaseReceipt; halt: MigrationHalt }
  | { row: "corruption"; halt: MigrationHalt };

/** FINDING (wave coupling) — `PhaseReceipt` is the typed, phase-bound evidence
 * every mutator consumes. It brands the exact control revision it was derived
 * from, so a mutator cannot be handed a raw `MigrationControl` and cannot use a
 * receipt across a revalidation boundary. */
export interface PhaseReceipt { readonly phase: MigrationPhase; readonly control: MigrationControl; /* branded */ }

/** Observe without mutating. `lstat`-only, no-follow, bounded reads; the active
 * DB is opened READ-ONLY. Caller has completed standing reset recovery and
 * holds the lock set. */
export async function classifyMigrationState(root, locks): Promise<MigrationObservation>;
```

Contradictory authority — exact `Q` with an absent, incomplete, unreadable,
foreign, or wrong-`authority_id` DB — is a hard `StateAuthorityCorruptError`
(new class in `errors.ts`, **landed in Wave 1 so Wave 2C does not depend on Wave
2A**), zero repair writes, not a `MigrationHaltCode`, never offered a retry.
`Q` + a *matching complete* DB with M5 control is **not** corruption; it is the
`m5-artifact-ahead-q` row.

**Zero writes**, enforced by import graph. One table-driven test per row, plus a
byte-for-byte `.rbox` snapshot before/after every corruption row.

---

#### M-4 `admission.ts`

```ts
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
export async function admitMigration(root, entry: MigrationEntryProof, locks): Promise<AdmissionVerdict>;

/** M1: design 161's unchanged 52× admission, 512 MiB hard cap, RSS/cgroup
 * budget, advisory `statfs`, and the reserve claim. `reserve-foreign` is a
 * refusal with nothing adopted, claimed, truncated, or deleted. */
export async function admitMigrationBudget(root, sourceBytes: number, stream: string): Promise<BudgetVerdict>;
```

The five conditions (163 §3 bullet 3): non-`degraded-unlocked` locking health →
`degraded-fence`; no live/recent workspace operation →
`migration-not-exclusive`; `.rbox/state/quarantine/` absent →
`quarantine-pending`; `verifyLastWriterWitness` matches all five fields with
`writerVersion >= 1.11.0` → `barrier-witness-missing`; the exclusivity window
proven (§3.3) → `migration-not-exclusive`.

**No `admitGenesis`.** Genesis has its own precondition inside its own operation
(§2.2). Refusals publish nothing and are freely retried.

A structural test asserts `legacy-writer-live` and any paired-interval sampling
appear nowhere in `src/`.

---

#### M-5 `import-json.ts`

```ts
/** M2 — preamble-prefixed STREAMING copies only (hard links forbidden, v7).
 * Preserves a differing prior fixed backup under its own verified body hash
 * first. Returns body + physical hashes for both backups. */
export async function preserveSource(root, receipt: PhaseReceipt, source: SourceIdentity, locks): Promise<M2Witness>;

/** FINDING 1 — step 1 of M3, with the create-ahead branch made explicit.
 * Admits exactly three observations of the staging main path:
 *   absent                      → `O_EXCL` no-follow create, fsync file, fsync
 *                                 `.rbox/state`, identity-bracket;
 *   the sole create-ahead shape  → ADOPT it (exact path, no-follow regular,
 *   (zero-byte, 0600, no sidecars)  zero-byte, mode 0600, no sidecars), fsync
 *                                 file and parent, identity-bracket;
 *   a recorded incomplete main   → identity-bracket, remove it AND only its own
 *   with its own sidecars only     sidecars, then create fresh.
 * Anything else — a sidecar without its main, a non-regular or followed path, a
 * nonzero unrecorded file, a foreign identity — is a `reserved-path` halt with
 * zero writes. */
export async function claimStagingMain(root, receipt: PhaseReceipt, locks): Promise<StagingMainClaim>;

/** Step 2 belongs to M-9: CAS-publish the SAME-PHASE M2 revision recording that
 * exact identity (163:3163). It returns the branded receipt below, which is the
 * ONLY way to reach step 3. A generic `MigrationControl` no longer type-checks
 * here, so the interstitial CAS cannot be skipped. */
export interface PublishedStagingClaim { readonly claim: StagingMainClaim; readonly receipt: PhaseReceipt; /* branded */ }

/** FINDING 1 — step 3. `initializeStateStore` opens `"wx"` and REJECTS an
 * existing path (`open.ts:218`), so it cannot be used on the already-claimed
 * file. U3 adds a sibling in `store/open.ts`:
 *
 *   export function adoptClaimedStateStore(file, install): StateStoreHandle
 *
 * identical to `initializeStateStore` except that it opens the EXISTING file
 * and asserts it is the exact no-follow regular zero-byte 0600 inode the caller
 * claimed, instead of creating it. Both delegate to one private body; on any
 * failure both remove the file and its sidecars. `createStateStore` keeps using
 * the creating variant. This is the smallest change that makes the required
 * ordering expressible — the alternative, letting the importer create the file,
 * is exactly the ordering 163:3163 forbids.
 *
 * Step 3 then re-runs 52×/RSS admission immediately before the sole guarded
 * parse, computes the JSON-side semantic stream, and imports every plane/record
 * in ONE transaction with `migration_completion` inserted LAST.
 *
 * The completion-ahead branch: if the claimed file already carries an exact
 * committed completion tuple for this migration id, this reads it back and
 * returns it without re-importing (163:3249's sole M3-artifact-ahead form). */
export async function importOwnedStaging(
  root, published: PublishedStagingClaim, source: SourceIdentity, locks,
): Promise<M3Witness>;

/** M4 — WAL recover if needed, `wal_checkpoint(TRUNCATE)` non-busy, close,
 * require `S0`; reopen read-only, recompute the SQL semantic stream/counts,
 * validate application/user/DDL ids, `foreign_key_check`, full
 * `integrity_check`; close, require `S0` again; fsync DB + state dir;
 * physical-hash under identity bracketing. */
export async function proveStaging(root, receipt: PhaseReceipt, locks): Promise<M4Witness>;
```

**The JSON side of the digest does not exist and U3 builds it.**
`digest/state-semantic-v1.ts` exports only `stateSemanticDigest(db: Database)`.
U3 adds, **in that same file** (74 lines today):

```ts
/** The named v1 normalization of a legacy `SyncState`: strips `resolutionIntent`
 * BEFORE the digest (never routed to `extras_cjson`, no shape-presence bit),
 * normalizes invalid repo counters to zero, derives the full source-shape
 * presence bits. The one place legacy shape becomes canonical. */
export function normalizeLegacyStateV1(state: SyncState): NormalizedLegacyState;
export function legacyStateSemanticDigest(n: NormalizedLegacyState): StateSemanticDigest;
```

One file, because a grammar divergence between the two sides is precisely the
failure this digest exists to catch. `import-json.ts` calls them; it does not own
the grammar. The same normalization supplies the `source_shape_flags_cjson`
presence bits that `installGenesisLineage` currently writes partially (finding
10's second half) — genesis passes its own constant flags, migration passes
derived ones, and both go through one builder.

**May NOT touch.** `.rbox/state.json` beyond reading the bracketed source, the
active `state.db`, the Q sibling, the control record, or cleanup.

---

#### M-6 `finalize.ts`

```ts
/** M5 — rename staging over `state.db`, durably remove only a redundant exact
 * staging name, require staging absent and active `S0`, fsync `.rbox/state`.
 * Returns the witness with the Q-sibling path/bytes/sha PREBOUND, disposition
 * `absent`. JSON remains authority throughout. */
export async function publishPreparedDatabase(root, receipt: PhaseReceipt, locks): Promise<M5Witness>;

/** M6 — one fs step of the Q-sibling ladder (`absent → building → exact`);
 * M-9 performs each same-phase CAS between steps. */
export async function stepQSibling(root, receipt: PhaseReceipt, locks): Promise<QSiblingStep>;

export type FlipOutcome =
  | { kind: "flipped"; witness: M6Witness }
  | { kind: "arm-retirement"; trigger: C1Trigger };   // both dispositions, one shape

/** FINDING 6 (resolved by removal) — migration-only, and the source witness is
 * ALWAYS real. There is no nullable-witness branch and no genesis caller.
 *
 * Revalidates source/backups/completion; then — as the LAST operation before
 * `fs.rename`, with NOTHING between them — re-verifies the live `state.json`
 * body hash against the M3-imported source digest under the held
 * `stateLockPath`. Then renames, and fsyncs `.rbox`. */
export async function flipAuthority(
  root, receipt: PhaseReceipt, source: SourceIdentity, locks,
): Promise<FlipOutcome>;
```

**May NOT touch.** Cleanup, the control's revision arithmetic beyond asking M-2,
the import path. It never deletes a backup or the source.

Both invariants stay under attack: no fsync, hash, or logging between the check
and the rename; and all five M0 conditions re-checked here.

---

#### M-7 `retirement.ts`

```ts
/** Arm retirement: CAS-publish the closed union with `durablePrefix: 0` and no
 * intent, BEFORE deleting anything. `reason` is always the literal
 * `durableRetirementReason(trigger)` — one durable reason, both dispositions
 * (finding 9). `items` derives ONLY from the old exact control's own recorded
 * artifacts; it never discovers a path. */
export async function armRetirement(root, receipt: PhaseReceipt, trigger: C1Trigger, locks): Promise<MigrationControl>;

/** Advance the cursor by exactly one position (163:2704 table), including the
 * terminal-prefix step: at complete prefix, unlink the control and fsync. */
export async function stepRetirement(root, receipt: PhaseReceipt, locks): Promise<RetirementStep>;
```

**May NOT touch.** The current source `L`, the immutable backup history, the
fixed backup, or any path not in the armed vector.

The vector (163:2704), fixed-role, deduplicated, ordered: Q sibling → staging
`-journal`, `-wal`, `-shm` → staging main → prepared active DB → migration-id
private artifacts (role 5 only, and only revision-scoped siblings the retiring
control names) → emergency resource → **the claimed reserve**.

A retirement halt preserves the **exact cursor**; halt publication consumes no
vector item as runway and never relabels a current intent.

---

#### M-8 `cleanup.ts`

```ts
export async function stepCleanup(root, receipt: PhaseReceipt, locks): Promise<CleanupStep>;

/** Drive `b → b+4` one durable ledger row at a time (163:2951). Never creates a
 * second pair; always resumes the same ledger stage and inode. A caught ENOSPC
 * here publishes NO alternate control (the named scoped f6 exception). */
export async function stepFutureControlPreparation(root, receipt: PhaseReceipt, locks): Promise<PreparationStep>;

/** At ready `r = b+4`: byte-exactly re-match all 128 reserve-header bytes before
 * unlinking role 7; unlink the final item; fsync its recorded parent; then ask
 * M-2 to `promotePreparedControl` the exact M7 sibling under expected `r`. On a
 * caught failure BEFORE that promotion begins, promote the prepared halted-M6
 * sibling instead. Once either begins, the other is never published. */
export async function completeFinalItem(root, receipt: PhaseReceipt, locks): Promise<FinalItemOutcome>;

/** The one halt whose clear IS a promotion (expected `r+1` → exact `r+2`). */
export async function retryPromotedHalt(root, receipt: PhaseReceipt, locks): Promise<FinalItemOutcome>;

/** M7 — published FIRST from the prepared `r+2` sibling, converting resources to
 * `retired`; THEN unlink the unused `r+1` sibling if exact-terminal and fsync;
 * THEN unlink the control and fsync. Asserts role-5 inert temps by `lstat` over
 * the control's own recorded revision interval; no directory discovery. */
export async function finishMigration(root, receipt: PhaseReceipt, locks): Promise<void>;
```

**May NOT touch.** The active DB, `Q`, the Q sibling, the backups,
`cache-v1-retired/`, or any legacy reset artifact. Roles 1–4 present at M6 are a
`reserved-path` corruption halt with zero writes.

**No genesis branch.** Genesis claims no reserve and no emergency candidate, so
r2's "genesis reaches M7 with an empty vector" — which finding 5 correctly showed
does not fit the control schema, where `not-created` is legal only at M0 and
`retired` requires M7 absence plus parent fsync — is gone with genesis itself.

---

#### M-9 `authority.ts`

```ts
export type MigrationOutcome =
  | { kind: "migrated"; phases: MigrationPhase[]; elapsedMs: number }
  | { kind: "genesis"; elapsedMs: number }
  | { kind: "already-established" }                 // terminal row, zero mutation
  | { kind: "refused"; refusal: AdmissionRefusal }
  | { kind: "retired"; trigger: C1Trigger }
  | { kind: "halted"; halt: MigrationHalt; durableHalt: boolean };

/** ONE classified dispatcher behind both entry sites. It classifies under the
 * locks and routes: `genesis-candidate` / `genesis-finish-ahead` → the genesis
 * operation (§2); every other row → the migration driver. There is no separate
 * `runGenesis` entry and no forgeable `DoctorRetryProof`. */
export async function runStateAuthorityTransition(
  root, entry: MigrationEntryProof, onProgress,
): Promise<MigrationOutcome>;

/** FINDING 2 — the private migration driver. Before EVERY M1–M6 mutator —
 * including all three split-M3 seams — it revalidates source identity/hash and
 * the exact control revision, and mints a fresh `PhaseReceipt`. A stale receipt
 * cannot reach a mutator, and an observed source change arms C1 instead of
 * mutating (163:2699). */
async function drive(root, locks: HeldMigrationLocks, start: MigrationObservation): Promise<MigrationOutcome>;

/** FINDING 8 — every mutator's halt path routes through `publishMigrationHalt`;
 * on `{durable: false}` the driver returns IMMEDIATELY and performs no further
 * migration write. There is no control to continue from, by type. */

/** FINDING 4 — four exhaustive retry buckets, keyed on the classified halted row:
 *  1. ordinary halted M0–M5 — recreate/fsync any `consumed-for-halt` or
 *     `not-created` resource, CAS-publish the same phase with both dispositions
 *     `available`, clear, resume;
 *  2. C1 or M6-cleanup cursor halt — preserve the exact cursor, clear, resume
 *     ONLY its current target, INCLUDING the terminal-prefix work (a failed
 *     terminal-control unlink has no "current target" and is resumed as the
 *     terminal step, not as a target);
 *  3. ordinary halted M7 — CAS-clear, then `finishMigration` (sibling retirement
 *     and terminal control unlink);
 *  4. final-intent `promotedHalt` — NO clear; validate and delegate one
 *     single-use in-process attempt to `cleanup.retryPromotedHalt`.
 * The switch is exhaustive over the halted rows; a new row without a bucket does
 * not compile. */
export async function retryHaltedMigration(root, locks): Promise<MigrationOutcome>;

/** Pre-`Q` abort: run C1 to completion against its own migration id. */
export async function abortMigration(root, locks): Promise<MigrationOutcome>;
```

**Structural tests.** No `node:fs`, `node:crypto`, or `bun:sqlite` in this
module's import graph; exactly **two entry call sites** of
`runStateAuthorityTransition` plus **one doctor authorization site**.

---

### 1.2 The two adapters

#### A-1 `adapters/sqlite-state-save.ts` — writes go native (260)

```ts
export async function applySavePacketToStore(
  store: StateStoreHandle, packet: StateSavePacket, ownerToken: OwnedLockCasToken,
): Promise<CasResult>;
```

Consumes only merged seams (`beginGeneration`, `beginRepoTransitionStage`,
`StageLock`, `applyCasPacket`, `casOwnerTokenFromLock`). Returns the raw
`CasResult`. May not touch authority selection, the JSON path, or migration.

#### A-2 `adapters/whole-state-compat.ts` — the sole authority selector (340)

Owns: authority selection via `classifyStateFormat`; the typed
`StreamMismatchError` on a different-stream read on **both** backends, never a
manufactured genesis baseline; shared reset recovery and reset-lineage
provenance; exhaustive raw `CasResult` translation against the retry view's exact
token, closing the view, **without widening `StateSaveResult`**.

**The one narrow migration dependency (findings 3 + 11).** A-2 performs exactly
one check, at the SQLite save boundary only, under the already-held state lock:

```ts
// `errors.ts` gains one member to `StateWriteRefusalReason`:
//   /** A durable migration control blocks writes until recovery finishes. */
//   | "migration-recovery-pending"
const control = readCanonicalControl(root);
if (control && blocksSqliteWrites(control)) {
  throw new StateWriteRefusedError("migration-recovery-pending", sqliteResetPaths.active(root));
}
```

`blocksSqliteWrites` is true for a durable `durability-indeterminate` halt **and
for any pre-M6 control on the SQLite branch** — the `M5 + exact Q` row, where the
rename landed but M6's publication and parent fsync did not. `cleanup-deferred`
is false and writes proceed. That is the whole dependency: one read, one pure
predicate, on the write path only.

Contradictory authority throws `StateAuthorityCorruptError` from selection, zero
repair writes, not a halt, never retryable.

**Standing-halt visibility without a daemon lifecycle.** No `migration-halted`
state, no pump, no catch — none exist and v11 forbids daemon migration. A
standing durable halt is *projected* from the control into the existing
doctor/status surface, exactly as U2's `reset-health.ts` does for reset.

**Call-site inventory.** CI counts `loadState()` production call sites; may only
decrease; zero by U4f.

---

## 2. Genesis — its own operation, not a migration

### 2.1 Why it is not a migration (the ruling, and the evidence)

r1 assigned genesis nowhere. r2 threaded it through M0–M7 and immediately drew
three CRITICALs (5, 6, 10), one of which asked to delete the mechanism r2 had
just added. That is the signature of the wrong layer.

**A genesis workspace has no source document.** Every invariant the M0–M7 machine
exists to enforce — source witness, source revalidation before every mutation,
backup preservation, import fidelity, changed-`L` detection, retirement of a
superseded authority, the reserve/emergency runway that protects a large import —
is *vacuous* for genesis. The machine's entire purpose is safely retiring a
source. Threading a no-source case through it produces a `null` witness, an empty
cleanup vector that does not fit the control schema, and phase rows with nothing
to observe.

163 already says genesis arrives on a different schedule: it is "reachable as
soon as U1's store and U2's reset support exist — **before** migration is enabled
on any real workspace" (163:4488-4494). A thing reachable before the machine
exists is not a step of the machine.

**Genesis is therefore its own module: `src/cli/state-plane/genesis.ts`, ~180
lines.** Not under `migration/`. It depends only on merged U1/U2 seams, so it can
be built and validated in Wave 1 rather than after the flip.

### 2.2 The operation

```ts
export type GenesisOutcome =
  | { kind: "established"; authorityId: string }
  | { kind: "already-established" }
  | { kind: "refused"; reason: "legacy-present" | "artifact-present" | "evidence-missing" };

/** Establish SQLite authority on a workspace that has none. Caller holds the
 * same exclusivity lock bundle a migration holds (§3.1) and has completed
 * standing reset recovery. */
export async function establishGenesisAuthority(
  root: string, genesis: GenesisLineage, locks: HeldMigrationLocks,
): Promise<GenesisOutcome>;
```

Five steps. No control record, no phases, no witnesses, no reserve, no
retirement.

1. **Confirm no authority exists.** `.rbox/state.json` absent (not `L`, not `Q`),
   `.rbox/state/state.db` absent, `.rbox/state/migration-v1.json` absent, and the
   fenced config/incarnation/reset evidence 163's matrix requires. Otherwise
   refuse — publishing nothing, creating nothing.
2. **Build the store, in one transaction, at its final active path.**
   `initializeStateStore(sqliteResetPaths.active(root), db => installGenesisLineage(db, genesis))`.
   Both are merged and unchanged. `installGenesisLineage` **already** inserts the
   `migration_completion` singleton with `origin_kind='genesis'` and
   `authority_id` last in its own transaction (`application.ts:67`) — which is
   why finding 10 is right that a sibling installer would duplicate the row, and
   why §2.3 works at all. `initializeStateStore` removes the file and its
   sidecars on any caught failure.
3. **Make it durable.** Checkpoint, close, require `S0`, fsync the DB and
   `.rbox/state`.
4. **Re-verify, as the immediately preceding operation to the rename, under the
   held `stateLockPath`, that `.rbox/state.json` is still absent.** This is
   finding 6's real requirement and the one thing from r2's genesis design that
   survives: an `L` created after step 1 must never be overwritten by `Q`. A
   non-absent observation refuses with `legacy-present` and renames nothing.
5. **Publish `Q`.** Exclusively create the genesis sibling
   `.rbox/state.json.genesis.<authorityId>.q` (unlinking any prior leftover
   first), write the exact 58 bytes derived from `authorityId`, fsync, rename
   over `.rbox/state.json`, fsync `.rbox`.

Step 5 deliberately does **not** use M6's `absent → building → exact` ladder. That
ladder exists to make a partially-written sibling resumable *across a durable
control record*. Genesis has no control record and nothing to honor, so a partial
sibling is simply discarded and rewritten from scratch. The genesis sibling path
is a named inert member of the `.rbox` namespace inventory — the same treatment
B0's reserve received — so a leftover is a recognized sweepable artifact, not an
unknown name that trips a reserved-path halt.

### 2.3 Crash safety without a control machine

Three observable images, and every one is either nothing or resumable by pure
re-derivation:

| Crash point | Observation | Resolution |
|---|---|---|
| Before step 2 commits | absent `L`, absent-or-**incomplete** DB (no `migration_completion` singleton), absent `Q`, no sidecars | A DB without that exact record "is incomplete, regardless of tables or file presence" (163:2612) — provably not authority and provably nobody's data. Genesis identity-brackets and removes it, then retries. `initializeStateStore` already does this for every caught failure; only `SIGKILL`/power loss reaches here |
| After step 2, before step 5's rename | absent `L`, **complete DB with `origin_kind='genesis'`**, absent `Q`, absent control | **Resumable.** Re-derive the 58 `Q` bytes from the DB's own `authority_id`, re-run steps 4 and 5. Idempotent and deterministic; nothing is read from a control record because the DB *is* the record |
| After the rename | `Q` + matching complete DB + absent control | 163's existing terminal SQLite row, unchanged. `already-established` |

A stranded genesis sibling with no `Q` is an ordinary sweepable leftover, removed
by the next attempt or by doctor's existing inert-artifact path.

**The ambiguous state finding 5 cited is unreachable, not classified.** 163:2603's
"absent legacy + any DB + any control → ambiguous/manual damage, halt" row is what
r2's design fell into. Here it is never entered, because the middle image is
distinguished by a field that is already in the schema and already committed
atomically with the data: `origin_kind`.

### 2.4 What the migration machine loses

Every "unless genesis" branch is deleted:

| Module | r2 carried | r3 |
|---|---|---|
| `control-codec.ts` | genesis phase/origin variants | none — `origin_kind` is a DB column |
| `admission.ts` | `admitGenesis` + a fourth condition set | deleted |
| `import-json.ts` | "genesis has no source" branches | deleted — it always has a source |
| `finalize.ts` | nullable source witness in `flipAuthority` | **deleted** — always a real witness (finding 6 resolved by removal) |
| `cleanup.ts` | "genesis has an empty vector, reaches M7 immediately" | deleted — the case finding 5 showed does not fit the schema |
| `authority.ts` | a second entry `runGenesis` | one classified dispatcher routes to either operation |
| `schema/application.ts` | `installGenesisCompletion` | **deleted** (finding 10) — the existing installer already writes the row |

### 2.5 The one amendment to 163 this requires — stated, not assumed

163's M0 authority matrix has two rows in tension at exactly the genesis window:

```
| absent | absent  | absent | Genesis is allowed … and uses staged DB + Q; otherwise halt. |
| absent | any DB  | any    | Ambiguous/manual damage; halt. DB presence never elects authority. |
```

The first authorizes genesis; the second halts on the only intermediate state
genesis can possibly produce. 163 never resolves it, which is why every round has
drawn a CRITICAL here.

**Proposed amendment — one row, no new mechanism:**

> | absent | complete DB whose `migration_completion.origin_kind = 'genesis'` | absent | Genesis finish-ahead. Derive `Q` from the DB's `authority_id`, re-verify the legacy path absent, and publish `Q`. No other action. |

The existing "ambiguous/manual damage" row is otherwise **unchanged** and still
catches everything real: a DB with `origin_kind='migration'` and absent `L` and
absent `Q` is a migration whose `Q` vanished — genuine damage, still a halt. An
incomplete DB is not authority and is handled by §2.3's first image. A foreign or
wrong-application DB still halts. "DB presence never elects authority" survives
intact: presence still elects nothing; a *complete genesis-origin completion
record* elects one specific finishing action.

This is the only place r3 amends the normative document, and it needs
ratification before implementation. If the reviewer rejects it, the fallback is
worse but available: genesis builds at a staged path and accepts that a crash
between its two renames is an unrecoverable halt requiring `.rbox` removal — on a
workspace that by definition holds no user state, so the cost is one re-adopt.

### 2.6 Genesis is still the first fleet checkpoint

163:4488 names the genesis path as the first falsifiable signal — a 2.0 dev build
taking a throwaway workspace through `absent/absent/absent`, before migration is
enabled on any real workspace, and the first go/no-go the founder can personally
observe. That is unchanged and it now arrives **earlier**: genesis depends only
on merged U1/U2 seams, so it ships in Wave 1 instead of after the flip.

---

## 3. Exclusivity

### 3.1 The lock bundle and its scope (N1 answer adopted)

The repository fence is **callback-scoped** (`withRepositoryRecoveryFence(requests,
stateIdentity, fn, options)`), not a holdable handle, so `HeldMigrationLocks` may
not carry one. The bundle is constructed *inside* a scoped wrapper and proves
what is currently held:

```ts
export interface HeldMigrationLocks {
  readonly mutex: WorkspaceSyncMutex;        // healthy, live-owned
  readonly stateLock: OwnedLock;             // held for this exact root
  readonly underRepositoryFence: true;       // witness, not a handle
}

/** The one wrapper both entry sites use. Mirrors the shape
 * `reset-journal-doctor.ts` already uses for the same job. */
export async function withMigrationLocks<T>(root: string, fn: (locks: HeldMigrationLocks) => Promise<T>): Promise<T>;
```

Order inside it, adopted verbatim from the ruling:

```
stop (upgrade only)
  → healthy workspace mutex (assertHealthyOwnedSyncMutex, not assertSyncMutex)
  → read-only repository / reset-journal inventory
  → withRepositoryRecoveryFence(requests, stateIdentity, …)
  → state lock
  → under-fence identity/request recheck (two-pass: restart on change)
  → standing reset recovery to completion
  → classify → drive
  → release
  → unconditional restart (upgrade only)
```

The request derivation includes both current repository records and any standing
reset transaction. Refusing repo-bearing workspaces at the upgrade entry was
rejected: it creates divergent entry semantics and excludes typical workspaces.

Standing reset recovery **precedes classification** (163:3127); quarantine
enumeration alone is not sufficient, or the classifier observes a mid-reset
artifact set.

### 3.2 Two entry sites, one doctor authorization

```ts
export type MigrationEntryPoint = "upgrade-stop-window" | "foreground-migrate";
export interface MigrationEntryProof { readonly entry: MigrationEntryPoint; readonly locks: HeldMigrationLocks }
```

Both call `runStateAuthorityTransition`, which classifies and routes to migration
or genesis. Doctor authorizes a retry by calling `retryHaltedMigration(root,
locks)` with the same bundle — one authorization site, no forgeable proof type.

**Entry A — `rbox upgrade`'s stop window, with a `finally`-level guarantee.**
`restartDaemonsAfterUpgrade` today runs `stop` and `resumeDesiredDaemon` in one
`try` with `continue` inside it (`upgrade-cmd.ts:143–158`); inserting a
transition between them as-is can strand a still-valid JSON workspace.

```
try {
  await stop(root);
  if (desired.state === "stopped") return;
  try { await withMigrationLocks(root, locks => runStateAuthorityTransition(root, {entry, locks}, onProgress)); }
  catch (error) { recordWorkspaceOutcome(error); }     // never rethrows past here
} finally {
  await restartDesiredDaemonIfAny(row.desired);        // unconditional, every outcome
}
```

A post-`Q` `durability-indeterminate` halt also restarts the daemon; the A-2
write fence, not a missing daemon, is what stops writes.

**Entry B — foreground `rbox migrate`.** Refuses inside a daemon process, same
bundle, same dispatcher, progress rendering, and a `--json` twin the rig drives.

### 3.3 Proving the window

M0 admits only when **both** hold: the caller presents a `MigrationEntryProof`
whose mutex is healthy and live-owned and whose state lock is owned for this exact
root; **and** M0 independently confirms no daemon is live for this workspace from
existing pid-record/ownership evidence. Otherwise `migration-not-exclusive`,
publishing no control and creating no artifact.

An actor starting after M0's check blocks on the locks the migration holds until
M7. The lock-ignoring pre-`1.11.0` actor is the drained population of the B0 gate,
with the barrier, the witness, M6's last-instant re-verify, and F2–F6 as backstop.

Locks are held continuously M0 → M7.

---

## 4. The whole-state adapter

```
                     .rbox/state.json
                            │
                  classifyStateFormat()
        ┌───────── json ────┴──── Q (58 bytes) ─────────┐
        ▼                                               ▼
adapters/legacy-json-store.ts                 store-facade.ts (SQLite)
  loadRawState / loadState                      openReadSnapshot
  applyStateSavePacket (JSON CAS)               adapters/sqlite-state-save.ts
        └──────────────► adapters/whole-state-compat.ts ◄──────┘
              sole selector · stream refusal · CasResult translation
              · write fence: readCanonicalControl + blocksSqliteWrites
```

Writes go native (O(dirty rows); the per-cycle full-serialize disappears here,
not in U4). Reads stay whole (every caller signature preserved; the
materialization peak stays until U4). A structural test pins
`classifyStateFormat`'s production callers to `whole-state-compat.ts` plus the B0
barrier sites and `genesis.ts` step 4.

---

## 5. The M0–M7 phase machine

`control.phase` is the **highest durably completed phase**. No phase is
pre-published.

### 5.1 Three outcome kinds

| Kind | Publishes | Suspends | Cleared by | Members |
|---|---|---|---|---|
| **Refusal** | Nothing; `.rbox` byte-identical | No | Nothing | `degraded-fence`, `quarantine-pending`, `barrier-witness-missing`, `migration-not-exclusive`, `reserve-foreign` |
| **Disposition** | Arms C1 (a control revision, durable reason always the literal `"source-changed"`) | No | Terminal retirement prefix | `source-changed`, `legacy-write-detected` |
| **Halt** | Same-phase revision with exact `halt` + `haltResources` | Yes | `--retry-state-migration`, four buckets (§1.1 M-9) | `filesystem-full`, `verification`, `reserved-path`, `durability-indeterminate`, `cleanup-deferred`, `source-oversize`, `memory-admission`, `record-oversize`, `disk-preflight`, `source-changed` **only as a retirement-cursor halt** |

### 5.2 Phase table

| Phase | Precondition | Work | Durable publication point | Crash-resume row | Reachable halts |
|---|---|---|---|---|---|
| — | control absent, exact `L`, no reserved active DB | — | — | Rerun read-only M0 after fresh identity/hash. An inert revision-scoped M0 temp is never adopted. Special/unreadable temp halts | `reserved-path` |
| **M0** | The five admission conditions | Bounded-read `L` first; identity-bracket + hash; random ids; exact staging path | Publish M0 after fresh identity/hash. Failure → in-process halt only | Row `M0`: reserve/emergency absent or exact id-scoped partial/complete; validate/create, rerun admission, publish M1 | `source-oversize`, `memory-admission`, `reserved-path` |
| **M1** | Exact M0; **source + control revalidated** | 52×, 512 MiB cap, RSS/cgroup, advisory `statfs`; claim/create the reserve; create + fsync the emergency candidate | Only after **both** identities and parents are durable | Row `M1`: backup absent, exact temp, exact current, or valid prior. Resume M2 idempotently. Foreign/special backup halts | `source-oversize`, `memory-admission`, `disk-preflight`, `filesystem-full` |
| **M2** | Exact M1; **revalidated** | Preamble-prefixed streaming copy to `legacy-json/<body-sha>.json`; publish/reuse the fixed `.bak`, preserving a differing prior under its own body hash first | Only after both exact backup witnesses and parents are durable | Row `M2`, **both branches**: (a) `stagingMain: "absent"` — no file or the sole create-ahead shape may begin/finish the M3 identity publication; (b) **a recorded exact identity — an incomplete id-owned main and only its own sidecars may be recovered/removed and rebuilt**. Sidecar-without-main halts. An exact committed completion is the sole M3-artifact-ahead form | `filesystem-full`, `reserved-path` |
| **M3** | Exact M2; **revalidated before each of the three seams** | `claimStagingMain` (absent / create-ahead-adopt / incomplete-rebuild) → **M-9 CAS-publishes the same-phase M2 revision recording that identity** → `importOwnedStaging` via `adoptClaimedStateStore`, one transaction, `migration_completion` last | Only after the committed completion tuple is reread and exact. WAL sidecars allowed until M4 | Row `M3`: exact committed id-bound staging; its own WAL/SHM may exist. Open only as migration owner, recover, rerun all M4 work | `record-oversize`, `memory-admission`, `filesystem-full`, `verification` |
| **M4** | Exact M3; **revalidated** | Recover WAL, `wal_checkpoint(TRUNCATE)`, close, `S0`; reopen read-only, recompute the SQL digest/counts, validate ids, `foreign_key_check`, `integrity_check`; close, `S0` again; fsync; physical-hash bracketed | Publish M4 with the complete proof | Row `M4`: staging-only, or the M5 rename ran ahead (active-only or both-exact). Revalidate identical hashes/completion, never move active backward, remove only a redundant exact staging name | `verification`, `filesystem-full`, `durability-indeterminate` |
| **M5** | Exact M4 hash; **revalidated** | Rename staging → `state.db`; remove only a redundant exact staging name; require staging absent and active `S0`; fsync `.rbox/state` | Publish M5 with the Q-sibling path + 58-byte hash **prebound**, disposition `absent`. **JSON remains authority** | Row `M5 + exact L`: sibling absent (+ the sole zero-byte create-ahead), recorded `building` at zero/partial/exact bytes, or recorded exact. Resume only the matching step | `filesystem-full`, `reserved-path`, `durability-indeterminate` |
| **M6** | Exact M5; exact sibling; **revalidated** | Ladder via same-phase CAS; revalidate live JSON + `.bak` + M5 completion/hash; **then, as the last operation before the rename with nothing between, re-verify the live body sha against the M3 source digest under the held `stateLockPath`**; rename; fsync `.rbox` | Publish M6 with sibling absent + the initial cleanup cursor. **Observing `Q` elects SQLite even if publication was interrupted** | Row `M5 + exact Q` (sole M6-artifact-ahead form): SQLite elected; never rename back. Complete/retry the `.rbox` fsync, publish M6. **`blocksSqliteWrites` is TRUE for this row** (finding 3) | `filesystem-full`, `reserved-path`, `durability-indeterminate` |
| **M7** | Exact M6; complete nonfinal prefix; final item absent; prepared runway | **Publish M7 first** from the prepared `r+2` sibling, converting resources to `retired`; **then** unlink the unused `r+1` sibling if exact-terminal and fsync; **then** unlink the control and fsync | M7 is the durable record of the final cleanup-absent prefix | Row `M7`: recorded `r+1` sibling exact-terminal or delete-ahead absent. Remove if needed, then unlink control and fsync. **Retry bucket 3** covers a halt here | `cleanup-deferred`, `durability-indeterminate` |

### 5.3 The rows that are not phases

| Row | Only action | Authority |
|---|---|---|
| ordinary M0–M5 + changed exact `L` | Publish the initial C1 retirement revision **before any artifact mutation**. Nothing else | JSON |
| `source-change-retirement` from M0–M5 | Resume the one current intent target, or at complete prefix retire the control | JSON |
| halted `source-change-retirement` | Cleanup suspended at the exact cursor; doctor clears only that halt (bucket 2) | JSON |
| exact halted M0–M7 | Four buckets (§1.1 M-9); the halt excuses no artifact mismatch | JSON before `Q`, SQLite after |
| terminal absent control + exact `Q` | Ordinary SQLite startup. `rbox migrate` here is `already-established`, exit 0, zero mutation | SQLite |
| foreign/malformed/inconsistent control or artifacts | No inference, cleanup, DB open, sentinel write, or backup restoration. Zero-write corruption halt | Existing `L`/`Q` predicate only |
| exact `Q` + absent/incomplete/foreign/wrong-id DB | Hard `StateAuthorityCorruptError`, zero repair. Not a halt, not retryable | Contradictory |
| **absent `L` + complete `origin_kind='genesis'` DB + absent control** | §2.5 amendment: derive and publish `Q`. No other action | None yet |

### 5.4 Global rules

- An unhalted control admits only its required artifact or the explicitly printed
  **one-next-phase artifact-ahead** state. Everything else halts with **zero
  writes** and is never repaired forward.
- `SIGKILL`, power loss, and unobserved crashes **never manufacture a halt**.
- A halt never advances phase, retirement prefix, or cleanup prefix, and never
  consumes a vector item as runway.
- **A failed halt publication is the final mutation of the trace** (finding 8),
  by type and by fault test.
- Before `Q`, a durable halt suspends migration but not JSON authority. After
  `Q`, only `durability-indeterminate` (write-blocking) and `cleanup-deferred`
  (writable) are expressible; neither can re-elect JSON.
- The `b..b+4` runway is the named scoped exception to f6: a caught ENOSPC there
  publishes no alternate control, reports nondurable, and stops. Deliberate.

---

## 6. Halts, refusals, dispositions: copy and the twin

Copy is written for a non-technical user; the merged
`satisfies Record<MigrationHaltCode, …>` is the gate.

### 6.1 Refusals

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `degraded-fence` | "This workspace's folder can't be safely locked on this disk, so rbox won't move its state here." | "Nothing changed. Your files and your sync are unaffected." | `rbox doctor` | `state-migration/degraded-fence` · warn |
| `quarantine-pending` | "There's a paused state repair to finish first." | "Nothing changed. Your data is intact." | `rbox doctor` | `state-migration/quarantine-pending` · warn |
| `barrier-witness-missing` | "This workspace was last written by an older rbox. It needs one ordinary sync with this version first." | "Nothing changed." | `rbox sync` | `state-migration/barrier-witness-missing` · info |
| `migration-not-exclusive` | "rbox only moves state while nothing else is using this workspace." | "Nothing changed." | `rbox stop`, then `rbox migrate` | `state-migration/not-exclusive` · warn |
| `reserve-foreign` | "A file rbox keeps as a safety reserve doesn't look like rbox wrote it, so rbox left it alone." | "Nothing was deleted, claimed, or changed." | `rbox doctor` (names the path) | `state-migration/reserve-foreign` · warn |
| `legacy-present` (genesis) | "This workspace got its sync records back while rbox was setting up, so rbox stopped and kept them." | "Nothing was replaced." | `rbox migrate` | `state-genesis/legacy-present` · warn |

### 6.2 Dispositions

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `source-changed` | "The workspace's state changed while rbox was converting it, so rbox is throwing the partial work away." | "Your current state is untouched and still in use." | `rbox migrate` (after cleanup finishes) | `state-migration/source-changed` · info |
| `legacy-write-detected` | "An older rbox wrote to this workspace during the conversion, so rbox stopped before switching over." | "Your current state is untouched and still in use." | Upgrade every machine to 1.11.0+, then `rbox migrate` | `state-migration/legacy-write-detected` · error |

### 6.3 Halts

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `source-oversize` | "This workspace's state file is larger than rbox can convert (names the measured size)." | "Nothing changed; the workspace keeps working on the old format." | Run once on a machine with more memory, or re-adopt | `state-migration/source-oversize` · error |
| `memory-admission` | "Converting this workspace needs more memory than this machine can spare (names size and required headroom)." | "Nothing changed." | Same two remedies; `RBOX_RESET_PARSE_BUDGET_BYTES` printed with its exact value | `state-migration/memory-admission` · error |
| `record-oversize` | "One entry in this workspace's state is too large to convert." | "Nothing changed." | `rbox doctor` | `state-migration/record-oversize` · error |
| `disk-preflight` | "There isn't enough free disk space to convert safely (names required vs available)." | "Nothing changed." | Free space, then `rbox migrate` | `state-migration/disk-preflight` · error |
| `filesystem-full` | "The disk filled up partway through. rbox stopped instead of leaving a half-converted workspace." | "Your old state is still the one in use and is intact." | Free space, then `rbox doctor --retry-state-migration` | `state-migration/filesystem-full` · error |
| `source-changed` (retirement cursor) | "Cleaning up after an interrupted conversion didn't finish." | "Your current state is untouched and still in use." | `rbox doctor --retry-state-migration` | `state-migration/retirement-source-changed` · warn |
| `verification` | "The converted state didn't match the original exactly, so rbox refused to switch to it." | "Your original state is untouched and still in use. A copy of it is saved." | `rbox doctor` (prints the backup path) | `state-migration/verification` · error |
| `reserved-path` | "rbox found an unexpected file where it keeps its state and won't touch it." | "Nothing was deleted. Your state is unaffected." | `rbox doctor` (names the path) | `state-migration/reserved-path` · error |
| `durability-indeterminate` | "rbox can't confirm the last write reached the disk, so it has paused writing to this workspace." | "No data was lost; rbox is being cautious." | `rbox doctor --retry-state-migration` | `state-migration/durability-indeterminate` · error |
| `cleanup-deferred` | "The conversion finished; tidying up one leftover file didn't." | "Your workspace is fully working on the new format and syncing normally." | `rbox doctor --retry-state-migration` | `state-migration/cleanup-deferred` · warn |

### 6.4 Not halts, never offered a retry

`StateAuthorityCorruptError` — "This workspace says it uses the new format, but
its state database is missing or doesn't match." / "rbox has changed nothing and
will not try to repair this automatically." / the printed re-adoption procedure.
`legacy-overwrite-after-Q` (F3's documented outcome) — names the hash-addressed
backup; remedy is re-adoption.

Never advise deleting `Q`. Never advise restoring a backup. Every `command` is
real and non-interactively twinned. The `migrating` state renders in plain English
past 5 s per phase, with the `--json` twin emitting structured phase progress.

---

## 7. Exit gates

### 7.1 F1–F6

| Fixture | Construction | Assertion | Negative control |
|---|---|---|---|
| **F1** | Degraded-unlocked workspace + live legacy writer | M0 refuses `degraded-fence`; no control, no artifact | Fence removed → M0 proceeds |
| **F2** | `forceLegacy` writer on a lockable fs, suspended after its state read; full M0–M7; writer resumes | Fails closed with `StateFormatTooNewError`; `Q` byte-identical | Barrier + lock-entry restriction removed → **demonstrably destroys `Q`** |
| **F3** | F2's shape, writer is the published signed 1.10.x artifact, released strictly after M6's rename | Documented outcome: `Q` destroyed; doctor reports `legacy-overwrite-after-Q` naming the backup | — |
| **F4** | Two concurrent degraded writers | The refusal, not last-writer-wins | — |
| **F5** | Signed 1.10.x, `forceLegacy`, rename inside M6's `check → rename` microwindow — driven by the `onStep` `"before-rename"` seam (`fsutil.ts:46`), **not by sleeping** | After M7: `state.json` is `Q`; DB and both backups carry the older digest; the writer's document absent from every artifact; doctor emits **no anomaly** | Companion: released one window earlier → M6 refuses `legacy-write-detected`, no rename, JSON authoritative |
| **F6** | F5 extended through the post-flip pull against remote `B1` after reverting to `B0` | Documented silent overwrite: ordinary `write`, no conflict copy, no anomaly | — |

F5/F6 assert **silence**; one comment line each says so.

**G1–G3 (genesis), new in r3.** G1: full genesis on a throwaway workspace →
`Q` + matching DB + no control + no migration artifact of any kind (asserted by
namespace inventory). G2: SIGKILL after the store commits, before the rename →
restart re-derives `Q` from `authority_id` and finishes; the resulting `Q` is
byte-identical to the uninterrupted run. G3: an `L` published between admission
and step 4 → refuse `legacy-present`, rename nothing, `L` byte-identical.

### 7.2 Crash/disk-full/resume coverage

Every row of §5.2, §5.3, and §2.3 is a test. 163:3267's full injection list,
plus the items r1/r2 omitted:

- **M2's recorded-identity branch** and **M3's three claim observations**
  (absent / create-ahead adopt / incomplete rebuild), each with every owned
  sidecar subset; sidecar-without-main halts.
- **M3's interstitial CAS**: kill before, during, and after the same-phase M2
  publication; assert a claimed-but-unpublished file is never opened by SQLite.
- **M7's normative order**: publish → sibling → control. A test asserts the
  control can never be retired before M7 is published, and that **no prepared
  sibling survives terminal control unlink**.
- **Final-runway faults after `b+4`**: item present/absent at ready M6; direct-M7
  promotion; caught-failure promotion to the prepared halt; kill and power cut at
  **both** promotions and both parent fsyncs; promoted-halt retry with the item
  present and absent; repeated failure before retry promotion; immutable M7
  validation on both terminal observations. **No retry creates a new pair.**
- **Role 7's byte-exact 128-byte reserve-header reread** immediately before the
  unlink; mismatch is a zero-write corruption halt.
- **Failed halt publication is the trace's final mutation** (finding 8): inject a
  publication failure at each halt site and assert no subsequent write.
- **The A-2 write fence**: a restarted process against the `M5 + Q` row is
  refused with `migration-recovery-pending`; against `cleanup-deferred` it writes.

Reuse U2's `crash-rig-child.ts` / `crash-rig-model.ts` / `trace-fs.ts`; migration
and genesis are two more scenario sets on the same harness.

### 7.3 Abort — phase-specific differential

Pre-`Q`: `rbox doctor --abort-state-migration` runs C1 to completion, unlinks the
control last, leaves exact `L` authoritative. Post-`Q`: no in-place downgrade;
doctor prints re-adoption.

| Abort from | Expected residue beyond the pre-migration tree |
|---|---|
| **M0** (before the M1 claim) | No backup history, no fixed `.bak`. **The B0 reserve survives** — unclaimed |
| **M1** | The reserve is claimed, is a vector item, and is **retired (absent)**; so is the emergency candidate |
| **M2–M5** | As M1, **plus** the immutable `legacy-json/<body-sha>.json` entry and the fixed `pre-163-latest.json.bak`, both preamble-prefixed, both never deleted on failure |

### 7.4 Import fidelity

`legacyStateSemanticDigest(normalizeLegacyStateV1(source))` equals
`stateSemanticDigest(staging)` on corpus-112k and every differential fixture;
canonical reconstructed manifest hash independently checked when meta is present;
min/max `RepoRecord` codec admission; `resolutionIntent` strip-before-digest; the
DDL-column ↔ `keyof RepoRecord` bijection minus the one named strip member;
exact-512-MiB admitted, >512 MiB refused; **the source-shape presence bits round
trip for both `origin_kind` values through the one shared builder**.

### 7.5 No-regression gate

100 samples after 10 warmups, void-on-untrusted, measured **pre-flip and post-flip
on the same host, same build, same corpus**. RSS is a **workload-paired
interval**: a fixed scripted workload (3 full sync cycles over corpus-112k after
one warm cycle), RSS at 1 Hz for the whole run, gate
`post_p95 <= pre_p95 * 1.05`. Falsifiable without the frozen machine profile,
which stays a U5 blocker. Reference absolutes for context only: `status` p50
≤ 200 ms, p95 ≤ 400 ms, daemon RSS ≤ 1.5 GB — a regression inside them still
blocks. **Migration duration: M0–M7 ≤ 60 s on corpus-112k**; any phase over 5 s
prints progress.

### 7.6 Dual-binary differential rig

Per-device staging and mounting exist. Remaining: (1) a scenario assertion that
the two devices report **different `rbox --version` strings**; (2) fetching the
**published signed `1.11.0` artifact** from `rbox-releases` and verifying digest
and detached signature, digest pinned in the scenario. Never a local build.

Scenario: one workspace, one candidate host and one 1.11.0 host, pull/push
interleaved with an ignore-rule change, a tracked-repo change, and a
mass-delete-shaped change. No spurious delete, lost deferral, or divergent
manifest. Plus the same-corpus manifest diff. The flip is **not exempt**.

### 7.7 First fleet checkpoint

Genesis on a throwaway workspace, 2.0 dev build, throwaway accounts (§2.6).
Now reachable from Wave 1.

### 7.8 The B0 enablement gate — all five conditions

Before U3 may be **enabled**: (1) `1.11.0` on the **stable channel**; (2) adopted
by **all 4 external users and all 3 fleet hosts** per the `rbox-admin` version
view; (3) **baked ≥ 2 weeks** with **zero barrier-related incidents**; (4)
**F1–F6 pass** including both negative controls and F5's companion; (5) the
pre-`1.11.0` population **demonstrably drained**. Known population as of
2026-07-28: one external user on 1.6, two on 1.9.x, founder fleet on dev builds.
Conditions 1–3 and 5 must be dated and re-checked before the 2.0 tag.

### 7.9 Structural / inventory gates

- `loadState()` production call sites counted; may only decrease; zero by U4f.
- `authority.ts` imports no `node:fs`, `node:crypto`, `bun:sqlite`.
- `classifier.ts` performs no writes (import graph + `.rbox` snapshots).
- Exactly two entry call sites of `runStateAuthorityTransition`, plus one doctor
  authorization site.
- The canonical control file is written only by `control-publication.ts`,
  including both prepared-sibling promotions, which share one private primitive.
- `genesis.ts` never imports from `migration/`, and no `migration/` module
  imports `genesis.ts`.
- No production `StateSavePacket` carries `authority.kind === "migration"`;
  migration authority originates only in `import-json.ts`.
- `legacy-writer-live` and paired-interval sampling appear nowhere in `src/`.
- Every file ≤400 lines / 25 KiB; 301–399 carries a review note.
- `docs/CODEMAP.md` gains one ownership line per new module in the same change.

---

## 8. Sequencing and dispatch

**Gate 0.** All four Tier 0 gates closed (**T0.1 / PR #574 still OPEN**). B0
conditions 1–3 and 5 on track. `2.0` opened from `main`. No wave starts before
this.

**One integration owner:** the 5A agent owns `docs/CODEMAP.md` and the inventory
tests; other lanes propose their one-line entries in the PR body.

### Wave 1 — the control record, the store seams, genesis (3 lanes)

| Lane | Deliverable | Routing |
|---|---|---|
| **1A** | M-1 + M-2 (one lane — M-2 depends on M-1's exact canonical schema). Codec, `C1Trigger`, `blocksSqliteWrites`, the shared `replaceCanonicalControl` primitive, `promotePreparedControl` with its pre-rename revalidation, `publishMigrationHalt`'s discriminated result, `readCanonicalControl`, **all migration + genesis path constructors into `paths.ts`**, **`StateAuthorityCorruptError` and the `migration-recovery-pending` refusal reason into `errors.ts`** (so Waves 2A and 2C do not depend on each other), and the initial `MigrationHaltCode` union + `MIGRATION_HALT_COPY` entries | **opus** |
| **1B** | **Genesis** — `state-plane/genesis.ts`, the §2.5 amendment applied to the classifier's row set, the genesis sibling as a named namespace member, G1–G3. Depends only on merged U1/U2 seams. **This is the first fleet checkpoint and it ships first** | **opus** |
| **1C** | `store/open.ts::adoptClaimedStateStore` (finding 1's scheduled change) + A-1 `adapters/sqlite-state-save.ts` + write-path differential tests | codex |

### Wave 2 — observation, admission, compat (3 lanes)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **2A** | M-3 `classifier.ts` + `PhaseReceipt` + table-driven row tests + zero-write snapshots | 1A, 1B | **opus** |
| **2B** | M-4 `admission.ts` + the five conditions + `withMigrationLocks` + standing-reset-recovery ordering + F1 + F4 | 1A | **opus** |
| **2C** | A-2 `whole-state-compat.ts` + `CasResult` translation + the write fence + call-site counter | 1A, 1C | **opus** |

### Wave 3 — the phase bodies (3 lanes; all consume `PhaseReceipt`)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **3A** | M-5 (M2 / three-seam M3 / M4) + `normalizeLegacyStateV1` + `legacyStateSemanticDigest` + the shared shape-flag builder + fidelity gate | 1A, 1C, 2A, **T0.1** | codex |
| **3B** | M-7 `retirement.ts` + cursor tests (consumes `C1Trigger` from 1A, **not** from Wave 4) | 1A, 2A | **opus** |
| **3C** | M-8 `cleanup.ts` (cursor + ledger + `retryPromotedHalt` + M7 in normative order) + runway fault injection | 1A, 2A | **opus** |

### Wave 4 — the flip (serial, alone)

**4A** — M-6 `finalize.ts`: M5, the Q ladder, `flipAuthority` (always a real
witness). **Unit and crash-rig coverage only**; F2/F3/F5/F6 land in Wave 5.
Depends on 1A, 2A, 2B, 3A, 3B, 3C. **opus, alone.**

### Wave 5 — assembly, ordered (serial)

| Step | Deliverable | Routing |
|---|---|---|
| **5A** | M-9 `authority.ts` — the driver with per-mutator revalidation, the four retry buckets, `runStateAuthorityTransition`'s classified dispatch, both entry sites (upgrade with the `finally` guarantee, `rbox migrate` + `--json`), progress UX. Integration owner | **opus** |
| **5B** | Doctor: the four retry buckets wired, `--abort-state-migration`, the standing-halt projection modeled on `reset-health.ts`, final copy pass | **opus** |
| **5C** | Integrated gates: F2/F3/F5/F6, the abort differential, the no-regression harness, duration budget, rig scenario. Harness *preparation* may run in parallel from Wave 3; the fixtures cannot | codex (harness) + **opus** (fixtures) |

### Wave 6 — validation, serial

Full crash-rig sweep → `/simplify` diff-scoped → parallel review fan-out → **one
final serial review** → merge to `2.0` → dual-binary differential against signed
1.11.0 → §7.8 re-checked → tag.

---

## 9. Risks

1. **The classifier / control-schema / M6 cleanup-runway cross-product.** Top
   correctness risk. Sharpest edges: prepared-control promotion and the
   promoted-halt retry whose clear is a rename. Mitigation: 1A and 2A at the same
   quality tier as the flip; 3C not dispatched until 2A's row set is stable.
2. **Per-mutator revalidation (finding 2).** The property is easy to state and
   easy to lose in one refactor. It is enforced by the branded `PhaseReceipt`,
   not by discipline.
3. **The M3 three-seam ordering and `adoptClaimedStateStore`.** A real change to a
   merged, load-bearing initializer. Mitigated by one private shared body and by
   crash coverage at all three seams.
4. **`whole-state-compat.ts` — top performance/compatibility risk, not top safety
   risk.** Whole-state materialization plus a SQLite page cache. If §7.5 fails:
   tune the cache, pull U4's cursor conversion forward for `status` only, or **do
   not ship the flip** — the third stays on the table per the revert rule.
5. **The §2.5 amendment.** It is the only normative change r3 proposes. If it is
   rejected, genesis degrades to "a crash between its two durable steps requires
   re-adopting a workspace that holds no user data" — recoverable, but worse UX
   at exactly the first fleet checkpoint.
6. **F5/F6 assertion maintenance.** Not a leading implementation risk; the
   deterministic seam exists. One comment line each.
7. **~3,400 production lines** (2,620 migration + 180 genesis + 600 adapters) of
   one-way, unrevertible-after-`Q` fail-closed surface. Mitigated by the dispatch
   plan and the one serial review.

---

## 10. Disposition of the r2 review

| # | Finding | Disposition |
|---|---|---|
| 1 | Split M3 cannot use the named initializer | **Folded.** `initializeStateStore` opens `"wx"` — verified at `open.ts:218`. U3 adds `adoptClaimedStateStore(file, install)` sharing one private body (scheduled in Wave 1C). `claimStagingMain` now names all three admitted observations including create-ahead adoption and incomplete rebuild; `importOwnedStaging` takes the branded `PublishedStagingClaim`, so the interstitial CAS cannot be skipped, and the completion-ahead branch is explicit |
| 2 | Changed-`L` fold omits the observation cadence | **Folded.** M-9's driver revalidates source identity/hash and the exact control revision **before every M1–M6 mutator**, including all three M3 seams, minting a fresh `PhaseReceipt` each time. A stale receipt cannot reach a mutator |
| 3 | The A-2 fence allows writes through `M5 + Q` | **Folded.** `blocksSqliteWrites` is now true for a durable `durability-indeterminate` halt **and any pre-M6 control on the SQLite branch**. `cleanup-deferred` stays writable. `StateAuthorityCorruptError`'s scope confirmed as codex states it: `Q` + matching complete DB with M5 control is the artifact-ahead row, not corruption |
| 4 | Retry buckets not exhaustive | **Folded.** Four buckets: ordinary M0–M5 resource recreation; exact-cursor continuation for C1/M6 **including terminal-prefix work**; ordinary halted M7 → CAS-clear then `finishMigration`; the sole specialized `promotedHalt` promotion-as-clear. The switch is exhaustive over the halted rows or it does not compile |
| 5 | Genesis has no durable crash/resume machine | **Restructured, not patched.** Genesis leaves the M0–M7 machine entirely (§2). Crash safety comes from the DB's own committed `origin_kind='genesis'` + `authority_id`, not a control record: three observable images, all nothing-or-resumable, and the ambiguous state is **unreachable rather than classified**. The control-schema mismatch codex names (`not-created` legal only at M0, `retired` requiring M7) disappears with genesis itself |
| 6 | Genesis `null` witness cannot mean "skip verification" | **Requirement kept, mechanism deleted.** `flipAuthority` is migration-only and always has a real witness; the nullable branch is gone. Genesis carries the requirement as step 4 of its own operation: re-verify the legacy path is still absent as the immediately preceding operation to its rename, under the held state lock, refusing `legacy-present` otherwise |
| 7 | Prepared promotion not yet *exact* | **Folded.** `promotePreparedControl` no-follow revalidates the recorded inode, byte length, SHA-256, and canonical bytes for its fixed kind/revision immediately before the rename. Both entry points delegate to one private `replaceCanonicalControl` |
| 8 | "No more writes" not real | **Folded.** `HaltPublication` is discriminated; the nondurable branch carries **no control**, so there is nothing to continue from by type. M-9 returns immediately. Fault test asserts a failed halt publication is the trace's final mutation |
| 9 | `legacy-write-detected` has no exact durable encoding | **Folded.** `C1Trigger` (in `control-codec.ts`, so Wave 3 does not depend on Wave 4) carries both outward dispositions; `durableRetirementReason` is total and returns the literal `"source-changed"`, so a second durable reason cannot be introduced |
| 10 | Delete `installGenesisCompletion` | **Adopted.** Verified: `installGenesisLineage` already inserts the `migration_completion` singleton with `origin_kind='genesis'` last in its transaction (`application.ts:67`). The sibling installer is deleted. Its second half — completing the source-shape presence bits with caller-supplied runtime values — is folded into the one shared builder in §1.1 M-5, used by both origin kinds |
| 11 | The A-2 sample does not typecheck | **Folded.** `errors.ts` gains `"migration-recovery-pending"` to `StateWriteRefusalReason` with its message, and the sample passes the required file path |
| Coupling — 2C↔2A | **Fixed.** `StateAuthorityCorruptError` lands in `errors.ts` in Wave 1A |
| Coupling — 3B↔4 | **Fixed.** `C1Trigger` lands in `control-codec.ts` in Wave 1A |
| Coupling — raw controls | **Fixed.** Every mutator takes a branded `PhaseReceipt` |
| Coupling — genesis unscheduled | **Fixed.** Wave 1B, and it now ships first |
| Coupling — M3 initializer unscheduled | **Fixed.** Wave 1C |
| Coupling — `RepositoryFence` invented | **Fixed.** `withMigrationLocks` is a scoped wrapper over the callback-scoped `withRepositoryRecoveryFence`; the bundle carries a witness, not a handle |
| Merge `runGenesis` | **Adopted with the ruling's shape.** One classified dispatcher `runStateAuthorityTransition` behind the two entry sites routes to the migration driver or the genesis operation. Two entry sites, one classification point, and genesis is still its own operation |
| N1 — repository fence | **Adopted verbatim** (§3.1), including the two-pass under-fence recheck and the rejection of refusing repo-bearing upgrade workspaces |
| N2 — genesis completion placement | **Adopted.** Stays in `schema/application.ts` inside the existing `installGenesisLineage`; no sibling installer; `import-json.ts` owns only source-derived completion |

### Where r3 asks for something back

**§2.5 is an amendment to 163, and it is the only one.** 163's authority matrix
authorizes genesis ("uses staged DB + `Q`") and then halts on the sole
intermediate state genesis can produce ("absent | any DB | any → ambiguous"). Both
rows are ratified; together they make genesis unimplementable, which is why every
round has drawn a CRITICAL at exactly this point. r3 proposes one added row keyed
on the already-committed `migration_completion.origin_kind = 'genesis'`, leaving
the ambiguous row and "DB presence never elects authority" otherwise intact. It
needs ratification. The fallback if rejected is stated in §2.5 and in risk 5.

**§0.2 stays.** `origin/main` is `1a78fa32` and PR #574 is OPEN; deleting the
unmerged-prerequisite section would assert a merge that has not happened. The
substance of the ruling — no wave starts until every Tier 0 gate closes — is
adopted in §8 Gate 0.
