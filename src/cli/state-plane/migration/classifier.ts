/**
 * One admitted migration observation row, mutating nothing (design 222 §M-3,
 * design 163's M0 authority matrix at :2597).
 *
 * The classifier decides which row of that matrix this workspace is on and hands
 * the mutators a phase-bound receipt. It creates, renames, unlinks, and truncates
 * nothing, on every row including every corruption row.
 *
 * It reaches a database exactly one way. While the migration write fence holds,
 * the database is frozen and the control's physical witness settles its identity
 * without opening anything — a read-only SQLite open is not free, it creates
 * `-wal`/`-shm` and leaves them. Once the fence lifts the store is in ordinary
 * use, physical bytes go stale on the first save, and identity comes from the
 * durable rows through `active-store-proof.ts`, the one sanctioned opener.
 *
 * No genesis rows. The coordinator rules genesis out before this module is
 * reached (design 222 §1.3, FINDING 5).
 */
import { MigrationControlError, StateAuthorityCorruptError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { sqliteResetPaths } from "../paths.js";
import { proveActiveStore } from "./active-store-proof.js";
import {
  isForeign, observeLegacyAuthority, observePath, observeQSibling, observeSidecars, observeStagingMain,
  type PathObservation, type QSiblingObservation, type StagingMainObservation,
} from "./artifact-observation.js";
import { blocksSqliteWrites } from "./control-codec.js";
import type {
  C1Trigger, Cursor, MigrationControl, MigrationPhase, SourceWitness, StagingProof,
} from "./control-codec.js";
import { readCanonicalControl } from "./control-publication.js";
import type { MigrationHalt } from "./health.js";

export type MigrationObservation =
  /** JSON authority, eligible for M0. */
  | { readonly row: "no-control-json" }
  | { readonly row: "m0-resume" | "m1-resume" | "m3-resume" | "m4-resume"; readonly receipt: PhaseReceipt }
  | { readonly row: "m2-resume"; readonly receipt: PhaseReceipt; readonly staging: StagingMainObservation }
  | { readonly row: "m5-resume"; readonly receipt: PhaseReceipt; readonly sibling: QSiblingObservation }
  | { readonly row: "source-changed"; readonly receipt: PhaseReceipt; readonly trigger: C1Trigger }
  | { readonly row: "retirement-cursor"; readonly receipt: PhaseReceipt; readonly cursor: Cursor }
  /** SQLite elected, writes blocked: the rename landed, M6 did not publish. */
  | { readonly row: "m5-artifact-ahead-q"; readonly receipt: PhaseReceipt }
  | { readonly row: "m6-cleanup"; readonly receipt: PhaseReceipt; readonly cursor: Cursor }
  | { readonly row: "m7"; readonly receipt: PhaseReceipt }
  | { readonly row: "terminal-sqlite" }
  | { readonly row: "halted"; readonly receipt: PhaseReceipt; readonly halt: MigrationHalt }
  | { readonly row: "corruption"; readonly halt: MigrationHalt };

/**
 * Typed, phase-bound evidence carrying the exact control — and therefore the
 * exact revision — it was observed from.
 *
 * A class with a private field, not a branded interface: a `unique symbol` brand
 * is type-level only, so `{...receipt, phase: "M0"}` would carry the brand while
 * losing the invariant. The private field makes every spread fail to typecheck,
 * the private constructor makes `observe` the only mint, and deriving `phase`
 * from the control makes a lying receipt unrepresentable.
 */
export class PhaseReceipt {
  readonly #observed = true;

  private constructor(readonly phase: MigrationPhase, readonly control: MigrationControl) {
    void this.#observed;
  }

  static observe(control: MigrationControl): PhaseReceipt {
    return new PhaseReceipt(control.witness.phase, control);
  }
}

const receiptFor = (control: MigrationControl): PhaseReceipt => PhaseReceipt.observe(control);

/**
 * A zero-write corruption halt. The halt taxonomy has no free-text slot and U3
 * adds no halt code, so the observed condition rides in `underlyingCode`, the one
 * member that records what actually happened.
 */
const corruption = (detail: string): MigrationObservation =>
  ({ row: "corruption", halt: { code: "reserved-path", underlyingCode: detail, required: null, available: null } });

export async function classifyMigrationState(
  root: string, locks: HeldStatePlaneLocks,
): Promise<MigrationObservation> {
  void locks;
  const legacy = await observeLegacyAuthority(root);
  let control: MigrationControl | undefined;
  try {
    control = readCanonicalControl(root);
  } catch (error) {
    if (error instanceof MigrationControlError) return corruption(`migration control ${error.reason}`);
    throw error;
  }
  const activeFile = sqliteResetPaths.active(root);
  const active = observePath(activeFile);
  switch (legacy.kind) {
    case "json": return underJsonAuthority(legacy.witness, control, activeFile, active);
    case "q": return underAuthorityMarker(legacy, control, active);
    // No authority at all, with genesis already ruled out, and a legacy path that
    // is neither legacy JSON nor the exact marker, are both manual damage
    // (163:2617, :2618). A database never elects authority by itself.
    case "absent": return corruption("neither legacy sync records nor the authority marker are present");
    case "foreign": return corruption("the sync-record path holds neither legacy records nor the authority marker");
  }
}

// ---------------------------------------------------------------------------
// JSON authority: rows 1-9 of the M0 matrix.

function underJsonAuthority(
  source: SourceWitness, control: MigrationControl | undefined,
  activeFile: string, active: PathObservation,
): MigrationObservation {
  if (!control) {
    // A complete orphan is neither adopted nor deleted (163:2606).
    if (active.state !== "absent") return corruption("a state database exists with no migration control");
    return { row: "no-control-json" };
  }
  const receipt = receiptFor(control);
  // Retirement owns its own artifact coherence: its cursor is mid-vector by
  // design, so the ordinary phase pairing below does not apply (163:2761).
  if (control.retirement) {
    return control.halt
      ? { row: "halted", receipt, halt: control.halt }
      : { row: "retirement-cursor", receipt, cursor: control.retirement.cursor };
  }
  const mismatch = activeMismatchUnderJson(activeFile, control, active);
  if (mismatch) return corruption(mismatch);
  // The halt excuses no artifact mismatch, so it is reported only after the
  // pairing above holds (163:2622).
  if (control.halt) return { row: "halted", receipt, halt: control.halt };
  if (!identicalSource(control.source, source)) {
    return { row: "source-changed", receipt, trigger: { disposition: "source-changed", replacement: source } };
  }

  const witness = control.witness;
  switch (witness.phase) {
    case "M0": return { row: "m0-resume", receipt };
    case "M1": return { row: "m1-resume", receipt };
    case "M2": {
      const staging = observeStagingMain(control.stagingPath, witness.stagingMain);
      return isForeign(staging) ? corruption(staging.foreign) : { row: "m2-resume", receipt, staging };
    }
    case "M3": return { row: "m3-resume", receipt };
    case "M4": return { row: "m4-resume", receipt };
    default: {
      const sibling = observeQSibling(witness.qSibling);
      return isForeign(sibling) ? corruption(sibling.foreign) : { row: "m5-resume", receipt, sibling };
    }
  }
}

/**
 * What the active path must hold for the control's phase. M0-M3 have not built
 * it; M4 admits the rename running one phase ahead; M5 requires it. M6 and M7
 * claim the flip already happened, which contradicts legacy JSON still being
 * authority, so no row admits them here.
 *
 * Legacy JSON is authority throughout, so nothing may be writing the database:
 * this whole branch is the frozen window, where the physical witness is exact and
 * a sidecar beside the active path is an anomaly (M4 closed and `S0`d it).
 */
function activeMismatchUnderJson(
  activeFile: string, control: MigrationControl, active: PathObservation,
): string | undefined {
  const witness = control.witness;
  const absent = active.state === "absent";
  const clean = (proof: StagingProof): string | undefined =>
    observeSidecars(activeFile).length > 0
      ? "the state database has sidecars while legacy sync records are still authority"
      : matchesProof(activeFile, proof) ? undefined : "the state database is not the one this migration proved";
  switch (witness.phase) {
    case "M0": case "M1": case "M2": case "M3":
      return absent ? undefined : "a state database exists before the migration built one";
    case "M4":
      return absent ? undefined : clean(witness.staging);
    case "M5":
      return absent ? "the state database this migration published is gone" : clean(witness.active);
    default:
      return `the migration control records ${witness.phase}, but legacy sync records are still authority`;
  }
}

/**
 * ONE descriptor, ONE comparison. An earlier draft observed twice — a cheap
 * length check, then a digesting reopen — and had to re-compare `dev`/`ino`
 * across the two to close the window it had just opened; and it compared the
 * recorded length as well as the hash, which a mutation sweep showed can never
 * disagree with it. Both are gone: the window is removed rather than defended,
 * and the hash is the whole test.
 */
function matchesProof(file: string, proof: StagingProof): boolean {
  const observed = observePath(file, true);
  return observed.state === "regular" && observed.sha256 === proof.sha256;
}

const identicalSource = (recorded: SourceWitness, live: SourceWitness): boolean =>
  recorded.dev === live.dev && recorded.ino === live.ino && recorded.bytes === live.bytes
  && recorded.mtimeNs === live.mtimeNs && recorded.sha256 === live.sha256;

// ---------------------------------------------------------------------------
// The authority marker: rows 10-15 of the M0 matrix.

/**
 * `Q` elects SQLite unconditionally, so every disagreement here is contradictory
 * durable state rather than a suspended protocol: a hard
 * `StateAuthorityCorruptError`, zero repair writes, never retryable.
 *
 * Which predicate proves the database is ours depends on whether it is FROZEN,
 * and `blocksSqliteWrites` — the same ratified fence A-2 enforces — is exactly
 * that question, so the two cannot drift apart:
 *
 * - frozen (M5, or any write-blocking halt): nothing may write the store, so the
 *   control's physical `{bytes, sha256}` is exact and is stronger than the
 *   database's self-description. A sidecar here is itself an anomaly, because a
 *   `-wal` beside a byte-identical main can carry a different `authority_id`.
 * - live (M6, M7, `cleanup-deferred`, and a retired control): the store is in
 *   ordinary use and its bytes change on every save, so identity must come from
 *   the durable rows — see `active-store-proof.ts`.
 */
function underAuthorityMarker(
  legacy: { readonly file: string; readonly authorityId: string },
  control: MigrationControl | undefined,
  active: PathObservation,
): MigrationObservation {
  if (active.state !== "regular" || active.bytes === 0) {
    throw new StateAuthorityCorruptError(legacy.file, "the state database is absent or unreadable");
  }
  if (!control) {
    proveActiveStore(legacy.file, active.file, legacy.authorityId, undefined);
    return { row: "terminal-sqlite" };
  }
  if (control.authorityId !== legacy.authorityId) {
    throw new StateAuthorityCorruptError(legacy.file, "the authority marker and the migration control name different authorities");
  }
  if (control.retirement) return corruption("a source-change retirement cannot survive the authority flip");
  const witness = control.witness;
  if (witness.phase !== "M5" && witness.phase !== "M6" && witness.phase !== "M7") {
    return corruption(`the authority marker is published but the migration control records ${witness.phase}`);
  }
  if (blocksSqliteWrites(control)) {
    if (observeSidecars(active.file).length > 0) {
      throw new StateAuthorityCorruptError(legacy.file, "the state database has uncheckpointed sidecars while writes are fenced");
    }
    if (!matchesProof(active.file, witness.active)) {
      throw new StateAuthorityCorruptError(legacy.file, "the state database is not the one this migration published");
    }
  } else {
    proveActiveStore(legacy.file, active.file, legacy.authorityId, control.migrationId);
  }
  const receipt = receiptFor(control);
  if (control.halt) return { row: "halted", receipt, halt: control.halt };
  if (witness.phase === "M5") {
    const sibling = observeQSibling(witness.qSibling);
    return isForeign(sibling) || sibling.state !== "absent"
      ? corruption("the Q sibling survived the authority rename")
      : { row: "m5-artifact-ahead-q", receipt };
  }
  return witness.phase === "M6"
    ? { row: "m6-cleanup", receipt, cursor: witness.cleanup }
    : { row: "m7", receipt };
}
