import fs from "node:fs/promises";
import {
  assertCurrentRecoveryWrap,
  assertMkWrapAuthorized,
  bootstrapAccount,
  buildPairing,
  buildRecoveryAdmission,
  ENC_ALG,
  fromB64url,
  generateSignKeyPair,
  generateWrapKeyPair,
  openOwnMasterKey,
  phraseToRk,
  randomBytes,
  recoverMasterKey,
  redeemPairing,
  toB64url,
  verifyAccount,
  canonicalString,
  phraseToRk as decodeRecoveryPhrase,
  sha256Hex,
  SIG_ALG,
  utf8,
  wrapHash,
  type DeviceSecrets,
  type RedeemResult,
  type SignedKeyState,
  type SignedRoster,
  type Wrap,
} from "../engine/e2ee/index.js";
import { RboxApi } from "./remote.js";
import type { AccountKeysDTO } from "./e2ee-remote.js";
import { E2eeRemote } from "./e2ee-remote.js";
import { hasDevice, keystorePinStore, loadDevice, saveDevice, saveMasterKey, saveRecoveryKey } from "./e2ee-keystore.js";
import { loadConfig, type WorkspaceConfig } from "./config.js";
import { credentialsForStrictFlow, loadCredentials, saveCredentials, type CredentialLoadResult } from "./credentials.js";
import type { SyncDeps } from "./sync.js";
import type { GenesisAccountObservation } from "./e2ee-remote.js";
import {
  GENESIS_PENDING_MESSAGE,
  genesisPaths,
  appendDestinationEvent,
  createDestinationProgress,
  hardenedRename,
  hardenedFsyncExisting,
  hardenedUnlink,
  loadDestinationProgress,
  publishCompletionIntent,
  publishDestinationProgress,
  publishGenesisJournal,
  publishPrepublishMarker,
  recordDestinationSetReceipt,
  recordGenesisReceipt,
  reconcileRetargetIntent,
  replaceDestinationSetIntent,
  retargetCompletionIntent,
  parseCompletionIntent,
  parseDestinationProgress,
  stageRecoveryKey,
  type CarriedDestinationCompletion,
  type CompletionIntent,
  type DestinationEvent,
  type DestinationProgress,
  type DestinationSetCompletionIntent,
  type GenesisJournal,
  type GenesisPrepublishMarker,
} from "./genesis-durable.js";
import { acquireAccountGenesisLock, acquireGenesisLockPair, acquireGlobalGenesisLock, type GenesisLock } from "./genesis-locks.js";
import { classifyEnrollment, genesisClassifierConsultationNeeded, inspectPendingGenesis, pendingGenesisState, type EnrollmentClassification } from "./genesis-enrollment.js";
import { genesisQuarantineStatus, resumeGenesisQuarantine, startGenesisQuarantine } from "./genesis-quarantine.js";
import { e2eeRoot } from "./genesis-durable.js";
import { GenesisBootstrapTerminalError } from "./remote/errors.js";

const ACCOUNT_ID_RE = /^acct_[0-9a-f]{16}$/; // strict grammar before path/lock naming
const ADMIT_RETRIES = 4;

export class RecoveryPreAdmissionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RecoveryPreAdmissionError";
  }
}

export function newAgentId(): string {
  return `agent_${toB64url(randomBytes(16))}`;
}

const PAIR_TOKEN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PAIR_TOKEN_PREFIX = "rbox-pair_";

export interface ParsedPairingToken {
  /** Preserve the prefixed/raw token exactly as supplied for server compatibility. */
  redeemToken: string;
  tokenSecret: Uint8Array;
}

export class PairingTokenShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingTokenShapeError";
  }
}

/** The shared secret decoder used by both the local wizard gate and redemption. */
export function decodePairingSecret(encoded: string): Uint8Array {
  return fromB64url(encoded);
}

/** Pure, single-source grammar for current, raw, and legacy pairing tokens. */
export function parsePairingToken(fullToken: string): ParsedPairingToken {
  const parts = fullToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PairingTokenShapeError("malformed pairing token (expected `rbox-pair_<id>.<secret>`)");
  }
  const redeemToken = parts[0];
  const tokenId = redeemToken.startsWith(PAIR_TOKEN_PREFIX) ? redeemToken.slice(PAIR_TOKEN_PREFIX.length) : redeemToken;
  if (!PAIR_TOKEN_ID_RE.test(tokenId)) throw new PairingTokenShapeError("malformed pairing token (invalid redeem id)");
  let tokenSecret: Uint8Array;
  try {
    tokenSecret = decodePairingSecret(parts[1]);
  } catch (error) {
    throw new PairingTokenShapeError(`malformed pairing token (${error instanceof Error ? error.message : "invalid secret encoding"})`);
  }
  if (tokenSecret.length !== 32) throw new PairingTokenShapeError("malformed pairing token (secret must be 32 bytes)");
  return { redeemToken, tokenSecret };
}

async function pairingRedeemError(res: Response): Promise<Error> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; cap?: unknown; plan?: unknown };
    if (body.error === "device_limit_reached") {
      const cap = typeof body.cap === "number" && Number.isFinite(body.cap) ? body.cap : "?";
      const plan = typeof body.plan === "string" && body.plan ? body.plan : "current plan";
      return new Error(`device limit reached (${cap}/${cap} on ${plan}) — revoke a device or upgrade; pairing token still valid`);
    }
  }
  return new Error("pairing failed — token may be expired, used, or invalid. Generate a fresh one with `rbox pair`.");
}

/** Parse the verified account chains from the server DTO + verify them (C1/C2/C7). */
async function verifyDto(dto: AccountKeysDTO) {
  const rosters = dto.rosters.map((s) => JSON.parse(s) as SignedRoster);
  const keyStates = dto.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
  if (!rosters.length || !keyStates.length) throw new Error("account key chain incomplete — refusing (fatal)");
  return { rosters, keyStates, account: await verifyAccount(rosters, keyStates) };
}

/** Cross-check a server-returned accountId against the SIGNED roster accountId (D7). */
function assertSignedAccountId(claimed: string, signed: string): void {
  if (!ACCOUNT_ID_RE.test(claimed)) throw new Error(`malformed accountId: ${claimed}`);
  if (claimed !== signed) throw new Error("accountId mismatch — server claim ≠ signed roster (refusing)");
}

// ---- enrollment ------------------------------------------------------------

/**
 * New account, first device (D2 crash-safe): generate keys, persist device.json +
 * mk.key (+ optional recovery cache) LOCALLY FIRST, then POST genesis. A crash
 * after the POST leaves local MK present ⇒ recoverable. Returns the recovery phrase
 * to display once.
 */
