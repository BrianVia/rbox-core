import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { acquireLock, type AcquireLockOptions, type OwnedLock } from "../../engine/lockfile.js";
import { repoCtx } from "./git-state.js";

export const PROTOCOL_LOCK_ORDER = {
  workspace: 1,
  chain: 2,
  operation: 3,
  reflog: 4,
  origin: 5,
  git: 6,
  reservation: 7,
  "orig-head": 8,
  index: 9,
  state: 10,
} as const;

export type ProtocolLockClass = keyof typeof PROTOCOL_LOCK_ORDER;
export type ProtocolLockTraceEvent = { action: "acquire" | "release"; class: ProtocolLockClass; identity: string; depth: number; postHeadException: boolean };

interface HeldClass { class: ProtocolLockClass; identity: string }
interface LockContext {
  held: HeldClass[];
  postHeadException: boolean;
  postHeadGitUsed: boolean;
  /** A recovery fence owns the complete physical Git lock plane. Nested
   * prepared transactions must use that plane rather than starting a second
   * logical Git phase after the state lock. */
  coveredClasses: Set<ProtocolLockClass>;
}

const context = new AsyncLocalStorage<LockContext>();
let traceSink: ((event: ProtocolLockTraceEvent) => void) | undefined;

const byteCompare = (a: string, b: string): number => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

export function setProtocolLockTraceForTests(sink: ((event: ProtocolLockTraceEvent) => void) | undefined): void {
  traceSink = sink;
}

export function heldProtocolLocks(): readonly HeldClass[] {
  return [...(context.getStore()?.held ?? [])];
}

function ensureAcquisitionAllowed(store: LockContext, lockClass: ProtocolLockClass, identity: string): void {
  if (store.postHeadException && lockClass !== "git") {
    throw new Error(`post-HEAD exception cannot acquire ${lockClass}`);
  }
  if (store.postHeadException && store.postHeadGitUsed) {
    throw new Error("post-HEAD exception permits exactly one Git phase");
  }
  const last = store.held[store.held.length - 1];
  if (!last) return;
  const nextRank = PROTOCOL_LOCK_ORDER[lockClass];
  const lastRank = PROTOCOL_LOCK_ORDER[last.class];
  if (nextRank < lastRank) {
    const later = store.held.filter((held) => PROTOCOL_LOCK_ORDER[held.class] > nextRank).map((held) => held.class);
    const postHeadGit = store.postHeadException && lockClass === "git"
      && later.length > 0 && later.every((held) => held === "reservation" || held === "index");
    if (!postHeadGit) throw new Error(`protocol lock inversion: ${last.class} -> ${lockClass}`);
  }
  if (nextRank === lastRank && byteCompare(identity, last.identity) <= 0) {
    throw new Error(`protocol lock class ${lockClass} is not in canonical byte order`);
  }
}

async function withinContext<T>(fn: (store: LockContext) => Promise<T>): Promise<T> {
  const existing = context.getStore();
  return existing ? fn(existing) : context.run({ held: [], postHeadException: false, postHeadGitUsed: false, coveredClasses: new Set() }, () => fn(context.getStore()!));
}

async function withAcquiredClass<T>(
  lockClass: ProtocolLockClass,
  identity: string,
  acquire: () => Promise<() => Promise<void>>,
  fn: () => Promise<T>,
): Promise<T> {
  return withinContext(async (store) => {
    if (store.coveredClasses.has(lockClass)) return fn();
    const exact = store.held.find((held) => held.class === lockClass && held.identity === identity);
    if (exact) return fn();
    ensureAcquisitionAllowed(store, lockClass, identity);
    const release = await acquire();
    if (store.postHeadException && lockClass === "git") store.postHeadGitUsed = true;
    store.held.push({ class: lockClass, identity });
    traceSink?.({ action: "acquire", class: lockClass, identity, depth: store.held.length, postHeadException: store.postHeadException });
    let result: T | undefined;
    let failure: unknown;
    try { result = await fn(); } catch (error) { failure = error; }
    const top = store.held.pop();
    if (top?.class !== lockClass || top.identity !== identity) {
      failure ??= new Error(`protocol lock release inversion at ${lockClass}`);
    }
    try {
      await release();
      traceSink?.({ action: "release", class: lockClass, identity, depth: store.held.length, postHeadException: store.postHeadException });
    } catch (error) { failure ??= error; }
    if (failure !== undefined) throw failure;
    return result as T;
  });
}

