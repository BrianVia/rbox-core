import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireClearMachineGenesisForPairing, assertNoPendingGenesis, beginAtomicGenesis, enrollViaPairing, parsePairingToken } from "./e2ee-client.js";
import { bootstrapAccount, buildPairing } from "../engine/e2ee/index.js";
import { saveDevice } from "./e2ee-keystore.js";
import { e2eeRoot, genesisPaths, GENESIS_PENDING_MESSAGE, publishPrepublishMarker } from "./genesis-durable.js";
import { acquireGlobalGenesisLock, genesisLockRoot, globalGenesisLockPath } from "./genesis-locks.js";
import { genesisQuarantineDir, genesisQuarantineStatus } from "./genesis-quarantine.js";
import { saveCredentials } from "./credentials.js";

const origFetch = globalThis.fetch;
const origRboxHome = process.env.RBOX_HOME;
const origHome = process.env.HOME;
const origToken = process.env.RBOX_TOKEN;
const origDeviceId = process.env.RBOX_DEVICE_ID;
const origAccountId = process.env.RBOX_ACCOUNT_ID;
const origApi = process.env.RBOX_API;
let testHome: string;

beforeEach(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-e2ee-client-"));
  process.env.RBOX_HOME = testHome;
  process.env.HOME = testHome;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_DEVICE_ID;
  delete process.env.RBOX_ACCOUNT_ID;
  delete process.env.RBOX_API;
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  if (origRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = origRboxHome;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origToken === undefined) delete process.env.RBOX_TOKEN; else process.env.RBOX_TOKEN = origToken;
  if (origDeviceId === undefined) delete process.env.RBOX_DEVICE_ID; else process.env.RBOX_DEVICE_ID = origDeviceId;
  if (origAccountId === undefined) delete process.env.RBOX_ACCOUNT_ID; else process.env.RBOX_ACCOUNT_ID = origAccountId;
  if (origApi === undefined) delete process.env.RBOX_API; else process.env.RBOX_API = origApi;
  await fs.rm(testHome, { recursive: true, force: true });
});

describe("enrollViaPairing redeem errors", () => {
  test("device_limit_reached 409 explains the pairing token is still valid", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(String(input)).toBe("https://api.test/v1/auth/pair/redeem");
      expect(JSON.parse(String(init?.body))).toEqual({ token: `rbox-pair_${"a".repeat(16)}`, label: "rig-b-onboard-smoke" });
      return new Response(JSON.stringify({ error: "device_limit_reached", cap: 2, plan: "none" }), { status: 409 });
    }) as typeof fetch;

    const secret = Buffer.alloc(32).toString("base64url");
    await expect(enrollViaPairing("https://api.test", `rbox-pair_${"a".repeat(16)}.${secret}`, 1, "rig-b-onboard-smoke")).rejects.toThrow(
      "device limit reached (2/2 on none) — revoke a device or upgrade; pairing token still valid"
    );
    expect(calls).toBe(1);
  });
});

test("shared pairing parser accepts current, raw, legacy, padded, unpadded, and standard-base64 vectors", () => {
  const urlSecret = Buffer.alloc(32, 0xfb).toString("base64url");
  const standardSecret = Buffer.alloc(32, 0xfb).toString("base64");
  const vectors = [
    `rbox-pair_${"a".repeat(16)}.${urlSecret}`,
    `${"b".repeat(16)}.${urlSecret}`,
    `rbox-pair_${"c".repeat(64)}.${urlSecret}`,
    `${"d".repeat(64)}.${urlSecret}`,
    `rbox-pair_${"e".repeat(16)}.${standardSecret}`,
    `rbox-pair_${"f".repeat(16)}.${urlSecret.slice(0, 12)}    ${urlSecret.slice(12)}`,
  ];
  for (const vector of vectors) expect(parsePairingToken(vector).tokenSecret).toHaveLength(32);
  expect(parsePairingToken(`  ${vectors[0]}  `.trim()).tokenSecret).toHaveLength(32);
});

test("shared pairing parser rejects malformed vectors locally with zero redeem fetches", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const secret = Buffer.alloc(32).toString("base64url");
  const bad = [
    "",
    `rbox-pair_${"a".repeat(16)}`,
    `rbox-pair_${"a".repeat(16)}.${secret}.extra`,
    `rbox-pair_short.${secret}`,
    `rbox-pair_${"a".repeat(65)}.${secret}`,
    `rbox-pair_${"!".repeat(16)}.${secret}`,
    `rbox-pair_${"a".repeat(16)}.${secret.slice(0, -1)}*`,
    `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(31).toString("base64url")}`,
    `rbox-pair_${"a".repeat(16)}.${Buffer.alloc(33).toString("base64url")}`,
  ];
  for (const vector of bad) {
    expect(() => parsePairingToken(vector)).toThrow(/malformed pairing token/);
    await expect(enrollViaPairing("https://api.test", vector, 1)).rejects.toThrow(/malformed pairing token/);
    expect(fetches).toBe(0);
  }
});