export async function bootstrapNewAccount(api: Pick<RboxApi, "bootstrapKeys">, accountId: string, deviceId: string, opts: { cacheRecovery?: boolean; now: number }): Promise<string> {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error(`malformed accountId from server: ${accountId}`);
  const boot = await bootstrapAccount(accountId, deviceId, opts.now);
  // Persist locally BEFORE the server POST (crash-safety).
  await saveDevice(boot.secrets);
  if (opts.cacheRecovery) await saveRecoveryKey(accountId, await phraseToRk(boot.recoveryPhrase));
  await api.bootstrapKeys({
    recoveryWrap: JSON.stringify(boot.upload.recoveryWrap),
    recoveryWrapId: boot.upload.recoveryWrapId,
    genesisRoster: JSON.stringify(boot.upload.genesisRoster),
    genesisKeyState: JSON.stringify(boot.upload.genesisKeyState),
    device: { deviceId, sigPubKey: boot.upload.device.sigPubKey, encPubKey: boot.upload.device.encPubKey, mkWrap: JSON.stringify(boot.upload.device.mkWrap) },
  });
  return boot.recoveryPhrase;
}

export interface GenesisCapableApi extends Pick<RboxApi,"bootstrapKeys"> { getGenesisObservation():Promise<GenesisAccountObservation> }
export interface AtomicGenesisCommit {kind:"committed";journal:GenesisJournal;phrase:string;lock:GenesisLock;globalLock:GenesisLock}
export type AtomicGenesisStartResult=AtomicGenesisCommit|{kind:"already-setup"};

async function removePrepublicationBundle(accountId:string):Promise<void>{const p=genesisPaths(accountId);await hardenedUnlink(p.device);await hardenedUnlink(p.mk);await hardenedUnlink(p.stagedRk);await hardenedUnlink(p.intent);await hardenedUnlink(p.progress);await hardenedUnlink(p.witness);await hardenedUnlink(p.marker);}

async function validateRecoveryKeyBytes(journal:GenesisJournal,bytes:Uint8Array):Promise<void>{
  const rk=fromB64url(Buffer.from(bytes).toString("utf8").trim());if(rk.length!==32)throw new Error("promoted recovery key has invalid length");
  const request=JSON.parse(journal.requestBody) as {recoveryWrap?:unknown};if(typeof request.recoveryWrap!=="string")throw new Error("journal recovery wrap missing");
  const loaded=await loadDevice(journal.accountId);if(!loaded||!("secrets" in loaded)||loaded.secrets.deviceId!==journal.deviceId)throw new Error("journal device material mismatch");
  const mk=await recoverMasterKey(journal.accountId,0,rk,JSON.parse(request.recoveryWrap) as Wrap);if(!Buffer.from(mk).equals(Buffer.from(loaded.secrets.mk)))throw new Error("promoted recovery key does not authenticate journal MK");
}

async function cleanupWinningJournal(journal:GenesisJournal):Promise<void>{
  const p=genesisPaths(journal.accountId);
  const receipt=journal.completionReceipts["recovery-kit-staging"];
  if(receipt?.outcome==="destination-set"){
    const intentBytes=await fsRead(p.intent),progressBytes=await fsRead(p.progress);
    if(!intentBytes&&progressBytes)throw new Error("destination progress survived without its cleanup authority");
    if(intentBytes){
      const intent=parseCompletionIntent(Buffer.from(intentBytes).toString("utf8"),journal);
      if(intent.version!==2||await sha256Hex(utf8(canonicalString(intent)))!==receipt.intentSha256)throw new Error("destination-set cleanup intent digest mismatch");
      if(progressBytes){
        const progress=await parseDestinationProgress(Buffer.from(progressBytes).toString("utf8"),intent);
        if(await sha256Hex(utf8(canonicalString(progress)))!==receipt.finalProgressSha256)throw new Error("destination-set cleanup progress digest mismatch");
      }
    }
  }
  if(journal.originalCacheRecovery){
    const staged=await fsRead(p.stagedRk),dest=await fsRead(p.rk);
    if(staged&&dest)throw new Error("winning recovery-key promotion has both source and destination");
    if(staged){await validateRecoveryKeyBytes(journal,staged);await hardenedRename(p.stagedRk,p.rk);const promoted=await fsRead(p.rk);if(!promoted)throw new Error("winning recovery-key promotion lost destination");await validateRecoveryKeyBytes(journal,promoted);}
    else{if(!dest)throw new Error("winning recovery-key promotion has neither source nor destination");await validateRecoveryKeyBytes(journal,dest);await hardenedFsyncExisting(p.rk);}
  }else{
    const loaded=await loadDevice(journal.accountId),request=JSON.parse(journal.requestBody) as {device?:{deviceId?:unknown;sigPubKey?:unknown;encPubKey?:unknown;mkWrap?:unknown}};const device=request.device;
    if(!loaded||!("secrets" in loaded)||loaded.secrets.deviceId!==journal.deviceId||device?.deviceId!==journal.deviceId||device.sigPubKey!==toB64url(loaded.secrets.sigPubKey)||device.encPubKey!==toB64url(loaded.secrets.encPubSpki)||typeof device.mkWrap!=="string")throw new Error("journal device material mismatch");
    const opened=await openOwnMasterKey(loaded.secrets,0,JSON.parse(device.mkWrap) as Wrap);if(!Buffer.from(opened).equals(Buffer.from(loaded.secrets.mk)))throw new Error("journal MK material mismatch");await hardenedUnlink(p.stagedRk);
  }
  await hardenedUnlink(p.progress);await hardenedUnlink(p.intent);await hardenedUnlink(p.witness);await hardenedUnlink(p.marker);await hardenedUnlink(p.journal);
}
async function fsRead(file:string):Promise<Uint8Array|undefined>{try{return new Uint8Array(await fs.readFile(file));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}}

async function cleanupCompetingJournal(journal:GenesisJournal):Promise<void>{const now=new Date().toISOString();const status=await genesisQuarantineStatus(journal.accountId,"abandoned-attempt",journal.requestSha256);if(status==="absent")await startGenesisQuarantine({accountId:journal.accountId,purpose:"abandoned-attempt",uniquenessKey:journal.requestSha256,createdAt:now});if(status!=="completed")await resumeGenesisQuarantine(journal.accountId,"abandoned-attempt",journal.requestSha256,now);const p=genesisPaths(journal.accountId);await hardenedUnlink(p.intent);await hardenedUnlink(p.progress);await hardenedUnlink(p.witness);await hardenedUnlink(p.marker);await hardenedUnlink(p.journal);}

