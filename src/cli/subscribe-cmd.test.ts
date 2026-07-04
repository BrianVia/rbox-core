import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { subscribe, billingPortal } from "./subscribe-cmd.js";

// Drive the CLI billing verbs against a stubbed control plane. loadCredentials()
// honors RBOX_TOKEN/RBOX_API, so no file/module mock is needed. The tests run
// non-TTY, so openInBrowser() short-circuits to printing the URL (no real spawn) —
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

describe("rbox subscribe", () => {
  test("opens a checkout bound to this account with the durable bearer", async () => {
    stub(() => ({ status: 200, body: { url: "https://checkout.stripe/cs_1" } }));
    await subscribe("pro");
    expect(calls[0]!.url).toBe("https://api.test/v1/billing/checkout?plan=pro");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer durable-token");
    expect(calls[0]!.init!.method).toBe("POST");
    expect(logs.join("\n")).toContain("https://checkout.stripe/cs_1");
  });

  test("a missing plan is a usage error and never calls the API", async () => {
    stub(() => ({ status: 200 }));
    await expect(subscribe(undefined)).rejects.toThrow(/usage/i);
    expect(calls.length).toBe(0);
  });

  test("an unknown plan is rejected client-side before any API call", async () => {
    stub(() => ({ status: 200 }));
    await expect(subscribe("enterprise")).rejects.toThrow(/unknown plan/i);
    expect(calls.length).toBe(0);
  });

  test("`subscribe team` prints the coming-soon message and never calls the API", async () => {
    stub(() => ({ status: 200 }));
    await subscribe("team"); // must not throw — team is "coming soon", not an error
    expect(calls.length).toBe(0);
    expect(logs.join("\n")).toContain("Team plans are coming soon — solo and pro are available today.");
  });

  test("already_subscribed (409) is NOT an error — it points at the portal and resolves", async () => {
    stub(() => ({ status: 409, body: { error: "already_subscribed", plan: "pro" } }));
    await subscribe("pro"); // must not throw
    const out = logs.join("\n").toLowerCase();
    expect(out).toContain("already subscribed");
    expect(out).toContain("rbox billing");
  });

  test("billing not configured (501) → a clear error", async () => {
    stub(() => ({ status: 501 }));
    await expect(subscribe("solo")).rejects.toThrow(/billing isn't enabled/i);
  });
});

describe("rbox billing", () => {
  test("opens the customer portal with the durable bearer", async () => {
    stub(() => ({ status: 200, body: { url: "https://billing.stripe/portal_1" } }));
    await billingPortal();
    expect(calls[0]!.url).toBe("https://api.test/v1/billing/portal");
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer durable-token");
    expect(logs.join("\n")).toContain("https://billing.stripe/portal_1");
  });

  test("no subscription yet (409) → an actionable error pointing at subscribe", async () => {
    stub(() => ({ status: 409 }));
    await expect(billingPortal()).rejects.toThrow(/subscribe/i);
  });
});
