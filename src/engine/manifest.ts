import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { indexByPath } from "./diff.js";
import type { DiscoveredGitRepo } from "./git-discover.js";
import { hashBytes, hashFile } from "./hash.js";
import type { HashCache } from "./hashcache.js";
import { DirCache, UNPRUNED_DEADLINE_MS, type DirCacheChild, type DircacheOutcome, type RuleFileRecord } from "./dircache.js";
import { buildIgnoreMatcher, isIgnoreRuleFile, type IgnoreMatcher } from "./ignore.js";
import { errCode, isAbsent } from "./fsutil.js";
import type { FileEntry, Manifest } from "./types.js";
import { bulkWalkDir, bulkWalkSupported, type BulkStat } from "./darwin-bulk-walk.js";

/** errno codes for a per-file fault we DEFER (carry the last-synced entry forward,
 *  retry next scan) rather than abort the whole scan on. A directory-level readdir
 *  failure is deliberately NOT here — an unenumerable dir fails the scan loudly. */
const DEFERRABLE_FILE_ERRNOS = new Set(["EACCES", "EPERM", "EIO", "ENOENT"]);
function isDeferrableFileError(e: unknown): e is NodeJS.ErrnoException {
  const code = errCode(e);
  return typeof code === "string" && DEFERRABLE_FILE_ERRNOS.has(code);
}

/** Present-but-unreadable: the path EXISTS but this process cannot read it. Never
 *  absence — mapping these to "gone" is how an unreadable file becomes a deletion. */
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

export interface ScanStats {
  dirsWalked: number;
  filesStatted: number;
  filesSkippedCacheHit: number;
  filesHashed: number;
  readdirMs: number;
  statMs: number;
  matcherMs: number;
  hashMs: number;
  sortMs: number;
  dirsReusedFromCache: number;
  dircacheOutcome: DircacheOutcome;
}

export interface DirProbeSample {
  key: string;
  mtimeMs: number;
  ctimeMs: number;
  readdirMs: number;
  childCount: number;
  projectedBytes: number;
}

export interface DirProbeSink {
  probeOverheadMs: number;
  record(sample: DirProbeSample): void;
}

export function createScanStats(): ScanStats {
  return {
    dirsWalked: 0,
    filesStatted: 0,
    filesSkippedCacheHit: 0,
    filesHashed: 0,
    readdirMs: 0,
    statMs: 0,
    matcherMs: 0,
    hashMs: 0,
    sortMs: 0,
    dirsReusedFromCache: 0,
    dircacheOutcome: "off",
  };
}

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
  const scanStartMs = Date.now();
  if (!dircache) {
    const files: FileEntry[] = [];
    if (scanStats) { scanStats.dircacheOutcome = "off"; scanStats.dirsReusedFromCache = 0; }
    const ctx = makeWalkCtx({ root, matcher, cache, mode: "off", scanStartMs, scanStats, deferred, dirProbe, onProgress, onGitRepo, onDeferErrno, warningSink });
    await runWalk(ctx, "", files);
    sortManifestFiles(files, scanStats);
    return { generatedAt: new Date().toISOString(), files };
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
    } else if (!(await dircache.validateRuleInventory(root))) {
      effectiveMode = "unpruned"; outcome = "rules-dropped";
    }
  }

  let winningStats = createScanStats();
  let winningCtx: WalkCtx;
  let files: FileEntry[];
  for (let attempt = 0; ; attempt++) {
    files = [];
    winningStats = createScanStats();
    winningCtx = makeWalkCtx({ root, matcher, cache, dircache, mode: effectiveMode, scanStartMs, scanStats: winningStats, deferred, dirProbe, onProgress, onGitRepo, onDeferErrno, warningSink, priorRuleFiles });
    if (effectiveMode === "unpruned") dircache.dropTable();
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
      if (effectiveMode === "pruned" && !(await dircache.validateRuleInventory(root))) throw new RulesChangedDuringPrune();
      break;
    } catch (error) {
      if (!(error instanceof RulesChangedDuringPrune) || attempt > 0) throw error;
      effectiveMode = "unpruned";
      outcome = "rules-dropped";
      dircache.dropTable();
    }
  }

  sortManifestFiles(files, winningStats);
  const ruleFiles = await buildRuleFiles(root, winningCtx!.observedRuleFiles);
  if (effectiveMode === "unpruned") dircache.stampUnprunedRebuild(scanStartMs, ruleFiles);
  else {
    dircache.stampPrunedScan(scanStartMs, ruleFiles);
    outcome = winningStats.dirsReusedFromCache > 0 ? "hit" : "cold";
  }
  winningStats.dircacheOutcome = outcome;
  // Record coverage-bearing outcome on the dircache itself (the thing that made the
  // pruning decision) so callers derive watcher-re-trust coverage from a first-class
  // source, never from the OPTIONAL metrics struct.
  dircache.lastOutcome = outcome;
  if (scanStats) mergeWinningStats(scanStats, winningStats);
  return { generatedAt: new Date().toISOString(), files };
}

