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

export class EntryLeaseError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "EntryLeaseError";
  }
}
