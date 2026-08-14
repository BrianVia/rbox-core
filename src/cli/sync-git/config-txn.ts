import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { fsyncDirectory } from "../../engine/fsutil.js";
import { hashBytes } from "../../engine/hash.js";
import { canonicalizeGitConfig, MAX_GIT_CONFIG_FILE_BYTES, validateCanonicalGitConfig, type GitConfig, type GitConfigCanonicalization } from "./config-sync.js";
import { acquireLock, compareProcessStart, systemLockIdentity, type AcquireLockOptions, type LockIdentitySource, type OwnedLock, type ProcessIncarnation } from "../../engine/lockfile.js";
import { parseNullDelimitedGitConfig } from "./git-state.js";
import { gitRaw } from "../../engine/git-spawn.js";

export type ConfigFaultDisposition = "permanent" | "transient";

export interface ConfigFault {
  disposition: ConfigFaultDisposition;
  reason:
    | "missing"
    | "permission"
    | "symlink"
    | "non-regular"
    | "over-cap"
    | "unstable"
    | "read-error"
    | "parse-error"
    | "lock-busy"
    | "lock-unsupported"
    | "lock-error"
    | "owner-lost"
    | "candidate-error"
    | "bytes-changed";
  error?: unknown;
}

export interface ConfigStatToken {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface ConfigSnapshot {
  bytes: Buffer;
  token: ConfigStatToken;
}

export type ConfigReadResult = { ok: true; snapshot: ConfigSnapshot } | { ok: false; fault: ConfigFault };

export interface ParsedConfigSnapshot extends ConfigSnapshot {
  entries: Array<[key: string, value: string]>;
}

export type ParsedConfigReadResult = { ok: true; snapshot: ParsedConfigSnapshot } | { ok: false; fault: ConfigFault };

export type ConfigTransactionResult =
  | {
      status: "completed";
      attempts: number;
      pre: GitConfigCanonicalization;
      post: GitConfigCanonicalization;
      preHash: string;
      postHash: string;
      incomingHash: string;
      baseHash?: string;
      postBytes: Buffer;
      postToken: ConfigStatToken;
      warnings: string[];
    }
  | { status: "deferred"; attempts: number; fault: ConfigFault }
  | { status: "disabled"; attempts: number; fault: ConfigFault };

export type GitConfigRunner = (repoDir: string, args: string[]) => Promise<string>;

export interface ConfigTransactionHooks {
  afterB1?: (snapshot: ConfigSnapshot, attempt: number) => void | Promise<void>;
  afterCandidateFsync?: (candidatePath: string, attempt: number) => void | Promise<void>;
  afterLock?: (lockPath: string, attempt: number) => void | Promise<void>;
  beforeOwnerRecheck?: (lockPath: string, attempt: number) => void | Promise<void>;
  afterRename?: (configPath: string, attempt: number) => void | Promise<void>;
}

export interface ConfigTransactionOptions {
  attempts?: number;
  identity?: LockIdentitySource;
  lock?: Omit<AcquireLockOptions, "identity">;
  git?: GitConfigRunner;
  retryDelay?: (attempt: number, fault: ConfigFault) => void | Promise<void>;
  hooks?: ConfigTransactionHooks;
  /** Base config at the start of this pull apply. Hashed while the transaction
   * lock is held so the caller can apply the §6 sync-point rule exactly. */
  baseConfig?: GitConfig;
}

export interface SweepResult {
  removed: string[];
  spared: string[];
}

const SNAPSHOT_RE = /\.rbox93(?:\.lock)?$/;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function errno(error: NodeJS.ErrnoException | Error | undefined): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function fault(disposition: ConfigFaultDisposition, reason: ConfigFault["reason"], error?: Error): ConfigFault {
  const result: ConfigFault = { disposition, reason };
  if (error !== undefined) result.error = error;
  return result;
}

/** Exhaustive config open/stat/read error classification required by design §4. */
export function classifyConfigFsError(error: Error): ConfigFault {
  const code = errno(error);
  if (code === "ENOENT") return fault("transient", "missing", error);
  if (code === "EACCES" || code === "EPERM") return fault("permanent", "permission", error);
  if (code === "ELOOP") return fault("permanent", "symlink", error);
  if (code === "EISDIR" || code === "ENOTDIR") return fault("permanent", "non-regular", error);
  return fault("transient", "read-error", error);
}

function sameStat(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function statToken(stat: BigIntStats): ConfigStatToken {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

export function sameConfigStatToken(a: ConfigStatToken | undefined, b: ConfigStatToken | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function stableOverCap(filePath: string, first: BigIntStats): Promise<ConfigReadResult> {
  try {
    const second = await fs.lstat(filePath, { bigint: true });
    if (!second.isFile()) return { ok: false, fault: fault("permanent", second.isSymbolicLink() ? "symlink" : "non-regular") };
    if (!sameStat(first, second)) return { ok: false, fault: fault("transient", "unstable") };
    return { ok: false, fault: fault("permanent", "over-cap") };
  } catch (error) {
    return { ok: false, fault: classifyConfigFsError(error as Error) };
  }
}

/** lstat + O_NOFOLLOW + bounded 1 MiB+1 handle read with a full stat bracket. */
export async function readConfigSnapshot(filePath: string, phase: "initial" | "locked" = "initial"): Promise<ConfigReadResult> {
  let before: BigIntStats;
  try {
    before = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    return { ok: false, fault: classifyConfigFsError(error as Error) };
  }
  if (before.isSymbolicLink()) return { ok: false, fault: fault("permanent", "symlink") };
  if (!before.isFile()) return { ok: false, fault: fault("permanent", "non-regular") };
  if (before.size > BigInt(MAX_GIT_CONFIG_FILE_BYTES)) {
    if (phase === "locked") return { ok: false, fault: fault("transient", "over-cap") };
    return stableOverCap(filePath, before);
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return { ok: false, fault: fault("permanent", "non-regular") };
    if (!sameStat(before, opened)) return { ok: false, fault: fault("transient", "unstable") };

    const bytes = Buffer.alloc(MAX_GIT_CONFIG_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(filePath, { bigint: true });
    if (!afterPath.isFile()) return { ok: false, fault: fault("permanent", afterPath.isSymbolicLink() ? "symlink" : "non-regular") };
    if (!sameStat(opened, afterHandle) || !sameStat(afterHandle, afterPath)) return { ok: false, fault: fault("transient", "unstable") };
    if (offset > MAX_GIT_CONFIG_FILE_BYTES) return { ok: false, fault: fault("transient", "over-cap") };
    return { ok: true, snapshot: { bytes: bytes.subarray(0, offset), token: statToken(afterHandle) } };
  } catch (error) {
    return { ok: false, fault: classifyConfigFsError(error as Error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeSnapshotTemp(configPath: string, bytes: Buffer): Promise<string> {
  const snapshotPath = path.join(path.dirname(configPath), `${path.basename(configPath)}.snapshot-${process.pid}-${crypto.randomBytes(16).toString("hex")}.rbox93`);
  const handle = await fs.open(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return snapshotPath;
}

/** Git parses only the bounded snapshot file, never the live config path. */
export async function parseConfigSnapshot(repoDir: string, configPath: string, snapshot: ConfigSnapshot, runGit: GitConfigRunner = gitRaw): Promise<ParsedConfigReadResult> {
  let snapshotPath: string | undefined;
  try {
    snapshotPath = await writeSnapshotTemp(configPath, snapshot.bytes);
    let raw: string;
    try {
      raw = await runGit(repoDir, ["config", "--file", snapshotPath, "--no-includes", "--get-regexp", "-z", ".*"]);
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) raw = "";
      else return { ok: false, fault: fault("permanent", "parse-error", error as Error) };
    }
    return { ok: true, snapshot: { ...snapshot, entries: parseNullDelimitedGitConfig(raw) } };
  } catch (error) {
    return { ok: false, fault: errno(error as Error) ? classifyConfigFsError(error as Error) : fault("permanent", "parse-error", error as Error) };
  } finally {
    if (snapshotPath) await fs.unlink(snapshotPath).catch(() => {});
  }
}

export async function readParsedConfigSnapshot(repoDir: string, configPath: string, phase: "initial" | "locked" = "initial", runGit: GitConfigRunner = gitRaw): Promise<ParsedConfigReadResult> {
  const read = await readConfigSnapshot(configPath, phase);
  if (!read.ok) return read;
  return parseConfigSnapshot(repoDir, configPath, read.snapshot, runGit);
}

/** Capture/status read: keep the live file inside the stability bracket while Git
 * parses the bounded snapshot. Git still receives only the same-directory temp;
 * this final no-follow stat detects a writer that commits during the subprocess. */
export async function readStableParsedConfigSnapshot(
  repoDir: string,
  configPath: string,
  phase: "initial" | "locked" = "initial",
  runGit: GitConfigRunner = gitRaw
): Promise<ParsedConfigReadResult> {
  const parsed = await readParsedConfigSnapshot(repoDir, configPath, phase, runGit);
  if (!parsed.ok) return parsed;
  try {
    const afterParse = await fs.lstat(configPath, { bigint: true });
    if (afterParse.isSymbolicLink()) return { ok: false, fault: fault("permanent", "symlink") };
    if (!afterParse.isFile()) return { ok: false, fault: fault("permanent", "non-regular") };
    if (afterParse.size > BigInt(MAX_GIT_CONFIG_FILE_BYTES)) return { ok: false, fault: fault("transient", "over-cap") };
    if (!sameConfigStatToken(statToken(afterParse), parsed.snapshot.token)) {
      return { ok: false, fault: fault("transient", "unstable") };
    }
    return parsed;
  } catch (error) {
    return { ok: false, fault: classifyConfigFsError(error as Error) };
  }
}

function candidateName(configPath: string, incarnation: ProcessIncarnation, token: string): string {
  return path.join(path.dirname(configPath), `${path.basename(configPath)}.${incarnation.hostId}-${incarnation.pid}-${incarnation.startTime}-${token}.rbox93`);
}

async function createCandidate(configPath: string, incarnation: ProcessIncarnation, bytes: Buffer, token: string): Promise<string> {
  const candidatePath = candidateName(configPath, incarnation, token);
  const handle = await fs.open(candidatePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return candidatePath;
}

async function reopenAndFsync(candidatePath: string): Promise<void> {
  const handle = await fs.open(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("candidate final path is not regular");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupCandidate(candidatePath: string | undefined): Promise<void> {
  if (!candidatePath) return;
  await Promise.all([
    fs.unlink(candidatePath).catch(() => {}),
    fs.unlink(`${candidatePath}.lock`).catch(() => {}),
  ]);
}

function transactionOutcome(attempt: number, faultValue: ConfigFault): ConfigTransactionResult {
  return faultValue.disposition === "permanent"
    ? { status: "disabled", attempts: attempt, fault: faultValue }
    : { status: "deferred", attempts: attempt, fault: faultValue };
}

function configHash(config: GitConfig): string {
  return hashBytes(Buffer.from(JSON.stringify(config)));
}

/** Optimistic-CAS add-only transaction. The rename is the sole commit point. */
export async function applyConfigTransaction(repoDir: string, configPath: string, desired: GitConfig, options: ConfigTransactionOptions = {}): Promise<ConfigTransactionResult> {
  const validation = validateCanonicalGitConfig(desired);
  if (!validation.ok) return { status: "disabled", attempts: 0, fault: fault("permanent", "parse-error", new Error(validation.reason)) };
  const maxAttempts = Math.max(1, options.attempts ?? 3);
  const identity = options.identity ?? systemLockIdentity;
  const runGit = options.git ?? gitRaw;
  let lastFault = fault("transient", "read-error");

  // Sweep is best-effort and runs only when a config transaction is already due;
  // it never adds per-cycle work to the warm carry path.
  await sweepConfigTransactionOrphans(configPath, identity).catch(() => {});

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidatePath: string | undefined;
    let ownedLock: OwnedLock | undefined;
    let committed = false;
    const prepareRetry = async (retryFault: ConfigFault): Promise<void> => {
      if (ownedLock) {
        await ownedLock.release();
        ownedLock = undefined;
      }
      await cleanupCandidate(candidatePath);
      candidatePath = undefined;
      if (attempt < maxAttempts) await options.retryDelay?.(attempt, retryFault);
    };
    try {
      const b1 = await readParsedConfigSnapshot(repoDir, configPath, "initial", runGit);
      if (!b1.ok) {
        lastFault = b1.fault;
        if (lastFault.disposition === "permanent") return transactionOutcome(attempt, lastFault);
        await prepareRetry(lastFault);
        continue;
      }
      await options.hooks?.afterB1?.(b1.snapshot, attempt);

      let incarnation: ProcessIncarnation;
      try {
        incarnation = await identity.current();
      } catch (error) {
        return { status: "disabled", attempts: attempt, fault: fault("permanent", "lock-unsupported", error as Error) };
      }
      const candidateToken = crypto.randomBytes(16).toString("hex");
      candidatePath = await createCandidate(configPath, incarnation, b1.snapshot.bytes, candidateToken);
      const present = new Set(b1.snapshot.entries.map(([key]) => key));
      for (const [key, values] of Object.entries(desired)) {
        if (present.has(key)) continue;
        for (const value of values) await runGit(repoDir, ["config", "--file", candidatePath, "--add", key, value]);
      }
      await reopenAndFsync(candidatePath);
      await options.hooks?.afterCandidateFsync?.(candidatePath, attempt);
      const candidate = await readParsedConfigSnapshot(repoDir, candidatePath, "locked", runGit);
      if (!candidate.ok) {
        lastFault = candidate.fault.disposition === "permanent" ? fault("transient", "candidate-error", candidate.fault.error as Error | undefined) : candidate.fault;
        await prepareRetry(lastFault);
        continue;
      }

      const acquired = await acquireLock(`${configPath}.lock`, { ...options.lock, identity });
      if (acquired.status !== "acquired") {
        const lockError = acquired.status === "error" ? classifyConfigFsError(acquired.error as Error) : undefined;
        lastFault = acquired.status === "held"
          ? fault("transient", "lock-busy")
          : acquired.status === "unsupported"
            ? fault("permanent", "lock-unsupported", acquired.error as Error)
            : lockError?.disposition === "permanent"
              ? lockError
              : fault("transient", "lock-error", acquired.error as Error);
        if (lastFault.disposition === "permanent") return transactionOutcome(attempt, lastFault);
        await prepareRetry(lastFault);
        continue;
      }
      ownedLock = acquired.lock;
      await options.hooks?.afterLock?.(`${configPath}.lock`, attempt);

      const b2 = await readConfigSnapshot(configPath, "locked");
      if (!b2.ok) {
        lastFault = b2.fault;
        if (lastFault.disposition === "permanent") return transactionOutcome(attempt, lastFault);
        await prepareRetry(lastFault);
        continue;
      }
      if (!b2.snapshot.bytes.equals(b1.snapshot.bytes)) {
        lastFault = fault("transient", "bytes-changed");
        await prepareRetry(lastFault);
        continue;
      }
      if (!(await ownedLock.recheckOwner(() => options.hooks?.beforeOwnerRecheck?.(`${configPath}.lock`, attempt)))) {
        lastFault = fault("transient", "owner-lost");
        await prepareRetry(lastFault);
        continue;
      }

      // Design 93 §6: every apply-decision hash is derived while config.lock is
      // held. The canonical maps themselves were built from the bracketed B1 and
      // candidate snapshots; hashing them here keeps the persisted sync point tied
      // to this exact transaction.
      const pre = canonicalizeGitConfig(b1.snapshot.entries);
      const candidatePost = canonicalizeGitConfig(candidate.snapshot.entries);
      if (!pre.ok) {
        lastFault = fault("permanent", "parse-error", new Error(pre.reason));
        return transactionOutcome(attempt, lastFault);
      }
      if (!candidatePost.ok) {
        lastFault = fault("permanent", "parse-error", new Error(candidatePost.reason));
        return transactionOutcome(attempt, lastFault);
      }
      const preHash = configHash(pre.config);
      const incomingHash = configHash(desired);
      const baseHash = options.baseConfig === undefined ? undefined : configHash(options.baseConfig);

      await fs.rename(candidatePath, configPath);
      committed = true;
      candidatePath = undefined;
      const warnings: string[] = [];
      let postBytes = candidate.snapshot.bytes;
      let postToken: ConfigStatToken = candidate.snapshot.token;
      let post: GitConfigCanonicalization = candidatePost;
      try {
        await options.hooks?.afterRename?.(configPath, attempt);
        const installed = await readConfigSnapshot(configPath, "locked");
        if (installed.ok) {
          postBytes = installed.snapshot.bytes;
          postToken = installed.snapshot.token;
          const parsedInstalled = await parseConfigSnapshot(repoDir, configPath, installed.snapshot, runGit);
          if (parsedInstalled.ok) post = canonicalizeGitConfig(parsedInstalled.snapshot.entries);
          else warnings.push(`post-rename parse: ${parsedInstalled.fault.reason}`);
        } else warnings.push(`post-rename read: ${installed.fault.reason}`);
      } catch (error) {
        warnings.push(`post-rename hook: ${errno(error as Error) ?? String(error)}`);
      }
      // Capture the final sync-point hash before releasing config.lock. Cleanup
      // below is deliberately non-fatal, but it must not move hash computation
      // outside the transaction boundary.
      const postHash = post.ok ? configHash(post.config) : configHash(candidatePost.config);
      try {
        await fsyncDirectory(path.dirname(configPath));
      } catch (error) {
        warnings.push(`post-rename directory fsync: ${errno(error as Error) ?? String(error)}`);
      }
      const released = await ownedLock.release();
      if (!released.released || !released.durable) warnings.push("post-rename lock release was not durable");
      const result: Extract<ConfigTransactionResult, { status: "completed" }> = {
        status: "completed",
        attempts: attempt,
        pre,
        post,
        preHash,
        postHash,
        incomingHash,
        postBytes,
        postToken,
        warnings,
      };
      if (baseHash !== undefined) result.baseHash = baseHash;
      return result;
    } catch (error) {
      const fsFault = errno(error as Error) ? classifyConfigFsError(error as Error) : undefined;
      lastFault = fsFault?.disposition === "permanent" ? fsFault : fault("transient", "candidate-error", error as Error);
    } finally {
      if (!committed) {
        if (ownedLock) await ownedLock.release();
        await cleanupCandidate(candidatePath);
      }
    }
    if (lastFault.disposition === "permanent") return transactionOutcome(attempt, lastFault);
    if (attempt < maxAttempts) await options.retryDelay?.(attempt, lastFault);
  }
  return { status: "deferred", attempts: maxAttempts, fault: lastFault };
}

/** Fresh targets are private and uncontended, so use Git's ordinary local path. */
export async function materializeFreshGitConfig(repoDir: string, desired: GitConfig, cleanupTarget: string, runGit: GitConfigRunner = gitRaw): Promise<void> {
  try {
    const validation = validateCanonicalGitConfig(desired);
    if (!validation.ok) throw new Error(validation.reason);
    for (const [key, values] of Object.entries(desired)) {
      for (const value of values) await runGit(repoDir, ["config", "--local", "--add", key, value]);
    }
  } catch (error) {
    await fs.rm(cleanupTarget, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

interface CandidateMarker {
  hostId: string;
  pid: number;
  startTime: string;
}

function parseCandidateName(configBase: string, name: string): CandidateMarker | undefined {
  const escaped = configBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}\\.([0-9a-f-]+)-([1-9]\\d*)-(\\d+(?:\\.\\d+)?)-[0-9a-f]{32}\\.rbox93(?:\\.lock)?$`).exec(name);
  if (!match) return undefined;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid)) return undefined;
  return { hostId: match[1]!, pid, startTime: match[3]! };
}

/** Sweep only provably dead same-host candidates; malformed names need >24 h. */
export async function sweepConfigTransactionOrphans(configPath: string, identity: LockIdentitySource = systemLockIdentity, nowMs = Date.now()): Promise<SweepResult> {
  const dir = path.dirname(configPath);
  const configBase = path.basename(configPath);
  const result: SweepResult = { removed: [], spared: [] };
  const names = (await fs.readdir(dir)).filter((name) => SNAPSHOT_RE.test(name) && name.startsWith(`${configBase}.`));
  let current: ProcessIncarnation;
  try {
    current = await identity.current();
  } catch {
    return { removed: [], spared: names };
  }
  for (const name of names) {
    const absolute = path.join(dir, name);
    const parsed = parseCandidateName(configBase, name);
    let remove = false;
    if (parsed) {
      if (parsed.hostId === current.hostId) {
        const probe = await identity.probe(parsed.pid);
        remove = probe.status === "dead"
          || (probe.status === "alive" && compareProcessStart(parsed.startTime, probe.startTime) === "different");
      }
    } else {
      const stat = await fs.lstat(absolute).catch(() => undefined);
      remove = !!stat && nowMs - stat.mtimeMs > ORPHAN_AGE_MS;
    }
    if (remove) {
      try {
        await fs.unlink(absolute);
        result.removed.push(name);
      } catch (error) {
        if (errno(error as Error) !== "ENOENT") result.spared.push(name);
      }
    } else result.spared.push(name);
  }
  return result;
}
