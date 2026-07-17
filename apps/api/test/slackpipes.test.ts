import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PING_TIMEOUT_MS, pingSlackpipes, pingNewAccount, formatNewAccount } from "../src/slackpipes.js";
import { stripeWebhook } from "../src/stripe.js";
import type { Env } from "../src/env.js";

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

// ── a global-fetch recorder/faker (the ONLY thing the ping path uses fetch for) ──
interface Call {
  url: string;
  body: unknown;
}
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function recordFetch(calls: Call[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
}
function failFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
}

const BUSINESS = "https://hook.test/business";
const ALERTS = "https://hook.test/alerts";
const pingEnv = (extra: Partial<Env> = {}): Env =>
  Object.assign({}, env, { SLACKPIPES_WEBHOOK_URL: BUSINESS, SLACKPIPES_ALERTS_WEBHOOK_URL: ALERTS }, extra) as Env;
const testCtx: Pick<ExecutionContext, "waitUntil"> = { waitUntil: (promise) => void promise };

/** Build a Stripe-signed webhook Request the handler will accept (HMAC over `t.body`). */
function signedWebhook(event: unknown): Request {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", "whsec_test_secret").update(`${t}.${body}`).digest("hex");
  return new Request("https://api.rbox.to/v1/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${mac}`, "content-type": "application/json" },
    body,
  });
}

