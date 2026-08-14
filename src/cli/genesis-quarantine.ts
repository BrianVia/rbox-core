import fs from "node:fs/promises";
import path from "node:path";
import { canonicalString, parseStrict, sha256Hex, utf8 } from "../engine/e2ee/index.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory } from "../engine/fsutil.js";
import { GENESIS_REPAIR_ID_RE, GENESIS_REQUEST_SHA_RE, assertGenesisAccountId, genesisPaths, hardenedRename, hardenedWrite, invalidateGenesisEnrollmentWitness, type HardenedWriteOptions } from "./genesis-durable.js";
import type { JsonObject, JsonValue } from "../json.js";

export type GenesisQuarantinePurpose="repaired-legacy"|"abandoned-attempt";
export type GenesisQuarantineEntry={source:"rk.key.staged"|"device.json"|"mk.key";destination:"rk.key.staged"|"device.json"|"mk.key";sha256:string};
export type GenesisQuarantineManifest={version:1;accountId:string;purpose:GenesisQuarantinePurpose;uniquenessKey:string;createdAt:string;entries:GenesisQuarantineEntry[]};
export type GenesisQuarantineCompleted={version:1;accountId:string;purpose:GenesisQuarantinePurpose;uniquenessKey:string;manifestSha256:string;completedAt:string};

/** One field read out of a parsed JSON object: a JSON value, or absent. */
type JsonField = JsonValue | undefined;

/** `parseStrict` hands back exactly what `JSON.parse` produced — a JSON value. */
const parsed=(raw:string):JsonValue=>parseStrict(raw) as JsonValue;
const exact=(value:object,keys:string[])=>{const actual=Object.keys(value);return actual.length===keys.length&&actual.every((k)=>keys.includes(k));};
const plain=(value:JsonField):value is JsonObject=>typeof value==="object"&&value!==null&&!Array.isArray(value);
const iso=(value:JsonField):value is string=>typeof value==="string"&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value;
const shaRe=/^[0-9a-f]{64}$/;

function directoryName(purpose:GenesisQuarantinePurpose,key:string):string{return purpose==="repaired-legacy"?`genesis-legacy-${key}`:`genesis-attempt-${key}`;}
export function genesisQuarantineDir(accountId:string,purpose:GenesisQuarantinePurpose,key:string):string{assertGenesisAccountId(accountId);if(purpose==="repaired-legacy"?!GENESIS_REPAIR_ID_RE.test(key):!GENESIS_REQUEST_SHA_RE.test(key))throw new Error("invalid genesis quarantine key");return path.join(genesisPaths(accountId).quarantine,directoryName(purpose,key));}

export function parseGenesisQuarantineManifest(raw:string,accountId:string,purpose:GenesisQuarantinePurpose,key:string):GenesisQuarantineManifest{
  const v=parsed(raw);if(!plain(v)||!exact(v,["version","accountId","purpose","uniquenessKey","createdAt","entries"])||v.version!==1||v.accountId!==accountId||v.purpose!==purpose||v.uniquenessKey!==key||!iso(v.createdAt)||!Array.isArray(v.entries))throw new Error("invalid genesis quarantine manifest");
  const names=purpose==="repaired-legacy"?["device.json","mk.key"]:["rk.key.staged","device.json","mk.key"];
  if(v.entries.length!==names.length)throw new Error("invalid genesis quarantine inventory");
  v.entries.forEach((entry,index)=>{if(!plain(entry)||!exact(entry,["source","destination","sha256"])||entry.source!==names[index]||entry.destination!==names[index]||typeof entry.sha256!=="string"||!shaRe.test(entry.sha256))throw new Error("invalid genesis quarantine entry");});
  return v as GenesisQuarantineManifest;
}

export function parseGenesisQuarantineCompleted(raw:string,manifest:GenesisQuarantineManifest,manifestRaw:string):Promise<GenesisQuarantineCompleted>{return(async()=>{const v=parsed(raw);if(!plain(v)||!exact(v,["version","accountId","purpose","uniquenessKey","manifestSha256","completedAt"])||v.version!==1||v.accountId!==manifest.accountId||v.purpose!==manifest.purpose||v.uniquenessKey!==manifest.uniquenessKey||!iso(v.completedAt)||v.manifestSha256!==await sha256Hex(utf8(manifestRaw)))throw new Error("invalid genesis quarantine completion marker");return v as GenesisQuarantineCompleted;})();}

