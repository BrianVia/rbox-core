import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";

/**
 * Persistent (mtime,size,ctime)->sha cache. The point is performance: re-hashing an
 * unchanged file is wasteful, and on a large `~/Development` it's the difference
 * between an invisible daemon and one that pegs the disk on every scan.
 *
 * (mtime,size,ctime) is a FAST-PATH HINT, never file identity (identity is the
 * content sha — see FileEntry). Including ctime protects foreground scans from a
 * same-size edit whose mtime is restored: the write still changes ctime, which
 * userspace cannot restore on macOS/Linux. A corrupt or old cache is safe to
 * discard — it only costs a re-hash, unlike sync STATE which must never be
 * silently reset.
 */

export interface HashCacheEntry {
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  sha256: string;
}

export type HashCacheStatIdentity = Omit<HashCacheEntry, "sha256">;

interface HashCacheFileV2 {
  version: 2;
  entries: Record<string, HashCacheEntry>;
}

const CACHE_REL = ".rbox/state/hashcache.json";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isValidEntry(e: unknown): e is HashCacheEntry {
  if (typeof e !== "object" || e === null) return false;
  const { mtimeMs, size, ctimeMs, sha256 } = e as Record<string, unknown>;
  return Number.isFinite(mtimeMs) && Number.isFinite(size) && Number.isFinite(ctimeMs) && typeof sha256 === "string" && SHA256_HEX.test(sha256);
}

export class HashCache {
  private readonly map: Map<string, HashCacheEntry>;
  private dirty = false;

  constructor(entries?: Record<string, HashCacheEntry>) {
    this.map = new Map(entries ? Object.entries(entries) : []);
  }

  /** Cached sha iff (mtime,size,ctime) match — the re-hash skip. */
  lookup(relPath: string, mtimeMs: number, size: number, ctimeMs: number): string | undefined {
    const e = this.map.get(relPath);
    if (e && e.mtimeMs === mtimeMs && e.size === size && e.ctimeMs === ctimeMs) return e.sha256;
    return undefined;
  }

  /** The complete stat identity retained for a particular scanned content hash.
   *  Consumers must still compare every returned field with the live stat. */
  statIdentity(relPath: string, sha256: string): HashCacheStatIdentity | undefined {
    const entry = this.map.get(relPath);
    if (!entry || entry.sha256 !== sha256) return undefined;
    return { mtimeMs: entry.mtimeMs, size: entry.size, ctimeMs: entry.ctimeMs };
  }

  record(relPath: string, entry: HashCacheEntry): void {
    const prev = this.map.get(relPath);
    if (prev && prev.mtimeMs === entry.mtimeMs && prev.size === entry.size && prev.ctimeMs === entry.ctimeMs && prev.sha256 === entry.sha256) return;
    this.map.set(relPath, entry);
    this.dirty = true;
  }

  /** Drop a path's entry — call when the watcher reports it changed/removed, so a
   *  same-(mtime,size,ctime) coincidence can never reuse a stale sha. */
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

  private toJSON(): HashCacheFileV2 {
    return { version: 2, entries: Object.fromEntries(this.map) };
  }

  static async load(root: string): Promise<HashCache> {
    try {
      const raw = await fs.readFile(path.join(root, CACHE_REL), "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as { version?: unknown }).version !== 2 ||
        typeof (parsed as { entries?: unknown }).entries !== "object" ||
        (parsed as { entries?: unknown }).entries === null ||
        Array.isArray((parsed as { entries?: unknown }).entries)
      ) return new HashCache();
      const entries = (parsed as HashCacheFileV2).entries;
      // One malformed entry condemns the whole file — the cache is safe-to-discard
      // by contract, and a damaged sha must never flow into a manifest.
      for (const e of Object.values(entries)) {
        if (!isValidEntry(e)) return new HashCache();
      }
      return new HashCache(entries);
    } catch {
      return new HashCache(); // missing OR corrupt cache → empty; only costs a re-hash
    }
  }

  async save(root: string, opts: { beforeRename?: () => boolean | Promise<boolean> } = {}): Promise<void> {
    if (!this.dirty) return;
    const abs = path.join(root, CACHE_REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, JSON.stringify(this.toJSON()), opts);
    this.dirty = false;
  }
}
