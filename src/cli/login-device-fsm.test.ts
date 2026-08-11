import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runDeviceCodeLogin,
  transitionDeviceLogin,
  type DeviceLoginFsmState,
} from "./auth-cmd.js";
import { _setSpawner } from "./browser-open.js";
import { enrollViaWebDelivery } from "./e2ee-client.js";
import {
  generateLoginAttemptKeys,
  loadLoginAttempt,
  recordLoginCredentialSaved,
  reserveLoginCredential,
  stageLoginAttempt,
  type LoginAttemptActive,
} from "./login-attempt-journal.js";
import { saveCredentials } from "./credentials.js";

const REMOTE = "https://api.test";
const ACCOUNT = "acct_1891891891891891";
const DEVICE = "dev_web_target";
const TOKEN = "recovered-device-token";

let root: string;
let originalFetch: typeof fetch;
let originalLog: typeof console.log;
const originalHome = process.env.HOME;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-login-fsm-"));
  process.env.RBOX_HOME = root;
  process.env.HOME = root;
  originalFetch = globalThis.fetch;
  originalLog = console.log;
  console.log = () => {};
  _setSpawner(() => ({ on: () => {}, unref: () => {} }));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  _setSpawner();
  delete process.env.RBOX_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(root, { recursive: true, force: true });
});

async function staged(code = "1".repeat(64)): Promise<LoginAttemptActive> {
  return stageLoginAttempt({
    deviceCode: code,
    userCode: "ABCD-EFGH",
    remoteUrl: REMOTE,
    label: "new-machine",
    pollIntervalSeconds: 1,
    createdAt: 1_000,
    expiresAt: 11_000,
    keys: generateLoginAttemptKeys(),
  });
}

function delivery(attempt: LoginAttemptActive, status: "pending" | "ready" | "delivered" | "expired") {
  if (status === "ready") {
    return {
      status,
      requestId: attempt.requestId,
      expiresAt: 10_000,
      mkWrapDevice: "{\"opaque\":true}",
      publishedRosterVersion: 7,
      accountEpoch: 0,
    };
  }
  return { status, requestId: attempt.requestId, expiresAt: 10_000 };
}

function claimed(attempt: LoginAttemptActive, status: "approved" | "claimed", keyStatus: "pending" | "ready") {
  return {
    status,
    token: TOKEN,
    deviceId: DEVICE,
    accountId: ACCOUNT,
    keyDelivery: delivery(attempt, keyStatus),
  };
}

const successfulEnrollment: typeof enrollViaWebDelivery = async (input, deps) => {
  await deps.onBoundary?.("keys-ready");
  await deps.persistCheckpoint?.();
  await deps.onBoundary?.("persisted");
  return { accountId: input.accountId, deviceId: input.deviceId };
};

