/**
 * Sealed-artifact substrate: id-scoped locks, owner-exclusive private directories,
 * no-follow identity-bracketed proof, and exactly one active accessor per artifact.
 *
 * The containment rule this module exists to enforce: **no pathname an attacker can
 * name is ever reopened after verification.** An artifact is hard-linked into a
 * private directory derived from the held stage lock id, and every subsequent
 * action — hashing, the SQLite open, the closing proof — happens on that private
 * name, which nothing outside the lock can rename or replace. Publication is the
 * mirror: an artifact is built and proven inside the private directory and reaches
 * its shared name only by `link(2)` from there.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StageChangedError, StageLockError } from "../errors.js";

/**
 * Stream rows through a private statement that is always finalized, including on
 * an early throw. A refusal raised mid-iteration must not leave a cursor open on a
 * connection-owned TEMP table the caller is about to drop. Returning `false` from
 * the visitor stops the scan, which is how byte ceilings are applied DURING paging.
 */
export function streamRows<T>(
  db: Database,
  sql: string,
  params: Array<string | number | Uint8Array | null>,
  visit: (row: T) => boolean | void,
): number {
  const statement = db.prepare(sql);
  let count = 0;
  try {
    for (const row of statement.iterate(...params) as Iterable<T>) {
      count++;
      if (visit(row) === false) break;
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

export const stageLockPath = (directory: string, stageId: string): string =>
  path.join(directory, `stage-${stageId}.lock`);
export const privateDirectoryPath = (directory: string, stageId: string): string =>
  path.join(directory, `stage-${stageId}.private`);
export const sealedStagePath = (directory: string, stageId: string, logicalDigest: string): string =>
  path.join(directory, `stage-${stageId}.${logicalDigest}.sealed`);

function identityOf(stats: fs.Stats): PhysicalIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino), size: stats.size, mtimeMs: stats.mtimeMs };
}

