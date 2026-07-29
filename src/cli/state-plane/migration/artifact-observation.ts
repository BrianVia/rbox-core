/**
 * Zero-write observation of the state-plane artifacts the migration classifier
 * reads (design 222 §M-3, design 163's M0 authority matrix).
 *
 * Every property of a path is decided from ONE no-follow descriptor, as the
 * sidecar modules do: a pathname lookup followed by a second one could be
 * answered by a symlink swapped in between.
 *
 * Nothing here opens SQLite. A read-only `bun:sqlite` open of a cleanly
 * checkpointed WAL database creates `-wal` and `-shm` and leaves them behind,
 * which would break the classifier's zero-write property outright, so a database
 * is matched against the physical bytes the durable control already recorded for
 * it rather than by reading its tables.
 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs";
import { classifyStateFormat, AUTHORITY_MARKER_BYTES, isAuthorityMarkerBytes } from "../authority-marker.js";
import { statePath } from "../paths.js";
import type { QSiblingWitness, SourceWitness, StagingMain } from "./control-codec.js";

const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const DIGEST_CHUNK_BYTES = 64 * 1024;

export type PathObservation =
  /** `foreign` is a symlink, a directory, a special file, or an unopenable path.
   * Every caller treats it exactly as it treats "not the thing I recorded", so it
   * carries nothing beyond the distinction from absence. */
  | { readonly state: "absent" | "foreign" }
  | {
    readonly state: "regular"; readonly file: string;
    readonly dev: number; readonly ino: number;
    readonly bytes: number; readonly mode: number; readonly mtimeNs: string;
    /** Present only when the caller asked for it. */
    readonly sha256: string | null;
  };

export function observePath(file: string, digest = false): PathObservation {
  let fd: number;
  try {
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { state: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "foreign" };
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return { state: "foreign" };
    return {
      state: "regular", file,
      dev: Number(stat.dev), ino: Number(stat.ino),
      bytes: Number(stat.size), mode: Number(stat.mode) & 0o7777,
      mtimeNs: stat.mtimeNs.toString(),
      sha256: digest ? digestOpenFile(fd) : null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function digestOpenFile(fd: number): string {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(DIGEST_CHUNK_BYTES);
  for (let offset = 0; ;) {
    const read = fs.readSync(fd, chunk, 0, chunk.byteLength, offset);
    if (read === 0) break;
    hash.update(chunk.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

/** Which of a database's own temporary sidecars exist beside it right now. */
export function observeSidecars(main: string): readonly string[] {
  return SIDECAR_SUFFIXES.filter((suffix) => observePath(`${main}${suffix}`).state !== "absent");
}

export type LegacyAuthority =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign" }
  /** Legacy JSON is authority, identity-bracketed as the control records it. */
  | { readonly kind: "json"; readonly witness: SourceWitness }
  /** The exact 58-byte marker elects SQLite; `authorityId` is the id it names. */
  | { readonly kind: "q"; readonly file: string; readonly authorityId: string };

/**
 * What `.rbox/state.json` is right now. `classifyStateFormat` is the barrier that
 * decides the format; this adds the identity and the hash the migration control
 * brackets its source against, and the authority id the marker publishes.
 */
export async function observeLegacyAuthority(root: string): Promise<LegacyAuthority> {
  const format = await classifyStateFormat(statePath(root));
  if (format === "absent") return { kind: "absent" };
  if (format === "authority-marker") {
    const authorityId = readMarkerAuthorityId(statePath(root));
    return authorityId ? { kind: "q", file: statePath(root), authorityId } : { kind: "foreign" };
  }
  if (format !== "json") return { kind: "foreign" };
  const observed = observePath(statePath(root), true);
  if (observed.state !== "regular" || observed.sha256 === null) return { kind: "foreign" };
  return {
    kind: "json",
    witness: {
      path: statePath(root), dev: observed.dev, ino: observed.ino,
      bytes: observed.bytes, sha256: observed.sha256, mtimeNs: observed.mtimeNs,
    },
  };
}

function readMarkerAuthorityId(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const bytes = Buffer.alloc(AUTHORITY_MARKER_BYTES);
    const read = fs.readSync(fd, bytes, 0, bytes.byteLength, 0);
    if (read !== AUTHORITY_MARKER_BYTES || !isAuthorityMarkerBytes(bytes)) return undefined;
    return bytes.toString("latin1").split("\n")[1];
  } finally {
    fs.closeSync(fd);
  }
}

/** The staging main as M2 recorded it (design 222 §M-5's four observations, of
 * which the two that need the database's contents are M-5's to distinguish). */
export type StagingMainObservation =
  | { readonly state: "absent" }
  /** The sole admitted create-ahead shape: zero-byte, 0600, no sidecars. */
  | { readonly state: "create-ahead" }
  | { readonly state: "recorded"; readonly bytes: number; readonly sidecars: readonly string[] };

/** The Q sibling against the disposition the M5 witness prebound (163:2646). */
export type QSiblingObservation =
  | { readonly state: "absent" }
  | { readonly state: "building"; readonly bytes: number }
  | { readonly state: "exact" };

/** An observation that matches no admitted disposition, carrying why. */
export interface ForeignArtifact { readonly foreign: string }

export const isForeign = (value: object): value is ForeignArtifact => "foreign" in value;

export function observeStagingMain(
  file: string, recorded: StagingMain,
): StagingMainObservation | ForeignArtifact {
  const observed = observePath(file);
  const sidecars = observeSidecars(file);
  if (recorded.state === "absent") {
    if (observed.state === "absent") {
      return sidecars.length === 0 ? { state: "absent" } : { foreign: `${file} is absent but its sidecars are not` };
    }
    if (observed.state === "regular" && observed.bytes === 0 && observed.mode === 0o600 && sidecars.length === 0) {
      return { state: "create-ahead" };
    }
    return { foreign: `${file} is not the sole admitted create-ahead shape` };
  }
  if (observed.state !== "regular") return { foreign: `${file} does not hold the recorded staging main` };
  if (observed.dev !== recorded.dev || observed.ino !== recorded.ino) {
    return { foreign: `${file} is not the recorded staging inode` };
  }
  return { state: "recorded", bytes: observed.bytes, sidecars };
}

export function observeQSibling(witness: QSiblingWitness): QSiblingObservation | ForeignArtifact {
  const { path: file, disposition } = witness;
  const observed = observePath(file, true);
  if (disposition.state === "absent") {
    if (observed.state === "absent") return { state: "absent" };
    if (observed.state === "regular" && observed.bytes === 0) return { state: "building", bytes: 0 };
    return { foreign: `${file} is neither absent nor the sole zero-byte create-ahead` };
  }
  if (observed.state !== "regular" || observed.dev !== disposition.dev || observed.ino !== disposition.ino) {
    return { foreign: `${file} is not the recorded Q-sibling inode` };
  }
  if (observed.bytes > AUTHORITY_MARKER_BYTES) return { foreign: `${file} is longer than the authority marker` };
  if (observed.bytes < AUTHORITY_MARKER_BYTES) {
    return disposition.state === "building"
      ? { state: "building", bytes: observed.bytes }
      : { foreign: `${file} is recorded exact but holds ${observed.bytes} bytes` };
  }
  return observed.sha256 === witness.sha256
    ? { state: "exact" }
    : { foreign: `${file} is 58 bytes that are not the recorded marker` };
}
