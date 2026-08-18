/** Never: the lockfile primitive itself (engine/lockfile.ts) or adoption content/Git mutation. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  acquireLock,
  type AcquireLockOptions,
  type LockUnsupportedReason,
  type OwnedLock,
} from "../engine/lockfile.js";
import { writeFileAtomic } from "../engine/fsutil.js";
import { resolveDaemonLogSources } from "./daemon-control.js";
import { inspectAdoptFence } from "./adopt-journal.js";
import { classifyStateFormat } from "./state-plane/authority-marker.js";
import { statePath } from "./state-plane/paths.js";

export type SyncMutexMode = "cli" | "daemon";
type WorkspaceLockFailureReason = LockUnsupportedReason | "io";

export interface WorkspaceSyncMutex {
  readonly root: string;
  readonly lock?: OwnedLock;
  /** No safe identity/link primitive exists. Callers continue through the legacy
   * unlocked state path with the workspace config lane disabled. `detail` carries
   * the real underlying error (identity resolution, ledger I/O, or link failure)
   * so surfaces can show WHY instead of a generic filesystem message. */
  readonly degraded?: { reason: string; detail?: string };
  /** Invocation-local cause retained only when an absent workspace cannot mint
   * its real mutex. Unlike `degraded`, this writes no health row and emits no
   * legacy warning; genesis admission turns it into an ephemeral refusal. */
  readonly lockFailure?: { reason: WorkspaceLockFailureReason; error?: unknown };
  /** Exact on-disk lock marker used to bind adoption continuation/recovery. */
  readonly incarnation: string;
  /** Set before release is attempted so a stale handle can never be replayed. */
  released?: boolean;
  readonly adoptAuthority?: { kind: "resume" | "abort" | "clean"; journalId: string };
}

interface BaselineContinuationCapability {
  journalId: string;
  root: string;
  stream: string;
  nonce: string;
  mutexIncarnation: string;
  active: boolean;
  consumed: boolean;
}

// Invocation-local and unforgeable by structural WorkspaceSyncMutex values.
// Only adopt-lifecycle receives the functions which manipulate this WeakMap;
// nested sync/pull/push merely borrow the already-held handle.
const baselineCapabilities = new WeakMap<WorkspaceSyncMutex, BaselineContinuationCapability>();

export type MutexBlockerKind = "live" | "foreign" | "stale-owned" | "fence";
export type LockStarvationReason = "foreign" | "identity-drift" | "stale-owned" | "fence";

export class WorkspaceSyncBusyError extends Error {
  constructor() {
    super("daemon/CLI is syncing; retry, or run `rbox stop` first");
    this.name = "WorkspaceSyncBusyError";
  }
}

