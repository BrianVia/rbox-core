# 222 — U3 implementation design: the migration unit, the `Q` flip, and the whole-state adapter

> Status: **r6**. Folds one falsified premise. **A read-only SQLite open is not
> a zero-write operation** — on a WAL-mode database in a writable parent the
> first read, a bare `PRAGMA` included, creates `-wal`/`-shm` that a read-only
> close cannot remove. r5's §2.5.1 named that defect and then prescribed it.
> r6 replaces it with the **ownership rule** (163 v13): files this code does not
> own are never opened at all; files it owns may be opened and must then be
> checkpointed and closed. §M-3's zero-write requirement is **re-scoped, not
> deleted**, by whether the database is frozen — and §2.5.1's amendment plus
> §M-3's re-scoping are **one unit; neither is correct alone**. §10 records the
> superseding disposition.
>
> Prior status for the record: **r5**. Folds the codex review of r3 (NOT-ALIGNED, 3 CRITICAL + 2 HIGH)
> and the independent adversarial validation of §2.6
> (RATIFY-WITH-CORRECTIONS, 9 items). §10 records both dispositions.
>
> **Final review verdict: GO.** The safety argument is sound, the `dev`/`ino`
> conjunction closes the hazard, and the v12 fold is accurate and correctly
> scoped. Four doc-level corrections are folded in this revision (§10) — none
> touches 163 v12's ratified row text: the intent is the sole source of ids on
> resume; §2.5.1 evaluates through the read-only preflight **(false — superseded
> in r6)**, case 7 precedes case
> 5, and cases 6–7 raise `StateAuthorityCorruptError` rather than a new halt
> code; the write fence collapses to one coordinator-owned call; and two 163
> editorial qualifications around (not inside) the ratified rows.
>
> **§2.6 is RATIFIED** (founder, 2026-07-28) and is now normative in 163 as
> **v12** — two inserted M0 authority-matrix rows plus a § "R4-v12 genesis
> intent (v12)" decision record. §2.6 here is a pointer and rationale; 163 v12
> owns the rows.
>
> **Founder steer governing r5:** the copy-from-another-workspace attack
> scenarios are low-odds, and the validation agrees — copy is blocked, stale
> replay self-heals, races are locked out, and a same-user attacker is no worse
> than 163's conceded baseline. So the genesis mechanism is made
> **accident-proof, not attacker-proof**. Where a correction bought only
> attacker-resistance, the smaller record won; §2.3.3 answers the trim question
> explicitly and the intent lost two of its six fields.
>
> **What changed in r4.** r3's structural ruling — genesis is not a migration —
> was validated and stands. Its *protocol* was unsound and is replaced: genesis
> now has a tiny durable **genesis intent** (§2.2), builds at a staged path, and
> never leaves an incomplete DB at the active path. r3's proposed amendment,
> which keyed authority on `origin_kind='genesis'` inside the candidate DB, is
> **withdrawn** — codex proved it would let a genesis DB copied from another
> workspace cause `Q` publication. §2.6 is the replacement amendment, keyed on
> the intent, and is the text going to the founder for ratification.
>
> The migration/genesis module boundary is now **enforced**, not declared: no
> genesis rows in `migration/classifier.ts`, no genesis outcome in
> `migration/authority.ts`, and a thin coordinator outside both domains (§1.3).
>
> Normative source: `docs/design/163-state-plane-sqlite.md` (ratified v10 +
> `MIGRATION-EXCLUSIVITY-v11`). Where this document and 163 disagree, **163
> wins** — except §2.6, which proposes explicit rows for ratification and says
> exactly what does and does not change. Build blueprint: sweep-4 Tier 1.
>
> Founder's bar:
>
> > "keep our domains clean and tight and as small as possible. No stupid long
> > comments. Build simple code that works and is easy to understand. Don't try
> > to be cute. Genius has the fewest moving parts."
>
> A module owns **one cohesive protocol outcome**. Splitting is not free. Split
> only on measured evidence, never to manufacture parallelism.

## 0. Scope and foundation

U3 carries the **one-way authority change** from `.rbox/state.json` to
`.rbox/state/state.db`, and nothing else. The engine is byte-identical across
the flip.

U3 **is**: the nine-module M0–M7 migration machine (sweep-4 T1.3); the genesis
operation (§2); the coordinator (§1.3); the two deferred adapters; two entry
points plus one doctor-authorized retry; the halt/refusal/disposition taxonomy
with plain-English copy and a non-interactive twin; the exit gates.

U3 is **not**: ambient or on-boot migration; the paired-interval live-writer
sampling (v11 deletes it); a generic capability framework; any engine port.

U3 is the only unit that opens the `2.0` branch. This document does not open it.

### 0.1 Foundation — verified merged on `origin/main` (`e1cd0b26`)

**All four sweep-4 Tier 0 gates are CLOSED.** #574 (T0.1) merged
2026-07-29T00:19Z; `gh pr view 574` → `state: MERGED`. r3's unmerged-prerequisite
section and Gate 0's T0.1 blocker are deleted — they were true when written and
are not now.

