import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  canonicalString,
  fromB64url,
  generateSignKeyPair,
  generateWrapKeyPair,
  randomBytes,
  sha256,
  sha256Hex,
  signPrivateToPkcs8,
  toB64url,
  utf8,
  wrapPrivateToPkcs8,
} from "../engine/e2ee/index.js";
import {
  acquireLock,
  systemLockIdentity,
  type LockIdentitySource,
  type ProcessIncarnation,
} from "../engine/git/lockfile.js";
import {
  ensureDirectoryChain,
  fsyncCreatedDirectoryAncestors,
  fsyncDirectory,
  writeFileAtomic,
} from "../engine/fsutil.js";

const VERSION = 1 as const;
const DEVICE_CODE_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{64}$/;
const ACCOUNT_ID_RE = /^acct_[0-9a-f]{16}$/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export interface LoginAttemptKeyMaterial {
  sigPubKey: Uint8Array;
  sigPrivPkcs8: Uint8Array;
  encPubKeySpki: Uint8Array;
  encPrivPkcs8: Uint8Array;
}

export interface LoginAttemptOwner extends ProcessIncarnation {
  nonce: string;
}

interface LoginAttemptBase {
  version: typeof VERSION;
  requestId: string;
  deviceCode: string;
  userCode: string;
  remoteUrl: string;
  label: string;
  pollIntervalSeconds: number;
  createdAt: number;
  expiresAt: number;
  deliveryExpiresAt?: number;
  pubkeyFingerprint: string;
  encPubKey: string;
  sigPubKey: string;
  sigPrivPkcs8: string;
  encPrivPkcs8: string;
  owner: LoginAttemptOwner;
}

export type LoginAttemptActive =
  | (LoginAttemptBase & { phase: "staged" })
  | (LoginAttemptBase & {
      phase: "credential-reserved" | "credential-saved";
      accountId: string;
      deviceId: string;
    })
  | (LoginAttemptBase & {
      phase: "persisted";
      accountId: string;
      deviceId: string;
      delivery: {
        requestId: string;
        mkWrapDevice: string;
        publishedRosterVersion: number;
        accountEpoch: number;
        expiresAt: number;
      };
    });

export interface LoginAttemptTerminal {
  version: typeof VERSION;
  requestId: string;
  remoteUrl: string;
  label: string;
  pollIntervalSeconds: number;
  createdAt: number;
  expiresAt: number;
  pubkeyFingerprint: string;
  owner: LoginAttemptOwner;
  phase: "abandoned" | "fulfilled";
  completedAt: number;
}

export type LoginAttemptRecord = LoginAttemptActive | LoginAttemptTerminal;

export class LoginAttemptAccountClaimedError extends Error {
  constructor() {
    super("this account is already set up (or being set up) on this machine — nothing more to do");
    this.name = "LoginAttemptAccountClaimedError";
  }
}

function isActive(record: LoginAttemptRecord): record is LoginAttemptActive {
  return record.phase === "staged"
    || record.phase === "credential-reserved"
    || record.phase === "credential-saved"
    || record.phase === "persisted";
}

interface IdentityDeps {
  identity?: LockIdentitySource;
  now?: () => number;
}

interface StageInput {
  deviceCode: string;
  userCode: string;
  remoteUrl: string;
  label: string;
  pollIntervalSeconds: number;
  createdAt: number;
  expiresAt: number;
  keys: LoginAttemptKeyMaterial;
  owner?: LoginAttemptOwner;
}

function home(): string {
  return process.env.RBOX_HOME || os.homedir();
}

export function loginAttemptRoot(): string {
  return path.join(home(), ".rbox", "login-attempts");
}

function lockPath(): string {
  return path.join(loginAttemptRoot(), ".journal.lock");
}

export function loginAttemptPath(requestId: string): string {
  if (!REQUEST_ID_RE.test(requestId)) throw new Error("invalid login attempt requestId");
  const root = path.resolve(loginAttemptRoot());
  const candidate = path.resolve(root, `${requestId}.json`);
  if (path.dirname(candidate) !== root) throw new Error("login attempt path escaped namespace");
  return candidate;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function canonicalB64(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("=")) return false;
  try {
    return toB64url(fromB64url(value)) === value;
  } catch {
    return false;
  }
}

