import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalString, fromB64url, parseStrict, rkToPhrase, sha256Hex, toB64url, utf8 } from "../engine/e2ee/index.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory } from "../engine/fsutil.js";

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
  | { outcome: "artifact-committed"; at: string; artifact: { mode: "keychain"; service: "rbox recovery phrase"; account: string; keychainPath: string } | { mode: "kit-path"; path: string } };

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

export type CompletionIntent =
  | { version: 1; accountId: string; requestSha256: string; mode: "phrase-display"; intentAt: string }
  | { version: 1; accountId: string; requestSha256: string; mode: "keychain"; keychain: { service: "rbox recovery phrase"; account: string; keychainPath: string }; intentAt: string }
  | { version: 1; accountId: string; requestSha256: string; mode: "kit-path"; path: string; intentAt: string };

export interface CompletionIntentRetargetWitness {
  version: 1;
  accountId: string;
  requestSha256: string;
  oldIntent: CompletionIntent;
  oldIntentSha256: string;
  newIntent: CompletionIntent;
  newIntentSha256: string;
  witnessedAt: string;
}

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
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseBounded(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > GENESIS_MAX_JSON_BYTES) throw new Error("genesis artifact exceeds size bound");
  return parseStrict(raw);
}

const boundedOpaque = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 64 * 1024;

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
    }else throw new Error("invalid genesis completion receipt");
  }
  if ((v.phase==="active") !== (receipt===undefined)) throw new Error("genesis journal phase/receipt mismatch");
  parseGenesisBootstrapRequest(v.requestBody, v.deviceId);
  return v as unknown as GenesisJournal;
}

export function serializeCompletionIntent(intent: CompletionIntent): string { return canonicalString(intent); }

export function parseCompletionIntent(raw: string, journal: GenesisJournal): CompletionIntent {
  const v=parseBounded(raw);
  if (!plain(v)||v.version!==1||v.accountId!==journal.accountId||v.requestSha256!==journal.requestSha256||!iso(v.intentAt)) throw new Error("invalid genesis completion intent binding");
  if (v.mode==="phrase-display" && exactKeys(v,["version","accountId","requestSha256","mode","intentAt"])) return v as unknown as CompletionIntent;
  if (v.mode==="kit-path" && exactKeys(v,["version","accountId","requestSha256","mode","path","intentAt"]) && typeof v.path==="string" && path.isAbsolute(v.path)) return v as unknown as CompletionIntent;
  if (v.mode==="keychain" && exactKeys(v,["version","accountId","requestSha256","mode","keychain","intentAt"]) && plain(v.keychain)
    && exactKeys(v.keychain,["service","account","keychainPath"]) && v.keychain.service==="rbox recovery phrase" && typeof v.keychain.account==="string" && !!v.keychain.account
    && typeof v.keychain.keychainPath==="string" && path.isAbsolute(v.keychain.keychainPath)) return v as unknown as CompletionIntent;
  throw new Error("invalid genesis completion intent shape");
}

export async function parseRetargetWitness(raw:string,journal:GenesisJournal):Promise<CompletionIntentRetargetWitness>{
  const v=parseBounded(raw);
  if(!plain(v)||!exactKeys(v,["version","accountId","requestSha256","oldIntent","oldIntentSha256","newIntent","newIntentSha256","witnessedAt"])||v.version!==1||v.accountId!==journal.accountId||v.requestSha256!==journal.requestSha256||!iso(v.witnessedAt)||!plain(v.oldIntent)||!plain(v.newIntent)) throw new Error("invalid completion RETARGET witness");
  const old=parseCompletionIntent(canonicalString(v.oldIntent),journal); const next=parseCompletionIntent(canonicalString(v.newIntent),journal);
  if(old.mode!=="keychain"||next.mode!=="kit-path"||typeof v.oldIntentSha256!=="string"||typeof v.newIntentSha256!=="string"
    ||await sha256Hex(utf8(serializeCompletionIntent(old)))!==v.oldIntentSha256||await sha256Hex(utf8(serializeCompletionIntent(next)))!==v.newIntentSha256) throw new Error("invalid completion RETARGET witness digests");
  return v as unknown as CompletionIntentRetargetWitness;
}

