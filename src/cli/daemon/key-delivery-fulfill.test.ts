import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bootstrapAccount,
  buildAdminRoster,
  canonicalString,
  generateSignKeyPair,
  generateWrapKeyPair,
  rsaDeviceWrap,
  sha256,
  sha256Hex,
  signPrivateFromPkcs8,
  toB64url,
  utf8,
  verifyAccount,
  wrapHash,
  type DeviceSecrets,
  type RosterEntry,
  type SignedKeyState,
  type SignedRoster,
} from "../../engine/e2ee/index.js";
import type { WorkspaceConfig } from "../config.js";
import type { AccountKeysDTO } from "../e2ee-remote.js";
import type { SyncDeps } from "../sync.js";
import { RboxDaemon } from "./daemon.js";
import {
  KeyDeliveryFulfillmentFlight,
  keyDeliveryPreferenceOverrideFromEnv,
  keyDeliveryJournalPath,
  loadKeyDeliveryDaemonPreference,
  parseKeyDeliveryNudge,
  saveKeyDeliveryDaemonPreference,
  validateKeyDeliveryFetchResponse,
  type KeyDeliveryDaemonPreference,
  type KeyDeliveryFlightPort,
  type KeyDeliveryFulfillmentApi,
  type KeyDeliveryRequest,
  type KeyDeliverySubmitBody,
} from "./key-delivery-fulfill.js";

const ACCOUNT_ID = "acct_0123456789abcdef";
const SOURCE_ID = "dev_source";
const TARGET_ID = "dev_target";
const REQUEST_ID = "a".repeat(64);
const NOW = 1_900_000_000_000;

let home: string;
let savedRboxHome: string | undefined;

