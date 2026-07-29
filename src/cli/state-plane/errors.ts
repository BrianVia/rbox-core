import path from "node:path";
import type { MigrationHalt } from "./migration/health.js";

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
  | "state-unlocked-foreign-target"
  /** A migration control blocks writes, or an unretired genesis intent survives:
   * authority recovery has not finished. One policy, one reason (design 222 §1.3). */
  | "authority-recovery-pending";

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
  "authority-recovery-pending": "this folder's sync records are mid-recovery onto the new format; refusing to write until it finishes",
};

/**
 * `.rbox/state.json` says SQLite is authority, but the database that claim
 * names is absent, incomplete, foreign, or carries a different authority id.
 *
 * Deliberately not a `MigrationHaltCode`: a halt is a suspended protocol that
 * doctor may retry, and this is contradictory durable state that rbox will not
 * repair automatically at all. Zero repair writes, never retryable; the remedy
 * is re-adoption (design 163 M0 matrix, design 222 §6.4).
 */
export class StateAuthorityCorruptError extends Error {
  readonly name = "StateAuthorityCorruptError";
  constructor(readonly file: string, readonly detail: string) {
    super(
      `${file} says this workspace uses the new state format, but its state database is missing or does not match (${detail}). ` +
      "rbox has changed nothing and will not try to repair this automatically.",
    );
  }
}

export type MigrationControlErrorReason =
  /** Unknown, extra, missing, mistyped, or noncanonical member bytes. */
  | "schema"
  /** A control path holds something rbox did not write: a symlink, a directory,
   * an unreadable or over-cap file, or a sibling that is not this exact record. */
  | "foreign"
  /** The canonical control was not the exact record the publisher expected. */
  | "cas"
  /** A prepared sibling is not the exact inode/length/hash/bytes it recorded. */
  | "prepared-foreign"
  /** The published record did not read back as the exact bytes just renamed. */
  | "reread";

/** The durable migration control could not be read, trusted, or replaced. Every
 * reason is a zero-write refusal: the caller classifies it as corruption, never
 * as something to repair forward. */
export class MigrationControlError extends Error {
  readonly name = "MigrationControlError";
  constructor(readonly reason: MigrationControlErrorReason, detail: string) {
    super(`migration control ${reason}: ${detail}`);
  }
}

/**
 * A phase body refuses, carrying the exact halt the driver must publish.
 *
 * The halt taxonomy is closed and the durable record is the driver's to write
 * (163's "a failed halt publication is the final mutation of the trace"), so a
 * phase body names its halt and raises — it never publishes one itself, and it
 * never returns a value that a caller could mistake for progress. `wrote` is
 * the one fact the driver cannot recompute: whether this refusal happened
 * before any artifact mutation, which is what the zero-write rows assert.
 */
export class MigrationPhaseHaltError extends Error {
  readonly name = "MigrationPhaseHaltError";
  constructor(
    readonly halt: MigrationHalt,
    readonly wrote: boolean,
    detail: string,
  ) {
    super(`migration halt ${halt.code}: ${detail}`);
  }
}

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
 * A stage tried to tag itself as the migration importer without presenting the
 * state-plane migration capability. That tag is what makes blanket `migration`
 * BASE authority admissible on re-admission — after canonical-JSON round trip a
 * minted authority and a forged one are indistinguishable, so the tag, not the
 * proof shape, is the thing that has to be unforgeable.
 */
export class MigrationImporterCapabilityError extends Error {
  readonly name = "MigrationImporterCapabilityError";
  constructor(readonly detail: string) {
    super(`a migration-tagged transition stage requires the state-plane migration capability: ${detail}`);
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

/**
 * A persisted authority row could not be decoded into the value its schema
 * promises: the durable bytes are corrupt. Distinct from a caller passing a bad
 * value (`TypeError`) and from a sealed stage being mutated after sealing
 * (`StageChangedError`) — this is data-at-rest corruption discovered on read.
 * The originating decode failure is retained as `cause`.
 */
export class StateDataCorruptionError extends Error {
  readonly name = "StateDataCorruptionError";
  constructor(readonly entity: string, readonly key: string, override readonly cause?: unknown) {
    super(`corrupt ${entity} authority row ${JSON.stringify(key)}`, { cause });
  }
}

/** Decode one persisted authority row, converting any decode failure into a
 * `StateDataCorruptionError`. A row that will not decode is data-at-rest
 * corruption, not a caller error — the single taxonomy every column codec shares,
 * at every site that reconstructs a value from durable bytes. */
export function decodeAuthorityRow<T>(entity: string, key: string, decode: () => T): T {
  try {
    return decode();
  } catch (cause) {
    throw new StateDataCorruptionError(entity, key, cause);
  }
}
