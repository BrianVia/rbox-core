import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleDeviceCodePostApprovalEncryption,
  deviceCodeLoginShouldPrintWorkspaceStep,
  deviceApprovalUrl,
  completeStagedGenesisRecoveryKit,
  defaultGenesisRecoveryKitCompletion,
  login,
  logout,
  keySave,
  pairingRedemptionSuccessMessages,
  pairCreate,
  readPairingTokenInteractive,
  recoverCmd,
  recoveryPhraseFromKeychain,
  runGenesisEnrollment,
  keyBackup,
  keyStatus,
  WORKSPACE_SYNC_NEXT_STEP,
} from "./auth-cmd.js";
import { accountProfilePath, flushAccountProfileWrites, scheduleAccountProfileWrite } from "./account-profile.js";
import { saveCredentials } from "./credentials.js";
import { _setSpawner } from "./browser-open.js";
import { AccountAlreadyBootstrappedError } from "./remote.js";
import { acquireGenesisLock, hasDevice, loadDevice, loadRecoveryKey, saveDevice, saveRecoveryKey } from "./e2ee-keystore.js";
import type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence } from "./e2ee-remote.js";
import { bootstrapAccount, buildKeyState, phraseToRk, signPrivateFromPkcs8, wrapHash } from "../engine/e2ee/index.js";
import { GENESIS_PENDING_MESSAGE, genesisPaths, publishGenesisEnrollmentWitness, publishPrepublishMarker } from "./genesis-durable.js";
import { acquireGenesisLockPair } from "./genesis-locks.js";
import type { GenesisSeam } from "./genesis-seam.js";
import { RecoveryPreAdmissionError } from "./e2ee-client.js";
import { claimRecoveryKitOffer, readRecoveryKitRecord } from "./recovery-kit.js";

const ACCOUNT_KEYS: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };

class FakeGenesisApi {
  bootstrapCalls = 0;
  getCalls = 0;

  constructor(
    private readonly keys: Array<AccountKeysDTO | null>,
    private readonly bootstrapResult: "ok" | "already" | "network" = "ok",
    private readonly accountId="acct_0123456789abcdef",
    private readonly deviceId="dev_genesis",
  ) {}

  private committed?:AccountKeysDTO;
  private async completeDto():Promise<AccountKeysDTO>{const boot=await bootstrapAccount(this.accountId,this.deviceId,1_900_000_000_000);const present:GenesisPresence={rosters:1,keyStates:1,devices:1,workspaces:0,workspaceKeys:0,e2eePairingTokens:0};return{genesisPresenceVersion:1,recoveryWrap:JSON.stringify(boot.upload.recoveryWrap),recoveryWrapId:boot.upload.recoveryWrapId,claimCreatedAt:1_900_000_000_000,genesisDeviceId:this.deviceId,rosters:[JSON.stringify(boot.upload.genesisRoster)],keyStates:[JSON.stringify(boot.upload.genesisKeyState)],devices:[{deviceId:this.deviceId,sigPubkey:boot.upload.device.sigPubKey,encPubkey:boot.upload.device.encPubKey,mkWrap:JSON.stringify(boot.upload.device.mkWrap)}],present,repairTombstone:null};}

  async getGenesisObservation():Promise<GenesisAccountObservation>{this.getCalls++;if(this.committed){const present=this.committed.present!;return{genesisPresenceVersion:1,claim:this.committed,present,repairTombstone:null};}const current=this.keys.length>1?this.keys.shift()!:this.keys[0]!;if(current===null)return{genesisPresenceVersion:1,claim:null,present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}};const claim=await this.completeDto();return{genesisPresenceVersion:1,claim,present:claim.present!,repairTombstone:null};}

  async getAccountKeys(): Promise<AccountKeysDTO | null> {
    this.getCalls++;
    return this.keys.length > 1 ? this.keys.shift()! : this.keys[0]!;
  }

  async bootstrapKeys(raw?:unknown): Promise<void> {
    this.bootstrapCalls++;
    if (this.bootstrapResult === "already") {this.committed=await this.completeDto();throw new AccountAlreadyBootstrappedError();}
    if (this.bootstrapResult === "network") throw new Error("network down");
    const b=JSON.parse(String(raw)) as Record<string,any>;const present:GenesisPresence={rosters:1,keyStates:1,devices:1,workspaces:0,workspaceKeys:0,e2eePairingTokens:0};this.committed={genesisPresenceVersion:1,recoveryWrap:b.recoveryWrap,recoveryWrapId:b.recoveryWrapId,claimCreatedAt:1_900_000_000_000,genesisDeviceId:b.device.deviceId,rosters:[b.genesisRoster],keyStates:[b.genesisKeyState],devices:[{deviceId:b.device.deviceId,sigPubkey:b.device.sigPubKey,encPubkey:b.device.encPubKey,mkWrap:b.device.mkWrap}],present,repairTombstone:null};
  }
}

let home: string;
const origLog = console.log;
const origFetch = globalThis.fetch;
const origSetTimeout = globalThis.setTimeout;
const origHome = process.env.HOME;

test("pairing token input prompts without echo on an interactive terminal", async () => {
  let promptMessage = "";
  let read = false;
  const token = await readPairingTokenInteractive({
    isInteractive: () => true,
    promptPassword: async (opts) => {
      promptMessage = opts.message;
      return "  secret-token  ";
    },
    readStdin: async () => {
      read = true;
      return "stdin-token";
    },
  });
  expect(token).toBe("secret-token");
  expect(promptMessage).toBe("Paste pairing token");
  expect(read).toBe(false);
});

test("pairing token input drains stdin when non-interactive", async () => {
  let prompted = false;
  const token = await readPairingTokenInteractive({
    isInteractive: () => false,
    promptPassword: async () => {
      prompted = true;
      return "prompt-token";
    },
    readStdin: async () => "  stdin-token  ",
  });
  expect(token).toBe("stdin-token");
  expect(prompted).toBe(false);
});

test("pairing redemption success chains to the existing-workspace setup step", () => {
  expect(pairingRedemptionSuccessMessages("dev_new")).toEqual([
    "device authorized + encryption enrolled: dev_new",
    WORKSPACE_SYNC_NEXT_STEP,
  ]);
});

test("wizard pairing success suppresses the standalone workspace next step", () => {
  expect(pairingRedemptionSuccessMessages("dev_new", "wizard")).toEqual([
    "device authorized + encryption enrolled: dev_new",
  ]);
  expect(pairingRedemptionSuccessMessages("dev_new", "standalone")).toContain(WORKSPACE_SYNC_NEXT_STEP);
});

test("RBOX_PAIR_TOKEN redemption inherits login's explicit presentation context", async () => {
  const previous = process.env.RBOX_PAIR_TOKEN;
  process.env.RBOX_PAIR_TOKEN = "pair-token";
  try {
    for (const presentation of ["wizard", "standalone"] as const) {
      const seen: string[] = [];
      await login("https://api.test", undefined, undefined, { kit: false }, "machine", presentation, {
        redeemPair: async (_remote, token, label, context) => {
          expect(token).toBe("pair-token");
          expect(label).toBe("machine");
          seen.push(context);
        },
      });
      expect(seen).toEqual([presentation]);
    }
  } finally {
    if (previous === undefined) delete process.env.RBOX_PAIR_TOKEN;
    else process.env.RBOX_PAIR_TOKEN = previous;
  }
});

test("empty RBOX_APP falls back to the full production approval URL", () => {
  const previous = process.env.RBOX_APP;
  process.env.RBOX_APP = "";
  try {
    expect(deviceApprovalUrl("AAAA-BBBB")).toBe("https://app.rbox.to/cli-login?code=AAAA-BBBB");
  } finally {
    if (previous === undefined) delete process.env.RBOX_APP;
    else process.env.RBOX_APP = previous;
  }
});

