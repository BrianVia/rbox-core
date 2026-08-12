import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { indexByPath } from "./diff.js";
import type { DiscoveredGitRepo } from "./git-discover.js";
import { hashBytes, hashFile } from "./hash.js";
import type { HashCache } from "./hashcache.js";
import { DirCache, UNPRUNED_DEADLINE_MS, type DirCacheChild, type DircacheOutcome, type RuleFileRecord } from "./dircache.js";
import { buildIgnoreMatcher, isIgnoreRuleFile, type IgnoreMatcher } from "./ignore.js";
import { isAbsent } from "./fsutil.js";
import type { FileEntry, Manifest } from "./types.js";
import { bulkWalkDir, bulkWalkSupported, type BulkStat } from "./darwin-bulk-walk.js";
import { ScanAccounting, createScanStats, type DirProbeSink, type ScanStats } from "./manifest-accounting.js";
import { isDeferrableFileError, isPresentButUnreadableError, statHashEntry, statsStableAcrossHash, type FileStatLike, type StatHashResult, type WatchEvent } from "./manifest-observation.js";
export { createScanStats, type DirProbeSample, type DirProbeSink, type ScanAttemptStats, type ScanResidualBuckets, type ScanStats, type ScanTimingStats } from "./manifest-accounting.js";
export { isPresentButUnreadableError, statsStableAcrossHash, type WatchEvent, type WatchEventKind } from "./manifest-observation.js";

/**
 * Walk `root`, applying ignore rules, and produce a content-hashed manifest.
 * Ignored directories are pruned (never descended into) so `node_modules` and
 * friends cost nothing. Symlinks are recorded by their target, never followed.
 *
 * With a {@link HashCache}, unchanged files (same mtime+size+ctime) skip re-hashing —
 * turning a full scan into a stat-only pass for the common case. The cache is a
 * fast-path hint only; identity is still the content sha (see FileEntry).
 * Per-file IO faults are deferred so callers can carry the last-synced entry
 * forward; directory enumeration failures remain fatal because the scan cannot
 * safely establish what exists below an unenumerable directory.
 */
/** How often {@link scanManifest}'s optional discovery callback fires — every Nth
 *  entry, so the caller's spinner moves during a long walk without paying a callback
 *  per file on a huge tree. */
const SCAN_PROGRESS_STRIDE = 500;

