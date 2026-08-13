import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";
// `@parcel/watcher/wrapper` is pure JS (path + picomatch + is-glob) — importing it
// dlopens nothing, so it's safe at module load on every platform. The NATIVE binding
// is loaded lazily, per-host, in loadParcelWrapper() below. Types: parcel-watcher.d.ts.
import { createWrapper } from "@parcel/watcher/wrapper";
import {
  discoverGitRepos,
  isGitRefSignal,
  MAX_GIT_REPOS,
  nativePruneGlobs,
  type IgnoreMatcher,
  type DiscoveredGitRepo,
  type WatchEvent,
  type WatchEventKind,
} from "../../engine/index.js";
import { classifyRepoCandidate, type RepoCandidateWork } from "./git-ref-watch.js";
import type { PropagationTrace } from "./propagation-trace.js";

export interface Watcher {
  /** Backend that was actually selected and successfully started. */
  readonly backend: WatcherBackend;
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
  /** Post-init backend error (FSEvents stream died, inotify overflow). Correctness
   *  is unaffected (the reconcile scans are the floor) but the daemon uses this to
   *  stop TRUSTING the watcher — a dead stream must not back the safety scan off
   *  (design 49). Events may well keep flowing after a transient error;
   *  the callback is a health signal, not a teardown. */
  onError?: (err: Error) => void;
  /** Fires after matcher filtering and before debounce coalescing. */
  onRawEvent?: (event: WatchEvent) => void;
  /** Daemon-owned shared debouncer, also used by registry arm handshakes. */
  signalDebouncer?: SignalDebouncer;
  /** Initial watcher-start discovery, awaited before readiness. */
  onInitialGitRepos?: (repos: readonly DiscoveredGitRepo[]) => Promise<void>;
  /** Optional local observation sink; never participates in watcher control flow. */
  propagationTrace?: PropagationTrace;
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

/** Exported for deterministic unit tests of coalescing/last-kind-wins (backend-agnostic). */
export interface Batcher {
  push(relPath: string, kind: WatchEventKind): void;
  dispose(): void;
}

export interface SignalDebouncer {
  push(reason: GitSignalReason, candidate?: RepoCandidateWork): void;
  dispose(): void;
}

export type GitSignalReason = "signal" | "candidate" | "other";

export interface GitSignalBatch {
  readonly reasons: Readonly<{ signal: boolean; candidate: boolean; other: boolean }>;
  readonly candidates: readonly RepoCandidateWork[];
  /** Candidate-map overflow degrades to ordinary full-plan discovery. */
  readonly discoverAll: boolean;
}

/**
 * last-kind-wins per path; the engine re-derives true state from disk on flush.
 * Flush immediately once a sustained burst runs past `maxWaitMs`; otherwise wait
 * for `debounceMs` of quiet. Identical semantics across both backends. Exported so the
 * coalescing invariant can be tested deterministically, independent of OS event timing.
 */
export function createBatcher(
  onSettle: (events: WatchEvent[]) => void,
  debounceMs: number,
  maxWaitMs: number,
  trace?: PropagationTrace,
): Batcher {
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
    trace?.debouncerFired("file");
    onSettle(events);
  };