describe("pingSlackpipes — never throws, self-gates on config", () => {
  test("no-op (no fetch) when the channel secret is absent", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const attempted = await pingSlackpipes({} as Env, "signup", "hi");
    expect(attempted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("posts {text} to the channel's webhook when configured", async () => {
    const calls: Call[] = [];
    const signalTimeouts: number[] = [];
    await pingSlackpipes(pingEnv(), "payment_failed", "boom", {
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("ok", { status: 200 });
      },
      timeoutSignal: (ms) => {
        signalTimeouts.push(ms);
        return new AbortController().signal;
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ALERTS);
    expect(calls[0]!.body).toEqual({ text: "boom" });
    expect(signalTimeouts).toEqual([PING_TIMEOUT_MS]);
  });

  test("fleet alerts route to the alerts channel", async () => {
    const calls: Call[] = [];
    await pingSlackpipes(pingEnv(), "fleet_alert", "fleet warning", {
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("ok", { status: 200 });
      },
      timeoutSignal: () => new AbortController().signal,
    });
    expect(calls).toEqual([{ url: ALERTS, body: { text: "fleet warning" } }]);
  });

  test("derives alerts from the business URL's final path segment when the override is unset", async () => {
    const calls: Call[] = [];
    const business = "https://hook.test/team/rbox?token=opaque#fragment";
    await pingSlackpipes(pingEnv({ SLACKPIPES_WEBHOOK_URL: business, SLACKPIPES_ALERTS_WEBHOOK_URL: undefined }), "payment_failed", "boom", {
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("ok", { status: 200 });
      },
      timeoutSignal: () => new AbortController().signal,
    });
    expect(calls).toEqual([{ url: "https://hook.test/team/rbox-alerts?token=opaque#fragment", body: { text: "boom" } }]);
  });

  test("the explicit alerts secret takes precedence over URL derivation", async () => {
    const calls: Call[] = [];
    const override = "https://alerts.test/custom-channel";
    await pingSlackpipes(pingEnv({ SLACKPIPES_WEBHOOK_URL: "https://hook.test/team/rbox", SLACKPIPES_ALERTS_WEBHOOK_URL: override }), "payment_failed", "boom", {
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("ok", { status: 200 });
      },
      timeoutSignal: () => new AbortController().signal,
    });
    expect(calls).toEqual([{ url: override, body: { text: "boom" } }]);
  });

  test("a timeout retries once after 1s with a fresh 5s signal, then succeeds", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const signalTimeouts: number[] = [];
    const result = await pingSlackpipes(pingEnv(), "signup", "hi", {
      fetch: async () => {
        attempts++;
        if (attempts === 1) throw new DOMException("timed out", "TimeoutError");
        return new Response("ok", { status: 200 });
      },
      delay: async (ms) => void delays.push(ms),
      timeoutSignal: (ms) => {
        signalTimeouts.push(ms);
        return new AbortController().signal;
      },
    });
    expect(result).toBe(true);
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(signalTimeouts).toEqual([5_000, 5_000]);
  });

  test("5xx retries exactly once; terminal failure logs slackpipes_ping_failed once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    const delays: number[] = [];
    await expect(pingSlackpipes(pingEnv(), "payment_failed", "hi", {
      fetch: async () => {
        attempts++;
        return new Response("no", { status: 503 });
      },
      delay: async (ms) => void delays.push(ms),
      timeoutSignal: () => new AbortController().signal,
    })).resolves.toBe(true);
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "slackpipes_ping_failed" });
  });

  test("4xx and non-timeout network errors are terminal without retry and never throw", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let clientAttempts = 0;
    await expect(pingSlackpipes(pingEnv(), "payment_failed", "bad", {
      fetch: async () => {
        clientAttempts++;
        return new Response("bad", { status: 400 });
      },
      delay: async () => {
        throw new Error("must not delay");
      },
      timeoutSignal: () => new AbortController().signal,
    })).resolves.toBe(true);
    let networkAttempts = 0;
    await expect(pingSlackpipes(pingEnv(), "payment_failed", "down", {
      fetch: async () => {
        networkAttempts++;
        throw new TypeError("network down");
      },
      timeoutSignal: () => new AbortController().signal,
    })).resolves.toBe(true);
    expect(clientAttempts).toBe(1);
    expect(networkAttempts).toBe(1);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("a retry-delay failure is swallowed and logged once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(pingSlackpipes(pingEnv(), "payment_failed", "hi", {
      fetch: async () => new Response("no", { status: 500 }),
      delay: async () => {
        throw new Error("timer unavailable");
      },
      timeoutSignal: () => new AbortController().signal,
    })).resolves.toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a terminal business failure fires one best-effort closed-enum alert operation", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: Call[] = [];
    const delays: number[] = [];
    await expect(pingSlackpipes(pingEnv(), "signup", "original signup text", {
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return calls.length < 3 ? new Response("no", { status: 503 }) : new Response("ok", { status: 200 });
      },
      delay: async (ms) => void delays.push(ms),
      timeoutSignal: () => new AbortController().signal,
    })).resolves.toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.slice(0, 2).map((call) => call.url)).toEqual([BUSINESS, BUSINESS]);
    expect(calls[2]).toEqual({ url: ALERTS, body: { text: "slackpipes ping failed: signup" } });
    expect(delays).toEqual([1_000]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("a failed synthetic alert stops after its own retry and never recursively alerts", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: Call[] = [];
    const delays: number[] = [];
    await expect(pingSlackpipes(pingEnv(), "churn", "churn text", {
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response("no", { status: 503 });
      },
      delay: async (ms) => void delays.push(ms),
      timeoutSignal: () => new AbortController().signal,
    })).resolves.toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => call.url)).toEqual([BUSINESS, BUSINESS, ALERTS, ALERTS]);
    expect(calls.slice(2).map((call) => call.body)).toEqual([
      { text: "slackpipes ping failed: churn" },
      { text: "slackpipes ping failed: churn" },
    ]);
    expect(delays).toEqual([1_000, 1_000]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("alerts-channel failures only log and never create a synthetic alert", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await pingSlackpipes(pingEnv(), "payment_failed", "payment text", {
      fetch: async () => {
        attempts++;
        return new Response("no", { status: 503 });
      },
      delay: async () => {},
      timeoutSignal: () => new AbortController().signal,
    });
    expect(attempts).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
  });

  test("failure logs never contain configured URLs or raw error messages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await pingSlackpipes(pingEnv(), "subscription", "subscription text", {
      fetch: async (input) => {
        throw new Error(`could not reach ${String(input)}; configured ${BUSINESS} and ${ALERTS}`);
      },
      timeoutSignal: () => new AbortController().signal,
    });
    const serializedLogs = log.mock.calls.flat().map(String).join("\n");
    expect(log).toHaveBeenCalledTimes(2);
    expect(serializedLogs).not.toContain(BUSINESS);
    expect(serializedLogs).not.toContain(ALERTS);
    expect(serializedLogs).not.toContain("could not reach");
    expect(serializedLogs).not.toContain("configured");
  });

  test("a malformed derived alerts URL is swallowed and privacy-safe", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let attempts = 0;
    await expect(pingSlackpipes(
      pingEnv({ SLACKPIPES_WEBHOOK_URL: "not-a-webhook-url", SLACKPIPES_ALERTS_WEBHOOK_URL: undefined }),
      "payment_failed",
      "payment text",
      { fetch: async () => { attempts++; return new Response("ok"); } },
    )).resolves.toBe(true);
    expect(attempts).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().map(String).join("\n")).not.toContain("not-a-webhook-url");
  });
});

