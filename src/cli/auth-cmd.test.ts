import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleDeviceCodePostApprovalEncryption,
  deviceCodeLoginShouldPrintWorkspaceStep,
  deviceApprovalUrl,
  login,
  logout,
  pairingRedemptionSuccessMessages,
  pairCreate,
  readPairingTokenInteractive,
  recoverCmd,
  runGenesisEnrollment,
  keyBackup,
  keyStatus,
  WORKSPACE_SYNC_NEXT_STEP,
} from "./auth-cmd.js";
import { accountProfilePath, flushAccountProfileWrites, scheduleAccountProfileWrite } from "./account-profile.js";
import { saveCredentials } from "./credentials.js";
import { _setSpawner } from "./browser-open.js";
import { AccountAlreadyBootstrappedError } from "./remote.js";
import { acquireGenesisLock, hasDevice, loadRecoveryKey, saveDevice, saveRecoveryKey } from "./e2ee-keystore.js";
import type { AccountKeysDTO, GenesisAccountObservation, GenesisPresence } from "./e2ee-remote.js";
import { bootstrapAccount } from "../engine/e2ee/index.js";
import { GENESIS_PENDING_MESSAGE, genesisPaths, publishPrepublishMarker } from "./genesis-durable.js";

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
  await saveCredentials({ token: "tok", deviceId: "dev", remoteUrl: "https://api.test", accountId: "acct_logout" });
  scheduleAccountProfileWrite({ accountId: "acct_logout", email: "owner@example.com", signInMethod: "github" });
  await logout();
  await flushAccountProfileWrites();
  expect(await fs.exists(path.join(home, ".rbox", "credentials.json"))).toBe(false);
  expect(await fs.exists(accountProfilePath())).toBe(false);
  await expect(logout()).resolves.toBeUndefined();
});

describe("runGenesisEnrollment", () => {
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
      return new Response(JSON.stringify({ status: "approved", token: "tok", deviceId: "dev_success", accountId: "acct_success" }));
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

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId: "acct_existing", deviceId: "dev_existing" }, { kit: false }, {
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

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId: "acct_headless", deviceId: "dev_headless" }, { kit: false }, {
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

    const result = await handleDeviceCodePostApprovalEncryption(api, { accountId: "acct_tty", deviceId: "dev_tty" }, { kit: false }, {
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
  test("key recover rechecks an injected prompt-seam artifact under the retained lock before phrase read",async()=>{
    const accountId="acct_7777777777777777";await saveCredentials({token:"tok",deviceId:"dev_recover",remoteUrl:"https://api.test",accountId});let reads=0;globalThis.fetch=(async(input:string|URL|Request)=>{expect(String(input)).toBe("https://api.test/v1/keys/account");return new Response(JSON.stringify({error:"not_found",genesisPresenceVersion:1,present:{rosters:0,keyStates:0,devices:0,workspaces:0,workspaceKeys:0,e2eePairingTokens:0}}),{status:404});}) as typeof fetch;
    await expect(recoverCmd({kit:false},{isInteractive:()=>false,readStdin:async()=>{reads++;return"must-not-read";},beforePhraseRead:async()=>{await markGenesisPending(accountId,"dev_recover");}})).rejects.toThrow(GENESIS_PENDING_MESSAGE);expect(reads).toBe(0);
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
