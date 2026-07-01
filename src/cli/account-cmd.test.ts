import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { accountLink, accountStatus, accountUnlink, fetchAccountSummary, formatAccountSummary } from "./account-cmd.js";

// Drive the CLI account verbs against a stubbed control plane. loadCredentials()
// honors RBOX_TOKEN/RBOX_API env overrides, so no file or module mock is needed —
// we exercise the real status-code → behavior control flow.

// `style` (imported by account-cmd) may emit ANSI when the test env forces color, so
// strip escapes before substring/pattern assertions on rendered output.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");

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
  test("status prints the account id, plan and linked state", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_xyz", linked: true, plan: "pro" } }));
    await accountStatus();
    const out = logs.join("\n");
    expect(out).toContain("acct_xyz");
    expect(out).toMatch(/plan:\s*pro/i);
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

// The ACCOUNT section of `rbox status` (design 21). fetchAccountSummary is the
// local-first, best-effort contract: it must resolve to a rendered state for every
// input (online, offline, timeout, signed-out) and NEVER reject or hang — a throwing
// account fetch would take the whole (otherwise-local) `rbox status` down with it.
describe("rbox status — account section", () => {
  test("ok: formats account id, plan and linked=yes", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_xyz", linked: true, plan: "solo" } }));
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "ok", status: { accountId: "acct_xyz", plan: "solo", linked: true } });
    const out = plain(formatAccountSummary(summary).join("\n"));
    expect(out).toContain("acct_xyz");
    expect(out).toMatch(/plan:\s*solo/i);
    expect(out).toMatch(/linked:\s*yes/i);
  });

  test("ok: an API without the plan field degrades to `free`, not a failure", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_old", linked: false } }));
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "ok", status: { accountId: "acct_old", plan: "free", linked: false } });
    expect(plain(formatAccountSummary(summary).join("\n"))).toMatch(/plan:\s*free/i);
    expect(plain(formatAccountSummary(summary).join("\n"))).toMatch(/linked:\s*no/i);
  });

  test("graceful degradation: a thrown fetch resolves to `unavailable`, never rejects", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "unavailable" });
    expect(plain(formatAccountSummary(summary).join("\n")).toLowerCase()).toContain("unavailable");
  });

  test("graceful degradation: a non-2xx (e.g. 500) is `unavailable`, not a throw", async () => {
    stub(() => ({ status: 500 }));
    expect(await fetchAccountSummary()).toEqual({ state: "unavailable" });
  });

  test("timeout: a hung request aborts and resolves to `unavailable` within the budget", async () => {
    // A fetch that never resolves on its own — only the AbortSignal ends it. If the
    // timeout weren't wired up this test would hang, so it also guards against a hang.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const summary = await fetchAccountSummary(20);
    expect(summary).toEqual({ state: "unavailable" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("signed-out renders a `not signed in` hint (no account id / plan lines)", () => {
    // The signed-out branch is decided by loadCredentials() (file/env, not stubbable
    // under Bun's real os.homedir), so assert the rendering contract directly.
    const lines = formatAccountSummary({ state: "signed-out" });
    expect(lines.length).toBe(1);
    const out = plain(lines[0]!).toLowerCase();
    expect(out).toContain("not signed in");
    expect(out).toContain("rbox login");
  });
});