describe("formatNewAccount — env tag + rich web-signup line, graceful per-segment degradation", () => {
  test("bootstrap carries only the (origin, env) tag — no rich suffix", () => {
    expect(formatNewAccount({ accountId: "acct_abc", origin: "bootstrap", env: "dev" })).toBe(
      ":seedling: New rbox account onboarded — `acct_abc` (bootstrap, dev)",
    );
  });

  test("web signup renders email + sign-in method + plan", () => {
    expect(
      formatNewAccount({ accountId: "acct_xyz", origin: "web", env: "prod", email: "jane@doe.com", signInMethod: "github", plan: "none" }),
    ).toBe(":seedling: New rbox account onboarded — `acct_xyz` (web, prod) — jane@doe.com via github · plan none");
  });

  test("missing email drops only the email — method + plan survive", () => {
    expect(formatNewAccount({ accountId: "acct_1", origin: "web", env: "prod", signInMethod: "google", plan: "none" })).toBe(
      ":seedling: New rbox account onboarded — `acct_1` (web, prod) — via google · plan none",
    );
  });

  test("missing sign-in method drops only 'via …'", () => {
    expect(formatNewAccount({ accountId: "acct_2", origin: "web", env: "dev", email: "a@b.com", plan: "solo" })).toBe(
      ":seedling: New rbox account onboarded — `acct_2` (web, dev) — a@b.com · plan solo",
    );
  });

  test("all rich fields absent ⇒ bare tag line (never a dangling separator)", () => {
    expect(formatNewAccount({ accountId: "acct_3", origin: "web", env: "prod" })).toBe(
      ":seedling: New rbox account onboarded — `acct_3` (web, prod)",
    );
  });
});

describe("pingNewAccount — reads the deploy-env tag off env.RBOX_ENV", () => {
  test("RBOX_ENV=prod tags prod; the rich web fields ride through to the business channel", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    pingNewAccount(testCtx, pingEnv({ RBOX_ENV: "prod" }), {
      accountId: "acct_prod",
      origin: "web",
      email: "jane@doe.com",
      signInMethod: "github",
      plan: "none",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BUSINESS);
    expect((calls[0]!.body as { text: string }).text).toBe(
      ":seedling: New rbox account onboarded — `acct_prod` (web, prod) — jane@doe.com via github · plan none",
    );
  });

  test("dev deployments are suppressed entirely — no signup ping for RBOX_ENV=dev or absent", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    pingNewAccount(testCtx, pingEnv({ RBOX_ENV: "dev" }), { accountId: "acct_dev", origin: "bootstrap" });
    pingNewAccount(testCtx, pingEnv({ RBOX_ENV: undefined }), { accountId: "acct_dev2", origin: "bootstrap" });
    expect(calls).toHaveLength(0);
  });

  test("a throwing waitUntil never escapes or adds logs beyond the failed ping operations", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let pending: Promise<unknown> | undefined;
    const throwingCtx: Pick<ExecutionContext, "waitUntil"> = {
      waitUntil: (promise) => {
        pending = promise;
        throw new Error("expired context");
      },
    };
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    expect(() => pingNewAccount(throwingCtx, pingEnv({ RBOX_ENV: "prod" }), { accountId: "acct_fail", origin: "web" })).not.toThrow();
    await pending;
    // One business-operation failure plus one terminal synthetic-alert failure;
    // the throwing registration itself contributes no third log.
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "slackpipes_ping_failed" });

    log.mockClear();
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    expect(() => pingNewAccount(throwingCtx, pingEnv(), { accountId: "acct_ok", origin: "web" })).not.toThrow();
    await pending;
    expect(log).not.toHaveBeenCalled();
  });
});