export async function resumeGenesisCleanup(journal:GenesisJournal):Promise<void>{const receipt=journal.completionReceipts["recovery-kit-staging"];if(!receipt)throw new Error("cleanup journal has no receipt");if(receipt.outcome==="competing-cleaned")await cleanupCompetingJournal(journal);else await cleanupWinningJournal(journal);}
async function resumeClassifiedGenesisCleanup(journal:GenesisJournal):Promise<void>{try{await resumeGenesisCleanup(journal);}catch(error){throw new Error(`genesis integrity failure: cleanup precondition changed: ${error instanceof Error?error.message:String(error)}`,{cause:error});}}

/** Durable first-attempt/resume protocol. The returned account lock remains held until completion is recorded. */
export async function beginAtomicGenesis(api:GenesisCapableApi,accountId:string,deviceId:string,opts:{cacheRecovery?:boolean;now:number}):Promise<AtomicGenesisStartResult>{
  if(!ACCOUNT_ID_RE.test(accountId))throw new Error(`malformed accountId from server: ${accountId}`);
  let pair=await acquireGenesisLockPair(accountId),accountLock=pair.account;let global=pair.global;
  try{
    for(;;){
      let observation=await api.getGenesisObservation();let state=await classifyEnrollment(accountId,observation);
      if(state.kind==="enrolled"){await global.release();await accountLock.release();return{kind:"already-setup"};}
      if(state.kind==="cleanup-resume"){await resumeClassifiedGenesisCleanup(state.journal);await accountLock.release();await global.release();pair=await acquireGenesisLockPair(accountId);accountLock=pair.account;global=pair.global;continue;}
      if(state.kind==="repaired-legacy"){
        // The manifest is a first pending artifact. Re-enter through the same
        // all-account global scan used by pairing, which classifies/cleans and
        // rescans before publishing it, then hand global back to this target.
        await accountLock.release();await global.release();global=await acquireClearMachineGenesisForPairing();accountLock=await acquireAccountGenesisLock(accountId);continue;
      }
      if(state.kind==="quarantine-resume"){await resumeGenesisQuarantine(accountId,"repaired-legacy",state.repairId,new Date(opts.now).toISOString());continue;}
      if(state.kind==="restart-prepublication"){await removePrepublicationBundle(accountId);continue;}
      let journal:GenesisJournal|undefined;
      if(state.kind==="resume-attempt")journal=state.journal;
      else if(state.kind==="committed-this-attempt")return{kind:"committed",journal:state.journal,phrase:state.phrase,lock:accountLock,globalLock:global};
      else if(state.kind==="competing-genesis"){const cleanup=await recordGenesisReceipt(state.journal,{outcome:"competing-cleaned",at:new Date(opts.now).toISOString()});await cleanupCompetingJournal(cleanup);await accountLock.release();await global.release();return{kind:"already-setup"};}
      else if(state.kind==="legacy-orphan")throw new Error("legacy_orphan: account encryption setup is incomplete; contact rbox support");
      else if(state.kind==="integrity-failure")throw new Error(`genesis integrity failure: ${state.reason}`);
      else if(state.kind==="pristine"||state.kind==="repair-ready"){
        const repairId=state.kind==="repair-ready"?state.repairId:null,startedAt=new Date(opts.now).toISOString();const marker:GenesisPrepublishMarker={version:1,accountId,deviceId,repairId,startedAt,phase:"prepublish"};await publishPrepublishMarker(marker);await global.release();
        const boot=await bootstrapAccount(accountId,deviceId,opts.now),rk=await decodeRecoveryPhrase(boot.recoveryPhrase);await saveDevice(boot.secrets);await stageRecoveryKey(accountId,rk);
        const body={recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,genesisRoster:JSON.stringify(boot.upload.genesisRoster),genesisKeyState:JSON.stringify(boot.upload.genesisKeyState),device:{deviceId,sigPubKey:boot.upload.device.sigPubKey,encPubKey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)},...(repairId?{repairId}:{})};const requestBody=JSON.stringify(body);journal={version:1,accountId,deviceId,startedAt,phase:"active",requestBody,requestSha256:await sha256Hex(utf8(requestBody)),originalCacheRecovery:opts.cacheRecovery??false,completionHolds:["recovery-kit-staging"],completionReceipts:{}};
        await accountLock.release();pair=await acquireGenesisLockPair(accountId);accountLock=pair.account;global=pair.global;observation=await api.getGenesisObservation();state=await classifyEnrollment(accountId,observation);if(state.kind!=="restart-prepublication")throw new Error("genesis state changed before journal publication");await publishGenesisJournal(journal);await global.release();
      }
      await global.release();try{await api.bootstrapKeys(journal!.requestBody);}catch(error){if(error instanceof GenesisBootstrapTerminalError)throw error;}
      observation=await api.getGenesisObservation();state=await classifyEnrollment(accountId,observation);
      if(state.kind==="committed-this-attempt"){
        await accountLock.release();pair=await acquireGenesisLockPair(accountId);accountLock=pair.account;global=pair.global;
        const locked=await classifyEnrollment(accountId,await api.getGenesisObservation());if(locked.kind!=="committed-this-attempt")throw new Error(locked.kind==="integrity-failure"?`genesis integrity failure: ${locked.reason}`:"genesis state changed before completion");
        return{kind:"committed",journal:locked.journal,phrase:locked.phrase,lock:accountLock,globalLock:global};
      }
      if(state.kind==="resume-attempt")throw new Error("genesis publication remains unconfirmed — re-run setup to resume");
      if(state.kind==="competing-genesis"){
        await accountLock.release();pair=await acquireGenesisLockPair(accountId);accountLock=pair.account;global=pair.global;const locked=await classifyEnrollment(accountId,await api.getGenesisObservation());
        if(locked.kind!=="competing-genesis")throw new Error(locked.kind==="integrity-failure"?`genesis integrity failure: ${locked.reason}`:"genesis state changed before competing cleanup");
        const cleanup=await recordGenesisReceipt(locked.journal,{outcome:"competing-cleaned",at:new Date(opts.now).toISOString()});await cleanupCompetingJournal(cleanup);await accountLock.release();await global.release();return{kind:"already-setup"};
      }
      throw new Error(state.kind==="integrity-failure"?`genesis integrity failure: ${state.reason}`:`genesis publication failed: ${state.kind}`);
    }
  }catch(error){await global.release().catch(()=>{});await accountLock.release().catch(()=>{});throw error;}
}

export interface AtomicGenesisCompletionHandlers{
  deliverPhrase:(phrase:string)=>Promise<void>;
  selectIntent?:(journal:GenesisJournal,phrase:string,now:number)=>Promise<CompletionIntent>;
  commitArtifact?:(intent:Extract<CompletionIntent,{mode:"keychain"|"kit-path"}>,phrase:string)=>Promise<void>;
  retargetKeychainFailure?:(error:unknown,intent:Extract<CompletionIntent,{mode:"keychain"}>,phrase:string)=>Promise<Extract<CompletionIntent,{mode:"kit-path"}>|undefined>;
  completeDestinationSet?:(context:AtomicGenesisDestinationSetContext)=>Promise<AtomicGenesisDestinationSetResult>;
}

