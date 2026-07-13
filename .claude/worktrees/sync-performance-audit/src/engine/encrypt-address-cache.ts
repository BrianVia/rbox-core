import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { isSafeRelPath } from "./manifest-validate.js";

export interface EncryptAddressCacheContext {
  accountId: string;
  workspaceId: string;
  accountEpoch: number;
  keyEpoch: number;
}

export interface EncryptAddressCacheEntry {
  encSha: string;
  cipherSize: number;
  comp?: "zstd";
  payloadSha?: string;
}

export interface StoredEncryptAddressCacheEntry extends EncryptAddressCacheEntry {
  paths: string[];
}

interface StoredEncryptAddressCache {
  version: 1;
  accountId: string;
  workspaceId: string;
  accountEpoch: number;
  keyEpoch: number;
  entries: Record<string, StoredEncryptAddressCacheEntry>;
}

export const ENCRYPT_ADDRESS_CACHE_REL = ".rbox/state/encrypt-cache.json";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const isNonNegativeInteger = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const validCompressionFields = (entry: Partial<EncryptAddressCacheEntry>): boolean => {
  if (entry.comp === undefined) return entry.payloadSha === undefined;
  return entry.comp === "zstd" && typeof entry.payloadSha === "string" && SHA256_HEX_RE.test(entry.payloadSha);
};

function cacheEntryBody(entry: EncryptAddressCacheEntry): EncryptAddressCacheEntry {
  return entry.comp ? { encSha: entry.encSha, cipherSize: entry.cipherSize, comp: entry.comp, payloadSha: entry.payloadSha } : { encSha: entry.encSha, cipherSize: entry.cipherSize };
}

function matchesContext(raw: StoredEncryptAddressCache, context: EncryptAddressCacheContext): boolean {
  return (
    raw.accountId === context.accountId &&
    raw.workspaceId === context.workspaceId &&
    raw.accountEpoch === context.accountEpoch &&
    raw.keyEpoch === context.keyEpoch
  );
}

function parseStored(raw: unknown, context: EncryptAddressCacheContext): Map<string, StoredEncryptAddressCacheEntry> | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const cache = raw as Partial<StoredEncryptAddressCache>;
  if (cache.version !== 1) return undefined;
  if (typeof cache.accountId !== "string" || typeof cache.workspaceId !== "string") return undefined;
  if (!isNonNegativeInteger(cache.accountEpoch) || !isNonNegativeInteger(cache.keyEpoch)) return undefined;
  if (!cache.entries || typeof cache.entries !== "object" || Array.isArray(cache.entries)) return undefined;
  if (!matchesContext(cache as StoredEncryptAddressCache, context)) return undefined;

  const entries = new Map<string, StoredEncryptAddressCacheEntry>();
  for (const [plaintextSha, entry] of Object.entries(cache.entries)) {
    if (!SHA256_HEX_RE.test(plaintextSha)) return undefined;
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const e = entry as Partial<StoredEncryptAddressCacheEntry>;
    if (typeof e.encSha !== "string" || !SHA256_HEX_RE.test(e.encSha)) return undefined;
    if (!isNonNegativeInteger(e.cipherSize)) return undefined;
    if (!validCompressionFields(e)) return undefined;
    if (!Array.isArray(e.paths) || e.paths.length === 0) return undefined;
    const paths = new Set<string>();
    for (const p of e.paths) {
      if (!isSafeRelPath(p) || paths.has(p)) return undefined;
      paths.add(p);
    }
    entries.set(plaintextSha, { ...cacheEntryBody(e as EncryptAddressCacheEntry), paths: [...paths].sort() });
  }
  return entries;
}

export class EncryptAddressCache {
  private readonly entries: Map<string, StoredEncryptAddressCacheEntry>;
  private readonly pathOwner = new Map<string, string>();
  private dirtyRevision = 0;
  private savedRevision = 0;

  constructor(private readonly context: EncryptAddressCacheContext, storedEntries?: Map<string, StoredEncryptAddressCacheEntry>) {
    this.entries = new Map();
    if (!storedEntries) return;

    // THE authoritative ordering for duplicate-path resolution (design 82 §3:
    // first owner in sorted-sha order wins) — parseStored is deliberately
    // order-agnostic so this sort is the single load-bearing one.
    let scrubbed = false;
    for (const plaintextSha of [...storedEntries.keys()].sort()) {
      const entry = storedEntries.get(plaintextSha)!;
      const paths = entry.paths.filter((relPath) => {
        if (this.pathOwner.has(relPath)) return false; // cross-entry duplicate — earlier owner keeps it
        this.pathOwner.set(relPath, plaintextSha);
        return true;
      });
      if (paths.length === entry.paths.length) {
        this.entries.set(plaintextSha, entry); // untouched — reuse parseStored's fresh object
        continue;
      }
      scrubbed = true;
      if (paths.length > 0) this.entries.set(plaintextSha, { ...entry, paths });
    }
    if (scrubbed) this.markDirty();
  }