export async function scanManifest(
  root: string,
  matcher: IgnoreMatcher = buildIgnoreMatcher(root),
  cache?: HashCache,
  /** Optional discovery progress: called with the running discovered-entry count and
   *  payload bytes every {@link SCAN_PROGRESS_STRIDE} entries, plus a final partial
   *  stride (and never with a total — a live walk has no known total). Display-only;
   *  the CLI renders it as the indeterminate `scanning… N files · N GB` phase. */
  onProgress?: (discovered: number, bytesDiscovered: number) => void,
  /** Optional git repo discovery hook. Fires for `.git` directories and gitfile
   *  pointers before the hard `.git` ignore prune, so callers can avoid a second
   *  full workspace walk. */
  onGitRepo?: (repo: DiscoveredGitRepo) => void,
  /** Optional metrics sink. Readdir/sort/hash timing is batched at the operation
   *  level; stat and matcher timing stays at the checked-entry level because the
   *  current walk interleaves them with pruning and recursion. */
  scanStats?: ScanStats,
  /** Out-param: files that changed between discovery and their deferred hash, or
   *  hit a per-file IO fault and must carry their last-synced entry forward. */
  deferred?: Set<string>,
  dirProbe?: DirProbeSink,
  dircache?: DirCache,
  mode: "pruned" | "unpruned" = "unpruned",
  /** Optional privacy-safe reporter for deferred per-file IO faults. Receives only
   *  the errno string, never a path. */
  onDeferErrno?: (code: string) => void,
  warningSink?: (line: string) => void,
): Promise<Manifest> {
  // The disabled path retains exactly one monotonic stamp. All bucket reads are
  // behind the optional ScanStats sink.
  const monotonicScanStart = performance.now();
  const scanStartMs = Date.now();
  const accounting = scanStats ? new ScanAccounting(scanStats, monotonicScanStart, dircache ? mode : "off") : undefined;
  if (!dircache) {
    const files: FileEntry[] = [];
    if (scanStats) { scanStats.dircacheOutcome = "off"; scanStats.dirsReusedFromCache = 0; }
    const ctx = makeWalkCtx({ root, matcher, cache, mode: "off", scanStartMs, scanStats, accounting, deferred, dirProbe, onProgress, onGitRepo, onDeferErrno, warningSink });
    await runWalk(ctx, "", files);
    sortManifestFiles(files, accounting);
    const manifest = accounting
      ? accounting.sync("finalizationMs", () => ({ generatedAt: new Date().toISOString(), files }))
      : { generatedAt: new Date().toISOString(), files };
    accounting?.finish();
    return manifest;
  }

  const priorRuleFiles = new Set(dircache.ruleFiles.map((record) => record.relPath));
  let effectiveMode: "pruned" | "unpruned" = mode;
  let outcome: DircacheOutcome = mode === "unpruned" ? "unpruned" : "cold";
  if (mode === "pruned") {
    // Self-demotion classification only — the walk loop drops the table for ANY
    // unpruned effective mode (`if (effectiveMode === "unpruned") dircache.dropTable()`),
    // so an extra drop here would be redundant.
    if (dircache.lastScanStartMs > scanStartMs || dircache.lastUnprunedScanAtMs > scanStartMs ||
        dircache.lastUnprunedScanAtMs === 0 || scanStartMs - dircache.lastUnprunedScanAtMs > UNPRUNED_DEADLINE_MS) {
      effectiveMode = "unpruned"; outcome = "deadline";
    } else if (!(accounting
      ? await accounting.async("rulePrevalidationMs", () => dircache.validateRuleInventory(root))
      : await dircache.validateRuleInventory(root))) {
      effectiveMode = "unpruned"; outcome = "rules-dropped";
    }
  }
  accounting?.setMode(effectiveMode);

  let winningStats = createScanStats();
  let winningCtx: WalkCtx;
  let files: FileEntry[];
  for (let attempt = 0; ; attempt++) {
    files = [];
    winningStats = createScanStats();
    winningCtx = makeWalkCtx({ root, matcher, cache, dircache, mode: effectiveMode, scanStartMs, scanStats: winningStats, accounting, deferred, dirProbe, onProgress, onGitRepo, onDeferErrno, warningSink, priorRuleFiles });
    if (effectiveMode === "unpruned") {
      if (accounting) accounting.sync("directoryMs", () => dircache.dropTable());
      else dircache.dropTable();
    }
    try {
      await runWalk(winningCtx, "", files);
      // Post-walk rule re-validation (§3.1 fix 1): pre-walk validation only proves
      // the inventory was intact when the walk STARTED. A rule file EDITED (or
      // removed) mid-walk — after its dir was already traversed/reused — would
      // otherwise be silently absorbed into the new inventory and never flagged,
      // masking the change on the NEXT scan (which would then validate the new
      // metadata and keep pruning under the changed rules). Re-validate the SAME
      // prior inventory (still loaded until we restamp below); any disagreement
      // forces the bounded unpruned restart. Appearance is already caught mid-walk;
      // disappearance/edit is caught here (and pre-walk).
      if (effectiveMode === "pruned" && !(accounting
        ? await accounting.async("rulePostvalidationMs", () => dircache.validateRuleInventory(root))
        : await dircache.validateRuleInventory(root))) throw new RulesChangedDuringPrune();
      break;
    } catch (error) {
      if (!(error instanceof RulesChangedDuringPrune) || attempt > 0) throw error;
      effectiveMode = "unpruned";
      outcome = "rules-dropped";
      if (accounting) {
        accounting.sync("directoryMs", () => dircache.dropTable());
        accounting.retry("unpruned");
      } else dircache.dropTable();
    }
  }

  sortManifestFiles(files, accounting);
  const ruleFiles = accounting
    ? await accounting.async("ruleRebuildMs", () => buildRuleFiles(root, winningCtx!.observedRuleFiles))
    : await buildRuleFiles(root, winningCtx!.observedRuleFiles);
  if (effectiveMode === "unpruned") {
    if (accounting) accounting.sync("directoryMs", () => dircache.stampUnprunedRebuild(scanStartMs, ruleFiles));
    else dircache.stampUnprunedRebuild(scanStartMs, ruleFiles);
  }
  else {
    if (accounting) accounting.sync("directoryMs", () => dircache.stampPrunedScan(scanStartMs, ruleFiles));
    else dircache.stampPrunedScan(scanStartMs, ruleFiles);
    outcome = winningStats.dirsReusedFromCache > 0 ? "hit" : "cold";
  }
  const manifest = accounting
    ? accounting.sync("finalizationMs", () => {
        winningStats.dircacheOutcome = outcome;
        // Record coverage-bearing outcome on the dircache itself (the thing that made the
        // pruning decision) so callers derive watcher-re-trust coverage from a first-class
        // source, never from the OPTIONAL metrics struct.
        dircache.lastOutcome = outcome;
        if (scanStats) mergeWinningStats(scanStats, winningStats);
        return { generatedAt: new Date().toISOString(), files };
      })
    : (() => {
        winningStats.dircacheOutcome = outcome;
        dircache.lastOutcome = outcome;
        if (scanStats) mergeWinningStats(scanStats, winningStats);
        return { generatedAt: new Date().toISOString(), files };
      })();
  accounting?.finish();
  return manifest;
}