export interface AtomicGenesisDestinationSetState{intent:DestinationSetCompletionIntent;progress:DestinationProgress}
export interface AtomicGenesisDestinationSetContext extends AtomicGenesisDestinationSetState{
  phrase:string;
  append(event:DestinationEvent):Promise<DestinationProgress>;
  replace(args:{
    newIntent:DestinationSetCompletionIntent;
    carriedCompletions:CarriedDestinationCompletion[];
    liveValidOldIndexes:readonly number[];
  }):Promise<AtomicGenesisDestinationSetState>;
}
export interface AtomicGenesisDestinationSetResult extends AtomicGenesisDestinationSetState{
  liveValidDestinationIndexes:readonly number[];
  continuedAfterPartial:boolean;
}

/** Consume the durable selection. Absence alone selects phrase-display; a present
 * intent or RETARGET witness is reconciled before any sink runs. */
export async function completeAtomicGenesis(commit:AtomicGenesisCommit,deliverOrHandlers:((phrase:string)=>Promise<void>)|AtomicGenesisCompletionHandlers,now=Date.now()):Promise<void>{
  const handlers:AtomicGenesisCompletionHandlers=typeof deliverOrHandlers==="function"?{deliverPhrase:deliverOrHandlers}:deliverOrHandlers;
  try{
    const pending=await inspectPendingGenesis(commit.journal.accountId);let intent:CompletionIntent|undefined;
    if(pending.witnessRaw!==undefined)intent=await reconcileRetargetIntent(commit.journal);
    else if(pending.intentRaw!==undefined)intent=parseCompletionIntent(pending.intentRaw,commit.journal);
    if(!intent){intent=handlers.selectIntent?await handlers.selectIntent(commit.journal,commit.phrase,now):{version:1,accountId:commit.journal.accountId,requestSha256:commit.journal.requestSha256,mode:"phrase-display",intentAt:new Date(now).toISOString()};await publishCompletionIntent(intent,commit.journal);}
    if(intent.version===2){
      if(!handlers.completeDestinationSet)throw new Error("cannot resume destination-set completion without its handler");
      let state:AtomicGenesisDestinationSetState;
      try{state={intent,progress:await loadDestinationProgress(intent)};}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        const progress=await createDestinationProgress(intent);
        await publishDestinationProgress(intent,progress);state={intent,progress};
      }
      const context:AtomicGenesisDestinationSetContext={
        ...state,phrase:commit.phrase,
        append:async(event)=>{
          state={...state,progress:await appendDestinationEvent(state.intent,state.progress,event)};
          context.intent=state.intent;context.progress=state.progress;return state.progress;
        },
        replace:async(args)=>{
          await replaceDestinationSetIntent(commit.journal,state.intent,state.progress,args.newIntent,args.carriedCompletions,args.liveValidOldIndexes,new Date(now).toISOString());
          const survivor=await reconcileRetargetIntent(commit.journal);
          if(!survivor||survivor.version!==2)throw new Error("destination-set replacement did not reconcile a destination plan");
          state={intent:survivor,progress:await loadDestinationProgress(survivor)};
          context.intent=state.intent;context.progress=state.progress;return state;
        },
      };
      const result=await handlers.completeDestinationSet(context);
      const cleanup=await recordDestinationSetReceipt(commit.journal,result.intent,result.progress,result.liveValidDestinationIndexes,result.continuedAfterPartial,new Date(now).toISOString());
      await cleanupWinningJournal(cleanup);return;
    }
    if(intent.mode==="phrase-display"){await handlers.deliverPhrase(commit.phrase);}
    else{
      if(!handlers.commitArtifact)throw new Error(`cannot resume ${intent.mode} completion without its artifact sink`);
      try{await handlers.commitArtifact(intent,commit.phrase);}
      catch(error){if(intent.mode!=="keychain"||!handlers.retargetKeychainFailure)throw error;const next=await handlers.retargetKeychainFailure(error,intent,commit.phrase);if(!next)throw error;await retargetCompletionIntent(commit.journal,intent,next,new Date(now).toISOString());const survivor=await reconcileRetargetIntent(commit.journal);if(!survivor||survivor.mode!=="kit-path")throw new Error("completion RETARGET did not select the fallback artifact");await handlers.commitArtifact(survivor,commit.phrase);intent=survivor;}
    }
    const at=new Date(now).toISOString();const receipt=intent.mode==="phrase-display"?{outcome:"phrase-delivered" as const,at}:{outcome:"artifact-committed" as const,at,artifact:intent.mode==="keychain"?{mode:"keychain" as const,...intent.keychain}:{mode:"kit-path" as const,path:intent.path}};
    const cleanup=await recordGenesisReceipt(commit.journal,receipt);await cleanupWinningJournal(cleanup);
  }finally{await commit.lock.release();await commit.globalLock.release();}
}

export async function assertNoPendingGenesis(accountId:string):Promise<void>{
  if(await pendingGenesisState(accountId))throw new Error(GENESIS_PENDING_MESSAGE);
  if(await genesisClassifierConsultationNeeded(accountId)){
    const creds=credentialsForStrictFlow(await loadCredentials());if(!creds||creds.accountId!==accountId)throw new Error(GENESIS_PENDING_MESSAGE);
    const lock=await acquireClearKnownAccountGenesis(new RboxApi(creds.remoteUrl,creds.token,"",""),accountId);await lock.release();
  }
}

async function accountDirectories():Promise<string[]>{try{const entries=await fs.readdir(e2eeRoot(),{withFileTypes:true});return entries.filter((entry)=>entry.isDirectory()).map((entry)=>entry.name).sort();}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}}