function validateOwner(value: unknown): value is LoginAttemptOwner {
  return plain(value)
    && exactKeys(value, ["hostId", "bootId", "pid", "startTime", "nonce"])
    && typeof value.hostId === "string" && value.hostId.length > 0
    && typeof value.bootId === "string" && value.bootId.length > 0
    && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.startTime === "string" && /^\d+(?:\.\d+)?$/.test(value.startTime)
    && typeof value.nonce === "string" && /^[0-9a-f]{32}$/.test(value.nonce);
}

function assertCanonicalPublicKeys(encPubKey: string, sigPubKey: string): void {
  if (!canonicalB64(sigPubKey) || fromB64url(sigPubKey).length !== 32) {
    throw new Error("login sigPubKey must be canonical base64url Ed25519 raw 32 bytes");
  }
  if (!canonicalB64(encPubKey)) {
    throw new Error("login encPubKey must be canonical base64url RSA SPKI");
  }
  const der = fromB64url(encPubKey);
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
  } catch {
    throw new Error("login encPubKey is not a valid RSA SPKI");
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== "rsa"
    || details?.modulusLength !== 3072
    || details.publicExponent !== 65537n) {
    throw new Error("login encPubKey must be RSA-3072 with exponent 65537");
  }
  const roundTrip = new Uint8Array(key.export({ format: "der", type: "spki" }) as Buffer);
  if (!Buffer.from(roundTrip).equals(Buffer.from(der))) {
    throw new Error("login encPubKey SPKI is not canonical DER");
  }
}

