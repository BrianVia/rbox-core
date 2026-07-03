import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { createHmac } from "node:crypto";
import { pingSlackpipes, pingNewAccount, formatNewAccount } from "../src/slackpipes.js";
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
    const attempted = await pingSlackpipes({} as Env, "business", "hi");
    expect(attempted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("posts {text} to the channel's webhook when configured", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    await pingSlackpipes(pingEnv(), "alerts", "boom");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ALERTS);
    expect(calls[0]!.body).toEqual({ text: "boom" });
  });

  test("a failing fetch is swallowed (resolves, never throws)", async () => {
    failFetch();
    await expect(pingSlackpipes(pingEnv(), "business", "hi")).resolves.toBe(true);
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
      formatNewAccount({ accountId: "acct_xyz", origin: "web", env: "prod", email: "jane@doe.com", signInMethod: "github", plan: "free" }),
    ).toBe(":seedling: New rbox account onboarded — `acct_xyz` (web, prod) — jane@doe.com via github · plan free");
  });

  test("missing email drops only the email — method + plan survive", () => {
    expect(formatNewAccount({ accountId: "acct_1", origin: "web", env: "prod", signInMethod: "google", plan: "free" })).toBe(
      ":seedling: New rbox account onboarded — `acct_1` (web, prod) — via google · plan free",
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
    await pingNewAccount(pingEnv({ RBOX_ENV: "prod" }), {
      accountId: "acct_prod",
      origin: "web",
      email: "jane@doe.com",
      signInMethod: "github",
      plan: "free",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BUSINESS);
    expect((calls[0]!.body as { text: string }).text).toBe(
      ":seedling: New rbox account onboarded — `acct_prod` (web, prod) — jane@doe.com via github · plan free",
    );
  });

  test("absent RBOX_ENV degrades to the dev tag (dev is never mislabeled prod)", async () => {
    const calls: Call[] = [];
    recordFetch(calls);
    await pingNewAccount(pingEnv({ RBOX_ENV: undefined }), { accountId: "acct_dev", origin: "bootstrap" });
    expect((calls[0]!.body as { text: string }).text).toBe(":seedling: New rbox account onboarded — `acct_dev` (bootstrap, dev)");
  });
});

describe("Stripe webhook business pings — fire on the right events, never bubble a failure", () => {
  test("subscription.created (paying) on an existing account → business channel, with the plan", async () => {
    const acct = `acct_sub_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at) VALUES (?, 'x', 'free', ?)").bind(acct, Date.now()).run();
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
    );
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(0);
  });

  test("subscription.deleted that downgrades a real account → churn ping; a no-op delete does not", async () => {
    const acct = `acct_churn_${crypto.randomUUID().replace(/-/g, "")}`;
    await env.rbox_dev_db
      .prepare("INSERT INTO accounts (id, name, plan, created_at, stripe_customer_id, stripe_subscription_id) VALUES (?, 'c', 'solo', ?, 'cus_churn', 'sub_churn')")
      .bind(acct, Date.now())
      .run();
    const calls: Call[] = [];
    recordFetch(calls);
    // real downgrade (matches the row) → ping
    await stripeWebhook(
      signedWebhook({ id: `evt_del_${crypto.randomUUID()}`, type: "customer.subscription.deleted", data: { object: { id: "sub_churn", customer: "cus_churn", metadata: { account_id: acct } } } }),
      pingEnv(),
      Date.now(),
    );
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(1);
    // stale/duplicate delete (matches nothing now — sub already cleared) → no second ping
    calls.length = 0;
    await stripeWebhook(
      signedWebhook({ id: `evt_del2_${crypto.randomUUID()}`, type: "customer.subscription.deleted", data: { object: { id: "sub_churn", customer: "cus_churn", metadata: { account_id: acct } } } }),
      pingEnv(),
      Date.now(),
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
    );
    expect(calls.filter((c) => c.url === BUSINESS)).toHaveLength(0);
  });
});
