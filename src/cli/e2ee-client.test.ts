import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireClearMachineGenesisForPairing, assertNoPendingGenesis, enrollViaPairing, parsePairingToken } from "./e2ee-client.js";
import { bootstrapAccount } from "../engine/e2ee/index.js";
import { saveDevice } from "./e2ee-keystore.js";
import { e2eeRoot, GENESIS_PENDING_MESSAGE, publishPrepublishMarker } from "./genesis-durable.js";
import { acquireGlobalGenesisLock } from "./genesis-locks.js";

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