test("key recover requires login before reading the recovery phrase", async () => {
  const token = process.env.RBOX_TOKEN;
  const accountId = process.env.RBOX_ACCOUNT_ID;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_ACCOUNT_ID;
  try {
    await expect(recoverCmd()).rejects.toThrow("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");
  } finally {
    if (token !== undefined) process.env.RBOX_TOKEN = token;
    if (accountId !== undefined) process.env.RBOX_ACCOUNT_ID = accountId;
  }
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-auth-home-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  console.log = () => {};
  _setSpawner(() => ({ on: () => {}, unref: () => {} }));
});

afterEach(async () => {
  console.log = origLog;
  globalThis.fetch = origFetch;
  globalThis.setTimeout = origSetTimeout;
  _setSpawner();
  delete process.env.RBOX_HOME;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  await fs.rm(home, { recursive: true, force: true });
});

function installImmediateTimers(): number[] {
  const sleeps: number[] = [];
  globalThis.setTimeout = ((handler: any, timeout?: number, ...args: any[]) => {
    sleeps.push(Number(timeout));
    queueMicrotask(() => {
      if (typeof handler === "function") handler(...args);
    });
    return 0 as any;
  }) as typeof setTimeout;
  return sleeps;
}

async function markGenesisPending(accountId: string, deviceId = "dev_pending"): Promise<void> {
  await publishPrepublishMarker({
    version: 1,
    accountId,
    deviceId,
    repairId: null,
    startedAt: "2026-07-22T12:00:00.000Z",
    phase: "prepublish",
  });
}

test("logout clears credentials and the queued account profile", async () => {
  await saveCredentials({ token: "tok", deviceId: "dev", remoteUrl: "https://api.test", accountId: "acct_1000000000000001" });
  scheduleAccountProfileWrite({ accountId: "acct_1000000000000001", email: "owner@example.com", signInMethod: "github" });
  await logout();
  await flushAccountProfileWrites();
  expect(await fs.exists(path.join(home, ".rbox", "credentials.json"))).toBe(false);
  expect(await fs.exists(accountProfilePath())).toBe(false);
  await expect(logout()).resolves.toBeUndefined();
});

