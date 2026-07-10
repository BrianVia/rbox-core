import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsyncDirectory } from "../fsutil.js";

const MARKER_PREFIX = "rbox-93";
const MARKER_MAX_BYTES = 1024;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[0-9a-f-]+$/;
const START_RE = /^\d+(?:\.\d+)?$/;

export interface ProcessIncarnation {
  hostId: string;
  bootId: string;
  pid: number;
  startTime: string;
}

export interface LockMarker extends ProcessIncarnation {
  token: string;
}

export type ProcessProbe =
  | { status: "alive"; startTime: string }
  | { status: "dead" }
  | { status: "unknown"; error?: unknown };

export interface LockIdentitySource {
  current(): Promise<ProcessIncarnation>;
  probe(pid: number): Promise<ProcessProbe>;
}

export interface LockfileHooks {
  link?: (existingPath: string, newPath: string) => Promise<void>;
  afterTempFsync?: (tempPath: string, marker: string) => void | Promise<void>;
  beforeReapInspect?: (lockPath: string) => void | Promise<void>;
  beforeReapUnlink?: (lockPath: string) => void | Promise<void>;
  beforeReleaseUnlink?: (lockPath: string) => void | Promise<void>;
}

export type LockInspection =
  | { kind: "absent" }
  | { kind: "live"; marker: LockMarker; raw: string }
  | { kind: "dead"; marker: LockMarker; raw: string }
  | { kind: "foreign"; raw?: string; reason: string };

export type LockAcquireResult =
  | { status: "acquired"; lock: OwnedLock }
  | { status: "held"; inspection: Exclude<LockInspection, { kind: "absent" }> }
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
}

interface MarkerRead {
  raw: string;
  marker?: LockMarker;
  reason?: string;
}

interface AtomicCreateResult {
  status: "created" | "exists" | "unsupported" | "error";
  error?: unknown;
}

const staleOwnedMarkers = new Map<string, string>();
const darwinFallbackOwnStart = Math.max(1, Math.floor((Date.now() - process.uptime() * 1000) * 1000)).toString();

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isLinkUnsupported(error: unknown): boolean {
  return ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "EMLINK", "ENOSYS"].includes(errno(error) ?? "");
}

async function execBytes(command: string, args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(command, args, { encoding: "buffer", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout));
    });
  });
}

async function sysctlString(name: string): Promise<string> {
  return (await execBytes("/usr/sbin/sysctl", ["-n", name])).toString("utf8").trim().toLowerCase();
}

async function darwinProcessStart(pid: number): Promise<string> {
  // kern.proc.pid returns struct kinfo_proc. On supported 64-bit macOS targets,
  // kp_proc.p_starttime is the first member (timeval: seconds, microseconds).
  let bytes: Buffer;
  try {
    bytes = await execBytes("/usr/sbin/sysctl", ["-b", `kern.proc.pid.${pid}`]);
  } catch (error) {
    // Some macOS application sandboxes deny kern.proc sysctl. We can still own
    // locks safely in-process; other-pid probes remain unknown/live (fail closed).
    if (pid === process.pid) return darwinFallbackOwnStart;
    throw error;
  }
  if (bytes.length < 16) {
    const error = new Error(`kern.proc.pid.${pid} returned ${bytes.length} bytes`);
    (error as NodeJS.ErrnoException).code = bytes.length === 0 ? "ESRCH" : "EIO";
    throw error;
  }
  const seconds = bytes.readBigInt64LE(0);
  const microseconds = bytes.readBigInt64LE(8);
  if (seconds < 0n || microseconds < 0n || microseconds >= 1_000_000n) throw new Error("invalid kern.proc.pid start time");
  return `${seconds}.${microseconds.toString().padStart(6, "0")}`;
}

