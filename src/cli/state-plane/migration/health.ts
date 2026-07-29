/**
 * Migration halt taxonomy (design 163 § "512 MiB and typed non-looping halts",
 * :3326).
 *
 * This module is the CLOSED contract every fail-closed migration halt is drawn
 * from. It holds types only: no runtime logic, no filesystem, no SQLite. The
 * exhaustive `satisfies Record<MigrationHaltCode, …>` copy mapping in
 * `doctor-state-plane.ts` is the merge gate — a code added here without its
 * human + machine copy stops the build.
 */

/** The ten stable halt reasons (163:3326). `source-changed` is expressible only
 * as a retirement-cursor halt; `durability-indeterminate` and `cleanup-deferred`
 * are the only two expressible after `Q`. */
export type MigrationHaltCode =
  | "source-oversize"
  | "memory-admission"
  | "record-oversize"
  | "disk-preflight"
  | "filesystem-full"
  | "source-changed"
  | "verification"
  | "reserved-path"
  | "durability-indeterminate"
  | "cleanup-deferred";

/**
 * One fail-closed migration halt, exactly as the durable control records it
 * (163:3339). It carries no phase: a halt is phase-preserving by construction
 * and the control it is published into already names the phase, so a second copy
 * could only ever disagree.
 */
export interface MigrationHalt<Code extends MigrationHaltCode = MigrationHaltCode> {
  readonly code: Code;
  /** The originating syscall or SQLite code, retained verbatim. */
  readonly underlyingCode: string | null;
  readonly required: number | null;
  readonly available: number | null;
}

/** What a state-plane migration health probe reports. `healthy` is the ordinary
 * steady state; `halted` carries the closed halt code doctor renders copy for. */
export type MigrationHealth =
  | { readonly status: "healthy" }
  | { readonly status: "halted"; readonly halt: MigrationHalt };