async function fileHash(file:string):Promise<string>{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw new Error(`unsafe genesis quarantine source: ${path.basename(file)}`);return sha256Hex(new Uint8Array(await fs.readFile(file)));}
async function exists(file:string):Promise<boolean>{try{await fs.lstat(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;}}

export type GenesisQuarantineStatus = "absent" | "active" | "completed";

/** Read-only validation used by the classifier and cleanup path. A completed
 * archive is terminal evidence; an active archive must already be executable. */
export async function genesisQuarantineStatus(accountId:string,purpose:GenesisQuarantinePurpose,key:string):Promise<GenesisQuarantineStatus>{
  const dir=genesisQuarantineDir(accountId,purpose,key);
  if(!(await exists(dir)))return"absent";
  const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("unsafe genesis quarantine directory");
  const manifestPath=path.join(dir,"quarantine-resume.json"),completedPath=path.join(dir,"completed.json"),diskEntries=await fs.readdir(dir);
  if(!(await exists(manifestPath))){if(diskEntries.length===0)return"absent";throw new Error("nonempty manifest-less genesis quarantine");}
  const manifestRaw=await fs.readFile(manifestPath,"utf8"),manifest=parseGenesisQuarantineManifest(manifestRaw,accountId,purpose,key);
  const allowed=new Set(["quarantine-resume.json","completed.json",...manifest.entries.map((entry)=>entry.destination)]);
  if(diskEntries.some((entry)=>!allowed.has(entry)))throw new Error("unexpected genesis quarantine entry");
  if(await exists(completedPath)){
    await parseGenesisQuarantineCompleted(await fs.readFile(completedPath,"utf8"),manifest,manifestRaw);
    for(const entry of manifest.entries){if(await fileHash(path.join(dir,entry.destination))!==entry.sha256)throw new Error("completed genesis quarantine hash mismatch");}
    return"completed";
  }
  const root=genesisPaths(accountId).dir;
  for(const entry of manifest.entries){const source=path.join(root,entry.source),destination=path.join(dir,entry.destination),sourceExists=await exists(source),destinationExists=await exists(destination);if(sourceExists===destinationExists)throw new Error("invalid genesis quarantine rename state");if(await fileHash(sourceExists?source:destination)!==entry.sha256)throw new Error("genesis quarantine hash mismatch");}
  return"active";
}

/** Create the durable manifest before any secret source is renamed. Caller owns lock choreography. */
export async function startGenesisQuarantine(args:{accountId:string;purpose:GenesisQuarantinePurpose;uniquenessKey:string;createdAt:string;expectedHashes?:Record<string,string>;writeOptions?:HardenedWriteOptions}):Promise<GenesisQuarantineManifest>{
  const dir=genesisQuarantineDir(args.accountId,args.purpose,args.uniquenessKey),paths=genesisPaths(args.accountId);
  const names=args.purpose==="repaired-legacy"?["device.json","mk.key"] as const:["rk.key.staged","device.json","mk.key"] as const;
  if(await exists(dir)){
    const namesOnDisk=await fs.readdir(dir);if(namesOnDisk.length===0){await fs.rmdir(dir);await fsyncDirectory(path.dirname(dir));}else throw new Error("genesis quarantine already exists and must be resumed");
  }
  await invalidateGenesisEnrollmentWitness(args.accountId);
  const created=await ensureDirectoryChain(dir,"genesis quarantine directory");for(const entry of created)await fs.chmod(entry,0o700);await fsyncCreatedDirectoryAncestors(dir,created);
  const entries:GenesisQuarantineEntry[]=[];
  for(const name of names){const digest=await fileHash(path.join(paths.dir,name));if(args.expectedHashes?.[name]&&args.expectedHashes[name]!==digest)throw new Error("genesis quarantine source hash mismatch");entries.push({source:name,destination:name,sha256:digest});}
  const manifest:GenesisQuarantineManifest={version:1,accountId:args.accountId,purpose:args.purpose,uniquenessKey:args.uniquenessKey,createdAt:args.createdAt,entries};
  await hardenedWrite(path.join(dir,"quarantine-resume.json"),canonicalString(manifest),args.writeOptions);return manifest;
}

export async function resumeGenesisQuarantine(accountId:string,purpose:GenesisQuarantinePurpose,key:string,completedAt:string,writeOptions?:HardenedWriteOptions):Promise<GenesisQuarantineCompleted>{
  const dir=genesisQuarantineDir(accountId,purpose,key),manifestPath=path.join(dir,"quarantine-resume.json"),completedPath=path.join(dir,"completed.json");
  const manifestRaw=await fs.readFile(manifestPath,"utf8");const manifest=parseGenesisQuarantineManifest(manifestRaw,accountId,purpose,key);
  const allowed=new Set(["quarantine-resume.json","completed.json",...manifest.entries.map((e)=>e.destination)]);for(const name of await fs.readdir(dir)){if(!allowed.has(name))throw new Error("unexpected genesis quarantine entry");}
  if(await exists(completedPath)){return parseGenesisQuarantineCompleted(await fs.readFile(completedPath,"utf8"),manifest,manifestRaw);}
  await invalidateGenesisEnrollmentWitness(accountId);
  const root=genesisPaths(accountId).dir;
  for(const entry of manifest.entries){const source=path.join(root,entry.source),destination=path.join(dir,entry.destination);const sourceExists=await exists(source),destinationExists=await exists(destination);if(sourceExists===destinationExists)throw new Error("invalid genesis quarantine rename state");const current=sourceExists?source:destination;if(await fileHash(current)!==entry.sha256)throw new Error("genesis quarantine hash mismatch");if(sourceExists){await hardenedRename(source,destination);if(await fileHash(destination)!==entry.sha256)throw new Error("genesis quarantine destination validation failed");}}
  const completed:GenesisQuarantineCompleted={version:1,accountId,purpose,uniquenessKey:key,manifestSha256:await sha256Hex(utf8(manifestRaw)),completedAt};await hardenedWrite(completedPath,canonicalString(completed),writeOptions);return completed;
}

export async function activeGenesisQuarantines(accountId:string):Promise<Array<{purpose:GenesisQuarantinePurpose;key:string}>>{
  const root=genesisPaths(accountId).quarantine;let names:string[];try{names=await fs.readdir(root);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}const active:Array<{purpose:GenesisQuarantinePurpose;key:string}>=[];
  for(const name of names){let purpose:GenesisQuarantinePurpose,key:string;if(name.startsWith("genesis-legacy-")){purpose="repaired-legacy";key=name.slice("genesis-legacy-".length);}else if(name.startsWith("genesis-attempt-")){purpose="abandoned-attempt";key=name.slice("genesis-attempt-".length);}else throw new Error("unexpected genesis quarantine directory");
    genesisQuarantineDir(accountId,purpose,key);const dir=path.join(root,name),stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("unsafe genesis quarantine directory");
    const status=await genesisQuarantineStatus(accountId,purpose,key);if(status==="active")active.push({purpose,key});}
  return active;
}
