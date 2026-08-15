import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { writeFileAtomic } from "./fsutil.js";
import { isSafeRelPath } from "./manifest-validate.js";
import type { JsonValue } from "../json.js";

export const RACY_MARGIN_MS = 2_000;
export const UNPRUNED_DEADLINE_MS = 30 * 60_000;

export type ChildType = "file" | "dir" | "symlink" | "other";
export type DirCacheChild = { name: string; type: ChildType };
export type DirCacheEntry = { mtimeMs: number; ctimeMs: number; children: DirCacheChild[] };
export type RuleFileRecord =
  | { relPath: string; size: number; mtimeMs: number; ctimeMs: number }
  | { relPath: string; absent: true };
export type DircacheOutcome = "off" | "unpruned" | "deadline" | "rules-dropped" | "hit" | "cold";

export interface DirCacheFile {
  /** v2 records unsupported/special directory children as `other`.  A v1
   * listing silently omitted them and therefore cannot prove complete
   * inventory for the applied-manifest receipt. */
  version: 2;
  lastScanStartMs: number;
  lastUnprunedScanAtMs: number;
  ruleFiles: RuleFileRecord[];
  entries: Record<string, DirCacheEntry>;
}

const CACHE_REL = ".rbox/state/dircache.json";

function validNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// "" is the root-dir key; every other key/relPath uses the canonical workspace
// path-safety predicate (adds NUL/backslash/length rejection over a bespoke check).
const validRel = (value: string): boolean => value === "" || isSafeRelPath(value);

/** The single racy-clean reuse discipline shared by {@link DirCache.reuse} and the
 *  P0.2 `probeEligible` projection: the live dir timestamps must equal the cached
 *  pair AND both must be strictly older than the CACHING scan's start minus the
 *  racy margin. One source of truth so the probe can never lie about reuse. */
export function dirListingReusable(liveMtimeMs: number, liveCtimeMs: number, cachedMtimeMs: number, cachedCtimeMs: number, priorScanStartMs: number): boolean {
  const cutoff = priorScanStartMs - RACY_MARGIN_MS;
  return liveMtimeMs === cachedMtimeMs && liveCtimeMs === cachedCtimeMs && cachedMtimeMs < cutoff && cachedCtimeMs < cutoff;
}

function validRuleFile(value: JsonValue | undefined): value is RuleFileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value["relPath"] !== "string" || !validRel(value["relPath"])) return false;
  return value["absent"] === true
    ? Object.keys(value).every((key) => key === "relPath" || key === "absent")
    : validNumber(value["size"]) && validNumber(value["mtimeMs"]) && validNumber(value["ctimeMs"]);
}

function validEntry(value: JsonValue | undefined): value is DirCacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const children = value["children"];
  return validNumber(value["mtimeMs"]) && validNumber(value["ctimeMs"]) && Array.isArray(children) && children.every((child) => {
    if (!child || typeof child !== "object" || Array.isArray(child)) return false;
    const name = child["name"];
    const type = child["type"];
    return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !name.includes("/") && (type === "file" || type === "dir" || type === "symlink" || type === "other");
  });
}

function sameRuleFile(a: RuleFileRecord, b: RuleFileRecord): boolean {
  if (a.relPath !== b.relPath || ("absent" in a) !== ("absent" in b)) return false;
  return "absent" in a || (a.size === (b as typeof a).size && a.mtimeMs === (b as typeof a).mtimeMs && a.ctimeMs === (b as typeof a).ctimeMs);
}

function sameChildren(a: DirCacheChild[], b: DirCacheChild[]): boolean {
  return a.length === b.length && a.every((c, i) => c.name === b[i]!.name && c.type === b[i]!.type);
}

export function scanPruneEnabled(): boolean {
  return process.env.RBOX_SCAN_PRUNE !== "0";
}

export function coverageOf(outcome: DircacheOutcome): "full-tree" | "pruned" {
  return outcome === "hit" || outcome === "cold" ? "pruned" : "full-tree";
}

export class DirCache {
  private entries: Map<string, DirCacheEntry>;
  private loadedRuleFiles: RuleFileRecord[];
  private dirty = false;
  lastScanStartMs: number;
  lastUnprunedScanAtMs: number;
  /** Transient (never persisted): the outcome of the most recent scan through this
   *  cache. The coverage authority — a pruned scan can heal but must never testify
   *  for watcher re-trust (design 104 R1 F8). Read via {@link coverageOf}. */
  lastOutcome: DircacheOutcome = "off";

  constructor(file?: DirCacheFile) {
    this.lastScanStartMs = file?.lastScanStartMs ?? 0;
    this.lastUnprunedScanAtMs = file?.lastUnprunedScanAtMs ?? 0;
    this.loadedRuleFiles = file?.ruleFiles.map((record) => ({ ...record })) ?? [];
    this.entries = new Map(file ? Object.entries(file.entries) : []);
  }

