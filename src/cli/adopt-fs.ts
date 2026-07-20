import { dlopen, FFIType, ptr, read } from "bun:ffi";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { identitiesEqual, readAdoptIdentity, type AdoptIdentity } from "./adopt-journal.js";

const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 0x00000004;
const AT_FDCWD = -100;

type RenameNative = (fromFd: number, from: Buffer, toFd: number, to: Buffer) => number;
let nativeRename: RenameNative | undefined;
let nativeError: (() => number) | undefined;

function cString(value: string): Buffer {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\0")) throw new Error("unsafe rename leaf");
  return Buffer.from(`${value}\0`);
}

function loadNativeRename(): RenameNative {
  if (nativeRename) return nativeRename;
  if (process.platform === "linux") {
    const lib = dlopen("libc.so.6", {
      renameat2: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    nativeError = () => read.i32(Number(lib.symbols.__errno_location!()));
    nativeRename = (fromFd, from, toFd, to) => Number(lib.symbols.renameat2!(fromFd, ptr(from), toFd, ptr(to), RENAME_NOREPLACE));
    return nativeRename;
  }
  if (process.platform === "darwin") {
    const lib = dlopen("libSystem.B.dylib", {
      renameatx_np: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    nativeError = () => read.i32(Number(lib.symbols.__error!()));
    nativeRename = (fromFd, from, toFd, to) => Number(lib.symbols.renameatx_np!(fromFd, ptr(from), toFd, ptr(to), RENAME_EXCL));
    return nativeRename;
  }
  throw new Error(`adoption requires no-replace rename support on ${process.platform}`);
}

function fdPath(fd: number, leaf?: string): string {
  const root = process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`;
  return leaf === undefined ? root : path.join(root, leaf);
}

function safeParts(rel: string): string[] {
  if (rel === "" || rel === ".") return [];
  if (path.isAbsolute(rel) || rel.includes("\0") || rel.includes("\\")) throw new Error(`unsafe adoption path: ${rel}`);
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe adoption path: ${rel}`);
  return parts;
}

async function openDirectory(abs: string): Promise<fs.FileHandle> {
  return fs.open(abs, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
}

/** Open a directory chain from a held root fd. Every existing component is no-follow. */
export async function openAdoptDirectory(root: string, rel: string, create = false): Promise<fs.FileHandle> {
  let current = await openDirectory(path.resolve(root));
  try {
    for (const part of safeParts(rel)) {
      let next: fs.FileHandle;
      try {
        next = await openDirectory(fdPath(current.fd, part));
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.mkdir(fdPath(current.fd, part), { mode: 0o700 });
        await current.sync();
        next = await openDirectory(fdPath(current.fd, part));
      }
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => {});
    throw error;
  }
}

async function openedParent(root: string, rel: string, create: boolean): Promise<{ handle: fs.FileHandle; leaf: string; parentRel: string }> {
  const parts = safeParts(rel);
  const leaf = parts.pop();
  if (!leaf) throw new Error("adoption cannot rename a root directory");
  const parentRel = parts.join("/");
  return { handle: await openAdoptDirectory(root, parentRel, create), leaf, parentRel };
}

async function assertParentStillBound(root: string, parentRel: string, held: fs.FileHandle): Promise<void> {
  const reopened = await openAdoptDirectory(root, parentRel, false).catch(() => {
    throw new Error(`adoption parent identity changed: ${parentRel || "."}`);
  });
  try {
    const [expected, actual] = await Promise.all([held.stat({ bigint: true }), reopened.stat({ bigint: true })]);
    if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error(`adoption parent identity changed: ${parentRel || "."}`);
  } finally { await reopened.close(); }
}

async function identityAt(parent: fs.FileHandle, leaf: string, withContent: boolean): Promise<AdoptIdentity | undefined> {
  try {
    return await readAdoptIdentity(fdPath(parent.fd, leaf), withContent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function nativeRenameNoReplace(fromFd: number, from: string, toFd: number, to: string): void {
  const rename = loadNativeRename();
  const fromBytes = cString(from);
  const toBytes = cString(to);
  const rc = rename(fromFd, fromBytes, toFd, toBytes);
  // Keep the buffers live through the native call.
  void fromBytes.byteLength; void toBytes.byteLength;
  if (rc !== 0) {
    const errno = nativeError?.() ?? -1;
    const error = new Error(`no-replace rename failed (errno ${errno})`) as NodeJS.ErrnoException;
    error.code = errno === 17 ? "EEXIST" : errno === 18 ? "EXDEV" : errno === 38 ? "ENOSYS" : `ERRNO_${errno}`;
    throw error;
  }
}

export interface SecureMoveResult {
  sourceBefore: AdoptIdentity;
  destinationAfter: AdoptIdentity;
}

/**
 * Identity-gated, dirfd-bound, no-follow and no-clobber rename. This is the only
 * primitive adoption uses for content namespace moves.
 */
export async function secureMoveNoReplace(input: {
  sourceRoot: string;
  sourceRel: string;
  destinationRoot: string;
  destinationRel: string;
  expectedSource: AdoptIdentity;
  createDestinationParents?: boolean;
  /** Deterministic race seam; production callers never provide it. */
  beforeRename?: () => void | Promise<void>;
}): Promise<SecureMoveResult> {
  const source = await openedParent(input.sourceRoot, input.sourceRel, false);
  const destination = await openedParent(input.destinationRoot, input.destinationRel, input.createDestinationParents === true);
  try {
    const sourceBefore = await identityAt(source.handle, source.leaf, input.expectedSource.kind === "file");
    if (!identitiesEqual(input.expectedSource, sourceBefore)) throw new Error(`adoption source identity changed: ${input.sourceRel}`);
    if (await identityAt(destination.handle, destination.leaf, false)) throw new Error(`adoption destination appeared: ${input.destinationRel}`);
    await input.beforeRename?.();
    await Promise.all([
      assertParentStillBound(input.sourceRoot, source.parentRel, source.handle),
      assertParentStillBound(input.destinationRoot, destination.parentRel, destination.handle),
    ]);
    nativeRenameNoReplace(source.handle.fd, source.leaf, destination.handle.fd, destination.leaf);
    await Promise.all([source.handle.sync(), destination.handle.sync()]);
    await Promise.all([
      assertParentStillBound(input.sourceRoot, source.parentRel, source.handle),
      assertParentStillBound(input.destinationRoot, destination.parentRel, destination.handle),
    ]);
    const destinationAfter = await identityAt(destination.handle, destination.leaf, input.expectedSource.kind === "file");
    if (!identitiesEqual(input.expectedSource, destinationAfter)) throw new Error(`adoption move identity mismatch: ${input.destinationRel}`);
    return { sourceBefore: sourceBefore!, destinationAfter: destinationAfter! };
  } finally {
    await Promise.all([source.handle.close().catch(() => {}), destination.handle.close().catch(() => {})]);
  }
}

export async function createAdoptDirectory(root: string, rel: string): Promise<AdoptIdentity> {
  const handle = await openAdoptDirectory(root, rel, true);
  try {
    return await readAdoptIdentity(fdPath(handle.fd), false);
  } finally {
    await handle.close();
  }
}

export async function removeEmptyAdoptDirectory(root: string, rel: string, expected: AdoptIdentity): Promise<void> {
  const target = await openedParent(root, rel, false);
  try {
    const actual = await identityAt(target.handle, target.leaf, false);
    // Moving children through this directory necessarily changes its size and
    // timestamps. Its stable object identity (and mode) must still be exactly
    // the scaffold adoption created, and rmdir itself proves it is empty.
    if (actual?.kind !== "directory" || expected.kind !== "directory"
      || actual.dev !== expected.dev || actual.ino !== expected.ino
      || actual.birthtimeNs !== expected.birthtimeNs || actual.mode !== expected.mode) {
      throw new Error(`created directory identity changed: ${rel}`);
    }
    await fs.rmdir(fdPath(target.handle.fd, target.leaf));
    await target.handle.sync();
  } finally {
    await target.handle.close();
  }
}

/** Test-only probe proving the native primitive is callable without mutating names. */
export function adoptionNoReplaceSupported(): boolean {
  try { loadNativeRename(); return true; } catch { return false; }
}

// Exported only for a structural test: content moves must never fall back to AT_FDCWD.
export const ADOPT_RENAME_REQUIRES_DIRFD = AT_FDCWD;
