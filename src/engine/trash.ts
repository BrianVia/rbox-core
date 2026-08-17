import fs from "node:fs/promises";
import path from "node:path";
import { assertWithinRoot, claimUnclobberedName, errCode, isAbsent } from "./fsutil.js";
import { conflictName } from "./conflict-name.js";

/**
 * The local trash tier (design 50): the pull writer never destroys bytes it
 * can't get back — propagated deletions and type-flip directory evictions
 * RENAME into `.rbox/trash/<batch>/<relpath>` instead of `fs.rm`. `.rbox` is
 * hard-pruned from scan/watch/sync, so trash never echoes; it lives on the
 * same filesystem as the tree, so every move is one atomic rename (§28 EXDEV
 * lesson: never stage across mounts).
 *
 * Cross-process safety: a batch carries an `.active`
 * marker from its first rename until the owning pull's apply phase finishes.
 * The pruner skips marked batches unless the marker is >24h stale (a crashed
 * pull), and never touches any batch younger than 15 minutes — cap pressure
 * included — so a concurrent one-shot pull can't have its in-flight batch
 * pruned out from under it by the daemon.
 */

export const TRASH_REL = ".rbox/trash";
/** The in-flight marker is a SIBLING file (`<batchDir>.active`), NOT inside the
 *  batch — the batch's namespace belongs entirely to trashed user paths (a user
 *  file legitimately named `.active` must trash, list, and restore cleanly). */
const markerFor = (dir: string) => `${dir}.active`;
const MIN_PRUNE_AGE_MS = 15 * 60_000;
const STALE_ACTIVE_MS = 24 * 60 * 60_000;

export interface TrashBatch {
  /** Atomically move `root/<relPath>` (file, symlink, or whole directory)
   *  into this batch, creating parents. A vanished source is not an error
   *  (delete semantics: already gone). Same-name collisions get `~2`, `~3`… */
  put(relPath: string): Promise<boolean>;
  /** Mark the batch settled (removes `.active`). Call after the apply phase;
   *  a batch that never received a put leaves nothing on disk. */
  finish(): Promise<void>;
  /** Absolute batch directory (forensic logging). */
  readonly dir: string;
}

/** A trash path must stay inside the workspace/batch: relative, no `..`
 *  escapes, no NUL. Guards both put() (engine-internal, cheap insurance) and
 *  restoreFromTrash() (raw CLI input). */
function assertSafeRel(rel: string): void {
  const norm = path.normalize(rel);
  if (rel.length === 0 || path.isAbsolute(norm) || norm === ".." || norm.startsWith(`..${path.sep}`) || rel.includes("\0")) {
    throw new Error(`unsafe trash path: ${rel}`);
  }
}

/** Batch dir names lead with the pull's wall-clock (filesystem-safe ISO) and end
 *  with a pid+counter tail: two pulls in the same millisecond (daemon + one-shot,
 *  or a fast test) must NOT share a batch dir — they'd trample each other's
 *  `.active` marker. Age parsing reads only the leading timestamp. */
let batchSeq = 0;
const batchName = (d: Date) => `${d.toISOString().replace(/[:.]/g, "-")}-p${process.pid}-${++batchSeq}`;

export function openTrashBatch(root: string, now: Date = new Date()): TrashBatch {
  const dir = path.join(root, TRASH_REL, batchName(now));
  let armed = false; // batch dir + marker created lazily on first put
  return {
    dir,
    async put(relPath: string): Promise<boolean> {
      assertSafeRel(relPath);
      const from = path.join(root, relPath);
      let to = path.join(dir, relPath);
      if (!armed) {
        await fs.mkdir(path.dirname(markerFor(dir)), { recursive: true });
        await fs.writeFile(markerFor(dir), "");
        armed = true;
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      for (let i = 2; ; i++) {
        try {
          // rename(2) over an EXISTING dest would clobber a same-batch entry —
          // probe first; the batch dir is ours alone, so no external racer.
          await fs.access(to);
          to = path.join(dir, `${relPath}~${i}`);
        } catch {
          break;
        }
      }
      try {
        await fs.rename(from, to);
        return true;
      } catch (e) {
        if (isAbsent(e)) return false; // already gone / ancestor evicted
        throw e;
      }
    },
    async finish(): Promise<void> {
      if (!armed) return;
      await fs.rm(markerFor(dir), { force: true }).catch(() => {});
    },
  };
}

interface BatchInfo {
  name: string;
  dir: string;
  bornMs: number; // from the batch NAME (mtime lies after prune-adjacent renames)
  active: boolean; // fresh `.active` marker present
  bytes: number;
  files: number;
}

async function listBatches(root: string, nowMs: number): Promise<BatchInfo[]> {
  const base = path.join(root, TRASH_REL);
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return [];
  }
  const out: BatchInfo[] = [];
  for (const name of names) {
    const dir = path.join(base, name);
    const st = await fs.lstat(dir).catch(() => undefined);
    if (!st?.isDirectory()) continue;
    // Reverse batchName()'s leading timestamp: "2026-07-02T17-30-00-000Z[-pN-M]"
    // → ISO (the pid+counter tail is uniqueness only). Unparseable → mtime.
    const m = name.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
    const born = m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : NaN;
    let active = false;
    const marker = await fs.lstat(markerFor(dir)).catch(() => undefined);
    if (marker?.isFile()) active = nowMs - marker.mtimeMs < STALE_ACTIVE_MS;
    const { bytes, files } = await duDir(dir);
    out.push({ name, dir, bornMs: Number.isFinite(born) ? born : st.mtimeMs, active, bytes, files });
  }
  return out.sort((a, b) => a.bornMs - b.bornMs); // oldest first
}

