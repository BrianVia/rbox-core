import { createPublicKey } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildAdminRoster,
  canonicalString,
  fromB64url,
  rsaDeviceWrap,
  sha256,
  sha256Hex,
  signPrivateFromPkcs8,
  toB64url,
  utf8,
  verifyAccount,
  wrapHash,
  type DeviceSecrets,
  type RsaWrap,
  type SignedKeyState,
  type SignedRoster,
  type VerifiedAccount,
  type Wrap,
} from "../../engine/e2ee/index.js";
import type { HeadPin } from "../e2ee-keystore.js";
import { loadDevice, loadPin } from "../e2ee-keystore.js";
import type { AccountKeysDTO } from "../e2ee-remote.js";
import {
  e2eeRoot,
  GENESIS_ACCOUNT_ID_RE,
  hardenedWrite,
  type HardenedWriteOptions,
} from "../genesis-durable.js";
import { RboxApi } from "../remote.js";

const REQUEST_ID_RE = /^[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const APPROVAL_MAX_AGE_MS = 10 * 60_000;
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_FLIGHT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRY_BUDGET = 3;
const MAX_PENDING_NUDGES = 5;

export interface KeyDeliveryRequest {
  requestId: string;
  targetDeviceId: string;
  encPubKey: string;
  sigPubKey: string;
  encPubKeyHash: string;
  sigPubKeyHash: string;
  pubkeyFingerprint: string;
  approvalTokenHash: string;
  accountEpoch: number;
  approvedAt: number;
  expiresAt: number;
}

export interface KeyDeliveryFetchBody {
  requestId?: string;
  keyReleaseOptIn: boolean;
}

export interface KeyDeliverySubmitBody {
  requestId: string;
  mkWrapDevice: string;
  publishedRosterVersion: number;
  accountEpoch: number;
}

export interface KeyDeliveryDaemonPreference {
  version: 1;
  accountId: string;
  deviceId: string;
  keyReleaseOptIn: boolean;
  fulfillmentEnabled: boolean;
}

export interface KeyDeliveryPreferenceOverride {
  keyReleaseOptIn?: boolean;
  fulfillmentEnabled?: boolean;
}

export interface KeyDeliveryFulfillmentApi {
  fetch(body: KeyDeliveryFetchBody, signal: AbortSignal): Promise<unknown>;
  getAccountKeys(signal: AbortSignal): Promise<AccountKeysDTO | null>;
  publish(
    body: {
      device: { deviceId: string; sigPubKey: string; encPubKey: string; mkWrap: string };
      roster: { version: number; signed: string };
    },
    signal: AbortSignal,
  ): Promise<{ ok: boolean; conflict?: boolean }>;
  submit(body: KeyDeliverySubmitBody, signal: AbortSignal): Promise<unknown>;
}

export interface KeyDeliveryFlightPort {
  enqueue(requestId?: string): void;
  stop(): Promise<void>;
}

export type FulfillmentBoundary = "after-stage" | "after-publish" | "after-submit";

export interface KeyDeliveryFulfillmentHooks {
  onBoundary?(boundary: FulfillmentBoundary): void | Promise<void>;
  wrapDevice?(publicSpki: Uint8Array, mk: Uint8Array, ctx: {
    accountId: string;
    accountEpoch: number;
    wrappedKeyKind: "MK";
    purpose: "rbox/mk-wrap/device/v1";
  }): Promise<RsaWrap>;
  loadDevice?(accountId: string): ReturnType<typeof loadDevice>;
  loadPin?(accountId: string, workspaceId: string): Promise<HeadPin | undefined>;
  loadPreference?(accountId: string, deviceId: string, pullOnly: boolean): Promise<KeyDeliveryDaemonPreference>;
  savePreference?(preference: KeyDeliveryDaemonPreference): Promise<void>;
  now?(): number;
  random?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

interface ValidatedRequest extends KeyDeliveryRequest {
  encPubKeyBytes: Uint8Array;
  sigPubKeyBytes: Uint8Array;
}

interface FulfillmentStage {
  version: 1;
  accountId: string;
  requestId: string;
  requestDigest: string;
  targetDeviceId: string;
  accountEpoch: number;
  mkWrapDevice: string;
  signedRoster: string;
  rosterVersion: number;
  stagedAt: number;
}

interface VerifiedSnapshot {
  dto: AccountKeysDTO;
  account: VerifiedAccount;
}

class KeyDeliveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyDeliveryValidationError";
  }
}

