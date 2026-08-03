/**
 * Sealed-artifact substrate: id-scoped locks, owner-exclusive private directories,
 * and descriptor-bound verification.
 *
 * The containment rule, and why it takes this exact shape. Verifying a path and
 * then reopening it — even through a hard link, which only shares the same
 * writable inode — leaves a window in which the bytes that were hashed are not the
 * bytes that get read. So consumption does not verify-then-open at all: it makes
 * ONE bounded streaming pass that simultaneously hashes and writes a private copy,
 * so the hash and the consumed bytes come from the same reads by construction. The
 * private copy is opened, primed, and then unlinked, leaving an anonymous inode no
 * pathname can reach. A closing re-proof would be meaningless and is not performed.
 *
 * TRUST BOUNDARY (ratified, see docs/design/notes/163/U1B-FINDINGS.md): a same-UID
 * actor mutating the anonymous inode behind an open descriptor requires /proc-level
 * fd introspection, which is ptrace-equivalent and outside this design's threat
 * model. The same boundary covers the residual window between the identity check
 * and the unlink in {@link deleteSealedArtifact}.
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import { StageChangedError, StageLockError } from "../errors.js";
import {
  SQLITE_SIDECARS, assertNoSidecars, copyWhileHashing, fsyncDirectory, hashDescriptor, identityOf,
  openNoFollow, sameInode, type PhysicalProof,
} from "./artifact-proof.js";
import { selectRow } from "./statements.js";

export { assertNoSidecars, fsyncDirectory, type PhysicalIdentity } from "./artifact-proof.js";
export { streamRows } from "./statements.js";

export const STAGE_ID_RE = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export const stageLockPath = (directory: string, stageId: string): string =>
  path.join(directory, `stage-${stageId}.lock`);
export const privateDirectoryPath = (directory: string, stageId: string): string =>
  path.join(directory, `stage-${stageId}.private`);
export const sealedStagePath = (directory: string, stageId: string, logicalDigest: string): string =>
  path.join(directory, `stage-${stageId}.${logicalDigest}.sealed`);

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
 * destroyed with it.
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

/**
 * The normative finish sequence. The caller has committed; this checkpoints
 * `TRUNCATE`, closes the sole builder, CHECKs `S0`, then takes its OWN descriptor
 * on the private inode and holds it for the rest of the interval. fsync, hash, and
 * the post-link identity check all run against that descriptor, so publication
 * never re-resolves a pathname it has already trusted. A destination that is not
 * the proven inode — or a parent fsync that fails after the link — is removed:
 * a destination must never survive a failed seal.
 */
