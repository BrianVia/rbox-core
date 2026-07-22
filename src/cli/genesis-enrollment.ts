import fs from "node:fs/promises";
import { assertMkWrapAuthorized, canonicalString, fromB64url, openOwnMasterKey, parseStrict, recoverMasterKey, rkToPhrase, sha256Hex, toB64url, utf8, verifyAccount, wrapHash, type SignedKeyState, type SignedRoster, type Wrap } from "../engine/e2ee/index.js";
import type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence } from "./e2ee-remote.js";
import { loadDevice } from "./e2ee-keystore.js";
import { activeGenesisQuarantines, genesisQuarantineStatus } from "./genesis-quarantine.js";
import { GENESIS_ACCOUNT_ID_RE, GENESIS_REPAIR_ID_RE, CompletionIntent, CompletionIntentRetargetWitness, GenesisJournal, GenesisPrepublishMarker, genesisEnrollmentWitnessMatches, genesisEnrollmentWitnessPresent, genesisPaths, loadStagedRecoveryKey, parseCompletionIntent, parseGenesisBootstrapRequest, parseGenesisJournal, parsePrepublishMarker, parseRetargetWitness, publishGenesisEnrollmentWitness } from "./genesis-durable.js";

export type EnrollmentClassification=
  |{kind:"pristine"}|{kind:"restart-prepublication";marker:GenesisPrepublishMarker}|{kind:"resume-attempt";journal:GenesisJournal}
  |{kind:"cleanup-resume";journal:GenesisJournal}|{kind:"committed-this-attempt";journal:GenesisJournal;phrase:string;intent?:CompletionIntent;witness?:CompletionIntentRetargetWitness}
  |{kind:"competing-genesis";journal:GenesisJournal}|{kind:"enrolled";dto:AccountKeysDTO}|{kind:"legacy-orphan"}
  |{kind:"repaired-legacy";repairId:string}|{kind:"quarantine-resume";repairId:string}|{kind:"repair-ready";repairId:string}
  |{kind:"integrity-failure";reason:string};

export interface PendingGenesisArtifacts{marker?:GenesisPrepublishMarker;journal?:GenesisJournal;stagedRk:boolean;device:boolean;mk:boolean;intentRaw?:string;witnessRaw?:string;activeQuarantines:Array<{purpose:"repaired-legacy"|"abandoned-attempt";key:string}>}

async function readOptional(file:string):Promise<string|undefined>{try{return await fs.readFile(file,"utf8");}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw error;}}
async function present(file:string):Promise<boolean>{try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error(`unsafe genesis artifact: ${file}`);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}

export async function inspectPendingGenesis(accountId:string):Promise<PendingGenesisArtifacts>{
  const paths=genesisPaths(accountId);const markerRaw=await readOptional(paths.marker),journalRaw=await readOptional(paths.journal);
  const marker=markerRaw===undefined?undefined:parsePrepublishMarker(markerRaw,accountId);const journal=journalRaw===undefined?undefined:await parseGenesisJournal(journalRaw,accountId);
  const intentRaw=await readOptional(paths.intent),witnessRaw=await readOptional(paths.witness);
  return{...(marker?{marker}:{}),...(journal?{journal}:{}),stagedRk:await present(paths.stagedRk),device:await present(paths.device),mk:await present(paths.mk),...(intentRaw===undefined?{}:{intentRaw}),...(witnessRaw===undefined?{}:{witnessRaw}),activeQuarantines:await activeGenesisQuarantines(accountId)};
}

export async function pendingGenesisState(accountId:string):Promise<boolean>{if(!GENESIS_ACCOUNT_ID_RE.test(accountId))return false;const p=await inspectPendingGenesis(accountId);return!!(p.marker||p.journal||p.stagedRk||p.intentRaw||p.witnessRaw||p.activeQuarantines.length);}

const legacyDeviceKeys=["deviceId","sigPubKey","sigPrivPkcs8","encPubSpki","encPrivPkcs8"] as const;
const exactKeys=(value:object,keys:readonly string[])=>{const actual=Object.keys(value);return actual.length===keys.length&&actual.every((key)=>keys.includes(key));};
const plain=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value);