function validatePrivateKeyBinding(record: LoginAttemptActive): void {
  const sigPrivate = createPrivateKey({
    key: Buffer.from(fromB64url(record.sigPrivPkcs8)),
    format: "der",
    type: "pkcs8",
  });
  if (sigPrivate.asymmetricKeyType !== "ed25519") {
    throw new Error("login attempt signing private key is not Ed25519");
  }
  const sigDerived = Buffer.from(
    (createPublicKey(sigPrivate).export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  );
  if (toB64url(sigDerived) !== record.sigPubKey) {
    throw new Error("login attempt signing keypair mismatch");
  }

  const encPrivate = createPrivateKey({
    key: Buffer.from(fromB64url(record.encPrivPkcs8)),
    format: "der",
    type: "pkcs8",
  });
  if (encPrivate.asymmetricKeyType !== "rsa") {
    throw new Error("login attempt encryption private key is not RSA");
  }
  const encDerived = new Uint8Array(
    createPublicKey(encPrivate).export({ format: "der", type: "spki" }) as Buffer,
  );
  if (toB64url(encDerived) !== record.encPubKey) {
    throw new Error("login attempt encryption keypair mismatch");
  }
}

async function expectedFingerprint(encPubKey: string, sigPubKey: string): Promise<string> {
  assertCanonicalPublicKeys(encPubKey, sigPubKey);
  return toB64url(await sha256(utf8(canonicalString({
    encPubKeySpki: encPubKey,
    sigPubKey,
  }))));
}

export async function loginPublicKeyFingerprint(keys: {
  encPubKey: string;
  sigPubKey: string;
}): Promise<string> {
  return expectedFingerprint(keys.encPubKey, keys.sigPubKey);
}

export function generateLoginAttemptKeys(): LoginAttemptKeyMaterial {
  const sig = generateSignKeyPair();
  const enc = generateWrapKeyPair();
  return {
    sigPubKey: sig.publicKey,
    sigPrivPkcs8: signPrivateToPkcs8(sig.privateKey),
    encPubKeySpki: enc.publicKeySpki,
    encPrivPkcs8: wrapPrivateToPkcs8(enc.privateKey),
  };
}

export function loginAttemptKeys(record: LoginAttemptActive): LoginAttemptKeyMaterial {
  return {
    sigPubKey: fromB64url(record.sigPubKey),
    sigPrivPkcs8: fromB64url(record.sigPrivPkcs8),
    encPubKeySpki: fromB64url(record.encPubKey),
    encPrivPkcs8: fromB64url(record.encPrivPkcs8),
  };
}

export async function requestIdForDeviceCode(deviceCode: string): Promise<string> {
  if (!DEVICE_CODE_RE.test(deviceCode)) throw new Error("invalid device code from login service");
  return sha256Hex(utf8(deviceCode));
}

async function parseRecord(raw: string, filenameRequestId?: string): Promise<LoginAttemptRecord> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid login attempt journal JSON");
  }
  if (!plain(value) || value.version !== VERSION || typeof value.phase !== "string") {
    throw new Error("invalid login attempt journal");
  }
  if (value.phase === "abandoned" || value.phase === "fulfilled") {
    const terminalKeys = [
      "version", "requestId", "remoteUrl", "label", "pollIntervalSeconds", "createdAt", "expiresAt",
      "pubkeyFingerprint", "owner", "phase", "completedAt",
    ];
    if (!exactKeys(value, terminalKeys)
      || typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId)
      || filenameRequestId !== undefined && value.requestId !== filenameRequestId
      || typeof value.remoteUrl !== "string" || !validRemote(value.remoteUrl)
      || typeof value.label !== "string"
      || !safeInteger(value.pollIntervalSeconds)
      || !safeInteger(value.createdAt) || !safeInteger(value.expiresAt)
      || value.expiresAt <= value.createdAt
      || typeof value.pubkeyFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.pubkeyFingerprint)
      || !validateOwner(value.owner)
      || !safeInteger(value.completedAt)) {
      throw new Error("invalid terminal login attempt journal");
    }
    return value as unknown as LoginAttemptTerminal;
  }

  const commonKeys = [
    "version", "requestId", "deviceCode", "userCode", "remoteUrl", "label", "pollIntervalSeconds",
    "createdAt", "expiresAt", "pubkeyFingerprint", "encPubKey", "sigPubKey",
    "sigPrivPkcs8", "encPrivPkcs8", "owner", "phase",
  ];
  const phaseKeys = value.phase === "staged"
    ? commonKeys
    : value.phase === "credential-reserved" || value.phase === "credential-saved"
      ? [...commonKeys, "accountId", "deviceId"]
      : value.phase === "persisted"
        ? [...commonKeys, "accountId", "deviceId", "delivery"]
        : [];
  if (Object.hasOwn(value, "deliveryExpiresAt")) phaseKeys.push("deliveryExpiresAt");
  if (!phaseKeys.length || !exactKeys(value, phaseKeys)
    || typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId)
    || filenameRequestId !== undefined && value.requestId !== filenameRequestId
    || typeof value.deviceCode !== "string" || !DEVICE_CODE_RE.test(value.deviceCode)
    || await requestIdForDeviceCode(value.deviceCode) !== value.requestId
    || typeof value.userCode !== "string" || !value.userCode
    || typeof value.remoteUrl !== "string" || !validRemote(value.remoteUrl)
    || typeof value.label !== "string"
    || !safeInteger(value.pollIntervalSeconds)
    || !safeInteger(value.createdAt) || !safeInteger(value.expiresAt)
    || value.expiresAt <= value.createdAt
    || value.deliveryExpiresAt !== undefined && (!safeInteger(value.deliveryExpiresAt) || value.deliveryExpiresAt > value.expiresAt)
    || !canonicalB64(value.encPubKey) || !canonicalB64(value.sigPubKey)
    || !canonicalB64(value.sigPrivPkcs8) || !canonicalB64(value.encPrivPkcs8)
    || typeof value.pubkeyFingerprint !== "string"
    || await expectedFingerprint(value.encPubKey, value.sigPubKey) !== value.pubkeyFingerprint
    || !validateOwner(value.owner)) {
    throw new Error("invalid active login attempt journal");
  }
  if (value.phase !== "staged") {
    if (typeof value.accountId !== "string" || !ACCOUNT_ID_RE.test(value.accountId)
      || typeof value.deviceId !== "string" || !value.deviceId) {
      throw new Error("invalid login attempt credential identity");
    }
  }
  if (value.phase === "persisted") {
    if (!plain(value.delivery)
      || !exactKeys(value.delivery, [
        "requestId", "mkWrapDevice", "publishedRosterVersion", "accountEpoch", "expiresAt",
      ])
      || value.delivery.requestId !== value.requestId
      || typeof value.delivery.mkWrapDevice !== "string" || !value.delivery.mkWrapDevice
      || !safeInteger(value.delivery.publishedRosterVersion)
      || !safeInteger(value.delivery.accountEpoch)
      || !safeInteger(value.delivery.expiresAt)
      || value.delivery.expiresAt > value.expiresAt) {
      throw new Error("invalid persisted login delivery");
    }
  }
  const record = value as unknown as LoginAttemptActive;
  validatePrivateKeyBinding(record);
  return record;
}

