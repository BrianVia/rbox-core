/**
 * The durable record of an in-flight scope edit (design 212 §3.3).
 *
 * Separate from the transaction that drives it so `workspace-config` can name the
 * persisted shape without importing the transaction, and so the two records that
 * have to agree — this intent and the daemon's maintenance token — are described
 * in one place.
 */

/** `planned`: the disk work is still owed. `committed`: the accepted scope is
 *  already durable and only the daemon's return is owed. Absent on records written
 *  before the phase existed — {@link legacyPhase} infers it for those. */
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

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.join("\n") === b.join("\n");

/**
 * The phase of an intent written before the field existed. The previous
 * transaction persisted the intent ONE more time after committing the scope, so an
 * intent whose target and generation are already the committed truth had its disk
 * work done — replaying its prune would trash files recreated since the crash.
 */
export const legacyPhase = (
  intent: ScopeIntent,
  committedScope: readonly string[] | undefined,
  committedGeneration: number | undefined,
): ScopeIntentPhase => (
  sameList(committedScope ?? [], intent.target) && committedGeneration === intent.generation ? "committed" : "planned"
);

/** The phase to act on, inferring it for records that predate the field. */
export const intentPhase = (
  intent: ScopeIntent,
  committedScope: readonly string[] | undefined,
  committedGeneration: number | undefined,
): ScopeIntentPhase => intent.phase ?? legacyPhase(intent, committedScope, committedGeneration);

/** Whether two journaled intents are the same edit, for compare-and-clear. */
export const sameIntent = (a: ScopeIntent | undefined, b: ScopeIntent): boolean =>
  a !== undefined
  && a.at === b.at
  && a.generation === b.generation
  && a.maintenanceId === b.maintenanceId
  && sameList(a.target, b.target);