/** The manifest's canonical path order — plain byte-wise ascending, the SINGLE
 *  definition every producer and consumer of a sorted `files` array shares. Exported
 *  so a patch that merges into an already-sorted manifest (design 202) can rely on
 *  the same order the scan established instead of re-sorting to guess it. */
export function compareManifestPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortManifestFiles(files: FileEntry[], accounting?: ScanAccounting): void {
  if (accounting) accounting.sync("sortMs", () => files.sort((a, b) => compareManifestPaths(a.path, b.path)));
  else files.sort((a, b) => compareManifestPaths(a.path, b.path));
}

function mergeWinningStats(target: ScanStats, source: ScanStats): void {
  for (const key of ["dirsWalked", "filesStatted", "filesSkippedCacheHit", "filesHashed"] as const) target[key] += source[key];
  target.dirsReusedFromCache = source.dirsReusedFromCache;
  target.dircacheOutcome = source.dircacheOutcome;
}

async function buildRuleFiles(root: string, observed: Set<string>): Promise<RuleFileRecord[]> {
  observed.add(".gitignore");
  observed.add(".rboxignore");
  return Promise.all([...observed].sort().map((relPath) => DirCache.statRuleFile(root, relPath)));
}

/** Per-scan inputs to {@link makeWalkCtx}; a named object so the many optional
 *  same-typed args cannot be transposed at a call site. */
interface WalkCtxOptions {
  root: string;
  matcher: IgnoreMatcher;
  cache?: HashCache;
  dircache?: DirCache;
  mode: WalkCtx["mode"];
  scanStartMs: number;
  scanStats?: ScanStats;
  accounting?: ScanAccounting;
  deferred?: Set<string>;
  dirProbe?: DirProbeSink;
  onProgress?: (discovered: number, bytesDiscovered: number) => void;
  onGitRepo?: (repo: DiscoveredGitRepo) => void;
  onDeferErrno?: (code: string) => void;
  warningSink?: (line: string) => void;
  priorRuleFiles?: Set<string>;
}

function makeWalkCtx(o: WalkCtxOptions): WalkCtx {
  let discovered = 0;
  let bytesDiscovered = 0;
  const onProgress = o.onProgress;
  let lastEmitted = 0;
  const onDiscover = onProgress
    ? (bytes: number) => {
        bytesDiscovered += bytes;
        if (++discovered % SCAN_PROGRESS_STRIDE === 0) {
          lastEmitted = discovered;
          if (o.accounting) o.accounting.observe(() => onProgress(discovered, bytesDiscovered));
          else onProgress(discovered, bytesDiscovered);
        }
      }
    : undefined;
  return {
    root: o.root, matcher: o.matcher, cache: o.cache, dircache: o.dircache, mode: o.mode,
    scanStartMs: o.scanStartMs, scanStats: o.scanStats, accounting: o.accounting, deferred: o.deferred, dirProbe: o.dirProbe,
    onDiscover,
    flushProgress: onProgress ? () => {
      if (discovered <= lastEmitted) return;
      if (o.accounting) o.accounting.observe(() => onProgress(discovered, bytesDiscovered));
      else onProgress(discovered, bytesDiscovered);
    } : undefined,
    onGitRepo: o.onGitRepo, onDeferErrno: o.onDeferErrno, warningSink: o.warningSink, priorRuleFiles: o.priorRuleFiles ?? new Set(), observedRuleFiles: new Set(),
  };
}

