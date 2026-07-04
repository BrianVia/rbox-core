import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleDeviceCodePostApprovalEncryption,
  login,
  runGenesisEnrollment,
} from "./auth-cmd.js";
import { _setSpawner } from "./browser-open.js";
import { AccountAlreadyBootstrappedError } from "./remote.js";
import { acquireGenesisLock, hasDevice, loadRecoveryKey, saveRecoveryKey } from "./e2ee-keystore.js";
import type { AccountKeysDTO } from "./e2ee-remote.js";

const ACCOUNT_KEYS: AccountKeysDTO = { recoveryWrap: null, recoveryWrapId: null, rosters: [], keyStates: [], devices: [] };

class FakeGenesisApi {
  bootstrapCalls = 0;
  getCalls = 0;

  constructor(
    private readonly keys: Array<AccountKeysDTO | null>,
    private readonly bootstrapResult: "ok" | "already" | "network" = "ok"
  ) {}

  async getAccountKeys(): Promise<AccountKeysDTO | null> {
    this.getCalls++;
    return this.keys.length > 1 ? this.keys.shift()! : this.keys[0]!;
  }

  async bootstrapKeys(): Promise<void> {
    this.bootstrapCalls++;
    if (this.bootstrapResult === "already") throw new AccountAlreadyBootstrappedError();
    if (this.bootstrapResult === "network") throw new Error("network down");
  }
}

let home: string;
const origLog = console.log;
const origFetch = globalThis.fetch;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-auth-home-"));
  process.env.RBOX_HOME = home;
  console.log = () => {};
  _setSpawner(() => ({ on: () => {}, unref: () => {} }));
});

afterEach(async () => {
  console.log = origLog;
  globalThis.fetch = origFetch;
  _setSpawner();
  delete process.env.RBOX_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe("runGenesisEnrollment", () => {
  test("null account keys mints genesis, shows the phrase, and leaves local device material", async () => {
    const api = new FakeGenesisApi([null]);
    let shown = "";

    const result = await runGenesisEnrollment(api, { accountId: "acct_genesis", deviceId: "dev_genesis" }, { kit: false }, {
      now: () => 1_900_000_000_000,
      showRecoveryPhrase: async (phrase) => {
        shown = phrase;
      },
    });

    expect(result).toBe("enrolled");
    expect(api.bootstrapCalls).toBe(1);
    expect(shown.split(/\s+/).length).toBe(24);
    expect(await hasDevice("acct_genesis")).toBe(true);
  });

  test("existing account keys returns the pair/recover signal without minting", async () => {
    const api = new FakeGenesisApi([ACCOUNT_KEYS]);
    let shown = false;

    const result = await runGenesisEnrollment(api, { accountId: "acct_existing", deviceId: "dev_existing" }, { kit: false }, {
      showRecoveryPhrase: async () => {
        shown = true;
      },
    });

    expect(result).toBe("already-setup");
    expect(api.bootstrapCalls).toBe(0);
    expect(shown).toBe(false);
    expect(await hasDevice("acct_existing")).toBe(false);
  });

  test("409 already_bootstrapped removes pre-persisted device material and cached recovery key", async () => {
    const api = new FakeGenesisApi([null, ACCOUNT_KEYS], "already");
    await saveRecoveryKey("acct_race", new Uint8Array([1, 2, 3]));

    const result = await runGenesisEnrollment(api, { accountId: "acct_race", deviceId: "dev_race" }, { kit: false }, {
      now: () => 1_900_000_000_000,
      showRecoveryPhrase: async () => {
        throw new Error("phrase should not be shown after a 409");
      },
    });

    expect(result).toBe("already-setup");
    expect(api.getCalls).toBe(2);
    expect(await hasDevice("acct_race")).toBe(false);
    expect(await loadRecoveryKey("acct_race")).toBeUndefined();
  });

  test("non-409 bootstrap failures leave crash-safety material for retry", async () => {
    const api = new FakeGenesisApi([null], "network");
    await saveRecoveryKey("acct_retry", new Uint8Array([4, 5, 6]));

    await expect(
      runGenesisEnrollment(api, { accountId: "acct_retry", deviceId: "dev_retry" }, { kit: false }, {
        now: () => 1_900_000_000_000,
      })
    ).rejects.toThrow(/network/);

    expect(await hasDevice("acct_retry")).toBe(true);
    expect(await loadRecoveryKey("acct_retry")).toBeDefined();
  });
});

describe("genesis lock", () => {
  test("second acquire while held reports setup contention", () => {
    const release = acquireGenesisLock("acct_lock");
    try {
      expect(() => acquireGenesisLock("acct_lock")).toThrow("another rbox process is already setting up encryption for this account");
    } finally {
      release();
    }

    const releaseAgain = acquireGenesisLock("acct_lock");
    releaseAgain();
  });

  test("stale dead-pid lock is taken over", async () => {
    const accountId = "acct_stale_lock";
    const dir = path.join(home, ".rbox", "e2ee", accountId);
    const lock = path.join(dir, "genesis.lock");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(lock, "2147483647");

    const release = acquireGenesisLock(accountId);
    release();

    await expect(fs.access(lock)).rejects.toThrow();
  });
});

describe("device-code login rate-limit / device-cap tolerance (design 64 §3.3)", () => {
  test("device/start retries on 429 (honoring Retry-After) then proceeds to poll", async () => {
    let startCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) {
        startCalls++;
        if (startCalls === 1) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "0" } });
        return new Response(JSON.stringify({ deviceCode: "dc_retry", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
      }
      // Reaching poll (with a deliberately malformed approval) proves start recovered.
      if (url.endsWith("/v1/auth/device/poll")) return new Response(JSON.stringify({ status: "approved", token: "tok" }));
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test")).rejects.toThrow("malformed approval response from server");
    expect(startCalls).toBe(2); // 429 → retry → 200
  });

  test("poll treats a 429 as transient (backs off, keeps polling) rather than a status", async () => {
    let pollCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) return new Response(JSON.stringify({ deviceCode: "dc_poll", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
      if (url.endsWith("/v1/auth/device/poll")) {
        pollCalls++;
        if (pollCalls === 1) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "Retry-After": "0" } });
        return new Response(JSON.stringify({ status: "approved", token: "tok" })); // malformed → terminates after we prove the retry
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test")).rejects.toThrow("malformed approval response from server");
    expect(pollCalls).toBe(2); // the 429 poll didn't throw/timeout — it backed off and re-polled
  });

  test("poll device-cap 409 is terminal with an actionable message", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/device/start")) return new Response(JSON.stringify({ deviceCode: "dc_cap", userCode: "AAAA-BBBB", interval: 0, expiresIn: 60 }));
      if (url.endsWith("/v1/auth/device/poll")) return new Response(JSON.stringify({ error: "device_limit_reached", cap: 5, plan: "free" }), { status: 409 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await expect(login("https://api.test")).rejects.toThrow("device limit reached (5/5 on free) — run `rbox device revoke <id>` to free a slot, or upgrade");
  });
});

describe("device-code approval validation", () => {
  test("login rejects an approved response missing accountId or deviceId", async () => {
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
  });
});

describe("device-code post-approval encryption handling", () => {
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
    expect(err.join("")).toContain("`rbox recover`");
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
