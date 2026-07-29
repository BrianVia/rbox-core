/**
 * One admitted migration observation row, mutating nothing (design 222 §M-3,
 * design 163's M0 authority matrix at :2597).
 *
 * The classifier decides which row of that matrix this workspace is on and hands
 * the mutators a phase-bound receipt. It performs no write of any kind: no
 * create, no rename, no unlink, and no SQLite open — a read-only open of a WAL
 * database leaves `-wal`/`-shm` behind, so a database is matched against the
 * physical bytes the durable control already proved for it.
 *
 * No genesis rows. The coordinator rules genesis out before this module is
 * reached (design 222 §1.3, FINDING 5).
 */
import { MigrationControlError, StateAuthorityCorruptError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { sqliteResetPaths } from "../paths.js";
import {
  isForeign, observeLegacyAuthority, observePath, observeQSibling, observeStagingMain,
  type PathObservation, type QSiblingObservation, type StagingMainObservation,
} from "./artifact-observation.js";
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

declare const observed: unique symbol;

/**
 * Typed, phase-bound evidence carrying the exact control — and therefore the
 * exact revision — it was observed from. Minted only here, so a mutator can be
 * handed one only by an observation, never by a caller holding a raw
 * `MigrationControl` it did not just re-read.
 */
export interface PhaseReceipt {
  readonly [observed]: true;
  readonly phase: MigrationPhase;
  readonly control: MigrationControl;
}

const receiptFor = (control: MigrationControl): PhaseReceipt =>
  ({ phase: control.witness.phase, control } as unknown as PhaseReceipt);

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
  const active = observePath(sqliteResetPaths.active(root));
  switch (legacy.kind) {
    case "json": return underJsonAuthority(legacy.witness, control, active);
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
  source: SourceWitness, control: MigrationControl | undefined, active: PathObservation,
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
  const mismatch = activeMismatchUnderJson(control, active);
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
 */
function activeMismatchUnderJson(control: MigrationControl, active: PathObservation): string | undefined {
  const witness = control.witness;
  const absent = active.state === "absent";
  switch (witness.phase) {
    case "M0": case "M1": case "M2": case "M3":
      return absent ? undefined : "a state database exists before the migration built one";
    case "M4":
      return absent || matchesProof(active, witness.staging) ? undefined
        : "the state database is not the staging database this migration proved";
    case "M5":
      return matchesProof(active, witness.active) ? undefined
        : "the state database is not the one this migration published";
    default:
      return `the migration control records ${witness.phase}, but legacy sync records are still authority`;
  }
}

/** Length first, so the steady state never hashes a database it can reject. */
function matchesProof(active: PathObservation, proof: StagingProof): boolean {
  if (active.state !== "regular" || active.bytes !== proof.bytes) return false;
  const digested = observePath(active.file, true);
  return digested.state === "regular" && digested.dev === active.dev
    && digested.ino === active.ino && digested.sha256 === proof.sha256;
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
 * The database's identity is proved from the control's own physical witness where
 * there is a control, and from the file's presence where the migration already
 * retired. Reading `store_meta.authority_id` instead would need a SQLite open,
 * which is not a read (see `artifact-observation.ts`).
 */
function underAuthorityMarker(
  legacy: { readonly file: string; readonly authorityId: string },
  control: MigrationControl | undefined,
  active: PathObservation,
): MigrationObservation {
  if (active.state !== "regular" || active.bytes === 0) {
    throw new StateAuthorityCorruptError(legacy.file, "the state database is absent or unreadable");
  }
  if (!control) return { row: "terminal-sqlite" };
  if (control.authorityId !== legacy.authorityId) {
    throw new StateAuthorityCorruptError(legacy.file, "the authority marker and the migration control name different authorities");
  }
  if (control.retirement) return corruption("a source-change retirement cannot survive the authority flip");
  const witness = control.witness;
  if (witness.phase !== "M5" && witness.phase !== "M6" && witness.phase !== "M7") {
    return corruption(`the authority marker is published but the migration control records ${witness.phase}`);
  }
  if (!matchesProof(active, witness.active)) {
    throw new StateAuthorityCorruptError(legacy.file, "the state database is not the one this migration published");
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