/** Caller retains the global lock through opaque token redemption. */
export async function acquireClearMachineGenesisForPairing():Promise<GenesisLock>{
  const global=await acquireGlobalGenesisLock();try{
    const creds=credentialsForStrictFlow(await loadCredentials());
    scan:for(;;){
      for(const accountId of await accountDirectories()){
        if(!ACCOUNT_ID_RE.test(accountId)){const entries=await fs.readdir(`${e2eeRoot()}/${accountId}`).catch(()=>[]);if(entries.some((name)=>name.startsWith("genesis-")||name==="rk.key.staged"||name==="quarantine"))throw new Error(GENESIS_PENDING_MESSAGE);continue;}
        const lock=await acquireAccountGenesisLock(accountId);try{
          if(!(await genesisClassifierConsultationNeeded(accountId)))continue;
          if(!creds||creds.accountId!==accountId)throw new Error(`${GENESIS_PENDING_MESSAGE} (${accountId})`);
          const api=new RboxApi(creds.remoteUrl,creds.token,"","");const state=await classifyEnrollment(accountId,await api.getGenesisObservation());
          if(state.kind==="enrolled")continue;
          if(state.kind==="cleanup-resume"){await resumeClassifiedGenesisCleanup(state.journal);continue scan;}
          if(state.kind==="repaired-legacy"){const now=new Date().toISOString();await startGenesisQuarantine({accountId,purpose:"repaired-legacy",uniquenessKey:state.repairId,createdAt:now});await resumeGenesisQuarantine(accountId,"repaired-legacy",state.repairId,now);continue scan;}
          if(state.kind==="quarantine-resume"){await resumeGenesisQuarantine(accountId,"repaired-legacy",state.repairId,new Date().toISOString());continue scan;}
          throw new Error(`${GENESIS_PENDING_MESSAGE} (${accountId})`);
        }finally{await lock.release();}
      }
      return global;
    }
  }catch(error){await global.release();throw error;}
}

async function acquireClearKnownAccountGenesis(api:Pick<RboxApi,"getGenesisObservation">,accountId:string):Promise<GenesisLock>{
  const lock=await acquireAccountGenesisLock(accountId);try{if(!(await genesisClassifierConsultationNeeded(accountId)))return lock;for(;;){const state=await classifyEnrollment(accountId,await api.getGenesisObservation());if(state.kind==="enrolled")return lock;if(state.kind==="cleanup-resume"){await resumeClassifiedGenesisCleanup(state.journal);continue;}throw new Error(GENESIS_PENDING_MESSAGE);}}catch(error){await lock.release();throw error;}
}

async function settleKnownAccountGenesisLocked(api:Pick<RboxApi,"getGenesisObservation">,accountId:string):Promise<void>{if(!(await genesisClassifierConsultationNeeded(accountId)))return;for(;;){const state=await classifyEnrollment(accountId,await api.getGenesisObservation());if(state.kind==="enrolled")return;if(state.kind==="cleanup-resume"){await resumeClassifiedGenesisCleanup(state.journal);continue;}throw new Error(GENESIS_PENDING_MESSAGE);}}
async function acquireClearKnownAccountGenesisPair(api:Pick<RboxApi,"getGenesisObservation">,accountId:string):Promise<{global:GenesisLock;account:GenesisLock}>{const pair=await acquireGenesisLockPair(accountId);try{await settleKnownAccountGenesisLocked(api,accountId);return pair;}catch(error){await pair.account.release();await pair.global.release();throw error;}}

/** Self-verify the candidate extended chain + wrap authorization BEFORE publishing
 *  (D4) — a chain that wouldn't verify must never wedge other clients. */
async function selfVerifyAdmission(dto: AccountKeysDTO, admissionRoster: SignedRoster, deviceWrap: Wrap): Promise<void> {
  const rosters = dto.rosters.map((s) => JSON.parse(s) as SignedRoster);
  const keyStates = dto.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
  const account = await verifyAccount([...rosters, admissionRoster], keyStates);
  await assertMkWrapAuthorized(deviceWrap, account);
}

export interface WebDeliveryEnrollment {
  remoteUrl: string;
  token: string;
  accountId: string;
  deviceId: string;
  requestId: string;
  mkWrapDevice: string;
  publishedRosterVersion: number;
  accountEpoch: number;
  keys: {
    sigPubKey: Uint8Array;
    sigPrivPkcs8: Uint8Array;
    encPubKeySpki: Uint8Array;
    encPrivPkcs8: Uint8Array;
  };
}

export type WebDeliveryBoundary = "keys-ready" | "persisted";