  return {
    push(relPath, kind) {
      trace?.debouncerArmed("file");
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

/** Independent debounce for watch-only signals that must never enter file batches. */
export function createSignalDebouncer(
  onSignal: ((batch: GitSignalBatch) => void | Promise<void>) | undefined,
  debounceMs: number,
  maxWaitMs: number,
  candidateCap = MAX_GIT_REPOS,
  trace?: PropagationTrace,
): SignalDebouncer {
  if (!Number.isInteger(candidateCap) || candidateCap < 1) throw new Error("candidateCap must be a positive integer");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstSignalAt = 0;
  let signal = false;
  let candidateReason = false;
  let other = false;
  let discoverAll = false;
  let candidates = new Map<string, RepoCandidateWork>();

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    firstSignalAt = 0;
    if (!signal && !candidateReason && !other) return;
    // Snapshot and clear atomically before handing work to async consumers. A
    // callback-triggered push therefore belongs to the next debounce window.
    const batch: GitSignalBatch = {
      reasons: { signal, candidate: candidateReason, other },
      candidates: [...candidates.values()],
      discoverAll,
    };
    signal = false;
    candidateReason = false;
    other = false;
    discoverAll = false;
    candidates = new Map();
    trace?.debouncerFired("git");
    void onSignal?.(batch);
  };

  return {
    push(reason, candidate) {
      trace?.debouncerArmed("git");
      if (reason === "signal") signal = true;
      else if (reason === "candidate") candidateReason = true;
      else other = true;
      if (candidate && !discoverAll) {
        const prior = candidates.get(candidate.owner);
        if (prior) {
          prior.dirty ||= candidate.dirty;
          prior.discover ||= candidate.discover;
        } else if (candidates.size < candidateCap) {
          candidates.set(candidate.owner, { ...candidate });
        } else {
          candidates.clear();
          discoverAll = true;
        }
      }
      const now = Date.now();
      if (firstSignalAt === 0) firstSignalAt = now;
      if (timer) clearTimeout(timer);
      if (now - firstSignalAt >= maxWaitMs) flush();
      else timer = setTimeout(flush, debounceMs);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      firstSignalAt = 0;
      signal = false;
      candidateReason = false;
      other = false;
      discoverAll = false;
      candidates.clear();
    },
  };
}

function pushWatchEvent(batcher: Batcher, opts: WatchOptions, relPath: string, kind: WatchEventKind): void {
  const event = { relPath, kind };
  opts.propagationTrace?.eventSeen("file");
  opts.onRawEvent?.(event);
  batcher.push(event.relPath, event.kind);
}

const toRelFor = (root: string) => (abs: string) => path.relative(root, abs).split(path.sep).join("/");

/** True only when `rel` (POSIX, "/"-joined) escapes the root — the root itself is "".
 *  Guards against a bare `startsWith("..")` that would wrongly drop legit files named
 *  like `..keep` or paths under `..data/`. */
const escapesRoot = (rel: string) => rel === ".." || rel.startsWith("../");

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
    opts: { ignore?: string[]; backend?: "fs-events" | "inotify" }
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
  // Supported: Apple Silicon macOS + Linux (x64/arm64). Intel Macs and anything else
  // fall through to the throw → the daemon catches it and degrades to periodic-scan.
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return require("@parcel/watcher-darwin-arm64");
    case "linux-x64":
      return require("@parcel/watcher-linux-x64-glibc");
    case "linux-arm64":
      return require("@parcel/watcher-linux-arm64-glibc");
    default:
      throw new Error(`no @parcel/watcher native binding for ${key}`);
  }
}

