import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountLink, accountStatus, accountUnlink, fetchAccountSummary, formatAccountSummary } from "./account-cmd.js";
import { accountProfilePath, flushAccountProfileWrites, readAccountProfile } from "./account-profile.js";

// Drive the CLI account verbs against a stubbed control plane. loadCredentials()
// honors RBOX_TOKEN/RBOX_API env overrides, so no file or module mock is needed —
// we exercise the real status-code → behavior control flow.

// `style` (imported by account-cmd) may emit ANSI when the test env forces color, so
// strip escapes before substring/pattern assertions on rendered output.
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, "");

const origFetch = globalThis.fetch;
const origAbortSignalTimeout = AbortSignal.timeout;
const origLog = console.log;
const origStdout = process.stdout.write.bind(process.stdout);
let calls: { url: string; init?: RequestInit }[] = [];
let logs: string[] = [];
let home: string;
let savedEnv: Record<string, string | undefined>;

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origStdout;
  }
  return out.join("");
}

function stub(responder: (url: string) => { status: number; body?: unknown }): void {
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as Response;
  }) as typeof fetch;
}

beforeEach(async () => {
  savedEnv = Object.fromEntries([
    "RBOX_HOME", "RBOX_TOKEN", "RBOX_API", "RBOX_DEVICE_ID",
  ].map((key) => [key, process.env[key]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-account-cmd-"));
  process.env.RBOX_HOME = home;
  calls = [];
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
  process.env.RBOX_TOKEN = "durable-token";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_test";
});
afterEach(async () => {
  await flushAccountProfileWrites();
  globalThis.fetch = origFetch;
  AbortSignal.timeout = origAbortSignalTimeout;
  console.log = origLog;
  process.stdout.write = origStdout;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
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
  test("degraded account summary is explicit and remains renderable", () => {
    const rendered = formatAccountSummary({ state: "credential-degraded", credential: { state: "corrupt", path: "/test/credentials.json", detail: "bad schema" } });
    expect(plain(rendered.join("\n"))).toContain("credential-degraded");
    expect(plain(rendered.join("\n"))).toContain("corrupt");
  });

  test("status prints the account id, plan and linked state", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_xyz", linked: true, plan: "pro", email: "owner@example.com", signInMethod: "github+password" } }));
    await accountStatus();
    const out = logs.join("\n");
    expect(out).toContain("acct_xyz");
    expect(out).toMatch(/plan:\s*pro/i);
    expect(out).toMatch(/linked:\s*yes/i);
    expect(out).toMatch(/signed in as:\s*owner@example\.com \(github\+password\)/i);
    await flushAccountProfileWrites();
    expect(await readAccountProfile("acct_xyz")).toMatchObject({ email: "owner@example.com", signInMethod: "github+password", plan: "pro" });
  });


  test.each([
    ["null", null],
    ["absent", undefined],
  ])("--json omits signInMethod for %s", async (_name, signInMethod) => {
    stub((url) => url.endsWith("/v1/account/status")
      ? { status: 200, body: { accountId: "acct_json", linked: true, ...(signInMethod !== undefined ? { signInMethod } : {}) } }
      : { status: 200, body: { plan: "solo", graceUntil: null, readOnly: false } });
    const out = await captureStdout(() => accountStatus({ json: true }));
    expect(JSON.parse(out)).not.toHaveProperty("signInMethod");
  });

  test("--json includes a known signInMethod", async () => {
    stub((url) => url.endsWith("/v1/account/status")
      ? { status: 200, body: { accountId: "acct_json", linked: true, signInMethod: "google" } }
      : { status: 200, body: { plan: "solo" } });
    const out = await captureStdout(() => accountStatus({ json: true }));
    expect(JSON.parse(out)).toMatchObject({ signInMethod: "google" });
  });

  test("--json includes a known email", async () => {
    stub((url) => url.endsWith("/v1/account/status")
      ? { status: 200, body: { accountId: "acct_json", linked: true, email: "owner@example.com", signInMethod: "google" } }
      : { status: 200, body: { plan: "solo" } });
    const out = await captureStdout(() => accountStatus({ json: true }));
    expect(JSON.parse(out)).toMatchObject({ email: "owner@example.com", signInMethod: "google" });
  });

  test("unlink maps 409 → billing error and 404 → not-linked error", async () => {
    stub(() => ({ status: 409 }));
    await expect(accountUnlink()).rejects.toThrow(/billing/i);
    stub(() => ({ status: 404 }));
    await expect(accountUnlink()).rejects.toThrow(/no linked web login/i);
  });

});

// The ACCOUNT section of `rbox status` (design 21). fetchAccountSummary is the
// local-first, best-effort contract: it must resolve to a rendered state for every
// input (online, offline, timeout, signed-out) and NEVER reject or hang — a throwing
// account fetch would take the whole (otherwise-local) `rbox status` down with it.
describe("rbox status — account section", () => {
  test("ok: formats account id, plan and linked=yes", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_xyz", linked: true, plan: "solo", email: "owner@example.com", signInMethod: "google" } }));
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "ok", status: { accountId: "acct_xyz", plan: "solo", linked: true, email: "owner@example.com", signInMethod: "google" } });
    const out = plain(formatAccountSummary(summary).join("\n"));
    expect(out).toContain("acct_xyz");
    expect(out).toMatch(/plan:\s*solo/i);
    expect(out).toMatch(/linked:\s*yes/i);
    expect(out).toMatch(/signed in as:\s*owner@example\.com \(google\)/i);
    await flushAccountProfileWrites();
    expect(await readAccountProfile("acct_xyz")).toMatchObject({ email: "owner@example.com", signInMethod: "google", plan: "solo" });
  });

  test("ok: an API without the plan field preserves absence while legacy detail remains compatible", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_old", linked: false } }));
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "ok", status: { accountId: "acct_old", linked: false } });
    await flushAccountProfileWrites();
    expect(await readAccountProfile("acct_old")).toMatchObject({ email: null, signInMethod: null, plan: null });
    expect(plain(formatAccountSummary(summary).join("\n"))).toMatch(/plan:\s*no active plan/i);
    expect(plain(formatAccountSummary(summary).join("\n"))).toMatch(/linked:\s*no/i);
    expect(plain(formatAccountSummary(summary).join("\n"))).not.toMatch(/sign-in:/i);
  });

  test("a null sign-in method is omitted from the summary shape and renderer", async () => {
    stub(() => ({ status: 200, body: { accountId: "acct_null", linked: true, plan: "none", signInMethod: null } }));
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "ok", status: { accountId: "acct_null", linked: true, plan: "none" } });
    expect(plain(formatAccountSummary(summary).join("\n"))).not.toMatch(/sign-in:/i);
  });

  test("graceful degradation: a thrown fetch resolves to `unavailable`, never rejects", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ENETUNREACH");
    }) as typeof fetch;
    const summary = await fetchAccountSummary();
    expect(summary).toEqual({ state: "unavailable" });
    expect(plain(formatAccountSummary(summary).join("\n")).toLowerCase()).toContain("unavailable");
  });

  test("graceful degradation: a non-2xx (e.g. 500) is `unavailable`, not a throw", async () => {
    stub(() => ({ status: 500 }));
    expect(await fetchAccountSummary()).toEqual({ state: "unavailable" });
    await flushAccountProfileWrites();
    expect(await fs.exists(accountProfilePath())).toBe(false);
  });

  test("timeout: a hung request aborts and resolves to `unavailable` within the budget", async () => {
    // A fetch that never resolves on its own — only the AbortSignal ends it. If the
    // timeout weren't wired up this test would hang, so it also guards against a hang.
    globalThis.fetch = ((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    let timeoutBudget: number | undefined;
    AbortSignal.timeout = ((ms: number) => {
      timeoutBudget = ms;
      const controller = new AbortController();
      queueMicrotask(() => controller.abort());
      return controller.signal;
    }) as typeof AbortSignal.timeout;
    const summary = await fetchAccountSummary(20);
    expect(summary).toEqual({ state: "unavailable" });
    expect(timeoutBudget).toBe(20);
  });

});
