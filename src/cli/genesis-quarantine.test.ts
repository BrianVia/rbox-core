import {afterEach,beforeEach,describe,expect,test} from "bun:test";import fs from "node:fs/promises";import os from "node:os";import path from "node:path";
import {canonicalString} from "../engine/e2ee/index.js";
import {genesisPaths,hardenedWrite} from "./genesis-durable.js";import {activeGenesisQuarantines,genesisQuarantineDir,genesisQuarantineStatus,parseGenesisQuarantineCompleted,parseGenesisQuarantineManifest,resumeGenesisQuarantine,startGenesisQuarantine} from "./genesis-quarantine.js";
const ACCOUNT="acct_0123456789abcdef",REPAIR="gra_"+"a".repeat(32),ATTEMPT="b".repeat(64);let home:string;let savedRboxHome:string|undefined;
beforeEach(async()=>{savedRboxHome=process.env.RBOX_HOME;home=await fs.mkdtemp(path.join(os.tmpdir(),"rbox-genesis-quarantine-"));process.env.RBOX_HOME=home;});afterEach(async()=>{if(savedRboxHome===undefined)delete process.env.RBOX_HOME;else process.env.RBOX_HOME=savedRboxHome;await fs.rm(home,{recursive:true,force:true});});
async function sources(abandoned=false){const p=genesisPaths(ACCOUNT);if(abandoned)await hardenedWrite(p.stagedRk,"rk");await hardenedWrite(p.device,"device");await hardenedWrite(p.mk,"mk");}
describe("design 180 shared genesis quarantine",()=>{
  for(const row of [{purpose:"repaired-legacy" as const,key:REPAIR,count:2},{purpose:"abandoned-attempt" as const,key:ATTEMPT,count:3}])test(`${row.purpose} is manifest-first and resumable`,async()=>{await sources(row.count===3);const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z"});expect(manifest.entries).toHaveLength(row.count);const dir=genesisQuarantineDir(ACCOUNT,row.purpose,row.key);expect(await fs.readFile(path.join(dir,"quarantine-resume.json"),"utf8")).toContain(row.purpose);const completed=await resumeGenesisQuarantine(ACCOUNT,row.purpose,row.key,"2026-07-22T12:01:00.000Z");expect(completed.manifestSha256).toMatch(/^[0-9a-f]{64}$/);expect(await fs.readdir(dir)).toContain("completed.json");for(const entry of manifest.entries){await expect(fs.access(path.join(genesisPaths(ACCOUNT).dir,entry.source))).rejects.toThrow();expect(await fs.readFile(path.join(dir,entry.destination),"utf8")).toBe(entry.source==="rk.key.staged"?"rk":entry.source==="device.json"?"device":"mk");}expect(await resumeGenesisQuarantine(ACCOUNT,row.purpose,row.key,"2026-07-22T12:02:00.000Z")).toEqual(completed);});
  test("completed repaired-legacy archives ignore a new bundle at reused source paths",async()=>{
    await sources();
    await startGenesisQuarantine({accountId:ACCOUNT,purpose:"repaired-legacy",uniquenessKey:REPAIR,createdAt:"2026-07-22T12:00:00.000Z"});
    const completed=await resumeGenesisQuarantine(ACCOUNT,"repaired-legacy",REPAIR,"2026-07-22T12:01:00.000Z");
    await sources();
    expect(await genesisQuarantineStatus(ACCOUNT,"repaired-legacy",REPAIR)).toBe("completed");
    expect(await activeGenesisQuarantines(ACCOUNT)).toEqual([]);
    expect(await resumeGenesisQuarantine(ACCOUNT,"repaired-legacy",REPAIR,"2026-07-22T12:02:00.000Z")).toEqual(completed);
    expect(await fs.readFile(genesisPaths(ACCOUNT).device,"utf8")).toBe("device");
    expect(await fs.readFile(genesisPaths(ACCOUNT).mk,"utf8")).toBe("mk");
  });
  test("wrong hashes and illegal both-present state fail closed",async()=>{await sources();const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:"repaired-legacy",uniquenessKey:REPAIR,createdAt:"2026-07-22T12:00:00.000Z"});const dir=genesisQuarantineDir(ACCOUNT,"repaired-legacy",REPAIR);await fs.writeFile(path.join(dir,"device.json"),"duplicate");await expect(resumeGenesisQuarantine(ACCOUNT,"repaired-legacy",REPAIR,"2026-07-22T12:01:00.000Z")).rejects.toThrow(/rename state/);expect(manifest.entries).toHaveLength(2);});

  for(const row of [{purpose:"repaired-legacy" as const,key:REPAIR,abandoned:false},{purpose:"abandoned-attempt" as const,key:ATTEMPT,abandoned:true}]){
    test(`${row.purpose} strict manifest and completed-marker parsers reject every binding class`,async()=>{
      await sources(row.abandoned);
      const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z"});
      const dir=genesisQuarantineDir(ACCOUNT,row.purpose,row.key),manifestRaw=await fs.readFile(path.join(dir,"quarantine-resume.json"),"utf8");
      expect(parseGenesisQuarantineManifest(manifestRaw,ACCOUNT,row.purpose,row.key)).toEqual(manifest);
      const first=manifest.entries[0]!;
      const manifestMutations:unknown[]=[
        {...manifest,version:2},{...manifest,accountId:"acct_ffffffffffffffff"},
        {...manifest,purpose:row.purpose==="repaired-legacy"?"abandoned-attempt":"repaired-legacy"},
        {...manifest,uniquenessKey:row.key.replace(/^./,"0")},{...manifest,createdAt:"invalid"},
        {...manifest,entries:manifest.entries.slice(1)},
        {...manifest,entries:[{...first,source:"other"},...manifest.entries.slice(1)]},
        {...manifest,entries:[{...first,destination:"other"},...manifest.entries.slice(1)]},
        {...manifest,entries:[{...first,sha256:"0"},...manifest.entries.slice(1)]},{...manifest,extra:true},
      ];
      for(const candidate of manifestMutations)expect(()=>parseGenesisQuarantineManifest(canonicalString(candidate),ACCOUNT,row.purpose,row.key)).toThrow();
      const completed=await resumeGenesisQuarantine(ACCOUNT,row.purpose,row.key,"2026-07-22T12:01:00.000Z"),completedRaw=await fs.readFile(path.join(dir,"completed.json"),"utf8");
      expect(await parseGenesisQuarantineCompleted(completedRaw,manifest,manifestRaw)).toEqual(completed);
      for(const candidate of [
        {...completed,version:2},{...completed,accountId:"acct_ffffffffffffffff"},
        {...completed,purpose:row.purpose==="repaired-legacy"?"abandoned-attempt":"repaired-legacy"},
        {...completed,uniquenessKey:row.key.replace(/^./,"0")},{...completed,manifestSha256:"0".repeat(64)},
        {...completed,completedAt:"invalid"},{...completed,extra:true},
      ])await expect(parseGenesisQuarantineCompleted(canonicalString(candidate),manifest,manifestRaw)).rejects.toThrow();
    });

    test(`${row.purpose} status validates absent, empty-dir recovery, partial rename, and completed states`,async()=>{
      const dir=genesisQuarantineDir(ACCOUNT,row.purpose,row.key);
      expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("absent");
      await fs.mkdir(dir,{recursive:true});
      expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("absent");
      await sources(row.abandoned);
      const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z"});
      expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("active");
      const first=manifest.entries[0]!;
      await fs.rename(path.join(genesisPaths(ACCOUNT).dir,first.source),path.join(dir,first.destination));
      expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("active");
      await resumeGenesisQuarantine(ACCOUNT,row.purpose,row.key,"2026-07-22T12:01:00.000Z");
      expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("completed");
    });

    test(`${row.purpose} status fails closed for both-present, both-absent, wrong-hash, and unexpected entries`,async()=>{
      await sources(row.abandoned);
      const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z"}),dir=genesisQuarantineDir(ACCOUNT,row.purpose,row.key),first=manifest.entries[0]!;
      await fs.copyFile(path.join(genesisPaths(ACCOUNT).dir,first.source),path.join(dir,first.destination));
      await expect(genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).rejects.toThrow(/rename state/);
      await fs.rm(path.join(dir,first.destination));await fs.rm(path.join(genesisPaths(ACCOUNT).dir,first.source));
      await expect(genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).rejects.toThrow(/rename state/);
      await hardenedWrite(path.join(genesisPaths(ACCOUNT).dir,first.source),"tampered");
      await expect(genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).rejects.toThrow(/hash mismatch/);
      await fs.writeFile(path.join(dir,"unexpected"),"evidence");
      await expect(genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).rejects.toThrow(/unexpected/);
    });

    test(`${row.purpose} completed evidence ignores source reuse but rejects bad destinations and marker mismatch`,async()=>{
      await sources(row.abandoned);
      const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z"}),dir=genesisQuarantineDir(ACCOUNT,row.purpose,row.key);
      await resumeGenesisQuarantine(ACCOUNT,row.purpose,row.key,"2026-07-22T12:01:00.000Z");
      const first=manifest.entries[0]!,original=first.source==="rk.key.staged"?"rk":first.source==="device.json"?"device":"mk";
      await hardenedWrite(path.join(genesisPaths(ACCOUNT).dir,first.source),original);
      expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("completed");
      await fs.rm(path.join(genesisPaths(ACCOUNT).dir,first.source));await fs.writeFile(path.join(dir,first.destination),"tampered");
      await expect(genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).rejects.toThrow(/hash mismatch/);
      await fs.writeFile(path.join(dir,first.destination),original);
      const completed=JSON.parse(await fs.readFile(path.join(dir,"completed.json"),"utf8"));await fs.writeFile(path.join(dir,"completed.json"),canonicalString({...completed,manifestSha256:"0".repeat(64)}));
      await expect(genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).rejects.toThrow(/completion marker/);
    });

    test(`${row.purpose} manifest publication awaits every before and after durability boundary`,async()=>{
      const stages=["ancestor-mkdir","ancestor-fsync","temp-create","temp-write","temp-fsync","temp-close","rename","read-back","published-file-fsync","parent-fsync"] as const;
      for(const fail of stages)for(const boundary of ["before","after"] as const){
        await fs.rm(genesisPaths(ACCOUNT).dir,{recursive:true,force:true});await sources(row.abandoned);const label=`manifest-${boundary}-${fail}`;
        await expect(startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z",writeOptions:{onBoundary(step,at){if(step===fail&&at===boundary)throw new Error(label);}}})).rejects.toThrow(label);
        const dir=genesisQuarantineDir(ACCOUNT,row.purpose,row.key),stageIndex=stages.indexOf(fail),renameIndex=stages.indexOf("rename"),published=stageIndex>renameIndex||(stageIndex===renameIndex&&boundary==="after");
        if(published){const raw=await fs.readFile(path.join(dir,"quarantine-resume.json"),"utf8");parseGenesisQuarantineManifest(raw,ACCOUNT,row.purpose,row.key);expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe("active");}
        else await expect(fs.access(path.join(dir,"quarantine-resume.json"))).rejects.toThrow();
      }
    });

    test(`${row.purpose} completion publication awaits every before and after durability boundary`,async()=>{
      const stages=["ancestor-mkdir","ancestor-fsync","temp-create","temp-write","temp-fsync","temp-close","rename","read-back","published-file-fsync","parent-fsync"] as const;
      for(const fail of stages)for(const boundary of ["before","after"] as const){
        await fs.rm(genesisPaths(ACCOUNT).dir,{recursive:true,force:true});await sources(row.abandoned);
        const manifest=await startGenesisQuarantine({accountId:ACCOUNT,purpose:row.purpose,uniquenessKey:row.key,createdAt:"2026-07-22T12:00:00.000Z"}),label=`completed-${boundary}-${fail}`;
        await expect(resumeGenesisQuarantine(ACCOUNT,row.purpose,row.key,"2026-07-22T12:01:00.000Z",{onBoundary(step,at){if(step===fail&&at===boundary)throw new Error(label);}})).rejects.toThrow(label);
        const stageIndex=stages.indexOf(fail),renameIndex=stages.indexOf("rename"),published=stageIndex>renameIndex||(stageIndex===renameIndex&&boundary==="after");
        expect(await genesisQuarantineStatus(ACCOUNT,row.purpose,row.key)).toBe(published?"completed":"active");
        for(const entry of manifest.entries)await expect(fs.access(path.join(genesisPaths(ACCOUNT).dir,entry.source))).rejects.toThrow();
      }
    });
  }
});