/** The only local no-journal shape that may be archived after operator repair.
 * Presence alone is not proof: parse the exact historical device schema and a
 * canonical 32-byte MK before the classifier can return repaired-legacy. */
export async function hasExactLegacyGenesisPair(accountId:string):Promise<boolean>{
  const paths=genesisPaths(accountId);let deviceRaw:string,mkRaw:string;try{[deviceRaw,mkRaw]=await Promise.all([fs.readFile(paths.device,"utf8"),fs.readFile(paths.mk,"utf8")]);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}
  const device=parseStrict(deviceRaw);if(!plain(device)||!exactKeys(device,legacyDeviceKeys)||typeof device.deviceId!=="string"||!device.deviceId)return false;
  for(const key of legacyDeviceKeys.slice(1))if(typeof device[key]!=="string"||!device[key])return false;
  try{if(fromB64url(mkRaw.trim()).length!==32)return false;const loaded=await loadDevice(accountId);return!!loaded&&"secrets" in loaded&&loaded.secrets.mk.length===32;}catch{return false;}
}

/** Pending state always wins. Otherwise an exact, byte-bound local enrollment
 * witness removes the network dependency; absent or invalid witnesses retain
 * the conservative legacy-pair consultation behavior. */
export async function genesisClassifierConsultationNeeded(accountId:string):Promise<boolean>{
  if(!GENESIS_ACCOUNT_ID_RE.test(accountId))return false;
  if(await pendingGenesisState(accountId))return true;
  if(await genesisEnrollmentWitnessPresent(accountId))return!(await genesisEnrollmentWitnessMatches(accountId));
  return await hasExactLegacyGenesisPair(accountId);
}

const allZero=(p:GenesisPresence)=>Object.values(p).every((n)=>n===0);
const sentinel="rbox:genesis-repair-tombstone:v1";
function exactTombstone(observation:GenesisAccountObservation):{repairId:string}|null{if(!observation.claim)return null;const d=observation.claim,t=observation.repairTombstone;return d.recoveryWrap===sentinel&&d.recoveryWrapId===sentinel&&d.genesisDeviceId===null&&!!t&&t.version===1&&GENESIS_REPAIR_ID_RE.test(t.repairId)&&Number.isSafeInteger(t.repairedAt)&&t.repairedAt>0&&typeof d.claimCreatedAt==="number"&&Number.isSafeInteger(d.claimCreatedAt)&&d.claimCreatedAt>0?{repairId:t.repairId}:null;}
function tombstoneFamily(d:AccountKeysDTO):boolean{return d.recoveryWrap===sentinel||d.recoveryWrapId===sentinel||d.repairTombstone!=null;}
function legacyOrphan(d:AccountKeysDTO,p:GenesisPresence):boolean{return typeof d.recoveryWrap==="string"&&Buffer.byteLength(d.recoveryWrap)>0&&Buffer.byteLength(d.recoveryWrap)<=65536&&typeof d.recoveryWrapId==="string"&&Buffer.byteLength(d.recoveryWrapId)>0&&Buffer.byteLength(d.recoveryWrapId)<=65536&&typeof d.claimCreatedAt==="number"&&Number.isSafeInteger(d.claimCreatedAt)&&d.claimCreatedAt>0&&d.genesisDeviceId===null&&d.repairTombstone===null&&allZero(p);}