describe("runGenesisEnrollment", () => {
  test("the production staged phrase sink suppresses the ordinary recovery-kit offer", async () => {
    const accountId = "acct_1000000000000008";
    const requestSha256 = "e".repeat(64);
    let allowOffer: boolean | undefined;
    const completion = defaultGenesisRecoveryKitCompletion(
      { accountId, deviceId: "dev" },
      { kit: true },
      async (_phrase, _creds, _opts, _surface, allowRecoveryKitOffer) => { allowOffer = allowRecoveryKitOffer }
    );
    await completion.displayPhrase("staged phrase", { version: 1, accountId, requestSha256, mode: "phrase-display", intentAt: "2026-07-22T12:00:00.000Z" });
    expect(allowOffer).toBe(false);
  });

  test("null account keys mints genesis, shows the phrase, and leaves local device material", async () => {
    const api = new FakeGenesisApi([null],"ok","acct_0123456789abcdef","dev_genesis");
    let shown = "";

    const result = await runGenesisEnrollment(api, { accountId: "acct_0123456789abcdef", deviceId: "dev_genesis" }, { kit: false }, {
      now: () => 1_900_000_000_000,
      showRecoveryPhrase: async (phrase) => {
        shown = phrase;
      },
    });

    expect(result).toBe("enrolled");
    expect(api.bootstrapCalls).toBe(1);
    expect(shown.split(/\s+/).length).toBe(24);
    expect(await hasDevice("acct_0123456789abcdef")).toBe(true);
  });

  test("existing account keys returns the pair/recover signal without minting", async () => {
    const api = new FakeGenesisApi([ACCOUNT_KEYS],"ok","acct_1111111111111111","dev_existing");
    let shown = false;

    const result = await runGenesisEnrollment(api, { accountId: "acct_1111111111111111", deviceId: "dev_existing" }, { kit: false }, {
      showRecoveryPhrase: async () => {
        shown = true;
      },
    });

    expect(result).toBe("already-setup");
    expect(api.bootstrapCalls).toBe(0);
    expect(shown).toBe(false);
    expect(await hasDevice("acct_1111111111111111")).toBe(false);
  });

  test("409 competing bootstrap quarantines the losing attempt but preserves unrelated cached recovery", async () => {
    const accountId="acct_2222222222222222";const api = new FakeGenesisApi([null], "already",accountId,"dev_race");
    await saveRecoveryKey(accountId, new Uint8Array([1, 2, 3]));

    const result = await runGenesisEnrollment(api, { accountId, deviceId: "dev_race" }, { kit: false }, {
      now: () => 1_900_000_000_000,
      showRecoveryPhrase: async () => {
        throw new Error("phrase should not be shown after a 409");
      },
    });

    expect(result).toBe("already-setup");
    expect(api.getCalls).toBe(4);
    expect(await hasDevice(accountId)).toBe(false);
    expect(await loadRecoveryKey(accountId)).toBeDefined();
  });

  test("non-409 bootstrap failures leave crash-safety material for retry", async () => {
    const accountId="acct_3333333333333333";const api = new FakeGenesisApi([null], "network",accountId,"dev_retry");
    await saveRecoveryKey(accountId, new Uint8Array([4, 5, 6]));

    await expect(
      runGenesisEnrollment(api, { accountId, deviceId: "dev_retry" }, { kit: false }, {
        now: () => 1_900_000_000_000,
      })
    ).rejects.toThrow(/unconfirmed/);

    expect(await hasDevice(accountId)).toBe(true);
    expect(await loadRecoveryKey(accountId)).toBeDefined();
  });

  test("production kit selection records the actual absolute artifact before commitment",async()=>{
    for(const row of [{accountId:"acct_4444444444444445",kit:{kit:true,kitPath:"relative-kit.txt"},offer:false},{accountId:"acct_4444444444444446",kit:{kit:false},offer:true}] as const){const api=new FakeGenesisApi([null],"ok",row.accountId,"dev_kit"),target=path.join(home,`${row.accountId}.txt`),seen:string[]=[];await runGenesisEnrollment(api,{accountId:row.accountId,deviceId:"dev_kit"},row.kit,{now:()=>1_900_000_000_000,isInteractive:()=>true,promptConfirm:async()=>row.offer,resolveKitPath:async()=>target,writeKit:async(_phrase,_creds,opts)=>{seen.push(opts.kitPath!);const intent=JSON.parse(await fs.readFile(genesisPaths(row.accountId).intent,"utf8"));expect(intent).toMatchObject({mode:"kit-path",path:target});}});expect(seen).toEqual([target]);}
  });

  test("ordinary resume supplies the persisted kit-path sink after a commitment crash",async()=>{
    const accountId="acct_4444444444444447",target=path.join(home,"persisted-kit.txt"),api=new FakeGenesisApi([null],"ok",accountId,"dev_resume");
    await expect(runGenesisEnrollment(api,{accountId,deviceId:"dev_resume"},{kit:true,kitPath:"ignored"},{now:()=>1_900_000_000_000,isInteractive:()=>false,resolveKitPath:async()=>target,writeKit:async()=>{throw new Error("crash after intent");}})).rejects.toThrow("crash after intent");
    expect(JSON.parse(await fs.readFile(genesisPaths(accountId).intent,"utf8"))).toMatchObject({mode:"kit-path",path:target});let resumed="";
    await expect(runGenesisEnrollment(api,{accountId,deviceId:"dev_resume"},{kit:false},{now:()=>1_900_000_000_001,isInteractive:()=>false,writeKit:async(_phrase,_creds,opts)=>{resumed=opts.kitPath!;}})).resolves.toBe("enrolled");expect(resumed).toBe(target);
  });

  test("phrase-display production intent survives a delivery crash and resumes without reselection",async()=>{
    const accountId="acct_4444444444444448",api=new FakeGenesisApi([null],"ok",accountId,"dev_phrase");await expect(runGenesisEnrollment(api,{accountId,deviceId:"dev_phrase"},{kit:false},{now:()=>1_900_000_000_000,isInteractive:()=>false,showRecoveryPhrase:async()=>{throw new Error("crash during phrase delivery");}})).rejects.toThrow("crash during phrase delivery");expect(JSON.parse(await fs.readFile(genesisPaths(accountId).intent,"utf8"))).toMatchObject({mode:"phrase-display"});let deliveries=0;await expect(runGenesisEnrollment(api,{accountId,deviceId:"dev_phrase"},{kit:true,kitPath:"must-not-be-selected"},{now:()=>1_900_000_000_001,isInteractive:()=>false,showRecoveryPhrase:async()=>{deliveries++;}})).resolves.toBe("enrolled");expect(deliveries).toBe(1);
  });

  test("declining the production kit offer records phrase-display before delivery",async()=>{
    const accountId="acct_4444444444444449",api=new FakeGenesisApi([null],"ok",accountId,"dev_decline"),target=path.join(home,"declined-kit.txt");let prompts=0;await runGenesisEnrollment(api,{accountId,deviceId:"dev_decline"},{kit:false},{now:()=>1_900_000_000_000,isInteractive:()=>true,promptConfirm:async()=>{prompts++;return false;},resolveKitPath:async()=>target,deliverPhrase:async()=>{expect(JSON.parse(await fs.readFile(genesisPaths(accountId).intent,"utf8"))).toMatchObject({mode:"phrase-display"});}});expect(prompts).toBe(1);await expect(fs.access(target)).rejects.toThrow();
  });

  test("real staged genesis re-presents a claimed offer after a crash before intent publication", async () => {
    const accountId = "acct_4646464646464646";
    const api = new FakeGenesisApi([null], "ok", accountId, "dev_claim_resume");
    const target = { service: "rbox recovery phrase" as const, account: accountId, keychainPath: path.join(home, "login.keychain-db"), discoveredAt: "2030-03-17T17:46:40.000Z" };
    let prompts = 0;
    const common = {
      platform: "darwin" as const,
      stdinTTY: true,
      stderrTTY: true,
      isInteractive: () => true,
      keychainOfferTarget: async () => target,
      probeKeychain: async () => "missing" as const,
      now: () => 1_900_000_000_000,
    };
    await expect(runGenesisEnrollment(api, { accountId, deviceId: "dev_claim_resume" }, { kit: false }, {
      ...common,
      promptConfirm: async () => { prompts++; throw new Error("crash after claim") },
    })).rejects.toThrow("crash after claim");
    expect((await readRecoveryKitRecord(accountId))?.offer?.outcome).toBe("claimed");
    await expect(fs.access(genesisPaths(accountId).intent)).rejects.toThrow();

    let delivered = 0;
    await runGenesisEnrollment(api, { accountId, deviceId: "dev_claim_resume" }, { kit: false }, {
      ...common,
      now: () => 1_900_000_000_001,
      promptConfirm: async () => { prompts++; return false },
      deliverPhrase: async () => { delivered++ },
    });
    expect({ prompts, delivered }).toEqual({ prompts: 2, delivered: 1 });
    expect((await readRecoveryKitRecord(accountId))?.offer?.outcome).toBe("declined");
  });

  test("staged genesis Keychain offer requires both TTYs and swallows unavailable preflight", async () => {
    const rows = [[true, true, 1], [true, false, 0], [false, true, 0], [false, false, 0]] as const;
    for (let index = 0; index < rows.length; index++) {
      const [stdinTTY, stderrTTY, expectedPreflights] = rows[index]!;
      const accountId = `acct_474747474747474${index}`;
      const api = new FakeGenesisApi([null], "ok", accountId, `dev_tty_${index}`);
      let preflights = 0;
      await runGenesisEnrollment(api, { accountId, deviceId: `dev_tty_${index}` }, { kit: false }, {
        platform: "darwin",
        stdinTTY,
        stderrTTY,
        isInteractive: () => stdinTTY,
        keychainOfferTarget: async () => { preflights++; throw new Error("Keychain unavailable") },
        deliverPhrase: async () => {},
        now: () => 1_900_000_000_000 + index,
      });
      expect(preflights).toBe(expectedPreflights);
      expect(await readRecoveryKitRecord(accountId)).toBeUndefined();
    }
  });

  test("a verified staged-genesis Keychain save advances the offer to accepted", async () => {
    const accountId = "acct_4848484848484848";
    const api = new FakeGenesisApi([null], "ok", accountId, "dev_offer_accept");
    const target = { service: "rbox recovery phrase" as const, account: accountId, keychainPath: path.join(home, "login.keychain-db"), discoveredAt: "2030-03-17T17:46:40.000Z" };
    await runGenesisEnrollment(api, { accountId, deviceId: "dev_offer_accept" }, { kit: false }, {
      platform: "darwin",
      stdinTTY: true,
      stderrTTY: true,
      isInteractive: () => true,
      keychainOfferTarget: async () => target,
      probeKeychain: async () => "missing",
      promptConfirm: async () => true,
      now: () => 1_900_000_000_000,
      genesisCompletion: {
        validatePhrase: async () => {},
        select: async () => { throw new Error("runGenesisEnrollment owns selection") },
        displayPhrase: async () => { throw new Error("wrong mode") },
        saveKeychain: async () => {},
        saveFile: async () => { throw new Error("wrong mode") },
      },
    });
    expect((await readRecoveryKitRecord(accountId))?.offer?.outcome).toBe("accepted");
  });

  test("real design-180 completion RETARGETs a failed Keychain intent before the file sink", async () => {
    const accountId = "acct_4545454545454545";
    const api = new FakeGenesisApi([null], "ok", accountId, "dev_keychain");
    const fallback = path.join(home, "retargeted-kit.txt");
    const trace: string[] = [];
    await runGenesisEnrollment(api, { accountId, deviceId: "dev_keychain" }, { kit: false }, {
      now: () => 1_900_000_000_000,
      isInteractive: () => true,
      platform: "darwin",
      stdinTTY: true,
      stderrTTY: true,
      keychainOfferTarget: async () => ({ service: "rbox recovery phrase", account: accountId, keychainPath: path.join(home, "login.keychain-db"), discoveredAt: "2030-03-17T17:46:40.000Z" }),
      probeKeychain: async () => "missing",
      promptConfirm: async () => true,
      genesisCompletion: {
        validatePhrase: async () => {},
        select: async (_phrase, staged) => ({
          version: 1,
          accountId,
          requestSha256: staged.requestSha256,
          mode: "keychain",
          keychain: { service: "rbox recovery phrase", account: accountId, keychainPath: path.join(home, "login.keychain-db") },
          intentAt: "2030-03-17T17:46:40.000Z",
        }),
        displayPhrase: async () => { throw new Error("wrong mode") },
        saveKeychain: async () => { trace.push("keychain"); throw new Error("security unavailable") },
        retargetAfterKeychainFailure: async (_phrase, intent) => {
          trace.push("consent");
          return { version: 1, accountId, requestSha256: intent.requestSha256, mode: "kit-path", path: fallback, intentAt: "2030-03-17T17:46:41.000Z" };
        },
        saveFile: async () => {
          trace.push("file");
          expect(JSON.parse(await fs.readFile(genesisPaths(accountId).intent, "utf8"))).toMatchObject({ mode: "kit-path", path: fallback });
          await expect(fs.access(genesisPaths(accountId).witness)).rejects.toThrow();
        },
      },
    });
    expect(trace).toEqual(["keychain", "consent", "file"]);
    await expect(fs.access(genesisPaths(accountId).journal)).rejects.toThrow();
    await expect(fs.access(genesisPaths(accountId).intent)).rejects.toThrow();
    await expect(fs.access(genesisPaths(accountId).stagedRk)).rejects.toThrow();
    expect((await readRecoveryKitRecord(accountId))?.offer?.outcome).toBe("accepted");
  });

  test("an unreleased design-180 hold runs staged completion instead of the legacy phrase path", async () => {
    const accountId = "acct_1000000000000006";
    const requestSha256 = "b".repeat(64);
    const stagedPhrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
    const trace: string[] = [];
    const committed = { kind: "committed-this-attempt" as const, journal: { accountId, requestSha256 }, phrase: stagedPhrase };
    const seam: GenesisSeam = {
      readValidatedStagedRecoveryKey: async () => ({ accountId, requestSha256, originalCacheRecovery: false, rk: await phraseToRk(stagedPhrase) }),
      readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
      writeCompletionIntent: async () => { trace.push("intent"); },
      retargetKeychainIntent: async (_classification, old) => old,
      pendingGenesis: async () => committed,
      commitVerifiedRecoveryKitArtifact: async () => { trace.push("receipt"); },
      commitDeliveredRecoveryPhrase: async () => { trace.push("phrase-receipt"); },
      quarantineAbandonedAttempt: async () => {},
    };
    expect(await claimRecoveryKitOffer(accountId, "genesis", "in-hand", async () => true)).toBe(true);
    const result = await completeStagedGenesisRecoveryKit(accountId, committed as any, seam, {
        validatePhrase: async () => { trace.push("validate"); },
        select: async () => { trace.push("select"); return { version: 1, accountId, requestSha256, mode: "kit-path", path: "/tmp/kit", intentAt: "2026-07-22T12:00:00.000Z" } },
        displayPhrase: async () => { throw new Error("wrong mode"); },
        saveKeychain: async () => { throw new Error("wrong mode"); },
        saveFile: async () => { trace.push("file"); },
    });
    expect(result.mode).toBe("kit-path");
    expect(trace).toEqual(["validate", "select", "intent", "file", "receipt"]);
    expect((await readRecoveryKitRecord(accountId))?.offer?.outcome).toBe("claimed");
  });

  test("runGenesisEnrollment routes Keychain failure through durable RETARGET before fallback", async () => {
    const accountId = "acct_1000000000000007";
    const requestSha256 = "c".repeat(64);
    const stagedPhrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
    const committed = { kind: "committed-this-attempt" as const, journal: { accountId, requestSha256 }, phrase: stagedPhrase };
    const keychainIntent = { version: 1 as const, accountId, requestSha256, mode: "keychain" as const, keychain: { service: "rbox recovery phrase" as const, account: accountId, keychainPath: "/tmp/login.keychain-db" }, intentAt: "2026-07-22T12:00:00.000Z" };
    const fileIntent = { version: 1 as const, accountId, requestSha256, mode: "kit-path" as const, path: "/tmp/fallback-kit.txt", intentAt: "2026-07-22T12:00:01.000Z" };
    const trace: string[] = [];
    const seam: GenesisSeam = {
      pendingGenesis: async () => committed,
      readValidatedStagedRecoveryKey: async () => ({ accountId, requestSha256, originalCacheRecovery: false, rk: await phraseToRk(stagedPhrase) }),
      readAndReconcileCompletionIntent: async () => { trace.push("reconcile"); return { state: "absent" } },
      writeCompletionIntent: async () => { trace.push("intent") },
      retargetKeychainIntent: async (_classification, oldIntent, newIntent) => { expect(oldIntent).toEqual(keychainIntent); expect(newIntent).toEqual(fileIntent); trace.push("retarget"); return fileIntent },
      commitVerifiedRecoveryKitArtifact: async () => { trace.push("receipt") },
      commitDeliveredRecoveryPhrase: async () => { throw new Error("wrong receipt") },
      quarantineAbandonedAttempt: async () => { throw new Error("unused") },
    };
    await completeStagedGenesisRecoveryKit(accountId, committed as any, seam, {
        validatePhrase: async () => { trace.push("validate") },
        select: async () => { trace.push("select"); return keychainIntent },
        displayPhrase: async () => { throw new Error("wrong mode") },
        saveKeychain: async () => { trace.push("keychain"); throw new Error("unavailable") },
        retargetAfterKeychainFailure: async () => { trace.push("consent"); return fileIntent },
        saveFile: async () => { trace.push("file") },
        offerClaimed: async () => true,
    });
    expect(trace).toEqual(["reconcile", "validate", "select", "intent", "keychain", "consent", "retarget", "file", "receipt"]);
  });
});