export class WorkspaceSyncTimeoutError extends Error {
  constructor() {
    super("timed out waiting for the current sync cycle to finish");
    this.name = "WorkspaceSyncTimeoutError";
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
  /** Acquisition-only wall-clock bound. Once acquired, no timer affects work. */
  acquisitionDeadlineMs?: number;
  /** Called once after the first observed contention. */
  onWait?: () => void;
  nowMs?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const syncMutexPath = (root: string): string => path.join(root, ".rbox", "state", "sync.lock");
export const lockingHealthPath = (root: string): string => path.join(root, ".rbox", "state", "locking-health.json");
export type LockingHealth =
  | { status: "ok" }
  | { status: "degraded-unlocked"; reason: "identity-unavailable" }
  | { status: "starved"; reason: LockStarvationReason };

interface StarvationWarningCandidate {
  warnedAt?: unknown;
}

async function readStarvationWarning(root: string): Promise<LockStarvationReason | undefined> {
  try {
    const episodeRaw = await fs.readFile(path.join(root, ".rbox", "state", "lock-starvation.json"), "utf8");
    if (Buffer.byteLength(episodeRaw) > 4 * 1024) return undefined;
    const episode = JSON.parse(episodeRaw) as StarvationWarningCandidate;
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
  const contention: Extract<DaemonMutexResult, { status: "contended" }> = {
    status: "contended",
    holderKey: result.holderKey,
    blockerKind: result.blockerKind,
  };
  if (result.warningReason) contention.warningReason = result.warningReason;
  return contention;
}

async function degradedHandle(root: string, onDegraded?: (message: string) => void, detail?: string): Promise<WorkspaceSyncMutex> {
  const previous = await readLockingHealth(root);
  await writeFileAtomic(lockingHealthPath(root), JSON.stringify({ status: "degraded-unlocked", reason: "identity-unavailable" }));
  const message = `workspace locking unavailable${detail ? ` (${detail})` : ""}; git config sync disabled, continuing with legacy state saves`;
  if (previous.status === "ok") {
    try {
      (onDegraded ?? ((line) => process.stderr.write(`warning: ${line}\n`)))(message);
    } catch {
      // Surfacing is advisory; the entire point of this bucket is never-fatal sync.
    }
  }
  const degraded: NonNullable<WorkspaceSyncMutex["degraded"]> = detail ? { reason: "identity-unavailable", detail } : { reason: "identity-unavailable" };
  return { root, degraded, incarnation: "degraded", released: false };
}

function lockFailureHandle(
  root: string,
  reason: WorkspaceLockFailureReason,
  error: NonNullable<WorkspaceSyncMutex["lockFailure"]>["error"],
  adoptAuthority?: { kind: "resume" | "abort" | "clean"; journalId: string },
): WorkspaceSyncMutex {
  const lockFailure: NonNullable<WorkspaceSyncMutex["lockFailure"]> = error === undefined ? { reason } : { reason, error };
  const handle: WorkspaceSyncMutex = {
    root,
    lockFailure,
    incarnation: "lock-unavailable",
    released: false,
  };
  return adoptAuthority ? { ...handle, adoptAuthority } : handle;
}

async function unavailableFreshMutex(
  root: string,
  mode: SyncMutexMode,
  reason: WorkspaceLockFailureReason,
  error: NonNullable<WorkspaceSyncMutex["lockFailure"]>["error"],
  adoptAuthority?: { kind: "resume" | "abort" | "clean"; journalId: string },
): Promise<WorkspaceSyncMutex | DaemonMutexResult> {
  const handle = lockFailureHandle(root, reason, error, adoptAuthority);
  const fence = await inspectAdoptFence(root);
  const authorized = adoptAuthority !== undefined
    && fence.status !== "none" && fence.status !== "corrupt"
    && fence.journalId === adoptAuthority.journalId
    && (adoptAuthority.kind === "clean" ? fence.status === "terminal" : fence.status === "active");
  if ((fence.status === "active" || fence.status === "corrupt") && !authorized
    || adoptAuthority !== undefined && !authorized) {
    if (mode === "daemon") {
      return {
        status: "contended",
        holderKey: fence.status === "active" ? `adopt-${fence.journalId}` : "adopt-corrupt",
        blockerKind: "fence",
        warningReason: "fence",
      };
    }
    const detail = fence.status === "corrupt" ? ` (${fence.reason})` : "";
    throw new Error(`workspace has an incomplete adoption${detail}; run \`rbox adopt status|resume|abort\``);
  }
  return mode === "daemon" ? { status: "acquired", handle } : handle;
}

/** Does this handle fence nothing? True for BOTH unhealthy states: a handle
 * holding no lock is the same fact to every consumer that guards state mutation
 * with it. Only genesis admission needs the finer answer, and it reads
 * `lockFailure` directly rather than through a second predicate, so no new
 * unhealthy state can be minted that reports itself healthy here. */
export const workspaceSyncMutexDegraded = (handle: WorkspaceSyncMutex | undefined): boolean =>
  handle?.degraded !== undefined || handle?.lockFailure !== undefined;

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
  return acquireWorkspaceSyncMutexInternal(root, mode, options);
}

async function acquireWorkspaceSyncMutexInternal(
  root: string,
  mode: SyncMutexMode,
  options: SyncMutexOptions,
  adoptAuthority?: { kind: "resume" | "abort" | "clean"; journalId: string },
): Promise<WorkspaceSyncMutex | DaemonMutexResult> {
  const lockPath = syncMutexPath(root);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const attempts = mode === "cli" ? (options.attempts ?? 16) : 1;
  const retryDelayMs = options.retryDelayMs ?? 50;
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? Date.now;
  const deadline = options.acquisitionDeadlineMs === undefined ? undefined : nowMs() + options.acquisitionDeadlineMs;
  let waitSurfaced = false;
  for (let attempt = 0; deadline !== undefined || attempt < attempts; attempt++) {
    const result = await acquireLock(lockPath, options.lock);
    if (result.status === "acquired") {
      await fs.rm(lockingHealthPath(root), { force: true });
      const handle: WorkspaceSyncMutex = {
        root,
        lock: result.lock,
        incarnation: result.lock.raw,
        released: false,
        ...(adoptAuthority ? { adoptAuthority } : {}),
      };
      const fence = await inspectAdoptFence(root);
      const authorized = adoptAuthority !== undefined
        && fence.status !== "none" && fence.status !== "corrupt"
        && fence.journalId === adoptAuthority.journalId
        && (adoptAuthority.kind === "clean" ? fence.status === "terminal" : fence.status === "active");
      if ((fence.status === "active" || fence.status === "corrupt") && !authorized
        || adoptAuthority !== undefined && !authorized) {
        await releaseWorkspaceSyncMutex(handle).catch(() => {});
        if (mode === "daemon") {
          return {
            status: "contended",
            holderKey: fence.status === "active" ? `adopt-${fence.journalId}` : "adopt-corrupt",
            blockerKind: "fence",
            warningReason: "fence",
          };
        }
        const detail = fence.status === "corrupt" ? ` (${fence.reason})` : "";
        throw new Error(`workspace has an incomplete adoption${detail}; run \`rbox adopt status|resume|abort\``);
      }
      return mode === "daemon" ? { status: "acquired", handle } : handle;
    }
    if (result.status === "unsupported") {
      // Absence is the one state that may not fall through the legacy degraded
      // lane: it has no selected backend yet. Preserve the exact current cause
      // for genesis admission and leave disk/diagnostic state untouched.
      // A classification failure keeps the legacy lane; only proven absence mints the handle.
      const absent = await classifyStateFormat(statePath(root)).then((format) => format === "absent", () => false);
      if (absent) return unavailableFreshMutex(root, mode, result.reason, result.error, adoptAuthority);
      const handle = await degradedHandle(root, options.onDegraded, result.error instanceof Error ? result.error.message : result.error ? String(result.error) : undefined);
      const fence = await inspectAdoptFence(root);
      if (adoptAuthority || fence.status === "active" || fence.status === "corrupt") {
        if (mode === "daemon") {
          return { status: "contended", holderKey: fence.status === "active" ? `adopt-${fence.journalId}` : "adopt-fence", blockerKind: "fence", warningReason: "fence" };
        }
        throw new Error(adoptAuthority
          ? `adopt ${adoptAuthority.kind} requires a non-degraded workspace mutex`
          : "workspace has an incomplete adoption; run `rbox adopt status|resume|abort`");
      }
      return mode === "daemon" ? { status: "acquired", handle } : handle;
    }
    if (result.status === "error") {
      const absent = await classifyStateFormat(statePath(root)).then((format) => format === "absent", () => false);
      if (absent) return unavailableFreshMutex(root, mode, "io", result.error, adoptAuthority);
      throw new Error(`workspace sync mutex failed: ${String(result.error)}`);
    }
    if (mode === "daemon") return daemonContention(result);
    if (!waitSurfaced) {
      waitSurfaced = true;
      options.onWait?.();
    }
    if (deadline !== undefined) {
      const remaining = deadline - nowMs();
      if (remaining <= 0) throw new WorkspaceSyncTimeoutError();
      await sleep(Math.min(retryDelayMs, remaining));
      if (nowMs() >= deadline) throw new WorkspaceSyncTimeoutError();
    } else if (attempt + 1 < attempts) {
      await sleep(retryDelayMs);
    }
  }
  throw new WorkspaceSyncBusyError();
}

/** Recovery-only entry. No public command can mint an authority: the expected
 * journal id comes from the validated direct-path recovery reader. */
export async function acquireWorkspaceSyncMutexForAdopt(
  root: string,
  kind: "resume" | "abort" | "clean",
  journalId: string,
  options: SyncMutexOptions = {},
): Promise<WorkspaceSyncMutex> {
  const handle = await acquireWorkspaceSyncMutexInternal(root, "cli", options, { kind, journalId });
  if ("status" in handle) throw new Error("unexpected daemon mutex result");
  if (workspaceSyncMutexDegraded(handle)) {
    await releaseWorkspaceSyncMutex(handle).catch(() => {});
    throw new Error(`adopt ${kind} requires a non-degraded workspace mutex`);
  }
  return handle;
}

export function assertSyncMutex(handle: WorkspaceSyncMutex, root: string): void {
  if (handle.root !== root) throw new Error("workspace sync mutex belongs to a different root");
  if (handle.released) throw new Error("workspace sync mutex has already been released");
  const continuation = baselineCapabilities.get(handle);
  if (continuation && !continuation.active) throw new Error("workspace adoption fence requires its active baseline continuation");
}

function assertMutexBase(handle: WorkspaceSyncMutex, root: string): void {
  if (handle.root !== root) throw new Error("workspace sync mutex belongs to a different root");
  if (handle.released) throw new Error("workspace sync mutex has already been released");
}

/** Internal adoption seam: bind a newly-persisted or refreshed nonce to the
 * exact handle before any baseline sync can borrow it. */
export function bindAdoptBaselineContinuation(handle: WorkspaceSyncMutex, input: Omit<BaselineContinuationCapability, "active" | "consumed">): void {
  assertMutexBase(handle, input.root);
  if (handle.incarnation !== input.mutexIncarnation || handle.degraded || !handle.lock) {
    throw new Error("adoption continuation mutex incarnation mismatch");
  }
  const prior = baselineCapabilities.get(handle);
  if (prior?.active) throw new Error("adoption continuation is already active");
  baselineCapabilities.set(handle, { ...input, active: false, consumed: false });
}

/** Internal adoption seam: activate one journaled top-level baseline call. */
export function beginAdoptBaselineContinuation(handle: WorkspaceSyncMutex, input: Omit<BaselineContinuationCapability, "active" | "consumed">): void {
  assertMutexBase(handle, input.root);
  const prior = baselineCapabilities.get(handle);
  if (!prior || prior.journalId !== input.journalId || prior.root !== input.root || prior.stream !== input.stream
    || prior.nonce !== input.nonce || prior.mutexIncarnation !== input.mutexIncarnation) {
    throw new Error("adoption continuation binding mismatch");
  }
  if (prior.active || prior.consumed) throw new Error("adoption continuation replay rejected");
  prior.active = true;
  prior.consumed = true;
}

/** Internal adoption seam: end borrowing after nested pull/push return. */
export function endAdoptBaselineContinuation(handle: WorkspaceSyncMutex, nonce: string): void {
  const active = baselineCapabilities.get(handle);
  if (!active || !active.active || active.nonce !== nonce) throw new Error("adoption continuation capability mismatch");
  active.active = false;
}

/** Lift only the invocation-local exception after phase-2 baseline completion. */
export function retireAdoptBaselineContinuation(handle: WorkspaceSyncMutex, nonce: string): void {
  const continuation = baselineCapabilities.get(handle);
  if (!continuation || continuation.active || !continuation.consumed || continuation.nonce !== nonce) {
    throw new Error("adoption continuation retirement mismatch");
  }
  baselineCapabilities.delete(handle);
}

export async function assertHealthyOwnedSyncMutex(handle: WorkspaceSyncMutex, root: string): Promise<void> {
  assertMutexBase(handle, root);
  if (workspaceSyncMutexDegraded(handle) || !handle.lock) throw new Error("operation requires a non-degraded workspace mutex");
  if (!await handle.lock.isOwner()) throw new Error("workspace sync mutex ownership was lost");
}

export async function releaseWorkspaceSyncMutex(handle: WorkspaceSyncMutex): Promise<void> {
  if (handle.released) throw new Error("workspace sync mutex already released");
  handle.released = true;
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