/**
 * Design 224 §2.2 / founder ruling F1: a symlink is ignored iff a directory of the
 * same name would be. Every `BUILTIN_IGNORE` dir pattern carries a trailing slash,
 * which gitignore semantics match against directories only — so a symlink named
 * `node_modules` slipped through. Answered at the two local producers that already
 * know the entry type; `IgnoreMatcher` keeps its signature, and a regular FILE
 * named `dist`/`build`/`target` still syncs.
 */
function symlinkIgnored(matcher: IgnoreMatcher, rel: string): boolean {
  return matcher.ignores(rel) || matcher.ignores(`${rel}/`);
}

/**
 * Patch a manifest in place from a settled batch of watcher events — the hot
 * path, O(changed) not O(repo). File add/change re-hash that one path; unlink
 * drops it; a directory unlink removes the whole `dir/**` prefix; a directory
 * add recursively scans just that subtree. A file that's mid-write (stats
 * shifted across the hash) is left for the next round rather than baked torn.
 */
export async function applyWatchEvents(
  base: Manifest,
  root: string,
  matcher: IgnoreMatcher,
  events: WatchEvent[],
  cache?: HashCache,
  /** Out-param: paths that were mid-write (stats shifted across the hash) and
   *  should be retried by the caller rather than left to the safety scan. */
  deferred?: Set<string>
): Promise<Manifest> {
  const map = indexByPath(base);
  // A watcher event carries no file-vs-symlink fact, so the pre-stat `ignores(rel)`
  // above cannot answer the directory-form question. `statHashEntry` is the second
  // local producer: drop its result once the type is known (design 224 §2.2).
  const dropAsIgnoredSymlink = (rel: string, res: StatHashResult): boolean =>
    res.kind === "entry" && res.entry.type === "symlink" && matcher.ignores(`${rel}/`);

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
      if (res.kind === "entry" && !dropAsIgnoredSymlink(rel, res)) map.set(rel, res.entry);
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
      let st: Stats | undefined;
      try { st = await fs.lstat(path.join(root, rel)); }
      catch (e) {
        if (isPresentButUnreadableError(e)) {
          // Unreadable, not absent: keep every prior entry under rel untouched and let the
          // caller retry — a permission fault must never convert a subtree into deletions.
          deferred?.add(rel);
          continue;
        }
        st = undefined;
      }
      if (st?.isDirectory()) {
        if ((matcher.prunes?.(`${rel}/`) ?? matcher.ignores(`${rel}/`))) continue;
        const sub: FileEntry[] = [];
        // A child the walk deferred (mutated during its hash) is absent from `sub`
        // because it's UNSTABLE, not gone — keep its prior entry out of the
        // authoritative-subtree cleanup, and surface it for the caller's retry.
        const subDeferred = new Set<string>();
        const ctx = makeWalkCtx({ root, matcher, cache, mode: "off", scanStartMs: Date.now(), deferred: subDeferred });
        await runWalk(ctx, rel, sub);
        const fresh = new Set(sub.map((e) => e.path));
        for (const k of [...map.keys()]) {
          if ((k === rel || k.startsWith(prefix)) && !fresh.has(k) && !subDeferred.has(k)) {
            map.delete(k);
            cache?.invalidate(k);
          }
        }
        for (const e of sub) map.set(e.path, e);
        for (const p of subDeferred) deferred?.add(p);
      } else {
        for (const k of [...map.keys()]) {
          if (k.startsWith(prefix)) {
            map.delete(k);
            cache?.invalidate(k);
          }
        }
        if (st && !matcher.ignores(rel)) {
          const res = await statHashEntry(root, rel, cache);
          if (res.kind === "entry" && !dropAsIgnoredSymlink(rel, res)) map.set(rel, res.entry);
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
      if ((matcher.prunes?.(`${rel}/`) ?? matcher.ignores(`${rel}/`))) continue;
      const sub: FileEntry[] = [];
      const ctx = makeWalkCtx({ root, matcher, cache, mode: "off", scanStartMs: Date.now(), deferred });
      await runWalk(ctx, rel, sub);
      for (const e of sub) map.set(e.path, e);
    } else {
      // add | change
      if (matcher.ignores(rel)) {
        map.delete(rel);
        cache?.invalidate(rel);
        continue;
      }
      const res = await statHashEntry(root, rel, cache);
      if (dropAsIgnoredSymlink(rel, res)) {
        map.delete(rel);
        cache?.invalidate(rel);
      } else if (res.kind === "entry") map.set(rel, res.entry);
      else if (res.kind === "midwrite") deferred?.add(rel);
      // "gone" ⇒ vanished after the event; leave it for the next unlink/settle.
    }
  }

  const files = [...map.values()].sort((a, b) => compareManifestPaths(a.path, b.path));
  return { generatedAt: new Date().toISOString(), files };
}

