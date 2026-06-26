import fs from "node:fs/promises";
import path from "node:path";
import { indexByPath } from "./diff.js";
import { hashBytes, hashFile } from "./hash.js";
import type { HashCache } from "./hashcache.js";
import { buildIgnoreMatcher, type IgnoreMatcher } from "./ignore.js";
import type { FileEntry, Manifest } from "./types.js";

export type WatchEventKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";
export interface WatchEvent {
  /** POSIX-relative path from the sync root. */
  relPath: string;
  kind: WatchEventKind;
}

/**
 * Walk `root`, applying ignore rules, and produce a content-hashed manifest.
 * Ignored directories are pruned (never descended into) so `node_modules` and
 * friends cost nothing. Symlinks are recorded by their target, never followed.
 *
 * With a {@link HashCache}, unchanged files (same mtime+size) skip re-hashing —
 * turning a full scan into a stat-only pass for the common case. The cache is a
 * fast-path hint only; identity is still the content sha (see FileEntry).
 */
export async function scanManifest(
  root: string,
  matcher: IgnoreMatcher = buildIgnoreMatcher(root),
  cache?: HashCache
): Promise<Manifest> {
  const files: FileEntry[] = [];
  await walk(root, "", matcher, files, cache);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { generatedAt: new Date().toISOString(), files };
}

/**
 * Patch a manifest in place from a settled batch of watcher events — the hot
 * path, O(changed) not O(repo). File add/change re-hash that one path; unlink
 * drops it; a directory unlink removes the whole `dir/**` prefix; a directory
 * add recursively scans just that subtree. A file that's mid-write (mtime/size
 * shifts across the hash) is left for the next round rather than baked torn.
 */
export async function applyWatchEvents(
  base: Manifest,
  root: string,
  matcher: IgnoreMatcher,
  events: WatchEvent[],
  cache?: HashCache
): Promise<Manifest> {
  const map = indexByPath(base);

  for (const ev of events) {
    const rel = ev.relPath;
    if (rel.length === 0) continue;

    if (ev.kind === "unlink") {
      map.delete(rel);
      cache?.invalidate(rel);
    } else if (ev.kind === "unlinkDir") {
      const prefix = `${rel}/`;
      for (const k of [...map.keys()]) {
        if (k === rel || k.startsWith(prefix)) {
          map.delete(k);
          cache?.invalidate(k);
        }
      }
    } else if (ev.kind === "addDir") {
      if (matcher.ignores(`${rel}/`)) continue;
      const sub: FileEntry[] = [];
      await walk(root, rel, matcher, sub, cache);
      for (const e of sub) map.set(e.path, e);
    } else {
      // add | change
      if (matcher.ignores(rel)) {
        map.delete(rel);
        cache?.invalidate(rel);
        continue;
      }
      const entry = await statHashEntry(root, rel, cache);
      if (entry) map.set(rel, entry);
      // entry undefined ⇒ vanished or mid-write; leave it for the next settle.
    }
  }

  const files = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { generatedAt: new Date().toISOString(), files };
}

/**
 * Stat → hash → stat-again for a single path. Returns the entry, or undefined if
 * the file vanished or is being actively written (mtime/size changed across the
 * hash) — never a torn snapshot. Symlinks and non-files handled too.
 */
async function statHashEntry(root: string, rel: string, cache?: HashCache): Promise<FileEntry | undefined> {
  const abs = path.join(root, rel);
  let st1;
  try {
    st1 = await fs.lstat(abs);
  } catch {
    return undefined; // gone
  }
  if (st1.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    return { path: rel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 };
  }
  if (!st1.isFile()) return undefined;

  const cached = cache?.lookup(rel, st1.mtimeMs, st1.size);
  if (cached) return { path: rel, type: "file", sha256: cached, size: st1.size, mode: st1.mode & 0o777, mtimeMs: st1.mtimeMs };

  const sha256 = await hashFile(abs);
  const st2 = await fs.lstat(abs);
  if (st2.mtimeMs !== st1.mtimeMs || st2.size !== st1.size) return undefined; // mid-write → defer
  cache?.record(rel, { mtimeMs: st2.mtimeMs, size: st2.size, sha256 });
  return { path: rel, type: "file", sha256, size: st2.size, mode: st2.mode & 0o777, mtimeMs: st2.mtimeMs };
}

async function walk(
  root: string,
  rel: string,
  matcher: IgnoreMatcher,
  out: FileEntry[],
  cache?: HashCache
): Promise<void> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(root, childRel);

    if (entry.isDirectory()) {
      if (matcher.ignores(`${childRel}/`)) continue;
      await walk(root, childRel, matcher, out, cache);
    } else if (entry.isSymbolicLink()) {
      if (matcher.ignores(childRel)) continue;
      const target = await fs.readlink(abs);
      out.push({
        path: childRel,
        type: "symlink",
        symlinkTarget: target,
        sha256: hashBytes(Buffer.from(target)),
        size: Buffer.byteLength(target),
        mode: 0o777,
        mtimeMs: 0,
      });
    } else if (entry.isFile()) {
      if (matcher.ignores(childRel)) continue;
      const st = await fs.stat(abs);
      const cached = cache?.lookup(childRel, st.mtimeMs, st.size);
      const sha256 = cached ?? (await hashFile(abs));
      if (!cached) cache?.record(childRel, { mtimeMs: st.mtimeMs, size: st.size, sha256 });
      out.push({
        path: childRel,
        type: "file",
        sha256,
        size: st.size,
        mode: st.mode & 0o777,
        mtimeMs: st.mtimeMs,
      });
    }
  }
}