describe("Stripe webhook business pings — fire on the right events, never bubble a failure", () => {
  test("subscription.created (paying) on an existing account → business channel, with the plan", async () => {
    const acct = `acct_sub_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at) VALUES (?, 'x', 'none', ?)").bind(acct, Date.now()).run();
    const calls: Call[] = [];
    recordFetch(calls);
    const res = await stripeWebhook(
      signedWebhook({
        id: `evt_sub_created_${crypto.randomUUID()}`,
        type: "customer.subscription.created",
        data: { object: { id: "sub_1", customer: "cus_1", status: "active", metadata: { account_id: acct }, items: { data: [{ price: { lookup_key: "rbox_solo_monthly" } }] } } },
      }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(res.status).toBe(200);
    const businessPings = calls.filter((c) => c.url === BUSINESS);
    expect(businessPings).toHaveLength(1);
    expect((businessPings[0]!.body as { text: string }).text).toContain("solo");
  });

  test("subscription.created whose UPDATE changes NO row → no business ping (no false alert)", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const res = await stripeWebhook(
      signedWebhook({
        id: `evt_sub_noop_${crypto.randomUUID()}`,
        type: "customer.subscription.created",
        data: { object: { id: "sub_x", customer: "cus_x", status: "active", metadata: { account_id: "acct_does_not_exist" }, items: { data: [{ price: { lookup_key: "rbox_solo_monthly" } }] } } },
      }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(0);
  });

  test("subscription.deleted that locks a real account → churn ping; a no-op delete does not", async () => {
    const acct = `acct_churn_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db
      .prepare("INSERT INTO accounts (id, name, plan, created_at, stripe_customer_id, stripe_subscription_id) VALUES (?, 'c', 'solo', ?, 'cus_churn', 'sub_churn')")
      .bind(acct, Date.now())
      .run();
    const calls: Call[] = [];
    recordFetch(calls);
    // real lock (matches the row) → ping
    await stripeWebhook(
      signedWebhook({ id: `evt_del_${crypto.randomUUID()}`, type: "customer.subscription.deleted", data: { object: { id: "sub_churn", customer: "cus_churn", metadata: { account_id: acct } } } }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(1);
    expect((calls.find((c) => c.url === BUSINESS)!.body as { text: string }).text).toContain("locked (grace started");
    // stale/duplicate delete (matches nothing now — sub already cleared) → no second ping
    calls.length = 0;
    await stripeWebhook(
      signedWebhook({ id: `evt_del2_${crypto.randomUUID()}`, type: "customer.subscription.deleted", data: { object: { id: "sub_churn", customer: "cus_churn", metadata: { account_id: acct } } } }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(0);
  });

  test("invoice.payment_failed → alerts channel (no state change)", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    const res = await stripeWebhook(
      signedWebhook({
        id: `evt_pay_fail_${crypto.randomUUID()}`,
        type: "invoice.payment_failed",
        data: { object: { customer: "cus_none", amount_due: 1234 } },
      }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url === ALERTS)).toHaveLength(1);
  });

  test("a Slackpipes outage does NOT 500 the webhook — handler still returns 200", async () => {
    failFetch(); // every ping attempt throws inside fetch
    const res = await stripeWebhook(
      signedWebhook({
        id: `evt_outage_${crypto.randomUUID()}`,
        type: "invoice.payment_failed",
        data: { object: { customer: "cus_none", amount_due: 500 } },
      }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { received: boolean }).toMatchObject({ received: true });
  });

  test("subscription.created with a NON-paying status does not ping business", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    await stripeWebhook(
      signedWebhook({
        id: `evt_sub_pastdue_${crypto.randomUUID()}`,
        type: "customer.subscription.created",
        data: { object: { id: "sub_2", customer: "cus_2", status: "past_due", metadata: { account_id: "acct_y" }, items: { data: [{ price: { lookup_key: "rbox_solo_monthly" } }] } } },
      }),
      pingEnv(),
      Date.now(),
      testCtx,
    );
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(0);
  });

  test("webhook response resolves while its registered Slack ping is still pending", async () => {
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => (resolveFetch = resolve))) as typeof fetch;
    const pending: Promise<unknown>[] = [];
    const ctx: Pick<ExecutionContext, "waitUntil"> = { waitUntil: (promise) => void pending.push(promise) };
    const response = await stripeWebhook(
      signedWebhook({
        id: `evt_nonblocking_${crypto.randomUUID()}`,
        type: "invoice.payment_failed",
        data: { object: { customer: "cus_none", amount_due: 500 } },
      }),
      pingEnv(),
      Date.now(),
      ctx,
    );
    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    let settled = false;
    void pending[0]!.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveFetch(new Response("ok", { status: 200 }));
    await Promise.all(pending);
    expect(settled).toBe(true);
  });
});
