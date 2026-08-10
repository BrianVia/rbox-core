import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalString, fromB64url, parseStrict, rkToPhrase, sha256Hex, toB64url, utf8 } from "../engine/e2ee/index.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory } from "../engine/fsutil.js";
import type { JsonObject } from "../json.js";

export const GENESIS_ACCOUNT_ID_RE = /^acct_[0-9a-f]{16}$/;
export const GENESIS_REPAIR_ID_RE = /^gra_[0-9a-f]{32}$/;
export const GENESIS_REQUEST_SHA_RE = /^[0-9a-f]{64}$/;
export const GENESIS_MAX_JSON_BYTES = 4 * 1024 * 1024;
export const GENESIS_PENDING_MESSAGE = "encryption setup is still pending — run `rbox setup` to resume and finish saving your recovery phrase";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
let tempCounter = 0;

export const e2eeRoot = (): string => path.join(process.env.RBOX_HOME || os.homedir(), ".rbox", "e2ee");
export function genesisAccountRoot(accountId: string): string {
  assertGenesisAccountId(accountId);
  return path.join(e2eeRoot(), accountId);
}

export function assertGenesisAccountId(accountId: string): void {
  if (!GENESIS_ACCOUNT_ID_RE.test(accountId)) throw new Error(`malformed accountId: ${accountId}`);
}

export type HardenedWriteStep =
  | "ancestor-mkdir" | "ancestor-fsync" | "temp-create" | "temp-write" | "temp-fsync" | "temp-close"
  | "rename" | "read-back" | "published-file-fsync" | "parent-fsync";

export interface HardenedWriteOptions {
  mode?: number;
  /** Legacy pre-operation hook retained for existing callers. */
  onStep?: (step: HardenedWriteStep) => void | Promise<void>;
  /** Crash-test seam on both sides of every durability operation. */
  onBoundary?: (step: HardenedWriteStep, boundary: "before" | "after") => void | Promise<void>;
}

async function writeBoundary(options:HardenedWriteOptions,step:HardenedWriteStep,boundary:"before"|"after"):Promise<void>{
  await options.onBoundary?.(step,boundary);
  if(boundary==="before")await options.onStep?.(step);
}