export const genesisPaths=(accountId:string)=>{const dir=genesisAccountRoot(accountId);return{
  dir, marker:path.join(dir,"genesis-prepublish.json"), stagedRk:path.join(dir,"rk.key.staged"), journal:path.join(dir,"genesis-attempt.json"),
  intent:path.join(dir,"genesis-completion-intent.json"), witness:path.join(dir,"genesis-completion-intent.retarget.json"), enrolledWitness:path.join(dir,"genesis-enrolled.json"), device:path.join(dir,"device.json"), mk:path.join(dir,"mk.key"), rk:path.join(dir,"rk.key"), quarantine:path.join(dir,"quarantine"),
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

export async function retargetCompletionIntent(journal:GenesisJournal,oldIntent:CompletionIntent,newIntent:CompletionIntent,now:string,options?:HardenedWriteOptions):Promise<void>{
  if(journal.phase!=="active"||journal.completionReceipts["recovery-kit-staging"]||oldIntent.mode!=="keychain"||newIntent.mode!=="kit-path")throw new Error("completion RETARGET is not authorized");
  const oldRaw=serializeCompletionIntent(oldIntent),newRaw=serializeCompletionIntent(newIntent);
  const canonicalRaw=await fs.readFile(genesisPaths(journal.accountId).intent,"utf8");parseCompletionIntent(canonicalRaw,journal);if(canonicalRaw!==oldRaw)throw new Error("completion RETARGET old intent is not the exact canonical record");
  const witness:CompletionIntentRetargetWitness={version:1,accountId:journal.accountId,requestSha256:journal.requestSha256,oldIntent,oldIntentSha256:await sha256Hex(utf8(oldRaw)),newIntent,newIntentSha256:await sha256Hex(utf8(newRaw)),witnessedAt:now};
  await publishRetargetWitness(witness,journal,options);
  await hardenedWrite(genesisPaths(journal.accountId).intent,newRaw,options);
}

/** Resume RETARGET by accepting only the witness's exact old/new canonical value. */
export async function reconcileRetargetIntent(journal:GenesisJournal):Promise<CompletionIntent|undefined>{
  const paths=genesisPaths(journal.accountId);let witnessRaw:string;try{witnessRaw=await fs.readFile(paths.witness,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}
  const witness=await parseRetargetWitness(witnessRaw,journal);let canonicalRaw:string;try{canonicalRaw=await fs.readFile(paths.intent,"utf8");}catch(error){throw new Error("RETARGET witness exists without canonical completion intent",{cause:error});}
  const canonical=parseCompletionIntent(canonicalRaw,journal),raw=serializeCompletionIntent(canonical);if(raw!==serializeCompletionIntent(witness.oldIntent)&&raw!==serializeCompletionIntent(witness.newIntent))throw new Error("RETARGET canonical intent is not a witnessed value");
  if((canonical.mode==="keychain"?witness.oldIntentSha256:witness.newIntentSha256)!==await sha256Hex(utf8(raw)))throw new Error("RETARGET survivor digest mismatch");
  const exact=await fs.readFile(paths.intent,"utf8");if(exact!==raw)throw new Error("RETARGET survivor exact read-back failed");const handle=await fs.open(paths.intent,"r");try{await handle.sync();}finally{await handle.close();}await fsyncDirectory(path.dirname(paths.intent));await hardenedUnlink(paths.witness);return canonical;
}

export async function recordGenesisReceipt(journal:GenesisJournal,receipt:GenesisCompletionReceipt,options?:HardenedWriteOptions):Promise<GenesisJournal>{
  const existing=journal.completionReceipts["recovery-kit-staging"];
  if(existing && canonicalString(existing)!==canonicalString(receipt))throw new Error("genesis completion receipt is monotone");
  const next:GenesisJournal={...journal,phase:"cleanup",completionReceipts:{"recovery-kit-staging":existing??receipt}};
  await publishGenesisJournal(next,options);return next;
}
