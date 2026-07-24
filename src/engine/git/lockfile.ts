import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../fsutil.js";

const MARKER_PREFIX = "rbox-93";
const MARKER_MAX_BYTES = 1024;
const LEDGER_MAX_BYTES = 32 * 1024;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[0-9a-f-]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const START_RE = /^\d+(?:\.\d+)?$/;
const LINUX_LOCAL_FS = new Set([0xef53n, 0x9123683en, 0x58465342n, 0x2fc12fc1n, 0xf2f52010n, 0x01021994n, 0x794c7630n]);
const DARWIN_LOCAL_FS = new Set(["apfs", "hfs"]);
const bootSeenAt = Math.max(0, Math.floor(Date.now() - process.uptime() * 1000));

export interface ProcessIncarnation {
  hostId: string;
  bootId: string;
  pid: number;
  startTime: string;
}

export interface LockMarker extends ProcessIncarnation {
  token: string;
}

export interface HostIdentityBoot {
  platformUuid?: string;
  kernUuid: string;
  bootSessionUuid: string;
  seenAt: number;
}

/** Enrichment used by new readers only. LockMarker deliberately remains wire-only. */
export interface ResolvedLockIdentity extends ProcessIncarnation {
  platformUuid?: string;
  knownBoots?: readonly HostIdentityBoot[];
}

export type ProcessProbe =
  | { status: "alive"; startTime: string }
  | { status: "dead" }
  | { status: "unknown"; error?: unknown };

export interface LockIdentitySource {
  current(): Promise<ProcessIncarnation | ResolvedLockIdentity>;
  probe(pid: number): Promise<ProcessProbe>;
}

export interface LockStorageStat {
  dev: bigint;
  type: bigint | string;
  local?: boolean;
}

export interface DarwinMountStat extends LockStorageStat {
  type: string;
  local: boolean;
}

export interface LockfileHooks {
  link?: (existingPath: string, newPath: string) => Promise<void>;
  afterTempFsync?: (tempPath: string, marker: string) => void | Promise<void>;
  /** Final cooperative-abort seam after durable staging and immediately before
   * the hardlink publishes the visible lock. */
  beforeLink?: (lockPath: string, marker: string) => void | Promise<void>;
  afterCreate?: (lockPath: string, marker: string) => void | Promise<void>;
  beforeCreatedCleanup?: (lockPath: string) => void | Promise<void>;
  beforeReapInspect?: (lockPath: string) => void | Promise<void>;
  beforeReapUnlink?: (lockPath: string) => void | Promise<void>;
  beforeReleaseUnlink?: (lockPath: string) => void | Promise<void>;
}

export interface MarkerObservation {
  dev: bigint;
  inode: bigint;
  size: bigint;
  mtimeNs: bigint;
  /** Inode birth time. 0 when the filesystem reports none (unsupported). It
   * distinguishes a same-bytes successor that reused a freed inode. */
  birthtimeNs: bigint;
  /** Byte-preserving latin1 prefix (ASCII for rbox markers). */
  raw: string;
}

/** JSON-safe form of the exact no-follow observation used as unlink authority. */
export interface SerializedMarkerObservation {
  dev: string;
  inode: string;
  size: string;
  mtimeNs: string;
  birthtimeNs: string;
  raw: string;
}

/** Filesystem identity fence for a canonical Git common directory. */
export interface CommonDirIdentity {
  path: string;
  realpath: string;
  dev: string;
  ino: string;
  birthtimeNs: string;
}

export type ProcessIncarnationClassification = "alive" | "dead" | "unknown";

export type MarkerPublishResult =
  | { status: "created"; observation: MarkerObservation }
  | { status: "exists" }
  | { status: "error"; error: unknown };

export type LockInspection =
  | { kind: "absent" }
  | { kind: "live"; marker: LockMarker; raw: string; identityDrift?: boolean; observation: MarkerObservation }
  | { kind: "dead"; marker: LockMarker; raw: string; observation: MarkerObservation }
  | { kind: "foreign"; raw?: string; reason: string; observation?: MarkerObservation };

export type LockBlockerKind = "live" | "foreign" | "stale-owned" | "fence";
export type LockWarningReason = "foreign" | "identity-drift" | "stale-owned" | "fence";

export type LockAcquireResult =
  | { status: "acquired"; lock: OwnedLock }
  | {
      status: "held";
      inspection: Exclude<LockInspection, { kind: "absent" }>;
      blockerKind: LockBlockerKind;
      warningReason?: LockWarningReason;
      holderKey: string;
    }
  | { status: "unsupported"; error: unknown }
  | { status: "error"; error: unknown };

export interface LockReleaseResult {
  released: boolean;
  durable: boolean;
  error?: unknown;
}

export interface AcquireLockOptions {
  identity?: LockIdentitySource;
  hooks?: LockfileHooks;
  token?: () => string;
  storageLocal?: (storagePath: string) => Promise<boolean>;
  /** Exact visible marker mode. Defaults to private 0600. Reap fences inherit it. */
  markerMode?: number;
  /** Avoid the optional home-scoped boot-history cache (callers still use live OS identity). */
  skipIdentityRefresh?: boolean;
}

interface MarkerRead extends MarkerObservation {
  marker?: LockMarker;
  reason?: string;
}

interface AtomicCreateResult {
  status: "created" | "exists" | "unsupported" | "error";
  error?: unknown;
}

interface ReapBlocker {
  inspection: Exclude<LockInspection, { kind: "absent" }>;
  kind: LockBlockerKind;
  reason?: LockWarningReason;
}

type ReapResult = { status: "reaped" } | { status: "retry" } | { status: "blocked"; blocker: ReapBlocker };

const staleOwnedMarkers = new Map<string, string>();
const localStorageCache = new Map<string, boolean>();
const darwinFallbackOwnStart = Math.max(1, Math.floor((Date.now() - process.uptime() * 1000) * 1000)).toString();

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export type ProcessStartComparison = "same" | "different" | "incomparable";

/** Compare a recorded process-start reading with a freshly probed one.
 *
 * String equality alone is wrong the moment one host can read the clock two
 * ways. macOS reports `seconds.microseconds` through sysctl and whole `seconds`
 * through ps (macOS 26 dropped the sysctl OID name), and a transient sysctl
 * failure can switch a single host between them mid-boot. Treating that as a
 * different incarnation would classify a LIVE owner dead and authorise reaping
 * its lock, so the two are compared at the coarser of their resolutions.
 *
 * The pre-ps binaries had no foreign reading at all and fell back to a
 * process-uptime estimate in whole MICROSECONDS for their own pid. Such a value
 * is a bare integer far too large to be epoch seconds, and it cannot be
 * reconciled with a second clock at all — it is reported incomparable so a
 * marker written by one of those binaries, in this boot, reads as unknown
 * liveness rather than as a dead owner. Every caller maps unknown to "leave it
 * alone", which is the only safe reading. Linux tick-since-boot values stay far
 * below the threshold and are unaffected. */