async function startParcel(
  root: string,
  matcher: IgnoreMatcher,
  onSettle: (events: WatchEvent[]) => void,
  opts: WatchOptions
): Promise<Watcher> {
  const debounceMs = opts.debounceMs ?? 400;
  const maxWaitMs = opts.maxWaitMs ?? 3000;
  const wrapper = loadParcelWrapper();
  const batcher = createBatcher(onSettle, debounceMs, maxWaitMs, opts.propagationTrace);
  const signalDebouncer = opts.signalDebouncer;
  // @parcel/watcher reports event paths as REAL paths (symlinks resolved). If the
  // watched root has a symlinked component (e.g. macOS `/tmp` → `/private/tmp`),
  // relativizing against the un-resolved root yields `../…` and silently drops
  // every event. Resolve the root so relPaths line up. Relative structure — and
  // thus the daemon's manifest keys — is unchanged by realpath.
  const realRoot = safeRealpath(root);
  const toRel = toRelFor(realRoot);
  // Kicked off before subscribe and awaited after: the ignore-pruned repo walk
  // feeds initial registry ownership without
  // delaying native subscription startup on large workspaces.
  const initialGitReposPromise = discoverGitRepos(realRoot, matcher).then(async (repos) => {
    await opts.onInitialGitRepos?.(repos);
  });

  const sub = await wrapper.subscribe(
    realRoot,
    (err, events) => {
      // A watcher error is not fatal to correctness — the reconcile loop is the
      // floor. Surface it as a health signal, then continue; the daemon's
      // periodic full scan heals any gap.
      if (err) {
        opts.onError?.(err);
        return;
      }
      if (!events) return;
      for (const ev of events) {
        const rel = toRel(ev.path);
        if (rel === "" || escapesRoot(rel)) continue;

        const candidate = classifyRepoCandidate(rel, ev.type);
        if (candidate) {
          opts.propagationTrace?.eventSeen("git");
          signalDebouncer?.push("candidate", candidate);
          continue;
        }

        // This classification is deliberately before BOTH Parcel's delete fork
        // and the authoritative sync matcher. A ref signal is routed through its
        // own seam and can therefore never become a file WatchEvent.
        if (isGitRefSignal(rel)) {
          opts.propagationTrace?.eventSeen("git");
          signalDebouncer?.push("signal");
          continue;
        }

        if (ev.type === "delete") {
          // Parcel doesn't say file-vs-dir on delete (the path is gone). `unlinkDir`
          // removes the exact path AND any `path/**` children (see applyWatchEvents),
          // so it correctly covers both a deleted file and a deleted directory.
          if (matcher.ignores(rel) || (matcher.prunes?.(`${rel}/`) ?? matcher.ignores(`${rel}/`))) continue;
          pushWatchEvent(batcher, opts, rel, "unlinkDir");
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
        if (isDir ? (matcher.prunes?.(`${rel}/`) ?? matcher.ignores(`${rel}/`)) : matcher.ignores(rel)) continue;
        if (ev.type === "create") pushWatchEvent(batcher, opts, rel, isDir ? "addDir" : "add");
        else pushWatchEvent(batcher, opts, rel, "change");
      }
    },
    // Coarse native prune (volume optimization): hard-prune dirs + their subtrees,
    // MINUS any the user could re-include under — those fall through to the JS matcher.
    {
      ignore: nativePruneGlobs(root),
      backend: process.platform === "darwin" ? "fs-events" : "inotify",
    }
  );

  try {
    await initialGitReposPromise;
  } catch (e) {
    // Preserve the sequential-walk failure semantics: a discovery failure fails
    // startParcel (daemon degrades to periodic scan) without leaking the live
    // subscription that now starts before the walk finishes.
    batcher.dispose();
    signalDebouncer?.dispose();
    await sub.unsubscribe().catch(() => {});
    throw e;
  }

  opts.propagationTrace?.backendArmed("parcel");

  return {
    backend: "parcel",
    async close() {
      batcher.dispose();
      signalDebouncer?.dispose();
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
  const batcher = createBatcher(onSettle, debounceMs, maxWaitMs, opts.propagationTrace);
  const signalDebouncer = opts.signalDebouncer;
  const toRel = toRelFor(root);

  const watcher = chokidar.watch(root, {
    followSymlinks: false, // match scanManifest: symlinks are recorded, not followed
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 20 }, // coalesce chunked writes
    ignored: (p: string, stats?: { isDirectory(): boolean }) => {
      const rel = toRel(p);
      if (rel === "" || escapesRoot(rel)) return false; // the root itself
      if (classifyRepoCandidate(rel, "create")) return false; // admit only the lifecycle entry; descendants remain pruned
      // The classifier stays ahead of the shared matcher, but `.git/` itself is
      // still pruned below, so Chokidar remains intentionally scan-bound for Git.
      if (isGitRefSignal(rel)) return true;
      return stats?.isDirectory() ? (matcher.prunes?.(`${rel}/`) ?? matcher.ignores(`${rel}/`)) : matcher.ignores(rel);
    },
  });

  watcher.on("error", (e) => opts.onError?.(e instanceof Error ? e : new Error(String(e))));
  watcher.on("all", (event: string, abs: string) => {
    const kind = EVENT_KIND[event];
    if (!kind) return;
    const rel = toRel(abs);
    if (rel === "" || escapesRoot(rel)) return; // parity with the parcel path
    const candidateKind = kind === "add" || kind === "addDir" ? "create"
      : kind === "change" ? "update"
      : "delete";
    const candidate = classifyRepoCandidate(rel, candidateKind);
    if (candidate) {
      opts.propagationTrace?.eventSeen("git");
      signalDebouncer?.push("candidate", candidate);
      return;
    }
    pushWatchEvent(batcher, opts, rel, kind);
  });

  opts.propagationTrace?.backendArmed("chokidar");

  return {
    backend: "chokidar",
    async close() {
      batcher.dispose();
      signalDebouncer?.dispose();
      await watcher.close();
    },
  };
}