async function validateCompleteAccount(accountId:string,dto:AccountKeysDTO,presence:GenesisPresence){
  if(typeof dto.recoveryWrap!=="string"||Buffer.byteLength(dto.recoveryWrap)===0||Buffer.byteLength(dto.recoveryWrap)>65536
    ||typeof dto.recoveryWrapId!=="string"||Buffer.byteLength(dto.recoveryWrapId)===0||Buffer.byteLength(dto.recoveryWrapId)>65536
    ||dto.recoveryWrap===sentinel||dto.recoveryWrapId===sentinel
    ||typeof dto.claimCreatedAt!=="number"||!Number.isSafeInteger(dto.claimCreatedAt)||dto.claimCreatedAt<=0
    ||!(dto.genesisDeviceId===null||(typeof dto.genesisDeviceId==="string"&&dto.genesisDeviceId.length>0)))throw new Error("malformed real genesis claim");
  if(dto.rosters.length!==presence.rosters||dto.keyStates.length!==presence.keyStates||dto.devices.length!==presence.devices||!dto.rosters.length||!dto.keyStates.length||!dto.devices.length)throw new Error("incomplete genesis inventory");
  const rosters=dto.rosters.map((raw)=>parseStrict(raw) as SignedRoster),keyStates=dto.keyStates.map((raw)=>parseStrict(raw) as SignedKeyState);const account=await verifyAccount(rosters,keyStates);
  if(account.currentRoster.accountId!==accountId||account.rosters[0]?.accountId!==accountId)throw new Error("signed genesis account mismatch");
  if(!dto.recoveryWrap||!dto.recoveryWrapId)throw new Error("missing recovery wrap");const recovery=JSON.parse(dto.recoveryWrap) as Wrap;const recoveryHash=await wrapHash(recovery);
  if(recoveryHash!==dto.recoveryWrapId||account.keyStates.at(-1)?.recoveryWrapId!==dto.recoveryWrapId||!account.authorizedMkWrapHashes.has(recoveryHash))throw new Error("recovery wrap binding mismatch");
  const current=new Map(account.currentRoster.devices.filter((entry)=>entry.kind!=="recovery").map((entry)=>[entry.deviceId,entry]));const historical=new Set(account.rosters.flatMap((roster)=>roster.devices.filter((entry)=>entry.kind!=="recovery").map((entry)=>entry.deviceId)));
  const rows=new Map<string,AccountKeysDTO["devices"][number]>();for(const row of dto.devices){if(typeof row.deviceId!=="string"||!row.deviceId||typeof row.sigPubkey!=="string"||!row.sigPubkey||typeof row.encPubkey!=="string"||!row.encPubkey||typeof row.mkWrap!=="string"||!row.mkWrap||rows.has(row.deviceId))throw new Error("malformed or duplicate device row");rows.set(row.deviceId,row);}
  if(rows.size!==historical.size)throw new Error("device inventory mismatch");for(const id of historical){const row=rows.get(id),entry=current.get(id)??account.rosters.flatMap((r)=>r.devices).reverse().find((d)=>d.deviceId===id);if(!row||!entry||row.sigPubkey!==entry.sigPubKey||row.encPubkey!==entry.encPubKey)throw new Error("device identity binding mismatch");const wrap=JSON.parse(row.mkWrap!) as Wrap;if(await wrapHash(wrap)!==entry.mkWrapHash)throw new Error("device wrap binding mismatch");await assertMkWrapAuthorized(wrap,account);}
  const first=account.rosters[0]!.devices.filter((entry)=>entry.kind==="device");if(dto.genesisDeviceId!==null&&dto.genesisDeviceId!==undefined&&(first.length!==1||dto.genesisDeviceId!==first[0]!.deviceId))throw new Error("genesis device marker mismatch");
  return account;
}

async function validateLocalEnrolledPair(accountId:string,dto:AccountKeysDTO,account:Awaited<ReturnType<typeof verifyAccount>>):Promise<void>{
  const loaded=await loadDevice(accountId);if(!loaded||!("secrets" in loaded))throw new Error("local enrolled device/MK pair is incomplete");
  const row=dto.devices.find((candidate)=>candidate.deviceId===loaded.secrets.deviceId);if(!row?.mkWrap||row.sigPubkey!==toB64url(loaded.secrets.sigPubKey)||row.encPubkey!==toB64url(loaded.secrets.encPubSpki))throw new Error("local enrolled device is not bound to the verified roster");
  const opened=await openOwnMasterKey(loaded.secrets,account.currentEpoch,JSON.parse(row.mkWrap) as Wrap);if(!Buffer.from(opened).equals(Buffer.from(loaded.secrets.mk)))throw new Error("local master key does not authenticate the enrolled device wrap");
}

function requestObject(journal:GenesisJournal):Record<string,unknown>{return parseGenesisBootstrapRequest(journal.requestBody,journal.deviceId) as unknown as Record<string,unknown>;}
function exactAttempt(dto:AccountKeysDTO,journal:GenesisJournal):boolean{const b=requestObject(journal),dev=b.device as Record<string,unknown>|undefined;return dto.recoveryWrap===b.recoveryWrap&&dto.recoveryWrapId===b.recoveryWrapId&&dto.rosters[0]===b.genesisRoster&&dto.keyStates[0]===b.genesisKeyState&&!!dev&&dto.devices.some((row)=>row.deviceId===dev.deviceId&&row.sigPubkey===dev.sigPubKey&&row.encPubkey===dev.encPubKey&&row.mkWrap===dev.mkWrap);}

