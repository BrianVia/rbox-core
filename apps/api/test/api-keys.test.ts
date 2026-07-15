import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createPatToken } from "../../../src/engine/pat-token.js";
import { createWebSession } from "../src/auth.js";
import { releaseRoutes } from "../src/routes/release.js";
import type { Env, WorkerEntrypointExports } from "../src/env.js";

const BASE = "https://example.com";
const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const corruptChecksum = (token: string) => `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(accountName: string, extra: Record<string, unknown> = {}): Promise<{ token: string; accountId: string; deviceId: string; userId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName, ...extra }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as { token: string; accountId: string; deviceId: string };
  const row = await env.rbox_dev_db.prepare("SELECT user_id FROM devices WHERE device_id = ?").bind(out.deviceId).first<{ user_id: string }>();
  return { ...out, userId: row!.user_id };
}

async function createKey(
  ownerToken: string,
  over: Partial<{ token: string; deviceId: string; expiresAt: number; label: string }> = {}
): Promise<{ token: string; deviceId: string; expiresAt: number; res: Response }> {
  const token = over.token ?? createPatToken();
  const deviceId = over.deviceId ?? `agent_${randomUUID().replace(/-/g, "")}`;
  const expiresAt = over.expiresAt ?? Date.now() + 90 * 24 * 60 * 60 * 1000;
  const res = await SELF.fetch(`${BASE}/v1/keys/api`, {
    method: "POST",
    headers: authed(ownerToken, { "content-type": "application/json" }),
    body: JSON.stringify({
      tokenHash: sha(token),
      deviceId,
      expiresAt,
      label: over.label ?? "test-agent",
      displayPrefix: `${token.slice(0, 17)}...`,
      enrolled: true,
    }),
  });
  return { token, deviceId, expiresAt, res };
}

describe("agent/API sync keys", () => {
  test("PAT recognizer accepts valid PATs, rejects malformed/bad checksum, and leaves 64-hex device tokens working", async () => {
    const a = await bootstrap("apikey-recognizer", { plan: "pro" });
    const made = await createKey(a.token);
    expect(made.res.status).toBe(200);

    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(made.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(corruptChecksum(made.token)) })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed("rbox_pat_not-valid") })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) })).status).toBe(200);
  });

  test("kind classification is explicit, with legacy NULL fallback preserving old web/device behavior", async () => {
    const a = await bootstrap("apikey-kind", { plan: "pro" });
    const made = await createKey(a.token);
    expect(made.res.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/keys/admit`, { method: "POST", headers: authed(made.token, { "content-type": "application/json" }), body: "{}" })).status).toBe(400);

    await env.rbox_dev_db.prepare("UPDATE devices SET kind = NULL WHERE device_id = ?").bind(a.deviceId).run();
    expect((await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(a.token) })).status).toBe(200);

    const web = await createWebSession(env as Env, a.accountId, a.userId);
    await env.rbox_dev_db.prepare("UPDATE devices SET kind = NULL WHERE device_id = ?").bind(web.deviceId).run();
    expect((await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(web.token) })).status).toBe(403);
  });

  test("api_key route allowlist permits sync/key-sync/usage/workspace list and denies management routes", async () => {
    const a = await bootstrap("apikey-allowlist", { plan: "pro" });
    const wsRes = await SELF.fetch(`${BASE}/v1/workspaces?project=root&name=Agent%20Workspace`, { method: "POST", headers: authed(a.token) });
    expect(wsRes.status).toBe(200);
    const ws = ((await wsRes.json()) as { workspaceId: string }).workspaceId;
    const made = await createKey(a.token);
    expect(made.res.status).toBe(200);

    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(made.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/account/workspaces`, { headers: authed(made.token) })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/keys/account`, { headers: authed(made.token) })).status).not.toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/keys/admit`, { method: "POST", headers: authed(made.token, { "content-type": "application/json" }), body: "{}" })).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/latest`, { headers: authed(made.token) })).status).not.toBe(403);

    const denied: Array<[string, RequestInit]> = [
      [`${BASE}/v1/billing/portal`, { method: "POST" }],
      [`${BASE}/v1/auth/pair/create`, { method: "POST" }],
      [`${BASE}/v1/auth/device/approve`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }],
      [`${BASE}/v1/workspaces?project=root`, { method: "POST" }],
      [`${BASE}/v1/account`, { method: "DELETE", body: "{}", headers: { "content-type": "application/json" } }],
      [`${BASE}/v1/keys/api`, { method: "GET" }],
      [`${BASE}/v1/keys/api/${made.deviceId}/revoke`, { method: "POST" }],
    ];
    for (const [url, init] of denied) {
      const res = await SELF.fetch(url, { ...init, headers: authed(made.token, (init.headers as Record<string, string>) ?? {}) });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden_for_api_key" });
    }
  });

  test("create requires device principal, active plan, mandatory <=1y expiry, and enforces the five-key cap", async () => {
    const paid = await bootstrap("apikey-create-paid", { plan: "pro" });
    const none = await bootstrap("apikey-create-none");
    const legacyFree = await bootstrap("apikey-create-free", { plan: "pro" });
    await env.rbox_dev_db.prepare("UPDATE accounts SET plan = 'free' WHERE id = ?").bind(legacyFree.accountId).run();
    const web = await createWebSession(env as Env, paid.accountId, paid.userId);

    expect((await createKey(web.token)).res.status).toBe(403);
    const first = await createKey(paid.token);
    expect(first.res.status).toBe(200);
    expect((await createKey(first.token)).res.status).toBe(403);
    expect((await createKey(none.token)).res.status).toBe(403);
    expect((await createKey(legacyFree.token)).res.status).toBe(403);
    expect((await createKey(paid.token, { expiresAt: Date.now() + 366 * 24 * 60 * 60 * 1000 })).res.status).toBe(400);
    expect((await createKey(paid.token, { expiresAt: Date.now() - 1000 })).res.status).toBe(400);

    for (let i = 0; i < 4; i++) expect((await createKey(paid.token)).res.status).toBe(200);
    expect((await createKey(paid.token)).res.status).toBe(429);
  });

  test("cap check is race-safe at four outstanding keys", async () => {
    const a = await bootstrap("apikey-cap-race", { plan: "pro" });
    for (let i = 0; i < 4; i++) expect((await createKey(a.token)).res.status).toBe(200);
    const statuses = await Promise.all([createKey(a.token), createKey(a.token)]).then((rs) => rs.map((r) => r.res.status).sort());
    expect(statuses).toEqual([200, 429]);
  });

  test("list and revoke target exactly one API-key device id; revoked key 401s immediately", async () => {
    const a = await bootstrap("apikey-revoke", { plan: "pro" });
    const k1 = await createKey(a.token, { label: "one" });
    const k2 = await createKey(a.token, { label: "two" });
    expect(k1.res.status).toBe(200);
    expect(k2.res.status).toBe(200);

    const listed = await SELF.fetch(`${BASE}/v1/keys/api`, { headers: authed(a.token) });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { keys: Array<{ deviceId: string; label: string }> }).keys.map((k) => k.deviceId)).toEqual(expect.arrayContaining([k1.deviceId, k2.deviceId]));

    const rev = await SELF.fetch(`${BASE}/v1/keys/api/${k1.deviceId}/revoke`, { method: "POST", headers: authed(a.token) });
    expect(rev.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(k1.token) })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(k2.token) })).status).toBe(200);
  });

  test("agent.sh route serves the passthrough setup wrapper with install.sh cache headers", async () => {
    const req = new Request(`${BASE}/agent.sh`);
    let forwarded = false;
    const res = await releaseRoutes({
      req,
      env,
      exports: {
        CachedReleases: {
          fetch: async () => {
            forwarded = true;
            return new Response("unexpected");
          },
        },
      } as WorkerEntrypointExports,
      executionCtx: { waitUntil: (promise) => void promise },
      url: new URL(req.url),
      seg: ["agent.sh"],
    });
    expect(res).not.toBeNull();
    expect(forwarded).toBe(false);
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/x-shellscript");
    expect(res!.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    const body = await res!.text();
    expect(body).toContain("install.sh");
    expect(body).toContain('exec rbox setup "$@"');
    expect(body).toContain('.rbox/bin'); // PATH extension — a child sh can't mutate ours (antislop #1)
  });
});