function sameIdentity(left: PhysicalIdentity, right: PhysicalIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function fsyncFile(file: string): void {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** An exclusive claim on one stage id. Its lifetime covers the whole protected
 * file-identity interval; cleanup removes only artifacts proven to belong to that
 * id, and the lock itself is always the LAST thing released. */
export class StageLock {
  #released = false;

  private constructor(readonly directory: string, readonly stageId: string, readonly file: string) {}

  static acquire(directory: string, stageId: string): StageLock {
    if (!STAGE_ID_RE.test(stageId)) throw new TypeError("stage id must be lowercase hex32");
    fs.mkdirSync(directory, { recursive: true });
    const file = stageLockPath(directory, stageId);
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600,
      );
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

  /**
   * Remove this id's build-time state — its private directory and nothing else. It
   * deliberately never touches the lock file: unlinking exclusivity while cleanup
   * is still running would let a second owner start inside our own interval.
   * Sealed artifacts are excluded too; those are removed only through
   * {@link deleteSealedArtifact}, which proves identity first.
   */
  sweepOwnedArtifacts(): void {
    this.assertHeld();
    fs.rmSync(privateDirectoryPath(this.directory, this.stageId), { recursive: true, force: true });
  }

  /** Always the last step of any owned interval. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    fs.rmSync(this.file, { force: true });
  }
}

/**
 * A directory only this lock's owner can name. Created 0700 under the held lock and
 * destroyed with it. Everything an artifact protocol touches after verification
 * lives here, which is what makes reopening by name safe.
 */
export class PrivateStageDirectory {
  private constructor(readonly path: string, private readonly lock: StageLock) {}

  static claim(lock: StageLock): PrivateStageDirectory {
    lock.assertHeld();
    const directory = privateDirectoryPath(lock.directory, lock.stageId);
    // A leftover from a crashed owner of this exact id: the lock we hold proves no
    // live owner exists, so reclaiming it is ours to do. mkdir is exclusive after.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    return new PrivateStageDirectory(directory, lock);
  }

  file(name = "artifact"): string {
    this.lock.assertHeld();
    return path.join(this.path, name);
  }

  destroy(): void {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
}

function openNoFollow(file: string, stageId: string): number {
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

/** Hash the opened descriptor, bracketed by identity observations on that same
 * descriptor. A replacement or in-place mutation around the read fails closed. */
export function physicalProof(file: string, stageId: string): { sha256: string; bytes: number; identity: PhysicalIdentity } {
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
      throw new StageChangedError(stageId, "artifact changed while it was being hashed");
    }
    return { sha256: hash.digest("hex"), bytes, identity: after };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The normative finish sequence, shared by every builder. The caller has committed;
 * this checkpoints `TRUNCATE`, closes the sole builder, CHECKs `S0`, fsyncs, proves
 * the physical hash inside the private directory, and only then `link(2)`s the
 * proven inode to its digest-bearing shared name. Publication is no-clobber:
 * `rename` would silently replace an artifact another owner already published.
 */
export function sealAndPublish(
  db: Database,
  privateFile: string,
  destination: string,
  stageId: string,
): { sha256: string; bytes: number } {
  db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  db.close();
  assertNoSidecars(privateFile, stageId);
  fsyncFile(privateFile);
  const proof = physicalProof(privateFile, stageId);
  try {
    fs.linkSync(privateFile, destination);
  } catch (error) {
    throw new StageChangedError(stageId, `sealed publication refused: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
  }
  fsyncDirectory(path.dirname(destination));
  return { sha256: proof.sha256, bytes: proof.bytes };
}

const activeAccessors = new Set<string>();

export interface SealedArtifactAccessor {
  readonly db: Database;
  readonly bytes: number;
  /** Re-proves the contained artifact after SQLite is closed, then destroys the
   * private directory. Only a caller that reaches this without throwing may use
   * what it streamed. */
  close(): void;
}

export interface SealedArtifactRef {
  stageId: string;
  logicalDigest: string;
  physicalSha256: string;
}

/**
 * Contain, prove, and open one sealed artifact. The shared pathname is resolved
 * exactly once — by `link(2)` into the private directory — and every later action
 * uses the private name. SQLite's read-only WAL sidecars therefore land inside the
 * private directory and are destroyed with it, never beside the shared artifact.
 */
export function openSealedArtifact(
  directory: string,
  expected: SealedArtifactRef,
  lock: StageLock,
): SealedArtifactAccessor {
  lock.assertHeld();
  if (lock.stageId !== expected.stageId) throw new StageLockError(expected.stageId, "lock belongs to a different stage id");
  if (!HEX64.test(expected.physicalSha256)) throw new TypeError("physicalSha256 must be lowercase hex64");
  const sealed = sealedStagePath(directory, expected.stageId, expected.logicalDigest);
  if (activeAccessors.has(sealed)) throw new StageChangedError(expected.stageId, "sealed artifact already has an active accessor");
  const shared = fs.lstatSync(sealed, { throwIfNoEntry: false });
  if (!shared?.isFile()) throw new StageChangedError(expected.stageId, "sealed artifact is not a regular file");
  assertNoSidecars(sealed, expected.stageId);
  const privateDirectory = PrivateStageDirectory.claim(lock);
  const contained = privateDirectory.file();
  let db: Database;
  let before: ReturnType<typeof physicalProof>;
  try {
    fs.linkSync(sealed, contained);
    assertNoSidecars(contained, expected.stageId);
    before = physicalProof(contained, expected.stageId);
    if (before.sha256 !== expected.physicalSha256) {
      throw new StageChangedError(expected.stageId, "sealed artifact physical hash does not match its ref");
    }
    db = new Database(contained, { create: false, readonly: true });
  } catch (error) {
    privateDirectory.destroy();
    if (error instanceof StageChangedError || error instanceof StageLockError) throw error;
    throw new StageChangedError(expected.stageId, `cannot contain sealed artifact: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
  }
  activeAccessors.add(sealed);
  let closed = false;
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA temp_store=FILE");
  } catch (error) {
    activeAccessors.delete(sealed);
    db.close();
    privateDirectory.destroy();
    throw error;
  }
  return {
    db,
    bytes: before.bytes,
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
      activeAccessors.delete(sealed);
      try {
        const after = physicalProof(contained, expected.stageId);
        if (after.sha256 !== expected.physicalSha256 || !sameIdentity(before.identity, after.identity)) {
          throw new StageChangedError(expected.stageId, "sealed artifact changed while it was being consumed");
        }
      } finally {
        privateDirectory.destroy();
      }
    },
  };
}

/**
 * The design's id-scoped delete after adoption or refusal. Identity is proven first
 * and re-observed immediately before the unlink, so a swapped-in file is never
 * removed on this id's behalf.
 */
export function deleteSealedArtifact(directory: string, ref: SealedArtifactRef, lock: StageLock): void {
  lock.assertHeld();
  if (lock.stageId !== ref.stageId) throw new StageLockError(ref.stageId, "lock belongs to a different stage id");
  const sealed = sealedStagePath(directory, ref.stageId, ref.logicalDigest);
  const proof = physicalProof(sealed, ref.stageId);
  if (proof.sha256 !== ref.physicalSha256) {
    throw new StageChangedError(ref.stageId, "refusing to delete an artifact that is not the one this ref names");
  }
  const now = fs.lstatSync(sealed, { throwIfNoEntry: false });
  if (!now?.isFile() || !sameIdentity(identityOf(now), proof.identity)) {
    throw new StageChangedError(ref.stageId, "sealed artifact identity changed before its id-scoped delete");
  }
  fs.unlinkSync(sealed);
  fsyncDirectory(directory);
}

/**
 * Stage builders run in WAL exactly as the design specifies. `S0` is then a checked
 * precondition of sealing (see {@link sealAndPublish}) rather than a property
 * inferred from a journal mode.
 */
export function configureStageBuilder(db: Database): void {
  db.exec(`
    PRAGMA page_size=4096;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA temp_store=FILE;
  `);
  const mode = String((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error(`stage builder journal_mode is ${mode}`);
}

/** Every builder shares this failure path: close what is open, remove the partial
 * artifact and private state, and release the lock LAST. A sealing failure must
 * never leave a lock or an orphan behind. */
export function abandonBuilder(db: Database | undefined, lock: StageLock, privateDirectory?: PrivateStageDirectory): void {
  try { if (db?.inTransaction) db.exec("ROLLBACK"); } catch { /* closing anyway */ }
  try { db?.close(); } catch { /* already closed */ }
  try { privateDirectory?.destroy(); } catch { /* best effort */ }
  try { lock.sweepOwnedArtifacts(); } catch { /* lock may already be released */ }
  lock.release();
}
