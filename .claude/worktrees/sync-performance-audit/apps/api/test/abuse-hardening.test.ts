import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createWebSession, mintDevice, pollDeviceAuth, redeemPairToken } from "../src/auth.js";
import { rateLimited } from "../src/ratelimit.js";
import type { Env, RateLimitBinding } from "../src/env.js";

const BASE = "https://example.com";

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

// The harness env is dev, where the device cap is intentionally lifted. Cap tests
// use prod/unset clones while keeping the local limiter binding unchanged.
const prodEnv: Env = { ...env, RBOX_ENV: "prod" };
const unsetEnv: Env = { ...env, RBOX_ENV: undefined };

async function bootstrap(accountName: string): Promise<{ token: string; accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string; deviceId: string };
}

/** Mint extra durable devices into an account and return their ids. */
async function fillDurableDevices(accountId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await mintDevice(env, accountId, "u", "dev", `filler-${i}`)).deviceId);
  return ids;
}

async function durableCount(accountId: string): Promise<number> {
  const row = await env.rbox_dev_db
    .prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND expires_at IS NULL AND revoked = 0")
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function pollReq(deviceCode: string): Request {
  return new Request(`${BASE}/v1/auth/device/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode }) });
}

function redeemReq(token: string): Request {
  return new Request(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
}

/** Seed an approved device_auth grant. */
async function seedApprovedDeviceCode(accountId: string, deviceCode: string): Promise<void> {
  const now = Date.now();
  await env.rbox_dev_db
    .prepare("INSERT INTO device_auth (device_code, user_code, status, device_id, label, created_at, expires_at, account_id, user_id) VALUES (?, ?, 'approved', ?, 'cap', ?, ?, ?, 'u')")
    .bind(deviceCode, `UC-${deviceCode.slice(0, 6)}`, `dev_dc_${deviceCode.slice(0, 8)}`, now, now + 10 * 60 * 1000, accountId)
    .run();
}

describe("design 64 §3.2 — per-account durable-device cap", () => {
  test("device-code claim hits the cap (409), keeps the grant intact, and revoking frees a slot", async () => {
    const a = await bootstrap("acct-cap-devicecode"); // bootstrap mints 1 durable device
    const fillers = await fillDurableDevices(a.accountId, 1); // → 2 total = none cap
    expect(await durableCount(a.accountId)).toBe(2);

    const deviceCode = "dc".padEnd(64, "0");
    await seedApprovedDeviceCode(a.accountId, deviceCode);

    const blocked = await pollDeviceAuth(pollReq(deviceCode), prodEnv);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "device_limit_reached", cap: 2, plan: "none" });
    const stillApproved = await env.rbox_dev_db.prepare("SELECT status FROM device_auth WHERE device_code = ?").bind(deviceCode).first<{ status: string }>();
    expect(stillApproved?.status).toBe("approved"); // grant intact — not flipped to 'claimed'

    await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(fillers[0]).run();
    const ok = await pollDeviceAuth(pollReq(deviceCode), prodEnv);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; token?: string };
    expect(body.status).toBe("approved");
    expect(typeof body.token).toBe("string");
  });

  test("pair-redeem hits the same cap (409), keeps the token intact, and revoking frees a slot", async () => {
    const a = await bootstrap("acct-cap-pair"); // 1 durable device
    const created = await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: { authorization: `Bearer ${a.token}` } });
    expect(created.status).toBe(200);
    const { token: pair } = (await created.json()) as { token: string };

    const fillers = await fillDurableDevices(a.accountId, 1); // → 2 total = cap
    expect(await durableCount(a.accountId)).toBe(2);

    const blocked = await redeemPairToken(redeemReq(pair), prodEnv);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: "device_limit_reached", cap: 2, plan: "none" });

    await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(fillers[0]).run();
    const ok = await redeemPairToken(redeemReq(pair), prodEnv);
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { token?: string }).token).toBe("string");
  });

  test("an ephemeral web-session mint is exempt — not counted, never blocked", async () => {
    const a = await bootstrap("acct-cap-web");
    await fillDurableDevices(a.accountId, 1); // → 2 durable = cap
    expect(await durableCount(a.accountId)).toBe(2);

    const ws = await createWebSession(prodEnv, a.accountId, "u");
    expect(typeof ws.token).toBe("string");
    expect(await durableCount(a.accountId)).toBe(2);
  });

  test("dev env lifts the cap so the rig is unaffected", async () => {
    const a = await bootstrap("acct-cap-dev");
    await expect(fillDurableDevices(a.accountId, 10)).resolves.toHaveLength(10);
    expect(await durableCount(a.accountId)).toBe(11); // 1 bootstrap + 10
  });

  test("undefined RBOX_ENV enforces the cap (config drift fails closed)", async () => {
    const a = await bootstrap("acct-cap-undefined-env");
    await fillDurableDevices(a.accountId, 1); // → 2 total = none cap

    await expect(mintDevice(unsetEnv, a.accountId, "u", "dev", "blocked")).rejects.toThrow("device limit reached");
  });

  test("pair-redeem tombstone semantics outrank the cap preflight", async () => {
    const a = await bootstrap("acct-cap-pair-tombstone");
    const created = await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: { authorization: `Bearer ${a.token}` } });
    expect(created.status).toBe(200);
    const { token: pair } = (await created.json()) as { token: string };
    await fillDurableDevices(a.accountId, 1); // would cap at 2 if tombstone did not short-circuit it
    await env.rbox_dev_db.prepare("UPDATE accounts SET deleted_at = ? WHERE id = ?").bind(Date.now(), a.accountId).run();

    const gone = await redeemPairToken(redeemReq(pair), prodEnv);
    expect(gone.status).toBe(401);
    expect(await gone.json()).toEqual({ error: "unauthorized" });
    const tokenRow = await env.rbox_dev_db.prepare("SELECT consumed_at FROM pairing_tokens WHERE account_id = ?").bind(a.accountId).first<{ consumed_at: number | null }>();
    expect(tokenRow?.consumed_at).not.toBeNull();
  });
});

describe("design 64 §3.1 — limiter guard (fail-open)", () => {
  const stub = (impl: RateLimitBinding["limit"]): RateLimitBinding => ({ limit: impl });

  test("under budget (success:true) → null (proceed)", async () => {
    expect(await rateLimited(stub(async () => ({ success: true })), "k")).toBeNull();
  });

  test("over budget (success:false) → 429 with Retry-After + rate_limited DTO", async () => {
    const res = await rateLimited(stub(async () => ({ success: false })), "k");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
    expect(res!.headers.get("Retry-After")).toBe("60");
    expect(await res!.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 60 });
  });

  test("a thrown .limit() fails OPEN → null (never blocks login)", async () => {
    expect(await rateLimited(stub(async () => { throw new Error("binding down"); }), "k")).toBeNull();
  });

  test("an absent binding fails OPEN → null", async () => {
    expect(await rateLimited(undefined, "k")).toBeNull();
  });

  test("device/poll rejects malformed deviceCode before any rate-limit bucket", async () => {
    let calls = 0;
    const failIfCalled = stub(async () => {
      calls++;
      throw new Error("limiter should not be called");
    });

    const res = await pollDeviceAuth(pollReq("A".repeat(64)), { ...env, RL_DEVICE_POLL: failIfCalled, RL_DEVICE_POLL_IP: failIfCalled });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
    expect(calls).toBe(0);
  });

  test("device/poll valid-shaped codes hit both the IP and per-code buckets", async () => {
    const calls: string[] = [];
    const bucket = (name: string) =>
      stub(async ({ key }) => {
        calls.push(`${name}:${key}`);
        return { success: true };
      });
    const code = "a".repeat(64);

    const res = await pollDeviceAuth(pollReq(code), { ...env, RL_DEVICE_POLL_IP: bucket("ip"), RL_DEVICE_POLL: bucket("code") });
    expect(res.status).toBe(404);
    expect(calls).toEqual([`ip:dpi:noip`, `code:dp:${code}`]);
  });
});
