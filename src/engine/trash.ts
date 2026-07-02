import fs from "node:fs/promises";
import path from "node:path";
import { conflictName } from "./reconcile.js";

/**
 * The local trash tier (design 50): the pull writer never destroys bytes it
 * can't get back — propagated deletions and type-flip directory evictions
 * RENAME into `.rbox/trash/<batch>/<relpath>` instead of `fs.rm`. `.rbox` is
 * hard-pruned from scan/watch/sync, so trash never echoes; it lives on the
 * same filesystem as the tree, so every move is one atomic rename (§28 EXDEV
 * lesson: never stage across mounts).
 *
 * Cross-process safety (design-review B3): a batch carries an `.active`
 * marker from its first rename until the owning pull's apply phase finishes.
 * The pruner skips marked batches unless the marker is >24h stale (a crashed
 * pull), and never touches any batch younger than 15 minutes — cap pressure
 * included — so a concurrent one-shot pull can't have its in-flight batch
 * pruned out from under it by the daemon.
 */

export const TRASH_REL = ".rbox/trash";
const ACTIVE_MARKER = ".active";
const MIN_PRUNE_AGE_MS = 15 * 60_000;
const STALE_ACTIVE_MS = 24 * 60 * 60_000;

export interface TrashBatch {
  /** Atomically move `root/<relPath>` (file, symlink, or whole directory)
   *  into this batch, creating parents. A vanished source is not an error
   *  (delete semantics: already gone). Same-name collisions get `~2`, `~3`… */
  put(relPath: string): Promise<void>;
  /** Mark the batch settled (removes `.active`). Call after the apply phase;
   *  a batch that never received a put leaves nothing on disk. */
  finish(): Promise<void>;
  /** Absolute batch directory (forensic logging). */
  readonly dir: string;
}

/** Batch dir names are the pull's wall-clock, filesystem-safe. */
const batchName = (d: Date) => d.toISOString().replace(/[:.]/g, "-");

export function openTrashBatch(root: string, now: Date = new Date()): TrashBatch {
  const dir = path.join(root, TRASH_REL, batchName(now));
  let armed = false; // batch dir + marker created lazily on first put
  return {
    dir,
    async put(relPath: string): Promise<void> {
      const from = path.join(root, relPath);
      let to = path.join(dir, relPath);
      await fs.mkdir(path.dirname(to), { recursive: true });
      if (!armed) {
        await fs.writeFile(path.join(dir, ACTIVE_MARKER), "");
        armed = true;
      }
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
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return; // already gone / ancestor evicted
        throw e;
      }
    },
    async finish(): Promise<void> {
      if (!armed) return;
      await fs.rm(path.join(dir, ACTIVE_MARKER), { force: true }).catch(() => {});
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
    // Reverse batchName(): "2026-07-02T17-30-00-000Z" → ISO. Unparseable → mtime.
    const iso = name.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1:$2:$3.$4Z");
    const born = Date.parse(iso);
    let active = false;
    const marker = await fs.lstat(path.join(dir, ACTIVE_MARKER)).catch(() => undefined);
    if (marker) active = nowMs - marker.mtimeMs < STALE_ACTIVE_MS;
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
    if (e.name === ACTIVE_MARKER) continue;
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
      if ((!e.isFile() && !e.isSymbolicLink()) || e.name === ACTIVE_MARKER) continue;
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
 * NEVER overwrites (design-review M4): an existing target — including a
 * case-folded twin on case-insensitive filesystems, which lstat finds —
 * diverts the restore to a visible conflict name. Searches newest batch
 * first unless `batch` pins one.
 */
export async function restoreFromTrash(root: string, relPath: string, opts: { batch?: string; now?: Date } = {}): Promise<RestoreResult> {
  const batches = (await listBatches(root, Date.now())).reverse(); // newest first
  const candidates = opts.batch ? batches.filter((b) => b.name === opts.batch) : batches;
  for (const b of candidates) {
    const from = path.join(b.dir, relPath);
    const st = await fs.lstat(from).catch(() => undefined);
    if (!st) continue;
    let toRel = relPath;
    try {
      await fs.lstat(path.join(root, relPath));
      // Target exists → divert, never overwrite.
      toRel = conflictName(relPath, "trash", (opts.now ?? new Date()).toISOString());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") throw new Error(`cannot restore ${relPath}: a parent path component is a file — move it aside first`);
      if (code !== "ENOENT") throw e;
    }
    const to = path.join(root, toRel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    return { restoredTo: toRel };
  }
  throw new Error(`${relPath} not found in trash${opts.batch ? ` batch ${opts.batch}` : ""}`);
}
