import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";
// `@parcel/watcher/wrapper` is pure JS (path + picomatch + is-glob) — importing it
// dlopens nothing, so it's safe at module load on every platform. The NATIVE binding
// is loaded lazily, per-host, in loadParcelWrapper() below. Types: parcel-watcher.d.ts.
import { createWrapper } from "@parcel/watcher/wrapper";
import { HARD_PRUNE_DIRS, type IgnoreMatcher, type WatchEvent, type WatchEventKind } from "../engine/index.js";

export interface Watcher {
  close(): Promise<void>;
}

export type WatcherBackend = "parcel" | "chokidar";

export interface WatchOptions {
  /** Quiet period before a batch is considered settled. */
  debounceMs?: number;
  /** Hard cap on how long a sustained burst (clone/install) delays a flush. */
  maxWaitMs?: number;
  /** Force a backend; defaults to env `RBOX_WATCHER` then `parcel`. */
  backend?: WatcherBackend;
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
 * (node_modules, .git, build output) emit zero events — the key to not getting
 * pegged by `npm ci` and friends. Coalesces a burst into a single settled batch
 * (adaptive debounce, capped so a long clone still flushes).
 *
 * Backend is swappable behind this async factory:
 *  - `parcel` (default): `@parcel/watcher` — one native recursive OS stream on a
 *    background thread. O(1) memory on macOS, per-dir inotify on Linux, and the
 *    JS event loop is never blocked installing watches. Fixes the 11 GB / dropped-
 *    events failure (design §41). May reject if no native binding for the host —
 *    the daemon then degrades to periodic-scan-only.
 *  - `chokidar`: the legacy per-path `fs.watch` backend. Correct, but ~0.5 MB of
 *    native state PER watched path — do not point it at a monorepo-scale tree.
 *    Kept for small workspaces / debugging / Phase-0-failing targets.
 *
 * Returns once the watch is armed (parcel) or set up (chokidar). Rejects only on a
 * hard backend failure; callers MUST still run their reconcile loop so a rejected
 * watcher degrades to periodic sync rather than silent death.
 */
export async function startWatcher(
  root: string,
  matcher: IgnoreMatcher,
  onSettle: (events: WatchEvent[]) => void,
  opts: WatchOptions = {}
): Promise<Watcher> {
  const backend = opts.backend ?? resolveBackend();
  if (backend === "chokidar") return startChokidar(root, matcher, onSettle, opts);
  return startParcel(root, matcher, onSettle, opts);
}

function resolveBackend(): WatcherBackend {
  const env = process.env.RBOX_WATCHER?.toLowerCase();
  if (env === "chokidar" || env === "parcel") return env;
  return "parcel";
}

// ---- shared coalescing batcher -------------------------------------------------

interface Batcher {
  push(relPath: string, kind: WatchEventKind): void;
  dispose(): void;
}

/**
 * last-kind-wins per path; the engine re-derives true state from disk on flush.
 * Flush immediately once a sustained burst runs past `maxWaitMs`; otherwise wait
 * for `debounceMs` of quiet. Identical semantics across both backends.
 */
function createBatcher(onSettle: (events: WatchEvent[]) => void, debounceMs: number, maxWaitMs: number): Batcher {
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

  return {
    push(relPath, kind) {
      pending.set(relPath, kind);
      const now = Date.now();
      if (firstEventAt === 0) firstEventAt = now;
      if (timer) clearTimeout(timer);
      if (now - firstEventAt >= maxWaitMs) flush();
      else timer = setTimeout(flush, debounceMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

const toRelFor = (root: string) => (abs: string) => path.relative(root, abs).split(path.sep).join("/");

/** realpath the root, tolerating a not-yet-existing path (fall back to the input). */
function safeRealpath(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

// ---- @parcel/watcher backend (default) -----------------------------------------

interface ParcelEvent {
  path: string;
  type: "create" | "update" | "delete";
}
interface ParcelSubscription {
  unsubscribe(): Promise<void>;
}
interface ParcelWrapper {
  subscribe(
    dir: string,
    fn: (err: Error | null, events: ParcelEvent[]) => void,
    opts: { ignore?: string[] }
  ): Promise<ParcelSubscription>;
}

let wrapperCache: ParcelWrapper | undefined;

/** Lazily load the host-platform native binding and build the wrapper. Throws if
 *  the host has no embedded binding (unsupported arch / externalized-and-absent). */
function loadParcelWrapper(): ParcelWrapper {
  if (wrapperCache) return wrapperCache;
  const binding = loadHostBinding();
  wrapperCache = createWrapper(binding) as ParcelWrapper;
  return wrapperCache;
}

/**
 * Load the native `.node` for THIS host via a literal per-platform `require`.
 *
 * Why bare `require` and not `import()`:  Node-API (`.node`) modules cannot be
 * loaded through ESM `import`/`import()` under Bun ("use require() or
 * process.dlopen"). A literal bare `require("@parcel/watcher-<platform>")` is the
 * one form that works BOTH interpreted (`bun run`/`bun test`) AND embedded by
 * `bun build --compile` (the bundler statically resolves the literal and inlines
 * the `.node`; `createRequire`/computed specifiers are opaque to it and fail).
 *
 * The `switch` is literal so the bundler sees every specifier; release builds
 * `--external` the three non-target packages so only the target's `.node` is
 * embedded (scripts/release.ts + design §41). A branch that is
 * externalized-and-absent throws → the daemon degrades to periodic-scan-only.
 */
function loadHostBinding(): unknown {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return require("@parcel/watcher-darwin-arm64");
    case "darwin-x64":
      return require("@parcel/watcher-darwin-x64");
    case "linux-x64":
      return require("@parcel/watcher-linux-x64-glibc");
    case "linux-arm64":
      return require("@parcel/watcher-linux-arm64-glibc");
    default:
      throw new Error(`no @parcel/watcher native binding for ${key}`);
  }
}

/** Coarse native prune globs — hard-pruned dirs at ANY depth (`** /node_modules`).
 *  Non-glob values would resolve to a root-only absolute path, missing the nested
 *  copies that dominate a monorepo; the glob form prunes every occurrence. */
const PARCEL_IGNORE_GLOBS = HARD_PRUNE_DIRS.map((d) => `**/${d}`);

async function startParcel(
  root: string,
  matcher: IgnoreMatcher,
  onSettle: (events: WatchEvent[]) => void,
  opts: WatchOptions
): Promise<Watcher> {
  const debounceMs = opts.debounceMs ?? 400;
  const maxWaitMs = opts.maxWaitMs ?? 3000;
  const wrapper = loadParcelWrapper();
  const batcher = createBatcher(onSettle, debounceMs, maxWaitMs);
  // @parcel/watcher reports event paths as REAL paths (symlinks resolved). If the
  // watched root has a symlinked component (e.g. macOS `/tmp` → `/private/tmp`),
  // relativizing against the un-resolved root yields `../…` and silently drops
  // every event. Resolve the root so relPaths line up. Relative structure — and
  // thus the daemon's manifest keys — is unchanged by realpath.
  const realRoot = safeRealpath(root);
  const toRel = toRelFor(realRoot);

  const sub = await wrapper.subscribe(
    realRoot,
    (err, events) => {
      // A watcher error is not fatal to correctness — the reconcile loop is the
      // floor. Swallow here; the daemon's periodic full scan heals any gap.
      if (err || !events) return;
      for (const ev of events) {
        const rel = toRel(ev.path);
        if (rel === "" || rel.startsWith("..")) continue;

        if (ev.type === "delete") {
          // Parcel doesn't say file-vs-dir on delete (the path is gone). `unlinkDir`
          // removes the exact path AND any `path/**` children (see applyWatchEvents),
          // so it correctly covers both a deleted file and a deleted directory.
          batcher.push(rel, "unlinkDir");
          continue;
        }

        // create | update: the JS IgnoreMatcher is the AUTHORITATIVE filter, even
        // though the native `ignore` already pruned the high-volume subtrees.
        let isDir = false;
        try {
          isDir = fs.statSync(ev.path).isDirectory();
        } catch {
          /* raced away; treat as file, applyWatchEvents handles the vanish */
        }
        if (matcher.ignores(isDir ? `${rel}/` : rel)) continue;
        if (ev.type === "create") batcher.push(rel, isDir ? "addDir" : "add");
        else batcher.push(rel, "change");
      }
    },
    { ignore: PARCEL_IGNORE_GLOBS }
  );

  return {
    async close() {
      batcher.dispose();
      await sub.unsubscribe();
    },
  };
}

// ---- chokidar backend (legacy / small workspaces / fallback) --------------------

function startChokidar(
  root: string,
  matcher: IgnoreMatcher,
  onSettle: (events: WatchEvent[]) => void,
  opts: WatchOptions
): Watcher {
  const debounceMs = opts.debounceMs ?? 400;
  const maxWaitMs = opts.maxWaitMs ?? 3000;
  const batcher = createBatcher(onSettle, debounceMs, maxWaitMs);
  const toRel = toRelFor(root);

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
    batcher.push(toRel(abs), kind);
  });

  return {
    async close() {
      batcher.dispose();
      await watcher.close();
    },
  };
}
