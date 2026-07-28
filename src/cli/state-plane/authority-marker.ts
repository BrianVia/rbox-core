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
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { StateFormatTooNewError, StateWriteRefusedError } from "./errors.js";

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

function looksLikeJson(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b; // '{' or '['
  }
  return false;
}

/**
 * Classify the bytes at `file` without materializing the document. Reads at most
 * {@link DETECT_BYTES} and never throws for content — only an unexpected
 * filesystem error propagates.
 *
 * Every property is decided from a single no-follow descriptor, as the sidecar
 * modules do: a pathname lookup followed by a second one could be answered by a
 * symlink swapped in after the first, which would let the attacker's file be
 * read as the state document under the original file's type and size.
 */
export async function classifyStateFormat(file: string): Promise<StateFormat> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    // ELOOP is O_NOFOLLOW refusing a symlink at the path: not a document this
    // binary may read or replace, and the same refusal a symlink got before.
    if (code === "ELOOP") return "foreign";
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0) return "foreign";
    const buffer = Buffer.alloc(Math.min(DETECT_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    if (stat.size === AUTHORITY_MARKER_BYTES && AUTHORITY_MARKER_RE.test(head.toString("latin1"))) return "authority-marker";
    return looksLikeJson(head) ? "json" : "foreign";
  } finally {
    await handle.close().catch(() => undefined);
  }
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