export function sealAndPublish(
  db: Database,
  privateFile: string,
  destination: string,
  stageId: string,
): { sha256: string; bytes: number } {
  selectRow(db, "PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  assertNoSidecars(privateFile, stageId);
  const fd = openNoFollow(privateFile, stageId);
  try {
    fs.fsyncSync(fd);
    const proof = hashDescriptor(fd, stageId);
    try {
      fs.linkSync(privateFile, destination);
    } catch (error) {
      throw new StageChangedError(stageId, `sealed publication refused: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
    }
    try {
      const published = openNoFollow(destination, stageId);
      try {
        if (!sameInode(identityOf(fs.fstatSync(published)), proof.identity)) {
          throw new StageChangedError(stageId, "the published name is not the inode this builder proved");
        }
      } finally {
        fs.closeSync(published);
      }
      fsyncDirectory(path.dirname(destination));
    } catch (error) {
      // The no-survivor guarantee has to be durable too: a crash after the unlink
      // must not resurrect a destination this seal already disowned.
      fs.rmSync(destination, { force: true });
      try { fsyncDirectory(path.dirname(destination)); } catch { /* best effort */ }
      throw error;
    }
    return { sha256: proof.sha256, bytes: proof.bytes };
  } finally {
    fs.closeSync(fd);
  }
}

const activeAccessors = new Set<string>();

export interface SealedArtifactAccessor {
  readonly db: Database;
  readonly bytes: number;
  close(): void;
}

export interface SealedArtifactRef {
  stageId: string;
  logicalDigest: string;
  physicalSha256: string;
}

/**
 * Verify and open one sealed artifact by copy-while-hashing it into the lock-owned
 * private directory. After a priming read materializes SQLite's WAL index, the
 * copy and its sidecars are unlinked: from then on the connection reads anonymous
 * inodes that no pathname can reach, and cleanup is automatic on close.
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
  assertNoSidecars(sealed, expected.stageId);
  const privateDirectory = PrivateStageDirectory.claim(lock);
  const contained = privateDirectory.file();
  let db: Database;
  let proof: PhysicalProof;
  try {
    const sourceFd = openNoFollow(sealed, expected.stageId);
    try {
      const destinationFd = fs.openSync(
        contained,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        proof = copyWhileHashing(sourceFd, destinationFd, expected.stageId);
        fs.fsyncSync(destinationFd);
      } finally {
        fs.closeSync(destinationFd);
      }
    } finally {
      fs.closeSync(sourceFd);
    }
    if (proof.sha256 !== expected.physicalSha256) {
      throw new StageChangedError(expected.stageId, "sealed artifact physical hash does not match its ref");
    }
    db = new Database(contained, { create: false, readonly: true });
    try {
      db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=250; PRAGMA temp_store=FILE");
      // The priming read materializes the WAL index; only then can the names go.
      selectRow(db, "SELECT count(*) AS n FROM sqlite_schema");
      for (const suffix of ["", ...SQLITE_SIDECARS]) fs.rmSync(`${contained}${suffix}`, { force: true });
    } catch (error) {
      // The handle must never outlive the names: an unclosed anonymous inode is
      // a leak nothing can reach to clean up.
      db.close();
      throw error;
    }
  } catch (error) {
    privateDirectory.destroy();
    if (error instanceof StageChangedError || error instanceof StageLockError) throw error;
    throw new StageChangedError(expected.stageId, `cannot contain sealed artifact: ${String((error as NodeJS.ErrnoException).code ?? error)}`);
  }
  activeAccessors.add(sealed);
  let closed = false;
  return {
    db,
    bytes: proof.bytes,
    close(): void {
      if (closed) return;
      closed = true;
      db.close();
      activeAccessors.delete(sealed);
      privateDirectory.destroy();
    },
  };
}

/**
 * The design's id-scoped delete after adoption or refusal. The inode is pinned by a
 * private hard link first, proven through a descriptor on that private name, and
 * the shared name is unlinked only after a fresh no-follow open of it is confirmed
 * to be that same inode. The residual window between that confirmation and the
 * unlink is the ptrace-equivalent boundary documented at the top of this file; the
 * id-scoped lock serializes every legitimate writer across it.
 */
export function deleteSealedArtifact(directory: string, ref: SealedArtifactRef, lock: StageLock): void {
  lock.assertHeld();
  if (lock.stageId !== ref.stageId) throw new StageLockError(ref.stageId, "lock belongs to a different stage id");
  const sealed = sealedStagePath(directory, ref.stageId, ref.logicalDigest);
  const privateDirectory = PrivateStageDirectory.claim(lock);
  const pinned = privateDirectory.file("delete-target");
  try {
    fs.linkSync(sealed, pinned);
    const fd = openNoFollow(pinned, ref.stageId);
    try {
      const proof = hashDescriptor(fd, ref.stageId);
      if (proof.sha256 !== ref.physicalSha256) {
        throw new StageChangedError(ref.stageId, "refusing to delete an artifact that is not the one this ref names");
      }
      const candidate = openNoFollow(sealed, ref.stageId);
      try {
        if (!sameInode(identityOf(fs.fstatSync(candidate)), proof.identity)) {
          throw new StageChangedError(ref.stageId, "the shared name is no longer the inode this ref proves");
        }
      } finally {
        fs.closeSync(candidate);
      }
      fs.unlinkSync(sealed);
      fsyncDirectory(directory);
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    privateDirectory.destroy();
  }
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
  const mode = String(selectRow<{ journal_mode: string }>(db, "PRAGMA journal_mode")!.journal_mode).toLowerCase();
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