describe("design-189 device login FSM", () => {
  test("transitions approved → pending → ready → admitted and preserves legacy/fallback branches", () => {
    const requestId = "a".repeat(64);
    let state: DeviceLoginFsmState = "awaiting-approval";
    state = transitionDeviceLogin(state, {
      kind: "poll",
      poll: {
        status: "approved",
        token: TOKEN,
        deviceId: DEVICE,
        accountId: ACCOUNT,
        keyDelivery: { status: "pending", requestId, expiresAt: 10_000 },
      },
    });
    expect(state).toBe("key-delivery-pending");
    state = transitionDeviceLogin(state, {
      kind: "poll",
      poll: {
        status: "claimed",
        token: TOKEN,
        deviceId: DEVICE,
        accountId: ACCOUNT,
        keyDelivery: {
          status: "ready",
          requestId,
          expiresAt: 10_000,
          mkWrapDevice: "{}",
          publishedRosterVersion: 1,
          accountEpoch: 0,
        },
      },
    });
    expect(state).toBe("keys-ready");
    expect(transitionDeviceLogin(state, { kind: "acknowledged" })).toBe("admitted");
    expect(transitionDeviceLogin("awaiting-approval", {
      kind: "poll",
      poll: { status: "approved", token: TOKEN, deviceId: DEVICE, accountId: ACCOUNT },
    })).toBe("legacy");
    expect(transitionDeviceLogin("key-delivery-pending", { kind: "deadline" })).toBe("fallback");
  });

  test("re-polls after a lost claim response and recovers the claimed bearer before enrollment", async () => {
    const attempt = await staged("2".repeat(64));
    let polls = 0;
    let acks = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        polls++;
        expect(JSON.parse(String(init?.body))).toEqual({ deviceCode: attempt.deviceCode });
        if (polls === 1) return new Response("lost response", { status: 503 });
        return new Response(JSON.stringify(claimed(attempt, "claimed", "ready")));
      }
      if (url.endsWith("/v1/auth/key-delivery/ack")) {
        acks++;
        expect(init?.headers).toEqual(expect.objectContaining({ authorization: `Bearer ${TOKEN}` }));
        expect(JSON.parse(String(init?.body))).toEqual({ requestId: attempt.requestId });
        return new Response(JSON.stringify({ ok: true, alreadyDelivered: false }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: successfulEnrollment,
    });
    expect({ polls, acks }).toEqual({ polls: 2, acks: 1 });
    expect((await loadLoginAttempt(attempt.requestId))?.phase).toBe("fulfilled");
  });

  test("delivery TTL enters the one-mount recovery fallback, never legacy genesis", async () => {
    let attempt = await staged("3".repeat(64));
    await saveCredentials({ token: TOKEN, deviceId: DEVICE, accountId: ACCOUNT, remoteUrl: REMOTE });
    attempt = await reserveLoginCredential(attempt, ACCOUNT, DEVICE);
    attempt = await recordLoginCredentialSaved(attempt, ACCOUNT, DEVICE);
    let prompts = 0;
    let recoveries = 0;
    await runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 11_000,
      sleep: async () => {},
      isInteractive: () => true,
      promptLoginFallback: async () => {
        prompts++;
        return { kind: "recovery", phrase: "checksum-valid phrase" };
      },
      enrollViaRecoveryWithPhraseInput: async (read) => {
        recoveries++;
        expect(await read()).toBe("checksum-valid phrase");
        return { accountId: ACCOUNT, deviceId: "rec_recovered", phrase: "checksum-valid phrase" };
      },
    });
    expect({ prompts, recoveries }).toEqual({ prompts: 1, recoveries: 1 });
    expect((await loadLoginAttempt(attempt.requestId))?.phase).toBe("abandoned");
  });

  test("legacy 200 terminal status fails immediately instead of polling to the deadline", async () => {
    const attempt = await staged("6".repeat(64));
    let polls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        polls++;
        return new Response(JSON.stringify({ status: "expired", keyDelivery: null }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    await expect(runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
    })).rejects.toThrow("authorization expired");
    expect(polls).toBe(1);
    expect((await loadLoginAttempt(attempt.requestId))?.phase).toBe("abandoned");
  });

  test("ACK honors JSON retryAfterSeconds and validates the exact success body", async () => {
    const attempt = await staged("7".repeat(64));
    let acks = 0;
    const waits: number[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        return new Response(JSON.stringify(claimed(attempt, "approved", "ready")));
      }
      if (url.endsWith("/v1/auth/key-delivery/ack")) {
        acks++;
        if (acks === 1) {
          return new Response(JSON.stringify({ error: "rate_limited", retryAfterSeconds: 0 }), {
            status: 429,
          });
        }
        return new Response(JSON.stringify({ ok: true, alreadyDelivered: false }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    await runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async (ms) => { waits.push(ms); },
      enrollViaWebDelivery: successfulEnrollment,
    });
    expect(acks).toBe(2);
    expect(waits).toContain(1_000);

    const malformedAttempt = await staged("8".repeat(64));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        return new Response(JSON.stringify(claimed(malformedAttempt, "approved", "ready")));
      }
      if (url.endsWith("/v1/auth/key-delivery/ack")) {
        return new Response(JSON.stringify({ ok: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    await expect(runDeviceCodeLogin(malformedAttempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: successfulEnrollment,
    })).rejects.toThrow("malformed key-delivery ACK response");
    expect((await loadLoginAttempt(malformedAttempt.requestId))?.phase).toBe("persisted");
  });
});

describe("design-189 CLI pickup crash injection", () => {
  test("crash after account reservation re-polls escrow before saving the bearer", async () => {
    const attempt = await staged("9".repeat(64));
    let polls = 0;
    let enrollments = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        polls++;
        return new Response(JSON.stringify(claimed(attempt, polls === 1 ? "approved" : "claimed", "ready")));
      }
      if (url.endsWith("/v1/auth/key-delivery/ack")) {
        return new Response(JSON.stringify({ ok: true, alreadyDelivered: false }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const enrollment: typeof enrollViaWebDelivery = async (input, deps) => {
      enrollments++;
      await deps.persistCheckpoint?.();
      return { accountId: input.accountId, deviceId: input.deviceId };
    };

    await expect(runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: enrollment,
      onCredentialReserved: () => {
        throw new Error("crash:credential-reserved");
      },
    })).rejects.toThrow("crash:credential-reserved");
    const reserved = await loadLoginAttempt(attempt.requestId) as LoginAttemptActive;
    expect(reserved.phase).toBe("credential-reserved");

    await runDeviceCodeLogin(reserved, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: enrollment,
    });
    expect({ polls, enrollments }).toEqual({ polls: 2, enrollments: 1 });
    expect((await loadLoginAttempt(attempt.requestId))?.phase).toBe("fulfilled");
  });

  test("crash after keys-ready before persist re-fetches and persists exactly once", async () => {
    const attempt = await staged("4".repeat(64));
    let persists = 0;
    let polls = 0;
    let crash = true;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        polls++;
        return new Response(JSON.stringify(claimed(attempt, polls === 1 ? "approved" : "claimed", "ready")));
      }
      if (url.endsWith("/v1/auth/key-delivery/ack")) {
        return new Response(JSON.stringify({ ok: true, alreadyDelivered: false }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const enrollment: typeof enrollViaWebDelivery = async (input, deps) => {
      await deps.onBoundary?.("keys-ready");
      if (crash) throw new Error("crash:keys-ready");
      persists++;
      await deps.persistCheckpoint?.();
      return { accountId: input.accountId, deviceId: input.deviceId };
    };

    await expect(runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: enrollment,
    })).rejects.toThrow("crash:keys-ready");
    const resumable = await loadLoginAttempt(attempt.requestId) as LoginAttemptActive;
    expect(resumable.phase).toBe("credential-saved");
    crash = false;
    await runDeviceCodeLogin(resumable, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: enrollment,
    });
    expect(persists).toBe(1);
    expect(polls).toBe(2);
    expect((await loadLoginAttempt(attempt.requestId))?.phase).toBe("fulfilled");
  });

  test("crash after persist before ACK resumes ACK without enrolling twice", async () => {
    const attempt = await staged("5".repeat(64));
    let enrollments = 0;
    let acks = 0;
    let polls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/poll")) {
        polls++;
        if (polls > 1) {
          return new Response(JSON.stringify({
            status: "claimed",
            keyDelivery: delivery(attempt, "delivered"),
          }));
        }
        return new Response(JSON.stringify(claimed(attempt, "approved", "ready")));
      }
      if (url.endsWith("/v1/auth/key-delivery/ack")) {
        acks++;
        return new Response(JSON.stringify({ ok: true, alreadyDelivered: true }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;
    const enrollment: typeof enrollViaWebDelivery = async (input, deps) => {
      enrollments++;
      await deps.persistCheckpoint?.();
      await deps.onBoundary?.("persisted");
      return { accountId: input.accountId, deviceId: input.deviceId };
    };

    await expect(runDeviceCodeLogin(attempt, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: enrollment,
      onWebDeliveryBoundary: (boundary) => {
        if (boundary === "persisted") throw new Error("crash:persisted");
      },
    })).rejects.toThrow("crash:persisted");
    const persisted = await loadLoginAttempt(attempt.requestId) as LoginAttemptActive;
    expect(persisted.phase).toBe("persisted");
    await runDeviceCodeLogin(persisted, { kit: false }, "wizard", {
      now: () => 2_000,
      sleep: async () => {},
      enrollViaWebDelivery: enrollment,
    });
    expect(enrollments).toBe(1);
    expect(acks).toBe(1);
    expect(polls).toBe(2);
    expect((await loadLoginAttempt(attempt.requestId))?.phase).toBe("fulfilled");
  });
});
