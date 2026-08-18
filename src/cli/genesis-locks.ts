/** Never: enrollment classification or credential mutation. */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertGenesisAccountId } from "./genesis-durable.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory } from "../engine/fsutil.js";

export const GENESIS_LOCK_CONTENTION_MESSAGE = "another rbox process is already setting up encryption for this account — let it finish, then re-run.";
export const genesisLockRoot = (): string => path.join(process.env.RBOX_HOME || os.homedir(), ".rbox", "locks", "genesis");
export const globalGenesisLockPath = (): string => path.join(genesisLockRoot(), "pairing-global.lock");
export function accountGenesisLockPath(accountId:string):string{assertGenesisAccountId(accountId);const root=path.resolve(genesisLockRoot());const candidate=path.resolve(root,`${accountId}.lock`);if(path.dirname(candidate)!==root)throw new Error("genesis lock path escaped namespace");return candidate;}

function processAlive(pid:number):boolean{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code==="EPERM";}}

export interface GenesisLock { path:string; release():Promise<void> }

async function ensureLockNamespace():Promise<void>{const dir=genesisLockRoot();const created=await ensureDirectoryChain(dir,"genesis lock namespace");for(const entry of created)await fs.chmod(entry,0o700);await fsyncCreatedDirectoryAncestors(dir,created);}

async function acquire(file:string,timeoutMs=10_000):Promise<GenesisLock>{
  await ensureLockNamespace();const deadline=Date.now()+timeoutMs;
  for(;;){
    try{
      const handle=await fs.open(file,"wx",0o600);try{await handle.writeFile(`${process.pid}\n`);await handle.sync();}finally{await handle.close();}await fsyncDirectory(path.dirname(file));
      let released=false;return{path:file,release:async()=>{if(released)return;released=true;await fs.unlink(file).catch((error)=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});await fsyncDirectory(path.dirname(file));}};
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      let holder=0;try{holder=Number((await fs.readFile(file,"utf8")).trim());}catch(readError){if((readError as NodeJS.ErrnoException).code!=="ENOENT")throw readError;continue;}
      if(!processAlive(holder)){await fs.unlink(file).catch(()=>{});await fsyncDirectory(path.dirname(file));continue;}
      if(Date.now()>=deadline)throw new Error(GENESIS_LOCK_CONTENTION_MESSAGE);
      await new Promise<void>((resolve)=>setTimeout(resolve,50));
    }
  }
}

export const acquireGlobalGenesisLock=(timeoutMs?:number):Promise<GenesisLock>=>acquire(globalGenesisLockPath(),timeoutMs);
export const acquireAccountGenesisLock=(accountId:string,timeoutMs?:number):Promise<GenesisLock>=>acquire(accountGenesisLockPath(accountId),timeoutMs);

/** Lock order is globally fixed: pairing arbitration, then account. */
export async function acquireGenesisLockPair(accountId:string,timeoutMs?:number):Promise<{global:GenesisLock;account:GenesisLock}>{
  const global=await acquireGlobalGenesisLock(timeoutMs);try{return{global,account:await acquireAccountGenesisLock(accountId,timeoutMs)};}catch(error){await global.release();throw error;}
}

/** Compatibility adapter for legacy synchronous callers; uses the same non-materializing namespace. */
export function acquireGenesisLockSync(accountId:string):()=>void{
  const file=accountGenesisLockPath(accountId);fsSync.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const take=()=>{const fd=fsSync.openSync(file,"wx",0o600);try{fsSync.writeSync(fd,`${process.pid}\n`);fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}};
  try{take();}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;let pid=0;try{pid=Number(fsSync.readFileSync(file,"utf8").trim());}catch{}if(processAlive(pid))throw new Error(GENESIS_LOCK_CONTENTION_MESSAGE);fsSync.rmSync(file,{force:true});take();}
  return()=>{fsSync.rmSync(file,{force:true});const fd=fsSync.openSync(path.dirname(file),"r");try{fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}};
}
