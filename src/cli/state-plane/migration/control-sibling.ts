/**
 * The control's revision-scoped sibling namespace, and the bounded descriptor
 * primitives every durable control transition is built from.
 *
 * `migration-v1.json.<migrationId>.<revision>.tmp` is ONE namespace with two
 * users: an ordinary publication's own render temp, and the M6 runway's prepared
 * future controls (163's "migration-id-bound canonical-publisher siblings"). This
 * module owns what may occupy a path in it and how one is brought into existence;
 * `control-publication.ts` owns the canonical file and every rename onto it.
 *
 * The split is the 400-line law's (163:3994), and the seam is real in both
 * directions: nothing here names the canonical control, so §7.9's sole-writer gate
 * is undisturbed, and the dependency runs strictly one way — the publisher imports
 * the sibling primitives, never the reverse. Which is also why the ownership
 * question `renderPreparedControl` has to ask ("does a live record still own this
 * revision?") arrives as a PARAMETER: only the canonical record can answer it, and
 * reaching back for it here would recreate the cycle the split avoids.
 *
 * Synchronous throughout, for the reason `control-publication.ts` gives.
 */
import crypto from "node:crypto";
import fs, { constants } from "node:fs";
import path from "node:path";
import { MigrationControlError, type MigrationControlErrorReason } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import {
  CONTROL_MAX_BYTES, decodeMigrationControl, encodeMigrationControl,
  type Inode, type MigrationControl,
} from "./control-codec.js";

/** A rendered, fsynced, revision-scoped sibling: exactly the bytes of one
 * control record, identified by inode as well as path. */
export interface PreparedControlIdentity extends Inode {
  readonly path: string;
  readonly revision: number;
  readonly bytes: number;
  readonly sha256: string;
}

export const digestBytes = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

export const controlFail: (reason: MigrationControlErrorReason, detail: string) => never = (reason, detail) => {
  throw new MigrationControlError(reason, detail);
};

