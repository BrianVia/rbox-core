import {afterEach,beforeEach,describe,expect,test} from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {bootstrapAccount} from "../engine/e2ee/index.js";
import {saveCredentials} from "./credentials.js";
import {saveDevice,saveMasterKey} from "./e2ee-keystore.js";
import {genesisPaths,publishGenesisEnrollmentWitness} from "./genesis-durable.js";
import {startGenesisQuarantine} from "./genesis-quarantine.js";

const ACCOUNT="acct_3131313131313131";let home:string,priorHome:string|undefined;
beforeEach(async()=>{priorHome=process.env.HOME;home=await fs.mkdtemp(path.join(os.tmpdir(),"rbox-enrollment-witness-"));process.env.HOME=home;process.env.RBOX_HOME=home;});
afterEach(async()=>{if(priorHome===undefined)delete process.env.HOME;else process.env.HOME=priorHome;delete process.env.RBOX_HOME;await fs.rm(home,{recursive:true,force:true});});
const expectAbsent=async()=>expect(fs.access(genesisPaths(ACCOUNT).enrolledWitness)).rejects.toThrow();

describe("design 180 local enrollment witness invalidation",()=>{
  test("key recovery invalidates before replacing the MK",async()=>{const boot=await bootstrapAccount(ACCOUNT,"dev_recovery",1_900_000_000_000);await saveDevice(boot.secrets);await publishGenesisEnrollmentWitness(ACCOUNT);await saveMasterKey(ACCOUNT,boot.secrets.mk);await expectAbsent();});
  test("pairing replacement invalidates before replacing device and MK",async()=>{const first=await bootstrapAccount(ACCOUNT,"dev_old",1_900_000_000_000),next=await bootstrapAccount(ACCOUNT,"dev_pair",1_900_000_000_001);await saveDevice(first.secrets);await publishGenesisEnrollmentWitness(ACCOUNT);await saveDevice(next.secrets);await expectAbsent();});
  test("local-material quarantine invalidates before publishing its manifest",async()=>{const boot=await bootstrapAccount(ACCOUNT,"dev_quarantine",1_900_000_000_000);await saveDevice(boot.secrets);await publishGenesisEnrollmentWitness(ACCOUNT);await startGenesisQuarantine({accountId:ACCOUNT,purpose:"repaired-legacy",uniquenessKey:"gra_"+"a".repeat(32),createdAt:"2026-07-22T12:00:00.000Z"});await expectAbsent();});
  test("credential account switch invalidates the old account witness before publication",async()=>{const boot=await bootstrapAccount(ACCOUNT,"dev_switch",1_900_000_000_000);await saveCredentials({token:"old",deviceId:"dev_switch",remoteUrl:"https://api.test",accountId:ACCOUNT});await saveDevice(boot.secrets);await publishGenesisEnrollmentWitness(ACCOUNT);await saveCredentials({token:"new",deviceId:"dev_new",remoteUrl:"https://api.test",accountId:"acct_3232323232323232"});await expectAbsent();});
});