describe("genesis lock", () => {
  test("second acquire while held reports setup contention", () => {
    const accountId="acct_4444444444444444";const release = acquireGenesisLock(accountId);
    try {
      expect(() => acquireGenesisLock(accountId)).toThrow("another rbox process is already setting up encryption for this account");
    } finally {
      release();
    }

    const releaseAgain = acquireGenesisLock(accountId);
    releaseAgain();
  });

  test("stale dead-pid lock is taken over", async () => {
    const accountId = "acct_5555555555555555";
    const dir = path.join(home, ".rbox", "locks", "genesis");
    const lock = path.join(dir, `${accountId}.lock`);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lock, "2147483647");

    const release = acquireGenesisLock(accountId);
    release();

    await expect(fs.access(lock)).rejects.toThrow();
  });
});

describe("device-code login rate-limit / device-cap tolerance (design 64 §3.3)", () => {
  test("device/start retries on 429 (honoring Retry-After) then proceeds to poll", async () => {
    const sleeps = installImmediateTimers();
    let startCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) {
        startCalls++;
        expect(JSON.parse(String(init?.body))).toEqual({ label: "rig-a-onboard-smoke" });
        if (startCalls === 1) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "0" } });
        return new Response(JSON.stringify({ deviceCode: "dc_retry", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
      }
      if (url.endsWith("/v1/auth/device/poll")) return new Response(JSON.stringify({ status: "approved", token: "tok" }));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test", undefined, undefined, { kit: false }, "rig-a-onboard-smoke")).rejects.toThrow("malformed approval response from server");
    expect(startCalls).toBe(2);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(1000);
  });

  test("poll treats a 429 as transient (backs off, keeps polling) rather than a status", async () => {
    const sleeps = installImmediateTimers();
    let pollCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) return new Response(JSON.stringify({ deviceCode: "dc_poll", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
      if (url.endsWith("/v1/auth/device/poll")) {
        pollCalls++;
        if (pollCalls === 1) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "not-a-number" } });
        return new Response(JSON.stringify({ status: "approved", token: "tok" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test")).rejects.toThrow("malformed approval response from server");
    expect(pollCalls).toBe(2);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(1000);
  });

  test("poll device-cap 409 stops login", async () => {
    const sleeps = installImmediateTimers();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) return new Response(JSON.stringify({ deviceCode: "dc_cap", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
      if (url.endsWith("/v1/auth/device/poll")) return new Response(JSON.stringify({ error: "device_limit_reached", cap: 2, plan: "none" }), { status: 409 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test")).rejects.toThrow("device limit reached (2/2 on none) — revoke a device or upgrade");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(1000);
  });
});

describe("device-code approval validation", () => {
  test("login rejects an approved response missing accountId or deviceId", async () => {
    const sleeps = installImmediateTimers();
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) {
        return new Response(JSON.stringify({ deviceCode: "dc_malformed", userCode: "ABC123", interval: 0, expiresIn: 60 }));
      }
      if (url.endsWith("/v1/auth/device/poll")) {
        return new Response(JSON.stringify({ status: "approved", token: "tok", deviceId: "dev_approval" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test")).rejects.toThrow("malformed approval response from server");
    expect(sleeps.length).toBeGreaterThan(0);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(1000);
  });
});

test("device-code login leaves the shared workspace step to the enrolled-elsewhere note", async () => {
  installImmediateTimers();
  const output: string[] = [];
  const errors: string[] = [];
  const priorWrite = process.stderr.write;
  console.log = (...args: unknown[]) => void output.push(args.map(String).join(" "));
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/device/start")) {
      return new Response(JSON.stringify({ deviceCode: "dc_success", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
    }
    if (url.endsWith("/v1/auth/device/poll")) {
      return new Response(JSON.stringify({ status: "approved", token: "tok", deviceId: "dev_success", accountId: "acct_1000000000000007" }));
    }
    if (url.endsWith("/v1/keys/account")) return new Response(JSON.stringify(ACCOUNT_KEYS));
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await login("https://api.test");
  } finally {
    process.stderr.write = priorWrite;
  }

  expect(output).toContain("device authorized: dev_success");
  expect(output).not.toContain(WORKSPACE_SYNC_NEXT_STEP);
  expect(errors.join("").match(new RegExp(WORKSPACE_SYNC_NEXT_STEP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
});

test("device-code login assigns the shared workspace step to exactly one output owner", () => {
  const results = [
    "existing-keys",
    "headless-command",
    "declined",
    "enrolled",
    "already-setup",
  ] as const;
  expect(results.map((result) => [result, deviceCodeLoginShouldPrintWorkspaceStep(result)])).toEqual([
    ["existing-keys", false],
    ["headless-command", true],
    ["declined", true],
    ["enrolled", true],
    ["already-setup", false],
  ]);
});

test("bootstrap login success prints the shared workspace step", async () => {
  const output: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => void output.push(args.map(String).join(" "));
  const priorError = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
  const existing=await bootstrapAccount("acct_6666666666666666","dev_bootstrap",1_900_000_000_000);const existingPresence={rosters:1,keyStates:1,devices:1,workspaces:0,workspaceKeys:0,e2eePairingTokens:0};const existingDto={genesisPresenceVersion:1,recoveryWrap:JSON.stringify(existing.upload.recoveryWrap),recoveryWrapId:existing.upload.recoveryWrapId,claimCreatedAt:1_900_000_000_000,genesisDeviceId:"dev_bootstrap",rosters:[JSON.stringify(existing.upload.genesisRoster)],keyStates:[JSON.stringify(existing.upload.genesisKeyState)],devices:[{deviceId:"dev_bootstrap",sigPubkey:existing.upload.device.sigPubKey,encPubkey:existing.upload.device.encPubKey,mkWrap:JSON.stringify(existing.upload.device.mkWrap)}],present:existingPresence,repairTombstone:null};
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/v1/auth/device/bootstrap")) {
      return new Response(JSON.stringify({ token: "tok", deviceId: "dev_bootstrap", accountId: "acct_6666666666666666" }));
    }
    if (url.endsWith("/v1/keys/account")) return new Response(JSON.stringify(existingDto));
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  const credentialFile = path.join(home, ".rbox", "credentials.json");
  await fs.mkdir(path.dirname(credentialFile), { mode: 0o700 });
  const corruptEvidence = Buffer.from("{direct-login-corrupt");
  await fs.writeFile(credentialFile, corruptEvidence, { mode: 0o600 });

  try {
    await login("https://api.test", "bootstrap-secret");
  } finally {
    console.error = priorError;
  }

  expect(output.filter((line) => line === WORKSPACE_SYNC_NEXT_STEP)).toHaveLength(1);
  expect(errors).toContain("account already set up — enroll this machine with `rbox pair` from an enrolled machine, or run `rbox key recover`.");
  expect(JSON.parse(await fs.readFile(credentialFile, "utf8"))).toMatchObject({ v: 1, token: "tok", deviceId: "dev_bootstrap" });
  const quarantine = (await fs.readdir(path.dirname(credentialFile))).find((name) => name.startsWith("credentials.json.corrupt-"));
  expect(quarantine).toBeDefined();
  expect(await fs.readFile(path.join(path.dirname(credentialFile), quarantine!))).toEqual(corruptEvidence);
});

describe("device-code post-approval encryption handling", () => {
  test("an exact old-flow device+MK pair routes through the classifier enrollment path before the keyless shortcut", async () => {
    const accountId = "acct_7777777777777777";
    const boot = await bootstrapAccount(accountId, "dev_legacy", 1_900_000_000_000);
    await saveDevice(boot.secrets);
    let enrolled = 0;
    const api = {
      getAccountKeys: async (): Promise<AccountKeysDTO | null> => {
        throw new Error("legacy routing must consult enrollment before the keyless shortcut");
      },
      getGenesisObservation: async () => { throw new Error("unused fake"); },
      bootstrapKeys: async () => { throw new Error("unused fake"); },
    };

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId, deviceId: "dev_legacy" }, { kit: false }, {
      isInteractive: () => false,
      runGenesisEnrollment: async () => {
        enrolled++;
        return "already-setup";
      },
    });

    expect(result).toBe("already-setup");
    expect(enrolled).toBe(1);
  });

  test("existing keys prints the device-code pair/recover note", async () => {
    const api = new FakeGenesisApi([ACCOUNT_KEYS]);
    const err: string[] = [];

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId: "acct_1000000000000003", deviceId: "dev_existing" }, { kit: false }, {
      writeStderr: (s) => void err.push(s),
      runGenesisEnrollment: async () => {
        throw new Error("must not mint when account keys exist");
      },
    });

    expect(result).toBe("existing-keys");
    expect(err.join("")).toContain("device-code login authorized this machine");
    expect(err.join("")).toContain("`rbox pair`");
    expect(err.join("")).toContain("`rbox key recover`");
    expect(err.join("")).toBe(
      `note: device-code login authorized this machine, but encryption is not enrolled.\n1. Run \`rbox pair\` on an enrolled machine or \`rbox key recover\`.\n2. ${WORKSPACE_SYNC_NEXT_STEP}\n`
    );
  });

  test("keyless non-TTY prints the explicit genesis command and mints nothing", async () => {
    const api = new FakeGenesisApi([null]);
    const err: string[] = [];
    let genesisCalls = 0;

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId: "acct_1000000000000009", deviceId: "dev_headless" }, { kit: false }, {
      isInteractive: () => false,
      writeStderr: (s) => void err.push(s),
      runGenesisEnrollment: async () => {
        genesisCalls++;
        return "enrolled";
      },
    });

    expect(result).toBe("headless-command");
    expect(err.join("")).toContain("rbox key genesis --yes");
    expect(genesisCalls).toBe(0);
  });

  test("keyless TTY offers inline genesis", async () => {
    const api = new FakeGenesisApi([null]);
    let confirmed = false;
    let genesisCalls = 0;

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId: "acct_100000000000000a", deviceId: "dev_tty" }, { kit: false }, {
      isInteractive: () => true,
      promptConfirm: async (cfg) => {
        confirmed = cfg.message.includes("first machine");
        return true;
      },
      runGenesisEnrollment: async () => {
        genesisCalls++;
        return "enrolled";
      },
    });

    expect(result).toBe("enrolled");
    expect(confirmed).toBe(true);
    expect(genesisCalls).toBe(1);
  });
});

describe("whole-command pending-genesis gates", () => {
  test("key recover sends the exact legacy device+MK shape through the classifier before phrase read", async () => {
    const accountId = "acct_2121212121212121";
    const deviceId = "dev_legacy_recovery";
    await saveCredentials({ token: "tok", deviceId, remoteUrl: "https://api.test", accountId });
    await saveDevice((await bootstrapAccount(accountId, deviceId, 1_900_000_000_000)).secrets);
    let reads = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://api.test/v1/keys/account");
      throw new Error("recovery classifier reached");
    }) as typeof fetch;

    await expect(recoverCmd({ kit: false }, { isInteractive: () => false, readStdin: async () => { reads++; return "must-not-read"; } })).rejects.toThrow("recovery classifier reached");
    expect(reads).toBe(0);
  });

  test("key recover reads zero phrase when a lock-honoring publisher wins the prompt race",async()=>{
    const accountId="acct_7777777777777777";await saveCredentials({token:"tok",deviceId:"dev_recover",remoteUrl:"https://api.test",accountId});let reads=0,fetches=0;
    globalThis.fetch=(async(input:string|URL|Request)=>{expect(String(input)).toBe("https://api.test/v1/keys/account");fetches++;return new Response(JSON.stringify({error:"not_found",genesisPresenceVersion:1,present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}}),{status:404});}) as typeof fetch;
    const publisherLocks=await acquireGenesisLockPair(accountId),recovery=recoverCmd({kit:false},{isInteractive:()=>false,readStdin:async()=>{reads++;return"must-not-read";}});
    await new Promise<void>(resolve=>setTimeout(resolve,75));
    await publishPrepublishMarker({version:1,accountId,deviceId:"dev_recover",repairId:null,startedAt:"2026-07-22T12:00:00.000Z",phase:"prepublish"});
    await publisherLocks.account.release();await publisherLocks.global.release();
    await expect(recovery).rejects.toThrow(GENESIS_PENDING_MESSAGE);
    expect(reads).toBe(0);expect(fetches).toBe(1);
  });
  test("rbox pair rejects before loading key material or minting a token", async () => {
    const accountId = "acct_8888888888888888";
    await saveCredentials({ token: "tok", deviceId: "dev_pending", remoteUrl: "https://api.test", accountId });
    await markGenesisPending(accountId);
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await expect(pairCreate()).rejects.toThrow(GENESIS_PENDING_MESSAGE);
    expect(fetches).toBe(0);
  });

  test("rbox key backup rejects before reading or displaying the recovery key", async () => {
    const accountId = "acct_9999999999999999";
    await saveCredentials({ token: "tok", deviceId: "dev_pending", remoteUrl: "https://api.test", accountId });
    await saveRecoveryKey(accountId, new Uint8Array(32).fill(7));
    await markGenesisPending(accountId);

    await expect(keyBackup({ kit: false })).rejects.toThrow(GENESIS_PENDING_MESSAGE);
  });

  test("rbox key status is read-only and reports pending without parsing unsafe device or RK bytes", async () => {
    const accountId = "acct_aaaaaaaaaaaaaaab";
    await saveCredentials({ token: "tok", deviceId: "dev_pending", remoteUrl: "https://api.test", accountId });
    await markGenesisPending(accountId);
    const paths = genesisPaths(accountId);
    await fs.writeFile(paths.device, "{malformed-device", { mode: 0o600 });
    await fs.writeFile(paths.rk, "not-a-recovery-key", { mode: 0o600 });
    let stdout = "";
    const oldWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await keyStatus({ json: true });
    } finally {
      process.stdout.write = oldWrite;
    }

    expect(JSON.parse(stdout)).toMatchObject({
      enrolled: false,
      genesisPending: true,
      resumeInstruction: GENESIS_PENDING_MESSAGE,
    });
  });
});

