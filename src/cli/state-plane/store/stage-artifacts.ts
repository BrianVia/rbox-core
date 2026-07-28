/**
 * Sealed-stage artifact lifecycle: id-scoped locks, no-follow identity-bracketed
 * verification, and exactly one active accessor per sealed file.
 *
 * Every building/sealing/verification/consumption/cleanup action here is owned by
 * an exact stage id. Nothing is decided from a bare pathname: a path is verified
 * through the descriptor it was opened on, and the physical identity observed
 * before a read must still hold after it.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StageChangedError, StageLockError } from "../errors.js";

/**
 * Stream rows through a private statement that is always finalized, including on
 * an early throw. A refusal raised mid-iteration must not leave a cursor open on a
 * connection-owned TEMP table the caller is about to drop.
 */
export function streamRows<T>(
  db: Database,
  sql: string,
  params: Array<string | number | Uint8Array | null>,
  visit: (row: T) => void,
): number {
  const statement = db.prepare(sql);
  let count = 0;
  try {
    for (const row of statement.iterate(...params) as Iterable<T>) {
      visit(row);
      count++;
    }
    return count;
  } finally {
    statement.finalize();
  }
}

export const STAGE_ID_RE = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

export interface PhysicalIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export function assertStageId(stageId: string): void {
  if (!STAGE_ID_RE.test(stageId)) throw new TypeError("stage id must be lowercase hex32");
}

export const stageLockPath = (directory: string, stageId: string): string =>
  path.join(directory, `stage-${stageId}.lock`);
export const buildingStagePath = (directory: string, stageId: string): string =>
  path.join(directory, `stage-${stageId}.building`);
export const sealedStagePath = (directory: string, stageId: string, logicalDigest: string): string =>
  path.join(directory, `stage-${stageId}.${logicalDigest}.sealed`);

/** An exclusive claim on one stage id. Its lifetime covers the whole protected
 * file-identity interval; cleanup may only remove artifacts named by this id. */
export class StageLock {
  #released = false;

  private constructor(readonly directory: string, readonly stageId: string, readonly file: string) {}

  static acquire(directory: string, stageId: string): StageLock {
    assertStageId(stageId);
    fs.mkdirSync(directory, { recursive: true });
    const file = stageLockPath(directory, stageId);
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, `${stageId}\n${process.pid}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      throw new StageLockError(stageId, String((error as NodeJS.ErrnoException).code ?? error));
    }
    return new StageLock(directory, stageId, file);
  }

  assertHeld(): void {
    if (this.#released) throw new StageLockError(this.stageId, "released");
  }

  /** Removes only artifacts proven to carry this id. */
  cleanupOwnedArtifacts(): void {
    this.assertHeld();
    const prefix = `stage-${this.stageId}.`;
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      fs.rmSync(path.join(this.directory, entry.name), { force: true });
    }
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    fs.rmSync(this.file, { force: true });
  }
}

function identityOf(stats: fs.Stats): PhysicalIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino), size: stats.size, mtimeMs: stats.mtimeMs };
}

function sameIdentity(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** Open the exact regular file with no-follow semantics and refuse anything else.
 * The returned descriptor — never the name — is the verification subject. */
function openNoFollow(file: string, stageId: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new StageChangedError(stageId, `cannot open sealed artifact: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) throw new StageChangedError(stageId, "sealed artifact is not a regular file");
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function assertNoSidecars(file: string, stageId: string): void {
  for (const suffix of SQLITE_SIDECARS) {
    if (fs.existsSync(`${file}${suffix}`)) throw new StageChangedError(stageId, `sealed artifact has a ${suffix} sidecar`);
  }
}

/** Hash the opened descriptor, bracketed by identity observations on that same
 * descriptor. A replacement or in-place mutation around the read fails closed. */
export function physicalProof(file: string, stageId: string): { sha256: string; bytes: number; identity: PhysicalIdentity } {
  assertNoSidecars(file, stageId);
  const fd = openNoFollow(file, stageId);
  try {
    const before = identityOf(fs.fstatSync(fd));
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    let position = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      bytes += read;
      position += read;
    }
    const after = identityOf(fs.fstatSync(fd));
    if (!sameIdentity(before, after) || before.size !== bytes) {
      throw new StageChangedError(stageId, "sealed artifact changed while it was being hashed");
    }
    return { sha256: hash.digest("hex"), bytes, identity: after };
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncFile(file: string): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** No-clobber publication. rename(2) would silently replace a sealed artifact
 * another id already published at the same digest-bearing name. */
export function publishSealed(source: string, destination: string, stageId: string): void {
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    throw new StageChangedError(stageId, `sealed publication refused: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
  }
  fs.unlinkSync(source);
  fsyncDirectory(path.dirname(destination));
}

const activeAccessors = new Set<string>();

export interface SealedArtifactAccessor {
  readonly db: Database;
  readonly bytes: number;
  /** Repeats the physical hash/stat/sidecar checks after the artifact is closed.
   * Only a caller that reaches this without throwing may use what it streamed. */
  close(): void;
}

/**
 * Open exactly one read-only accessor over a sealed artifact whose physical hash
 * is already proven. The SQLite handle never escapes this object, and a second
 * concurrent accessor for the same file is refused rather than shared.
 */
export function openSealedArtifact(
  file: string,
  expected: { stageId: string; physicalSha256: string },
  lock: StageLock,
): SealedArtifactAccessor {
  lock.assertHeld();
  if (lock.stageId !== expected.stageId) throw new StageLockError(expected.stageId, "lock belongs to a different stage id");
  if (!HEX64.test(expected.physicalSha256)) throw new TypeError("physicalSha256 must be lowercase hex64");
  if (activeAccessors.has(file)) throw new StageChangedError(expected.stageId, "sealed artifact already has an active accessor");
  const before = physicalProof(file, expected.stageId);
  if (before.sha256 !== expected.physicalSha256) {
    throw new StageChangedError(expected.stageId, "sealed artifact physical hash does not match its ref");
  }
  const db = new Database(file, { create: false, readonly: true });
  activeAccessors.add(file);
  let closed = false;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA temp_store=FILE");
  } catch (error) {
    activeAccessors.delete(file);
    db.close();
    throw error;
  }
  return {
    db,
    bytes: before.bytes,
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
      activeAccessors.delete(file);
      const after = physicalProof(file, expected.stageId);
      if (after.sha256 !== expected.physicalSha256 || !sameIdentity(before.identity, after.identity)) {
        throw new StageChangedError(expected.stageId, "sealed artifact changed while it was being consumed");
      }
    },
  };
}

/** Stage builders use `journal_mode=DELETE`, not the authority's WAL. A committed
 * DELETE-journal database leaves no sidecar at all, so the design's "S0" (zero
 * sidecars) precondition for sealing is a property of the journal mode instead of
 * a checkpoint step that could be skipped. */
export function configureStageBuilder(db: Database): void {
  db.exec(`
    PRAGMA page_size=4096;
    PRAGMA journal_mode=DELETE;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA temp_store=FILE;
  `);
  const mode = String((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase();
  if (mode !== "delete") throw new Error(`stage builder journal_mode is ${mode}`);
}

export function assertSealedZeroSidecars(file: string, stageId: string): void {
  assertNoSidecars(file, stageId);
}
