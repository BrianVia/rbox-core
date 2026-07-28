/**
 * The 1.x-side state-plane barrier (design 163, unit B0).
 *
 * A future release moves the state plane to SQLite and replaces the bytes at
 * `.rbox/state.json` with a fixed 58-byte non-JSON authority marker (`Q`). This
 * module is the only thing that recognizes those bytes, and every production
 * reader and writer of that path consults it — reads so a 1.x binary refuses
 * instead of guessing, writes so a 1.x binary can never rename a legacy JSON
 * document over the marker and silently re-elect a stale sync base.
 *
 * The write side is the load-bearing half: a read-time check only protects an
 * operation that read *after* the flip.
 */
import fs from "node:fs/promises";

export const AUTHORITY_MARKER_MAGIC = "RBOX-SQLITE-AUTHORITY-v1";
/** magic + LF + 32 lowercase hex + LF. */
export const AUTHORITY_MARKER_BYTES = 58;
const AUTHORITY_MARKER_RE = new RegExp(`^${AUTHORITY_MARKER_MAGIC}\\n[0-9a-f]{32}\\n$`);
const DETECT_BYTES = 128;

/** What the bytes at `.rbox/state.json` are, decided without parsing them. */
export type StateFormat =
  /** No file at the path (first run, or a workspace that never synced). */
  | "absent"
  /** Exactly the 58-byte SQLite authority marker. */
  | "authority-marker"
  /** Plausible legacy JSON — the only format a 1.x binary may read or replace. */
  | "json"
  /** Neither: truncated, binary, a directory, a symlink, or an unknown marker. */
  | "foreign";

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

function looksLikeJson(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b; // '{' or '['
  }
  return false;
}

/**
 * Classify the bytes at `file` without materializing the document. Reads at most
 * {@link DETECT_BYTES}, follows no symlink, and never throws for content — only
 * an unexpected filesystem error propagates.
 */
export async function classifyStateFormat(file: string): Promise<StateFormat> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return "absent";
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return "foreign";
  if (stat.size === 0) return "foreign";
  const handle = await fs.open(file, "r");
  let head: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(DETECT_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (stat.size === AUTHORITY_MARKER_BYTES && AUTHORITY_MARKER_RE.test(head.toString("latin1"))) return "authority-marker";
  return looksLikeJson(head) ? "json" : "foreign";
}

/** True only for the exact 58-byte marker. Exposed for fixtures and tests;
 * production code goes through {@link classifyStateFormat}. */
export function isAuthorityMarkerBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength === AUTHORITY_MARKER_BYTES
    && AUTHORITY_MARKER_RE.test(Buffer.from(bytes).toString("latin1"));
}

/**
 * The read-side barrier. Throws {@link StateFormatTooNewError} when the path
 * carries the authority marker; every other format is left to the caller's own
 * parser, so this check never changes behaviour for a legacy workspace.
 */
export async function assertStateReadable(file: string): Promise<void> {
  if (await classifyStateFormat(file) === "authority-marker") throw new StateFormatTooNewError(file);
}

/**
 * The write-side barrier, evaluated immediately before publication. Under a held
 * publication lock only the marker is disqualifying. On an unlockable filesystem
 * the check has no mutual exclusion behind it, so it additionally refuses any
 * target it cannot positively recognize as legacy JSON.
 */
export async function assertStatePublishable(file: string, opts: { locked: boolean }): Promise<void> {
  const format = await classifyStateFormat(file);
  if (format === "authority-marker") throw new StateFormatTooNewError(file);
  if (!opts.locked && format === "foreign") throw new StateWriteRefusedError("state-unlocked-foreign-target", file);
}

/**
 * Re-raise the barrier's fail-closed refusals out of a broad `catch`. Callers
 * that fold every exception into "the save did not land" would otherwise reload
 * and retry a write the barrier has just refused, turning a terminal condition
 * into a retry loop.
 */
export function rethrowIfStateBarrier(error: unknown): void {
  if (error instanceof StateFormatTooNewError || error instanceof StateWriteRefusedError) throw error;
}