interface WebDeliveryDeps {
  api?: Pick<RboxApi, "getAccountKeys">;
  loadDevice?: typeof loadDevice;
  saveDevice?: typeof saveDevice;
  acquireLocks?: typeof acquireGenesisLockPair;
  /** Durable attempt checkpoint, invoked under the enrollment locks after the
   * keystore is durable and before the persisted crash boundary is exposed. */
  persistCheckpoint?: () => Promise<void>;
  onBoundary?: (boundary: WebDeliveryBoundary) => void | Promise<void>;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function assertSameLocalDevice(
  local: Omit<DeviceSecrets, "mk">,
  expected: Omit<DeviceSecrets, "mk">,
): void {
  if (local.accountId !== expected.accountId
    || local.deviceId !== expected.deviceId
    || !sameBytes(local.sigPubKey, expected.sigPubKey)
    || !sameBytes(local.sigPrivPkcs8, expected.sigPrivPkcs8)
    || !sameBytes(local.encPubSpki, expected.encPubSpki)
    || !sameBytes(local.encPrivPkcs8, expected.encPrivPkcs8)) {
    throw new Error("this account already has different local device keys — refusing to overwrite them");
  }
}

function exactRosterDevice(
  body: Awaited<ReturnType<typeof verifyDto>>["account"]["currentRoster"],
  args: Pick<WebDeliveryEnrollment, "deviceId" | "keys">,
) {
  const entry = body.devices.find((device) => device.deviceId === args.deviceId);
  if (!entry
    || entry.status !== "active"
    || entry.kind !== "device"
    || entry.role !== "admin"
    || entry.sigAlg !== SIG_ALG
    || entry.encAlg !== ENC_ALG
    || entry.sigPubKey !== toB64url(args.keys.sigPubKey)
    || entry.encPubKey !== toB64url(args.keys.encPubKeySpki)) {
    throw new Error("published roster does not admit this device's exact keys");
  }
  return entry;
}

/** Complete design-189 web delivery without minting keys, signing a roster, or
 * re-wrapping MK. The daemon-produced device-context wrap is verified and
 * opened as-is; the existing keystore persists only the identity and MK. */
export async function enrollViaWebDelivery(
  input: WebDeliveryEnrollment,
  deps: WebDeliveryDeps = {},
): Promise<{ accountId: string; deviceId: string }> {
  if (!ACCOUNT_ID_RE.test(input.accountId)) throw new Error(`malformed accountId from server: ${input.accountId}`);
  if (!/^[0-9a-f]{64}$/.test(input.requestId)) throw new Error("malformed key-delivery requestId");
  if (!Number.isSafeInteger(input.publishedRosterVersion) || input.publishedRosterVersion < 0
    || !Number.isSafeInteger(input.accountEpoch) || input.accountEpoch < 0) {
    throw new Error("malformed key-delivery roster metadata");
  }

  const api = deps.api ?? new RboxApi(input.remoteUrl, input.token, "", "");
  const pair = await (deps.acquireLocks ?? acquireGenesisLockPair)(input.accountId);
  let mk: Uint8Array | undefined;
  try {
    const dto = await api.getAccountKeys();
    if (!dto) throw new Error("account key chain missing during web enrollment");
    const { account } = await verifyDto(dto);
    assertSignedAccountId(input.accountId, account.currentRoster.accountId);
    if (account.currentEpoch !== input.accountEpoch) {
      throw new Error("key-delivery account epoch is no longer current");
    }
    if (account.currentRoster.accountEpoch !== account.currentEpoch) {
      throw new Error("current roster head and key-state epoch disagree");
    }

    const published = account.rosters[input.publishedRosterVersion];
    if (!published || published.version !== input.publishedRosterVersion) {
      throw new Error("published key-delivery roster version is missing");
    }
    if (published.accountId !== input.accountId || published.accountEpoch !== input.accountEpoch) {
      throw new Error("published key-delivery roster account/epoch mismatch");
    }
    const publishedEntry = exactRosterDevice(published, input);
    // A later same-epoch head may exist. It must still admit this exact identity;
    // accepting a now-revoked target would race the server's revocation fence.
    // Checked for LIVENESS ONLY (the throw side-effect) — NOT its mkWrapHash: a
    // same-epoch re-wrap in a later head opens the same MK, and the delivered
    // wrap is bound to publishedEntry.mkWrapHash + the server device-row equality
    // check below. Do not "tighten" this to compare the current-head wrap hash.
    exactRosterDevice(account.currentRoster, input);

    const deviceRow = dto.devices.find((device) => device.deviceId === input.deviceId);
    if (!deviceRow
      || deviceRow.sigPubkey !== toB64url(input.keys.sigPubKey)
      || deviceRow.encPubkey !== toB64url(input.keys.encPubKeySpki)
      || deviceRow.mkWrap !== input.mkWrapDevice) {
      throw new Error("published device row does not match the delivered keys and wrap");
    }

    let mkWrap: Wrap;
    try {
      mkWrap = JSON.parse(input.mkWrapDevice) as Wrap;
    } catch {
      throw new Error("delivered MK wrap is not valid JSON");
    }
    if (!publishedEntry.mkWrapHash || await wrapHash(mkWrap) !== publishedEntry.mkWrapHash) {
      throw new Error("delivered MK wrap hash does not match the published roster");
    }
    await assertMkWrapAuthorized(mkWrap, account);

    const device: Omit<DeviceSecrets, "mk"> = {
      accountId: input.accountId,
      deviceId: input.deviceId,
      sigPubKey: input.keys.sigPubKey,
      sigPrivPkcs8: input.keys.sigPrivPkcs8,
      encPubSpki: input.keys.encPubKeySpki,
      encPrivPkcs8: input.keys.encPrivPkcs8,
    };
    mk = await openOwnMasterKey(device, input.accountEpoch, mkWrap);
    await deps.onBoundary?.("keys-ready");

    const load = deps.loadDevice ?? loadDevice;
    const save = deps.saveDevice ?? saveDevice;
    const local = await load(input.accountId);
    if (local) {
      const localDevice = "secrets" in local ? local.secrets : local.device;
      assertSameLocalDevice(localDevice, device);
      if (!("secrets" in local) || !sameBytes(local.secrets.mk, mk)) {
        await save({ ...device, mk });
      }
    } else {
      await save({ ...device, mk });
    }
    await deps.persistCheckpoint?.();
    await deps.onBoundary?.("persisted");
    return { accountId: input.accountId, deviceId: input.deviceId };
  } finally {
    mk?.fill(0);
    await pair.account.release();
    await pair.global.release();
  }
}

/** Persist the device secrets, POST /v1/keys/admit, retrying 409s by rebuilding the
 *  roster against the new head with the SAME keypair (crash-safe, D3/D4). `build`
 *  produces a RedeemResult for a given head roster + the reused keypair. */
const headRoster = (dto: AccountKeysDTO): SignedRoster => JSON.parse(dto.rosters[dto.rosters.length - 1]!) as SignedRoster;

async function admitWithRetry(api: RboxApi, deviceId: string, initial: RedeemResult, rebuild: (dto: AccountKeysDTO) => Promise<RedeemResult>, persist = true): Promise<void> {
  // Persist the device + MK locally BEFORE admit (D3): the keypair is durable, so a
  // lost admit-response can be finalized on the next run rather than wedging.
  let result = initial;
  if (persist) await saveDevice(result.secrets);
  for (let attempt = 0; attempt <= ADMIT_RETRIES; attempt++) {
    const res = await api.admitDevice({
      device: { deviceId, sigPubKey: result.device.sigPubKey, encPubKey: result.device.encPubKey, mkWrap: JSON.stringify(result.device.mkWrap) },
      roster: { version: JSON.parse(result.admissionRoster.body).version as number, signed: JSON.stringify(result.admissionRoster) },
    });
    if (res.ok) return;
    // 409: someone advanced the roster. If our device already landed (lost response),
    // we're done; otherwise rebuild against the new head with the SAME keypair.
    const dto = await api.getAccountKeys();
    if (!dto) throw new Error("account key chain vanished mid-admit (fatal)");
    if (dto.devices.some((d) => d.deviceId === deviceId)) return; // our earlier attempt actually succeeded
    if (attempt === ADMIT_RETRIES) throw new Error("admit kept conflicting — try again");
    result = await rebuild(dto);
    if (persist) await saveDevice(result.secrets); // keypair unchanged; roster parent updated
  }
}

/** Connect this machine via a split-secret pairing token (D3/D4/D7). */
export async function enrollViaPairing(remoteUrl: string, fullToken: string, now: number, label?: string): Promise<{ accountId: string; deviceId: string }> {
  const { redeemToken, tokenSecret } = parsePairingToken(fullToken);
  const global=await acquireClearMachineGenesisForPairing();let targetLock:GenesisLock|undefined;
  try{const res = await fetch(`${remoteUrl}/v1/auth/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: redeemToken, ...(label ? { label } : {}) }),
  });
  if (!res.ok) throw await pairingRedeemError(res);
  const raw=await res.json() as unknown;if(typeof raw!=="object"||raw===null||Array.isArray(raw)||Object.keys(raw).length!==5||!["token","deviceId","accountId","mkWrap","admissionGrant"].every((key)=>Object.hasOwn(raw,key)))throw new Error("malformed pairing response");
  const redeem=raw as {token:unknown;deviceId:unknown;accountId:unknown;mkWrap:unknown;admissionGrant:unknown};if(typeof redeem.token!=="string"||!redeem.token||typeof redeem.deviceId!=="string"||!redeem.deviceId||typeof redeem.accountId!=="string"||!ACCOUNT_ID_RE.test(redeem.accountId)||typeof redeem.mkWrap!=="string"||typeof redeem.admissionGrant!=="string")throw new Error("malformed pairing response");
  const accountId=redeem.accountId,pairedDeviceId=redeem.deviceId,pairedToken=redeem.token,mkWrap=redeem.mkWrap,admissionGrant=redeem.admissionGrant;
  targetLock=await acquireAccountGenesisLock(accountId);await global.release();
  if (!redeem.mkWrap || !redeem.admissionGrant) throw new Error("this pairing token carries no key material — it predates E2EE. Generate a fresh one with `rbox pair`.");

  const api = new RboxApi(remoteUrl, pairedToken, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  assertSignedAccountId(accountId, account.currentRoster.accountId); // D7

  const material = { mkWrap: JSON.parse(mkWrap) as Wrap, admissionGrant: JSON.parse(admissionGrant) as { grant: string; grantSig: string; admissionPubKey: string; grantSignerDeviceId: string } };
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() }; // one keypair, reused across 409 retries (D3)
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await redeemPairing({ accountId, deviceId:pairedDeviceId, tokenSecret, accountEpoch: account.currentEpoch, material, prevRoster: headRoster(curDto), now, deviceKeys: keys });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap); // D4
    return r;
  };

  const initial = await build(dto);
  await saveCredentials({ token:pairedToken, deviceId:pairedDeviceId, remoteUrl, accountId });
  await admitWithRetry(api, pairedDeviceId, initial, build);
  return { accountId, deviceId:pairedDeviceId };
  }finally{await global.release().catch(()=>{});await targetLock?.release().catch(()=>{});}
}

/** Recover this machine from the phrase (D10): needs an existing device credential
 *  (the caller logged in first); RK unlocks MK + RSK to self-admit. */
export async function enrollViaRecovery(phrase: string, now: number, loaded?: CredentialLoadResult): Promise<{ accountId: string; deviceId: string }> {
  let rk: Uint8Array;
  try { rk = await phraseToRk(phrase) }
  catch (error) { throw new RecoveryPreAdmissionError(error) }
  try { return await enrollViaPrevalidatedRecovery(rk, now, loaded) }
  finally { rk.fill(0) }
}

/** Read-only validation used before saving a typed/cached phrase. It authenticates
 * the signed account, exact current recovery-wrap identity, and the candidate's
 * ability to decrypt that envelope, but never persists or admits anything. */
export async function validatePhraseForAccount(
  phrase: string,
  loaded?: CredentialLoadResult,
  deps: { api?: Pick<RboxApi, "getAccountKeys"> } = {}
): Promise<void> {
  const { accountId, account, wrap } = await currentRecoveryContext(loaded, deps);
  const rk = await phraseToRk(phrase);
  let mk: Uint8Array | undefined;
  try {
    mk = await recoverMasterKey(accountId, account.currentEpoch, rk, wrap);
  } finally {
    rk.fill(0);
    mk?.fill(0);
  }
}

async function currentRecoveryContext(loaded?: CredentialLoadResult, deps: { api?: Pick<RboxApi, "getAccountKeys"> } = {}) {
  const creds = credentialsForStrictFlow(loaded ?? await loadCredentials());
  if (!creds?.accountId) throw new Error("`rbox key save` needs an account login first — run `rbox login`");
  const api = deps.api ?? new RboxApi(creds.remoteUrl, creds.token, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  assertSignedAccountId(creds.accountId, account.currentRoster.accountId);
  if (!dto.recoveryWrap) throw new Error("no recovery wrap stored for this account");
  const wrap = JSON.parse(dto.recoveryWrap) as Wrap;
  await assertCurrentRecoveryWrap(wrap, account);
  return { accountId: creds.accountId, account, wrap };
}

/** Read-only actionable-offer preflight: signed account and exact current wrap
 * are available, without trying a candidate or mutating admission state. */
export async function preflightRecoveryEnvelope(loaded?: CredentialLoadResult, deps: { api?: Pick<RboxApi, "getAccountKeys"> } = {}): Promise<void> {
  await currentRecoveryContext(loaded, deps);
}

export async function assertRecoveryGenesisReady(loaded?:CredentialLoadResult):Promise<void>{const creds=credentialsForStrictFlow(loaded??await loadCredentials());if(!creds?.accountId)throw new Error("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");const api=new RboxApi(creds.remoteUrl,creds.token,"","");const lock=await acquireClearKnownAccountGenesis(api,creds.accountId);await lock.release();}

export async function enrollViaRecoveryWithPhraseInput(readPhrase:()=>Promise<string>,now:number,loaded?:CredentialLoadResult,beforePhraseRead?:()=>Promise<void>):Promise<{accountId:string;deviceId:string;phrase:string}>{
  const creds=credentialsForStrictFlow(loaded??await loadCredentials());if(!creds?.accountId)throw new Error("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");const api=new RboxApi(creds.remoteUrl,creds.token,"","");const pair=await acquireClearKnownAccountGenesisPair(api,creds.accountId);
  try{await beforePhraseRead?.();await settleKnownAccountGenesisLocked(api,creds.accountId);const phrase=(await readPhrase()).trim();if(!phrase)throw new Error("no phrase entered");const rk=await phraseToRk(phrase);try{const result=await enrollViaPrevalidatedRecoveryLocked(rk,now,creds,creds.accountId,api);return{...result,phrase};}finally{rk.fill(0);}}
  finally{await pair.account.release();await pair.global.release();}
}

/** Recovery continuation for callers that already passed the local BIP39 gate. */
export async function enrollViaPrevalidatedRecovery(rk: Uint8Array, now: number, loaded?: CredentialLoadResult): Promise<{ accountId: string; deviceId: string }> {
  const creds = credentialsForStrictFlow(loaded ?? await loadCredentials());
  if (!creds?.accountId) throw new Error("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");
  const api = new RboxApi(creds.remoteUrl, creds.token, "", "");
  const genesisLocks=await acquireClearKnownAccountGenesisPair(api,creds.accountId);
  try{return await enrollViaPrevalidatedRecoveryLocked(rk,now,creds,creds.accountId,api);}
  finally{await genesisLocks.account.release();await genesisLocks.global.release();}
}

async function enrollViaPrevalidatedRecoveryLocked(rk:Uint8Array,now:number,creds:NonNullable<ReturnType<typeof credentialsForStrictFlow>>,accountId:string,api:RboxApi):Promise<{accountId:string;deviceId:string}>{
  let prepared: { deviceId: string; initial: RedeemResult; build: (curDto: AccountKeysDTO) => Promise<RedeemResult> };
  try {
    const dto = await api.getAccountKeys();
    if (!dto) throw new Error("account has no key material (fatal)");
    const { account } = await verifyDto(dto);
    assertSignedAccountId(accountId, account.currentRoster.accountId);
    if (!dto.recoveryWrap) throw new Error("no recovery wrap stored for this account");

    const recoveryWrap = JSON.parse(dto.recoveryWrap) as Wrap;
    await assertCurrentRecoveryWrap(recoveryWrap, account);
    // A recovered device is a FRESH roster principal — never reuse the credential's
    // deviceId (it may already be an entry, e.g. recovering on the same machine that
    // lost its keystore) which would collide as a duplicate roster deviceId.
    const deviceId = `rec_${toB64url(randomBytes(6))}`;
    const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() }; // one keypair, reused across 409 retries (D3)
    const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
      const r = await buildRecoveryAdmission({ accountId, accountEpoch: account.currentEpoch, deviceId, recoveryKey: rk, recoveryWrap, prevRoster: headRoster(curDto), now, deviceKeys: keys });
      await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap);
      return r;
    };
    const initial = await build(dto);
    prepared = { deviceId, initial, build };
  } catch (error) {
    throw new RecoveryPreAdmissionError(error);
  }
  await admitWithRetry(api, prepared.deviceId, prepared.initial, prepared.build);
  return { accountId, deviceId: prepared.deviceId };
}

/** Admit a locally generated agent/API-key device without replacing the issuing
 *  machine's own keystore. The PAT bearer must already authenticate as `deviceId`;
 *  the issuer signs the admission grant, and the new device self-admits through
 *  the same verified roster path as pairing. */
export async function admitAgentDevice(args: {
  remoteUrl: string;
  bearer: string;
  accountId: string;
  deviceId: string;
  issuer: DeviceSecrets;
  expiresAt: number;
  now: number;
}): Promise<DeviceSecrets> {
  const api = new RboxApi(args.remoteUrl, args.bearer, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  assertSignedAccountId(args.accountId, account.currentRoster.accountId);

  const tokenSecret = randomBytes(32);
  const tokenId = newAgentId();
  const material = await buildPairing(args.issuer, { accountEpoch: account.currentEpoch, tokenId, tokenSecret, notAfter: args.expiresAt });
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() };
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await redeemPairing({
      accountId: args.accountId,
      deviceId: args.deviceId,
      tokenSecret,
      accountEpoch: account.currentEpoch,
      material,
      prevRoster: headRoster(curDto),
      now: args.now,
      deviceKeys: keys,
    });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap);
    return r;
  };

  const initial = await build(dto);
  await admitWithRetry(api, args.deviceId, initial, build, false);
  return initial.secrets;
}

// ---- the sync seam ---------------------------------------------------------

/**
 * Load device secrets for the account, healing a partial keystore (D8): if
 * device.json is present but mk.key is missing, re-open this device's own
 * server-stored MK wrap and save it. A MISSING device.json → not enrolled (D6).
 */
async function ensureSecrets(api: RboxApi, accountId: string): Promise<DeviceSecrets> {
  await assertNoPendingGenesis(accountId);
  const loaded = await loadDevice(accountId);
  if (loaded && "secrets" in loaded) return loaded.secrets;
  if (!loaded) {
    throw new Error("this machine isn't enrolled for encryption — run `rbox pair` on a signed-in machine and connect with the token, or `rbox key recover`.");
  }
  // device.json present, mk.key missing → re-derive MK from the server wrap (C7/D8),
  // using the account's verified current epoch (not a hardcoded 0).
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  const mine = dto.devices.find((d) => d.deviceId === loaded.device.deviceId);
  if (!mine?.mkWrap) throw new Error("no MK wrap stored for this device — run `rbox key recover`.");
  const wrap = JSON.parse(mine.mkWrap) as Wrap;
  await assertMkWrapAuthorized(wrap, account);
  const mk = await openOwnMasterKey(loaded.device, account.currentEpoch, wrap);
  await saveMasterKey(accountId, mk);
  return { ...loaded.device, mk };
}

/**
 * Build the authed E2EE sync deps for a workspace (D6 fail-closed): no E2EE
 * marker / no enrollment → throw before any sync. Returns the cfg (with the
 * blob-encryption KEK set from the frozen write context) and the E2eeRemote.
 */
export async function buildAuthedRemote(root: string, now: () => number = Date.now, warningSink?: (line: string) => void, loaded?: CredentialLoadResult): Promise<{ cfg: WorkspaceConfig; deps: SyncDeps; remote: E2eeRemote }> {
  const cfg = await loadConfig(root);
  if ((cfg as { schema?: string }).schema !== "e2ee/v1") {
    throw new Error("this workspace predates full E2EE — re-run `rbox init` to re-enroll (greenfield; dev data is wiped).");
  }
  const creds = credentialsForStrictFlow(loaded ?? await loadCredentials());
  if (!creds) throw new Error("not logged in — run `rbox login`");
  if (!creds.accountId) throw new Error("credential has no account — re-run `rbox login`");

  // ONE effective remote for both the network client and the returned cfg (design 44
  // §2): the sync-state stream stamp derives from cfg.remoteUrl, so the cfg
  // must name the remote actually being talked to — otherwise a baseline built against
  // prod could be accepted while syncing a same-id workspace on a different server,
  // and its divergent (or empty) head would reconcile as local deletes.
  const remoteUrl = creds.remoteUrl ?? cfg.remoteUrl;
  const api = new RboxApi(remoteUrl, creds.token, cfg.remoteWorkspaceId, cfg.projectId, warningSink);
  const secrets = await ensureSecrets(api, creds.accountId);
  const remote = new E2eeRemote(api, { accountId: creds.accountId, workspaceId: cfg.remoteWorkspaceId, secrets, now, ...(warningSink ? { warningSink } : {}) }, keystorePinStore(creds.accountId, cfg.remoteWorkspaceId));
  const writeContext = await remote.currentKek(); // frozen write epoch (D1)
  // `remote` is returned alongside `deps` so version-history commands can reach the
  // E2eeRemote history/restore/advisoryTimes methods directly (the raw transport stays
  // encapsulated); push/pull/sync ignore it and use `deps` as before.
  return {
    cfg: {
      ...cfg,
      remoteUrl,
      token: creds.token,
      encrypted: true,
      kek: Buffer.from(writeContext.kek),
      accountId: writeContext.accountId,
      accountEpoch: writeContext.accountEpoch,
      keyEpoch: writeContext.keyEpoch,
    },
    deps: { remote, ...(warningSink ? { warningSink } : {}) },
    remote,
  };
}

export { hasDevice };
