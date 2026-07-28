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

/** The `FileEntry` extension vocabulary is entirely primitive (every declared
 *  field in `src/engine/types.ts` is a string or a number), so exact interning
 *  compares with `Object.is` and freezes shallowly. A composite value would
 *  silently break both, so it is refused at intern time rather than deep-frozen. */
export class EntryShapeError extends Error {
  constructor(key: string, detail: string) {
    super(`entry field ${key} is not internable: ${detail}`);
    this.name = "EntryShapeError";
  }
}

export class EntryLeaseError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "EntryLeaseError";
  }
}
