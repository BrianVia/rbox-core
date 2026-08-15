import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { errCode } from "./fsutil.js";
import { hashBytes, hashFile } from "./hash.js";
import type { HashCache } from "./hashcache.js";
import type { FileEntry } from "./types.js";

/** errno codes for a per-file fault we DEFER (carry the last-synced entry forward,
 * retry next scan) rather than abort the whole scan on. Both classifiers take
 * `unknown` because their only input is a caught throw value, which JS gives no
 * narrower type. */
const DEFERRABLE_FILE_ERRNOS = new Set(["EACCES", "EPERM", "EIO", "ENOENT"]);
export function isDeferrableFileError(e: unknown): e is NodeJS.ErrnoException {
  const code = errCode(e);
  return typeof code === "string" && DEFERRABLE_FILE_ERRNOS.has(code);
}

/** Present-but-unreadable paths must never be projected as deletions. */
const PRESENT_BUT_UNREADABLE_ERRNOS = new Set(["EACCES", "EPERM", "EIO"]);
export function isPresentButUnreadableError(e: unknown): e is NodeJS.ErrnoException {
  const code = errCode(e);
  return typeof code === "string" && PRESENT_BUT_UNREADABLE_ERRNOS.has(code);
}

export type WatchEventKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";
export interface WatchEvent {
  /** POSIX-relative path from the sync root. */
  relPath: string;
  kind: WatchEventKind;
}

/** Discriminates a clean hash from a vanished path vs one still being written. */
export type StatHashResult = { kind: "entry"; entry: FileEntry } | { kind: "gone" } | { kind: "midwrite" };

/** Exact identity and metadata contract for accepting a stat → hash → stat tuple. */
export interface FileStatLike {
  ino: number; dev: number; size: number; mtimeMs: number; ctimeMs: number; mode: number;
  isFile(): boolean;
}

export function statsStableAcrossHash(pre: FileStatLike, post: FileStatLike): boolean {
  return pre.isFile() &&
    post.isFile() &&
    pre.ino === post.ino &&
    pre.dev === post.dev &&
    pre.size === post.size &&
    pre.mtimeMs === post.mtimeMs &&
    pre.ctimeMs === post.ctimeMs &&
    pre.mode === post.mode;
}

/**
 * Stat → hash → stat-again for a single path. Never returns a torn snapshot: if the
 * file vanished it's `gone`; if identity or metadata shifted across the hash it's
 * `midwrite` (retry, don't bake). Symlinks and non-files handled too.
 */
export async function statHashEntry(root: string, rel: string, cache?: HashCache): Promise<StatHashResult> {
  const abs = path.join(root, rel);
  let st1;
  try {
    st1 = await fs.lstat(abs);
  } catch (e) {
    if (isPresentButUnreadableError(e)) return { kind: "midwrite" };
    return { kind: "gone" };
  }
  if (st1.isSymbolicLink()) {
    let target: string;
    try { target = await fs.readlink(abs); }
    catch (e) { if (isPresentButUnreadableError(e)) return { kind: "midwrite" }; return { kind: "gone" }; }
    return { kind: "entry", entry: { path: rel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 } };
  }
  if (!st1.isFile()) return { kind: "gone" };

  const cached = cache?.lookup(rel, st1.mtimeMs, st1.size, st1.ctimeMs);
  if (cached) return { kind: "entry", entry: { path: rel, type: "file", sha256: cached, size: st1.size, mode: st1.mode & 0o777, mtimeMs: st1.mtimeMs } };

  let sha256: string;
  try { sha256 = await hashFile(abs, st1.size); }
  catch (e) { if (isDeferrableFileError(e)) return { kind: "midwrite" }; throw e; }
  let st2: Stats | undefined;
  try { st2 = await fs.lstat(abs); }
  catch (e) {
    if (isPresentButUnreadableError(e)) return { kind: "midwrite" };
    return { kind: "gone" };
  }
  if (!statsStableAcrossHash(st1, st2)) return { kind: "midwrite" };
  cache?.record(rel, { mtimeMs: st2.mtimeMs, size: st2.size, ctimeMs: st2.ctimeMs, sha256 });
  return { kind: "entry", entry: { path: rel, type: "file", sha256, size: st2.size, mode: st2.mode & 0o777, mtimeMs: st2.mtimeMs } };
}