/** A cache-miss file whose hashing is deferred to a bounded-parallel batch. */
interface PendingHash {
  childRel: string;
  abs: string;
  st: FileStatLike;
}

const HASH_CONCURRENCY = 16; // bound on parallel hashing — saturates disk without fd storms

interface WalkCtx {
  root: string;
  matcher: IgnoreMatcher;
  cache?: HashCache;
  dircache?: DirCache;
  mode: "pruned" | "unpruned" | "off";
  scanStartMs: number;
  scanStats?: ScanStats;
  accounting?: ScanAccounting;
  deferred?: Set<string>;
  dirProbe?: DirProbeSink;
  onDiscover?: (bytes: number) => void;
  flushProgress?: () => void;
  onGitRepo?: (repo: DiscoveredGitRepo) => void;
  onDeferErrno?: (code: string) => void;
  warningSink?: (line: string) => void;
  priorRuleFiles: Set<string>;
  observedRuleFiles: Set<string>;
}

/** Defer a per-file fault (add to the deferred set, report errno-only) — returns
 *  false for a non-deferrable error the caller must rethrow. */
function deferWalkFault(ctx: WalkCtx, childRel: string, error: unknown): boolean {
  if (!isDeferrableFileError(error)) return false;
  ctx.deferred?.add(childRel);
  if (ctx.onDeferErrno) {
    if (ctx.accounting) ctx.accounting.observe(() => ctx.onDeferErrno!(error.code!));
    else ctx.onDeferErrno(error.code!);
  }
  return true;
}

class RulesChangedDuringPrune extends Error {}

export function scanBulkEnabled(): boolean {
  return process.env.RBOX_SCAN_BULK === "1";
}