export function assertProtocolLockHeld(lockClass: ProtocolLockClass, identity?: string): void {
  const store = context.getStore();
  if (!store || (!store.coveredClasses.has(lockClass)
    && !store.held.some((held) => held.class === lockClass && (identity === undefined || held.identity === identity)))) {
    throw new Error(`required held protocol lock is missing: ${lockClass}${identity === undefined ? "" : ` (${identity})`}`);
  }
}

async function withCoveredClasses<T>(lockClasses: readonly ProtocolLockClass[], fn: () => Promise<T>): Promise<T> {
  return withinContext(async (store) => {
    const added = lockClasses.filter((lockClass) => !store.coveredClasses.has(lockClass));
    for (const lockClass of added) store.coveredClasses.add(lockClass);
    try {
      return await fn();
    } finally {
      for (const lockClass of added.reverse()) store.coveredClasses.delete(lockClass);
    }
  });
}

export function withProtocolLockClass<T>(lockClass: ProtocolLockClass, identity: string, fn: () => Promise<T>): Promise<T> {
  if (!identity || identity.includes("\0")) return Promise.reject(new Error("invalid protocol lock identity"));
  return withAcquiredClass(lockClass, identity, async () => async () => {}, fn);
}

export async function withPostHeadCompatibilityException<T>(fn: () => Promise<T>): Promise<T> {
  return withinContext(async (store) => {
    if (store.postHeadException) throw new Error("nested post-HEAD compatibility exception");
    if (store.held.some((held) => held.class === "reflog" || held.class === "origin" || held.class === "git"
      || held.class === "orig-head" || held.class === "state")) {
      throw new Error("post-HEAD exception overlaps a forbidden lock class");
    }
    if (!store.held.some((held) => held.class === "reservation") || !store.held.some((held) => held.class === "index")) {
      throw new Error("post-HEAD exception requires reservation and index locks");
    }
    store.postHeadException = true;
    store.postHeadGitUsed = false;
    try {
      const result = await fn();
      if (!store.postHeadGitUsed) throw new Error("post-HEAD exception did not acquire its Git phase");
      return result;
    } finally {
      store.postHeadException = false;
      store.postHeadGitUsed = false;
    }
  });
}

async function acquireDurable(lockPath: string, options?: AcquireLockOptions): Promise<OwnedLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const result = await acquireLock(lockPath, options);
  if (result.status === "acquired") return result.lock;
  if (result.status === "held") throw new Error(`protocol lock held: ${lockPath} (${result.blockerKind})`);
  throw new Error(`protocol lock unavailable: ${lockPath} (${String(result.error)})`);
}

async function withDurableClass<T>(lockClass: ProtocolLockClass, identity: string, lockPath: string, fn: () => Promise<T>, options?: AcquireLockOptions): Promise<T> {
  return withAcquiredClass(lockClass, identity, async () => {
    const lock = await acquireDurable(lockPath, options);
    return async () => {
      const released = await lock.release();
      if (!released.released) throw new Error(`protocol lock ownership lost: ${lockPath}`);
      if (!released.durable) throw new Error(`protocol lock release was not durable: ${lockPath}`);
    };
  }, fn);
}

export async function withCommonDirOperationLocks<T>(commonDirs: readonly string[], fn: () => Promise<T>, options?: AcquireLockOptions): Promise<T> {
  const real = [...new Set(await Promise.all(commonDirs.map((commonDir) => fs.realpath(commonDir))))].sort(byteCompare);
  const acquireAt = (index: number): Promise<T> => index === real.length
    ? fn()
    : withDurableClass("operation", real[index]!, path.join(real[index]!, "rbox-operation.lock"), () => acquireAt(index + 1), options);
  return acquireAt(0);
}

export async function withRepoOperationLock<T>(repoDir: string, fn: () => Promise<T>, options?: AcquireLockOptions): Promise<T> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while acquiring protocol operation lock");
  return withCommonDirOperationLocks([ctx.commonDir], fn, options);
}

