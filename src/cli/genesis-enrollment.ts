import fs from "node:fs/promises";
import { assertMkWrapAuthorized, canonicalString, parseStrict, recoverMasterKey, rkToPhrase, sha256Hex, utf8, verifyAccount, wrapHash, type SignedKeyState, type SignedRoster, type Wrap } from "../engine/e2ee/index.js";
import type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence } from "./e2ee-remote.js";
import { loadDevice } from "./e2ee-keystore.js";
import { activeGenesisQuarantines } from "./genesis-quarantine.js";
import { GENESIS_ACCOUNT_ID_RE, GENESIS_REPAIR_ID_RE, CompletionIntent, CompletionIntentRetargetWitness, GenesisJournal, GenesisPrepublishMarker, genesisPaths, loadStagedRecoveryKey, parseCompletionIntent, parseGenesisJournal, parsePrepublishMarker, parseRetargetWitness } from "./genesis-durable.js";

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
  return{...(marker?{marker}:{}),...(journal?{journal}:{}),stagedRk:await present(paths.stagedRk),device:await present(paths.device),mk:await present(paths.mk),...(await readOptional(paths.intent)===undefined?{}:{intentRaw:(await readOptional(paths.intent))!}),...(await readOptional(paths.witness)===undefined?{}:{witnessRaw:(await readOptional(paths.witness))!}),activeQuarantines:await activeGenesisQuarantines(accountId)};
}

export async function pendingGenesisState(accountId:string):Promise<boolean>{if(!GENESIS_ACCOUNT_ID_RE.test(accountId))return false;const p=await inspectPendingGenesis(accountId);return!!(p.marker||p.journal||p.stagedRk||p.intentRaw||p.witnessRaw||p.activeQuarantines.length);}

const allZero=(p:GenesisPresence)=>Object.values(p).every((n)=>n===0);
const sentinel="rbox:genesis-repair-tombstone:v1";
function exactTombstone(observation:GenesisAccountObservation):{repairId:string}|null{if(!observation.claim)return null;const d=observation.claim,t=observation.repairTombstone;return d.recoveryWrap===sentinel&&d.recoveryWrapId===sentinel&&d.genesisDeviceId===null&&!!t&&t.version===1&&GENESIS_REPAIR_ID_RE.test(t.repairId)&&Number.isSafeInteger(t.repairedAt)&&t.repairedAt>0&&typeof d.claimCreatedAt==="number"&&Number.isSafeInteger(d.claimCreatedAt)&&d.claimCreatedAt>0?{repairId:t.repairId}:null;}
function tombstoneFamily(d:AccountKeysDTO):boolean{return d.recoveryWrap===sentinel||d.recoveryWrapId===sentinel||d.repairTombstone!=null;}
function legacyOrphan(d:AccountKeysDTO,p:GenesisPresence):boolean{return typeof d.recoveryWrap==="string"&&Buffer.byteLength(d.recoveryWrap)>0&&Buffer.byteLength(d.recoveryWrap)<=65536&&typeof d.recoveryWrapId==="string"&&Buffer.byteLength(d.recoveryWrapId)>0&&Buffer.byteLength(d.recoveryWrapId)<=65536&&typeof d.claimCreatedAt==="number"&&Number.isSafeInteger(d.claimCreatedAt)&&d.claimCreatedAt>0&&d.genesisDeviceId===null&&d.repairTombstone===null&&allZero(p);}

async function validateCompleteAccount(accountId:string,dto:AccountKeysDTO,presence:GenesisPresence):Promise<void>{
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
}

function requestObject(journal:GenesisJournal):Record<string,unknown>{const parsed=parseStrict(journal.requestBody);if(typeof parsed!=="object"||parsed===null||Array.isArray(parsed))throw new Error("invalid journal request");return parsed as Record<string,unknown>;}
function exactAttempt(dto:AccountKeysDTO,journal:GenesisJournal):boolean{const b=requestObject(journal),dev=b.device as Record<string,unknown>|undefined;return dto.recoveryWrap===b.recoveryWrap&&dto.recoveryWrapId===b.recoveryWrapId&&dto.rosters[0]===b.genesisRoster&&dto.keyStates[0]===b.genesisKeyState&&!!dev&&dto.devices.some((row)=>row.deviceId===dev.deviceId&&row.sigPubkey===dev.sigPubKey&&row.encPubkey===dev.encPubKey&&row.mkWrap===dev.mkWrap);}

