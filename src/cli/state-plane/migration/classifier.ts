/**
 * One admitted migration observation row, mutating nothing (design 222 §M-3,
 * design 163's M0 authority matrix at :2597).
 *
 * The classifier decides which row of that matrix this workspace is on and hands
 * the mutators a phase-bound receipt. It creates, renames, unlinks, and truncates
 * nothing, on every row including every corruption row.
 *
 * It reaches a database exactly one way, and which way turns on the flip. Before
 * it, the database is frozen and the control's physical witness settles identity
 * without opening anything — a read-only SQLite open is not free, it creates
 * `-wal`/`-shm` and leaves them. After it, the store has been in ordinary use and
 * that witness is stale, so identity comes from the durable rows through
 * `active-store-proof.ts`, the one sanctioned opener.
 *
 * Two orderings inside `classifyMigrationState` are load-bearing and are not
 * merely stylistic. The control is read BEFORE the switch on legacy authority, so
 * any `ENOTDIR` under `.rbox/state` — a regular file where the directory must be
 * — halts as a foreign control rather than reaching `authority-marker.ts`, whose
 * `ENOTDIR` is still read as absence. And under JSON authority the artifact
 * pairing is checked before the halt is reported, because a halt excuses no
 * artifact mismatch (163:2622).
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

/** `locks` is a compile-time witness that the complete lock set is held. It has
 * no runtime use HERE — every observation is a single no-follow descriptor — but
 * it is what makes the reads mutually consistent across paths, so a later wave's
 * mutators can act on this row without re-observing. */
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
 * Which predicate proves the database is ours turns on ONE question: could the
 * bytes have changed since `witness.active` was recorded? That witness is fixed at
 * M5 and never refreshed, so the answer is "no" for exactly as long as the write
 * fence has been up — which is every phase below M6, on BOTH sides of the rename.
 *
 * - **`M5`, which on this branch is always post-rename** — the frozen window. `Q`
 *   is live, so the flip's rename has landed; but the phase is still M5, so
 *   `blocksSqliteWrites` has been TRUE since before it and nothing may have
 *   written the store. The control's physical `{bytes, sha256}` is therefore exact
 *   and is stronger than the database's self-description. A sidecar here is itself
 *   an anomaly, because a `-wal` beside a byte-identical main can carry a
 *   different `authority_id`. (The pre-rename side of the same window is under
 *   legacy JSON authority and is handled by `underJsonAuthority` above.)
 * - **`M6` and `M7`, unconditionally** — the live window. The store has been in
 *   ordinary use since the flip and its bytes change on every save, so identity
 *   comes from the durable rows (`active-store-proof.ts`).
 *
 * Not `blocksSqliteWrites`. That answers "may anything write *now*", which is a
 * different question: a `durability-indeterminate` halt published after the live
 * window has already taken a save makes the fence true again while the M5 witness
 * stays stale, and comparing against it would turn a recoverable durability scare
 * into a never-retryable corruption error. Design 163 v13 enumerates these
 * windows by row, and the row list — not the fence — is what this follows.
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
  if (witness.phase === "M5") {
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
    // The sibling BECAME `Q`: the flip renames it over `.rbox/state.json`, so the
    // durable M5 witness still records it `exact` while the path is empty. This
    // is a plain absence test, NOT `observeQSibling` — that reads the recorded
    // `exact` inode against an absent path and calls the only crash image the
    // flip can leave foreign, turning the whole `M5 + Q` row into corruption.
    if (witness.qSibling.disposition.state !== "exact") {
      return corruption(`the authority marker is published from a Q sibling recorded ${witness.qSibling.disposition.state}`);
    }
    if (observePath(witness.qSibling.path).state !== "absent") {
      return corruption("the Q sibling survived the authority rename");
    }
    return { row: "m5-artifact-ahead-q", receipt };
  }
  return witness.phase === "M6"
    ? { row: "m6-cleanup", receipt, cursor: witness.cleanup }
    : { row: "m7", receipt };
}
