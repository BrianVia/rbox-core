/** Never: blob fetch, decryption, or publishing (apply.ts owns those). */
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { hashBytes, hashFile } from "./hash.js";
import { claimUnclobberedName, isAbsent } from "./fsutil.js";
import { countLstat, countMkdir, countRename, mkdirCounted } from "./apply-stats.js";
import type { FileEntry } from "./types.js";

/**
 * The live on-disk state of a path an apply is about to overwrite or remove.
 *
 * Apply decides what SHOULD be at a path; this module is the only thing that says
 * what IS there. It answers three questions and nothing else: what entry does the
 * target hold right now, has it changed since we looked, and where did we put its
 * bytes when we moved them out of the way.
 */

/** A stat fingerprint of one path's bytes. `(mtimeMs, size, ctimeMs)` is the same
 *  triple the hash cache trusts to skip a re-hash (ctime is unforgeable from
 *  userspace on macOS/Linux). `dev`/`ino` join it so an atomic same-size
 *  replacement cannot evade detection on a coarse-timestamp filesystem: `rename`
 *  installs a different inode even when every timestamp ties. */
export type TargetIdentity = { dev: number; ino: number; mtimeMs: number; size: number; ctimeMs: number };

/** What the target held, plus the stat identity that reading it was based on —
 *  so a later re-stat can prove nothing moved underneath the observation. */
export type TargetObservation = { entry: FileEntry; identity: TargetIdentity };

/**
 * The on-disk entry at `rel`, or undefined if absent. Symlink targets are read,
 * not followed; directories read as undefined (we never delete/overwrite a dir as
 * if it were a file). The file is HASHED, so a stale expectation held by the
 * caller can never silently match — it can only mismatch and be preserved.
 */
export async function observeTarget(destRoot: string, rel: string): Promise<TargetObservation | undefined> {
  const abs = path.join(destRoot, rel);
  let st;
  try {
    countLstat();
    st = await fs.lstat(abs);
  } catch (e) {
    // ENOTDIR: a parent component is a file (or was evicted to trash) — the target
    // can't exist, so it's already gone.
    if (isAbsent(e)) return undefined;
    throw e;
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    const entry: FileEntry = { path: rel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 };
    return { entry, identity: identityOf(st) };
  }
  if (st.isFile()) {
    const entry: FileEntry = { path: rel, type: "file", sha256: await hashFile(abs), size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
    return { entry, identity: identityOf(st) };
  }
  return undefined; // directory or special file
}

/** The identity of file/symlink BYTES at a path, or undefined when the path holds
 *  no bytes to preserve (absent, a directory, or a special file). */
export function targetBytesIdentity(st: Stats | undefined): TargetIdentity | undefined {
  if (!st || !(st.isFile() || st.isSymbolicLink())) return undefined;
  return identityOf(st);
}

/** True when `b` is the very same bytes `a` was observed from. An absent prior
 *  observation is never "the same" as present bytes — that is a path that gained
 *  content after we looked. */
export function sameTargetIdentity(a: TargetIdentity | undefined, b: TargetIdentity): boolean {
  return a?.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ctimeMs === b.ctimeMs;
}

/**
 * Move the target out of the way, returning the path actually claimed. A conflict
 * destination must never clobber an EARLIER copy: `conflictName` has one-second
 * precision, so two conflicts on the same path in the same second (same device)
 * collide — probe and suffix `~2`, `~3`… (design 50). The claimed name is returned
 * because it, not the requested one, is what the user has to go find.
 */
export async function preserveTarget(destRoot: string, fromRel: string, toRel: string): Promise<string> {
  const from = path.join(destRoot, fromRel);
  countLstat();
  const st = await fs.lstat(from);
  // The conflict destination shares its parent directory with `toRel` (only the
  // basename gains a `~N` suffix), so the parent is created once here — the
  // caller already ran assertWithinRoot on this subtree.
  await mkdirCounted(path.dirname(path.join(destRoot, toRel)));
  return claimUnclobberedName({
    from,
    st,
    baseRel: toRel,
    toAbs: (rel) => path.join(destRoot, rel),
    hooks: { onMkdir: countMkdir, onRename: countRename },
  });
}

function identityOf(st: Stats): TargetIdentity {
  return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs };
}