export function compareProcessStart(recorded: string, probed: string): ProcessStartComparison {
  if (recorded === probed) return "same";
  const microsecondClock = (value: string): boolean => !value.includes(".") && value.length >= 13;
  if (microsecondClock(recorded) !== microsecondClock(probed)) return "incomparable";
  const [recordedSeconds, recordedFraction] = recorded.split(".");
  const [probedSeconds, probedFraction] = probed.split(".");
  if (recordedSeconds === probedSeconds && (recordedFraction === undefined || probedFraction === undefined)) return "same";
  return "different";
}

/** Shared strict validator for journal-carried process incarnations. */
export function validProcessIncarnation(value: unknown): value is ProcessIncarnation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Partial<ProcessIncarnation>;
  return typeof owner.hostId === "string" && owner.hostId.length > 0 && owner.hostId.length <= 256
    && typeof owner.bootId === "string" && owner.bootId.length > 0 && owner.bootId.length <= 256
    && Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0
    && typeof owner.startTime === "string" && owner.startTime.length > 0 && owner.startTime.length <= 128;
}

/** Classify an owner by host, boot, PID, and process-start identity. A host
 * mismatch or any unavailable evidence is unknown; neither authorizes reap. */
export async function classifyProcessIncarnation(
  owner: ProcessIncarnation,
  identity: LockIdentitySource = systemLockIdentity,
): Promise<ProcessIncarnationClassification> {
  if (!validProcessIncarnation(owner)) return "unknown";
  let current: ProcessIncarnation;
  try {
    current = await identity.current();
  } catch {
    return "unknown";
  }
  if (current.hostId !== owner.hostId) return "unknown";
  if (current.bootId !== owner.bootId) return "dead";
  try {
    const probe = await identity.probe(owner.pid);
    if (probe.status === "unknown") return "unknown";
    if (probe.status === "dead") return "dead";
    const start = compareProcessStart(owner.startTime, probe.startTime);
    return start === "incomparable" ? "unknown" : start === "different" ? "dead" : "alive";
  } catch {
    return "unknown";
  }
}

