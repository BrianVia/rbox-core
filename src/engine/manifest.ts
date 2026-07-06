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
/** How often {@link scanManifest}'s optional discovery callback fires — every Nth
 *  entry, so the caller's spinner moves during a long walk without paying a callback
 *  per file on a huge tree. */
const SCAN_PROGRESS_STRIDE = 500;

export async function scanManifest(
  root: string,
  matcher: IgnoreMatcher = buildIgnoreMatcher(root),
  cache?: HashCache,
  /** Optional discovery progress: called with the running discovered-entry count
   *  every {@link SCAN_PROGRESS_STRIDE} entries (and never with a total — a live walk
   *  has no known total). Display-only; the CLI renders it as the indeterminate
   *  `scanning… N files` phase. */
  onProgress?: (discovered: number) => void
): Promise<Manifest> {
  const files: FileEntry[] = [];
  let discovered = 0;
  const onDiscover = onProgress
    ? () => {
        if (++discovered % SCAN_PROGRESS_STRIDE === 0) onProgress(discovered);
      }
    : undefined;
  await walk(root, "", matcher, files, cache, undefined, onDiscover);
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
  cache?: HashCache,
  /** Out-param: paths that were mid-write (mtime/size shifted across the hash) and
   *  should be retried by the caller rather than left to the safety scan. */
  deferred?: Set<string>
): Promise<Manifest> {
  const map = indexByPath(base);

  for (const ev of events) {
    const rel = ev.relPath;
    if (rel.length === 0) continue;

    if (ev.kind === "unlink") {
      // A stale unlink can never delete an entry whose path is still present on
      // disk (design 50 B1): a pull-side eviction+rewrite emits an unlink for the
      // original path that may land after the rewrite. Re-derive truth from disk —
      // only a genuinely-absent path drops the entry.
      if (matcher.ignores(rel)) {
        map.delete(rel);
        cache?.invalidate(rel);
        continue;
      }
      const res = await statHashEntry(root, rel, cache);
      if (res.kind === "entry") map.set(rel, res.entry);
      else if (res.kind === "midwrite") deferred?.add(rel); // present but churning — not a delete
      else {
        map.delete(rel);
        cache?.invalidate(rel);
      }
    } else if (ev.kind === "unlinkDir") {
      // Same invariant for a directory unlink: whatever occupies the path NOW is
      // the truth. Three disk states, three answers:
      //  - still a dir → AUTHORITATIVE subtree rescan: fresh children upsert AND
      //    vanished `dir/**` entries drop (the walk is the whole truth for the
      //    subtree, not a merge);
      //  - now a file/symlink (a type flip — the pull-eviction echo, design 50 B1)
      //    → `dir/**` children are impossible under a file, drop them; the path
      //    itself re-derives from disk exactly like a stale `unlink`;
      //  - genuinely gone → drop the exact path + `dir/**` prefix.
      const prefix = `${rel}/`;
      const st = await fs.lstat(path.join(root, rel)).catch(() => undefined);
      if (st?.isDirectory()) {
        if (matcher.ignores(`${rel}/`)) continue;
        const sub: FileEntry[] = [];
        await walk(root, rel, matcher, sub, cache);
        const fresh = new Set(sub.map((e) => e.path));
        for (const k of [...map.keys()]) {
          if ((k === rel || k.startsWith(prefix)) && !fresh.has(k)) {
            map.delete(k);
            cache?.invalidate(k);
          }
        }
        for (const e of sub) map.set(e.path, e);
      } else {
        for (const k of [...map.keys()]) {
          if (k.startsWith(prefix)) {
            map.delete(k);
            cache?.invalidate(k);
          }
        }
        if (st && !matcher.ignores(rel)) {
          const res = await statHashEntry(root, rel, cache);
          if (res.kind === "entry") map.set(rel, res.entry);
          else if (res.kind === "midwrite") deferred?.add(rel);
          else {
            map.delete(rel);
            cache?.invalidate(rel);
          }
        } else {
          map.delete(rel);
          cache?.invalidate(rel);
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
      const res = await statHashEntry(root, rel, cache);
      if (res.kind === "entry") map.set(rel, res.entry);
      else if (res.kind === "midwrite") deferred?.add(rel);
      // "gone" ⇒ vanished after the event; leave it for the next unlink/settle.
    }
  }

  const files = [...map.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { generatedAt: new Date().toISOString(), files };
}

/** Discriminates a clean hash from a vanished path vs one still being written, so the
 *  caller can RETRY a mid-write on the hot path instead of waiting for the safety scan. */
type StatHashResult = { kind: "entry"; entry: FileEntry } | { kind: "gone" } | { kind: "midwrite" };

/**
 * Stat → hash → stat-again for a single path. Never returns a torn snapshot: if the
 * file vanished it's `gone`; if mtime/size shifted across the hash (active write) it's
 * `midwrite` (retry, don't bake). Symlinks and non-files handled too.
 */
async function statHashEntry(root: string, rel: string, cache?: HashCache): Promise<StatHashResult> {
  const abs = path.join(root, rel);
  let st1;
  try {
    st1 = await fs.lstat(abs);
  } catch {
    return { kind: "gone" };
  }
  if (st1.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    return { kind: "entry", entry: { path: rel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 } };
  }
  if (!st1.isFile()) return { kind: "gone" };

  const cached = cache?.lookup(rel, st1.mtimeMs, st1.size);
  if (cached) return { kind: "entry", entry: { path: rel, type: "file", sha256: cached, size: st1.size, mode: st1.mode & 0o777, mtimeMs: st1.mtimeMs } };

  const sha256 = await hashFile(abs, st1.size);
  const st2 = await fs.lstat(abs).catch(() => undefined);
  if (!st2) return { kind: "gone" };
  if (st2.mtimeMs !== st1.mtimeMs || st2.size !== st1.size) return { kind: "midwrite" };
  cache?.record(rel, { mtimeMs: st2.mtimeMs, size: st2.size, sha256 });
  return { kind: "entry", entry: { path: rel, type: "file", sha256, size: st2.size, mode: st2.mode & 0o777, mtimeMs: st2.mtimeMs } };
}

/** A cache-miss file whose hashing is deferred to a bounded-parallel batch. */
interface PendingHash {
  childRel: string;
  abs: string;
  size: number;
  mode: number;
  mtimeMs: number;
}

const HASH_CONCURRENCY = 16; // bound on parallel hashing — saturates disk without fd storms

async function walk(
  root: string,
  rel: string,
  matcher: IgnoreMatcher,
  out: FileEntry[],
  cache?: HashCache,
  pending?: PendingHash[],
  onDiscover?: () => void
): Promise<void> {
  // Top-level call owns the pending list + drains it in parallel at the end;
  // recursive calls share the same list.
  const isRoot = pending === undefined;
  const toHash = pending ?? [];

  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(root, childRel);

    if (entry.isDirectory()) {
      if (matcher.ignores(`${childRel}/`)) continue;
      await walk(root, childRel, matcher, out, cache, toHash, onDiscover);
    } else if (entry.isSymbolicLink()) {
      if (matcher.ignores(childRel)) continue;
      onDiscover?.();
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
      onDiscover?.();
      const st = await fs.stat(abs);
      const cached = cache?.lookup(childRel, st.mtimeMs, st.size);
      if (cached) {
        out.push({ path: childRel, type: "file", sha256: cached, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
      } else {
        // Defer the hash — sequential per-file hashing dominates a cold scan.
        toHash.push({ childRel, abs, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
      }
    }
  }

  if (isRoot && toHash.length > 0) await drainHashes(toHash, out, cache);
}

/** Hash the deferred cache-miss files with bounded concurrency. */
async function drainHashes(pending: PendingHash[], out: FileEntry[], cache?: HashCache): Promise<void> {
  let i = 0;
  const worker = async () => {
    for (let idx = i++; idx < pending.length; idx = i++) {
      const p = pending[idx]!;
      const sha256 = await hashFile(p.abs, p.size);
      cache?.record(p.childRel, { mtimeMs: p.mtimeMs, size: p.size, sha256 });
      out.push({ path: p.childRel, type: "file", sha256, size: p.size, mode: p.mode, mtimeMs: p.mtimeMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, pending.length) }, worker));
}
