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

  // ── Stripe billing (M10) ─────────────────────────────────────────────────

  test("billing/checkout + portal are gated on STRIPE_SECRET (absent → 501)", async () => {
    const a = await bootstrap("acct-bill");
    expect((await SELF.fetch(`${BASE}/v1/billing/checkout?plan=pro`, { method: "POST", headers: authed(a.token) })).status).toBe(501);
    expect((await SELF.fetch(`${BASE}/v1/billing/portal`, { method: "POST", headers: authed(a.token) })).status).toBe(501);
  });

  // Sign a payload exactly as Stripe does: HMAC-SHA256 over `${t}.${body}`.
  async function stripeSig(body: string, secret: string, t: number): Promise<string> {
    const { createHmac } = await import("node:crypto");
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${v1}`;
  }
  const webhook = (body: string, sig: string) =>
    SELF.fetch(`${BASE}/v1/stripe/webhook`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body });

  test("webhook rejects a bad/forged signature → 400 (no plan change)", async () => {
    const evt = JSON.stringify({ id: "evt_bad", type: "customer.subscription.updated", data: { object: {} } });
    expect((await webhook(evt, "t=123,v1=deadbeef")).status).toBe(400);
  });

  test("webhook flips accounts.plan on an active subscription (valid signature)", async () => {
    const a = await bootstrap("acct-sub");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_sub_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active", customer: "cus_sub1", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_pro_monthly" } }] } } },
    });
    const res = await webhook(body, await stripeSig(body, "whsec_test_secret", t));
    expect(res.status).toBe(200);
    // Confirm via the authed usage endpoint that the plan is now pro.
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(((await usage.json()) as { plan: string }).plan).toBe("pro");
  });

  test("webhook is idempotent (same event id re-delivered → duplicate, applied once)", async () => {
    const a = await bootstrap("acct-idem");
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_dup",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_2", status: "active", customer: "cus_sub2", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: "rbox_solo_monthly" } }] } } },
    });
    const sig = await stripeSig(body, "whsec_test_secret", t);
    expect((await (await webhook(body, sig)).json() as { duplicate?: boolean }).duplicate).toBeUndefined();
    expect((await (await webhook(body, sig)).json() as { duplicate?: boolean }).duplicate).toBe(true); // 2nd = no-op
  });

  test("webhook downgrades to free when subscription is canceled/past_due", async () => {
    const a = await bootstrap("acct-cancel");
    const t = Math.floor(Date.now() / 1000);
    const mk = (id: string, status: string, lk: string) =>
      JSON.stringify({ id, type: "customer.subscription.updated", data: { object: { id: "sub_3", status, customer: "cus_sub3", metadata: { account_id: a.accountId }, items: { data: [{ price: { lookup_key: lk } }] } } } });
    const up = mk("evt_up", "active", "rbox_pro_monthly");
    await webhook(up, await stripeSig(up, "whsec_test_secret", t));
    const down = mk("evt_down", "past_due", "rbox_pro_monthly");
    await webhook(down, await stripeSig(down, "whsec_test_secret", t));
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(a.token) });
    expect(((await usage.json()) as { plan: string }).plan).toBe("free"); // fail-closed
  });

  // ── web auth via Clerk (M11) ─────────────────────────────────────────────

  // Generate a test RSA key, publish it as the JWKS, and sign Clerk-like JWTs.
  const b64url = (buf: ArrayBuffer | Uint8Array) => {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = ""; for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  let priv: CryptoKey;
  const KID = "test-kid-1";
  const ISS = "https://clerk.test";
  const AZP = "https://app.test";

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    priv = pair.privateKey;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & { kid?: string; use?: string; alg?: string };
    jwk.kid = KID; jwk.use = "sig"; jwk.alg = "RS256";
    const { fetchMock } = await import("cloudflare:test");
    fetchMock.activate();
    fetchMock.disableNetConnect();
    fetchMock.get("https://clerk.test").intercept({ path: "/.well-known/jwks.json" }).reply(200, JSON.stringify({ keys: [jwk] })).persist();
    // Clerk Backend API (email verification): every sub verified EXCEPT "user_unverified".
    fetchMock
      .get("https://api.clerk.com")
      .intercept({ path: /^\/v1\/users\//, method: "GET" })
      .reply((opts: { path: string }) => {
        const sub = decodeURIComponent(opts.path.split("/").pop() ?? "");
        const status = sub === "user_unverified" ? "unverified" : "verified";
        return { statusCode: 200, data: JSON.stringify({ primary_email_address_id: "e1", email_addresses: [{ id: "e1", verification: { status } }] }) };
      })
      .persist();
  });

  async function signJwt(payload: Record<string, unknown>, opts: { alg?: string; kid?: string } = {}): Promise<string> {
    const header = { alg: opts.alg ?? "RS256", kid: opts.kid ?? KID, typ: "JWT" };
    const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
    if (header.alg === "none") return `${h}.${p}.`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  }
  const now = () => Math.floor(Date.now() / 1000);
  const claims = (over: Record<string, unknown> = {}) => ({ iss: ISS, sub: "user_clerk_1", azp: AZP, exp: now() + 60, nbf: now() - 5, ...over });
  const webExchange = (token: string) =>
    SELF.fetch(`${BASE}/v1/web/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });

  test("valid Clerk JWT → rbox web session token that authenticates", async () => {
    const res = await webExchange(await signJwt(claims()));
    expect(res.status).toBe(200);
    const { token, accountId } = (await res.json()) as { token: string; accountId: string };
    expect(accountId.startsWith("acct_")).toBe(true);
    const usage = await SELF.fetch(`${BASE}/v1/account/usage`, { headers: authed(token) });
    expect(usage.status).toBe(200);
  });

  test("same Clerk user logging in twice reuses the SAME account (idempotent)", async () => {
    const a1 = (await (await webExchange(await signJwt(claims({ sub: "user_dup" })))).json()) as { accountId: string };
    const a2 = (await (await webExchange(await signJwt(claims({ sub: "user_dup" })))).json()) as { accountId: string };
    expect(a1.accountId).toBe(a2.accountId);
  });

  test("forged signature → 401", async () => {
    const t = await signJwt(claims({ sub: "user_forge" }));
    const tampered = t.slice(0, -4) + (t.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect((await webExchange(tampered)).status).toBe(401);
  });

  test("alg:none → 401 (algorithm-confusion guard)", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_none" }), { alg: "none" }))).status).toBe(401);
  });

  test("wrong issuer → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_iss", iss: "https://evil.test" })))).status).toBe(401);
  });

  test("expired token → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_exp", exp: now() - 120 })))).status).toBe(401);
  });

  test("disallowed azp (origin) → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_azp", azp: "https://evil.test" })))).status).toBe(401);
  });

  test("absent azp → 401 (web route requires origin binding)", async () => {
    const c = claims({ sub: "u_noazp" }); delete (c as Record<string, unknown>).azp;
    expect((await webExchange(await signJwt(c))).status).toBe(401);
  });

  test("unknown kid → 401", async () => {
    expect((await webExchange(await signJwt(claims({ sub: "u_kid" }), { kid: "nope" }))).status).toBe(401);
  });

  test("JWT whose header/payload decode to non-objects → 401 (not 500)", async () => {
    const nullHeader = `${b64url(new TextEncoder().encode("null"))}.${b64url(new TextEncoder().encode(JSON.stringify(claims())))}.AAAA`;
    expect((await webExchange(nullHeader)).status).toBe(401);
  });

  test("first-login with an UNVERIFIED email → 403 (abuse gate), no account created", async () => {
    const res = await webExchange(await signJwt(claims({ sub: "user_unverified" })));
    expect(res.status).toBe(403);
    // A subsequent call still 403s (no mapping was claimed → gate re-runs).
    expect((await webExchange(await signJwt(claims({ sub: "user_unverified" })))).status).toBe(403);
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