export function fsyncDirectorySync(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Private: `phase-io.ts` exports a same-named primitive for the phase bodies,
 * and one exported name belongs to one module. Duplicating six lines is the right
 * trade against inverting the layering — the publication layer must not import a
 * phase-body primitive. */
function fsyncSiblingAndParent(file: string): void {
  const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fsyncDirectorySync(path.dirname(file));
}

/** One no-follow descriptor decides type, identity, and bytes: a second pathname
 * lookup could be answered by a symlink swapped in after the first. */
export function readExactFile(file: string): { bytes: Buffer; dev: number; ino: number } | undefined {
  let fd: number;
  try {
    // O_NONBLOCK: `readCanonicalControl` is on the write fence's hot path, under
    // the held state lock, and opening a FIFO without it blocks forever waiting
    // for a writer. The `isFile` check below is what then refuses it.
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only ENOENT is absence. ENOTDIR means a path component is not a directory
    // — `.rbox/state` replaced by a regular file — which is manual damage, and
    // reading it as "no control" would restart a migration over a live one.
    if (code === "ENOENT") return undefined;
    return controlFail("foreign", `${file} could not be opened as a regular file (${code})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return controlFail("foreign", `${file} is not a regular file`);
    if (stat.size > CONTROL_MAX_BYTES) {
      return controlFail("foreign", `${file} is ${stat.size} bytes, over the ${CONTROL_MAX_BYTES} cap`);
    }
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) {
      return controlFail("foreign", `${file} was truncated while reading`);
    }
    return { bytes, dev: Number(stat.dev), ino: Number(stat.ino) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Remove a sibling this process created, and only if the path still holds the
 * exact inode it recorded. Cleanup on a caught failure only: a crash leaves the
 * inert revision temp 163's `absent` crash row already admits. */
export function removeOwnSibling(sibling: { path: string } & Inode): void {
  try {
    const observed = fs.lstatSync(sibling.path);
    if (!observed.isFile() || Number(observed.dev) !== sibling.dev || Number(observed.ino) !== sibling.ino) return;
    fs.unlinkSync(sibling.path);
    fsyncDirectorySync(path.dirname(sibling.path));
  } catch {
    // Best effort: the sibling is inert either way.
  }
}

/**
 * Render one exclusive revision-scoped sibling: create, write, fsync the file,
 * fsync `.rbox/state`, then reread it exactly. Used both for an ordinary
 * publication's own temp and for the M6 runway's prepared future controls —
 * they are the same namespace.
 *
 * A crash between rendering and renaming leaves the exact inert temp for this
 * record at this revision, and every phase after M0 pins both the migration id
 * and the revision, so refusing to resume it would wedge the migration forever.
 * The occupied path is therefore adopted — but only when every byte is this
 * exact record, and never for anything else.
 *
 * `ownedRevisionPaths` is what a live canonical record still owns as artifacts
 * (see {@link isOwnStrand}). Anything at a path in that list is refused rather
 * than repaired.
 */
export function renderControlSibling(
  root: string, revision: number, next: MigrationControl, locks: HeldStatePlaneLocks,
  ownedRevisionPaths: readonly string[] = [],
): PreparedControlIdentity {
  void locks;
  if (next.controlRevision !== revision) {
    controlFail("schema", `record revision ${next.controlRevision} may not be rendered at ${revision}`);
  }
  const bytes = encodeMigrationControl(next);
  const file = migrationPaths.controlRevision(root, next.migrationId, revision);
  const identity = (found: Inode): PreparedControlIdentity =>
    ({ path: file, revision, dev: found.dev, ino: found.ino, bytes: bytes.byteLength, sha256: digestBytes(bytes) });

  let fd: number;
  try {
    fd = fs.openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") return controlFail("foreign", `${file} could not be created exclusively (${code})`);
    const existing = readExactFile(file);
    if (existing?.bytes.equals(bytes)) {
      fsyncSiblingAndParent(file);
      return identity(existing);
    }
    if (!existing || ownedRevisionPaths.includes(file)
      || !isOwnStrand(next, revision, existing.bytes, bytes)) {
      return controlFail("foreign", `${file} is occupied by something other than this exact record`);
    }
    return identity(rewriteStrand(file, bytes, existing));
  }

  const created = fs.fstatSync(fd);
  const own = { path: file, dev: Number(created.dev), ino: Number(created.ino) };
  try {
    try {
      fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectorySync(path.dirname(file));
    const exact = readExactFile(file);
    if (!exact || !exact.bytes.equals(bytes)) {
      return controlFail("reread", `${file} is not the record just rendered`);
    }
    return identity(exact);
  } catch (error) {
    removeOwnSibling(own);
    throw error;
  }
}

/**
 * Wave 1A's render→rename wedge, closed — the third path 222 §M-2 left open.
 *
 * 1A pinned that byte-identical resume closes only the DETERMINISTIC half of the
 * crash window. A record whose bytes will never recur strands its revision-scoped
 * sibling permanently, and 5A is where that becomes reachable: halt records carry
 * a live `underlyingCode` and, for `memory-admission` and `disk-preflight`, a
 * measured pair taken from live RSS and `statfs`. Wave 3A closed M2/M3 by making
 * them deterministic; halts cannot be, because §6.3 requires them to print what
 * was measured.
 *
 * The wedge is worse than "un-haltable", which is why deferring to doctor's
 * quarantine was not good enough. A strand at `r+1` blocks the SUCCESSFUL
 * publication at `r+1` too, so a workspace that halts on low disk and then has
 * disk freed can never migrate: every attempt renders a different halt, refuses
 * the occupied path, and reports a non-durable halt forever.
 *
 * The repair is bounded by the ACTUAL ownership predicate rather than a phase
 * proxy. Wave 3C's negative control proved a blanket overwrite is unsafe because
 * the M6 runway legitimately owns prepared siblings at `b+5`/`b+6` while the
 * canonical control sits at `b+4` — so those slots, and M7's terminal sibling,
 * arrive as `ownedRevisionPaths` and are refused before this function is asked.
 * Everything else at this migration's own id-and-revision-scoped path is this
 * migration's own strand.
 *
 * Two occupant shapes are admitted, and nothing else:
 *
 * - a complete record for this exact `migrationId` at this exact `revision` — a
 *   render that finished and was not renamed;
 * - a nonempty strict byte PREFIX of the record about to be written — `writeSync`
 *   fills from offset 0, so that is the only image a torn own write can leave.
 *
 * A crafted occupant is refused exactly as before.
 */
function isOwnStrand(next: MigrationControl, revision: number, found: Buffer, bytes: Buffer): boolean {
  if (found.byteLength > 0 && found.byteLength < bytes.byteLength
    && bytes.subarray(0, found.byteLength).equals(found)) {
    return true;
  }
  let decoded: MigrationControl;
  try {
    decoded = decodeMigrationControl(found);
  } catch {
    return false;
  }
  return decoded.migrationId === next.migrationId && decoded.controlRevision === revision;
}

/**
 * Replace a strand IN PLACE, on its own inode — never unlink-and-recreate. Genesis
 * case 3 and wave 3A's M2 rebuild both established this repair for the same
 * reason: a fresh inode would have to be re-recorded, and the record that names it
 * is the one being rendered.
 */
function rewriteStrand(file: string, bytes: Buffer, found: Inode): Inode {
  const fd = fs.openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const observed = fs.fstatSync(fd);
    if (!observed.isFile() || Number(observed.dev) !== found.dev || Number(observed.ino) !== found.ino) {
      return controlFail("foreign", `${file} stopped being the strand just observed`);
    }
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectorySync(path.dirname(file));
  const exact = readExactFile(file);
  if (!exact || !exact.bytes.equals(bytes) || exact.dev !== found.dev || exact.ino !== found.ino) {
    return controlFail("reread", `${file} is not the record just rewritten over its strand`);
  }
  return exact;
}