describe("Keychain recovery selection", () => {
  const accountId = "acct_0123456789abcdef";
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

  test("the new offer requires both stdin and stderr TTYs", async () => {
    for (const [stdinTTY, stderrTTY, expectedCalls] of [[true, true, 1], [true, false, 0], [false, true, 0], [false, false, 0]] as const) {
      let resolveCalls = 0;
      const selected = await recoveryPhraseFromKeychain(accountId, {
        stdinTTY,
        stderrTTY,
        readRecord: async () => ({ state: "missing" }),
        resolve: async () => { resolveCalls++; return "/tmp/login.keychain-db"; },
        probe: async () => "present",
        confirm: async () => true,
        read: async () => Buffer.from(phrase),
        validate: async () => {},
      });
      expect(resolveCalls).toBe(expectedCalls);
      expect(Boolean(selected)).toBe(expectedCalls === 1);
    }
  });

  test("a checksum-valid wrong-account candidate warns redacted and falls back before admission", async () => {
    const warnings: string[] = [];
    let reads = 0;
    const selected = await recoveryPhraseFromKeychain(accountId, {
      stdinTTY: true,
      stderrTTY: true,
      readRecord: async () => ({ state: "missing" }),
      resolve: async () => "/tmp/login.keychain-db",
      probe: async () => "present",
      confirm: async () => true,
      read: async () => { reads++; return Buffer.from(phrase); },
      validate: async () => { throw new Error(`wrong wrap for ${phrase}`); },
      warn: (message) => warnings.push(message),
    });
    expect(selected).toBeUndefined();
    expect(reads).toBe(1);
    expect(warnings).toEqual(["Keychain recovery phrase could not be used; enter the phrase manually."]);
    expect(warnings.join(" ")).not.toContain("abandon");
  });

  test("validated persisted metadata supplies the exact identity without resolving again", async () => {
    let resolves = 0;
    const selected = await recoveryPhraseFromKeychain(accountId, {
      stdinTTY: true,
      stderrTTY: true,
      readRecord: async () => ({ state: "recognized", record: {
        version: 2,
        accountId,
        plaintextArtifacts: [],
        keychain: { service: "rbox recovery phrase", account: accountId, keychainPath: "/exact/login.keychain-db", writtenAt: "2026-07-22T12:00:00.000Z" },
      } }),
      resolve: async () => { resolves++; return "/wrong"; },
      realpath: async (value) => value,
      probe: async (artifact) => artifact.keychainPath === "/exact/login.keychain-db" ? "present" : "missing",
      confirm: async () => true,
      read: async (artifact) => { expect(artifact.keychainPath).toBe("/exact/login.keychain-db"); return Buffer.from(phrase); },
      validate: async () => {},
    });
    expect(selected?.phrase).toBe(phrase);
    expect(resolves).toBe(0);
  });
});

