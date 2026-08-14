import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../engine/index.js";
import type { ContentEquivalenceCache } from "./reachability.js";

const CACHE_REL = ".rbox/state/git-content-equivalence.json";
const CACHE_VERSION = 1;
export const CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES = 4_096;

interface Entry {
  equivalent: boolean;
  accessedAtMs: number;
}

interface Persisted {
  version: number;
  entries: Record<string, Entry>;
}

const byWorkspace = new Map<string, Promise<WorkspaceContentEquivalenceCache>>();

function key(tip: string, durableRoot: string): string {
  return `${tip}:${durableRoot}`;
}

function validEntry(value: unknown): value is Entry {
  const entry = value as Entry;
  return value !== null && typeof value === "object"
    && typeof entry.equivalent === "boolean"
    && Number.isSafeInteger(entry.accessedAtMs) && entry.accessedAtMs >= 0;
}

export class WorkspaceContentEquivalenceCache implements ContentEquivalenceCache {
  private mutationVersion = 0;
  private persistedVersion = 0;
  private saveTail = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    private readonly entries: Map<string, Entry>,
    private readonly now: () => number = Date.now,
  ) {}

  get(tip: string, durableRoot: string): boolean | undefined {
    const entry = this.entries.get(key(tip, durableRoot));
    if (!entry) return undefined;
    entry.accessedAtMs = this.now();
    this.mutationVersion++;
    return entry.equivalent;
  }

  set(tip: string, durableRoot: string, equivalent: boolean): void {
    this.entries.set(key(tip, durableRoot), { equivalent, accessedAtMs: this.now() });
    this.evict();
    this.mutationVersion++;
  }

  private evict(): void {
    if (this.entries.size <= CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES) return;
    const victims = [...this.entries.entries()]
      .sort(([ak, a], [bk, b]) => a.accessedAtMs - b.accessedAtMs || ak.localeCompare(bk))
      .slice(0, this.entries.size - CONTENT_EQUIVALENCE_CACHE_MAX_ENTRIES);
    for (const [victim] of victims) this.entries.delete(victim);
  }

  async save(): Promise<void> {
    this.saveTail = this.saveTail.catch(() => {}).then(async () => {
      if (this.persistedVersion === this.mutationVersion) return;
      const version = this.mutationVersion;
      const abs = path.join(this.workspaceRoot, CACHE_REL);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const entries = Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
      await writeFileAtomic(abs, JSON.stringify({ version: CACHE_VERSION, entries } satisfies Persisted));
      this.persistedVersion = version;
    });
    return this.saveTail;
  }
}

async function load(workspaceRoot: string): Promise<WorkspaceContentEquivalenceCache> {
  const entries = new Map<string, Entry>();
  try {
    const raw = JSON.parse(await fs.readFile(path.join(workspaceRoot, CACHE_REL), "utf8")) as Partial<Persisted>;
    if (raw.version === CACHE_VERSION) {
      for (const [entryKey, entry] of Object.entries(raw.entries ?? {})) {
        if (/^[0-9a-f]{40}:[0-9a-f]{40}$/.test(entryKey) && validEntry(entry)) entries.set(entryKey, entry);
      }
    }
  } catch {
    // A cache miss is always safe.
  }
  return new WorkspaceContentEquivalenceCache(workspaceRoot, entries);
}

export function loadContentEquivalenceCache(workspaceRoot: string): Promise<WorkspaceContentEquivalenceCache> {
  const absolute = path.resolve(workspaceRoot);
  let pending = byWorkspace.get(absolute);
  if (!pending) {
    pending = load(absolute);
    byWorkspace.set(absolute, pending);
  }
  return pending;
}

export function resetContentEquivalenceCachesForTests(): void {
  byWorkspace.clear();
}