| Merged | Provides |
|---|---|
| `migration/base-proof.ts`, `migration/import-stage.ts`, `store/transition-admission.ts::withMigrationImporter`, `sync-git/base-proof-selection.ts` (**#574**) | `beginMigrationImportStage` — the only way to create a `migration`-tagged transition stage. Ordinary engine writes name their own BASE authority |
| `state-plane/paths.ts` (#579) | `statePath`, `stateLockPath`, `stateIncarnationPath`, `sqliteResetPaths`. 25 lines — **U3 adds every migration and genesis path constructor here** |
| `adapters/legacy-json-store.ts` (#579) | `loadRawState`, `loadState`, `applyStateSavePacket`, `saveState`, `ensureTelemetryBindingId`, `installGenesisResetStateUnderHeldLock` |
| `store/owner-token.ts` (#579) | `casOwnerTokenFromLock(lock): OwnedLockCasToken` — sole production mint site |
| `store/open.ts::initializeStateStore(file, install)` (#577) | Claimed-file initializer. **Opens `"wx"` — requires the path ABSENT** (`open.ts:218`); its cleanup runs only on **caught** failures (`open.ts:236`), never on `SIGKILL` |
| `schema/application.ts` (#577) | `applySchemaV1`; `installGenesisLineage`, which already inserts the `migration_completion` singleton with `origin_kind='genesis'` last in its own transaction (`application.ts:67`) |
| `schema/validate-open.ts` | `validateOpen` — application id, schema version, DDL fingerprint, required objects, singleton/head coherence. **Establishes no provenance** (see §2.6) |
| `errors.ts` (#578) | `StateDataCorruptionError`, `decodeAuthorityRow`, `ProoflessBaseError`, `StateFormatTooNewError`, `StreamMismatchError`, `StateWriteRefusedError(reason, file, detail?)` |
| `doctor-state-plane.ts` + `migration/health.ts` (#576) | `MigrationHaltCode = never`, `MIGRATION_HALT_COPY = {} satisfies Record<…>` |
| `authority-marker.ts` (B0) | `AUTHORITY_MARKER_BYTES = 58`, `classifyStateFormat`, `assertStateReadable`, `assertStatePublishable` |
| `migration/reserve.ts`, `migration/last-writer-witness.ts` (B0) | 128-byte reserve header and its adopt-never-delete-a-foreign-path rule; `BARRIER_DOWNGRADE_FLOOR = "1.11.0"`, `verifyLastWriterWitness` |
| `reset/index.ts`, `reset-health.ts` (U2) | `sqliteResetFacade`; `ResetHaltHealthV1` / `readResetHaltHealth` — the standing-halt projection precedent |
| `store/*` (U1a/U1b) | `applyCasPacket`, `StageLock`, sealed stages, transition stages, `buildCasRetryView`, `read-snapshot` |
| `engine/git/protocol-locks.ts` | `withRepositoryRecoveryFence(requests, stateIdentity, fn, options)` — **callback-scoped, not a handle** |
| `scripts/rig/lib/binary.ts` | `resolveRigBinaryPaths`, `prepareRigBinarySelection` → per-device staged artifacts |

### 0.2 Seams earlier rounds claimed that do not exist

| Claimed | Reality | Fix |
|---|---|---|
| `stateSemanticDigest` serves both sides | `stateSemanticDigest(db: Database)` — SQL only | U3 builds the JSON side (§1.1 M-5) |
| `assertSyncMutex` proves the window | Shape check; `assertHealthyOwnedSyncMutex` (`:325`) verifies live ownership | §3.1 |
| A daemon `migration-halted` state exists | No `StateMigrationHaltError`, no pump, no catch, no `StateAuthorityCorruptError` | Deleted; halts project like `reset-health.ts` |
| `initializeStateStore` can adopt a claimed file | It opens `"wx"` and rejects an existing path | §1.1 M-5 |
| `RepositoryFence` is a holdable handle | Callback-scoped | §3.1 |
| `migration-write-blocked` is a `StateWriteRefusalReason` | It is not, and the error requires a file path | §1.2 A-2 |
| `origin_kind='genesis'` is provenance | It is a `CHECK`-constrained string the candidate asserts about itself (`v1.ts:29`) | §2.6 — **withdrawn and replaced** |

---

## 1. Module inventory

163:3994: production files **target ≤300 nonblank lines**, **301–399 permitted
with a review note**, **400 lines / 25 KiB is the hard CI failure**. Nine
migration modules, not twelve.

### 1.1 The nine migration modules (`src/cli/state-plane/migration/`)

| # | Module | The one protocol outcome it owns | Budget |
|---|---|---|---:|
| M-1 | `control-codec.ts` | The control record as a value: closed union, canonical bytes, pure predicates, the C1 trigger type | 300 |
| M-2 | `control-publication.ts` | Every durable transition of the canonical control file | 280 (352 shipped) |
| M-3 | `classifier.ts` | One admitted migration observation row, mutating nothing | 300 |
| M-4 | `admission.ts` | May a migration begin or continue right now | 260 |
| M-5 | `import-json.ts` | A **proven staging DB** derived from an admitted source | 340 |
| M-6 | `finalize.ts` | The prepared DB becomes authority — the one flip | 280 |
| M-7 | `retirement.ts` | C1: a superseded migration's artifacts are gone | 260 |
| M-8 | `cleanup.ts` + `cleanup-runway.ts` | Terminalization: cursor, runway, M7 (two files — see §M-8) | 360 (302 + 396 shipped) |
| M-9 | `authority.ts` | Migration sequencing over typed receipts. No filesystem primitives, **no genesis** | 240 |

M-3, M-5, M-8 sit in the 301–399 band; the review note is that each is one
correlated machine 163 specifies as a unit.

**Migration production budget: 2,620.** Genesis **393** (§2 — revised from the
estimated 240 when wave 1C shipped; see §2.1), coordinator 90 (§1.3),
adapters 600 (§1.2).

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

/** The C1 trigger. Both outward dispositions total-map to 163's single literal
 * durable reason (163:2711), so a second durable reason cannot be introduced.
 * It lives HERE, not in `finalize.ts`, so Wave 3 does not depend on Wave 4. */
export type C1Trigger =
  | { disposition: "source-changed"; replacement: SourceIdentity }
  | { disposition: "legacy-write-detected"; observedBodySha256: string };
export const durableRetirementReason = (_: C1Trigger): "source-changed" => "source-changed";

/** The post-`Q` MIGRATION write fence. TRUE for a durable
 * `durability-indeterminate` halt AND for any control whose phase is below M6
 * on the SQLite-selected branch — the `M5 + Q` row, where the rename landed but
 * M6's publication and parent fsync did not (163:3253). FALSE for
 * `cleanup-deferred`, which is explicitly writable. */
export function blocksSqliteWrites(control: MigrationControl): boolean;

export function isFinalIntentPromotedHalt(control: MigrationControl): boolean;
```

May not touch the filesystem, SQLite, the state document, or path computation.
**No genesis variants** — `origin_kind` is a DB column, not a control phase.

---

#### M-2 `control-publication.ts`

```ts
export interface PublishExpectation { migrationId: string | "absent"; revision: number | "absent" }

/** Ordinary publication and prepared promotion share ONE private canonical
 * replacement primitive: revalidate the target under `expect`, no-follow
 * revalidate the source inode/length/hash/canonical bytes, rename, fsync
 * `.rbox/state`, exact reread. Neither entry point implements its own rename. */
function replaceCanonicalControl(root, expect, source: ExactControlBytes, locks): MigrationControl;

export function publishMigrationControl(root, expect, next: MigrationControl, locks): MigrationControl;
export function renderPreparedControl(root, revision: number, next: MigrationControl, locks): PreparedControlIdentity;

/** Allocation-free promotion of an ALREADY-EXACT prepared sibling. Immediately
 * before the rename it no-follow revalidates the recorded inode, byte length,
 * SHA-256, and canonical bytes for its fixed kind/revision; anything else is
 * foreign and it does not rename. No temp, no write, no truncate. */
export function promotePreparedControl(root, expect, prepared: PreparedControlIdentity, locks): MigrationControl;

/** Discriminated: the nondurable branch carries NO next control, so a caller
 * cannot keep publishing after a failed halt. */
export type HaltPublication =
  | { durable: true;  control: MigrationControl }
  | { durable: false; reason: unknown };

/** Same phase, incremented revision, exact `halt` + updated `haltResources`. If
 * publication needs space it releases the exact previously-available reserve and
 * records it `consumed-for-halt`. It NEVER consumes a retirement- or
 * cleanup-vector item as runway and never relabels a current intent. */
export function publishMigrationHalt(root, control, halt: MigrationHalt, locks): HaltPublication;

export function readCanonicalControl(root: string): MigrationControl | undefined;
```

Owns revision **arithmetic and validation** (safe integers, exact spacing, the
monotone `r → r+2` gap as the only permitted one). Paths live in `paths.ts`.

3C adds three members here rather than anywhere else, because this module is the
sole writer of the canonical control: `readCanonicalControlExact` (the record
plus the inode it occupies, which the promoted-halt retry's whole admission test
needs), `retireCanonicalControl` (M7's terminal unlink, under the same CAS as
every other transition), and an `export` on `releaseHaltResource` so its refusal
path has the direct test 1A's review flagged as missing.

##### What wave 1A pinned (record, so later waves do not re-decide it)

- **`FIRST_CONTROL_REVISION = 1`.** Neither document named the first published
  revision. With `expect.revision === "absent"` the publisher admits exactly
  `1`; `0` reads as "no control" and is refused. 3C's ledger arithmetic is
  relative to `b`, so this only fixes the M0 origin.
- **`r → r+2` is gated on the promoted record's phase.** It is the direct-M7
  success transition alone (163:2919). A halt promotion is `r → r+1` and
  doctor's retry promotion is `r+1 → r+2`; both are ordinary steps. The gap is
  admitted only when the prepared record's witness phase is `M7`.
- **M-1 and M-2 are synchronous.** The signatures above carry no `Promise`
  while every other module's do, and §1.3's `assertAuthorityWritable(root): void`
  is synchronous and consumes `readCanonicalControl`. **Lane 1C's
  `readGenesisIntent` must be synchronous for the same reason** — the same
  fence calls it on the SQLite save boundary.
- **Three duplicated members are not stored**, each being one value written
  twice whose only reachable disagreement is corruption: the control's
  top-level `phase` (the witness union is discriminated by phase), the halt
  record's own `phase` (halts are phase-preserving), and M6's `qAuthorityId`
  (the control already carries `authorityId`).
- **One path policy: every artifact the record names stores its own path.**
  163 prints paths inside the retirement vector, the M6 preparation ledger, and
  the M7 terminal sibling, and the record is not a delete-authorizing input the
  way the genesis intent is (§2.3.1) — cleanup identity-brackets before every
  unlink. The M6 ledger therefore keeps `version`, both slots' `kind`, and both
  slots' `path`; its outer discriminant is named `stage` so it does not collide
  with the slots' own `kind`.

  **Corrected by 3C: `promoted-halt`'s `preparedSuccess` stores no `bytes`.**
  163 prints no schema for the consumed `promoted-halt` form — only for the
  one-way `preparing` ledger — and says of it only that `preparedSuccess`
  "omits the M7 SHA-256". 1A read that as *carries `dev`/`ino`/`bytes`*, which
  makes the two prepared records mutually self-sizing: the halt record's
  canonical length depends on the decimal width of the M7 length it stores, and
  vice versa. 163's own five-row ordering then breaks before any fixpoint does
  — the halt bytes must be final before M7 is derived from them — and the
  fixpoint has no specified convergence. The member is also exactly the class of
  stored duplicate this list already refuses three times: 163:3092 requires the
  retry to recompute and byte-check the M7 record, so a stored length has no
  reachable use except to disagree with the recomputation. Full statement in
  163 § "V5 future-control preparation".
- **M6's `cleanup.order` is named `items`**, so the M6 cleanup cursor and the
  C1 retirement cursor are one `Cursor` type over one vector shape. They are
  the same one-target machine (163:2761, :2899) over different vectors.
- **The halt record's reason member is named `code`**, not 163:3339's `reason`.
  A rename only, matching `MigrationHaltCode`; no halt record is durable yet,
  so nothing on disk changes.
- **A crash between rendering a revision sibling and renaming it is resumable
  ONLY when the record recurs byte-for-byte — the non-deterministic case is an
  open decision, not a solved one.** Every phase after M0 pins both the
  migration id and the revision, so blanket-refusing the occupied path would
  wedge the migration permanently. The publisher therefore adopts the sibling
  when every byte is that exact record at that exact revision, re-fsyncs it and
  its parent, and treats anything else as foreign.

  That covers only records whose content is a pure function of the phase.
  **It does not cover M2, M3, or any halt**, whose bytes carry freshly created
  inodes, a wall-clock `completedAt`, or live failure detail — a crash in their
  render→rename window strands a sibling whose bytes will never recur, and that
  revision is then permanently unpublishable. The state is fail-closed and
  data-safe (JSON stays authority, the halt stays in memory) and unreachable in
  1A, where nothing is wired. Later waves must not "fix" this by letting the
  publisher overwrite any unpublished temp in its own namespace: **the M6
  runway legitimately owns prepared siblings at `b+5`/`b+6` while control sits
  at `b+4`**, so a blanket replace would destroy a live ledger-owned artifact.
  The intended remover is doctor's inert-temp quarantine (163's designated sole
  remover), which is a later wave; **the wave that wires the first post-M0
  publication owns closing this**, either by making those records deterministic
  or by landing quarantine alongside.

---

#### M-3 `classifier.ts`

```ts
export type MigrationObservation =
  | { row: "no-control-json" }                                   // JSON authority, eligible for M0
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

/** Typed, phase-bound evidence branded with the exact control revision it came
 * from. A mutator cannot be handed a raw `MigrationControl` and cannot reuse a
 * receipt across a revalidation boundary. */
export interface PhaseReceipt { readonly phase: MigrationPhase; readonly control: MigrationControl }

export async function classifyMigrationState(root, locks): Promise<MigrationObservation>;
```

**FINDING 5 — no genesis rows.** `genesis-candidate` and `genesis-finish-ahead`
are gone. This module is only reached after the coordinator (§1.3) has ruled
genesis out. Its `corruption` row still fires on absent-`L` + present-DB, which
is correct: reaching that state through the migration path *is* damage.

Contradictory authority — exact `Q` with an absent, incomplete, unreadable,
foreign, or wrong-`authority_id` DB — is a hard `StateAuthorityCorruptError`
(new class in `errors.ts`, landed in Wave 1), zero repair writes, not a
`MigrationHaltCode`, never retryable. `Q` + a *matching complete* DB with M5
control is not corruption; it is `m5-artifact-ahead-q`.

Zero writes, enforced by import graph — an **import-graph ban on `bun:sqlite`
in every refusal-path module** is the right mechanism and generalizes beyond
this file (r6). One table-driven test per row, plus a byte-for-byte `.rbox`
snapshot, **sidecars included**, before/after every corruption row.

**The ban is re-scoped by frozen-versus-live, not deleted (r6).** §2.5.1's
amendment and this re-scoping are **one unit; neither is correct alone.**

- **Frozen window** — M4 rename-ahead, `m5-resume`, `m5-artifact-ahead-q`.
  Writes are blocked by `blocksSqliteWrites`, so the physical
  `{bytes, sha256}` match is exact and genuinely stronger than anything the
  database says about itself. The ban stands as written: pure `fs`, no
  `bun:sqlite`.
- **Live window** — `m6-cleanup`, `m7`, `cleanup-deferred`, `terminal-sqlite`.
  The store is **explicitly writable and in normal use**, so a physical
  `{bytes, sha256}` predicate goes stale on the user's next sync and then throws
  an unretryable `StateAuthorityCorruptError` on a healthy workspace. The
  durable predicate 163 actually names — `store_meta.authority_id` plus the
  `migration_completion` singleton — requires an open. That open is **legal**:
  past the authority flip the active database is rbox's own store, rbox owns
  the inode, and the ownership rule never forbade rbox reading its own DB.

The ban therefore reads: no `bun:sqlite` on any refusal path or in the frozen
window; in the live window, read the workspace's own store through the owning
connection and nothing else.

---

#### M-4 `admission.ts`

```ts
export type AdmissionRefusal =
  | { code: "degraded-fence" }
  | { code: "quarantine-pending" }
  | { code: "barrier-witness-missing"; verdict: WitnessVerdict }
  | { code: "migration-not-exclusive"; detail: string }
  | { code: "reserve-foreign"; detail: ReserveForeignDetail };

export async function admitMigration(root, entry: EntryProof, locks): Promise<AdmissionVerdict>;
export async function admitMigrationBudget(root, sourceBytes: number, stream: string): Promise<BudgetVerdict>;
```

The five conditions (163 §3 bullet 3), in order: non-`degraded-unlocked` locking
health → `degraded-fence`; no live/recent workspace operation →
`migration-not-exclusive`; `.rbox/state/quarantine/` absent →
`quarantine-pending`; `verifyLastWriterWitness` matches all five fields with
`writerVersion >= 1.11.0` → `barrier-witness-missing`; the exclusivity window
proven (§3.3) → `migration-not-exclusive`. Re-called verbatim immediately before
the M6 rename.

No `admitGenesis`. Refusals publish nothing and are freely retried. A structural
test asserts `legacy-writer-live` and paired-interval sampling appear nowhere.

---

#### M-5 `import-json.ts`

```ts
export async function preserveSource(root, receipt: PhaseReceipt, source: SourceIdentity, locks): Promise<M2Witness>;

/** FINDING (r3-1) — FOUR admitted observations of the staging main path, each a
 * distinct returned variant, so every one has a coherent path through this API:
 *   absent                     → `O_EXCL` no-follow create, fsync file + parent,
 *                                identity-bracket        → { kind: "claimed" }
 *   the sole create-ahead shape → ADOPT (exact path, no-follow regular,
 *   (zero-byte, 0600, no sidecars) zero-byte, 0600, no sidecars), fsync,
 *                                identity-bracket        → { kind: "claimed" }
 *   recorded incomplete main   → identity-bracket, remove it AND only its own
 *   with its own sidecars only   sidecars, create fresh   → { kind: "claimed" }
 *   recorded main carrying an  → no mutation; the import is already done
 *   EXACT committed completion   (163:3249's sole M3-artifact-ahead form)
 *     tuple for this id                                  → { kind: "completed" }
 * Anything else — sidecar without main, non-regular or followed path, nonzero
 * unrecorded file, foreign identity — is a `reserved-path` halt, zero writes. */
export type StagingMainClaim =
  | { kind: "claimed";   identity: ClaimedInode }
  | { kind: "completed"; identity: ClaimedInode; completion: CompletionTuple };
export async function claimStagingMain(root, receipt: PhaseReceipt, locks): Promise<StagingMainClaim>;

/** Step 2 is M-9's: CAS-publish the SAME-PHASE M2 revision recording that exact
 * identity (163:3163), yielding the branded receipt below. On a `completed`
 * claim, M-9 publishes the same revision and skips straight to M3 publication —
 * `importOwnedStaging` is not called. */
export interface PublishedStagingClaim { readonly identity: ClaimedInode; readonly receipt: PhaseReceipt }

/** FINDING (r3-1) — `initializeStateStore` opens `"wx"` and REJECTS an existing
 * path (`open.ts:218`), so it cannot be used here. U3 adds to `store/open.ts`:
 *
 *   export function adoptClaimedStateStore(
 *     file: string, expected: ClaimedInode, install: (db: Database) => void,
 *   ): StateStoreHandle
 *
 * identical to `initializeStateStore` except that it opens the EXISTING file and
 * asserts, no-follow, that it is exactly the recorded `{dev, ino}` zero-byte
 * 0600 regular inode — the expected identity is a PARAMETER, not an assumption.
 * Both delegate to one private body; both remove the file and its sidecars on
 * any caught failure — legal precisely because the adopter OWNS the inode it
 * was handed (r6). This is the model the ownership rule generalizes: only the
 * owner may open, and only the owner may clean up after itself.
 * `createStateStore` keeps the creating variant.
 * `genesis.ts` uses the same adopter (§2.2 step 3).
 *
 * Then: re-run 52×/RSS admission immediately before the sole guarded parse,
 * compute the JSON-side semantic stream, import every plane/record in ONE
 * transaction with `migration_completion` LAST. */
export async function importOwnedStaging(
  root, published: PublishedStagingClaim, source: SourceIdentity, locks,
): Promise<M3Witness>;

export async function proveStaging(root, receipt: PhaseReceipt, locks): Promise<M4Witness>;
```

**The JSON side of the digest does not exist and U3 builds it**, in
`digest/state-semantic-v1.ts` alongside the SQL projection:

```ts
/** Strips `resolutionIntent` BEFORE the digest (never routed to `extras_cjson`,
 * no shape-presence bit), normalizes invalid repo counters to zero, derives the
 * full source-shape presence bits. */
export function normalizeLegacyStateV1(state: SyncState): NormalizedLegacyState;
export function legacyStateSemanticDigest(n: NormalizedLegacyState): StateSemanticDigest;
```

One file, because a grammar divergence between the two sides is exactly the
failure this digest exists to catch. The same normalization supplies the
`source_shape_flags_cjson` presence bits that `installGenesisLineage` currently
writes partially — genesis passes constant flags, migration derived ones, both
through one builder.

---

#### M-6 `finalize.ts`

```ts
export async function publishPreparedDatabase(root, receipt: PhaseReceipt, locks): Promise<M5Witness>;
export async function stepQSibling(root, receipt: PhaseReceipt, locks): Promise<QSiblingStep>;

export type FlipOutcome =
  | { kind: "flipped"; witness: M6Witness }
  | { kind: "arm-retirement"; trigger: C1Trigger };

/** Migration-only; the source witness is ALWAYS real. Revalidates
 * source/backups/completion; then — as the LAST operation before `fs.rename`,
 * with NOTHING between them — re-verifies the live `state.json` body hash
 * against the M3-imported source digest under the held `stateLockPath`. Then
 * renames, and fsyncs `.rbox`. */
export async function flipAuthority(root, receipt: PhaseReceipt, source: SourceIdentity, locks): Promise<FlipOutcome>;
```

No nullable witness, no genesis caller. Both invariants stay under attack: no
fsync, hash, or logging between the check and the rename; all five M0 conditions
re-checked here.

**Shipped as two files (4A), and the signatures amended.** The budget above was
280 and the honest single file measured 475 nonblank against 163:3994's hard 400,
so M-6 is `finalize.ts` (M5's rename onto `state.db`, the Q sibling's
`absent → building → exact` ladder, and the primitives both halves share — 331
nonblank) plus `authority-flip.ts` (the one rename that elects SQLite, its
pre-rename evidence, the initial M6 cleanup vector, and everything after the
rename — 339 nonblank). Both sit in 163's 301–399 band, and the review note is
the one M-3/M-5/M-8 already carry: each is one correlated machine, and most of
the growth is the reasoning that review demanded be written where the code lives
(which side of 163:2988 each refusal falls on, why a length conjunct is or is not
compared, what contains each stale witness member). Same disposition M-8 took for the same reason, and the
dependency runs strictly one way: the flip imports the receipt guard, the marker
bytes, and the sibling fence from `finalize.ts`, never the reverse. The seam is
the rename — everything in `finalize.ts` runs under legacy-JSON authority. The
module count is therefore eleven, not ten.

Two signature amendments, both ratified in review:

- `flipAuthority(root, receipt, locks)` — the `source: SourceIdentity` parameter
  is dropped. `SourceIdentity` does not exist in the tree, and 3A already made
  this amendment for `preserveSource`/`importOwnedStaging`: the source comes from
  `control.source`, because a second parameter could only ever disagree with the
  record the CAS is keyed on.
- It returns `{ kind: "flipped"; control }`, not a witness. 163:2988 forbids
  publishing a lower revision once the rename begins, and the only code that can
  honour that is code owning both the rename and the publication — a witness
  return implies the driver publishes M6 afterwards, which is exactly the gap a
  driver could interpose in. The flip therefore also owns the `.rbox` parent
  fsync and the `M5 + exact Q` resume branch.

**The M5 witness records `stagingMain: "absent"`** (163:2748), published by M5
itself through the layered witness. Keeping M3's `{state: "present"}` is not
merely stale: `retirement.ts` reads that member, finds the staging name empty at a
phase that is not M4, and refuses — which makes C1 retirement from M5 impossible.

**The rename's own failure is typed.** 163:2988's rule is stated for the
aftermath of a rename, not for the syscall, so 4A decides it explicitly:
`durability-indeterminate` with `wrote: true`. `rename(2)` is atomic, so the
failure left one of the two admitted images and the caller cannot know which —
`wrote` is genuinely unknowable at that instant and a zero-write row is an
assertion that must not be guessed. The code cannot over-fence, because
`blocksSqliteWrites` is already TRUE for every phase below M6. This does not
contradict `promoteSuccess`'s refusal to mislabel a CAS error, where the fence
would otherwise be lifted.

**An empty M6 cleanup vector is refused, not published**, because `stepCleanup`
has no complete-prefix transition into M7 and the runway has no final item, so an
empty cursor wedges the migration one phase past the point of no return. A
shorter-but-nonempty vector is admitted. **Constraint on whichever wave introduces
halt clearing:** `haltRunway` returns `[]` only at M6/M7, so at M5 a halt may
still consume both resources, and clearing that halt without recreating them
would reach the flip with an empty vector — a post-rename `reserved-path` refusal
that no row can clear. That wave must either exclude `emergency` from
`haltRunway` below M6, or let a complete-prefix empty cursor reach M7. Not
reachable today only because nothing clears a halt yet.

**Which M5 witness members go stale, and what contains each** — carried here
because the containment is a property of who reads what on which row, no row
dispatcher exists yet, and nothing asserts it. **5A must not break these.**

| Member | Stale from | Contained by |
|---|---|---|
| `staging` (the M4 proof) | M5's rename | Every consumer at phase ≥ M5 reads `active` instead: `retirement.ts` selects on the phase to do exactly that, and `classifier.ts` compares `witness.active` on both M5 rows |
| `completion.sourceJsonSha256`, `source` | the flip | Their only comparisons — `bracketSource` and the flip's pre-rename body re-read — run under legacy-JSON authority and are unreachable from any row where `Q` is live. The flip's resume branch is the boundary and deliberately skips both |
| `active` | **never** | `blocksSqliteWrites` is TRUE for every phase below M6, so the frozen window spans the rename and ends only when M6 publishes. This is why the flip may still compare it after `Q` is live |

**Known asymmetry, for a 163 answer.** The flip's resume branch does not
revalidate the two legacy-JSON backups, while the pre-rename path treats a
missing one as a hard refusal. 163's `M5 + exact Q` row admits exactly one
action — complete/retry the `.rbox` fsync and publish M6 — and lists no backup
precondition; refusing would wedge a fenced M5 forever, because the document the
backups copy no longer exists to re-derive them from. The cost is that a backup
deleted inside the rename → publish window is never noticed, and it cannot be
recorded either: the control schema is closed and strict, so a "backups
unchecked" note needs a codec member 4A does not own.

---

#### M-7 `retirement.ts`

```ts
export async function armRetirement(root, receipt: PhaseReceipt, trigger: C1Trigger, locks): Promise<MigrationControl>;
export async function stepRetirement(root, receipt: PhaseReceipt, locks): Promise<RetirementStep>;
```

`reason` is always `durableRetirementReason(trigger)` — one durable reason, both
dispositions. `items` derives only from the old exact control's own recorded
artifacts; it never discovers a path. `stepRetirement` includes the terminal
step: at complete prefix, unlink the control and fsync.

Vector order (163:2704): Q sibling → staging `-journal`, `-wal`, `-shm` → staging
main → prepared active DB → migration-id private artifacts (role 5 only) →
emergency resource → **the claimed reserve**. Never the current `L`, the
immutable history, or the fixed backup.

---

#### M-8 `cleanup.ts`

```ts
export async function stepCleanup(root, receipt: PhaseReceipt, locks): Promise<CleanupStep>;
export async function stepFutureControlPreparation(root, receipt: PhaseReceipt, locks): Promise<PreparationStep>;
export async function completeFinalItem(root, receipt: PhaseReceipt, locks): Promise<FinalItemOutcome>;
export async function retryPromotedHalt(root, receipt: PhaseReceipt, locks): Promise<FinalItemOutcome>;
export async function finishMigration(root, receipt: PhaseReceipt, locks): Promise<void>;
```

`completeFinalItem` byte-exactly re-matches all 128 reserve-header bytes before
unlinking role 7, unlinks the final item, fsyncs its parent, then asks M-2 to
promote the exact M7 sibling under expected `r`; on a caught failure *before*
that promotion begins it promotes the prepared halted-M6 sibling instead.
`finishMigration` publishes M7 **first**, then unlinks the unused `r+1` sibling
if exact-terminal and fsyncs, then unlinks the control and fsyncs.

The `b..b+4` runway never creates a second pair and always resumes the same
ledger stage and inode; a caught ENOSPC there publishes no alternate control
(the named scoped f6 exception). No genesis branch — genesis has no cleanup
vector because it claims no reserve and no emergency candidate.

**Shipped as two files (3C).** The budget above was 360 and the honest
implementation is 636 lines, so M-8 is `cleanup.ts` (the cursor, the
identity-bracketed removal of a vector item, M7, and the primitives both halves
share — 302 lines) plus `cleanup-runway.ts` (the `b..b+4` preparation ledger,
the two prepared records, slot I/O, the final item, and `retryPromotedHalt` —
396 total, 376 nonblank). 163's ceiling is stated once as nonblank and once
without, so both readings are satisfied rather than argued. It is not a budget
to be renegotiated, and
the correlation the one-file review note was protecting is preserved by the
dependency running strictly one way: the runway imports from the cursor, never
the reverse. The module count is therefore ten, not nine.

**`completeFinalItem` and the 128 reserve header bytes.** §M-8's earlier
sentence attached the role-7 header re-match to `completeFinalItem`, but role 7
is the *nonfinal* item in every vector where the emergency candidate exists, so
the rule belongs to the shared item bracket rather than to one step. 3C puts it
there: any vector item of role `reserve` is unlinked only after its first 128
bytes are re-read through the same descriptor that proves the inode and hashed
against the digest the vector recorded. **That digest is the contract M-6 (wave
4A) must honour when it builds the vector**: an item of role `reserve` whose
`sha256` is `null` is refused, so the requirement cannot be silently skipped.

**Two hazards for 4A's vector builder, stated because nothing in the schema
catches either.**

- For role `reserve`, `ArtifactItem.sha256` is the SHA-256 of exactly the first
  `RESERVE_HEADER_BYTES` (128) bytes — the same value M1 recorded on adoption.
  It is not a whole-file digest and it is not `haltResources.reserve.sha256`.
  Both names describe the same file, nothing cross-checks them, and 4A builds
  the vector from the resource record, so a wire-up error would satisfy the
  codec and every 3C test. 163:4429 states these must not drift; this is the
  drift it means. (`releaseHaltResource` verifies
  `haltResources.reserve.sha256` as a whole-file digest, which is the shape
  every other `{bytes, sha256}` witness in the codec carries.)
- `ArtifactItem.path` is schema-typed as a bare `"string"` with no confinement.
  **Now fenced rather than documented.** 3B landed `notDerived` over the C1
  vector while this lane was in review, so M-8 adopted the same rule at the door
  of every M6 mutator: each item's `path` must equal the path its role derives
  to from `migrationPaths`, and its `parent` must be that path's own directory
  or the post-unlink fsync is aimed elsewhere. A row reading
  `/tmp/outside/precious.txt` is refused, not removed. 4A's builder should still
  derive every `path` from `migrationPaths` — the fence now makes anything else
  fail closed instead of silently working.

  The two vectors derive their own roles separately because they admit
  different ones (C1 carries the staging artifacts and the Q sibling; M6 carries
  two). **5A consolidation candidate:** one role→path derivation consumed by
  both, rather than the two that exist now.

---

#### M-9 `authority.ts` — migration only

```ts
export type MigrationOutcome =
  | { kind: "migrated"; phases: MigrationPhase[]; elapsedMs: number }
  | { kind: "already-migrated" }
  | { kind: "refused"; refusal: AdmissionRefusal }
  | { kind: "retired"; trigger: C1Trigger }
  | { kind: "halted"; halt: MigrationHalt; durableHalt: boolean };

/** FINDING 5 — no genesis outcome and no genesis dispatch. This module neither
 * imports nor is injected with anything from `genesis.ts`. */
export async function runMigration(root, entry: EntryProof, onProgress): Promise<MigrationOutcome>;

/** Before EVERY M1–M6 mutator — including all M3 seams — revalidate source
 * identity/hash and the exact control revision, minting a fresh `PhaseReceipt`.
 * A stale receipt cannot reach a mutator; an observed source change arms C1
 * instead of mutating (163:2699). On `{durable: false}` from a halt publication
 * the driver returns IMMEDIATELY and performs no further migration write. */

/** Four exhaustive retry buckets, keyed on the classified halted row:
 *  1. ordinary halted M0–M5 — recreate/fsync any `consumed-for-halt` or
 *     `not-created` resource, CAS-publish the same phase with both dispositions
 *     `available`, clear, resume;
 *  2. C1 or M6-cleanup cursor halt — preserve the exact cursor, clear, resume
 *     ONLY its current target, INCLUDING terminal-prefix work;
 *  3. ordinary halted M7 — CAS-clear, then `finishMigration`;
 *  4. final-intent `promotedHalt` — NO clear; delegate one single-use in-process
 *     attempt to `cleanup.retryPromotedHalt`.
 * Exhaustive over the halted rows or it does not compile. */
export async function retryHaltedMigration(root, locks): Promise<MigrationOutcome>;
export async function abortMigration(root, locks): Promise<MigrationOutcome>;
```

Structural test: no `node:fs`, `node:crypto`, or `bun:sqlite` in this module's
import graph.

**Shipped as four files (5A), and six amendments.** M-9's budget was 240; the
honest driver measured 465 nonblank against 163:3994's hard 400, and two of the
phases it must sequence did not exist. What shipped:

| File | Nonblank | Owns |
|---|---:|---|
| `authority.ts` | 342 | `runMigration`, `ROW_DISPATCH`, and every publication a phase body does not make itself |
| `halt-recovery.ts` | 158 | the four retry buckets and the pre-`Q` abort — the only code that clears a halt |
| `begin.ts` | 255 | **M0 and M1**, which no wave built |
| `control-sibling.ts` | 235 | split out of M-2 to carry the strand repair (below) |

`authority.ts` sits in the 301–399 band; the review note is the one M-3/M-5/M-6/M-8
already carry — the M0→M7 sequence is one correlated machine 163 specifies as a
unit. The dependency runs strictly one way in both splits: recovery imports the
driver, and the publisher imports the sibling primitives.

1. **M0 and M1 had no owner.** §8's wave table gives 3A "M-5 (M2 / M3 / M4)" and
   2B "admission, which publishes nothing", so nothing minted a migration id,
   published a first control, claimed the reserve, or created the emergency
   candidate: `publishMigrationControl` at `FIRST_CONTROL_REVISION` and
   `migrationPaths.emergency` had **no production caller at all**. 5A builds both
   as `begin.ts`, because a driver with no M0 is not a driver. The emergency
   candidate's size is unstated in 163 and is derived rather than picked:
   `CONTROL_MAX_BYTES`, zero-filled, which is exactly the one record it exists to
   let a halt publish.

2. **§M-9's "no `node:fs`/`node:crypto`/`bun:sqlite` in this module's import
   graph" is unimplementable read transitively** — the driver's whole job is
   sequencing bodies that open databases and rename files. It is implemented as
   §7.9 states it: `authority.ts` (and `halt-recovery.ts`) import none of the
   three *themselves*, which is what actually protects the property. Same class of
   finding as 163 v13's M4.

3. **`{kind: "retired"}` carries the durable reason, not a `C1Trigger`.** A
   retirement resumed from a record has no trigger; the record keeps the one
   durable `reason` plus `fromPhase`, and synthesizing a disposition from
   `triggeringSource` would invent the fact §M-7 deliberately does not store.

4. **`retryHaltedMigration`/`abortMigration` take an `EntryProof`, not bare
   `locks`.** Both delegate to `runMigration` when the row is drivable again, and
   admission's exclusivity condition reads the entry point.

5. **2D's generics collapsed** onto the real `MigrationOutcome`.
   `MigrationDriver` stays an *injected* function rather than a direct call:
   binding the progress sink is the entry site's job, and injection is what lets
   the coordinator's own tests drive the C8 re-inspect without a whole migration.
   The stub in `authority-bootstrap.test.ts` returned a bare string, invisible to
   both gates (`tsconfig` excludes tests, Bun erases annotations) — now typed.

6. **§M-6's halt-clearing constraint needs neither escape.** Bucket 1 recreates
   whatever the halt spent and republishes both dispositions `available` in the
   *same* publication that clears, so a cleared M5 halt cannot reach the flip with
   an empty cleanup vector. `emergency` stays in `haltRunway` and no
   complete-prefix empty cursor reaches M7.

**The halt-record wedge — closed, and by a third path.** 1A's pin assigned the
render→rename wedge to the wave that first wires a post-M0 publication of a
non-deterministic record; 3A closed M2/M3 by determinism and left halts here.
Halts cannot be made deterministic — §6.3 requires them to print what was
*measured*, and `memory-admission`/`disk-preflight` measure live RSS and `statfs`
— and quarantine-later is not sufficient, because the wedge is worse than
"un-haltable": a strand at `r+1` blocks the **successful** publication at `r+1`
too, so a workspace that halts on low disk and then has disk freed can never
migrate. `control-sibling.ts` therefore repairs its own strand, bounded by the
*actual* ownership predicate rather than a phase proxy: the canonical record is
asked which revision-scoped paths it still owns (the M6 runway's two prepared
slots, M7's terminal sibling — 3C's negative control), those are refused, and at
every other path in this migration's own id-and-revision-scoped namespace exactly
two occupant shapes are admitted — a complete record for this exact id and
revision, or a nonempty strict byte prefix of the record about to be written,
which is the only image `writeSync` can tear. The repair is in place on the
recorded inode, the precedent genesis case 3 and 3A's M2 rebuild both set. A
crafted occupant is refused exactly as before.

**`claimSibling`/`claimSlot`: NOT consolidated.** 4A recorded the mechanism as
identical line-by-line with the refusal channel as the only difference. The
mechanism is identical — `O_CREAT|O_EXCL` → EEXIST → no-follow reopen → validate
the sole create-ahead shape → fsync — but the difference is **two** axes, not one:
`claimSibling` converts a non-`EEXIST` open failure into a typed `reserved-path`
halt because it runs where every refusal must carry a halt code, while `claimSlot`
rethrows so `stepFutureControlPreparation`'s out-of-space catch can see it. A
shared body parameterized over both the refusal channel and the propagation
policy for non-`EEXIST` errors is a worse abstraction than two honest copies of
twenty lines of `openSync` boilerplate, and both copies are separately
mutation-pinned by their own lanes. The 5A consolidation note is withdrawn rather
than deferred.

**§7.9's prose-only items, now executable** in `migration/authority.test.ts`: the
stale-witness routing gate (below), the CODEMAP one-line-per-module rule — which
no wave-1-to-4 lane could satisfy because nothing enforced it — and the pinned
count of `establishStateAuthority` entry call sites. That count is pinned at what
exists (zero) rather than asserted at two: §6.3 already states both commands land
with §3.2 and 5B, and the gate's purpose is identical either way — an unenumerated
third caller fails it. `EXPECTED_SITES` is the one line 5B edits. The
`HeldStatePlaneLocks` cast gate was already made executable by 2B and is pinned
from the inventory's home so its deletion is visible.

**The stale-witness containment, now asserted.** §M-6 recorded it as "no consumer
reaches this from that row", with no row dispatcher in existence. The driver is
that dispatcher, so `ROW_DISPATCH` is *data* and three gates cross it against what
each body reads: no body dispatched from a row where `Q` is live calls
`bracketSource`; the one unguarded reader of the stale M4 `staging` proof
(`publishPreparedDatabase`) appears under exactly one row, and it is `m4-resume`;
and `m5-resume`/`m5-artifact-ahead-q` stay disjoint on everything but
`flipAuthority`. For the flip the containment is a *branch* rather than a row —
it does read both flip-stale members — so its own gate asserts source order: the
resume branch's return precedes every stale read, and the resume branch itself
reads only `active`, the member §M-6 marks never stale.

**Round-3 fold — behavioral coverage and four blockers.** The first 5A submission's
tests were entirely static (the sandbox's `bun test <path>` argv is heuristically
refused; a pinned wrapper script runs it, which the first pass missed). The fold
adds `authority-behavior.test.ts` — a real migratable workspace under a real
`withStatePlaneLocks` bundle that drives M0→M3 organically (M4 needs an importable
corpus, which is 3A/5C fixture territory), plus synthetic-control units — and every
new guard is mutation-verified (15 named production mutants, all killed; baseline
green). Four blockers the review found, all closed:

- **B1** — `createEmergencyCandidate` had no strand repair, so a torn own write
  (partial/zero-length, at this migration's own id-scoped path) wedged M1 forever
  under exactly the `ENOSPC` this file exists to survive. It now repairs its own
  torn write in place on the recorded inode (`rewriteEmergencyStrand`), the
  `control-sibling.ts` shape, admitting only a strictly-shorter all-zero image.
- **B2** — `ownedRevisionPaths`' fail-closed branch returned
  `[migrationPaths.control(root)]`, which the caller compares against a
  `controlRevision()` path, so it never matched: the degraded/unreadable-canonical
  state became the *permissive* one. It now lets `readCanonicalControl`'s throw
  propagate, so a corrupt canonical refuses the render rather than licensing a
  sibling overwrite.
- **B3** — `abortMigration` could not abort a *halted* pre-`Q` migration (163:2614's
  "essentially every case"), because `armRetirement` refused on `control.halt`.
  `armRetirement` gains an operator-only `clearHalt` that publishes `halt: null` in
  the same revision that arms the retirement (bucket-1 discipline; no runway
  restoration, since `haltRunway` is `[]` under a retirement and consumed resources
  stay `consumed-for-halt`, which `retirementVector` skips). `abortMigration` passes
  it.
- **B4** — the post-flip data-loss fence (`SQLITE_LIVE_ROWS.includes(row)`) had zero
  coverage; now behavioral (abort refuses/does-not-refuse by row) plus an
  exact-members assertion.

Ride-alongs taken: the flip stale-read gate is window-scoped (kills the aliasing
evasion, rev1 M24); `dispatch` gains a `default: assertNever(observation)` so a new
row is a compile error, not a spin; `runMigration` non-convergence returns a typed
`corruptionHalt` rather than a bare `throw`; `abortMigration` on a pristine
workspace returns a distinct `nothing-to-abort` (never `already-migrated`, so 5B
cannot tell a pristine workspace it was migrated); the strand prefix branch is bound
to the encoded id+revision, not merely "control-record-shaped"; `rewriteStrand`
carries `O_NONBLOCK`. Noted for doctor, not blocking: a crashed M0 leaks one inert
~1 KiB revision temp per crash (re-entry mints a fresh id), for the inert-temp
quarantine sweep.

---

### 1.2 The two adapters

#### A-1 `adapters/sqlite-state-save.ts` (260)

```ts
export async function applySavePacketToStore(
  store: StateStoreHandle, packet: StateSavePacket, ownerToken: OwnedLockCasToken,
): Promise<CasResult>;
```

Consumes only merged seams. Returns the raw `CasResult`. May not touch authority
selection, the JSON path, or migration.

#### A-2 `adapters/whole-state-compat.ts` (340)

Owns: authority selection via `classifyStateFormat`; the typed
`StreamMismatchError` on a different-stream read on both backends, never a
manufactured genesis baseline; shared reset recovery and reset-lineage
provenance; exhaustive raw `CasResult` translation against the retry view's exact
token, **without widening `StateSaveResult`**.

**The write fence — ONE call**, at the SQLite save boundary only, under the
already-held state lock:

```ts
import { assertAuthorityWritable } from "../authority-bootstrap.js";
assertAuthorityWritable(root);   // throws StateWriteRefusedError("authority-recovery-pending", …)
```

An earlier draft inlined two reads here — the migration control and the genesis
intent — with a duplicated refusal branch. That was worse three ways, and
collapsing it fixes all three at once:

- it **duplicated a branch** that is one policy, not two;
- it **doubled the hot-path reads** on every SQLite save;
- it **broke §7.9's boundary gate.** `whole-state-compat.ts` would have imported
  from *both* `migration/` and `genesis.ts`, making "exactly one module imports
  both" false — and lanes 2C and 2D would have collided over who owns the
  predicate.

The coordinator already imports both domains and is the only module allowed to,
so the fence lives there (§1.3). A-2 imports one function from one module and
holds no opinion about either domain.

A surviving genesis intent after `Q` means the authority rename's parent fsync
may not have completed (§2.5.2 case 1) — the exact analogue of migration's
`M5+Q` block. Once the intent is retired, writes flow. `cleanup-deferred` is
writable.

Contradictory authority throws `StateAuthorityCorruptError` from selection, zero
repair writes, not a halt, never retryable.

**Standing-halt visibility without a daemon lifecycle.** No `migration-halted`
state, no pump, no catch. A standing durable halt is *projected* from the control
into the existing doctor/status surface, exactly as `reset-health.ts` does.

**Call-site inventory.** CI counts `loadState()` production call sites; may only
decrease; zero by U4f.

### 1.3 `state-plane/authority-bootstrap.ts` — the coordinator (90)

**FINDING 5.** r3 declared the migration/genesis boundary and then had
`migration/authority.ts` route to genesis, which requires an import or injection
across the boundary the structural gate forbids. The routing decision belongs to
neither domain.

```ts
/** The one thing both entry points call. Holds the locks, asks genesis whether
 * this workspace is its business, and otherwise runs migration. */
export async function establishStateAuthority(
  root: string, entry: EntryProof, onProgress: ProgressSink,
): Promise<AuthorityOutcome>;

export type AuthorityOutcome =
  | { domain: "genesis";   outcome: GenesisOutcome }
  | { domain: "migration"; outcome: MigrationOutcome };

/** The state-plane write fence, as ONE exported predicate. Refuses while a
 * durable migration control blocks writes (`blocksSqliteWrites`) OR an
 * unretired genesis intent survives. Both are the same policy — "authority
 * recovery has not finished" — so they are one branch and one refusal reason
 * (`authority-recovery-pending`, the single member added to
 * `StateWriteRefusalReason`). This lives here because the coordinator is the
 * only module permitted to import both domains (§7.9); A-2 calls it and
 * imports nothing else from either. */
export function assertAuthorityWritable(root: string): void;
```

It runs, in order: `withStatePlaneLocks` (§3.1) → standing reset recovery →
`genesis.inspect(root)`. If genesis claims the workspace — no authority and no
migration control, or an exact genesis intent exists — it calls
`genesis.establish`; otherwise `migration.runMigration`. It contains no protocol
logic of its own.

**One re-inspect, for the one outcome that changes the answer (C8).** §2.5 case 5
is a genesis attempt that finds an `L` has appeared: it refuses `legacy-present`,
removes its own artifacts, and retires its intent — after which the workspace is
an ordinary migration candidate. Without a second pass, `rbox migrate` would
return `legacy-present` and do nothing while §6.1 tells the user to run
`rbox migrate`. So: **on `legacy-present` only**, the coordinator re-inspects
once and dispatches to migration in the same pass, under the same held locks.
Exactly one re-inspect; every other outcome returns directly. Any second
`legacy-present` is impossible (the intent is gone, so genesis no longer claims
the workspace) and would be a corruption halt rather than a third pass.

**Structural gates:** `genesis.ts` imports nothing from `migration/`;
`migration/**` imports nothing from `genesis.ts`; exactly one module imports
both, and it is this one.

---

## 2. Genesis — its own operation, with its own durable intent

### 2.1 Why it is not a migration (validated in r3, unchanged)

A genesis workspace has **no source document**. Every invariant the M0–M7
machine exists to enforce — source witness, revalidation before every mutation,
backup preservation, import fidelity, changed-`L` detection, retirement of a
superseded authority, the reserve/emergency runway — is vacuous. The machine's
purpose is safely retiring a source. Threading a no-source case through it
produced, in r2, a `null` witness, an empty cleanup vector that does not fit the
control schema, and phase rows with nothing to observe.

Genesis is `src/cli/state-plane/genesis.ts`, **393 non-blank lines / 20,008
bytes** as shipped in wave 1C, outside `migration/`.

**§7.9 review note (the 301–399 band requires one).** The pre-implementation
estimate was ~240. The delivered file is 65% larger, and the difference is not
drift — it is four things this section had not yet costed, each of which was
argued for and kept:

- the eight-row §2.5.1 conjunction with its read-only sidecar undo (§2.5.1),
  which the estimate predated;
- seven distinct crash images, each with its own legal action, rather than the
  single resume path the estimate assumed;
- the strict closed-record decode, now delegated to `closed-record.ts` — this
  one made the file *smaller*;
- the fenced-evidence construction and comparison (§2.3.2).

It stays one file: 163 v12 and §2.3 name `genesis.ts` sole owner of the intent
and of every path derived from `authorityId`, and the seven crash images are one
decision table that splitting would scatter. It is inside §7.9's 400-line /
25 KiB ceiling with 7 lines of headroom, so **the next change to this file
should remove something or split deliberately** — it must not be absorbed
silently.

### 2.2 What r3 got wrong, and the repair

r3 claimed genesis needed **no** durable record because the DB's own
`origin_kind='genesis'` was sufficient evidence. That was wrong, and the reason
is worth stating precisely because it is the whole argument for §2.6:

> A DB at the active path with no `Q` is either **(a)** genesis leftovers — no
> user data, safe to sweep and retry — or **(b)** a migrated workspace whose `Q`
> was lost — **real data, where sweeping is catastrophic**. Nothing *inside* the
> candidate distinguishes (a) from (b): `origin_kind` is a `CHECK`-constrained
> string the candidate asserts about itself (`v1.ts:29`), and `validateOpen`
> establishes structure and coherence but never that this process created the
> DB, that its lineage matches this workspace's fenced evidence, or that
> checkpoint/`S0`/fsync completed. A genesis DB copied from another workspace
> satisfies r3's wording and would cause `Q` to be derived from the copy's
> authority id.

That is exactly what 163's ambiguous-halt row protects. So genesis gets a
durable witness **outside** the candidate — small, written once, retired last.

Two further r3 defects the repair also closes: an incomplete DB was reachable at
the *active* path with no owner (because r3 built directly there), and the
legacy-absence check was not the literal last operation before the rename.
Building at a staged path also honors 163's own wording — genesis "uses staged
DB + `Q`" (163:2603, 163:3772) — so r3's direct-construction reading is
withdrawn and no longer needs ratification.

### 2.3 The genesis intent — and the trim question, answered

`.rbox/state/genesis-v1.json`, owned entirely by `genesis.ts`. A closed exact
record, **written once and never updated mid-flight**:

```ts
export interface GenesisIntent {
  version: 1;
  authorityId: string;      // hex32 — determines the 58 Q bytes, scopes every
                            //         path this attempt may own, and is checked
                            //         against store_meta.authority_id
  lineageId: string;        // hex32 — checked against store_meta.active_lineage_id
                            //         and migration_completion.migration_id
  evidence: FencedEvidence; // §2.3.2
  staging: { dev: number; ino: number };   // claimed BEFORE SQLite opens the file
}

/** Minimal by design (C5). Enough to notice a `.rbox` that was copied or moved
 * between workspaces, or a workspace re-adopted since the intent was written.
 * Nothing more — see the founder steer in §2.3.3. */
export interface FencedEvidence {
  root: string;             // absolute workspace root
  stream: string;           // syncStreamId for this workspace
  incarnation:              // `.rbox/state/state-incarnation.json`
    | { dev: number; ino: number; sha256: string }
    | "absent";
}
```

**There is no stage field, and no stored path.** The recorded inode plus four
observable paths determine the case totally, because `rename(2)` preserves the
inode — so "where is my recorded inode?" answers "how far did I get?" without a
cursor.

#### 2.3.1 Paths are derived, never read from the record (C4)

Both paths this attempt may own are **derived from `authorityId`**:

```
staged DB   .rbox/state/state.db.genesis.<authorityId>
Q sibling   .rbox/state.json.genesis.<authorityId>.q
```

The record stores **no path string**, and `genesis.ts` never unlinks a path it
read out of the record — it unlinks only paths it derived from `authorityId` and
whose identity it independently confirmed. That removes a field *and* removes a
delete-authorized input, which is the trade this design wants: a corrupted or
tampered record can no longer name a victim.

A path scoped to a different `authorityId` is not ours and is never touched —
the same distinction the reserve protocol makes.

#### 2.3.2 What `FencedEvidence` is for

163 requires "fenced config/incarnation/reset evidence" for genesis but never
enumerates it, and r3 left it undefined while leaning on it. It is three values,
all cheap, all observable before the database exists: the absolute workspace
root, the sync stream id, and the identity of the incarnation marker (or the
literal `"absent"`, which is itself a fact worth binding).

Its job is to notice **accidents**: a `.rbox` directory copied or rsynced from
another machine, a workspace moved on disk, or a re-adopt that happened after an
intent was written. A well-formed intent whose bound evidence differs from the
live evidence is §2.5 case 7 — a zero-write halt that deletes nothing.

#### 2.3.3 The trim question: the smallest record that still works

**Question.** What is the smallest record that separates *genesis leftovers*
(no user data, safe to sweep) from *a real workspace whose `Q` was lost* (real
data, sweeping is catastrophic)?

Applied field by field, with the founder steer — **accident-proof, not
attacker-proof; where a field only buys attacker-resistance, drop it**:

| Field | Verdict | Why |
|---|---|---|
| `version` | **Survives** | Strict decode of a closed record. A future version must halt, not be read leniently. One integer |
| ~~`attemptId`~~ | **DROPPED (r5)** | Redundant. Its only jobs were scoping the two paths and distinguishing attempts. `authorityId` is already a fresh hex32 per attempt (a rebuild mints a new one, and nothing external depends on it before `Q`), so it scopes the paths itself — and scoping the Q sibling by the same id whose bytes it will contain is *stronger*, not weaker. One field and one indirection removed |
| ~~`staging.path`~~ | **DROPPED (C4)** | Derived from `authorityId`. Removes a stored string and a delete-authorized input |
| `authorityId` | **Survives** | Load-bearing three ways: the 58 `Q` bytes, the path scope, and the `store_meta.authority_id` equality check that makes C2's inode-reuse fix work |
| `lineageId` | **Survives, belt-and-braces** | It is the second value the intent published *before* the database existed, and it binds both `store_meta.active_lineage_id` and `migration_completion.migration_id = 'genesis:<lineageId>'`. Honest accounting: with `authorityId` already checked, a *lineage* mismatch is reachable only at ~2⁻¹²⁸, so this is closer to attacker-resistance than accident-safety. It stays because the completion-row check (C2) names it and it costs 32 bytes — but it is the one field a reviewer could cut without weakening the accident story |
| `evidence` | **Survives, minimally** | The only thing that catches a copied or moved `.rbox`, which is an accident a real user can produce with `cp -r`. Three values, no more |
| `staging{dev,ino}` | **Survives** | The core ownership proof, and the thing C2's correction hardens |

**Result: six fields become five**, and the record no longer contains any string
that authorizes a deletion.

**What was deliberately *not* added,** per the steer: no HMAC or signature over
the record (buys only attacker-resistance; a same-user attacker with write access
to `.rbox` is already conceded by 163's threat model); no monotonic counter or
generation (races are locked out by the exclusivity window, §3); no
staging-content hash (the DB is not final when the intent is published, so the
hash would be of nothing).

### 2.4 The operation

```ts
export type GenesisOutcome =
  | { kind: "established"; authorityId: string }
  | { kind: "already-established" }
  | { kind: "refused"; reason: GenesisRefusal };

export type GenesisRefusal = "legacy-present" | "artifact-present" | "evidence-missing";

/** Does this workspace belong to genesis? Read-only. */
export async function inspect(root: string, locks: HeldStatePlaneLocks): Promise<GenesisInspection>;

/** The two ids the intent publishes before the database exists. */
export interface GenesisIds { authorityId: string; lineageId: string }

/** Establish SQLite authority on a workspace that has none.
 *
 * FRESH START ONLY. `mintIds` is called at most once, and only when there
 * is no intent to resume (§2.4 step 3, and §2.5.2 case 4's rebuild). */
export async function establish(
  root: string, mintIds: () => GenesisIds, locks: HeldStatePlaneLocks,
): Promise<GenesisOutcome>;

/** Resume an existing attempt. The intent is the SOLE source of `authorityId`
 * and `lineageId`; no caller-supplied lineage reaches this path. */
async function resume(root: string, intent: GenesisIntent, locks: HeldStatePlaneLocks): Promise<GenesisOutcome>;

/** Read-only; consumed by A-2's write fence. SYNCHRONOUS, like M-2's
 * `readCanonicalControl`: §1.3's `assertAuthorityWritable(root): void` calls
 * both on the SQLite save boundary and is itself synchronous. */
export function readGenesisIntent(root: string): GenesisIntent | undefined;
```

Seven steps. No phases, no witnesses, no reserve, no retirement, no cursor.

1. **Confirm no authority and no competing artifact.** `.rbox/state.json` absent
   (not `L`, not `Q`), `.rbox/state/state.db` absent, `migration-v1.json` absent,
   and the fenced evidence of §2.3.2 present. Otherwise refuse `legacy-present` /
   `artifact-present` / `evidence-missing`, mutating nothing.
2. **Claim the staged path.** `O_EXCL` no-follow create a zero-byte mode-0600
   file at `.rbox/state/state.db.genesis.<authorityId>`; fsync it and
   `.rbox/state`; `lstat` it. A crash here leaves a zero-byte file no record
   names. It is inert and provably not a database, and **nothing in U3 deletes
   it** — it is reported, not swept (C7).
3. **Publish the intent** (§2.3), recording that exact identity and the live
   fenced evidence. Only now may SQLite open anything.
4. **Build**, via `adoptClaimedStateStore(file, expected, install)` (§1.1 M-5,
   Wave 1B — **not on `main` today**) with
   `install = db => installGenesisLineage(db, lineageFrom(intent))`, which already writes the
   `migration_completion` singleton last in its own transaction. Then
   recover/checkpoint, validate, close, **require `S0`**, fsync the file and
   `.rbox/state`.
5. **Place it.** Rename the exact recorded inode from the staged path to
   `.rbox/state/state.db`; fsync `.rbox/state`.
6. **Prepare `Q`.** Create the sibling at
   `.rbox/state.json.genesis.<authorityId>.q`, write the 58 bytes derived from
   `authorityId`, fsync it and `.rbox`.
7. **Publish `Q`.** Revalidate the fenced evidence; then, as the **literal final
   operation before `fs.rename`, with nothing between them**, re-verify that
   `.rbox/state.json` is still absent under the held `stateLockPath`. Rename the
   sibling over `.rbox/state.json`, fsync `.rbox`, **then retire the intent last**
   (unlink, fsync `.rbox/state`).

**The intent is the sole source of `authorityId` and `lineageId` on every
resume. Only §2.5.2 case 4 mints fresh ids.** This is load-bearing, not
housekeeping: §2.5.1 checks the database's `store_meta` against the *intent's*
ids, so any resume path that rebuilds from step 4 with caller-supplied ids
installs values that can never satisfy the conjunction — and a **healthy**
workspace live-locks into a permanent halt on every retry. `establish` therefore
takes a `mintIds` thunk it calls at most once, `resume` takes the intent and
no ids at all, and step 4's `install` reads its stream and both ids straight off
the intent.

**Signature amendment (implementation, wave 1C).** The thunk is
`mintIds: () => GenesisIds`, not `mintLineage: () => GenesisLineage`.
`GenesisLineage` is `schema/application.ts`'s install argument and additionally
carries `stream` and `createdBy` — values genesis derives itself, from the
fenced evidence and a module constant. Letting a caller supply them would widen
exactly the surface this paragraph closes, so the thunk returns only the two ids
the intent publishes. This is stronger than the signature first drafted here;
the code is normative and this text now matches it.

An inventory test asserts `installGenesisLineage`'s only genesis caller derives
its argument from an intent (`inventory.test.ts`), that the thunk is called from
exactly one place, and that `resume` never reaches it.

Step 6 before step 7 is deliberate: r3 checked absence and *then* did four
filesystem operations before renaming, leaving exactly the window the check
exists to close.

Step 7 does not use M6's `absent → building → exact` ladder. That ladder makes a
partially written sibling resumable across a control record's recorded
disposition. Genesis records no disposition: the sibling sits at a path derived
from `authorityId`, which this intent owns, so it is rewritten from offset zero
and truncated to 58 bytes. Owned, not discovered.

### 2.5 The finishing predicate, and the crash images

#### 2.5.1 The finishing predicate (C2 — the real hazard)

**Before any finishing action, an inode match is not sufficient.** `dev`/`ino`
pairs are recycled by the filesystem, and this design creates the exact
conditions for it: §2.5 case 3 truncates the recorded inode, and *migration*
stages its own database in the **same directory** and renames it onto
`.rbox/state/state.db`. A recycled inode could therefore land at the active path
holding **real user data**, satisfy an inode-only test, and cause `Q` to be
published from `intent.authorityId` — whose id would not match the database,
turning a healthy migrated workspace into a permanent
`StateAuthorityCorruptError`.

So the predicate is a **conjunction**. A database is this intent's genesis
database only if **all** of the following hold:

**Evaluated only on a database this code owns; never opened otherwise (r6).**
r5 required this conjunction to be evaluated "through the read-only preflight,
never a read-write open", reasoning that a read-write open would let WAL replay
mutate the candidate. **That premise is falsified.** A read-only open of a
WAL-mode database in a writable parent creates `-wal`/`-shm` on its first read —
a bare `PRAGMA user_version` is enough — and a read-only close cannot remove
them, while a read-write close can. Read-only does not avoid the write; it
abandons the debris — and with a `0555` parent the same open instead throws
`attempt to write a readonly database` on its first read, so the outcome is
environment-dependent and a read-only parent is not a fix. The effect is
**WAL-only** (a `journal_mode=delete` database is inert), but the rule stays
ownership-scoped, because journal mode is a property of the candidate — the
thing a refusal path does not get to inspect first.
`openStateStore(file, { readonly: true })`'s stated purpose
(`store/open.ts:249-262`) does not survive contact with WAL mode, and
`immutable=1` is not the fix either: it creates no sidecars but silently ignores
uncheckpointed WAL content, so on a healthy candidate whose `store_meta` and
`migration_completion` rows are still in an uncheckpointed WAL it returns a
confidently wrong verdict.

The governing rule is **163 v13's ownership rule**, and it maps onto this
section's own refusal/work boundary:

- **Refusal path — the candidate is not ours.** Cases 6 and 7 refuse from
  file-level facts alone (`{dev,ino}` identity, `state.json` shape, live fenced
  evidence). No SQLite open of any kind occurs on any path that ends in a
  refusal.
- **Work path — the database *is* ours.** Cases 2 and 3 reach the conjunction
  only after the intent's recorded `{dev,ino}` has already matched, which is
  what makes the file this intent's own staged inode. Only then is it opened,
  **read-write, as its owner**, and the case's own sequence
  (recover/checkpoint/validate/close/require `S0`/fsync) is what restores the
  at-rest signature. Opening without checkpointing and closing is the defect,
  not opening writable.

**The premise above is false, and two independent waves measured it.** A
read-only connection to a WAL database creates `-wal` and `-shm` at its **first
read**, and — unlike a read-write connection, which checkpoints and unlinks them
on close — it **cannot remove them again**. The read-only preflight closes the
WAL-replay hazard but **not** the sidecar hazard. So a halt against a real user
database left two sidecars beside it, and 163:1136-1138 then classifies that
file set as a corruption signature rbox is forbidden to clean up. Choosing
read-only does not deliver the guarantee this section claims; it only changes
which file gets written. **Wave 2A reached the identical conclusion from M-3 and
wave 1C from §2.5.2 — treat "evaluate through the read-only preflight" as
*insufficient on its own* wherever this design says it, not just here.**
`immutable=1` is not the escape: beyond suppressing WAL replay, `bun:sqlite`
does not enable URI filenames, so the open fails outright (measured).

**The remedy is to not open, wherever an independent fact decides.** 2A
eliminated its opens entirely — the classifier matches a candidate against the
control's own `witness.active` physical `{bytes, sha256}`, which is *stronger*
than reading `store_meta.authority_id` because it does not trust the candidate's
self-description, and defers the no-control case to A-2 at selection.

**Genesis cannot borrow that discriminator, and this is structural, not an
oversight.** Genesis runs precisely when there is no control record, so there is
no independent witness to match against; and §2.3.3 deliberately excluded a
staging-content hash from the intent ("the DB is not final when the intent is
published, so the hash would be of nothing"). The intent's physical facts are
`staging{dev,ino}` and the fenced evidence — nothing that describes *contents*.

So the conjunction is ordered cheapest-first — evidence, then the recorded
`{dev, ino}` — and the halt images were measured one by one:

| Image | Opens? | Why |
|---|---|---|
| 7, bound evidence differs | **no open** | `resume` halts before the predicate |
| 6, foreign inode at either path | **no open** | the identity row decides |
| 6, **recycled** inode at the active path (C2) | **opens** | only `store_meta` discriminates |
| 5, foreign active DB under an `L` | **opens** | same image, reached from the refusal path |
| 1, 2, 3 | opens, and **accepts** | success paths; `sealAtRest`/case 3's truncate already leave S0 |

Every zero-write halt is therefore decided with **no open at all except the
recycled-inode image C2 exists for** — and for that one image no file-level fact
can discriminate, because `store_meta.authority_id` lives inside the b-tree. For
it alone the open happens and then **undoes exactly the sidecars it created**,
never a pre-existing one, which would discard unreplayed frames. Measured: such
a `-wal` is 0 bytes and the main database is byte-identical afterwards.

**The undo stays in `genesis.ts` and is not a property of `openStateStore` —
but state the reason accurately.** An earlier draft of this section claimed that
removing a `-shm` under a live sibling reader splits the wal-index across two
inodes. **That does not reproduce** (Linux, bun 1.4 / SQLite): with a sibling
reader live, removing `-shm`, or `-wal`+`-shm`, with an empty or a frame-holding
WAL, left the sibling reading correctly in every combination tried, and a
subsequent commit was still visible to both readers. A proposed
`SQLITE_IOERR_SHORT_READ` failure mode did not reproduce either.

So the placement is a **precaution resting on an invariant, not on a
demonstrated corruption**: `openStateStore` supports several concurrent
read-only handles per file — `closeOwnedStateStoreReadersForReset` exists
precisely to close them all — so an unlink there would act on shared state whose
other users that layer does not account for. Genesis runs under §3.1's
exclusivity window, where there is exactly one opener, so it needs no such
reasoning. Do not promote this undo to the shared layer on the strength of the
genesis case; that would require its own analysis of concurrent readers.

**Accepted residual: the guarantee covers a completed halt, not a crash inside
one.** The undo runs in a `finally`. A SIGKILL or power cut between the
read-only open and that `finally` leaves exactly the `-wal`/`-shm` signature
163:1136-1138 forbids, beside a real user database. Nothing in this design
closes that window — the sidecars are created by SQLite before any rbox code
regains control. It is narrow (one open, no user-visible work between) and it
degrades to the same state the unfixed code produced on *every* halt rather than
on a crash inside one, but it is not zero. A reader of this section must not
infer an absolute guarantee.

| Check | Value |
|---|---|
| identity | the file's no-follow `{dev, ino}` equals `intent.staging` |
| opens cleanly | `validateOpen` succeeds **on the owning read-write connection**, reached only after the identity row above matched (r6) |
| authority | `store_meta.authority_id === intent.authorityId` |
| lineage | `store_meta.active_lineage_id === intent.lineageId` |
| origin | a `migration_completion` singleton with `origin_kind = 'genesis'` |
| binding | that row's `migration_id === 'genesis:' + intent.lineageId` |
| emptiness | that row's `entry_count = 0` and `repo_count = 0` |
| evidence | `intent.evidence` equals the live fenced evidence |

Any failure raises **`StateAuthorityCorruptError`**: nothing is adopted, nothing
is deleted, no `Q` is published, and nothing is retryable. Cases 6 and 7 are
**zero writes only because the cheapest-first ordering above holds** (r6): the
identity and evidence checks are pure `fs`, so every refusal is decided before
any open. If a later lane reorders the conjunction so an open precedes them, the
zero-write claim becomes false.

**Two members are deliberately not load-bearing, named here so nobody later
mistakes them for safety.** `entry_count = repo_count = 0` is *tautological* —
`installGenesisLineage` writes zeros and genesis imports nothing, so no
reachable genesis database has other values. `lineageId` is *defense in depth* —
with `authorityId` already checked, a lineage mismatch is reachable only at
~2⁻¹²⁸. Both are in the **ratified** 163 v12 row text; cutting either would cost
a re-ratification for zero safety, so both stay. Do not "simplify" them away,
and do not cite them as the reason the conjunction is sound — `authorityId`,
the identity, and the evidence are.

**This is not the withdrawn proposal.** Every one of `authority_id`,
`active_lineage_id`, `migration_id`, `origin_kind`, `entry_count`, and
`repo_count` is written by the **already-merged** `installGenesisLineage`
(`schema/application.ts:25-86`, completion row at `:67`, `migration_id` composed
as `` `genesis:${lineageId}` `` at `:72`) **from values this intent published to
disk before the database existed**. The database is not asserting something about
itself; it is being checked against a record that predates it. That is the whole
difference between r3's withdrawn rule and this one.

#### 2.5.2 Crash images — exhaustive, one legal action each

**Evaluation order matters in exactly one place: case 7 is evaluated before case
5.** Case 5 keys on `state.json` being `L` and does not reference §2.5.1, so it
does not inherit the evidence check; without the explicit ordering, a copied
`.rbox` carrying a foreign intent into a workspace that has an `L` would take
case 5's cleanup path and delete another workspace's artifacts. Evidence is
checked first, and a mismatch halts before any case-5 removal.

**Cases 6 and 7 raise `StateAuthorityCorruptError`, not a new halt code.** That
is deliberate and it is a deletion: **U3 adds no genesis halt taxonomy** — no
member of `MigrationHaltCode`, no new entry in `MIGRATION_HALT_COPY`, and no new
copy to write, because `StateAuthorityCorruptError` already has its copy in
§6.4. It also removes the contradiction an unnamed "halt" created with §5.3 and
163:2612, which reserve halts for the migration control's own taxonomy. The
three genesis **refusals** (§6.1) are unaffected: they fire at step 1, before
anything is mutated, and are not halts.

| # | Observation | Only legal action |
|---|---|---|
| 1 | `Q` matching `authorityId` + active path satisfies §2.5.1 | **Terminal.** Retry the (idempotent) `.rbox` fsync, remove the sibling if present, retire the intent. **Writes stay blocked until the intent is retired** (A-2 fence) |
| 2 | `state.json` absent + active path satisfies §2.5.1 | Recover/checkpoint, fully validate, close, require `S0`, fsync DB and parent — **all of it**, then steps 6 and 7 |
| 3 | `state.json` absent + active absent + staged path holds the recorded inode | Open it — legally, because the recorded inode matched, so this is **our** staged file and this is 1C's sole remaining open (r6). If it satisfies §2.5.1: checkpoint/validate/close/`S0`/fsync, then step 5 onward. If it **does not open cleanly through `validateOpen` as a genesis store bound to this intent** (C9 — `installGenesisLineage` runs in one transaction, so "committed but not genesis-shaped" is not a reachable state; the reachable failure is a partial or unopenable file): **`ftruncate` the recorded inode to zero in place** (C3 — this preserves the inode, so the next crash still reads case 3 rather than case 6), remove only its `-wal`/`-shm`/`-journal` sidecars, and rebuild from step 4 through the same adopter, whose precondition is exactly a zero-byte claimed file |
| 4 | `state.json` absent + the recorded inode is at neither path, both absent | Nothing durable happened after the intent. Rebuild from step 2 under a **fresh** `authorityId`; the new intent is published before the old one is unlinked |
| 5 | `state.json` is `L` | **Refuse `legacy-present`.** JSON is authority. Remove only our own confirmed artifacts, retire the intent — and the coordinator then re-inspects once and dispatches to migration in the same pass (§1.3, C8) |
| 6 | A foreign inode at either path, an unrecorded file at the active path, `Q` with a non-matching authority id, a malformed intent, or any §2.5.1 check failing | **`StateAuthorityCorruptError`**, zero writes. Never adopt, never delete |
| 7 | A well-formed intent whose bound `evidence` differs from the live fenced evidence | **`StateAuthorityCorruptError`**, zero writes. A copied, moved, or re-adopted workspace. Delete nothing — the artifacts may belong to the workspace this `.rbox` came from |

**No intent present** is the ordinary world: `absent/absent/absent` → genesis may
begin; anything else → 163's existing rows, unchanged, including the
ambiguous-halt row that protects a migrated workspace whose `Q` was lost.

### 2.6 The 163 amendment — RATIFIED, and now normative in 163 v12

**Status: RATIFIED by the founder, 2026-07-28.** The amendment this section
proposed across r3–r5 is folded into
`docs/design/163-state-plane-sqlite.md` as **v12**: the two matrix rows are
inserted in § "Migration authority state machine" (M0 authority matrix), and the
decision record is § "R4-v12 genesis intent (v12)". 163 v12 is normative; this
section is a pointer and a rationale, not a competing copy.

**What 163 v12 owns:** the two authority-matrix rows, and the statement of what
does and does not change. **What 222 owns:** the protocol behind them — the
intent's field list and the trim rationale (§2.3), the seven-step operation
(§2.4), the finishing conjunction and the seven crash images (§2.5), the copy
(§6.1), and the fixtures G1–G6 (§7.1). If the two ever disagree, **163 v12
wins on the rows and 222 wins on the protocol**, and one of them is a bug.

Recorded here for context, since the reasoning is what the rest of §2 is built
on:

---

**Problem.** 163's M0 authority matrix contains two ratified rows that are
individually correct and jointly unimplementable:

```
| absent | absent  | absent | No authority. Genesis is allowed only with fenced
                              config/incarnation/reset evidence and uses staged
                              DB + Q; otherwise halt.                          |   (163:2603)
| absent | any DB  | any    | Ambiguous/manual damage; halt. DB presence never
                              elects authority.                                |   (163:2604)
```

The first authorizes genesis. The second halts on the only intermediate state
genesis can produce, because an active database and `Q` cannot be published
atomically. Genesis therefore cannot complete a crash-safe run under the matrix
as written.

**Why a witness is required rather than a cleverer read of the database.** An
active database with no `Q` is either **(a)** genesis leftovers — no user data,
safe to sweep and retry — or **(b)** a migrated workspace whose `Q` was lost —
real data, where sweeping is catastrophic. Nothing inside the candidate
distinguishes them: `origin_kind` is a `CHECK`-constrained string the candidate
asserts about itself (`schema/v1.ts:29`), and `validateOpen`
(`schema/validate-open.ts`) establishes application id, schema version, DDL
fingerprint, required objects, and singleton/head coherence — but never that this
process created the database, never that it belongs to this workspace, and never
that checkpoint/`S0`/fsync completed. An earlier draft of this amendment keyed
the new rows on `origin_kind` alone; that was withdrawn because a valid genesis
database **copied from another workspace** would satisfy it and cause `Q` to be
published from the copy's authority id.

**Amendment (as ratified).** Introduce one durable artifact, the **genesis intent**
(`.rbox/state/genesis-v1.json`, design 222 §2.3): a closed exact record binding
this workspace's fenced evidence, the authority id, the lineage id, and the
`{dev, ino}` identity of the staged database file — published **before** SQLite
opens that file and unlinked **last**, after `Q`. It stores no path (both paths
are derived from the authority id) and therefore names no deletion target. It is
owned solely by `state-plane/genesis.ts`. It is not a migration control, carries
no phase, and no migration module reads or writes it.

163's M0 authority matrix gains **two rows**, both keyed on the intent. They
are now inserted in 163 v12; the shape below is the ratified intent, and 163's
inserted rows are the normative wording:

```
| Legacy path | Active DB                          | Control                   | Authority and M0 action |
|---|---|---|---|
| absent | absent, or exactly the database that    | migration control absent  | Genesis in progress. Only the genesis
|        | satisfies design 222 §2.5.1 against     | AND an exact genesis      | recorded-identity correlation of design
|        | this intent — the recorded {dev,ino},   | intent whose bound fenced | 222 §2.5.2 may act. No migration phase
|        | `store_meta.authority_id`, `store_meta. | evidence equals this      | is inferred and no migration artifact is
|        | active_lineage_id`, and a genesis       | workspace's current       | created. No authority until `Q`.
|        | `migration_completion` singleton whose  | fenced evidence, and      |
|        | `migration_id` is `genesis:<lineageId>` | which records that exact  |
|        | with `entry_count = repo_count = 0`     | {dev,ino} identity        |                                        |
| exact  | matching `C`, whose `authority_id`      | same as above, and the    | Genesis finish-ahead past the authority
| `Q`    | equals the intent's authority id and    | intent's authority id     | rename. SQLite authority; **writes are
|        | the `Q` bytes                           | equals the `Q` authority  | blocked** until the parent fsync
|        |                                         | id                        | completes and the intent is retired.    |
```

**Every value in those checks was written by already-merged code from values the
intent published before the database existed.** `installGenesisLineage`
(`schema/application.ts:25-86`) writes `store_meta.authority_id`,
`store_meta.active_lineage_id`, and the `migration_completion` singleton —
including `migration_id = 'genesis:' + lineageId` (`:72`) and the zero counts —
last in its own transaction, from the caller's values. The database is never
asserting something about itself; it is checked against a record that predates
it. That distinction is the reason this amendment is safe where the withdrawn
one was not.

**What is explicitly NOT changing:**

- The **ambiguous/manual-damage row is unchanged** and still fires for any
  database at the active path when there is no exact genesis intent satisfying
  the full conjunction above. A migrated workspace whose `Q` was lost still
  halts, exactly as today.
- **"DB presence never elects authority" is preserved verbatim.** Presence still
  elects nothing. The intent — a separate, durable artifact published before the
  database existed — is what authorizes the finishing action, and the database
  must satisfy every check the intent implies.
- The genesis row at 163:2603 keeps its wording, including "**uses staged DB +
  Q**", which design 222 §2.4 now honors literally. No second interpretation of
  that phrase is requested.
- No migration row, phase, witness, halt, or artifact changes. The intent is not
  a migration control and never becomes one.
- The `Q` predicate, the barrier, the last-writer witness, the reserve, and
  F1–F6 are untouched.
- **Doctor gains no new deletion authority.** Genesis artifacts are reported, not
  swept. Nothing in U3 deletes an unowned zero-byte staged file, a stranded `Q`
  sibling, or a database at a path scoped to a different authority id.

**What this does add, stated so it is not discovered later:**

- one durable artifact (`.rbox/state/genesis-v1.json`) and one new named member
  of the `.rbox/state/` namespace inventory, plus the two derived paths
  `state.db.genesis.<authorityId>` and `state.json.genesis.<authorityId>.q`;
- **one new condition in the state-plane write fence**: an unretired genesis
  intent blocks SQLite writes, alongside the existing migration-control
  condition. Both surface as the single refusal reason
  `authority-recovery-pending`;
- **three new refusal codes** — `legacy-present`, `artifact-present`,
  `evidence-missing` — each with plain-English doctor copy and a
  non-interactive twin (design 222 §6.1);
- **one prerequisite that does not exist on `main` today**: step 4 needs
  `adoptClaimedStateStore(file, expected, install)`, because the merged
  `initializeStateStore` opens `"wx"` and rejects an existing path
  (`store/open.ts:218`). It is a Wave 1B deliverable and is also required by
  migration's M3. **This amendment is therefore not implementable against
  today's `main`** — ratifying it authorizes the design, not an immediate
  landing.

**Blast radius.** One new artifact, two new matrix rows, three refusal codes,
one added write-fence condition, and one new store-open variant. No migration
code path observes any of it.

---

**Ratification record.** Founder ratified 2026-07-28 as written, with
`lineageId` retained (§2.3.3 had flagged it as the one cuttable field). Folded
into 163 as v12 in the same change that carries this revision. The independent
validation's nine corrections (§10) were folded before ratification.

### 2.7 Genesis is still the first fleet checkpoint — but not in Wave 1

163:4488 names the genesis path as the first falsifiable signal. That stands.
**r3's claim that Wave 1B "ships first" is deleted**: genesis cannot be an
observable checkpoint before the coordinator (§1.3), an entry point (§3.2), and
A-2's post-`Q` read/write support exist. The module lands early because it
depends only on merged seams; the *checkpoint* is a Wave 5 milestone, and §8 says
so.

---

## 3. Exclusivity

### 3.1 The lock bundle

The repository fence is **callback-scoped**, so the bundle is a witness of what
is held, not a set of handles:

```ts
declare const heldStatePlaneLocks: unique symbol;   // not exported: the brand

export interface HeldStatePlaneLocks {
  readonly mutex: WorkspaceSyncMutex;      // non-degraded, acquired for this root
  readonly stateLock: OwnedLock;           // held for this exact root
  readonly underRepositoryFence: true;
  readonly [heldStatePlaneLocks]: true;    // mintable only in `locks.ts` (§7.9)
}

/** Degradation is a typed outcome, not an exception: 163's `degraded-fence` is
 * a refusal with plain-English copy, and it must be decided BEFORE the standing
 * reset recovery below, which copies, creates, and renames. */
export type StatePlaneLockOutcome<T> =
  | { readonly held: true;  readonly value: T }
  | { readonly held: false; readonly refusal: { code: "degraded-fence"; detail: string } };

export async function withStatePlaneLocks<T>(
  root: string, fn: (l: HeldStatePlaneLocks) => Promise<T>,
): Promise<StatePlaneLockOutcome<T>>;
```

Live mutex ownership is verified where the answer is consumed — admission's
exclusivity-window condition, re-called immediately before the M6 rename —
rather than at the moment the handle is made, where it is a tautology.

Order inside it, adopted verbatim from the N1 ruling:

```
stop (upgrade only)
  → healthy workspace mutex (assertHealthyOwnedSyncMutex, NOT assertSyncMutex)
  → read-only repository / reset-journal inventory
  → withRepositoryRecoveryFence(requests, stateIdentity, …)
  → state lock
  → under-fence identity/request recheck (two-pass: restart on change)
  → standing reset recovery to completion
  → classify and dispatch (§1.3)
  → release
  → unconditional restart (upgrade only)
```

The request derivation includes both current repository records and any standing
reset transaction. Refusing repo-bearing workspaces at the upgrade entry was
rejected: divergent entry semantics, and it excludes typical workspaces.

### 3.2 Two entry sites, one doctor authorization

```ts
export type EntryPoint = "upgrade-stop-window" | "foreground-migrate";
export interface EntryProof { readonly entry: EntryPoint; readonly locks: HeldStatePlaneLocks }
```

Both call `establishStateAuthority` (§1.3). Doctor authorizes a retry by calling
`retryHaltedMigration(root, locks)` with the same bundle — one authorization
site, no forgeable proof type.

**Entry A — `rbox upgrade`'s stop window, with a `finally`-level guarantee.**
`restartDaemonsAfterUpgrade` today runs `stop` and `resumeDesiredDaemon` in one
`try` with `continue` inside it (`upgrade-cmd.ts:143–158`).

```
try {
  await stop(root);
  if (desired.state === "stopped") return;
  try { await withStatePlaneLocks(root, l => establishStateAuthority(root, {entry, locks: l}, onProgress)); }
  catch (error) { recordWorkspaceOutcome(error); }     // never rethrows past here
} finally {
  await restartDesiredDaemonIfAny(row.desired);        // unconditional, every outcome
}
```

**Entry B — foreground `rbox migrate`.** Refuses inside a daemon process, same
bundle, same coordinator, progress rendering, `--json` twin the rig drives.

**LANDED in wave 5B, with three amendments the implementation forced.**

1. **Entry A lives in its own module** (`upgrade-state-window.ts`) rather than
   inside `upgrade-cmd.ts`, which is already past the module-size law. The
   §7.9 gate names it as one of the exactly-two, and it contracts *never to
   throw* — the `finally` restart is then the second of two independent
   guarantees rather than the only one.
2. **A conversion that did not happen never fails `rbox upgrade`.** §3.2's
   pseudocode says `recordWorkspaceOutcome(error)`; that is a line to print, not
   an exit code. `UpgradeDaemonRestartError` keeps meaning exactly what it meant
   — a stop or a restart failed. The window is also SILENT on every refusal: a
   refusal published nothing and `.rbox` is byte-identical, and an upgrade that
   printed a paragraph per not-yet-eligible workspace would bury the restart
   lines that are the command's answer.
3. **The post-`Q` inventory debt is CLOSED, here, not deferred.** The note below
   used to say the SQLite-backed inventory was future work. It was not
   separable: `inspectInventory` raised `StateFormatTooNewError` on an authority
   marker, so **no lock bundle was obtainable on a migrated workspace at all** —
   `rbox migrate` could not report success on its own work, and the two post-`Q`
   halts (`durability-indeterminate`, `cleanup-deferred`) were unreachable by
   the `--retry-state-migration` that exists for them. The fix is one line of
   derivation rather than a second inventory: the read goes through the
   **selecting whole-state seam** (`loadRawState`), which answers both formats
   with one signature, so the fence covers the same repositories either way.
   This is the ordinary post-`Q` read every other caller already performs; it is
   not the byte-identical-refusal path, where opening the authority would itself
   be the violation.

### 3.3 Proving the window

M0 admits only when both hold: the caller presents an `EntryProof` whose mutex is
healthy and live-owned and whose state lock is owned for this exact root; **and**
M0 independently confirms no daemon is live for this workspace from existing
pid-record/ownership evidence. Otherwise `migration-not-exclusive`, publishing no
control and creating no artifact. Genesis requires the same bundle.

An actor starting after the check blocks on the locks until release. The
lock-ignoring pre-`1.11.0` actor is the drained population of the B0 gate.

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
              · write fence: migration control AND genesis intent
```

Writes go native (O(dirty rows); the per-cycle full-serialize disappears here,
not in U4). Reads stay whole (every caller signature preserved). A structural
test pins `classifyStateFormat`'s production callers to `whole-state-compat.ts`,
the B0 barrier sites, and `genesis.ts` step 7.

---

## 5. The M0–M7 phase machine

`control.phase` is the **highest durably completed phase**. No phase is
pre-published.

### 5.1 Three outcome kinds

| Kind | Publishes | Suspends | Cleared by | Members |
|---|---|---|---|---|
| **Refusal** | Nothing; `.rbox` byte-identical — **the strongest promise in this document, and false for any refusal that opened a DB. 5C must actually test it, sidecars included (r6)** | No | Nothing | `degraded-fence`, `quarantine-pending`, `barrier-witness-missing`, `migration-not-exclusive`, `reserve-foreign`; genesis `legacy-present`, `artifact-present`, `evidence-missing` |
| **Disposition** | Arms C1 (durable reason always the literal `"source-changed"`) | No | Terminal retirement prefix | `source-changed`, `legacy-write-detected` |
| **Halt** | Same-phase revision with exact `halt` + `haltResources` | Yes | `--retry-state-migration`, four buckets | `filesystem-full`, `verification`, `reserved-path`, `durability-indeterminate`, `cleanup-deferred`, `source-oversize`, `memory-admission`, `record-oversize`, `disk-preflight`, `source-changed` **only as a retirement-cursor halt** |

### 5.2 Phase table

| Phase | Precondition | Work | Durable publication point | Crash-resume row | Reachable halts |
|---|---|---|---|---|---|
| — | control absent, exact `L`, no reserved active DB | — | — | Rerun read-only M0 after fresh identity/hash. An inert revision-scoped M0 temp is never adopted | `reserved-path` |
| **M0** | The five admission conditions | Bounded-read `L` first; identity-bracket + hash; random ids; exact staging path | After fresh identity/hash. Failure → in-process halt only | Row `M0`: reserve/emergency absent or exact id-scoped partial/complete; validate/create, rerun admission, publish M1 | `source-oversize`, `memory-admission`, `reserved-path` |
| **M1** | Exact M0; **source + control revalidated** | 52×, 512 MiB cap, RSS/cgroup, advisory `statfs`; claim/create the reserve; create + fsync the emergency candidate | Only after **both** identities and parents are durable | Row `M1`: backup absent, exact temp, exact current, or valid prior. Resume M2 idempotently | `source-oversize`, `memory-admission`, `disk-preflight`, `filesystem-full` |
| **M2** | Exact M1; **revalidated** | Preamble-prefixed streaming copy to `legacy-json/<body-sha>.json`; publish/reuse the fixed `.bak`, preserving a differing prior under its own body hash first | Only after both exact backup witnesses and parents are durable | Row `M2`, **both branches**: `stagingMain: "absent"` (no file, or the sole create-ahead shape); or a recorded exact identity, where an incomplete id-owned main and only its own sidecars may be recovered/removed and rebuilt. Sidecar-without-main halts | `filesystem-full`, `reserved-path` |
| **M3** | Exact M2; **revalidated before each of the three seams** | `claimStagingMain` (four observations) → **M-9 CAS-publishes the same-phase M2 revision recording that identity** → `importOwnedStaging` via `adoptClaimedStateStore(file, expected, install)`, one transaction, `migration_completion` last. A `completed` claim skips the import | Only after the committed completion tuple is reread and exact. WAL sidecars allowed until M4 | Row `M3`: exact committed id-bound staging; its own WAL/SHM may exist. Open only as migration owner, recover, rerun all M4 work | `record-oversize`, `memory-admission`, `filesystem-full`, `verification` |
| **M4** | Exact M3; **revalidated** | **Rewritten in r6 / 163 v13.** On the **owning read-write** connection: recover WAL, recompute the SQL digest/counts, validate ids, `foreign_key_check`, `integrity_check` — *then* `wal_checkpoint(TRUNCATE)`, close, `S0` **once**; fsync; physical-hash bracketed. The withdrawn "reopen read-only … `S0` again" cannot succeed: staging is WAL-mode, the read-only verifier's first read recreates the sidecars and its close cannot remove them. Owned by lane 3A | Publish M4 with the complete proof | Row `M4`: staging-only, or the M5 rename ran ahead. Revalidate identical hashes/completion, never move active backward, remove only a redundant exact staging name | `verification`, `filesystem-full`, `durability-indeterminate` |
| **M5** | Exact M4 hash; **revalidated** | Rename staging → `state.db`; remove only a redundant exact staging name; require staging absent and active `S0`; fsync `.rbox/state` | Publish M5 with the Q-sibling path + 58-byte hash **prebound**, disposition `absent`. **JSON remains authority** | Row `M5 + exact L`: sibling absent (+ the sole zero-byte create-ahead), recorded `building` at zero/partial/exact bytes, or recorded exact | `filesystem-full`, `reserved-path`, `durability-indeterminate` |
| **M6** | Exact M5; exact sibling; **revalidated** | Ladder via same-phase CAS; revalidate live JSON + `.bak` + M5 completion/hash; **then, as the last operation before the rename with nothing between, re-verify the live body sha against the M3 source digest under the held `stateLockPath`**; rename; fsync `.rbox` | Publish M6 with sibling absent + the initial cleanup cursor. **Observing `Q` elects SQLite even if publication was interrupted** | Row `M5 + exact Q`: SQLite elected; never rename back. Complete/retry the `.rbox` fsync, publish M6. **`blocksSqliteWrites` is TRUE for this row** | `filesystem-full`, `reserved-path`, `durability-indeterminate` |
| **M7** | Exact M6; complete nonfinal prefix; final item absent; prepared runway | **Publish M7 first**, converting resources to `retired`; **then** unlink the unused `r+1` sibling if exact-terminal and fsync; **then** unlink the control and fsync | M7 is the durable record of the final cleanup-absent prefix | Row `M7`: recorded `r+1` sibling exact-terminal or delete-ahead absent. **Retry bucket 3** covers a halt here | `cleanup-deferred`, `durability-indeterminate` |

### 5.3 The rows that are not phases

| Row | Only action | Authority |
|---|---|---|
| ordinary M0–M5 + changed exact `L` | Publish the initial C1 retirement revision **before any artifact mutation** | JSON |
| `source-change-retirement` from M0–M5 | Resume the one current intent target, or at complete prefix retire the control | JSON |
| halted `source-change-retirement` | Suspended at the exact cursor; doctor clears only that halt (bucket 2) | JSON |
| exact halted M0–M7 | Four buckets; the halt excuses no artifact mismatch | JSON before `Q`, SQLite after |
| terminal absent control + exact `Q` | Ordinary SQLite startup. `rbox migrate` here is `already-migrated`, exit 0, zero mutation | SQLite |
| foreign/malformed/inconsistent control or artifacts | Zero-write corruption halt | Existing `L`/`Q` predicate only |
| exact `Q` + absent/incomplete/foreign/wrong-id DB | Hard `StateAuthorityCorruptError`, zero repair. Not a halt, not retryable | Contradictory |
| **the two genesis-intent rows** | §2.6. Owned by `genesis.ts`; keyed on the full §2.5.1 conjunction, not on a field inside the candidate; no migration module reads them | None until `Q` |

### 5.4 Global rules

- An unhalted control admits only its required artifact or the explicitly printed
  **one-next-phase artifact-ahead** state. Everything else halts with **zero
  writes** and is never repaired forward.
- `SIGKILL`, power loss, and unobserved crashes **never manufacture a halt**.
- A halt never advances phase, retirement prefix, or cleanup prefix, and never
  consumes a vector item as runway.
- **A failed halt publication is the final mutation of the trace**, by type and
  by fault test.
- Before `Q`, a durable halt suspends migration but not JSON authority. After
  `Q`, only `durability-indeterminate` (write-blocking) and `cleanup-deferred`
  (writable) are expressible.
- **Nothing deletes an artifact it does not durably own** — not an incomplete DB,
  not a leftover `Q` sibling, not a reserve. Ownership means a recorded identity
  or an attempt-scoped path named by a durable record.
- The `b..b+4` runway is the named scoped exception to f6.

---

## 6. Copy and the non-interactive twin

The merged `satisfies Record<MigrationHaltCode, …>` is the gate. Genesis refusals
use the same copy shape through the same renderer.

### 6.1 Refusals

| Code | `human.problem` | `human.safety` | `human.command` | `machine.id` · severity |
|---|---|---|---|---|
| `degraded-fence` | "This workspace's folder can't be safely locked on this disk, so rbox won't move its state here." | "Nothing changed. Your files and your sync are unaffected." | `rbox doctor` | `state-migration/degraded-fence` · warn |
| `quarantine-pending` | "There's a paused state repair to finish first." | "Nothing changed. Your data is intact." | `rbox doctor` | `state-migration/quarantine-pending` · warn |
| `barrier-witness-missing` | "This workspace was last written by an older rbox. It needs one ordinary sync with this version first." | "Nothing changed." | `rbox sync` | `state-migration/barrier-witness-missing` · info |
| `migration-not-exclusive` | "rbox only moves state while nothing else is using this workspace." | "Nothing changed." | `rbox stop`, then `rbox migrate` | `state-migration/not-exclusive` · warn |
| `reserve-foreign` | "A file rbox keeps as a safety reserve doesn't look like rbox wrote it, so rbox left it alone." | "Nothing was deleted, claimed, or changed." | `rbox doctor` (names the path) | `state-migration/reserve-foreign` · warn |
| `legacy-present` (genesis) | "This workspace got its sync records back while rbox was setting up, so rbox stopped and kept them." | "Nothing was replaced." | `rbox migrate` | `state-genesis/legacy-present` · warn |
| `artifact-present` (genesis) | "There's already something where rbox keeps this workspace's state, so rbox didn't start fresh." | "Nothing was deleted or overwritten." | `rbox doctor` (names the path) | `state-genesis/artifact-present` · error |
| `evidence-missing` (genesis) | "rbox can't confirm this workspace is set up, so it won't create state records for it." | "Nothing changed." | `rbox adopt` | `state-genesis/evidence-missing` · error |

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

**Interpolation, and what wave 1A deferred.** 163:3300 requires the refusals to
print what was *measured*, not merely that a limit was hit. `MigrationHaltCopy`
therefore carries an optional `measured(halt)` renderer alongside the three
fixed strings, and `source-oversize`, `memory-admission`, `disk-preflight`, and
`filesystem-full` use it for the `required`/`available` pair the durable halt
record carries. The remaining facts are **deferred to wave 5B**, which owns the
renderer and the `--json` twin: `verification`'s backup path and
`reserved-path`'s occupant come from the control witness, not the halt, and
`memory-admission`'s exact `RBOX_RESET_PARSE_BUDGET_BYTES` value comes from the
environment. The copy map is the merge gate, so the shape is pinned now and
only the data sources are outstanding.

Both commands above land with §3.2 (`rbox migrate`) and §5B
(`rbox doctor --retry-state-migration`). Until they do, no halt is reachable;
5B is the gate for "every command is real and non-interactively twinned".

**LANDED in wave 5B.** The tables moved to `state-plane-copy.ts` (the
`satisfies` clauses, and therefore the merge gate, are unchanged) and
`state-plane-report.ts` decides which one an outcome reaches. Five rows of the
table above are AMENDED, each because the shipped wording was false rather than
merely improvable:

| Row | What was wrong | Amendment |
|---|---|---|
| `reserved-path` | "rbox found an unexpected file" is **factually inverted** for 163's authority-matrix row 17 (`absent`/`absent`/`absent` — no file at all), and for every corruption verdict `authority.ts`, `classifier.ts`, and `retirement.ts` raise through this code. It is the taxonomy's catch-all, not a statement about an occupant | "the files it keeps this workspace's sync records in weren't the ones it expected", which is true for every producer. Its `command` also stops being `rbox doctor` — the surface printing the message — and becomes an action |
| `source-oversize` | `measured()` rendered it **backwards**: the record's `required` is the document's own size and `available` is the 512 MiB ceiling, so the generic "N available against M required" printed the cap as what was available | Its own line: "This workspace's state file is X; the most rbox can convert is Y" |
| every `measured()` row | `?? "unknown"` leaked the literal word into user text where a number belongs | A row with no numbers renders **no measurement line at all**. Pinned by a test over every message |
| `memory-admission` | §6.3 owed the exact `RBOX_RESET_PARSE_BUDGET_BYTES` value | Rendered from the live budget, beside the two measured figures |
| `verification`, and the `underlyingCode` tokens generally | `verification` covers seven distinct refusals in `prove-staging.ts` and printed one sentence for all of them | `UNDERLYING_TOKEN_COPY` renders each stable token (`completion-tuple`, `semantic-digest`, `integrity-check`, …) in plain English. An errno reads as one; an unrecognised value is quoted rather than dropped |

Two further 5B corrections outside the table:

- **`nothing-to-abort`** (5A's outcome member) has its own message. Rendering it
  as `already-migrated` told a user on a pristine workspace that their records
  had been converted.
- **The halted-retirement detail** in `retirement.ts` said "resumes only through
  doctor", which reached the user as `rbox doctor` — a command that prints the
  halt again and changes nothing. It now names
  `rbox doctor --retry-state-migration`, which 163:3461 makes the only thing that
  clears a halt.
- **`source-unreadable`** is a NEW message, not a new halt code. 163's
  "malformed JSON / unreadable legacy path" row halts before any database open,
  and it escaped the operator commands as a raw `ResetCorruptionError` naming a
  JSON parser. It is rendered as a refusal with a next step.

**§6.4's `format-too-new` story is corrected (163 §C4).** `classifyStateFormat`
returns `authority-marker` only for the marker THIS binary writes — a future one
is `foreign` — so a healthy migrated workspace was reaching doctor's
"written by a newer version of rbox / run `rbox upgrade`" copy, telling a user to
upgrade a binary that is already the newest one there is. The `state` check now
reads through the selecting seam: a migrated workspace is reported healthy, and a
marker with no records behind it gets §6.4's re-adoption procedure spelled out
under a new `authority-corrupt` status. The 2C review flagged this as blocking
before any 2.0 tag; it lands here.

### 6.4 Not halts, never offered a retry

`StateAuthorityCorruptError` — "This workspace says it uses the new format, but
its state database is missing or doesn't match." / "rbox has changed nothing and
will not try to repair this automatically." / the printed re-adoption procedure.
`legacy-overwrite-after-Q` — names the hash-addressed backup; remedy is
re-adoption.

Never advise deleting `Q`. Never advise restoring a backup. Every `command` is
real and non-interactively twinned. The `migrating` state renders in plain
English past 5 s per phase, with a structured `--json` twin.

---

## 7. Exit gates

### 7.1 F1–F6 (migration) and G1–G6 (genesis)

| Fixture | Construction | Assertion | Negative control |
|---|---|---|---|
| **F1** | Degraded-unlocked workspace + live legacy writer | M0 refuses `degraded-fence`; no control, no artifact | Fence removed → M0 proceeds |
| **F2** | `forceLegacy` writer on a lockable fs, suspended after its state read; full M0–M7; writer resumes | Fails closed with `StateFormatTooNewError`; `Q` byte-identical | Barrier + lock-entry restriction removed → **demonstrably destroys `Q`** |
| **F3** | F2's shape, writer is the published signed 1.10.x artifact, released strictly after M6's rename | Documented outcome: `Q` destroyed; doctor reports `legacy-overwrite-after-Q` naming the backup | — |
| **F4** | Two concurrent degraded writers | The refusal, not last-writer-wins | — |
| **F5** | Signed 1.10.x, `forceLegacy`, rename inside M6's `check → rename` microwindow — driven by the `onStep` `"before-rename"` seam (`fsutil.ts:46`), **not by sleeping** | After M7: `state.json` is `Q`; DB and both backups carry the older digest; the writer's document absent from every artifact; doctor emits **no anomaly** | Companion: released one window earlier → M6 refuses `legacy-write-detected`, no rename, JSON authoritative |
| **F6** | F5 extended through the post-flip pull against remote `B1` after reverting to `B0` | Documented silent overwrite: ordinary `write`, no conflict copy, no anomaly | — |
| **G1** | Full genesis on a throwaway workspace | `Q` + matching DB + intent retired + **no migration artifact of any kind** (namespace-inventory assertion) | — |
| **G2** | SIGKILL at each of §2.5.2's cases 2, 3-clean, 3-unopenable, and 4 | Each resumes to a `Q` byte-identical to the uninterrupted run. **Case 3-unopenable additionally asserts the staged path still holds the RECORDED inode after recovery** (C3 — `ftruncate` in place, not unlink), so a second kill reads case 3 again and never case 6; case 4 re-attempts under a fresh authority id | Replace the in-place truncate with an unlink → the second kill must demonstrably halt a workspace with nothing wrong |
| **G3** | An `L` published in the window **between step 6's sibling fsync and step 7's rename** — driven by the same deterministic seam, not by sleeping | Refuse `legacy-present`; **rename nothing**; `L` byte-identical; intent retired; own artifacts removed | With the check moved back before step 6 (r3's ordering), the same fixture must demonstrably overwrite `L` |
| **G4** | Kill after step 7's rename, before the `.rbox` fsync | §2.5 case 1: an intent survives with `Q` present. **A restarted daemon's write is refused** with `authority-recovery-pending`; recovery fsyncs, retires the intent, and writes then flow | Fence condition removed → the write lands |
| **G5** | A **complete genesis DB copied from another workspace** placed at the active path, no intent | 163's ambiguous row: **halt, zero writes, no `Q` published** | With r3's `origin_kind`-keyed rule, the same fixture publishes `Q` from the copy's authority id — the capability expansion this fixture exists to prevent |
| **G6** | A leftover zero-byte staged file, or a `Q` sibling, at a path scoped to a **different authority id**; and a well-formed intent whose bound evidence differs from the live evidence (case 7) | Never deleted, never adopted, no `Q` published; reported by doctor as an inert artifact. **U3 grants no deletion authority over any of them** | — |

F5/F6 assert **silence**; G5 asserts a **refusal**. One comment line each says so.

**Widen the comparisons (r6).** `Q` byte-identical (F2) and `L` byte-identical
(G3) survive literally but are too narrow: a stray `-wal`/`-shm` beside an
untouched `Q` passes both. Every such fixture compares the **whole `.rbox`
tree, sidecars included**. 5C additionally extends that snapshot to every
genesis refusal, every migration halt, and every doctor inspection, and carries
a **negative control in which a read-only open of the inspected database must
fail the snapshot** — that control is what would have caught this defect.

### 7.2 Crash/disk-full/resume coverage

Every row of §5.2, §5.3, and §2.5 is a test. 163:3267's full injection list, plus:

- **M2's recorded-identity branch** and **M3's four claim observations**
  (absent / create-ahead adopt / incomplete rebuild / completion-ahead), each
  with every owned sidecar subset.
- **M3's interstitial CAS**: kill before, during, and after the same-phase M2
  publication; assert a claimed-but-unpublished file is never opened by SQLite.
- **M7's normative order**: publish → sibling → control; the control can never be
  retired before M7 is published; **no prepared sibling survives terminal control
  unlink**.
- **Final-runway faults after `b+4`**: item present/absent at ready M6; direct-M7
  promotion; caught-failure promotion to the prepared halt; kill and power cut at
  **both** promotions and both parent fsyncs; promoted-halt retry with the item
  present and absent; repeated failure before retry promotion. **No retry creates
  a new pair.**
- **Role 7's byte-exact 128-byte reserve-header reread**; mismatch is a zero-write
  corruption halt.
- **Failed halt publication is the trace's final mutation**: inject a publication
  failure at each halt site and assert no subsequent write.
- **The write fence**: `M5 + Q` and an unretired genesis intent both refuse;
  `cleanup-deferred` writes.
- **Genesis**: kill at each of the seven steps; the intent publication itself;
  both renames; both parent fsyncs; and an injected `ENOSPC` at the intent write
  (which leaves an unowned zero-byte staged file and nothing else).

Reuse U2's `crash-rig-child.ts` / `crash-rig-model.ts` / `trace-fs.ts`.

### 7.3 Abort — phase-specific differential

Pre-`Q`: `rbox doctor --abort-state-migration` runs C1 to completion, unlinks the
control last, leaves exact `L` authoritative. Post-`Q`: re-adoption only.

| Abort from | Expected residue beyond the pre-migration tree |
|---|---|
| **M0** (before the M1 claim) | No backup history, no fixed `.bak`. **The B0 reserve survives** — unclaimed |
| **M1** | The reserve is claimed, is a vector item, and is **retired (absent)**; so is the emergency candidate |
| **M2–M5** | As M1, **plus** the immutable `legacy-json/<body-sha>.json` entry and the fixed `pre-163-latest.json.bak`, both preamble-prefixed, never deleted on failure |

### 7.4 Import fidelity

`legacyStateSemanticDigest(normalizeLegacyStateV1(source))` equals
`stateSemanticDigest(staging)` on corpus-112k and every differential fixture;
canonical reconstructed manifest hash independently checked when meta is present;
min/max `RepoRecord` codec admission; `resolutionIntent` strip-before-digest; the
DDL-column ↔ `keyof RepoRecord` bijection minus the one named strip member;
exact-512-MiB admitted, >512 MiB refused; the source-shape presence bits round
trip for both `origin_kind` values through the one shared builder.

### 7.5 No-regression gate

100 samples after 10 warmups, void-on-untrusted, **pre-flip and post-flip on the
same host, same build, same corpus**. RSS is a **workload-paired interval**: a
fixed scripted workload (3 full sync cycles over corpus-112k after one warm
cycle), RSS at 1 Hz, gate `post_p95 <= pre_p95 * 1.05`. Falsifiable without the
frozen machine profile, which stays a U5 blocker. Reference absolutes for context
only: `status` p50 ≤ 200 ms, p95 ≤ 400 ms, daemon RSS ≤ 1.5 GB — a regression
inside them still blocks. **Migration duration: M0–M7 ≤ 60 s on corpus-112k**;
any phase over 5 s prints progress.

### 7.6 Dual-binary differential rig

Per-device staging and mounting exist. Remaining: (1) a scenario assertion that
the two devices report **different `rbox --version` strings**; (2) fetching the
**published signed `1.11.0` artifact** and verifying digest and detached
signature, digest pinned in the scenario. Never a local build.

Scenario: one workspace, one candidate host and one 1.11.0 host, pull/push
interleaved with an ignore-rule change, a tracked-repo change, and a
mass-delete-shaped change. No spurious delete, lost deferral, or divergent
manifest. Plus the same-corpus manifest diff. The flip is **not exempt**.

### 7.7 First fleet checkpoint

Genesis on a throwaway workspace, 2.0 dev build, throwaway accounts. **Wave 5
milestone** (§2.7) — it needs the coordinator, an entry point, and A-2.

### 7.8 The B0 enablement gate — all five conditions

Before U3 may be **enabled**: (1) `1.11.0` on the **stable channel**; (2) adopted
by **all 4 external users and all 3 fleet hosts** per the `rbox-admin` version
view; (3) **baked ≥ 2 weeks** with **zero barrier-related incidents**; (4)
**F1–F6 pass** including both negative controls and F5's companion; (5) the
pre-`1.11.0` population **demonstrably drained**. Conditions 1–3 and 5 must be
dated and re-checked before the 2.0 tag.

### 7.9 Structural / inventory gates

- `loadState()` production call sites counted; may only decrease; zero by U4f.
- `authority.ts` imports no `node:fs`, `node:crypto`, `bun:sqlite`.
- `classifier.ts` performs no writes, and **contains no genesis row**.
- **`genesis.ts` imports nothing from `migration/`; `migration/**` imports
  nothing from `genesis.ts`; exactly one module imports both** — the coordinator.
  `whole-state-compat.ts` imports `assertAuthorityWritable` from the coordinator
  and nothing else from either domain.
- Exactly two entry call sites of `establishStateAuthority`, plus one doctor
  authorization site. **Executable and asserted at TWO since wave 5B**, with
  three conjuncts rather than one, because a list of admitted files alone would
  have passed for a single site and a count of one: the files are exactly
  `state-plane-cmd.ts` and `upgrade-state-window.ts`; each calls it **once**; and
  each `EntryPoint` literal is CONSTRUCTED in exactly one production module, so
  the union stays a fact rather than a label. The doctor authorization site is
  pinned the same way — `retryHaltedMigration` has exactly one production
  caller, because a second one is a second repair path.
- **`as`-casts to `HeldStatePlaneLocks` occur only in `locks.ts`** (production
  `src/**`; test files are the enumerated exception, since adversarial
  construction is what they are for). The bundle is the proof object every
  mutator trusts without re-verifying — `control-publication.ts` takes it and
  does `void locks` — so its unforgeability rests on the brand alone. A cast
  anywhere else reaches an admitted migration with no lock held. **Executable**
  in `locks.test.ts`, not prose: an unenforced structural claim is how the
  brand quietly stops being load-bearing.
- The canonical control file is written only by `control-publication.ts`,
  including both prepared-sibling promotions, which share one private primitive.
- The genesis intent is written only by `genesis.ts`; `readGenesisIntent` is its
  only exported reader and A-2 its only production consumer. It stores no path,
  and `genesis.ts` never unlinks a path read from it — only paths derived from
  `authorityId` whose identity it independently confirmed.
- No production `StateSavePacket` carries `authority.kind === "migration"`.
- `legacy-writer-live` and paired-interval sampling appear nowhere in `src/`.
- Every file ≤400 lines / 25 KiB; 301–399 carries a review note.
- `docs/CODEMAP.md` gains one ownership line per new module in the same change.

### 7.10 Wave 5C — the fault primitive, and what it changed (LANDED)

**The rule 5C was created to enforce.** Across eight lanes the most-repeated
defect class was a fixture encoding a state the machine cannot produce: 3A's M4
halt written off as "fixture territory" when no corpus could pass it; 4A's row
test passing only because its fixture recorded a Q-sibling disposition no crash
produces; 5B's `format-too-new` fixture encoding the wrong verdict, and its
post-flip abort test passing for the wrong reason. Each was self-consistent and
wrong. **5C plants nothing.** Every state it asserts against is produced by
driving the real machine to a real instant and ending it there.

**The primitive** (`migration/fault-rig.ts`). Every migration and genesis module
uses `import fs from "node:fs"` and calls through the namespace object, so the
property is resolved at call time and one assignment reaches all of them. A
fault point is `{syscall, match, nth, when}` and an action is `kill`, `errno`,
`short-write`, or `side-effect`. It is not a fake filesystem: every untargeted
call, and every `when: "after"` targeted call, performs the real syscall.
`fault-rig-child.ts` is the spawnable half, because SIGKILL only means something
in a process the test does not need back; **it exits 65 when its point is never
reached**, so an unreachable kill point reads as a failure rather than a pass.

**The matrix is derived, not authored.** `scripts/probe/u3-5c-trace.ts` makes the
machine report its own `node:fs` mutations per phase. The kill points below are
that output, not a reading of this document — which is the same discipline
applied to the test design itself:

| Window | The physical effect the machine actually performs |
|---|---|
| every phase | `rename migration-v1.json.<id>.<rev>.tmp -> migration-v1.json` |
| M1 | the body-sha backup and the fixed `pre-163-latest.json.bak` renames |
| M4 -> M5 | `rename state.db.migrate.<id> -> state.db` |
| M5 -> M6 | `rename state.json.migrate.<id>.q -> state.json` — the flip |
| M6 | `unlink reserve-1mib.bin`, `unlink migration-emergency.<id>.bin` |
| M7 | `unlink` the prepared sibling, then `unlink` the control |

The first thing the probe caught was one of 5C's own fixtures: a manifest built
with `hash` instead of `sha256` and no `type` halted at `verification`, and the
machine refused it rather than importing it. A hand-planted corpus would have
encoded that halt as expected behaviour.

### 7.11 FINDING — `filesystem-full` is unreachable for an ordinary control publication

`isOutOfSpace` in `control-publication.ts` guards only the **halt** publication's
runway, through `haltRunway`. An `ENOSPC`/`EDQUOT` during an **ordinary** control
publication is classified by nothing: it unwinds past `step`'s two typed catches
(`MigrationPhaseHaltError`, `MigrationControlError`), out of `runMigration`, and
out of `state-plane-cmd.ts`'s `inWindow` — whose own comment says the "no bare
throws to the CLI" rule exists to prevent exactly this. §5.2 lists
`filesystem-full` as a reachable halt for M1–M5 and §6.3 writes copy for it, but
no code path can produce that halt for the publication itself before M6 prepares
a runway.

**Severity: copy and typed-outcome, not corruption.** The behaviour is still
fail-closed — the prepared sibling is removed, the canonical control is
untouched, and re-entry re-classifies at the previous phase and converges. The
user gets a stack trace instead of the sentence §6.3 already wrote. Pinned by
`guard-coverage.test.ts`'s `FINDING:` test, which asserts the behaviour that
EXISTS and must be **inverted, not deleted**, when the gap is closed.

### 7.12 The standing mutation gate (§7.9, executable)

Eight review rounds found "correct guard, no test that notices its deletion" one
at a time, by hand. `scripts/mutation-gate.ts` makes it a gate: a **curated**
table of load-bearing guards, each naming an exact source anchor and the one test
that must fail when the guard is removed. Deliberately not exhaustive AST
mutation — that costs minutes and yields mostly equivalent mutants, which is how
mutation testing usually dies. Three properties make it a gate:

1. **The anchor must match exactly once** — zero means the guard moved or was
   deleted, two means the anchor is ambiguous. Same self-expiry as the duplicate
   and file-size gates; a row cannot outlive what it excuses.
2. **The baseline must pass before the mutant is judged.** A test that cannot run
   in the sandbox would otherwise "fail" under mutation for the wrong reason and
   report a healthy guard — the gate reproducing its own bug. Baseline failure is
   a BROKEN row, never a surviving guard.
3. **A surviving mutant fails loudly**, naming guard, file, and the test that was
   supposed to notice.

`src/` is copied once into `.cache/mutation-gate` and mutated there, so the
working tree is never touched. Runs in ~4 s; wired as `bun run gate:mutation` in
the `checks` CI leg.

**On its first run, three of five guards SURVIVED** — `runway-enospc-predicate`,
`phase-receipt-phase-match`, and `source-rebracket` were all deletable with the
suite green. `guard-coverage.test.ts` was written to close them, and the gate is
green at five of five. Two lessons are worth keeping: a mutation whose anchor
covers only the first line of a multi-line condition does **not** remove the
guard (`source-rebracket` first appeared covered for that reason), and a guard
that is a second line of defence needs a test that reaches **its** window
specifically — perturbing between driver iterations proves nothing about
`bracketSource`, because the classifier catches it one layer earlier.

---

---

## 8. Sequencing and dispatch

**Gate 0.** All four sweep-4 Tier 0 gates are **CLOSED** (#571 report, #572
T0.2–T0.4, #574 T0.1 merged at `e1cd0b26`); the roadmap records the same. The
remaining gate is the `2.0` branch opening from `main`, plus B0 conditions 1–3
and 5 (§7.8) on track. **U3 is clear to dispatch.**

**One integration owner:** the 5A agent owns `docs/CODEMAP.md` and the inventory
tests; other lanes propose their one-line entries in the PR body.

### Wave 1 — the control record, the store seam, genesis (3 lanes)

| Lane | Deliverable | Routing |
|---|---|---|
| **1A** | M-1 + M-2 (one lane — M-2 depends on M-1's exact canonical schema). Codec, `C1Trigger`, `blocksSqliteWrites`, the shared `replaceCanonicalControl`, `promotePreparedControl` with pre-rename revalidation, `publishMigrationHalt`'s discriminated result, `readCanonicalControl`, **all migration + genesis path constructors into `paths.ts`**, **`StateAuthorityCorruptError` + the `authority-recovery-pending` refusal reason into `errors.ts`**, the initial `MigrationHaltCode` union + `MIGRATION_HALT_COPY`, and **collapsing `paths.ts`'s duplicate incarnation path** (`stateIncarnationPath` and `sqliteResetPaths.marker` are the same path written twice) | **opus** |
| **1B** | `store/open.ts::adoptClaimedStateStore(file, expected, install)` + A-1 `adapters/sqlite-state-save.ts` + write-path differential tests. **Lands before 1C and 3A, which both consume the adopter** | codex |
| **1C** | **Genesis** — `genesis.ts`, the five-field intent, the seven steps, the §2.5.1 finishing conjunction, §2.5.2's seven images, G1–G6, and the §2.6 rows applied to the classifier's *documentation* (not its code — the classifier has no genesis row). Depends on 1B for `adoptClaimedStateStore` | **opus** |

### Wave 2 — observation, admission, compat, coordinator (4 lanes)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **2A** | M-3 `classifier.ts` + `PhaseReceipt` + table-driven row tests + zero-write snapshots | 1A | **opus** |
| **2B** | M-4 `admission.ts` + the five conditions + `withStatePlaneLocks` + standing-reset-recovery ordering + F1 + F4 | 1A | **opus** |
| **2C** | A-2 `whole-state-compat.ts` + `CasResult` translation + the **one-call** write fence (`assertAuthorityWritable`, owned by 2D) + call-site counter | 1A, 1B, 2D | **opus** |
| **2D** | `authority-bootstrap.ts`: dispatch, the single-re-inspect rule, **`assertAuthorityWritable`**, and the boundary structural gates. **Lands before 2C**, which consumes the fence | 1A, 1C, 2A | codex |

### Wave 3 — the phase bodies (3 lanes; all consume `PhaseReceipt`)

| Lane | Deliverable | Depends on | Routing |
|---|---|---|---|
| **3A** | M-5 (M2 / four-observation M3 / M4) + `normalizeLegacyStateV1` + `legacyStateSemanticDigest` + the shared shape-flag builder + fidelity gate. **Also owns the `disk-preflight` halt**: 2B deliberately left it undecided because 163:3319 budgets it from staging/backup/WAL size estimates only this lane has, and a guessed multiplier would land a fabricated number in a durable halt record | 1A, 1B, 2A | codex |
| **3B** | M-7 `retirement.ts` + cursor tests (consumes `C1Trigger` from 1A, not Wave 4) | 1A, 2A | **opus** |
| **3C** | M-8 `cleanup.ts` (cursor + ledger + `retryPromotedHalt` + M7 in normative order) + runway fault injection | 1A, 2A | **opus** |

### Wave 4 — the flip (serial, alone)

**4A** — M-6 `finalize.ts`: M5, the Q ladder, `flipAuthority` (always a real
witness). **Unit and crash-rig coverage only**; F2/F3/F5/F6 land in Wave 5.
Depends on 1A, 2A, 2B, 3A, 3B, 3C. **opus, alone.**

### Wave 5 — assembly, ordered (serial)

| Step | Deliverable | Routing |
|---|---|---|
| **5A** | M-9 `authority.ts` — per-mutator revalidation, the four retry buckets, both entry sites (upgrade with the `finally` guarantee, `rbox migrate` + `--json`), progress UX. Integration owner | **opus** |
| **5B** | Doctor: the four buckets wired, `--abort-state-migration`, the standing-halt projection modeled on `reset-health.ts`, final copy pass | **opus** |
| **5C** | **The genesis fleet checkpoint** (§7.7 — first reachable here), then F2/F3/F5/F6, the abort differential, the no-regression harness, duration budget, rig scenario. Harness *preparation* may run in parallel from Wave 3 | codex (harness) + **opus** (fixtures) |

### The ownership rule, per lane (r6)

Carried here so unbuilt lanes inherit the fix instead of rediscovering it. Full
statement and evidence: 163 § "R4-v13 the ownership rule (v13)".

| Lane | Inheritance |
|---|---|
| **3A** | **Blocker.** M4 verification as r5 specified it is impossible. Verify on the owning read-write connection, checkpoint after |
| **5B** | Doctor must be **observation-only** on files it does not own |
| **2D** | `assertAuthorityWritable` runs on the **hot path, every SQLite save**. File-level only, never a SQLite open, so nobody optimizes it into one |
| **2C** | Selection via `classifyStateFormat` is pure-`fs` and safe; `reset/lifecycle.ts:65` `readLineage` is a live read-only open — do not adopt or resurrect it |
| **4A** | "Any sidecar halts" is a precondition of M4→M5→M6 resume; an open-based check both leaves debris and trips its own halt |
| **5A** | Per-mutator revalidation runs many times per migration; open-based revalidation multiplies debris linearly |
| **5C** | Extend the sidecar-inclusive snapshot to every genesis refusal, migration halt, and doctor inspection; add the read-only-open negative control |
| **3C** | Inertness must be a file-level judgement |
| **3B** | No DB open in spec; note only |
| **1B** | Not a victim — the **model**. The adopter removes the file *and* its sidecars on failure legally, because it owns the inode |

### Wave 6 — validation, serial

Full crash-rig sweep → `/simplify` diff-scoped → parallel review fan-out → **one
final serial review** → merge to `2.0` → dual-binary differential against signed
1.11.0 → §7.8 re-checked → tag.

---

## 9. Risks

1. **The classifier / control-schema / M6 cleanup-runway cross-product.** Top
   correctness risk. Sharpest edges: prepared-control promotion and the
   promoted-halt retry whose clear is a rename.
2. **Per-mutator revalidation.** Easy to state, easy to lose in one refactor.
   Enforced by the branded `PhaseReceipt`, not by discipline.
3. **Inode reuse around the genesis staged path.** The sharpest hazard the
   independent validation found, and the reason §2.5.1 is a conjunction rather
   than an inode test: `dev`/`ino` pairs are recycled, genesis truncates a
   recorded inode in case 3, and *migration* stages its database in the same
   directory and renames it onto the active path. Without the authority/lineage/
   completion checks a recycled inode carrying real user data could satisfy an
   inode-only match and turn a healthy workspace into a permanent
   `StateAuthorityCorruptError`. Mitigated by the conjunction and by C3's
   in-place truncate; G2's negative control keeps both honest.
4. **The genesis intent is new durable state on the authority path.** It is
   small, single-writer, and never updated mid-flight — but it is one more thing
   that can be foreign, malformed, or stranded. G5 and G6 exist to keep its
   fail-closed behavior honest. It is now normative (163 v12), so the risk is
   implementation fidelity to the ratified rows, not legitimacy.
5. **`adoptClaimedStateStore` changes a merged, load-bearing initializer** and is
   now consumed by two callers (M3 and genesis). Mitigated by one private shared
   body and crash coverage on both callers.
6. **`whole-state-compat.ts` — top performance/compatibility risk, not top safety
   risk.** If §7.5 fails: tune the page cache, pull U4's cursor conversion
   forward for `status` only, or **do not ship the flip** — the third stays on
   the table per the revert rule.
7. **F5/F6 assertion maintenance.** Not a leading implementation risk.
8. **~3,700 production lines** (2,620 migration + 393 genesis as shipped +
   90 coordinator + 600 adapters) of one-way, unrevertible-after-`Q`
   fail-closed surface.

---

## 10. Disposition of the r3 review and the §2.6 validation

| # | Finding | Disposition |
|---|---|---|
| 1 | CRITICAL — an incomplete active DB is reachable with no durable owner | **Folded by construction.** Genesis builds at an authority-id-scoped **staged** path and renames to active only after the DB is proven complete and durable (§2.4 steps 2–5). An incomplete DB at the active path is unreachable, so no rule needs to authorize deleting one. The staged file is owned by the intent's recorded `{dev,ino}`; before the intent is durable it is a zero-byte file no record names — inert, provably not a database, **reported and never deleted** (C7) |
| 2 | CRITICAL — logical completion is not physical durability | **Folded.** §2.5.2 cases 2 and 3-clean require the full recover/checkpoint/validate/close/require-`S0`/fsync sequence before approaching `Q`. r3's "derive and publish `Q`, no other action" is deleted |
| 3 | CRITICAL — the post-rename/pre-fsync image is indistinguishable from terminal | **Folded.** §2.5.2 case 1 is a distinct image with its own action, and the surviving intent is what makes it observable. A-2's write fence blocks writes while an unretired intent exists with `Q` present — the analogue of migration's `M5+Q` block. G4 tests it with a negative control |
| 4 | HIGH — the absence check is not immediately before the rename | **Folded.** The sibling is prepared and fsynced in step 6; the legacy-absence re-check is the **literal final operation** before step 7's rename. G3 now injects `L` in that exact window and carries a negative control that reproduces r3's overwrite. "Unlink any prior leftover first" is **deleted** — an attempt-scoped path is owned, a foreign one is never touched, matching the reserve protocol's distinction |
| 5 | HIGH — the module boundary is declared but not enforced | **Folded.** `genesis-candidate` and `genesis-finish-ahead` are removed from `migration/classifier.ts`; the genesis outcome and dispatch are removed from `migration/authority.ts`; a 90-line coordinator outside both domains (§1.3) classifies and routes. Structural gates in §7.9 assert neither domain imports the other and exactly one module imports both. **The "Wave 1B ships first" claim is deleted** — the checkpoint moves to Wave 5C (§2.7, §7.7) because it needs the coordinator, an entry point, and A-2 |
| §2.5 amendment | Not sufficient or safe | **Withdrawn in full and replaced.** §2.6 keys the new rows on the durable, provenance-bound genesis intent instead of on `origin_kind`. G5 is the fixture that pins the difference: a genesis DB copied from another workspace must **halt**, and under r3's rule it would have published `Q` |
| 163 "staged DB + Q" | Direct construction is a second interpretation needing ratification | **Withdrawn.** §2.4 stages and renames, honoring 163:2603/3772 literally. One fewer thing to ratify |
| r2-1 partial | The adopter does not take the expected inode; completion-ahead has no path through the claim API | **Folded.** `adoptClaimedStateStore(file, expected: ClaimedInode, install)` takes the identity as a parameter; `StagingMainClaim` is a discriminated result with **four** observations, `completed` among them, and M-9 skips the import on that variant |
| r2-2, 3, 4, 7, 8, 9, 11 | Judged faithfully folded | Unchanged |
| `GenesisOutcome` codes vs copy table | Only `legacy-present` had copy | **Folded.** `artifact-present` and `evidence-missing` now have full human + machine entries (§6.1) |
| Stale prerequisite section | `origin/main` is `e1cd0b26`; #574 merged | **Folded.** Rebased. §0.2's blocker and Gate 0's T0.1 condition are **deleted**; §0.1 records the merge and what it provides. Verified: `gh pr view 574` → `MERGED`, and `migration/base-proof.ts`, `migration/import-stage.ts`, `withMigrationImporter` are all present |
| "§2.5 is the only normative divergence" | Overclaimed | **Deleted.** §2.6 now enumerates precisely what changes and what does not, and the staged-DB reading removes the second divergence rather than asserting it away |

### Disposition of the independent §2.6 validation (RATIFY-WITH-CORRECTIONS, 9 items)

Founder steer applied throughout: the copy-from-another-workspace scenarios are
low-odds and the validation agrees copy is blocked, stale replay self-heals,
races are locked out, and a same-user attacker is no worse than 163's conceded
baseline. **The mechanism is made accident-proof, not attacker-proof.** Where a
correction bought only attacker-resistance, the smaller record won.

| # | Correction | Disposition |
|---|---|---|
| **C1** | Both new rows underspecify "an exact genesis intent" | **Folded.** Both rows now read "whose bound fenced evidence equals this workspace's current fenced evidence, and which records that exact `{dev,ino}` identity"; row 2 adds the authority-id equality against both the database and the `Q` bytes |
| **C2** | **The real hazard — `dev`/`ino` reuse.** Case 3 truncates the recorded inode while the intent still names it, and migration stages in the same directory and renames onto the active path, so a recycled inode can land at `state.db` holding real user data → case 2 fires → `Q` published from `intent.authorityId` → permanent `StateAuthorityCorruptError` | **Folded completely** (§2.5.1). The finishing predicate is a conjunction: recorded `{dev,ino}`, `validateOpen`, `store_meta.authority_id === intent.authorityId`, `store_meta.active_lineage_id === intent.lineageId`, a `migration_completion` singleton with `origin_kind='genesis'`, `migration_id === 'genesis:' + lineageId`, and `entry_count = repo_count = 0`. §2.5.1 and §2.6 both state explicitly that **every one of those values is written by the already-merged `installGenesisLineage` from values the intent published to disk before the database existed** — so no reviewer mistakes it for the withdrawn self-assertion proposal |
| **C3** | Case 3's own remedy broke the no-stage-field claim: unlinking the recorded inode makes the next crash read case 6 and halt a healthy workspace | **Folded, preferred fix taken.** `ftruncate` the recorded inode to **zero in place** (preserving the inode), remove only its `-wal`/`-shm`/`-journal` sidecars, rebuild from step 4 through the same adopter — whose precondition is exactly a zero-byte claimed file. G2 now asserts the staged path still holds the recorded inode after recovery, with a negative control that reproduces the false halt |
| **C4** | Derive the staged path; do not store a path string | **Folded as a simplification** (§2.3.1). Both paths derive from `authorityId`; the record stores no path; `genesis.ts` never unlinks a path read from the record. Removes a field *and* a delete-authorized input |
| **C5** | `FencedEvidence` was undefined while carrying the copy-detection argument | **Folded minimally** per the steer (§2.3.2): absolute workspace root, stream id, incarnation-marker identity or `"absent"`. Nothing more. Case 7 added: well-formed intent, evidence ≠ live evidence → zero-write halt, delete nothing |
| **C6** | Citation `v1.ts:27` → `:29` | **Folded** in §2.2 and §2.6. Verified: `origin_kind … CHECK(origin_kind IN ('migration','genesis'))` is line 29 |
| **C7** | "doctor-sweepable" grants deletion authority the design does not want | **Folded.** Deleted from §2.4 step 2 (now "reported, not swept"). The NOT-changing list gains "**doctor gains no new deletion authority**", and a new "what this does add" list discloses the write fence's new condition and the three refusal codes |
| **C8** | **Real UX bug** — after case-5 retirement, `rbox migrate` returns `legacy-present` and does nothing while §6.1 tells the user to run `rbox migrate` | **Folded** (§1.3). On `legacy-present` **only**, the coordinator re-inspects once and dispatches to migration in the same pass under the same held locks. Exactly one re-inspect; a second `legacy-present` is unreachable and would be a corruption halt |
| **C9** | Case 3's test was unreachable — `installGenesisLineage` writes everything in one transaction | **Folded.** Reworded to "does not open cleanly through `validateOpen` as a genesis store bound to this intent", with the reachable failure named (partial or unopenable file) |
| — | Disclose that step 4 needs `adoptClaimedStateStore`, not on `main` | **Folded into §2.6 itself**, in the new "what this does add" list: the merged `initializeStateStore` opens `"wx"` and rejects an existing path (`store/open.ts:218`), so **the amendment is not implementable against today's `main`** — ratifying it authorizes the design, not an immediate landing. It is a Wave 1B deliverable that migration's M3 also needs |
| — | The trim question | **Answered in the doc** (§2.3.3), field by field, with the drop rationale. Six fields become five: `attemptId` and `staging.path` are gone; `version`, `authorityId`, `lineageId`, `evidence`, `staging{dev,ino}` survive. `lineageId` is flagged honestly as the one belt-and-braces field a reviewer could cut without weakening the accident story |

### Disposition of the final review (verdict GO — four doc-level corrections)

None touches 163 v12's ratified row text; both v12 rows remain byte-identical.

| # | Correction | Disposition |
|---|---|---|
| **1** (lane 1C, highest value) | The intent must be the sole source of `authorityId`/`lineageId` on every resume. As written, `establish(root, lineage, locks)` took a caller lineage while cases 2/3 rebuild "from step 4", whose `install` closes over it — so a coordinator minting a fresh lineage per invocation (the natural reading of that signature) installs ids that can never satisfy §2.5.1, and a **healthy** workspace live-locks into a permanent halt | **Folded, and carried by the signature, not just prose.** `establish(root, mintLineage: () => GenesisLineage, locks)` calls the thunk at most once and only with no intent to resume; a private `resume(root, intent, locks)` takes the intent and no lineage; step 4 installs `lineageFrom(intent)`. §2.4 states the rule in bold with the live-lock consequence spelled out, and an inventory test asserts `installGenesisLineage`'s only genesis caller derives its argument from an intent |
| **2** (lane 1C) | §2.5.1 must evaluate through the read-only preflight; case 7 must precede case 5; cases 6–7 must raise `StateAuthorityCorruptError` | **SUPERSEDED IN PART (r6) — do not re-derive this.** The first of the three is **false**: a read-only open is not zero-write (163 v13's evidence), so the preflight prescription is withdrawn and replaced by the ownership rule; the other two stand. Original r5 disposition, for the record: **Folded, all three.** §2.5.1 evaluates through `openStateStore`'s `readonly: true` preflight (`store/open.ts:249-262`, which exists precisely so a foreign SQLite file is not converted to WAL merely by being inspected) — otherwise a "zero-write halt" rule performs a write via WAL replay. §2.5.2 states the ordering and why (case 5 keys on `L` and does not reference §2.5.1, so it does not inherit the evidence check; without the ordering a copied `.rbox` would take case 5's cleanup path and delete another workspace's artifacts). Cases 6 and 7 now raise `StateAuthorityCorruptError`, which **deletes the genesis halt taxonomy before it is born**: no `MigrationHaltCode` member, no `MIGRATION_HALT_COPY` entry, no new copy — §6.4 already covers it — and it resolves the contradiction an unnamed "halt" created with §5.3 and 163:2612. The three genesis **refusals** are unaffected; they fire at step 1, before any mutation |
| **3** (lanes 2C + 2D) | Collapse A-2's two-read fence into one exported `assertAuthorityWritable(root)` in the coordinator | **Folded.** One call replaces a duplicated branch, halves the hot-path reads, and fixes a **real §7.9 boundary violation**: as written, `whole-state-compat.ts` imported from both `migration/` and `genesis.ts`, so "exactly one module imports both" was false and lanes 2C/2D would have collided over ownership. 2D now owns the predicate and **lands before 2C** |
| **4** (163 editorial) | Qualify 163:2613 and widen `C` at 163:2589 | **Folded.** `absent \| absent \| absent` becomes `absent \| absent \| absent, and no genesis intent`, so it cannot overlap the v12 in-progress row under first-match reading; `C`'s definition now reads "evidence for the record that owns it — the migration control ordinarily, or the genesis intent on the two v12 intent-keyed rows". Both are surrounding definitions, **not** the amendment; the two v12 row texts are untouched |
| — | `entry_count = repo_count = 0` and `lineageId` are tautological / defense-in-depth | **Recorded, not changed** (§2.5.1). Both are in the ratified row text; cutting either costs a re-ratification for zero safety. They are now explicitly named non-load-bearing so nobody later mistakes them for the reason the conjunction is sound — `authorityId`, the identity, and the evidence are |
| — | `paths.ts` declares the incarnation path twice | **Folded into lane 1A's PR** — `stateIncarnationPath` and `sqliteResetPaths.marker` are the same path written twice |

### Deletions r3 asked for, all taken

The `origin_kind`-only finish-ahead row; automatic deletion or rewrite of an
unowned incomplete DB or leftover `Q` sibling; genesis variants in
`migration/classifier.ts`, `migration/authority.ts`, and `MigrationOutcome`; the
Wave 1B fleet-checkpoint claim; the stale #574 prerequisite section; and the
exclusivity assertion about §2.5.

### No disagreement this round

Every r3 finding was verified against the checkout before folding.
`initializeStateStore`'s `"wx"` and catch-only cleanup, `validateOpen`'s scope,
`v1.ts:29`'s `CHECK`, `installGenesisLineage`'s completion insert,
`withRepositoryRecoveryFence`'s callback shape, `upgrade-cmd.ts`'s single `try`,
and #574's merge all check out as codex describes them.