async function validateJournalDeviceMaterial(accountId:string,journal:GenesisJournal):Promise<void>{
  const loaded=await loadDevice(accountId);if(!loaded||!("secrets" in loaded)||loaded.secrets.deviceId!==journal.deviceId)throw new Error("journal device material mismatch");
  const request=requestObject(journal),device=request.device;if(!plain(device)||device.deviceId!==journal.deviceId||device.sigPubKey!==toB64url(loaded.secrets.sigPubKey)||device.encPubKey!==toB64url(loaded.secrets.encPubSpki)||typeof device.mkWrap!=="string")throw new Error("journal device material mismatch");
  const opened=await openOwnMasterKey(loaded.secrets,0,JSON.parse(device.mkWrap) as Wrap);if(!Buffer.from(opened).equals(Buffer.from(loaded.secrets.mk)))throw new Error("journal MK material mismatch");
}

async function validateAttemptMaterial(accountId:string,journal:GenesisJournal):Promise<string>{
  const loaded=await loadDevice(accountId);if(!loaded||!("secrets" in loaded)||loaded.secrets.deviceId!==journal.deviceId)throw new Error("journal device material mismatch");const rk=await loadStagedRecoveryKey(accountId),request=requestObject(journal);if(typeof request.recoveryWrap!=="string")throw new Error("journal recovery wrap missing");const mk=await recoverMasterKey(accountId,0,rk,JSON.parse(request.recoveryWrap) as Wrap);if(!Buffer.from(mk).equals(Buffer.from(loaded.secrets.mk)))throw new Error("staged recovery key does not authenticate journal MK");return rkToPhrase(rk);
}

async function validatePromotedRecoveryKey(accountId:string,journal:GenesisJournal):Promise<void>{
  const raw=(await fs.readFile(genesisPaths(accountId).rk,"utf8")).trim(),rk=fromB64url(raw);if(rk.length!==32)throw new Error("promoted recovery key has invalid length");
  const loaded=await loadDevice(accountId);if(!loaded||!("secrets" in loaded)||loaded.secrets.deviceId!==journal.deviceId)throw new Error("journal device material mismatch");
  const request=requestObject(journal);if(typeof request.recoveryWrap!=="string")throw new Error("journal recovery wrap missing");const mk=await recoverMasterKey(accountId,0,rk,JSON.parse(request.recoveryWrap) as Wrap);if(!Buffer.from(mk).equals(Buffer.from(loaded.secrets.mk)))throw new Error("promoted recovery key does not authenticate journal MK");
}