describe("recoverCmd production boundary", () => {
  const accountId = "acct_0123456789abcdef";
  const keychainPhrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const manualPhrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
  const loaded = { state: "valid", source: "env", credentials: { v: 1, token: "tok", deviceId: "dev", remoteUrl: "https://api.test", accountId }, legacy: false, extensions: {} } as const;
  const artifact = { service: "rbox recovery phrase" as const, account: accountId, keychainPath: "/tmp/login.keychain-db", discoveredAt: "2026-07-22T12:00:00.000Z" };

  function seam(initial: Awaited<ReturnType<GenesisSeam["pendingGenesis"]>> = "none", trace: string[] = []): GenesisSeam {
    let pending = initial;
    const unused = async (): Promise<never> => { throw new Error("unused") };
    return {
      withAccountGenesisLock: async (_id, operation) => { trace.push("lock-enter"); try { return await operation() } finally { trace.push("lock-exit") } },
      pendingGenesis: async () => pending,
      resumeOrCleanupPendingGenesis: async () => { trace.push("resume"); pending = "none" },
      readValidatedStagedRecoveryKey: async () => undefined,
      readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
      writeCompletionIntent: unused,
      retargetKeychainIntent: unused,
      commitVerifiedRecoveryKitArtifact: unused,
      commitDeliveredRecoveryPhrase: unused,
      quarantineAbandonedAttempt: unused,
    };
  }

  test("real design-180 recovery lock flow restores from a selected Keychain phrase", async () => {
    const current = await bootstrapAccount(accountId, "dev_current", 1_900_000_000_000);
    await saveDevice(current.secrets);
    await publishGenesisEnrollmentWitness(accountId);
    const dto: AccountKeysDTO = {
      recoveryWrap: JSON.stringify(current.upload.recoveryWrap),
      recoveryWrapId: current.upload.recoveryWrapId,
      rosters: [JSON.stringify(current.upload.genesisRoster)],
      keyStates: [JSON.stringify(current.upload.genesisKeyState)],
      devices: [{
        deviceId: "dev_current",
        sigPubkey: current.upload.device.sigPubKey,
        encPubkey: current.upload.device.encPubKey,
        mkWrap: JSON.stringify(current.upload.device.mkWrap),
      }],
    };
    const methods: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      methods.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).endsWith("/v1/keys/account")) return new Response(JSON.stringify(dto));
      if (String(input).endsWith("/v1/keys/admit")) return new Response("{}", { status: 200 });
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as typeof fetch;
    await recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      keychainPhrase: async () => ({ phrase: current.recoveryPhrase, artifact }),
      offerRecoveryKit: async () => {},
      now: () => 1_900_000_000_001,
    });
    expect(methods.map((entry) => entry.split(" ")[0])).toEqual(["GET", "POST"]);
    const recovered = await loadDevice(accountId);
    expect(recovered && "secrets" in recovered ? recovered.secrets.deviceId : "").toStartWith("rec_");
    await expect(fs.access(genesisPaths(accountId).enrolledWitness)).rejects.toThrow();
    expect((await readRecoveryKitRecord(accountId))?.keychain).toMatchObject({ account: accountId, keychainPath: artifact.keychainPath });
  });

  test("the production branch retries the real lock-holding helper only after Keychain pre-admission failure", async () => {
    const seen: string[] = [];
    let passes = 0;
    let offered = "";
    await recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      keychainPhrase: async () => ({ phrase: keychainPhrase, artifact }),
      manualPhrase: async () => manualPhrase,
      enrollWithPhraseInput: async (readPhrase) => {
        passes++;
        const phrase = await readPhrase();
        seen.push(phrase);
        if (passes === 1) throw new RecoveryPreAdmissionError(new Error("current wrap changed"));
        return { accountId, deviceId: "rec_manual", phrase };
      },
      mergeDiscovered: async () => { throw new Error("manual fallback must not merge Keychain metadata") },
      offerRecoveryKit: async (phrase) => { offered = phrase },
    });
    expect({ passes, seen, offered }).toEqual({ passes: 2, seen: [keychainPhrase, manualPhrase], offered: manualPhrase });
  });

  test("the production branch never retries an ordinary post-persistence failure", async () => {
    let passes = 0;
    let manuals = 0;
    await expect(recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      keychainPhrase: async () => ({ phrase: keychainPhrase, artifact }),
      manualPhrase: async () => { manuals++; return manualPhrase },
      enrollWithPhraseInput: async (readPhrase) => {
        passes++;
        await readPhrase();
        throw new Error("admission failed after persistence");
      },
      offerRecoveryKit: async () => {},
    })).rejects.toThrow("admission failed after persistence");
    expect({ passes, manuals }).toEqual({ passes: 1, manuals: 0 });
  });

  test("holds the account lock across pending cleanup, selection, persistence, and admission", async () => {
    const trace: string[] = [];
    const pending = { kind: "cleanup-resume" as const, journal: { accountId, requestSha256: "a".repeat(64) } };
    await recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      genesisSeam: seam(pending, trace),
      keychainPhrase: async () => { trace.push("select"); return undefined },
      manualPhrase: async () => { trace.push("manual"); return manualPhrase },
      enroll: async () => { trace.push("persist-admit"); return { accountId, deviceId: "recovered" } },
      offerRecoveryKit: async () => { trace.push("offer") },
    });
    expect(trace).toEqual(["lock-enter", "resume", "select", "manual", "persist-admit", "lock-exit", "offer"]);
  });

  test("completes a committed pending journal before recovery phrase selection", async () => {
    const requestSha256 = "d".repeat(64);
    const committed = { kind: "committed-this-attempt" as const, journal: { accountId, requestSha256 }, phrase: keychainPhrase };
    let pending: Awaited<ReturnType<GenesisSeam["pendingGenesis"]>> = committed;
    const trace: string[] = [];
    const committedSeam: GenesisSeam = {
      withAccountGenesisLock: async (_id, operation) => { trace.push("lock-enter"); try { return await operation() } finally { trace.push("lock-exit") } },
      pendingGenesis: async () => pending,
      resumeOrCleanupPendingGenesis: async () => { throw new Error("committed state must use completion") },
      readValidatedStagedRecoveryKey: async () => ({ accountId, requestSha256, originalCacheRecovery: false, rk: await phraseToRk(keychainPhrase) }),
      readAndReconcileCompletionIntent: async () => ({ state: "intent", intent: { version: 1, accountId, requestSha256, mode: "phrase-display", intentAt: "2026-07-22T12:00:00.000Z" } }),
      writeCompletionIntent: async () => { throw new Error("intent already exists") },
      retargetKeychainIntent: async () => { throw new Error("wrong mode") },
      commitVerifiedRecoveryKitArtifact: async () => { throw new Error("wrong receipt") },
      commitDeliveredRecoveryPhrase: async () => { trace.push("completion-receipt"); pending = "none" },
      quarantineAbandonedAttempt: async () => { throw new Error("unused") },
    };
    await recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      genesisSeam: committedSeam,
      genesisCompletion: {
        validatePhrase: async () => { trace.push("validate-staged") },
        select: async () => { throw new Error("existing intent must resume without selection") },
        displayPhrase: async () => { trace.push("display-staged") },
        saveKeychain: async () => { throw new Error("wrong mode") },
        saveFile: async () => { throw new Error("wrong mode") },
      },
      keychainPhrase: async () => { trace.push("select-recovery"); return undefined },
      manualPhrase: async () => manualPhrase,
      enroll: async () => { trace.push("persist-admit"); return { accountId, deviceId: "recovered" } },
      offerRecoveryKit: async () => { trace.push("offer") },
    });
    expect(trace).toEqual(["lock-enter", "validate-staged", "display-staged", "completion-receipt", "select-recovery", "persist-admit", "lock-exit", "offer"]);
  });

  test("only a pre-admission Keychain failure reopens manual selection", async () => {
    let enrolls = 0;
    let manuals = 0;
    await recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      genesisSeam: seam(),
      keychainPhrase: async () => ({ phrase: keychainPhrase, artifact }),
      manualPhrase: async () => { manuals++; return manualPhrase },
      enroll: async (phrase) => {
        enrolls++;
        if (enrolls === 1) { expect(phrase).toBe(keychainPhrase); throw new RecoveryPreAdmissionError(new Error("wrong current wrap")) }
        expect(phrase).toBe(manualPhrase);
        return { accountId, deviceId: "recovered" };
      },
      mergeDiscovered: async () => { throw new Error("manual fallback must not merge Keychain metadata") },
      offerRecoveryKit: async () => {},
    });
    expect({ enrolls, manuals }).toEqual({ enrolls: 2, manuals: 1 });
  });

  test("post-persistence admission failures never prompt for a second phrase", async () => {
    let manuals = 0;
    await expect(recoverCmd({ kit: false }, {
      loadCredentials: async () => loaded,
      genesisSeam: seam(),
      keychainPhrase: async () => ({ phrase: keychainPhrase, artifact }),
      manualPhrase: async () => { manuals++; return manualPhrase },
      enroll: async () => { throw new Error("admission request failed after persistence") },
      offerRecoveryKit: async () => {},
    })).rejects.toThrow(/admission request failed/);
    expect(manuals).toBe(0);
  });

  test("the four-way TTY selection matrix is exercised through recoverCmd", async () => {
    for (const [stdinTTY, stderrTTY] of [[true, true], [true, false], [false, true], [false, false]] as const) {
      let manualCalls = 0;
      let enrolledPhrase = "";
      await recoverCmd({ kit: false }, {
        loadCredentials: async () => loaded,
        genesisSeam: seam(),
        keychainPhrase: (id) => recoveryPhraseFromKeychain(id, {
          stdinTTY,
          stderrTTY,
          readRecord: async () => ({ state: "missing" }),
          resolve: async () => artifact.keychainPath,
          probe: async () => "present",
          confirm: async () => true,
          read: async () => Buffer.from(keychainPhrase),
          validate: async () => {},
        }),
        manualPhrase: async () => { manualCalls++; return manualPhrase },
        enroll: async (phrase) => { enrolledPhrase = phrase; return { accountId, deviceId: "recovered" } },
        mergeDiscovered: async () => {},
        offerRecoveryKit: async () => {},
      });
      const usesKeychain = stdinTTY && stderrTTY;
      expect(enrolledPhrase).toBe(usesKeychain ? keychainPhrase : manualPhrase);
      expect(manualCalls).toBe(usesKeychain ? 0 : 1);
    }
  });

  test("wrong and historically authorized envelopes fail at key-save and recovery command boundaries", async () => {
    const current = await bootstrapAccount(accountId, "dev_current", 1_900_000_000_000);
    const foreign = await bootstrapAccount(accountId, "dev_foreign", 1_900_000_000_001);
    const currentWrapHash = await wrapHash(current.upload.recoveryWrap);
    const rotatedState = await buildKeyState({
      accountId,
      accountEpoch: 1,
      prevStateHash: current.upload.genesisKeyState.stateHash,
      rosterVersion: 0,
      rosterHash: current.upload.genesisRoster.rosterHash,
      keyEpoch: 1,
      mkWrapHashes: [currentWrapHash, foreign.upload.recoveryWrapId],
      recoveryWrapId: foreign.upload.recoveryWrapId,
      signerDeviceId: "dev_current",
      signKey: { publicKey: current.secrets.sigPubKey, privateKey: signPrivateFromPkcs8(current.secrets.sigPrivPkcs8) },
    });
    const base = {
      recoveryWrapId: current.upload.recoveryWrapId,
      rosters: [JSON.stringify(current.upload.genesisRoster)],
      devices: [],
    };
    const cases: Array<[string, AccountKeysDTO]> = [
      ["wrong", { ...base, recoveryWrap: JSON.stringify(foreign.upload.recoveryWrap), keyStates: [JSON.stringify(current.upload.genesisKeyState)] }],
      ["historical", { ...base, recoveryWrap: JSON.stringify(current.upload.recoveryWrap), keyStates: [JSON.stringify(current.upload.genesisKeyState), JSON.stringify(rotatedState)] }],
    ];
    for (const [label, dto] of cases) {
      const methods: string[] = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return new Response(JSON.stringify(dto));
      }) as typeof fetch;
      let saves = 0;
      await expect(keySave({ kit: true }, {
        loadCredentials: async () => loaded,
        loadRecoveryKey: async () => phraseToRk(current.recoveryPhrase),
        savePhrase: async () => { saves++ },
      })).rejects.toThrow(/recovery wrap is not the current wrap/);
      expect(saves).toBe(0);
      expect(methods).toEqual(["GET"]);

      methods.length = 0;
      let manuals = 0;
      await expect(recoverCmd({ kit: false }, {
        loadCredentials: async () => loaded,
        genesisSeam: seam(),
        keychainPhrase: async () => ({ phrase: current.recoveryPhrase, artifact }),
        manualPhrase: async () => { manuals++; return current.recoveryPhrase },
        offerRecoveryKit: async () => {},
      })).rejects.toThrow(/recovery wrap is not the current wrap/);
      expect(manuals).toBe(1);
      expect(methods).toEqual(["GET", "GET"]);
      expect(methods).not.toContain("POST");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("key save phrase sources", () => {
  const accountId = "acct_0123456789abcdef";
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
  const loaded = async () => ({ state: "valid", source: "env", credentials: { v: 1, token: "tok", deviceId: "dev", remoteUrl: "https://api.test", accountId }, legacy: false, extensions: {} } as const);

  test("cached RK never reads stdin and is validated before save", async () => {
    const events: string[] = [];
    await keySave({ kit: true }, {
      loadCredentials: loaded,
      loadRecoveryKey: async () => phraseToRk(phrase),
      readPhraseStdin: async () => { throw new Error("stdin must not be read"); },
      validatePhrase: async (candidate) => { expect(candidate).toBe(phrase); events.push("validated"); },
      savePhrase: async (candidate) => { expect(candidate).toBe(phrase); events.push("saved"); },
    });
    expect(events).toEqual(["validated", "saved"]);
  });

  test("typed/piped wrong-account phrase stores nothing", async () => {
    let saves = 0;
    await expect(keySave({ kit: true }, {
      loadCredentials: loaded,
      loadRecoveryKey: async () => undefined,
      readPhraseStdin: async () => phrase,
      validatePhrase: async () => { throw new Error("current envelope mismatch"); },
      savePhrase: async () => { saves++; },
    })).rejects.toThrow(/current envelope mismatch/);
    expect(saves).toBe(0);
  });

  test("production key save and re-save use the real Keychain and record modules", async () => {
    const keychainPath = path.join(home, "login.keychain-db");
    let adds = 0;
    const keychainSeams = {
      platform: "darwin" as const,
      securityBinExists: async () => true,
      realpath: async (value: string) => value,
      runSecurity: async (args: readonly string[], stdin: Uint8Array | undefined) => {
        if (args[0] === "login-keychain") return { outcome: "exit" as const, code: 0, stdout: Buffer.from(`    "${keychainPath}"\n`), stderr: new Uint8Array() };
        if (args[0] === "-i") {
          adds++;
          expect(Buffer.from(stdin!).toString("utf8")).toContain("add-generic-password -U");
          return { outcome: "exit" as const, code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
        }
        expect(args[0]).toBe("find-generic-password");
        return { outcome: "exit" as const, code: 0, stdout: Buffer.from(`${phrase}\n`), stderr: new Uint8Array() };
      },
    };
    const deps = {
      loadCredentials: loaded,
      loadRecoveryKey: async () => phraseToRk(phrase),
      validatePhrase: async () => {},
      seams: keychainSeams,
    };
    await keySave({ kit: true }, deps);
    const first = await readRecoveryKitRecord(accountId);
    expect(first?.keychain).toMatchObject({ account: accountId, keychainPath });
    await keySave({ kit: true }, deps);
    const second = await readRecoveryKitRecord(accountId);
    expect(adds).toBe(2);
    expect(second?.keychain).toMatchObject({ service: "rbox recovery phrase", account: accountId, keychainPath });
    expect(second?.plaintextArtifacts).toEqual(first?.plaintextArtifacts);
  });
});