async function walk(
  ctx: WalkCtx,
  rel: string,
  out: FileEntry[],
  toHash: PendingHash[],
  discoveryPruned: boolean
): Promise<void> {
  const absDir = path.join(ctx.root, rel);
  let dirStat: Stats | undefined;
  let children: DirCacheChild[] | undefined;
  let bulkStats: Map<string, BulkStat> | undefined;
  if (ctx.mode !== "off" && ctx.dircache) {
    dirStat = ctx.accounting
      ? await ctx.accounting.async("directoryMs", () => fs.lstat(absDir))
      : await fs.lstat(absDir);
    if (ctx.mode === "pruned") {
      children = ctx.accounting
        ? ctx.accounting.sync("directoryMs", () => ctx.dircache!.reuse(rel, dirStat!))
        : ctx.dircache.reuse(rel, dirStat);
    }
  }
  const reused = children !== undefined;
  let rawEntryCount = children?.length ?? 0;
  // Probe projection is INDEPENDENT of the traversal listing: the P0.2 sidecar
  // (RBOX_SCAN_PROBE, separate from Layer A) counts every readdir entry — including
  // fifos/sockets/devices, mapped to "file" — exactly as before Layer A, so its
  // projectedBytes stays byte-identical. The dircache stores only file/dir/symlink.
  let probeProjectedBytes = 0;
  const readdirStart = ctx.dirProbe && !reused ? Date.now() : 0;
  if (reused) {
    if (ctx.scanStats) ctx.scanStats.dirsReusedFromCache += 1;
  } else {
    if (scanBulkEnabled() && !ctx.dirProbe && bulkWalkSupported()) {
      const timedWarningSink = ctx.warningSink && ctx.accounting
        ? (line: string) => ctx.accounting!.observe(() => ctx.warningSink!(line))
        : ctx.warningSink;
      const bulk = ctx.accounting
        ? ctx.accounting.sync("readdirMs", () => bulkWalkDir(absDir, timedWarningSink))
        : bulkWalkDir(absDir, ctx.warningSink);
      if (bulk !== null) {
        const converted = () => {
          children = bulk.map(({ name, type }) => ({ name, type }));
          bulkStats = new Map(bulk.flatMap((child) => child.type === "file" && child.stat ? [[child.name, child.stat]] : []));
        };
        if (ctx.accounting) ctx.accounting.sync("readdirMs", converted);
        else converted();
        rawEntryCount = bulk.length;
        if (ctx.scanStats) {
          ctx.scanStats.dirsWalked += 1;
        }
      }
    }
    if (children === undefined) {
      // Deliberate fail-loud boundary (design 108): an unenumerable directory aborts
      // the scan — per-file faults defer, but the walk cannot know what lives below.
      const entries = ctx.accounting
        ? await ctx.accounting.async("readdirMs", () => fs.readdir(absDir, { withFileTypes: true }))
        : await fs.readdir(absDir, { withFileTypes: true });
      if (ctx.scanStats) {
        ctx.scanStats.dirsWalked += 1;
      }
      rawEntryCount = entries.length;
      const convert = () => {
        children = entries.map((entry): DirCacheChild => entry.isDirectory()
          ? { name: entry.name, type: "dir" }
          : entry.isSymbolicLink() ? { name: entry.name, type: "symlink" }
          : entry.isFile() ? { name: entry.name, type: "file" }
          : { name: entry.name, type: "other" });
        if (ctx.dirProbe) probeProjectedBytes = Buffer.byteLength(JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file" }))));
      };
      if (ctx.accounting) ctx.accounting.sync("readdirMs", convert);
      else convert();
    }
    if (ctx.dircache && dirStat) {
      if (ctx.accounting) ctx.accounting.sync("directoryMs", () => ctx.dircache!.record(rel, { mtimeMs: dirStat!.mtimeMs, ctimeMs: dirStat!.ctimeMs, children: children! }));
      else ctx.dircache.record(rel, { mtimeMs: dirStat.mtimeMs, ctimeMs: dirStat.ctimeMs, children: children! });
    }
  }
  if (ctx.dirProbe && !reused) {
    const readdirMs = Date.now() - readdirStart;
    const overheadStart = Date.now();
    const st = dirStat ?? (ctx.accounting
      ? await ctx.accounting.async("directoryMs", () => fs.lstat(absDir))
      : await fs.lstat(absDir));
    const sample = {
      key: hashBytes(Buffer.from(rel)).slice(0, 16),
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      readdirMs,
      childCount: rawEntryCount,
      projectedBytes: probeProjectedBytes,
    };
    if (ctx.accounting) ctx.accounting.observe(() => ctx.dirProbe!.record(sample));
    else ctx.dirProbe.record(sample);
    ctx.dirProbe.probeOverheadMs += Date.now() - overheadStart;
  }
  // Path construction is pure and directory-local, so the enabled path times
  // one batch rather than two clock reads per entry. The disabled path keeps the
  // allocation-free loop used before instrumentation.
  const preparedPaths = ctx.accounting
    ? ctx.accounting.sync("pathMs", () => children!.map((child) => {
        const childRel = rel ? `${rel}/${child.name}` : child.name;
        return { childRel, abs: path.join(ctx.root, childRel) };
      }))
    : undefined;
  for (let childIndex = 0; childIndex < children!.length; childIndex++) {
    const child = children![childIndex]!;
    const prepared = preparedPaths?.[childIndex];
    const childRel = prepared?.childRel ?? (rel ? `${rel}/${child.name}` : child.name);
    const abs = prepared?.abs ?? path.join(ctx.root, childRel);
    // Rule-file inventory tracking is dircache-only; skip the per-child string work
    // entirely on the "off" (no-dircache) path so it stays zero-new-work.
    if (ctx.mode !== "off" && isIgnoreRuleFile(childRel)) {
      ctx.observedRuleFiles.add(childRel);
      if (!reused && ctx.mode === "pruned" && !ctx.priorRuleFiles.has(childRel)) throw new RulesChangedDuringPrune();
    }
    if (child.name === ".git") {
      const discover = (): DiscoveredGitRepo | undefined => {
        if (discoveryPruned || (child.type !== "dir" && child.type !== "file")) return undefined;
        return { relPath: rel === "" ? "." : rel, kind: child.type === "dir" ? "dir" : "pointer" };
      };
      const repo = ctx.accounting ? ctx.accounting.sync("gitDiscoveryMs", discover) : discover();
      if (repo && ctx.onGitRepo) {
        if (ctx.accounting) ctx.accounting.observe(() => ctx.onGitRepo!(repo));
        else ctx.onGitRepo(repo);
      }
    }

    if (child.type === "dir") {
      const childDir = `${childRel}/`;
      const childDiscoveryPruned =
        discoveryPruned ||
        (ctx.accounting
          ? timedMatcher(ctx.accounting, () => ctx.matcher.prunesForGitDiscovery?.(childDir) ?? ctx.matcher.ignores(childDir))
          : ctx.matcher.prunesForGitDiscovery?.(childDir) ?? ctx.matcher.ignores(childDir));
      if (ctx.accounting ? timedMatcher(ctx.accounting, () => ctx.matcher.prunes?.(childDir) ?? ctx.matcher.ignores(childDir)) : ctx.matcher.prunes?.(childDir) ?? ctx.matcher.ignores(childDir)) continue;
      try {
        await walk(ctx, childRel, out, toHash, childDiscoveryPruned);
      } catch (error) {
        if (reused && isAbsent(error)) continue;
        throw error;
      }
    } else if (child.type === "symlink") {
      const linkIgnored = () => symlinkIgnored(ctx.matcher, childRel);
      if (ctx.accounting ? timedMatcher(ctx.accounting, linkIgnored) : linkIgnored()) continue;
      let targetAndHash: { target: string; sha256: string; size: number };
      try {
        const read = async () => {
          const target = await fs.readlink(abs);
          return { target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target) };
        };
        targetAndHash = ctx.accounting ? await ctx.accounting.async("symlinkMs", read) : await read();
      }
      catch (error) {
        if (deferWalkFault(ctx, childRel, error)) continue;
        throw error;
      }
      ctx.onDiscover?.(targetAndHash.size);
      const append = () => out.push({
        path: childRel, type: "symlink", symlinkTarget: targetAndHash.target,
        sha256: targetAndHash.sha256, size: targetAndHash.size, mode: 0o777, mtimeMs: 0,
      });
      if (ctx.accounting) ctx.accounting.sync("entryMs", append);
      else append();
    } else if (child.type === "file") {
      if (ctx.accounting ? timedMatcher(ctx.accounting, () => ctx.matcher.ignores(childRel)) : ctx.matcher.ignores(childRel)) continue;
      let st: FileStatLike | undefined = bulkStats?.get(child.name);
      if (!st && ctx.accounting) {
        try {
          st = await ctx.accounting.async("statMs", () => fs.stat(abs));
        } catch (error) {
          if (deferWalkFault(ctx, childRel, error)) continue;
          throw error;
        }
      } else if (!st) {
        try { st = await fs.stat(abs); }
        catch (error) {
          if (deferWalkFault(ctx, childRel, error)) continue;
          throw error;
        }
      }
      ctx.onDiscover?.(st.size);
      if (ctx.scanStats) ctx.scanStats.filesStatted += 1;
      const cached = ctx.cache
        ? ctx.accounting
          ? ctx.accounting.sync("statMs", () => ctx.cache!.lookup(childRel, st!.mtimeMs, st!.size, st!.ctimeMs))
          : ctx.cache.lookup(childRel, st.mtimeMs, st.size, st.ctimeMs)
        : undefined;
      if (cached) {
        if (ctx.scanStats) ctx.scanStats.filesSkippedCacheHit += 1;
        const append = () => out.push({ path: childRel, type: "file" as const, sha256: cached, size: st!.size, mode: st!.mode & 0o777, mtimeMs: st!.mtimeMs });
        if (ctx.accounting) ctx.accounting.sync("entryMs", append);
        else append();
      } else {
        // Defer the hash — sequential per-file hashing dominates a cold scan.
        toHash.push({ childRel, abs, st });
      }
    } else {
      // FIFOs/sockets/devices are not syncable manifest entries, but retaining
      // them in the directory cache is load-bearing for consumers that must
      // distinguish "absent" from "present but unrepresentable".
      continue;
    }
  }
}