export async function classifyEnrollment(accountId:string,observation:GenesisAccountObservation,pending?:PendingGenesisArtifacts):Promise<EnrollmentClassification>{
  try{
    const local=pending??await inspectPendingGenesis(accountId),claim=observation.claim,tomb=exactTombstone(observation),hasPartial=local.device||local.mk||local.stagedRk||!!local.intentRaw||!!local.witnessRaw;
    if(!claim&&!allZero(observation.present))return{kind:"integrity-failure",reason:"claim-absent child state"};
    if(local.journal&&local.journal.phase==="cleanup"){
      const journal=local.journal,receipt=journal.completionReceipts["recovery-kit-staging"];if(!receipt)throw new Error("cleanup journal has no receipt");
      if(tomb&&!allZero(observation.present))return{kind:"integrity-failure",reason:"child-bearing repair tombstone"};
      if(receipt.outcome==="competing-cleaned"){
        const status=await genesisQuarantineStatus(accountId,"abandoned-attempt",journal.requestSha256);
        if(status==="absent"&&!(local.stagedRk&&local.device&&local.mk))throw new Error("competing cleanup has neither complete sources nor quarantine");
      }
      else if(journal.originalCacheRecovery){const destination=await present(genesisPaths(accountId).rk);if(local.stagedRk===destination)throw new Error("winning recovery-key promotion requires exactly one of source or destination");if(destination)await validatePromotedRecoveryKey(accountId,journal);else await validateAttemptMaterial(accountId,journal);}
      else await validateJournalDeviceMaterial(accountId,journal);
      return{kind:"cleanup-resume",journal};
    }
    if(local.activeQuarantines.length){if(!tomb||!allZero(observation.present)||local.activeQuarantines.length!==1||local.activeQuarantines[0]!.purpose!=="repaired-legacy"||local.activeQuarantines[0]!.key!==tomb.repairId)return{kind:"integrity-failure",reason:"quarantine/tombstone mismatch"};return{kind:"quarantine-resume",repairId:tomb.repairId};}
    if(local.journal){const journal=local.journal;const phrase=await validateAttemptMaterial(accountId,journal);const body=requestObject(journal),expectedRepair=typeof body.repairId==="string"?body.repairId:null;
      if(!claim){if(!allZero(observation.present)||expectedRepair!==null)return{kind:"integrity-failure",reason:"journal/server expected-previous mismatch"};return{kind:"resume-attempt",journal};}
      if(tomb){if(!allZero(observation.present))return{kind:"integrity-failure",reason:"child-bearing repair tombstone"};if(expectedRepair!==tomb.repairId)return{kind:"integrity-failure",reason:"journal repair id mismatch"};return{kind:"resume-attempt",journal};}
      if(tombstoneFamily(claim))return{kind:"integrity-failure",reason:"malformed repair tombstone"};await validateCompleteAccount(accountId,claim,observation.present);
      if(!exactAttempt(claim,journal))return{kind:"competing-genesis",journal};let intent:CompletionIntent|undefined,witness:CompletionIntentRetargetWitness|undefined;if(local.witnessRaw!==undefined)witness=await parseRetargetWitness(local.witnessRaw,journal);if(local.intentRaw!==undefined)intent=parseCompletionIntent(local.intentRaw,journal);if(witness&&!intent)throw new Error("RETARGET witness without canonical intent");return{kind:"committed-this-attempt",journal,phrase,...(intent?{intent}:{}),...(witness?{witness}:{})};}
    if(local.marker){if(hasPartial&&(local.intentRaw||local.witnessRaw))return{kind:"integrity-failure",reason:"completion state without journal"};if(!claim&&allZero(observation.present)&&local.marker.repairId===null)return{kind:"restart-prepublication",marker:local.marker};if(tomb&&allZero(observation.present)&&local.marker.repairId===tomb.repairId)return{kind:"restart-prepublication",marker:local.marker};return{kind:"integrity-failure",reason:"prepublish marker expected-previous mismatch"};}
    if(!claim)return hasPartial?{kind:"integrity-failure",reason:"unmarked local genesis material"}:{kind:"pristine"};
    if(tomb){if(!allZero(observation.present))return{kind:"integrity-failure",reason:"child-bearing repair tombstone"};if(local.device&&local.mk&&!local.stagedRk&&!local.intentRaw&&!local.witnessRaw)return await hasExactLegacyGenesisPair(accountId)?{kind:"repaired-legacy",repairId:tomb.repairId}:{kind:"integrity-failure",reason:"malformed repaired legacy local state"};return hasPartial?{kind:"integrity-failure",reason:"malformed repaired legacy local state"}:{kind:"repair-ready",repairId:tomb.repairId};}
    if(tombstoneFamily(claim))return{kind:"integrity-failure",reason:"malformed repair tombstone"};if(legacyOrphan(claim,observation.present))return{kind:"legacy-orphan"};const account=await validateCompleteAccount(accountId,claim,observation.present);if(local.stagedRk||local.intentRaw||local.witnessRaw)return{kind:"integrity-failure",reason:"unmarked pending material beside enrolled account"};if(local.device&&local.mk){await validateLocalEnrolledPair(accountId,claim,account);await publishGenesisEnrollmentWitness(accountId);}return{kind:"enrolled",dto:claim};
  }catch(error){return{kind:"integrity-failure",reason:error instanceof Error?error.message:"genesis classification failed"};}
}

export function legacyOrphanError():Error{return Object.assign(new Error("this account's encryption setup is incomplete; pairing and recovery cannot repair it. Local recovery material was preserved. Contact rbox support for atomic-genesis repair, then retry setup."),{code:"legacy_orphan"});}
