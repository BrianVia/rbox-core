/**
 * The durable record of an in-flight scope edit (design 212 §3.3).
 *
 * Separate from the transaction that drives it so `workspace-config` can name the
 * persisted shape without importing the transaction, and so the two records that
 * have to agree — this intent and the daemon's maintenance token — are described
 * in one place.
 */

/** `planned`: the disk work is still owed. `committed`: the accepted scope is
 *  already durable and only the daemon's return is owed. Absent on records
 *  written before the phase existed, which are read as `planned`. */
export type ScopeIntentPhase = "planned" | "committed";

export interface ScopeIntent {
  generation: number;
  accepted: string[];
  target: string[];
  materialize: string[];
  prune: string[];
  at: string;
  phase?: ScopeIntentPhase;
  /** The maintenance token this transaction parked the daemon under. Present ⇒ a
   *  restart is owed, and the intent must survive until that restart is attempted. */
  maintenanceId?: string;
}

export const planScopeIntent = (
  accepted: readonly string[],
  target: readonly string[],
  generation: number,
  at: string,
): ScopeIntent => ({
  generation,
  accepted: [...accepted],
  target: [...target],
  materialize: target.filter((prefix) => !accepted.includes(prefix)),
  prune: accepted.filter((prefix) => !target.includes(prefix)),
  at,
  phase: "planned",
});

export const newMaintenanceId = (): string => `scope_${crypto.randomUUID()}`;