async function finishHashes(ctx: WalkCtx, pending: PendingHash[], out: FileEntry[]): Promise<void> {
  if (pending.length === 0) return;
  if (ctx.scanStats) ctx.scanStats.filesHashed += pending.length;
  const onDeferErrno = ctx.onDeferErrno && ctx.accounting
    ? (code: string) => ctx.accounting!.observe(() => ctx.onDeferErrno!(code))
    : ctx.onDeferErrno;
  const hashed = ctx.accounting
    ? await ctx.accounting.async("hashMs", () => hashPending(pending, ctx.deferred, onDeferErrno))
    : await hashPending(pending, ctx.deferred, onDeferErrno);
  const stable = ctx.accounting
    ? await ctx.accounting.async("statMs", () => statHashed(hashed, ctx.deferred))
    : await statHashed(hashed, ctx.deferred);
  const recordCache = () => {
    if (!ctx.cache) return;
    for (const result of stable) ctx.cache.record(result.pending.childRel, {
      mtimeMs: result.post.mtimeMs,
      size: result.post.size,
      ctimeMs: result.post.ctimeMs,
      sha256: result.sha256,
    });
  };
  if (ctx.accounting) ctx.accounting.sync("statMs", recordCache);
  else recordCache();
  const allocateEntries = () => {
    for (const result of stable) out.push({
      path: result.pending.childRel,
      type: "file",
      sha256: result.sha256,
      size: result.post.size,
      mode: result.post.mode & 0o777,
      mtimeMs: result.post.mtimeMs,
    });
  };
  if (ctx.accounting) ctx.accounting.sync("entryMs", allocateEntries);
  else allocateEntries();
}