  static async load(root: string): Promise<DirCache> {
    try {
      const parsed: JsonValue = JSON.parse(await fs.readFile(path.join(root, CACHE_REL), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new DirCache();
      const lastScanStartMs = parsed["lastScanStartMs"];
      const lastUnprunedScanAtMs = parsed["lastUnprunedScanAtMs"];
      const rawRuleFiles = parsed["ruleFiles"];
      const rawEntries = parsed["entries"];
      if (parsed["version"] !== 2 || !validNumber(lastScanStartMs) || !validNumber(lastUnprunedScanAtMs) ||
          !Array.isArray(rawRuleFiles) || !rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) return new DirCache();
      const ruleFiles: RuleFileRecord[] = [];
      for (const record of rawRuleFiles) {
        if (!validRuleFile(record)) return new DirCache();
        ruleFiles.push(record);
      }
      const entries: Record<string, DirCacheEntry> = {};
      for (const [key, entry] of Object.entries(rawEntries)) {
        if (!validRel(key) || !validEntry(entry)) return new DirCache();
        entries[key] = entry;
      }
      return new DirCache({ version: 2, lastScanStartMs, lastUnprunedScanAtMs, ruleFiles, entries });
    } catch {
      return new DirCache();
    }
  }

  async save(root: string, opts: { beforeRename?: () => boolean | Promise<boolean> } = {}): Promise<void> {
    if (!this.dirty) return;
    const abs = path.join(root, CACHE_REL);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const file: DirCacheFile = {
      version: 2,
      lastScanStartMs: this.lastScanStartMs,
      lastUnprunedScanAtMs: this.lastUnprunedScanAtMs,
      ruleFiles: this.loadedRuleFiles,
      entries: Object.fromEntries(this.entries),
    };
    await writeFileAtomic(abs, JSON.stringify(file), opts);
    this.dirty = false;
  }

  get needsSave(): boolean { return this.dirty; }
  get ruleFiles(): readonly RuleFileRecord[] { return this.loadedRuleFiles; }

  /** Reuse a cached listing iff the dir's live (mtime,ctime) equal the cached pair
   *  AND both are strictly older than the PRIOR scan's start minus the racy margin
   *  (`this.lastScanStartMs`, still the loaded/prior value during a walk — it is
   *  restamped only after the scan). Matching `probeEligible`'s discipline against
   *  the CACHING scan's start — not the current one — is load-bearing: a child
   *  add/remove that landed in the same mtime tick as the prior readdir leaves the
   *  dir's mtime ≈ that prior scan start, so anchoring the cutoff there fails it
   *  closed; anchoring on the current (later) scan start would wrongly reuse it. */
  reuse(dirRel: string, st: Stats): DirCacheChild[] | undefined {
    const entry = this.entries.get(dirRel);
    if (entry && dirListingReusable(st.mtimeMs, st.ctimeMs, entry.mtimeMs, entry.ctimeMs, this.lastScanStartMs)) return entry.children;
    return undefined;
  }

  record(dirRel: string, entry: DirCacheEntry): void {
    const previous = this.entries.get(dirRel);
    if (previous && previous.mtimeMs === entry.mtimeMs && previous.ctimeMs === entry.ctimeMs && sameChildren(previous.children, entry.children)) return;
    this.entries.set(dirRel, entry);
    this.dirty = true;
  }

  static async statRuleFile(root: string, relPath: string): Promise<RuleFileRecord> {
    try {
      const st = await fs.lstat(path.join(root, relPath));
      return { relPath, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { relPath, absent: true };
      throw error;
    }
  }

  async validateRuleInventory(root: string): Promise<boolean> {
    if (this.loadedRuleFiles.length === 0) return false;
    for (const prior of this.loadedRuleFiles) {
      if (!sameRuleFile(prior, await DirCache.statRuleFile(root, prior.relPath))) return false;
    }
    return true;
  }

  setLastScanStartMs(ms: number): void {
    if (this.lastScanStartMs !== ms) { this.lastScanStartMs = ms; this.dirty = true; }
  }

  setRuleFiles(ruleFiles: RuleFileRecord[]): void {
    if (this.loadedRuleFiles.length === ruleFiles.length && this.loadedRuleFiles.every((r, i) => sameRuleFile(r, ruleFiles[i]!))) return;
    this.loadedRuleFiles = ruleFiles;
    this.dirty = true;
  }

  /** Post-pruned-scan header stamp: advance the scan start and refresh the observed
   *  rule inventory, but NEVER touch `lastUnprunedScanAtMs` — only a genuine unpruned
   *  rebuild resets the deadline. Mirrors {@link stampUnprunedRebuild} for the pruned path. */
  stampPrunedScan(ms: number, ruleFiles: RuleFileRecord[]): void {
    this.setLastScanStartMs(ms);
    this.setRuleFiles(ruleFiles);
  }

  stampUnprunedRebuild(ms: number, ruleFiles: RuleFileRecord[]): void {
    this.lastUnprunedScanAtMs = ms;
    this.lastScanStartMs = ms;
    this.loadedRuleFiles = ruleFiles;
    this.dirty = true;
  }

  dropTable(): void {
    if (this.entries.size || this.loadedRuleFiles.length) this.dirty = true;
    this.entries.clear();
    this.loadedRuleFiles = [];
  }
}