async function validateAttemptMaterial(accountId:string,journal:GenesisJournal):Promise<string>{
  const loaded=await loadDevice(accountId);if(!loaded||!("secrets" in loaded)||loaded.secrets.deviceId!==journal.deviceId)throw new Error("journal device material mismatch");const rk=await loadStagedRecoveryKey(accountId),request=requestObject(journal);if(typeof request.recoveryWrap!=="string")throw new Error("journal recovery wrap missing");const mk=await recoverMasterKey(accountId,0,rk,JSON.parse(request.recoveryWrap) as Wrap);if(!Buffer.from(mk).equals(Buffer.from(loaded.secrets.mk)))throw new Error("staged recovery key does not authenticate journal MK");return rkToPhrase(rk);
}

export async function classifyEnrollment(accountId:string,observation:GenesisAccountObservation,pending?:PendingGenesisArtifacts):Promise<EnrollmentClassification>{
  try{
    const local=pending??await inspectPendingGenesis(accountId),claim=observation.claim,tomb=exactTombstone(observation),hasPartial=local.device||local.mk||local.stagedRk||!!local.intentRaw||!!local.witnessRaw;
    if(!claim&&!allZero(observation.present))return{kind:"integrity-failure",reason:"claim-absent child state"};
    if(local.activeQuarantines.length){if(!tomb||local.activeQuarantines.length!==1||local.activeQuarantines[0]!.purpose!=="repaired-legacy"||local.activeQuarantines[0]!.key!==tomb.repairId)return{kind:"integrity-failure",reason:"quarantine/tombstone mismatch"};return{kind:"quarantine-resume",repairId:tomb.repairId};}
    if(local.journal){const journal=local.journal;if(journal.phase==="cleanup")return{kind:"cleanup-resume",journal};const phrase=await validateAttemptMaterial(accountId,journal);const body=requestObject(journal),expectedRepair=typeof body.repairId==="string"?body.repairId:null;
      if(!claim){if(!allZero(observation.present)||expectedRepair!==null)return{kind:"integrity-failure",reason:"journal/server expected-previous mismatch"};return{kind:"resume-attempt",journal};}
      if(tomb){if(expectedRepair!==tomb.repairId)return{kind:"integrity-failure",reason:"journal repair id mismatch"};return{kind:"resume-attempt",journal};}
      if(tombstoneFamily(claim))return{kind:"integrity-failure",reason:"malformed repair tombstone"};await validateCompleteAccount(accountId,claim,observation.present);
      if(!exactAttempt(claim,journal))return{kind:"competing-genesis",journal};let intent:CompletionIntent|undefined,witness:CompletionIntentRetargetWitness|undefined;if(local.witnessRaw!==undefined)witness=await parseRetargetWitness(local.witnessRaw,journal);if(local.intentRaw!==undefined)intent=parseCompletionIntent(local.intentRaw,journal);if(witness&&!intent)throw new Error("RETARGET witness without canonical intent");return{kind:"committed-this-attempt",journal,phrase,...(intent?{intent}:{}),...(witness?{witness}:{})};}
    if(local.marker){if(hasPartial&&(local.intentRaw||local.witnessRaw))return{kind:"integrity-failure",reason:"completion state without journal"};if(!claim&&allZero(observation.present)&&local.marker.repairId===null)return{kind:"restart-prepublication",marker:local.marker};if(tomb&&local.marker.repairId===tomb.repairId)return{kind:"restart-prepublication",marker:local.marker};return{kind:"integrity-failure",reason:"prepublish marker expected-previous mismatch"};}
    if(!claim)return hasPartial?{kind:"integrity-failure",reason:"unmarked local genesis material"}:{kind:"pristine"};
    if(tomb){if(!allZero(observation.present))return{kind:"integrity-failure",reason:"child-bearing repair tombstone"};if(local.device&&local.mk&&!local.stagedRk&&!local.intentRaw&&!local.witnessRaw)return{kind:"repaired-legacy",repairId:tomb.repairId};return hasPartial?{kind:"integrity-failure",reason:"malformed repaired legacy local state"}:{kind:"repair-ready",repairId:tomb.repairId};}
    if(tombstoneFamily(claim))return{kind:"integrity-failure",reason:"malformed repair tombstone"};if(legacyOrphan(claim,observation.present))return{kind:"legacy-orphan"};await validateCompleteAccount(accountId,claim,observation.present);return hasPartial?{kind:"integrity-failure",reason:"unmarked pending material beside enrolled account"}:{kind:"enrolled",dto:claim};
  }catch(error){return{kind:"integrity-failure",reason:error instanceof Error?error.message:"genesis classification failed"};}
}

export function legacyOrphanError():Error{return Object.assign(new Error("this account's encryption setup is incomplete; pairing and recovery cannot repair it. Local recovery material was preserved. Contact rbox support for atomic-genesis repair, then retry setup."),{code:"legacy_orphan"});}
