import chokidar from "chokidar";
import path from "node:path";
import type { IgnoreMatcher, WatchEvent, WatchEventKind } from "../engine/index.js";

export interface Watcher {
  close(): Promise<void>;
}

export interface WatchOptions {
  /** Quiet period before a batch is considered settled. */
  debounceMs?: number;
  /** Hard cap on how long a sustained burst (clone/install) delays a flush. */
  maxWaitMs?: number;
}

const EVENT_KIND: Record<string, WatchEventKind | undefined> = {
  add: "add",
  change: "change",
  unlink: "unlink",
  addDir: "addDir",
  unlinkDir: "unlinkDir",
};

/**
 * Watch `root`, honoring the same ignore matcher as the scanner so ignored dirs
 * (node_modules, .git, build output) emit zero events and consume zero watches —
 * the key to not getting pegged by `npm ci` and friends. Coalesces a burst into
 * a single settled batch (adaptive debounce, capped so a long clone still flushes).
 *
 * Behind a small interface so the backend (chokidar today, @parcel/watcher for
 * monorepo scale in M9) is swappable without touching the daemon.
 */
export function startWatcher(
  root: string,
  matcher: IgnoreMatcher,
  onSettle: (events: WatchEvent[]) => void,
  opts: WatchOptions = {}
): Watcher {
  const debounceMs = opts.debounceMs ?? 400;
  const maxWaitMs = opts.maxWaitMs ?? 3000;

  // last-kind-wins per path; the engine re-derives true state from disk on flush.
  const pending = new Map<string, WatchEventKind>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstEventAt = 0;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    firstEventAt = 0;
    if (pending.size === 0) return;
    const events: WatchEvent[] = [...pending].map(([relPath, kind]) => ({ relPath, kind }));
    pending.clear();
    onSettle(events);
  };

  const schedule = () => {
    const now = Date.now();
    if (firstEventAt === 0) firstEventAt = now;
    if (timer) clearTimeout(timer);
    // Flush immediately if the burst has run past the hard cap; else wait for quiet.
    if (now - firstEventAt >= maxWaitMs) flush();
    else timer = setTimeout(flush, debounceMs);
  };

  const toRel = (abs: string) => path.relative(root, abs).split(path.sep).join("/");

  const watcher = chokidar.watch(root, {
    followSymlinks: false, // match scanManifest: symlinks are recorded, not followed
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 20 }, // coalesce chunked writes
    ignored: (p: string, stats?: { isDirectory(): boolean }) => {
      const rel = toRel(p);
      if (rel === "" || rel.startsWith("..")) return false; // the root itself
      return stats?.isDirectory() ? matcher.ignores(`${rel}/`) : matcher.ignores(rel);
    },
  });

  watcher.on("all", (event: string, abs: string) => {
    const kind = EVENT_KIND[event];
    if (!kind) return;
    pending.set(toRel(abs), kind);
    schedule();
  });

  return {
    async close() {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}
