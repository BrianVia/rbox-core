import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock, type AcquireLockOptions, type LockInspection, type OwnedLock } from "../engine/git/lockfile.js";

export type SyncMutexMode = "cli" | "daemon";

export interface WorkspaceSyncMutex {
  readonly root: string;
  readonly lock: OwnedLock;
}

export type DaemonMutexResult =
  | { status: "acquired"; handle: WorkspaceSyncMutex }
  | { status: "contended"; detail: string };

export interface SyncMutexOptions {
  lock?: AcquireLockOptions;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const syncMutexPath = (root: string): string => path.join(root, ".rbox", "state", "sync.lock");

function heldDetail(inspection: Exclude<LockInspection, { kind: "absent" }>): string {
  if (inspection.kind === "live" || inspection.kind === "dead") return `pid ${inspection.marker.pid}`;
  return inspection.reason;
}

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
  let lastDetail = "unknown owner";

  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await acquireLock(lockPath, options.lock);
    if (result.status === "acquired") {
      const handle = { root, lock: result.lock };
      return mode === "daemon" ? { status: "acquired", handle } : handle;
    }
    if (result.status === "unsupported") throw new Error(`workspace sync mutex is unsupported: ${String(result.error)}`);
    if (result.status === "error") throw new Error(`workspace sync mutex failed: ${String(result.error)}`);
    lastDetail = heldDetail(result.inspection);
    if (mode === "daemon") return { status: "contended", detail: lastDetail };
    if (attempt + 1 < attempts) await sleep(retryDelayMs);
  }
  throw new Error(`another sync is in progress (${lastDetail})`);
}

export function assertSyncMutex(handle: WorkspaceSyncMutex, root: string): void {
  if (handle.root !== root) throw new Error("workspace sync mutex belongs to a different root");
}

export async function releaseWorkspaceSyncMutex(handle: WorkspaceSyncMutex): Promise<void> {
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