function validRemote(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function readNoFollow(file: string): Promise<string | undefined> {
  let before: Stats;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe login attempt journal file");
  if ((before.mode & 0o777) !== FILE_MODE) throw new Error("unsafe login attempt journal mode");
  if (process.getuid !== undefined && before.uid !== process.getuid()) {
    throw new Error("login attempt journal is not owned by the current user");
  }
  const handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error("login attempt journal changed during open");
    if (opened.size > 64 * 1024) throw new Error("login attempt journal is too large");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function ensureRoot(): Promise<void> {
  const root = loginAttemptRoot();
  const created = await ensureDirectoryChain(root, "login attempt journal directory");
  for (const dir of created) await fs.chmod(dir, DIR_MODE);
  await fsyncCreatedDirectoryAncestors(root, created);
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== DIR_MODE) {
    throw new Error("unsafe login attempt journal directory");
  }
  if (process.getuid !== undefined && stat.uid !== process.getuid()) {
    throw new Error("login attempt journal directory is not owned by the current user");
  }
}

async function withJournalLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureRoot();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const result = await acquireLock(lockPath(), { skipIdentityRefresh: true });
    if (result.status === "acquired") {
      try {
        return await fn();
      } finally {
        const released = await result.lock.release();
        if (!released.released) throw new Error("login attempt journal lock release failed");
      }
    }
    if (result.status === "error" || result.status === "unsupported") {
      throw result.error instanceof Error ? result.error : new Error("login attempt journal lock unavailable");
    }
    if (Date.now() >= deadline) throw new Error("another rbox login is updating the attempt journal");
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

async function writeRecord(record: LoginAttemptRecord): Promise<void> {
  const file = loginAttemptPath(record.requestId);
  await writeFileAtomic(file, canonicalString(record), {
    mode: FILE_MODE,
    exactMode: true,
  });
  await fsyncDirectory(path.dirname(file));
}

async function ownerFor(identity: LockIdentitySource): Promise<LoginAttemptOwner> {
  const current = await identity.current();
  return {
    hostId: current.hostId,
    bootId: current.bootId,
    pid: current.pid,
    startTime: current.startTime,
    nonce: Buffer.from(randomBytes(16)).toString("hex"),
  };
}

function effectiveExpiry(attempt: LoginAttemptActive): number {
  return Math.min(attempt.expiresAt, attempt.deliveryExpiresAt ?? attempt.expiresAt);
}

function terminalize(
  attempt: LoginAttemptActive,
  phase: LoginAttemptTerminal["phase"],
  completedAt: number,
): LoginAttemptTerminal {
  return {
    version: VERSION,
    requestId: attempt.requestId,
    remoteUrl: attempt.remoteUrl,
    label: attempt.label,
    pollIntervalSeconds: attempt.pollIntervalSeconds,
    createdAt: attempt.createdAt,
    expiresAt: effectiveExpiry(attempt),
    pubkeyFingerprint: attempt.pubkeyFingerprint,
    owner: attempt.owner,
    phase,
    completedAt,
  };
}

async function loadLocked(requestId: string): Promise<LoginAttemptRecord | undefined> {
  const raw = await readNoFollow(loginAttemptPath(requestId));
  return raw === undefined ? undefined : parseRecord(raw, requestId);
}

async function updateOwned(
  attempt: LoginAttemptActive,
  update: (current: LoginAttemptActive) => LoginAttemptRecord,
): Promise<LoginAttemptRecord> {
  return withJournalLock(async () => {
    const current = await loadLocked(attempt.requestId);
    if (!current || !isActive(current)) {
      throw new Error("login attempt is no longer active");
    }
    if (current.owner.nonce !== attempt.owner.nonce) {
      throw new Error("login attempt ownership changed");
    }
    const next = update(current);
    await writeRecord(next);
    return next;
  });
}

export async function stageLoginAttempt(input: StageInput): Promise<LoginAttemptActive> {
  const identity = systemLockIdentity;
  const requestId = await requestIdForDeviceCode(input.deviceCode);
  const encPubKey = toB64url(input.keys.encPubKeySpki);
  const sigPubKey = toB64url(input.keys.sigPubKey);
  const record: LoginAttemptActive = {
    version: VERSION,
    requestId,
    deviceCode: input.deviceCode,
    userCode: input.userCode,
    remoteUrl: input.remoteUrl,
    label: input.label,
    pollIntervalSeconds: input.pollIntervalSeconds,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    pubkeyFingerprint: await expectedFingerprint(encPubKey, sigPubKey),
    encPubKey,
    sigPubKey,
    sigPrivPkcs8: toB64url(input.keys.sigPrivPkcs8),
    encPrivPkcs8: toB64url(input.keys.encPrivPkcs8),
    owner: input.owner ?? await ownerFor(identity),
    phase: "staged",
  };
  await parseRecord(canonicalString(record), requestId);
  return withJournalLock(async () => {
    if (await loadLocked(requestId)) throw new Error("login attempt already exists");
    await writeRecord(record);
    return record;
  });
}

export async function loadLoginAttempt(requestId: string): Promise<LoginAttemptRecord | undefined> {
  await ensureRoot();
  const raw = await readNoFollow(loginAttemptPath(requestId));
  return raw === undefined ? undefined : parseRecord(raw, requestId);
}

export async function recordDeliveryExpiry(
  attempt: LoginAttemptActive,
  expiresAt: number,
): Promise<LoginAttemptActive> {
  if (!safeInteger(expiresAt)) throw new Error("invalid key-delivery expiry");
  return await updateOwned(attempt, (current) => {
    if (expiresAt <= current.createdAt || expiresAt > current.expiresAt) {
      throw new Error("key-delivery expiry is outside the device-code TTL");
    }
    if (current.deliveryExpiresAt !== undefined && current.deliveryExpiresAt !== expiresAt) {
      throw new Error("key-delivery expiry changed across polls");
    }
    return { ...current, deliveryExpiresAt: expiresAt };
  }) as LoginAttemptActive;
}

export async function reserveLoginCredential(
  attempt: LoginAttemptActive,
  accountId: string,
  deviceId: string,
): Promise<LoginAttemptActive> {
  if (!ACCOUNT_ID_RE.test(accountId) || !deviceId) throw new Error("invalid login credential identity");
  return withJournalLock(async () => {
    const loaded = await loadLocked(attempt.requestId);
    if (!loaded || !isActive(loaded)) throw new Error("login attempt is no longer active");
    if (loaded.owner.nonce !== attempt.owner.nonce) throw new Error("login attempt ownership changed");
    const sibling = (await recordsLocked()).find((record) =>
      isActive(record)
      && record.requestId !== loaded.requestId
      && record.phase !== "staged"
      && record.accountId === accountId);
    if (sibling) throw new LoginAttemptAccountClaimedError();
    const current = loaded;
    if (current.phase === "persisted") {
      if (current.accountId !== accountId || current.deviceId !== deviceId) {
        throw new Error("login credential identity changed after persistence");
      }
      return current;
    }
    if ((current.phase === "credential-reserved" || current.phase === "credential-saved")
      && (current.accountId !== accountId || current.deviceId !== deviceId)) {
      throw new Error("login credential identity changed");
    }
    if (current.phase === "credential-reserved" || current.phase === "credential-saved") {
      return current;
    }
    const next: LoginAttemptActive = {
      ...current,
      phase: "credential-reserved",
      accountId,
      deviceId,
    };
    await writeRecord(next);
    return next;
  });
}

export async function recordLoginCredentialSaved(
  attempt: LoginAttemptActive,
  accountId: string,
  deviceId: string,
): Promise<LoginAttemptActive> {
  if (!ACCOUNT_ID_RE.test(accountId) || !deviceId) throw new Error("invalid login credential identity");
  return await updateOwned(attempt, (current) => {
    if (current.phase === "staged") throw new Error("cannot save an unreserved login credential");
    if (current.accountId !== accountId || current.deviceId !== deviceId) {
      throw new Error("login credential identity changed");
    }
    if (current.phase === "persisted" || current.phase === "credential-saved") return current;
    return { ...current, phase: "credential-saved" };
  }) as LoginAttemptActive;
}

export interface PersistedDelivery {
  requestId: string;
  mkWrapDevice: string;
  publishedRosterVersion: number;
  accountEpoch: number;
  expiresAt: number;
}

export async function recordLoginPersisted(
  attempt: LoginAttemptActive,
  delivery: PersistedDelivery,
): Promise<LoginAttemptActive> {
  return await updateOwned(attempt, (current) => {
    if (current.phase === "staged" || current.phase === "credential-reserved") {
      throw new Error("cannot persist login delivery before saving the credential");
    }
    if (delivery.requestId !== current.requestId) throw new Error("key-delivery requestId mismatch");
    if (current.phase === "persisted") {
      if (canonicalString(current.delivery) !== canonicalString(delivery)) {
        throw new Error("persisted key delivery changed");
      }
      return current;
    }
    return { ...current, phase: "persisted", delivery };
  }) as LoginAttemptActive;
}

export async function finishLoginAttempt(
  attempt: LoginAttemptActive,
  phase: LoginAttemptTerminal["phase"],
  completedAt = Date.now(),
): Promise<LoginAttemptTerminal> {
  return await updateOwned(attempt, (current) => terminalize(current, phase, completedAt)) as LoginAttemptTerminal;
}

async function ownerIsLive(owner: LoginAttemptOwner, identity: LockIdentitySource): Promise<boolean> {
  const current = await identity.current();
  if (owner.hostId === current.hostId && owner.bootId === current.bootId
    && owner.pid === current.pid && owner.startTime === current.startTime) {
    return true;
  }
  if (owner.hostId !== current.hostId) return true;
  if (owner.bootId !== current.bootId) return false;
  const probe = await identity.probe(owner.pid);
  return probe.status === "alive" && probe.startTime === owner.startTime
    || probe.status === "unknown";
}

async function recordsLocked(): Promise<LoginAttemptRecord[]> {
  const entries = await fs.readdir(loginAttemptRoot(), { withFileTypes: true });
  const records: LoginAttemptRecord[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith(".json")) continue;
    const requestId = entry.name.slice(0, -5);
    if (!REQUEST_ID_RE.test(requestId) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("unsafe entry in login attempt journal");
    }
    const loaded = await loadLocked(requestId);
    if (loaded) records.push(loaded);
  }
  return records;
}

