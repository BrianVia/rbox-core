import path from "node:path";

/** A caller selected a different manifest stream than the durable baseline. */
export class StreamMismatchError extends Error {
  readonly name = "StreamMismatchError";

  constructor(
    readonly root: string,
    readonly expectedStream: string,
    readonly observedStream: string,
    readonly source: "state" | "incarnation-marker",
  ) {
    const file = source === "state"
      ? path.join(root, ".rbox", "state.json")
      : path.join(root, ".rbox", "state", "state-incarnation.json");
    super(
      `sync state at ${file} belongs to stream ${observedStream}, ` +
      `not ${expectedStream}; refusing to reset local sync history without setup confirmation`,
    );
  }
}

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

export type StateStoreOpenReason =
  | "not-a-database"
  | "corrupt"
  | "foreign-by-absence"
  | "wrong-application"
  | "wrong-schema-version"
  | "ddl-fingerprint"
  | "structural-invariant";

/** Stable refusal for a database that cannot safely be treated as this
 * version's state authority. The original SQLite error remains available. */
export class StateStoreOpenError extends Error {
  readonly name = "StateStoreOpenError";

  constructor(
    readonly reason: StateStoreOpenReason,
    readonly file: string,
    detail: string,
    readonly cause?: unknown,
  ) {
    super(`cannot open state store ${file}: ${detail}`, { cause });
  }
}

export class CursorWindowError extends Error {
  readonly name = "CursorWindowError";
  constructor(readonly kind: "file" | "repo" | "git" | "chain" | "transition", readonly requested: number, readonly maximum: number) {
    super(`${kind} cursor window ${requested} exceeds maximum ${maximum}`);
  }
}

export class SnapshotChangedError extends Error {
  readonly name = "SnapshotChangedError";
  constructor() {
    super("state snapshot changed during projection; discard every emitted page and retry");
  }
}

export class FileEntryOversizeError extends Error {
  readonly name = "FileEntryOversizeError";
  constructor(readonly path: string, readonly canonicalBytes: number, readonly retainedEstimate: number) {
    super(`file entry ${path} exceeds state-store limits (${canonicalBytes} canonical, ${retainedEstimate} retained bytes)`);
  }
}

export class RepoRecordOversizeError extends Error {
  readonly name = "RepoRecordOversizeError";
  constructor(readonly relPath: string, readonly canonicalBytes: number, readonly retainedEstimate: number) {
    super(`repository record ${relPath} exceeds state-store limits (${canonicalBytes} canonical, ${retainedEstimate} retained bytes)`);
  }
}

/** A sealed stage artifact was replaced, mutated, or could not be proven to be
 * the exact file its ref names. Never retried against the same path in place:
 * a retry that needs different bytes needs a new stage id. */
export class StageChangedError extends Error {
  readonly name = "StageChangedError";
  constructor(readonly stageId: string, detail: string) {
    super(`sealed stage ${stageId} failed verification: ${detail}`);
  }
}

/** The exclusive id-scoped stage lock could not be acquired or is no longer held. */
export class StageLockError extends Error {
  readonly name = "StageLockError";
  constructor(readonly stageId: string, readonly detail: string) {
    super(`stage ${stageId} lock unavailable: ${detail}`);
  }
}

/** One transition row exceeded the 8 MiB canonical / 24 MiB retained ceiling.
 * Raised by the pre-materialization scanner, before sealing or any authority write. */
export class TransitionRowOversizeError extends Error {
  readonly name = "TransitionRowOversizeError";
  constructor(readonly relPath: string, readonly canonicalBytes: number, readonly retainedEstimate: number) {
    super(`transition row ${relPath} exceeds transition-stage limits (${canonicalBytes} canonical, ${retainedEstimate} retained bytes)`);
  }
}

/**
 * A transition tried to introduce or change BASE without an explicit, purpose-bound
 * `RepoBaseProof`. The removed first implementation of this seam admitted exactly
 * this, which is why it is a named typed refusal rather than a generic TypeError.
 */
export class ProoflessBaseError extends Error {
  readonly name = "ProoflessBaseError";
  constructor(readonly relPath: string, readonly detail: string) {
    super(`repository ${relPath} may not change BASE without a validated proof: ${detail}`);
  }
}

export class GitSectionOversizeError extends Error {
  readonly name = "GitSectionOversizeError";
  constructor(readonly relPath: string, readonly bytes: number) {
    super(`Git section ${relPath} exceeds the 4 MiB cursor row ceiling (${bytes} bytes)`);
  }
}
