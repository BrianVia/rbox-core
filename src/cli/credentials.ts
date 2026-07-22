import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { systemLockIdentity } from "../engine/git/lockfile.js";
import { homeDir } from "./rbox-paths.js";
import { GENESIS_ACCOUNT_ID_RE, invalidateGenesisEnrollmentWitness } from "./genesis-durable.js";

/** The whitelisted, versioned credential document written to disk. */
export interface CredentialsV1 {
  v: 1;
  token: string;
  deviceId: string;
  remoteUrl: string;
  /** Trusted only after cross-checking the signed account roster. */
  accountId?: string;
}

/** Input accepted by save callers; save always adds the v1 discriminator. */
export type Credentials = Omit<CredentialsV1, "v"> & { v?: 1 };

export type CredentialLoadResult =
  | { state: "absent"; path: string }
  | {
      state: "valid";
      source: "disk" | "env";
      credentials: CredentialsV1;
      legacy: boolean;
      extensions: Record<string, unknown>;
    }
  | { state: "corrupt"; path: string; detail: string; quarantinedTo?: string }
  | { state: "unreadable"; path: string; detail: string }
  | { state: "unsupported-version"; path: string; version: unknown; quarantinedTo?: string }
  | {
      state: "invalid-environment";
      variable: "RBOX_DEVICE_ID" | "RBOX_API" | "RBOX_ACCOUNT_ID";
      detail: string;
    };

type DegradedCredentialResult = Exclude<CredentialLoadResult, { state: "absent" | "valid" }>;
type ParsedCredential =
  | { state: "valid"; credentials: CredentialsV1; legacy: boolean; extensions: Record<string, unknown> }
  | { state: "corrupt"; detail: string }
  | { state: "unsupported-version"; version: unknown };

interface MarkerV1 {
  v: 1;
  pid: number;
  processStart: string;
  acquiredAt: string;
  nonce: string;
}

interface PathObservation {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
}

interface MarkerObservation extends PathObservation {
  raw: string;
  marker: MarkerV1;
  mtimeMs: number;
}

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_RETRY_MS = 25;
const LOCK_RETRIES = 80;
const HEARTBEAT_MS = 25_000;
const OPTIMISTIC_READ_RETRIES = 3;
let heartbeatIntervalMs = HEARTBEAT_MS;
const MARKER_MAX_BYTES = 1024;
const NONCE_RE = /^[0-9a-f]{32}$/;
const PROCESS_START_RE = /^\d+(?:\.\d+)?$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type CredentialTestSeam =
  | "lock-before-acquire" | "lock-contended" | "load-before-mutation-lock"
  | "marker-temp-opened" | "marker-temp-written" | "marker-temp-synced" | "marker-temp-closed"
  | "marker-before-link" | "marker-after-link" | "marker-before-temp-cleanup" | "marker-after-temp-cleanup"
  | "source-after-lstat" | "source-after-open" | "source-after-fstat" | "source-after-read"
  | "quarantine-copy-durable" | "quarantine-before-source-remove"
  | `atomic-${"temp-opened" | "temp-written" | "temp-synced" | "temp-closed" | "before-rename" | "after-rename"}`
  | "save-before-parent-recheck" | "save-before-directory-sync"
  | "logout-override-before-delete" | "logout-override-after-delete";
type CredentialTestHook = (seam: CredentialTestSeam, context: Readonly<Record<string, string>>) => void | Promise<void>;
let credentialTestHook: CredentialTestHook | undefined;

/** @internal Installs a process-local fault hook; production callers never set it. */
export function installCredentialTestHook(hook: CredentialTestHook | undefined): () => void {
  const previous = credentialTestHook;
  credentialTestHook = hook;
  return () => { credentialTestHook = previous; };
}

/** @internal Shortens the heartbeat only for deterministic in-process tests. */
export function installCredentialTestHeartbeatInterval(ms: number): () => void {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("credential test heartbeat interval must be positive");
  const previous = heartbeatIntervalMs;
  heartbeatIntervalMs = ms;
  return () => { heartbeatIntervalMs = previous; };
}

async function testSeam(seam: CredentialTestSeam, context: Readonly<Record<string, string>> = {}): Promise<void> {
  await credentialTestHook?.(seam, context);
}

/** Production endpoints are centralized here so env and disk validation agree. */
export const PROD_REMOTE = "https://api.rbox.to";
export const PROD_WEB = "https://app.rbox.to";