async function regularOrAbsent(file: string): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe genesis target: ${file}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Full enrollment publication contract, including the post-rename durability suffix. */
export async function hardenedWrite(file: string, bytes: string | Uint8Array, options: HardenedWriteOptions = {}): Promise<void> {
  const data = typeof bytes === "string" ? utf8(bytes) : bytes;
  const dir = path.dirname(file);
  await writeBoundary(options,"ancestor-mkdir","before");
  const created = await ensureDirectoryChain(dir, "genesis directory");
  for (const createdDir of created) await fs.chmod(createdDir, DIR_MODE);
  await writeBoundary(options,"ancestor-mkdir","after");
  await writeBoundary(options,"ancestor-fsync","before");
  await fsyncCreatedDirectoryAncestors(dir, created);
  await writeBoundary(options,"ancestor-fsync","after");
  await regularOrAbsent(file);
  const tmp = path.join(dir, `.rbox-genesis-tmp-${process.pid}-${tempCounter++}-${path.basename(file)}`);
  let handle: fs.FileHandle | undefined;
  try {
    await writeBoundary(options,"temp-create","before");
    handle = await fs.open(tmp, "wx", options.mode ?? FILE_MODE);
    await writeBoundary(options,"temp-create","after");
    await writeBoundary(options,"temp-write","before");
    await handle.writeFile(data);
    await handle.chmod(options.mode ?? FILE_MODE);
    await writeBoundary(options,"temp-write","after");
    await writeBoundary(options,"temp-fsync","before");
    await handle.sync();
    await writeBoundary(options,"temp-fsync","after");
    await writeBoundary(options,"temp-close","before");
    await handle.close();
    handle = undefined;
    await writeBoundary(options,"temp-close","after");
    await writeBoundary(options,"rename","before");
    await fs.rename(tmp, file);
    await writeBoundary(options,"rename","after");
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  await writeBoundary(options,"read-back","before");
  const readBack = await fs.readFile(file);
  if (!Buffer.from(readBack).equals(Buffer.from(data))) throw new Error(`genesis exact read-back failed: ${path.basename(file)}`);
  await writeBoundary(options,"read-back","after");
  await writeBoundary(options,"published-file-fsync","before");
  const published = await fs.open(file, "r");
  try { await published.sync(); } finally { await published.close(); }
  await writeBoundary(options,"published-file-fsync","after");
  await writeBoundary(options,"parent-fsync","before");
  await fsyncDirectory(dir);
  await writeBoundary(options,"parent-fsync","after");
}

export async function hardenedUnlink(file: string): Promise<void> {
  try {
    await regularOrAbsent(file);
    await fs.unlink(file);
    await fsyncDirectory(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function hardenedRename(source: string, destination: string): Promise<void> {
  await regularOrAbsent(source);
  await regularOrAbsent(destination);
  const expected = await fs.readFile(source);
  await fs.rename(source, destination);
  const actual = await fs.readFile(destination);
  if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error(`genesis promotion exact read-back failed: ${path.basename(destination)}`);
  const target = await fs.open(destination, "r");
  try { await target.sync(); } finally { await target.close(); }
  await fsyncDirectory(path.dirname(destination));
  if (path.dirname(destination) !== path.dirname(source)) await fsyncDirectory(path.dirname(source));
}

/** Re-establish the durability suffix for an already-published exact survivor. */
export async function hardenedFsyncExisting(file:string):Promise<void>{
  await regularOrAbsent(file);const handle=await fs.open(file,"r");try{await handle.sync();}finally{await handle.close();}await fsyncDirectory(path.dirname(file));
}

export interface GenesisPrepublishMarker {
  version: 1;
  accountId: string;
  deviceId: string;
  repairId: string | null;
  startedAt: string;
  phase: "prepublish";
}

export type GenesisCompletionReceipt =
  | { outcome: "phrase-delivered" | "competing-cleaned"; at: string }
  | { outcome: "artifact-committed"; at: string; artifact: { mode: "keychain"; service: "rbox recovery phrase"; account: string; keychainPath: string } | { mode: "kit-path"; path: string } }
  | {
      outcome: "destination-set";
      at: string;
      intentSha256: string;
      completions: DestinationCompletion[];
      finalProgressSha256: string;
      continuedAfterPartial: boolean;
    };

export interface GenesisJournal {
  version: 1;
  accountId: string;
  deviceId: string;
  startedAt: string;
  phase: "active" | "cleanup";
  requestBody: string;
  requestSha256: string;
  originalCacheRecovery: boolean;
  completionHolds: ["recovery-kit-staging"];
  completionReceipts: { "recovery-kit-staging"?: GenesisCompletionReceipt };
}

export interface GenesisBootstrapRequest {
  recoveryWrap: string;
  recoveryWrapId: string;
  genesisRoster: string;
  genesisKeyState: string;
  device: { deviceId: string; sigPubKey: string; encPubKey: string; mkWrap: string };
  repairId?: string;
}

export type LegacyCompletionIntent =
  | { version: 1; accountId: string; requestSha256: string; mode: "phrase-display"; intentAt: string }
  | { version: 1; accountId: string; requestSha256: string; mode: "keychain"; keychain: { service: "rbox recovery phrase"; account: string; keychainPath: string }; intentAt: string }
  | { version: 1; accountId: string; requestSha256: string; mode: "kit-path"; path: string; intentAt: string };

export type RecoveryDestination =
  | { kind: "onepassword"; accountUuid: string; vaultUuid: string; operationTag: string; fieldId: "rboxRecoveryPhrase" }
  | { kind: "keychain"; service: "rbox recovery phrase"; account: string; keychainPath: string }
  | { kind: "kit-path"; path: string }
  | { kind: "clipboard" };

export interface DestinationSetCompletionIntent {
  version: 2;
  accountId: string;
  requestSha256: string;
  mode: "destination-set";
  destinations: RecoveryDestination[];
  successThreshold: 1;
  intentAt: string;
}

export type CompletionIntent = LegacyCompletionIntent | DestinationSetCompletionIntent;

export type DestinationCompletion =
  | { kind: "onepassword"; accountUuid: string; vaultUuid: string; operationTag: string; itemUuid: string; fieldId: "rboxRecoveryPhrase"; completedAt: string }
  | { kind: "keychain"; service: "rbox recovery phrase"; account: string; keychainPath: string; completedAt: string }
  | { kind: "kit-path"; path: string; completedAt: string }
  | { kind: "clipboard"; confirmedAt: string };

export type DestinationEvent =
  | { kind: "op-dispatch-prepared"; destinationIndex: number; attemptId: string; at: string }
  | { kind: "op-may-have-dispatched"; destinationIndex: number; attemptId: string; at: string }
  | { kind: "op-child-not-started"; destinationIndex: number; attemptId: string; reason: "spawn-enoent" | "spawn-eacces"; at: string }
  | { kind: "completed"; destinationIndex: number; completion: DestinationCompletion; at: string }
  | { kind: "invalidated"; destinationIndex: number; priorCompletionSha256: string; reason: "missing" | "mismatch"; at: string };

export interface DestinationProgress {
  version: 1;
  accountId: string;
  requestSha256: string;
  intentSha256: string;
  events: DestinationEvent[];
  updatedAt: string;
}

export interface LegacyCompletionIntentRetargetWitness {
  version: 1;
  accountId: string;
  requestSha256: string;
  oldIntent: LegacyCompletionIntent;
  oldIntentSha256: string;
  newIntent: LegacyCompletionIntent;
  newIntentSha256: string;
  witnessedAt: string;
}

export interface CarriedDestinationCompletion {
  oldDestinationIndex: number;
  newDestinationIndex: number;
  completionSha256: string;
}

export interface DestinationSetRetargetWitness {
  version: 2;
  accountId: string;
  requestSha256: string;
  oldIntent: DestinationSetCompletionIntent;
  oldIntentSha256: string;
  newIntent: DestinationSetCompletionIntent;
  newIntentSha256: string;
  oldProgress: DestinationProgress;
  oldProgressSha256: string;
  newProgress: DestinationProgress;
  newProgressSha256: string;
  carriedCompletions: CarriedDestinationCompletion[];
  witnessedAt: string;
}

export type CompletionIntentRetargetWitness = LegacyCompletionIntentRetargetWitness | DestinationSetRetargetWitness;

/** Durable local proof that the current device/MK bytes were verified against a
 * complete server enrollment. It is only a routing optimization: any parse or
 * byte-binding failure falls back to a fresh server consultation. */
export interface GenesisEnrollmentWitness {
  version: 1;
  accountId: string;
  deviceSha256: string;
  mkSha256: string;
  verifiedAt: string;
}

const exactKeys = (value: object, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const iso = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const plain = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

function parseBounded(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > GENESIS_MAX_JSON_BYTES) throw new Error("genesis artifact exceeds size bound");
  return parseStrict(raw);
}

const boundedOpaque = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 64 * 1024;

const DESTINATION_LIMIT = 4;
const DESTINATION_EVENT_LIMIT = 128;
const DESTINATION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const safeBoundedString = (value: unknown, maxBytes = 4096): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes && !/[\0-\x1f\x7f]/.test(value);
const safeAbsolutePath = (value: unknown): value is string =>
  safeBoundedString(value) && path.isAbsolute(value) && path.normalize(value) === value;
const digest = (value: string): Promise<string> => sha256Hex(utf8(value));

function parseRecoveryDestination(value: unknown, accountId: string): RecoveryDestination {
  if (!plain(value) || typeof value.kind !== "string") throw new Error("invalid recovery destination");
  if (value.kind === "onepassword") {
    if (!exactKeys(value, ["kind","accountUuid","vaultUuid","operationTag","fieldId"])
      || typeof value.accountUuid !== "string" || !DESTINATION_TOKEN_RE.test(value.accountUuid)
      || typeof value.vaultUuid !== "string" || !DESTINATION_TOKEN_RE.test(value.vaultUuid)
      || typeof value.operationTag !== "string" || !DESTINATION_TOKEN_RE.test(value.operationTag)
      || value.fieldId !== "rboxRecoveryPhrase") throw new Error("invalid 1Password destination");
    return value as unknown as RecoveryDestination;
  }
  if (value.kind === "keychain") {
    if (!exactKeys(value, ["kind","service","account","keychainPath"]) || value.service !== "rbox recovery phrase"
      || value.account !== accountId || !safeAbsolutePath(value.keychainPath)) throw new Error("invalid Keychain destination");
    return value as unknown as RecoveryDestination;
  }
  if (value.kind === "kit-path") {
    if (!exactKeys(value, ["kind","path"]) || !safeAbsolutePath(value.path)) throw new Error("invalid kit-path destination");
    return value as unknown as RecoveryDestination;
  }
  if (value.kind === "clipboard" && exactKeys(value, ["kind"])) return value as unknown as RecoveryDestination;
  throw new Error("invalid recovery destination");
}

function destinationIdentity(destination: RecoveryDestination): string {
  if (destination.kind === "onepassword") return `onepassword:${destination.accountUuid}:${destination.vaultUuid}:${destination.operationTag}`;
  if (destination.kind === "keychain") return `keychain:${destination.service}:${destination.account}:${destination.keychainPath}`;
  if (destination.kind === "kit-path") return `kit-path:${destination.path}`;
  return "clipboard";
}

const destinationRank = (destination: RecoveryDestination): number =>
  destination.kind === "onepassword" ? 0 : destination.kind === "keychain" ? 1 : destination.kind === "kit-path" ? 2 : 3;

function parseDestinationCompletion(value: unknown, destination?: RecoveryDestination): DestinationCompletion {
  if (!plain(value) || typeof value.kind !== "string") throw new Error("invalid destination completion");
  let parsed: DestinationCompletion;
  if (value.kind === "onepassword") {
    if (!exactKeys(value, ["kind","accountUuid","vaultUuid","operationTag","itemUuid","fieldId","completedAt"])
      || typeof value.accountUuid !== "string" || !DESTINATION_TOKEN_RE.test(value.accountUuid)
      || typeof value.vaultUuid !== "string" || !DESTINATION_TOKEN_RE.test(value.vaultUuid)
      || typeof value.operationTag !== "string" || !DESTINATION_TOKEN_RE.test(value.operationTag)
      || typeof value.itemUuid !== "string" || !DESTINATION_TOKEN_RE.test(value.itemUuid)
      || value.fieldId !== "rboxRecoveryPhrase" || !iso(value.completedAt)) throw new Error("invalid 1Password completion");
    parsed = value as unknown as DestinationCompletion;
  } else if (value.kind === "keychain") {
    if (!exactKeys(value, ["kind","service","account","keychainPath","completedAt"]) || value.service !== "rbox recovery phrase"
      || typeof value.account !== "string" || !GENESIS_ACCOUNT_ID_RE.test(value.account)
      || !safeAbsolutePath(value.keychainPath) || !iso(value.completedAt)) throw new Error("invalid Keychain completion");
    parsed = value as unknown as DestinationCompletion;
  } else if (value.kind === "kit-path") {
    if (!exactKeys(value, ["kind","path","completedAt"]) || !safeAbsolutePath(value.path) || !iso(value.completedAt)) throw new Error("invalid kit-path completion");
    parsed = value as unknown as DestinationCompletion;
  } else if (value.kind === "clipboard") {
    if (!exactKeys(value, ["kind","confirmedAt"]) || !iso(value.confirmedAt)) throw new Error("invalid clipboard completion");
    parsed = value as unknown as DestinationCompletion;
  } else throw new Error("invalid destination completion");
  if (destination && !completionMatchesDestination(parsed, destination)) throw new Error("destination completion does not match selected target");
  return parsed;
}

function completionMatchesDestination(completion: DestinationCompletion, destination: RecoveryDestination): boolean {
  if (completion.kind !== destination.kind) return false;
  if (completion.kind === "onepassword" && destination.kind === "onepassword") {
    return completion.accountUuid === destination.accountUuid && completion.vaultUuid === destination.vaultUuid
      && completion.operationTag === destination.operationTag && completion.fieldId === destination.fieldId;
  }
  if (completion.kind === "keychain" && destination.kind === "keychain") {
    return completion.service === destination.service && completion.account === destination.account && completion.keychainPath === destination.keychainPath;
  }
  if (completion.kind === "kit-path" && destination.kind === "kit-path") return completion.path === destination.path;
  return completion.kind === "clipboard" && destination.kind === "clipboard";
}

function parseDestinationEvent(value: unknown, intent: DestinationSetCompletionIntent): DestinationEvent {
  if (!plain(value) || typeof value.kind !== "string" || !Number.isInteger(value.destinationIndex)
    || (value.destinationIndex as number) < 0 || (value.destinationIndex as number) >= intent.destinations.length || !iso(value.at)) {
    throw new Error("invalid destination event");
  }
  const index = value.destinationIndex as number;
  if (value.kind === "op-dispatch-prepared" || value.kind === "op-may-have-dispatched") {
    if (!exactKeys(value, ["kind","destinationIndex","attemptId","at"]) || intent.destinations[index]?.kind !== "onepassword"
      || typeof value.attemptId !== "string" || !DESTINATION_TOKEN_RE.test(value.attemptId)) throw new Error("invalid 1Password dispatch event");
    return value as unknown as DestinationEvent;
  }
  if (value.kind === "op-child-not-started") {
    if (!exactKeys(value, ["kind","destinationIndex","attemptId","reason","at"]) || intent.destinations[index]?.kind !== "onepassword"
      || typeof value.attemptId !== "string" || !DESTINATION_TOKEN_RE.test(value.attemptId)
      || (value.reason !== "spawn-enoent" && value.reason !== "spawn-eacces")) throw new Error("invalid 1Password child event");
    return value as unknown as DestinationEvent;
  }
  if (value.kind === "completed") {
    if (!exactKeys(value, ["kind","destinationIndex","completion","at"])) throw new Error("invalid completed event");
    // The completion carries its own authoritative timestamp; the event's `at`
    // only drives the append-order/monotonicity fold. We deliberately do NOT
    // require completion.completedAt === at — that equality added no integrity
    // (the completion is embedded in and bound to the event) and manufactured a
    // hard failure whenever a durable write between capturing the two crossed a
    // millisecond boundary during first-run setup.
    const completion=parseDestinationCompletion(value.completion,intent.destinations[index]);
    return { kind: "completed", destinationIndex: index, completion, at: value.at as string };
  }
  if (value.kind === "invalidated") {
    if (!exactKeys(value, ["kind","destinationIndex","priorCompletionSha256","reason","at"])
      || typeof value.priorCompletionSha256 !== "string" || !GENESIS_REQUEST_SHA_RE.test(value.priorCompletionSha256)
      || (value.reason !== "missing" && value.reason !== "mismatch")) throw new Error("invalid invalidation event");
    return value as unknown as DestinationEvent;
  }
  throw new Error("invalid destination event");
}

/** Strict client-side copy of the bootstrap wire schema. Journals are authority to
 * replay exact bytes, so a digest-valid but malformed body must never be replayed. */
export function parseGenesisBootstrapRequest(raw: string, deviceId?: string): GenesisBootstrapRequest {
  const v = parseBounded(raw);
  if (!plain(v) || (!exactKeys(v, ["recoveryWrap", "recoveryWrapId", "genesisRoster", "genesisKeyState", "device"])
    && !exactKeys(v, ["recoveryWrap", "recoveryWrapId", "genesisRoster", "genesisKeyState", "device", "repairId"]))) {
    throw new Error("invalid genesis bootstrap request shape");
  }
  if (!boundedOpaque(v.recoveryWrap) || !boundedOpaque(v.recoveryWrapId)
    || !boundedOpaque(v.genesisRoster) || !boundedOpaque(v.genesisKeyState)
    || !plain(v.device) || !exactKeys(v.device, ["deviceId", "sigPubKey", "encPubKey", "mkWrap"])
    || !boundedOpaque(v.device.deviceId) || (deviceId !== undefined && v.device.deviceId !== deviceId)
    || !boundedOpaque(v.device.sigPubKey) || !boundedOpaque(v.device.encPubKey) || !boundedOpaque(v.device.mkWrap)) {
    throw new Error("invalid genesis bootstrap request fields");
  }
  if (Object.hasOwn(v, "repairId") && (typeof v.repairId !== "string" || !GENESIS_REPAIR_ID_RE.test(v.repairId))) {
    throw new Error("invalid genesis bootstrap repair binding");
  }
  return v as unknown as GenesisBootstrapRequest;
}

export function parsePrepublishMarker(raw: string, accountId?: string): GenesisPrepublishMarker {
  const v = parseBounded(raw);
  if (!plain(v) || !exactKeys(v, ["version","accountId","deviceId","repairId","startedAt","phase"]) || v.version !== 1
    || typeof v.accountId !== "string" || !GENESIS_ACCOUNT_ID_RE.test(v.accountId) || (accountId !== undefined && v.accountId !== accountId)
    || typeof v.deviceId !== "string" || !v.deviceId || !iso(v.startedAt) || v.phase !== "prepublish"
    || !(v.repairId === null || (typeof v.repairId === "string" && GENESIS_REPAIR_ID_RE.test(v.repairId)))) throw new Error("invalid genesis prepublish marker");
  return v as unknown as GenesisPrepublishMarker;
}

export function parseGenesisEnrollmentWitness(raw:string,accountId?:string):GenesisEnrollmentWitness{
  const v=parseBounded(raw);
  if(!plain(v)||!exactKeys(v,["version","accountId","deviceSha256","mkSha256","verifiedAt"])||v.version!==1
    ||typeof v.accountId!=="string"||!GENESIS_ACCOUNT_ID_RE.test(v.accountId)||(accountId!==undefined&&v.accountId!==accountId)
    ||typeof v.deviceSha256!=="string"||!GENESIS_REQUEST_SHA_RE.test(v.deviceSha256)
    ||typeof v.mkSha256!=="string"||!GENESIS_REQUEST_SHA_RE.test(v.mkSha256)||!iso(v.verifiedAt))throw new Error("invalid genesis enrollment witness");
  return v as unknown as GenesisEnrollmentWitness;
}

export async function parseGenesisJournal(raw: string, accountId?: string): Promise<GenesisJournal> {
  const v = parseBounded(raw);
  if (!plain(v) || !exactKeys(v,["version","accountId","deviceId","startedAt","phase","requestBody","requestSha256","originalCacheRecovery","completionHolds","completionReceipts"])
    || v.version!==1 || typeof v.accountId!=="string" || !GENESIS_ACCOUNT_ID_RE.test(v.accountId) || (accountId!==undefined && v.accountId!==accountId)
    || typeof v.deviceId!=="string" || !v.deviceId || !iso(v.startedAt) || (v.phase!=="active"&&v.phase!=="cleanup")
    || typeof v.requestBody!=="string" || Buffer.byteLength(v.requestBody,"utf8")>GENESIS_MAX_JSON_BYTES
    || typeof v.requestSha256!=="string" || !GENESIS_REQUEST_SHA_RE.test(v.requestSha256) || await sha256Hex(utf8(v.requestBody))!==v.requestSha256
    || typeof v.originalCacheRecovery!=="boolean" || !Array.isArray(v.completionHolds) || v.completionHolds.length!==1 || v.completionHolds[0]!=="recovery-kit-staging"
    || !plain(v.completionReceipts) || !Object.keys(v.completionReceipts).every((k)=>k==="recovery-kit-staging")) throw new Error("invalid genesis journal");
  const receipt=v.completionReceipts["recovery-kit-staging"];
  if (receipt!==undefined) {
    if(!plain(receipt)||!iso(receipt.at))throw new Error("invalid genesis completion receipt");
    if(receipt.outcome==="phrase-delivered"||receipt.outcome==="competing-cleaned"){if(!exactKeys(receipt,["outcome","at"]))throw new Error("invalid genesis completion receipt");}
    else if(receipt.outcome==="artifact-committed"){
      if(!exactKeys(receipt,["outcome","at","artifact"])||!plain(receipt.artifact))throw new Error("invalid genesis artifact receipt");
      const artifact=receipt.artifact;if(artifact.mode==="kit-path"){if(!exactKeys(artifact,["mode","path"])||typeof artifact.path!=="string"||!path.isAbsolute(artifact.path))throw new Error("invalid genesis artifact receipt");}
      else if(artifact.mode==="keychain"){if(!exactKeys(artifact,["mode","service","account","keychainPath"])||artifact.service!=="rbox recovery phrase"||artifact.account!==v.accountId||typeof artifact.keychainPath!=="string"||!path.isAbsolute(artifact.keychainPath))throw new Error("invalid genesis artifact receipt");}
      else throw new Error("invalid genesis artifact receipt");
    }else if(receipt.outcome==="destination-set"){
      if(!exactKeys(receipt,["outcome","at","intentSha256","completions","finalProgressSha256","continuedAfterPartial"])
        ||typeof receipt.intentSha256!=="string"||!GENESIS_REQUEST_SHA_RE.test(receipt.intentSha256)
        ||typeof receipt.finalProgressSha256!=="string"||!GENESIS_REQUEST_SHA_RE.test(receipt.finalProgressSha256)
        ||typeof receipt.continuedAfterPartial!=="boolean"||!Array.isArray(receipt.completions)
        ||receipt.completions.length<1||receipt.completions.length>DESTINATION_LIMIT)throw new Error("invalid destination-set receipt");
      const completions=receipt.completions.map((completion)=>parseDestinationCompletion(completion));
      if(new Set(completions.map((completion)=>completion.kind)).size!==completions.length)throw new Error("duplicate destination-set receipt completion");
    }else throw new Error("invalid genesis completion receipt");
  }
  if ((v.phase==="active") !== (receipt===undefined)) throw new Error("genesis journal phase/receipt mismatch");
  parseGenesisBootstrapRequest(v.requestBody, v.deviceId);
  return v as unknown as GenesisJournal;
}

export function serializeCompletionIntent(intent: CompletionIntent): string { return canonicalString(intent); }

export function parseCompletionIntent(raw: string, journal: GenesisJournal): CompletionIntent {
  const v=parseBounded(raw);
  if (!plain(v)||v.accountId!==journal.accountId||v.requestSha256!==journal.requestSha256||!iso(v.intentAt)) throw new Error("invalid genesis completion intent binding");
  if (v.version===1 && v.mode==="phrase-display" && exactKeys(v,["version","accountId","requestSha256","mode","intentAt"])) return v as unknown as CompletionIntent;
  if (v.version===1 && v.mode==="kit-path" && exactKeys(v,["version","accountId","requestSha256","mode","path","intentAt"]) && safeAbsolutePath(v.path)) return v as unknown as CompletionIntent;
  if (v.version===1 && v.mode==="keychain" && exactKeys(v,["version","accountId","requestSha256","mode","keychain","intentAt"]) && plain(v.keychain)
    && exactKeys(v.keychain,["service","account","keychainPath"]) && v.keychain.service==="rbox recovery phrase" && typeof v.keychain.account==="string" && !!v.keychain.account
    && safeAbsolutePath(v.keychain.keychainPath)) return v as unknown as CompletionIntent;
  if (v.version===2 && v.mode==="destination-set" && exactKeys(v,["version","accountId","requestSha256","mode","destinations","successThreshold","intentAt"])
    && v.successThreshold===1 && Array.isArray(v.destinations) && v.destinations.length>=1 && v.destinations.length<=DESTINATION_LIMIT) {
    const destinations=v.destinations.map((destination)=>parseRecoveryDestination(destination,journal.accountId));
    const identities=destinations.map(destinationIdentity);
    if(new Set(identities).size!==identities.length)throw new Error("duplicate recovery destination");
    for(let index=1;index<destinations.length;index++)if(destinationRank(destinations[index-1]!)>=destinationRank(destinations[index]!))throw new Error("recovery destinations are not in canonical order");
    return {...v,destinations} as unknown as CompletionIntent;
  }
  throw new Error("invalid genesis completion intent shape");
}

export async function completionIntentSha256(intent:CompletionIntent):Promise<string>{
  return digest(serializeCompletionIntent(intent));
}

export interface FoldedDestinationState {
  completions: Array<DestinationCompletion | undefined>;
  attempts: Array<{ attemptId:string; state:"prepared"|"may-have-dispatched"|"child-not-started" } | undefined>;
}

export async function foldDestinationProgress(intent:DestinationSetCompletionIntent,events:readonly DestinationEvent[]):Promise<FoldedDestinationState>{
  const completions:Array<DestinationCompletion|undefined>=Array.from({length:intent.destinations.length});
  const attempts:Array<{attemptId:string;state:"prepared"|"may-have-dispatched"|"child-not-started"}|undefined>=Array.from({length:intent.destinations.length});
  const usedAttemptIds=new Set<string>();
  let previousAt="";
  for(const event of events){
    if(previousAt&&event.at<previousAt)throw new Error("destination event timestamps are not monotone");
    previousAt=event.at;
    const destination=intent.destinations[event.destinationIndex]!;
    if(event.kind==="op-dispatch-prepared"){
      const prior=attempts[event.destinationIndex];
      if(completions[event.destinationIndex]||prior&&prior.state!=="child-not-started"||usedAttemptIds.has(event.attemptId))throw new Error("invalid 1Password prepare transition");
      attempts[event.destinationIndex]={attemptId:event.attemptId,state:"prepared"};usedAttemptIds.add(event.attemptId);
    }else if(event.kind==="op-may-have-dispatched"){
      const prior=attempts[event.destinationIndex];
      if(!prior||prior.state!=="prepared"||prior.attemptId!==event.attemptId)throw new Error("invalid 1Password dispatch transition");
      attempts[event.destinationIndex]={attemptId:event.attemptId,state:"may-have-dispatched"};
    }else if(event.kind==="op-child-not-started"){
      const prior=attempts[event.destinationIndex];
      if(!prior||prior.state!=="may-have-dispatched"||prior.attemptId!==event.attemptId)throw new Error("invalid 1Password child-not-started transition");
      attempts[event.destinationIndex]={attemptId:event.attemptId,state:"child-not-started"};
    }else if(event.kind==="completed"){
      if(completions[event.destinationIndex])throw new Error("destination is already completed");
      if(destination.kind==="onepassword"){
        const prior=attempts[event.destinationIndex];
        if(!prior||prior.state!=="may-have-dispatched")throw new Error("1Password completion has no may-have-dispatched attempt");
      }
      completions[event.destinationIndex]=event.completion;
    }else{
      if(destination.kind==="clipboard")throw new Error("clipboard completion cannot be invalidated");
      const prior=completions[event.destinationIndex];
      if(!prior||await digest(canonicalString(prior))!==event.priorCompletionSha256)throw new Error("invalidation does not bind the current completion");
      completions[event.destinationIndex]=undefined;
    }
  }
  return{completions,attempts};
}

export async function parseDestinationProgress(raw:string,intent:DestinationSetCompletionIntent):Promise<DestinationProgress>{
  const v=parseBounded(raw);
  const expectedIntentSha=await completionIntentSha256(intent);
  if(!plain(v)||!exactKeys(v,["version","accountId","requestSha256","intentSha256","events","updatedAt"])||v.version!==1
    ||v.accountId!==intent.accountId||v.requestSha256!==intent.requestSha256||v.intentSha256!==expectedIntentSha
    ||!Array.isArray(v.events)||v.events.length>DESTINATION_EVENT_LIMIT||!iso(v.updatedAt))throw new Error("invalid destination progress");
  const events=v.events.map((event)=>parseDestinationEvent(event,intent));
  if(events.length>0&&events[events.length-1]!.at!==v.updatedAt)throw new Error("destination progress timestamp mismatch");
  await foldDestinationProgress(intent,events);
  return{version:1,accountId:intent.accountId,requestSha256:intent.requestSha256,intentSha256:expectedIntentSha,events,updatedAt:v.updatedAt as string};
}

export async function createDestinationProgress(intent:DestinationSetCompletionIntent,at=intent.intentAt):Promise<DestinationProgress>{
  const progress:DestinationProgress={version:1,accountId:intent.accountId,requestSha256:intent.requestSha256,intentSha256:await completionIntentSha256(intent),events:[],updatedAt:at};
  return parseDestinationProgress(canonicalString(progress),intent);
}

export async function parseRetargetWitness(raw:string,journal:GenesisJournal):Promise<CompletionIntentRetargetWitness>{
  const v=parseBounded(raw);
  if(!plain(v)||v.accountId!==journal.accountId||v.requestSha256!==journal.requestSha256||!iso(v.witnessedAt)||!plain(v.oldIntent)||!plain(v.newIntent))throw new Error("invalid completion RETARGET witness");
  const old=parseCompletionIntent(canonicalString(v.oldIntent),journal),next=parseCompletionIntent(canonicalString(v.newIntent),journal);
  if(v.version===1){
    if(!exactKeys(v,["version","accountId","requestSha256","oldIntent","oldIntentSha256","newIntent","newIntentSha256","witnessedAt"])
      ||old.version!==1||old.mode!=="keychain"||next.version!==1||next.mode!=="kit-path"
      ||typeof v.oldIntentSha256!=="string"||typeof v.newIntentSha256!=="string"
      ||await completionIntentSha256(old)!==v.oldIntentSha256||await completionIntentSha256(next)!==v.newIntentSha256)throw new Error("invalid completion RETARGET witness digests");
    return v as unknown as CompletionIntentRetargetWitness;
  }
  if(v.version!==2||!exactKeys(v,["version","accountId","requestSha256","oldIntent","oldIntentSha256","newIntent","newIntentSha256","oldProgress","oldProgressSha256","newProgress","newProgressSha256","carriedCompletions","witnessedAt"])
    ||old.version!==2||next.version!==2||!plain(v.oldProgress)||!plain(v.newProgress)||!Array.isArray(v.carriedCompletions)
    ||v.carriedCompletions.length>DESTINATION_LIMIT||typeof v.oldIntentSha256!=="string"||typeof v.newIntentSha256!=="string"
    ||typeof v.oldProgressSha256!=="string"||typeof v.newProgressSha256!=="string")throw new Error("invalid destination-set RETARGET witness");
  const oldProgress=await parseDestinationProgress(canonicalString(v.oldProgress),old);
  const newProgress=await parseDestinationProgress(canonicalString(v.newProgress),next);
  if(await completionIntentSha256(old)!==v.oldIntentSha256||await completionIntentSha256(next)!==v.newIntentSha256
    ||await digest(canonicalString(oldProgress))!==v.oldProgressSha256||await digest(canonicalString(newProgress))!==v.newProgressSha256)throw new Error("invalid destination-set RETARGET witness digests");
  const oldFold=await foldDestinationProgress(old,oldProgress.events),newFold=await foldDestinationProgress(next,newProgress.events);
  const carried:CarriedDestinationCompletion[]=[];
  const oldIndexes=new Set<number>(),newIndexes=new Set<number>();
  for(const rawMapping of v.carriedCompletions){
    if(!plain(rawMapping)||!exactKeys(rawMapping,["oldDestinationIndex","newDestinationIndex","completionSha256"])
      ||!Number.isInteger(rawMapping.oldDestinationIndex)||!Number.isInteger(rawMapping.newDestinationIndex)
      ||(rawMapping.oldDestinationIndex as number)<0||(rawMapping.oldDestinationIndex as number)>=old.destinations.length
      ||(rawMapping.newDestinationIndex as number)<0||(rawMapping.newDestinationIndex as number)>=next.destinations.length
      ||typeof rawMapping.completionSha256!=="string"||!GENESIS_REQUEST_SHA_RE.test(rawMapping.completionSha256))throw new Error("invalid carried destination completion");
    const mapping=rawMapping as unknown as CarriedDestinationCompletion;
    const oldCompletion=oldFold.completions[mapping.oldDestinationIndex],newCompletion=newFold.completions[mapping.newDestinationIndex];
    if(!oldCompletion||!newCompletion||canonicalString(oldCompletion)!==canonicalString(newCompletion)
      ||await digest(canonicalString(oldCompletion))!==mapping.completionSha256
      ||oldIndexes.has(mapping.oldDestinationIndex)||newIndexes.has(mapping.newDestinationIndex))throw new Error("carried destination completion mismatch");
    oldIndexes.add(mapping.oldDestinationIndex);newIndexes.add(mapping.newDestinationIndex);carried.push(mapping);
  }
  const newCompletedIndexes=newFold.completions.flatMap((completion,index)=>completion?[index]:[]);
  if(newCompletedIndexes.length!==carried.length||newCompletedIndexes.some((index)=>!newIndexes.has(index)))throw new Error("replacement progress contains an uncarried completion");
  return{...(v as unknown as DestinationSetRetargetWitness),oldIntent:old,newIntent:next,oldProgress,newProgress,carriedCompletions:carried};
}

export const genesisPaths=(accountId:string)=>{const dir=genesisAccountRoot(accountId);return{
  dir, marker:path.join(dir,"genesis-prepublish.json"), stagedRk:path.join(dir,"rk.key.staged"), journal:path.join(dir,"genesis-attempt.json"),
  intent:path.join(dir,"genesis-completion-intent.json"), progress:path.join(dir,"genesis-destination-progress.json"), witness:path.join(dir,"genesis-completion-intent.retarget.json"), enrolledWitness:path.join(dir,"genesis-enrolled.json"), device:path.join(dir,"device.json"), mk:path.join(dir,"mk.key"), rk:path.join(dir,"rk.key"), quarantine:path.join(dir,"quarantine"),
};};

async function enrollmentMaterialHashes(accountId:string):Promise<{deviceSha256:string;mkSha256:string}>{
  const paths=genesisPaths(accountId),[device,mk]=await Promise.all([fs.readFile(paths.device),fs.readFile(paths.mk)]);
  return{deviceSha256:await sha256Hex(new Uint8Array(device)),mkSha256:await sha256Hex(new Uint8Array(mk))};
}

export async function publishGenesisEnrollmentWitness(accountId:string,verifiedAt=new Date().toISOString(),options?:HardenedWriteOptions):Promise<GenesisEnrollmentWitness>{
  assertGenesisAccountId(accountId);const hashes=await enrollmentMaterialHashes(accountId);const witness:GenesisEnrollmentWitness={version:1,accountId,...hashes,verifiedAt};
  const raw=canonicalString(witness);parseGenesisEnrollmentWitness(raw,accountId);await hardenedWrite(genesisPaths(accountId).enrolledWitness,raw,options);return witness;
}

/** False includes absence, malformed bytes, unsafe file shape, missing material,
 * and content drift. Callers deliberately fail toward server consultation. */
export async function genesisEnrollmentWitnessMatches(accountId:string):Promise<boolean>{
  try{
    const file=genesisPaths(accountId).enrolledWitness,stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return false;
    const witness=parseGenesisEnrollmentWitness(await fs.readFile(file,"utf8"),accountId),hashes=await enrollmentMaterialHashes(accountId);
    return witness.deviceSha256===hashes.deviceSha256&&witness.mkSha256===hashes.mkSha256;
  }catch{return false;}
}

export async function genesisEnrollmentWitnessPresent(accountId:string):Promise<boolean>{
  try{await fs.lstat(genesisPaths(accountId).enrolledWitness);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;return true;}
}

export async function invalidateGenesisEnrollmentWitness(accountId:string):Promise<void>{assertGenesisAccountId(accountId);await hardenedUnlink(genesisPaths(accountId).enrolledWitness);}

export async function publishPrepublishMarker(marker:GenesisPrepublishMarker,options?:HardenedWriteOptions):Promise<void>{parsePrepublishMarker(canonicalString(marker),marker.accountId);await hardenedWrite(genesisPaths(marker.accountId).marker,canonicalString(marker),options);}
export async function stageRecoveryKey(accountId:string,rk:Uint8Array,options?:HardenedWriteOptions):Promise<void>{assertGenesisAccountId(accountId);if(rk.length!==32)throw new Error("staged recovery key must be 32 bytes");const encoded=toB64url(rk);const decoded=fromB64url(encoded);if(await rkToPhrase(decoded)!==await rkToPhrase(rk))throw new Error("staged recovery key round-trip failed");await hardenedWrite(genesisPaths(accountId).stagedRk,encoded,options);}
export async function loadStagedRecoveryKey(accountId:string):Promise<Uint8Array>{const raw=(await fs.readFile(genesisPaths(accountId).stagedRk,"utf8")).trim();const rk=fromB64url(raw);if(rk.length!==32)throw new Error("invalid staged recovery key");await rkToPhrase(rk);return rk;}
export async function publishGenesisJournal(journal:GenesisJournal,options?:HardenedWriteOptions):Promise<void>{await parseGenesisJournal(canonicalString(journal),journal.accountId);await hardenedWrite(genesisPaths(journal.accountId).journal,canonicalString(journal),options);}
export async function publishCompletionIntent(intent:CompletionIntent,journal:GenesisJournal,options?:HardenedWriteOptions):Promise<void>{const raw=serializeCompletionIntent(intent);parseCompletionIntent(raw,journal);await hardenedWrite(genesisPaths(intent.accountId).intent,raw,options);}
export async function publishRetargetWitness(witness:CompletionIntentRetargetWitness,journal:GenesisJournal,options?:HardenedWriteOptions):Promise<void>{const raw=canonicalString(witness);await parseRetargetWitness(raw,journal);await hardenedWrite(genesisPaths(witness.accountId).witness,raw,options);}
export async function publishDestinationProgress(intent:DestinationSetCompletionIntent,progress:DestinationProgress,options?:HardenedWriteOptions):Promise<void>{
  const raw=canonicalString(progress);await parseDestinationProgress(raw,intent);await hardenedWrite(genesisPaths(intent.accountId).progress,raw,options);
}
export async function loadDestinationProgress(intent:DestinationSetCompletionIntent):Promise<DestinationProgress>{
  return parseDestinationProgress(await fs.readFile(genesisPaths(intent.accountId).progress,"utf8"),intent);
}
export async function appendDestinationEvent(intent:DestinationSetCompletionIntent,current:DestinationProgress,event:DestinationEvent,options?:HardenedWriteOptions):Promise<DestinationProgress>{
  const paths=genesisPaths(intent.accountId),canonical=await fs.readFile(paths.progress,"utf8"),currentRaw=canonicalString(current);
  if(canonical!==currentRaw)throw new Error("destination progress is not the exact canonical record");
  await parseDestinationProgress(currentRaw,intent);
  if(current.events.length>=DESTINATION_EVENT_LIMIT)throw new Error("destination progress event limit reached");
  const next:DestinationProgress={...current,events:[...current.events,event],updatedAt:event.at};
  await parseDestinationProgress(canonicalString(next),intent);await publishDestinationProgress(intent,next,options);return next;
}

export async function retargetCompletionIntent(journal:GenesisJournal,oldIntent:LegacyCompletionIntent,newIntent:LegacyCompletionIntent,now:string,options?:HardenedWriteOptions):Promise<void>{
  if(journal.phase!=="active"||journal.completionReceipts["recovery-kit-staging"]||oldIntent.mode!=="keychain"||newIntent.mode!=="kit-path")throw new Error("completion RETARGET is not authorized");
  const oldRaw=serializeCompletionIntent(oldIntent),newRaw=serializeCompletionIntent(newIntent);
  const canonicalRaw=await fs.readFile(genesisPaths(journal.accountId).intent,"utf8");parseCompletionIntent(canonicalRaw,journal);if(canonicalRaw!==oldRaw)throw new Error("completion RETARGET old intent is not the exact canonical record");
  const witness:LegacyCompletionIntentRetargetWitness={version:1,accountId:journal.accountId,requestSha256:journal.requestSha256,oldIntent,oldIntentSha256:await sha256Hex(utf8(oldRaw)),newIntent,newIntentSha256:await sha256Hex(utf8(newRaw)),witnessedAt:now};
  await publishRetargetWitness(witness,journal,options);
  await hardenedWrite(genesisPaths(journal.accountId).intent,newRaw,options);
}

export async function replaceDestinationSetIntent(
  journal:GenesisJournal,
  oldIntent:DestinationSetCompletionIntent,
  oldProgress:DestinationProgress,
  newIntent:DestinationSetCompletionIntent,
  carriedCompletions:CarriedDestinationCompletion[],
  liveValidOldIndexes:readonly number[],
  now:string,
  options?:HardenedWriteOptions
):Promise<void>{
  if(journal.phase!=="active"||journal.completionReceipts["recovery-kit-staging"])throw new Error("destination-set replacement is not authorized");
  if(oldIntent.accountId!==journal.accountId||newIntent.accountId!==journal.accountId||oldIntent.requestSha256!==journal.requestSha256||newIntent.requestSha256!==journal.requestSha256)throw new Error("destination-set replacement attempt mismatch");
  const paths=genesisPaths(journal.accountId),oldIntentRaw=serializeCompletionIntent(oldIntent),newIntentRaw=serializeCompletionIntent(newIntent);
  const canonicalIntentRaw=await fs.readFile(paths.intent,"utf8"),canonicalProgressRaw=await fs.readFile(paths.progress,"utf8");
  if(canonicalIntentRaw!==oldIntentRaw||canonicalProgressRaw!==canonicalString(oldProgress))throw new Error("destination-set replacement source is not canonical");
  parseCompletionIntent(newIntentRaw,journal);await parseDestinationProgress(canonicalProgressRaw,oldIntent);
  const oldFold=await foldDestinationProgress(oldIntent,oldProgress.events);
  const liveSet=new Set(liveValidOldIndexes);
  if(liveSet.size!==liveValidOldIndexes.length||[...liveSet].some((index)=>!Number.isInteger(index)||index<0||index>=oldIntent.destinations.length||!oldFold.completions[index]))throw new Error("invalid live-valid replacement set");
  const carriedOld=new Set(carriedCompletions.map((mapping)=>mapping.oldDestinationIndex));
  if(carriedOld.size!==carriedCompletions.length||liveSet.size!==carriedOld.size||[...liveSet].some((index)=>!carriedOld.has(index)))throw new Error("replacement would discard a live-valid completion");
  const ordered=[...carriedCompletions].sort((a,b)=>a.newDestinationIndex-b.newDestinationIndex);
  for(const mapping of ordered){
    const completion=oldFold.completions[mapping.oldDestinationIndex];
    if(!completion||!completionMatchesDestination(completion,newIntent.destinations[mapping.newDestinationIndex]!)
      ||await digest(canonicalString(completion))!==mapping.completionSha256)throw new Error("invalid carried completion mapping");
  }
  const remap=new Map(ordered.map((mapping)=>[mapping.oldDestinationIndex,mapping.newDestinationIndex]));
  const carriedEvents=oldProgress.events.flatMap((event)=>{
    const nextIndex=remap.get(event.destinationIndex);
    return nextIndex===undefined?[]:[{...event,destinationIndex:nextIndex} as DestinationEvent];
  });
  const newProgress:DestinationProgress={version:1,accountId:newIntent.accountId,requestSha256:newIntent.requestSha256,intentSha256:await completionIntentSha256(newIntent),events:carriedEvents,updatedAt:carriedEvents.at(-1)?.at??now};
  await parseDestinationProgress(canonicalString(newProgress),newIntent);
  const witness:DestinationSetRetargetWitness={
    version:2,accountId:journal.accountId,requestSha256:journal.requestSha256,
    oldIntent,oldIntentSha256:await completionIntentSha256(oldIntent),newIntent,newIntentSha256:await completionIntentSha256(newIntent),
    oldProgress,oldProgressSha256:await digest(canonicalString(oldProgress)),newProgress,newProgressSha256:await digest(canonicalString(newProgress)),
    carriedCompletions:ordered,witnessedAt:now,
  };
  await publishRetargetWitness(witness,journal,options);
  await hardenedWrite(paths.intent,newIntentRaw,options);
  await hardenedWrite(paths.progress,canonicalString(newProgress),options);
}

/** Resume RETARGET by accepting only the witness's exact old/new canonical value. */
export async function reconcileRetargetIntent(journal:GenesisJournal):Promise<CompletionIntent|undefined>{
  const paths=genesisPaths(journal.accountId);let witnessRaw:string;try{witnessRaw=await fs.readFile(paths.witness,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
  const witness=await parseRetargetWitness(witnessRaw,journal);let canonicalRaw:string;try{canonicalRaw=await fs.readFile(paths.intent,"utf8");}catch(error){throw new Error("RETARGET witness exists without canonical completion intent",{cause:error});}
  const canonical=parseCompletionIntent(canonicalRaw,journal),raw=serializeCompletionIntent(canonical),oldRaw=serializeCompletionIntent(witness.oldIntent),newRaw=serializeCompletionIntent(witness.newIntent);
  if(raw!==oldRaw&&raw!==newRaw)throw new Error("RETARGET canonical intent is not a witnessed value");
  if(witness.version===1){
    if((raw===oldRaw?witness.oldIntentSha256:witness.newIntentSha256)!==await digest(raw))throw new Error("RETARGET survivor digest mismatch");
    const exact=await fs.readFile(paths.intent,"utf8");if(exact!==raw)throw new Error("RETARGET survivor exact read-back failed");await hardenedFsyncExisting(paths.intent);await hardenedUnlink(paths.witness);return canonical;
  }
  let progressRaw:string;try{progressRaw=await fs.readFile(paths.progress,"utf8");}catch(error){throw new Error("destination-set RETARGET witness exists without progress",{cause:error});}
  const oldProgressRaw=canonicalString(witness.oldProgress),newProgressRaw=canonicalString(witness.newProgress);
  if(progressRaw!==oldProgressRaw&&progressRaw!==newProgressRaw)throw new Error("RETARGET progress is not a witnessed value");
  if(raw===newRaw&&progressRaw===oldProgressRaw){
    await hardenedWrite(paths.progress,newProgressRaw);
    progressRaw=newProgressRaw;
  }else if(raw===oldRaw&&progressRaw===newProgressRaw){
    await hardenedWrite(paths.progress,oldProgressRaw);
    progressRaw=oldProgressRaw;
  }
  const survivor=raw===newRaw?witness.newIntent:witness.oldIntent;
  const survivorProgress=raw===newRaw?witness.newProgress:witness.oldProgress;
  if(progressRaw!==canonicalString(survivorProgress))throw new Error("RETARGET intent/progress survivor mismatch");
  await hardenedFsyncExisting(paths.intent);await hardenedFsyncExisting(paths.progress);await hardenedUnlink(paths.witness);return survivor;
}

export async function buildDestinationSetReceipt(
  intent:DestinationSetCompletionIntent,
  progress:DestinationProgress,
  liveValidDestinationIndexes:readonly number[],
  continuedAfterPartial:boolean,
  at:string
):Promise<Extract<GenesisCompletionReceipt,{outcome:"destination-set"}>>{
  if(!iso(at))throw new Error("invalid destination-set receipt timestamp");
  await parseDestinationProgress(canonicalString(progress),intent);
  const folded=await foldDestinationProgress(intent,progress.events),indexes=[...liveValidDestinationIndexes];
  if(new Set(indexes).size!==indexes.length||indexes.some((index)=>!Number.isInteger(index)||index<0||index>=intent.destinations.length||!folded.completions[index]))throw new Error("invalid live-valid destination set");
  indexes.sort((a,b)=>a-b);
  if(indexes.length<intent.successThreshold)throw new Error("destination success threshold is not met");
  if(!continuedAfterPartial&&indexes.length!==intent.destinations.length)throw new Error("partial destination completion requires explicit continuation");
  return{
    outcome:"destination-set",at,intentSha256:await completionIntentSha256(intent),
    completions:indexes.map((index)=>folded.completions[index]!),
    finalProgressSha256:await digest(canonicalString(progress)),continuedAfterPartial,
  };
}

export async function recordDestinationSetReceipt(
  journal:GenesisJournal,
  intent:DestinationSetCompletionIntent,
  progress:DestinationProgress,
  liveValidDestinationIndexes:readonly number[],
  continuedAfterPartial:boolean,
  at:string,
  options?:HardenedWriteOptions
):Promise<GenesisJournal>{
  if(journal.phase!=="active"||journal.completionReceipts["recovery-kit-staging"])throw new Error("destination-set receipt is not authorized");
  const paths=genesisPaths(journal.accountId);
  if(await fs.readFile(paths.intent,"utf8")!==serializeCompletionIntent(intent)||await fs.readFile(paths.progress,"utf8")!==canonicalString(progress))throw new Error("destination-set receipt source is not canonical");
  const receipt=await buildDestinationSetReceipt(intent,progress,liveValidDestinationIndexes,continuedAfterPartial,at);
  return recordGenesisReceipt(journal,receipt,options);
}

export async function recordGenesisReceipt(journal:GenesisJournal,receipt:GenesisCompletionReceipt,options?:HardenedWriteOptions):Promise<GenesisJournal>{
  const existing=journal.completionReceipts["recovery-kit-staging"];
  if(existing && canonicalString(existing)!==canonicalString(receipt))throw new Error("genesis completion receipt is monotone");
  const next:GenesisJournal={...journal,phase:"cleanup",completionReceipts:{"recovery-kit-staging":existing??receipt}};
  await publishGenesisJournal(next,options);return next;
}