function parseLinuxProcStart(raw: string): string {
  // The comm field is parenthesized and may itself contain spaces or ')'. Field
  // 22 is therefore the 20th field after the final ')' (field 3 starts there).
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

/** Resolve the Linux host identity in design-93 order. Hostnames are hashed into
 * the marker's hex grammar; this preserves their (weak) equality semantics without
 * allowing punctuation or whitespace to make an otherwise usable source invalid. */
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
    // The caller maps total identity-source failure to the legacy lock bucket.
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
    // Darwin's sysctl CLI does not preserve errno. kill(pid, 0) is used only to
    // recognize the design's ESRCH death case; any other probe failure is live.
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

async function currentSystemIncarnation(): Promise<ProcessIncarnation> {
  let hostId: string;
  let bootId: string;
  if (process.platform === "darwin") {
    try {
      [hostId, bootId] = await Promise.all([sysctlString("kern.uuid"), sysctlString("kern.bootsessionuuid")]);
    } catch {
      // `ioreg` exposes the same stable machine/boot identities when sysctl is
      // denied by an app sandbox. This is an identity-source fallback only; all
      // marker, no-follow, reaper, and owner checks remain in this primitive.
      const [platform, chosen] = await Promise.all([
        execBytes("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).then((v) => v.toString("utf8")),
        execBytes("/usr/sbin/ioreg", ["-p", "IODeviceTree", "-n", "chosen", "-r", "-d1"]).then((v) => v.toString("utf8")),
      ]);
      const host = /"IOPlatformUUID"\s*=\s*"([0-9A-F-]+)"/i.exec(platform)?.[1];
      const boot = /"boot-uuid"\s*=\s*<"([0-9A-F-]+)">/i.exec(chosen)?.[1];
      if (!host || !boot) throw new Error("ioreg did not expose host/boot UUIDs");
      hostId = host.toLowerCase();
      bootId = boot.toLowerCase();
    }
  } else if (process.platform === "linux") {
    [hostId, bootId] = await Promise.all([
      resolveLinuxHostId(),
      fs.readFile("/proc/sys/kernel/random/boot_id", "utf8").then((v) => v.trim().toLowerCase()),
    ]);
  } else {
    throw new Error(`unsupported lock identity platform: ${process.platform}`);
  }
  if (!ID_RE.test(hostId) || !ID_RE.test(bootId)) throw new Error("invalid host or boot identity source");
  return { hostId, bootId, pid: process.pid, startTime: await processStart(process.pid) };
}

export const systemLockIdentity: LockIdentitySource = {
  current: (() => {
    let cached: Promise<ProcessIncarnation> | undefined;
    return () => (cached ??= currentSystemIncarnation());
  })(),
  probe: probeProcess,
};

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

async function readMarkerNoFollow(lockPath: string): Promise<MarkerRead | undefined> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(lockPath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  if (before.isSymbolicLink()) return { raw: "", reason: "symlink lock" };
  if (!before.isFile()) return { raw: "", reason: "non-regular lock" };
  if (before.size > BigInt(MARKER_MAX_BYTES)) return { raw: "", reason: "oversized lock marker" };

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return { raw: "", reason: "lock changed during inspection" };
    const bytes = Buffer.alloc(MARKER_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MARKER_MAX_BYTES) return { raw: "", reason: "oversized lock marker" };
    const raw = bytes.subarray(0, bytesRead).toString("utf8");
    const marker = parseLockMarker(raw);
    return { raw, marker, reason: marker ? undefined : "malformed or foreign lock marker" };
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes(errno(error) ?? "")) return { raw: "", reason: "lock changed during inspection" };
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function inspectLock(lockPath: string, identity: LockIdentitySource = systemLockIdentity): Promise<LockInspection> {
  let read: MarkerRead | undefined;
  try {
    read = await readMarkerNoFollow(lockPath);
  } catch (error) {
    return { kind: "foreign", reason: `marker inspection failed: ${errno(error) ?? "unknown"}` };
  }
  if (!read) return { kind: "absent" };
  if (!read.marker) return { kind: "foreign", raw: read.raw || undefined, reason: read.reason ?? "foreign lock" };

  let current: ProcessIncarnation;
  try {
    current = await identity.current();
  } catch {
    return { kind: "foreign", raw: read.raw, reason: "local incarnation unavailable" };
  }
  const marker = read.marker;
  if (marker.hostId !== current.hostId) return { kind: "foreign", raw: read.raw, reason: "cross-host lock" };
  if (marker.bootId !== current.bootId) return { kind: "dead", marker, raw: read.raw };
  const probe = await identity.probe(marker.pid);
  if (probe.status === "unknown") return { kind: "live", marker, raw: read.raw };
  if (probe.status === "dead" || probe.startTime !== marker.startTime) return { kind: "dead", marker, raw: read.raw };
  return { kind: "live", marker, raw: read.raw };
}

async function atomicCreateMarker(lockPath: string, raw: string, hooks?: LockfileHooks): Promise<AtomicCreateResult> {
  const dir = path.dirname(lockPath);
  const tempPath = path.join(dir, `.${path.basename(lockPath)}.${process.pid}.${crypto.randomBytes(16).toString("hex")}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks?.afterTempFsync?.(tempPath, raw);
    try {
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

async function unlinkIfExact(lockPath: string, expectedRaw: string, hook?: () => void | Promise<void>): Promise<boolean> {
  const before = await readMarkerNoFollow(lockPath).catch(() => undefined);
  if (!before || before.raw !== expectedRaw) return false;
  await hook?.();
  const after = await readMarkerNoFollow(lockPath).catch(() => undefined);
  if (!after || after.raw !== expectedRaw) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
}

async function acquireFence(fencePath: string, incarnation: ProcessIncarnation, identity: LockIdentitySource, hooks: LockfileHooks | undefined, token: () => string): Promise<OwnedLock | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const marker: LockMarker = { ...incarnation, token: token() };
    const raw = formatLockMarker(marker);
    const created = await atomicCreateMarker(fencePath, raw, hooks);
    if (created.status === "created") return new OwnedLock(fencePath, marker, raw, identity, hooks);
    if (created.status !== "exists") return undefined;
    const existing = await inspectLock(fencePath, identity);
    if (existing.kind !== "dead") return undefined;
    // A reaper fence is the one deliberate single-level exception: a dead
    // <lock>.reap is exact-checked and unlinked directly, never recursively.
    if (!(await unlinkIfExact(fencePath, existing.raw))) return undefined;
  }
  return undefined;
}

async function tryReap(lockPath: string, expected: LockInspection & { kind: "dead" } | { kind: "live"; marker: LockMarker; raw: string }, identity: LockIdentitySource, hooks: LockfileHooks | undefined, token: () => string, allowLive: boolean): Promise<boolean> {
  const incarnation = await identity.current();
  const fence = await acquireFence(`${lockPath}.reap`, incarnation, identity, hooks, token);
  if (!fence) return false;
  try {
    await hooks?.beforeReapInspect?.(lockPath);
    const again = await inspectLock(lockPath, identity);
    const eligible = again.kind === "dead" || (allowLive && again.kind === "live");
    if (!eligible || again.raw !== expected.raw) return false;
    return await unlinkIfExact(lockPath, expected.raw, () => hooks?.beforeReapUnlink?.(lockPath));
  } finally {
    await fence.release();
  }
}

export class OwnedLock {
  constructor(
    readonly path: string,
    readonly marker: LockMarker,
    readonly raw: string,
    private readonly identity: LockIdentitySource,
    private readonly hooks?: LockfileHooks,
  ) {}

  async isOwner(): Promise<boolean> {
    const current = await readMarkerNoFollow(this.path).catch(() => undefined);
    return current?.raw === this.raw;
  }

  async recheckOwner(hook?: () => void | Promise<void>): Promise<boolean> {
    await hook?.();
    return this.isOwner();
  }

  async release(): Promise<LockReleaseResult> {
    try {
      const released = await unlinkIfExact(this.path, this.raw, () => this.hooks?.beforeReleaseUnlink?.(this.path));
      if (!released) return { released: false, durable: false };
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
  let incarnation: ProcessIncarnation;
  try {
    incarnation = await identity.current();
  } catch (error) {
    return { status: "unsupported", error };
  }
  const marker: LockMarker = { ...incarnation, token: token() };
  let raw: string;
  try {
    raw = formatLockMarker(marker);
  } catch (error) {
    return { status: "unsupported", error };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const created = await atomicCreateMarker(lockPath, raw, options.hooks);
    if (created.status === "created") return { status: "acquired", lock: new OwnedLock(lockPath, marker, raw, identity, options.hooks) };
    if (created.status === "unsupported") return { status: "unsupported", error: created.error };
    if (created.status === "error") return { status: "error", error: created.error };

    const inspection = await inspectLock(lockPath, identity);
    if (inspection.kind === "absent") continue;
    const staleRaw = staleOwnedMarkers.get(lockPath);
    if (inspection.kind === "dead" || (inspection.kind === "live" && staleRaw === inspection.raw)) {
      const reaped = await tryReap(lockPath, inspection, identity, options.hooks, token, inspection.kind === "live");
      if (reaped) {
        staleOwnedMarkers.delete(lockPath);
        continue;
      }
    }
    return { status: "held", inspection };
  }
  const inspection = await inspectLock(lockPath, identity);
  return inspection.kind === "absent"
    ? { status: "error", error: new Error("lock acquisition race did not settle") }
    : { status: "held", inspection };
}