/** Capture a path-and-inode fence without accepting a symlink alias. */
export async function captureCommonDirIdentity(commonDir: string): Promise<CommonDirIdentity> {
  const absolute = path.resolve(commonDir);
  const realpath = await fs.realpath(absolute);
  if (realpath !== absolute) throw new Error(`symlinked Git common directory is unsupported: ${absolute}`);
  const stat = await fs.lstat(realpath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`invalid Git common directory: ${absolute}`);
  return {
    path: absolute,
    realpath,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

/** Revalidate both canonical pathname and filesystem identity. */
export async function commonDirIdentityMatches(expected: CommonDirIdentity): Promise<boolean> {
  try {
    const current = await captureCommonDirIdentity(expected.path);
    return current.realpath === expected.realpath && current.dev === expected.dev
      && current.ino === expected.ino && current.birthtimeNs === expected.birthtimeNs;
  } catch {
    return false;
  }
}

/** Validate/create a lock's bounded parent without following symlink
 * components. Missing parents are explicit absence for recovery callers. */
export async function safeBoundLockParent(
  root: string,
  leaf: string,
  options: { create: boolean },
): Promise<"safe" | "absent"> {
  const boundedRoot = path.resolve(root);
  const boundedLeaf = path.resolve(leaf);
  if (!path.isAbsolute(root) || !path.isAbsolute(leaf) || boundedLeaf !== leaf || !boundedLeaf.endsWith(".lock")
    || !boundedLeaf.startsWith(`${boundedRoot}${path.sep}`)) {
    throw new Error(`Git lock path escaped common directory: ${leaf}`);
  }
  let rootStat;
  try {
    rootStat = await fs.lstat(boundedRoot);
  } catch (error) {
    if (errno(error) === "ENOENT") return "absent";
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`unsafe Git lock root: ${boundedRoot}`);
  const rootReal = await fs.realpath(boundedRoot);
  if (rootReal !== boundedRoot) throw new Error(`symlinked Git lock root is unsupported: ${boundedRoot}`);

  const parent = path.dirname(boundedLeaf);
  if (options.create) {
    const created = await ensureDirectoryChain(parent, "Git lock parent");
    await fsyncCreatedDirectoryAncestors(parent, created);
  }
  let cursor = boundedRoot;
  for (const component of path.relative(boundedRoot, parent).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try {
      stat = await fs.lstat(cursor);
    } catch (error) {
      if (errno(error) === "ENOENT" && !options.create) return "absent";
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe Git lock parent: ${cursor}`);
  }
  const parentReal = await fs.realpath(parent);
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error(`Git lock parent escaped common directory: ${parent}`);
  }
  return "safe";
}

function isLinkUnsupported(error: unknown): boolean {
  return ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "EMLINK", "ENOSYS"].includes(errno(error) ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type IdentityCommand = (command: string, args: string[]) => Promise<Buffer>;

async function execBytes(command: string, args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(command, args, {
      encoding: "buffer",
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout));
    });
  });
}

/** Bounded identity subprocess runner, exported for adversarial platform tests. */
export const runIdentityCommand = execBytes;

function uuid(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  return UUID_RE.test(value) ? value : undefined;
}

async function retryComponent(read: () => Promise<string | undefined>): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const value = await read();
      if (value) return value;
    } catch {
      // Missing components remain independently retryable.
    }
    if (attempt < 2) await sleep(25 * (attempt + 1));
  }
  return undefined;
}

async function sysctlUuid(name: string, run: IdentityCommand): Promise<string | undefined> {
  const bytes = await run("/usr/sbin/sysctl", ["-n", name]);
  return bytes.length <= 1024 ? uuid(bytes.toString("utf8")) : undefined;
}

async function ioregPlatformUuid(run: IdentityCommand): Promise<string | undefined> {
  const raw = (await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])).toString("utf8");
  if (Buffer.byteLength(raw) > 64 * 1024) return undefined;
  const value = /"IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"/i.exec(raw)?.[1];
  return value ? uuid(value) : undefined;
}

export interface DarwinIdentityComponents {
  platformUuid?: string;
  kernUuid?: string;
  bootSessionUuid?: string;
}

/** Independently resolves Darwin's stable platform identity and compatible wire pair. */
export async function resolveDarwinIdentityComponents(run: IdentityCommand = execBytes): Promise<DarwinIdentityComponents> {
  const [kernUuid, bootSessionUuid, platformUuid] = await Promise.all([
    retryComponent(() => sysctlUuid("kern.uuid", run)),
    retryComponent(() => sysctlUuid("kern.bootsessionuuid", run)),
    retryComponent(async () => {
      try {
        const value = await sysctlUuid("kern.iokit.platform-uuid", run);
        return value ?? await ioregPlatformUuid(run);
      } catch {
        return await ioregPlatformUuid(run);
      }
    }),
  ]);
  return { kernUuid, bootSessionUuid, platformUuid };
}

/** `ps -o lstart=` under `LC_ALL=C`, e.g. `Fri Jul 24 23:05:12 2026`. The day is
 * space-padded to two columns. */
const PS_LSTART_RE = /^[A-Za-z]{3} ([A-Za-z]{3}) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;
const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Second-resolution start time from `ps`, the only per-process clock macOS 26
 * still exposes to a command-line caller after it dropped the `kern.proc.pid`
 * sysctl OID name. `TZ=UTC` makes the reading independent of the caller's zone
 * and removes the repeated-hour ambiguity a local-time rendering would carry, so
 * two reads of one process are byte-identical. */
async function darwinPsProcessStart(pid: number): Promise<string> {
  const run = await new Promise<{ stdout: string; failed: boolean; spawnError?: NodeJS.ErrnoException }>((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024,
      timeout: 2_000,
      killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
    }, (error, stdout) => {
      // A non-zero exit carries a numeric `code`; only a failure to run the
      // command at all carries an errno string. The two must not be conflated:
      // the first can still be a truthful "no such process".
      const spawnError = error && typeof (error as NodeJS.ErrnoException).code === "string" ? error as NodeJS.ErrnoException : undefined;
      resolve({ stdout, failed: !!error, ...(spawnError ? { spawnError } : {}) });
    });
  });
  if (run.spawnError) throw run.spawnError;
  const line = run.stdout.trim();
  if (!line) {
    // ps prints nothing and exits non-zero when no process matches. That is a
    // proven-absent process, exactly what an ESRCH sysctl read means.
    const error = new Error("process incarnation unavailable");
    (error as NodeJS.ErrnoException).code = "ESRCH";
    throw error;
  }
  if (run.failed) throw new Error("process start listing failed");
  const start = parseDarwinProcessStartListing(line);
  if (start === undefined) throw new Error("unparsable process start listing");
  return start;
}

/** Canonicalize one `TZ=UTC LC_ALL=C ps -o lstart=` line into whole epoch
 * seconds. Exported for adversarial platform tests: the value is compared for
 * equality across processes and binaries, so it must be a pure function of the
 * listing and never carry the reader's locale, zone, or clock. */
export function parseDarwinProcessStartListing(line: string): string | undefined {
  const match = PS_LSTART_RE.exec(line.trim());
  const month = match ? PS_MONTHS.indexOf(match[1]!) : -1;
  if (!match || month < 0) return undefined;
  const day = Number(match[2]);
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  const seconds = Number(match[5]);
  if (day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 60) return undefined;
  const ms = Date.UTC(Number(match[6]), month, day, hours, minutes, seconds);
  return Number.isFinite(ms) && ms >= 0 ? String(Math.floor(ms / 1000)) : undefined;
}

async function darwinProcessStart(pid: number): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await execBytes("/usr/sbin/sysctl", ["-b", `kern.proc.pid.${pid}`]);
  } catch (error) {
    // sysctl stays PRIMARY so a healthy host keeps producing byte-identical
    // microsecond readings. macOS 26 removed the `kern.proc.pid.<pid>` OID name,
    // so there the primary answers "unknown oid" with exit 1 for every live
    // process and every reading — self and foreign alike — comes from ps, which
    // keeps the writer and the prober on one clock. Same-boot mixing of the two
    // sources is handled by `compareProcessStart`, never by string equality.
    try {
      return await darwinPsProcessStart(pid);
    } catch (psError) {
      if (errno(psError) === "ESRCH") throw psError;
      if (pid === process.pid) return darwinFallbackOwnStart;
      throw error;
    }
  }
  if (bytes.length < 16) {
    const error = new Error("process incarnation unavailable");
    (error as NodeJS.ErrnoException).code = bytes.length === 0 ? "ESRCH" : "EIO";
    throw error;
  }
  const seconds = bytes.readBigInt64LE(0);
  const microseconds = bytes.readBigInt64LE(8);
  if (seconds < 0n || microseconds < 0n || microseconds >= 1_000_000n) throw new Error("invalid process incarnation");
  return `${seconds}.${microseconds.toString().padStart(6, "0")}`;
}

function parseLinuxProcStart(raw: string): string {
  const close = raw.lastIndexOf(")");
  if (close < 0) throw new Error("malformed /proc/<pid>/stat");
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  if (!start || !/^\d+$/.test(start)) throw new Error("missing /proc/<pid>/stat field 22");
  return start;
}

async function linuxProcessStart(pid: number): Promise<string> {
  return parseLinuxProcStart(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
}

export interface LinuxHostIdOptions {
  readFile?: (filePath: string) => Promise<string>;
  hostname?: () => string;
}

export async function resolveLinuxHostId(options: LinuxHostIdOptions = {}): Promise<string> {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFile(filePath, "utf8"));
  for (const filePath of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const candidate = (await readFile(filePath)).trim().toLowerCase();
      if (ID_RE.test(candidate)) return candidate;
    } catch {
      // Continue through the ordered fallback chain.
    }
  }
  try {
    const hostname = (options.hostname ?? os.hostname)().trim().toLowerCase();
    if (hostname) return crypto.createHash("sha256").update(`hostname:${hostname}`).digest("hex");
  } catch {
    // Total failure is reported below.
  }
  throw new Error("no Linux host identity source");
}

async function processStart(pid: number): Promise<string> {
  if (process.platform === "darwin") return darwinProcessStart(pid);
  if (process.platform === "linux") return linuxProcessStart(pid);
  throw new Error(`unsupported lock identity platform: ${process.platform}`);
}

async function probeProcess(pid: number): Promise<ProcessProbe> {
  try {
    return { status: "alive", startTime: await processStart(pid) };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(errno(error) ?? "")) return { status: "dead" };
    if (process.platform === "darwin") {
      try {
        process.kill(pid, 0);
      } catch (killError) {
        if (errno(killError) === "ESRCH") return { status: "dead" };
      }
    }
    return { status: "unknown", error };
  }
}

let cachedKernUuid: string | undefined;
let cachedBootSessionUuid: string | undefined;
let cachedPlatformUuid: string | undefined;
let cachedLinuxHostId: string | undefined;
let cachedLinuxBootId: string | undefined;
let cachedKnownBoots: readonly HostIdentityBoot[] | undefined;
let cachedOwnProcessStart: Promise<string> | undefined;
let systemLedgerRefresh: Promise<ResolvedLockIdentity> | undefined;

async function currentSystemIncarnation(): Promise<ResolvedLockIdentity> {
  let hostId: string | undefined;
  let bootId: string | undefined;
  let platformUuid: string | undefined;
  if (process.platform === "darwin") {
    if (!cachedKernUuid || !cachedBootSessionUuid || !cachedPlatformUuid) {
      const found = await resolveDarwinIdentityComponents();
      cachedKernUuid ??= found.kernUuid;
      cachedBootSessionUuid ??= found.bootSessionUuid;
      cachedPlatformUuid ??= found.platformUuid;
    }
    hostId = cachedKernUuid;
    bootId = cachedBootSessionUuid;
    platformUuid = cachedPlatformUuid;
  } else if (process.platform === "linux") {
    cachedLinuxHostId ??= await resolveLinuxHostId();
    if (!cachedLinuxBootId) {
      const candidate = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
      if (!UUID_RE.test(candidate)) throw new Error("invalid Linux boot identity source");
      cachedLinuxBootId = candidate;
    }
    hostId = cachedLinuxHostId;
    bootId = cachedLinuxBootId;
  } else {
    throw new Error(`unsupported lock identity platform: ${process.platform}`);
  }
  if (!hostId || !bootId || !ID_RE.test(hostId) || !ID_RE.test(bootId)) throw new Error("compatible lock identity unavailable");
  cachedOwnProcessStart ??= processStart(process.pid);
  return { hostId, bootId, platformUuid, knownBoots: cachedKnownBoots, pid: process.pid, startTime: await cachedOwnProcessStart };
}

export const systemLockIdentity: LockIdentitySource = {
  current: currentSystemIncarnation,
  probe: probeProcess,
};

function rboxHome(): string {
  if (!process.env.RBOX_HOME && process.env.RBOX_TEST_HOST_IDENTITY_DIR) {
    return process.env.RBOX_TEST_HOST_IDENTITY_DIR;
  }
  return path.join(process.env.RBOX_HOME || process.env.HOME || os.homedir(), ".rbox");
}

export function hostIdentityLedgerPath(): string {
  return path.join(rboxHome(), "host-identity.json");
}

function validBoot(value: unknown): value is HostIdentityBoot {
  if (!value || typeof value !== "object") return false;
  const boot = value as Partial<HostIdentityBoot>;
  const keys = Object.keys(boot);
  return keys.every((key) => ["platformUuid", "kernUuid", "bootSessionUuid", "seenAt"].includes(key))
    && keys.includes("kernUuid") && keys.includes("bootSessionUuid") && keys.includes("seenAt")
    && UUID_RE.test(boot.kernUuid ?? "")
    && UUID_RE.test(boot.bootSessionUuid ?? "")
    && (boot.platformUuid === undefined || UUID_RE.test(boot.platformUuid))
    && Number.isSafeInteger(boot.seenAt) && (boot.seenAt ?? -1) >= 0;
}

export async function readHostIdentityLedger(filePath: string): Promise<HostIdentityBoot[] | undefined> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return [];
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(LEDGER_MAX_BYTES)) return undefined;
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameStat(before, opened)) throw new Error("host identity ledger changed during read");
    const bytes = Buffer.alloc(LEDGER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    if (bytesRead > LEDGER_MAX_BYTES || !sameStat(opened, after) || BigInt(bytesRead) !== opened.size) {
      throw new Error("host identity ledger changed during read");
    }
    const parsed = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as { version?: unknown; boots?: unknown };
    if (!parsed || Object.keys(parsed).some((key) => !["version", "boots"].includes(key))
      || parsed.version !== 1 || !Array.isArray(parsed.boots) || parsed.boots.length > 8 || !parsed.boots.every(validBoot)) return undefined;
    return parsed.boots;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

export function mergeHostIdentityBoots(existing: readonly HostIdentityBoot[], current: HostIdentityBoot): HostIdentityBoot[] {
  const byBoot = new Map<string, HostIdentityBoot>();
  for (const boot of [...existing, current]) {
    const key = `${boot.kernUuid}\0${boot.bootSessionUuid}`;
    const prior = byBoot.get(key);
    if (!prior) byBoot.set(key, { ...boot });
    else byBoot.set(key, {
      kernUuid: boot.kernUuid,
      bootSessionUuid: boot.bootSessionUuid,
      platformUuid: boot.platformUuid || prior.platformUuid,
      seenAt: Math.max(prior.seenAt, boot.seenAt),
    });
  }
  const currentKey = `${current.kernUuid}\0${current.bootSessionUuid}`;
  const pinned = byBoot.get(currentKey)!;
  const history = [...byBoot.values()]
    .filter((boot) => `${boot.kernUuid}\0${boot.bootSessionUuid}` !== currentKey)
    .sort((a, b) => b.seenAt - a.seenAt || b.bootSessionUuid.localeCompare(a.bootSessionUuid))
    .slice(0, 7);
  return [pinned, ...history];
}

async function writeLedger(filePath: string, boots: readonly HostIdentityBoot[]): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(filePath, `${JSON.stringify({ version: 1, boots }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  await fsyncDirectory(dir);
}

/** Resolve and durably merge this boot before any normal marker is published. */
export async function refreshSystemLockIdentityLedger(): Promise<ResolvedLockIdentity> {
  systemLedgerRefresh ??= (async () => {
    const current = await systemLockIdentity.current() as ResolvedLockIdentity;
    // The v1 ledger records Darwin's kern UUID aliases. Linux's compatible wire
    // host id is commonly a 32-byte machine-id rather than a UUID; persisting it
    // into this UUID-only schema would make every subsequent read look corrupt.
    if (process.platform !== "darwin") return current;
    return refreshHostIdentityLedger(current);
  })().catch((error) => {
    // Never memoize a rejection (design 118 F1): a transient identity failure
    // must retry on the next acquire, not fail the process forever.
    systemLedgerRefresh = undefined;
    throw error;
  });
  return systemLedgerRefresh;
}

export async function refreshHostIdentityLedger(
  current: ResolvedLockIdentity,
  filePath = hostIdentityLedgerPath(),
  seenAt = bootSeenAt,
): Promise<ResolvedLockIdentity> {
  // The ledger is a boot-history CACHE that only sharpens stale-lock cleanup
  // across reboots. If ANY step fails to acquire its lock, read, or write it —
  // a transient stat race, a security agent monitoring ~/.rbox, an ACL/permission
  // quirk — workspace locking must still work: the live host/boot/platform
  // identity (already resolved by the caller) fully distinguishes machines and
  // boots. So a broken cache degrades to "no persisted history", never to a
  // failed identity that makes every lock acquisition "unsupported".
  try {
    return await refreshHostIdentityLedgerStrict(current, filePath, seenAt);
  } catch {
    return current;
  }
}

async function refreshHostIdentityLedgerStrict(
  current: ResolvedLockIdentity,
  filePath: string,
  seenAt: number,
): Promise<ResolvedLockIdentity> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const ledgerIdentity: LockIdentitySource = { current: async () => current, probe: systemLockIdentity.probe };
  const deadline = Date.now() + 2_000;
  let lockResult: LockAcquireResult;
  do {
    lockResult = await acquireLock(`${filePath}.lock`, { identity: ledgerIdentity, skipIdentityRefresh: true });
    if (lockResult.status === "acquired") break;
    if (lockResult.status !== "held") throw new Error("host identity ledger lock unavailable");
    await sleep(10);
  } while (Date.now() < deadline);
  if (lockResult.status !== "acquired") throw new Error("host identity ledger lock unavailable");
  try {
    let boots: HostIdentityBoot[];
    let read: HostIdentityBoot[] | undefined;
    let lastReadError: unknown;
    // A stat-race read failure (something touching ~/.rbox mid-read) is commonly
    // transient — retry a few times before giving up rather than quarantining a
    // file we simply couldn't read this instant. A persistent failure throws and
    // the non-fatal wrapper above degrades to no history.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        read = await readHostIdentityLedger(filePath);
        lastReadError = undefined;
        break;
      } catch (error) {
        lastReadError = error;
        if (attempt < 2) await sleep(15);
      }
    }
    if (lastReadError) throw new Error("host identity ledger unreadable");
    if (read === undefined) {
      const corrupt = `${filePath}.corrupt`;
      await fs.rm(corrupt, { force: true }).catch(() => {});
      try {
        await fs.rename(filePath, corrupt);
        await fsyncDirectory(path.dirname(filePath));
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      boots = [];
    } else {
      boots = read;
    }
    const merged = mergeHostIdentityBoots(boots, {
      kernUuid: current.hostId,
      bootSessionUuid: current.bootId,
      platformUuid: current.platformUuid,
      seenAt,
    });
    if (JSON.stringify(merged) !== JSON.stringify(boots)) await writeLedger(filePath, merged);
    cachedKnownBoots = merged;
    return { ...current, knownBoots: merged };
  } finally {
    const released = await lockResult.lock.release();
    if (!released.released) throw new Error("host identity ledger lock release failed");
  }
}

export function formatLockMarker(marker: LockMarker): string {
  if (!ID_RE.test(marker.hostId) || !ID_RE.test(marker.bootId) || !Number.isSafeInteger(marker.pid) || marker.pid <= 0 || !START_RE.test(marker.startTime) || !TOKEN_RE.test(marker.token)) {
    throw new Error("invalid rbox-93 lock marker");
  }
  return `${MARKER_PREFIX} ${marker.hostId} ${marker.bootId} ${marker.pid} ${marker.startTime} ${marker.token}\n`;
}

export function parseLockMarker(raw: string): LockMarker | undefined {
  const match = /^rbox-93 ([0-9a-f-]+) ([0-9a-f-]+) ([1-9]\d*) (\d+(?:\.\d+)?) ([0-9a-f]{32})\n?$/.exec(raw);
  if (!match) return undefined;
  const pid = Number(match[3]);
  if (!Number.isSafeInteger(pid)) return undefined;
  return { hostId: match[1]!, bootId: match[2]!, pid, startTime: match[4]!, token: match[5]! };
}

function statToken(stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; birthtimeNs: bigint }): Omit<MarkerObservation, "raw"> {
  return { dev: stat.dev, inode: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, birthtimeNs: stat.birthtimeNs };
}

export function serializeMarkerObservation(observation: MarkerObservation): SerializedMarkerObservation {
  return {
    dev: observation.dev.toString(),
    inode: observation.inode.toString(),
    size: observation.size.toString(),
    mtimeNs: observation.mtimeNs.toString(),
    birthtimeNs: observation.birthtimeNs.toString(),
    raw: observation.raw,
  };
}

const UNSIGNED_INTEGER = /^(?:0|[1-9]\d*)$/;
const SIGNED_INTEGER = /^(?:0|-?[1-9]\d*)$/;

/** Parse journal authority without accepting numbers (which lose inode
 * precision), noncanonical decimals, oversized prefixes, or inconsistent
 * sizes. Files larger than MARKER_MAX_BYTES carry the exact stat tuple plus
 * the bounded prefix returned by the no-follow reader. */
export function deserializeMarkerObservation(value: unknown): MarkerObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const observation = value as Partial<SerializedMarkerObservation>;
  // birthtimeNs is tolerated as absent so an observation persisted by an older
  // journal within the same release (or the vendored v1.7.24 path) still parses.
  const keys = Object.keys(observation).sort().join(",");
  if ((keys !== "dev,inode,mtimeNs,raw,size" && keys !== "birthtimeNs,dev,inode,mtimeNs,raw,size")
    || typeof observation.dev !== "string" || !UNSIGNED_INTEGER.test(observation.dev)
    || typeof observation.inode !== "string" || !UNSIGNED_INTEGER.test(observation.inode)
    || typeof observation.size !== "string" || !UNSIGNED_INTEGER.test(observation.size)
    || typeof observation.mtimeNs !== "string" || !SIGNED_INTEGER.test(observation.mtimeNs)
    || (observation.birthtimeNs !== undefined && (typeof observation.birthtimeNs !== "string" || !UNSIGNED_INTEGER.test(observation.birthtimeNs)))
    || typeof observation.raw !== "string" || observation.raw.length > MARKER_MAX_BYTES) return undefined;
  const parsed: MarkerObservation = {
    dev: BigInt(observation.dev),
    inode: BigInt(observation.inode),
    size: BigInt(observation.size),
    mtimeNs: BigInt(observation.mtimeNs),
    birthtimeNs: observation.birthtimeNs === undefined ? 0n : BigInt(observation.birthtimeNs),
    raw: observation.raw,
  };
  const prefixBytes = BigInt(parsed.raw.length);
  if (parsed.size < prefixBytes) return undefined;
  if (parsed.size <= BigInt(MARKER_MAX_BYTES)) return parsed.size === prefixBytes ? parsed : undefined;
  return prefixBytes === BigInt(MARKER_MAX_BYTES) ? parsed : undefined;
}

function sameStat(a: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }, b: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

async function readMarkerNoFollow(lockPath: string): Promise<MarkerRead | undefined> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(lockPath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  const token = statToken(before);
  if (before.isSymbolicLink()) return { ...token, raw: "", reason: "symlink lock" };
  if (!before.isFile()) return { ...token, raw: "", reason: "non-regular lock" };
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) return { ...token, raw: "", reason: "lock changed during inspection" };
    if (opened.size > BigInt(MARKER_MAX_BYTES)) {
      const bounded = Buffer.alloc(MARKER_MAX_BYTES);
      const { bytesRead } = await handle.read(bounded, 0, bounded.length, 0);
      const after = await handle.stat({ bigint: true });
      if (!sameStat(opened, after)) return { ...token, raw: "", reason: "lock changed during inspection" };
      return { ...statToken(opened), raw: bounded.subarray(0, bytesRead).toString("latin1"), reason: "oversized lock marker" };
    }
    const bytes = Buffer.alloc(MARKER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat({ bigint: true });
    if (!sameStat(opened, after) || BigInt(bytesRead) !== opened.size) return { ...token, raw: "", reason: "lock changed during inspection" };
    if (bytesRead > MARKER_MAX_BYTES) return { ...token, raw: "", reason: "oversized lock marker" };
    const raw = bytes.subarray(0, bytesRead).toString("latin1");
    const marker = parseLockMarker(raw);
    return { ...statToken(opened), raw, marker, reason: marker ? undefined : "malformed or foreign lock marker" };
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(errno(error) ?? "")) return { ...token, raw: "", reason: "lock changed during inspection" };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** No-follow observation seam for journal-backed Git reservations. Unlike
 * acquireLock(), this primitive never decides that an existing marker is stale
 * and never reaps it: recovery authority belongs to the caller's durable
 * journal. */
export async function observeLockMarker(lockPath: string): Promise<MarkerRead | undefined> {
  return readMarkerNoFollow(lockPath);
}

interface DarwinMountEntry {
  mountpoint: string;
  type: string;
  local: boolean;
}

function balancedParens(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function isPathPrefix(mountpoint: string, storageRealpath: string): boolean {
  return mountpoint === "/"
    ? storageRealpath.startsWith("/")
    : storageRealpath === mountpoint || storageRealpath.startsWith(`${mountpoint}/`);
}

/** Parse `/sbin/mount` output, rejecting malformed records that could own the requested path. */
export function parseDarwinMountOutput(raw: string, storageRealpath: string): Omit<DarwinMountStat, "dev"> | undefined {
  const entries: DarwinMountEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const detailsAt = line.lastIndexOf(" (");
    const separator = " on ";
    const location = detailsAt < 0 ? line : line.slice(0, detailsAt);
    const onAt = location.indexOf(separator);
    if (onAt < 0) continue;
    const mountpoint = location.slice(onAt + separator.length);
    const matchesPath = path.isAbsolute(mountpoint) && isPathPrefix(mountpoint, storageRealpath);
    const sourceValid = location.slice(0, onAt).trim().length > 0;
    const ambiguousOn = location.indexOf(separator, onAt + separator.length) >= 0;
    if (ambiguousOn) {
      for (let candidateAt = onAt; candidateAt >= 0; candidateAt = location.indexOf(separator, candidateAt + separator.length)) {
        const candidate = location.slice(candidateAt + separator.length);
        if (path.isAbsolute(candidate) && isPathPrefix(candidate, storageRealpath)) return undefined;
      }
      continue;
    }
    if (!sourceValid || detailsAt < 0 || !line.endsWith(")") || !path.isAbsolute(mountpoint) || !balancedParens(mountpoint)) {
      if (matchesPath) return undefined;
      continue;
    }
    const fields = line.slice(detailsAt + 2, -1).split(",").map((field) => field.trim());
    const type = fields[0]?.toLowerCase();
    if (!type || fields.some((field) => !field)) {
      if (matchesPath) return undefined;
      continue;
    }
    entries.push({ mountpoint, type, local: fields.slice(1).includes("local") });
  }

  const matches = entries
    .filter(({ mountpoint }) => isPathPrefix(mountpoint, storageRealpath))
    .sort((a, b) => b.mountpoint.length - a.mountpoint.length);
  if (!matches[0] || (matches[1] && matches[1].mountpoint.length === matches[0].mountpoint.length)) return undefined;
  return { type: matches[0].type, local: matches[0].local };
}

export async function defaultStorageStat(storagePath: string): Promise<LockStorageStat> {
  if (process.platform === "linux") {
    const stat = await fs.stat(storagePath, { bigint: true });
    const value = await fs.statfs(storagePath, { bigint: true });
    return { dev: stat.dev, type: value.type };
  }
  if (process.platform === "darwin") {
    const storageRealpath = await fs.realpath(storagePath);
    const stat = await fs.stat(storageRealpath, { bigint: true });
    const mount = parseDarwinMountOutput((await execBytes("/sbin/mount", [])).toString("utf8"), storageRealpath);
    if (!mount) throw new Error("storage mount unavailable");
    return { dev: stat.dev, ...mount };
  }
  throw new Error("unsupported filesystem platform");
}

export async function lockStorageLocal(
  storagePath: string,
  adapter: (storagePath: string) => Promise<LockStorageStat> = defaultStorageStat,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    const stat = await adapter(storagePath);
    const type = typeof stat.type === "string" ? stat.type.toLowerCase() : stat.type;
    const key = `${platform}:${stat.dev}:${String(type)}:${String(stat.local)}`;
    if (localStorageCache.get(key)) return true;
    const local = platform === "darwin"
      ? stat.local === true && typeof type === "string" && DARWIN_LOCAL_FS.has(type)
      : platform === "linux" && typeof type === "bigint" && LINUX_LOCAL_FS.has(type);
    if (local) localStorageCache.set(key, true);
    return local;
  } catch {
    return false;
  }
}

function observationOf(inspection: Exclude<LockInspection, { kind: "absent" }>): MarkerObservation | undefined {
  return inspection.observation;
}

async function classifyProbe(read: MarkerRead, identity: LockIdentitySource, identityDrift: boolean): Promise<LockInspection> {
  const marker = read.marker!;
  const probe = await identity.probe(marker.pid);
  if (probe.status === "unknown") return { kind: "foreign", raw: read.raw, reason: "process liveness unavailable", observation: read };
  if (probe.status === "dead") return { kind: "dead", marker, raw: read.raw, observation: read };
  const start = compareProcessStart(marker.startTime, probe.startTime);
  if (start === "incomparable") return { kind: "foreign", raw: read.raw, reason: "process start clock unavailable", observation: read };
  if (start === "different") return { kind: "dead", marker, raw: read.raw, observation: read };
  return { kind: "live", marker, raw: read.raw, identityDrift: identityDrift || undefined, observation: read };
}

export async function inspectLock(
  lockPath: string,
  identity: LockIdentitySource = systemLockIdentity,
  storageLocal: (storagePath: string) => Promise<boolean> = lockStorageLocal,
): Promise<LockInspection> {
  let read: MarkerRead | undefined;
  try {
    read = await readMarkerNoFollow(lockPath);
  } catch {
    return { kind: "foreign", reason: "marker inspection failed" };
  }
  if (!read) return { kind: "absent" };
  if (!read.marker) return { kind: "foreign", raw: read.raw || undefined, reason: read.reason ?? "foreign lock", observation: read };

  let current: ProcessIncarnation | ResolvedLockIdentity;
  try {
    current = await identity.current();
  } catch {
    return { kind: "foreign", raw: read.raw, reason: "local incarnation unavailable", observation: read };
  }
  const marker = read.marker;
  const known = (current as ResolvedLockIdentity).knownBoots?.find((boot) => boot.kernUuid === marker.hostId && boot.bootSessionUuid === marker.bootId);
  if (known && marker.bootId !== current.bootId) return { kind: "dead", marker, raw: read.raw, observation: read };
  if ((known && marker.bootId === current.bootId) || (marker.hostId === current.hostId && marker.bootId === current.bootId)) {
    return classifyProbe(read, identity, false);
  }
  if (marker.hostId === current.hostId && marker.bootId !== current.bootId) {
    // Linux and legacy stable-host identities retain the prior-boot shortcut.
    return { kind: "dead", marker, raw: read.raw, observation: read };
  }
  if (await storageLocal(path.dirname(lockPath))) return classifyProbe(read, identity, true);
  return { kind: "foreign", raw: read.raw, reason: "cross-host lock", observation: read };
}

async function atomicCreateMarker(lockPath: string, raw: string, hooks?: LockfileHooks, markerMode = 0o600): Promise<AtomicCreateResult> {
  const dir = path.dirname(lockPath);
  const tempPath = path.join(dir, `.${path.basename(lockPath)}.${process.pid}.${crypto.randomBytes(16).toString("hex")}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, markerMode);
    await handle.writeFile(raw);
    await handle.chmod(markerMode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks?.afterTempFsync?.(tempPath, raw);
    try {
      await hooks?.beforeLink?.(lockPath, raw);
      await (hooks?.link ?? fs.link)(tempPath, lockPath);
      return { status: "created" };
    } catch (error) {
      if (errno(error) === "EEXIST") return { status: "exists" };
      if (isLinkUnsupported(error)) return { status: "unsupported", error };
      return { status: "error", error };
    }
  } catch (error) {
    return { status: "error", error };
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
  }
}

/** Publish one caller-generated marker with the same durable hardlink/O_EXCL
 * protocol as acquireLock(), but without its dead-owner auto-reap policy. */
export async function publishLockMarker(
  lockPath: string,
  raw: string,
  hooks?: LockfileHooks,
): Promise<MarkerPublishResult> {
  if (!parseLockMarker(raw)) return { status: "error", error: new Error("invalid rbox lock marker") };
  const created = await atomicCreateMarker(lockPath, raw, hooks);
  if (created.status === "exists") return { status: "exists" };
  if (created.status !== "created") return { status: "error", error: created.error ?? new Error("lock marker publication failed") };
  const finalized = await finalizeCreated(lockPath, raw, hooks);
  if (!finalized.ok) return { status: "error", error: finalized.error ?? new Error("created lock verification failed") };
  return { status: "created", observation: finalized.observation };
}

/** Birth time distinguishes a same-bytes successor that reused a freed inode.
 * Residual: a filesystem that reports no creation time yields 0, so when either
 * side lacks one we fall back to dev/ino/size/mtime/bytes identity. */
export function birthtimeMatches(actual: bigint, expected: bigint): boolean {
  return actual === 0n || expected === 0n || actual === expected;
}

export function sameMarkerObservation(actual: MarkerObservation, expected: MarkerObservation): boolean {
  return actual.raw === expected.raw && actual.dev === expected.dev && actual.inode === expected.inode
    && actual.size === expected.size && actual.mtimeNs === expected.mtimeNs
    && birthtimeMatches(actual.birthtimeNs, expected.birthtimeNs);
}

async function unlinkIfExact(lockPath: string, expected: string | MarkerObservation, hook?: () => void | Promise<void>): Promise<boolean> {
  const before = await readMarkerNoFollow(lockPath);
  if (!before || (typeof expected === "string" ? before.raw !== expected : !sameMarkerObservation(before, expected))) return false;
  await hook?.();
  const after = await readMarkerNoFollow(lockPath);
  if (!after || (typeof expected === "string" ? after.raw !== expected : !sameMarkerObservation(after, expected))) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

/** Exact observation-based release for journal-backed Git reservations. The
 * inode/marker/size/mtime tuple is re-read twice and the containing directory is
 * fsynced after unlink. A successor or symlink replacement is preserved. */
export async function releaseObservedLock(
  lockPath: string,
  expected: MarkerObservation,
  hook?: () => void | Promise<void>,
): Promise<LockReleaseResult> {
  try {
    const released = await unlinkIfExact(lockPath, expected, hook);
    if (!released) return { released: false, durable: false };
    const durable = await fsyncDirectory(path.dirname(lockPath)).then(() => true, () => false);
    return { released: true, durable };
  } catch (error) {
    return { released: false, durable: false, error };
  }
}

function heldResult(blocker: ReapBlocker): Extract<LockAcquireResult, { status: "held" }> {
  const observation = observationOf(blocker.inspection);
  const raw = blocker.inspection.raw ?? "";
  const holderKey = crypto.createHash("sha256")
    .update(blocker.kind).update("\0").update(raw).update("\0")
    .update(observation ? `${observation.dev}:${observation.inode}:${observation.mtimeNs}` : "unknown")
    .digest("hex");
  return {
    status: "held",
    inspection: blocker.inspection,
    blockerKind: blocker.kind,
    warningReason: blocker.reason,
    holderKey,
  };
}

function blockerFor(inspection: Exclude<LockInspection, { kind: "absent" }>): ReapBlocker {
  if (inspection.kind === "live") {
    return { inspection, kind: "live", reason: inspection.identityDrift ? "identity-drift" : undefined };
  }
  return { inspection, kind: "foreign", reason: "foreign" };
}

async function finalizeCreated(lockPath: string, raw: string, hooks?: LockfileHooks): Promise<{ ok: true; observation: MarkerObservation } | { ok: false; cleaned: boolean; error?: unknown }> {
  let created: MarkerRead | undefined;
  try {
    created = await readMarkerNoFollow(lockPath);
  } catch (error) {
    return { ok: false, cleaned: false, error };
  }
  if (!created || created.raw !== raw) {
    return { ok: false, cleaned: false, error: new Error("created lock changed before finalization") };
  }
  let failure: unknown;
  try {
    await fsyncDirectory(path.dirname(lockPath));
    await hooks?.afterCreate?.(lockPath, raw);
    const verified = await readMarkerNoFollow(lockPath);
    if (verified && sameMarkerObservation(verified, created)) return { ok: true, observation: created };
    failure = new Error("created lock verification failed");
  } catch (error) {
    failure = error;
  }
  try {
    const cleaned = await unlinkIfExact(lockPath, created, () => hooks?.beforeCreatedCleanup?.(lockPath));
    if (cleaned) await fsyncDirectory(path.dirname(lockPath));
    return { ok: false, cleaned, error: failure };
  } catch (error) {
    return { ok: false, cleaned: false, error };
  }
}

async function acquireFence(
  fencePath: string,
  incarnation: ProcessIncarnation,
  identity: LockIdentitySource,
  hooks: LockfileHooks | undefined,
  token: () => string,
  storageLocal: (storagePath: string) => Promise<boolean>,
  markerMode: number,
): Promise<{ status: "acquired"; lock: OwnedLock } | { status: "retry" } | { status: "blocked"; blocker: ReapBlocker }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const marker: LockMarker = { ...incarnation, token: token() };
    const raw = formatLockMarker(marker);
    const created = await atomicCreateMarker(fencePath, raw, hooks, markerMode);
    if (created.status === "created") {
      const finalized = await finalizeCreated(fencePath, raw, hooks);
      if (finalized.ok) return { status: "acquired", lock: new OwnedLock(fencePath, marker, raw, finalized.observation, identity, hooks) };
      if (finalized.cleaned) return { status: "retry" };
      staleOwnedMarkers.set(fencePath, raw);
      const inspection = await inspectLock(fencePath, identity, storageLocal);
      if (inspection.kind === "absent") return { status: "retry" };
      return { status: "blocked", blocker: { inspection, kind: "fence", reason: "fence" } };
    }
    if (created.status !== "exists") {
      const inspection = await inspectLock(fencePath, identity, storageLocal);
      if (inspection.kind === "absent") return { status: "retry" };
      return { status: "blocked", blocker: { inspection, kind: "fence", reason: "fence" } };
    }
    const existing = await inspectLock(fencePath, identity, storageLocal);
    if (existing.kind === "absent") continue;
    const staleRaw = staleOwnedMarkers.get(fencePath);
    if (staleRaw !== undefined && (existing.kind === "live" || existing.kind === "foreign") && staleRaw === existing.raw) {
      try {
        if (await unlinkIfExact(fencePath, staleRaw)) {
          staleOwnedMarkers.delete(fencePath);
          continue;
        }
      } catch {
        // Keep the exact candidate for a later acquire.
      }
      return { status: "blocked", blocker: { inspection: existing, kind: "fence", reason: "fence" } };
    }
    if (existing.kind !== "dead" || !existing.observation) {
      return { status: "blocked", blocker: { inspection: existing, kind: "fence", reason: "fence" } };
    }
    try {
      if (await unlinkIfExact(fencePath, existing.observation)) continue;
    } catch {
      // Re-observe below.
    }
    return { status: "retry" };
  }
  return { status: "retry" };
}

async function tryReap(
  lockPath: string,
  expected: Exclude<LockInspection, { kind: "absent" }>,
  identity: LockIdentitySource,
  hooks: LockfileHooks | undefined,
  token: () => string,
  allowLive: boolean,
  storageLocal: (storagePath: string) => Promise<boolean>,
  markerMode: number,
): Promise<ReapResult> {
  const incarnation = await identity.current();
  const fence = await acquireFence(`${lockPath}.reap`, incarnation, identity, hooks, token, storageLocal, markerMode);
  if (fence.status === "blocked") return fence;
  if (fence.status === "retry") return { status: "retry" };
  let result: ReapResult = { status: "retry" };
  try {
    await hooks?.beforeReapInspect?.(lockPath);
    const again = await inspectLock(lockPath, identity, storageLocal);
    const eligible = again.kind === "dead" || (allowLive && again.kind !== "absent" && again.raw === expected.raw);
    const capability = allowLive ? expected.raw : expected.observation;
    if (!eligible || !capability) result = { status: "retry" };
    else if (await unlinkIfExact(lockPath, capability, () => hooks?.beforeReapUnlink?.(lockPath))) result = { status: "reaped" };
  } catch {
    result = { status: "retry" };
  } finally {
    const released = await fence.lock.release();
    if (!released.released) {
      staleOwnedMarkers.set(fence.lock.path, fence.lock.raw);
      const inspection = await inspectLock(fence.lock.path, identity, storageLocal);
      if (inspection.kind !== "absent") result = { status: "blocked", blocker: { inspection, kind: "fence", reason: "fence" } };
    }
  }
  return result;
}

export class OwnedLock {
  constructor(
    readonly path: string,
    readonly marker: LockMarker,
    readonly raw: string,
    private readonly observation: MarkerObservation,
    private readonly identity: LockIdentitySource,
    private readonly hooks?: LockfileHooks,
  ) {}

  async isOwner(): Promise<boolean> {
    try {
      const current = await readMarkerNoFollow(this.path);
      return current !== undefined && sameMarkerObservation(current, this.observation);
    } catch {
      return false;
    }
  }

  async recheckOwner(hook?: () => void | Promise<void>): Promise<boolean> {
    await hook?.();
    return this.isOwner();
  }

  async release(): Promise<LockReleaseResult> {
    try {
      const released = await unlinkIfExact(this.path, this.observation, () => this.hooks?.beforeReleaseUnlink?.(this.path));
      if (!released) {
        const read = await readMarkerNoFollow(this.path).catch(() => undefined);
        if (read?.raw === this.raw) staleOwnedMarkers.set(this.path, this.raw);
        return { released: false, durable: false };
      }
      staleOwnedMarkers.delete(this.path);
      const durable = await fsyncDirectory(path.dirname(this.path)).then(() => true, () => false);
      return { released: true, durable };
    } catch (error) {
      staleOwnedMarkers.set(this.path, this.raw);
      return { released: false, durable: false, error };
    }
  }
}

export async function acquireLock(lockPath: string, options: AcquireLockOptions = {}): Promise<LockAcquireResult> {
  const identity = options.identity ?? systemLockIdentity;
  const token = options.token ?? (() => crypto.randomBytes(16).toString("hex"));
  const storageLocal = options.storageLocal ?? lockStorageLocal;
  let incarnation: ProcessIncarnation | ResolvedLockIdentity;
  try {
    incarnation = identity === systemLockIdentity && !options.skipIdentityRefresh
      ? await refreshSystemLockIdentityLedger()
      : await identity.current();
  } catch (error) {
    return { status: "unsupported", error };
  }
  const marker: LockMarker = { hostId: incarnation.hostId, bootId: incarnation.bootId, pid: incarnation.pid, startTime: incarnation.startTime, token: token() };
  let raw: string;
  try {
    raw = formatLockMarker(marker);
  } catch (error) {
    return { status: "unsupported", error };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await atomicCreateMarker(lockPath, raw, options.hooks, options.markerMode);
    if (created.status === "created") {
      const finalized = await finalizeCreated(lockPath, raw, options.hooks);
      if (finalized.ok) return { status: "acquired", lock: new OwnedLock(lockPath, marker, raw, finalized.observation, identity, options.hooks) };
      if (finalized.cleaned) return { status: "error", error: finalized.error ?? new Error("created lock verification failed") };
      staleOwnedMarkers.set(lockPath, raw);
    } else if (created.status === "unsupported") return { status: "unsupported", error: created.error };
    else if (created.status === "error") return { status: "error", error: created.error };

    const inspection = await inspectLock(lockPath, identity, storageLocal);
    if (inspection.kind === "absent") continue;
    const staleRaw = staleOwnedMarkers.get(lockPath);
    const staleOwned = staleRaw !== undefined && inspection.raw === staleRaw;
    if (inspection.kind === "dead" || staleOwned) {
      const reap = await tryReap(lockPath, inspection, identity, options.hooks, token, staleOwned, storageLocal, options.markerMode ?? 0o600);
      if (reap.status === "reaped" || reap.status === "retry") {
        if (reap.status === "reaped") staleOwnedMarkers.delete(lockPath);
        continue;
      }
      return heldResult(reap.blocker);
    }
    return heldResult(staleOwned
      ? { inspection, kind: "stale-owned", reason: "stale-owned" }
      : blockerFor(inspection));
  }
  const inspection = await inspectLock(lockPath, identity, storageLocal);
  return inspection.kind === "absent"
    ? { status: "error", error: new Error("lock acquisition race did not settle") }
    : heldResult(staleOwnedMarkers.get(lockPath) === inspection.raw
      ? { inspection, kind: "stale-owned", reason: "stale-owned" }
      : blockerFor(inspection));
}
