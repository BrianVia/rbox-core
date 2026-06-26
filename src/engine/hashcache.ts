import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

/**
 * Persistent (mtime,size)->sha cache. The point is performance: re-hashing an
 * unchanged file is wasteful, and on a large `~/Development` it's the difference
 * between an invisible daemon and one that pegs the disk on every scan.
 *
 * (mtime,size) is a FAST-PATH HINT, never file identity (identity is the content
 * sha — see FileEntry). Worst case (mtime-preserving same-size edit) we'd reuse a
 * stale sha, but the watcher invalidates a changed path's entry before the next
 * scan, so a real edit is never masked. A corrupt cache is safe to discard — it
 * only costs a re-hash, unlike sync STATE which must never be silently reset.
 */

export interface HashCacheEntry {
  mtimeMs: number;
  size: number;
  sha256: string;
}

const CACHE_REL = ".rbox/state/hashcache.json";

export class HashCache {
  private readonly map: Map<string, HashCacheEntry>;
  private dirty = false;

  constructor(entries?: Record<string, HashCacheEntry>) {
    this.map = new Map(entries ? Object.entries(entries) : []);
  }

  /** Cached sha iff (mtime,size) match — the re-hash skip. */
  lookup(relPath: string, mtimeMs: number, size: number): string | undefined {
    const e = this.map.get(relPath);
    if (e && e.mtimeMs === mtimeMs && e.size === size) return e.sha256;
    return undefined;
  }

  record(relPath: string, entry: HashCacheEntry): void {
    const prev = this.map.get(relPath);
    if (prev && prev.mtimeMs === entry.mtimeMs && prev.size === entry.size && prev.sha256 === entry.sha256) return;
    this.map.set(relPath, entry);
    this.dirty = true;
  }

  /** Drop a path's entry — call when the watcher reports it changed/removed, so a
   *  same-(mtime,size) coincidence can never reuse a stale sha. */
  invalidate(relPath: string): void {
    if (this.map.delete(relPath)) this.dirty = true;
  }

  /** Forget entries for paths that no longer exist, to bound cache growth. */
  prune(livePaths: Set<string>): void {
    for (const k of this.map.keys()) {
      if (!livePaths.has(k)) {
        this.map.delete(k);
        this.dirty = true;
      }
    }
  }

  get needsSave(): boolean {
    return this.dirty;
  }

  private toJSON(): Record<string, HashCacheEntry> {
    return Object.fromEntries(this.map);
  }

  static async load(root: string): Promise<HashCache> {
    try {
      const raw = await fs.readFile(path.join(root, CACHE_REL), "utf8");
      return new HashCache(JSON.parse(raw) as Record<string, HashCacheEntry>);
    } catch {
      return new HashCache(); // missing OR corrupt cache → empty; only costs a re-hash
    }
  }

  async save(root: string): Promise<void> {
    if (!this.dirty) return;
    const abs = path.join(root, CACHE_REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, JSON.stringify(this.toJSON()));
    this.dirty = false;
  }
}