  lookup(plaintextSha: string): EncryptAddressCacheEntry | undefined {
    if (!SHA256_HEX_RE.test(plaintextSha)) return undefined;
    const entry = this.entries.get(plaintextSha);
    return entry ? cacheEntryBody(entry) : undefined;
  }

  record(plaintextSha: string, entry: EncryptAddressCacheEntry & { path: string }): void {
    if (!SHA256_HEX_RE.test(plaintextSha)) throw new Error(`invalid plaintext sha for encrypt cache: ${plaintextSha}`);
    if (!SHA256_HEX_RE.test(entry.encSha)) throw new Error(`invalid ciphertext sha for encrypt cache: ${entry.encSha}`);
    if (!isNonNegativeInteger(entry.cipherSize)) throw new Error(`invalid ciphertext size for encrypt cache: ${entry.cipherSize}`);
    if (!validCompressionFields(entry)) throw new Error("invalid compression descriptor for encrypt cache");
    if (!isSafeRelPath(entry.path)) throw new Error(`invalid path for encrypt cache: ${entry.path}`);

    this.migratePath(plaintextSha, entry.path);
    const prev = this.entries.get(plaintextSha);
    const nextBody = cacheEntryBody(entry);
    if (prev) {
      const paths = new Set(prev.paths);
      const beforePaths = paths.size;
      paths.add(entry.path);
      // paths.size === beforePaths means entry.path was already in prev.paths, so by
      // the disjointness invariant pathOwner already maps it here — nothing to update.
      if (prev.encSha === nextBody.encSha && prev.cipherSize === nextBody.cipherSize && prev.comp === nextBody.comp && prev.payloadSha === nextBody.payloadSha && paths.size === beforePaths) return;
      this.entries.set(plaintextSha, { ...nextBody, paths: [...paths].sort() });
    } else {
      this.entries.set(plaintextSha, { ...nextBody, paths: [entry.path] });
    }
    this.pathOwner.set(entry.path, plaintextSha);
    this.markDirty();
  }

  migratePath(plaintextSha: string, relPath: string): boolean {
    if (!SHA256_HEX_RE.test(plaintextSha)) throw new Error(`invalid plaintext sha for encrypt cache: ${plaintextSha}`);
    if (!isSafeRelPath(relPath)) throw new Error(`invalid path for encrypt cache: ${relPath}`);
    return this.removePathFromOtherEntries(relPath, plaintextSha);
  }

  prune(livePaths: ReadonlySet<string>): void {
    for (const [plaintextSha, entry] of [...this.entries]) {
      for (const relPath of entry.paths) {
        if (!livePaths.has(relPath)) this.releasePath(plaintextSha, relPath);
      }
    }
  }

  get needsSave(): boolean {
    return this.dirtyRevision !== this.savedRevision;
  }

  private removePathFromOtherEntries(relPath: string, keepPlaintextSha: string): boolean {
    const owner = this.pathOwner.get(relPath);
    if (owner === undefined || owner === keepPlaintextSha) return false;
    this.releasePath(owner, relPath);
    return true;
  }

  /** Remove `relPath` from `owner`'s entry AND its reverse mapping — the one place
   *  entry paths shrink, so the entries↔pathOwner lockstep invariant is enforced
   *  here rather than replicated at every removal site. Deletes the entry when its
   *  last path goes. Must stay synchronous (design 82 §3: no await between the
   *  paired mutations). */
  private releasePath(owner: string, relPath: string): void {
    const entry = this.entries.get(owner)!; // invariant: pathOwner never points at a missing entry
    const next = entry.paths.filter((p) => p !== relPath);
    if (next.length === 0) this.entries.delete(owner);
    else this.entries.set(owner, { ...entry, paths: next });
    this.pathOwner.delete(relPath);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirtyRevision++;
  }

  private toJSON(): StoredEncryptAddressCache {
    const entries: Record<string, StoredEncryptAddressCacheEntry> = {};
    for (const [plaintextSha, entry] of [...this.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      entries[plaintextSha] = { ...cacheEntryBody(entry), paths: [...entry.paths].sort() };
    }
    return { version: 1, ...this.context, entries };
  }

  static async load(root: string, context: EncryptAddressCacheContext): Promise<EncryptAddressCache> {
    try {
      const raw = await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8");
      const entries = parseStored(JSON.parse(raw), context);
      return new EncryptAddressCache(context, entries);
    } catch {
      return new EncryptAddressCache(context);
    }
  }

  async save(root: string): Promise<void> {
    if (!this.needsSave) return;
    const revision = this.dirtyRevision;
    const abs = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await writeFileAtomic(abs, JSON.stringify(this.toJSON()));
    this.savedRevision = Math.max(this.savedRevision, revision);
  }
}

export class EncryptAddressCacheWriter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly root: string,
    private readonly cache: EncryptAddressCache,
    private readonly flushMs = 10_000
  ) {}

  schedule(): void {
    if (!this.cache.needsSave || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
      if (!this.cache.needsSave) return;
    }
    if (!this.cache.needsSave) return;
    this.inFlight = this.cache.save(this.root).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
    if (this.cache.needsSave) await this.flush();
  }
}