async function duDir(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isFile() && !e.isSymbolicLink()) continue;
    const st = await fs.lstat(path.join(e.parentPath, e.name)).catch(() => undefined);
    if (!st) continue;
    bytes += st.size;
    files++;
  }
  return { bytes, files };
}

export interface TrashPruneResult {
  removedBatches: number;
  freedBytes: number;
}

/**
 * Retention: (1) age pass — batches older than `days` go (days <= 0 means
 * every eligible batch, used by `rbox trash empty`); (2) size pass — while
 * the remainder exceeds `maxBytes`, evict oldest-first. Both passes skip
 * protected batches: fresh `.active` marker, or younger than 15 minutes.
 */
export async function pruneTrash(root: string, opts: { days: number; maxBytes: number; now?: number }): Promise<TrashPruneResult> {
  const nowMs = opts.now ?? Date.now();
  const batches = await listBatches(root, nowMs);
  const protectedB = (b: BatchInfo) => b.active || nowMs - b.bornMs < MIN_PRUNE_AGE_MS;
  const result: TrashPruneResult = { removedBatches: 0, freedBytes: 0 };
  const remove = async (b: BatchInfo) => {
    await fs.rm(b.dir, { recursive: true, force: true });
    await fs.rm(markerFor(b.dir), { force: true }).catch(() => {}); // stale-override case
    result.removedBatches++;
    result.freedBytes += b.bytes;
  };

  const cutoff = nowMs - Math.max(0, opts.days) * 86_400_000;
  const survivors: BatchInfo[] = [];
  for (const b of batches) {
    if (!protectedB(b) && (opts.days <= 0 || b.bornMs < cutoff)) await remove(b);
    else survivors.push(b);
  }
  let total = survivors.reduce((n, b) => n + b.bytes, 0);
  for (const b of survivors) {
    if (total <= opts.maxBytes) break;
    if (protectedB(b)) continue;
    await remove(b);
    total -= b.bytes;
  }
  return result;
}

export interface TrashStats {
  batches: number;
  files: number;
  bytes: number;
}

export async function trashStats(root: string): Promise<TrashStats> {
  const batches = await listBatches(root, Date.now());
  return {
    batches: batches.length,
    files: batches.reduce((n, b) => n + b.files, 0),
    bytes: batches.reduce((n, b) => n + b.bytes, 0),
  };
}

export interface TrashEntry {
  batch: string;
  path: string; // workspace-relative
  bytes: number;
}

export async function listTrash(root: string): Promise<TrashEntry[]> {
  const batches = await listBatches(root, Date.now());
  const out: TrashEntry[] = [];
  for (const b of [...batches].reverse()) {
    const entries = await fs.readdir(b.dir, { withFileTypes: true, recursive: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const abs = path.join(e.parentPath, e.name);
      const st = await fs.lstat(abs).catch(() => undefined);
      if (!st) continue;
      out.push({ batch: b.name, path: path.relative(b.dir, abs), bytes: st.size });
    }
  }
  return out;
}

export interface RestoreResult {
  restoredTo: string; // workspace-relative; a conflictName if the target existed
}

/**
 * Rename a trashed path (file, symlink, or directory) back into the tree.
 * NEVER overwrites: an existing target — including a
 * case-folded twin on case-insensitive filesystems, which lstat finds —
 * diverts the restore to a visible conflict name. Searches newest batch
 * first unless `batch` pins one.
 */
export async function restoreFromTrash(root: string, relPath: string, opts: { batch?: string; now?: Date } = {}): Promise<RestoreResult> {
  assertSafeRel(relPath);
  const batches = (await listBatches(root, Date.now())).reverse(); // newest first
  const candidates = opts.batch ? batches.filter((b) => b.name === opts.batch) : batches;
  for (const b of candidates) {
    const from = path.join(b.dir, relPath);
    // The SOURCE needs the same symlinked-parent guard as the destination: a
    // trashed symlink `out -> /elsewhere` makes `batch/out/secret` resolve
    // OUTSIDE the batch — following it would exfiltrate (and then unlink!) a
    // file the trash never held. Real parent must stay inside this batch.
    await assertWithinRoot(b.dir, from);
    const st = await fs.lstat(from).catch(() => undefined);
    if (!st) continue;
    let toRel = relPath;
    try {
      await fs.lstat(path.join(root, relPath));
      // Target exists → divert, never overwrite.
      toRel = conflictName(relPath, "trash", (opts.now ?? new Date()).toISOString());
    } catch (e) {
      const code = errCode(e);
      if (code === "ENOTDIR") throw new Error(`cannot restore ${relPath}: a parent path component is a file — move it aside first`);
      if (code !== "ENOENT") throw e;
    }
    // conflictName is second-precision and a plain rename clobbers — claim each
    // candidate name ATOMICALLY (link/symlink/mkdir are all EEXIST-atomic), so two
    // concurrent restores can never overwrite each other's copy. The destination's
    // real parent is guarded like every apply-side write: a symlinked dir must not
    // teleport the restore outside the workspace.
    const restoredTo = await claimUnclobberedName({
      from,
      st,
      baseRel: toRel,
      toAbs: (rel) => path.join(root, rel),
      prepare: async (_rel, abs) => {
        await assertWithinRoot(root, abs);
        await fs.mkdir(path.dirname(abs), { recursive: true });
      },
    });
    return { restoredTo };
  }
  throw new Error(`${relPath} not found in trash${opts.batch ? ` batch ${opts.batch}` : ""}`);
}