class KeyDeliveryBoundaryCrash extends Error {
  constructor(readonly boundary: FulfillmentBoundary, cause: unknown) {
    super(`key-delivery crash injected ${boundary}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "KeyDeliveryBoundaryCrash";
  }
}

export class KeyDeliveryHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "KeyDeliveryHttpError";
  }
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
};

const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function decodeCanonicalBase64url(value: unknown): Uint8Array {
  if (typeof value !== "string" || !B64URL_RE.test(value)) {
    throw new KeyDeliveryValidationError("key-delivery public key is not canonical base64url");
  }
  let decoded: Uint8Array;
  try {
    decoded = fromB64url(value);
  } catch {
    throw new KeyDeliveryValidationError("key-delivery public key is not valid base64url");
  }
  if (toB64url(decoded) !== value) {
    throw new KeyDeliveryValidationError("key-delivery public key is not canonical base64url");
  }
  return decoded;
}

function assertRsa3072Spki(spki: Uint8Array): void {
  try {
    const key = createPublicKey({ key: Buffer.from(spki), format: "der", type: "spki" });
    const details = key.asymmetricKeyDetails;
    const canonical = key.export({ format: "der", type: "spki" }) as Buffer;
    if (
      key.asymmetricKeyType !== "rsa"
      || details?.modulusLength !== 3072
      || details.publicExponent !== 65537n
      || !canonical.equals(Buffer.from(spki))
    ) {
      throw new Error("wrong RSA parameters");
    }
  } catch {
    throw new KeyDeliveryValidationError("key-delivery encryption key must be a canonical RSA-3072/65537 SPKI");
  }
}

async function requestDigest(request: KeyDeliveryRequest): Promise<string> {
  return sha256Hex(utf8(canonicalString({
    requestId: request.requestId,
    targetDeviceId: request.targetDeviceId,
    encPubKey: request.encPubKey,
    sigPubKey: request.sigPubKey,
    encPubKeyHash: request.encPubKeyHash,
    sigPubKeyHash: request.sigPubKeyHash,
    pubkeyFingerprint: request.pubkeyFingerprint,
    approvalTokenHash: request.approvalTokenHash,
    accountEpoch: request.accountEpoch,
    approvedAt: request.approvedAt,
    expiresAt: request.expiresAt,
  })));
}

export async function validateKeyDeliveryFetchResponse(
  value: unknown,
  nudgedRequestId: string | undefined,
  now: number,
): Promise<ValidatedRequest | null> {
  if (!plain(value)) throw new KeyDeliveryValidationError("malformed key-delivery fetch response");
  if (value.request === null) {
    if (
      !exactKeys(value, ["request"])
      && !(exactKeys(value, ["request", "keyReleaseEnabled"]) && value.keyReleaseEnabled === false)
    ) {
      throw new KeyDeliveryValidationError("malformed empty key-delivery fetch response");
    }
    return null;
  }
  if (!exactKeys(value, ["request"]) || !plain(value.request)) {
    throw new KeyDeliveryValidationError("malformed key-delivery fetch response");
  }
  const request = value.request;
  const fields = [
    "requestId",
    "targetDeviceId",
    "encPubKey",
    "sigPubKey",
    "encPubKeyHash",
    "sigPubKeyHash",
    "pubkeyFingerprint",
    "approvalTokenHash",
    "accountEpoch",
    "approvedAt",
    "expiresAt",
  ] as const;
  if (!exactKeys(request, fields)) throw new KeyDeliveryValidationError("malformed key-delivery request shape");
  if (typeof request.requestId !== "string" || !REQUEST_ID_RE.test(request.requestId)) {
    throw new KeyDeliveryValidationError("invalid key-delivery requestId");
  }
  if (nudgedRequestId !== undefined && request.requestId !== nudgedRequestId) {
    throw new KeyDeliveryValidationError("key-delivery fetch returned a different requestId");
  }
  if (typeof request.targetDeviceId !== "string" || request.targetDeviceId.length === 0 || request.targetDeviceId.length > 256) {
    throw new KeyDeliveryValidationError("invalid key-delivery target device");
  }
  if (
    typeof request.encPubKeyHash !== "string" || !HASH_RE.test(request.encPubKeyHash)
    || typeof request.sigPubKeyHash !== "string" || !HASH_RE.test(request.sigPubKeyHash)
    || typeof request.approvalTokenHash !== "string" || !HASH_RE.test(request.approvalTokenHash)
    || typeof request.pubkeyFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.pubkeyFingerprint)
    || !safeInteger(request.accountEpoch)
    || !safeInteger(request.approvedAt)
    || !safeInteger(request.expiresAt)
  ) {
    throw new KeyDeliveryValidationError("invalid key-delivery request fields");
  }
  if (
    request.approvedAt > now
    || request.expiresAt <= now
    || now - request.approvedAt >= APPROVAL_MAX_AGE_MS
    || request.expiresAt - request.approvedAt > APPROVAL_MAX_AGE_MS
  ) {
    throw new KeyDeliveryValidationError("key-delivery approval is expired or not fresh");
  }
  const encPubKeyBytes = decodeCanonicalBase64url(request.encPubKey);
  const sigPubKeyBytes = decodeCanonicalBase64url(request.sigPubKey);
  if (sigPubKeyBytes.byteLength !== 32) {
    throw new KeyDeliveryValidationError("key-delivery signing key must be 32-byte Ed25519");
  }
  assertRsa3072Spki(encPubKeyBytes);
  if (await sha256Hex(encPubKeyBytes) !== request.encPubKeyHash || await sha256Hex(sigPubKeyBytes) !== request.sigPubKeyHash) {
    throw new KeyDeliveryValidationError("key-delivery public-key hash binding mismatch");
  }
  const fingerprint = toB64url(await sha256(utf8(canonicalString({
    encPubKeySpki: request.encPubKey,
    sigPubKey: request.sigPubKey,
  }))));
  if (fingerprint !== request.pubkeyFingerprint) {
    throw new KeyDeliveryValidationError("key-delivery public-key fingerprint mismatch");
  }
  return { ...(request as unknown as KeyDeliveryRequest), encPubKeyBytes, sigPubKeyBytes };
}

function assertAccountId(accountId: string): void {
  if (!GENESIS_ACCOUNT_ID_RE.test(accountId)) throw new Error("invalid key-delivery account id");
}

export const keyDeliveryJournalPath = (accountId: string, requestId: string): string => {
  assertAccountId(accountId);
  if (!REQUEST_ID_RE.test(requestId)) throw new Error("invalid key-delivery request id");
  return path.join(e2eeRoot(), accountId, "key-delivery", `${requestId}.json`);
};

async function preferencePath(accountId: string, deviceId: string): Promise<string> {
  assertAccountId(accountId);
  if (!deviceId || deviceId.length > 256) throw new Error("invalid key-delivery device id");
  const deviceHash = await sha256Hex(utf8(deviceId));
  return path.join(e2eeRoot(), accountId, "key-delivery", `daemon-${deviceHash}.prefs.json`);
}

async function readBoundedRegular(file: string, maxBytes: number): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("key-delivery state file is not a bounded regular file");
    return await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parsePreference(raw: string, accountId: string, deviceId: string): KeyDeliveryDaemonPreference {
  const value = JSON.parse(raw) as unknown;
  if (
    !plain(value)
    || !exactKeys(value, ["version", "accountId", "deviceId", "keyReleaseOptIn", "fulfillmentEnabled"])
    || value.version !== 1
    || value.accountId !== accountId
    || value.deviceId !== deviceId
    || typeof value.keyReleaseOptIn !== "boolean"
    || typeof value.fulfillmentEnabled !== "boolean"
  ) {
    throw new Error("invalid key-delivery daemon preference");
  }
  return value as unknown as KeyDeliveryDaemonPreference;
}

export async function loadKeyDeliveryDaemonPreference(
  accountId: string,
  deviceId: string,
  pullOnly: boolean,
): Promise<KeyDeliveryDaemonPreference> {
  const raw = await readBoundedRegular(await preferencePath(accountId, deviceId), 4096);
  if (raw === undefined) {
    return {
      version: 1,
      accountId,
      deviceId,
      keyReleaseOptIn: !pullOnly,
      fulfillmentEnabled: true,
    };
  }
  return parsePreference(raw, accountId, deviceId);
}

export async function saveKeyDeliveryDaemonPreference(
  preference: KeyDeliveryDaemonPreference,
  options?: HardenedWriteOptions,
): Promise<void> {
  const raw = canonicalString(preference);
  parsePreference(raw, preference.accountId, preference.deviceId);
  await hardenedWrite(await preferencePath(preference.accountId, preference.deviceId), raw, options);
}

function booleanOverride(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true" || value === "on") return true;
  return false;
}

/**
 * Production control surface. Overrides are persisted into the per-device
 * preference on the next flight, so daemon restarts do not silently re-enable
 * release. Unknown explicit values fail closed.
 */
export function keyDeliveryPreferenceOverrideFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeyDeliveryPreferenceOverride | undefined {
  const keyReleaseOptIn = booleanOverride(env.RBOX_DAEMON_KEY_RELEASE_OPT_IN);
  const fulfillmentEnabled = booleanOverride(env.RBOX_DAEMON_KEY_DELIVERY);
  if (keyReleaseOptIn === undefined && fulfillmentEnabled === undefined) return undefined;
  return {
    ...(keyReleaseOptIn === undefined ? {} : { keyReleaseOptIn }),
    ...(fulfillmentEnabled === undefined ? {} : { fulfillmentEnabled }),
  };
}

function parseStage(raw: string, accountId: string, requestId: string): FulfillmentStage {
  const value = JSON.parse(raw) as unknown;
  if (
    !plain(value)
    || !exactKeys(value, [
      "version",
      "accountId",
      "requestId",
      "requestDigest",
      "targetDeviceId",
      "accountEpoch",
      "mkWrapDevice",
      "signedRoster",
      "rosterVersion",
      "stagedAt",
    ])
    || value.version !== 1
    || value.accountId !== accountId
    || value.requestId !== requestId
    || typeof value.requestDigest !== "string" || !HASH_RE.test(value.requestDigest)
    || typeof value.targetDeviceId !== "string" || value.targetDeviceId.length === 0
    || !safeInteger(value.accountEpoch)
    || typeof value.mkWrapDevice !== "string" || value.mkWrapDevice.length === 0
    || typeof value.signedRoster !== "string" || value.signedRoster.length === 0
    || !safeInteger(value.rosterVersion)
    || !safeInteger(value.stagedAt)
  ) {
    throw new Error("invalid key-delivery fulfillment journal");
  }
  return value as unknown as FulfillmentStage;
}

async function loadStage(accountId: string, request: ValidatedRequest): Promise<FulfillmentStage | undefined> {
  const raw = await readBoundedRegular(keyDeliveryJournalPath(accountId, request.requestId), JOURNAL_MAX_BYTES);
  if (raw === undefined) return undefined;
  const stage = parseStage(raw, accountId, request.requestId);
  if (
    stage.requestDigest !== await requestDigest(request)
    || stage.targetDeviceId !== request.targetDeviceId
    || stage.accountEpoch !== request.accountEpoch
  ) {
    throw new KeyDeliveryValidationError("staged key-delivery material does not match the fetched request");
  }
  const wrap = JSON.parse(stage.mkWrapDevice) as Wrap;
  assertDeviceWrapBinding(wrap, request, accountId);
  const roster = JSON.parse(stage.signedRoster) as SignedRoster;
  const body = JSON.parse(roster.body) as { version?: unknown; devices?: unknown };
  if (body.version !== stage.rosterVersion || !Array.isArray(body.devices)) {
    throw new KeyDeliveryValidationError("staged key-delivery roster is malformed");
  }
  const entry = body.devices.find((candidate) =>
    plain(candidate) && candidate.deviceId === request.targetDeviceId
  ) as Record<string, unknown> | undefined;
  if (
    !entry
    || entry.encPubKey !== request.encPubKey
    || entry.sigPubKey !== request.sigPubKey
    || entry.mkWrapHash !== await wrapHash(wrap)
  ) {
    throw new KeyDeliveryValidationError("staged key-delivery wrap does not match its signed roster entry");
  }
  return stage;
}

async function persistStage(stage: FulfillmentStage): Promise<void> {
  const raw = canonicalString(stage);
  parseStage(raw, stage.accountId, stage.requestId);
  await hardenedWrite(keyDeliveryJournalPath(stage.accountId, stage.requestId), raw);
}

async function removeStage(accountId: string, requestId: string): Promise<void> {
  const file = keyDeliveryJournalPath(accountId, requestId);
  try {
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeAllStages(accountId: string): Promise<void> {
  assertAccountId(accountId);
  const directory = path.join(e2eeRoot(), accountId, "key-delivery");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/.test(entry.name))
    .map((entry) => fs.unlink(path.join(directory, entry.name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    })));
}

function assertPinExtension(account: VerifiedAccount, pin: HeadPin | undefined): void {
  if (!pin) return;
  if (
    account.rosterHashByVersion.get(pin.rosterVersion) !== pin.rosterHash
    || account.keyStateHashByEpoch.get(pin.accountEpoch) !== pin.keyStateHash
    || account.currentEpoch < pin.accountEpoch
  ) {
    throw new KeyDeliveryValidationError("account key rollback detected while fulfilling key delivery");
  }
}

async function verifySnapshot(
  dto: AccountKeysDTO | null,
  accountId: string,
  source: DeviceSecrets,
  pin: HeadPin | undefined,
): Promise<VerifiedSnapshot> {
  if (!dto) throw new KeyDeliveryValidationError("account key material disappeared during key delivery");
  let rosters: SignedRoster[];
  let keyStates: SignedKeyState[];
  try {
    rosters = dto.rosters.map((raw) => JSON.parse(raw) as SignedRoster);
    keyStates = dto.keyStates.map((raw) => JSON.parse(raw) as SignedKeyState);
  } catch {
    throw new KeyDeliveryValidationError("malformed account key material during key delivery");
  }
  const account = await verifyAccount(rosters, keyStates);
  if (account.currentRoster.accountId !== accountId) {
    throw new KeyDeliveryValidationError("key-delivery account binding mismatch");
  }
  assertPinExtension(account, pin);
  const sourceEntry = account.currentRoster.devices.find((entry) => entry.deviceId === source.deviceId);
  if (
    !sourceEntry
    || sourceEntry.status !== "active"
    || sourceEntry.kind !== "device"
    || sourceEntry.sigPubKey !== toB64url(source.sigPubKey)
    || sourceEntry.encPubKey !== toB64url(source.encPubSpki)
  ) {
    throw new KeyDeliveryValidationError("fulfilling daemon is not an active bound source device");
  }
  return { dto, account };
}

async function adoptedSubmission(
  snapshot: VerifiedSnapshot,
  request: ValidatedRequest,
  accountId: string,
): Promise<KeyDeliverySubmitBody | undefined> {
  const historical = snapshot.account.rosters.flatMap((roster) =>
    roster.devices.filter((entry) => entry.deviceId === request.targetDeviceId)
  );
  const current = snapshot.account.currentRoster.devices.find((entry) => entry.deviceId === request.targetDeviceId);
  const row = snapshot.dto.devices.find((candidate) => candidate.deviceId === request.targetDeviceId);
  if (!current) {
    if (historical.length > 0) {
      throw new KeyDeliveryValidationError("key-delivery target was previously admitted or revoked");
    }
    if (row) throw new KeyDeliveryValidationError("key-delivery target has a device row without a roster entry");
    for (const entry of snapshot.account.currentRoster.devices) {
      if (
        entry.deviceId !== request.targetDeviceId
        && (entry.encPubKey === request.encPubKey || entry.sigPubKey === request.sigPubKey)
      ) {
        throw new KeyDeliveryValidationError("key-delivery public keys are already bound to another roster device");
      }
    }
    return undefined;
  }
  if (current.status !== "active" || current.kind !== "device") {
    throw new KeyDeliveryValidationError("key-delivery target is revoked");
  }
  if (
    current.encPubKey !== request.encPubKey
    || current.sigPubKey !== request.sigPubKey
    || !current.mkWrapHash
    || !row
    || row.encPubkey !== request.encPubKey
    || row.sigPubkey !== request.sigPubKey
    || typeof row.mkWrap !== "string"
  ) {
    throw new KeyDeliveryValidationError("committed key-delivery target binding is inconsistent");
  }
  let wrap: Wrap;
  try {
    wrap = JSON.parse(row.mkWrap) as Wrap;
  } catch {
    throw new KeyDeliveryValidationError("committed key-delivery wrap is malformed");
  }
  assertDeviceWrapBinding(wrap, request, accountId);
  if (await wrapHash(wrap) !== current.mkWrapHash) {
    throw new KeyDeliveryValidationError("committed key-delivery wrap does not match the roster commitment");
  }
  return {
    requestId: request.requestId,
    mkWrapDevice: row.mkWrap,
    publishedRosterVersion: snapshot.account.currentRoster.version,
    accountEpoch: request.accountEpoch,
  };
}

function assertDeviceWrapBinding(wrap: Wrap, request: ValidatedRequest, accountId: string): asserts wrap is RsaWrap {
  if (
    !plain(wrap)
    || !exactKeys(wrap, ["v", "kind", "alg", "recipientKeyHash", "ct", "ctx"])
    || wrap.v !== 1
    || wrap.kind !== "rsa-oaep-wrap"
    || wrap.alg !== "RSA-OAEP-3072-SHA256"
    || wrap.recipientKeyHash !== request.encPubKeyHash
    || !plain(wrap.ctx)
    || !exactKeys(wrap.ctx, ["accountId", "accountEpoch", "wrappedKeyKind", "purpose", "recipientKeyHash"])
    || wrap.ctx.accountId !== accountId
    || wrap.ctx.accountEpoch !== request.accountEpoch
    || wrap.ctx.wrappedKeyKind !== "MK"
    || wrap.ctx.purpose !== "rbox/mk-wrap/device/v1"
    || wrap.ctx.recipientKeyHash !== request.encPubKeyHash
  ) {
    throw new KeyDeliveryValidationError("key-delivery wrap has the wrong persisted device context");
  }
  const ciphertext = decodeCanonicalBase64url(wrap.ct);
  if (ciphertext.byteLength !== 384) {
    throw new KeyDeliveryValidationError("key-delivery wrap has invalid RSA ciphertext length");
  }
}

async function buildStage(
  accountId: string,
  request: ValidatedRequest,
  source: DeviceSecrets,
  account: VerifiedAccount,
  wrapDevice: NonNullable<KeyDeliveryFulfillmentHooks["wrapDevice"]>,
  now: number,
  prior?: FulfillmentStage,
): Promise<FulfillmentStage> {
  const mkWrapDevice = prior?.mkWrapDevice ?? JSON.stringify(await wrapDevice(
    request.encPubKeyBytes,
    source.mk,
    {
      accountId,
      accountEpoch: request.accountEpoch,
      wrappedKeyKind: "MK",
      purpose: "rbox/mk-wrap/device/v1",
    },
  ));
  const wrap = JSON.parse(mkWrapDevice) as Wrap;
  assertDeviceWrapBinding(wrap, request, accountId);
  const targetEntry = {
    deviceId: request.targetDeviceId,
    sigAlg: "Ed25519" as const,
    encAlg: "RSA-OAEP-3072-SHA256" as const,
    sigPubKey: request.sigPubKey,
    encPubKey: request.encPubKey,
    role: "admin" as const,
    kind: "device" as const,
    addedAt: request.approvedAt,
    status: "active" as const,
    mkWrapHash: await wrapHash(wrap),
  };
  const signed = await buildAdminRoster(
    account.currentRoster,
    [...account.currentRoster.devices, targetEntry],
    source.deviceId,
    {
      publicKey: source.sigPubKey,
      privateKey: signPrivateFromPkcs8(source.sigPrivPkcs8),
    },
  );
  return {
    version: 1,
    accountId,
    requestId: request.requestId,
    requestDigest: await requestDigest(request),
    targetDeviceId: request.targetDeviceId,
    accountEpoch: request.accountEpoch,
    mkWrapDevice,
    signedRoster: JSON.stringify(signed),
    rosterVersion: account.currentRoster.version + 1,
    stagedAt: now,
  };
}

function stageExtends(stage: FulfillmentStage, account: VerifiedAccount): boolean {
  try {
    const roster = JSON.parse(stage.signedRoster) as SignedRoster;
    const body = JSON.parse(roster.body) as { version?: unknown; prevRosterHash?: unknown };
    return body.version === account.currentRoster.version + 1
      && body.prevRosterHash === account.currentRosterHash;
  } catch {
    return false;
  }
}

async function verifyStageForPublish(
  snapshot: VerifiedSnapshot,
  stage: FulfillmentStage,
  request: ValidatedRequest,
): Promise<void> {
  let candidate: SignedRoster;
  try {
    candidate = JSON.parse(stage.signedRoster) as SignedRoster;
    const verified = await verifyAccount(
      [...snapshot.dto.rosters.map((raw) => JSON.parse(raw) as SignedRoster), candidate],
      snapshot.dto.keyStates.map((raw) => JSON.parse(raw) as SignedKeyState),
    );
    const target = verified.currentRoster.devices.find((entry) => entry.deviceId === request.targetDeviceId);
    if (
      verified.currentRoster.version !== stage.rosterVersion
      || verified.currentEpoch !== request.accountEpoch
      || verified.currentRoster.accountEpoch !== request.accountEpoch
      || !target
      || target.status !== "active"
      || target.encPubKey !== request.encPubKey
      || target.sigPubKey !== request.sigPubKey
      || target.mkWrapHash !== await wrapHash(JSON.parse(stage.mkWrapDevice) as Wrap)
    ) {
      throw new Error("candidate binding mismatch");
    }
  } catch {
    throw new KeyDeliveryValidationError("staged key-delivery roster failed full chain verification");
  }
}

function parseSubmitSuccess(value: unknown, requestId: string): void {
  if (!plain(value)) throw new KeyDeliveryValidationError("malformed key-delivery submit response");
  const valid = exactKeys(value, ["ok", "requestId"])
    || exactKeys(value, ["ok", "requestId", "alreadyFulfilled"]);
  if (
    !valid
    || value.ok !== true
    || value.requestId !== requestId
    || (Object.hasOwn(value, "alreadyFulfilled") && value.alreadyFulfilled !== true)
  ) {
    throw new KeyDeliveryValidationError("malformed key-delivery submit response");
  }
}

async function responseJson(response: Response, operation: string): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new KeyDeliveryHttpError(response.status, undefined, `${operation} returned malformed JSON`);
  }
  if (response.ok) return body;
  const code = plain(body) && typeof body.error === "string" ? body.error : undefined;
  throw new KeyDeliveryHttpError(response.status, code, `${operation} failed (${response.status}${code ? ` ${code}` : ""})`);
}

export function rboxKeyDeliveryApi(api: RboxApi): KeyDeliveryFulfillmentApi {
  return {
    fetch: async (body, signal) => responseJson(
      await api.postJson("/v1/auth/key-delivery/fetch", body, {
        signal,
      }),
      "key-delivery fetch",
    ),
    getAccountKeys: (signal) => api.getAccountKeys(signal),
    publish: (body, signal) => api.admitDevice(body, signal),
    submit: async (body, signal) => responseJson(
      await api.postJson("/v1/auth/key-delivery/submit", body, {
        signal,
      }),
      "key-delivery submit",
    ),
  };
}

export interface KeyDeliveryFulfillmentOptions {
  accountId: string;
  deviceId: string;
  workspaceId: string;
  pullOnly: boolean;
  api: KeyDeliveryFulfillmentApi;
  log: (message: string) => void;
  timeoutMs?: number;
  retryBudget?: number;
  preferenceOverride?: KeyDeliveryPreferenceOverride;
  hooks?: KeyDeliveryFulfillmentHooks;
}

export class KeyDeliveryFulfillmentFlight implements KeyDeliveryFlightPort {
  private readonly pending = new Set<string>();
  private pollPending = false;
  private running?: Promise<void>;
  private stopped = false;
  private activeController: AbortController | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly wrapDevice: NonNullable<KeyDeliveryFulfillmentHooks["wrapDevice"]>;
  private readonly loadLocalDevice: NonNullable<KeyDeliveryFulfillmentHooks["loadDevice"]>;
  private readonly loadLocalPin: NonNullable<KeyDeliveryFulfillmentHooks["loadPin"]>;
  private readonly loadPreference: NonNullable<KeyDeliveryFulfillmentHooks["loadPreference"]>;
  private readonly savePreference: NonNullable<KeyDeliveryFulfillmentHooks["savePreference"]>;

  constructor(private readonly options: KeyDeliveryFulfillmentOptions) {
    assertAccountId(options.accountId);
    this.now = options.hooks?.now ?? Date.now;
    this.random = options.hooks?.random ?? Math.random;
    this.sleep = options.hooks?.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }).then(() => undefined));
    this.wrapDevice = options.hooks?.wrapDevice ?? rsaDeviceWrap;
    this.loadLocalDevice = options.hooks?.loadDevice ?? loadDevice;
    this.loadLocalPin = options.hooks?.loadPin ?? loadPin;
    this.loadPreference = options.hooks?.loadPreference ?? loadKeyDeliveryDaemonPreference;
    this.savePreference = options.hooks?.savePreference ?? saveKeyDeliveryDaemonPreference;
  }

  enqueue(requestId?: string): void {
    if (this.stopped) return;
    if (requestId === undefined) this.pollPending = true;
    else if (REQUEST_ID_RE.test(requestId)) {
      if (this.pending.size < MAX_PENDING_NUDGES) this.pending.add(requestId);
      else this.pollPending = true;
    } else return;
    if (!this.running) {
      const run = this.runQueue();
      const wrapped = run.finally(() => {
        if (this.running === wrapped) this.running = undefined;
        if (!this.stopped && (this.pollPending || this.pending.size > 0)) this.enqueue();
      });
      this.running = wrapped;
    }
  }

  private next(): string | undefined | null {
    const first = this.pending.values().next();
    if (!first.done) {
      this.pending.delete(first.value);
      return first.value;
    }
    if (this.pollPending) {
      this.pollPending = false;
      return undefined;
    }
    return null;
  }

  private async runQueue(): Promise<void> {
    while (!this.stopped) {
      const requestId = this.next();
      if (requestId === null) return;
      try {
        await this.runBounded(requestId);
      } catch (error) {
        this.options.log(`key delivery fulfillment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async runBounded(requestId: string | undefined): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error("key-delivery fulfillment flight timed out")),
      this.options.timeoutMs ?? DEFAULT_FLIGHT_TIMEOUT_MS,
    );
    timeout.unref?.();
    try {
      await this.runWithRetries(requestId, controller.signal);
    } finally {
      clearTimeout(timeout);
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private async runWithRetries(requestId: string | undefined, signal: AbortSignal): Promise<void> {
    const retryBudget = this.options.retryBudget ?? DEFAULT_RETRY_BUDGET;
    for (let attempt = 0; attempt <= retryBudget; attempt++) {
      signal.throwIfAborted();
      try {
        const done = await this.attempt(requestId, signal);
        if (done) return;
      } catch (error) {
        if (
          error instanceof KeyDeliveryValidationError
          || error instanceof KeyDeliveryBoundaryCrash
          || (error instanceof KeyDeliveryHttpError && (
            error.status === 400
            || error.status === 401
            || error.status === 403
            || error.status === 404
            || error.status === 410
            || error.code === "already_fulfilled"
          ))
        ) {
          throw error;
        }
        if (attempt === retryBudget) throw error;
      }
      if (attempt === retryBudget) break;
      const backoff = Math.floor((150 * 2 ** attempt) * (0.75 + this.random() * 0.5));
      await this.sleep(backoff, signal);
    }
  }

  private async boundary(boundary: FulfillmentBoundary): Promise<void> {
    if (!this.options.hooks?.onBoundary) return;
    try {
      await this.options.hooks.onBoundary(boundary);
    } catch (error) {
      throw new KeyDeliveryBoundaryCrash(boundary, error);
    }
  }

  private async releasePreference(): Promise<boolean> {
    try {
      const preference = await this.loadPreference(
        this.options.accountId,
        this.options.deviceId,
        this.options.pullOnly,
      );
      const override = this.options.preferenceOverride;
      const effective = override ? {
        ...preference,
        ...(override.keyReleaseOptIn === undefined ? {} : { keyReleaseOptIn: override.keyReleaseOptIn }),
        ...(override.fulfillmentEnabled === undefined ? {} : { fulfillmentEnabled: override.fulfillmentEnabled }),
      } : preference;
      if (
        effective.keyReleaseOptIn !== preference.keyReleaseOptIn
        || effective.fulfillmentEnabled !== preference.fulfillmentEnabled
      ) {
        await this.savePreference(effective);
      }
      return effective.fulfillmentEnabled && effective.keyReleaseOptIn;
    } catch (error) {
      this.options.log(`key delivery preference unavailable; release disabled: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async snapshot(source: DeviceSecrets, signal: AbortSignal): Promise<VerifiedSnapshot> {
    const [dto, pin] = await Promise.all([
      this.options.api.getAccountKeys(signal),
      this.loadLocalPin(this.options.accountId, this.options.workspaceId),
    ]);
    return verifySnapshot(dto, this.options.accountId, source, pin);
  }

  private async submit(body: KeyDeliverySubmitBody, signal: AbortSignal): Promise<"done" | "retry"> {
    try {
      parseSubmitSuccess(await this.options.api.submit(body, signal), body.requestId);
      await this.boundary("after-submit");
      await removeStage(this.options.accountId, body.requestId);
      return "done";
    } catch (error) {
      if (error instanceof KeyDeliveryHttpError && error.status === 409) {
        if (error.code === "already_fulfilled") {
          await removeStage(this.options.accountId, body.requestId);
          return "done";
        }
        if (error.code === "publish_not_current") return "retry";
      }
      throw error;
    }
  }

  private async attempt(requestId: string | undefined, signal: AbortSignal): Promise<boolean> {
    const keyReleaseOptIn = await this.releasePreference();
    const fetched = await this.options.api.fetch({
      ...(requestId === undefined ? {} : { requestId }),
      keyReleaseOptIn,
    }, signal);
    const optedOutDenial = plain(fetched)
      && exactKeys(fetched, ["request", "keyReleaseEnabled"])
      && fetched.request === null
      && fetched.keyReleaseEnabled === false;
    const request = await validateKeyDeliveryFetchResponse(fetched, requestId, this.now());
    if (!request) {
      if (!optedOutDenial) {
        if (requestId === undefined) await removeAllStages(this.options.accountId);
        else await removeStage(this.options.accountId, requestId);
      }
      return true;
    }
    if (!keyReleaseOptIn) {
      throw new KeyDeliveryValidationError("server returned key-delivery work while this daemon is opted out");
    }

    const loaded = await this.loadLocalDevice(this.options.accountId);
    if (!loaded || !("secrets" in loaded)) {
      throw new KeyDeliveryValidationError("fulfilling daemon has no complete local account key state");
    }
    const source = loaded.secrets;
    if (source.deviceId !== this.options.deviceId) {
      throw new KeyDeliveryValidationError("daemon credential and local E2EE device identities differ");
    }

    let snapshot = await this.snapshot(source, signal);
    if (
      snapshot.account.currentEpoch !== request.accountEpoch
      || snapshot.account.currentRoster.accountEpoch !== request.accountEpoch
    ) {
      throw new KeyDeliveryValidationError("key-delivery account epoch is stale");
    }
    const adopted = await adoptedSubmission(snapshot, request, this.options.accountId);
    if (adopted) return (await this.submit(adopted, signal)) === "done";

    let stage = await loadStage(this.options.accountId, request);
    if (!stage || !stageExtends(stage, snapshot.account)) {
      stage = await buildStage(
        this.options.accountId,
        request,
        source,
        snapshot.account,
        this.wrapDevice,
        this.now(),
        stage,
      );
      await persistStage(stage);
      await this.boundary("after-stage");
    }
    await verifyStageForPublish(snapshot, stage, request);

    const published = await this.options.api.publish({
      device: {
        deviceId: request.targetDeviceId,
        sigPubKey: request.sigPubKey,
        encPubKey: request.encPubKey,
        mkWrap: stage.mkWrapDevice,
      },
      roster: { version: stage.rosterVersion, signed: stage.signedRoster },
    }, signal);
    if (!published.ok && published.conflict) return false;
    if (!published.ok) throw new Error("key-delivery roster publish failed without a conflict");
    await this.boundary("after-publish");

    snapshot = await this.snapshot(source, signal);
    if (
      snapshot.account.currentEpoch !== request.accountEpoch
      || snapshot.account.currentRoster.accountEpoch !== request.accountEpoch
    ) {
      throw new KeyDeliveryValidationError("key-delivery account epoch changed after publish");
    }
    const committed = await adoptedSubmission(snapshot, request, this.options.accountId);
    if (!committed) throw new KeyDeliveryValidationError("published key-delivery device row is absent");
    return (await this.submit(committed, signal)) === "done";
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pending.clear();
    this.pollPending = false;
    // Cancel a hung-network flight immediately so `rbox stop`/`upgrade` don't
    // wait out the 45s flight timeout. A SIGKILL mid-flight is already crash-
    // safe (staged bytes are reused on restart), so aborting here corrupts
    // nothing — it just turns a stuck shutdown into an immediate one.
    this.activeController?.abort(new Error("key-delivery fulfillment flight stopped"));
    await this.running;
  }

  /** Test/diagnostic drain: wait until all work currently queued has settled. */
  async drain(): Promise<void> {
    await this.running;
  }
}

export function parseKeyDeliveryNudge(data: string): string | undefined {
  try {
    const value = JSON.parse(data) as unknown;
    if (
      !plain(value)
      || !exactKeys(value, ["type", "requestId"])
      || value.type !== "key-delivery"
      || typeof value.requestId !== "string"
      || !REQUEST_ID_RE.test(value.requestId)
    ) return undefined;
    return value.requestId;
  } catch {
    return undefined;
  }
}