/** The "make a pending list, walk from `rel`, drain the deferred hashes" sequence
 *  every top-level walk shares. `discoveryPruned` starts false at the top level. */
async function runWalk(ctx: WalkCtx, rel: string, out: FileEntry[]): Promise<void> {
  const toHash: PendingHash[] = [];
  await walk(ctx, rel, out, toHash, false);
  await finishHashes(ctx, toHash, out);
  ctx.flushProgress?.();
}

function timedMatcher(accounting: ScanAccounting, fn: () => boolean): boolean {
  return accounting.sync("matcherMs", fn);
}

interface HashedPending {
  pending: PendingHash;
  sha256: string;
}

interface StableHash extends HashedPending {
  post: Stats;
}

/** Hash the deferred cache-miss files with bounded concurrency. */
async function hashPending(pending: PendingHash[], deferred?: Set<string>, onDeferErrno?: (code: string) => void): Promise<HashedPending[]> {
  const hashed: Array<HashedPending | undefined> = new Array(pending.length);
  let i = 0;
  const worker = async () => {
    for (let idx = i++; idx < pending.length; idx = i++) {
      const p = pending[idx]!;
      try {
        hashed[idx] = { pending: p, sha256: await hashFile(p.abs, p.st.size) };
      } catch (e) {
        if (!isDeferrableFileError(e)) throw e;
        deferred?.add(p.childRel);
        onDeferErrno?.(e.code!);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, pending.length) }, worker));
  return hashed.filter((result): result is HashedPending => result !== undefined);
}

/** Post-hash metadata is a distinct bounded phase so concurrent worker overlap
 * cannot double-count it into the regular-file read/hash bucket. */
async function statHashed(hashed: HashedPending[], deferred?: Set<string>): Promise<StableHash[]> {
  const stable: Array<StableHash | undefined> = new Array(hashed.length);
  let i = 0;
  const worker = async () => {
    for (let idx = i++; idx < hashed.length; idx = i++) {
      const result = hashed[idx]!;
      const post = await fs.lstat(result.pending.abs).catch(() => undefined);
      if (!post || !statsStableAcrossHash(result.pending.st, post)) {
        deferred?.add(result.pending.childRel);
        continue;
      }
      stable[idx] = { ...result, post };
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, hashed.length) }, worker));
  return stable.filter((result): result is StableHash => result !== undefined);
}