test("malformed redeem account ids fail before target lock naming or keystore creation",async()=>{
  const secret=Buffer.alloc(32).toString("base64url"),valid={token:"paired",deviceId:"dev_new",accountId:"acct_0123456789abcdef",mkWrap:"wrap",admissionGrant:"grant"};
  for(const candidate of ["acct_../escape","acct_01234567/abcdef","acct_０123456789abcdef","acct_"+"a".repeat(200),{...valid,extra:true}] as const){globalThis.fetch=(async()=>new Response(JSON.stringify(typeof candidate==="string"?{...valid,accountId:candidate}:candidate))) as typeof fetch;await expect(enrollViaPairing("https://api.test",`rbox-pair_${"a".repeat(16)}.${secret}`,1)).rejects.toThrow(/malformed pairing response/);await expect(fs.access(e2eeRoot())).rejects.toThrow();expect(await fs.readdir(genesisLockRoot())).toEqual([]);}
});

test("normal enrolled device+MK material passes the common gate after coherent server verification", async () => {
  const accountId = "acct_dddddddddddddddd";
  const deviceId = "dev_enrolled";
  const boot = await bootstrapAccount(accountId, deviceId, 1_900_000_000_000);
  await saveDevice(boot.secrets);
  process.env.RBOX_TOKEN = "tok";
  process.env.RBOX_DEVICE_ID = deviceId;
  process.env.RBOX_ACCOUNT_ID = accountId;
  process.env.RBOX_API = "https://api.test";
  const present = { rosters: 1, keyStates: 1, devices: 1, workspaces: 0, workspaceKeys: 0, e2eePairingTokens: 0 };
  const dto = {
    genesisPresenceVersion: 1,
    recoveryWrap: JSON.stringify(boot.upload.recoveryWrap),
    recoveryWrapId: boot.upload.recoveryWrapId,
    claimCreatedAt: 1_900_000_000_000,
    genesisDeviceId: deviceId,
    rosters: [JSON.stringify(boot.upload.genesisRoster)],
    keyStates: [JSON.stringify(boot.upload.genesisKeyState)],
    devices: [{
      deviceId,
      sigPubkey: boot.upload.device.sigPubKey,
      encPubkey: boot.upload.device.encPubKey,
      mkWrap: JSON.stringify(boot.upload.device.mkWrap),
    }],
    present,
    repairTombstone: null,
  };
  let fetches = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetches++;
    expect(String(input)).toBe("https://api.test/v1/keys/account");
    return new Response(JSON.stringify(dto));
  }) as typeof fetch;

  await expect(assertNoPendingGenesis(accountId)).resolves.toBeUndefined();
  expect(fetches).toBe(1);
});

test("pairing global scan checks every local account and releases the global fence when a foreign pending account blocks", async () => {
  const cleanAccount = "acct_1111111111111111";
  const pendingAccount = "acct_ffffffffffffffff";
  await fs.mkdir(path.join(e2eeRoot(), cleanAccount), { recursive: true });
  await publishPrepublishMarker({
    version: 1,
    accountId: pendingAccount,
    deviceId: "dev_pending",
    repairId: null,
    startedAt: "2026-07-22T12:00:00.000Z",
    phase: "prepublish",
  });
  // Use an explicit valid current identity so this test exercises the
  // all-account scan independently of any credential-file fixtures running in
  // other Bun test files.
  process.env.RBOX_TOKEN = "tok";
  process.env.RBOX_DEVICE_ID = "dev_current";
  process.env.RBOX_ACCOUNT_ID = cleanAccount;
  process.env.RBOX_API = "https://api.test";

  await expect(acquireClearMachineGenesisForPairing()).rejects.toThrow(`${GENESIS_PENDING_MESSAGE} (${pendingAccount})`);
  const global = await acquireGlobalGenesisLock(0);
  await global.release();
});

test("pairing sends the exact legacy device+MK shape through the classifier before redeeming its opaque token", async () => {
  const accountId = "acct_2323232323232323";
  const deviceId = "dev_legacy_pairing";
  await saveCredentials({ token: "tok", deviceId, remoteUrl: "https://api.test", accountId });
  await saveDevice((await bootstrapAccount(accountId, deviceId, 1_900_000_000_000)).secrets);
  let requests = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests++;
    expect(String(input)).toBe("https://api.test/v1/keys/account");
    throw new Error("pairing classifier reached");
  }) as typeof fetch;
  const secret = Buffer.alloc(32).toString("base64url");

  await expect(enrollViaPairing("https://api.test", `rbox-pair_${"a".repeat(16)}.${secret}`, 1)).rejects.toThrow("pairing classifier reached");
  expect(requests).toBe(1);
});