beforeEach(async () => {
  savedRboxHome = process.env.RBOX_HOME;
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-key-delivery-"));
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (savedRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = savedRboxHome;
  await fs.rm(home, { recursive: true, force: true });
});

interface Fixture {
  source: DeviceSecrets;
  request: KeyDeliveryRequest;
  dto: AccountKeysDTO;
}

async function fixture(): Promise<Fixture> {
  const source = await bootstrapAccount(ACCOUNT_ID, SOURCE_ID, NOW - 60_000);
  const targetSig = generateSignKeyPair();
  const targetEnc = generateWrapKeyPair();
  const encPubKey = toB64url(targetEnc.publicKeySpki);
  const sigPubKey = toB64url(targetSig.publicKey);
  const request: KeyDeliveryRequest = {
    requestId: REQUEST_ID,
    targetDeviceId: TARGET_ID,
    encPubKey,
    sigPubKey,
    encPubKeyHash: await sha256Hex(targetEnc.publicKeySpki),
    sigPubKeyHash: await sha256Hex(targetSig.publicKey),
    pubkeyFingerprint: toB64url(await sha256(utf8(canonicalString({ encPubKeySpki: encPubKey, sigPubKey })))),
    approvalTokenHash: "b".repeat(64),
    accountEpoch: 0,
    approvedAt: NOW - 1_000,
    expiresAt: NOW + 9 * 60_000,
  };
  return {
    source: source.secrets,
    request,
    dto: {
      recoveryWrap: JSON.stringify(source.upload.recoveryWrap),
      recoveryWrapId: source.upload.recoveryWrapId,
      rosters: [JSON.stringify(source.upload.genesisRoster)],
      keyStates: [JSON.stringify(source.upload.genesisKeyState)],
      devices: [{
        deviceId: SOURCE_ID,
        sigPubkey: source.upload.device.sigPubKey,
        encPubkey: source.upload.device.encPubKey,
        mkWrap: JSON.stringify(source.upload.device.mkWrap),
      }],
    },
  };
}

class FakeApi implements KeyDeliveryFulfillmentApi {
  fetchBodies: Array<{ requestId?: string; keyReleaseOptIn: boolean }> = [];
  publishBodies: Array<Parameters<KeyDeliveryFulfillmentApi["publish"]>[0]> = [];
  submitBodies: KeyDeliverySubmitBody[] = [];
  fulfilled = false;
  conflictOnce = false;
  publishCommitThenThrow = false;
  advanceAfterCommit = false;
  revokeAfterCommit = false;
  private threwAfterCommit = false;

  constructor(readonly state: Fixture) {}

  async fetch(body: { requestId?: string; keyReleaseOptIn: boolean }): Promise<unknown> {
    this.fetchBodies.push(body);
    if (!body.keyReleaseOptIn) return { request: null, keyReleaseEnabled: false };
    if (this.fulfilled) return { request: null };
    if (body.requestId !== undefined && body.requestId !== this.state.request.requestId) return { request: null };
    return { request: this.state.request };
  }

  async getAccountKeys(): Promise<AccountKeysDTO> {
    return this.state.dto;
  }

  async advanceRosterWithoutTarget(): Promise<void> {
    const current = JSON.parse(this.state.dto.rosters.at(-1)!) as SignedRoster;
    const body = JSON.parse(current.body);
    const next = await buildAdminRoster(body, body.devices, SOURCE_ID, {
      publicKey: this.state.source.sigPubKey,
      privateKey: signPrivateFromPkcs8(this.state.source.sigPrivPkcs8),
    });
    this.state.dto.rosters.push(JSON.stringify(next));
  }

  private commit(body: Parameters<KeyDeliveryFulfillmentApi["publish"]>[0]): void {
    this.state.dto.devices.push({
      deviceId: body.device.deviceId,
      sigPubkey: body.device.sigPubKey,
      encPubkey: body.device.encPubKey,
      mkWrap: body.device.mkWrap,
    });
    this.state.dto.rosters.push(body.roster.signed);
  }

  async publish(body: Parameters<KeyDeliveryFulfillmentApi["publish"]>[0]): Promise<{ ok: boolean; conflict?: boolean }> {
    this.publishBodies.push(body);
    if (this.conflictOnce) {
      this.conflictOnce = false;
      await this.advanceRosterWithoutTarget();
      return { ok: false, conflict: true };
    }
    this.commit(body);
    if (this.advanceAfterCommit) await this.advanceRosterWithoutTarget();
    if (this.revokeAfterCommit) {
      const current = JSON.parse(this.state.dto.rosters.at(-1)!) as SignedRoster;
      const currentBody = JSON.parse(current.body);
      const revoked = await buildAdminRoster(
        currentBody,
        currentBody.devices.map((entry: RosterEntry) =>
          entry.deviceId === TARGET_ID ? { ...entry, status: "revoked" as const } : entry
        ),
        SOURCE_ID,
        {
          publicKey: this.state.source.sigPubKey,
          privateKey: signPrivateFromPkcs8(this.state.source.sigPrivPkcs8),
        },
      );
      this.state.dto.rosters.push(JSON.stringify(revoked));
    }
    if (this.publishCommitThenThrow && !this.threwAfterCommit) {
      this.threwAfterCommit = true;
      throw new Error("connection closed after publish commit");
    }
    return { ok: true };
  }

  async submit(body: KeyDeliverySubmitBody): Promise<unknown> {
    this.submitBodies.push(body);
    const row = this.state.dto.devices.find((candidate) => candidate.deviceId === TARGET_ID);
    if (!row || row.mkWrap !== body.mkWrapDevice) throw new Error("submit did not adopt committed wrap");
    this.fulfilled = true;
    return { ok: true, requestId: body.requestId };
  }
}

function preference(enabled = true, optIn = true): KeyDeliveryDaemonPreference {
  return {
    version: 1,
    accountId: ACCOUNT_ID,
    deviceId: SOURCE_ID,
    keyReleaseOptIn: optIn,
    fulfillmentEnabled: enabled,
  };
}

function flight(
  state: Fixture,
  api: FakeApi,
  overrides: {
    pullOnly?: boolean;
    retryBudget?: number;
    onBoundary?: (boundary: "after-stage" | "after-publish" | "after-submit") => void | Promise<void>;
    wrapDevice?: typeof rsaDeviceWrap;
    loadPreference?: () => Promise<KeyDeliveryDaemonPreference>;
    preferenceOverride?: { keyReleaseOptIn?: boolean; fulfillmentEnabled?: boolean };
  } = {},
): KeyDeliveryFulfillmentFlight {
  return new KeyDeliveryFulfillmentFlight({
    accountId: ACCOUNT_ID,
    deviceId: SOURCE_ID,
    workspaceId: "ws_test",
    pullOnly: overrides.pullOnly ?? false,
    api,
    log: () => {},
    retryBudget: overrides.retryBudget,
    preferenceOverride: overrides.preferenceOverride,
    hooks: {
      now: () => NOW,
      random: () => 0.5,
      sleep: async () => {},
      loadDevice: async () => ({ secrets: state.source }),
      loadPin: async () => undefined,
      loadPreference: overrides.loadPreference ?? (async () => preference()),
      onBoundary: overrides.onBoundary,
      wrapDevice: overrides.wrapDevice,
    },
  });
}

async function run(worker: KeyDeliveryFulfillmentFlight, requestId: string | undefined = REQUEST_ID): Promise<void> {
  worker.enqueue(requestId);
  await worker.drain();
}

async function verifiedRoster(dto: AccountKeysDTO): Promise<Awaited<ReturnType<typeof verifyAccount>>> {
  return verifyAccount(
    dto.rosters.map((raw) => JSON.parse(raw) as SignedRoster),
    dto.keyStates.map((raw) => JSON.parse(raw) as SignedKeyState),
  );
}

describe("design 189 daemon fulfillment", () => {
  test("binds the exact WS and HTTP response shapes", async () => {
    expect(parseKeyDeliveryNudge(JSON.stringify({ type: "key-delivery", requestId: REQUEST_ID }))).toBe(REQUEST_ID);
    expect(parseKeyDeliveryNudge(JSON.stringify({ type: "key-delivery", requestId: REQUEST_ID, extra: true }))).toBeUndefined();
    expect(parseKeyDeliveryNudge(JSON.stringify({ type: "committed", requestId: REQUEST_ID }))).toBeUndefined();
    expect(await validateKeyDeliveryFetchResponse({ request: null }, REQUEST_ID, NOW)).toBeNull();
    await expect(validateKeyDeliveryFetchResponse({ request: null, keyReleaseEnabled: true }, REQUEST_ID, NOW)).rejects.toThrow();
  });

  test("rejects expired, wrong-epoch, mismatched-key, and revoked-target work before wrapping", async () => {
    const cases: Array<(state: Fixture) => Promise<void> | void> = [
      (state) => { state.request.expiresAt = NOW; },
      (state) => { state.request.accountEpoch = 1; },
      (state) => { state.request.encPubKeyHash = "c".repeat(64); },
      async (state) => {
        const current = JSON.parse(state.dto.rosters[0]!) as SignedRoster;
        const currentBody = JSON.parse(current.body);
        const stagedWrap = await rsaDeviceWrap(
          Uint8Array.from(Buffer.from(state.request.encPubKey, "base64url")),
          state.source.mk,
          { accountId: ACCOUNT_ID, accountEpoch: 0, wrappedKeyKind: "MK", purpose: "rbox/mk-wrap/device/v1" },
        );
        const active: RosterEntry = {
          deviceId: TARGET_ID,
          sigAlg: "Ed25519",
          encAlg: "RSA-OAEP-3072-SHA256",
          sigPubKey: state.request.sigPubKey,
          encPubKey: state.request.encPubKey,
          role: "admin",
          kind: "device",
          addedAt: NOW - 2_000,
          status: "active",
          mkWrapHash: await wrapHash(stagedWrap),
        };
        const v1 = await buildAdminRoster(currentBody, [...currentBody.devices, active], SOURCE_ID, {
          publicKey: state.source.sigPubKey,
          privateKey: signPrivateFromPkcs8(state.source.sigPrivPkcs8),
        });
        const v1body = JSON.parse(v1.body);
        const v2 = await buildAdminRoster(v1body, v1body.devices.map((entry: RosterEntry) =>
          entry.deviceId === TARGET_ID ? { ...entry, status: "revoked" as const } : entry
        ), SOURCE_ID, {
          publicKey: state.source.sigPubKey,
          privateKey: signPrivateFromPkcs8(state.source.sigPrivPkcs8),
        });
        state.dto.rosters.push(JSON.stringify(v1), JSON.stringify(v2));
        state.dto.devices.push({
          deviceId: TARGET_ID,
          sigPubkey: state.request.sigPubKey,
          encPubkey: state.request.encPubKey,
          mkWrap: JSON.stringify(stagedWrap),
        });
      },
    ];
    for (const mutate of cases) {
      const state = await fixture();
      await mutate(state);
      const api = new FakeApi(state);
      let wraps = 0;
      await run(flight(state, api, {
        retryBudget: 0,
        wrapDevice: async (...args) => {
          wraps++;
          return rsaDeviceWrap(...args);
        },
      }));
      expect(wraps).toBe(0);
      expect(api.publishBodies).toHaveLength(0);
      expect(api.submitBodies).toHaveLength(0);
    }
  });

  test("builds an admin roster, atomically publishes the device row, then submits exact wire fields", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    await run(flight(state, api));

    expect(api.publishBodies).toHaveLength(1);
    expect(api.submitBodies).toHaveLength(1);
    expect(Object.keys(api.submitBodies[0]!).sort()).toEqual([
      "accountEpoch",
      "mkWrapDevice",
      "publishedRosterVersion",
      "requestId",
    ]);
    const account = await verifiedRoster(state.dto);
    const target = account.currentRoster.devices.find((entry) => entry.deviceId === TARGET_ID)!;
    expect(target.status).toBe("active");
    expect(target.mkWrapHash).toBe(await wrapHash(JSON.parse(api.submitBodies[0]!.mkWrapDevice)));
    expect(api.submitBodies[0]!.publishedRosterVersion).toBe(account.currentRoster.version);
  });

  test("reuses staged randomized wrap bytes across a restart after stage", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    let wraps = 0;
    let crash = true;
    const wrapDevice: typeof rsaDeviceWrap = async (...args) => {
      wraps++;
      return rsaDeviceWrap(...args);
    };
    await run(flight(state, api, {
      retryBudget: 0,
      wrapDevice,
      onBoundary: (boundary) => {
        if (boundary === "after-stage" && crash) {
          crash = false;
          throw new Error("kill");
        }
      },
    }));
    const staged = JSON.parse(await fs.readFile(keyDeliveryJournalPath(ACCOUNT_ID, REQUEST_ID), "utf8"));
    await run(flight(state, api, { retryBudget: 0, wrapDevice }));
    expect(wraps).toBe(1);
    expect(api.publishBodies[0]!.device.mkWrap).toBe(staged.mkWrapDevice);
    expect(api.publishBodies[0]!.roster.signed).toBe(staged.signedRoster);
    expect(api.submitBodies[0]!.mkWrapDevice).toBe(staged.mkWrapDevice);
  });

  test("ADOPTs the committed wrap after publish commit-before-response without a double insert", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    api.publishCommitThenThrow = true;
    await run(flight(state, api, { retryBudget: 0 }));
    expect(state.dto.devices.filter((row) => row.deviceId === TARGET_ID)).toHaveLength(1);
    const committed = state.dto.devices.find((row) => row.deviceId === TARGET_ID)!.mkWrap!;

    await run(flight(state, api, { retryBudget: 0 }));
    expect(api.publishBodies).toHaveLength(1);
    expect(state.dto.devices.filter((row) => row.deviceId === TARGET_ID)).toHaveLength(1);
    expect(api.submitBodies[0]!.mkWrapDevice).toBe(committed);
  });

  test("ADOPTs another daemon's different committed randomized wrap without wrapping again", async () => {
    const state = await fixture();
    const externalWrap = await rsaDeviceWrap(
      Uint8Array.from(Buffer.from(state.request.encPubKey, "base64url")),
      state.source.mk,
      { accountId: ACCOUNT_ID, accountEpoch: 0, wrappedKeyKind: "MK", purpose: "rbox/mk-wrap/device/v1" },
    );
    const current = JSON.parse(state.dto.rosters[0]!) as SignedRoster;
    const currentBody = JSON.parse(current.body);
    const entry: RosterEntry = {
      deviceId: TARGET_ID,
      sigAlg: "Ed25519",
      encAlg: "RSA-OAEP-3072-SHA256",
      sigPubKey: state.request.sigPubKey,
      encPubKey: state.request.encPubKey,
      role: "admin",
      kind: "device",
      addedAt: state.request.approvedAt,
      status: "active",
      mkWrapHash: await wrapHash(externalWrap),
    };
    const roster = await buildAdminRoster(currentBody, [...currentBody.devices, entry], SOURCE_ID, {
      publicKey: state.source.sigPubKey,
      privateKey: signPrivateFromPkcs8(state.source.sigPrivPkcs8),
    });
    const committed = JSON.stringify(externalWrap);
    state.dto.rosters.push(JSON.stringify(roster));
    state.dto.devices.push({
      deviceId: TARGET_ID,
      sigPubkey: state.request.sigPubKey,
      encPubkey: state.request.encPubKey,
      mkWrap: committed,
    });
    const api = new FakeApi(state);
    let wraps = 0;
    await run(flight(state, api, {
      wrapDevice: async (...args) => {
        wraps++;
        return rsaDeviceWrap(...args);
      },
    }));
    expect(wraps).toBe(0);
    expect(api.publishBodies).toHaveLength(0);
    expect(api.submitBodies[0]!.mkWrapDevice).toBe(committed);
  });

  test("rebases and re-signs after a 409 with the row absent while retaining the staged wrap", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    api.conflictOnce = true;
    let wraps = 0;
    await run(flight(state, api, {
      wrapDevice: async (...args) => {
        wraps++;
        return rsaDeviceWrap(...args);
      },
    }));
    expect(api.publishBodies).toHaveLength(2);
    expect(api.publishBodies[1]!.roster.version).toBe(2);
    expect(api.publishBodies[1]!.device.mkWrap).toBe(api.publishBodies[0]!.device.mkWrap);
    expect(wraps).toBe(1);
    expect(api.submitBodies).toHaveLength(1);
  });

  test("submits the latest verified head after an unrelated post-publish roster race", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    api.advanceAfterCommit = true;
    await run(flight(state, api));
    expect(api.submitBodies).toHaveLength(1);
    expect(api.submitBodies[0]!.publishedRosterVersion).toBe(2);
    expect(api.submitBodies[0]!.mkWrapDevice).toBe(api.publishBodies[0]!.device.mkWrap);
  });

  test("a revoke race after publish prevents the MK blob submission", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    api.revokeAfterCommit = true;
    await run(flight(state, api, { retryBudget: 0 }));
    expect(api.publishBodies).toHaveLength(1);
    expect(api.submitBodies).toHaveLength(0);
  });

  test("a crash after blob post resumes terminally without republishing or double-submitting", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    let crash = true;
    const first = flight(state, api, {
      retryBudget: 0,
      onBoundary: (boundary) => {
        if (boundary === "after-submit" && crash) {
          crash = false;
          throw new Error("kill");
        }
      },
    });
    first.enqueue();
    await first.drain();
    expect(api.fulfilled).toBeTrue();
    expect(await fs.stat(keyDeliveryJournalPath(ACCOUNT_ID, REQUEST_ID))).toBeDefined();
    const optedOut = flight(state, api, {
      retryBudget: 0,
      loadPreference: async () => preference(true, false),
    });
    optedOut.enqueue();
    await optedOut.drain();
    expect(await fs.stat(keyDeliveryJournalPath(ACCOUNT_ID, REQUEST_ID))).toBeDefined();
    const resumed = flight(state, api, { retryBudget: 0 });
    resumed.enqueue();
    await resumed.drain();
    expect(api.publishBodies).toHaveLength(1);
    expect(api.submitBodies).toHaveLength(1);
    await expect(fs.stat(keyDeliveryJournalPath(ACCOUNT_ID, REQUEST_ID))).rejects.toMatchObject({ code: "ENOENT" });
    const account = await verifiedRoster(state.dto);
    const target = account.currentRoster.devices.find((entry) => entry.deviceId === TARGET_ID)!;
    expect(target.mkWrapHash).toBe(await wrapHash(JSON.parse(api.submitBodies[0]!.mkWrapDevice)));
  });

  test("pull-only remains off until its separately persisted release opt-in is true; kill switch sends false", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    await run(flight(state, api, {
      pullOnly: true,
      loadPreference: async () => preference(true, false),
    }));
    expect(api.fetchBodies[0]).toEqual({ requestId: REQUEST_ID, keyReleaseOptIn: false });
    expect(api.publishBodies).toHaveLength(0);

    await saveKeyDeliveryDaemonPreference(preference(true, true));
    await run(flight(state, api, {
      pullOnly: true,
      loadPreference: async () => JSON.parse(await fs.readFile(
        path.join(home, ".rbox", "e2ee", ACCOUNT_ID, "key-delivery", `daemon-${await sha256Hex(utf8(SOURCE_ID))}.prefs.json`),
        "utf8",
      )),
    }));
    expect(api.fetchBodies[1]).toEqual({ requestId: REQUEST_ID, keyReleaseOptIn: true });
    expect(api.publishBodies).toHaveLength(1);

    const next = await fixture();
    const killed = new FakeApi(next);
    await run(flight(next, killed, { loadPreference: async () => preference(false, true) }));
    expect(killed.fetchBodies[0]!.keyReleaseOptIn).toBeFalse();
    expect(killed.publishBodies).toHaveLength(0);

    const controlled = await fixture();
    const controlledApi = new FakeApi(controlled);
    await saveKeyDeliveryDaemonPreference(preference(true, false));
    const envOverride = keyDeliveryPreferenceOverrideFromEnv({
      RBOX_DAEMON_KEY_RELEASE_OPT_IN: "1",
    } as NodeJS.ProcessEnv);
    await run(flight(controlled, controlledApi, {
      pullOnly: true,
      preferenceOverride: envOverride,
      loadPreference: () => loadKeyDeliveryDaemonPreference(ACCOUNT_ID, SOURCE_ID, true),
    }));
    expect(controlledApi.publishBodies).toHaveLength(1);
    expect((await loadKeyDeliveryDaemonPreference(ACCOUNT_ID, SOURCE_ID, true)).keyReleaseOptIn).toBeTrue();

    const disabled = await fixture();
    const disabledApi = new FakeApi(disabled);
    await run(flight(disabled, disabledApi, {
      preferenceOverride: keyDeliveryPreferenceOverrideFromEnv({
        RBOX_DAEMON_KEY_DELIVERY: "0",
      } as NodeJS.ProcessEnv),
      loadPreference: () => loadKeyDeliveryDaemonPreference(ACCOUNT_ID, SOURCE_ID, false),
    }));
    expect(disabledApi.fetchBodies[0]!.keyReleaseOptIn).toBeFalse();
    expect((await loadKeyDeliveryDaemonPreference(ACCOUNT_ID, SOURCE_ID, false)).fulfillmentEnabled).toBeFalse();
  });

  test("refuses server-returned work after transmitting an opt-out before loading keys or wrapping", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    api.fetch = async (body) => {
      api.fetchBodies.push(body);
      return { request: state.request };
    };
    let loaded = 0;
    let wraps = 0;
    const worker = new KeyDeliveryFulfillmentFlight({
      accountId: ACCOUNT_ID,
      deviceId: SOURCE_ID,
      workspaceId: "ws_test",
      pullOnly: true,
      api,
      log: () => {},
      retryBudget: 0,
      hooks: {
        now: () => NOW,
        loadPreference: async () => preference(true, false),
        loadDevice: async () => {
          loaded++;
          return { secrets: state.source };
        },
        wrapDevice: async (...args) => {
          wraps++;
          return rsaDeviceWrap(...args);
        },
      },
    });
    await run(worker);
    expect(loaded).toBe(0);
    expect(wraps).toBe(0);
  });

  test("WS fulfillment dispatch bypasses the sync readiness gate and sync mutex", () => {
    const enqueued: Array<string | undefined> = [];
    const port: KeyDeliveryFlightPort = {
      enqueue: (requestId) => { enqueued.push(requestId); },
      stop: async () => {},
    };
    const cfg: WorkspaceConfig = {
      remoteWorkspaceId: "ws_test",
      projectId: "root",
      deviceId: SOURCE_ID,
      rootPath: home,
      remoteUrl: "https://api.test",
      token: "token",
      accountId: ACCOUNT_ID,
    };
    let mutexCalls = 0;
    const daemon = new RboxDaemon(home, cfg, {} as SyncDeps, {
      keyDeliveryFlight: port,
      acquireSyncMutex: async () => {
        mutexCalls++;
        throw new Error("must not enter sync mutex");
      },
    });
    (daemon as unknown as { handleWsMessageData(data: string): void }).handleWsMessageData(
      JSON.stringify({ type: "key-delivery", requestId: REQUEST_ID }),
    );
    expect(enqueued).toEqual([REQUEST_ID]);
    expect(mutexCalls).toBe(0);
  });

  test("a production fulfillment flight completes while daemon startup is blocked acquiring the sync mutex", async () => {
    const state = await fixture();
    const api = new FakeApi(state);
    const worker = flight(state, api);
    let signalSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => { signalSubmitted = resolve; });
    const originalSubmit = api.submit.bind(api);
    api.submit = async (body) => {
      const result = await originalSubmit(body);
      signalSubmitted();
      return result;
    };

    let signalMutexEntered!: () => void;
    const mutexEntered = new Promise<void>((resolve) => { signalMutexEntered = resolve; });
    let releaseMutex!: (result: { status: "contended"; holderKey: string; blockerKind: "live" }) => void;
    const heldMutex = new Promise<{ status: "contended"; holderKey: string; blockerKind: "live" }>((resolve) => {
      releaseMutex = resolve;
    });
    const cfg: WorkspaceConfig = {
      remoteWorkspaceId: "ws_test",
      projectId: "root",
      deviceId: SOURCE_ID,
      rootPath: home,
      remoteUrl: "https://api.test",
      token: "token",
      accountId: ACCOUNT_ID,
    };
    const daemon = new RboxDaemon(home, cfg, {} as SyncDeps, {
      keyDeliveryFlight: worker,
      log: () => {},
      acquireSyncMutex: async () => {
        signalMutexEntered();
        return heldMutex;
      },
    });

    const starting = daemon.start();
    await mutexEntered;
    await submitted;
    expect(api.submitBodies).toHaveLength(1);
    const stopping = daemon.stop();
    releaseMutex({ status: "contended", holderKey: "held-by-sync", blockerKind: "live" });
    await Promise.all([starting, stopping]);
  });
});