export const reflogMaintenanceLockPath = (commonDir: string, ref: string): string => {
  const components = ref.split("/");
  if (!ref.startsWith("refs/") || Buffer.byteLength(ref, "utf8") > 1_024
    || components.some((part) => part === "" || part === "." || part === ".." || part.endsWith(".lock"))
    || ref.endsWith(".") || ref.includes("..") || /[\x00-\x20\x7f~^:?*[\\]/.test(ref)
    || ref.includes("@{")) throw new Error("invalid reflog lock ref");
  const refHash = crypto.createHash("sha256").update(Buffer.from(ref, "utf8")).digest("hex");
  return path.join(commonDir, "rbox-locks", "reflog", "v1", `${refHash}.lock`);
};

export async function withReflogMaintenanceLocks<T>(commonDir: string, refs: readonly string[], fn: () => Promise<T>, options?: AcquireLockOptions): Promise<T> {
  const real = await fs.realpath(commonDir);
  const ordered = [...new Set(refs)].sort(byteCompare);
  const acquireAt = (index: number): Promise<T> => index === ordered.length
    ? fn()
    : withDurableClass("reflog", `${real}\0${ordered[index]!}`, reflogMaintenanceLockPath(real, ordered[index]!), () => acquireAt(index + 1), options);
  return acquireAt(0);
}

export async function withKeepOriginsLock<T>(commonDir: string, fn: () => Promise<T>, options?: AcquireLockOptions): Promise<T> {
  const real = await fs.realpath(commonDir);
  return withDurableClass("origin", real, path.join(real, "rbox-keep-origins.json.lock"), fn, options);
}

export async function withRepoProtocolLocks<T>(
  repoDir: string,
  request: { reflogRefs?: readonly string[]; origins?: boolean },
  fn: () => Promise<T>,
  options?: AcquireLockOptions,
): Promise<T> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while acquiring protocol locks");
  return withCommonDirOperationLocks([ctx.commonDir], () =>
    withReflogMaintenanceLocks(ctx.commonDir, request.reflogRefs ?? [], () =>
      request.origins ? withKeepOriginsLock(ctx.commonDir, fn, options) : fn(), options), options);
}

export interface RepositoryProtocolFenceRequest {
  commonDir: string;
  reflogRefs?: readonly string[];
  origins?: boolean;
}

/** Complete reset/recovery repository fence. The caller already owns the
 * workspace mutex. Every repository class is acquired globally before state,
 * so helpers running inside the callback may safely reuse their ordinary
 * wrappers: exact durable classes are already held and nested Git phases are
 * covered by the encompassing phase. */
export async function withRepositoryRecoveryFence<T>(
  requests: readonly RepositoryProtocolFenceRequest[],
  stateIdentity: string,
  fn: () => Promise<T>,
  options?: AcquireLockOptions,
): Promise<T> {
  const normalized = new Map<string, { refs: Set<string>; origins: boolean }>();
  for (const request of requests) {
    const real = await fs.realpath(request.commonDir);
    const current = normalized.get(real) ?? { refs: new Set<string>(), origins: false };
    for (const ref of request.reflogRefs ?? []) current.refs.add(ref);
    current.origins ||= request.origins === true;
    normalized.set(real, current);
  }
  const commonDirs = [...normalized.keys()].sort(byteCompare);
  const acquireReflogs = (index: number, next: () => Promise<T>): Promise<T> => {
    if (index === commonDirs.length) return next();
    const commonDir = commonDirs[index]!;
    return withReflogMaintenanceLocks(commonDir, [...normalized.get(commonDir)!.refs], () => acquireReflogs(index + 1, next), options);
  };
  const originDirs = commonDirs.filter((commonDir) => normalized.get(commonDir)!.origins);
  const acquireOrigins = (index: number, next: () => Promise<T>): Promise<T> => index === originDirs.length
    ? next()
    : withKeepOriginsLock(originDirs[index]!, () => acquireOrigins(index + 1, next), options);
  const coveredRepositoryClasses = ["git", "reservation", "orig-head", "index"] as const;
  const acquireClassPlanes = (classIndex: number, dirIndex: number): Promise<T> => {
    if (classIndex === coveredRepositoryClasses.length) {
      return withCoveredClasses(coveredRepositoryClasses, () => withProtocolLockClass("state", stateIdentity, fn));
    }
    if (dirIndex === commonDirs.length) return acquireClassPlanes(classIndex + 1, 0);
    const lockClass = coveredRepositoryClasses[classIndex]!;
    return withProtocolLockClass(lockClass, commonDirs[dirIndex]!, () => acquireClassPlanes(classIndex, dirIndex + 1));
  };
  return withCommonDirOperationLocks(commonDirs, () =>
    acquireReflogs(0, () => acquireOrigins(0, () => acquireClassPlanes(0, 0))), options);
}
