/**
 * Migration halt taxonomy (design 163 §U3, R4-ROLLOUT M5).
 *
 * U3 introduces roughly fifteen fail-closed halt classes, each of which stops
 * sync and each of which must ship with plain-English AND machine-readable
 * doctor copy. This module is the CLOSED contract those halts are drawn from:
 * `MigrationHaltCode` is the exhaustive union, and `MigrationHealth` is the
 * result a state-plane migration probe reports.
 *
 * It is deliberately a TYPE SKELETON. U3 replaces the empty union with the
 * concrete codes; this file gains no runtime logic and no filesystem or SQLite
 * access. The exhaustive `satisfies Record<MigrationHaltCode, …>` copy mapping
 * in `doctor-state-plane.ts` is the merge gate: the day a code is added here
 * without its human + machine copy, the build stops compiling.
 */

// U3 replaces `never` with the closed union of the ~15 migration halt codes
// (design 163:4482). Every member added here must gain an entry in
// MIGRATION_HALT_COPY (doctor-state-plane.ts) or the build fails.
export type MigrationHaltCode = never;

/** A single fail-closed migration halt: which class stopped the migration. U3
 * adds any per-code detail fields; today the closed `code` alone is the
 * contract every producer and every copy entry is keyed by. */
export interface MigrationHalt<Code extends MigrationHaltCode = MigrationHaltCode> {
  readonly code: Code;
}

/** What a state-plane migration health probe reports. `healthy` is the ordinary
 * steady state; `halted` carries the closed halt code doctor renders copy for. */
export type MigrationHealth =
  | { readonly status: "healthy" }
  | { readonly status: "halted"; readonly halt: MigrationHalt };
