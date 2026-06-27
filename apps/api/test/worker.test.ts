import { env, SELF, applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const BASE = "https://example.com";

// Apply D1 migrations against the local test DB once.
beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

// Each test bootstraps its own account/device so they're isolated.
async function bootstrap(accountName: string): Promise<{ token: string; accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; accountId: string; deviceId: string };
}

const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

describe("worker integration (real DO + D1 + R2)", () => {
  test("health is public", async () => {
    const res = await SELF.fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  test("unauthenticated request → 401", async () => {
    const res = await SELF.fetch(`${BASE}/v1/account/usage`);
    expect(res.status).toBe(401);
  });

  test("blob entitlement: PUT grants, GET works; a different account 404s the same sha", async () => {
    const a = await bootstrap("acct-blob-a");
    const content = "blob-entitlement-content";
    const s = sha(content);
    const put = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(content.length) }), body: content });
    expect(put.status).toBe(200);
    const get = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { headers: authed(a.token) });
    expect(get.status).toBe(200);
    // A second account never uploaded it → not entitled → 404 (cross-account isolation).
    const b = await bootstrap("acct-blob-b");
    const cross = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { headers: authed(b.token) });
    expect(cross.status).toBe(404);
  });

  // The DO commit sequencer uses `ctx.storage.kv` + `transactionSync` — DO storage
  // APIs newer than the workerd bundled with the pinned vitest-pool-workers (which
  // caps at compat 2025-07-30). These paths are verified LIVE (M1–M7) and the
  // client-side 409/422/retry logic is automated in src/cli/sync.test.ts against a
  // stateful FakeRemote. Re-enable when a pool-workers/runtime with storage.kv lands.
  test.skip("commit sequencer: clean commit, then a STALE parent → 409 conflict", async () => {
    const a = await bootstrap("acct-commit");
    // Create a workspace (server-owned).
    const wsRes = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(wsRes.status).toBe(200);
    const ws = ((await wsRes.json()) as { workspaceId: string }).workspaceId;

    // Upload a blob and commit a manifest referencing it (parent seq 0).
    const content = "commit-payload";
    const s = sha(content);
    await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(content.length) }), body: content });
    const manifest = { generatedAt: "", files: [{ path: "f.txt", type: "file", sha256: s, size: content.length, mode: 0o644, mtimeMs: 1 }] };
    const commitUrl = `${BASE}/v1/ws/${ws}/proj/root/manifests`;
    const c1 = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, deviceId: a.accountId, manifest }) });
    expect(c1.status).toBe(200);
    const seq1 = ((await c1.json()) as { sequence: number }).sequence;
    expect(seq1).toBe(1);

    // Re-commit with the now-stale parent 0 → 409.
    const c2 = await SELF.fetch(commitUrl, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, deviceId: a.accountId, manifest }) });
    expect(c2.status).toBe(409);
  });

  test.skip("commit referencing an un-uploaded blob → 422 unsatisfied (entitlement-scoped)", async () => {
    const a = await bootstrap("acct-422");
    const ws = ((await (await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) })).json()) as { workspaceId: string }).workspaceId;
    const ghostSha = sha("never-uploaded");
    const manifest = { generatedAt: "", files: [{ path: "ghost.txt", type: "file", sha256: ghostSha, size: 13, mode: 0o644, mtimeMs: 1 }] };
    const res = await SELF.fetch(`${BASE}/v1/ws/${ws}/proj/root/manifests`, { method: "POST", headers: authed(a.token, { "content-type": "application/json" }), body: JSON.stringify({ parentSequence: 0, deviceId: a.accountId, manifest }) });
    expect(res.status).toBe(422);
  });

  test("free plan workspace cap: 2nd workspace → 402 quota_exceeded", async () => {
    const a = await bootstrap("acct-quota");
    const first = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(first.status).toBe(200);
    const second = await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    expect(second.status).toBe(402);
  });

  // ── pairing tokens (M10) ─────────────────────────────────────────────────

  const pairCreate = (token: string) => SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST", headers: authed(token) });
  const pairRedeem = (pair: string) =>
    SELF.fetch(`${BASE}/v1/auth/pair/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pair, label: "new-machine" }) });

  test("pair/create requires auth (no token → 401)", async () => {
    const res = await SELF.fetch(`${BASE}/v1/auth/pair/create`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  test("pair create → redeem mints a working device on the SAME account", async () => {
    const a = await bootstrap("acct-pair");
    const cr = await pairCreate(a.token);
    expect(cr.status).toBe(200);
    const { token: pair } = (await cr.json()) as { token: string };
    expect(pair.startsWith("rbox-pair_")).toBe(true);

    const rd = await pairRedeem(pair);
    expect(rd.status).toBe(200);
    const { token: deviceToken, deviceId } = (await rd.json()) as { token: string; deviceId: string };
    expect(deviceId.startsWith("dev_")).toBe(true);
    // The minted token authenticates and lands in the creator's account.
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(deviceToken) });
    expect(usage.status).toBe(200);
    expect(((await usage.json()) as { plan: string }).plan).toBe("free");
  });

  test("pairing token is SINGLE-USE (second redeem → 401)", async () => {
    const a = await bootstrap("acct-pair-once");
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    expect((await pairRedeem(pair)).status).toBe(200);
    expect((await pairRedeem(pair)).status).toBe(401); // already consumed
  });

  test("malformed / unknown pairing token → 401", async () => {
    expect((await pairRedeem("rbox-pair_not-hex")).status).toBe(401);
    expect((await pairRedeem(`rbox-pair_${"a".repeat(64)}`)).status).toBe(401); // well-formed but unknown
  });

  test("expired pairing token → 401 (and is not minted)", async () => {
    const a = await bootstrap("acct-pair-exp");
    // Insert a token that's already expired, directly into D1.
    const { createHash } = await import("node:crypto");
    const raw = "b".repeat(64);
    const hash = createHash("sha256").update(raw).digest("hex");
    const past = Date.now() - 1000;
    await env.rbox_dev_db
      .prepare("INSERT INTO pairing_tokens (token_hash, account_id, user_id, created_by, label, created_at, expires_at) VALUES (?, ?, ?, ?, 'x', ?, ?)")
      .bind(hash, a.accountId, "u", a.deviceId, past - 1000, past)
      .run();
    expect((await pairRedeem(`rbox-pair_${raw}`)).status).toBe(401);
  });

  test("revoked creator device → its outstanding token is dead at redeem (fix #1)", async () => {
    const a = await bootstrap("acct-pair-revoke");
    const { token: pair } = (await (await pairCreate(a.token)).json()) as { token: string };
    // Revoke the device that created the token, THEN try to redeem it.
    await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(a.deviceId).run();
    expect((await pairRedeem(pair)).status).toBe(401); // live-authority check fails closed
  });

  test("active-token cap enforced (6th create → 429)", async () => {
    const a = await bootstrap("acct-pair-cap");
    for (let i = 0; i < 5; i++) expect((await pairCreate(a.token)).status).toBe(200);
    expect((await pairCreate(a.token)).status).toBe(429);
  });

  const PLAT = { "x-rbox-platform": "test-platform-secret" };

  test("retention prune is platform-gated (tenant token → 404)", async () => {
    const a = await bootstrap("acct-ret-gate");
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: authed(a.token) });
    expect(res.status).toBe(404);
  });

  test("retention prune runs the plan→floor pass over workspaces (no old versions → 0 pruned)", async () => {
    // Exercises the workspaces⋈accounts join + per-plan cutoff query. The DO
    // prune reclaim itself uses ctx.storage.kv (skipped here; verified live, M6) —
    // with no committed versions there's nothing past the window, so no DO call.
    const a = await bootstrap("acct-ret");
    await SELF.fetch(`${BASE}/v1/workspaces?project=root`, { method: "POST", headers: authed(a.token) });
    const res = await SELF.fetch(`${BASE}/v1/admin/gc?phase=retention`, { method: "POST", headers: PLAT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; workspaces: number; pruned: number };
    expect(body.ok).toBe(true);
    expect(body.workspaces).toBeGreaterThanOrEqual(1); // our workspace was in the pass
    expect(body.pruned).toBe(0); // nothing old enough to prune
  });
});
