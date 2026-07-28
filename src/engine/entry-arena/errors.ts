/** Failure reasons of the U0 replacement seam. Every one of them leaves retains
 *  and generation references exactly as they were. */
export type ReplacementConflictReason =
  | "stale-token"
  | "stale-version"
  | "unknown-path"
  | "path-mismatch"
  | "not-live"
  | "intake-closed"
  | "pending-results";

export class GenerationReplacementConflict extends Error {
  readonly reason: ReplacementConflictReason;
  constructor(reason: ReplacementConflictReason, detail?: string) {
    super(detail ? `generation replacement conflict (${reason}): ${detail}` : `generation replacement conflict (${reason})`);
    this.name = "GenerationReplacementConflict";
    this.reason = reason;
  }
}

/** The presented object is not a live capability in this isolate's registry. */
export class GenerationOwnerCapabilityError extends Error {
  constructor(detail = "not a live generation owner capability") {
    super(detail);
    this.name = "GenerationOwnerCapabilityError";
  }
}

/** An illegal worker lifecycle transition, a reused settlement, or a revoked
 *  apply context. Never decrements `pendingResults`. */
export class WorkerLifecycleError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "WorkerLifecycleError";
  }
}

/** Extension members are arbitrary decoded JSON, which interning fully
 *  supports. This is raised only for values JSON cannot produce (functions,
 *  symbols, bigints) or nesting past `MAX_EXTENSION_DEPTH`. */
export class EntryShapeError extends Error {
  constructor(key: string, detail: string) {
    super(`entry field ${key} is not internable: ${detail}`);
    this.name = "EntryShapeError";
  }
}

/** A terminal operation was started on an owner from inside that same owner's
 *  resource-release callback — a cycle: the operation waits for the settlement
 *  that is waiting for the callback. Detected across awaits, not just
 *  synchronously, so abort can never deadlock. */
export class OwnerReentrancyError extends Error {
  constructor(operation: string) {
    super(`${operation} cannot be called from a resource-release callback of the same owner`);
    this.name = "OwnerReentrancyError";
  }
}

export class EntryLeaseError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "EntryLeaseError";
  }
}