async function sweepLocked(now: number): Promise<{ abandoned: number; removed: number }> {
  let abandoned = 0;
  let removed = 0;
  for (const record of await recordsLocked()) {
    if (!isActive(record)) {
      if (record.completedAt + TERMINAL_RETENTION_MS <= now) {
        await fs.unlink(loginAttemptPath(record.requestId));
        await fsyncDirectory(loginAttemptRoot());
        removed++;
      }
      continue;
    }
    if (effectiveExpiry(record) <= now) {
      await writeRecord(terminalize(record, "abandoned", now));
      abandoned++;
    }
  }
  return { abandoned, removed };
}

export async function sweepLoginAttempts(now = Date.now()): Promise<{ abandoned: number; removed: number }> {
  return withJournalLock(() => sweepLocked(now));
}

export async function resumeLoginAttempt(
  remoteUrl: string,
  label: string,
  deps: IdentityDeps = {},
): Promise<LoginAttemptActive | undefined> {
  const identity = deps.identity ?? systemLockIdentity;
  const now = (deps.now ?? Date.now)();
  return withJournalLock(async () => {
    await sweepLocked(now);
    const candidates = (await recordsLocked())
      .filter((record): record is LoginAttemptActive =>
        isActive(record)
        && record.remoteUrl === remoteUrl
        && record.label === label
        && effectiveExpiry(record) > now)
      .sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
    for (const candidate of candidates) {
      if (await ownerIsLive(candidate.owner, identity)) continue;
      const claimed = { ...candidate, owner: await ownerFor(identity) };
      await writeRecord(claimed);
      return claimed;
    }
    return undefined;
  });
}