/** The manifest's canonical path order — plain byte-wise ascending, the SINGLE
 *  definition every producer and consumer of a sorted `files` array shares. Exported
 *  so a patch that merges into an already-sorted manifest (design 202) can rely on
 *  the same order the scan established instead of re-sorting to guess it. */
export function compareManifestPaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortManifestFiles(files: FileEntry[], scanStats?: ScanStats): void {
  const t0 = scanStats ? Date.now() : 0;
  files.sort((a, b) => compareManifestPaths(a.path, b.path));
  if (scanStats) scanStats.sortMs += Date.now() - t0;
}

function mergeWinningStats(target: ScanStats, source: ScanStats): void {
  for (const key of ["dirsWalked", "filesStatted", "filesSkippedCacheHit", "filesHashed", "readdirMs", "statMs", "matcherMs", "hashMs", "sortMs"] as const) target[key] += source[key];
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
          onProgress(discovered, bytesDiscovered);
        }
      }
    : undefined;
  return {
    root: o.root, matcher: o.matcher, cache: o.cache, dircache: o.dircache, mode: o.mode,
    scanStartMs: o.scanStartMs, scanStats: o.scanStats, deferred: o.deferred, dirProbe: o.dirProbe,
    onDiscover,
    flushProgress: onProgress ? () => { if (discovered > lastEmitted) onProgress(discovered, bytesDiscovered); } : undefined,
    onGitRepo: o.onGitRepo, onDeferErrno: o.onDeferErrno, warningSink: o.warningSink, priorRuleFiles: o.priorRuleFiles ?? new Set(), observedRuleFiles: new Set(),
  };
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
      if (res.kind === "entry") map.set(rel, res.entry);
      else if (res.kind === "midwrite") deferred?.add(rel);
      // "gone" ⇒ vanished after the event; leave it for the next unlink/settle.
    }
  }

  const files = [...map.values()].sort((a, b) => compareManifestPaths(a.path, b.path));
  return { generatedAt: new Date().toISOString(), files };
}

/** Discriminates a clean hash from a vanished path vs one still being written, so the
 *  caller can RETRY a mid-write on the hot path instead of waiting for the safety scan. */
type StatHashResult = { kind: "entry"; entry: FileEntry } | { kind: "gone" } | { kind: "midwrite" };

