import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { encryptFileToTempInline } from "../../src/engine/crypto.js";
import { encryptBytesInMemory, type Expected } from "./core.js";

type Job = { index:number; srcPath:string; expected:Expected; oversize?:boolean };
type Message = { id:number; kek?:Uint8Array; tmpDir?:string; jobs?:Job[]; jobPlaintextCap?:number };
declare const self: { onmessage: ((e:{data:Message})=>void|Promise<void>)|null; postMessage(v:unknown, transfer?:ArrayBuffer[]):void };
let kek: Buffer | undefined; let tmpDir: string | undefined;
self.onmessage = async ({data}) => {
  if (data.kek) { kek=Buffer.from(data.kek); tmpDir=data.tmpDir; self.postMessage({id:data.id,ready:true}); return; }
  const started=performance.now(); let payloadCryptoMs=0, used=0; const results: unknown[]=[]; const transfers:ArrayBuffer[]=[];
  for (const job of data.jobs ?? []) {
    try {
      if (job.oversize) {
        // Design 99 §3: files > FUSE_MAX_FILE_BYTES keep the UNCHANGED single-file
        // temp path (the oracle). No in-memory ciphertext, no budget charge.
        const t=performance.now();
        const blob=await encryptFileToTempInline(job.srcPath,kek!,tmpDir,{compress:true,expected:job.expected});
        payloadCryptoMs+=performance.now()-t;
        results.push({index:job.index,ok:true,oversize:true,plaintextSha:blob.plaintextSha,encSha:blob.encSha,cipherSize:blob.cipherSize,ciphertextPath:blob.ciphertextPath,plaintextSize:job.expected.size});
        continue;
      }
      const t=performance.now(); const src=await fs.readFile(job.srcPath); if (used+src.length>(data.jobPlaintextCap??0)) { results.push({index:job.index,requeue:true}); continue; } used+=src.length;
      const blob=await encryptBytesInMemory(src,kek!,job.expected,true); payloadCryptoMs+=performance.now()-t; transfers.push(blob.ct); results.push({index:job.index,ok:true,...blob});
    } catch (e) { results.push({index:job.index,ok:false,errorCode:typeof e==="object"&&e&&"code" in e?String(e.code):"ERROR"}); }
  }
  const jobWallMs=performance.now()-started;
  try { self.postMessage({id:data.id,results,jobWallMs,payloadCryptoMs},transfers); }
  catch { self.postMessage({id:data.id,fatal:"transfer-list-required"}); }
};
