import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock, type AcquireLockOptions, type OwnedLock } from "../engine/git/lockfile.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { resolveDaemonLogSources } from "./daemon-control.js";

export type SyncMutexMode = "cli" | "daemon";

export interface WorkspaceSyncMutex {
  readonly root: string;
  readonly lock?: OwnedLock;
  /** No safe identity/link primitive exists. Callers continue through the legacy
   * unlocked state path with the workspace config lane disabled. */
  readonly degraded?: { reason: string };
}

export type MutexBlockerKind = "live" | "foreign" | "stale-owned" | "fence";
export type LockStarvationReason = "foreign" | "identity-drift" | "stale-owned" | "fence";

export class WorkspaceSyncBusyError extends Error {
  constructor() {
    super("daemon/CLI is syncing; retry, or run `rbox stop` first");
    this.name = "WorkspaceSyncBusyError";
  }
}

export type DaemonMutexResult =
  | { status: "acquired"; handle: WorkspaceSyncMutex }
  | {
      status: "contended";
      /** Private scheduling identity. Never render, log, or upload. */
      holderKey: string;
      blockerKind: MutexBlockerKind;
      /** Only these closed causes are eligible for a durable starvation episode. */
      warningReason?: LockStarvationReason;
    };

export interface SyncMutexOptions {
  lock?: AcquireLockOptions;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Test/embedding seam for the once-per-workspace degradation surface. */
  onDegraded?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const syncMutexPath = (root: string): string => path.join(root, ".rbox", "state", "sync.lock");
export const lockingHealthPath = (root: string): string => path.join(root, ".rbox", "state", "locking-health.json");
export type LockingHealth =
  | { status: "ok" }
  | { status: "degraded-unlocked"; reason: "identity-unavailable" }
  | { status: "starved"; reason: LockStarvationReason };

async function readStarvationWarning(root: string): Promise<LockStarvationReason | undefined> {
  try {
    const episodeRaw = await fs.readFile(path.join(root, ".rbox", "state", "lock-starvation.json"), "utf8");
    if (Buffer.byteLength(episodeRaw) > 4 * 1024) return undefined;
    const episode = JSON.parse(episodeRaw) as Record<string, unknown>;
    if (typeof episode.warnedAt !== "number" || !Number.isSafeInteger(episode.warnedAt)) return undefined;
    const operational = (await resolveDaemonLogSources(root)).dated;
    if (!operational) return undefined;
    const handle = await fs.open(operational, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, 64 * 1024);
      const bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, stat.size - length);
      const lines = bytes.toString("utf8").split(/\r?\n/).reverse();
      for (const line of lines) {
        const match = /(?:^|\s)lock starved: reason=(foreign|identity-drift|stale-owned|fence) age=(?:15m|1h|1d)$/.exec(line);
        if (match) return match[1] as LockStarvationReason;
      }
      return undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function readLockingHealth(root: string): Promise<LockingHealth> {
  try {
    await fs.readFile(lockingHealthPath(root), "utf8");
    return { status: "degraded-unlocked", reason: "identity-unavailable" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "degraded-unlocked", reason: "identity-unavailable" };
    }
    const starvation = await readStarvationWarning(root);
    return starvation ? { status: "starved", reason: starvation } : { status: "ok" };
  }
}

function daemonContention(result: Extract<Awaited<ReturnType<typeof acquireLock>>, { status: "held" }>): Extract<DaemonMutexResult, { status: "contended" }> {
  return {
    status: "contended",
    holderKey: result.holderKey,
    blockerKind: result.blockerKind,
    ...(result.warningReason ? { warningReason: result.warningReason } : {}),
  };
}

async function degradedHandle(root: string, onDegraded?: (message: string) => void): Promise<WorkspaceSyncMutex> {
  const previous = await readLockingHealth(root);
  await writeFileAtomic(lockingHealthPath(root), JSON.stringify({ status: "degraded-unlocked", reason: "identity-unavailable" }));
  const message = "workspace locking unavailable; git config sync disabled, continuing with legacy state saves";
  if (previous.status === "ok") {
    try {
      (onDegraded ?? ((line) => process.stderr.write(`warning: ${line}\n`)))(message);
    } catch {
      // Surfacing is advisory; the entire point of this bucket is never-fatal sync.
    }
  }
  return { root, degraded: { reason: "identity-unavailable" } };
}

export const workspaceSyncMutexDegraded = (handle: WorkspaceSyncMutex | undefined): boolean => handle?.degraded !== undefined;

/**
 * Acquire the one workspace-wide sync mutex. CLI owners wait briefly and fail
 * loudly; daemon owners never consume their queued wakeup on contention.
 */
export async function acquireWorkspaceSyncMutex(
  root: string,
  mode: "cli",
  options?: SyncMutexOptions,
): Promise<WorkspaceSyncMutex>;
export async function acquireWorkspaceSyncMutex(
  root: string,
  mode: "daemon",
  options?: SyncMutexOptions,
): Promise<DaemonMutexResult>;
export async function acquireWorkspaceSyncMutex(
  root: string,
  mode: SyncMutexMode,
  options: SyncMutexOptions = {},
): Promise<WorkspaceSyncMutex | DaemonMutexResult> {
  const lockPath = syncMutexPath(root);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const attempts = mode === "cli" ? (options.attempts ?? 16) : 1;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await acquireLock(lockPath, options.lock);
    if (result.status === "acquired") {
      await fs.rm(lockingHealthPath(root), { force: true });
      const handle = { root, lock: result.lock };
      return mode === "daemon" ? { status: "acquired", handle } : handle;
    }
    if (result.status === "unsupported") {
      const handle = await degradedHandle(root, options.onDegraded);
      return mode === "daemon" ? { status: "acquired", handle } : handle;
    }
    if (result.status === "error") throw new Error(`workspace sync mutex failed: ${String(result.error)}`);
    if (mode === "daemon") return daemonContention(result);
    if (attempt + 1 < attempts) await sleep(retryDelayMs);
  }
  throw new WorkspaceSyncBusyError();
}

export function assertSyncMutex(handle: WorkspaceSyncMutex, root: string): void {
  if (handle.root !== root) throw new Error("workspace sync mutex belongs to a different root");
}

export async function releaseWorkspaceSyncMutex(handle: WorkspaceSyncMutex): Promise<void> {
  if (!handle.lock) return;
  const released = await handle.lock.release();
  if (!released.released) throw new Error("workspace sync mutex ownership was lost before release");
}

export async function withWorkspaceSyncMutex<T>(
  root: string,
  fn: (handle: WorkspaceSyncMutex) => Promise<T>,
  options?: SyncMutexOptions,
): Promise<T> {
  const handle = await acquireWorkspaceSyncMutex(root, "cli", options);
  try {
    return await fn(handle);
  } finally {
    await releaseWorkspaceSyncMutex(handle);
  }
}