test("real pairing handoff excludes real first-marker and repaired-legacy publication through admission",async()=>{
  const accountId="acct_3333333333333333",issuerId="dev_issuer",pairedDeviceId="dev_paired",tokenId="a".repeat(16),tokenSecret=Buffer.alloc(32,7),repairId=`gra_${"b".repeat(32)}`;
  const waitFor=async(predicate:()=>Promise<boolean>)=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise<void>(resolve=>setTimeout(resolve,10));}throw new Error("timed out waiting for race seam");};
  for(const kind of ["marker","repaired-legacy"] as const){
    await fs.rm(path.join(testHome,".rbox"),{recursive:true,force:true});
    const boot=await bootstrapAccount(accountId,issuerId,1_900_000_000_000),material=await buildPairing(boot.secrets,{accountEpoch:0,tokenId,tokenSecret,notAfter:1_900_000_600_000});
    const present={rosters:1,keyStates:1,devices:1,workspaces:0,workspaceKeys:0,e2eePairingTokens:0};
    const dto={genesisPresenceVersion:1,recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,claimCreatedAt:1_900_000_000_000,genesisDeviceId:issuerId,rosters:[JSON.stringify(boot.upload.genesisRoster)],keyStates:[JSON.stringify(boot.upload.genesisKeyState)],devices:[{deviceId:issuerId,sigPubkey:boot.upload.device.sigPubKey,encPubkey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}],present,repairTombstone:null};
    const tombstone={genesisPresenceVersion:1,recoveryWrap:"rbox:genesis-repair-tombstone:v1",recoveryWrapId:"rbox:genesis-repair-tombstone:v1",claimCreatedAt:1_900_000_000_001,genesisDeviceId:null,rosters:[],keyStates:[],devices:[],present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0},repairTombstone:{version:1,repairId,repairedAt:1_900_000_000_001}};
    let releaseAdmission!:()=>void,admissionStarted!:()=>void,serverTombstoned=false;
    const admissionGate=new Promise<void>(resolve=>{releaseAdmission=()=>{serverTombstoned=true;resolve();};}),atAdmission=new Promise<void>(resolve=>{admissionStarted=resolve;});
    globalThis.fetch=(async(input:string|URL|Request)=>{const url=String(input);
      if(url.endsWith("/v1/auth/pair/redeem"))return new Response(JSON.stringify({token:"paired-token",deviceId:pairedDeviceId,accountId,mkWrap:JSON.stringify(material.mkWrap),admissionGrant:JSON.stringify(material.admissionGrant)}));
      if(url.endsWith("/v1/keys/account"))return new Response(JSON.stringify(serverTombstoned?tombstone:dto));
      if(url.endsWith("/v1/keys/admit")){admissionStarted();await admissionGate;return new Response("{}");}
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const markerPath=genesisPaths(accountId).marker,quarantineDir=genesisQuarantineDir(accountId,"repaired-legacy",repairId),quarantineManifest=path.join(quarantineDir,"quarantine-resume.json");
    await expect(fs.access(markerPath)).rejects.toThrow();await expect(fs.access(quarantineDir)).rejects.toThrow();
    const pairing=enrollViaPairing("https://api.test",`rbox-pair_${tokenId}.${tokenSecret.toString("base64url")}`,1_900_000_000_100);
    await atAdmission;
    let publisherObservations=0;
    const publisherApi={getGenesisObservation:async()=>{publisherObservations++;if(kind==="marker")return{genesisPresenceVersion:1 as const,claim:null,present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}};if(!serverTombstoned)throw new Error("publisher observed before repair");if(publisherObservations>1)throw new Error("stop after repaired-legacy publication");return{genesisPresenceVersion:1 as const,claim:tombstone,present:tombstone.present,repairTombstone:tombstone.repairTombstone};},bootstrapKeys:async()=>{throw new Error("bootstrap must not run in handoff race");}};
    const publisher=beginAtomicGenesis(publisherApi,accountId,"dev_genesis",{now:1_900_000_000_200}).catch(error=>error as Error);
    await waitFor(async()=>fs.access(globalGenesisLockPath()).then(()=>true,()=>false));
    const artifact=kind==="marker"?markerPath:quarantineManifest;
    await expect(fs.access(artifact)).rejects.toThrow();
    expect(await fs.access(genesisPaths(accountId).device).then(()=>true,()=>false)).toBe(true);
    releaseAdmission();
    await expect(pairing).resolves.toEqual({accountId,deviceId:pairedDeviceId});
    const publisherResult=await publisher;
    if(kind==="marker"){
      expect(publisherResult.message).toBe("genesis integrity failure: unmarked local genesis material");
      expect(publisherObservations).toBe(1);await expect(fs.access(markerPath)).rejects.toThrow();await expect(fs.access(quarantineDir)).rejects.toThrow();
    }else{
      expect(publisherResult.message).toBe("stop after repaired-legacy publication");expect(publisherObservations).toBe(2);
      expect(await genesisQuarantineStatus(accountId,"repaired-legacy",repairId)).toBe("completed");await fs.access(quarantineManifest);await fs.access(path.join(quarantineDir,"device.json"));await fs.access(path.join(quarantineDir,"mk.key"));
      await expect(fs.access(genesisPaths(accountId).device)).rejects.toThrow();await expect(fs.access(genesisPaths(accountId).mk)).rejects.toThrow();await expect(fs.access(markerPath)).rejects.toThrow();
    }
  }
});
