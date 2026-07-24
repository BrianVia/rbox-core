import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountLink, accountStatus, accountUnlink, fetchAccountSummary } from "./account-cmd.js";
import { billingPortal, subscribe } from "./subscribe-cmd.js";
import { usageCmd } from "./usage-cmd.js";
import { runUpdateCheckIfDue } from "./update-check.js";

/**
 * The command layer used to call the global `fetch` with no AbortSignal. Against a
 * black-holed TCP connection (SYN accepted, nothing ever returned) such a fetch never
 * settles, so `rbox account` / `usage` / `subscribe` / `pair` / `upgrade` hung until
 * Ctrl-C. Every command-layer call now goes through src/cli/remote/resilient.ts's deadline
 * wrappers; these tests pin BOTH halves of that: a request that never answers rejects on
 * its deadline, and every converted call site actually hands fetch a live signal.
 */

const origFetch = globalThis.fetch;
const origLog = console.log;
const origHome = process.env.RBOX_HOME;
let observed: (AbortSignal | undefined | null)[] = [];
let home: string;

/** A server that accepts the connection and then says nothing, ever. The ONLY way this
 *  promise settles is the caller's own abort signal — i.e. the deadline under test. */
function blackHole(): void {
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      observed.push(signal);
      if (!signal) return; // no deadline wired → hangs forever, exactly the defect
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as unknown as typeof fetch;
}

/** Records the signal each call site passes, then answers immediately. */
function recording(body: (url: string) => unknown): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    observed.push(init?.signal);
    const value = body(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => value,
      text: async () => JSON.stringify(value),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(value)).buffer,
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  observed = [];
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fetch-deadline-"));
  process.env.RBOX_HOME = home;
  console.log = () => {};
  process.env.RBOX_TOKEN = "durable-token";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_test";
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  console.log = origLog;
  if (origHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = origHome;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_API;
  delete process.env.RBOX_DEVICE_ID;
  await fs.rm(home, { recursive: true, force: true });
});

test("a black-holed request rejects on its deadline instead of hanging forever", async () => {
  blackHole();
  const started = Date.now();
  // fetchAccountSummary takes an explicit budget, so the deadline is observable in ms
  // rather than at the 60s control default.
  const summary = await fetchAccountSummary(50);
  const elapsed = Date.now() - started;

  expect(summary).toEqual({ state: "unavailable" });
  expect(elapsed).toBeLessThan(5_000);
  const signal = observed[0];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal!.aborted).toBe(true);
  expect((signal!.reason as { name?: string }).name).toBe("TimeoutError");
});

test("every command-layer network call carries an abort signal", async () => {
  recording((url) => {
    if (url.includes("/v1/account/status")) return { accountId: "acct_1", linked: false, plan: "none" };
    if (url.includes("/v1/account/usage")) return { plan: "none", usedBytes: 0, storageCap: null, workspaces: 0, workspaceCap: null, retentionDays: 0, graceUntil: null, readOnly: false };
    if (url.includes("/v1/account/link/redeem")) return { account: "acct_1" };
    if (url.includes("/v1/billing/")) return { url: "https://stripe.test/session" };
    return {};
  });

  await usageCmd();
  await accountStatus();
  await accountStatus({ json: true });
  await accountLink("CODE-1234");
  await accountUnlink();
  await subscribe("solo");
  await billingPortal();
  await runUpdateCheckIfDue("https://releases.test"); // background poll: fails closed on a bad manifest

  expect(observed.length).toBeGreaterThanOrEqual(9);
  const bare = observed.filter((signal) => !(signal instanceof AbortSignal));
  expect(bare).toEqual([]);
});