const dir = () => path.join(homeDir(), ".rbox");
const file = () => path.join(dir(), "credentials.json");
const lockFile = () => path.join(dir(), "credentials.lock");
const fenceFile = () => path.join(dir(), "credentials.lock.fence");

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function failureClass(error: unknown): string {
  return errno(error) ?? (error instanceof Error && error.name ? error.name : "credential-lock-failure");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validRemote(value: unknown): value is string {
  if (!nonempty(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure parser exported so wire-format compatibility can be tested without I/O. */
export function parseCredentialDocument(raw: string | Uint8Array): ParsedCredential {
  let value: unknown;
  try {
    value = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
  } catch {
    return { state: "corrupt", detail: "credential file is not valid JSON" };
  }
  if (!objectRecord(value)) return { state: "corrupt", detail: "credential file must contain an object" };

  const hasVersion = Object.prototype.hasOwnProperty.call(value, "v");
  if (hasVersion && (!Number.isInteger(value.v) || typeof value.v !== "number")) {
    return { state: "corrupt", detail: "credential version is malformed" };
  }
  if (hasVersion && value.v !== 1) return { state: "unsupported-version", version: value.v };
  if (!nonempty(value.token)) return { state: "corrupt", detail: "credential token is missing or empty" };
  if (!nonempty(value.deviceId)) return { state: "corrupt", detail: "credential deviceId is missing or empty" };
  if (!validRemote(value.remoteUrl)) return { state: "corrupt", detail: "credential remoteUrl must be an absolute HTTP(S) URL" };
  if (value.accountId !== undefined && !nonempty(value.accountId)) {
    return { state: "corrupt", detail: "credential accountId must be nonempty when present" };
  }

  const known = new Set(["v", "token", "deviceId", "remoteUrl", "accountId"]);
  const extensions = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
  return {
    state: "valid",
    credentials: {
      v: 1,
      token: value.token,
      deviceId: value.deviceId,
      remoteUrl: value.remoteUrl,
      ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
    },
    legacy: !hasVersion,
    extensions,
  };
}

function envResult(): CredentialLoadResult | undefined {
  const token = process.env.RBOX_TOKEN;
  if (!token) return undefined;
  const explicit = (name: string): boolean => Object.prototype.hasOwnProperty.call(process.env, name);
  const deviceId = process.env.RBOX_DEVICE_ID ?? "env";
  const remoteUrl = process.env.RBOX_API ?? PROD_REMOTE;
  const accountId = process.env.RBOX_ACCOUNT_ID;
  if (explicit("RBOX_DEVICE_ID") && !nonempty(deviceId)) {
    return { state: "invalid-environment", variable: "RBOX_DEVICE_ID", detail: "RBOX_DEVICE_ID must be nonempty" };
  }
  if (explicit("RBOX_API") && !validRemote(remoteUrl)) {
    return { state: "invalid-environment", variable: "RBOX_API", detail: "RBOX_API must be an absolute HTTP(S) URL" };
  }
  if (explicit("RBOX_ACCOUNT_ID") && !nonempty(accountId)) {
    return { state: "invalid-environment", variable: "RBOX_ACCOUNT_ID", detail: "RBOX_ACCOUNT_ID must be nonempty" };
  }
  return {
    state: "valid",
    source: "env",
    credentials: { v: 1, token, deviceId, remoteUrl, ...(accountId === undefined ? {} : { accountId }) },
    legacy: false,
    extensions: {},
  };
}

function components(abs: string): string[] {
  const resolved = path.resolve(abs);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const out = [parsed.root];
  let current = parsed.root;
  for (const part of relative) {
    current = path.join(current, part);
    out.push(current);
  }
  return out;
}

/** Validate the whole no-symlink chain, but apply owner/mode policy only to ~/.rbox. */
async function secureCredentialDirectory(create: boolean): Promise<PathObservation | undefined> {
  // Authority extends only to the secret leaf. HOME and all system ancestors
  // must already exist as plain directories; never create or chmod them.
  for (const component of components(homeDir())) {
    const stat = await fs.lstat(component);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe credential directory component: ${component}`);
  }
  if (create) {
    const created = await ensureDirectoryChain(dir(), "credential directory");
    if ([...created].some((createdDir) => createdDir !== dir())) throw new Error("refusing to create a credential directory ancestor");
    if (created.has(dir())) await fs.chmod(dir(), 0o700);
    await fsyncCreatedDirectoryAncestors(dir(), created).catch(() => {});
  }
  for (const component of components(dir())) {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(component);
    } catch (error) {
      if (!create && errno(error) === "ENOENT") return undefined;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe credential directory component: ${component}`);
  }
  const parent = await fs.lstat(dir());
  if (typeof process.geteuid !== "function") throw new Error("effective user identity is unavailable for credential directory validation");
  const effectiveUid = process.geteuid();
  if (parent.uid !== effectiveUid) throw new Error(`credential directory is not owned by the effective user: ${dir()}`);
  if ((parent.mode & 0o022) !== 0) throw new Error(`credential directory is group/world writable: ${dir()}`);
  return observation(await fs.lstat(dir(), { bigint: true }));
}

function observation(stat: { dev: bigint; ino: bigint; size: bigint; mode: bigint }): PathObservation {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode };
}

function sameIdentity(a: PathObservation, b: PathObservation, includeSize = true): boolean {
  return a.dev === b.dev && a.ino === b.ino && (!includeSize || a.size === b.size) && (a.mode & 0o170000n) === (b.mode & 0o170000n);
}

function regular(mode: bigint): boolean {
  return (mode & 0o170000n) === 0o100000n;
}

function parseMarker(raw: string): MarkerV1 | undefined {
  if (Buffer.byteLength(raw) > MARKER_MAX_BYTES) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<MarkerV1>;
    if (!objectRecord(value) || value.v !== 1 || !Number.isSafeInteger(value.pid) || (value.pid ?? 0) <= 0) return undefined;
    if (!nonempty(value.processStart) || !PROCESS_START_RE.test(value.processStart) || !nonempty(value.acquiredAt) || !NONCE_RE.test(value.nonce ?? "")) return undefined;
    if (!Number.isFinite(Date.parse(value.acquiredAt))) return undefined;
    const keys = Object.keys(value).sort().join(",");
    if (keys !== "acquiredAt,nonce,pid,processStart,v") return undefined;
    return value as MarkerV1;
  } catch {
    return undefined;
  }
}

async function readMarker(markerPath: string): Promise<MarkerObservation | undefined> {
  let before;
  try {
    before = await fs.lstat(markerPath, { bigint: true });
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  const beforeObs = observation(before);
  if (!regular(beforeObs.mode)) throw new Error(`unsafe credential lock marker: ${markerPath}`);
  const handle = await fs.open(markerPath, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = observation(await handle.stat({ bigint: true }));
    if (!sameIdentity(beforeObs, opened)) throw new Error(`credential lock marker changed during inspection: ${markerPath}`);
    if (opened.size > BigInt(MARKER_MAX_BYTES)) throw new Error(`credential lock marker exceeds ${MARKER_MAX_BYTES} bytes: ${markerPath}`);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== bytes.length) throw new Error(`credential lock marker changed during read: ${markerPath}`);
    const after = observation(await handle.stat({ bigint: true }));
    if (!sameIdentity(opened, after) || BigInt(bytes.byteLength) !== opened.size) throw new Error(`credential lock marker changed during read: ${markerPath}`);
    const raw = bytes.toString("utf8");
    const marker = parseMarker(raw);
    if (!marker) throw new Error(`malformed credential lock marker: ${markerPath}`);
    return { ...opened, raw, marker, mtimeMs: Number(before.mtimeMs) };
  } finally {
    await handle.close();
  }
}

async function markerForCurrentProcess(): Promise<{ marker: MarkerV1; raw: string }> {
  const current = await systemLockIdentity.current();
  const marker: MarkerV1 = {
    v: 1,
    pid: process.pid,
    processStart: current.startTime,
    acquiredAt: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  return { marker, raw: JSON.stringify(marker) };
}

type PublishResult = "created" | "exists";

async function publishMarker(markerPath: string, raw: string): Promise<PublishResult> {
  const tempPath = path.join(path.dirname(markerPath), `.${path.basename(markerPath)}.${process.pid}.${crypto.randomBytes(16).toString("hex")}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    await testSeam("marker-temp-opened", { markerPath, tempPath });
    await handle.writeFile(raw);
    await testSeam("marker-temp-written", { markerPath, tempPath });
    await handle.chmod(0o600);
    await handle.sync();
    await testSeam("marker-temp-synced", { markerPath, tempPath });
    await handle.close();
    handle = undefined;
    await testSeam("marker-temp-closed", { markerPath, tempPath });
    try {
      await testSeam("marker-before-link", { markerPath, tempPath });
      await fs.link(tempPath, markerPath);
      await testSeam("marker-after-link", { markerPath, tempPath });
      await fsyncDirectory(path.dirname(markerPath));
      return "created";
    } catch (error) {
      if (errno(error) === "EEXIST") return "exists";
      throw new Error(`credential lock marker publication failed (${errno(error) ?? "unknown"})`);
    }
  } finally {
    await handle?.close().catch(() => {});
    await testSeam("marker-before-temp-cleanup", { markerPath, tempPath });
    await fs.unlink(tempPath).catch(() => {});
    await testSeam("marker-after-temp-cleanup", { markerPath, tempPath });
  }
}

async function unlinkObserved(target: string, expected: PathObservation, durable = false): Promise<boolean> {
  let current;
  try {
    current = observation(await fs.lstat(target, { bigint: true }));
  } catch (error) {
    if (errno(error) === "ENOENT") return false;
    throw error;
  }
  if (!sameIdentity(current, expected)) return false;
  if ("raw" in expected) {
    const marker = await readMarker(target);
    const expectedMarker = expected as MarkerObservation;
    if (!marker || marker.raw !== expectedMarker.raw || marker.marker.nonce !== expectedMarker.marker.nonce || !sameIdentity(marker, expectedMarker)) return false;
  } else {
    const final = observation(await fs.lstat(target, { bigint: true }));
    if (!sameIdentity(final, expected)) return false;
  }
  await fs.unlink(target);
  if (durable) await fsyncDirectory(path.dirname(target));
  return true;
}

async function acquireFence(): Promise<{ path: string; observation: MarkerObservation }> {
  const markerPath = fenceFile();
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    const created = await markerForCurrentProcess();
    const result = await publishMarker(markerPath, created.raw);
    if (result === "created") {
      const observed = await readMarker(markerPath);
      if (!observed || observed.marker.nonce !== created.marker.nonce) throw new Error("credential fence ownership could not be proved");
      return { path: markerPath, observation: observed };
    }
    const held = await readMarker(markerPath);
    if (!held) continue;
    const now = Date.now();
    if (held.mtimeMs > now || Date.parse(held.marker.acquiredAt) > now) throw new Error(`future-dated credential fence marker: ${markerPath}`);
    const probe = await systemLockIdentity.probe(held.marker.pid);
    const exactDead = probe.status === "dead" || (probe.status === "alive" && probe.startTime !== held.marker.processStart);
    if (exactDead) {
      await unlinkObserved(markerPath, held, true);
      continue;
    }
    if (credentialTestHook) await testSeam("lock-contended", { lockPath: markerPath, attempt: String(attempt) });
    if (attempt + 1 < LOCK_RETRIES) await sleep(LOCK_RETRY_MS);
  }
  throw new Error(`credential fence is held or its owner cannot be proved dead: ${markerPath}`);
}

async function releaseFence(fence: { path: string; observation: MarkerObservation }): Promise<void> {
  if (!(await unlinkObserved(fence.path, fence.observation, true))) throw new Error("credential fence ownership changed before release");
}

class OwnedCredentialLock {
  private timer: ReturnType<typeof setInterval> | undefined;
  private fencedOperation = false;

  constructor(
    readonly path: string,
    readonly marker: MarkerV1,
    readonly raw: string,
    readonly handle: fs.FileHandle,
    readonly identity: PathObservation,
  ) {
    this.timer = setInterval(() => {
      if (!this.fencedOperation) void this.heartbeat().catch(() => {});
    }, heartbeatIntervalMs);
    this.timer.unref?.();
  }

  private async checkOwnership(): Promise<void> {
    const handleStat = observation(await this.handle.stat({ bigint: true }));
    const pathMarker = await readMarker(this.path);
    if (!pathMarker || pathMarker.raw !== this.raw || pathMarker.marker.nonce !== this.marker.nonce
      || !sameIdentity(this.identity, handleStat, false) || !sameIdentity(handleStat, pathMarker, false)) {
      throw new Error("credential lock ownership was displaced");
    }
  }

  async fenced<T>(operation: () => Promise<T>): Promise<T> {
    this.fencedOperation = true;
    let fence: Awaited<ReturnType<typeof acquireFence>>;
    try {
      fence = await acquireFence();
    } catch (error) {
      this.fencedOperation = false;
      throw error;
    }
    let pulseError: unknown;
    let pulse = Promise.resolve();
    const pulseTimer = setInterval(() => {
      pulse = pulse.then(async () => {
        if (pulseError) return;
        try {
          await this.checkOwnership();
          await this.handle.utimes(new Date(), new Date());
        } catch (error) {
          pulseError = error;
        }
      });
    }, heartbeatIntervalMs);
    pulseTimer.unref?.();
    try {
      await this.checkOwnership();
      const result = await operation();
      await pulse;
      if (pulseError) throw pulseError;
      await this.checkOwnership();
      await this.handle.utimes(new Date(), new Date());
      return result;
    } finally {
      clearInterval(pulseTimer);
      await pulse;
      try {
        await releaseFence(fence);
      } finally {
        this.fencedOperation = false;
      }
    }
  }

  async heartbeat(): Promise<void> {
    await this.fenced(async () => {});
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    let releaseError: unknown;
    try {
      const fence = await acquireFence();
      try {
        await this.checkOwnership();
        if (!(await unlinkObserved(this.path, this.identity, true))) throw new Error("credential lock successor refused at release");
      } finally {
        await releaseFence(fence);
      }
    } catch (error) {
      releaseError = error;
    } finally {
      await this.handle.close().catch((error) => { releaseError ??= error; });
    }
    if (releaseError) throw releaseError;
  }

  async abandon(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.handle.close();
  }
}

async function openOwnedLock(markerPath: string, expected: MarkerV1, raw: string): Promise<OwnedCredentialLock> {
  const before = await readMarker(markerPath);
  if (!before || before.marker.nonce !== expected.nonce || before.raw !== raw) throw new Error("credential lock publication changed");
  const handle = await fs.open(markerPath, constants.O_RDONLY | NOFOLLOW);
  const opened = observation(await handle.stat({ bigint: true }));
  if (!sameIdentity(before, opened)) {
    await handle.close();
    throw new Error("credential lock handle identity mismatch");
  }
  return new OwnedCredentialLock(markerPath, expected, raw, handle, opened);
}

async function acquireCredentialLock(): Promise<OwnedCredentialLock> {
  await testSeam("lock-before-acquire", { lockPath: lockFile() });
  await secureCredentialDirectory(true);
  const markerPath = lockFile();
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    const fence = await acquireFence();
    let acquired: OwnedCredentialLock | undefined;
    let contended = false;
    let releaseError: unknown;
    try {
      const current = await readMarker(markerPath);
      if (!current) {
        const created = await markerForCurrentProcess();
        if (await publishMarker(markerPath, created.raw) === "created") acquired = await openOwnedLock(markerPath, created.marker, created.raw);
      } else {
        contended = true;
        const now = Date.now();
        if (current.mtimeMs > now || Date.parse(current.marker.acquiredAt) > now) throw new Error(`future-dated credential lock marker: ${markerPath}`);
        if (now - current.mtimeMs >= LOCK_STALE_MS) {
          const rechecked = await readMarker(markerPath);
          if (rechecked && sameIdentity(current, rechecked) && rechecked.raw === current.raw) {
            if (!(await unlinkObserved(markerPath, current, true))) throw new Error("stale credential lock changed during takeover");
            const created = await markerForCurrentProcess();
            if (await publishMarker(markerPath, created.raw) !== "created") throw new Error("credential lock takeover publication collided");
            acquired = await openOwnedLock(markerPath, created.marker, created.raw);
          }
        }
      }
    } finally {
      try {
        await releaseFence(fence);
      } catch (error) {
        releaseError = error;
      }
    }
    if (releaseError) {
      await acquired?.abandon().catch(() => {});
      throw releaseError;
    }
    if (acquired) return acquired;
    if (contended && credentialTestHook) await testSeam("lock-contended", { lockPath: markerPath, attempt: String(attempt) });
    if (attempt + 1 < LOCK_RETRIES) await sleep(LOCK_RETRY_MS);
  }
  throw new Error(`credential lock contention did not clear: ${markerPath}`);
}

class CredentialSourceReplacedError extends Error {}

async function openCredentialSource(sourcePath: string): Promise<{ handle: fs.FileHandle; identity: PathObservation; bytes: Buffer }> {
  const before = observation(await fs.lstat(sourcePath, { bigint: true }));
  await testSeam("source-after-lstat", { sourcePath });
  if (!regular(before.mode)) throw new Error(`credential path is a symlink or non-regular file: ${sourcePath}`);
  const handle = await fs.open(sourcePath, constants.O_RDONLY | NOFOLLOW);
  try {
    await testSeam("source-after-open", { sourcePath });
    const opened = observation(await handle.stat({ bigint: true }));
    await testSeam("source-after-fstat", { sourcePath });
    if (!sameIdentity(before, opened, false)) throw new CredentialSourceReplacedError(`credential path changed between lstat and open: ${sourcePath}`);
    if (before.size !== opened.size) throw new Error(`credential file changed between lstat and open: ${sourcePath}`);
    const bytes = await handle.readFile();
    await testSeam("source-after-read", { sourcePath });
    const after = observation(await handle.stat({ bigint: true }));
    if (!sameIdentity(opened, after) || BigInt(bytes.byteLength) !== opened.size) throw new Error(`credential file changed while reading: ${sourcePath}`);
    return { handle, identity: opened, bytes };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function classifyDisk(optimistic = false): Promise<{ parsed: ParsedCredential; source: Awaited<ReturnType<typeof openCredentialSource>> } | { absent: true }> {
  for (let attempt = 0;; attempt++) {
    try {
      if (!(await secureCredentialDirectory(false))) return { absent: true };
      const source = await openCredentialSource(file());
      return { parsed: parseCredentialDocument(source.bytes), source };
    } catch (error) {
      if (errno(error) === "ENOENT") return { absent: true };
      if (optimistic && error instanceof CredentialSourceReplacedError && attempt + 1 < OPTIMISTIC_READ_RETRIES) continue;
      throw error;
    }
  }
}

function quarantineTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function quarantine(
  lock: OwnedCredentialLock,
  source: Awaited<ReturnType<typeof openCredentialSource>>,
): Promise<string> {
  return lock.fenced(async () => {
    const parentIdentity = await secureCredentialDirectory(false);
    if (!parentIdentity) throw new Error("credential directory disappeared before quarantine");
    const base = `${file()}.corrupt-${quarantineTimestamp()}`;
    let destination = base;
    for (let n = 0;; n++) {
      if (n > 0) destination = `${base}-${n}`;
      let out: fs.FileHandle | undefined;
      try {
        out = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
      } catch (error) {
        if (errno(error) === "EEXIST") continue;
        throw error;
      }
      try {
        await out.writeFile(source.bytes);
        await out.chmod(0o600);
        await out.sync();
      } catch (error) {
        await out.close().catch(() => {});
        throw error;
      }
      await out.close();
      // The quarantine filename itself must be durable before the only source
      // name can be removed. A file fsync alone does not persist its directory
      // entry across a crash on all supported filesystems.
      await fsyncDirectory(dir());
      await testSeam("quarantine-copy-durable", { sourcePath: file(), destination });
      break;
    }
    const current = observation(await fs.lstat(file(), { bigint: true }));
    const handleCurrent = observation(await source.handle.stat({ bigint: true }));
    const parentCurrent = await secureCredentialDirectory(false);
    if (!parentCurrent || !sameIdentity(parentIdentity, parentCurrent, false)) throw new Error("credential directory changed before quarantine removal");
    if (!sameIdentity(source.identity, handleCurrent) || !sameIdentity(handleCurrent, current)) {
      throw new Error("credential source changed before quarantine removal; preserved copy retained");
    }
    await testSeam("quarantine-before-source-remove", { sourcePath: file(), destination });
    if (!(await unlinkObserved(file(), source.identity))) {
      throw new Error("credential source changed at quarantine removal; preserved copy retained");
    }
    await fsyncDirectory(dir()).catch(() => {});
    return destination;
  });
}

function unreadable(error: unknown): CredentialLoadResult {
  return { state: "unreadable", path: file(), detail: `credential file could not be safely read: ${errno(error) ?? "safety check failed"}; repair or remove it and retry` };
}

export function isCredentialDegraded(result: CredentialLoadResult): result is DegradedCredentialResult {
  return result.state !== "absent" && result.state !== "valid";
}

export function credentialFailureMessage(result: Exclude<CredentialLoadResult, { state: "valid" }>): string {
  if (result.state === "absent") return "not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)";
  if (result.state === "invalid-environment") return `credential ${result.state}: ${result.variable}: ${result.detail}; fix or unset it and retry`;
  return `credential ${result.state}: ${result.path}: ${"detail" in result ? result.detail : `unsupported version ${String(result.version)}`}; recover from the quarantine or remove/repair the file and retry`;
}

/** Strict/first-run policy adapter: absence remains undefined, degradation throws. */
export function credentialsForStrictFlow(result: CredentialLoadResult): CredentialsV1 | undefined {
  if (result.state === "valid") return result.credentials;
  if (result.state === "absent") return undefined;
  throw new Error(credentialFailureMessage(result));
}

export async function loadCredentials(): Promise<CredentialLoadResult> {
  const env = envResult();
  if (env) return env;

  // Reads are optimistic and side-effect free. Only a classification that
  // intends to quarantine crosses into the fenced mutation path below.
  let initial: Awaited<ReturnType<typeof classifyDisk>>;
  try {
    initial = await classifyDisk(true);
    if ("absent" in initial) return { state: "absent", path: file() };
    if (initial.parsed.state === "valid") {
      const result: CredentialLoadResult = { ...initial.parsed, source: "disk" };
      await initial.source.handle.close();
      return result;
    }
    await initial.source.handle.close();
    await testSeam("load-before-mutation-lock", { state: initial.parsed.state });
  } catch (error) {
    return unreadable(error);
  }

  let lock: OwnedCredentialLock | undefined;
  let result: CredentialLoadResult | undefined;
  try {
    lock = await acquireCredentialLock();
    // Discard the optimistic handle and classify again while serialized. A
    // concurrent save may have replaced corrupt evidence with a valid file.
    const rechecked = await classifyDisk();
    if ("absent" in rechecked) {
      result = { state: "absent", path: file() };
    } else {
      const { parsed, source } = rechecked;
      try {
        if (parsed.state === "valid") {
          result = { ...parsed, source: "disk" };
        } else {
          const quarantinedTo = await quarantine(lock, source);
          result = parsed.state === "corrupt"
            ? { state: "corrupt", path: file(), detail: parsed.detail, quarantinedTo }
            : { state: "unsupported-version", path: file(), version: parsed.version, quarantinedTo };
        }
      } finally {
        await source.handle.close();
      }
    }
  } catch (error) {
    result = unreadable(error);
  } finally {
    if (lock) {
      try {
        await lock.release();
      } catch (error) {
        result = unreadable(error);
      }
    }
  }
  return result ?? { state: "unreadable", path: file(), detail: "credential load did not produce a safe result" };
}

export async function requireCredentials(): Promise<CredentialsV1> {
  const result = await loadCredentials();
  if (result.state !== "valid") throw new Error(credentialFailureMessage(result));
  return result.credentials;
}

function serialized(c: Credentials): string {
  const parsed = parseCredentialDocument(JSON.stringify({
    v: 1,
    token: c.token,
    deviceId: c.deviceId,
    remoteUrl: c.remoteUrl,
    ...(c.accountId === undefined ? {} : { accountId: c.accountId }),
  }));
  if (parsed.state !== "valid") throw new Error(parsed.state === "corrupt" ? parsed.detail : "unsupported credential version");
  const value = parsed.credentials;
  return JSON.stringify({ v: 1, token: value.token, deviceId: value.deviceId, remoteUrl: value.remoteUrl, ...(value.accountId === undefined ? {} : { accountId: value.accountId }) }, null, 2) + "\n";
}

export async function saveCredentials(c: Credentials): Promise<void> {
  const body = serialized(c);
  const lock = await acquireCredentialLock();
  try {
    const classified = await classifyDisk();
    let expectedDestination: PathObservation | undefined,previousAccountId:string|undefined;
    if (!("absent" in classified)) {
      try {
        if (classified.parsed.state !== "valid") await quarantine(lock, classified.source);
        else {expectedDestination = classified.source.identity;previousAccountId=classified.parsed.credentials.accountId;}
      } finally {
        await classified.source.handle.close();
      }
    }
    await lock.fenced(async () => {
      if(previousAccountId!==c.accountId){
        if(previousAccountId&&GENESIS_ACCOUNT_ID_RE.test(previousAccountId))await invalidateGenesisEnrollmentWitness(previousAccountId);
      }
      const parentIdentity = await secureCredentialDirectory(false);
      if (!parentIdentity) throw new Error("credential directory disappeared before save");
      try {
        const destination = observation(await fs.lstat(file(), { bigint: true }));
        if (!regular(destination.mode)) throw new Error(`credential destination is not a regular file: ${file()}`);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      await writeFileAtomic(file(), body, {
        flag: "wx",
        mode: 0o600,
        exactMode: true,
        onStep: (step) => testSeam(`atomic-${step}`, { destination: file() }),
        beforeRename: async () => {
          await testSeam("save-before-parent-recheck", { directory: dir(), destination: file() });
          const parentCurrent = await secureCredentialDirectory(false);
          if (!parentCurrent || !sameIdentity(parentIdentity, parentCurrent, false)) throw new Error("credential directory changed before atomic rename");
          try {
            const current = observation(await fs.lstat(file(), { bigint: true }));
            if (!expectedDestination || !sameIdentity(current, expectedDestination)) {
              throw new Error("credential destination changed before atomic rename");
            }
          } catch (error) {
            if (errno(error) !== "ENOENT" || expectedDestination) throw error;
          }
          return true;
        },
      });
      await (async () => {
        await testSeam("save-before-directory-sync", { directory: dir() });
        await fsyncDirectory(dir());
      })().catch((error) => console.warn(`credential directory sync failed (${errno(error) ?? "unknown"}); credential save completed`));
    });
  } finally {
    await lock.release();
  }
}

async function normalClear(lock: OwnedCredentialLock): Promise<void> {
  await lock.fenced(async () => {
    try {
      const target = observation(await fs.lstat(file(), { bigint: true }));
      if (!regular(target.mode)) throw new Error(`credential destination is not a regular file: ${file()}`);
      if (!(await unlinkObserved(file(), target))) throw new Error("credential destination changed before logout removal");
      await fsyncDirectory(dir()).catch(() => {});
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  });
}

async function destructiveLogoutOverride(failure: unknown): Promise<void> {
  const targets = [fenceFile(), lockFile(), file()];
  const manual = `verify these paths are not symlinks, stop any rbox credential writer, and remove them manually: ${targets.join(", ")}`;
  const snapshots = new Map<string, { observation: PathObservation; handle: fs.FileHandle } | undefined>();
  try {
    const parentIdentity = await secureCredentialDirectory(false);
    if (!parentIdentity) throw new Error("credential directory is absent or changed");
    for (const target of targets) {
      try {
        const observed = observation(await fs.lstat(target, { bigint: true }));
        if (!regular(observed.mode)) throw new Error(`unsafe logout recovery target: ${target}`);
        const handle = await fs.open(target, constants.O_RDONLY | NOFOLLOW);
        const opened = observation(await handle.stat({ bigint: true }));
        if (!sameIdentity(observed, opened)) {
          await handle.close();
          throw new Error(`logout recovery target changed while opening: ${target}`);
        }
        snapshots.set(target, { observation: opened, handle });
      } catch (error) {
        if (errno(error) === "ENOENT") snapshots.set(target, undefined);
        else throw error;
      }
    }
    for (const [target, expected] of snapshots) {
      if (!expected) continue;
      const current = observation(await fs.lstat(target, { bigint: true }));
      const held = observation(await expected.handle.stat({ bigint: true }));
      if (!sameIdentity(current, expected.observation) || !sameIdentity(held, expected.observation)) throw new Error(`logout recovery target changed: ${target}`);
    }
    const parentCurrent = await secureCredentialDirectory(false);
    if (!parentCurrent || !sameIdentity(parentIdentity, parentCurrent, false)) throw new Error("credential directory changed before logout recovery deletion");
    await testSeam("logout-override-before-delete", { credentialPath: file(), lockPath: lockFile(), fencePath: fenceFile() });
    const deletionParent = await secureCredentialDirectory(false);
    if (!deletionParent || !sameIdentity(parentIdentity, deletionParent, false)) throw new Error("credential directory changed at logout recovery deletion");
    for (const [target, expected] of snapshots) {
      if (!expected) continue;
      const current = observation(await fs.lstat(target, { bigint: true }));
      const held = observation(await expected.handle.stat({ bigint: true }));
      if (!sameIdentity(current, expected.observation) || !sameIdentity(held, expected.observation)) {
        throw new Error(`logout recovery target changed at deletion seam: ${target}`);
      }
    }
    for (const target of [fenceFile(), lockFile()]) {
      const expected = snapshots.get(target);
      if (expected && !(await unlinkObserved(target, expected.observation))) throw new Error(`logout recovery target changed at deletion: ${target}`);
    }
    // Secret evidence is removed last. A cooperative writer must republish a
    // fence/main marker before it can save, so any republish visible here keeps
    // the credential intact and turns recovery into a safe refusal.
    for (const markerPath of [fenceFile(), lockFile()]) {
      try {
        await fs.lstat(markerPath);
        throw new Error(`credential writer republished during logout recovery: ${markerPath}`);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    }
    const credential = snapshots.get(file());
    if (credential && !(await unlinkObserved(file(), credential.observation))) {
      throw new Error(`logout recovery target changed at deletion: ${file()}`);
    }
    await testSeam("logout-override-after-delete", { credentialPath: file(), lockPath: lockFile(), fencePath: fenceFile() });
    let republished = false;
    for (const target of targets) {
      try {
        await fs.lstat(target);
        republished = true;
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
    }
    console.warn(`logout destructive-recovery override (${failureClass(failure)}): cleared${republished ? "; a credential path was republished" : ""}; if another rbox process was signing in concurrently, run \`rbox logout\` again`);
  } catch (error) {
    console.warn(`logout destructive-recovery override refused (${failureClass(failure)}): ${manual}`);
    throw new Error(`credentials could not be cleared safely; ${manual}`, { cause: error });
  } finally {
    for (const expected of snapshots.values()) await expected?.handle.close().catch(() => {});
  }
}

/** Logout-only recovery capability. No load/save/generic lock helper can reach it. */
export async function clearCredentials(): Promise<void> {
  let lock: OwnedCredentialLock | undefined;
  try {
    lock = await acquireCredentialLock();
    await normalClear(lock);
    await lock.release();
    lock = undefined;
  } catch (error) {
    await lock?.abandon().catch(() => {});
    await destructiveLogoutOverride(error);
  }
}