/** Exact identity and metadata contract for accepting a stat → hash → stat tuple. */
interface FileStatLike {
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
async function statHashEntry(root: string, rel: string, cache?: HashCache): Promise<StatHashResult> {
  const abs = path.join(root, rel);
  let st1;
  try {
    st1 = await fs.lstat(abs);
  } catch (e) {
    // ENOENT/ENOTDIR = genuinely absent. A permission/IO fault is NOT absence —
    // treating it as gone converts an unreadable-but-present file into a deletion.
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
  ctx.onDeferErrno?.(error.code!);
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
    dirStat = await fs.lstat(absDir);
    if (ctx.mode === "pruned") children = ctx.dircache.reuse(rel, dirStat);
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
      const t0 = ctx.scanStats ? Date.now() : 0;
      const bulk = bulkWalkDir(absDir, ctx.warningSink);
      if (bulk !== null) {
        children = bulk.map(({ name, type }) => ({ name, type }));
        bulkStats = new Map(bulk.flatMap((child) => child.type === "file" && child.stat ? [[child.name, child.stat]] : []));
        rawEntryCount = bulk.length;
        if (ctx.scanStats) {
          ctx.scanStats.readdirMs += Date.now() - t0;
          ctx.scanStats.dirsWalked += 1;
        }
      }
    }
    if (children === undefined) {
      const t0 = ctx.scanStats ? Date.now() : 0;
      // Deliberate fail-loud boundary (design 108): an unenumerable directory aborts
      // the scan — per-file faults defer, but the walk cannot know what lives below.
      const entries = await fs.readdir(absDir, { withFileTypes: true });
      if (ctx.scanStats) {
        ctx.scanStats.readdirMs += Date.now() - t0;
        ctx.scanStats.dirsWalked += 1;
      }
      rawEntryCount = entries.length;
      children = entries.map((entry): DirCacheChild => entry.isDirectory()
        ? { name: entry.name, type: "dir" }
        : entry.isSymbolicLink() ? { name: entry.name, type: "symlink" }
        : entry.isFile() ? { name: entry.name, type: "file" }
        : { name: entry.name, type: "other" });
      if (ctx.dirProbe) probeProjectedBytes = Buffer.byteLength(JSON.stringify(entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : "file" }))));
    }
    if (ctx.dircache && dirStat) ctx.dircache.record(rel, { mtimeMs: dirStat.mtimeMs, ctimeMs: dirStat.ctimeMs, children });
  }
  if (ctx.dirProbe && !reused) {
    const readdirMs = Date.now() - readdirStart;
    const overheadStart = Date.now();
    const st = dirStat ?? await fs.lstat(absDir);
    ctx.dirProbe.record({
      key: hashBytes(Buffer.from(rel)).slice(0, 16),
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      readdirMs,
      childCount: rawEntryCount,
      projectedBytes: probeProjectedBytes,
    });
    ctx.dirProbe.probeOverheadMs += Date.now() - overheadStart;
  }
  for (const child of children!) {
    const childRel = rel ? `${rel}/${child.name}` : child.name;
    const abs = path.join(ctx.root, childRel);
    // Rule-file inventory tracking is dircache-only; skip the per-child string work
    // entirely on the "off" (no-dircache) path so it stays zero-new-work.
    if (ctx.mode !== "off" && isIgnoreRuleFile(childRel)) {
      ctx.observedRuleFiles.add(childRel);
      if (!reused && ctx.mode === "pruned" && !ctx.priorRuleFiles.has(childRel)) throw new RulesChangedDuringPrune();
    }
    if (child.name === ".git") {
      const relPath = rel === "" ? "." : rel;
      if (!discoveryPruned && child.type === "dir") ctx.onGitRepo?.({ relPath, kind: "dir" });
      else if (!discoveryPruned && child.type === "file") ctx.onGitRepo?.({ relPath, kind: "pointer" });
    }

    if (child.type === "dir") {
      const childDir = `${childRel}/`;
      const childDiscoveryPruned =
        discoveryPruned ||
        (ctx.scanStats
          ? timedMatcher(ctx.scanStats, () => ctx.matcher.prunesForGitDiscovery?.(childDir) ?? ctx.matcher.ignores(childDir))
          : ctx.matcher.prunesForGitDiscovery?.(childDir) ?? ctx.matcher.ignores(childDir));
      if (ctx.scanStats ? timedMatcher(ctx.scanStats, () => ctx.matcher.prunes?.(childDir) ?? ctx.matcher.ignores(childDir)) : ctx.matcher.prunes?.(childDir) ?? ctx.matcher.ignores(childDir)) continue;
      try {
        await walk(ctx, childRel, out, toHash, childDiscoveryPruned);
      } catch (error) {
        if (reused && isAbsent(error)) continue;
        throw error;
      }
    } else if (child.type === "symlink") {
      if (ctx.scanStats ? timedMatcher(ctx.scanStats, () => ctx.matcher.ignores(childRel)) : ctx.matcher.ignores(childRel)) continue;
      let target: string;
      try { target = await fs.readlink(abs); }
      catch (error) {
        if (deferWalkFault(ctx, childRel, error)) continue;
        throw error;
      }
      ctx.onDiscover?.(Buffer.byteLength(target));
      out.push({
        path: childRel,
        type: "symlink",
        symlinkTarget: target,
        sha256: hashBytes(Buffer.from(target)),
        size: Buffer.byteLength(target),
        mode: 0o777,
        mtimeMs: 0,
      });
    } else if (child.type === "file") {
      if (ctx.scanStats ? timedMatcher(ctx.scanStats, () => ctx.matcher.ignores(childRel)) : ctx.matcher.ignores(childRel)) continue;
      let st: FileStatLike | undefined = bulkStats?.get(child.name);
      if (!st && ctx.scanStats) {
        const t0 = Date.now();
        try {
          st = await fs.stat(abs);
        } catch (error) {
          if (deferWalkFault(ctx, childRel, error)) continue;
          throw error;
        } finally {
          ctx.scanStats.statMs += Date.now() - t0;
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
      const cached = ctx.cache?.lookup(childRel, st.mtimeMs, st.size, st.ctimeMs);
      if (cached) {
        if (ctx.scanStats) ctx.scanStats.filesSkippedCacheHit += 1;
        out.push({ path: childRel, type: "file", sha256: cached, size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
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
  if (ctx.scanStats) {
    ctx.scanStats.filesHashed += pending.length;
    const t0 = Date.now();
    await drainHashes(pending, out, ctx.cache, ctx.deferred, ctx.onDeferErrno);
    ctx.scanStats.hashMs += Date.now() - t0;
  } else await drainHashes(pending, out, ctx.cache, ctx.deferred, ctx.onDeferErrno);
}

/** The "make a pending list, walk from `rel`, drain the deferred hashes" sequence
 *  every top-level walk shares. `discoveryPruned` starts false at the top level. */
async function runWalk(ctx: WalkCtx, rel: string, out: FileEntry[]): Promise<void> {
  const toHash: PendingHash[] = [];
  await walk(ctx, rel, out, toHash, false);
  await finishHashes(ctx, toHash, out);
  ctx.flushProgress?.();
}

function timedMatcher(scanStats: ScanStats, fn: () => boolean): boolean {
  const t0 = Date.now();
  try {
    return fn();
  } finally {
    scanStats.matcherMs += Date.now() - t0;
  }
}

/** Hash the deferred cache-miss files with bounded concurrency. */
async function drainHashes(pending: PendingHash[], out: FileEntry[], cache?: HashCache, deferred?: Set<string>, onDeferErrno?: (code: string) => void): Promise<void> {
  let i = 0;
  const worker = async () => {
    for (let idx = i++; idx < pending.length; idx = i++) {
      const p = pending[idx]!;
      let sha256: string;
      try {
        sha256 = await hashFile(p.abs, p.st.size);
      } catch (e) {
        if (!isDeferrableFileError(e)) throw e;
        deferred?.add(p.childRel);
        onDeferErrno?.(e.code!);
        continue;
      }
      const post = await fs.lstat(p.abs).catch(() => undefined);
      if (!post || !statsStableAcrossHash(p.st, post)) {
        deferred?.add(p.childRel);
        continue;
      }
      cache?.record(p.childRel, { mtimeMs: post.mtimeMs, size: post.size, ctimeMs: post.ctimeMs, sha256 });
      out.push({ path: p.childRel, type: "file", sha256, size: post.size, mode: post.mode & 0o777, mtimeMs: post.mtimeMs });
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, pending.length) }, worker));
}
