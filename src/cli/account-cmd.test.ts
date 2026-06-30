import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { accountLink, accountStatus, accountUnlink } from "./account-cmd.js";

// Drive the CLI account verbs against a stubbed control plane. loadCredentials()
// honors RBOX_TOKEN/RBOX_API env overrides, so no file or module mock is needed —
// we exercise the real status-code → behavior control flow.

const origFetch = globalThis.fetch;
const origLog = console.log;
let calls: { url: string; init?: RequestInit }[] = [];
let logs: string[] = [];

function stub(responder: (url: string) => { status: number; body?: unknown }): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
  process.env.RBOX_TOKEN = "durable-token";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_test";
});
afterEach(() => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_API;
  delete process.env.RBOX_DEVICE_ID;
});

describe("rbox account link", () => {
  test("redeems with the durable bearer and surfaces the dashboard-confirm instruction", async () => {
    stub(() => ({ status: 200, body: { account: "acct_abc123" } }));
    await accountLink("rbox-link_xyz");
    expect(calls[0]!.url).toBe("https://api.test/v1/account/link/redeem");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer durable-token");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ code: "rbox-link_xyz" });
    const out = logs.join("\n");
    expect(out).toContain("acct_abc123");
    expect(out.toLowerCase()).toContain("dashboard");
  });

  test("a missing code is a usage error and never calls the API", async () => {
    stub(() => ({ status: 200 }));
    await expect(accountLink("")).rejects.toThrow(/usage/i);
    expect(calls.length).toBe(0);
  });

  test("403 → owner-device error; 401 → expired-code error", async () => {
    stub(() => ({ status: 403 }));
    await expect(accountLink("c")).rejects.toThrow(/owner device/i);
    stub(() => ({ status: 401 }));
    await expect(accountLink("c")).rejects.toThrow(/expired/i);
  });
});

describe("rbox account status / unlink", () => {
  test("status prints the account id and linked state", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_xyz", linked: true } }));
    await accountStatus();
    const out = logs.join("\n");
    expect(out).toContain("acct_xyz");
    expect(out).toMatch(/linked:\s*yes/i);
  });

  test("unlink maps 409 → billing error and 404 → not-linked error", async () => {
    stub(() => ({ status: 409 }));
    await expect(accountUnlink()).rejects.toThrow(/billing/i);
    stub(() => ({ status: 404 }));
    await expect(accountUnlink()).rejects.toThrow(/no linked web login/i);
  });

  test("unlink success prints the moved-to-fresh-account confirmation", async () => {
    stub(() => ({ status: 200, body: { ok: true, account: "acct_fresh" } }));
    await accountUnlink();
    expect(logs.join("\n").toLowerCase()).toContain("unlinked");
  });
});
