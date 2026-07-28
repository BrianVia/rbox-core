/** The state plane belongs to a newer rbox than this one. Never repairable by
 * deleting the marker: it is the only pointer to the authoritative database. */
export class StateFormatTooNewError extends Error {
  readonly name = "StateFormatTooNewError";
  readonly reason = "state-format-too-new" as const;

  constructor(readonly file: string) {
    super(
      `${file} was written by a newer version of rbox that stores sync state in a database. ` +
      "This version cannot read or replace it. Upgrade rbox (`rbox upgrade`); never delete this file.",
    );
  }
}

export type StateWriteRefusalReason =
  /** The publication lock is held by another process right now. */
  | "state-lock-unavailable"
  /** The publication lock could not be evaluated (I/O or marker failure). */
  | "state-lock-error"
  /** The lease was stolen or expired between acquisition and publication. */
  | "state-lock-lease-lost"
  /** Unlockable filesystem, and the target is not recognizable legacy JSON. */
  | "state-unlocked-foreign-target";

/** A state publication was refused rather than attempted unlocked or blind.
 * Every reason is a fail-closed decision, not a transient the caller may retry
 * by writing anyway. */
export class StateWriteRefusedError extends Error {
  readonly name = "StateWriteRefusedError";

  constructor(readonly reason: StateWriteRefusalReason, readonly file: string, detail?: string) {
    super(`${REFUSAL_MESSAGES[reason]} (${file}${detail ? `: ${detail}` : ""})`);
  }
}

const REFUSAL_MESSAGES: Record<StateWriteRefusalReason, string> = {
  "state-lock-unavailable": "another rbox process is saving this folder's sync records; refusing to save over it",
  "state-lock-error": "this folder's sync-record lock could not be checked; refusing to save without it",
  "state-lock-lease-lost": "this folder's sync-record lock was lost mid-save; refusing to publish",
  "state-unlocked-foreign-target": "this folder's sync records are not in a format this rbox wrote; refusing to replace them",
};
