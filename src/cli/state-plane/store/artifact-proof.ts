/**
 * Descriptor-bound proof primitives.
 *
 * Everything here decides a property from an OPEN DESCRIPTOR rather than from a
 * pathname, which is what lets the artifact lifecycle above it never re-resolve a
 * name it has already trusted. {@link copyWhileHashing} is the load-bearing one:
 * the hash and the private copy come from the same reads, so "the bytes I verified"
 * and "the bytes I will consume" are one object rather than two observations.
 *
 * Never: pathname-derived decisions, locks, or SQLite schemas.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { StageChangedError } from "../errors.js";

export const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;

export interface PhysicalIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface PhysicalProof {
  sha256: string;
  bytes: number;
  identity: PhysicalIdentity;
}

export function identityOf(stats: fs.Stats): PhysicalIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino), size: stats.size, mtimeMs: stats.mtimeMs };
}

export const sameInode = (left: PhysicalIdentity, right: PhysicalIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function openNoFollow(file: string, stageId: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new StageChangedError(stageId, `cannot open artifact: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new StageChangedError(stageId, "artifact is not a regular file");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** The design's `S0`: an artifact may be sealed or consumed only with zero SQLite
 * sidecars beside it. This is a CHECK, never a consequence of a journal mode. */
export function assertNoSidecars(file: string, stageId: string): void {
  for (const suffix of SQLITE_SIDECARS) {
    if (fs.existsSync(`${file}${suffix}`)) throw new StageChangedError(stageId, `artifact has a ${suffix} sidecar`);
  }
}

export interface PhysicalProof {
  sha256: string;
  bytes: number;
  identity: PhysicalIdentity;
}

/** Hash an already-open descriptor. Used where this process owns the inode for the
 * whole interval — sealing and deletion — so no pathname is re-resolved. */
export function hashDescriptor(fd: number, stageId: string): PhysicalProof {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let bytes = 0;
  for (;;) {
    const read = fs.readSync(fd, chunk, 0, chunk.length, bytes);
    if (read === 0) break;
    hash.update(chunk.subarray(0, read));
    bytes += read;
  }
  const identity = identityOf(fs.fstatSync(fd));
  if (identity.size !== bytes) throw new StageChangedError(stageId, "artifact changed while it was being hashed");
  return { sha256: hash.digest("hex"), bytes, identity };
}

/**
 * ONE bounded streaming pass that both hashes and copies. The digest and the copy
 * are produced from the same reads, so "the bytes I verified" and "the bytes I will
 * consume" are the same object rather than two observations of a mutable path.
 * Memory is one fixed chunk regardless of artifact size.
 */
export function copyWhileHashing(sourceFd: number, destinationFd: number, stageId: string): PhysicalProof {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let bytes = 0;
  for (;;) {
    const read = fs.readSync(sourceFd, chunk, 0, chunk.length, bytes);
    if (read === 0) break;
    const slice = chunk.subarray(0, read);
    hash.update(slice);
    let written = 0;
    while (written < read) written += fs.writeSync(destinationFd, slice, written, read - written, bytes + written);
    bytes += read;
  }
  const identity = identityOf(fs.fstatSync(destinationFd));
  if (identity.size !== bytes) throw new StageChangedError(stageId, "private copy is not the length that was hashed");
  return { sha256: hash.digest("hex"), bytes, identity };
}

